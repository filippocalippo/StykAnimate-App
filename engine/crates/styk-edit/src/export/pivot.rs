//! A document as native Pivot frames (the stored-frame projection stays in src/pivot-frame-draft.mjs): Pivot has one shared
//! exposure sequence, so the authored tracks, camera motion, parallax, styles and movieclips bake into stored frames
//! of the document the export is made from; the document the interface edits stays as it is.

use std::collections::HashMap;

use styk_doc::{Obj, Value};

use super::figure::{portable_background, portable_figure};
use super::style::StyleTable;
use super::{items, number, remove, set, Context, Hold};
use crate::property_edit::channel_id;
use crate::sheet::create_frame;
use crate::EditError;

const MAX_FRAMES: f64 = 100_000.0;
const MAX_OBJECTS: usize = 2_000_000;
const MAX_BACKGROUNDS: usize = 65_534;

fn invalid(key: &str) -> EditError {
    EditError::Invalid(key.into())
}

fn truthy(value: Option<&Value>) -> bool {
    value.is_some_and(Value::truthy)
}

/// `n.toLocaleString()` for a count: digits in groups of three.
fn grouped(n: f64) -> String {
    let digits = format!("{}", n.trunc() as i64);
    let mut out = String::new();
    for (at, digit) in digits.chars().enumerate() {
        if at > 0 && (digits.len() - at) % 3 == 0 {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

/// `movieclipTypes(report).size`.
pub(super) fn has_movieclips(report: &Value) -> bool {
    items(report.get("figure_types")).iter().any(|figure| truthy(figure.path(&["_styk", "movieclip"])))
}

fn has_ik(report: &Value) -> bool {
    items(report.get("keyframes")).iter().any(|frame| items(frame.get("objects")).iter().any(crate::ik::has_pinned))
}

fn has_frame_easing(report: &Value) -> bool {
    items(report.get("keyframes")).iter().any(|frame| truthy(frame.path(&["_styk", "easing"])))
}

fn has_animation_origins(report: &Value) -> bool {
    items(report.get("figure_types")).iter().any(|figure| truthy(figure.path(&["_styk", "animationOrigin"])))
}

fn has_native_style_overrides(report: &Value) -> bool {
    items(report.get("keyframes")).iter().any(|frame| items(frame.get("objects")).iter().any(|object| truthy(object.get("_stykStyle"))))
}

fn camera_features(report: &Value) -> bool {
    let clips = items(report.path(&["_styk", "cameraMotion", "clips"])).iter().any(|clip| truthy(clip.get("enabled")));
    let layers = report.path(&["_styk", "layers"]);
    clips || layers.is_some_and(|layers| items(layers.get("order")).iter().any(|id| id.as_str().is_some_and(|id| truthy(layers.path(&["byId", id, "parallax", "enabled"])))))
}

/// `activeChannels(report)`: the authored channels that hold keys, and every pose channel.
fn active_channels(report: &Value) -> Vec<Value> {
    items(report.path(&["_styk", "animation", "channels"])).into_iter()
        .filter(|channel| channel.get("property").and_then(Value::as_str) == Some("pose") || channel.get("keys").and_then(Value::array_len).is_some_and(|keys| keys > 0))
        .collect()
}

/// `layerVisible(report, uid)`.
fn layer_visible(report: &Value, uid: u32) -> bool {
    let layers = report.path(&["_styk", "layers"]);
    let id = crate::frame::layer_of(layers, uid);
    !matches!(layers.and_then(|layers| layers.path(&["byId", &id, "visible"])), Some(Value::Bool(false)))
}

/// The rows of the native timeline (`nativeTimeline(report)`): where each stored key starts and how long it lasts.
fn native_rows(report: &Value) -> Vec<(f64, f64)> {
    let version = number(report, "version").unwrap_or(5.0) as u32;
    let durations = items(report.get("keyframes")).iter().map(|frame| number(frame, "duration_raw").map_or(1, |raw| raw.max(0.0) as i64 as u32)).collect::<Vec<u32>>();
    styk_eval::eval::timeline_rows(version, durations.into_iter()).into_iter().map(|row| (row.start as f64, row.count as f64)).collect()
}

/// `withoutNativeSheet(report)`: an imported sheet is a view of native time until a track is authored or retimed. Proved from
/// its current contents on every export (a cached "unedited" flag would be unsafe after Undo or a native-save reopen).
fn without_native_sheet(report: &Value) -> Value {
    let Some(sheet) = report.path(&["_styk", "layerSheet"]).filter(|sheet| sheet.truthy()) else { return report.clone() };
    let sheet_keys: Vec<String> = sheet.as_obj().map(|sheet| sheet.keys().map(|key| key.to_string()).collect()).unwrap_or_default();
    if truthy(report.path(&["_styk", "animation"])) || truthy(report.path(&["_styk", "movieclipSource"])) || has_movieclips(report)
        || number(sheet, "version") != Some(1.0) || sheet_keys.iter().any(|key| !["version", "duration", "nextId", "tracks"].contains(&key.as_str())) {
        return report.clone();
    }
    let rows = native_rows(report);
    let duration = rows.last().map_or(0.0, |&(start, count)| start + count);
    if number(sheet, "duration") != Some(duration) || duration == 0.0 {
        return report.clone();
    }
    let mut times: Vec<f64> = vec![0.0];
    for &(start, count) in &rows {
        if count > 0.0 && !times.contains(&start) {
            times.push(start);
        }
    }
    times.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mut ids = vec!["scene".to_string(), "camera".to_string()];
    ids.extend(items(report.path(&["_styk", "layers", "order"])).iter().filter_map(|id| id.as_str().map(str::to_string)));
    let Some(tracks) = sheet.get("tracks").and_then(Value::as_obj) else { return report.clone() };
    if tracks.len() != ids.len() {
        return report.clone();
    }
    let interpolation = if number(report, "version").unwrap_or(5.0) < 5.0 { "constant" } else if truthy(report.get("auto_easing")) { "auto" } else { "linear" };
    for id in &ids {
        let Some(track) = tracks.get(id) else { return report.clone() };
        let keys = items(track.get("keys"));
        let track_keys: Vec<String> = track.as_obj().map(|track| track.keys().map(|key| key.to_string()).collect()).unwrap_or_default();
        if number(track, "end") != Some(duration) || keys.len() != times.len() || track_keys.iter().any(|key| key != "end" && key != "keys") {
            return report.clone();
        }
        for (key, &time) in keys.iter().zip(&times) {
            let fields: Vec<String> = key.as_obj().map(|key| key.keys().map(|field| field.to_string()).collect()).unwrap_or_default();
            if number(key, "tick") != Some(time) || number(key, "sourceTick") != Some(time) || key.get("interpolation").and_then(Value::as_str) != Some(interpolation)
                || fields.iter().any(|field| !["id", "tick", "sourceTick", "interpolation", "empty"].contains(&field.as_str())) {
                return report.clone();
            }
        }
    }
    let mut styk = report.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
    styk.remove("layerSheet");
    let mut out = report.clone();
    set(&mut out, "_styk", Value::object(styk));
    out
}

/// `storedFrameReport(report)`: native Pivot saves stored keys, excluding an uncommitted Add-frame pose.
fn stored_frame_report(report: &Value) -> Result<Value, EditError> {
    let Some(draft) = report.path(&["_styk", "simpleFrameDraft"]) else { return Ok(report.clone()) };
    validate_draft(report, draft)?;
    let mut styk = report.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
    styk.remove("simpleFrameDraft");
    let mut out = report.clone();
    if truthy(draft.get("empty")) {
        set(&mut out, "_styk", Value::object(styk));
        set(&mut out, "keyframes", Value::array(Vec::new()));
        set(&mut out, "total_output_frames", Value::Num(0.0));
        set(&mut out, "duration_seconds", Value::Num(0.0));
        return Ok(out);
    }
    if draft.get("mode").and_then(Value::as_str) == Some("add") && truthy(draft.get("baseline")) {
        let mut keyframes = items(report.get("keyframes"));
        let index = number(draft, "index").unwrap_or(f64::NAN);
        if let Some(slot) = keyframes.get_mut(index as usize) {
            *slot = draft.get("baseline").cloned().unwrap_or(Value::Null);
        }
        if draft.get("animationBaseline").is_some() {
            match draft.get("animationBaseline") {
                Some(Value::Null) => {
                    styk.remove("animation");
                }
                Some(baseline) => styk.set("animation", baseline.clone()),
                None => {}
            }
        }
        set(&mut out, "keyframes", Value::array(keyframes));
    }
    set(&mut out, "_styk", Value::object(styk));
    Ok(out)
}

/// `validateSimpleFrameDraft(report)`.
fn validate_draft(report: &Value, draft: &Value) -> Result<(), EditError> {
    let frames = items(report.get("keyframes"));
    let index = number(draft, "index");
    let frame = index.filter(|index| index.fract() == 0.0 && *index >= 0.0).and_then(|index| frames.get(index as usize));
    let ok = draft.truthy() && number(draft, "version") == Some(1.0) && matches!(draft.get("mode").and_then(Value::as_str), Some("add" | "update"))
        && frame.is_some_and(|frame| draft.get("frameId") == frame.path(&["_styk", "frameId"]));
    if !ok {
        return Err(invalid("errors.editorFrameDraft.invalidSimpleTimelineWorkingFrame"));
    }
    let empty = draft.get("empty");
    if empty.is_some_and(|empty| !matches!(empty, Value::Bool(_))) || truthy(empty) && (draft.get("mode").and_then(Value::as_str) != Some("add") || index != Some(0.0) || frames.len() != 1) {
        return Err(invalid("errors.editorFrameDraft.anEmptySimpleAnimationRequiresOneAddWorking"));
    }
    if let Some(baseline) = draft.get("baseline") {
        if baseline.path(&["_styk", "frameId"]) != draft.get("frameId") {
            return Err(invalid("errors.editorFrameDraft.theWorkingFrameCheckpointHasADifferentIdentity"));
        }
        let mut probe = report.clone();
        set(&mut probe, "keyframes", Value::array(vec![baseline.clone()]));
        crate::load::validate_scene(&probe)?;
    }
    if let Some(animation) = draft.get("animationBaseline") {
        if !truthy(draft.get("baseline")) {
            return Err(invalid("errors.editorFrameDraft.anAnimationCheckpointRequiresAWorkingFrameBaseline"));
        }
        if !animation.is_null() {
            let mut probe = report.clone();
            let mut styk = report.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
            styk.set("animation", animation.clone());
            set(&mut probe, "_styk", Value::object(styk));
            crate::load::validate_animation(&probe)?;
        }
    }
    Ok(())
}

/// `applyLayerOrder(report, frame)`: the draw order with the figures grouped by layer, back to front, when it differs from
/// the frame's. `Ok(None)` is the frame as it is.
fn layer_order(report: &Value, frame: &Value) -> Result<Option<(Vec<usize>, Vec<Value>)>, EditError> {
    let state = report.path(&["_styk", "layers"]);
    let objects = items(frame.get("objects"));
    let has_depth = objects.iter().any(|object| truthy(object.get("_stykZIndex")));
    let layers: Vec<String> = state.map(|state| items(state.get("order")).iter().filter_map(|id| id.as_str().map(str::to_string)).collect()).unwrap_or_else(|| vec!["layer-1".to_string()]);
    if layers.len() < 2 && !has_depth {
        return Ok(None);
    }
    let order: Vec<usize> = frame.get("object_draw_order").and_then(Value::numbers).map(|order| order.into_iter().map(|slot| slot as usize).collect()).unwrap_or_else(|| (0..objects.len()).collect());
    let mut groups: Vec<(String, Vec<usize>)> = layers.iter().map(|id| (id.clone(), Vec::new())).collect();
    for &slot in &order {
        let Some(object) = objects.get(slot) else { return Err(invalid("errors.layers.invalidNativeFigureOrder")) };
        let id = crate::frame::layer_of(state, number(object, "unique_id").unwrap_or(f64::NAN) as u32);
        let Some(group) = groups.iter_mut().find(|(layer, _)| *layer == id) else { return Err(invalid("errors.layers.figureReferencesAMissingUserLayer")) };
        group.1.push(slot);
    }
    let mut next = Vec::with_capacity(order.len());
    for (_, mut group) in groups {
        if has_depth {
            group.sort_by(|&a, &b| {
                let depth = |slot: usize| number(&objects[slot], "_stykZIndex").unwrap_or(0.0);
                depth(a).partial_cmp(&depth(b)).unwrap_or(std::cmp::Ordering::Equal)
            });
        }
        next.extend(group);
    }
    if next == order {
        return Ok(None);
    }
    let ids = next.iter().map(|&slot| objects[slot].get("unique_id").cloned().unwrap_or(Value::Null)).collect();
    Ok(Some((next, ids)))
}

/// `needsPivotMaterialization(report)`.
pub(super) fn needs_materialization(report: &Value) -> Result<bool, EditError> {
    let report = &without_native_sheet(report);
    if camera_features(report) || truthy(report.path(&["_styk", "layerSheet"])) || has_movieclips(report) || truthy(report.path(&["_styk", "movieclipSource"])) {
        return Ok(true);
    }
    if has_ik(report) || has_frame_easing(report) || !active_channels(report).is_empty() || has_animation_origins(report) || has_native_style_overrides(report) {
        return Ok(true);
    }
    if items(report.get("keyframes")).iter().any(|frame| items(frame.get("objects")).iter().any(|object| object.get("_stykZIndex").is_some())) {
        return Ok(true);
    }
    let Some(layers) = report.path(&["_styk", "layers"]) else { return Ok(false) };
    let hidden = |value: Option<&Value>| matches!(value, Some(Value::Bool(false)));
    let order: Vec<Value> = items(layers.get("order"));
    if hidden(layers.path(&["fixed", "camera", "visible"])) || hidden(layers.path(&["fixed", "scene", "visible"]))
        || order.iter().any(|id| id.as_str().is_some_and(|id| hidden(layers.path(&["byId", id, "visible"])))) {
        return Ok(true);
    }
    if order.len() <= 1 {
        return Ok(false);
    }
    for frame in items(report.get("keyframes")) {
        if layer_order(report, &frame)?.is_some() {
            return Ok(true);
        }
    }
    Ok(false)
}

fn without_frame_identity(frame: &mut Obj) {
    let Some(styk) = frame.get("_styk").filter(|styk| styk.truthy()) else { return };
    let mut metadata = styk.as_obj().cloned().unwrap_or_default();
    metadata.remove("frameId");
    metadata.remove("easing");
    if metadata.is_empty() {
        frame.remove("_styk");
    } else {
        frame.set("_styk", Value::object(metadata));
    }
}

/// One exposure that lasts no time, and the tracks it belongs to.
struct Exposure {
    tick: f64,
    source_id: Value,
    native_index: Option<usize>,
    targets: Vec<(String, Value)>,
}

/// `hiddenExposures`: preserves zero-duration source poses as zero-duration native keys. Authored hidden poses replace only
/// their own track; untouched tracks retain their own native hidden poses. Coincident references to one source share an exposure.
fn hidden_exposures(report: &Value, rows: &[(f64, f64)], channels: &[Value]) -> Result<(Vec<Exposure>, Vec<(String, Value)>), EditError> {
    let mut groups: Vec<(String, Exposure)> = Vec::new();
    let mut extra: Vec<(String, Value)> = Vec::new();
    let frames = items(report.get("keyframes"));
    let mut source_ids: Vec<String> = report.path(&["_styk", "frameSources"]).and_then(Value::as_obj).map(|sources| sources.keys().map(|key| key.to_string()).collect()).unwrap_or_default();
    for frame in &frames {
        if let Some(id) = frame.path(&["_styk", "frameId"]).filter(|id| id.truthy()).and_then(Value::as_str) {
            source_ids.push(id.to_string());
        }
    }
    let mut authored: Vec<String> = Vec::new();
    for channel in channels.iter().filter(|channel| channel.get("property").and_then(Value::as_str) == Some("pose")) {
        if let Some(id) = channel.get("id").and_then(Value::as_str) {
            authored.push(id.to_string());
        }
    }
    let mut targets: Vec<Value> = Vec::new();
    for kind in ["scene", "camera"] {
        let mut target = Obj::new();
        target.set("kind", Value::str(kind));
        targets.push(Value::object(target));
    }
    let layer_ids: Vec<Value> = report.path(&["_styk", "layers", "order"]).map(|order| items(Some(order))).unwrap_or_else(|| vec![Value::str("layer-1")]);
    for id in layer_ids {
        let mut target = Obj::new();
        target.set("kind", Value::str("layer"));
        target.set("id", id);
        targets.push(Value::object(target));
    }
    let mut add = |tick: f64, source_id: Value, target: &Value, native_index: Option<usize>| -> Result<(), EditError> {
        let name = format!("{}:{}", styk_doc::json::to_string(&Value::Num(tick)), source_id.as_str().unwrap_or("blank"));
        let at = match groups.iter().position(|(id, _)| *id == name) {
            Some(at) => at,
            None => {
                groups.push((name, Exposure { tick, source_id: source_id.clone(), native_index, targets: Vec::new() }));
                groups.len() - 1
            }
        };
        let group = &mut groups[at].1;
        if native_index.is_some() {
            group.native_index = native_index;
        }
        let id = channel_id(target, "pose")?;
        match group.targets.iter_mut().find(|(known, _)| *known == id) {
            Some(entry) => entry.1 = target.clone(),
            None => group.targets.push((id, target.clone())),
        }
        Ok(())
    };
    for (index, &(start, count)) in rows.iter().enumerate() {
        if count != 0.0 {
            continue;
        }
        let frame = &frames[index];
        let mut source_id = frame.path(&["_styk", "frameId"]).filter(|id| id.truthy()).and_then(Value::as_str).map(str::to_string);
        if source_id.is_none() {
            let mut suffix = index + 1;
            let name = loop {
                let name = format!("export-hidden-{suffix}");
                suffix += 1;
                if !source_ids.contains(&name) {
                    break name;
                }
            };
            source_ids.push(name.clone());
            extra.push((name.clone(), frame.clone()));
            source_id = Some(name);
        }
        for target in &targets {
            if !authored.contains(&channel_id(target, "pose")?) {
                add(start, Value::str(source_id.as_deref().unwrap_or("")), target, Some(index))?;
            }
        }
    }
    for channel in channels.iter().filter(|channel| channel.get("property").and_then(Value::as_str) == Some("pose")) {
        for key in items(channel.get("keys")) {
            if truthy(key.get("hidden")) {
                let source = key.path(&["value", "frameId"]).cloned().filter(|id| !id.is_null()).unwrap_or(Value::Null);
                add(number(&key, "tick").unwrap_or(f64::NAN), source, channel.get("target").unwrap_or(&Value::Null), None)?;
            }
        }
    }
    let mut events: Vec<Exposure> = groups.into_iter().map(|(_, group)| group).collect();
    events.sort_by(|a, b| a.tick.partial_cmp(&b.tick).unwrap_or(std::cmp::Ordering::Equal));
    Ok((events, extra))
}

/// The offset a layer's parallax gives a figure (`parallaxResolver(report, frame)`): the layers move against the camera's
/// travel, and a figure joined to another moves with the layer of the figure at the root of its chain.
struct Parallax {
    offsets: Vec<(String, [f64; 2])>,
    roots: HashMap<u32, u32>,
    layers: Option<Value>,
}

impl Parallax {
    fn of(&self, uid: u32) -> [f64; 2] {
        if self.offsets.is_empty() {
            return [0.0, 0.0];
        }
        let root = self.roots.get(&uid).copied().unwrap_or(uid);
        let layers = self.layers.as_ref();
        let id = layers.and_then(|layers| layers.get("assignments")).and_then(|assignments| assignments.get(&root.to_string())).or_else(|| layers.and_then(|layers| layers.get("defaultLayerId"))).and_then(Value::as_str).unwrap_or("");
        self.offsets.iter().find(|(layer, _)| layer == id).map_or([0.0, 0.0], |&(_, offset)| offset)
    }
}

impl Context {
    fn parallax(&self, frame: &Value, tick: f64) -> Result<Parallax, EditError> {
        let none = Parallax { offsets: Vec::new(), roots: HashMap::new(), layers: None };
        let Some(layers) = self.report.path(&["_styk", "layers"]).filter(|layers| layers.truthy()) else { return Ok(none) };
        if matches!(layers.path(&["fixed", "camera", "visible"]), Some(Value::Bool(false))) {
            return Ok(none);
        }
        let travel = self.editor().camera_travel_at(frame, tick)?.filter(|camera| !truthy(camera.get("is_default")));
        let at = |key: &str| travel.as_ref().and_then(|camera| camera.get(key)).filter(|v| !v.is_null()).map_or(0.0, |v| v.as_f64().unwrap_or(f64::NAN));
        let impulse = |key: &str| travel.as_ref().and_then(|camera| camera.path(&["_parallaxMotionOffset", key])).filter(|v| !v.is_null()).and_then(Value::as_f64).unwrap_or(0.0);
        let mut offsets = Vec::new();
        for id in items(layers.get("order")) {
            let Some(id) = id.as_str() else { continue };
            let Some(parallax) = layers.path(&["byId", id, "parallax"]).filter(|p| truthy(p.get("enabled"))) else { continue };
            let reference = |key: &str| parallax.path(&["reference", key]).and_then(Value::as_f64).unwrap_or(f64::NAN);
            let response = |key: &str| parallax.get(key).and_then(Value::as_f64).unwrap_or(f64::NAN);
            offsets.push((id.to_string(), [(1.0 - response("x")) * (at("x") - impulse("x") - reference("x")), (1.0 - response("y")) * (at("y") - impulse("y") - reference("y"))]));
        }
        if offsets.is_empty() {
            return Ok(none);
        }
        // Only joined members need identity mapping; path compression keeps long chains linear.
        let objects = items(frame.get("objects"));
        let mut slot_roots: HashMap<usize, u32> = HashMap::new();
        let mut roots: HashMap<u32, u32> = HashMap::new();
        for i in 0..objects.len() {
            if objects[i].get("join").is_none_or(|join| !join.truthy()) || slot_roots.contains_key(&i) {
                continue;
            }
            let mut slot = i;
            let mut chain = Vec::new();
            while objects.get(slot).and_then(|object| object.get("join")).is_some_and(Value::truthy) && !slot_roots.contains_key(&slot) && chain.len() <= objects.len() {
                chain.push(slot);
                slot = number(objects[slot].get("join").unwrap(), "target_object_slot").map_or(usize::MAX, |slot| slot as usize);
            }
            let uid = slot_roots.get(&slot).copied().or_else(|| objects.get(slot).and_then(|object| number(object, "unique_id")).map(|uid| uid as u32)).or_else(|| number(&objects[i], "unique_id").map(|uid| uid as u32));
            let Some(uid) = uid else { continue };
            for part in chain {
                slot_roots.insert(part, uid);
                if let Some(own) = number(&objects[part], "unique_id") {
                    roots.insert(own as u32, uid);
                }
            }
        }
        Ok(Parallax { offsets, roots, layers: Some(layers.clone()) })
    }
}

/// How the materialization of one document goes.
struct Bake<'a> {
    hold: &'a Hold<'a>,
}

impl Bake<'_> {
    fn check(&self) -> Result<(), EditError> {
        self.hold.check()
    }
}

/// `materializePivotDocument(report)`.
pub(super) fn materialize(hold: &Hold<'_>, context: &Context) -> Result<Value, EditError> {
    let bake = Bake { hold };
    bake.document(context)
}

impl Bake<'_> {
    fn document(&self, context: &Context) -> Result<Value, EditError> {
        let report = &context.report;
        if super::has_surfaces(report) {
            return Err(invalid("errors.pivotExportMaterialize.pivotCannotPreserveOneSidedFillsSaveAs"));
        }
        if super::has_rig_constraints(report) {
            return Err(invalid("errors.pivotExportMaterialize.pivotCannotPreserveConnectorsOrSmartStretchSave"));
        }
        let working = without_native_sheet(&stored_frame_report(report)?);
        let context = &context.derive(working.clone())?;
        let report = &context.report;
        if !items(report.get("keyframes")).is_empty() && has_movieclips(report) {
            return self.movieclips(context);
        }
        if items(report.get("keyframes")).is_empty() {
            // The working placeholder is absent from native stored-frame export. Its authored overlays cannot create stored
            // exposures after Delete All.
            let mut probe = report.clone();
            set(&mut probe, "keyframes", Value::array(vec![placeholder()]));
            crate::load::validate_scene(&probe)?;
            let mut output = report.clone();
            set(&mut output, "total_output_frames", Value::Num(0.0));
            set(&mut output, "duration_seconds", Value::Num(0.0));
            if report.get("_styk").is_some_and(Value::truthy) {
                let mut styk = report.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
                for key in ["animation", "cameraMotion", "layers", "frameSources"] {
                    styk.remove(key);
                }
                set(&mut output, "_styk", Value::object(styk));
            }
            return Ok(output);
        }
        if !needs_materialization(report)? {
            return Ok(report.clone());
        }
        crate::load::validate_animation(report)?;
        if let Some(layers) = report.path(&["_styk", "layers"]) {
            crate::load::validate_layer_state(layers)?;
        }
        self.bake(context)
    }

    /// A document with movieclips: every tick expanded into the figures of its clips, then baked as any other.
    fn movieclips(&self, context: &Context) -> Result<Value, EditError> {
        let report = &context.report;
        let mut materializer = styk_eval::materialize::Materializer::new(report, &context.prepared).map_err(EditError::from)?;
        let rows = crate::timeline::rows(report);
        let total = crate::timeline::total_ticks(&rows);
        if total > MAX_FRAMES {
            return Err(invalid("errors.pivotExportMaterialize.movieclipExportExceedsThe100000FrameLimit"));
        }
        let mut frames = Vec::new();
        let mut objects = 0usize;
        let mut index = 0usize;
        let mut tick = 0.0;
        while tick < total {
            self.check()?;
            while index + 1 < rows.len() && rows[index + 1].start <= tick {
                index += 1;
            }
            let row = rows[index];
            let sample = context.sample_interval(index, if row.count != 0.0 { (tick - row.start) / row.count } else { 0.0 }, tick)?;
            let parallax = context.parallax(&sample, tick)?;
            let camera = context.editor().camera_at_time(&sample, tick)?;
            let mut moved = sample.as_obj().cloned().unwrap_or_default();
            if let Some(camera) = camera {
                moved.set("camera", camera);
            } else {
                moved.remove("camera");
            }
            let shifted: Vec<Value> = items(sample.get("objects")).into_iter().map(|object| {
                let [x, y] = parallax.of(number(&object, "unique_id").unwrap_or(f64::NAN) as u32);
                if x != 0.0 || y != 0.0 {
                    let mut next = object.as_obj().cloned().unwrap_or_default();
                    next.set("root_x", Value::Num(number(&object, "root_x").unwrap_or(f64::NAN) + x));
                    next.set("root_y", Value::Num(number(&object, "root_y").unwrap_or(f64::NAN) + y));
                    Value::object(next)
                } else {
                    object
                }
            }).collect();
            moved.set("objects", Value::array(shifted));
            let mut frame = materializer.frame(&Value::object(moved)).map_err(EditError::from)?;
            remove(&mut frame, "_cameraMotionTick");
            set(&mut frame, "duration_raw", Value::Num(1.0));
            objects += items(frame.get("objects")).len();
            if objects > MAX_OBJECTS {
                return Err(invalid("errors.pivotExportMaterialize.movieclipExportExceedsTheObjectLimit"));
            }
            frames.push(frame);
            tick += 1.0;
        }
        let mut metadata = report.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
        for key in ["animation", "frameSources", "movieclipSource", "layerSheet"] {
            metadata.remove(key);
        }
        let fixed = metadata.get("layers").and_then(|layers| layers.get("fixed")).cloned();
        metadata.remove("layers");
        metadata.remove("cameraMotion");
        let mut output = report.as_obj().cloned().unwrap_or_default();
        output.set("figure_types", Value::array(materializer.figures().to_vec()));
        output.set("keyframes", Value::array(frames));
        output.set("_styk", Value::object(metadata));
        output.set("auto_easing", Value::Bool(false));
        output.set("auto_easing_disabled_raw", Value::Num(1.0));
        let mut output = Value::object(output);
        if let Some(fixed) = fixed {
            // `ensureLayerState(output).fixed = fixed`
            let mut styk = output.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
            let mut layers = crate::layers::created_state().as_obj().cloned().unwrap_or_default();
            layers.set("fixed", fixed);
            styk.set("layers", Value::object(layers));
            set(&mut output, "_styk", Value::object(styk));
        }
        self.document(&context.derive(output)?)
    }

    /// The bake itself: the native keys, or every tick, as the stored frames of a new document.
    fn bake(&self, context: &Context) -> Result<Value, EditError> {
        let report = &context.report;
        let channels = active_channels(report);
        let layers = report.path(&["_styk", "layers"]);
        let sheet = truthy(report.path(&["_styk", "layerSheet"]));
        let version = number(report, "version").unwrap_or(5.0);
        let hidden_layer = layers.is_some_and(|layers| items(layers.get("order")).iter().any(|id| id.as_str().is_some_and(|id| matches!(layers.path(&["byId", id, "visible"]), Some(Value::Bool(false))))));
        let authored = version < 5.0 || camera_features(report) || sheet || has_ik(report) || has_frame_easing(report) || !channels.is_empty() || has_animation_origins(report) || has_native_style_overrides(report) || hidden_layer;
        let rows = native_rows(report);
        let output_rows = crate::timeline::rows(report);
        let total_ticks = crate::timeline::total_ticks(&output_rows);
        let (hidden, extra) = if authored && !sheet { hidden_exposures(report, &rows, &channels)? } else { (Vec::new(), Vec::new()) };
        let keyframes = items(report.get("keyframes"));
        let output_count = if authored { total_ticks + hidden.len() as f64 } else { keyframes.len() as f64 };
        if output_count < 1.0 || output_count > MAX_FRAMES {
            return Err(crate::invalid_with("errors.pivotExportMaterialize.nativePivotExportNeedsKeysTheSupportedLimit", vec![("value", Value::str(&grouped(output_count))), ("value1", Value::str(&grouped(MAX_FRAMES)))]));
        }
        let mut output = report.as_obj().cloned().unwrap_or_default();
        let mut backgrounds = items(report.get("backgrounds"));
        let mut figure_types = items(report.get("figure_types"));
        // Materialized per-segment styles use Pivot 5. Convert the untouched legacy colors too, before changing their
        // interpretation in the output document.
        let legacy = version < 5.0;
        let segment_color_types: Vec<f64> = figure_types.iter().filter(|figure| figure.path(&["_styk", "colorMode"]).and_then(Value::as_str) == Some("segments")).filter_map(|figure| number(figure, "figure_type_id")).collect();
        if sheet || legacy {
            output.set("version", Value::Num(5.0));
        }
        if legacy {
            figure_types = figure_types.iter().map(|figure| portable_figure(figure, true)).collect();
            backgrounds = backgrounds.iter().map(portable_background).collect();
        }
        let mut styles = StyleTable::new(&figure_types);
        if let Some(styk) = output.get("_styk").filter(|styk| styk.truthy()) {
            let mut styk = styk.as_obj().cloned().unwrap_or_default();
            for key in ["animation", "cameraMotion", "layers", "frameSources", "layerSheet"] {
                styk.remove(key);
            }
            output.set("_styk", Value::object(styk));
        }
        if authored {
            output.set("auto_easing", Value::Bool(false));
            output.set("auto_easing_disabled_raw", Value::Num(1.0));
            output.set("auto_easing_source", Value::str("file"));
        }
        let mut colors: Vec<(f64, f64)> = backgrounds.iter().filter(|bg| number(bg, "kind") == Some(2.0)).filter_map(|bg| Some((number(bg, "color")?, number(bg, "background_id")?))).collect();
        let mut used: Vec<f64> = backgrounds.iter().filter_map(|bg| number(bg, "background_id")).collect();
        let mut next_background = 1.0;
        let mut object_count = 0usize;
        let mut stored: Vec<Value> = Vec::new();
        {
            let mut color_id = |color: f64, backgrounds: &mut Vec<Value>| -> Result<f64, EditError> {
                if let Some(&(_, id)) = colors.iter().find(|(known, _)| *known == color) {
                    return Ok(id);
                }
                if backgrounds.len() >= MAX_BACKGROUNDS {
                    return Err(invalid("errors.pivotExportMaterialize.animatedSceneColorsExceedTheNativePivotBackground"));
                }
                while used.contains(&next_background) {
                    next_background += 1.0;
                }
                let id = next_background;
                next_background += 1.0;
                used.push(id);
                colors.push((color, id));
                let mut background = Obj::new();
                background.set("background_id", Value::Num(id));
                background.set("kind", Value::Num(2.0));
                background.set("color", Value::Num(color));
                background.set("name", Value::str(&format!("Color #{:06x}", (color as i64 as u32) & 0xffffff)));
                backgrounds.push(Value::object(background));
                Ok(id)
            };
            let mut append = |frame: &Value, tick: f64, duration: f64, figure_types: &mut Vec<Value>, backgrounds: &mut Vec<Value>| -> Result<(), EditError> {
                let objects_in = items(frame.get("objects"));
                let solved = if objects_in.iter().any(|object| truthy(object.get("join")) || crate::ik::has_pinned(object)) { Some(context.solved(frame)?) } else { None };
                let parallax = context.parallax(frame, tick)?;
                let mut old_to_new: HashMap<usize, usize> = HashMap::new();
                let mut objects: Vec<Obj> = Vec::new();
                for (slot, object) in objects_in.iter().enumerate() {
                    let uid = number(object, "unique_id").unwrap_or(f64::NAN);
                    if !layer_visible(report, uid as u32) {
                        continue;
                    }
                    old_to_new.insert(slot, objects.len());
                    let mut next = object.as_obj().cloned().unwrap_or_default();
                    next.set("object_slot", Value::Num(objects.len() as f64));
                    next.remove("runtime_segments");
                    let type_id = number(object, "figure_type_id").unwrap_or(f64::NAN);
                    if legacy && !segment_color_types.contains(&type_id) {
                        crate::figure_clipboard::modernize_legacy_object_color(&mut next);
                    }
                    let group = solved.as_ref().and_then(|solved| solved.get(slot)).and_then(Option::as_ref);
                    if let Some(angles) = group.and_then(|group| group.angles.as_ref()) {
                        next.set("angles", Value::array(angles.iter().map(|&angle| Value::Num(angle)).collect()));
                    }
                    if let Some(lengths) = group.and_then(|group| group.lengths.as_ref()) {
                        next.set("len_flag", Value::Num(1.0));
                        next.set("lengths", Value::array(lengths.iter().map(|&length| Value::Num(length)).collect()));
                    }
                    next.remove("_stykIK");
                    next.remove("_stykAnimationOrigin");
                    next.remove("_stykZIndex");
                    next.set("figure_type_id", Value::Num(styles.id(object, figure_types)?));
                    next.remove("_stykStyle");
                    if truthy(object.get("join")) {
                        let Some(group) = group else { return Err(invalid("errors.pivotExportMaterialize.anExportedFigureHasUnresolvedJoinedGeometry")) };
                        next.set("root_x", Value::Num(group.root[0]));
                        next.set("root_y", Value::Num(group.root[1]));
                    }
                    let [dx, dy] = parallax.of(uid as u32);
                    next.set("root_x", Value::Num(next.get("root_x").and_then(Value::as_f64).unwrap_or(f64::NAN) + dx));
                    next.set("root_y", Value::Num(next.get("root_y").and_then(Value::as_f64).unwrap_or(f64::NAN) + dy));
                    objects.push(next);
                }
                let uids: Vec<Value> = objects.iter().map(|object| object.get("unique_id").cloned().unwrap_or(Value::Null)).collect();
                for object in objects.iter_mut() {
                    let Some(join) = object.get("join").filter(|join| join.truthy()).cloned() else { continue };
                    let parent = number(&join, "target_object_slot").and_then(|slot| old_to_new.get(&(slot as usize)).copied());
                    match parent {
                        None => object.set("join", Value::Null),
                        Some(parent) => {
                            let mut next = join.as_obj().cloned().unwrap_or_default();
                            next.set("target_object_slot", Value::Num(parent as f64));
                            next.set("target_unique_id", uids[parent].clone());
                            object.set("join", Value::object(next));
                        }
                    }
                }
                object_count += objects.len();
                if object_count > MAX_OBJECTS {
                    return Err(invalid("errors.pivotExportMaterialize.theComposedPivotExportExceedsTheTwoMillion"));
                }
                let order: Vec<usize> = frame.get("object_draw_order").and_then(Value::numbers).map(|order| order.into_iter().map(|slot| slot as usize).collect()).unwrap_or_else(|| (0..objects_in.len()).collect());
                let order: Vec<usize> = order.into_iter().filter_map(|slot| old_to_new.get(&slot).copied()).collect();
                let mut next = frame.as_obj().cloned().unwrap_or_default();
                next.set("duration_raw", Value::Num(duration));
                let count = objects.len();
                next.set("objects", Value::array(objects.into_iter().map(Value::object).collect()));
                next.set("object_count", Value::Num(count as f64));
                next.set("keyframe_index", Value::Num(stored.len() as f64));
                next.set("object_draw_order", Value::array(order.iter().map(|&slot| Value::Num(slot as f64)).collect()));
                next.set("object_draw_order_unique_ids", Value::array(order.iter().map(|&slot| uids[slot].clone()).collect()));
                without_frame_identity(&mut next);
                let scene_hidden = matches!(report.path(&["_styk", "layers", "fixed", "scene", "visible"]), Some(Value::Bool(false)));
                if scene_hidden || next.get("_stykBackgroundColor").is_some() {
                    let color = if scene_hidden { 0.0 } else { next.get("_stykBackgroundColor").and_then(Value::as_f64).unwrap_or(f64::NAN) };
                    next.set("background_id", Value::Num(color_id(color, backgrounds)?));
                    next.set("background_id_b", Value::Num(0.0));
                    next.set("background_mix", Value::Num(0.0));
                }
                match context.editor().camera_at_time(frame, tick)? {
                    Some(camera) => next.set("camera", camera),
                    None => {
                        next.remove("camera");
                    }
                }
                next.remove("_cameraMotionTick");
                next.remove("_stykBackgroundColor");
                if matches!(report.path(&["_styk", "layers", "fixed", "camera", "visible"]), Some(Value::Bool(false))) {
                    let mut camera = Obj::new();
                    camera.set("is_default", Value::Bool(true));
                    for (key, value) in [("x", 0.0), ("y", 0.0), ("scale", 1.0), ("angle_rad", 0.0)] {
                        camera.set(key, Value::Num(value));
                    }
                    next.set("camera", Value::object(camera));
                }
                // Existing aliases must agree with the authoritative native exposure.
                next.set("hidden", Value::Bool(duration == 0.0));
                next.set("inbetweens", Value::Num(duration - 1.0));
                next.set("duration_frames", Value::Num(duration));
                stored.push(Value::object(next));
                Ok(())
            };
            if !authored {
                for (index, frame) in keyframes.iter().enumerate() {
                    self.check()?;
                    let sample = context.sample_interval(index, 0.0, rows[index].0)?;
                    append(&sample, rows[index].0, number(frame, "duration_raw").unwrap_or(f64::NAN), &mut figure_types, &mut backgrounds)?;
                }
            } else {
                let mut hidden_index = 0;
                let source_metadata = if extra.is_empty() {
                    report.get("_styk").cloned()
                } else {
                    let mut styk = report.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
                    let mut sources = report.path(&["_styk", "frameSources"]).and_then(Value::as_obj).cloned().unwrap_or_default();
                    for (id, frame) in &extra {
                        sources.set(id, frame.clone());
                    }
                    styk.set("frameSources", Value::object(sources));
                    Some(Value::object(styk))
                };
                let mut tick = 0.0;
                while tick <= total_ticks {
                    self.check()?;
                    while hidden_index < hidden.len() && hidden[hidden_index].tick == tick {
                        let exposure = &hidden[hidden_index];
                        hidden_index += 1;
                        let mut kept: Vec<Value> = channels.iter().filter(|channel| channel.get("id").and_then(Value::as_str).is_none_or(|id| !exposure.targets.iter().any(|(known, _)| known == id))).cloned().collect();
                        for (id, target) in &exposure.targets {
                            let mut key = Obj::new();
                            key.set("id", Value::str("export-hidden-pose"));
                            key.set("tick", Value::Num(tick));
                            let mut value = Obj::new();
                            value.set("frameId", exposure.source_id.clone());
                            key.set("value", Value::object(value));
                            key.set("interpolation", Value::str("hold"));
                            let mut channel = Obj::new();
                            channel.set("id", Value::str(id));
                            channel.set("target", target.clone());
                            channel.set("property", Value::str("pose"));
                            channel.set("keys", Value::array(vec![Value::object(key)]));
                            kept.push(Value::object(channel));
                        }
                        let mut animation = report.path(&["_styk", "animation"]).and_then(Value::as_obj).cloned().unwrap_or_default();
                        animation.set("channels", Value::array(kept));
                        let mut styk = source_metadata.as_ref().and_then(Value::as_obj).cloned().unwrap_or_default();
                        styk.set("animation", Value::object(animation));
                        let mut temporary = report.clone();
                        set(&mut temporary, "_styk", Value::object(styk));
                        let temporary = context.derive(temporary)?;
                        let sample = temporary.sample_at(&rows, tick, exposure.native_index)?;
                        append(&sample, tick, 0.0, &mut figure_types, &mut backgrounds)?;
                    }
                    if tick < total_ticks {
                        let sample = context.sample_at(&rows, tick, None)?;
                        append(&sample, tick, 1.0, &mut figure_types, &mut backgrounds)?;
                    }
                    tick += 1.0;
                }
            }
        }
        output.set("backgrounds", Value::array(backgrounds));
        output.set("keyframes", Value::array(stored));
        output.set("total_output_frames", Value::Num(total_ticks));
        output.set("duration_seconds", Value::Num(total_ticks / number(&Value::object(output.clone()), "fps").unwrap_or(f64::NAN)));
        output.set("figure_types", Value::array(figure_types.into_iter().map(|figure| {
            if !figure.path(&["_styk", "animationOrigin"]).is_some_and(Value::truthy) {
                return figure;
            }
            let mut metadata = figure.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
            metadata.remove("animationOrigin");
            let mut next = figure.as_obj().cloned().unwrap_or_default();
            next.set("_styk", Value::object(metadata));
            Value::object(next)
        }).collect()));
        let output = Value::object(output);
        crate::load::validate_scene(&output)?;
        Ok(output)
    }
}

