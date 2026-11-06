//! Exclusive capability for the same worker Session, including live gestures.
//! No mutable Editor/Session reference is exposed while this owner is attached.
use super::*;
use crate::publication::{GuardedPublication, PreparedPublication};

/// Actual working display prepared by the editor's existing Loader/evaluator.
/// Keep this strong payload on its worker. Browser presentation/query admission
/// requires the actor's separately guarded ready ticket and retirement lease.
pub struct WorkerFrame {
    pub record: Value,
    pub prepared: Arc<styk_eval::eval::Prepared>,
    pub frame: Arc<styk_eval::eval::Frame>,
    pub scene: styk_eval::geometry::RetainedScene,
}

/// One immutable operation of the private exclusive worker capability.
/// Constructors are private: another Session cannot fabricate its identity or
/// operation epoch, even if it shares exactly the same canonical report head.
pub struct WorkerPrepared {
    publication: PreparedPublication,
    identity: Arc<()>,
    epoch: u64,
    live: bool,
    display: Option<WorkerFrame>,
    runtime: Value,
}
impl WorkerPrepared {
    pub fn publication(&self) -> &PreparedPublication { &self.publication }
    pub fn display(&self) -> Option<&WorkerFrame> { self.display.as_ref() }
    pub fn runtime(&self) -> &Value { &self.runtime }
    pub fn result(&self) -> &Value { self.publication.result() }
    pub fn report(&self) -> &Value { self.publication.report() }
    pub fn before_report(&self) -> &Value { self.publication.before_report() }
    pub fn revision(&self) -> u64 { self.publication.revision() }
    pub fn before_revision(&self) -> u64 { self.publication.before_revision() }
}

/// The existing Session moved into an exclusive worker capability. This is an
/// ownership boundary, not another editor, baseline, store or evaluation cache.
pub struct WorkerSession {
    session: Session,
    identity: Arc<()>,
    epoch: u64,
}

fn runtime(editor: &Editor) -> Value {
    let mut value = Obj::new();
    value.set("drag", Value::Bool(editor.drag.is_some()));
    value.set("authored", Value::Bool(editor.authored.is_some()));
    value.set("animationEdit", Value::Bool(editor.property_edit.is_some()));
    value.set("changed", Value::Bool(editor.drag.as_ref().is_some_and(|drag| drag.changed)
        || editor.property_edit.as_ref().is_some_and(|edit| edit.changed)));
    Value::object(value)
}

// One display preparation owner for quiet and live operations. A quiet
// operation after a gesture must replace its actual ready candidate too.
fn display_worker(
    editor: &mut Editor, check: &mut dyn FnMut() -> Result<(), EditError>,
) -> Result<WorkerFrame, EditError> {
    check()?;
    let record = editor.shown_frame()?;
    let (prepared, frame, scene) = editor.evaluate()?;
    check()?;
    let scene = prepared.doc.scene_budget.retain_worker(Arc::new(scene))
        .map_err(|_| EditError::Unported("the worker display exceeds its lineage scene budget".into()))?;
    Ok(WorkerFrame { record, prepared, frame: Arc::new(frame), scene })
}

impl Session {
    /// Consumes the SAME Session on its owning worker. No direct mutable session
    /// access remains until explicit worker detach returns that owner.
    pub fn into_worker(self) -> WorkerSession {
        WorkerSession { session: self, identity: Arc::new(()), epoch: 0 }
    }
}
impl WorkerSession {
    pub fn report(&self) -> &Value { self.session.report() }
    pub fn revision(&self) -> u64 { self.session.revision() }
    pub fn history_checkpoint_worker(&self) -> Option<f64> { self.session.history_checkpoint_worker() }
    pub fn operation_epoch(&self) -> u64 { self.epoch }
    // Offline replay observes the exact moved owner's initial heads before
    // dispatch. Reuse the same serializers and worker display preparation;
    // this exposes no UI capability and publishes no operation or report.
    pub(crate) fn initial_observation_worker(
        &mut self, check: &mut dyn FnMut() -> Result<(), EditError>,
    ) -> Result<(Value, Value, WorkerFrame, Value), EditError> {
        let display = display_worker(&mut self.session.editor, check)?;
        Ok((self.session.editor.state_value(), self.session.editor.history_value(),
            display, runtime(&self.session.editor)))
    }
    /// Reuses the same history owner during worker attach/readiness. It does
    /// not expose mutable Session access or import foreign command entries.
    pub fn prepare_worker_history(
        &mut self, limits: crate::HistoryLimits, checkpoint: f64,
        check: impl FnMut() -> Result<(), EditError>,
    ) -> Result<(), EditError> {
        self.session.prepare_worker_history(limits, checkpoint, check)
    }
    /// Worker detach moves the original owner, preserving every live baseline,
    /// history entry, counter and source. The host must retain its actor guards.
    pub fn into_session(self) -> Session {
        self.session
    }

