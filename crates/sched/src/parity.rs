//! While a rule exists twice, here and in `lib/reconcile.js`, the two
//! must agree: this runs bot-reconcile on a snapshot and compares what
//! each action says and what would carry it out. It goes with the last
//! JavaScript rule.
//!
//! Both sides are given the snapshot, so this compares the rules, not
//! the observing: what `observe` drops or reads differently from
//! bot-board (a Branch entry that is no issue or PR URL, say) is the
//! same for both here.

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::action::{Action, Write};
use crate::model::{ContentKind, FIELD_NEWS, FIELD_STATUS, Item, Snapshot};
use crate::rules::RULES;
use crate::tool;

const TOOL: &str = "bot-reconcile";
const BOARD_FILE: &str = "board-items.json";
const STATES_FILE: &str = "content-states.json";
const OUTPUT_FILE: &str = "reconcile-parity.json";
const TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// What an action comes to: what it says, and the item and `bot-board
/// set` arguments that carry it out, if any.
type Deed = (String, Option<(String, Vec<String>)>);

/// Whether bot-reconcile's rules of the same names list the same actions
/// as ours, given the same board and states. Keys are the actions'.
#[derive(Debug, PartialEq, Eq)]
pub enum Parity {
    Same(usize),
    Differs {
        only_ours: Vec<String>,
        only_theirs: Vec<String>,
        /// Listed by both, but saying or doing something else.
        changed: Vec<String>,
    },
    NotCompared(String),
}

impl fmt::Display for Parity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let list = |keys: &[String]| match keys {
            [] => "none".to_owned(),
            keys => keys.join(", "),
        };
        match self {
            Self::Same(n) => write!(f, "the same {n} actions."),
            Self::Differs {
                only_ours,
                only_theirs,
                changed,
            } => write!(
                f,
                "**differs**. Only bot-sched: {}. Only bot-reconcile: {}. Say or do something else: {}.",
                list(only_ours),
                list(only_theirs),
                list(changed)
            ),
            Self::NotCompared(why) => write!(f, "not compared: {why}"),
        }
    }
}

/// An action of bot-reconcile's `--json` output.
#[derive(Deserialize)]
struct Theirs {
    key: String,
    #[serde(rename = "do")]
    todo: String,
    apply: Option<Apply>,
}

#[derive(Deserialize)]
struct Apply {
    id: String,
    set: Vec<String>,
}

#[derive(Deserialize)]
struct Output {
    actions: Vec<Theirs>,
    #[serde(default)]
    errors: Vec<String>,
}

/// A write as the `bot-board set` arguments `lib/reconcile.js` gives it.
fn set_args(write: &Write) -> Vec<String> {
    match write {
        Write::ClearField { field } => vec!["--field".to_owned(), field.clone(), String::new()],
        Write::SetFields { fields } => {
            let named = [(FIELD_STATUS, "--status"), (FIELD_NEWS, "--news")];
            let known = named.iter().filter_map(|(field, flag)| {
                Some(vec![(*flag).to_owned(), fields.get(*field)?.clone()])
            });
            let other = fields
                .iter()
                .filter(|(name, _)| named.iter().all(|(field, _)| field != name))
                .map(|(name, value)| vec!["--field".to_owned(), name.clone(), value.clone()]);
            known.chain(other).flatten().collect()
        }
    }
}

/// Actions by key, compared as GitHub compares URLs (an owner's and a
/// repository's case is ignored), with the key as it was written.
type Deeds = BTreeMap<String, (String, Deed)>;

fn ours(actions: &[Action]) -> Deeds {
    let deed = |a: &Action| {
        let apply = a.write.as_ref().map(|w| (a.item.clone(), set_args(w)));
        (a.todo.clone(), apply)
    };
    actions
        .iter()
        .map(|a| (a.key.to_ascii_lowercase(), (a.key.clone(), deed(a))))
        .collect()
}

