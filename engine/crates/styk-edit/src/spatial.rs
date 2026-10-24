//! 3D bones as editing sees them (src/editor-spatial.mjs).
//!
//! Ported: a bone's pose read from the angles it is drawn with (`getSpatialPose`), turning
//! it (`setSpatialPose`, and `rotateJoint` on a bone), the travel of mechanical slides and
//! hinges (`getSpatialMotion`, `setSpatialMotion`), and the canvas drags: a bone turned
//! flat on screen or swung in depth (`poseSpatialJoint`, `_flatSpatialJoint`,
//! `_arcSpatialJoint`), twisted about its axis (`twistSpatialJoint`), a mechanism moved
//! along its track (`_moveMechanicalJoint`); with 3D IK, a planted knee steering its limb's
//! bend plane, a twist swinging a planted limb's swivel or turning its foot or hand, a whole
//! figure turned with its targets, and `resetSpatialPose`. Pose choices are in
//! `pose_choice.rs`.

use std::{collections::HashMap, sync::Arc};

use styk_eval::{eval::{Frame, Prepared}, geometry::Scene};

use styk_doc::{Obj, Value};
use styk_eval::doc::Figure;
use styk_eval::ik::spatial::{between_vectors, inverse_quaternion, quaternion_pose, spatial_world_quaternion, spatial_world_vector, Euler};
use styk_eval::rig::{quat_multiply, quat_rotate, spatial_point, spatial_quaternion, Motion, Spatial, SpatialFrame};
use styk_eval::spatial::Camera;
use styk_math::{atan2, cos, hypot, norm, sin};

use crate::record::uid;
use crate::{EditError, Editor};

/// The bone at a segment of a figure, as its rig relationship describes it.
pub(crate) struct Bone<'a> {
    pub parent: u32,
    pub turn: u32,
    pub pitch: u32,
    pub origin: [f64; 3],
    pub tip: [f64; 3],
    pub motion: Option<&'a Motion>,
}

pub(crate) fn bone(figure: &Figure, index: usize) -> Option<Bone<'_>> {
    match figure.segments.get(index)?.rig.as_ref()?.spatial.as_ref()? {
        Spatial::Bone { parent, turn, pitch, origin, tip, motion } => Some(Bone { parent: *parent, turn: *turn, pitch: *pitch, origin: *origin, tip: *tip, motion: motion.as_ref() }),
        Spatial::Skin { .. } => None,
    }
}

/// What the selected figure's 3D bones are read from: its record, its definition, the
/// frames geometry gave its bones, and the angles it is drawn with.
pub(crate) struct Context {
    pub slot: usize,
    pub object: Value,
    pub figure: Arc<Figure>,
    pub frames: Vec<Option<SpatialFrame>>,
    /// `geometry…solvedAngles ?? object.angles`.
    pub angles: Vec<f64>,
    /// `animationRotation(figure, object)`.
    pub figure_angle: f64,
    pub mirror: bool,
    pub root: [f64; 2],
    pub scale: f64,
    /// The pose's perspective (`projection(object, root)`).
    pub camera: Option<Camera>,
    /// `unprojectJoint(shape.start)` per segment: the start before perspective.
    pub starts: Vec<[f64; 2]>,
    /// Each segment's handle as drawn, and before perspective.
    pub ends: Vec<[f64; 2]>,
    pub raws: Vec<Option<[f64; 3]>>,
    /// The pose's part proportions.
    pub shape: Option<std::collections::BTreeMap<u32, styk_eval::doc::SpatialShape>>,
}

/// A 3D bone drag from its fixed start (`_spatialGesture(kind)`), or a mechanism's track.
#[derive(Clone, Debug)]
pub(crate) enum Gesture {
    Bone(BoneGesture),
    Mechanism(MechanismGesture),
    /// `flat-ik:`: a 3D limb's flat pole (`crate::spatial_ik`).
    FlatIk(crate::spatial_ik::FlatPole),
    /// `depth:`: a depth push, from the pointer's height and the target's depth at its start.
    Depth { y: f64, depth: f64 },
}

#[derive(Clone, Debug)]
pub(crate) struct BoneGesture {
    origin: [f64; 3],
    tip: [f64; 3],
    length: f64,
    direction: [f64; 3],
    side: f64,
    world: [f64; 4],
    parent: [f64; 4],
    /// Set by the first sample: the twist's pointer, the flat drag's grab and the bone's
    /// length then, the arc's pointer.
    start: Option<[f64; 2]>,
    grab: Option<[f64; 2]>,
    native_length: Option<f64>,
    pointer: Option<[f64; 2]>,
    /// A twist of a planted 3D limb: the swivel it started from.
    swivel: Option<f64>,
}

#[derive(Clone, Debug)]
pub(crate) struct MechanismGesture {
    slide: bool,
    tip: [f64; 3],
    pivot: [f64; 3],
    axis: [f64; 3],
    value: f64,
    start: [f64; 3],
    grab: [f64; 2],
    figure_angle: f64,
    mirror: bool,
    scale: f64,
    root: [f64; 2],
}

impl MechanismGesture {
    /// `along(p)`: where the moving end is at travel `p`, in the scene.
    fn along(&self, p: f64) -> [f64; 3] {
        let d = p - self.value;
        let local = if self.slide {
            [self.tip[0] + self.axis[0] * d, self.tip[1] + self.axis[1] * d, self.tip[2] + self.axis[2] * d]
        } else {
            let turned = quat_rotate(axis_quaternion(self.axis, d), [self.tip[0] - self.pivot[0], self.tip[1] - self.pivot[1], self.tip[2] - self.pivot[2]]);
            [turned[0] + self.pivot[0], turned[1] + self.pivot[1], turned[2] + self.pivot[2]]
        };
        world_point(local, self.figure_angle, self.mirror, self.scale, self.root)
    }
}

/// `spatialAxisQuaternion(axis, angle)`.
fn axis_quaternion(axis: [f64; 3], angle: f64) -> [f64; 4] {
    let h = sin(angle / 2.0) / norm(&axis);
    [axis[0] * h, axis[1] * h, axis[2] * h, cos(angle / 2.0)]
}

/// The `world(p)` of the gestures: a figure-space point in the scene, before perspective.
fn world_point(p: [f64; 3], figure_angle: f64, mirror: bool, scale: f64, root: [f64; 2]) -> [f64; 3] {
    let v = spatial_world_vector(p, figure_angle, mirror, false);
    let v = [v[0] * scale, v[1] * scale, v[2] * scale];
    [v[0] + root[0], v[1] + root[1], v[2]]
}

/// `Math.sign` for the values it sees here.
fn sign(v: f64) -> f64 {
    if v > 0.0 {
        1.0
    } else if v < 0.0 {
        -1.0
    } else {
        v
    }
}

/// The state of a mechanical joint (`getSpatialMotion`).
pub(crate) struct MotionState {
    pub hinge: bool,
    pub min: f64,
    pub max: f64,
    pub value: f64,
}

/// `Math.min(a, b)` / `Math.max(a, b)` for the values clamps see (NaN wins, as there).
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.min(b) }
}
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.max(b) }
}

fn number_at(value: &Value, key: &str, index: usize) -> f64 {
    value.get(key).and_then(|v| v.item(index)).and_then(|v| v.as_f64()).unwrap_or(f64::NAN)
}

impl Editor {
    /// `validateSpatialJoins`: perspective belongs to a single spatial figure,
    /// except for a drawing attached to a spatial bone. Inspect authored records;
    /// validation must happen before attachment geometry is evaluated or published.
    pub(crate) fn validate_spatial_joins(&self) -> Result<(), EditError> {
        let objects = self.frame_objects();
        for object in &objects {
            let Some(join) = object.get("join").filter(|join| join.truthy()) else { continue };
            let strength = |value: &Value| value.path(&["_stykSpatial", "camera", "strength"]).is_some_and(Value::truthy);
            let parent = join.get("target_object_slot").and_then(Value::as_f64).and_then(|slot| objects.get(slot as usize));
            let projected_drawing = parent.is_some_and(|parent| {
                let figure = self.figure_value(object);
                let drawing = figure.path(&["_styk", "movieclip"]).is_some_and(|asset| asset.get("drawingRotation").is_some_and(Value::truthy) || asset.get("spatialMeshes").is_some_and(Value::truthy));
                drawing && self.figure_value(parent).get("segments").and_then(Value::elements).is_some_and(|segments| {
                    segments.iter().any(|segment| segment.get("segment_id") == join.get("target_handle_id") && segment.path(&["_stykRig", "spatial", "origin"]).is_some_and(Value::truthy))
                })
            });
            if strength(object) || parent.is_some_and(strength) && !projected_drawing {
                return Err(EditError::Invalid("errors.spatialProjection.perspectiveRequiresASingleSpatialFigureOrA".into()));
            }
        }
        Ok(())
    }

