//! Movieclips (src/editor-movieclips.mjs): `renameMovieclip`, published as one
//! `movieclip-definition` history entry (`publishDefinition`); an instance's playback on the
//! frame on show (`setMovieclipPlayback`, `setMovieclipDrawing`), checked as
//! `validatePlayback` checks it. Recorded native playback across every frame uses
//! the shared movieclip pose/history owner; timed sheet preparation is still refused.

use styk_doc::{Obj, Value};

use crate::history::{Command, CommandKind, Direction};
use crate::{EditError, Editor};

/// White space as `String.prototype.trim` removes it.
fn js_space(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn whole(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Num(n)) if n.fract() == 0.0 && n.is_finite() => Some(*n),
        _ => None,
    }
}

fn finite(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Num(n)) if n.is_finite() => Some(*n),
        _ => None,
    }
}

/// `playbackSettings(object)`: the instance's playback over the defaults.
pub(crate) fn playback_settings(playback: Option<&Value>) -> Obj {
    let mut value = Obj::new();
    value.set("start", Value::Num(0.0));
    value.set("end", Value::Null);
    value.set("offset", Value::Num(0.0));
    value.set("speed", Value::Num(1.0));
    value.set("mode", Value::str("loop"));
    for (key, field) in playback.and_then(Value::as_obj).map(|p| p.iter().collect::<Vec<_>>()).unwrap_or_default() {
        value.set(key, field.clone());
    }
    value
}

fn invalid(key: &str) -> EditError {
    EditError::Invalid(format!("errors.movieclips.{key}"))
}

/// `validatePlayback(settings)`: the playback over the defaults, if it is one.
pub(crate) fn validate_playback(settings: Obj) -> Result<Value, EditError> {
    let value = playback_settings(Some(&Value::object(settings)));
    let clock = value.get("clock");
    if clock.is_some_and(|c| c.as_str() != Some("presence")) {
        return Err(invalid("invalidMovieclipClock"));
    }
    let restarts = value.get("restarts");
    if clock.is_some()
        && (restarts.and_then(Value::array_len).unwrap_or(0) > 0 || value.get("start").and_then(Value::as_f64) != Some(0.0) || !value.get("end").is_some_and(Value::is_null))
    {
        return Err(invalid("presenceMovieclipsUseFrameMembershipInsteadOfPlacement"));
    }
    if !value.get("mode").and_then(Value::as_str).is_some_and(|m| ["loop", "once", "hold", "single"].contains(&m)) {
        return Err(invalid("invalidMovieclipPlaybackMode"));
    }
    let start = whole(value.get("start")).filter(|s| (0.0..=10_000_000.0).contains(s));
    let end_ok = match value.get("end") {
        Some(Value::Null) => true,
        end => whole(end).is_some_and(|e| start.is_some_and(|s| e > s) && e <= 10_000_001.0),
    };
    if start.is_none() || !end_ok {
        return Err(invalid("movieclipPlacementMustHaveAValidStartAnd"));
    }
    let offset_ok = finite(value.get("offset")).is_some_and(|o| (0.0..=10_000_000.0).contains(&o));
    let speed_ok = finite(value.get("speed")).is_some_and(|s| s > 0.0 && s <= 100.0);
    if !offset_ok || !speed_ok {
        return Err(invalid("movieclipOffsetOrSpeedIsOutsideTheSupported"));
    }
    if let Some(restarts) = restarts {
        let keys: Option<Vec<Value>> = restarts.elements().filter(|_| restarts.is_array()).map(|e| e.iter().collect());
        let valid = keys.is_some_and(|keys| {
            keys.len() <= 100_000
                && keys.iter().enumerate().all(|(i, key)| {
                    let tick = whole(key.get("tick")).filter(|t| (0.0..=10_000_000.0).contains(t));
                    let offset = finite(key.get("offset")).filter(|o| (0.0..=10_000_000.0).contains(o));
                    let after = i == 0 || tick.is_some_and(|t| t > keys[i - 1].get("tick").and_then(Value::as_f64).unwrap_or(f64::NAN));
                    tick.is_some() && offset.is_some() && after
                })
        });
        if !valid {
            return Err(invalid("invalidMovieclipRestartKeys"));
        }
    }
    Ok(Value::object(value))
}

