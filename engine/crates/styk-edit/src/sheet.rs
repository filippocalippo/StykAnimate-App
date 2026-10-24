//! Writing poses into a layer sheet (src/editor-layer-sheet.mjs): `_commitSheetPose`,
//! the planner (`planner`, `write`, `capture`, `materialize`), `publish`, and undo and
//! redo of what it records (`applyLayerSheetCommand`, `_pruneFrameSources`).
//!
//! Ported for gestures on existing figures. Movieclip frame replacements, drawing
//! layers, new figures and reordering answer `Unported`.

use styk_doc::{Obj, Value};
use styk_eval::records::snapshot_pose_frame_of;

use crate::frame::{layer_of, objects_of};
use crate::history::{Command, CommandKind, Direction};
use crate::record::uid;
use crate::{EditError, Editor};

pub(crate) const MAX_SHEET_TICKS: f64 = 10_000_000.0;

pub(crate) fn fixed(id: &str) -> bool {
    id == "scene" || id == "camera"
}

pub(crate) fn num(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

pub(crate) fn items(value: Option<&Value>) -> Vec<Value> {
    value.and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default()
}

fn json(value: Option<&Value>) -> String {
    value.map(styk_doc::json::to_string).unwrap_or_default()
}

/// `createFrame(objects)` (src/demo.mjs): a frame of `objects` alone, each in its slot.
pub(crate) fn create_frame(objects: &[Value]) -> Value {
    let mut frame = Obj::new();
    frame.set("duration_raw", Value::Num(1.0));
    for key in ["background_id", "background_id_b", "background_mix"] {
        frame.set(key, Value::Num(0.0));
    }
    let mut camera = Obj::new();
    camera.set("is_default", Value::Bool(true));
    for (key, value) in [("x", 0.0), ("y", 0.0), ("scale", 1.0), ("angle_rad", 0.0)] {
        camera.set(key, Value::Num(value));
    }
    frame.set("camera", Value::object(camera));
    let placed: Vec<Value> = objects
        .iter()
        .enumerate()
        .map(|(slot, object)| {
            let mut object = object.as_obj().cloned().unwrap_or_default();
            object.set("object_slot", Value::Num(slot as f64));
            Value::object(object)
        })
        .collect();
    let (order, ids): (Vec<Value>, Vec<Value>) = placed.iter().enumerate().map(|(i, o)| (Value::Num(i as f64), o.get("unique_id").cloned().unwrap_or(Value::Null))).unzip();
    frame.set("objects", Value::array(placed));
    frame.set("object_draw_order", Value::array(order));
    frame.set("object_draw_order_unique_ids", Value::array(ids));
    Value::object(frame)
}

/// `continuations(frame)`.
pub(crate) fn continuations(frame: &Value) -> Vec<Value> {
    items(frame.path(&["_styk", "movieclipContinuations"]))
}

/// `frameOrder(frame)`: unique ids in drawing order.
fn frame_order(frame: &Value) -> Vec<f64> {
    let objects = objects_of(frame);
    match frame.get("object_draw_order").filter(|o| o.truthy()) {
        Some(order) => order.numbers().unwrap_or_default().into_iter().filter_map(|slot| objects.get(slot as usize).filter(|_| slot >= 0.0).and_then(|o| num(o, "unique_id"))).collect(),
        None => objects.iter().filter_map(|o| num(o, "unique_id")).collect(),
    }
}

/// `poseObjectSignature(object, frame)`: a pose without its slot and caches, its
/// join named by the figure it joins.
pub(crate) fn signature(object: &Value, frame_objects: &[Value]) -> String {
    let mut fields = object.as_obj().cloned().unwrap_or_default();
    fields.remove("runtime_segments");
    fields.remove("_movieclipSample");
    fields.remove("object_slot");
    if let Some(join) = object.get("join").filter(|j| j.truthy()) {
        let slot = num(join, "target_object_slot");
        let target = slot.filter(|s| *s >= 0.0).and_then(|s| frame_objects.get(s as usize)).and_then(|o| o.get("unique_id").cloned()).or_else(|| join.get("target_unique_id").cloned());
        let mut out = join.as_obj().cloned().unwrap_or_default();
        out.remove("target_object_slot");
        out.remove("target_unique_id");
        if let Some(target) = target {
            out.set("target_unique_id", target);
        }
        fields.set("join", Value::object(out));
    }
    styk_doc::json::to_string(&Value::object(fields))
}

/// `keyEasing(key)`: `{interpolation, bezier?}`, `hold` read as `constant`.
pub(crate) fn key_easing(easing: &Value) -> Vec<(&'static str, Value)> {
    let mode = match easing.get("interpolation").and_then(Value::as_str) {
        Some("hold") => "constant",
        Some(mode) => mode,
        None => "linear",
    };
    let mut fields = vec![("interpolation", Value::str(mode))];
    if mode == "bezier" {
        fields.push(("bezier", easing.get("bezier").cloned().unwrap_or_else(|| Value::array([0.42, 0.0, 0.58, 1.0].map(Value::Num).to_vec()))));
    }
    fields
}

/// `sheetKeyAt(track, tick)`: the index of the last key at or before `tick`.
pub(crate) fn key_at(keys: &[Value], tick: f64) -> Option<usize> {
    keys.partition_point(|k| num(k, "tick").unwrap_or(0.0) <= tick).checked_sub(1)
}

/// `write`'s options: an empty cell, the easing the key takes (else the one of the
/// key before it), and whether a key past the layer's end extends the last exposure
/// instead of leaving an empty cell before it.
#[derive(Clone, Copy, Default)]
pub(crate) struct Write<'a> {
    pub blank: bool,
    pub easing: Option<&'a Value>,
    pub extend: bool,
}

/// `{interpolation: 'constant'}`: the easing of a key with no key before it.
pub(crate) fn constant() -> Value {
    let mut easing = Obj::new();
    easing.set("interpolation", Value::str("constant"));
    Value::object(easing)
}

/// The planner of one command: the tracks it replaces, the pose sources it captures.
#[derive(Clone, Debug)]
pub(crate) struct Plan {
    pub before: Value,
    /// Replaced tracks, in the order the command first touched them.
    pub(crate) tracks: Vec<(String, Obj)>,
    pub(crate) removed_tracks: Vec<String>,
    pub(crate) next_id: f64,
    pub duration: f64,
    pub(crate) sources: Vec<(String, Value)>,
    pub(crate) layers: Value,
    pub(crate) next_frame: u64,
    /// Figure definitions the command adds (`assets.figure_types.added`).
    pub(crate) definitions: Vec<Value>,
}

impl Plan {
    /// The same sheet state used by publication and virtual motion previews.
    fn state(&self, check: &mut impl FnMut() -> Result<(), EditError>) -> Result<Value, EditError> {
        check()?;
        let mut tracks = self.before.get("tracks").and_then(Value::as_obj).cloned().unwrap_or_default();
        for id in &self.removed_tracks { check()?; tracks.remove(id); }
        for (id, track) in &self.tracks { check()?; tracks.set(id, Value::object(track.clone())); }
        let mut state = self.before.as_obj().cloned().unwrap_or_default();
        state.set("tracks", Value::object(tracks));
        state.set("nextId", Value::Num(self.next_id));
        state.set("duration", Value::Num(self.duration));
        Ok(Value::object(state))
    }

    /// `refreshSession`/`refreshFalloff`: a borrowed, transient COW projection.
    /// Preparation/evaluation of this report belongs on the session worker.
    pub(crate) fn virtual_report(&self, report: &Value) -> Result<Value, EditError> {
        let mut root = report.as_obj().cloned().unwrap_or_default();
        let mut styk = report.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
        styk.set("layerSheet", self.state(&mut || Ok(()))?);
        styk.set("layers", self.layers.clone());
        let mut sources = styk.get("frameSources").and_then(Value::as_obj).cloned().unwrap_or_default();
        for (id, source) in &self.sources { sources.set(id, source.clone()); }
        styk.set("frameSources", Value::object(sources));
        root.set("_styk", Value::object(styk));
        Ok(Value::object(root))
    }

    /// `get(id)`: the command's own copy of a track.
    pub(crate) fn track(&mut self, id: &str) -> &mut Obj {
        if let Some(at) = self.tracks.iter().position(|(track, _)| track == id) {
            return &mut self.tracks[at].1;
        }
        let track = self.before.path(&["tracks", id]).and_then(Value::as_obj).cloned().unwrap_or_else(|| {
            let mut track = Obj::new();
            track.set("keys", Value::array(Vec::new()));
            track.set("end", Value::Num(0.0));
            track
        });
        self.tracks.push((id.to_string(), track));
        &mut self.tracks.last_mut().unwrap().1
    }

