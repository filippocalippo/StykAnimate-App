//! Camera commands on a layer sheet (src/editor-camera.mjs): the camera's values copied,
//! pasted, typed, reset, transformed, aligned with the canvas view or taken from the
//! neighbouring key, each a key of the camera track (`addAnimationKeys`); a camera drag that
//! previews its keys and commits them once; a handle moved to where it is on the neighbouring
//! key (`locateHandle`). On a native timeline the editor stores cameras in keyframes: not
//! ported.

use styk_doc::{Obj, Value};

use crate::record::{num, uid};
use crate::{EditError, Editor};

const FIELDS: [&str; 4] = ["x", "y", "scale", "angle_rad"];
const FINITE: &str = "errors.editorCamera.mustBeFinite";

/// A frame's camera as edited (`{index, tick, camera}`).
#[derive(Clone, Debug)]
pub(crate) struct Target {
    index: usize,
    tick: f64,
    camera: Value,
}

/// `_drag` of a camera drag on a layer sheet.
#[derive(Clone, Debug)]
pub(crate) struct CameraDrag {
    /// The keyframes the drag edits (`cameraBefore`'s indices).
    indices: Vec<usize>,
    baseline: Vec<Target>,
    current: Vec<Target>,
    entries: Vec<Value>,
    /// What the frame on show is while the drag previews its keys (`_sheetPropertyPreview`).
    pub preview: Option<Value>,
}

/// `cameraValues(camera)`: every value present, a default camera when none.
pub(crate) fn camera_values(camera: Option<&Value>) -> Value {
    let camera = camera.filter(|c| !c.is_null() && !c.get("is_default").is_some_and(Value::truthy));
    let mut out = match camera.and_then(Value::as_obj) {
        Some(object) => object.clone(),
        None => {
            let mut defaults = Obj::new();
            defaults.set("is_default", Value::Bool(true));
            defaults
        }
    };
    for (key, fallback) in [("x", 0.0), ("y", 0.0), ("scale", 1.0), ("angle_rad", 0.0)] {
        let value = camera.and_then(|c| c.get(key)).filter(|v| !v.is_null()).cloned().unwrap_or(Value::Num(fallback));
        out.set(key, value);
    }
    Value::object(out)
}

/// `finite(camera[key], {Camera <key>})` failed.
pub(crate) fn camera_not_finite(key: &str) -> EditError {
    crate::invalid_with(FINITE, vec![("label", crate::label(&format!("Camera {key}")))])
}

fn field(camera: &Value, key: &str) -> f64 {
    camera.get(key).and_then(Value::as_f64).unwrap_or(f64::NAN)
}

/// `checked(camera)`: finite values within the native range and a positive scale.
fn checked(camera: &Value) -> Result<Value, EditError> {
    for key in FIELDS {
        if !camera.get(key).and_then(Value::as_f64).is_some_and(f64::is_finite) {
            return Err(camera_not_finite(key));
        }
    }
    for key in ["x", "y", "scale"] {
        if !(field(camera, key) as f32).is_finite() {
            return Err(crate::invalid_with("errors.editorCamera.cameraExceedsTheNativeRange", vec![("field", Value::str(key))]));
        }
    }
    let scale = field(camera, "scale");
    if scale <= 0.0 {
        return Err(EditError::Invalid("errors.editorCamera.cameraScaleMustBePositive".into()));
    }
    let inverse = (1.0f32 / scale as f32) as f64;
    if !inverse.is_finite() || inverse <= 0.0 {
        return Err(EditError::Invalid("errors.background.cameraScaleExceedsTheNativeRenderingRange".into()));
    }
    let mut out = camera.as_obj().cloned().unwrap_or_default();
    let default = field(camera, "x") == 0.0 && field(camera, "y") == 0.0 && scale == 1.0 && field(camera, "angle_rad") == 0.0;
    out.set("is_default", Value::Bool(default));
    Ok(Value::object(out))
}

/// `checkedPatch(patch)`: camera values only, each finite.
fn checked_patch(patch: &Value) -> Result<Vec<(String, f64)>, EditError> {
    let Some(object) = patch.as_obj() else { return Err(EditError::Invalid("errors.editorCamera.provideCameraPositionValues".into())) };
    let mut out = Vec::new();
    for (key, value) in object.iter() {
        if !FIELDS.contains(&key.as_ref()) {
            return Err(crate::invalid_with("errors.editorCamera.unknownCameraValue", vec![("key", Value::str(key))]));
        }
        let Some(value) = value.as_f64().filter(|v| v.is_finite()) else { return Err(camera_not_finite(key)) };
        out.push((key.to_string(), value));
    }
    Ok(out)
}

