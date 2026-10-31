//! What the interface reads of the frame on show (docs/engine/evaluation.md, "The interface's frame"):
//! the evaluated frame record (`editor.evaluatedFrame`), the document's own frame under a gesture
//! (the base a draft is composed on), the motion-path edit's display, the timeline rows
//! (`editor.timeline`) and the geometry of a frame (`editor.geometry`), each as JSON text.
//!
//! Geometry is sent as the groups that changed since the interface's last read: a group is rebuilt
//! when its figure's pose (or a figure joined to it) is another record (another node with other values: a
//! frame evaluated at another tick makes new records of the poses it holds), and every group when a figure
//! definition is another. The interface names the read it holds (`since`).

use std::sync::Arc;

use styk_doc::Value;
use styk_eval::eval::Prepared;

use crate::{EditError, Editor};

/// What the interface holds of one kind of frame's geometry, and the scenes built for that kind of frame.
#[derive(Clone, Default)]
pub(crate) struct Cache {
    /// The read it holds; zero before the first.
    token: u64,
    /// How many objects the frame had then, and the build of its scene ([`crate::shown::ShownScene::serial`]): an object built
    /// after it has changed since.
    count: usize,
    through: u64,
    pub(crate) scenes: crate::shown::Scenes,
}

impl Editor {
    /// The frame the interface shows: the gesture in progress, else the document at the playhead
    /// (`kind` `frame`); the document's own frame under any gesture (`document`); the motion-path
    /// edit's display, `null` where it shows the document (`motion`). Each carries the playhead as the time
    /// the document's effect clips are read at ([`Editor::with_effect_time`]).
    pub(crate) fn interface_frame(&self, kind: &str) -> Result<String, EditError> {
        let record = match kind {
            "frame" => self.shown_frame()?,
            "document" => self.document_frame()?,
            "motion" => match self.motion_display_frame_worker()? {
                Some(record) => record,
                None => return Ok("null".into()),
            },
            other => return Err(EditError::Invalid(format!("the interface has no frame '{other}'"))),
        };
        Ok(styk_doc::json::to_string(&self.with_effect_time(record)))
    }

    /// `record` with the playhead as the time the document's effect clips are read at (`_vfxTimelineTick`, which the
    /// effect gizmos compose the figures' effects at); a document with no effect clips leaves the frame as it is.
    fn with_effect_time(&self, record: Value) -> Value {
        if self.report.path(&["_styk", "vfxClips", "clips"]).and_then(Value::array_len).unwrap_or(0) == 0 {
            return record;
        }
        let mut shown = record.as_obj().cloned().unwrap_or_default();
        shown.set("_vfxTimelineTick", Value::Num(self.tick));
        Value::object(shown)
    }

    /// The record of the frame the stage draws: the motion-path edit's display where one is asked for and shown,
    /// else the frame on show.
    pub(crate) fn interface_record(&self, motion: bool) -> Result<Value, EditError> {
        let displayed = if motion { self.motion_display_frame_worker()? } else { None };
        let record = match displayed {
            Some(record) => record,
            None => self.shown_frame()?,
        };
        // The stage samples the effect clips and the camera's motion at the playhead.
        let mut shown = record.as_obj().cloned().unwrap_or_default();
        shown.set("tick", Value::Num(self.tick));
        if self.report.path(&["_styk", "cameraMotion", "clips"]).and_then(Value::array_len).unwrap_or(0) > 0 {
            shown.set("_cameraMotionTick", Value::Num(self.tick));
        }
        Ok(Value::object(shown))
    }