    pub(crate) fn keys(&mut self, id: &str) -> Vec<Value> {
        items(self.track(id).get("keys"))
    }

    pub(crate) fn set_keys(&mut self, id: &str, keys: Vec<Value>) {
        self.track(id).set("keys", Value::array(keys));
    }

    /// `track.end`.
    pub(crate) fn end(&mut self, id: &str) -> f64 {
        self.track(id).get("end").and_then(Value::as_f64).unwrap_or(0.0)
    }

    pub(crate) fn set_end(&mut self, id: &str, end: f64) {
        self.track(id).set("end", Value::Num(end));
    }

    /// The largest end among the plan's tracks and the untouched ones (`Object.values(state.tracks)`).
    pub(crate) fn longest(&self) -> f64 {
        let untouched = self.before.get("tracks").and_then(Value::as_obj).map(|tracks| {
            tracks.iter().filter(|(id, _)| !self.removed_tracks.iter().any(|removed| removed.as_str() == &***id) && !self.tracks.iter().any(|(touched, _)| touched.as_str() == &***id)).filter_map(|(_, track)| num(track, "end")).fold(f64::NEG_INFINITY, f64::max)
        });
        self.tracks.iter().filter_map(|(_, track)| track.get("end").and_then(Value::as_f64)).fold(untouched.unwrap_or(f64::NEG_INFINITY), f64::max)
    }

    /// `plan.layers.assignments[uid] = layer`.
    pub(crate) fn assign(&mut self, uid: u32, layer: &str) {
        if let Some(assignments) = self.layers.make_obj().and_then(|layers| layers.get_mut("assignments")).and_then(Value::make_obj) {
            assignments.set(&uid.to_string(), Value::str(layer));
        }
    }

    /// Whether the plan captured any pose source (`plan.sources.length`).
    pub(crate) fn has_sources(&self) -> bool {
        !self.sources.is_empty()
    }

    /// A pose source this plan captured, by id.
    pub(crate) fn captured(&self, id: &str) -> Option<&Value> {
        self.sources.iter().find(|(source, _)| source == id).map(|(_, frame)| frame)
    }

    pub(crate) fn cell(&mut self) -> String {
        let id = format!("cell-{}", styk_doc::json::to_string(&Value::Num(self.next_id)));
        self.next_id += 1.0;
        id
    }

    /// `capture(frame, id)`: the layer's figures of `frame` (and what they are joined
    /// to) as a new pose source.
    pub(crate) fn capture(&mut self, frame: &Value, id: &str) -> Value {
        let frame_id = format!("frame-{}", self.next_frame);
        self.next_frame += 1;
        let source = self.source_of(frame, id, &frame_id);
        self.sources.push((frame_id.clone(), source));
        let mut value = Obj::new();
        value.set("frameId", Value::str(&frame_id));
        Value::object(value)
    }

    /// The pose source `frame_id`, which this plan captured, captured again from `frame`: a
    /// motion-path gesture's later pointer moves rewrite it in place (`_sheetPoseDraftWrite`).
    pub(crate) fn recapture(&mut self, frame: &Value, id: &str, frame_id: &str) {
        let source = self.source_of(frame, id, frame_id);
        if let Some((_, captured)) = self.sources.iter_mut().find(|(captured, _)| captured == frame_id) {
            *captured = source;
        }
    }

    /// What `capture` stores: the layer's figures of `frame`, what they are joined to and
    /// their movieclip continuations, named `frame_id`.
    fn source_of(&self, frame: &Value, id: &str, frame_id: &str) -> Value {
        let layers = Some(&self.layers);
        let owned = |uid: f64| layer_of(layers, uid as u32) == id;
        let uids: Vec<f64> = if fixed(id) { Vec::new() } else { objects_of(frame).iter().filter_map(|o| num(o, "unique_id")).filter(|u| owned(*u)).collect() };
        let steps: Vec<Value> = if fixed(id) { Vec::new() } else { continuations(frame).into_iter().filter(|step| num(step, "uid").is_some_and(owned)).collect() };
        let mut source = snapshot_pose_frame_of(frame, Some(&uids)).as_obj().cloned().unwrap_or_default();
        let mut styk = source.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
        styk.set("frameId", Value::str(frame_id));
        if steps.is_empty() {
            styk.remove("movieclipContinuations");
        } else {
            styk.set("movieclipContinuations", Value::array(steps));
        }
        source.set("_styk", Value::object(styk));
        Value::object(source)
    }

    /// One held sample on a fresh worker-owned track. Capture uses the same owner
    /// as write; the fresh key list grows in place between ticks.
    pub(crate) fn append_sample(&mut self, id: &str, tick: f64, frame: &Value) -> Result<(), EditError> {
        let owns = |u: Option<f64>| u.is_some_and(|u| layer_of(Some(&self.layers), u as u32) == id);
        let empty = !fixed(id) && !objects_of(frame).iter().any(|o| owns(num(o, "unique_id"))) && !continuations(frame).iter().any(|step| owns(num(step, "uid")));
        let mut key = Obj::new(); key.set("id", Value::str(&self.cell())); key.set("tick", Value::Num(tick)); key.set("interpolation", Value::str("constant"));
        let value = if empty { let mut value=Obj::new(); value.set("frameId", Value::Null); Value::object(value) } else { self.capture(frame,id) };
        key.set("value",value);key.set("empty",Value::Bool(empty));
        self.track(id).get_mut("keys").and_then(Value::make_arr).ok_or_else(|| EditError::Invalid("invalid sampled track".into()))?.push(Value::object(key));
        Ok(())
    }

    /// `write(id, tick, frame, {blank, easing, extend})`: a key at `tick` holding the
    /// layer's pose in `frame`.
    pub(crate) fn write(&mut self, id: &str, tick: f64, frame: &Value, options: Write) -> Result<(), EditError> {
        if tick.fract() != 0.0 || !(0.0..MAX_SHEET_TICKS).contains(&tick) {
            return Err(EditError::Invalid("errors.editorLayerSheet.chooseAValidWholeFrame".into()));
        }
        let mut keys = self.keys(id);
        let end = self.end(id);
        let index = key_at(&keys, tick);
        let existing = index.filter(|&i| num(&keys[i], "tick") == Some(tick));
        let mut key = match existing {
            Some(i) => keys[i].as_obj().cloned().unwrap_or_default(),
            None => {
                let mut key = Obj::new();
                key.set("id", Value::str(&self.cell()));
                key.set("tick", Value::Num(tick));
                let easing = match options.easing {
                    Some(easing) => key_easing(easing),
                    None => inherited_easing(&keys, tick),
                };
                for (name, value) in easing {
                    key.set(name, value);
                }
                key
            }
        };
        // Past the layer's end: an empty cell closes the gap before the new key.
        if !options.extend && !fixed(id) && tick > end && !keys.is_empty() {
            let mut pad = Obj::new();
            pad.set("id", Value::str(&self.cell()));
            pad.set("tick", Value::Num(end));
            pad.set("interpolation", Value::str("constant"));
            let mut value = Obj::new();
            value.set("frameId", Value::Null);
            pad.set("value", Value::object(value));
            pad.set("empty", Value::Bool(true));
            keys.push(Value::object(pad));
        }
        let layers = Some(&self.layers);
        let owned = |uid: Option<f64>| uid.is_some_and(|u| layer_of(layers, u as u32) == id);
        if layers.and_then(|l| l.path(&["byId", id, "drawing", "version"])).and_then(Value::as_f64) == Some(1.0) {
            return Err(EditError::Unported("poses on a drawing layer".into()));
        }
        let empty = options.blank || (!fixed(id) && !objects_of(frame).iter().any(|o| owned(num(o, "unique_id"))) && !continuations(frame).iter().any(|step| owned(num(step, "uid"))));
        let value = if empty {
            let mut value = Obj::new();
            value.set("frameId", Value::Null);
            Value::object(value)
        } else {
            self.capture(frame, id)
        };
        key.set("value", value);
        key.set("empty", Value::Bool(empty));
        key.remove("sourceTick");
        if let Some(easing) = options.easing {
            for (name, value) in key_easing(easing) {
                key.set(name, value);
            }
        }
        key.remove("patchOnly");
        key.remove("movieclipPatches");
        match existing {
            Some(i) => keys[i] = Value::object(key),
            None if keys.is_empty() || keys.last().and_then(|last| num(last, "tick")).is_some_and(|last| tick > last) => keys.push(Value::object(key)),
            None => keys.insert(index.map_or(0, |i| i + 1), Value::object(key)),
        }
        self.set_keys(id, keys);
        let end = end.max(tick + 1.0);
        self.set_end(id, end);
        self.duration = self.duration.max(end);
        Ok(())
    }
}

