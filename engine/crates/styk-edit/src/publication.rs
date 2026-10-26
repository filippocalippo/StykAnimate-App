//! Worker-prepared publication over the existing Editor/history owner.
//!
//! No API here may run on the interface thread. Preparation and validation can
//! traverse retained metadata. The guarded commit itself only exchanges heads;
//! its returned retirement must stay on the worker until the common packet ACK.
use std::collections::VecDeque;

use styk_doc::Value;

use crate::{EditError, Editor, HistoryLimits, Options, Snapshot, frame, select};

fn quiet(editor: &Editor) -> bool {
    editor.drag.is_none()
        && editor.authored.is_none()
        && editor.property_edit.is_none()
        && editor.vfx_edit.is_none()
        && editor.batch.is_none()
}
fn same_value(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(left), Some(right)) => left.same_node(right),
        _ => false,
    }
}

/// The existing rollback Snapshot plus the resources its ordinary synchronous
/// rollback deliberately leaves warm. All clones happen on the owning worker.
struct Heads {
    snapshot: Snapshot,
    events: Vec<Value>,
    cache: frame::Cache,
    gate: Option<(Value, Option<&'static str>)>,
    limits: HistoryLimits,
    ready: bool,
    auto_key: bool,
    draws: VecDeque<(String, Value)>,
}
impl Heads {
    fn capture(editor: &Editor) -> Self {
        Self {
            snapshot: editor.snapshot(),
            events: editor.events.clone(),
            cache: editor.eval.borrow().clone(),
            gate: editor.gate.borrow().clone(),
            limits: editor.history_limits,
            ready: editor.worker_history,
            auto_key: editor.auto_key,
            draws: editor.draws.clone(),
        }
    }
    /// Swaps complete prepared heads, retaining every displaced large value.
    /// No cloning, allocation, serialization, dropping or owner callback here.
    fn exchange(&mut self, editor: &mut Editor) {
        editor.exchange_snapshot(&mut self.snapshot);
        std::mem::swap(&mut editor.events, &mut self.events);
        std::mem::swap(editor.eval.get_mut(), &mut self.cache);
        std::mem::swap(editor.gate.get_mut(), &mut self.gate);
        std::mem::swap(&mut editor.history_limits, &mut self.limits);
        std::mem::swap(&mut editor.worker_history, &mut self.ready);
        std::mem::swap(&mut editor.auto_key, &mut self.auto_key);
        std::mem::swap(&mut editor.draws, &mut self.draws);
    }
}

/// Validated host generation/lineage is an additional caller invariant, as for
/// the borrowed SheetPlan API. This guard checks the actual editing owner, not
/// a serialized document or another Editor/evaluator/cache.
struct Guard {
    report: Value,
    counters: [u64; 6],
    selection: select::SelectionState,
    selection_metadata: select::SelectionMetadata,
    selection_locks: Option<std::sync::Arc<select::SelectionLocks>>,
    options: Options,
    size: u64,
    lengths: [usize; 2],
    limits: HistoryLimits,
    auto_key: bool,
    retained: Option<Value>,
    events: Vec<Value>,
    sheet_clipboard: Option<crate::sheet_clipboard::Clipboard>,
    figure_clipboard: Option<crate::figure_clipboard::FigureClipboard>,
    segment_values_clipboard: Option<String>,
    camera_clipboard: Option<Value>,
    camera_motion_clipboard: Option<Value>,
    vfx_clip_clipboard: Option<(Value, Option<Value>)>,
    draws: VecDeque<(String, Value)>,
}
impl Guard {
    fn capture(editor: &Editor) -> Self {
        Self {
            report: editor.report.clone(),
            counters: [
                editor.revision,
                editor.saved_revision,
                editor.revision_serial,
                editor.layer_revision,
                editor.next_frame_identity,
                editor.next_uid,
            ],
            selection: editor.selection_state(),
            selection_metadata: editor.selection_metadata.clone(),
            selection_locks: editor.selection_locks.clone(),
            options: editor.options,
            size: editor.history_size.to_bits(),
            lengths: [editor.undo.len(), editor.redo.len()],
            limits: editor.history_limits,
            auto_key: editor.auto_key,
            retained: editor.retained.clone(),
            events: editor.events.clone(),
            sheet_clipboard: editor.sheet_clipboard.clone(),
            figure_clipboard: editor.figure_clipboard.clone(),
            segment_values_clipboard: editor.segment_values_clipboard.clone(),
            camera_clipboard: editor.camera_clipboard.clone(),
            camera_motion_clipboard: editor.camera_motion_clipboard.clone(),
            vfx_clip_clipboard: editor.vfx_clip_clipboard.clone(),
            draws: editor.draws.clone(),
        }
    }
    fn matches(&self, editor: &Editor) -> bool {
        quiet(editor)
            && self.matches_owner(editor)
    }
    fn matches_owner(&self, editor: &Editor) -> bool {
        editor.worker_history
            && self.report.same_node(&editor.report)
            && self.counters
                == [
                    editor.revision,
                    editor.saved_revision,
                    editor.revision_serial,
                    editor.layer_revision,
                    editor.next_frame_identity,
                    editor.next_uid,
                ]
            && self.selection == editor.selection_state()
            && self.selection_metadata == editor.selection_metadata
            && match (&self.selection_locks, &editor.selection_locks) {
                (None, None) => true,
                (Some(before), Some(current)) => std::sync::Arc::ptr_eq(before, current),
                _ => false,
            }
            && self.options.property_channels == editor.options.property_channels
            && self.options.layer_timeline == editor.options.layer_timeline
            && self.options.auto_key == editor.options.auto_key
            && self.size == editor.history_size.to_bits()
            && self.lengths == [editor.undo.len(), editor.redo.len()]
            && self.limits.count == editor.history_limits.count
            && self.limits.bytes.to_bits() == editor.history_limits.bytes.to_bits()
            && self.auto_key == editor.auto_key
            && same_value(self.retained.as_ref(), editor.retained.as_ref())
            && self.events.len() == editor.events.len()
            && self
                .events
                .iter()
                .zip(&editor.events)
                .all(|(a, b)| a.same_node(b))
            && self.sheet_clipboard == editor.sheet_clipboard
            && self.figure_clipboard == editor.figure_clipboard
            && self.segment_values_clipboard == editor.segment_values_clipboard
            && same_value(
                self.camera_clipboard.as_ref(),
                editor.camera_clipboard.as_ref(),
            )
            && same_value(
                self.camera_motion_clipboard.as_ref(),
                editor.camera_motion_clipboard.as_ref(),
            )
            && self.vfx_clip_clipboard == editor.vfx_clip_clipboard
            && self.draws == editor.draws
    }
}

/// Immutable results of the actual recorded publisher/history callback. All
/// large retained state stays on the worker; an interface job owns only IDs.
pub struct PreparedPublication {
    guard: Guard,
    heads: Heads,
    before_state: Value,
    before_history: Value,
    result: Value,
    state: Value,
    history: Value,
    events: Value,
}
impl PreparedPublication {
    /// Narrow worker response for the recorded project-settings surface. Fields
    /// come from the actual Fields owner, preserving its order and absence;
    /// this is not a second diff/publication or a serialized document snapshot.
    /// UI admission remains separate from this portable owning-worker API.
    pub fn project_fields_response_worker(&self, method: &str) -> Result<Value, EditError> {
        use crate::history::CommandKind;
        use styk_doc::Obj;
        if !matches!(method, "setFPS" | "setCanvasSize" | "updateProject" | "undo" | "redo") {
            return Err(EditError::Unported("the bounded project-settings worker surface".into()));
        }
        let status = self.result.get("status").and_then(Value::as_str);
        let changed = status == Some("ok") && self.result.get("result") == Some(&Value::Bool(true));
        let mut fields = Vec::new();
        if changed {
            let values: Vec<(String, Option<Value>)> = if matches!(method, "undo" | "redo") {
                let command = if method == "undo" { self.heads.snapshot.redo.last() } else { self.heads.snapshot.undo.last() }
                    .ok_or_else(|| EditError::Unported("the moved project history entry is unavailable".into()))?;
                let CommandKind::Fields { before, after, .. } = &command.kind else {
                    return Err(EditError::Unported("history outside the bounded project-settings worker surface".into()));
                };
                if before.iter().any(|(_, value)| value.is_none()) {
                    return Err(EditError::Unported("absent-before project fields require recorded own-key ordering".into()));
                }
                if method == "undo" { before.clone() } else { after.iter().map(|(key, value)| (key.clone(), Some(value.clone()))).collect() }
            } else {
                // _fields emits its exact ordered patch keys even if count0
                // immediately trims the command. Reuse that owning event and
                // the exact guarded root; never infer changes from a root diff.
                let events = self.result.get("events").and_then(Value::elements)
                    .ok_or_else(|| EditError::Unported("the Fields publication event is unavailable".into()))?;
                let mut keys = None;
                for event in events.iter() {
                    if let Some(fields) = event.get("projectFields") {
                        if keys.is_some() { return Err(EditError::Unported("multiple Fields publication events".into())); }
                        keys = Some(fields.clone());
                    }
                }
                let keys = keys.and_then(|keys| keys.elements().map(|e| e.iter().collect::<Vec<_>>()))
                    .ok_or_else(|| EditError::Unported("the Fields publication event is unavailable".into()))?;
                if keys.len() > 3 { return Err(EditError::Unported("more than three project fields in one publication".into())); }
                let mut values = Vec::new();
                for key in keys {
                    let key = key.as_str().ok_or_else(|| EditError::Unported("a non-string project field".into()))?;
                    if self.before_report().get(key).is_none() {
                        return Err(EditError::Unported("absent-before project fields require recorded own-key ordering".into()));
                    }
                    values.push((key.to_owned(), self.report().get(key).cloned()));
                }
                values
            };
            // JS undo keeps an own undefined key for absent-before settings.
            // The canonical JSON store cannot yet retain that insertion slot
            // through a later branch/re-edit. Refuse rather than delete/append
            // and silently alter the oracle's subsequent serialized key order.
            if values.len() > 3 { return Err(EditError::Unported("more than three project fields in one publication".into())); }
            for (key, value) in values {
                if !matches!(key.as_str(), "fps" | "canvas_width" | "canvas_height" | "frame_delay_ms")
                    || value.as_ref().is_some_and(|value| !matches!(value, Value::Null | Value::Bool(_) | Value::Num(_))) {
                    return Err(EditError::Unported("a non-scalar project field in worker history".into()));
                }
                let mut field = Obj::new(); field.set("key", Value::str(&key));
                match value { Some(value) => field.set("value", value.clone()), None => field.set("absent", Value::Bool(true)) }
                fields.push(Value::object(field));
            }
        }
        // State/history are the views already prepared by this same owner. Only
        // scalar lengths/checkpoint and top labels cross this narrow boundary;
        // complete undo/redo summaries remain retained on the durable worker.
        if self.state.get("selectedUids").and_then(Value::array_len).unwrap_or(0) > 1024
            || ["polygonSelection", "segmentIds", "branch"].iter().any(|key| self.state.get(key).is_some()) {
            return Err(EditError::Unported("selection outside the bounded project-settings worker surface".into()));
        }
        let mut result = Obj::new();
        for key in ["status", "result", "error", "reason"] {
            if let Some(value) = self.result.get(key) { result.set(key, value.clone()); }
        }
        result.set("state", self.state.clone());
        // Session drains emitted events into its answer before Heads capture.
        // Preserve that exact command response, not the now-empty pending list.
        result.set("events", self.result.get("events").cloned().unwrap_or_else(|| self.events.clone()));
        let mut history = Obj::new();
        for key in ["size", "revision", "revisionSerial", "savedRevision"] {
            if let Some(value) = self.history.get(key) { history.set(key, value.clone()); }
        }
        for key in ["undo", "redo"] {
            history.set(key, Value::Num(self.history.get(key).and_then(Value::array_len).unwrap_or(0) as f64));
        }
        history.set("limit", Value::Num(self.heads.limits.count as f64));
        history.set("byteLimit", Value::Num(self.heads.limits.bytes));
        let mut response = Obj::new(); response.set("kind", Value::str("project-fields"));
        response.set("answer", Value::object(result)); response.set("fields", Value::array(fields));
        response.set("history", Value::object(history));
        let response = Value::object(response);
        // Worker-only final bounded control check, before cursor or root admission.
        // Dense raw unknown fields never participate in this small response.
        if styk_doc::json::to_string(&response).len() > 64 * 1024 / 3 {
            return Err(EditError::Unported("project-settings response exceeds its control budget".into()));
        }
        Ok(response)
    }
    pub fn before_report(&self) -> &Value {
        &self.guard.report
    }
    pub fn before_revision(&self) -> u64 { self.guard.counters[0] }
    pub fn revision(&self) -> u64 { self.heads.snapshot.counters[0] }
    pub fn report(&self) -> &Value {
        &self.heads.snapshot.report
    }
    pub fn result(&self) -> &Value {
        &self.result
    }
    pub fn state(&self) -> &Value {
        &self.state
    }
    pub fn history(&self) -> &Value {
        &self.history
    }
    pub fn events(&self) -> &Value {
        &self.events
    }
    pub fn before_state(&self) -> &Value {
        &self.before_state
    }
    pub fn before_history(&self) -> &Value {
        &self.before_history
    }

