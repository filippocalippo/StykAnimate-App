//! The structure of drawings on a layer sheet (src/editor-drawing.mjs): a drawing layer holds one cel per key,
//! and the commands here make the keys: a new layer with its first blank cel, a blank or copied cel at a frame,
//! the next one after the exposure under the playhead, a longer exposure, and the copy that painting on a held cel
//! makes with auto key. The pixels of a cel are not the document's: a copied cel's go with the call's answer
//! (`Editor::drawing_forks`) for the interface, which holds them, to copy.
//!
//! Pixel commits and resampling are in `drawing_pixels.rs`.

use styk_doc::{Obj, Value};

use crate::sheet::{constant, create_frame, items, key_at, num, Write, MAX_SHEET_TICKS};
use crate::{EditError, Editor};

fn invalid(key: &str) -> EditError {
    EditError::Invalid(key.into())
}

/// A whole number from 1 to 65535.
fn exposure(value: &Value, default: f64) -> Option<f64> {
    let count = if value.is_null() { default } else { value.as_f64()? };
    (count.fract() == 0.0 && (1.0..=65535.0).contains(&count)).then_some(count)
}

/// A figure type identity no definition has: `figure_types.reduce((n, f) => Math.max(n, f.figure_type_id + 1), 1)`.
pub(crate) fn next_figure_type(figures: &[Value]) -> f64 {
    figures.iter().fold(1.0f64, |largest, figure| {
        let id = num(figure, "figure_type_id").unwrap_or(f64::NAN);
        if largest.is_nan() || id.is_nan() { f64::NAN } else { largest.max(id + 1.0) }
    })
}

/// What `drawingTarget` finds: the exposure under a tick of a drawing layer.
pub(crate) struct DrawingTarget {
    /// The identity of the layer key that shows the cel.
    pub key: Value,
    /// Where the exposure starts, and the tick it ends at.
    pub start: f64,
    pub end: f64,
    /// The cel the exposure shows and its figure on the layer, when it shows one.
    pub cel: Option<String>,
    pub object: Option<Value>,
}

impl Editor {
    fn drawing_layer_state(&self, id: &str) -> Option<&Value> {
        self.report.path(&["_styk", "layers", "byId", id]).filter(|layer| layer.path(&["drawing", "version"]).and_then(Value::as_f64) == Some(1.0))
    }

    /// `assertDrawingTargets(editor, ids)`: each id is a drawing layer that is shown and unlocked.
    pub(crate) fn assert_drawing_targets(&self, ids: &[String]) -> Result<(), EditError> {
        if ids.is_empty() {
            return Err(invalid("errors.editorDrawing.chooseADrawingLayer"));
        }
        for id in ids {
            let Some(layer) = self.drawing_layer_state(id) else { return Err(invalid("errors.editorDrawing.chooseADrawingLayerOrCreateANew")) };
            if self.track_locked(id) || !layer.get("visible").is_some_and(Value::truthy) {
                let name = layer.get("name").cloned().unwrap_or(Value::Null);
                return Err(crate::invalid_with("errors.editorDrawing.showAndUnlockBeforeDrawing", vec![("name", name)]));
            }
        }
        Ok(())
    }

    fn track_end(&self, id: &str) -> f64 {
        self.report.path(&["_styk", "layerSheet", "tracks", id, "end"]).and_then(Value::as_f64).unwrap_or(0.0)
    }

    /// `drawingTarget(id, tick)`: the exposure under `tick` (its key, where it starts and ends) and the cel it shows. Nothing is drawn
    /// where there is no cel.
    pub(crate) fn drawing_target(&self, id: &str, tick: f64) -> Result<DrawingTarget, EditError> {
        self.assert_drawing_targets(&[id.to_string()])?;
        let keys = items(self.report.path(&["_styk", "layerSheet", "tracks", id, "keys"]));
        let end = self.track_end(id);
        let at = key_at(&keys, tick);
        let Some(at) = at.filter(|_| tick < end) else { return Err(invalid("errors.editorDrawing.insertABlankDrawingOrCopyDrawingHere")) };
        let frame = keys[at].path(&["value", "frameId"]).and_then(Value::as_str).and_then(|frame| self.frame_by_id(frame));
        let object = frame.as_ref().and_then(|frame| crate::frame::objects_of(frame).into_iter().find(|o| crate::record::uid(o).is_some_and(|u| self.layer_of(u) == id)));
        let mut cel = None;
        if let Some(object) = &object {
            let figure = self.report.get("figure_types").and_then(Value::elements).and_then(|figures| figures.iter().find(|f| f.get("figure_type_id") == object.get("figure_type_id")));
            if !figure.as_ref().is_some_and(|f| f.path(&["_styk", "drawing"]).is_some_and(Value::truthy)) {
                return Err(invalid("errors.editorDrawing.convertThisImageToADrawingBeforePainting"));
            }
            cel = figure.and_then(|f| f.path(&["_styk", "drawing", "celId"]).and_then(Value::as_str).map(str::to_string));
        }
        let next = keys.get(at + 1).and_then(|key| num(key, "tick")).unwrap_or(end);
        Ok(DrawingTarget { key: keys[at].get("id").cloned().unwrap_or(Value::Null), start: num(&keys[at], "tick").unwrap_or(f64::NAN), end: next, cel, object })
    }

