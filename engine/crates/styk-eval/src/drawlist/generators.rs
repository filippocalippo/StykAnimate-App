//! Generated effects in the draw list (docs/engine/vfx.md, Generated effects):
//! each draw of a frame's batch becomes [`K_PARTICLE`] and [`K_BEAM`] records,
//! placed before or after its target's artwork in painter order: behind-placed
//! draws when the target's first entry begins, front-placed ones when the next
//! entry begins, scene draws after the background and after everything, draws of
//! a target not drawn at the end.
//!
//! Each particle is evaluated once; its trail, glow halo and outline are drawn from
//! that one evaluation (a trail's earlier places from its birth). A frame's soft
//! sprites are limited in the area they cover ([`FILL_LIMIT`]): beyond it they are
//! thinned evenly and the list says the picture was reduced.

use std::collections::HashSet;

use super::*;
use crate::vfx::generated::layers::{Placement, Spec, ADD, ARC, AUTO, BEAM, CHUNK, COLOR_STOPS, DISC, NORMAL, SPRITE};
use crate::vfx::generated::particle::{self, Evaluator, Particle};
use crate::vfx::generated::{Batch, Draw};
use styk_draw::{particle_kind, F_ADD, K_BEAM, MATERIALS_REDUCED};

/// The area a frame's particles may cover, in canvases: beyond it they are thinned evenly.
pub const FILL_LIMIT: f64 = 48.0;

/// Every draw of a batch as records, each in its own `Out` (rows included), and the material
/// rows they sample (with [`MATERIALS_REDUCED`] when a limit reduced the picture).
pub(super) fn encode(batch: &Batch) -> (Vec<Out>, u32) {
    let mut materials = if batch.reduced { MATERIALS_REDUCED } else { 0 };
    // Every live particle once, so the frame's coverage is known before anything is drawn.
    let mut alive: Vec<Vec<(u32, Particle)>> = Vec::with_capacity(batch.draws.len());
    let mut area = 0.0f64;
    for draw in &batch.draws {
        let mut list = Vec::new();
        if !batch.spec(draw).is_beam() {
            let ev = Evaluator::new(batch, draw);
            let s2 = draw.scale * draw.scale;
            for i in 0..draw.count {
                if let Some(p) = ev.particle(i) {
                    area += 4.0 * p.reach * p.reach * s2;
                    list.push((i, p));
                }
            }
        }
        alive.push(list);
    }
    let canvas = batch.draws.first().map_or(1.0, |d| (d.canvas[0] * d.canvas[1]).max(1.0));
    let fill = if area > FILL_LIMIT * canvas { FILL_LIMIT * canvas / area } else { 1.0 };
    if fill < 1.0 {
        materials |= MATERIALS_REDUCED;
    }
    let outs = batch
        .draws
        .iter()
        .zip(&alive)
        .map(|(draw, list)| {
            let out = draw_out(batch, draw, list, fill);
            if draw.material >= 0 && !out.prims.is_empty() {
                materials |= 1 << draw.material;
            }
            out
        })
        .collect();
    (outs, materials)
}

/// The colour stops a layer draws with: on a light stage, Auto layers painted solid borrow
/// their nearest saturated colour for white-hot stops, which would otherwise vanish against it.
fn ramp_of(s: &Spec, draw: &Draw, x: f64) -> [f64; 4] {
    if draw.blend == NORMAL && s.blend == AUTO
        && let Some(colors) = s.colors
    {
        let inked = Spec { colors: Some(ink_stops(colors)), ..Spec::default() };
        let mut c = particle::ramp(&Spec { opacity: s.opacity, ..inked }, NORMAL, x);
        if c[3] < 0.0 {
            c[3] = 0.0;
        }
        return c;
    }
    particle::ramp(s, draw.blend, x)
}

fn near_white(c: &[f64; 4]) -> bool {
    c[0].min(c[1]).min(c[2]) > 0.82
}