    /// Worker-only validation; refusal returns the payload for worker disposal.
    /// Once validated, safe Rust's exclusive borrow prevents an intervening edit.
    pub fn guard_worker<'a>(
        self,
        editor: &'a mut Editor,
    ) -> Result<GuardedPublication<'a>, (EditError, Self)> {
        self.guard_worker_checked(editor, || Ok(()))
    }

    pub fn guard_worker_checked<'a>(
        self,
        editor: &'a mut Editor,
        mut check: impl FnMut() -> Result<(), EditError>,
    ) -> Result<GuardedPublication<'a>, (EditError, Self)> {
        if let Err(error) = check() {
            return Err((error, self));
        }
        let matches = self.guard.matches(editor);
        if let Err(error) = check() {
            return Err((error, self));
        }
        if !matches {
            return Err((
                EditError::Invalid(
                    "errors.editorLayerAsync.theAnimationChangedWhileTheLayerMoveWas".into(),
                ),
                self,
            ));
        }
        Ok(GuardedPublication {
            editor,
            prepared: self,
            epoch: None,
        })
    }

    /// Only the consuming Session worker capability can use this live guard.
    /// Its private epoch was checked before borrowing the same owner exclusively.
    pub(crate) fn guard_worker_exclusive<'a>(
        self, editor: &'a mut Editor, epoch: &'a mut u64, live: bool,
        mut check: impl FnMut() -> Result<(), EditError>,
    ) -> Result<GuardedPublication<'a>, (EditError, Self)> {
        if let Err(error) = check() { return Err((error, self)); }
        let matches = if live { self.guard.matches_owner(editor) } else { self.guard.matches(editor) };
        if let Err(error) = check() { return Err((error, self)); }
        if !matches { return Err((EditError::Invalid("the exclusive Session owner changed".into()), self)); }
        Ok(GuardedPublication { editor, prepared: self, epoch: Some(epoch) })
    }
}

