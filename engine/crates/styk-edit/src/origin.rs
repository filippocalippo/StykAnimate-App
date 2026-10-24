//! Raw-record side of animation-origin gesture mutations (src/editor-origin-mutations.mjs).
//! Numeric tree/support arithmetic stays in styk_eval::origin; unknown record fields
//! survive synchronization and reflection, including ghost metadata.
use std::collections::HashMap;
use std::sync::Arc;
use styk_doc::{Obj, Value};
use crate::record::{num, uid};
use crate::{EditError, Editor};

pub(crate) fn recorded_call(method: &str) -> bool {
    gesture_call(method) || choice_call(method) || posing_call(method) || constraint_call(method) || rig_tool_call(method) || rig_pose_call(method) || property_call(method) || range_call(method) || motion_call(method) || matches!(method, "select" | "@select" | "selectMany" | "seek" | "@seek" | "beginDrag" | "beginTranslationDrag" |
        "commitDrag" | "cancelDrag" | "moveSelection" | "rotateSelection" | "scaleSelection" | "scaleSelected" |
        "mirrorSelection" | "mirrorFigure" | "rotateFigure" | "centerFigure" | "resetPose" | "setOrigin" | "mirrorSegment" | "mirrorSegmentBranch" | "splitSegment" | "splitSegmentBranch" | "splitBuilderSegments" | "unsplitSegment" |
        "deleteSingleSegment" | "deleteSegment" | "addSegment" | "addSegments" | "addSpriteSegment" | "changeBranchThickness" | "moveBuilderSegment" | "duplicateSegment" | "duplicateSegmentBranch" | "replaceFigureDefinition" | "undo" | "redo")
}

pub(crate) fn property_call(method: &str) -> bool {
    matches!(method, "beginAnimationEdit" | "previewAnimationEdit" | "commitAnimationEdit" | "cancelAnimationEdit" | "addAnimationKey" | "addAnimationKeys")
}

pub(crate) fn motion_call(method: &str) -> bool {
    matches!(method, "beginMotionPathEdit" | "updateMotionPathEdit" | "commitMotionPathEdit" | "cancelMotionPathEdit" | "setMotionPathFalloff" | "motionPathFalloff")
}

pub(crate) fn recorded_channel_call(method: &str) -> bool {
    gesture_call(method) || choice_call(method) || constraint_call(method) || property_call(method) || range_call(method) || rig_tool_call(method) || rig_pose_call(method) || motion_call(method) || matches!(method, "select" | "@select" | "selectMany" | "seek" | "@seek" | "beginDrag" | "beginTranslationDrag" | "commitDrag" | "cancelDrag" |
        "moveSelection" | "rotateSelection" | "scaleSelection" | "scaleSelected" | "mirrorSelection" | "mirrorFigure" | "rotateFigure" | "centerFigure" | "resetPose" |
        "poseJoint" | "rotateJoint" | "bendJoint" | "undo" | "redo")
}

pub(crate) fn range_call(method: &str) -> bool {
    matches!(method, "rotateFiguresInFrames" | "mirrorFiguresInFrames" | "scaleFiguresInFrames" | "resetPoseInFrames" | "centerFiguresInFrames" |
        "detachFiguresInFrames" | "joinFiguresInFrames" | "moveSelectionInFrames" | "joinTo" | "unjoinFigure" | "joinFigure" | "addFigure" | "deleteSelection" | "deleteFigure")
}

pub(crate) fn posing_call(method: &str) -> bool {
    matches!(method, "poseJoint" | "rotateJoint" | "bendJoint" | "beginHandleEditDrag" | "editHandlePosition" | "commitHandleEditDrag" | "cancelHandleEditDrag" |
        "beginFigureHandleDrag" | "transformFigureHandle" | "commitFigureHandleDrag" | "cancelFigureHandleDrag")
}

pub(crate) fn choice_call(method: &str) -> bool { method == "setPoseChoice" }

/// The tweener and the Alt-drag duplicate: gestures that pose or copy whole figures.
pub(crate) fn gesture_call(method: &str) -> bool {
    matches!(method, "beginTween" | "updateTween" | "beginDuplicateDrag" | "finishDuplicateDrag")
}

/// Only the recorded sparse 2D angle-lock definition changes, not general rig patches.
pub(crate) fn constraint_call(method: &str) -> bool {
    matches!(method, "setAngleLock" | "setSecondaryAngleReference" | "setRigBehavior")
}

#[derive(Clone, Copy, PartialEq)]
enum RigScope { Plain, Pose, Angle }

pub(crate) fn rig_tool_call(method: &str) -> bool {
    matches!(method, "beginRigDrag" | "editRigJoint" | "commitRigDrag" | "cancelRigDrag")
}

pub(crate) fn rig_pose_call(method: &str) -> bool {
    matches!(method, "poseJoint" | "rotateJoint" | "bendJoint" | "beginFigureHandleDrag" | "transformFigureHandle" | "commitFigureHandleDrag" | "cancelFigureHandleDrag" |
        "slideConnector" | "setConnectorPosition")
}

fn same_pose(a: &Value, b: &Value) -> bool {
    if ["root_x", "root_y", "scale", "len_flag", "bend_flag", "angles", "lengths", "bends"].iter().any(|key| a.get(key) != b.get(key)) {
        return false;
    }
    let ghosts = |object: &Value| object.path(&["_stykAnimationOrigin", "ghosts"]).and_then(Value::as_obj).cloned().unwrap_or_default();
    let (a, b) = (ghosts(a), ghosts(b));
    a.len() == b.len() && a.iter().all(|(key, ghost)| b.get(key).is_some_and(|other|
        other.truthy() && ["angle_rad", "bend_rad", "length"].iter().all(|field| ghost.get(field) == other.get(field))))
}

fn support(figure: &Value) -> bool {
    figure.path(&["_styk", "animationOrigin", "support"]).is_some_and(Value::truthy)
}

pub(crate) fn rotate_support(figure: &Value, object: &mut Obj, delta: f64) {
    if delta == 0.0 || !support(figure) { return; }
    let Some(origin) = object.get("_stykAnimationOrigin").and_then(Value::as_obj) else { return };
    let Some(ghosts) = origin.get("ghosts").and_then(Value::as_obj) else { return };
    let mut out = ghosts.clone();
    for (key, pose) in ghosts.iter() {
        let mut pose = pose.as_obj().cloned().unwrap_or_default();
        pose.set("angle_rad", Value::Num(pose.get("angle_rad").and_then(Value::as_f64).unwrap_or(f64::NAN) + delta));
        out.set(key, Value::object(pose));
    }
    let mut origin = origin.clone(); origin.set("ghosts", Value::object(out));
    object.set("_stykAnimationOrigin", Value::object(origin));
}

