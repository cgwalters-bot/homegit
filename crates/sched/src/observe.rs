//! Observing: one read of the forge into a [`Snapshot`].
//!
//! The board's REST listing carries the issue or PR of every item whole,
//! so its state comes with the listing and needs no request of its own.
//! Only what the listing lacks is asked for: the Branch PRs of items
//! whose own issue or PR has ended.

use std::collections::{BTreeMap, BTreeSet};

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use serde_json::Value;

use crate::forge::Forge;
use crate::model::{
    BoardRef, Content, ContentState, ContentUrl, FIELD_BRANCH, FIELD_LEAD, FIELD_PRIORITY,
    FIELD_RUN, FIELD_STATUS, Item, SNAPSHOT_SCHEMA, Snapshot, Status,
};

const PER_PAGE: usize = 100;
/// The board fields the snapshot holds. Only these are asked for, which
/// keeps the listing small.
const FIELDS: [&str; 5] = [
    FIELD_STATUS,
    FIELD_PRIORITY,
    FIELD_LEAD,
    FIELD_RUN,
    FIELD_BRANCH,
];
/// Without these the snapshot would say every item is untriaged.
const REQUIRED_FIELDS: [&str; 1] = [FIELD_STATUS];

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

/// What a pass observed, and what it could not read: a problem leaves
/// its part of the snapshot unknown, it never stands for a state.
#[derive(Debug)]
pub struct Observed {
    pub snapshot: Snapshot,
    pub problems: Vec<String>,
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

fn item_of(raw: RawItem) -> Result<Item> {
    let mut values: BTreeMap<String, String> = raw
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
            let url = ContentUrl::parse(&url)
                .with_context(|| format!("{url} is not an issue or pull request URL"))?;
            Some(Content { url, state })
        }
        _ => None,
    };
    let branch = values.remove(FIELD_BRANCH).unwrap_or_default();
    Ok(Item {
        id: raw.node_id,
        content,
        status: values.remove(FIELD_STATUS).map(Status::from),
        priority: values.remove(FIELD_PRIORITY),
        lead: values.remove(FIELD_LEAD),
        run: values.remove(FIELD_RUN),
        branch: branch
            .split_whitespace()
            .filter_map(ContentUrl::parse)
            .collect(),
    })
}

/// The ids of [`FIELDS`] on this board, for the listing's `fields=`.
fn field_ids(forge: &dyn Forge, board: &BoardRef) -> Result<String> {
    let path = format!("{}/fields?per_page={PER_PAGE}", board.api_path());
    let fields: Vec<RawField> = serde_json::from_value(Value::Array(forge.list(&path)?))
        .context("the board's fields are not what the REST API documents")?;
    if let Some(missing) = REQUIRED_FIELDS
        .iter()
        .find(|name| fields.iter().all(|f| f.name != **name))
    {
        bail!(
            "the board {} has no '{missing}' field: its layout changed",
            board.url()
        );
    }
    let ids: Vec<String> = fields
        .iter()
        .filter(|f| FIELDS.contains(&f.name.as_str()))
        .map(|f| f.id.to_string())
        .collect();
    Ok(ids.join(","))
}

/// The state of one issue or PR, asked for by itself.
fn linked_state(forge: &dyn Forge, url: &ContentUrl) -> Result<ContentState> {
    let Some(issue) = forge.get(&url.issue_api_path())? else {
        return Ok(ContentState::Gone);
    };
    let issue: RawIssue = serde_json::from_value(issue)?;
    let merged = issue.pull_request.is_some_and(|p| p.merged_at.is_some());
    state_of(&issue.state, merged)
}

/// Reads the board into a snapshot.
pub fn observe(forge: &dyn Forge, board: &BoardRef) -> Result<Observed> {
    let ids = field_ids(forge, board)?;
    let path = format!(
        "{}/items?per_page={PER_PAGE}&fields={ids}",
        board.api_path()
    );
    let items = forge
        .list(&path)?
        .into_iter()
        .map(|raw| item_of(serde_json::from_value(raw)?))
        .collect::<Result<Vec<Item>>>()
        .context("a board item is not what the REST API documents")?;

    let own: BTreeSet<String> = items
        .iter()
        .filter_map(Item::url)
        .map(ContentUrl::key)
        .collect();
    let ended = |it: &&Item| {
        it.status != Some(Status::Done) && it.content.as_ref().is_some_and(|c| c.state.ended())
    };
    let wanted: BTreeMap<String, &ContentUrl> = items
        .iter()
        .filter(ended)
        .flat_map(|it| &it.branch)
        .map(|url| (url.key(), url))
        .filter(|(key, _)| !own.contains(key))
        .collect();
    let mut linked = BTreeMap::new();
    let mut problems = Vec::new();
    for (key, url) in wanted {
        match linked_state(forge, url) {
            Ok(state) => {
                linked.insert(key, state);
            }
            Err(e) => problems.push(format!("the state of {url}: {e:#}")),
        }
    }
    let snapshot = Snapshot {
        schema: SNAPSHOT_SCHEMA.to_owned(),
        board: board.clone(),
        items,
        linked,
    };
    Ok(Observed { snapshot, problems })
}
