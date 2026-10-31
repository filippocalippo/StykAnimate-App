//! An edit session as the interface drives it: calls in, JSON out.
//!
//! The session starts from the document the engine already holds (the mirror) and the
//! editor state the document does not carry, runs the editor's calls by name, and
//! answers with everything the JavaScript editor would show for the same call: the
//! returned value, the playhead and selection, the change events, the gesture's draft,
//! and the parts of the document a command published. `src/engine/engine-owner.mjs`
//! applies it to the JavaScript editor (docs/engine/editing.md).

use std::collections::HashSet;
use std::sync::Arc;

use styk_doc::{Obj, Value};

use crate::{EditError, Editor, Options, Selection};

/// The start of the message of a read the session does not answer for this document.
pub const UNPORTED: &str = "unported: ";

pub struct Session {
    pub(crate) editor: Editor,
}

mod worker;
pub use worker::{WorkerFrame, WorkerPrepared, WorkerSession};

/// Exact counters supplied by the existing history owner during worker handoff.
#[derive(Clone, Copy, Debug)]
pub struct RevisionCounters {
    pub revision: u64,
    pub serial: u64,
    pub saved: u64,
}

fn number(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

fn flag(value: &Value, key: &str) -> bool {
    value.get(key).is_some_and(Value::truthy)
}

/// `sheetSelection` of a view: the layer chosen on the timeline and whether it follows seeks.
fn sheet_selection_of(view: &Value) -> Option<(&str, bool)> {
    let chosen = view.get("sheetSelection").filter(|s| s.is_object())?;
    Some((chosen.get("id").and_then(Value::as_str)?, chosen.get("contents").is_some_and(Value::truthy)))
}

fn selection_of(view: &Value) -> Selection {
    Selection {
        uid: number(view, "selectedUid").map(|v| v as u32),
        uids: view.get("selectedUids").and_then(Value::numbers).unwrap_or_default().into_iter().map(|v| v as u32).collect(),
        joint: number(view, "selectedJoint").unwrap_or(-1.0) as i64,
    }
}

/// `set_view` only assigns these stored values. An unchanged parsed view can
/// borrow its UID sequence instead of allocating two equal replacement vectors.
/// Missing/non-numeric sequences retain `selection_of`'s existing fallback.
fn view_unchanged(editor: &Editor, view: &Value) -> bool {
    if editor.tick.to_bits() != number(view, "tick").unwrap_or(0.0).to_bits()
        || editor.frame_index != number(view, "frameIndex").unwrap_or(0.0) as usize
        || editor.selection.uid != number(view, "selectedUid").map(|value| value as u32)
        || editor.selection.joint != number(view, "selectedJoint").unwrap_or(-1.0) as i64
    {
        return false;
    }
    view.get("selectedUids").and_then(Value::elements).is_some_and(|uids| {
        uids.len() == editor.selection.uids.len()
            && uids.iter().zip(&editor.selection.uids).all(|(value, &uid)| value.as_f64().is_some_and(|value| value as u32 == uid))
    })
}

/// These response fields have unique, nonnumeric keys, appended in the same
/// order as the JSON owner emits them. Build their existing ordered shape once
/// rather than replacing the shape after each missing-key `Obj::set`.
fn response_value(fields: Vec<(&'static str, Value)>) -> Value {
    let (keys, values): (Vec<Arc<str>>, Vec<Value>) = fields.into_iter().map(|(key, value)| (Arc::from(key), value)).unzip();
    Value::object(Obj::from_shape(styk_doc::Shape::new(keys), values))
}

/// The accepted ordered scalar patch from the existing project-settings event.
/// Refuse any other stored change (including zero-history source pruning) rather
/// than publishing a partial report. No history entry is read after trimming.
fn project_fields_publication(before: &Value, report: &Value, event: &Value) -> Option<Value> {
    if event.get("kind").and_then(Value::as_str) != Some("edit")
        || ["live", "layerSheet", "definition", "structural", "animation"].iter().any(|key| event.get(key).is_some_and(Value::truthy))
    { return None; }
    let label = event.get("label")?.as_str()?;
    let timing = event.get("timing")?;
    if !matches!(timing, Value::Bool(_)) { return None; }
    let keys = event.get("projectFields")?.elements()?;
    if keys.len() == 0 || keys.len() > 4 { return None; }
    let keys: Vec<Value> = keys.iter().collect();
    let (old, new) = (before.as_obj()?, report.as_obj()?);
    // This opt-in preparation is bounded; wider unknown root records keep the
    // original conversion/response and the facade's existing fallback.
    if old.len() > 64 || new.len() > 64 { return None; }
    let mut names = Vec::with_capacity(keys.len());
    let mut fields = Vec::with_capacity(keys.len());
    for key in &keys {
        let key = key.as_str()?;
        if !["fps", "frame_delay_ms", "canvas_width", "canvas_height"].contains(&key) || names.contains(&key) { return None; }
        let value = new.get(key)?;
        if !matches!(value, Value::Null) && !value.as_f64().is_some_and(f64::is_finite) { return None; }
        names.push(key);
        fields.push(Value::array(vec![Value::str(key), value.clone()]));
    }
    if old.iter().any(|(key, value)| !names.contains(&key.as_ref()) && !new.get(key).is_some_and(|current| current.same_node(value)))
        || new.keys().any(|key| !old.contains(key) && !names.contains(&key.as_ref()))
    { return None; }
    let mut order: Vec<&str> = old.keys().map(|key| key.as_ref()).collect();
    order.extend(names.iter().copied().filter(|key| !old.contains(key)));
    if !order.into_iter().eq(new.keys().map(|key| key.as_ref())) { return None; }
    Some(response_value(vec![("label", Value::str(label)), ("timing", timing.clone()), ("fields", Value::array(fields))]))
}

/// The COW figures the call replaced, without evaluation's runtime movieclip clock.
/// A draft keeps its slots; a retained frame can also add, remove or reorder figures.
fn changed_figures(frame: &Value, previous: Option<&Value>, taken: Option<&HashSet<u32>>) -> Vec<Value> {
    let objects = frame.get("objects").and_then(Value::elements);
    let before = previous.and_then(|frame| frame.get("objects")).and_then(Value::elements);
    objects.map(|objects| objects.iter().enumerate().filter_map(|(slot, figure)| {
        let uid = crate::record::uid(&figure)?;
        // Figures the gesture did not take do not change, except one added to its draft
        // meanwhile (drawn while posing), which was not in the draft before the call.
        let added = before.is_some_and(|objects| !objects.iter().any(|old| crate::record::uid(&old) == Some(uid)));
        if taken.is_some_and(|taken| !taken.contains(&uid)) && !added {
            return None;
        }
        if before.and_then(|objects| objects.get(slot)).is_some_and(|old| crate::record::uid(&old) == Some(uid) && old.same_node(&figure)) {
            return None;
        }
        // Ordinary pose drafts already are immutable COW records. Reuse their
        // values without copying every field just to remove an absent runtime
        // movieclip clock; the serialized figure remains identical.
        if figure.get("_movieclipSample").is_none() {
            Some(figure)
        } else {
            let mut figure = figure.as_obj().cloned().unwrap_or_default();
            figure.remove("_movieclipSample");
            Some(Value::object(figure))
        }
    }).collect()).unwrap_or_default()
}

/// A frame as its difference from `base`, the frame it was composed on: the figures that
/// changed (`figures`), the figure order when it moved (`order`), and the other fields that
/// differ (`fields`), went (`removed`) or moved (`fieldOrder`). The owner lays them over its
/// copy of `base`. Composing copies every figure, so they are told apart by value: a copy
/// shares its children with the figure it came from, which makes the comparison shallow.
fn frame_delta(frame: &Value, base: &Value) -> Value {
    let mut out = Obj::new();
    let before: Vec<Value> = base.get("objects").and_then(Value::elements).map(|objects| objects.iter().collect()).unwrap_or_default();
    let figures = frame.get("objects").and_then(Value::elements).map(|objects| objects.iter().enumerate().filter(|(slot, figure)| before.get(*slot) != Some(figure)).map(|(_, figure)| {
        let mut figure = figure.as_obj().cloned().unwrap_or_default();
        figure.remove("_movieclipSample");
        Value::object(figure)
    }).collect()).unwrap_or_default();
    out.set("figures", Value::array(figures));
    let order = figure_order(frame);
    if order != figure_order(base) {
        out.set("order", Value::array(order));
    }
    let (previous, current) = (base.as_obj().cloned().unwrap_or_default(), frame.as_obj().cloned().unwrap_or_default());
    let mut fields = Obj::new();
    for (key, value) in current.iter().filter(|(key, _)| &***key != "objects") {
        if previous.get(key) != Some(value) {
            fields.set(key, value.clone());
        }
    }
    if !fields.is_empty() {
        out.set("fields", Value::object(fields));
    }
    let removed: Vec<Value> = previous.keys().filter(|key| &***key != "objects" && !current.contains(key)).map(|key| Value::str(key)).collect();
    if !removed.is_empty() {
        out.set("removed", Value::array(removed));
    }
    if !previous.keys().eq(current.keys()) {
        out.set("fieldOrder", Value::array(current.keys().map(|key| Value::str(key)).collect()));
    }
    Value::object(out)
}

fn figure_order(frame: &Value) -> Vec<Value> {
    frame.get("objects").and_then(Value::elements).map(|objects| objects.iter().filter_map(|figure| crate::record::uid(&figure)).map(|uid| Value::Num(uid as f64)).collect()).unwrap_or_default()
}

/// A renamed existing definition keeps every other shallow child and key order.
/// Read the command result/reports, never a history entry that may be trimmed.
fn movieclip_rename_publication(before: &Value, original: &Value, report: &Value, result: &Value, events: &[Value]) -> Option<Value> {
    let previous = before.get("figure_types")?.elements()?;
    let figures = report.get("figure_types")?.elements()?;
    if previous.len() != figures.len() { return None; }
    let index = previous.iter().position(|figure| figure.same_node(original))?;
    let renamed = figures.get(index)?;
    let old = original.as_obj()?;
    let fields = renamed.as_obj()?;
    let before_name = original.get("name")?.as_str()?;
    let name = renamed.get("name")?.as_str()?;
    if !old.keys().eq(fields.keys())
        || fields.iter().any(|(key, value)| key.as_ref() != "name" && !old.get(key).is_some_and(|old| old.same_node(value)))
        || previous.iter().zip(figures.iter()).enumerate().any(|(slot, (old, new))| slot != index && !old.same_node(&new))
    { return None; }
    if name == before_name {
        if !result.is_null() || !events.is_empty() || !renamed.same_node(original) { return None; }
    } else {
        if !result.same_node(&renamed) || events.len() != 1 { return None; }
        let event = &events[0];
        if event.get("kind").and_then(Value::as_str) != Some("edit")
            || event.get("label").and_then(Value::as_str) != Some("Rename movieclip")
            || event.get("structural") != Some(&Value::Bool(true)) || event.get("timing") != Some(&Value::Bool(true))
            || event.get("definition") != Some(&Value::Bool(true))
            || event.get("live").is_some_and(Value::truthy) || event.get("layerSheet").is_some_and(Value::truthy)
        { return None; }
    }
    Some(response_value(vec![("index", Value::Num(index as f64)), ("beforeName", Value::str(before_name)), ("name", Value::str(name))]))
}

/// The existing split command's stored changes, projected from its COW reports.
/// History may already have trimmed the new command, so never read this from undo.
fn split_topology_publication(before: &Value, report: &Value) -> Option<Value> {
    if before.get("keyframes")?.array_len()? != report.get("keyframes")?.array_len()? { return None; }
    let old = before.get("figure_types")?.elements()?;
    let figures = report.get("figure_types")?.elements()?;
    if old.len() != figures.len() { return None; }
    let mut replaced = None;
    for (index, figure) in figures.iter().enumerate() {
        let previous = old.get(index)?;
        if previous.same_node(&figure) { continue; }
        if replaced.is_some() || previous.get("figure_type_id") != figure.get("figure_type_id")
            || previous.path(&["_styk", "animationOrigin"]).is_some()
        { return None; }
        replaced = Some((index, figure));
    }
    let (index, figure) = replaced?;
    let mut frames = Vec::new();
    for place in crate::topology::places(report) {
        let frame = crate::topology::frame_at(report, &place)?;
        let previous = crate::topology::frame_at(before, &place)?;
        if previous.same_node(frame) { continue; }
        // This packet replaces poses only. Unsupported frame shape changes use
        // the original JS command instead of silently losing metadata or slots.
        let previous_fields = previous.as_obj()?;
        let fields = frame.as_obj()?;
        if !previous_fields.keys().eq(fields.keys())
            || fields.iter().any(|(key, value)| key.as_ref() != "objects"
                && !previous_fields.get(key).is_some_and(|old| old.same_node(value)))
        { return None; }
        let old_objects = previous.get("objects")?.elements()?;
        let current_objects = frame.get("objects")?.elements()?;
        if old_objects.len() != current_objects.len()
            || old_objects.iter().zip(current_objects.iter()).any(|(old, current)|
                crate::record::uid(&current).is_none() || crate::record::uid(&old) != crate::record::uid(&current))
        { return None; }
        let objects = changed_figures(frame, Some(previous), None);
        if objects.is_empty() { continue; }
        let mut fields = match place {
            crate::topology::Place::Keyframe(index) => vec![("index", Value::Num(index as f64))],
            crate::topology::Place::Source(id) => vec![("index", Value::Num(-1.0)), ("sourceId", Value::str(&id))],
            // A retained source document is not part of this packet.
            crate::topology::Place::Retained(..) => return None,
        };
        fields.push(("objects", Value::array(objects)));
        frames.push(response_value(fields));
    }
    let mut fields = vec![("index", Value::Num(index as f64)), ("figure", figure), ("frames", Value::array(frames))];
    for (key, path) in [
        ("animation", &["_styk", "animation"][..]),
        ("sheetAnimation", &["_styk", "layerSheet", "legacyAnimation"][..]),
    ] {
        let previous = before.path(path);
        let current = report.path(path);
        if matches!((previous, current), (None, None))
            || previous.zip(current).is_some_and(|(previous, current)| previous.same_node(current))
        { continue; }
        let mut change = vec![("exists", Value::Bool(current.is_some()))];
        if let Some(current) = current { change.push(("value", current.clone())); }
        fields.push((key, response_value(change)));
    }
    Some(response_value(fields))
}

/// A command-specific certificate for the existing definition + sheet batch.
/// The payload remains in the ordinary answer fields, not a second history format.
fn movieclip_unique_publication(before: &Value, original: &Value, report: &Value, result: &Value, events: &[Value]) -> Option<Value> {
    if events.len() != 5 { return None; }
    let edit = |event: &Value, label: &str, definition: bool, sheet: bool| {
        event.get("kind").and_then(Value::as_str) == Some("edit")
            && event.get("label").and_then(Value::as_str) == Some(label)
            && event.get("structural") == Some(&Value::Bool(true))
            && event.get("timing") == Some(&Value::Bool(true))
            && event.get("definition").is_some_and(Value::truthy) == definition
            && event.get("layerSheet").is_some_and(Value::truthy) == sheet
            && !event.get("live").is_some_and(Value::truthy)
    };
    if !edit(&events[0], "Create movieclip", true, false)
        || !edit(&events[1], "Make movieclip unique", false, true)
        || events[2].get("kind").and_then(Value::as_str) != Some("seek")
        || events[3].get("kind").and_then(Value::as_str) != Some("selection")
        || !edit(&events[4], "Make movieclip unique", false, false)
        || events[2..4].iter().any(|event| ["structural", "timing", "definition", "layerSheet", "live"].iter().any(|key| event.get(key).is_some_and(Value::truthy)))
    { return None; }
    let old = before.get("figure_types")?.elements()?;
    let figures = report.get("figure_types")?.elements()?;
    if figures.len() != old.len() + 1
        || !old.iter().zip(figures.iter()).all(|(old, figure)| old.same_node(&figure))
        || !old.iter().any(|figure| figure.same_node(original))
        || !before.get("keyframes")?.same_node(report.get("keyframes")?)
    { return None; }
    let figure = figures.get(old.len())?;
    let old_fields = original.as_obj()?;
    let fields = figure.as_obj()?;
    if !figure.same_node(result) || original.get("name")?.as_str().is_none()
        || original.path(&["_styk", "animationOrigin"]).is_some()
        || !old_fields.keys().eq(fields.keys())
        || fields.iter().any(|(key, value)| !matches!(key.as_ref(), "figure_type_id" | "name")
            && !old_fields.get(key).is_some_and(|old| old.same_node(value)))
        || !figure.get("figure_type_id")?.as_f64()?.is_finite()
        || figure.get("name")?.as_str().is_none()
    { return None; }
    // The existing response reads these sources from the final report. If
    // collection lost an intermediate capture, JS must run its original owner.
    let sources = events[1].get("sourceIds")?.elements()?;
    if sources.is_empty() { return None; }
    for id in sources.iter() {
        let id = id.as_str()?;
        let source = report.path(&["_styk", "frameSources", id])?;
        source.as_obj()?;
        source.get("objects")?.elements()?;
        if before.path(&["_styk", "frameSources", id]).is_some() { return None; }
    }
    Some(response_value(vec![("definitionIndex", Value::Num(old.len() as f64))]))
}

impl Session {
    /// `state` is JSON: the editor's options (`propertyChannels`, `layerTimeline`,
    /// `autoKey`), view (`tick`, `frameIndex`, `selectedUid`, `selectedUids`,
    /// `selectedJoint`, `activeLayerId`) and counters (`layerRevision`, `nextFrameIdentity`, `nextUid`).
    /// [`Session::start`] from typed views already made for `report` (the engine's mirror).
    pub fn start_prepared(report: Value, state: &str, loader: styk_eval::load::Loader, prepared: std::sync::Arc<styk_eval::eval::Prepared>) -> Result<Session, String> {
        Self::start_with(report, state, Some((loader, prepared)))
    }

    /// Worker-only initialization from an actually fresh, empty-history owner.
    /// The host must refuse foreign warm history, not rebuild it from the report.
    /// Existing Rust warm Sessions move as-is through Engine::attach_session_worker.
    /// Counters come from that original owner; never infer them from the mirror.
    pub fn start_worker_prepared(report: Value, state: &str, loader: styk_eval::load::Loader, prepared: std::sync::Arc<styk_eval::eval::Prepared>, counters: RevisionCounters) -> Result<Session, String> {
        if counters.revision > counters.serial || counters.saved > counters.serial {
            return Err("the original history revision counters are invalid".into());
        }
        let mut session = Self::start_prepared(report, state, loader, prepared)?;
        session.editor.set_revision_counters(counters.revision, counters.serial, counters.saved);
        Ok(session)
    }

    pub fn start(report: Value, state: &str) -> Result<Session, String> {
        Self::start_with(report, state, None)
    }

    fn start_with(report: Value, state: &str, prepared: Option<(styk_eval::load::Loader, std::sync::Arc<styk_eval::eval::Prepared>)>) -> Result<Session, String> {
        let state = styk_doc::json::parse(state.as_bytes()).map_err(|error| error.to_string())?;
        let options = Options { property_channels: flag(&state, "propertyChannels"), layer_timeline: flag(&state, "layerTimeline"), auto_key: flag(&state, "autoKey") };
        let mut editor = Editor::new(report, options);
        editor.set_view(number(&state, "tick").unwrap_or(0.0), number(&state, "frameIndex").unwrap_or(0.0) as usize, selection_of(&state));
        // A metadata restore may inspect stable handles of the figure on show:
        // the interface session must use the mirror's already prepared owner.
        if let Some((loader, prepared)) = prepared { editor.adopt_prepared(loader, prepared); }
        editor.set_selection_metadata(&state).map_err(|error| format!("{error:?}"))?;
        let counter = |key: &str| number(&state, key).unwrap_or(0.0) as u64;
        editor.set_counters(counter("layerRevision"), counter("nextFrameIdentity"), counter("nextUid"));
        if let Some(active) = state.get("activeLayerId").and_then(Value::as_str) {
            editor.set_active_layer_id(active);
        }
        editor.set_sheet_selection(sheet_selection_of(&state));
        Ok(Session { editor })
    }

    /// Whether the session's own history can undo (it only knows the commands it ran).
    pub fn can_undo(&self) -> bool {
        self.editor.state().can_undo
    }

    pub fn can_redo(&self) -> bool {
        self.editor.state().can_redo
    }

    /// Runs `method` with the JSON array `args`. `view` (JSON, or `null`) is the
    /// editor's view just before the call: selection and seeking may have gone through
    /// calls the session did not see. With `changesOnly: true`, draft/retained figures
    /// and sheet fields carry only changed COW records; optional order/removal fields
    /// reconstruct their previous layout. Results the facade returns from its adopted
    /// document are `null`. Default answers remain complete for shadow comparison.
    /// `topologyPublication: true` opts an ordinary sheet split (including its two
    /// aliases) into an additional `topology` packet of changed stored definitions,
    /// poses and animation fields. It does not change the command or default wire.
    /// `movieclipUniquePublication: true` additionally certifies an ordinary sheet
    /// Make Unique answer with `movieclipUnique: {definitionIndex}`. Its appended
    /// definition, sheet and sources remain in their existing response fields.
    /// `layerPublication: true` requests a quiet ordinary sheet layer edit's
    /// original accepted operands as `{label, structural, updates}`. Removals
    /// preserve null versus an omitted undefined value. Layer creation may include
    /// its original `activeId`; no-op calls omit the packet.
    /// Literal `figureClipboardPastes: true` requests a successful top-level
    /// `pasteSelection`'s existing clipboard count as `{before, after}`, or null when no
    /// clipboard exists. For `duplicateSelection` this is its temporary copy,
    /// before restoration; an empty copy returns null. Other calls and
    /// unsuccessful answers omit it.
    /// Literal `projectFieldsPublication: true` requests an ordered scalar
    /// `projectFields` certificate for a quiet ordinary-sheet settings change.
    /// Default, no-op, error and unsupported responses remain unchanged.
    /// Literal `movieclipRenamePublication: true` requests a quiet ordinary
    /// sheet rename's scalar `{index, beforeName, name}` certificate, including
    /// unchanged names. Its original definition/history/result stays unchanged.
    /// Returns the answer as JSON (see the module).
    pub fn call(&mut self, method: &str, args: &str, view: &str) -> String {
        let parsed = (styk_doc::json::parse(args.as_bytes()), styk_doc::json::parse(view.as_bytes()));
        let (Ok(args), Ok(view)) = parsed else {
            let mut answer = Vec::with_capacity(8);
            answer.push(("status", Value::str("error")));
            answer.push(("error", Value::str("the call's arguments are not JSON")));
            return styk_doc::json::to_string(&response_value(answer));
        };
        let answer = { let _scope = crate::prof::scope("session::call_values"); self.call_values(method, &args, &view) };
        let _scope = crate::prof::scope("session::json");
        styk_doc::json::to_string(&answer)
    }

    /// A read of what the interface shows, at `view` (its playhead: `tick` and `frameIndex`): `kind` is `frame`, `document`, `motion`,
    /// `timeline` or `geometry` (`args`: `{since, motion}`); or the name of one of the editor's reads the session answers
    /// (`Editor::interface_query`, at the whole view: `{"v": value}`, or `{}` where the editor answers `undefined`). The answer is
    /// JSON text; the document does not change. An error that starts with [`UNPORTED`] is a document the session does not answer for.
    pub fn query(&mut self, kind: &str, args: &str, view: &str) -> Result<String, String> {
        let (args, view) = (styk_doc::json::parse(args.as_bytes()).map_err(|error| error.to_string())?, styk_doc::json::parse(view.as_bytes()).map_err(|error| error.to_string())?);
        let shown = match kind {
            "timeline" | "geometry" | "previewGeometry" | "figureDocument" | "frame" | "document" | "motion" => {
                apply_playhead(&mut self.editor, &view);
                match kind {
                    "timeline" => Ok(self.editor.interface_timeline()),
                    "geometry" => self.editor.interface_geometry(&args),
                    "previewGeometry" => self.editor.interface_preview_geometry(&args),
                    "figureDocument" => self.editor.interface_figure_document(&args),
                    other => self.editor.interface_frame(other),
                }
            }
            // What is sampled from the document besides the frame on show, at the playhead: the trails, the pose at a trail point, the
            // onion skins (as the stage takes them, `Session::onions`) and the camera.
            "trails" | "ghost" | "onions" | "shot" | "frameCamera" | "cameraSamples" | "framing" | "vfxClips" | "vfxGroup" | "vfxExtent" => {
                apply_playhead(&mut self.editor, &view);
                match kind {
                    "trails" => self.editor.interface_trails(&args),
                    "ghost" => self.editor.interface_trail_ghost(&args),
                    "onions" => self.editor.onion_summary(&styk_doc::json::to_string(&args)),
                    "vfxClips" => self.editor.interface_vfx_clips(&args),
                    "vfxGroup" => self.editor.interface_vfx_group(&args),
                    "vfxExtent" => self.editor.interface_vfx_extent(&args),
                    other => self.editor.interface_camera(other, &args),
                }
            }
            // The editor's own reads: the view is its whole state (the selection too).
            name => {
                apply_view(&mut self.editor, &view).map_err(|error| format!("{error:?}"))?;
                match self.editor.interface_query(name, &args) {
                    Some(answer) => answer.map(|value| match value {
                        Some(value) => format!("{{\"v\":{}}}", styk_doc::json::to_string(&value)),
                        None => "{}".to_string(),
                    }),
                    None => Err(EditError::Invalid(format!("the session answers no read '{name}'"))),
                }
            }
        };
        shown.map_err(|error| match error {
            EditError::Invalid(message) => message,
            // What the session does not evaluate yet: the editor reads it itself.
            EditError::Unported(message) => format!("{UNPORTED}{message}"),
        })
    }

    /// The onion skins the stage draws behind the frame on show, for the settings, the hidden figures and the selection in `request`
    /// (JSON), at `view` (its playhead). The same set while nothing it depends on changed.
    pub fn onions(&mut self, view: &str, request: &str) -> Result<Arc<crate::OnionSet>, String> {
        let view = styk_doc::json::parse(view.as_bytes()).map_err(|error| error.to_string())?;
        apply_playhead(&mut self.editor, &view);
        self.editor.onion_set(request).map_err(|error| match error {
            EditError::Invalid(message) => message,
            EditError::Unported(message) => format!("{UNPORTED}{message}"),
        })
    }

    /// The clock reads that are given a time to take are held to (milliseconds).
    pub fn set_clock(&mut self, clock: fn() -> f64) {
        self.editor.clock = Some(clock);
    }

    /// The frame the stage draws, at `view` (its playhead): the gesture in progress, else the document at the playhead; with `motion`,
    /// the motion-path edit's display where one is shown. The frame is typed and its scene built (the geometry the interface reads
    /// is the same scene, `crate::shown`); no text is made.
    pub fn show(&mut self, view: &str, motion: bool) -> Result<Arc<crate::ShownScene>, String> {
        let view = styk_doc::json::parse(view.as_bytes()).map_err(|error| error.to_string())?;
        apply_playhead(&mut self.editor, &view);
        let refused = |error| match error {
            EditError::Invalid(message) => message,
            EditError::Unported(message) => format!("{UNPORTED}{message}"),
        };
        let displayed = if motion { self.editor.shown_scene(true, crate::Flavor::Sampled).map_err(refused)? } else { None };
        match displayed {
            Some(shown) => Ok(shown),
            None => self.editor.shown_scene(false, crate::Flavor::Sampled).map_err(refused)?.ok_or_else(|| "the frame on show has no scene".to_string()),
        }
    }

    /// The same command and response owner over already decoded COW values.
    /// This worker-only boundary avoids whole-answer JSON serialization: its
    /// returned value stays worker-owned until the common bounded packet ACK.
    /// Arguments and view must also be decoded/admitted on that worker; this
    /// method does not enable an owning editor on both UI and worker.
    pub fn call_values(&mut self, method: &str, args: &Value, view: &Value) -> Value {
        call_values(&mut self.editor, method, args, view, false, None).expect("legacy response has no host cancellation callback")
    }

    /// Borrow the canonical COW report on its owning worker. The host pairs this
    /// with the acknowledged Engine generation/lineage; no report is serialized.
    pub fn report(&self) -> &Value {
        self.editor.report()
    }

    /// The typed views the session has made of its document as it is now, if it has.
    pub fn views(&self) -> Option<Arc<styk_eval::eval::Prepared>> { self.editor.views() }

    /// Takes the typed views the engine made of the session's document (`report`, as it is now): it converts it once.
    pub fn adopt_views(&self, report: &Value, prepared: Arc<styk_eval::eval::Prepared>) { self.editor.adopt_views(report, prepared) }

    /// Actual owning history revision, for worker handoff validation.
    pub fn revision(&self) -> u64 { self.editor.revision }

    /// Scalar checkpoint of the exact prepared owner, never a reconstructed sum.
    pub fn history_checkpoint_worker(&self) -> Option<f64> { self.editor.history_size() }

    /// Prepare the existing exact history owner before accepting worker calls.
    /// A warm session uses its original owner checkpoint, never a reconstructed sum.
    pub fn prepare_worker_history(
        &mut self,
        limits: crate::HistoryLimits,
        checkpoint: f64,
        check: impl FnMut() -> Result<(), EditError>,
    ) -> Result<(), EditError> {
        self.editor.prepare_worker_history(limits, checkpoint, check)
    }

    /// Immutable preparation using the SAME Session/editor/response owner.
    /// This retains the existing quiet-editor requirement; gesture/preflight
    /// requests require their separately recorded worker boundary.
    pub fn prepare_worker_call_values(
        &mut self,
        method: &str,
        args: &Value,
        view: &Value,
        check: impl FnMut() -> Result<(), EditError>,
    ) -> Result<crate::publication::PreparedPublication, EditError> {
        self.editor.prepare_worker_publication(
            |editor, check| {
                check()?;
                let answer = call_values(editor, method, args, view, true, Some(&mut *check))?;
                check()?;
                Ok(answer)
            },
            check,
        )
    }

    /// Worker-only final validation before the Engine's atomic publication hook.
    /// Refusal returns the immutable payload for durable worker disposal.
    pub fn guard_worker_publication_checked<'a>(
        &'a mut self,
        prepared: crate::publication::PreparedPublication,
        check: impl FnMut() -> Result<(), EditError>,
    ) -> Result<crate::publication::GuardedPublication<'a>, (EditError, crate::publication::PreparedPublication)> {
        prepared.guard_worker_checked(&mut self.editor, check)
    }
}

