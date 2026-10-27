//! Inverse-kinematics controllers as editing sees them (src/ik.mjs).
//!
//! Ported: moving controller targets with their figure (`translateIKTargets`), dragging
//! the end of a limb (`poseIKTarget`: a pinned target moves, an unpinned limb is solved
//! and baked), and what gestures do around pinned limbs: the displayed solution baked
//! before a pose edit (`_objectEdit(…, {posed})`, `_bakeIKFollowers`), follower offsets
//! turned with their joint (`_rotateIKFollowers`), the bend remembered after each change
//! (`_rememberIKBends`) and a stretched end followed by its pin (`_followStretchedIK`).
//! Across joined figures the same runs on the assembly's temporary skeleton
//! (`styk_eval::ik::joined::Assembly`: `context()`, `_ikPoseSlots`, `poseGraph`).
//! With 3D controllers (`spatialTarget`) every call runs except the paths that need their
//! own solving: posing a 3D target, steering a planted 3D limb's knee, twisting with 3D IK
//! and turning a whole figure (they answer `Unported`).

use std::collections::{BTreeMap, HashMap, HashSet};

use styk_doc::{Obj, Value};
use styk_eval::eval::{Frame, Prepared};
use styk_eval::geometry::Scene;
use styk_eval::ik::joined::{Assembly, Followers};
use styk_eval::ik::{self, BendReference, Controller, Pose, Skeleton, Solution, Table, Target};
use styk_math::{atan2, cos, hypot, sin};

use crate::record::{join_target, uid};
use crate::{EditError, Editor};

pub(crate) fn controllers(object: &Value) -> Vec<(std::sync::Arc<str>, Value)> {
    object.get("_stykIK").and_then(Value::as_obj).map(|table| table.iter().map(|(id, c)| (id.clone(), c.clone())).collect()).unwrap_or_default()
}

fn truthy(value: &Value, key: &str) -> bool {
    value.get(key).is_some_and(Value::truthy)
}

/// `translateIKTargets(object, dx, dy, {source, pinnedOnly})`: the targets of `object`'s
/// controllers (only the enabled, pinned ones with `pinned_only`) moved to `source`'s
/// target plus (dx, dy). Returns whether a target changed.
pub(crate) fn translate_targets(object: &mut Obj, dx: f64, dy: f64, source: &Value, pinned_only: bool) -> bool {
    let Some(table) = object.get("_stykIK").filter(|t| t.truthy()).and_then(Value::as_obj).cloned() else { return false };
    let mut next: Option<Obj> = None;
    for (id, c) in table.iter() {
        if pinned_only && !(truthy(c, "enabled") && truthy(c, "pinned")) {
            continue;
        }
        let Some(target) = source.path(&["_stykIK", id, "target"]).filter(|t| t.truthy()) else { continue };
        let number = |value: &Value, key: &str| value.get(key).and_then(Value::as_f64).unwrap_or(f64::NAN);
        let (x, y) = (number(target, "x") + dx, number(target, "y") + dy);
        let current = c.get("target").cloned().unwrap_or(Value::Null);
        if x == number(&current, "x") && y == number(&current, "y") {
            continue;
        }
        let mut moved = current.as_obj().cloned().unwrap_or_default();
        moved.set("x", Value::Num(x));
        moved.set("y", Value::Num(y));
        let mut controller = c.as_obj().cloned().unwrap_or_default();
        controller.set("target", Value::object(moved));
        next.get_or_insert_with(|| table.clone()).set(id, Value::object(controller));
    }
    match next {
        Some(next) => {
            object.set("_stykIK", Value::object(next));
            true
        }
        None => false,
    }
}

/// Movieclip capture/break can read future native keys, saved sources and nested assets.
/// Reuse the controller owner rather than relying on the gesture's current-frame gate.
fn movieclip_document_has_controllers(report: &Value) -> bool {
    let frame_has_controllers = |frame: &Value| frame.get("objects").and_then(Value::elements).is_some_and(|objects| objects.iter().any(|object| !controllers(&object).is_empty()));
    report.get("keyframes").and_then(Value::elements).is_some_and(|frames| frames.iter().any(|frame| frame_has_controllers(&frame)))
        || report.path(&["_styk", "frameSources"]).and_then(Value::as_obj).is_some_and(|sources| sources.iter().any(|(_, frame)| frame_has_controllers(frame)))
        || report.get("figure_types").and_then(Value::elements).is_some_and(|figures| figures.iter().any(|figure| figure.path(&["_styk", "movieclip", "document"]).is_some_and(movieclip_document_has_controllers)))
}

impl Editor {
    /// Why `method` cannot run here because of IK controllers: movieclip edits over a document that has any.
    pub(crate) fn ik_gate(&self, method: &str, args: &[Value]) -> Result<Option<String>, EditError> {
        if self.native_movieclip_mutation(method, args) && movieclip_document_has_controllers(&self.report) {
            return Ok(Some("native movieclip edits with IK are not recorded".into()));
        }
        Ok(None)
    }

    /// `poseIKTarget(x, y)` for the enabled, unpinned controller ending at `handle` of the
    /// figure in `slot`: the pointer becomes its target and the limb is solved to it.
    pub(crate) fn pose_ik_target(&mut self, slot: usize, handle: u32, x: f64, y: f64) -> Result<bool, EditError> {
        // The pointer at the target's depth (`unprojectSpatial`).
        let key = handle.to_string();
        let shown = self.frame_objects().get(slot).and_then(|o| o.path(&["_stykIK", &key]).cloned()).unwrap_or(Value::Null);
        let spatial_depth = shown.path(&["spatialTarget", "depth"]).and_then(Value::as_f64);
        let mut evaluation = None;
        let context = if self.drag.is_some() && !truthy(&shown, "pinned") {
            self.spatial_context_at_with(slot, Some(&mut evaluation))?
        } else {
            self.spatial_context_at(slot)?
        };
        let depth = if truthy(&shown, "pinned") {
            spatial_depth.unwrap_or(0.0)
        } else {
            context.as_ref().and_then(|c| c.raw(handle)).map(|r| r[2]).or(spatial_depth).unwrap_or(0.0)
        };
        let [x, y] = context.as_ref().map_or([x, y], |c| c.unproject_at([x, y], depth));
        let mut graph_evaluation = None;
        let graph = if self.drag.is_some() && !truthy(&shown, "pinned") {
            self.in_assembly_with(slot, Some(&mut graph_evaluation))?
        } else {
            self.in_assembly(slot)?
        };
        // Only an already-active unpinned edit can reach the callback without
        // beginning or baking a pose. Graphs need the classifier's complete scene.
        let evaluation = if graph { None } else { evaluation };
        self.object_edit("Move IK target", move |editor| {
            let current = editor.frame_objects().get(slot).and_then(|o| o.path(&["_stykIK", &key]).cloned()).unwrap_or(Value::Null);
            if !truthy(&current, "pinned") {
                return if graph { editor.pose_graph(slot, handle, x, y, graph_evaluation.as_ref()) } else { editor.bake_unpinned(slot, handle, x, y, evaluation.as_ref()) };
            }
            // A pinned target persists where it is put; geometry solves the limb to it.
            let mut next = current.as_obj().cloned().unwrap_or_default();
            let mut target = current.get("target").and_then(Value::as_obj).cloned().unwrap_or_default();
            target.set("x", Value::Num(x));
            target.set("y", Value::Num(y));
            next.set("target", Value::object(target));
            // A planted 3D limb's knee keeps its side on screen (`_flatSpatialIKPole`).
            if !graph && let Some(spatial) = current.get("spatialTarget").filter(|s| s.truthy()).and_then(crate::spatial_ik::parse_spatial_target) {
                let length = current.get("chainLength").and_then(Value::as_f64).unwrap_or(f64::NAN).max(0.0).min(u32::MAX as f64) as u32;
                let bend = current.get("bendDirection").and_then(Value::as_f64).unwrap_or(f64::NAN);
                if let Some(pole) = editor.flat_spatial_ik_pole(slot, handle, length, bend, [x, y], &spatial)? {
                    next.set("spatialTarget", crate::spatial_ik::merged(current.get("spatialTarget").unwrap(), &[("pole", Value::nums(&pole))]));
                }
            }
            let record = editor.frame_object_mut(slot).ok_or_else(|| EditError::Unported("posing an IK target outside the frame".into()))?;
            set_controller(record, &key, next);
            record.remove("runtime_segments");
            Ok(())
        })
    }

