//! The observed state of the forge, typed: what one pass of the
//! scheduler knows. A [`Snapshot`] is plain data, so a recorded one is a
//! test case and the rules that read it never touch the network.

use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};

/// The schema of a serialized [`Snapshot`].
pub const SNAPSHOT_SCHEMA: &str = "bot-sched-snapshot/v1";
const GITHUB: &str = "https://github.com/";
/// What a board without a Status calls an item, in messages.
pub const UNTRIAGED: &str = "untriaged";
/// The board fields this code reads or sets, by name.
pub const FIELD_STATUS: &str = "Status";
pub const FIELD_PRIORITY: &str = "Priority";
pub const FIELD_LEAD: &str = "Lead";
pub const FIELD_RUN: &str = "Run";
pub const FIELD_BRANCH: &str = "Branch";
pub const FIELD_NEWS: &str = "News";

/// Which Projects v2 board the snapshot is of.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BoardRef {
    /// `orgs` or `users`, as in the REST path.
    pub owner_type: String,
    pub owner: String,
    pub number: u64,
}

impl BoardRef {
    /// Its REST path, without a leading slash.
    pub fn api_path(&self) -> String {
        format!(
            "{}/{}/projectsV2/{}",
            self.owner_type, self.owner, self.number
        )
    }

    /// Its URL, as gh-aw's `update_project` names a project.
    pub fn url(&self) -> String {
        format!(
            "{GITHUB}{}/{}/projects/{}",
            self.owner_type, self.owner, self.number
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ContentKind {
    Issue,
    PullRequest,
}

impl ContentKind {
    fn segment(self) -> &'static str {
        match self {
            Self::Issue => "issues",
            Self::PullRequest => "pull",
        }
    }

    /// "issue" or "PR", for messages.
    pub fn noun(self) -> &'static str {
        match self {
            Self::Issue => "issue",
            Self::PullRequest => "PR",
        }
    }
}

/// The URL of an issue or pull request on github.com. The one parser of
/// such URLs: it keeps the case it was given, and [`ContentUrl::key`] is
/// the identity to compare by.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct ContentUrl {
    pub owner: String,
    pub repo: String,
    pub kind: ContentKind,
    pub number: u64,
}

impl ContentUrl {
    /// Parses an issue or PR URL, ignoring anything after its number (a
    /// fragment, `/files`); None for anything else.
    pub fn parse(s: &str) -> Option<Self> {
        let mut parts = s.trim().strip_prefix(GITHUB)?.splitn(4, '/');
        let (owner, repo, kind, rest) =
            (parts.next()?, parts.next()?, parts.next()?, parts.next()?);
        let kind = match kind {
            "issues" => ContentKind::Issue,
            "pull" => ContentKind::PullRequest,
            _ => return None,
        };
        let name = |s: &str| {
            !s.is_empty()
                && s.chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
        };
        let digits = rest.split(|c: char| !c.is_ascii_digit()).next()?;
        (name(owner) && name(repo)).then_some(())?;
        Some(Self {
            owner: owner.to_owned(),
            repo: repo.to_owned(),
            kind,
            number: digits.parse().ok()?,
        })
    }

    /// Its identity: GitHub's owner and repository names ignore case.
    pub fn key(&self) -> String {
        self.to_string().to_ascii_lowercase()
    }

    /// `OWNER/REPO`.
    pub fn repository(&self) -> String {
        format!("{}/{}", self.owner, self.repo)
    }

    /// The REST path that answers for an issue and a PR alike.
    pub fn issue_api_path(&self) -> String {
        format!("repos/{}/{}/issues/{}", self.owner, self.repo, self.number)
    }
}

impl fmt::Display for ContentUrl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{GITHUB}{}/{}/{}/{}",
            self.owner,
            self.repo,
            self.kind.segment(),
            self.number
        )
    }
}

impl TryFrom<String> for ContentUrl {
    type Error = String;

    fn try_from(s: String) -> Result<Self, String> {
        Self::parse(&s).ok_or_else(|| format!("not an issue or pull request URL: {s}"))
    }
}

impl From<ContentUrl> for String {
    fn from(u: ContentUrl) -> Self {
        u.to_string()
    }
}

/// Where an issue or PR stands. `Gone` is one GitHub no longer shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ContentState {
    Open,
    Closed,
    Merged,
    Gone,
}

impl ContentState {
    /// Closed or merged: nothing more happens on it.
    pub fn ended(self) -> bool {
        matches!(self, Self::Closed | Self::Merged)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Closed => "closed",
            Self::Merged => "merged",
            Self::Gone => "gone",
        }
    }
}

