//! The editor's load normalization in the engine (`prepareEditorLoadSteps`).
//!
//! Opening a document runs the same transformation and the same refusals as the JavaScript editor, in the
//! same order, on the document store: pose sequences expanded, a zero-key animation given its working frame,
//! the scene, drawings, audio, layers, authored animation, layer sheet, legacy movieclips and frame identities
//! validated or normalized, and the indexes the editor builds from the result (next identities, figures per
//! layer, tracks) returned with it. It runs in one piece: the engine runs it off the interface thread, so
//! it needs none of the JavaScript's time slicing.
//!
//! The owner is `styk-edit` because the validators it shares with the commands (rig behavior, effects, camera
//! motion, audio, paint) live here and the session starts on the document it returns; the refusals are
//! `EditError::Invalid` with the editor's message key (or its plain message where it has none, or
//! [`js::TYPE_ERROR`] where the JavaScript throws a `TypeError` on a malformed document). Their parameters
//! (the labels in `must be a finite number`) are not carried yet. The checks are transcribed from the
//! JavaScript and recorded against it (`tests/load.rs` replays the recordings).

mod animation;
mod drawings;
mod figure;
mod frames;
mod js;
mod layer_state;
mod legacy;
mod movieclip;
mod object;
mod scene;
mod sheet;

use styk_doc::{Obj, Value};

use self::js::*;
use crate::EditError;

pub use self::js::TYPE_ERROR;
pub(crate) use self::object::{object_pose as validate_object_pose, spatial_pose};
pub(crate) use self::scene::projected_drawing;
pub(crate) use self::sheet::initialize as initialize_layer_sheet;

/// `validateScene({...report, figure_types: definitions, backgrounds: [], keyframes: [a frame without figures]})`: whether the
/// definitions a paste adds are ones the document may hold.
pub(crate) fn validate_definitions(report: &Value, definitions: &[Value]) -> Result<(), EditError> {
    let mut source = report.as_obj().cloned().unwrap_or_default();
    source.set("figure_types", Value::array(definitions.to_vec()));
    source.set("backgrounds", Value::array(Vec::new()));
    source.set("keyframes", Value::array(vec![crate::sheet::create_frame(&[])]));
    scene::validate_scene(&Value::object(source), None)
}

/// `validateScene({...report, figure_types: [], backgrounds: [background], keyframes: [createFrame([])]})`: whether
/// `background` is a scene asset the document may hold.
pub(crate) fn validate_background(report: &Value, background: &Value) -> Result<(), EditError> {
    if !matches!(background.get("kind").and_then(Value::as_f64), Some(0.0 | 1.0 | 2.0 | 3.0 | 4.0)) {
        return fail("errors.editorScene.expectedADecodedImageColorOrGradientBackground");
    }
    let mut source = report.as_obj().cloned().unwrap_or_default();
    source.set("figure_types", Value::array(Vec::new()));
    source.set("backgrounds", Value::array(vec![background.clone()]));
    source.set("keyframes", Value::array(vec![crate::sheet::create_frame(&[])]));
    scene::validate_scene(&Value::object(source), None)
}

/// What `validateScene` checks of a figure definition beyond its hierarchy and rig, for the edits that change one:
/// the segments' pose choices, the figure's pose-choice groups and its 3D mesh.
pub(crate) fn validate_figure_extensions(figure: &Value) -> Result<(), EditError> {
    for segment in items(figure.get("segments")) {
        figure::pose_choice(&segment)?;
    }
    figure::figure_pose_choices(figure)?;
    figure::spatial_mesh(figure)
}

/// `validateSurface(polygon, ids)`: the face visibility a polygon holds, against the handles of its figure.
pub(crate) fn validate_surface(polygon: &Value, handles: &[f64]) -> Result<(), EditError> {
    let mut known = NumberSet::default();
    for &handle in handles {
        known.insert(handle);
    }
    figure::surface(polygon, &known)
}

/// `validateScene(report)`: the figure definitions, backgrounds and frames of a document.
pub(crate) fn validate_scene(report: &Value) -> Result<(), EditError> {
    scene::validate_scene(report, None)
}

/// `validateLayerState(state)`.
pub(crate) fn validate_layer_state(state: &Value) -> Result<(), EditError> {
    layer_state::validate(Some(state))
}

