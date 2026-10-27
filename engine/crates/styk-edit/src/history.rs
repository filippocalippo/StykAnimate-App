//! History entries and undo/redo (`_record`, `_applyCommand`, `undo`, `redo`).
//!
//! Phase 1 keeps the app's history in JavaScript (docs/engine/editing.md); this one
//! exists so the command-replay harness can check undo and redo record for record.
//! Worker-owned editors can prepare exact byte weights and honor the app's count
//! and byte limits. Synchronous UI sessions keep count-only readiness until their
//! immutable transactions arrive with worker-prepared weights.

use std::sync::Arc;

use styk_doc::Value;

use crate::record::{frame_mut, uid};
use crate::select::SelectionState;
use crate::{EditError, Editor};

#[cfg(test)]
#[path = "history_cow_tests.rs"]
mod cow_tests;

const HISTORY_LIMIT: usize = 80;

/// The editor's settings. The byte budget always retains one oversized entry;
/// a zero count limit discards even that entry.
#[derive(Clone, Copy, Debug)]
pub struct HistoryLimits { pub count: usize, pub bytes: f64 }
impl Default for HistoryLimits { fn default() -> Self { Self { count: HISTORY_LIMIT, bytes: 48.0 * 1024.0 * 1024.0 } } }

/// One weight tree parallel to a batch's existing command tree. No retained
/// document data is copied and child weights survive revision overrides.
#[derive(Clone, Debug, Default)]
pub(crate) struct Weight {
    pub(crate) bytes: f64,
    pub(crate) children: Vec<Weight>,
    /// The actual owner's sparse estimate shape, retained even while unprepared.
    pub(crate) topology: Option<crate::history_weight::TopologyShape>,
}
#[derive(Clone, Debug)]
pub(crate) struct Entry { command: Command, weight: Weight }
impl std::ops::Deref for Entry { type Target = Command; fn deref(&self) -> &Command { &self.command } }
impl std::ops::DerefMut for Entry { fn deref_mut(&mut self) -> &mut Command { &mut self.command } }

/// `a === b` for two values: numbers by value, text by content, containers by identity.
pub(crate) fn js_strict_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Num(x), Value::Num(y)) => x == y,
        (Value::Bool(x), Value::Bool(y)) => x == y,
        (Value::Null, Value::Null) => true,
        (x @ (Value::Str(_) | Value::Blob(_)), y @ (Value::Str(_) | Value::Blob(_))) => x.text() == y.text(),
        (x, y) => x.same_node(y),
    }
}

