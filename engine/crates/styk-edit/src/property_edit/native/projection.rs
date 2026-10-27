//! `projectNativePropertyChannel`: worker-only materialization through the same
//! native pose marker/source and typed Records property/composition owners.
use super::{channel_id, easing, items, native_channel_header, normalize_target, own_channel};
use crate::{EditError, Editor};
use styk_doc::{Obj, Value};

impl Editor {
    /// Read-only projection. The caller owns worker readiness and forwards its
    /// existing cancellation check; no draft/cache/index/callback state is kept.
    pub(crate) fn native_property_channel_checked(
        &self,
        target: &Value,
        property: &str,
        check: &mut dyn FnMut() -> Result<(), EditError>,
    ) -> Result<Value, EditError> {
        check()?;
        if self.sheet()
            || target.get("kind").and_then(Value::as_str) != Some("figure")
            || !["x", "y", "scale", "rotation"].contains(&property)
        {
            return Err(EditError::Unported(
                "unrecorded native property projection target".into(),
            ));
        }
        let target = normalize_target(target)?;
        let id = channel_id(&target, property)?;
        if let Some(channel) = own_channel(self, &id) {
            return Ok(channel);
        }
        // Layer-pose inheritance is a separately recorded owner boundary.
        if items(self.report.path(&["_styk", "animation", "channels"]))
            .iter()
            .any(|channel| {
                channel.path(&["target", "kind"]).and_then(Value::as_str) == Some("layer")
                    && channel.get("property").and_then(Value::as_str) == Some("pose")
                    && channel.get("keys").and_then(Value::array_len).unwrap_or(0) > 0
            })
        {
            return Err(EditError::Unported(
                "native scalar projection from an inherited layer pose".into(),
            ));
        }
        let uid = target.get("uid").and_then(Value::as_f64).unwrap() as u32;
        let pose = self.native_baseline_pose_checked(uid, check)?;
        let native = pose.get("source").and_then(Value::as_str) == Some("native");
        let raw_frames = if native {
            items(self.report.get("keyframes"))
        } else {
            Vec::new()
        };
        let dependency = items(self.report.path(&["_styk", "animation", "channels"]))
            .iter()
            .any(|channel| {
                channel.get("property").and_then(Value::as_str) == Some(property)
                    && channel.path(&["target", "kind"]).and_then(Value::as_str) == Some("figure")
                    && (["x", "y"].contains(&property)
                        || channel.path(&["target", "uid"]) == target.get("uid"))
            });
        self.with_records(|records| {
            let mut keys = Vec::new();
            let mut cursor = 0;
            for key in items(pose.get("keys")) {
                check()?;
                if key.get("hidden").is_some_and(Value::truthy) {
                    continue;
                }
                let Some(source_id) = key.path(&["value", "frameId"]).and_then(Value::as_str)
                else {
                    continue;
                };
                let hint = if native {
                    while cursor < raw_frames.len()
                        && raw_frames[cursor]
                            .path(&["_styk", "frameId"])
                            .and_then(Value::as_str)
                            != Some(source_id)
                    {
                        check()?;
                        cursor += 1;
                    }
                    (cursor < raw_frames.len()).then(|| {
                        let index = cursor;
                        cursor += 1;
                        index
                    })
                } else {
                    None
                };
                let Some(source) = records.pose_source_frame(source_id, hint) else {
                    continue;
                };
                let Some(base) = records.property_value(&source, &target, property)? else {
                    continue;
                };
                let object = items(source.get("objects"))
                    .into_iter()
                    .find(|object| object.get("unique_id") == target.get("uid"));
                let needs_rig = ["x", "y", "rotation"].contains(&property)
                    && object.as_ref().is_some_and(|object| {
                        object.get("join").is_some_and(Value::truthy)
                            || object.get("_stykIK").is_some_and(Value::truthy)
                    });
                let tick = key
                    .get("tick")
                    .and_then(Value::as_f64)
                    .ok_or_else(|| EditError::Unported("a native marker without a tick".into()))?;
                let value = if needs_rig || dependency {
                    check()?;
                    let frame = records.evaluated_editor_with(tick, true)?;
                    records
                        .property_value(&frame, &target, property)?
                        .unwrap_or(Value::Null)
                } else {
                    base
                };
                let curve = key.get("interpolation").is_none()
                    && self.report.get("auto_easing").is_some_and(Value::truthy);
                let mut timing = key.as_obj().cloned().unwrap();
                timing.set(
                    "interpolation",
                    Value::str(if curve {
                        "linear"
                    } else {
                        key.get("interpolation")
                            .and_then(Value::as_str)
                            .unwrap_or("linear")
                    }),
                );
                let (interpolation, bezier) = easing(&Value::object(timing))?;
                let mut out = Obj::new();
                let marker_id = key.get("id").and_then(Value::as_str).ok_or_else(|| {
                    EditError::Unported("a native marker without an identity".into())
                })?;
                out.set("id", Value::str(&format!("native:{id}:{marker_id}")));
                out.set("tick", Value::Num(tick));
                out.set("value", value);
                out.set("interpolation", Value::str(&interpolation));
                if let Some(bezier) = bezier {
                    out.set("bezier", bezier);
                }
                if curve {
                    out.set("nativeCurve", Value::str("pchip"));
                }
                if property == "rotation" {
                    out.set("nativeRotation", Value::Bool(true));
                }
                // Map.set(tick,key) replaces at the original position.
                let value = Value::object(out);
                if let Some(index) = keys
                    .iter()
                    .position(|prior: &Value| prior.get("tick") == value.get("tick"))
                {
                    keys[index] = value;
                } else {
                    keys.push(value);
                }
            }
            check()?;
            let mut channel = Obj::new();
            channel.set("id", Value::str(&id));
            channel.set("target", target);
            channel.set("property", Value::str(property));
            channel.set("keys", Value::array(keys));
            Ok(Value::object(channel))
        })
    }
    /// Recorded worker-only ordinary native live families; no class/UI gate.
    pub(crate) fn native_projected_call(&self, method: &str, args: &[Value]) -> bool {
        if !self.options.property_channels
            || self.options.layer_timeline
            || self.sheet()
            || self.selection_metadata.polygon.is_some()
            || self.selection_metadata.segments.is_some()
            || self.selection_metadata.branch.is_some()
            || self.tick.fract() != 0.0
            || self.selection.uids.len() > 1
            || self.selection.joint >= 0
            || self.native_token.is_some()
            || ![
                "select",
                "@select",
                "beginDrag",
                "moveSelection",
                "commitDrag",
                "cancelDrag",
                "beginAnimationEdit",
                "previewAnimationEdit",
                "commitAnimationEdit",
                "cancelAnimationEdit",
                "seek",
                "@seek",
                "undo",
                "redo",
            ]
            .contains(&method)
        {
            return false;
        }
        if self.property_edit.is_some()
            && [
                "select",
                "@select",
                "beginDrag",
                "moveSelection",
                "commitDrag",
                "cancelDrag",
                "undo",
                "redo",
            ]
            .contains(&method)
        {
            return false;
        }
        if self.drag.is_some()
            && [
                "select",
                "@select",
                "beginDrag",
                "beginAnimationEdit",
                "seek",
                "@seek",
                "undo",
                "redo",
                "commitAnimationEdit",
                "cancelAnimationEdit",
            ]
            .contains(&method)
        {
            return false;
        }
        if self.drag.as_ref().is_some_and(|drag| {
            !drag.authored
                || drag.camera.is_some()
                || drag.rig.is_some()
                || drag.motion_path.is_some()
                || drag.figure_handle.is_some()
                || drag.handle_edit.is_some()
        }) || self
            .property_edit
            .as_ref()
            .is_some_and(|edit| edit.native.is_none())
        {
            return false;
        }
        let empty_options = |value: &Value| value.as_obj().is_some_and(|object| object.is_empty());
        if ["select", "@select"].contains(&method) {
            if args
                .get(1)
                .is_some_and(|joint| joint.as_f64() != Some(-1.0))
                || args.get(2).is_some_and(|options| !empty_options(options))
            {
                return false;
            }
        }
        if method == "beginAnimationEdit" {
            let Some(target) = args.first() else {
                return false;
            };
            if target.get("kind").and_then(Value::as_str) != Some("figure")
                || target.as_obj().is_none_or(|object| {
                    object
                        .iter()
                        .any(|(field, _)| !["kind", "uid"].contains(&field.as_ref()))
                })
                || !args
                    .get(1)
                    .and_then(Value::as_str)
                    .is_some_and(|property| ["x", "y"].contains(&property))
                || args.get(2).is_some_and(|options| !empty_options(options))
            {
                return false;
            }
        }
        if ["seek", "@seek"].contains(&method)
            && !args
                .first()
                .and_then(Value::as_f64)
                .is_some_and(|tick| tick.is_finite() && tick.fract() == 0.0)
        {
            return false;
        }
        if ["beginDrag", "moveSelection"].contains(&method) && self.tick.fract() != 0.0 {
            return false;
        }
        if method == "beginDrag" && args.first().is_some_and(|label| label.as_str().is_none()) {
            return false;
        }
        if method == "moveSelection" && args.get(2).is_some_and(|options| !empty_options(options)) {
            return false;
        }
        if method == "beginDrag" && args.get(1).is_some_and(|options| !empty_options(options)) {
            return false;
        }
        true
    }

