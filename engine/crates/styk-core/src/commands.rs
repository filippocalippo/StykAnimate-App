//! Every user action is a [`Command`]; [`crate::app::Core::dispatch`] runs it and answers with [`Effect`]s.
//!
//! This is the one command type and the one registry. [`CommandId::info`] holds the metadata of every command in
//! `docs/native/INVENTORY.md` appendix A: its label, handler owner, shortcuts, gates and history. `Core` only routes:
//! a handler lives with its feature ([`crate::history`],
//! [`crate::selection_actions`], [`crate::camera_actions`], the view state), never in `Core`. A command whose
//! feature has no handler yet answers [`Effect::NotAvailable`], typed, so nothing pretends to have run.

mod metadata;
pub use metadata::{Availability, CommandId, Disabled, Gates, History, Info, Mode, Owner, Polygon, Requirement};

// Engine-dependent command payloads and effects are separate from the registry metadata.
mod execution;
pub use execution::*;
