//! What the JavaScript editor changed itself, while the session owns the document (D19).
//!
//! A call the session has no command for runs in the JavaScript editor on its read view. Its
//! changed records come back as patch operations (`crate::patch`), with a history entry the
//! JavaScript editor undoes and redoes itself: the session keeps the entry's place, label,
//! weight and the pose sources it keeps alive, and asks the editor to apply it.
//!
//! Each also takes the editor's counters `[layerRevision, nextFrameIdentity, nextUid]`, then
//! (`@sync`, `@external`) whether the editor still shows the frame the session retained.
//!
//! - `@external(label, id, retainedSources, generatedSources, bytes, ops)` applies `ops`
//!   and records the entry; it returns the patch of what recording changed besides (pose
//!   sources it collected);
//! - `@sync(ops, generatedSources, touched)` applies `ops` without history (edits the editor
//!   made outside a command); `touched` makes a new revision, as `dirty = true` does;
//! - `undo` / `redo` with an external entry on top answer `Unported("external history
//!   entry <id>")` and change nothing; the editor applies it, then calls
//!   `@externalDone(id, redo, ops)`, which applies `ops` and moves the entry;
//! - `@historyLimits(count, bytes)` sizes history as the editor does; `@revisions(revision,
//!   serial, saved)` continues the editor's numbering; `@markSaved()`.

use std::collections::HashSet;

use styk_doc::{Obj, Value};

use crate::history::{Command, CommandKind};
use crate::{EditError, Editor};

/// The answer of undo or redo when the entry on top is the editor's own.
pub const EXTERNAL_ENTRY: &str = "external history entry ";