/// What a history entry changed.
#[derive(Clone, Debug)]
pub enum CommandKind {
    /// Contiguous native frame slices (`kind: 'ranges'`), including row splits.
    Ranges { changes: Vec<crate::frame::FrameSlice>, structural: bool, timing: bool },
    /// One native keyframe before and after a structural transaction (`kind: 'frame'`).
    Frame { index: usize, before: Value, after: Value, structural: bool },
    /// Saved native channels (`kind: 'animation'`), sharing the movieclip owner.
    Animation { before: Option<Value>, after: Value, structural: bool },
    /// Whole records of one native keyframe's objects, replaced by unique id.
    Objects { index: usize, before: Vec<Value>, after: Vec<Value> },
    /// The layer sheet and layer state before and after, and the pose sources the
    /// command captured (`kind: 'layer-sheet'`).
    LayerSheet { before: Value, after: Value, before_layers: Value, after_layers: Value, sources: Vec<(String, Value)>, definitions: Option<(usize, Vec<Value>)>, backgrounds: Option<(usize, Vec<Value>)>, retain_geometry: bool },
    /// Paths of the layer state before and after, and the sheet when the layers' tracks
    /// changed with them (`kind: 'layers'`).
    Layers { changes: Vec<crate::layers::LayerChange>, sheet: Option<(Value, Value)>, migration: Option<crate::layer_planning::NativeMigration>, structural: bool, timing: bool },
    /// A figure definition before and after (`kind: 'figure'`).
    Figure { index: usize, before: Value, after: Value },
    /// Definitions inserted beside the existing library and one native keyframe
    /// before and after (`kind: 'figure-splice'`).
    FigureSplice { index: usize, figure_index: usize, before: Value, after: Value },
    /// The camera motion table before (none when there was none) and after, and the sheet
    /// when the clips lengthened it (`kind: 'camera-motion'`).
    CameraMotion { before: Option<Value>, after: Value, sheet: Option<(Value, Value)> },
    /// The project palette before and after, absent when there is none (`kind: 'palette'`).
    Palette { before: Option<Value>, after: Option<Value> },
    /// The audio before (the empty audio when there was none) and after, and whether the
    /// document had audio before (`kind: 'audio'`).
    Audio { before: Value, after: Value, before_present: bool },
    /// The effect clips before (none when there were none) and after, and the sheet when
    /// the clips lengthened it (`kind: 'vfx-clips'`).
    VfxClips { before: Option<Value>, after: Value, sheet: Option<(Value, Value)> },
    /// A background added to the table or fields of one of its entries changed (`kind: 'scene'`, `scene_backgrounds.rs`).
    Scene { index: usize, change: crate::scene_backgrounds::Change },
    /// Fields of the document before (absent ones as none) and after (`kind: 'fields'`).
    Fields { before: Vec<(String, Option<Value>)>, after: Vec<(String, Value)>, timing: bool },
    /// A movieclip definition before (none when it was added) and after (none when removed)
    /// at its place in the definitions (`kind: 'movieclip-definition'`).
    MovieclipDefinition { index: usize, before: Option<Value>, after: Option<Value> },
    /// Selected movieclip poses in native keys and retained sources (`kind: 'movieclip-poses'`).
    MovieclipPoses { before: Vec<crate::topology::FramePoses>, after: Vec<crate::topology::FramePoses> },
    /// Entries recorded inside `movieclipBatch`, undone and redone together (`kind: 'movieclip-batch'`).
    Batch { commands: Vec<Command> },
    /// Native keyframes patched by a figure operation across frames (`kind: 'figure-range'`).
    FigureRange { changes: Vec<crate::range::FrameChange>, structural: bool, retain_geometry: bool },
    /// Paths of a figure definition before and after (`kind: 'native-properties'`, `scope: 'figure'`).
    NativeProperties { index: usize, before: crate::builder::Patch, after: crate::builder::Patch },
    /// A figure definition taken out of the library with every instance of it in every frame that held one (`kind: 'figure-discard'`,
    /// `figure_discard.rs`).
    FigureDiscard { figure_index: usize, figure: Value, frames: Vec<crate::figure_discard::DiscardedFrame> },
    /// A figure definition and the poses it changed, before and after (`kind: 'topology'`).
    Topology { index: usize, before: crate::topology::Snapshot, after: crate::topology::Snapshot },
    /// A branch made a figure of its own in every pose of the figure: the part inserted in each, the definitions added
    /// to the library (`kind: 'disconnect'`, `disconnect.rs`).
    Disconnect { piece: u32, figure_index: usize, figures: Vec<Value>, changes: Vec<crate::disconnect::Change> },
    /// A drawing cel's pixels changed (`kind: 'drawing-pixels'`, `drawing_pixels.rs`): the cel and the interface's
    /// record of the change, whose before and after tiles the interface's drawing store and history hold.
    DrawingPixels { cel_id: String, record: u64 },
}

/// The name the interface gives an entry (`{label}` among a command's options), else the command's own.
pub(crate) fn entry_label(options: &Value, default: &str) -> String {
    options.get("label").and_then(Value::as_str).filter(|label| !label.is_empty()).unwrap_or(default).to_string()
}

/// `editor._movieclipBatch` in progress: its entries, label, the revision before it and the
/// selection when it began.
#[derive(Clone, Debug)]
pub(crate) struct Batch {
    commands: Vec<Entry>,
    label: String,
    revision: u64,
    before_selection: SelectionState,
    /// Batches opened inside this one, which only run their operation.
    nested: u32,
}

/// One history entry.
#[derive(Clone, Debug)]
pub struct Command {
    pub kind: CommandKind,
    pub label: String,
    pub(crate) before_selection: SelectionState,
    pub(crate) after_selection: SelectionState,
    pub before_revision: u64,
    pub after_revision: u64,
    /// Assignments captured with pose sources, attached by `_record` to this command.
    pub(crate) layer_changes: Vec<crate::layers::LayerChange>,
    /// Newly captured source storage, charged after the command estimate.
    pub(crate) captured_source_bytes: usize,
    /// Independent enumerable `command.layers` metadata from membership tracking.
    pub(crate) layers: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Direction {
    Before,
    After,
}

impl Editor {
    /// `_record`: a new revision, pushed to undo; redo is cleared, and pose sources
    /// only a dropped redo branch used are collected.
    pub(crate) fn record(&mut self, command: Command) -> Result<(), EditError> {
        self.record_weight(command, None, None)
    }

