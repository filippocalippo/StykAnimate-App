//! Generated effects in the draw list (docs/engine/vfx.md, Generated effects):
//! each draw of a frame's batch becomes [`K_PARTICLE`] and [`K_BEAM`] records,
//! placed before or after its target's artwork in painter order: behind-placed
//! draws when the target's first entry begins, front-placed ones when the next
//! entry begins, scene draws after the background and after everything, draws of
//! a target not drawn at the end.
//!
//! Each particle is evaluated once; its ribbon trail and glow halo are drawn from that
//! one evaluation (the ribbon from its birth, at earlier ages). A frame's particles are
//! limited in the area they cover ([`FILL_LIMIT`]): beyond it they are thinned evenly and
//! the list says the picture was reduced. A material not generated yet is drawn as soft
//! discs and the list says so ([`MATERIALS_PENDING`]).

use std::collections::HashSet;

use super::*;
use crate::vfx::generated::atlas;
use crate::vfx::generated::layers::{Placement, Spec, ADD, ARC, BEAM, DISC, MATERIAL, NORMAL};
use crate::vfx::generated::particle::{self, Birth, Evaluator, Particle};
use crate::vfx::generated::{Batch, Draw};
use styk_draw::{particle_kind, F_CAP_END, F_CAP_START, K_BEAM, MATERIALS_PENDING, MATERIALS_REDUCED, P_SEGMENT};

/// The area a frame's particles may cover, in canvases: beyond it they are thinned evenly.
pub const FILL_LIMIT: f64 = 48.0;

