//! GitHub as a [`Forge`]: a Projects v2 board read over REST, github.com
//! URLs, and writes handed to gh-aw's safe-output handlers. What the
//! scheduler's library knows about GitHub is in this module; outside it,
//! only the command line, the report and the parity check (which run
//! GitHub-only tools that are not ported yet) name it.
//!
//! The board's REST listing carries the issue or PR of every item whole,
//! so an item's state comes with the listing and needs no request of its
//! own.

use std::cell::OnceCell;

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use serde_json::Value;

use crate::forge::{BoardItem, Forge};
use crate::model::{Content, ContentKind, ContentRef, ContentState};

mod api;
mod emit;

pub use api::{Api, Recorded, Recorder, Rest};
pub use emit::{AgentOutput, Emitted, SafeOutput, emit};

const WEB: &str = "https://github.com/";
const ISSUES: &str = "issues";
const PULL: &str = "pull";
const PER_PAGE: usize = 100;

/// Which Projects v2 board.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoardRef {
    /// `orgs` or `users`, as in the REST path.
    pub owner_type: String,
    pub owner: String,
    pub number: u64,
}

impl BoardRef {
    /// Its REST path, without a leading slash.
    fn api_path(&self) -> String {
        format!(
            "{}/{}/projectsV2/{}",
            self.owner_type, self.owner, self.number
        )
    }

    /// Its URL, as gh-aw's `update_project` names a project.
    pub fn url(&self) -> String {
        format!(
            "{WEB}{}/{}/projects/{}",
            self.owner_type, self.owner, self.number
        )
    }
}

/// Parses the URL of an issue or pull request on github.com, ignoring
/// anything after its number (a fragment, `/files`); None for anything
/// else. The one parser of such URLs: the reference keeps the case it
/// was given, and [`ContentRef::key`] is the identity to compare by.
pub fn parse_content_ref(s: &str) -> Option<ContentRef> {
    let mut parts = s.trim().strip_prefix(WEB)?.splitn(4, '/');
    let (owner, repo, segment, rest) = (parts.next()?, parts.next()?, parts.next()?, parts.next()?);
    let kind = match segment {
        ISSUES => ContentKind::Issue,
        PULL => ContentKind::PullRequest,
        _ => return None,
    };
    // Not `.` or `..`: the names go into a REST path.
    let name = |s: &str| {
        !matches!(s, "" | "." | "..")
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
    };
    let digits = rest.split(|c: char| !c.is_ascii_digit()).next()?;
    let number: u64 = digits.parse().ok()?;
    (name(owner) && name(repo)).then_some(())?;
    Some(ContentRef {
        url: format!("{WEB}{owner}/{repo}/{segment}/{number}"),
        repo: format!("{owner}/{repo}"),
        kind,
        number,
    })
}

/// Whether a reference is what its URL parses to here: one read from a
/// file may be another forge's, or name a repository its URL does not.
fn is_ours(content: &ContentRef) -> bool {
    parse_content_ref(&content.url).as_ref() == Some(content)
}

/// The REST path that answers for an issue and a PR alike.
fn issue_api_path(content: &ContentRef) -> String {
    format!("repos/{}/issues/{}", content.repo, content.number)
}

#[derive(Deserialize)]
struct RawField {
    id: u64,
    name: String,
}

#[derive(Deserialize)]
struct RawItem {
    node_id: String,
    content: Option<RawContent>,
    #[serde(default)]
    fields: Vec<RawValue>,
}

#[derive(Deserialize)]
struct RawContent {
    html_url: Option<String>,
    state: Option<String>,
    merged_at: Option<String>,
}

#[derive(Deserialize)]
struct RawValue {
    name: String,
    #[serde(default)]
    value: Value,
}

/// An issue as `repos/O/R/issues/N` answers, for a PR too.
#[derive(Deserialize)]
struct RawIssue {
    state: String,
    pull_request: Option<RawPull>,
}

#[derive(Deserialize)]
struct RawPull {
    merged_at: Option<String>,
}

fn state_of(state: &str, merged: bool) -> Result<ContentState> {
    match (state, merged) {
        (_, true) => Ok(ContentState::Merged),
        ("open", _) => Ok(ContentState::Open),
        ("closed", _) => Ok(ContentState::Closed),
        _ => bail!("unknown state '{state}'"),
    }
}

