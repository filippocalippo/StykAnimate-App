//! Follow cameras: camera-motion clips that keep figures in frame.
//!
//! Per tick, the followed figures are evaluated alone, with the figures they hang from
//! and the camera (`followSamplingReport`), and measured (`figureBounds`): their weighted
//! centre, the size of their union and the authored camera. A forward pass over a clip's
//! frames shapes those samples (dead zone, look-ahead, a critically damped spring per
//! axis, framing zoom) into an offset in output pixels and a log zoom per clip frame
//! (`ShapedPath`), stored in single precision like the editor's `Float32Array`.
//! `cameraTravelAt` moves the authored camera by the blend of the clips active at a tick
//! (`sampleFollow`): where the camera is, which parallax layers respond to and
//! camera-motion impulses shake.
//!
//! The pass is sequential, so a clip's path is worked out once per prepared document,
//! lazily: up to the frame asked for and a chunk beyond, and kept. Any thread may extend
//! it; the work runs outside any lock, and the longest path published wins (the lock only
//! swaps a pointer, D7). The editor keeps its paths across edits and resamples from the
//! key before a change; the engine prepares each revision afresh.

use std::cell::UnsafeCell;
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::doc::{Camera, CameraMotionClip, Document, Join, Keyframe};
use crate::eval::Prepared;

/// Clip frames shaped past the one asked for once a path has been started, so a playing clip
/// extends its path a few times rather than on every frame.
const CHUNK: usize = 256;

/// The follow clips of a document and the projection their figures are sampled in.
pub struct Follow {
    clips: Vec<Clip>,
    canvas: [f64; 2],
}

/// `FOLLOW_DEFAULTS`, the parameters a follow clip stores.
#[derive(Clone, Copy, Debug)]
struct Params {
    strength: f64,
    follow_x: f64,
    follow_y: f64,
    offset_x: f64,
    offset_y: f64,
    lag: f64,
    dead_zone: f64,
    look_ahead: f64,
    zoom_fit: f64,
    padding: f64,
    max_zoom: f64,
    fade_in: f64,
    fade_out: f64,
}

impl Params {
    fn of(clip: &CameraMotionClip) -> Params {
        let p = |key: &str, default: f64| clip.params.get(key).copied().unwrap_or(default);
        Params {
            strength: p("strength", 1.0),
            follow_x: p("followX", 1.0),
            follow_y: p("followY", 1.0),
            offset_x: p("offsetX", 0.0),
            offset_y: p("offsetY", 0.0),
            lag: p("lag", 8.0),
            dead_zone: p("deadZone", 0.0),
            look_ahead: p("lookAhead", 0.0),
            zoom_fit: p("zoomFit", 0.0),
            padding: p("padding", 0.2),
            max_zoom: p("maxZoom", 3.0),
            fade_in: p("fadeIn", 6.0),
            fade_out: p("fadeOut", 6.0),
        }
    }
}

struct Clip {
    start: f64,
    duration: f64,
    enabled: bool,
    muted: Vec<(f64, f64)>,
    params: Params,
    /// Followed figures and their weights.
    targets: Vec<(u32, f64)>,
    /// The document restricted to what the targets' poses depend on.
    projection: Arc<Prepared>,
    path: Latest<Path>,
}

/// What the followed figures look like at one tick (a `TargetSamples` row).
#[derive(Clone, Copy, Debug, Default)]
struct Sample {
    /// A target with a positive weight was drawn.
    found: bool,
    /// Weighted centre (the canvas centre when none was found).
    center: [f64; 2],
    /// Size of the union of every drawn target (zero when none was found).
    size: [f64; 2],
    /// The authored camera: x, y, scale, angle.
    camera: [f64; 4],
}

