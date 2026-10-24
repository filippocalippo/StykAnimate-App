//! Whole-figure transforms by a handle (src/editor-figure-transform.mjs): Alt-dragging a
//! handle turns and scales the selected figures, and those joined below them, about the
//! dragged figure's origin (`beginFigureHandleDrag`, `transformFigureHandle`,
//! `commitFigureHandleDrag`, `cancelFigureHandleDrag`).

use styk_doc::{Obj, Value};

use crate::record::{num, uid};
use crate::{EditError, Editor};

const EPS: f64 = 1e-9;
const NOT_FINITE: &str = "errors.editorFigureTransform.transformCoordinatesMustBeFinite";

/// `createFigureHandleTransform` and the angle it has turned through.
#[derive(Clone, Debug)]
struct Transform {
    origin: [f64; 2],
    distance: f64,
    last_angle: f64,
    rotation: f64,
}

/// `_drag.figureHandle`.
#[derive(Clone, Debug)]
pub(crate) struct FigureHandle {
    uid: Option<u32>,
    rotate: bool,
    scale: bool,
    transform: Transform,
    /// The figures that move, by slot, with their snapshots.
    targets: Vec<(usize, Value)>,
}

impl FigureHandle {
    /// What the interface reads of the gesture (`_drag.figureHandle`): the figure it turns about
    /// its origin, the toolbar's locks it began with, and where the turns stand.
    pub(crate) fn live(&self) -> Value {
        let mut value = Obj::new();
        value.set("uid", self.uid.map_or(Value::Null, |uid| Value::Num(uid as f64)));
        value.set("rotate", Value::Bool(self.rotate));
        value.set("scale", Value::Bool(self.scale));
        value.set("origin", Value::nums(&self.transform.origin));
        value.set("distance", Value::Num(self.transform.distance));
        value.set("lastAngle", Value::Num(self.transform.last_angle));
        value.set("rotation", Value::Num(self.transform.rotation));
        Value::object(value)
    }
}

fn coordinates(x: f64, y: f64) -> Result<(), EditError> {
    if x.is_finite() && y.is_finite() { Ok(()) } else { Err(EditError::Invalid(NOT_FINITE.into())) }
}

/// `createFigureHandleTransform(origin, start)`.
fn create_transform(origin: [f64; 2], start: [f64; 2]) -> Result<Transform, EditError> {
    coordinates(origin[0], origin[1])?;
    coordinates(start[0], start[1])?;
    let (dx, dy) = (start[0] - origin[0], start[1] - origin[1]);
    let distance = styk_math::hypot(dx, dy);
    if !(distance > EPS) {
        return Err(EditError::Invalid("errors.editorFigureTransform.dragAHandleAwayFromTheFigureOrigin".into()));
    }
    Ok(Transform { origin, distance, last_angle: styk_math::atan2(dy, dx), rotation: 0.0 })
}

/// `figureHandleTransform(state, point, {rotate, scale, ctrlKey, shiftKey})`: the rotation,
/// crossings of ±π accumulated, and the scale against the starting distance.
fn handle_transform(state: &mut Transform, point: [f64; 2], rotate: bool, scale: bool, ctrl: bool, shift: bool) -> Result<(f64, f64), EditError> {
    coordinates(point[0], point[1])?;
    let (dx, dy) = (point[0] - state.origin[0], point[1] - state.origin[1]);
    let distance = styk_math::hypot(dx, dy);
    if distance > EPS {
        let angle = styk_math::atan2(dy, dx);
        state.rotation += styk_math::shortest(angle - state.last_angle);
        state.last_angle = angle;
    }
    Ok((if rotate && !shift { state.rotation } else { 0.0 }, if scale && !ctrl { distance / state.distance } else { 1.0 }))
}

/// An option given as a boolean (`{rotate = fallback}` when absent).
fn flag(options: &Value, key: &str, fallback: bool) -> bool {
    options.get(key).map_or(fallback, Value::truthy)
}

