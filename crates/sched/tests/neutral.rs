//! The scheduler's core names no forge: a pass over a forge that is not
//! GitHub, with another forge's URLs and repository paths, and a check
//! that the core's sources say nothing of GitHub. No network.

use std::cell::RefCell;
use std::collections::BTreeMap;

use anyhow::{Result, bail};
use bot_sched::forge::{BoardItem, Forge};
use bot_sched::model::{Content, ContentKind, ContentRef, ContentState};
use bot_sched::observe::observe;
use bot_sched::rules::reconcile;
use serde_json::json;

const WEB: &str = "https://forge.example/";
const BOARD: &str = "https://forge.example/groups/g/-/boards/7";
/// A repository in a nested group, which GitHub does not have.
const REPO: &str = "g/sub/project";
const FIELDS: [&str; 3] = ["Status", "Lead", "Branch"];

fn content_ref(kind: ContentKind, number: u64) -> ContentRef {
    let segment = match kind {
        ContentKind::Issue => "issues",
        ContentKind::PullRequest => "merge_requests",
    };
    ContentRef {
        url: format!("{WEB}{REPO}/-/{segment}/{number}"),
        repo: REPO.to_owned(),
        kind,
        number,
    }
}

/// A merge request of [`REPO`], as GitLab writes its URL.
fn merge_request(number: u64) -> ContentRef {
    content_ref(ContentKind::PullRequest, number)
}

fn issue(number: u64) -> ContentRef {
    content_ref(ContentKind::Issue, number)
}

/// A forge held in memory: its board, the states it answers with (an
/// error for one it does not have), and what it was asked.
struct Memory {
    fields: Vec<&'static str>,
    items: Vec<BoardItem>,
    states: BTreeMap<String, ContentState>,
    asked: RefCell<Vec<String>>,
}

impl Forge for Memory {
    fn board_url(&self) -> String {
        BOARD.to_owned()
    }

    fn board_fields(&self) -> Result<Vec<String>> {
        Ok(self.fields.iter().map(|f| (*f).to_owned()).collect())
    }

    fn board_items(&self, fields: &[&str]) -> Result<Vec<BoardItem>> {
        let mut items = self.items.clone();
        for item in &mut items {
            item.fields
                .retain(|name, _| fields.contains(&name.as_str()));
        }
        Ok(items)
    }

    /// `WEB/GROUP.../PROJECT/-/issues/N` or `.../-/merge_requests/N`.
    fn content_ref(&self, text: &str) -> Option<ContentRef> {
        let (repo, rest) = text.strip_prefix(WEB)?.split_once("/-/")?;
        let (segment, number) = rest.split_once('/')?;
        let kind = match segment {
            "issues" => ContentKind::Issue,
            "merge_requests" => ContentKind::PullRequest,
            _ => return None,
        };
        let number = number.parse().ok()?;
        (repo == REPO).then(|| content_ref(kind, number))
    }

    fn content_state(&self, content: &ContentRef) -> Result<ContentState> {
        self.asked.borrow_mut().push(content.url.clone());
        match self.states.get(&content.key()) {
            Some(state) => Ok(*state),
            None => bail!("HTTP 500"),
        }
    }
}

fn item(id: &str, status: &str, of: ContentRef, state: ContentState, branch: &str) -> BoardItem {
    let fields = [("Status", status), ("Branch", branch), ("Epic", "ignored")];
    BoardItem {
        id: id.to_owned(),
        content: Some(Content { of, state }),
        fields: fields
            .iter()
            .filter(|(_, value)| !value.is_empty())
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
            .collect(),
    }
}

