//! The layer list as the timeline's panel edits it (src/editor-layers.mjs): renaming,
//! colours, visibility and locks, order and new layers, each one history entry of kind
//! `layers` (`_layerEdit`) recorded as the paths it changed in the layer state.
//!
//! Deleting layers and moving figures between them change poses on a layer sheet
//! (`sheetDeleteLayer`, `sheetAssignFigures`) and are not ported.

use styk_doc::{Obj, Value};

use crate::history::{Command, CommandKind, Direction};
use crate::{EditError, Editor};

/// `FIXED_LAYER_IDS`.
const FIXED: [&str; 2] = ["scene", "camera"];
/// `LAYER_COLORS`.
const COLORS: [&str; 6] = ["blue", "violet", "rose", "orange", "green", "teal"];

/// One path of the layer state, before and after (`{path, before, after}`). A side is
/// `None` when the key does not exist; its value `None` when it is `undefined`.
#[derive(Clone, Debug)]
pub struct LayerChange {
    pub(crate) path: Vec<String>,
    pub(crate) before: Option<Value>,
    pub(crate) after: Option<Option<Value>>,
}

impl LayerChange {
    /// The layer owner's enumerable change, for worker history sizing.
    pub(crate) fn history_value(&self) -> Value {
        let side = |exists: bool, value: Option<&Value>| {
            let mut object = Obj::new();
            object.set("exists", Value::Bool(exists));
            if let Some(value) = value { object.set("value", value.clone()); }
            Value::object(object)
        };
        let mut change = Obj::new();
        change.set("path", Value::array(self.path.iter().map(|part| Value::str(part)).collect()));
        change.set("before", side(self.before.is_some(), self.before.as_ref()));
        change.set("after", side(self.after.is_some(), self.after.as_ref().and_then(Option::as_ref)));
        Value::object(change)
    }
}

/// `{exists, value}` as `JSON.stringify` prints it, to tell a change from none.
fn side_json(side: &Option<Option<Value>>) -> String {
    match side {
        None => "{\"exists\":false}".into(),
        Some(None) => "{\"exists\":true}".into(),
        Some(Some(value)) => format!("{{\"exists\":true,\"value\":{}}}", styk_doc::json::to_string(value)),
    }
}

fn removed_json(value: &Option<Value>) -> String {
    match value {
        None => "{\"exists\":false}".into(),
        Some(value) => format!("{{\"exists\":false,\"value\":{}}}", styk_doc::json::to_string(value)),
    }
}

/// `createLayerState()`.
pub(crate) fn created_state() -> Value {
    let flags = || {
        let mut flags = Obj::new();
        flags.set("visible", Value::Bool(true));
        flags.set("locked", Value::Bool(false));
        flags
    };
    // `{name, visible, locked}`
    let mut layer = Obj::new();
    layer.set("name", Value::str("Layer 1"));
    layer.set("visible", Value::Bool(true));
    layer.set("locked", Value::Bool(false));
    let mut by_id = Obj::new();
    by_id.set("layer-1", Value::object(layer));
    let mut fixed = Obj::new();
    fixed.set("scene", Value::object(flags()));
    fixed.set("camera", Value::object(flags()));
    let mut state = Obj::new();
    state.set("version", Value::Num(1.0));
    state.set("nextId", Value::Num(2.0));
    state.set("order", Value::array(vec![Value::str("layer-1")]));
    state.set("byId", Value::object(by_id));
    state.set("assignments", Value::object(Obj::new()));
    state.set("defaultLayerId", Value::str("layer-1"));
    state.set("activeId", Value::str("layer-1"));
    state.set("fixed", Value::object(fixed));
    Value::object(state)
}

/// `cleanName(name)`.
fn clean_name(name: &Value) -> Result<String, EditError> {
    let trimmed = name.as_str().map(|n| n.trim().to_string()).filter(|n| !n.is_empty() && n.encode_utf16().count() <= 160);
    trimmed.ok_or_else(|| EditError::Invalid("errors.editorLayers.layerNamesNeed1160Characters".into()))
}

/// `folderLayerOrder(state, order)`: layers of one folder kept together, where the
/// folder's topmost layer is.
fn folder_order(by_id: &Obj, order: &[String]) -> Vec<String> {
    let key = |id: &String| by_id.get(id).and_then(|layer| layer.get("folderId")).and_then(|f| f.as_str().map(str::to_string)).unwrap_or_else(|| id.clone());
    let mut groups: Vec<(String, Vec<String>)> = Vec::new();
    for id in order {
        let k = key(id);
        match groups.iter_mut().find(|(g, _)| *g == k) {
            Some((_, members)) => members.push(id.clone()),
            None => groups.push((k, vec![id.clone()])),
        }
    }
    let mut seen: Vec<String> = Vec::new();
    let mut front: Vec<String> = Vec::new();
    for id in order.iter().rev() {
        let k = key(id);
        if !seen.contains(&k) {
            seen.push(k.clone());
            let members = &groups.iter().find(|(g, _)| *g == k).unwrap().1;
            front.extend(members.iter().rev().cloned());
        }
    }
    front.reverse();
    front
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value.and_then(Value::elements).map(|e| e.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

fn get_path<'a>(state: &'a Value, path: &[String]) -> Option<&'a Value> {
    let mut at = state;
    for key in path {
        at = at.get(key)?;
    }
    Some(at)
}

