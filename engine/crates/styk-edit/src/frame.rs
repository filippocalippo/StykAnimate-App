//! The frames a command reads and writes: the keyframe or the draft being edited
//! (`editor.frame`), the frame selection reads (`editor.selectionFrame`), the frame on
//! show and its geometry (`editor.evaluatedFrame`, `editor.geometry`).
//!
//! The evaluated frame comes from the engine's record evaluation
//! (`styk_eval::records`), byte for byte what the editor evaluates, and its geometry
//! from the typed view of that same record.

use std::sync::Arc;

use styk_doc::{Obj, Value};
use styk_eval::eval::Prepared;
use styk_eval::records::Records;

use crate::record::{frame_mut, uid};
use crate::{EditError, Editor};

/// What evaluation keeps between calls, for as long as the document does not change.
#[derive(Clone, Default)]
pub(crate) struct Cache {
    pub loader: styk_eval::load::Loader,
    /// The document the prepared/raw/typed views belong to (a shared node: any change to
    /// the editor's report makes it a different one).
    report: Option<Value>,
    prepared: Option<Arc<Prepared>>,
    /// Evaluated frames by tick and by whether movieclips were sampled; a few recent ones.
    frames: Vec<(u64, bool, bool, Value)>,
    /// Only the latest successfully converted shown frame. Object nodes may be
    /// reused within this Prepared lineage; geometry is always built afresh.
    latest_typed: Option<Arc<EditFramePair>>,
}

struct EditFramePair {
    prepared: Arc<Prepared>,
    record: Value,
    frame: styk_eval::eval::Frame,
}

impl Cache {
    pub(crate) fn typed_worker(&self, report: &Value) -> Option<(&styk_eval::load::Loader, &Arc<Prepared>)> {
        if !self.report.as_ref().is_some_and(|cached| cached.same_node(report)) { return None; }
        Some((&self.loader, self.prepared.as_ref()?))
    }

    pub(crate) fn edit_frame(&mut self, record: &Value, prepared: &Arc<Prepared>) -> Result<styk_eval::eval::Frame, styk_eval::Error> {
        let _scope = crate::prof::scope("frame::edit_frame");
        let previous = self.latest_typed.as_ref().filter(|pair| Arc::ptr_eq(&pair.prepared, prepared)).cloned();
        if let Some(pair) = &previous {
            if pair.record.same_node(record) { return Ok(pair.frame.clone()); }
        }
        // Loader's null convention is a delta protocol, not a literal null in
        // the shown record. Only a complete, non-null object array can use it.
        let reusable = previous.as_ref().filter(|pair| {
            let Some(current) = record.get("objects").and_then(Value::as_arr) else { return false; };
            let Some(old) = pair.record.get("objects").and_then(Value::as_arr) else { return false; };
            current.len() == old.len() && current.len() == pair.frame.objects.len()
                && current.iter().all(Value::is_object)
        });
        let delta = reusable.and_then(|pair| {
            let current = record.get("objects")?.as_arr()?;
            let old = pair.record.get("objects")?.as_arr()?;
            if !current.iter().zip(old).any(|(item, old)| item.same_node(old)) { return None; }
            let mut value = record.as_obj()?.clone();
            value.set("objects", Value::array(current.iter().zip(old).map(|(item, old)| {
                if item.same_node(old) { Value::Null } else { item.clone() }
            }).collect()));
            Some(Value::object(value))
        });
        let frame = match (&delta, reusable) {
            (Some(delta), Some(pair)) => self.loader.edit_frame_reusing_ik(delta, &pair.record, &pair.frame, &prepared.doc),
            (None, Some(pair)) => self.loader.edit_frame_reusing_ik(record, &pair.record, &pair.frame, &prepared.doc),
            _ => self.loader.edit_frame(record, None, &prepared.doc),
        }?;
        // A failed conversion leaves the previous coherent pair intact. This
        // replaces a single pair rather than collecting every gesture draft.
        self.latest_typed = Some(Arc::new(EditFramePair { prepared: prepared.clone(), record: record.clone(), frame: frame.clone() }));
        Ok(frame)
    }
}

impl From<styk_eval::records::Error> for EditError {
    fn from(error: styk_eval::records::Error) -> EditError {
        match error {
            styk_eval::records::Error::Unported(what) => EditError::Unported(what),
            styk_eval::records::Error::Invalid(what) => EditError::Invalid(what),
        }
    }
}

pub(crate) fn objects_of(frame: &Value) -> Vec<Value> {
    frame.get("objects").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default()
}

impl Editor {
    /// Whether the document is edited through its layer sheet (always, in the app).
    pub(crate) fn sheet(&self) -> bool {
        self.report.path(&["_styk", "layerSheet"]).is_some()
    }

    /// Starts from typed views already made for the current document (the engine's
    /// mirror), and the loader that made them, so the first call converts nothing.
    pub fn adopt_prepared(&mut self, loader: styk_eval::load::Loader, prepared: Arc<Prepared>) {
        let mut cache = self.eval.borrow_mut();
        cache.loader = loader;
        cache.prepared = Some(prepared);
        cache.report = Some(self.report.clone());
        cache.frames.clear();
        cache.latest_typed = None;
    }

    /// The typed views of the current document.
    pub(crate) fn prepared(&self) -> Result<Arc<Prepared>, EditError> {
        let mut cache = self.eval.borrow_mut();
        if cache.prepared.is_none() || !cache.report.as_ref().is_some_and(|report| report.same_node(&self.report)) {
            let document = cache.loader.document(&self.report, "").map_err(|error| EditError::Invalid(error.to_string()))?;
            // The views of records the document and its history no longer hold go with them.
            cache.loader.release_unused();
            cache.prepared = Some(Arc::new(Prepared::new(Arc::new(document))));
            cache.report = Some(self.report.clone());
            cache.frames.clear();
            cache.latest_typed = None;
        }
        Ok(cache.prepared.clone().unwrap())
    }

    /// `evaluatedFrame(report, …, tick)` as records; without `clips`, the frame a
    /// key's pose is captured from (`at(report, tick)`: movieclips not sampled).
    pub(crate) fn evaluated(&self, tick: f64, clips: bool) -> Result<Value, EditError> {
        let _scope = crate::prof::scope("frame::evaluated");
        self.evaluated_mode(tick, clips, false)
    }

    fn evaluated_mode(&self, tick: f64, clips: bool, editor_native: bool) -> Result<Value, EditError> {
        let editor_native = editor_native && !self.sheet();
        let prepared = self.prepared()?;
        if let Some((_, _, _, frame)) = self.eval.borrow().frames.iter().find(|(at, with, editor, _)| *at == tick.to_bits() && *with == clips && *editor == editor_native) {
            return Ok(frame.clone());
        }
        let records = Records::new(&self.report, &prepared)?;
        let frame = if editor_native { records.evaluated_editor_with(tick, clips)? } else { records.evaluated_with(tick, clips)? };
        let mut cache = self.eval.borrow_mut();
        if cache.frames.len() >= 4 {
            cache.frames.remove(0);
        }
        cache.frames.push((tick.to_bits(), clips, editor_native, frame.clone()));
        Ok(frame)
    }

    /// `at(report, tick, {skipMovieclipPatches: true})`: movieclips not sampled and the keys'
    /// movieclip frame replacements left out.
    pub(crate) fn evaluated_without_patches(&self, tick: f64) -> Result<Value, EditError> {
        let prepared = self.prepared()?;
        Ok(Records::new(&self.report, &prepared)?.evaluated_options(tick, false, true)?)
    }

    /// `editor.evaluatedFrame`: the draft of the gesture in progress, else the
    /// document at the playhead.
    pub(crate) fn shown_frame(&self) -> Result<Value, EditError> {
        // A property edit shows its preview over everything else (`_sheetPropertyPreview`).
        if let Some(preview) = self.property_preview() {
            return Ok(preview);
        }
        match (&self.authored, &self.retained) {
            (Some(edit), _) => Ok(edit.frame.clone()),
            (None, Some(frame)) => Ok(frame.clone()),
            (None, None) => self.evaluated_mode(self.tick, true, true),
        }
    }

    /// The document at the playhead, with no gesture's draft, preview or retained frame over it:
    /// the frame a gesture is composed on.
    pub(crate) fn document_frame(&self) -> Result<Value, EditError> {
        self.evaluated_mode(self.tick, true, true)
    }

    /// `editor.selectionFrame.objects`: what selection reads. On a layer sheet the
    /// frame on show; on a native timeline with no saved channels the keyframe
    /// at the playhead.
    pub(crate) fn selection_frame(&self) -> Result<Vec<Value>, EditError> {
        if self.authored.is_some() || self.sheet() || self.report.path(&["_styk", "animation", "channels"]).and_then(Value::array_len).unwrap_or(0) > 0 {
            return Ok(objects_of(&self.shown_frame()?));
        }
        Ok(crate::record::frame_objects(&self.report, self.frame_index))
    }

    /// `editor.frame.objects`: what a command changes. The gesture's draft, else the
    /// native keyframe at the playhead.
    pub(crate) fn frame_objects(&self) -> Vec<Value> {
        match &self.authored {
            Some(edit) => objects_of(&edit.frame),
            None => crate::record::frame_objects(&self.report, self.frame_index),
        }
    }

    /// A figure of `editor.frame`, to change.
    pub(crate) fn frame_object_mut(&mut self, slot: usize) -> Option<&mut Obj> {
        let frame = match self.authored.as_mut() {
            Some(edit) => edit.frame.make_obj()?,
            None => frame_mut(&mut self.report, self.frame_index)?,
        };
        frame.get_mut("objects")?.make_arr()?.get_mut(slot)?.make_obj()
    }

    /// Replace one pose already copied for a transform, without first copying its old
    /// object again through `frame_object_mut`. Frame/array ownership stays here.
    pub(crate) fn replace_frame_object(&mut self, slot: usize, object: Obj) -> Option<()> {
        let frame = match self.authored.as_mut() {
            Some(edit) => edit.frame.make_obj()?,
            None => frame_mut(&mut self.report, self.frame_index)?,
        };
        *frame.get_mut("objects")?.make_arr()?.get_mut(slot)? = Value::object(object);
        Some(())
    }

    /// `editor.object`: the selected figure's record in the selection frame, else the
    /// last selected figure in slot order.
    pub(crate) fn object(&self) -> Result<Option<(usize, Value)>, EditError> {
        let frame = self.selection_frame()?;
        let found = self.selection.uid.and_then(|selected| frame.iter().position(|o| uid(o) == Some(selected)));
        let slot = found.or_else(|| frame.iter().rposition(|o| uid(o).is_some_and(|u| self.selection.uids.contains(&u))));
        Ok(slot.map(|slot| (slot, frame[slot].clone())))
    }

    /// The figures selected in the selection frame, in slot order (`selectedObjects`).
    pub(crate) fn selected_objects(&self) -> Result<Vec<Value>, EditError> {
        Ok(self.selection_frame()?.into_iter().filter(|o| uid(o).is_some_and(|u| self.selection.uids.contains(&u))).collect())
    }

    /// The frame on show as the typed evaluator reads it, and its geometry
    /// (`editor.geometry`). A document with features the engine cannot evaluate yet
    /// is not edited here.
    pub(crate) fn evaluate(&self) -> Result<(Arc<Prepared>, styk_eval::eval::Frame, styk_eval::geometry::Scene), EditError> {
        self.evaluate_only(None)
    }

    /// [`Editor::evaluate`] with the geometry of the figures in `slots` (and those they are
    /// joined to) only, when given.
    pub(crate) fn evaluate_only(&self, slots: Option<&[usize]>) -> Result<(Arc<Prepared>, styk_eval::eval::Frame, styk_eval::geometry::Scene), EditError> {
        self.evaluate_geometry(slots, false, None)
    }

    /// The same shown-frame/typed owner, with only the geometry `shape` consumes.
    /// Missing slot information keeps the original full build; the geometry owner
    /// retains its full-output fallback for rigged and other rich figures.
    pub(crate) fn evaluate_for_shape(&self, slots: Option<&[usize]>) -> Result<(Arc<Prepared>, styk_eval::eval::Frame, styk_eval::geometry::Scene), EditError> {
        self.evaluate_geometry(slots, true, None)
    }

