//! `bakeCameraMotion`: the camera the motion clips make is keyed on every frame of the range, and the clips are muted
//! over it, as one history entry. The frames are sampled in the session's own call (the editor had a worker for it).

use styk_doc::{Obj, Value};

use crate::sheet::{constant, items, key_at, num, Write};
use crate::{EditError, Editor};

/// The most frames a bake may sample.
const MOST: f64 = 100_000.0;

fn invalid(key: &str) -> EditError {
    EditError::Invalid(key.into())
}

/// A camera as the bake keeps it: where it is and the offset parallax layers do not follow.
struct Baked {
    tick: f64,
    restore: bool,
    camera: Value,
}

/// `easingMode(key)`: a hold is a constant, no interpolation a linear one.
fn easing_mode(key: &Value) -> String {
    match key.get("interpolation").and_then(Value::as_str) {
        Some("hold") => "constant".into(),
        Some(mode) => mode.into(),
        None => "linear".into(),
    }
}

/// `muteRange(clip, start, end)`: the clip silenced over `start..end`; one that is silent throughout is disabled.
fn mute_range(clip: &Value, start: f64, end: f64) -> Value {
    let (first, length) = (num(clip, "start").unwrap_or(f64::NAN), num(clip, "duration").unwrap_or(f64::NAN));
    if !clip.get("enabled").is_some_and(Value::truthy) || end <= first || start >= first + length {
        return clip.clone();
    }
    let mut all: Vec<(f64, f64)> = items(clip.get("mutedRanges")).iter().map(|r| (num(r, "start").unwrap_or(f64::NAN), num(r, "end").unwrap_or(f64::NAN))).collect();
    all.push((start.max(first), end.min(first + length)));
    all.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut ranges: Vec<(f64, f64)> = Vec::new();
    for range in all {
        match ranges.last_mut() {
            Some(last) if range.0 <= last.1 => last.1 = last.1.max(range.1),
            _ => ranges.push(range),
        }
    }
    let silent = ranges.len() == 1 && ranges[0].0 <= first && ranges[0].1 >= first + length;
    let mut out = clip.as_obj().cloned().unwrap_or_default();
    out.set("enabled", Value::Bool(!silent));
    out.set(
        "mutedRanges",
        Value::array(
            ranges
                .into_iter()
                .map(|(start, end)| {
                    let mut range = Obj::new();
                    range.set("start", Value::Num(start));
                    range.set("end", Value::Num(end));
                    Value::object(range)
                })
                .collect(),
        ),
    );
    Value::object(out)
}

impl Editor {
    /// `cameraBakeRange(report, start, end)`: the span to sample, widened to the adjoining runs of automatic
    /// easing so that no key between them changes its slope.
    fn camera_bake_range(&self, start: f64, end: f64) -> Result<(f64, f64), EditError> {
        let keys = items(self.report.path(&["_styk", "layerSheet", "tracks", "camera", "keys"]));
        if keys.is_empty() {
            return Ok((start, end));
        }
        let left = key_at(&keys, start).unwrap_or(0);
        let right = key_at(&keys, end - 1.0).map_or(0, |index| index + 1).max(left).min(keys.len() - 1);
        let (mut first, mut last) = (left, right);
        while first > 0 && easing_mode(&keys[first - 1]) == "auto" {
            first -= 1;
        }
        while last < keys.len() - 1 && easing_mode(&keys[last]) == "auto" {
            last += 1;
        }
        let sample_start = start.min(num(&keys[first], "tick").unwrap_or(f64::NAN));
        let sample_end = end.max(num(&keys[last], "tick").unwrap_or(f64::NAN));
        if sample_end - sample_start > MOST {
            return Err(invalid("errors.cameraMotionBake.splitTheCameraEasingSpanBeforeBakingAt"));
        }
        Ok((sample_start, sample_end))
    }