/// The spring and dead-zone state of a forward pass.
#[derive(Clone, Copy, Debug, Default)]
struct State {
    /// The sample the camera aims at: the latest one found (`held`).
    held: Option<Sample>,
    x: f64,
    xv: f64,
    y: f64,
    yv: f64,
    z: f64,
    zv: f64,
    hx: f64,
    hy: f64,
    primed: bool,
    /// While nothing is held: no sample is found from this clip frame to the end.
    absent_from: Option<usize>,
}

/// A clip's shaped path through some frames, with what the pass needs to go on.
#[derive(Clone, Debug, Default)]
struct Path {
    /// Offset x, offset y (output pixels) and log zoom per clip frame.
    frames: Vec<[f32; 3]>,
    state: State,
    /// Samples by clip frame (`tick - start`), through the look-ahead past the clip's end.
    samples: Vec<Option<Sample>>,
}

impl Follow {
    /// The follow clips of `doc` (`None` when it has none).
    pub fn new(doc: &Document) -> Option<Follow> {
        let follows: Vec<&CameraMotionClip> = doc.camera_motion.iter().filter(|c| c.kind == "follow" && !c.targets.is_empty()).collect();
        if follows.is_empty() {
            return None;
        }
        // One projection per set of targets (`followSamplingReport`).
        let mut projections: Vec<(Vec<u32>, Arc<Prepared>)> = Vec::new();
        let clips = follows
            .into_iter()
            .map(|clip| {
                let uids: Vec<u32> = clip.targets.iter().map(|t| t.0).collect();
                let projection = match projections.iter().find(|(set, _)| *set == uids) {
                    Some((_, projection)) => projection.clone(),
                    None => {
                        let projection = Arc::new(Prepared::new(Arc::new(projected(doc, &uids.iter().copied().collect()))));
                        projections.push((uids, projection.clone()));
                        projection
                    }
                };
                Clip {
                    start: clip.start,
                    duration: clip.duration,
                    enabled: clip.enabled,
                    muted: clip.muted.clone(),
                    params: Params::of(clip),
                    targets: clip.targets.clone(),
                    projection,
                    path: Latest::new(Path::default()),
                }
            })
            .collect();
        Some(Follow { clips, canvas: [doc.canvas[0] as f64, doc.canvas[1] as f64] })
    }

    /// `sampleFollow`: the offset (output pixels) and log zoom of the follow clips active
    /// at `tick`. Overlapping clips share one frame: their weights blend toward each
    /// target instead of adding up.
    pub fn offset(&self, tick: f64) -> [f64; 3] {
        self.offset_with(tick, true).expect("blocking path is always prepared")
    }

    /// Reads only paths workers have already published; never shapes or samples a frame.
    fn offset_ready(&self, tick: f64) -> Option<[f64; 3]> {
        self.offset_with(tick, false)
    }

    fn offset_with(&self, tick: f64, prepare: bool) -> Option<[f64; 3]> {
        let (mut x, mut y, mut zoom, mut total) = (0.0, 0.0, 0.0, 0.0);
        for clip in &self.clips {
            let age = tick - clip.start;
            if !clip.enabled || age < 0.0 || age >= clip.duration || clip.muted.iter().any(|r| tick >= r.0 && tick < r.1) {
                continue;
            }
            let weight = clip.envelope(age);
            if weight.is_nan() || weight <= 0.0 {
                continue;
            }
            let i = age.floor();
            let t = age - i;
            let next = (clip.duration - 1.0).min(i + 1.0);
            let path = if prepare { clip.path(next as usize, self.canvas) } else { clip.path.get() };
            let (a, b) = (path.frames.get(i as usize)?.map(f64::from), path.frames.get(next as usize)?.map(f64::from));
            x += weight * (a[0] + (b[0] - a[0]) * t);
            y += weight * (a[1] + (b[1] - a[1]) * t);
            zoom += weight * (a[2] + (b[2] - a[2]) * t);
            total += weight;
        }
        if total > 1.0 {
            x /= total;
            y /= total;
            zoom /= total;
        }
        Some([x, y, zoom])
    }

