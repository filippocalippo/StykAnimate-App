//! The camera as the interface reads it besides the frame on show (docs/engine/evaluation.md, "The interface's
//! views"): the camera the shown frame is seen through (`cameraAtTime`: follow travel, then preset impulses),
//! the authored camera of another frame, the samples of a camera-motion clip (the inspector's graph and
//! readout; the clip may be one being edited, not yet stored) and the framing that keeps followed figures
//! where they stand.
//!
//! Read-only: the document does not change.

use std::sync::Arc;

use styk_doc::Value;
use styk_eval::follow::Follow;

use crate::record::num;
use crate::{EditError, Editor};

/// What the views keep between reads.
#[derive(Default)]
pub(crate) struct Cache {
    /// The follow clip last sampled: the document it was shaped against (the prepared views' identity), the clip as
    /// text and its shaped path. A graph is drawn from many reads of one clip, and a slider drags it through many.
    follow: Option<(usize, String, Option<Arc<Follow>>)>,
}

impl Editor {
    /// One read of the camera (`kind`: `shot`, `frameCamera`, `cameraSamples` or `framing`), as JSON text.
    pub(crate) fn interface_camera(&self, kind: &str, args: &Value) -> Result<String, EditError> {
        let value = match kind {
            // The camera the frame on show is seen through at the playhead.
            "shot" => {
                let record = self.shown_frame()?;
                self.camera_at_time(&record, self.tick)?.unwrap_or(Value::Null)
            }
            // The camera an evaluated frame of the document holds, `null` for the default one.
            "frameCamera" => {
                let tick = num(args, "tick").ok_or_else(|| EditError::Invalid("the camera of a frame needs its tick".into()))?;
                self.evaluated(tick, true)?.get("camera").cloned().unwrap_or(Value::Null)
            }
            "cameraSamples" => self.camera_samples(args)?,
            "framing" => self.framing(args)?,
            other => return Err(EditError::Invalid(format!("the interface has no camera read '{other}'"))),
        };
        Ok(styk_doc::json::to_string(&value))
    }

    /// `{clip, ticks}`: for each tick, what the clip alone does to the shot as `x, y, rotation, zoom` (a follow clip's shaped
    /// path, zoom out negative; a preset's impulse), flat. `sampleCameraMotion` and `sampleFollow` for one clip.
    fn camera_samples(&self, args: &Value) -> Result<Value, EditError> {
        let clip = args.get("clip").and_then(styk_eval::load::camera_motion_clip).ok_or_else(|| EditError::Invalid("the camera motion to sample is not a clip".into()))?;
        let ticks = args.get("ticks").and_then(Value::numbers).unwrap_or_default();
        let prepared = self.prepared()?;
        let mut samples: Vec<f64> = Vec::with_capacity(ticks.len() * 4);
        if clip.kind == "follow" {
            let follow = self.follow_of(&prepared, clip, args.get("clip"));
            for &tick in &ticks {
                let [x, y, zoom] = follow.as_ref().map_or([0.0; 3], |follow| follow.offset(tick));
                samples.extend([x, y, 0.0, styk_math::exp(-zoom)]);
            }
        } else {
            let clips = [clip];
            for &tick in &ticks {
                match styk_eval::camera::impulse(&clips, tick, prepared.doc.fps) {
                    Some(d) => samples.extend([d.x, d.y, d.rotation, d.zoom]),
                    None => samples.extend([0.0, 0.0, 0.0, 1.0]),
                }
            }
        }
        Ok(Value::nums(&samples))
    }

    /// The follow path of `clip` through the document's figures, kept while it is the same clip of the same document.
    fn follow_of(&self, prepared: &Arc<styk_eval::eval::Prepared>, clip: styk_eval::doc::CameraMotionClip, source: Option<&Value>) -> Option<Arc<Follow>> {
        let text = source.map(styk_doc::json::to_string).unwrap_or_default();
        let identity = Arc::as_ptr(prepared) as usize;
        let mut cache = self.camera_views.borrow_mut();
        if let Some((held, held_text, follow)) = &cache.follow
            && *held == identity
            && *held_text == text
        {
            return follow.clone();
        }
        let mut doc = (*prepared.doc).clone();
        doc.camera_motion = vec![clip];
        let follow = Follow::new(&doc).map(Arc::new);
        cache.follow = Some((identity, text, follow.clone()));
        follow
    }

    /// `{targets: [{uid, weight}, …]}`: the framing offset that keeps those figures where they stand in the frame on show
    /// (`followFramingOffset`), `{x, y}`, or `null` when none of them is in it.
    fn framing(&self, args: &Value) -> Result<Value, EditError> {
        let targets: Vec<(u32, f64)> = args
            .get("targets")
            .and_then(Value::elements)
            .map(|targets| targets.iter().filter_map(|target| Some((num(&target, "uid")? as u32, num(&target, "weight")?))).collect())
            .unwrap_or_default();
        let record = self.shown_frame()?;
        let prepared = self.prepared()?;
        let frame = self.eval.borrow_mut().edit_frame(&record, &prepared).map_err(|error| EditError::Invalid(error.to_string()))?;
        let Some([x, y]) = styk_eval::follow::framing_offset(&prepared.doc, &frame, &targets) else { return Ok(Value::Null) };
        let mut offset = styk_doc::Obj::new();
        offset.set("x", Value::Num(x));
        offset.set("y", Value::Num(y));
        Ok(Value::object(offset))
    }
}
