//! Rig editing by dragging: a joint of the selected figure dragged in the
//! Rig tool or the Build Figure workspace. The gesture previews on the frame on show, then its
//! commit changes the reusable definition and every pose of it by the same deltas, as one
//! `topology` history entry (`commitRigDrag`). Repositioning moves the joint and refits its
//! children; rotating turns its branch (or the joint alone); an angle-locked joint only
//! stretches along its chord; a connector slides; a bend gesture (`bendJoint` during a rig drag)
//! bends the joint and turns its branch with it.

use styk_doc::Value;
use styk_eval::eval::shortest;
use styk_math::{atan2, cos, hypot, sin};

use crate::pose::Shape;
use crate::record::{num, uid};
use crate::{EditError, Editor};

const EPS: f64 = 1e-9;

fn invalid(key: &str) -> EditError {
    EditError::Invalid(key.into())
}

fn items(value: Option<&Value>) -> Vec<Value> {
    value.and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default()
}

fn rig_has(segment: &Value, key: &str) -> bool {
    segment.path(&["_stykRig", key]).is_some_and(Value::truthy)
}

/// What a step changes on one joint: its angle, and its length or bend.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Change {
    angle: Option<f64>,
    length: Option<f64>,
    bend: Option<f64>,
}

/// `_drag.rig`: the gesture's figure, its record and shapes when it began, and the joints the
/// preview changed.
#[derive(Clone, Debug)]
pub(crate) struct RigDrag {
    uid: u32,
    figure: Value,
    object: Value,
    index: usize,
    shapes: Vec<Option<Shape>>,
    reposition: bool,
    pub bend: bool,
    pub branch: Vec<usize>,
    children: Vec<usize>,
    changed: Vec<usize>,
    changes: Vec<(usize, Change)>,
    /// The definition's lengths, materialized once when a step first stretches (`rig.lengths`).
    lengths: Option<Vec<f64>>,
}

/// `chordPose(start, end, bend, scale, fallbackAngle)`.
fn chord_pose(start: [f64; 2], end: [f64; 2], bend: f64, scale: f64, fallback: f64) -> Result<(f64, f64), EditError> {
    let distance = hypot(end[0] - start[0], end[1] - start[1]);
    let factor = if bend.abs() < EPS { 1.0 } else { 2.0 * sin(bend / 2.0) / bend };
    if factor.abs() < EPS && distance > EPS {
        return Err(invalid("errors.editorRig.aClosedFullCircleBendCannotBeStretched"));
    }
    let angle = if distance < EPS { fallback } else { atan2(end[1] - start[1], end[0] - start[0]) - bend / 2.0 - if factor * scale < 0.0 { std::f64::consts::PI } else { 0.0 } };
    let length = if distance < EPS { 0.0 } else { distance / (scale * factor).abs() };
    Ok((angle, length))
}

/// `authoredRigTarget(shape, x, y)`: where the joint's authored channels must aim so that its rig
/// draws it at the point.
fn authored_target(start: [f64; 2], shape: &Shape, point: [f64; 2]) -> Result<[f64; 2], EditError> {
    styk_eval::ik::rig::authored_rig_target_with(start, shape.space, shape.bend, point, None).ok_or_else(|| invalid("errors.rigConstraints.expandTheStretchDriverBeforePosingAFully"))
}

fn vector(object: &Value, key: &str) -> Vec<f64> {
    items(object.get(key)).iter().map(|v| v.as_f64().unwrap_or(f64::NAN)).collect()
}

impl Editor {
    /// The rig gesture in progress, if any.
    pub(crate) fn rig_drag(&self) -> Option<&RigDrag> {
        self.drag.as_ref().and_then(|d| d.rig.as_ref())
    }

    /// The rig gesture commands by their JavaScript names; `None` for other calls.
    pub(crate) fn rig_drag_call(&mut self, method: &str, args: &[Value]) -> Option<Result<Value, EditError>> {
        let arg = |i: usize| args.get(i).cloned().unwrap_or(Value::Null);
        Some(match method {
            "beginRigDrag" => self.begin_rig_drag(args.first()).map(Value::Bool),
            "editRigJoint" => self.edit_rig_joint(&arg(0), &arg(1), args.get(2)).map(Value::Bool),
            "commitRigDrag" => self.commit_rig_drag().map(Value::Bool),
            "cancelRigDrag" => self.cancel_rig_drag().map(Value::Bool),
            _ => return None,
        })
    }