/// `validateMovieclipGraph(report)`: movieclips nest at most eight deep, a document holds at most 4096 assets, and each asset is valid.
pub(crate) fn validate_movieclip_graph(report: &Value) -> Result<(), EditError> {
    movieclip::graph(report)
}

/// `validateAnimationDocument(report)`: the authored channels of `report._styk.animation`.
pub(crate) fn validate_animation(report: &Value) -> Result<(), EditError> {
    animation::validate_document(report)
}

/// What `prepareEditorLoad` returns: the normalized report and the indexes the editor adopts.
#[derive(Clone, Debug)]
pub struct Prepared {
    pub report: Value,
    pub next_frame_identity: f64,
    pub next_uid: f64,
    /// How many poses hold each figure (`layerUidCounts`), in order of first appearance.
    pub layer_uid_counts: Vec<(f64, i64)>,
    /// Every figure seen, in order (`layerSeenUids`).
    pub layer_seen_uids: Vec<f64>,
    /// The figures on each layer, by layer in stacking order (`layerGroups`).
    pub layer_groups: Vec<(String, Vec<f64>)>,
    /// The name and type of each figure (`figureNames`).
    pub figure_names: Vec<(f64, FigureName)>,
    /// The poses of each figure on the native timeline (`tracks`).
    pub tracks: Vec<Track>,
    /// Whether the document stored a frame draft (`_styk.simpleFrameDraft`) when it was opened.
    pub saved_draft: bool,
}

#[derive(Clone, Debug)]
pub struct FigureName {
    pub name: Value,
    pub figure_type_id: Value,
}

#[derive(Clone, Debug)]
pub struct Track {
    pub uid: f64,
    pub name: Value,
    pub type_id: Value,
    pub frames: Vec<usize>,
}

impl Prepared {
    /// The indexes as JSON: the shape the load recordings hold.
    pub fn indexes(&self) -> Value {
        let number = |n: f64| Value::Num(n);
        let pairs = |items: Vec<Value>| Value::array(items);
        let mut out = Obj::new();
        out.set("nextFrameIdentity", number(self.next_frame_identity));
        out.set("nextUid", number(self.next_uid));
        out.set("layerUidCounts", pairs(self.layer_uid_counts.iter().map(|(uid, count)| Value::array(vec![number(*uid), number(*count as f64)])).collect()));
        out.set("layerSeenUids", pairs(self.layer_seen_uids.iter().map(|uid| number(*uid)).collect()));
        out.set(
            "layerGroups",
            pairs(self.layer_groups.iter().map(|(id, uids)| Value::array(vec![Value::str(id), pairs(uids.iter().map(|uid| number(*uid)).collect())])).collect()),
        );
        out.set(
            "figureNames",
            pairs(
                self.figure_names
                    .iter()
                    .map(|(uid, entry)| {
                        let mut named = Obj::new();
                        named.set("name", entry.name.clone());
                        named.set("figureTypeId", entry.figure_type_id.clone());
                        Value::array(vec![number(*uid), Value::object(named)])
                    })
                    .collect(),
            ),
        );
        out.set(
            "tracks",
            pairs(
                self.tracks
                    .iter()
                    .map(|track| {
                        let mut object = Obj::new();
                        object.set("uid", number(track.uid));
                        object.set("name", track.name.clone());
                        object.set("typeId", track.type_id.clone());
                        object.set("frames", Value::array(track.frames.iter().map(|f| number(*f as f64)).collect()));
                        Value::object(object)
                    })
                    .collect(),
            ),
        );
        Value::object(out)
    }
}

/// `prepareEditorLoad(document)`: the report is `document.document ?? document.report ?? document`.
pub fn prepare_editor_load(document: Value) -> Result<Prepared, EditError> {
    let mut report = or(get(Some(&document), "document"), or(get(Some(&document), "report"), Some(&document))).cloned().unwrap_or(Value::Null);
    movieclip::graph(&report)?;
    let indexes = prepare(&mut report)?;
    let saved_draft = truthy(path(Some(&report), &["_styk", "simpleFrameDraft"]));
    Ok(Prepared { report, saved_draft, ..indexes })
}

/// What the app's editor does to a document it opens: [`prepare_editor_load`], then, when the editor has a
/// layer timeline, the layer sheet it gives every document (`initializeLayerSheet`).
pub fn prepare_for_editor(document: Value, layer_timeline: bool) -> Result<Prepared, EditError> {
    let mut prepared = prepare_editor_load(document)?;
    if layer_timeline {
        sheet::initialize(&mut prepared.report)?;
    }
    Ok(prepared)
}

