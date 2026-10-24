//! The projection adapter between IK and rig relationships (`rigIKContext` in
//! src/ik-rig.mjs) and the inverse of a rig joint's local space
//! (`authoredRigTarget` in src/rig-constraints.mjs).
//!
//! A rigged bone is not drawn where its authored angle points: stretch, follow
//! and spatial relationships derive its rendered position. The solver therefore
//! evaluates the rig for candidate angles and corrects them until the endpoint
//! reaches its target. Only the joints the driven bones depend on take part.

use std::collections::HashMap;
use std::sync::Arc;

use styk_math::{cos, sin};

use crate::doc::{Figure, Object};
use crate::rig::{quat_multiply, spatial_point, Context, Input, RigPlan, Space, Spatial, State};

use super::layout::spatial_bone;
use super::object::{Points, Pose, Skeleton};
use super::spatial::{between_vectors, inverse_quaternion, quaternion_pose, spatial_ik_orientation, spatial_knee, spatial_world_quaternion, spatial_world_vector, Euler};
use super::{figure_angle, hypot, norm, SpatialTarget};

/// One figure of a joined skeleton (`group` in `joinedIKGraph`): its own
/// constraints evaluate in its own scale and placement.
pub struct RigGroup<'a> {
    pub figure: &'a Figure,
    pub object: &'a Object,
    /// Segment id in the figure → id in the joined skeleton.
    pub ids: HashMap<u32, u32>,
    /// Id in the joined skeleton of the joint this figure hangs from (0 = root).
    pub root_id: u32,
    /// The figure's rig plan (trivial when it has no rig relationships).
    pub plan: Arc<RigPlan>,
}

/// `figure._rigSources` of a joined skeleton.
pub struct RigSources<'a> {
    pub groups: Vec<RigGroup<'a>>,
    /// Per joined segment: its group and its index in that group's figure.
    pub of: Vec<(u32, u32)>,
}

/// The plan of a figure without rig relationships: every joint is plain.
pub(crate) fn plain_plan(count: usize) -> RigPlan {
    RigPlan { order: (0..count as u32).collect(), inputs: vec![None; count], dependencies: vec![Vec::new(); count] }
}

struct GroupSample {
    ready: bool,
    origin: [f64; 2],
    states: Vec<Option<State>>,
}

/// One evaluation of the driven joints (`{points, states}` of `evaluate()`).
pub(crate) struct Sample {
    pub points: Points,
    pub states: Vec<Option<State>>,
    groups: Vec<GroupSample>,
}

/// `{sample, error, iterations}` of `refine` and `solveSpatial`.
pub(crate) struct Refined {
    pub sample: Sample,
    pub error: f64,
    pub iterations: u32,
}

/// `rigIKContext(figure, object, root, handles, angles, lengths, plan)`.
pub(crate) struct RigContext<'a> {
    skeleton: &'a Skeleton<'a>,
    pose: &'a Pose<'a>,
    root: [f64; 2],
    /// The joints the driven handles depend on, in plan order.
    order: Vec<usize>,
}

const NAN: [f64; 2] = [f64::NAN, f64::NAN];