pub(crate) fn mirror_support(figure: &Value, object: &mut Obj, horizontal: bool) {
    if !support(figure) { return; }
    let Some(origin) = object.get("_stykAnimationOrigin").and_then(Value::as_obj) else { return };
    let Some(ghosts) = origin.get("ghosts").and_then(Value::as_obj) else { return };
    let mut out = ghosts.clone();
    for (key, pose) in ghosts.iter() {
        let angle = num(pose, "angle_rad").unwrap_or(f64::NAN);
        let mut record = pose.as_obj().cloned().unwrap_or_default();
        record.set("angle_rad", Value::Num(if horizontal { std::f64::consts::PI - angle } else { -angle }));
        record.set("bend_rad", Value::Num(-num(pose, "bend_rad").unwrap_or(f64::NAN)));
        out.set(key, Value::object(record));
    }
    let mut origin = origin.clone(); origin.set("ghosts", Value::object(out));
    object.set("_stykAnimationOrigin", Value::object(origin));
}

pub(crate) fn reset_support(figure: &Value, object: &mut Obj) {
    let Some(bones) = figure.path(&["_styk", "animationOrigin", "support", "bones"]).and_then(Value::elements) else { return };
    let mut ghosts = Obj::new();
    for (index, bone) in bones.iter().enumerate().filter(|(_, bone)| bone.get("handleId").is_some_and(Value::is_null)) {
        let mut pose = Obj::new();
        for field in ["angle_rad", "bend_rad", "length"] { pose.set(field, bone.get(field).cloned().unwrap_or(Value::Null)); }
        ghosts.set(&index.to_string(), Value::object(pose));
    }
    if !ghosts.is_empty() {
        let mut origin = object.get("_stykAnimationOrigin").and_then(Value::as_obj).cloned().unwrap_or_default();
        origin.set("ghosts", Value::object(ghosts)); object.set("_stykAnimationOrigin", Value::object(origin));
    }
}

impl Editor {
    /// Only the ordinary 2D and retained-support definitions in the posing
    /// recordings are admitted. Reuse the gesture owner's affected slots.
    pub(crate) fn origin_pose_gate(&self) -> Result<(), EditError> {
        self.origin_plain_targets(&self.selection.uids)
    }

    /// The tweener blends, and the duplicate drag copies and moves, whole connected figures; neither
    /// edits a rig or a pose by hand, so every definition the evaluator and the typed origin owner
    /// read is admitted. A figure whose origin does not decode, or that lost its pivot, is refused.
    pub(crate) fn origin_gesture_gate(&self, method: &str) -> Result<(), EditError> {
        if !matches!(method, "beginTween" | "beginDuplicateDrag") { return Ok(()); }
        let objects = self.selection_frame()?;
        let slots = crate::select::resolve_join_selection(&objects, &self.selection.uids, true)
            .map_err(|_| EditError::Unported("an invalid animation-origin hierarchy".into()))?;
        for slot in slots {
            let object = &objects[slot];
            if let Some(figure) = self.figure_of(object).filter(|figure| figure.path(&["_styk", "animationOrigin"]).is_some_and(Value::truthy)) {
                self.origin_figure(&figure)?;
                if !object.get("_stykAnimationOrigin").is_some_and(Value::truthy) {
                    return Err(EditError::Unported("an animation-origin figure without its pivot".into()));
                }
            }
        }
        Ok(())
    }

    /// The Rig tool's recorded 2D lifecycle reuses pose admission
    /// and the topology owner's typed origin validation before starting a gesture.
    pub(crate) fn origin_rig_gate(&self) -> Result<(), EditError> {
        self.origin_rig_pose_gate("beginRigDrag", false)?;
        for object in self.selected_objects()? {
            if let Some(figure) = self.figure_of(&object).filter(|figure| figure.path(&["_styk", "animationOrigin"]).is_some()) {
                self.origin_figure(&figure)?;
            }
        }
        Ok(())
    }

    /// Recorded 2D stretch/follow/world-lock/connector definitions use the same
    /// pose owners; other rig relationships and rig/IK combinations stay refused.
    pub(crate) fn origin_rig_pose_gate(&self, method: &str, saved_channels: bool) -> Result<(), EditError> {
        let objects = self.selection_frame()?;
        let slots = Self::ik_pose_slots(&objects, crate::select::resolve_join_selection(&objects, &self.selection.uids, false)?);
        let has_rig = self.origin_plain_slots_with_rig(&objects, &slots, RigScope::Pose)?;
        if has_rig && slots.iter().any(|&slot| objects[slot].get("_stykIK").and_then(Value::as_obj).is_some_and(|controllers| !controllers.is_empty())) {
            return Err(EditError::Unported("an unrecorded animation-origin rig with IK controllers".into()));
        }
        if !has_rig && saved_channels && matches!(method, "beginFigureHandleDrag" | "transformFigureHandle" | "commitFigureHandleDrag" | "cancelFigureHandleDrag") {
            return Err(EditError::Unported("an unrecorded saved-origin channel figure-handle gesture without a 2D rig".into()));
        }
        Ok(())
    }

