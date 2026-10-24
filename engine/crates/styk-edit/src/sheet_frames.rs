//! Keys and frames of the layer timeline (src/editor-layer-sheet.mjs): `sheetInsertKey`,
//! `sheetDuplicateFrameAfter`, `sheetSetEasing`, `sheetClearKeys`, `sheetClearFrames`,
//! `sheetInsertFrames`, `sheetRemoveFrames`, `sheetSetDuration`, `sheetAppendFrame`.
//! Each plans on the sheet planner and publishes one history entry ([`crate::sheet`]).
//! Drawing layers and audio ripple answer `Unported`.

use std::sync::Arc;

use styk_doc::{Obj, Value};

use crate::frame::objects_of;
use crate::record::uid;
use crate::sheet::{constant, items, key_at, key_easing, num, Plan, Write, MAX_SHEET_TICKS};
use crate::{EditError, Editor};

const WHOLE_FRAME: &str = "errors.editorLayerSheet.chooseAValidWholeFrame";

fn checked_tick(tick: f64) -> Result<f64, EditError> {
    if tick.fract() != 0.0 || !(0.0..MAX_SHEET_TICKS).contains(&tick) {
        return Err(EditError::Invalid(WHOLE_FRAME.into()));
    }
    Ok(tick)
}

/// `usesPresence(object)`: a movieclip instance on the presence clock.
fn uses_presence(object: &Value) -> bool {
    object.path(&["_stykMovieclip", "clock"]).and_then(Value::as_str) == Some("presence")
}

/// A movieclip instance's playback span retimed by `map` (`start`, `end`, restarts).
/// Returns whether it changed.
fn retime_playback(object: &mut Obj, start: impl Fn(f64) -> f64, end: impl Fn(f64, f64) -> f64, restart: impl Fn(f64) -> f64) -> bool {
    let Some(playback) = object.get("_stykMovieclip").filter(|p| p.truthy()).and_then(Value::as_obj) else { return false };
    let before = styk_doc::json::to_string(&Value::object(playback.clone()));
    let mut playback = playback.clone();
    let began = start(playback.get("start").and_then(Value::as_f64).unwrap_or(0.0));
    playback.set("start", Value::Num(began));
    if let Some(ended) = playback.get("end").and_then(Value::as_f64) {
        playback.set("end", Value::Num(end(began, ended)));
    }
    if let Some(restarts) = playback.get("restarts").filter(|r| r.truthy()) {
        let moved = items(Some(restarts)).into_iter().map(|key| {
            let mut key = key.as_obj().cloned().unwrap_or_default();
            let tick = key.get("tick").and_then(Value::as_f64).unwrap_or(f64::NAN);
            key.set("tick", Value::Num(restart(tick)));
            Value::object(key)
        });
        playback.set("restarts", Value::array(moved.collect()));
    }
    let changed = before != styk_doc::json::to_string(&Value::object(playback.clone()));
    object.set("_stykMovieclip", Value::object(playback));
    changed
}

/// `shiftClipTime(clone(frame), delta)`: clips on the document's clock start `delta` later.
pub(crate) fn shift_clip_time(frame: &Value, delta: f64) -> Value {
    let objects: Vec<Value> = objects_of(frame)
        .into_iter()
        .map(|object| {
            if !object.get("_stykMovieclip").is_some_and(Value::truthy) || uses_presence(&object) {
                return object;
            }
            let mut record = object.as_obj().cloned().unwrap_or_default();
            retime_playback(&mut record, |start| (start + delta).max(0.0), |start, end| (start + 1.0).max(end + delta), |tick| (tick + delta).max(0.0));
            Value::object(record)
        })
        .collect();
    let mut out = frame.as_obj().cloned().unwrap_or_default();
    out.set("objects", Value::array(objects));
    Value::object(out)
}

impl Editor {
    fn list(&self, ids: &Value) -> Vec<String> {
        match ids.elements() {
            Some(ids) => ids.iter().filter_map(|id| id.as_str().map(str::to_string)).collect(),
            None => vec![self.active_layer()],
        }
    }