impl Editor {
    /// The selected figure's slot, record and definition, when it is a movieclip instance.
    pub(crate) fn selected_movieclip(&self) -> Result<(usize, Value, Value), EditError> {
        if let Some((slot, object)) = self.object()? {
            let figures: Vec<Value> = self.report.get("figure_types").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
            if let Some(figure) = figures.into_iter().find(|f| f.get("figure_type_id") == object.get("figure_type_id")).filter(|f| f.path(&["_styk", "movieclip"]).is_some_and(Value::truthy)) {
                return Ok((slot, object, figure));
            }
        }
        Err(EditError::Invalid("errors.editorMovieclips.selectAMovieclip".into()))
    }

    /// `setMovieclipPlayback(patch, {allFrames})` on the frame on show. Returns the playback.
    pub(crate) fn set_movieclip_playback(&mut self, patch: &Value, options: &Value) -> Result<Value, EditError> {
        self.set_movieclip_playback_with(patch, options, None)
    }

    pub(crate) fn set_movieclip_playback_with(&mut self, patch: &Value, options: &Value, mut worker: Option<&mut crate::movieclip_planning::TimelineWorker<'_>>) -> Result<Value, EditError> {
        let (slot, object, _) = self.selected_movieclip()?;
        let mut settings = playback_settings(object.get("_stykMovieclip"));
        for (key, value) in patch.as_obj().map(|p| p.iter().collect::<Vec<_>>()).unwrap_or_default() {
            settings.set(key, value.clone());
        }
        let value = validate_playback(settings)?;
        if options.get("allFrames").is_some_and(Value::truthy) {
            let presence = object.path(&["_stykMovieclip", "clock"]).and_then(Value::as_str) == Some("presence");
            if presence && self.sheet() {
                let id = crate::record::uid(&object).unwrap_or(0);
                return self.sheet_set_movieclip_playback(id, patch);
            }
            if !self.sheet() || worker.is_some() {
                let prepare = self.sheet() && self.batch.is_none();
                return self.movieclip_batch("Set movieclip playback", |editor| {
                    if prepare { worker.as_deref_mut().unwrap().prepare(editor)?; }
                    editor.edit_native_movieclip_poses("Set movieclip playback", |object| object.set("_stykMovieclip", value.clone()))?;
                    Ok(value.clone())
                });
            }
            return Err(EditError::Unported("movieclip playback across every frame of a clip on the document's clock".into()));
        }
        let playback = value.clone();
        self.object_edit("Set movieclip playback", move |editor| {
            if let Some(record) = editor.frame_object_mut(slot) {
                record.set("_stykMovieclip", playback);
            }
            Ok(())
        })?;
        Ok(value)
    }

    /// `restartMovieclip()`: the selected clip starts again at the playhead (a restart key),
    /// on every frame.
    pub(crate) fn restart_movieclip(&mut self) -> Result<Value, EditError> {
        self.restart_movieclip_with(None)
    }

    pub(crate) fn restart_movieclip_with(&mut self, worker: Option<&mut crate::movieclip_planning::TimelineWorker<'_>>) -> Result<Value, EditError> {
        let (_, object, _) = self.selected_movieclip()?;
        let tick = (self.tick + 0.5).floor();
        let mut restarts: Vec<Value> = playback_settings(object.get("_stykMovieclip")).get("restarts").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
        restarts.retain(|key| key.get("tick").and_then(Value::as_f64) != Some(tick));
        let mut key = Obj::new();
        key.set("tick", Value::Num(tick));
        key.set("offset", Value::Num(0.0));
        restarts.push(Value::object(key));
        restarts.sort_by(|a, b| a.get("tick").and_then(Value::as_f64).unwrap_or(f64::NAN).total_cmp(&b.get("tick").and_then(Value::as_f64).unwrap_or(f64::NAN)));
        self.set_restarts(restarts, worker)
    }

    /// `removeMovieclipRestart()`: the restart key at the playhead removed, on every frame.
    pub(crate) fn remove_movieclip_restart(&mut self) -> Result<Value, EditError> {
        self.remove_movieclip_restart_with(None)
    }

    pub(crate) fn remove_movieclip_restart_with(&mut self, worker: Option<&mut crate::movieclip_planning::TimelineWorker<'_>>) -> Result<Value, EditError> {
        let (_, object, _) = self.selected_movieclip()?;
        let mut restarts: Vec<Value> = playback_settings(object.get("_stykMovieclip")).get("restarts").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
        restarts.retain(|key| key.get("tick").and_then(Value::as_f64) != Some(self.tick));
        self.set_restarts(restarts, worker)
    }

