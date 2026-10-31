//! A 3D rig's perspective and part proportions: small authored
//! values on the pose (`_stykSpatial`), evaluated by the rig graph and the projection as ever.
//!
//! Ported: `setSpatialCamera`, `setSpatialProportions` and `resetSpatialProportions`. The reads
//! the interface makes (`getSpatialCamera`, `getSpatialProportions`) stay on the read view.

use std::collections::HashSet;

use styk_doc::{Obj, Value};

use crate::history::js_strict_eq;
use crate::{EditError, Editor};

/// `Number.isFinite(v)`: only a number is finite here, with no coercion.
fn finite(value: &Value) -> Option<f64> {
    value.as_f64().filter(|n| n.is_finite())
}

/// `Math.max(a, b)` for the values this module sees (NaN wins, as there).
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.max(b) }
}

/// The selected figure is no longer on the frame being edited.
fn vanished() -> EditError {
    EditError::Unported("the selected figure left the frame".into())
}

/// `spatialBone(segment)`.
fn is_bone(segment: &Value) -> bool {
    segment.path(&["_stykRig", "spatial", "origin"]).is_some_and(Value::truthy)
}

/// A number as JavaScript reads one out of a record (`undefined` is NaN).
fn number(value: Option<Value>) -> f64 {
    value.and_then(|v| v.as_f64()).unwrap_or(f64::NAN)
}

/// `spatialCamera(object)`: `{strength: 0, distance: 600, centerX: root_x ?? 0, centerY: root_y ?? 0, ...camera}`.
fn spatial_camera(object: &Value) -> Obj {
    let mut camera = Obj::new();
    camera.set("strength", Value::Num(0.0));
    camera.set("distance", Value::Num(600.0));
    for (key, root) in [("centerX", "root_x"), ("centerY", "root_y")] {
        camera.set(key, object.get(root).filter(|v| !v.is_null()).cloned().unwrap_or(Value::Num(0.0)));
    }
    if let Some(own) = object.path(&["_stykSpatial", "camera"]).and_then(Value::as_obj) {
        for (key, value) in own.iter() {
            camera.set(key, value.clone());
        }
    }
    camera
}

/// `spatialShape(object, id)`: `{width: 1, taper: 0, ...shape[id]}`.
fn spatial_shape(object: &Value, id: u32) -> Obj {
    let mut shape = Obj::new();
    shape.set("width", Value::Num(1.0));
    shape.set("taper", Value::Num(0.0));
    if let Some(own) = object.path(&["_stykSpatial", "shape", &id.to_string()]).and_then(Value::as_obj) {
        for (key, value) in own.iter() {
            shape.set(key, value.clone());
        }
    }
    shape
}

/// What `getSpatialProportions()` reads of the selected bone.
struct Proportions {
    slot: usize,
    object: Value,
    figure: Value,
    index: usize,
    id: u32,
    can_resize: bool,
    /// The bone's length as a multiple of its definition's (`getSpatialProportions().length`).
    scale: f64,
}

impl Editor {
    /// `{...spatialShape(object, id), canResizeLength, length}` of the selected bone, if it is one.
    fn spatial_proportions(&self) -> Result<Option<Proportions>, EditError> {
        let Some((slot, object)) = self.object()? else { return Ok(None) };
        if self.selection.joint < 0 {
            return Ok(None);
        }
        let index = self.selection.joint as usize;
        let figure = self.figure_value(&object);
        let Some(segment) = figure.get("segments").and_then(|s| s.item(index)).filter(is_bone) else { return Ok(None) };
        let id = segment.get("segment_id").and_then(Value::as_f64).unwrap_or(f64::NAN) as u32;
        let length = number(segment.get("length").cloned());
        let can_resize = length > 1e-9;
        let scale = if can_resize {
            let own = if object.get("len_flag").is_some_and(Value::truthy) { number(object.get("lengths").and_then(|l| l.item(index))) } else { length };
            own / length
        } else {
            1.0
        };
        Ok(Some(Proportions { slot, object, figure, index, id, can_resize, scale }))
    }