/// bot-reconcile's actions, from its exit status and `--json` output. One
/// that failed or could not read an input has not answered.
fn theirs(ran: &tool::Ran) -> Result<Deeds> {
    let output: Output =
        serde_json::from_str(&ran.output).context("its output is not the JSON of --json")?;
    let named = match output.errors.as_slice() {
        [] => "no error named".to_owned(),
        errors => errors.join("; "),
    };
    ensure!(
        ran.exit == Some(0) && output.errors.is_empty(),
        "it failed: {named}"
    );
    let deed = |a: Theirs| {
        let apply = a.apply.map(|apply| (apply.id, apply.set));
        (a.key.to_ascii_lowercase(), (a.key, (a.todo, apply)))
    };
    Ok(output.actions.into_iter().map(deed).collect())
}

fn compare(ours: &Deeds, theirs: &Deeds) -> Parity {
    let only = |a: &Deeds, b: &Deeds| -> Vec<String> {
        let missing = a.iter().filter(|(k, _)| !b.contains_key(*k));
        missing.map(|(_, (key, _))| key.clone()).collect()
    };
    let (only_ours, only_theirs) = (only(ours, theirs), only(theirs, ours));
    let differs = |(k, (key, deed)): (&String, &(String, Deed))| {
        theirs
            .get(k)
            .filter(|(_, other)| other != deed)
            .map(|_| key.clone())
    };
    let changed: Vec<String> = ours.iter().filter_map(differs).collect();
    if only_ours.is_empty() && only_theirs.is_empty() && changed.is_empty() {
        return Parity::Same(ours.len());
    }
    Parity::Differs {
        only_ours,
        only_theirs,
        changed,
    }
}

/// The snapshot's items as `bot-board list --json` prints them, for
/// `bot-reconcile --board-file`.
fn board_file(snapshot: &Snapshot) -> Value {
    let item = |it: &Item| {
        let content = match &it.content {
            Some(c) => {
                let kind = match c.of.kind {
                    ContentKind::Issue => "Issue",
                    ContentKind::PullRequest => "PullRequest",
                };
                json!({ "type": kind, "url": c.of.url })
            }
            None => json!({ "type": "DraftIssue" }),
        };
        let branch: Vec<String> = it.branch.iter().map(ToString::to_string).collect();
        let fields = [
            ("status", it.status.as_ref().map(|s| s.as_str().to_owned())),
            ("lead", it.lead.clone()),
            ("branch", Some(branch.join(" ")).filter(|b| !b.is_empty())),
        ];
        let mut out = json!({ "id": it.id, "content": content });
        for (name, value) in fields {
            if let Some(value) = value {
                out[name] = Value::String(value);
            }
        }
        out
    };
    Value::Array(snapshot.items.iter().map(item).collect())
}

/// bot-watch's state file, as `bot-reconcile --watch-state` reads it,
/// holding the snapshot's states.
fn watch_state(snapshot: &Snapshot) -> Value {
    let items: Map<String, Value> = snapshot
        .states()
        .into_iter()
        .map(|(url, state)| (url, json!({ "state": state })))
        .collect();
    json!({ "version": 1, "items": items })
}

