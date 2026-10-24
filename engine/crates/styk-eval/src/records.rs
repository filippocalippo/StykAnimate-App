//! The evaluated frame as the editor's records.
//!
//! A gesture commits by storing the frame the editor shows: `snapshotPoseFrame(
//! editor.evaluatedFrame)` becomes a pose source in the document. To run that commit
//! in the engine, the engine must produce the same record, byte for byte: the same
//! keys in the same order and every number with the same bits.
//!
//! This module mirrors the record-level shape of the editor's evaluation
//! (`sampleLayerSheet` in src/layer-sheet.mjs, `evaluatedNativeFrame` and
//! `evaluatedFrame` in src/pivot/geometry.mjs, `snapshotPoseFrame` in
//! src/pose-snapshot.mjs): which record a pose comes from, which keys a tween writes
//! and in which order. Every interpolated number comes from the typed evaluator
//! ([`crate::eval`]), so there is one implementation of the arithmetic.
//!
//! What it does not cover yet answers [`Error::Unported`] with the reason.
//! `engine/tools/records-reference.mjs` records the editor's output and
//! `styk records` compares.

mod channels;

use std::collections::HashMap;
use std::sync::Arc;

use styk_doc::{Obj, Value};

use crate::eval::{Prepared, Row, Seq, evaluate_native_exact_only, timeline_rows};

pub use channels::{Bound, RecordChannels, resolved_stack};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The engine does not produce this frame as records yet.
    #[error("not ported: {0}")]
    Unported(String),
    #[error("{0}")]
    Invalid(String),
}

fn unported<T>(what: &str) -> Result<T, Error> {
    Err(Error::Unported(what.to_string()))
}

/// A sampled frame and what it is, for the identity tests of `sampleLayerSheet`
/// (JavaScript compares frames with `===`).
#[derive(Clone)]
struct Sample {
    frame: Value,
    identity: Identity,
}

/// What one layer takes from a sampled frame: its figures (each with the unique id
/// it joins, if any) in drawing order, and its movieclip continuations.
#[derive(Default)]
struct Group {
    records: Vec<(Value, Option<f64>)>,
    steps: Vec<Value>,
}

#[derive(Clone, PartialEq)]
enum Identity {
    /// `sourceAt(time)`: the imported timeline at a JavaScript Map time key.
    Native(u64),
    /// A retained pose source, by id.
    Source(Arc<str>),
    /// A frame of a layer's own pose track: never the same object as another track's.
    Track(String),
}

// JavaScript Map's SameValueZero: signed zero shares a key, as do all NaNs.
// The original first time is still passed unchanged to native evaluation.
fn source_time_key(time: f64) -> u64 {
    if time == 0.0 { 0 } else if time.is_nan() { f64::NAN.to_bits() } else { time.to_bits() }
}

fn source_at(samples: &std::cell::RefCell<HashMap<u64, Value>>, time: f64,
    read: impl FnOnce(f64) -> Result<Value, Error>) -> Result<Value, Error>
{
    let key = source_time_key(time);
    if let Some(frame) = samples.borrow().get(&key) {
        return Ok(frame.clone());
    }
    // No lookup borrow survives evaluation. Failed samples are not retained.
    let frame = read(time)?;
    samples.borrow_mut().insert(key, frame.clone());
    Ok(frame)
}

#[cfg(test)]
thread_local! {
    static NATIVE_SAMPLE_TIMES: std::cell::RefCell<Option<Vec<u64>>> = const { std::cell::RefCell::new(None) };
}

fn num(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

fn items(value: Option<&Value>) -> Vec<Value> {
    value.and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default()
}

fn truthy(value: Option<&Value>) -> bool {
    value.is_some_and(Value::truthy)
}

fn uid(object: &Value) -> Option<f64> {
    num(object, "unique_id")
}

fn numbers(values: impl IntoIterator<Item = f64>) -> Value {
    Value::array(values.into_iter().map(Value::Num).collect())
}

/// Evaluates frames of one document as records.
pub struct Records<'a> {
    tree: &'a Value,
    prepared: &'a Prepared,
    /// `timeline(legacySheetReport(report))`: the native rows without the sheet's cut.
    rows: Vec<Row>,
    /// The property channels the native timeline is sampled with (`sampleLegacy`): a
    /// layer sheet's `legacyAnimation`, else `_styk.animation`.
    legacy: Vec<Bound>,
    /// Raw retained source, sharing the parent definitions when requested.
    source_tree: Option<Value>,
}