/// The shared geometry-aware ownership/attachment kernel. A worker borrows the
/// mirror's existing Loader/Prepared instead of constructing another Editor/cache.
pub(crate) fn owned_frame_with(frame: &Value, uids: &[u32], steps: &[Value], mut geometry: impl FnMut(&Value) -> Result<styk_eval::geometry::Scene, EditError>) -> Result<Value, EditError> {
        let all = objects_of(frame);
        let selected = |object: &Value| uid(object).is_some_and(|u| uids.contains(&u));
        let order: Vec<f64> = frame_order(frame).into_iter().filter(|u| uids.contains(&(*u as u32))).collect();
        let mut members: Vec<Obj> = Vec::new();
        let mut scene = None;
        for object in all.iter().filter(|o| selected(o)) {
            let mut record = object.as_obj().cloned().unwrap_or_default();
            if let Some(join) = object.get("join").filter(|j| j.truthy()) {
                let parent = num(join, "target_object_slot").filter(|s| *s >= 0.0).and_then(|s| all.get(s as usize));
                match parent.filter(|p| selected(p)).and_then(|p| p.get("unique_id")) {
                    Some(parent) => {
                        let mut join = join.as_obj().cloned().unwrap_or_default();
                        join.set("target_unique_id", parent.clone());
                        record.set("join", Value::object(join));
                    }
                    // Joined to a figure left out: it stays where geometry puts it, unjoined.
                    None => {
                        if scene.is_none() {
                            scene = Some(geometry(frame)?);
                        }
                        let slot = num(object, "object_slot");
                        if let Some(root) = scene.as_ref().and_then(|scene| scene.objects.iter().find(|g| Some(g.slot as f64) == slot)).map(|g| g.root) {
                            record.set("root_x", Value::Num(root[0]));
                            record.set("root_y", Value::Num(root[1]));
                        }
                        record.set("join", Value::Null);
                    }
                }
            }
            members.push(record);
        }
        // `normalizeFrame`: slots follow unique ids, joins follow their figures.
        let id_of = |record: &Obj| record.get("unique_id").and_then(Value::as_f64).unwrap_or(f64::NAN);
        members.sort_by_key(|record| id_of(record) as i64 as i32);
        let slot_of = |target: f64| members.iter().position(|record| id_of(record) == target);
        let slots: Vec<Option<usize>> = members.iter().map(|record| record.get("join").filter(|j| j.truthy()).and_then(|j| num(j, "target_unique_id")).and_then(slot_of)).collect();
        let objects: Vec<Value> = members
            .iter()
            .enumerate()
            .map(|(slot, record)| {
                let mut record = record.clone();
                record.set("object_slot", Value::Num(slot as f64));
                if let (Some(target), Some(join)) = (slots[slot], record.get("join").and_then(Value::as_obj).cloned()) {
                    let mut join = join;
                    join.set("target_object_slot", Value::Num(target as f64));
                    record.set("join", Value::object(join));
                }
                Value::object(record)
            })
            .collect();
        let mut out = frame.as_obj().cloned().unwrap_or_default();
        out.set("objects", Value::array(objects));
        let mut styk = out.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
        if steps.is_empty() {
            styk.remove("movieclipContinuations");
        } else {
            styk.set("movieclipContinuations", Value::array(steps.to_vec()));
        }
        out.set("_styk", Value::object(styk));
        out.set("object_draw_order_unique_ids", Value::array(order.iter().map(|u| Value::Num(*u)).collect()));
        out.set("object_draw_order", Value::array(order.iter().map(|u| slot_of(*u).map_or(Value::Null, |slot| Value::Num(slot as f64))).collect()));
        Ok(Value::object(out))
}

/// `inheritedKeyEasing(keys, tick)`: the easing of the nearest earlier key, else a hold.
fn inherited_easing(keys: &[Value], tick: f64) -> Vec<(&'static str, Value)> {
    let mut previous: Option<&Value> = None;
    for key in keys.iter().filter(|k| !k.get("hidden").is_some_and(Value::truthy)) {
        let at = num(key, "tick").unwrap_or(f64::NAN);
        if at < tick && previous.is_none_or(|p| at > num(p, "tick").unwrap_or(f64::NAN)) {
            previous = Some(key);
        }
    }
    match previous {
        // A key without an interpolation eases linearly.
        Some(previous) => key_easing(previous),
        None => key_easing(&constant()),
    }
}

impl Editor {
    /// `insertionOwner(editor, uid, hints)`: the layer of a figure the document has, the
    /// hinted or the active layer for a new one. It must be a user layer.
    fn owner(&self, uid: u32) -> Result<String, EditError> {
        self.owner_with(uid, &self.new_layer_hints)
    }

    /// `insertionOwner(editor, uid, hints)` with the given hints.
    pub(crate) fn owner_with(&self, uid: u32, hints: &std::collections::HashMap<u32, String>) -> Result<String, EditError> {
        let layers = self.report.path(&["_styk", "layers"]);
        let known = self.uid_counts.as_ref().is_some_and(|(counts, _)| counts.contains_key(&uid)) || layers.and_then(|l| l.path(&["assignments", &uid.to_string()])).is_some();
        let user = |id: &str| layers.and_then(|l| l.path(&["byId", id])).is_some();
        let id = match hints.get(&uid) {
            Some(layer) => layer.clone(),
            None if known => self.layer_of(uid),
            None => {
                let active = self.active_layer();
                if user(&active) { active } else { layers.and_then(|l| l.get("defaultLayerId")).and_then(Value::as_str).unwrap_or("").to_string() }
            }
        };
        if !user(&id) {
            return Err(EditError::Invalid("errors.editorLayerSheet.figuresBelongToAnExistingUserLayer".into()));
        }
        Ok(id)
    }

    /// `_layerUidCounts` and `_layerSeenUids`, read from the document the first time.
    pub(crate) fn ensure_counts(&mut self) {
        if self.uid_counts.is_some() {
            return;
        }
        let mut counts: std::collections::HashMap<u32, i64> = std::collections::HashMap::new();
        let sources = self.report.path(&["_styk", "frameSources"]).and_then(Value::as_obj).map(|table| table.values().to_vec()).unwrap_or_default();
        for frame in items(self.report.get("keyframes")).iter().chain(&sources) {
            for id in objects_of(frame).iter().filter_map(uid) {
                *counts.entry(id).or_default() += 1;
            }
        }
        let seen = counts.keys().copied().collect();
        self.uid_counts = Some((counts, seen));
    }

    /// `_trackLayerCommand`: poses in `previous` no longer hold their figures, poses
    /// in `next` now do. A figure that appears or disappears altogether changes the
    /// layers' membership, which is one more layer revision; the layer hints of the
    /// last publication are used once and dropped.
    pub(crate) fn track_frames(&mut self, previous: &[Value], next: &[Value], record: bool) -> Result<bool, EditError> {
        let _scope = crate::prof::scope("sheet::track_frames");
        if previous.is_empty() && next.is_empty() {
            return Ok(false);
        }
        self.ensure_counts();
        let mut delta: Vec<(u32, i64)> = Vec::new();
        for (frames, sign) in [(previous, -1), (next, 1)] {
            for id in frames.iter().flat_map(objects_of).filter_map(|o| uid(&o)) {
                match delta.iter_mut().find(|(known, _)| *known == id) {
                    Some((_, amount)) => *amount += sign,
                    None => delta.push((id, sign)),
                }
            }
        }
        let mut changed = false;
        for (id, amount) in delta.into_iter().filter(|(_, amount)| *amount != 0) {
            let (counts, seen) = self.uid_counts.as_ref().unwrap();
            let before = counts.get(&id).copied().unwrap_or(0);
            let count = before + amount;
            let mut membership = (before > 0) != (count > 0);
            if count > 0 && record && !seen.contains(&id) {
                // A figure never seen takes the hinted layer, else the active one.
                let layers = self.report.path(&["_styk", "layers"]);
                let active = layers.and_then(|l| l.get("activeId")).and_then(Value::as_str).filter(|active| layers.and_then(|l| l.path(&["byId", active])).is_some());
                let layer = self.new_layer_hints.get(&id).cloned().or_else(|| active.map(str::to_string)).unwrap_or_else(|| layers.and_then(|l| l.get("defaultLayerId")).and_then(Value::as_str).unwrap_or("").to_string());
                if let Some(change) = self.capture_layer_assignment(id, &layer) {
                    self.pending_source_layer_changes.push(change);
                    membership = true;
                }
            }
            let (counts, seen) = self.uid_counts.as_mut().unwrap();
            if count <= 0 {
                counts.remove(&id);
            } else {
                counts.insert(id, count);
                seen.insert(id);
            }
            changed |= membership;
        }
        self.new_layer_hints.clear();
        if changed {
            self.layer_revision += 1;
            self.layer_event_pending = true;
        }
        Ok(changed)
    }