    fn tick_or_playhead(&self, tick: &Value) -> f64 {
        if tick.is_null() { self.tick } else { tick.as_f64().unwrap_or(f64::NAN) }
    }

    fn drawing_layer(&self, ids: &[String]) -> bool {
        ids.iter().any(|id| self.report.path(&["_styk", "layers", "byId", id, "drawing", "version"]).and_then(Value::as_f64) == Some(1.0))
    }

    /// `retimeClips(editor, plan, id, map)`: the playback spans of the layer's clips
    /// follow frames inserted or removed before them.
    fn retime_clips(&self, plan: &mut Plan, id: &str, map: &dyn Fn(f64) -> f64) -> Result<(), EditError> {
        let clips = items(self.report.get("figure_types")).iter().any(|figure| figure.path(&["_styk", "movieclip"]).is_some_and(Value::truthy));
        if !clips {
            return Ok(());
        }
        let on_layer = |object: &Value| object.get("_stykMovieclip").is_some_and(Value::truthy) && uid(object).is_some_and(|u| self.layer_of(u) == id);
        let mut keys = plan.keys(id);
        for (at, key) in keys.clone().into_iter().enumerate() {
            let old = items(plan.before.path(&["tracks", id, "keys"])).into_iter().find(|k| k.get("id") == key.get("id"));
            let frame = match (num(&key, "sourceTick"), key.path(&["value", "frameId"]).and_then(Value::as_str)) {
                (Some(_), _) => Some(self.evaluated(old.as_ref().and_then(|k| num(k, "tick")).or_else(|| num(&key, "tick")).unwrap_or(0.0), false)?),
                (None, Some(frame_id)) => plan.captured(frame_id).cloned().or_else(|| self.frame_by_id(frame_id)),
                (None, None) => None,
            };
            let Some(frame) = frame.filter(|frame| objects_of(frame).iter().any(on_layer)) else { continue };
            let mut changed = false;
            let objects: Vec<Value> = objects_of(&frame)
                .into_iter()
                .map(|object| {
                    if !on_layer(&object) || uses_presence(&object) {
                        return object;
                    }
                    let mut record = object.as_obj().cloned().unwrap_or_default();
                    changed |= retime_playback(&mut record, map, |start, end| (start + 1.0).max(map(end)), map);
                    Value::object(record)
                })
                .collect();
            if changed {
                let mut source = frame.as_obj().cloned().unwrap_or_default();
                source.set("objects", Value::array(objects));
                let mut owned = key.as_obj().cloned().unwrap_or_default();
                owned.set("value", plan.capture(&Value::object(source), id));
                owned.remove("sourceTick");
                keys[at] = Value::object(owned);
            }
        }
        plan.set_keys(id, keys);
        Ok(())
    }

    /// Every key of the layer at or after `start` moves by `by` frames.
    fn shift_keys(plan: &mut Plan, id: &str, start: f64, by: f64) {
        let keys = plan
            .keys(id)
            .into_iter()
            .map(|key| match num(&key, "tick") {
                Some(tick) if tick >= start => {
                    let mut key = key.as_obj().cloned().unwrap_or_default();
                    key.set("tick", Value::Num(tick + by));
                    Value::object(key)
                }
                _ => key,
            })
            .collect();
        plan.set_keys(id, keys);
    }

    pub(crate) fn sheet_insert_key(&mut self, ids: &Value, tick: &Value, options: &Value) -> Result<bool, EditError> {
        let (ids, tick) = (self.list(ids), self.tick_or_playhead(tick));
        let blank = options.get("blank").is_some_and(Value::truthy);
        if self.drawing_layer(&ids) {
            return Err(EditError::Unported("keys on a drawing layer".into()));
        }
        checked_tick(tick)?;
        let mut plan = self.planner(&ids)?;
        for id in &ids {
            let keys = plan.keys(id);
            let end = plan.end(id);
            let previous = key_at(&keys, tick).map(|i| keys[i].clone());
            let source = if !blank && tick >= end { (end - 1.0).max(0.0) } else { tick };
            let frame = shift_clip_time(&self.evaluated(source, false)?, tick - source);
            let held = constant();
            plan.write(id, tick, &frame, Write { blank, easing: Some(previous.as_ref().unwrap_or(&held)), extend: true })?;
        }
        let selection = self.selection_state();
        self.publish(plan, if blank { "Insert blank keyframe" } else { "Insert keyframe" }, selection, None)
    }