/// Runs bot-reconcile (in BIN_DIR) on the snapshot, through files in DIR,
/// and compares its actions with ACTIONS.
pub fn parity(dir: &Path, bin_dir: &Path, snapshot: &Snapshot, actions: &[Action]) -> Parity {
    let (board, states) = (dir.join(BOARD_FILE), dir.join(STATES_FILE));
    let files = [
        (&board, board_file(snapshot)),
        (&states, watch_state(snapshot)),
    ];
    for (file, value) in files {
        if let Err(e) = fs::write(file, value.to_string()) {
            return Parity::NotCompared(format!("cannot write {}: {e}", file.display()));
        }
    }
    let (board, states) = (board.to_string_lossy(), states.to_string_lossy());
    let mut args = vec!["--json", "--board-file", &board, "--watch-state", &states];
    for rule in RULES {
        args.extend(["--rule", rule.name]);
    }
    let ran = tool::run(
        &bin_dir.join(TOOL),
        &args,
        TIMEOUT,
        &dir.join(OUTPUT_FILE),
        false,
    );
    match theirs(&ran) {
        Ok(theirs) => compare(&ours(actions), &theirs),
        Err(e) => Parity::NotCompared(format!("{TOOL} ({}): {e:#}", ran.exit_text())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::action::Kind;

    fn ran(exit: i64, output: &str) -> tool::Ran {
        tool::Ran {
            exit: Some(exit),
            duration: Duration::ZERO,
            output: output.to_owned(),
        }
    }

    fn action(key: &str, todo: &str, write: Option<Write>) -> Action {
        Action {
            key: key.to_owned(),
            kind: Kind::ClosedNotDone,
            item: "PVTI_1".to_owned(),
            content: None,
            todo: todo.to_owned(),
            write,
        }
    }

    fn done() -> Option<Write> {
        let fields = [(FIELD_NEWS, "PR merged; set Done"), (FIELD_STATUS, "Done")];
        Some(Write::SetFields {
            fields: fields
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                .collect(),
        })
    }

    #[test]
    fn compares_what_actions_say_and_do() {
        const SET: &str =
            r#"{"id": "PVTI_1", "set": ["--status", "Done", "--news", "PR merged; set Done"]}"#;
        let theirs_of = |actions: &str| {
            theirs(&ran(
                0,
                &format!(r#"{{"actions": [{actions}], "errors": []}}"#),
            ))
            .unwrap()
        };
        let mine = [
            action("a:https://github.com/o/r/pull/1", "set it Done", done()),
            action("b", "ask", None),
        ];
        let same = format!(
            r#"{{"key": "a:https://github.com/O/R/pull/1", "do": "set it Done", "apply": {SET}}}, {{"key": "b", "do": "ask"}}"#
        );
        // (bot-reconcile's actions, the verdict)
        let cases = [
            (same.clone(), "the same 2 actions."),
            // The same key, but nothing carries it out there.
            (
                same.replace(&format!(r#", "apply": {SET}"#), ""),
                "**differs**. Only bot-sched: none. Only bot-reconcile: none. Say or do something else: a:https://github.com/o/r/pull/1.",
            ),
            (
                same.replace("--news", "--why"),
                "**differs**. Only bot-sched: none. Only bot-reconcile: none. Say or do something else: a:https://github.com/o/r/pull/1.",
            ),
            (
                same.replace(r#""do": "ask""#, r#""do": "tell""#),
                "**differs**. Only bot-sched: none. Only bot-reconcile: none. Say or do something else: b.",
            ),
            (
                r#"{"key": "c", "do": "x"}"#.to_owned(),
                "**differs**. Only bot-sched: a:https://github.com/o/r/pull/1, b. Only bot-reconcile: c. Say or do something else: none.",
            ),
        ];
        for (actions, verdict) in cases {
            assert_eq!(
                compare(&ours(&mine), &theirs_of(&actions)).to_string(),
                verdict,
                "{actions}"
            );
        }
    }

    #[test]
    fn a_failed_bot_reconcile_has_not_agreed() {
        // (exit, output, what the refusal says)
        let cases = [
            (
                1,
                r#"{"actions": [], "errors": ["the board: quota"]}"#,
                "it failed: the board: quota",
            ),
            (0, r#"{"actions": [], "errors": ["x"]}"#, "it failed: x"),
            (1, r#"{"actions": []}"#, "it failed: no error named"),
            (0, "Actions: none", "its output is not the JSON of --json"),
        ];
        for (exit, output, says) in cases {
            let err = theirs(&ran(exit, output)).unwrap_err();
            assert_eq!(err.to_string(), says, "{output}");
        }
    }

    #[test]
    fn writes_as_bot_board_arguments() {
        let clear = Write::ClearField {
            field: "Lead".to_owned(),
        };
        assert_eq!(set_args(&clear), ["--field", "Lead", ""]);
        let mut write = done().unwrap();
        if let Write::SetFields { fields } = &mut write {
            fields.insert("Why".to_owned(), "because".to_owned());
        }
        assert_eq!(
            set_args(&write),
            [
                "--status",
                "Done",
                "--news",
                "PR merged; set Done",
                "--field",
                "Why",
                "because"
            ]
        );
    }
}