    /// The reads of the editor's own the interface makes by name (`animationValue`, `vfxEffects`, `segmentAnimationTarget`,
    /// `getIKSettings`), answered where the session holds the document: `None` for a name it does not answer, else the
    /// value (`None` inside for what the editor answers `undefined`). A document that is not on a layer sheet has property
    /// channels of its own that these do not read yet: `Unported`.
    pub(crate) fn interface_query(&self, name: &str, args: &Value) -> Option<Result<Option<Value>, EditError>> {
        let arg = |index: usize| args.item(index).filter(|value| !value.is_null());
        Some(match name {
            "getIKSettings" => self.get_ik_settings().map(Some),
            "drawingReplay" => Ok(Some(self.drawing_replay(arg(0).is_some_and(|redo| redo.truthy())))),
            "drawingBatch" => Ok(Some(self.drawing_batch())),
            "drawingRefs" => Ok(Some(self.drawing_refs())),
            // A clipboard the session holds, as the interface hands it to another session (`@setClipboard`).
            "clipboard" => Ok(arg(0).and_then(|kind| kind.as_str().and_then(|kind| self.clipboard_wire(kind)))),
            // The reads of the 3D rig inspector and the effect clips' sampling (the interface never evaluates them itself).
            "getSpatialPose" => self.interface_spatial(arg(0), false),
            "getSpatialMotion" => self.interface_spatial(arg(0), true),
            "sampleVfxClip" => (|| {
                let id = arg(0).ok_or_else(|| EditError::Invalid("errors.editorVfxClips.selectAnEffectClip".into()))?;
                let tick = arg(1).and_then(|tick| tick.as_f64()).unwrap_or(self.tick);
                self.sample_vfx_clip(&id, tick).map(Some)
            })(),
            "animationValue" | "vfxEffects" | "segmentAnimationTarget" if !self.sheet() => {
                Err(EditError::Unported("property values of a document without a layer sheet".into()))
            }
            "animationValue" => (|| {
                let property = arg(1).and_then(|property| property.as_str().map(str::to_string)).ok_or_else(|| EditError::Invalid("errors.animationChannels.chooseASupportedAnimationProperty".into()))?;
                self.animation_value(&arg(0).unwrap_or(Value::Null), &property, &arg(2).unwrap_or(Value::Num(self.tick)))
            })(),
            "vfxEffects" => self.vfx_effects(&arg(0).unwrap_or(Value::Null)).map(|effects| Some(Value::array(effects))),
            "segmentAnimationTarget" => {
                let mut target = styk_doc::Obj::new();
                target.set("kind", Value::str("segment"));
                target.set("uid", arg(0).unwrap_or(Value::Null));
                target.set("handleId", arg(1).unwrap_or(Value::Null));
                crate::property_edit::normalize_target(&Value::object(target)).map(Some)
            }
            _ => return None,
        })
    }

    /// The rectangle the figures `{uids}` paint at the playhead, a movieclip instance's content included, without the reach of their
    /// effects: `[x, y, width, height]`, or `null` when they paint nothing. The effects gizmo measures a figure by it: the geometry the
    /// interface holds of a movieclip instance is its handle alone (what it draws is the engine's).
    pub(crate) fn interface_vfx_extent(&self, args: &Value) -> Result<String, EditError> {
        let uids: Vec<f64> = args.get("uids").and_then(Value::numbers).ok_or_else(|| EditError::Invalid("an extent needs the identities of its figures".into()))?;
        let prepared = self.prepared()?;
        let record = self.interface_record(false)?;
        let frame = self.eval.borrow_mut().loader.edit_frame(&record, None, &prepared.doc).map_err(|error| EditError::Invalid(error.to_string()))?;
        let slots: Vec<u32> = frame.objects.iter().enumerate().filter(|(_, object)| uids.contains(&f64::from(object.uid))).map(|(slot, _)| slot as u32).collect();
        let scene = styk_eval::geometry::build(&prepared.doc, &frame);
        Ok(match styk_eval::drawlist::objects_artwork_bounds(&scene, prepared.doc.as_ref(), &slots) {
            Some(rect) => styk_doc::json::to_string(&Value::nums(&rect)),
            None => "null".into(),
        })
    }

    /// The figures whose connected effects the figure `{uid}` filters together at the playhead (its `vfxScope`, or a clip that includes
    /// the attached parts, with an effect active): `{members: [uid, …]}`, the owner first and then the figures attached to it, or
    /// `null` when it owns no connected group (the effects gizmo measures the owner alone).
    pub(crate) fn interface_vfx_group(&self, args: &Value) -> Result<String, EditError> {
        let uid = args.get("uid").and_then(Value::as_f64).ok_or_else(|| EditError::Invalid("a connected group needs its owner's identity".into()))?;
        let prepared = self.prepared()?;
        if !prepared.has_vfx {
            return Ok("null".into());
        }
        let record = self.interface_record(false)?;
        let mut frame = self.eval.borrow_mut().loader.edit_frame(&record, None, &prepared.doc).map_err(|error| EditError::Invalid(error.to_string()))?;
        frame.vfx = prepared.frame_vfx(&frame, &mut Vec::new());
        let attached = frame
            .objects
            .iter()
            .position(|object| f64::from(object.uid) == uid)
            .and_then(|slot| frame.vfx.as_ref()?.object(slot as u32)?.attached.as_ref());
        let Some(attached) = attached else { return Ok("null".into()) };
        let members: Vec<f64> = attached.members.iter().filter_map(|&slot| frame.objects.get(slot as usize)).map(|object| f64::from(object.uid)).collect();
        let mut group = styk_doc::Obj::new();
        group.set("members", Value::nums(&members));
        Ok(styk_doc::json::to_string(&Value::object(group)))
    }

