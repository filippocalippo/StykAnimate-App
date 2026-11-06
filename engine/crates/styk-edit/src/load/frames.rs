//! Frame identities, stored pose sequences and the simple timeline's working frame on load
//! (`validateFrameIdentities` of src/editor-frames.mjs, src/pose-sequence-storage.mjs and
//! `validateSimpleFrameDraft` of src/editor-frame-draft.mjs).

use std::collections::HashMap;

use styk_doc::Value;

use super::js::*;
use crate::EditError;

/// The animation records a document may store pose key sequences in: its authored animation and the
/// checkpoint of the simple timeline's working frame.
fn animation_mut(report: &mut Value, which: usize) -> Option<&mut Value> {
    let styk = report.make_obj()?.get_mut("_styk")?.make_obj()?;
    match which {
        0 => styk.get_mut("animation"),
        _ => styk.get_mut("simpleFrameDraft")?.make_obj()?.get_mut("animationBaseline"),
    }
}

fn animation_ref(report: &Value, which: usize) -> V<'_> {
    match which {
        0 => path(Some(report), &["_styk", "animation"]),
        _ => path(Some(report), &["_styk", "simpleFrameDraft", "animationBaseline"]),
    }
}

/// `expandPoseSequencesSteps(report)`: stored sequences (`version: 2`) become ordinary key arrays.
pub(super) fn expand_pose_sequences(report: &mut Value) -> Result<(), EditError> {
    for which in 0..2 {
        let animation = animation_ref(report, which);
        if num(get(animation, "version")) != Some(2.0) {
            continue;
        }
        let (channels, sequences) = (get(animation, "channels"), get(animation, "poseSequences"));
        if !is_array(channels) || len(channels) > 100_000 || !is_array(sequences) || len(sequences) > 100_000 {
            return fail("errors.poseSequenceStorage.invalidStoredPoseSequenceTable");
        }
        let table = items(sequences);
        let mut count = 0usize;
        for keys in &table {
            if !keys.is_array() {
                return fail("errors.poseSequenceStorage.invalidStoredPoseSequenceCapacity");
            }
            count += keys.array_len().unwrap_or(0);
            if count > 1_000_000 {
                return fail("errors.poseSequenceStorage.invalidStoredPoseSequenceCapacity");
            }
        }
        let mut expanded: Vec<Value> = Vec::with_capacity(len(channels));
        for channel in items(channels) {
            if text(get(Some(&channel), "property")) != Some("pose") {
                expanded.push(channel);
                continue;
            }
            let reference = get(Some(&channel), "keys");
            let index = get(reference, "sequence");
            let valid = truthy(reference) && !is_array(reference) && key_count(reference) == 1 && integer_in(index, 0.0, table.len() as f64 - 1.0) && is_record(reference);
            if !valid {
                return fail("errors.poseSequenceStorage.invalidStoredPoseSequenceReference");
            }
            let mut changed = channel.clone();
            changed.make_obj().unwrap().set("keys", table[num(index).unwrap() as usize].clone());
            expanded.push(changed);
        }
        let animation = animation_mut(report, which).unwrap();
        let record = animation.make_obj().unwrap();
        record.set("channels", Value::array(expanded));
        record.set("version", Value::Num(1.0));
        record.remove("poseSequences");
    }
    Ok(())
}

/// Content hash of a value, equal for values that compare equal.
fn hash_value(value: &Value, state: &mut u64) {
    fn mix(state: &mut u64, word: u64) {
        *state = (*state ^ word).wrapping_mul(0x100000001b3);
    }
    match value {
        Value::Null => mix(state, 1),
        Value::Bool(b) => mix(state, 2 + *b as u64),
        Value::Num(n) => {
            mix(state, 4);
            mix(state, if *n == 0.0 { 0 } else { n.to_bits() });
        }
        Value::Str(_) | Value::Blob(_) => {
            mix(state, 5);
            for b in value.text().unwrap().bytes() {
                mix(state, b as u64);
            }
        }
        Value::Arr(_) | Value::Nums(_) => {
            mix(state, 6);
            mix(state, value.array_len().unwrap() as u64);
            for item in value.elements().unwrap().iter() {
                hash_value(&item, state);
            }
        }
        Value::Obj(object) => {
            mix(state, 7);
            mix(state, object.len() as u64);
            for (key, item) in object.iter() {
                for b in key.bytes() {
                    mix(state, b as u64);
                }
                hash_value(item, state);
            }
        }
    }
}