fn invalid(what: &str) -> EditError {
    EditError::Invalid(format!("errors.engineOwner.{what}"))
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value.and_then(Value::elements).map(|items| items.iter().filter_map(|item| item.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

impl Editor {
    /// Applies the editor's record operations to the document and forgets what was
    /// derived from the records before them.
    /// The editor's counters after its own edit: `[layerRevision, nextFrameIdentity, nextUid]`.
    fn adopt_counters(&mut self, counters: Option<&Value>) {
        let Some(values) = counters.and_then(Value::numbers).filter(|values| values.len() == 3 && values.iter().all(|value| value.is_finite() && *value >= 0.0)) else { return };
        self.set_counters(values[0] as u64, values[1] as u64, values[2] as u64);
    }

    /// `keep`: the editor still shows the frame the session retained (it changed something
    /// that leaves the frame on show alone, as selecting does to the active layer).
    fn apply_records(&mut self, ops: &Value, generated: &[String], keep: bool) -> Result<(), EditError> {
        if ops.elements().is_some_and(|ops| !ops.is_empty()) {
            self.report = crate::patch::apply(&self.report, ops).map_err(|_| invalid("recordsDoNotApply"))?;
            self.uid_counts = None;
            if !keep { self.retained = None; }
        }
        for id in generated {
            if !self.generated_sources.contains(id) { self.generated_sources.push(id.clone()); }
        }
        Ok(())
    }

    pub(crate) fn sync_records(&mut self, args: &[Value]) -> Result<Value, EditError> {
        self.apply_records(args.first().unwrap_or(&Value::Null), &strings(args.get(1)), args.get(4).is_some_and(Value::truthy))?;
        self.adopt_counters(args.get(3));
        // `dirty = true` outside a command: a new revision without history.
        if args.get(2).is_some_and(Value::truthy) {
            self.revision_serial += 1;
            self.revision = self.revision_serial;
        }
        Ok(Value::array(Vec::new()))
    }

    pub(crate) fn record_external(&mut self, args: &[Value]) -> Result<Value, EditError> {
        let label = args.first().and_then(Value::as_str).ok_or_else(|| invalid("externalEntryNeedsALabel"))?.to_string();
        let id = args.get(1).and_then(Value::as_f64).filter(|id| id.is_finite() && *id >= 0.0).ok_or_else(|| invalid("externalEntryNeedsAnIdentity"))? as u64;
        let retained = strings(args.get(2));
        let generated = strings(args.get(3));
        let bytes = args.get(4).and_then(Value::as_f64).filter(|bytes| bytes.is_finite() && *bytes >= 0.0).unwrap_or(0.0);
        self.apply_records(args.get(5).unwrap_or(&Value::Null), &generated, args.get(7).is_some_and(Value::truthy))?;
        self.adopt_counters(args.get(6));
        let applied = self.report.clone();
        let selection = self.selection_state();
        let command = Command {
            kind: CommandKind::External { id, retained },
            label,
            before_selection: selection.clone(),
            after_selection: selection,
            before_revision: 0,
            after_revision: 0,
            layer_changes: Vec::new(),
            captured_source_bytes: 0,
            layers: false,
        };
        self.record_external_entry(command, bytes)?;
        // What recording changed besides the editor's records: the pose sources only
        // history kept alive, collected now.
        Ok(crate::patch::diff(&applied, &self.report))
    }

    /// The identity of the external entry undo (or redo) would apply next.
    pub(crate) fn external_on_top(&self, redo: bool) -> Option<u64> {
        let stack = if redo { &self.redo } else { &self.undo };
        match &stack.last()?.kind {
            CommandKind::External { id, .. } => Some(*id),
            _ => None,
        }
    }

    pub(crate) fn external_done(&mut self, args: &[Value]) -> Result<Value, EditError> {
        let id = args.first().and_then(Value::as_f64).ok_or_else(|| invalid("externalEntryNeedsAnIdentity"))? as u64;
        let redo = args.get(1).is_some_and(Value::truthy);
        if self.external_on_top(redo) != Some(id) { return Err(invalid("externalEntryIsNotNext")); }
        self.apply_records(args.get(2).unwrap_or(&Value::Null), &strings(args.get(3)), false)?;
        self.adopt_counters(args.get(4));
        self.move_history_entry(redo);
        Ok(Value::array(Vec::new()))
    }

    pub(crate) fn configure_history(&mut self, args: &[Value]) -> Result<Value, EditError> {
        let count = args.first().and_then(Value::as_f64).filter(|count| *count >= 0.0).ok_or_else(|| invalid("historyLimitsNeedACount"))?;
        let bytes = args.get(1).and_then(Value::as_f64).unwrap_or(48.0 * 1024.0 * 1024.0);
        self.configure_worker_history(crate::HistoryLimits { count: count as usize, bytes })?;
        Ok(Value::Bool(true))
    }

    /// `@revisions(revision, serial, saved)`: continue the editor's numbering.
    pub(crate) fn set_revisions(&mut self, args: &[Value]) -> Result<Value, EditError> {
        let number = |at: usize| args.get(at).and_then(Value::as_f64).filter(|value| value.is_finite() && *value >= 0.0).map(|value| value as u64).ok_or_else(|| invalid("revisionsNeedNumbers"));
        self.set_revision_counters(number(0)?, number(1)?, number(2)?);
        Ok(Value::Bool(true))
    }

    /// What the interface reads of the figure-handle, Handle Edit Mode and segment-value gesture in
    /// progress (`_drag.figureHandle`, `_drag.handleEdit`, `_drag.segmentValueOptions`), told with
    /// every answer; `null` when none is open.
    pub fn handle_gesture_view(&self) -> Value {
        let Some(drag) = &self.drag else { return Value::Null };
        if drag.figure_handle.is_none() && drag.handle_edit.is_none() && drag.segment_value_options.is_none() {
            return Value::Null;
        }
        let mut out = Obj::new();
        if let Some(edit) = &drag.figure_handle { out.set("figureHandle", edit.live()); }
        if let Some(edit) = &drag.handle_edit { out.set("handleEdit", edit.live()); }
        if let Some(options) = &drag.segment_value_options { out.set("segmentValueOptions", options.clone()); }
        Value::object(out)
    }

    pub(crate) fn mark_saved(&mut self) -> Result<Value, EditError> {
        self.saved_revision = self.revision;
        Ok(Value::Bool(true))
    }

    /// The pose sources external entries keep alive (`retainedFrameSourceIds` and the
    /// rest of what `_pruneFrameSources` reads from the editor's own command).
    pub(crate) fn external_retained(command: &Command, retained: &mut Vec<String>) {
        if let CommandKind::External { retained: ids, .. } = &command.kind {
            let known: HashSet<&String> = retained.iter().collect();
            let fresh: Vec<String> = ids.iter().filter(|id| !known.contains(id)).cloned().collect();
            retained.extend(fresh);
        }
    }
}
