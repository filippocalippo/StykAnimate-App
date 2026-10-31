//! Motion-path trails (docs/MOTION-PATHS.md): where a figure's joint, or the camera, is at each tick of the animation, and
//! the pose of the figure at one of those ticks.
//!
//! A trail is sampled from the session's document (while a motion-path edit has moved, from the document as the edit
//! shows it) and kept per target. The ticks sampled are planned from the animation's length, the playhead and the target's
//! keys, bounded however long the animation is; a read samples some of what is missing (until the time it is given has
//! passed, the interface thread does not wait, D7) and answers what it has, with `complete` saying whether more is to
//! come. A trail whose document changed keeps its points, nearest the playhead first replaced, so that an edit morphs it
//! instead of clearing it. The ticks an open edit changes are sampled first, and again from the document when it ends.
//!
//! Every target that needs the same tick is read from one evaluation of it, and only the figures joined together with
//! the target are built.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;

use styk_doc::Value;
use styk_eval::eval::Prepared;
use styk_eval::records::Records;

use crate::motion_path::MotionLive;
use crate::record::num;
use crate::timeline::{rows, total_ticks};
use crate::{EditError, Editor};

/// Trails kept at most; the least recently read are dropped beyond this.
const MAX_TRAILS: usize = 64;
/// Targets read at once at most.
const MAX_TARGETS: usize = 64;
/// Points a trail holds at most, whatever the caller asks.
const MAX_POINTS: usize = 4096;

/// What a trail follows: the camera, or a joint of a figure (`handle` 0 is its origin).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Target {
    Camera,
    Node { uid: u32, handle: u32 },
}

impl Target {
    fn parse(value: &Value) -> Result<Target, EditError> {
        let invalid = || EditError::Invalid("a motion-path target is a figure's joint or the camera".into());
        match value.get("kind").and_then(Value::as_str) {
            Some("camera") => Ok(Target::Camera),
            Some("node") => Ok(Target::Node { uid: num(value, "uid").ok_or_else(invalid)? as u32, handle: num(value, "handleId").ok_or_else(invalid)? as u32 }),
            _ => Err(invalid()),
        }
    }

    /// `motionPathTargetKey`.
    fn key(&self) -> String {
        match self {
            Target::Camera => "camera".into(),
            Target::Node { uid, handle } => format!("{uid}:{handle}"),
        }
    }
}

/// One planned tick of a trail.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Sampled {
    /// Not sampled yet.
    Waiting,
    /// The target is not in the frame at this tick.
    Missing,
    /// Where the target is, and where the body it belongs to is (the origin of the topmost figure it is joined to) unless
    /// the target is that origin.
    At { x: f64, y: f64, body: Option<[f64; 2]> },
}

struct Trail {
    key: String,
    target: Target,
    /// The document it was planned for (a shared node: any change to it is another one).
    base: Value,
    total: f64,
    range: f64,
    max_points: usize,
    /// The playhead it was planned around (a ranged trail follows it).
    center: f64,
    /// The planned ticks, ascending, and what each has so far.
    ticks: Vec<f64>,
    points: Vec<Sampled>,
    /// The ticks that wait for a sample, the next first (ticks that have since been sampled are skipped).
    pending: Vec<bool>,
    waiting: usize,
    queue: VecDeque<usize>,
    /// The target's own keys, ascending (`keyTicksForTarget`).
    keys: Vec<f64>,
    /// The ticks an open edit changed when the trail was last sampled for it.
    live: Option<[f64; 2]>,
    /// The edit state the trail was last sampled for.
    stamp: Option<(u64, u64)>,
    /// Unique among all trails and all their changes: a reader that holds a version holds exactly this.
    version: u64,
}

impl Trail {
    fn index_of(&self, tick: f64) -> Option<usize> {
        self.ticks.binary_search_by(|planned| planned.total_cmp(&tick)).ok()
    }

    fn is_key(&self, tick: f64) -> bool {
        self.keys.binary_search_by(|key| key.total_cmp(&tick)).is_ok()
    }