    /// The selected figure's 3D context, when it is posed here.
    pub(crate) fn spatial_context(&self) -> Result<Option<Context>, EditError> {
        let Some((slot, _)) = self.object()? else { return Ok(None) };
        self.spatial_context_at(slot)
    }

    /// The 3D context of the figure in `slot` of the frame on show (the gesture's draft
    /// during one).
    pub(crate) fn spatial_context_at(&self, slot: usize) -> Result<Option<Context>, EditError> {
        self.spatial_context_at_with(slot, None)
    }

    /// Optionally keep this call's immutable pose and full solved map. The context's
    /// original slot/UID/figure guards run before solving or installing that tuple.
    pub(crate) fn spatial_context_at_with(&self, slot: usize, mut evaluation: Option<&mut Option<(Arc<Prepared>, Frame, Scene, HashMap<u32, crate::ik::Solved>)>>) -> Result<Option<Context>, EditError> {
        if let Some(output) = evaluation.as_mut() { **output = None; }
        let Some(object) = self.selection_frame()?.get(slot).cloned() else { return Ok(None) };
        let Some(id) = uid(&object) else { return Ok(None) };
        // Only the active unpinned caller retains this tuple. Its context, capture
        // and full solve read all joints; render output keeps the shape owner's
        // existing rich-figure/ancestor fallback. Default callers stay unchanged.
        let (prepared, frame, scene) = if evaluation.is_some() {
            self.evaluate_for_shape(Some(&[slot]))?
        } else {
            self.evaluate_only(Some(&[slot]))?
        };
        let mut kept_solved = evaluation.as_ref().map(|_| HashMap::new());
        let context = Self::spatial_context_of(slot, object, id, &prepared, &frame, &scene, None, kept_solved.as_mut());
        if context.is_some() && let Some(output) = evaluation {
            *output = Some((prepared, frame, scene, kept_solved.unwrap()));
        }
        Ok(context)
    }

    /// Borrow this call's evaluated pose, but read the selection record just as the wrapper does.
    pub(crate) fn spatial_context_from(&self, slot: usize, prepared: &Prepared, frame: &Frame, scene: &Scene, solved: &HashMap<u32, crate::ik::Solved>) -> Result<Option<Context>, EditError> {
        let Some(object) = self.selection_frame()?.get(slot).cloned() else { return Ok(None) };
        let Some(id) = uid(&object) else { return Ok(None) };
        Ok(Self::spatial_context_of(slot, object, id, prepared, frame, scene, Some(solved), None))
    }

    fn spatial_context_of(slot: usize, object: Value, id: u32, prepared: &Prepared, frame: &Frame, scene: &Scene, solved: Option<&HashMap<u32, crate::ik::Solved>>, keep_solved: Option<&mut HashMap<u32, crate::ik::Solved>>) -> Option<Context> {
        let at = frame.objects.iter().position(|o| o.uid == id)?;
        let evaluated = &frame.objects[at];
        let figure = evaluated.figure_override.clone().or_else(|| prepared.doc.figure(evaluated.figure).cloned())?;
        let geometry = scene.objects.iter().find(|g| g.uid == id && g.resolved);
        let frames = geometry.and_then(|g| g.spatial.as_ref()).map(|s| s.frames.clone()).unwrap_or_default();
        let root = geometry.map_or(evaluated.root, |g| g.root);
        // The start of each segment before perspective (its parent joint's raw point).
        let starts = (0..figure.segments.len())
            .map(|i| {
                let drawn = geometry.and_then(|g| g.starts.get(i).copied()).unwrap_or([f64::NAN; 2]);
                let parent = figure.plan.parent.get(i).copied().filter(|&p| p != u32::MAX);
                let raw = parent.and_then(|p| geometry.and_then(|g| g.spatial.as_ref()).and_then(|s| s.depths.get(p as usize)).and_then(|d| d.raw));
                raw.map_or(drawn, |r| [r[0], r[1]])
            })
            .collect();
        let camera = Camera::of(evaluated, root);
        let scale = evaluated.scale;
        let ends = geometry.map(|g| g.ends.clone()).unwrap_or_default();
        let raws = (0..figure.segments.len()).map(|i| geometry.and_then(|g| g.spatial.as_ref()).and_then(|s| s.depths.get(i)).and_then(|d| d.raw)).collect();
        let shape = evaluated.spatial.as_ref().and_then(|s| s.shape.clone());
        let angles = match solved {
            Some(solved) => solved.get(&id).map(|s| s.solution.angles.clone()),
            None => {
                let mut solved = crate::ik::solve_frame(prepared, frame, scene);
                if let Some(output) = keep_solved {
                    let angles = solved.get(&id).map(|s| s.solution.angles.clone());
                    *output = solved;
                    angles
                } else {
                    solved.remove(&id).map(|s| s.solution.angles)
                }
            },
        };
        let angles = angles.unwrap_or_else(|| (0..figure.segments.len().max(object.get("angles").and_then(Value::array_len).unwrap_or(0))).map(|i| number_at(&object, "angles", i)).collect());
        Some(Context {
            slot,
            figure_angle: styk_eval::ik::figure_angle(&figure, evaluated),
            mirror: object.get("image_text_flags").is_some_and(Value::truthy),
            object,
            figure,
            frames,
            angles,
            root,
            scale,
            camera,
            starts,
            ends,
            raws,
            shape,
        })
    }

    /// `getSpatialPose(index)`: the bone's bend, turn and pitch as the figure is drawn.
    pub(crate) fn spatial_pose(context: &Context, index: usize) -> Option<Euler> {
        let figure = &context.figure;
        let bone = bone(figure, index)?;
        let find = |id: u32| figure.segments.iter().position(|s| s.id == id);
        let delta = context.figure_angle;
        let sign = if context.mirror { -1.0 } else { 1.0 };
        let angle = |i: usize| context.angles.get(i).copied().unwrap_or(f64::NAN);
        let parent_angle = find(bone.parent).map_or(0.0, |p| (angle(p) - delta) * sign - figure.segments[p].angle);
        let bend = (angle(index) - delta) * sign - figure.segments[index].angle - parent_angle;
        if let Some(motion) = bone.motion {
            return Some(Euler { bend: if motion.hinge { atan2(sin(bend), cos(bend)) } else { 0.0 }, turn: 0.0, pitch: 0.0 });
        }
        let channel = |id: u32| find(id).map_or(f64::NAN, |i| (angle(i) - delta) * sign - figure.segments[i].angle);
        Some(Euler { bend, turn: channel(bone.turn), pitch: channel(bone.pitch) })
    }

    /// `getSpatialMotion(index)`.
    pub(crate) fn spatial_motion(context: &Context, index: usize) -> Option<MotionState> {
        let bone = bone(&context.figure, index)?;
        let motion = bone.motion?;
        let index_of = |id: u32| context.figure.plan.index_of.get(&id).map(|&i| i as usize);
        let driver = motion.driver.map_or(0.0, |(joint, multiplier)| {
            index_of(joint).and_then(|i| context.frames.get(i).copied().flatten()).map_or(0.0, |frame| frame.motion_value) * multiplier
        });
        let length = if context.object.get("len_flag").is_some_and(Value::truthy) { number_at(&context.object, "lengths", index) } else { context.figure.segments[index].length };
        let bend = if motion.hinge { Self::spatial_pose(context, index).map_or(f64::NAN, |p| p.bend) } else { 0.0 };
        // `spatialMotionValue(spatial, {length, bend, driver})`
        let raw = if motion.hinge { atan2(sin(bend), cos(bend)) } else { length - norm(&[bone.tip[0] - bone.origin[0], bone.tip[1] - bone.origin[1], bone.tip[2] - bone.origin[2]]) };
        let applied = js_min(motion.max, js_max(motion.min, raw + driver));
        Some(MotionState { hinge: motion.hinge, min: motion.min - driver, max: motion.max - driver, value: applied - driver })
    }