/// A value at `steps` of `root`, mutably: object keys and array slots.
enum Step<'a> {
    Key(&'a str),
    Slot(usize),
}

fn child_mut<'a>(root: &'a mut Value, steps: &[Step]) -> Option<&'a mut Value> {
    let mut at = root;
    for step in steps {
        at = match step {
            Step::Key(key) => at.make_obj()?.get_mut(key)?,
            Step::Slot(index) => at.make_arr()?.get_mut(*index)?,
        };
    }
    Some(at)
}

/// Runs `prepare` on the document at `steps` of `report`, in place.
fn prepare_child(report: &mut Value, steps: &[Step]) -> Result<(), EditError> {
    let Some(slot) = child_mut(report, steps) else { return Ok(()) };
    let mut nested = slot.clone();
    prepare(&mut nested)?;
    if let Some(slot) = child_mut(report, steps) {
        *slot = nested;
    }
    Ok(())
}

fn empty_frame() -> Value {
    let mut camera = Obj::new();
    camera.set("is_default", Value::Bool(true));
    camera.set("x", Value::Num(0.0));
    camera.set("y", Value::Num(0.0));
    camera.set("scale", Value::Num(1.0));
    camera.set("angle_rad", Value::Num(0.0));
    let mut frame = Obj::new();
    frame.set("duration_raw", Value::Num(1.0));
    frame.set("background_id", Value::Num(0.0));
    frame.set("background_id_b", Value::Num(0.0));
    frame.set("background_mix", Value::Num(0.0));
    frame.set("camera", Value::object(camera));
    frame.set("objects", Value::array(Vec::new()));
    frame.set("object_draw_order", Value::array(Vec::new()));
    frame.set("object_draw_order_unique_ids", Value::array(Vec::new()));
    Value::object(frame)
}

/// The shared `figure_types` of a movieclip source that inherits its figures (`movieclipSourceDocument`).
fn inherited_source(report: &Value) -> Option<Value> {
    let descriptor = path(Some(report), &["_styk", "movieclipSource"]);
    if !truthy(descriptor) || !truthy(get(descriptor, "inheritFigures")) {
        return None;
    }
    let mut source = get(descriptor, "document")?.as_obj()?.clone();
    source.set("figure_types", report.get("figure_types").cloned().unwrap_or(Value::Null));
    Some(Value::object(source))
}

/// `nextUidAfter(next, uid)`.
fn next_uid_after(next: f64, uid: f64) -> f64 {
    if uid <= 2_147_483_646.0 { next.max(uid + 1.0) } else { next }
}