/// The text of a board field's value: a single-select's option name, a
/// text field's text.
fn text_of(value: &Value) -> Option<String> {
    let raw = [&value["name"]["raw"], &value["raw"], value];
    raw.iter()
        .find_map(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn item_of(raw: RawItem) -> Result<BoardItem> {
    let fields = raw
        .fields
        .iter()
        .filter_map(|f| Some((f.name.clone(), text_of(&f.value)?)))
        .collect();
    // A draft item has a content with no URL.
    let content = match raw.content {
        Some(RawContent {
            html_url: Some(url),
            state,
            merged_at,
        }) => {
            let state = state.with_context(|| format!("the item of {url} has no state"))?;
            let state = state_of(&state, merged_at.is_some())
                .with_context(|| format!("the item of {url}"))?;
            let of = parse_content_ref(&url)
                .with_context(|| format!("{url} is not an issue or pull request URL"))?;
            Some(Content { of, state })
        }
        _ => None,
    };
    Ok(BoardItem {
        id: raw.node_id,
        content,
        fields,
    })
}

/// One Projects v2 board, read through `A`.
pub struct GitHub<A> {
    api: A,
    board: BoardRef,
    /// The board's fields, asked for once a pass.
    fields: OnceCell<Vec<RawField>>,
}

impl<A: Api> GitHub<A> {
    pub fn new(api: A, board: BoardRef) -> Self {
        Self {
            api,
            board,
            fields: OnceCell::new(),
        }
    }

    fn fields(&self) -> Result<&[RawField]> {
        if let Some(fields) = self.fields.get() {
            return Ok(fields);
        }
        let path = format!("{}/fields?per_page={PER_PAGE}", self.board.api_path());
        let fields: Vec<RawField> = serde_json::from_value(Value::Array(self.api.list(&path)?))
            .context("the board's fields are not what the REST API documents")?;
        Ok(self.fields.get_or_init(|| fields))
    }
}

impl<A: Api> Forge for GitHub<A> {
    fn board_url(&self) -> String {
        self.board.url()
    }

    fn board_fields(&self) -> Result<Vec<String>> {
        Ok(self.fields()?.iter().map(|f| f.name.clone()).collect())
    }

    /// Only the fields named are asked for, by id, which keeps the
    /// listing small.
    fn board_items(&self, fields: &[&str]) -> Result<Vec<BoardItem>> {
        let ids: Vec<String> = self
            .fields()?
            .iter()
            .filter(|f| fields.contains(&f.name.as_str()))
            .map(|f| f.id.to_string())
            .collect();
        let path = format!(
            "{}/items?per_page={PER_PAGE}&fields={}",
            self.board.api_path(),
            ids.join(",")
        );
        self.api
            .list(&path)?
            .into_iter()
            .map(|raw| item_of(serde_json::from_value(raw)?))
            .collect::<Result<Vec<BoardItem>>>()
            .context("a board item is not what the REST API documents")
    }

    fn content_ref(&self, text: &str) -> Option<ContentRef> {
        parse_content_ref(text)
    }

    fn content_state(&self, content: &ContentRef) -> Result<ContentState> {
        // A reference is data, and its repository goes into a path.
        if !is_ours(content) {
            bail!("not an issue or pull request on github.com");
        }
        let path = issue_api_path(content);
        let Some(issue) = self.api.get(&path)? else {
            return Ok(ContentState::Gone);
        };
        let issue: RawIssue = serde_json::from_value(issue)
            .with_context(|| format!("GET {path}: not an issue as the REST API documents"))?;
        let merged = issue.pull_request.is_some_and(|p| p.merged_at.is_some());
        state_of(&issue.state, merged)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_refs() {
        // (input, the URL it is, or None)
        let cases = [
            (
                "https://github.com/o/r/issues/7",
                Some("https://github.com/o/r/issues/7"),
            ),
            (
                "https://github.com/O/R.x/pull/12/files#diff",
                Some("https://github.com/O/R.x/pull/12"),
            ),
            (
                " https://github.com/o/r/pull/3 ",
                Some("https://github.com/o/r/pull/3"),
            ),
            (
                "https://github.com/o/r/pull/007",
                Some("https://github.com/o/r/pull/7"),
            ),
            ("https://github.com/o/r/compare/main...b", None),
            ("https://github.com/o/r/pull/", None),
            ("https://github.com/o/r/pull/x1", None),
            ("https://github.com/o//pull/1", None),
            ("https://github.com/../../pull/1", None),
            ("https://github.com/o/./pull/1", None),
            ("https://example.com/o/r/pull/1", None),
            ("bot/t405", None),
        ];
        for (input, want) in cases {
            let got = parse_content_ref(input).map(|c| c.url);
            assert_eq!(got.as_deref(), want, "{input}");
        }
        let mixed = parse_content_ref("https://github.com/O/R/pull/1").unwrap();
        assert_eq!(mixed.key(), "https://github.com/o/r/pull/1");
        assert_eq!(mixed.repo, "O/R");
        assert_eq!(mixed.kind, ContentKind::PullRequest);
        assert_eq!(issue_api_path(&mixed), "repos/O/R/issues/1");
    }

    /// No request is made for a reference that is not GitHub's own.
    #[test]
    fn foreign_references_are_not_asked_for() {
        let ours = parse_content_ref("https://github.com/o/r/pull/1").unwrap();
        let board = BoardRef {
            owner_type: "orgs".to_owned(),
            owner: "o".to_owned(),
            number: 1,
        };
        let forge = GitHub::new(Recorded::default(), board);
        let cases = [
            ContentRef {
                repo: "o/r/../../x".to_owned(),
                ..ours.clone()
            },
            ContentRef {
                url: "https://forge.example/o/r/pull/1".to_owned(),
                ..ours.clone()
            },
        ];
        for content in cases {
            let err = forge.content_state(&content).unwrap_err();
            assert_eq!(
                err.to_string(),
                "not an issue or pull request on github.com",
                "{content:?}"
            );
        }
        // Its own is asked for: the empty recording says so.
        let err = forge.content_state(&ours).unwrap_err();
        assert_eq!(
            err.to_string(),
            "GET repos/o/r/issues/1 is not in the recording"
        );
    }
}