/// `{...camera, ...patch}`.
fn with(camera: &Value, patch: &[(&str, f64)]) -> Value {
    let mut out = camera.as_obj().cloned().unwrap_or_default();
    for (key, value) in patch {
        out.set(key, Value::Num(*value));
    }
    Value::object(out)
}

/// `cameraKeyEntries(editor, before, after)`: a camera key for every value that changed.
fn key_entries(before: &[Target], after: &[Target]) -> Vec<Value> {
    let mut entries = Vec::new();
    for (b, a) in before.iter().zip(after) {
        for key in FIELDS {
            let value = field(&a.camera, key);
            if field(&b.camera, key) == value {
                continue;
            }
            let mut target = Obj::new();
            target.set("kind", Value::str("camera"));
            let mut entry = Obj::new();
            entry.set("target", Value::object(target));
            entry.set("property", Value::str(if key == "angle_rad" { "rotation" } else { key }));
            entry.set("tick", Value::Num(b.tick));
            entry.set("value", Value::Num(value));
            entries.push(Value::object(entry));
        }
    }
    entries
}

/// A JSON list of keyframe indices (`indices = [this.frameIndex]`).
fn indices_of(value: &Value) -> Option<Value> {
    (!value.is_null()).then(|| value.clone())
}

impl Editor {
    fn camera_sheet(&self, method: &str) -> Result<(), EditError> {
        if self.sheet() { Ok(()) } else { Err(EditError::Unported(format!("{method} on a native timeline"))) }
    }

    /// `finishGesture(editor)`: an open property edit or gesture is committed first.
    fn finish_gesture(&mut self) -> Result<(), EditError> {
        if self.property_edit.is_some() {
            self.commit_animation_edit()?;
        }
        if self.drag.is_some() {
            self.commit_drag()?;
        }
        Ok(())
    }

    /// `cameraTargets(editor, indices)` with each frame's camera (`composedFrame`).
    fn camera_targets(&mut self, indices: Option<&Value>) -> Result<Vec<Target>, EditError> {
        let mut options = Obj::new();
        if let Some(indices) = indices {
            options.set("indices", indices.clone());
        }
        let ticks = self.sheet_edit_times_of(Some(&Value::object(options)))?;
        let rows = crate::timeline::rows(&self.report);
        let mut targets = Vec::with_capacity(ticks.len());
        for tick in ticks {
            let index = rows.iter().rposition(|row| row.start <= tick).unwrap_or(0);
            let frame = self.evaluated(tick, true)?;
            targets.push(Target { index, tick, camera: camera_values(frame.get("camera")) });
        }
        Ok(targets)
    }

    /// `cameraEdit(editor, label, indices, update)`: the changed cameras keyed; returns how many.
    fn camera_edit(&mut self, indices: Option<&Value>, update: impl Fn(&Value) -> Option<Value>) -> Result<Value, EditError> {
        self.camera_edit_at(indices, |_, target| Ok(update(&target.camera)))
    }

    fn camera_edit_at(&mut self, indices: Option<&Value>, mut update: impl FnMut(&Editor, &Target) -> Result<Option<Value>, EditError>) -> Result<Value, EditError> {
        self.finish_gesture()?;
        let (mut before, mut after) = (Vec::new(), Vec::new());
        for entry in self.camera_targets(indices)? {
            let Some(value) = update(self, &entry)? else { continue };
            let next = checked(&value)?;
            if styk_doc::json::to_string(&entry.camera) == styk_doc::json::to_string(&next) {
                continue;
            }
            after.push(Target { index: entry.index, tick: entry.tick, camera: next });
            before.push(entry);
        }
        if after.is_empty() {
            return Ok(Value::Num(0.0));
        }
        let entries = key_entries(&before, &after);
        if entries.is_empty() {
            return Ok(Value::Num(0.0));
        }
        self.add_animation_keys(Some(&Value::array(entries)))?;
        Ok(Value::Num(after.len() as f64))
    }

