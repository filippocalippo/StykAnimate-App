//! Alt-drag duplication (src/editor-duplicate-drag.mjs): `beginDuplicateDrag` duplicates the
//! selected figures whole and starts moving the copies; the gesture's commit records the copies and
//! the move as one history entry, its cancel takes the copies away again and leaves history alone.

use styk_doc::{Obj, Value};

use crate::history::Entry;
use crate::record::uid;
use crate::select::{resolve_join_selection, SelectionState};
use crate::{EditError, Editor};

/// `_drag.duplicate`: what duplicating recorded (held back from history until the gesture ends),
/// the revision before it and the selection when it began.
#[derive(Clone, Debug)]
pub(crate) struct Duplicate {
    pub(crate) commands: Vec<Entry>,
    pub(crate) revision: u64,
    pub(crate) selection: SelectionState,
}

const LABEL: &str = "Duplicate figures";

impl Editor {
    /// `beginDuplicateDrag({pasteMode})`: duplicates the selected figures (whole, with what is joined
    /// to them) at the same place and begins a translation gesture on the copies.
    pub(crate) fn begin_duplicate_drag(&mut self, options: &Value) -> Result<bool, EditError> {
        let paste_mode = options.get("pasteMode").filter(|mode| !mode.is_null()).cloned().unwrap_or_else(|| Value::str("instance"));
        if self.drag.is_some() {
            self.commit_drag()?;
        }
        if self.property_edit.is_some() {
            self.commit_animation_edit()?;
        }
        if self.object()?.is_none() {
            return Ok(false);
        }
        if self.batch.is_some() {
            return Err(EditError::Unported("a duplicate drag inside a grouped edit".into()));
        }
        let (revision, selection) = (self.revision, self.selection_state());
        // The copies are recorded into the gesture, not into history.
        self.start_collecting();
        let begun = self.duplicate_and_begin(paste_mode);
        let duplicate = Duplicate { commands: self.finish_collecting(), revision, selection };
        match begun {
            Ok(true) => {
                if let Some(drag) = self.drag.as_mut() {
                    drag.duplicate = Some(duplicate);
                    drag.changed = true;
                }
                Ok(true)
            }
            Ok(false) => {
                self.rollback_duplicate(&duplicate)?;
                Ok(false)
            }
            Err(error) => {
                self.cancel_drag()?;
                self.rollback_duplicate(&duplicate)?;
                Err(error)
            }
        }
    }

    fn duplicate_and_begin(&mut self, paste_mode: Value) -> Result<bool, EditError> {
        let frame = self.selection_frame()?;
        let slots = resolve_join_selection(&frame, &self.selection.uids, true)?;
        let affected: Vec<u32> = slots.iter().filter_map(|&slot| frame.get(slot).and_then(uid)).collect();
        self.select_many(&affected)?;
        let mut options = Obj::new();
        options.set("pasteMode", paste_mode);
        options.set("offset", Value::Num(0.0));
        let copies = self.duplicate_selection_pastes(&Value::object(options), None)?;
        Ok(copies.array_len().unwrap_or(0) > 0 && self.begin_drag(LABEL, true)?)
    }

    /// `finishDuplicateDrag(commit)`: the copies and their move become one history entry, or neither remains.
    pub(crate) fn finish_duplicate_drag(&mut self, commit: bool) -> Result<bool, EditError> {
        let Some(duplicate) = self.drag.as_mut().and_then(|drag| drag.duplicate.take()) else { return Ok(false) };
        if !commit {
            self.cancel_drag()?;
            self.rollback_duplicate(&duplicate)?;
            return Ok(true);
        }
        // One undo step, published only after the move has validated.
        self.revision = duplicate.revision;
        self.begin_batch_with(LABEL, duplicate.selection.clone(), duplicate.commands.clone());
        match self.commit_drag() {
            Ok(_) => {
                self.end_batch()?;
                Ok(true)
            }
            Err(error) => {
                self.abort_batch()?;
                self.cancel_drag()?;
                self.restore_selection(&duplicate.selection)?;
                self.prune_frame_sources();
                self.emit("edit", vec![("label", Value::str("Cancel duplicate")), ("structural", Value::Bool(true))]);
                Err(error)
            }
        }
    }

    /// Takes the copies away: what duplicating recorded undone, the revision and selection as they were.
    fn rollback_duplicate(&mut self, duplicate: &Duplicate) -> Result<(), EditError> {
        self.undo_entries(&duplicate.commands)?;
        self.revision = duplicate.revision;
        self.restore_selection(&duplicate.selection)?;
        self.prune_frame_sources();
        self.retained = None;
        self.emit("edit", vec![("label", Value::str("Cancel duplicate")), ("structural", Value::Bool(true))]);
        Ok(())
    }
}
