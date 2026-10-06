//! The operator config: who runs this bot harness and where its work
//! lives. The Rust twin of homegit's `lib/operator.js`, which documents
//! the file; `tests/fixtures/operator/cases.json` holds cases both
//! loaders must agree on.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

/// The environment variable naming the config file.
pub const ENV_PATH: &str = "BOT_OPERATOR_CONFIG";
const CONFIG_DIR: &str = "bot-harness";
const CONFIG_FILE: &str = "operator.json";

const DEFAULT_OPERATOR_LOGIN: &str = "cgwalters";
const DEFAULT_OPERATOR_NAME: &str = "Colin Walters";
const DEFAULT_OPERATOR_EMAIL: &str = "walters@verbum.org";
const DEFAULT_BOT_LOGIN: &str = "cgwalters-bot";
const DEFAULT_FORGE_ORG: &str = "cgwalters-forge";
const DEFAULT_DEVSPACE_REPO: &str = "bootc-dev/cgwalters-devspace-sandbox";
const DEFAULT_TRACKER: &str = "cgwalters-forge/tracker";
const DEFAULT_HEARTBEAT_ISSUE: u64 = 176;
const DEFAULT_BOARD_OWNER_TYPE: &str = "orgs";
const DEFAULT_BOARD_NUMBER: u64 = 1;
const DEFAULT_EPICS: [(&str, &str); 1] = [("composefs-stable", "users/cgwalters-bot/2")];
const BOT_EMAIL_TAG: &str = "llm";
const OWNER_TYPES: [&str; 2] = ["orgs", "users"];
const WORKSTREAM: &str = "workstream";
const MAX_NUMBER: u64 = 1_000_000_000;
const DEFAULT_AGENTS: u64 = 4;
const MAX_AGENTS: u64 = 64;
/// The share of the agents that are devspace runs, as JSON text, so that
/// it prints as in homegit's lib/operator.js.
const DEFAULT_OPENCODE_SHARE: &str = "0.25";
/// How many devspace runs may be going at once, whatever the share says.
const DEFAULT_OPENCODE_RUNS: u64 = 2;
/// The inference pools paced on their own (see homegit's lib/pools.js),
/// and each one's default target and burst, as JSON text like the share.
const POOLS: [&str; 2] = ["claude", "openai"];
const DEFAULT_POOL_TARGET: &str = "0.95";
const DEFAULT_POOL_BURST: &str = "3";
const MAX_BURST: f64 = 100.0;
const DEFAULT_BUDGETS: [(&str, &str); 3] = [("P0", "M"), ("P1", "S"), ("P2", "S")];
const BUCKETS: [&str; 5] = ["XS", "S", "M", "L", "XL"];