/// `write(state, path, value)`; the parents exist (the commands check them).
fn write_path(state: &mut Value, path: &[String], value: Option<&Option<Value>>) {
    let Some((last, parents)) = path.split_last() else { return };
    let mut at = state;
    for key in parents {
        let Some(next) = at.make_obj().and_then(|o| o.get_mut(key)) else { return };
        at = next;
    }
    let Some(object) = at.make_obj() else { return };
    match value {
        Some(value) => object.set(last, value.clone().unwrap_or(Value::Null)),
        None => {
            object.remove(last);
        }
    }
}

/// What a layer edit changes: paths, values (`None` for `undefined`), removals.
pub(crate) type Update = (Vec<String>, Option<Value>, bool);

fn path(keys: &[&str]) -> Vec<String> {
    keys.iter().map(|k| k.to_string()).collect()
}

/// The name the interface shows for a layer (`getLayer(id).name`): Scene and Camera have their own.
pub(crate) fn layer_title(layers: Option<&Value>, id: &str) -> String {
    match id {
        "scene" => "Scene".into(),
        "camera" => "Camera".into(),
        _ => layers.and_then(|state| state.path(&["byId", id, "name"])).and_then(Value::as_str).unwrap_or("").to_string(),
    }
}

impl Editor {
    /// `_registerFrameSources`: register membership and defer source storage/assignment
    /// history until the next real command. The source table remains its only owner.
    pub(crate) fn register_frame_sources(&mut self, frames: &[Value], captured: bool) -> Result<bool, EditError> {
        for frame in frames {
            if let Some(id) = frame.path(&["_styk", "frameId"]).and_then(Value::as_str)
                && !self.generated_sources.iter().any(|known| known == id)
            {
                self.generated_sources.push(id.to_string());
                // `_registerFrameSources` charges captures referenced by small
                // key IDs. Real LayerSheet entries already charge their source
                // values in precomputedBytes and must not charge them twice.
                if captured {
                    self.pending_source_bytes += 256 + crate::frame::objects_of(frame).iter().map(|object| {
                        512 + 8 * ["angles", "lengths", "bends"].iter().map(|key| object.get(key).and_then(Value::array_len).unwrap_or(0)).sum::<usize>()
                    }).sum::<usize>();
                }
            }
        }
        self.track_frames(&[], frames, true)
    }

    /// Capture and write the assignment of a never-seen figure in `_trackLayerCommand`.
    pub(crate) fn capture_layer_assignment(&mut self, uid: u32, layer: &str) -> Option<LayerChange> {
        if layer == self.layer_of(uid) {
            return None;
        }
        let path = vec!["assignments".into(), uid.to_string()];
        let before = get_path(&self.layer_state(), &path).cloned();
        let after = Some(Some(Value::str(layer)));
        write_path(self.layer_state_mut()?, &path, after.as_ref());
        Some(LayerChange { path, before, after })
    }

    /// `_applyLayerChanges` for source assignments attached to a native animation entry.
    /// `layers` entries apply their own changes instead, as the JavaScript history does.
    pub(crate) fn apply_attached_layer_changes(&mut self, changes: &[LayerChange], direction: Direction) {
        if changes.is_empty() {
            return;
        }
        if let Some(state) = self.layer_state_mut() {
            for change in changes {
                let side = if direction == Direction::Before { change.before.clone().map(Some) } else { change.after.clone() };
                write_path(state, &change.path, side.as_ref());
            }
        }
        self.layer_revision += 1;
        self.layer_event_pending = true;
    }

    /// `ensureLayerState(report)`: a document without layers gets the default state.
    fn ensure_layer_state(&mut self) -> Result<(), EditError> {
        let report = self.report.make_obj().ok_or_else(|| EditError::Unported("a document that is not an object".into()))?;
        if report.get("_styk").is_none() {
            report.set("_styk", Value::object(Obj::new()));
        }
        let styk = report.get_mut("_styk").and_then(Value::make_obj).ok_or_else(|| EditError::Invalid("errors.layers.invalidStykanimateMetadata".into()))?;
        if styk.get("layers").is_none_or(Value::is_null) {
            styk.set("layers", created_state());
        }
        if let Some(state) = styk.get_mut("layers").and_then(Value::make_obj)
            && state.get("fixed").is_none_or(|f| f.is_object())
        {
            if state.get("fixed").is_none() {
                state.set("fixed", Value::object(Obj::new()));
            }
            let fixed = state.get_mut("fixed").and_then(Value::make_obj).unwrap();
            for id in FIXED {
                if fixed.get(id).is_none_or(Value::is_null) {
                    let mut flags = Obj::new();
                    flags.set("visible", Value::Bool(true));
                    flags.set("locked", Value::Bool(false));
                    fixed.set(id, Value::object(flags));
                }
            }
        }
        Ok(())
    }

    fn layer_state(&self) -> Value {
        self.report.path(&["_styk", "layers"]).cloned().unwrap_or(Value::Null)
    }

