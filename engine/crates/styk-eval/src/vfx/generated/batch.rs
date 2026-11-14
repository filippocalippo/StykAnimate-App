//! A frame's generated effects as one batch: every layer's draw (when it emits,
//! how many, where its table rows are, its transform) and a table of values read
//! at each particle's birth: where the target was, how much was emitted, the
//! keyed direction, speed and size, the body's scale, the layer's parameters as
//! they were keyed at that tick, the ground; and the target's outlines. A particle
//! is a pure function of its draw, the table and the tick ([`super::particle`]);
//! nothing is simulated or kept between frames.
//!
//! Limits: a frame evaluates at most [`BATCH_INSTANCES`] particles and draws at
//! most [`MAX_DRAWN`] records (copies counted); an edit frame on the interface
//! thread draws at most what [`build_within`] is given. Beyond them emission is
//! thinned evenly (each particle keeps its own chance, so the same particles stay)
//! and [`Batch::reduced`] says so.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

use super::anchors::{anchor, Anchor, Sample, Sampler};
use super::layers::*;
use super::styles::{self, Context};
use crate::doc::Document;
use crate::eval::{Frame, Prepared};
use crate::geometry::Scene;
use crate::vfx::clips::{sample_keys, Field};
use crate::vfx::registry::Prefill;
use crate::vfx::{paint, Clip, Effect, Kind, ParamValue, Params, Target};

/// Floats per birth-table row ([`row`]).
pub const ROW: usize = 12;

/// The values of a birth-table row.
pub mod row {
    /// Where the emitter was.
    pub const X: usize = 0;
    pub const Y: usize = 1;
    /// How much of the layer's emission happens at that tick, 0–1.
    pub const EMIT: usize = 2;
    /// Keyed direction (radians), speed and size multipliers (Particles), or a stream's aim.
    pub const DIR: usize = 3;
    pub const SPEED: usize = 4;
    pub const SIZE: usize = 5;
    /// The body's scale (auras): sizes, speeds and forces are multiplied by it.
    pub const SCALE: usize = 6;
    /// The layer's parameters at that tick: an index into [`super::Batch::specs`].
    pub const SPEC: usize = 7;
    /// Where the ground was.
    pub const GROUND: usize = 8;
}

/// Floats per outline segment in a block: `x0, y0, x1, y1`, the outline's length to its end.
pub const SEGMENT: usize = 5;

/// Particles evaluated per layer and per frame, layers per frame, birth-table rows per layer.
pub const LAYER_PARTICLES: f64 = 65536.0;
pub const BATCH_INSTANCES: f64 = 262144.0;
pub const BATCH_LAYERS: usize = 256;
pub const TABLE_TICKS: f64 = 600.0;
/// Records a frame draws at most, trails, halos and outlines counted.
pub const MAX_DRAWN: f64 = 200_000.0;
/// What an edit frame drawn on the interface thread draws at most ([`build_within`]).
pub const EDIT_DRAWN: f64 = 8_000.0;
/// Movieclips nest generated effects at most this deep.
pub const MAX_NESTING: u32 = 4;

/// A target's outline shared by the layers of an effect: one per birth tick for layers
/// that leave a trail, one current outline otherwise.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Block {
    /// Its first float in the table.
    pub start: u32,
    pub segments: u32,
    /// Rows (birth ticks) it holds; 1 for a current outline.
    pub rows: u32,
    /// The tick of its first row.
    pub first: f64,
}

/// One layer drawn: its particles (with their halos, outlines and trails), its beam or
/// its arcs, placed before or after its target's artwork.
#[derive(Clone, Debug, PartialEq)]
pub struct Draw {
    /// The layer's parameters now, by index into [`Batch::specs`].
    pub spec: u32,
    /// Instances: particles, a beam's one, or arc segments.
    pub count: u32,
    pub shape: u8,
    /// [`NORMAL`], [`ADD`] or [`AUTO`] (`Spec::blend`).
    pub blend: u8,
    /// The figure (or the movieclip container) it is drawn beside; `None` for the scene.
    pub uid: Option<u32>,
    pub placement: Placement,
    /// A scene effect of the top-level document.
    pub scene: bool,
    /// The atlas row a material layer samples, or -1.
    pub material: i32,
    /// The tick of the layer's document (a movieclip's own tick for effects inside one).
    pub tick: f64,
    /// Animate on ones, twos or threes, counted from `clip[0]`.
    pub step: f64,
    pub seed: u32,
    /// The effect's start and playback speed: its own time at tick `t` is `t0 + (t − t0) · time_scale`.
    pub t0: f64,
    pub time_scale: f64,
    /// The clip's start and end ([`FAR`] when untimed), in ticks.
    pub clip: [f64; 2],
    /// Emission in the effect's time: from `start` for `emit_dur` (a lifetime earlier and
    /// longer when it starts already running); `emit_dur` 0 is a burst.
    pub start: f64,
    pub emit_dur: f64,
    /// Particles a frame of the effect's time at full emission.
    pub rate: f64,
    /// The share of particles drawn (limits thin evenly): each keeps its own chance.
    pub keep: f64,
    /// Its rows: from `table` (in rows), the first at tick `tick0`, `ticks` of them.
    pub table: u32,
    pub tick0: f64,
    pub ticks: u32,
    pub block: Option<Block>,
    /// Local units to the stage: the movieclip transform, then `offset` (a live drag).
    pub matrix: [f64; 6],
    /// √|det| of `matrix`.
    pub scale: f64,
    pub offset: [f64; 2],
    /// The target's point now, and the beam's aim.
    pub point: [f64; 2],
    pub aim: [f64; 2],
    pub ground: f64,
    pub canvas: [f64; 2],
    /// The effect's opacity times the clip's strength and fades.
    pub alpha: f64,
    /// Particles stay where they were born (their rows hold earlier places).
    pub world: bool,
}

/// Everything one frame draws for generated effects.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Batch {
    pub tick: f64,
    /// Layer parameters: each draw's current ones, and those keyed at earlier births.
    pub specs: Vec<Arc<Spec>>,
    pub table: Vec<f32>,
    pub draws: Vec<Draw>,
    /// Instances over every draw.
    pub particles: u32,
    /// Some earlier-tick anchors were not ready: those births used the nearest known.
    pub incomplete: bool,
    /// A limit thinned or left out part of what was asked for: the picture is reduced.
    pub reduced: bool,
}