/// `prepareEditorLoadSteps` on a document that has passed the movieclip graph check.
fn prepare(report: &mut Value) -> Result<Prepared, EditError> {
    frames::expand_pose_sequences(report)?;
    // Pivot permits a zero-key animation. One private editable working pose stands for it.
    let empty = is_array(report.get("keyframes")) && len(report.get("keyframes")) == 0;
    if empty {
        report.make_obj().ok_or_else(|| refuse(TYPE_ERROR))?.set("keyframes", Value::array(vec![empty_frame()]));
    }
    scene::validate_scene(report, None)?;
    drawings::validate(report)?;
    let audio = path(Some(report), &["_styk", "audio"]);
    if truthy(audio) {
        for (_, asset) in entries(get(audio, "assets")) {
            crate::audio::check_asset(asset)?;
        }
        crate::audio::check_state(audio.unwrap())?;
    }
    // A source that inherits the figures shares them with this document, and so does the preparation of their clips.
    let mut assets_prepared = false;
    if let Some(mut source) = inherited_source(report) {
        let had_styk = truthy(path(Some(report), &["_styk", "movieclipSource", "document", "_styk"]));
        let had_frames = len(path(Some(report), &["_styk", "movieclipSource", "document", "keyframes"])) > 0;
        prepare(&mut source)?;
        let figures = source.get("figure_types").cloned();
        if let Some(figures) = figures {
            report.make_obj().unwrap().set("figure_types", figures);
        }
        let write_back = |report: &mut Value, key: &str| {
            if let (Some(value), Some(document)) = (source.get(key).cloned(), child_mut(report, &[Step::Key("_styk"), Step::Key("movieclipSource"), Step::Key("document")])) {
                if let Some(object) = document.make_obj() {
                    object.set(key, value);
                }
            }
        };
        if had_styk {
            write_back(report, "_styk");
        }
        if had_frames {
            write_back(report, "keyframes");
        }
        assets_prepared = true;
    } else if truthy(path(Some(report), &["_styk", "movieclipSource"])) && !missing(path(Some(report), &["_styk", "movieclipSource", "document"])) {
        let descriptor = path(Some(report), &["_styk", "movieclipSource"]);
        if truthy(get(descriptor, "document")) {
            prepare_child(report, &[Step::Key("_styk"), Step::Key("movieclipSource"), Step::Key("document")])?;
        }
    }
    if !assets_prepared {
        let figures = items(report.get("figure_types"));
        for (index, figure) in figures.iter().enumerate() {
            if truthy(movieclip::asset(figure)) {
                prepare_child(report, &[Step::Key("figure_types"), Step::Slot(index), Step::Key("_styk"), Step::Key("movieclip"), Step::Key("document")])?;
            }
        }
    }
    layer_state::ensure(report)?;
    layer_state::validate(path(Some(report), &["_styk", "layers"]))?;
    animation::validate_document(report)?;
    layer_state::validate_sheet(report)?;
    let legacy = path(Some(report), &["_styk", "layerSheet", "legacyAnimation"]);
    if truthy(legacy) {
        // `legacySheetReport(report)`: the sheet's own animation stands for the document's, without the sheet.
        let mut styk = report.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
        styk.set("animation", legacy.unwrap().clone());
        styk.remove("layerSheet");
        let mut stand_in = report.as_obj().cloned().unwrap_or_default();
        stand_in.set("_styk", Value::object(styk));
        animation::validate_document(&Value::object(stand_in))?;
    }
    if legacy::has_clips(report) {
        legacy::normalize(report)?;
    }
    frames::intern_pose_sequences(report)?;
    let mut next_frame_identity = frames::validate_frame_identity(report)?;
    if empty {
        if !missing(path(Some(report), &["_styk", "simpleFrameDraft"])) {
            return fail("errors.editorLoad.anEmptyNativeAnimationCannotContainASaved");
        }
        if next_frame_identity > 9_007_199_254_740_991.0 {
            return fail("errors.clipboardLegacyUpgrade.frameIdentityCapacityExceeded");
        }
        let id = format!("frame-{}", number_text(next_frame_identity));
        next_frame_identity += 1.0;
        let mut identity = Obj::new();
        identity.set("frameId", Value::str(&id));
        if let Some(frame) = child_mut(report, &[Step::Key("keyframes"), Step::Slot(0)]).and_then(Value::make_obj) {
            frame.set("_styk", Value::object(identity));
        }
        let mut draft = Obj::new();
        draft.set("version", Value::Num(1.0));
        draft.set("mode", Value::str("add"));
        draft.set("index", Value::Num(0.0));
        draft.set("frameId", Value::str(&id));
        draft.set("empty", Value::Bool(true));
        if let Some(styk) = child_mut(report, &[Step::Key("_styk")]).and_then(Value::make_obj) {
            styk.set("simpleFrameDraft", Value::object(draft));
        }
    }
    frames::validate_simple_frame_draft(report)?;
    let sources: Vec<Value> = entries(path(Some(report), &["_styk", "frameSources"])).into_iter().map(|(_, frame)| frame.clone()).collect();
    if !sources.is_empty() {
        scene::validate_scene(report, Some(&sources))?;
    }
    let draft = path(Some(report), &["_styk", "simpleFrameDraft"]);
    if truthy(get(draft, "baseline")) {
        scene::validate_scene(report, Some(&[get(draft, "baseline").unwrap().clone()]))?;
    }
    if has_own(draft, "animationBaseline") {
        let mut styk = report.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
        styk.set("animation", get(draft, "animationBaseline").cloned().unwrap_or(Value::Null));
        let mut stand_in = report.as_obj().cloned().unwrap_or_default();
        stand_in.set("_styk", Value::object(styk));
        animation::validate_document(&Value::object(stand_in))?;
    }
    index(report, sources, next_frame_identity)
}

