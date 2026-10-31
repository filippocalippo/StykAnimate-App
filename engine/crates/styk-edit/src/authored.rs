//! Gestures on a layer sheet: a gesture edits a draft
//! of the frame on show, never the keys it was evaluated from, and commits by
//! capturing the draft into the tracks of the layers it changed ([`crate::sheet`]).

use std::collections::HashMap;

use styk_doc::{Obj, Value};

use crate::frame::objects_of;
use crate::record::{join_target, same, uid};
use crate::select::resolve_join_selection;
use crate::{Authored, Drag, EditError, Editor};

impl Editor {
    /// `_beginAuthoredPoseDrag(label, scope)`: drafts the frame at the playhead.
    pub(crate) fn begin_authored_drag(&mut self, label: &str, translation: bool) -> Result<bool, EditError> {
        if self.tick.fract() != 0.0 {
            // `Math.round`.
            self.tick = (self.tick + 0.5).floor();
        }
        let source = self.shown_frame()?;
        let objects = objects_of(&source);
        if !objects.iter().any(|o| uid(o).is_some_and(|u| self.selection.uids.contains(&u))) {
            return Ok(false);
        }
        // Moving takes whole connected figures; posing takes the selected figures and
        // what is joined to them, and leaves what they are joined to in place.
        let connected = resolve_join_selection(&objects, &self.selection.uids, true)?;
        let slots = if translation { connected } else { resolve_join_selection(&objects, &self.selection.uids, false)? };
        let slots = Editor::ik_pose_slots(&objects, slots);
        self.authored = Some(Authored { frame: source.clone(), source, tick: self.tick, transaction: false, definitions_start: None, key_at_playhead: false, key_at_playhead_layers: Vec::new() });
        self.drag = Some(Drag {
            label: label.to_string(),
            translation,
            index: self.frame_index,
            before: slots.iter().map(|&slot| objects[slot].clone()).collect(),
            before_selection: self.selection_state(),
            changed: false,
            detached: HashMap::new(),
            rotation_targets: HashMap::new(),
            spatial_gestures: HashMap::new(),
            spatial_kinds: HashMap::new(),
            ik_captures: HashMap::new(),
            spatial_ik_captures: HashMap::new(),
            ik_resume: HashMap::new(),
            handle_edit: None,
            figure_handle: None,
            segment_value_options: None,
            camera: None,
            rig: None,
            motion_path: None,
            duplicate: None,
            tweener: None,
            serial: self.next_drag_serial(),
            authored: true,
        });
        Ok(true)
    }

    /// `commitAuthoredPoseDrag`: nothing changed, or the draft goes to the layer sheet.
    pub(crate) fn commit_authored_drag(&mut self) -> Result<bool, EditError> { self.commit_authored_drag_checked(&mut || Ok(())) }
    pub(crate) fn commit_authored_drag_checked(&mut self, check: &mut dyn FnMut() -> Result<(), EditError>) -> Result<bool, EditError> {
        check()?;
        let (Some(drag), Some(_)) = (self.drag.as_ref(), self.authored.as_ref()) else { return Ok(false) };
        let before = drag.before.clone();
        self.synchronize_origins(&before)?;
        let (drag, edit) = (self.drag.as_ref().unwrap(), self.authored.as_ref().unwrap());
        let mut ids: Vec<u32> = drag.before.iter().filter_map(uid).collect();
        if edit.transaction {
            ids.extend(objects_of(&edit.frame).iter().filter_map(uid).filter(|u| !ids.contains(u)).collect::<Vec<_>>());
        }
        let after: Vec<Value> = objects_of(&edit.frame).into_iter().filter(|o| uid(o).is_some_and(|u| ids.contains(&u))).collect();
        // A gesture compares the figures it took; a command's draft, the whole frame.
        let unchanged = if edit.transaction { same(std::slice::from_ref(&edit.source), std::slice::from_ref(&edit.frame)) } else { same(&drag.before, &after) };
        if unchanged && edit.key_at_playhead_layers.is_empty() {
            self.drag = None;
            self.authored = None;
            self.retained = None;
            return Ok(false);
        }
        let committed = self.finish_authored_drag(&ids, &after, check);
        if committed.is_err() {
            // The draft is released on failure too, or every seek would retry it.
            self.cancel_authored_drag()?;
        }
        committed
    }

