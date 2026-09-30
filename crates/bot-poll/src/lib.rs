//! What `bot-poll` reads in one sweep's outputs, and what of it is news:
//! the parsers of the human-readable reports of bot-notify, `bot-pr
//! inbox` and bot-watch (the ones the coordinator reads), the seen-sets
//! that carry across sweeps and restarts, and the `--summary` rendering.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub mod hot;
pub mod operator;
use operator::Operator;

/// A key not there for this long is forgotten, and news again when it
/// comes back; a shorter absence (a sweep that missed it, say a failed
/// read) is not news.
pub const FORGET_MS: i64 = 3600 * 1000;
/// An event id (see [`event_id`]) is remembered this long after it was
/// last listed, so that an item that comes back after [`FORGET_MS`] is
/// still not news.
pub const REPORTED_KEEP_MS: i64 = 7 * 24 * 3600 * 1000;
pub const STATE_VERSION: u32 = 1;
const GITHUB: &str = "https://github.com/";
/// The URL fragments that name one review or comment, by its
/// GitHub-wide unique id.
const EVENT_ANCHORS: [&str; 3] = ["pullrequestreview-", "issuecomment-", "discussion_r"];
/// `bot-pr inbox`'s line naming a fork PR's approval.
const APPROVED_BY: &str = "  -> approved by ";

/// A step of the sweep whose output holds news.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Source {
    Notify,
    Inbox,
    Watch,
}

impl Source {
    pub const ALL: [Source; 3] = [Source::Notify, Source::Inbox, Source::Watch];

    /// The step's name, which is also its output's file name, NAME.txt.
    pub fn name(self) -> &'static str {
        match self {
            Source::Notify => "notify",
            Source::Inbox => "inbox",
            Source::Watch => "watch",
        }
    }

    /// The seen-sets its output feeds.
    fn sets(self) -> &'static [&'static str] {
        match self {
            Source::Notify => &["notify"],
            Source::Inbox => &["approval", "forge-review"],
            Source::Watch => &[
                "health",
                "review",
                "signoff",
                "promotion",
                "text",
                "rebase",
                "news",
            ],
        }
    }

    fn parse(self, text: &str) -> Parsed {
        match self {
            Source::Notify => parse_notify(text),
            Source::Inbox => parse_inbox(text),
            Source::Watch => parse_watch(text),
        }
    }

    /// The sets whose items an output lists in full, so that what it
    /// lacks is really gone. bot-watch reports even when a URL or a
    /// section failed (exit 1): a report is whole once it has its
    /// closing "Swept" line, but for the sections its warnings say are
    /// incomplete.
    fn whole_sets(self, text: &str, status: Option<i32>) -> Vec<&'static str> {
        match self {
            Source::Watch => {
                let swept = text.lines().any(|l| {
                    l.strip_prefix("Swept ")
                        .and_then(|r| r.split_once(' '))
                        .is_some_and(|(n, r)| {
                            n.bytes().all(|b| b.is_ascii_digit()) && r.starts_with("URLs")
                        })
                });
                if !swept {
                    return Vec::new();
                }
                let failed: Vec<&str> = WATCH_SECTION_FAILURES
                    .iter()
                    .filter(|(warning, _)| text.contains(warning))
                    .flat_map(|(_, sets)| sets.iter().copied())
                    .collect();
                self.sets()
                    .iter()
                    .copied()
                    .filter(|s| !failed.contains(s))
                    .collect()
            }
            _ if status == Some(0) => self.sets().to_vec(),
            _ => Vec::new(),
        }
    }
}

/// bot-watch's warnings that a section is incomplete, and its sets.
const WATCH_SECTION_FAILURES: [(&str, &[&str]); 4] = [
    ("the priority health sweep failed", &["health"]),
    (
        "only the board's PRs were checked for outstanding reviews",
        &["review", "rebase"],
    ),
    ("looking for sign-offs due failed", &["signoff"]),
    ("looking for promotions due failed", &["promotion", "text"]),
];

/// The kinds of news, most urgent first, as the NEWS line and the
/// summary order them, with their titles, where OPERATOR and
/// OPERATOR'S stand for the operator's login (see [`kind_title`]).
/// health-P0 is the new health lines of P0 PRs (they share the health
/// seen-set).
pub const KINDS: [(&str, &str); 11] = [
    ("health-P0", "Priority health (P0)"),
    ("review", "Outstanding reviews by OPERATOR"),
    ("approval", "Approved fork PRs (promote)"),
    ("signoff", "Sign-offs"),
    ("promotion", "Promotions"),
    ("text", "Needs OPERATOR'S text"),
    ("notify", "Requests and answers from OPERATOR"),
    ("forge-review", "OPERATOR'S activity on fork PRs"),
    ("rebase", "Needs rebase"),
    ("health", "Priority health (P1)"),
    ("news", "Item news"),
];

/// One thing a report lists: its identity across sweeps, and what the
/// summary shows of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    pub key: String,
    pub url: String,
    pub text: String,
    /// A P0 health line.
    pub p0: bool,
    /// What it reports, when that has a stable id of its own (see
    /// [`Item::event`]).
    pub event: Option<String>,
}

