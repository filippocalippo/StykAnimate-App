//! Read-only in-between planning: `planInsertInbetweenSteps` (src/editor-inbetween.mjs) and
//! the wire `inbetweenPlanWire` (src/editor-inbetween-async.mjs) sends the editor, byte for byte.
//!
//! The plan names the poses to insert before each chosen native key (sampled with forced
//! linear interpolation, `Records::native_interval` on the document's `inbetween_view`),
//! and for a document with authored channels the retained pose sources, the channels' keys
//! moved by the inserted exposure and the keys the insertions add. Nothing is published:
//! the editor stages the plan and records it as one `ranges` command.
//!
//! What it does not plan answers [`EditError::Unported`] and the host plans in JavaScript:
//! a layer sheet, and authored poses of a document with camera-motion or effect clips (their
//! runtime clock fields travel inside the captured frames).

use crate::{
    EditError,
    sheet::{items, num},
};
use std::collections::HashSet;
use styk_doc::{Obj, Value};
use styk_eval::{
    eval::{Prepared, preview::background_pair},
    records::{self, Records},
};

/// `INBETWEEN_LIMITS`.
const INSERTED_FRAMES: usize = 10_000;
const OBJECT_POSES: usize = 250_000;
const SEGMENT_VALUES: usize = 3_000_000;
const MAX_KEYFRAMES: usize = 100_000;
const MAX_KEYS: usize = 1_000_000;
const MAX_TICK: f64 = 10_000_000.0;
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

const RATIO: &str = "errors.editorInbetweenAsync.chooseAnInterpolationRatioFromZeroToOne";
const SOURCES: &str = "errors.editorInbetween.chooseExistingSourceFrames";
const TOO_MANY: &str = "errors.editorInbetween.insertAtMost10000InbetweensAtOnce";
const BACKGROUNDS: &str = "errors.editorInbetween.thisInbetweenNeedsMoreThanTwoBackgroundImages";
const BUDGET: &str = "errors.editorInbetween.insertFewerInbetweensAtOnceACommandSupports";
const KEY_LIMIT: &str = "errors.editorInbetween.insertFewerInbetweensToStayWithinTheOne";
const SHIFT: &str = "errors.editorInbetween.insertingHereWouldMoveAnAuthoredKeyBeyond";
const AUTHORED_TICK: &str = "errors.editorInbetween.theInsertedAuthoredPoseWouldExceedFrame10";
const FRAME_IDENTITY: &str = "errors.clipboardLegacyUpgrade.frameIdentityCapacityExceeded";
const KEY_IDENTITY: &str = "errors.cameraBakeAuthored.animationKeyIdentityCapacityExceeded";

/// What the editor asks for: a ratio, the chosen native keys (existing, ascending, once
/// each) and the editor's next pose-source identity.
pub struct Request<'a> {
    pub ratio: f64,
    pub indices: &'a [usize],
    pub next_frame_identity: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Progress {
    pub phase: &'static str,
    pub completed: usize,
    pub total: usize,
}

fn invalid(key: &str) -> EditError {
    EditError::Invalid(key.into())
}
fn evaluation(error: records::Error) -> EditError {
    match error {
        records::Error::Unported(what) => EditError::Unported(what),
        records::Error::Invalid(message) => EditError::Invalid(message),
    }
}
fn safe_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && value.abs() <= MAX_SAFE
}

/// `identityPlan`: `frame-N` identities from the editor's counter.
struct Identities(u64);
impl Identities {
    fn take(&mut self) -> Result<String, EditError> {
        if self.0 < 1 || self.0 as f64 + 1.0 > MAX_SAFE {
            return Err(invalid(FRAME_IDENTITY));
        }
        self.0 += 1;
        Ok(format!("frame-{}", self.0 - 1))
    }
}

