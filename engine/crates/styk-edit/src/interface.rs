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
    /// The frame and scene of the latest read ([`Editor::interface_geometry_groups`] reads the groups it sent light from it): the frame
    /// on show once the interface has read it, so it holds no scene the session does not hold already.
    read: Option<Arc<crate::shown::ShownScene>>,
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

    /// [`Editor::interface_frame`] with the numbers of its objects' arrays (a pose's angles, lengths, bends: most of a dense frame's text)
    /// left out of the text: each such array is the string `"\u0000"` there, and its numbers wait, as words, for the next
    /// [`Editor::take_frame_numbers`]. Only arrays of finite numbers are left out (a non-finite number is `null` as text), and a negative zero
    /// is a zero, as the text gives it: the interface puts back the values the whole text holds.
    pub(crate) fn interface_frame_packed(&self, kind: &str) -> Result<String, EditError> {
        let record = match kind {
            "frame" => self.shown_frame()?,
            "document" => self.document_frame()?,
            "motion" => match self.motion_display_frame_worker()? {
                Some(record) => record,
                None => return Ok("null".into()),
            },
            other => return Err(EditError::Invalid(format!("the interface has no frame '{other}'"))),
        };
        let mut numbers = Vec::new();
        let record = pack_object_numbers(self.with_effect_time(record), &mut numbers);
        *self.frame_numbers.borrow_mut() = numbers;
        Ok(styk_doc::json::to_string(&record))
    }

    /// The numbers the last [`Editor::interface_frame_packed`] left out of its text, as words: for each object of the frame in order, for each
    /// array left out in the order of its keys, its length and then its numbers. Taken once.
    pub(crate) fn take_frame_numbers(&self) -> Vec<f64> {
        std::mem::take(&mut *self.frame_numbers.borrow_mut())
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
    /// that changed since the read `since` named, as a packet ([`geometry_packet`]). Empty where a motion-path edit shows the document.
    pub(crate) fn interface_geometry(&self, args: &Value) -> Result<Vec<f64>, EditError> {
        let motion = args.get("motion").is_some_and(Value::truthy);
        let since = args.get("since").and_then(Value::as_f64).map(|token| token as u64);
        let Some(shown) = self.shown_scene(motion, crate::shown::Flavor::Composed)? else { return Ok(Vec::new()) };
        let count = shown.frame.objects.len();
        let mut caches = self.shown.borrow_mut();
        let cache = &mut caches[usize::from(motion)];
        // The held read is this one's predecessor: the objects built since are the ones that changed. Another read, or one of another
        // frame, is all of them. So is a scene older than the read held (one the stage drew of this frame before the interface read
        // another): its objects' builds say nothing of what changed since that read.
        let reuse = since.is_some() && since == Some(cache.token) && cache.count == count && shown.serial >= cache.through;
        let slots: Vec<usize> = (0..count).filter(|&slot| !reuse || shown.built_in[slot] > cache.through).collect();
        let full = slots.len() == count;
        cache.token += 1;
        cache.count = count;
        cache.through = shown.serial;
        cache.read = Some(shown.clone());
        // A read that changed nothing says nothing of the scene's warnings, which the interface holds.
        let warnings = if slots.is_empty() { &[][..] } else { &shown.scene.warnings[..] };
        // Above `lightAbove` segments, a figure that is not joined to another is sent light (`interface::LIGHT`): what the joints of a
        // dense frame read of a figure that shows its origin alone. The interface asks for the rest of it when it reads more of it
        // (`geometryGroups`).
        let light_above = args.get("lightAbove").and_then(Value::as_f64);
        let segments: usize = slots.iter().map(|&slot| shown.scene.objects[slot].ends.len()).sum();
        let lighten = light_above.is_some_and(|limit| segments as f64 > limit);
        let light = |slot: usize| lighten && shown.frame.objects[slot].join.is_none();
        // The groups are written after the header, in the packet itself (a dense frame's are megabytes): room for them is made once.
        let mut packet = geometry_packet(cache.token, full, count, slots.len(), warnings, &[]);
        if !slots.is_empty() {
            packet.reserve(styk_eval::geometry::packed_size_with(&shown.scene, &slots, &light));
            let bounds = styk_eval::drawlist::app_bounds_of(&shown.scene, shown.prepared.doc.as_ref(), &slots);
            styk_eval::geometry::pack_groups_with(&shown.scene, &slots, &bounds, &light, &mut packet);
        }
        Ok(packet)
    }

    /// The whole groups of `slots` (`args` `{slots, motion}`) of the interface's latest geometry read, which sent them light: `slot, length,
    /// words` each, as a read writes them. A group a read sent is its figure's in every later read that did not send it again, so the latest
    /// read holds what any light group the interface holds was sent for. Empty before the first read.
    pub(crate) fn interface_geometry_groups(&self, args: &Value) -> Result<Vec<f64>, EditError> {
        let motion = args.get("motion").is_some_and(Value::truthy);
        let Some(shown) = self.shown.borrow()[usize::from(motion)].read.clone() else { return Ok(Vec::new()) };
        let count = shown.frame.objects.len();
        let slots: Vec<usize> = args.get("slots").and_then(Value::elements).map(|slots| slots.iter().filter_map(|slot| slot.as_f64()).map(|slot| slot as usize).filter(|&slot| slot < count).collect()).unwrap_or_default();
        let mut groups = Vec::with_capacity(styk_eval::geometry::packed_size(&shown.scene, &slots));
        let bounds = styk_eval::drawlist::app_bounds_of(&shown.scene, shown.prepared.doc.as_ref(), &slots);
        styk_eval::geometry::pack_groups(&shown.scene, &slots, &bounds, &mut groups);
        Ok(groups)
    }

    /// The geometry of a frame that is not the document's: `frame` (the frame on show with a drawing cel the document does not hold yet
    /// added to it) seen against the document with `figure` among its figure types and its object on the layer `layerId`
    /// (`{frame, figure, uid, layerId}`), as a full geometry read of it.
    pub(crate) fn interface_preview_geometry(&self, args: &Value) -> Result<Vec<f64>, EditError> {
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
        let mut groups = Vec::new();
        styk_eval::geometry::pack_groups(&scene, &slots, &bounds, &mut groups);
        Ok(geometry_packet(0, true, count, slots.len(), &scene.warnings, &groups))
    }
}

