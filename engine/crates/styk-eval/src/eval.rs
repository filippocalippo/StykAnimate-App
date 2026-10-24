//! Frame evaluation: the timeline, native Pivot tweening (`evaluatedNativeFrame`
//! in src/pivot/geometry.mjs) with its property channels ([`crate::channels`]) and the
//! StykAnimate layer sheet (`sampleLayerSheet` in src/layer-sheet.mjs).
//!
//! Evaluation is a pure function of an immutable [`Prepared`] document and a
//! tick, so any number of threads can evaluate different ticks concurrently.
//! Each tweened channel only reads the four keyframes around its interval
//! (Pivot's monotone cubic only needs the neighbouring secants), so cost is
//! O(segments) per figure, independent of how long the keyframe run is.

use std::collections::HashMap;
use std::sync::Arc;

use crate::doc::*;

pub mod preview;
pub(crate) mod retained;

/// One key of a native or virtual (pose-track) timeline.
#[derive(Clone, Debug)]
pub struct KeyRef {
    pub frame: Arc<Keyframe>,
    pub duration: u32,
    pub easing: Option<Easing>,
    pub origin: Option<FrameRef>,
}

/// Where an evaluated pose came from, for editing.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum FrameRef {
    Keyframe(usize),
    Source(Arc<str>),
}

#[derive(Clone, Debug)]
pub struct Seq {
    pub keys: Vec<KeyRef>,
    pub version: u32,
    pub auto_easing: bool,
    /// Authored key ticks of a pose track (empty for native timelines).
    pub ticks: Vec<f64>,
}

#[derive(Clone, Copy, Debug)]
pub struct Row {
    pub start: u32,
    pub count: u32,
}

/// An evaluated scene at one tick.
#[derive(Clone, Debug, Default)]
pub struct Frame {
    pub tick: f64,
    /// `_vfxTimelineTick`: retained source/template clock for inherited effect clips.
    pub retained_vfx_tick: Option<f64>,
    pub objects: Vec<Arc<Object>>,
    pub draw_order: Vec<u32>,
    pub camera: Option<Camera>,
    pub background: u32,
    pub background_b: u32,
    pub background_mix: f64,
    /// Exactly authored poses: their key and slot (None while tweening).
    pub origins: Vec<Option<(FrameRef, u32)>>,
    /// Presence-clock movieclips carried by the pose (`movieclipContinuations`).
    pub continuations: Vec<(u32, Arc<MovieclipPlayback>)>,
    /// Scene colour key (ARGB), if any.
    pub background_color: Option<u32>,
    /// The scene's own per-pose effects (`_stykVfx` of the frame), tweened:
    /// an input of [`Frame::vfx`].
    pub pose_vfx: Option<Arc<crate::vfx::Stacks>>,
    /// Every effect to draw at this tick, resolved ([`crate::vfx::evaluate`]).
    /// `None` when there is none, and always for a document without effects.
    pub vfx: Option<Arc<crate::vfx::FrameVfx>>,
    /// Export's `hasDrawableVfx`, by object slot, including active saved scopes
    /// which paint no effect. Metadata only; [`Frame::vfx`] keeps its render semantics.
    pub export_vfx: Vec<bool>,
    /// How far parallax layers move each object while the scene camera is shown
    /// ([`crate::parallax`]); `None` when nothing moves.
    pub parallax: Option<Arc<crate::parallax::Parallax>>,
}

/// A document plus the timing tables evaluation needs, built once per revision.
pub struct Prepared {
    pub doc: Arc<Document>,
    pub native: Seq,
    pub rows: Vec<Row>,
    pub total_ticks: u32,
    /// Whether evaluation resolves effects: the document or one of its
    /// movieclips has effect clips or per-pose stacks.
    pub has_vfx: bool,
    tracks: HashMap<String, Arc<Seq>>,
    imported: HashMap<String, bool>,
    /// The pose track of each replaced movieclip, by layer and replaced uid (`patchChannels`).
    patches: HashMap<(String, u32), Arc<Seq>>,
    /// Presence-clock spans per movieclip instance: (start, end, elapsed, rate).
    presence: HashMap<u32, Vec<(f64, f64, f64, f64)>>,
    /// Follow camera clips and their shaped paths ([`crate::follow`]).
    follow: Option<crate::follow::Follow>,
    /// The property channels the native timeline is evaluated with ([`crate::channels`]).
    channels: Option<crate::channels::Compiled>,
    /// Retained crop baseline prepared once; source arithmetic has one typed owner.
    pub(crate) source: Option<Arc<Prepared>>,
}

/// `shortest(a)`: the angle in (-π, π], with V8's rounding (tweened angles are stored
/// when a gesture commits, D16).
pub fn shortest(a: f64) -> f64 {
    styk_math::shortest(a)
}

pub fn frame_ticks(duration: u32) -> u32 {
    duration
}

fn same_sign(a: f64, b: f64) -> bool {
    js_sign(a) == js_sign(b)
}

fn js_sign(v: f64) -> f64 {
    if v > 0.0 {
        1.0
    } else if v < 0.0 {
        -1.0
    } else {
        0.0
    }
}

