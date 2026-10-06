//! Observing: one read of the forge into a [`Snapshot`].
//!
//! The board's items come with the state of their own issue or PR. Only
//! what they lack is asked for: the Branch PRs of items whose own issue
//! or PR has ended.

use std::collections::{BTreeMap, BTreeSet};

use anyhow::{Result, bail};

use crate::forge::{BoardItem, Forge};
use crate::model::{
    ContentRef, FIELD_BRANCH, FIELD_LEAD, FIELD_PRIORITY, FIELD_RUN, FIELD_STATUS, Item,
    SNAPSHOT_SCHEMA, Snapshot, Status,
};

/// The board fields the snapshot holds: only these are asked for.
const FIELDS: [&str; 5] = [
    FIELD_STATUS,
    FIELD_PRIORITY,
    FIELD_LEAD,
    FIELD_RUN,
    FIELD_BRANCH,
];
/// Without these the snapshot would say every item is untriaged.
const REQUIRED_FIELDS: [&str; 1] = [FIELD_STATUS];

/// What a pass observed, and what it could not read: a problem leaves
/// its part of the snapshot unknown, it never stands for a state.
#[derive(Debug)]
pub struct Observed {
    pub snapshot: Snapshot,
    pub problems: Vec<String>,
}

/// A board item as the rules read it. What its Branch field names that
/// is no issue or PR of this forge is dropped.
fn item_of(forge: &dyn Forge, raw: BoardItem) -> Item {
    let mut fields = raw.fields;
    let branch = fields.remove(FIELD_BRANCH).unwrap_or_default();
    Item {
        id: raw.id,
        content: raw.content,
        status: fields.remove(FIELD_STATUS).map(Status::from),
        priority: fields.remove(FIELD_PRIORITY),
        lead: fields.remove(FIELD_LEAD),
        run: fields.remove(FIELD_RUN),
        branch: branch
            .split_whitespace()
            .filter_map(|text| forge.content_ref(text))
            .collect(),
    }
}

/// Reads the forge's board into a snapshot.
pub fn observe(forge: &dyn Forge) -> Result<Observed> {
    let has = forge.board_fields()?;
    if let Some(missing) = REQUIRED_FIELDS
        .iter()
        .find(|name| has.iter().all(|f| f != **name))
    {
        bail!(
            "the board {} has no '{missing}' field: its layout changed",
            forge.board_url()
        );
    }
    let items: Vec<Item> = forge
        .board_items(&FIELDS)?
        .into_iter()
        .map(|raw| item_of(forge, raw))
        .collect();

    let own: BTreeSet<String> = items
        .iter()
        .filter_map(Item::content_ref)
        .map(ContentRef::key)
        .collect();
    let ended = |it: &&Item| {
        it.status != Some(Status::Done) && it.content.as_ref().is_some_and(|c| c.state.ended())
    };
    let wanted: BTreeMap<String, &ContentRef> = items
        .iter()
        .filter(ended)
        .flat_map(|it| &it.branch)
        .map(|content| (content.key(), content))
        .filter(|(key, _)| !own.contains(key))
        .collect();
    let mut linked = BTreeMap::new();
    let mut problems = Vec::new();
    for (key, content) in wanted {
        match forge.content_state(content) {
            Ok(state) => {
                linked.insert(key, state);
            }
            Err(e) => problems.push(format!("the state of {content}: {e:#}")),
        }
    }
    let snapshot = Snapshot {
        schema: SNAPSHOT_SCHEMA.to_owned(),
        board: forge.board_url(),
        items,
        linked,
    };
    Ok(Observed { snapshot, problems })
}
