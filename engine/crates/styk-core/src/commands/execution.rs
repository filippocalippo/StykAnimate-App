//! Engine-dependent command payloads, dispatch context and effects. Metadata lives in the sibling module.

use crate::answers::Session;
use crate::documents::Documents;
use crate::engine::EditError;
use crate::i18n::{Arg, Msg};
use crate::inspector;
use crate::view_state::ViewState;
use super::CommandId;

/// What a handler is given: the documents, the view state and the dispatch's record of what the session reported.
pub struct Context<'a> {
    pub documents: &'a mut Documents,
    pub view: &'a mut ViewState,
    pub session: &'a mut Session,
}

/// What the interface asks the core to do.
#[derive(Clone, Debug, PartialEq)]
pub enum Command {
    /// A registry command (a button, a menu item, a shortcut, a quick action, an automation step).
    Run(CommandId),
    /// A Properties panel control: a field's gesture, a switch, a choice, a section's toggle.
    Inspector(inspector::Event),
    /// Make another open document the active one (a project tab).
    Activate(crate::documents::DocumentId),
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
}

/// A refusal of the session as a message (`messageError`): the key, and the values its message names.
pub fn refusal(error: &EditError) -> Msg {
    match error {
        EditError::Invalid(text) => {
            let (key, params) = text.split_once('\u{1f}').unwrap_or((text.as_str(), ""));
            let mut msg = Msg::owned(key.to_owned());
            if let Ok(styk_doc::Value::Obj(object)) = styk_doc::json::parse(params.as_bytes()) {
                for (name, value) in object.iter() {
                    let arg = match value {
                        styk_doc::Value::Num(number) => Arg::Num(*number),
                        other => Arg::Text(other.as_str().map_or_else(|| styk_doc::json::to_string(other), str::to_owned).into()),
                    };
                    msg = msg.with(name.to_string(), arg);
                }
            }
            msg
        }
        EditError::Unported(_) => Msg::new("errors.engineOwner.notSupported"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refusal_keeps_its_key_and_parameters() {
        let refused = refusal(&EditError::Invalid("errors.nativePropertyEdit.enterAValueFromTo\u{1f}{\"min\":1,\"max\":1000}".into()));
        assert_eq!(refused.key, "errors.nativePropertyEdit.enterAValueFromTo");
        assert_eq!(crate::i18n::english(&refused), crate::i18n::english(&Msg::new("errors.nativePropertyEdit.enterAValueFromTo").with("min", 1.0).with("max", 1000.0)));
        assert_eq!(refusal(&EditError::Unported("x".into())).key, "errors.engineOwner.notSupported");
    }
}