    /// A figure, a set of figures or a movieclip with the pose on show as a document of its own (`nativeFigureDocument`; a
    /// library file, the rig test, the builder): `{figureUid | figureUids | figureTypeId, tick}`, as JSON.
    pub(crate) fn interface_figure_document(&self, args: &Value) -> Result<String, EditError> {
        let number = |key: &str| args.get(key).and_then(Value::as_f64);
        let request = crate::export::FigureRequest {
            figure_type_id: number("figureTypeId"),
            figure_uid: number("figureUid"),
            figure_uids: args.get("figureUids").and_then(Value::numbers).unwrap_or_default(),
            tick: number("tick").unwrap_or(self.tick),
        };
        Ok(styk_doc::json::to_string(&self.native_figure(&request, Some(&self.selection_frame_record()?))?))
    }

    /// `editor.selectionFrame` as a record: on a layer sheet, or under a gesture or with saved channels the frame on show, else
    /// the keyframe at the playhead.
    pub(crate) fn selection_frame_record(&self) -> Result<Value, EditError> {
        if self.authored.is_some() || self.sheet() || self.report.path(&["_styk", "animation", "channels"]).and_then(Value::array_len).unwrap_or(0) > 0 {
            return self.shown_frame();
        }
        // The playhead is the row of a keyframe, so the frame is there; a stale index reads the last one.
        let frames = self.report.get("keyframes");
        let last = frames.and_then(Value::array_len).and_then(|count| count.checked_sub(1));
        last.and_then(|last| frames?.item(self.frame_index.min(last))).ok_or_else(|| EditError::Invalid("the document has no keyframe on show".into()))
    }

    /// `getSpatialPose(index)` (or `getSpatialMotion(index)` with `motion`) of the selected figure's bone at `index` (by default the
    /// selected joint): `{bend, turn, pitch}`, or the travel of a mechanical joint, `null` where there is no such bone.
    fn interface_spatial(&self, index: Option<Value>, motion: bool) -> Result<Option<Value>, EditError> {
        let Some(context) = self.spatial_context()? else { return Ok(Some(Value::Null)) };
        let index = match index.and_then(|index| index.as_f64()) {
            Some(index) if index >= 0.0 && index.fract() == 0.0 => index as usize,
            Some(_) => return Ok(Some(Value::Null)),
            None if self.selection.joint >= 0 => self.selection.joint as usize,
            None => return Ok(Some(Value::Null)),
        };
        let mut out = styk_doc::Obj::new();
        if motion {
            let Some(state) = Self::spatial_motion(&context, index) else { return Ok(Some(Value::Null)) };
            out.set("type", Value::str(if state.hinge { "hinge" } else { "slide" }));
            out.set("min", Value::Num(state.min));
            out.set("max", Value::Num(state.max));
            out.set("value", Value::Num(state.value));
            out.set("applied", Value::Num(state.applied));
            out.set("driver", Value::Num(state.driver));
            out.set("fraction", Value::Num(if state.max > state.min { (state.value - state.min) / (state.max - state.min) } else { 0.0 }));
        } else {
            let Some(pose) = Self::spatial_pose(&context, index) else { return Ok(Some(Value::Null)) };
            out.set("bend", Value::Num(pose.bend));
            out.set("turn", Value::Num(pose.turn));
            out.set("pitch", Value::Num(pose.pitch));
        }
        Ok(Some(Value::object(out)))
    }

    /// `editor.timeline` as `[[start, count], …]`, one pair per row.
    pub(crate) fn interface_timeline(&self) -> String {
        let rows = crate::timeline::rows(&self.report);
        let mut out = Vec::with_capacity(rows.len() * 12 + 2);
        out.push(b'[');
        for (i, row) in rows.iter().enumerate() {
            if i > 0 {
                out.push(b',');
            }
            out.push(b'[');
            styk_doc::format_number(row.start, &mut out);
            out.push(b',');
            styk_doc::format_number(row.count, &mut out);
            out.push(b']');
        }
        out.push(b']');
        String::from_utf8(out).unwrap_or_default()
    }

