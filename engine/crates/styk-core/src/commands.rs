//! Every user action is a [`Command`]; [`crate::app::Core::dispatch`] runs it and answers with [`Effect`]s.
//!
//! This is the one command type and the one registry. [`CommandId::info`] holds each command's metadata (its label and
//! the module that owns its handler); chunk K-cmd adds every command of `docs/native/INVENTORY.md` appendix A here with
//! its shortcut and enabled state. `Core` only routes: a handler lives with its feature ([`crate::history`],
//! [`crate::selection_actions`], [`crate::camera_actions`], the view state), never in `Core`. A command whose
//! feature has no handler yet answers [`Effect::NotAvailable`], typed, so nothing pretends to have run.

use crate::answers::Session;
use crate::documents::Documents;
use crate::engine::EditError;
use crate::i18n::{Arg, Msg};
use crate::inspector;
use crate::view_state::ViewState;

/// A registry command by its identity (appendix A's `id`). The Inspector's buttons and quick actions name these.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum CommandId {
    Undo,
    Redo,
    Rotate,
    Center,
    ResetColor,
    LayerUp,
    LayerDown,
    JoinFigure,
    CombineFigures,
    EditText,
    AlignLeft,
    AlignCenterX,
    AlignRight,
    AlignTop,
    AlignCenterY,
    AlignBottom,
    ImportBackground,
    BackgroundStyle,
    CameraGuides,
    CameraCopy,
    CameraPaste,
    CameraAlignView,
    CameraCenterX,
    CameraCenterY,
    CameraLocatePrevious,
    CameraLocateNext,
    CameraApplyFigures,
    AddFrame,
    ToggleRangeEdit,
}

/// The module whose handler runs a command.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Owner {
    History,
    Selection,
    Camera,
    ViewState,
    /// Its feature belongs to a later chunk.
    NotYet,
}

/// A command's registry entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Info {
    pub id: CommandId,
    /// The label's message key (today's registry label).
    pub label: &'static str,
    pub owner: Owner,
}

/// What a handler is given: the documents, the view state and the dispatch's record of what the session reported.
pub struct Context<'a> {
    pub documents: &'a mut Documents,
    pub view: &'a mut ViewState,
    pub session: &'a mut Session,
}

impl CommandId {
    /// The command's registry entry.
    pub fn info(self) -> Info {
        use CommandId as C;
        let (label, owner) = match self {
            C::Undo => ("common.undo", Owner::History),
            C::Redo => ("common.redo", Owner::History),
            C::Rotate => ("inspectorView.rotate15", Owner::Selection),
            C::ResetColor => ("inspectorView.resetColors", Owner::Selection),
            C::LayerUp => ("inspectorView.bringForward", Owner::Selection),
            C::LayerDown => ("inspectorView.sendBackward", Owner::Selection),
            C::AlignLeft => ("inspectorView.alignLeft", Owner::Selection),
            C::AlignCenterX => ("inspectorView.alignCenter", Owner::Selection),
            C::AlignRight => ("inspectorView.alignRight", Owner::Selection),
            C::AlignTop => ("inspectorView.alignTop", Owner::Selection),
            C::AlignCenterY => ("inspectorView.alignMiddle", Owner::Selection),
            C::AlignBottom => ("inspectorView.alignBottom", Owner::Selection),
            C::CameraCopy => ("inspectorView.copyCameraPose", Owner::Camera),
            C::CameraPaste => ("inspectorView.pasteCameraPose", Owner::Camera),
            C::ToggleRangeEdit => ("inspectorView.stop", Owner::ViewState),
            C::Center => ("inspectorView.center", Owner::NotYet),
            C::JoinFigure => ("inspectorView.joinToFigure", Owner::NotYet),
            C::CombineFigures => ("inspectorView.combineConnected", Owner::NotYet),
            C::EditText => ("inspectorView.editText", Owner::NotYet),
            C::ImportBackground => ("inspectorView.importBackground", Owner::NotYet),
            C::BackgroundStyle => ("inspectorView.backgroundSettings", Owner::NotYet),
            C::CameraGuides => ("inspectorView.guides", Owner::NotYet),
            C::CameraAlignView => ("inspectorView.fitView", Owner::NotYet),
            C::CameraCenterX => ("inspectorView.centerCameraHorizontally", Owner::NotYet),
            C::CameraCenterY => ("inspectorView.centerCameraVertically", Owner::NotYet),
            C::CameraLocatePrevious => ("inspectorView.matchPreviousCameraPose", Owner::NotYet),
            C::CameraLocateNext => ("inspectorView.matchNextCameraPose", Owner::NotYet),
            C::CameraApplyFigures => ("inspectorView.applyCameraTransformToFigures", Owner::NotYet),
            C::AddFrame => ("inspectorView.insertKeyframeF6", Owner::NotYet),
        };
        Info { id: self, label, owner }
    }

    /// The identity today's registry gives it.
    pub fn id(self) -> &'static str {
        match self {
            CommandId::Undo => "undo",
            CommandId::Redo => "redo",
            CommandId::Rotate => "rotate",
            CommandId::Center => "center",
            CommandId::ResetColor => "reset-color",
            CommandId::LayerUp => "layer-up",
            CommandId::LayerDown => "layer-down",
            CommandId::JoinFigure => "join-figure",
            CommandId::CombineFigures => "combine-figures",
            CommandId::EditText => "edit-text",
            CommandId::AlignLeft => "align-left",
            CommandId::AlignCenterX => "align-center-x",
            CommandId::AlignRight => "align-right",
            CommandId::AlignTop => "align-top",
            CommandId::AlignCenterY => "align-center-y",
            CommandId::AlignBottom => "align-bottom",
            CommandId::ImportBackground => "import-background",
            CommandId::BackgroundStyle => "background-style",
            CommandId::CameraGuides => "camera-guides",
            CommandId::CameraCopy => "camera-copy",
            CommandId::CameraPaste => "camera-paste",
            CommandId::CameraAlignView => "camera-align-view",
            CommandId::CameraCenterX => "camera-center-x",
            CommandId::CameraCenterY => "camera-center-y",
            CommandId::CameraLocatePrevious => "camera-locate-previous",
            CommandId::CameraLocateNext => "camera-locate-next",
            CommandId::CameraApplyFigures => "camera-apply-figures",
            CommandId::AddFrame => "add-frame",
            CommandId::ToggleRangeEdit => "toggle-range-edit",
        }
    }
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
    /// The stage: pointer, wheel, key, pen and frame demands for the active document's stage (`docs/native/stage.md`).
    Stage(crate::stage::Event),
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
