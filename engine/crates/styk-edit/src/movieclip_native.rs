//! Recorded native movieclip pose captures, publication and timing. Saved VFX
//! stacks are additionally sampled by recorded reads/Bake; other scalar movie
//! commands, drafts, origins and retained-source editing remain refused.

use crate::history::{Command, CommandKind, Direction};
use crate::frame::objects_of;
use crate::record::{num, uid};
use crate::topology::{self, FramePoses};
use crate::{EditError, Editor};
use styk_doc::{Obj, Value};

fn object(fields: &[(&str, Value)]) -> Value {
    let mut out = Obj::new();
    for (key, value) in fields {
        out.set(*key, value.clone());
    }
    Value::object(out)
}
fn items(value: Option<&Value>) -> Vec<Value> {
    value.and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default()
}
fn channel_id(uid: u32) -> String {
    format!("figure:{uid}:pose")
}
fn poses(report: &Value) -> Vec<Value> {
    items(report.path(&["_styk", "animation", "channels"]))
}
fn pose_key(id: &str, tick: f64, source: Option<&str>) -> Value {
    object(&[("id", Value::str(id)), ("tick", Value::Num(tick)), ("interpolation", Value::str("hold")), ("value", object(&[("frameId", source.map(Value::str).unwrap_or(Value::Null))]))])
}

/// Static movie command classification for the IK and saved-draft admission gates,
/// shared by the interface Session and worker preparation (one implementation).
pub(crate) fn native_movieclip_method(method: &str) -> bool {
    matches!(method, "createEmptyMovieclip" | "createMovieclip" | "makeMovieclipUnique" | "placeMovieclip" | "splitMovieclip" | "breakApartMovieclip" | "renameMovieclip" | "restartMovieclip" | "removeMovieclipRestart" | "setMovieclipPlayback" | "setMovieclipDrawing" | "addMovieclipToNextKeyframes" | "bakeMovieclip")
}

impl Editor {
    /// Native movieclip mutations whose draft/IK composition is not recorded yet.
    pub(crate) fn native_movieclip_mutation(&self, method: &str, args: &[Value]) -> bool {
        if self.sheet() { return false; }
        if method == "addFigure" {
            let wanted = args.first().cloned().or_else(|| items(self.report.get("figure_types")).first().and_then(|figure| figure.get("figure_type_id").cloned()));
            return items(self.report.get("figure_types")).iter().find(|figure| figure.get("figure_type_id") == wanted.as_ref()).is_some_and(|figure| figure.path(&["_styk", "movieclip"]).is_some_and(Value::truthy));
        }
        native_movieclip_method(method)
    }

    /// `_insertMovieclip`: library placement uses the existing range command,
    /// selected-pose mutation, source capture and animation publication owners.
    pub(crate) fn insert_native_movieclip(&mut self, definition: &Value) -> Result<Value, EditError> {
        if poses(&self.report).is_empty() && self.report.path(&["_styk", "movieclipSource"]).is_none() && self.tick.fract() != 0.0 {
            return Err(EditError::Invalid("errors.animationChannels.invalidMovieclipEnd".into()));
        }
        let type_id = definition.get("figure_type_id").unwrap().clone();
        let asset = definition.path(&["_styk", "movieclip"]).unwrap().clone();
        self.movieclip_batch("Insert movieclip", |editor| {
            editor.add_movieclip_range(&type_id, None)?;
            let selected = editor.selection.uid.unwrap();
            let tick = editor.tick;
            let end = tick + (num(&asset, "duration").unwrap() * num(&editor.report, "fps").unwrap() / asset.get("document").and_then(|document| num(document, "fps")).unwrap()).ceil().max(1.0);
            editor.edit_native_movieclip_poses("Insert movieclip", |object| {
                let mut playback = crate::movieclips::playback_settings(object.get("_stykMovieclip"));
                playback.set("start", Value::Num(tick));
                playback.set("end", Value::Num(end));
                object.set("_stykMovieclip", Value::object(playback));
            })?;
            let shown = editor.shown_frame()?;
            let mut channel = editor.capture_native_pose_channel(selected, &[(tick, shown)], (tick, None), None, &[selected])?.as_obj().cloned().unwrap();
            channel.set("clipEnd", Value::Num(end));
            editor.publish_native_channels(vec![Value::object(channel)], "Insert movieclip")?;
            editor.seek(tick)?;
            editor.select(Some(selected), -1, false, false)?;
            Ok(editor.object()?.map(|(_, object)| object).unwrap_or(Value::Null))
        })
    }