    fn layer_state_mut(&mut self) -> Option<&mut Value> {
        self.report.make_obj()?.get_mut("_styk")?.make_obj()?.get_mut("layers")
    }

    /// `getLayer(id)`: a fixed track or a user layer of the order.
    fn has_layer(&self, id: &str) -> bool {
        FIXED.contains(&id) || strings(self.layer_state().get("order")).iter().any(|layer| layer == id)
    }

    /// `_layerEdit(label, updates, {structural, activeId})`: the changed paths of the layer
    /// state, one history entry, the sheet's tracks following the layers.
    pub(crate) fn layer_edit(&mut self, label: &str, updates: Vec<Update>, structural: bool, active: Option<String>) -> Result<bool, EditError> {
        self.layer_edit_migration_checked(label, updates, structural, active, None, &mut || Ok(()))
    }

    pub(crate) fn layer_edit_migration_checked(&mut self, label: &str, updates: Vec<Update>, structural: bool, active: Option<String>, migration: Option<crate::layer_planning::NativeMigration>, check: &mut impl FnMut() -> Result<(), EditError>) -> Result<bool, EditError> {
        self.layer_edit_publication_checked(label, updates, structural, active, migration, check, None)
    }

    fn layer_edit_publication(&mut self, label: &str, updates: Vec<Update>, structural: bool, publication: Option<&mut Option<Value>>) -> Result<bool, EditError> {
        self.layer_edit_publication_checked(label, updates, structural, None, None, &mut || Ok(()), publication)
    }

    fn layer_edit_publication_checked(&mut self, label: &str, updates: Vec<Update>, structural: bool, active: Option<String>, migration: Option<crate::layer_planning::NativeMigration>, check: &mut impl FnMut() -> Result<(), EditError>, publication: Option<&mut Option<Value>>) -> Result<bool, EditError> {
        check()?;
        if self.drag.is_some() { self.commit_drag()?; }
        self.ensure_layer_state()?;
        if migration.is_some() { self.ensure_counts(); }
        let before_selection = self.selection_state();
        let state = self.layer_state();
        let mut accepted = publication.as_ref().map(|_| Vec::new());
        let changes: Vec<LayerChange> = updates
            .into_iter()
            .map(|(path, value, remove)| {
                let before = get_path(&state, &path).cloned();
                let after = if remove { None } else { Some(value.clone()) };
                // `JSON.stringify(change.before) !== JSON.stringify(change.after)`
                let before_text = side_json(&before.clone().map(Some));
                let after_text = if remove { removed_json(&value) } else { side_json(&after) };
                let changed = before_text != after_text;
                if changed && let Some(accepted) = &mut accepted {
                    let mut update = Obj::new();
                    update.set("path", Value::array(path.iter().map(|key| Value::str(key)).collect()));
                    update.set("remove", Value::Bool(remove));
                    // Removed null and omitted undefined differ in the JS
                    // history filter, even when the stored key is absent.
                    if let Some(value) = value { update.set("value", value); }
                    accepted.push(Value::object(update));
                }
                (LayerChange { path, before, after }, changed)
            })
            .filter(|(_, changed)| *changed)
            .map(|(change, _)| change)
            .collect();
        if changes.is_empty() {
            return Ok(false);
        }
        if let Some(publication) = publication {
            let mut packet = Obj::new();
            packet.set("label", Value::str(label));
            packet.set("structural", Value::Bool(structural));
            packet.set("updates", Value::array(accepted.unwrap()));
            if let Some(active) = &active { packet.set("activeId", Value::str(active)); }
            *publication = Some(Value::object(packet));
        }
        let state = self.layer_state_mut().unwrap();
        for change in &changes {
            write_path(state, &change.path, change.after.as_ref());
        }
        if let Some(active) = &active
            && let Some(object) = state.make_obj()
        {
            object.set("activeId", Value::str(active));
        }
        // The sheet has a track for each user layer and for the fixed ones only.
        let order = strings(self.layer_state().get("order"));
        let sheet = self.report.path(&["_styk", "layerSheet"]).cloned();
        let sheet_patch = sheet.filter(|s| s.truthy()).map(|before| {
            let mut tracks = before.get("tracks").and_then(Value::as_obj).cloned().unwrap_or_default();
            for id in &order {
                if tracks.get(id).is_none_or(Value::is_null) {
                    let mut empty = Obj::new();
                    empty.set("keys", Value::array(Vec::new()));
                    empty.set("end", Value::Num(0.0));
                    tracks.set(id, Value::object(empty));
                }
            }
            for id in tracks.keys().map(|k| k.to_string()).collect::<Vec<_>>() {
                if !FIXED.contains(&id.as_str()) && !order.contains(&id) {
                    tracks.remove(&id);
                }
            }
            let mut after = before.as_obj().cloned().unwrap_or_default();
            after.set("tracks", Value::object(tracks));
            (before, Value::object(after))
        });
        let timing = sheet_patch.is_some() || migration.is_some();
        if let Some((_, after)) = &sheet_patch
            && let Some(styk) = self.report.make_obj().and_then(|r| r.get_mut("_styk")).and_then(Value::make_obj)
        {
            styk.set("layerSheet", after.clone());
        }
        let animation = migration.is_some();
        if let Some(migration) = &migration { migration.publish(self, check)?; }
        self.layer_revision += 1;
        let after_selection = self.selection_state();
        self.record_checked(Command { kind: CommandKind::Layers { changes, sheet: sheet_patch, migration, structural, timing }, label: label.into(), before_selection, after_selection, before_revision: 0, after_revision: 0, layer_changes: Vec::new(), captured_source_bytes: 0, layers: false }, check)?;
        self.retained = None;
        self.emit_layers("edit", label, structural, timing, animation, true);
        Ok(true)
    }