    /// `setSpatialCamera(patch)`: perspective strength, distance and centre of the selected 3D figure.
    pub(crate) fn set_spatial_camera(&mut self, patch: &Value) -> Result<bool, EditError> {
        let Some((slot, object)) = self.object()? else { return Ok(false) };
        let figure = self.figure_value(&object);
        if !figure.get("segments").and_then(Value::elements).is_some_and(|segments| segments.iter().any(|s| is_bone(&s))) {
            return Ok(false);
        }
        let current = spatial_camera(&object);
        let mut camera = current.clone();
        if let Some(patch) = patch.as_obj() {
            for (key, value) in patch.iter() {
                camera.set(key, value.clone());
            }
        }
        let mut state = object.get("_stykSpatial").and_then(Value::as_obj).cloned().unwrap_or_default();
        state.set("camera", Value::object(camera.clone()));
        if camera.get("strength").is_some_and(Value::truthy) && !self.perspective_available(&object)? {
            return Err(EditError::Invalid("errors.editorSpatialShape.perspectiveRequiresASingleSpatialFigureSeparateJoined".into()));
        }
        let mut candidate = object.as_obj().cloned().unwrap_or_default();
        candidate.set("_stykSpatial", Value::object(state.clone()));
        crate::load::spatial_pose(&Value::object(candidate), &figure)?;
        if camera.iter().all(|(key, value)| current.get(key).is_some_and(|own| js_strict_eq(value, own))) {
            return Ok(false);
        }
        self.object_edit_with("Adjust perspective", false, move |editor| {
            let record = editor.frame_object_mut(slot).ok_or_else(vanished)?;
            record.set("_stykSpatial", Value::object(state));
            record.remove("runtime_segments");
            Ok(())
        })
    }

    /// `spatialPerspectiveAvailable(selectionFrame.objects, object, figures)`: a figure joined to another, or
    /// with another joined to it, cannot have a perspective of its own (a projected drawing excepted).
    fn perspective_available(&self, object: &Value) -> Result<bool, EditError> {
        if object.get("join").is_some_and(Value::truthy) {
            return Ok(false);
        }
        let objects = self.selection_frame()?;
        let figures: Vec<Value> = self.report.get("figure_types").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
        let slot = object.get("object_slot").and_then(Value::as_f64);
        Ok(!objects.iter().any(|other| {
            other.path(&["join", "target_object_slot"]).and_then(Value::as_f64) == slot && !crate::load::projected_drawing(&objects, other, &figures)
        }))
    }

