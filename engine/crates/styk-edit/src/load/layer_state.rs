//! The persistent layers (`ensureLayerState`, `validateLayerStateSteps` of src/layers.mjs, with the
//! parallax and folder checks of src/layer-parallax.mjs and src/layer-folders.mjs) and the layer
//! exposure sheet (`validateLayerSheet` of src/layer-sheet.mjs).

use std::collections::{HashMap, HashSet};

use styk_doc::{Obj, Value};

use super::animation::key_easing;
use super::js::*;
use crate::EditError;

const FIXED: [&str; 2] = ["scene", "camera"];
const COLORS: [&str; 6] = ["blue", "violet", "rose", "orange", "green", "teal"];

/// `isUserLayerId(id)`: `/^layer-[1-9]\d*$/`.
fn user_layer_id(value: &str) -> bool {
    value.strip_prefix("layer-").is_some_and(positive_canonical)
}

/// `ensureLayerState(report)`: a document without layers gets the default state, and the permanent
/// tracks get their settings.
pub(super) fn ensure(report: &mut Value) -> Result<(), EditError> {
    let Some(object) = report.make_obj() else { return Err(refuse(TYPE_ERROR)) };
    if !object.get("_styk").is_some_and(Value::truthy) {
        object.set("_styk", Value::object(Obj::new()));
    }
    if !object.get("_styk").is_some_and(Value::is_object) {
        return fail("errors.layers.invalidStykanimateMetadata");
    }
    let styk = object.get_mut("_styk").and_then(Value::make_obj).unwrap();
    if styk.get("layers").is_none_or(Value::is_null) {
        styk.set("layers", crate::layers::created_state());
    }
    let Some(state) = styk.get_mut("layers").and_then(Value::make_obj) else { return Ok(()) };
    if state.get("fixed").is_none_or(Value::is_object) {
        if state.get("fixed").is_none() {
            state.set("fixed", Value::object(Obj::new()));
        }
        let fixed = state.get_mut("fixed").and_then(Value::make_obj).unwrap();
        for id in FIXED {
            if fixed.get(id).is_none_or(Value::is_null) {
                let mut flags = Obj::new();
                flags.set("visible", Value::Bool(true));
                flags.set("locked", Value::Bool(false));
                fixed.set(id, Value::object(flags));
            }
        }
    }
    Ok(())
}

/// `validateParallax(p)`.
fn parallax(p: V) -> Result<(), EditError> {
    if missing(p) {
        return Ok(());
    }
    let valid = truthy(p)
        && boolean(get(p, "enabled"))
        && boolean(get(p, "linked"))
        && [get(p, "x"), get(p, "y")].iter().all(|v| finite_in(*v, 0.0, 4.0))
        && truthy(get(p, "reference"))
        && [path(p, &["reference", "x"]), path(p, &["reference", "y"])].iter().all(|v| finite(*v));
    if !valid {
        return fail("errors.layerParallax.parallaxNeedsA0400ResponseAndA");
    }
    Ok(())
}

/// `validateLayerFolders(state)`.
fn folders(state: V) -> Result<(), EditError> {
    let table = get(state, "folders");
    if !missing(table) {
        let by_id = get(table, "byId");
        if !is_record(table) || !is_record(by_id) || !safe_integer(get(table, "nextId")) || num(get(table, "nextId")).unwrap() < 1.0 || key_count(by_id) > 10_000 {
            return fail("errors.layerFolders.invalidFolders");
        }
        let mut largest = 0.0f64;
        for (id, folder) in entries(by_id) {
            let f = Some(folder);
            let numbered = id.strip_prefix("folder-").filter(|n| positive_canonical(n));
            if numbered.is_none() || !is_record(f) || !name(get(f, "name"), 160) {
                return fail("errors.layerFolders.invalidFolders");
            }
            largest = largest.max(number_of(numbered.unwrap()));
        }
        if num(get(table, "nextId")).unwrap() <= largest {
            return fail("errors.layerFolders.invalidFolders");
        }
    }
    let known = path(state, &["folders", "byId"]);
    for (_, layer) in entries(get(state, "byId")) {
        let folder = get(Some(layer), "folderId");
        if !missing(folder) && !(known.is_some() && folder.is_some_and(|f| property_key(f).is_some_and(|key| has_own(known, &key)))) {
            return fail("errors.layerFolders.missingFolder");
        }
    }
    let mut seen: HashSet<String> = HashSet::new();
    let mut previous: Option<Value> = None;
    for id in items(get(state, "order")) {
        let folder = path(state.map(|s| s), &["byId", text(Some(&id)).unwrap_or("")]).and_then(|layer| layer.get("folderId"));
        if folder.is_some_and(Value::truthy) && folder != previous.as_ref() {
            let key = property_key(folder.unwrap()).unwrap_or_default();
            if !seen.insert(key) {
                return fail("errors.layerFolders.invalidFolders");
            }
        }
        previous = folder.cloned();
    }
    Ok(())
}