    /// `rotateJoint(delta)` on a 3D bone (without `isolate`): `setSpatialPose` with the bend turned.
    pub(crate) fn rotate_spatial_joint(&mut self, delta: f64) -> Result<Option<bool>, EditError> {
        let Some(context) = self.spatial_context()? else { return Ok(None) };
        let joint = self.selection.joint;
        if joint < 0 {
            return Ok(None);
        }
        let Some(pose) = Self::spatial_pose(&context, joint as usize) else { return Ok(None) };
        let sign = if context.mirror { -1.0 } else { 1.0 };
        let mut patch = Obj::new();
        patch.set("bend", Value::Num(pose.bend + delta * sign));
        self.set_spatial_pose(&Value::object(patch), &Value::Null).map(Some)
    }

    /// `setSpatialPose(patch, {wholeFigure})`.
    pub(crate) fn set_spatial_pose(&mut self, patch: &Value, options: &Value) -> Result<bool, EditError> {
        let Some(context) = self.spatial_context()? else { return Ok(false) };
        if self.selection.joint < 0 {
            return Ok(false);
        }
        let index = self.selection.joint as usize;
        let Some(before) = Self::spatial_pose(&context, index) else { return Ok(false) };
        let entries: Vec<(String, f64)> = patch.as_obj().map(|o| o.iter().map(|(k, v)| (k.to_string(), v.as_f64().unwrap_or(f64::NAN))).collect()).unwrap_or_default();
        if entries.iter().any(|(k, v)| !["bend", "turn", "pitch"].contains(&k.as_str()) || !v.is_finite() || v.abs() > 1e6) {
            return Err(EditError::Invalid("errors.editorSpatial.chooseAFiniteJointRotation".into()));
        }
        let get = |key: &str| entries.iter().find(|(k, _)| k == key).map(|(_, v)| *v);
        // A hinge takes only its own rotation; a slide does not rotate.
        if let Some(motion) = Self::spatial_motion(&context, index) {
            return match (motion.hinge, get("bend")) {
                (true, Some(bend)) => self.set_spatial_motion(bend, false),
                _ => Ok(false),
            };
        }
        let previous = |key: &str| match key {
            "bend" => before.bend,
            "turn" => before.turn,
            _ => before.pitch,
        };
        if entries.iter().all(|(k, v)| (v - previous(k)).abs() < 1e-12) {
            return Ok(false);
        }
        let bone = bone(&context.figure, index).unwrap();
        let Some(frame) = context.frames.get(index).copied().flatten() else {
            return Err(EditError::Unported("turning a 3D bone geometry did not frame".into()));
        };
        let parent = quat_multiply(frame.q, inverse_quaternion(spatial_quaternion(before.bend, before.turn, before.pitch)));
        let next = Euler { bend: get("bend").unwrap_or(before.bend), turn: get("turn").unwrap_or(before.turn), pitch: get("pitch").unwrap_or(before.pitch) };
        let world = spatial_world_quaternion(quat_multiply(parent, spatial_quaternion(next.bend, next.turn, next.pitch)), context.figure_angle, context.mirror, false);
        let whole = options.get("wholeFigure").is_some_and(Value::truthy);
        if whole && bone.parent != 0 {
            return Err(EditError::Invalid("errors.editorSpatial.selectTheRootArticulationToRotateTheWhole".into()));
        }
        let handle = context.figure.segments[index].id;
        let index_of = |id: u32| context.figure.plan.index_of.get(&id).map(|&i| i as usize);
        let channels = [("turn", index_of(bone.turn)), ("pitch", index_of(bone.pitch))];
        let slot = context.slot;
        // `wholeFigure` rewrites the controllers from the table the figure had before the
        // edit: the 3D targets, their bend planes and planted orientations turn with the
        // figure about its root, as one rigid transform; the others stay as they were.
        let controllers = if whole {
            let delta = quat_multiply(world, inverse_quaternion(spatial_world_quaternion(frame.q, context.figure_angle, context.mirror, false)));
            let center = context.world(spatial_point(&frame, bone.origin));
            context.object.get("_stykIK").filter(|t| t.truthy()).map(|table| turn_spatial_targets(table, delta, center))
        } else {
            None
        };
        let figure = context.figure.clone();
        self.object_edit_with("Rotate articulated joint", true, |editor| {
            crate::ik::release_spatial_chain(editor.frame_object_mut(slot).unwrap(), &figure, index);
            let sign = if editor.frame_objects()[slot].get("image_text_flags").is_some_and(Value::truthy) { -1.0 } else { 1.0 };
            if let Some(bend) = get("bend") {
                editor.rotate_joint_by(slot, index, (bend - before.bend) * sign, true, false)?;
            }
            let record = editor.frame_object_mut(slot).unwrap();
            for (key, at) in channels {
                if let (Some(value), Some(at)) = (get(key), at) {
                    crate::pose::add_angle_at(record, at, (value - previous(key)) * sign);
                }
            }
            plant_spatial_follower(record, handle, world);
            if let Some(table) = &controllers {
                record.set("_stykIK", table.clone());
            }
            Ok(())
        })
    }

    /// `resetSpatialPose(all)`: the selected bone back to rest (a mechanism to its rest travel),
    /// or with `all` every 3D bone and slide of the figure, its 3D targets released.
    pub(crate) fn reset_spatial_pose(&mut self, all: bool) -> Result<bool, EditError> {
        if !all {
            let Some(context) = self.spatial_context()? else { return Ok(false) };
            if self.selection.joint >= 0 && Self::spatial_motion(&context, self.selection.joint as usize).is_some() {
                return self.set_spatial_motion(0.0, false);
            }
            let mut rest = Obj::new();
            for key in ["bend", "turn", "pitch"] {
                rest.set(key, Value::Num(0.0));
            }
            return self.set_spatial_pose(&Value::object(rest), &Value::Null);
        }
        let Some(context) = self.spatial_context()? else {
            return Err(EditError::Unported("resetting the 3D pose of a flat figure".into()));
        };
        let figure = context.figure.clone();
        let definition = self.figure_value(&context.object);
        let lengths: Vec<Value> = definition.get("segments").and_then(Value::elements).map(|e| e.iter().map(|s| s.get("length").cloned().unwrap_or(Value::Null)).collect()).unwrap_or_default();
        let slot = context.slot;
        self.object_edit_with("Reset articulated rig", true, |editor| {
            let record = editor.frame_object_mut(slot).unwrap();
            let delta = number_at(&Value::object(record.clone()), "angles", 0) - figure.segments.first().map_or(0.0, |s| s.angle);
            let sign = if record.get("image_text_flags").is_some_and(Value::truthy) { -1.0 } else { 1.0 };
            let index_of = |id: u32| figure.plan.index_of.get(&id).map(|&i| i as usize);
            for (i, _) in figure.segments.iter().enumerate() {
                let Some(b) = bone(&figure, i) else { continue };
                for at in [Some(i), index_of(b.turn), index_of(b.pitch)].into_iter().flatten() {
                    crate::pose::set_item_at(record, "angles", at, figure.segments[at].angle * sign + delta);
                }
            }
            // Slides return to their rest position (or the nearest end of their range).
            let slides: Vec<usize> = (0..figure.segments.len()).filter(|&i| bone(&figure, i).and_then(|b| b.motion).is_some_and(|m| !m.hinge)).collect();
            if !slides.is_empty() {
                if !record.get("len_flag").is_some_and(Value::truthy) {
                    record.set("lengths", Value::array(lengths.clone()));
                }
                record.set("len_flag", Value::Num(1.0));
                for i in slides {
                    let b = bone(&figure, i).unwrap();
                    let motion = b.motion.unwrap();
                    let rest = norm(&[b.tip[0] - b.origin[0], b.tip[1] - b.origin[1], b.tip[2] - b.origin[2]]);
                    crate::pose::set_item_at(record, "lengths", i, rest + js_min(motion.max, js_max(motion.min, 0.0)));
                }
            }
            // Targets release when the animator restores the rest pose.
            if let Some(table) = record.get("_stykIK").filter(|t| t.truthy()).and_then(|t| t.as_obj().cloned()) {
                let mut released = Obj::new();
                for (id, c) in table.iter() {
                    let mut next = c.as_obj().cloned().unwrap_or_default();
                    next.set("pinned", Value::Bool(false));
                    released.set(id, Value::object(next));
                }
                record.set("_stykIK", Value::object(released));
            }
            Ok(())
        })
    }

