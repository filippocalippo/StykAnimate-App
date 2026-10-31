//! Discarding a figure the builder created (`discardNewFigure(typeId, {label})`): the repair of the builder session when history
//! eviction dropped the entries that created it (src/builder-session.mjs). Every instance of the definition leaves every frame that
//! holds one (the keyframes and the pose sources, in the retained movieclip sources too), the figures joined to an instance stay
//! where they were, and the definition leaves the library. One `figure-discard` entry holds the definition and the frames it
//! changed, before and after.

use std::collections::HashSet;

use styk_doc::{Obj, Value};

use crate::figures::{frame_order, normalize_frame, set_order};
use crate::history::{Command, CommandKind, Direction};
use crate::record::{num, uid};
use crate::topology::{frame_at, frame_mut, places, Place};
use crate::{EditError, Editor};

/// A frame the discard changed.
#[derive(Clone, Debug)]
pub struct DiscardedFrame {
    pub place: Place,
    pub before: Value,
    pub after: Value,
}

/// The frame without the figures in `gone`: the figures joined to one of them are detached, the joins of the figures that remain follow their
/// targets to the slots they take, and the drawing order names the same figures (`_removeCreatedFigure`).
fn without(frame: &Value, gone: &HashSet<u32>) -> Value {
    let objects: Vec<Value> = frame.get("objects").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
    let mut out = frame.as_obj().cloned().unwrap_or_default();
    let ids: Vec<f64> = frame_order(&out).into_iter().filter(|id| !gone.contains(&(*id as u32))).collect();
    // The slot each figure that stays takes, by the slot it held.
    let mut moved: Vec<Option<usize>> = Vec::with_capacity(objects.len());
    let mut next = 0;
    for object in &objects {
        if uid(object).is_some_and(|id| gone.contains(&id)) {
            moved.push(None);
        } else {
            moved.push(Some(next));
            next += 1;
        }
    }
    let kept: Vec<Value> = objects
        .iter()
        .zip(&moved)
        .filter_map(|(object, slot)| slot.map(|slot| (object, slot)))
        .map(|(object, slot)| {
            let mut record = object.as_obj().cloned().unwrap_or_default();
            if let Some(mut join) = record.get("join").filter(|join| join.truthy()).and_then(Value::as_obj).cloned() {
                let held = join.get("target_object_slot").and_then(Value::as_f64).filter(|slot| *slot >= 0.0 && slot.fract() == 0.0).map(|slot| slot as usize);
                match held.and_then(|held| moved.get(held).map(|target| (held, *target))) {
                    // The target is leaving: nothing holds this figure any more.
                    Some((_, None)) => record.set("join", Value::Null),
                    Some((held, Some(target))) => {
                        join.set("target_object_slot", Value::Num(target as f64));
                        join.set("target_unique_id", objects[held].get("unique_id").cloned().unwrap_or(Value::Null));
                        record.set("join", Value::object(join));
                    }
                    None => {
                        join.set("target_unique_id", Value::Null);
                        record.set("join", Value::object(join));
                    }
                }
            }
            record.set("object_slot", Value::Num(slot as f64));
            Value::object(record)
        })
        .collect();
    out.set("objects", Value::array(kept));
    set_order(&mut out, &ids);
    normalize_frame(&mut out);
    Value::object(out)
}

