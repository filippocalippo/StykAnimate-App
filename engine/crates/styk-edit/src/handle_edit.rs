//! Handle Edit Mode: a handle of the current pose moved to
//! the pointer, the segments that meet there keeping their arcs (a bend edit keeps the
//! moved end's tangent), the figures joined at it moving with it; one gesture
//! (`beginHandleEditDrag`, `editHandlePosition`, `commitHandleEditDrag`,
//! `cancelHandleEditDrag`).

use styk_doc::{Obj, Value};

use crate::pose::set_item;
use crate::record::{num, uid};
use crate::{EditError, Editor};

const EPS: f64 = 1e-9;

/// A segment meeting the moved handle, as the geometry drew it when the gesture began.
#[derive(Clone, Debug)]
struct Shape {
    index: usize,
    segment_id: f64,
    angle: f64,
    bend: f64,
    start: [f64; 2],
    end: [f64; 2],
    /// A line or a square line: its bend can be edited.
    line: bool,
}

/// A figure whose handle moves: the selected one, and those joined at the handle.
#[derive(Clone, Debug)]
struct State {
    slot: usize,
    vertex: f64,
    before: Value,
    indices: Vec<usize>,
    incident: Vec<Shape>,
    lengths: Vec<f64>,
    bends: Vec<f64>,
    /// The bends the geometry drew when the gesture began.
    drawn: Vec<f64>,
    moved: bool,
}

/// `_drag.handleEdit`.
#[derive(Clone, Debug)]
pub(crate) struct HandleEdit {
    uid: Option<u32>,
    index: i64,
    point: [f64; 2],
    states: Vec<State>,
    bend: bool,
}

impl HandleEdit {
    /// What the interface reads of the gesture (`_drag.handleEdit`): the figure and handle being
    /// edited, where the handle began, and whether a bend is being edited.
    pub(crate) fn live(&self) -> Value {
        let mut value = Obj::new();
        value.set("uid", self.uid.map_or(Value::Null, |uid| Value::Num(uid as f64)));
        value.set("index", Value::Num(self.index as f64));
        value.set("point", Value::nums(&self.point));
        value.set("bend", Value::Bool(self.bend));
        Value::object(value)
    }
}

/// `handleEditSegmentPose(shape, start, end, scale, {bend, movingEnd})`: the angle, length
/// and bend of the same circular arc between two endpoints.
fn segment_pose(shape: &Shape, start: [f64; 2], end: [f64; 2], scale: f64, bend: bool, moving_end: bool) -> Result<(f64, f64, f64), EditError> {
    if !(scale.abs() > EPS) {
        return Err(EditError::Invalid("errors.editorHandleEdit.increaseFigureScaleBeforeRepositioningAHandle".into()));
    }
    let (dx, dy) = (end[0] - start[0], end[1] - start[1]);
    let distance = styk_math::hypot(dx, dy);
    let (mut angle, mut curvature) = (shape.angle, shape.bend);
    if distance > EPS && bend && shape.line {
        let direction = styk_math::atan2(dy, dx);
        if moving_end {
            let tangent = shape.angle + shape.bend;
            curvature = 2.0 * styk_math::shortest(tangent - direction);
            angle = tangent - curvature;
        } else {
            curvature = 2.0 * styk_math::shortest(direction - shape.angle);
        }
    }
    let factor = if curvature.abs() < EPS { 1.0 } else { 2.0 * styk_math::sin(curvature / 2.0) / curvature };
    if factor.abs() < EPS && distance > EPS {
        return Err(EditError::Invalid("errors.editorHandleEdit.reduceTheFullCircleBendBeforeMovingIts".into()));
    }
    if distance > EPS && !(bend && shape.line) {
        angle = styk_math::atan2(dy, dx) - curvature / 2.0 - if factor * scale < 0.0 { std::f64::consts::PI } else { 0.0 };
    }
    let length = if distance < EPS { 0.0 } else { distance / (scale * factor).abs() };
    Ok((shape.angle + styk_math::shortest(angle - shape.angle), length, curvature))
}

/// `object[key] = before[key]`, the field dropped when the snapshot has none.
fn restore_field(object: &mut Obj, before: &Value, key: &str) {
    match before.get(key) {
        Some(value) => object.set(key, value.clone()),
        None => {
            object.remove(key);
        }
    }
}


/// A segment as the editor's geometry draws it (`geometry.objects.get(slot).segments[i]`):
/// its definition's ids, the angle shown (a pinned limb's solved angle), the bend drawn, the
/// drawn (scaled) length and its ends.
#[derive(Clone, Debug)]
pub(crate) struct Drawn {
    pub index: usize,
    pub id: f64,
    pub parent: f64,
    pub angle: f64,
    pub bend: f64,
    pub length: f64,
    pub start: [f64; 2],
    pub end: [f64; 2],
    /// The definition's length (`shape.seg.length`).
    pub definition_length: f64,
    /// A line or a square line.
    pub line: bool,
}