    pub(crate) fn record_topology(&mut self, command: Command, shape: crate::history_weight::TopologyShape) -> Result<(), EditError> {
        self.record_weight(command, None, Some(shape))
    }

    fn record_weight(&mut self, command: Command, prepared: Option<Weight>, topology: Option<crate::history_weight::TopologyShape>) -> Result<(), EditError> {
        self.record_weight_checked(command, prepared, topology, &mut || Ok(()))
    }

    pub(crate) fn record_checked(&mut self, command: Command, check: &mut impl FnMut() -> Result<(), EditError>) -> Result<(), EditError> {
        self.record_weight_checked(command, None, None, check)
    }

    fn record_weight_checked(&mut self, mut command: Command, prepared: Option<Weight>, topology: Option<crate::history_weight::TopologyShape>, check: &mut impl FnMut() -> Result<(), EditError>) -> Result<(), EditError> {
        let _scope = crate::prof::scope("history::record");
        check()?;
        if let CommandKind::LayerSheet { sources, .. } = &command.kind {
            let frames: Vec<Value> = sources.iter().map(|(_, frame)| frame.clone()).collect();
            command.layers |= self.register_frame_sources(&frames, false)?;
        }
        if let CommandKind::Layers { migration: Some(migration), .. } = &command.kind {
            command.layers |= self.register_frame_sources(&migration.frames(), false)?;
        }
        let captured_pending_bytes = self.pending_source_bytes;
        command.layers |= !self.pending_source_layer_changes.is_empty();
        command.layer_changes.append(&mut self.pending_source_layer_changes);
        command.captured_source_bytes += std::mem::take(&mut self.pending_source_bytes);
        let collect = !self.redo.is_empty();
        command.before_revision = self.revision;
        self.revision_serial += 1;
        command.after_revision = self.revision_serial;
        self.revision = command.after_revision;
        let weight = if self.worker_history {
            match prepared {
                Some(mut weight) => { weight.bytes += command.captured_source_bytes as f64; weight },
                None => Weight { bytes: crate::history_weight::command_bytes_checked(&command, topology.as_ref(), check)?, children: Vec::new(), topology },
            }
        } else {
            let mut weight = prepared.unwrap_or_default();
            weight.bytes = 0.0;
            weight.topology = topology;
            weight
        };
        if self.replay_records.is_some() {
            let carrier = crate::history_weight::record_value_checked(&command, &weight, check)?;
            let mut record = styk_doc::Obj::new();
            record.set("kind", carrier.get("kind").cloned().unwrap());
            record.set("label", Value::str(&command.label));
            record.set("bytes", Value::Num(weight.bytes));
            record.set("capturedPendingBytes", Value::Num(captured_pending_bytes as f64));
            record.set("sourceBytes", carrier.get("sourceBytes").cloned().unwrap_or(Value::Null));
            record.set("precomputedBytes", carrier.get("precomputedBytes").cloned().unwrap_or(Value::Null));
            record.set("enumerableJSON", Value::str(&styk_doc::json::to_string(&carrier)));
            self.replay_records.as_mut().unwrap().push(Value::object(record));
        }
        let entry = Entry { command, weight };
        if let Some(batch) = self.batch.as_mut() {
            batch.commands.push(entry);
            return Ok(());
        }
        self.history_size -= self.redo.iter().map(|entry| entry.weight.bytes).sum::<f64>();
        self.history_size += entry.weight.bytes;
        Arc::make_mut(&mut self.undo).push(entry);
        if collect {
            self.drawing_retired |= self.redo.iter().any(|entry| crate::drawing_pixels::references_drawings(&entry.command));
            self.redo = Arc::new(Vec::new());
        }
        self.trim_history(collect);
        Ok(())
    }

    /// Enables exact sizing for a worker-owned editor before its first command.
    /// This is deliberately separate from synchronous Session::start: command
    /// weights and retired dense values must be prepared/disposed on a worker.
    pub fn configure_worker_history(&mut self, limits: HistoryLimits) -> Result<(), EditError> {
        if limits.bytes.is_nan() || limits.bytes < 0.0 { return Err(EditError::Invalid("invalid history byte budget".into())); }
        if !self.worker_history && (!self.undo.is_empty() || !self.redo.is_empty() || self.batch.is_some()) { return Err(EditError::Unported("worker history must be configured before recording commands".into())); }
        self.history_limits = limits; self.worker_history = true; Ok(())
    }