    pub(crate) fn sheet_duplicate_frame_after(&mut self, ids: &Value, tick: &Value) -> Result<bool, EditError> {
        let (ids, tick) = (self.list(ids), self.tick_or_playhead(tick));
        if self.drawing_layer(&ids) {
            return Err(EditError::Unported("frames on a drawing layer".into()));
        }
        checked_tick(tick)?;
        let start = checked_tick(tick + 1.0)?;
        let mut plan = self.planner(&ids)?;
        for id in &ids {
            let end = plan.end(id);
            let source = tick.min((end - 1.0).max(0.0));
            let frame = shift_clip_time(&self.evaluated(source, false)?, start - source);
            let keys = plan.keys(id);
            let previous = key_at(&keys, source).map(|i| keys[i].clone());
            Self::shift_keys(&mut plan, id, start, 1.0);
            plan.set_end(id, start.max(end) + 1.0);
            self.retime_clips(&mut plan, id, &|time| if time >= start { time + 1.0 } else { time })?;
            let held = constant();
            plan.write(id, start, &frame, Write { easing: Some(previous.as_ref().unwrap_or(&held)), extend: true, ..Write::default() })?;
            plan.duration = plan.duration.max(plan.end(id));
        }
        let selection = self.selection_state();
        self.publish(plan, "Duplicate frame after current", selection, None)?;
        self.seek(start)?;
        // The entry redoes to the new frame.
        let after = self.selection_state();
        if !self.undo.is_empty() {
            if let Some(command) = Arc::make_mut(&mut self.undo).last_mut() {
                command.after_selection = after;
            }
        }
        Ok(true)
    }

    pub(crate) fn sheet_set_easing(&mut self, ids: &Value, start: f64, end: f64, easing: &Value) -> Result<bool, EditError> {
        let ids = self.list(ids);
        let interpolation = easing.get("interpolation").and_then(Value::as_str);
        if self.drawing_layer(&ids) && !matches!(interpolation, Some("constant" | "hold")) {
            return Err(EditError::Invalid("errors.editorLayerSheet.drawingExposuresHoldTheirPixelsAndPoseUse".into()));
        }
        let mut plan = self.planner(&ids)?;
        valid_easing(easing)?;
        let fields = key_easing(easing);
        for id in &ids {
            let keys = plan.keys(id);
            let first = key_at(&keys, start);
            let eased = keys.into_iter().enumerate().map(|(at, key)| {
                let tick = num(&key, "tick").unwrap_or(f64::NAN);
                if Some(at) != first && !(tick >= start && tick <= end) {
                    return key;
                }
                let mut key = key.as_obj().cloned().unwrap_or_default();
                key.remove("bezier");
                for (name, value) in &fields {
                    key.set(name, value.clone());
                }
                Value::object(key)
            });
            let eased = eased.collect();
            plan.set_keys(id, eased);
        }
        let selection = self.selection_state();
        self.publish(plan, "Set frame interpolation", selection, None)
    }

    pub(crate) fn sheet_clear_keys(&mut self, ids: &Value, start: f64, end: &Value) -> Result<bool, EditError> {
        let (ids, end) = (self.list(ids), end.as_f64().unwrap_or(start));
        let mut plan = self.planner(&ids)?;
        for id in &ids {
            let kept = plan.keys(id).into_iter().filter(|key| num(key, "tick").is_some_and(|tick| tick < start || tick > end)).collect();
            plan.set_keys(id, kept);
        }
        let selection = self.selection_state();
        self.publish(plan, "Clear keyframes", selection, None)
    }

