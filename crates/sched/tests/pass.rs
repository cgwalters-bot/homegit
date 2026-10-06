//! One whole pass (observe, reconcile, emit) over a recorded board:
//! tests/fixtures/board.json holds GitHub's answers, cut down to what
//! is read. No network.

use std::path::{Path, PathBuf};

use bot_sched::action::emit;
use bot_sched::forge::Recorded;
use bot_sched::model::{BoardRef, ContentState};
use bot_sched::observe::observe;
use bot_sched::rules::reconcile;
use serde_json::json;

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/board.json")
}

fn board() -> BoardRef {
    BoardRef {
        owner_type: "orgs".to_owned(),
        owner: "cgwalters-forge".to_owned(),
        number: 1,
    }
}

#[test]
fn a_recorded_pass() {
    let forge = Recorded::load(&fixture()).unwrap();
    let observed = observe(&forge, &board()).unwrap();
    let snapshot = &observed.snapshot;

    assert_eq!(snapshot.items.len(), 10);
    // Only the Branch PRs of ended items that are not items themselves
    // were asked for; the one outside the recording is a problem, and
    // stays unknown.
    let linked: Vec<_> = snapshot
        .linked
        .iter()
        .map(|(k, s)| (k.as_str(), *s))
        .collect();
    assert_eq!(
        linked,
        [
            (
                "https://github.com/bootc-dev/bootc/pull/50",
                ContentState::Open
            ),
            (
                "https://github.com/cgwalters-forge/bootc/pull/404",
                ContentState::Gone
            ),
            (
                "https://github.com/cgwalters-forge/bootc/pull/8",
                ContentState::Merged
            ),
        ]
    );
    assert_eq!(observed.problems.len(), 1, "{:?}", observed.problems);
    assert!(
        observed.problems[0]
            .starts_with("the state of https://github.com/cgwalters-forge/bootc/pull/500: ")
    );

    // A snapshot is data: it survives a round trip, so a saved one is a
    // test case.
    let text = serde_json::to_string(snapshot).unwrap();
    assert_eq!(
        &serde_json::from_str::<bot_sched::model::Snapshot>(&text).unwrap(),
        snapshot
    );

    let actions = reconcile(snapshot, &[]).unwrap();
    let lines: Vec<String> = actions.iter().map(|a| a.line()).collect();
    assert_eq!(
        lines,
        [
            "* closed-not-done https://github.com/cgwalters-bot/homegit/pull/1: its PR merged, but it is Draft: set it Done",
            "* closed-not-done https://github.com/cgwalters-bot/homegit/pull/2: its PR closed unmerged, but it is Draft: ask the operator whether to drop it (Done) or redo it (Needs human), or set it Done if it is clear",
            "* closed-not-done https://github.com/cgwalters-forge/tracker/issues/7: its issue closed, but it is Needs human: set it Done",
            "* closed-not-done https://github.com/cgwalters-forge/tracker/issues/9: its issue closed, but it is Draft: set it Done",
            "* stale-lead PVTI_draft: Lead coordinator, but it is Done: clear its Lead",
            "* stale-lead https://github.com/cgwalters-forge/tracker/issues/11: Lead coordinator, but it is Todo: clear its Lead",
        ]
    );

    let emitted = emit(&actions, &snapshot.board);
    let update = |repo: &str, kind: &str, number: u64, news: &str| {
        json!({
            "type": "update_project",
            "project": "https://github.com/orgs/cgwalters-forge/projects/1",
            "content_type": kind,
            "content_number": number,
            "target_repo": repo,
            "fields": { "News": news, "Status": "Done" },
        })
    };
    assert_eq!(
        serde_json::to_value(&emitted.output).unwrap(),
        json!({
            "items": [
                update("cgwalters-bot/homegit", "pull_request", 1, "PR merged; set Done"),
                update("cgwalters-forge/tracker", "issue", 7, "issue closed; set Done"),
                update("cgwalters-forge/tracker", "issue", 9, "issue closed; set Done"),
            ],
            "errors": [],
        })
    );
    // Clearing a field has no safe-output type: said, not dropped.
    let unsupported: Vec<_> = emitted
        .unsupported
        .iter()
        .map(|(k, _)| k.as_str())
        .collect();
    assert_eq!(
        unsupported,
        [
            "stale-lead:PVTI_draft",
            "stale-lead:https://github.com/cgwalters-forge/tracker/issues/11"
        ]
    );
}

#[test]
fn a_board_without_status_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("board.json");
    let recording = json!({ "orgs/cgwalters-forge/projectsV2/1/fields?per_page=100": [{ "id": 1, "name": "Title" }] });
    std::fs::write(&file, recording.to_string()).unwrap();
    let err = observe(&Recorded::load(&file).unwrap(), &board()).unwrap_err();
    assert_eq!(
        err.to_string(),
        "the board https://github.com/orgs/cgwalters-forge/projects/1 has no 'Status' field: its layout changed"
    );
}