    /// Prepares retained history on its owning worker, atomically. The checkpoint
    /// must come from the validated existing accounting owner: summing retained
    /// entries cannot reproduce floating residue from earlier dropped commands.
    /// Dense traversal and retirement are never allowed in a synchronous Session.
    /// Caller cancellation/stale checks run through dense strings/numeric arrays.
    pub fn prepare_worker_history(
        &mut self,
        limits: HistoryLimits,
        checkpoint: f64,
        mut check: impl FnMut() -> Result<(), EditError>,
    ) -> Result<(), EditError> {
        if limits.bytes.is_nan() || limits.bytes < 0.0 || !checkpoint.is_finite() {
            return Err(EditError::Invalid(
                "invalid history accounting checkpoint or limits".into(),
            ));
        }
        if self.worker_history && checkpoint != self.history_size {
            return Err(EditError::Invalid(
                "history accounting checkpoint differs from its owner".into(),
            ));
        }
        fn prepare(
            command: &Command,
            previous: &Weight,
            check: &mut impl FnMut() -> Result<(), EditError>,
        ) -> Result<Weight, EditError> {
            check()?;
            if matches!(command.kind, CommandKind::DrawingPixels { .. }) { return Ok(previous.clone()); }
            if matches!(command.kind, CommandKind::Topology { .. }) && previous.topology.is_none() {
                return Err(EditError::Unported(
                    "original topology history estimate metadata is unavailable".into(),
                ));
            }
            let children = if let CommandKind::Batch { commands } = &command.kind {
                if commands.len() != previous.children.len() {
                    return Err(EditError::Unported(
                        "original batch history estimate metadata is unavailable".into(),
                    ));
                }
                commands
                    .iter()
                    .zip(&previous.children)
                    .map(|(command, previous)| prepare(command, previous, check))
                    .collect::<Result<Vec<_>, _>>()?
            } else {
                Vec::new()
            };
            let bytes = if matches!(command.kind, CommandKind::Batch { .. }) {
                128.0
                    + children.iter().map(|weight| weight.bytes).sum::<f64>()
                    + command.captured_source_bytes as f64
            } else {
                crate::history_weight::command_bytes_checked(
                    command,
                    previous.topology.as_ref(),
                    check,
                )?
            };
            Ok(Weight {
                bytes,
                children,
                topology: previous.topology.clone(),
            })
        }
        let undo = self
            .undo
            .iter()
            .map(|entry| prepare(entry, &entry.weight, &mut check))
            .collect::<Result<Vec<_>, _>>()?;
        let redo = self
            .redo
            .iter()
            .map(|entry| prepare(entry, &entry.weight, &mut check))
            .collect::<Result<Vec<_>, _>>()?;
        let prepared_batch = self
            .batch
            .as_ref()
            .map(|batch| {
                batch
                    .commands
                    .iter()
                    .map(|entry| prepare(entry, &entry.weight, &mut check))
                    .collect::<Result<Vec<_>, _>>()
            })
            .transpose()?;
        check()?;
        if !undo.is_empty() {
            for (entry, weight) in Arc::make_mut(&mut self.undo).iter_mut().zip(undo) {
                entry.weight = weight;
            }
        }
        if !redo.is_empty() {
            for (entry, weight) in Arc::make_mut(&mut self.redo).iter_mut().zip(redo) {
                entry.weight = weight;
            }
        }
        if let Some(batch) = self.batch.as_mut() {
            for (entry, weight) in batch
                .commands
                .iter_mut()
                .zip(prepared_batch.unwrap_or_default())
            {
                entry.weight = weight;
            }
        }
        self.history_size = checkpoint;
        self.history_limits = limits;
        self.worker_history = true;
        Ok(())
    }

    pub fn history_limits(&self) -> HistoryLimits { self.history_limits }
    /// No byte total is claimed until a worker has enabled exact accounting.
    pub fn history_size(&self) -> Option<f64> { self.worker_history.then_some(self.history_size) }

    /// `_trimHistory`: retires oldest undo until one remains, then farthest redo.
    /// Worker-only because retirement can release dense retained COW values.
    pub fn trim_worker_history(&mut self) -> Result<(), EditError> {
        if !self.worker_history { return Err(EditError::Unported("history byte weights have not been prepared on a worker".into())); }
        self.trim_history(false); Ok(())
    }