    fn set_restarts(&mut self, restarts: Vec<Value>, worker: Option<&mut crate::movieclip_planning::TimelineWorker<'_>>) -> Result<Value, EditError> {
        let mut patch = Obj::new();
        patch.set("restarts", Value::array(restarts));
        let mut options = Obj::new();
        options.set("allFrames", Value::Bool(true));
        self.set_movieclip_playback_with(&Value::object(patch), &Value::object(options), worker)
    }

    /// `sheetSetMovieclipPlayback(uid, patch, {allFrames: true})`: a clip on the presence clock
    /// takes the patch on every key of its layer (each written from the frame without its
    /// replacements, which it keeps) and in every replacement holding it.
    fn sheet_set_movieclip_playback(&mut self, uid: u32, patch: &Value) -> Result<Value, EditError> {
        let id = self.layer_of(uid);
        let mut plan = self.planner(std::slice::from_ref(&id))?;
        let patched = |playback: Option<&Value>| -> Result<Value, EditError> {
            let mut settings = playback.and_then(Value::as_obj).cloned().unwrap_or_default();
            for (key, value) in patch.as_obj().map(|p| p.iter().collect::<Vec<_>>()).unwrap_or_default() {
                settings.set(key, value.clone());
            }
            validate_playback(settings)
        };
        let presence = |object: &Value| object.path(&["_stykMovieclip", "clock"]).and_then(Value::as_str) == Some("presence");
        let same = |object: &Value| crate::record::uid(object) == Some(uid);
        let ticks: Vec<f64> = plan.keys(&id).iter().filter(|k| !k.get("patchOnly").is_some_and(Value::truthy)).filter_map(|k| crate::sheet::num(k, "tick")).collect();
        let mut result = Value::Null;
        for tick in ticks {
            let frame = self.evaluated_without_patches(tick)?;
            let mut changed = false;
            let mut record = frame.as_obj().cloned().unwrap_or_default();
            let mut objects = crate::frame::objects_of(&frame);
            for object in objects.iter_mut().filter(|o| same(o) && presence(o)) {
                let settings = patched(object.get("_stykMovieclip"))?;
                changed |= styk_doc::json::to_string(&settings) != object.get("_stykMovieclip").map(styk_doc::json::to_string).unwrap_or_default();
                result = settings.clone();
                if let Some(object) = object.make_obj() {
                    object.set("_stykMovieclip", settings);
                }
            }
            record.set("objects", Value::array(objects));
            let steps = crate::sheet::continuations(&frame);
            if steps.iter().any(|step| crate::sheet::num(step, "uid") == Some(uid as f64)) {
                let mut rewritten = Vec::with_capacity(steps.len());
                for step in steps {
                    if crate::sheet::num(&step, "uid") != Some(uid as f64) {
                        rewritten.push(step);
                        continue;
                    }
                    let mut step = step.as_obj().cloned().unwrap_or_default();
                    step.set("playback", patched(step.get("playback"))?);
                    rewritten.push(Value::object(step));
                    changed = true;
                }
                let mut styk = record.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
                styk.set("movieclipContinuations", Value::array(rewritten));
                record.set("_styk", Value::object(styk));
            }
            if changed {
                let keys = plan.keys(&id);
                let key = crate::sheet::key_at(&keys, tick).map(|i| keys[i].clone());
                plan.write(&id, tick, &Value::object(record), crate::sheet::Write { easing: key.as_ref(), ..crate::sheet::Write::default() })?;
                if let Some(patches) = key.as_ref().and_then(|k| k.get("movieclipPatches")).cloned() {
                    let mut keys = plan.keys(&id);
                    if let Some(written) = keys.iter_mut().find(|k| crate::sheet::num(k, "tick") == Some(tick)).and_then(Value::make_obj) {
                        written.set("movieclipPatches", patches);
                        match key.as_ref().and_then(|k| k.get("empty")) {
                            Some(empty) => written.set("empty", empty.clone()),
                            None => {
                                written.remove("empty");
                            }
                        }
                    }
                    plan.set_keys(&id, keys);
                }
            }
        }
        // Replacements holding the clip take the patch too.
        let mut keys = plan.keys(&id);
        let mut rewritten = false;
        for key in keys.iter_mut() {
            let patches = crate::sheet::items(key.get("movieclipPatches"));
            if key.get("movieclipPatches").is_none_or(|p| !p.truthy()) {
                continue;
            }
            let mut replaced = Vec::with_capacity(patches.len());
            for replacement in patches {
                let source = replacement.get("frameId").and_then(Value::as_str).and_then(|frame| self.frame_by_id(frame)).unwrap_or(Value::Null);
                let holds = crate::sheet::continuations(&source).iter().any(|step| crate::sheet::num(step, "uid") == Some(uid as f64)) || crate::frame::objects_of(&source).iter().any(|o| same(o) && presence(o));
                if !holds {
                    replaced.push(replacement);
                    continue;
                }
                let mut frame = source.as_obj().cloned().unwrap_or_default();
                let mut objects = crate::frame::objects_of(&source);
                for object in objects.iter_mut().filter(|o| same(o) && presence(o)) {
                    let settings = patched(object.get("_stykMovieclip"))?;
                    result = settings.clone();
                    if let Some(object) = object.make_obj() {
                        object.set("_stykMovieclip", settings);
                    }
                }
                frame.set("objects", Value::array(objects));
                let steps = crate::sheet::continuations(&source);
                if !steps.is_empty() {
                    let mut out = Vec::with_capacity(steps.len());
                    for step in steps {
                        if crate::sheet::num(&step, "uid") != Some(uid as f64) {
                            out.push(step);
                            continue;
                        }
                        let mut step = step.as_obj().cloned().unwrap_or_default();
                        step.set("playback", patched(step.get("playback"))?);
                        out.push(Value::object(step));
                    }
                    let mut styk = frame.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
                    styk.set("movieclipContinuations", Value::array(out));
                    frame.set("_styk", Value::object(styk));
                }
                let mut replacement = replacement.as_obj().cloned().unwrap_or_default();
                replacement.set("frameId", plan.capture(&Value::object(frame), &id).get("frameId").cloned().unwrap_or(Value::Null));
                replaced.push(Value::object(replacement));
            }
            if let Some(key) = key.make_obj() {
                key.set("movieclipPatches", Value::array(replaced));
            }
            rewritten = true;
        }
        if rewritten {
            plan.set_keys(&id, keys);
        }
        if plan.has_sources() {
            let selection = self.selection_state();
            self.publish(plan, "Set movieclip playback", selection, None)?;
        }
        Ok(result)
    }

