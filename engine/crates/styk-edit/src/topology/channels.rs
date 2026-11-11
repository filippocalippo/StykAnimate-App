//! Saved property channels that animate a segment whose handle a topology edit removes, replaces or
//! restyles (`repairStyles`, on the channels of a layer sheet's
//! imported animation).
//!
//! An animated segment stays the same physical segment: its channels follow the handle it now has,
//! are copied to each piece it was split into (their keys with fresh identities), switch endpoints
//! or reverse the fill when the gradient was reversed, and, where several figure definitions share
//! the animated figure, are split by definition.

use std::collections::{HashMap, HashSet};

use styk_doc::{Obj, Value};

use super::{FramePoses, format_number, frame_at, items, key_of, places};
use crate::EditError;
use crate::record::uid;

fn invalid(key: &str) -> EditError {
    EditError::Invalid(key.into())
}

/// What the edit did to the handles of the figure whose channels are repaired.
pub(super) struct Edit<'a> {
    /// The figure definition's identity.
    pub type_id: &'a Value,
    /// Each old handle's replacements (an empty list removes it).
    pub changes: &'a [(f64, Vec<f64>)],
    pub reversed: &'a HashSet<u64>,
    /// The definition before the edit, and the poses of its instances.
    pub before_figure: &'a Value,
    pub before_frames: &'a [FramePoses],
}

fn reverse_property(property: &str) -> &str {
    match property {
        "opacity" => "gradientOpacity",
        "gradientOpacity" => "opacity",
        "color" => "gradientColor",
        "gradientColor" => "color",
        other => other,
    }
}

/// `reversePaint(paint)`: a gradient turned half way round.
fn reverse_paint(paint: &Value) -> Value {
    if paint.get("type").and_then(Value::as_str) == Some("solid") {
        return paint.clone();
    }
    let mut next = paint.as_obj().cloned().unwrap_or_default();
    let angle = paint.get("angle").and_then(Value::as_f64).unwrap_or(f64::NAN);
    next.set("angle", Value::Num((((angle - 180.0) % 360.0 + 540.0) % 360.0) - 180.0));
    Value::object(next)
}

fn number(value: Option<&Value>) -> f64 {
    value.and_then(Value::as_f64).unwrap_or(f64::NAN)
}

