//! Project settings (src/editor.mjs `setFPS`, `setCanvasSize`, `updateProject`): fields of
//! the document itself, each change one `fields` history entry (`_fields`).

use styk_doc::{Obj, Value};

use crate::history::{Command, CommandKind, Direction};
use crate::{EditError, Editor};

fn invalid(key: &str) -> EditError {
    EditError::Invalid(key.into())
}

fn whole_between(value: Option<&Value>, min: f64, max: f64) -> Option<f64> {
    match value {
        Some(Value::Num(n)) if n.fract() == 0.0 && *n >= min && *n <= max => Some(*n),
        _ => None,
    }
}

/// `Math.round(x)`: halves go up.
fn js_round(x: f64) -> f64 {
    let floor = x.floor();
    if x - floor >= 0.5 { floor + 1.0 } else { floor }
}

impl Editor {
    fn older_format(&self) -> bool {
        self.report.get("version").and_then(Value::as_f64).is_some_and(|v| v < 5.0)
    }

    /// `_fields(label, patch, {timing})`: the document's fields set, unless they already are.
    fn set_fields(&mut self, label: &str, patch: Vec<(&str, Value)>, timing: bool) -> Result<bool, EditError> {
        let before: Vec<(String, Option<Value>)> = patch.iter().map(|(key, _)| (key.to_string(), self.report.get(key).cloned())).collect();
        // `same(before, patch)`: equal as JSON, a missing field left out.
        let json = |pairs: &mut dyn Iterator<Item = (String, Option<Value>)>| {
            let mut object = Obj::new();
            for (key, value) in pairs {
                if let Some(value) = value {
                    object.set(&key, value);
                }
            }
            styk_doc::json::to_string(&Value::object(object))
        };
        if json(&mut before.clone().into_iter()) == json(&mut patch.iter().map(|(k, v)| (k.to_string(), Some(v.clone())))) {
            return Ok(false);
        }
        let report = self.report.make_obj().ok_or_else(|| EditError::Unported("a document that is not an object".into()))?;
        for (key, value) in &patch {
            report.set(key, value.clone());
        }
        let selection = self.selection_state();
        let after = patch.iter().map(|(key, value)| (key.to_string(), value.clone())).collect();
        self.record(Command { kind: CommandKind::Fields { before, after, timing }, label: label.into(), before_selection: selection.clone(), after_selection: selection, before_revision: 0, after_revision: 0, layer_changes: Vec::new(), captured_source_bytes: 0, layers: false })?;
        let fields = Value::array(patch.iter().map(|(key, _)| Value::str(key)).collect());
        self.emit("edit", vec![("label", Value::str(label)), ("timing", Value::Bool(timing)), ("projectFields", fields)]);
        Ok(true)
    }

    /// `_applyCommand` for a `fields` entry.
    pub(crate) fn apply_fields_command(&mut self, command: &Command, direction: Direction) -> Result<(), EditError> {
        let CommandKind::Fields { before, after, timing } = &command.kind else { return Ok(()) };
        if let Some(report) = self.report.make_obj() {
            match direction {
                Direction::Before => {
                    for (key, value) in before {
                        match value {
                            Some(value) => report.set(key, value.clone()),
                            None => {
                                report.remove(key);
                            }
                        }
                    }
                }
                Direction::After => {
                    for (key, value) in after {
                        report.set(key, value.clone());
                    }
                }
            }
        }
        let (selection, revision) = match direction {
            Direction::Before => (&command.before_selection, command.before_revision),
            Direction::After => (&command.after_selection, command.after_revision),
        };
        self.restore_selection(selection)?;
        self.revision = revision;
        self.emit("history", vec![("label", Value::str(&command.label)), ("timing", Value::Bool(*timing)), ("definition", Value::Bool(false)), ("animation", Value::Bool(false))]);
        Ok(())
    }

    /// `setFPS(value)`: frames per second, and the frame delay older formats store.
    pub(crate) fn set_fps(&mut self, value: &Value) -> Result<bool, EditError> {
        let fps = whole_between(Some(value), 1.0, 1000.0).ok_or_else(|| invalid("errors.editor.fpsMustBeAnIntegerBetween1And"))?;
        let mut patch = vec![("fps", Value::Num(fps))];
        if self.older_format() {
            patch.push(("frame_delay_ms", Value::Num(js_round(1000.0 / fps))));
        }
        self.set_fields("Change frame rate", patch, true)
    }

    /// `setCanvasSize(width, height)`.
    pub(crate) fn set_canvas_size(&mut self, width: &Value, height: &Value) -> Result<bool, EditError> {
        let (Some(width), Some(height)) = (whole_between(Some(width), 1.0, 100000.0), whole_between(Some(height), 1.0, 100000.0)) else {
            return Err(invalid("errors.editor.canvasDimensionsMustBe1100000Pixels"));
        };
        self.set_fields("Resize canvas", vec![("canvas_width", Value::Num(width)), ("canvas_height", Value::Num(height))], false)
    }

    /// `updateProject(patch)`: the canvas size and frame rate from the project settings.
    pub(crate) fn update_project(&mut self, patch: &Value) -> Result<bool, EditError> {
        let patch = patch.as_obj().ok_or_else(|| EditError::Unported("project settings that are not an object".into()))?;
        if let Some(key) = patch.keys().find(|key| !["canvas_width", "canvas_height", "fps"].contains(&&***key)) {
            return Err(crate::invalid_with("errors.editor.projectSettingIsNotEditableHere", vec![("key", Value::str(key))]));
        }
        let size = |key: &str| patch.get(key).filter(|v| !v.is_null()).or_else(|| self.report.get(key)).cloned();
        if whole_between(size("canvas_width").as_ref(), 1.0, 100000.0).is_none() || whole_between(size("canvas_height").as_ref(), 1.0, 100000.0).is_none() {
            return Err(invalid("errors.editor.canvasDimensionsMustBe1100000Pixels"));
        }
        if patch.contains("fps") && whole_between(patch.get("fps"), 1.0, 1000.0).is_none() {
            return Err(invalid("errors.editor.fpsMustBeAnIntegerBetween1And"));
        }
        let mut fields: Vec<(&str, Value)> = patch.iter().map(|(key, value)| (&**key, value.clone())).collect();
        let fps = patch.get("fps").and_then(Value::as_f64);
        if let Some(fps) = fps.filter(|_| self.older_format()) {
            fields.push(("frame_delay_ms", Value::Num(js_round(1000.0 / fps))));
        }
        let fields: Vec<(String, Value)> = fields.into_iter().map(|(k, v)| (k.to_string(), v)).collect();
        let borrowed: Vec<(&str, Value)> = fields.iter().map(|(k, v)| (k.as_str(), v.clone())).collect();
        self.set_fields("Project settings", borrowed, fps.is_some())
    }
}