/// Every segment of the figure at `at` in the evaluated frame as drawn; `definition` is its
/// definition's segment records.
pub(crate) fn drawn_segments(prepared: &styk_eval::eval::Prepared, frame: &styk_eval::eval::Frame, scene: &styk_eval::geometry::Scene, solved: &std::collections::HashMap<u32, crate::ik::Solved>, at: usize, definition: &[Value]) -> Result<Vec<Drawn>, EditError> {
    let evaluated = &frame.objects[at];
    let figure = evaluated.figure_override.as_ref().or_else(|| prepared.doc.figure(evaluated.figure));
    let Some(figure) = figure else { return Err(EditError::Unported("a figure the engine does not draw".into())) };
    let geometry = scene.objects.iter().find(|g| g.uid == evaluated.uid && g.resolved);
    let stretched = solved.get(&evaluated.uid).and_then(|s| s.solution.lengths.as_ref());
    let mut shapes = Vec::with_capacity(figure.segments.len());
    for (i, segment) in figure.segments.iter().enumerate() {
        let (_, bend, length) = styk_eval::geometry::segment_pose(evaluated, segment, i);
        // A straight Stick Nodes segment with a sagitta is drawn as a curve, which geometry
        // reports with a bend of 1e-6.
        let bend = if bend.abs() < 1e-7 && styk_eval::sticknodes::shape_for(segment, evaluated).is_some_and(|s| s.sagitta != 0.0) { 1e-6 } else { bend };
        let length = stretched.and_then(|l| l.get(i).copied()).unwrap_or(length) * evaluated.scale;
        let record = definition.get(i).cloned().unwrap_or(Value::Null);
        let code = match record.get("primitive_code").filter(|v| !v.is_null()) {
            Some(code) => code.as_f64().unwrap_or(f64::NAN),
            None => (num(&record, "flags").unwrap_or(0.0) as i64 & 255) as f64,
        };
        shapes.push(Drawn {
            index: i,
            id: num(&record, "segment_id").unwrap_or(f64::NAN),
            parent: num(&record, "parent_id").unwrap_or(f64::NAN),
            angle: crate::ik::displayed_angle(prepared, frame, scene, solved, at, i),
            bend,
            length,
            start: geometry.and_then(|g| g.starts.get(i).copied()).unwrap_or([f64::NAN; 2]),
            end: geometry.and_then(|g| g.ends.get(i).copied()).unwrap_or([f64::NAN; 2]),
            definition_length: num(&record, "length").unwrap_or(f64::NAN),
            line: code == 0.0 || code == 6.0,
        });
    }
    Ok(shapes)
}

impl Editor {
    pub(crate) fn figure_record(&self, object: &Value) -> Option<Value> {
        let figures = self.report.get("figure_types")?.elements()?;
        figures.iter().find(|f| num(f, "figure_type_id") == num(object, "figure_type_id"))
    }

    /// `beginHandleEditDrag({label, bend})`.
    pub(crate) fn begin_handle_edit_drag(&mut self, options: &Value) -> Result<bool, EditError> {
        let label = options.get("label").and_then(Value::as_str).unwrap_or("Reposition handle").to_string();
        let bend = options.get("bend").is_some_and(Value::truthy);
        let Some((_, object)) = self.object()? else { return Ok(false) };
        let Some(figure) = self.figure_record(&object) else { return Ok(false) };
        let segments: Vec<Value> = figure.get("segments").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
        if segments.iter().any(|s| s.get("_stykRig").is_some_and(Value::truthy)) {
            return Err(EditError::Invalid("errors.editorHandleEdit.useBuildFigureToRepositionRigAnchorsOr".into()));
        }
        let index = self.selection.joint;
        if index < -1 || index >= segments.len() as i64 || (index < 0 && object.get("join").is_some_and(Value::truthy)) {
            return Ok(false);
        }
        if !(num(&object, "scale").unwrap_or(f64::NAN).abs() > EPS) {
            return Err(EditError::Invalid("errors.editorHandleEdit.increaseFigureScaleBeforeRepositioningAHandle".into()));
        }
        if !self.begin_drag(&label, false)? {
            return Ok(false);
        }
        let vertex = if index < 0 { 0.0 } else { num(&segments[index as usize], "segment_id").unwrap_or(f64::NAN) };
        match self.plan_handle_edit(vertex, index, bend) {
            Ok(Some(edit)) => {
                self.drag.as_mut().unwrap().handle_edit = Some(edit);
                Ok(true)
            }
            Ok(None) => {
                self.cancel_drag()?;
                Ok(false)
            }
            Err(error) => {
                self.cancel_drag()?;
                Err(error)
            }
        }
    }