/// `record` (a frame) with each array of finite numbers at the top of its objects (at least four of them) replaced by the string `"\u0000"`,
/// its length and numbers appended to `out` ([`Editor::interface_frame_packed`]).
fn pack_object_numbers(record: Value, out: &mut Vec<f64>) -> Value {
    let Some(frame) = record.as_obj() else { return record };
    let Some(objects) = frame.get("objects").and_then(Value::elements) else { return record };
    let marker = Value::str("\u{0}");
    let mut packed = Vec::with_capacity(objects.len());
    for object in objects {
        let Some(fields) = object.as_obj() else {
            packed.push(object);
            continue;
        };
        let mut copy: Option<styk_doc::Obj> = None;
        for (key, value) in fields.iter() {
            let Value::Nums(numbers) = value else { continue };
            if numbers.len() < 4 || !numbers.iter().all(f64::is_finite) {
                continue;
            }
            out.push(numbers.len() as f64);
            // As the text gives it: a negative zero is written `0`.
            out.extend(numbers.iter().map(|value| if value == 0.0 { 0.0 } else { value }));
            copy.get_or_insert_with(|| fields.clone()).set(key, marker.clone());
        }
        packed.push(copy.map_or(object, Value::object));
    }
    let mut frame = frame.clone();
    frame.set("objects", Value::array(packed));
    Value::object(frame)
}

/// A geometry read as the interface takes it: words, `token, full (0 or 1), count (of objects), groups (how many follow), warnings` (how
/// many, then each as its length and its UTF-16 code units), then the groups as `slot, length, words`
/// ([`styk_eval::geometry::interface`]). The interface reads them where they lie.
fn geometry_packet(token: u64, full: bool, count: usize, groups: usize, warnings: &[String], words: &[f64]) -> Vec<f64> {
    let mut out = Vec::with_capacity(8 + words.len() + warnings.iter().map(|warning| warning.len() + 1).sum::<usize>());
    out.extend_from_slice(&[token as f64, if full { 1.0 } else { 0.0 }, count as f64, groups as f64, warnings.len() as f64]);
    for warning in warnings {
        let units: Vec<u16> = warning.encode_utf16().collect();
        out.push(units.len() as f64);
        out.extend(units.into_iter().map(f64::from));
    }
    out.extend_from_slice(words);
    out
}