    /// Marks the ticks in `[low, high)` as waiting, nearest `center` first and before the others.
    fn resample(&mut self, range: [f64; 2], center: f64) {
        let mut urgent: Vec<usize> = (0..self.ticks.len()).filter(|&i| self.ticks[i] >= range[0] && self.ticks[i] < range[1]).collect();
        urgent.sort_by(|&a, &b| (self.ticks[a] - center).abs().total_cmp(&(self.ticks[b] - center).abs()));
        for &i in urgent.iter().rev() {
            if !self.pending[i] {
                self.pending[i] = true;
                self.waiting += 1;
            }
            self.queue.push_front(i);
        }
    }

    /// The next tick that waits.
    fn next(&mut self) -> Option<usize> {
        while let Some(&i) = self.queue.front() {
            if self.pending[i] {
                return Some(i);
            }
            self.queue.pop_front();
        }
        None
    }
}

/// What the trails keep between reads.
#[derive(Default)]
pub(crate) struct Cache {
    trails: Vec<Trail>,
    /// Typed views of the frames sampled (kept apart from the frame on show's).
    frames: crate::frame::Cache,
    version: u64,
    cursor: usize,
    /// The open motion-path edit as it was last read.
    live: Option<Arc<MotionLive>>,
    /// The last pose asked for at a trail point, and its answer.
    ghost: Option<(Value, Option<(u64, u64)>, String, u64, String)>,
}

/// The ticks a trail samples (`motionPathTicks`): the ends of the animation or of the window `range` ticks either side of the
/// playhead (all of it when 0), the playhead, an evenly spread share of the target's keys and an even stride through the rest,
/// at most `max_points` of them.
pub(crate) fn plan_ticks(total: f64, tick: f64, range: f64, max_points: usize, keys: &[f64]) -> Vec<f64> {
    if total <= 0.0 {
        return Vec::new();
    }
    let center = tick.clamp(0.0, total - 1.0);
    let low = if range > 0.0 { (center - range).max(0.0) } else { 0.0 };
    let high = if range > 0.0 { (center + range).min(total - 1.0) } else { total - 1.0 };
    let count = (high - low + 1.0).max(0.0);
    let budget = max_points.max(3) as f64;
    let mut included: Vec<f64> = vec![low];
    let mut seen: HashSet<u64> = HashSet::from([low.to_bits()]);
    let mut add = |t: f64, included: &mut Vec<f64>| {
        if seen.insert(t.to_bits()) {
            included.push(t);
        }
    };
    add(high, &mut included);
    if tick >= low && tick <= high {
        add(tick, &mut included);
    }
    let between: Vec<f64> = keys.iter().copied().filter(|&t| t > low && t < high).collect();
    let key_budget = ((budget - included.len() as f64) / 2.0).floor().min(between.len() as f64);
    if key_budget > 0.0 {
        for i in 0..key_budget as usize {
            add(between[(i as f64 * between.len() as f64 / key_budget).floor() as usize], &mut included);
        }
    }
    let stride = if count <= budget { 1.0 } else { ((count / (budget - included.len() as f64).max(1.0)).ceil()).max(1.0) };
    let mut t = low;
    while t <= high && (included.len() as f64) < budget {
        add(t, &mut included);
        t += stride;
    }
    included.sort_by(f64::total_cmp);
    included
}

/// The document a read samples: the one on show, or an open motion-path edit's.
struct Source<'a> {
    report: &'a Value,
    prepared: &'a Arc<Prepared>,
    draft: Option<&'a [Value]>,
}

impl Source<'_> {
    fn records(&self) -> Result<Records<'_>, EditError> {
        match self.draft {
            Some(draft) => Records::new_native_draft(self.report, self.prepared, draft),
            None => Records::new(self.report, self.prepared),
        }
        .map_err(EditError::from)
    }
}

/// The topmost figure of the chain `slot` is joined to (`componentRoot`): the body a relative trail stays with.
fn component_root(frame: &styk_eval::eval::Frame, slot: usize) -> usize {
    let mut root = slot;
    let mut seen = vec![slot];
    while let Some(join) = frame.objects[root].join {
        let next = join.slot as usize;
        if seen.contains(&next) || next >= frame.objects.len() {
            break;
        }
        seen.push(next);
        root = next;
    }
    root
}