    /// `setMovieclipDrawing(uid, group, view)`: a drawing set's view shown by the instance
    /// (the selected figure or one joined to it), held on its frame.
    pub(crate) fn set_movieclip_drawing(&mut self, uid: &Value, group: &Value, view: &Value) -> Result<bool, EditError> {
        let frame = self.selection_frame()?;
        let object = frame.iter().find(|o| o.get("unique_id").is_some_and(|u| crate::history::js_strict_eq(u, uid))).cloned();
        let figures: Vec<Value> = self.report.get("figure_types").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
        let figure = object.as_ref().and_then(|o| figures.iter().find(|f| f.get("figure_type_id") == o.get("figure_type_id")));
        let index = |v: &Value| v.as_f64().filter(|n| n.fract() == 0.0 && *n >= 0.0).map(|n| n as usize);
        let drawing = figure.and_then(|f| f.path(&["_styk", "movieclip", "drawingSets"])).and_then(|sets| index(group).and_then(|g| sets.item(g))).and_then(|set| set.get("views").and_then(|views| index(view).and_then(|v| views.item(v))));
        let (Some(object), Some(drawing), true, true) = (object, drawing.filter(|d| d.truthy()), whole(Some(group)).is_some(), whole(Some(view)).is_some()) else {
            return Err(EditError::Invalid("errors.editorMovieclips.chooseAnExistingDrawing".into()));
        };
        let id = crate::record::uid(&object).unwrap_or(0);
        let parent = object.path(&["join", "target_unique_id"]).and_then(Value::as_f64).map(|p| p as u32);
        if Some(id) != self.selection.uid && parent.is_none_or(|p| Some(p) != self.selection.uid) {
            return Err(EditError::Invalid("errors.editorMovieclips.selectTheDrawingOrItsParentRig".into()));
        }
        let layer = self.layer_of(id);
        if self.report.path(&["_styk", "layers", "byId", &layer, "locked"]).is_some_and(|l| l.as_bool() == Some(true)) {
            return Err(EditError::Invalid("errors.editorMovieclips.unlockTheDrawingLayerBeforeChangingIt".into()));
        }
        let mut settings = playback_settings(object.get("_stykMovieclip"));
        settings.set("mode", Value::str("single"));
        settings.set("offset", drawing.get("frame").cloned().unwrap_or(Value::Null));
        let value = validate_playback(settings)?;
        self.object_edit("Change drawing", move |editor| {
            let slot = editor.frame_objects().iter().position(|o| crate::record::uid(o) == Some(id));
            if let Some(record) = slot.and_then(|slot| editor.frame_object_mut(slot)) {
                record.set("_stykMovieclip", value);
            }
            Ok(())
        })
    }