fn endpoint_slope(h0: f64, h1: f64, d0: f64, d1: f64) -> f64 {
    let mut m = ((2.0 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
    if !same_sign(m, d0) {
        return 0.0;
    }
    if !same_sign(d0, d1) && m.abs() > 3.0 * d0.abs() {
        m = 3.0 * d0;
    }
    m
}

fn interior_slope(h0: f64, h1: f64, before: f64, after: f64) -> f64 {
    if before == 0.0 || after == 0.0 || before.is_nan() || after.is_nan() || !same_sign(before, after) {
        return 0.0;
    }
    let w = (2.0 * h0 + h1) / (3.0 * (h0 + h1));
    (before * after) / (w * before + (1.0 - w) * after)
}

fn bezier_coordinate(t: f64, a: f64, b: f64) -> f64 {
    // `(1 - t) ** 2` is `x * x` in V8; `t ** 3` is V8's `pow` (D16): `t * t * t` rounds twice
    // and stored channel values differed in their last bit.
    3.0 * (1.0 - t).powi(2) * t * a + 3.0 * (1.0 - t) * t * t * b + styk_math::pow(t, 3.0)
}

pub fn cubic_bezier_progress(t: f64, p: [f64; 4]) -> f64 {
    if t <= 0.0 {
        return 0.0;
    }
    if t >= 1.0 {
        return 1.0;
    }
    let (mut low, mut high, mut u) = (0.0, 1.0, t);
    for _ in 0..40 {
        let x = bezier_coordinate(u, p[0], p[2]);
        if (x - t).abs() < 1e-10 {
            break;
        }
        if x < t {
            low = u;
        } else {
            high = u;
        }
        u = (low + high) / 2.0;
    }
    bezier_coordinate(u, p[1], p[3])
}

pub fn eased_progress(easing: Option<&Easing>, fraction: f64) -> f64 {
    let t = fraction.clamp(0.0, 1.0);
    match easing.map(|e| e.mode).unwrap_or(EasingMode::Linear) {
        EasingMode::Auto => t * t * (3.0 - 2.0 * t),
        EasingMode::Bezier => cubic_bezier_progress(t, easing.unwrap().bezier),
        EasingMode::EaseIn => cubic_bezier_progress(t, [0.42, 0.0, 1.0, 1.0]),
        EasingMode::EaseOut => cubic_bezier_progress(t, [0.0, 0.0, 0.58, 1.0]),
        EasingMode::Linear => t,
        EasingMode::Constant => {
            if t < 1.0 {
                0.0
            } else {
                1.0
            }
        }
    }
}

/// Monotone cubic Hermite through optional Auto neighbours (`autoValue`).
pub fn auto_value(a: f64, b: f64, fraction: f64, duration: f64, previous: Option<(f64, f64)>, following: Option<(f64, f64)>) -> f64 {
    if fraction <= 0.0 || !(duration > 0.0) {
        return a;
    }
    if fraction >= 1.0 {
        return b;
    }
    if a == b {
        return a;
    }
    let slope = (b - a) / duration;
    let tangent = |other: Option<(f64, f64)>, h: f64, before: bool| -> f64 {
        let Some((value, d_other)) = other else { return 0.0 };
        if !(d_other > 0.0) || !value.is_finite() {
            return 0.0;
        }
        let d = if before { (a - value) / d_other } else { (value - b) / d_other };
        if d == 0.0 || d.is_nan() || js_sign(d) != js_sign(slope) {
            return 0.0;
        }
        let w1 = 2.0 * h + d_other;
        let w2 = h + 2.0 * d_other;
        (w1 + w2) / (w1 / d + w2 / slope)
    };
    let m0 = tangent(previous, duration, true);
    let m1 = tangent(following, duration, false);
    let (t, t2, t3) = (fraction, fraction * fraction, fraction * fraction * fraction);
    let value = a + (b - a) * (3.0 * t2 - 2.0 * t3) + duration * ((t3 - 2.0 * t2 + t) * m0 + (t3 - t2) * m1);
    value.clamp(a.min(b), a.max(b))
}

/// The interpolation context of one keyframe interval: channel values are
/// read at keys index-1, index, index+1 and index+2.
struct Sampler<'a> {
    seq: &'a Seq,
    index: usize,
    /// Unwrap angles along the whole run of keys, as the editor does (see [`Sampler::angle`]).
    exact: bool,
    t: f64,
    auto: bool,
    auto_prev: bool,
    auto_next: bool,
    legacy: bool,
    has_prev: bool,
    has_next2: bool,
    /// frameTicks of keys index-1, index, index+1.
    ticks: [f64; 3],
    /// Whether keys index+1 is not the last key (pchip may extend to index+2).
    can_extend_right: bool,
}

impl<'a> Sampler<'a> {
    fn new(seq: &'a Seq, index: usize, t: f64, exact: bool) -> Sampler<'a> {
        let keys = &seq.keys;
        let mode = |k: usize| keys.get(k).and_then(|f| f.easing).map(|e| e.mode);
        let ticks = |k: Option<usize>| k.and_then(|k| keys.get(k)).map(|f| frame_ticks(f.duration) as f64).unwrap_or(0.0);
        Sampler {
            seq,
            index,
            exact,
            t,
            auto: mode(index) == Some(EasingMode::Auto),
            auto_prev: index > 0 && mode(index - 1) == Some(EasingMode::Auto),
            auto_next: mode(index + 1) == Some(EasingMode::Auto),
            legacy: seq.auto_easing && keys[index].easing.is_none(),
            has_prev: index > 0,
            has_next2: index + 2 < keys.len(),
            ticks: [ticks(index.checked_sub(1)), ticks(Some(index)), ticks(Some(index + 1))],
            can_extend_right: index + 1 < keys.len() - 1,
        }
    }

    /// `v` = values at keys [index-1, index, index+1, index+2].
    fn value(&self, v: [Option<f64>; 4], angular: bool) -> f64 {
        self.value_from(v, angular, None)
    }

    /// An angle, with `far(k)` reading the channel at any key `k`. Pivot's own easing
    /// unwraps an angle along the whole run of tweened keys before the interval, so
    /// the value the editor stores can sit whole turns away from the one unwrapped
    /// from the previous key alone. Both draw the same; when records are produced
    /// (`exact`) the editor's chain is followed, at a cost that grows with the run.
    fn angle(&self, v: [Option<f64>; 4], far: &dyn Fn(usize) -> Option<f64>) -> f64 {
        self.value_from(v, true, self.unwrapped_before(&v, far))
    }

    /// The unwrapped angle at key index-1 when the run starts before it.
    fn unwrapped_before(&self, v: &[Option<f64>; 4], far: &dyn Fn(usize) -> Option<f64>) -> Option<f64> {
        if !self.exact || self.auto || !self.legacy || !(self.has_prev && self.ticks[0] > 1.0 && v[0].is_some()) {
            return None;
        }
        let ticks = |k: usize| frame_ticks(self.seq.keys[k].duration) as f64;
        let mut left = self.index - 1;
        while left > 0 && ticks(left - 1) > 1.0 && far(left - 1).is_some() {
            left -= 1;
        }
        let mut value = far(left)?;
        for k in left + 1..self.index {
            value += shortest(far(k)? - value);
        }
        Some(value)
    }

    fn value_from(&self, v: [Option<f64>; 4], angular: bool, before: Option<f64>) -> f64 {
        let (Some(a), Some(b)) = (v[1], v[2]) else { return v[1].unwrap_or(0.0) };
        let t = self.t;
        if self.auto {
            let end = if angular { a + shortest(b - a) } else { b };
            let previous = if self.auto_prev && self.has_prev {
                v[0].map(|value| (if angular { a - shortest(a - value) } else { value }, self.ticks[0]))
            } else {
                None
            };
            let following = if self.auto_next && self.has_next2 {
                v[3].map(|value| (if angular { end + shortest(value - b) } else { value }, self.ticks[2]))
            } else {
                None
            };
            return auto_value(a, end, t, self.ticks[1], previous, following);
        }
        if !self.legacy {
            return a + if angular { shortest(b - a) } else { b - a } * t;
        }
        let left = self.has_prev && self.ticks[0] > 1.0 && v[0].is_some();
        let right = self.can_extend_right && self.ticks[2] > 1.0 && v[3].is_some();
        let unwrap = |prev: f64, value: f64| if angular { prev + shortest(value - prev) } else { value };
        let u0 = if left { before.unwrap_or_else(|| v[0].unwrap()) } else { 0.0 };
        let u1 = if left { unwrap(u0, a) } else { a };
        let u2 = unwrap(u1, b);
        if !left && !right {
            return u1 + (u2 - u1) * t;
        }
        let u3 = if right { unwrap(u2, v[3].unwrap()) } else { 0.0 };
        let (h0, h1) = (self.ticks[0], self.ticks[1]);
        let h2 = if right {
            // frameTicks(frames[index + 1]) is the interval index+1 → index+2.
            self.ticks[2]
        } else {
            0.0
        };
        let d0 = if left { (u1 - u0) / h0 } else { 0.0 };
        let d1 = (u2 - u1) / h1;
        let d2 = if right { (u3 - u2) / h2 } else { 0.0 };
        let m1 = if !left { endpoint_slope(h1, h2, d1, d2) } else { interior_slope(h0, h1, d0, d1) };
        let m2 = if !right { endpoint_slope(h1, h0, d1, d0) } else { interior_slope(h1, h2, d1, d2) };
        let (t2, t3) = (t * t, t * t * t);
        (2.0 * t3 - 3.0 * t2 + 1.0) * u1 + (t3 - 2.0 * t2 + t) * h1 * m1 + (3.0 * t2 - 2.0 * t3) * u2 + (t3 - t2) * h1 * m2
    }
}

pub(crate) fn color_tween(a: u32, b: u32, t: f64) -> u32 {
    let (am, bm) = (a >> 24, b >> 24);
    if am == 0 && bm == 0 {
        return a;
    }
    let mut out = 0u32;
    for i in 0..4 {
        let mut av = (a >> (i * 8)) & 255;
        let mut bv = (b >> (i * 8)) & 255;
        if i < 3 {
            if am == 0 {
                av = bv;
            }
            if bm == 0 {
                bv = av;
            }
        }
        let v = av as f64 + ((bv as f64 - av as f64) * t).trunc();
        out |= ((v as i64 as u32) & 255) << (i * 8);
    }
    out
}

/// `tweenBackground` in src/pivot/background.mjs.
fn tween_background(start: &Keyframe, end: &Keyframe, duration: u32, t: f64) -> (u32, u32, f64) {
    let (mut a, mut b, mut m) = (start.background, start.background_b, start.background_mix);
    let (c, d, n) = (end.background, end.background_b, end.background_mix);
    if a == c && b == d && m == n {
        return (a, b, m);
    }
    let duration = if duration == 0 { 1.0 } else { duration as f64 };
    let mut j = t * duration;
    if (j - j.round()).abs() < 1e-9 {
        j = j.round();
    }
    let lerp = |x: f64, y: f64| x + ((j * (y - x)) / duration).trunc();
    let mut fallback = false;
    if m != 0.0 && n != 0.0 {
        if a == c && b == d {
            m = lerp(m, n);
        } else if a == d && b == c {
            m = lerp(m, 255.0 - n);
        } else {
            fallback = true;
        }
    } else if m != 0.0 {
        if c == a {
            m = lerp(m, 0.0);
        } else if c == b {
            m = lerp(m, 255.0);
        } else {
            fallback = true;
        }
    } else if n != 0.0 {
        if a == c {
            b = d;
            m = lerp(0.0, n);
        } else if a == d {
            a = c;
            b = d;
            m = lerp(255.0, n);
        } else {
            fallback = true;
        }
    } else {
        b = c;
        m = ((255.0 * j) / duration).floor();
    }
    if fallback {
        a = if start.background_mix >= 128.0 { start.background_b } else { start.background };
        b = if end.background_mix >= 128.0 { end.background_b } else { end.background };
        if a == b {
            b = 0;
            m = 0.0;
        } else {
            m = ((255.0 * j) / duration).floor();
        }
    }
    if m >= 254.0 {
        a = b;
        b = 0;
        m = 0.0;
    }
    (a, b, m)
}

fn frame_of(key: &KeyRef) -> Frame {
    let k = &key.frame;
    Frame {
        tick: 0.0,
        retained_vfx_tick: k.retained_vfx_tick,
        objects: k.objects.clone(),
        draw_order: k.draw_order.clone(),
        camera: k.camera,
        background: k.background,
        background_b: k.background_b,
        background_mix: k.background_mix,
        origins: match &key.origin {
            Some(o) => (0..k.objects.len() as u32).map(|slot| Some((o.clone(), slot))).collect(),
            None => vec![None; k.objects.len()],
        },
        continuations: k.continuations.clone(),
        background_color: k.background_color,
        pose_vfx: k.vfx.clone(),
        vfx: None,
        export_vfx: Vec::new(),
        parallax: None,
    }
}

/// `evaluatedNativeFrame`: one interval of a native or virtual timeline.
pub fn evaluate_native(doc: &Document, seq: &Seq, index: usize, t: f64) -> Frame {
    evaluate_interval(doc, seq, index, t, false, None)
}

/// [`evaluate_native`] tweening only the figures `uids` and the figures they hang from
/// (`requestedUids`); the others keep the interval's first pose.
pub(crate) fn evaluate_native_only(doc: &Document, seq: &Seq, index: usize, t: f64, uids: &[u32]) -> Frame {
    evaluate_interval(doc, seq, index, t, false, Some(uids))
}

/// [`evaluate_native`] with every stored value as the editor computes it, for
/// records (see [`Sampler::angle`]); tweening only the figures `uids` (and those they
/// hang from) when given, as a figure's pose channel samples its track (`requestedUids`).
pub(crate) fn evaluate_native_exact_only(doc: &Document, seq: &Seq, index: usize, t: f64, uids: Option<&[u32]>) -> Frame {
    evaluate_interval(doc, seq, index, t, true, uids)
}

fn evaluate_interval(doc: &Document, seq: &Seq, index: usize, t: f64, exact: bool, only: Option<&[u32]>) -> Frame {
    let mut frame = tween_interval(doc, seq, index, t, exact, only);
    correct_origins(doc, &mut frame);
    frame
}

/// `correctAnimationOrigins`: every unjoined figure with an animation origin is placed so
/// that its pivot lands where its pose says, as each native interval leaves it.
pub(crate) fn correct_origins(doc: &Document, frame: &mut Frame) {
    if !doc.origins {
        return;
    }
    for object in frame.objects.iter_mut() {
        let Some(figure) = doc.figure(object.figure) else { continue };
        if let Some(root) = crate::origin::corrected_root(figure, object) {
            Arc::make_mut(object).root = root;
        }
    }
}

fn tween_interval(doc: &Document, seq: &Seq, index: usize, t: f64, exact: bool, only: Option<&[u32]>) -> Frame {
    let keys = &seq.keys;
    let Some(a) = keys.get(index) else { return Frame::default() };
    let Some(b) = keys.get(index + 1) else { return frame_of(a) };
    if t <= 0.0 || (seq.version < 5 && a.easing.is_none()) {
        return frame_of(a);
    }
    if t >= 1.0 {
        return frame_of(b);
    }
    let auto = a.easing.map(|e| e.mode) == Some(EasingMode::Auto);
    let t = if auto { t } else { eased_progress(a.easing.as_ref(), t) };
    if t <= 0.0 {
        return frame_of(a);
    }
    if t >= 1.0 {
        return frame_of(b);
    }
    let sampler = Sampler::new(seq, index, t, exact);
    let around = |k: Option<usize>| k.and_then(|k| keys.get(k)).map(|f| &f.frame);
    let frames = [around(index.checked_sub(1)), Some(&a.frame), Some(&b.frame), around(Some(index + 2))];
    // A figure's trajectory needs only its figures and those they hang from in either key.
    let needed: Option<std::collections::HashSet<u32>> = only.map(|uids| {
        let mut needed: std::collections::HashSet<u32> = uids.iter().copied().collect();
        let mut queue: Vec<u32> = uids.to_vec();
        let mut i = 0;
        while i < queue.len() {
            for key in [&a.frame, &b.frame] {
                let parent = key.object(queue[i]).and_then(|o| o.join).and_then(|j| key.objects.get(j.slot as usize));
                if let Some(parent) = parent
                    && needed.insert(parent.uid)
                {
                    queue.push(parent.uid);
                }
            }
            i += 1;
        }
        needed
    });
    let mut objects = Vec::with_capacity(a.frame.objects.len());
    for o in &a.frame.objects {
        if needed.as_ref().is_some_and(|needed| !needed.contains(&o.uid)) {
            objects.push(o.clone());
            continue;
        }
        let Some(next) = b.frame.object(o.uid).filter(|n| n.figure == o.figure) else {
            objects.push(o.clone());
            continue;
        };
        let Some(fig) = doc.figure(o.figure) else {
            objects.push(o.clone());
            continue;
        };
        let recs: [Option<&Object>; 4] = frames.map(|f| f.and_then(|f| f.object(o.uid)).filter(|x| x.figure == o.figure).map(|x| &**x));
        objects.push(Arc::new(tween_object(&sampler, fig, o, next, &recs, auto)));
    }
    let camera = match (a.frame.camera, b.frame.camera) {
        (Some(ca), Some(cb)) => {
            let cams = frames.map(|f| f.map(|f| f.camera.unwrap_or_default()));
            let get = |k: fn(&Camera) -> f64| cams.map(|c| c.as_ref().map(k));
            // A baked parallax offset tweens when either key has one; a key without one is at zero.
            let motion_offset = (ca.motion_offset.is_some() || cb.motion_offset.is_some()).then(|| {
                [sampler.value(get(|c| c.motion_offset.map_or(0.0, |o| o[0])), false), sampler.value(get(|c| c.motion_offset.map_or(0.0, |o| o[1])), false)]
            });
            Some(Camera {
                x: sampler.value(get(|c| c.x), false),
                y: sampler.value(get(|c| c.y), false),
                scale: sampler.value(get(|c| c.scale), false),
                angle: sampler.angle(get(|c| c.angle), &|k| keys.get(k).map(|f| f.frame.camera.unwrap_or_default().angle)),
                is_default: false,
                motion_offset,
            })
        }
        _ => a.frame.camera,
    };
    let bg_t = if auto { eased_progress(a.easing.as_ref(), t) } else { t };
    let (background, background_b, background_mix) = tween_background(&a.frame, &b.frame, a.duration, bg_t);
    Frame {
        tick: 0.0,
        retained_vfx_tick: a.frame.retained_vfx_tick,
        pose_vfx: a.frame.vfx.as_ref().map(|stacks| crate::vfx::interpolate(stacks, b.frame.vfx.as_ref(), t)),
        vfx: None,
        export_vfx: Vec::new(),
        parallax: None,
        origins: vec![None; objects.len()],
        continuations: a.frame.continuations.clone(),
        background_color: a.frame.background_color,
        objects,
        draw_order: a.frame.draw_order.clone(),
        camera,
        background,
        background_b,
        background_mix,
    }
}

fn tween_object(s: &Sampler, fig: &Figure, o: &Object, next: &Object, recs: &[Option<&Object>; 4], auto: bool) -> Object {
    let t = s.t;
    let read = |f: &dyn Fn(&Object) -> f64| recs.map(|r| r.map(f));
    let mut out = o.clone();
    // IK: controller targets and follower angles tween with the pose (`interpolateIK`).
    if let Some(table) = &o.ik {
        let at = |k: usize| s.seq.keys.get(k).and_then(|f| f.frame.object(o.uid)).filter(|x| x.figure == o.figure).and_then(|x| x.ik.as_deref());
        let value = |v: [Option<f64>; 4], angular: bool, far: &dyn Fn(usize) -> Option<f64>| if angular { s.angle(v, far) } else { s.value(v, false) };
        out.ik = Some(Arc::new(crate::ik::tween(table, recs.map(|r| r.and_then(|x| x.ik.as_deref())), t, &value, &at)));
    }
    // Effects: matching identities interpolate toward the next pose's (`interpolateVfx`).
    if let Some(stacks) = &o.vfx {
        out.vfx = Some(crate::vfx::interpolate(stacks, next.vfx.as_ref(), t));
    }
    // 3D: perspective and part proportions tween linearly within their limits (`interpolateSpatialPose`).
    if o.spatial.is_some() || next.spatial.is_some() {
        out.spatial = Some(Arc::new(crate::spatial::interpolate_pose(o, next, t)));
    }
    out.root = [s.value(read(&|x| x.root[0]), false), s.value(read(&|x| x.root[1]), false)];
    out.scale = s.value(read(&|x| x.scale), false);
    // An animation origin's pivot tweens (its offset too when either key has one); the root
    // follows it once the angles are known ([`correct_origins`]).
    if fig.origin.is_some()
        && let (Some(a), Some(b)) = (&o.origin, &next.origin)
    {
        let pivot = |k: fn(&crate::origin::PoseOrigin) -> f64| s.value(recs.map(|r| r.and_then(|x| x.origin.as_deref()).map(k)), false);
        let mut origin = crate::origin::PoseOrigin { x: pivot(|p| p.x), y: pivot(|p| p.y), ..Default::default() };
        if (0..2).any(|i| a.offset[i].is_some() || b.offset[i].is_some()) {
            let offset = |i: usize| s.value(recs.map(|r| r.map(|x| x.origin.as_deref().and_then(|p| p.offset[i]).unwrap_or(0.0))), false);
            origin.offset = [Some(offset(0)), Some(offset(1))];
        }
        out.origin = Some(Arc::new(origin));
    }
    out.transparency = if auto {
        s.value(read(&|x| x.transparency), false).round()
    } else {
        o.transparency + ((next.transparency - o.transparency) * t).trunc()
    };
    let n = fig.segments.len();
    if o.lengths.is_some() || next.lengths.is_some() || s.legacy {
        let lengths: Vec<f64> = (0..n)
            .map(|i| {
                let base = fig.segments[i].length;
                s.value(recs.map(|r| r.map(|x| x.lengths.as_ref().map_or(base, |l| l.get(i).copied().unwrap_or(f64::NAN)))), false)
            })
            .collect();
        out.lengths = Some(lengths.into());
    }
    if o.bends.is_some() || next.bends.is_some() || s.legacy {
        let bends: Vec<f64> = (0..n)
            .map(|i| {
                let base = fig.segments[i].bend;
                s.value(recs.map(|r| r.map(|x| x.bends.as_ref().map_or(base, |l| l.get(i).copied().unwrap_or(f64::NAN)))), false)
            })
            .collect();
        out.bends = Some(bends.into());
    }
    // A figure with an animation origin tweens the angles of its original tree (`animationOriginLayout`
    // or its retained support graph) rather than of its construction tree.
    if let Some(origin) = fig.origin.as_deref() {
        let key_object = |k: usize| s.seq.keys.get(k).and_then(|f| f.frame.object(o.uid)).filter(|x| x.figure == o.figure);
        let sample = |read: &dyn Fn(&Object) -> f64, angular: bool| -> f64 {
            let values = recs.map(|r| r.map(read));
            if angular { s.angle(values, &|k| key_object(k).map(|x| read(x))) } else { s.value(values, false) }
        };
        match &origin.kind {
            crate::origin::Kind::Layout(layout) => out.angles = crate::origin::tween_layout(fig, layout, &out, &sample).into(),
            crate::origin::Kind::Support(support) => {
                let first = o.angles.clone();
                crate::origin::tween_support(fig, support, &first, &mut out, &sample);
            }
        }
        return finish_colors(s, o, next, recs, auto, out);
    }
    let plan = &fig.plan;
    let mut angles: Vec<f64> = (0..n).map(|i| o.angles.get(i).copied().unwrap_or(fig.segments[i].angle)).collect();
    let mut done = vec![false; n];
    for &i in &plan.order {
        let i = i as usize;
        let parent = plan.parent[i];
        let relative_of = |x: &Object| -> f64 {
            let mut value = x.angles.get(i).copied().unwrap_or(fig.segments[i].angle);
            if parent != u32::MAX {
                let p = parent as usize;
                let ps = &fig.segments[p];
                value -= x.angles.get(p).copied().unwrap_or(ps.angle)
                    + match &x.bends {
                        Some(b) => b.get(p).copied().unwrap_or(f64::NAN),
                        None => ps.bend,
                    };
            }
            value
        };
        let relative = s.angle(recs.map(|r| r.map(relative_of)), &|k| s.seq.keys.get(k).and_then(|f| f.frame.object(o.uid)).filter(|x| x.figure == o.figure).map(|x| relative_of(x)));
        angles[i] = if parent == u32::MAX {
            relative
        } else {
            let p = parent as usize;
            let bend = match &out.bends {
                Some(b) => b[p],
                None => fig.segments[p].bend,
            };
            angles[p] + bend + relative
        };
        done[i] = true;
    }
    out.angles = angles.into();
    finish_colors(s, o, next, recs, auto, out)
}

/// The colour override of a tween, the last channel `tween_object` writes.
fn finish_colors(s: &Sampler, o: &Object, next: &Object, recs: &[Option<&Object>; 4], auto: bool, mut out: Object) -> Object {
    let t = s.t;
    out.color = color_tween(o.color, next.color, t);
    if auto {
        let mut color = 0u32;
        for shift in (0..32).step_by(8) {
            let component = |x: &Object| -> f64 {
                let raw = x.color;
                if shift < 24 && raw >> 24 == 0 {
                    let fallback = if o.color >> 24 != 0 { o.color } else { next.color };
                    return ((fallback >> shift) & 255) as f64;
                }
                ((raw >> shift) & 255) as f64
            };
            let v = s.value(recs.map(|r| r.map(component)), false).round() as i64;
            color |= ((v as u32) & 255) << shift;
        }
        out.color = color;
    }
    out
}

const FIXED: [&str; 2] = ["scene", "camera"];

impl Prepared {
    pub fn new(doc: Arc<Document>) -> Prepared {
        let native = Seq {
            keys: doc
                .keyframes
                .iter()
                .enumerate()
                .map(|(i, k)| KeyRef { frame: k.clone(), duration: k.duration, easing: k.easing, origin: Some(FrameRef::Keyframe(i)) })
                .collect(),
            version: doc.version,
            auto_easing: doc.auto_easing,
            ticks: Vec::new(),
        };
        let mut rows = native_timeline(&doc);
        let clip_end = doc.camera_motion.iter().map(|c| c.start + c.duration).fold(0.0, f64::max) as u32;
        let channels = doc.animation.as_ref().map(|animation| crate::channels::Compiled::new(&doc, animation));
        let mut tracks = HashMap::new();
        let mut imported = HashMap::new();
        let mut patches = HashMap::new();
        if let Some(sheet) = &doc.sheet {
            rows.retain(|r| r.start < sheet.duration);
            for r in rows.iter_mut() {
                r.count = r.count.min(sheet.duration - r.start);
            }
            if let Some(last) = rows.last_mut() {
                last.count = sheet.duration.max(clip_end) - last.start;
            }
            for (id, track) in &sheet.tracks {
                tracks.insert(id.clone(), Arc::new(pose_track(&doc, id, track)));
                imported.insert(id.clone(), track.keys.iter().any(|k| matches!(k.value, SheetValue::SourceTick(_))));
                for patch in track.keys.iter().flat_map(|k| &k.movieclip_patches) {
                    patches.entry((id.clone(), patch.uid)).or_insert_with(|| Arc::new(patch_track(&doc, track, patch.uid)));
                }
            }
        } else if let Some(last) = rows.last_mut() {
            // A native timeline also lasts until the channels' last frame (`animationEndTick`).
            let end = clip_end.max(doc.animation.as_ref().map_or(0.0, |a| a.end.max(0.0)) as u32);
            last.count = last.count.max(end.saturating_sub(last.start));
        }
        let total_ticks = rows.last().map(|r| r.start + r.count).unwrap_or(0).max(1);
        // Effect channels can give a pose a stack it does not save.
        let has_vfx = crate::vfx::has_own_vfx(&doc)
            || doc.animation.as_ref().is_some_and(|a| a.vfx)
            || doc.figures.iter().any(|f| f.movieclip.as_ref().is_some_and(|clip| clip.prepared.has_vfx));
        let follow = crate::follow::Follow::new(&doc);
        let source = doc.movieclip_source.as_ref().map(|source| Arc::new(Prepared::new(source.document.clone())));
        let has_vfx = has_vfx || source.as_ref().is_some_and(|source| source.has_vfx);
        let mut prepared = Prepared { doc, native, rows, total_ticks, has_vfx, tracks, imported, patches, presence: HashMap::new(), follow, channels, source };
        prepared.presence = prepared.presence_index();
        prepared
    }

    /// The property channels the native timeline is evaluated with, compiled.
    pub(crate) fn channels(&self) -> Option<&crate::channels::Compiled> {
        self.channels.as_ref()
    }

    /// The pose track of a layer (or `scene`, `camera`) as a virtual native timeline.
    pub(crate) fn track(&self, id: &str) -> Option<&Seq> {
        self.tracks.get(id).map(|seq| &**seq)
    }

    fn has_clips(&self) -> bool {
        self.doc.figures.iter().any(|f| f.movieclip.is_some())
    }

    /// `presenceIndex`: membership is sampled once per interval between keys.
    fn presence_index(&self) -> HashMap<u32, Vec<(f64, f64, f64, f64)>> {
        let mut out: HashMap<u32, Vec<(f64, f64, f64, f64)>> = HashMap::new();
        if !self.has_clips() {
            return out;
        }
        let mut times: Vec<f64> = vec![0.0];
        match &self.doc.sheet {
            Some(sheet) => {
                times.push(sheet.duration as f64);
                for t in sheet.tracks.values() {
                    times.push(t.end as f64);
                    times.extend(t.keys.iter().map(|k| k.tick as f64));
                }
            }
            None => {
                for r in &self.rows {
                    times.push(r.start as f64);
                    times.push((r.start + r.count) as f64);
                }
                // Channel keys can change who is in the frame.
                for channel in self.doc.animation.iter().flat_map(|a| &a.channels) {
                    times.extend(channel.keys.iter().map(|k| k.tick));
                }
            }
        }
        times.sort_by(f64::total_cmp);
        times.dedup();
        let mut elapsed: HashMap<u32, f64> = HashMap::new();
        for w in times.windows(2) {
            let (start, end) = (w[0], w[1]);
            if end <= start {
                continue;
            }
            let frame = self.evaluate_raw(start, false);
            let mut members: Vec<(u32, Arc<MovieclipPlayback>)> = frame.continuations.clone();
            for o in &frame.objects {
                if let Some(p) = o.movieclip.as_ref().filter(|p| p.presence) {
                    members.retain(|(uid, _)| *uid != o.uid);
                    members.push((o.uid, p.clone()));
                }
            }
            for (uid, settings) in members {
                let rate = if settings.mode == MovieclipMode::Single { 0.0 } else { settings.speed };
                let spans = out.entry(uid).or_default();
                let e = elapsed.entry(uid).or_insert(0.0);
                match spans.last_mut() {
                    Some(last) if last.1 == start && last.3 == rate => last.1 = end,
                    _ => spans.push((start, end, *e, rate)),
                }
                *e += (end - start) * rate;
            }
        }
        out
    }

    /// `presenceElapsed(index, uid, tick)`: how long movieclip `uid` has played on the presence
    /// clock by `tick`, in document ticks at its speed.
    pub fn presence_elapsed(&self, uid: u32, tick: f64) -> f64 {
        let Some(spans) = self.presence.get(&uid) else { return 0.0 };
        let i = spans.partition_point(|s| s.0 <= tick);
        match i.checked_sub(1).map(|i| spans[i]) {
            Some((start, end, elapsed, rate)) => elapsed + (tick.min(end) - start).max(0.0) * rate,
            None => 0.0,
        }
    }

    /// `sampleMovieclipObjects`: chooses each instance's local clip time and
    /// removes instances that are not playing at this tick.
    /// A movieclip instance's local time at `tick` (`_movieclipSample`): `Some(None)`
    /// while it is not shown, `None` for a figure that is not a movieclip.
    pub(crate) fn clip_local(&self, object: &Object, tick: f64) -> Option<Option<f64>> {
        let doc = &self.doc;
        let clip = doc.figure(object.figure).and_then(|f| f.movieclip.clone())?;
        let default = MovieclipPlayback { start: 0.0, end: None, offset: 0.0, speed: 1.0, mode: MovieclipMode::Loop, presence: false, restarts: vec![] };
        let settings = object.movieclip.as_deref().cloned().unwrap_or(default);
        Some(if settings.presence && self.retained_source_time_at(tick).is_some() {
            object.clip_time
        } else if settings.presence {
            let time = if settings.mode == MovieclipMode::Single { 0.0 } else { self.presence_elapsed(object.uid, tick) };
            let s = MovieclipPlayback { start: 0.0, end: None, speed: 1.0, ..settings };
            movieclip_time(&clip, &s, time, doc.fps)
        } else {
            movieclip_time(&clip, &settings, tick, doc.fps)
        })
    }

    /// The pose track of what replaces movieclip `uid` on layer `id` (`patchChannels`).
    pub(crate) fn patch_track(&self, id: &str, uid: u32) -> Option<&Seq> {
        self.patches.get(&(id.to_string(), uid)).map(|seq| &**seq)
    }

    /// One layer's own frame at `tick`, movieclip replacements applied (`sample(id)`).
    pub(crate) fn layer_frame(&self, id: &str, tick: f64) -> Option<Frame> {
        self.sample_track(id, tick).map(|(frame, _)| frame)
    }

    /// The frame before movieclips are sampled and layers ordered (`sampleLayerSheet`
    /// or the native tween), for the record view.
    pub(crate) fn raw(&self, tick: f64) -> Frame {
        self.evaluate_raw(tick, false)
    }

    fn apply_movieclips(&self, frame: &mut Frame, tick: f64) {
        if !self.has_clips() {
            return;
        }
        let doc = &self.doc;
        let mut hidden = false;
        for object in frame.objects.iter_mut() {
            let Some(local) = self.clip_local(object, tick) else { continue };
            hidden |= local.is_none();
            Arc::make_mut(object).clip_time = local;
        }
        if !hidden {
            return;
        }
        let keep: Vec<bool> = frame.objects.iter().map(|o| doc.figure(o.figure).and_then(|f| f.movieclip.as_ref()).is_none() || o.clip_time.is_some()).collect();
        let mut remap = vec![u32::MAX; keep.len()];
        let mut next = 0u32;
        for (i, &k) in keep.iter().enumerate() {
            if k {
                remap[i] = next;
                next += 1;
            }
        }
        let mut objects = Vec::with_capacity(next as usize);
        let mut origins = Vec::with_capacity(next as usize);
        for (i, o) in frame.objects.iter().enumerate() {
            if !keep[i] {
                continue;
            }
            let mut o = o.clone();
            if let Some(j) = o.join {
                let target = remap[j.slot as usize];
                Arc::make_mut(&mut o).join = (target != u32::MAX).then_some(Join { slot: target, handle: j.handle });
            }
            objects.push(o);
            origins.push(frame.origins.get(i).cloned().flatten());
        }
        frame.draw_order = frame.draw_order.iter().filter(|&&s| keep[s as usize]).map(|&s| remap[s as usize]).collect();
        frame.objects = objects;
        frame.origins = origins;
    }

    /// The editor's frame at an integer (or fractional) tick.
    pub fn evaluate(&self, tick: f64) -> Frame {
        self.evaluate_with(tick, false)
    }

    /// Movieclip sources sample their rows at fractional local times.
    pub fn evaluate_clip(&self, tick: f64) -> Frame {
        self.evaluate_with(tick, true)
    }

    fn evaluate_with(&self, tick: f64, fractional: bool) -> Frame {
        self.finish_frame(self.evaluate_raw(tick, fractional), tick, fractional)
    }

    /// A native interval selected explicitly by the editor (including one-tick and
    /// hidden keys). A layer sheet still samples its tracks at the absolute tick.
    pub fn evaluate_interval(&self, index: usize, ratio: f64, tick: f64) -> Frame {
        let mut frame = if self.doc.sheet.is_some() { self.sample_sheet(tick) } else { self.native_interval(index, ratio, tick) };
        frame.tick = tick;
        self.finish_frame(frame, tick, false)
    }

    fn finish_frame(&self, mut frame: Frame, tick: f64, fractional: bool) -> Frame {
        self.apply_movieclips(&mut frame, tick);
        apply_layer_order(&self.doc, &mut frame);
        // Where the camera travels (`cameraTravelAt`, follow clips included) moves parallax
        // layers; camera-motion impulses shake the finished shot on top of it. A movieclip's
        // own frame is drawn with its instance's camera and parallax, never its own.
        let travel = if fractional { frame.camera } else { self.travel(frame.camera, tick) };
        if !fractional {
            frame.parallax = crate::parallax::resolve(&self.doc, &frame, travel.as_ref());
        }
        if !self.doc.camera_motion.is_empty() {
            frame.camera = crate::camera::at_time(travel, &self.doc.camera_motion, tick, self.doc.fps);
        }
        if self.has_vfx {
            let mut export_vfx = Vec::new();
            if self.doc.vfx_clips.is_none()
                && let (Some(source), Some(source_tick)) = (self.retained_effect_source(), frame.retained_vfx_tick)
            {
                let mut timed = frame.clone();
                timed.tick = source_tick;
                frame.vfx = crate::vfx::frame::inherited_filters(source, &timed, &mut export_vfx);
            } else {
                frame.vfx = crate::vfx::frame::evaluate_for_export(&self.doc, &frame, &mut export_vfx);
            }
            frame.export_vfx = export_vfx;
        }
        frame
    }

    fn retained_effect_source(&self) -> Option<&Document> {
        let source = self.source.as_ref()?;
        if source.doc.vfx_clips.is_some() { Some(&source.doc) } else { source.retained_effect_source() }
    }

    /// `cameraTravelAt`: where the camera is at `tick`, the authored `camera` moved by the
    /// follow clips there.
    pub fn travel(&self, camera: Option<Camera>, tick: f64) -> Option<Camera> {
        match &self.follow {
            Some(follow) => follow.travel(camera, tick),
            None => camera,
        }
    }

    /// Reads the follow paths workers have already published, without evaluating or shaping
    /// a frame. The outer `None` means an active path is cold; `Some(None)` is ready with no
    /// camera. Interactive hosts must refuse or defer a cold query rather than call `travel`.
    pub fn travel_ready(&self, camera: Option<Camera>, tick: f64) -> Option<Option<Camera>> {
        match &self.follow {
            Some(follow) => follow.travel_ready(camera, tick),
            None => Some(camera),
        }
    }

    /// The figures of the frame at `tick` and the authored camera: what a follow camera
    /// samples (no effects, camera motion or parallax).
    pub(crate) fn evaluate_figures(&self, tick: f64) -> Frame {
        let mut frame = self.evaluate_raw(tick, false);
        self.apply_movieclips(&mut frame, tick);
        apply_layer_order(&self.doc, &mut frame);
        frame
    }

    fn evaluate_raw(&self, tick: f64, fractional: bool) -> Frame {
        let mut frame = if self.doc.sheet.is_some() {
            self.sample_sheet(tick)
        } else if fractional {
            let (index, t) = row_at_fraction(&self.rows, tick);
            self.native_interval(index, t, tick)
        } else {
            self.native_at(tick)
        };
        frame.tick = tick;
        frame
    }

    /// The native timeline at an absolute (possibly fractional) tick, its property
    /// channels applied: the frame itself, or what a layer sheet's imported keys sample
    /// (`sampleLegacy`, whose channels are the sheet's `legacyAnimation`).
    pub fn native_at(&self, tick: f64) -> Frame {
        let (index, t) = row_at(&self.rows, tick);
        self.native_interval(index, t, tick)
    }

    // Imported sheet keys call sampleLegacy with an explicit interval ratio even
    // inside one-tick rows. Ordinary paused native playback keeps row_at's rule.
    fn native_at_fraction(&self, tick: f64) -> Frame {
        let (index, ratio) = row_at_fraction(&self.rows, tick);
        self.native_interval(index, ratio, tick)
    }

    fn native_interval(&self, index: usize, ratio: f64, tick: f64) -> Frame {
        self.with_channels(self.native_frame(index, ratio), tick)
    }

    /// The absolute source time corresponding to a local native key interval.
    pub(crate) fn retained_source_time(&self, index: usize, t: f64) -> Option<f64> {
        let source = self.doc.movieclip_source.as_ref()?;
        let start = source.ticks.get(index).copied().flatten()?;
        let finish = source
            .ticks
            .get(index + 1)
            .copied()
            .flatten()
            .unwrap_or(start + self.rows.get(index).map_or(1.0, |row| row.count as f64));
        Some(start + (finish - start) * t.clamp(0.0, 1.0))
    }

    fn retained_source_time_at(&self, tick: f64) -> Option<f64> {
        if self.doc.sheet.is_some() {
            return None;
        }
        let (index, t) = row_at_fraction(&self.rows, tick);
        self.retained_source_time(index, t)
    }

    fn native_frame(&self, index: usize, t: f64) -> Frame {
        let (Some(source), Some(source_tick)) = (&self.source, self.retained_source_time(index, t))
        else {
            return evaluate_native(&self.doc, &self.native, index, t);
        };
        let mut frame = source.evaluate_raw(source_tick, true);
        if source.doc.vfx_clips.is_some() { frame.retained_vfx_tick = Some(source_tick); }
        // Source clocks are sampled before the local crop restores its presence
        // offsets, as evaluatedFrame does for retained samples. Hidden instances
        // stay present here; apply_movieclips owns visibility filtering.
        for object in &mut frame.objects {
            let time = source.clip_local(object, source_tick);
            if let Some(time) = time {
                Arc::make_mut(object).clip_time = time;
            }
            if let Some(local) = self
                .doc
                .keyframes
                .get(index)
                .and_then(|key| key.object(object.uid))
                .filter(|local| local.movieclip.as_ref().is_some_and(|p| p.presence))
            {
                Arc::make_mut(object).movieclip = local.movieclip.clone();
            }
        }
        apply_layer_order(&source.doc, &mut frame);
        frame
    }

    /// `composePoseChannels` then `composeAnimationChannels` at `tick`.
    fn with_channels(&self, frame: Frame, tick: f64) -> Frame {
        match &self.channels {
            Some(channels) => channels.compose(&self.doc, frame, tick),
            None => frame,
        }
    }

    /// Keyframe index whose start is exactly `tick`, if any (native timelines).
    pub fn key_at(&self, tick: u32) -> Option<usize> {
        self.rows.iter().position(|r| r.start == tick && r.count > 0)
    }

    pub fn key_ticks(&self) -> Vec<u32> {
        if let Some(sheet) = &self.doc.sheet {
            let mut ticks: Vec<u32> = sheet.tracks.values().flat_map(|t| t.keys.iter().map(|k| k.tick)).filter(|&t| t < sheet.duration).collect();
            ticks.push(0);
            ticks.sort_unstable();
            ticks.dedup();
            return ticks;
        }
        self.rows.iter().filter(|r| r.count > 0).map(|r| r.start).collect()
    }

    /// `sample(id)` in `sampleLayerSheet`: the layer's own pose, then the movieclip
    /// frames its key replaces; with what the editor's frame object is (see [`Sampled`]).
    fn sample_track(&self, id: &str, tick: f64) -> Option<(Frame, Sampled)> {
        let track = self.doc.sheet.as_ref()?.tracks.get(id)?;
        let sampled = self.sample_base(id, track, tick);
        if tick >= track.end as f64 {
            return sampled;
        }
        let (mut frame, mut identity) = match sampled {
            Some((frame, identity)) => (Some(frame), identity),
            None => (None, Sampled::Track),
        };
        // Replacements are read from every key, the patch-only ones included.
        let at = track.keys.partition_point(|k| k.tick as f64 <= tick);
        let Some(key) = at.checked_sub(1).map(|i| &track.keys[i]) else { return frame.map(|frame| (frame, identity)) };
        let next = track.keys.get(at);
        let held = key.easing.map(|e| e.mode) == Some(EasingMode::Constant);
        for patch in &key.movieclip_patches {
            let source = |fid: &Arc<str>| {
                let key = self.doc.pose_source(fid)?;
                Some(frame_of(&KeyRef { frame: key.clone(), duration: 1, easing: None, origin: Some(FrameRef::Source(fid.clone())) }))
            };
            // Consecutive replacements of one movieclip tween like any pose track.
            let tweened = !held && next.is_some_and(|n| n.movieclip_patches.iter().any(|p| p.uid == patch.uid));
            let replacement = match self.patches.get(&(id.to_string(), patch.uid)).filter(|_| tweened) {
                Some(seq) => sample_pose_track(&self.doc, seq, tick),
                None => source(&patch.frame_id),
            };
            let Some(replacement) = replacement else { continue };
            let base = frame.take().unwrap_or_else(|| match self.doc.keyframes.first() {
                Some(first) => Frame { objects: vec![], draw_order: vec![], origins: vec![], continuations: vec![], ..frame_of(&KeyRef { frame: first.clone(), duration: 1, easing: None, origin: None }) },
                None => Frame::default(),
            });
            frame = Some(self.replace_movieclip_frame(base, patch, replacement));
            identity = Sampled::Track;
        }
        frame.map(|frame| (frame, identity))
    }

    /// `replaceMovieclipFrame`: the objects of `replacement` take the place of the
    /// movieclip `patch.uid` in `base`, in its place in the draw order.
    fn replace_movieclip_frame(&self, base: Frame, patch: &crate::doc::MovieclipPatch, replacement: Frame) -> Frame {
        let removed = patch.uid;
        let added: std::collections::HashSet<u32> = replacement.objects.iter().map(|o| o.uid).collect();
        let uid_at = |frame: &Frame, slot: u32| frame.objects.get(slot as usize).map(|o| o.uid);
        let order_of = |frame: &Frame| -> Vec<u32> { frame.draw_order.iter().filter_map(|&slot| uid_at(frame, slot)).collect() };
        // Each kept object with where it was authored and the uid it joins.
        let mut members: Vec<(Arc<Object>, Option<(FrameRef, u32)>, Option<u32>)> = Vec::new();
        let mut geometry = None;
        for (slot, object) in base.objects.iter().enumerate() {
            if object.uid == removed || added.contains(&object.uid) {
                continue;
            }
            let mut object = object.clone();
            let mut origin = base.origins.get(slot).cloned().flatten();
            let mut parent = None;
            if let Some(join) = object.join {
                let target = uid_at(&base, join.slot);
                if target == Some(removed) && patch.replacement_uid.is_some() {
                    parent = patch.replacement_uid;
                } else if target == Some(removed) {
                    // Nothing replaces what it was joined to: it stays where the join held it.
                    let scene = geometry.get_or_insert_with(|| crate::geometry::build(&self.doc, &base));
                    let loose = Arc::make_mut(&mut object);
                    if let Some(placed) = scene.objects.iter().find(|g| g.slot == slot as u32 && g.resolved) {
                        loose.root = placed.root;
                    }
                    loose.join = None;
                    origin = None;
                } else {
                    parent = target;
                }
            }
            members.push((object, origin, parent));
        }
        for (slot, object) in replacement.objects.iter().enumerate() {
            let parent = object.join.and_then(|join| uid_at(&replacement, join.slot));
            members.push((object.clone(), replacement.origins.get(slot).cloned().flatten(), parent));
        }
        let previous = order_of(&base);
        let anchor = previous.iter().position(|&uid| uid == removed);
        let mut order: Vec<u32> = previous.iter().copied().filter(|uid| *uid != removed && !added.contains(uid)).collect();
        let mut insertion = anchor.map_or(order.len(), |anchor| anchor.min(order.len()));
        if let (None, Some(index), Some(layers)) = (anchor, patch.order_index, &self.doc.layers) {
            let layer = layers.layer_of(removed);
            let siblings: Vec<usize> = order.iter().enumerate().filter(|(_, uid)| layers.layer_of(**uid) == layer).map(|(at, _)| at).collect();
            insertion = match (siblings.get(index as usize), siblings.last()) {
                (Some(&at), _) => at,
                (None, Some(&last)) => last + 1,
                (None, None) => order.len(),
            };
        }
        order.splice(insertion..insertion, order_of(&replacement));
        // `normalizeFrame`: slots follow unique ids.
        members.sort_by_key(|(object, _, _)| object.uid as i32);
        let slots: HashMap<u32, u32> = members.iter().enumerate().map(|(slot, (object, _, _))| (object.uid, slot as u32)).collect();
        let mut objects = Vec::with_capacity(members.len());
        let mut origins = Vec::with_capacity(members.len());
        for (mut object, mut origin, parent) in members {
            if let Some(join) = object.join {
                let rejoined = parent.and_then(|uid| slots.get(&uid)).map(|&slot| Join { slot, handle: join.handle });
                if rejoined != object.join {
                    Arc::make_mut(&mut object).join = rejoined;
                    origin = None;
                }
            }
            objects.push(object);
            origins.push(origin);
        }
        let mut continuations: Vec<_> =
            base.continuations.iter().filter(|(uid, _)| *uid != removed && !replacement.continuations.iter().any(|(other, _)| other == uid)).cloned().collect();
        continuations.extend(replacement.continuations.iter().cloned());
        Frame { objects, origins, continuations, draw_order: order.iter().filter_map(|uid| slots.get(uid).copied()).collect(), ..base }
    }

    /// `baseSample`: the layer's pose from its keys, without movieclip replacements.
    fn sample_base(&self, id: &str, track: &SheetTrack, tick: f64) -> Option<(Frame, Sampled)> {
        if tick >= track.end as f64 && !FIXED.contains(&id) {
            return None;
        }
        let keys: Vec<&SheetKey> = track.keys.iter().filter(|k| !k.patch_only).collect();
        let at = keys.partition_point(|k| k.tick as f64 <= tick);
        let key = *keys.get(at.checked_sub(1)?)?;
        let next = keys.get(at).copied();
        if matches!(key.value, SheetValue::Frame(None)) {
            return None;
        }
        if let Some(n) = next
            && matches!(n.value, SheetValue::Frame(None))
        {
            return match &key.value {
                SheetValue::SourceTick(t) => Some((self.native_at_fraction(*t), Sampled::Native(t.to_bits()))),
                SheetValue::Frame(Some(id)) => self.doc.pose_source(id).map(|k| {
                    (frame_of(&KeyRef { frame: k.clone(), duration: 1, easing: None, origin: Some(FrameRef::Source(id.clone())) }), Sampled::Source(id.clone()))
                }),
                SheetValue::Frame(None) => None,
            };
        }
        if let SheetValue::SourceTick(source) = key.value
            && next.is_none_or(|n| matches!(n.value, SheetValue::SourceTick(_)))
        {
            let (fraction, target) = match next {
                Some(n) => {
                    let SheetValue::SourceTick(ns) = n.value else { unreachable!() };
                    (((tick - key.tick as f64) / (n.tick as f64 - key.tick as f64)).clamp(0.0, 1.0), ns)
                }
                None => (0.0, source),
            };
            let time = source + fraction * (target - source);
            return Some((self.native_at_fraction(time), Sampled::Native(time.to_bits())));
        }
        if self.imported.get(id).copied().unwrap_or(false) {
            let index = at - 1;
            let (seq, first) = self.mixed_window(id, &keys, index);
            let fraction = next.map_or(0.0, |n| (tick - key.tick as f64) / (n.tick as f64 - key.tick as f64));
            return Some((evaluate_native(&self.doc, &seq, index - first, fraction), Sampled::Track));
        }
        let seq = self.tracks.get(id)?;
        sample_pose_track(&self.doc, seq, tick).map(|frame| (frame, Sampled::Track))
    }

    /// A layer that mixes imported and authored keys (an imported animation after an
    /// edit) tweens through a window of the keys around the playhead: one before the
    /// interval and one after, each imported key standing in as the layer's own
    /// figures of the imported pose at its source tick (`baseSample`'s `imported`
    /// branch). Returns the window as a timeline and the index of its first key.
    pub(crate) fn mixed_window(&self, id: &str, keys: &[&SheetKey], index: usize) -> (Seq, usize) {
        let (first, last) = (index.saturating_sub(1), (index + 3).min(keys.len()));
        let fixed = FIXED.contains(&id);
        let window = keys[first..last]
            .iter()
            .enumerate()
            .map(|(i, entry)| {
                let (frame, origin) = match &entry.value {
                    SheetValue::SourceTick(time) => (Some(Arc::new(self.endpoint(id, fixed, *time))), None),
                    SheetValue::Frame(Some(fid)) => (self.doc.pose_source(fid).cloned(), Some(FrameRef::Source(fid.clone()))),
                    SheetValue::Frame(None) => (None, None),
                };
                let frame = frame.unwrap_or_else(|| {
                    // No pose: the first keyframe's own fields, without figures.
                    let mut blank = self.doc.keyframes.first().map(|k| (**k).clone()).unwrap_or_else(blank_keyframe);
                    blank.objects.clear();
                    blank.draw_order.clear();
                    blank.slot_of.clear();
                    Arc::new(blank)
                });
                let until = keys.get(first + i + 1).map_or(entry.tick + 1, |next| next.tick);
                KeyRef { frame, duration: until.saturating_sub(entry.tick), easing: Some(entry.easing.unwrap_or(Easing::LINEAR)), origin: if fixed { None } else { origin } }
            })
            .collect();
        (Seq { keys: window, version: 5, auto_easing: self.doc.auto_easing, ticks: Vec::new() }, first)
    }

    /// `snapshotPoseFrame(sourceAt(time), <the layer's figures>)`: the imported pose at
    /// `time` reduced to the figures of layer `id` and the figures they are joined to.
    fn endpoint(&self, id: &str, fixed: bool, time: f64) -> Keyframe {
        let source = self.native_at_fraction(time);
        let layers = self.doc.layers.clone().unwrap_or_default();
        let mut wanted = vec![false; source.objects.len()];
        if !fixed {
            let mut queue: Vec<usize> = (0..source.objects.len()).filter(|&slot| layers.layer_of(source.objects[slot].uid) == id).collect();
            for &slot in &queue {
                wanted[slot] = true;
            }
            let mut q = 0;
            while q < queue.len() {
                if let Some(parent) = source.objects[queue[q]].join.map(|j| j.slot as usize).filter(|&p| p < wanted.len() && !wanted[p]) {
                    wanted[parent] = true;
                    queue.push(parent);
                }
                q += 1;
            }
        }
        let mut remap = vec![u32::MAX; wanted.len()];
        let mut objects = Vec::new();
        for (slot, object) in source.objects.iter().enumerate().filter(|(slot, _)| wanted[*slot]) {
            remap[slot] = objects.len() as u32;
            objects.push(object.clone());
        }
        for object in objects.iter_mut() {
            if let Some(join) = object.join {
                let target = remap.get(join.slot as usize).copied().filter(|&slot| slot != u32::MAX);
                let rejoined = target.map(|slot| Join { slot, handle: join.handle });
                if rejoined != object.join {
                    Arc::make_mut(object).join = rejoined;
                }
            }
        }
        let mut frame = Keyframe {
            duration: 1,
            retained_vfx_tick: None,
            draw_order: source.draw_order.iter().filter_map(|&slot| remap.get(slot as usize).copied().filter(|&slot| slot != u32::MAX)).collect(),
            objects,
            camera: source.camera,
            background: source.background,
            background_b: source.background_b,
            background_mix: source.background_mix,
            easing: None,
            frame_id: None,
            slot_of: HashMap::new(),
            continuations: source.continuations.clone(),
            background_color: source.background_color,
            vfx: source.pose_vfx.clone(),
        };
        frame.reindex();
        frame
    }

    /// `sampleLayerSheet`: compose each layer's own pose track.
    fn sample_sheet(&self, tick: f64) -> Frame {
        let doc = &self.doc;
        let scene = self.sample_track("scene", tick);
        let camera = self.sample_track("camera", tick);
        let layers = doc.layers.clone().unwrap_or_default();
        let frames: Vec<(&String, Option<(Frame, Sampled)>)> = layers.order.iter().map(|id| (id, self.sample_track(id, tick))).collect();
        // Imported layers that share one native pose are that pose, whole, slots included.
        if let (Some((scene, identity)), Some((_, other))) = (&scene, &camera)
            && *identity != Sampled::Track
            && other == identity
            && frames.iter().all(|(_, sampled)| match sampled {
                None => true,
                Some((frame, sampled)) => sampled == identity || (frame.objects.is_empty() && frame.continuations.is_empty()),
            })
        {
            let shared: std::collections::HashSet<&str> = frames.iter().filter(|(_, s)| s.as_ref().is_some_and(|(_, s)| s == identity)).map(|(id, _)| id.as_str()).collect();
            if scene.objects.iter().all(|o| shared.contains(layers.layer_of(o.uid))) && scene.continuations.iter().all(|(uid, _)| shared.contains(layers.layer_of(*uid))) {
                return Frame { tick, ..scene.clone() };
            }
        }
        let mut objects: Vec<Arc<Object>> = Vec::new();
        let mut origins = Vec::new();
        let mut parents: Vec<Option<u32>> = Vec::new();
        let mut continuations = Vec::new();
        for (id, sampled) in &frames {
            let Some((frame, _)) = sampled else { continue };
            continuations.extend(frame.continuations.iter().filter(|(uid, _)| layers.layer_of(*uid) == id.as_str()).cloned());
            for &slot in &frame.draw_order {
                let object = &frame.objects[slot as usize];
                if layers.layer_of(object.uid) != id.as_str() {
                    continue;
                }
                parents.push(object.join.map(|j| frame.objects[j.slot as usize].uid));
                origins.push(frame.origins.get(slot as usize).cloned().flatten());
                objects.push(object.clone());
            }
        }
        let slots: HashMap<u32, u32> = objects.iter().enumerate().map(|(i, o)| (o.uid, i as u32)).collect();
        for (i, parent) in parents.iter().enumerate() {
            let object = &objects[i];
            if object.join.is_none() {
                continue;
            }
            let target = parent.and_then(|p| slots.get(&p).copied());
            let join = target.map(|slot| Join { slot, handle: object.join.unwrap().handle });
            if object.join != join {
                Arc::make_mut(&mut objects[i]).join = join;
            }
        }
        let scene = scene.map(|(frame, _)| frame);
        let (background, background_b, background_mix) = match &scene {
            Some(s) => (s.background, s.background_b, s.background_mix),
            None => (0, 0, 0.0),
        };
        let background_color = scene.as_ref().and_then(|s| s.background_color);
        let pose_vfx = scene.as_ref().and_then(|s| s.pose_vfx.clone());
        Frame {
            tick,
            retained_vfx_tick: doc.keyframes.first().and_then(|k| k.retained_vfx_tick),
            draw_order: (0..objects.len() as u32).collect(),
            objects,
            camera: Some(camera.and_then(|(c, _)| c.camera).unwrap_or_default()),
            background,
            background_b,
            background_mix,
            origins,
            continuations,
            background_color,
            pose_vfx,
            vfx: None,
            export_vfx: Vec::new(),
            parallax: None,
        }
    }
}

/// `nativeTimeline`: start and tick count of each keyframe.
pub fn native_timeline(doc: &Document) -> Vec<Row> {
    timeline_rows(doc.version, doc.keyframes.iter().map(|k| k.duration))
}

/// The native timeline from a document's version and keyframe durations (`duration_raw`).
pub fn timeline_rows(version: u32, durations: impl ExactSizeIterator<Item = u32>) -> Vec<Row> {
    let mut tick = 0;
    let n = durations.len();
    durations
        .enumerate()
        .map(|(i, duration)| {
            let ticks = frame_ticks(duration);
            let count = if version >= 5 && i == n - 1 { ticks.min(1) } else { ticks };
            let row = Row { start: tick, count };
            tick += count;
            row
        })
        .collect()
}

/// Row index and fraction for a tick (Editor.evaluatedFrame).
pub fn row_at(rows: &[Row], tick: f64) -> (usize, f64) {
    let index = rows.partition_point(|r| r.start as f64 <= tick).saturating_sub(1);
    let row = rows.get(index).copied().unwrap_or(Row { start: 0, count: 0 });
    let t = if row.count > 1 { ((tick - row.start as f64) / row.count as f64).clamp(0.0, 1.0) } else { 0.0 };
    (index, t)
}

/// Row and fraction without the editor's single-tick rule (movieclip sampling).
pub fn row_at_fraction(rows: &[Row], tick: f64) -> (usize, f64) {
    let index = rows.partition_point(|r| r.start as f64 <= tick).saturating_sub(1);
    let row = rows.get(index).copied().unwrap_or(Row { start: 0, count: 0 });
    let t = if row.count > 0 { (tick - row.start as f64) / row.count as f64 } else { 0.0 };
    (index, t)
}

/// `movieclipTime`: local clip time, or None when the clip is not shown.
pub fn movieclip_time(clip: &Movieclip, s: &MovieclipPlayback, tick: f64, fps: f64) -> Option<f64> {
    if tick < s.start || s.end.is_some_and(|e| tick >= e) {
        return None;
    }
    let duration = clip.duration;
    let at = s.restarts.partition_point(|r| r.0 <= tick);
    let (phase_tick, phase_offset) = match at.checked_sub(1) {
        Some(i) => s.restarts[i],
        None => (s.start, s.offset),
    };
    let raw = if s.mode == MovieclipMode::Single { phase_offset } else { phase_offset + (tick - phase_tick) * s.speed * clip.document.fps / fps };
    match s.mode {
        MovieclipMode::Loop => Some(((raw % duration) + duration) % duration),
        MovieclipMode::Once if raw >= duration => None,
        _ => Some(raw.clamp(0.0, (duration - 1.0).max(0.0))),
    }
}

/// Which of the editor's frame objects a layer's sample is (`sampleLayerSheet` caches
/// `sourceAt(time)` and returns retained sources as they are): layers whose samples are the
/// same object share it, slots included.
#[derive(Clone, Debug, PartialEq)]
enum Sampled {
    /// `sourceAt(time)`: the native timeline at a time (its bits).
    Native(u64),
    /// A retained pose source, by id.
    Source(Arc<str>),
    /// A frame of the layer's own (never shared with another layer's).
    Track,
}

/// The pose track of a layer: its keys that carry a pose of their own.
fn pose_track(doc: &Document, id: &str, track: &SheetTrack) -> Seq {
    let keys = track.keys.iter().filter(|k| !k.patch_only).map(|k| (k, if let SheetValue::Frame(Some(fid)) = &k.value { Some(fid) } else { None }));
    virtual_track(doc, FIXED.contains(&id), keys.collect())
}

/// The pose track of what replaces movieclip `uid` on a layer: every key of the
/// layer, posing the frame it replaces the movieclip with (or nothing).
fn patch_track(doc: &Document, track: &SheetTrack, uid: u32) -> Seq {
    let keys = track.keys.iter().map(|k| (k, k.movieclip_patches.iter().find(|p| p.uid == uid).map(|p| &p.frame_id)));
    virtual_track(doc, false, keys.collect())
}

/// A pose with nothing in it: no figures, the default camera, the first background.
pub(crate) fn blank_keyframe() -> Keyframe {
    Keyframe {
        duration: 1,
        retained_vfx_tick: None,
        objects: vec![],
        draw_order: vec![],
        camera: Some(Camera::default()),
        background: 0,
        background_b: 0,
        background_mix: 0.0,
        easing: None,
        frame_id: None,
        slot_of: HashMap::new(),
        continuations: Vec::new(),
        background_color: None,
        vfx: None,
    }
}

/// `buildVirtualPoseTrack`: keys become a native timeline of their source poses.
fn virtual_track(doc: &Document, fixed: bool, mut keys: Vec<(&SheetKey, Option<&Arc<str>>)>) -> Seq {
    keys.sort_by(|a, b| a.0.tick.cmp(&b.0.tick).then((b.0.hidden as u8).cmp(&(a.0.hidden as u8))));
    let blank = Arc::new(blank_keyframe());
    let refs = keys
        .iter()
        .enumerate()
        .map(|(i, (key, frame_id))| {
            let (source, origin) = match frame_id.and_then(|fid| Some((doc.pose_source(fid)?, fid))) {
                Some((k, fid)) => (k.clone(), Some(FrameRef::Source((*fid).clone()))),
                None => (blank.clone(), None),
            };
            // Fixed tracks only need their camera/background fields.
            let source = if fixed && !source.objects.is_empty() {
                let mut k = (*source).clone();
                k.objects.clear();
                k.draw_order.clear();
                k.slot_of.clear();
                Arc::new(k)
            } else {
                source
            };
            let next = keys.get(i + 1);
            KeyRef {
                easing: if key.easing.is_some() { key.easing } else { source.easing },
                duration: if key.hidden { 0 } else { next.map(|n| n.0.tick.saturating_sub(key.tick)).unwrap_or(1) },
                frame: source,
                origin: if fixed { None } else { origin },
            }
        })
        .collect();
    Seq { keys: refs, version: 5, auto_easing: doc.auto_easing, ticks: keys.iter().map(|k| k.0.tick as f64).collect() }
}

/// `samplePoseTrack`: the interval of the track's own key ticks around `tick`.
pub(crate) fn sample_pose_track(doc: &Document, seq: &Seq, tick: f64) -> Option<Frame> {
    sample_pose_track_only(doc, seq, tick, None)
}

/// [`sample_pose_track`] tweening only the figures `uids` (and those they hang from) when given.
pub(crate) fn sample_pose_track_only(doc: &Document, seq: &Seq, tick: f64, uids: Option<&[u32]>) -> Option<Frame> {
    let ticks = &seq.ticks;
    if ticks.is_empty() || tick < ticks[0] {
        return None;
    }
    let low = ticks.partition_point(|&t| t <= tick) - 1;
    let fraction = match ticks.get(low + 1) {
        Some(&next) if next > ticks[low] => ((tick - ticks[low]) / (next - ticks[low])).clamp(0.0, 1.0),
        _ => 0.0,
    };
    Some(match uids {
        Some(uids) => evaluate_native_only(doc, seq, low, fraction, uids),
        None => evaluate_native(doc, seq, low, fraction),
    })
}

/// `applyLayerOrder`: group back-to-front by user layer, stable within each.
pub fn apply_layer_order(doc: &Document, frame: &mut Frame) {
    let has_depth = frame.objects.iter().any(|o| o.z_index != 0.0);
    let Some(layers) = &doc.layers else {
        if has_depth {
            frame.draw_order.sort_by(|&a, &b| frame.objects[a as usize].z_index.total_cmp(&frame.objects[b as usize].z_index));
        }
        return;
    };
    if layers.order.len() < 2 && !has_depth {
        return;
    }
    let mut groups: Vec<Vec<u32>> = vec![Vec::new(); layers.order.len().max(1)];
    let index: HashMap<&str, usize> = layers.order.iter().enumerate().map(|(i, id)| (id.as_str(), i)).collect();
    for &slot in &frame.draw_order {
        let uid = frame.objects[slot as usize].uid;
        let g = index.get(layers.layer_of(uid)).copied().unwrap_or(0);
        groups[g].push(slot);
    }
    let mut next = Vec::with_capacity(frame.draw_order.len());
    for mut group in groups {
        if has_depth {
            group.sort_by(|&a, &b| frame.objects[a as usize].z_index.total_cmp(&frame.objects[b as usize].z_index));
        }
        next.extend(group);
    }
    frame.draw_order = next;
}