    /// The events of a layer edit and of its undo and redo, decorated with the layer
    /// revision as `_emit` decorates them.
    fn emit_layers(&mut self, kind: &str, label: &str, structural: bool, timing: bool, animation: bool, edit: bool) {
        self.layer_event_pending = false;
        let mut event = Obj::new();
        event.set("kind", Value::str(kind));
        event.set("frameIndex", Value::Num(self.frame_index as f64));
        event.set("tick", Value::Num(self.tick));
        event.set("structural", Value::Bool(structural));
        event.set("timing", Value::Bool(if edit { animation } else { timing }));
        event.set("layers", Value::Bool(true));
        event.set("layerRevision", Value::Num(self.layer_revision as f64));
        event.set("label", Value::str(label));
        if edit {
            event.set("layerMetadata", Value::Bool(true));
            event.set("animation", Value::Bool(animation));
        } else {
            event.set("definition", Value::Bool(false));
            event.set("animation", Value::Bool(animation));
        }
        self.events.push(Value::object(event));
    }

    /// `_applyCommand` for a `layers` entry.
    pub(crate) fn apply_layers_command(&mut self, command: &Command, direction: Direction) -> Result<(), EditError> {
        let CommandKind::Layers { changes, sheet, migration, structural, timing } = &command.kind else { return Ok(()) };
        self.ensure_layer_state()?;
        if let Some(migration) = migration { migration.apply(self, direction)?; }
        if let Some(state) = self.layer_state_mut() {
            for change in changes {
                let side = match direction {
                    Direction::Before => change.before.clone().map(Some),
                    Direction::After => change.after.clone(),
                };
                write_path(state, &change.path, side.as_ref());
            }
        }
        self.layer_revision += 1;
        if let Some((before, after)) = sheet
            && let Some(styk) = self.report.make_obj().and_then(|r| r.get_mut("_styk")).and_then(Value::make_obj)
        {
            styk.set("layerSheet", if direction == Direction::Before { before.clone() } else { after.clone() });
        }
        let (selection, revision) = match direction {
            Direction::Before => (&command.before_selection, command.before_revision),
            Direction::After => (&command.after_selection, command.after_revision),
        };
        self.restore_selection(selection)?;
        self.revision = revision;
        self.retained = None;
        self.emit_layers("history", &command.label, *structural, *timing, migration.is_some(), false);
        Ok(())
    }

    /// `renameLayer(id, name)`.
    pub(crate) fn rename_layer(&mut self, id: &Value, name: &Value) -> Result<bool, EditError> {
        self.rename_layer_publication(id, name, None)
    }

    pub(crate) fn rename_layer_publication(&mut self, id: &Value, name: &Value, publication: Option<&mut Option<Value>>) -> Result<bool, EditError> {
        let id = id.as_str().unwrap_or("").to_string();
        if FIXED.contains(&id.as_str()) {
            return Err(EditError::Invalid("errors.editorLayers.sceneAndCameraArePermanentTracksAndCannot".into()));
        }
        self.ensure_layer_state()?;
        if self.layer_state().path(&["byId", &id]).is_none() {
            return Err(EditError::Invalid("errors.editorLayers.chooseAnExistingUserLayer".into()));
        }
        let name = clean_name(name)?;
        self.layer_edit_publication("Rename layer", vec![(path(&["byId", &id, "name"]), Some(Value::str(&name)), false)], false, publication)
    }

    /// `setLayerColor(ids, color)`: `null` removes the colour.
    pub(crate) fn set_layer_color(&mut self, ids: &Value, color: &Value, publication: Option<&mut Option<Value>>) -> Result<bool, EditError> {
        if !color.is_null() && !color.as_str().is_some_and(|c| COLORS.contains(&c)) {
            return Err(EditError::Invalid("errors.editorLayers.chooseALayerColor".into()));
        }
        self.ensure_layer_state()?;
        let mut unique: Vec<String> = Vec::new();
        for id in ids.elements().map(|e| e.iter().collect::<Vec<_>>()).unwrap_or_default() {
            let Some(id) = id.as_str().map(str::to_string) else { return Err(EditError::Invalid("errors.editorLayers.chooseExistingUserLayers".into())) };
            if !unique.contains(&id) {
                unique.push(id);
            }
        }
        let state = self.layer_state();
        if unique.iter().any(|id| state.path(&["byId", id]).is_none()) {
            return Err(EditError::Invalid("errors.editorLayers.chooseExistingUserLayers".into()));
        }
        let updates = unique.iter().map(|id| (path(&["byId", id, "color"]), Some(color.clone()), color.is_null())).collect();
        self.layer_edit_publication("Set layer color", updates, false, publication)
    }

