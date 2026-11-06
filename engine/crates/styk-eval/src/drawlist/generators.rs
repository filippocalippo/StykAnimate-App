//! Generated effects in the draw list (docs/engine/vfx.md, Generated effects):
//! each draw of a frame's batch becomes [`K_PARTICLE`] and [`K_BEAM`] records,
//! placed before or after its target's artwork in painter order as the editor's
//! renderers place them (`generatorSchedule`, `scheduleWalker`): behind-placed draws when the target's first entry
//! begins, front-placed ones when the next entry begins, scene draws after the
//! background and after everything, draws of a target not drawn at the end.

use std::collections::HashSet;

use super::*;
use crate::vfx::generated::layers::{ARC, BEAM, CHUNK, SPRITE};
use crate::vfx::generated::{particle, Batch, Draw};
use styk_draw::{particle_kind, F_ADD, K_BEAM};

/// Every draw of a batch as records, each in its own `Out` (rows included).
pub(super) fn encode(batch: &Batch) -> (Vec<Out>, u32) {
    let mut materials = 0u32;
    let outs = batch
        .draws
        .iter()
        .map(|draw| {
            let out = draw_out(batch, draw);
            if draw.material >= 0 && !out.prims.is_empty() {
                materials |= 1 << draw.material;
            }
            out
        })
        .collect();
    (outs, materials)
}

/// Farthest reach of a drawn particle from its centre, in its local units (`particleExtent`).
fn extent(r: &[f32], shape: u8, p: &particle::Particle) -> f64 {
    let speed = styk_math::hypot(p.vx, p.vy);
    match shape {
        s if s == crate::vfx::generated::layers::RING => p.size * (1.0 + r[23] as f64 * 2.0),
        s if s == crate::vfx::generated::layers::STREAK => p.size + speed * r[22] as f64,
        s if s == SPRITE => p.size.max(p.size * r[125] as f64 + 0.5 * speed * r[22] as f64),
        s if s == crate::vfx::generated::layers::SQUARE || s == CHUNK => p.size * 1.42,
        _ => p.size * (r[125] as f64).max(1.0),
    }
}

fn draw_out(batch: &Batch, draw: &Draw) -> Out {
    let mut out = Out::new();
    let r = batch.record(draw);
    let m = batch.matrix(draw);
    let s = r[110] as f64;
    let world = |x: f64, y: f64| [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
    let rows = out.paints.len() as u32;
    out.paints.push([m[0] as f32, m[1] as f32, m[2] as f32, m[3] as f32]);
    out.paints.push([m[4] as f32, m[5] as f32, s as f32, r[114]]);
    out.paints.push([r[23], r[22], r[125], r[112]]);
    let additive = draw.blend == crate::vfx::generated::layers::ADD;
    let grow = |out: &mut Out, centre: [f64; 2], reach: f64| out.grow(centre[0] - reach, centre[1] - reach, centre[0] + reach, centre[1] + reach);
    if draw.shape == BEAM {
        let Some(beam) = particle::beam(batch, draw) else { return Out::new() };
        for x in [0.0, 1.0] {
            let c = particle::ramp(r, x);
            out.paints.push([c[0] as f32, c[1] as f32, c[2] as f32, c[3] as f32]);
        }
        let seed = (r[7] as u32 % 997) as f64;
        let reach = (beam.width * 3.5 + 8.0) * s;
        grow(&mut out, world(beam.a[0], beam.a[1]), reach);
        grow(&mut out, world(beam.b[0], beam.b[1]), reach);
        out.prims.push(prim(K_BEAM | if additive { F_ADD } else { 0 }, 0, rows, [beam.a[0], beam.a[1], beam.b[0], beam.b[1]], [beam.width, r[57] as f64, seed, beam.te], [r[26] as f64, r[112] as f64, 0.0, 0.0]));
        return out;
    }
    if draw.shape == ARC {
        for i in 0..draw.count {
            let Some(seg) = particle::arc_segment(batch, draw, i) else { continue };
            let reach = seg.radius * 5.0 * s;
            grow(&mut out, world(seg.p0[0], seg.p0[1]), reach);
            grow(&mut out, world(seg.p1[0], seg.p1[1]), reach);
            out.prims.push(prim(particle_kind(ARC as u32, additive), 0, rows, [seg.p0[0], seg.p0[1], seg.p1[0], seg.p1[1]], [seg.radius, 0.0, 0.0, 0.0], [seg.rgb[0], seg.rgb[1], seg.rgb[2], seg.alpha]));
        }
        return out;
    }
    let seed = r[7] as u32;
    let row = r[112] as i64 - 1;
    for i in 0..draw.count {
        let Some(p) = particle::evaluate(batch, draw, i) else { continue };
        let c = particle::ramp(r, p.color);
        let alpha = p.alpha * c[3];
        if alpha <= 0.0 {
            continue;
        }
        let cell = if draw.shape == SPRITE { p.variant | (row.max(0) as u32) << 8 } else { 0 };
        let h = if draw.shape == CHUNK { particle::hash(p.n, 14, seed) } else { 0.0 };
        grow(&mut out, world(p.x, p.y), (extent(r, draw.shape, &p) + 1.0) * s);
        out.prims.push(prim(particle_kind(draw.shape as u32, additive), cell, rows, [p.x, p.y, p.size, p.rotation], [p.vx, p.vy, h, 0.0], [c[0], c[1], c[2], alpha]));
    }
    if out.prims.is_empty() {
        return Out::new();
    }
    out
}

/// Which draws go before or after each target's artwork (`generatorSchedule`), and
/// where the walk through painter order is (`scheduleWalker`).
pub(super) struct Walker<'a> {
    outs: &'a [Out],
    /// By target, in the order targets first appear in the batch.
    before: Vec<(u32, Vec<usize>)>,
    after: Vec<(u32, Vec<usize>)>,
    scene_before: Vec<usize>,
    scene_after: Vec<usize>,
    started: HashSet<u32>,
    current: Option<u32>,
    begun: bool,
}