    /// Actual native next-keyframe edits share the existing whole-frame transaction.
    pub(crate) fn extend_native_movieclip(&mut self, count: f64) -> Result<Value, EditError> {
        let (_, instance, _) = self.selected_movieclip()?;
        if !count.is_finite() || count.fract() != 0.0 || !(1.0..=9_007_199_254_740_991.0).contains(&count) {
            return Err(EditError::Invalid("errors.editorMovieclips.enterAPositiveWholeNumberOfKeyframes".into()));
        }
        let selected = uid(&instance).unwrap();
        let layer = self.layer_of(selected);
        if self.report.path(&["_styk", "layers", "byId", &layer, "locked"]).is_some_and(Value::truthy) {
            return Err(EditError::Invalid("errors.editorMovieclips.unlockTheMovieclipLayerBeforeEditingIt".into()));
        }
        let frame = self.report.get("keyframes").and_then(|frames| frames.item(self.frame_index)).unwrap();
        let source = crate::movieclip_commands::filtered_frame(&frame, &std::collections::HashSet::from([selected]));
        let source = objects_of(&source).into_iter().next().unwrap();
        let selection = self.selection_state();
        let order_index = crate::figures::frame_order(frame.as_obj().unwrap()).into_iter().filter(|u| self.layer_of(*u as u32) == layer).position(|u| u == selected as f64).map_or(-1, |i| i as isize);
        let ticks = crate::timeline::rows(&self.report).into_iter().filter(|row| row.start > self.tick && row.count > 0.0).take(count as usize).map(|row| row.start).collect::<Vec<_>>();
        self.movieclip_batch("Add movieclip to next keyframes", |editor| {
            let result = (|| {
                let mut added = 0;
                for tick in ticks {
                    editor.seek(tick)?;
                    if editor.selection_frame()?.iter().any(|object| uid(object) == Some(selected)) { continue; }
                    editor.native_frame_transaction("Add movieclip to next keyframes", |editor| {
                        if source.get("join").is_some_and(Value::truthy) && crate::record::join_target(&source).is_none() {
                            return Err(EditError::Invalid("errors.model.joinPointsToAMissingFigureOrHandle".into()));
                        }
                        let frame = editor.report.make_obj().and_then(|report| report.get_mut("keyframes")).and_then(Value::make_arr).and_then(|frames| frames.get_mut(editor.frame_index)).unwrap().as_obj().unwrap().clone();
                        let mut order = crate::figures::frame_order(&frame);
                        let siblings = order.iter().copied().filter(|u| editor.layer_of(*u as u32) == layer).collect::<Vec<_>>();
                        let insertion = if order_index >= 0 && (order_index as usize) < siblings.len() {
                            order.iter().position(|id| *id == siblings[order_index as usize]).unwrap()
                        } else if let Some(last) = siblings.last() { order.iter().position(|id| id == last).unwrap() + 1 } else { order.len() };
                        let mut frame = frame;
                        let mut objects = objects_of(&Value::object(frame.clone()));
                        objects.push(source.clone());
                        frame.set("objects", Value::array(objects));
                        order.insert(insertion, selected as f64);
                        crate::figures::set_order(&mut frame, &order);
                        crate::figures::normalize_frame(&mut frame);
                        *editor.report.make_obj().and_then(|report| report.get_mut("keyframes")).and_then(Value::make_arr).and_then(|frames| frames.get_mut(editor.frame_index)).unwrap() = Value::object(frame);
                        Ok(())
                    })?;
                    added += 1;
                }
                Ok(Value::Num(added as f64))
            })();
            editor.restore_selection(&selection)?;
            result
        })
    }

    pub(crate) fn recorded_native_movieclip_call(&self, method: &str, args: &[Value], reason: &str) -> bool {
        if reason != "with property channels"
            || self.sheet()
            || self.options.property_channels
            || self.options.layer_timeline
            || (method == "setMovieclipPlayback" && !args.get(1).and_then(|options| options.get("allFrames")).is_some_and(Value::truthy))
            || !matches!(
                method,
                "seek"
                    | "@seek"
                    | "select"
                    | "@select"
                    | "selectMany"
                    | "undo"
                    | "redo"
                    | "createEmptyMovieclip"
                    | "createMovieclip"
                    | "makeMovieclipUnique"
                    | "placeMovieclip"
                    | "splitMovieclip"
                    | "breakApartMovieclip"
                    | "bakeMovieclip"
                    | "setMovieclipPlayback"
                    | "restartMovieclip"
                    | "removeMovieclipRestart"
                    | "addFigure"
                    | "setLayerLocked"
            )
            || self.report.path(&["_styk", "movieclipSource"]).is_some()
            || self.report.path(&["_styk", "simpleFrameDraft"]).is_some()
            || items(self.report.get("figure_types")).iter().any(|f| f.path(&["_styk", "animationOrigin"]).is_some_and(Value::truthy))
        {
            return false;
        }
        if method == "addFigure" {
            let wanted = args.first().cloned().or_else(|| items(self.report.get("figure_types")).first().and_then(|figure| figure.get("figure_type_id").cloned()));
            if items(self.report.get("figure_types")).iter().find(|figure| figure.get("figure_type_id") == wanted.as_ref()).is_some_and(|figure| !figure.path(&["_styk", "movieclip"]).is_some_and(Value::truthy)) {
                return false;
            }
        }
        poses(&self.report).iter().all(|c| {
            let figure = c.path(&["target", "kind"]).and_then(Value::as_str) == Some("figure")
                && c.path(&["target", "uid"]).and_then(Value::as_f64).is_some();
            // The existing Records scalar owner composes these saved stacks;
            // only the recorded non-authoring reads/history and worker Bake
            // are admitted. Other movieclip mutations are still unrecorded.
            if c.get("property").and_then(Value::as_str) == Some("vfxStack") {
                return matches!(method, "seek" | "@seek" | "select" | "@select" | "undo" | "redo" | "bakeMovieclip")
                    && (figure || c.path(&["target", "kind"]).and_then(Value::as_str) == Some("scene"));
            }
            c.get("property").and_then(Value::as_str) == Some("pose")
                && (figure
                    || (matches!(method, "seek" | "@seek" | "select" | "@select" | "selectMany" | "undo" | "redo" | "createEmptyMovieclip" | "addFigure" | "bakeMovieclip" | "setLayerLocked")
                        && c.path(&["target", "kind"]).and_then(Value::as_str) == Some("layer")
                        && c.path(&["target", "id"]).and_then(Value::as_str).is_some()))
        })
    }

    /// Snapshot and identity assignment are shared by captured assets and the
    /// motion draft. Rewrites supply their allocated ID and never advance it.
    pub(crate) fn native_pose_source(&mut self, frame: &Value, selected: Option<&[f64]>, identity: Option<&str>) -> Result<(String, Value), EditError> {
        let id = match identity {
            Some(id) => id.to_string(),
            None => {
                if self.next_frame_identity > 9_007_199_254_740_991 {
                    return Err(EditError::Invalid("errors.clipboardLegacyUpgrade.frameIdentityCapacityExceeded".into()));
                }
                let id = format!("frame-{}", self.next_frame_identity); self.next_frame_identity += 1; id
            }
        };
        let mut source = styk_eval::records::snapshot_pose_frame_of(frame, selected).as_obj().cloned().unwrap();
        let mut metadata = source.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
        metadata.set("frameId", Value::str(&id)); source.set("_styk", Value::object(metadata));
        Ok((id, Value::object(source)))
    }