impl Item {
    fn new(key: impl Into<String>, url: impl Into<String>, text: impl Into<String>) -> Self {
        Item {
            key: key.into(),
            url: url.into(),
            text: text.into(),
            p0: false,
            event: None,
        }
    }

    /// The id of the review, comment or sign-off it reports, which the
    /// same event keeps whichever report lists it: its own, else its
    /// URL's.
    pub fn event(&self) -> Option<String> {
        self.event.clone().or_else(|| event_id(&self.url))
    }
}

/// The id of the review or comment a URL points at (its fragment, such as
/// "pullrequestreview-123"), if it does.
pub fn event_id(url: &str) -> Option<String> {
    let (_, frag) = url.split_once('#')?;
    EVENT_ANCHORS
        .iter()
        .any(|a| {
            frag.strip_prefix(a)
                .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
        })
        .then(|| frag.to_string())
}

/// The event id of a line in bot-watch's sign-off, promotion or
/// "Needs your text" section (SET), which is its own id: one is news
/// once, however long it stays or comes back.
pub fn line_event(set: &str, line: &str) -> String {
    format!("{set} {line}")
}

/// A line of such a section of SET as an item, keyed by itself.
fn line_item(set: &str, line: &str) -> Item {
    let l = line.trim();
    let mut item = Item::new(l, first_url(l), l);
    item.event = Some(line_event(set, l));
    item
}

/// A report's items, by seen-set.
pub type Parsed = BTreeMap<&'static str, Vec<Item>>;

/// The first github.com URL in s, without trailing punctuation.
pub fn first_url(s: &str) -> String {
    s.find(GITHUB)
        .map(|i| {
            let url = s[i..].split_whitespace().next().unwrap_or_default();
            url.trim_end_matches([')', '.', ',', ':']).to_string()
        })
        .unwrap_or_default()
}

/// OWNER/REPO#N, as bot-watch names issues and PRs.
fn parse_ref(s: &str) -> Option<&str> {
    let (repo, n) = s.split_once('#')?;
    let ok = repo.split('/').count() == 2
        && !repo.contains(char::is_whitespace)
        && !n.is_empty()
        && n.bytes().all(|b| b.is_ascii_digit());
    ok.then_some(s)
}

/// The URL of OWNER/REPO#N; issues/ URLs redirect to PRs too.
fn ref_url(r: &str, kind: &str) -> String {
    match r.split_once('#') {
        Some((repo, n)) => format!("{GITHUB}{repo}/{kind}/{n}"),
        None => String::new(),
    }
}

/// s without exactly n leading spaces, if it has them and then more text.
fn indented(s: &str, n: usize) -> Option<&str> {
    let rest = s.get(n..)?;
    (s.as_bytes()[..n].iter().all(|&b| b == b' ') && rest.starts_with(|c: char| !c.is_whitespace()))
        .then_some(rest)
}

/// `bot-pr inbox`: a line per fork PR ("URL  [VERDICT]  TITLE"), then his
/// activity ("  TIME KIND...: LINK", with "    > excerpt" lines) and hints
/// ("  -> ..."). Approvals are the [APPROVED...] verdicts, not "APPROVED
/// earlier; new commits since", which leaves nothing to promote; one is
/// keyed by his latest approving review listed too, so that approving a
/// new head is news again, and its event is the approving review or
/// /promote comment its "-> approved by URL:" line names.
pub fn parse_inbox(text: &str) -> Parsed {
    let mut approval = Vec::new();
    let mut activity = Vec::new();
    let mut pr: Option<&str> = None;
    // The approval of the current PR, as an index into approval.
    let mut approved: Option<usize> = None;
    for line in text.lines() {
        if line.starts_with(GITHUB) {
            let (url, rest) = line.split_once("  ").unwrap_or((line, ""));
            pr = Some(url);
            approved = None;
            let (verdict, title) = match rest.strip_prefix('[').and_then(|r| r.split_once("]  ")) {
                Some((v, t)) => (v, t),
                None => ("", rest),
            };
            if verdict == "APPROVED" || verdict.starts_with("APPROVED,") {
                approved = Some(approval.len());
                approval.push(Item::new(
                    format!("{url} [{verdict}]"),
                    url,
                    format!("{title} [{verdict}]"),
                ));
            }
            continue;
        }
        let act = indented(line, 2)
            .and_then(|l| l.split_once(' '))
            .filter(|(ts, _)| ts.len() > 5 && ts.starts_with("20") && ts.as_bytes()[4] == b'-');
        match (act, pr) {
            (Some((ts, what)), Some(pr)) => {
                let url = first_url(what);
                if let (Some(i), true) = (approved, what.starts_with("review APPROVED")) {
                    approval[i].key = format!("{pr} [APPROVED] {url}");
                    approval[i].event = event_id(&url);
                }
                activity.push(Item::new(
                    format!("{pr} {ts} {what}"),
                    if url.is_empty() { pr.to_string() } else { url },
                    format!("{pr}: {what}"),
                ));
            }
            _ if line.starts_with(APPROVED_BY) => {
                if let Some(i) = approved {
                    approval[i].event = event_id(&first_url(line)).or(approval[i].event.take());
                }
            }
            _ if line.starts_with(|c: char| !c.is_whitespace()) => {
                pr = None;
                approved = None;
            }
            _ => {}
        }
    }
    Parsed::from([("approval", approval), ("forge-review", activity)])
}