    /// The selected figure's definition, joint and record on show.
    fn rig_selection(&self) -> Result<Option<(Value, usize, Value, usize)>, EditError> {
        let Some((slot, object)) = self.object()? else { return Ok(None) };
        let figure = self.figure_value(&object);
        let joint = self.selection.joint;
        let count = figure.get("segments").and_then(Value::array_len).unwrap_or(0);
        if joint < 0 || joint as usize >= count {
            return Ok(Some((figure, usize::MAX, object, slot)));
        }
        Ok(Some((figure, joint as usize, object, slot)))
    }

    /// `beginRigDrag({reposition, bend, label})`.
    fn begin_rig_drag(&mut self, options: Option<&Value>) -> Result<bool, EditError> {
        let options = match options {
            None => Value::object(styk_doc::Obj::new()),
            Some(Value::Null) => return Err(EditError::Unported("rig drag options that are null".into())),
            Some(o) => o.clone(),
        };
        let bend = options.get("bend").is_some_and(Value::truthy);
        let reposition = options.get("reposition").is_none_or(Value::truthy);
        let label = match options.get("label") {
            None => (if bend { "Bend rig joint" } else { "Edit rig" }).to_string(),
            Some(Value::Str(text)) => text.to_string(),
            Some(_) => return Err(EditError::Unported("a rig drag label that is not text".into())),
        };
        let Some((figure, joint, object, _)) = self.rig_selection()? else {
            return Ok(false);
        };
        let segment = items(figure.get("segments")).get(joint).cloned();
        if bend {
            let ok = segment.as_ref().is_some_and(|s| {
                let code = match s.get("primitive_code").filter(|v| !v.is_null()) {
                    Some(code) => code.as_f64().unwrap_or(f64::NAN),
                    None => ((num(s, "flags").unwrap_or(0.0) as i64) & 255) as f64,
                };
                !rig_has(s, "spatial") && (code == 0.0 || code == 6.0)
            });
            if !ok {
                return Ok(false);
            }
        }
        if segment.as_ref().is_some_and(|s| rig_has(s, "spatial")) {
            return Err(invalid("errors.editorRig.usePoseOrRotateToArticulateThisJoint"));
        }
        if segment.as_ref().is_some_and(|s| rig_has(s, "anglePath") || rig_has(s, "weighted")) {
            return Ok(false);
        }
        if !bend && segment.as_ref().is_some_and(|s| rig_has(s, "connector")) {
            return self.begin_drag("Slide connector", false);
        }
        let Some(_) = segment else { return Ok(false) };
        let scale = num(&object, "scale").unwrap_or(f64::NAN);
        if scale.abs() < EPS {
            return Err(invalid("errors.editorRig.increaseFigureScaleBeforeEditingItsRig"));
        }
        if !self.begin_drag(&label, false)? {
            return Ok(false);
        }
        let Some((_, object_now)) = self.object()? else { return Ok(false) };
        let shapes = self.shapes(&object_now)?;
        let id = uid(&object_now);
        let before = self.drag.as_ref().and_then(|d| d.before.iter().find(|o| uid(o) == id).cloned()).unwrap_or(Value::Null);
        let segments = items(figure.get("segments"));
        let handle = segments[joint].get("segment_id").cloned().unwrap_or(Value::Null);
        let children: Vec<usize> = (0..segments.len()).filter(|&i| segments[i].get("parent_id").is_some_and(|p| crate::history::js_strict_eq(p, &handle))).collect();
        let branch = crate::builder::branch(&figure, joint, true, false).indices;
        if let Some(drag) = self.drag.as_mut() {
            drag.rig = Some(RigDrag { uid: id.unwrap_or(u32::MAX), figure, object: before, index: joint, shapes, reposition, bend, branch, children, changed: Vec::new(), changes: Vec::new(), lengths: None });
        }
        Ok(true)
    }

