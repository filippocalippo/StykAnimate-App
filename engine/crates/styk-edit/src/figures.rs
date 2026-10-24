//! Commands on whole figures that draft the frame (`transaction` in src/editor.mjs):
//! `joinTo`, `unjoinFigure`, `joinFigure`, `deleteSelection`, `duplicateFigure`.
//! On a layer sheet they commit through the planner like a gesture, and may add or
//! remove figures.

use styk_doc::{Obj, Value};

use crate::frame::objects_of;
use crate::record::{join_target, num, uid};
use crate::history::{Command, CommandKind};
use crate::{EditError, Editor};

/// `setOrder(frame, ids)`: the drawing order as unique ids and as slots.
pub(crate) fn set_order(frame: &mut Obj, ids: &[f64]) {
    let objects: Vec<Value> = frame.get("objects").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
    let slot = |id: f64| objects.iter().position(|o| num(o, "unique_id") == Some(id));
    frame.set("object_draw_order_unique_ids", Value::array(ids.iter().map(|id| Value::Num(*id)).collect()));
    frame.set("object_draw_order", Value::array(ids.iter().map(|id| slot(*id).map_or(Value::Null, |slot| Value::Num(slot as f64))).collect()));
}

/// `frameOrder(frame)`.
pub(crate) fn frame_order(frame: &Obj) -> Vec<f64> {
    let objects: Vec<Value> = frame.get("objects").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
    match frame.get("object_draw_order").filter(|o| o.truthy()) {
        Some(order) => order.numbers().unwrap_or_default().into_iter().filter_map(|slot| objects.get(slot as usize).filter(|_| slot >= 0.0).and_then(|o| num(o, "unique_id"))).collect(),
        None => objects.iter().filter_map(|o| num(o, "unique_id")).collect(),
    }
}

/// `createObject(figure, uid, x, y)` (src/demo.mjs): a figure of a definition in its
/// definition's pose.
pub(crate) fn create_object(figure: &Value, identity: u32, x: f64, y: f64) -> Value {
    let angles: Vec<Value> = figure.get("segments").and_then(Value::elements).map(|e| e.iter().map(|s| s.get("angle_rad").cloned().unwrap_or(Value::Null)).collect()).unwrap_or_default();
    let mut object = Obj::new();
    object.set("object_slot", Value::Num(0.0));
    object.set("unique_id", Value::Num(identity as f64));
    object.set("figure_type_id", figure.get("figure_type_id").cloned().unwrap_or(Value::Null));
    object.set("root_x", Value::Num(x));
    object.set("root_y", Value::Num(y));
    object.set("scale", Value::Num(1.0));
    object.set("color_override_raw", Value::Num(0.0));
    object.set("field28", Value::Num(0.0));
    object.set("angles", Value::array(angles));
    object.set("len_flag", Value::Num(0.0));
    object.set("lengths", Value::array(Vec::new()));
    object.set("bend_flag", Value::Num(0.0));
    object.set("bends", Value::array(Vec::new()));
    object.set("join", Value::Null);
    Value::object(object)
}

/// `createObject`'s pivot for a figure with an animation origin (`{initialize: true}`): a support figure gets its ghosts;
/// the synchronization of the frame the figure is added to places the pivot.
pub(crate) fn with_origin_pivot(figure: &Value, mut object: Value) -> Value {
    if figure.path(&["_styk", "animationOrigin"]).is_some_and(Value::truthy) {
        let record = object.make_obj().unwrap();
        crate::origin::reset_support(figure, record);
        if !record.contains("_stykAnimationOrigin") {
            record.set("_stykAnimationOrigin", Value::object(Obj::new()));
        }
    }
    object
}

/// `{...join, [key]: value}` on a figure's join, in place.
fn set_join_field(object: &mut Obj, key: &str, value: Option<Value>) {
    let Some(mut join) = object.get("join").filter(|j| j.truthy()).and_then(Value::as_obj).cloned() else { return };
    match value {
        Some(value) => join.set(key, value),
        None => {
            join.remove(key);
        }
    }
    object.set("join", Value::object(join));
}

