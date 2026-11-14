//! Where a generated effect's target is: its point, bounds, size and outline, now
//! and on earlier ticks.

use std::f64::consts::PI;
use std::sync::Arc;

use super::super::Target;
use crate::doc::Document;
use crate::eval::{Frame, Prepared};
use crate::geometry::{ItemKind, ObjectGeometry, Scene};

/// Outlines keep at most this many segments.
pub const SEGMENTS: usize = 192;

/// One target at one tick.
#[derive(Clone, Debug, PartialEq)]
pub struct Anchor {
    /// The figure's root, or the node's joint.
    pub point: [f64; 2],
    /// The middle of the outline's bounds.
    pub center: [f64; 2],
    /// The lowest point of the outline.
    pub bottom: f64,
    pub height: f64,
    /// The target's size, which its pose does not change: its two longest limbs from
    /// the root, end to end (a standing stick figure's height); the outline's height
    /// for what has no limbs. Auras are sized by it.
    pub measure: f64,
    /// The outline as `x0, y0, x1, y1` per segment, when asked for.
    pub segments: Option<Arc<[f32]>>,
}

/// An anchor on another tick, or the reason there is none yet.
#[derive(Clone, Debug)]
pub enum Sample {
    /// `None`: the target is not in the frame.
    Ready(Option<Arc<Anchor>>),
    /// The caller's time budget is spent.
    Pending,
}

/// Anchors on earlier ticks. The engine keeps them across frames; a sampler
/// evaluates the document at `tick` (rounded) and reads the target with its outline.
pub trait Sampler {
    fn sample(&self, prepared: &Prepared, target: Target, tick: f64, include_attached: bool) -> Sample;

    /// What is known of the target nearest `tick` without evaluating anything, for a
    /// sample that is [`Sample::Pending`]: the batch draws from it until the sample is ready.
    fn nearest(&self, _prepared: &Prepared, _target: Target, _tick: f64, _include_attached: bool) -> Option<Arc<Anchor>> {
        None
    }
}

/// Evaluates every sample, without a cache or a budget.
pub struct Evaluate;

impl Sampler for Evaluate {
    fn sample(&self, prepared: &Prepared, target: Target, tick: f64, include_attached: bool) -> Sample {
        Sample::Ready(sample_now(prepared, target, tick, include_attached).map(Arc::new))
    }
}

/// What a sampler computes for one sample: the target at `tick`, with its outline.
pub fn sample_now(prepared: &Prepared, target: Target, tick: f64, include_attached: bool) -> Option<Anchor> {
    let (frame, scene) = evaluate_targets(prepared, tick, &[(target, include_attached)]);
    anchor(&prepared.doc, &scene, &frame, target, true, include_attached)
}

/// The frame at a rounded tick (before the timeline, its first pose) and the geometry of
/// the objects `targets` read: each target, what it is joined to, and with `attached` what
/// is joined below it. Other objects are left unresolved.
pub fn evaluate_targets(prepared: &Prepared, tick: f64, targets: &[(Target, bool)]) -> (Frame, Scene) {
    let tick = crate::vfx::paint::js_round(tick).max(0.0);
    let frame = prepared.evaluate(tick);
    let mut slots = Vec::new();
    for &(target, attached) in targets {
        let Some(uid) = target.uid() else { continue };
        let Some(slot) = frame.objects.iter().position(|o| o.uid == uid) else { continue };
        if attached {
            slots.extend(subtree(&frame, slot));
        } else {
            slots.push(slot);
        }
    }
    slots.sort_unstable();
    slots.dedup();
    let scene = crate::geometry::build_only(&prepared.doc, &frame, &slots);
    (frame, scene)
}

/// The frame and the whole geometry at a rounded tick.
pub fn evaluate_at(prepared: &Prepared, tick: f64) -> (Frame, Scene) {
    let tick = crate::vfx::paint::js_round(tick).max(0.0);
    let frame = prepared.evaluate(tick);
    let scene = crate::geometry::build(&prepared.doc, &frame);
    (frame, scene)
}

/// The slot and every object joined below it, breadth first.
fn subtree(frame: &Frame, slot: usize) -> Vec<usize> {
    let count = frame.objects.len();
    let mut children: Vec<Vec<usize>> = vec![Vec::new(); count];
    for (child, object) in frame.objects.iter().enumerate() {
        if let Some(j) = object.join
            && (j.slot as usize) < count
            && j.slot as usize != child
        {
            children[j.slot as usize].push(child);
        }
    }
    let mut out = vec![slot];
    let mut seen = vec![false; count];
    seen[slot] = true;
    let mut i = 0;
    while i < out.len() {
        for &child in &children[out[i]] {
            if !seen[child] {
                seen[child] = true;
                out.push(child);
            }
        }
        i += 1;
    }
    out
}