/// The slots of the figures joined together with any of `wanted`.
fn components(frame: &styk_eval::eval::Frame, wanted: &[usize]) -> Vec<usize> {
    let joins: Vec<Option<usize>> = frame.objects.iter().map(|object| object.join.map(|join| join.slot as usize)).collect();
    let mut slots: Vec<usize> = styk_eval::ik::joined::components_of(&joins).into_iter().filter(|group| group.iter().any(|slot| wanted.contains(slot))).flatten().collect();
    slots.sort_unstable();
    slots
}

impl Editor {
    /// The keyed ticks of a target (`keyTicksForTarget`, else `keyTicksFor`): the keys of its track on a layer sheet, of its
    /// channels, or the stored poses of a native timeline. Ascending.
    fn target_key_ticks(&self, target: &Target, timeline: &[crate::timeline::Row]) -> Vec<f64> {
        let report = &self.report;
        let mut ticks: Vec<f64> = Vec::new();
        let mut add = |tick: f64| {
            if !ticks.contains(&tick) {
                ticks.push(tick);
            }
        };
        let layer = match target {
            Target::Camera => "camera".to_string(),
            Target::Node { uid, .. } => self.layer_of(*uid),
        };
        if let Some(sheet) = report.path(&["_styk", "layerSheet"]) {
            let duration = num(sheet, "duration").unwrap_or(f64::NAN);
            for key in sheet.path(&["tracks", &layer, "keys"]).and_then(Value::elements).into_iter().flat_map(|keys| keys.iter()) {
                if let Some(tick) = num(&key, "tick")
                    && !key.get("patchOnly").is_some_and(Value::truthy)
                    && tick < duration
                {
                    add(tick);
                }
            }
        } else if let Some(channels) = report.path(&["_styk", "animation", "channels"]).and_then(Value::elements).filter(|channels| channels.len() > 0) {
            let kind = |channel: &Value| channel.path(&["target", "kind"]).and_then(Value::as_str).map(str::to_string);
            let figure = |channel: &Value, uid: u32| kind(channel).as_deref() == Some("figure") && channel.path(&["target", "uid"]).and_then(Value::as_f64) == Some(uid as f64);
            let independent = match target {
                Target::Node { uid, .. } => channels.iter().any(|channel| figure(&channel, *uid) && channel.get("property").and_then(Value::as_str) == Some("pose")),
                Target::Camera => false,
            };
            for channel in channels.iter() {
                let owns = match target {
                    Target::Camera => kind(&channel).as_deref() == Some("camera"),
                    Target::Node { uid, .. } => {
                        figure(&channel, *uid)
                            || (kind(&channel).as_deref() == Some("layer")
                                && channel.path(&["target", "id"]).and_then(Value::as_str) == Some(layer.as_str())
                                && !independent
                                && channel.get("property").and_then(Value::as_str) == Some("pose"))
                    }
                };
                if !owns {
                    continue;
                }
                for key in channel.get("keys").and_then(Value::elements).into_iter().flat_map(|keys| keys.iter()) {
                    if let Some(tick) = num(&key, "tick")
                        && !key.get("hidden").is_some_and(Value::truthy)
                    {
                        add(tick);
                    }
                }
            }
        } else {
            for row in timeline.iter().filter(|row| row.count > 0.0) {
                add(row.start);
            }
        }
        ticks.sort_by(f64::total_cmp);
        ticks
    }

    /// The open motion-path edit that has moved, as every reader of it sees it: made once for each pointer move.
    pub(crate) fn shared_motion_live(&self) -> Result<Option<Arc<MotionLive>>, EditError> {
        let mut cache = self.trails.borrow_mut();
        self.live_views(&mut cache)
    }

    /// [`Editor::shared_motion_live`] for a reader that holds the trails' cache (made again when another pointer move changed it).
    fn live_views(&self, cache: &mut Cache) -> Result<Option<Arc<MotionLive>>, EditError> {
        match self.motion_stamp() {
            None => {
                cache.live = None;
                Ok(None)
            }
            Some(stamp) => {
                if cache.live.as_ref().is_none_or(|live| live.stamp != stamp) {
                    cache.live = self.motion_live()?.map(Arc::new);
                }
                Ok(cache.live.clone())
            }
        }
    }