impl<'a> Records<'a> {
    /// `tree` is the document `prepared` was built from.
    pub fn new(tree: &'a Value, prepared: &'a Prepared) -> Result<Records<'a>, Error> {
        let styk = tree.get("_styk");
        let legacy_channels = match styk.and_then(|s| s.get("layerSheet")) {
            Some(sheet) => sheet.path(&["legacyAnimation", "channels"]),
            None => styk.and_then(|s| s.path(&["animation", "channels"])),
        };
        let legacy = channels::bind_compiled(prepared, &items(legacy_channels))?;
        Self::from_bound(tree, prepared, legacy)
    }

    /// A validated live native editor draft on its owning worker. `tree` and
    /// `prepared` are the same COW projection including its transient sources.
    /// The caller must own the draft's validated canonical keys and validate
    /// each new write before this read. Only finalized key ordering is deferred:
    /// pose tracks sort their own copy; scalar sampling retains insertion order
    /// until commit, using the same typed channel sampler. This does not admit
    /// unordered persisted documents or provide an interface-thread query.
    pub fn new_native_draft(tree: &'a Value, prepared: &'a Prepared, draft: &[Value]) -> Result<Records<'a>, Error> {
        if tree.path(&["_styk", "layerSheet"]).is_some() {
            return unported("a native channel draft on a layer sheet");
        }
        Self::from_bound(tree, prepared, channels::bind_draft(prepared, draft)?)
    }

    fn from_bound(tree: &'a Value, prepared: &'a Prepared, legacy: Vec<Bound>) -> Result<Records<'a>, Error> {
        let styk = tree.get("_styk");
        let clips = |path: &[&str]| items(styk.and_then(|s| s.path(path)));
        let doc = &prepared.doc;
        let mut rows = timeline_rows(doc.version, doc.keyframes.iter().map(|k| k.duration));
        // The last row lasts as long as the channels (`animationEndTick`), the camera and
        // effect clips do.
        let ends = clips(&["cameraMotion", "clips"])
            .iter()
            .map(|c| num(c, "start").unwrap_or(0.0) + num(c, "duration").unwrap_or(0.0))
            .chain(clips(&["vfxClips", "clips"]).iter().map(|c| match c.get("duration") {
                Some(Value::Null) => 0.0,
                _ => num(c, "start").unwrap_or(0.0) + num(c, "duration").unwrap_or(0.0),
            }))
            .fold(channels::end_tick(&legacy), f64::max);
        if let Some(last) = rows.last_mut() {
            last.count = last.count.max((ends - last.start as f64).max(0.0) as u32);
        }
        let source_tree = styk
            .and_then(|s| s.get("movieclipSource"))
            .and_then(|source| {
                let mut document = source.get("document")?.as_obj()?.clone();
                if source.get("inheritFigures").is_some_and(Value::truthy) {
                    document.set(
                        "figure_types",
                        tree.get("figure_types").cloned().unwrap_or(Value::Null),
                    );
                }
                Some(Value::object(document))
            });
        Ok(Records { tree, prepared, rows, legacy,
            source_tree,
        })
    }

    /// A pose record read through the same typed loader as evaluation. Origin arithmetic
    /// stays in `crate::origin`; the record writer only preserves the editor's key layout.
    fn typed_object(&self, object: &Value) -> Option<Arc<crate::doc::Object>> {
        let mut frame = Obj::new();
        frame.set("objects", Value::array(vec![object.clone()]));
        crate::load::Loader::new().keyframe(&Value::object(frame)).ok()?.objects.into_iter().next()
    }

    /// `correctAnimationOrigins`: exact keys need this as well as interpolated frames.
    /// Unchanged records keep their identity and unknown fields; a changed root drops the
    /// runtime geometry just as the editor's correction does.
    fn correct_origins(&self, frame: Value) -> Result<Value, Error> {
        if !self.prepared.doc.origins {
            return Ok(frame);
        }
        let mut objects = items(frame.get("objects"));
        let mut changed = false;
        for object in &mut objects {
            // Most poses in a mixed scene need no origin work. Read only an unjoined pose
            // with a pivot, using the base definition: styles affect drawing, not the
            // animation basis (`correct_origins` in the typed evaluator does the same).
            if !truthy(object.get("_stykAnimationOrigin")) || truthy(object.get("join")) {
                continue;
            }
            let Some(figure) = num(object, "figure_type_id").and_then(|id| self.prepared.doc.figure(id as u32)).filter(|figure| figure.origin.is_some()) else { continue };
            let Some(typed) = self.typed_object(object) else { return Err(Error::Invalid("an animation origin's pose has no identity or figure".into())) };
            let Some(root) = crate::origin::corrected_root(figure, &typed) else { continue };
            let Some(record) = object.make_obj() else { continue };
            record.set("root_x", Value::Num(root[0]));
            record.set("root_y", Value::Num(root[1]));
            record.remove("runtime_segments");
            changed = true;
        }
        if !changed {
            return Ok(frame);
        }
        let mut corrected = frame.as_obj().cloned().unwrap_or_default();
        corrected.set("objects", Value::array(objects));
        Ok(Value::object(corrected))
    }

    /// `snapshotPoseFrame(editor.evaluatedFrame)` at `tick`.
    pub fn snapshot(&self, tick: f64) -> Result<Value, Error> {
        Ok(snapshot_pose_frame(&self.evaluated(tick)?))
    }

    /// What `engine/tools/records-reference.mjs` recorded for one tick (`{tick, channels?}`):
    /// the evaluated frame, or with `channels` the frame a property edit writes there
    /// (`_sheetPropertyEntries`: `at(report, tick)` with those one-key channels composed).
    pub fn recorded(&self, entry: &Value) -> Result<Value, Error> {
        let tick = num(entry, "tick").unwrap_or(0.0);
        match entry.get("channels").and_then(Value::elements) {
            Some(channels) => {
                let channels: Vec<Value> = channels.iter().collect();
                Ok(snapshot_pose_frame(&self.compose_channels(self.evaluated_with(tick, false)?, &channels, tick)?))
            }
            None => self.snapshot(tick),
        }
    }

    /// `evaluatedFrame(report, …, tick)` without the runtime clock fields.
    pub fn evaluated(&self, tick: f64) -> Result<Value, Error> {
        self.evaluated_with(tick, true)
    }

    /// `evaluatedFrame(report, …, tick, {skipMovieclips: !clips})`: with `clips` off,
    /// movieclips outside their span stay in the frame (what a key's pose is captured from).
    pub fn evaluated_with(&self, tick: f64, clips: bool) -> Result<Value, Error> {
        self.evaluated_options(tick, clips, false)
    }

    /// [`Records::evaluated_with`], and with `skip_patches` the keys' movieclip frame
    /// replacements left out (`at(report, tick, {skipMovieclipPatches: true})`): the pose a
    /// key with replacements is written from.
    pub fn evaluated_options(&self, tick: f64, clips: bool, skip_patches: bool) -> Result<Value, Error> {
        self.evaluated_mode(tick, clips, skip_patches, false)
    }

    /// The editor's authoritative shown pose holds a native one-tick row while
    /// channels retain the actual fractional clock. Raw `at`/motion sampling
    /// keeps its existing fractional-row rule through [`Records::evaluated_with`].
    pub fn evaluated_editor_with(&self, tick: f64, clips: bool) -> Result<Value, Error> {
        self.evaluated_mode(tick, clips, false, true)
    }

    fn evaluated_mode(&self, tick: f64, clips: bool, skip_patches: bool, editor: bool) -> Result<Value, Error> {
        let frame = match self.tree.path(&["_styk", "layerSheet"]) {
            Some(sheet) => self.sample_sheet(sheet, tick, skip_patches)?,
            None => self.native_at_with(tick, clips, editor)?,
        };
        let frame = if clips { self.sample_clips(frame, tick)? } else { frame };
        Ok(self.layer_order(frame))
    }

    /// `sampleMovieclipObjects(report, frame, tick)`: every movieclip instance gets its
    /// local time (`_movieclipSample`, a runtime field a snapshot drops), and instances
    /// outside their span leave the frame.
    fn sample_clips(&self, frame: Value, tick: f64) -> Result<Value, Error> {
        if !self.prepared.doc.figures.iter().any(|f| f.movieclip.is_some()) {
            return Ok(frame);
        }
        // The clocks are the typed evaluator's, by identity.
        let typed = self.prepared.raw(tick);
        let times: HashMap<u32, Option<f64>> = typed.objects.iter().filter_map(|o| Some((o.uid, self.prepared.clip_local(o, tick)?))).collect();
        if times.is_empty() {
            return Ok(frame);
        }
        let objects: Vec<Value> = items(frame.get("objects"))
            .into_iter()
            .map(|object| match uid(&object).and_then(|id| times.get(&(id as u32))) {
                Some(time) => {
                    let mut sampled = object.as_obj().cloned().unwrap_or_default();
                    sampled.set("_movieclipSample", time.map_or(Value::Null, Value::Num));
                    Value::object(sampled)
                }
                None => object,
            })
            .collect();
        let shown = |o: &Value| !matches!(o.get("_movieclipSample"), Some(Value::Null));
        let mut out = frame.as_obj().cloned().unwrap_or_default();
        if objects.iter().all(shown) {
            out.set("objects", Value::array(objects));
            return Ok(Value::object(out));
        }
        let mut slots: HashMap<usize, usize> = HashMap::new();
        for (slot, object) in objects.iter().enumerate() {
            if shown(object) {
                slots.insert(slot, slots.len());
            }
        }
        let mut visible = Vec::with_capacity(slots.len());
        for (slot, object) in objects.iter().enumerate() {
            let Some(&at) = slots.get(&slot) else { continue };
            let mut next = object.as_obj().cloned().unwrap_or_default();
            next.set("object_slot", Value::Num(at as f64));
            if let Some(join) = object.get("join").filter(|j| j.truthy()) {
                let target = num(join, "target_object_slot").map(|s| s as usize);
                let Some(&parent) = target.and_then(|t| slots.get(&t)) else { return unported("figures joined to a hidden movieclip") };
                let mut join = join.as_obj().cloned().unwrap_or_default();
                join.set("target_object_slot", Value::Num(parent as f64));
                next.set("join", Value::object(join));
            }
            visible.push(Value::object(next));
        }
        let order: Vec<usize> = match frame.get("object_draw_order").filter(|o| !o.is_null()) {
            Some(order) => order.numbers().unwrap_or_default().into_iter().map(|s| s as usize).collect(),
            None => (0..objects.len()).collect(),
        };
        let order: Vec<usize> = order.iter().filter_map(|slot| slots.get(slot).copied()).collect();
        let ids: Vec<Value> = order.iter().map(|&slot| visible[slot].get("unique_id").cloned().unwrap_or(Value::Null)).collect();
        let count = visible.len();
        out.set("objects", Value::array(visible));
        out.set("object_count", Value::Num(count as f64));
        out.set("object_draw_order", numbers(order.iter().map(|&s| s as f64)));
        out.set("object_draw_order_unique_ids", Value::array(ids));
        Ok(Value::object(out))
    }

    /// `sampleLegacy(report, time)`: the native timeline at a time with its property
    /// channels composed, in layer order.
    fn native_at(&self, time: f64) -> Result<Value, Error> {
        #[cfg(test)]
        NATIVE_SAMPLE_TIMES.with(|times| { if let Some(times) = times.borrow_mut().as_mut() { times.push(time.to_bits()); } });
        self.native_at_with(time, false, false)
    }

    fn native_at_with(&self, time: f64, clips: bool, editor: bool) -> Result<Value, Error> {
        let (index, t) = if editor { crate::eval::row_at(&self.rows, time) } else {
            let index = self.rows.partition_point(|r| r.start as f64 <= time).saturating_sub(1);
            let t = match self.rows.get(index) {
                Some(row) if row.count > 0 => (time - row.start as f64) / row.count as f64,
                _ => 0.0,
            };
            (index, t)
        };
        self.native_sample(index, t, time, clips)
    }

    /// `evaluatedFrame(report, index, t, time)` on a native timeline, before movieclips:
    /// the interval's frame with the property channels composed at `time`.
    fn native_sample(&self, index: usize, t: f64, time: f64, clips: bool) -> Result<Value, Error> {
        let frame = match (
            &self.source_tree,
            &self.prepared.source,
            self.prepared.retained_source_time(index, t),
        ) {
            (Some(tree), Some(prepared), Some(source_tick)) => {
                let source = Records::new(tree, prepared)?;
                let sampled = source.evaluated_with(source_tick, clips)?;
                let keys = items(self.tree.get("keyframes"));
                let key = keys
                    .get(index)
                    .ok_or_else(|| Error::Invalid(format!("no key {index}")))?;
                let mut frame = sampled.as_obj().cloned().unwrap_or_default();
                if let Some(duration) = key.get("duration_raw") {
                    frame.set("duration_raw", duration.clone());
                }
                match key.get("_styk") {
                    Some(styk) => frame.set("_styk", styk.clone()),
                    None => {
                        frame.remove("_styk");
                    }
                }
                let settings: HashMap<u32, Value> = items(key.get("objects"))
                    .iter()
                    .filter_map(|object| {
                        Some((
                            uid(object)? as u32,
                            object
                                .get("_stykMovieclip")
                                .filter(|p| {
                                    p.get("clock").and_then(Value::as_str) == Some("presence")
                                })?
                                .clone(),
                        ))
                    })
                    .collect();
                if !settings.is_empty() {
                    let objects = items(frame.get("objects"))
                        .into_iter()
                        .map(|object| {
                            if let Some(settings) =
                                uid(&object).and_then(|uid| settings.get(&(uid as u32)))
                            {
                                let mut object = object.as_obj().cloned().unwrap_or_default();
                                object.set("_stykMovieclip", settings.clone());
                                Value::object(object)
                            } else {
                                object
                            }
                        })
                        .collect();
                    frame.set("objects", Value::array(objects));
                }
                Value::object(frame)
            }
            _ => self.native(index, t)?,
        };
        Ok(self.layer_order(self.compose(frame, &self.legacy, time)?))
    }

    /// `evaluatedFrame(report, index, t, tick)` of a native timeline: the interval `index` at
    /// fraction `t`, its channels sampled at `tick` (an in-between samples between the rows'
    /// own times), and movieclips at `tick`.
    pub fn evaluated_interval(&self, index: usize, t: f64, tick: f64) -> Result<Value, Error> {
        if self.tree.path(&["_styk", "layerSheet"]).is_some() {
            return unported("an interval of a layer sheet");
        }
        let frame = self.native_sample(index, t, tick, true)?;
        let frame = self.sample_clips(frame, tick)?;
        Ok(self.layer_order(frame))
    }

    /// `evaluatedNativeFrame(report, index, t)`: the interval's frame without channels.
    pub fn native_interval(&self, index: usize, t: f64) -> Result<Value, Error> {
        self.native(index, t)
    }

    /// `evaluatedNativeFrame(report, index, t)` on the document's own keyframes.
    fn native(&self, index: usize, t: f64) -> Result<Value, Error> {
        let frames = items(self.tree.get("keyframes"));
        self.interval(&self.prepared.native, &|i| Ok(frames.get(i).cloned()), index, t, None)
    }

    /// `evaluatedNativeFrame` on a timeline: the document's keyframes, or a pose
    /// track's virtual ones. `frame_at` gives the record of each key of `seq`; with
    /// `only`, the other figures keep the interval's first pose (`requestedUids`).
    fn interval(&self, seq: &Seq, frame_at: &dyn Fn(usize) -> Result<Option<Value>, Error>, index: usize, t: f64, only: Option<&[u32]>) -> Result<Value, Error> {
        let (Some(a), Some(key)) = (frame_at(index)?, seq.keys.get(index)) else { return Err(Error::Invalid(format!("no key {index}"))) };
        let Some(b) = frame_at(index + 1)? else { return self.correct_origins(a) };
        if t <= 0.0 || (seq.version < 5 && key.easing.is_none()) {
            return self.correct_origins(a);
        }
        if t >= 1.0 {
            return self.correct_origins(b);
        }
        let auto = key.easing.map(|e| e.mode) == Some(crate::doc::EasingMode::Auto);
        let eased = if auto { t } else { crate::eval::eased_progress(key.easing.as_ref(), t) };
        if eased <= 0.0 {
            return self.correct_origins(a);
        }
        if eased >= 1.0 {
            return self.correct_origins(b);
        }
        // The numbers: the typed evaluator's tween of the same interval.
        let typed = evaluate_native_exact_only(&self.prepared.doc, seq, index, t, only);
        let before = &key.frame.objects;
        let next: HashMap<u64, Value> = items(b.get("objects")).into_iter().filter_map(|o| Some((uid(&o)?.to_bits(), o))).collect();
        let mut objects = Vec::new();
        for (slot, o) in items(a.get("objects")).into_iter().enumerate() {
            let pair = typed.objects.get(slot).zip(before.get(slot));
            let origin = pair.is_some_and(|(_, source)| self.prepared.doc.figure(source.figure).is_some_and(|figure| figure.origin.is_some()));
            let corrected = |mut record: Value| {
                if let Some((out, source)) = pair.filter(|(out, source)| origin && out.root != source.root)
                    && source.join.is_none()
                    && let Some(record) = record.make_obj()
                {
                    record.set("root_x", Value::Num(out.root[0]));
                    record.set("root_y", Value::Num(out.root[1]));
                    record.remove("runtime_segments");
                }
                record
            };
            let other = uid(&o).and_then(|id| next.get(&id.to_bits())).filter(|other| other.get("figure_type_id") == o.get("figure_type_id"));
            let Some(other) = other else {
                objects.push(corrected(o));
                continue;
            };
            let tweened = pair.filter(|(out, source)| {
                // Root correction may copy an otherwise untouched pose (including one outside
                // `only`). A real origin tween writes a fresh origin; correction keeps it.
                !Arc::ptr_eq(out, source) && !(origin && source.origin.as_ref().zip(out.origin.as_ref()).is_some_and(|(a, b)| Arc::ptr_eq(a, b)))
            });
            let Some((out, source)) = tweened else {
                objects.push(corrected(o));
                continue;
            };
            objects.push(tween_record(&o, other, source, out, origin)?);
        }
        let mut frame = a.as_obj().cloned().unwrap_or_default();
        frame.set("objects", Value::array(objects));
        if truthy(a.get("camera")) && truthy(b.get("camera")) {
            let camera = typed.camera.unwrap_or_default();
            let mut record = Obj::new();
            record.set("is_default", Value::Bool(false));
            record.set("x", Value::Num(camera.x));
            record.set("y", Value::Num(camera.y));
            record.set("scale", Value::Num(camera.scale));
            record.set("angle_rad", Value::Num(camera.angle));
            // A baked camera-motion impulse tweens when either key has one.
            if let Some([x, y]) = camera.motion_offset {
                let mut offset = Obj::new();
                offset.set("x", Value::Num(x));
                offset.set("y", Value::Num(y));
                record.set("_parallaxMotionOffset", Value::object(offset));
            }
            frame.set("camera", Value::object(record));
        }
        frame.set("background_id", Value::Num(typed.background as f64));
        frame.set("background_id_b", Value::Num(typed.background_b as f64));
        frame.set("background_mix", Value::Num(typed.background_mix));
        if let Some(stacks) = a.get("_stykVfx").filter(|v| v.truthy()) {
            frame.set("_stykVfx", vfx_record(stacks, b.get("_stykVfx"), key.frame.vfx.as_deref(), typed.pose_vfx.as_deref())?);
        }
        Ok(Value::object(frame))
    }

    /// One frame of `buildVirtualPoseTrack(report, channel)`: the key's pose source
    /// with the key's easing and the time to the next key.
    fn virtual_frame(&self, keys: &[Value], index: usize, fixed: bool) -> Result<Option<Value>, Error> {
        let Some(key) = keys.get(index) else { return Ok(None) };
        let frame_id = key.path(&["value", "frameId"]);
        let blank = matches!(key.get("value"), Some(Value::Null)) || matches!(frame_id, Some(Value::Null));
        let source = match (blank, frame_id.and_then(Value::as_str)) {
            (true, _) => None,
            (false, Some(id)) => Some(self.source(id).ok_or_else(|| Error::Invalid(format!("the pose source {id} is missing")))?),
            (false, None) => return Err(Error::Invalid("a pose key names no source".into())),
        };
        let mut frame = match &source {
            Some(source) => source.as_obj().cloned().unwrap_or_default(),
            None => {
                // `blankPoseFrame(report.keyframes[0])`.
                let mut blank = self.tree.get("keyframes").and_then(|k| k.item(0)).and_then(|f| f.as_obj().cloned()).unwrap_or_default();
                for key in ["background_color", "_stykBackgroundColor", "_stykVfx"] {
                    blank.remove(key);
                }
                empty_objects(&mut blank);
                for key in ["background_id", "background_id_b", "background_mix"] {
                    blank.set(key, Value::Num(0.0));
                }
                blank.set("camera", default_camera());
                blank
            }
        };
        let source_styk = source.as_ref().and_then(|s| s.get("_styk"));
        let mut styk = source_styk.and_then(Value::as_obj).cloned().unwrap_or_default();
        let easing = match key.get("interpolation") {
            None => source_styk.and_then(|s| s.get("easing")).cloned(),
            Some(interpolation) => {
                // `keyEasing(key)`: `hold` is read as `constant`.
                let mode = match interpolation.as_str() {
                    Some("hold") => "constant",
                    Some(mode) => mode,
                    None => "linear",
                };
                let mut easing = Obj::new();
                easing.set("interpolation", Value::str(mode));
                if mode == "bezier" {
                    easing.set("bezier", key.get("bezier").cloned().unwrap_or_else(|| numbers([0.42, 0.0, 0.58, 1.0])));
                }
                Some(Value::object(easing))
            }
        };
        match easing {
            Some(easing) => styk.set("easing", easing),
            None => {
                styk.remove("easing");
            }
        }
        frame.set("_styk", Value::object(styk));
        let tick = |k: &Value| num(k, "tick").unwrap_or(0.0);
        let duration = if truthy(key.get("hidden")) { 0.0 } else { keys.get(index + 1).map_or(1.0, |next| (tick(next) - tick(key)).max(0.0)) };
        frame.set("duration_raw", Value::Num(duration));
        if fixed {
            empty_objects(&mut frame);
        }
        Ok(Some(Value::object(frame)))
    }

    /// `samplePoseTrack(report, channel, tick)` for a layer's own keys.
    fn pose_track(&self, id: &str, keys: &[Value], tick: f64) -> Result<Option<Sample>, Error> {
        let fixed = id == "scene" || id == "camera";
        let Some(seq) = self.prepared.track(id) else { return Err(Error::Invalid(format!("no pose track {id}"))) };
        Ok(self.sample_keys(seq, keys, fixed, tick, None)?.map(|frame| Sample { frame, identity: Identity::Track(id.to_string()) }))
    }

    /// `samplePoseTrack` on keys and the typed sequence built from the same keys, tweening
    /// only the figures `only` when given (`sampleUids`).
    fn sample_keys(&self, seq: &Seq, keys: &[Value], fixed: bool, tick: f64, only: Option<&[u32]>) -> Result<Option<Value>, Error> {
        // `buildVirtualPoseTrack` orders the keys by time, a hidden key before a visible one at
        // the same time (a stable sort, as the typed track's).
        let hidden = |k: &Value| truthy(k.get("hidden"));
        let mut keys = keys.to_vec();
        keys.sort_by(|a, b| num(a, "tick").unwrap_or(0.0).total_cmp(&num(b, "tick").unwrap_or(0.0)).then((hidden(b) as u8).cmp(&(hidden(a) as u8))));
        let ticks: Vec<f64> = keys.iter().map(|k| num(k, "tick").unwrap_or(0.0)).collect();
        if ticks.is_empty() || tick < ticks[0] {
            return Ok(None);
        }
        let low = ticks.partition_point(|&t| t <= tick) - 1;
        let fraction = match ticks.get(low + 1) {
            Some(&next) if next > ticks[low] => ((tick - ticks[low]) / (next - ticks[low])).clamp(0.0, 1.0),
            _ => 0.0,
        };
        Ok(Some(self.interval(seq, &|i| self.virtual_frame(&keys, i, fixed), low, fraction, only)?))
    }

    /// `layerIdForUid(report, uid)`.
    fn layer_of(&self, uid: f64) -> String {
        let Some(state) = self.tree.path(&["_styk", "layers"]) else { return "layer-1".into() };
        let key = styk_doc::json::to_string(&Value::Num(uid));
        let assigned = state.get("assignments").and_then(|a| a.get(&key));
        assigned.or_else(|| state.get("defaultLayerId")).and_then(Value::as_str).unwrap_or("").to_string()
    }

    /// `applyLayerOrder(report, frame)`: figures drawn layer by layer; slots stay.
    fn layer_order(&self, frame: Value) -> Value {
        let state = self.tree.path(&["_styk", "layers"]);
        let objects = items(frame.get("objects"));
        let depth = |o: &Value| o.get("_stykZIndex").and_then(Value::as_f64).unwrap_or(0.0);
        let has_depth = objects.iter().any(|o| truthy(o.get("_stykZIndex")));
        let layers: Vec<String> = match state {
            Some(state) => items(state.get("order")).iter().filter_map(|id| id.as_str().map(str::to_string)).collect(),
            None => vec!["layer-1".into()],
        };
        if (state.is_none() || layers.len() < 2) && !has_depth {
            return frame;
        }
        let order: Vec<usize> = match frame.get("object_draw_order").filter(|o| !o.is_null()) {
            Some(order) => order.numbers().unwrap_or_default().into_iter().map(|s| s as usize).collect(),
            None => (0..objects.len()).collect(),
        };
        let mut groups: Vec<Vec<usize>> = vec![Vec::new(); layers.len()];
        for &slot in &order {
            let Some(object) = objects.get(slot) else { return frame };
            let id = self.layer_of(uid(object).unwrap_or(f64::NAN));
            let Some(group) = layers.iter().position(|layer| *layer == id) else { return frame };
            groups[group].push(slot);
        }
        let mut next = Vec::with_capacity(order.len());
        for mut group in groups {
            if has_depth {
                group.sort_by(|&a, &b| depth(&objects[a]).total_cmp(&depth(&objects[b])));
            }
            next.extend(group);
        }
        if next == order {
            return frame;
        }
        let mut out = frame.as_obj().cloned().unwrap_or_default();
        out.set("object_draw_order", numbers(next.iter().map(|&s| s as f64)));
        out.set("object_draw_order_unique_ids", Value::array(next.iter().map(|&s| objects[s].get("unique_id").cloned().unwrap_or(Value::Null)).collect()));
        Value::object(out)
    }

    /// `poseSourceFrame(report, id)`: one canonical COW source lookup owner.
    /// A native marker caller may supply its row index to avoid rescanning the
    /// timeline. Retained sources always take precedence, and a hint is used
    /// only when that row's identity matches; an absent/wrong hint has exactly
    /// the ordinary lookup result. Supply a hint only after verifying that native
    /// frame identities are unique, as the editor loader does. Callers of raw or
    /// unvalidated records must pass `None` to preserve first-match lookup.
    /// No index, source store or evaluator is added.
    pub fn pose_source_frame(&self, id: &str, native_index: Option<usize>) -> Option<Value> {
        let retained = self.tree.path(&["_styk", "frameSources"]).and_then(|sources| sources.get(id)).filter(|frame| frame.truthy());
        retained.cloned().or_else(|| {
            let frames = self.tree.get("keyframes")?;
            if let Some(frame) = native_index.and_then(|index| frames.item(index))
                .filter(|frame| frame.path(&["_styk", "frameId"]).and_then(Value::as_str) == Some(id))
            {
                return Some(frame);
            }
            frames.elements()?.iter().find(|frame| frame.path(&["_styk", "frameId"]).and_then(Value::as_str) == Some(id))
        })
    }

    fn source(&self, id: &str) -> Option<Value> {
        self.pose_source_frame(id, None)
    }

    /// `baseSample(id, track)`: a layer's pose from its keys.
    fn base_sample(&self, id: &str, track: &Value, tick: f64, source_at: &impl Fn(f64) -> Result<Value, Error>) -> Result<Option<Sample>, Error> {
        let fixed = id == "scene" || id == "camera";
        let keys: Vec<Value> = items(track.get("keys")).into_iter().filter(|k| !truthy(k.get("patchOnly"))).collect();
        if !fixed && tick >= num(track, "end").unwrap_or(0.0) {
            return Ok(None);
        }
        let at = keys.partition_point(|k| num(k, "tick").unwrap_or(0.0) <= tick);
        let Some(key) = at.checked_sub(1).map(|i| &keys[i]) else { return Ok(None) };
        let next = keys.get(at);
        let frame_id = |k: &Value| k.path(&["value", "frameId"]).cloned();
        let source_tick = |k: &Value| num(k, "sourceTick");
        let native = |time: f64| -> Result<Option<Sample>, Error> { Ok(Some(Sample { frame: source_at(time)?, identity: Identity::Native(source_time_key(time)) })) };
        let held = |k: &Value| -> Result<Option<Sample>, Error> {
            match (source_tick(k), frame_id(k)) {
                (Some(time), _) => native(time),
                (None, Some(Value::Str(id))) => Ok(self.source(&id).map(|frame| Sample { frame, identity: Identity::Source(id.clone()) })),
                _ => Ok(None),
            }
        };
        if matches!(frame_id(key), Some(Value::Null)) {
            return Ok(None);
        }
        if next.is_some_and(|n| matches!(frame_id(n), Some(Value::Null))) {
            return held(key);
        }
        if let Some(start) = source_tick(key)
            && next.is_none_or(|n| source_tick(n).is_some())
        {
            let (fraction, end) = match next {
                Some(n) => {
                    let (a, b) = (num(key, "tick").unwrap_or(0.0), num(n, "tick").unwrap_or(0.0));
                    (((tick - a) / (b - a)).clamp(0.0, 1.0), source_tick(n).unwrap_or(start))
                }
                None => (0.0, start),
            };
            return native(start + fraction * (end - start));
        }
        if keys.iter().any(|k| source_tick(k).is_some()) {
            // Imported and authored keys: a window of the keys around the playhead.
            let Some(track) = self.prepared.doc.sheet.as_ref().and_then(|sheet| sheet.tracks.get(id)) else { return Err(Error::Invalid(format!("no track {id}"))) };
            let typed: Vec<&crate::doc::SheetKey> = track.keys.iter().filter(|k| !k.patch_only).collect();
            if typed.len() != keys.len() {
                return Err(Error::Invalid(format!("the keys of {id} were not all read")));
            }
            let index = at - 1;
            let (seq, first) = self.prepared.mixed_window(id, &typed, index);
            let fraction = next.map_or(0.0, |n| {
                let (a, b) = (num(key, "tick").unwrap_or(0.0), num(n, "tick").unwrap_or(0.0));
                (tick - a) / (b - a)
            });
            let count = seq.keys.len();
            let frame = self.interval(&seq, &|i| if i < count { self.window_frame(id, &keys, first + i, fixed, source_at).map(Some) } else { Ok(None) }, index - first, fraction, None)?;
            return Ok(Some(Sample { frame, identity: Identity::Track(id.to_string()) }));
        }
        self.pose_track(id, &keys, tick)
    }

    /// One key of a mixed layer as a native keyframe (`baseSample`'s `imported` branch):
    /// an imported key is the layer's figures of the imported pose at its source tick.
    fn window_frame(&self, id: &str, keys: &[Value], index: usize, fixed: bool, source_at: &impl Fn(f64) -> Result<Value, Error>) -> Result<Value, Error> {
        let entry = &keys[index];
        let frame = match num(entry, "sourceTick") {
            Some(time) => {
                let source = source_at(time)?;
                let uids: Vec<f64> = if fixed { Vec::new() } else { items(source.get("objects")).iter().filter_map(uid).filter(|&u| self.layer_of(u) == id).collect() };
                Some(snapshot_pose_frame_of(&source, Some(&uids)))
            }
            None => entry.path(&["value", "frameId"]).and_then(Value::as_str).and_then(|frame_id| self.source(frame_id)),
        };
        let mut out = match &frame {
            Some(frame) => frame.as_obj().cloned().unwrap_or_default(),
            None => {
                let mut blank = self.tree.get("keyframes").and_then(|k| k.item(0)).and_then(|f| f.as_obj().cloned()).unwrap_or_default();
                empty_objects(&mut blank);
                blank
            }
        };
        let mut easing = Obj::new();
        if let Some(interpolation) = entry.get("interpolation") {
            easing.set("interpolation", interpolation.clone());
        }
        if let Some(bezier) = entry.get("bezier").filter(|b| b.truthy()) {
            easing.set("bezier", bezier.clone());
        }
        let mut styk = frame.as_ref().and_then(|f| f.get("_styk")).and_then(Value::as_obj).cloned().unwrap_or_default();
        styk.set("easing", Value::object(easing));
        out.set("_styk", Value::object(styk));
        let tick = num(entry, "tick").unwrap_or(0.0);
        let until = keys.get(index + 1).and_then(|next| num(next, "tick")).unwrap_or(tick + 1.0);
        out.set("duration_raw", Value::Num(until - tick));
        Ok(Value::object(out))
    }

    /// `sample(id)`: the base pose, then the movieclip frames its key replaces.
    fn sample(&self, sheet: &Value, id: &str, tick: f64, skip_patches: bool, source_at: &impl Fn(f64) -> Result<Value, Error>) -> Result<Option<Sample>, Error> {
        let Some(track) = sheet.path(&["tracks", id]) else { return Ok(None) };
        let mut sample = self.base_sample(id, track, tick, source_at)?;
        let keys = items(track.get("keys"));
        let at = keys.partition_point(|k| num(k, "tick").unwrap_or(0.0) <= tick);
        let Some(key) = at.checked_sub(1).map(|i| &keys[i]) else { return Ok(sample) };
        let patches = items(key.get("movieclipPatches"));
        if skip_patches || patches.is_empty() || tick >= num(track, "end").unwrap_or(0.0) {
            return Ok(sample);
        }
        let next = keys.get(at);
        let held = matches!(key.get("interpolation").and_then(Value::as_str), Some("constant" | "hold"));
        // Roots of figures a replacement leaves without a parent come from the geometry
        // of the frame being replaced: the typed evaluator's result for this layer.
        let typed = self.prepared.layer_frame(id, tick);
        let root_of = |uid: f64| typed.as_ref().and_then(|frame| frame.objects.iter().find(|o| o.uid as f64 == uid)).map(|o| o.root);
        for patch in &patches {
            let removed = num(patch, "uid").unwrap_or(f64::NAN);
            let continues = next.is_some_and(|n| items(n.get("movieclipPatches")).iter().any(|other| num(other, "uid") == Some(removed)));
            let replacement = if continues && !held {
                // Consecutive replacements of one movieclip tween like any pose track.
                let mapped: Vec<Value> = keys
                    .iter()
                    .map(|entry| {
                        let frame_id = items(entry.get("movieclipPatches")).iter().find(|other| num(other, "uid") == Some(removed)).and_then(|other| other.get("frameId").cloned());
                        let mut value = Obj::new();
                        value.set("frameId", frame_id.unwrap_or(Value::Null));
                        let mut entry = entry.as_obj().cloned().unwrap_or_default();
                        entry.set("value", Value::object(value));
                        Value::object(entry)
                    })
                    .collect();
                let Some(seq) = self.prepared.patch_track(id, removed as u32) else { return Err(Error::Invalid(format!("no replacement track for {removed} on {id}"))) };
                self.sample_keys(seq, &mapped, false, tick, None)?
            } else {
                patch.get("frameId").and_then(Value::as_str).and_then(|frame_id| self.source(frame_id))
            };
            let Some(replacement) = replacement else { return Err(Error::Invalid("a movieclip replacement has no frame".into())) };
            let base = match sample.take() {
                Some(sample) => sample.frame,
                None => {
                    let mut blank = self.tree.get("keyframes").and_then(|k| k.item(0)).and_then(|f| f.as_obj().cloned()).unwrap_or_default();
                    blank.set("objects", Value::array(Vec::new()));
                    blank.set("object_draw_order", Value::array(Vec::new()));
                    blank.set("object_draw_order_unique_ids", Value::array(Vec::new()));
                    Value::object(blank)
                }
            };
            sample = Some(Sample { frame: self.replace_movieclip_frame(&base, patch, &replacement, &root_of), identity: Identity::Track(id.to_string()) });
        }
        Ok(sample)
    }

    /// `replaceMovieclipFrame(report, base, patch, …, replacement)`: the figures of
    /// `replacement` take the place of movieclip `patch.uid` in `base`.
    fn replace_movieclip_frame(&self, base: &Value, patch: &Value, replacement: &Value, root_of: &dyn Fn(f64) -> Option<[f64; 2]>) -> Value {
        let removed = num(patch, "uid");
        let base_objects = items(base.get("objects"));
        let new_objects = items(replacement.get("objects"));
        let added: Vec<f64> = new_objects.iter().filter_map(uid).collect();
        let join_of = |object: &Value| object.get("join").filter(|j| j.truthy()).cloned();
        let target_uid = |objects: &[Value], join: &Value| num(join, "target_object_slot").filter(|s| *s >= 0.0).and_then(|s| objects.get(s as usize)).and_then(uid);
        let with_target = |join: &Value, target: Option<f64>| {
            let mut join = join.as_obj().cloned().unwrap_or_default();
            match target {
                Some(target) => join.set("target_unique_id", Value::Num(target)),
                None => {
                    join.remove("target_unique_id");
                }
            }
            join
        };
        // (record, the unique id it joins)
        let mut members: Vec<(Obj, Option<Obj>)> = Vec::new();
        for object in base_objects.iter().filter(|o| uid(o) != removed && !uid(o).is_some_and(|u| added.contains(&u))) {
            let mut record = object.as_obj().cloned().unwrap_or_default();
            let mut joined = None;
            if let Some(join) = join_of(object) {
                let parent = target_uid(&base_objects, &join);
                let replacement_uid = num(patch, "replacementUid");
                if parent == removed && parent.is_some() && replacement_uid.is_some() {
                    joined = Some(with_target(&join, replacement_uid));
                } else if parent == removed && parent.is_some() {
                    if let Some(root) = uid(object).and_then(root_of) {
                        record.set("root_x", Value::Num(root[0]));
                        record.set("root_y", Value::Num(root[1]));
                    }
                    record.set("join", Value::Null);
                } else {
                    joined = Some(with_target(&join, parent));
                }
            }
            members.push((record, joined));
        }
        for object in &new_objects {
            let record = object.as_obj().cloned().unwrap_or_default();
            let joined = join_of(object).map(|join| with_target(&join, target_uid(&new_objects, &join)));
            members.push((record, joined));
        }
        let order_of = |frame: &Value, objects: &[Value]| -> Vec<f64> {
            match frame.get("object_draw_order").filter(|o| o.truthy()) {
                Some(order) => order.numbers().unwrap_or_default().into_iter().filter_map(|slot| objects.get(slot as usize).filter(|_| slot >= 0.0).and_then(uid)).collect(),
                None => objects.iter().filter_map(uid).collect(),
            }
        };
        let previous = order_of(base, &base_objects);
        let anchor = previous.iter().position(|u| Some(*u) == removed);
        let mut order: Vec<f64> = previous.iter().copied().filter(|u| Some(*u) != removed && !added.contains(u)).collect();
        let mut insertion = anchor.map_or(order.len(), |anchor| anchor.min(order.len()));
        if let (None, Some(index)) = (anchor, num(patch, "orderIndex")) {
            let layer = self.layer_of(removed.unwrap_or(f64::NAN));
            let siblings: Vec<usize> = order.iter().enumerate().filter(|(_, u)| self.layer_of(**u) == layer).map(|(at, _)| at).collect();
            insertion = match (siblings.get(index as usize), siblings.last()) {
                (Some(&at), _) => at,
                (None, Some(&last)) => last + 1,
                (None, None) => order.len(),
            };
        }
        let replacement_order = order_of(replacement, &new_objects);
        order.splice(insertion..insertion, replacement_order);
        // `normalizeFrame`: slots follow unique ids; joins follow their figures.
        let id_of = |record: &Obj| record.get("unique_id").and_then(Value::as_f64).unwrap_or(f64::NAN);
        members.sort_by_key(|(record, _)| id_of(record) as i64 as i32);
        let slots: HashMap<u64, usize> = members.iter().enumerate().map(|(slot, (record, _))| (id_of(record).to_bits(), slot)).collect();
        let objects: Vec<Value> = members
            .into_iter()
            .enumerate()
            .map(|(slot, (mut record, joined))| {
                record.set("object_slot", Value::Num(slot as f64));
                if let Some(mut join) = joined {
                    let target = join.get("target_unique_id").and_then(Value::as_f64).and_then(|u| slots.get(&u.to_bits()));
                    match target {
                        Some(&target) => join.set("target_object_slot", Value::Num(target as f64)),
                        None => {
                            join.remove("target_object_slot");
                            join.remove("target_unique_id");
                        }
                    }
                    record.set("join", Value::object(join));
                }
                Value::object(record)
            })
            .collect();
        let mut frame = base.as_obj().cloned().unwrap_or_default();
        frame.set("objects", Value::array(objects));
        frame.set("object_draw_order_unique_ids", numbers(order.iter().copied()));
        frame.set("object_draw_order", Value::array(order.iter().map(|u| slots.get(&u.to_bits()).map_or(Value::Null, |&slot| Value::Num(slot as f64))).collect()));
        let continuations = |frame: &Value| items(frame.path(&["_styk", "movieclipContinuations"]));
        let incoming = continuations(replacement);
        let mut steps: Vec<Value> = continuations(base).into_iter().filter(|step| num(step, "uid") != removed && !incoming.iter().any(|other| num(other, "uid") == num(step, "uid"))).collect();
        steps.extend(incoming);
        let mut styk = frame.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
        if steps.is_empty() {
            styk.remove("movieclipContinuations");
        } else {
            styk.set("movieclipContinuations", Value::array(steps));
        }
        frame.set("_styk", Value::object(styk));
        Value::object(frame)
    }

    /// `sampleLayerSheet(report, tick)`.
    fn sample_sheet(&self, sheet: &Value, tick: f64, skip_patches: bool) -> Result<Value, Error> {
        // `sampleLayerSheet` clears its sourceAt map for every call. Share complete
        // imported samples across scene, camera, layers and mixed endpoints only
        // during this immutable sampling operation; retain no cross-call state.
        let samples = std::cell::RefCell::new(HashMap::new());
        self.sample_sheet_with(sheet, tick, skip_patches, &|time| source_at(&samples, time, |time| self.native_at(time)))
    }

    fn sample_sheet_with(&self, sheet: &Value, tick: f64, skip_patches: bool,
        source_at: &impl Fn(f64) -> Result<Value, Error>) -> Result<Value, Error>
    {
        let layers: Vec<String> = items(self.tree.path(&["_styk", "layers", "order"])).iter().filter_map(|id| id.as_str().map(str::to_string)).collect();
        let scene = self.sample(sheet, "scene", tick, skip_patches, source_at)?;
        let camera = self.sample(sheet, "camera", tick, skip_patches, source_at)?;
        let mut frames: Vec<(String, Option<Sample>)> = Vec::new();
        for id in &layers {
            frames.push((id.clone(), self.sample(sheet, id, tick, skip_patches, source_at)?));
        }
        let continuations = |frame: &Value| items(frame.path(&["_styk", "movieclipContinuations"]));
        let frame_of = |layer: &str| frames.iter().find(|(id, _)| id == layer).and_then(|(_, sample)| sample.as_ref());
        // Imported layers that share one native pose are that pose, whole.
        if let (Some(scene), Some(camera)) = (&scene, &camera)
            && camera.identity == scene.identity
        {
            let same = |sample: Option<&Sample>| sample.is_some_and(|s| s.identity == scene.identity);
            let objects = items(scene.frame.get("objects"));
            let steps = continuations(&scene.frame);
            if objects.iter().all(|o| same(frame_of(&self.layer_of(uid(o).unwrap_or(f64::NAN)))))
                && steps.iter().all(|step| same(frame_of(&self.layer_of(num(step, "uid").unwrap_or(f64::NAN)))))
                && frames.iter().all(|(_, sample)| match sample {
                    None => true,
                    Some(s) => s.identity == scene.identity || (items(s.frame.get("objects")).is_empty() && continuations(&s.frame).is_empty()),
                })
            {
                return Ok(scene.frame.clone());
            }
        }
        // Otherwise each layer contributes its own figures from its own sample.
        let mut records: Vec<(Value, Option<f64>)> = Vec::new();
        let mut steps: Vec<Value> = Vec::new();
        let mut seen: Vec<&Sample> = Vec::new();
        let mut partitions: Vec<HashMap<String, Group>> = Vec::new();
        for (id, sample) in &frames {
            let Some(sample) = sample else { continue };
            let at = match seen.iter().position(|s| s.identity == sample.identity) {
                Some(at) => at,
                None => {
                    let objects = items(sample.frame.get("objects"));
                    let order: Vec<usize> = match sample.frame.get("object_draw_order").filter(|o| !o.is_null()) {
                        Some(order) => order.numbers().unwrap_or_default().into_iter().map(|s| s as usize).collect(),
                        None => (0..objects.len()).collect(),
                    };
                    let mut groups: HashMap<String, Group> = HashMap::new();
                    for object in order.iter().filter_map(|&slot| objects.get(slot)) {
                        let parent = object.get("join").filter(|j| j.truthy()).map(|join| {
                            let slot = num(join, "target_object_slot").unwrap_or(f64::NAN);
                            objects.get(slot as usize).filter(|_| slot >= 0.0).and_then(uid)
                        });
                        let owner = self.layer_of(uid(object).unwrap_or(f64::NAN));
                        groups.entry(owner).or_default().records.push((object.clone(), parent.flatten()));
                    }
                    for step in continuations(&sample.frame) {
                        groups.entry(self.layer_of(num(&step, "uid").unwrap_or(f64::NAN))).or_default().steps.push(step);
                    }
                    seen.push(sample);
                    partitions.push(groups);
                    seen.len() - 1
                }
            };
            if let Some(group) = partitions[at].get(id) {
                records.extend(group.records.iter().cloned());
                steps.extend(group.steps.iter().cloned());
            }
        }
        let slots: HashMap<u64, usize> = records.iter().enumerate().filter_map(|(slot, (object, _))| Some((uid(object)?.to_bits(), slot))).collect();
        let objects: Vec<Value> = records
            .iter()
            .enumerate()
            .map(|(slot, (object, parent))| {
                let join = object.get("join").filter(|j| j.truthy());
                let parent_slot = parent.and_then(|p| slots.get(&p.to_bits()).copied());
                let joined = join.is_some() && parent_slot.is_some();
                let slot_matches = num(object, "object_slot") == Some(slot as f64);
                let join_matches = join.is_none() || (joined && join.and_then(|j| num(j, "target_object_slot")) == parent_slot.map(|s| s as f64));
                if slot_matches && join_matches {
                    return object.clone();
                }
                let mut out = object.as_obj().cloned().unwrap_or_default();
                out.set("object_slot", Value::Num(slot as f64));
                out.set(
                    "join",
                    match (joined, join) {
                        (true, Some(join)) => {
                            let mut join = join.as_obj().cloned().unwrap_or_default();
                            join.set("target_object_slot", Value::Num(parent_slot.unwrap() as f64));
                            join.set("target_unique_id", Value::Num(parent.unwrap()));
                            Value::object(join)
                        }
                        _ => Value::Null,
                    },
                );
                Value::object(out)
            })
            .collect();
        let template = self.tree.get("keyframes").and_then(|k| k.item(0)).unwrap_or(Value::Null);
        let mut result = template.as_obj().cloned().unwrap_or_default();
        let count = objects.len();
        let ids: Vec<Value> = objects.iter().map(|o| o.get("unique_id").cloned().unwrap_or(Value::Null)).collect();
        result.set("objects", Value::array(objects));
        result.set("object_count", Value::Num(count as f64));
        result.set("object_draw_order", numbers((0..count).map(|i| i as f64)));
        result.set("object_draw_order_unique_ids", Value::array(ids));
        result.set(
            "camera",
            camera.as_ref().and_then(|c| c.frame.get("camera").filter(|v| !v.is_null()).cloned()).unwrap_or_else(default_camera),
        );
        // `setContinuations`: `_styk` is copied, with or without the list.
        let mut styk = result.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
        if steps.is_empty() {
            styk.remove("movieclipContinuations");
        } else {
            styk.set("movieclipContinuations", Value::array(steps));
        }
        result.set("_styk", Value::object(styk));
        for field in ["background_id", "background_id_b", "background_mix", "background_color", "_stykBackgroundColor", "_stykVfx"] {
            match scene.as_ref().map(|s| s.frame.get(field)) {
                Some(Some(value)) => result.set(field, value.clone()),
                Some(None) => {
                    result.remove(field);
                }
                // No scene pose: `{background_id: 0, background_id_b: 0, background_mix: 0}`.
                None if field.starts_with("background_") && field != "background_color" => result.set(field, Value::Num(0.0)),
                None => {
                    result.remove(field);
                }
            }
        }
        Ok(Value::object(result))
    }
}