    /// `centerCamera` with the editor's default callback. Its `objectBounds` returns a
    /// rectangle as x/y/width/height, which the caller rejects for missing min/max fields:
    /// no keys change, but cameraEdit still finishes gestures and checks its targets.
    /// A supplied callback is the app's, measured here, or the measurements the JavaScript
    /// owner already made with it.
    pub(crate) fn center_camera(&mut self, axis: &str, indices: &Value, options: &Value) -> Result<Value, EditError> {
        self.camera_sheet("centerCamera")?;
        if !["both", "x", "y"].contains(&axis) {
            return Err(EditError::Invalid("errors.editorCamera.cameraCenteringAxisMustBeBothXOr".into()));
        }
        let callback = crate::bounds::Callback::of(self, "centerCamera", &[Value::str(axis), indices.clone()], options)?;
        if let Some(callback) = &callback { crate::bounds::require_function(callback)?; }
        if self.selection.uids.is_empty() {
            if let Some(callback) = &callback { callback.finish()?; }
            return Ok(Value::Num(0.0));
        }
        let result = self.camera_edit_at(indices_of(indices).as_ref(), |editor, target| {
            let Some(callback) = &callback else { return Ok(None) };
            let frame = editor.evaluated(target.tick, true)?;
            let (mut min, mut max) = ([f64::INFINITY; 2], [f64::NEG_INFINITY; 2]);
            let objects = crate::frame::objects_of(&frame);
            // `geometry.objects` is populated parents first, in the existing hierarchy
            // traversal; callbacks see that order rather than native object-slot order.
            let (_, order) = crate::range_plan::hierarchy(&objects).map_err(|_| EditError::Unported("bounds requests with unresolved joins".into()))?;
            let selected: Vec<(usize, u32)> = order.into_iter().filter_map(|slot| Some((slot, uid(&objects[slot]).filter(|id| editor.selection.uids.contains(id))?))).collect();
            let measured = match callback {
                crate::bounds::Callback::App => editor.app_bounds(&frame, &selected.iter().map(|(slot, _)| *slot).collect::<Vec<_>>())?,
                _ => std::collections::HashMap::new(),
            };
            for (slot, id) in selected {
                let b = match callback {
                    crate::bounds::Callback::Recorded(shared) => {
                        let raw = shared.borrow_mut().request(id)?;
                        [num(&raw, "minX"), num(&raw, "minY"), num(&raw, "maxX"), num(&raw, "maxY")]
                    }
                    // A figure without geometry is not asked.
                    _ => match measured.get(&slot) { Some(b) => b.map(Some), None => continue },
                };
                if !b.iter().all(|v| v.is_some_and(f64::is_finite)) { continue; }
                min = [min[0].min(b[0].unwrap()), min[1].min(b[1].unwrap())];
                max = [max[0].max(b[2].unwrap()), max[1].max(b[3].unwrap())];
            }
            if !min[0].is_finite() { return Ok(None); }
            let mut next = target.camera.as_obj().cloned().unwrap_or_default();
            if axis != "y" { next.set("x", Value::Num((min[0] + max[0] - num(&editor.report, "canvas_width").unwrap_or(f64::NAN)) / 2.0)); }
            if axis != "x" { next.set("y", Value::Num((min[1] + max[1] - num(&editor.report, "canvas_height").unwrap_or(f64::NAN)) / 2.0)); }
            Ok(Some(Value::object(next)))
        })?;
        if let Some(callback) = &callback { callback.finish()?; }
        Ok(result)
    }

    /// `copyCamera()`.
    pub(crate) fn copy_camera(&mut self) -> Result<Value, EditError> {
        self.camera_sheet("copyCamera")?;
        let camera = checked(&camera_values(self.shown_frame()?.get("camera")))?;
        self.camera_clipboard = Some(camera.clone());
        Ok(camera)
    }

    /// `pasteCamera(indices)`.
    pub(crate) fn paste_camera(&mut self, indices: &Value) -> Result<Value, EditError> {
        self.camera_sheet("pasteCamera")?;
        let Some(values) = self.camera_clipboard.clone() else { return Ok(Value::Num(0.0)) };
        let patch: Vec<(&str, Value)> = FIELDS.iter().map(|key| (*key, values.get(key).cloned().unwrap_or(Value::Null))).collect();
        self.camera_edit(indices_of(indices).as_ref(), |camera| {
            let mut out = camera.as_obj().cloned().unwrap_or_default();
            for (key, value) in &patch {
                out.set(key, value.clone());
            }
            Some(Value::object(out))
        })
    }