    /// The canonical source table and its existing registration/accounting owner.
    /// Initialize retention before insertion, so a first capture is counted once.
    pub(crate) fn publish_native_pose_sources(&mut self, sources: &[(String, Value)]) -> Result<(), EditError> {
        if sources.is_empty() { return Ok(()); }
        self.ensure_counts();
        let styk = self.report.make_obj().and_then(|r| r.get_mut("_styk")).and_then(Value::make_obj).unwrap();
        if styk.get("frameSources").is_none() { styk.set("frameSources", Value::object(Obj::new())); }
        let table = styk.get_mut("frameSources").and_then(Value::make_obj).unwrap();
        for (id, source) in sources { table.set(id, source.clone()); }
        self.register_frame_sources(&sources.iter().map(|(_, source)| source.clone()).collect::<Vec<_>>(), true)?;
        Ok(())
    }

    /// `captureFrameSource`: snapshot, assign and register one identity. Existing
    /// source IDs remain assets across history changes.
    pub(crate) fn capture_native_pose(&mut self, frame: &Value, selected: Option<&[f64]>) -> Result<String, EditError> {
        let (id, source) = self.native_pose_source(frame, selected, None)?;
        self.publish_native_pose_sources(&[(id.clone(), source)])?;
        Ok(id)
    }

    fn publish_native_channels(&mut self, channels: Vec<Value>, label: &str) -> Result<(), EditError> {
        let before = self.report.path(&["_styk", "animation"]).cloned();
        let selection = self.selection_state();
        let mut after = object(&[("version", Value::Num(1.0)), ("nextKeyId", Value::Num(1.0))]).as_obj().cloned().unwrap();
        for (key, value) in before.as_ref().and_then(Value::as_obj).map(|o| o.iter().collect::<Vec<_>>()).unwrap_or_default() {
            after.set(key, value.clone());
        }
        let mut merged: Vec<Value> = poses(&self.report).into_iter().filter(|old| !channels.iter().any(|new| old.get("id") == new.get("id"))).collect();
        merged.extend(channels);
        after.set("channels", Value::array(merged));
        let after = Value::object(after);
        self.publish_native_animation(before, after, label, selection, None)
    }

    pub(crate) fn publish_native_animation(&mut self, before: Option<Value>, after: Value, label: &str, selection: crate::select::SelectionState, changed: Option<&[u32]>) -> Result<(), EditError> {
        self.record_native_animation(before, after, label, selection, true)?;
        let fields = match changed {
            Some(changed) => vec![("label", Value::str(label)), ("animation", Value::Bool(true)), ("structural", Value::Bool(true)), ("timing", Value::Bool(true)), ("changedUids", Value::array(changed.iter().map(|uid| Value::Num(*uid as f64)).collect()))],
            None => vec![("structural", Value::Bool(true)), ("timing", Value::Bool(true)), ("animation", Value::Bool(true)), ("label", Value::str(label))],
        };
        self.emit("edit", fields);
        Ok(())
    }

    fn replace_movieclip_pose_entries(&mut self, entries: &[FramePoses]) {
        for entry in entries {
            if let Some(objects) = topology::frame_mut(&mut self.report, &entry.place).and_then(|f| f.get_mut("objects")).and_then(Value::make_arr) {
                for object in objects {
                    if let Some(replacement) = entry.objects.iter().find(|o| uid(o) == uid(object)) {
                        *object = replacement.clone();
                    }
                }
            }
        }
        self.retained = None;
    }

    pub(crate) fn edit_native_movieclip_poses(&mut self, label: &str, mutate: impl Fn(&mut Obj)) -> Result<(), EditError> {
        let selected = self.selection.uid.unwrap();
        let selection = self.selection_state();
        let mut before = Vec::new();
        let mut after = Vec::new();
        for place in topology::places(&self.report) {
            let objects: Vec<Value> = items(topology::frame_at(&self.report, &place).and_then(|f| f.get("objects"))).into_iter().filter(|o| uid(o) == Some(selected)).collect();
            if objects.is_empty() {
                continue;
            }
            let changed = objects
                .iter()
                .map(|o| {
                    let mut o = o.as_obj().cloned().unwrap();
                    mutate(&mut o);
                    o.remove("_movieclipSample");
                    Value::object(o)
                })
                .collect();
            before.push(FramePoses { place: place.clone(), objects });
            after.push(FramePoses { place, objects: changed });
        }
        self.replace_movieclip_pose_entries(&after);
        self.record(Command {
            kind: CommandKind::MovieclipPoses { before, after },
            label: label.into(),
            before_selection: selection.clone(),
            after_selection: selection,
            before_revision: 0,
            after_revision: 0,
            layer_changes: Vec::new(),
            captured_source_bytes: 0,
            layers: false,
        })?;
        self.emit("edit", vec![("structural", Value::Bool(true)), ("timing", Value::Bool(true)), ("label", Value::str(label))]);
        Ok(())
    }

    pub(crate) fn apply_movieclip_poses(&mut self, command: &Command, direction: Direction) -> Result<(), EditError> {
        let CommandKind::MovieclipPoses { before, after } = &command.kind else { return Ok(()) };
        self.replace_movieclip_pose_entries(if direction == Direction::Before { before } else { after });
        self.restore_selection(if direction == Direction::Before { &command.before_selection } else { &command.after_selection })?;
        self.revision = if direction == Direction::Before { command.before_revision } else { command.after_revision };
        self.emit("history", vec![("structural", Value::Bool(true)), ("timing", Value::Bool(true)), ("label", Value::str(&command.label))]);
        Ok(())
    }

    pub(crate) fn make_native_movieclip_unique(&mut self, definition: Value) -> Result<Value, EditError> {
        self.movieclip_batch("Make movieclip unique", |editor| {
            let mut figure = definition.as_obj().cloned().unwrap();
            figure.set("figure_type_id", Value::Num(crate::movieclip_commands::allocate_type(&editor.report)));
            figure.set("name", Value::str(&format!("{} copy", definition.get("name").and_then(Value::as_str).unwrap_or(""))));
            let figure = Value::object(figure);
            let type_id = figure.get("figure_type_id").unwrap().clone();
            editor.publish_definition(items(editor.report.get("figure_types")).len(), figure.clone(), "Create movieclip")?;
            editor.edit_native_movieclip_poses("Make movieclip unique", |object| object.set("figure_type_id", type_id.clone()))?;
            Ok(figure)
        })
    }