/// `{is_default: true, x: 0, y: 0, scale: 1, angle_rad: 0}`.
fn default_camera() -> Value {
    let mut camera = Obj::new();
    camera.set("is_default", Value::Bool(true));
    camera.set("x", Value::Num(0.0));
    camera.set("y", Value::Num(0.0));
    camera.set("scale", Value::Num(1.0));
    camera.set("angle_rad", Value::Num(0.0));
    Value::object(camera)
}

/// `objects: [], object_count: 0, object_draw_order: [], object_draw_order_unique_ids: []`.
fn empty_objects(frame: &mut Obj) {
    frame.set("objects", Value::array(Vec::new()));
    frame.set("object_count", Value::Num(0.0));
    frame.set("object_draw_order", Value::array(Vec::new()));
    frame.set("object_draw_order_unique_ids", Value::array(Vec::new()));
}

/// The record of a tweened figure: `out` in `evaluatedNativeFrame`, with the keys
/// in the order the editor writes them and the typed evaluator's values.
fn tween_record(o: &Value, next: &Value, source: &crate::doc::Object, out: &crate::doc::Object, origin: bool) -> Result<Value, Error> {
    let mut record = o.as_obj().cloned().unwrap_or_default();
    record.remove("runtime_segments");
    // `interpolateSpatialPose`: the camera always, proportions when either key has any.
    if truthy(o.get("_stykSpatial")) || truthy(next.get("_stykSpatial")) {
        let Some(pose) = &out.spatial else { return unported("3D poses the engine did not read") };
        record.set("_stykSpatial", spatial_record(pose));
    }
    if let Some(stacks) = o.get("_stykVfx").filter(|v| v.truthy()) {
        record.set("_stykVfx", vfx_record(stacks, next.get("_stykVfx"), source.vfx.as_deref(), out.vfx.as_deref())?);
    }
    if let (Some(table), Some(typed)) = (o.get("_stykIK").filter(|t| t.truthy()), &out.ik) {
        record.set("_stykIK", ik_record(table, next.get("_stykIK"), typed));
    }
    record.set("root_x", Value::Num(out.root[0]));
    record.set("root_y", Value::Num(out.root[1]));
    record.set("scale", Value::Num(out.scale));
    if origin && truthy(o.get("_stykAnimationOrigin")) && truthy(next.get("_stykAnimationOrigin")) {
        let Some(pose) = out.origin.as_deref() else { return unported("an animation origin the engine did not read") };
        let mut origin = Obj::new();
        origin.set("x", Value::Num(pose.x));
        origin.set("y", Value::Num(pose.y));
        for (key, offset) in ["offsetX", "offsetY"].into_iter().zip(pose.offset) {
            if let Some(value) = offset {
                origin.set(key, Value::Num(value));
            }
        }
        if !pose.ghosts.is_empty() {
            let mut ghosts = Obj::new();
            for (index, pose) in &pose.ghosts {
                let mut ghost = Obj::new();
                // `interpolateOriginSupport` creates bend and length, then its angular pass
                // writes angle. Integer bone keys enumerate in ascending order in JavaScript.
                ghost.set("bend_rad", Value::Num(pose.bend));
                ghost.set("length", Value::Num(pose.length));
                ghost.set("angle_rad", Value::Num(pose.angle));
                ghosts.set(&index.to_string(), Value::object(ghost));
            }
            origin.set("ghosts", Value::object(ghosts));
        }
        record.set("_stykAnimationOrigin", Value::object(origin));
    }
    record.set("field28", Value::Num(out.transparency));
    if let Some(lengths) = &out.lengths {
        record.set("len_flag", Value::Num(1.0));
        record.set("lengths", numbers(lengths.iter().copied()));
    }
    if let Some(bends) = &out.bends {
        record.set("bend_flag", Value::Num(1.0));
        record.set("bends", numbers(bends.iter().copied()));
    }
    record.set("angles", numbers(out.angles.iter().copied()));
    record.set("color_override_raw", Value::Num(out.color as f64));
    Ok(Value::object(record))
}

