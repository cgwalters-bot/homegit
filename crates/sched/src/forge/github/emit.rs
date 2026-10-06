//! How a write leaves the scheduler on GitHub: as a gh-aw safe-output
//! item (the `agent_output.json` its handlers apply in a later job that
//! holds the token), so the pass that decides needs read access only.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::{WEB, is_ours};
use crate::action::{Action, Write};
use crate::model::ContentKind;

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
const NOT_OURS: &str = "its issue or PR is not one on github.com, or its repository, kind and number are not its URL's";
const NO_BOARD: &str = "the board is not one on github.com";

/// Turns the actions' writes into safe outputs for the board at
/// `board_url`. An action without a write emits nothing: it is for a
/// reader. Actions may come from a saved snapshot: a board that is not
/// on github.com is refused, and so is a reference that is not what its
/// URL parses to here.
pub fn emit(actions: &[Action], board_url: &str) -> Emitted {
    let mut out = Emitted::default();
    for action in actions {
        let Some(write) = &action.write else { continue };
        match (write, &action.content) {
            _ if !board_url.starts_with(WEB) => {
                out.unsupported
                    .push((action.key.clone(), NO_BOARD.to_owned()));
            }
            (Write::SetFields { .. }, Some(content)) if !is_ours(content) => {
                out.unsupported
                    .push((action.key.clone(), NOT_OURS.to_owned()));
            }
            (Write::SetFields { fields }, Some(content)) => {
                out.output.items.push(SafeOutput::UpdateProject {
                    project: board_url.to_owned(),
                    content_type: match content.kind {
                        ContentKind::Issue => "issue",
                        ContentKind::PullRequest => "pull_request",
                    }
                    .to_owned(),
                    content_number: content.number,
                    target_repo: content.repo.clone(),
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
    use super::super::parse_content_ref;
    use super::*;
    use crate::action::Kind;
    use crate::model::ContentRef;

    const BOARD: &str = "https://github.com/orgs/o/projects/1";

    fn set_done(key: &str, content: Option<ContentRef>) -> Action {
        Action {
            key: key.to_owned(),
            kind: Kind::ClosedNotDone,
            item: "PVTI_1".to_owned(),
            content,
            todo: String::new(),
            write: Some(Write::SetFields {
                fields: BTreeMap::from([("Status".to_owned(), "Done".to_owned())]),
            }),
        }
    }

    #[test]
    fn only_what_is_githubs_is_emitted() {
        let ours = parse_content_ref("https://github.com/o/r/pull/7").unwrap();
        let elsewhere = ContentRef {
            url: "https://forge.example/o/r/pull/7".to_owned(),
            ..ours.clone()
        };
        let retargeted = ContentRef {
            repo: "o/other".to_owned(),
            ..ours.clone()
        };
        let actions = [
            set_done("ours", Some(ours)),
            set_done("elsewhere", Some(elsewhere)),
            set_done("retargeted", Some(retargeted)),
            set_done("draft", None),
        ];
        let emitted = emit(&actions, BOARD);
        assert_eq!(
            emitted.output.items,
            [SafeOutput::UpdateProject {
                project: BOARD.to_owned(),
                content_type: "pull_request".to_owned(),
                content_number: 7,
                target_repo: "o/r".to_owned(),
                fields: BTreeMap::from([("Status".to_owned(), "Done".to_owned())]),
            }]
        );
        let unsupported: Vec<_> = emitted
            .unsupported
            .iter()
            .map(|(key, why)| (key.as_str(), why.as_str()))
            .collect();
        assert_eq!(
            unsupported,
            [
                ("elsewhere", NOT_OURS),
                ("retargeted", NOT_OURS),
                ("draft", NO_DRAFT)
            ]
        );

        let elsewhere = emit(&actions[..1], "https://forge.example/boards/1");
        assert_eq!(elsewhere.output.items, []);
        assert_eq!(
            elsewhere.unsupported,
            [("ours".to_owned(), NO_BOARD.to_owned())]
        );
    }
}