/// `allocationBudget`: figure poses and segment values the plan captures.
#[derive(Default)]
struct Budget {
    objects: usize,
    values: usize,
}
impl Budget {
    fn add(&mut self, frame: &Value) -> Result<(), EditError> {
        for object in frame.get("objects").and_then(Value::elements).into_iter().flat_map(|objects| objects.iter()) {
            self.objects += 1;
            for field in ["angles", "lengths", "bends"] {
                self.values += object.get(field).and_then(Value::array_len).unwrap_or(0);
            }
        }
        if self.objects > OBJECT_POSES || self.values > SEGMENT_VALUES {
            return Err(invalid(BUDGET));
        }
        Ok(())
    }
}

/// `cleanFrame`: a captured copy of a sampled frame, without runtime segments, with its
/// exposure and its new pose-source identity.
fn clean_frame(frame: &Value, id: &str, duration: f64) -> Value {
    let mut result = frame.as_obj().cloned().unwrap_or_default();
    let objects = frame
        .get("objects")
        .and_then(Value::elements)
        .into_iter()
        .flat_map(|objects| objects.iter())
        .map(|mut object| {
            if let Some(record) = object.make_obj() {
                record.remove("runtime_segments");
            }
            object
        })
        .collect();
    result.set("objects", Value::array(objects));
    result.set("duration_raw", Value::Num(duration));
    let mut styk = frame.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
    styk.set("frameId", Value::str(id));
    result.set("_styk", Value::object(styk));
    Value::object(result)
}

/// One inserted pose, with what the authored channels need of it.
struct Entry {
    index: usize,
    inserted_index: usize,
    original_tick: f64,
    tick: f64,
    source_index: usize,
    sample_ratio: f64,
    duration: f64,
    cumulative_duration: f64,
    source_tick: f64,
    frame: Value,
    /// The retained pose source of the authored channels' pose keys.
    source_id: Option<String>,
    /// The pose the authored channels sample (`entry.pose`).
    pose: Option<Value>,
}

fn entry_value(entry: &Entry, ratio: f64) -> Value {
    let mut record = Obj::new();
    for (key, value) in [
        ("index", entry.index as f64),
        ("insertedIndex", entry.inserted_index as f64),
        ("originalTick", entry.original_tick),
        ("tick", entry.tick),
        ("ratio", ratio),
        ("sourceIndex", entry.source_index as f64),
        ("sampleRatio", entry.sample_ratio),
        ("duration", entry.duration),
        ("cumulativeDuration", entry.cumulative_duration),
        ("sourceTick", entry.source_tick),
    ] {
        record.set(key, Value::Num(value));
    }
    record.set("frame", entry.frame.clone());
    if let Some(id) = &entry.source_id {
        record.set("sourceId", Value::str(id));
    }
    Value::object(record)
}

/// `shiftedTick`: where an authored key goes once the insertions before it are made.
fn shifted_tick(tick: f64, entries: &[Entry]) -> Result<f64, EditError> {
    let before = entries.partition_point(|entry| entry.original_tick <= tick);
    let shifted = tick + before.checked_sub(1).map_or(0.0, |last| entries[last].cumulative_duration);
    if !safe_integer(shifted) || shifted > MAX_TICK {
        return Err(invalid(SHIFT));
    }
    Ok(shifted)
}

/// `keyEasing(keyAt(channel, tick))`: the interpolation a new key continues from the last
/// key at or before `tick`.
fn key_easing(keys: &[Value], tick: f64) -> Vec<(&'static str, Value)> {
    let mut at = None;
    for key in keys {
        if num(key, "tick").is_some_and(|key_tick| key_tick > tick) {
            break;
        }
        at = Some(key);
    }
    let interpolation = match at.and_then(|key| key.get("interpolation")).filter(|value| !value.is_null()) {
        Some(value) if value.as_str() == Some("hold") => "constant",
        Some(value) => value.as_str().unwrap_or("linear"),
        None => "linear",
    };
    let mut fields = vec![("interpolation", Value::str(interpolation))];
    if interpolation == "bezier" {
        let bezier = at.and_then(|key| key.get("bezier")).filter(|value| !value.is_null()).cloned();
        fields.push(("bezier", bezier.unwrap_or_else(|| Value::nums(&[0.42, 0.0, 0.58, 1.0]))));
    }
    fields
}

