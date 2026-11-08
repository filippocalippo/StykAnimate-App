//! Direct host access to the same session, without the JavaScript read-view protocol.

use styk_doc::Value;

use super::{Session, apply_view, prepare_call};
use crate::{EditError, Editor, HistoryMarks, Selection};

/// A command's actual return value or refusal, and effects the host must handle.
/// Errors retain events too: the native host must not invent a rollback the command does not make.
#[derive(Debug)]
pub struct NativeCall {
    pub result: Result<Value, EditError>,
    pub events: Vec<Value>,
    pub drawing_forks: Vec<(String, String)>,
    pub drawing_retired: bool,
    /// The copied kind and its session-owned COW payload, as in the JSON host's answer.
    pub clipboard: Option<(&'static str, Value)>,
    /// Unused D18 draws, in order, when the caller supplied a pool.
    pub draws_left: Option<Vec<(String, Value)>>,
    /// Moved typed storage. Native hosts hand this to worker reclamation before returning the answer.
    pub retired_clipboard: Option<crate::clipboards::RetiredClipboard>,
}

/// Borrowed view state and scalar history state. Nothing here owns a second selection or document.
pub struct SessionView<'a> {
    pub selection: &'a Selection,
    pub sheet_selection: Option<(&'a str, bool)>,
    pub tick: f64,
    pub frame_index: usize,
    pub revision: u64,
    pub history: HistoryMarks,
    pub undo_label: &'a str,
    pub redo_label: &'a str,
    pub dirty: bool,
    /// Today's detach guard (`editor-sessions.mjs`): finish the edit before switching projects.
    pub editing: bool,
}

impl Session {
    /// COW save operands. Materialize on the save worker, never on the interface thread.
    pub fn native_save_snapshot(&self) -> impl FnOnce() -> Value + Send + 'static {
        let mut report = self.report().clone();
        let active = self.native_snapshot_active.clone();
        move || {
            if let Some(active) = active {
                if let Some(layers) = report.make_obj().and_then(|r| r.get_mut("_styk")).and_then(Value::make_obj)
                    .and_then(|r| r.get_mut("layers")).and_then(Value::make_obj) { layers.set("activeId", active); }
            }
            report
        }
    }
    /// Native Settings supplies only the preference it owns; a partial JSON view would reset selection/playhead.
    pub fn set_auto_key(&mut self, enabled: bool) { self.editor.set_auto_key(enabled); }
    /// Native long-work routing. The incremental browser bake entries are also excluded from
    /// the synchronous native seam; native hosts dispatch the complete bake on its sole worker owner.
    pub fn requires_worker(&self, method: &str, args: &[Value]) -> bool {
        match method {
            "@timeline" => true,
            "bakeMovieclip" | "bakeMovieclipBegin" | "bakeMovieclipSample" | "bakeMovieclipPublish" | "bakeMovieclipCancel"
            | "restartMovieclip" | "removeMovieclipRestart" | "breakApartMovieclip"
            | "addMovieclipToNextKeyframes" | "placeMovieclip" | "splitMovieclip" => true,
            "setMovieclipPlayback" => args.get(1).and_then(|value| value.get("allFrames")).is_some_and(Value::truthy),
            "addFigure" => self.report().get("figure_types").and_then(Value::elements).is_some_and(|figures| {
                let wanted = args.first().cloned().or_else(|| figures.iter().next().and_then(|figure| figure.get("figure_type_id").cloned()));
                figures.iter().find(|figure| figure.get("figure_type_id") == wanted.as_ref())
                    .is_some_and(|figure| figure.path(&["_styk", "movieclip"]).is_some_and(Value::truthy))
            }),
            _ => false,
        }
    }
    /// The same movieclip open operands used by the browser host, sharing the tree until the worker reserves its copy.
    pub fn movieclip_document(&self, type_id: f64) -> Result<(Value, String), EditError> {
        let refused = || EditError::Invalid("errors.editorMovieclips.chooseAMovieclip".into());
        let figure = self.report().get("figure_types").and_then(Value::elements)
            .and_then(|figures| figures.iter().find(|figure| figure.get("figure_type_id").and_then(Value::as_f64) == Some(type_id))).ok_or_else(refused)?;
        let asset = figure.path(&["_styk", "movieclip"]).filter(|asset| asset.is_object()).ok_or_else(refused)?;
        if asset.get("spatialMeshes").is_some_and(Value::truthy) { return Err(EditError::Invalid("errors.editorMovieclips.thisIsAnAttachedMeshPoseItsParent".into())); }
        let document = asset.get("document").filter(|document| document.is_object()).ok_or_else(refused)?;
        Ok((document.clone(), figure.get("name").and_then(Value::as_str).unwrap_or("").to_string()))
    }