    pub(crate) fn sheet_clear_frames(&mut self, ids: &Value, start: f64, end: &Value) -> Result<bool, EditError> {
        let (ids, end) = (self.list(ids), end.as_f64().unwrap_or(start));
        let mut plan = self.planner(&ids)?;
        let after = self.evaluated(end + 1.0, false)?;
        let cleared = self.evaluated(start, false)?;
        for id in &ids {
            let finish = plan.end(id);
            let kept = plan.keys(id).into_iter().filter(|key| num(key, "tick").is_some_and(|tick| tick < start || tick > end)).collect();
            plan.set_keys(id, kept);
            plan.write(id, start, &cleared, Write { blank: true, ..Write::default() })?;
            let next = plan.keys(id).into_iter().find(|key| num(key, "tick") == Some(end + 1.0));
            if end + 1.0 < finish && next.is_none_or(|key| key.get("patchOnly").is_some_and(Value::truthy)) {
                plan.write(id, end + 1.0, &after, Write::default())?;
            }
        }
        let selection = self.selection_state();
        self.publish(plan, "Clear frames", selection, None)
    }

    /// Whether an edit of these layers' frames moves the audio with it (`audioRipple`: every layer is edited).
    fn ripples_audio(&self, ids: &[String]) -> bool {
        self.audio_ripple && !self.audio_rippling && {
            let order = self.report.path(&["_styk", "layers", "order"]).and_then(Value::elements).map(|order| order.iter().filter_map(|id| id.as_str().map(str::to_string)).collect::<Vec<_>>()).unwrap_or_default();
            ["scene".to_string(), "camera".to_string()].iter().chain(&order).all(|id| ids.contains(id))
        }
    }

    /// Runs `operation` as one history entry with the audio rippled before it (`movieclipBatch(label, …)`).
    fn with_audio_ripple(&mut self, label: &str, start: f64, removed: f64, inserted: f64, operation: impl FnOnce(&mut Editor) -> Result<bool, EditError>) -> Result<bool, EditError> {
        let outer = self.batch.is_none();
        self.begin_batch(label)?;
        self.audio_rippling = true;
        let result = self.ripple_audio(start, removed, inserted).and_then(|_| operation(self));
        self.audio_rippling = false;
        match result {
            Ok(done) => self.end_batch().map(|()| done),
            Err(error) => {
                if outer { self.abort_batch()?; } else { self.end_batch()?; }
                Err(error)
            }
        }
    }

    pub(crate) fn sheet_insert_frames(&mut self, ids: &Value, start: f64, count: &Value) -> Result<bool, EditError> {
        let layers = self.list(ids);
        if self.ripples_audio(&layers) {
            let inserted = if count.is_null() { 1.0 } else { count.as_f64().unwrap_or(f64::NAN) };
            return self.with_audio_ripple("Insert scene frames with audio", start, 0.0, inserted, |editor| editor.sheet_insert_frames(ids, start, count));
        }
        let ids = layers;
        let count = if count.is_null() { 1.0 } else { count.as_f64().unwrap_or(f64::NAN) };
        checked_tick(start)?;
        if count.fract() != 0.0 || count.is_nan() || count < 1.0 || start + count >= MAX_SHEET_TICKS {
            return Err(EditError::Invalid("errors.editorLayerSheet.chooseAValidFrameCount".into()));
        }
        let mut plan = self.planner(&ids)?;
        let frame = self.evaluated((start - 1.0).max(0.0), false)?;
        for id in &ids {
            let had = plan.keys(id).iter().any(|key| num(key, "tick") == Some(start));
            Self::shift_keys(&mut plan, id, start, count);
            let end = start.max(plan.end(id)) + count;
            plan.set_end(id, end);
            self.retime_clips(&mut plan, id, &|tick| if tick >= start { tick + count } else { tick })?;
            if had && start == 0.0 {
                // The new opening exposure starts now; only the original keys move.
                let objects: Vec<Value> = objects_of(&frame)
                    .into_iter()
                    .map(|object| {
                        if !object.get("_stykMovieclip").is_some_and(Value::truthy) || uses_presence(&object) {
                            return object;
                        }
                        let mut record = object.as_obj().cloned().unwrap_or_default();
                        if let Some(mut playback) = record.get("_stykMovieclip").and_then(Value::as_obj).cloned() {
                            let began = playback.get("start").and_then(Value::as_f64);
                            if began.is_some_and(|start| start > 0.0) {
                                playback.set("start", Value::Num(began.unwrap() + count));
                            }
                            if let Some(ended) = playback.get("end").and_then(Value::as_f64) {
                                playback.set("end", Value::Num(ended + count));
                            }
                            if let Some(restarts) = playback.get("restarts").filter(|r| r.truthy()) {
                                let moved = items(Some(restarts)).into_iter().map(|key| match num(&key, "tick") {
                                    Some(tick) if tick > 0.0 => {
                                        let mut key = key.as_obj().cloned().unwrap_or_default();
                                        key.set("tick", Value::Num(tick + count));
                                        Value::object(key)
                                    }
                                    _ => key,
                                });
                                playback.set("restarts", Value::array(moved.collect()));
                            }
                            record.set("_stykMovieclip", Value::object(playback));
                        }
                        Value::object(record)
                    })
                    .collect();
                let mut opening = frame.as_obj().cloned().unwrap_or_default();
                opening.set("objects", Value::array(objects));
                plan.write(id, start, &Value::object(opening), Write::default())?;
            }
            plan.duration = plan.duration.max(plan.end(id));
        }
        let selection = self.selection_state();
        self.publish(plan, "Insert frames", selection, None)
    }