/// `interpolateSpatialPose(a, b, t)`'s record: `{camera: {strength, distance, centerX,
/// centerY}, shape?: {[handle]: {width, taper}}}`, handles in ascending order as
/// JavaScript keeps integer keys.
fn spatial_record(pose: &crate::doc::SpatialPose) -> Value {
    let mut record = Obj::new();
    if let Some(c) = pose.camera {
        let mut camera = Obj::new();
        camera.set("strength", Value::Num(c.strength));
        camera.set("distance", Value::Num(c.distance));
        for (key, value) in [("centerX", c.center[0]), ("centerY", c.center[1])] {
            if let Some(value) = value {
                camera.set(key, Value::Num(value));
            }
        }
        record.set("camera", Value::object(camera));
    }
    if let Some(shape) = &pose.shape {
        let mut bones = Obj::new();
        for (id, s) in shape {
            let mut entry = Obj::new();
            entry.set("width", Value::Num(s.width));
            entry.set("taper", Value::Num(s.taper));
            bones.set(&id.to_string(), Value::object(entry));
        }
        record.set("shape", Value::object(bones));
    }
    Value::object(record)
}

/// `interpolateVfx(a, b, t)` as a record: every effect of `stacks` whose identity and
/// type the next pose also has gets all its parameters, resolved and tweened, in the
/// registry's order; every other effect stays the record it is. `before` and `after`
/// are the typed stacks of the pose and of the tween.
fn vfx_record(stacks: &Value, next: Option<&Value>, before: Option<&crate::vfx::Stacks>, after: Option<&crate::vfx::Stacks>) -> Result<Value, Error> {
    if !truthy(next) {
        return Ok(stacks.clone());
    }
    let (Some(entries), Some(before), Some(after)) = (stacks.as_obj(), before, after) else { return unported("effect stacks the engine did not read") };
    if entries.len() != before.entries.len() || entries.len() != after.entries.len() {
        return unported("effect stacks the engine did not read");
    }
    let mut out = Obj::new();
    for (at, (key, stack)) in entries.iter().enumerate() {
        let (from, to) = (&before.entries[at].1, &after.entries[at].1);
        let effects = items(Some(stack));
        if effects.len() != from.len() || effects.len() != to.len() {
            return unported("effect records the engine did not read");
        }
        let tweened = effects.iter().enumerate().map(|(i, effect)| {
            if Arc::ptr_eq(&from[i], &to[i]) {
                return effect.clone();
            }
            let mut params = Obj::new();
            for (index, spec) in to[i].kind().specs().iter().enumerate() {
                params.set(spec.name, match to[i].params.get(index) {
                    crate::vfx::ParamValue::Num(value) => Value::Num(value),
                    crate::vfx::ParamValue::Paint(paint) => paint_record(&paint),
                });
            }
            let mut record = effect.as_obj().cloned().unwrap_or_default();
            record.set("params", Value::object(params));
            Value::object(record)
        });
        out.set(key, Value::array(tweened.collect()));
    }
    Ok(Value::object(out))
}