impl Editor {
    /// `beginFigureHandleDrag(x, y, {rotate, scale, joint, label})`.
    pub(crate) fn begin_figure_handle_drag(&mut self, x: Option<f64>, y: Option<f64>, options: &Value) -> Result<bool, EditError> {
        let (rotate, scale) = (flag(options, "rotate", true), flag(options, "scale", true));
        let joint = options.get("joint").and_then(Value::as_f64).map_or(self.selection.joint, |j| j as i64);
        let label = options.get("label").and_then(Value::as_str).unwrap_or("Transform figure").to_string();
        let Some((_, object)) = self.object()? else { return Ok(false) };
        let segments = self.report.get("figure_types").and_then(Value::elements).and_then(|f| f.iter().find(|f| num(f, "figure_type_id") == num(&object, "figure_type_id"))).and_then(|f| f.get("segments").and_then(Value::array_len)).unwrap_or(0);
        if joint < 0 || joint as usize >= segments {
            return Ok(false);
        }
        let joint = joint as usize;
        let original = self.figure_geometry()?;
        let handle = original.as_ref().and_then(|(_, ends)| ends.get(joint).copied());
        let (x, y) = (x.or(handle.map(|h| h[0])).unwrap_or(f64::NAN), y.or(handle.map(|h| h[1])).unwrap_or(f64::NAN));
        coordinates(x, y)?;
        let Some((root, _)) = original.filter(|_| num(&object, "scale").unwrap_or(f64::NAN).abs() > EPS) else {
            return Err(EditError::Invalid("errors.editorFigureTransform.increaseFigureScaleBeforeTransformingAHandle".into()));
        };
        // Checked before the gesture begins: an invalid start leaves history alone.
        let transform = create_transform(root, [x, y])?;
        if !self.begin_drag(&label, false)? {
            return Ok(false);
        }
        // The selected figures, then what is joined below them.
        let objects = self.frame_objects();
        let mut queue: Vec<usize> = objects.iter().enumerate().filter(|(_, o)| uid(o).is_some_and(|u| self.selection.uids.contains(&u))).map(|(slot, _)| slot).collect();
        let mut cursor = 0;
        while cursor < queue.len() {
            let parent = queue[cursor] as f64;
            cursor += 1;
            for (slot, object) in objects.iter().enumerate() {
                let joined = object.get("join").filter(|j| j.truthy()).and_then(|j| num(j, "target_object_slot")) == Some(parent);
                if joined && !queue.contains(&slot) {
                    queue.push(slot);
                }
            }
        }
        let before = &self.drag.as_ref().unwrap().before;
        let mut targets = Vec::with_capacity(queue.len());
        for slot in queue {
            let Some(snapshot) = before.iter().find(|o| uid(o) == uid(&objects[slot])) else {
                self.cancel_drag()?;
                return Err(EditError::Unported("a handle transform of a figure outside its gesture".into()));
            };
            targets.push((slot, snapshot.clone()));
        }
        self.drag.as_mut().unwrap().figure_handle = Some(FigureHandle { uid: self.selection.uid, rotate, scale, transform, targets });
        Ok(true)
    }

    /// The selected figure's root and handle ends as drawn (`geometry.objects.get(selectedSlot)`).
    fn figure_geometry(&self) -> Result<Option<([f64; 2], Vec<[f64; 2]>)>, EditError> {
        let Some(id) = self.selection.uid else { return Ok(None) };
        if !self.selection_frame()?.iter().any(|o| uid(o) == Some(id)) {
            return Ok(None);
        }
        let (_, _, scene) = self.evaluate()?;
        Ok(scene.objects.iter().find(|g| g.uid == id && g.resolved).map(|g| (g.root, g.ends.clone())))
    }