impl<'a> RigContext<'a> {
    pub fn new(skeleton: &'a Skeleton<'a>, pose: &'a Pose<'a>, root: [f64; 2], handles: impl Iterator<Item = u32>, plan: &'a RigPlan) -> RigContext<'a> {
        let mut needed = vec![false; skeleton.segments.len()];
        let mut queue: Vec<usize> = handles.filter_map(|id| skeleton.index(id)).collect();
        let mut q = 0;
        while q < queue.len() {
            let i = queue[q];
            q += 1;
            if needed[i] {
                continue;
            }
            needed[i] = true;
            queue.extend(plan.dependencies[i].iter().map(|&d| d as usize));
        }
        let order = plan.order.iter().map(|&i| i as usize).filter(|&i| needed[i]).collect();
        RigContext { skeleton, pose, root, order }
    }

    fn blank(&self) -> Sample {
        let groups = match self.skeleton.sources {
            Some(sources) => sources.groups.iter().map(|g| GroupSample { ready: false, origin: self.root, states: vec![None; g.figure.segments.len()] }).collect(),
            None => Vec::new(),
        };
        Sample { points: Points::new(self.root, self.skeleton.segments.len()), states: vec![None; self.skeleton.segments.len()], groups }
    }

    /// `evaluate()`: positions and rig states of the driven joints for `angles`.
    pub fn evaluate(&self, angles: &[f64], lengths: Option<&[f64]>) -> Sample {
        let mut sample = self.blank();
        self.evaluate_into(angles, lengths, &mut sample);
        sample
    }

    /// `evaluate()` into a sample this context produced before: every call
    /// writes the same joints, so nothing needs clearing in between.
    fn evaluate_into(&self, angles: &[f64], lengths: Option<&[f64]>, sample: &mut Sample) {
        let skeleton = self.skeleton;
        let pose = self.pose;
        let root = self.root;
        let Sample { points, states, groups } = sample;
        for group in groups.iter_mut() {
            group.ready = false;
        }
        for &i in &self.order {
            let s = &skeleton.segments[i];
            let start = points.get(skeleton, s.parent).unwrap_or(root);
            let bend = pose.bend(i, s);
            let length = lengths.map(|l| l[i]).unwrap_or_else(|| pose.length(i, s)) * pose.scale;
            let input = Input { start, angle: angles[i], length, bend };
            let p = match skeleton.sources {
                Some(sources) => {
                    let (g, index) = sources.of[i];
                    let group = &sources.groups[g as usize];
                    let scratch = &mut groups[g as usize];
                    if !scratch.ready {
                        scratch.ready = true;
                        scratch.origin = points.get(skeleton, group.root_id).unwrap_or(root);
                    }
                    let context = Context {
                        segments: &group.figure.segments,
                        index_of: &group.figure.plan.index_of,
                        plan: &group.plan,
                        root: scratch.origin,
                        scale: group.object.scale,
                        figure_angle: figure_angle(group.figure, group.object),
                        mirror: group.object.image_text_flags,
                        len_flag: group.object.lengths.is_some(),
                        lengths: group.object.lengths.as_deref(),
                        // Inverse kinematics solves before perspective (`project: false`).
                        camera: None,
                        shape: group.object.spatial.as_ref().and_then(|s| s.shape.as_ref()),
                    };
                    let joint = |id: u32| points.get(skeleton, if id != 0 { *group.ids.get(&id)? } else { group.root_id });
                    let p = crate::rig::evaluate(&context, &mut scratch.states, index as usize, input, &joint);
                    states[i] = Some(p);
                    p
                }
                None => {
                    let context = Context {
                        segments: skeleton.segments,
                        index_of: &skeleton.plan.index_of,
                        plan: skeleton.plan.rig.as_deref().expect("a rig context needs a rig plan"),
                        root,
                        scale: pose.scale,
                        figure_angle: pose.figure_angle,
                        mirror: pose.mirror,
                        len_flag: pose.lengths.is_some(),
                        lengths: pose.lengths,
                        camera: None,
                        shape: pose.shape,
                    };
                    let joint = |id: u32| points.get(skeleton, id);
                    crate::rig::evaluate(&context, states, i, input, &joint)
                }
            };
            let b = p.bend;
            let span = p.length * if b.abs() < 1e-8 { 1.0 } else { 2.0 * sin(b / 2.0) / b };
            let a = p.angle + b / 2.0;
            points.at[i] = Some(p.handle.unwrap_or([p.start[0] + cos(a) * span, p.start[1] + sin(a) * span]));
        }
    }

    /// `refine(chain, target)`: damped least squares on the chain's authored
    /// angles (and the turn and tilt controls of spatial bones) until the
    /// rendered endpoint reaches `target`. At most 40 steps, each halving its
    /// step up to three times; a straight limb pulled inward explores bounded
    /// null-space bends instead of stalling.
    pub fn refine(&self, angles: &mut [f64], lengths: Option<&[f64]>, chain: &[usize], target: [f64; 2]) -> Refined {
        const ITERATIONS: u32 = 40;
        const TOLERANCE: f64 = 1e-4;
        let segments = self.skeleton.segments;
        let endpoint = chain[chain.len() - 1];
        let mut variables: Vec<usize> = Vec::new();
        for &i in chain {
            let mut add = |index: Option<usize>| {
                if let Some(index) = index
                    && !variables.contains(&index)
                {
                    variables.push(index);
                }
            };
            add(Some(i));
            if let Some(Spatial::Bone { turn, pitch, .. }) = segments[i].rig.as_ref().and_then(|r| r.spatial.as_ref()) {
                add(self.skeleton.index(*turn));
                add(self.skeleton.index(*pitch));
            }
        }
        let at = |sample: &Sample| sample.points.at[endpoint].unwrap_or(NAN);
        let mut sample = self.evaluate(angles, lengths);
        let mut scratch = self.blank();
        let mut p = at(&sample);
        let mut error = hypot(target[0] - p[0], target[1] - p[1]);
        let mut used = 0;
        while used < ITERATIONS && error > TOLERANCE {
            let (dx, dy) = (target[0] - p[0], target[1] - p[1]);
            let mut jacobian: Vec<[f64; 2]> = Vec::with_capacity(variables.len());
            let (mut xx, mut xy, mut yy) = (1e-5, 0.0, 1e-5);
            for &i in &variables {
                let angle = angles[i];
                let step = 1e-4;
                angles[i] = angle + step;
                self.evaluate_into(angles, lengths, &mut scratch);
                let plus = at(&scratch);
                angles[i] = angle - step;
                self.evaluate_into(angles, lengths, &mut scratch);
                let minus = at(&scratch);
                angles[i] = angle;
                let (x, y) = ((plus[0] - minus[0]) / (2.0 * step), (plus[1] - minus[1]) / (2.0 * step));
                jacobian.push([x, y]);
                xx += x * x;
                xy += x * y;
                yy += y * y;
            }
            let determinant = xx * yy - xy * xy;
            if !determinant.is_finite() || determinant < 1e-14 {
                break;
            }
            let (ux, uy) = ((yy * dx - xy * dy) / determinant, (xx * dy - xy * dx) / determinant);
            let delta: Vec<f64> = jacobian.iter().map(|[x, y]| (-0.35f64).max(0.35f64.min(x * ux + y * uy))).collect();
            let baseline: Vec<f64> = variables.iter().map(|&i| angles[i]).collect();
            let mut accepted = false;
            for factor in [1.0, 0.5, 0.25, 0.125] {
                for (j, &i) in variables.iter().enumerate() {
                    angles[i] = baseline[j] + factor * delta[j];
                }
                self.evaluate_into(angles, lengths, &mut scratch);
                let point = at(&scratch);
                let distance = hypot(target[0] - point[0], target[1] - point[1]);
                if distance < error - 1e-9 {
                    std::mem::swap(&mut sample, &mut scratch);
                    p = point;
                    error = distance;
                    accepted = true;
                    break;
                }
            }
            if !accepted {
                for (j, &i) in variables.iter().enumerate() {
                    angles[i] = baseline[j];
                }
                // A straight limb pulled inward has zero first-order shortening.
                // Explore bounded null-space bends, preserving the endpoint's
                // tangent direction, instead of stalling or flipping the knee.
                if variables.len() > chain.len() {
                    'directions: for j in 0..variables.len() {
                        let [x, y] = jacobian[j];
                        let (vx, vy) = ((yy * x - xy * y) / determinant, (xx * y - xy * x) / determinant);
                        let direction: Vec<f64> = jacobian.iter().enumerate().map(|(k, [a, b])| (if k == j { 1.0 } else { 0.0 }) - a * vx - b * vy).collect();
                        // `Math.max(...)`: NaN if any entry is NaN.
                        let size = direction.iter().fold(f64::NEG_INFINITY, |m, v| if m.is_nan() || v.is_nan() { f64::NAN } else { m.max(v.abs()) });
                        if size < 1e-5 {
                            continue;
                        }
                        for sign in [1.0, -1.0] {
                            for (k, &i) in variables.iter().enumerate() {
                                angles[i] = baseline[k] + direction[k] / size * 0.18 * sign;
                            }
                            self.evaluate_into(angles, lengths, &mut scratch);
                            let point = at(&scratch);
                            let distance = hypot(target[0] - point[0], target[1] - point[1]);
                            if distance < error - 1e-7 {
                                std::mem::swap(&mut sample, &mut scratch);
                                p = point;
                                error = distance;
                                accepted = true;
                                break 'directions;
                            }
                        }
                    }
                }
                if !accepted {
                    for (j, &i) in variables.iter().enumerate() {
                        angles[i] = baseline[j];
                    }
                    break;
                }
            }
            used += 1;
        }
        Refined { sample, error, iterations: used }
    }

