//! Drawing pixel commits as session commands (src/editor-drawing.mjs `commitDrawingPixels` and `resampleDrawing`).
//!
//! The pixels of a cel are not the document's: the interface's drawing store holds them and its history keeps the
//! before and after tiles of every commit (docs/engine/drawing.md). The session never takes tiles. A stroke, an
//! erase, a fill, a pasted or moved selection arrives as the cel it changes and the interface's `record` of the change; the
//! session records a history entry with that reference, the label and the weight the interface measured, and
//! the interface applies the tiles to its store around the call:
//!
//! - `commitDrawingPixels(target, {record, bytes}, label)` writes the cel into the layer sheet when the stroke
//!   created it or migrated it from a v1 drawing (one entry with the stroke), then records the commit;
//! - `resampleDrawing(target, {pixelsPerUnit, bounds})` makes the cel of the new resolution (a layer sheet entry that adds
//!   its definition) and answers its identity, for the interface to give it the resampled tiles;
//! - undo and redo of a commit change the revision and say so (a `history` event naming the cel); the interface applies the
//!   record's tiles before the call (undo) or after it (redo) of the entry, which `drawingReplay` names;
//! - `@drawingBytes(record, delta)`: the interface moved the record's tiles to or from the disk: the entry weighs as much less
//!   or more, and the history is held to its byte limit again;
//! - `@retractDrawing(record)`: the interface could not apply the tiles of the commit it had the session record: the entry is taken back
//!   (the last entry of the open grouped edit, else of the history), so no entry names a record the interface never made;
//! - `drawingBatch` names the pixel commits of the grouped edit in progress, last first: the interface takes their tiles back when the
//!   group fails and the session aborts it;
//! - `drawingRefs` names the records and cels the history still refers to. The call that retired an entry that referred to
//!   any says so (`drawingRetired`), and the interface lets go of the rest.

use styk_doc::{Obj, Value};

use crate::drawing_structure::next_figure_type;
use crate::history::{Command, CommandKind, Direction};
use crate::sheet::{constant, create_frame, items, num, Write};
use crate::{EditError, Editor};

/// A drawing cel without pixels: the carrier PNG of every v2 cel (`EMPTY_PNG` of src/drawing-model.mjs).
const EMPTY_PNG: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";
/// The largest object identity the editor allocates.
const MAX_ALLOCATED_UID: f64 = 2147483646.0;

fn invalid(key: &str) -> EditError {
    EditError::Invalid(key.into())
}

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

/// Whether a history entry refers to the interface's drawings: a pixel commit, a cel a layer sheet entry added, or a batch of those.
pub(crate) fn references_drawings(command: &Command) -> bool {
    match &command.kind {
        CommandKind::DrawingPixels { .. } => true,
        CommandKind::LayerSheet { definitions: Some((_, figures)), .. } => figures.iter().any(is_drawing),
        CommandKind::Batch { commands } => commands.iter().any(references_drawings),
        _ => false,
    }
}

/// Whether `command` is the pixel commit of `record`, or a batch holding it.
pub(crate) fn holds_record(command: &Command, record: u64) -> bool {
    match &command.kind {
        CommandKind::DrawingPixels { record: held, .. } => *held == record,
        CommandKind::Batch { commands } => commands.iter().any(|child| holds_record(child, record)),
        _ => false,
    }
}

/// The pixel commits applying `command` (an undo, or a redo) applies, in the order it applies them.
fn replay_steps(command: &Command, redo: bool, out: &mut Vec<Value>) {
    match &command.kind {
        CommandKind::DrawingPixels { cel_id, record } => {
            let mut step = Obj::new();
            step.set("celId", Value::str(cel_id));
            step.set("record", Value::Num(*record as f64));
            out.push(Value::object(step));
        }
        CommandKind::Batch { commands } if redo => commands.iter().for_each(|child| replay_steps(child, redo, out)),
        CommandKind::Batch { commands } => commands.iter().rev().for_each(|child| replay_steps(child, redo, out)),
        _ => {}
    }
}

fn is_drawing(figure: &Value) -> bool {
    figure.path(&["_styk", "drawing"]).is_some_and(Value::truthy)
}

/// The object at `path` of `value`, made editable.
fn edit<'a>(value: &'a mut Value, path: &[&str]) -> Option<&'a mut Obj> {
    let mut cursor = value;
    for key in path {
        cursor = cursor.make_obj()?.get_mut(key)?;
    }
    cursor.make_obj()
}