    fn finish_authored_drag(&mut self, ids: &[u32], after: &[Value], check: &mut dyn FnMut() -> Result<(), EditError>) -> Result<bool, EditError> {
        self.validate_spatial_joins()?;
        // A pose stores where its joined figures sit as well as their joins.
        if after.iter().any(|o| join_target(o).is_some()) {
            let roots = self.roots_of(ids)?;
            for (slot, object) in self.frame_objects().iter().enumerate() {
                let Some(id) = uid(object).filter(|u| ids.contains(u)) else { continue };
                if join_target(object).is_none() {
                    continue;
                }
                if let (Some(root), Some(record)) = (roots.get(&id), self.frame_object_mut(slot)) {
                    record.set("root_x", Value::Num(root[0]));
                    record.set("root_y", Value::Num(root[1]));
                }
            }
        }
        let before = self.drag.as_ref().map(|drag| drag.before.clone()).unwrap_or_default();
        self.synchronize_origins(&before)?;
        if self.sheet() { self.commit_sheet_pose() } else { self.commit_native_authored_drag_checked(check) }
    }

    /// Native `splitPosePropertyChanges` for the recorded unjoined whole-figure
    /// translation family. The existing Authored frame and scalar Draft are the
    /// only working heads; capture/source membership/history keep their owners.
    fn commit_native_authored_drag_checked(
        &mut self,
        check: &mut dyn FnMut() -> Result<(), EditError>,
    ) -> Result<bool, EditError> {
        check()?;
        let edit = self.authored.as_ref().ok_or_else(|| {
            EditError::Unported("a native authored commit without its draft".into())
        })?;
        if edit.transaction && self.native_channel_transaction() {
            return self.commit_native_transaction_checked(check);
        }
        let drag = self.drag.as_ref().unwrap();
        if edit.transaction || !self.options.property_channels {
            return Err(EditError::Unported(
                "an unrecorded native authored transaction".into(),
            ));
        }
        let source = edit.source.clone();
        let shown = edit.frame.clone();
        let tick = edit.tick;
        let ids = drag.before.iter().filter_map(uid).collect::<Vec<_>>();
        let label = drag.label.clone();
        let selection = drag.before_selection.clone();
        let before = objects_of(&source);
        let mut normalized = objects_of(&shown);
        let mut entries = Vec::new();
        let mut shape_ids = Vec::new();
        let channels = self
            .report
            .path(&["_styk", "animation", "channels"])
            .and_then(Value::elements)
            .map(|items| items.iter().collect::<Vec<_>>())
            .unwrap_or_default();
        self.with_records(|records| {
            for object in &mut normalized {
                check()?;
                let Some(id) = uid(object).filter(|id| ids.contains(id)) else {
                    continue;
                };
                let original = before
                    .iter()
                    .find(|old| uid(old) == Some(id))
                    .ok_or_else(|| {
                        EditError::Unported(
                            "a native authored translation without its original pose".into(),
                        )
                    })?;
                let mut target = Obj::new();
                target.set("kind", Value::str("figure"));
                target.set("uid", Value::Num(id as f64));
                let target = Value::object(target);
                for (property, field) in [("x", "root_x"), ("y", "root_y")] {
                    let authored = channels.iter().any(|channel| {
                        channel.path(&["target", "kind"]).and_then(Value::as_str) == Some("figure")
                            && channel.path(&["target", "uid"]).and_then(Value::as_f64)
                                == Some(id as f64)
                            && channel.get("property").and_then(Value::as_str) == Some(property)
                            && channel.get("keys").and_then(Value::array_len).unwrap_or(0) > 0
                    });
                    if !authored {
                        continue;
                    }
                    let value = records
                        .property_value(&shown, &target, property)?
                        .ok_or_else(|| {
                            EditError::Unported(
                                "an absent native authored translation target".into(),
                            )
                        })?;
                    let old = records.property_value(&source, &target, property)?.unwrap();
                    if value != old
                        && (value.as_f64().unwrap() - old.as_f64().unwrap()).abs() >= 1e-9
                    {
                        let mut entry = Obj::new();
                        entry.set("target", target.clone());
                        entry.set("property", Value::str(property));
                        entry.set("tick", Value::Num(tick));
                        entry.set("value", value);
                        entries.push(Value::object(entry));
                        object
                            .make_obj()
                            .unwrap()
                            .set(field, original.get(field).unwrap().clone());
                    }
                }
                // The admitted translation changes only roots. Reuse the same JS
                // round owner for the source's 1e9 comparable numeric shape.
                let shape = ["root_x", "root_y"].iter().any(|field| {
                    let compare = |value: &Value| {
                        crate::range_plan::js_round(
                            value.get(field).unwrap().as_f64().unwrap() * 1e9,
                        ) / 1e9
                    };
                    compare(object) != compare(original)
                });
                object.make_obj().unwrap().remove("runtime_segments");
                if shape {
                    shape_ids.push(id);
                }
            }
            Ok(())
        })?;
        let mut draft = crate::property_edit::NativeAnimationDraft::new(self);
        if !shape_ids.is_empty() {
            check()?;
            let mut frame = shown.as_obj().unwrap().clone();
            frame.set("objects", Value::array(normalized));
            let selected = shape_ids.iter().map(|id| *id as f64).collect::<Vec<_>>();
            let (source_id, captured) =
                self.native_pose_source(&Value::object(frame), Some(&selected), None)?;
            draft.write_source(source_id.clone(), captured);
            for id in shape_ids {
                let mut target = Obj::new();
                target.set("kind", Value::str("figure"));
                target.set("uid", Value::Num(id as f64));
                let mut value = Obj::new();
                value.set("frameId", Value::str(&source_id));
                let mut entry = Obj::new();
                entry.set("target", Value::object(target));
                entry.set("property", Value::str("pose"));
                entry.set("tick", Value::Num(tick));
                entry.set("value", Value::object(value));
                entries.push(Value::object(entry));
            }
        }
        for entry in &entries {
            draft.put_checked(self, entry, check)?;
        }
        check()?;
        self.drag = None;
        self.authored = None;
        let changed =
            draft.publish_checked(self, &label, selection, "Add animation keys", check)?;
        self.retained = Some(shown);
        Ok(changed)
    }