    /// `cameraTravelAt`: the authored camera `base` moved by the follow clips at `tick`.
    pub fn travel(&self, base: Option<Camera>, tick: f64) -> Option<Camera> {
        moved(base, self.offset(tick))
    }

    /// `None` is cold; `Some(None)` is a ready path with no camera.
    pub fn travel_ready(&self, base: Option<Camera>, tick: f64) -> Option<Option<Camera>> {
        Some(moved(base, self.offset_ready(tick)?))
    }
}

fn moved(base: Option<Camera>, [fx, fy, fz]: [f64; 3]) -> Option<Camera> {
    let none = |v: f64| v == 0.0 || v.is_nan();
    if none(fx) && none(fy) && none(fz) {
        return base;
    }
    let c = match base {
        Some(c) if !c.is_default => c,
        _ => Camera { x: 0.0, y: 0.0, scale: 1.0, angle: 0.0, is_default: false, motion_offset: None },
    };
    let (cos, sin) = (styk_math::cos(c.angle), styk_math::sin(c.angle));
    Some(Camera {
        x: c.x + c.scale * (cos * fx - sin * fy),
        y: c.y + c.scale * (sin * fx + cos * fy),
        scale: c.scale * styk_math::exp(fz),
        angle: c.angle,
        is_default: false,
        motion_offset: c.motion_offset,
    })
}

fn smooth(t: f64) -> f64 {
    t * t * (3.0 - 2.0 * t)
}

/// `Math.max` and `Math.min`: NaN wins.
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.max(b) }
}
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.min(b) }
}

/// A critically damped spring stepped one frame (`spring`).
fn spring(value: &mut f64, velocity: &mut f64, target: f64, time: f64) -> f64 {
    if time.is_nan() || time <= 0.0 {
        *value = target;
        *velocity = 0.0;
        return target;
    }
    let omega = 2.0 / time;
    let decay = 1.0 / (1.0 + omega + 0.48 * omega * omega + 0.235 * omega * omega * omega);
    let change = *value - target;
    let temp = *velocity + omega * change;
    *velocity = (*velocity - omega * temp) * decay;
    *value = target + (change + temp) * decay;
    *value
}

impl Clip {
    /// `followEnvelope`: strength times the fade in and out.
    fn envelope(&self, age: f64) -> f64 {
        let p = &self.params;
        let fade = |time: f64, span: f64| if span != 0.0 && !span.is_nan() { smooth(js_min(1.0, time / span)) } else { 1.0 };
        js_max(0.0, js_min(1.0, p.strength)) * js_min(fade(age, p.fade_in), fade(self.duration - age, p.fade_out))
    }

    /// `Math.round(lookAhead)`.
    fn lead(&self) -> usize {
        (self.params.look_ahead + 0.5).floor().max(0.0) as usize
    }

    /// The path through clip frame `upto` at least. A path nobody has started is shaped through
    /// that frame and no further, which is all a session needs for the revision it has just made
    /// (it works the path out itself, on the interface thread); a path that exists grows a chunk
    /// at a time, so a playing clip extends it rarely.
    fn path(&self, upto: usize, canvas: [f64; 2]) -> Arc<Path> {
        let known = self.path.get();
        if known.frames.len() > upto {
            return known;
        }
        let mut next = (*known).clone();
        drop(known);
        let ahead = if next.frames.is_empty() { 0 } else { CHUNK };
        let goal = (upto + 1).max(next.frames.len() + ahead).min(self.duration.max(0.0) as usize);
        self.extend(&mut next, goal, canvas);
        let next = Arc::new(next);
        self.path.offer(next.clone(), |new, old| new.frames.len() > old.frames.len());
        next
    }