    /// `drawingTarget(id, tick)`'s exposure: where the cel under `tick` ends. Nothing is drawn where there is no cel.
    fn drawing_exposure(&self, id: &str, tick: f64) -> Result<(f64, f64), EditError> {
        self.drawing_target(id, tick).map(|target| (target.start, target.end))
    }

    /// `drawingKey(ids, tick, {blank})`: each layer shows a cel from `tick`, blank or a copy of the one it showed.
    pub(crate) fn drawing_key(&mut self, ids: &Value, tick: &Value, options: &Value) -> Result<bool, EditError> {
        let ids = self.list(ids);
        let tick = self.tick_or_playhead(tick);
        let blank = options.get("blank").is_some_and(Value::truthy);
        self.assert_drawing_targets(&ids)?;
        let mut plan = self.planner(&ids)?;
        let figures: Vec<Value> = items(self.report.get("figure_types"));
        let mut next_type = next_figure_type(&figures);
        let mut added: Vec<Value> = Vec::new();
        let mut forks: Vec<(String, String)> = Vec::new();
        let mut changed = false;
        for id in &ids {
            let keys = plan.keys(id);
            let end = plan.end(id);
            if !blank && key_at(&keys, tick).is_some_and(|at| num(&keys[at], "tick") == Some(tick)) {
                continue;
            }
            let source_key = key_at(&keys, tick.min(end - 1.0)).map(|at| keys[at].clone());
            let source = source_key.as_ref().and_then(|key| key.path(&["value", "frameId"])).and_then(Value::as_str).and_then(|frame| self.frame_by_id(frame));
            let mut frame = source.unwrap_or_else(|| create_frame(&[]));
            if !blank {
                let mut objects = items(frame.get("objects"));
                for object in objects.iter_mut() {
                    let old = figures.iter().chain(added.iter()).find(|f| f.get("figure_type_id") == object.get("figure_type_id")).cloned().ok_or_else(|| EditError::Unported("a drawing of a figure the document lacks".into()))?;
                    let cel = format!("cel-{}", self.draw_uuid()?);
                    let mut copy = old.as_obj().cloned().unwrap_or_default();
                    copy.set("figure_type_id", Value::Num(next_type));
                    next_type += 1.0;
                    let mut styk = copy.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
                    let mut drawing = styk.get("drawing").and_then(Value::as_obj).cloned().unwrap_or_default();
                    let from = drawing.get("celId").and_then(Value::as_str).unwrap_or("").to_string();
                    drawing.set("celId", Value::str(&cel));
                    styk.set("drawing", Value::object(drawing));
                    copy.set("_styk", Value::object(styk));
                    if let Some(record) = object.make_obj() {
                        record.set("figure_type_id", Value::Num(next_type - 1.0));
                    }
                    forks.push((from, cel));
                    added.push(Value::object(copy));
                }
                let mut copied = frame.as_obj().cloned().unwrap_or_default();
                copied.set("objects", Value::array(objects));
                frame = Value::object(copied);
            }
            plan.definitions = added.clone();
            if keys.is_empty() && tick > 0.0 {
                plan.write(id, 0.0, &create_frame(&[]), Write { blank: true, easing: Some(&constant()), ..Write::default() })?;
            }
            plan.write(id, tick, &frame, Write { blank, easing: Some(&constant()), extend: true })?;
            changed = true;
        }
        if !changed {
            return Ok(false);
        }
        let selection = self.selection_state();
        let result = self.publish(plan, if blank { "Blank drawing" } else { "Copy drawing" }, selection, None)?;
        self.drawing_forks.extend(forks);
        Ok(result)
    }