    /// `setSpatialProportions({size, length, width, taper})` on the selected bone: `size` scales it and the
    /// bones it carries, the rest are local to the bone.
    pub(crate) fn set_spatial_proportions(&mut self, patch: &Value) -> Result<bool, EditError> {
        let Some(before) = self.spatial_proportions()? else { return Ok(false) };
        let entries: Vec<(String, Value)> = patch.as_obj().map(|o| o.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()).unwrap_or_default();
        let given = |key: &str| entries.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone());
        if !before.can_resize && (given("size").is_some() || given("length").is_some()) {
            return Err(EditError::Invalid("errors.editorSpatialShape.useFigureScaleToResizeAZeroLength".into()));
        }
        for (key, value) in &entries {
            let (low, high) = if key == "taper" { (-0.9, 3.0) } else { (0.1, 5.0) };
            let in_range = finite(value).is_some_and(|v| v >= low && v <= high);
            if !["size", "length", "width", "taper"].contains(&key.as_str()) || !in_range {
                return Err(EditError::Invalid("errors.editorSpatialShape.chooseProportionsWithinTheControlRange".into()));
            }
        }
        let segments: Vec<Value> = before.figure.get("segments").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
        let segment_id = |segment: &Value| segment.get("segment_id").and_then(Value::as_f64).unwrap_or(f64::NAN) as u32;
        // Size carries all descendant bones (e.g. foot + toes) as one part. Length, width and taper remain
        // local adjustments; bindings blend their boundaries.
        let mut affected = HashSet::from([before.id]);
        if given("size").is_some() {
            let mut changed = true;
            while changed {
                changed = false;
                for segment in &segments {
                    let parent = segment.path(&["_stykRig", "spatial", "parent"]).and_then(Value::as_f64).map(|p| p as u32);
                    if is_bone(segment) && parent.is_some_and(|p| affected.contains(&p)) && !affected.contains(&segment_id(segment)) {
                        affected.insert(segment_id(segment));
                        changed = true;
                    }
                }
            }
        }
        let factor = given("size").map_or(1.0, |size| size.as_f64().unwrap_or(f64::NAN) / js_max(0.000001, before.scale));
        let mut shape = before.object.path(&["_stykSpatial", "shape"]).and_then(Value::as_obj).cloned().unwrap_or_default();
        let mut lengths: Vec<f64> = if before.object.get("len_flag").is_some_and(Value::truthy) {
            before.object.get("lengths").and_then(|l| l.numbers()).unwrap_or_default()
        } else {
            segments.iter().map(|s| number(s.get("length").cloned())).collect()
        };
        for (i, segment) in segments.iter().enumerate() {
            if !affected.contains(&segment_id(segment)) {
                continue;
            }
            let current = spatial_shape(&before.object, segment_id(segment));
            let mut entry = Obj::new();
            entry.set("width", Value::Num(number(current.get("width").cloned()) * factor));
            entry.set("taper", current.get("taper").cloned().unwrap_or(Value::Null));
            shape.set(&segment_id(segment).to_string(), Value::object(entry));
            if let Some(length) = lengths.get_mut(i) {
                *length *= factor;
            }
        }
        for key in ["width", "taper"] {
            if let Some(value) = given(key) {
                let mut entry = shape.get(&before.id.to_string()).and_then(Value::as_obj).cloned().unwrap_or_default();
                entry.set(key, value);
                shape.set(&before.id.to_string(), Value::object(entry));
            }
        }
        if let Some(value) = given("length")
            && let Some(slot) = lengths.get_mut(before.index)
        {
            *slot = number(segments[before.index].get("length").cloned()) * value.as_f64().unwrap_or(f64::NAN);
        }
        let mut state = before.object.get("_stykSpatial").and_then(Value::as_obj).cloned().unwrap_or_default();
        state.set("shape", Value::object(shape));
        let mut candidate = before.object.as_obj().cloned().unwrap_or_default();
        candidate.set("_stykSpatial", Value::object(state.clone()));
        crate::load::spatial_pose(&Value::object(candidate), &before.figure)?;
        let resizes = given("size").is_some() || given("length").is_some();
        let typed = self.prepared()?.doc.figure(number(before.object.get("figure_type_id").cloned()) as u32).cloned();
        let (slot, index) = (before.slot, before.index);
        self.object_edit_with("Adjust rig proportions", true, move |editor| {
            let record = editor.frame_object_mut(slot).ok_or_else(vanished)?;
            if let Some(figure) = &typed {
                crate::ik::release_spatial_chain(record, figure, index);
            }
            record.set("_stykSpatial", Value::object(state));
            if resizes {
                record.set("lengths", Value::nums(&lengths));
                record.set("len_flag", Value::Num(1.0));
            }
            record.remove("runtime_segments");
            Ok(())
        })
    }

    /// `resetSpatialProportions()`: the selected bone's width, taper and (when it has one) length back to the figure's.
    pub(crate) fn reset_spatial_proportions(&mut self) -> Result<bool, EditError> {
        let Some(before) = self.spatial_proportions()? else { return Ok(false) };
        let mut patch = Obj::new();
        if before.can_resize {
            patch.set("length", Value::Num(1.0));
        }
        patch.set("width", Value::Num(1.0));
        patch.set("taper", Value::Num(0.0));
        self.set_spatial_proportions(&Value::object(patch))
    }
}