/// Puts the editor's playhead, selection and settings where the interface has them (the view of a
/// call, or of a read of what the interface shows).
fn apply_view(editor: &mut Editor, view: &Value) -> Result<(), EditError> {
    if !view.is_object() {
        return Ok(());
    }
    if !view_unchanged(editor, view) {
        let (tick, frame_index) = (number(view, "tick").unwrap_or(0.0), number(view, "frameIndex").unwrap_or(0.0) as usize);
        // The editor seeked without the session (D19): the frame it kept on show is gone, as after `seek`.
        if tick.to_bits() != editor.tick.to_bits() || frame_index != editor.frame_index { editor.retained = None; }
        editor.set_view(tick, frame_index, selection_of(view));
    }
    editor.sync_selection_metadata(view)?;
    editor.set_auto_key(flag(view, "autoKey"));
    editor.audio_ripple = flag(view, "audioRipple");
    // Focus and lock: the layers outside the focus are locked for this call (the focus is the interface's, never the document's).
    editor.set_layer_focus_lock_of(view);
    // Selecting changes the active layer without a new revision of the document.
    if let Some(active) = view.get("activeLayerId").and_then(Value::as_str) {
        editor.set_active_layer_id(active);
    }
    editor.set_sheet_selection(sheet_selection_of(view));
    Ok(())
}