    /// `setCameraValues(patch, indices)`.
    pub(crate) fn set_camera_values(&mut self, patch: &Value, indices: &Value) -> Result<Value, EditError> {
        self.camera_sheet("setCameraValues")?;
        let patch = checked_patch(patch)?;
        if patch.is_empty() {
            return Ok(Value::Num(0.0));
        }
        let patch: Vec<(&str, f64)> = patch.iter().map(|(k, v)| (k.as_str(), *v)).collect();
        self.camera_edit(indices_of(indices).as_ref(), |camera| Some(with(camera, &patch)))
    }

    /// `resetCamera(indices)`.
    pub(crate) fn reset_camera(&mut self, indices: &Value) -> Result<Value, EditError> {
        self.camera_sheet("resetCamera")?;
        self.camera_edit(indices_of(indices).as_ref(), |camera| {
            let mut out = camera.as_obj().cloned().unwrap_or_default();
            out.set("is_default", Value::Bool(true));
            for (key, value) in [("x", 0.0), ("y", 0.0), ("scale", 1.0), ("angle_rad", 0.0)] {
                out.set(key, Value::Num(value));
            }
            Some(Value::object(out))
        })
    }

    /// `transformCamera(delta, indices)`: offsets for position and angle, a factor for scale.
    pub(crate) fn transform_camera(&mut self, delta: &Value, indices: &Value) -> Result<Value, EditError> {
        self.camera_sheet("transformCamera")?;
        let delta = checked_patch(delta)?;
        let get = |key: &str, fallback: f64| delta.iter().find(|(k, _)| k == key).map_or(fallback, |(_, v)| *v);
        let (dx, dy, da, ds) = (get("x", 0.0), get("y", 0.0), get("angle_rad", 0.0), get("scale", 1.0));
        self.camera_edit(indices_of(indices).as_ref(), |camera| {
            Some(with(camera, &[("x", field(camera, "x") + dx), ("y", field(camera, "y") + dy), ("angle_rad", field(camera, "angle_rad") + da), ("scale", field(camera, "scale") * ds)]))
        })
    }

    /// `alignCameraToView({x, y, scale, width, height}, indices)`: the camera framing what the
    /// canvas view shows.
    pub(crate) fn align_camera_to_view(&mut self, view: &Value, indices: &Value) -> Result<Value, EditError> {
        self.camera_sheet("alignCameraToView")?;
        let mut values = [0.0; 5];
        for (slot, key) in values.iter_mut().zip(["x", "y", "scale", "width", "height"]) {
            *slot = view.get(key).and_then(Value::as_f64).filter(|v| v.is_finite()).ok_or_else(|| {
                let mut label = Obj::new();
                label.set("messageKey", Value::str("errors.editorCamera.canvasValueLabel"));
                label.set("messageParams", Value::object(std::iter::once((std::sync::Arc::from("field"), Value::str(key))).collect()));
                label.set("diagnosticValue", Value::str(&format!("Canvas {key}")));
                crate::invalid_with(FINITE, vec![("label", Value::object(label))])
            })?;
        }
        let [x, y, scale, width, height] = values;
        if scale <= 0.0 || width <= 0.0 || height <= 0.0 {
            return Err(EditError::Invalid("errors.editorCamera.canvasDimensionsAndZoomMustBePositive".into()));
        }
        let (w, h) = (num(&self.report, "canvas_width").unwrap_or(f64::NAN), num(&self.report, "canvas_height").unwrap_or(f64::NAN));
        let patch = [("x", (width / 2.0 - x) / scale - w / 2.0), ("y", (height / 2.0 - y) / scale - h / 2.0), ("scale", (width / w).min(height / h) / scale)];
        self.camera_edit(indices_of(indices).as_ref(), |camera| Some(with(camera, &patch)))
    }

    /// `neighborIndex(editor, direction)`.
    fn neighbour_index(&self, direction: f64) -> Result<Option<usize>, EditError> {
        if direction != -1.0 && direction != 1.0 {
            return Err(EditError::Invalid("errors.editorCamera.chooseThePrevious1OrNext1Frame".into()));
        }
        let index = self.frame_index as i64 + direction as i64;
        let count = self.report.get("keyframes").and_then(Value::array_len).unwrap_or(0) as i64;
        Ok((index >= 0 && index < count).then_some(index as usize))
    }

