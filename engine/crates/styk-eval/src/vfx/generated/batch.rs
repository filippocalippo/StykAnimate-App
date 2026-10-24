//! A frame's generated effects as one batch (`buildGeneratorBatch`,
//! `collectLayers`, `packBatch` in src/vfx-generators.mjs): every layer's
//! record (128 numbers: emission, motion, colour, transform, materials) and a
//! table of per-tick values read at each particle's birth (anchor, emission
//! amount, keyed direction, speed and size) and of outlines. Particles are a
//! pure function of a record, the table, an instance index and the tick
//! ([`super::particle`]); nothing is simulated or kept between frames.
//!
//! Values are computed in `f64` operation for operation as the editor, then
//! stored in single precision as its `Float32Array`s are.

use std::collections::HashMap;
use std::sync::Arc;

use super::anchors::{anchor, Anchor, Sample, Sampler};
use super::layers::*;
use super::styles::{self, Context};
use crate::doc::{BackgroundKind, Document};
use crate::eval::{Frame, Prepared};
use crate::geometry::Scene;
use crate::vfx::clips::{sample_keys, Field};
use crate::vfx::{paint, Clip, Effect, Kind, ParamValue, Params, Target};

/// Numbers per layer record: 32 vectors of four.
pub const RECORD_FLOATS: usize = 128;
/// `LIMITS`: particles per layer and per frame, layers per frame, birth-table ticks.
pub const LAYER_PARTICLES: f64 = 65536.0;
pub const BATCH_PARTICLES: f64 = 262144.0;
pub const BATCH_LAYERS: usize = 256;
pub const TABLE_TICKS: f64 = 420.0;
/// Movieclips nest generated effects at most this deep (`MAX_NESTING`).
pub const MAX_NESTING: u32 = 4;

/// One draw of a batch: a layer's particles, or an extra draw of them (a trail
/// echo, a glow halo, an outline), placed before or after its target's artwork.
#[derive(Clone, Debug, PartialEq)]
pub struct Draw {
    /// Its record, by index (`records[record * 128..]`).
    pub record: u32,
    /// Instances: particles, a beam's one, or arc segments.
    pub count: u32,
    pub shape: u8,
    /// [`NORMAL`] or [`ADD`].
    pub blend: u8,
    /// The figure (or the movieclip container) it is drawn beside; `None` for the scene.
    pub uid: Option<u32>,
    pub placement: Placement,
    /// A scene effect of the top-level document.
    pub scene: bool,
    /// The material row a sprite samples, or -1.
    pub material: i32,
}

/// Everything one frame draws for generated effects.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Batch {
    pub tick: f64,
    pub records: Vec<f32>,
    pub table: Vec<f32>,
    pub draws: Vec<Draw>,
    /// Instances over every draw.
    pub particles: u32,
    /// Some earlier-tick anchors were not ready: trails used the current pose.
    pub incomplete: bool,
}

impl Batch {
    /// Record `i` of a draw.
    pub fn record(&self, draw: &Draw) -> &[f32] {
        let o = draw.record as usize * RECORD_FLOATS;
        &self.records[o..o + RECORD_FLOATS]
    }

    /// `drawMatrix`: a draw's stage transform, its movieclip matrix then its offset.
    pub fn matrix(&self, draw: &Draw) -> [f64; 6] {
        let r = self.record(draw);
        [r[104] as f64, r[105] as f64, r[106] as f64, r[107] as f64, r[108] as f64 + r[48] as f64, r[109] as f64 + r[49] as f64]
    }