    fn trim_history(&mut self, mut collect: bool) {
        while self.undo.len() > self.history_limits.count || (self.worker_history && self.history_size > self.history_limits.bytes && self.undo.len() + self.redo.len() > 1) {
            let retired = if self.undo.len() > 1 { &mut self.undo } else if !self.redo.is_empty() { &mut self.redo } else { &mut self.undo };
            let removed = Arc::make_mut(retired).remove(0);
            self.history_size -= removed.weight.bytes; collect = true;
            self.drawing_retired |= crate::drawing_pixels::references_drawings(&removed.command);
        }
        if collect { self.prune_frame_sources(); }
    }

    pub(crate) fn history_value(&self) -> Value { self.history_value_shape(false, true) }

    /// Read-only summary shape used by the original capture protocol. Exact
    /// weights, stack entries and epochs still come from their one owner.
    pub(crate) fn history_value_shape(&self, kinds: bool, children: bool) -> Value {
        fn summary(command: &Command, weight: &Weight, kinds: bool, children: bool) -> Value {
            let mut value = styk_doc::Obj::new();
            if kinds { value.set("kind", Value::str(match &command.kind {
                CommandKind::Ranges { .. } => "ranges", CommandKind::Frame { .. } => "frame", CommandKind::Animation { .. } => "animation", CommandKind::Objects { .. } => "objects", CommandKind::LayerSheet { .. } => "layer-sheet", CommandKind::Layers { .. } => "layers", CommandKind::Figure { .. } => "figure", CommandKind::FigureSplice { .. } => "figure-splice", CommandKind::FigureDiscard { .. } => "figure-discard", CommandKind::CameraMotion { .. } => "camera-motion", CommandKind::Palette { .. } => "palette", CommandKind::Scene { .. } => "scene", CommandKind::Audio { .. } => "audio", CommandKind::VfxClips { .. } => "vfx-clips", CommandKind::Fields { .. } => "fields", CommandKind::MovieclipDefinition { .. } => "movieclip-definition", CommandKind::MovieclipPoses { .. } => "movieclip-poses", CommandKind::Batch { .. } => "movieclip-batch", CommandKind::FigureRange { .. } => "figure-range", CommandKind::NativeProperties { .. } => "native-properties", CommandKind::Topology { .. } => "topology", CommandKind::Disconnect { .. } => "disconnect", CommandKind::DrawingPixels { .. } => "drawing-pixels",
            })); }
            value.set("label", Value::str(&command.label)); value.set("bytes", Value::Num(weight.bytes));
            if children && let CommandKind::Batch { commands } = &command.kind { value.set("children", Value::array(commands.iter().zip(&weight.children).map(|(command, weight)| summary(command,weight,kinds,children)).collect())); }
            Value::object(value)
        }
        let mut value = styk_doc::Obj::new(); value.set("size", Value::Num(self.history_size));
        value.set("undo", Value::array(self.undo.iter().map(|entry|summary(entry,&entry.weight,kinds,children)).collect())); value.set("redo", Value::array(self.redo.iter().map(|entry|summary(entry,&entry.weight,kinds,children)).collect()));
        value.set("revision",Value::Num(self.revision as f64));value.set("revisionSerial",Value::Num(self.revision_serial as f64));value.set("savedRevision",Value::Num(self.saved_revision as f64));Value::object(value)
    }

    /// `movieclipBatch(label, operation)` begins: entries recorded until it ends become one.
    pub(crate) fn begin_batch(&mut self, label: &str) -> Result<(), EditError> {
        match self.batch.as_mut() {
            Some(batch) => batch.nested += 1,
            None => self.batch = Some(Batch { commands: Vec::new(), label: label.into(), revision: self.revision, before_selection: self.selection_state(), nested: 0 }),
        }
        Ok(())
    }