    /// `restorePreview(editor, drag)`: the joints the last step changed put back as they were.
    fn restore_rig_preview(&mut self) {
        let Some(rig) = self.rig_drag().cloned() else { return };
        let Some(slot) = self.frame_objects().iter().position(|o| uid(o) == Some(rig.uid)) else { return };
        let definition_lengths: Vec<f64> = items(rig.figure.get("segments")).iter().map(|s| num(s, "length").unwrap_or(f64::NAN)).collect();
        let snapshot_angles = vector(&rig.object, "angles");
        let snapshot_lengths = vector(&rig.object, "lengths");
        let snapshot_len_flag = rig.object.get("len_flag").cloned();
        let length_flag = snapshot_len_flag.as_ref().is_some_and(Value::truthy);
        let Some(record) = self.frame_object_mut(slot) else { return };
        let mut angles = items(record.get("angles"));
        for &i in &rig.changed {
            if let Some(a) = angles.get_mut(i) {
                *a = Value::Num(snapshot_angles.get(i).copied().unwrap_or(f64::NAN));
            }
        }
        record.set("angles", Value::array(angles));
        if length_flag {
            let mut lengths = if record.get("len_flag").is_some_and(Value::truthy) { items(record.get("lengths")) } else { snapshot_lengths.iter().map(|&l| Value::Num(l)).collect() };
            for &i in &rig.changed {
                if let Some(l) = lengths.get_mut(i) {
                    *l = Value::Num(snapshot_lengths.get(i).copied().unwrap_or(f64::NAN));
                }
            }
            record.set("lengths", Value::array(lengths));
        } else {
            record.set("len_flag", Value::Num(0.0));
            record.set("lengths", Value::array(Vec::new()));
        }
        match snapshot_len_flag {
            Some(flag) => record.set("len_flag", flag),
            None => {
                record.remove("len_flag");
            }
        }
        let rig = self.drag.as_mut().and_then(|d| d.rig.as_mut()).unwrap();
        if let Some(lengths) = rig.lengths.as_mut() {
            for &i in &rig.changed {
                if let Some(l) = lengths.get_mut(i) {
                    *l = definition_lengths.get(i).copied().unwrap_or(f64::NAN);
                }
            }
        }
        rig.changed.clear();
    }

    /// `editRigJoint(x, y, {stretch, isolate, reposition})`: one step of the gesture (or a
    /// gesture of its own, begun and committed).
    fn edit_rig_joint(&mut self, x: &Value, y: &Value, options: Option<&Value>) -> Result<bool, EditError> {
        let options = match options {
            None => Value::object(styk_doc::Obj::new()),
            Some(Value::Null) => return Err(EditError::Unported("rig drag options that are null".into())),
            Some(o) => o.clone(),
        };
        if let Some((figure, joint, object, slot)) = self.rig_selection()?
            && items(figure.get("segments")).get(joint).is_some_and(|s| rig_has(s, "connector"))
        {
            let number = |v: &Value| v.as_f64().unwrap_or(f64::NAN);
            return self.slide_connector(slot, &object, joint, number(x), number(y));
        }
        let (Some(x), Some(y)) = (x.as_f64().filter(|v| v.is_finite()), y.as_f64().filter(|v| v.is_finite())) else {
            return Err(invalid("errors.editorRig.jointCoordinatesMustBeFinite"));
        };
        let active = self.rig_drag().is_some();
        if !active {
            let mut begin = styk_doc::Obj::new();
            begin.set("reposition", options.get("reposition").cloned().filter(|v| !v.is_null()).unwrap_or(Value::Bool(true)));
            if !self.begin_rig_drag(Some(&Value::object(begin)))? {
                return Ok(false);
            }
        }
        let rig = self.rig_drag().cloned().unwrap();
        let figure_now = self.rig_selection()?.map(|(f, ..)| f).unwrap_or(Value::Null);
        let same_figure = figure_now.same_node(&rig.figure) || styk_doc::json::to_string(&figure_now) == styk_doc::json::to_string(&rig.figure);
        if self.frame_index != self.drag.as_ref().unwrap().index || self.selection.uid != Some(rig.uid) || !same_figure {
            self.cancel_rig_drag()?;
            return Err(invalid("errors.editorRig.theEditedFigureChangedDuringTheRigGesture"));
        }
        match self.rig_step(&rig, [x, y], &options) {
            Ok(None) => Ok(false),
            Ok(Some(())) => {
                if !active {
                    self.commit_rig_drag()?;
                }
                Ok(true)
            }
            Err(error) => {
                self.cancel_rig_drag()?;
                Err(error)
            }
        }
    }

