//! An IK controller's settings as the inspector changes them (`getIKSettings`,
//! `setNodeIK` and `rotateIKTarget` in src/editor-ik.mjs).
//!
//! Switching a controller on (pinned where the limb is drawn) or off (the limb kept as
//! drawn), pinning and releasing it, stretching, its chain length and bend side, a 3D limb's
//! swivel, and turning a target. On joined figures the controllers act across the assembly
//! (`bakeGraph`, `captureFor` on the graph): the same settings run on its temporary skeleton,
//! baking and capturing every figure of the assembly.

use std::collections::BTreeMap;

use styk_doc::{Obj, Value};
use styk_eval::ik::{BendReference, Skeleton};

use crate::spatial_ik::{joined_quaternion_table, quaternion_table, spatial_target_value, Capture, CaptureSpec};
use crate::{EditError, Editor};

/// `MAX_IK_CHAIN`.
const MAX_CHAIN: u32 = 256;
const SETTINGS: [&str; 6] = ["enabled", "pinned", "allowStretch", "chainLength", "bendDirection", "swivel"];

fn truthy(value: &Value, key: &str) -> bool {
    value.get(key).is_some_and(Value::truthy)
}

/// A stored bend reference read back (as the IK table's reader does).
fn bend_reference(value: Option<&Value>) -> Option<BendReference> {
    let r = value?;
    let number = |key: &str| r.get(key).and_then(Value::as_f64).filter(|n| n.is_finite());
    Some(BendReference { side: number("side")?, angle: number("angle")?, axis: number("axis")?, ratio: number("ratio")?, shape: r.get("shape").and_then(Value::numbers) })
}