    /// `setLayerParallax(id, patch)`: a figure layer's
    /// response to camera travel, its reference the camera on show unless set.
    pub(crate) fn set_layer_parallax(&mut self, id: &Value, patch: &Value, publication: Option<&mut Option<Value>>) -> Result<bool, EditError> {
        let (id, parallax) = self.parallax_after(id, patch)?;
        self.layer_edit_publication("Edit layer parallax", vec![(path(&["byId", &id, "parallax"]), Some(parallax), false)], false, publication)
    }

    /// The layer and the parallax `patch` makes of its response, validated as `setLayerParallax` does.
    pub(crate) fn parallax_after(&mut self, id: &Value, patch: &Value) -> Result<(String, Value), EditError> {
        self.ensure_layer_state()?;
        let state = self.layer_state();
        let Some(id) = id.as_str().filter(|id| state.path(&["byId", id]).is_some()).map(str::to_string) else {
            return Err(EditError::Invalid("errors.editorCameraMotion.selectAFigureLayerForParallax".into()));
        };
        if self.track_locked(&id) {
            return Err(crate::invalid_with("errors.editorCameraMotion.unlockBeforeEditingParallax", vec![("name", Value::str(&layer_title(Some(&state), &id)))]));
        }
        let patch = patch.as_obj().ok_or_else(|| EditError::Unported("a parallax change that is not an object".into()))?;
        if patch.keys().any(|key| !["enabled", "linked", "x", "y", "reference"].contains(&&**key)) {
            return Err(EditError::Invalid("errors.editorCameraMotion.unsupportedParallaxProperty".into()));
        }
        let camera = self.shown_frame()?.get("camera").cloned().unwrap_or(Value::Null);
        let axis = |key: &str| camera.get(key).filter(|v| !v.is_null()).cloned().unwrap_or(Value::Num(0.0));
        let mut reference = Obj::new();
        reference.set("x", axis("x"));
        reference.set("y", axis("y"));
        let mut p = Obj::new();
        p.set("enabled", Value::Bool(false));
        p.set("linked", Value::Bool(true));
        p.set("x", Value::Num(1.0));
        p.set("y", Value::Num(1.0));
        p.set("reference", Value::object(reference));
        if let Some(current) = state.path(&["byId", &id, "parallax"]).and_then(Value::as_obj) {
            for (key, value) in current.iter() {
                p.set(key, value.clone());
            }
        }
        for (key, value) in patch.iter() {
            p.set(key, value.clone());
        }
        if p.get("linked").is_some_and(Value::truthy) {
            let given = |key: &str| patch.get(key).is_some();
            if given("y") && !given("x") {
                let y = p.get("y").cloned().unwrap_or(Value::Null);
                p.set("x", y);
            } else {
                let x = p.get("x").cloned().unwrap_or(Value::Null);
                p.set("y", x);
            }
        }
        // `validateParallax(p)`
        let response = |key: &str| matches!(p.get(key), Some(Value::Num(v)) if v.is_finite() && (0.0..=4.0).contains(v));
        let finite = |value: Option<&Value>| matches!(value, Some(Value::Num(v)) if v.is_finite());
        let reference = p.get("reference").filter(|r| r.truthy());
        let valid = matches!(p.get("enabled"), Some(Value::Bool(_))) && matches!(p.get("linked"), Some(Value::Bool(_))) && response("x") && response("y")
            && reference.is_some_and(|r| finite(r.get("x")) && finite(r.get("y")));
        if !valid {
            return Err(EditError::Invalid("errors.layerParallax.parallaxNeedsA0400ResponseAndA".into()));
        }
        Ok((id, Value::object(p)))
    }

    /// `setLayerVisible(id, visible)`, `setLayerLocked(id, locked)`.
    pub(crate) fn set_layer_flag(&mut self, id: &Value, key: &str, value: &Value, publication: Option<&mut Option<Value>>) -> Result<bool, EditError> {
        let id = id.as_str().unwrap_or("").to_string();
        self.ensure_layer_state()?;
        if !matches!(value, Value::Bool(_)) || !self.has_layer(&id) {
            return Err(EditError::Invalid("errors.editorLayers.chooseAnExistingTrackAndABooleanState".into()));
        }
        let owner = if FIXED.contains(&id.as_str()) { "fixed" } else { "byId" };
        let label = if key == "visible" { "Set layer visibility" } else { "Set layer lock" };
        self.layer_edit_publication(label, vec![(path(&[owner, &id, key]), Some(value.clone()), false)], false, publication)
    }

