//! `initializeLayerSheet(report)` (src/editor-layer-sheet.mjs): the layer sheet the app's editor gives a
//! document when it publishes it, built from the native timeline and the authored animation. The editor ran
//! it after `prepareEditorLoad`; the engine runs it after [`super::prepare_editor_load`] when the editor has
//! a layer timeline, so the document the session starts on is the one the interface shows.

use styk_doc::{Obj, Value};

use super::js::*;
use crate::EditError;

/// The permanent tracks that no user layer owns.
fn fixed(id: &str) -> bool {
    id == "scene" || id == "camera"
}

/// `nativeTimeline(report)`: where each keyframe starts and how many ticks it lasts.
fn native_rows(report: &Value) -> Vec<styk_eval::eval::Row> {
    let version = report.get("version").and_then(Value::as_f64).unwrap_or(5.0) as u32;
    let durations: Vec<u32> = report
        .get("keyframes")
        .and_then(Value::elements)
        .map(|frames| frames.iter().map(|k| k.get("duration_raw").and_then(Value::as_f64).map(|v| v as i64).unwrap_or(1).max(0) as u32).collect())
        .unwrap_or_default();
    styk_eval::eval::timeline_rows(version, durations.into_iter())
}

/// Gives a document without a layer sheet one, and takes its authored animation and saved frame draft into
/// it (the animation as the sheet's `legacyAnimation`).
pub(crate) fn initialize(report: &mut Value) -> Result<(), EditError> {
    if truthy(path(Some(report), &["_styk", "layerSheet"])) {
        // The sheet was validated with the rest of the document.
        return Ok(());
    }
    let rows = crate::timeline::rows(report);
    let native = native_rows(report);
    let duration = rows.last().map_or(0.0, |last| last.start + last.count).max(1.0);
    let legacy = path(Some(report), &["_styk", "animation"]).filter(|animation| animation.truthy()).cloned();
    let version = num(get(Some(report), "version")).unwrap_or(f64::NAN);
    let auto = truthy(get(Some(report), "auto_easing"));
    let movieclip_source = truthy(path(Some(report), &["_styk", "movieclipSource"]));
    let frames = items(report.get("keyframes"));
    // Rows that start on the same tick share it: the last one wins, as in a `Map`.
    let mut key_of: std::collections::HashMap<u64, usize> = std::collections::HashMap::new();
    for (index, row) in native.iter().enumerate() {
        key_of.insert((row.start as f64).to_bits(), index);
    }
    let order: Vec<String> = items(path(Some(report), &["_styk", "layers", "order"])).iter().filter_map(|id| id.as_str().map(str::to_string)).collect();
    let mut next_id = 1.0;
    let mut tracks = Obj::new();
    for id in ["scene", "camera"].into_iter().map(str::to_string).chain(order) {
        let mut times: Vec<f64> = native.iter().filter(|row| row.count > 0).map(|row| row.start as f64).collect();
        times.push(0.0);
        for channel in items(path(legacy.as_ref(), &["channels"])) {
            let target = get(Some(&channel), "target");
            let kind = text(get(target, "kind"));
            let matches_layer = kind == Some(id.as_str())
                || (kind == Some("layer") && text(get(target, "id")) == Some(id.as_str()))
                || (target.and_then(|t| t.get("uid")).is_some_and(|uid| layer_of_value(report, uid).as_deref() == Some(id.as_str())));
            if matches_layer {
                for key in items(get(Some(&channel), "keys")) {
                    if !truthy(get(Some(&key), "hidden")) && num(get(Some(&key), "tick")).is_some_and(|tick| tick < duration) {
                        times.push(num(get(Some(&key), "tick")).unwrap());
                    }
                }
            }
        }
        times.sort_by(f64::total_cmp);
        times.dedup_by(|a, b| a == b);
        let mut keys = Vec::with_capacity(times.len());
        for tick in times {
            let frame = key_of.get(&tick.to_bits()).and_then(|index| frames.get(*index));
            let mut key = Obj::new();
            key.set("id", Value::str(&format!("cell-{}", number_text(next_id))));
            next_id += 1.0;
            key.set("tick", Value::Num(tick));
            key.set("sourceTick", Value::Num(tick));
            match frame.and_then(|frame| path(Some(frame), &["_styk", "easing"])).filter(|easing| !matches!(easing, Value::Null)) {
                Some(easing) => {
                    if let Some(easing) = easing.as_obj() {
                        for (name, value) in easing.iter() {
                            key.set(name, value.clone());
                        }
                    }
                }
                None => key.set("interpolation", Value::str(if version < 5.0 { "constant" } else if auto { "auto" } else { "linear" })),
            }
            if !fixed(&id) && legacy.is_none() && !movieclip_source {
                let owned = frame.is_some_and(|frame| items(frame.get("objects")).iter().any(|object| num(object.get("unique_id")).is_some_and(|uid| layer_of_uid(report, uid).as_deref() == Some(id.as_str()))));
                key.set("empty", Value::Bool(!owned));
            }
            keys.push(Value::object(key));
        }
        let mut track = Obj::new();
        track.set("end", Value::Num(duration));
        track.set("keys", Value::array(keys));
        tracks.set(&id, Value::object(track));
    }
    let mut sheet = Obj::new();
    sheet.set("version", Value::Num(1.0));
    sheet.set("duration", Value::Num(duration));
    sheet.set("nextId", Value::Num(next_id));
    sheet.set("tracks", Value::object(tracks));
    if let Some(legacy) = legacy {
        sheet.set("legacyAnimation", legacy);
    }
    let styk = report.make_obj().and_then(|root| root.get_mut("_styk")).and_then(Value::make_obj).ok_or_else(|| refuse(TYPE_ERROR))?;
    styk.set("layerSheet", Value::object(sheet));
    styk.remove("animation");
    styk.remove("simpleFrameDraft");
    super::layer_state::validate_sheet(report)
}

/// `layerIdForUid(report, uid)` for a figure identity that is a number.
fn layer_of_uid(report: &Value, uid: f64) -> Option<String> {
    super::layer_state::layer_of(report, uid)
}

/// `layerIdForUid(report, value)` for whatever the target names (`String(value)` is its key).
fn layer_of_value(report: &Value, uid: &Value) -> Option<String> {
    match uid {
        Value::Num(n) => layer_of_uid(report, *n),
        _ => None,
    }
}