impl Batch {
    /// A draw's current parameters.
    pub fn spec(&self, draw: &Draw) -> &Spec {
        &self.specs[draw.spec as usize]
    }

    /// Row `k` of a draw (clamped to its rows).
    pub fn row(&self, draw: &Draw, k: usize) -> &[f32] {
        let k = k.min(draw.ticks.saturating_sub(1) as usize);
        let o = (draw.table as usize + k) * ROW;
        &self.table[o..o + ROW]
    }

    /// A draw's stage transform: its movieclip matrix, then its offset.
    pub fn matrix(&self, draw: &Draw) -> [f64; 6] {
        let m = draw.matrix;
        [m[0], m[1], m[2], m[3], m[4] + draw.offset[0], m[5] + draw.offset[1]]
    }

    /// The material rows the batch's sprites sample.
    pub fn materials(&self) -> impl Iterator<Item = u32> + '_ {
        self.draws.iter().filter(|d| d.material >= 0).map(|d| d.material as u32)
    }

    /// The stage rectangle the batch's live particles and beams cover (x, y, width,
    /// height), each grown by its reach, or `None` when nothing is alive.
    pub fn bounds(&self) -> Option<[f64; 4]> {
        use super::particle::{arcs, beam_tip, Evaluator};
        let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
        for draw in &self.draws {
            let s = self.spec(draw);
            let (mut lx0, mut ly0, mut lx1, mut ly1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
            let mut grow = |x: f64, y: f64, reach: f64| {
                lx0 = lx0.min(x - reach);
                ly0 = ly0.min(y - reach);
                lx1 = lx1.max(x + reach);
                ly1 = ly1.max(y + reach);
            };
            if s.shape == ARC {
                for piece in arcs(self, draw) {
                    grow(piece.p0[0], piece.p0[1], piece.r0 * 4.0 + 2.0);
                    grow(piece.p1[0], piece.p1[1], piece.r1 * 4.0 + 2.0);
                }
            } else if s.is_beam() {
                let ev = Evaluator::new(self, draw);
                let tip = beam_tip(draw, s, ev.local());
                let pad = s.beam_w * 4.0 + s.arc_amp + 16.0;
                grow(draw.point[0], draw.point[1], pad);
                grow(tip[0], tip[1], pad);
            } else {
                let ev = Evaluator::new(self, draw);
                for i in 0..draw.count {
                    if let Some(p) = ev.particle(i) {
                        grow(p.x, p.y, p.reach);
                    }
                }
            }
            if lx0 > lx1 {
                continue;
            }
            let [a, b, c, d, e, f] = self.matrix(draw);
            for [x, y] in [[lx0, ly0], [lx1, ly0], [lx0, ly1], [lx1, ly1]] {
                let (px, py) = (a * x + c * y + e, b * x + d * y + f);
                x0 = x0.min(px);
                y0 = y0.min(py);
                x1 = x1.max(px);
                y1 = y1.max(py);
            }
        }
        (x0 <= x1).then(|| [x0, y0, x1 - x0, y1 - y0])
    }

    /// Draws beside `uid` move by `offset(uid)` (a live drag, parallax). Particles that stay
    /// where they were born keep their place: only their newest births follow the drag.
    pub fn offset(&mut self, offset: impl Fn(u32) -> Option<[f64; 2]>) {
        for i in 0..self.draws.len() {
            let Some(d) = self.draws[i].uid.and_then(&offset) else { continue };
            if d[0] == 0.0 && d[1] == 0.0 {
                continue;
            }
            let draw = &self.draws[i];
            if draw.world && !self.specs[draw.spec as usize].is_beam() {
                // Into the draw's local units.
                let m = draw.matrix;
                let det = m[0] * m[3] - m[1] * m[2];
                if det.abs() < 1e-12 {
                    continue;
                }
                let (lx, ly) = ((m[3] * d[0] - m[2] * d[1]) / det, (-m[1] * d[0] + m[0] * d[1]) / det);
                let newest = (draw.tick.floor() - draw.tick0).max(0.0) as usize;
                for k in newest..draw.ticks as usize {
                    let o = (draw.table as usize + k) * ROW;
                    self.table[o + row::X] += lx as f32;
                    self.table[o + row::Y] += ly as f32;
                }
            } else {
                let draw = &mut self.draws[i];
                draw.offset[0] += d[0];
                draw.offset[1] += d[1];
            }
        }
    }
}

/// Whether a document, or a movieclip nested in it, has a generated effect.
pub fn has_generators(doc: &Document) -> bool {
    fn within(doc: &Document, depth: u32) -> bool {
        if depth > MAX_NESTING {
            return false;
        }
        doc.vfx_clips.as_ref().is_some_and(|clips| clips.clips.iter().any(|clip| clip.has_generators()))
            || doc.figures.iter().any(|figure| figure.movieclip.as_ref().is_some_and(|clip| within(&clip.document, depth + 1)))
    }
    within(doc, 0)
}

/// Effect `index` of `clip` with its keys sampled at `tick` (the clip's own envelope left out).
fn sample_effect(clip: &Clip, index: usize, tick: f64) -> Arc<Effect> {
    let effect = &clip.effects[index];
    let age = clip.time(tick);
    let mut result: Option<Effect> = None;
    for channel in clip.channels.iter().filter(|channel| channel.effect == index) {
        let value = sample_keys(&channel.keys, age, channel.discrete, channel.color);
        let sampled = result.get_or_insert_with(|| (**effect).clone());
        match channel.field {
            Field::Enabled => sampled.enabled = matches!(value, ParamValue::Num(n) if n != 0.0),
            Field::Param(i) => {
                sampled.params.set(i, &value);
            }
        }
    }
    result.map_or_else(|| effect.clone(), Arc::new)
}

fn keyed(clip: &Clip, index: usize) -> bool {
    clip.channels.iter().any(|c| c.effect == index)
}

// ---------------------------------------------------------------------------
// Caches: compiled layers and clip tails, per thread and bounded, so a frame does
// not compile styles again. An entry holds the effects it was made from, so their
// addresses (part of its key) cannot be reused while it lives.
// ---------------------------------------------------------------------------

const CACHE_ENTRIES: usize = 512;