    /// One sample, computed once per path.
    fn sample(&self, samples: &mut Vec<Option<Sample>>, frame: usize, canvas: [f64; 2]) -> Sample {
        if samples.len() <= frame {
            samples.resize(frame + 1, None);
        }
        if let Some(sample) = samples[frame] {
            return sample;
        }
        let sample = self.measure(self.start + frame as f64, canvas);
        samples[frame] = Some(sample);
        sample
    }

    /// `TargetSamples.ensure` for one tick: evaluate the projection and measure the targets.
    fn measure(&self, tick: f64, canvas: [f64; 2]) -> Sample {
        let frame = self.projection.evaluate_figures(tick);
        let scene = crate::geometry::build_measured(&self.projection.doc, &frame);
        measure_frame(&frame, &scene, &self.targets, canvas)
    }

    /// `ShapedPath.target`: the sample aimed at for clip frame `frame` (the look-ahead
    /// applied), holding the last one found while the targets are missing.
    fn target(&self, path: &mut Path, frame: usize, canvas: [f64; 2]) -> Option<Sample> {
        let sample = self.sample(&mut path.samples, frame, canvas);
        if sample.found {
            path.state.held = Some(sample);
        } else if path.state.held.is_none() {
            // Not yet seen: aim at the first frame ahead that shows them.
            let end = self.duration as usize + self.lead();
            let stop = path.state.absent_from.unwrap_or(end).min(end);
            for ahead in frame + 1..stop {
                let sample = self.sample(&mut path.samples, ahead, canvas);
                if sample.found {
                    path.state.held = Some(sample);
                    break;
                }
            }
            if path.state.held.is_none() {
                path.state.absent_from = Some(frame + 1);
            }
        }
        path.state.held
    }

    /// `ShapedPath.ensure`: shapes clip frames until `path` holds `goal` of them.
    fn extend(&self, path: &mut Path, goal: usize, canvas: [f64; 2]) {
        let p = self.params;
        let [width, height] = canvas;
        let lead = self.lead();
        let last = self.duration as usize - 1;
        let (dead_x, dead_y) = (p.dead_zone * width / 2.0, p.dead_zone * height / 2.0);
        while path.frames.len() < goal {
            let i = path.frames.len();
            let target = self.target(path, (last + lead).min(i + lead), canvas);
            let camera = self.sample(&mut path.samples, i, canvas).camera;
            let (mut lx, mut ly, mut zoom) = (0.0, 0.0, 0.0);
            if let Some(target) = target {
                // `d[camera + 7] || 1`: a zero or NaN scale is 1.
                let scale = if camera[2] != 0.0 && !camera[2].is_nan() { camera[2] } else { 1.0 };
                let (cos, sin) = (styk_math::cos(camera[3]), styk_math::sin(camera[3]));
                // The target's distance from the authored frame centre, in the frame's output pixels.
                let dx = target.center[0] - width / 2.0 - camera[0];
                let dy = target.center[1] - height / 2.0 - camera[1];
                lx = (cos * dx + sin * dy) / scale - p.offset_x;
                ly = (cos * dy - sin * dx) / scale - p.offset_y;
                if p.zoom_fit > 0.0 && (target.size[0] > 0.0 || target.size[1] > 0.0) {
                    let room = js_max(0.05, 1.0 - 2.0 * p.padding);
                    let fit = js_max(target.size[0] / (width * room), target.size[1] / (height * room)) / scale;
                    let limit = styk_math::log(p.max_zoom);
                    zoom = p.zoom_fit * js_max(-limit, js_min(limit, styk_math::log(js_max(1e-6, fit))));
                }
            }
            let s = &mut path.state;
            // The dead zone moves the camera only once the target leaves it (hysteresis).
            s.hx = js_max(lx - dead_x, js_min(lx + dead_x, if s.primed { s.hx } else { 0.0 }));
            s.hy = js_max(ly - dead_y, js_min(ly + dead_y, if s.primed { s.hy } else { 0.0 }));
            if !s.primed {
                s.primed = true;
                s.x = s.hx;
                s.y = s.hy;
                s.z = zoom;
            }
            let (hx, hy) = (s.hx, s.hy);
            let x = spring(&mut s.x, &mut s.xv, hx, p.lag) * p.follow_x;
            let y = spring(&mut s.y, &mut s.yv, hy, p.lag) * p.follow_y;
            let z = spring(&mut s.z, &mut s.zv, zoom, p.lag);
            path.frames.push([x as f32, y as f32, z as f32]);
        }
    }
}