/// The property name a value reads as (`object[value]`), for the values a document holds.
fn property_key(value: &Value) -> Option<String> {
    match value {
        Value::Str(text) => Some(text.to_string()),
        Value::Num(n) => Some(number_text(*n)),
        Value::Bool(b) => Some(b.to_string()),
        Value::Null => Some("null".into()),
        _ => None,
    }
}

/// `validateLayerStateSteps(state)`.
pub(super) fn validate(state: V) -> Result<(), EditError> {
    let order = get(state, "order");
    if !is_record(state)
        || num(get(state, "version")) != Some(1.0)
        || !is_array(order)
        || len(order) == 0
        || len(order) > 10_000
        || !is_record(get(state, "byId"))
        || !is_record(get(state, "assignments"))
        || !safe_integer(get(state, "nextId"))
        || num(get(state, "nextId")).unwrap() < 1.0
    {
        return fail("errors.layers.invalidStykanimateLayerMetadata");
    }
    let by_id = get(state, "byId");
    let mut ids: HashSet<String> = HashSet::new();
    let mut largest = 0.0f64;
    for id in items(order) {
        let id_text = text(Some(&id));
        if !id_text.is_some_and(|id| user_layer_id(id) && !ids.contains(id) && has_own(by_id, id)) {
            return fail("errors.layers.layerIdsAndOrderMustBeUnique");
        }
        let id_text = id_text.unwrap();
        ids.insert(id_text.to_string());
        largest = largest.max(number_of(&id_text[6..]));
        let layer = get(by_id, id_text);
        let valid = is_record(layer) && name(get(layer, "name"), 160) && boolean(get(layer, "visible")) && boolean(get(layer, "locked"));
        if !valid {
            return fail("errors.layers.invalidLayerProperties");
        }
        parallax(get(layer, "parallax"))?;
        let drawing = get(layer, "drawing");
        if !missing(drawing) && !(is_record(drawing) && num(get(drawing, "version")) == Some(1.0)) {
            return fail("errors.layers.invalidDrawingLayerMetadata");
        }
        let color = get(layer, "color");
        if !missing(color) && !color.and_then(property_key).is_some_and(|c| COLORS.contains(&c.as_str())) {
            return fail("errors.layers.invalidLayerColor");
        }
    }
    let active = get(state, "activeId");
    let known = |id: &str| ids.contains(id);
    let default_layer = text(get(state, "defaultLayerId")).is_some_and(known);
    let active_ok = missing(active) || text(active).is_some_and(|a| known(a) || FIXED.contains(&a));
    if key_count(by_id) != ids.len() || num(get(state, "nextId")).unwrap() <= largest || !default_layer || !active_ok {
        return fail("errors.layers.layerMetadataReferencesAMissingLayer");
    }
    for (uid, layer) in entries(get(state, "assignments")) {
        if !(canonical(&uid) && number_of(&uid) <= 4_294_967_295.0 && text(Some(layer)).is_some_and(known)) {
            return fail("errors.layers.invalidFigureToLayerAssignment");
        }
    }
    let fixed = get(state, "fixed");
    if !missing(fixed) {
        if !is_record(fixed) || entries(fixed).iter().any(|(id, _)| !FIXED.contains(&&**id)) {
            return fail("errors.layers.invalidPermanentTracks");
        }
        for id in FIXED {
            let track = get(fixed, id);
            if truthy(track) && !(boolean(get(track, "visible")) && boolean(get(track, "locked"))) {
                return fail("errors.layers.invalidPermanentTrackProperties");
            }
        }
    }
    folders(state)
}