    /// `setSpatialMotion(value, {fraction})`: a mechanical joint's travel, clamped to its range.
    pub(crate) fn set_spatial_motion(&mut self, value: f64, fraction: bool) -> Result<bool, EditError> {
        let Some(context) = self.spatial_context()? else { return Ok(false) };
        if self.selection.joint < 0 {
            return Ok(false);
        }
        let index = self.selection.joint as usize;
        let Some(motion) = Self::spatial_motion(&context, index) else { return Ok(false) };
        if !value.is_finite() {
            return Err(EditError::Invalid("errors.editorSpatial.chooseAFinitePosition".into()));
        }
        let target = js_min(motion.max, js_max(motion.min, if fraction { motion.min + value * (motion.max - motion.min) } else { value }));
        let bone = bone(&context.figure, index).unwrap();
        let rest = norm(&[bone.tip[0] - bone.origin[0], bone.tip[1] - bone.origin[1], bone.tip[2] - bone.origin[2]]);
        let length_flag = context.object.get("len_flag").is_some_and(Value::truthy);
        let current = if motion.hinge {
            Self::spatial_pose(&context, index).map_or(f64::NAN, |p| p.bend)
        } else if length_flag {
            number_at(&context.object, "lengths", index)
        } else {
            context.figure.segments[index].length
        };
        let next = if motion.hinge { target } else { rest + target };
        if (next - current).abs() < 1e-12 {
            return Ok(false);
        }
        let slot = context.slot;
        let lengths: Vec<Value> = context.figure.segments.iter().map(|s| Value::Num(s.length)).collect();
        self.object_edit_with(if motion.hinge { "Turn hinge" } else { "Slide mechanical joint" }, true, |editor| {
            if motion.hinge {
                let sign = if editor.frame_objects()[slot].get("image_text_flags").is_some_and(Value::truthy) { -1.0 } else { 1.0 };
                editor.rotate_joint_by(slot, index, (next - current) * sign, true, false)?;
            }
            let record = editor.frame_object_mut(slot).unwrap();
            if !motion.hinge {
                if !record.get("len_flag").is_some_and(Value::truthy) {
                    record.set("lengths", Value::array(lengths.clone()));
                }
                record.set("len_flag", Value::Num(1.0));
                crate::pose::set_item_at(record, "lengths", index, next);
            }
            record.remove("runtime_segments");
            Ok(())
        })
    }
}

/// The controllers of a figure turned by `delta` about `center` (`setSpatialPose` with
/// `wholeFigure`).
fn turn_spatial_targets(table: &Value, delta: [f64; 4], center: [f64; 3]) -> Value {
    let Some(entries) = table.as_obj() else { return table.clone() };
    let mut turned = Obj::new();
    for (id, c) in entries.iter() {
        if !c.get("spatialTarget").is_some_and(Value::truthy) {
            turned.set(id, c.clone());
            continue;
        }
        let number = |path: &[&str]| c.path(path).and_then(Value::as_f64).unwrap_or(f64::NAN);
        let p = quat_rotate(delta, [number(&["target", "x"]) - center[0], number(&["target", "y"]) - center[1], number(&["spatialTarget", "depth"]) - center[2]]);
        let rotation = number(&["target", "rotation"]);
        let rotate = |q: [f64; 4]| quat_multiply(spatial_quaternion(-rotation, 0.0, 0.0), quat_multiply(delta, quat_multiply(spatial_quaternion(rotation, 0.0, 0.0), q)));
        let mut next = c.as_obj().cloned().unwrap_or_default();
        let mut target = c.get("target").and_then(Value::as_obj).cloned().unwrap_or_default();
        target.set("x", Value::Num(center[0] + p[0]));
        target.set("y", Value::Num(center[1] + p[1]));
        next.set("target", Value::object(target));
        let mut spatial = c.get("spatialTarget").and_then(Value::as_obj).cloned().unwrap_or_default();
        spatial.set("depth", Value::Num(center[2] + p[2]));
        let pole = c.path(&["spatialTarget", "pole"]).and_then(Value::numbers).unwrap_or_default();
        let pole = [0, 1, 2].map(|i| pole.get(i).copied().unwrap_or(f64::NAN));
        spatial.set("pole", Value::nums(&quat_rotate(delta, pole)));
        next.set("spatialTarget", Value::object(spatial));
        if let Some(followers) = c.get("spatialFollowers").filter(|f| f.truthy()).and_then(|f| f.as_obj().cloned()) {
            let mut rotated = Obj::new();
            for (handle, q) in followers.iter() {
                let q = q.numbers().unwrap_or_default();
                rotated.set(handle, Value::nums(&rotate([0, 1, 2, 3].map(|i| q.get(i).copied().unwrap_or(f64::NAN)))));
            }
            next.set("spatialFollowers", Value::object(rotated));
        }
        turned.set(id, Value::object(next));
    }
    Value::object(turned)
}

/// `_plantSpatialFollower(object, handle, world)`: a pinned hand or foot keeps the world
/// orientation it is given.
fn plant_spatial_follower(record: &mut Obj, handle: u32, world: [f64; 4]) {
    let Some(table) = record.get("_stykIK").and_then(Value::as_obj).cloned() else { return };
    let key = handle.to_string();
    let mut changed = table.clone();
    let mut any = false;
    for (id, c) in table.iter() {
        let truthy = |k: &str| c.get(k).is_some_and(Value::truthy);
        if !(truthy("enabled") && truthy("pinned")) || !c.path(&["spatialFollowers", &key]).is_some_and(Value::truthy) {
            continue;
        }
        let rotation = c.path(&["target", "rotation"]).and_then(Value::as_f64).unwrap_or(f64::NAN);
        let q = quat_multiply(spatial_quaternion(-rotation, 0.0, 0.0), world);
        let mut next = c.as_obj().cloned().unwrap_or_default();
        let mut followers = c.get("spatialFollowers").and_then(Value::as_obj).cloned().unwrap_or_default();
        followers.set(&key, Value::nums(&q));
        next.set("spatialFollowers", Value::object(followers));
        changed.set(id, Value::object(next));
        any = true;
    }
    if any {
        record.set("_stykIK", Value::object(changed));
    }
}

impl Context {
    /// `unprojectSpatial(p, depth, object, root)`.
    pub(crate) fn unproject_at(&self, p: [f64; 2], depth: f64) -> [f64; 2] {
        self.unproject(p, depth)
    }

    /// `projectSpatial(p, projection(object, root))`.
    pub(crate) fn project(&self, p: [f64; 3]) -> [f64; 2] {
        match &self.camera {
            Some(camera) => camera.project(p),
            None => [p[0], p[1]],
        }
    }

    /// `geometry.joints.get(handle)`: the handle as drawn.
    pub(crate) fn joint(&self, handle: u32) -> [f64; 2] {
        self.figure.plan.index_of.get(&handle).and_then(|&i| self.ends.get(i as usize).copied()).unwrap_or([f64::NAN; 2])
    }

    /// The handle's `rawPoint`, when perspective moved it.
    pub(crate) fn raw_joint(&self, handle: u32) -> Option<[f64; 2]> {
        self.raw(handle).map(|r| [r[0], r[1]])
    }

    pub(crate) fn raw(&self, handle: u32) -> Option<[f64; 3]> {
        self.figure.plan.index_of.get(&handle).and_then(|&i| self.raws.get(i as usize).copied().flatten())
    }

    fn unproject(&self, p: [f64; 2], depth: f64) -> [f64; 2] {
        match &self.camera {
            Some(camera) => camera.unproject(p, depth),
            None => p,
        }
    }

    pub(crate) fn world(&self, p: [f64; 3]) -> [f64; 3] {
        world_point(p, self.figure_angle, self.mirror, self.scale, self.root)
    }
}