fn ink_stops(colors: [[f64; 4]; COLOR_STOPS]) -> [[f64; 4]; COLOR_STOPS] {
    if colors.iter().all(near_white) {
        return colors;
    }
    let mut out = colors;
    for i in 0..COLOR_STOPS {
        if !near_white(&colors[i]) {
            continue;
        }
        let mut best: Option<[f64; 4]> = None;
        let mut d = 1;
        while d < COLOR_STOPS && best.is_none() {
            for j in [i as i64 + d as i64, i as i64 - d as i64] {
                if j >= 0 && (j as usize) < COLOR_STOPS && !near_white(&colors[j as usize]) {
                    best = Some(colors[j as usize]);
                    break;
                }
            }
            d += 1;
        }
        let b = best.expect("some stop is not near white");
        out[i] = [b[0], b[1], b[2], colors[i][3]];
    }
    out
}

/// The three rows of a draw: transform, scale and shading, then the shape's constants.
fn rows(out: &mut Out, m: [f64; 6], scale: f64, shade: f64, softness: f64, stretch: f64, aspect: f64, row: f64) -> u32 {
    let at = out.paints.len() as u32;
    out.paints.push([m[0] as f32, m[1] as f32, m[2] as f32, m[3] as f32]);
    out.paints.push([m[4] as f32, m[5] as f32, scale as f32, shade as f32]);
    out.paints.push([softness as f32, stretch as f32, aspect as f32, row as f32]);
    at
}