    /// `reorderLayers(ids)`: every user layer once, folders kept together.
    pub(crate) fn reorder_layers(&mut self, ids: &Value, publication: Option<&mut Option<Value>>) -> Result<bool, EditError> {
        self.ensure_layer_state()?;
        let state = self.layer_state();
        let current = strings(state.get("order"));
        let given: Vec<Value> = ids.elements().map(|e| e.iter().collect()).unwrap_or_default();
        let order: Vec<String> = given.iter().filter_map(|v| v.as_str().map(str::to_string)).collect();
        let distinct = order.iter().collect::<std::collections::HashSet<_>>().len() == order.len();
        if order.len() != given.len() || order.len() != current.len() || !distinct || order.iter().any(|id| state.path(&["byId", id]).is_none()) {
            return Err(EditError::Invalid("errors.editorLayers.includeEveryUserLayerExactlyOnceSceneAnd".into()));
        }
        let by_id = state.get("byId").and_then(Value::as_obj).cloned().unwrap_or_default();
        let ordered = folder_order(&by_id, &order);
        self.layer_edit_publication("Reorder layers", vec![(path(&["order"]), Some(Value::array(ordered.iter().map(|id| Value::str(id)).collect())), false)], true, publication)
    }

    /// `moveLayerTo(id, index)`.
    pub(crate) fn move_layer_to(&mut self, id: &Value, index: &Value, publication: Option<&mut Option<Value>>) -> Result<bool, EditError> {
        self.ensure_layer_state()?;
        let mut order = strings(self.layer_state().get("order"));
        let id = id.as_str().unwrap_or("").to_string();
        let from = order.iter().position(|layer| *layer == id);
        let to = index.as_f64().filter(|n| n.fract() == 0.0 && *n >= 0.0 && (*n as usize) < order.len());
        let (Some(from), Some(to)) = (from, to) else { return Err(EditError::Invalid("errors.editorLayers.chooseAValidUserLayerPosition".into())) };
        let layer = order.remove(from);
        order.insert(to as usize, layer);
        self.reorder_layers(&Value::array(order.iter().map(|id| Value::str(id)).collect()), publication)
    }

    /// `createLayer(name, {index, activate, drawing, folderId})`: the new layer's view.
    pub(crate) fn create_layer(&mut self, name: &Value, options: &Value, publication: Option<&mut Option<Value>>) -> Result<Value, EditError> {
        self.ensure_layer_state()?;
        let state = self.layer_state();
        let next = state.get("nextId").and_then(Value::as_f64).unwrap_or(f64::NAN);
        let id = format!("layer-{}", styk_doc::json::to_string(&Value::Num(next)));
        let order = strings(state.get("order"));
        if order.len() >= 10000 {
            return Err(EditError::Invalid("errors.editorLayers.aProjectSupportsAtMost10000User".into()));
        }
        let insertion = match options.get("index").filter(|v| !v.is_null()) {
            None => order.len(),
            Some(index) => match index.as_f64().filter(|n| n.fract() == 0.0 && *n >= 0.0 && *n <= order.len() as f64) {
                Some(n) => n as usize,
                None => return Err(EditError::Invalid("errors.editorLayers.invalidLayerPosition".into())),
            },
        };
        let by_id = state.get("byId").and_then(Value::as_obj).cloned().unwrap_or_default();
        let folder_of = |at: Option<usize>| at.and_then(|i| order.get(i)).and_then(|id| by_id.get(id)).and_then(|layer| layer.get("folderId")).cloned();
        let folder = match options.get("folderId").filter(|v| !v.is_null()) {
            Some(folder) => Some(folder.clone()),
            // `byId[order[insertion - 1]]?.folderId === byId[order[insertion]]?.folderId`
            None => {
                let above = folder_of(insertion.checked_sub(1));
                let below = folder_of(Some(insertion));
                if above == below { below } else { None }
            }
        };
        if let Some(folder) = &folder
            && !folder.as_str().is_some_and(|f| state.path(&["folders", "byId", f]).is_some())
        {
            return Err(EditError::Invalid("errors.layerFolders.missingFolder".into()));
        }
        let title = match name {
            Value::Null => format!("Layer {}", styk_doc::json::to_string(&Value::Num(next))),
            name => clean_name(name)?,
        };
        let mut layer = Obj::new();
        layer.set("name", Value::str(&title));
        layer.set("visible", Value::Bool(true));
        layer.set("locked", Value::Bool(false));
        if let Some(folder) = folder.as_ref().filter(|f| f.truthy()) {
            layer.set("folderId", folder.clone());
        }
        if options.get("drawing").is_some_and(Value::truthy) {
            let mut drawing = Obj::new();
            drawing.set("version", Value::Num(1.0));
            layer.set("drawing", Value::object(drawing));
        }
        let mut placed = order.clone();
        placed.insert(insertion, id.clone());
        let mut with_new = by_id.clone();
        let mut folder_only = Obj::new();
        if let Some(folder) = &folder {
            folder_only.set("folderId", folder.clone());
        }
        with_new.set(&id, Value::object(folder_only));
        let ordered = folder_order(&with_new, &placed);
        // `activate = true` when it is not given.
        let activate = options.get("activate").is_none_or(Value::truthy);
        let updates = vec![
            (path(&["byId", &id]), Some(Value::object(layer)), false),
            (path(&["order"]), Some(Value::array(ordered.iter().map(|id| Value::str(id)).collect())), false),
            (path(&["nextId"]), Some(Value::Num(next + 1.0)), false),
        ];
        self.layer_edit_publication_checked("Create layer", updates, true, activate.then(|| id.clone()), None, &mut || Ok(()), publication)?;
        Ok(self.layer_view(&id))
    }

