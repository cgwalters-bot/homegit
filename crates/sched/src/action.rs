//! What the rules ask for: an [`Action`] says what to do about one
//! item, and its [`Write`], if it has one, is the change to make with no
//! judgment needed. Writes are never made here, and how one is carried
//! out is the forge's: each [`crate::forge`] module turns them into
//! what its own appliers take, in a job that holds the token, so the
//! pass that decides needs read access only.

use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};

use crate::model::ContentRef;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    ClosedNotDone,
    StaleLead,
}

impl Kind {
    /// Its name, which is also its rule's and the start of its keys.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ClosedNotDone => "closed-not-done",
            Self::StaleLead => "stale-lead",
        }
    }
}

impl fmt::Display for Kind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A change to the forge that an action can be carried out by.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case")]
pub enum Write {
    /// Set board fields of an item, by field name.
    SetFields { fields: BTreeMap<String, String> },
    /// Empty a board field of an item.
    ClearField { field: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Action {
    /// Stable across passes: the same gap has the same key.
    pub key: String,
    pub kind: Kind,
    /// The board item it is about, by its id.
    pub item: String,
    /// That item's issue or PR; None for a draft item.
    pub content: Option<ContentRef>,
    /// What to do, for a reader.
    #[serde(rename = "do")]
    pub todo: String,
    /// None: it takes judgment, so someone must read it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub write: Option<Write>,
}

impl Action {
    /// `* KIND URL: what to do`, the line a report lists it as; a draft
    /// item is named by its id.
    pub fn line(&self) -> String {
        let target = self
            .content
            .as_ref()
            .map_or(self.item.clone(), ToString::to_string);
        format!("* {} {target}: {}", self.kind, self.todo)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_serialize_as_their_names() {
        for kind in [Kind::ClosedNotDone, Kind::StaleLead] {
            assert_eq!(serde_json::to_value(kind).unwrap(), kind.as_str());
        }
    }
}
