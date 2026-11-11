//! The layer timeline's clipboard (src/editor-layer-sheet.mjs): `sheetCopyFrames` keeps
//! each layer's poses and easing over a range, `sheetPasteFrames` writes them at another
//! frame, over what is there or inserted, on the same layers or on others (where the
//! figures take new identities). The clipboard belongs to the editor that copied: a
//! session pastes only what it copied itself (the facade checks that the editor's
//! clipboard is that one). Movieclips on the presence clock carry on from where they were
//! copied. Drawing keys paste as cels of their own (new cel identities, the pixels of the copied cels forked for
//! the interface to copy) and the parts of a broken-apart movieclip follow the instance they belong to. A
//! clipboard from another document is never the engine's.

use styk_doc::{Obj, Value};

use crate::frame::objects_of;
use crate::record::uid;
use crate::sheet::{constant, continuations, fixed, items, key_at, key_easing, num, Write, MAX_SHEET_TICKS};

/// `usesPresence(object)`: a movieclip instance on the presence clock.
fn uses_presence(object: &Value) -> bool {
    object.path(&["_stykMovieclip", "clock"]).and_then(Value::as_str) == Some("presence")
}
use crate::{EditError, Editor};

/// `editor._sheetClipboard`, as far as pasting it in the same document reads it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Clipboard {
    start: f64,
    duration: f64,
    rows: Vec<Row>,
    /// Where each movieclip on the presence clock was in its clip when copied (`phases`).
    phases: Vec<(u32, f64)>,
    /// The definitions the rows show, as they were when copied: a drawing cel pastes as a cel of its own, and in another
    /// document every one is a new definition.
    figures: Vec<Value>,
    /// The scene's backgrounds when copied, which a paste in another document brings along with the scene row.
    backgrounds: Vec<Value>,
    /// Copied in another document (or restored from the system's clipboard): every figure takes a new identity.
    foreign: bool,
}

impl Clipboard {
    /// The drawing cels among the definitions.
    fn drawings(&self) -> impl Iterator<Item = &Value> {
        self.figures.iter().filter(|figure| figure.path(&["_styk", "drawing"]).is_some_and(Value::truthy))
    }
}

#[derive(Clone, Debug, PartialEq)]
struct Row {
    id: String,
    drawing: bool,
    keys: Vec<Entry>,
}

#[derive(Clone, Debug, PartialEq)]
struct Entry {
    offset: f64,
    frame: Value,
    easing: Value,
}

fn invalid(key: &str) -> EditError {
    EditError::Invalid(format!("errors.editorLayerSheet.{key}"))
}

/// The layer ids of a call (an array of text), refusing repeated ones with `repeated`.
fn distinct(ids: &Value, repeated: &str) -> Result<Vec<String>, EditError> {
    let list: Vec<String> = match ids.elements() {
        Some(ids) => ids.iter().map(|id| id.as_str().map(str::to_string).ok_or_else(|| EditError::Unported("a layer id that is not text".into()))).collect::<Result<_, _>>()?,
        None => return Err(EditError::Unported("layer ids that are not a list".into())),
    };
    if list.iter().collect::<std::collections::HashSet<_>>().len() != list.len() {
        return Err(invalid(repeated));
    }
    Ok(list)
}

/// Layer ids as given (an array of text), repeats allowed.
fn distinct_list(ids: &Value) -> Result<Vec<String>, EditError> {
    match ids.elements() {
        Some(ids) => ids.iter().map(|id| id.as_str().map(str::to_string).ok_or_else(|| EditError::Unported("a layer id that is not text".into()))).collect(),
        None => Err(EditError::Unported("layer ids that are not a list".into())),
    }
}

/// `Array.prototype.slice(start, end)`.
fn js_slice<T: Clone>(list: &[T], start: i64, end: i64) -> Vec<T> {
    let len = list.len() as i64;
    let clamp = |at: i64| if at < 0 { (len + at).max(0) } else { at.min(len) };
    let (from, to) = (clamp(start), clamp(end));
    if from >= to { Vec::new() } else { list[from as usize..to as usize].to_vec() }
}

