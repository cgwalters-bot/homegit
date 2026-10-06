//! `bot-sched` as a command, against a recorded board and stand-ins for
//! bot-sweep and bot-reconcile (which 'report' still runs). No network.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const RUN: &str = "20261006-151029-159";
/// Publishes $FAKE_STATUS (unless empty) and one step's output, as
/// bot-sweep does under --state-dir.
const FAKE_SWEEP: &str = r#"#!/bin/bash
test "$1" = --read-only && test "$2" = --state-dir || exit 99
if [ -n "${FAKE_STATUS-}" ]; then
  mkdir -p "$3/runs/RUN"
  printf '%s' "${FAKE_WATCH-}" >"$3/runs/RUN/watch.txt"
  printf '%s' "${FAKE_STATUS//DIR/$3/runs/RUN}" >"$3/status.json"
fi
echo "bot-sweep: run RUN took 1s"
exit "${FAKE_SWEEP_EXIT:-0}"
"#;
/// Answers --json (the parity run) with $FAKE_ACTIONS.
const FAKE_RECONCILE: &str = r#"#!/bin/bash
case "$1" in
  --sweep-dir) echo "Actions: none" ;;
  --json) test "$2" = --board-file && test -s "$3" && test "$4" = --watch-state && test -s "$5" || exit 98; printf '%s' "${FAKE_ACTIONS-}" ;;
  *) exit 99 ;;
esac
"#;
/// The keys of the actions the recorded board gives (see tests/pass.rs).
const KEYS: [&str; 6] = [
    "closed-not-done:https://github.com/cgwalters-bot/homegit/pull/1",
    "closed-not-done:https://github.com/cgwalters-bot/homegit/pull/2",
    "closed-not-done:https://github.com/cgwalters-forge/tracker/issues/7",
    "closed-not-done:https://github.com/cgwalters-forge/tracker/issues/9",
    "stale-lead:PVTI_draft",
    "stale-lead:https://github.com/cgwalters-forge/tracker/issues/11",
];

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/board.json")
}

struct World {
    dir: tempfile::TempDir,
}

impl World {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("bin");
        fs::create_dir(&bin).unwrap();
        for (name, text) in [("bot-sweep", FAKE_SWEEP), ("bot-reconcile", FAKE_RECONCILE)] {
            let file = bin.join(name);
            fs::write(&file, text.replace("RUN", RUN)).unwrap();
            fs::set_permissions(&file, fs::Permissions::from_mode(0o755)).unwrap();
        }
        Self { dir }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }

    /// Runs bot-sched with no token and no operator config of its own.
    fn run(&self, args: &[&str], env: &[(&str, &str)]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_bot-sched"))
            .args(args)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", self.dir.path())
            .envs(env.iter().copied())
            .output()
            .unwrap()
    }

    fn report(&self, env: &[(&str, &str)]) -> (Output, String) {
        let (out, bin, summary) = (self.path("out"), self.path("bin"), self.path("summary"));
        let mut env = env.to_vec();
        let summary = summary.to_string_lossy().into_owned();
        env.push(("GITHUB_STEP_SUMMARY", &summary));
        let fixture = fixture();
        let args = [
            "report",
            "--dir",
            out.to_str().unwrap(),
            "--bin-dir",
            bin.to_str().unwrap(),
            "--recorded",
            fixture.to_str().unwrap(),
        ];
        let output = self.run(&args, &env);
        let text = fs::read_to_string(out.join("report.md")).unwrap_or_default();
        (output, text)
    }
}

fn status(extra: &str) -> String {
    format!(
        r#"{{"run": "{RUN}", "dir": "DIR", "started_at": "2026-10-06T15:10:29.159Z", "duration_s": 1, "complete": true, "problems": [], "steps": {{"watch": {{"exit": 0, "duration_s": 0.5}}}}{extra}}}"#
    )
}

