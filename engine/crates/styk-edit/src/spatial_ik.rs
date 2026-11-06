//! IK targets with their 3D parts as editing sees them (`capture` and `poseIKTarget`,
//! `captureSpatialIK`, the 3D IK commands of
//! src/editor-spatial.mjs).
//!
//! Ported: the capture of a limb with its 3D target and followers' orientations, kept for
//! the rest of a gesture (`_drag.ikCapture`); the flat pole of a planted or posed 3D limb
//! (`_flatSpatialIKPole`); pushing a target in depth (`poseSpatialIKDepth`) and the pointer
//! offset that follows (`_spatialIKPointer`, `_clearFlatSpatialIK`, `_clearSpatialIKDepth`);
//! the pole handle of a planted limb and steering it (`getSpatialIKPole`, `setSpatialIKPole`);
//! `setSpatialIKTarget`.

use std::collections::{BTreeMap, HashMap};

use styk_eval::{eval::{Frame, Prepared}, geometry::Scene};

use styk_doc::{Obj, Value};
use styk_eval::ik::spatial::{capture_spatial_target, cross, dot, normalize, flat_spatial_bend, spatial_knee, spatial_pole_for, spatial_world_quaternion, spatial_world_vector};
use styk_eval::ik::{self, BendReference, Pose, Skeleton, SpatialTarget, Table};
use styk_eval::rig::{quat_multiply, spatial_point, spatial_quaternion};
use styk_math::{cos, hypot, norm, sin};

use crate::record::uid;
use crate::{EditError, Editor};

/// `capture(figure, object, geometry, handle, controller)`: the limb as drawn.
#[derive(Clone, Debug)]
pub(crate) struct Capture {
    /// `unprojectJoint(geometry.joints.get(handle))`: the end of the limb before perspective.
    pub target: [f64; 2],
    pub followers: BTreeMap<u32, f64>,
    pub joined_followers: Option<BTreeMap<u32, BTreeMap<u32, f64>>>,
    pub bend_direction: f64,
    pub bend_reference: BendReference,
    pub spatial_followers: Option<BTreeMap<u32, [f64; 4]>>,
    pub joined_spatial_followers: Option<BTreeMap<u32, BTreeMap<u32, [f64; 4]>>>,
    pub spatial_target: Option<SpatialTarget>,
}

/// `captureSpatialIK(...)`: the 3D parts alone (`_drag.spatialIKCapture`).
#[derive(Clone, Debug)]
pub(crate) struct SpatialCapture {
    pub spatial_followers: Option<BTreeMap<u32, [f64; 4]>>,
    pub spatial_target: Option<SpatialTarget>,
}

/// `spatialPoleHandle(...)`: where a planted 3D limb's pole handle sits, in the scene before
/// perspective.
#[derive(Clone, Copy, Debug)]
pub(crate) struct PoleHandle {
    pub point: [f64; 3],
    pub center: [f64; 3],
    pub knee: [f64; 3],
}

/// The flat pole gesture of a 3D limb (`flat-ik:` in `spatialGesture`), in the solver's
/// unscaled world space.
#[derive(Clone, Copy, Debug)]
pub(crate) struct FlatPole {
    base: [f64; 3],
    end: [f64; 3],
    a: f64,
    b: f64,
    lean: f64,
    side: f64,
}

pub(crate) fn sign(v: f64) -> f64 {
    if v > 0.0 {
        1.0
    } else if v < 0.0 {
        -1.0
    } else {
        v
    }
}

/// A 3D target as the editor stores it: depth, pole, swivel and the bend-plane normals.
pub(crate) fn spatial_target_value(target: &SpatialTarget) -> Value {
    let mut value = Obj::new();
    value.set("depth", Value::Num(target.depth));
    value.set("pole", Value::nums(&target.pole));
    value.set("swivel", Value::Num(target.swivel));
    if let Some(normals) = &target.normals {
        value.set("normals", Value::array(normals.iter().map(|n| Value::nums(n)).collect()));
    }
    Value::object(value)
}

pub(crate) fn quaternion_table(table: &BTreeMap<u32, [f64; 4]>) -> Value {
    let mut value = Obj::new();
    for (id, q) in table {
        value.set(&id.to_string(), Value::nums(q));
    }
    Value::object(value)
}

pub(crate) fn joined_quaternion_table(table: &BTreeMap<u32, BTreeMap<u32, [f64; 4]>>) -> Value {
    let mut value = Obj::new();
    for (uid, q) in table { value.set(&uid.to_string(), quaternion_table(q)); }
    Value::object(value)
}