    /// `{targets, range, maxPoints, budgetMs, held}`: the trails of the targets as far as they are sampled,
    /// `{entries: [{key, version, complete, ticks, points}, …]}`. `held` names the version of each trail the reader
    /// already has: of those only `key`, `version` and `complete` come back. `points` is a flat list of
    /// `tick, x, y, flags, bodyX, bodyY` per sampled tick; the flags are 1 for a keyed tick, 2 for a tick the target is
    /// missing at and 4 when the body's position is given.
    pub(crate) fn interface_trails(&self, args: &Value) -> Result<String, EditError> {
        let prepared = self.prepared()?;
        let mut targets: Vec<Target> = Vec::new();
        for target in args.get("targets").and_then(Value::elements).into_iter().flat_map(|targets| targets.iter()).take(MAX_TARGETS) {
            let target = Target::parse(&target)?;
            if !targets.contains(&target) {
                targets.push(target);
            }
        }
        let range = num(args, "range").filter(|range| range.is_finite()).unwrap_or(0.0);
        let max_points = (num(args, "maxPoints").filter(|points| points.is_finite()).unwrap_or(1600.0).floor().max(3.0) as usize).min(MAX_POINTS);
        let budget = num(args, "budgetMs").filter(|ms| !ms.is_nan());
        let held: HashMap<String, u64> = args
            .get("held")
            .and_then(Value::as_obj)
            .map(|held| held.iter().filter_map(|(key, version)| Some((key.to_string(), version.as_f64()? as u64))).collect())
            .unwrap_or_default();
        let timeline = rows(&self.report);
        let total = total_ticks(&timeline);
        let canvas = [prepared.doc.canvas[0] as f64, prepared.doc.canvas[1] as f64];

        let mut guard = self.trails.borrow_mut();
        let cache = &mut *guard;
        let live = self.live_views(cache)?;

        // Plan: a trail whose document, window or playhead changed is planned again, keeping the points still planned.
        for target in &targets {
            let key = target.key();
            let at = cache.trails.iter().position(|trail| trail.key == key);
            let stale = at.is_none_or(|at| {
                let trail = &cache.trails[at];
                !trail.base.same_node(&self.report)
                    || trail.total != total
                    || trail.range != range
                    || trail.max_points != max_points
                    || (range > 0.0 && trail.center != self.tick)
                    || (self.tick < total && trail.index_of(self.tick).is_none())
            });
            if !stale {
                let trail = cache.trails.remove(at.expect("a fresh trail exists"));
                cache.trails.push(trail);
                continue;
            }
            let old = at.map(|at| cache.trails.remove(at));
            let keys = self.target_key_ticks(target, &timeline);
            let ticks = plan_ticks(total, self.tick, range, max_points, &keys);
            let same_document = old.as_ref().is_some_and(|old| old.total == total);
            // Only the window or the playhead moved: what was sampled stays good.
            let reusable = same_document && old.as_ref().is_some_and(|old| old.base.same_node(&self.report) && old.live.is_none());
            let points: Vec<Sampled> = ticks
                .iter()
                .map(|&tick| match old.as_ref().filter(|_| same_document).and_then(|old| old.index_of(tick).map(|at| old.points[at])) {
                    Some(point) => point,
                    None => Sampled::Waiting,
                })
                .collect();
            let pending: Vec<bool> = points.iter().map(|point| !reusable || *point == Sampled::Waiting).collect();
            let mut order: Vec<usize> = (0..ticks.len()).filter(|&i| pending[i]).collect();
            // The playhead's surroundings matter most.
            order.sort_by(|&a, &b| (ticks[a] - self.tick).abs().total_cmp(&(ticks[b] - self.tick).abs()));
            cache.version += 1;
            cache.trails.push(Trail {
                key,
                target: *target,
                base: self.report.clone(),
                total,
                range,
                max_points,
                center: self.tick,
                waiting: order.len(),
                queue: order.into(),
                ticks,
                points,
                pending,
                keys,
                live: old.as_ref().and_then(|old| old.live),
                stamp: old.as_ref().and_then(|old| old.stamp),
                version: cache.version,
            });
        }
        while cache.trails.len() > MAX_TRAILS {
            cache.trails.remove(0);
        }
        let active: Vec<usize> = targets.iter().filter_map(|target| cache.trails.iter().position(|trail| trail.key == target.key())).collect();

        // An open edit changes the ticks in its range: they are sampled first; when it ends they are read from the document again.
        for &at in &active {
            let version = cache.version + 1;
            let trail = &mut cache.trails[at];
            let change = match &live {
                Some(live) if trail.stamp != Some(live.stamp) => Some((live.range, live.tick, Some(live.stamp))),
                None => trail.live.map(|range| (range, self.tick, None)),
                _ => None,
            };
            if let Some((range, center, stamp)) = change {
                trail.resample(range, center);
                trail.live = stamp.and(live.as_ref().map(|live| live.range));
                trail.stamp = stamp;
                trail.version = version;
                cache.version = version;
            }
        }

        // Sample until the time is up, a tick for every trail that needs it at once.
        let base = Source { report: &self.report, prepared: &prepared, draft: None };
        let source = match &live {
            Some(live) => Source { report: &live.report, prepared: &live.prepared, draft: live.draft.as_deref() },
            None => base,
        };
        let deadline = budget.zip(self.clock).map(|(ms, clock)| clock() + ms);
        let mut sampled = false;
        let records = if active.iter().any(|&at| cache.trails[at].waiting > 0) { Some(source.records()?) } else { None };
        loop {
            let mut lead = None;
            for n in 0..active.len() {
                let turn = (cache.cursor + n) % active.len();
                if cache.trails[active[turn]].waiting > 0 {
                    lead = Some(active[turn]);
                    cache.cursor = (turn + 1) % active.len();
                    break;
                }
            }
            let Some(lead) = lead else { break };
            if sampled && deadline.zip(self.clock).is_some_and(|(deadline, clock)| clock() > deadline) {
                break;
            }
            sampled = true;
            let at = cache.trails[lead].next().expect("a trail that waits has a tick");
            let tick = cache.trails[lead].ticks[at];
            let needers: Vec<(usize, usize)> = active.iter().filter_map(|&trail| Some((trail, cache.trails[trail].index_of(tick).filter(|&i| cache.trails[trail].pending[i])?))).collect();
            let wanted: Vec<Target> = needers.iter().map(|&(trail, _)| cache.trails[trail].target).collect();
            let found = sample_tick(&mut cache.frames, records.as_ref().expect("something waits"), source.prepared, canvas, tick, &wanted)?;
            for (&(trail, i), point) in needers.iter().zip(found) {
                cache.version += 1;
                let trail = &mut cache.trails[trail];
                trail.points[i] = point;
                trail.pending[i] = false;
                trail.waiting -= 1;
                trail.version = cache.version;
            }
        }

        let mut out: Vec<u8> = Vec::with_capacity(64);
        out.extend_from_slice(b"{\"entries\":[");
        for (n, &at) in active.iter().enumerate() {
            if n > 0 {
                out.push(b',');
            }
            write_trail(&mut out, &cache.trails[at], held.get(&cache.trails[at].key).copied());
        }
        out.extend_from_slice(b"]}");
        String::from_utf8(out).map_err(|error| EditError::Invalid(error.to_string()))
    }