/// The tree with the property channels replaced (`poseReport`).
fn with_channels(tree: &Value, channels: Vec<Value>) -> Result<Value, EditError> {
    let mut tree = tree.clone();
    tree.make_obj()
        .and_then(|document| document.get_mut("_styk"))
        .and_then(Value::make_obj)
        .and_then(|styk| styk.get_mut("animation"))
        .and_then(Value::make_obj)
        .ok_or_else(|| invalid("errors.animationChannels.invalidAnimationMetadata"))?
        .set("channels", Value::array(channels));
    Ok(tree)
}

/// The authored channels' share of the plan (`planAnimation`).
struct Animation {
    updates: Vec<Value>,
    order: Vec<Value>,
    next_key_id: f64,
    sources: Vec<Value>,
}

fn plan_animation(
    tree: &Value,
    view: &Prepared,
    records: &Records,
    channels: &[Value],
    entries: &mut [Entry],
    identities: &mut Identities,
    budget: &mut Budget,
    check: &mut impl FnMut() -> Result<(), EditError>,
    progress: &mut impl FnMut(Progress),
) -> Result<Animation, EditError> {
    let clips = |name: &str| tree.path(&["_styk", name, "clips"]).and_then(Value::array_len).unwrap_or(0) > 0;
    if clips("cameraMotion") || clips("vfxClips") {
        return Err(EditError::Unported("authored in-betweens of a document with camera-motion or effect clips".into()));
    }
    let property = |channel: &Value| channel.get("property").and_then(Value::as_str).map(str::to_string);
    let pose_channels: Vec<Value> = channels.iter().filter(|channel| property(channel).as_deref() == Some("pose")).cloned().collect();
    let visible = entries.iter().filter(|entry| entry.duration > 0.0).count();
    let maximum: usize = channels
        .iter()
        .map(|channel| channel.get("keys").and_then(Value::array_len).unwrap_or(0) + if property(channel).as_deref() == Some("pose") { entries.len() } else { visible })
        .sum();
    if maximum > MAX_KEYS {
        return Err(invalid(KEY_LIMIT));
    }
    let poses_tree = with_channels(tree, pose_channels.clone())?;
    let poses = Records::new(&poses_tree, view).map_err(evaluation)?;
    let mut sources = Vec::new();
    let total = entries.len();
    for (done, entry) in entries.iter_mut().enumerate() {
        check()?;
        // Scalar channels are sampled separately: only the pose channels compose here.
        let pose = poses.evaluated_interval(entry.source_index, entry.sample_ratio, entry.source_tick).map_err(evaluation)?;
        if !pose_channels.is_empty() {
            if !view.scene_transition_fits(entry.source_tick) {
                return Err(invalid(BACKGROUNDS));
            }
            budget.add(&pose)?;
            let id = identities.take()?;
            sources.push(clean_frame(&pose, &id, entry.duration));
            entry.source_id = Some(id);
        }
        entry.pose = Some(pose);
        progress(Progress { phase: "sampling animation", completed: done + 1, total });
    }
    let mut next_key_id = tree.path(&["_styk", "animation"]).and_then(|animation| num(animation, "nextKeyId")).unwrap_or(1.0);
    let mut updates = Vec::new();
    let mut order = Vec::new();
    let total = channels.len();
    for (done, channel) in channels.iter().enumerate() {
        check()?;
        let name = property(channel).unwrap_or_default();
        let keys = items(channel.get("keys"));
        // Each key with the place it had when the insertion leaves it untouched, and whether
        // the insertion made it: an unchanged channel keeps its record.
        let mut after: Vec<(Value, Option<usize>, bool)> = Vec::with_capacity(keys.len() + entries.len());
        for (visited, key) in keys.iter().enumerate() {
            let tick = num(key, "tick").unwrap_or(f64::NAN);
            let shifted = shifted_tick(tick, entries)?;
            if shifted == tick {
                after.push((key.clone(), Some(visited), false));
            } else {
                let mut moved = key.clone();
                if let Some(record) = moved.make_obj() {
                    record.set("tick", Value::Num(shifted));
                }
                after.push((moved, None, false));
            }
            if (visited + 1) % 256 == 0 {
                check()?;
                progress(Progress { phase: "animation", completed: done, total });
            }
        }
        let mut used: HashSet<String> = after.iter().filter_map(|(key, _, _)| key.get("id").and_then(Value::as_str).map(str::to_string)).collect();
        let target = channel.get("target").cloned().unwrap_or(Value::Null);
        let scene_color = target.get("kind").and_then(Value::as_str) == Some("scene") && name == "color";
        for entry in entries.iter() {
            let value = if name == "pose" {
                let mut value = Obj::new();
                value.set("frameId", entry.source_id.as_deref().map_or(Value::Null, Value::str));
                Some(Value::object(value))
            } else {
                // Scalar channels have no hidden-key representation: a zero-exposure
                // insertion stays a pose tween target and adds no scalar key.
                if entry.duration == 0.0 {
                    continue;
                }
                let pose = entry.pose.as_ref().expect("every entry was posed");
                match records.sample_channel_value(&target, &name, entry.source_tick).map_err(evaluation)? {
                    Some(value) => Some(value),
                    // A curve may begin after the requested sample: key the pose's own value,
                    // so that the later curve cannot mask it.
                    None if scene_color => Some(pose.get("_stykBackgroundColor").filter(|color| !color.is_null()).cloned().unwrap_or(Value::Null)),
                    None => records.property_value(pose, &target, &name).map_err(evaluation)?,
                }
            };
            // The figure is absent in this pose.
            let Some(value) = value else { continue };
            let id = loop {
                if !safe_integer(next_key_id) || next_key_id < 1.0 || next_key_id + 1.0 > MAX_SAFE {
                    return Err(invalid(KEY_IDENTITY));
                }
                let id = format!("key-{next_key_id}");
                next_key_id += 1.0;
                if !used.contains(&id) {
                    break id;
                }
            };
            used.insert(id.clone());
            let mut key = Obj::new();
            key.set("id", Value::str(&id));
            key.set("tick", Value::Num(entry.tick));
            key.set("value", value);
            for (field, value) in key_easing(&keys, entry.source_tick) {
                key.set(field, value);
            }
            if entry.duration == 0.0 {
                key.set("hidden", Value::Bool(true));
            }
            after.push((Value::object(key), None, true));
        }
        // By tick, a hidden key before a visible one at the same tick, a new key before an old.
        let hidden = |key: &Value| key.get("hidden").is_some_and(Value::truthy);
        after.sort_by(|(a, _, inserted_a), (b, _, inserted_b)| {
            let (a_tick, b_tick) = (num(a, "tick").unwrap_or(f64::NAN), num(b, "tick").unwrap_or(f64::NAN));
            a_tick.partial_cmp(&b_tick).unwrap_or(std::cmp::Ordering::Equal)
                .then(hidden(b).cmp(&hidden(a)))
                .then(inserted_b.cmp(inserted_a))
        });
        let changed = after.len() != keys.len() || after.iter().enumerate().any(|(place, (_, origin, _))| *origin != Some(place));
        let mut channel = channel.clone();
        if changed {
            if let Some(record) = channel.make_obj() {
                record.set("keys", Value::array(after.into_iter().map(|(key, _, _)| key).collect()));
            }
            let mut update = Obj::new();
            update.set("id", channel.get("id").cloned().unwrap_or(Value::Null));
            update.set("channel", channel.clone());
            updates.push(Value::object(update));
        }
        order.push(channel.get("id").cloned().unwrap_or(Value::Null));
        progress(Progress { phase: "animation", completed: done + 1, total });
    }
    Ok(Animation { updates, order, next_key_id, sources })
}

