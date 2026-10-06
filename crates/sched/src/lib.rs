//! The scheduler: the Rust rewrite of the controller, one piece at a
//! time (see "The read-only report" in homegit's
//! docs/scheduled-dispatcher.md for what runs it today).
//!
//! A pass is three steps: [`observe`] reads the forge once into a typed
//! [`model::Snapshot`]; [`rules`] are pure functions from a snapshot to
//! [`action::Action`]s; and the forge's own module turns the actions'
//! writes into what its appliers take ([`forge::github::emit()`]: gh-aw
//! safe outputs), for a later job to apply. Nothing here writes to the
//! forge.
//!
//! [`model`], [`rules`], [`observe`] and [`action`] name no forge: what
//! is GitHub's is behind [`forge::Forge`], in [`forge::github`]
//! (tests/neutral.rs holds them to it).

pub mod action;
pub mod forge;
pub mod model;
pub mod observe;
pub mod operator;
pub mod parity;
pub mod report;
pub mod rules;
pub mod tool;
