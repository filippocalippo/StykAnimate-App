//! The application core's state and its one entry point, [`Core::dispatch`].
//!
//! `Core` owns the open documents (each one's session owns the document, its selection, playhead and history), the
//! window's view state and the panels' state. The interface calls `dispatch` with a [`Command`] and gets [`Effect`]s
//! back; after every dispatch it calls [`Core::refresh`], which rebuilds the view models whose inputs changed, and its
//! `view` reads them. Nothing here blocks: every call is a session command on the interface thread, as today's are.

use styk_doc::{Obj, Value};

use crate::commands::{Command, CommandId, Effect, Notice, Severity, refusal};
use crate::documents::{CallAnswer, DocumentId, Documents};
use crate::i18n::Msg;
use crate::inspector::Panel;
use crate::view_state::ViewState;

#[derive(Default)]
pub struct Core {
    pub documents: Documents,
    view: ViewState,
    inspector: Panel,
}

fn object(pairs: &[(&str, Value)]) -> Value {
    let mut obj = Obj::new();
    for (key, value) in pairs {
        obj.set(key, value.clone());
    }
    Value::object(obj)
}

fn warn(message: Msg) -> Effect {
    Effect::Notice(Notice { message, severity: Severity::Warning })
}

impl Core {
    pub fn new(documents: Documents) -> Core {
        Core { documents, ..Core::default() }
    }

    pub fn view_state(&self) -> &ViewState {
        &self.view
    }

    /// The view state, for the panels that set it (the timeline's frame range, the workspace tab).
    pub fn view_state_mut(&mut self) -> &mut ViewState {
        &mut self.view
    }

    pub fn inspector(&self) -> &Panel {
        &self.inspector
    }

    /// Rebuilds the view models whose inputs changed since the last call.
    pub fn refresh(&mut self) {
        self.inspector.refresh(&self.documents, &self.view);
    }

    /// Runs one command.
    pub fn dispatch(&mut self, command: Command) -> Vec<Effect> {
        match command {
            Command::Inspector(event) => self.inspector.update(&mut self.documents, &mut self.view, event),
            Command::Run(id) => self.run(id),
        }
    }

    fn active(&self) -> Option<DocumentId> {
        self.documents.active().map(|document| document.id())
    }

    fn call(&mut self, method: &str, args: &[Value]) -> Result<CallAnswer, Msg> {
        let id = self.active().ok_or_else(|| Msg::new("errors.editorSessions.thisProjectIsNoLongerOpen"))?;
        let answer = self.documents.call(id, method, args, &Value::Null).map_err(|error| Msg::owned(error.message_key().to_owned()))?;
        match &answer.result {
            Ok(_) => Ok(answer),
            Err(error) => Err(refusal(error)),
        }
    }

    /// `rangeFrames()` as the session takes it: the chosen frame indices, and the options naming the ticks they start
    /// at (a layer sheet's `sheetTicks`).
    fn range(&self) -> Option<(Value, Value)> {
        let id = self.active()?;
        let reach = Panel::reach(&self.documents, id, &self.view);
        let indices = reach.indices?;
        let ticks = Value::array(reach.ticks.unwrap_or_default().into_iter().map(Value::Num).collect());
        Some((Value::array(indices.into_iter().map(|index| Value::Num(index as f64)).collect()), object(&[("ticks", ticks)])))
    }

    fn run(&mut self, id: CommandId) -> Vec<Effect> {
        let mut effects = Vec::new();
        // An open property edit is committed before any command, as today's `finishCurrentEdit`.
        self.inspector.finish(&mut self.documents, &mut effects);
        let range = self.range();
        let result = match id {
            CommandId::Undo => self.history(true),
            CommandId::Redo => self.history(false),
            CommandId::Rotate => match &range {
                Some((frames, options)) => self.call("rotateFiguresInFrames", &[Value::Num(std::f64::consts::PI / 12.0), frames.clone(), options.clone()]),
                None => self.call("rotateFigure", &[Value::Num(std::f64::consts::PI / 12.0)]),
            },
            CommandId::ResetColor => self.call("resetFigureColors", &[object(&[("indices", range.as_ref().map_or(Value::Null, |(frames, _)| frames.clone()))])]),
            CommandId::LayerUp | CommandId::LayerDown => {
                let step = Value::Num(if id == CommandId::LayerUp { 1.0 } else { -1.0 });
                match &range {
                    Some((frames, options)) => self.call("orderFiguresInFrames", &[step, frames.clone(), options.clone()]),
                    None => self.call("moveSelectionLayer", &[step]),
                }
            }
            CommandId::AlignLeft | CommandId::AlignCenterX | CommandId::AlignRight | CommandId::AlignTop | CommandId::AlignCenterY | CommandId::AlignBottom => {
                let (axis, edge) = match id {
                    CommandId::AlignLeft => ("x", "start"),
                    CommandId::AlignCenterX => ("x", "center"),
                    CommandId::AlignRight => ("x", "end"),
                    CommandId::AlignTop => ("y", "start"),
                    CommandId::AlignCenterY => ("y", "center"),
                    _ => ("y", "end"),
                };
                // The app's own bounds callback (`boundsOf`), measured by the session from its geometry.
                let options = object(&[("boundsOf", object(&[("@boundsCallback", Value::str("app"))]))]);
                self.call("alignSelection", &[Value::str(axis), Value::str(edge), options])
            }
            CommandId::CameraCopy => self.call("copyCamera", &[]).inspect(|answer| {
                let pose = answer.clipboard.as_ref().map(|(_, pose)| pose.clone()).or_else(|| answer.result.as_ref().ok().filter(|value| value.is_object()).cloned());
                if pose.is_some() {
                    self.inspector.set_camera_clipboard(pose);
                }
            }),
            CommandId::CameraPaste => match self.inspector.camera_clipboard().cloned() {
                Some(pose) => self.call("pasteCamera", &[pose]),
                None => return effects,
            },
            CommandId::ToggleRangeEdit => {
                let on = !self.view.apply_range();
                self.view.set_apply_range(on);
                return effects;
            }
            other => {
                effects.push(Effect::NotAvailable(other));
                return effects;
            }
        };
        match result {
            Ok(_) => effects.push(Effect::RequestFrame),
            Err(message) => effects.push(warn(message)),
        }
        effects
    }

    fn history(&mut self, undo: bool) -> Result<CallAnswer, Msg> {
        let id = self.active().ok_or_else(|| Msg::new("errors.editorSessions.thisProjectIsNoLongerOpen"))?;
        let answer = if undo { self.documents.undo(id) } else { self.documents.redo(id) };
        let answer = answer.map_err(|error| Msg::owned(error.message_key().to_owned()))?;
        match &answer.result {
            Ok(_) => Ok(answer),
            Err(error) => Err(refusal(error)),
        }
    }
}