    /// `_commitSheetPose(edit, drag)`: keys the draft on every layer whose figures changed.
    pub(crate) fn commit_sheet_pose(&mut self) -> Result<bool, EditError> {
        self.ensure_counts();
        let (Some(edit), Some(drag)) = (self.authored.as_ref(), self.drag.as_ref()) else { return Ok(false) };
        let transaction = edit.transaction;
        let definitions_start = edit.definitions_start;
        let (before, after, tick) = (edit.source.clone(), edit.frame.clone(), edit.tick);
        // Auto key behaves like pressing A during the gesture: every edited track keys the playhead (a tween does too).
        let at_playhead = edit.key_at_playhead || self.auto_key;
        let keyed_layers = edit.key_at_playhead_layers.clone();
        let (old, current) = (objects_of(&before), objects_of(&after));
        let find = |objects: &[Value], id: u32| objects.iter().find(|o| uid(o) == Some(id)).cloned();
        // A gesture can only have changed the figures it took; a command, any figure.
        let mut candidates: Vec<u32> = if transaction { old.iter().filter_map(uid).collect() } else { drag.before.iter().filter_map(uid).collect() };
        if transaction {
            candidates.extend(current.iter().filter_map(uid).filter(|u| !candidates.contains(u)).collect::<Vec<_>>());
        }
        let changed: Vec<u32> = candidates
            .into_iter()
            .filter(|&id| match (find(&old, id), find(&current, id)) {
                (Some(a), Some(b)) => signature(&a, &old) != signature(&b, &current),
                (None, None) => false,
                _ => true,
            })
            .collect();
        let mut ids: Vec<String> = keyed_layers;
        for &id in &changed {
            let owner = self.owner(id)?;
            if !ids.contains(&owner) {
                ids.push(owner);
            }
        }
        // A changed drawing order keys every layer whose own figures are drawn in another order.
        let (before_order, after_order) = (frame_order(&before), frame_order(&after));
        if before_order != after_order {
            let group = |order: &[f64]| -> Result<Vec<(String, Vec<f64>)>, EditError> {
                let mut groups: Vec<(String, Vec<f64>)> = Vec::new();
                for &id in order {
                    let owner = self.owner(id as u32)?;
                    match groups.iter_mut().find(|(layer, _)| *layer == owner) {
                        Some((_, members)) => members.push(id),
                        None => groups.push((owner, vec![id])),
                    }
                }
                Ok(groups)
            };
            let (previous, next) = (group(&before_order)?, group(&after_order)?);
            let layers: Vec<&String> = previous.iter().map(|(layer, _)| layer).chain(next.iter().map(|(layer, _)| layer)).collect();
            for layer in layers {
                let members = |groups: &[(String, Vec<f64>)]| groups.iter().find(|(id, _)| id == layer).map(|(_, members)| members.clone()).unwrap_or_default();
                if members(&previous) != members(&next) && !ids.contains(layer) {
                    ids.push(layer.clone());
                }
            }
        }
        if json(before.get("camera")) != json(after.get("camera")) {
            ids.push("camera".into());
        }
        if ["background_id", "background_id_b", "background_mix", "background_color", "_stykBackgroundColor", "_stykVfx"].iter().any(|key| json(before.get(key)) != json(after.get(key))) {
            ids.push("scene".into());
        }
        if ids.is_empty() {
            self.drag = None;
            self.authored = None;
            self.retained = None;
            return Ok(false);
        }
        // The draft stays on show after the commit unless a clip's playback changed.
        let playback = |objects: &[Value], id: u32| json(find(objects, id).as_ref().and_then(|o| o.get("_stykMovieclip")));
        let retain = !transaction && changed.iter().all(|&id| find(&old, id).is_some() && find(&current, id).is_some() && playback(&old, id) == playback(&current, id));
        let label = drag.label.clone();
        let selection = drag.before_selection.clone();
        let mut plan = self.planner(&ids)?;
        // A new figure's layer is settled before any layer captures the frame.
        let counts = &self.uid_counts.as_ref().unwrap().0;
        for id in current.iter().filter_map(uid).filter(|id| !counts.contains_key(id)) {
            plan.assign(id, &self.owner(id)?);
        }
        let presence = |object: &Value| object.path(&["_stykMovieclip", "clock"]).and_then(Value::as_str) == Some("presence");
        for id in &ids {
            let keys = plan.keys(id);
            let end = num(&Value::object(plan.track(id).clone()), "end").unwrap_or(0.0);
            let at_key = key_at(&keys, tick);
            let key = at_key.map(|i| keys[i].clone());
            let hold = key.as_ref().is_some_and(|k| tick < end && matches!(k.get("interpolation").and_then(Value::as_str), Some("constant" | "hold")));
            // Figures that a key's movieclip replacements placed are edited in the
            // replacement they came from: the key keeps its pose and its replacements.
            let patches = items(key.as_ref().and_then(|k| k.get("movieclipPatches")));
            let mut changed_here = Vec::new();
            for &figure in &changed {
                if self.owner(figure)? == *id {
                    changed_here.push(figure);
                }
            }
            if let (false, Some(index), false) = (at_playhead, at_key, patches.is_empty()) {
                let members = |patch: &Value| -> Vec<u32> {
                    patch.get("frameId").and_then(Value::as_str).and_then(|frame| self.frame_by_id(frame)).map(|frame| objects_of(&frame).iter().filter_map(uid).collect()).unwrap_or_default()
                };
                let placed: Vec<u32> = patches.iter().flat_map(&members).collect();
                if !changed_here.is_empty() && changed_here.iter().all(|u| placed.contains(u)) {
                    let mut owned = keys[index].as_obj().cloned().unwrap_or_default();
                    owned.set("empty", Value::Bool(!current.iter().any(|o| uid(o).is_some_and(|u| self.owner(u).is_ok_and(|owner| owner == *id)))));
                    let mut replaced = Vec::with_capacity(patches.len());
                    for patch in &patches {
                        let uids = members(patch);
                        if !changed_here.iter().any(|u| uids.contains(u)) {
                            replaced.push(patch.clone());
                            continue;
                        }
                        let source = patch.get("frameId").and_then(Value::as_str).and_then(|frame| self.frame_by_id(frame)).unwrap_or(Value::Null);
                        let frame = self.owned_frame(&after, &uids, &continuations(&source))?;
                        let mut patch = patch.as_obj().cloned().unwrap_or_default();
                        patch.set("frameId", plan.capture(&frame, id).get("frameId").cloned().unwrap_or(Value::Null));
                        replaced.push(Value::object(patch));
                    }
                    owned.set("movieclipPatches", Value::array(replaced));
                    let mut keys = keys;
                    keys[index] = Value::object(owned);
                    plan.set_keys(id, keys);
                    continue;
                }
            }
            // A boundary of a broken-apart movieclip frame: the pose after it is fixed first.
            if key.as_ref().is_some_and(|k| k.get("patchOnly").is_some_and(Value::truthy))
                && let Some(next) = at_key.and_then(|i| keys.get(i + 1)).cloned()
            {
                let until = num(&next, "tick").unwrap_or(tick);
                let frame = self.evaluated(until, false)?;
                plan.write(id, until, &frame, Write { easing: Some(&next), ..Write::default() })?;
            }
            // A held cell is edited at its key; auto key, and a presence clip that
            // enters or leaves the layer, key the playhead.
            let mut membership = false;
            for object in old.iter().chain(&current).filter(|o| presence(o)) {
                let Some(figure) = uid(object) else { continue };
                membership |= self.owner(figure)? == *id && find(&old, figure).is_some() != find(&current, figure).is_some();
            }
            let at = match &key {
                Some(key) if hold && !membership && !at_playhead => num(key, "tick").unwrap_or(tick),
                _ => tick,
            };
            let held = constant();
            plan.write(id, at, &after, Write { easing: Some(key.as_ref().unwrap_or(&held)), ..Write::default() })?;
        }
        self.drag = None;
        self.authored = None;
        if let Some(start) = definitions_start
            && let Some(figures) = self.report.make_obj().and_then(|r| r.get_mut("figure_types")).and_then(Value::make_arr)
        {
            plan.definitions = figures.split_off(start);
        }
        self.publish_geometry(plan, &label, selection, retain.then_some(after), retain)
    }

