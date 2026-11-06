//! Camera motion clips as the timeline edits them: a clip's
//! timing, switch, parameters and followed figures, and deleting one, each validated as
//! `validateCameraMotion` does and recorded as one `camera-motion` history entry. Adding,
//! duplicating, pasting and randomizing give clips random identities and seeds, which a
//! record-for-record port cannot reproduce: they stay in the editor.

use styk_doc::{Obj, Value};

use crate::history::{Command, CommandKind, Direction};
use crate::{EditError, Editor};

/// `CAMERA_MOTION_TYPES`.
const TYPES: [&str; 6] = ["follow", "shake", "handheld", "wobble", "impact", "pulse"];
/// `CAMERA_MOTION_LIMIT`, `FOLLOW_TARGET_LIMIT`, `FOLLOW_FRAME_LIMIT`.
const CLIP_LIMIT: usize = 256;
const TARGET_LIMIT: usize = 16;
const FOLLOW_FRAMES: f64 = 100000.0;
/// `Object.keys(defaults)` and `Object.keys(FOLLOW_DEFAULTS)`: the parameters of each kind.
const PRESET_KEYS: [&str; 13] = ["strength", "moveX", "moveY", "roll", "zoom", "frequency", "roughness", "direction", "recovery", "phase", "fadeIn", "fadeOut", "seed"];
const FOLLOW_KEYS: [&str; 13] = ["strength", "followX", "followY", "offsetX", "offsetY", "lag", "deadZone", "lookAhead", "zoomFit", "padding", "maxZoom", "fadeIn", "fadeOut"];
/// A new clip's parameters (`defaults` and `FOLLOW_DEFAULTS` of the recorded editor).
const MOTION_DEFAULTS: &[(&str, f64)] = &[("strength", 1.0), ("moveX", 12.0), ("moveY", 12.0), ("roll", 1.0), ("zoom", 0.0), ("frequency", 8.0), ("roughness", 0.5), ("direction", 0.0), ("recovery", 5.0), ("phase", 0.0), ("fadeIn", 2.0), ("fadeOut", 4.0), ("seed", 1.0)];
const FOLLOW_DEFAULTS: &[(&str, f64)] = &[("strength", 1.0), ("followX", 1.0), ("followY", 1.0), ("offsetX", 0.0), ("offsetY", 0.0), ("lag", 8.0), ("deadZone", 0.0), ("lookAhead", 0.0), ("zoomFit", 0.0), ("padding", 0.2), ("maxZoom", 3.0), ("fadeIn", 6.0), ("fadeOut", 6.0)];

/// `MOTION_PARAMETERS[key]`'s range.
/// `MOTION_PARAMETERS[key][0]`: the English name of a parameter.
fn parameter_label(key: &str) -> &str {
    match key {
        "strength" => "Strength", "moveX" => "Move X", "moveY" => "Move Y", "roll" => "Roll", "zoom" => "Zoom", "frequency" => "Speed",
        "roughness" => "Roughness", "direction" => "Direction", "recovery" => "Recovery", "phase" => "Phase", "fadeIn" => "Fade in",
        "fadeOut" => "Fade out", "seed" => "Seed", "followX" => "Horizontal", "followY" => "Vertical", "offsetX" => "Frame X",
        "offsetY" => "Frame Y", "lag" => "Smoothness", "deadZone" => "Dead zone", "lookAhead" => "Look ahead", "zoomFit" => "Auto zoom",
        "padding" => "Margin", "maxZoom" => "Zoom limit",
        other => other,
    }
}

fn range(key: &str) -> (f64, f64) {
    match key {
        "strength" => (0.0, 2.0),
        "moveX" | "moveY" => (0.0, 2000.0),
        "roll" => (0.0, 90.0),
        "zoom" => (-0.8, 4.0),
        "frequency" => (0.05, 60.0),
        "roughness" | "followX" | "followY" | "zoomFit" => (0.0, 1.0),
        "direction" => (-180.0, 180.0),
        "recovery" => (0.1, 20.0),
        "phase" => (-360.0, 360.0),
        "fadeIn" | "fadeOut" => (0.0, 100000.0),
        "seed" => (0.0, 2147483647.0),
        "offsetX" | "offsetY" => (-4000.0, 4000.0),
        "lag" => (0.0, 240.0),
        "deadZone" => (0.0, 0.9),
        "lookAhead" => (0.0, 120.0),
        "padding" => (0.0, 0.45),
        "maxZoom" => (1.0, 20.0),
        _ => (f64::NAN, f64::NAN),
    }
}