/// `remapIKFollowers(object, uidMap)`: followers in other figures follow their new
/// identities; those not pasted are dropped. Integer keys come out in ascending order,
/// as a JavaScript object orders them.
pub(crate) fn remap_followers(object: &mut Obj, map: &[(u32, u32)]) {
    let Some(controllers) = object.get("_stykIK").filter(|c| c.truthy()).and_then(Value::as_obj).cloned() else { return };
    let mut out = Obj::new();
    for (id, controller) in controllers.iter() {
        let mut next = controller.as_obj().cloned().unwrap_or_default();
        for field in ["joinedFollowers", "joinedAttachmentOffsets", "joinedSpatialFollowers"] {
            let Some(table) = controller.get(field).filter(|t| t.truthy()) else { continue };
            let mut entries: Vec<(u32, Value)> = table
                .as_obj()
                .map(|t| t.iter().filter_map(|(key, value)| key.parse::<u32>().ok().and_then(|old| map.iter().find(|(from, _)| *from == old)).map(|(_, to)| (*to, value.clone()))).collect())
                .unwrap_or_default();
            entries.sort_by_key(|(to, _)| *to);
            let mut remapped = Obj::new();
            for (to, value) in entries {
                remapped.set(&to.to_string(), value);
            }
            next.set(field, Value::object(remapped));
        }
        out.set(id, Value::object(next));
    }
    object.set("_stykIK", Value::object(out));
}

impl Editor {
    /// `assertLayers(editor, ids)`: layers that exist and are not locked.
    fn assert_layers(&self, ids: &[String]) -> Result<(), EditError> {
        let layers = self.report.path(&["_styk", "layers"]);
        if ids.is_empty() {
            return Err(invalid("selectALayer"));
        }
        for id in ids {
            let listed = fixed(id) || items(layers.and_then(|l| l.get("order"))).iter().any(|layer| layer.as_str() == Some(id.as_str()));
            if !listed {
                return Err(invalid("theSelectedLayerNoLongerExists"));
            }
            if self.track_locked(id) {
                return Err(crate::invalid_with("errors.editorLayerSheet.unlockBeforeEditingIt", vec![("name", Value::str(&crate::layers::layer_title(layers, id)))]));
            }
        }
        Ok(())
    }

    fn drawing_layer_id(&self, id: &str) -> bool {
        !fixed(id) && self.report.path(&["_styk", "layers", "byId", id, "drawing", "version"]).and_then(Value::as_f64) == Some(1.0)
    }