    /// `publishDefinition(editor, figure, index, label)` replacing the definition at `index`.
    pub(crate) fn publish_definition(&mut self, index: usize, figure: Value, label: &str) -> Result<(), EditError> {
        let figures = self.report.make_obj().and_then(|r| r.get_mut("figure_types")).and_then(Value::make_arr).ok_or_else(|| EditError::Unported("figure definitions that are not a list".into()))?;
        let before = figures.get(index).cloned();
        match figures.get_mut(index) {
            Some(slot) => *slot = figure.clone(),
            None => figures.push(figure.clone()),
        }
        let selection = self.selection_state();
        self.record(Command { kind: CommandKind::MovieclipDefinition { index, before, after: Some(figure) }, label: label.into(), before_selection: selection.clone(), after_selection: selection, before_revision: 0, after_revision: 0, layer_changes: Vec::new(), captured_source_bytes: 0, layers: false })?;
        self.emit("edit", vec![("structural", Value::Bool(true)), ("timing", Value::Bool(true)), ("definition", Value::Bool(true)), ("label", Value::str(label))]);
        Ok(())
    }

    /// `applyMovieclipCommand` for a `movieclip-definition` entry.
    pub(crate) fn apply_movieclip_definition(&mut self, command: &Command, direction: Direction) -> Result<(), EditError> {
        let CommandKind::MovieclipDefinition { index, before, after } = &command.kind else { return Ok(()) };
        let (value, other) = if direction == Direction::Before { (before, after) } else { (after, before) };
        if let Some(figures) = self.report.make_obj().and_then(|r| r.get_mut("figure_types")).and_then(Value::make_arr) {
            let at = (*index).min(figures.len());
            let removed = if other.is_some() { 1.min(figures.len() - at) } else { 0 };
            figures.splice(at..at + removed, value.iter().cloned());
        }
        let (selection, revision) = match direction {
            Direction::Before => (&command.before_selection, command.before_revision),
            Direction::After => (&command.after_selection, command.after_revision),
        };
        self.revision = revision;
        self.restore_selection(selection)?;
        self.emit("history", vec![("structural", Value::Bool(true)), ("timing", Value::Bool(true)), ("definition", Value::Bool(true)), ("label", Value::str(&command.label))]);
        Ok(())
    }

    /// `renameMovieclip(name)`: the selected movieclip's definition renamed.
    pub(crate) fn rename_movieclip(&mut self, name: &Value) -> Result<Value, EditError> {
        let definition = match self.object()? {
            Some((_, object)) => {
                let figures: Vec<Value> = self.report.get("figure_types").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
                figures.iter().position(|f| f.get("figure_type_id") == object.get("figure_type_id")).map(|i| (i, figures[i].clone()))
            }
            None => None,
        };
        let Some((index, figure)) = definition.filter(|(_, f)| f.path(&["_styk", "movieclip"]).is_some_and(Value::truthy)) else {
            return Err(EditError::Invalid("errors.editorMovieclips.selectAMovieclip".into()));
        };
        // `String(name).trim()`
        let text = match name {
            Value::Str(_) | Value::Blob(_) => name.text().unwrap_or_default().into_owned(),
            Value::Num(_) | Value::Bool(_) | Value::Null => styk_doc::json::to_string(name),
            _ => return Err(EditError::Unported("a movieclip name that is not text".into())),
        };
        let trimmed: &str = text.trim_matches(js_space);
        if trimmed.is_empty() || trimmed.encode_utf16().count() > 120 {
            return Err(EditError::Invalid("errors.editorMovieclips.useANameFrom1To120Characters".into()));
        }
        if figure.get("name").and_then(Value::as_str) == Some(trimmed) {
            return Ok(Value::Null);
        }
        let mut renamed = figure.as_obj().cloned().unwrap_or_default();
        renamed.set("name", Value::str(trimmed));
        let renamed = Value::object(renamed);
        self.publish_definition(index, renamed.clone(), "Rename movieclip")?;
        Ok(renamed)
    }
}