/// Every draw of a batch as records, each in its own `Out` (rows included), and the material
/// rows they sample (with [`MATERIALS_REDUCED`] when a limit reduced the picture and
/// [`MATERIALS_PENDING`] when a material was not ready).
pub(super) fn encode(batch: &Batch) -> (Vec<Out>, u32) {
    let mut materials = if batch.reduced { MATERIALS_REDUCED } else { 0 };
    // Every live particle once, so the frame's coverage is known before anything is drawn.
    let mut alive: Vec<Vec<(Birth, Particle)>> = Vec::with_capacity(batch.draws.len());
    let mut area = 0.0f64;
    for draw in &batch.draws {
        let mut list = Vec::new();
        if !batch.spec(draw).is_beam() {
            let ev = Evaluator::new(batch, draw);
            let s2 = draw.scale * draw.scale;
            for i in 0..draw.count {
                let Some(b) = ev.birth(i) else { continue };
                if let Some(p) = ev.at_age(&b, ev.local() - b.born) {
                    area += 4.0 * p.reach * p.reach * s2;
                    list.push((b, p));
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
            let (out, used) = draw_out(batch, draw, list, fill);
            materials |= used;
            out
        })
        .collect();
    (outs, materials)
}

/// A draw's six rows: transform, scale and shading, the shape's constants, the outline,
/// erosion and rim, or a crisp shape's cartoon shadow (styk-draw `K_PARTICLE`). `outline`:
/// the main drawing of its particles (halos and trails have neither outline nor shadow).
fn rows(out: &mut Out, m: [f64; 6], scale: f64, s: &Spec, softness: f64, outline: bool) -> u32 {
    let at = out.paints.len() as u32;
    let f = |v: f64| v as f32;
    out.paints.push([f(m[0]), f(m[1]), f(m[2]), f(m[3])]);
    out.paints.push([f(m[4]), f(m[5]), f(scale), f(s.shade)]);
    let o = s.outline.filter(|_| outline);
    out.paints.push([f(softness), f(s.stretch), f(s.aspect), f(o.map_or(0.0, |o| o.width))]);
    out.paints.push(o.map_or([0.0; 4], |o| [f(o.color[0]), f(o.color[1]), f(o.color[2]), 1.0]));
    // A material breaks up (erosion and its rim); a crisp shape may have a shadow side instead.
    match s.cel.filter(|_| outline && s.shape != MATERIAL) {
        Some(c) => {
            out.paints.push([0.0, 0.0, 0.0, f(c.strength)]);
            out.paints.push([f(c.color[0]), f(c.color[1]), f(c.color[2]), f(c.depth)]);
        }
        None => {
            let e = s.erosion.unwrap_or_default();
            out.paints.push([f(e.edge), f(e.rim_width), f(e.rim), 0.0]);
            out.paints.push([f(e.rim_color[0]), f(e.rim_color[1]), f(e.rim_color[2]), 0.0]);
        }
    }
    at
}

/// A beam's look: its stops' ends as core and body unless its style gives one.
fn beam_look(s: &Spec) -> crate::vfx::generated::layers::BeamLook {
    if let Some(look) = s.beam_look {
        return look;
    }
    let (core, _) = particle::color_at(s, 0.0);
    let (body, _) = particle::color_at(s, 1.0);
    let (ec, eb, eg) = match s.blend {
        NORMAL => (0.0, 0.0, 0.0),
        ADD => (1.0, 1.0, 1.0),
        _ => (0.85, 0.35, 1.0),
    };
    crate::vfx::generated::layers::BeamLook {
        core: [core[0], core[1], core[2], ec],
        body: [body[0], body[1], body[2], eb],
        glow: [body[0], body[1], body[2], eg],
        head: 1.0,
        strands: s.beam_style == 3.0,
        ink: s.outline.map(|o| (o.color, o.width)),
    }
}

fn draw_out(batch: &Batch, draw: &Draw, alive: &[(Birth, Particle)], fill: f64) -> (Out, u32) {
    let mut out = Out::new();
    let mut used = 0u32;
    let s = batch.spec(draw);
    let m = batch.matrix(draw);
    let scale = draw.scale;
    let world = |x: f64, y: f64| [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
    let grow = |out: &mut Out, centre: [f64; 2], reach: f64| out.grow(centre[0] - reach, centre[1] - reach, centre[0] + reach, centre[1] + reach);
    let f = |v: f64| v as f32;
    if s.shape == BEAM {
        let Some(beam) = particle::beam(batch, draw) else { return (Out::new(), 0) };
        let look = beam_look(s);
        let at = out.paints.len() as u32;
        out.paints.push([f(m[0]), f(m[1]), f(m[2]), f(m[3])]);
        out.paints.push([f(m[4]), f(m[5]), f(scale), 0.0]);
        for c in [look.core, look.body, look.glow] {
            out.paints.push([f(c[0]), f(c[1]), f(c[2]), f(c[3])]);
        }
        let ink = look.ink.unwrap_or(([0.0; 3], 0.0));
        out.paints.push([f(look.head), f(ink.0[0]), f(ink.0[1]), f(ink.0[2])]);
        let seed = (draw.seed % 997) as f64;
        let reach = (beam.width * 3.0 + 8.0 + ink.1) * scale;
        grow(&mut out, world(beam.a[0], beam.a[1]), reach);
        grow(&mut out, world(beam.b[0], beam.b[1]), reach);
        let style = match s.beam_style as u32 {
            1 => 1.0,
            2 => 2.0,
            _ => 0.0,
        };
        let opacity = draw.alpha * s.alpha * particle::color_at(s, 0.0).1;
        out.prims.push(prim(K_BEAM, 0, at, [beam.a[0], beam.a[1], beam.b[0], beam.b[1]], [beam.width, s.wobble, seed, beam.te], [opacity, style, if look.strands { 1.0 } else { 0.0 }, ink.1]));
        return (out, 0);
    }
    if s.shape == ARC {
        let r = rows(&mut out, m, scale, s, s.softness, false);
        let (rgb, _) = particle::color_at(s, 0.0);
        let e = particle::emission(s, 0.0, rgb);
        for piece in particle::arcs(batch, draw) {
            let reach = piece.r0.max(piece.r1) * (1.0 + s.softness * 3.0) * scale + scale;
            grow(&mut out, world(piece.p0[0], piece.p0[1]), reach);
            grow(&mut out, world(piece.p1[0], piece.p1[1]), reach);
            let caps = if piece.start { F_CAP_START } else { 0 } | if piece.end { F_CAP_END } else { 0 };
            out.prims.push(prim(particle_kind(P_SEGMENT) | caps, 0, r, [piece.p0[0], piece.p0[1], piece.p1[0], piece.p1[1]], [piece.r0, piece.r1, e, piece.a1], [rgb[0], rgb[1], rgb[2], piece.a0]));
        }
        if out.prims.is_empty() {
            return (Out::new(), 0);
        }
        return (out, 0);
    }
    let seed = draw.seed;
    let main = rows(&mut out, m, scale, s, s.softness, true);
    let halo_rows = s.halo.map(|_| rows(&mut out, m, scale, s, 2.2, false));
    let trail_rows = s.trail.map(|t| rows(&mut out, m, scale, s, t.glow, false));
    // A material not generated yet: soft discs this frame, and the frame is drawn again.
    let fallback_rows = (s.shape == MATERIAL && s.material.and_then(|m| m.noise).is_some_and(|row| atlas::ready(row as usize).is_none())).then(|| rows(&mut out, m, scale, s, 1.5, false));
    let (mut trails, mut halos, mut mains) = (Vec::new(), Vec::new(), Vec::new());
    let ev = Evaluator::new(batch, draw);
    for (b, p) in alive {
        let mut alpha_scale = 1.0;
        if fill < 1.0 {
            // Thinned evenly by a chance of its own, fading near the threshold rather than popping.
            let h = particle::hash(p.n, 23, seed);
            alpha_scale = 1.0 - particle::smoothstep(fill - 0.04, fill, h);
            if alpha_scale <= 0.0 {
                continue;
            }
        }
        let alpha = p.rgba[3] * alpha_scale;
        if alpha <= 0.0 {
            continue;
        }
        let ps = &*batch.specs[p.spec as usize];
        let reach = (p.reach + 1.0) * scale;
        grow(&mut out, world(p.x, p.y), reach);
        let (mut shape, mut rows_of) = (p.shape as u32, main);
        if p.shape == MATERIAL {
            match (fallback_rows, ps.material.and_then(|m| m.noise)) {
                (Some(r), _) => {
                    shape = DISC as u32;
                    rows_of = r;
                    used |= MATERIALS_PENDING;
                }
                (None, Some(row)) => used |= 1 << row,
                _ => {}
            }
        }
        mains.push(prim(particle_kind(shape), p.cell, rows_of, [p.x, p.y, p.size, p.rotation], [p.vx, p.vy, p.emissive, p.erosion], [p.rgba[0], p.rgba[1], p.rgba[2], alpha]));
        if let (Some(h), Some(r)) = (ps.halo, halo_rows) {
            let size = p.size * h.scale;
            grow(&mut out, world(p.x, p.y), (size + 1.0) * scale);
            halos.push(prim(particle_kind(DISC as u32), 0, r, [p.x, p.y, size, 0.0], [0.0, 0.0, 1.0, 0.0], [p.rgba[0], p.rgba[1], p.rgba[2], alpha * h.alpha]));
        }
        if let (Some(t), Some(r)) = (ps.trail, trail_rows) {
            // Where it was over the last `length` frames, a whole number of the drawing's steps apart.
            let pieces = t.segments.max(1);
            let dt = particle::trail_lag(t.length / pieces as f64, draw.step);
            let age = ev.local() - b.born;
            let e = t.emissive.unwrap_or(p.emissive);
            let mut previous = [p.x, p.y];
            for k in 1..=pieces {
                let then = age - k as f64 * dt;
                if then < 0.0 {
                    break;
                }
                let (at, _) = ev.motion(b, then);
                let (f0, f1) = ((k - 1) as f64 / pieces as f64, k as f64 / pieces as f64);
                let w = p.size * t.width;
                let (r0, r1) = (w * (1.0 - f0), w * (1.0 - f1));
                let (a0, a1) = (alpha * t.alpha * (1.0 - f0) * (1.0 - f0), alpha * t.alpha * (1.0 - f1) * (1.0 - f1));
                grow(&mut out, world(at[0], at[1]), (r0 * (1.0 + t.glow * 3.0) + 1.0) * scale);
                let caps = if k == 1 { F_CAP_START } else { 0 } | if k == pieces || then - dt < 0.0 { F_CAP_END } else { 0 };
                trails.push(prim(particle_kind(P_SEGMENT) | caps, 0, r, [previous[0], previous[1], at[0], at[1]], [r0, r1, e, a1], [p.rgba[0], p.rgba[1], p.rgba[2], a0]));
                previous = at;
            }
        }
    }
    // Painter order within the draw: trails, halos, then the particles.
    out.prims.extend(trails);
    out.prims.extend(halos);
    out.prims.extend(mains);
    if out.prims.is_empty() {
        return (Out::new(), 0);
    }
    (out, used)
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