    /// `transaction` goes through the authored draft on a native timeline once it has saved
    /// channels (`animationChannels.length`), and with property channels commits as keys of the
    /// layers' poses (`splitPosePropertyChanges`).
    pub(crate) fn native_channel_transaction(&self) -> bool {
        !self.sheet()
            && self.options.property_channels
            && !self.options.layer_timeline
            && self.report.path(&["_styk", "animation", "channels"]).and_then(Value::array_len).unwrap_or(0) > 0
    }

    /// `commitAuthoredPoseDrag` of a command's draft on a native timeline with property channels:
    /// figures added to the frame on show. The draft's frame is captured as one pose source, and
    /// each layer holding a new figure (and every layer, once the draw order changed) keys that
    /// source at the playhead. Any other change to the frame is not recorded.
    fn commit_native_transaction_checked(&mut self, check: &mut dyn FnMut() -> Result<(), EditError>) -> Result<bool, EditError> {
        check()?;
        let (edit, drag) = (self.authored.as_ref().unwrap(), self.drag.as_ref().unwrap());
        let (source, shown, tick) = (edit.source.clone(), edit.frame.clone(), edit.tick);
        let (label, selection) = (drag.label.clone(), drag.before_selection.clone());
        let (before, after) = (objects_of(&source), objects_of(&shown));
        let unrecorded = || EditError::Unported("a native transaction that does more than add figures".into());
        // The figures that were there stand as they were, in their slots; the others follow them.
        if after.len() <= before.len() || !same(&before, &after[..before.len()]) { return Err(unrecorded()); }
        let fields = |frame: &Value| frame.as_obj().map(|record| record.iter().filter(|(key, _)| !["objects", "object_draw_order", "object_draw_order_unique_ids", "object_count"].contains(&key.as_ref())).map(|(key, value)| (key.to_string(), value.clone())).collect::<Vec<_>>()).unwrap_or_default();
        if fields(&source) != fields(&shown) { return Err(unrecorded()); }
        let mut layers: Vec<String> = Vec::new();
        for object in after[before.len()..].iter().chain(&after) {
            let layer = self.layer_of(uid(object).ok_or_else(unrecorded)?);
            if !layers.contains(&layer) { layers.push(layer); }
        }
        self.ensure_counts();
        let mut frame = shown.as_obj().cloned().unwrap_or_default();
        frame.set("objects", Value::array(after.into_iter().map(|mut object| { object.make_obj().map(|record| record.remove("runtime_segments")); object }).collect()));
        let (source_id, captured) = self.native_pose_source(&Value::object(frame), None, None)?;
        let mut draft = crate::property_edit::NativeAnimationDraft::new(self);
        draft.write_source(source_id.clone(), captured);
        for layer in layers {
            check()?;
            let mut target = Obj::new();
            target.set("kind", Value::str("layer"));
            target.set("id", Value::str(&layer));
            let mut value = Obj::new();
            value.set("frameId", Value::str(&source_id));
            let mut entry = Obj::new();
            entry.set("target", Value::object(target));
            entry.set("property", Value::str("pose"));
            entry.set("tick", Value::Num(tick));
            entry.set("value", Value::object(value));
            draft.put_checked(self, &Value::object(entry), check)?;
        }
        check()?;
        self.drag = None;
        self.authored = None;
        self.retained = None;
        draft.publish_checked(self, &label, selection, "Add animation keys", check)
    }