/// `normalizePaint`'s record: `{type, angle, stops: [{offset, color, opacity}]}`.
pub fn paint_record(paint: &crate::doc::Paint) -> Value {
    let mut record = Obj::new();
    record.set("type", Value::str(crate::vfx::paint::kind_name(paint.kind)));
    record.set("angle", Value::Num(paint.angle));
    let stops = paint.stops.iter().map(|stop| {
        let mut record = Obj::new();
        record.set("offset", Value::Num(stop.offset));
        record.set("color", numbers(stop.rgb.iter().map(|&c| c as f64)));
        record.set("opacity", Value::Num(stop.opacity));
        Value::object(record)
    });
    record.set("stops", Value::array(stops.collect()));
    Value::object(record)
}

/// `interpolateIK(a, b, t, sample)` as a record: the controllers of `table` on their
/// way to `next`'s, with the typed tween's values in the editor's key layout.
fn ik_record(table: &Value, next: Option<&Value>, typed: &crate::ik::Table) -> Value {
    let Some(controllers) = table.as_obj() else { return table.clone() };
    let mut out = Obj::new();
    for (id, c) in controllers.iter() {
        let other = next.and_then(|n| n.get(id));
        let handle = id.parse::<u32>().ok();
        let compatible = other.is_some_and(|n| truthy(n.get("enabled")) && truthy(c.get("enabled")) && n.get("pinned") == c.get("pinned"));
        let (Some(other), Some(tweened)) = (other.filter(|_| compatible), handle.and_then(|h| typed.get(h))) else {
            out.set(id, c.clone());
            continue;
        };
        let finite = |v: Option<&Value>| v.and_then(Value::as_f64).is_some_and(f64::is_finite);
        // `{...c.target}` with its three channels; `{...c.followers}` with the ones `next` has.
        let mut target = c.get("target").and_then(Value::as_obj).cloned().unwrap_or_default();
        target.set("x", Value::Num(tweened.target.x));
        target.set("y", Value::Num(tweened.target.y));
        target.set("rotation", Value::Num(tweened.target.rotation));
        let mut followers = c.get("followers").and_then(Value::as_obj).cloned().unwrap_or_default();
        let children: Vec<Arc<str>> = followers.keys().cloned().collect();
        for child in children {
            if finite(other.get("followers").and_then(|f| f.get(&child)))
                && let Some(angle) = child.parse::<u32>().ok().and_then(|h| tweened.followers.get(&h))
            {
                followers.set(&child, Value::Num(*angle));
            }
        }
        let mut record = c.as_obj().cloned().unwrap_or_default();
        record.set("target", Value::object(target));
        record.set("followers", Value::object(followers));
        let quaternions = |from: &Obj, typed: Option<&crate::ik::Quaternions>| -> Value {
            Value::object(from.iter().map(|(id, q)| (id.clone(), id.parse::<u32>().ok().and_then(|h| typed?.get(&h)).map_or_else(|| q.clone(), |q| numbers(q.iter().copied())))).collect())
        };
        if let Some(from) = c.get("spatialFollowers").filter(|v| v.truthy()).and_then(Value::as_obj) {
            record.set("spatialFollowers", quaternions(from, tweened.spatial_followers.as_ref()));
        }
        if let Some(from) = c.get("joinedSpatialFollowers").filter(|v| v.truthy()).and_then(Value::as_obj) {
            let joined = from.iter().map(|(uid, children)| {
                let typed = uid.parse::<u32>().ok().and_then(|u| tweened.joined_spatial_followers.as_ref()?.get(&u));
                (uid.clone(), children.as_obj().map_or_else(|| children.clone(), |children| quaternions(children, typed)))
            });
            record.set("joinedSpatialFollowers", Value::object(joined.collect()));
        }
        if let Some(from) = c.get("spatialTarget").filter(|v| v.truthy()) {
            let mut spatial = from.as_obj().cloned().unwrap_or_default();
            if let (true, Some(value)) = (truthy(other.get("spatialTarget")), &tweened.spatial_target) {
                spatial.set("depth", Value::Num(value.depth));
                spatial.set("swivel", Value::Num(value.swivel));
                spatial.set("pole", numbers(value.pole));
                if let (true, true, Some(normals)) = (truthy(from.get("normals")), truthy(other.path(&["spatialTarget", "normals"])), &value.normals) {
                    spatial.set("normals", Value::array(normals.iter().map(|v| numbers(*v)).collect()));
                }
            }
            record.set("spatialTarget", Value::object(spatial));
        }
        if let Some(from) = c.get("joinedFollowers").filter(|v| v.truthy()).and_then(Value::as_obj) {
            let joined = from.iter().map(|(uid, children)| {
                let typed = uid.parse::<u32>().ok().and_then(|u| tweened.joined_followers.as_ref()?.get(&u));
                let angles = children.as_obj().map(|children| {
                    Value::object(children.iter().map(|(child, angle)| (child.clone(), child.parse::<u32>().ok().and_then(|h| typed?.get(&h)).map_or_else(|| angle.clone(), |a| Value::Num(*a)))).collect())
                });
                (uid.clone(), angles.unwrap_or_else(|| children.clone()))
            });
            record.set("joinedFollowers", Value::object(joined.collect()));
        }
        if let Some(from) = c.get("bendReference").filter(|v| v.truthy()) {
            let mut reference = from.as_obj().cloned().unwrap_or_default();
            let length = |v: Option<&Value>| v.and_then(|r| r.get("shape")).and_then(Value::array_len).unwrap_or(0);
            if length(Some(from)) > 0
                && length(Some(from)) == length(other.get("bendReference"))
                && let Some(shape) = tweened.bend_reference.as_ref().and_then(|r| r.shape.as_ref())
            {
                reference.set("shape", numbers(shape.iter().copied()));
            }
            record.set("bendReference", Value::object(reference));
        }
        out.set(id, Value::object(record));
    }
    Value::object(out)
}