    /// The recorded spatial visibility/preset owner has its own narrow admission;
    /// it does not admit other spatial gestures, IK, meshes or saved channels.
    pub(crate) fn origin_choice_gate(&self) -> Result<(), EditError> {
        if self.selection.uids.len() != 1 || self.selection.joint >= 0 ||
            self.selection_metadata.polygon.is_some() || self.selection_metadata.segments.is_some() || self.selection_metadata.branch.is_some() ||
            (!self.sheet() && (self.options.property_channels || self.options.layer_timeline)) ||
            self.report.path(&["_styk", "simpleFrameDraft"]).is_some() ||
            self.report.path(&["_styk", "animation", "channels"]).and_then(Value::array_len).is_some_and(|n| n > 0) ||
            self.report.path(&["_styk", "layerSheet", "legacyAnimation", "channels"]).and_then(Value::array_len).is_some_and(|n| n > 0) {
            return Err(EditError::Unported("an unrecorded origin pose-choice selection or saved channels".into()));
        }
        if self.drag.as_ref().is_some_and(|drag| drag.translation || drag.handle_edit.is_some() || drag.figure_handle.is_some() || drag.segment_value_options.is_some() || drag.camera.is_some() || drag.rig.is_some() || drag.motion_path.is_some()) {
            return Err(EditError::Unported("an origin pose choice during an unrecorded gesture".into()));
        }
        let objects = self.selection_frame()?;
        let slots = crate::select::resolve_join_selection(&objects, &self.selection.uids, true)
            .map_err(|_| EditError::Unported("an invalid origin pose-choice hierarchy".into()))?;
        let selected = self.object()?.and_then(|(_, object)| crate::record::uid(&object));
        for slot in slots {
            let object = &objects[slot];
            if object.get("_stykSpatial").is_some_and(Value::truthy) || object.get("_stykIK").filter(|controllers| controllers.truthy()).is_some_and(|controllers| !controllers.as_obj().is_some_and(|controllers| controllers.is_empty())) {
                return Err(EditError::Unported("an unrecorded projected or IK origin pose choice".into()));
            }
            let Some(figure) = self.figure_of(object) else { return Err(EditError::Unported("an origin pose choice without a figure".into())) };
            if ["spatialMesh", "drawing", "movieclip"].iter().any(|key| figure.path(&["_styk", key]).is_some_and(Value::truthy)) {
                return Err(EditError::Unported("an unrecorded origin pose-choice mesh, drawing or movieclip".into()));
            }
            if selected != crate::record::uid(object) {
                self.origin_plain_slots_in(&objects, &[slot])?;
            } else {
                let segments = crate::topology::validate_definition(&figure)
                    .map_err(|error| EditError::Unported(format!("an invalid origin pose-choice definition: {error}")))?;
                if segments.iter().any(|segment| segment.get("_stykRig").is_some_and(|rig| !rig.as_obj().is_some_and(|rig|
                    !rig.is_empty() && rig.keys().all(|key| key.as_ref() == "spatial") && rig.get("spatial").is_some_and(|spatial|
                        spatial.get("origin").is_some_and(Value::truthy) && spatial.get("bindings").is_none() && spatial.get("motion").is_none())))) {
                    return Err(EditError::Unported("an unrecorded origin pose-choice rig relationship".into()));
                }
                crate::pose_choice::validate_choices(&figure, &segments)
                    .map_err(|error| EditError::Unported(format!("an invalid origin pose-choice schema: {error}")))?;
            }
            if figure.path(&["_styk", "animationOrigin"]).is_some_and(Value::truthy) {
                self.origin_figure(&figure)?;
                if !object.get("_stykAnimationOrigin").is_some_and(Value::truthy) {
                    return Err(EditError::Unported("an unrecorded origin pose choice without a pivot".into()));
                }
            }
        }
        Ok(())
    }

    /// A sparse definition change reuses the selected component, strict typed rig
    /// validation and typed origin owner before its existing history body may commit
    /// a translation. Figure/parent locks do not open the separate posing gate.
    pub(crate) fn origin_constraint_gate(&self, method: &str, args: &[Value]) -> Result<(), EditError> {
        if method == "setRigBehavior" && !args.first().and_then(Value::as_obj).is_some_and(|patch|
            !patch.is_empty() && patch.keys().all(|key| key.as_ref() == "angleLock")) {
            return Err(EditError::Unported("an unrecorded animation-origin rig behavior patch".into()));
        }
        if self.drag.as_ref().is_some_and(|drag| !drag.translation) {
            return Err(EditError::Unported("an animation-origin constraint change during an unrecorded gesture".into()));
        }
        let objects = self.selection_frame()?;
        let slots = crate::select::resolve_join_selection(&objects, &self.selection.uids, true)
            .map_err(|_| EditError::Unported("an invalid animation-origin constraint hierarchy".into()))?;
        self.origin_plain_slots_with_rig(&objects, &slots, RigScope::Angle)?;
        for slot in slots {
            let object = &objects[slot];
            if object.get("_stykIK").and_then(Value::as_obj).is_some_and(|controllers| !controllers.is_empty()) {
                return Err(EditError::Unported("an unrecorded animation-origin constraint with IK controllers".into()));
            }
            if let Some(figure) = self.figure_of(object).filter(|figure| figure.path(&["_styk", "animationOrigin"]).is_some_and(Value::truthy)) {
                self.origin_figure(&figure)?;
                if !object.get("_stykAnimationOrigin").is_some_and(Value::truthy) {
                    return Err(EditError::Unported("an unrecorded animation-origin constraint pose without a pivot".into()));
                }
            }
        }
        Ok(())
    }