/// What the `targets` look like in `frame`, whose `scene` was built by [`crate::geometry::build_measured`].
fn measure_frame(frame: &crate::eval::Frame, scene: &crate::geometry::Scene, targets: &[(u32, f64)], canvas: [f64; 2]) -> Sample {
    let (mut cx, mut cy, mut total) = (0.0, 0.0, 0.0);
    let mut union = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    // In the order the editor builds objects: roots by slot, then joined children level by level.
    for slot in build_order(frame) {
        let Some(geometry) = scene.objects.get(slot).filter(|g| g.resolved) else { continue };
        let Some(&(_, weight)) = targets.iter().find(|(uid, _)| *uid == geometry.uid) else { continue };
        let Some(own) = geometry.extent else { continue };
        if weight > 0.0 {
            cx += (own[0] + own[2]) / 2.0 * weight;
            cy += (own[1] + own[3]) / 2.0 * weight;
            total += weight;
        }
        union = [js_min(union[0], own[0]), js_min(union[1], own[1]), js_max(union[2], own[2]), js_max(union[3], own[3])];
    }
    let camera = match frame.camera {
        Some(c) if !c.is_default => [c.x, c.y, c.scale, c.angle],
        _ => [0.0, 0.0, 1.0, 0.0],
    };
    let found = total > 0.0;
    Sample {
        found,
        center: if found { [cx / total, cy / total] } else { [canvas[0] / 2.0, canvas[1] / 2.0] },
        size: if found { [union[2] - union[0], union[3] - union[1]] } else { [0.0, 0.0] },
        camera,
    }
}

/// `followFramingOffset`: the offset (output pixels, seen through the frame's own camera) that keeps `targets` where they
/// stand in `frame`, or `None` when none of them with a positive weight is drawn.
pub fn framing_offset(doc: &Document, frame: &crate::eval::Frame, targets: &[(u32, f64)]) -> Option<[f64; 2]> {
    let scene = crate::geometry::build_measured(doc, frame);
    let canvas = [doc.canvas[0] as f64, doc.canvas[1] as f64];
    let sample = measure_frame(frame, &scene, targets, canvas);
    if !sample.found {
        return None;
    }
    let [camera_x, camera_y, scale, angle] = sample.camera;
    let (cos, sin) = (styk_math::cos(angle), styk_math::sin(angle));
    let dx = sample.center[0] - canvas[0] / 2.0 - camera_x;
    let dy = sample.center[1] - canvas[1] / 2.0 - camera_y;
    Some([(cos * dx + sin * dy) / scale, (cos * dy - sin * dx) / scale])
}

/// Slots in the order the editor builds a frame's objects: every unjoined object by
/// slot, then the objects joined to each, breadth first.
fn build_order(frame: &crate::eval::Frame) -> Vec<usize> {
    let n = frame.objects.len();
    let mut children: Vec<Vec<usize>> = vec![Vec::new(); n];
    let mut order: Vec<usize> = Vec::with_capacity(n);
    for (slot, object) in frame.objects.iter().enumerate() {
        match object.join {
            None => order.push(slot),
            Some(join) => {
                if let Some(list) = children.get_mut(join.slot as usize) {
                    list.push(slot);
                }
            }
        }
    }
    let mut q = 0;
    while q < order.len() {
        let slot = order[q];
        order.extend_from_slice(&children[slot]);
        q += 1;
    }
    order
}