/// `normalizeFrame(frame)`: slots follow unique ids, joins follow their figures, the
/// drawing order keeps naming the same figures.
pub(crate) fn normalize_frame(frame: &mut Obj) {
    let ids = frame_order(frame);
    let objects: Vec<Value> = frame.get("objects").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
    let mut records: Vec<Obj> = objects
        .iter()
        .map(|object| {
            let mut record = object.as_obj().cloned().unwrap_or_default();
            let target = join_target(object).and_then(|slot| objects.get(slot)).and_then(|o| o.get("unique_id").cloned());
            set_join_field(&mut record, "target_unique_id", target);
            record
        })
        .collect();
    let id_of = |record: &Obj| record.get("unique_id").and_then(Value::as_f64).unwrap_or(f64::NAN);
    records.sort_by_key(|record| id_of(record) as i64 as i32);
    let slots: Vec<f64> = records.iter().map(id_of).collect();
    let normalized = records.into_iter().enumerate().map(|(slot, mut record)| {
        record.set("object_slot", Value::Num(slot as f64));
        let target = record.get("join").and_then(|j| num(j, "target_unique_id")).and_then(|u| slots.iter().position(|id| *id == u));
        set_join_field(&mut record, "target_object_slot", target.map(|slot| Value::Num(slot as f64)));
        Value::object(record)
    });
    frame.set("objects", Value::array(normalized.collect()));
    set_order(frame, &ids);
}

impl Editor {
    /// `editor.selectedSlot`: the slot of the selected figure in the selection frame.
    fn selected_slot(&self) -> Result<Option<usize>, EditError> {
        let frame = self.selection_frame()?;
        Ok(self.selection.uid.and_then(|selected| frame.iter().position(|o| uid(o) == Some(selected))))
    }

    /// `joinTo(targetUid, handleId)`.
    pub(crate) fn join_to(&mut self, target: Option<f64>, handle: &Value) -> Result<bool, EditError> {
        let Some((_, object)) = self.object()? else { return Ok(false) };
        let handle = if handle.is_null() { Some(0.0) } else { handle.as_f64() };
        let frame = self.selection_frame()?;
        let slot = self.selected_slot()?;
        let target_slot = target.and_then(|target| frame.iter().position(|o| num(o, "unique_id") == Some(target)));
        let figures: Vec<Value> = self.report.get("figure_types").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
        let handles = |figure: &Value| -> Vec<f64> {
            let segments = figure.get("segments").and_then(Value::elements).map(|e| e.iter().collect::<Vec<_>>()).unwrap_or_default();
            std::iter::once(0.0).chain(segments.iter().filter_map(|s| num(s, "segment_id"))).collect()
        };
        let valid = target_slot.filter(|&t| Some(t) != slot).and_then(|t| figures.iter().find(|f| num(f, "figure_type_id") == num(&frame[t], "figure_type_id"))).is_some_and(|figure| handle.is_some_and(|h| handles(figure).contains(&h)));
        let (Some(target_slot), true) = (target_slot, valid) else { return Err(EditError::Invalid("errors.editor.chooseAnotherFigureAndAValidJoint".into())) };
        let mut current = target_slot;
        let mut steps = 0;
        while let Some(parent) = frame.get(current).and_then(join_target) {
            current = parent;
            steps += 1;
            if Some(current) == slot || steps > frame.len() {
                return Err(EditError::Invalid("errors.editor.joiningTheseFiguresWouldCreateACycle".into()));
            }
        }
        let selected = uid(&object);
        let mut join = Obj::new();
        join.set("target_object_slot", Value::Num(target_slot as f64));
        join.set("target_unique_id", Value::Num(target.unwrap()));
        join.set("target_handle_id", Value::Num(handle.unwrap()));
        self.join_transaction("Join figures", |editor| {
            let at = editor.frame_objects().iter().position(|o| uid(o) == selected);
            if let Some(record) = at.and_then(|at| editor.frame_object_mut(at)) {
                record.set("join", Value::object(join));
            }
            Ok(())
        })
    }

    /// `unjoinFigure()`: the figure stays where its join held it.
    pub(crate) fn unjoin_figure(&mut self) -> Result<bool, EditError> {
        let Some((_, object)) = self.object()?.filter(|(_, o)| join_target(o).is_some()) else { return Ok(false) };
        let selected = uid(&object);
        let root = match self.selected_slot()? {
            Some(_) => selected.and_then(|u| self.roots_of(&[u]).ok()?.get(&u).copied()),
            None => None,
        };
        self.join_transaction("Unjoin figure", |editor| {
            let at = editor.frame_objects().iter().position(|o| uid(o) == selected);
            if let Some(record) = at.and_then(|at| editor.frame_object_mut(at)) {
                if let Some(root) = root {
                    record.set("root_x", Value::Num(root[0]));
                    record.set("root_y", Value::Num(root[1]));
                }
                record.set("join", Value::Null);
            }
            Ok(())
        })
    }