/// bot-notify: the pending records, "request {JSON}" or "answer {JSON}",
/// listed on every run until acked.
pub fn parse_notify(text: &str) -> Parsed {
    let mut items = Vec::new();
    for line in text.lines() {
        let Some((kind, json)) = line.split_once(' ') else {
            continue;
        };
        if !matches!(kind, "request" | "answer") || !json.starts_with('{') {
            continue;
        }
        let Ok(r) = serde_json::from_str::<serde_json::Value>(json) else {
            eprintln!("bot-poll: warning: skipping an unparseable bot-notify record: {line:.80}");
            continue;
        };
        let field = |k: &str| r.get(k).and_then(|v| v.as_str()).unwrap_or_default();
        let url = [field("url"), field("thread_url")]
            .into_iter()
            .find(|s| !s.is_empty())
            .unwrap_or_default();
        let thread = field("thread_id");
        let author = Some(field("author"))
            .filter(|s| !s.is_empty())
            .unwrap_or("?");
        let title = Some(field("title"))
            .filter(|s| !s.is_empty())
            .unwrap_or(url);
        items.push(Item::new(
            format!("{kind} {url} {thread}"),
            url,
            format!("{kind} from @{author}: {title} [thread {thread}]"),
        ));
    }
    Parsed::from([("notify", items)])
}

#[derive(Clone, Copy, PartialEq)]
enum Section {
    Health,
    Signoff,
    Promotion,
    Text,
    Review,
    Rebase,
    News,
}

/// bot-watch: its sections (a header line, then indented lines until a
/// blank one), then the items with news ("TITLE  [STATUS]  ID", then
/// "  REF", then "    CHANGE" with "      LINK" lines, and "  -> ACTION"
/// lines), and a closing "Swept ..." line. Warnings from stderr, mixed
/// in anywhere, are skipped.
pub fn parse_watch(text: &str) -> Parsed {
    let mut out = Parsed::new();
    for set in Source::Watch.sets() {
        out.insert(set, Vec::new());
    }
    let lines: Vec<&str> = text.lines().collect();
    let link_after = |i: usize| {
        lines
            .get(i + 1)
            .and_then(|l| indented(l, 6))
            .filter(|l| l.starts_with(GITHUB) && !l.contains(' '))
            .map(str::to_string)
    };
    let mut section: Option<Section> = None;
    // The current entry: OWNER/REPO#N and its title (review, rebase), or
    // for news the item's title and id, and its current ref.
    let mut entry: Option<(String, String)> = None;
    let mut news_ref = String::new();
    let mut group = "";
    for (i, &line) in lines.iter().enumerate() {
        if line.is_empty() {
            if section != Some(Section::News) {
                section = None;
            }
            continue;
        }
        if is_diagnostic(line) {
            continue;
        }
        if !line.starts_with(' ') {
            entry = None;
            section = if line == "Priority health:" {
                Some(Section::Health)
            } else if line == "Sign-offs:" {
                Some(Section::Signoff)
            } else if line == "Promotions:" {
                Some(Section::Promotion)
            } else if line == "Needs your text:" {
                Some(Section::Text)
            } else if line.starts_with("Outstanding reviews by ") {
                Some(Section::Review)
            } else if line.starts_with("Needs rebase") {
                Some(Section::Rebase)
            } else if let Some((title, id)) = news_item(line) {
                entry = Some((title.to_string(), id.to_string()));
                news_ref.clear();
                Some(Section::News)
            } else {
                None
            };
            continue;
        }
        let push = |out: &mut Parsed, set: &str, item: Item| {
            out.get_mut(set).expect("a watch set").push(item)
        };
        match section {
            Some(Section::Health) => {
                let Some(l) = indented(line, 2) else { continue };
                let f: Vec<&str> = l.splitn(5, ' ').collect();
                let valid = f.len() == 5
                    && f[0].starts_with('P')
                    && f[3].ends_with(':')
                    && f[3]
                        .trim_end_matches(':')
                        .bytes()
                        .all(|b| b.is_ascii_hexdigit());
                if valid {
                    let head = f[3].trim_end_matches(':');
                    let mut item = Item::new(format!("{} {} {} {head}", f[0], f[1], f[2]), f[2], l);
                    item.p0 = f[0] == "P0";
                    push(&mut out, "health", item);
                }
            }
            Some(Section::Signoff) => push(&mut out, "signoff", line_item("signoff", line)),
            Some(Section::Promotion) => push(&mut out, "promotion", line_item("promotion", line)),
            Some(Section::Text) => push(&mut out, "text", line_item("text", line)),
            Some(Section::Review) => {
                if let Some((r, title)) = indented(line, 2)
                    .and_then(|l| l.split_once("  "))
                    .filter(|(r, _)| parse_ref(r).is_some())
                {
                    entry = Some((r.to_string(), title.to_string()));
                } else if let (Some((r, title)), Some(l)) = (&entry, indented(line, 4)) {
                    let link = link_after(i);
                    let key = format!("{r} {}", link.as_deref().unwrap_or(l));
                    let url = link.unwrap_or_else(|| ref_url(r, "pull"));
                    push(
                        &mut out,
                        "review",
                        Item::new(key, url, format!("{r}  {title}: {l}")),
                    );
                }
            }
            Some(Section::Rebase) => {
                if let Some(g) = indented(line, 2).and_then(|l| l.strip_suffix(':')) {
                    group = g;
                } else if let Some((r, title)) = indented(line, 4)
                    .and_then(|l| l.split_once("  "))
                    .filter(|(r, _)| parse_ref(r).is_some())
                {
                    entry = Some((r.to_string(), title.to_string()));
                } else if let (Some((r, _)), Some(l)) = (entry.take(), indented(line, 6)) {
                    push(
                        &mut out,
                        "rebase",
                        Item::new(
                            r.clone(),
                            ref_url(&r, "pull"),
                            format!("{r} ({group}): {l}"),
                        ),
                    );
                }
            }
            Some(Section::News) => {
                let Some((title, id)) = &entry else { continue };
                if let Some(r) = indented(line, 2).and_then(parse_ref) {
                    news_ref = r.to_string();
                } else if let Some(l) = indented(line, 4) {
                    if is_bot_activity(l) {
                        continue;
                    }
                    let link = link_after(i);
                    let key = format!(
                        "{id} {news_ref} {l} {}",
                        link.as_deref().unwrap_or_default()
                    );
                    let url = link.unwrap_or_else(|| ref_url(&news_ref, "issues"));
                    push(
                        &mut out,
                        "news",
                        Item::new(key.trim_end(), url, format!("{title}: {news_ref} {l}")),
                    );
                }
            }
            None => {}
        }
    }
    out
}