#[test]
fn a_pass_over_another_forge() {
    use ContentState::{Closed, Merged, Open};
    // A Branch names merge requests by URL; what is no URL of this
    // forge's is dropped.
    let waiting = format!(
        "{} bot/topic https://example.com/o/r/pull/1",
        merge_request(10)
    );
    let forge = Memory {
        fields: FIELDS.to_vec(),
        items: vec![
            item("gid://Item/1", "In Review", issue(1), Closed, &waiting),
            item(
                "gid://Item/2",
                "In Review",
                issue(2),
                Closed,
                &merge_request(11).url,
            ),
            // Its own merge request is an item too: not asked for again.
            item(
                "gid://Item/3",
                "Draft",
                issue(3),
                Closed,
                &merge_request(12).url,
            ),
            item("gid://Item/4", "Draft", merge_request(12), Merged, ""),
            item("gid://Item/5", "Draft", issue(5), Open, ""),
        ],
        states: BTreeMap::from([(merge_request(10).key(), Open)]),
        asked: RefCell::default(),
    };

    let observed = observe(&forge).unwrap();
    let snapshot = &observed.snapshot;
    assert_eq!(
        *forge.asked.borrow(),
        [merge_request(10).url, merge_request(11).url]
    );
    assert_eq!(
        observed.problems,
        [format!("the state of {}: HTTP 500", merge_request(11))]
    );

    // The snapshot's form, which a saved one is read back from.
    let value = serde_json::to_value(snapshot).unwrap();
    assert_eq!(value["schema"], "bot-sched-snapshot/v2");
    assert_eq!(value["board"], BOARD);
    assert_eq!(
        value["linked"],
        json!({ "https://forge.example/g/sub/project/-/merge_requests/10": "open" })
    );
    assert_eq!(
        value["items"][0],
        json!({
            "id": "gid://Item/1",
            "content": {
                "of": {
                    "url": "https://forge.example/g/sub/project/-/issues/1",
                    "repo": "g/sub/project",
                    "kind": "issue",
                    "number": 1,
                },
                "state": "closed",
            },
            "status": "In Review",
            "branch": [{
                "url": "https://forge.example/g/sub/project/-/merge_requests/10",
                "repo": "g/sub/project",
                "kind": "pull-request",
                "number": 10,
            }],
        })
    );
    assert_eq!(
        &serde_json::from_value::<bot_sched::model::Snapshot>(value).unwrap(),
        snapshot
    );

    // An open merge request holds its item back, and so does one that
    // could not be read; the rest is Done.
    let lines: Vec<String> = reconcile(snapshot, &[])
        .unwrap()
        .iter()
        .map(|a| a.line())
        .collect();
    assert_eq!(
        lines,
        [
            format!(
                "* closed-not-done {}: its issue closed, but it is Draft: set it Done",
                issue(3)
            ),
            format!(
                "* closed-not-done {}: its PR merged, but it is Draft: set it Done",
                merge_request(12)
            ),
        ]
    );
}

#[test]
fn a_board_without_status_is_refused_on_any_forge() {
    let forge = Memory {
        fields: vec!["Lead", "Branch"],
        items: Vec::new(),
        states: BTreeMap::new(),
        asked: RefCell::default(),
    };
    assert_eq!(
        observe(&forge).unwrap_err().to_string(),
        format!("the board {BOARD} has no 'Status' field: its layout changed")
    );
}

/// What only GitHub has, which belongs behind `forge::github`.
const GITHUB_WORDS: [&str; 5] = ["github", "gh-aw", "pvti", "projectsv2", "update_project"];
const CORE: [(&str, &str); 5] = [
    ("model.rs", include_str!("../src/model.rs")),
    ("rules.rs", include_str!("../src/rules.rs")),
    ("observe.rs", include_str!("../src/observe.rs")),
    ("action.rs", include_str!("../src/action.rs")),
    ("forge.rs", include_str!("../src/forge.rs")),
];
/// forge.rs declares the module and says where GitHub's code is.
const ALLOWED: [(&str, &str); 2] = [("forge.rs", "pub mod github;"), ("forge.rs", "[`github`]")];

#[test]
fn the_core_names_no_forge() {
    for (file, text) in CORE {
        for (n, line) in text.lines().enumerate() {
            let allowed = ALLOWED.iter().any(|(f, s)| *f == file && line.contains(s));
            let lower = line.to_ascii_lowercase();
            let found = GITHUB_WORDS.iter().find(|w| lower.contains(**w));
            assert!(
                allowed || found.is_none(),
                "src/{file}:{}: '{}' belongs in src/forge/github: {line}",
                n + 1,
                found.unwrap_or(&"")
            );
        }
    }
}