/// Holds the same editing owner exclusively after its worker guard succeeded.
pub struct GuardedPublication<'a> {
    editor: &'a mut Editor,
    prepared: PreparedPublication,
    epoch: Option<&'a mut u64>,
}

/// Borrowed existing after-cache capability. Only the guarded publication can
/// construct it; it is worker-scoped and must not span host ACKs. It contains no
/// new evaluator, store, cache or prepared resources.
pub struct GuardedTypedCache<'a> {
    report: &'a Value,
    loader: &'a styk_eval::load::Loader,
    prepared: &'a std::sync::Arc<styk_eval::eval::Prepared>,
}
impl GuardedTypedCache<'_> {
    pub fn report(&self) -> &Value { self.report }
    pub fn loader(&self) -> &styk_eval::load::Loader { self.loader }
    pub fn prepared(&self) -> &std::sync::Arc<styk_eval::eval::Prepared> { self.prepared }
}
impl GuardedPublication<'_> {
    /// Canonical roots of this already-guarded transaction, borrowed on its worker.
    pub fn before_report(&self) -> &Value { self.prepared.before_report() }
    pub fn report(&self) -> &Value { self.prepared.report() }
    pub fn revision(&self) -> u64 { self.prepared.heads.snapshot.counters[0] }
    /// The actual after-cache belonging to this exact canonical COW report.
    /// Metadata/document compatibility is validated by the consuming Mirror
    /// owner before asset preparation; a foreign/cold cache is refused.
    pub fn typed_cache_worker(&self) -> Result<GuardedTypedCache<'_>, EditError> {
        let report = self.report();
        let (loader, prepared) = self.prepared.heads.cache.typed_worker(report)
            .ok_or_else(|| EditError::Unported("the guarded report has no compatible prepared cache".into()))?;
        if prepared.doc.sheet.is_none() {
            return Err(EditError::Unported("typed publication requires its prepared layer sheet".into()));
        }
        // Loader deliberately permits partial typed views. The existing Plan
        // owner checks the raw required layer/track/key descriptors; do not
        // fabricate a second shape validator or change legacy Editor loading.
        crate::layer_planning::checked_plan(report, &[], 0, None)?;
        Ok(GuardedTypedCache { report, loader, prepared })
    }
    /// Constant head exchange; retains all displaced payloads in the return.
    /// The host must keep this retirement on its durable worker through ACK.
    pub fn commit(mut self) -> RetiredPublication {
        self.prepared.heads.exchange(self.editor);
        if let Some(epoch) = self.epoch { *epoch += 1; }
        RetiredPublication {
            prepared: self.prepared,
        }
    }
}