    /// `_commitSheetRange(plans, payload, label, selection)` for one frame at the playhead:
    /// `frame` keyed on the layers of the figures in `changed`, the figures in `inserted`
    /// assigned to theirs (`hints` first), `definitions` added with it.
    pub(crate) fn commit_sheet_range_with(&mut self, frame: &Value, changed: &[u32], inserted: &[u32], hints: &std::collections::HashMap<u32, String>, definitions: Vec<Value>, label: &str, selection: crate::select::SelectionState) -> Result<bool, EditError> {
        self.commit_sheet_range(&[(self.tick, frame.clone(), changed.to_vec())], inserted, hints, definitions, label, selection, None, None)
    }

    /// [`Editor::commit_sheet_range_with`] for figures a command inserted (`payload.objects`;
    /// `paste` for a paste): movieclips alone inside a layer's span become replacements of
    /// their own, and a pasted movieclip is keyed at the playhead rather than on a held key.
    pub(crate) fn commit_sheet_insertion(&mut self, frame: &Value, changed: &[u32], inserted: &[u32], hints: &std::collections::HashMap<u32, String>, definitions: Vec<Value>, label: &str, selection: crate::select::SelectionState, payload: &[Value], paste: bool) -> Result<bool, EditError> {
        self.commit_sheet_range(&[(self.tick, frame.clone(), changed.to_vec())], inserted, hints, definitions, label, selection, Some((payload, paste)), None)
    }

    /// `_commitSheetRange(plans, payload, label, selection)`: each planned frame `(tick, frame,
    /// changed)` keyed on the layers owning its changed figures (a held cell at its key unless
    /// auto key is on), the figures in `inserted` first assigned to their layer (`hints` first),
    /// `definitions` added with it. Unlike a gesture's commit, nothing else of a frame is
    /// compared: the operation names what it changed. `payload`: the figures an insertion
    /// added and whether it pastes them (see [`Editor::commit_sheet_insertion`]). `deletion`:
    /// the figures a deletion removes and each plan's frame before it; where a movieclip
    /// instance is among them, they leave as replacements by nothing.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn commit_sheet_range(&mut self, plans: &[(f64, Value, Vec<u32>)], inserted: &[u32], hints: &std::collections::HashMap<u32, String>, definitions: Vec<Value>, label: &str, selection: crate::select::SelectionState, payload: Option<(&[Value], bool)>, deletion: Option<(&[u32], &[Value])>) -> Result<bool, EditError> {
        self.commit_sheet_range_worker(plans, inserted, hints, definitions, label, selection, payload, deletion, None)
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn commit_sheet_range_worker(&mut self, plans: &[(f64, Value, Vec<u32>)], inserted: &[u32], hints: &std::collections::HashMap<u32, String>, definitions: Vec<Value>, label: &str, selection: crate::select::SelectionState, payload: Option<(&[Value], bool)>, deletion: Option<(&[u32], &[Value])>, mut worker: Option<&mut crate::movieclip_planning::TimelineWorker<'_>>) -> Result<bool, EditError> {
        if let Some(worker) = worker.as_mut() { (worker.check)()?; }
        self.ensure_counts();
        let mut ids: Vec<String> = Vec::new();
        for &uid in plans.iter().flat_map(|(_, _, changed)| changed) {
            let owner = self.owner_with(uid, hints)?;
            if !ids.contains(&owner) {
                ids.push(owner);
            }
        }
        let mut plan = self.planner(&ids)?;
        plan.definitions = definitions;
        for &uid in inserted {
            plan.assign(uid, &self.owner_with(uid, hints)?);
        }
        for (index, (tick, frame, changed)) in plans.iter().enumerate() {
            if let Some(worker) = worker.as_mut() { (worker.check)()?; }
            let tick = *tick;
            if let Some((uids, befores)) = deletion {
                let before = befores.get(index).map(objects_of).unwrap_or_default();
                if before.iter().any(|o| uid(o).is_some_and(|u| changed.contains(&u)) && o.get("_stykMovieclip").is_some_and(Value::truthy)) {
                    for &removed in uids {
                        if before.iter().any(|o| uid(o) == Some(removed)) {
                            let owner = self.owner_with(removed, hints)?;
                            self.replace_at(&mut plan, &owner, tick, removed, &create_frame(&[]), None, tick + 1.0)?;
                        }
                    }
                    continue;
                }
            }
            let mut layers: Vec<String> = Vec::new();
            for &uid in changed {
                let owner = self.owner_with(uid, hints)?;
                if !layers.contains(&owner) {
                    layers.push(owner);
                }
            }
            for id in &layers {
                let keys = plan.keys(id);
                let end = num(&Value::object(plan.track(id).clone()), "end").unwrap_or(0.0);
                let at_key = key_at(&keys, tick);
                let key = at_key.map(|i| keys[i].clone());
                let inside = tick < end;
                let clip = |object: &Value| object.get("_stykMovieclip").is_some_and(Value::truthy);
                // Inserting movieclips alone changes which figures a cell shows, not the motion
                // of those around them: each is a replacement until the next key.
                if let Some((objects, _)) = payload.filter(|(objects, _)| inside && !objects.is_empty() && objects.iter().all(|o| clip(o) && !o.get("join").is_some_and(Value::truthy))) {
                    let until = keys.iter().find(|k| num(k, "tick").is_some_and(|t| t > tick)).and_then(|k| num(k, "tick")).unwrap_or(end);
                    for object in objects {
                        let Some(inserted) = uid(object) else { continue };
                        if self.owner_with(inserted, hints)? == *id {
                            self.replace_at(&mut plan, id, tick, inserted, &create_frame(std::slice::from_ref(object)), Some(("replacementUid", Value::Num(inserted as f64))), until)?;
                        }
                    }
                    continue;
                }
                let mut clip_paste = false;
                if let Some((objects, true)) = payload {
                    for object in objects.iter().filter(|o| clip(o)) {
                        if let Some(inserted) = uid(object) {
                            clip_paste |= self.owner_with(inserted, hints)? == *id;
                        }
                    }
                }
                // A boundary of a broken-apart movieclip frame: the pose after it is fixed first.
                if key.as_ref().is_some_and(|k| k.get("patchOnly").is_some_and(Value::truthy))
                    && let Some(next) = at_key.and_then(|i| keys.get(i + 1)).cloned()
                {
                    let until = num(&next, "tick").unwrap_or(tick);
                    let evaluated = self.evaluated(until, false)?;
                    plan.write(id, until, &evaluated, Write { easing: Some(&next), ..Write::default() })?;
                }
                let hold = key.as_ref().is_some_and(|k| matches!(k.get("interpolation").and_then(Value::as_str), Some("constant" | "hold")));
                let at = match &key {
                    Some(key) if !self.auto_key && !clip_paste && inside && hold => num(key, "tick").unwrap_or(tick),
                    _ => tick,
                };
                let held = constant();
                plan.write(id, at, frame, Write { easing: Some(key.as_ref().unwrap_or(&held)), ..Write::default() })?;
            }
        }
        match worker {
            Some(worker) => { worker.publish_plan_with_geometry(self, plan, label, Some(selection), payload.is_some())?; Ok(true) }
            None => self.publish_geometry(plan, label, selection, None, payload.is_some()),
        }
    }

