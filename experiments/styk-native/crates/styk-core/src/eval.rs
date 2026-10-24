//! Frame evaluation: the timeline, native Pivot tweening (`evaluatedNativeFrame`
//! in src/pivot/geometry.mjs) and the StykAnimate layer sheet
//! (`sampleLayerSheet` in src/layer-sheet.mjs).
//!
//! Evaluation is a pure function of an immutable [`Prepared`] document and a
//! tick, so any number of threads can evaluate different ticks concurrently.
//! Each tweened channel only reads the four keyframes around its interval
//! (Pivot's monotone cubic only needs the neighbouring secants), so cost is
//! O(segments) per figure, independent of how long the keyframe run is.

use std::collections::HashMap;
use std::sync::Arc;

use crate::doc::*;

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
}

/// A document plus the timing tables evaluation needs, built once per revision.
pub struct Prepared {
    pub doc: Arc<Document>,
    pub native: Seq,
    pub rows: Vec<Row>,
    pub total_ticks: u32,
    tracks: HashMap<String, Arc<Seq>>,
    imported: HashMap<String, bool>,
    /// Presence-clock spans per movieclip instance: (start, end, elapsed, rate).
    presence: HashMap<u32, Vec<(f64, f64, f64, f64)>>,
}

pub fn shortest(a: f64) -> f64 {
    a.sin().atan2(a.cos())
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
    3.0 * (1.0 - t).powi(2) * t * a + 3.0 * (1.0 - t) * t * t * b + t.powi(3)
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
struct Sampler {
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

impl Sampler {
    fn new(seq: &Seq, index: usize, t: f64) -> Sampler {
        let keys = &seq.keys;
        let mode = |k: usize| keys.get(k).and_then(|f| f.easing).map(|e| e.mode);
        let ticks = |k: Option<usize>| k.and_then(|k| keys.get(k)).map(|f| frame_ticks(f.duration) as f64).unwrap_or(0.0);
        Sampler {
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
        let u0 = if left { v[0].unwrap() } else { 0.0 };
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

fn color_tween(a: u32, b: u32, t: f64) -> u32 {
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
    }
}

/// `evaluatedNativeFrame`: one interval of a native or virtual timeline.
pub fn evaluate_native(doc: &Document, seq: &Seq, index: usize, t: f64) -> Frame {
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
    let sampler = Sampler::new(seq, index, t);
    let around = |k: Option<usize>| k.and_then(|k| keys.get(k)).map(|f| &f.frame);
    let frames = [around(index.checked_sub(1)), Some(&a.frame), Some(&b.frame), around(Some(index + 2))];
    let mut objects = Vec::with_capacity(a.frame.objects.len());
    for o in &a.frame.objects {
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
        (Some(_), Some(_)) => {
            let cams = frames.map(|f| f.map(|f| f.camera.unwrap_or_default()));
            let get = |k: fn(&Camera) -> f64| cams.map(|c| c.as_ref().map(k));
            Some(Camera {
                x: sampler.value(get(|c| c.x), false),
                y: sampler.value(get(|c| c.y), false),
                scale: sampler.value(get(|c| c.scale), false),
                angle: sampler.value(get(|c| c.angle), true),
                is_default: false,
            })
        }
        _ => a.frame.camera,
    };
    let bg_t = if auto { eased_progress(a.easing.as_ref(), t) } else { t };
    let (background, background_b, background_mix) = tween_background(&a.frame, &b.frame, a.duration, bg_t);
    Frame {
        tick: 0.0,
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
    out.root = [s.value(read(&|x| x.root[0]), false), s.value(read(&|x| x.root[1]), false)];
    out.scale = s.value(read(&|x| x.scale), false);
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
        let relative = s.value(recs.map(|r| r.map(relative_of)), true);
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
        let mut tracks = HashMap::new();
        let mut imported = HashMap::new();
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
            }
        } else if let Some(last) = rows.last_mut() {
            last.count = last.count.max(clip_end.saturating_sub(last.start));
        }
        let total_ticks = rows.last().map(|r| r.start + r.count).unwrap_or(0).max(1);
        let mut prepared = Prepared { doc, native, rows, total_ticks, tracks, imported, presence: HashMap::new() };
        prepared.presence = prepared.presence_index();
        prepared
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
        let mut times: Vec<u32> = vec![0];
        match &self.doc.sheet {
            Some(sheet) => {
                times.push(sheet.duration);
                for t in sheet.tracks.values() {
                    times.push(t.end);
                    times.extend(t.keys.iter().map(|k| k.tick));
                }
            }
            None => {
                for r in &self.rows {
                    times.push(r.start);
                    times.push(r.start + r.count);
                }
            }
        }
        times.sort_unstable();
        times.dedup();
        let mut elapsed: HashMap<u32, f64> = HashMap::new();
        for w in times.windows(2) {
            let (start, end) = (w[0] as f64, w[1] as f64);
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

    fn presence_elapsed(&self, uid: u32, tick: f64) -> f64 {
        let Some(spans) = self.presence.get(&uid) else { return 0.0 };
        let i = spans.partition_point(|s| s.0 <= tick);
        match i.checked_sub(1).map(|i| spans[i]) {
            Some((start, end, elapsed, rate)) => elapsed + (tick.min(end) - start).max(0.0) * rate,
            None => 0.0,
        }
    }

    /// `sampleMovieclipObjects`: chooses each instance's local clip time and
    /// removes instances that are not playing at this tick.
    fn apply_movieclips(&self, frame: &mut Frame, tick: f64) {
        if !self.has_clips() {
            return;
        }
        let doc = &self.doc;
        let mut hidden = false;
        for object in frame.objects.iter_mut() {
            let Some(clip) = doc.figure(object.figure).and_then(|f| f.movieclip.clone()) else { continue };
            let default = MovieclipPlayback { start: 0.0, end: None, offset: 0.0, speed: 1.0, mode: MovieclipMode::Loop, presence: false, restarts: vec![] };
            let settings = object.movieclip.as_deref().cloned().unwrap_or(default);
            let local = if settings.presence {
                let time = if settings.mode == MovieclipMode::Single { 0.0 } else { self.presence_elapsed(object.uid, tick) };
                let s = MovieclipPlayback { start: 0.0, end: None, speed: 1.0, ..settings };
                movieclip_time(&clip, &s, time, doc.fps)
            } else {
                movieclip_time(&clip, &settings, tick, doc.fps)
            };
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
        let mut frame = self.evaluate_raw(tick, fractional);
        self.apply_movieclips(&mut frame, tick);
        apply_layer_order(&self.doc, &mut frame);
        if !self.doc.camera_motion.is_empty() {
            frame.camera = crate::camera::at_time(frame.camera, &self.doc.camera_motion, tick, self.doc.fps);
        }
        frame
    }

    fn evaluate_raw(&self, tick: f64, fractional: bool) -> Frame {
        let mut frame = if self.doc.sheet.is_some() {
            self.sample_sheet(tick)
        } else if fractional {
            let (index, t) = row_at_fraction(&self.rows, tick);
            evaluate_native(&self.doc, &self.native, index, t)
        } else {
            self.native_at(tick)
        };
        frame.tick = tick;
        frame
    }

    /// Native evaluation at an absolute (possibly fractional) tick.
    pub fn native_at(&self, tick: f64) -> Frame {
        let (index, t) = row_at(&self.rows, tick);
        evaluate_native(&self.doc, &self.native, index, t)
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

    fn sample_track(&self, id: &str, tick: f64) -> Option<Frame> {
        let sheet = self.doc.sheet.as_ref()?;
        let track = sheet.tracks.get(id)?;
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
                SheetValue::SourceTick(t) => Some(self.native_at(*t)),
                SheetValue::Frame(Some(id)) => self.doc.pose_source(id).map(|k| {
                    frame_of(&KeyRef { frame: k.clone(), duration: 1, easing: None, origin: Some(FrameRef::Source(id.clone())) })
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
            return Some(self.native_at(source + fraction * (target - source)));
        }
        if self.imported.get(id).copied().unwrap_or(false) {
            // Mixed imported/authored track: hold the authored pose (rare).
            return match &key.value {
                SheetValue::SourceTick(t) => Some(self.native_at(*t)),
                SheetValue::Frame(Some(fid)) => self.doc.pose_source(fid).map(|k| {
                    frame_of(&KeyRef { frame: k.clone(), duration: 1, easing: None, origin: Some(FrameRef::Source(fid.clone())) })
                }),
                SheetValue::Frame(None) => None,
            };
        }
        let seq = self.tracks.get(id)?;
        sample_pose_track(&self.doc, seq, tick)
    }

    /// `sampleLayerSheet`: compose each layer's own pose track.
    fn sample_sheet(&self, tick: f64) -> Frame {
        let doc = &self.doc;
        let scene = self.sample_track("scene", tick);
        let camera = self.sample_track("camera", tick);
        let layers = doc.layers.clone().unwrap_or_default();
        let mut objects: Vec<Arc<Object>> = Vec::new();
        let mut origins = Vec::new();
        let mut parents: Vec<Option<u32>> = Vec::new();
        let mut continuations = Vec::new();
        for id in &layers.order {
            let Some(frame) = self.sample_track(id, tick) else { continue };
            continuations.extend(frame.continuations.iter().filter(|(uid, _)| layers.layer_of(*uid) == id).cloned());
            for &slot in &frame.draw_order {
                let object = &frame.objects[slot as usize];
                if layers.layer_of(object.uid) != id {
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
        let (background, background_b, background_mix) = match &scene {
            Some(s) => (s.background, s.background_b, s.background_mix),
            None => (0, 0, 0.0),
        };
        let background_color = scene.as_ref().and_then(|s| s.background_color);
        Frame {
            tick,
            draw_order: (0..objects.len() as u32).collect(),
            objects,
            camera: Some(camera.and_then(|c| c.camera).unwrap_or_default()),
            background,
            background_b,
            background_mix,
            origins,
            continuations,
            background_color,
        }
    }
}

/// `nativeTimeline`: start and tick count of each keyframe.
pub fn native_timeline(doc: &Document) -> Vec<Row> {
    let mut tick = 0;
    let n = doc.keyframes.len();
    doc.keyframes
        .iter()
        .enumerate()
        .map(|(i, k)| {
            let ticks = frame_ticks(k.duration);
            let count = if doc.version >= 5 && i == n - 1 { ticks.min(1) } else { ticks };
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

/// `buildVirtualPoseTrack`: keys become a native timeline of their source poses.
fn pose_track(doc: &Document, id: &str, track: &SheetTrack) -> Seq {
    let fixed = FIXED.contains(&id);
    let mut keys: Vec<&SheetKey> = track.keys.iter().filter(|k| !k.patch_only).collect();
    keys.sort_by(|a, b| a.tick.cmp(&b.tick).then((b.hidden as u8).cmp(&(a.hidden as u8))));
    let blank = Arc::new(Keyframe {
        duration: 1,
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
    });
    let refs = keys
        .iter()
        .enumerate()
        .map(|(i, key)| {
            let (source, origin) = match &key.value {
                SheetValue::Frame(Some(fid)) => match doc.pose_source(fid) {
                    Some(k) => (k.clone(), Some(FrameRef::Source(fid.clone()))),
                    None => (blank.clone(), None),
                },
                _ => (blank.clone(), None),
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
                duration: if key.hidden { 0 } else { next.map(|n| n.tick.saturating_sub(key.tick)).unwrap_or(1) },
                frame: source,
                origin: if fixed { None } else { origin },
            }
        })
        .collect();
    Seq { keys: refs, version: 5, auto_easing: doc.auto_easing, ticks: keys.iter().map(|k| k.tick as f64).collect() }
}

/// `samplePoseTrack`: the interval of the track's own key ticks around `tick`.
fn sample_pose_track(doc: &Document, seq: &Seq, tick: f64) -> Option<Frame> {
    let ticks = &seq.ticks;
    if ticks.is_empty() || tick < ticks[0] {
        return None;
    }
    let low = ticks.partition_point(|&t| t <= tick) - 1;
    let fraction = match ticks.get(low + 1) {
        Some(&next) if next > ticks[low] => ((tick - ticks[low]) / (next - ticks[low])).clamp(0.0, 1.0),
        _ => 0.0,
    };
    Some(evaluate_native(doc, seq, low, fraction))
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