impl Editor {
    /// The definition the figure in `object` is drawn from, as the document stores it.
    pub(crate) fn figure_value(&self, object: &Value) -> Value {
        let figures = self.report.get("figure_types").and_then(Value::elements);
        figures.and_then(|e| e.iter().find(|f| f.get("figure_type_id") == object.get("figure_type_id"))).unwrap_or(Value::Null)
    }

    /// `poseSpatialJoint(x, y, {stretch, depth, flip, pixel, anchor})`.
    pub(crate) fn pose_spatial_joint(&mut self, x: f64, y: f64, options: &Value) -> Result<bool, EditError> {
        let Some(context) = self.spatial_context()? else { return Ok(false) };
        let index = self.selection.joint as usize;
        let Some(bone) = bone(&context.figure, index) else { return Ok(false) };
        if !x.is_finite() || !y.is_finite() {
            return Ok(false);
        }
        let flag = |key: &str| options.get(key).is_some_and(Value::truthy);
        let mut anchor = options.get("anchor").filter(|a| a.truthy()).map(|a| [a.get("x").and_then(Value::as_f64).unwrap_or(f64::NAN), a.get("y").and_then(Value::as_f64).unwrap_or(f64::NAN)]);
        if bone.motion.is_some() {
            return self.move_mechanical_joint(&context, index, x, y, anchor);
        }
        let stretch = flag("stretch");
        // A planted knee or elbow steers its 3D bend plane (`setSpatialIKPole`).
        if !stretch && let Some(endpoint) = planted_limb_end(&context, index) {
            let selected = self.selection.joint;
            self.selection.joint = endpoint as i64;
            let result = (|| {
                let Some(pole) = self.spatial_ik_pole()? else { return Ok(false) };
                self.set_spatial_ik_pole(x, y, Some(pole.knee[2]))
            })();
            self.selection.joint = selected;
            return result;
        }
        let kind = if flag("depth") && !stretch { "arc" } else { "flat" };
        let uid = uid(&context.object).unwrap_or(0);
        if let Some(drag) = self.drag.as_mut() {
            // Pressing or releasing the depth key mid-drag starts the other gesture from the
            // current pose and pointer, so the bone never jumps.
            let key = format!("{uid}:{index}");
            if let Some(last) = drag.spatial_kinds.get(&key)
                && *last != kind
            {
                for k in ["arc", "flat"] {
                    drag.spatial_gestures.remove(&format!("{k}:{key}"));
                }
                anchor = Some([x, y]);
            }
            drag.spatial_kinds.insert(key, kind);
        }
        if kind == "arc" {
            let pixel = options.get("pixel").and_then(Value::as_f64).unwrap_or(0.0);
            self.arc_spatial_joint(&context, index, x, y, flag("alternate"), pixel, anchor)
        } else {
            self.flat_spatial_joint(&context, index, x, y, stretch, anchor)
        }
    }

    /// `_spatialGesture(kind)`: the drag's fixed start, kept for the rest of the gesture.
    fn bone_gesture(&mut self, context: &Context, index: usize, kind: &str) -> Result<BoneGesture, EditError> {
        let key = format!("{kind}:{}:{index}", uid(&context.object).unwrap_or(0));
        if let Some(Gesture::Bone(gesture)) = self.drag.as_ref().and_then(|d| d.spatial_gestures.get(&key)) {
            return Ok(gesture.clone());
        }
        let unported = || EditError::Unported("posing a 3D bone geometry did not frame".into());
        let bone = bone(&context.figure, index).ok_or_else(unported)?;
        let frame = context.frames.get(index).copied().flatten().ok_or_else(unported)?;
        let start = context.starts[index];
        let origin = [start[0], start[1], context.world(spatial_point(&frame, bone.origin))[2]];
        let tip = context.world(spatial_point(&frame, bone.tip));
        let vector = [tip[0] - origin[0], tip[1] - origin[1], tip[2] - origin[2]];
        let length = norm(&vector);
        let before = Self::spatial_pose(context, index).ok_or_else(unported)?;
        let local = spatial_quaternion(before.bend, before.turn, before.pitch);
        // Limbs lying in the view plane leave toward the character's front.
        let mut root_frame = frame;
        let mut at = index;
        while let Some(Spatial::Bone { parent, .. }) = context.figure.segments[at].rig.as_ref().and_then(|r| r.spatial.as_ref()) {
            if *parent == 0 {
                break;
            }
            let Some(p) = context.figure.plan.index_of.get(parent).map(|&p| p as usize) else { break };
            let Some(parent_frame) = context.frames.get(p).copied().flatten() else { break };
            root_frame = parent_frame;
            at = p;
        }
        let front = quat_rotate(spatial_world_quaternion(root_frame.q, context.figure_angle, context.mirror, false), [0.0, 0.0, 1.0])[2];
        let depth = if length > 1e-9 { vector[2] / length } else { 0.0 };
        let gesture = BoneGesture {
            origin,
            tip,
            length,
            direction: if length > 1e-9 { [vector[0] / length, vector[1] / length, vector[2] / length] } else { [1.0, 0.0, 0.0] },
            side: if depth.abs() > 0.04 { sign(depth) } else if front < -0.2 { -1.0 } else { 1.0 },
            world: spatial_world_quaternion(frame.q, context.figure_angle, context.mirror, false),
            parent: quat_multiply(frame.q, inverse_quaternion(local)),
            start: None,
            grab: None,
            native_length: None,
            pointer: None,
            swivel: None,
        };
        self.keep_gesture(key, Gesture::Bone(gesture.clone()));
        Ok(gesture)
    }

    fn keep_gesture(&mut self, key: String, gesture: Gesture) {
        if let Some(drag) = self.drag.as_mut() {
            drag.spatial_gestures.insert(key, gesture);
        }
    }

    /// `_setSpatialWorldOrientation(world, gesture, label, edit)`: the bone's channels for a
    /// world orientation.
    fn set_spatial_world_orientation(&mut self, context: &Context, index: usize, world: [f64; 4], gesture: &BoneGesture, label: &str, length: Option<f64>) -> Result<bool, EditError> {
        let before = Self::spatial_pose(context, index).ok_or_else(|| EditError::Unported("posing a 3D bone without a pose".into()))?;
        let bone = bone(&context.figure, index).unwrap();
        let pose = quaternion_pose(quat_multiply(inverse_quaternion(gesture.parent), spatial_world_quaternion(world, context.figure_angle, context.mirror, true)), before);
        let index_of = |id: u32| context.figure.plan.index_of.get(&id).map(|&i| i as usize);
        let channels = [(index_of(bone.turn), pose.turn - before.turn), (index_of(bone.pitch), pose.pitch - before.pitch)];
        let handle = context.figure.segments[index].id;
        let slot = context.slot;
        let lengths: Vec<Value> = context.figure.segments.iter().map(|s| Value::Num(s.length)).collect();
        let figure = context.figure.clone();
        self.object_edit_with(label, true, |editor| {
            crate::ik::release_spatial_chain(editor.frame_object_mut(slot).unwrap(), &figure, index);
            let sign = if editor.frame_objects()[slot].get("image_text_flags").is_some_and(Value::truthy) { -1.0 } else { 1.0 };
            editor.rotate_joint_by(slot, index, (pose.bend - before.bend) * sign, true, false)?;
            let record = editor.frame_object_mut(slot).unwrap();
            for (at, change) in channels {
                if let Some(at) = at {
                    crate::pose::add_angle_at(record, at, change * sign);
                }
            }
            plant_spatial_follower(record, handle, world);
            if let Some(length) = length {
                if !record.get("len_flag").is_some_and(Value::truthy) {
                    record.set("lengths", Value::array(lengths.clone()));
                }
                crate::pose::set_item_at(record, "lengths", index, length);
                record.set("len_flag", Value::Num(1.0));
            }
            Ok(())
        })
    }