/// The identity of the layer a figure sits on (`layerIdForUid(report, uid)`).
pub(super) fn layer_of(report: &Value, uid: f64) -> Option<String> {
    let state = path(Some(report), &["_styk", "layers"]);
    if !truthy(state) {
        return Some("layer-1".into());
    }
    let key = number_text(uid);
    let assigned = get(get(state, "assignments"), &key);
    text(if has_own(get(state, "assignments"), &key) { assigned } else { get(state, "defaultLayerId") }).map(str::to_string)
}

/// `validateLayerSheet(report)` and the pose-source lookup it needs.
pub(super) fn validate_sheet(report: &Value) -> Result<(), EditError> {
    const MAX_TICKS: f64 = 10_000_000.0;
    let state = path(Some(report), &["_styk", "layerSheet"]);
    if missing(state) {
        return Ok(());
    }
    let tracks = get(state, "tracks");
    if !truthy(state)
        || num(get(state, "version")) != Some(1.0)
        || !integer_in(get(state, "duration"), 1.0, MAX_TICKS)
        || !safe_integer(get(state, "nextId"))
        || num(get(state, "nextId")).unwrap() < 1.0
        || !truthy(tracks)
        || is_array(tracks)
    {
        return fail("errors.layerSheet.invalidLayerTimeline");
    }
    let mut allowed: HashSet<String> = FIXED.iter().map(|s| s.to_string()).collect();
    let order = path(Some(report), &["_styk", "layers", "order"]);
    for id in items(order) {
        if let Some(id) = text(Some(&id)) {
            allowed.insert(id.to_string());
        }
    }
    if allowed.iter().any(|id| !has_own(tracks, id)) {
        return fail("errors.layerSheet.layerTimelineIsMissingAnExposureTrack");
    }
    let duration = num(get(state, "duration")).unwrap();
    let sources = Sources::new(report);
    let mut count = 0usize;
    let mut largest = 0.0f64;
    let mut key_ids: Vec<Vec<String>> = Vec::new();
    for (id, track) in entries(tracks) {
        if !allowed.contains(&*id) {
            return fail("errors.layerSheet.layerTimelineReferencesAMissingLayer");
        }
        let (ids, track_largest) = validate_track(&sources, Some(track), duration)?;
        count += ids.len();
        largest = largest.max(track_largest);
        key_ids.push(ids);
    }
    if count > 1_000_000 {
        return fail("errors.layerSheet.layerKeysNeedUniqueIdentitiesAndDistinctOrdered");
    }
    if num(get(state, "nextId")).unwrap() <= largest {
        return fail("errors.layerSheet.layerKeyIdentityCounterIsInvalid");
    }
    let mut owners: HashSet<&str> = HashSet::with_capacity(count);
    for ids in &key_ids {
        for id in ids {
            if !owners.insert(id) {
                return fail("errors.layerSheet.layerKeysNeedUniqueIdentitiesAndDistinctOrdered");
            }
        }
    }
    Ok(())
}

/// `poseSourceFrame(report, id)`: a retained pose source, or the keyframe that carries the identity.
struct Sources<'a> {
    retained: Option<&'a Value>,
    frames: Vec<Value>,
    by_id: std::cell::OnceCell<HashMap<String, usize>>,
}