    /// `editor.geometry` of the frame on show (or of the motion-path display with `motion`), the groups
    /// that changed since the read `since` named: `{token, full, count, slots: [[slot, group|null], …],
    /// warnings}`. `null` where a motion-path edit shows the document.
    pub(crate) fn interface_geometry(&self, args: &Value) -> Result<String, EditError> {
        let motion = args.get("motion").is_some_and(Value::truthy);
        let since = args.get("since").and_then(Value::as_f64).map(|token| token as u64);
        let Some(shown) = self.shown_scene(motion, crate::shown::Flavor::Composed)? else { return Ok("null".into()) };
        let count = shown.frame.objects.len();
        let mut caches = self.shown.borrow_mut();
        let cache = &mut caches[usize::from(motion)];
        // The held read is this one's predecessor: the objects built since are the ones that changed. Another read, or one of another
        // frame, is all of them.
        let reuse = since.is_some() && since == Some(cache.token) && cache.count == count;
        let slots: Vec<usize> = (0..count).filter(|&slot| !reuse || shown.built_in[slot] > cache.through).collect();
        let full = slots.len() == count;
        let groups = if slots.is_empty() {
            (Vec::new(), Vec::new())
        } else {
            let bounds = styk_eval::drawlist::app_bounds_of(&shown.scene, shown.prepared.doc.as_ref(), &slots);
            (styk_eval::geometry::write_groups(&shown.scene, &slots, &bounds), shown.scene.warnings.clone())
        };
        cache.token += 1;
        cache.count = count;
        cache.through = shown.serial;
        geometry_text(cache.token, full, count, &slots, &groups)
    }

    /// The geometry of a frame that is not the document's: `frame` (the frame on show with a drawing cel the document does not hold yet
    /// added to it) seen against the document with `figure` among its figure types and its object on the layer `layerId`
    /// (`{frame, figure, uid, layerId}`), as a full geometry read of it.
    pub(crate) fn interface_preview_geometry(&self, args: &Value) -> Result<String, EditError> {
        let invalid = |what: &str| EditError::Invalid(format!("the geometry preview needs {what}"));
        let record = args.get("frame").filter(|frame| frame.is_object()).ok_or_else(|| invalid("a frame"))?;
        let figure = args.get("figure").filter(|figure| figure.is_object()).ok_or_else(|| invalid("a figure"))?;
        let uid = args.get("uid").and_then(Value::as_f64).ok_or_else(|| invalid("the figure's identity"))?;
        let layer = args.get("layerId").and_then(Value::as_str).ok_or_else(|| invalid("a layer"))?;
        let mut report = self.report.clone();
        {
            let root = report.make_obj().ok_or_else(|| invalid("a document"))?;
            let mut figures = root.get("figure_types").and_then(Value::elements).map(|figures| figures.iter().collect::<Vec<_>>()).unwrap_or_default();
            figures.push(figure.clone());
            root.set("figure_types", Value::array(figures));
            let mut styk = root.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
            let mut layers = styk.get("layers").and_then(Value::as_obj).cloned().unwrap_or_default();
            let mut assignments = layers.get("assignments").and_then(Value::as_obj).cloned().unwrap_or_default();
            assignments.set(&(uid as u64).to_string(), Value::str(layer));
            layers.set("assignments", Value::object(assignments));
            styk.set("layers", Value::object(layers));
            root.set("_styk", Value::object(styk));
        }
        let mut loader = self.eval.borrow().loader.clone();
        let document = loader.document(&report, "").map_err(|error| EditError::Invalid(error.to_string()))?;
        let prepared = Prepared::new(Arc::new(document));
        let frame = loader.edit_frame(record, None, &prepared.doc).map_err(|error| EditError::Invalid(error.to_string()))?;
        let count = frame.objects.len();
        let scene = styk_eval::geometry::build_shapes(&prepared.doc, &frame, None);
        let bounds = styk_eval::drawlist::app_bounds(&scene, prepared.doc.as_ref());
        let slots: Vec<usize> = (0..count).collect();
        let groups = (styk_eval::geometry::write_groups(&scene, &slots, &bounds), scene.warnings);
        geometry_text(0, true, count, &slots, &groups)
    }
}

/// A geometry read as the interface takes it (`{token, full, count, slots: [[slot, group|null], …], warnings}`).
fn geometry_text(token: u64, full: bool, count: usize, slots: &[usize], groups: &(Vec<String>, Vec<String>)) -> Result<String, EditError> {
    let mut out = Vec::with_capacity(64 + groups.0.iter().map(|group| group.len() + 8).sum::<usize>());
    out.extend_from_slice(format!("{{\"token\":{token},\"full\":{full},\"count\":{count},\"slots\":[").as_bytes());
    for (n, (slot, group)) in slots.iter().zip(&groups.0).enumerate() {
        if n > 0 {
            out.push(b',');
        }
        out.extend_from_slice(format!("[{slot},").as_bytes());
        out.extend_from_slice(group.as_bytes());
        out.push(b']');
    }
    out.extend_from_slice(b"],\"warnings\":");
    styk_doc::json::write(&Value::array(groups.1.iter().map(|warning| Value::str(warning)).collect()), &mut out);
    out.push(b'}');
    String::from_utf8(out).map_err(|error| EditError::Invalid(error.to_string()))
}
