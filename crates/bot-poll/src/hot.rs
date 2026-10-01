//! The hot set: the issues and PRs where the operator is likely to act
//! soon, which `bot-poll` watches between its full sweeps. What they are,
//! how the notifications and the operator's events feed flag one as
//! changed, and which of the operator's reviews and comments on one are
//! news, by kind. No I/O here: the binary makes the requests.

use std::collections::{BTreeMap, BTreeSet};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::event_id;

/// The notification reasons that ask something of the bot, which
/// bot-notify routes (its SELECT_REASONS): a thread updated for one of
/// them runs bot-notify.
pub const NOTIFY_REASONS: [&str; 4] = ["mention", "team_mention", "review_requested", "assign"];
/// The labels of the tracker issues that ask the operator something (as
/// `bot-board question` and its asks label them).
pub const ASK_LABELS: [&str; 4] = ["question", "decision", "review", "chore"];
/// How long an item the operator reviewed or commented on stays hot.
pub const RECENT_MS: i64 = 3 * 3600 * 1000;
/// At most this many of those are polled directly on every hot cycle,
/// the most recently active first.
pub const MAX_DIRECT: usize = 10;
/// A hot cycle's statistics are kept this long, for the last hour's.
pub const STATS_KEEP_MS: i64 = 3600 * 1000;
/// A conditional request's validator not used for this long is dropped.
pub const VALIDATOR_KEEP_MS: i64 = 24 * 3600 * 1000;
const API_REPOS: &str = "https://api.github.com/repos/";
const WEB: &str = "https://github.com/";
/// A line of the operator's comment on a fork PR that approves its head
/// (see `bot-pr inbox`).
const PROMOTE: &str = "/promote";
/// A line that is exactly this, in his comment on an upstream PR, revokes
/// a sign-off the bot carried (see bot-pr no-carry).
const NO_CARRY: &str = "/no-carry";
const APPROVED: &str = "APPROVED";
const SHORT_SHA: usize = 12;
/// The query parameter of the comment listings, which is the cursor.
pub const SINCE_PARAM: &str = "since=";
/// Where a fork PR's body starts its bot-meta section, which `bot-pr
/// fork-pr` writes: the bot's other PRs in the forge are its own
/// repositories'.
const FORK_META: &str = "<!-- bot-meta -->";
const EXCERPT_CHARS: usize = 80;

/// Why an item is hot, which decides what the operator's activity on it
/// means.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Class {
    /// A fork PR of the bot's in the forge, awaiting his review.
    Forge,
    /// Another open PR of the bot's (upstream, or in its own
    /// repositories), awaiting his review or his approval for a sign-off.
    Upstream,
    /// An open tracker issue that asks him something.
    Ask,
    /// Anything else of the bot's he reviewed or commented on lately.
    Recent,
}

impl Class {
    pub const ALL: [Class; 4] = [Class::Forge, Class::Upstream, Class::Ask, Class::Recent];

    pub fn name(self) -> &'static str {
        match self {
            Class::Forge => "forge",
            Class::Upstream => "upstream",
            Class::Ask => "ask",
            Class::Recent => "recent",
        }
    }
}

/// OWNER/REPO#N.
pub type Key = String;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HotItem {
    pub class: Class,
    pub pr: bool,
    #[serde(default)]
    pub title: String,
    /// When the operator last reviewed or commented on it (ms), as his
    /// events feed says.
    #[serde(default)]
    pub active: Option<i64>,
}

/// A polled feed: its validators, when it may be polled again (its
/// X-Poll-Interval), and how far it was read (the newest notification's
/// updated_at, or the newest event's id).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Feed {
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    #[serde(default)]
    pub next_at: i64,
    pub mark: Option<String>,
}

/// One hot cycle's (or hot set rebuild's) requests.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct CycleStat {
    pub at: i64,
    /// A full sweep's rebuild of the hot set, not a hot cycle.
    #[serde(default)]
    pub sweep: bool,
    pub requests: u32,
    pub not_modified: u32,
}

/// The ETag of a page read, for a conditional request of it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Validator {
    pub etag: String,
    /// When it was last used (ms).
    pub used: i64,
    /// The page was full, so there may be a next one.
    #[serde(default)]
    pub full: bool,
}

/// What bot-poll keeps of the hot set in its state.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct HotState {
    #[serde(default)]
    pub items: BTreeMap<Key, HotItem>,
    /// The operator's reviews and comments before this (ms) are the full
    /// sweeps' to report: the start of the sweep before the last one, so
    /// that a sweep that ran just before an event can't have missed it.
    pub cursor: Option<i64>,
    /// When the last sweep started (ms).
    pub sweep_start: Option<i64>,
    #[serde(default)]
    pub notifications: Feed,
    #[serde(default)]
    pub events: Feed,
    /// Items flagged as changed but not polled yet.
    #[serde(default)]
    pub pending: BTreeSet<Key>,
    /// GitHub rate limited the bot: no hot cycle polls before this (ms).
    #[serde(default)]
    pub paused_until: i64,
    /// Per request path, the validator of the response last read.
    #[serde(default)]
    pub etags: BTreeMap<String, Validator>,
    #[serde(default)]
    pub stats: Vec<CycleStat>,
}

