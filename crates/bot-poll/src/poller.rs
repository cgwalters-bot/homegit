//! The hot cycle, which polls the notifications, the operator's events
//! and the hot items between full sweeps, and the hot set's rebuild on
//! each sweep.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use bot_poll::hot::{
    self, Act, Class, CycleStat, HotItem, HotState, Key, NOTIFY_REASONS, OpEvent, Pages, Places,
    RECENT_MS, SINCE_PARAM,
};
use bot_poll::operator::Config;
use bot_poll::{
    KindNews, NewsItem, Output, Reported, Source, State, evaluate, in_kind_order, line_event,
};

use crate::Sweeper;
use crate::gh::{Fetched, Gh, MAX_PAGES, NOT_MODIFIED, PER_PAGE};

/// Unread notification threads, newest first: a cycle only needs the
/// ones updated since the last.
const NOTIFICATIONS: &str = "notifications?per_page=50";
/// The lines of bot-signoff-due --apply's results.
const SIGNOFF_RESULTS: [&str; 6] = [
    "Signed off:",
    "Sign-off refused:",
    "Sign-off changed nothing:",
    "Carried sign-off dropped:",
    "No-carry answered:",
    "No-carry refused:",
];
const APPROVED: &str = "APPROVED";
/// The notification reason of a thread the bot opened.
const AUTHOR_REASON: &str = "author";

/// What a hot cycle found.
pub struct Cycle {
    pub news: Vec<KindNews>,
    pub stat: CycleStat,
}

pub struct Poller<'a> {
    pub cfg: &'a Config,
    pub gh: PathBuf,
    pub sweeper: &'a Sweeper,
    /// The state dir, where gh's responses are captured.
    pub dir: &'a Path,
}

fn warn(what: &str, e: &anyhow::Error) {
    eprintln!("bot-poll: warning: {what} failed: {e:#}");
}