/// `{x, y}`.
fn point(x: f64, y: f64) -> Value {
    let mut point = Obj::new();
    point.set("x", Value::Num(x));
    point.set("y", Value::Num(y));
    Value::object(point)
}

/// `value?.field ?? 0` of a point.
fn coordinate(value: Option<&Value>, key: &str) -> f64 {
    value.and_then(|point| point.get(key)).and_then(Value::as_f64).unwrap_or(0.0)
}

impl Editor {
    /// The index of the definition of cel `cel` in the document's figures.
    fn cel_index(&self, cel: &str) -> Option<usize> {
        self.report.get("figure_types").and_then(Value::elements)?.iter().position(|figure| figure.path(&["_styk", "drawing", "celId"]).and_then(Value::as_str) == Some(cel))
    }

    /// `commitDrawingPixels(target, tiles, label)`, the tiles being the interface's record `pixels.record`. `target` is the
    /// exposure the interface painted on: `{id, tick, keyId, celId, selectable}`, and for a cel the stroke created
    /// (`created`) or migrated from a v1 drawing (`migratedFrom`) its `figure` and `object` too.
    pub(crate) fn commit_drawing_pixels(&mut self, target: &Value, pixels: &Value, label: &Value) -> Result<Value, EditError> {
        let label = label.as_str().unwrap_or("Brush stroke").to_string();
        let id = text(target, "id").ok_or_else(|| invalid("errors.editorDrawing.chooseADrawingLayer"))?;
        self.assert_drawing_targets(std::slice::from_ref(&id))?;
        let tick = num(target, "tick").unwrap_or(f64::NAN);
        let current = self.drawing_target(&id, tick)?;
        let created = target.get("created").is_some_and(Value::truthy);
        let migrated = target.get("migratedFrom").is_some_and(Value::truthy);
        let cel = text(target, "celId").ok_or_else(|| invalid("errors.engineOwner.drawingCommitNeedsACel"))?;
        if current.key.as_str() != target.get("keyId").and_then(Value::as_str) || (!created && !migrated && current.cel.as_deref() != Some(cel.as_str())) {
            return Err(invalid("errors.editorDrawing.theDrawingExposureChangedBeforeTheEditFinished"));
        }
        let record = pixels.get("record").and_then(Value::as_f64).filter(|record| record.fract() == 0.0 && *record >= 0.0).ok_or_else(|| invalid("errors.engineOwner.drawingCommitNeedsARecord"))? as u64;
        let bytes = pixels.get("bytes").and_then(Value::as_f64).filter(|bytes| bytes.is_finite() && *bytes >= 0.0).unwrap_or(0.0);
        let select = target.get("selectable").is_some_and(Value::truthy);
        let written = if created || migrated {
            let figure = target.get("figure").filter(|figure| is_drawing(figure)).cloned();
            let object = target.get("object").filter(|object| object.is_object()).cloned();
            Some(figure.zip(object).ok_or_else(|| invalid("errors.engineOwner.drawingCommitNeedsAFigure"))?)
        } else {
            None
        };
        // Cel creation and migration change the sheet's structure, with the first stroke as one entry; later strokes are pixel commits alone.
        let commit = |editor: &mut Editor| -> Result<(), EditError> {
            if let Some((figure, object)) = &written {
                let uid = crate::record::uid(object);
                let mut plan = editor.planner(std::slice::from_ref(&id))?;
                if let Some(uid) = uid {
                    plan.assign(uid, &id);
                }
                plan.definitions = vec![figure.clone()];
                plan.write(&id, current.start, &create_frame(std::slice::from_ref(object)), Write { easing: Some(&constant()), ..Write::default() })?;
                let selection = editor.selection_state();
                editor.publish(plan, if created { "Create drawing cel" } else { "Migrate drawing" }, selection, None)?;
                let used = uid.map_or(0.0, f64::from);
                if used <= MAX_ALLOCATED_UID {
                    editor.next_uid = editor.next_uid.max(used as u64 + 1);
                }
            }
            let index = editor.cel_index(&cel).ok_or_else(|| invalid("errors.editorDrawing.theDrawingHistoryReferencesAMissingCel"))?;
            let selection = editor.selection_state();
            if select && editor.active_layer() == id && editor.tick >= current.start && editor.tick < current.end {
                editor.select_sheet_layer(&Value::str(&id), &Value::Null)?;
            }
            // The entry is the last thing that can fail: a commit that errs leaves no entry whose record the interface never tracks.
            editor.record_pixels_entry(Command {
                kind: CommandKind::DrawingPixels { cel_id: cel.clone(), record },
                label: label.clone(),
                before_selection: selection.clone(),
                after_selection: selection,
                before_revision: 0,
                after_revision: 0,
                layer_changes: Vec::new(),
                captured_source_bytes: 0,
                layers: false,
            }, bytes)?;
            editor.emit("edit", vec![("label", Value::str(&label)), ("definition", Value::Bool(true)), ("drawing", Value::Bool(true)), ("figureIndices", Value::array(vec![Value::Num(index as f64)]))]);
            Ok(())
        };
        if written.is_some() {
            self.movieclip_batch(&label, commit)?;
        } else {
            commit(self)?;
        }
        Ok(Value::Bool(true))
    }

