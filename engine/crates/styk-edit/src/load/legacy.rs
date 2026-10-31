//! `normalizeLegacyMovieclips(report, rows, total)` (src/movieclips.mjs): the early movieclip placement
//! descriptors, upgraded once on load. A placement with no end gets one, and a restart that
//! only moved `start` becomes a phase key, without moving the container.

use std::collections::HashMap;

use styk_doc::{Obj, Value};

use super::js::*;
use crate::EditError;

/// `playbackSettings(object)`: the defaults, then the placement's own fields.
fn playback_settings(object: V) -> Obj {
    let mut settings = Obj::new();
    settings.set("start", Value::Num(0.0));
    settings.set("end", Value::Null);
    settings.set("offset", Value::Num(0.0));
    settings.set("speed", Value::Num(1.0));
    settings.set("mode", Value::str("loop"));
    if let Some(own) = get(object, "_stykMovieclip").and_then(Value::as_obj) {
        for (key, value) in own.iter() {
            settings.set(key, value.clone());
        }
    }
    settings
}

fn number(value: Option<&Value>) -> f64 {
    value.and_then(Value::as_f64).unwrap_or(f64::NAN)
}

fn id_key(value: f64) -> u64 {
    if value == 0.0 { 0.0f64.to_bits() } else { value.to_bits() }
}

/// One place where an object lives: a native keyframe or a retained pose source, and its slot.
#[derive(Clone)]
enum Place {
    Native(usize),
    Source(std::sync::Arc<str>),
}

/// `nativeTimeline(report)`: where each keyframe starts and how long it lasts.
fn native_rows(report: &Value) -> Vec<(f64, f64)> {
    let version = number(report.get("version"));
    let frames = items(report.get("keyframes"));
    let mut tick = 0.0;
    frames
        .iter()
        .enumerate()
        .map(|(index, frame)| {
            let n = match frame.get("duration_raw") {
                None | Some(Value::Null) => 1.0,
                Some(value) => value.as_f64().unwrap_or(f64::NAN),
            };
            let ticks = if n.is_nan() { f64::NAN } else { n.max(0.0) };
            let count = if version >= 5.0 && index == frames.len() - 1 { ticks.min(1.0) } else { ticks };
            let start = tick;
            tick += count;
            (start, count)
        })
        .collect()
}

/// The movieclip types of the report (`movieclipTypes(report)`): figure identities whose definition is a clip.
fn clip_types(report: &Value) -> NumberSet {
    let mut types = NumberSet::default();
    for figure in items(report.get("figure_types")) {
        if truthy(path(Some(&figure), &["_styk", "movieclip"])) {
            if let Some(id) = num(figure.get("figure_type_id")) {
                types.insert(id);
            }
        }
    }
    types
}

/// Whether the report holds any movieclip definition.
pub(super) fn has_clips(report: &Value) -> bool {
    clip_types(report).len() > 0
}