    /// `replaceAt(editor, plan, id, tick, uid, frame, options, end)`: from `tick` until `end`,
    /// layer `id` shows `frame` in place of figure `uid` (a movieclip frame replacement on the
    /// key there, a replacement-only key made where there is none), the replacements in force
    /// before restored at `end`.
    pub(crate) fn replace_at(&self, plan: &mut Plan, id: &str, tick: f64, replaced: u32, frame: &Value, extra: Option<(&str, Value)>, end: f64) -> Result<(), EditError> {
        if tick.fract() != 0.0 || !(0.0..MAX_SHEET_TICKS).contains(&tick) {
            return Err(EditError::Invalid("errors.editorLayerSheet.chooseAValidWholeFrame".into()));
        }
        if tick >= plan.end(id) {
            return Ok(());
        }
        // The key at `time`, made (replacement only) when there is none.
        let boundary = |editor: &Editor, plan: &mut Plan, time: f64| -> Result<usize, EditError> {
            let mut keys = plan.keys(id);
            if let Some(at) = keys.iter().position(|k| num(k, "tick") == Some(time)) {
                return Ok(at);
            }
            let empty = !objects_of(&editor.evaluated(time, false)?).iter().filter_map(uid).any(|u| editor.layer_of(u) == id);
            let mut key = Obj::new();
            key.set("id", Value::str(&plan.cell()));
            key.set("tick", Value::Num(time));
            key.set("interpolation", Value::str("constant"));
            key.set("patchOnly", Value::Bool(true));
            let mut value = Obj::new();
            value.set("frameId", Value::Null);
            key.set("value", Value::object(value));
            key.set("empty", Value::Bool(empty));
            keys.push(Value::object(key));
            keys.sort_by(|a, b| num(a, "tick").unwrap_or(0.0).total_cmp(&num(b, "tick").unwrap_or(0.0)));
            let at = keys.iter().position(|k| num(k, "tick") == Some(time)).unwrap();
            plan.set_keys(id, keys);
            Ok(at)
        };
        let keys = plan.keys(id);
        let previous = key_at(&keys, tick).map(|i| items(keys[i].get("movieclipPatches"))).unwrap_or_default();
        if end < plan.end(id) && !keys.iter().any(|k| num(k, "tick") == Some(end)) {
            let at = boundary(self, plan, end)?;
            if !previous.is_empty() {
                let mut keys = plan.keys(id);
                if let Some(key) = keys[at].make_obj() {
                    key.set("movieclipPatches", Value::array(previous.clone()));
                }
                plan.set_keys(id, keys);
            }
        }
        let frame_id = match &extra {
            Some(("frameId", frame_id)) => frame_id.clone(),
            _ => plan.capture(frame, id).get("frameId").cloned().unwrap_or(Value::Null),
        };
        let at = boundary(self, plan, tick)?;
        let mut patches: Vec<Value> = previous.into_iter().filter(|p| num(p, "uid") != Some(replaced as f64)).collect();
        let mut patch = Obj::new();
        patch.set("uid", Value::Num(replaced as f64));
        patch.set("frameId", frame_id);
        if let Some((key, value)) = extra.filter(|(key, _)| *key != "frameId") {
            patch.set(key, value);
        }
        patches.push(Value::object(patch));
        // Whether the layer shows anything there once the replacements are in force.
        let mut members: Vec<u32> = objects_of(&self.evaluated(tick, false)?).iter().filter_map(uid).filter(|u| self.layer_of(*u) == id).collect();
        for patch in &patches {
            let removed = num(patch, "uid").map(|u| u as u32);
            members.retain(|u| Some(*u) != removed);
            let source = patch.get("frameId").and_then(Value::as_str).and_then(|frame| plan.captured(frame).cloned().or_else(|| self.frame_by_id(frame)));
            for added in source.map(|s| objects_of(&s)).unwrap_or_default().iter().filter_map(uid) {
                if !members.contains(&added) {
                    members.push(added);
                }
            }
        }
        let mut keys = plan.keys(id);
        if let Some(key) = keys[at].make_obj() {
            key.set("movieclipPatches", Value::array(patches));
            key.set("empty", Value::Bool(members.is_empty()));
        }
        plan.set_keys(id, keys);
        Ok(())
    }

    /// `getFrameById(report, id)`: a retained pose source, else the keyframe with that id.
    pub(crate) fn frame_by_id(&self, id: &str) -> Option<Value> {
        let retained = self.report.path(&["_styk", "frameSources", id]).filter(|frame| frame.truthy()).cloned();
        retained.or_else(|| items(self.report.get("keyframes")).into_iter().find(|frame| frame.path(&["_styk", "frameId"]).and_then(Value::as_str) == Some(id)))
    }

    /// `ownedFrame(report, frame, uids)` with `continuations` set: the frame reduced to
    /// the figures `uids` name, joins among them kept, slots by unique id.
    pub(crate) fn owned_frame(&self, frame: &Value, uids: &[u32], steps: &[Value]) -> Result<Value, EditError> {
        owned_frame_with(frame, uids, steps, |frame| self.record_geometry(frame))
    }

    /// `buildGeometry(report, frame)` for a frame record that need not be the one on show.
    pub(crate) fn record_geometry(&self, record: &Value) -> Result<styk_eval::geometry::Scene, EditError> {
        let prepared = self.prepared()?;
        if let Some(feature) = prepared.doc.unsupported.first() {
            return Err(EditError::Unported(format!("geometry with {feature}")));
        }
        let frame = self.eval.borrow_mut().loader.edit_frame(record, None, &prepared.doc).map_err(|error| EditError::Invalid(error.to_string()))?;
        Ok(styk_eval::geometry::build(&prepared.doc, &frame))
    }

    /// `planner(editor, ids)`: `ids` must be layers that exist and are not locked.
    pub(crate) fn planner(&self, ids: &[String]) -> Result<Plan, EditError> {
        let styk = self.report.get("_styk");
        let layers = styk.and_then(|s| s.get("layers")).cloned().unwrap_or(Value::Null);
        if ids.is_empty() {
            return Err(EditError::Invalid("errors.editorLayerSheet.selectALayer".into()));
        }
        for id in ids {
            let state = if fixed(id) { layers.path(&["fixed", id]) } else { layers.path(&["byId", id]) };
            let listed = fixed(id) || items(layers.get("order")).iter().any(|layer| layer.as_str() == Some(id.as_str()));
            if !listed {
                return Err(EditError::Invalid("errors.editorLayerSheet.theSelectedLayerNoLongerExists".into()));
            }
            if state.and_then(|s| s.get("locked")).is_some_and(Value::truthy) {
                return Err(crate::invalid_with("errors.editorLayerSheet.unlockBeforeEditingIt", vec![("name", Value::str(&crate::layers::layer_title(Some(&layers), id)))]));
            }
        }
        let Some(before) = styk.and_then(|s| s.get("layerSheet")).cloned() else { return Err(EditError::Invalid("errors.editorLayerSheet.openTheLayerTimelineFirst".into())) };
        Ok(Plan {
            next_id: num(&before, "nextId").unwrap_or(1.0),
            duration: num(&before, "duration").unwrap_or(1.0),
            before,
            tracks: Vec::new(),
            removed_tracks: Vec::new(),
            sources: Vec::new(),
            layers,
            next_frame: self.next_frame_identity,
            definitions: Vec::new(),
        })
    }

    /// `publish(editor, plan, label, {selection})`: the plan becomes the document's
    /// sheet, with one history entry.
    pub(crate) fn publish(&mut self, plan: Plan, label: &str, selection: crate::select::SelectionState, retained: Option<Value>) -> Result<bool, EditError> {
        self.publish_geometry(plan, label, selection, retained, false)
    }

    fn publish_geometry(&mut self, plan: Plan, label: &str, selection: crate::select::SelectionState, retained: Option<Value>, retain_geometry: bool) -> Result<bool, EditError> {
        self.publish_checked(plan, label, selection, retained, retain_geometry, &mut || Ok(()))
    }

