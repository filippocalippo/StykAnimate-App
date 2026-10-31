//! The frame on show as the engine builds it, once for every reader (docs/engine/evaluation.md, "The interface's frame").
//!
//! The interface's geometry, the commands that read where a joint is and the stage that draws the frame all need the typed
//! frame of the record on show and the scene built from it. A [`ShownScene`] is that pair, kept for as long as the record
//! and the document's views are what it was made from, and built from the one before it: an object whose inputs did not
//! change is not built again ([`BuildMemory`]), so a gesture that moves one figure builds that figure and what hangs from
//! it, however many figures the frame has.

use std::sync::Arc;

use styk_doc::Value;
use styk_eval::eval::{Frame, Prepared};
use styk_eval::geometry::{BuildMemory, Scene};

use crate::{EditError, Editor};

/// Which effects the frame carries: a frame of a document with effects is two scenes, a frame of one without is one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Flavor {
    /// The effects the editor composed into the record (clips included): what the interface reads.
    Composed,
    /// The effects of the document sampled at the frame's tick, as a prepared frame's are: what the stage draws.
    Sampled,
}

/// The frame on show, typed, and the scene built from it.
pub struct ShownScene {
    /// The views of the document the frame was converted against.
    pub prepared: Arc<Prepared>,
    /// The record the frame was made from.
    pub record: Value,
    /// The playhead it was made at: the time the stage samples the effect clips and the camera's motion at.
    pub tick: f64,
    pub frame: Arc<Frame>,
    pub scene: Arc<Scene>,
    /// The time the effect clips are read at (`_vfxTimelineTick`, when the record carries it) and the playhead on the camera-motion clips
    /// (when the document has any).
    pub times: (Option<f64>, Option<f64>),
    /// The build ([`BuildMemory::serial`]) that made the scene, and for each object the build that made its geometry: an object
    /// whose number is above that of a read has changed since the read.
    pub serial: u64,
    pub built_in: Vec<u64>,
    flavor: Flavor,
    /// The document has no effects to change it: both flavors of the frame are this one.
    plain: bool,
}

/// What the editor keeps of its shown frames: the memory their builds share and the last of each flavor.
#[derive(Clone, Default)]
pub(crate) struct Scenes {
    memory: BuildMemory,
    held: [Option<Arc<ShownScene>>; 2],
}

impl Scenes {
    /// The frame held last, of either flavor.
    fn latest(&self) -> Option<Arc<ShownScene>> {
        self.held.iter().flatten().next().cloned()
    }

    /// The held frame of `flavor` made of `source` against `prepared`, if there is one.
    fn find(&self, source: &Value, tick: f64, prepared: &Arc<Prepared>, flavor: Flavor) -> Option<Arc<ShownScene>> {
        self.held.iter().flatten().find(|held| {
            (held.flavor == flavor || held.plain) && held.record.same_node(source) && Arc::ptr_eq(&held.prepared, prepared) && held.tick.to_bits() == tick.to_bits()
        }).cloned()
    }
}

impl Editor {
    /// The frame on show (the motion-path edit's display with `motion`; `None` where it shows nothing), typed and built, in the
    /// effects of `flavor`.
    pub fn shown_scene(&self, motion: bool, flavor: Flavor) -> Result<Option<Arc<ShownScene>>, EditError> {
        let source = if motion {
            match self.motion_display_frame_worker()? {
                Some(record) => record,
                None => return Ok(None),
            }
        } else {
            self.shown_frame()?
        };
        let prepared = self.prepared()?;
        if let Some(held) = self.shown.borrow()[usize::from(motion)].scenes.find(&source, self.tick, &prepared, flavor) {
            return Ok(Some(held));
        }
        let mut frame = self.eval.borrow_mut().edit_frame(&source, &prepared).map_err(|error| EditError::Invalid(error.to_string()))?;
        frame.tick = self.tick;
        // An object whose record holds the data the held frame's did is that frame's object: what a scene built of it was, it still is.
        let held = self.shown.borrow()[usize::from(motion)].scenes.latest();
        if let Some(held) = held.filter(|held| held.frame.objects.len() == frame.objects.len()) {
            let (now, before) = (source.get("objects").and_then(Value::as_arr), held.record.get("objects").and_then(Value::as_arr));
            if let (Some(now), Some(before)) = (now, before)
                && now.len() == before.len() && now.len() == frame.objects.len()
            {
                for (slot, object) in frame.objects.iter_mut().enumerate() {
                    let kept = &held.frame.objects[slot];
                    let figure = object.figure;
                    let same_figure = held.prepared.doc.figure(figure).zip(prepared.doc.figure(figure)).is_some_and(|(was, is)| Arc::ptr_eq(was, is));
                    if !Arc::ptr_eq(object, kept) && same_figure && now[slot].same_data(&before[slot]) {
                        *object = kept.clone();
                    }
                }
            }
        }
        let fields = frame.pose_vfx.is_some() || frame.objects.iter().any(|object| object.vfx.is_some() || object.vfx_connected.is_some());
        let plain = !(fields || prepared.has_vfx);
        if !plain {
            frame.vfx = match flavor {
                Flavor::Composed => styk_eval::vfx::frame::composed(&prepared.doc, &frame),
                Flavor::Sampled => styk_eval::vfx::frame::evaluate(&prepared.doc, &frame),
            };
        }
        let mut caches = self.shown.borrow_mut();
        let scenes = &mut caches[usize::from(motion)].scenes;
        let scene = styk_eval::geometry::build_remembering(&prepared.doc, &frame, &mut scenes.memory);
        let moving_camera = self.report.path(&["_styk", "cameraMotion", "clips"]).and_then(Value::array_len).unwrap_or(0) > 0;
        let times = (source.get("_vfxTimelineTick").and_then(Value::as_f64), moving_camera.then_some(self.tick));
        let built_in = (0..frame.objects.len()).map(|slot| scenes.memory.built_in(slot)).collect();
        let shown = Arc::new(ShownScene {
            prepared, record: source, tick: self.tick, frame: Arc::new(frame), scene: Arc::new(scene), times, serial: scenes.memory.serial(), built_in, flavor, plain,
        });
        scenes.held[usize::from(flavor == Flavor::Sampled)] = Some(shown.clone());
        Ok(Some(shown))
    }
}