    /// `_flatSpatialJoint(x, y, stretch, anchor)`: the bone turns about the view axis
    /// through its base, keeping its lean and twist.
    fn flat_spatial_joint(&mut self, context: &Context, index: usize, x: f64, y: f64, stretch: bool, anchor: Option<[f64; 2]>) -> Result<bool, EditError> {
        let mut gesture = self.bone_gesture(context, index, "flat")?;
        let depth = gesture.tip[2];
        let p = context.unproject([x, y], depth);
        let grab = *gesture.grab.get_or_insert_with(|| anchor.map_or([gesture.tip[0], gesture.tip[1]], |a| context.unproject(a, depth)));
        let length_flag = context.object.get("len_flag").is_some_and(Value::truthy);
        let native = *gesture.native_length.get_or_insert_with(|| if length_flag { number_at(&context.object, "lengths", index) } else { context.figure.segments[index].length });
        self.keep_gesture(format!("flat:{}:{index}", uid(&context.object).unwrap_or(0)), Gesture::Bone(gesture.clone()));
        let c = gesture.origin;
        let (gx, gy, px, py) = (grab[0] - c[0], grab[1] - c[1], p[0] - c[0], p[1] - c[1]);
        let (from, to) = (hypot(gx, gy), hypot(px, py));
        if from < 1e-6 || to < 1e-6 {
            return Ok(false);
        }
        let world = quat_multiply(spatial_quaternion(atan2(py, px) - atan2(gy, gx), 0.0, 0.0), gesture.world);
        self.set_spatial_world_orientation(context, index, world, &gesture, "Pose articulated joint", stretch.then(|| native * to / from))
    }

    /// `_arcSpatialJoint(x, y, flip, pixel, anchor)`: the bone keeps its length and swings in
    /// 3D so its end follows the pointer.
    #[allow(clippy::too_many_arguments)]
    fn arc_spatial_joint(&mut self, context: &Context, index: usize, x: f64, y: f64, flip: bool, pixel: f64, anchor: Option<[f64; 2]>) -> Result<bool, EditError> {
        let mut gesture = self.bone_gesture(context, index, "arc")?;
        if gesture.length < 1e-6 {
            return Ok(false);
        }
        let depth = gesture.origin[2] + gesture.direction[2] * gesture.length;
        let p = context.unproject([x, y], depth);
        let pointer = *gesture.pointer.get_or_insert_with(|| anchor.map_or([gesture.tip[0], gesture.tip[1]], |a| context.unproject(a, depth)));
        self.keep_gesture(format!("arc:{}:{index}", uid(&context.object).unwrap_or(0)), Gesture::Bone(gesture.clone()));
        let l = gesture.length.max(if pixel > 0.0 { 70.0 * pixel } else { 0.0 });
        let d = gesture.direction;
        let (dx, dy) = (d[0] * l + p[0] - pointer[0], d[1] * l + p[1] - pointer[1]);
        let reach = hypot(dx, dy);
        let direction = if reach >= l {
            [dx / reach, dy / reach, 0.0]
        } else {
            let side = gesture.side * if flip { -1.0 } else { 1.0 };
            [dx / l, dy / l, side * (l * l - reach * reach).sqrt() / l]
        };
        if reach < 1e-9 && direction[2].abs() < 1e-9 {
            return Ok(false);
        }
        self.set_spatial_world_orientation(context, index, quat_multiply(between_vectors(d, direction), gesture.world), &gesture, "Pose articulated joint", None)
    }

    /// `twistSpatialJoint(x, y, {pixel})`: the bone twists about its own axis; 120 screen
    /// pixels turn a quarter.
    pub(crate) fn twist_spatial_joint(&mut self, x: f64, y: f64, pixel: f64) -> Result<bool, EditError> {
        let Some(context) = self.spatial_context()? else { return Ok(false) };
        let index = self.selection.joint as usize;
        let Some(bone) = bone(&context.figure, index) else { return Ok(false) };
        if self.drag.is_none() || bone.motion.is_some() {
            return Ok(false);
        }
        if !x.is_finite() || !y.is_finite() || !pixel.is_finite() || pixel <= 0.0 {
            return Ok(false);
        }
        let mut gesture = self.bone_gesture(&context, index, "twist")?;
        let start = *gesture.start.get_or_insert([x, y]);
        let key = format!("twist:{}:{index}", uid(&context.object).unwrap_or(0));
        self.keep_gesture(key.clone(), Gesture::Bone(gesture.clone()));
        if gesture.length < 1e-6 {
            return Ok(false);
        }
        let angle = (x - start[0]) / pixel / 120.0 * std::f64::consts::PI / 2.0 * if context.mirror { -1.0 } else { 1.0 };
        let (d, h) = (gesture.direction, sin(angle / 2.0));
        let about = [d[0] * h, d[1] * h, d[2] * h, cos(angle / 2.0)];
        let figure = context.figure.clone();
        let handle = figure.segments[index].id;
        let controllers = context.object.get("_stykIK").and_then(Value::as_obj).cloned().unwrap_or_default();
        let truthy = |c: &Value, k: &str| c.get(k).is_some_and(Value::truthy);
        // The ankle or wrist marker of a 3D limb turns its hand or foot about the forearm or shin.
        let own = controllers.get(&handle.to_string()).cloned().unwrap_or(Value::Null);
        if truthy(&own, "enabled") && truthy(&own, "spatialTarget") {
            let definition = self.figure_value(&context.object);
            let end = (0..figure.segments.len()).position(|n| {
                matches!(self::bone(&figure, n), Some(b) if b.parent == handle && b.motion.is_none())
                    && !definition.get("segments").and_then(|s| s.item(n)).is_some_and(|s| s.get("_stykPoseChoice").is_some_and(Value::truthy))
            });
            if let Some(end) = end {
                let selected = self.selection.joint;
                self.selection.joint = end as i64;
                let result = (|| {
                    let part = self.bone_gesture(&context, end, "twist")?;
                    self.keep_gesture(format!("twist:{}:{end}", uid(&context.object).unwrap_or(0)), Gesture::Bone(part.clone()));
                    let label = format!("Turn {}", figure.segments[end].name.clone().filter(|n| !n.is_empty()).unwrap_or_else(|| "part".into()));
                    self.set_spatial_world_orientation(&context, end, quat_multiply(about, part.world), &part, &label, None)
                })();
                self.selection.joint = selected;
                return result;
            }
        }
        // A planted 3D limb holding this bone swings its bend plane (its swivel).
        if let Some((limb, _)) = planted_limbs(&context).into_iter().find(|(_, chain)| chain.contains(&index)) {
            let stored = controllers.get(&limb.to_string()).and_then(|c| c.path(&["spatialTarget", "swivel"])).and_then(Value::as_f64).unwrap_or(f64::NAN);
            let swivel = *gesture.swivel.get_or_insert(stored);
            self.keep_gesture(key, Gesture::Bone(gesture.clone()));
            let selected = self.selection.joint;
            self.selection.joint = figure.plan.index_of.get(&limb).map_or(-1, |&i| i as i64);
            let mut patch = styk_doc::Obj::new();
            patch.set("swivel", Value::Num(swivel + angle));
            let result = self.set_spatial_ik_target(&Value::object(patch));
            self.selection.joint = selected;
            return result;
        }
        self.set_spatial_world_orientation(&context, index, quat_multiply(about, gesture.world), &gesture, "Twist articulated joint", None)
    }