    pub(crate) fn publish_checked(&mut self, mut plan: Plan, label: &str, selection: crate::select::SelectionState, retained: Option<Value>, retain_geometry: bool, check: &mut impl FnMut() -> Result<(), EditError>) -> Result<bool, EditError> {
        check()?;
        // How many poses hold each figure, counted on the document before it changes.
        self.ensure_counts();
        // Imported spans whose ends changed are frozen as poses: an unchanged
        // imported span keeps evaluating from the import.
        // Object.entries(plan.state.tracks): existing table order, then appended tracks.
        // Touch order can differ (figure keys before camera keys in a camera bake), and
        // materializing imported endpoints assigns observable frame-source identities.
        let changed: std::collections::HashSet<&str> = plan.tracks.iter().map(|(id, _)| id.as_str()).collect();
        let before_tracks = plan.before.get("tracks").and_then(Value::as_obj);
        let mut materialize_ids: Vec<String> = before_tracks.map(|tracks| tracks.keys().filter(|id| changed.contains(&***id)).map(|id| id.to_string()).collect()).unwrap_or_default();
        materialize_ids.extend(plan.tracks.iter().filter(|(id, _)| before_tracks.is_none_or(|tracks| tracks.get(id).is_none())).map(|(id, _)| id.clone()));
        for id in materialize_ids {
            check()?;
            let previous: Vec<Value> = items(plan.before.path(&["tracks", &id, "keys"])).into_iter().filter(|k| !k.get("patchOnly").is_some_and(Value::truthy)).collect();
            let current: Vec<Value> = plan.keys(&id).into_iter().filter(|k| !k.get("patchOnly").is_some_and(Value::truthy)).collect();
            let name = |key: Option<&Value>| key.and_then(|k| k.get("id")).cloned();
            let tick = |key: Option<&Value>| key.and_then(|k| num(k, "tick"));
            // Where each previous key with a text identity is (the first of equal ones, as a
            // scan finds it); other identities are looked for by scanning.
            let mut index: std::collections::HashMap<String, usize> = std::collections::HashMap::with_capacity(previous.len());
            let mut other = false;
            for (at, old) in previous.iter().enumerate() {
                check()?;
                match old.get("id").and_then(|id| id.as_str().map(str::to_string)) {
                    Some(id) => {
                        index.entry(id).or_insert(at);
                    }
                    None => other = true,
                }
            }
            for (i, key) in current.iter().enumerate() {
                check()?;
                let scan = || previous.iter().position(|old| name(Some(old)) == name(Some(key)));
                let found = match key.get("id").and_then(|id| id.as_str().map(str::to_string)) {
                    Some(id) if !other => index.get(&id).copied(),
                    _ => scan(),
                };
                let Some(at) = found else { continue };
                let (old, old_next, next) = (&previous[at], previous.get(at + 1), current.get(i + 1));
                let moved = tick(Some(key)) != tick(Some(old))
                    || key.get("interpolation") != old.get("interpolation")
                    || json(key.get("bezier")) != json(old.get("bezier"))
                    || name(next) != name(old_next)
                    || tick(next) != tick(old_next);
                if moved {
                    for target in [Some(key), next].into_iter().flatten() {
                        self.materialize(&mut plan, &id, target)?;
                    }
                }
            }
        }
        self.validate_plan_checked(&mut plan, check)?;
        // The new sheet: the old one with the replaced tracks, counters and length.
        let before = plan.before.clone();
        let before_layers = self.report.path(&["_styk", "layers"]).cloned().unwrap_or(Value::Null);
        let after = plan.state(check)?;
        let after_layers = plan.layers.clone();
        let definitions = if plan.definitions.is_empty() {
            None
        } else {
            let figures = self.report.make_obj().and_then(|r| r.get_mut("figure_types")).and_then(Value::make_arr).ok_or_else(|| EditError::Unported("figure definitions that are not a list".into()))?;
            let index = figures.len();
            figures.extend(plan.definitions.iter().cloned());
            Some((index, std::mem::take(&mut plan.definitions)))
        };
        let definition = definitions.is_some();
        self.set_sheet(&after, &after_layers);
        if !plan.sources.is_empty() {
            let sources = self.sources_mut();
            for (id, source) in &plan.sources {
                check()?;
                sources.set(id, source.clone());
            }
        }
        self.next_frame_identity = plan.next_frame;
        self.retained = retained;
        self.new_layer_hints = plan.sources.iter().flat_map(|(_, source)| objects_of(source)).filter_map(|o| uid(&o)).map(|u| (u, self.layer_of(u))).collect();
        let after_selection = self.selection_state();
        let source_ids: Vec<Value> = plan.sources.iter().map(|(id, _)| Value::str(id)).collect();
        self.record_checked(Command {
            kind: CommandKind::LayerSheet { before, after, before_layers, after_layers, sources: plan.sources, definitions, retain_geometry },
            label: label.to_string(),
            before_selection: selection,
            after_selection,
            before_revision: 0,
            after_revision: 0,
            layer_changes: Vec::new(),
            captured_source_bytes: 0,
            layers: false,
        }, check)?;
        check()?;
        self.layer_revision += 1;
        self.emit_sheet("edit", label, source_ids, definition);
        Ok(true)
    }