    /// `sampleMotionBake(report, {start, end})`: the camera at each frame of the span, motion included inside
    /// `start..end`, and the parallax offset the motion adds to it.
    fn sample_camera_bake(&self, start: f64, end: f64) -> Result<Vec<Baked>, EditError> {
        let rows = crate::timeline::rows(&self.report);
        let (sample_start, sample_end) = self.camera_bake_range(start, end)?;
        let length = self.report.path(&["_styk", "layerSheet", "duration"]).and_then(Value::as_f64).unwrap_or_else(|| crate::timeline::total_ticks(&rows));
        let restore = sample_end < length;
        let neutral = || {
            let mut camera = Obj::new();
            for (key, value) in [("x", 0.0), ("y", 0.0), ("scale", 1.0), ("angle_rad", 0.0)] {
                camera.set(key, Value::Num(value));
            }
            Value::object(camera)
        };
        let number = |camera: &Value, key: &str| camera.get(key).filter(|v| !v.is_null()).map_or(f64::NAN, |v| v.as_f64().unwrap_or(f64::NAN));
        let mut frames = Vec::new();
        let mut tick = sample_start;
        while tick < sample_end + f64::from(u8::from(restore)) {
            let frame = self.evaluated(tick, false)?;
            let shown = frame.get("camera").filter(|c| !c.is_null()).cloned();
            let base = match shown {
                Some(camera) if camera.get("is_default").is_some_and(Value::truthy) => neutral(),
                Some(camera) => camera,
                None => neutral(),
            };
            let inside = tick >= start && tick < end;
            let moved = if inside { self.camera_travel_at(&frame, tick)? } else { None };
            let travel = match moved.filter(|camera| !camera.get("is_default").is_some_and(Value::truthy)) {
                Some(camera) => camera,
                None => base.clone(),
            };
            let camera = if inside { self.camera_at_time(&frame, tick)?.unwrap_or_else(|| base.clone()) } else { base.clone() };
            // The baked screen impulse stays apart from the depth-driving camera travel, which includes a follow.
            let previous = base.get("_parallaxMotionOffset").filter(|v| v.truthy());
            let before = |key: &str| previous.map_or(0.0, |offset| number(offset, key));
            let mut offset = Obj::new();
            offset.set("x", Value::Num(number(&camera, "x") - number(&travel, "x") + before("x")));
            offset.set("y", Value::Num(number(&camera, "y") - number(&travel, "y") + before("y")));
            let mut baked = camera.as_obj().cloned().unwrap_or_default();
            baked.set("is_default", Value::Bool(false));
            baked.set("_parallaxMotionOffset", Value::object(offset));
            frames.push(Baked { tick, restore: tick == sample_end, camera: Value::object(baked) });
            tick += 1.0;
        }
        Ok(frames)
    }

    /// `_sheetBakeCameraFrames(frames)`: each frame keyed on the camera track, held; the key at the span's end
    /// that restores the camera after it keeps the easing the track had there.
    fn bake_camera_frames(&mut self, frames: &[Baked]) -> Result<(), EditError> {
        let mut plan = self.planner(&["camera".to_string()])?;
        for baked in frames {
            let before = items(plan.before.path(&["tracks", "camera", "keys"]));
            let held = constant();
            let easing = if baked.restore { key_at(&before, baked.tick).map(|index| before[index].clone()).unwrap_or_else(constant) } else { held };
            let mut frame = Obj::new();
            frame.set("objects", Value::array(Vec::new()));
            frame.set("camera", baked.camera.clone());
            frame.set("duration_raw", Value::Num(1.0));
            plan.write("camera", baked.tick, &Value::object(frame), Write { easing: Some(&easing), ..Write::default() })?;
            if easing.get("interpolation").and_then(Value::as_str) != Some("bezier") {
                let mut keys = plan.keys("camera");
                if let Some(index) = key_at(&keys, baked.tick)
                    && let Some(key) = keys[index].make_obj()
                {
                    key.remove("bezier");
                    plan.set_keys("camera", keys);
                }
            }
        }
        let selection = self.selection_state();
        self.publish_geometry(plan, "Bake camera motion", selection, None, true)?;
        Ok(())
    }

    /// `bakeCameraMotion({start, end})`: the camera motion clips become keys of the camera track over the range
    /// (the whole animation by default, at most 100000 frames), and the clips are silenced there.
    pub(crate) fn bake_camera_motion(&mut self, options: &Value) -> Result<bool, EditError> {
        if self.track_locked("camera") {
            return Err(invalid("errors.editorCameraMotion.unlockCameraBeforeEditingMotion"));
        }
        if !self.sheet() {
            return Err(EditError::Unported("bakeCameraMotion on a native timeline".into()));
        }
        if !self.camera_clips().iter().any(|clip| clip.get("enabled").is_some_and(Value::truthy)) {
            return Ok(false);
        }
        let total = crate::timeline::total_ticks(&crate::timeline::rows(&self.report));
        let given = |key: &str, default: f64| match options.get(key) {
            None => Some(default),
            Some(value) => value.as_f64().filter(|n| n.fract() == 0.0),
        };
        let (start, end) = (given("start", 0.0), given("end", total));
        let Some((start, end)) = start.zip(end).filter(|(start, end)| *start >= 0.0 && *end > *start && *end <= total && *end - *start <= MOST) else {
            return Err(invalid("errors.editorCameraMotion.bakeAValidRangeOfAtMost100"));
        };
        // The bake plans against the document as it is: an edit still open would be baked around.
        if self.drag.is_some() || self.property_edit.is_some() {
            return Err(invalid("errors.editorCameraMotion.theAnimationChangedWhileBakingTryAgain"));
        }
        let frames = self.sample_camera_bake(start, end)?;
        self.movieclip_batch("Bake camera motion", |editor| {
            editor.bake_camera_frames(&frames)?;
            let clips: Vec<Value> = editor.camera_clips().iter().map(|clip| mute_range(clip, start, end)).collect();
            editor.publish_camera(clips, "Disable baked camera motion")?;
            Ok(true)
        })
    }
}