/// `snapshotPoseFrame(frame)` for every figure of the frame.
pub fn snapshot_pose_frame(frame: &Value) -> Value {
    snapshot_pose_frame_of(frame, None)
}

/// `snapshotPoseFrame(frame, uids)`: the frame with the figures `uids` name and the
/// figures they are joined to (every figure without `uids`), slots renumbered, without
/// the runtime caches and clock fields.
pub fn snapshot_pose_frame_of(frame: &Value, uids: Option<&[f64]>) -> Value {
    let all = items(frame.get("objects"));
    let slots: Vec<usize> = match uids {
        None => (0..all.len()).collect(),
        Some(uids) => {
            let by_uid: HashMap<u64, usize> = all.iter().enumerate().filter_map(|(slot, o)| Some((uid(o)?.to_bits(), slot))).collect();
            let mut wanted = vec![false; all.len()];
            let mut queue = Vec::new();
            for id in uids {
                if let Some(&slot) = by_uid.get(&id.to_bits()).filter(|&&slot| !wanted[slot]) {
                    wanted[slot] = true;
                    queue.push(slot);
                }
            }
            let mut q = 0;
            while q < queue.len() {
                let parent = all[queue[q]].get("join").filter(|j| j.truthy()).and_then(|j| num(j, "target_object_slot"));
                if let Some(parent) = parent.filter(|p| *p >= 0.0).map(|p| p as usize).filter(|&p| p < all.len() && !wanted[p]) {
                    wanted[parent] = true;
                    queue.push(parent);
                }
                q += 1;
            }
            (0..all.len()).filter(|&slot| wanted[slot]).collect()
        }
    };
    let remap: HashMap<usize, usize> = slots.iter().enumerate().map(|(index, &slot)| (slot, index)).collect();
    let objects: Vec<Value> = slots
        .iter()
        .enumerate()
        .map(|(index, &slot)| {
            let mut out = all[slot].as_obj().cloned().unwrap_or_default();
            out.remove("runtime_segments");
            out.remove("_movieclipSample");
            out.set("object_slot", Value::Num(index as f64));
            if let Some(join) = out.get("join").filter(|j| j.truthy()).cloned() {
                let mut join = join.as_obj().cloned().unwrap_or_default();
                match num(&Value::object(join.clone()), "target_object_slot").filter(|s| *s >= 0.0).and_then(|s| remap.get(&(s as usize))) {
                    Some(&target) => join.set("target_object_slot", Value::Num(target as f64)),
                    None => {
                        join.remove("target_object_slot");
                    }
                }
                out.set("join", Value::object(join));
            }
            Value::object(out)
        })
        .collect();
    let order: Vec<usize> = match frame.get("object_draw_order").filter(|o| !o.is_null()) {
        Some(order) => order.numbers().unwrap_or_default().into_iter().filter_map(|s| remap.get(&(s as usize)).copied()).collect(),
        None => (0..slots.len()).collect(),
    };
    let ids: Vec<Value> = order.iter().map(|&slot| objects[slot].get("unique_id").cloned().unwrap_or(Value::Null)).collect();
    let count = objects.len();
    let mut saved = frame.as_obj().cloned().unwrap_or_default();
    for key in ["_cameraMotionTick", "_vfxTimelineTick", "_vfxTimelineScene"] {
        saved.remove(key);
    }
    saved.set("objects", Value::array(objects));
    saved.set("object_count", Value::Num(count as f64));
    saved.set("object_draw_order", numbers(order.iter().map(|&s| s as f64)));
    saved.set("object_draw_order_unique_ids", Value::array(ids));
    Value::object(saved)
}