    /// `resampleDrawing(target, {pixelsPerUnit, bounds})`: the exposure under the playhead shows a cel of the new resolution; pixel (0, 0)
    /// stays fixed, so the anchors and the segment scale with the ratio. Answers the identity of the new cel, which the interface gives the
    /// resampled tiles.
    pub(crate) fn resample_drawing(&mut self, target: &Value, options: &Value) -> Result<Value, EditError> {
        let id = text(target, "id").ok_or_else(|| invalid("errors.editorDrawing.chooseADrawingLayer"))?;
        self.assert_drawing_targets(std::slice::from_ref(&id))?;
        let current = self.drawing_target(&id, self.tick)?;
        let (Some(old_cel), Some(object)) = (current.cel.clone(), current.object.clone()) else { return Err(invalid("errors.editorDrawing.theDrawingChangedBeforeResampling")) };
        if current.key.as_str() != target.get("keyId").and_then(Value::as_str) || Some(old_cel.as_str()) != target.get("celId").and_then(Value::as_str) {
            return Err(invalid("errors.editorDrawing.theDrawingChangedBeforeResampling"));
        }
        let ppu = options.get("pixelsPerUnit").and_then(Value::as_f64).ok_or_else(|| invalid("errors.engineOwner.resampleNeedsAResolution"))?;
        let bounds = options.get("bounds").filter(|bounds| bounds.is_object()).cloned();
        let old_index = self.cel_index(&old_cel).ok_or_else(|| invalid("errors.editorDrawing.theDrawingChangedBeforeResampling"))?;
        let old_figure = self.report.get("figure_types").and_then(|figures| figures.item(old_index)).ok_or_else(|| invalid("errors.editorDrawing.theDrawingChangedBeforeResampling"))?;
        let old = old_figure.path(&["_styk", "drawing"]).cloned().unwrap_or(Value::Null);
        let old_ppu = num(&old, "pixelsPerUnit").unwrap_or(f64::NAN);
        let ratio = ppu / old_ppu;
        let figures = items(self.report.get("figure_types"));
        let type_id = next_figure_type(&figures);
        let cel = format!("cel-{}", self.draw_uuid()?);

        let mut figure = old_figure.clone();
        let version = num(&old, "version");
        {
            let record = figure.make_obj().ok_or_else(|| invalid("errors.editorDrawing.theDrawingChangedBeforeResampling"))?;
            record.set("figure_type_id", Value::Num(type_id));
        }
        if version == Some(1.0) {
            // `migrateDrawingFigure`: the same anchors and segment geometry in tile pixels, the pixel space rescaled by the ratio.
            let crop = old.get("crop");
            let asset = edit_asset(&mut figure)?;
            let start = asset.get("anchor_start").cloned();
            let end = asset.get("anchor_end").cloned();
            let anchor = point((coordinate(start.as_ref(), "x") + coordinate(crop, "x")) * ratio, (coordinate(start.as_ref(), "y") + coordinate(crop, "y")) * ratio);
            let moved = point(
                anchor.get("x").and_then(Value::as_f64).unwrap_or(0.0) + coordinate(end.as_ref(), "x") - coordinate(start.as_ref(), "x"),
                anchor.get("y").and_then(Value::as_f64).unwrap_or(0.0) + coordinate(end.as_ref(), "y") - coordinate(start.as_ref(), "y"),
            );
            asset.remove("styk_tiles");
            asset.set("data_url", Value::str(EMPTY_PNG));
            for key in ["width", "height", "display_width", "display_height"] {
                asset.set(key, Value::Num(1.0));
            }
            asset.set("anchor_start", anchor.clone());
            asset.set("anchor_end", moved);
            asset.set("drawing_anchor", anchor);
            let mut drawing = Obj::new();
            drawing.set("version", Value::Num(2.0));
            drawing.set("celId", Value::str(&cel));
            drawing.set("pixelsPerUnit", Value::Num(old_ppu));
            drawing.set("revision", Value::Num(0.0));
            drawing.set("bounds", Value::Null);
            edit(&mut figure, &["_styk"]).ok_or_else(|| invalid("errors.editorDrawing.theDrawingChangedBeforeResampling"))?.set("drawing", Value::object(drawing));
        } else {
            edit(&mut figure, &["_styk", "drawing"]).ok_or_else(|| invalid("errors.editorDrawing.theDrawingChangedBeforeResampling"))?.set("celId", Value::str(&cel));
        }
        {
            let drawing = edit(&mut figure, &["_styk", "drawing"]).ok_or_else(|| invalid("errors.editorDrawing.theDrawingChangedBeforeResampling"))?;
            drawing.set("pixelsPerUnit", Value::Num(ppu));
            drawing.set("bounds", bounds.unwrap_or(Value::Null));
            drawing.set("revision", Value::Num(0.0));
        }
        // Anchors sit in pixel space: rescaling pixels rescales them. anchor_start stays pinned to drawing_anchor and anchor_end keeps its direction.
        {
            let asset = edit_asset(&mut figure)?;
            let length = asset.get("anchor_length").and_then(Value::as_f64).unwrap_or(f64::NAN);
            let (start, end) = (asset.get("anchor_start").cloned(), asset.get("anchor_end").cloned());
            let direction = if length != 0.0 && !length.is_nan() {
                ((coordinate(end.as_ref(), "x") - coordinate(start.as_ref(), "x")) / length, (coordinate(end.as_ref(), "y") - coordinate(start.as_ref(), "y")) / length)
            } else {
                (1.0, 0.0)
            };
            if version == Some(2.0) {
                let drawn = asset.get("drawing_anchor").cloned();
                let anchor = point(coordinate(drawn.as_ref(), "x") * ratio, coordinate(drawn.as_ref(), "y") * ratio);
                asset.set("anchor_start", anchor.clone());
                asset.set("drawing_anchor", anchor);
            }
            let length = length * ratio;
            asset.set("anchor_length", Value::Num(length));
            let start = asset.get("anchor_start").cloned();
            asset.set("anchor_end", point(coordinate(start.as_ref(), "x") + direction.0 * length, coordinate(start.as_ref(), "y") + direction.1 * length));
            asset.remove("styk_tiles");
            asset.set("data_url", Value::str(EMPTY_PNG));
            for key in ["width", "height", "display_width", "display_height"] {
                asset.set(key, Value::Num(1.0));
            }
        }
        {
            let segment = figure.make_obj().and_then(|record| record.get_mut("segments")).and_then(Value::make_arr).and_then(|segments| segments.get_mut(0)).and_then(Value::make_obj).ok_or_else(|| invalid("errors.editorDrawing.theDrawingChangedBeforeResampling"))?;
            let length = segment.get("length").and_then(Value::as_f64).unwrap_or(f64::NAN);
            segment.set("length", Value::Num(length * ratio));
        }

        let mut moved = object.clone();
        {
            let record = moved.make_obj().ok_or_else(|| invalid("errors.editorDrawing.theDrawingChangedBeforeResampling"))?;
            record.set("figure_type_id", Value::Num(type_id));
            let scale = record.get("scale").and_then(Value::as_f64).unwrap_or(f64::NAN);
            record.set("scale", Value::Num(scale * (old_ppu / ppu)));
            if record.get("len_flag").is_some_and(Value::truthy) {
                let lengths = record.get("lengths").and_then(Value::elements).map(|lengths| lengths.iter().map(|length| Value::Num(length.as_f64().unwrap_or(f64::NAN) * ratio)).collect::<Vec<_>>()).unwrap_or_default();
                record.set("lengths", Value::array(lengths));
            }
        }
        let mut plan = self.planner(std::slice::from_ref(&id))?;
        plan.definitions = vec![figure];
        plan.write(&id, current.start, &create_frame(&[moved]), Write { easing: Some(&constant()), ..Write::default() })?;
        let selection = self.selection_state();
        self.publish(plan, "Resample drawing", selection, None)?;
        Ok(Value::str(&cel))
    }