type CompileKey = (usize, [u64; 10]);

thread_local! {
    static COMPILED: RefCell<HashMap<CompileKey, (Arc<Effect>, Arc<Vec<Spec>>)>> = RefCell::new(HashMap::new());
    static TAILS: RefCell<HashMap<Vec<usize>, (Vec<Arc<Effect>>, Vec<Arc<[crate::vfx::clips::Key]>>, f64)>> = RefCell::new(HashMap::new());
}

fn context_key(ctx: &Context) -> [u64; 10] {
    [
        ctx.start.to_bits(),
        ctx.end.to_bits(),
        ctx.window.to_bits(),
        ctx.timed as u64,
        ctx.fade_out.to_bits(),
        ctx.scene as u64,
        ctx.start_point[0].to_bits(),
        ctx.start_point[1].to_bits(),
        ctx.prefill as u64,
        0,
    ]
}

/// The effect's layers ([`styles::compile`]), compiled once while the effect lives.
pub fn compiled(effect: &Arc<Effect>, ctx: &Context) -> Arc<Vec<Spec>> {
    let key = (Arc::as_ptr(effect) as usize, context_key(ctx));
    if let Some(found) = COMPILED.with(|c| c.borrow().get(&key).map(|(_, specs)| specs.clone())) {
        return found;
    }
    let specs = Arc::new(styles::compile(&effect.params, ctx));
    COMPILED.with(|c| {
        let mut c = c.borrow_mut();
        if c.len() >= CACHE_ENTRIES {
            c.clear();
        }
        c.insert(key, (effect.clone(), specs.clone()));
    });
    specs
}

/// Ticks after a timed clip's end during which its particles still show: their longest
/// lifetime, trail and jitter, keyed values included, at the effect's playback speed.
pub fn clip_tail(clip: &Clip) -> f64 {
    let Some(duration) = clip.duration else { return 0.0 };
    let mut key: Vec<usize> = clip.effects.iter().map(|e| Arc::as_ptr(e) as usize).collect();
    key.extend(clip.channels.iter().map(|c| Arc::as_ptr(&c.keys) as *const u8 as usize));
    key.push(clip.start.to_bits() as usize);
    key.push(duration.to_bits() as usize);
    if let Some(found) = TAILS.with(|t| t.borrow().get(&key).map(|e| e.2)) {
        return found;
    }
    let end = clip.start + duration;
    let mut tail = 0.0f64;
    for (index, effect) in clip.effects.iter().enumerate() {
        if !effect.kind().is_generator() {
            continue;
        }
        // The stored values, and those at every key of the effect's channels.
        let mut samples = vec![effect.clone()];
        for channel in clip.channels.iter().filter(|c| c.effect == index) {
            for k in channel.keys.iter() {
                samples.push(sample_effect(clip, index, clip.start + k.tick - clip.offset));
            }
        }
        for sampled in samples {
            let p = &sampled.params;
            let delay = p.delay();
            if delay >= duration {
                continue;
            }
            let ts = time_scale(p);
            let t0 = clip.start + delay;
            let ctx = Context { start: t0, end, window: duration - delay, timed: true, fade_out: 0.0, scene: false, start_point: [0.0, 0.0], prefill: false };
            for l in styles::compile(p, &ctx) {
                if !l.is_beam() {
                    let local = l.start + if l.emit_dur > 0.0 { l.emit_dur } else { l.burst_jitter } + l.life_max + l.trail_span();
                    tail = tail.max(t0 + (local - t0) / ts - end);
                }
            }
        }
    }
    let tail = tail.max(0.0).ceil();
    TAILS.with(|t| {
        let mut t = t.borrow_mut();
        if t.len() >= CACHE_ENTRIES {
            t.clear();
        }
        t.insert(key, (clip.effects.clone(), clip.channels.iter().map(|c| c.keys.clone()).collect(), tail));
    });
    tail
}

fn time_scale(p: &Params) -> f64 {
    let ts = p.time_scale();
    if ts.is_finite() { ts.clamp(0.1, 4.0) } else { 1.0 }
}

/// A keyed parameter of a clip's effect as a function of the tick, and the
/// largest value it reaches, which sizes emission capacity.
struct Channel<'a> {
    max: f64,
    keys: Option<(&'a crate::vfx::Channel, &'a Clip)>,
    fallback: f64,
}

impl Channel<'_> {
    fn at(&self, tick: f64) -> f64 {
        match self.keys {
            None => self.fallback,
            Some((channel, clip)) => match sample_keys(&channel.keys, clip.time(tick), channel.discrete, channel.color) {
                ParamValue::Num(n) => n,
                ParamValue::Paint(_) => self.fallback,
            },
        }
    }

    fn keyed(&self) -> bool {
        self.keys.is_some()
    }
}

fn number(effect: &Effect, name: &str) -> f64 {
    match effect.kind().param(name).map(|i| effect.params.get(i)) {
        Some(ParamValue::Num(n)) => n,
        _ => 0.0,
    }
}

fn keyed_channel<'a>(clip: &'a Clip, position: usize, effect: &Effect, name: &str) -> Channel<'a> {
    let fallback = number(effect, name);
    let index = effect.kind().param(name);
    let channel = clip.channels.iter().find(|c| c.effect == position && index.is_some_and(|i| c.field == Field::Param(i)));
    match channel {
        None => Channel { max: fallback, keys: None, fallback },
        Some(channel) => {
            let mut max = fallback;
            for key in channel.keys.iter() {
                if let ParamValue::Num(v) = key.value {
                    max = max.max(v);
                }
            }
            Channel { max, keys: Some((channel, clip)), fallback }
        }
    }
}

/// How a nested layer's births follow its movieclip container: the container's place
/// in the document around it, at the birth's tick.
#[derive(Clone, Copy)]
struct Container<'a> {
    prepared: &'a Prepared,
    uid: u32,
    /// The outer document's tick now, and the container's root now.
    tick: f64,
    root: [f64; 2],
}