    /// The batch's operation returned: its entries as one, and the batch's change event.
    pub(crate) fn end_batch(&mut self) -> Result<(), EditError> {
        let Some(batch) = self.batch.as_mut() else { return Ok(()) };
        if batch.nested > 0 {
            batch.nested -= 1;
            return Ok(());
        }
        let batch = self.batch.take().unwrap();
        if !batch.commands.is_empty() {
            let after_selection = self.selection_state();
            let (commands,children): (Vec<_>,Vec<_>) = batch.commands.into_iter().map(|entry|(entry.command,entry.weight)).unzip();
            let weight=Weight { bytes:128.0+children.iter().map(|weight|weight.bytes).sum::<f64>(),children,topology:None };
            self.record_weight(Command { kind: CommandKind::Batch { commands }, label: batch.label.clone(), before_selection: batch.before_selection, after_selection, before_revision: 0, after_revision: 0, layer_changes: Vec::new(), captured_source_bytes: 0, layers: false },Some(weight),None)?;
            if let Some(command) = Arc::make_mut(&mut self.undo).last_mut() {
                command.before_revision = batch.revision;
            }
            if self.sheet() {
                self.prune_frame_sources();
            }
        }
        self.emit("edit", vec![("structural", Value::Bool(true)), ("timing", Value::Bool(true)), ("label", Value::str(&batch.label))]);
        Ok(())
    }

    /// The batch's operation failed: its entries undone, the revision as before it.
    pub(crate) fn abort_batch(&mut self) -> Result<(), EditError> {
        let Some(batch) = self.batch.take() else { return Ok(()) };
        for command in batch.commands.iter().rev() {
            self.apply(command, Direction::Before)?;
        }
        self.drawing_retired |= batch.commands.iter().any(|entry| crate::drawing_pixels::references_drawings(&entry.command));
        self.revision = batch.revision;
        Ok(())
    }

    /// `_movieclipBatch = commands` (a gesture collecting what it records): entries go to the collector, not to history.
    pub(crate) fn start_collecting(&mut self) {
        self.batch = Some(Batch { commands: Vec::new(), label: String::new(), revision: self.revision, before_selection: self.selection_state(), nested: 0 });
    }

    /// The entries the collector holds; history records into itself again.
    pub(crate) fn finish_collecting(&mut self) -> Vec<Entry> {
        self.batch.take().map(|batch| batch.commands).unwrap_or_default()
    }

    /// `movieclipBatch(label, …, {beforeSelection})` begun with entries already in it.
    pub(crate) fn begin_batch_with(&mut self, label: &str, before_selection: SelectionState, commands: Vec<Entry>) {
        self.batch = Some(Batch { commands, label: label.into(), revision: self.revision, before_selection, nested: 0 });
    }

    /// Applies entries before their commands, last first (`_applyCommand(command, 'before')`).
    pub(crate) fn undo_entries(&mut self, entries: &[Entry]) -> Result<(), EditError> {
        for entry in entries.iter().rev() {
            self.apply(&entry.command, Direction::Before)?;
        }
        Ok(())
    }

    pub(crate) fn undo(&mut self) -> Result<bool, EditError> {
        self.cancel_vfx_clip_edit()?;
        if self.drag.is_some() {
            self.cancel_drag()?;
        }
        if self.undo.is_empty() { return Ok(false) }
        let Some(command) = Arc::make_mut(&mut self.undo).pop() else { return Ok(false) };
        self.apply(&command, Direction::Before)?;
        Arc::make_mut(&mut self.redo).push(command);
        Ok(true)
    }

    pub(crate) fn redo(&mut self) -> Result<bool, EditError> {
        self.cancel_vfx_clip_edit()?;
        if self.redo.is_empty() { return Ok(false) }
        let Some(command) = Arc::make_mut(&mut self.redo).pop() else { return Ok(false) };
        self.apply(&command, Direction::After)?;
        Arc::make_mut(&mut self.undo).push(command);
        Ok(true)
    }

    /// Records a pixel commit whose weight the interface measured (its before and after tiles stay with the interface's drawing history).
    pub(crate) fn record_pixels_entry(&mut self, command: Command, bytes: f64) -> Result<(), EditError> {
        self.record_weight(command, Some(Weight { bytes, children: Vec::new(), topology: None }), None)
    }