    /// `{target, tick}`: the pose of the figures joined with the target at `tick` as it would be with the document as it stands
    /// (an open motion-path edit's included), `{rx, ry, lines, circles}` (the body's origin, the segments drawn as polylines
    /// `[x0, y0, x1, y1, …]` and as circles `[x, y, radius]`) or `null` when there is none.
    pub(crate) fn interface_trail_ghost(&self, args: &Value) -> Result<String, EditError> {
        let Target::Node { uid, handle: _ } = Target::parse(args.get("target").ok_or_else(|| EditError::Invalid("a ghost needs its target".into()))?)? else { return Ok("null".into()) };
        let tick = num(args, "tick").ok_or_else(|| EditError::Invalid("a ghost needs its tick".into()))?;
        let key = args.get("target").map(|target| styk_doc::json::to_string(target)).unwrap_or_default();
        let mut guard = self.trails.borrow_mut();
        let cache = &mut *guard;
        let live = self.live_views(cache)?;
        let stamp = live.as_ref().map(|live| live.stamp);
        if let Some((report, held, target, at, answer)) = &cache.ghost
            && report.same_node(&self.report)
            && *held == stamp
            && *target == key
            && *at == tick.to_bits()
        {
            return Ok(answer.clone());
        }
        let prepared = self.prepared()?;
        let source = match &live {
            Some(live) => Source { report: &live.report, prepared: &live.prepared, draft: live.draft.as_deref() },
            None => Source { report: &self.report, prepared: &prepared, draft: None },
        };
        let record = source.records()?.evaluated_with(tick, true)?;
        let frame = cache.frames.edit_frame(&record, source.prepared).map_err(|error| EditError::Invalid(error.to_string()))?;
        let answer = match frame.objects.iter().rposition(|object| object.uid == uid) {
            None => "null".to_string(),
            Some(slot) => {
                let slots = components(&frame, &[slot]);
                let scene = styk_eval::geometry::build_shapes(&source.prepared.doc, &frame, Some(&slots));
                ghost_json(&scene, &slots, component_root(&frame, slot))
            }
        };
        cache.ghost = Some((self.report.clone(), stamp, key, tick.to_bits(), answer.clone()));
        Ok(answer)
    }
}