impl HotState {
    /// The items to poll directly on every hot cycle: those the operator
    /// was active on lately, most recent first.
    pub fn direct(&self, now: i64) -> Vec<Key> {
        let mut recent: Vec<(i64, &Key)> = self
            .items
            .iter()
            .filter_map(|(k, it)| it.active.filter(|&a| now - a < RECENT_MS).map(|a| (a, k)))
            .collect();
        recent.sort_by(|a, b| b.cmp(a));
        recent
            .into_iter()
            .take(MAX_DIRECT)
            .map(|(_, k)| k.clone())
            .collect()
    }

    /// Records the operator's activity on an item, adding it as Recent if
    /// it isn't hot yet.
    pub fn touch(&mut self, key: &Key, pr: bool, title: &str, at: i64) {
        let item = self.items.entry(key.clone()).or_insert_with(|| HotItem {
            class: Class::Recent,
            pr,
            title: title.to_string(),
            active: None,
        });
        item.active = Some(item.active.map_or(at, |a| a.max(at)));
        if item.title.is_empty() {
            item.title = title.to_string();
        }
    }

    /// Replaces the items with a full sweep's, keeping the operator's
    /// recent activity (and the items it alone makes hot).
    pub fn rebuild(&mut self, fresh: BTreeMap<Key, HotItem>, now: i64) {
        let old = std::mem::replace(&mut self.items, fresh);
        for (key, it) in old {
            let Some(active) = it.active.filter(|&a| now - a < RECENT_MS) else {
                continue;
            };
            match self.items.get_mut(&key) {
                Some(cur) => cur.active = Some(active),
                None if it.class == Class::Recent => {
                    self.items.insert(key, it);
                }
                // Hot for a reason that no longer holds (closed, say).
                None => {}
            }
        }
        self.pending.retain(|k| self.items.contains_key(k));
    }

    /// Advances the cursor for a sweep that starts now.
    pub fn start_sweep(&mut self, now: i64) {
        self.cursor = Some(self.sweep_start.unwrap_or(now));
        self.sweep_start = Some(now);
        // Their paths hold the old cursor: never requested again.
        self.etags.retain(|p, _| !p.contains(SINCE_PARAM));
    }

    /// Records a cycle's requests, dropping stale statistics and
    /// validators.
    pub fn record(&mut self, stat: CycleStat) {
        self.stats.retain(|s| stat.at - s.at < STATS_KEEP_MS);
        self.stats.push(stat);
        self.etags
            .retain(|_, v| stat.at - v.used < VALIDATOR_KEEP_MS);
    }

    /// The number of items per class.
    pub fn sizes(&self) -> BTreeMap<&'static str, usize> {
        let mut out: BTreeMap<&str, usize> = Class::ALL.iter().map(|c| (c.name(), 0)).collect();
        for it in self.items.values() {
            *out.entry(it.class.name()).or_default() += 1;
        }
        out
    }
}