    /// `layerLocked(report, uid)`: the figure's layer is locked, or Focus and lock holds it.
    pub(crate) fn layer_locked(&self, uid: u32) -> bool {
        let layer = self.layer_of(uid);
        crate::layer_focus::locked(matches!(self.report.path(&["_styk", "layers", "byId", &layer, "locked"]), Some(Value::Bool(true))), self.focus_lock.as_ref(), &layer)
    }

    /// The pinned limbs of the frame being edited as geometry solves them, by figure
    /// identity (`geometry.objects.get(slot).ik`, `solvedAngles`, `solvedLengths`).
    fn solutions(&self) -> Result<HashMap<u32, Solved>, EditError> {
        let (prepared, frame, scene) = self.evaluate()?;
        Ok(solve_frame(&prepared, &frame, &scene))
    }

    /// `context()` is a graph: the figure in `slot` belongs to joined figures that compile
    /// into one skeleton.
    pub(crate) fn in_assembly(&self, slot: usize) -> Result<bool, EditError> {
        self.in_assembly_with(slot, None)
    }

    /// Keep the classifier's complete immutable scene for an active graph callback.
    /// Default callers still discard it; a false classification never supplies a tuple.
    fn in_assembly_with(&self, slot: usize, mut evaluation: Option<&mut Option<(std::sync::Arc<Prepared>, Frame, Scene)>>) -> Result<bool, EditError> {
        if let Some(output) = evaluation.as_mut() { **output = None; }
        let objects = self.selection_frame()?;
        if !objects.iter().any(|o| o.get("join").is_some_and(Value::truthy)) {
            return Ok(false);
        }
        let (prepared, frame, scene) = self.evaluate()?;
        let graph = assembly_of(&prepared, &frame, slot).is_some();
        if graph && let Some(output) = evaluation {
            *output = Some((prepared, frame, scene));
        }
        Ok(graph)
    }

    /// `_ikPoseSlots(frame, slots)`: with IK on joined figures, a gesture takes in every
    /// figure of an assembly it touches that has an enabled controller.
    pub(crate) fn ik_pose_slots(objects: &[Value], slots: Vec<usize>) -> Vec<usize> {
        let enabled = |object: &Value| controllers(object).iter().any(|(_, c)| truthy(c, "enabled"));
        if !objects.iter().any(|o| o.get("join").is_some_and(Value::truthy)) || !objects.iter().any(enabled) {
            return slots;
        }
        let mut affected: std::collections::BTreeSet<usize> = slots.into_iter().collect();
        let joins: Vec<Option<usize>> = objects.iter().map(join_target).collect();
        for group in ik::joined::components_of(&joins) {
            if group.iter().any(|slot| affected.contains(slot)) && group.iter().any(|&slot| enabled(&objects[slot])) {
                affected.extend(group);
            }
        }
        affected.into_iter().collect()
    }

    /// `_expandIKDrag(slots)`: the gesture's snapshots take in these figures too.
    pub(crate) fn expand_drag(&mut self, slots: &[usize]) {
        let objects = self.frame_objects();
        let Some(drag) = self.drag.as_mut() else { return };
        let slot_of = |o: &Value| o.get("object_slot").and_then(Value::as_f64).unwrap_or(f64::NAN);
        for &slot in slots {
            if !drag.before.iter().any(|o| slot_of(o) == slot as f64)
                && let Some(object) = objects.get(slot)
            {
                drag.before.push(object.clone());
            }
        }
        drag.before.sort_by(|a, b| slot_of(a).total_cmp(&slot_of(b)));
    }

    /// `captureFor` for an assembly, using the geometry already evaluated for the call.
    pub(crate) fn capture_joined(&self, prepared: &Prepared, frame: &Frame, scene: &Scene, assembly: &Assembly<'_>, slot: usize, handle: u32, spec: &crate::spatial_ik::CaptureSpec) -> Result<crate::spatial_ik::Capture, EditError> {
        let unported = |what: &str| EditError::Unported(format!("capturing a joined IK limb {what}"));
        let id = assembly.id(slot, handle).ok_or_else(|| unported("without a handle"))?;
        let geometry_of = |slot: usize| scene.objects.iter().find(|g| g.uid == frame.objects[slot].uid && g.resolved);
        let chain = assembly.chain(slot, handle, spec.chain_length);
        if chain.is_empty() { return Err(unported("without a chain")); }
        let solved = solve_frame(prepared, frame, scene);
        let (mut followers, mut joined, mut spatial, mut joined_spatial) = (BTreeMap::new(), BTreeMap::<u32, BTreeMap<u32, f64>>::new(), BTreeMap::new(), BTreeMap::<u32, BTreeMap<u32, [f64; 4]>>::new());
        for i in assembly.skeleton().follower_indices(id) {
            let entry = assembly.entry(i);
            let angle = displayed_angle(prepared, frame, scene, &solved, entry.slot, entry.index) - spec.rotation;
            if entry.slot == slot { followers.insert(entry.handle, angle); } else { joined.entry(entry.uid).or_default().insert(entry.handle, angle); }
            if let Some(q) = crate::spatial_ik::follower_orientation(geometry_of(entry.slot), entry.index, spec.rotation) {
                if entry.slot == slot { spatial.insert(entry.handle, q); } else { joined_spatial.entry(entry.uid).or_default().insert(entry.handle, q); }
            }
        }
        let mut points = Vec::with_capacity(chain.len() + 1); let mut lengths = Vec::with_capacity(chain.len());
        for (k, &i) in chain.iter().enumerate() {
            let entry = assembly.entry(i); let geometry = geometry_of(entry.slot).ok_or_else(|| unported("of an unresolved figure"))?;
            let (start, end) = (geometry.starts[entry.index], geometry.ends[entry.index]);
            if k == 0 { points.push(start); } points.push(end); lengths.push(hypot(end[0] - start[0], end[1] - start[1]));
        }
        let geometry = geometry_of(slot).ok_or_else(|| unported("of an unresolved owner"))?;
        let figure = figure_of(prepared, frame, slot).ok_or_else(|| unported("without a definition"))?;
        let index = figure.plan.index_of.get(&handle).copied().ok_or_else(|| unported("without a joint"))? as usize;
        let raw = geometry.spatial.as_ref().and_then(|s| s.depths.get(index)).and_then(|d| d.raw);
        let target = raw.map_or(geometry.ends[index], |p| [p[0], p[1]]);
        Ok(crate::spatial_ik::Capture { target, followers, joined_followers: Some(joined), bend_direction: spec.bend_direction.unwrap_or(f64::NAN), bend_reference: ik::bend_reference(&points, &lengths, spec.bend_reference.as_ref()), spatial_followers: (!spatial.is_empty()).then_some(spatial), joined_spatial_followers: (!joined_spatial.is_empty()).then_some(joined_spatial), spatial_target: None })
    }