    /// The selected segment through the same guarded typed-frame and geometry
    /// owners. Missing slot information preserves the original full build.
    pub(crate) fn evaluate_for_joint_shape(&self, slot: Option<usize>, joint: usize) -> Result<(Arc<Prepared>, styk_eval::eval::Frame, styk_eval::geometry::Scene), EditError> {
        match slot {
            Some(slot) => self.evaluate_geometry(Some(&[slot]), true, Some((slot, joint))),
            None => self.evaluate_for_shape(None),
        }
    }

    /// The same guarded shown-frame conversion, for callers that do not read geometry.
    /// This shares the existing Prepared lineage and latest typed view owner.
    pub(crate) fn evaluate_frame(&self) -> Result<(Arc<Prepared>, styk_eval::eval::Frame), EditError> {
        let prepared = self.prepared()?;
        let record = self.shown_frame()?;
        let frame = self.eval.borrow_mut().edit_frame(&record, &prepared).map_err(|error| EditError::Invalid(error.to_string()))?;
        Ok((prepared, frame))
    }

    fn evaluate_geometry(&self, slots: Option<&[usize]>, for_shape: bool, joint: Option<(usize, usize)>) -> Result<(Arc<Prepared>, styk_eval::eval::Frame, styk_eval::geometry::Scene), EditError> {
        let (prepared, frame) = self.evaluate_frame()?;
        let scene = match (slots, joint) {
            (Some(_), Some((slot, joint))) => styk_eval::geometry::build_joint_for_shape(&prepared.doc, &frame, slot, joint),
            (Some(slots), _) if for_shape => styk_eval::geometry::build_only_for_shape(&prepared.doc, &frame, slots),
            (Some(slots), _) => styk_eval::geometry::build_only(&prepared.doc, &frame, slots),
            (None, _) => styk_eval::geometry::build(&prepared.doc, &frame),
        };
        Ok((prepared, frame, scene))
    }

    /// `layerIdForUid(report, uid)`.
    pub(crate) fn layer_of(&self, uid: u32) -> String {
        layer_of(self.report.path(&["_styk", "layers"]), uid)
    }
}