/// One layer of one effect, ready to pack.
struct Layer<'a> {
    prepared: &'a Prepared,
    tick: f64,
    clip: &'a Arc<Clip>,
    /// The effect's position in its clip, and the layer's in the effect's compiled list.
    position: usize,
    index: usize,
    effect: Arc<Effect>,
    spec: Arc<Spec>,
    ctx: Context,
    alpha: f64,
    matrix: [f64; 6],
    seed: u32,
    uid: Option<u32>,
    scene: bool,
    /// The target now (or when it was last there), and which effect it belongs to.
    current: Option<(usize, Arc<Anchor>)>,
    /// The tick the target was last there (the tick itself when it is there now).
    last_present: f64,
    point: [f64; 2],
    aim: Option<[f64; 2]>,
    ground: f64,
    step: f64,
    attached: bool,
    t0: f64,
    time_scale: f64,
    keyed: bool,
    container: Option<Container<'a>>,
}

/// What a nested movieclip document contributes, drawn beside its container.
struct Nest<'a> {
    matrix: [f64; 6],
    container: Option<u32>,
    opacity: f64,
    depth: u32,
    outer: Option<Container<'a>>,
}

/// Canvas-style affine product `p·m`: apply `m` first, then `p`.
fn compose(p: [f64; 6], m: [f64; 6]) -> [f64; 6] {
    [p[0] * m[0] + p[2] * m[1], p[1] * m[0] + p[3] * m[1], p[0] * m[2] + p[2] * m[3], p[1] * m[2] + p[3] * m[3], p[0] * m[4] + p[2] * m[5] + p[4], p[1] * m[4] + p[3] * m[5] + p[5]]
}

const IDENTITY: [f64; 6] = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

struct State {
    incomplete: bool,
    reduced: bool,
    /// Effects whose current anchor was read, for shared outlines.
    effects: usize,
}

/// A sample, or the nearest known one while it is pending.
fn sample_or_nearest(sampler: &dyn Sampler, prepared: &Prepared, target: Target, tick: f64, attached: bool, state: &mut State) -> Option<Arc<Anchor>> {
    match sampler.sample(prepared, target, tick, attached) {
        Sample::Ready(a) => a,
        Sample::Pending => {
            state.incomplete = true;
            sampler.nearest(prepared, target, tick, attached)
        }
    }
}

/// FNV-1a of a string: a clip's identity mixed into the seeds of its effects.
fn fnv(text: &str) -> u32 {
    let mut h = 0x811c9dc5u32;
    for b in text.bytes() {
        h ^= b as u32;
        h = h.wrapping_mul(0x01000193);
    }
    h
}