    /// The joined branch of `poseIKTarget` for an unpinned controller (`poseGraph`): the
    /// limb is captured across the assembly (`captureFor`), solved with the captured
    /// controller pinned at the pointer, and every figure of the assembly takes its part
    /// of the solution.
    fn pose_graph(&mut self, slot: usize, handle: u32, x: f64, y: f64, evaluation: Option<&(std::sync::Arc<Prepared>, Frame, Scene)>) -> Result<(), EditError> {
        let unported = |what: &str| EditError::Unported(format!("posing a joined IK target {what}"));
        let owned;
        let (prepared, frame, scene) = match evaluation {
            Some((prepared, frame, scene)) => (&**prepared, frame, scene),
            None => {
                owned = self.evaluate()?;
                (&*owned.0, &owned.1, &owned.2)
            },
        };
        let mut assembly = assembly_of(prepared, frame, slot).ok_or_else(|| unported("outside an assembly"))?;
        self.expand_drag(&assembly.slots.clone());
        let object = self.frame_objects().get(slot).cloned().ok_or_else(|| unported("outside the frame"))?;
        let key = handle.to_string();
        let current = object.path(&["_stykIK", &key]).cloned().unwrap_or(Value::Null);
        let controller = ik::parse::table(object.get("_stykIK")).and_then(|t| t.get(handle).cloned()).ok_or_else(|| unported("with a controller the engine cannot read"))?;
        let id = assembly.id(slot, handle).ok_or_else(|| unported("of a handle outside the assembly"))?;
        let spec = crate::spatial_ik::CaptureSpec { rotation: controller.target.rotation, chain_length: controller.chain_length, bend_direction: Some(controller.bend_direction), bend_reference: controller.bend_reference.clone(), swivel: 0.0 };
        let capture = self.capture_joined(prepared, frame, scene, &assembly, slot, handle, &spec)?;
        let (followers, joined, captured, rotation) = (capture.followers.clone(), capture.joined_followers.clone().unwrap_or_default(), capture.bend_reference.clone(), spec.rotation);
        let temporary = Controller {
            pinned: true,
            target: Target { x, y, rotation },
            followers: followers.clone(),
            joined_followers: Some(joined.clone()),
            bend_reference: Some(captured.clone()),
            spatial_followers: capture.spatial_followers.clone().or(controller.spatial_followers.clone()),
            joined_spatial_followers: capture.joined_spatial_followers.clone().or(controller.joined_spatial_followers.clone()),
            ..controller
        };
        // The lengths the gesture began with, scaled into the skeleton.
        let before = self.drag.as_ref().map(|d| d.before.clone()).unwrap_or_default();
        let baseline_of = |slot: usize| before.iter().find(|o| o.get("object_slot").and_then(Value::as_f64) == Some(slot as f64));
        for i in 0..assembly.lengths_mut().len() {
            let entry = assembly.entry(i);
            let baseline = baseline_of(entry.slot).ok_or_else(|| unported("outside the gesture"))?;
            let length = if baseline.get("len_flag").is_some_and(Value::truthy) {
                baseline.get("lengths").and_then(|l| l.item(entry.index)).and_then(|v| v.as_f64()).unwrap_or(f64::NAN)
            } else {
                frame.objects[entry.slot].figure_override.as_ref().or_else(|| prepared.doc.figure(frame.objects[entry.slot].figure)).map_or(f64::NAN, |f| f.segments[entry.index].length)
            };
            assembly.lengths_mut()[i] = length * entry.scale;
        }
        let mapped = assembly.map_controller(slot, id, &temporary);
        let table = Table { controllers: BTreeMap::from([(id, mapped)]) };
        let solution = assembly.solve(&table).ok_or_else(|| unported("the solver did not reach"))?;
        let bend = solution.results.iter().find(|(h, _)| *h == id).and_then(|(_, o)| o.bend_reference.clone()).unwrap_or(captured);
        for part in assembly.scatter(&solution, &table) {
            let baseline = baseline_of(part.slot).cloned().ok_or_else(|| unported("outside the gesture"))?;
            let record = self.frame_object_mut(part.slot).ok_or_else(|| unported("outside the frame"))?;
            record.set("angles", Value::nums(&part.solution.angles));
            match (&part.solution.lengths, baseline.get("len_flag")) {
                (Some(_), _) => record.set("len_flag", Value::Num(1.0)),
                (None, Some(flag)) => record.set("len_flag", flag.clone()),
                (None, None) => {
                    record.remove("len_flag");
                }
            }
            match (&part.solution.lengths, baseline.get("lengths")) {
                (Some(lengths), _) => record.set("lengths", Value::nums(lengths)),
                (None, Some(lengths)) => record.set("lengths", lengths.clone()),
                (None, None) => {
                    record.remove("lengths");
                }
            }
            record.remove("runtime_segments");
        }
        // `Object.assign(next, {...captured, target, bendReference})`
        let mut next = current.as_obj().cloned().unwrap_or_default();
        let mut target = current.get("target").and_then(Value::as_obj).cloned().unwrap_or_default();
        target.set("x", Value::Num(x));
        target.set("y", Value::Num(y));
        next.set("target", Value::object(target));
        next.set("followers", angle_table(&followers));
        next.set("joinedFollowers", joined_table(&joined));
        if let Some(q) = &capture.spatial_followers { next.set("spatialFollowers", crate::spatial_ik::quaternion_table(q)); }
        if let Some(q) = &capture.joined_spatial_followers { next.set("joinedSpatialFollowers", crate::spatial_ik::joined_quaternion_table(q)); }
        match current.get("bendDirection") {
            Some(direction) => next.set("bendDirection", direction.clone()),
            None => {
                next.remove("bendDirection");
            }
        }
        next.set("bendReference", reference_value(&bend));
        let record = self.frame_object_mut(slot).ok_or_else(|| unported("outside the frame"))?;
        set_controller(record, &key, next);
        record.remove("runtime_segments");
        Ok(())
    }

    /// The posed half of `_objectEdit`: every figure of the gesture with a pinned limb takes
    /// the angles it is displayed with, and its controllers the followers of that solution.
    pub(crate) fn bake_pinned(&mut self) -> Result<(), EditError> {
        let Some(drag) = self.drag.as_ref() else { return Ok(()) };
        let before = drag.before.clone();
        if !before.iter().any(has_pinned) {
            return Ok(());
        }
        let solved = self.solutions()?;
        for snapshot in &before {
            let Some(id) = uid(snapshot) else { continue };
            if self.layer_locked(id) {
                continue;
            }
            let objects = self.frame_objects();
            let Some(slot) = objects.iter().position(|o| uid(o) == Some(id)) else { continue };
            let Some(Solved { solution, followers, joined }) = solved.get(&id) else { continue };
            if objects[slot].get("angles").and_then(Value::array_len) != Some(solution.angles.len()) {
                return Err(EditError::Unported("baking IK into a pose without one angle per segment".into()));
            }
            let mut controllers = objects[slot].get("_stykIK").and_then(Value::as_obj).cloned().unwrap_or_default();
            let mut changed = false;
            for (handle, outcome) in &solution.results {
                let key = handle.to_string();
                let Some(c) = controllers.get(&key).filter(|c| truthy(c, "enabled") && truthy(c, "pinned")) else { continue };
                let (Some((own, others)), false) = (followers.get(handle), outcome.conflict) else { continue };
                let mut next = c.as_obj().cloned().unwrap_or_default();
                next.set("followers", angle_table(own));
                if *joined {
                    next.set("joinedFollowers", joined_table(others));
                }
                controllers.set(&key, Value::object(next));
                changed = true;
            }
            let record = self.frame_object_mut(slot).unwrap();
            if changed {
                record.set("_stykIK", Value::object(controllers));
            }
            record.set("angles", Value::nums(&solution.angles));
        }
        Ok(())
    }