/// `followSamplingReport`: the document with only the followed figures and the joins
/// they hang from in every pose, and without camera motion or effect clips.
fn projected(doc: &Document, keep: &HashSet<u32>) -> Document {
    let mut out = doc.clone();
    out.camera_motion.clear();
    out.vfx_clips = None;
    out.vfx_elsewhere = false;
    out.keyframes = doc.keyframes.iter().map(|frame| project_frame(frame, keep)).collect();
    out.frame_sources = doc.frame_sources.iter().map(|(id, frame)| (id.clone(), project_frame(frame, keep))).collect();
    // `_styk.animation` keeps the channels of the camera, of layers and of the followed
    // figures themselves; a layer sheet keeps its `legacyAnimation` whole.
    if out.sheet.is_none()
        && let Some(animation) = &doc.animation
    {
        let channels: Vec<_> = animation
            .channels
            .iter()
            .filter(|c| matches!(c.target, crate::channels::Target::Camera | crate::channels::Target::Layer { .. }) || c.target.uid().is_some_and(|uid| keep.contains(&uid)))
            .cloned()
            .collect();
        out.animation = crate::channels::Animation::of(channels);
    }
    out
}

/// `projectFrame`: the followed figures and every figure up their join chains.
fn project_frame(frame: &Arc<Keyframe>, keep: &HashSet<u32>) -> Arc<Keyframe> {
    let objects = &frame.objects;
    let n = objects.len();
    if n == 0 {
        return frame.clone();
    }
    let mut kept = vec![false; n];
    for i in 0..n {
        if !keep.contains(&objects[i].uid) {
            continue;
        }
        let (mut slot, mut guard) = (Some(i), 0);
        while let Some(s) = slot {
            if s >= n || kept[s] || guard > n {
                break;
            }
            kept[s] = true;
            guard += 1;
            slot = objects[s].join.map(|join| join.slot as usize);
        }
    }
    if kept.iter().all(|&k| k) {
        return frame.clone();
    }
    let mut index = vec![u32::MAX; n];
    let mut next = 0u32;
    for (slot, &k) in kept.iter().enumerate() {
        if k {
            index[slot] = next;
            next += 1;
        }
    }
    let mut out: Keyframe = (**frame).clone();
    out.objects = objects
        .iter()
        .enumerate()
        .filter(|(slot, _)| kept[*slot])
        .map(|(_, object)| {
            let mut object = object.clone();
            if let Some(join) = object.join {
                let target = index.get(join.slot as usize).copied().filter(|&t| t != u32::MAX).map(|slot| Join { slot, handle: join.handle });
                if target != object.join {
                    Arc::make_mut(&mut object).join = target;
                }
            }
            object
        })
        .collect();
    out.draw_order = frame.draw_order.iter().filter(|&&slot| kept.get(slot as usize).copied().unwrap_or(false)).map(|&slot| index[slot as usize]).collect();
    out.reindex();
    Arc::new(out)
}

/// The latest of a value several threads may replace. Taking or offering it holds a
/// spinning lock for a pointer copy (D7: the interface thread never waits on a futex).
struct Latest<T> {
    busy: AtomicBool,
    value: UnsafeCell<Arc<T>>,
}

// SAFETY: the value is only reached while `busy` is held, and only to clone or swap an `Arc`.
unsafe impl<T: Send + Sync> Sync for Latest<T> {}
unsafe impl<T: Send + Sync> Send for Latest<T> {}

impl<T> Latest<T> {
    fn new(value: T) -> Latest<T> {
        Latest { busy: AtomicBool::new(false), value: UnsafeCell::new(Arc::new(value)) }
    }

    fn with<R>(&self, f: impl FnOnce(&mut Arc<T>) -> R) -> R {
        while self.busy.compare_exchange_weak(false, true, Ordering::Acquire, Ordering::Relaxed).is_err() {
            std::hint::spin_loop();
        }
        // SAFETY: `busy` is held.
        let result = f(unsafe { &mut *self.value.get() });
        self.busy.store(false, Ordering::Release);
        result
    }