    /// The source figure and pose of a joined bone, or the skeleton's own.
    fn frame_of(&self, i: usize) -> (f64, bool) {
        match self.skeleton.sources {
            Some(sources) => {
                let group = &sources.groups[sources.of[i].0 as usize];
                (figure_angle(group.figure, group.object), group.object.image_text_flags)
            }
            None => (self.pose.figure_angle, self.pose.mirror),
        }
    }

    /// `setOrientation(i, q, sample, descendants)`: write the bend, turn and
    /// tilt channels that give spatial bone `i` the orientation `q` (in the
    /// figure's frame), carrying `descendants` by the same bend.
    fn set_orientation(&self, angles: &mut [f64], i: usize, q: [f64; 4], sample: &Sample, descendants: &[usize]) {
        let skeleton = self.skeleton;
        let Some(Spatial::Bone { parent, turn, pitch, .. }) = skeleton.segments[i].rig.as_ref().and_then(|r| r.spatial.as_ref()) else { return };
        // A joined bone names its parent in its own figure's ids.
        let parent_index = match skeleton.sources {
            Some(sources) => {
                let (g, index) = sources.of[i];
                let group = &sources.groups[g as usize];
                match group.figure.segments[index as usize].rig.as_ref().and_then(|r| r.spatial.as_ref()) {
                    Some(Spatial::Bone { parent, .. }) if *parent != 0 => group.ids.get(parent).and_then(|&id| skeleton.index(id)),
                    _ => None,
                }
            }
            None if *parent != 0 => skeleton.index(*parent),
            None => None,
        };
        let parent_frame = parent_index.and_then(|k| sample.states[k]).and_then(|s| s.spatial);
        let Some(frame) = sample.states[i].and_then(|s| s.spatial) else { return };
        let (Some(turn), Some(pitch)) = (skeleton.index(*turn), skeleton.index(*pitch)) else { return };
        let (angle, mirror) = self.frame_of(i);
        let sign = if mirror { -1.0 } else { 1.0 };
        let local = quat_multiply(inverse_quaternion(parent_frame.map(|f| f.q).unwrap_or([0.0, 0.0, 0.0, 1.0])), q);
        let previous = Euler {
            bend: frame.native_bend - parent_frame.map(|f| f.native_bend).unwrap_or(0.0),
            turn: (angles[turn] - angle) * sign - skeleton.segments[turn].angle,
            pitch: (angles[pitch] - angle) * sign - skeleton.segments[pitch].angle,
        };
        let pose = quaternion_pose(local, previous);
        let delta = (pose.bend - previous.bend) * sign;
        angles[i] += delta;
        angles[turn] = angle + (pose.turn + skeleton.segments[turn].angle) * sign;
        angles[pitch] = angle + (pose.pitch + skeleton.segments[pitch].angle) * sign;
        for &child in descendants {
            angles[child] += delta;
        }
    }