pub(super) fn normalize(report: &mut Value) -> Result<(), EditError> {
    let types = clip_types(report);
    if types.len() == 0 {
        return Ok(());
    }
    let rows = native_rows(report);
    let timeline = crate::timeline::rows(report);
    let total = timeline.last().map_or(1.0, |last| last.start + last.count);
    let native = items(report.get("keyframes"));
    let sources: Vec<(std::sync::Arc<str>, Value)> = entries(path(Some(report), &["_styk", "frameSources"])).into_iter().map(|(key, frame)| (key, frame.clone())).collect();
    let frames: Vec<(Place, &Value)> = native.iter().enumerate().map(|(i, f)| (Place::Native(i), f)).chain(sources.iter().map(|(key, f)| (Place::Source(key.clone()), f))).collect();
    // `byFrame`: the last frame carrying each identity; frames without one share the `undefined` key.
    let mut by_frame: HashMap<Option<String>, usize> = HashMap::new();
    for (index, (_, frame)) in frames.iter().enumerate() {
        let id = prop(Some(frame), "_styk")?;
        by_frame.insert(text(get(id, "frameId")).map(str::to_string), index);
    }
    // Instances of each clip, by figure identity: where they are, in order of first appearance.
    let mut order: Vec<f64> = Vec::new();
    let mut instances: HashMap<u64, Vec<(usize, usize)>> = HashMap::new();
    for (index, (_, frame)) in frames.iter().enumerate() {
        let objects = prop(Some(frame), "objects")?;
        if !is_array(objects) {
            return Err(refuse(TYPE_ERROR));
        }
        for (slot, object) in items(objects).iter().enumerate() {
            let type_id = prop(Some(object), "figure_type_id")?;
            if num(type_id).is_some_and(|id| types.has(id)) {
                let uid = num(object.get("unique_id")).unwrap_or(f64::NAN);
                let list = instances.entry(id_key(uid)).or_default();
                if list.is_empty() {
                    order.push(uid);
                }
                list.push((index, slot));
            }
        }
    }
    let mut poses: HashMap<u64, Value> = HashMap::new();
    for channel in items(path(Some(report), &["_styk", "animation", "channels"])) {
        let c = Some(&channel);
        if text(prop(c, "property")?) == Some("pose") && text(path(prop(c, "target")?, &["kind"])) == Some("figure") {
            poses.insert(id_key(number(path(c, &["target", "uid"]))), channel.clone());
        }
    }
    let object_of = |frame: usize, slot: usize| -> Option<Value> { items(frames[frame].1.get("objects")).get(slot).cloned() };
    let mut updates: Vec<(usize, usize, Value)> = Vec::new();
    for uid in order {
        let places = &instances[&id_key(uid)];
        let owner = poses.get(&id_key(uid));
        let owner_keys = owner.map(|o| items(o.get("keys"))).unwrap_or_default();
        // `keys`: each key of the figure's pose track, with the object it names in its source frame.
        let mut keys: Vec<(&Value, Value)> = Vec::new();
        for key in &owner_keys {
            let frame_id = path(Some(key), &["value", "frameId"]);
            let lookup = match frame_id {
                None => Some(None),
                Some(Value::Str(id)) => Some(Some(id.to_string())),
                _ => None,
            };
            let Some(found) = lookup.and_then(|id| by_frame.get(&id)) else { continue };
            let objects = prop(Some(frames[*found].1), "objects")?;
            if let Some(object) = items(objects).into_iter().find(|o| num(o.get("unique_id")) == Some(uid)) {
                keys.push((key, object));
            }
        }
        let first = keys.first().map(|(_, object)| object.clone()).or_else(|| places.first().and_then(|(f, s)| object_of(*f, *s)));
        let base = playback_settings(first.as_ref());
        if text(base.get("clock")) == Some("presence") {
            continue;
        }
        let start = number(base.get("start"));
        let mut end: Option<f64> = base.get("end").and_then(Value::as_f64);
        let end_is_null = matches!(base.get("end"), Some(Value::Null));
        if end_is_null {
            let found = owner.and_then(|o| items(o.get("keys")).into_iter().find(|k| number(k.get("tick")) > start && is_null(path(Some(k), &["value", "frameId"]))).map(|k| number(k.get("tick"))));
            end = found;
            if end.is_none() && owner.is_none() {
                let index = rows.iter().rposition(|row| row.0 <= start);
                for i in index.unwrap_or(0)..rows.len() {
                    let present = items(native[i].get("objects")).iter().any(|o| num(o.get("unique_id")) == Some(uid));
                    if !present {
                        break;
                    }
                    end = Some(rows[i].0 + rows[i].1);
                }
            }
            end = Some((start + 1.0).max(end.unwrap_or(total)));
        }
        // `phases`: a Map from tick to restart, in insertion order.
        let restarts = items(base.get("restarts"));
        let mut phases: Vec<(f64, Value)> = Vec::new();
        let put = |phases: &mut Vec<(f64, Value)>, tick: f64, entry: Value| match phases.iter_mut().find(|(t, _)| *t == tick || (t.is_nan() && tick.is_nan())) {
            Some(slot) => slot.1 = entry,
            None => phases.push((tick, entry)),
        };
        for restart in &restarts {
            put(&mut phases, number(restart.get("tick")), restart.clone());
        }
        for (key, object) in &keys {
            let p = playback_settings(Some(object));
            let tick = number(key.get("tick"));
            let (p_start, own_restarts) = (number(p.get("start")), p.get("restarts"));
            if !truthy(own_restarts) && p_start > start && p_start == tick {
                let mut entry = Obj::new();
                entry.set("tick", Value::Num(tick));
                entry.set("offset", p.get("offset").cloned().unwrap_or(Value::Null));
                put(&mut phases, tick, Value::object(entry));
            }
        }
        let legacy_restart = phases.len() > len(base.get("restarts"));
        if end_is_null || legacy_restart {
            for (frame, slot) in places {
                let settings = if legacy_restart {
                    let mut merged = base.clone();
                    merged.set("end", end.map(Value::Num).unwrap_or(Value::Null));
                    let mut sorted = phases.clone();
                    sorted.sort_by(|a, b| (a.0 - b.0).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal));
                    merged.set("restarts", Value::array(sorted.into_iter().map(|(_, entry)| entry).collect()));
                    merged
                } else {
                    let mut own = playback_settings(object_of(*frame, *slot).as_ref());
                    own.set("end", end.map(Value::Num).unwrap_or(Value::Null));
                    own
                };
                updates.push((*frame, *slot, Value::object(settings)));
            }
        }
    }
    for (frame, slot, settings) in updates {
        write(report, &frames_place(&frames, frame), slot, settings);
    }
    Ok(())
}

fn frames_place(frames: &[(Place, &Value)], index: usize) -> Place {
    frames[index].0.clone()
}

/// `object._stykMovieclip = settings` on the object at `slot` of the frame at `place`.
fn write(report: &mut Value, place: &Place, slot: usize, settings: Value) {
    let frame = match place {
        Place::Native(index) => report.make_obj().and_then(|r| r.get_mut("keyframes")).and_then(Value::make_arr).and_then(|list| list.get_mut(*index)),
        Place::Source(key) => report.make_obj().and_then(|r| r.get_mut("_styk")).and_then(Value::make_obj).and_then(|s| s.get_mut("frameSources")).and_then(Value::make_obj).and_then(|table| table.get_mut(key)),
    };
    let Some(objects) = frame.and_then(Value::make_obj).and_then(|f| f.get_mut("objects")) else { return };
    let Some(list) = objects.make_arr() else { return };
    if let Some(object) = list.get_mut(slot).and_then(Value::make_obj) {
        object.set("_stykMovieclip", settings);
    }
}