impl Poller<'_> {
    fn client(&self, now: i64, sweep: bool) -> Gh {
        Gh::new(self.gh.clone(), self.dir.join("gh.out"), now, sweep)
    }

    fn places(&self) -> Places {
        Places {
            tracker: self.cfg.tracker_repo.clone(),
            forge_org: self.cfg.forge_org.clone(),
        }
    }

    fn owned(&self, repo: &str) -> bool {
        hot::is_bots_repo(repo, &self.cfg.forge_org, &self.cfg.bot.login)
    }

    /// Rebuilds the hot set, keeping the old one if that fails.
    pub fn rebuild(&self, state: &mut State, now: i64) -> CycleStat {
        let mut gh = self.client(now, true);
        match self.fresh(&mut gh) {
            Ok(items) => state.hot.rebuild(items, now),
            Err(e) => warn("rebuilding the hot set (the old one is kept)", &e),
        }
        state.hot.record(gh.stat);
        gh.stat
    }

    /// The bot's open PRs, in the forge and elsewhere, and the tracker's
    /// open asks assigned to the operator.
    fn fresh(&self, gh: &mut Gh) -> Result<BTreeMap<Key, HotItem>> {
        let (bot, forge) = (&self.cfg.bot.login, &self.cfg.forge_org);
        let mut items = BTreeMap::new();
        for (query, class) in [
            (
                format!("is:pr is:open author:{bot} org:{forge}"),
                Class::Forge,
            ),
            (
                format!("is:pr is:open author:{bot} -org:{forge}"),
                Class::Upstream,
            ),
        ] {
            for body in gh.search(&query)? {
                items.extend(hot::parse_search(&body, class)?);
            }
        }
        let asks = format!(
            "repos/{}/issues?assignee={}&state=open",
            self.cfg.tracker_repo, self.cfg.operator.login
        );
        for page in 1..=MAX_PAGES {
            let path = format!("{asks}&per_page={PER_PAGE}&page={page}");
            let body = gh.get(&path, &[])?.body;
            let got = hot::parse_asks(&body)?;
            let n = serde_json::from_str::<Vec<serde_json::Value>>(&body)
                .map(|v| v.len())
                .unwrap_or_default();
            items.extend(got);
            if n < PER_PAGE {
                break;
            }
        }
        Ok(items)
    }

    /// One hot cycle: the notifications and the operator's events (as
    /// often as their X-Poll-Interval allows), then the items they flag
    /// and those the operator was active on lately. Runs bot-notify when a
    /// thread asks something of the bot, and bot-signoff-due --apply when
    /// the operator approved the head of an upstream PR of the bot's, or
    /// commented /no-carry there.
    /// Writes RUN/hot.txt (and the tools' outputs there) when there is
    /// news or a tool ran.
    pub fn cycle(&self, state: &mut State, run: &Path, now: i64) -> Result<Cycle> {
        let mut gh = self.client(now, false);
        if now < state.hot.paused_until {
            return Ok(Cycle {
                news: Vec::new(),
                stat: gh.stat,
            });
        }
        let cursor = *state.hot.cursor.get_or_insert(now);
        let mut dirty: BTreeSet<Key> = std::mem::take(&mut state.hot.pending);
        let mut run_notify = false;
        if now >= state.hot.notifications.next_at {
            match self.notifications(&mut gh, &mut state.hot, now) {
                Ok((keys, notify)) => {
                    dirty.extend(keys);
                    run_notify |= notify;
                }
                Err(e) => warn("polling the notifications", &e),
            }
        }
        if now >= state.hot.events.next_at {
            match self.events(&mut gh, &mut state.hot, now) {
                Ok(keys) => dirty.extend(keys),
                Err(e) => warn("polling the operator's events", &e),
            }
        }
        let mut targets: Vec<Key> = dirty
            .into_iter()
            .filter(|k| state.hot.items.contains_key(k))
            .collect();
        for k in state.hot.direct(now) {
            if !targets.contains(&k) {
                targets.push(k);
            }
        }

        let mut news: BTreeMap<String, Vec<NewsItem>> = BTreeMap::new();
        let mut signoff = false;
        for key in targets {
            let item = state.hot.items[&key].clone();
            let evs = match self.poll_item(&mut gh, &mut state.hot, &key, &item, cursor, now) {
                Ok(evs) => evs,
                Err(e) => {
                    warn(&format!("polling {key}"), &e);
                    state.hot.pending.insert(key);
                    continue;
                }
            };
            let new: Vec<OpEvent> = evs
                .into_iter()
                .filter(|e| !e.reported(&state.reported))
                .collect();
            let approval = new
                .iter()
                .any(|e| matches!(&e.act, Act::Review { state, .. } if state == APPROVED));
            let head = if item.pr && approval {
                self.head(&mut gh, &key)
                    .map_err(|e| warn(&format!("reading the head of {key}"), &e))
                    .ok()
            } else {
                None
            };
            for ev in new {
                let c = hot::classify(&key, &item, &ev, head.as_deref(), &self.places());
                signoff |= c.signoff;
                state.reported.insert(ev.id, now);
                for id in ev.also {
                    state.reported.insert(id, now);
                }
                news.entry(c.kind.to_string()).or_default().push(NewsItem {
                    url: ev.url,
                    text: c.text,
                });
            }
        }

        if let Some(until) = gh.limited_until {
            eprintln!(
                "bot-poll: warning: GitHub is rate limiting the bot; no hot cycle before {}",
                hot::rfc3339(until)
            );
            state.hot.paused_until = until;
        }
        let tool_ran = signoff || run_notify;
        if tool_ran {
            fs::create_dir_all(run).with_context(|| format!("creating {}", run.display()))?;
        }
        if signoff {
            let items = self.signoffs(run, &mut state.reported, now)?;
            if !items.is_empty() {
                news.entry("signoff".to_string()).or_default().extend(items);
            }
        }
        if run_notify {
            let out = run.join(format!("{}.txt", Source::Notify.name()));
            let status = self.sweeper.step(&out, Some("bot-notify"), &[])?;
            let text =
                fs::read_to_string(&out).with_context(|| format!("reading {}", out.display()))?;
            let outputs = BTreeMap::from([(Source::Notify, Output { text, status })]);
            let (found, seen, reported) = evaluate(&outputs, &state.seen, &state.reported, now);
            state.seen = seen;
            state.reported = reported;
            for k in found {
                news.entry(k.kind).or_default().extend(k.items);
            }
        }
        let news = in_kind_order(news);
        if !news.is_empty() || tool_ran {
            fs::create_dir_all(run).with_context(|| format!("creating {}", run.display()))?;
            let mut text = String::new();
            for k in &news {
                for it in &k.items {
                    text.push_str(&format!("{}: {}\n  {}\n", k.kind, it.text, it.url));
                }
            }
            let path = run.join("hot.txt");
            fs::write(&path, text).with_context(|| format!("writing {}", path.display()))?;
        }
        state.hot.record(gh.stat);
        Ok(Cycle {
            news,
            stat: gh.stat,
        })
    }

    /// Polls the notifications: the items of the threads updated since
    /// (making one of the bot's own that isn't hot yet Recent, or Upstream
    /// for a PR it opened elsewhere since the last rebuild), and whether
    /// one asks something of the bot.
    fn notifications(&self, gh: &mut Gh, hot: &mut HotState, now: i64) -> Result<(Vec<Key>, bool)> {
        let cond = hot
            .notifications
            .last_modified
            .clone()
            .map(|lm| ("If-Modified-Since", lm));
        let cond: Vec<(&str, &str)> = cond.iter().map(|(k, v)| (*k, v.as_str())).collect();
        let r = gh.get(NOTIFICATIONS, &cond)?;
        hot.notifications.next_at = now + r.poll_interval_ms();
        if r.status == NOT_MODIFIED {
            return Ok((Vec::new(), false));
        }
        let (changed, mark) = hot::parse_notifications(&r.body, hot.notifications.mark.as_deref())?;
        hot.notifications.mark = mark;
        hot.notifications.last_modified = r.header("last-modified").map(str::to_string);
        let mut keys = Vec::new();
        let mut notify = false;
        for c in changed {
            notify |= NOTIFY_REASONS.contains(&c.reason.as_str());
            let Some((key, pr)) = c.item else { continue };
            if !hot.items.contains_key(&key) {
                let owned = self.owned(&c.repo);
                let authored = c.reason == AUTHOR_REASON;
                if !owned && !authored {
                    continue;
                }
                let class = if authored && pr && !owned {
                    Class::Upstream
                } else {
                    Class::Recent
                };
                hot.items.insert(
                    key.clone(),
                    HotItem {
                        class,
                        pr,
                        title: c.title,
                        active: None,
                    },
                );
            }
            keys.push(key);
        }
        Ok((keys, notify))
    }

    /// Polls the operator's events: the items he reviewed or commented on
    /// since, which become (or stay) hot if they are the bot's business.
    /// The first read only records them.
    fn events(&self, gh: &mut Gh, hot: &mut HotState, now: i64) -> Result<Vec<Key>> {
        let path = format!(
            "users/{}/events?per_page={PER_PAGE}",
            self.cfg.operator.login
        );
        let cond = hot.events.etag.clone();
        let cond: Vec<(&str, &str)> = cond.iter().map(|e| ("If-None-Match", e.as_str())).collect();
        let r = gh.get(&path, &cond)?;
        hot.events.next_at = now + r.poll_interval_ms();
        if r.status == NOT_MODIFIED {
            return Ok(Vec::new());
        }
        let first = hot.events.mark.is_none();
        let (touches, mark) = hot::parse_events(
            &r.body,
            hot.events.mark.as_deref(),
            &self.cfg.operator.login,
            &self.cfg.bot.login,
        )?;
        hot.events.mark = mark;
        hot.events.etag = r.header("etag").map(str::to_string);
        let mut keys = Vec::new();
        for t in touches {
            let ours = hot.items.contains_key(&t.key)
                || hot::is_bots(&t, &self.cfg.forge_org, &self.cfg.bot.login);
            if now - t.at >= RECENT_MS || !ours {
                continue;
            }
            hot.touch(&t.key, t.pr, &t.title, t.at);
            if !first {
                keys.push(t.key);
            }
        }
        Ok(keys)
    }

    /// The operator's reviews and comments on an item since `cursor`,
    /// read conditionally.
    fn poll_item(
        &self,
        gh: &mut Gh,
        hot: &mut HotState,
        key: &str,
        item: &HotItem,
        cursor: i64,
        now: i64,
    ) -> Result<Vec<OpEvent>> {
        let (repo, n) =
            hot::split_key(key).with_context(|| format!("{key} is not OWNER/REPO#N"))?;
        let reviews = if item.pr {
            gh.changed_pages(
                &format!("repos/{repo}/pulls/{n}/reviews"),
                &mut hot.etags,
                now,
            )?
        } else {
            Fetched::default()
        };
        let since = hot::rfc3339(cursor);
        let review_comments = if item.pr {
            gh.changed_pages(
                &format!("repos/{repo}/pulls/{n}/comments?{SINCE_PARAM}{since}"),
                &mut hot.etags,
                now,
            )?
        } else {
            Fetched::default()
        };
        let comments = gh.changed_pages(
            &format!("repos/{repo}/issues/{n}/comments?{SINCE_PARAM}{since}"),
            &mut hot.etags,
            now,
        )?;
        let pages = Pages {
            reviews: reviews.texts(),
            review_comments: review_comments.texts(),
            comments: comments.texts(),
        };
        let evs = hot::operator_events(&pages, &self.cfg.operator.login, cursor)?;
        for f in [reviews, review_comments, comments] {
            f.commit(&mut hot.etags);
        }
        Ok(evs)
    }

    fn head(&self, gh: &mut Gh, key: &str) -> Result<String> {
        let (repo, n) =
            hot::split_key(key).with_context(|| format!("{key} is not OWNER/REPO#N"))?;
        let body = gh.get(&format!("repos/{repo}/pulls/{n}"), &[])?.body;
        serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| Some(v.get("head")?.get("sha")?.as_str()?.to_string()))
            .context("no head.sha")
    }

    /// Runs bot-signoff-due --apply, as a sweep's bot-watch would: its
    /// new result lines.
    fn signoffs(&self, run: &Path, reported: &mut Reported, now: i64) -> Result<Vec<NewsItem>> {
        let out = run.join("signoff.txt");
        let status = self
            .sweeper
            .step(&out, Some("bot-signoff-due"), &["--apply"])?;
        if status != Some(0) {
            eprintln!(
                "bot-poll: warning: bot-signoff-due exited {status:?}; see {}",
                out.display()
            );
        }
        let text =
            fs::read_to_string(&out).with_context(|| format!("reading {}", out.display()))?;
        let mut items = Vec::new();
        for line in text.lines().map(str::trim) {
            if !SIGNOFF_RESULTS.iter().any(|p| line.starts_with(p)) {
                continue;
            }
            if reported.insert(line_event("signoff", line), now).is_none() {
                items.push(NewsItem {
                    url: bot_poll::first_url(line),
                    text: line.to_string(),
                });
            }
        }
        Ok(items)
    }
}