    /// The material rows the batch's sprites sample.
    pub fn materials(&self) -> impl Iterator<Item = u32> + '_ {
        self.draws.iter().filter(|d| d.material >= 0).map(|d| d.material as u32)
    }

    /// `generatorBatchBounds`: the stage rectangle the batch's live particles and beams
    /// cover (x, y, width, height), each grown by its reach (`particleExtent`, a beam's
    /// width and glow), or `None` when nothing is alive.
    pub fn bounds(&self) -> Option<[f64; 4]> {
        use super::particle::{beam_tip, evaluate, stepped_time};
        let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
        for draw in &self.draws {
            let r = self.record(draw);
            let v = |i: usize| r[i] as f64;
            let (mut lx0, mut ly0, mut lx1, mut ly1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
            let mut grow = |x: f64, y: f64, reach: f64| {
                lx0 = lx0.min(x - reach);
                ly0 = ly0.min(y - reach);
                lx1 = lx1.max(x + reach);
                ly1 = ly1.max(y + reach);
            };
            if draw.shape == BEAM || draw.shape == ARC {
                let tip = beam_tip(r, stepped_time(r));
                let pad = (v(56) + v(122)) * 4.0 + v(63) + 16.0;
                grow(v(36), v(37), pad);
                grow(tip[0], tip[1], pad);
            } else {
                for i in 0..draw.count {
                    if let Some(p) = evaluate(self, draw, i) {
                        let speed = styk_math::hypot(p.vx, p.vy);
                        // `particleExtent`.
                        let reach = match draw.shape {
                            RING => p.size * (1.0 + v(23) * 2.0),
                            STREAK => p.size + speed * v(22),
                            SPRITE => p.size.max(p.size * v(125) + 0.5 * speed * v(22)),
                            SQUARE | CHUNK => p.size * 1.42,
                            _ => p.size * v(125).max(1.0),
                        };
                        grow(p.x, p.y, reach);
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

    /// `offsetGeneratorBatch`: draws beside `uid` move by `offset(uid)` (a live drag).
    pub fn offset(&mut self, offset: impl Fn(u32) -> Option<[f64; 2]>) {
        for draw in &self.draws {
            let Some(d) = draw.uid.and_then(&offset) else { continue };
            if d[0] == 0.0 && d[1] == 0.0 {
                continue;
            }
            let o = draw.record as usize * RECORD_FLOATS;
            self.records[o + 48] = (self.records[o + 48] as f64 + d[0]) as f32;
            self.records[o + 49] = (self.records[o + 49] as f64 + d[1]) as f32;
        }
    }
}

/// Whether a document, or a movieclip nested in it (8 levels at most), has a generated effect (`hasGeneratedEffects`).
pub fn has_generators(doc: &Document) -> bool {
    fn within(doc: &Document, depth: u32) -> bool {
        if depth > 8 {
            return false;
        }
        doc.vfx_clips.as_ref().is_some_and(|clips| clips.clips.iter().any(|clip| clip.has_generators()))
            || doc.figures.iter().any(|figure| figure.movieclip.as_ref().is_some_and(|clip| within(&clip.document, depth + 1)))
    }
    within(doc, 0)
}

fn echo_span(s: &Spec) -> f64 {
    s.echoes.map_or(0.0, |e| e.count as f64 * e.lag)
}

/// `resolvedParams(effect)`: the typed parameters (already resolved).
fn params(effect: &Effect) -> &Params {
    &effect.params
}

/// `generatorClipTail`: ticks after a timed clip's end during which its
/// particles are still visible (their longest lifetime, trail and jitter).
pub fn clip_tail(clip: &Clip) -> f64 {
    let Some(duration) = clip.duration else { return 0.0 };
    let mut tail = 0.0f64;
    let end = clip.start + duration;
    for effect in &clip.effects {
        if !effect.kind().is_generator() {
            continue;
        }
        let p = params(effect);
        let delay = p.delay();
        if delay >= duration {
            continue;
        }
        let ctx = Context { start: clip.start + delay, end, window: duration - delay, timed: true, fade_out: 0.0, scene: false, body_height: None, start_point: [0.0, 0.0] };
        for l in styles::compile(p, &ctx) {
            if l.shape != BEAM && l.shape != ARC {
                tail = tail.max(l.start + if l.emit_dur > 0.0 { l.emit_dur } else { l.burst_jitter } + l.life_max + echo_span(&l) - end);
            }
        }
    }
    tail.max(0.0).ceil()
}

/// `backgroundIsLight`: whether Auto layers paint solid (a light, solid-colour
/// scene) or add light (a dark scene; images count as dark).
pub fn background_is_light(doc: &Document, frame: &Frame) -> bool {
    if doc.layers.as_ref().is_some_and(|l| !l.scene_visible) {
        return false;
    }
    let lum = |n: u32| -> Option<f64> {
        if (n >> 24) < 13 {
            return None;
        }
        Some(0.2126 * (n >> 16 & 255) as f64 / 255.0 + 0.7152 * (n >> 8 & 255) as f64 / 255.0 + 0.0722 * (n & 255) as f64 / 255.0)
    };
    let light = |l: Option<f64>| l.is_some_and(|l| l > 0.6);
    if let Some(color) = frame.background_color {
        return light(lum(color));
    }
    let Some(bg) = doc.backgrounds.iter().find(|b| b.id == frame.background) else { return true };
    match &bg.kind {
        BackgroundKind::Paint(p) if !p.stops.is_empty() => {
            let mut sum = 0.0;
            for s in &p.stops {
                sum += (0.2126 * s.rgb[0] as f64 + 0.7152 * s.rgb[1] as f64 + 0.0722 * s.rgb[2] as f64) / 255.0;
            }
            sum / p.stops.len() as f64 > 0.6
        }
        BackgroundKind::Linear { a, b, .. } | BackgroundKind::Radial { a, b, .. } => match (lum(*a), lum(*b)) {
            (Some(a), Some(b)) => (a + b) / 2.0 > 0.6,
            _ => false,
        },
        BackgroundKind::Solid { argb } => light(lum(*argb)),
        _ => false,
    }
}

/// A keyed parameter of a clip's effect as a function of the tick, and the
/// largest value it reaches, which sizes emission capacity (`keyedChannel`).
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

/// One layer of one effect, ready to pack.
struct Layer<'a> {
    prepared: &'a Prepared,
    tick: f64,
    clip: &'a Arc<Clip>,
    /// The effect's position in its clip.
    position: usize,
    effect: Arc<Effect>,
    spec: Spec,
    alpha: f64,
    matrix: [f64; 6],
    seed: u32,
    uid: Option<u32>,
    scene: bool,
    /// The target now, and which effect it belongs to (outlines are shared per effect).
    current: Option<(usize, Arc<Anchor>)>,
    point: [f64; 2],
    aim: Option<[f64; 2]>,
    ground: f64,
    step: f64,
    attached: bool,
}

/// What a nested movieclip document contributes, drawn beside its container.
struct Nest {
    matrix: [f64; 6],
    container: Option<u32>,
    opacity: f64,
    depth: u32,
}

/// Canvas-style affine product `p·m`: apply `m` first, then `p`.
fn compose(p: [f64; 6], m: [f64; 6]) -> [f64; 6] {
    [p[0] * m[0] + p[2] * m[1], p[1] * m[0] + p[3] * m[1], p[0] * m[2] + p[2] * m[3], p[1] * m[2] + p[3] * m[3], p[0] * m[4] + p[2] * m[5] + p[4], p[1] * m[4] + p[3] * m[5] + p[5]]
}

const IDENTITY: [f64; 6] = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

struct State {
    incomplete: bool,
    /// Effects whose current anchor was read, for shared outlines.
    effects: usize,
}

/// Generator layers of one document at one frame, its nested movieclips' after
/// its own (`collectLayers`). `tick` is `_vfxTimelineTick`: `None` when the
/// frame carries none, which draws no clip of this document.
#[allow(clippy::too_many_arguments)]
fn collect<'a>(prepared: &'a Prepared, frame: &Frame, scene: &Scene, tick: Option<f64>, sampler: Option<&dyn Sampler>, nest: &Nest, state: &mut State, layers: &mut Vec<Layer<'a>>) {
    let doc = &*prepared.doc;
    let (width, height) = (doc.canvas[0] as f64, doc.canvas[1] as f64);
    if let (Some(tick), Some(clips)) = (tick, doc.vfx_clips.as_deref()) {
        for clip in &clips.clips {
            if layers.len() >= BATCH_LAYERS {
                return;
            }
            // `generatorClipActiveAt`.
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
            for (index, effect) in clip.sample(at, false).into_iter().enumerate() {
                if !effect.kind().is_generator() || !effect.enabled {
                    continue;
                }
                let p = params(&effect);
                let alpha = strength * p.effect_strength();
                if alpha <= 0.0 {
                    continue;
                }
                let kind = effect.kind();
                let wants_body = kind == Kind::Aura || matches!(p, Params::Particles(q) if q.shape == crate::vfx::registry::EmitShape::Body);
                let attached = clip.include_attached || kind == Kind::Aura;
                let current = if scene_target { None } else { anchor(doc, scene, frame, clip.target, wants_body, attached).map(Arc::new) };
                if !scene_target && current.is_none() {
                    continue;
                }
                let delay = p.delay();
                if timed && delay >= clip.duration.unwrap_or(FAR) {
                    continue;
                }
                let (x, y) = position(p);
                let stage_point = [x * width, y * height];
                let start = clip.start + delay;
                if tick < start {
                    continue;
                }
                let start_anchor: Option<Arc<Anchor>> = if scene_target {
                    None
                } else if tick <= start + 0.5 || sampler.is_none() {
                    current.clone()
                } else {
                    match sampler.unwrap().sample(prepared, clip.target, start, clip.include_attached) {
                        Sample::Pending => {
                            state.incomplete = true;
                            current.clone()
                        }
                        Sample::Ready(sample) => sample.or_else(|| current.clone()),
                    }
                };
                // Auras scale with the target's height, in steps so compiled layers can be reused.
                let ctx = Context {
                    start,
                    end,
                    window: if timed { clip.duration.unwrap() - delay } else { FAR },
                    timed,
                    fade_out: clip.fade_out,
                    scene: scene_target,
                    body_height: current.as_ref().map(|c| paint::js_round(c.height / 4.0) * 4.0),
                    start_point: if scene_target {
                        stage_point
                    } else {
                        let a = start_anchor.as_ref().expect("a target present now has a start anchor");
                        if kind == Kind::Explosion && matches!(clip.target, Target::Figure { .. }) { a.center } else { a.point }
                    },
                };
                let mut aim = None;
                if let Params::Beam(b) = p {
                    aim = Some([b.aim_x * width, b.aim_y * height]);
                    if b.aim_uid != 0 {
                        let target = if b.aim_handle != 0 { Target::Segment { uid: b.aim_uid, handle: b.aim_handle, figure_type: None } } else { Target::Figure { uid: b.aim_uid } };
                        if let Some(a) = anchor(doc, scene, frame, target, false, false) {
                            aim = Some(a.point);
                        }
                    }
                }
                let seed_base = (seed(p).wrapping_add(1).wrapping_mul(2654435761)).wrapping_add((index as u32 + 1).wrapping_mul(40503));
                let effect_id = state.effects;
                state.effects += 1;
                let step = styles::step(p);
                for (li, spec) in styles::compile(p, &ctx).into_iter().enumerate() {
                    layers.push(Layer {
                        prepared,
                        tick,
                        clip,
                        position: index,
                        effect: effect.clone(),
                        spec,
                        alpha,
                        matrix: nest.matrix,
                        seed: seed_base.wrapping_add((li as u32 + 1).wrapping_mul(97531)) & 0xffffff,
                        uid: nest.container.or(if scene_target { None } else { clip.target.uid() }),
                        scene: nest.container.is_none() && scene_target,
                        current: current.clone().map(|c| (effect_id, c)),
                        point: if scene_target { stage_point } else { current.as_ref().unwrap().point },
                        aim,
                        // Scene explosions stand on the ground at their own position.
                        ground: if scene_target {
                            if kind == Kind::Explosion { stage_point[1] + 40.0 * size(p) } else { height }
                        } else {
                            start_anchor.as_ref().map_or(height, |a| a.bottom)
                        },
                        step,
                        attached,
                    });
                }
            }
        }
    }
    if nest.depth >= MAX_NESTING {
        return;
    }
    // Movieclip containers whose documents carry generated effects, in the editor's object order.
    for slot in object_order(frame) {
        let Some(g) = scene.objects.get(slot).filter(|g| g.resolved) else { continue };
        let object = &frame.objects[slot];
        // A styled instance shares its base figure's movieclip.
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
        let inner = Nest { matrix: compose(nest.matrix, matrix), container: nest.container.or(Some(object.uid)), opacity: nest.opacity * (1.0 - object.transparency / 255.0), depth: nest.depth + 1 };
        collect(&clip.prepared, &inner_frame, &inner_scene, inner_tick, sampler, &inner, state, layers);
    }
}

/// The order the editor's geometry lists objects (`geometry.objects`): free
/// figures by slot, then what is joined to each, breadth first.
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
        // Auras have no stage position (`p.x` is undefined: NaN).
        _ => (f64::NAN, f64::NAN),
    }
}

fn size(p: &Params) -> f64 {
    match p {
        Params::Explosion(p) => p.size,
        Params::Particles(p) => p.size,
        Params::Smoke(p) => p.size,
        _ => f64::NAN,
    }
}

/// The generated effects of one frame, or `None` when nothing generated is
/// visible (`buildGeneratorBatch`). `tick` is the frame's `_vfxTimelineTick`;
/// `sampler` supplies anchors on earlier ticks (without one, trails follow the
/// current pose); `density` thins emission (1 draws everything).
pub fn build(prepared: &Prepared, frame: &Frame, scene: &Scene, tick: Option<f64>, sampler: Option<&dyn Sampler>, density: f64) -> Option<Batch> {
    let mut layers = Vec::new();
    let mut state = State { incomplete: false, effects: 0 };
    collect(prepared, frame, scene, tick, sampler, &Nest { matrix: IDENTITY, container: None, opacity: 1.0, depth: 0 }, &mut state, &mut layers);
    if layers.is_empty() {
        return None;
    }
    let light = background_is_light(&prepared.doc, frame);
    let mut batch = pack(&layers, sampler, density, light, &mut state)?;
    batch.incomplete = state.incomplete;
    Some(batch)
}

/// A layer's plan: capacity and birth rows.
struct Plan {
    layer: usize,
    beam: bool,
    burst: bool,
    start: f64,
    count: f64,
    rate: f64,
    rate_max: f64,
    tick0: f64,
    ticks: f64,
    /// Its shared outline block: (effect, world).
    block: Option<(usize, bool)>,
}

/// An outline shared by the layers of one effect: one row per birth tick for
/// trails in world space, one current outline otherwise.
struct Block {
    layer: usize,
    world: bool,
    first: f64,
    last: f64,
    seg_count: usize,
    rows: usize,
    start: usize,
}

/// `packBatch`: plan every layer's capacity and birth rows, then fill one
/// table. Echoes, halos and outlines are extra draws of the same particles.
fn pack(layers: &[Layer<'_>], sampler: Option<&dyn Sampler>, density: f64, light: bool, state: &mut State) -> Option<Batch> {
    let mut plans: Vec<Plan> = Vec::new();
    // Blocks by effect, 'world' and 'fixed' in the order first needed.
    let mut blocks: Vec<((usize, bool), Block)> = Vec::new();
    let (mut particles, mut row_count, mut draw_count) = (0.0f64, 0.0f64, 0usize);
    // Earlier-tick samples shared by the layers of one clip within this batch.
    let mut memo: HashMap<(usize, i64), Option<Arc<Anchor>>> = HashMap::new();
    let mut sample_at = |l: &Layer<'_>, tau: f64, state: &mut State| -> Option<Arc<Anchor>> {
        let key = (Arc::as_ptr(l.clip) as usize, if l.attached { -1 - tau as i64 } else { tau as i64 });
        if let Some(hit) = memo.get(&key) {
            return hit.clone();
        }
        match sampler.expect("only sampled with a sampler").sample(l.prepared, l.clip.target, tau, l.attached) {
            Sample::Pending => {
                state.incomplete = true;
                None
            }
            Sample::Ready(a) => {
                memo.insert(key, a.clone());
                a
            }
        }
    };
    for (li, l) in layers.iter().enumerate() {
        if plans.len() >= BATCH_LAYERS {
            break;
        }
        let s = &l.spec;
        let tick = l.tick;
        let cs = l.clip.start;
        let te = if l.step > 1.0 { cs + ((tick - cs) / l.step).floor() * l.step } else { tick };
        let beam = s.shape == BEAM || s.shape == ARC;
        let burst = s.emit_dur <= 0.0 && !beam;
        let start = if s.prewarm != 0.0 { s.start - s.life_max } else { s.start };
        let echo = echo_span(s);
        let mut count = if beam { s.count } else { 0.0 };
        let (mut rate, mut rate_max) = (0.0, 1.0);
        if !beam {
            if let Some(param) = s.rate_param {
                rate_max = keyed_channel(l.clip, l.position, &l.effect, param.name()).max.max(1e-6);
                rate = s.rate * rate_max;
            } else {
                rate = s.rate;
            }
            if s.emit_dur > 0.0 {
                let window = if s.prewarm != 0.0 { s.emit_dur + s.life_max } else { s.emit_dur };
                count = ((rate * s.life_max).ceil() + 2.0).min((rate * window.min(FAR)).ceil() + 2.0);
            } else {
                count = paint::js_round(s.count);
            }
        }
        count = count.min(LAYER_PARTICLES).min(BATCH_PARTICLES - particles).max(0.0);
        if count == 0.0 || count.is_nan() {
            continue;
        }
        let first = if burst { start.floor() } else { start.floor().max((te - s.life_max - echo).floor() - 1.0) };
        let last = if burst {
            (start + s.burst_jitter).ceil() + 1.0
        } else {
            ((te).ceil() + 1.0).min((start + if s.prewarm != 0.0 { s.emit_dur + s.life_max } else { s.emit_dur }).floor() + 1.0)
        };
        if !beam && (last < first || te < start || burst && te > start + s.burst_jitter + s.life_max + echo) {
            continue;
        }
        let tick0 = if beam { te.floor() } else { first };
        let ticks = ((if beam { 0.0 } else { last - first }) + 1.0).clamp(1.0, TABLE_TICKS);
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
                    blocks.push((key, Block { layer: li, world, first: f64::INFINITY, last: f64::NEG_INFINITY, seg_count: current.segments.as_ref().unwrap().len() / 4, rows: 0, start: 0 }));
                    blocks.len() - 1
                }
            };
            if world {
                let b = &mut blocks[at].1;
                b.first = b.first.min(tick0);
                b.last = b.last.max(tick0 + ticks - 1.0);
            }
            block = Some(key);
        }
        let copies = if beam { usize::from(s.outline.is_some()) } else { s.echoes.map_or(0, |e| e.count as usize) + usize::from(s.halo.is_some()) + usize::from(s.outline.is_some()) };
        plans.push(Plan { layer: li, beam, burst, start, count, rate, rate_max, tick0, ticks, block });
        particles += count;
        row_count += ticks;
        draw_count += 1 + copies;
    }
    if plans.is_empty() {
        return None;
    }
    let mut floats = row_count as usize * 8;
    // Effects in the order their first block appeared, then 'world' before or after 'fixed' as first needed.
    let mut order: Vec<usize> = Vec::new();
    for (i, ((effect, _), _)) in blocks.iter().enumerate() {
        if !order.iter().any(|&j| blocks[j].0.0 == *effect) {
            for (k, ((e, _), _)) in blocks.iter().enumerate() {
                if e == effect {
                    order.push(k);
                }
            }
        }
        let _ = i;
    }
    for (_, block) in blocks.iter_mut() {
        block.rows = if block.world { (block.last - block.first + 1.0).min(TABLE_TICKS) as usize } else { 1 };
        if !block.world {
            block.first = 0.0;
        }
        floats += block.rows * block.seg_count * 4;
    }
    let mut table = vec![0f32; floats];
    let mut records = vec![0f32; draw_count * RECORD_FLOATS];
    let mut draws: Vec<Draw> = Vec::with_capacity(draw_count);
    let mut at = 0usize;
    let mut drawn = 0u32;
    // Shared outlines first: one sampled body per birth tick of the union window.
    for &k in &order {
        let block = &mut blocks[k].1;
        let l = &layers[block.layer];
        let current = &l.current.as_ref().unwrap().1;
        let own = current.segments.as_ref().unwrap();
        let size = block.seg_count * 4;
        block.start = at / 4;
        for r in 0..block.rows {
            let tau = block.first + r as f64;
            let mut data: Arc<[f32]> = own.clone();
            if block.world
                && (tau - l.tick).abs() > 0.5
                && let Some(a) = sample_at(l, tau, state)
                && let Some(segments) = &a.segments
            {
                data = fit_segments(segments, block.seg_count);
            }
            table[at..at + size].copy_from_slice(&data[..size]);
            at += size;
        }
    }
    for plan in &plans {
        let l = &layers[plan.layer];
        let s = &l.spec;
        let tick = l.tick;
        let count = plan.count;
        let table_start = at / 4;
        let rate_channel = s.rate_param.map(|param| keyed_channel(l.clip, l.position, &l.effect, param.name()));
        let keyed = s.keyed.then(|| ["direction", "speed", "size"].map(|name| keyed_channel(l.clip, l.position, &l.effect, name)));
        let block = plan.block.and_then(|key| blocks.iter().find(|(k, _)| *k == key).map(|(_, b)| b));
        for k in 0..plan.ticks as usize {
            let tau = plan.tick0 + k as f64;
            let mut anchor = l.point;
            if let Some(fixed) = s.fixed {
                anchor = fixed;
            } else if l.clip.target != Target::Scene && s.world && sampler.is_some() && (tau - tick).abs() > 0.5 {
                anchor = sample_at(l, tau, state).map_or(l.point, |a| a.point);
            }
            let in_window = s.prewarm != 0.0 || tau >= l.clip.start.floor() && l.clip.duration.is_none_or(|d| tau < l.clip.start + d);
            let mut emit = if plan.burst || in_window { 1.0 } else { 0.0 };
            if emit != 0.0
                && let Some(channel) = &rate_channel
                && plan.rate_max > 0.0
            {
                emit = channel.at(tau) / plan.rate_max;
            }
            table[at] = anchor[0] as f32;
            table[at + 1] = anchor[1] as f32;
            table[at + 2] = clamp(emit * density, 0.0, 1.0) as f32;
            if let Some([dir, speed, size]) = &keyed {
                table[at + 3] = (dir.at(tau) * std::f64::consts::PI / 180.0) as f32;
                table[at + 4] = speed.at(tau) as f32;
                table[at + 5] = size.at(tau) as f32;
            } else {
                table[at + 3] = 0.0;
                table[at + 4] = 1.0;
                table[at + 5] = 1.0;
            }
            // Aimed streams leave toward the beam's aim; their speed scales with its distance.
            if s.aimed
                && let Some(aim) = l.aim
            {
                let (dx, dy) = (aim[0] - anchor[0], aim[1] - anchor[1]);
                table[at + 3] = styk_math::atan2(dy, dx) as f32;
                table[at + 4] = (styk_math::hypot(dx, dy) / 100.0).max(0.15) as f32;
            }
            at += 8;
        }
        let mut colors = s.colors.unwrap_or([[1.0, 1.0, 1.0, 1.0]; COLOR_STOPS]);
        let opacity = s.opacity.unwrap_or([1.0; COLOR_STOPS]);
        let blend = if s.blend == AUTO { if light { NORMAL } else { ADD } } else { s.blend };
        // Auto layers painted solid on a light stage borrow their nearest saturated
        // colour for white-hot stops, which would otherwise vanish against it.
        if light && s.blend == AUTO && !plan.beam {
            colors = ink_stops(colors);
        }
        let aim = l.aim.unwrap_or(l.point);
        let m = l.matrix;
        let material = s.material;
        let mut rec: Vec<f64> = vec![
            plan.start,
            if s.emit_dur > 0.0 { if s.prewarm != 0.0 { s.emit_dur + s.life_max } else { s.emit_dur } } else { 0.0 },
            count,
            plan.rate,
            s.life_min,
            s.life_max,
            l.step,
            l.seed as f64,
            s.speed_min,
            s.speed_max,
            s.angle,
            s.spread,
            s.gravity,
            s.drag,
            s.radial,
            s.turb,
            s.turb_scale,
            s.spin,
            s.shape as f64,
            blend as f64,
            s.size0,
            s.size1,
            s.stretch,
            s.softness,
            s.fade_in,
            s.fade_out,
            s.alpha * l.alpha,
            s.color_mode,
            s.emit_shape as f64,
            s.emit_radius,
            table_start as f64,
            plan.tick0,
            plan.ticks,
            block.map_or(0.0, |b| b.start as f64),
            block.map_or(0.0, |b| b.seg_count as f64),
            block.filter(|b| b.world).map_or(0.0, |b| b.rows as f64),
            l.point[0],
            l.point[1],
            aim[0],
            aim[1],
            s.inherit,
            s.burst_jitter,
            s.size_jitter,
            s.size_curve,
            s.collide,
            l.ground,
            l.prepared.doc.canvas[0] as f64,
            l.prepared.doc.canvas[1] as f64,
            0.0,
            0.0,
            l.clip.start,
            l.clip.duration.map_or(FAR, |d| l.clip.start + d),
            s.clip_fade_in,
            s.clip_fade_out,
            tick,
            s.prewarm,
            s.beam_w,
            s.wobble,
            s.grow,
            s.fire_start,
            s.fire_end,
            s.fade_frames,
            s.arc_segs,
            s.arc_amp,
        ];
        for color in &colors {
            rec.extend_from_slice(color);
        }
        rec.extend_from_slice(&opacity);
        rec.extend_from_slice(&[m[0], m[1], m[2], m[3], m[4], m[5], { let d = (m[0] * m[3] - m[1] * m[2]).abs().sqrt(); if d == 0.0 || d.is_nan() { 1.0 } else { d } }, block.filter(|b| b.world).map_or(0.0, |b| b.first)]);
        rec.extend_from_slice(&[
            if plan.beam { s.beam_style } else { material.map_or(0.0, |m| (m.row + 1) as f64) },
            material.map_or(0.0, |m| (m.col * 16 + m.count) as f64),
            s.shade,
            s.rotate as f64,
            s.spin_jitter,
            s.orbit,
            s.curl,
            s.curl_scale,
            s.size_mode as f64,
            1.0,
            0.0,
            s.squash.max(0.05),
            s.flicker,
            s.aspect,
            s.frame_rate,
            s.wind,
        ]);
        debug_assert_eq!(rec.len(), RECORD_FLOATS);
        let row = material.map_or(-1, |m| m.row as i32);
        let count_u = count as u32;
        let mut push = |r: &[f64], shape: u8, blend: u8, row: i32| {
            let o = draws.len() * RECORD_FLOATS;
            for (i, v) in r.iter().enumerate() {
                records[o + i] = *v as f32;
            }
            draws.push(Draw { record: draws.len() as u32, count: count_u, shape, blend, uid: l.uid, placement: s.placement, scene: l.scene, material: row });
            drawn += count_u;
        };
        // Older echoes first, then the halo and outline beneath the particles themselves.
        if let Some(e) = s.echoes
            && !plan.beam
        {
            for k in (1..=e.count).rev() {
                let mut r = rec.clone();
                r[54] = tick - k as f64 * e.lag;
                r[26] *= styk_math::pow(e.alpha, k as f64);
                r[121] = styk_math::pow(e.size, k as f64);
                push(&r, s.shape, blend, row);
            }
        }
        if let Some(h) = s.halo
            && !plan.beam
        {
            let mut r = rec.clone();
            r[18] = DISC as f64;
            r[23] = 2.2;
            r[112] = 0.0;
            r[121] = h.scale;
            r[125] = 1.0;
            r[26] *= h.alpha;
            push(&r, DISC, blend, -1);
        }
        if let Some(o) = s.outline {
            let mut r = rec.clone();
            for j in 0..COLOR_STOPS {
                r[64 + j * 4..64 + j * 4 + 4].copy_from_slice(&[o.color[0], o.color[1], o.color[2], 1.0]);
            }
            r[19] = NORMAL as f64;
            r[114] = 0.0;
            r[122] = o.width;
            push(&r, s.shape, NORMAL, row);
        }
        push(&rec, s.shape, blend, row);
    }
    Some(Batch { tick: layers[plans[0].layer].tick, records, table, draws, particles: drawn, incomplete: false })
}

fn near_white(c: &[f64; 4]) -> bool {
    c[0].min(c[1]).min(c[2]) > 0.82
}

/// `inkStops`.
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

/// `fitSegments`: an outline resampled to `count` segments.
fn fit_segments(segments: &Arc<[f32]>, count: usize) -> Arc<[f32]> {
    if segments.len() == count * 4 {
        return segments.clone();
    }
    let n = segments.len() / 4;
    let mut out = vec![0f32; count * 4];
    for i in 0..count {
        let j = ((n as i64 - 1).min((i as f64 * n as f64 / count as f64).floor() as i64)).max(0) as usize * 4;
        out[i * 4..i * 4 + 4].copy_from_slice(&segments[j..j + 4]);
    }
    out.into()
}