/// Retains old/rollback/history/cache views for ACK, cancellation and disposal.
/// Never give this strong payload to an interface handle or drop it on the UI.
pub struct RetiredPublication {
    prepared: PreparedPublication,
}
impl RetiredPublication {
    pub fn previous_report(&self) -> &Value {
        &self.prepared.heads.snapshot.report
    }
    pub fn result(&self) -> &Value {
        &self.prepared.result
    }
    pub fn state(&self) -> &Value {
        &self.prepared.state
    }
    pub fn history(&self) -> &Value {
        &self.prepared.history
    }
    pub fn events(&self) -> &Value {
        &self.prepared.events
    }
}

impl Editor {
    /// Runs a recorded publication/history operation on this same owning worker,
    /// builds immutable views, then restores the live owner until guarded commit.
    /// Errors/cancel/stale restore all captured state; no second Editor is built.
    /// The caller must use the same validated generation/lineage as the Plan and
    /// retain all returned strong payloads on its durable worker until packet ACK.
    pub fn prepare_worker_publication(
        &mut self,
        operation: impl FnOnce(
            &mut Editor,
            &mut dyn FnMut() -> Result<(), EditError>,
        ) -> Result<Value, EditError>,
        check: impl FnMut() -> Result<(), EditError>,
    ) -> Result<PreparedPublication, EditError> {
        self.prepare_worker_operation(operation, check, false)
    }