    /// `transformFigureHandle(x, y, {rotate, scale, ctrlKey, shiftKey})`: one edit unless a
    /// handle transform is in progress.
    pub(crate) fn transform_figure_handle(&mut self, x: f64, y: f64, options: &Value) -> Result<bool, EditError> {
        coordinates(x, y)?;
        let active = self.drag.as_ref().is_some_and(|d| d.figure_handle.is_some());
        if !active && !self.begin_figure_handle_drag(None, None, options)? {
            return Ok(false);
        }
        let drag = self.drag.as_mut().unwrap();
        let mut edit = drag.figure_handle.take().unwrap();
        if drag.index != self.frame_index || edit.uid != self.selection.uid {
            self.cancel_drag()?;
            return Err(EditError::Invalid("errors.editorFigureTransform.theSelectedFigureChangedDuringItsGesture".into()));
        }
        let (rotate, scale) = (flag(options, "rotate", edit.rotate), flag(options, "scale", edit.scale));
        let result = handle_transform(&mut edit.transform, [x, y], rotate, scale, flag(options, "ctrlKey", false), flag(options, "shiftKey", false)).and_then(|(radians, factor)| {
            self.apply_figure_handle(&edit, radians, factor);
            self.drag.as_mut().unwrap().figure_handle = Some(edit);
            self.touch()?;
            if !active { self.commit_drag().map(|_| ()) } else { Ok(()) }
        });
        if let Err(error) = result {
            self.cancel_drag()?;
            return Err(error);
        }
        Ok(true)
    }

    fn apply_figure_handle(&mut self, edit: &FigureHandle, radians: f64, factor: f64) {
        let (cos, sin) = (styk_math::cos(radians), styk_math::sin(radians));
        let origin = edit.transform.origin;
        let unchanged = radians.abs() < EPS && (factor - 1.0).abs() < EPS;
        let figures: Vec<Value> = self.report.get("figure_types").and_then(Value::elements).map(|items| items.iter().collect()).unwrap_or_default();
        for (slot, before) in &edit.targets {
            let Some(object) = self.frame_object_mut(*slot) else { continue };
            if let Some(support) = before.get("_stykAnimationOrigin").filter(|o| o.truthy()) {
                object.set("_stykAnimationOrigin", support.clone());
            }
            let angles: Vec<Value> = before.get("angles").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
            if unchanged {
                // Back where it started: the figure as it was.
                if before.get("root_x").is_some() {
                    restore(object, before, "root_x");
                    restore(object, before, "root_y");
                } else {
                    object.remove("root_x");
                    object.remove("root_y");
                }
                restore(object, before, "scale");
                for (index, angle) in angles.iter().enumerate() {
                    set_value(object, index, angle.clone());
                }
                restore(object, before, "runtime_segments");
                continue;
            }
            // Every root orbits and scales toward the dragged figure's origin.
            let (dx, dy) = (num(before, "root_x").unwrap_or(0.0) - origin[0], num(before, "root_y").unwrap_or(0.0) - origin[1]);
            object.set("root_x", Value::Num(origin[0] + (dx * cos - dy * sin) * factor));
            object.set("root_y", Value::Num(origin[1] + (dx * sin + dy * cos) * factor));
            object.set("scale", Value::Num(num(before, "scale").unwrap_or(f64::NAN) * factor));
            for (index, angle) in angles.iter().enumerate() {
                // `before.angles[index] + radians`: a hole (null) adds as 0.
                let value = if angle.is_null() { 0.0 } else { angle.as_f64().unwrap_or(f64::NAN) };
                set_value(object, index, Value::Num(value + radians));
            }
            if let Some(figure) = figures.iter().find(|figure| num(figure, "figure_type_id") == object.get("figure_type_id").and_then(Value::as_f64)) {
                crate::origin::rotate_support(figure, object, radians);
            }
            object.remove("runtime_segments");
        }
    }

    /// `commitFigureHandleDrag()` and `cancelFigureHandleDrag()`.
    pub(crate) fn finish_figure_handle_drag(&mut self, commit: bool) -> Result<bool, EditError> {
        if !self.drag.as_ref().is_some_and(|d| d.figure_handle.is_some()) {
            return Ok(false);
        }
        if commit { self.commit_drag() } else { self.cancel_drag() }
    }
}

/// `object[key] = before[key]`, dropped when the snapshot has none.
fn restore(object: &mut styk_doc::Obj, before: &Value, key: &str) {
    match before.get(key) {
        Some(value) => object.set(key, value.clone()),
        None => {
            object.remove(key);
        }
    }
}

/// `object.angles[index] = value`.
fn set_value(object: &mut styk_doc::Obj, index: usize, value: Value) {
    let Some(array) = object.get_mut("angles") else { return };
    let Some(list) = array.make_arr() else { return };
    if index >= list.len() {
        list.resize(index + 1, Value::Null);
    }
    list[index] = value;
    array.repack();
}