    /// Structural joins use the editor's single native-frame transaction. Other
    /// native transaction families remain refused at their existing owner.
    pub(crate) fn join_transaction(&mut self, label: &str, mutate: impl FnOnce(&mut Editor) -> Result<(), EditError>) -> Result<bool, EditError> {
        let recorded_native = self.unported_document().is_some_and(|reason| reason.starts_with("with animation origins"));
        self.transaction_impl(label, mutate, recorded_native)
    }

    pub(crate) fn native_frame_transaction(&mut self, label: &str, mutate: impl FnOnce(&mut Editor) -> Result<(), EditError>) -> Result<bool, EditError> {
        self.ensure_counts();
        let index = self.frame_index;
        let before = self.report.get("keyframes").and_then(|frames| frames.item(index)).ok_or_else(|| EditError::Invalid("a native transaction without a frame".into()))?;
        let before_selection = self.selection_state();
        let result = mutate(self).and_then(|()| self.synchronize_origins_with(&objects_of(&before), true));
        if let Err(error) = result {
            if let Some(frame) = self.report.make_obj().and_then(|report| report.get_mut("keyframes")).and_then(Value::make_arr).and_then(|frames| frames.get_mut(index)) { *frame = before; }
            self.restore_selection(&before_selection)?;
            self.retained = None;
            return Err(error);
        }
        let after = self.report.get("keyframes").and_then(|frames| frames.item(index)).unwrap();
        if before == after { return Ok(false); }
        self.retained = None;
        self.tick = crate::timeline::rows(&self.report).get(index).map(|row| row.start).unwrap_or(0.0);
        let layers = self.track_frames(std::slice::from_ref(&before), std::slice::from_ref(&after), true)?;
        self.record(crate::history::Command { kind: crate::history::CommandKind::Frame { index, before, after, structural: true }, label: label.into(), before_selection, after_selection: self.selection_state(), before_revision: 0, after_revision: 0, layer_changes: Vec::new(), captured_source_bytes: 0, layers })?;
        self.emit("edit", vec![("label", Value::str(label)), ("structural", Value::Bool(true))]);
        Ok(true)
    }