/// What the real bot-reconcile answers for the recorded board (kept from
/// a run of tests/bot-sched-parity.sh), changed by EDIT.
fn theirs(edit: impl FnOnce(&mut Vec<serde_json::Value>)) -> String {
    let file = fixture().with_file_name("reconcile.json");
    let mut output: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(file).unwrap()).unwrap();
    edit(output["actions"].as_array_mut().unwrap());
    output.to_string()
}

#[track_caller]
fn assert_has(text: &str, part: &str) {
    assert!(text.contains(part), "no {part:?} in:\n{text}");
}

#[test]
fn the_report_has_the_sweep_the_reconcile_and_the_scheduler_pass() {
    let world = World::new();
    let (status, same) = (status(""), theirs(|_| ()));
    let (out, text) = world.report(&[
        ("FAKE_STATUS", &status),
        ("FAKE_WATCH", "Swept 3 URLs\n"),
        ("FAKE_ACTIONS", &same),
    ]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        text.starts_with(&format!("# Controller report (read-only): sweep {RUN}\n")),
        "{text}"
    );
    for part in [
        "\nStarted 2026-10-06T15:10:29.159Z, took 1s; complete.\n\nNo problems.\n",
        "<code>watch</code>: exit 0, 0.5s, 13 characters</summary>\n\n```text\nSwept 3 URLs\n```\n",
        "characters</summary>\n\n```text\nActions: none\n```\n",
        "Observed 10 board items (9 of an issue or PR, their state from the board's own listing) and 3 linked PRs.\n",
        "Not read:\n\n```text\nthe state of https://github.com/cgwalters-forge/bootc/pull/500: ",
        "Actions of closed-not-done, stale-lead: 6\n",
        "* closed-not-done https://github.com/cgwalters-bot/homegit/pull/1: its PR merged, but it is Draft: set it Done\n",
        "Safe outputs: 3 in `agent_output.json` (nothing applies them yet).\n",
        "No safe-output type:\n\n```text\nstale-lead:PVTI_draft: update_project sets values only",
        "Against bot-reconcile on the same board: the same 6 actions.\n",
    ] {
        assert_has(&text, part);
    }
    assert_eq!(fs::read_to_string(world.path("summary")).unwrap(), text);
    assert_eq!(
        fs::read_to_string(world.path("out/reconcile.txt")).unwrap(),
        "Actions: none\n"
    );
    let output: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(world.path("out/agent_output.json")).unwrap())
            .unwrap();
    assert_eq!(output["items"].as_array().unwrap().len(), 3);
    assert!(world.path("out/snapshot.json").exists());
}

#[test]
fn a_report_says_where_bot_reconcile_differs() {
    let world = World::new();
    // One action gone, one saying something else, one of its own.
    let theirs = theirs(|actions| {
        actions.remove(1);
        actions[0]["apply"]["set"][1] = "Dropped".into();
        actions.push(serde_json::json!({ "key": "closed-not-done:https://github.com/o/r/issues/1", "do": "x" }));
    });
    let (out, text) = world.report(&[("FAKE_STATUS", &status("")), ("FAKE_ACTIONS", &theirs)]);
    assert!(out.status.success());
    assert_has(
        &text,
        &format!(
            "Against bot-reconcile on the same board: **differs**. Only bot-sched: {}. Only bot-reconcile: closed-not-done:https://github.com/o/r/issues/1. Say or do something else: {}.\n",
            KEYS[1], KEYS[0]
        ),
    );
    // An answer that is no JSON is not agreement.
    let (_, text) = world.report(&[
        ("FAKE_STATUS", &status("")),
        ("FAKE_ACTIONS", "gh: rate limited"),
    ]);
    assert_has(
        &text,
        "Against bot-reconcile on the same board: not compared: bot-reconcile (exit 0): its output is not the JSON of --json",
    );
}