    /// `locateCamera(direction, channel, indices)`: the neighbouring key's camera values.
    pub(crate) fn locate_camera(&mut self, direction: f64, channel: &str, indices: &Value) -> Result<Value, EditError> {
        self.camera_sheet("locateCamera")?;
        let keys: &[&str] = match channel {
            "position" => &["x", "y"],
            "rotation" => &["angle_rad"],
            "scale" => &["scale"],
            "pose" => &FIELDS,
            _ => return Err(EditError::Invalid("errors.editorCamera.chooseCameraPositionRotationScaleOrPose".into())),
        };
        let Some(index) = self.neighbour_index(direction)? else { return Ok(Value::Num(0.0)) };
        let Some(row) = crate::timeline::rows(&self.report).get(index).copied() else { return Ok(Value::Num(0.0)) };
        let camera = camera_values(self.evaluated(row.start, true)?.get("camera"));
        let mut patch = Obj::new();
        for key in keys {
            patch.set(key, camera.get(key).cloned().unwrap_or(Value::Null));
        }
        self.set_camera_values(&Value::object(patch), indices)
    }

    /// `locateHandle(direction, {uid, jointIndex, handleId, editMode})`: the handle's figure
    /// moved by where the handle is on the neighbouring key.
    pub(crate) fn locate_handle(&mut self, direction: f64, options: &Value) -> Result<bool, EditError> {
        let id = match options.get("uid") {
            Some(value) => value.as_f64().filter(|v| v.fract() == 0.0 && *v >= 0.0).map(|v| v as u32),
            None => self.selection.uid,
        };
        let joint = options.get("jointIndex").and_then(Value::as_f64).map_or(self.selection.joint, |j| j as i64);
        if options.get("editMode").is_some_and(Value::truthy) {
            let mut edit = Obj::new();
            edit.set("uid", id.map_or(Value::Null, |u| Value::Num(u as f64)));
            edit.set("jointIndex", Value::Num(joint as f64));
            if let Some(handle) = options.get("handleId").filter(|h| !h.is_null()) {
                edit.set("handleId", handle.clone());
            }
            return self.locate_edited_handle(direction, &Value::object(edit));
        }
        self.finish_gesture()?;
        let Some(index) = self.neighbour_index(direction)? else { return Ok(false) };
        let current = self.selection_frame()?;
        let Some(object) = id.and_then(|id| current.iter().find(|o| uid(o) == Some(id))).cloned() else { return Ok(false) };
        let Some(row) = crate::timeline::rows(&self.report).get(index).copied() else { return Ok(false) };
        let neighbour = self.evaluated(row.start, true)?;
        let id = id.unwrap();
        if !crate::frame::objects_of(&neighbour).iter().any(|o| uid(o) == Some(id)) {
            return Ok(false);
        }
        let segments: Vec<Value> = self.figure_record(&object).and_then(|f| f.get("segments").and_then(Value::elements).map(|e| e.iter().collect())).unwrap_or_default();
        let handle = match options.get("handleId").filter(|h| !h.is_null()) {
            Some(value) => value.as_f64().unwrap_or(f64::NAN),
            None if joint < 0 => 0.0,
            None => segments.get(joint as usize).and_then(|s| num(s, "segment_id")).unwrap_or(f64::NAN),
        };
        if !(handle.fract() == 0.0 && handle >= 0.0) {
            return Ok(false);
        }
        // `buildGeometry(report, selectionFrame)`: the frame on show.
        let source = self.joint_in_frame(&self.shown_frame()?, id, handle)?;
        let target = self.joint_in_frame(&neighbour, id, handle)?;
        let (Some(source), Some(target)) = (source, target) else { return Ok(false) };
        let (dx, dy) = (target[0] - source[0], target[1] - source[1]);
        if dx == 0.0 && dy == 0.0 {
            return Ok(false);
        }
        if !self.selection.uids.contains(&id) {
            self.select(Some(id), joint, false, false)?;
        }
        self.begin_drag(if direction < 0.0 { "Locate handle in previous frame" } else { "Locate handle in next frame" }, true)?;
        let result = self.move_selection(dx, dy, &Value::Null).and_then(|_| self.commit_drag());
        if result.is_err() {
            self.cancel_drag()?;
        }
        result
    }