    /// `nextDrawing(ids, {blank, length, tick})`: after the exposure under `tick`, room for a new cel of `length` frames, and the cel;
    /// the playhead goes to it.
    pub(crate) fn next_drawing(&mut self, ids: &Value, options: &Value) -> Result<bool, EditError> {
        let ids = self.list(ids);
        self.assert_drawing_targets(&ids)?;
        let length = exposure(options.get("length").unwrap_or(&Value::Null), 1.0).ok_or_else(|| invalid("errors.editorDrawing.chooseAnExposureLengthOf165535"))?;
        let blank = options.get("blank").filter(|b| !b.is_null()).is_none_or(Value::truthy);
        let tick = self.tick_or_playhead(options.get("tick").unwrap_or(&Value::Null));
        let spans: Vec<(String, f64)> = ids.iter().map(|id| (id.clone(), self.sheet_span(id, tick).1)).collect();
        for (id, end) in &spans {
            if end.max(self.track_end(id)) + length > MAX_SHEET_TICKS {
                return Err(invalid("errors.editorDrawing.thisExposureExceedsTheTimelineLimit"));
            }
        }
        self.movieclip_batch(if blank { "Next blank drawing" } else { "Next copied drawing" }, |editor| {
            for (id, end) in &spans {
                // Split before shifting: copying at an existing next key must use the preceding cel, not the next exposure's content.
                let layer = Value::array(vec![Value::str(id)]);
                editor.sheet_insert_frames(&layer, *end, &Value::Num(length))?;
                let mut keyed = Obj::new();
                keyed.set("blank", Value::Bool(blank));
                editor.drawing_key(&layer, &Value::Num(*end), &Value::object(keyed))?;
            }
            editor.seek(spans[0].1)?;
            Ok(true)
        })
    }

    /// `extendDrawing(ids, count)`: the cel under the playhead holds `count` frames longer.
    pub(crate) fn extend_drawing(&mut self, ids: &Value, count: &Value) -> Result<bool, EditError> {
        let ids = self.list(ids);
        self.assert_drawing_targets(&ids)?;
        let count = exposure(count, 1.0).ok_or_else(|| invalid("errors.editorDrawing.chooseAPositiveExposureExtension"))?;
        let mut spans = Vec::new();
        for id in &ids {
            spans.push((id.clone(), self.drawing_exposure(id, self.tick)?.1));
        }
        for (id, _) in &spans {
            if self.track_end(id) + count > MAX_SHEET_TICKS {
                return Err(invalid("errors.editorDrawing.thisExposureExceedsTheTimelineLimit"));
            }
        }
        self.movieclip_batch("Extend drawing exposure", |editor| {
            for (id, end) in &spans {
                editor.sheet_insert_frames(&Value::array(vec![Value::str(id)]), *end, &Value::Num(count))?;
            }
            Ok(true)
        })
    }

    /// `addDrawingFrame(id, tick)`: a blank cel at `tick`, after the exposure there when it already starts one.
    pub(crate) fn add_drawing_frame(&mut self, id: &Value, tick: &Value) -> Result<Value, EditError> {
        let id = id.as_str().map(str::to_string).unwrap_or_else(|| self.active_layer());
        let tick = self.tick_or_playhead(tick);
        self.assert_drawing_targets(std::slice::from_ref(&id))?;
        let on_key = items(self.report.path(&["_styk", "layerSheet", "tracks", &id, "keys"])).iter().any(|key| num(key, "tick") == Some(tick));
        let layer = Value::array(vec![Value::str(&id)]);
        let mut options = Obj::new();
        options.set("blank", Value::Bool(true));
        if on_key && tick < self.track_end(&id) {
            options.set("length", Value::Num(1.0));
            options.set("tick", Value::Num(tick));
            return self.next_drawing(&layer, &Value::object(options)).map(Value::Bool);
        }
        self.drawing_key(&layer, &Value::Num(tick), &Value::object(options)).map(Value::Bool)
    }

    /// `createDrawingLayer(name)`: a drawing layer with its first, blank cel, as one entry. Answers the layer.
    pub(crate) fn create_drawing_layer(&mut self, name: &Value) -> Result<Value, EditError> {
        let name = if name.is_null() { Value::str("Drawing") } else { name.clone() };
        self.movieclip_batch("New drawing layer", |editor| {
            let mut options = Obj::new();
            options.set("drawing", Value::Bool(true));
            let layer = editor.create_layer(&name, &Value::object(options), None)?;
            let id = layer.get("id").cloned().unwrap_or(Value::Null);
            let mut keyed = Obj::new();
            keyed.set("blank", Value::Bool(true));
            editor.drawing_key(&Value::array(vec![id]), &Value::Num(0.0), &Value::object(keyed))?;
            Ok(layer)
        })
    }

    /// `autoKeyDrawing(id, tick)`: painting on a held cel with auto key first copies it to `tick`.
    pub(crate) fn auto_key_drawing(&mut self, id: &Value, tick: &Value) -> Result<bool, EditError> {
        if !self.auto_key {
            return Ok(false);
        }
        let id = id.as_str().map(str::to_string).unwrap_or_else(|| self.active_layer());
        let tick = self.tick_or_playhead(tick);
        let Ok((start, _)) = self.drawing_exposure(&id, tick) else { return Ok(false) };
        if start == tick {
            return Ok(false);
        }
        self.drawing_key(&Value::array(vec![Value::str(&id)]), &Value::Num(tick), &Value::Null)
    }
}