    /// Retains the original quiet-editor requirement exactly.
    pub fn prepare_quiet(
        &mut self, method: &str, args: &Value, view: &Value,
        check: impl FnMut() -> Result<(), EditError>,
    ) -> Result<WorkerPrepared, EditError> {
        if self.epoch == u64::MAX { return Err(EditError::Invalid("the Session operation epoch is exhausted".into())); }
        let mut display = None;
        let publication = self.session.editor.prepare_worker_publication(|editor, check| {
            check()?;
            let answer = call_values(editor, method, args, view, true, Some(&mut *check))?;
            check()?;
            display = Some(display_worker(editor, check)?);
            Ok(answer)
        }, check)?;
        Ok(WorkerPrepared { publication, identity: self.identity.clone(), epoch: self.epoch,
            live: false, display, runtime: Value::Null })
    }

    /// Recorded live lifecycle only. The owning Session supplies all view state;
    /// a foreign pre-call view cannot overwrite a newer gesture or selection.
    /// Display geometry is built by its existing evaluation owner on this worker.
    pub fn prepare_live(
        &mut self, method: &str, args: &Value, view: &Value,
        check: impl FnMut() -> Result<(), EditError>,
    ) -> Result<WorkerPrepared, EditError> {
        if !view.is_null() || !matches!(method, "select" | "beginDrag" | "moveSelection"
            | "commitDrag" | "cancelDrag" | "beginAnimationEdit" | "previewAnimationEdit"
            | "commitAnimationEdit" | "cancelAnimationEdit" | "seek" | "undo" | "redo") {
            return Err(EditError::Unported("the recorded exclusive Session lifecycle".into()));
        }
        if self.epoch == u64::MAX { return Err(EditError::Invalid("the Session operation epoch is exhausted".into())); }
        let mut display = None;
        let mut observed = Value::Null;
        let publication = self.session.editor.prepare_worker_operation(|editor, check| {
            check()?;
            let answer = call_values(editor, method, args, view, true, Some(&mut *check))?;
            check()?;
            observed = runtime(editor);
            display = Some(display_worker(editor, check)?);
            Ok(answer)
        }, check, true)?;
        Ok(WorkerPrepared { publication, identity: self.identity.clone(), epoch: self.epoch,
            live: true, display, runtime: observed })
    }

    /// Final validation over this exact exclusive owner. Refusal returns all
    /// candidate display/snapshot payloads for disposal on the durable worker.
    pub fn guard<'a>(
        &'a mut self, prepared: WorkerPrepared,
        check: impl FnMut() -> Result<(), EditError>,
    ) -> Result<(GuardedPublication<'a>, Option<WorkerFrame>, Value), (EditError, WorkerPrepared)> {
        if !Arc::ptr_eq(&self.identity, &prepared.identity) || self.epoch != prepared.epoch {
            return Err((EditError::Invalid("the exclusive Session operation is stale".into()), prepared));
        }
        let WorkerPrepared { publication, identity, epoch, live, display, runtime } = prepared;
        match publication.guard_worker_exclusive(&mut self.session.editor, &mut self.epoch, live, check) {
            Ok(guard) => Ok((guard, display, runtime)),
            Err((error, publication)) => Err((error, WorkerPrepared { publication, identity, epoch, live, display, runtime })),
        }
    }
}