    /// `transaction(label, mutate)` on a layer sheet (`_authoredTransaction`): `mutate`
    /// changes a draft of the whole frame on show, figures included, which commits
    /// through the sheet like a gesture.
    pub(crate) fn transaction(&mut self, label: &str, mutate: impl FnOnce(&mut Editor) -> Result<(), EditError>) -> Result<bool, EditError> {
        self.transaction_impl(label, mutate, false)
    }

    fn transaction_impl(&mut self, label: &str, mutate: impl FnOnce(&mut Editor) -> Result<(), EditError>, native_join: bool) -> Result<bool, EditError> {
        if self.drag.is_some() {
            self.commit_drag()?;
        }
        if !self.sheet() && !self.native_channel_transaction() {
            if native_join { return self.native_frame_transaction(label, mutate); }
            return Err(EditError::Unported(format!("{label} on a native timeline")));
        }
        if self.tick.fract() != 0.0 {
            self.tick = (self.tick + 0.5).floor();
        }
        let source = self.shown_frame()?;
        let definitions_start = self.report.get("figure_types").and_then(Value::array_len).unwrap_or(0);
        self.authored = Some(Authored { frame: source.clone(), source: source.clone(), tick: self.tick, transaction: true, definitions_start: Some(definitions_start), key_at_playhead: false, key_at_playhead_layers: Vec::new() });
        self.drag = Some(Drag {
            label: label.to_string(),
            translation: false,
            index: self.frame_index,
            before: objects_of(&source),
            before_selection: self.selection_state(),
            changed: false,
            detached: HashMap::new(),
            rotation_targets: HashMap::new(),
            spatial_gestures: HashMap::new(),
            spatial_kinds: HashMap::new(),
            ik_captures: HashMap::new(),
            spatial_ik_captures: HashMap::new(),
            ik_resume: HashMap::new(),
            handle_edit: None,
            figure_handle: None,
            segment_value_options: None,
            camera: None,
            rig: None,
            motion_path: None,
            duplicate: None,
            tweener: None,
            serial: self.next_drag_serial(),
            authored: true,
        });
        let result = mutate(self).and_then(|()| self.synchronize_origins_with(&objects_of(&source), true)).and_then(|()| self.commit_authored_drag());
        if result.is_err() {
            if let Some(figures) = self.report.make_obj().and_then(|r| r.get_mut("figure_types")).and_then(Value::make_arr) {
                figures.truncate(definitions_start);
            }
            self.cancel_authored_drag()?;
        }
        result
    }

    /// The draft's frame record, to change (`this.frame` inside a transaction).
    pub(crate) fn draft_mut(&mut self) -> Option<&mut styk_doc::Obj> {
        self.authored.as_mut()?.frame.make_obj()
    }

    /// `cancelAuthoredPoseDrag`: the draft is dropped; the document was never touched.
    pub(crate) fn cancel_authored_drag(&mut self) -> Result<bool, EditError> {
        if self.authored.is_none() {
            return Ok(false);
        }
        let drag = self.drag.take();
        self.authored = None;
        self.retained = None;
        let mut changed = Vec::new();
        if let Some(drag) = drag {
            self.restore_selection(&drag.before_selection)?;
            changed = drag.before.iter().filter_map(uid).map(|u| Value::Num(u as f64)).collect();
        }
        self.emit("edit", vec![("label", Value::str("Cancel pose")), ("animation", Value::Bool(true)), ("changedUids", Value::array(changed))]);
        Ok(true)
    }
}
