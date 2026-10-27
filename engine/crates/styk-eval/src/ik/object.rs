//! One skeleton's pinned controllers (`solveObjectIK` in src/ik.mjs).
//!
//! The skeleton is either a figure as it stands in the document or the
//! temporary skeleton [`joined`](super::joined) compiles from figures joined to
//! one another. The solve reads the pose and returns derived channels; it never
//! writes to the document.

use std::collections::{HashMap, HashSet};
use std::f64::consts::PI;

use styk_math::{atan2, cos, sin};

use crate::doc::{FigurePlan, Polyfill, Segment};

use super::layout::spatial_bone;
use super::rig::{authored_rig_target, RigContext, RigSources, Sample};
use super::solve::solve_points;
use super::{bend_reference, hypot, wrap, BendReference, Controller, Table, EPS};
use crate::rig::{quat_multiply, spatial_point, spatial_quaternion, Spatial};

/// The bones a solve reads (`figure` in `solveObjectIK`).
pub struct Skeleton<'a> {
    pub segments: &'a [Segment],
    /// Ids, children and breadth-first order of `segments` (`ikLayout`), and
    /// their rig plan when any bone has a rig relationship.
    pub plan: &'a FigurePlan,
    /// Polygons tie sibling branches at an endpoint into one follower group.
    pub polygons: &'a [Polyfill],
    /// For a joined skeleton with rig relationships: the figure each bone came
    /// from (`figure._rigSources`), which evaluates its own constraints.
    pub sources: Option<&'a RigSources<'a>>,
}

/// The pose channels a solve reads (`object` in `solveObjectIK`).
pub struct Pose<'a> {
    pub scale: f64,
    /// One authored angle per segment.
    pub angles: &'a [f64],
    /// Authored lengths when the pose overrides them (`len_flag`).
    pub lengths: Option<&'a [f64]>,
    /// Authored bends when the pose overrides them (`bend_flag`).
    pub bends: Option<&'a [f64]>,
    /// `image_text_flags`: the figure is mirrored.
    pub mirror: bool,
    /// `animationRotation(figure, object)`.
    pub figure_angle: f64,
    /// Part proportions of a 3D pose by bone handle (`_stykSpatial.shape`).
    pub shape: Option<&'a std::collections::BTreeMap<u32, crate::doc::SpatialShape>>,
}

impl Pose<'_> {
    /// `object.len_flag ? object.lengths[i] : segment.length`.
    pub(crate) fn length(&self, i: usize, segment: &Segment) -> f64 {
        match self.lengths {
            Some(lengths) => lengths.get(i).copied().unwrap_or(segment.length),
            None => segment.length,
        }
    }

    /// `object.bend_flag ? object.bends[i] : segment.bend_rad ?? 0`.
    pub(crate) fn bend(&self, i: usize, segment: &Segment) -> f64 {
        match self.bends {
            Some(bends) => bends.get(i).copied().unwrap_or(0.0),
            None => segment.bend,
        }
    }
}

/// What happened to one controller (`results.get(handle)`).
#[derive(Clone, Debug, PartialEq)]
pub struct Outcome {
    /// The chain shares a bone with a controller solved before it: left as posed.
    pub conflict: bool,
    pub iterations: u32,
    /// Distance left between the endpoint and its target.
    pub error: f64,
    /// Length factor applied to the chain (1 unless the target was out of reach).
    pub stretch: f64,
    /// Segment indices of the chain, base first.
    pub chain: Vec<usize>,
    /// Continuity reference of an automatic bend after the solve.
    pub bend_reference: Option<BendReference>,
}

/// Derived channels of one skeleton: what geometry draws instead of the
/// authored angles (and lengths, when a chain stretched).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Solution {
    /// One angle per segment (authored where no controller reached).
    pub angles: Vec<f64>,
    /// Unscaled lengths per segment, present once any chain stretched.
    pub lengths: Option<Vec<f64>>,
    /// Per controller handle, in solve order.
    pub results: Vec<(u32, Outcome)>,
}

/// Joint positions by segment index (`points` keyed by handle id; 0 is the root).
#[derive(Clone, Debug)]
pub(crate) struct Points {
    pub root: [f64; 2],
    pub at: Vec<Option<[f64; 2]>>,
}

impl Points {
    pub fn new(root: [f64; 2], count: usize) -> Points {
        Points { root, at: vec![None; count] }
    }

    /// `points.get(id)`.
    pub fn get(&self, skeleton: &Skeleton, id: u32) -> Option<[f64; 2]> {
        if id == 0 {
            return Some(self.root);
        }
        skeleton.index(id).and_then(|i| self.at[i])
    }
}