    /// The recorded sheet property subset, validated before a property begin
    /// could commit a live gesture. Other targets/properties stay with the editor.
    pub(crate) fn origin_property_gate(&self, method: &str, args: &[Value]) -> Result<(), EditError> {
        let take = |target: Option<&Value>, property: Option<&Value>, tick: Option<&Value>| -> Result<(), EditError> {
            if target.and_then(|target| target.get("kind")).and_then(Value::as_str) != Some("figure") ||
                !property.and_then(Value::as_str).is_some_and(|property| ["x", "y", "scale", "rotation"].contains(&property)) {
                return Err(EditError::Unported("an unrecorded origin property target or property".into()));
            }
            let target = crate::property_edit::normalize_target(target.unwrap()).map_err(|_| EditError::Unported("an unrecorded origin property target".into()))?;
            let uid = num(&target, "uid").unwrap() as u32;
            let fallback = Value::Num(self.tick);
            let at = tick.filter(|tick| !tick.is_null()).unwrap_or(&fallback);
            // Keys use the sheet owner's tick check; a begin reads the current property view.
            let at = if method == "beginAnimationEdit" { at.clone() } else if self.sheet() { Value::Num(crate::property_edit::checked_tick(at)?) } else { at.clone() };
            let frame = self.animation_frame_at(&at)?;
            let mut objects = crate::frame::objects_of(&frame);
            let has_target = |objects: &[Value]| objects.iter().any(|object| crate::record::uid(object) == Some(uid));
            if !has_target(&objects) {
                // Recorded explicit keys past an exposure's end write an empty cell.
                // Admit that no-target path only for a proven ordinary target on show.
                objects = if method == "beginAnimationEdit" { Vec::new() } else { self.selection_frame()? };
                if !has_target(&objects) {
                    return Err(EditError::Unported("an absent origin property target at the edited tick".into()));
                }
            }
            self.origin_plain_targets_in(&objects, &[uid], matches!(property.and_then(Value::as_str), Some("x" | "y")))
        };
        match method {
            "beginAnimationEdit" => take(args.first(), args.get(1), None),
            "addAnimationKey" => take(args.first(), args.get(1), args.get(2)),
            "addAnimationKeys" => {
                if let Some(entries) = args.first().and_then(Value::elements) {
                    for entry in entries.iter() { take(entry.get("target"), entry.get("property"), entry.get("tick"))?; }
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }

    pub(crate) fn origin_plain_targets(&self, uids: &[u32]) -> Result<(), EditError> {
        self.origin_plain_targets_in(&self.selection_frame()?, uids, false)
    }

    fn origin_plain_targets_in(&self, objects: &[Value], uids: &[u32], ancestors: bool) -> Result<(), EditError> {
        let slots = Self::ik_pose_slots(objects, crate::select::resolve_join_selection(objects, uids, ancestors)?);
        self.origin_plain_slots_in(objects, &slots)
    }

    fn origin_plain_slots_in(&self, objects: &[Value], slots: &[usize]) -> Result<(), EditError> {
        self.origin_plain_slots_with_rig(objects, slots, RigScope::Plain).map(|_| ())
    }

    /// Motion edits resolve their component in the remote frame, not the current
    /// selection. The same definition and typed-origin owners validate that view.
    pub(crate) fn origin_motion_gate(&self, objects: &[Value], slots: &[usize]) -> Result<(), EditError> {
        let ids = slots.iter().filter_map(|&slot| uid(&objects[slot])).collect::<Vec<_>>();
        let slots = crate::select::resolve_join_selection(objects, &ids, true)
            .map_err(|_| EditError::Unported("an unrecorded invalid animation-origin motion hierarchy".into()))?;
        self.origin_plain_slots_in(objects, &slots)?;
        for slot in slots {
            if let Some(figure) = self.figure_of(&objects[slot]).filter(|figure| figure.path(&["_styk", "animationOrigin"]).is_some_and(Value::truthy)) {
                self.origin_figure(&figure)?;
            }
        }
        Ok(())
    }

    fn origin_plain_slots_with_rig(&self, objects: &[Value], slots: &[usize], scope: RigScope) -> Result<bool, EditError> {
        let mut has_rig = false;
        let mut validated = std::collections::HashSet::new();
        for &slot in slots {
            let object = &objects[slot];
            let figure = self.report.get("figure_types").and_then(Value::elements).and_then(|figures| figures.iter().find(|figure| num(figure, "figure_type_id") == num(object, "figure_type_id")));
            let mut figure_has_rig = false;
            let complex = figure.as_ref().is_some_and(|figure|
                ["poseChoices", "spatialMesh", "movieclip", "drawing"].iter().any(|key| figure.path(&["_styk", key]).is_some_and(Value::truthy)) ||
                figure.get("segments").and_then(Value::elements).is_some_and(|segments| segments.iter().any(|segment| {
                    let rig = segment.get("_stykRig").filter(|rig| rig.truthy());
                    figure_has_rig |= rig.is_some();
                    has_rig |= rig.is_some();
                    let unrecorded = rig.is_some_and(|rig| scope == RigScope::Plain || !rig.as_obj().is_some_and(|rig| !rig.is_empty() &&
                        rig.keys().all(|key| if scope == RigScope::Angle { key.as_ref() == "angleLock" } else { ["stretch", "follow", "angleLock", "connector"].contains(&key.as_ref()) }) &&
                        rig.get("follow").is_none_or(|follow| follow.get("mode").and_then(Value::as_str) == Some("stretch")) &&
                        rig.get("angleLock").is_none_or(|lock| lock.get("mode").and_then(Value::as_str).is_some_and(|mode| if scope == RigScope::Angle { ["world", "figure", "parent"].contains(&mode) } else { mode == "world" }))));
                    unrecorded || segment.get("_stykPoseChoice").is_some_and(Value::truthy)
                }))) ||
                object.get("_stykSpatial").is_some_and(Value::truthy) ||
                object.get("_stykIK").and_then(Value::as_obj).is_some_and(|controllers| controllers.iter().any(|(_, controller)| controller.get("spatialTarget").is_some_and(Value::truthy)));
            if complex { return Err(EditError::Unported("origin posing with an unrecorded rig, pose choice, 3D, movieclip or drawing definition".into())); }
            if scope != RigScope::Plain && figure_has_rig && let Some(figure) = figure
                && validated.insert(num(&figure, "figure_type_id").unwrap_or(f64::NAN).to_bits())
            {
                styk_eval::rig::validate_2d(&figure).map_err(|error| EditError::Unported(format!("an animation-origin rig unavailable for editing: {error}")))?;
            }
        }
        Ok(has_rig)
    }

    /// Range admission follows the actual planned frame, including attachments and
    /// a join destination. IK combinations stay refused until range recordings prove them.
    pub(crate) fn origin_range_gate(&self, objects: &[Value], uids: &[u32], target: Option<u32>) -> Result<(), EditError> {
        let mut affected = uids.to_vec();
        if let Some(target) = target { affected.push(target); }
        let slots = crate::select::resolve_join_selection(objects, &affected, true)
            .map_err(|_| EditError::Unported("an unrecorded invalid animation-origin range hierarchy".into()))?;
        self.origin_plain_slots_in(objects, &slots)?;
        for slot in slots {
            let object = &objects[slot];
            if object.get("_stykIK").and_then(Value::as_obj).is_some_and(|controllers| !controllers.is_empty()) {
                return Err(EditError::Unported("an unrecorded animation-origin range with IK controllers".into()));
            }
            if let Some(figure) = self.figure_of(object).filter(|figure| figure.path(&["_styk", "animationOrigin"]).is_some_and(Value::truthy)) {
                self.origin_figure(&figure)?;
            }
        }
        Ok(())
    }

    /// Decode the existing typed origin descriptor before a command can commit or
    /// index its raw support. The loader's figure cache remains the single owner.
    pub(crate) fn origin_figure(&self, figure: &Value) -> Result<Arc<styk_eval::doc::Figure>, EditError> {
        let mut definition = Obj::new();
        definition.set("version", self.report.get("version").cloned().unwrap_or(Value::Num(5.0)));
        definition.set("figure_types", Value::array(vec![figure.clone()]));
        let doc = self.eval.borrow_mut().loader.document(&Value::object(definition), "").map_err(|e| EditError::Invalid(e.to_string()))?;
        doc.figures.first().filter(|f| f.origin.is_some()).cloned()
            .ok_or_else(|| EditError::Unported("a malformed animation origin".into()))
    }

    /// Decode only an origin-bearing pose, reusing the typed loader's figure cache.
    /// A tiny definition view avoids converting the whole document on a translation.
    pub(crate) fn origin_view(&self, figure: &Value, object: &Value) -> Result<(Arc<styk_eval::doc::Figure>, Arc<styk_eval::doc::Object>), EditError> {
        let figure = self.origin_figure(figure)?;
        let mut frame = Obj::new(); frame.set("objects", Value::array(vec![object.clone()]));
        let pose = self.eval.borrow_mut().loader.keyframe(&Value::object(frame)).map_err(|e| EditError::Invalid(e.to_string()))?.objects.into_iter().next()
            .filter(|pose| pose.figure == figure.id)
            .ok_or_else(|| EditError::Unported("an animation origin pose without an identity or figure".into()))?;
        Ok((figure, pose))
    }

    pub(crate) fn origin_rotation(&self, figure: &Value, object: &Value) -> Result<f64, EditError> {
        if !figure.path(&["_styk", "animationOrigin"]).is_some_and(Value::truthy) || !object.get("_stykAnimationOrigin").is_some_and(Value::truthy) { return Ok(0.0); }
        let (figure, pose) = self.origin_view(figure, object)?;
        Ok(styk_eval::origin::rotation(&figure, &pose))
    }

    pub(crate) fn reflect_origin_offset(&self, figure: &Value, object: &mut Obj, horizontal: bool, previous: f64) -> Result<(), EditError> {
        let Some(origin) = object.get("_stykAnimationOrigin").and_then(Value::as_obj) else { return Ok(()) };
        if !figure.path(&["_styk", "animationOrigin"]).is_some_and(Value::truthy) { return Ok(()); }
        let (x, y) = (origin.get("offsetX").and_then(Value::as_f64).unwrap_or(0.0), origin.get("offsetY").and_then(Value::as_f64).unwrap_or(0.0));
        if x == 0.0 && y == 0.0 { return Ok(()); }
        let (c, s) = (styk_math::cos(previous), styk_math::sin(previous));
        let world_x = (if horizontal { -1.0 } else { 1.0 }) * (x * c - y * s);
        let world_y = (if horizontal { 1.0 } else { -1.0 }) * (x * s + y * c);
        let turn = self.origin_rotation(figure, &Value::object(object.clone()))?;
        let (c, s) = (styk_math::cos(turn), styk_math::sin(turn));
        let mut origin = origin.clone();
        origin.set("offsetX", Value::Num(world_x * c + world_y * s));
        origin.set("offsetY", Value::Num(-world_x * s + world_y * c));
        object.set("_stykAnimationOrigin", Value::object(origin)); Ok(())
    }

    pub(crate) fn mirror_origin_support(&self, figure: &Value, source: &Value, object: &mut Obj, horizontal: bool) -> Result<(), EditError> {
        let previous = self.origin_rotation(figure, source)?;
        mirror_support(figure, object, horizontal);
        self.reflect_origin_offset(figure, object, horizontal, previous)
    }

    /// `touch` and both commit paths synchronize only the gesture's captured poses.
    /// Pointer return preserves the exact original pivot metadata instead of rounding it again.
    pub(crate) fn synchronize_origins(&mut self, before: &[Value]) -> Result<(), EditError> {
        for (slot, updated) in self.origin_updates(&self.frame_objects(), before, false, &[])? {
            self.frame_object_mut(slot).unwrap().set("_stykAnimationOrigin", updated);
        }
        Ok(())
    }

    /// The same synchronization owner for independently planned range frames.
    pub(crate) fn synchronize_origin_frame(&self, frame: &mut Value, before: &[Value], include_new: bool) -> Result<(), EditError> {
        self.synchronize_origin_frame_with(frame, before, include_new, &[])
    }

    /// The same, with the definitions an insertion is about to add (the document does not hold them yet).
    pub(crate) fn synchronize_origin_frame_with(&self, frame: &mut Value, before: &[Value], include_new: bool, added: &[Value]) -> Result<(), EditError> {
        let updates = self.origin_updates(&crate::frame::objects_of(frame), before, include_new, added)?;
        if !updates.is_empty() {
            let objects = frame.make_obj().and_then(|frame| frame.get_mut("objects")).and_then(Value::make_arr)
                .ok_or_else(|| EditError::Invalid("an origin frame without objects".into()))?;
            for (slot, updated) in updates { objects[slot].make_obj().unwrap().set("_stykAnimationOrigin", updated); }
        }
        Ok(())
    }

    fn origin_updates(&self, objects: &[Value], before: &[Value], include_new: bool, added: &[Value]) -> Result<Vec<(usize, Value)>, EditError> {
        let figures: HashMap<u32, Value> = self.report.get("figure_types").and_then(Value::elements).map(|items| items.iter().chain(added.iter().cloned()).collect::<Vec<_>>()).unwrap_or_default().into_iter()
            .filter(|figure| figure.path(&["_styk", "animationOrigin"]).is_some_and(Value::truthy))
            .filter_map(|figure| Some((num(&figure, "figure_type_id")? as u32, figure))).collect();
        if figures.is_empty() { return Ok(Vec::new()); }
        let mut updates = Vec::new();
        let previous: HashMap<u32, &Value> = before.iter().filter_map(|object| Some((uid(object)?, object))).collect();
        for (slot, object) in objects.iter().enumerate() {
            let Some(figure) = num(object, "figure_type_id").and_then(|id| figures.get(&(id as u32))) else { continue };
            let Some(origin) = object.get("_stykAnimationOrigin").and_then(Value::as_obj) else { continue };
            let old = uid(object).and_then(|id| previous.get(&id)).copied();
            if !before.is_empty() && old.is_none() && !include_new { continue; }
            let updated = if let Some(old) = old.filter(|old| same_pose(old, object)) {
                if ["x", "y", "offsetX", "offsetY"].iter().all(|field| old.path(&["_stykAnimationOrigin", field]) == origin.get(field)) { continue; }
                let Some(origin) = old.get("_stykAnimationOrigin").cloned() else { continue }; origin
            } else {
                let (typed, pose) = self.origin_view(figure, object)?;
                let offset = styk_eval::origin::offset(&typed, &pose);
                let mut origin = origin.clone();
                origin.set("x", Value::Num(num(object, "root_x").unwrap_or(f64::NAN) + offset[0]));
                origin.set("y", Value::Num(num(object, "root_y").unwrap_or(f64::NAN) + offset[1]));
                Value::object(origin)
            };
            updates.push((slot, updated));
        }
        Ok(updates)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_bytes(name: &str) -> Vec<u8> {
        std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit").join(name)).unwrap()
    }

    #[test]
    fn unrecorded_rig_relationships_and_ik_refuse_before_committing_a_drag() {
        let bytes = fixture_bytes("origin-rig-pose-support-sheet.document.json");
        let mut refused = 0;
        for feature in ["spatial", "weighted", "anglePath", "futureRelationship", "follow-mode", "angle-lock-mode", "ik"] {
            let mut editor = Editor::new(styk_doc::json::parse(&bytes).unwrap(), crate::Options { property_channels: true, layer_timeline: true, auto_key: false });
            editor.call("select", &[Value::Num(1.0), Value::Num(2.0)]).unwrap();
            editor.call("beginTranslationDrag", &[]).unwrap();
            editor.call("moveSelection", &[Value::Num(5.125), Value::Num(-2.75)]).unwrap();
            let figure = editor.report.make_obj().unwrap().get_mut("figure_types").unwrap().make_arr().unwrap()[0].make_obj().unwrap();
            let segments = figure.get_mut("segments").unwrap().make_arr().unwrap();
            match feature {
                "ik" => {
                    let mut controllers = Obj::new();controllers.set("66", Value::object(Obj::new()));
                    editor.authored.as_mut().unwrap().frame.make_obj().unwrap().get_mut("objects").unwrap().make_arr().unwrap()[0].make_obj().unwrap().set("_stykIK", Value::object(controllers));
                }
                "follow-mode" | "angle-lock-mode" => {
                    let field = if feature == "follow-mode" { "follow" } else { "angleLock" };
                    let rig = segments.iter_mut().find_map(|segment| segment.make_obj()?.get_mut("_stykRig")?.make_obj().filter(|rig| rig.get(field).is_some())).unwrap();
                    rig.get_mut(field).unwrap().make_obj().unwrap().set("mode", Value::str("unrecorded"));
                }
                _ => {
                    let rig = segments.iter_mut().find_map(|segment| segment.make_obj()?.get_mut("_stykRig")?.make_obj()).unwrap();
                    rig.set(feature, Value::Bool(true));
                }
            }
            editor.take_events();
            let snapshot = |editor: &Editor| (editor.report_json(), editor.state(), editor.drag_value(), styk_doc::json::to_string(&styk_eval::records::snapshot_pose_frame(&editor.shown_frame().unwrap())));
            let before = snapshot(&editor);
            for (method, args) in [("poseJoint", vec![Value::Num(400.25), Value::Num(200.125)]), ("rotateJoint", vec![Value::Num(0.17)]), ("bendJoint", vec![Value::Num(400.25), Value::Num(200.125)]),
                ("beginFigureHandleDrag", vec![]), ("transformFigureHandle", vec![Value::Num(400.25), Value::Num(200.125)]), ("commitFigureHandleDrag", vec![]), ("cancelFigureHandleDrag", vec![]),
                ("beginRigDrag", vec![]), ("editRigJoint", vec![Value::Num(400.25), Value::Num(200.125)]), ("commitRigDrag", vec![]), ("cancelRigDrag", vec![]), ("slideConnector", vec![Value::Num(400.25), Value::Num(200.125)]), ("setConnectorPosition", vec![Value::Num(0.65)])] {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| editor.call(method, &args)));
                assert!(matches!(result, Ok(Err(EditError::Unported(_)))), "{feature} {method}: {result:?}");
                assert_eq!(snapshot(&editor), before, "{feature} {method} changed the live drag");assert!(editor.take_events().is_empty());refused += 1;
            }
        }
        assert_eq!(refused, 91);
    }

    #[test]
    fn origin_rig_range_join_and_property_admission_is_unchanged() {
        let bytes = fixture_bytes("origin-rig-pose-support-sheet.document.json");
        let mut editor = Editor::new(styk_doc::json::parse(&bytes).unwrap(), crate::Options { property_channels: true, layer_timeline: true, auto_key: false });
        editor.call("select", &[Value::Num(1.0), Value::Num(-1.0)]).unwrap();editor.call("beginTranslationDrag", &[]).unwrap();editor.call("moveSelection", &[Value::Num(5.125), Value::Num(-2.75)]).unwrap();editor.take_events();
        let snapshot = |editor: &Editor| (editor.report_json(), editor.state(), editor.drag_value(), styk_doc::json::to_string(&styk_eval::records::snapshot_pose_frame(&editor.shown_frame().unwrap())));
        let before = snapshot(&editor);
        let mut target = Obj::new();target.set("kind", Value::str("figure"));target.set("uid", Value::Num(1.0));
        for (method, args) in [("rotateFiguresInFrames", vec![Value::Num(0.17)]), ("joinTo", vec![Value::Num(2.0), Value::Num(22.0)]), ("beginAnimationEdit", vec![Value::object(target), Value::str("rotation")])] {
            assert!(matches!(editor.call(method, &args), Err(EditError::Unported(_))), "{method}");
            assert_eq!(snapshot(&editor), before, "{method} changed the live drag");assert!(editor.take_events().is_empty());
        }
    }

    #[test]
    fn ordinary_rig_gate_refuses_complex_or_malformed_origins_without_committing_a_drag() {
        let bytes = fixture_bytes("origin-rig-support-sheet.document.json");
        let mut refused = 0;
        for feature in ["rig", "pose-choice", "mesh", "movieclip", "drawing", "spatial", "invalid-origin"] {
            let report = styk_doc::json::parse(&bytes).unwrap();
            let mut editor = Editor::new(report, crate::Options { property_channels: true, layer_timeline: true, auto_key: false });
            editor.call("select", &[Value::Num(1.0), Value::Num(3.0)]).unwrap();
            editor.call("beginTranslationDrag", &[]).unwrap();
            editor.call("moveSelection", &[Value::Num(5.125), Value::Num(-2.75)]).unwrap();
            let figure = editor.report.make_obj().unwrap().get_mut("figure_types").unwrap().make_arr().unwrap()[0].make_obj().unwrap();
            match feature {
                "rig" | "pose-choice" => {
                    let segment = figure.get_mut("segments").unwrap().make_arr().unwrap()[0].make_obj().unwrap();
                    segment.set(if feature == "rig" { "_stykRig" } else { "_stykPoseChoice" }, Value::Bool(true));
                }
                "spatial" => {
                    editor.authored.as_mut().unwrap().frame.make_obj().unwrap().get_mut("objects").unwrap().make_arr().unwrap()[0].make_obj().unwrap().set("_stykSpatial", Value::Bool(true));
                }
                "invalid-origin" => {
                    figure.get_mut("_styk").unwrap().make_obj().unwrap().get_mut("animationOrigin").unwrap().make_obj().unwrap().get_mut("support").unwrap().make_obj().unwrap().set("rotation", Value::Num(100_001.0));
                }
                _ => { figure.get_mut("_styk").unwrap().make_obj().unwrap().set(match feature { "mesh" => "spatialMesh", other => other }, Value::Bool(true)); }
            }
            editor.take_events();
            let snapshot = |editor: &Editor| (editor.report_json(), editor.state(), editor.drag_value(), styk_doc::json::to_string(&styk_eval::records::snapshot_pose_frame(&editor.shown_frame().unwrap())));
            let before = snapshot(&editor);
            for (method, args) in [("beginRigDrag", vec![]), ("editRigJoint", vec![Value::Num(400.25), Value::Num(200.125)]), ("commitRigDrag", vec![]), ("cancelRigDrag", vec![])] {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| editor.call(method, &args)));
                assert!(matches!(result, Ok(Err(EditError::Unported(_)))), "{feature} {method}: {result:?}");
                assert_eq!(snapshot(&editor), before, "{feature} {method} committed or changed the live drag");
                assert!(editor.take_events().is_empty());
                refused += 1;
            }
        }
        assert_eq!(refused, 28);
    }