    /// `orientWorld(i, q, descendants)`: give spatial bone `i` the scene-space
    /// orientation `q`.
    pub fn orient_world(&self, angles: &mut [f64], lengths: Option<&[f64]>, i: usize, q: [f64; 4], descendants: &[usize]) {
        let (angle, mirror) = self.frame_of(i);
        let sample = self.evaluate(angles, lengths);
        self.set_orientation(angles, i, spatial_world_quaternion(q, angle, mirror, true), &sample, descendants);
    }

    /// `solveSpatial(chain, target, settings)`: the analytic solution of a
    /// two-bone spatial limb with a 3D target. `None` when it does not apply
    /// (other chains, no spatial target, a joined skeleton, a collapsed bone),
    /// in which case the caller refines by projection.
    pub fn solve_spatial(&self, angles: &mut [f64], lengths: Option<&[f64]>, chain: &[usize], target: [f64; 2], settings: Option<&SpatialTarget>) -> Option<Refined> {
        let skeleton = self.skeleton;
        let pose = self.pose;
        let settings = settings?;
        if chain.len() != 2 || !chain.iter().all(|&i| spatial_bone(&skeleton.segments[i])) || pose.scale.abs() < 1e-9 {
            return None;
        }
        // Cross-figure chains keep the projection solver: each source may have
        // its own scale and placement.
        if skeleton.sources.is_some() {
            return None;
        }
        let bone = |i: usize| match skeleton.segments[i].rig.as_ref().and_then(|r| r.spatial.as_ref()) {
            Some(Spatial::Bone { origin, tip, .. }) => (*origin, *tip),
            _ => unreachable!("checked above"),
        };
        let mut sample = self.evaluate(angles, lengths);
        let (a, b) = (chain[0], chain[1]);
        let frame = |sample: &Sample, i: usize| sample.states[i].and_then(|s| s.spatial);
        let (frame_a, frame_b) = (frame(&sample, a)?, frame(&sample, b)?);
        let base = spatial_point(&frame_a, bone(a).0);
        let middle = spatial_point(&frame_a, bone(a).1);
        let end = spatial_point(&frame_b, bone(b).1);
        let aim = spatial_world_vector(
            [(target[0] - self.root[0]) / pose.scale, (target[1] - self.root[1]) / pose.scale, settings.depth / pose.scale],
            pose.figure_angle,
            pose.mirror,
            true,
        );
        let distance = |p: [f64; 3], q: [f64; 3]| norm(&[p[0] - q[0], p[1] - q[1], p[2] - q[2]]);
        let pole = spatial_world_vector(settings.pole, pose.figure_angle, pose.mirror, true);
        if distance(base, middle) < 1e-8 || distance(middle, end) < 1e-8 {
            return None;
        }
        let solved = spatial_knee(base, aim, pole, settings.swivel, distance(base, middle), distance(middle, end));
        let unit = |v: [f64; 3]| {
            let n = norm(&v);
            v.map(|x| x / n.max(1e-9))
        };
        for (j, i, tip) in [(0, a, solved.knee), (1, b, solved.end)] {
            let frame = frame(&sample, i)?;
            let (origin, rest_tip) = bone(i);
            let start = spatial_point(&frame, origin);
            let end = spatial_point(&frame, rest_tip);
            let direction = unit([tip[0] - start[0], tip[1] - start[1], tip[2] - start[2]]);
            let q = match &settings.normals {
                Some(normals) => spatial_ik_orientation(frame.axis, normals[j], direction, solved.normal),
                None => quat_multiply(between_vectors(unit([end[0] - start[0], end[1] - start[1], end[2] - start[2]]), direction), frame.q),
            };
            self.set_orientation(angles, i, q, &sample, &[]);
            sample = self.evaluate(angles, lengths);
        }
        let p = sample.points.at[b].unwrap_or(NAN);
        Some(Refined { error: hypot(p[0] - target[0], p[1] - target[1]), sample, iterations: 1 })
    }
}