    /// `_moveMechanicalJoint(x, y, anchor)`: the slide or hinge moves to the point of its track
    /// nearest the pointer, relative to where its handle was grabbed.
    fn move_mechanical_joint(&mut self, context: &Context, index: usize, x: f64, y: f64, anchor: Option<[f64; 2]>) -> Result<bool, EditError> {
        let Some(motion) = Self::spatial_motion(context, index) else { return Ok(false) };
        if motion.max <= motion.min {
            return Ok(false);
        }
        let key = format!("mechanism:{}:{index}", uid(&context.object).unwrap_or(0));
        let gesture = match self.drag.as_ref().and_then(|d| d.spatial_gestures.get(&key)) {
            Some(Gesture::Mechanism(gesture)) => gesture.clone(),
            _ => {
                let unported = || EditError::Unported("moving a mechanism geometry did not frame".into());
                let bone = bone(&context.figure, index).ok_or_else(unported)?;
                let frame = context.frames.get(index).copied().flatten().ok_or_else(unported)?;
                let (tip, pivot) = (spatial_point(&frame, bone.tip), spatial_point(&frame, bone.origin));
                let local_axis = if motion.hinge { bone.motion.and_then(|m| m.axis).unwrap_or([0.0, 0.0, 1.0]) } else { frame.axis };
                let mut gesture = MechanismGesture {
                    slide: !motion.hinge,
                    tip,
                    pivot,
                    axis: quat_rotate(frame.q, local_axis),
                    value: motion.value,
                    start: [0.0; 3],
                    grab: [0.0; 2],
                    figure_angle: context.figure_angle,
                    mirror: context.mirror,
                    scale: context.scale,
                    root: context.root,
                };
                gesture.start = gesture.along(motion.value);
                gesture.grab = anchor.map_or([gesture.start[0], gesture.start[1]], |a| context.unproject(a, gesture.start[2]));
                self.keep_gesture(key, Gesture::Mechanism(gesture.clone()));
                gesture
            }
        };
        let pointer = context.unproject([x, y], gesture.start[2]);
        let target = [gesture.start[0] + pointer[0] - gesture.grab[0], gesture.start[1] + pointer[1] - gesture.grab[1]];
        let distance = |p: f64| {
            let q = gesture.along(p);
            (q[0] - target[0]).powi(2) + (q[1] - target[1]).powi(2)
        };
        // Sample the track, then refine between the neighbours of the nearest sample.
        let steps = 96;
        let at = |k: usize| motion.min + (motion.max - motion.min) * k as f64 / steps as f64;
        let mut best = 0;
        for k in 1..=steps {
            if distance(at(k)) < distance(at(best)) {
                best = k;
            }
        }
        let (mut lo, mut hi) = (at(best.saturating_sub(1)), at((best + 1).min(steps)));
        for _ in 0..40 {
            let (a, b) = (lo + (hi - lo) / 3.0, hi - (hi - lo) / 3.0);
            if distance(a) <= distance(b) {
                hi = b;
            } else {
                lo = a;
            }
        }
        // Past either end the pointer lands exactly on that stop.
        let value = [motion.min, motion.max].into_iter().fold((lo + hi) / 2.0, |v, end| if distance(end) <= distance(v) { end } else { v });
        Ok(self.set_spatial_motion(value, false)? || true)
    }
}

/// The pinned automatic 3D controllers of the figure, in table order, each with the chain it
/// drives.
fn planted_limbs(context: &Context) -> Vec<(u32, Vec<usize>)> {
    let figure = &context.figure;
    let skeleton = styk_eval::ik::Skeleton { segments: &figure.segments, plan: &figure.plan, polygons: &figure.polyfills, sources: None };
    let Some(table) = context.object.get("_stykIK").and_then(Value::as_obj) else { return Vec::new() };
    table
        .iter()
        .filter_map(|(id, c)| {
            let truthy = |k: &str| c.get(k).is_some_and(Value::truthy);
            let handle = id.parse::<u32>().ok()?;
            if !(truthy("enabled") && truthy("pinned") && truthy("spatialTarget")) || c.get("bendDirection").and_then(Value::as_f64) != Some(0.0) {
                return None;
            }
            let length = c.get("chainLength").and_then(Value::as_f64).unwrap_or(2.0).max(0.0).min(u32::MAX as f64) as u32;
            Some((handle, skeleton.chain(handle, length)))
        })
        .collect()
}

/// The endpoint of the first planted two-bone limb that starts at `index`.
fn planted_limb_end(context: &Context, index: usize) -> Option<usize> {
    let (handle, _) = planted_limbs(context).into_iter().find(|(_, chain)| chain.len() == 2 && chain[0] == index)?;
    context.figure.plan.index_of.get(&handle).map(|&i| i as usize)
}

#[cfg(test)]
mod same_call_context_tests {
    use super::*;
    use crate::{Authored, Options, Selection};
    use std::path::Path;

    fn recorded_editor(name: &str) -> (Editor, Value) {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../tests/edit/{name}.reference.json"));
        let reference = styk_doc::json::parse(&std::fs::read(path).unwrap()).unwrap();
        let first = reference.get("steps").unwrap().item(0).unwrap();
        let report = styk_doc::json::parse(first.get("document").unwrap().as_str().unwrap().as_bytes()).unwrap();
        let flag = |key: &str| reference.path(&["editor", key]).is_some_and(Value::truthy);
        let mut editor = Editor::new(report, Options { property_channels: flag("propertyChannels"), layer_timeline: flag("layerTimeline"), auto_key: flag("autoKey") });
        let state = first.get("state").unwrap();
        editor.set_view(
            state.get("tick").and_then(Value::as_f64).unwrap_or(0.0),
            state.get("frameIndex").and_then(Value::as_f64).unwrap_or(0.0) as usize,
            Selection {
                uid: state.get("selectedUid").and_then(Value::as_f64).map(|n| n as u32),
                uids: state.get("selectedUids").and_then(Value::numbers).unwrap_or_default().into_iter().map(|n| n as u32).collect(),
                joint: state.get("selectedJoint").and_then(Value::as_f64).unwrap_or(-1.0) as i64,
            },
        );
        let counter = |key: &str| state.get(key).and_then(Value::as_f64).unwrap_or(0.0) as u64;
        editor.set_counters(counter("layerRevision"), counter("nextFrameIdentity"), counter("nextUid"));
        editor.set_selection_metadata(state).unwrap();
        (editor, reference)
    }

    fn context_bits(context: &Context) -> String {
        format!("{:?}", (
            context.angles.iter().map(|n| n.to_bits()).collect::<Vec<_>>(),
            [context.figure_angle, context.scale].map(f64::to_bits), context.mirror,
            context.root.map(f64::to_bits),
            context.starts.iter().map(|p| p.map(f64::to_bits)).collect::<Vec<_>>(),
            context.ends.iter().map(|p| p.map(f64::to_bits)).collect::<Vec<_>>(),
            context.raws.iter().map(|p| p.map(|p| p.map(f64::to_bits))).collect::<Vec<_>>(),
            context.camera.as_ref().map(|c| (c.root.map(f64::to_bits), c.k.to_bits(), c.scale.to_bits())),
            context.shape.as_ref().map(|s| s.iter().map(|(id, s)| (*id, [s.width, s.taper].map(f64::to_bits))).collect::<Vec<_>>()),
            context.frames.iter().map(|f| f.map(|f| (
                f.q.map(f64::to_bits), f.t.map(f64::to_bits), f.dual.map(f64::to_bits),
                [f.native_bend, f.authored_bend, f.motion_value, f.stretch, f.rest_length].map(f64::to_bits),
                f.origin.map(f64::to_bits), f.axis.map(f64::to_bits), f.choice_scale.map(f64::to_bits),
                f.shape.map(|s| [s.width, s.taper].map(f64::to_bits)),
            ))).collect::<Vec<_>>(),
        ))
    }

    #[test]
    fn stale_same_call_context_is_cleared_before_absent_or_invalid_current_pose() {
        for case in ["slot", "uid", "malformed"] {
            let (mut editor, _) = recorded_editor("ik-unpinned-sheet");
            let slot = editor.object().unwrap().unwrap().0;
            let source = editor.shown_frame().unwrap();
            editor.authored = Some(Authored { frame: source.clone(), source, tick: editor.tick, transaction: false, definitions_start: None, key_at_playhead: false, key_at_playhead_layers: Vec::new() });
            let mut evaluation = None;
            assert!(editor.spatial_context_at_with(slot, Some(&mut evaluation)).unwrap().is_some());
            assert!(evaluation.is_some(), "{case}: seed a real prior tuple");
            let read_slot = match case {
                "slot" => editor.selection_frame().unwrap().len(),
                "uid" => {
                    let object = editor.frame_object_mut(slot).unwrap();
                    object.remove("unique_id");
                    // The UID guard must precede conversion of this malformed figure.
                    object.set("figure_type_id", Value::Null);
                    slot
                },
                "malformed" => { editor.frame_object_mut(slot).unwrap().set("figure_type_id", Value::Null); slot },
                _ => unreachable!(),
            };
            let raw = editor.shown_frame().unwrap();
            let report = editor.report().clone();
            let ordinary = editor.spatial_context_at(read_slot);
            let kept = editor.spatial_context_at_with(read_slot, Some(&mut evaluation));
            if case == "malformed" {
                let message = |result: Result<Option<Context>, EditError>| match result {
                    Err(EditError::Invalid(message)) => message,
                    _ => panic!("malformed edit-frame conversion must retain the existing Invalid error"),
                };
                assert_eq!(message(ordinary), format!("object {slot} of the edit frame has no identity or figure"));
                assert_eq!(message(kept), format!("object {slot} of the edit frame has no identity or figure"));
            } else {
                assert!(ordinary.unwrap().is_none(), "{case}: original absent-context result");
                assert!(kept.unwrap().is_none(), "{case}: retained-tuple absent-context result");
            }
            assert!(evaluation.is_none(), "{case}: no stale output survives a missing or invalid current pose");
            assert!(editor.shown_frame().unwrap().same_node(&raw));
            assert!(editor.report().same_node(&report));
        }
    }