/// OWNER/REPO#N and whether it is a PR, of an issue or PR URL on
/// github.com or api.github.com.
pub fn key_of(url: &str) -> Option<(Key, bool)> {
    let rest = url
        .strip_prefix(API_REPOS)
        .or_else(|| url.strip_prefix(WEB))?;
    let rest = rest.split(['#', '?']).next()?;
    let mut parts = rest.split('/');
    let (owner, repo, kind, n) = (parts.next()?, parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() || owner.is_empty() || repo.is_empty() {
        return None;
    }
    let pr = match kind {
        "pull" | "pulls" => true,
        "issues" => false,
        _ => return None,
    };
    (!n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
        .then(|| (format!("{owner}/{repo}#{n}"), pr))
}

/// OWNER/REPO and N of a key.
pub fn split_key(key: &str) -> Option<(&str, &str)> {
    key.split_once('#')
}

/// The web URL of an item.
pub fn web_url(key: &str, pr: bool) -> String {
    let (repo, n) = split_key(key).unwrap_or((key, ""));
    let kind = if pr { "pull" } else { "issues" };
    format!("{WEB}{repo}/{kind}/{n}")
}

#[derive(Deserialize)]
struct Login {
    login: String,
}

#[derive(Deserialize)]
struct Label {
    name: String,
}

/// An issue or PR as search and the issues API list it.
#[derive(Deserialize)]
struct Listed {
    html_url: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    labels: Vec<Label>,
    #[serde(default)]
    pull_request: Option<serde_json::Value>,
    #[serde(default)]
    body: Option<String>,
}

#[derive(Deserialize)]
struct Search {
    items: Vec<Listed>,
}

/// The items of a page of search results for the bot's PRs; in the
/// forge, those without a bot-meta section aren't fork PRs.
pub fn parse_search(body: &str, class: Class) -> Result<Vec<(Key, HotItem)>> {
    let s: Search = serde_json::from_str(body).context("parsing search results")?;
    let (forks, own): (Vec<Listed>, Vec<Listed>) = s.items.into_iter().partition(|i| {
        class != Class::Forge || i.body.as_deref().is_some_and(|b| b.contains(FORK_META))
    });
    let mut out = listed(forks, class);
    out.extend(listed(own, Class::Upstream));
    Ok(out)
}

/// The ask issues of a page of the tracker's issues assigned to the
/// operator (PRs and issues without an ask label left out).
pub fn parse_asks(body: &str) -> Result<Vec<(Key, HotItem)>> {
    let issues: Vec<Listed> = serde_json::from_str(body).context("parsing the tracker's issues")?;
    let asks = issues
        .into_iter()
        .filter(|i| {
            i.pull_request.is_none()
                && i.labels
                    .iter()
                    .any(|l| ASK_LABELS.contains(&l.name.as_str()))
        })
        .collect();
    Ok(listed(asks, Class::Ask))
}

fn listed(items: Vec<Listed>, class: Class) -> Vec<(Key, HotItem)> {
    items
        .into_iter()
        .filter_map(|i| {
            let (key, pr) = key_of(&i.html_url)?;
            Some((
                key,
                HotItem {
                    class,
                    pr: pr || i.pull_request.is_some(),
                    title: i.title,
                    active: None,
                },
            ))
        })
        .collect()
}

#[derive(Deserialize)]
struct Notification {
    reason: String,
    updated_at: String,
    subject: Subject,
    repository: FullName,
}

#[derive(Deserialize)]
struct Subject {
    url: Option<String>,
    #[serde(default)]
    title: String,
}

#[derive(Deserialize)]
struct FullName {
    full_name: String,
}

/// A notification thread updated since the feed was last read.
#[derive(Debug, Clone, PartialEq)]
pub struct Changed {
    /// Its issue or PR, if it is one.
    pub item: Option<(Key, bool)>,
    pub repo: String,
    pub reason: String,
    pub title: String,
}

/// The threads of a notifications page updated after `mark` (the newest
/// updated_at read before), and the new mark. The first read (no mark)
/// only sets the mark: what came before is the sweeps'.
pub fn parse_notifications(
    body: &str,
    mark: Option<&str>,
) -> Result<(Vec<Changed>, Option<String>)> {
    let threads: Vec<Notification> =
        serde_json::from_str(body).context("parsing the notifications")?;
    // ISO 8601 UTC times, which sort as strings.
    let newest = threads.iter().map(|t| t.updated_at.as_str()).max();
    let next = match (mark, newest) {
        (Some(m), Some(n)) => Some(m.max(n).to_string()),
        (m, n) => m.or(n).map(str::to_string),
    };
    let Some(mark) = mark else {
        return Ok((Vec::new(), next));
    };
    let changed = threads
        .into_iter()
        .filter(|t| t.updated_at.as_str() > mark)
        .map(|t| Changed {
            item: t.subject.url.as_deref().and_then(key_of),
            repo: t.repository.full_name,
            reason: t.reason,
            title: t.subject.title,
        })
        .collect();
    Ok((changed, next))
}

#[derive(Deserialize)]
struct Event {
    id: String,
    #[serde(rename = "type")]
    kind: String,
    actor: Login,
    repo: RepoName,
    created_at: String,
    #[serde(default)]
    payload: EventPayload,
}

#[derive(Deserialize)]
struct RepoName {
    name: String,
}

#[derive(Deserialize, Default)]
struct EventPayload {
    issue: Option<EventIssue>,
    pull_request: Option<EventPr>,
}

#[derive(Deserialize)]
struct EventIssue {
    html_url: String,
    #[serde(default)]
    title: String,
    user: Option<Login>,
    pull_request: Option<serde_json::Value>,
}

/// The events API's PRs are trimmed to a few fields: an API URL, no
/// author or title.
#[derive(Deserialize)]
struct EventPr {
    url: String,
}

/// An issue or PR the operator reviewed or commented on, from his events.
#[derive(Debug, Clone, PartialEq)]
pub struct Touch {
    pub key: Key,
    pub pr: bool,
    pub repo: String,
    pub title: String,
    /// The bot opened it (only known for comments).
    pub by_bot: bool,
    /// When (ms).
    pub at: i64,
}

/// The event types that are the operator reviewing or commenting.
const TOUCH_EVENTS: [&str; 3] = [
    "IssueCommentEvent",
    "PullRequestReviewEvent",
    "PullRequestReviewCommentEvent",
];

/// The operator's reviews and comments in a page of his events newer than
/// `mark` (the newest event id read before), and the new mark.
pub fn parse_events(
    body: &str,
    mark: Option<&str>,
    operator: &str,
    bot: &str,
) -> Result<(Vec<Touch>, Option<String>)> {
    let events: Vec<Event> = serde_json::from_str(body).context("parsing the operator's events")?;
    let id = |s: &str| s.parse::<u64>().unwrap_or_default();
    let floor = mark.map_or(0, id);
    let next = events
        .iter()
        .map(|e| id(&e.id))
        .chain([floor])
        .max()
        .filter(|&n| n > 0)
        .map(|n| n.to_string());
    let touches = events
        .into_iter()
        .filter(|e| {
            id(&e.id) > floor
                && e.actor.login.eq_ignore_ascii_case(operator)
                && TOUCH_EVENTS.contains(&e.kind.as_str())
        })
        .filter_map(|e| {
            let at = parse_time(&e.created_at)?;
            let (url, title, by_bot, is_pr) = match (&e.payload.issue, &e.payload.pull_request) {
                (Some(i), _) => (
                    i.html_url.as_str(),
                    i.title.clone(),
                    i.user
                        .as_ref()
                        .is_some_and(|u| u.login.eq_ignore_ascii_case(bot)),
                    i.pull_request.is_some(),
                ),
                (None, Some(p)) => (p.url.as_str(), String::new(), false, true),
                (None, None) => return None,
            };
            let (key, pr) = key_of(url)?;
            Some(Touch {
                key,
                pr: pr || is_pr,
                repo: e.repo.name,
                title,
                by_bot,
                at,
            })
        })
        .collect();
    Ok((touches, next))
}

/// The RFC 3339 UTC time of milliseconds since the epoch.
pub fn rfc3339(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .unwrap_or_default()
}

/// Milliseconds since the epoch of an RFC 3339 time.
pub fn parse_time(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|t| t.timestamp_millis())
}

#[derive(Deserialize)]
struct Review {
    id: u64,
    user: Option<Login>,
    state: String,
    commit_id: Option<String>,
    html_url: String,
    submitted_at: Option<String>,
    #[serde(default)]
    body: Option<String>,
}

/// A conversation comment, or an inline review comment (with its review's
/// id).
#[derive(Deserialize)]
struct Comment {
    id: u64,
    user: Option<Login>,
    html_url: String,
    created_at: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    pull_request_review_id: Option<u64>,
}

/// What the operator did.
#[derive(Debug, Clone, PartialEq)]
pub enum Act {
    /// A review, in STATE (APPROVED, ...) of COMMIT.
    Review { state: String, commit: String },
    /// A conversation comment; with a line that is exactly /promote, or
    /// /no-carry (with blanks around it).
    Comment { promote: bool, no_carry: bool },
    /// An inline review comment whose review (by id) isn't among the
    /// events.
    ReviewComment { review: Option<u64> },
}

/// One of the operator's reviews or comments on an item.
#[derive(Debug, Clone, PartialEq)]
pub struct OpEvent {
    /// Its event id (see [`crate::event_id`]).
    pub id: String,
    pub url: String,
    pub at: i64,
    pub act: Act,
    pub excerpt: String,
    /// The ids of the inline comments of a review, which `bot-pr inbox`
    /// lists apart: reported with it.
    pub also: Vec<String>,
}

/// The pages of an item's listings a hot cycle read: a PR's reviews and
/// inline review comments, and its conversation comments.
#[derive(Default)]
pub struct Pages<'a> {
    pub reviews: Vec<&'a str>,
    pub review_comments: Vec<&'a str>,
    pub comments: Vec<&'a str>,
}