    /// `sheetDeleteFigures(selected)`: with a movieclip among them, the selected figures leave
    /// the cell at the playhead as replacements by nothing, so the clips' membership changes
    /// without the surrounding motion being sampled again; the selection is emptied.
    fn sheet_delete_figures(&mut self, selected: &[u32]) -> Result<bool, EditError> {
        let mut ids: Vec<String> = Vec::new();
        for &figure in selected {
            let layer = self.layer_of(figure);
            if !ids.contains(&layer) {
                ids.push(layer);
            }
        }
        let mut plan = self.planner(&ids)?;
        let tick = self.tick;
        for &figure in selected {
            let layer = self.layer_of(figure);
            self.replace_at(&mut plan, &layer, tick, figure, &crate::sheet::create_frame(&[]), None, tick + 1.0)?;
        }
        let selection = self.selection_state();
        self.selection = crate::Selection { uid: None, uids: Vec::new(), joint: -1 };
        self.publish(plan, "Delete figures", selection, None)
    }

    /// `deleteSelection()`: the selected figures leave the frame; figures joined to
    /// them stay where the join held them.
    pub(crate) fn delete_selection(&mut self) -> Result<bool, EditError> {
        let selected: Vec<u32> = self.selected_objects()?.iter().filter_map(uid).collect();
        if selected.is_empty() {
            return Ok(false);
        }
        let figures: Vec<Value> = self.report.get("figure_types").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
        let clip = |object: &Value| figures.iter().find(|f| num(f, "figure_type_id") == num(object, "figure_type_id")).is_some_and(|f| f.path(&["_styk", "movieclip"]).is_some_and(Value::truthy));
        if self.sheet() && self.selected_objects()?.iter().any(clip) {
            return self.sheet_delete_figures(&selected);
        }
        let roots = self.roots()?;
        let gone = |object: &Value| uid(object).is_some_and(|u| selected.contains(&u));
        self.transaction("Delete figures", |editor| {
            let Some(frame) = editor.draft_mut() else { return Ok(()) };
            let objects = objects_of(&Value::object(frame.clone()));
            let order: Vec<f64> = frame_order(frame).into_iter().filter(|u| !selected.contains(&(*u as u32))).collect();
            let mut kept = Vec::new();
            for object in &objects {
                let mut record = object.as_obj().cloned().unwrap_or_default();
                if let Some(parent) = join_target(object).and_then(|slot| objects.get(slot)) {
                    set_join_field(&mut record, "target_unique_id", parent.get("unique_id").cloned());
                    if !gone(object) && gone(parent) {
                        if let Some(root) = uid(object).and_then(|u| roots.get(&u)) {
                            record.set("root_x", Value::Num(root[0]));
                            record.set("root_y", Value::Num(root[1]));
                        }
                        record.set("join", Value::Null);
                    }
                }
                if !gone(object) {
                    kept.push(record);
                }
            }
            let ids: Vec<f64> = kept.iter().map(|record| record.get("unique_id").and_then(Value::as_f64).unwrap_or(f64::NAN)).collect();
            let renumbered = kept.into_iter().enumerate().map(|(slot, mut record)| {
                record.set("object_slot", Value::Num(slot as f64));
                let target = record.get("join").and_then(|j| num(j, "target_unique_id")).and_then(|u| ids.iter().position(|id| *id == u));
                set_join_field(&mut record, "target_object_slot", target.map(|slot| Value::Num(slot as f64)));
                Value::object(record)
            });
            frame.set("objects", Value::array(renumbered.collect()));
            set_order(frame, &order);
            editor.selection = crate::Selection { uid: None, uids: Vec::new(), joint: -1 };
            Ok(())
        })
    }