    /// The exclusive Session capability is the sole caller permitting live
    /// runtime. It owns the same snapshots and must guard its operation epoch.
    pub(crate) fn prepare_worker_operation(
        &mut self,
        operation: impl FnOnce(&mut Editor, &mut dyn FnMut() -> Result<(), EditError>) -> Result<Value, EditError>,
        mut check: impl FnMut() -> Result<(), EditError>,
        live: bool,
    ) -> Result<PreparedPublication, EditError> {
        check()?;
        if !self.worker_history {
            return Err(EditError::Unported(
                "worker history has not been prepared".into(),
            ));
        }
        if !live && !quiet(self) {
            return Err(EditError::Unported(
                "publication with a live editing gesture or batch".into(),
            ));
        }
        let guard = Guard::capture(self);
        let mut heads = Heads::capture(self);
        let before_state = self.state_value();
        let before_history = self.history_value();
        let result = operation(self, &mut check).and_then(|result| {
            check()?;
            if !live && !quiet(self) {
                return Err(EditError::Unported(
                    "publication left a live editing gesture or batch".into(),
                ));
            }
            if self.events.len() < guard.events.len()
                || !self
                    .events
                    .iter()
                    .zip(&guard.events)
                    .all(|(a, b)| a.same_node(b))
            {
                return Err(EditError::Unported(
                    "publication consumed previously queued change events".into(),
                ));
            }
            Ok(result)
        });
        match result {
            Err(error) => {
                heads.exchange(self);
                Err(error)
            }
            Ok(result) => {
                let state = self.state_value();
                let history = self.history_value();
                let events =
                    Value::array(self.events[guard.events.len().min(self.events.len())..].to_vec());
                let final_check = check();
                heads.exchange(self);
                final_check?;
                Ok(PreparedPublication {
                    guard,
                    heads,
                    before_state,
                    before_history,
                    result,
                    state,
                    history,
                    events,
                })
            }
        }
    }
}