impl OpEvent {
    /// Whether it was reported before: itself, or the review it is an
    /// inline comment of.
    pub fn reported(&self, reported: &crate::Reported) -> bool {
        reported.contains_key(&self.id)
            || matches!(self.act, Act::ReviewComment { review: Some(r) }
                if reported.contains_key(&format!("pullrequestreview-{r}")))
    }

    pub fn approves(&self, head: &str) -> bool {
        matches!(&self.act, Act::Review { state, commit } if state == APPROVED && commit == head)
    }
}

/// The operator's reviews and comments at or after `cursor` (ms), oldest
/// first. His inline comments go with their review, when that is one of
/// them.
pub fn operator_events(pages: &Pages, operator: &str, cursor: i64) -> Result<Vec<OpEvent>> {
    let by_op = |u: &Option<Login>| {
        u.as_ref()
            .is_some_and(|u| u.login.eq_ignore_ascii_case(operator))
    };
    let mut out = Vec::new();
    // Review id to its event's index.
    let mut by_review: BTreeMap<u64, usize> = BTreeMap::new();
    for body in &pages.reviews {
        let reviews: Vec<Review> = serde_json::from_str(body).context("parsing reviews")?;
        for r in reviews {
            let Some(at) = r.submitted_at.as_deref().and_then(parse_time) else {
                // Pending: not submitted yet.
                continue;
            };
            if !by_op(&r.user) || at < cursor {
                continue;
            }
            by_review.insert(r.id, out.len());
            out.push(OpEvent {
                id: event_id(&r.html_url).unwrap_or_else(|| format!("pullrequestreview-{}", r.id)),
                url: r.html_url,
                at,
                act: Act::Review {
                    state: r.state,
                    commit: r.commit_id.unwrap_or_default(),
                },
                excerpt: excerpt(r.body.as_deref()),
                also: Vec::new(),
            });
        }
    }
    for body in &pages.review_comments {
        let comments: Vec<Comment> =
            serde_json::from_str(body).context("parsing review comments")?;
        for c in comments {
            let Some(at) = parse_time(&c.created_at) else {
                continue;
            };
            if !by_op(&c.user) || at < cursor {
                continue;
            }
            let id = event_id(&c.html_url).unwrap_or_else(|| format!("discussion_r{}", c.id));
            match c.pull_request_review_id.and_then(|r| by_review.get(&r)) {
                Some(&i) => out[i].also.push(id),
                None => out.push(OpEvent {
                    id,
                    url: c.html_url,
                    at,
                    act: Act::ReviewComment {
                        review: c.pull_request_review_id,
                    },
                    excerpt: excerpt(c.body.as_deref()),
                    also: Vec::new(),
                }),
            }
        }
    }
    for body in &pages.comments {
        let comments: Vec<Comment> = serde_json::from_str(body).context("parsing comments")?;
        for c in comments {
            let Some(at) = parse_time(&c.created_at) else {
                continue;
            };
            if !by_op(&c.user) || at < cursor {
                continue;
            }
            let body = c.body.unwrap_or_default();
            out.push(OpEvent {
                id: event_id(&c.html_url).unwrap_or_else(|| format!("issuecomment-{}", c.id)),
                url: c.html_url,
                at,
                act: Act::Comment {
                    promote: body.lines().any(|l| l.trim_end() == PROMOTE),
                    no_carry: body.lines().any(|l| l.trim() == NO_CARRY),
                },
                excerpt: excerpt(Some(&body)),
                also: Vec::new(),
            });
        }
    }
    out.sort_by_key(|e| e.at);
    Ok(out)
}