    /// `duplicateFigure()`: a copy of the selected figure beside it, selected.
    pub(crate) fn duplicate_figure(&mut self) -> Result<Value, EditError> {
        if self.selected_objects()?.len() > 1 {
            return Err(EditError::Unported("duplicating several figures".into()));
        }
        let Some((_, object)) = self.object()? else { return Ok(Value::Null) };
        let figures: Vec<Value> = self.report.get("figure_types").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
        if figures.iter().find(|f| num(f, "figure_type_id") == num(&object, "figure_type_id")).is_some_and(|f| f.path(&["_styk", "movieclip"]).is_some_and(Value::truthy)) {
            return Err(EditError::Unported("duplicating a movieclip instance".into()));
        }
        if self.next_uid > 0x7fff_fffe {
            return Err(EditError::Invalid("errors.editorLayerSheet.objectIdentityCapacityReached".into()));
        }
        let identity = self.next_uid;
        self.next_uid += 1;
        let original = uid(&object);
        let mut copy = object.as_obj().cloned().unwrap_or_default();
        copy.set("unique_id", Value::Num(identity as f64));
        copy.remove("_stykMovieclipPart");
        if let Some(original) = original {
            let layer = self.layer_of(original);
            self.new_layer_hints.insert(identity as u32, layer);
        }
        let root = match self.selected_slot()? {
            Some(_) => original.and_then(|u| self.roots_of(&[u]).ok()?.get(&u).copied()),
            None => None,
        };
        let at = |key: &str, world: Option<f64>| world.or_else(|| copy.get(key).and_then(Value::as_f64)).unwrap_or(f64::NAN) + 24.0;
        let (x, y) = (at("root_x", root.map(|r| r[0])), at("root_y", root.map(|r| r[1])));
        copy.set("root_x", Value::Num(x));
        copy.set("root_y", Value::Num(y));
        // Every controller target of the copy moves with it.
        let source = Value::object(copy.clone());
        crate::ik::translate_targets(&mut copy, 24.0, 24.0, &source, false);
        copy.set("join", Value::Null);
        let copy = Value::object(copy);
        self.transaction("Duplicate figure", |editor| {
            let Some(frame) = editor.draft_mut() else { return Ok(()) };
            let mut ids = frame_order(frame);
            let mut objects = objects_of(&Value::object(frame.clone()));
            objects.push(copy);
            frame.set("objects", Value::array(objects));
            ids.push(identity as f64);
            set_order(frame, &ids);
            normalize_frame(frame);
            editor.selection = crate::Selection { uid: Some(identity as u32), uids: vec![identity as u32], joint: -1 };
            Ok(())
        })?;
        Ok(self.object()?.map(|(_, o)| o).unwrap_or(Value::Null))
    }

    /// `addFigure(typeId)`: a new figure of a library definition in the middle of the
    /// canvas, at the playhead (`applyFigureRange({kind: 'add'}, {atPlayhead: true})`), selected.
    pub(crate) fn add_figure(&mut self, type_id: Option<&Value>) -> Result<Value, EditError> {
        let figures: Vec<Value> = self.report.get("figure_types").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
        // `typeId = this.report.figure_types[0]?.figure_type_id` when not given.
        let wanted = match type_id {
            Some(id) => id.clone(),
            None => figures.first().and_then(|f| f.get("figure_type_id").cloned()).unwrap_or(Value::Null),
        };
        let figure = figures.iter().find(|f| f.get("figure_type_id").is_some_and(|id| *id == wanted && !wanted.is_null())).cloned();
        let Some(figure) = figure else { return Err(EditError::Invalid("errors.editor.chooseAFigureFromTheLibrary".into())) };
        if figure.path(&["_styk", "movieclip"]).is_some_and(Value::truthy) {
            if !self.sheet() {
                return self.insert_native_movieclip(&figure);
            }
            return Err(EditError::Unported("adding a movieclip".into()));
        }
        if !self.sheet() {
            return Err(EditError::Unported("adding a figure on a native timeline".into()));
        }
        if self.drag.is_some() {
            self.commit_drag()?;
        }
        if self.next_uid > 0x7fff_fffe {
            return Err(EditError::Invalid("errors.editorLayerSheet.objectIdentityCapacityReached".into()));
        }
        let (x, y) = (num(&self.report, "canvas_width").unwrap_or(f64::NAN) / 2.0, num(&self.report, "canvas_height").unwrap_or(f64::NAN) / 2.0);
        if !x.is_finite() || !y.is_finite() {
            return Err(EditError::Invalid("errors.editorRangeCommands.figurePositionMustBeFinite".into()));
        }
        let identity = self.next_uid;
        let object = with_origin_pivot(&figure, create_object(&figure, identity as u32, x, y));
        // `insert(frame, payload)`: the frame on show with the figure added, slots following
        // unique ids, drawn in front.
        let shown = self.shown_frame()?;
        let mut frame = shown.as_obj().cloned().unwrap_or_default();
        let mut ids = frame_order(&frame);
        let mut objects = objects_of(&Value::object(frame.clone()));
        if objects.len() >= 65535 {
            return Err(EditError::Invalid("errors.editorRangeCommands.aNativeKeyframeSupportsAtMost65535".into()));
        }
        objects.push(object);
        let count = objects.len();
        frame.set("objects", Value::array(objects));
        ids.push(identity as f64);
        set_order(&mut frame, &ids);
        normalize_frame(&mut frame);
        if frame.get("object_count").is_some() {
            frame.set("object_count", Value::Num(count as f64));
        }
        // Published, the figure is selected and the next identity taken; refused, neither.
        let (selection, previous) = (self.selection_state(), self.selection.clone());
        self.selection = crate::Selection { uid: Some(identity as u32), uids: vec![identity as u32], joint: -1 };
        self.next_uid += 1;
        let mut frame = Value::object(frame);
        self.synchronize_origin_frame(&mut frame, &objects_of(&shown), true)?;
        if let Err(error) = self.commit_sheet_range_with(&frame, &[identity as u32], &[identity as u32], &std::collections::HashMap::new(), Vec::new(), "Add figure", selection) {
            self.selection = previous;
            self.next_uid = identity;
            return Err(error);
        }
        Ok(self.object()?.map(|(_, o)| o).unwrap_or(Value::Null))
    }