    /// `sheetCopyFrames(ids, start, end = start)`: each layer's poses at `start`, at its
    /// keys up to `end` and at its end inside the range, with their easing. Returns the
    /// clipboard, which the editor keeps to itself (not compared).
    pub(crate) fn sheet_copy_frames(&mut self, ids: &Value, start: f64, end: &Value) -> Result<Value, EditError> {
        let end = if end.is_null() { start } else { end.as_f64().unwrap_or(f64::NAN) };
        let ids = distinct(ids, "selectDistinctSourceLayers")?;
        self.assert_layers(&ids)?;
        let sheet = self.report.path(&["_styk", "layerSheet"]).cloned().ok_or_else(|| EditError::Unported("copying frames without a layer timeline".into()))?;
        let mut rows = Vec::with_capacity(ids.len());
        let mut types: Vec<f64> = Vec::new();
        for id in &ids {
            let track = sheet.path(&["tracks", id]).cloned();
            let keys = items(track.as_ref().and_then(|t| t.get("keys")));
            let mut ticks = vec![start];
            ticks.extend(keys.iter().filter_map(|k| num(k, "tick")).filter(|&t| t > start && t <= end));
            if !fixed(id) {
                let track_end = track.as_ref().and_then(|t| num(t, "end")).ok_or_else(|| EditError::Unported("a layer without a track".into()))?;
                if track_end > start && track_end <= end {
                    ticks.push(track_end);
                }
            }
            let mut entries = Vec::with_capacity(ticks.len());
            for tick in ticks {
                let frame = self.evaluated(tick, false)?;
                let (uids, steps): (Vec<u32>, Vec<Value>) = if fixed(id) {
                    (Vec::new(), Vec::new())
                } else {
                    let uids = objects_of(&frame).iter().filter_map(uid).filter(|u| self.layer_of(*u) == *id).collect();
                    let steps = continuations(&frame).into_iter().filter(|step| num(step, "uid").is_some_and(|u| self.layer_of(u as u32) == *id)).collect();
                    (uids, steps)
                };
                let owned = self.owned_frame(&frame, &uids, &steps)?;
                let objects = objects_of(&owned);
                types.extend(objects.iter().filter_map(|o| num(o, "figure_type_id")));
                types.extend(continuations(&owned).iter().filter_map(|step| num(step, "typeId")));
                let at = key_at(&keys, tick).map(|i| keys[i].clone()).unwrap_or_else(constant);
                let mut easing = Obj::new();
                for (name, value) in key_easing(&at) {
                    easing.set(name, value);
                }
                entries.push(Entry { offset: tick - start, frame: owned, easing: Value::object(easing) });
            }
            let drawing = self.drawing_layer_id(id);
            rows.push(Row { id: id.clone(), drawing, keys: entries });
        }
        let figures = items(self.report.get("figure_types")).into_iter().filter(|f| num(f, "figure_type_id").is_some_and(|t| types.contains(&t))).collect();
        let backgrounds = items(self.report.get("backgrounds"));
        let phases = self.clip_phases(&rows, start)?;
        self.sheet_clipboard = Some(Clipboard { start, duration: end - start + 1.0, rows, phases, figures, backgrounds, foreign: false });
        Ok(Value::Null)
    }

    /// The phase of every movieclip on the presence clock in the copied rows, where it first
    /// appears (`phases` of `sheetCopyFrames`).
    fn clip_phases(&self, rows: &[Row], start: f64) -> Result<Vec<(u32, f64)>, EditError> {
        let mut phases: Vec<(u32, f64)> = Vec::new();
        let figures = items(self.report.get("figure_types"));
        let fps = num(&self.report, "fps").unwrap_or(f64::NAN);
        let mut prepared = None;
        for row in rows {
            for key in &row.keys {
                let mut members: Vec<(u32, Value, Value)> = objects_of(&key.frame)
                    .iter()
                    .filter(|o| uses_presence(o))
                    .filter_map(|o| Some((uid(o)?, o.get("figure_type_id").cloned().unwrap_or(Value::Null), o.get("_stykMovieclip").cloned().unwrap_or(Value::Null))))
                    .collect();
                members.extend(continuations(&key.frame).iter().filter_map(|step| Some((num(step, "uid")? as u32, step.get("typeId").cloned().unwrap_or(Value::Null), step.get("playback").cloned().unwrap_or(Value::Null)))));
                for (member, type_id, playback) in members {
                    if phases.iter().any(|(u, _)| *u == member) {
                        continue;
                    }
                    if prepared.is_none() {
                        prepared = Some(self.prepared()?);
                    }
                    let asset = figures.iter().find(|f| f.get("figure_type_id") == Some(&type_id)).and_then(|f| f.path(&["_styk", "movieclip"]).cloned());
                    let offset = playback.get("offset").filter(|v| !v.is_null()).and_then(Value::as_f64).unwrap_or(0.0);
                    let clip_fps = asset.as_ref().and_then(|a| a.path(&["document", "fps"])).and_then(Value::as_f64).unwrap_or(fps);
                    let duration = asset.as_ref().and_then(|a| num(a, "duration")).unwrap_or(f64::NAN);
                    let raw = offset + prepared.as_ref().unwrap().presence_elapsed(member, start + key.offset) * clip_fps / fps;
                    let phase = match playback.get("mode").and_then(Value::as_str) {
                        Some("single") => offset,
                        Some("loop") => raw % duration,
                        mode => raw.min(duration - if mode == Some("once") { 0.0 } else { 1.0 }),
                    };
                    phases.push((member, phase));
                }
            }
        }
        Ok(phases)
    }