    /// `_rememberIKBends`: after a change, each pinned automatic ("Both") controller of the
    /// gesture keeps the bend its limb is now solved with, so the next solve continues
    /// from it. A bend within 1e-7 of the one the gesture started with stays as it was.
    pub(crate) fn remember_bends(&mut self) -> Result<(), EditError> {
        let Some(drag) = self.drag.as_ref() else { return Ok(()) };
        let before = drag.before.clone();
        let objects = self.frame_objects();
        let mut solved: Option<HashMap<u32, Solved>> = None;
        for snapshot in &before {
            let Some(slot) = snapshot.get("object_slot").and_then(Value::as_f64).filter(|s| *s >= 0.0).map(|s| s as usize) else { continue };
            let Some(object) = objects.get(slot) else { continue };
            let Some(id) = uid(object).filter(|&u| Some(u) == uid(snapshot)) else { continue };
            if self.layer_locked(id) {
                continue;
            }
            for (key, c) in controllers(object) {
                if !(truthy(&c, "enabled") && truthy(&c, "pinned") && c.get("bendDirection").and_then(Value::as_f64) == Some(0.0)) {
                    continue;
                }
                if solved.is_none() {
                    solved = Some(self.solutions()?);
                }
                let Ok(handle) = key.parse::<u32>() else { continue };
                let outcome = solved.as_ref().unwrap().get(&id).and_then(|s| s.solution.results.iter().find(|(h, _)| *h == handle));
                let Some(reference) = outcome.and_then(|(_, o)| o.bend_reference.as_ref()) else { continue };
                let value = match snapshot.path(&["_stykIK", &key, "bendReference"]) {
                    Some(baseline) if same_bend(reference, baseline) => baseline.clone(),
                    _ => reference_value(reference),
                };
                let mut next = c.as_obj().cloned().unwrap_or_default();
                next.set("bendReference", value);
                set_controller(self.frame_object_mut(slot).unwrap(), &key, next);
            }
        }
        Ok(())
    }

    /// `_rotateIKFollowers(targets, delta, includeJoint)`: turning a joint of a pinned
    /// controller's outgoing group by hand changes the angle that group keeps relative
    /// to the target; turning an ancestor leaves the target's orientation planted.
    pub(crate) fn rotate_ik_followers(&mut self, slot: usize, joint: usize, targets: &[(usize, usize)], delta: f64, include_joint: bool) -> Result<(), EditError> {
        if delta == 0.0 || delta.is_nan() || !self.drag.as_ref().is_some_and(|d| d.before.iter().any(has_pinned)) {
            return Ok(());
        }
        let unported = |what: &str| EditError::Unported(format!("turning the followers of an IK target {what}"));
        let selected: HashSet<(usize, usize)> = targets.iter().copied().collect();
        if self.in_assembly(slot)? {
            return self.rotate_assembly_followers(slot, joint, &selected, delta, include_joint);
        }
        let source = self.frame_objects().get(slot).cloned().ok_or_else(|| unported("outside the frame"))?;
        let prepared = self.prepared()?;
        let figure = source.get("figure_type_id").and_then(Value::as_f64).and_then(|id| prepared.doc.figure(id as u32)).ok_or_else(|| unported("of a figure without a definition"))?;
        let skeleton = Skeleton { segments: &figure.segments, plan: &figure.plan, polygons: &figure.polyfills, sources: None };
        let angles = source.get("angles").and_then(Value::numbers).filter(|a| a.len() >= figure.segments.len()).ok_or_else(|| unported("of a pose without every angle"))?;
        let table = ik::parse::table(source.get("_stykIK"));
        for (key, c) in controllers(&source) {
            if !(truthy(&c, "enabled") && truthy(&c, "pinned")) {
                continue;
            }
            let Some(id) = key.parse::<u32>().ok() else { continue };
            let Some(endpoint) = skeleton.index(id) else { continue };
            if selected.contains(&(slot, endpoint)) {
                continue;
            }
            let controller = table.as_ref().and_then(|t| t.get(id)).ok_or_else(|| unported("with a controller the engine cannot read"))?;
            let followers = skeleton.followers(&angles, id, controller);
            let current = self.frame_objects()[slot].path(&["_stykIK", &key]).cloned().unwrap_or(Value::Null);
            let mut next: Option<Obj> = None;
            for i in skeleton.follower_indices(id) {
                if (!include_joint && i == joint) || !selected.contains(&(slot, i)) {
                    continue;
                }
                let handle = figure.segments[i].id;
                let next = next.get_or_insert_with(|| {
                    let mut next = current.as_obj().cloned().unwrap_or_default();
                    for key in ["followers", "joinedFollowers"] {
                        next.set(key, Value::object(current.get(key).and_then(Value::as_obj).cloned().unwrap_or_default()));
                    }
                    next
                });
                let mut table = next.get("followers").and_then(Value::as_obj).cloned().unwrap_or_default();
                assign(&mut table, &handle.to_string(), Value::Num(followers.get(&handle).copied().unwrap_or(f64::NAN) + delta));
                next.set("followers", Value::object(table));
                // `next.spatialFollowers = {...current.spatialFollowers, [handle]: turned}`: from
                // the controller as it was, so of several turned only the last stays turned.
                if let Some(q) = current.path(&["spatialFollowers", &handle.to_string()]).filter(|q| q.truthy()) {
                    let mut spatial = current.get("spatialFollowers").and_then(Value::as_obj).cloned().unwrap_or_default();
                    assign(&mut spatial, &handle.to_string(), Value::nums(&turn_quaternion(q, delta)));
                    next.set("spatialFollowers", Value::object(spatial));
                }
            }
            if let Some(next) = next {
                set_controller(self.frame_object_mut(slot).unwrap(), &key, next);
            }
        }
        Ok(())
    }

