//! What the rules ask for, and how it leaves the scheduler: an
//! [`Action`] says what to do about one item, and its [`Write`], if it
//! has one, is the change to make with no judgment needed. Writes are
//! never made here. They are emitted as gh-aw safe-output items (the
//! `agent_output.json` its handlers apply in a later job that holds the
//! token), so the pass that decides needs read access only.

use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};

use crate::model::{BoardRef, ContentKind, ContentUrl};

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
    /// The board item it is about, by its `PVTI_` id.
    pub item: String,
    /// That item's issue or PR; None for a draft item.
    pub url: Option<ContentUrl>,
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
            .url
            .as_ref()
            .map_or(self.item.clone(), ToString::to_string);
        format!("* {} {target}: {}", self.kind, self.todo)
    }
}

/// One gh-aw safe-output item (`actions/setup/js/safe_outputs_tools.json`
/// in github/gh-aw). Only the types the scheduler emits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SafeOutput {
    UpdateProject {
        project: String,
        content_type: String,
        content_number: u64,
        target_repo: String,
        fields: BTreeMap<String, String>,
    },
}

/// gh-aw's `agent_output.json`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentOutput {
    pub items: Vec<SafeOutput>,
    pub errors: Vec<String>,
}

/// The writes of some actions as safe outputs, and the writes that have
/// no safe-output type: (the action's key, why).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Emitted {
    pub output: AgentOutput,
    pub unsupported: Vec<(String, String)>,
}

const NO_CLEAR: &str =
    "update_project sets values only: clearing a board field has no safe-output type yet";
const NO_DRAFT: &str =
    "the item is a draft, which update_project addresses by a draft id this does not carry yet";

/// Turns the actions' writes into safe outputs. An action without a
/// write emits nothing: it is for a reader.
pub fn emit(actions: &[Action], board: &BoardRef) -> Emitted {
    let mut out = Emitted::default();
    for action in actions {
        let Some(write) = &action.write else { continue };
        match (write, &action.url) {
            (Write::SetFields { fields }, Some(url)) => {
                out.output.items.push(SafeOutput::UpdateProject {
                    project: board.url(),
                    content_type: match url.kind {
                        ContentKind::Issue => "issue",
                        ContentKind::PullRequest => "pull_request",
                    }
                    .to_owned(),
                    content_number: url.number,
                    target_repo: url.repository(),
                    fields: fields.clone(),
                });
            }
            (Write::SetFields { .. }, None) => {
                out.unsupported
                    .push((action.key.clone(), NO_DRAFT.to_owned()));
            }
            (Write::ClearField { .. }, _) => {
                out.unsupported
                    .push((action.key.clone(), NO_CLEAR.to_owned()));
            }
        }
    }
    out
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
