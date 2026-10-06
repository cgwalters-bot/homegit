//! The forge: where the operator, the coordinator and the agents meet.
//! [`Forge`] is what the scheduler asks of one, in the model's own
//! types, so that the snapshot and the rules name no forge. Each forge
//! is a module below that implements it and keeps its API, its URLs
//! and its way of carrying out a write to itself; [`github`] is the
//! only one so far (homegit's docs/scheduled-dispatcher.md has the
//! design, and what the other forges map to).
//!
//! Only reading is behind the trait yet. How a write leaves is each
//! forge module's own function, called by name from the command line
//! and the report.

use std::collections::BTreeMap;

use anyhow::Result;

use crate::model::{Content, ContentRef, ContentState};

pub mod github;

/// One item of the board as the forge has it: which fields mean what is
/// the scheduler's to say, not the forge's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoardItem {
    /// Its id on the board, as the forge gives it.
    pub id: String,
    /// The issue or pull request it is of, and where that stands; None
    /// for an item that is of neither (a draft).
    pub content: Option<Content>,
    /// The text of its fields that have a value, by field name: a
    /// choice's name, a text field's text.
    pub fields: BTreeMap<String, String>,
}

/// Read access to one forge and the board on it.
pub trait Forge {
    /// The board's web URL: what a snapshot knows it by.
    fn board_url(&self) -> String;

    /// The names of the board's fields.
    fn board_fields(&self) -> Result<Vec<String>>;

    /// Every item of the board, with those of `fields` it has a value
    /// for. An item of an issue or pull request comes with where that
    /// stands, whatever it costs the forge to say.
    fn board_items(&self, fields: &[&str]) -> Result<Vec<BoardItem>>;

    /// The issue or pull request `text` is the URL of on this forge, in
    /// the forge's canonical form; None if it is not one.
    fn content_ref(&self, text: &str) -> Option<ContentRef>;

    /// Where one issue or pull request stands: `Gone` for one the forge
    /// no longer shows, an error for one that could not be read.
    fn content_state(&self, content: &ContentRef) -> Result<ContentState>;
}