fn reference_value(reference: &BendReference) -> Value {
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

fn angle_table(angles: &BTreeMap<u32, f64>) -> Value {
    let mut table = Obj::new();
    for (handle, angle) in angles {
        table.set(&handle.to_string(), Value::Num(*angle));
    }
    Value::object(table)
}

/// What `capture` reads of a controller record.
fn spec_of(controller: &Obj) -> CaptureSpec {
    let value = Value::object(controller.clone());
    let number = |path: &[&str]| value.path(path).and_then(Value::as_f64);
    CaptureSpec {
        rotation: number(&["target", "rotation"]).unwrap_or(0.0),
        chain_length: number(&["chainLength"]).unwrap_or(2.0).max(0.0).min(u32::MAX as f64) as u32,
        bend_direction: value.get("bendDirection").filter(|v| !v.is_null()).map(|v| v.as_f64().unwrap_or(f64::NAN)),
        bend_reference: bend_reference(value.get("bendReference")),
        swivel: number(&["spatialTarget", "swivel"]).unwrap_or(0.0),
    }
}

fn flag(object: &Obj, key: &str) -> bool {
    object.get(key).is_some_and(Value::truthy)
}

/// The chain length a controller record holds, as the chain functions take it.
fn chain_of(settings: &Obj) -> u32 {
    settings.get("chainLength").and_then(Value::as_f64).map_or(0, |n| n.max(0.0).min(u32::MAX as f64) as u32)
}

/// `getIKSettings()` without `maxLength`: the controller's record over the defaults (`max`
/// is the longest chain from the node).
fn settings_with(at: &At, max: u32) -> Obj {
    let mut settings = Obj::new();
    settings.set("enabled", Value::Bool(false));
    settings.set("pinned", Value::Bool(false));
    settings.set("allowStretch", Value::Bool(false));
    settings.set("bendDirection", Value::Num(0.0));
    settings.set("chainLength", Value::Num(max.min(2) as f64));
    if let Some(controller) = at.controller.as_obj() {
        for (key, value) in controller.iter() {
            settings.set(key, value.clone());
        }
    }
    settings
}

/// `{...settings, ...patch}` checked as `setNodeIK` checks it: the names, the chain length
/// (1 to `max`), the switches and the bend side. A controller switched on without saying so
/// is pinned, where the limb is drawn, so nothing jumps. Returns the merged settings and the
/// chain length.
fn merged_patch(settings: &Obj, entries: &[(String, Value)], max: u32) -> Result<(Obj, u32), EditError> {
    let mut next = settings.clone();
    for (key, value) in entries {
        next.set(key, value.clone());
    }
    if entries.iter().any(|(k, _)| !SETTINGS.contains(&k.as_str())) {
        return Err(EditError::Invalid("errors.editorIk.unknownIkSetting".into()));
    }
    let chain_length = next.get("chainLength").and_then(Value::as_f64).filter(|n| n.fract() == 0.0 && *n >= 1.0 && *n <= max as f64);
    let Some(chain_length) = chain_length else { return Err(crate::invalid_with("errors.editorIk.chainLengthMustBeBetween1And", vec![("maxLength", Value::Num(max as f64))])) };
    let boolean = |key: &str| matches!(next.get(key), Some(Value::Bool(_)));
    let side = next.get("bendDirection").and_then(Value::as_f64);
    if !boolean("enabled") || !boolean("pinned") || !boolean("allowStretch") || !matches!(side, Some(s) if s == -1.0 || s == 0.0 || s == 1.0) {
        return Err(EditError::Invalid("errors.editorIk.invalidIkSetting".into()));
    }
    let given = |key: &str| entries.iter().find(|(k, _)| k == key).map(|(_, v)| v);
    if matches!(given("enabled"), Some(Value::Bool(true))) && !flag(settings, "enabled") && given("pinned").is_none() {
        next.set("pinned", Value::Bool(true));
    }
    Ok((next, chain_length as u32))
}

/// A 3D limb's swivel patch (`next.spatialTarget = {...settings.spatialTarget, swivel}`).
fn with_swivel(next: &mut Obj, settings: &Obj, swivel: &Value) -> Result<(), EditError> {
    let finite = swivel.as_f64().filter(|v| v.is_finite() && v.abs() <= 1e6);
    let (Some(swivel), Some(spatial)) = (finite, settings.get("spatialTarget").filter(|t| t.truthy())) else {
        return Err(EditError::Invalid("errors.editorIk.chooseAFiniteSpatialBendDirection".into()));
    };
    next.set("spatialTarget", crate::spatial_ik::merged(spatial, &[("swivel", Value::Num(swivel))]));
    next.remove("swivel");
    Ok(())
}

/// A longer or shorter chain keeps the target and bend side the controller had.
fn restore_target(next: &mut Obj, settings: &Obj) {
    next.set("target", settings.get("target").cloned().unwrap_or(Value::Null));
    next.set("bendDirection", settings.get("bendDirection").cloned().unwrap_or(Value::Null));
}

/// `Object.assign(next, captureFor(...))`: the limb as drawn, in the order `captureFor` builds
/// it. A joined limb carries the followers of the figures joined to it.
fn assign_capture(next: &mut Obj, capture: &Capture, rotation: f64) {
    if capture.joined_followers.is_none() {
        if let Some(followers) = &capture.spatial_followers {
            next.set("spatialFollowers", quaternion_table(followers));
        }
        if let Some(target) = &capture.spatial_target {
            next.set("spatialTarget", spatial_target_value(target));
        }
    }
    let mut target = Obj::new();
    target.set("x", Value::Num(capture.target[0]));
    target.set("y", Value::Num(capture.target[1]));
    target.set("rotation", Value::Num(rotation));
    next.set("target", Value::object(target));
    next.set("followers", angle_table(&capture.followers));
    if let Some(joined) = &capture.joined_followers {
        next.set("joinedFollowers", crate::ik::joined_table(joined));
        if let Some(followers) = &capture.spatial_followers {
            next.set("spatialFollowers", quaternion_table(followers));
        }
        if let Some(followers) = &capture.joined_spatial_followers {
            next.set("joinedSpatialFollowers", joined_quaternion_table(followers));
        }
    }
    next.set("bendDirection", Value::Num(capture.bend_direction));
    next.set("bendReference", reference_value(&capture.bend_reference));
}

/// Writes the controller `next` into the figure's record. A 3D limb keeps a disabled record
/// so its switch stays in the rig panel; any other disabled controller is removed.
fn store_controller(record: &mut Obj, key: &str, next: &Obj) {
    if !flag(next, "enabled") && next.get("spatialTarget").is_some_and(Value::truthy) {
        let mut off = next.clone();
        off.set("pinned", Value::Bool(false));
        crate::ik::set_controller_value(record, key, Value::object(off));
    } else if !flag(next, "enabled") {
        let mut table = record.get("_stykIK").and_then(Value::as_obj).cloned().unwrap_or_default();
        table.remove(key);
        if table.is_empty() {
            record.remove("_stykIK");
        } else {
            record.set("_stykIK", Value::object(table));
        }
    } else {
        crate::ik::set_controller_value(record, key, Value::object(next.clone()));
    }
    record.remove("runtime_segments");
}

/// `indices` and the bones below them, in the order a walk down the skeleton reaches them.
fn branches_below(skeleton: &Skeleton<'_>, mut indices: Vec<usize>) -> Vec<usize> {
    let mut visited: std::collections::HashSet<usize> = indices.iter().copied().collect();
    let mut q = 0;
    while q < indices.len() {
        for &child in skeleton.children(indices[q]) {
            if visited.insert(child as usize) {
                indices.push(child as usize);
            }
        }
        q += 1;
    }
    indices
}

/// `{handle, controller} = controllerAt(editor)` with the figure's definition.
struct At {
    slot: usize,
    handle: u32,
    object: Value,
    controller: Value,
}

impl Editor {
    fn controller_at(&self) -> Result<Option<At>, EditError> {
        let Some((slot, object)) = self.object()? else { return Ok(None) };
        let definition = self.figure_value(&object);
        let handle = (self.selection.joint >= 0).then(|| definition.get("segments").and_then(|s| s.item(self.selection.joint as usize))).flatten().and_then(|s| s.get("segment_id").and_then(Value::as_f64));
        let Some(handle) = handle else { return Ok(None) };
        let controller = object.path(&["_stykIK", &(handle as u32).to_string()]).cloned().unwrap_or(Value::Null);
        Ok(Some(At { slot, handle: handle as u32, object, controller }))
    }

    /// The figure of the frame on show in `slot`, as evaluation types it.
    fn typed_figure(&self, slot: usize) -> Result<(std::sync::Arc<styk_eval::doc::Figure>, std::sync::Arc<styk_eval::eval::Prepared>, styk_eval::eval::Frame, styk_eval::geometry::Scene), EditError> {
        let (prepared, frame, scene) = self.evaluate_only(Some(&[slot]))?;
        let object = frame.objects.get(slot).ok_or_else(|| EditError::Unported("configuring IK of a figure the engine does not draw".into()))?;
        let figure = object.figure_override.clone().or_else(|| prepared.doc.figure(object.figure).cloned()).ok_or_else(|| EditError::Unported("configuring IK of a figure without a definition".into()))?;
        Ok((figure, prepared, frame, scene))
    }

    /// `setNodeIK(patch)`.
    pub(crate) fn set_node_ik(&mut self, patch: &Value) -> Result<bool, EditError> {
        let entries: Vec<(String, Value)> = patch.as_obj().map(|o| o.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()).unwrap_or_default();
        let given = |key: &str| entries.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone());
        // A 3D limb's swivel alone goes through its pole (`setSpatialIKTarget`).
        if entries.len() == 1
            && let Some(swivel) = given("swivel")
            && self.spatial_ik_pole()?.is_some()
        {
            let mut patch = Obj::new();
            patch.set("swivel", swivel);
            return self.set_spatial_ik_target(&Value::object(patch));
        }
        let enabling = given("enabled").is_some_and(|v| v.truthy());
        if enabling && let Some((_, object)) = self.object()? {
            let definition = self.figure_value(&object);
            if !definition.is_null() {
                // `rigIKAllowed(figure, selectedJoint)`: a segment that is not a derived rig joint.
                let segment = (self.selection.joint >= 0).then(|| definition.get("segments").and_then(|s| s.item(self.selection.joint as usize))).flatten();
                let derived = |s: &Value| {
                    let rig = s.get("_stykRig");
                    let has = |key: &str| rig.and_then(|r| r.get(key)).is_some_and(Value::truthy);
                    let skin = rig.and_then(|r| r.get("spatial")).is_some_and(|sp| sp.get("point").is_some_and(Value::truthy) && sp.get("bindings").is_some());
                    skin || has("connector") || has("angleLock") || has("anglePath") || has("weighted")
                };
                if !segment.as_ref().is_some_and(|s| !derived(s)) {
                    return Err(EditError::Invalid("errors.editorIk.applyIkToTheDrivingBonesConnectorWeighted".into()));
                }
            }
        }
        let Some(at) = self.controller_at()? else { return Ok(false) };
        if self.in_assembly(at.slot)? {
            return self.set_joined_node_ik(at, &entries);
        }
        let (figure, prepared, frame, scene) = self.typed_figure(at.slot)?;
        let skeleton = Skeleton { segments: &figure.segments, plan: &figure.plan, polygons: &figure.polyfills, sources: None };
        let max = skeleton.chain(at.handle, MAX_CHAIN).len() as u32;
        let settings = settings_with(&at, max);
        let (mut next, chain_length) = merged_patch(&settings, &entries, max)?;
        if flag(&next, "enabled") {
            let chain: std::collections::HashSet<usize> = skeleton.chain(at.handle, chain_length).into_iter().collect();
            for (id, other) in at.object.get("_stykIK").and_then(Value::as_obj).map(|t| t.iter().map(|(k, v)| (k.to_string(), v.clone())).collect::<Vec<_>>()).unwrap_or_default() {
                let Ok(handle) = id.parse::<u32>() else { continue };
                let length = other.get("chainLength").and_then(Value::as_f64).filter(|n| !n.is_nan()).map_or(0, |n| n.max(0.0).min(u32::MAX as f64) as u32);
                if handle != at.handle && truthy(&other, "enabled") && skeleton.chain(handle, length).iter().any(|i| chain.contains(i)) {
                    return Err(EditError::Invalid("errors.editorIk.ikChainsCannotShareBonesShortenTheChain".into()));
                }
            }
        }
        if let Some(swivel) = given("swivel") {
            with_swivel(&mut next, &settings, &swivel)?;
        }
        // The followers a pinned limb is solved with. The tuple still represents the
        // unchanged pose read for its typed figure before validating this patch.
        let id = crate::record::uid(&at.object).unwrap_or(0);
        let solved_frame = crate::ik::solve_frame(&prepared, &frame, &scene);
        let solved = solved_frame.get(&id);
        if let Some(followers) = solved.and_then(|s| s.followers_of(at.handle)) {
            next.set("followers", angle_table(followers));
        }
        // What the edit captures, from the limb as drawn before it (`captureFor`).
        let pin = matches!(given("pinned"), Some(Value::Bool(true))) && !flag(&settings, "pinned");
        if !flag(&settings, "enabled") || pin || given("chainLength").is_some() {
            let spec = spec_of(&next);
            let capture = self.capture_from(at.slot, at.handle, &spec, &prepared, &frame, &scene, Some(&solved_frame))?;
            assign_capture(&mut next, &capture, spec.rotation);
        }
        if flag(&settings, "enabled") && given("chainLength").is_some() {
            restore_target(&mut next, &settings);
        }
        if let Some(direction) = given("bendDirection") {
            next.set("bendDirection", direction.clone());
            if direction.as_f64() == Some(0.0) {
                let capture = self.capture_from(at.slot, at.handle, &spec_of(&next), &prepared, &frame, &scene, Some(&solved_frame))?;
                next.set("bendReference", reference_value(&capture.bend_reference));
            }
        }
        let (slot, key) = (at.slot, at.handle.to_string());
        let rest: Vec<Value> = self.figure_value(&at.object).get("segments").and_then(Value::elements).map(|e| e.iter().map(|s| s.get("length").cloned().unwrap_or(Value::Null)).collect()).unwrap_or_default();
        let old_chain = skeleton.chain(at.handle, chain_of(&settings));
        let released = !flag(&next, "enabled") || !flag(&next, "pinned");
        self.object_edit_with("Configure IK", false, |editor| {
            let record = editor.frame_object_mut(slot).unwrap();
            // The limb keeps the pose it is drawn with (`_bakeIKFollowers`, `solvedAngles`).
            if let Some(solved) = solved {
                if record.get("angles").and_then(Value::array_len) != Some(solved.solution.angles.len()) {
                    return Err(EditError::Unported("configuring IK of a pose without one angle per segment".into()));
                }
                crate::ik::bake_object(record, solved);
                record.set("angles", Value::nums(&solved.solution.angles));
                // Releasing one controller must not change another limb's rest lengths.
                if let Some(lengths) = solved.solution.lengths.as_ref().filter(|_| released) {
                    let flagged = record.get("len_flag").is_some_and(Value::truthy);
                    let rest_of = |record: &Obj, i: usize| if flagged { record.get("lengths").and_then(|l| l.item(i)).unwrap_or(Value::Null) } else { rest.get(i).cloned().unwrap_or(Value::Null) };
                    if old_chain.iter().any(|&i| Some(lengths.get(i).copied().unwrap_or(f64::NAN)) != rest_of(record, i).as_f64()) {
                        let mut all: Vec<Value> = (0..rest.len()).map(|i| rest_of(record, i)).collect();
                        for &i in &old_chain {
                            if let Some(slot) = all.get_mut(i) {
                                *slot = Value::Num(lengths.get(i).copied().unwrap_or(f64::NAN));
                            }
                        }
                        record.set("len_flag", Value::Num(1.0));
                        record.set("lengths", Value::array(all));
                    }
                }
            }
            store_controller(editor.frame_object_mut(slot).unwrap(), &key, &next);
            Ok(())
        })
    }

    /// `setNodeIK(patch)` on joined figures: the controller acts across the assembly, so the
    /// displayed pose is baked into every figure of it, released rest lengths are kept along
    /// this controller's chain only, and what the edit captures is the limb across the assembly.
    fn set_joined_node_ik(&mut self, at: At, entries: &[(String, Value)]) -> Result<bool, EditError> {
        let unported = |what: &str| EditError::Unported(format!("configuring IK on a joined figure {what}"));
        let given = |key: &str| entries.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone());
        let (prepared, frame, scene) = self.evaluate()?;
        let assembly = crate::ik::assembly_of(&prepared, &frame, at.slot).ok_or_else(|| unported("outside an assembly"))?;
        let id = assembly.id(at.slot, at.handle).ok_or_else(|| unported("without a handle"))?;
        let max = assembly.chain(at.slot, at.handle, MAX_CHAIN).len() as u32;
        let settings = settings_with(&at, max);
        let (mut next, chain_length) = merged_patch(&settings, entries, max)?;
        if flag(&next, "enabled") {
            let chain = assembly.chain(at.slot, at.handle, chain_length);
            for (&other, controller) in &assembly.controllers.controllers {
                if other != id && controller.enabled && assembly.skeleton().chain(other, controller.chain_length).iter().any(|i| chain.contains(i)) {
                    return Err(EditError::Invalid("errors.editorIk.ikChainsCannotShareBonesShortenTheChain".into()));
                }
            }
        }
        if let Some(swivel) = given("swivel") {
            with_swivel(&mut next, &settings, &swivel)?;
        }
        let solved = crate::ik::solve_frame(&prepared, &frame, &scene);
        if let Some(s) = solved.get(&frame.objects[at.slot].uid) {
            if let Some(followers) = s.followers_of(at.handle) {
                next.set("followers", angle_table(followers));
            }
            if let Some(followers) = s.joined_followers_of(at.handle) {
                next.set("joinedFollowers", crate::ik::joined_table(followers));
            }
        }
        let pin = matches!(given("pinned"), Some(Value::Bool(true))) && !flag(&settings, "pinned");
        if !flag(&settings, "enabled") || pin || given("chainLength").is_some() {
            let spec = spec_of(&next);
            let capture = self.capture_joined(&prepared, &frame, &scene, &assembly, at.slot, at.handle, &spec)?;
            assign_capture(&mut next, &capture, spec.rotation);
        }
        if flag(&settings, "enabled") && given("chainLength").is_some() {
            restore_target(&mut next, &settings);
        }
        if let Some(direction) = given("bendDirection") {
            next.set("bendDirection", direction.clone());
            if direction.as_f64() == Some(0.0) {
                let capture = self.capture_joined(&prepared, &frame, &scene, &assembly, at.slot, at.handle, &spec_of(&next))?;
                next.set("bendReference", reference_value(&capture.bend_reference));
            }
        }
        // Releasing a controller keeps the rest lengths its limb is drawn with, along the chain it had.
        let released: Vec<_> = if !flag(&next, "enabled") || !flag(&next, "pinned") { assembly.chain(at.slot, at.handle, chain_of(&settings)).into_iter().map(|i| assembly.entry(i)).collect() } else { Vec::new() };
        let slots = assembly.slots.clone();
        let key = at.handle.to_string();
        self.object_edit_with("Configure IK", false, |editor| {
            editor.expand_drag(&slots);
            for &slot in &slots {
                let object = &frame.objects[slot];
                let record = editor.frame_object_mut(slot).ok_or_else(|| unported("outside the frame"))?;
                if let Some(s) = solved.get(&object.uid) {
                    crate::ik::bake_object(record, s);
                    record.set("angles", Value::nums(&s.solution.angles));
                    let indices: Vec<usize> = released.iter().filter(|entry| entry.slot == slot).map(|entry| entry.index).collect();
                    if let Some(lengths) = s.solution.lengths.as_ref().filter(|_| !indices.is_empty()) {
                        let definition = object.figure_override.as_ref().or_else(|| prepared.doc.figure(object.figure)).ok_or_else(|| unported("without a definition"))?;
                        let flagged = record.get("len_flag").is_some_and(Value::truthy);
                        let rest: Vec<f64> = definition.segments.iter().enumerate().map(|(i, s)| if flagged { record.get("lengths").and_then(|v| v.item(i)).and_then(|v| v.as_f64()).unwrap_or(f64::NAN) } else { s.length }).collect();
                        if indices.iter().any(|&i| lengths.get(i).copied().unwrap_or(f64::NAN) != rest[i]) {
                            let mut updated = rest;
                            for &i in &indices {
                                updated[i] = lengths.get(i).copied().unwrap_or(f64::NAN);
                            }
                            record.set("len_flag", Value::Num(1.0));
                            record.set("lengths", Value::nums(&updated));
                        }
                    }
                }
                record.remove("runtime_segments");
            }
            store_controller(editor.frame_object_mut(at.slot).ok_or_else(|| unported("outside the frame"))?, &key, &next);
            Ok(())
        })
    }

    /// `rotateIKTarget(radians)`: the target's rotation; a free limb first takes the pose it
    /// is drawn with and turns its outgoing branches by the change.
    pub(crate) fn rotate_ik_target(&mut self, radians: f64) -> Result<bool, EditError> {
        if !radians.is_finite() {
            return Err(EditError::Invalid("errors.editorIk.ikRotationMustBeFinite".into()));
        }
        let Some(at) = self.controller_at()? else { return Ok(false) };
        if !truthy(&at.controller, "enabled") {
            return Ok(false);
        }
        let free = !truthy(&at.controller, "pinned");
        // A free controller captures the limb as drawn before the edit (`captureFor`), and
        // its followers and everything below them turn.
        let (capture, branches) = if free {
            let spec = spec_of(&at.controller.as_obj().cloned().unwrap_or_default());
            let joined = if self.in_assembly(at.slot)? { self.joined_branches(&at, &spec)? } else { None };
            let (capture, branches) = match joined {
                Some(joined) => joined,
                None => {
                    let capture = self.capture_with(at.slot, at.handle, &spec)?;
                    let (figure, _, _, _) = self.typed_figure(at.slot)?;
                    let skeleton = Skeleton { segments: &figure.segments, plan: &figure.plan, polygons: &figure.polyfills, sources: None };
                    (capture, branches_below(&skeleton, skeleton.follower_indices(at.handle)).into_iter().map(|i| (at.slot, i)).collect())
                }
            };
            (Some(capture), branches)
        } else {
            (None, Vec::new())
        };
        let (slot, key, joint) = (at.slot, at.handle.to_string(), self.selection.joint.max(0) as usize);
        self.object_edit_with("Rotate IK target", true, |editor| {
            let record = editor.frame_object_mut(slot).unwrap();
            let current = record.get("_stykIK").and_then(|t| t.get(&key)).cloned().unwrap_or(Value::Null);
            let mut next = current.as_obj().cloned().unwrap_or_default();
            let mut target = current.get("target").and_then(Value::as_obj).cloned().unwrap_or_default();
            target.set("rotation", Value::Num(radians));
            next.set("target", Value::object(target.clone()));
            if let Some(capture) = &capture {
                assign_capture(&mut next, capture, radians);
                next.set("target", Value::object(target));
                let previous = current.path(&["target", "rotation"]).and_then(Value::as_f64).unwrap_or(f64::NAN);
                editor.apply_joint_rotation(slot, joint, &branches, radians - previous, true)?;
            }
            let record = editor.frame_object_mut(slot).unwrap();
            crate::ik::set_controller_value(record, &key, Value::object(next));
            record.remove("runtime_segments");
            Ok(())
        })
    }

    /// `captureFor` of a free controller on joined figures, and the bones of the assembly its
    /// target turns: its followers and everything below them. `None` when the figure is not
    /// part of an assembly that compiles.
    fn joined_branches(&self, at: &At, spec: &CaptureSpec) -> Result<Option<(Capture, Vec<(usize, usize)>)>, EditError> {
        let (prepared, frame, scene) = self.evaluate()?;
        let Some(assembly) = crate::ik::assembly_of(&prepared, &frame, at.slot) else { return Ok(None) };
        let capture = self.capture_joined(&prepared, &frame, &scene, &assembly, at.slot, at.handle, spec)?;
        let id = assembly.id(at.slot, at.handle).ok_or_else(|| EditError::Unported("turning an IK target of a joined handle outside its assembly".into()))?;
        let skeleton = assembly.skeleton();
        let branches = branches_below(&skeleton, skeleton.follower_indices(id)).into_iter().map(|i| { let entry = assembly.entry(i); (entry.slot, entry.index) }).collect();
        Ok(Some((capture, branches)))
    }

    /// `setSpatialFeetPinned(pinned)`: every foot or ankle of the selected 3D figure with a
    /// controller is planted or released, in one gesture.
    pub(crate) fn set_spatial_feet_pinned(&mut self, pinned: &Value) -> Result<bool, EditError> {
        let Some((_, object)) = self.object()? else { return Ok(false) };
        let definition = self.figure_value(&object);
        let segments: Vec<Value> = definition.get("segments").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
        if definition.is_null() {
            return Ok(false);
        }
        let id = |s: &Value| s.get("segment_id").and_then(Value::as_f64);
        let foot = |s: &Value| s.get("name").and_then(Value::as_str).is_some_and(|name| { let name = name.to_lowercase(); name.contains("foot") || name.contains("ankle") });
        let bone_of = |child: &Value, parent: f64| child.path(&["_stykRig", "spatial", "origin"]).is_some_and(Value::truthy) && child.path(&["_stykRig", "spatial", "parent"]).and_then(Value::as_f64) == Some(parent);
        let targets: Vec<usize> = segments
            .iter()
            .enumerate()
            .filter(|(_, s)| id(s).is_some_and(|handle| object.path(&["_stykIK", &(handle as u32).to_string(), "enabled"]).is_some_and(Value::truthy) && segments.iter().any(|child| bone_of(child, handle) && foot(child))))
            .map(|(i, _)| i)
            .collect();
        if targets.is_empty() {
            return Ok(false);
        }
        let selected = self.selection.joint;
        if !self.begin_drag(if pinned.truthy() { "Plant feet" } else { "Release feet" }, false)? {
            return Ok(false);
        }
        let mut patch = Obj::new();
        patch.set("pinned", pinned.clone());
        let patch = Value::object(patch);
        let mut result = Ok(());
        for i in targets {
            self.selection.joint = i as i64;
            if let Err(error) = self.set_node_ik(&patch) {
                result = Err(error);
                break;
            }
        }
        self.selection.joint = selected;
        match result {
            Ok(()) => {
                self.commit_drag()?;
                Ok(true)
            }
            Err(error) => {
                self.cancel_drag()?;
                Err(error)
            }
        }
    }
}