/// Generator layers of one document at one frame, its nested movieclips' after its own.
/// `tick` is the frame's effects tick (`None` draws no clip of this document).
#[allow(clippy::too_many_arguments)]
fn collect<'a>(prepared: &'a Prepared, frame: &Frame, scene: &Scene, tick: Option<f64>, sampler: Option<&dyn Sampler>, nest: &Nest<'a>, state: &mut State, layers: &mut Vec<Layer<'a>>) {
    let doc = &*prepared.doc;
    let (width, height) = (doc.canvas[0] as f64, doc.canvas[1] as f64);
    if let (Some(tick), Some(clips)) = (tick, doc.vfx_clips.as_deref()) {
        for clip in &clips.clips {
            if layers.len() >= BATCH_LAYERS {
                state.reduced = true;
                break;
            }
            if !clip.enabled || clip.strength == 0.0 || !clip.has_generators() || tick < clip.start {
                continue;
            }
            if let Some(duration) = clip.duration
                && tick >= clip.start + duration + clip_tail(clip)
            {
                continue;
            }
            let scene_target = clip.target == Target::Scene;
            let timed = clip.duration.is_some();
            let end = clip.duration.map_or(FAR, |d| clip.start + d);
            let elapsed = clamp(tick - clip.start, 0.0, clip.duration.unwrap_or(FAR));
            let strength = clip.strength * if timed { clip.fade(elapsed) } else { 1.0 } * nest.opacity;
            if strength <= 0.0 {
                continue;
            }
            let at = if timed { tick.min(end - 1e-6) } else { tick };
            for index in 0..clip.effects.len() {
                let effect = sample_effect(clip, index, at);
                if !effect.kind().is_generator() || !effect.enabled {
                    continue;
                }
                let p = &effect.params;
                let alpha = strength * p.effect_strength();
                if alpha <= 0.0 {
                    continue;
                }
                let kind = effect.kind();
                let delay = p.delay();
                if timed && delay >= clip.duration.unwrap_or(FAR) {
                    continue;
                }
                let start = clip.start + delay;
                if tick < start {
                    continue;
                }
                let wants_body = kind == Kind::Aura || matches!(p, Params::Particles(q) if q.shape == crate::vfx::registry::EmitShape::Body);
                let attached = clip.include_attached || kind == Kind::Aura;
                let (x, y) = position(p);
                let stage_point = [x * width, y * height];
                let mut current = if scene_target { None } else { anchor(doc, scene, frame, clip.target, wants_body, attached).map(Arc::new) };
                let mut last_present = tick;
                let start_anchor: Option<Arc<Anchor>> = match (scene_target, sampler) {
                    (true, _) => None,
                    (false, Some(sampler)) if tick > start + 0.5 || current.is_none() => sample_or_nearest(sampler, prepared, clip.target, start, clip.include_attached, state).or_else(|| current.clone()),
                    _ => current.clone(),
                };
                let ts = time_scale(p);
                let prefill = match p.prefill() {
                    Prefill::On => true,
                    Prefill::Off => false,
                    Prefill::Auto => clip.duration.is_none() || start <= 0.0,
                };
                let mut ctx = Context {
                    start,
                    end,
                    window: if timed { clip.duration.unwrap() - delay } else { FAR },
                    timed,
                    fade_out: clip.fade_out,
                    scene: scene_target,
                    start_point: stage_point,
                    prefill,
                };
                if !scene_target {
                    let a = start_anchor.as_ref().or(current.as_ref());
                    ctx.start_point = match a {
                        Some(a) if kind == Kind::Explosion && matches!(clip.target, Target::Figure { .. }) => a.center,
                        Some(a) => a.point,
                        None => stage_point,
                    };
                }
                let specs = compiled(&effect, &ctx);
                if !scene_target && current.is_none() {
                    // The target is gone: what it emitted while it was there still draws, from
                    // where it last was, for as long as those particles live.
                    let Some(sampler) = sampler else { continue };
                    let reach = specs.iter().filter(|l| !l.is_beam()).map(|l| (l.life_max + l.trail_span() + l.burst_jitter) / ts).fold(0.0, f64::max).ceil();
                    let mut found = None;
                    let mut t = tick.floor() - 1.0;
                    while t >= (tick - reach - 1.0).max(start.floor()) && found.is_none() {
                        found = sample_or_nearest(sampler, prepared, clip.target, t, attached, state).map(|a| (t, a));
                        t -= 1.0;
                    }
                    let Some((when, a)) = found else { continue };
                    last_present = when;
                    // Its outline was not asked for with the body: ask again when it is needed.
                    current = Some(if wants_body && a.segments.is_none() { sample_or_nearest(sampler, prepared, clip.target, when, attached, state).unwrap_or(a) } else { a });
                }
                let mut aim = None;
                if let Params::Beam(b) = p {
                    aim = Some([b.aim_x * width, b.aim_y * height]);
                    if b.aim_uid != 0 {
                        let target = if b.aim_handle != 0 { Target::Segment { uid: b.aim_uid, handle: b.aim_handle, figure_type: None } } else { Target::Figure { uid: b.aim_uid } };
                        match anchor(doc, scene, frame, target, false, false) {
                            Some(a) => aim = Some(a.point),
                            // An aim that left keeps the beam where it last pointed.
                            None => {
                                if let Some(sampler) = sampler {
                                    let mut t = tick.floor() - 1.0;
                                    while t >= (tick - 240.0).max(0.0) {
                                        if let Some(a) = sample_or_nearest(sampler, prepared, target, t, false, state) {
                                            aim = Some(a.point);
                                            break;
                                        }
                                        t -= 1.0;
                                    }
                                }
                            }
                        }
                    }
                }
                let mut seed_base = (seed(p).wrapping_add(1).wrapping_mul(2654435761)).wrapping_add((index as u32 + 1).wrapping_mul(40503));
                if p.unique() {
                    // Each copy plays its own pattern: another clip, another target.
                    seed_base ^= fnv(&clip.id).wrapping_mul(0x9E37_79B9) ^ clip.target.uid().unwrap_or(0).wrapping_mul(0x85EB_CA6B);
                    seed_base ^= nest.container.unwrap_or(0).wrapping_mul(0xC2B2_AE35);
                }
                let effect_id = state.effects;
                state.effects += 1;
                let step = styles::step(p);
                for (li, spec) in specs.iter().enumerate() {
                    layers.push(Layer {
                        prepared,
                        tick,
                        clip,
                        position: index,
                        index: li,
                        effect: effect.clone(),
                        spec: Arc::new(spec.clone()),
                        ctx,
                        alpha,
                        matrix: nest.matrix,
                        seed: seed_base.wrapping_add((li as u32 + 1).wrapping_mul(97531)) & 0xffffff,
                        uid: nest.container.or(if scene_target { None } else { clip.target.uid() }),
                        scene: nest.container.is_none() && scene_target,
                        current: current.clone().map(|c| (effect_id, c)),
                        last_present,
                        point: if scene_target { stage_point } else { current.as_ref().unwrap().point },
                        aim,
                        ground: if scene_target {
                            if kind == Kind::Explosion { stage_point[1] + 40.0 * size(p) } else { height }
                        } else {
                            start_anchor.as_ref().or(current.as_ref()).map_or(height, |a| a.bottom)
                        },
                        step,
                        attached,
                        t0: start,
                        time_scale: ts,
                        keyed: keyed(clip, index),
                        container: nest.outer,
                    });
                }
            }
        }
    }
    if nest.depth >= MAX_NESTING {
        return;
    }
    // Movieclip containers whose documents carry generated effects, in object order.
    for slot in object_order(frame) {
        let Some(g) = scene.objects.get(slot).filter(|g| g.resolved) else { continue };
        let object = &frame.objects[slot];
        let Some(fig) = doc.figure(object.figure) else { continue };
        let Some(clip) = &fig.movieclip else { continue };
        if clip.meshes.is_some() || !has_generators(&clip.document) {
            continue;
        }
        let Some(local) = object.clip_time else { continue };
        let source_tick = clip.source_start + local;
        let inner_frame = clip.prepared.evaluate_clip(source_tick);
        let inner_scene = crate::geometry::clip_scene(clip, local);
        let angle = object.angles.first().copied().unwrap_or(0.0);
        let scale = object.scale;
        let flip = if object.image_text_flags { -1.0 } else { 1.0 };
        let (a, b) = (styk_math::cos(angle) * scale, styk_math::sin(angle) * scale);
        let (root, pivot) = (g.root, clip.pivot);
        let matrix = [a, b, -b * flip, a * flip, root[0] - a * pivot[0] + b * flip * pivot[1], root[1] - b * pivot[0] - a * flip * pivot[1]];
        let inner_tick = clip.document.vfx_clips.as_ref().map(|_| source_tick);
        let outer = match (nest.depth, tick) {
            // The top-level container's place on earlier ticks moves the trails it leaves.
            (0, Some(tick)) => Some(Container { prepared, uid: object.uid, tick, root }),
            _ => nest.outer,
        };
        let inner = Nest { matrix: compose(nest.matrix, matrix), container: nest.container.or(Some(object.uid)), opacity: nest.opacity * (1.0 - object.transparency / 255.0), depth: nest.depth + 1, outer };
        collect(&clip.prepared, &inner_frame, &inner_scene, inner_tick, sampler, &inner, state, layers);
    }
}

/// The order of objects: free figures by slot, then what is joined to each, breadth first.
fn object_order(frame: &Frame) -> Vec<usize> {
    let count = frame.objects.len();
    let mut children: Vec<Vec<usize>> = vec![Vec::new(); count];
    let mut ready = Vec::new();
    for (i, o) in frame.objects.iter().enumerate() {
        match o.join {
            Some(j) => {
                if (j.slot as usize) < count {
                    children[j.slot as usize].push(i);
                }
            }
            None => ready.push(i),
        }
    }
    let mut q = 0;
    while q < ready.len() {
        let slot = ready[q];
        ready.extend(children[slot].iter().copied());
        q += 1;
        if ready.len() > count * 2 {
            break;
        }
    }
    ready
}