const NAN: [f64; 2] = [f64::NAN, f64::NAN];

/// `chord(figure, object, i, lengths)`: a bone's bend and the signed straight
/// distance between its ends.
fn chord(skeleton: &Skeleton, pose: &Pose, i: usize, lengths: Option<&[f64]>) -> (f64, f64) {
    let s = &skeleton.segments[i];
    let bend = pose.bend(i, s);
    let length = lengths.map(|l| l[i]).unwrap_or_else(|| pose.length(i, s)) * pose.scale;
    (bend, length * if bend.abs() < EPS { 1.0 } else { 2.0 * sin(bend / 2.0) / bend })
}

/// `solveObjectIK(figure, object, root, layout, controllers)`.
///
/// Returns `None` when no enabled, pinned controller ends at a handle of the
/// skeleton. Disjoint chains may share a base; of overlapping chains the one
/// nearer the root (then the lower handle) wins and the other reports a conflict.
pub fn solve_object(skeleton: &Skeleton, pose: &Pose, root: [f64; 2], controllers: &Table) -> Option<Solution> {
    solve_object_with(skeleton, pose, root, controllers, true)
}

/// [`solve_object`] with `followTargetOrientation`: when false, the outgoing branches keep
/// their own angles instead of the target's orientation (a 3D target posed while unpinned).
pub fn solve_object_with(skeleton: &Skeleton, pose: &Pose, root: [f64; 2], controllers: &Table, follow: bool) -> Option<Solution> {
    let segments = skeleton.segments;
    let mut active: Vec<(u32, &Controller)> =
        controllers.controllers.iter().filter(|(id, c)| c.active() && skeleton.index(**id).is_some()).map(|(id, c)| (*id, c)).collect();
    if active.is_empty() {
        return None;
    }
    let mut angles: Vec<f64> = pose.angles.to_vec();
    let mut lengths: Option<Vec<f64>> = None;
    let mut points = Points::new(root, segments.len());
    let mut results: Vec<(u32, Outcome)> = Vec::new();
    let mut claimed: HashSet<usize> = HashSet::new();
    let forward = |points: &mut Points, angles: &[f64], lengths: Option<&[f64]>, i: usize| {
        let s = &segments[i];
        let p = points.get(skeleton, s.parent).unwrap_or(root);
        let (bend, signed) = chord(skeleton, pose, i, lengths);
        let a = angles[i] + bend / 2.0;
        points.at[i] = Some([p[0] + cos(a) * signed, p[1] + sin(a) * signed]);
    };
    let rig = skeleton.plan.rig.as_deref().map(|plan| {
        let handles = active.iter().flat_map(|(id, c)| std::iter::once(*id).chain(c.spatial_followers.iter().flat_map(|table| table.keys().copied())));
        RigContext::new(skeleton, pose, root, handles, plan)
    });
    let refresh = |rig: &RigContext, points: &mut Points, angles: &[f64], lengths: Option<&[f64]>| -> Sample {
        let sample = rig.evaluate(angles, lengths);
        for (i, p) in sample.points.at.iter().enumerate() {
            if p.is_some() {
                points.at[i] = *p;
            }
        }
        sample
    };
    let mut rig_sample: Option<Sample> = rig.as_ref().map(|rig| refresh(rig, &mut points, &angles, None));
    if rig.is_none() {
        for &i in &skeleton.plan.order {
            forward(&mut points, &angles, None, i as usize);
        }
    }
    let chains: HashMap<u32, Vec<usize>> = active.iter().map(|(id, c)| (*id, skeleton.chain(*id, c.chain_length))).collect();
    if active.len() > 1 {
        // Ancestor chains first, then handle order. A stable insertion sort with
        // the JavaScript comparator: a chain without a rank compares by handle.
        let mut rank = vec![f64::NAN; segments.len()];
        for (order, &i) in skeleton.plan.order.iter().enumerate() {
            rank[i as usize] = order as f64;
        }
        let key = |id: u32| chains[&id].first().map(|&i| rank[i]).unwrap_or(f64::NAN);
        let before = |a: u32, b: u32| {
            let by_rank = key(a) - key(b);
            (if by_rank != 0.0 && !by_rank.is_nan() { by_rank } else { a as f64 - b as f64 }) < 0.0
        };
        for at in 1..active.len() {
            let mut k = at;
            while k > 0 && before(active[k].0, active[k - 1].0) {
                active.swap(k, k - 1);
                k -= 1;
            }
        }
    }
    for (id, c) in active {
        let chain = &chains[&id];
        if chain.is_empty() || chain.iter().any(|i| claimed.contains(i)) {
            results.push((id, Outcome { conflict: true, iterations: 0, error: 0.0, stretch: 1.0, chain: chain.clone(), bend_reference: None }));
            continue;
        }
        claimed.extend(chain.iter().copied());
        let target = [c.target.x, c.target.y];
        let first = chain[0];
        let last = chain[chain.len() - 1];
        let state_start = |sample: &Option<Sample>, i: usize| sample.as_ref().and_then(|s| s.states[i]).map(|s| s.start);
        let base = state_start(&rig_sample, first).or_else(|| points.get(skeleton, segments[first].parent)).unwrap_or(root);
        let mut positions: Vec<[f64; 2]> = std::iter::once(base).chain(chain.iter().map(|&i| points.at[i].unwrap_or(NAN))).collect();
        // (bend, signed span) per chain bone. Rigged bones use their evaluated span.
        let mut chords: Vec<(f64, f64)> = chain
            .iter()
            .map(|&i| {
                if rig.is_some() && !spatial_bone(&segments[i]) {
                    let p = points.at[i].unwrap_or(NAN);
                    let start = state_start(&rig_sample, i).unwrap_or(root);
                    (0.0, hypot(p[0] - start[0], p[1] - start[1]))
                } else {
                    chord(skeleton, pose, i, lengths.as_deref())
                }
            })
            .collect();
        let reach = chords.iter().fold(0.0, |sum, c| sum + c.1.abs());
        let distance = hypot(target[0] - base[0], target[1] - base[1]);
        let spatial_distance = match (&c.spatial_target, &rig_sample) {
            (Some(spatial), Some(sample)) if c.bend_direction == 0.0 && skeleton.sources.is_none() => {
                let depth = match (sample.states[first].and_then(|s| s.spatial), segments[first].rig.as_ref().and_then(|r| r.spatial.as_ref())) {
                    (Some(frame), Some(Spatial::Bone { origin, .. })) => spatial_point(&frame, *origin)[2],
                    _ => 0.0,
                };
                hypot(distance, spatial.depth - depth * pose.scale)
            }
            _ => distance,
        };
        let stretch = if c.allow_stretch && reach > EPS { 1f64.max(spatial_distance / reach) } else { 1.0 };
        if stretch > 1.0 {
            let lengths = lengths.get_or_insert_with(|| segments.iter().enumerate().map(|(i, s)| pose.length(i, s)).collect());
            for (j, &i) in chain.iter().enumerate() {
                lengths[i] *= stretch;
                chords[j].1 *= stretch;
            }
        }
        let spans: Vec<f64> = chords.iter().map(|c| c.1.abs()).collect();
        let mut result = solve_points(&mut positions, &spans, target, c.bend_direction, c.bend_reference.as_ref());
        // Angle change per segment index, inherited by everything below the chain.
        let mut deltas: HashMap<usize, f64> = HashMap::new();
        let original: Vec<f64> = chain.iter().map(|&i| angles[i]).collect();
        for (j, &i) in chain.iter().enumerate() {
            let (bend, signed) = chords[j];
            if signed.abs() < EPS || spatial_bone(&segments[i]) {
                continue;
            }
            let (dx, dy) = (positions[j + 1][0] - positions[j][0], positions[j + 1][1] - positions[j][1]);
            let mut a = atan2(dy, dx) - bend / 2.0 - if signed < 0.0 { PI } else { 0.0 };
            if let Some(state) = rig_sample.as_ref().and_then(|s| s.states[i]) {
                // The solved direction is in rendered space: invert the joint's
                // derived local space to find the authored angle that draws it.
                if state.space.and_then(|s| s.follow).map(|f| f.1).unwrap_or(1.0).abs() < 1e-8 && state.bend.abs() > 1e-7 {
                    a = angles[i];
                } else {
                    let length = lengths.as_ref().map(|l| l[i]).unwrap_or_else(|| pose.length(i, &segments[i])) * pose.scale;
                    // Same association as the JavaScript: (start + next) - previous.
                    let aim = [state.start[0] + positions[j + 1][0] - positions[j][0], state.start[1] + positions[j + 1][1] - positions[j][1]];
                    let authored = authored_rig_target(state.start, state.space, state.bend, aim, angles[i], length);
                    a = atan2(authored[1] - state.start[1], authored[0] - state.start[0]) - state.bend / 2.0 - if pose.scale < 0.0 { PI } else { 0.0 };
                }
            }
            let delta = wrap(a - angles[i]);
            angles[i] += delta;
            deltas.insert(i, delta);
        }
        if let Some(rig) = &rig {
            if c.bend_direction != 0.0
                && chain.len() == 2
                && chain.iter().all(|&i| spatial_bone(&segments[i]))
                && let Some(sample) = &rig_sample
            {
                let start = sample.states[first].map(|s| s.start).unwrap_or(NAN);
                let middle = sample.points.at[first].unwrap_or(NAN);
                let end = sample.points.at[last].unwrap_or(NAN);
                let side = (end[0] - start[0]) * (middle[1] - start[1]) - (end[1] - start[1]) * (middle[0] - start[0]);
                if side * c.bend_direction < 1e-7 {
                    rig.refine(&mut angles, lengths.as_deref(), &chain[..1], positions[1]);
                }
            }
            let settings = if c.bend_direction == 0.0 { c.spatial_target.as_ref() } else { None };
            let refined = match rig.solve_spatial(&mut angles, lengths.as_deref(), chain, target, settings) {
                Some(refined) => refined,
                None => rig.refine(&mut angles, lengths.as_deref(), chain, target),
            };
            result.error = refined.error;
            result.iterations += refined.iterations;
            for (j, &i) in chain.iter().enumerate() {
                deltas.insert(i, wrap(angles[i] - original[j]));
            }
            let sample = refined.sample;
            let posed: Vec<[f64; 2]> = std::iter::once(sample.states[first].map(|s| s.start).or_else(|| sample.points.get(skeleton, segments[first].parent)).unwrap_or(root))
                .chain(chain.iter().map(|&i| sample.points.at[i].unwrap_or(NAN)))
                .collect();
            let spans: Vec<f64> = posed.windows(2).map(|w| hypot(w[1][0] - w[0][0], w[1][1] - w[0][1])).collect();
            result.bend_reference = Some(bend_reference(&posed, &spans, c.bend_reference.as_ref()));
            rig_sample = Some(sample);
        }
        // Only the next articulated group follows the target. Construction artwork
        // attached to the constrained bone keeps inheriting its solved rotation.
        let followers = if follow { skeleton.followers(pose.angles, id, c) } else { HashMap::new() };
        let attachments = if follow { skeleton.attachments(pose.angles, id, c, &followers) } else { HashMap::new() };
        let chain_set: HashSet<usize> = chain.iter().copied().collect();
        let mut affected: Vec<usize> = chain.clone();
        let mut visited: HashSet<usize> = chain_set.clone();
        let mut q = 0;
        while q < affected.len() {
            let i = affected[q];
            let s = &segments[i];
            if !chain_set.contains(&i) {
                let delta = if let Some(follower) = followers.get(&s.id).filter(|a| a.is_finite()) {
                    Some(wrap(c.target.rotation + follower - angles[i]))
                } else if let Some(offset) = attachments.get(&s.id).filter(|a| a.is_finite()) {
                    Some(wrap(angles[last] + offset - angles[i]))
                } else {
                    skeleton.index(s.parent).and_then(|parent| deltas.get(&parent).copied())
                };
                if let Some(delta) = delta {
                    angles[i] += delta;
                    deltas.insert(i, delta);
                }
            }
            if rig.is_none() {
                forward(&mut points, &angles, lengths.as_deref(), i);
            }
            for &child in skeleton.children(i) {
                if visited.insert(child as usize) {
                    affected.push(child as usize);
                }
            }
            q += 1;
        }
        if let Some(rig) = &rig {
            for (&child, q) in c.spatial_followers.iter().flatten().filter(|_| follow) {
                let Some(i) = skeleton.index(child).filter(|&i| spatial_bone(&segments[i])) else { continue };
                let mut descendants: Vec<usize> = Vec::new();
                let mut queue: Vec<usize> = skeleton.children(i).iter().map(|&k| k as usize).collect();
                let mut j = 0;
                while j < queue.len() {
                    descendants.push(queue[j]);
                    queue.extend(skeleton.children(queue[j]).iter().map(|&k| k as usize));
                    j += 1;
                }
                rig.orient_world(&mut angles, lengths.as_deref(), i, quat_multiply(spatial_quaternion(c.target.rotation, 0.0, 0.0), *q), &descendants);
            }
            rig_sample = Some(refresh(rig, &mut points, &angles, lengths.as_deref()));
        }
        results.push((id, Outcome { conflict: false, iterations: result.iterations, error: result.error, stretch, chain: chain.clone(), bend_reference: result.bend_reference }));
    }
    Some(Solution { angles, lengths, results })
}