    /// The weight of the pixel commit `record` changed by `delta` bytes (its tiles left or came back to memory), wherever the commit is in
    /// the history; the byte limit applies to the new total.
    pub(crate) fn adjust_pixels_bytes(&mut self, record: u64, delta: f64) -> bool {
        fn adjust(command: &Command, weight: &mut Weight, record: u64, delta: f64) -> bool {
            match &command.kind {
                CommandKind::DrawingPixels { record: held, .. } if *held == record => { weight.bytes = (weight.bytes + delta).max(0.0); true }
                CommandKind::Batch { commands } => {
                    let found = commands.iter().zip(weight.children.iter_mut()).any(|(child, child_weight)| adjust(child, child_weight, record, delta));
                    if found { weight.bytes = (weight.bytes + delta).max(0.0); }
                    found
                }
                _ => false,
            }
        }
        let mut found = false;
        for stack in [&mut self.undo, &mut self.redo] {
            // Entries are shared with snapshots: copy a stack only when it holds the record.
            if stack.iter().any(|entry| crate::drawing_pixels::references_drawings(&entry.command)) && Arc::make_mut(stack).iter_mut().any(|entry| adjust(&entry.command, &mut entry.weight, record, delta)) {
                found = true;
                break;
            }
        }
        if found {
            self.history_size = (self.history_size + delta).max(0.0);
            self.trim_history(false);
        }
        found
    }

    /// The commands the grouped edit in progress holds, oldest first.
    pub(crate) fn batch_commands(&self) -> impl Iterator<Item = &Command> {
        self.batch.iter().flat_map(|batch| batch.commands.iter().map(|entry| &entry.command))
    }

    /// The pixel commit of `record`, when it is the entry recorded last (in the open grouped edit, else in the history), is taken back as an
    /// undo takes it, but its entry is not kept for a redo. Whether it was.
    pub(crate) fn retract_pixels_entry(&mut self, record: u64) -> Result<bool, EditError> {
        let holds = |entry: &Entry| crate::drawing_pixels::holds_record(&entry.command, record);
        let batched = self.batch.is_some();
        let last = match &self.batch { Some(batch) => batch.commands.last(), None => self.undo.last() };
        if !last.is_some_and(holds) { return Ok(false) }
        let Some(entry) = (match self.batch.as_mut() { Some(batch) => batch.commands.pop(), None => Arc::make_mut(&mut self.undo).pop() }) else { return Ok(false) };
        self.apply(&entry.command, Direction::Before)?;
        if !batched { self.history_size -= entry.weight.bytes; }
        self.drawing_retired = true;
        if self.sheet() { self.prune_frame_sources(); }
        Ok(true)
    }

    /// Existing undo/redo owner for a worker transaction. This bypasses no UI
    /// admission gate: a canonical worker editor must have exact history ready.
    pub fn apply_history_worker(&mut self, redo: bool) -> Result<bool, EditError> {
        if !self.worker_history {
            return Err(EditError::Unported("worker history is not prepared".into()));
        }
        if redo { self.redo() } else { self.undo() }
    }