fn draw_out(batch: &Batch, draw: &Draw, alive: &[(u32, Particle)], fill: f64) -> Out {
    let mut out = Out::new();
    let s = batch.spec(draw);
    let m = batch.matrix(draw);
    let scale = draw.scale;
    let world = |x: f64, y: f64| [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
    let additive = draw.blend == ADD;
    let grow = |out: &mut Out, centre: [f64; 2], reach: f64| out.grow(centre[0] - reach, centre[1] - reach, centre[0] + reach, centre[1] + reach);
    if s.shape == BEAM {
        let Some(beam) = particle::beam(batch, draw) else { return Out::new() };
        let main = rows(&mut out, m, scale, s.shade, s.softness, s.stretch, s.aspect, s.beam_style);
        for x in [0.0, 1.0] {
            let c = particle::ramp(s, draw.blend, x);
            out.paints.push([c[0] as f32, c[1] as f32, c[2] as f32, c[3] as f32]);
        }
        let seed = (draw.seed % 997) as f64;
        let reach = (beam.width * 3.5 + 8.0) * scale;
        grow(&mut out, world(beam.a[0], beam.a[1]), reach);
        grow(&mut out, world(beam.b[0], beam.b[1]), reach);
        let mut push = |width: f64, opacity: f64, style: f64| {
            out.prims.push(prim(K_BEAM | if additive { F_ADD } else { 0 }, 0, main, [beam.a[0], beam.a[1], beam.b[0], beam.b[1]], [width, s.wobble, seed, beam.te], [opacity, style, 0.0, 0.0]));
        };
        if let Some(o) = s.outline {
            push(beam.width + o.width, draw.alpha * s.alpha, 2.0);
        }
        push(beam.width, draw.alpha * s.alpha, s.beam_style);
        return out;
    }
    let main = rows(&mut out, m, scale, s.shade, s.softness, s.stretch, s.aspect, s.material.map_or(0.0, |m| (m.row + 1) as f64));
    if s.shape == ARC {
        for i in 0..draw.count {
            let Some(seg) = particle::arc_segment(batch, draw, i) else { continue };
            let reach = seg.radius * 5.0 * scale;
            grow(&mut out, world(seg.p0[0], seg.p0[1]), reach);
            grow(&mut out, world(seg.p1[0], seg.p1[1]), reach);
            out.prims.push(prim(particle_kind(ARC as u32, additive), 0, main, [seg.p0[0], seg.p0[1], seg.p1[0], seg.p1[1]], [seg.radius, 0.0, 0.0, 0.0], [seg.rgb[0], seg.rgb[1], seg.rgb[2], seg.alpha]));
        }
        return out;
    }
    let seed = draw.seed;
    let halo_rows = s.halo.map(|_| rows(&mut out, m, scale, s.shade, 2.2, s.stretch, 1.0, 0.0));
    let outline_rows = s.outline.map(|_| rows(&mut out, m, scale, 0.0, s.softness, s.stretch, s.aspect, s.material.map_or(0.0, |m| (m.row + 1) as f64)));
    let (mut trails, mut halos, mut outlines, mut mains) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    // A trail's earlier places: on twos or threes they keep the drawing's step.
    let trail = s.echoes.map(|e| (e, particle::trail_lag(e.lag, draw.step)));
    let earlier: Vec<Evaluator<'_>> = trail.map_or_else(Vec::new, |(e, lag)| (1..=e.count).map(|k| Evaluator::at(batch, draw, draw.tick - k as f64 * lag)).collect());
    let ev = Evaluator::new(batch, draw);
    for &(i, p) in alive {
        let mut alpha_scale = 1.0;
        if fill < 1.0 {
            // Thinned evenly by a chance of its own, fading near the threshold rather than popping.
            let h = particle::hash(p.n, 23, seed);
            alpha_scale = 1.0 - particle::smoothstep(fill - 0.04, fill, h);
            if alpha_scale <= 0.0 {
                continue;
            }
        }
        let ps = &*batch.specs[p.spec as usize];
        let c = ramp_of(ps, draw, p.color);
        let alpha = p.alpha * c[3] * alpha_scale;
        if alpha <= 0.0 {
            continue;
        }
        let shape = ps.shape;
        let cell = if shape == SPRITE { p.variant | (ps.material.map_or(0, |m| m.row)) << 8 } else { 0 };
        let h = if shape == CHUNK { particle::hash(p.n, 14, seed) } else { 0.0 };
        let reach = (p.reach + 1.0) * scale;
        grow(&mut out, world(p.x, p.y), reach);
        mains.push(prim(particle_kind(shape as u32, additive), cell, main, [p.x, p.y, p.size, p.rotation], [p.vx, p.vy, h, 0.0], [c[0], c[1], c[2], alpha]));
        if let (Some(hl), Some(r)) = (ps.halo, halo_rows) {
            let size = p.size * hl.scale;
            grow(&mut out, world(p.x, p.y), (size + 1.0) * scale);
            halos.push(prim(particle_kind(DISC as u32, additive), 0, r, [p.x, p.y, size, p.rotation], [p.vx, p.vy, 0.0, 0.0], [c[0], c[1], c[2], alpha * hl.alpha]));
        }
        if let (Some(o), Some(r)) = (ps.outline, outline_rows) {
            let size = p.size + o.width;
            grow(&mut out, world(p.x, p.y), (p.reach + o.width + 1.0) * scale);
            outlines.push(prim(particle_kind(shape as u32, false), cell, r, [p.x, p.y, size, p.rotation], [p.vx, p.vy, h, 0.0], [o.color[0], o.color[1], o.color[2], alpha]));
        }
        if let Some((e, _)) = trail
            && let Some(b) = ev.birth(i)
        {
            for (k, then) in earlier.iter().enumerate() {
                let Some(q) = then.at_age(&b, then.local() - b.born) else { continue };
                let k = k as f64 + 1.0;
                let tc = ramp_of(ps, draw, q.color);
                let size = q.size * fast_pow(e.size, k);
                grow(&mut out, world(q.x, q.y), (q.reach + 1.0) * scale);
                trails.push((k, prim(particle_kind(shape as u32, additive), cell, main, [q.x, q.y, size, q.rotation], [q.vx, q.vy, h, 0.0], [tc[0], tc[1], tc[2], q.alpha * tc[3] * fast_pow(e.alpha, k) * alpha_scale])));
            }
        }
    }
    // Painter order within the draw: the oldest trail copies, halos, outlines, then the particles.
    trails.sort_by(|a, b| b.0.total_cmp(&a.0));
    out.prims.extend(trails.into_iter().map(|(_, p)| p));
    out.prims.extend(halos);
    out.prims.extend(outlines);
    out.prims.extend(mains);
    if out.prims.is_empty() {
        return Out::new();
    }
    out
}

fn fast_pow(base: f64, k: f64) -> f64 {
    crate::vfx::generated::fastmath::powf(base, k)
}

/// Which draws go before or after each target's artwork, and where the walk through
/// painter order is.
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
            let behind = draw.placement == Placement::Behind;
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

    /// A painter-order entry of `uid` begins.
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