    #[test]
    fn future_or_absent_property_refusal_preserves_the_shown_frame() {
        let fixtures = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
        let plain = std::fs::read(fixtures.join("origin-future-rig-sheet.document.json")).unwrap();
        let joined = std::fs::read(fixtures.join("origin-future-rig-joined-sheet.document.json")).unwrap();
        let changing = std::fs::read(fixtures.join("origin-changing-rig-sheet.document.json")).unwrap();
        for (document, id, property, begin) in [(plain.as_slice(), 3.0, "rotation", true), (plain.as_slice(), 77.0, "rotation", true), (joined.as_slice(), 2.0, "x", false), (changing.as_slice(), 3.0, "rotation", false)] {
            let report = styk_doc::json::parse(document).unwrap();
            let mut editor = Editor::new(report, crate::Options { property_channels: true, layer_timeline: true, auto_key: false });
            editor.call("select", &[Value::Num(1.0), Value::Num(-1.0)]).unwrap();
            editor.call("beginTranslationDrag", &[]).unwrap();
            editor.call("moveSelection", &[Value::Num(7.25), Value::Num(-3.5)]).unwrap();
            editor.take_events();
            let snapshot = |editor: &Editor| (editor.report_json(), editor.state(), editor.drag_value(), styk_doc::json::to_string(&styk_eval::records::snapshot_pose_frame(&editor.shown_frame().unwrap())));
            let before = snapshot(&editor);
            let mut target = Obj::new();target.set("kind", Value::str("figure"));target.set("uid", Value::Num(id));let target = Value::object(target);
            let mut entry = Obj::new();entry.set("target", target.clone());entry.set("property", Value::str(property));entry.set("tick", Value::Num(8.0));entry.set("value", Value::Num(0.47));
            let mut calls = vec![("addAnimationKey", vec![target.clone(), Value::str(property), Value::Num(8.0), Value::Num(0.47)]), ("addAnimationKeys", vec![Value::array(vec![Value::object(entry)])])];
            if begin { calls.push(("beginAnimationEdit", vec![target, Value::str(property)])); }
            for (method, args) in calls {
                assert!(matches!(editor.call(method, &args), Err(EditError::Unported(_))), "{id} {property} {method}");
                assert_eq!(snapshot(&editor), before, "{id} {property} {method} changed the shown frame or editor on refusal");
                assert!(editor.take_events().is_empty(), "{id} {property} {method} emitted on refusal");
            }
        }
    }