    /// `updateObject(patch)`: the inspector's figure fields (several figures: `updateSelection`).
    pub(crate) fn update_object(&mut self, patch: &Value) -> Result<bool, EditError> {
        const SHARED: [&str; 5] = ["color_override_raw", "field28", "image_text_flags", "name", "_styk"];
        let entries: Vec<(String, Value)> = patch.as_obj().map(|o| o.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()).unwrap_or_default();
        if self.selected_objects()?.len() > 1 && entries.iter().all(|(k, _)| SHARED.contains(&k.as_str())) {
            return self.update_selection(patch);
        }
        let given = |key: &str| entries.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone());
        for field in ["root_x", "root_y", "scale"] {
            if let Some(value) = given(field)
                && !value.as_f64().is_some_and(f64::is_finite)
            {
                return Err(crate::transform::not_finite(field));
            }
        }
        if given("scale").and_then(|v| v.as_f64()).is_some_and(|scale| scale < 0.0) {
            return Err(EditError::Invalid("errors.editor.scaleCannotBeNegative".into()));
        }
        if let Some(opacity) = given("field28")
            && !opacity.as_f64().is_some_and(|o| o.fract() == 0.0 && (0.0..=255.0).contains(&o))
        {
            return Err(EditError::Invalid("errors.editor.opacityMustBeAByte".into()));
        }
        if ["unique_id", "figure_type_id", "object_slot", "join"].iter().any(|key| given(key).is_some()) {
            return Err(EditError::Invalid("errors.editor.useStructuralOperationsToChangeFigureIdentityOr".into()));
        }
        let Some((slot, _)) = self.object()? else { return Ok(false) };
        self.object_edit_with("Edit figure", false, |editor| {
            let record = editor.frame_object_mut(slot).unwrap();
            for (key, value) in &entries {
                record.set(key, value.clone());
            }
            record.remove("runtime_segments");
            Ok(())
        })
    }

    /// `updateSelection(patch)`: names, colours, opacity, mirroring and metadata of every
    /// selected figure, in one edit.
    pub(crate) fn update_selection(&mut self, patch: &Value) -> Result<bool, EditError> {
        const SHARED: [&str; 5] = ["color_override_raw", "field28", "image_text_flags", "name", "_styk"];
        let entries: Vec<(String, Value)> = patch.as_obj().map(|o| o.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()).unwrap_or_default();
        if entries.iter().any(|(k, _)| !SHARED.contains(&k.as_str())) {
            return Err(EditError::Invalid("errors.editor.useGroupTransformCommandsToChangeSelectionGeometry".into()));
        }
        self.object_edit_with("Edit selected figures", false, |editor| {
            let selected = editor.selection.uids.clone();
            let slots: Vec<usize> = editor.frame_objects().iter().enumerate().filter(|(_, o)| uid(o).is_some_and(|u| selected.contains(&u))).map(|(slot, _)| slot).collect();
            for slot in slots {
                let record = editor.frame_object_mut(slot).unwrap();
                for (key, value) in &entries {
                    record.set(key, value.clone());
                }
                record.remove("runtime_segments");
            }
            Ok(())
        })
    }

    /// `updateSegment(patch)`: the selected joint's pose fields (`angle_rad`, `length`,
    /// `bend_rad`, one posed edit) and its definition's style fields (one `figure` entry).
    pub(crate) fn update_segment(&mut self, patch: &Value) -> Result<bool, EditError> {
        let Some((slot, object)) = self.object()? else { return Ok(false) };
        let definition = self.figure_value(&object);
        let segments: Vec<Value> = definition.get("segments").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
        let index = self.selection.joint;
        if definition.is_null() || index < 0 || index as usize >= segments.len() {
            return Ok(false);
        }
        let index = index as usize;
        let entries: Vec<(String, Value)> = patch.as_obj().map(|o| o.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()).unwrap_or_default();
        let given = |key: &str| entries.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone());
        let byte = |v: &Value| v.as_f64().is_some_and(|n| n.fract() == 0.0 && (0.0..=255.0).contains(&n));
        if let Some(color) = given("color_rgb")
            && !color.elements().map(|e| e.iter().collect::<Vec<_>>()).is_some_and(|c| c.len() == 3 && c.iter().all(byte))
        {
            return Err(EditError::Invalid("errors.editor.colorMustContainThreeRgbBytes".into()));
        }
        if given("transparency").is_some_and(|t| !byte(&t)) {
            return Err(EditError::Invalid("errors.editor.transparencyMustBeAByte".into()));
        }
        if given("primitive_code").is_some_and(|p| !p.as_f64().is_some_and(|n| n.fract() == 0.0 && (0.0..=6.0).contains(&n))) {
            return Err(EditError::Invalid("errors.editor.unknownSegmentPrimitive".into()));
        }
        let mut pose: Vec<(&str, f64)> = Vec::new();
        for field in ["angle_rad", "length", "bend_rad"] {
            if let Some(value) = given(field) {
                let Some(value) = value.as_f64().filter(|v| v.is_finite()) else { return Err(crate::transform::not_finite(field)) };
                pose.push((field, value));
            }
        }
        let style: Vec<(String, Value)> = entries.iter().filter(|(k, _)| !["angle_rad", "length", "bend_rad"].contains(&k.as_str())).cloned().collect();
        let segment = segments[index].clone();
        let connector = segment.path(&["_stykRig", "connector"]).is_some_and(Value::truthy);
        if let Some((_, length)) = pose.iter().find(|(k, _)| *k == "length")
            && (*length < 0.0 || (connector && *length > 1.0))
        {
            return Err(EditError::Invalid("errors.editor.connectorPositionMustBe01SegmentLengths".into()));
        }
        if !pose.is_empty() {
            let lengths: Vec<Value> = segments.iter().map(|s| s.get("length").cloned().unwrap_or(Value::Null)).collect();
            let bends: Vec<Value> = segments.iter().map(|s| s.get("bend_rad").cloned().filter(|b| !b.is_null()).unwrap_or(Value::Num(0.0))).collect();
            let rest_bend = segment.get("bend_rad").and_then(Value::as_f64).unwrap_or(0.0);
            let value = |key: &str| pose.iter().find(|(k, _)| *k == key).map(|(_, v)| *v);
            self.object_edit_with("Edit joint", true, |editor| {
                if let Some(angle) = value("angle_rad") {
                    let current = editor.frame_objects()[slot].get("angles").and_then(|a| a.item(index)).and_then(|v| v.as_f64()).unwrap_or(f64::NAN);
                    editor.rotate_joint_by(slot, index, angle - current, true, false)?;
                }
                if let Some(length) = value("length") {
                    let record = editor.frame_object_mut(slot).unwrap();
                    if !record.get("len_flag").is_some_and(Value::truthy) {
                        record.set("lengths", Value::array(lengths.clone()));
                    }
                    record.set("len_flag", Value::Num(1.0));
                    crate::pose::set_item_at(record, "lengths", index, length);
                }
                if let Some(bend) = value("bend_rad") {
                    let record = &editor.frame_objects()[slot];
                    let previous = if record.get("bend_flag").is_some_and(Value::truthy) { record.get("bends").and_then(|b| b.item(index)).and_then(|v| v.as_f64()).unwrap_or(f64::NAN) } else { rest_bend };
                    editor.rotate_joint_by(slot, index, bend - previous, false, false)?;
                    let record = editor.frame_object_mut(slot).unwrap();
                    if !record.get("bend_flag").is_some_and(Value::truthy) {
                        record.set("bends", Value::array(bends.clone()));
                    }
                    record.set("bend_flag", Value::Num(1.0));
                    crate::pose::set_item_at(record, "bends", index, bend);
                }
                editor.frame_object_mut(slot).unwrap().remove("runtime_segments");
                Ok(())
            })?;
        }
        if style.is_empty() {
            return Ok(true);
        }
        if style.iter().any(|(k, _)| k == "segment_id" || k == "parent_id") {
            return Err(EditError::Invalid("errors.editor.useTheFigureBuilderToChangeJointHierarchy".into()));
        }
        if let Some((_, thickness)) = style.iter().find(|(k, _)| k == "thickness") {
            let Some(thickness) = thickness.as_f64().filter(|t| t.is_finite()) else { return Err(crate::transform::not_finite("Thickness")) };
            if thickness < 0.0 {
                return Err(EditError::Invalid("errors.editor.thicknessCannotBeNegative".into()));
            }
        }
        let figures: Vec<Value> = self.report.get("figure_types").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
        let Some(figure_index) = figures.iter().position(|f| f.get("figure_type_id") == object.get("figure_type_id")) else { return Ok(false) };
        let before = figures[figure_index].clone();
        let selection = self.selection_state();
        let mut changed = segment.as_obj().cloned().unwrap_or_default();
        for (key, value) in &style {
            changed.set(key, value.clone());
        }
        // Raw definition flags follow the edit (`aux_code`, `segment_kind`, `segment_type`, `flags`, `visible`).
        let number = |o: &Obj, key: &str| o.get(key).and_then(Value::as_f64).unwrap_or(0.0);
        if let Some((_, is_static)) = style.iter().find(|(k, _)| k == "is_static") {
            // `(s.aux_code ?? 0) & ~1 | Number(s.is_static)`, in 32-bit integers.
            let bit = match is_static {
                Value::Bool(b) => *b as i32,
                other => other.as_f64().filter(|n| n.is_finite()).map_or(0, |n| n as i64 as i32),
            };
            let aux = (number(&changed, "aux_code") as i64 as i32 & !1) | bit;
            changed.set("aux_code", Value::Num(aux as f64));
        }
        if style.iter().any(|(k, _)| k == "primitive_code") {
            let code = number(&changed, "primitive_code") as usize;
            const KINDS: [&str; 7] = ["line", "circle", "image", "circleFill", "circleClear", "text", "squareLine"];
            changed.set("segment_kind", Value::str(KINDS[code.min(6)]));
            let kind = match code {
                1 | 3 | 4 => "circle",
                2 => "image",
                5 => "text",
                _ => "line",
            };
            changed.set("segment_type", Value::str(kind));
        }
        let code = number(&changed, "primitive_code") as i64 as i32;
        let aux = number(&changed, "aux_code") as i64 as i32;
        changed.set("flags", Value::Num((code | aux.wrapping_shl(8)) as f64));
        let thickness = changed.get("thickness").and_then(Value::as_f64).unwrap_or(f64::NAN);
        changed.set("visible", Value::Bool(thickness > 0.01 || code > 0));
        let mut after = before.as_obj().cloned().unwrap_or_default();
        let mut list: Vec<Value> = segments.clone();
        list[index] = Value::object(changed);
        after.set("segments", Value::array(list));
        let after = Value::object(after);
        if let Some(slot) = self.report.make_obj().and_then(|r| r.get_mut("figure_types")).and_then(Value::make_arr).and_then(|f| f.get_mut(figure_index)) {
            *slot = after.clone();
        }
        self.record(Command { kind: CommandKind::Figure { index: figure_index, before, after }, label: "Edit segment style".into(), before_selection: selection.clone(), after_selection: selection, before_revision: 0, after_revision: 0, layer_changes: Vec::new(), captured_source_bytes: 0, layers: false })?;
        self.emit("edit", vec![("label", Value::str("Edit segment style")), ("definition", Value::Bool(true))]);
        Ok(true)
    }
}