/// The first non-empty line of a text, shortened.
fn excerpt(text: Option<&str>) -> String {
    let line = text
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or_default();
    let mut out: String = line.chars().take(EXCERPT_CHARS).collect();
    if line.chars().count() > EXCERPT_CHARS {
        out.push_str("...");
    }
    out
}

/// Where the bot's work lives, from the operator config.
pub struct Places {
    pub tracker: String,
    pub forge_org: String,
}

/// What one of the operator's events on a hot item is news of.
#[derive(Debug, Clone, PartialEq)]
pub struct Classified {
    /// Its kind (see [`crate::KINDS`]).
    pub kind: &'static str,
    pub text: String,
    /// An approval of an upstream PR's head, which may make a sign-off
    /// due, or a /no-carry there, which may make dropping one due: both
    /// are bot-signoff-due's.
    pub signoff: bool,
}

/// The kind of the operator's event on an item, as the sweeps would
/// report it: on a fork PR an approval of its head (or /promote) is an
/// approval, anything else his activity there; on a tracker issue it is
/// an answer or a request (bot-notify's); on another PR, a review; on
/// another issue, item news. `head` is the PR's current head, when
/// known.
pub fn classify(
    key: &str,
    item: &HotItem,
    ev: &OpEvent,
    head: Option<&str>,
    places: &Places,
) -> Classified {
    let tracker = places.tracker.as_str();
    let at_head = head.is_some_and(|h| ev.approves(h));
    let repo = split_key(key).map_or(key, |(r, _)| r);
    // A fork PR opened since the last rebuild is only Recent so far.
    // (Or a PR of one of the forge's own repositories, which the rebuild
    // then puts right.)
    let owner = repo.split('/').next().unwrap_or_default();
    let forge = item.class == Class::Forge
        || (item.class == Class::Recent
            && item.pr
            && owner.eq_ignore_ascii_case(&places.forge_org));
    let promote = matches!(ev.act, Act::Comment { promote: true, .. });
    let no_carry = matches!(ev.act, Act::Comment { no_carry: true, .. });
    let kind = if forge && (at_head || promote) {
        "approval"
    } else if forge {
        "forge-review"
    } else if item.class == Class::Ask || repo.eq_ignore_ascii_case(tracker) {
        "notify"
    } else if item.pr {
        "review"
    } else {
        "news"
    };
    let what = match &ev.act {
        Act::Review { state, commit } => {
            let short = &commit[..commit.len().min(SHORT_SHA)];
            let head_note = if at_head { " (the head)" } else { "" };
            format!("review {state} at {short}{head_note}")
        }
        Act::Comment { promote: true, .. } => format!("comment {PROMOTE}"),
        Act::Comment { no_carry: true, .. } => format!("comment {NO_CARRY}"),
        Act::Comment { .. } => "comment".to_string(),
        Act::ReviewComment { .. } => "review comment".to_string(),
    };
    let title = if item.title.is_empty() {
        String::new()
    } else {
        format!("  {}", item.title)
    };
    let excerpt = if ev.excerpt.is_empty() {
        String::new()
    } else {
        format!(": {}", ev.excerpt)
    };
    Classified {
        kind,
        text: format!("{key}{title}: {what}{excerpt}"),
        signoff: (at_head || no_carry) && item.class == Class::Upstream,
    }
}

/// Whether a repository is the forge's or the bot's own (the tracker
/// among them).
pub fn is_bots_repo(repo: &str, forge_org: &str, bot: &str) -> bool {
    let owner = repo.split('/').next().unwrap_or_default();
    owner.eq_ignore_ascii_case(forge_org) || owner.eq_ignore_ascii_case(bot)
}

/// Whether an item outside the hot set that the operator touched is the
/// bot's business: in its repositories, or opened by it.
pub fn is_bots(touch: &Touch, forge_org: &str, bot: &str) -> bool {
    touch.by_bot || is_bots_repo(&touch.repo, forge_org, bot)
}

#[cfg(test)]
mod tests {
    use super::*;

    const OP: &str = "cgwalters";
    const BOT: &str = "cgwalters-bot";
    const TRACKER: &str = "cgwalters-forge/tracker";
    fn places() -> Places {
        Places {
            tracker: TRACKER.into(),
            forge_org: "cgwalters-forge".into(),
        }
    }