/// The channels `animation` holds, repaired for `edit`: the animation to store, or `None` when no
/// channel animates a changed segment.
pub(super) fn repair(report: &Value, animation: &Value, edit: &Edit) -> Result<Option<Value>, EditError> {
    let channels = items(animation.get("channels"));
    let uids: HashSet<u32> = edit.before_frames.iter().flat_map(|entry| entry.objects.iter()).filter(|o| o.get("figure_type_id") == Some(edit.type_id)).filter_map(uid).collect();
    let changed = |handle: f64| edit.changes.iter().find(|(old, _)| *old == handle).map(|(_, next)| next);
    let affected: Vec<bool> = channels
        .iter()
        .map(|channel| {
            let Some(target) = channel.get("target") else { return false };
            target.get("kind").and_then(Value::as_str) == Some("segment")
                && target.get("uid").and_then(Value::as_f64).is_some_and(|u| uids.contains(&(u as u32)))
                && changed(number(target.get("handleId"))).is_some()
                && target.get("figureTypeId").is_none_or(|scope| scope == edit.type_id)
        })
        .collect();
    if !affected.iter().any(|a| *a) {
        return Ok(None);
    }
    let is_affected = |at: usize| affected[at];
    let uid_text = |target: &Value| format_number(number(target.get("uid")));
    // The fills a channel or an instance overrides decide whether a reversed gradient swaps its endpoints.
    let mut paint_owners: HashSet<String> = HashSet::new();
    for (channel, _) in channels.iter().zip(&affected).filter(|(_, a)| **a) {
        if channel.get("property").and_then(Value::as_str) == Some("paint") && channel.get("keys").and_then(Value::array_len).unwrap_or(0) > 0 {
            let target = channel.get("target").cloned().unwrap_or(Value::Null);
            paint_owners.insert(format!("{}:{}", uid_text(&target), format_number(number(target.get("handleId")))));
        }
    }
    for entry in edit.before_frames {
        for object in entry.objects.iter().filter(|o| o.get("figure_type_id") == Some(edit.type_id)) {
            for (handle, style) in object.path(&["_stykStyle", "segments"]).and_then(Value::as_obj).into_iter().flat_map(|table| table.iter()) {
                if style.get("paint").is_some_and(Value::truthy) {
                    paint_owners.insert(format!("{}:{handle}", format_number(number(object.get("unique_id")))));
                }
            }
        }
    }
    let native_swaps: HashSet<u64> = items(edit.before_figure.get("segments"))
        .iter()
        .filter(|segment| segment.get("secondary").is_some_and(Value::truthy) && !matches!(segment.path(&["paint", "type"]).and_then(Value::as_str), Some("radial" | "angular" | "diamond")))
        .filter_map(|segment| segment.get("segment_id").and_then(Value::as_f64))
        .map(key_of)
        .collect();
    let swaps_endpoints = |uid: &str, handle: f64| native_swaps.contains(&key_of(handle)) && !paint_owners.contains(&format!("{uid}:{}", format_number(handle)));
    // A track of a figure whatever its definition may be shared by several definitions.
    let keyed: HashSet<u32> = channels
        .iter()
        .zip(&affected)
        .filter(|(channel, a)| **a && channel.path(&["target", "figureTypeId"]).is_none())
        .filter_map(|(channel, _)| channel.path(&["target", "uid"]).and_then(Value::as_f64).map(|u| u as u32))
        .collect();
    let mut scopes: HashMap<u32, Vec<f64>> = HashMap::new();
    if !keyed.is_empty() {
        for place in places(report) {
            for object in items(frame_at(report, &place).and_then(|f| f.get("objects"))) {
                if let Some(u) = uid(&object).filter(|u| keyed.contains(u)) {
                    let types = scopes.entry(u).or_default();
                    let id = number(object.get("figure_type_id"));
                    if !types.contains(&id) {
                        types.push(id);
                    }
                }
            }
        }
    }
    let own_type = number(Some(edit.type_id));
    let mut next_key = animation.get("nextKeyId").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Num(1.0));
    let mut used: Option<HashSet<String>> = None;
    let mut fresh_key = || -> Result<String, EditError> {
        let used = used.get_or_insert_with(|| channels.iter().flat_map(|channel| items(channel.get("keys"))).filter_map(|key| key.get("id").and_then(Value::as_str).map(str::to_string)).collect());
        loop {
            let n = next_key.as_f64().filter(|n| n.fract() == 0.0 && *n >= 1.0 && *n <= 9007199254740991.0);
            let Some(n) = n else { return Err(invalid("errors.cameraBakeAuthored.animationKeyIdentityCapacityExceeded")) };
            next_key = Value::Num(n + 1.0);
            let id = format!("key-{}", format_number(n));
            if used.insert(id.clone()) {
                return Ok(id);
            }
        }
    };
    let mut after_channels: Vec<Value> = Vec::new();
    let mut emitted: HashMap<String, (usize, bool)> = HashMap::new();
    let mut emit = |value: Value, specific: bool| -> Result<(), EditError> {
        let id = value.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        if let Some(&(index, old_specific)) = emitted.get(&id) {
            if old_specific && !specific {
                return Ok(());
            }
            if old_specific == specific {
                return Err(invalid("errors.editorStyleTopology.physicalSegmentMappingConflictsWithAnotherAnimatedSegment"));
            }
            after_channels[index] = value;
            emitted.insert(id, (index, specific));
            return Ok(());
        }
        emitted.insert(id, (after_channels.len(), specific));
        after_channels.push(value);
        Ok(())
    };
    let by_id: HashMap<String, usize> = channels.iter().enumerate().map(|(at, channel)| (channel.get("id").and_then(Value::as_str).unwrap_or("").to_string(), at)).collect();
    for (at, channel) in channels.iter().enumerate() {
        let specific = channel.path(&["target", "figureTypeId"]).is_some();
        if !is_affected(at) {
            emit(channel.clone(), specific)?;
            continue;
        }
        let target = channel.get("target").and_then(Value::as_obj).cloned().unwrap_or_default();
        let handle = number(target.get("handleId"));
        let replacements = changed(handle).cloned().unwrap_or_default();
        let reversed = edit.reversed.contains(&key_of(handle));
        let uid_key = format_number(number(target.get("uid")));
        let property = channel.get("property").and_then(Value::as_str).unwrap_or("").to_string();
        let moved = if reversed && swaps_endpoints(&uid_key, handle) { reverse_property(&property).to_string() } else { property.clone() };
        let types = target.get("uid").and_then(Value::as_f64).and_then(|u| scopes.get(&(u as u32)));
        let split = !specific && types.is_some_and(|types| types.len() > 1);
        struct Mapped {
            target: Obj,
            property: String,
            reverse_paint: bool,
            copied: bool,
        }
        let mut mapped: Vec<Mapped> = Vec::new();
        for (index, &replacement) in replacements.iter().enumerate() {
            let mut next = target.clone();
            next.set("handleId", Value::Num(replacement));
            if split {
                next.set("figureTypeId", edit.type_id.clone());
            }
            mapped.push(Mapped { target: next, property: moved.clone(), reverse_paint: reversed && property == "paint", copied: (replacement != handle && replacements.contains(&handle)) || index > 0 });
        }
        if split {
            for &other in types.into_iter().flatten().filter(|other| **other != own_type) {
                let mut next = target.clone();
                next.set("figureTypeId", Value::Num(other));
                let copied = !mapped.is_empty();
                mapped.push(Mapped { target: next, property: property.clone(), reverse_paint: false, copied });
            }
        }
        for result in mapped {
            let target_value = Value::object(result.target);
            let id = crate::property_edit::channel_id(&target_value, &result.property)?;
            // A more specific authored curve already owns this unaffected rig: the legacy fallback must not replace it.
            if by_id.get(&id).is_some_and(|&existing| existing != at && !is_affected(existing)) {
                continue;
            }
            if channel.get("id").and_then(Value::as_str) == Some(id.as_str()) && !result.reverse_paint {
                emit(channel.clone(), specific)?;
                continue;
            }
            let keys = if result.copied || result.reverse_paint {
                let mut keys = Vec::new();
                for key in items(channel.get("keys")) {
                    let mut next = key.as_obj().cloned().unwrap_or_default();
                    if result.copied {
                        next.set("id", Value::str(&fresh_key()?));
                    }
                    if result.reverse_paint {
                        next.set("value", reverse_paint(key.get("value").unwrap_or(&Value::Null)));
                    }
                    keys.push(Value::object(next));
                }
                Value::array(keys)
            } else {
                channel.get("keys").cloned().unwrap_or(Value::Null)
            };
            let mut next = channel.as_obj().cloned().unwrap_or_default();
            next.set("target", target_value.clone());
            next.set("property", Value::str(&result.property));
            next.set("id", Value::str(&id));
            next.set("keys", keys);
            emit(Value::object(next), specific)?;
        }
    }
    let mut after = animation.as_obj().cloned().unwrap_or_default();
    after.set("nextKeyId", next_key);
    after.set("channels", Value::array(after_channels));
    let after = Value::object(after);
    // `validateAnimationDocument`: the repaired table must still be a valid one.
    let mut checked = report.clone();
    if let Some(styk) = checked.make_obj().and_then(|r| r.get_mut("_styk")).and_then(Value::make_obj) {
        styk.set("animation", after.clone());
    }
    crate::load::validate_animation(&checked)?;
    Ok(Some(after))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::topology::Place;

    fn parse(text: &str) -> Value {
        styk_doc::json::parse(text.as_bytes()).unwrap()
    }

    fn report(channels: &str) -> (Value, Value) {
        let animation = parse(&format!(r#"{{"version":1,"nextKeyId":3,"channels":{channels}}}"#));
        let mut report = parse(r#"{"figure_types":[{"figure_type_id":1,"segments":[]}]}"#);
        report.make_obj().unwrap().set("_styk", parse(r#"{}"#));
        report.make_obj().unwrap().get_mut("_styk").unwrap().make_obj().unwrap().set("animation", animation.clone());
        (report, animation)
    }

    const OPACITY: &str = r#"[{"id":"segment:1%2F5:opacity","target":{"kind":"segment","uid":1,"handleId":5},"property":"opacity","keys":[{"id":"key-1","tick":0,"value":1},{"id":"key-2","tick":10,"value":0.5}]}]"#;

    fn run(animation: &Value, report: &Value, changes: &[(f64, Vec<f64>)], reversed: &[f64], figure: &Value) -> Option<Value> {
        let type_id = Value::Num(1.0);
        let before = [FramePoses { place: Place::Keyframe(0), objects: vec![parse(r#"{"unique_id":1,"figure_type_id":1}"#)] }];
        let reversed = reversed.iter().map(|h| key_of(*h)).collect();
        repair(report, animation, &Edit { type_id: &type_id, changes, reversed: &reversed, before_figure: figure, before_frames: &before }).unwrap()
    }

    fn ids(animation: &Value) -> Vec<String> {
        items(animation.get("channels")).iter().map(|c| c.get("id").and_then(Value::as_str).unwrap().to_string()).collect()
    }

    #[test]
    fn a_split_copies_the_animation_to_the_new_piece_with_keys_of_its_own() {
        let (report, animation) = report(OPACITY);
        let after = run(&animation, &report, &[(5.0, vec![5.0, 11.0])], &[], &Value::Null).unwrap();
        assert_eq!(ids(&after), ["segment:1%2F5:opacity", "segment:1%2F11:opacity"]);
        let piece = after.get("channels").unwrap().item(1).unwrap();
        let keys: Vec<String> = items(piece.get("keys")).iter().map(|k| k.get("id").and_then(Value::as_str).unwrap().to_string()).collect();
        assert_eq!(keys, ["key-3", "key-4"]);
        assert_eq!(after.get("nextKeyId").and_then(Value::as_f64), Some(5.0));
        assert_eq!(piece.path(&["target", "handleId"]).and_then(Value::as_f64), Some(11.0));
        assert_eq!(items(after.get("channels").and_then(|c| c.item(0)).unwrap().get("keys")).len(), 2, "the original keeps its own keys");
    }

    #[test]
    fn a_deleted_segment_takes_its_animation_with_it() {
        let (report, animation) = report(OPACITY);
        let after = run(&animation, &report, &[(5.0, Vec::new())], &[], &Value::Null).unwrap();
        assert!(ids(&after).is_empty());
        assert_eq!(after.get("nextKeyId").and_then(Value::as_f64), Some(3.0));
    }

    #[test]
    fn a_reversed_gradient_swaps_the_endpoints_the_animation_names() {
        let (report, animation) = report(OPACITY);
        let figure = parse(r#"{"segments":[{"segment_id":5,"secondary":{"rgb":[0,0,0],"a":0}}]}"#);
        let after = run(&animation, &report, &[(5.0, vec![5.0])], &[5.0], &figure).unwrap();
        assert_eq!(ids(&after), ["segment:1%2F5:gradientOpacity"]);
        let keys: Vec<String> = items(after.get("channels").and_then(|c| c.item(0)).unwrap().get("keys")).iter().map(|k| k.get("id").and_then(Value::as_str).unwrap().to_string()).collect();
        assert_eq!(keys, ["key-1", "key-2"], "an endpoint swap is not a copy");
    }

    #[test]
    fn channels_of_other_segments_are_left_as_they_are() {
        let (report, animation) = report(OPACITY);
        assert!(run(&animation, &report, &[(9.0, Vec::new())], &[], &Value::Null).is_none());
    }
}
