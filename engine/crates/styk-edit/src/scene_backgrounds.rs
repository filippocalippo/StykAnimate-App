//! Scene backgrounds: a background brought into the document and one given
//! a name. Choosing which one a frame shows (`setSceneBackground`, `setSceneColor`) is a property
//! edit (`property_edit.rs`).

use styk_doc::{Obj, Value};

use crate::history::{Command, CommandKind, Direction};
use crate::{EditError, Editor};

/// What a `scene` history entry changed in the background table.
#[derive(Clone, Debug)]
pub enum Change {
    /// A background taken in at its index.
    Added(Value),
    /// Fields of the entry at its index, before (absent ones as none) and after.
    Fields { before: Vec<(String, Option<Value>)>, after: Vec<(String, Value)> },
}

fn invalid(key: &str) -> EditError {
    EditError::Invalid(key.into())
}

/// `Number.isSafeInteger`.
fn safe_integer(value: f64) -> bool {
    value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0
}

impl Editor {
    /// `editable(editor)`: the Scene track must be shown and unlocked, and an open edit ends first.
    fn scene_editable(&mut self) -> Result<(), EditError> {
        let scene = self.report.path(&["_styk", "layers", "fixed", "scene"]);
        if scene.and_then(|s| s.get("locked")).is_some_and(Value::truthy) {
            return Err(invalid("errors.editorScene.unlockTheSceneTrackBeforeEditingItsBackground"));
        }
        if matches!(scene.and_then(|s| s.get("visible")), Some(Value::Bool(false))) {
            return Err(invalid("errors.editorScene.showTheSceneTrackBeforeEditingItsBackground"));
        }
        if self.property_edit.is_some() {
            self.commit_animation_edit()?;
        }
        if self.drag.is_some() {
            self.commit_drag()?;
        }
        Ok(())
    }

    /// `nextBackgroundId(report)`: one past the largest identity in the table.
    fn next_background_id(&self) -> Result<f64, EditError> {
        let backgrounds: Vec<Value> = self.report.get("backgrounds").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
        if backgrounds.len() >= 65534 {
            return Err(invalid("errors.editorScene.theNativePivotBackgroundTableIsFull"));
        }
        let id = backgrounds.iter().fold(0.0f64, |largest, asset| {
            let id = asset.get("background_id").and_then(Value::as_f64).unwrap_or(f64::NAN);
            if largest.is_nan() || id.is_nan() { f64::NAN } else { largest.max(id) }
        });
        if !safe_integer(id + 1.0) {
            return Err(invalid("errors.editorScene.backgroundIdentityCapacityExceeded"));
        }
        Ok(id + 1.0)
    }

    /// `importSceneBackground(background, {indices})`: the background joins the table and the chosen frames show it,
    /// as one history entry. Answers the asset it stored, or nothing when no frame is chosen.
    pub(crate) fn import_scene_background(&mut self, background: &Value, options: &Value) -> Result<Value, EditError> {
        if !self.sheet() {
            return Err(EditError::Unported("importSceneBackground on a native timeline".into()));
        }
        self.scene_editable()?;
        let indices = crate::range::Indices::parse(options.get("indices"));
        if self.frame_indices(indices.as_ref())?.is_empty() {
            return Ok(Value::Null);
        }
        let source = background.get("background").filter(|inner| !inner.is_null()).unwrap_or(background);
        let id = self.next_background_id()?;
        let mut imported = source.as_obj().cloned().unwrap_or_default();
        imported.set("background_id", Value::Num(id));
        if !imported.get("name").is_some_and(Value::truthy) {
            imported.set("name", Value::str("Background"));
        }
        let imported = Value::object(imported);
        crate::load::validate_background(&self.report, &imported)?;
        let mut chosen = Obj::new();
        if let Some(indices) = options.get("indices") {
            chosen.set("indices", indices.clone());
        }
        let chosen = Value::object(chosen);
        self.movieclip_batch("Import scene background", move |editor| {
            editor.add_background(imported.clone(), "Import background asset")?;
            editor.set_scene_background(&Value::Num(id), Some(&chosen))?;
            Ok(editor.report.get("backgrounds").and_then(Value::elements).and_then(|e| e.iter().find(|asset| asset.get("background_id").and_then(Value::as_f64) == Some(id))).unwrap_or(Value::Null))
        })
    }