/// The board's Status column. `Other` keeps an option this code does not
/// know, so that a new column is data, not a parse error.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(from = "String", into = "String")]
pub enum Status {
    Todo,
    InProgress,
    Draft,
    InReview,
    NeedsHuman,
    Done,
    Other(String),
}

impl Status {
    pub const TODO: &'static str = "Todo";
    pub const IN_PROGRESS: &'static str = "In Progress";
    pub const DRAFT: &'static str = "Draft";
    pub const IN_REVIEW: &'static str = "In Review";
    pub const NEEDS_HUMAN: &'static str = "Needs human";
    pub const DONE: &'static str = "Done";

    /// The option's name on the board.
    pub fn as_str(&self) -> &str {
        match self {
            Self::Todo => Self::TODO,
            Self::InProgress => Self::IN_PROGRESS,
            Self::Draft => Self::DRAFT,
            Self::InReview => Self::IN_REVIEW,
            Self::NeedsHuman => Self::NEEDS_HUMAN,
            Self::Done => Self::DONE,
            Self::Other(s) => s,
        }
    }
}

impl From<String> for Status {
    fn from(s: String) -> Self {
        match s.as_str() {
            Self::TODO => Self::Todo,
            Self::IN_PROGRESS => Self::InProgress,
            Self::DRAFT => Self::Draft,
            Self::IN_REVIEW => Self::InReview,
            Self::NEEDS_HUMAN => Self::NeedsHuman,
            Self::DONE => Self::Done,
            _ => Self::Other(s),
        }
    }
}

impl From<Status> for String {
    fn from(s: Status) -> Self {
        s.as_str().to_owned()
    }
}

/// The issue or PR a board item is of, with the state the board's own
/// listing gives it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Content {
    pub url: ContentUrl,
    pub state: ContentState,
}

/// One board item, with the fields the rules read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Item {
    /// Its `PVTI_` node id.
    pub id: String,
    /// None for a draft item, which is of no issue or PR.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<Content>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<Status>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lead: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run: Option<String>,
    /// The issues and PRs its Branch field names; anything else there
    /// is dropped.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub branch: Vec<ContentUrl>,
}

impl Item {
    pub fn url(&self) -> Option<&ContentUrl> {
        self.content.as_ref().map(|c| &c.url)
    }

    /// Its Status as messages name it.
    pub fn status_name(&self) -> &str {
        self.status.as_ref().map_or(UNTRIAGED, Status::as_str)
    }
}

/// What one pass observed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    pub schema: String,
    pub board: BoardRef,
    pub items: Vec<Item>,
    /// The state of Branch PRs that are not items themselves, by
    /// [`ContentUrl::key`]. One that could not be read is absent, and a
    /// rule must take an absent state as unknown, never as ended.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub linked: BTreeMap<String, ContentState>,
}

impl Snapshot {
    /// The state of every issue and PR the snapshot knows, by key: the
    /// items' own and the linked ones.
    pub fn states(&self) -> BTreeMap<String, ContentState> {
        let own = self
            .items
            .iter()
            .filter_map(|it| it.content.as_ref())
            .map(|c| (c.url.key(), c.state));
        self.linked.clone().into_iter().chain(own).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_urls() {
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
            ("https://github.com/o/r/compare/main...b", None),
            ("https://github.com/o/r/pull/", None),
            ("https://github.com/o/r/pull/x1", None),
            ("https://github.com/o//pull/1", None),
            ("https://example.com/o/r/pull/1", None),
            ("bot/t405", None),
        ];
        for (input, want) in cases {
            let got = ContentUrl::parse(input).map(|u| u.to_string());
            assert_eq!(got.as_deref(), want, "{input}");
        }
        let mixed = ContentUrl::parse("https://github.com/O/R/pull/1").unwrap();
        assert_eq!(mixed.key(), "https://github.com/o/r/pull/1");
        assert_eq!(mixed.repository(), "O/R");
        assert_eq!(mixed.issue_api_path(), "repos/O/R/issues/1");
    }

    #[test]
    fn statuses_round_trip() {
        for name in [
            "Todo",
            "In Progress",
            "Draft",
            "In Review",
            "Needs human",
            "Done",
            "Parked",
        ] {
            let status = Status::from(name.to_owned());
            assert_eq!(status.as_str(), name);
            assert_eq!(matches!(status, Status::Other(_)), name == "Parked");
        }
    }
}