    #[test]
    fn active_free_2d_and_spatial_3d_context_tuple_tracks_each_recorded_pose() {
        let mut checked = 0;
        for name in ["ik-unpinned-sheet", "ik-spatial-free-sheet"] {
            let (mut editor, reference) = recorded_editor(name);
            let steps = reference.get("steps").unwrap().elements().unwrap();
            let mut expected = steps.get(0).unwrap().get("document").unwrap().as_str().unwrap().to_string();
            let mut evaluation = None;
            let mut last_context = None;
            let mut changed_contexts = 0;
            for step in steps.iter().skip(1) {
                let call: Vec<Value> = step.get("call").unwrap().elements().unwrap().iter().collect();
                let method = call[0].as_str().unwrap();
                if method == "poseJoint" && editor.drag.is_some() {
                    let slot = editor.object().unwrap().unwrap().0;
                    let context = editor.spatial_context_at_with(slot, Some(&mut evaluation)).unwrap().unwrap();
                    let (prepared, frame, scene, solved) = evaluation.as_ref().unwrap();
                    let borrowed = editor.spatial_context_from(slot, prepared, frame, scene, solved).unwrap().unwrap();
                    let ordinary = editor.spatial_context_at(slot).unwrap().unwrap();
                    let bits = context_bits(&context);
                    assert_eq!(bits, context_bits(&borrowed), "{name}: the tuple is the current immutable pose");
                    assert_eq!(bits, context_bits(&ordinary), "{name}: original current-context numeric bits");
                    assert!(context.object.same_node(&editor.selection_frame().unwrap()[slot]));
                    assert_eq!(context.frames.iter().any(Option::is_some), name == "ik-spatial-free-sheet");
                    if last_context.as_ref().is_some_and(|last| last != &bits) { changed_contexts += 1; }
                    last_context = Some(bits);
                    checked += 1;
                }
                editor.set_draws(step.get("draws").unwrap_or(&Value::Null));
                editor.call(method, &call[1..]).unwrap();
                if let Some(document) = step.get("document").and_then(Value::as_str) { expected = document.to_string(); }
                assert_eq!(editor.report_json(), expected, "{name}/{}: document", step.get("step").unwrap());
                assert_eq!(editor.state_value(), *step.get("state").unwrap(), "{name}/{}: state", step.get("step").unwrap());
                if method == "commitDrag" { break; }
            }
            assert!(changed_contexts > 0, "{name}: repeated samples must actually change the current context");
        }
        assert_eq!(checked, 6);
    }


    fn solved_bits(solved: &HashMap<u32, crate::ik::Solved>) -> Vec<(u32, String)> {
        let mut values: Vec<_> = solved.iter().map(|(&uid, solved)| {
            let solution = &solved.solution;
            let results: Vec<_> = solution.results.iter().map(|(handle, outcome)| {
                let reference = outcome.bend_reference.as_ref().map(|r| (
                    [r.side, r.angle, r.axis, r.ratio].map(f64::to_bits),
                    r.shape.as_ref().map(|v| v.iter().map(|v| v.to_bits()).collect::<Vec<_>>()),
                ));
                let followers = solved.followers_of(*handle).map(|v| v.iter().map(|(&id, &angle)| (id, angle.to_bits())).collect::<Vec<_>>());
                let joined = solved.joined_followers_of(*handle).map(|v| v.iter().map(|(&uid, angles)| (
                    uid, angles.iter().map(|(&id, &angle)| (id, angle.to_bits())).collect::<Vec<_>>(),
                )).collect::<Vec<_>>());
                (*handle, outcome.conflict, outcome.iterations, [outcome.error, outcome.stretch].map(f64::to_bits), outcome.chain.clone(), reference, followers, joined)
            }).collect();
            (uid, format!("{:?}", (
                solution.angles.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
                solution.lengths.as_ref().map(|v| v.iter().map(|v| v.to_bits()).collect::<Vec<_>>()),
                results,
            )))
        }).collect();
        values.sort_by_key(|(uid, _)| *uid);
        values
    }

    #[test]
    fn retained_numeric_context_preserves_recorded_joints_and_complete_solutions() {
        for name in [
            "startup-sheet", "ik-unpinned-sheet", "pinned-ik-sheet", "ik-followers-sheet",
            "ik-joined-sheet", "ik-joined-unpinned-sheet", "ik-spatial-sheet",
            "ik-spatial-free-sheet", "ik-spatial-joined-free-sheet", "ik-movieclip-parent-sheet",
        ] {
            let (mut editor, reference) = recorded_editor(name);
            let steps = reference.get("steps").unwrap().elements().unwrap();
            let mut expected = steps.get(0).unwrap().get("document").unwrap().as_str().unwrap().to_string();
            let mut checked = 0;
            let mut omitted_output = 0;
            let mut nonempty_solutions = 0;
            for step in steps.iter().skip(1) {
                let call: Vec<Value> = step.get("call").unwrap().elements().unwrap().iter().collect();
                let method = call[0].as_str().unwrap();
                if method == "poseJoint" {
                    let slot = editor.object().unwrap().unwrap().0;
                    let original = editor.spatial_context_at(slot).unwrap().unwrap();
                    let (prepared, frame, full) = editor.evaluate_only(Some(&[slot])).unwrap();
                    let full_solved = crate::ik::solve_frame(&prepared, &frame, &full);
                    let mut retained = None;
                    let numeric = editor.spatial_context_at_with(slot, Some(&mut retained)).unwrap().unwrap();
                    let (_, _, query, solved) = retained.as_ref().unwrap();
                    assert_eq!(context_bits(&numeric), context_bits(&original), "{name}: all context numeric fields");
                    assert!(numeric.object.same_node(&original.object));
                    assert!(Arc::ptr_eq(&numeric.figure, &original.figure));
                    assert_eq!(solved_bits(solved), solved_bits(&full_solved), "{name}: the entire solved map, including joined followers/conflicts");
                    if !solved.is_empty() { nonempty_solutions += 1; }
                    if query.items.is_empty() && !full.items.is_empty() { omitted_output += 1; }
                    if matches!(name, "ik-spatial-sheet" | "ik-spatial-free-sheet" | "ik-spatial-joined-free-sheet" | "ik-movieclip-parent-sheet") {
                        assert_eq!(format!("{query:?}"), format!("{full:?}"), "{name}: rich figure or needed ancestor retains the complete scene");
                    }
                    checked += 1;
                }
                editor.set_draws(step.get("draws").unwrap_or(&Value::Null));
                editor.call(method, &call[1..]).unwrap();
                if let Some(document) = step.get("document").and_then(Value::as_str) { expected = document.to_string(); }
                assert_eq!(editor.report_json(), expected, "{name}/{}: document", step.get("step").unwrap());
                assert_eq!(editor.state_value(), *step.get("state").unwrap(), "{name}/{}: state", step.get("step").unwrap());
                if method == "commitDrag" { break; }
            }
            assert!(checked > 0, "{name}: actual recorded posing reaches the comparison");
            if matches!(name, "startup-sheet" | "ik-unpinned-sheet") {
                assert!(omitted_output > 0, "{name}: visible ordinary geometry discards render output");
            }
            if matches!(name, "pinned-ik-sheet" | "ik-joined-sheet" | "ik-spatial-sheet") {
                assert!(nonempty_solutions > 0, "{name}: pinned controls exercise a real solved map");
            }
        }
    }
}