    /// Restore today's shared clipboards when a project becomes active, without serializing a read view.
    pub fn clipboard(&self, kind: &str) -> Option<Value> { self.editor.clipboard_wire(kind) }

    pub fn take_clipboard(&mut self, kind: &str) -> Option<crate::clipboards::RetiredClipboard> { self.editor.take_clipboard(kind) }

    /// The nesting depth belongs to the document host; every command observes it, including null-view calls.
    pub fn set_outer_depth(&mut self, depth: usize) { self.editor.outer_depth = depth; }

    /// Run today's command and arguments directly, on this session's owner thread.
    /// `view` has the same meaning as in `call_values`; null retains the session's current view.
    /// Values are native (including non-finite numbers); no JSON argument encoding or document patch is needed.
    /// The command dispatcher, rollback, history and gesture grouping remain `Editor::call`'s.
    pub fn call_native(&mut self, method: &str, args: &[Value], view: &Value) -> NativeCall {
        snapshot_view_boundary(&self.editor, &mut self.native_snapshot_active, method);
        let editor = &mut self.editor;
        let displaced_kind = crate::clipboards::copied_kind(method)
            .or_else(|| (method == "@setClipboard").then(|| args.first().and_then(Value::as_str)).flatten());
        let mut retired_clipboard = displaced_kind.and_then(|kind| editor.take_clipboard(kind));
        let result = apply_view(editor, view).and_then(|()| {
            prepare_call(editor, view);
            editor.call(method, args)
        });
        // A copy with no selection (or a refused copy) retains its old clipboard. A successful
        // explicit null handoff clears it. Restore by move, never by cloning typed storage.
        if displaced_kind.is_some_and(|kind| !editor.has_clipboard(kind))
            && (method != "@setClipboard" || result.is_err())
            && let Some(previous) = retired_clipboard.take() { previous.restore(editor); }
        answer(editor, method, result, retired_clipboard)
    }

    pub fn view(&self) -> SessionView<'_> {
        let editor = &self.editor;
        SessionView {
            selection: &editor.selection,
            sheet_selection: editor.sheet_selection.as_ref().map(|s| (s.id.as_str(), s.contents)),
            tick: editor.tick,
            frame_index: editor.frame_index,
            revision: editor.revision,
            history: self.history_marks(),
            undo_label: editor.undo.last().map_or("", |entry| entry.label.as_str()),
            redo_label: editor.redo.last().map_or("", |entry| entry.label.as_str()),
            dirty: editor.dirty(),
            editing: editor.drag.is_some() || editor.property_edit.is_some() || editor.authored.is_some(),
        }
    }

    /// Read the session's cached typed document inside the owning core's logic.
    /// The callback borrows it; no `Prepared`/generation escapes into a panel view model.
    pub fn with_document<T>(&self, read: impl FnOnce(&styk_eval::doc::Document) -> T) -> Result<T, EditError> {
        let prepared = self.editor.prepared()?;
        Ok(read(&prepared.doc))
    }

    /// A read the interface makes by name (`animationValue`, `segmentAnimationTarget`, `getIKSettings`, ...), with
    /// native arguments, against the session's current view: `None` for a name the session does not answer.
    pub fn read(&self, name: &str, args: &Value) -> Option<Result<Option<Value>, EditError>> {
        self.editor.interface_query(name, args)
    }

    /// The current frame's records, including a live gesture or property preview.
    /// Only a COW handle is returned; records are neither copied nor serialized.
    /// Uses the editor's existing cache (tree identity, playhead and evaluation options).
    pub fn frame_records(&self) -> Result<Value, EditError> {
        self.editor.shown_frame()
    }

    /// The frame on show when it needs no evaluation or conversion: `None` when only evaluating would answer. The
    /// interface thread reads this, never [`Session::frame_records`].
    pub fn frame_records_ready(&self) -> Option<Value> {
        self.editor.shown_frame_ready()
    }

    /// The typed document when the session holds views of it as it is now: `None` rather than converting it.
    pub fn with_document_ready<T>(&self, read: impl FnOnce(&styk_eval::doc::Document) -> T) -> Option<T> {
        self.editor.views().map(|prepared| read(&prepared.doc))
    }

    /// `animationValue(target, property)` at the playhead when it needs no evaluation: `None` when not ready.
    pub fn animation_value_ready(&self, target: &Value, property: &str) -> Option<Result<Option<Value>, EditError>> {
        self.editor.animation_value_ready(target, property)
    }

    /// Takes the views and the frame on show a worker made of the session's document as it is now (`report`) at
    /// `tick`; a document that changed since keeps what it has.
    pub fn adopt_evaluation(&self, report: &Value, prepared: std::sync::Arc<styk_eval::eval::Prepared>, tick: f64, frame: Value) {
        self.editor.adopt_views(report, prepared);
        self.editor.adopt_frame(report, tick, frame);
    }
}