    /// The shapes meeting the handle, on the selected figure and those joined at it.
    fn plan_handle_edit(&self, vertex: f64, index: i64, bend: bool) -> Result<Option<HandleEdit>, EditError> {
        let objects = self.frame_objects();
        let Some(slot) = self.selection.uid.and_then(|selected| objects.iter().position(|o| uid(o) == Some(selected))) else { return Ok(None) };
        let (prepared, frame, scene) = self.evaluate()?;
        let solved = crate::ik::solve_frame(&prepared, &frame, &scene);
        // A figure's geometry, and its place in the evaluated frame.
        let geometry_of = |slot: usize| {
            let id = objects.get(slot).and_then(uid)?;
            let at = frame.objects.iter().position(|o| o.uid == id)?;
            Some((at, scene.objects.iter().find(|g| g.uid == id && g.resolved)?))
        };
        let point = geometry_of(slot).and_then(|(_, g)| if index < 0 { Some(g.root) } else { g.ends.get(index as usize).copied() });
        let Some(point) = point.filter(|p| p.iter().all(|v| v.is_finite())) else { return Ok(None) };
        let before = &self.drag.as_ref().unwrap().before;
        let mut queue = vec![(slot, vertex)];
        let mut visited = Vec::new();
        let mut states = Vec::new();
        let mut cursor = 0;
        while cursor < queue.len() {
            let (item, handle) = queue[cursor];
            cursor += 1;
            if visited.contains(&item) {
                continue;
            }
            visited.push(item);
            let found = geometry_of(item).and_then(|(at, g)| Some((at, g, before.iter().find(|o| uid(o) == Some(g.uid))?)));
            let Some((at, _, snapshot)) = found else {
                return Err(EditError::Invalid("errors.editorHandleEdit.theAttachedHandleIsOutsideTheCurrentPose".into()));
            };
            let evaluated = &frame.objects[at];
            if !(evaluated.scale.abs() > EPS) {
                return Err(EditError::Invalid("errors.editorHandleEdit.increaseAttachedFigureScaleBeforeRepositioningThisHandle".into()));
            }
            let definition: Vec<Value> = self.figure_record(&objects[item]).and_then(|f| f.get("segments").and_then(Value::elements).map(|e| e.iter().collect())).unwrap_or_default();
            let shapes = drawn_segments(&prepared, &frame, &scene, &solved, at, &definition)?;
            let lengths: Vec<f64> = shapes.iter().map(|s| s.length / evaluated.scale.abs()).collect();
            let bends: Vec<f64> = shapes.iter().map(|s| s.bend).collect();
            let incident: Vec<Shape> = shapes
                .iter()
                .filter(|s| s.id == handle || s.parent == handle)
                .map(|s| Shape { index: s.index, segment_id: s.id, angle: s.angle, bend: s.bend, start: s.start, end: s.end, line: s.line })
                .collect();
            let drawn = bends.clone();
            let indices = incident.iter().map(|s| s.index).collect();
            states.push(State { slot: item, vertex: handle, before: snapshot.clone(), indices, incident, lengths, bends, drawn, moved: false });
            // Joined roots share this exact handle; only the segments leaving them move.
            for (child, record) in objects.iter().enumerate() {
                let Some(join) = record.get("join").filter(|j| j.truthy()) else { continue };
                let target = num(&join, "target_object_slot");
                let target_handle = join.get("target_handle_id").filter(|h| !h.is_null()).map_or(Some(0.0), Value::as_f64);
                if target == Some(item as f64) && target_handle == Some(handle) {
                    queue.push((child, 0.0));
                }
            }
        }
        Ok(Some(HandleEdit { uid: self.selection.uid, index, point, states, bend }))
    }