    /// The step's changes previewed on the frame on show; `None` for a joint its rig places.
    fn rig_step(&mut self, rig: &RigDrag, point: [f64; 2], options: &Value) -> Result<Option<()>, EditError> {
        let Some((_, _, object, _)) = self.rig_selection()? else { return Ok(None) };
        let Some(selected) = rig.shapes.get(rig.index).cloned().flatten() else { return Err(EditError::Unported("a rig joint the engine does not draw".into())) };
        let segments = items(rig.figure.get("segments"));
        let segment = &segments[rig.index];
        if rig_has(segment, "anglePath") || rig_has(segment, "weighted") {
            return Ok(None);
        }
        let flag = |key: &str| options.get(key).is_some_and(Value::truthy);
        let (stretch, isolate) = (flag("stretch"), flag("isolate"));
        let move_point = match options.get("reposition").filter(|v| !v.is_null()) {
            Some(value) => value.truthy(),
            None => rig.reposition,
        };
        let scale = num(&object, "scale").unwrap_or(f64::NAN);
        let angles = vector(&rig.object, "angles");
        let angle_of = |i: usize| angles.get(i).copied().unwrap_or(f64::NAN);
        let mut changes: Vec<(usize, Change)> = Vec::new();
        let put = |changes: &mut Vec<(usize, Change)>, i: usize, change: Change| match changes.iter_mut().find(|(at, _)| *at == i) {
            Some(entry) => entry.1 = change,
            None => changes.push((i, change)),
        };
        if rig_has(segment, "angleLock") {
            let current = if rig.object.get("len_flag").is_some_and(Value::truthy) { vector(&rig.object, "lengths").get(rig.index).copied().unwrap_or(f64::NAN) } else { num(segment, "length").unwrap_or(f64::NAN) };
            let chord = hypot(selected.end[0] - selected.start[0], selected.end[1] - selected.start[1]);
            let axis = selected.angle + selected.bend / 2.0;
            if (stretch || move_point) && current > EPS && chord > EPS {
                let along = ((point[0] - selected.start[0]) * cos(axis) + (point[1] - selected.start[1]) * sin(axis)).max(0.0);
                put(&mut changes, rig.index, Change { angle: Some(angle_of(rig.index)), length: Some(along * current / chord), bend: None });
            }
        } else if hypot(point[0] - selected.end[0], point[1] - selected.end[1]) < EPS {
            // Exact pointer return restores the snapshot, without float32 chord drift.
        } else if move_point {
            let target = authored_target(selected.start, &selected, point)?;
            let (angle, length) = chord_pose(selected.start, target, selected.bend, scale, angle_of(rig.index))?;
            put(&mut changes, rig.index, Change { angle: Some(angle), length: Some(length), bend: None });
            for &i in &rig.children {
                let Some(child) = rig.shapes.get(i).cloned().flatten() else { continue };
                let child_segment = &segments[i];
                let locked = rig_has(child_segment, "angleLock") || rig_has(child_segment, "anglePath") || rig_has(child_segment, "weighted");
                if child.connector || rig_has(child_segment, "follow") || child.space.is_some_and(|s| s.follow.is_some()) || (child.space.is_some() && locked) {
                    continue;
                }
                let target = authored_target(point, &child, child.end)?;
                let (angle, length) = chord_pose(point, target, child.bend, scale, angle_of(i))?;
                put(&mut changes, i, Change { angle: Some(angle), length: Some(length), bend: None });
            }
        } else {
            let target = authored_target(selected.start, &selected, point)?;
            let (angle, length) = chord_pose(selected.start, target, selected.bend, scale, angle_of(rig.index))?;
            let delta = shortest(angle - angle_of(rig.index));
            let joints = if isolate { vec![rig.index] } else { rig.branch.clone() };
            for i in joints {
                put(&mut changes, i, Change { angle: Some(angle_of(i) + delta), length: None, bend: None });
            }
            if stretch && let Some(entry) = changes.iter_mut().find(|(i, _)| *i == rig.index) {
                entry.1.length = Some(length);
            }
        }
        self.restore_rig_preview();
        let slot = self.frame_objects().iter().position(|o| uid(o) == Some(rig.uid));
        let definition_lengths: Vec<f64> = segments.iter().map(|s| num(s, "length").unwrap_or(f64::NAN)).collect();
        if let Some(slot) = slot {
            let mut materialized = self.rig_drag().and_then(|r| r.lengths.clone());
            let record = self.frame_object_mut(slot).unwrap();
            let mut angles_now = items(record.get("angles"));
            let mut lengths_now = items(record.get("lengths"));
            for (i, change) in &changes {
                if let (Some(a), Some(value)) = (angles_now.get_mut(*i), change.angle) {
                    *a = Value::Num(angle_of(*i) + shortest(value - angle_of(*i)));
                }
                if let Some(length) = change.length {
                    if !record.get("len_flag").is_some_and(Value::truthy) {
                        let base = materialized.get_or_insert_with(|| definition_lengths.clone());
                        lengths_now = base.iter().map(|&l| Value::Num(l)).collect();
                        record.set("len_flag", Value::Num(1.0));
                    }
                    if let Some(l) = lengths_now.get_mut(*i) {
                        *l = Value::Num(length);
                    }
                    if let Some(base) = materialized.as_mut()
                        && let Some(l) = base.get_mut(*i)
                    {
                        *l = length;
                    }
                }
            }
            record.set("angles", Value::array(angles_now));
            if record.get("len_flag").is_some_and(Value::truthy) {
                record.set("lengths", Value::array(lengths_now));
            }
            record.remove("runtime_segments");
            let rig_state = self.drag.as_mut().and_then(|d| d.rig.as_mut()).unwrap();
            rig_state.lengths = materialized;
            for (i, _) in &changes {
                if !rig_state.changed.contains(i) {
                    rig_state.changed.push(*i);
                }
            }
        }
        self.drag.as_mut().and_then(|d| d.rig.as_mut()).unwrap().changes = changes;
        self.touch()?;
        Ok(Some(()))
    }