    /// `applyCameraToFigures(indices, {ticks})` on a layer sheet (`applyAuthoredCameraToFigures`):
    /// at each chosen frame whose camera is not the identity, every figure keyed where the
    /// camera shows it (root, scale and rotation through the inverse camera) and the camera
    /// keyed back to the identity. Returns how many frames changed.
    pub(crate) fn apply_camera_to_figures(&mut self, indices: &Value, options: &Value) -> Result<Value, EditError> {
        self.camera_sheet("applyCameraToFigures")?;
        self.finish_gesture()?;
        if self.report.path(&["_styk", "layers", "fixed", "camera", "visible"]).is_some_and(|v| matches!(v, Value::Bool(false))) {
            return Ok(Value::Num(0.0));
        }
        let parsed = crate::range::Indices::parse(indices_of(indices).as_ref());
        let ticks: Vec<f64> = match options.get("ticks").filter(|t| !t.is_null()) {
            Some(ticks) => ticks.elements().map(|e| e.iter().map(|t| t.as_f64().unwrap_or(f64::NAN)).collect()).unwrap_or_default(),
            None => self.sheet_edit_times(parsed.as_ref())?,
        };
        // `_frameIndices(indices)` checks the indices even when ticks are given.
        self.frame_indices(parsed.as_ref())?;
        let mut times: Vec<f64> = Vec::new();
        for tick in ticks {
            if !times.iter().any(|t| *t == tick || (t.is_nan() && tick.is_nan())) {
                times.push(tick);
            }
        }
        times.sort_by(f64::total_cmp);
        let end = crate::timeline::total_ticks(&crate::timeline::rows(&self.report));
        if times.iter().any(|t| t.fract() != 0.0 || !(*t >= 0.0 && *t < end)) {
            return Err(EditError::Invalid("errors.cameraBakeAuthored.chooseWholeDisplayFramesInsideThisAnimation".into()));
        }
        let figures = crate::sheet::items(self.report.get("figure_types"));
        let (cx, cy) = (num(&self.report, "canvas_width").unwrap_or(640.0) / 2.0, num(&self.report, "canvas_height").unwrap_or(480.0) / 2.0);
        // Every value is read before any key is written; one entry a channel, its ticks in order.
        let mut points: Vec<(String, Value, &'static str, Vec<(f64, Value)>)> = Vec::new();
        let mut put = |target: &Value, property: &'static str, tick: f64, value: f64| -> Result<(), EditError> {
            let id = crate::property_edit::channel_id(target, property)?;
            let value = crate::property_edit::validate_value(target, property, Some(&Value::Num(value)))?;
            match points.iter_mut().find(|(i, ..)| *i == id) {
                Some((_, _, _, values)) => match values.iter_mut().find(|(t, _)| *t == tick) {
                    Some(slot) => slot.1 = value,
                    None => values.push((tick, value)),
                },
                None => points.push((id, target.clone(), property, vec![(tick, value)])),
            }
            Ok(())
        };
        let mut changed = 0usize;
        for &tick in &times {
            let frame = self.evaluated(tick, true)?;
            let Some(camera) = self.effective_camera(&frame, true, tick)? else { continue };
            let [a, b, c, d] = crate::handle_commands::camera_linear(&camera, 1.0)?;
            let number = |key: &str, fallback: f64| camera.get(key).filter(|v| !v.is_null()).map_or(fallback, |v| v.as_f64().unwrap_or(f64::NAN));
            let (px, py) = (cx + number("x", 0.0), cy + number("y", 0.0));
            let (e, f) = (0.0 + cx * 1.0 - a * px + b * py, 0.0 + cy * 1.0 - b * px - a * py);
            let scale = (1.0f32 / (number("scale", 1.0) as f32)) as f64;
            let angle = number("angle_rad", 0.0);
            let roots = self.frame_roots(&frame)?;
            for object in crate::frame::objects_of(&frame) {
                let Some(id) = uid(&object) else { continue };
                let mut target = Obj::new();
                target.set("kind", Value::str("figure"));
                target.set("uid", Value::Num(id as f64));
                let target = Value::object(target);
                let root = roots.iter().find(|(u, _)| *u == id).map(|(_, r)| *r).unwrap_or([num(&object, "root_x").unwrap_or(f64::NAN), num(&object, "root_y").unwrap_or(f64::NAN)]);
                put(&target, "x", tick, a * root[0] + c * root[1] + e)?;
                put(&target, "y", tick, b * root[0] + d * root[1] + f)?;
                put(&target, "scale", tick, num(&object, "scale").unwrap_or(f64::NAN) * scale)?;
                let base = figures.iter().find(|fig| fig.get("figure_type_id") == object.get("figure_type_id")).and_then(|fig| fig.get("segments").and_then(|s| s.item(0))).and_then(|seg| seg.get("angle_rad").filter(|v| !v.is_null()).and_then(Value::as_f64)).unwrap_or(0.0);
                let first = object.get("angles").and_then(|angles| angles.item(0)).filter(|v| !v.is_null()).and_then(|v| v.as_f64()).unwrap_or(0.0);
                put(&target, "rotation", tick, first - base - angle)?;
            }
            let mut target = Obj::new();
            target.set("kind", Value::str("camera"));
            let target = Value::object(target);
            for property in ["x", "y", "scale", "rotation"] {
                put(&target, property, tick, if property == "scale" { 1.0 } else { 0.0 })?;
            }
            changed += 1;
        }
        if changed == 0 {
            return Ok(Value::Num(0.0));
        }
        let mut entries = Vec::new();
        for (_, target, property, values) in points {
            for (tick, value) in values {
                let mut entry = Obj::new();
                entry.set("target", target.clone());
                entry.set("property", Value::str(property));
                entry.set("tick", Value::Num(tick));
                entry.set("value", value);
                entries.push(Value::object(entry));
            }
        }
        self.sheet_property_entries(&entries, "Apply camera to figures")?;
        Ok(Value::Num(changed as f64))
    }