    /// `_rotateIKFollowers` on an assembly (`context()` is a graph): every pinned
    /// controller of the joined figures, its followers in their own figures or in others.
    fn rotate_assembly_followers(&mut self, slot: usize, joint: usize, selected: &HashSet<(usize, usize)>, delta: f64, include_joint: bool) -> Result<(), EditError> {
        let unported = |what: &str| EditError::Unported(format!("turning the followers of a joined IK target {what}"));
        let (prepared, frame) = self.evaluate_frame()?;
        let assembly = assembly_of(&prepared, &frame, slot).ok_or_else(|| unported("outside an assembly"))?;
        let skeleton = assembly.skeleton();
        for (&id, c) in &assembly.controllers.controllers {
            if !c.active() {
                continue;
            }
            let Some(endpoint) = skeleton.index(id) else { continue };
            let owner = assembly.entry(endpoint);
            if selected.contains(&(owner.slot, owner.index)) {
                continue;
            }
            let key = owner.handle.to_string();
            let current = self.frame_objects().get(owner.slot).and_then(|o| o.path(&["_stykIK", &key]).cloned()).unwrap_or(Value::Null);
            let followers = skeleton.followers(assembly.angles(), id, c);
            let mut next: Option<Obj> = None;
            for i in skeleton.follower_indices(id) {
                let child = assembly.entry(i);
                if (!include_joint && child.slot == slot && child.index == joint) || !selected.contains(&(child.slot, child.index)) {
                    continue;
                }
                let next = next.get_or_insert_with(|| {
                    let mut next = current.as_obj().cloned().unwrap_or_default();
                    for key in ["followers", "joinedFollowers"] {
                        next.set(key, Value::object(current.get(key).and_then(Value::as_obj).cloned().unwrap_or_default()));
                    }
                    next
                });
                let angle = Value::Num(followers.get(&skeleton.segments[i].id).copied().unwrap_or(f64::NAN) + delta);
                let (uid_key, handle_key) = (child.uid.to_string(), child.handle.to_string());
                if child.slot == owner.slot {
                    let mut table = next.get("followers").and_then(Value::as_obj).cloned().unwrap_or_default();
                    assign(&mut table, &handle_key, angle);
                    next.set("followers", Value::object(table));
                    if let Some(q) = current.path(&["spatialFollowers", &handle_key]).filter(|q| q.truthy()) {
                        let mut spatial = current.get("spatialFollowers").and_then(Value::as_obj).cloned().unwrap_or_default();
                        assign(&mut spatial, &handle_key, Value::nums(&turn_quaternion(q, delta)));
                        next.set("spatialFollowers", Value::object(spatial));
                    }
                } else {
                    let mut table = next.get("joinedFollowers").and_then(Value::as_obj).cloned().unwrap_or_default();
                    let mut inner = table.get(&uid_key).and_then(Value::as_obj).cloned().unwrap_or_default();
                    assign(&mut inner, &handle_key, angle);
                    assign(&mut table, &uid_key, Value::object(inner));
                    next.set("joinedFollowers", Value::object(table));
                    if let Some(q) = current.path(&["joinedSpatialFollowers", &uid_key, &handle_key]).filter(|q| q.truthy()) {
                        // `{...next.joinedSpatialFollowers, [uid]: {...next…[uid], [handle]: turned}}`
                        let mut spatial = next.get("joinedSpatialFollowers").and_then(Value::as_obj).cloned().unwrap_or_default();
                        let mut inner = spatial.get(&uid_key).and_then(Value::as_obj).cloned().unwrap_or_default();
                        assign(&mut inner, &handle_key, Value::nums(&turn_quaternion(q, delta)));
                        assign(&mut spatial, &uid_key, Value::object(inner));
                        next.set("joinedSpatialFollowers", Value::object(spatial));
                    }
                }
            }
            if let Some(next) = next {
                set_controller(self.frame_object_mut(owner.slot).unwrap(), &key, next);
            }
        }
        Ok(())
    }

    /// `_ikLimbPoints(handle)` of a pinned controller as displayed (its base to the joint
    /// before the end), with its chain and the stretched lengths it is displayed with.
    pub(crate) fn pinned_limb(&self, object: &Value, handle: u32) -> Result<PinnedLimb, EditError> {
        let unported = |what: &str| EditError::Unported(format!("stretching a pinned IK limb {what}"));
        let (prepared, frame, scene) = self.evaluate()?;
        let id = uid(object).ok_or_else(|| unported("without an identity"))?;
        let slot = frame.objects.iter().position(|o| o.uid == id).ok_or_else(|| unported("the engine does not draw"))?;
        let evaluated = &frame.objects[slot];
        let figure = evaluated.figure_override.as_deref().or_else(|| prepared.doc.figure(evaluated.figure).map(|f| &**f)).ok_or_else(|| unported("without a definition"))?;
        let controller = ik::parse::table(object.get("_stykIK")).and_then(|t| t.get(handle).cloned()).ok_or_else(|| unported("with a controller the engine cannot read"))?;
        // The limb's bones: in the assembly's skeleton when the figure is joined to others.
        let joined = self.selection_frame()?.iter().any(|o| o.get("join").is_some_and(Value::truthy));
        let assembly = if joined { assembly_of(&prepared, &frame, slot) } else { None };
        let bones: Vec<(usize, usize)> = match &assembly {
            Some(assembly) => assembly.chain(slot, handle, controller.chain_length).into_iter().map(|i| (assembly.entry(i).slot, assembly.entry(i).index)).collect(),
            None => {
                let skeleton = Skeleton { segments: &figure.segments, plan: &figure.plan, polygons: &figure.polyfills, sources: None };
                skeleton.chain(handle, controller.chain_length).into_iter().map(|i| (slot, i)).collect()
            }
        };
        if bones.is_empty() {
            return Err(unported("without a chain"));
        }
        let geometry_of = |slot: usize| scene.objects.iter().find(|g| g.uid == frame.objects[slot].uid && g.resolved);
        let mut points = Vec::with_capacity(bones.len());
        for (k, &(s, i)) in bones.iter().enumerate() {
            let geometry = geometry_of(s).ok_or_else(|| unported("the engine does not draw"))?;
            if k == 0 {
                points.push(geometry.starts[i]);
            }
            if k + 1 < bones.len() {
                points.push(geometry.ends[i]);
            }
        }
        // `ikChain(this.figure, handle, pin.chainLength)`: the limb in the figure's own bones.
        let skeleton = Skeleton { segments: &figure.segments, plan: &figure.plan, polygons: &figure.polyfills, sources: None };
        let chain = skeleton.chain(handle, controller.chain_length);
        let solved_lengths = solve_frame(&prepared, &frame, &scene).remove(&id).and_then(|s| s.solution.lengths);
        Ok(PinnedLimb { points, chain, solved_lengths })
    }