/// `layerIdForUid` on a layer state: the figure's assigned layer, else the default one.
pub(crate) fn layer_of(layers: Option<&Value>, uid: u32) -> String {
    let Some(state) = layers else { return "layer-1".into() };
    let assigned = state.get("assignments").and_then(|a| a.get(&uid.to_string()));
    assigned.or_else(|| state.get("defaultLayerId")).and_then(Value::as_str).unwrap_or("").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Value { styk_doc::json::parse(text.as_bytes()).unwrap() }

    fn recorded(name: &str) -> Value {
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../tests/edit/{name}.reference.json"));
        styk_doc::json::parse(&std::fs::read(file).unwrap()).unwrap()
    }

    fn recorded_editor(reference: &Value) -> Editor {
        let first = reference.get("steps").unwrap().item(0).unwrap();
        let report = parse(first.get("document").unwrap().as_str().unwrap());
        let state = first.get("state").unwrap();
        let flag = |key| reference.path(&["editor", key]).is_some_and(Value::truthy);
        let number = |key| state.get(key).and_then(Value::as_f64).unwrap_or(0.0);
        let mut editor = Editor::new(report, crate::Options {
            property_channels: flag("propertyChannels"), layer_timeline: flag("layerTimeline"), auto_key: flag("autoKey"),
        });
        editor.set_view(number("tick"), number("frameIndex") as usize, crate::Selection {
            uid: state.get("selectedUid").and_then(Value::as_f64).map(|v| v as u32),
            uids: state.get("selectedUids").and_then(Value::numbers).unwrap_or_default().into_iter().map(|v| v as u32).collect(),
            joint: state.get("selectedJoint").and_then(Value::as_f64).unwrap_or(-1.0) as i64,
        });
        editor.set_counters(number("layerRevision") as u64, number("nextFrameIdentity") as u64, number("nextUid") as u64);
        editor.set_selection_metadata(state).unwrap();
        editor
    }

    fn shown(name: &str) -> (Editor, Arc<Prepared>, Value) {
        let editor = recorded_editor(&recorded(name));
        let prepared = editor.prepared().unwrap();
        let record = editor.shown_frame().unwrap();
        (editor, prepared, record)
    }

    fn replace_object(record: &Value, slot: usize, change: impl FnOnce(&mut Obj)) -> Value {
        let mut next = record.clone();
        change(next.make_obj().unwrap().get_mut("objects").unwrap().make_arr().unwrap()[slot].make_obj().unwrap());
        next
    }

    // The oracle here is the original Loader conversion, never another typed
    // decoder. Debug equality covers the rich typed metadata of these finite
    // recorded inputs; numeric bit checks also preserve signed zero.
    fn assert_fresh(cache: &Cache, record: &Value, prepared: &Arc<Prepared>, frame: &styk_eval::eval::Frame) {
        let fresh = cache.loader.clone().edit_frame(record, None, &prepared.doc).unwrap();
        assert_eq!(format!("{frame:?}"), format!("{fresh:?}"));
        assert_eq!(frame.tick.to_bits(), fresh.tick.to_bits());
        assert_eq!(frame.retained_vfx_tick.map(f64::to_bits), fresh.retained_vfx_tick.map(f64::to_bits));
        for (actual, expected) in frame.objects.iter().zip(&fresh.objects) {
            assert_eq!(actual.root.map(f64::to_bits), expected.root.map(f64::to_bits));
            assert_eq!(actual.angles.iter().map(|v| v.to_bits()).collect::<Vec<_>>(), expected.angles.iter().map(|v| v.to_bits()).collect::<Vec<_>>());
            assert_eq!(actual.clip_time.map(f64::to_bits), expected.clip_time.map(f64::to_bits));
        }
        for slots in [None, Some(&[0usize][..])] {
            let scene = match slots {
                None => styk_eval::geometry::build(&prepared.doc, frame),
                Some(slots) => styk_eval::geometry::build_only(&prepared.doc, frame, slots),
            };
            let expected = match slots {
                None => styk_eval::geometry::build(&prepared.doc, &fresh),
                Some(slots) => styk_eval::geometry::build_only(&prepared.doc, &fresh, slots),
            };
            assert_eq!(format!("{:?}", scene.objects), format!("{:?}", expected.objects));
            assert_eq!(format!("{:?}", scene.items), format!("{:?}", expected.items));
            assert_eq!(scene.points.iter().map(|p| p.map(f64::to_bits)).collect::<Vec<_>>(), expected.points.iter().map(|p| p.map(f64::to_bits)).collect::<Vec<_>>());
            assert_eq!(scene.figure_of, expected.figure_of);
            assert_eq!(scene.camera, expected.camera);
            assert_eq!(scene.background, expected.background);
            assert_eq!(scene.chains, expected.chains);
            assert_eq!(scene.warnings, expected.warnings);
        }
    }

    #[test]
    fn same_active_layer_select_and_restore_reuse_the_current_evaluation() {
        let reference = recorded("channels-figure-sheet");
        let mut editor = recorded_editor(&reference);
        let report = editor.report.clone();
        let bytes = editor.report_json();
        let history = styk_doc::json::to_string(&editor.history_value());
        let state = styk_doc::json::to_string(&editor.state_value());
        let selection = styk_doc::json::to_string(&editor.selection_state().history_value());
        let prepared = editor.prepared().unwrap();
        let shown = editor.shown_frame().unwrap();
        let step = reference.get("steps").unwrap().item(1).unwrap();
        let call = step.get("call").unwrap().elements().unwrap().iter().collect::<Vec<_>>();
        let result = editor.call(call[0].as_str().unwrap(), &call[1..]).unwrap();
        assert_eq!(result, *step.get("result").unwrap());
        assert_eq!(Value::array(editor.take_events()), *step.get("events").unwrap(), "selection still emits its original event");
        assert!(editor.report.same_node(&report), "selecting the current layer must not COW-replace the document");
        assert!(Arc::ptr_eq(&prepared, &editor.prepared().unwrap()), "the second selection read retains the same preparation");
        assert!(shown.same_node(&editor.shown_frame().unwrap()), "the second selection read retains the evaluated record");
        assert_eq!(editor.report_json(), bytes);
        assert_eq!(styk_doc::json::to_string(&editor.history_value()), history);
        assert_eq!(styk_doc::json::to_string(&editor.state_value()), state);
        assert_eq!(styk_doc::json::to_string(&editor.selection_state().history_value()), selection);

        let restored = editor.selection_state();
        editor.restore_selection(&restored).unwrap();
        assert!(editor.report.same_node(&report), "history restoration to the same active layer keeps the current document");
        assert!(Arc::ptr_eq(&prepared, &editor.prepared().unwrap()));
        assert!(shown.same_node(&editor.shown_frame().unwrap()));
        assert_eq!(editor.report_json(), bytes);
        assert_eq!(styk_doc::json::to_string(&editor.history_value()), history);
        assert_eq!(styk_doc::json::to_string(&editor.state_value()), state);
        assert_eq!(styk_doc::json::to_string(&editor.selection_state().history_value()), selection);
        assert!(editor.take_events().is_empty());
    }

    #[test]
    fn active_layer_equality_preserves_missing_null_nonstring_and_changed_writes() {
        for active in [None, Some(Value::Null), Some(Value::Num(0.0)), Some(Value::Bool(false)), Some(Value::str("camera"))] {
            let mut editor = recorded_editor(&recorded("channels-figure-sheet"));
            let layers = editor.report.make_obj().unwrap().get_mut("_styk").unwrap().make_obj().unwrap().get_mut("layers").unwrap().make_obj().unwrap();
            match active { Some(active) => layers.set("activeId", active), None => { layers.remove("activeId"); } }
            layers.set("futureActiveHint", parse(r#"{"preserve":[null,1,"layer-1"]}"#));
            let report = editor.report.clone();
            let history = styk_doc::json::to_string(&editor.history_value());
            let state = styk_doc::json::to_string(&editor.state_value());
            let prepared = editor.prepared().unwrap();
            let shown = editor.shown_frame().unwrap();
            let mut expected = report.clone();
            expected.make_obj().unwrap().get_mut("_styk").unwrap().make_obj().unwrap().get_mut("layers").unwrap().make_obj().unwrap().set("activeId", Value::str("layer-1"));
            editor.set_active_layer("layer-1");
            assert!(!editor.report.same_node(&report), "only an existing equal string can omit the original write");
            assert_eq!(editor.report_json(), styk_doc::json::to_string(&crate::record::without_runtime(&expected)));
            assert_eq!(styk_doc::json::to_string(&editor.history_value()), history);
            assert_eq!(styk_doc::json::to_string(&editor.state_value()), state);
            assert!(editor.take_events().is_empty(), "the helper emits no event on its original write path");
            assert!(!Arc::ptr_eq(&prepared, &editor.prepared().unwrap()), "a changed scalar keeps the original preparation invalidation");
            let current = editor.report.clone();
            let next = editor.shown_frame().unwrap();
            assert_eq!(styk_doc::json::to_string(&shown), styk_doc::json::to_string(&next));
            editor.set_active_layer("layer-1");
            assert!(editor.report.same_node(&current));
            assert!(next.same_node(&editor.shown_frame().unwrap()));
        }
    }

    #[test]
    fn latest_typed_view_reuses_only_identical_slots_and_preserves_input() {
        let (editor, prepared, record) = shown("gestures-sheet");
        let before = styk_doc::json::to_string(&record);
        let mut cache = editor.eval.borrow().clone();
        let first = cache.edit_frame(&record, &prepared).unwrap();
        assert!(first.objects.len() > 1);
        let again = cache.edit_frame(&record, &prepared).unwrap();
        for (old, new) in first.objects.iter().zip(&again.objects) { assert!(Arc::ptr_eq(old, new)); }
        let old_path = cache.loader.clone().edit_frame(&record, None, &prepared.doc).unwrap();
        for (old, cold) in first.objects.iter().zip(&old_path.objects) { assert!(!Arc::ptr_eq(old, cold), "the original per-call conversion reparses every pose"); }
        let next = replace_object(&record, 0, |object| { object.set("root_x", Value::Num(-0.0)); });
        let frame = cache.edit_frame(&next, &prepared).unwrap();
        assert!(!Arc::ptr_eq(&first.objects[0], &frame.objects[0]));
        for slot in 1..first.objects.len() { assert!(Arc::ptr_eq(&first.objects[slot], &frame.objects[slot])); }
        assert_eq!(frame.objects[0].root[0].to_bits(), (-0.0f64).to_bits());
        assert_fresh(&cache, &next, &prepared, &frame);
        assert_eq!(styk_doc::json::to_string(&record), before, "delta construction never edits its source");
        assert!(cache.latest_typed.as_ref().unwrap().record.same_node(&next));
    }

    #[test]
    fn latest_typed_view_rebuilds_current_frame_fields_around_reused_objects() {
        let (editor, prepared, record) = shown("gestures-sheet");
        let mut cache = editor.eval.borrow().clone();
        let first = cache.edit_frame(&record, &prepared).unwrap();
        let mut next = record.clone();
        let value = next.make_obj().unwrap();
        value.set("tick", Value::Num(-0.0));
        value.set("camera", parse(r#"{"is_default":false,"x":42,"y":-0,"scale":1.25,"angle_rad":0.125}"#));
        value.set("object_draw_order", Value::array((0..first.objects.len()).rev().map(|slot| Value::Num(slot as f64)).collect()));
        value.set("background_id", Value::Num(7.0));
        value.set("background_id_b", Value::Num(8.0));
        value.set("background_mix", Value::Num(0.375));
        value.set("_stykBackgroundColor", Value::Num(0xff123456u32 as f64));
        value.set("_vfxTimelineScene", parse("[]"));
        value.set("_vfxTimelineTick", Value::Num(3.25));
        let mut metadata = value.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
        metadata.set("movieclipContinuations", parse(r#"[{"uid":1,"playback":{"start":0,"offset":2.5,"speed":1,"mode":"loop"}}]"#));
        value.set("_styk", Value::object(metadata));
        let frame = cache.edit_frame(&next, &prepared).unwrap();
        for (old, new) in first.objects.iter().zip(&frame.objects) { assert!(Arc::ptr_eq(old, new)); }
        assert_eq!(frame.tick.to_bits(), (-0.0f64).to_bits());
        assert_eq!(frame.retained_vfx_tick, Some(3.25));
        assert_eq!(frame.background, 7); assert_eq!(frame.background_b, 8); assert_eq!(frame.background_mix, 0.375);
        assert_eq!(frame.background_color, Some(0xff123456));
        assert_eq!(frame.camera.unwrap().x, 42.0);
        assert_eq!(frame.draw_order, (0..first.objects.len() as u32).rev().collect::<Vec<_>>());
        assert_eq!(frame.continuations.len(), 1); assert!(frame.pose_vfx.is_some());
        assert_fresh(&cache, &next, &prepared, &frame);
        next.make_obj().unwrap().remove("_vfxTimelineScene");
        next.make_obj().unwrap().remove("_vfxTimelineTick");
        next.make_obj().unwrap().remove("camera");
        let frame = cache.edit_frame(&next, &prepared).unwrap();
        assert!(frame.camera.is_none()); assert!(frame.retained_vfx_tick.is_none());
        assert_fresh(&cache, &next, &prepared, &frame);
    }

    #[test]
    fn latest_typed_view_reparses_reorder_membership_style_and_movieclip_clock() {
        let (editor, prepared, record) = shown("gestures-sheet");
        let mut cache = editor.eval.borrow().clone();
        let first = cache.edit_frame(&record, &prepared).unwrap();
        let mut reordered = record.clone();
        reordered.make_obj().unwrap().get_mut("objects").unwrap().make_arr().unwrap().swap(0, 1);
        let frame = cache.edit_frame(&reordered, &prepared).unwrap();
        assert_eq!(frame.objects[0].uid, first.objects[1].uid);
        assert!(!Arc::ptr_eq(&first.objects[0], &frame.objects[0]));
        assert!(!Arc::ptr_eq(&first.objects[1], &frame.objects[1]));
        assert_fresh(&cache, &reordered, &prepared, &frame);
        let mut shorter = reordered.clone();
        shorter.make_obj().unwrap().get_mut("objects").unwrap().make_arr().unwrap().pop();
        let short = cache.edit_frame(&shorter, &prepared).unwrap();
        assert!(!Arc::ptr_eq(&frame.objects[0], &short.objects[0]), "count changes use the original complete conversion");
        assert_fresh(&cache, &shorter, &prepared, &short);
        let segment = prepared.doc.figure(first.objects[0].figure).unwrap().segments[0].id;
        let style = parse(&format!(r#"{{"segments":{{"{segment}":{{"thickness":7.25,"color":1193046}}}}}}"#));
        let styled = replace_object(&record, 0, |object| { object.set("_stykStyle", style); });
        let frame = cache.edit_frame(&styled, &prepared).unwrap();
        assert!(frame.objects[0].figure_override.is_some());
        assert_eq!(frame.objects[0].figure_override.as_ref().unwrap().segments[0].thickness, 7.25);
        assert_fresh(&cache, &styled, &prepared, &frame);
        let mut unstyled = styled.clone();
        unstyled.make_obj().unwrap().get_mut("objects").unwrap().make_arr().unwrap()[0].make_obj().unwrap().remove("_stykStyle");
        let frame = cache.edit_frame(&unstyled, &prepared).unwrap();
        assert!(frame.objects[0].figure_override.is_none());
        assert_fresh(&cache, &unstyled, &prepared, &frame);
        let changed_figure = replace_object(&styled, 0, |object| { object.set("figure_type_id", Value::Num(first.objects[1].figure as f64)); });
        let frame = cache.edit_frame(&changed_figure, &prepared).unwrap();
        assert_eq!(frame.objects[0].figure, first.objects[1].figure);
        assert_fresh(&cache, &changed_figure, &prepared, &frame);
        let changed_uid = replace_object(&changed_figure, 0, |object| { object.set("unique_id", Value::Num(first.objects[0].uid as f64 + 1000.0)); });
        let frame = cache.edit_frame(&changed_uid, &prepared).unwrap();
        assert_eq!(frame.objects[0].uid, first.objects[0].uid + 1000);
        assert_fresh(&cache, &changed_uid, &prepared, &frame);

        let (movie_editor, movie_prepared, movie_record) = shown("ik-movieclip-parent-sheet");
        let mut cache = movie_editor.eval.borrow().clone();
        let first = cache.edit_frame(&movie_record, &movie_prepared).unwrap();
        let slot = first.objects.iter().position(|object| movie_prepared.doc.figure(object.figure).unwrap().movieclip.is_some()).unwrap();
        for clock in [Value::Num(-0.0), Value::Num(5.25), Value::Null] {
            let next = replace_object(&movie_record, slot, |object| { object.set("_movieclipSample", clock.clone()); });
            let frame = cache.edit_frame(&next, &movie_prepared).unwrap();
            assert_eq!(frame.objects[slot].clip_time.map(f64::to_bits), clock.as_f64().map(f64::to_bits));
            assert!(!Arc::ptr_eq(&first.objects[slot], &frame.objects[slot]));
            assert_fresh(&cache, &next, &movie_prepared, &frame);
        }
    }

    #[test]
    fn latest_typed_view_preserves_cold_null_malformed_and_nonarray_semantics() {
        let (editor, prepared, record) = shown("gestures-sheet");
        let mut cache = editor.eval.borrow().clone();
        cache.edit_frame(&record, &prepared).unwrap();
        let coherent = cache.latest_typed.as_ref().unwrap().clone();
        let mut malformed = Vec::new();
        for object in [Value::Null, Value::Num(3.0), parse("{}"), parse(r#"{"unique_id":1}"#)] {
            let mut next = record.clone();
            next.make_obj().unwrap().get_mut("objects").unwrap().make_arr().unwrap()[0] = object;
            malformed.push(next);
        }
        for next in malformed {
            let want = cache.loader.clone().edit_frame(&next, None, &prepared.doc).unwrap_err().to_string();
            assert_eq!(cache.edit_frame(&next, &prepared).unwrap_err().to_string(), want);
            assert!(Arc::ptr_eq(cache.latest_typed.as_ref().unwrap(), &coherent), "failed conversion installs no partial frame");
        }
        for objects in [None, Some(Value::Null), Some(Value::Num(3.0)), Some(parse("[1,2,3]")), Some(parse("[]"))] {
            let mut next = record.clone();
            let value = next.make_obj().unwrap();
            match objects { None => { value.remove("objects"); }, Some(objects) => { value.set("objects", objects); } }
            let frame = cache.edit_frame(&next, &prepared).unwrap();
            assert!(frame.objects.is_empty());
            assert_fresh(&cache, &next, &prepared, &frame);
        }
    }

    #[test]
    fn latest_typed_view_tracks_prepared_lineage_and_retains_only_one_pair() {
        let (mut editor, prepared, record) = shown("gestures-sheet");
        let first = editor.eval.borrow_mut().edit_frame(&record, &prepared).unwrap();
        let original = Arc::downgrade(editor.eval.borrow().latest_typed.as_ref().unwrap());
        let next = replace_object(&record, 0, |object| { object.set("root_y", Value::Num(123.25)); });
        editor.eval.borrow_mut().edit_frame(&next, &prepared).unwrap();
        assert!(original.upgrade().is_none(), "the previous pair is not retained by a chain");
        let snapshot = editor.eval.borrow().clone();
        let kept = Arc::downgrade(snapshot.latest_typed.as_ref().unwrap());
        let lineage = Arc::new(Prepared::new(prepared.doc.clone()));
        let frame = editor.eval.borrow_mut().edit_frame(&record, &lineage).unwrap();
        for (old, new) in first.objects.iter().zip(&frame.objects) { assert!(!Arc::ptr_eq(old, new)); }
        assert!(kept.upgrade().is_some(), "a complete existing Cache clone owns its immutable pair");
        drop(snapshot);
        assert!(kept.upgrade().is_none());

        let mut report = editor.report.clone();
        let figure = prepared.doc.figure(first.objects[0].figure).unwrap();
        let definitions = report.make_obj().unwrap().get_mut("figure_types").unwrap().make_arr().unwrap();
        let definition = definitions.iter_mut().find(|value| value.get("figure_type_id").and_then(Value::as_f64) == Some(figure.id as f64)).unwrap();
        definition.make_obj().unwrap().get_mut("segments").unwrap().make_arr().unwrap()[0].make_obj().unwrap().set("thickness", Value::Num(17.0));
        editor.report = report;
        let changed = editor.prepared().unwrap();
        assert!(!Arc::ptr_eq(&prepared, &changed));
        assert_eq!(changed.doc.figure(figure.id).unwrap().segments[0].thickness, 17.0);
        assert!(editor.eval.borrow().latest_typed.is_none(), "document preparation clears the previous lineage");
        let frame = editor.eval.borrow_mut().edit_frame(&record, &changed).unwrap();
        assert_fresh(&editor.eval.borrow(), &record, &changed, &frame);
        let last = Arc::downgrade(editor.eval.borrow().latest_typed.as_ref().unwrap());
        let loader = editor.eval.borrow().loader.clone();
        editor.adopt_prepared(loader, changed);
        assert!(editor.eval.borrow().latest_typed.is_none());
        assert!(last.upgrade().is_none(), "adopting clears even the same Prepared identity");
    }

    #[test]
    fn latest_typed_view_follows_recorded_drag_cancel_history_and_atomic_refusal() {
        let reference = recorded("drag-cancel");
        let outcome = crate::replay::replay(&reference).unwrap();
        assert!(outcome.unported.is_none()); assert!(outcome.mismatches.is_empty(), "{outcome:?}");
        assert_eq!(outcome.matched, outcome.steps);
        let mut editor = recorded_editor(&reference);
        let mut expected_document = reference.get("steps").unwrap().item(0).unwrap().get("document").unwrap().as_str().unwrap().to_string();
        for step in reference.get("steps").unwrap().elements().unwrap().iter().skip(1) {
            let call = step.get("call").unwrap().elements().unwrap().iter().collect::<Vec<_>>();
            let method = call[0].as_str().unwrap();
            let method = match method { "@select" => "select", "@seek" => "seek", other => other };
            let report = editor.report_json();
            let state = editor.state_value();
            let history = editor.history_value();
            let events = editor.events.clone();
            let shown = styk_doc::json::to_string(&editor.shown_frame().unwrap());
            let mut checks = 0;
            let result = editor.call_checked_impl(method, &call[1..], true, &mut || {
                checks += 1;
                if checks == 2 { Err(EditError::Invalid("typed view one-shot cancellation".into())) } else { Ok(()) }
            });
            assert!(matches!(result, Err(EditError::Invalid(ref reason)) if reason == "typed view one-shot cancellation"));
            assert_eq!(editor.report_json(), report); assert_eq!(editor.state_value(), state);
            assert_eq!(editor.history_value(), history); assert_eq!(editor.events, events);
            assert_eq!(styk_doc::json::to_string(&editor.shown_frame().unwrap()), shown);
            editor.call(method, &call[1..]).unwrap();
            if let Some(document) = step.get("document").and_then(Value::as_str) { expected_document = document.to_string(); }
            assert_eq!(editor.report_json(), expected_document);
            assert_eq!(editor.state_value(), *step.get("state").unwrap());
            let (prepared, frame, _) = editor.evaluate().unwrap();
            let record = editor.shown_frame().unwrap();
            assert_fresh(&editor.eval.borrow(), &record, &prepared, &frame);
            let report = editor.report.clone();
            let state = editor.state_value();
            assert!(matches!(editor.call("unrecordedTypedViewControl", &[]), Err(EditError::Unported(_))));
            assert!(editor.report.same_node(&report)); assert_eq!(editor.state_value(), state);
            let (_, after, _) = editor.evaluate().unwrap();
            for (before, after) in frame.objects.iter().zip(&after.objects) { assert!(Arc::ptr_eq(before, after)); }
        }
    }

    #[test]
    fn latest_typed_view_reuses_ik_on_changed_angles_even_without_unchanged_objects() {
        for name in ["startup-sheet", "ik-unpinned-sheet", "ik-spatial-sheet"] {
            let (editor, prepared, record) = shown(name);
            let before = styk_doc::json::to_string(&record);
            let mut cache = editor.eval.borrow().clone();
            let first = cache.edit_frame(&record, &prepared).unwrap();
            let mut next = record.clone();
            for raw in next.make_obj().unwrap().get_mut("objects").unwrap().make_arr().unwrap() {
                let object = raw.make_obj().unwrap();
                let mut angles = object.get("angles").unwrap().numbers().unwrap();
                assert!(!angles.is_empty());
                angles[0] += 0.125;
                object.set("angles", Value::nums(&angles));
                object.set("root_y", Value::Num(-0.0));
            }
            let frame = cache.edit_frame(&next, &prepared).unwrap();
            let mut reused = 0;
            for (slot, (old, new)) in first.objects.iter().zip(&frame.objects).enumerate() {
                assert!(!Arc::ptr_eq(old, new), "{name}: changed poses still convert");
                assert_eq!(new.root[1].to_bits(), (-0.0f64).to_bits());
                if let Some(old_ik) = &old.ik {
                    let new_ik = new.ik.as_ref().unwrap();
                    assert!(Arc::ptr_eq(old_ik, new_ik), "{name}: unchanged IK table in slot {slot}");
                    assert!(record.get("objects").unwrap().item(slot).unwrap().get("_stykIK").unwrap()
                        .same_node(next.get("objects").unwrap().item(slot).unwrap().get("_stykIK").unwrap()));
                    reused += 1;
                }
            }
            assert!(reused > 0, "{name}: actual recorded controllers");
            assert_fresh(&cache, &next, &prepared, &frame);
            assert_eq!(styk_doc::json::to_string(&record), before);
        }
    }

    #[test]
    fn latest_typed_view_reparses_replaced_and_nested_edited_ik_tables() {
        let (editor, prepared, record) = shown("ik-spatial-sheet");
        let before = styk_doc::json::to_string(&record);
        let mut cache = editor.eval.borrow().clone();
        let first = cache.edit_frame(&record, &prepared).unwrap();
        let slot = first.objects.iter().position(|object| object.ik.as_ref().is_some_and(|ik| !ik.controllers.is_empty())).unwrap();
        let original = first.objects[slot].ik.as_ref().unwrap();
        let key = original.controllers.keys().next().unwrap().to_string();
        let table = parse(&styk_doc::json::to_string(record.get("objects").unwrap().item(slot).unwrap().get("_stykIK").unwrap()));
        let replaced = replace_object(&record, slot, |object| { object.set("_stykIK", table); });
        let replacement = cache.edit_frame(&replaced, &prepared).unwrap();
        let replacement_ik = replacement.objects[slot].ik.as_ref().unwrap();
        assert_eq!(original, replacement_ik, "equal separately parsed data remains equal");
        assert!(!Arc::ptr_eq(original, replacement_ik), "equal JSON is not unchanged node identity");
        assert_fresh(&cache, &replaced, &prepared, &replacement);

        let nested = replace_object(&replaced, slot, |object| {
            let controller = object.get_mut("_stykIK").unwrap().make_obj().unwrap().get_mut(&key).unwrap().make_obj().unwrap();
            controller.get_mut("target").unwrap().make_obj().unwrap().set("x", Value::Num(-0.0));
            controller.get_mut("spatialTarget").unwrap().make_obj().unwrap().set("depth", Value::Num(-0.0));
        });
        let changed = cache.edit_frame(&nested, &prepared).unwrap();
        let changed_ik = changed.objects[slot].ik.as_ref().unwrap();
        assert!(!Arc::ptr_eq(replacement_ik, changed_ik));
        let handle = *original.controllers.keys().next().unwrap();
        assert_eq!(changed_ik.get(handle).unwrap().target.x.to_bits(), (-0.0f64).to_bits());
        assert_eq!(changed_ik.get(handle).unwrap().spatial_target.as_ref().unwrap().depth.to_bits(), (-0.0f64).to_bits());
        assert_eq!(original.get(handle).unwrap().target.x.to_bits(), replacement_ik.get(handle).unwrap().target.x.to_bits());
        assert_fresh(&cache, &nested, &prepared, &changed);

        let nonfinite = replace_object(&nested, slot, |object| {
            object.get_mut("_stykIK").unwrap().make_obj().unwrap().get_mut(&key).unwrap().make_obj().unwrap()
                .get_mut("target").unwrap().make_obj().unwrap().set("x", Value::Num(f64::NAN));
        });
        let changed = cache.edit_frame(&nonfinite, &prepared).unwrap();
        assert!(changed.objects[slot].ik.as_ref().unwrap().get(handle).is_none(), "the original lenient parser discards the invalid controller");
        assert_fresh(&cache, &nonfinite, &prepared, &changed);
        assert_eq!(styk_doc::json::to_string(&record), before, "descendant edits leave the coherent source untouched");
    }

    #[test]
    fn latest_typed_view_keeps_missing_null_and_malformed_ik_parser_semantics() {
        let (editor, prepared, record) = shown("ik-unpinned-sheet");
        for table in [None, Some(Value::Null), Some(Value::Bool(false)), Some(Value::Num(3.0)), Some(parse("[]")),
            Some(parse(r#"{"22":{"enabled":true},"opaque":[1,2]}"#))]
        {
            let mut cache = editor.eval.borrow().clone();
            cache.edit_frame(&record, &prepared).unwrap();
            let next = replace_object(&record, 0, |object| {
                match table.clone() { Some(table) => { object.set("_stykIK", table); }, None => { object.remove("_stykIK"); } }
            });
            let frame = cache.edit_frame(&next, &prepared).unwrap();
            let parsed = styk_eval::ik::parse::table(table.as_ref());
            assert_eq!(frame.objects[0].ik.as_deref(), parsed.as_ref());
            assert_fresh(&cache, &next, &prepared, &frame);
            if let Some(ik) = &frame.objects[0].ik {
                assert!(ik.controllers.is_empty());
                let changed = replace_object(&next, 0, |object| { object.set("root_x", Value::Num(12.5)); });
                let again = cache.edit_frame(&changed, &prepared).unwrap();
                assert!(Arc::ptr_eq(ik, again.objects[0].ik.as_ref().unwrap()), "unchanged lenient empty table is still an immutable parsed table");
                assert_fresh(&cache, &changed, &prepared, &again);
            }
        }
    }

    #[test]
    fn latest_typed_view_limits_ik_reuse_to_same_slot_identity_count_and_prepared() {
        let (editor, prepared, record) = shown("ik-unpinned-sheet");
        for change in 0..4 {
            let mut cache = editor.eval.borrow().clone();
            let first = cache.edit_frame(&record, &prepared).unwrap();
            assert_eq!(first.objects.len(), 2);
            assert_ne!(first.objects[0].figure, first.objects[1].figure);
            let mut next = record.clone();
            match change {
                0 => { next = replace_object(&record, 0, |object| { object.set("unique_id", Value::Num(first.objects[0].uid as f64 + 1000.0)); }); }
                1 => { next = replace_object(&record, 0, |object| { object.set("figure_type_id", Value::Num(first.objects[1].figure as f64)); }); }
                2 => { next.make_obj().unwrap().get_mut("objects").unwrap().make_arr().unwrap().swap(0, 1); }
                _ => { next.make_obj().unwrap().get_mut("objects").unwrap().make_arr().unwrap().pop(); }
            }
            let frame = cache.edit_frame(&next, &prepared).unwrap();
            assert!(!Arc::ptr_eq(first.objects[0].ik.as_ref().unwrap(), frame.objects[0].ik.as_ref().unwrap()), "guard {change} reparses");
            assert_fresh(&cache, &next, &prepared, &frame);
        }

        let mut cache = editor.eval.borrow().clone();
        let first = cache.edit_frame(&record, &prepared).unwrap();
        let previous_pair = Arc::downgrade(cache.latest_typed.as_ref().unwrap());
        let snapshot = cache.clone();
        let next = replace_object(&record, 0, |object| { object.set("root_x", Value::Num(17.5)); });
        let frame = cache.edit_frame(&next, &prepared).unwrap();
        assert!(Arc::ptr_eq(first.objects[0].ik.as_ref().unwrap(), frame.objects[0].ik.as_ref().unwrap()));
        assert!(previous_pair.upgrade().is_some(), "an existing Cache snapshot pins its coherent pair");
        drop(snapshot);
        assert!(previous_pair.upgrade().is_none(), "the current pair does not retain a predecessor chain");
        let coherent = cache.latest_typed.as_ref().unwrap().clone();
        let mut invalid = replace_object(&next, 0, |object| { object.set("root_x", Value::Num(-0.0)); });
        invalid.make_obj().unwrap().get_mut("objects").unwrap().make_arr().unwrap()[1].make_obj().unwrap().remove("figure_type_id");
        let want = cache.loader.clone().edit_frame(&invalid, None, &prepared.doc).unwrap_err().to_string();
        assert_eq!(cache.edit_frame(&invalid, &prepared).unwrap_err().to_string(), want);
        assert!(Arc::ptr_eq(cache.latest_typed.as_ref().unwrap(), &coherent), "an error after an eligible first slot installs no partial pair");
        assert!(coherent.record.same_node(&next));
        let lineage = Arc::new(Prepared::new(prepared.doc.clone()));
        let cold = cache.edit_frame(&next, &lineage).unwrap();
        for (old, new) in frame.objects.iter().zip(&cold.objects) {
            assert!(!Arc::ptr_eq(old.ik.as_ref().unwrap(), new.ik.as_ref().unwrap()));
        }
        assert_fresh(&cache, &next, &lineage, &cold);
    }

    #[test]
    fn latest_typed_view_ik_reuse_still_converts_other_pose_and_frame_fields() {
        let (editor, prepared, record) = shown("ik-unpinned-sheet");
        let mut cache = editor.eval.borrow().clone();
        let first = cache.edit_frame(&record, &prepared).unwrap();
        let segment = prepared.doc.figure(first.objects[0].figure).unwrap().segments[0].id;
        let style = parse(&format!(r#"{{"segments":{{"{segment}":{{"thickness":7.25,"color":1193046}}}}}}"#));
        let mut next = replace_object(&record, 0, |object| {
            object.set("_stykStyle", style);
            object.set("_movieclipSample", Value::Num(5.25));
            object.set("_sticknodesSprite", parse(r#"{"ratio":1}"#));
            object.set("color_transition", parse(r#"{"from":4278190080,"to":4294967295,"t":0.375}"#));
        });
        let value = next.make_obj().unwrap();
        value.set("tick", Value::Num(-0.0));
        value.set("camera", parse(r#"{"is_default":false,"x":42,"y":-0,"scale":1.25,"angle_rad":0.125}"#));
        value.set("_vfxTimelineTick", Value::Num(3.25));
        let mut original = cache.loader.clone();
        let cold = original.edit_frame(&next, None, &prepared.doc).unwrap();
        let frame = cache.edit_frame(&next, &prepared).unwrap();
        assert!(Arc::ptr_eq(first.objects[0].ik.as_ref().unwrap(), frame.objects[0].ik.as_ref().unwrap()));
        assert!(!Arc::ptr_eq(&first.objects[0], &frame.objects[0]));
        assert!(Arc::ptr_eq(&first.objects[1], &frame.objects[1]), "existing whole-object delta reuse remains");
        assert_eq!(frame.objects[0].figure_override.as_ref().unwrap().segments[0].thickness, 7.25);
        assert_eq!(frame.objects[0].clip_time, Some(5.25));
        assert_eq!(frame.objects[0].color_transition.as_ref().unwrap().t, 0.375);
        assert_eq!(frame.tick.to_bits(), (-0.0f64).to_bits());
        assert_eq!(frame.retained_vfx_tick, Some(3.25));
        assert_eq!(frame.camera, cold.camera);
        assert_eq!(cache.loader.notes, original.notes, "the unchanged IK subview suppresses no unrelated conversion notes");
        assert_fresh(&cache, &next, &prepared, &frame);
    }

    fn converted_vfx_frame(cache: &mut Cache, record: &Value, prepared: &Arc<Prepared>) -> styk_eval::eval::Frame {
        let mut original = cache.loader.clone();
        original.notes.clear();
        let fresh = original.edit_frame(record, None, &prepared.doc).unwrap();
        cache.loader.notes.clear();
        let frame = cache.edit_frame(record, prepared).unwrap();
        assert_eq!(cache.loader.notes, original.notes, "all conversion notes retain their original order");
        assert_eq!(format!("{frame:?}"), format!("{fresh:?}"));
        assert_fresh(cache, record, prepared, &frame);
        frame
    }

    #[test]
    fn latest_typed_view_vfx_reuse_preserves_output_notes_and_other_fields() {
        let (editor, prepared, record) = shown("vfx-parameter-sheet");
        let before = styk_doc::json::to_string(&record);
        let mut cache = editor.eval.borrow().clone();
        let first = cache.edit_frame(&record, &prepared).unwrap();
        let slot = first.objects.iter().position(|object| object.vfx.as_ref().is_some_and(|vfx| !vfx.figure().is_empty())).unwrap();
        let next = replace_object(&record, slot, |object| {
            let mut angles = object.get("angles").unwrap().numbers().unwrap();
            angles[0] += 0.125;
            object.set("angles", Value::nums(&angles));
            object.set("root_y", Value::Num(-0.0));
            object.set("_stykVfxScope", Value::Num(1.0));
            object.set("_vfxConnectedEffects", Value::Num(3.0));
            object.set("_sticknodesSprite", parse(r#"{"ratio":1}"#));
        });
        let mut next = next;
        next.make_obj().unwrap().set("_vfxTimelineScene", Value::Num(3.0));
        let frame = converted_vfx_frame(&mut cache, &next, &prepared);
        assert!(!Arc::ptr_eq(&first.objects[slot], &frame.objects[slot]));
        assert!(Arc::ptr_eq(first.objects[slot].vfx.as_ref().unwrap(), frame.objects[slot].vfx.as_ref().unwrap()), "identity witness only; fresh output/notes are the behavioral oracle");
        assert!(frame.objects[slot].vfx_scope);
        assert_eq!(frame.objects[slot].root[1].to_bits(), (-0.0f64).to_bits());
        assert_eq!(cache.loader.notes.len(), 3, "sprite, connected stack and scene stack still parse");
        assert_eq!(styk_doc::json::to_string(&record), before);
    }

    #[test]
    fn latest_typed_view_vfx_reuses_unchanged_owner_through_editor_pose_commands() {
        let (mut editor, _, _) = shown("vfx-parameter-sheet");
        let (_, initial) = editor.evaluate_frame().unwrap();
        let slot = initial.objects.iter().position(|object| object.vfx.as_ref().is_some_and(|vfx| !vfx.figure().is_empty())).unwrap();
        editor.call("select", &[Value::Num(initial.objects[slot].uid as f64), Value::Num(0.0)]).unwrap();
        editor.call("beginDrag", &[Value::str("Pose joint")]).unwrap();
        let (prepared, first, scene) = editor.evaluate_only(Some(&[slot])).unwrap();
        let original = editor.shown_frame().unwrap();
        let owner = original.get("objects").unwrap().item(slot).unwrap().get("_stykVfx").unwrap().clone();
        let before = first.objects[slot].vfx.as_ref().unwrap();
        let end = scene.objects[slot].ends[0];
        for offset in [5.0, 9.0] {
            editor.eval.borrow_mut().loader.notes.clear();
            assert_eq!(editor.call("poseJoint", &[Value::Num(end[0] + offset), Value::Num(end[1] + 3.0)]).unwrap(), Value::Bool(true));
            let record = editor.shown_frame().unwrap();
            assert!(owner.same_node(record.get("objects").unwrap().item(slot).unwrap().get("_stykVfx").unwrap()), "real angle mutation preserves the saved owner node");
            let (current, frame) = editor.evaluate_frame().unwrap();
            assert!(Arc::ptr_eq(&prepared, &current));
            assert!(Arc::ptr_eq(before, frame.objects[slot].vfx.as_ref().unwrap()), "actual command/Cache consumer retains the parsed table");
            let mut fresh = editor.eval.borrow().loader.clone();
            fresh.notes.clear();
            let cold = fresh.edit_frame(&record, None, &current.doc).unwrap();
            assert_eq!(editor.eval.borrow().loader.notes, fresh.notes);
            assert_eq!(format!("{frame:?}"), format!("{cold:?}"));
            assert_fresh(&editor.eval.borrow(), &record, &current, &frame);
        }
        editor.call("cancelDrag", &[]).unwrap();
    }

    #[test]
    fn latest_typed_view_vfx_reuse_limits_node_identity_slot_and_lineage() {
        let (editor, prepared, record) = shown("vfx-parameter-sheet");
        for case in ["node", "nested", "uid", "figure", "reorder", "count", "lineage"] {
            let mut cache = editor.eval.borrow().clone();
            let first = cache.edit_frame(&record, &prepared).unwrap();
            let slot = first.objects.iter().position(|object| object.vfx.as_ref().is_some_and(|vfx| !vfx.figure().is_empty())).unwrap();
            let owner = record.get("objects").unwrap().item(slot).unwrap().get("_stykVfx").unwrap().clone();
            let mut next = replace_object(&record, slot, |object| { object.set("root_x", Value::Num(17.5)); });
            let mut selected = slot;
            match case {
                "node" => next = replace_object(&next, slot, |object| { object.set("_stykVfx", parse(&styk_doc::json::to_string(&owner))); }),
                "nested" => next = replace_object(&next, slot, |object| {
                    let stack = object.get_mut("_stykVfx").unwrap().make_obj().unwrap().get_mut("figure").unwrap().make_arr().unwrap();
                    stack[0].make_obj().unwrap().set("enabled", Value::Bool(false));
                }),
                "uid" => next = replace_object(&next, slot, |object| { object.set("unique_id", Value::Num(first.objects[slot].uid as f64 + 1000.0)); }),
                "figure" => {
                    let other = first.objects.iter().find(|object| object.figure != first.objects[slot].figure).unwrap().figure;
                    next = replace_object(&next, slot, |object| { object.set("figure_type_id", Value::Num(other as f64)); });
                },
                "reorder" => {
                    let other = (slot + 1) % first.objects.len();
                    next.make_obj().unwrap().get_mut("objects").unwrap().make_arr().unwrap().swap(slot, other);
                    selected = other;
                },
                "count" => { next.make_obj().unwrap().get_mut("objects").unwrap().make_arr().unwrap().push(record.get("objects").unwrap().item(slot).unwrap().clone()); },
                _ => {},
            }
            let lineage = if case == "lineage" { Arc::new(Prepared::new(prepared.doc.clone())) } else { prepared.clone() };
            let frame = converted_vfx_frame(&mut cache, &next, &lineage);
            assert!(!Arc::ptr_eq(first.objects[slot].vfx.as_ref().unwrap(), frame.objects[selected].vfx.as_ref().unwrap()), "{case}: parsed table cannot be retained");
        }
        let mut cache = editor.eval.borrow().clone();
        cache.edit_frame(&record, &prepared).unwrap();
        let coherent = cache.latest_typed.as_ref().unwrap().clone();
        let mut invalid = replace_object(&record, 0, |object| { object.set("root_y", Value::Num(-0.0)); });
        invalid.make_obj().unwrap().get_mut("objects").unwrap().make_arr().unwrap()[1].make_obj().unwrap().remove("figure_type_id");
        let expected = cache.loader.clone().edit_frame(&invalid, None, &prepared.doc).unwrap_err().to_string();
        assert_eq!(cache.edit_frame(&invalid, &prepared).unwrap_err().to_string(), expected);
        assert!(Arc::ptr_eq(cache.latest_typed.as_ref().unwrap(), &coherent), "a later malformed slot cannot publish a partial reused frame");
    }

    #[test]
    fn latest_typed_view_vfx_reuse_repeats_every_lenient_diagnostic() {
        let (editor, prepared, record) = shown("vfx-parameter-sheet");
        let mut original = editor.eval.borrow().clone();
        let first = original.edit_frame(&record, &prepared).unwrap();
        let slot = first.objects.iter().position(|object| object.vfx.as_ref().is_some_and(|vfx| !vfx.figure().is_empty())).unwrap();
        let effect = record.get("objects").unwrap().item(slot).unwrap().path(&["_stykVfx", "figure"]).unwrap().item(0).unwrap();
        let owner = |stack: Value| { let mut value = Obj::new(); value.set("figure", stack); Value::object(value) };
        let invalid_key = { let mut value = Obj::new(); value.set("opaque", Value::array(vec![effect.clone()])); Value::object(value) };
        let invalid_param = { let mut value = effect.clone(); value.make_obj().unwrap().get_mut("params").unwrap().make_obj().unwrap().set("radius", Value::Num(f64::INFINITY)); value };
        let invalid_record = { let mut value = effect.clone(); value.make_obj().unwrap().set("version", Value::Num(3.0)); value };
        let unknown_param = { let mut value = effect.clone(); value.make_obj().unwrap().get_mut("params").unwrap().make_obj().unwrap().set("opaque", Value::Num(1.0)); value };
        let vectors = styk_doc::json::parse(&std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../styk-eval/tests/fixtures/vfx/vectors.json")).unwrap()).unwrap();
        let generator = vectors.get("neutral").unwrap().as_arr().unwrap().iter().filter_map(|case| case.get("effect"))
            .find(|effect| effect.get("type").and_then(Value::as_str) == Some("particles")).unwrap().clone();
        assert!(styk_eval::vfx::parse::effect(&generator).unwrap().kind().is_generator());
        let excessive = (0..=styk_eval::vfx::parse::STACK_LIMIT).map(|index| {
            let mut value = effect.clone(); value.make_obj().unwrap().set("id", Value::str(&format!("effect{index}"))); value
        }).collect();
        let disabled = { let mut value = effect.clone(); value.make_obj().unwrap().set("enabled", Value::Bool(false)); value };
        for (name, table) in [
            ("nonobject", Value::Num(3.0)), ("invalid-key", invalid_key),
            ("nonarray", owner(Value::Num(3.0))), ("invalid-param", owner(Value::array(vec![invalid_param]))),
            ("invalid-record", owner(Value::array(vec![invalid_record]))), ("unknown-param", owner(Value::array(vec![unknown_param]))),
            ("duplicate", owner(Value::array(vec![effect.clone(), effect.clone()]))),
            ("generator", owner(Value::array(vec![generator]))), ("over-limit", owner(Value::array(excessive))),
        ] {
            let mut cache = editor.eval.borrow().clone();
            let warm = replace_object(&record, slot, |object| { object.set("_stykVfx", table); });
            let before = cache.edit_frame(&warm, &prepared).unwrap();
            let next = replace_object(&warm, slot, |object| { object.set("root_y", Value::Num(-0.0)); });
            let frame = converted_vfx_frame(&mut cache, &next, &prepared);
            assert!(!cache.loader.notes.is_empty(), "{name}: original parser emitted no diagnostic");
            assert!(!Arc::ptr_eq(before.objects[slot].vfx.as_ref().unwrap(), frame.objects[slot].vfx.as_ref().unwrap()), "{name}: warning-producing owner must parse again");
        }
        // Falsy owners remain absent. Valid empty owners/stacks remain present;
        // a packed empty numeric stack is ambiguous and uses the original parser.
        for (table, reusable) in [
            (None, false), (Some(Value::Null), false), (Some(Value::Bool(false)), false),
            (Some(Value::object(Obj::new())), true), (Some(owner(Value::array(vec![]))), true),
            (Some(owner(Value::Nums(Arc::new(styk_doc::Nums::new(&[]))))), false),
            (Some(owner(Value::array(vec![disabled]))), true),
        ] {
            let mut cache = editor.eval.borrow().clone();
            let warm = replace_object(&record, slot, |object| { match table { Some(table) => { object.set("_stykVfx", table); }, None => { object.remove("_stykVfx"); } } });
            let before = cache.edit_frame(&warm, &prepared).unwrap();
            let next = replace_object(&warm, slot, |object| { object.set("root_x", Value::Num(-0.0)); });
            let frame = converted_vfx_frame(&mut cache, &next, &prepared);
            assert!(cache.loader.notes.is_empty());
            match (&before.objects[slot].vfx, &frame.objects[slot].vfx) {
                (Some(a), Some(b)) => assert_eq!(Arc::ptr_eq(a, b), reusable),
                (None, None) => assert!(!reusable),
                _ => panic!("presence changed"),
            }
        }
    }

    // Actual Editor-recorded startup prefix: pose, rotate, then stretch/bend.
    // It supplies enabled numeric overrides without inventing new recordings.
    fn pose_field_editor() -> Editor {
        let reference = recorded("startup-sheet");
        let mut editor = recorded_editor(&reference);
        for step in reference.get("steps").unwrap().elements().unwrap().iter().skip(1).take(4) {
            let call = step.get("call").unwrap();
            let method = call.item(0).unwrap().as_str().unwrap().to_string();
            let args = call.elements().unwrap().iter().skip(1).collect::<Vec<_>>();
            editor.call(if method == "@select" { "select" } else { &method }, &args).unwrap();
        }
        editor
    }

    #[test]
    fn latest_typed_view_pose_fields_share_actual_editor_numeric_overrides() {
        let mut editor = pose_field_editor();
        let report = styk_doc::json::to_string(&editor.report);
        editor.call("beginDrag", &[Value::str("Pose figure")]).unwrap();
        let (prepared, first, scene) = editor.evaluate_only(Some(&[0])).unwrap();
        assert!(first.objects[0].lengths.is_some() && first.objects[0].bends.is_some());
        let mut previous = editor.shown_frame().unwrap();
        let end = scene.objects[0].ends[2];
        for offset in [5.0, 9.0] {
            editor.eval.borrow_mut().loader.notes.clear();
            assert_eq!(editor.call("poseJoint", &[Value::Num(end[0] + offset), Value::Num(end[1] + 3.0), parse(r#"{"snap":false}"#)]).unwrap(), Value::Bool(true));
            let record = editor.shown_frame().unwrap();
            let old = previous.get("objects").unwrap().item(0).unwrap();
            let raw = record.get("objects").unwrap().item(0).unwrap();
            assert!(Arc::ptr_eq(old.as_obj().unwrap().shape(), raw.as_obj().unwrap().shape()));
            assert!(raw.as_obj().unwrap().len() <= 64);
            for ((key, value), old) in raw.as_obj().unwrap().iter().zip(old.as_obj().unwrap().values()) {
                if !matches!(&**key, "angles" | "root_x" | "root_y" | "scale") { assert!(value.same_node(old), "unchanged {key}"); }
            }
            let (current, frame) = editor.evaluate_frame().unwrap();
            assert!(Arc::ptr_eq(&prepared, &current));
            assert!(Arc::ptr_eq(first.objects[0].lengths.as_ref().unwrap(), frame.objects[0].lengths.as_ref().unwrap()), "real changed pose retains its parsed lengths");
            assert!(Arc::ptr_eq(first.objects[0].bends.as_ref().unwrap(), frame.objects[0].bends.as_ref().unwrap()), "real changed pose retains its parsed bends");
            assert!(!Arc::ptr_eq(&first.objects[0].angles, &frame.objects[0].angles));
            let mut fresh = editor.eval.borrow().loader.clone(); fresh.notes.clear();
            let cold = fresh.edit_frame(&record, None, &current.doc).unwrap();
            assert_eq!(editor.eval.borrow().loader.notes, fresh.notes);
            assert_eq!(format!("{frame:?}"), format!("{cold:?}"));
            assert_fresh(&editor.eval.borrow(), &record, &current, &frame);
            previous = record;
        }
        editor.call("cancelDrag", &[]).unwrap();
        assert_eq!(styk_doc::json::to_string(&editor.report), report);
    }

    #[test]
    fn latest_typed_view_pose_fields_preserve_numeric_defaults_and_wrapper() {
        let editor = pose_field_editor(); let prepared = editor.prepared().unwrap(); let record = editor.shown_frame().unwrap();
        let record = replace_object(&record, 0, |object| { object.set("_movieclipSample", Value::Num(5.25)); });
        let mut cache = editor.eval.borrow().clone();
        let first = cache.edit_frame(&record, &prepared).unwrap();
        assert_eq!(first.objects[0].clip_time, Some(5.25));
        for angles in [Value::nums(&[-0.0, 0.125]), Value::Null, Value::array(vec![Value::str("invalid")])] {
            let next = replace_object(&record, 0, |object| {
                object.set("angles", angles);
                object.set("root_x", Value::Null); object.set("root_y", Value::Num(-0.0)); object.set("scale", Value::str("invalid"));
            });
            let frame = converted_vfx_frame(&mut cache, &next, &prepared);
            assert_eq!(frame.objects[0].root.map(f64::to_bits), [0.0f64.to_bits(), (-0.0f64).to_bits()]);
            assert_eq!(frame.objects[0].scale.to_bits(), 1.0f64.to_bits());
            assert_eq!(frame.objects[0].clip_time, Some(5.25));
            assert!(frame.objects[0].figure_override.is_none());
            assert!(Arc::ptr_eq(first.objects[0].lengths.as_ref().unwrap(), frame.objects[0].lengths.as_ref().unwrap()));
        }
        let segment = prepared.doc.figure(first.objects[0].figure).unwrap().segments[0].id;
        let styled = replace_object(&record, 0, |object| { object.set("_stykStyle", parse(&format!(r#"{{"segments":{{"{segment}":{{"thickness":7.25}}}}}}"#))); });
        let mut cache = editor.eval.borrow().clone(); let before = cache.edit_frame(&styled, &prepared).unwrap();
        let next = replace_object(&styled, 0, |object| { object.set("root_y", Value::Num(-0.0)); });
        let frame = converted_vfx_frame(&mut cache, &next, &prepared);
        assert!(!Arc::ptr_eq(before.objects[0].lengths.as_ref().unwrap(), frame.objects[0].lengths.as_ref().unwrap()));
        assert_eq!(frame.objects[0].figure_override.as_ref().unwrap().segments[0].thickness, 7.25);
        assert_eq!(frame.objects[0].clip_time, Some(5.25));
        let mut cache = editor.eval.borrow().clone(); let before = cache.edit_frame(&record, &prepared).unwrap();
        let changed_clock = replace_object(&record, 0, |object| { object.set("_movieclipSample", Value::Null); object.set("root_y", Value::Num(-0.0)); });
        let frame = converted_vfx_frame(&mut cache, &changed_clock, &prepared);
        assert!(frame.objects[0].clip_time.is_none());
        assert!(!Arc::ptr_eq(before.objects[0].lengths.as_ref().unwrap(), frame.objects[0].lengths.as_ref().unwrap()), "sample changes retain the original conversion");
    }

    #[test]
    fn latest_typed_view_pose_fields_repeat_connected_and_sprite_notes() {
        let editor = pose_field_editor(); let prepared = editor.prepared().unwrap(); let record = editor.shown_frame().unwrap();
        let effect = parse(r#"{"version":2,"id":"effect1","type":"blur","enabled":true,"params":{"radius":4}}"#);
        let over_limit = Value::array((0..=styk_eval::vfx::parse::STACK_LIMIT).map(|i| {
            let mut value = effect.clone(); value.make_obj().unwrap().set("id", Value::str(&format!("effect{i}"))); value
        }).collect());
        for (name, connected, sprite, reusable) in [
            ("absent", None, None, true), ("valid", Some(Value::array(vec![effect.clone()])), None, true),
            ("null", Some(Value::Null), None, false), ("nonarray", Some(Value::Num(3.0)), None, false),
            ("duplicate", Some(Value::array(vec![effect.clone(), effect])), None, false),
            ("over-limit", Some(over_limit), None, false), ("invalid-sprite", None, Some(Value::Null), false),
        ] {
            let warm = replace_object(&record, 0, |object| {
                if let Some(value) = connected { object.set("_vfxConnectedEffects", value); }
                if let Some(value) = sprite { object.set("_sticknodesSprite", value); }
            });
            let mut cache = editor.eval.borrow().clone(); let before = cache.edit_frame(&warm, &prepared).unwrap();
            let next = replace_object(&warm, 0, |object| { object.set("root_y", Value::Num(-0.0)); });
            let frame = converted_vfx_frame(&mut cache, &next, &prepared);
            assert_eq!(Arc::ptr_eq(before.objects[0].lengths.as_ref().unwrap(), frame.objects[0].lengths.as_ref().unwrap()), reusable, "{name}");
            assert_eq!(cache.loader.notes.is_empty(), reusable, "{name}");
            if name == "valid" { assert!(Arc::ptr_eq(before.objects[0].vfx_connected.as_ref().unwrap(), frame.objects[0].vfx_connected.as_ref().unwrap())); }
        }
    }

    #[test]
    fn latest_typed_view_pose_fields_preserve_duplicate_key_resolution() {
        let editor = pose_field_editor(); let prepared = editor.prepared().unwrap(); let record = editor.shown_frame().unwrap();
        let raw = record.get("objects").unwrap().item(0).unwrap();
        for wide in [false, true] {
            for changed in ["angles", "root_x", "root_y", "scale"] {
                let mut keys = ["unique_id", "figure_type_id", "angles", "root_x", "root_y", "scale"].iter().map(|key| Arc::<str>::from(*key)).collect::<Vec<_>>();
                let mut values = keys.iter().map(|key| raw.get(key).unwrap().clone()).collect::<Vec<_>>();
                keys.push(Arc::from(changed)); values.push(raw.get(changed).unwrap().clone());
                if wide { for i in 0..2 { keys.push(Arc::from(format!("opaque{i}"))); values.push(Value::Null); } }
                let shape = styk_doc::Shape::new(keys);
                let warm = replace_object(&record, 0, |object| { *object = Obj::from_shape(shape.clone(), values); });
                let mut cache = editor.eval.borrow().clone(); let before = cache.edit_frame(&warm, &prepared).unwrap();
                let next = replace_object(&warm, 0, |object| { object.set(changed, if changed == "angles" { Value::nums(&[0.75]) } else { Value::Num(7.25) }); });
                assert!(Arc::ptr_eq(warm.get("objects").unwrap().item(0).unwrap().as_obj().unwrap().shape(), next.get("objects").unwrap().item(0).unwrap().as_obj().unwrap().shape()));
                // Obj resolves the first duplicate in narrow Shapes and the
                // last in wide Shapes. Conversion must retain that same owner.
                let frame = converted_vfx_frame(&mut cache, &next, &prepared);
                match changed {
                    "angles" => { assert_eq!(frame.objects[0].angles[0].to_bits(), 0.75f64.to_bits()); assert!(!Arc::ptr_eq(&before.objects[0].angles, &frame.objects[0].angles)); },
                    "root_x" => assert_eq!(frame.objects[0].root[0].to_bits(), 7.25f64.to_bits()),
                    "root_y" => assert_eq!(frame.objects[0].root[1].to_bits(), 7.25f64.to_bits()),
                    _ => assert_eq!(frame.objects[0].scale.to_bits(), 7.25f64.to_bits()),
                }
            }
        }
    }

    #[test]
    fn latest_typed_view_pose_fields_limit_field_scan_rich_nodes_and_lineage() {
        let editor = pose_field_editor(); let prepared = editor.prepared().unwrap(); let record = editor.shown_frame().unwrap();
        for count in [64, 65] {
            let warm = replace_object(&record, 0, |object| {
                while object.len() < count { object.set(&format!("opaque{}", object.len()), Value::Num(1.0)); }
                assert_eq!(object.len(), count);
            });
            let mut cache = editor.eval.borrow().clone(); let before = cache.edit_frame(&warm, &prepared).unwrap();
            let next = replace_object(&warm, 0, |object| { object.set("root_y", Value::Num(-0.0)); });
            let frame = converted_vfx_frame(&mut cache, &next, &prepared);
            assert_eq!(Arc::ptr_eq(before.objects[0].lengths.as_ref().unwrap(), frame.objects[0].lengths.as_ref().unwrap()), count == 64);
        }
        for rich in ["_stykStyle", "_sticknodesSprite", "_sticknodesShapes", "_stykMovieclip", "_stykSpatial", "_stykAnimationOrigin", "color_transition"] {
            let warm = replace_object(&record, 0, |object| { object.set(rich, Value::Null); });
            let mut cache = editor.eval.borrow().clone(); let before = cache.edit_frame(&warm, &prepared).unwrap();
            let next = replace_object(&warm, 0, |object| { object.set("root_y", Value::Num(-0.0)); });
            let frame = converted_vfx_frame(&mut cache, &next, &prepared);
            assert!(!Arc::ptr_eq(before.objects[0].lengths.as_ref().unwrap(), frame.objects[0].lengths.as_ref().unwrap()), "{rich}");
        }
        for change in 0..4 {
            let warm = replace_object(&record, 0, |object| { object.set("opaque", parse(r#"{"nested":1}"#)); });
            let mut cache = editor.eval.borrow().clone(); let before = cache.edit_frame(&warm, &prepared).unwrap();
            let next = replace_object(&warm, 0, |object| {
                match change {
                    0 => { object.set("unique_id", Value::Num(1234.0)); },
                    1 => { object.set("opaque", parse(r#"{"nested":1}"#)); },
                    2 => { object.set("opaque", parse(r#"{"nested":2}"#)); },
                    _ => { object.set("new-key", Value::Null); },
                }
                object.set("root_y", Value::Num(-0.0));
            });
            let frame = converted_vfx_frame(&mut cache, &next, &prepared);
            assert!(!Arc::ptr_eq(before.objects[0].lengths.as_ref().unwrap(), frame.objects[0].lengths.as_ref().unwrap()), "guard {change}");
        }
        let mut cache = editor.eval.borrow().clone(); let before = cache.edit_frame(&record, &prepared).unwrap();
        let next = replace_object(&record, 0, |object| { object.set("root_y", Value::Num(-0.0)); });
        let new_lineage = Arc::new(Prepared::new(prepared.doc.clone()));
        let frame = converted_vfx_frame(&mut cache, &next, &new_lineage);
        assert!(!Arc::ptr_eq(before.objects[0].lengths.as_ref().unwrap(), frame.objects[0].lengths.as_ref().unwrap()));
        let coherent = cache.latest_typed.as_ref().unwrap().clone();
        // Invalid identity/figure still follows the original converter's order.
        for key in ["unique_id", "figure_type_id"] {
            let malformed = replace_object(&next, 0, |object| { object.set(key, Value::Null); });
            let old = cache.loader.clone().edit_frame(&malformed, None, &new_lineage.doc).unwrap_err().to_string();
            assert_eq!(cache.edit_frame(&malformed, &new_lineage).unwrap_err().to_string(), old);
            assert!(Arc::ptr_eq(cache.latest_typed.as_ref().unwrap(), &coherent));
        }
    }

    #[test]
    fn camera_without_motion_does_not_prepare_typed_document() {
        let report = styk_doc::json::parse(br#"{"_styk":{"cameraMotion":{"clips":[]}}}"#).unwrap();
        let editor = crate::Editor::new(report, crate::Options::default());
        let frame = styk_doc::json::parse(br#"{"camera":{"is_default":false,"x":4}}"#).unwrap();
        assert_eq!(editor.camera_at_time(&frame, 90_000.0).unwrap(), frame.get("camera").cloned());
        assert!(editor.eval.borrow().prepared.is_none(), "empty camera clips prepared the document");
    }

    fn assert_shape_query(editor: &Editor, counts: &mut [usize; 5]) {
        let selected = editor.selection_frame().unwrap().iter().position(|object| uid(object) == editor.selection.uid);
        let Some(slot) = selected else { return };
        let (prepared, frame, full) = editor.evaluate_only(Some(&[slot])).unwrap();
        let (query_prepared, query_frame, query) = editor.evaluate_for_shape(Some(&[slot])).unwrap();
        assert!(Arc::ptr_eq(&prepared, &query_prepared));
        assert_eq!(frame.objects.len(), query_frame.objects.len());
        for (before, after) in frame.objects.iter().zip(&query_frame.objects) { assert!(Arc::ptr_eq(before, after)); }
        assert_eq!(full.figure_of, query.figure_of);
        assert_eq!(full.objects.len(), query.objects.len());
        let rig_bits = |rig: &Option<Arc<[styk_eval::geometry::RigJoint]>>| rig.as_deref().map(|joints| joints.iter().map(|joint| (
            joint.space.map(|space| (space.rotation.to_bits(), space.follow.map(|(a, b)| (a.to_bits(), b.to_bits())))),
            joint.connector, [joint.angle, joint.bend, joint.length, joint.authored].map(f64::to_bits),
        )).collect::<Vec<_>>());
        for (geometry, actual) in full.objects.iter().zip(&query.objects) {
            assert_eq!((geometry.slot, geometry.uid, geometry.figure, geometry.resolved), (actual.slot, actual.uid, actual.figure, actual.resolved));
            assert_eq!(geometry.root.map(f64::to_bits), actual.root.map(f64::to_bits));
            assert_eq!(geometry.scale.to_bits(), actual.scale.to_bits());
            assert_eq!(geometry.starts.iter().map(|p| p.map(f64::to_bits)).collect::<Vec<_>>(), actual.starts.iter().map(|p| p.map(f64::to_bits)).collect::<Vec<_>>());
            assert_eq!(geometry.ends.iter().map(|p| p.map(f64::to_bits)).collect::<Vec<_>>(), actual.ends.iter().map(|p| p.map(f64::to_bits)).collect::<Vec<_>>());
            assert_eq!(rig_bits(&geometry.rig), rig_bits(&actual.rig));
            if !geometry.resolved { continue; }
            let at = geometry.slot as usize;
            let object = &frame.objects[at];
            let figure = object.figure_override.as_ref().or_else(|| prepared.doc.figure(object.figure)).unwrap();
            for index in 0..figure.segments.len() {
                assert_eq!(crate::ik::shape_angle(&prepared, &frame, &full, at, index).to_bits(), crate::ik::shape_angle(&query_prepared, &query_frame, &query, at, index).to_bits(), "shape angle slot{at}/joint{index}");
            }
            // Rig/connector shapes also consume item angle/bend/length and its
            // curve. The geometry owner's rich-query fallback must retain them.
            if geometry.rig.is_some() {
                for item in full.items.iter().filter(|item| item.slot == geometry.slot && !matches!(item.kind, styk_eval::geometry::ItemKind::Poly | styk_eval::geometry::ItemKind::Mesh)) {
                    let actual = query.items.iter().find(|actual| actual.slot == item.slot && actual.index == item.index && actual.kind == item.kind).unwrap();
                    assert_eq!([item.angle, item.bend, item.length].map(f64::to_bits), [actual.angle, actual.bend, actual.length].map(f64::to_bits));
                    assert_eq!(item.start.map(f64::to_bits), actual.start.map(f64::to_bits));
                    assert_eq!(item.end.map(f64::to_bits), actual.end.map(f64::to_bits));
                    assert_eq!(full.points_of(item).iter().map(|p| p.map(f64::to_bits)).collect::<Vec<_>>(), query.points_of(actual).iter().map(|p| p.map(f64::to_bits)).collect::<Vec<_>>());
                }
            }
            if at == slot {
                let index = usize::try_from(editor.selection.joint).ok().filter(|&index| index < figure.segments.len()).unwrap_or(0);
                if figure.segments.get(index).is_some() {
                    let (joint_prepared, joint_frame, joint_scene) = editor.evaluate_for_joint_shape(Some(slot), index).unwrap();
                    assert!(Arc::ptr_eq(&prepared, &joint_prepared));
                    for (before, after) in frame.objects.iter().zip(&joint_frame.objects) { assert!(Arc::ptr_eq(before, after)); }
                    let joint_geometry = &joint_scene.objects[slot];
                    assert_eq!((geometry.slot, geometry.uid, geometry.figure, geometry.resolved), (joint_geometry.slot, joint_geometry.uid, joint_geometry.figure, joint_geometry.resolved));
                    assert_eq!(geometry.root.map(f64::to_bits), joint_geometry.root.map(f64::to_bits));
                    assert_eq!(geometry.starts[index].map(f64::to_bits), joint_geometry.starts[index].map(f64::to_bits));
                    assert_eq!(geometry.ends[index].map(f64::to_bits), joint_geometry.ends[index].map(f64::to_bits));
                    assert_eq!(geometry.lengths[index].to_bits(), joint_geometry.lengths[index].to_bits());
                    assert_eq!(crate::ik::shape_angle(&prepared, &frame, &full, at, index).to_bits(), crate::ik::shape_angle(&joint_prepared, &joint_frame, &joint_scene, at, index).to_bits(), "selected shape angle slot{at}/joint{index}");
                    assert_eq!(rig_bits(&geometry.rig), rig_bits(&joint_geometry.rig));
                }
            }
            counts[0] += 1;
            counts[1] += usize::from(geometry.rig.is_some());
            counts[2] += usize::from(geometry.spatial.is_some());
            counts[3] += usize::from(figure.movieclip.is_some());
            counts[4] += usize::from(object.join.is_some());
        }
    }

    #[test]
    fn shape_query_preserves_consumed_geometry_on_recorded_live_history_and_rich_states() {
        let mut counts = [0usize; 5];
        let mut calls = 0usize;
        for name in ["startup-sheet", "rig-sheet", "gestures-sheet", "drag-cancel", "pinned-ik-sheet", "ik-followers-sheet", "ik-joined-sheet", "ik-joined-late-sheet", "ik-settings-rig-sheet", "ik-spatial-joined-free-sheet", "ik-movieclip-parent-sheet", "origin-pose-support-free-native", "origin-pose-support-free-sheet", "origin-pose-support-pinned-native", "origin-pose-support-pinned-sheet"] {
            let reference = recorded(name);
            let mut editor = recorded_editor(&reference);
            let steps = reference.get("steps").unwrap().elements().unwrap();
            let mut expected = steps.get(0).unwrap().get("document").unwrap().as_str().unwrap().to_string();
            assert_shape_query(&editor, &mut counts);
            for step in steps.iter().skip(1) {
                let call = step.get("call").unwrap().elements().unwrap().iter().collect::<Vec<_>>();
                let method = call[0].as_str().unwrap();
                let measured = step.get("boundsArgs").and_then(Value::elements).map(|items| items.iter().collect::<Vec<_>>());
                editor.set_draws(step.get("draws").unwrap_or(&Value::Null));
                let result = editor.call(method, measured.as_deref().unwrap_or(&call[1..]));
                match (result, step.get("error").filter(|error| !error.is_null())) {
                    (Ok(_), None) => {},
                    (Err(EditError::Invalid(key)), Some(error)) => assert_eq!(Some(crate::error_key(&key)), error.get("key").and_then(Value::as_str).or_else(|| error.get("message").and_then(Value::as_str))),
                    (result, error) => panic!("{name}/{method}: {result:?}, recorded {error:?}"),
                }
                if let Some(document) = step.get("document").and_then(Value::as_str) { expected = document.to_string(); }
                assert_eq!(editor.report_json(), expected, "{name}/{method}: document");
                assert_eq!(Some(&editor.state_value()), step.get("state"), "{name}/{method}: state");
                assert_eq!(Some(&Value::array(editor.take_events())), step.get("events"), "{name}/{method}: events");
                assert_shape_query(&editor, &mut counts);
                calls += 1;
            }
        }
        assert_eq!(calls, 576);
        assert!(counts.iter().all(|&count| count > 0), "actual shape geometry / rig / spatial / movieclip / ancestor coverage: {counts:?}");
    }

    #[test]
    fn shape_query_keeps_full_none_and_original_preparation_conversion_error_order() {
        let reference = recorded("gestures-sheet");
        let mut editor = recorded_editor(&reference);
        let (prepared, frame, full) = editor.evaluate_only(None).unwrap();
        let (query_prepared, query_frame, query) = editor.evaluate_for_shape(None).unwrap();
        assert!(Arc::ptr_eq(&prepared, &query_prepared));
        for (before, after) in frame.objects.iter().zip(&query_frame.objects) { assert!(Arc::ptr_eq(before, after)); }
        assert_eq!(format!("{:?}", full.objects), format!("{:?}", query.objects));
        assert_eq!(format!("{:?}", full.items), format!("{:?}", query.items));
        assert_eq!(full.points.iter().map(|p| p.map(f64::to_bits)).collect::<Vec<_>>(), query.points.iter().map(|p| p.map(f64::to_bits)).collect::<Vec<_>>());
        let source = editor.shown_frame().unwrap();
        let mut invalid = source.clone();
        invalid.make_obj().unwrap().get_mut("objects").unwrap().make_arr().unwrap()[0] = Value::Null;
        editor.authored = Some(crate::Authored { source, frame: invalid, tick: editor.tick, transaction: false, definitions_start: None, key_at_playhead: false, key_at_playhead_layers: Vec::new() });
        let coherent = editor.eval.borrow().latest_typed.as_ref().unwrap().clone();
        let old = editor.evaluate_only(Some(&[0])).err().unwrap();
        assert!(matches!(&old, EditError::Invalid(_)));
        assert_eq!(format!("{old:?}"), format!("{:?}", editor.evaluate_for_shape(Some(&[0])).err().unwrap()));
        assert_eq!(format!("{old:?}"), format!("{:?}", editor.evaluate_for_joint_shape(Some(0), 0).err().unwrap()));
        assert!(Arc::ptr_eq(editor.eval.borrow().latest_typed.as_ref().unwrap(), &coherent), "conversion error never installs a partial typed frame");
    }

}

/// A contiguous native row splice (`kind: 'ranges'`), shared by native frame commands.
/// Values remain immutable COW records; applying history never mutates its snapshots.
#[derive(Clone, Debug)]
pub struct FrameSlice {
    pub index: usize,
    pub before: Vec<Value>,
    pub after: Vec<Value>,
}

impl FrameSlice {
    pub(crate) fn history_value(&self) -> Value {
        let mut value = Obj::new();
        value.set("index", Value::Num(self.index as f64));
        value.set("before", Value::array(self.before.clone()));
        value.set("after", Value::array(self.after.clone()));
        Value::object(value)
    }
}

/// The existing native keyframe array owns row splices. The direction determines
/// ordering when more than one disjoint original range is replaced.
pub(crate) fn splice_ranges(report: &mut Value, changes: &[FrameSlice], after: bool) -> Result<(), EditError> {
    let frames = report.make_obj().and_then(|report| report.get_mut("keyframes")).and_then(Value::make_arr)
        .ok_or_else(|| EditError::Unported("native ranges without a keyframe array".into()))?;
    let mut ordered = changes.iter().collect::<Vec<_>>();
    ordered.sort_by_key(|change| change.index);
    if after { ordered.reverse(); }
    for change in ordered {
        let (removed, inserted) = if after { (&change.before, &change.after) } else { (&change.after, &change.before) };
        if change.index > frames.len() || removed.len() > frames.len() - change.index {
            return Err(EditError::Unported("native ranges outside the keyframe array".into()));
        }
        frames.splice(change.index..change.index + removed.len(), inserted.iter().cloned());
    }
    Ok(())
}

impl Editor {
    /// `_reconcileFrameIds(previous)`: live unchanged nodes reserve their identity;
    /// retained sources and every earlier row reserve theirs in traversal order.
    fn reconcile_native_frame_ids(&self, report: &mut Value) -> Result<u64, EditError> {
        let previous = native_frames_of(&self.report);
        let mut frames = native_frames_of(report);
        let live = frames.iter().filter_map(|frame| match frame { Value::Obj(node) => Some(Arc::as_ptr(node) as usize), _ => None }).collect::<std::collections::HashSet<_>>();
        let mut reserved = std::collections::HashMap::new();
        for old in &previous {
            if matches!(old, Value::Obj(node) if live.contains(&(Arc::as_ptr(node) as usize))) {
                if let Some(id) = old.path(&["_styk", "frameId"]).and_then(Value::as_str) { reserved.insert(id.to_string(), old.clone()); }
            }
        }
        let mut retained = report.path(&["_styk", "frameSources"]).and_then(Value::as_obj)
            .map(|sources| sources.keys().map(|id| id.to_string()).collect::<std::collections::HashSet<_>>()).unwrap_or_default();
        let mut next = self.next_frame_identity;
        for frame in &mut frames {
            let id = frame.path(&["_styk", "frameId"]).and_then(Value::as_str).map(str::to_string);
            if id.as_ref().is_none_or(|id| retained.contains(id) || reserved.get(id).is_some_and(|old| !old.same_node(frame))) {
                if next > 9_007_199_254_740_991 { return Err(EditError::Unported("native row identity capacity before its recording".into())); }
                let mut fields = frame.as_obj().cloned().ok_or_else(|| EditError::Unported("a native row that is not an object".into()))?;
                let mut styk = frame.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
                styk.set("frameId", Value::str(&format!("frame-{next}"))); next += 1;
                fields.set("_styk", Value::object(styk)); *frame = Value::object(fields);
            }
            retained.insert(frame.path(&["_styk", "frameId"]).and_then(Value::as_str).unwrap().to_string());
        }
        report.make_obj().unwrap().set("keyframes", Value::array(frames));
        Ok(next)
    }

    /// A native row transaction shared by split, falloff and future recorded frame
    /// commands. Authored reference capture remains unavailable until recorded.
    pub(crate) fn commit_native_ranges(&mut self, mut changes: Vec<FrameSlice>, label: &str, before_selection: crate::select::SelectionState, structural: bool, timing: bool) -> Result<bool, EditError> {
        if changes.len() != 1 { return Err(EditError::Unported("multiple native row splices before their recordings".into())); }
        if self.report.path(&["_styk", "animation", "channels"]).and_then(Value::array_len).unwrap_or(0) != 0 || self.report.path(&["_styk", "simpleFrameDraft"]).is_some() {
            return Err(EditError::Unported("native ranges with authored frame references".into()));
        }
        let mut report = self.report.clone();
        splice_ranges(&mut report, &changes, true)?;
        let next = self.reconcile_native_frame_ids(&mut report)?;
        // Reconciliation may assign new identities; history captures exactly the
        // published rows, rather than the pre-reconciliation pieces.
        for change in &mut changes {
            change.after = native_frames_of(&report).into_iter().skip(change.index).take(change.after.len()).collect();
        }
        self.ensure_counts();
        self.report = report; self.next_frame_identity = next; self.retained = None;
        let previous = changes.iter().flat_map(|change| change.before.iter().cloned()).collect::<Vec<_>>();
        let current = changes.iter().flat_map(|change| change.after.iter().cloned()).collect::<Vec<_>>();
        let layers = self.track_frames(&previous, &current, true)?;
        self.frame_index = crate::timeline::rows(&self.report).iter().rposition(|row| row.start <= self.tick).unwrap_or(0);
        let indices = changes.iter().flat_map(|change| change.index..change.index + change.after.len()).map(|index| Value::Num(index as f64)).collect();
        self.record(crate::history::Command { kind: crate::history::CommandKind::Ranges { changes, structural, timing }, label: label.into(), before_selection, after_selection: self.selection_state(), before_revision: 0, after_revision: 0, layer_changes: Vec::new(), captured_source_bytes: 0, layers })?;
        self.emit("edit", vec![("label", Value::str(label)), ("structural", Value::Bool(structural)), ("timing", Value::Bool(timing)), ("frameIndices", Value::array(indices))]);
        Ok(true)
    }

    pub(crate) fn apply_native_ranges(&mut self, command: &crate::history::Command, direction: crate::history::Direction) -> Result<(), EditError> {
        let crate::history::CommandKind::Ranges { changes, structural, timing } = &command.kind else { return Ok(()) };
        let after = direction == crate::history::Direction::After;
        self.ensure_counts();
        splice_ranges(&mut self.report, changes, after)?;
        let (previous, current) = if after {
            (changes.iter().flat_map(|change| change.before.iter().cloned()).collect::<Vec<_>>(), changes.iter().flat_map(|change| change.after.iter().cloned()).collect::<Vec<_>>())
        } else {
            (changes.iter().flat_map(|change| change.after.iter().cloned()).collect::<Vec<_>>(), changes.iter().flat_map(|change| change.before.iter().cloned()).collect::<Vec<_>>())
        };
        self.track_frames(&previous, &current, false)?;
        self.apply_attached_layer_changes(&command.layer_changes, direction);
        self.retained = None;
        let (selection, revision) = if after { (&command.after_selection, command.after_revision) } else { (&command.before_selection, command.before_revision) };
        self.restore_selection(selection)?; self.revision = revision;
        self.emit("history", vec![("label", Value::str(&command.label)), ("structural", Value::Bool(*structural)), ("timing", Value::Bool(*timing)), ("definition", Value::Bool(false)), ("animation", Value::Bool(false))]);
        Ok(())
    }
}

fn native_frames_of(report: &Value) -> Vec<Value> {
    report.get("keyframes").and_then(Value::elements).map(|frames| frames.iter().collect()).unwrap_or_default()
}

#[cfg(test)]
#[path = "native_sampling_tests.rs"]
mod native_sampling_tests;