    pub(crate) fn native_projected_gate(
        &self,
        method: &str,
        args: &[Value],
        check: &mut dyn FnMut() -> Result<(), EditError>,
    ) -> Result<(), EditError> {
        if !self.native_projected_call(method, args) {
            return Err(EditError::Unported(
                "unrecorded worker native projected lifecycle".into(),
            ));
        }
        if self.report.path(&["_styk", "movieclipSource"]).is_some()
            || self.report.path(&["_styk", "simpleFrameDraft"]).is_some()
        {
            return Err(EditError::Unported(
                "a native projected lifecycle inside a retained or saved draft".into(),
            ));
        }
        if self
            .report
            .get("_styk")
            .is_some_and(|metadata| !metadata.is_object())
            || self
                .report
                .path(&["_styk", "animation"])
                .is_some_and(|animation| {
                    !animation.is_null()
                        && (!animation.is_object()
                            || animation.get("channels").is_some_and(|channels| {
                                !channels.is_null() && !channels.is_array()
                            }))
                })
            || self
                .report
                .path(&["_styk", "frameSources"])
                .is_some_and(|sources| !sources.is_object())
        {
            return Err(EditError::Unported(
                "malformed native projected owner headers".into(),
            ));
        }
        if ["vfxClips", "cameraMotion"]
            .iter()
            .any(|field| self.report.path(&["_styk", field]).is_some())
        {
            return Err(EditError::Unported(
                "an unrecorded native projected effect or camera-motion document".into(),
            ));
        }
        // The worker-only slice excludes wider definitions and future/retained
        // pose dependencies before committing any existing live draft. The
        // existing typed Records compiler retains all numeric/schema checks.
        for figure in items(self.report.get("figure_types")) {
            check()?;
            if [
                "animationOrigin",
                "poseChoices",
                "spatialMesh",
                "movieclip",
                "drawing",
            ]
            .iter()
            .any(|field| figure.path(&["_styk", field]).is_some_and(Value::truthy))
                || items(figure.get("segments")).iter().any(|segment| {
                    segment.get("_stykRig").is_some_and(Value::truthy)
                        || segment.get("_stykPoseChoice").is_some_and(Value::truthy)
                })
            {
                return Err(EditError::Unported(
                    "a complex native projected definition".into(),
                ));
            }
        }
        let frames = items(self.report.get("keyframes"));
        let retained = self
            .report
            .path(&["_styk", "frameSources"])
            .and_then(Value::as_obj)
            .map(|sources| {
                sources
                    .iter()
                    .map(|(_, frame)| frame.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let mut native_ids = std::collections::HashSet::new();
        for frame in &frames {
            check()?;
            if !frame
                .path(&["_styk", "frameId"])
                .and_then(Value::as_str)
                .is_some_and(|id| !id.is_empty() && native_ids.insert(id))
            {
                return Err(EditError::Unported(
                    "unavailable or nonunique native projected frame identities".into(),
                ));
            }
        }
        for frame in frames.iter().chain(&retained) {
            check()?;
            if frame.get("_stykVfx").is_some() {
                return Err(EditError::Unported(
                    "an unrecorded native projected scene effect".into(),
                ));
            }
            for object in items(frame.get("objects")) {
                check()?;
                if ["join", "_stykIK", "_stykSpatial", "_stykStyle", "_stykVfx"]
                    .iter()
                    .any(|field| object.get(field).is_some_and(Value::truthy))
                {
                    return Err(EditError::Unported(
                        "an unrecorded native projected pose dependency".into(),
                    ));
                }
            }
        }
        let mut ids = std::collections::HashSet::new();
        for channel in items(self.report.path(&["_styk", "animation", "channels"])) {
            check()?;
            if !native_channel_header(&channel, &["x", "y", "pose"], &mut ids) {
                return Err(EditError::Unported(
                    "an unrecorded native projected channel family".into(),
                ));
            }
        }
        let shown = self.selection_frame()?;
        if ["select", "@select", "beginAnimationEdit"].contains(&method) {
            let target = if method == "beginAnimationEdit" {
                args.first().and_then(|target| target.get("uid"))
            } else {
                args.first()
            };
            let target = target.and_then(Value::as_f64).filter(|uid| {
                uid.is_finite() && uid.fract() == 0.0 && (0.0..=u32::MAX as f64).contains(uid)
            });
            if !shown
                .iter()
                .any(|object| object.get("unique_id").and_then(Value::as_f64) == target)
            {
                return Err(EditError::Unported(
                    "an unrecorded absent native projected target".into(),
                ));
            }
        }
        Ok(())
    }
}