    fn native_movieclip_pose_channel(&mut self) -> Result<Value, EditError> {
        let (_, instance, _) = self.selected_movieclip()?;
        let selected = uid(&instance).unwrap();
        let own = poses(&self.report).into_iter().find(|c| c.get("property").and_then(Value::as_str) == Some("pose") && c.path(&["target", "uid"]).and_then(Value::as_f64) == Some(selected as f64));
        let own = if own.is_none() && self.sheet() {
            let keys = items(self.report.path(&["_styk", "layerSheet", "tracks", &self.layer_of(selected), "keys"]));
            if keys.iter().any(|key| key.get("sourceTick").is_some()) {
                Some(self.native_baseline_pose(selected)?)
            } else {
                Some(object(&[
                    ("id", Value::str(&channel_id(selected))),
                    ("target", object(&[("kind", Value::str("figure")), ("uid", Value::Num(selected as f64))])),
                    ("property", Value::str("pose")), ("source", Value::str("authored")),
                    ("keys", Value::array(self.project_movieclip_pose_keys(&keys, selected))),
                ]))
            }
        } else { own };
        if let Some(own) = own {
            let mut own = own.as_obj().cloned().unwrap();
            let keys = items(own.get("keys"));
            let first = keys.iter().position(|k| !k.path(&["value", "frameId"]).is_some_and(Value::is_null));
            let last = keys.iter().rposition(|k| !k.path(&["value", "frameId"]).is_some_and(Value::is_null));
            own.remove("nativeProperties");
            own.remove("useBasePose");
            own.set(
                "keys",
                Value::array(match (first, last) {
                    (Some(first), Some(last)) => keys[first..=last].to_vec(),
                    _ => Vec::new(),
                }),
            );
            return Ok(Value::object(own));
        }
        let start = num(&Value::object(crate::movieclips::playback_settings(instance.get("_stykMovieclip"))), "start").unwrap_or(0.0);
        let shown = self.shown_frame()?;
        self.capture_native_pose_channel(selected, &[(start, shown)], (0.0, None), None, &[selected])
    }

    /// `figurePoseSequences`: keys follow this UID's recorded lifetime, keeping
    /// an explicit blank boundary after every gap and the original key fields.
    fn project_movieclip_pose_keys(&self, keys: &[Value], selected: u32) -> Vec<Value> {
        let present = keys.iter().enumerate().filter_map(|(index, key)| {
            key.path(&["value", "frameId"]).and_then(Value::as_str).and_then(|id| self.frame_by_id(id))
                .is_some_and(|frame| crate::frame::objects_of(&frame).iter().any(|object| uid(object) == Some(selected))).then_some(index)
        }).collect::<Vec<_>>();
        project_pose_keys(keys, &present)
    }

    /// `poseChannel`: every child shares one captured frame sequence.
    fn capture_native_pose_channel(&mut self, selected: u32, frames: &[(f64, Value)], bounds: (f64, Option<f64>), anchor: Option<u32>, source_uids: &[u32]) -> Result<Value, EditError> {
        self.capture_native_pose_channel_checked(selected, frames, bounds, anchor, source_uids, &mut || Ok(()))
    }

    fn capture_native_pose_channel_checked(&mut self, selected: u32, frames: &[(f64, Value)], bounds: (f64, Option<f64>), anchor: Option<u32>, source_uids: &[u32], check: &mut dyn FnMut() -> Result<(), EditError>) -> Result<Value, EditError> {
        let uids = source_uids.iter().map(|u| *u as f64).collect::<Vec<_>>();
        let mut keys = Vec::new();
        for (index, (tick, frame)) in frames.iter().enumerate() {
            check()?;
            let source = self.capture_native_pose(frame, Some(&uids))?;
            keys.push(pose_key(&format!("clip-pose-{selected}-{index}"), *tick, Some(&source)));
        }
        check()?;
        if bounds.0 > 0.0 {
            keys.insert(0, pose_key(&format!("clip-blank-{selected}"), 0.0, None));
        }
        if let Some(end) = bounds.1 {
            keys.push(pose_key(&format!("clip-end-{selected}"), end, None));
        }
        let mut channel = object(&[
            ("id", Value::str(&channel_id(selected))),
            ("target", object(&[("kind", Value::str("figure")), ("uid", Value::Num(selected as f64))])),
            ("property", Value::str("pose")),
            ("keys", Value::array(keys)),
        ])
        .as_obj()
        .cloned()
        .unwrap();
        if let Some(anchor) = anchor {
            channel.set("orderAnchor", Value::Num(anchor as f64));
        }
        Ok(Value::object(channel))
    }

    /// Native reference keys projected onto this figure's lifetime. The
    /// evaluator owns their curves; publication saves only frame references.
    pub(crate) fn native_baseline_pose(&self, selected: u32) -> Result<Value, EditError> {
        self.native_baseline_pose_checked(selected, &mut || Ok(()))
    }

    /// The same native marker/lifetime owner; only worker preparation forwards
    /// its borrowed cancellation check. Ordinary callers retain their wrapper.
    pub(crate) fn native_baseline_pose_checked(
        &self,
        selected: u32,
        check: &mut dyn FnMut() -> Result<(), EditError>,
    ) -> Result<Value, EditError> {
        check()?;
        for channel in poses(&self.report) {
            check()?;
            if channel.get("property").and_then(Value::as_str) == Some("pose")
                && channel.path(&["target", "kind"]).and_then(Value::as_str) == Some("figure")
                && channel.path(&["target", "uid"]).and_then(Value::as_f64) == Some(selected as f64)
            {
                return Ok(channel);
            }
        }
        let keys = self.native_pose_markers_checked(check)?;
        let mut present = Vec::new();
        for (index, frame) in items(self.report.get("keyframes")).iter().enumerate() {
            check()?;
            for object in items(frame.get("objects")) {
                check()?;
                if uid(&object) == Some(selected) {
                    present.push(index);
                    break;
                }
            }
        }
        check()?;
        let sequence = project_pose_keys(&keys, &present);
        let mut descriptor = object(&[
            ("id", Value::str(&channel_id(selected))),
            (
                "target",
                object(&[
                    ("kind", Value::str("figure")),
                    ("uid", Value::Num(selected as f64)),
                ]),
            ),
            ("property", Value::str("pose")),
            ("source", Value::str("native")),
            ("keys", Value::array(sequence)),
        ])
        .as_obj()
        .unwrap()
        .clone();
        if self.options.property_channels {
            descriptor.set("nativeProperties", Value::Bool(true));
        }
        Ok(Value::object(descriptor))
    }