    pub(crate) fn sheet_remove_frames(&mut self, ids: &Value, start: f64, end: &Value) -> Result<bool, EditError> {
        let (layers, end) = (self.list(ids), end.as_f64().unwrap_or(start));
        if self.ripples_audio(&layers) {
            return self.with_audio_ripple("Remove scene frames with audio", start, end - start + 1.0, 0.0, |editor| editor.sheet_remove_frames(ids, start, &Value::Num(end)));
        }
        let ids = layers;
        let count = end - start + 1.0;
        if count.is_nan() || count < 1.0 {
            return Err(EditError::Invalid("errors.editorLayerSheet.selectFramesToRemove".into()));
        }
        let mut plan = self.planner(&ids)?;
        let frame = self.evaluated(end + 1.0, false)?;
        for id in &ids {
            let keys = plan.keys(id);
            let restore = keys.iter().any(|key| num(key, "tick").is_some_and(|tick| tick >= start && tick <= end));
            let kept: Vec<Value> = keys.into_iter().filter(|key| num(key, "tick").is_some_and(|tick| tick < start || tick > end)).collect();
            plan.set_keys(id, kept);
            Self::shift_keys(&mut plan, id, end + 1.0, -count);
            let length = plan.end(id);
            plan.set_end(id, (length - count.min(length - start).max(0.0)).max(0.0));
            if restore && start < plan.end(id) && !plan.keys(id).iter().any(|key| num(key, "tick") == Some(start)) {
                plan.write(id, start, &frame, Write::default())?;
            }
            self.retime_clips(&mut plan, id, &|tick| if tick >= start { start.max(tick - count) } else { tick })?;
        }
        plan.duration = plan.longest().max(1.0);
        let selection = self.selection_state();
        self.publish(plan, "Remove frames", selection, None)
    }

    /// `sheetSpan(id, tick)`: the exposure around `tick`, as `{start, end}`.
    fn sheet_span(&self, id: &str, tick: f64) -> (f64, f64) {
        let track = self.report.path(&["_styk", "layerSheet", "tracks", id]);
        let keys = items(track.and_then(|t| t.get("keys")));
        let at = key_at(&keys, tick);
        let start = at.and_then(|i| num(&keys[i], "tick")).unwrap_or(tick);
        let next = keys.get(at.map_or(0, |i| i + 1)).and_then(|key| num(key, "tick"));
        (start, next.unwrap_or_else(|| (tick + 1.0).max(track.and_then(|t| num(t, "end")).unwrap_or(0.0))))
    }