fn integer(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|n| n.fract() == 0.0 && n.is_finite())
}

/// `/^[\w-]{1,80}$/`
fn identity(id: &str) -> bool {
    (1..=80).contains(&id.chars().count()) && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn invalid(key: &str) -> EditError {
    EditError::Invalid(key.into())
}

/// `validateFollowTargets(targets)`.
fn validate_targets(targets: Option<&Value>) -> Result<(), EditError> {
    let list: Vec<Value> = targets.and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
    if targets.and_then(Value::elements).is_none() || list.is_empty() || list.len() > TARGET_LIMIT {
        return Err(invalid("errors.cameraFollow.follow1Figures"));
    }
    let mut seen: Vec<f64> = Vec::new();
    for target in &list {
        let uid = integer(target.get("uid")).filter(|u| *u >= 0.0);
        let weight = target.get("weight").and_then(Value::as_f64).filter(|w| (0.0..=1.0).contains(w));
        match (uid, weight) {
            (Some(uid), Some(_)) if !seen.contains(&uid) => seen.push(uid),
            _ => return Err(invalid("errors.cameraFollow.eachFollowedFigureNeedsAUniqueFigureAnd")),
        }
    }
    Ok(())
}

/// `validateCameraMotion(state)`.
pub(crate) fn validate(state: &Value) -> Result<(), EditError> {
    let clips: Vec<Value> = state.get("clips").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
    if state.get("version").and_then(Value::as_f64) != Some(1.0) || state.get("clips").and_then(Value::elements).is_none() || clips.len() > CLIP_LIMIT {
        return Err(invalid("errors.cameraMotion.invalidCameraMotionTableMaximum256Clips"));
    }
    let mut ids: Vec<String> = Vec::new();
    for clip in &clips {
        let id = clip.get("id").and_then(Value::as_str).map(str::to_string);
        let kind = clip.get("type").and_then(Value::as_str).unwrap_or("");
        let start = integer(clip.get("start")).filter(|s| *s >= 0.0);
        let duration = integer(clip.get("duration")).filter(|d| *d >= 1.0);
        let valid = id.as_ref().is_some_and(|id| identity(id) && !ids.contains(id))
            && TYPES.contains(&kind)
            && matches!(clip.get("enabled"), Some(Value::Bool(_)))
            && matches!((start, duration), (Some(s), Some(d)) if s + d <= 10_000_000.0);
        if !valid {
            return Err(invalid("errors.cameraMotion.invalidCameraMotionClip"));
        }
        ids.push(id.unwrap());
        if let Some(ranges) = clip.get("mutedRanges") {
            let list: Option<Vec<Value>> = ranges.elements().map(|e| e.iter().collect());
            let ok = list.is_some_and(|list| list.len() <= 1024 && list.iter().all(|r| matches!((integer(r.get("start")), integer(r.get("end"))), (Some(s), Some(e)) if s >= 0.0 && e > s)));
            if !ok {
                return Err(invalid("errors.cameraMotion.invalidBakedCameraRange"));
            }
        }
        let keys: &[&str] = if kind == "follow" { &FOLLOW_KEYS } else { &PRESET_KEYS };
        if kind == "follow" {
            validate_targets(clip.get("targets"))?;
            if duration.unwrap() > FOLLOW_FRAMES {
                return Err(crate::invalid_with("errors.cameraMotion.aFollowClipCanLastUpToFrames", vec![("value", Value::str("100,000"))]));
            }
        } else if clip.get("targets").is_some() {
            return Err(invalid("errors.cameraMotion.onlyFollowClipsHaveFollowedFigures"));
        }
        let params = clip.get("params").filter(|p| p.truthy());
        if params.is_none_or(|p| p.as_obj().is_some_and(|o| o.keys().any(|k| !keys.contains(&&**k)))) {
            return Err(invalid("errors.cameraMotion.invalidCameraMotionParameters"));
        }
        let params = params.unwrap();
        for key in keys {
            let (min, max) = range(key);
            let value = params.get(key).and_then(Value::as_f64);
            let whole = ["seed", "fadeIn", "fadeOut", "lookAhead"].contains(key);
            if !value.is_some_and(|v| v.is_finite() && v >= min && v <= max && (!whole || v.fract() == 0.0)) {
                let mut parameter = Obj::new();
                parameter.set("key", Value::str(key));
                parameter.set("label", Value::str(parameter_label(key)));
                let mut reference = Obj::new();
                reference.set("@motionParameter", Value::object(parameter));
                return Err(crate::invalid_with("errors.cameraMotion.mustBeBetweenAnd", vec![("label", Value::object(reference)), ("min", Value::Num(min)), ("max", Value::Num(max))]));
            }
        }
    }
    Ok(())
}

/// `shiftedRanges(clip, start, duration)`: a clip's muted ranges moved with it.
fn shifted_ranges(clip: &Value, start: f64, duration: f64) -> Option<Value> {
    let ranges = clip.get("mutedRanges").filter(|r| r.truthy())?;
    let from = clip.get("start").and_then(Value::as_f64).unwrap_or(f64::NAN);
    let list: Vec<Value> = ranges
        .elements()
        .map(|e| e.iter().collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .map(|r| {
            let (s, e) = (r.get("start").and_then(Value::as_f64).unwrap_or(f64::NAN), r.get("end").and_then(Value::as_f64).unwrap_or(f64::NAN));
            let mut range = Obj::new();
            range.set("start", Value::Num(s + start - from));
            range.set("end", Value::Num((start + duration).min(e + start - from)));
            (range, (start + duration).min(e + start - from) > s + start - from)
        })
        .filter(|(_, keep)| *keep)
        .map(|(range, _)| Value::object(range))
        .collect();
    Some(Value::array(list))
}

impl Editor {
    pub(crate) fn camera_clips(&self) -> Vec<Value> {
        self.report.path(&["_styk", "cameraMotion", "clips"]).and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default()
    }

    /// `publish(editor, next, label)`: the new table, one history entry, the sheet lengthened
    /// to the last clip.
    pub(crate) fn publish_camera(&mut self, clips: Vec<Value>, label: &str) -> Result<bool, EditError> {
        if self.track_locked("camera") {
            return Err(invalid("errors.editorCameraMotion.unlockCameraBeforeEditingMotion"));
        }
        let mut table = Obj::new();
        table.set("version", Value::Num(1.0));
        table.set("clips", Value::array(clips.clone()));
        let next = Value::object(table);
        validate(&next)?;
        if self.drag.is_some() {
            self.commit_drag()?;
        }
        let before = self.report.path(&["_styk", "cameraMotion"]).cloned();
        if before.as_ref().map_or("null".to_string(), styk_doc::json::to_string) == styk_doc::json::to_string(&next) {
            return Ok(false);
        }
        let before_selection = self.selection_state();
        let end = clips.iter().map(|c| c.get("start").and_then(Value::as_f64).unwrap_or(f64::NAN) + c.get("duration").and_then(Value::as_f64).unwrap_or(f64::NAN)).fold(1.0f64, |a, b| if b.is_nan() || a.is_nan() { f64::NAN } else { a.max(b) });
        let sheet = self.report.path(&["_styk", "layerSheet"]).cloned().filter(|s| s.truthy());
        let duration = sheet.as_ref().and_then(|s| s.get("duration")).and_then(Value::as_f64).unwrap_or(f64::NAN);
        let patch = sheet.filter(|_| end > duration).map(|before| {
            let mut tracks = before.get("tracks").and_then(Value::as_obj).cloned().unwrap_or_default();
            for id in tracks.keys().map(|k| k.to_string()).collect::<Vec<_>>() {
                if tracks.get(&id).and_then(|t| t.get("end")).and_then(Value::as_f64) == Some(duration) {
                    let mut track = tracks.get(&id).and_then(Value::as_obj).cloned().unwrap_or_default();
                    track.set("end", Value::Num(end));
                    tracks.set(&id, Value::object(track));
                }
            }
            let mut after = before.as_obj().cloned().unwrap_or_default();
            after.set("duration", Value::Num(end));
            after.set("tracks", Value::object(tracks));
            (before, Value::object(after))
        });
        if let Some(styk) = self.report.make_obj().and_then(|r| r.get_mut("_styk")).and_then(Value::make_obj) {
            styk.set("cameraMotion", next.clone());
            if let Some((_, after)) = &patch {
                styk.set("layerSheet", after.clone());
            }
        }
        let after_selection = self.selection_state();
        self.record(Command { kind: CommandKind::CameraMotion { before, after: next, sheet: patch }, label: label.into(), before_selection, after_selection, before_revision: 0, after_revision: 0, layer_changes: Vec::new(), captured_source_bytes: 0, layers: false })?;
        // `{label, camera: true, cameraMotion: true, frameIndices: [], timing: true}`
        let mut event = Obj::new();
        event.set("kind", Value::str("edit"));
        event.set("frameIndex", Value::Num(self.frame_index as f64));
        event.set("tick", Value::Num(self.tick));
        event.set("structural", Value::Bool(false));
        event.set("timing", Value::Bool(true));
        event.set("label", Value::str(label));
        event.set("camera", Value::Bool(true));
        event.set("cameraMotion", Value::Bool(true));
        event.set("frameIndices", Value::array(Vec::new()));
        self.events.push(Value::object(event));
        Ok(true)
    }

    /// `_applyCommand` for a `camera-motion` entry.
    pub(crate) fn apply_camera_command(&mut self, command: &Command, direction: Direction) -> Result<(), EditError> {
        let CommandKind::CameraMotion { before, after, sheet } = &command.kind else { return Ok(()) };
        if let Some(styk) = self.report.make_obj().and_then(|r| r.get_mut("_styk")).and_then(Value::make_obj) {
            match (direction, before) {
                (Direction::Before, None) => {
                    styk.remove("cameraMotion");
                }
                (Direction::Before, Some(before)) => styk.set("cameraMotion", before.clone()),
                (Direction::After, _) => styk.set("cameraMotion", after.clone()),
            }
            if let Some((old, new)) = sheet {
                styk.set("layerSheet", if direction == Direction::Before { old.clone() } else { new.clone() });
            }
        }
        let (selection, revision) = match direction {
            Direction::Before => (&command.before_selection, command.before_revision),
            Direction::After => (&command.after_selection, command.after_revision),
        };
        self.restore_selection(selection)?;
        self.revision = revision;
        // The history event has no `structural` (the entry does not say), as the editor's.
        let mut event = Obj::new();
        event.set("kind", Value::str("history"));
        event.set("frameIndex", Value::Num(self.frame_index as f64));
        event.set("tick", Value::Num(self.tick));
        event.set("timing", Value::Bool(true));
        event.set("label", Value::str(&command.label));
        event.set("definition", Value::Bool(false));
        event.set("animation", Value::Bool(false));
        event.set("cameraMotion", Value::Bool(true));
        event.set("frameIndices", Value::array(Vec::new()));
        self.events.push(Value::object(event));
        Ok(())
    }

    /// `setCameraMotion(id, patch)`: a clip's start, duration, switch, parameters or
    /// followed figures.
    pub(crate) fn set_camera_motion(&mut self, id: &Value, patch: &Value) -> Result<bool, EditError> {
        let list = self.camera_motion_after(self.camera_clips(), id, patch)?;
        self.publish_camera(list, "Edit camera motion")
    }

    /// The clips with `patch` applied to the clip `id`, as `setCameraMotion` makes them.
    pub(crate) fn camera_motion_after(&self, clips: Vec<Value>, id: &Value, patch: &Value) -> Result<Vec<Value>, EditError> {
        let entries: Vec<(String, Value)> = patch.as_obj().map(|o| o.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()).unwrap_or_default();
        if entries.iter().any(|(k, _)| !["start", "duration", "enabled", "params", "targets"].contains(&k.as_str())) {
            return Err(invalid("errors.editorCameraMotion.unsupportedCameraMotionProperty"));
        }
        let Some(at) = clips.iter().position(|c| c.get("id") == Some(id)) else { return Err(invalid("errors.editorCameraMotion.selectACameraMotionClip")) };
        let old = clips[at].clone();
        let given = |key: &str| entries.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone()).filter(|v| !v.is_null());
        let start = given("start").and_then(|v| v.as_f64()).unwrap_or_else(|| old.get("start").and_then(Value::as_f64).unwrap_or(f64::NAN));
        let duration = given("duration").and_then(|v| v.as_f64()).unwrap_or_else(|| old.get("duration").and_then(Value::as_f64).unwrap_or(f64::NAN));
        // `{...c, ...patch, ...shiftedRanges(c, start, duration), params: {...c.params, ...patch.params}}`
        let mut next = old.as_obj().cloned().unwrap_or_default();
        for (key, value) in &entries {
            next.set(key, value.clone());
        }
        if let Some(ranges) = shifted_ranges(&old, start, duration) {
            next.set("mutedRanges", ranges);
        }
        let mut params = old.get("params").and_then(Value::as_obj).cloned().unwrap_or_default();
        if let Some(changes) = entries.iter().find(|(k, _)| k == "params").and_then(|(_, v)| v.as_obj().cloned()) {
            for (key, value) in changes.iter() {
                params.set(key, value.clone());
            }
        }
        next.set("params", Value::object(params));
        let mut list = clips;
        list[at] = Value::object(next);
        Ok(list)
    }

    /// `copyCameraMotion(id)`: a clip kept for pasting.
    pub(crate) fn copy_camera_motion(&mut self, id: &Value) -> bool {
        match self.camera_clips().into_iter().find(|c| c.get("id") == Some(id)) {
            Some(clip) => {
                self.camera_motion_clipboard = Some(clip);
                true
            }
            None => false,
        }
    }

    /// A copy of `clip` with a new identity at `start` (its muted ranges moved with it).
    fn moved_clip(&mut self, clip: &Value, start: f64) -> Result<Value, EditError> {
        let mut next = clip.as_obj().cloned().unwrap_or_default();
        next.set("id", Value::str(&format!("motion-{}", self.draw_uuid()?)));
        next.set("start", Value::Num(start));
        let duration = clip.get("duration").and_then(Value::as_f64).unwrap_or(f64::NAN);
        if let Some(ranges) = shifted_ranges(clip, start, duration) {
            next.set("mutedRanges", ranges);
        }
        Ok(Value::object(next))
    }

    /// `pasteCameraMotion(start)`: the copied clip at `start` (the playhead's frame by
    /// default) with a new identity. Returns the identity.
    pub(crate) fn paste_camera_motion(&mut self, start: Option<f64>) -> Result<Value, EditError> {
        let Some(clip) = self.camera_motion_clipboard.clone() else { return Err(invalid("errors.editorCameraMotion.copyACameraMotionClipFirst")) };
        let next = self.moved_clip(&clip, start.unwrap_or(self.tick.floor()))?;
        let id = next.get("id").cloned().unwrap_or(Value::Null);
        let mut clips = self.camera_clips();
        clips.push(next);
        self.publish_camera(clips, "Paste camera motion")?;
        Ok(id)
    }

    /// `duplicateCameraMotion(id, start)`: a copy after the clip (or at `start`).
    pub(crate) fn duplicate_camera_motion(&mut self, id: &Value, start: Option<f64>) -> Result<Value, EditError> {
        let Some(source) = self.camera_clips().into_iter().find(|c| c.get("id") == Some(id)) else { return Err(invalid("errors.editorCameraMotion.selectACameraMotionClip")) };
        let number = |key: &str| source.get(key).and_then(Value::as_f64).unwrap_or(f64::NAN);
        let next = self.moved_clip(&source, start.unwrap_or(number("start") + number("duration")))?;
        let id = next.get("id").cloned().unwrap_or(Value::Null);
        let mut clips = self.camera_clips();
        clips.push(next);
        self.publish_camera(clips, "Duplicate camera motion")?;
        Ok(id)
    }

    /// `addCameraMotion(type, {start, duration, targets})` (`createCameraMotion`): a preset
    /// clip at the playhead's frame; a follow clip follows the selected figures to the end.
    pub(crate) fn add_camera_motion(&mut self, kind: &Value, options: &Value) -> Result<Value, EditError> {
        let kind = kind.as_str().unwrap_or("").to_string();
        let given = |key: &str| options.get(key).filter(|v| !v.is_null()).cloned();
        // `{start = Math.floor(this.tick)}`: only a missing start takes the default.
        let start = options.get("start").cloned().unwrap_or(Value::Num(self.tick.floor()));
        let mut targets = given("targets");
        let mut duration = given("duration");
        if kind == "follow" {
            if targets.is_none() {
                let list: Vec<Value> = self.selection.uids.iter().map(|uid| {
                    let mut target = Obj::new();
                    target.set("uid", Value::Num(*uid as f64));
                    target.set("weight", Value::Num(1.0));
                    Value::object(target)
                }).collect();
                targets = Some(Value::array(list));
            }
            if targets.as_ref().and_then(Value::array_len).unwrap_or(0) == 0 {
                return Err(invalid("errors.editorCameraMotion.selectTheFiguresTheCameraShouldFollow"));
            }
            if duration.is_none() {
                let total = crate::timeline::total_ticks(&crate::timeline::rows(&self.report));
                duration = Some(Value::Num(FOLLOW_FRAMES.min(24f64.max(total - start.as_f64().unwrap_or(f64::NAN)))));
            }
        }
        let duration = duration.unwrap_or(Value::Num(if kind == "impact" { 12.0 } else { 24.0 }));
        let id = format!("motion-{}", self.draw_uuid()?);
        // `createCameraMotion(type, id, start, duration, {targets})`
        if !TYPES.contains(&kind.as_str()) {
            return Err(invalid("errors.cameraMotion.chooseACameraMotionPreset"));
        }
        let mut clip = Obj::new();
        clip.set("id", Value::str(&id));
        clip.set("type", Value::str(&kind));
        clip.set("start", start);
        clip.set("duration", duration);
        clip.set("enabled", Value::Bool(true));
        let mut params = Obj::new();
        if kind == "follow" {
            validate_targets(targets.as_ref())?;
            let list: Vec<Value> = targets.as_ref().and_then(Value::elements).map(|e| e.iter().map(|t| {
                let mut target = Obj::new();
                target.set("uid", t.get("uid").cloned().unwrap_or(Value::Null));
                target.set("weight", t.get("weight").cloned().unwrap_or(Value::Null));
                Value::object(target)
            }).collect()).unwrap_or_default();
            clip.set("targets", Value::array(list));
            for (key, value) in FOLLOW_DEFAULTS {
                params.set(key, Value::Num(*value));
            }
        } else {
            for (key, value) in MOTION_DEFAULTS {
                params.set(key, Value::Num(*value));
            }
            let preset: &[(&str, f64)] = match kind.as_str() {
                "handheld" => &[("moveX", 3.0), ("moveY", 2.0), ("roll", 0.3), ("frequency", 0.7)],
                "wobble" => &[("moveX", 5.0), ("moveY", 2.0), ("roll", 2.0), ("frequency", 1.5)],
                "impact" => &[("moveX", 18.0), ("moveY", 18.0), ("roll", 1.5), ("zoom", 0.04), ("fadeIn", 0.0), ("fadeOut", 0.0), ("frequency", 6.0)],
                "pulse" => &[("moveX", 0.0), ("moveY", 0.0), ("roll", 0.0), ("zoom", 0.08), ("fadeIn", 0.0), ("fadeOut", 0.0)],
                _ => &[],
            };
            for (key, value) in preset {
                params.set(key, Value::Num(*value));
            }
        }
        clip.set("params", Value::object(params));
        let mut clips = self.camera_clips();
        clips.push(Value::object(clip));
        self.publish_camera(clips, "Add camera motion")?;
        Ok(Value::str(&id))
    }

    /// `randomizeCameraMotion(id)`: a new seed (31 random bits).
    pub(crate) fn randomize_camera_motion(&mut self, id: &Value) -> Result<bool, EditError> {
        let seed = (self.draw_seed()? as u32 & 0x7fff_ffff) as f64;
        let mut params = Obj::new();
        params.set("seed", Value::Num(seed));
        let mut patch = Obj::new();
        patch.set("params", Value::object(params));
        self.set_camera_motion(id, &Value::object(patch))
    }

    /// `deleteCameraMotion(id)`.
    pub(crate) fn delete_camera_motion(&mut self, id: &Value) -> Result<bool, EditError> {
        let clips: Vec<Value> = self.camera_clips().into_iter().filter(|c| c.get("id") != Some(id)).collect();
        self.publish_camera(clips, "Delete camera motion")
    }
}