/// `authoredRigTarget(shape, x, y, pose)`: the point an authored (unrigged)
/// bone must aim at so that its rig draws it toward `[x, y]`. `start`, `space`
/// and `bend` are the joint's evaluated state; `angle` and `length` its
/// authored channels (length scaled).
pub fn authored_rig_target(start: [f64; 2], space: Option<Space>, bend: f64, target: [f64; 2], angle: f64, length: f64) -> [f64; 2] {
    // The JavaScript throws for a collapsed driver; `solveObjectIK` keeps the authored
    // angle before it gets here, so the solver never sees `None`.
    authored_rig_target_with(start, space, bend, target, Some((angle, length))).unwrap_or(target)
}

/// `authoredRigTarget(shape, x, y, pose)`, `pose` being the joint's authored angle and
/// scaled length when the edge-on case may lift the pointer (a drag without stretch).
/// `None` where the JavaScript throws: a stretch driver collapsed below 1e-8.
pub fn authored_rig_target_with(start: [f64; 2], space: Option<Space>, bend: f64, target: [f64; 2], pose: Option<(f64, f64)>) -> Option<[f64; 2]> {
    let Some(space) = space else { return Some(target) };
    let (mut dx, mut dy) = (target[0] - start[0], target[1] - start[1]);
    if let Some((follow_axis, follow_scale)) = space.follow {
        let (c, s) = (cos(follow_axis), sin(follow_axis));
        let mut side = -dx * s + dy * c;
        let along = match pose {
            Some((angle, length)) if follow_scale.abs() < 1e-4 && bend.abs() < 1e-7 => {
                // An edge-on fixed-length control has lost one visible coordinate.
                // Lift the remaining one onto its authored circle, keeping the
                // nearest branch.
                let radius = length.abs();
                side = (-radius).max(radius.min(side));
                let prior = length * cos(angle + space.rotation - follow_axis);
                (if prior < 0.0 { -1.0 } else { 1.0 }) * (radius * radius - side * side).max(0.0).sqrt()
            }
            _ => {
                if follow_scale.abs() < 1e-8 {
                    return None;
                }
                (dx * c + dy * s) / follow_scale
            }
        };
        dx = along * c - side * s;
        dy = along * s + side * c;
    }
    let (c, s) = (cos(space.rotation), sin(space.rotation));
    Some([start[0] + dx * c + dy * s, start[1] - dx * s + dy * c])
}