/// Puts the editor's playhead where the interface has it, leaving the selection and settings as the session last had
/// them: what the frame on show and its geometry are does not depend on them, so a read of those needs no more.
fn apply_playhead(editor: &mut Editor, view: &Value) {
    let (Some(tick), Some(frame_index)) = (number(view, "tick"), number(view, "frameIndex")) else { return };
    let frame_index = frame_index as usize;
    if tick.to_bits() != editor.tick.to_bits() || frame_index != editor.frame_index {
        // The editor seeked without the session (D19): the frame it kept on show is gone, as after `seek`.
        editor.retained = None;
        let selection = editor.selection.clone();
        editor.set_view(tick, frame_index, selection);
    }
}

/// Shared by legacy JSON calls and canonical worker transactions.
fn call_values(editor: &mut Editor, method: &str, args: &Value, view: &Value, worker_preparation: bool, check: Option<&mut dyn FnMut() -> Result<(), EditError>>) -> Result<Value, EditError> {
    let prelude_scope = crate::prof::scope("call::prelude");
    let before = editor.report().clone();
    let retained = editor.retained_frame();
    let draft = editor.authored.as_ref().map(|edit| edit.frame.clone());
    let gesture_before = editor.drag.as_ref().map(|drag| drag.serial);
    let project_requested = view.get("projectFieldsPublication") == Some(&Value::Bool(true))
        && matches!(method, "setFPS" | "setCanvasSize" | "updateProject")
        && editor.sheet() && editor.drag.is_none() && draft.is_none()
        && editor.property_edit.is_none() && editor.vfx_edit.is_none()
        && editor.native_token.is_none() && editor.batch.is_none()
        && before.path(&["_styk", "simpleFrameDraft"]).is_none()
        && before.path(&["_styk", "movieclipSource"]).is_none();
    let topology_requested = view.get("topologyPublication") == Some(&Value::Bool(true))
        && matches!(method, "splitBuilderSegments" | "splitSegment" | "splitSegmentBranch")
        && editor.sheet() && editor.drag.is_none() && draft.is_none()
        && editor.property_edit.is_none() && editor.vfx_edit.is_none()
        && editor.native_token.is_none() && editor.batch.is_none()
        && before.path(&["_styk", "simpleFrameDraft"]).is_none()
        && before.path(&["_styk", "movieclipSource"]).is_none();
    let unique_requested = view.get("movieclipUniquePublication") == Some(&Value::Bool(true))
        && method == "makeMovieclipUnique" && editor.sheet()
        && editor.drag.is_none() && draft.is_none()
        && editor.property_edit.is_none() && editor.vfx_edit.is_none()
        && editor.native_token.is_none() && editor.batch.is_none()
        && before.path(&["_styk", "simpleFrameDraft"]).is_none()
        && before.path(&["_styk", "movieclipSource"]).is_none();
    let layer_requested = view.get("layerPublication") == Some(&Value::Bool(true))
        && matches!(method, "createLayerFolder" | "renameLayerFolder" | "moveLayersToFolder" | "arrangeLayers" | "deleteLayerFolder"
            | "renameLayer" | "setLayerColor" | "setLayerVisible" | "setLayerLocked" | "reorderLayers" | "moveLayerTo" | "createLayer" | "setLayerParallax")
        && !(method == "createLayer" && args.elements().and_then(|args| args.get(1)).is_some_and(|options| options.get("drawing").is_some_and(Value::truthy)))
        && editor.sheet() && editor.drag.is_none() && draft.is_none()
        && editor.property_edit.is_none() && editor.vfx_edit.is_none()
        && editor.native_token.is_none() && editor.batch.is_none()
        && before.path(&["_styk", "simpleFrameDraft"]).is_none()
        && before.path(&["_styk", "movieclipSource"]).is_none()
        && !before.get("figure_types").and_then(Value::elements).is_some_and(|figures| figures.iter().any(|figure| figure.path(&["_styk", "animationOrigin"]).is_some()));
    let mut layer_publication = None;
    let rename_requested = view.get("movieclipRenamePublication") == Some(&Value::Bool(true))
        && method == "renameMovieclip" && editor.sheet()
        && editor.drag.is_none() && draft.is_none() && editor.property_edit.is_none()
        && editor.vfx_edit.is_none() && editor.native_token.is_none() && editor.batch.is_none()
        && before.path(&["_styk", "simpleFrameDraft"]).is_none()
        && before.path(&["_styk", "movieclipSource"]).is_none()
        && !before.get("figure_types").and_then(Value::elements).is_some_and(|figures| figures.iter().any(|figure| figure.path(&["_styk", "animationOrigin"]).is_some()));
    let mut answer = Vec::with_capacity(8);
    // Owned calls request only changed COW records. The default remains complete for
    // shadow comparison and existing native session consumers.
    let changes_only = flag(view, "changesOnly");
    // The read view takes what the call changed as a patch (`patch`, below) and nothing it published besides.
    let patched = flag(view, "patch");
    if changes_only {
        answer.push(("changesOnly", Value::Bool(true)));
    }
    if let Err(error) = apply_view(editor, view) {
        answer.push(("status", Value::str("unported")));
        answer.push(("reason", Value::str(&format!("{error:?}"))));
        return Ok(response_value(answer));
    }
    // The document the editor's read view holds is the one the call's patch is the difference from: the view's active layer
    // (the editor sets it in place when it selects) is part of it.
    let before = editor.report().clone();
    // Capture through the existing selected-definition reader after view sync.
    // Failure only omits the opt-in marker; dispatch keeps its original errors.
    let unique_original = if unique_requested { editor.selected_movieclip().ok().map(|(_, _, figure)| figure) } else { None };
    let rename_original = if rename_requested { editor.selected_movieclip().ok().map(|(_, _, figure)| figure).filter(|figure| figure.path(&["_styk", "animationOrigin"]).is_none()) } else { None };
    drop(prelude_scope);
    let command_scope = crate::prof::scope("call::command");
    // What the editor drew at random during its own run of the call (D18).
    editor.set_draws(view.get("draws").unwrap_or(&Value::Null));
    editor.draw_pool = view.get("drawPool") == Some(&Value::Bool(true));
    editor.drawing_forks.clear();
    editor.drawing_retired = false;
    // What JSON cannot say (a member set to `undefined`, a non-finite number) arrives encoded (args.rs).
    let decoded;
    let args = if flag(view, "encoded") { decoded = crate::args::decode(args, crate::args::keeps_undefined(method)); &decoded } else { args };
    let args: Vec<Value> = args.elements().map(|e| e.iter().collect()).unwrap_or_default();
    let clipboard_requested = matches!(method, "pasteSelection" | "duplicateSelection")
        && view.get("figureClipboardPastes") == Some(&Value::Bool(true));
    let clipboard_before = if clipboard_requested && method == "pasteSelection" { editor.figure_clipboard_pastes() } else { None };
    let mut duplicate_pastes = None;
    let called = if let Some(check) = check {
        // A recorded Invalid belongs in the canonical JSON response. Host
        // cancellation must instead escape the same preparation operation,
        // including a one-shot failure that later checks would not repeat.
        // This stack-local error retains no callback or authoritative state.
        let mut interrupted = None;
        let mut checked = || match check() {
            Ok(()) => Ok(()),
            Err(error) => {
                let forwarded = match &error {
                    EditError::Invalid(message) => EditError::Invalid(message.clone()),
                    EditError::Unported(message) => EditError::Unported(message.clone()),
                };
                interrupted = Some(error);
                Err(forwarded)
            }
        };
        let result = if layer_requested {
            // The original worker path delegates ordinary sheet calls to
            // Editor::call after this entry check, with the same rollback.
            checked().and_then(|()| editor.call_layer_publication(method, &args, &mut layer_publication))
        } else if clipboard_requested && method == "duplicateSelection" {
            editor.call_duplicate_pastes_checked(method, &args, true, &mut checked, &mut duplicate_pastes)
        } else { editor.call_worker_checked(method, &Value::array(args), &mut checked) };
        if let Some(error) = interrupted { return Err(error); }
        result
    } else {
        if layer_requested { editor.call_layer_publication(method, &args, &mut layer_publication) }
        else if clipboard_requested && method == "duplicateSelection" { editor.call_duplicate_pastes_checked(method, &args, false, &mut || Ok(()), &mut duplicate_pastes) }
        else { editor.call(method, &args) }
    };
    let result = called.and_then(|result| {
        // Legacy facades read these views locally. The exclusive worker has
        // the sole owner, so it returns the recorded view from that owner.
        if worker_preparation && matches!(method, "seek" | "@seek") { editor.shown_frame() }
        else if worker_preparation && method == "beginAnimationEdit" { editor.animation_edit_value_worker() }
        else { Ok(result) }
    });
    drop(command_scope);
    let _answer_scope = crate::prof::scope("call::answer");
    let topology_changed = topology_requested && matches!(&result, Ok(Value::Bool(true)));
    // The owner runs a refused call in the editor and does not adopt its answer.
    let adopted = !matches!(&result, Err(EditError::Unported(_)));
    let unique_result = unique_original.as_ref().and_then(|_| result.as_ref().ok()).cloned();
    let rename_result = rename_original.as_ref().and_then(|_| result.as_ref().ok()).cloned();
    let layer_changed = layer_requested && result.as_ref().is_ok_and(Value::truthy);
    let project_changed = project_requested && matches!(&result, Ok(Value::Bool(true)));
    // Paste keeps this same clipboard owner; duplicate captures its temporary
    // owner before restoring the saved one. Both increment after paste events.
    let clipboard_pastes = if clipboard_requested && result.is_ok() {
        if method == "duplicateSelection" { duplicate_pastes } else { match (clipboard_before, editor.figure_clipboard_pastes()) {
            (None, None) => Some(Value::Null),
            (Some(before), Some(after)) => Some(response_value(vec![("before", Value::Num(before)), ("after", Value::Num(after))])),
            _ => None,
        } }
    } else { None };
    let called_ok = result.is_ok();
    // A copy that copied something (`sheetCopyFrames` answers nothing): the interface keeps what was copied.
    let copied = if called_ok { crate::clipboards::copied_kind(method).filter(|_| method == "sheetCopyFrames" || result.as_ref().is_ok_and(Value::truthy)) } else { None };
    match result {
        Ok(result) => {
            answer.push(("status", Value::str("ok")));
            // The facade returns these views from its adopted document. Repeating
            // their complete figure/frame data in the answer serves no purpose.
            // (A paste or a duplicate that made nothing answers an empty list, which the facade cannot read from its document.)
            let adopted_view = changes_only && matches!(method, "duplicateFigure" | "addFigure" | "importFigure" | "pasteSelection" | "duplicateSelection" | "sheetAppendFrame") && result.array_len() != Some(0);
            answer.push(("result", if adopted_view { Value::Null } else { result }));
        }
        Err(EditError::Unported(what)) => {
            answer.push(("status", Value::str("unported")));
            answer.push(("reason", Value::str(&what)));
        }
        Err(EditError::Invalid(text)) => {
            answer.push(("status", Value::str("error")));
            answer.push(("error", Value::str(crate::error_key(&text))));
            if let Some(params) = crate::error_params(&text) {
                answer.push(("errorParams", params));
            }
        }
    }
    answer.push(("state", editor.state_value()));
    // The cels a call copied: the interface gives the copies the pixels of the cels they copy.
    if called_ok && !editor.drawing_forks.is_empty() {
        let forks = std::mem::take(&mut editor.drawing_forks);
        answer.push(("drawingForks", Value::array(forks.into_iter().map(|(old, new)| Value::array(vec![Value::str(&old), Value::str(&new)])).collect())));
    }
    if called_ok && std::mem::take(&mut editor.drawing_retired) {
        answer.push(("drawingRetired", Value::Bool(true)));
    }
    if let Some(kind) = copied && let Some(data) = editor.clipboard_answer(kind) {
        answer.push(("clipboard", response_value(vec![("kind", Value::str(kind)), ("data", data)])));
    }
    let events = editor.take_events();
    let report = editor.report();
    // A command published the sheet when one of its events says so, as the facade reads
    // it: layer edits also replace the sheet (its tracks follow the layers) without it.
    let published = events.iter().any(|event| event.get("layerSheet").is_some_and(Value::truthy));
    if published {
        if !patched {
            // What a command publishes: the sheet (with the tracks it replaced; `trackOrder`
            // names them all), the layers and the sources its events name.
            let styk = report.get("_styk");
            let tracks = |document: &Value| document.path(&["_styk", "layerSheet", "tracks"]).and_then(Value::as_obj).cloned().unwrap_or_default();
            let (old, new) = (tracks(&before), tracks(report));
            let changed: Vec<&std::sync::Arc<str>> = new.iter().filter(|(id, track)| !old.get(id).is_some_and(|previous| previous.same_node(track))).map(|(id, _)| id).collect();
            let current_sheet = styk.and_then(|s| s.get("layerSheet")).and_then(Value::as_obj).cloned().unwrap_or_default();
            let old_sheet = before.path(&["_styk", "layerSheet"]).and_then(Value::as_obj);
            if changes_only && !old_sheet.into_iter().flat_map(|sheet| sheet.keys()).eq(current_sheet.keys()) {
                answer.push(("sheetOrder", Value::array(current_sheet.keys().map(|key| Value::str(key)).collect())));
            }
            let mut sheet = if changes_only {
                let mut delta = Obj::new();
                for (key, value) in current_sheet.iter().filter(|(key, _)| &***key != "tracks") {
                    if !old_sheet.and_then(|sheet| sheet.get(key)).is_some_and(|old| old.same_node(value)) {
                        delta.set(key, value.clone());
                    }
                }
                let removed: Vec<Value> = old_sheet.into_iter().flat_map(|sheet| sheet.keys()).filter(|key| &***key != "tracks" && !current_sheet.contains(key)).map(|key| Value::str(key)).collect();
                if !removed.is_empty() {
                    answer.push(("sheetRemoved", Value::array(removed)));
                }
                delta
            } else { current_sheet };
            let mut replaced = Obj::new();
            for id in &changed {
                replaced.set(id, new.get(id).cloned().unwrap_or(Value::Null));
            }
            sheet.set("tracks", Value::object(replaced));
            answer.push(("sheet", Value::object(sheet)));
            if !changes_only || !old.keys().eq(new.keys()) {
                answer.push(("trackOrder", Value::array(new.keys().map(|id| Value::str(id)).collect())));
            }
            if !changes_only {
                answer.push(("changedTracks", Value::array(changed.iter().map(|id| Value::str(id)).collect())));
            }
            let layers = styk.and_then(|s| s.get("layers")).cloned().unwrap_or(Value::Null);
            if !changes_only || !before.path(&["_styk", "layers"]).is_some_and(|old| old.same_node(&layers)) {
                answer.push(("layers", layers));
            }
            let mut sources = Obj::new();
            for id in events.iter().flat_map(|event| event.get("sourceIds").and_then(Value::elements).map(|e| e.iter().collect::<Vec<_>>()).unwrap_or_default()) {
                if let Some(id) = id.as_str() {
                    sources.set(id, styk.and_then(|s| s.path(&["frameSources", id])).cloned().unwrap_or(Value::Null));
                }
            }
            answer.push(("sources", Value::object(sources)));
            // Figure definitions the publication added (a paste's copies), after the others.
            let count = |document: &Value| document.get("figure_types").and_then(Value::array_len).unwrap_or(0);
            if count(report) > count(&before) {
                let added: Vec<Value> = report.get("figure_types").and_then(Value::elements).map(|e| e.iter().skip(count(&before)).collect()).unwrap_or_default();
                answer.push(("definitions", Value::array(added)));
            }
        }
        // A committed gesture's draft stays on show (`_authoredCommitPreview`), with what
        // the commit itself changed in it (joined figures' roots from geometry): its figures.
        if let Some(frame) = editor.retained_frame().filter(|frame| !retained.as_ref().is_some_and(|old| old.same_node(frame))) {
            if changes_only {
                let previous = draft.as_ref().or(retained.as_ref());
                answer.push(("retained", Value::array(changed_figures(&frame, previous, None))));
                if let Some(previous) = previous {
                    let order = figure_order(&frame);
                    if order != figure_order(previous) {
                        answer.push(("retainedOrder", Value::array(order)));
                    }
                    answer.push(("retainedChanges", Value::Bool(true)));
                }
            } else {
                answer.push(("retained", frame.get("objects").cloned().unwrap_or(Value::Null)));
            }
            // A transaction can change frame-level order, counts or other fields as
            // well as figures. Keeping only its objects would leave the displayed
            // frame's metadata at its pre-command value.
            let previous = draft.as_ref().or(retained.as_ref()).and_then(Value::as_obj);
            let current = frame.as_obj().cloned().unwrap_or_default();
            let mut fields = Obj::new();
            for (key, value) in current.iter().filter(|(key, _)| &***key != "objects") {
                if !previous.and_then(|frame| frame.get(key)).is_some_and(|old| old.same_node(value)) {
                    fields.set(key, value.clone());
                }
            }
            if !fields.is_empty() { answer.push(("retainedFields", Value::object(fields))); }
            let removed: Vec<Value> = previous.into_iter().flat_map(|frame| frame.keys()).filter(|key| &***key != "objects" && !current.contains(key)).map(|key| Value::str(key)).collect();
            if !removed.is_empty() { answer.push(("retainedRemoved", Value::array(removed))); }
            if !previous.into_iter().flat_map(|frame| frame.keys()).eq(current.keys()) {
                answer.push(("retainedFieldOrder", Value::array(current.keys().map(|key| Value::str(key)).collect())));
            }
        }
    }
    // What a property edit shows while the inspector scrubs, or a camera drag while it moves
    // (`_sheetPropertyPreview`), for the app to compare: the frame, without the clip sample
    // times evaluation adds.
    if (method == "previewAnimationEdit" || method == "updateCameraDrag")
        && let Some(preview) = editor.property_preview()
    {
        // The owner holds the frame the edit began on: it takes the difference.
        if changes_only && method == "previewAnimationEdit" && let Some(base) = editor.property_edit_base() {
            answer.push(("previewChanges", frame_delta(&preview, &base)));
        } else if changes_only && method == "updateCameraDrag" {
            // A camera drag previews the frame on show with another camera: that is all that differs.
            answer.push(("cameraPreview", preview.get("camera").cloned().unwrap_or(Value::Null)));
        } else {
            let mut frame = preview.as_obj().cloned().unwrap_or_default();
            let objects: Vec<Value> = frame.get("objects").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
            let objects = objects.into_iter().map(|object| {
                let mut object = object.as_obj().cloned().unwrap_or_default();
                object.remove("_movieclipSample");
                Value::object(object)
            });
            frame.set("objects", Value::array(objects.collect()));
            answer.push(("preview", Value::object(frame)));
        }
    }
    if topology_changed && events.len() == 1
        && events[0].get("kind").and_then(Value::as_str) == Some("edit")
        && events[0].get("structural") == Some(&Value::Bool(true))
        && events[0].get("definition") == Some(&Value::Bool(true))
        && !events[0].get("layerSheet").is_some_and(Value::truthy)
        && !events[0].get("live").is_some_and(Value::truthy)
        && let Some(topology) = split_topology_publication(&before, report)
    {
        answer.push(("topology", topology));
    }
    if let Some((original, result)) = unique_original.as_ref().zip(unique_result.as_ref())
        && let Some(marker) = movieclip_unique_publication(&before, original, report, result, &events)
    {
        answer.push(("movieclipUnique", marker));
    }
    if layer_changed && events.len() == 1
        && events[0].get("kind").and_then(Value::as_str) == Some("edit")
        && events[0].get("layerMetadata") == Some(&Value::Bool(true))
        && events[0].get("layers") == Some(&Value::Bool(true))
        && !events[0].get("layerSheet").is_some_and(Value::truthy)
        && !events[0].get("live").is_some_and(Value::truthy)
        && !events[0].get("timing").is_some_and(Value::truthy)
        && !events[0].get("animation").is_some_and(Value::truthy)
        && let Some(publication) = layer_publication
    {
        answer.push(("layerPublication", publication));
    }
    if let Some(pastes) = clipboard_pastes { answer.push(("figureClipboardPastes", pastes)); }
    if project_changed && events.len() == 1
        && let Some(publication) = project_fields_publication(&before, report, &events[0])
    { answer.push(("projectFields", publication)); }
    if let Some((original, result)) = rename_original.as_ref().zip(rename_result.as_ref())
        && let Some(marker) = movieclip_rename_publication(&before, original, report, result, &events)
    {
        // Owned rename consumes only the certified scalars. Its held definition
        // supplies unchanged children; do not serialize its embedded document.
        if changes_only && let Some((_, result)) = answer.iter_mut().find(|(key, _)| *key == "result") { *result = Value::Null; }
        answer.push(("movieclipRename", marker));
    }
    // `patch: true`: what the call changed in the report, for the read view (D19).
    if view.get("patch") == Some(&Value::Bool(true)) {
        answer.push(("patch", { let _scope = crate::prof::scope("patch::diff"); crate::patch::diff(&before, report) }));
        answer.push(("revision", Value::Num(editor.revision as f64)));
        answer.push(("depths", Value::array(vec![Value::Num(editor.undo.len() as f64), Value::Num(editor.redo.len() as f64)])));
        // The pool's draws the call did not take, in order: the editor's next ones.
        if editor.draw_pool { answer.push(("drawsLeft", Value::array(editor.draws.iter().map(|(kind, value)| Value::array(vec![Value::str(kind), value.clone()])).collect()))); }
        // The committed frame the session still keeps on show, unchanged by the call.
        if editor.retained_frame().is_some_and(|frame| retained.as_ref().is_some_and(|old| old.same_node(&frame))) {
            answer.push(("retainedKept", Value::Bool(true)));
        }
        // The gesture draft's frame fields (draw order) when the call changed them.
        if let (Some(edit), Some(_)) = (&editor.authored, &editor.drag) {
            let previous = draft.as_ref().and_then(Value::as_obj);
            let mut fields = Obj::new();
            for (key, value) in edit.frame.as_obj().map(|frame| frame.iter().filter(|(key, _)| &***key != "objects").map(|(key, value)| (key.clone(), value.clone())).collect::<Vec<_>>()).unwrap_or_default() {
                if !previous.and_then(|frame| frame.get(&key)).is_some_and(|old| old.same_node(&value)) { fields.set(&key, value); }
            }
            if previous.is_some() && !fields.is_empty() { answer.push(("draftFields", Value::object(fields))); }
        }
        // The effect-clip and property edits the session holds, which the editor shows as its own.
        answer.push(("vfxEdit", Value::Bool(editor.vfx_edit.is_some())));
        answer.push(("animationEdit", editor.animation_edit_view(method == "beginAnimationEdit")));
        // The figure-handle, handle-edit and segment-value gesture it holds (`_drag.figureHandle` and the others).
        answer.push(("handleGesture", editor.handle_gesture_view()));
        // The motion-path edit it holds, which the editor shows as its own (`_drag`).
        match editor.motion_path_view(adopted) {
            Ok(view) => answer.push(("motionPath", view)),
            Err(error) => answer.push(("motionPathError", Value::str(&format!("{error:?}")))),
        }
        // The timeline's chosen layer, which history restores with the selection.
        answer.push(("sheetSelection", editor.sheet_selection.as_ref().map_or(Value::Null, |chosen| response_value(vec![("id", Value::str(&chosen.id)), ("contents", Value::Bool(chosen.contents))]))));
    }
    answer.push(("events", Value::array(events)));
    let figures = if changes_only {
        match (&editor.authored, &editor.drag) {
            (Some(edit), Some(drag)) => {
                let taken = drag.before.iter().filter_map(crate::record::uid).collect();
                Some(changed_figures(&edit.frame, draft.as_ref(), Some(&taken)))
            }
            _ => None,
        }
    } else { editor.draft_figures() };
    answer.push(("draft", figures.map_or(Value::Null, Value::array)));
    // A call that ended a gesture and began another: the new draft as its difference from the old one on show,
    // since figures the gestures did not take (joined ones the commit moved) changed with the first.
    if changes_only && let (Some(edit), Some(drag), Some(old), Some(previous)) = (&editor.authored, &editor.drag, gesture_before, draft.as_ref()) && drag.serial != old {
        answer.push(("draftBase", frame_delta(&edit.frame, previous)));
    }
    answer.push(("drag", editor.drag_value()));
    Ok(response_value(answer))
}

#[cfg(test)]
#[path = "session_tests.rs"]
mod tests;