    /// The unpinned branch of `poseIKTarget`: `capture` the limb as drawn, solve it with
    /// the captured controller pinned at the pointer (`solveObjectIK`), keep the solved
    /// angles (and stretched lengths) in the pose, and remember the followers and the
    /// bend in the controller. Unpinned IK is a posing tool: the target does not persist.
    fn bake_unpinned(&mut self, slot: usize, handle: u32, x: f64, y: f64, evaluation: Option<&(std::sync::Arc<Prepared>, Frame, Scene, HashMap<u32, Solved>)>) -> Result<(), EditError> {
        let unported = |what: &str| EditError::Unported(format!("posing an IK target {what}"));
        let owned;
        let (prepared, frame, scene, captured_solved) = match evaluation {
            Some((prepared, frame, scene, solved)) => (&**prepared, frame, scene, Some(solved)),
            None => {
                owned = self.evaluate_only(Some(&[slot]))?;
                (&*owned.0, &owned.1, &owned.2, None)
            },
        };
        let object = self.frame_objects().get(slot).cloned().ok_or_else(|| unported("outside the frame"))?;
        let id = uid(&object).ok_or_else(|| unported("of a figure without an identity"))?;
        let evaluated = frame.objects.iter().find(|o| o.uid == id).ok_or_else(|| unported("of a figure the engine does not draw"))?;
        let geometry = scene.objects.iter().find(|g| g.uid == id && g.resolved).ok_or_else(|| unported("of a figure the engine does not draw"))?;
        let figure = evaluated.figure_override.as_deref().or_else(|| prepared.doc.figure(evaluated.figure).map(|f| &**f)).ok_or_else(|| unported("of a figure without a definition"))?;
        let key = handle.to_string();
        let current = object.path(&["_stykIK", &key]).cloned().unwrap_or(Value::Null);
        let controller = ik::parse::table(object.get("_stykIK")).and_then(|table| table.get(handle).cloned()).ok_or_else(|| unported("with a controller the engine cannot read"))?;
        let skeleton = Skeleton { segments: &figure.segments, plan: &figure.plan, polygons: &figure.polyfills, sources: None };
        let angles = object.get("angles").and_then(Value::numbers).filter(|a| a.len() >= figure.segments.len()).ok_or_else(|| unported("of a pose without every angle"))?;

        // capture(figure, object, geometry, handle, controller), kept for the gesture once it
        // has a 3D target (`_drag.ikCapture`).
        let rotation = controller.target.rotation;
        let capture_key = format!("{id}:{handle}");
        let capture = |editor: &Editor| {
            let owned_solved;
            let solved = match captured_solved {
                Some(solved) => solved,
                None => { owned_solved = solve_frame(prepared, frame, scene); &owned_solved },
            };
            editor.capture_limb_from(slot, handle, prepared, frame, scene, solved)
        };
        let fresh = if !self.drag.as_ref().is_some_and(|d| d.ik_captures.contains_key(&capture_key)) {
            let capture = capture(self)?;
            if let Some(drag) = self.drag.as_mut() {
                drag.ik_captures.insert(capture_key.clone(), capture.clone());
            }
            Some(capture)
        } else { None };
        let cached = self.drag.as_ref().and_then(|d| d.ik_captures.get(&capture_key).cloned());
        let captured = match cached {
            Some(capture) if capture.spatial_target.is_some() => capture,
            // A fresh 2D capture is valid within this invocation only. Subsequent drag calls
            // recapture the current selection pose; only a 3D target retains its baseline.
            _ => match fresh {
                Some(capture) => capture,
                None => capture(self)?,
            },
        };
        let followers = captured.followers.clone();
        // `{...next, ...captured}`: the captured 3D parts, else the controller's.
        let mut spatial_value = match &captured.spatial_target {
            Some(target) => Some(crate::spatial_ik::spatial_target_value(target)),
            None => current.get("spatialTarget").filter(|s| s.truthy()).cloned(),
        };
        let mut spatial_target = captured.spatial_target.clone().or_else(|| controller.spatial_target.clone());
        if let Some(spatial) = spatial_target.as_mut() {
            let bend = current.get("bendDirection").and_then(Value::as_f64).unwrap_or(f64::NAN);
            if let Some(pole) = self.flat_spatial_ik_pole(slot, handle, controller.chain_length, bend, [x, y], spatial)? {
                spatial.pole = pole;
                spatial_value = spatial_value.map(|v| crate::spatial_ik::merged(&v, &[("pole", Value::nums(&pole))]));
            }
        }
        let spatial_followers = captured.spatial_followers.clone();
        let follow = spatial_target.is_none();
        let captured_reference = captured.bend_reference.clone();
        let temporary = Controller {
            pinned: true,
            target: Target { x, y, rotation },
            followers: followers.clone(),
            bend_direction: captured.bend_direction,
            bend_reference: Some(captured_reference.clone()),
            spatial_followers: spatial_followers.clone().or_else(|| controller.spatial_followers.clone()),
            spatial_target: spatial_target.clone(),
            ..controller
        };
        let baseline = self.drag.as_ref().and_then(|drag| drag.before.iter().find(|o| uid(o) == Some(id)).cloned()).ok_or_else(|| unported("outside a gesture"))?;
        let length_flag = baseline.get("len_flag").cloned();
        let rest = if length_flag.as_ref().is_some_and(Value::truthy) {
            Some(baseline.get("lengths").and_then(Value::numbers).ok_or_else(|| unported("of a pose with unreadable lengths"))?)
        } else {
            None
        };
        let bends = if object.get("bend_flag").is_some_and(Value::truthy) { object.get("bends").and_then(Value::numbers) } else { None };
        let pose = Pose {
            scale: object.get("scale").and_then(Value::as_f64).unwrap_or(f64::NAN),
            angles: &angles,
            lengths: rest.as_deref(),
            bends: bends.as_deref(),
            mirror: object.get("image_text_flags").is_some_and(Value::truthy),
            figure_angle: ik::figure_angle(figure, evaluated),
            shape: evaluated.spatial.as_ref().and_then(|s| s.shape.as_ref()),
        };
        let table = Table { controllers: BTreeMap::from([(handle, temporary)]) };
        let solution = ik::solve_object_with(&skeleton, &pose, geometry.root, &table, follow).ok_or_else(|| unported("the solver did not reach"))?;
        let solved = solution.results.iter().find(|(h, _)| *h == handle).and_then(|(_, outcome)| outcome.bend_reference.clone());

        let mut next = current.as_obj().cloned().unwrap_or_default();
        let mut target = current.get("target").and_then(Value::as_obj).cloned().unwrap_or_default();
        target.set("x", Value::Num(x));
        target.set("y", Value::Num(y));
        next.set("target", Value::object(target));
        next.set("followers", angle_table(&followers));
        if let Some(followers) = &spatial_followers {
            next.set("spatialFollowers", crate::spatial_ik::quaternion_table(followers));
        }
        if let Some(value) = spatial_value {
            next.set("spatialTarget", value);
        }
        next.set("bendReference", reference_value(solved.as_ref().unwrap_or(&captured_reference)));
        let record = self.frame_object_mut(slot).ok_or_else(|| unported("outside the frame"))?;
        record.set("angles", Value::nums(&solution.angles));
        match (&solution.lengths, length_flag) {
            (Some(_), _) => record.set("len_flag", Value::Num(1.0)),
            (None, Some(flag)) => record.set("len_flag", flag),
            (None, None) => {
                record.remove("len_flag");
            }
        }
        match (&solution.lengths, baseline.get("lengths")) {
            (Some(lengths), _) => record.set("lengths", Value::nums(lengths)),
            (None, Some(lengths)) => record.set("lengths", lengths.clone()),
            (None, None) => {
                record.remove("lengths");
            }
        }
        set_controller(record, &key, next);
        record.remove("runtime_segments");
        Ok(())
    }
}

/// A frame's pinned solution of one figure and each controller's followers (by handle),
/// solved on its own or as part of an assembly (`joined`).
pub(crate) struct Solved {
    pub solution: Solution,
    followers: BTreeMap<u32, Followers>,
    joined: bool,
}

impl Solved {
    /// `geometry.ik.get(handle).followers`: the followers of a limb that solved.
    pub(crate) fn followers_of(&self, handle: u32) -> Option<&BTreeMap<u32, f64>> {
        let (_, outcome) = self.solution.results.iter().find(|(h, _)| *h == handle)?;
        if outcome.conflict {
            return None;
        }
        self.followers.get(&handle).map(|(own, _)| own)
    }
    pub(crate) fn joined_followers_of(&self, handle: u32) -> Option<&BTreeMap<u32, BTreeMap<u32, f64>>> {
        let (_, outcome) = self.solution.results.iter().find(|(h, _)| *h == handle)?;
        if outcome.conflict || !self.joined { return None; }
        self.followers.get(&handle).map(|(_, joined)| joined)
    }

}

/// `_bakeIKFollowers(object, geometry)`: each enabled, pinned controller of the figure takes
/// the followers its limb is solved with.
pub(crate) fn bake_object(record: &mut Obj, solved: &Solved) {
    let mut controllers = record.get("_stykIK").and_then(Value::as_obj).cloned().unwrap_or_default();
    let mut changed = false;
    for (handle, outcome) in &solved.solution.results {
        let key = handle.to_string();
        let Some(c) = controllers.get(&key).filter(|c| truthy(c, "enabled") && truthy(c, "pinned")) else { continue };
        let (Some((own, others)), false) = (solved.followers.get(handle), outcome.conflict) else { continue };
        let mut next = c.as_obj().cloned().unwrap_or_default();
        next.set("followers", angle_table(own));
        if solved.joined {
            next.set("joinedFollowers", joined_table(others));
        }
        controllers.set(&key, Value::object(next));
        changed = true;
    }
    if changed {
        record.set("_stykIK", Value::object(controllers));
    }
}