    /// Undo or redo of a pixel commit, in the document: its revision, and the cel it changed named for the interface, which applies the
    /// record's tiles around this call (`applyDrawingCommand`; the selection is not restored).
    pub(crate) fn apply_drawing_pixels(&mut self, command: &Command, direction: Direction) -> Result<(), EditError> {
        let CommandKind::DrawingPixels { cel_id, .. } = &command.kind else { return Ok(()) };
        let index = self.cel_index(cel_id).ok_or_else(|| invalid("errors.editorDrawing.theDrawingHistoryReferencesAMissingCel"))?;
        self.revision = if direction == Direction::Before { command.before_revision } else { command.after_revision };
        self.emit("history", vec![("label", Value::str(&command.label)), ("definition", Value::Bool(true)), ("drawing", Value::Bool(true)), ("figureIndices", Value::array(vec![Value::Num(index as f64)]))]);
        Ok(())
    }

    /// The pixel commits the next undo (or redo) applies, in the order it applies them: `[{celId, record}]`.
    pub(crate) fn drawing_replay(&self, redo: bool) -> Value {
        let mut steps = Vec::new();
        if let Some(entry) = if redo { self.redo.last() } else { self.undo.last() } {
            replay_steps(entry, redo, &mut steps);
        }
        Value::array(steps)
    }