    /// `getLayer(id)` for a layer just created: Focus and lock never holds it, as it joins the focus.
    fn layer_view(&self, id: &str) -> Value {
        let state = self.layer_state();
        let Some(layer) = state.path(&["byId", id]).and_then(Value::as_obj) else { return Value::Null };
        let mut view = Obj::new();
        view.set("id", Value::str(id));
        view.set("kind", Value::str("layer"));
        for (key, value) in layer.iter() {
            view.set(key, value.clone());
        }
        let locked = layer.get("locked").cloned().unwrap_or(Value::Null);
        view.set("savedLocked", locked.clone());
        view.set("focusLocked", Value::Bool(false));
        view.set("locked", if locked.truthy() { locked } else { Value::Bool(false) });
        view.set("permanent", Value::Bool(false));
        // A layer just created holds no figures.
        view.set("figureUids", Value::array(Vec::new()));
        Value::object(view)
    }

    /// `members(state, ids)`: distinct user layers, or the folders' refusal.
    fn layer_members(&self, ids: &Value) -> Result<Vec<String>, EditError> {
        let state = self.layer_state();
        let mut selected: Vec<String> = Vec::new();
        for id in ids.elements().map(|e| e.iter().collect::<Vec<_>>()).unwrap_or_default() {
            let Some(id) = id.as_str().map(str::to_string).filter(|id| state.path(&["byId", id]).is_some()) else {
                return Err(EditError::Invalid("errors.layerFolders.chooseLayers".into()));
            };
            if !selected.contains(&id) {
                selected.push(id);
            }
        }
        Ok(selected)
    }

    /// `nameOf(name)` for folders.
    fn folder_name(name: &Value) -> Result<String, EditError> {
        clean_name(name).map_err(|_| EditError::Invalid("errors.layerFolders.invalidName".into()))
    }

    fn folder_exists(&self, id: &Value) -> bool {
        id.as_str().is_some_and(|id| self.layer_state().path(&["folders", "byId", id]).is_some())
    }

    /// The layers' records with `ids` moved into `folder` (`None`: out of every folder).
    fn regrouped(&self, ids: &[String], folder: Option<&Value>) -> Obj {
        let mut by_id = self.layer_state().get("byId").and_then(Value::as_obj).cloned().unwrap_or_default();
        for id in ids {
            let mut layer = by_id.get(id).and_then(Value::as_obj).cloned().unwrap_or_default();
            match folder {
                Some(folder) => layer.set("folderId", folder.clone()),
                None => {
                    layer.remove("folderId");
                }
            }
            by_id.set(id, Value::object(layer));
        }
        by_id
    }

    fn order_update(order: Vec<String>) -> Update {
        (path(&["order"]), Some(Value::array(order.iter().map(|id| Value::str(id)).collect())), false)
    }

    /// `createLayerFolder(name, ids)`: the folder's view.
    pub(crate) fn create_layer_folder(&mut self, name: Option<&Value>, ids: &Value, publication: Option<&mut Option<Value>>) -> Result<Value, EditError> {
        self.ensure_layer_state()?;
        let selected = self.layer_members(ids)?;
        let state = self.layer_state();
        let folders = state.get("folders").filter(|f| f.truthy()).cloned();
        let next = folders.as_ref().map_or(1.0, |f| f.get("nextId").and_then(Value::as_f64).unwrap_or(f64::NAN));
        if folders.as_ref().and_then(|f| f.get("byId")).and_then(Value::as_obj).is_some_and(|b| b.len() >= 10000) {
            return Err(EditError::Invalid("errors.layerFolders.tooManyFolders".into()));
        }
        let id = format!("folder-{}", styk_doc::json::to_string(&Value::Num(next)));
        let title = match name {
            None => "Folder".to_string(),
            Some(name) => Self::folder_name(name)?,
        };
        let mut folder = Obj::new();
        folder.set("name", Value::str(&title));
        let mut updates: Vec<Update> = if folders.is_some() {
            vec![(path(&["folders", "byId", &id]), Some(Value::object(folder.clone())), false), (path(&["folders", "nextId"]), Some(Value::Num(next + 1.0)), false)]
        } else {
            let mut by_id = Obj::new();
            by_id.set(&id, Value::object(folder.clone()));
            let mut table = Obj::new();
            table.set("nextId", Value::Num(next + 1.0));
            table.set("byId", Value::object(by_id));
            vec![(path(&["folders"]), Some(Value::object(table)), false)]
        };
        let folder_id = Value::str(&id);
        let by_id = self.regrouped(&selected, Some(&folder_id));
        updates.extend(selected.iter().map(|layer| (path(&["byId", layer, "folderId"]), Some(folder_id.clone()), false)));
        updates.push(Self::order_update(folder_order(&by_id, &strings(state.get("order")))));
        self.layer_edit_publication("Create layer folder", updates, true, publication)?;
        let mut view = Obj::new();
        view.set("id", Value::str(&id));
        view.set("kind", Value::str("folder"));
        view.set("name", Value::str(&title));
        Ok(Value::object(view))
    }