    /// `commitRigDrag()`: the gesture's deltas written into the definition and every pose of it,
    /// one `topology` entry; without a change the preview is dropped (`Cancel rig edit`).
    pub(crate) fn commit_rig_drag(&mut self) -> Result<bool, EditError> {
        let Some(rig) = self.rig_drag().cloned() else { return Ok(false) };
        let preview = self.frame_objects().into_iter().find(|o| uid(o) == Some(rig.uid)).unwrap_or(Value::Null);
        let segments = items(rig.figure.get("segments"));
        let mut changes = rig.changes.clone();
        if rig.bend {
            let lengths = preview.get("len_flag").is_some_and(Value::truthy).then(|| vector(&preview, "lengths"));
            let bends = preview.get("bend_flag").is_some_and(Value::truthy).then(|| vector(&preview, "bends"));
            for &i in &rig.branch {
                let change = Change { angle: None, length: lengths.as_ref().map(|l| l.get(i).copied().unwrap_or(f64::NAN)), bend: if i == rig.index { bends.as_ref().map(|b| b.get(i).copied().unwrap_or(f64::NAN)) } else { None } };
                match changes.iter_mut().find(|(at, _)| *at == i) {
                    Some(entry) => entry.1 = change,
                    None => changes.push((i, change)),
                }
            }
        }
        let preview_angles = vector(&preview, "angles");
        let snapshot_angles = vector(&rig.object, "angles");
        let snapshot_lengths = vector(&rig.object, "lengths");
        let snapshot_bends = vector(&rig.object, "bends");
        let (len_flag, bend_flag) = (rig.object.get("len_flag").is_some_and(Value::truthy), rig.object.get("bend_flag").is_some_and(Value::truthy));
        struct Operation {
            index: usize,
            angle: f64,
            length: Option<f64>,
            length_delta: f64,
            ratio: Option<f64>,
            bend: f64,
            default_length: f64,
        }
        let mut operations = Vec::new();
        for (i, change) in &changes {
            let i = *i;
            let angle_delta = shortest(preview_angles.get(i).copied().unwrap_or(f64::NAN) - snapshot_angles.get(i).copied().unwrap_or(f64::NAN));
            let definition_length = num(&segments[i], "length").unwrap_or(f64::NAN);
            let old_length = if len_flag { snapshot_lengths.get(i).copied().unwrap_or(f64::NAN) } else { definition_length };
            let length_delta = change.length.map_or(0.0, |l| l - old_length);
            let old_bend = if bend_flag { snapshot_bends.get(i).copied().unwrap_or(f64::NAN) } else { segments[i].get("bend_rad").filter(|v| !v.is_null()).map_or(0.0, |v| v.as_f64().unwrap_or(f64::NAN)) };
            let bend_delta = change.bend.map_or(0.0, |b| b - old_bend);
            if angle_delta.abs() < EPS && length_delta.abs() < EPS && bend_delta.abs() < EPS {
                continue;
            }
            let ratio = match change.length {
                Some(l) if old_length.abs() >= EPS => Some(l / old_length),
                _ => None,
            };
            let default_length = match (change.length, ratio) {
                (None, _) => definition_length,
                (Some(_), Some(r)) if definition_length.abs() > EPS => definition_length * r,
                (Some(l), _) => l,
            };
            operations.push(Operation { index: i, angle: angle_delta, length: change.length, length_delta, ratio, bend: bend_delta, default_length });
        }
        let drag = self.drag.take().unwrap();
        if drag.authored {
            self.authored = None;
        } else {
            self.replace_objects(drag.index, &drag.before);
        }
        self.retained = None;
        if operations.is_empty() {
            let changed = Value::array(drag.before.iter().filter_map(uid).map(|u| Value::Num(u as f64)).collect());
            self.emit("edit", vec![("label", Value::str("Cancel rig edit")), ("changedUids", changed)]);
            return Ok(false);
        }
        let type_id = rig.figure.get("figure_type_id").cloned().unwrap_or(Value::Null);
        let history_segment_indices = Some(operations.iter().map(|operation| operation.index).collect());
        self.topology_edit(&drag.label, crate::topology::TopologyOptions { history_segment_indices, ..crate::topology::TopologyOptions::default() }, |editor, at| {
            let mut next = items(editor.report.get("figure_types").and_then(|f| f.item(at)).as_ref().and_then(|f| f.get("segments")));
            for op in &operations {
                let segment = &mut next[op.index];
                let angle = num(segment, "angle_rad").unwrap_or(f64::NAN);
                let record = segment.make_obj().unwrap();
                record.set("angle_rad", Value::Num(angle + op.angle));
                // `if (operation.bendDelta)`.
                if op.bend != 0.0 && !op.bend.is_nan() {
                    let bend = record.get("bend_rad").filter(|v| !v.is_null()).map_or(0.0, |v| v.as_f64().unwrap_or(f64::NAN));
                    record.set("bend_rad", Value::Num(bend + op.bend));
                }
                if op.length.is_some() {
                    record.set("length", Value::Num(op.default_length));
                }
            }
            if let Some(figure) = editor.report.make_obj().and_then(|r| r.get_mut("figure_types")).and_then(Value::make_arr).and_then(|f| f.get_mut(at)).and_then(Value::make_obj) {
                figure.set("segments", Value::array(next));
            }
            for place in crate::topology::places(&editor.report) {
                let objects = items(crate::topology::frame_at(&editor.report, &place).and_then(|f| f.get("objects")));
                let slots: Vec<usize> = (0..objects.len()).filter(|&s| objects[s].get("figure_type_id") == Some(&type_id)).collect();
                if slots.is_empty() {
                    continue;
                }
                let Some(frame) = crate::topology::frame_mut(&mut editor.report, &place) else { continue };
                let Some(list) = frame.get_mut("objects").and_then(Value::make_arr) else { continue };
                for &slot in &slots {
                    let record = list[slot].make_obj().unwrap();
                    let mut angles = vector(&Value::object(record.clone()), "angles");
                    let lengths_on = record.get("len_flag").is_some_and(Value::truthy);
                    let bends_on = record.get("bend_flag").is_some_and(Value::truthy);
                    let mut lengths = vector(&Value::object(record.clone()), "lengths");
                    let mut bends = vector(&Value::object(record.clone()), "bends");
                    for op in &operations {
                        if let Some(a) = angles.get_mut(op.index) {
                            *a += op.angle;
                        }
                        if bends_on && let Some(b) = bends.get_mut(op.index) {
                            *b += op.bend;
                        }
                        if lengths_on && op.length.is_some() && let Some(l) = lengths.get_mut(op.index) {
                            *l = match op.ratio {
                                None => *l + op.length_delta,
                                Some(r) => *l * r,
                            };
                        }
                    }
                    record.set("angles", Value::nums(&angles));
                    if bends_on {
                        record.set("bends", Value::nums(&bends));
                    }
                    if lengths_on {
                        record.set("lengths", Value::nums(&lengths));
                    }
                    record.remove("runtime_segments");
                }
                editor.canonicalize_children(&place, &slots)?;
            }
            Ok(())
        })
    }

    /// `cancelRigDrag()`: the preview dropped.
    pub(crate) fn cancel_rig_drag(&mut self) -> Result<bool, EditError> {
        if self.rig_drag().is_none() {
            return Ok(false);
        }
        let drag = self.drag.take().unwrap();
        if drag.authored {
            self.authored = None;
        } else {
            self.replace_objects(drag.index, &drag.before);
        }
        self.retained = None;
        let changed = Value::array(drag.before.iter().filter_map(uid).map(|u| Value::Num(u as f64)).collect());
        self.emit("edit", vec![("label", Value::str("Cancel rig edit")), ("changedUids", changed)]);
        Ok(true)
    }
}