fn answer(editor: &mut crate::Editor, method: &str, result: Result<Value, EditError>, retired_clipboard: Option<crate::clipboards::RetiredClipboard>) -> NativeCall {
    let ok = result.is_ok();
    let copied = if ok { crate::clipboards::copied_kind(method).filter(|_| method == "sheetCopyFrames" || result.as_ref().is_ok_and(Value::truthy)) } else { None };
    let clipboard = copied.and_then(|kind| editor.clipboard_answer(kind).map(|value| (kind, value)));
    NativeCall { result, events: editor.take_events(),
        drawing_forks: if ok { std::mem::take(&mut editor.drawing_forks) } else { Vec::new() },
        drawing_retired: ok && std::mem::take(&mut editor.drawing_retired), clipboard,
        draws_left: editor.draw_pool.then(|| editor.draws.iter().cloned().collect()), retired_clipboard }
}

impl super::WorkerSession {
    /// Run the complete native long command on the SAME exclusive owner. Checkpoints and rollback
    /// use the existing timeline worker and publication heads; commit linearizes cancellation.
    pub fn call_native_long(&mut self, method: &str, args: &[Value], view: &Value,
        check: &mut dyn FnMut() -> Result<(), EditError>, commit: impl FnOnce() -> Result<(), EditError>,
    ) -> Result<NativeCall, EditError> {
        if !self.session.requires_worker(method, args) || matches!(method, "bakeMovieclipBegin" | "bakeMovieclipSample" | "bakeMovieclipPublish" | "bakeMovieclipCancel") {
            return Err(EditError::Invalid("errors.editorSessions.chooseACompleteBackgroundCommand".into()));
        }
        let mut snapshot_active = self.session.native_snapshot_active.clone();
        let result = self.session.editor.native_worker_transaction(|editor, check| {
            let mut interrupted = None;
            let mut checked = || match check() {
                Ok(()) => Ok(()),
                Err(error) => {
                    let forwarded = match &error { EditError::Invalid(key) => EditError::Invalid(key.clone()), EditError::Unported(reason) => EditError::Unported(reason.clone()) };
                    interrupted = Some(error);
                    Err(forwarded)
                }
            };
            let result = apply_view(editor, view).and_then(|()| {
                prepare_call(editor, view);
                if method == "@timeline" {
                    // A bounded interaction batch on the same exclusive session, never a second Editor.
                    // Selection and seek can evaluate arbitrarily dense frames. FPS normalization also stays here.
                    if args.len() > 4 { return Err(EditError::Invalid("errors.editorSessions.finishTheCurrentOperationFirst".into())); }
                    let mut result = Value::Null;
                    for call in args {
                        checked()?;
                        let name = call.get("method").and_then(Value::as_str).unwrap_or("");
                        if !matches!(name, "seek" | "selectSheetLayer" | "keepSelectionOnSeek" | "setFPS" | "endFrameDraftPreview" | "disableFrameDrafts") {
                            return Err(EditError::Invalid("errors.editorSessions.chooseACompleteBackgroundCommand".into()));
                        }
                        let values: Vec<_> = call.get("args").and_then(Value::elements).map(|v| v.iter().collect()).unwrap_or_default();
                        snapshot_view_boundary(editor, &mut snapshot_active, name);
                        result = editor.call(name, &values)?;
                    }
                    return Ok(result);
                }
                snapshot_view_boundary(editor, &mut snapshot_active, method);
                if editor.sheet() || method == "bakeMovieclip" {
                    let clock = editor.clock.unwrap_or(|| 0.0);
                    let mut worker = crate::movieclip_planning::TimelineWorker { max_source_bytes: usize::MAX, check: &mut checked, progress: &mut |_| {}, clock };
                    editor.call_movieclip_timeline_worker(method, args, &mut worker)
                } else { editor.call_worker_checked(method, &Value::array(args.to_vec()), &mut checked) }
            });
            if let Some(error) = interrupted { return Err(error); }
            Ok(answer(editor, method, result, None))
        }, check, commit);
        if result.is_ok() { self.session.native_snapshot_active = snapshot_active; }
        result
    }
}

// The browser owner leaves selection/seek in its read view. Snapshot/export takes the session's
// last activeId until the next actual session command imports that view. Keep that one scalar
// wire distinction here; the native Editor remains the only live selection/history owner.
fn snapshot_view_boundary(editor: &Editor, active: &mut Option<Value>, method: &str) {
    if matches!(method, "seek" | "selectSheetLayer" | "keepSelectionOnSeek" | "setActiveLayer") {
        if active.is_none() { *active = editor.report.path(&["_styk", "layers", "activeId"]).cloned(); }
    } else { *active = None; }
}