    /// `nativePoseChannel` marker keys are shared by figure lifetime projection
    /// and a newly authored native layer. The typed native timeline owns timing.
    fn native_pose_markers(&self) -> Result<Vec<Value>, EditError> {
        self.native_pose_markers_checked(&mut || Ok(()))
    }

    fn native_pose_markers_checked(
        &self,
        check: &mut dyn FnMut() -> Result<(), EditError>,
    ) -> Result<Vec<Value>, EditError> {
        check()?;
        let prepared = self.prepared()?;
        check()?;
        let rows = styk_eval::eval::native_timeline(&prepared.doc);
        let frames = items(self.report.get("keyframes"));
        let mut keys = Vec::new();
        for (row, frame) in rows.iter().zip(&frames) {
            check()?;
            let id = frame
                .path(&["_styk", "frameId"])
                .and_then(Value::as_str)
                .unwrap();
            let mut key = object(&[
                ("id", Value::str(&format!("native:pose:{id}"))),
                ("tick", Value::Num(row.start as f64)),
                ("value", object(&[("frameId", Value::str(id))])),
            ])
            .as_obj()
            .cloned()
            .unwrap();
            if let Some(easing) = frame.path(&["_styk", "easing"]).and_then(Value::as_obj) {
                for (k, v) in easing.iter() {
                    key.set(k, v.clone());
                }
            } else if prepared.doc.version < 5 {
                key.set("interpolation", Value::str("constant"));
            } else if !prepared.doc.auto_easing {
                key.set("interpolation", Value::str("linear"));
            }
            if row.count == 0 {
                key.set("hidden", Value::Bool(true));
            }
            keys.push(Value::object(key));
        }
        Ok(keys)
    }

    pub(crate) fn native_layer_pose(&mut self, layer: &str) -> Result<Value, EditError> {
        self.ensure_counts();
        self.native_layer_pose_counted(layer)
    }

    /// [`Self::native_layer_pose`] once the figure counts exist (`ensure_counts`). With property
    /// channels the native clock keeps the layer's other properties (`nativeProperties`).
    pub(crate) fn native_layer_pose_counted(&self, layer: &str) -> Result<Value, EditError> {
        let id = format!("layer:{layer}:pose");
        if let Some(own) = poses(&self.report).into_iter().find(|channel| channel.get("id").and_then(Value::as_str) == Some(id.as_str())) {
            return Ok(own);
        }
        let counts = self.uid_counts.as_ref().ok_or_else(|| EditError::Unported("a layer pose before the figure counts".into()))?;
        let empty = !counts.0.keys().any(|uid| self.layer_of(*uid) == layer);
        let mut channel = object(&[
            ("id", Value::str(&id)),
            ("target", object(&[("kind", Value::str("layer")), ("id", Value::str(layer))])),
            ("property", Value::str("pose")), ("source", Value::str("native")),
            ("keys", Value::array(if empty { Vec::new() } else { self.native_pose_markers()? })),
        ]);
        if self.options.property_channels { channel.make_obj().unwrap().set("nativeProperties", Value::Bool(true)); }
        Ok(channel)
    }

    fn masked_native_pose(&self, selected: u32, start: f64, end: f64) -> Result<Value, EditError> {
        let own = poses(&self.report).iter().any(|c| c.path(&["target", "uid"]).and_then(Value::as_f64) == Some(selected as f64));
        let mut channel = self.native_baseline_pose(selected)?.as_obj().cloned().unwrap();
        if !own {
            channel.set("useBasePose", Value::Bool(true));
        }
        let mut ranges = items(channel.get("maskedRanges")).iter().filter_map(Value::numbers).map(|r| [r[0], r[1]]).collect::<Vec<_>>();
        ranges.push([start, end]);
        ranges.sort_by(|a, b| a[0].total_cmp(&b[0]));
        let mut merged: Vec<[f64; 2]> = Vec::new();
        for range in ranges {
            if let Some(last) = merged.last_mut().filter(|last| last[1] >= range[0]) {
                last[1] = last[1].max(range[1]);
            } else {
                merged.push(range);
            }
        }
        channel.set("maskedRanges", Value::array(merged.iter().map(|r| Value::array(vec![Value::Num(r[0]), Value::Num(r[1])])).collect()));
        Ok(Value::object(channel))
    }

    pub(crate) fn create_native_movieclip_replacement(&mut self, figure: Value, selected: &[u32], start: f64, end: f64, anchor: u32) -> Result<Value, EditError> {
        self.movieclip_batch("Create movieclip", |editor| {
            editor.publish_definition(items(editor.report.get("figure_types")).len(), figure.clone(), "Create movieclip")?;
            if editor.next_uid > 0x7fff_fffe {
                return Err(EditError::Invalid("errors.editorLayerSheet.objectIdentityCapacityReached".into()));
            }
            let identity = editor.next_uid as u32;
            editor.next_uid += 1;
            let asset = figure.path(&["_styk", "movieclip"]).unwrap();
            let pivot = asset.get("pivot").unwrap();
            let mut instance = crate::figures::create_object(&figure, identity, num(pivot, "x").unwrap(), num(pivot, "y").unwrap()).as_obj().cloned().unwrap();
            instance.set(
                "_stykMovieclip",
                object(&[
                    ("start", Value::Num(start)),
                    ("end", Value::Num(end)),
                    ("offset", Value::Num(0.0)),
                    ("speed", Value::Num(1.0)),
                    ("mode", Value::str(if num(asset, "duration") == Some(1.0) { "single" } else { "loop" })),
                ]),
            );
            let frame = crate::sheet::create_frame(&[Value::object(instance)]);
            let mut channels = selected.iter().map(|u| editor.masked_native_pose(*u, start, end)).collect::<Result<Vec<_>, _>>()?;
            let mut channel = editor.capture_native_pose_channel(identity, &[(start, frame)], (start, None), Some(anchor), &[identity])?.as_obj().cloned().unwrap();
            channel.set("clipEnd", Value::Num(end));
            channels.push(Value::object(channel));
            editor.layer_edit("Place movieclip figures", vec![(vec!["assignments".into(), identity.to_string()], Some(Value::str(&editor.layer_of(anchor))), false)], true, None)?;
            editor.publish_native_channels(channels, "Create movieclip")?;
            editor.seek(start)?;
            editor.select(Some(identity), -1, false, false)?;
            Ok(figure)
        })
    }