/// "warning: ..." or "error: ...", or "TOOL: warning: ...": stderr mixed
/// into a report.
fn is_diagnostic(line: &str) -> bool {
    let diag = |l: &str| l.starts_with("warning: ") || l.starts_with("error: ");
    diag(line)
        || line
            .split_once(": ")
            .is_some_and(|(tool, rest)| !tool.contains(' ') && diag(rest))
}

/// "TITLE  [STATUS]  ID", an item with news in bot-watch's report.
fn news_item(line: &str) -> Option<(&str, &str)> {
    let (rest, id) = line.rsplit_once("  ")?;
    let (title, status) = rest.rsplit_once("  ")?;
    (status.starts_with('[') && status.ends_with(']') && !id.is_empty() && !id.contains(' '))
        .then_some((title, id))
}

/// Whether a change is by a bot account ("... by @renovate[bot]..."):
/// their pushes and comments are not news.
fn is_bot_activity(change: &str) -> bool {
    change.split(" by @").skip(1).any(|rest| {
        let login = rest
            .split(|c: char| c.is_whitespace() || c == ':')
            .next()
            .unwrap_or_default();
        login.ends_with("[bot]")
    })
}

/// A new item, as the report and the state keep it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NewsItem {
    pub url: String,
    pub text: String,
}

/// The new items of one kind.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KindNews {
    pub kind: String,
    pub items: Vec<NewsItem>,
}

/// The seen-sets: per set, each key with when it was last there (ms).
pub type Seen = BTreeMap<String, BTreeMap<String, i64>>;
/// The event ids (see [`Item::event`]) listed or reported, with when they
/// last were (ms): one is news once, whichever report or poll lists it.
pub type Reported = BTreeMap<String, i64>;

/// One step's output: its text, and its exit status (None: killed, or it
/// didn't start).
pub struct Output {
    pub text: String,
    pub status: Option<i32>,
}

/// What is new in one run's outputs (a missing source is incomplete)
/// against the seen-sets and the reported events, in KINDS order, and the
/// seen-sets and reported events after it. A source whose output is
/// incomplete leaves its sets as they are. An item whose event was
/// reported before is not news, even under a new key or in another set.
pub fn evaluate(
    outputs: &BTreeMap<Source, Output>,
    seen: &Seen,
    reported: &Reported,
    now: i64,
) -> (Vec<KindNews>, Seen, Reported) {
    let mut news: BTreeMap<&str, Vec<NewsItem>> = BTreeMap::new();
    let mut next = Seen::new();
    let mut next_reported = reported.clone();
    for source in Source::ALL {
        let o = outputs.get(&source);
        let whole = o
            .map(|o| source.whole_sets(&o.text, o.status))
            .unwrap_or_default();
        let mut parsed = o.map(|o| source.parse(&o.text)).unwrap_or_default();
        for &set in source.sets() {
            let old = seen.get(set).cloned().unwrap_or_default();
            if !whole.contains(&set) {
                next.insert(set.to_string(), old);
                continue;
            }
            let mut cur = BTreeMap::new();
            for item in parsed.remove(set).unwrap_or_default() {
                // Checked against the events before this run, so that two
                // items reporting one new event are both news.
                let event = item.event();
                let known = event.as_ref().is_some_and(|e| reported.contains_key(e));
                if let Some(e) = event {
                    next_reported.insert(e, now);
                }
                if cur.insert(item.key.clone(), now).is_some()
                    || old.contains_key(&item.key)
                    || known
                {
                    continue;
                }
                let kind = if set == "health" && item.p0 {
                    "health-P0"
                } else {
                    set
                };
                news.entry(kind).or_default().push(NewsItem {
                    url: item.url,
                    text: item.text,
                });
            }
            for (key, at) in old {
                if now - at < FORGET_MS {
                    cur.entry(key).or_insert(at);
                }
            }
            next.insert(set.to_string(), cur);
        }
    }
    let news = news.into_iter().map(|(k, v)| (k.to_string(), v)).collect();
    next_reported.retain(|_, at| now - *at < REPORTED_KEEP_MS);
    (in_kind_order(news), next, next_reported)
}

