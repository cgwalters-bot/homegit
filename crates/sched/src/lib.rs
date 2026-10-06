//! The scheduler: the Rust rewrite of the controller, one piece at a
//! time (see "The read-only report" in homegit's
//! docs/scheduled-dispatcher.md for what runs it today).
//!
//! A pass is three steps, each with its own module: [`observe`] reads
//! the forge once into a typed [`model::Snapshot`]; [`rules`] are pure
//! functions from a snapshot to [`action::Action`]s; and
//! [`action::emit`] turns the actions' writes into gh-aw safe outputs
//! for a later job to apply. Nothing here writes to the forge.

pub mod action;
pub mod forge;
pub mod model;
pub mod observe;
pub mod operator;
pub mod parity;
pub mod report;
pub mod rules;
pub mod tool;