    #[test]
    fn future_complex_range_refusal_preserves_the_shown_frame() {
        for (document, id) in [(fixture_bytes("origin-future-rig-sheet.document.json"), 3.0), (fixture_bytes("origin-future-rig-joined-sheet.document.json"), 2.0), (fixture_bytes("origin-changing-rig-sheet.document.json"), 3.0)] {
            let mut editor = Editor::new(styk_doc::json::parse(&document).unwrap(), crate::Options { property_channels: true, layer_timeline: true, auto_key: false });
            editor.call("select", &[Value::Num(1.0), Value::Num(-1.0)]).unwrap();editor.call("beginTranslationDrag", &[]).unwrap();editor.call("moveSelection", &[Value::Num(7.25), Value::Num(-3.5)]).unwrap();editor.take_events();
            let snapshot = |editor: &Editor| (editor.report_json(), editor.state(), editor.drag_value(), styk_doc::json::to_string(&styk_eval::records::snapshot_pose_frame(&editor.shown_frame().unwrap())));
            let before = snapshot(&editor);
            let mut options = Obj::new();options.set("uids", Value::array(vec![Value::Num(id)]));options.set("ticks", Value::array(vec![Value::Num(8.0)]));
            assert!(matches!(editor.call("rotateFiguresInFrames", &[Value::Num(0.27), Value::Null, Value::object(options)]), Err(EditError::Unported(_))));
            assert_eq!(snapshot(&editor), before);assert!(editor.take_events().is_empty());
            let mut indices = Obj::new();indices.set("@array", Value::array(vec![Value::Num(1.0)]));indices.set("sheetTicks", Value::array(vec![Value::Num(8.0)]));
            assert!(matches!(editor.call("joinFiguresInFrames", &[Value::Num(id), Value::Num(22.0), Value::object(indices)]), Err(EditError::Unported(_))));
            assert_eq!(snapshot(&editor), before);assert!(editor.take_events().is_empty());
        }
    }