/// News by kind, in KINDS order.
pub fn in_kind_order(mut news: BTreeMap<String, Vec<NewsItem>>) -> Vec<KindNews> {
    KINDS
        .iter()
        .filter_map(|(kind, _)| {
            news.remove(*kind)
                .filter(|items| !items.is_empty())
                .map(|items| KindNews {
                    kind: kind.to_string(),
                    items,
                })
        })
        .collect()
}

/// The last NEWS report, for --summary.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LastNews {
    pub at: String,
    pub run: String,
    pub line: String,
    pub items: Vec<KindNews>,
}

/// What bot-poll keeps in STATE-DIR/state.json.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct State {
    pub version: u32,
    #[serde(default)]
    pub seen: Seen,
    #[serde(default)]
    pub reported: Reported,
    /// The newest run checked for news.
    #[serde(default)]
    pub evaluated: Option<String>,
    #[serde(default)]
    pub last_news: Option<LastNews>,
    #[serde(default)]
    pub hot: hot::HotState,
}

impl Default for State {
    fn default() -> Self {
        State {
            version: STATE_VERSION,
            seen: Seen::new(),
            reported: Reported::new(),
            evaluated: None,
            last_news: None,
            hot: hot::HotState::default(),
        }
    }
}

/// How quiet the poll has been and what it costs: what STATE-DIR/status.json
/// holds, and --summary shows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Status {
    pub updated_at: String,
    /// When the poll last printed a NEWS line, waking the coordinator.
    pub last_wake: Option<String>,
    pub quiet_secs: Option<i64>,
    /// The hot set's items per class.
    pub hot: BTreeMap<String, usize>,
    /// Of those, the ones polled on every hot cycle.
    pub direct: usize,
    /// When the last full sweep started.
    pub last_sweep: Option<String>,
    /// The last hot cycle's requests.
    pub last_cycle: Option<hot::CycleStat>,
    pub last_hour: HourStats,
}

/// bot-poll's own requests in the last hour (not its sweeps' tools').
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct HourStats {
    pub hot_cycles: u32,
    pub rebuilds: u32,
    pub requests: u32,
    pub not_modified: u32,
}

/// The status of a state at `now` (ms).
pub fn status(state: &State, now: i64) -> Status {
    let wake = state.last_news.as_ref().map(|n| n.at.clone());
    let quiet_secs = wake
        .as_deref()
        .and_then(hot::parse_time)
        .map(|at| (now - at) / 1000);
    let mut last_hour = HourStats::default();
    for s in state
        .hot
        .stats
        .iter()
        .filter(|s| now - s.at < hot::STATS_KEEP_MS)
    {
        if s.sweep {
            last_hour.rebuilds += 1;
        } else {
            last_hour.hot_cycles += 1;
        }
        last_hour.requests += s.requests;
        last_hour.not_modified += s.not_modified;
    }
    Status {
        updated_at: hot::rfc3339(now),
        last_wake: wake,
        quiet_secs,
        hot: state
            .hot
            .sizes()
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect(),
        direct: state.hot.direct(now).len(),
        last_sweep: state.hot.sweep_start.map(hot::rfc3339),
        last_cycle: state.hot.stats.iter().rev().find(|s| !s.sweep).copied(),
        last_hour,
    }
}

/// A duration in seconds, roughly: 45s, 12m, 3h05m.
fn human_secs(secs: i64) -> String {
    match secs.max(0) {
        s if s < 60 => format!("{s}s"),
        s if s < 3600 => format!("{}m", s / 60),
        s => format!("{}h{:02}m", s / 3600, s % 3600 / 60),
    }
}

/// The status, for --summary.
pub fn render_status(st: &Status) -> String {
    let quiet = match (&st.last_wake, st.quiet_secs) {
        (Some(at), Some(s)) => format!("{} since the last wake ({at})", human_secs(s)),
        _ => "no wake yet".to_string(),
    };
    let total: usize = st.hot.values().sum();
    let classes: Vec<String> = st.hot.iter().map(|(k, v)| format!("{v} {k}")).collect();
    let cycle = st.last_cycle.map_or("no hot cycle yet".to_string(), |c| {
        format!(
            "last hot cycle {} requests, {} not modified",
            c.requests, c.not_modified
        )
    });
    let h = &st.last_hour;
    format!(
        "Quiet: {quiet}.\n\
         Hot set: {total} items ({}), {} polled directly.\n\
         Requests (bot-poll's own, not its sweeps' tools): {cycle}; \
         last hour {} in {} hot cycles and {} hot set rebuilds, {} not modified.\n",
        classes.join(", "),
        st.direct,
        h.requests,
        h.hot_cycles,
        h.rebuilds,
        h.not_modified,
    )
}