    /// `sheetTransferFrames(ids, destinations, start, end, tick, {copy})`: a range of layers
    /// moved (or copied) onto other rows at `tick`, as one batch; the clipboard left as it was.
    pub(crate) fn sheet_transfer_frames(&mut self, ids: &Value, destinations: &Value, start: f64, end: f64, tick: &Value, options: &Value) -> Result<Value, EditError> {
        let sources = distinct_list(ids)?;
        let targets = distinct_list(destinations)?;
        self.assert_layers(&sources.iter().chain(&targets).cloned().collect::<Vec<_>>())?;
        let copy = options.get("copy").is_some_and(Value::truthy);
        let kept = self.sheet_clipboard.clone();
        let result = (|| {
            self.sheet_copy_frames(ids, start, &Value::Num(end))?;
            self.begin_batch(if copy { "Copy frames to layer" } else { "Move frames to layer" })?;
            let moved = (|| {
                if !copy {
                    self.sheet_clear_frames(ids, start, &Value::Num(end))?;
                    self.retain_moved_phases(&sources, start)?;
                }
                self.sheet_paste_frames(destinations, tick, &Value::Null)
            })();
            match moved {
                Ok(pasted) => {
                    self.end_batch()?;
                    Ok(Value::Bool(pasted))
                }
                Err(error) => {
                    if matches!(error, EditError::Invalid(_)) {
                        self.abort_batch()?;
                    }
                    Err(error)
                }
            }
        })();
        self.sheet_clipboard = kept;
        result
    }

    /// The source rows of a move keep where their presence-clock movieclips were: a later
    /// appearance there does not jump back because the frames in between moved away.
    fn retain_moved_phases(&mut self, sources: &[String], start: f64) -> Result<(), EditError> {
        let clipboard = self.sheet_clipboard.clone().unwrap();
        let mut plan = self.planner(sources)?;
        let mut changed = false;
        for row in &clipboard.rows {
            for entry in &row.keys {
                let mut steps: Vec<Value> = continuations(&entry.frame);
                for object in objects_of(&entry.frame).iter().filter(|o| uses_presence(o)) {
                    let mut step = Obj::new();
                    step.set("uid", object.get("unique_id").cloned().unwrap_or(Value::Null));
                    step.set("typeId", object.get("figure_type_id").cloned().unwrap_or(Value::Null));
                    step.set("playback", object.get("_stykMovieclip").cloned().unwrap_or(Value::Null));
                    steps.push(Value::object(step));
                }
                if steps.is_empty() {
                    continue;
                }
                // One step a figure, where it first appears, with its last value.
                let mut unique: Vec<(Value, Value)> = Vec::new();
                for step in steps {
                    let id = step.get("uid").cloned().unwrap_or(Value::Null);
                    match unique.iter_mut().find(|(u, _)| *u == id) {
                        Some(entry) => entry.1 = step,
                        None => unique.push((id, step)),
                    }
                }
                let mut frame = entry.frame.as_obj().cloned().unwrap_or_default();
                for key in ["objects", "object_draw_order", "object_draw_order_unique_ids"] {
                    frame.set(key, Value::array(Vec::new()));
                }
                let mut styk = frame.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
                styk.set("movieclipContinuations", Value::array(unique.into_iter().map(|(_, step)| step).collect()));
                frame.set("_styk", Value::object(styk));
                plan.write(&row.id, start + entry.offset, &Value::object(frame), Write::default())?;
                changed = true;
            }
        }
        if changed {
            let selection = self.selection_state();
            self.publish(plan, "Retain moved movieclip phase", selection, None)?;
        }
        Ok(())
    }