    #[test]
    fn invalid_future_range_join_guard_is_atomic_and_never_panics() {
        use std::panic::{catch_unwind, AssertUnwindSafe};
        for cyclic in [true, false] {
            let mut report = styk_doc::json::parse(&fixture_bytes("origin-future-rig-joined-sheet.document.json")).unwrap();
            let invalidate = |frame: &mut Value| {
                let objects = frame.make_obj().unwrap().get_mut("objects").unwrap().make_arr().unwrap();
                let Some(slot) = objects.iter().position(|object| uid(object) == Some(3)) else { return };
                let parent = objects.iter().position(|object| uid(object) == Some(2)).unwrap();
                let mut join = Obj::new();join.set("target_object_slot", Value::Num(if cyclic { parent as f64 } else { 999.0 }));join.set("target_unique_id", Value::Num(2.0));join.set("target_handle_id", Value::Num(22.0));
                objects[slot].make_obj().unwrap().set("join", Value::object(join));
            };
            for frame in report.make_obj().unwrap().get_mut("keyframes").unwrap().make_arr().unwrap() { invalidate(frame); }
            let sources = report.make_obj().unwrap().get_mut("_styk").unwrap().make_obj().unwrap().get_mut("frameSources").unwrap().make_obj().unwrap();
            let names: Vec<_> = sources.keys().map(|key| key.to_string()).collect();for name in names { invalidate(sources.get_mut(&name).unwrap()); }
            let mut editor = Editor::new(report, crate::Options { property_channels: true, layer_timeline: true, auto_key: false });
            editor.call("select", &[Value::Num(1.0), Value::Num(-1.0)]).unwrap();editor.call("beginTranslationDrag", &[]).unwrap();editor.call("moveSelection", &[Value::Num(7.25), Value::Num(-3.5)]).unwrap();editor.take_events();
            let snapshot = |editor: &Editor| (editor.report_json(), editor.state(), editor.drag_value(), styk_doc::json::to_string(&styk_eval::records::snapshot_pose_frame(&editor.shown_frame().unwrap())));
            let before = snapshot(&editor);
            let mut indices = Obj::new();indices.set("@array", Value::array(vec![Value::Num(1.0)]));indices.set("sheetTicks", Value::array(vec![Value::Num(8.0)]));
            let result = catch_unwind(AssertUnwindSafe(|| editor.call("rotateFiguresInFrames", &[Value::Num(0.27), Value::object(indices)])));
            assert!(matches!(result, Ok(Err(EditError::Unported(_)))), "invalid future range join was not atomically refused");
            assert_eq!(snapshot(&editor), before, "invalid future range join changed the shown frame or editor");
            assert!(editor.take_events().is_empty());
        }
    }