    /// Each figure's root as `buildGeometry(report, frame)` places it, by identity.
    fn frame_roots(&self, frame: &Value) -> Result<Vec<(u32, [f64; 2])>, EditError> {
        let prepared = self.prepared()?;
        let typed = self.eval.borrow_mut().loader.edit_frame(frame, None, &prepared.doc).map_err(|error| EditError::Invalid(error.to_string()))?;
        let scene = styk_eval::geometry::build(&prepared.doc, &typed);
        Ok(scene.objects.iter().filter(|g| g.resolved).map(|g| (g.uid, g.root)).collect())
    }

    /// `beginCameraDrag({indices, label})`.
    pub(crate) fn begin_camera_drag(&mut self, options: &Value) -> Result<bool, EditError> {
        self.camera_sheet("beginCameraDrag")?;
        self.finish_gesture()?;
        let indices = options.get("indices").filter(|i| !i.is_null()).cloned();
        let label = options.get("label").and_then(Value::as_str).unwrap_or("Move camera").to_string();
        let selected = self.frame_indices(crate::range::Indices::parse(indices.as_ref()).as_ref())?;
        if selected.is_empty() {
            return Ok(false);
        }
        let baseline = self.camera_targets(indices.as_ref())?;
        self.drag = Some(crate::Drag {
            label,
            translation: false,
            index: self.frame_index,
            before: Vec::new(),
            before_selection: self.selection_state(),
            changed: false,
            detached: Default::default(),
            authored: false,
            rotation_targets: Default::default(),
            spatial_gestures: Default::default(),
            spatial_kinds: Default::default(),
            ik_captures: Default::default(),
            spatial_ik_captures: Default::default(),
            ik_resume: Default::default(),
            handle_edit: None,
            figure_handle: None,
            segment_value_options: None,
            camera: Some(CameraDrag { indices: selected, current: baseline.clone(), baseline, entries: Vec::new(), preview: None }),
            rig: None,
            motion_path: None,
            duplicate: None,
            tweener: None,
            serial: self.next_drag_serial(),
        });
        self.retained = None;
        Ok(true)
    }