    /// `sheetPasteFrames(ids, tick, {insert})`: the clipboard's rows on `ids` (or, given one
    /// layer, on it and the layers below it), replacing the frames they cover or inserted
    /// before what follows. Figures pasted on a layer other than theirs take new identities.
    pub(crate) fn sheet_paste_frames(&mut self, ids: &Value, tick: &Value, options: &Value) -> Result<bool, EditError> {
        let Some(clipboard) = self.sheet_clipboard.clone() else { return Err(invalid("copyTimelineFramesFirst")) };
        let tick = tick.as_f64().filter(|t| t.fract() == 0.0 && (0.0..MAX_SHEET_TICKS).contains(t)).ok_or_else(|| invalid("chooseAValidWholeFrame"))?;
        let ids = distinct(ids, "selectDistinctDestinationLayers")?;
        let insert = options.get("insert").is_some_and(Value::truthy);
        let rows = &clipboard.rows;
        let foreign = clipboard.foreign;
        if ids.len() != 1 && ids.len() != rows.len() {
            return Err(invalid("selectOneDestinationLayerOrTheSameNumber"));
        }
        let destinations = if ids.len() == rows.len() {
            ids.clone()
        } else {
            let mut ordered: Vec<String> = items(self.report.path(&["_styk", "layers", "order"])).iter().filter_map(|id| id.as_str().map(str::to_string)).collect();
            ordered.reverse();
            let offset = ordered.iter().position(|id| *id == ids[0]).map_or(-1, |at| at as i64);
            js_slice(&ordered, offset, offset + rows.len() as i64)
        };
        if destinations.len() != rows.len() {
            return Err(invalid("createEnoughDestinationLayersForThisRange"));
        }
        if rows.iter().zip(&destinations).any(|(row, id)| row.drawing != self.drawing_layer_id(id)) {
            return Err(invalid("pasteDrawingKeysIntoDrawingLayersAndFigure"));
        }
        if rows.iter().zip(&destinations).any(|(row, id)| (fixed(&row.id) || fixed(id)) && row.id != *id) {
            return Err(invalid("pasteFramesIntoTheSameTrackKindFigures"));
        }
        let mut plan = self.planner(&destinations)?;
        let finish = tick + clipboard.duration;
        if finish > MAX_SHEET_TICKS {
            return Err(invalid("pastedFramesExceedTheTimelineLimit"));
        }
        // Every identity of the range is allocated first, so joins to a figure that
        // appears later in the range follow it.
        let mut next_uid = self.next_uid;
        let mut map: Vec<(u32, u32)> = Vec::new();
        for (row, id) in rows.iter().zip(&destinations) {
            for entry in &row.keys {
                let steps = continuations(&entry.frame).iter().filter_map(|step| num(step, "uid").map(|u| u as u32)).collect::<Vec<_>>();
                let parts = objects_of(&entry.frame).iter().filter_map(|o| o.path(&["_stykMovieclipPart", "instance"]).and_then(Value::as_f64).map(|u| u as u32)).collect::<Vec<_>>();
                for old in objects_of(&entry.frame).iter().filter_map(uid).chain(steps).chain(parts) {
                    if !foreign && row.id == *id && self.layer_of(old) == *id {
                        continue;
                    }
                    if !map.iter().any(|(from, _)| *from == old) {
                        if next_uid > 0x7ffffffe {
                            return Err(invalid("objectIdentityCapacityReached"));
                        }
                        map.push((old, next_uid as u32));
                        next_uid += 1;
                    }
                }
            }
        }
        // Every drawing cel is a cel of its own, with the pixels of the one it copies; copied from another document, every
        // definition (and, with the scene, every background) is a new one.
        let mut type_map: Vec<(f64, f64)> = Vec::new();
        let mut background_map: Vec<(f64, f64)> = vec![(0.0, 0.0)];
        let mut forks: Vec<(String, String)> = Vec::new();
        if foreign || clipboard.drawings().next().is_some() {
            let figures = items(self.report.get("figure_types"));
            let mut next_type = figures.iter().filter_map(|f| num(f, "figure_type_id")).fold(0.0f64, f64::max) + 1.0;
            let mut definitions = Vec::with_capacity(clipboard.figures.len());
            for figure in &clipboard.figures {
                let drawing = figure.path(&["_styk", "drawing"]).is_some_and(Value::truthy);
                if !foreign && !drawing {
                    continue;
                }
                let old = num(figure, "figure_type_id").unwrap_or(f64::NAN);
                type_map.push((old, next_type));
                let mut copy = figure.clone();
                let cel = if drawing { Some(format!("cel-{}", self.draw_uuid()?)) } else { None };
                if let Some(record) = copy.make_obj() {
                    record.set("figure_type_id", Value::Num(next_type));
                    if let Some(cel) = &cel
                        && let Some(drawing) = record.get_mut("_styk").and_then(Value::make_obj).and_then(|styk| styk.get_mut("drawing")).and_then(Value::make_obj)
                    {
                        if let Some(from) = drawing.get("celId").and_then(Value::as_str).filter(|_| !foreign) {
                            forks.push((from.to_string(), cel.clone()));
                        }
                        drawing.set("celId", Value::str(cel));
                    }
                }
                next_type += 1.0;
                definitions.push(copy);
            }
            plan.definitions = definitions;
            if foreign && rows.iter().any(|row| row.id == "scene") {
                let mut next_background = items(self.report.get("backgrounds")).iter().filter_map(|b| num(b, "background_id")).fold(0.0f64, f64::max) + 1.0;
                for background in &clipboard.backgrounds {
                    background_map.push((num(background, "background_id").unwrap_or(f64::NAN), next_background));
                    let mut copy = background.clone();
                    if let Some(record) = copy.make_obj() {
                        record.set("background_id", Value::Num(next_background));
                    }
                    plan.backgrounds.push(copy);
                    next_background += 1.0;
                }
            }
        }
        let renamed = |old: u32| map.iter().find(|(from, _)| *from == old).map(|(_, to)| *to);
        let phase_of = |old: u32| clipboard.phases.iter().find(|(u, _)| *u == old).map(|(_, p)| *p);
        for (row, id) in rows.iter().zip(&destinations) {
            let restore = self.evaluated(finish, false)?;
            let old_end = plan.end(id);
            if insert {
                let shifted = plan
                    .keys(id)
                    .into_iter()
                    .map(|key| match num(&key, "tick") {
                        Some(at) if at >= tick => {
                            let mut key = key.as_obj().cloned().unwrap_or_default();
                            key.set("tick", Value::Num(at + clipboard.duration));
                            Value::object(key)
                        }
                        _ => key,
                    })
                    .collect();
                plan.set_keys(id, shifted);
            } else {
                let kept = plan.keys(id).into_iter().filter(|k| num(k, "tick").is_some_and(|at| at < tick || at >= finish)).collect();
                plan.set_keys(id, kept);
            }
            if !fixed(id) && tick > old_end && !plan.keys(id).is_empty() {
                plan.write(id, old_end, &Value::object(Obj::new()), Write { blank: true, ..Write::default() })?;
            }
            let end = finish.max(old_end + if insert { clipboard.duration } else { 0.0 });
            plan.set_end(id, end);
            for entry in &row.keys {
                let mut frame = crate::sheet_frames::shift_clip_time(&entry.frame, tick - clipboard.start);
                if !type_map.is_empty() {
                    let mut record = frame.as_obj().cloned().unwrap_or_default();
                    let objects: Vec<Value> = objects_of(&frame)
                        .into_iter()
                        .map(|mut object| {
                            let old = num(&object, "figure_type_id").unwrap_or(f64::NAN);
                            if let (Some((_, new)), Some(record)) = (type_map.iter().find(|(from, _)| *from == old), object.make_obj()) {
                                styk_eval::vfx::remap_owner(record, *new, None, old);
                                record.set("figure_type_id", Value::Num(*new));
                            }
                            object
                        })
                        .collect();
                    record.set("objects", Value::array(objects));
                    frame = Value::object(record);
                }
                if foreign {
                    // The backgrounds the scene row brought are the document's now; any other frame shows none.
                    let mut record = frame.as_obj().cloned().unwrap_or_default();
                    for field in ["background_id", "background_id_b"] {
                        let mapped = record.get(field).and_then(Value::as_f64).and_then(|old| background_map.iter().find(|(from, _)| *from == old)).map_or(0.0, |(_, to)| *to);
                        record.set(field, Value::Num(mapped));
                    }
                    frame = Value::object(record);
                }
                if !map.is_empty() || foreign {
                    let mut record = frame.as_obj().cloned().unwrap_or_default();
                    let mut objects = objects_of(&frame);
                    for object in objects.iter_mut() {
                        let Some(old) = uid(object) else { continue };
                        let Some(record) = object.make_obj() else { continue };
                        // The part of a broken-apart movieclip follows its instance.
                        if let Some(instance) = record.get("_stykMovieclipPart").and_then(|part| part.get("instance")).and_then(Value::as_f64).and_then(|instance| renamed(instance as u32)) {
                            if let Some(part) = record.get_mut("_stykMovieclipPart").and_then(Value::make_obj) {
                                part.set("instance", Value::Num(instance as f64));
                            }
                        }
                        if let Some(new) = renamed(old) {
                            record.set("unique_id", Value::Num(new as f64));
                            plan.assign(new, id);
                            // A pasted presence-clock clip carries on from where it was copied.
                            if let (true, Some(phase)) = (uses_presence(&Value::object(record.clone())), phase_of(old)) {
                                let mut playback = record.get("_stykMovieclip").and_then(Value::as_obj).cloned().unwrap_or_default();
                                playback.set("offset", Value::Num(phase));
                                record.set("_stykMovieclip", Value::object(playback));
                            }
                        }
                    }
                    let steps: Vec<Value> = continuations(&frame)
                        .into_iter()
                        .map(|step| {
                            let mut step = step.as_obj().cloned().unwrap_or_default();
                            let Some(old) = step.get("uid").and_then(Value::as_f64).map(|u| u as u32) else { return Value::object(step) };
                            if foreign && let Some((_, new)) = step.get("typeId").and_then(Value::as_f64).and_then(|from| type_map.iter().find(|(old, _)| *old == from)) {
                                step.set("typeId", Value::Num(*new));
                            }
                            if let Some(new) = renamed(old) {
                                step.set("uid", Value::Num(new as f64));
                                plan.assign(new, id);
                                if let Some(phase) = phase_of(old) {
                                    let mut playback = step.get("playback").and_then(Value::as_obj).cloned().unwrap_or_default();
                                    playback.set("offset", Value::Num(phase));
                                    step.set("playback", Value::object(playback));
                                }
                            }
                            Value::object(step)
                        })
                        .collect();
                    if !steps.is_empty() {
                        let mut styk = record.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
                        styk.set("movieclipContinuations", Value::array(steps));
                        record.set("_styk", Value::object(styk));
                    }
                    for object in objects.iter_mut() {
                        let Some(record) = object.make_obj() else { continue };
                        if let Some(join) = record.get("join").filter(|j| j.truthy()).and_then(Value::as_obj).cloned() {
                            let mut join = join;
                            if let Some(target) = join.get("target_unique_id").and_then(Value::as_f64).and_then(|t| renamed(t as u32)) {
                                join.set("target_unique_id", Value::Num(target as f64));
                            }
                            record.set("join", Value::object(join));
                        }
                        remap_followers(record, &map);
                    }
                    let order: Vec<Value> = items(record.get("object_draw_order"))
                        .iter()
                        .map(|slot| slot.as_f64().and_then(|s| objects.get(s as usize)).and_then(|o| o.get("unique_id").cloned()).unwrap_or(Value::Null))
                        .collect();
                    record.set("objects", Value::array(objects));
                    record.set("object_draw_order_unique_ids", Value::array(order));
                    frame = Value::object(record);
                }
                plan.write(id, tick + entry.offset, &frame, Write { easing: Some(&entry.easing), ..Write::default() })?;
            }
            let keys = plan.keys(id);
            let at_finish = keys.iter().find(|k| num(k, "tick") == Some(finish));
            if !insert && finish < old_end && at_finish.is_none_or(|k| k.get("patchOnly").is_some_and(Value::truthy)) {
                plan.write(id, finish, &restore, Write::default())?;
            }
            plan.set_end(id, end);
            plan.duration = plan.duration.max(end);
        }
        let selection = self.selection_state();
        let published = self.publish(plan, "Paste frames", selection, None)?;
        self.next_uid = next_uid;
        self.drawing_forks.extend(forks);
        Ok(published)
    }
}