/// The NEWS line.
pub fn news_line(news: &[KindNews], hhmm: &str, run_dir: &str) -> String {
    let kinds: Vec<&str> = news.iter().map(|k| k.kind.as_str()).collect();
    format!("NEWS ({}) at {hhmm}: {run_dir}/*.txt", kinds.join(", "))
}

/// The title of KIND in the summary, for OPERATOR.
pub fn kind_title(kind: &str, operator: &Operator) -> String {
    KINDS
        .iter()
        .find(|(k, _)| *k == kind)
        .map_or(kind.to_string(), |(_, t)| {
            t.replace("OPERATOR'S", &operator.possessive())
                .replace("OPERATOR", &operator.login)
        })
}

/// The --summary: the NEWS line, then the new items grouped by kind,
/// each with its URL unless its text has it.
pub fn render_summary(last: Option<&LastNews>, operator: &Operator) -> String {
    let Some(last) = last else {
        return "No news reported yet.\n".to_string();
    };
    let mut out = format!("{}\n", last.line);
    for k in &last.items {
        let title = kind_title(&k.kind, operator);
        out.push_str(&format!("\n{title} ({}):\n", k.kind));
        for it in &k.items {
            out.push_str(&format!("  {}\n", it.text));
            if !it.url.is_empty() && !it.text.contains(&it.url) {
                out.push_str(&format!("    {}\n", it.url));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(set: &str, source: Source) -> String {
        let path = format!(
            "{}/tests/fixtures/{set}/{}.txt",
            env!("CARGO_MANIFEST_DIR"),
            source.name()
        );
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
    }
    fn keys(items: &[Item]) -> Vec<&str> {
        items.iter().map(|i| i.key.as_str()).collect()
    }
    fn outputs(set: &str) -> BTreeMap<Source, Output> {
        Source::ALL
            .iter()
            .map(|&s| {
                (
                    s,
                    Output {
                        text: fixture(set, s),
                        status: Some(0),
                    },
                )
            })
            .collect()
    }
    fn kinds(news: &[KindNews]) -> Vec<&str> {
        news.iter().map(|k| k.kind.as_str()).collect()
    }
    /// The seen-sets and the reported events.
    type Memory = (Seen, Reported);
    fn eval(o: &BTreeMap<Source, Output>, m: &Memory, now: i64) -> (Vec<KindNews>, Memory) {
        let (news, seen, reported) = evaluate(o, &m.0, &m.1, now);
        (news, (seen, reported))
    }
    const BASE_KINDS: [&str; 6] = [
        "health-P0",
        "review",
        "approval",
        "forge-review",
        "rebase",
        "health",
    ];
    const NEWS_KINDS: [&str; 8] = [
        "health-P0",
        "approval",
        "signoff",
        "promotion",
        "text",
        "notify",
        "forge-review",
        "news",
    ];

    #[test]
    fn watch_sections() {
        let w = parse_watch(&fixture("news", Source::Watch));
        assert_eq!(
            keys(&w["health"]),
            [
                "P0 ci-failing https://github.com/bootc-dev/bootc/pull/2437 781bbcac8255",
                "P0 dco https://github.com/bootc-dev/bootc/pull/2516 4e10ca5cee5e",
                "P1 ci-failing https://github.com/coreos/rpm-ostree/pull/5637 498e91eb18ea",
            ]
        );
        assert_eq!(
            w["health"].iter().map(|i| i.p0).collect::<Vec<_>>(),
            [true, true, false]
        );
        assert_eq!(
            keys(&w["signoff"]),
            ["Signed off: https://github.com/bootc-dev/bootc/pull/2516 (5e20ab31c0d2)"]
        );
        assert_eq!(
            w["signoff"][0].url,
            "https://github.com/bootc-dev/bootc/pull/2516"
        );
        assert_eq!(
            w["signoff"][0].event().as_deref(),
            Some("signoff Signed off: https://github.com/bootc-dev/bootc/pull/2516 (5e20ab31c0d2)")
        );
        assert_eq!(
            w["promotion"][0].url,
            "https://github.com/cgwalters-forge/composefs-rs/pull/6"
        );
        assert_eq!(
            w["promotion"][0].event().as_deref(),
            Some(
                "promotion Promoted: https://github.com/cgwalters-forge/composefs-rs/pull/6 -> https://github.com/composefs/composefs-rs/pull/310"
            )
        );
        assert_eq!(
            keys(&w["text"]),
            [
                "Needs your text: https://github.com/cgwalters-forge/podman/pull/3 (containers/podman is human-text): retitle it, edit its body, reword and push the commits yourself, then comment '/promote --human-text'"
            ]
        );
        assert_eq!(
            keys(&w["review"]),
            [
                "bootc-dev/bootc#2500 https://github.com/bootc-dev/bootc/pull/2500#pullrequestreview-5365982119"
            ]
        );
        assert_eq!(keys(&w["rebase"]), ["bootc-dev/bootc#2515"]);
        assert_eq!(
            w["rebase"][0].url,
            "https://github.com/bootc-dev/bootc/pull/2515"
        );
        assert!(
            w["rebase"][0]
                .text
                .starts_with("bootc-dev/bootc#2515 (conflict-free): CI failing")
        );
        // Only Johan's review: not renovate's push, nor the action line.
        assert_eq!(w["news"].len(), 1, "{:?}", w["news"]);
        assert_eq!(
            w["news"][0].url,
            "https://github.com/bootc-dev/bootc/pull/2448#pullrequestreview-5362732351"
        );
        assert_eq!(
            w["news"][0].text,
            "UKI Addons Support: bootc-dev/bootc#2448 review COMMENTED by @Johan-Liebert1: fixed"
        );
        assert!(
            parse_watch(&fixture("base", Source::Watch))["news"].is_empty(),
            "renovate's force-push is no news"
        );
    }

    #[test]
    fn inbox_approvals_and_activity() {
        let i = parse_inbox(&fixture("news", Source::Inbox));
        assert_eq!(
            keys(&i["approval"]),
            [
                "https://github.com/cgwalters-forge/bootc/pull/23 [APPROVED] https://github.com/cgwalters-forge/bootc/pull/23#pullrequestreview-5356903990",
                "https://github.com/cgwalters-forge/bootc/pull/24 [APPROVED] https://github.com/cgwalters-forge/bootc/pull/24#pullrequestreview-5354700998",
            ]
        );
        assert_eq!(
            i["approval"][1].event().as_deref(),
            Some("pullrequestreview-5354700998")
        );
        let a = &i["forge-review"];
        assert_eq!(a.len(), 4);
        assert_eq!(
            a[3].url,
            "https://github.com/cgwalters-forge/bootc/pull/24#pullrequestreview-5354700998"
        );
        assert_eq!(
            a[3].key,
            "https://github.com/cgwalters-forge/bootc/pull/24 2026-09-30T14:20:59Z review APPROVED: https://github.com/cgwalters-forge/bootc/pull/24#pullrequestreview-5354700998"
        );
    }

    #[test]
    fn notify_records() {
        assert!(parse_notify(&fixture("base", Source::Notify))["notify"].is_empty());
        let n = &parse_notify(&fixture("news", Source::Notify))["notify"];
        assert_eq!(
            keys(n),
            [
                "answer https://github.com/cgwalters-forge/tracker/issues/151#issuecomment-1 25909312948"
            ]
        );
        assert_eq!(
            n[0].text,
            "answer from @cgwalters: bootc#2499 (.vmlinuz.hmac): sign off again [thread 25909312948]"
        );
    }

    #[test]
    fn evaluate_seen_sets() {
        let t0 = 1_000_000_000;
        let (first, seen) = eval(&outputs("base"), &Memory::default(), t0);
        assert_eq!(kinds(&first), BASE_KINDS);
        let (second, seen) = eval(&outputs("news"), &seen, t0 + 1000);
        assert_eq!(kinds(&second), NEWS_KINDS);
        assert_eq!(
            second[0].items[0].url,
            "https://github.com/bootc-dev/bootc/pull/2437"
        );
        // Back to base: the news items are gone but remembered a while.
        let (back, back_seen) = eval(&outputs("base"), &seen, t0 + 2000);
        assert!(back.is_empty(), "{back:?}");
        assert!(eval(&outputs("news"), &back_seen, t0 + 3000).0.is_empty());
        // Gone for longer: forgotten, and news when they come back, but
        // for the reviews, comments and sign-offs, whose events are
        // remembered longer.
        let (none, forgot) = eval(&outputs("base"), &back_seen, t0 + 1000 + FORGET_MS);
        assert!(none.is_empty());
        assert_eq!(
            kinds(&eval(&outputs("news"), &forgot, t0 + 2000 + FORGET_MS).0),
            ["health-P0"]
        );
        let (_, long_gone) = eval(&outputs("base"), &forgot, t0 + 1000 + REPORTED_KEEP_MS);
        assert_eq!(
            kinds(&eval(&outputs("news"), &long_gone, t0 + 2000 + REPORTED_KEEP_MS).0),
            NEWS_KINDS
        );
        // bot-watch cut short, bot-pr inbox failed: their sets are kept.
        let mut broken = outputs("base");
        broken.insert(
            Source::Watch,
            Output {
                text: "error: rate limited\n".into(),
                status: Some(75),
            },
        );
        broken.insert(
            Source::Inbox,
            Output {
                text: String::new(),
                status: Some(1),
            },
        );
        let (none, kept) = eval(&broken, &seen, t0 + 10 * FORGET_MS);
        assert!(none.is_empty());
        for set in [
            "health",
            "review",
            "rebase",
            "signoff",
            "promotion",
            "text",
            "news",
            "approval",
            "forge-review",
        ] {
            assert_eq!(kept.0[set], seen.0[set], "{set}");
        }
        // A step that didn't run at all counts the same.
        broken.remove(&Source::Watch);
        assert_eq!(
            eval(&broken, &seen, t0 + 10 * FORGET_MS).1.0["health"],
            seen.0["health"]
        );
    }

    #[test]
    fn a_restart_after_a_long_outage_is_no_news() {
        // The machine was down for days: what the first sweep after lists
        // was there before, so its keys were never dropped.
        let (_, seen) = eval(&outputs("news"), &Memory::default(), 0);
        let (news, _) = eval(&outputs("news"), &seen, 3 * REPORTED_KEEP_MS);
        assert!(news.is_empty(), "{news:?}");
    }

    fn inbox_approved(review: &str) -> BTreeMap<Source, Output> {
        BTreeMap::from([(
            Source::Inbox,
            Output {
                text: format!(
                    "https://github.com/o/r/pull/1  [APPROVED]  Fix\n  2026-09-30T10:00:00Z review APPROVED: https://github.com/o/r/pull/1#pullrequestreview-{review}\n"
                ),
                status: Some(0),
            },
        )])
    }

    #[test]
    fn reapproval_is_news() {
        let (news, seen) = eval(&inbox_approved("1"), &Memory::default(), 0);
        assert_eq!(kinds(&news), ["approval", "forge-review"]);
        let (news, _) = eval(&inbox_approved("2"), &seen, 1);
        assert_eq!(kinds(&news), ["approval", "forge-review"]);
    }

    #[test]
    fn a_reported_event_is_not_news_again() {
        // Reported by a hot cycle: the sweep's listing of it is no news.
        let reported = Reported::from([("pullrequestreview-7".to_string(), 0)]);
        let (news, (_, reported)) = eval(&inbox_approved("7"), &(Seen::new(), reported), 1);
        assert!(news.is_empty(), "{news:?}");
        assert_eq!(reported["pullrequestreview-7"], 1, "still listed");
        for (url, want) in [
            (
                "https://github.com/o/r/pull/1#pullrequestreview-7",
                Some("pullrequestreview-7"),
            ),
            (
                "https://github.com/o/r/issues/1#issuecomment-8",
                Some("issuecomment-8"),
            ),
            (
                "https://github.com/o/r/pull/1#discussion_r9",
                Some("discussion_r9"),
            ),
            ("https://github.com/o/r/pull/1#issuecomment-", None),
            ("https://github.com/o/r/pull/1#issue-9", None),
            ("https://github.com/o/r/pull/1", None),
        ] {
            assert_eq!(event_id(url).as_deref(), want, "{url}");
        }
    }

    #[test]
    fn failed_watch_sections_keep_their_sets() {
        let (_, seen) = eval(&outputs("news"), &Memory::default(), 0);
        let mut o = outputs("base");
        let watch = o.get_mut(&Source::Watch).unwrap();
        watch.text = watch.text.replace(
            "Swept ",
            "warning: the priority health sweep failed (status 1); its section is incomplete\n\
             warning: checking the bot's open PRs off the board failed (status 1); only the board's PRs were checked for outstanding reviews\nSwept ",
        );
        let (news, next) = eval(&o, &seen, FORGET_MS * 10);
        assert!(news.is_empty(), "{news:?}");
        for set in ["health", "review", "rebase"] {
            assert_eq!(next.0[set], seen.0[set], "{set}");
        }
        assert!(next.0["news"].is_empty(), "the whole sections are updated");
    }

    #[test]
    fn warnings_and_bots() {
        let w = parse_watch(
            "Priority health:\n  P0 dco https://github.com/o/r/pull/1 abc: DCO\nbot-watch: warning: slow\n  P1 stale https://github.com/o/r/pull/2 def: old\n\n\
             T  [Todo]  ID1\n  o/r#3\n    comment by @dependabot[bot]: bump\n    comment by @alice: see @renovate[bot]'s PR\n      https://github.com/o/r/issues/3#issuecomment-1\n",
        );
        assert_eq!(w["health"].len(), 2);
        assert_eq!(
            keys(&w["news"]),
            [
                "ID1 o/r#3 comment by @alice: see @renovate[bot]'s PR https://github.com/o/r/issues/3#issuecomment-1"
            ]
        );
    }

    #[test]
    fn summary() {
        let op = operator::parse("{}").unwrap().operator;
        assert_eq!(render_summary(None, &op), "No news reported yet.\n");
        assert_eq!(
            kind_title("review", &op),
            "Outstanding reviews by cgwalters"
        );
        assert_eq!(
            kind_title("forge-review", &op),
            "cgwalters' activity on fork PRs"
        );
        let other = operator::parse(r#"{"operator": {"login": "jmarrero"}}"#)
            .unwrap()
            .operator;
        for (kind, _) in KINDS {
            assert!(!kind_title(kind, &other).contains("cgwalters"), "{kind}");
        }
        assert_eq!(
            kind_title("notify", &other),
            "Requests and answers from jmarrero"
        );
        assert_eq!(
            kind_title("forge-review", &other),
            "jmarrero's activity on fork PRs"
        );
        let (news, _) = eval(&outputs("news"), &Memory::default(), 0);
        let line = news_line(&news, "1415", "/s/runs/x");
        assert!(line.starts_with("NEWS (health-P0, review, approval, signoff, promotion, text, notify, forge-review, rebase, health, news) at 1415: /s/runs/x/*.txt"));
    }
}