/// `{objects: [], duration_raw: 0}`: the frame a document without stored frames is validated with.
fn placeholder() -> Value {
    let mut frame = create_frame(&[]);
    set(&mut frame, "duration_raw", Value::Num(0.0));
    frame
}

impl Context {
    /// `sampleAt(report, rows, tick, hidden)`: the frame at `tick`, its row picked from the native rows (a hidden exposure
    /// is its own native key).
    pub(super) fn sample_at(&self, rows: &[(f64, f64)], tick: f64, native: Option<usize>) -> Result<Value, EditError> {
        let mut low = 0usize;
        let mut high = rows.len().saturating_sub(1);
        while low < high {
            let mid = (low + high + 1) / 2;
            if rows[mid].0 <= tick {
                low = mid;
            } else {
                high = mid - 1;
            }
        }
        let (start, count) = rows.get(low).copied().unwrap_or((0.0, 0.0));
        let fraction = if native.is_some() { 0.0 } else if count > 0.0 { ((tick - start) / count).clamp(0.0, 1.0) } else { 0.0 };
        self.sample_interval(native.unwrap_or(low), fraction, tick)
    }

    /// `evaluatedFrame(report, index, t, tick)`.
    pub(super) fn sample_interval(&self, index: usize, t: f64, tick: f64) -> Result<Value, EditError> {
        let records = self.records()?;
        Ok(if truthy(self.report.path(&["_styk", "layerSheet"])) { records.evaluated_with(tick, true)? } else { records.evaluated_interval(index, t, tick)? })
    }
}