fn seed(p: &Params) -> u32 {
    match p {
        Params::Particles(p) => p.seed,
        Params::Aura(p) => p.seed,
        Params::Beam(p) => p.seed,
        Params::Smoke(p) => p.seed,
        Params::Explosion(p) => p.seed,
        _ => 0,
    }
}

fn position(p: &Params) -> (f64, f64) {
    match p {
        Params::Particles(p) => (p.x, p.y),
        Params::Beam(p) => (p.x, p.y),
        Params::Smoke(p) => (p.x, p.y),
        Params::Explosion(p) => (p.x, p.y),
        _ => (0.5, 0.5),
    }
}

fn size(p: &Params) -> f64 {
    match p {
        Params::Explosion(p) => p.size,
        Params::Particles(p) => p.size,
        Params::Smoke(p) => p.size,
        _ => 1.0,
    }
}

/// The generated effects of one frame, or `None` when nothing generated is visible.
/// `tick` is the frame's effects tick; `sampler` supplies anchors on earlier ticks
/// (without one, trails follow the current pose); `density` thins emission (1 draws
/// everything, within [`MAX_DRAWN`]).
pub fn build(prepared: &Prepared, frame: &Frame, scene: &Scene, tick: Option<f64>, sampler: Option<&dyn Sampler>, density: f64) -> Option<Batch> {
    build_limited(prepared, frame, scene, tick, sampler, density, MAX_DRAWN)
}

/// [`build`] for a frame that must stay light: at most `drawn` records (copies counted),
/// thinned evenly beyond (edit frames drawn on the interface thread: [`EDIT_DRAWN`]).
pub fn build_within(prepared: &Prepared, frame: &Frame, scene: &Scene, tick: Option<f64>, sampler: Option<&dyn Sampler>, drawn: f64) -> Option<Batch> {
    build_limited(prepared, frame, scene, tick, sampler, 1.0, drawn.min(MAX_DRAWN))
}

fn build_limited(prepared: &Prepared, frame: &Frame, scene: &Scene, tick: Option<f64>, sampler: Option<&dyn Sampler>, density: f64, drawn: f64) -> Option<Batch> {
    let mut layers = Vec::new();
    let mut state = State { incomplete: false, reduced: false, effects: 0 };
    collect(prepared, frame, scene, tick, sampler, &Nest { matrix: IDENTITY, container: None, opacity: 1.0, depth: 0, outer: None }, &mut state, &mut layers);
    if layers.is_empty() {
        return None;
    }
    let mut batch = pack(&layers, sampler, density, drawn, &mut state)?;
    batch.incomplete = state.incomplete;
    batch.reduced |= state.reduced;
    Some(batch)
}

/// A layer's plan: capacity and birth rows.
struct Plan {
    layer: usize,
    beam: bool,
    burst: bool,
    /// Emission in the effect's time.
    start: f64,
    emit_dur: f64,
    count: f64,
    rate: f64,
    rate_max: f64,
    tick0: f64,
    ticks: f64,
    /// Its shared outline block: (effect, world).
    block: Option<(usize, bool)>,
}

/// An outline shared by the layers of one effect.
struct OutlineBlock {
    layer: usize,
    world: bool,
    first: f64,
    last: f64,
    seg_count: usize,
    rows: usize,
    start: usize,
}

/// The stepped tick of a layer: held on twos or threes, counted from its clip's start.
fn stepped(tick: f64, clip_start: f64, step: f64) -> f64 {
    if step > 1.0 { clip_start + ((tick - clip_start) / step).floor() * step } else { tick }
}