    pub(crate) fn sheet_set_duration(&mut self, value: f64, id: &Value, tick: &Value) -> Result<bool, EditError> {
        if value.fract() != 0.0 || !(1.0..=65535.0).contains(&value) {
            return Err(EditError::Invalid("errors.editorLayerSheet.exposureMustBe165535Frames".into()));
        }
        let id = id.as_str().map(str::to_string).unwrap_or_else(|| self.active_layer());
        let (start, end) = self.sheet_span(&id, self.tick_or_playhead(tick));
        let delta = value - (end - start);
        let ids = Value::array(vec![Value::str(&id)]);
        if delta == 0.0 {
            return Ok(false);
        }
        if delta > 0.0 { self.sheet_insert_frames(&ids, end, &Value::Num(delta)) } else { self.sheet_remove_frames(&ids, start + value, &Value::Num(end - 1.0)) }
    }

    pub(crate) fn sheet_append_frame(&mut self, options: &Value) -> Result<Value, EditError> {
        let duration = options.get("duration").map_or(1.0, |d| d.as_f64().unwrap_or(f64::NAN));
        if duration.fract() != 0.0 || !(1.0..=65535.0).contains(&duration) {
            return Err(EditError::Invalid("errors.editorLayerSheet.exposureMustBe165535Frames".into()));
        }
        let order = items(self.report.path(&["_styk", "layers", "order"]));
        let ids: Vec<String> = ["scene", "camera"].into_iter().map(str::to_string).chain(order.iter().filter_map(|id| id.as_str().map(str::to_string))).collect();
        let mut plan = self.planner(&ids)?;
        let tick = crate::timeline::total_ticks(&crate::timeline::rows(&self.report));
        let source = self.tick.min(tick - 1.0);
        let shifted = shift_clip_time(&self.evaluated(source, false)?, tick - source);
        // Clips on the document's clock play through the new frame.
        let objects: Vec<Value> = objects_of(&shifted)
            .into_iter()
            .map(|object| {
                if !object.get("_stykMovieclip").is_some_and(Value::truthy) || uses_presence(&object) {
                    return object;
                }
                let mut record = object.as_obj().cloned().unwrap_or_default();
                if let Some(mut playback) = record.get("_stykMovieclip").and_then(Value::as_obj).cloned() {
                    playback.set("end", Value::Num(tick + duration));
                    record.set("_stykMovieclip", Value::object(playback));
                }
                Value::object(record)
            })
            .collect();
        let mut frame = shifted.as_obj().cloned().unwrap_or_default();
        frame.set("objects", Value::array(objects));
        let frame = Value::object(frame);
        for id in &ids {
            plan.write(id, tick, &frame, Write::default())?;
            plan.set_end(id, tick + duration);
        }
        plan.duration = tick + duration;
        let selection = self.selection_state();
        self.publish(plan, "Add scene frame", selection, None)?;
        self.seek(tick)?;
        // Returns the evaluated frame, which the facade reads from its own copy.
        Ok(Value::Null)
    }