    /// `validateLayerSheetChanges`: what the replaced tracks must satisfy, with the
    /// editor's errors (keys in order inside their layer's length, poses that exist,
    /// identities not reused).
    fn validate_plan_checked(&self, plan: &mut Plan, check: &mut impl FnMut() -> Result<(), EditError>) -> Result<(), EditError> {
        check()?;
        let order = "errors.layerSheet.layerKeysNeedUniqueIdentitiesAndDistinctOrdered";
        let duration = plan.duration;
        if duration.fract() != 0.0 || !(1.0..=MAX_SHEET_TICKS).contains(&duration) {
            return Err(EditError::Invalid("errors.layerSheet.invalidLayerTimeline".into()));
        }
        let ids: Vec<String> = plan.tracks.iter().map(|(id, _)| id.clone()).collect();
        let mut largest = 0.0f64;
        for id in &ids {
            check()?;
            let end = plan.end(id);
            if end.fract() != 0.0 || end < 0.0 || end > duration {
                return Err(EditError::Invalid("errors.layerSheet.invalidLayerExposureLength".into()));
            }
            let mut previous = -1.0;
            let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
            for key in plan.keys(id) {
                check()?;
                let name = key.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                let tick = num(&key, "tick").unwrap_or(f64::NAN);
                if name.is_empty() || seen.contains(&name) || tick.fract() != 0.0 || tick.is_nan() || tick < 0.0 || tick <= previous || tick >= end {
                    return Err(EditError::Invalid(order.into()));
                }
                previous = tick;
                crate::sheet_frames::valid_easing(&key)?;
                if let Some(number) = name.strip_prefix("cell-").filter(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())).and_then(|n| n.parse::<f64>().ok()) {
                    largest = largest.max(number);
                }
                match (key.get("sourceTick"), key.path(&["value", "frameId"])) {
                    (Some(source), _) => {
                        if !source.as_f64().is_some_and(|t| t.is_finite() && (0.0..=MAX_SHEET_TICKS).contains(&t)) {
                            return Err(EditError::Invalid("errors.layerSheet.invalidImportedLayerTiming".into()));
                        }
                    }
                    (None, Some(Value::Null)) => {}
                    (None, frame) => {
                        let known = frame.and_then(Value::as_str).is_some_and(|frame| plan.captured(frame).is_some() || self.frame_by_id(frame).is_some());
                        if !known {
                            return Err(EditError::Invalid("errors.layerSheet.layerKeyReferencesAMissingPose".into()));
                        }
                    }
                }
                seen.insert(name);
            }
        }
        // An untouched track may not outlast a shortened sheet.
        let untouched = plan.before.get("tracks").and_then(Value::as_obj).map(|tracks| tracks.iter().filter(|(id, _)| !plan.removed_tracks.iter().any(|removed| removed.as_str() == &***id) && !ids.iter().any(|touched| touched.as_str() == &***id)).filter_map(|(_, track)| num(track, "end")).fold(0.0, f64::max));
        if untouched.is_some_and(|end| end > duration) {
            return Err(EditError::Invalid("errors.layerSheet.invalidLayerExposureLength".into()));
        }
        if plan.next_id <= largest {
            return Err(EditError::Invalid("errors.layerSheet.layerKeyIdentityCounterIsInvalid".into()));
        }
        Ok(())
    }

    /// `materialize(id, key)`: an imported key becomes the pose it showed.
    pub(crate) fn materialize(&self, plan: &mut Plan, id: &str, key: &Value) -> Result<(), EditError> {
        let mut keys = plan.keys(id);
        let Some(at) = keys.iter().position(|k| k.get("id") == key.get("id")) else { return Ok(()) };
        if keys[at].get("sourceTick").is_none() {
            return Ok(());
        }
        let old = items(plan.before.path(&["tracks", id, "keys"])).into_iter().find(|k| k.get("id") == key.get("id"));
        let tick = old.as_ref().and_then(|k| num(k, "tick")).or_else(|| num(&keys[at], "tick")).unwrap_or(0.0);
        let frame = self.evaluated(tick, false)?;
        let mut owned = keys[at].as_obj().cloned().unwrap_or_default();
        owned.set("value", plan.capture(&frame, id));
        owned.remove("sourceTick");
        keys[at] = Value::object(owned);
        plan.set_keys(id, keys);
        Ok(())
    }

    fn styk_mut(&mut self) -> Option<&mut Obj> {
        self.report.make_obj()?.get_mut("_styk")?.make_obj()
    }

    fn set_sheet(&mut self, sheet: &Value, layers: &Value) {
        if let Some(styk) = self.styk_mut() {
            styk.set("layerSheet", sheet.clone());
            styk.set("layers", layers.clone());
        }
    }

    /// `report._styk.frameSources ??= {}`.
    fn sources_mut(&mut self) -> &mut Obj {
        let styk = self.styk_mut().expect("a layer-sheet document has _styk");
        if !styk.get("frameSources").is_some_and(Value::is_object) {
            styk.set("frameSources", Value::object(Obj::new()));
        }
        styk.get_mut("frameSources").and_then(Value::make_obj).expect("just set")
    }

    /// The event of a published or replayed sheet command: every layer view refreshes.
    fn emit_sheet(&mut self, kind: &str, label: &str, source_ids: Vec<Value>, definition: bool) {
        self.layer_event_pending = false;
        // `{layers: true, layerRevision, ...detail}` over the base event, whose
        // `structural` and `timing` the detail sets.
        let mut event = Obj::new();
        event.set("kind", Value::str(kind));
        event.set("frameIndex", Value::Num(self.frame_index as f64));
        event.set("tick", Value::Num(self.tick));
        event.set("structural", Value::Bool(true));
        event.set("timing", Value::Bool(true));
        event.set("layers", Value::Bool(true));
        event.set("layerRevision", Value::Num(self.layer_revision as f64));
        event.set("label", Value::str(label));
        event.set("layerSheet", Value::Bool(true));
        event.set("definition", Value::Bool(definition));
        event.set("frameIndices", Value::array(Vec::new()));
        event.set("sourceIds", Value::array(source_ids));
        self.events.push(Value::object(event));
    }

    /// `applyLayerSheetCommand(editor, command, direction)`.
    pub(crate) fn apply_sheet_command(&mut self, command: &Command, direction: Direction) -> Result<(), EditError> {
        let _scope = crate::prof::scope("sheet::apply_command");
        let CommandKind::LayerSheet { before, after, before_layers, after_layers, sources, definitions, .. } = &command.kind else { return Ok(()) };
        let (sheet, layers, selection, revision) = match direction {
            Direction::Before => (before, before_layers, &command.before_selection, command.before_revision),
            Direction::After => (after, after_layers, &command.after_selection, command.after_revision),
        };
        self.set_sheet(sheet, layers);
        // The definitions the command added go before it and come back after it.
        if let Some((index, added)) = definitions
            && let Some(figures) = self.report.make_obj().and_then(|r| r.get_mut("figure_types")).and_then(Value::make_arr)
        {
            match direction {
                Direction::Before => {
                    figures.drain(*index..(*index + added.len()).min(figures.len()));
                }
                Direction::After => {
                    let at = (*index).min(figures.len());
                    figures.splice(at..at, added.iter().cloned());
                }
            }
        }
        // `_applyFrameSourceChanges`: the command's captures exist after it, not before.
        if !sources.is_empty() {
            let table = self.sources_mut();
            for (id, source) in sources {
                match direction {
                    Direction::After => table.set(id, source.clone()),
                    Direction::Before => {
                        table.remove(id);
                    }
                }
            }
            if direction == Direction::Before && table.is_empty() {
                self.styk_mut().and_then(|styk| styk.remove("frameSources"));
            }
        }
        let frames: Vec<Value> = sources.iter().map(|(_, frame)| frame.clone()).collect();
        match direction {
            Direction::Before => self.track_frames(&frames, &[], false)?,
            Direction::After => self.track_frames(&[], &frames, false)?,
        };
        self.layer_revision += 1;
        self.retained = None;
        self.restore_selection(selection)?;
        self.revision = revision;
        let source_ids = sources.iter().map(|(id, _)| Value::str(id)).collect();
        self.emit_sheet("history", &command.label, source_ids, definitions.is_some());
        Ok(())
    }

    /// `_pruneFrameSources`: this session's pose captures that neither the sheet nor
    /// any history entry refers to any more are dropped.
    pub(crate) fn prune_frame_sources(&mut self) {
        if self.generated_sources.is_empty() {
            return;
        }
        let mut retained: Vec<String> = Vec::new();
        let keep_sheet = |sheet: Option<&Value>, retained: &mut Vec<String>| {
            for (_, track) in sheet.and_then(|s| s.get("tracks")).and_then(Value::as_obj).map(|t| t.iter().collect::<Vec<_>>()).unwrap_or_default() {
                for key in items(track.get("keys")) {
                    let patches = items(key.get("movieclipPatches"));
                    for id in key.path(&["value", "frameId"]).into_iter().chain(patches.iter().filter_map(|patch| patch.get("frameId"))).filter_map(Value::as_str) {
                        if !retained.iter().any(|kept| kept == id) {
                            retained.push(id.to_string());
                        }
                    }
                }
            }
        };
        keep_sheet(self.report.path(&["_styk", "layerSheet"]), &mut retained);
        let keep_animation = |animation: Option<&Value>, retained: &mut Vec<String>| {
            for channel in items(animation.and_then(|a| a.get("channels"))).iter().filter(|c| c.get("property").and_then(Value::as_str) == Some("pose")) {
                for key in items(channel.get("keys")) {
                    if let Some(id) = key.path(&["value", "frameId"]).and_then(Value::as_str) {
                        if !retained.iter().any(|kept| kept == id) { retained.push(id.to_string()); }
                    }
                }
            }
        };
        keep_animation(self.report.path(&["_styk", "animation"]), &mut retained);
        // History can only add retained IDs. If the live document already keeps
        // every generated source, none can be collected.
        if self.generated_sources.iter().all(|id| retained.contains(id)) {
            return;
        }
        // `historyCommands`: the entries of batches count as entries.
        fn flatten<'a>(commands: impl Iterator<Item = &'a Command>, out: &mut Vec<&'a Command>) {
            for command in commands {
                match &command.kind {
                    CommandKind::Batch { commands } => flatten(commands.iter(), out),
                    _ => out.push(command),
                }
            }
        }
        let mut history = Vec::new();
        flatten(self.undo.iter().chain(self.redo.iter()).map(|entry| &**entry), &mut history);
        // Captures owned by a sheet command are unconditionally retained. Check
        // those direct references before walking the commands' sheet snapshots.
        for command in &history {
            if let CommandKind::LayerSheet { sources, .. } = &command.kind {
                retained.extend(sources.iter().map(|(id, _)| id.clone()));
            }
            Editor::external_retained(command, &mut retained);
        }
        if self.generated_sources.iter().all(|id| retained.contains(id)) {
            return;
        }
        for command in history {
            if let CommandKind::LayerSheet { before, after, .. } = &command.kind {
                keep_sheet(Some(before), &mut retained);
                keep_sheet(Some(after), &mut retained);
            }
            if let CommandKind::Animation { before, after, .. } = &command.kind {
                keep_animation(before.as_ref(), &mut retained);
                keep_animation(Some(after), &mut retained);
            }
            if let CommandKind::Layers { migration: Some(migration), .. } = &command.kind {
                migration.retain_sources(&mut retained);
            }
            if let CommandKind::MovieclipPoses { before, after } = &command.kind {
                for entry in before.iter().chain(after) {
                    if let crate::topology::Place::Source(id) = &entry.place { retained.push(id.clone()); }
                }
            }
            if let CommandKind::Topology { before, after, .. } = &command.kind {
                for entry in before.frames.iter().chain(&after.frames) {
                    if let crate::topology::Place::Source(id) = &entry.place { retained.push(id.clone()); }
                }
            }
        }
        let dropped: Vec<String> = self.generated_sources.iter().filter(|id| !retained.contains(id)).cloned().collect();
        if dropped.is_empty() {
            return;
        }
        self.generated_sources.retain(|id| !dropped.contains(id));
        let keep_table = self.source_table_was_present;
        let mut removed = Vec::new();
        if let Some(styk) = self.styk_mut() {
            let empty = match styk.get_mut("frameSources").and_then(Value::make_obj) {
                Some(table) => {
                    removed.extend(dropped.iter().filter_map(|id| table.remove(id)));
                    table.is_empty()
                }
                None => false,
            };
            if empty && !keep_table {
                styk.remove("frameSources");
            }
        }
        // Counting never fails here: nothing is recorded, so no figure is new.
        let _ = self.track_frames(&removed, &[], false);
    }
}
