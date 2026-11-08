//! Every user action is a [`Command`]; [`crate::app::Core::dispatch`] runs it and answers with [`Effect`]s.
//!
//! This is the one command type and the one registry. [`CommandId::info`] holds the metadata of every command in
//! `docs/native/INVENTORY.md` appendix A: its label, handler owner, shortcuts, gates and history. `Core` only routes:
//! a handler lives with its feature ([`crate::history`],
//! [`crate::selection_actions`], [`crate::camera_actions`], the view state), never in `Core`. A command whose
//! feature has no handler yet answers [`Effect::NotAvailable`], typed, so nothing pretends to have run.

mod metadata;
pub use metadata::{Availability, CommandId, Disabled, Gates, History, Info, Mode, Owner, Polygon, Requirement};

// Execution context and refusal translation require the engine; messages below are plain data.
#[cfg(feature = "engine")]
mod execution;
#[cfg(feature = "engine")]
pub use execution::*;

use crate::{i18n::Msg, inspector};

/// What the interface asks the core to do.
#[derive(Clone, Debug, PartialEq)]
pub enum Command {
    Overlay { event: crate::overlay::host::Event, now: u64 },
    /// A registry command (a button, a menu item, a shortcut, a quick action, an automation step).
    Run(CommandId),
    /// A Properties panel control: a field's gesture, a switch, a choice, a section's toggle.
    Inspector(inspector::Event),
    /// Make another open document the active one (a project tab).
    Activate(crate::identity::DocumentId),
    /// The stage: pointer, wheel, key, pen and frame demands for the active document's stage (`docs/native/stage.md`).
    Stage(crate::stage::Event),
    /// The docked window: panels, groups, dividers and drags (`styk_core::dock`).
    Dock(crate::dock::Event),
}

/// How a refusal or a failure reaches the person (the error policy: a message key and scalar parameters).
#[derive(Clone, Debug, PartialEq)]
pub struct Notice {
    pub message: Msg,
    pub severity: Severity,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Severity {
    /// A person's mistake or a refused edit: a timed warning.
    Warning,
    /// A failed save, export or import: it stays until dismissed.
    Error,
}

/// What the core asks the interface to do after a command: the interface turns each into an iced task (or a view-only
/// change). Effects carry plain data, never a borrowed document.
#[derive(Clone, Debug, PartialEq)]
pub enum Effect {
    Overlay(crate::overlay::Effect),
    OverlayChoice { invoker: crate::focus::FocusId, index: usize },
    MessageDismissed(u64),
    ShortcutReleased(crate::shortcuts::Release),
    /// Show a message (`toast`/the message slot).
    Notice(Notice),
    /// The command exists but its feature belongs to a later chunk.
    NotAvailable(CommandId),
    /// The document changed: the stage needs a frame for its new revision.
    RequestFrame,
    /// Open the colour picker for a colour row (the picker is a later chunk).
    PickColor(inspector::model::ColorTarget),
    /// Show the one-time scrub hint in the message slot.
    ScrubHint(Msg),
    /// Take focus from the field that finished (Enter commits and blurs).
    Blur,
    /// Move focus where a panel asks (the rename field as it opens, the name as it closes).
    Focus(inspector::FocusRequest),
    /// Move focus to this target (a tab the dock activated, the group a closing flyout returns to).
    FocusTarget(crate::focus::FocusId),
}
