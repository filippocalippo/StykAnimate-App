//! Direct host access to the same session, without the JavaScript read-view protocol.

use styk_doc::Value;

use super::{Session, apply_view, prepare_call};
use crate::{EditError, HistoryMarks, Selection};

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
}

/// Borrowed view state and scalar history state. Nothing here owns a second selection or document.
pub struct SessionView<'a> {
    pub selection: &'a Selection,
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
    /// Run today's command and arguments directly, on this session's owner thread.
    /// `view` has the same meaning as in `call_values`; null retains the session's current view.
    /// Values are native (including non-finite numbers); no JSON argument encoding or document patch is needed.
    /// The command dispatcher, rollback, history and gesture grouping remain `Editor::call`'s.
    pub fn call_native(&mut self, method: &str, args: &[Value], view: &Value) -> NativeCall {
        let editor = &mut self.editor;
        let result = apply_view(editor, view).and_then(|()| {
            prepare_call(editor, view);
            editor.call(method, args)
        });
        let ok = result.is_ok();
        let copied = if ok { crate::clipboards::copied_kind(method).filter(|_| method == "sheetCopyFrames" || result.as_ref().is_ok_and(Value::truthy)) } else { None };
        let clipboard = copied.and_then(|kind| editor.clipboard_answer(kind).map(|value| (kind, value)));
        NativeCall {
            result,
            events: editor.take_events(),
            drawing_forks: if ok { std::mem::take(&mut editor.drawing_forks) } else { Vec::new() },
            drawing_retired: ok && std::mem::take(&mut editor.drawing_retired),
            clipboard,
            draws_left: editor.draw_pool.then(|| editor.draws.iter().cloned().collect()),
        }
    }

    pub fn view(&self) -> SessionView<'_> {
        let editor = &self.editor;
        SessionView {
            selection: &editor.selection,
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
}