/// The figures' typed views by slot, as geometry resolves them.
fn figure_of<'a>(prepared: &'a Prepared, frame: &'a Frame, slot: usize) -> Option<&'a std::sync::Arc<styk_eval::doc::Figure>> {
    let object = frame.objects.get(slot)?;
    object.figure_override.as_ref().or_else(|| prepared.doc.figure(object.figure))
}

/// `context()`: the assembly of joined figures that `slot` belongs to, when there is one
/// of two figures or more and it compiles.
pub(crate) fn assembly_of<'a>(prepared: &'a Prepared, frame: &'a Frame, slot: usize) -> Option<Assembly<'a>> {
    if !frame.objects.iter().any(|o| o.join.is_some()) {
        return None;
    }
    let slots = ik::joined::components(frame).into_iter().find(|slots| slots.contains(&slot)).filter(|slots| slots.len() > 1)?;
    Assembly::new(frame, &slots, &|slot| figure_of(prepared, frame, slot))
}

/// The pinned limbs of a frame solved as geometry solves them (`solveJoinedIK`, then
/// `evaluateIKPose` for the other figures with a pinned controller), by figure identity.
pub(crate) fn solve_frame(prepared: &Prepared, frame: &Frame, scene: &Scene) -> HashMap<u32, Solved> {
    let mut solved = HashMap::new();
    if !frame.objects.iter().any(|o| ik::has_pinned(o)) {
        return solved;
    }
    if frame.objects.iter().any(|o| o.join.is_some()) {
        for slots in ik::joined::components(frame) {
            if slots.len() < 2 || !slots.iter().any(|&slot| ik::has_pinned(&frame.objects[slot])) {
                continue;
            }
            let Some(assembly) = Assembly::new(frame, &slots, &|slot| figure_of(prepared, frame, slot)) else { continue };
            let Some(solution) = assembly.solve(&assembly.controllers) else { continue };
            for part in assembly.scatter(&solution, &assembly.controllers) {
                solved.insert(frame.objects[part.slot].uid, Solved { solution: part.solution, followers: part.followers, joined: true });
            }
        }
    }
    for (slot, object) in frame.objects.iter().enumerate() {
        if !ik::has_pinned(object) || solved.contains_key(&object.uid) {
            continue;
        }
        let Some(figure) = figure_of(prepared, frame, slot) else { continue };
        // Where geometry draws the figure from: a joined figure hangs from its parent's joint.
        let root = scene.objects.iter().find(|g| g.uid == object.uid).map_or(object.root, |g| g.root);
        let Some(solution) = ik::solve_local(figure, object, root) else { continue };
        let table = object.ik.as_ref().unwrap();
        let skeleton = Skeleton { segments: &figure.segments, plan: &figure.plan, polygons: &figure.polyfills, sources: None };
        let angles: Vec<f64> = figure.segments.iter().enumerate().map(|(i, s)| object.angles.get(i).copied().unwrap_or(s.angle)).collect();
        // `results.get(id).followers`: `ikFollowers` of each controller that solved.
        let followers = solution
            .results
            .iter()
            .filter(|(_, outcome)| !outcome.conflict)
            .filter_map(|(id, _)| Some((*id, (skeleton.followers(&angles, *id, table.get(*id)?).into_iter().collect(), BTreeMap::new()))))
            .collect();
        solved.insert(object.uid, Solved { solution, followers, joined: false });
    }
    solved
}

/// The angle geometry draws segment `index` of the figure in `slot` with: solved for a
/// pinned limb (`ik.angles[i] ?? obj.angles[i]`), then through the figure's rig.
pub(crate) fn displayed_angle(prepared: &Prepared, frame: &Frame, scene: &Scene, solved: &HashMap<u32, Solved>, slot: usize, index: usize) -> f64 {
    let object = &frame.objects[slot];
    // A rigged figure is drawn as its rig evaluates it, every joint drawn or not.
    let rigged = scene.objects.iter().find(|g| g.uid == object.uid && g.resolved).and_then(|g| g.rig.as_ref()).and_then(|rig| rig.get(index).copied());
    if let Some(joint) = rigged {
        return joint.angle;
    }
    if let Some(angle) = solved.get(&object.uid).and_then(|s| s.solution.angles.get(index)) {
        return *angle;
    }
    match figure_of(prepared, frame, slot).and_then(|f| f.segments.get(index)) {
        Some(segment) => styk_eval::geometry::segment_pose(object, segment, index).0,
        None => object.angles.get(index).copied().unwrap_or(f64::NAN),
    }
}

/// The one angle `shape` reads, without unrelated solves or reporting followers.
/// The full owning solver still processes every controller of the selected assembly.
pub(crate) fn shape_angle(prepared: &Prepared, frame: &Frame, scene: &Scene, slot: usize, index: usize) -> f64 {
    let object = &frame.objects[slot];
    // The global map is keyed by UID: duplicate identities preserve its original
    // cross-component overwrite/skip order instead of selecting a slot's solve.
    if frame.objects.iter().filter(|other| other.uid == object.uid).take(2).count() > 1 {
        return displayed_angle(prepared, frame, scene, &solve_frame(prepared, frame, scene), slot, index);
    }
    // `shape` normally returns through its rig branch before reaching this helper.
    let rigged = scene.objects.iter().find(|g| g.uid == object.uid && g.resolved).and_then(|g| g.rig.as_ref()).and_then(|rig| rig.get(index).copied());
    if let Some(joint) = rigged {
        return joint.angle;
    }
    let authored = || match figure_of(prepared, frame, slot).and_then(|f| f.segments.get(index)) {
        Some(segment) => styk_eval::geometry::segment_pose(object, segment, index).0,
        None => object.angles.get(index).copied().unwrap_or(f64::NAN),
    };
    if !frame.objects.iter().any(|other| ik::has_pinned(other)) {
        return authored();
    }
    if frame.objects.iter().any(|other| other.join.is_some()) {
        if let Some(slots) = ik::joined::components(frame).into_iter().find(|slots| slots.contains(&slot))
            && slots.len() >= 2 && slots.iter().any(|&slot| ik::has_pinned(&frame.objects[slot]))
            && let Some(assembly) = Assembly::new(frame, &slots, &|slot| figure_of(prepared, frame, slot))
            && let Some(solution) = assembly.solve(&assembly.controllers)
        {
            // Match scatter's authored initialization and last exact-entry assignment.
            // Mapping through a handle ID would instead choose the last duplicate ID.
            let mut angle = object.angles.get(index).copied().or_else(|| figure_of(prepared, frame, slot).and_then(|figure| figure.segments.get(index)).map(|segment| segment.angle)).unwrap_or(f64::NAN);
            for at in 0..assembly.skeleton().segments.len() {
                let entry = assembly.entry(at);
                if entry.slot == slot && entry.index == index {
                    angle = solution.angles[at];
                }
            }
            return angle;
        }
    }
    // Match solve_frame's local fallback after an uncompiled/unsolved assembly,
    // including its first geometry-UID root lookup (not a resolved-only lookup).
    if ik::has_pinned(object) && let Some(figure) = figure_of(prepared, frame, slot) {
        let root = scene.objects.iter().find(|g| g.uid == object.uid).map_or(object.root, |g| g.root);
        if let Some(angle) = ik::solve_local(figure, object, root).and_then(|solution| solution.angles.get(index).copied()) {
            return angle;
        }
    }
    authored()
}