    fn get(&self) -> Arc<T> {
        self.with(|value| value.clone())
    }

    /// Replaces the value with `next` when `better(next, current)`; the replaced value is dropped after the lock.
    fn offer(&self, next: Arc<T>, better: impl FnOnce(&T, &T) -> bool) {
        let replaced = self.with(|value| if better(&next, value) { Some(std::mem::replace(value, next)) } else { None });
        drop(replaced);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_cold_path_is_shaped_through_the_frame_asked_and_then_grows_in_chunks() {
        let tree = styk_doc::json::parse(&std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/eval/follow-figures.json")).unwrap()).unwrap();
        let mut doc = crate::from_value(&tree, "bounded").unwrap();
        for clip in doc.camera_motion.iter_mut().filter(|clip| clip.kind == "follow") { clip.duration = 100_000.0; }
        let follow = super::Follow::new(&doc).unwrap();
        let shaped = |follow: &super::Follow| follow.clips.iter().map(|clip| clip.path.get().frames.len()).collect::<Vec<_>>();
        assert!(shaped(&follow).iter().all(|&frames| frames == 0));
        // The clips start at tick 2: tick 5 is clip frame 3, which reads frames 3 and 4.
        follow.travel(None, 5.0);
        assert!(shaped(&follow).iter().all(|&frames| frames == 5), "a cold path went past the frame asked: {:?}", shaped(&follow));
        // A path that exists grows a chunk at a time.
        follow.travel(None, 9.0);
        assert!(shaped(&follow).iter().all(|&frames| frames == 5 + super::CHUNK), "{:?}", shaped(&follow));
    }

    #[test]
    fn cold_late_dense_queries_do_not_publish_samples_or_shapes() {
        let mut tree = styk_doc::json::parse(&std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/eval/follow-figures.json")).unwrap()).unwrap();
        let figures = tree.make_obj().unwrap().get_mut("figure_types").unwrap().make_arr().unwrap();
        for figure in figures {
            let object = figure.make_obj().unwrap();
            let segments = object.get_mut("segments").unwrap().make_arr().unwrap();
            let template = segments[0].clone();
            for index in 0..200 {
                let mut segment = template.clone();
                let segment = segment.make_obj().unwrap();
                segment.set("segment_id", styk_doc::Value::Num(1000.0 + index as f64));
                segment.set("parent_id", styk_doc::Value::Num(0.0));
                segments.push(styk_doc::Value::object(segment.clone()));
            }
        }
        let mut doc = crate::from_value(&tree, "readiness").unwrap();
        for clip in doc.camera_motion.iter_mut().filter(|clip| clip.kind == "follow") { clip.duration = 100_000.0; }
        let follow = super::Follow::new(&doc).unwrap();
        for _ in 0..100 { assert!(follow.travel_ready(None, 90_000.0).is_none()); }
        for clip in &follow.clips {
            let path = clip.path.get();
            assert!(path.frames.is_empty() && path.samples.is_empty(), "cold reads shaped or sampled a target");
        }
        let expected = follow.travel(None, 3.0);
        let lengths: Vec<_> = follow.clips.iter().map(|clip| { let path = clip.path.get(); (path.frames.len(), path.samples.len()) }).collect();
        assert_eq!(follow.travel_ready(None, 3.0), Some(expected));
        assert_eq!(follow.travel_ready(None, 3.25), Some(follow.travel(None, 3.25)));
        assert!(follow.travel_ready(None, 90_000.0).is_none());
        assert_eq!(lengths, follow.clips.iter().map(|clip| { let path = clip.path.get(); (path.frames.len(), path.samples.len()) }).collect::<Vec<_>>());
        assert_eq!(follow.travel_ready(None, -1.0), Some(None), "inactive clips must not need shaping");
    }
}