impl Editor {
    /// \`discardNewFigure(typeId, {label})\`: whether the definition was there.
    pub(crate) fn discard_new_figure(&mut self, type_id: &Value, options: &Value) -> Result<bool, EditError> {
        let Some(wanted) = type_id.as_f64() else { return Err(EditError::Invalid("errors.editorRangeCommands.chooseAnExistingFigureDefinition".into())) };
        let figures: Vec<Value> = self.report.get("figure_types").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
        let Some(figure_index) = figures.iter().position(|figure| num(figure, "figure_type_id") == Some(wanted)) else { return Ok(false) };
        let label = crate::history::entry_label(options, "Discard new figure");
        if self.drag.is_some() {
            self.commit_drag()?;
        }
        let mut frames = Vec::new();
        let mut gone: HashSet<u32> = HashSet::new();
        for place in places(&self.report) {
            let Some(before) = frame_at(&self.report, &place).cloned() else { continue };
            let removed: HashSet<u32> = crate::frame::objects_of(&before).iter().filter(|object| num(object, "figure_type_id") == Some(wanted)).filter_map(uid).collect();
            if removed.is_empty() {
                continue;
            }
            gone.extend(&removed);
            let after = without(&before, &removed);
            frames.push(DiscardedFrame { place, before, after });
        }
        self.validate_discard(figure_index, &frames)?;
        self.ensure_counts();
        let before_selection = self.selection_state();
        let before_report = frames.iter().map(|frame| frame.before.clone()).collect::<Vec<_>>();
        let after_report = frames.iter().map(|frame| frame.after.clone()).collect::<Vec<_>>();
        for frame in &frames {
            if let Some(slot) = frame_mut(&mut self.report, &frame.place) {
                if let Some(next) = frame.after.as_obj() {
                    *slot = next.clone();
                }
            }
        }
        if let Some(list) = self.report.make_obj().and_then(|report| report.get_mut("figure_types")).and_then(Value::make_arr) {
            list.remove(figure_index);
        }
        if !self.selection.uids.is_empty() {
            let kept: Vec<u32> = self.selection.uids.iter().copied().filter(|id| !gone.contains(id)).collect();
            self.select_ids(kept);
        }
        let layers = self.track_frames(&before_report, &after_report, true)?;
        self.retained = None;
        let figure = figures[figure_index].clone();
        self.record(Command {
            kind: CommandKind::FigureDiscard { figure_index, figure, frames },
            label: label.clone(),
            before_selection,
            after_selection: self.selection_state(),
            before_revision: 0,
            after_revision: 0,
            layer_changes: Vec::new(),
            captured_source_bytes: 0,
            layers,
        })?;
        self.emit("edit", vec![("label", Value::str(&label)), ("structural", Value::Bool(true)), ("definition", Value::Bool(true))]);
        Ok(true)
    }

    /// `validateScene` on the document the discard would leave (the frames it changed, the library without the definition): a document
    /// that cannot be saved or reopened is refused before anything changes.
    fn validate_discard(&self, figure_index: usize, frames: &[DiscardedFrame]) -> Result<(), EditError> {
        let mut probe = self.report.clone();
        let Some(report) = probe.make_obj() else { return Ok(()) };
        let mut figures = report.get("figure_types").and_then(Value::elements).map(|e| e.iter().collect::<Vec<Value>>()).unwrap_or_default();
        if figure_index < figures.len() {
            figures.remove(figure_index);
        }
        let mut changed: Vec<Value> = frames.iter().map(|frame| frame.after.clone()).collect();
        if changed.is_empty() {
            changed.push(crate::sheet::create_frame(&[]));
        }
        report.set("figure_types", Value::array(figures));
        report.set("keyframes", Value::array(changed));
        crate::load::validate_scene(&probe)
    }

    /// Undo or redo of a `figure-discard` entry: the definition and the frames as they were, or as the discard left them.
    pub(crate) fn apply_figure_discard(&mut self, command: &Command, direction: Direction) -> Result<(), EditError> {
        let CommandKind::FigureDiscard { figure_index, figure, frames } = &command.kind else { return Ok(()) };
        let (selection, revision) = match direction {
            Direction::Before => (&command.before_selection, command.before_revision),
            Direction::After => (&command.after_selection, command.after_revision),
        };
        self.ensure_counts();
        let (previous, next): (Vec<Value>, Vec<Value>) = match direction {
            Direction::Before => (frames.iter().map(|frame| frame.after.clone()).collect(), frames.iter().map(|frame| frame.before.clone()).collect()),
            Direction::After => (frames.iter().map(|frame| frame.before.clone()).collect(), frames.iter().map(|frame| frame.after.clone()).collect()),
        };
        for (frame, value) in frames.iter().zip(&next) {
            if let Some(slot) = frame_mut(&mut self.report, &frame.place) {
                *slot = value.as_obj().cloned().unwrap_or_else(Obj::new);
            }
        }
        if let Some(list) = self.report.make_obj().and_then(|report| report.get_mut("figure_types")).and_then(Value::make_arr) {
            match direction {
                Direction::Before => list.insert((*figure_index).min(list.len()), figure.clone()),
                Direction::After => {
                    if let Some(at) = list.iter().position(|item| item.get("figure_type_id") == figure.get("figure_type_id")) {
                        list.remove(at);
                    }
                }
            }
        }
        self.track_frames(&previous, &next, false)?;
        self.apply_attached_layer_changes(&command.layer_changes, direction);
        self.retained = None;
        self.restore_selection(selection)?;
        self.revision = revision;
        self.emit("history", vec![("label", Value::str(&command.label)), ("structural", Value::Bool(true)), ("definition", Value::Bool(true)), ("animation", Value::Bool(false))]);
        Ok(())
    }
}