/// Followers of figures joined to a controller's owner, as the editor stores them
/// (`joinedFollowers`: by identity, then by handle).
pub(crate) fn joined_table(joined: &BTreeMap<u32, BTreeMap<u32, f64>>) -> Value {
    let mut table = Obj::new();
    for (uid, angles) in joined {
        table.set(&uid.to_string(), angle_table(angles));
    }
    Value::object(table)
}

/// A pinned limb as displayed, for a stretch drag on its end.
pub(crate) struct PinnedLimb {
    pub points: Vec<[f64; 2]>,
    pub chain: Vec<usize>,
    pub solved_lengths: Option<Vec<f64>>,
}

/// `hasPinnedIK(object)`.
pub(crate) fn has_pinned(object: &Value) -> bool {
    controllers(object).iter().any(|(_, c)| truthy(c, "enabled") && truthy(c, "pinned"))
}

/// `_followStretchedIK(object, handle, limb, tip)`: the pin of a stretched end follows it
/// and keeps the bend now shown.
pub(crate) fn follow_stretched(record: &mut Obj, handle: u32, limb: &[[f64; 2]], tip: [f64; 2]) {
    let key = handle.to_string();
    let current = record.get("_stykIK").and_then(|t| t.get(&key)).cloned().unwrap_or(Value::Null);
    let previous = ik::parse::table(record.get("_stykIK")).and_then(|t| t.get(handle).and_then(|c| c.bend_reference.clone()));
    let points: Vec<[f64; 2]> = limb.iter().copied().chain(std::iter::once(tip)).collect();
    let lengths: Vec<f64> = points.windows(2).map(|w| hypot(w[1][0] - w[0][0], w[1][1] - w[0][1])).collect();
    let reference = ik::bend_reference(&points, &lengths, previous.as_ref());
    let mut next = current.as_obj().cloned().unwrap_or_default();
    let mut target = current.get("target").and_then(Value::as_obj).cloned().unwrap_or_default();
    target.set("x", Value::Num(tip[0]));
    target.set("y", Value::Num(tip[1]));
    next.set("target", Value::object(target));
    next.set("bendReference", reference_value(&reference));
    // `bendDirection: c.bendDirection && bendReference.side`
    match current.get("bendDirection") {
        Some(direction) if direction.truthy() => next.set("bendDirection", Value::Num(reference.side)),
        Some(direction) => next.set("bendDirection", direction.clone()),
        None => {
            next.remove("bendDirection");
        }
    }
    set_controller(record, &key, next);
}

/// `object._stykIK = {...object._stykIK, [key]: next}`.
pub(crate) fn set_controller(record: &mut Obj, key: &str, next: Obj) {
    set_controller_value(record, key, Value::object(next));
}

pub(crate) fn set_controller_value(record: &mut Obj, key: &str, next: Value) {
    let mut table = record.get("_stykIK").and_then(Value::as_obj).cloned().unwrap_or_default();
    assign(&mut table, key, next);
    record.set("_stykIK", Value::object(table));
}

/// `quatMultiply(spatialQuaternion(delta, 0, 0), q)`: a follower's world orientation turned in the view plane.
fn turn_quaternion(q: &Value, delta: f64) -> [f64; 4] {
    let q = q.numbers().unwrap_or_default();
    let q = [q.first().copied().unwrap_or(f64::NAN), q.get(1).copied().unwrap_or(f64::NAN), q.get(2).copied().unwrap_or(f64::NAN), q.get(3).copied().unwrap_or(f64::NAN)];
    styk_eval::rig::quat_multiply(styk_eval::rig::spatial_quaternion(delta, 0.0, 0.0), q)
}

/// `_releaseSpatialChain(object, index)`: posing a bone by hand takes its limb from a
/// planted 3D controller whose chain holds it.
pub(crate) fn release_spatial_chain(record: &mut Obj, figure: &styk_eval::doc::Figure, index: usize) {
    let Some(table) = record.get("_stykIK").and_then(Value::as_obj).cloned() else { return };
    let skeleton = Skeleton { segments: &figure.segments, plan: &figure.plan, polygons: &figure.polyfills, sources: None };
    let mut changed = table.clone();
    let mut any = false;
    for (id, c) in table.iter() {
        if !(truthy(c, "enabled") && truthy(c, "pinned") && truthy(c, "spatialTarget")) {
            continue;
        }
        let Ok(handle) = id.parse::<u32>() else { continue };
        let length = c.get("chainLength").and_then(Value::as_f64).unwrap_or(f64::NAN);
        if length.is_nan() || length < 0.0 || !skeleton.chain(handle, length.min(u32::MAX as f64) as u32).contains(&index) {
            continue;
        }
        let mut next = c.as_obj().cloned().unwrap_or_default();
        next.set("pinned", Value::Bool(false));
        assign(&mut changed, id, Value::object(next));
        any = true;
    }
    if any {
        record.set("_stykIK", Value::object(changed));
    }
}

/// An array index as JavaScript objects enumerate them: first, in ascending order.
fn index_key(key: &str) -> Option<u32> {
    if key.is_empty() || (key.len() > 1 && key.starts_with('0')) || !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    key.parse::<u32>().ok().filter(|&n| n < u32::MAX)
}

/// `object[key] = value` in JavaScript's key order: an existing key keeps its place, a new
/// index key goes among the index keys in ascending order, any other key last.
pub(crate) fn assign(object: &mut Obj, key: &str, value: Value) {
    let Some(n) = index_key(key).filter(|_| !object.contains(key)) else {
        object.set(key, value);
        return;
    };
    let entries: Vec<(std::sync::Arc<str>, Value)> = object.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    let at = entries.iter().position(|(k, _)| index_key(k).is_none_or(|m| m > n)).unwrap_or(entries.len());
    let mut next = Obj::new();
    for (k, v) in &entries[..at] {
        next.set(k, v.clone());
    }
    next.set(key, value);
    for (k, v) in &entries[at..] {
        next.set(k, v.clone());
    }
    *object = next;
}

/// Angles by handle, as the editor stores followers (index keys, ascending).
pub(crate) fn angle_table(angles: &BTreeMap<u32, f64>) -> Value {
    let mut table = Obj::new();
    for (handle, angle) in angles {
        table.set(&handle.to_string(), Value::Num(*angle));
    }
    Value::object(table)
}

/// `_rememberIKBends`' test that a solved bend is the one the gesture began with.
pub(crate) fn same_bend(reference: &BendReference, baseline: &Value) -> bool {
    let number = |key: &str| baseline.get(key).and_then(Value::as_f64);
    let close = |a: f64, b: Option<f64>| {
        let d = a - b.unwrap_or(f64::NAN);
        atan2(sin(d), cos(d)).abs() < 1e-7
    };
    let shape = baseline.get("shape");
    Some(reference.side) == number("side")
        && close(reference.angle, number("angle"))
        && close(reference.axis, number("axis"))
        && (reference.ratio - number("ratio").unwrap_or(f64::NAN)).abs() < 1e-7
        && reference.shape.as_ref().map(Vec::len) == shape.and_then(Value::array_len)
        && reference.shape.as_ref().is_none_or(|s| s.iter().enumerate().all(|(i, &a)| close(a, shape.and_then(|v| v.item(i)).and_then(|v| v.as_f64()))))
}

/// `ikBendReference`'s result as the editor stores it in a controller.
pub(crate) fn reference_value(reference: &BendReference) -> Value {
    let mut value = Obj::new();
    value.set("side", Value::Num(reference.side));
    value.set("angle", Value::Num(reference.angle));
    value.set("axis", Value::Num(reference.axis));
    value.set("ratio", Value::Num(reference.ratio));
    if let Some(shape) = &reference.shape {
        value.set("shape", Value::nums(shape));
    }
    Value::object(value)
}