/// `internPoseSequencesSteps(report)`: pose key sequences with the same keys share one array.
pub(super) fn intern_pose_sequences(report: &mut Value) -> Result<(), EditError> {
    let mut known: HashMap<(usize, u64), Vec<Value>> = HashMap::new();
    let mut visited: std::collections::HashSet<usize> = std::collections::HashSet::new();
    let mut replacements: Vec<(usize, usize, Value)> = Vec::new();
    for which in 0..2 {
        let channels = get(animation_ref(report, which), "channels");
        for (index, channel) in items(channels).iter().enumerate() {
            let ch = prop(Some(channel), "property")?;
            let keys = channel.get("keys");
            if text(ch) != Some("pose") || super::animation::node_id(keys).is_some_and(|id| visited.contains(&id)) {
                continue;
            }
            let Some(keys) = keys.filter(|k| k.is_array()) else { return Err(refuse(TYPE_ERROR)) };
            let mut hash = 0xcbf29ce484222325u64;
            hash_value(keys, &mut hash);
            let bucket = known.entry((keys.array_len().unwrap(), hash)).or_default();
            if let Some(same) = bucket.iter().find(|candidate| *candidate == keys) {
                replacements.push((which, index, same.clone()));
                visited.extend(super::animation::node_id(Some(same)));
            } else {
                bucket.push(keys.clone());
                visited.extend(super::animation::node_id(Some(keys)));
            }
        }
    }
    for (which, index, keys) in replacements {
        let Some(animation) = animation_mut(report, which) else { continue };
        let Some(channels) = animation.make_obj().and_then(|a| a.get_mut("channels")) else { continue };
        let Some(list) = channels.make_arr() else { continue };
        if let Some(channel) = list.get_mut(index).and_then(Value::make_obj) {
            channel.set("keys", keys);
        }
    }
    Ok(())
}

/// `validId(id)`: `/^[a-z][a-z0-9-]{0,127}$/`.
fn valid_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    (1..=128).contains(&bytes.len()) && bytes[0].is_ascii_lowercase() && bytes[1..].iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

/// `validateFrameIdentitySteps(report)`: the identities are valid and unique; the number of the next one.
pub(super) fn validate_frame_identity(report: &Value) -> Result<f64, EditError> {
    let sources = path(Some(report), &["_styk", "frameSources"]);
    if !missing(sources) && !is_record(sources) {
        return fail("errors.editorFrames.invalidRetainedFrameSources");
    }
    let mut ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut next = 1.0f64;
    let mut check = |key: Option<&str>, frame: V| -> Result<(), EditError> {
        let id = path(frame, &["_styk", "frameId"]);
        if missing(id) && key.is_none() {
            return Ok(());
        }
        let valid = text(id).is_some_and(|id| valid_id(id) && key.is_none_or(|key| key == id) && !ids.contains(id));
        if !valid {
            return fail("errors.editorFrames.frameSourceIdentitiesMustBeValidAndUnique");
        }
        let id = text(id).unwrap();
        ids.insert(id.to_string());
        if let Some(digits) = id.strip_prefix("frame-").filter(|d| positive_canonical(d)) {
            let number = number_of(digits);
            if number > 9_007_199_254_740_991.0 {
                return fail("errors.clipboardLegacyUpgrade.frameIdentityCapacityExceeded");
            }
            next = next.max(number + 1.0);
        }
        Ok(())
    };
    for frame in items(report.get("keyframes")) {
        check(None, Some(&frame))?;
    }
    for (key, frame) in entries(sources) {
        check(Some(&key), Some(frame))?;
    }
    Ok(next)
}

/// `validateSimpleFrameDraft(report, {validateFrame: false})`: the working frame of the simple timeline.
pub(super) fn validate_simple_frame_draft(report: &Value) -> Result<(), EditError> {
    let state = path(Some(report), &["_styk", "simpleFrameDraft"]);
    if missing(state) {
        return Ok(());
    }
    let keyframes = items(report.get("keyframes"));
    let index = get(state, "index");
    let frame = if integer_in(index, 0.0, f64::INFINITY) { keyframes.get(num(index).unwrap() as usize) } else { None };
    let valid = truthy(state)
        && num(get(state, "version")) == Some(1.0)
        && matches!(text(get(state, "mode")), Some("add" | "update"))
        && frame.is_some()
        && get(state, "frameId") == path(frame, &["_styk", "frameId"]);
    if !valid {
        return fail("errors.editorFrameDraft.invalidSimpleTimelineWorkingFrame");
    }
    let empty = get(state, "empty");
    if (!missing(empty) && !boolean(empty)) || (truthy(empty) && (text(get(state, "mode")) != Some("add") || num(index) != Some(0.0) || keyframes.len() != 1)) {
        return fail("errors.editorFrameDraft.anEmptySimpleAnimationRequiresOneAddWorking");
    }
    let baseline = get(state, "baseline");
    if !missing(baseline) && path(baseline, &["_styk", "frameId"]) != get(state, "frameId") {
        return fail("errors.editorFrameDraft.theWorkingFrameCheckpointHasADifferentIdentity");
    }
    if has_own(state, "animationBaseline") {
        if missing(get(state, "animationBaseline")) {
            return fail("errors.editorFrameDraft.anAnimationCheckpointMustBeAChannelTable");
        }
        if !truthy(baseline) {
            return fail("errors.editorFrameDraft.anAnimationCheckpointRequiresAWorkingFrameBaseline");
        }
    }
    Ok(())
}