/// Reads a stored 3D target back (lenient, as `parse` reads one).
pub(crate) fn parse_spatial_target(value: &Value) -> Option<SpatialTarget> {
    let number = |key: &str| value.get(key).and_then(Value::as_f64);
    let vector = |v: &Value| v.numbers().filter(|n| n.len() == 3).map(|n| [n[0], n[1], n[2]]);
    Some(SpatialTarget {
        depth: number("depth")?,
        pole: vector(value.get("pole")?)?,
        swivel: number("swivel").unwrap_or(0.0),
        normals: value.get("normals").and_then(|n| Some([vector(&n.item(0)?)?, vector(&n.item(1)?)?])),
    })
}

/// `{...base, ...patch}` for objects: existing keys keep their place, new ones follow.
pub(crate) fn merged(base: &Value, patch: &[(&str, Value)]) -> Value {
    let mut object = base.as_obj().cloned().unwrap_or_default();
    for (key, value) in patch {
        object.set(key, value.clone());
    }
    Value::object(object)
}

/// `captureSpatialIK(…, [], [index], rotation).spatialFollowers?.[handle]` for a joint of a figure of an assembly: the orientation
/// its limb keeps relative to the target, when the figure is posed in 3D.
pub(crate) fn follower_orientation(geometry: Option<&styk_eval::geometry::ObjectGeometry>, index: usize, rotation: f64) -> Option<[f64; 4]> {
    let spatial = geometry?.spatial.as_ref()?;
    let frame = spatial.frames.get(index).copied().flatten()?;
    Some(quat_multiply(spatial_quaternion(-rotation, 0.0, 0.0), spatial_world_quaternion(frame.q, spatial.figure_angle, spatial.mirror, false)))
}

/// What `capture` reads of the controller it captures the limb for.
#[derive(Clone, Debug)]
pub(crate) struct CaptureSpec {
    /// `controller.target.rotation ?? 0`.
    pub rotation: f64,
    pub chain_length: u32,
    /// `controller.bendDirection`, when set: otherwise the side the limb bends to on screen.
    pub bend_direction: Option<f64>,
    pub bend_reference: Option<BendReference>,
    /// `controller.spatialTarget.swivel ?? 0`.
    pub swivel: f64,
}

impl Editor {
    /// `capture(figure, object, geometry, handle, controller)` of the limb ending at
    /// `handle` of the figure in `slot`, with `captureSpatialIK`'s parts.
    #[cfg(test)]
    pub(crate) fn capture_limb(&self, slot: usize, handle: u32) -> Result<Capture, EditError> {
        let spec = self.capture_limb_spec(slot, handle)?;
        self.capture_with(slot, handle, &spec)
    }

    /// The same selection-record capture, using evaluation from this immutable call only.
    pub(crate) fn capture_limb_from(&self, slot: usize, handle: u32, prepared: &Prepared, frame: &Frame, scene: &Scene, solved: &HashMap<u32, crate::ik::Solved>) -> Result<Capture, EditError> {
        let spec = self.capture_limb_spec(slot, handle)?;
        self.capture_from(slot, handle, &spec, prepared, frame, scene, Some(solved))
    }

    fn capture_limb_spec(&self, slot: usize, handle: u32) -> Result<CaptureSpec, EditError> {
        let unported = |what: &str| EditError::Unported(format!("posing an IK target {what}"));
        // The figure as selection reads it (on a layer sheet the frame on show), as `captureFor` reads `editor.object`.
        let object = self.selection_frame()?.get(slot).cloned().ok_or_else(|| unported("outside the frame"))?;
        let current = object.path(&["_stykIK", &handle.to_string()]).cloned().unwrap_or(Value::Null);
        let controller = ik::parse::table(object.get("_stykIK")).and_then(|table| table.get(handle).cloned()).ok_or_else(|| unported("with a controller the engine cannot read"))?;
        Ok(CaptureSpec {
            rotation: controller.target.rotation,
            chain_length: controller.chain_length,
            // `controller.bendDirection ?? bendDirection`
            bend_direction: current.get("bendDirection").is_some_and(|v| !v.is_null()).then_some(controller.bend_direction),
            bend_reference: controller.bend_reference.clone(),
            swivel: controller.spatial_target.as_ref().map_or(0.0, |s| s.swivel),
        })
    }

