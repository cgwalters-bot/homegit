//! The observed state of the forge, typed: what one pass of the
//! scheduler knows. A [`Snapshot`] is plain data, so a recorded one is a
//! test case and the rules that read it never touch the network.

use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};

/// The schema of a serialized [`Snapshot`].
pub const SNAPSHOT_SCHEMA: &str = "bot-sched-snapshot/v2";
/// What a board without a Status calls an item, in messages.
pub const UNTRIAGED: &str = "untriaged";
/// The board fields this code reads or sets, by name.
pub const FIELD_STATUS: &str = "Status";
pub const FIELD_PRIORITY: &str = "Priority";
pub const FIELD_LEAD: &str = "Lead";
pub const FIELD_RUN: &str = "Run";
pub const FIELD_BRANCH: &str = "Branch";
pub const FIELD_NEWS: &str = "News";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ContentKind {
    Issue,
    /// A pull request, or what the forge has for one (a merge request).
    PullRequest,
}

impl ContentKind {
    /// "issue" or "PR", for messages.
    pub fn noun(self) -> &'static str {
        match self {
            Self::Issue => "issue",
            Self::PullRequest => "PR",
        }
    }
}

/// An issue or pull request, as the forge that has it names it. Only a
/// [`crate::forge::Forge`] makes one from text, since what such a URL
/// looks like is the forge's to say; here it is data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContentRef {
    /// Its web URL in the forge's one canonical form, which is what
    /// messages and action keys show and what [`ContentRef::key`] is
    /// made of.
    pub url: String,
    /// The repository it is in, as the forge writes one (`OWNER/REPO`).
    pub repo: String,
    pub kind: ContentKind,
    pub number: u64,
}

impl ContentRef {
    /// Its identity. Forges ignore the case of an owner's and a
    /// repository's name, and people type both, so this does too.
    pub fn key(&self) -> String {
        self.url.to_ascii_lowercase()
    }
}

impl fmt::Display for ContentRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.url)
    }
}

/// Where an issue or PR stands. `Gone` is one the forge no longer shows.
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
    pub of: ContentRef,
    pub state: ContentState,
}

/// One board item, with the fields the rules read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Item {
    /// Its id on the board, as the forge gives it.
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
    pub branch: Vec<ContentRef>,
}

impl Item {
    /// The issue or PR it is of.
    pub fn content_ref(&self) -> Option<&ContentRef> {
        self.content.as_ref().map(|c| &c.of)
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
    /// The board's web URL.
    pub board: String,
    pub items: Vec<Item>,
    /// The state of Branch PRs that are not items themselves, by
    /// [`ContentRef::key`]. One that could not be read is absent, and a
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
            .map(|c| (c.of.key(), c.state));
        self.linked.clone().into_iter().chain(own).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