impl<'a> Walker<'a> {
    /// The schedule of `batch` without the draws of `hidden` targets.
    pub(super) fn new(batch: &Batch, outs: &'a [Out], hidden: &HashSet<u32>) -> Walker<'a> {
        let mut walker = Walker { outs, before: Vec::new(), after: Vec::new(), scene_before: Vec::new(), scene_after: Vec::new(), started: HashSet::new(), current: None, begun: false };
        for (i, draw) in batch.draws.iter().enumerate() {
            if draw.uid.is_some_and(|uid| hidden.contains(&uid)) || outs[i].prims.is_empty() {
                continue;
            }
            let behind = draw.placement == crate::vfx::generated::layers::Placement::Behind;
            if draw.scene {
                if behind { walker.scene_before.push(i) } else { walker.scene_after.push(i) }
                continue;
            }
            let uid = draw.uid.unwrap_or(u32::MAX);
            let map = if behind { &mut walker.before } else { &mut walker.after };
            match map.iter_mut().find(|(u, _)| *u == uid) {
                Some((_, list)) => list.push(i),
                None => map.push((uid, vec![i])),
            }
        }
        walker
    }

    pub(super) fn is_empty(&self) -> bool {
        self.before.is_empty() && self.after.is_empty() && self.scene_before.is_empty() && self.scene_after.is_empty()
    }

    fn emit(&self, b: &mut Builder, group: usize, list: &[usize]) {
        for &i in list {
            b.add_ref(group, &self.outs[i]);
        }
    }

    /// Scene draws placed behind the figures.
    pub(super) fn begin(&mut self, b: &mut Builder, group: usize) {
        if self.begun {
            return;
        }
        self.begun = true;
        let list = std::mem::take(&mut self.scene_before);
        self.emit(b, group, &list);
    }

    fn leave(&mut self, b: &mut Builder, group: usize) {
        if let Some(uid) = self.current.take()
            && let Some(at) = self.after.iter().position(|(u, _)| *u == uid)
        {
            let (_, list) = self.after.remove(at);
            self.emit(b, group, &list);
        }
    }

    /// A painter-order entry of `uid` begins (the editor's layout entry).
    pub(super) fn object(&mut self, b: &mut Builder, group: usize, uid: u32) {
        self.begin(b, group);
        if self.current == Some(uid) {
            return;
        }
        self.leave(b, group);
        self.current = Some(uid);
        if self.started.insert(uid)
            && let Some(at) = self.before.iter().position(|(u, _)| *u == uid)
        {
            let (_, list) = self.before.remove(at);
            self.emit(b, group, &list);
        }
    }

    /// After the last entry: draws of targets never drawn, then scene draws in front.
    pub(super) fn end(&mut self, b: &mut Builder, group: usize) {
        self.begin(b, group);
        self.leave(b, group);
        for (_, list) in std::mem::take(&mut self.before) {
            self.emit(b, group, &list);
        }
        for (_, list) in std::mem::take(&mut self.after) {
            self.emit(b, group, &list);
        }
        let list = std::mem::take(&mut self.scene_after);
        self.emit(b, group, &list);
    }
}