/// Plans every layer, fills one table, writes one draw per layer.
fn pack(layers: &[Layer<'_>], sampler: Option<&dyn Sampler>, density: f64, budget: f64, state: &mut State) -> Option<Batch> {
    let mut plans: Vec<Plan> = Vec::new();
    let mut blocks: Vec<((usize, bool), OutlineBlock)> = Vec::new();
    let (mut instances, mut row_count, mut drawn) = (0.0f64, 0.0f64, 0.0f64);
    // Earlier-tick samples shared by the layers of one clip within this batch.
    let mut memo: HashMap<(usize, bool, i64), Option<Arc<Anchor>>> = HashMap::new();
    let mut sample_at = |l: &Layer<'_>, tau: f64, state: &mut State| -> Option<Arc<Anchor>> {
        let key = (Arc::as_ptr(l.clip) as usize, l.attached, tau.round() as i64);
        if let Some(hit) = memo.get(&key) {
            return hit.clone();
        }
        let sampler = sampler.expect("only sampled with a sampler");
        match sampler.sample(l.prepared, l.clip.target, tau, l.attached) {
            Sample::Pending => {
                state.incomplete = true;
                sampler.nearest(l.prepared, l.clip.target, tau, l.attached)
            }
            Sample::Ready(a) => {
                memo.insert(key, a.clone());
                a
            }
        }
    };
    for (li, l) in layers.iter().enumerate() {
        let s = &*l.spec;
        let te = stepped(l.tick, l.clip.start, l.step);
        let ts = l.time_scale;
        let local = |t: f64| l.t0 + (t - l.t0) * ts;
        let real = |t: f64| l.t0 + (t - l.t0) / ts;
        let beam = s.is_beam();
        let burst = s.emit_dur <= 0.0 && !beam;
        let prewarm = s.prewarm != 0.0;
        let start = if prewarm { s.start - s.life_max } else { s.start };
        let emit_dur = if burst || beam { 0.0 } else if prewarm { s.emit_dur + s.life_max } else { s.emit_dur };
        let trail = s.trail_span();
        let mut count = if beam { s.count } else { 0.0 };
        let (mut rate, mut rate_max) = (0.0, 1.0);
        if !beam {
            if let Some(param) = s.rate_param {
                rate_max = keyed_channel(l.clip, l.position, &l.effect, param.name()).max.max(1e-6);
                rate = s.rate * rate_max;
            } else {
                rate = s.rate;
            }
            if burst {
                count = paint::js_round(s.count);
            } else {
                count = ((rate * s.life_max).ceil() + 2.0).min((rate * emit_dur.min(FAR)).ceil() + 2.0);
                if count > LAYER_PARTICLES {
                    // More alive at once than a layer holds: emit fewer, evenly (each particle
                    // still lives its life), rather than cut the oldest.
                    rate *= (LAYER_PARTICLES - 2.0) / (count - 2.0);
                    count = LAYER_PARTICLES;
                    state.reduced = true;
                }
            }
        }
        count = count.min(LAYER_PARTICLES).max(0.0);
        if count == 0.0 || count.is_nan() {
            continue;
        }
        if instances + count > BATCH_INSTANCES {
            state.reduced = true;
            continue;
        }
        let now = local(te);
        let (first, last) = if beam {
            (te.floor(), te.floor())
        } else if burst {
            (real(start).floor(), real(start + s.burst_jitter).ceil() + 1.0)
        } else {
            (real(start).floor().max((te - (s.life_max + trail) / ts).floor() - 1.0), (te.ceil() + 1.0).min(real(start + emit_dur).floor() + 1.0))
        };
        if !beam && (last < first || now < start || burst && now > start + s.burst_jitter + s.life_max + trail) {
            continue;
        }
        // The newest births keep their rows when a long life needs more than a table holds.
        let first = if beam { first } else { first.max(last - TABLE_TICKS + 1.0) };
        let ticks = if beam { 1.0 } else { last - first + 1.0 };
        let mut block = None;
        if s.body
            && let Some((effect, current)) = &l.current
            && current.segments.as_ref().is_some_and(|s| !s.is_empty())
        {
            let world = s.world && sampler.is_some() && l.clip.target != Target::Scene;
            let key = (*effect, world);
            let at = match blocks.iter().position(|(k, _)| *k == key) {
                Some(at) => at,
                None => {
                    blocks.push((key, OutlineBlock { layer: li, world, first: f64::INFINITY, last: f64::NEG_INFINITY, seg_count: current.segments.as_ref().unwrap().len() / 4, rows: 0, start: 0 }));
                    blocks.len() - 1
                }
            };
            if world {
                let b = &mut blocks[at].1;
                b.first = b.first.min(first);
                b.last = b.last.max(first + ticks - 1.0);
            }
            block = Some(key);
        }
        // Records each particle draws: itself, its halo, its trail's pieces.
        let copies = if beam { 0.0 } else { s.trail.map_or(0.0, |t| t.segments as f64) + f64::from(u8::from(s.halo.is_some())) };
        let draws_now = if beam && s.shape == BEAM { 1.0 } else { count * (1.0 + copies) };
        plans.push(Plan { layer: li, beam, burst, start, emit_dur, count, rate, rate_max, tick0: first, ticks, block });
        instances += count;
        row_count += ticks;
        drawn += draws_now;
    }
    if plans.is_empty() {
        return None;
    }
    // One share for every layer: thinning is even across the frame.
    let keep = clamp(density, 0.0, 1.0).min(if drawn > budget { budget / drawn } else { 1.0 });
    if keep < 1.0 {
        state.reduced = true;
    }
    let mut floats = row_count as usize * ROW;
    for (_, block) in blocks.iter_mut() {
        block.rows = if block.world { (block.last - block.first + 1.0).clamp(1.0, TABLE_TICKS) as usize } else { 1 };
        if block.world {
            block.first = block.first.max(block.last - TABLE_TICKS + 1.0);
        } else {
            block.first = 0.0;
        }
        floats += block.rows * block.seg_count * SEGMENT;
    }
    let mut table = vec![0f32; floats];
    let mut specs: Vec<Arc<Spec>> = Vec::with_capacity(plans.len());
    let mut draws: Vec<Draw> = Vec::with_capacity(plans.len());
    // Rows first (each a whole row), then the outlines.
    let mut outline_at = row_count as usize * ROW;
    let mut at = 0usize;
    // Shared outlines first: one sampled body per birth tick, newest first.
    for (_, block) in blocks.iter_mut() {
        let l = &layers[block.layer];
        let current = &l.current.as_ref().unwrap().1;
        let own_segments = current.segments.as_ref().unwrap();
        let n = block.seg_count;
        block.start = outline_at;
        for r in (0..block.rows).rev() {
            let tau = block.first + r as f64;
            let o = outline_at + r * n * SEGMENT;
            let mut segs: &[f32] = own_segments;
            let sampled;
            if block.world && (tau - l.tick).abs() > 0.5 && tau <= l.last_present + 0.5 {
                sampled = sample_at(l, tau, state);
                if let Some(a) = &sampled
                    && let Some(s) = &a.segments
                    && !s.is_empty()
                {
                    segs = s;
                }
            }
            fit_outline(segs, n, &mut table[o..o + n * SEGMENT]);
        }
        outline_at += block.rows * n * SEGMENT;
    }
    // Variants of keyed layers, compiled once per birth tick within the batch.
    let mut variants: HashMap<(usize, usize, i64), Arc<Vec<Spec>>> = HashMap::new();
    for plan in &plans {
        let l = &layers[plan.layer];
        let s = &*l.spec;
        let table_row = at / ROW;
        let spec_index = specs.len() as u32;
        specs.push(l.spec.clone());
        let rate_channel = s.rate_param.map(|param| keyed_channel(l.clip, l.position, &l.effect, param.name()));
        let keyed_values = s.keyed.then(|| ["direction", "speed", "size"].map(|name| keyed_channel(l.clip, l.position, &l.effect, name)));
        let scene_xy = (l.clip.target == Target::Scene && s.fixed.is_none()).then(|| ["x", "y"].map(|name| keyed_channel(l.clip, l.position, &l.effect, name)));
        let scene_xy = scene_xy.filter(|[x, y]| x.keyed() || y.keyed());
        let block = plan.block.and_then(|key| blocks.iter().find(|(k, _)| *k == key).map(|(_, b)| b));
        let world = s.world && sampler.is_some() && l.clip.target != Target::Scene && s.fixed.is_none() && !plan.beam;
        let canvas = [l.prepared.doc.canvas[0] as f64, l.prepared.doc.canvas[1] as f64];
        let body_scale_now = l.current.as_ref().map_or(1.0, |(_, a)| styles::body_scale(a.measure));
        let mut last_spec = spec_index;
        // Newest first: an interactive frame's budget samples the newest births exactly.
        for k in (0..plan.ticks as usize).rev() {
            let tau = plan.tick0 + k as f64;
            let o = at + k * ROW;
            let mut anchor = l.point;
            let mut present = tau <= l.last_present + 0.5;
            let mut scale = body_scale_now;
            let mut ground = l.ground;
            if let Some(fixed) = s.fixed {
                anchor = fixed;
                present = true;
            } else if let Some([x, y]) = &scene_xy {
                anchor = [x.at(tau) * canvas[0], y.at(tau) * canvas[1]];
            } else if world && (tau - l.tick).abs() > 0.5 && present {
                match sample_at(l, tau, state) {
                    Some(a) => {
                        anchor = a.point;
                        scale = styles::body_scale(a.measure);
                        ground = a.bottom;
                    }
                    None => present = false,
                }
                // Inside a movieclip, the container's own move at that tick moves the birth.
                if let (Some(c), Some(sampler)) = (l.container, sampler) {
                    let outer_tau = c.tick - (l.tick - tau);
                    if let Some(then) = sample_or_nearest(sampler, c.prepared, Target::Figure { uid: c.uid }, outer_tau, false, state) {
                        let m = l.matrix;
                        let det = m[0] * m[3] - m[1] * m[2];
                        if det.abs() > 1e-12 {
                            let (dx, dy) = (then.point[0] - c.root[0], then.point[1] - c.root[1]);
                            anchor[0] += (m[3] * dx - m[2] * dy) / det;
                            anchor[1] += (-m[1] * dx + m[0] * dy) / det;
                        }
                    }
                }
            }
            let in_window = s.prewarm != 0.0 || tau >= l.clip.start.floor() && l.clip.duration.is_none_or(|d| tau < l.clip.start + d);
            let mut emit = if present && (plan.burst || in_window) { 1.0 } else { 0.0 };
            if emit != 0.0
                && let Some(channel) = &rate_channel
                && plan.rate_max > 0.0
            {
                emit = channel.at(tau) / plan.rate_max;
            }
            table[o + row::X] = anchor[0] as f32;
            table[o + row::Y] = anchor[1] as f32;
            table[o + row::EMIT] = clamp(emit, 0.0, 1.0) as f32;
            if let Some([dir, speed, size]) = &keyed_values {
                table[o + row::DIR] = (dir.at(tau) * std::f64::consts::PI / 180.0) as f32;
                table[o + row::SPEED] = speed.at(tau) as f32;
                table[o + row::SIZE] = size.at(tau) as f32;
            } else {
                table[o + row::DIR] = 0.0;
                table[o + row::SPEED] = 1.0;
                table[o + row::SIZE] = 1.0;
            }
            // Aimed streams leave toward the beam's aim; their speed scales with its distance.
            if s.aimed
                && let Some(aim) = l.aim
            {
                let (dx, dy) = (aim[0] - anchor[0], aim[1] - anchor[1]);
                table[o + row::DIR] = super::fastmath::atan2(dy, dx) as f32;
                table[o + row::SPEED] = (super::fastmath::hypot(dx, dy) / 100.0).max(0.15) as f32;
            }
            table[o + row::SCALE] = if s.body_scaled { scale as f32 } else { 1.0 };
            table[o + row::GROUND] = ground as f32;
            // The layer as it was keyed at this birth.
            let mut variant = spec_index;
            if l.keyed && !plan.beam && (tau - l.tick).abs() > 0.5 {
                let key = (Arc::as_ptr(l.clip) as usize, l.position, tau as i64);
                let compiled = variants
                    .entry(key)
                    .or_insert_with(|| {
                        let effect = sample_effect(l.clip, l.position, tau.min(l.ctx.end - 1e-6).max(l.clip.start));
                        Arc::new(styles::compile(&effect.params, &l.ctx))
                    })
                    .clone();
                if let Some(v) = compiled.get(l.index).filter(|v| v.shape == s.shape) {
                    if *v == *specs[last_spec as usize] {
                        variant = last_spec;
                    } else if *v != *s {
                        specs.push(Arc::new(v.clone()));
                        variant = specs.len() as u32 - 1;
                    }
                }
            }
            last_spec = variant;
            table[o + row::SPEC] = variant as f32;
        }
        at += plan.ticks as usize * ROW;
        let m = l.matrix;
        let det = (m[0] * m[3] - m[1] * m[2]).abs().sqrt();
        draws.push(Draw {
            spec: spec_index,
            count: plan.count as u32,
            shape: s.shape,
            blend: s.blend,
            uid: l.uid,
            placement: s.placement,
            scene: l.scene,
            material: s.material.map_or(-1, |m| m.row()),
            tick: l.tick,
            step: l.step,
            seed: l.seed,
            t0: l.t0,
            time_scale: l.time_scale,
            clip: [l.clip.start, l.clip.duration.map_or(FAR, |d| l.clip.start + d)],
            start: plan.start,
            emit_dur: plan.emit_dur,
            rate: plan.rate,
            keep,
            table: table_row as u32,
            tick0: plan.tick0,
            ticks: plan.ticks as u32,
            block: block.map(|b| Block { start: b.start as u32, segments: b.seg_count as u32, rows: if b.world { b.rows as u32 } else { 1 }, first: b.first }),
            matrix: m,
            scale: if det == 0.0 || det.is_nan() { 1.0 } else { det },
            offset: [0.0, 0.0],
            point: l.point,
            aim: l.aim.unwrap_or(l.point),
            ground: l.ground,
            canvas,
            alpha: s.alpha * l.alpha,
            world,
        });
    }
    let particles = plans.iter().map(|p| p.count as u32).sum();
    Some(Batch { tick: layers[plans[0].layer].tick, specs, table, draws, particles, incomplete: false, reduced: state.reduced })
}

/// An outline resampled to `count` segments, each with the outline's length to its end.
fn fit_outline(segments: &[f32], count: usize, out: &mut [f32]) {
    let n = segments.len() / 4;
    if n == 0 {
        return;
    }
    for i in 0..count {
        let j = if n == count { i } else { ((n - 1).min((i as f64 * n as f64 / count as f64).floor() as usize)).min(n - 1) };
        out[i * 4..i * 4 + 4].copy_from_slice(&segments[j * 4..j * 4 + 4]);
    }
    // Running lengths of the chosen segments.
    let base = count * 4;
    let mut running = 0.0f32;
    for i in 0..count {
        let s = &out[i * 4..i * 4 + 4];
        running += ((s[2] - s[0]).powi(2) + (s[3] - s[1]).powi(2)).sqrt();
        out[base + i] = running;
    }
}
