//! What the interface's owner (`src/engine/engine-owner.mjs`, D19) tells the session besides the editor's calls: bookkeeping
//! that is not an edit. The calls start with `@` and are never refused for the document.
//!
//! - `@historyLimits(count, bytes)` sizes history as the editor does;
//! - `@revisions(revision, serial, saved)` continues the editor's numbering across the documents it holds;
//! - `@markSaved()` makes the revision on show the saved one;
//! - `@touch()` marks the document changed outside a command (`editor.dirty = true`): a new revision without a history entry;
//! - `@publishCel(celId, definition)` gives the session the cel definition the interface's drawing store finished (the
//!   encoded tiles, bounds and revision it attaches once it published the pixels): a derived publication, not an edit, so the
//!   revision does not move. The pixel commits themselves are `drawing_pixels.rs`.

use styk_doc::Value;

use crate::{EditError, Editor};

fn invalid(what: &str) -> EditError {
    EditError::Invalid(format!("errors.engineOwner.{what}"))
}

impl Editor {
    pub(crate) fn configure_history(&mut self, args: &[Value]) -> Result<Value, EditError> {
        let count = args.first().and_then(Value::as_f64).filter(|count| *count >= 0.0).ok_or_else(|| invalid("historyLimitsNeedACount"))?;
        let bytes = args.get(1).and_then(Value::as_f64).unwrap_or(48.0 * 1024.0 * 1024.0);
        self.configure_worker_history(crate::HistoryLimits { count: count as usize, bytes })?;
        Ok(Value::Bool(true))
    }

    /// `@revisions(revision, serial, saved)`: continue the editor's numbering. A `null` revision or saved revision stays as the
    /// session has it (a session the editor came back to goes on from the editor's serial alone).
    pub(crate) fn set_revisions(&mut self, args: &[Value]) -> Result<Value, EditError> {
        let number = |at: usize| args.get(at).and_then(Value::as_f64).filter(|value| value.is_finite() && *value >= 0.0).map(|value| value as u64).ok_or_else(|| invalid("revisionsNeedNumbers"));
        let kept = |at: usize, current: u64| if args.get(at).is_some_and(Value::is_null) { Ok(current) } else { number(at) };
        self.set_revision_counters(kept(0, self.revision)?, number(1)?, kept(2, self.saved_revision)?);
        Ok(Value::Bool(true))
    }

    pub(crate) fn mark_saved(&mut self) -> Result<Value, EditError> {
        self.saved_revision = self.revision;
        Ok(Value::Bool(true))
    }

    /// `dirty = true` outside a command: a new revision, the tree untouched.
    pub(crate) fn mark_changed(&mut self) -> Result<Value, EditError> {
        self.revision_serial += 1;
        self.revision = self.revision_serial;
        Ok(Value::Bool(true))
    }

    /// `@publishCel(celId, definition)`: the cel's definition as the drawing store left it replaces the session's.
    pub(crate) fn publish_cel(&mut self, args: &[Value]) -> Result<Value, EditError> {
        let cel = args.first().and_then(Value::as_str).ok_or_else(|| invalid("celNeedsAnIdentity"))?;
        let definition = args.get(1).filter(|definition| definition.is_object()).ok_or_else(|| invalid("celNeedsADefinition"))?;
        let celled = |figure: &Value| figure.path(&["_styk", "drawing", "celId"]).and_then(Value::as_str) == Some(cel);
        if !celled(definition) {
            return Err(invalid("celDefinitionIsAnotherCel"));
        }
        let Some(index) = self.report.get("figure_types").and_then(Value::elements).and_then(|figures| figures.iter().position(|figure| celled(&figure))) else {
            // The cel left the document (undone, deleted) while its pixels were being published: nothing to attach.
            return Ok(Value::Bool(false));
        };
        let figures = self.report.make_obj().and_then(|report| report.get_mut("figure_types")).and_then(Value::make_arr).ok_or_else(|| invalid("celNeedsADocument"))?;
        figures[index] = definition.clone();
        Ok(Value::Bool(true))
    }
}