/// Where each of `targets` is at `tick`, from one evaluation of the frame.
fn sample_tick(frames: &mut crate::frame::Cache, records: &Records<'_>, prepared: &Arc<Prepared>, canvas: [f64; 2], tick: f64, targets: &[Target]) -> Result<Vec<Sampled>, EditError> {
    let record = records.evaluated_with(tick, true)?;
    let wanted: Vec<u32> = targets.iter().filter_map(|target| match target { Target::Node { uid, .. } => Some(*uid), Target::Camera => None }).collect();
    if wanted.is_empty() {
        return Ok(targets.iter().map(|_| camera_point(&record, canvas)).collect());
    }
    let frame = frames.edit_frame(&record, prepared).map_err(|error| EditError::Invalid(error.to_string()))?;
    let slot_of = |uid: u32| frame.objects.iter().rposition(|object| object.uid == uid);
    let slots: Vec<usize> = wanted.iter().filter_map(|&uid| slot_of(uid)).collect();
    let built = components(&frame, &slots);
    let scene = styk_eval::geometry::build_only(&prepared.doc, &frame, &built);
    Ok(targets
        .iter()
        .map(|target| {
            let Target::Node { uid, handle } = *target else { return camera_point(&record, canvas) };
            let Some(slot) = slot_of(uid) else { return Sampled::Missing };
            let Some(point) = scene.objects.get(slot).filter(|object| object.resolved).zip(scene.figure_for(slot)).and_then(|(object, figure)| object.joint(figure, handle)) else { return Sampled::Missing };
            let root = component_root(&frame, slot);
            if root == slot && handle == 0 {
                return Sampled::At { x: point[0], y: point[1], body: None };
            }
            let body = scene.objects.get(root).filter(|object| object.resolved).map(|object| object.root);
            Sampled::At { x: point[0], y: point[1], body }
        })
        .collect())
}

/// The camera trail: the centre of the canvas moved by the camera's position.
fn camera_point(record: &Value, canvas: [f64; 2]) -> Sampled {
    let camera = record.get("camera");
    let at = |key: &str| camera.and_then(|camera| num(camera, key)).unwrap_or(0.0);
    Sampled::At { x: canvas[0] / 2.0 + at("x"), y: canvas[1] / 2.0 + at("y"), body: None }
}

fn write_number(out: &mut Vec<u8>, value: f64) {
    styk_doc::format_number(value, out);
}