/// The config file as written: every key optional.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct Raw {
    #[serde(default)]
    operator: RawOperator,
    #[serde(default)]
    bot: RawBot,
    forge_org: Option<String>,
    tracker_repo: Option<String>,
    heartbeat_issue: Option<u64>,
    #[serde(default)]
    board: RawBoard,
    generated_by_url: Option<String>,
    #[serde(default)]
    devspace: RawDevspace,
    #[serde(default)]
    pacing: RawPacing,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawOperator {
    login: Option<String>,
    name: Option<String>,
    email: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawBot {
    login: Option<String>,
    git_name: Option<String>,
    git_email: Option<String>,
    issue_repo: Option<String>,
    homegit_repo: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawBoard {
    owner_type: Option<String>,
    owner: Option<String>,
    number: Option<u64>,
    state_items: Option<BTreeMap<String, StateItem>>,
    epics: Option<BTreeMap<String, String>>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawDevspace {
    repo: Option<String>,
    host_prefix: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawPacing {
    agents: Option<u64>,
    harness_agents: Option<u64>,
    budgets: Option<BTreeMap<String, String>>,
    opencode_share: Option<serde_json::Number>,
    opencode_runs: Option<u64>,
    pools: Option<BTreeMap<String, RawPool>>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawPool {
    target: Option<serde_json::Number>,
    burst: Option<serde_json::Number>,
}

/// The resolved config, defaults filled in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Config {
    pub operator: Operator,
    pub bot: Bot,
    pub forge_org: String,
    pub tracker_repo: String,
    /// None: the tracker has no heartbeat issue yet.
    pub heartbeat_issue: Option<u64>,
    pub board: Board,
    pub generated_by_url: String,
    pub devspace: Devspace,
    pub pacing: Pacing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Operator {
    pub login: String,
    pub name: String,
    pub email: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Bot {
    pub login: String,
    pub git_name: String,
    pub git_email: String,
    pub issue_repo: String,
    pub homegit_repo: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Board {
    pub owner_type: String,
    pub owner: String,
    pub number: u64,
    pub state_items: BTreeMap<String, StateItem>,
    pub epics: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StateItem {
    pub item: String,
    pub draft: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Devspace {
    pub repo: String,
    pub host_prefix: String,
}

/// How many work agents the coordinator keeps busy, how many of them on
/// the harness, and the Est. cost bucket an unestimated item is budgeted
/// at, by priority (see homegit's bin/bot-pace).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Pacing {
    pub agents: u64,
    pub harness_agents: u64,
    pub budgets: BTreeMap<String, String>,
    /// The share of the agents that are devspace runs (0 to 1).
    pub opencode_share: serde_json::Number,
    /// How many devspace runs may be going at once.
    pub opencode_runs: u64,
    /// The pace of each inference pool, by name.
    pub pools: BTreeMap<String, Pool>,
}

/// An inference pool's pace: the share of its window to have used by the
/// reset (0 to 1; the rest is the operator's reserve), and the percent
/// points of slack that let work start right after a reset.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Pool {
    pub target: serde_json::Number,
    pub burst: serde_json::Number,
}

impl Operator {
    /// "cgwalters'" or "jmarrero's", for messages.
    pub fn possessive(&self) -> String {
        if self.login.ends_with('s') {
            format!("{}'", self.login)
        } else {
            format!("{}'s", self.login)
        }
    }
}

fn is_login(s: &str) -> bool {
    let b = s.as_bytes();
    (1..=39).contains(&b.len())
        && b[0].is_ascii_alphanumeric()
        && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'-')
}

fn is_repo_name(s: &str) -> bool {
    (1..=100).contains(&s.len())
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
}

fn is_repo(s: &str) -> bool {
    s.split_once('/')
        .is_some_and(|(o, r)| is_login(o) && is_repo_name(r))
}

/// A name starts and ends with a non-space.
fn is_name(s: &str) -> bool {
    (1..=100).contains(&s.encode_utf16().count())
        && s.trim() == s
        && !s
            .chars()
            .any(|c| (c as u32) < 0x20 || matches!(c, '\x7f' | '<' | '>' | '\u{2028}' | '\u{2029}'))
}

fn is_email(s: &str) -> bool {
    s.split_once('@').is_some_and(|(local, domain)| {
        (1..=64).contains(&local.len())
            && local
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._%+-".contains(&c))
            && (1..=253).contains(&domain.len())
            && domain
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b".-".contains(&c))
    })
}

fn is_url(s: &str) -> bool {
    s.strip_prefix("https://").is_some_and(|rest| {
        (1..=500).contains(&rest.len())
            && rest
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._~:/?#@!&*+,;=%-".contains(&c))
    })
}

/// A lowercase name: host prefixes and state item and epic board names.
fn is_short_name(s: &str) -> bool {
    let b = s.as_bytes();
    (1..=41).contains(&b.len())
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

fn is_node_id(s: &str, prefix: &str) -> bool {
    s.strip_prefix(prefix).is_some_and(|rest| {
        (1..=100).contains(&rest.len())
            && rest
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    })
}

fn is_board_path(s: &str) -> bool {
    let parts: Vec<&str> = s.split('/').collect();
    matches!(parts.as_slice(), [kind, owner, number]
        if OWNER_TYPES.contains(kind) && is_login(owner)
            && (1..=6).contains(&number.len()) && !number.starts_with('0')
            && number.bytes().all(|c| c.is_ascii_digit()))
}

fn check(ok: bool, key: &str, value: &str) -> Result<()> {
    if !ok {
        bail!("{key} is invalid: {value:?}");
    }
    Ok(())
}

fn check_opt(v: &Option<String>, key: &str, f: fn(&str) -> bool) -> Result<()> {
    v.as_deref().map_or(Ok(()), |s| check(f(s), key, s))
}

fn check_number(v: Option<u64>, key: &str) -> Result<()> {
    match v {
        Some(n) if !(1..=MAX_NUMBER).contains(&n) => {
            bail!("{key} must be a positive integer, not {n}")
        }
        _ => Ok(()),
    }
}

fn is_priority(s: &str) -> bool {
    matches!(s.as_bytes(), [b'P', d] if d.is_ascii_digit())
}

fn check_agents(v: Option<u64>, key: &str, min: u64) -> Result<()> {
    match v {
        Some(n) if !(min..=MAX_AGENTS).contains(&n) => {
            bail!("{key} must be an integer from {min} to {MAX_AGENTS}, not {n}")
        }
        _ => Ok(()),
    }
}

fn validate(raw: &Raw) -> Result<()> {
    check_opt(&raw.operator.login, "operator.login", is_login)?;
    check_opt(&raw.operator.name, "operator.name", is_name)?;
    check_opt(&raw.operator.email, "operator.email", is_email)?;
    check_opt(&raw.bot.login, "bot.login", is_login)?;
    check_opt(&raw.bot.git_name, "bot.git_name", is_name)?;
    check_opt(&raw.bot.git_email, "bot.git_email", is_email)?;
    check_opt(&raw.bot.issue_repo, "bot.issue_repo", is_repo)?;
    check_opt(&raw.bot.homegit_repo, "bot.homegit_repo", is_repo)?;
    check_opt(&raw.forge_org, "forge_org", is_login)?;
    check_opt(&raw.tracker_repo, "tracker_repo", is_repo)?;
    check_number(raw.heartbeat_issue, "heartbeat_issue")?;
    check_opt(&raw.board.owner_type, "board.owner_type", |s| {
        OWNER_TYPES.contains(&s)
    })?;
    check_opt(&raw.board.owner, "board.owner", is_login)?;
    check_number(raw.board.number, "board.number")?;
    for (name, ids) in raw.board.state_items.iter().flatten() {
        check(is_short_name(name), "board.state_items name", name)?;
        check(
            is_node_id(&ids.item, "PVTI_") && is_node_id(&ids.draft, "DI_"),
            &format!("board.state_items.{name}"),
            &format!("{ids:?}"),
        )?;
    }
    for (name, board) in raw.board.epics.iter().flatten() {
        check(
            is_short_name(name) && name != WORKSTREAM,
            "board.epics name",
            name,
        )?;
        check(is_board_path(board), &format!("board.epics.{name}"), board)?;
    }
    check_opt(&raw.generated_by_url, "generated_by_url", is_url)?;
    check_opt(&raw.devspace.repo, "devspace.repo", is_repo)?;
    check_opt(
        &raw.devspace.host_prefix,
        "devspace.host_prefix",
        is_short_name,
    )?;
    check_agents(raw.pacing.agents, "pacing.agents", 1)?;
    check_agents(raw.pacing.harness_agents, "pacing.harness_agents", 0)?;
    for (prio, bucket) in raw.pacing.budgets.iter().flatten() {
        check(is_priority(prio), "pacing.budgets priority", prio)?;
        check(
            BUCKETS.contains(&bucket.as_str()),
            &format!("pacing.budgets.{prio}"),
            bucket,
        )?;
    }
    if let Some(share) = &raw.pacing.opencode_share {
        check(
            share.as_f64().is_some_and(|s| (0.0..=1.0).contains(&s)),
            "pacing.opencode_share",
            &share.to_string(),
        )?;
    }
    check_agents(raw.pacing.opencode_runs, "pacing.opencode_runs", 0)?;
    for (name, pool) in raw.pacing.pools.iter().flatten() {
        check(POOLS.contains(&name.as_str()), "pacing.pools name", name)?;
        if let Some(target) = &pool.target {
            check(
                target.as_f64().is_some_and(|t| t > 0.0 && t <= 1.0),
                &format!("pacing.pools.{name}.target"),
                &target.to_string(),
            )?;
        }
        if let Some(burst) = &pool.burst {
            check(
                burst
                    .as_f64()
                    .is_some_and(|b| (0.0..=MAX_BURST).contains(&b)),
                &format!("pacing.pools.{name}.burst"),
                &burst.to_string(),
            )?;
        }
    }
    Ok(())
}

/// The operator's email with a +llm tag, which marks the bot's commits.
fn bot_email(email: &str) -> String {
    let (local, domain) = email.rsplit_once('@').unwrap_or((email, ""));
    format!("{local}+{BOT_EMAIL_TAG}@{domain}")
}

fn resolve(raw: Raw) -> Result<Config> {
    validate(&raw)?;
    let or = |v: Option<String>, d: &str| v.unwrap_or_else(|| d.to_string());
    let operator = Operator {
        login: or(raw.operator.login, DEFAULT_OPERATOR_LOGIN),
        name: or(raw.operator.name, DEFAULT_OPERATOR_NAME),
        email: or(raw.operator.email, DEFAULT_OPERATOR_EMAIL),
    };
    let bot_login = or(raw.bot.login, DEFAULT_BOT_LOGIN);
    let bot = Bot {
        git_name: raw.bot.git_name.unwrap_or_else(|| operator.name.clone()),
        git_email: raw
            .bot
            .git_email
            .unwrap_or_else(|| bot_email(&operator.email)),
        issue_repo: raw
            .bot
            .issue_repo
            .unwrap_or_else(|| format!("{bot_login}/{bot_login}")),
        homegit_repo: raw
            .bot
            .homegit_repo
            .unwrap_or_else(|| format!("{bot_login}/homegit")),
        login: bot_login,
    };
    let forge_org = or(raw.forge_org, DEFAULT_FORGE_ORG);
    let tracker_repo = raw
        .tracker_repo
        .unwrap_or_else(|| format!("{forge_org}/tracker"));
    let heartbeat_issue = raw
        .heartbeat_issue
        .or((tracker_repo == DEFAULT_TRACKER).then_some(DEFAULT_HEARTBEAT_ISSUE));
    let owner_type = or(raw.board.owner_type, DEFAULT_BOARD_OWNER_TYPE);
    let owner = raw.board.owner.unwrap_or_else(|| forge_org.clone());
    let number = raw.board.number.unwrap_or(DEFAULT_BOARD_NUMBER);
    let is_default = owner_type == DEFAULT_BOARD_OWNER_TYPE
        && owner == DEFAULT_FORGE_ORG
        && number == DEFAULT_BOARD_NUMBER;
    let state_items = raw.board.state_items.unwrap_or_default();
    let epics = raw.board.epics.unwrap_or_else(|| {
        DEFAULT_EPICS
            .iter()
            .filter(|_| is_default)
            .map(|(n, b)| (n.to_string(), b.to_string()))
            .collect()
    });
    let devspace_repo = or(raw.devspace.repo, DEFAULT_DEVSPACE_REPO);
    let host_prefix = match raw.devspace.host_prefix {
        Some(p) => p,
        None => {
            let name = devspace_repo.split_once('/').map_or("", |(_, r)| r);
            let p = format!("{}-", name.strip_suffix("-sandbox").unwrap_or(name)).to_lowercase();
            check(
                is_short_name(&p),
                "devspace.host_prefix (derived from devspace.repo; set it)",
                &p,
            )?;
            p
        }
    };
    let agents = raw.pacing.agents.unwrap_or(DEFAULT_AGENTS);
    let harness_agents = raw.pacing.harness_agents.unwrap_or(agents / 2);
    if harness_agents > agents {
        bail!("pacing.harness_agents ({harness_agents}) must not exceed pacing.agents ({agents})");
    }
    let mut budgets: BTreeMap<String, String> = DEFAULT_BUDGETS
        .iter()
        .map(|(p, b)| (p.to_string(), b.to_string()))
        .collect();
    budgets.extend(raw.pacing.budgets.unwrap_or_default());
    let opencode_share = match raw.pacing.opencode_share {
        Some(share) => share,
        None => DEFAULT_OPENCODE_SHARE.parse()?,
    };
    let mut raw_pools = raw.pacing.pools.unwrap_or_default();
    let mut pools = BTreeMap::new();
    for name in POOLS {
        let pool = raw_pools.remove(name).unwrap_or_default();
        let or_default = |v: Option<serde_json::Number>, default: &str| match v {
            Some(n) => Ok(n),
            None => default.parse(),
        };
        pools.insert(
            name.to_string(),
            Pool {
                target: or_default(pool.target, DEFAULT_POOL_TARGET)?,
                burst: or_default(pool.burst, DEFAULT_POOL_BURST)?,
            },
        );
    }
    // The trust split: the bot must never pass for the operator.
    if operator.login.eq_ignore_ascii_case(&bot.login) {
        bail!("bot.login must differ from operator.login");
    }
    if operator.email.eq_ignore_ascii_case(&bot.git_email) {
        bail!("bot.git_email must differ from operator.email");
    }
    Ok(Config {
        generated_by_url: raw
            .generated_by_url
            .unwrap_or_else(|| format!("https://github.com/{}/#llms", operator.login)),
        operator,
        bot,
        forge_org,
        tracker_repo,
        heartbeat_issue,
        board: Board {
            owner_type,
            owner,
            number,
            state_items,
            epics,
        },
        devspace: Devspace {
            repo: devspace_repo,
            host_prefix,
        },
        pacing: Pacing {
            agents,
            harness_agents,
            budgets,
            opencode_share,
            opencode_runs: raw.pacing.opencode_runs.unwrap_or(DEFAULT_OPENCODE_RUNS),
            pools,
        },
    })
}

/// Resolves a config file's contents.
pub fn parse(text: &str) -> Result<Config> {
    let value: serde_json::Value = serde_json::from_str(text)?;
    reject_nulls(&value, "")?;
    resolve(serde_json::from_value(value)?)
}

/// serde would take a null as an absent key; lib/operator.js rejects it.
fn reject_nulls(v: &serde_json::Value, key: &str) -> Result<()> {
    match v {
        serde_json::Value::Null => bail!("{key} must not be null"),
        serde_json::Value::Object(m) => m.iter().try_for_each(|(k, v)| {
            let key = if key.is_empty() {
                k.clone()
            } else {
                format!("{key}.{k}")
            };
            reject_nulls(v, &key)
        }),
        _ => Ok(()),
    }
}

/// The config file this environment reads, and whether it was named
/// explicitly (then it must exist).
pub fn config_path(env: impl Fn(&str) -> Option<String>) -> (PathBuf, bool) {
    let set = |k: &str| env(k).filter(|v| !v.is_empty());
    if let Some(p) = set(ENV_PATH) {
        return (PathBuf::from(p), true);
    }
    let base = set("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(&set("HOME").unwrap_or_default()).join(".config"));
    (base.join(CONFIG_DIR).join(CONFIG_FILE), false)
}

/// The operator config of this process's environment: the defaults when
/// there is no file, unless $BOT_OPERATOR_CONFIG names it.
pub fn load() -> Result<Config> {
    let (path, explicit) = config_path(|k| std::env::var(k).ok());
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && !explicit => {
            return resolve(Raw::default());
        }
        Err(e) => {
            return Err(e)
                .with_context(|| format!("cannot read the operator config {}", path.display()));
        }
    };
    parse(&text).with_context(|| format!("the operator config {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The cases lib/operator.js is tested against too.
    #[test]
    fn shared_cases() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/fixtures/operator/cases.json"
        );
        let cases: Vec<serde_json::Value> =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let got = parse(&case["config"].to_string());
            match case.get("expect") {
                Some(expect) => {
                    let got = got.unwrap_or_else(|e| panic!("{name}: {e:#}"));
                    assert_eq!(&serde_json::to_value(&got).unwrap(), expect, "{name}");
                }
                None => assert!(got.is_err(), "{name}: accepted {got:?}"),
            }
        }
    }

    #[test]
    fn possessive() {
        for (login, want) in [("cgwalters", "cgwalters'"), ("jmarrero", "jmarrero's")] {
            let op = Operator {
                login: login.into(),
                name: "N".into(),
                email: "e@x".into(),
            };
            assert_eq!(op.possessive(), want);
        }
    }

    #[test]
    fn paths() {
        type Vars = &'static [(&'static str, &'static str)];
        let env = |vars: Vars| {
            move |k: &str| {
                vars.iter()
                    .find(|(n, _)| *n == k)
                    .map(|(_, v)| v.to_string())
            }
        };
        let cases: [(Vars, &str, bool); 4] = [
            (
                &[("HOME", "/h")],
                "/h/.config/bot-harness/operator.json",
                false,
            ),
            (
                &[("HOME", "/h"), ("XDG_CONFIG_HOME", "/x")],
                "/x/bot-harness/operator.json",
                false,
            ),
            (
                &[("HOME", "/h"), ("XDG_CONFIG_HOME", "")],
                "/h/.config/bot-harness/operator.json",
                false,
            ),
            (&[("HOME", "/h"), (ENV_PATH, "/c.json")], "/c.json", true),
        ];
        for (vars, want, explicit) in cases {
            assert_eq!(config_path(env(vars)), (PathBuf::from(want), explicit));
        }
    }
}