#[cfg(test)]
mod source_time_tests {
    use super::*;

    fn fixture() -> Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/channels/channels-figure.sheet.json");
        styk_doc::json::parse(&std::fs::read(path).unwrap()).unwrap()
    }

    fn measured(run: impl FnOnce() -> Value) -> (Value, Vec<u64>) {
        NATIVE_SAMPLE_TIMES.with(|times| *times.borrow_mut() = Some(Vec::new()));
        let frame = run();
        let times = NATIVE_SAMPLE_TIMES.with(|times| times.borrow_mut().take().unwrap());
        (frame, times)
    }

    fn compare(tree: &Value, tick: f64, expected_times: &[f64], old_count: usize) {
        let before = styk_doc::json::to_string(tree);
        let prepared = crate::prepare(crate::from_value(tree, "").unwrap());
        let records = Records::new(tree, &prepared).unwrap();
        let sheet = tree.path(&["_styk", "layerSheet"]).unwrap();
        // The same original sampling/math owner with no sourceAt reuse.
        let (reference, old_times) = measured(|| records.sample_sheet_with(sheet, tick, false,
            &|time| records.native_at(time)).unwrap());
        assert_eq!(old_times.len(), old_count);
        let (actual, times) = measured(|| records.sample_sheet(sheet, tick, false).unwrap());
        let expected: Vec<_> = expected_times.iter().map(|time| time.to_bits()).collect();
        assert_eq!(times, expected, "each distinct imported time must compose once");
        assert_eq!(styk_doc::json::to_string(&actual), styk_doc::json::to_string(&reference));
        // Reusing this Records object starts another fresh per-call lookup.
        let (again, times) = measured(|| records.sample_sheet(sheet, tick, false).unwrap());
        assert_eq!(times, expected);
        assert_eq!(styk_doc::json::to_string(&again), styk_doc::json::to_string(&reference));
        assert_eq!(styk_doc::json::to_string(tree), before);
    }

    #[test]
    fn imported_sheet_composes_each_source_time_once() {
        let tree = fixture();
        compare(&tree, 5.5, &[5.5], 3);
        let mut distinct = tree.clone();
        let keys = distinct.make_obj().unwrap().get_mut("_styk").unwrap().make_obj().unwrap()
            .get_mut("layerSheet").unwrap().make_obj().unwrap().get_mut("tracks").unwrap().make_obj().unwrap()
            .get_mut("camera").unwrap().make_obj().unwrap().get_mut("keys").unwrap().make_arr().unwrap();
        for key in keys {
            let key = key.make_obj().unwrap();
            let time = key.get("sourceTick").unwrap().as_f64().unwrap();
            key.set("sourceTick", Value::Num(time + 0.25));
        }
        compare(&distinct, 5.5, &[5.5, 5.75], 3);
    }

    #[test]
    fn mixed_imported_endpoints_share_the_same_source_lookup() {
        let mut tree = fixture();
        let key = tree.make_obj().unwrap().get_mut("_styk").unwrap().make_obj().unwrap()
            .get_mut("layerSheet").unwrap().make_obj().unwrap().get_mut("tracks").unwrap().make_obj().unwrap()
            .get_mut("layer-1").unwrap().make_obj().unwrap().get_mut("keys").unwrap().make_arr().unwrap()[1]
            .make_obj().unwrap();
        key.remove("sourceTick");
        let mut value = Obj::new(); value.set("frameId", Value::str("frame-3"));
        key.set("value", Value::object(value));
        compare(&tree, 0.0, &[0.0], 3);
        compare(&tree, 1.5, &[1.5, 0.0], 3);
        compare(&tree, 4.0, &[4.0, 5.0], 3);
    }

    #[test]
    fn source_lookup_keeps_first_time_same_value_zero_and_failed_reads() {
        let samples = std::cell::RefCell::new(HashMap::new());
        let read = |time: f64| {
            let mut frame = Obj::new();
            frame.set("firstTimeBits", Value::str(&format!("{:016x}", time.to_bits())));
            frame.set("unknown", Value::array(vec![Value::Num(7.0), Value::Null]));
            Ok(Value::object(frame))
        };
        let first = source_at(&samples, -0.0, read).unwrap();
        let zero = source_at(&samples, 0.0, |_| panic!("signed zero must share the first sample")).unwrap();
        assert!(first.same_node(&zero));
        assert_eq!(zero.get("firstTimeBits").unwrap().as_str(), Some("8000000000000000"));
        // Raw private key semantics only: nonfinite sourceTick is not admitted by
        // the validated document boundary. Different NaN payloads share a Map key.
        let nan = f64::from_bits(0xfff8_0000_0000_0123);
        let first_nan = source_at(&samples, nan, read).unwrap();
        let other_nan = source_at(&samples, f64::from_bits(0x7ff8_0000_0000_0456), |_| panic!("NaNs share a key")).unwrap();
        assert!(first_nan.same_node(&other_nan));
        assert_eq!(other_nan.get("firstTimeBits").unwrap().as_str(), Some("fff8000000000123"));
        let failed = source_at(&samples, 1.25, |_| Err(Error::Invalid("original failure".into())));
        assert!(matches!(failed, Err(Error::Invalid(message)) if message == "original failure"));
        assert_eq!(samples.borrow().len(), 2);
        let recovered = source_at(&samples, 1.25, read).unwrap();
        assert_eq!(recovered.get("firstTimeBits").unwrap().as_str(), Some("3ff4000000000000"));
        assert_eq!(samples.borrow().len(), 3);
        let adjacent = source_at(&samples, f64::from_bits(1.25f64.to_bits() + 1), read).unwrap();
        assert!(!recovered.same_node(&adjacent));
        assert_eq!(samples.borrow().len(), 4);
    }
}