    fn apply(&mut self, command: &Command, direction: Direction) -> Result<(), EditError> {
        let (selection, revision) = match direction {
            Direction::Before => (&command.before_selection, command.before_revision),
            Direction::After => (&command.after_selection, command.after_revision),
        };
        match &command.kind {
            CommandKind::Ranges { .. } => self.apply_native_ranges(command, direction)?,
            CommandKind::Frame { index, before, after, structural } => {
                self.ensure_counts();
                let (previous, next) = if direction == Direction::Before { (after, before) } else { (before, after) };
                let value = if direction == Direction::Before { before } else { after };
                if let Some(frame) = self.report.make_obj().and_then(|report| report.get_mut("keyframes")).and_then(Value::make_arr).and_then(|frames| frames.get_mut(*index)) { *frame = value.clone(); }
                self.track_frames(std::slice::from_ref(previous), std::slice::from_ref(next), false)?;
                self.apply_attached_layer_changes(&command.layer_changes, direction);
                self.retained = None;
                self.restore_selection(selection)?;
                self.revision = revision;
                self.emit("history", vec![("label", Value::str(&command.label)), ("structural", Value::Bool(*structural)), ("definition", Value::Bool(false)), ("animation", Value::Bool(false))]);
            }
            CommandKind::Objects { index, before, after } => {
                let value = if direction == Direction::Before { before } else { after };
                self.replace_objects(*index, value);
                self.restore_selection(selection)?;
                self.revision = revision;
                let uids = Value::array(value.iter().filter_map(uid).map(|u| Value::Num(u as f64)).collect());
                self.emit(
                    "history",
                    vec![
                        ("label", Value::str(&command.label)),
                        ("definition", Value::Bool(false)),
                        ("animation", Value::Bool(false)),
                        ("frameIndices", Value::array(vec![Value::Num(*index as f64)])),
                        ("changedUids", uids),
                    ],
                );
            }
            CommandKind::LayerSheet { .. } => self.apply_sheet_command(command, direction)?,
            CommandKind::Animation { .. } => self.apply_native_animation(command, direction)?,
            CommandKind::Layers { .. } => self.apply_layers_command(command, direction)?,
            CommandKind::CameraMotion { .. } => self.apply_camera_command(command, direction)?,
            CommandKind::Palette { .. } => self.apply_palette_command(command, direction)?,
            CommandKind::Scene { .. } => self.apply_scene_command(command, direction)?,
            CommandKind::Audio { .. } => self.apply_audio_command(command, direction)?,
            CommandKind::VfxClips { .. } => self.apply_vfx_command(command, direction)?,
            CommandKind::Fields { .. } => self.apply_fields_command(command, direction)?,
            CommandKind::MovieclipDefinition { .. } => self.apply_movieclip_definition(command, direction)?,
            CommandKind::MovieclipPoses { .. } => self.apply_movieclip_poses(command, direction)?,
            CommandKind::FigureRange { .. } => self.apply_figure_range_command(command, direction)?,
            CommandKind::NativeProperties { .. } => self.apply_native_properties(command, direction)?,
            CommandKind::Topology { .. } => self.apply_topology(command, direction)?,
            CommandKind::FigureDiscard { .. } => self.apply_figure_discard(command, direction)?,
            CommandKind::Disconnect { .. } => self.apply_disconnect(command, direction)?,
            CommandKind::DrawingPixels { .. } => self.apply_drawing_pixels(command, direction)?,
            CommandKind::Batch { commands } => {
                let ordered: Vec<&Command> = if direction == Direction::Before { commands.iter().rev().collect() } else { commands.iter().collect() };
                for child in ordered {
                    self.apply(child, direction)?;
                }
                self.restore_selection(selection)?;
                self.revision = revision;
            }
            CommandKind::Figure { index, before, after } => {
                if let Some(figures) = self.report.make_obj().and_then(|r| r.get_mut("figure_types")).and_then(Value::make_arr)
                    && let Some(slot) = figures.get_mut(*index)
                {
                    *slot = if direction == Direction::Before { before.clone() } else { after.clone() };
                }
                self.restore_selection(selection)?;
                self.revision = revision;
                self.emit("history", vec![("label", Value::str(&command.label)), ("definition", Value::Bool(true)), ("animation", Value::Bool(false))]);
            }
            CommandKind::FigureSplice { index, figure_index, before, after } => {
                let (previous, value) = if direction == Direction::Before { (after, before) } else { (before, after) };
                self.ensure_counts();
                let removed = previous.get("figures").and_then(Value::array_len).unwrap_or(0);
                let inserted: Vec<_> = value.get("figures").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
                if let Some(figures) = self.report.make_obj().and_then(|r| r.get_mut("figure_types")).and_then(Value::make_arr) {
                    figures.splice(*figure_index..*figure_index + removed, inserted);
                }
                if let Some(frame) = self.report.make_obj().and_then(|r| r.get_mut("keyframes")).and_then(Value::make_arr).and_then(|f| f.get_mut(*index)) {
                    *frame = value.get("frame").cloned().unwrap_or(Value::Null);
                }
                let previous_frame = previous.get("frame").cloned().unwrap_or(Value::Null);
                let next_frame = value.get("frame").cloned().unwrap_or(Value::Null);
                self.track_frames(&[previous_frame], &[next_frame], false)?;
                self.apply_attached_layer_changes(&command.layer_changes, direction);
                self.retained = None;
                self.restore_selection(selection)?;
                self.revision = revision;
                self.emit("history", vec![("label", Value::str(&command.label)), ("structural", Value::Bool(true)), ("definition", Value::Bool(true)), ("animation", Value::Bool(false))]);
            }
        }
        Ok(())
    }

    /// `_replaceObjects`: puts `objects` in place of the records with the same unique ids.
    pub(crate) fn replace_objects(&mut self, index: usize, objects: &[Value]) {
        let Some(frame) = frame_mut(&mut self.report, index) else { return };
        let Some(list) = frame.get_mut("objects").and_then(Value::make_arr) else { return };
        for slot in list.iter_mut() {
            if let Some(replacement) = uid(slot).and_then(|id| objects.iter().find(|o| uid(o) == Some(id))) {
                *slot = replacement.clone();
            }
        }
    }
}