/// The indexes of a validated document, and the frame identities its keyframes lack.
fn index(report: &mut Value, sources: Vec<Value>, mut next_frame_identity: f64) -> Result<Prepared, EditError> {
    let layers = path(Some(report), &["_styk", "layers"]);
    let order: Vec<String> = items(get(layers, "order")).iter().filter_map(|id| id.as_str().map(str::to_string)).collect();
    let mut groups: Vec<(String, Vec<f64>)> = order.iter().map(|id| (id.clone(), Vec::new())).collect();
    let mut counts: Vec<(f64, i64)> = Vec::new();
    let mut count_at: std::collections::HashMap<u64, usize> = std::collections::HashMap::new();
    let mut seen: Vec<f64> = Vec::new();
    let mut seen_keys: std::collections::HashSet<u64> = std::collections::HashSet::new();
    let mut tracks: Vec<Track> = Vec::new();
    let mut track_at: std::collections::HashMap<u64, usize> = std::collections::HashMap::new();
    let mut names: Vec<(f64, FigureName)> = Vec::new();
    let key_of = |n: f64| if n == 0.0 { 0.0f64.to_bits() } else { n.to_bits() };
    let definitions: std::collections::HashMap<u64, Value> = items(report.get("figure_types")).into_iter().filter_map(|f| num(f.get("figure_type_id")).map(|id| (key_of(id), f))).collect();
    let native = items(report.get("keyframes"));
    let mut next_uid = 1.0f64;
    let mut missing_ids: Vec<(usize, String)> = Vec::new();
    for (index, frame) in native.iter().chain(sources.iter()).enumerate() {
        let is_native = index < native.len();
        for step in movieclip::steps(frame) {
            next_uid = next_uid_after(next_uid, num(step.get("uid")).unwrap_or(f64::NAN));
        }
        if is_native && !truthy(path(Some(frame), &["_styk", "frameId"])) {
            if next_frame_identity > 9_007_199_254_740_991.0 {
                return fail("errors.clipboardLegacyUpgrade.frameIdentityCapacityExceeded");
            }
            missing_ids.push((index, format!("frame-{}", number_text(next_frame_identity))));
            next_frame_identity += 1.0;
        }
        for object in items(frame.get("objects")) {
            let uid = num(object.get("unique_id")).unwrap_or(f64::NAN);
            next_uid = next_uid_after(next_uid, uid);
            match count_at.get(&key_of(uid)) {
                Some(slot) => counts[*slot].1 += 1,
                None => {
                    count_at.insert(key_of(uid), counts.len());
                    counts.push((uid, 1));
                }
            }
            if seen_keys.insert(key_of(uid)) {
                seen.push(uid);
                let layer = layer_state::layer_of(report, uid).unwrap_or_default();
                if let Some(group) = groups.iter_mut().find(|(id, _)| *id == layer) {
                    group.1.push(uid);
                } else {
                    return Err(refuse(TYPE_ERROR));
                }
            }
            if is_native {
                let slot = match track_at.get(&key_of(uid)) {
                    Some(slot) => *slot,
                    None => {
                        let figure_type = object.get("figure_type_id").cloned().unwrap_or(Value::Null);
                        let own = path(Some(&object), &["_styk", "name"]).filter(|n| n.truthy());
                        let defined = num(Some(&figure_type)).and_then(|id| definitions.get(&key_of(id))).and_then(|f| f.get("name")).filter(|n| n.truthy());
                        let name = own.or(defined).cloned().unwrap_or_else(|| Value::str(&format!("Figure {}", number_text(uid))));
                        names.push((uid, FigureName { name: name.clone(), figure_type_id: figure_type.clone() }));
                        tracks.push(Track { uid, name, type_id: figure_type, frames: Vec::new() });
                        track_at.insert(key_of(uid), tracks.len() - 1);
                        tracks.len() - 1
                    }
                };
                tracks[slot].frames.push(index);
            }
        }
    }
    for (index, id) in missing_ids {
        let Some(frame) = child_mut(report, &[Step::Key("keyframes"), Step::Slot(index)]).and_then(Value::make_obj) else { continue };
        let mut identity = frame.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
        identity.set("frameId", Value::str(&id));
        frame.set("_styk", Value::object(identity));
    }
    Ok(Prepared {
        report: Value::Null,
        next_frame_identity,
        next_uid,
        layer_uid_counts: counts,
        layer_seen_uids: seen,
        layer_groups: groups,
        figure_names: names,
        tracks,
        saved_draft: false,
    })
}