/// A trail as the reader takes it (see [`Editor::interface_trails`]); without its ticks and points when it holds `held`.
fn write_trail(out: &mut Vec<u8>, trail: &Trail, held: Option<u64>) {
    out.extend_from_slice(format!("{{\"key\":\"{}\",\"version\":{},\"complete\":{}", trail.key, trail.version, trail.waiting == 0).as_bytes());
    if held != Some(trail.version) {
        out.extend_from_slice(b",\"ticks\":[");
        for (i, &tick) in trail.ticks.iter().enumerate() {
            if i > 0 {
                out.push(b',');
            }
            write_number(out, tick);
        }
        out.extend_from_slice(b"],\"points\":[");
        let mut first = true;
        for (&tick, point) in trail.ticks.iter().zip(&trail.points) {
            let (x, y, flags, body) = match *point {
                Sampled::Waiting => continue,
                Sampled::Missing => (0.0, 0.0, 2, None),
                Sampled::At { x, y, body } => (x, y, 0, body),
            };
            if !first {
                out.push(b',');
            }
            first = false;
            let flags = flags | u8::from(trail.is_key(tick)) | if body.is_some() { 4 } else { 0 };
            let [bx, by] = body.unwrap_or([0.0, 0.0]);
            for (n, value) in [tick, x, y, flags as f64, bx, by].into_iter().enumerate() {
                if n > 0 {
                    out.push(b',');
                }
                write_number(out, value);
            }
        }
        out.push(b']');
    }
    out.push(b'}');
}

/// The segments of the figures `slots` of `scene` that a ghost draws, as the reader takes them (see [`Editor::interface_trail_ghost`]).
fn ghost_json(scene: &styk_eval::geometry::Scene, slots: &[usize], root: usize) -> String {
    use styk_eval::geometry::ItemKind;
    let mut lines: Vec<Vec<f64>> = Vec::new();
    let mut circles: Vec<[f64; 3]> = Vec::new();
    for item in &scene.measured {
        if !slots.contains(&(item.slot as usize)) || matches!(item.kind, ItemKind::Poly | ItemKind::Mesh | ItemKind::Image | ItemKind::Text) {
            continue;
        }
        if !scene.figure_for(item.slot as usize).and_then(|figure| figure.segments.get(item.index as usize)).is_some_and(|segment| segment.visible) {
            continue;
        }
        if matches!(item.kind, ItemKind::Circle | ItemKind::CircleFill | ItemKind::CircleClear) {
            let (dx, dy) = (item.end[0] - item.start[0], item.end[1] - item.start[1]);
            circles.push([(item.start[0] + item.end[0]) / 2.0, (item.start[1] + item.end[1]) / 2.0, styk_math::hypot(dx, dy) / 2.0]);
            continue;
        }
        let points = scene.points_of(item);
        let line: Vec<[f64; 2]> = if points.len() >= 2 { points.to_vec() } else { vec![item.start, item.end] };
        lines.push(line.into_iter().flatten().collect());
    }
    if lines.is_empty() && circles.is_empty() {
        return "null".into();
    }
    let reference = scene.objects.get(root).filter(|object| object.resolved).map(|object| object.root);
    let mut out: Vec<u8> = Vec::with_capacity(64 + lines.iter().map(|line| line.len() * 9 + 2).sum::<usize>());
    out.extend_from_slice(b"{\"rx\":");
    write_number(&mut out, reference.map_or(f64::NAN, |at| at[0]));
    out.extend_from_slice(b",\"ry\":");
    write_number(&mut out, reference.map_or(f64::NAN, |at| at[1]));
    out.extend_from_slice(b",\"lines\":[");
    for (i, line) in lines.iter().enumerate() {
        if i > 0 {
            out.push(b',');
        }
        out.push(b'[');
        for (n, &value) in line.iter().enumerate() {
            if n > 0 {
                out.push(b',');
            }
            write_number(&mut out, value);
        }
        out.push(b']');
    }
    out.extend_from_slice(b"],\"circles\":[");
    for (i, circle) in circles.iter().enumerate() {
        if i > 0 {
            out.push(b',');
        }
        out.push(b'[');
        for (n, &value) in circle.iter().enumerate() {
            if n > 0 {
                out.push(b',');
            }
            write_number(&mut out, value);
        }
        out.push(b']');
    }
    out.extend_from_slice(b"]}");
    String::from_utf8(out).unwrap_or_else(|_| "null".into())
}