    pub(crate) fn publish_native_movieclip_expansions(
        &mut self, mut frames: Vec<(f64, Value)>, previous: u32, bounds: (f64, f64),
        definitions: Vec<Value>, paths: std::collections::HashMap<u32, String>, label: &str, reuse_parts: bool,
        mut worker: Option<&mut crate::movieclip_planning::TimelineWorker<'_>>,
    ) -> Result<Value, EditError> {
        let (start, end) = bounds;
        self.movieclip_batch(label, |editor| {
            let mut existing = items(editor.report.get("figure_types")).iter().filter_map(|f| num(f, "figure_type_id")).collect::<Vec<_>>();
            for figure in definitions {
                if let Some(worker) = worker.as_deref_mut() { (worker.check)()?; }
                let id = num(&figure, "figure_type_id").unwrap();
                if !existing.contains(&id) {
                    existing.push(id);
                    editor.publish_definition(items(editor.report.get("figure_types")).len(), figure, "Create movieclip")?;
                }
            }
            let parts = poses(&editor.report).into_iter().filter(|c| reuse_parts && c.path(&["movieclipPart", "instance"]).and_then(Value::as_f64) == Some(previous as f64)).collect::<Vec<_>>();
            let mut mapping: Vec<(u32, u32, String)> = Vec::new();
            for o in frames.iter().flat_map(|(_, frame)| items(frame.get("objects"))) {
                if let Some(worker) = worker.as_deref_mut() { (worker.check)()?; }
                let old = uid(&o).unwrap();
                if mapping.iter().any(|(a, _, _)| *a == old) {
                    continue;
                }
                let path = paths.get(&old).cloned().unwrap_or_default();
                let known = parts.iter().find(|c| c.path(&["movieclipPart", "path"]).and_then(Value::as_str) == Some(&path));
                let identity = if let Some(known) = known {
                    known.path(&["target", "uid"]).and_then(Value::as_f64).unwrap() as u32
                } else {
                    if editor.next_uid > 0x7fff_fffe {
                        return Err(EditError::Invalid("errors.editorLayerSheet.objectIdentityCapacityReached".into()));
                    }
                    let id = editor.next_uid as u32;
                    editor.next_uid += 1;
                    id
                };
                mapping.push((old, identity, path));
            }
            for (_, source) in &mut frames {
                if let Some(worker) = worker.as_deref_mut() { (worker.check)()?; }
                let mut frame = source.as_obj().cloned().unwrap();
                let order = crate::figures::frame_order(&frame).iter().map(|old| mapping.iter().find(|(uid, _, _)| *uid as f64 == *old).unwrap().1 as f64).collect::<Vec<_>>();
                if let Some(objects) = frame.get_mut("objects").and_then(Value::make_arr) {
                    for o in objects {
                        let (_, id, path) = mapping.iter().find(|(old, _, _)| Some(*old) == uid(o)).unwrap();
                        let o = o.make_obj().unwrap();
                        o.set("unique_id", Value::Num(*id as f64));
                        if reuse_parts { o.set("_stykMovieclipPart", object(&[("instance", Value::Num(previous as f64)), ("path", Value::str(path))])); }
                    }
                }
                crate::figures::set_order(&mut frame, &order);
                crate::figures::normalize_frame(&mut frame);
                *source = Value::object(frame);
            }
            let children = mapping.iter().map(|(_, id, _)| *id).collect::<Vec<_>>();
            let mut channels = vec![editor.masked_native_pose(previous, start, end)?];
            if let Some(first) = children.first().copied() {
                let shared = if let Some(worker) = worker.as_deref_mut() {
                    editor.capture_native_pose_channel_checked(first, &frames, (start, Some(end)), Some(previous), &children, worker.check)?
                } else { editor.capture_native_pose_channel(first, &frames, (start, Some(end)), Some(previous), &children)? };
                let keys = items(shared.get("keys"));
                for (_, identity, path) in &mapping {
                    if let Some(worker) = worker.as_deref_mut() { (worker.check)()?; }
                    let previous_channel = parts.iter().find(|c| c.path(&["movieclipPart", "path"]).and_then(Value::as_str) == Some(path));
                    let key_sequence = if let Some(previous_channel) = previous_channel {
                        let prepared = editor.prepared()?;
                        let sampled = prepared
                            .doc
                            .animation
                            .as_ref()
                            .and_then(|a| a.channels.iter().find(|c| c.target == styk_eval::channels::Target::Figure { uid: *identity } && c.property == styk_eval::channels::Property::Pose))
                            .and_then(|c| c.sample(end));
                        let at_end = match sampled {
                            Some(styk_eval::channels::KeyValue::Pose(Some(id))) => object(&[("frameId", Value::str(&id))]),
                            _ => object(&[("frameId", Value::Null)]),
                        };
                        let mut merged = items(previous_channel.get("keys"));
                        for key in keys.iter().filter(|k| num(k, "tick").unwrap() >= start) {
                            let key_tick = num(key, "tick").unwrap();
                            let mut changed = key.as_obj().cloned().unwrap();
                            changed.set("id", Value::str(&format!("clip-part-{identity}-{key_tick}")));
                            if key_tick == end {
                                changed.set("value", at_end.clone());
                            }
                            let changed = Value::object(changed);
                            if let Some(old) = merged.iter_mut().find(|k| num(k, "tick") == Some(key_tick)) {
                                *old = changed;
                            } else {
                                merged.push(changed);
                            }
                        }
                        merged.sort_by(|a, b| num(a, "tick").unwrap().total_cmp(&num(b, "tick").unwrap()));
                        merged
                    } else {
                        keys.clone()
                    };
                    let mut channel = object(&[
                        ("id", Value::str(&channel_id(*identity))),
                        ("target", object(&[("kind", Value::str("figure")), ("uid", Value::Num(*identity as f64))])),
                        ("property", Value::str("pose")),
                        ("keys", Value::array(key_sequence)),
                        ("orderAnchor", Value::Num(previous as f64)),
                    ]).as_obj().cloned().unwrap();
                    if reuse_parts { channel.set("movieclipPart", object(&[("instance", Value::Num(previous as f64)), ("path", Value::str(path))])); }
                    channels.push(Value::object(channel));
                }
            }
            let layer = editor.layer_of(previous);
            if let Some(worker) = worker.as_deref_mut() { (worker.check)()?; }
            editor.layer_edit("Place movieclip figures", children.iter().map(|id| (vec!["assignments".into(), id.to_string()], Some(Value::str(&layer)), false)).collect(), true, None)?;
            if let Some(worker) = worker.as_deref_mut() { (worker.check)()?; }
            editor.publish_native_channels(channels, label)?;
            editor.seek(start)?;
            editor.select_many(&children)?;
            Ok(Value::array(children.iter().map(|id| Value::Num(*id as f64)).collect()))
        })
    }