/// `planInsertInbetweenSteps` for the native timeline of `tree` (`prepared` is its typed
/// document), as the payload the editor receives: `{plan}`.
pub fn plan(
    tree: &Value,
    prepared: &Prepared,
    request: &Request,
    mut check: impl FnMut() -> Result<(), EditError>,
    mut progress: impl FnMut(Progress),
) -> Result<Value, EditError> {
    check()?;
    let ratio = request.ratio;
    if !ratio.is_finite() || !(0.0..=1.0).contains(&ratio) {
        return Err(invalid(RATIO));
    }
    if tree.path(&["_styk", "layerSheet"]).is_some() {
        return Err(EditError::Unported("in-between planning on a layer sheet".into()));
    }
    let frames = tree.get("keyframes").cloned().unwrap_or(Value::Null);
    let frame_count = frames.array_len().unwrap_or(0);
    if request.indices.iter().any(|&index| index >= frame_count) {
        return Err(invalid(SOURCES));
    }
    let mut targets = request.indices.to_vec();
    targets.sort_unstable();
    targets.dedup();
    if targets.len() > INSERTED_FRAMES || frame_count + targets.len() > MAX_KEYFRAMES {
        return Err(invalid(TOO_MANY));
    }
    let channels = items(tree.path(&["_styk", "animation", "channels"]));
    let authored = !channels.is_empty();
    let mut identities = Identities(request.next_frame_identity);
    let mut budget = Budget::default();
    // Native Insert Inbetween forces linear interpolation, even when playback uses automatic
    // easing: the sampling view of the document, built once.
    let view = prepared.inbetween_view();
    let records = Records::new(tree, &view).map_err(evaluation)?;
    let starts: Vec<f64> = prepared.rows.iter().map(|row| row.start as f64).collect();
    let keyframes = &prepared.doc.keyframes;
    let duration_of = |index: usize| -> Result<f64, EditError> {
        frames
            .item(index)
            .and_then(|frame| num(&frame, "duration_raw"))
            .ok_or_else(|| EditError::Unported("a keyframe without a duration".into()))
    };
    let mut cumulative = 0.0;
    let mut entries: Vec<Entry> = Vec::with_capacity(targets.len());
    for (ordinal, &index) in targets.iter().enumerate() {
        check()?;
        let original_tick = starts[index];
        let tick = original_tick + cumulative;
        if tick > MAX_TICK && authored {
            return Err(invalid(AUTHORED_TICK));
        }
        let source_index = index.saturating_sub(1);
        let sample_ratio = if index == 0 { 0.0 } else { ratio };
        if index > 0 && !background_pair(&keyframes[index - 1], &keyframes[index], ratio) {
            return Err(invalid(BACKGROUNDS));
        }
        let sampled = records.native_interval(source_index, sample_ratio).map_err(evaluation)?;
        let duration = duration_of(if index == 0 || ratio > 0.0 { index } else { index - 1 })?;
        cumulative += duration;
        budget.add(&sampled)?;
        let id = identities.take()?;
        entries.push(Entry {
            index,
            inserted_index: index + ordinal,
            original_tick,
            tick,
            source_index,
            sample_ratio,
            duration,
            cumulative_duration: cumulative,
            source_tick: starts[source_index] + (original_tick - starts[source_index]) * sample_ratio,
            frame: clean_frame(&sampled, &id, duration),
            source_id: None,
            pose: None,
        });
        progress(Progress { phase: "sampling", completed: ordinal + 1, total: targets.len() });
    }
    let animation = if authored && !entries.is_empty() {
        Some(plan_animation(tree, &view, &records, &channels, &mut entries, &mut identities, &mut budget, &mut check, &mut progress)?)
    } else {
        None
    };
    check()?;
    let mut plan = Obj::new();
    plan.set("version", Value::Num(1.0));
    plan.set("entries", Value::array(entries.iter().map(|entry| entry_value(entry, ratio)).collect()));
    plan.set("skippedIndices", Value::array(Vec::new()));
    plan.set("nextFrameIdentity", Value::Num(identities.0 as f64));
    plan.set(
        "animation",
        match animation {
            Some(animation) => {
                let mut record = Obj::new();
                record.set("channelUpdates", Value::array(animation.updates));
                record.set("channelOrder", Value::array(animation.order));
                record.set("nextKeyId", Value::Num(animation.next_key_id));
                record.set("sources", Value::array(animation.sources));
                Value::object(record)
            }
            None => Value::Null,
        },
    );
    let mut payload = Obj::new();
    payload.set("plan", Value::object(plan));
    Ok(Value::object(payload))
}