impl Clipboard {
    /// The clipboard as the interface holds it (`editor._sheetClipboard`), without the document it came from
    /// (the interface knows that).
    pub(crate) fn to_wire(&self) -> Value {
        let mut wire = Obj::new();
        wire.set("version", Value::Num(1.0));
        wire.set("start", Value::Num(self.start));
        wire.set("duration", Value::Num(self.duration));
        let rows = self.rows.iter().map(|row| {
            let mut out = Obj::new();
            out.set("id", Value::str(&row.id));
            out.set("drawing", Value::Bool(row.drawing));
            let keys = row.keys.iter().map(|entry| {
                let mut key = Obj::new();
                key.set("offset", Value::Num(entry.offset));
                key.set("frame", entry.frame.clone());
                key.set("easing", entry.easing.clone());
                Value::object(key)
            });
            out.set("keys", Value::array(keys.collect()));
            Value::object(out)
        });
        wire.set("rows", Value::array(rows.collect()));
        let mut phases = Obj::new();
        for (uid, phase) in &self.phases {
            phases.set(&uid.to_string(), Value::Num(*phase));
        }
        wire.set("phases", Value::object(phases));
        wire.set("figures", Value::array(self.figures.clone()));
        wire.set("backgrounds", Value::array(self.backgrounds.clone()));
        Value::object(wire)
    }