    pub(crate) fn place_native_movieclip(&mut self, patch: &Value, move_: bool) -> Result<Value, EditError> {
        self.place_movieclip_with(patch, move_, None)
    }

    pub(crate) fn place_movieclip_with(&mut self, patch: &Value, move_: bool, mut worker: Option<&mut crate::movieclip_planning::TimelineWorker<'_>>) -> Result<Value, EditError> {
        if self.sheet() && worker.is_none() {
            return Err(EditError::Unported("placing a movieclip on a layer sheet".into()));
        }
        let (_, instance, _) = self.selected_movieclip()?;
        let selected = uid(&instance).unwrap();
        let previous = Value::object(crate::movieclips::playback_settings(instance.get("_stykMovieclip")));
        let start = num(&previous, "start").unwrap();
        let tick = self.tick;
        let delta = if move_ { num(patch, "start").unwrap_or(start) - start } else { 0.0 };
        let mut next = previous.as_obj().cloned().unwrap();
        for (key, value) in patch.as_obj().map(|o| o.iter().collect::<Vec<_>>()).unwrap_or_default() {
            next.set(key, value.clone());
        }
        if move_ && previous.get("restarts").is_some() {
            let prepared = self.prepared()?;
            let figure = prepared.doc.figure(num(&instance, "figure_type_id").unwrap() as u32).unwrap();
            let phase = styk_eval::eval::movieclip_time(figure.movieclip.as_ref().unwrap(), &styk_eval::load::playback(&previous), start, prepared.doc.fps);
            next.set("offset", phase.map(Value::Num).unwrap_or_else(|| previous.get("offset").unwrap().clone()));
            let restarts = items(previous.get("restarts"))
                .into_iter()
                .filter(|r| num(r, "tick").is_some_and(|t| t >= start))
                .map(|r| {
                    let mut r = r.as_obj().cloned().unwrap();
                    r.set("tick", Value::Num(num(&Value::object(r.clone()), "tick").unwrap() + delta));
                    Value::object(r)
                })
                .collect();
            next.set("restarts", Value::array(restarts));
        }
        let next = crate::movieclips::validate_playback(next)?;
        let prepare = self.sheet() && self.batch.is_none();
        self.movieclip_batch("Set movieclip timing", |editor| {
            if prepare { worker.as_deref_mut().unwrap().prepare(editor)?; }
            let channel = editor.native_movieclip_pose_channel()?;
            editor.edit_native_movieclip_poses("Set movieclip timing", |o| o.set("_stykMovieclip", next.clone()))?;
            let mut channels = Vec::new();
            for old in poses(&editor.report).into_iter().filter(|c| c.path(&["target", "uid"]).and_then(Value::as_f64) == Some(selected as f64)) {
                let mut c = if old.get("property").and_then(Value::as_str) == Some("pose") { channel.as_obj().cloned().unwrap() } else { old.as_obj().cloned().unwrap() };
                c.set("movieclipCurve", Value::Bool(true));
                shift_channel(&mut c, delta);
                c.set("clipEnd", next.get("end").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Num(0.0)));
                channels.push(Value::object(c));
            }
            if channels.is_empty() {
                let mut c = channel.as_obj().cloned().unwrap();
                shift_channel(&mut c, delta);
                c.set("clipEnd", next.get("end").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Num(0.0)));
                channels.push(Value::object(c));
            }
            if !move_ && num(&next, "start").unwrap() < start {
                let c = channels[0].make_obj().unwrap();
                let keys = c.get_mut("keys").and_then(Value::make_arr).unwrap();
                if keys.first().is_some_and(|k| num(k, "tick").unwrap() > num(&next, "start").unwrap()) {
                    let mut first = keys[0].as_obj().cloned().unwrap();
                    first.set("id", Value::str(&format!("clip-trim-{selected}-{}", num(&next, "start").unwrap())));
                    first.set("tick", next.get("start").unwrap().clone());
                    keys.insert(0, Value::object(first));
                }
            }
            if editor.sheet() { worker.as_deref_mut().unwrap().publish(editor, &channels, "Set movieclip timing")?; }
            else { editor.publish_native_channels(channels, "Set movieclip timing")?; }
            editor.seek(num(&next, "start").unwrap().max(num(&next, "end").map_or(tick, |e| e - 1.0).min(tick + delta)))?;
            editor.select(Some(selected), -1, false, false)?;
            Ok(next)
        })
    }

    pub(crate) fn split_native_movieclip(&mut self, tick: f64) -> Result<Value, EditError> {
        self.split_movieclip_with(tick, None)
    }

    pub(crate) fn split_movieclip_with(&mut self, tick: f64, mut worker: Option<&mut crate::movieclip_planning::TimelineWorker<'_>>) -> Result<Value, EditError> {
        if self.sheet() && worker.is_none() {
            return Err(EditError::Unported("splitting a movieclip on a layer sheet".into()));
        }
        let (_, instance, _) = self.selected_movieclip()?;
        let old_uid = uid(&instance).unwrap();
        let playback = Value::object(crate::movieclips::playback_settings(instance.get("_stykMovieclip")));
        if !tick.is_finite() || tick.fract() != 0.0 || tick <= num(&playback, "start").unwrap() || num(&playback, "end").is_some_and(|end| tick >= end) {
            return Err(EditError::Invalid("errors.editorMovieclips.placeThePlayheadInsideTheMovieclip".into()));
        }
        let prepared = self.prepared()?;
        let figure = prepared.doc.figure(num(&instance, "figure_type_id").unwrap() as u32).unwrap();
        let phase = styk_eval::eval::movieclip_time(figure.movieclip.as_ref().unwrap(), &styk_eval::load::playback(&playback), tick, prepared.doc.fps);
        let mut settings = playback.as_obj().cloned().unwrap();
        settings.set("start", Value::Num(tick));
        settings.set("offset", phase.map(Value::Num).unwrap_or_else(|| playback.get("offset").unwrap().clone()));
        settings.set("restarts", Value::array(items(playback.get("restarts")).into_iter().filter(|r| num(r, "tick").is_some_and(|t| t > tick)).collect()));
        let settings = crate::movieclips::validate_playback(settings)?;
        let prepare = self.sheet() && self.batch.is_none();
        self.movieclip_batch("Split movieclip", |editor| {
            if prepare { worker.as_deref_mut().unwrap().prepare(editor)?; }
            let original = editor.native_movieclip_pose_channel()?;
            if editor.next_uid > 0x7fff_fffe {
                return Err(EditError::Invalid("errors.editorLayerSheet.objectIdentityCapacityReached".into()));
            }
            let identity = editor.next_uid as u32;
            editor.next_uid += 1;
            let mut second = original.as_obj().cloned().unwrap();
            second.set("target", object(&[("kind", Value::str("figure")), ("uid", Value::Num(identity as f64))]));
            second.set("id", Value::str(&channel_id(identity)));
            second.set("clipEnd", playback.get("end").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Num(0.0)));
            second.set("orderAnchor", Value::Num(old_uid as f64));
            let mut sources: Vec<(String, String)> = Vec::new();
            let mut keys = Vec::new();
            for key in items(original.get("keys")) {
                let Some(id) = key.path(&["value", "frameId"]).and_then(Value::as_str) else {
                    keys.push(key);
                    continue;
                };
                let captured = match sources.iter().find(|(source, _)| source == id) {
                    Some((_, captured)) => captured.clone(),
                    None => {
                        let raw = editor.frame_by_id(id).ok_or_else(|| EditError::Invalid("errors.editorFrames.chooseAnExistingSourceFrame".into()))?;
                        let mut frame = styk_eval::records::snapshot_pose_frame_of(&raw, Some(&[old_uid as f64])).as_obj().cloned().unwrap();
                        if let Some(objects) = frame.get_mut("objects").and_then(Value::make_arr) {
                            for o in objects {
                                if uid(o) == Some(old_uid) {
                                    let o = o.make_obj().unwrap();
                                    o.set("unique_id", Value::Num(identity as f64));
                                    o.set("_stykMovieclip", settings.clone());
                                }
                            }
                        }
                        let order = crate::figures::frame_order(&frame).iter().map(|id| if *id == old_uid as f64 { identity as f64 } else { *id }).collect::<Vec<_>>();
                        crate::figures::set_order(&mut frame, &order);
                        crate::figures::normalize_frame(&mut frame);
                        let captured = editor.capture_native_pose(&Value::object(frame), None)?;
                        sources.push((id.into(), captured.clone()));
                        captured
                    }
                };
                let mut key = key.as_obj().cloned().unwrap();
                key.set("value", object(&[("frameId", Value::str(&captured))]));
                keys.push(Value::object(key));
            }
            second.set("keys", Value::array(keys));
            editor.layer_edit("Place movieclip figures", vec![(vec!["assignments".into(), identity.to_string()], Some(Value::str(&editor.layer_of(old_uid))), false)], true, None)?;
            editor.place_movieclip_with(&object(&[("end", Value::Num(tick))]), false, worker.as_deref_mut())?;
            if editor.sheet() { worker.as_deref_mut().unwrap().publish(editor, &[Value::object(second)], "Split movieclip")?; }
            else { editor.publish_native_channels(vec![Value::object(second)], "Split movieclip")?; }
            editor.seek(tick)?;
            editor.select(Some(identity), -1, false, false)?;
            Ok(editor.object()?.map(|(_, o)| o).unwrap_or(Value::Null))
        })
    }
}