    /// The pixel commits the grouped edit in progress holds, in the order its abort takes them back: `[{celId, record}]`.
    pub(crate) fn drawing_batch(&self) -> Value {
        let mut steps = Vec::new();
        for command in self.batch_commands().collect::<Vec<_>>().into_iter().rev() {
            replay_steps(command, false, &mut steps);
        }
        Value::array(steps)
    }

    /// The records of pixel commits and the cels (their commits' and the ones layer sheet entries added) the history refers to:
    /// `{records, cels}`.
    pub(crate) fn drawing_refs(&self) -> Value {
        fn visit(command: &Command, records: &mut Vec<Value>, cels: &mut Vec<Value>) {
            match &command.kind {
                CommandKind::DrawingPixels { cel_id, record } => {
                    records.push(Value::Num(*record as f64));
                    cels.push(Value::str(cel_id));
                }
                CommandKind::LayerSheet { definitions: Some((_, figures)), .. } => {
                    cels.extend(figures.iter().filter_map(|figure| figure.path(&["_styk", "drawing", "celId"]).cloned()));
                }
                CommandKind::Batch { commands } => commands.iter().for_each(|child| visit(child, records, cels)),
                _ => {}
            }
        }
        let (mut records, mut cels) = (Vec::new(), Vec::new());
        for entry in self.undo.iter().chain(self.redo.iter()) {
            visit(entry, &mut records, &mut cels);
        }
        let mut seen = std::collections::HashSet::new();
        cels.retain(|cel| seen.insert(cel.as_str().map(str::to_string)));
        let mut refs = Obj::new();
        refs.set("records", Value::array(records));
        refs.set("cels", Value::array(cels));
        Value::object(refs)
    }

    /// `@drawingBytes(record, delta)`.
    pub(crate) fn set_pixels_bytes(&mut self, args: &[Value]) -> Result<Value, EditError> {
        let record = args.first().and_then(Value::as_f64).filter(|record| record.fract() == 0.0 && *record >= 0.0).ok_or_else(|| invalid("errors.engineOwner.drawingBytesNeedARecord"))? as u64;
        let delta = args.get(1).and_then(Value::as_f64).filter(|delta| delta.is_finite()).ok_or_else(|| invalid("errors.engineOwner.drawingBytesNeedADelta"))?;
        Ok(Value::Bool(self.adjust_pixels_bytes(record, delta)))
    }

    /// `@retractDrawing(record)`: the interface could not apply the tiles of the commit it had recorded; the entry leaves the history as if
    /// it had not been recorded. Answers whether the commit was the last entry (it is not, once anything was recorded after it).
    pub(crate) fn retract_pixels(&mut self, args: &[Value]) -> Result<Value, EditError> {
        let record = args.first().and_then(Value::as_f64).filter(|record| record.fract() == 0.0 && *record >= 0.0).ok_or_else(|| invalid("errors.engineOwner.drawingRetractNeedsARecord"))? as u64;
        Ok(Value::Bool(self.retract_pixels_entry(record)?))
    }
}

/// The cel's picture asset (`figure.image_assets[0]`), made editable.
fn edit_asset(figure: &mut Value) -> Result<&mut Obj, EditError> {
    figure.make_obj().and_then(|record| record.get_mut("image_assets")).and_then(Value::make_arr).and_then(|assets| assets.get_mut(0)).and_then(Value::make_obj).ok_or_else(|| invalid("errors.editorDrawing.theDrawingChangedBeforeResampling"))
}