    #[test]
    fn keys() {
        for (url, want) in [
            ("https://github.com/o/r/pull/1", Some(("o/r#1", true))),
            (
                "https://github.com/o/r/pull/1#pullrequestreview-2",
                Some(("o/r#1", true)),
            ),
            ("https://github.com/o/r/issues/12", Some(("o/r#12", false))),
            (
                "https://api.github.com/repos/o/r/pulls/3",
                Some(("o/r#3", true)),
            ),
            (
                "https://api.github.com/repos/o/r/issues/4",
                Some(("o/r#4", false)),
            ),
            ("https://api.github.com/repos/o/r/issues/comments/5", None),
            ("https://api.github.com/repos/o/r/commits/abc", None),
            ("https://github.com/o/r/pull/x", None),
            ("https://example.com/o/r/pull/1", None),
        ] {
            let got = key_of(url);
            assert_eq!(got.as_ref().map(|(k, pr)| (k.as_str(), *pr)), want, "{url}");
        }
        assert_eq!(web_url("o/r#1", true), "https://github.com/o/r/pull/1");
        assert_eq!(web_url("o/r#2", false), "https://github.com/o/r/issues/2");
    }

    fn thread(reason: &str, at: &str, url: &str) -> String {
        format!(
            r#"{{"reason":"{reason}","updated_at":"{at}","subject":{{"url":"{url}","title":"T"}},"repository":{{"full_name":"o/r"}}}}"#
        )
    }