fn shift_channel(channel: &mut Obj, delta: f64) {
    if let Some(keys) = channel.get_mut("keys").and_then(Value::make_arr) {
        for key in keys {
            let tick = num(key, "tick").unwrap();
            key.make_obj().unwrap().set("tick", Value::Num(tick + delta));
        }
    }
    if let Some(ranges) = channel.get("maskedRanges") {
        let shifted = items(Some(ranges))
            .iter()
            .filter_map(|range| {
                let pair = range.numbers()?;
                let a = (pair[0] + delta).max(0.0);
                let b = pair[1] + delta;
                (b > a).then(|| Value::array(vec![Value::Num(a), Value::Num(b)]))
            })
            .collect();
        channel.set("maskedRanges", Value::array(shifted));
    }
}

/// Projection shared by native and authored sheet descriptors.
fn project_pose_keys(keys: &[Value], present: &[usize]) -> Vec<Value> {
    if present.len() == keys.len() { return keys.to_vec(); }
    let blank = |index: usize| {
        let mut key = keys[index].as_obj().cloned().unwrap();
        key.set("value", object(&[("frameId", Value::Null)]));
        Value::object(key)
    };
    let mut result = Vec::new();
    if present.first().is_some_and(|first| *first > 0) { result.push(blank(0)); }
    for (at, index) in present.iter().copied().enumerate() {
        result.push(keys[index].clone());
        if index + 1 < keys.len() && present.get(at + 1) != Some(&(index + 1)) { result.push(blank(index + 1)); }
    }
    result
}