    /// Capture for the controller `spec` describes.
    pub(crate) fn capture_with(&self, slot: usize, handle: u32, spec: &CaptureSpec) -> Result<Capture, EditError> {
        let (prepared, frame, scene) = self.evaluate_only(Some(&[slot]))?;
        self.capture_from(slot, handle, spec, &prepared, &frame, &scene, None)
    }

    /// Recalculate capture for each controller spec while borrowing the same pre-edit pose.
    /// The full solved map is kept: joined followers and spatial context read it too.
    pub(crate) fn capture_from(&self, slot: usize, handle: u32, spec: &CaptureSpec, prepared: &Prepared, frame: &Frame, scene: &Scene, solved: Option<&HashMap<u32, crate::ik::Solved>>) -> Result<Capture, EditError> {
        let unported = |what: &str| EditError::Unported(format!("posing an IK target {what}"));
        let object = self.selection_frame()?.get(slot).cloned().ok_or_else(|| unported("outside the frame"))?;
        let id = uid(&object).ok_or_else(|| unported("of a figure without an identity"))?;
        let at = frame.objects.iter().position(|o| o.uid == id).ok_or_else(|| unported("of a figure the engine does not draw"))?;
        let evaluated = &frame.objects[at];
        let geometry = scene.objects.iter().find(|g| g.uid == id && g.resolved).ok_or_else(|| unported("of a figure the engine does not draw"))?;
        let figure = evaluated.figure_override.as_deref().or_else(|| prepared.doc.figure(evaluated.figure).map(|f| &**f)).ok_or_else(|| unported("of a figure without a definition"))?;
        let skeleton = Skeleton { segments: &figure.segments, plan: &figure.plan, polygons: &figure.polyfills, sources: None };
        // Preserve the wrapper's validation order before solving when no map was supplied.
        let owned_solved;
        let solved = match solved {
            Some(solved) => solved,
            None => { owned_solved = crate::ik::solve_frame(prepared, frame, scene); &owned_solved }
        };
        let drawn = |i: usize| crate::ik::displayed_angle(prepared, frame, scene, solved, at, i);
        let rotation = spec.rotation;
        let follower_indices = skeleton.follower_indices(handle);
        let followers: BTreeMap<u32, f64> = follower_indices.iter().map(|&i| (figure.segments[i].id, drawn(i) - rotation)).collect();
        let chain = skeleton.chain(handle, spec.chain_length);
        let mut bend_direction = 1.0;
        if chain.len() >= 2 {
            let (a, c) = (geometry.starts[chain[0]], geometry.ends[chain[chain.len() - 1]]);
            let mut cross = 0.0f64;
            for &i in &chain[..chain.len() - 1] {
                let b = geometry.ends[i];
                let value = (c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0]);
                if value.abs() > cross.abs() {
                    cross = value;
                }
            }
            if cross.abs() > 1e-8 {
                bend_direction = if cross < 0.0 { -1.0 } else { 1.0 };
            }
        }
        let Some(point) = skeleton.index(handle).and(geometry.joint(figure, handle)) else {
            return Err(EditError::Invalid("errors.editorIk.selectAValidIkNode".into()));
        };
        // `unprojectJoint(point)`: before perspective when the figure has one.
        let raw = skeleton.index(handle).and_then(|i| geometry.spatial.as_ref().and_then(|s| s.depths.get(i)).and_then(|d| d.raw));
        let target = raw.map_or(point, |r| [r[0], r[1]]);
        if chain.is_empty() {
            return Err(unported("without a chain"));
        }
        let points: Vec<[f64; 2]> = std::iter::once(geometry.starts[chain[0]]).chain(chain.iter().map(|&i| geometry.ends[i])).collect();
        let lengths: Vec<f64> = chain.iter().map(|&i| hypot(geometry.ends[i][0] - geometry.starts[i][0], geometry.ends[i][1] - geometry.starts[i][1])).collect();
        let bend_reference = ik::bend_reference(&points, &lengths, spec.bend_reference.as_ref());
        let bend_direction = spec.bend_direction.unwrap_or(bend_direction);
        let context = self.spatial_context_from(slot, prepared, frame, scene, solved)?;
        let spatial = Self::capture_spatial_from(context.as_ref(), &chain, &follower_indices, rotation, spec.swivel);
        Ok(Capture { target, followers, joined_followers: None, bend_direction, bend_reference, spatial_followers: spatial.spatial_followers, joined_spatial_followers: None, spatial_target: spatial.spatial_target })
    }

    /// `captureSpatialIK(figure, object, geometry, chain, followers, rotation, swivel)`.
    pub(crate) fn capture_spatial(&self, slot: usize, chain: &[usize], followers: &[usize], rotation: f64, swivel: f64) -> Result<SpatialCapture, EditError> {
        let context = self.spatial_context_at(slot)?;
        Ok(Self::capture_spatial_from(context.as_ref(), chain, followers, rotation, swivel))
    }

    pub(crate) fn capture_spatial_from(context: Option<&crate::spatial::Context>, chain: &[usize], followers: &[usize], rotation: f64, swivel: f64) -> SpatialCapture {
        let Some(context) = context else { return SpatialCapture { spatial_followers: None, spatial_target: None } };
        let mut spatial_followers = BTreeMap::new();
        for &i in followers {
            if let Some(frame) = context.frames.get(i).copied().flatten() {
                let q = quat_multiply(spatial_quaternion(-rotation, 0.0, 0.0), spatial_world_quaternion(frame.q, context.figure_angle, context.mirror, false));
                spatial_followers.insert(context.figure.segments[i].id, q);
            }
        }
        let frames: Vec<_> = chain.iter().map(|&i| context.frames.get(i).copied().flatten()).collect();
        let bones: Vec<_> = chain.iter().map(|&i| crate::spatial::bone(&context.figure, i)).collect();
        let spatial_target = match (frames.as_slice(), bones.as_slice()) {
            ([Some(f0), Some(f1)], [Some(b0), Some(b1)]) => {
                let points = [spatial_point(f0, b0.origin), spatial_point(f0, b0.tip), spatial_point(f1, b1.tip)];
                Some(capture_spatial_target(points, f0.q, f1.q, swivel, context.figure_angle, context.mirror, context.scale))
            }
            _ => None,
        };
        SpatialCapture { spatial_followers: (!spatial_followers.is_empty()).then_some(spatial_followers), spatial_target }
    }

    /// `_flatSpatialIKPole(handle, controller, target, spatialTarget)`: drags of a 3D hand or
    /// foot solve the limb as on a flat figure; the pole that keeps each bone's lean and the
    /// knee on its side of the limb on screen. `None` for other limbs and edge-on axes.
    pub(crate) fn flat_spatial_ik_pole(&mut self, slot: usize, handle: u32, chain_length: u32, bend_direction: f64, target: [f64; 2], spatial: &SpatialTarget) -> Result<Option<[f64; 3]>, EditError> {
        if bend_direction != 0.0 {
            return Ok(None);
        }
        let Some(context) = self.spatial_context_at(slot)? else { return Ok(None) };
        let figure = &context.figure;
        let skeleton = Skeleton { segments: &figure.segments, plan: &figure.plan, polygons: &figure.polyfills, sources: None };
        let chain = skeleton.chain(handle, chain_length);
        if chain.len() != 2 || context.scale.abs() < 1e-9 {
            return Ok(None);
        }
        let key = format!("flat-ik:{}:{handle}", uid(&context.object).unwrap_or(0));
        let mut gesture = match self.drag.as_ref().and_then(|d| d.spatial_gestures.get(&key)) {
            Some(crate::spatial::Gesture::FlatIk(gesture)) => *gesture,
            _ => {
                let (Some(f0), Some(f1)) = (context.frames.get(chain[0]).copied().flatten(), context.frames.get(chain[1]).copied().flatten()) else { return Ok(None) };
                let (Some(b0), Some(b1)) = (crate::spatial::bone(figure, chain[0]), crate::spatial::bone(figure, chain[1])) else { return Ok(None) };
                let point = |frame, p| spatial_world_vector(spatial_point(frame, p), context.figure_angle, context.mirror, false);
                let (base, knee, end) = (point(&f0, b0.origin), point(&f0, b0.tip), point(&f1, b1.tip));
                let a = norm(&[knee[0] - base[0], knee[1] - base[1], knee[2] - base[2]]);
                let reach = hypot(end[0] - base[0], end[1] - base[1]);
                let b = norm(&[end[0] - knee[0], end[1] - knee[1], end[2] - knee[2]]);
                let offset = |p: [f64; 3]| (end[0] - base[0]) * (p[1] - base[1]) - (end[1] - base[1]) * (p[0] - base[0]);
                let bent = offset(knee);
                let natural = offset(spatial_knee(base, end, spatial.pole, spatial.swivel, a, b).knee);
                let side = if bent.abs() > 1e-3 * a * reach {
                    sign(bent)
                } else if natural.abs() > 0.05 * a * reach {
                    sign(natural)
                } else {
                    0.0
                };
                FlatPole { base, end, a, b, lean: knee[2] - base[2], side }
            }
        };
        let aim = [(target[0] - context.root[0]) / context.scale, (target[1] - context.root[1]) / context.scale, spatial.depth / context.scale];
        let b = gesture.base;
        // Failing that, toward the side the pointer first leaves it by.
        if gesture.side == 0.0 || gesture.side.is_nan() {
            let s = sign((gesture.end[0] - b[0]) * (aim[1] - b[1]) - (gesture.end[1] - b[1]) * (aim[0] - b[0]));
            gesture.side = if s == 0.0 || s.is_nan() { 1.0 } else { s };
        }
        if let Some(drag) = self.drag.as_mut() {
            drag.spatial_gestures.insert(key, crate::spatial::Gesture::FlatIk(gesture));
        }
        Ok(flat_spatial_bend(b, aim, gesture.lean, gesture.side, gesture.a, gesture.b).map(|bend| spatial_pole_for(b, aim, bend, spatial.swivel)))
    }

    /// `poseSpatialIKDepth(x, y, {pixel})`: the depth key pushes a 3D target toward the camera
    /// (down) or away (up) while it stays put on screen.
    pub(crate) fn pose_spatial_ik_depth(&mut self, slot: usize, handle: u32, x: f64, y: f64, pixel: f64) -> Result<bool, EditError> {
        let object = self.frame_objects().get(slot).cloned().unwrap_or(Value::Null);
        let c = object.path(&["_stykIK", &handle.to_string()]).cloned().unwrap_or(Value::Null);
        let truthy = |k: &str| c.get(k).is_some_and(Value::truthy);
        if !truthy("enabled") || !truthy("spatialTarget") || c.get("bendDirection").and_then(Value::as_f64) != Some(0.0) || self.drag.is_none() || !x.is_finite() || !y.is_finite() || !pixel.is_finite() || pixel <= 0.0 {
            return Ok(false);
        }
        let key = format!("depth:{}:{handle}", uid(&object).unwrap_or(0));
        let depth = c.path(&["spatialTarget", "depth"]).and_then(Value::as_f64).unwrap_or(f64::NAN);
        let (start_y, start_depth) = match self.drag.as_ref().and_then(|d| d.spatial_gestures.get(&key)) {
            Some(crate::spatial::Gesture::Depth { y, depth }) => (*y, *depth),
            _ => {
                self.drag.as_mut().unwrap().spatial_gestures.insert(key, crate::spatial::Gesture::Depth { y, depth });
                (y, depth)
            }
        };
        let scale = object.get("scale").and_then(Value::as_f64).unwrap_or(f64::NAN).abs();
        let mut patch = Obj::new();
        patch.set("depth", Value::Num(start_depth + (y - start_y) / pixel * scale * 0.5));
        self.set_spatial_ik_target(&Value::object(patch))?;
        Ok(true)
    }

    /// `_clearFlatSpatialIK()`: after a depth push the next plain drag captures the limb
    /// afresh and continues from where the target is (`ikResume`).
    pub(crate) fn clear_flat_spatial_ik(&mut self, uid: u32, handle: u32) {
        let Some(drag) = self.drag.as_mut() else { return };
        let key = format!("{uid}:{handle}");
        drag.spatial_gestures.remove(&format!("flat-ik:{key}"));
        drag.ik_captures.remove(&key);
        drag.ik_resume.insert(key, None);
    }

    /// `_clearSpatialIKDepth()`.
    pub(crate) fn clear_spatial_ik_depth(&mut self, uid: u32, handle: u32) {
        if let Some(drag) = self.drag.as_mut() {
            drag.spatial_gestures.remove(&format!("depth:{uid}:{handle}"));
        }
    }

    /// `_spatialIKPointer(x, y)`: the pointer for a plain target drag, offset by where a depth
    /// push left the target.
    pub(crate) fn spatial_ik_pointer(&mut self, slot: usize, handle: u32, x: f64, y: f64) -> Result<[f64; 2], EditError> {
        let object = self.frame_objects().get(slot).cloned().unwrap_or(Value::Null);
        let key = format!("{}:{handle}", uid(&object).unwrap_or(0));
        let Some(resume) = self.drag.as_ref().and_then(|d| d.ik_resume.get(&key).copied()) else { return Ok([x, y]) };
        let offset = match resume {
            Some(offset) => offset,
            None => {
                let (prepared, _, scene) = self.evaluate_only(Some(&[slot]))?;
                let id = uid(&object).unwrap_or(0);
                let figure_id = object.get("figure_type_id").and_then(Value::as_f64).unwrap_or(f64::NAN) as u32;
                let joint = scene.objects.iter().find(|g| g.uid == id && g.resolved).and_then(|g| prepared.doc.figure(figure_id).and_then(|f| g.joint(f, handle)));
                let p = joint.unwrap_or([f64::NAN; 2]);
                let offset = [p[0] - x, p[1] - y];
                self.drag.as_mut().unwrap().ik_resume.insert(key, Some(offset));
                offset
            }
        };
        Ok([x + offset[0], y + offset[1]])
    }

    /// `getSpatialIKPole()`: the pole handle of the selected 3D limb end.
    pub(crate) fn spatial_ik_pole(&self) -> Result<Option<PoleHandle>, EditError> {
        let Some((_, object)) = self.object()? else { return Ok(None) };
        if self.selection.joint < 0 {
            return Ok(None);
        }
        let definition = self.figure_value(&object);
        let Some(handle) = definition.get("segments").and_then(|s| s.item(self.selection.joint as usize)).and_then(|s| s.get("segment_id").and_then(Value::as_f64)) else { return Ok(None) };
        let handle = handle as u32;
        let c = object.path(&["_stykIK", &handle.to_string()]).cloned().unwrap_or(Value::Null);
        if !c.get("enabled").is_some_and(Value::truthy) || !c.get("spatialTarget").is_some_and(Value::truthy) || c.get("bendDirection").and_then(Value::as_f64) != Some(0.0) {
            return Ok(None);
        }
        let Some(context) = self.spatial_context()? else { return Ok(None) };
        let controller = ik::parse::table(object.get("_stykIK")).and_then(|t| t.get(handle).cloned()).ok_or_else(|| EditError::Unported("steering a 3D IK pole the engine cannot read".into()))?;
        let pole = c.path(&["spatialTarget", "pole"]).and_then(Value::numbers).filter(|p| p.len() == 3).ok_or_else(|| EditError::Unported("steering a 3D IK pole that is not a vector".into()))?;
        let pole = [pole[0], pole[1], pole[2]];
        let swivel = c.path(&["spatialTarget", "swivel"]).filter(|v| !v.is_null()).map_or(Some(0.0), Value::as_f64).unwrap_or(f64::NAN);
        let figure = &context.figure;
        let skeleton = Skeleton { segments: &figure.segments, plan: &figure.plan, polygons: &figure.polyfills, sources: None };
        let chain = skeleton.chain(handle, controller.chain_length);
        if chain.len() != 2 || context.scale.abs() < 1e-9 {
            return Ok(None);
        }
        let (Some(f0), Some(f1)) = (context.frames.get(chain[0]).copied().flatten(), context.frames.get(chain[1]).copied().flatten()) else { return Ok(None) };
        let (Some(b0), Some(b1)) = (crate::spatial::bone(figure, chain[0]), crate::spatial::bone(figure, chain[1])) else { return Ok(None) };
        let (base, knee, end) = (context.world(spatial_point(&f0, b0.origin)), context.world(spatial_point(&f0, b0.tip)), context.world(spatial_point(&f1, b1.tip)));
        let axis = normalize([end[0] - base[0], end[1] - base[1], end[2] - base[2]]);
        let along = dot(pole, axis);
        let raw = [pole[0] - axis[0] * along, pole[1] - axis[1] * along, pole[2] - axis[2] * along];
        let mut direction = normalize(if norm(&raw) < 1e-6 { cross(axis, if axis[0].abs() < 0.8 { [1.0, 0.0, 0.0] } else { [0.0, 1.0, 0.0] }) } else { raw });
        let side = cross(axis, direction);
        let (cs, sn) = (cos(swivel), sin(swivel));
        direction = [0, 1, 2].map(|i| direction[i] * cs + side[i] * sn);
        let center = [0, 1, 2].map(|i| (base[i] + end[i]) / 2.0);
        let length = norm(&[knee[0] - base[0], knee[1] - base[1], knee[2] - base[2]]) + norm(&[end[0] - knee[0], end[1] - knee[1], end[2] - knee[2]]);
        // `Math.max(20, length * .5)`
        let radius = if (length * 0.5).is_nan() { f64::NAN } else { (length * 0.5).max(20.0) };
        let point = [0, 1, 2].map(|i| center[i] + direction[i] * radius);
        Ok(Some(PoleHandle { point, center, knee }))
    }

    /// `setSpatialIKPole(x, y, depth)`: the pole points from the middle of the limb toward
    /// the pointer, unprojected at `depth`.
    pub(crate) fn set_spatial_ik_pole(&mut self, x: f64, y: f64, depth: Option<f64>) -> Result<bool, EditError> {
        let Some(pole) = self.spatial_ik_pole()? else { return Ok(false) };
        let depth = depth.unwrap_or(pole.point[2]);
        if ![x, y, depth].iter().all(|v| v.is_finite()) {
            return Err(EditError::Invalid("errors.editorSpatial.chooseAFiniteIkPolePosition".into()));
        }
        let Some(context) = self.spatial_context()? else { return Ok(false) };
        let p = context.unproject_at([x, y], depth);
        let v = [p[0] - pole.center[0], p[1] - pole.center[1], depth - pole.center[2]];
        let n = norm(&v);
        if n < 1e-6 {
            return Ok(false);
        }
        let mut patch = Obj::new();
        patch.set("pole", Value::nums(&v.map(|x| x / n)));
        patch.set("swivel", Value::Num(0.0));
        self.set_spatial_ik_target(&Value::object(patch))
    }

    /// `setSpatialIKTarget(patch)`: a 3D target's depth, pole or swivel.
    pub(crate) fn set_spatial_ik_target(&mut self, patch: &Value) -> Result<bool, EditError> {
        let Some((slot, object)) = self.object()? else { return Ok(false) };
        if self.selection.joint < 0 {
            return Ok(false);
        }
        let figures = self.report.get("figure_types").and_then(Value::elements).map(|e| e.iter().collect::<Vec<_>>()).unwrap_or_default();
        let figure_value = figures.iter().find(|f| f.get("figure_type_id") == object.get("figure_type_id")).cloned().unwrap_or(Value::Null);
        let Some(handle) = figure_value.get("segments").and_then(|s| s.item(self.selection.joint as usize)).and_then(|s| s.get("segment_id").and_then(Value::as_f64)) else { return Ok(false) };
        let handle = handle as u32;
        let key = handle.to_string();
        let c = object.path(&["_stykIK", &key]).cloned().unwrap_or(Value::Null);
        let truthy = |k: &str| c.get(k).is_some_and(Value::truthy);
        if !truthy("enabled") || !truthy("spatialTarget") || c.get("bendDirection").and_then(Value::as_f64) != Some(0.0) {
            return Ok(false);
        }
        let mut entries: Vec<(String, Value)> = Vec::new();
        for (k, v) in patch.as_obj().map(|o| o.iter().map(|(k, v)| (k.to_string(), v.clone())).collect::<Vec<_>>()).unwrap_or_default() {
            if k == "pole" {
                let unit = v.numbers().filter(|n| n.len() == 3 && n.iter().all(|x| x.is_finite())).is_some_and(|n| (norm(&n) - 1.0).abs() <= 1e-5);
                if !unit {
                    return Err(EditError::Invalid("errors.editorSpatial.chooseAUnitIkPoleDirection".into()));
                }
            } else if !["depth", "swivel"].contains(&k.as_str()) || !v.as_f64().is_some_and(|n| n.is_finite() && n.abs() <= 1e6) {
                return Err(EditError::Invalid("errors.editorSpatial.chooseAFiniteSpatialIkAdjustment".into()));
            }
            entries.push((k, v));
        }
        let pole = entries.iter().any(|(k, _)| k == "pole");
        let depth = entries.iter().find(|(k, _)| k == "depth").and_then(|(_, v)| v.as_f64());
        let pinned = truthy("pinned");
        let controller = ik::parse::table(object.get("_stykIK")).and_then(|t| t.get(handle).cloned()).ok_or_else(|| EditError::Unported("adjusting a 3D IK target the engine cannot read".into()))?;
        self.object_edit_with(if pole { "Move IK pole" } else { "Adjust spatial IK target" }, true, |editor| {
            let context = editor.spatial_context_at(slot)?.ok_or_else(|| EditError::Unported("adjusting a 3D IK target without a 3D figure".into()))?;
            let figure = context.figure.clone();
            let skeleton = Skeleton { segments: &figure.segments, plan: &figure.plan, polygons: &figure.polyfills, sources: None };
            let uid_now = uid(&context.object).unwrap_or(0);
            // An unpinned controller captures the limb once per gesture.
            let capture = if pinned {
                None
            } else {
                let capture_key = format!("{uid_now}:{handle}");
                let cached = editor.drag.as_ref().and_then(|d| d.spatial_ik_captures.get(&capture_key).cloned());
                Some(match cached {
                    Some(capture) => capture,
                    None => {
                        let swivel = controller.spatial_target.as_ref().map_or(0.0, |s| s.swivel);
                        let capture = editor.capture_spatial(slot, &skeleton.chain(handle, controller.chain_length), &skeleton.follower_indices(handle), controller.target.rotation, swivel)?;
                        if let Some(drag) = editor.drag.as_mut() {
                            drag.spatial_ik_captures.insert(capture_key, capture.clone());
                        }
                        capture
                    }
                })
            };
            let joint = context.joint(handle);
            // `next = {...c, ...capture, target: {...c.target, ...joint}, spatialTarget: {...base, ...patch}}`
            let mut next = c.as_obj().cloned().unwrap_or_default();
            if let Some(capture) = &capture {
                if let Some(followers) = &capture.spatial_followers {
                    next.set("spatialFollowers", quaternion_table(followers));
                }
                if let Some(target) = &capture.spatial_target {
                    next.set("spatialTarget", spatial_target_value(target));
                }
            }
            let mut target = c.get("target").and_then(Value::as_obj).cloned().unwrap_or_default();
            if !pinned {
                let point = context.raw_joint(handle).unwrap_or(joint);
                target.set("x", Value::Num(point[0]));
                target.set("y", Value::Num(point[1]));
            }
            let base = capture.as_ref().and_then(|c| c.spatial_target.as_ref()).map(spatial_target_value).unwrap_or_else(|| c.get("spatialTarget").cloned().unwrap_or(Value::Null));
            let patch_entries: Vec<(&str, Value)> = entries.iter().map(|(k, v)| (k.as_str(), v.clone())).collect();
            let spatial_target = merged(&base, &patch_entries);
            if let Some(depth) = depth {
                let screen = if pinned {
                    let (tx, ty) = (c.path(&["target", "x"]).and_then(Value::as_f64).unwrap_or(f64::NAN), c.path(&["target", "y"]).and_then(Value::as_f64).unwrap_or(f64::NAN));
                    let old = c.path(&["spatialTarget", "depth"]).and_then(Value::as_f64).unwrap_or(f64::NAN);
                    context.project([tx, ty, old])
                } else {
                    joint
                };
                let point = context.unproject_at(screen, depth);
                target.set("x", Value::Num(point[0]));
                target.set("y", Value::Num(point[1]));
            }
            next.set("target", Value::object(target));
            next.set("spatialTarget", spatial_target.clone());
            if !pinned {
                // Solved with the controller pinned where it is, followers left as they are.
                let mut solving = next.clone();
                solving.set("pinned", Value::Bool(true));
                let mut table = Obj::new();
                table.set(&key, Value::object(solving));
                let parsed = ik::parse::table(Some(&Value::object(table))).ok_or_else(|| EditError::Unported("adjusting a 3D IK target the engine cannot read".into()))?;
                let record = editor.frame_objects()[slot].clone();
                let angles = record.get("angles").and_then(Value::numbers).unwrap_or_default();
                let lengths = if record.get("len_flag").is_some_and(Value::truthy) { record.get("lengths").and_then(Value::numbers) } else { None };
                let bends = if record.get("bend_flag").is_some_and(Value::truthy) { record.get("bends").and_then(Value::numbers) } else { None };
                if angles.len() < figure.segments.len() {
                    return Err(EditError::Unported("adjusting a 3D IK target of a pose without every angle".into()));
                }
                let pose = Pose {
                    scale: context.scale,
                    angles: &angles,
                    lengths: lengths.as_deref(),
                    bends: bends.as_deref(),
                    mirror: context.mirror,
                    figure_angle: context.figure_angle,
                    shape: context.shape.as_ref(),
                };
                let solved = ik::solve_object_with(&skeleton, &pose, context.root, &Table { controllers: parsed.controllers }, false).ok_or_else(|| EditError::Unported("adjusting a 3D IK target the solver did not reach".into()))?;
                let record = editor.frame_object_mut(slot).unwrap();
                record.set("angles", Value::nums(&solved.angles));
                if let Some(lengths) = &solved.lengths {
                    record.set("lengths", Value::nums(lengths));
                    record.set("len_flag", Value::Num(1.0));
                }
            }
            let record = editor.frame_object_mut(slot).unwrap();
            crate::ik::set_controller_value(record, &key, Value::object(next));
            record.remove("runtime_segments");
            Ok(())
        })
    }
}