    /// `renameLayerFolder(id, name)`.
    pub(crate) fn rename_layer_folder(&mut self, id: &Value, name: &Value, publication: Option<&mut Option<Value>>) -> Result<bool, EditError> {
        if !self.folder_exists(id) {
            return Err(EditError::Invalid("errors.layerFolders.missingFolder".into()));
        }
        let name = Self::folder_name(name)?;
        let id = id.as_str().unwrap().to_string();
        self.layer_edit_publication("Rename layer folder", vec![(path(&["folders", "byId", &id, "name"]), Some(Value::str(&name)), false)], false, publication)
    }

    /// `moveLayersToFolder(ids, folderId)`: `null` takes them out of every folder.
    pub(crate) fn move_layers_to_folder(&mut self, ids: &Value, folder: &Value, publication: Option<&mut Option<Value>>) -> Result<bool, EditError> {
        self.ensure_layer_state()?;
        let selected = self.layer_members(ids)?;
        if !folder.is_null() && !self.folder_exists(folder) {
            return Err(EditError::Invalid("errors.layerFolders.missingFolder".into()));
        }
        let into = (!folder.is_null()).then_some(folder);
        let by_id = self.regrouped(&selected, into);
        let state_order = strings(self.layer_state().get("order"));
        let mut order = state_order.clone();
        if into.is_some() {
            let remaining: Vec<String> = state_order.iter().filter(|id| !selected.contains(id)).cloned().collect();
            let in_folder = |id: &String| by_id.get(id).and_then(|l| l.get("folderId")) == into;
            if let Some(last) = remaining.iter().rposition(in_folder) {
                order = remaining.clone();
                let chosen: Vec<String> = state_order.iter().filter(|id| selected.contains(id)).cloned().collect();
                for (k, id) in chosen.into_iter().enumerate() {
                    order.insert(last + 1 + k, id);
                }
            }
        }
        let mut updates: Vec<Update> = selected.iter().map(|id| (path(&["byId", id, "folderId"]), Some(folder.clone()), folder.is_null())).collect();
        updates.push(Self::order_update(folder_order(&by_id, &order)));
        self.layer_edit_publication("Move layers to folder", updates, true, publication)
    }

    /// `arrangeLayers(order, ids, folderId)`: the whole stack, and with `folderId` given
    /// (`null`: out of every folder) `ids` moved into it.
    pub(crate) fn arrange_layers(&mut self, order: &Value, ids: Option<&Value>, folder: Option<&Value>, publication: Option<&mut Option<Value>>) -> Result<bool, EditError> {
        self.ensure_layer_state()?;
        let selected = match ids {
            Some(ids) => self.layer_members(ids)?,
            None => Vec::new(),
        };
        let state = self.layer_state();
        let given: Vec<Value> = order.elements().map(|e| e.iter().collect()).unwrap_or_default();
        let stack: Vec<String> = given.iter().filter_map(|v| v.as_str().map(str::to_string)).collect();
        let distinct = stack.iter().collect::<std::collections::HashSet<_>>().len() == stack.len();
        if stack.len() != given.len() || stack.len() != strings(state.get("order")).len() || !distinct || stack.iter().any(|id| state.path(&["byId", id]).is_none()) {
            return Err(EditError::Invalid("errors.editorLayers.includeEveryUserLayerExactlyOnceSceneAnd".into()));
        }
        if let Some(folder) = folder.filter(|f| !f.is_null())
            && !self.folder_exists(folder)
        {
            return Err(EditError::Invalid("errors.layerFolders.missingFolder".into()));
        }
        let moved: Vec<String> = if folder.is_some() { selected } else { Vec::new() };
        let into = folder.filter(|f| !f.is_null());
        let by_id = self.regrouped(&moved, into);
        let folder_value = folder.cloned().unwrap_or(Value::Null);
        let mut updates: Vec<Update> = moved.iter().map(|id| (path(&["byId", id, "folderId"]), Some(folder_value.clone()), folder_value.is_null())).collect();
        updates.push(Self::order_update(folder_order(&by_id, &stack)));
        self.layer_edit_publication("Move layers", updates, true, publication)
    }

    /// `deleteLayerFolder(id)`: its layers leave it; nothing else changes.
    pub(crate) fn delete_layer_folder(&mut self, id: &Value, publication: Option<&mut Option<Value>>) -> Result<bool, EditError> {
        self.ensure_layer_state()?;
        if !self.folder_exists(id) {
            return Err(EditError::Invalid("errors.layerFolders.missingFolder".into()));
        }
        let id = id.as_str().unwrap().to_string();
        let state = self.layer_state();
        let mut updates: Vec<Update> = vec![(path(&["folders", "byId", &id]), None, true)];
        for layer in strings(state.get("order")) {
            if state.path(&["byId", &layer, "folderId"]).and_then(Value::as_str) == Some(id.as_str()) {
                updates.push((path(&["byId", &layer, "folderId"]), None, true));
            }
        }
        self.layer_edit_publication("Ungroup layer folder", updates, true, publication)
    }
}