/// The two longest limbs from the root of a figure, end to end: what its pose does not
/// change (lengths are posed lengths, so a figure scaled on a key is measured scaled).
fn limbs(doc: &Document, frame: &Frame, g: &ObjectGeometry, slot: usize) -> Option<f64> {
    let object = frame.objects.get(slot)?;
    let fig = match &object.figure_override {
        Some(fig) => fig,
        None => doc.figure(object.figure)?,
    };
    let n = fig.segments.len();
    if n == 0 || g.lengths.len() < n {
        return None;
    }
    let (mut chain, mut branch) = (vec![0.0f64; n], vec![usize::MAX; n]);
    for &i in &fig.plan.order {
        let i = i as usize;
        let seg = &fig.segments[i];
        let len = if g.lengths[i].is_finite() { g.lengths[i].abs() } else { 0.0 };
        match fig.plan.index_of.get(&seg.parent) {
            Some(&p) if seg.parent != 0 => {
                chain[i] = chain[p as usize] + len;
                branch[i] = branch[p as usize];
            }
            _ => {
                chain[i] = len;
                branch[i] = i;
            }
        }
    }
    let mut best: Vec<(usize, f64)> = Vec::new();
    for i in 0..n {
        match best.iter_mut().find(|(b, _)| *b == branch[i]) {
            Some(entry) => entry.1 = entry.1.max(chain[i]),
            None => best.push((branch[i], chain[i])),
        }
    }
    best.sort_by(|a, b| b.1.total_cmp(&a.1));
    let measure = best.first().map_or(0.0, |b| b.1) + best.get(1).map_or(0.0, |b| b.1);
    (measure > 0.0).then_some(measure)
}

/// The target's point (its root, or a node's joint), the bounds of its drawn segments (with
/// what is attached to it when asked), its size and, with `body`, its outline sampled to at
/// most [`SEGMENTS`] segments with their running lengths. `None` when the target is not in
/// the scene.
pub fn anchor(doc: &Document, scene: &Scene, frame: &Frame, target: Target, body: bool, include_attached: bool) -> Option<Anchor> {
    let uid = target.uid()?;
    let slot = scene.objects.iter().position(|g| g.resolved && g.uid == uid)?;
    let g = &scene.objects[slot];
    let mut point = g.root;
    if let Target::Segment { handle, figure_type, .. } = target {
        let object = frame.objects.get(slot)?;
        if figure_type.is_some_and(|t| t != object.figure) {
            return None;
        }
        let fig = match &object.figure_override {
            Some(fig) => fig,
            None => doc.figure(object.figure)?,
        };
        point = g.joint(fig, handle)?;
    }
    let members: Vec<usize> = if include_attached { subtree(frame, slot).into_iter().filter(|&s| scene.objects.get(s).is_some_and(|g| g.resolved)).collect() } else { vec![slot] };
    let mut segments: Vec<f64> = Vec::new();
    let (mut top, mut bottom, mut left, mut right) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
    let mut add = |x0: f64, y0: f64, x1: f64, y1: f64| {
        segments.extend_from_slice(&[x0, y0, x1, y1]);
        top = top.min(y0).min(y1);
        bottom = bottom.max(y0).max(y1);
        left = left.min(x0).min(x1);
        right = right.max(x0).max(x1);
    };
    let mut arc = Vec::new();
    for it in scene.items.iter().filter(|it| members.contains(&(it.slot as usize))) {
        match it.kind {
            ItemKind::Poly | ItemKind::Mesh => continue,
            ItemKind::Circle | ItemKind::CircleFill | ItemKind::CircleClear => {
                let (cx, cy, r) = ((it.start[0] + it.end[0]) / 2.0, (it.start[1] + it.end[1]) / 2.0, it.length.abs() / 2.0);
                for i in 0..8 {
                    let (a, b) = (i as f64 / 8.0 * (PI * 2.0), (i + 1) as f64 / 8.0 * (PI * 2.0));
                    add(cx + styk_math::cos(a) * r, cy + styk_math::sin(a) * r, cx + styk_math::cos(b) * r, cy + styk_math::sin(b) * r);
                }
            }
            _ => {
                let mut pts = scene.points_of(it);
                // Bent images and text keep their arc as their points, which the scene does not store.
                if pts.len() <= 2 && matches!(it.kind, ItemKind::Image | ItemKind::Text) && it.bend.abs() >= 1e-7 {
                    arc.clear();
                    crate::geometry::arc_points(it.start, it.angle, it.length, it.bend, &mut arc);
                    if let Some(last) = arc.last_mut() {
                        *last = it.end;
                    }
                    pts = &arc;
                }
                if pts.len() > 2 {
                    let step = ((pts.len() - 1) as f64 / 4.0).ceil().max(1.0) as usize;
                    let mut i = 0;
                    while i < pts.len() - 1 {
                        let j = (pts.len() - 1).min(i + step);
                        add(pts[i][0], pts[i][1], pts[j][0], pts[j][1]);
                        i += step;
                    }
                } else {
                    add(it.start[0], it.start[1], it.end[0], it.end[1]);
                }
            }
        }
    }
    if segments.is_empty() {
        top = point[1];
        bottom = point[1];
        left = point[0];
        right = point[0];
    }
    let count = segments.len() / 4;
    let data: Vec<f64> = if count > SEGMENTS {
        let stride = count as f64 / SEGMENTS as f64;
        (0..SEGMENTS)
            .flat_map(|i| {
                let j = (i as f64 * stride).floor() as usize * 4;
                [segments[j], segments[j + 1], segments[j + 2], segments[j + 3]]
            })
            .collect()
    } else {
        segments
    };
    let outline = body.then(|| data.iter().map(|&v| v as f32).collect::<Arc<[f32]>>());
    let height = bottom - top;
    let measure = limbs(doc, frame, g, slot).unwrap_or(height.max(right - left));
    Some(Anchor { point, center: [(left + right) / 2.0, (top + bottom) / 2.0], bottom, height, measure, segments: outline })
}