    #[test]
    fn notifications() {
        let body = format!(
            "[{},{}]",
            thread(
                "mention",
                "2026-09-30T10:00:05Z",
                "https://api.github.com/repos/o/r/issues/1"
            ),
            thread(
                "author",
                "2026-09-30T09:00:00Z",
                "https://api.github.com/repos/o/r/pulls/2"
            ),
        );
        // First read: only the mark.
        let (changed, mark) = parse_notifications(&body, None).unwrap();
        assert!(changed.is_empty());
        assert_eq!(mark.as_deref(), Some("2026-09-30T10:00:05Z"));
        let (changed, mark) = parse_notifications(&body, Some("2026-09-30T09:30:00Z")).unwrap();
        assert_eq!(mark.as_deref(), Some("2026-09-30T10:00:05Z"));
        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0].item, Some(("o/r#1".to_string(), false)));
        assert_eq!(changed[0].reason, "mention");
        // Nothing newer: the mark stays.
        let (changed, mark) = parse_notifications("[]", Some("2026-09-30T11:00:00Z")).unwrap();
        assert!(changed.is_empty());
        assert_eq!(mark.as_deref(), Some("2026-09-30T11:00:00Z"));
        assert!(parse_notifications("{}", None).is_err());
    }

    #[test]
    fn events() {
        let body = r#"[
          {"id":"30","type":"PullRequestReviewEvent","actor":{"login":"cgwalters"},"repo":{"name":"cgwalters-forge/bootc"},
           "created_at":"2026-09-30T10:00:00Z","payload":{"review":{"id":9},"pull_request":{"url":"https://api.github.com/repos/cgwalters-forge/bootc/pulls/30","number":30}}},
          {"id":"29","type":"IssueCommentEvent","actor":{"login":"cgwalters"},"repo":{"name":"bootc-dev/bootc"},
           "created_at":"2026-09-30T09:00:00Z","payload":{"issue":{"html_url":"https://github.com/bootc-dev/bootc/pull/2515","title":"Fix","user":{"login":"cgwalters-bot"},"pull_request":{}}}},
          {"id":"28","type":"PushEvent","actor":{"login":"cgwalters"},"repo":{"name":"o/r"},"created_at":"2026-09-30T08:00:00Z","payload":{}},
          {"id":"27","type":"IssueCommentEvent","actor":{"login":"someone"},"repo":{"name":"o/r"},
           "created_at":"2026-09-30T08:00:00Z","payload":{"issue":{"html_url":"https://github.com/o/r/issues/1","title":"X"}}},
          {"id":"26","type":"IssueCommentEvent","actor":{"login":"cgwalters"},"repo":{"name":"o/r"},
           "created_at":"2026-09-30T07:00:00Z","payload":{"issue":{"html_url":"https://github.com/o/r/issues/2","title":"Y","user":{"login":"alice"}}}}
        ]"#;
        let (touches, mark) = parse_events(body, None, OP, BOT).unwrap();
        assert_eq!(mark.as_deref(), Some("30"));
        let got: Vec<(&str, bool, bool)> = touches
            .iter()
            .map(|t| (t.key.as_str(), t.pr, is_bots(t, "cgwalters-forge", BOT)))
            .collect();
        assert_eq!(
            got,
            [
                ("cgwalters-forge/bootc#30", true, true),
                ("bootc-dev/bootc#2515", true, true),
                ("o/r#2", false, false),
            ]
        );
        assert_eq!(touches[1].title, "Fix");
        let (touches, mark) = parse_events(body, Some("29"), OP, BOT).unwrap();
        assert_eq!(touches.len(), 1);
        assert_eq!(mark.as_deref(), Some("30"));
        let (touches, mark) = parse_events("[]", Some("30"), OP, BOT).unwrap();
        assert!(touches.is_empty());
        assert_eq!(mark.as_deref(), Some("30"));
    }

    const REVIEWS: &str = r#"[
      {"id":1,"user":{"login":"cgwalters"},"state":"COMMENTED","commit_id":"aaaa","html_url":"https://github.com/o/r/pull/1#pullrequestreview-1","submitted_at":"2026-09-30T08:00:00Z","body":"old"},
      {"id":2,"user":{"login":"alice"},"state":"APPROVED","commit_id":"bbbb","html_url":"https://github.com/o/r/pull/1#pullrequestreview-2","submitted_at":"2026-09-30T10:00:00Z"},
      {"id":3,"user":{"login":"cgwalters"},"state":"APPROVED","commit_id":"bbbbbbbbbbbbbbbb","html_url":"https://github.com/o/r/pull/1#pullrequestreview-3","submitted_at":"2026-09-30T10:01:00Z","body":"\n\nLGTM, thanks\nmore"},
      {"id":4,"user":{"login":"cgwalters"},"state":"PENDING","commit_id":"bbbb","html_url":"https://github.com/o/r/pull/1#pullrequestreview-4"}
    ]"#;
    const COMMENTS: &str = r#"[
      {"id":7,"user":{"login":"cgwalters"},"html_url":"https://github.com/o/r/pull/1#issuecomment-7","created_at":"2026-09-30T10:02:00Z","body":"Looks good\n/promote\n"},
      {"id":8,"user":{"login":"cgwalters-bot"},"html_url":"https://github.com/o/r/pull/1#issuecomment-8","created_at":"2026-09-30T10:03:00Z","body":"/promote"},
      {"id":9,"user":{"login":"cgwalters"},"html_url":"https://github.com/o/r/pull/1#issuecomment-9","created_at":"2026-09-30T10:06:00Z","body":"Not that one.\r\n  /no-carry \r\n"}
    ]"#;
    /// His inline comments: one of review 3, one of a review before the
    /// cursor (a lone reply), and the bot's.
    const REVIEW_COMMENTS: &str = r#"[
      {"id":20,"user":{"login":"cgwalters"},"html_url":"https://github.com/o/r/pull/1#discussion_r20","created_at":"2026-09-30T10:01:00Z","body":"nit","pull_request_review_id":3},
      {"id":21,"user":{"login":"cgwalters"},"html_url":"https://github.com/o/r/pull/1#discussion_r21","created_at":"2026-09-30T10:04:00Z","body":"and here","pull_request_review_id":1},
      {"id":22,"user":{"login":"cgwalters-bot"},"html_url":"https://github.com/o/r/pull/1#discussion_r22","created_at":"2026-09-30T10:05:00Z","body":"done","pull_request_review_id":5}
    ]"#;
    fn pages() -> Pages<'static> {
        Pages {
            reviews: vec![REVIEWS],
            review_comments: vec![REVIEW_COMMENTS],
            comments: vec![COMMENTS],
        }
    }

    #[test]
    fn operator_activity() {
        let cursor = parse_time("2026-09-30T09:00:00Z").unwrap();
        let evs = operator_events(&pages(), OP, cursor).unwrap();
        let ids: Vec<&str> = evs.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "pullrequestreview-3",
                "issuecomment-7",
                "discussion_r21",
                "issuecomment-9"
            ]
        );
        assert_eq!(evs[0].also, ["discussion_r20"]);
        assert_eq!(evs[2].act, Act::ReviewComment { review: Some(1) });
        assert_eq!(evs[0].excerpt, "LGTM, thanks");
        assert!(evs[0].approves("bbbbbbbbbbbbbbbb"));
        assert!(!evs[0].approves("cccc"));
        assert_eq!(
            evs[1].act,
            Act::Comment {
                promote: true,
                no_carry: false
            }
        );
        assert_eq!(
            evs[3].act,
            Act::Comment {
                promote: false,
                no_carry: true
            }
        );
        assert!(
            operator_events(
                &Pages {
                    reviews: vec![REVIEWS],
                    ..Pages::default()
                },
                "nobody",
                0
            )
            .unwrap()
            .is_empty()
        );
    }

    #[test]
    fn kinds() {
        let cursor = parse_time("2026-09-30T09:00:00Z").unwrap();
        let evs = operator_events(&pages(), OP, cursor).unwrap();
        // A fork PR opened since the last rebuild, Recent so far.
        let recent_fork = HotItem {
            class: Class::Recent,
            pr: true,
            title: String::new(),
            active: None,
        };
        let c = classify(
            "cgwalters-forge/bootc#31",
            &recent_fork,
            &evs[0],
            Some("bbbbbbbbbbbbbbbb"),
            &places(),
        );
        assert_eq!((c.kind, c.signoff), ("approval", false));
        let (approve, promote, no_carry) = (&evs[0], &evs[1], &evs[3]);
        let item = |class, pr| HotItem {
            class,
            pr,
            title: "Fix".into(),
            active: None,
        };
        const HEAD: Option<&str> = Some("bbbbbbbbbbbbbbbb");
        const OLD: Option<&str> = Some("cccc");
        for (key, it, ev, head, kind, signoff) in [
            (
                "o/r#1",
                item(Class::Forge, true),
                approve,
                HEAD,
                "approval",
                false,
            ),
            (
                "o/r#1",
                item(Class::Forge, true),
                approve,
                OLD,
                "forge-review",
                false,
            ),
            (
                "o/r#1",
                item(Class::Forge, true),
                promote,
                None,
                "approval",
                false,
            ),
            (
                "o/r#1",
                item(Class::Upstream, true),
                approve,
                HEAD,
                "review",
                true,
            ),
            (
                "o/r#1",
                item(Class::Upstream, true),
                approve,
                OLD,
                "review",
                false,
            ),
            (
                "o/r#1",
                item(Class::Upstream, true),
                promote,
                None,
                "review",
                false,
            ),
            (
                "o/r#1",
                item(Class::Upstream, true),
                no_carry,
                None,
                "review",
                true,
            ),
            (
                "o/r#1",
                item(Class::Forge, true),
                no_carry,
                None,
                "forge-review",
                false,
            ),
            (
                "cgwalters-forge/tracker#5",
                item(Class::Ask, false),
                promote,
                None,
                "notify",
                false,
            ),
            (
                "cgwalters-forge/tracker#6",
                item(Class::Recent, false),
                promote,
                None,
                "notify",
                false,
            ),
            (
                "o/r#1",
                item(Class::Recent, true),
                approve,
                None,
                "review",
                false,
            ),
            (
                "o/r#2",
                item(Class::Recent, false),
                promote,
                None,
                "news",
                false,
            ),
        ] {
            let c = classify(key, &it, ev, head, &places());
            assert_eq!(
                (c.kind, c.signoff),
                (kind, signoff),
                "{key} {:?} {:?}",
                it.class,
                ev.act
            );
        }
        assert_eq!(
            classify("o/r#1", &item(Class::Forge, true), approve, HEAD, &places()).text,
            "o/r#1  Fix: review APPROVED at bbbbbbbbbbbb (the head): LGTM, thanks"
        );
    }

    #[test]
    fn hot_set() {
        let search = r#"{"items":[
          {"html_url":"https://github.com/cgwalters-forge/bootc/pull/30","title":"Fix","pull_request":{},"body":"Fix it.\n<!-- bot-meta -->\n..."},
          {"html_url":"https://github.com/cgwalters-forge/review/pull/3","title":"Own","pull_request":{},"body":"No meta"}]}"#;
        let asks = r#"[
          {"html_url":"https://github.com/cgwalters-forge/tracker/issues/151","title":"Q","labels":[{"name":"question"},{"name":"P1"}]},
          {"html_url":"https://github.com/cgwalters-forge/tracker/issues/152","title":"Epic","labels":[{"name":"P1"}]},
          {"html_url":"https://github.com/cgwalters-forge/tracker/pull/153","title":"PR","labels":[{"name":"review"}],"pull_request":{}}
        ]"#;
        let mut fresh: BTreeMap<Key, HotItem> = parse_search(search, Class::Forge)
            .unwrap()
            .into_iter()
            .collect();
        fresh.extend(parse_asks(asks).unwrap());
        assert_eq!(
            fresh.keys().collect::<Vec<_>>(),
            [
                "cgwalters-forge/bootc#30",
                "cgwalters-forge/review#3",
                "cgwalters-forge/tracker#151"
            ]
        );
        assert_eq!(fresh["cgwalters-forge/review#3"].class, Class::Upstream);
        fresh.remove("cgwalters-forge/review#3");
        let now = 10 * RECENT_MS;
        let mut st = HotState::default();
        st.touch(&"o/r#9".to_string(), true, "Old", now - RECENT_MS - 1);
        st.touch(&"o/r#8".to_string(), true, "Recent", now - 1000);
        st.touch(
            &"cgwalters-forge/bootc#30".to_string(),
            true,
            "",
            now - 2000,
        );
        st.items.insert(
            "o/r#7".into(),
            HotItem {
                class: Class::Upstream,
                pr: true,
                title: "Merged".into(),
                active: Some(now - 10),
            },
        );
        st.pending.insert("o/r#9".into());
        st.rebuild(fresh, now);
        assert_eq!(
            st.items.keys().collect::<Vec<_>>(),
            [
                "cgwalters-forge/bootc#30",
                "cgwalters-forge/tracker#151",
                "o/r#8"
            ]
        );
        assert_eq!(st.items["cgwalters-forge/bootc#30"].class, Class::Forge);
        assert!(st.pending.is_empty());
        assert_eq!(st.direct(now), ["o/r#8", "cgwalters-forge/bootc#30"]);
        assert_eq!(
            st.sizes(),
            BTreeMap::from([("ask", 1), ("forge", 1), ("recent", 1), ("upstream", 0)])
        );
        // The cursor trails a sweep behind.
        st.start_sweep(100);
        assert_eq!((st.cursor, st.sweep_start), (Some(100), Some(100)));
        st.start_sweep(200);
        assert_eq!((st.cursor, st.sweep_start), (Some(100), Some(200)));
    }
}