    /// `renameSceneBackground(id, name)`: whether the name changed.
    pub(crate) fn rename_scene_background(&mut self, id: &Value, name: &Value) -> Result<bool, EditError> {
        let backgrounds: Vec<Value> = self.report.get("backgrounds").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
        let Some(index) = backgrounds.iter().position(|asset| asset.get("background_id") == Some(id) && id.as_f64().is_some()) else {
            return Err(invalid("errors.editorScene.chooseAnExistingBackground"));
        };
        let name = name.text().map(|text| js_trim(&text).to_string()).filter(|text| !text.is_empty() && text.encode_utf16().count() <= 160);
        let Some(name) = name else { return Err(invalid("errors.editorScene.backgroundNamesMustContain1160Characters")) };
        if backgrounds[index].get("name").and_then(Value::as_str) == Some(name.as_str()) {
            return Ok(false);
        }
        if !self.sheet() {
            return Err(EditError::Unported("renameSceneBackground on a native timeline".into()));
        }
        if self.property_edit.is_some() {
            self.commit_animation_edit()?;
        }
        if self.drag.is_some() {
            self.commit_drag()?;
        }
        let previous = backgrounds[index].get("name").cloned();
        let mut asset = backgrounds[index].as_obj().cloned().unwrap_or_default();
        asset.set("name", Value::str(&name));
        self.table_mut()?[index] = Value::object(asset);
        let change = Change::Fields { before: vec![("name".to_string(), previous)], after: vec![("name".to_string(), Value::str(&name))] };
        self.record_scene(index, change, "Rename background")?;
        Ok(true)
    }

    /// The background table (`report.backgrounds ??= []`).
    fn table_mut(&mut self) -> Result<&mut Vec<Value>, EditError> {
        let report = self.report.make_obj().ok_or_else(|| EditError::Unported("a document that is not an object".into()))?;
        if !report.get("backgrounds").is_some_and(|table| !table.is_null()) {
            report.set("backgrounds", Value::array(Vec::new()));
        }
        report.get_mut("backgrounds").and_then(Value::make_arr).ok_or_else(|| EditError::Unported("a background table that is not a list".into()))
    }

    /// A background added at the end of the table, as one history entry that touches no frame.
    fn add_background(&mut self, asset: Value, label: &str) -> Result<(), EditError> {
        let index = self.table_mut()?.len();
        self.table_mut()?.push(asset.clone());
        self.record_scene(index, Change::Added(asset), label)
    }

    fn record_scene(&mut self, index: usize, change: Change, label: &str) -> Result<(), EditError> {
        let selection = self.selection_state();
        self.record(Command { kind: CommandKind::Scene { index, change }, label: label.into(), before_selection: selection.clone(), after_selection: selection, before_revision: 0, after_revision: 0, layer_changes: Vec::new(), captured_source_bytes: 0, layers: false })?;
        self.emit("edit", vec![("label", Value::str(label)), ("scene", Value::Bool(true))]);
        Ok(())
    }

    /// `_applyCommand` for a `scene` entry (`_applySceneSnapshot`).
    pub(crate) fn apply_scene_command(&mut self, command: &Command, direction: Direction) -> Result<(), EditError> {
        let CommandKind::Scene { index, change } = &command.kind else { return Ok(()) };
        let table = self.table_mut()?;
        match (change, direction) {
            (Change::Added(asset), Direction::After) => {
                if *index < table.len() { table[*index] = asset.clone() } else { table.insert((*index).min(table.len()), asset.clone()) }
            }
            (Change::Added(_), Direction::Before) => {
                if *index < table.len() {
                    table.remove(*index);
                }
            }
            (Change::Fields { before, after }, direction) => {
                if let Some(mut asset) = table.get(*index).and_then(Value::as_obj).cloned() {
                    match direction {
                        Direction::Before => {
                            for (key, value) in before {
                                match value {
                                    Some(value) => asset.set(key, value.clone()),
                                    None => {
                                        asset.remove(key);
                                    }
                                }
                            }
                        }
                        Direction::After => {
                            for (key, value) in after {
                                asset.set(key, value.clone());
                            }
                        }
                    }
                    table[*index] = Value::object(asset);
                }
            }
        }
        self.revision = if direction == Direction::Before { command.before_revision } else { command.after_revision };
        self.emit("history", vec![("label", Value::str(&command.label)), ("scene", Value::Bool(true))]);
        Ok(())
    }
}

/// `String.prototype.trim`: the white space and line terminators of ECMAScript.
fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}