    /// The clipboard the interface hands over; `foreign` when it was copied in another document or restored from the
    /// system's clipboard.
    pub(crate) fn from_wire(data: &Value, foreign: bool) -> Result<Clipboard, EditError> {
        let invalid = || EditError::Invalid("errors.sharedClipboard.invalidTimelineClipboard".into());
        let list = |value: Option<&Value>| value.and_then(Value::elements).map(|items| items.iter().collect::<Vec<Value>>());
        if data.get("version").and_then(Value::as_f64) != Some(1.0) {
            return Err(invalid());
        }
        let start = data.get("start").and_then(Value::as_f64).filter(|start| start.is_finite()).ok_or_else(invalid)?;
        let duration = data.get("duration").and_then(Value::as_f64).filter(|duration| duration.fract() == 0.0 && *duration >= 1.0).ok_or_else(invalid)?;
        let rows = list(data.get("rows")).filter(|rows| !rows.is_empty()).ok_or_else(invalid)?;
        let rows = rows.iter().map(|row| {
            let keys = list(row.get("keys"))?.iter().map(|key| {
                let frame = key.get("frame").filter(|frame| frame.is_object())?.clone();
                Some(Entry { offset: key.get("offset")?.as_f64()?, frame, easing: key.get("easing").cloned().unwrap_or(Value::Null) })
            }).collect::<Option<Vec<_>>>()?;
            Some(Row { id: row.get("id")?.as_str()?.to_string(), drawing: row.get("drawing").is_some_and(Value::truthy), keys })
        }).collect::<Option<Vec<_>>>().ok_or_else(invalid)?;
        let phases = data.get("phases").and_then(Value::as_obj).map(|phases| phases.iter().filter_map(|(uid, phase)| Some((uid.parse::<u32>().ok()?, phase.as_f64()?))).collect()).unwrap_or_default();
        let figures = list(data.get("figures")).filter(|figures| figures.iter().all(Value::is_object)).ok_or_else(invalid)?;
        let backgrounds = list(data.get("backgrounds")).unwrap_or_default();
        Ok(Clipboard { start, duration, rows, phases, figures, backgrounds, foreign })
    }
}