impl<'a> Sources<'a> {
    fn new(report: &'a Value) -> Sources<'a> {
        Sources { retained: path(Some(report), &["_styk", "frameSources"]), frames: items(report.get("keyframes")), by_id: Default::default() }
    }

    fn frame(&self, id: V) -> Option<Value> {
        let id = text(id)?;
        if let Some(found) = get(self.retained, id).filter(|_| has_own(self.retained, id)).filter(|f| f.truthy()) {
            return Some(found.clone());
        }
        let index = self.by_id.get_or_init(|| {
            let mut map = HashMap::new();
            for (i, frame) in self.frames.iter().enumerate() {
                if let Some(id) = text(path(Some(frame), &["_styk", "frameId"])).filter(|id| !id.is_empty()) {
                    map.insert(id.to_string(), i);
                }
            }
            map
        });
        index.get(id).map(|i| self.frames[*i].clone())
    }
}

/// `validateTrack(report, id, track, allowed, duration)`: the key identities in order and the largest `cell-N`.
fn validate_track(sources: &Sources, track: V, duration: f64) -> Result<(Vec<String>, f64), EditError> {
    let keys = get(track, "keys");
    if !truthy(track) || !is_array(keys) {
        return fail("errors.layerSheet.layerTimelineReferencesAMissingLayer");
    }
    let end = get(track, "end");
    if !integer_in(end, 0.0, duration) {
        return fail("errors.layerSheet.invalidLayerExposureLength");
    }
    let end = num(end).unwrap();
    let mut ids: Vec<String> = Vec::with_capacity(len(keys));
    let mut seen: HashSet<String> = HashSet::with_capacity(len(keys));
    let mut previous = -1.0;
    let mut largest = 0.0f64;
    for key in items(keys) {
        let k = Some(&key);
        let key_id = text(get(k, "id"));
        let tick = get(k, "tick");
        if ids.len() >= 1_000_000
            || !truthy(k)
            || !key_id.is_some_and(|id| !id.is_empty() && !seen.contains(id))
            || !integer(tick)
            || num(tick).unwrap() < 0.0
            || num(tick).unwrap() <= previous
            || num(tick).unwrap() >= end
        {
            return fail("errors.layerSheet.layerKeysNeedUniqueIdentitiesAndDistinctOrdered");
        }
        let key_id = key_id.unwrap();
        seen.insert(key_id.to_string());
        ids.push(key_id.to_string());
        previous = num(tick).unwrap();
        key_easing(k, None)?;
        let patch_only = get(k, "patchOnly");
        if !missing(patch_only) && !matches!(patch_only, Some(Value::Bool(true))) {
            return fail("errors.layerSheet.invalidMovieclipFrameBoundary");
        }
        let patches = get(k, "movieclipPatches");
        if !missing(patches) {
            if !is_array(patches) || len(patches) > 65535 {
                return fail("errors.layerSheet.invalidMovieclipFrameReplacements");
            }
            let mut replaced = NumberSet::default();
            for patch in items(patches) {
                let p = Some(&patch);
                let source = sources.frame(get(p, "frameId"));
                let replacement = get(p, "replacementUid");
                let order = get(p, "orderIndex");
                let valid = truthy(p)
                    && integer_in(get(p, "uid"), 0.0, f64::INFINITY)
                    && !replaced.has(num(get(p, "uid")).unwrap())
                    && source.is_some()
                    && (missing(replacement) || items(source.as_ref().and_then(|s| s.get("objects"))).iter().any(|o| o.get("unique_id") == replacement && replacement.is_some()))
                    && (missing(order) || integer_in(order, 0.0, 65535.0));
                if !valid {
                    return fail("errors.layerSheet.invalidMovieclipFrameReplacement");
                }
                replaced.insert(num(get(p, "uid")).unwrap());
            }
        }
        if let Some(number) = key_id.strip_prefix("cell-").filter(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())) {
            largest = largest.max(number_of(number));
        }
        let source_tick = get(k, "sourceTick");
        if !missing(source_tick) {
            if !finite_in(source_tick, 0.0, 10_000_000.0) {
                return fail("errors.layerSheet.invalidImportedLayerTiming");
            }
        } else {
            let frame_id = path(k, &["value", "frameId"]);
            if !is_null(frame_id) && sources.frame(frame_id).is_none() {
                return fail("errors.layerSheet.layerKeyReferencesAMissingPose");
            }
        }
    }
    Ok((ids, largest))
}