    /// `sheetMoveFrames(ids, start, end, delta, {copy, replace})`: the keys of each layer
    /// between `start` and `end` (a key made at `start` when there is none) move, or are
    /// copied, by `delta` frames; keys where they land are replaced.
    pub(crate) fn sheet_move_frames(&mut self, ids: &Value, start: f64, end: f64, delta: &Value, options: &Value) -> Result<bool, EditError> {
        let delta = delta.as_f64().filter(|d| d.fract() == 0.0 && d.is_finite());
        let Some(delta) = delta.filter(|d| start + d >= 0.0) else { return Err(EditError::Invalid("errors.editorLayerSheet.framesCannotMoveBeforeFrame1".into())) };
        if delta == 0.0 {
            return Ok(false);
        }
        // `{copy = false, replace = true}`
        let copy = options.get("copy").is_some_and(Value::truthy);
        let replace = options.get("replace").is_none_or(Value::truthy);
        let ids = self.list(ids);
        let mut plan = self.planner(&ids)?;
        let finish = end + delta;
        let tick_of = |key: &Value| num(key, "tick").unwrap_or(f64::NAN);
        for id in &ids {
            let mut selected: Vec<Value> = plan.keys(id).into_iter().filter(|k| tick_of(k) >= start && tick_of(k) <= end).collect();
            if selected.is_empty() {
                let frame = self.evaluated(start, false)?;
                plan.write(id, start, &frame, Write::default())?;
                selected.extend(plan.keys(id).into_iter().find(|k| tick_of(k) == start));
            }
            let chosen: Vec<Value> = selected.iter().map(|k| k.get("id").cloned().unwrap_or(Value::Null)).collect();
            let is_chosen = |key: &Value| chosen.contains(&key.get("id").cloned().unwrap_or(Value::Null));
            if !replace && plan.keys(id).iter().any(|k| (copy || !is_chosen(k)) && tick_of(k) >= start + delta && tick_of(k) <= finish) {
                return Err(EditError::Invalid("errors.editorLayerSheet.theDestinationContainsKeyframesEnableReplaceKeyframesOn".into()));
            }
            let mut materialized = Vec::with_capacity(selected.len());
            for key in &selected {
                self.materialize(&mut plan, id, key)?;
                materialized.push(plan.keys(id).into_iter().find(|k| k.get("id") == key.get("id")).unwrap_or_else(|| key.clone()));
            }
            // Only exact landing ticks replace keys; keys in between survive.
            let landing: Vec<f64> = materialized.iter().map(|k| tick_of(k) + delta).collect();
            let mut keys: Vec<Value> = plan.keys(id).into_iter().filter(|k| !landing.contains(&tick_of(k)) && (copy || !is_chosen(k))).collect();
            let drawing = self.report.path(&["_styk", "layers", "byId", id, "drawing"]).is_some_and(Value::truthy);
            for key in &materialized {
                let source = key.path(&["value", "frameId"]).and_then(Value::as_str).and_then(|frame| plan.captured(frame).cloned().or_else(|| self.frame_by_id(frame)));
                if copy && source.is_some() && drawing {
                    return Err(EditError::Unported("copying the frames of a drawing layer".into()));
                }
                let mut moved = key.as_obj().cloned().unwrap_or_default();
                moved.set("tick", Value::Num(tick_of(key) + delta));
                if copy {
                    moved.set("id", Value::str(&plan.cell()));
                }
                // A movieclip on the document's clock moves its span with the frame.
                if let Some(frame) = source.as_ref().filter(|frame| objects_of(frame).iter().any(|o| o.get("_stykMovieclip").is_some_and(Value::truthy))) {
                    moved.set("value", plan.capture(&shift_clip_time(frame, delta), id));
                }
                keys.push(Value::object(moved));
            }
            keys.sort_by(|a, b| tick_of(a).total_cmp(&tick_of(b)));
            plan.set_keys(id, keys);
            let track_end = plan.end(id).max(finish + 1.0);
            plan.set_end(id, track_end);
            plan.duration = plan.duration.max(track_end);
        }
        let selection = self.selection_state();
        self.publish(plan, if copy { "Copy frames" } else { "Move frames" }, selection, None)
    }
}

/// `validateKeyEasing(easing)`.
pub(crate) fn valid_easing(key: &Value) -> Result<(), EditError> {
    let mode = match key.get("interpolation") {
        None | Some(Value::Null) => "linear",
        Some(mode) => match mode.as_str() {
            Some("hold") => "constant",
            Some(mode) => mode,
            None => "",
        },
    };
    if !["auto", "bezier", "ease-in", "ease-out", "linear", "constant"].contains(&mode) {
        return Err(EditError::Invalid("errors.keyframeEasing.invalidKeyInterpolationChooseAutoBezierEaseIn".into()));
    }
    if let Some(bezier) = key.get("bezier") {
        let points = bezier.numbers().filter(|_| bezier.is_array()).unwrap_or_default();
        let whole = bezier.array_len() == Some(4) && points.len() == 4 && points.iter().all(|v| v.is_finite() && (0.0..=1.0).contains(v));
        if mode != "bezier" || !whole {
            return Err(EditError::Invalid("errors.keyframeEasing.bezierRequiresFourControlCoordinatesBetween0And".into()));
        }
    }
    Ok(())
}