    /// `editHandlePosition(x, y, {bend})`: one edit, unless a handle gesture is in progress.
    pub(crate) fn edit_handle_position(&mut self, x: f64, y: f64, options: &Value) -> Result<bool, EditError> {
        if !x.is_finite() || !y.is_finite() {
            return Err(EditError::Invalid("errors.editorHandleEdit.handleCoordinatesMustBeFinite".into()));
        }
        let bend = options.get("bend").filter(|b| !b.is_null()).map(Value::truthy);
        let active = self.drag.as_ref().is_some_and(|d| d.handle_edit.is_some());
        if !active {
            let mut begin = Obj::new();
            begin.set("bend", Value::Bool(bend.unwrap_or(false)));
            if !self.begin_handle_edit_drag(&Value::object(begin))? {
                return Ok(false);
            }
        }
        let drag = self.drag.as_mut().unwrap();
        let mut edit = drag.handle_edit.take().unwrap();
        if drag.index != self.frame_index || edit.uid != self.selection.uid || edit.index != self.selection.joint {
            self.cancel_drag()?;
            return Err(EditError::Invalid("errors.editorHandleEdit.theSelectedHandleChangedDuringItsGesture".into()));
        }
        let bend = bend.unwrap_or(edit.bend);
        let result = self.move_handle(&mut edit, x, y, bend).and_then(|()| {
            self.drag.as_mut().unwrap().handle_edit = Some(edit);
            self.touch()?;
            if !active { self.commit_drag().map(|_| ()) } else { Ok(()) }
        });
        if let Err(error) = result {
            self.cancel_drag()?;
            return Err(error);
        }
        Ok(true)
    }

    fn move_handle(&mut self, edit: &mut HandleEdit, x: f64, y: f64, bend: bool) -> Result<(), EditError> {
        let at_start = styk_math::hypot(x - edit.point[0], y - edit.point[1]) < EPS;
        // Every edge is solved before any figure changes, degenerate arcs included.
        let mut plans = Vec::with_capacity(edit.states.len());
        for state in &edit.states {
            let mut changes = Vec::new();
            if !at_start {
                let scale = num(&state.before, "scale").unwrap_or(f64::NAN);
                for shape in &state.incident {
                    let moving_end = shape.segment_id == state.vertex;
                    let (start, end) = if moving_end { (shape.start, [x, y]) } else { ([x, y], shape.end) };
                    let (angle, length, curvature) = segment_pose(shape, start, end, scale, bend, moving_end)?;
                    changes.push((shape.index, angle, length, curvature));
                }
            }
            plans.push(changes);
        }
        for (state, changes) in edit.states.iter_mut().zip(plans) {
            let Some(object) = self.frame_object_mut(state.slot) else { continue };
            let before = &state.before;
            if at_start {
                // `restoreObject(state, object)`
                if state.moved {
                    let angles = before.get("angles").and_then(Value::elements);
                    for &index in &state.indices {
                        let value = angles.as_ref().and_then(|a| a.get(index)).and_then(|v| v.as_f64()).unwrap_or(f64::NAN);
                        set_item(object, "angles", index, value);
                    }
                    for key in ["root_x", "root_y", "len_flag", "lengths", "bend_flag", "bends", "runtime_segments"] {
                        restore_field(object, before, key);
                    }
                }
                state.moved = false;
                continue;
            }
            let changed_bends = changes.iter().any(|&(index, _, _, curvature)| state.drawn.get(index) != Some(&curvature));
            for &(index, angle, length, curvature) in &changes {
                set_item(object, "angles", index, angle);
                state.lengths[index] = length;
                state.bends[index] = curvature;
            }
            object.set("lengths", Value::nums(&state.lengths));
            object.set("len_flag", Value::Num(1.0));
            if changed_bends || before.get("bend_flag").is_some_and(Value::truthy) {
                object.set("bends", Value::nums(&state.bends));
                object.set("bend_flag", Value::Num(1.0));
            } else {
                restore_field(object, before, "bends");
                restore_field(object, before, "bend_flag");
            }
            if state.vertex == 0.0 {
                object.set("root_x", Value::Num(x));
                object.set("root_y", Value::Num(y));
            }
            object.remove("runtime_segments");
            state.moved = true;
        }
        Ok(())
    }

    /// `commitHandleEditDrag()` and `cancelHandleEditDrag()`.
    pub(crate) fn finish_handle_edit_drag(&mut self, commit: bool) -> Result<bool, EditError> {
        if !self.drag.as_ref().is_some_and(|d| d.handle_edit.is_some()) {
            return Ok(false);
        }
        if commit { self.commit_drag() } else { self.cancel_drag() }
    }

    /// What the interface reads of the figure-handle, Handle Edit Mode and segment-value gesture in
    /// progress (`_drag.figureHandle`, `_drag.handleEdit`, `_drag.segmentValueOptions`), told with
    /// every answer; `null` when none is open.
    pub fn handle_gesture_view(&self) -> Value {
        let Some(drag) = &self.drag else { return Value::Null };
        if drag.figure_handle.is_none() && drag.handle_edit.is_none() && drag.segment_value_options.is_none() {
            return Value::Null;
        }
        let mut out = Obj::new();
        if let Some(edit) = &drag.figure_handle { out.set("figureHandle", edit.live()); }
        if let Some(edit) = &drag.handle_edit { out.set("handleEdit", edit.live()); }
        if let Some(options) = &drag.segment_value_options { out.set("segmentValueOptions", options.clone()); }
        Value::object(out)
    }
}