    /// `updateCameraDrag(delta, {fromStart})`: the keys previewed on the frame on show.
    pub(crate) fn update_camera_drag(&mut self, delta: &Value, options: &Value) -> Result<bool, EditError> {
        self.camera_sheet("updateCameraDrag")?;
        let delta = match checked_patch(delta) {
            Ok(delta) => delta,
            Err(error) => {
                if self.camera_drag().is_some() {
                    self.cancel_camera_drag()?;
                }
                return Err(error);
            }
        };
        if self.camera_drag().is_none() && !self.begin_camera_drag(&Value::Null)? {
            return Ok(false);
        }
        if self.drag.as_ref().is_some_and(|d| d.index != self.frame_index) {
            self.cancel_camera_drag()?;
            return Err(EditError::Invalid("errors.editorCamera.theDocumentOrFrameChangedDuringTheCamera".into()));
        }
        let from_start = options.get("fromStart").is_none_or(Value::truthy);
        let get = |key: &str, fallback: f64| delta.iter().find(|(k, _)| k == key).map_or(fallback, |(_, v)| *v);
        let (dx, dy, da, ds) = (get("x", 0.0), get("y", 0.0), get("angle_rad", 0.0), get("scale", 1.0));
        let result = (|| {
            let drag = self.camera_drag().unwrap();
            let mut values = Vec::with_capacity(drag.baseline.len());
            for (i, entry) in drag.baseline.iter().enumerate() {
                let camera = camera_values(Some(if from_start { &entry.camera } else { &drag.current[i].camera }));
                let next = checked(&with(&camera, &[("x", field(&camera, "x") + dx), ("y", field(&camera, "y") + dy), ("angle_rad", field(&camera, "angle_rad") + da), ("scale", field(&camera, "scale") * ds)]))?;
                values.push(Target { index: entry.index, tick: entry.tick, camera: next });
            }
            let entries = key_entries(&drag.baseline, &values);
            let preview = self.camera_preview(&drag.baseline, &entries)?;
            Ok::<_, EditError>((values, entries, preview))
        })();
        let (values, entries, preview) = match result {
            Ok(done) => done,
            Err(error) => {
                self.cancel_camera_drag()?;
                return Err(error);
            }
        };
        let frames: Vec<Value> = values.iter().map(|v| Value::Num(v.index as f64)).collect();
        let drag = self.drag.as_mut().unwrap();
        drag.changed = !entries.is_empty();
        let camera = drag.camera.as_mut().unwrap();
        camera.current = values;
        camera.entries = entries;
        camera.preview = Some(preview);
        self.retained = None;
        self.emit("edit", vec![("live", Value::Bool(true)), ("camera", Value::Bool(true)), ("animation", Value::Bool(true)), ("changedFrames", Value::array(frames))]);
        Ok(true)
    }

    /// `previewCameraKeys` on a layer sheet: the frame on show with the drag's camera at the playhead.
    fn camera_preview(&self, baseline: &[Target], entries: &[Value]) -> Result<Value, EditError> {
        let shown = self.shown_frame()?;
        let mut camera = camera_values(shown.get("camera")).as_obj().cloned().unwrap_or_default();
        if let Some(entry) = baseline.iter().find(|e| e.tick == self.tick)
            && let Some(object) = entry.camera.as_obj()
        {
            for (key, value) in object.iter() {
                camera.set(key, value.clone());
            }
        }
        for entry in entries {
            if entry.get("tick").and_then(Value::as_f64) == Some(self.tick) {
                let property = entry.get("property").and_then(Value::as_str).unwrap_or("");
                camera.set(if property == "rotation" { "angle_rad" } else { property }, entry.get("value").cloned().unwrap_or(Value::Null));
            }
        }
        let mut frame = shown.as_obj().cloned().unwrap_or_default();
        frame.set("camera", checked(&Value::object(camera))?);
        Ok(Value::object(frame))
    }

    pub(crate) fn camera_drag(&self) -> Option<&CameraDrag> {
        self.drag.as_ref().and_then(|d| d.camera.as_ref())
    }

    /// `commitCameraDrag()`: the previewed keys added as one edit.
    pub(crate) fn commit_camera_drag(&mut self) -> Result<bool, EditError> {
        let Some(camera) = self.drag.take().and_then(|d| d.camera) else { return Ok(false) };
        self.retained = None;
        if camera.entries.is_empty() {
            return Ok(false);
        }
        self.add_animation_keys(Some(&Value::array(camera.entries)))?;
        Ok(true)
    }

    /// `cancelCameraDrag()`.
    pub(crate) fn cancel_camera_drag(&mut self) -> Result<bool, EditError> {
        let Some(camera) = self.drag.take().and_then(|d| d.camera) else { return Ok(false) };
        self.retained = None;
        let frames: Vec<Value> = camera.indices.iter().map(|i| Value::Num(*i as f64)).collect();
        self.emit("edit", vec![("label", Value::str("Cancel camera move")), ("camera", Value::Bool(true)), ("changedFrames", Value::array(frames))]);
        Ok(true)
    }

    /// While a camera drag is open only its own calls and camera commands run here.
    pub(crate) fn camera_gate(&self, method: &str) -> Result<(), EditError> {
        if self.camera_drag().is_none() {
            return Ok(());
        }
        const ALLOWED: [&str; 15] = ["updateCameraDrag", "commitCameraDrag", "cancelCameraDrag", "beginCameraDrag", "commitDrag", "cancelDrag", "copyCamera", "pasteCamera", "setCameraValues", "resetCamera", "transformCamera", "centerCamera", "alignCameraToView", "locateCamera", "locateHandle"];
        if ALLOWED.contains(&method) { Ok(()) } else { Err(EditError::Unported(format!("{method} during a camera drag"))) }
    }
}