#[test]
fn a_sweep_with_problems_or_none_is_still_a_report() {
    let world = World::new();
    let failing = status("")
        .replace(
            r#""complete": true, "problems": []"#,
            r#""complete": false, "problems": ["notify exited 1: HTTP 403"]"#,
        )
        .replace(
            r#""exit": 0, "duration_s": 0.5"#,
            r#""exit": null, "duration_s": 2"#,
        );
    let (out, text) = world.report(&[
        ("FAKE_STATUS", &failing),
        ("FAKE_WATCH", "a ```` fence\n"),
        ("FAKE_SWEEP_EXIT", "1"),
    ]);
    assert!(out.status.success());
    assert_has(
        &text,
        "; not complete.\n\nProblems:\n\n```text\nnotify exited 1: HTTP 403\n```\n",
    );
    assert_has(
        &text,
        "<code>watch</code>: killed, 2s, 13 characters</summary>\n\n`````text\na ```` fence\n`````\n",
    );
    assert_has(&text, "<code>bot-sweep</code>: exit 1, ");

    // In the same directory: not the last sweep's status.
    let (out, text) = world.report(&[("FAKE_SWEEP_EXIT", "75")]);
    assert!(out.status.success());
    assert_has(
        &text,
        "sweep not published\n\nbot-sweep published no status (exit 75).\n",
    );
}

#[test]
fn reconcile_reads_a_recording_or_a_snapshot_and_refuses_unknown_arguments() {
    let world = World::new();
    let fixture = fixture();
    let (snapshot, emitted) = (world.path("snapshot.json"), world.path("agent_output.json"));
    let observed = world.run(&["observe", "--recorded", fixture.to_str().unwrap()], &[]);
    assert!(
        observed.status.success(),
        "{}",
        String::from_utf8_lossy(&observed.stderr)
    );
    assert_has(
        &String::from_utf8_lossy(&observed.stderr),
        "warning: not read: the state of https://github.com/cgwalters-forge/bootc/pull/500",
    );
    fs::write(&snapshot, &observed.stdout).unwrap();

    let out = world.run(
        &[
            "reconcile",
            "--snapshot",
            snapshot.to_str().unwrap(),
            "--rule",
            "stale-lead",
            "--emit",
            emitted.to_str().unwrap(),
        ],
        &[],
    );
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&out.stdout),
        "* stale-lead PVTI_draft: Lead coordinator, but it is Done: clear its Lead\n* stale-lead https://github.com/cgwalters-forge/tracker/issues/11: Lead coordinator, but it is Todo: clear its Lead\n"
    );
    assert_has(
        &String::from_utf8_lossy(&out.stderr),
        "not emitted: stale-lead:PVTI_draft: ",
    );
    assert_eq!(
        fs::read_to_string(&emitted).unwrap(),
        "{\n  \"items\": [],\n  \"errors\": []\n}\n"
    );

    let json = world.run(
        &[
            "reconcile",
            "--recorded",
            fixture.to_str().unwrap(),
            "--json",
        ],
        &[],
    );
    let value: serde_json::Value = serde_json::from_slice(&json.stdout).unwrap();
    let keys: Vec<_> = value["actions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["key"].as_str().unwrap())
        .collect();
    assert_eq!(keys, KEYS);

    // A snapshot of the schema before this one is refused by name.
    let old = world.path("old.json");
    fs::write(&old, r#"{"schema": "bot-sched-snapshot/v1", "board": {}}"#).unwrap();

    // (arguments, exit status, what stderr says)
    let refused = [
        (
            vec!["reconcile", "--snapshot", old.to_str().unwrap()],
            1,
            "is a snapshot of schema 'bot-sched-snapshot/v1', not bot-sched-snapshot/v2",
        ),
        (
            vec!["reconcile", "--nope"],
            2,
            "unexpected argument '--nope'",
        ),
        (
            vec![
                "reconcile",
                "--snapshot",
                snapshot.to_str().unwrap(),
                "--rule",
                "nope",
            ],
            1,
            "unknown rule 'nope'",
        ),
        (
            vec!["observe"],
            1,
            "no GitHub token: set GH_TOKEN or GITHUB_TOKEN",
        ),
    ];
    for (args, code, says) in refused {
        let out = world.run(&args, &[]);
        assert_eq!(out.status.code(), Some(code), "{args:?}");
        assert_has(&String::from_utf8_lossy(&out.stderr), says);
    }
}