    #[test]
    fn invalid_future_join_guard_is_atomic_and_never_panics() {
        use std::panic::{catch_unwind, AssertUnwindSafe};
        for cyclic in [true, false] {
            let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/origin-future-rig-joined-sheet.document.json");
            let mut report = styk_doc::json::parse(&std::fs::read(file).unwrap()).unwrap();
            let invalidate = |frame: &mut Value| {
                let objects = frame.make_obj().unwrap().get_mut("objects").unwrap().make_arr().unwrap();
                let Some(slot) = objects.iter().position(|object| uid(object) == Some(3)) else { return };
                let parent = objects.iter().position(|object| uid(object) == Some(2)).unwrap();
                let mut join = Obj::new();join.set("target_object_slot", Value::Num(if cyclic { parent as f64 } else { 999.0 }));join.set("target_unique_id", Value::Num(2.0));join.set("target_handle_id", Value::Num(22.0));
                objects[slot].make_obj().unwrap().set("join", Value::object(join));
            };
            for frame in report.make_obj().unwrap().get_mut("keyframes").unwrap().make_arr().unwrap() { invalidate(frame); }
            let sources = report.make_obj().unwrap().get_mut("_styk").unwrap().make_obj().unwrap().get_mut("frameSources").unwrap().make_obj().unwrap();
            let names: Vec<_> = sources.keys().map(|key| key.to_string()).collect();for name in names { invalidate(sources.get_mut(&name).unwrap()); }
            let mut editor = Editor::new(report, crate::Options { property_channels: true, layer_timeline: true, auto_key: false });
            editor.call("select", &[Value::Num(1.0), Value::Num(-1.0)]).unwrap();editor.call("beginTranslationDrag", &[]).unwrap();editor.call("moveSelection", &[Value::Num(7.25), Value::Num(-3.5)]).unwrap();editor.take_events();
            let snapshot = |editor: &Editor| (editor.report_json(), editor.state(), editor.drag_value(), styk_doc::json::to_string(&styk_eval::records::snapshot_pose_frame(&editor.shown_frame().unwrap())));
            let before = snapshot(&editor);
            let mut target = Obj::new();target.set("kind", Value::str("figure"));target.set("uid", Value::Num(2.0));let target = Value::object(target);
            let mut entry = Obj::new();entry.set("target", target.clone());entry.set("property", Value::str("x"));entry.set("tick", Value::Num(8.0));entry.set("value", Value::Num(410.75));
            for (method, args) in [("addAnimationKey", vec![target, Value::str("x"), Value::Num(8.0), Value::Num(410.75)]), ("addAnimationKeys", vec![Value::array(vec![Value::object(entry)])])] {
                let result = catch_unwind(AssertUnwindSafe(|| editor.call(method, &args))).expect("invalid future join guard panicked");
                assert!(matches!(result, Err(EditError::Unported(_) | EditError::Invalid(_))), "{cyclic} {method} admitted an invalid future join");
                assert_eq!(snapshot(&editor), before, "{cyclic} {method} changed the shown frame or editor on refusal");assert!(editor.take_events().is_empty());
            }
        }
    }

}

#[cfg(test)]
#[path = "origin_rig_validation_tests.rs"]
mod validation_tests;

#[cfg(test)]
#[path = "origin_angle_tests.rs"]
mod angle_tests;

#[cfg(test)]
#[path = "origin_pose_choice_tests.rs"]
mod choice_tests;
