//! Working frames (src/editor-frame-draft.mjs). The interface never starts one on a layer sheet: it
//! only ends them (`disableFrameDrafts` when the timeline is mounted in Advanced mode) and asks
//! whether a preview is open. The engine answers those, and converts a draft a file was saved
//! with into the frame it edits; starting, adding, updating and discarding a draft (the editor's
//! low-level API for native timelines, used by its tests) are not edited here.

use styk_doc::Value;

use crate::record::num;
use crate::timeline::rows;
use crate::{EditError, Editor};

impl Editor {
    /// `disableFrameDrafts()`: commits what is open, and makes the document edit its frames directly:
    /// a saved Update draft stays the edit it was (its frame already holds the working pose).
    /// Answers whether a pending Add became a frame of its own, which it never does here.
    pub(crate) fn disable_frame_drafts(&mut self) -> Result<Value, EditError> {
        if self.property_edit.is_some() {
            self.commit_animation_edit()?;
        }
        if let Some(draft) = self.report.path(&["_styk", "simpleFrameDraft"]).cloned() {
            let index = num(&draft, "index").filter(|index| *index >= 0.0 && index.fract() == 0.0).map(|index| index as usize);
            let frames = self.report.get("keyframes").and_then(Value::elements).map(|frames| frames.iter().collect::<Vec<_>>()).unwrap_or_default();
            let valid = draft.is_object()
                && num(&draft, "version") == Some(1.0)
                && matches!(draft.get("mode").and_then(Value::as_str), Some("add" | "update"))
                && index.is_some_and(|index| frames.get(index).is_some_and(|frame| frame.path(&["_styk", "frameId"]) == draft.get("frameId")));
            let Some(index) = index.filter(|_| valid) else { return Err(EditError::Invalid("errors.editorFrameDraft.invalidSimpleTimelineWorkingFrame".into())) };
            if draft.get("mode").and_then(Value::as_str) == Some("add") && (draft.get("baseline").is_some_and(Value::truthy) || draft.get("empty").is_some_and(Value::truthy)) {
                return Err(EditError::Unported("a saved working frame that adds a keyframe".into()));
            }
            // The editor shows the draft's frame while it commits it.
            self.frame_index = index;
            self.tick = rows(&self.report).get(index).map_or(0.0, |row| row.start);
            self.retained = None;
        }
        self.commit_drag()?;
        if self.report.path(&["_styk", "simpleFrameDraft"]).is_some() {
            if let Some(styk) = self.report.make_obj().and_then(|report| report.get_mut("_styk")).and_then(Value::make_obj) {
                styk.remove("simpleFrameDraft");
            }
        }
        self.emit("frame-draft", vec![]);
        Ok(Value::Bool(false))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn editor() -> Editor {
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/rig-drag-sheet.reference.json");
        let reference = styk_doc::json::parse(&std::fs::read(file).unwrap()).unwrap();
        let first = reference.get("steps").unwrap().item(0).unwrap();
        let mut editor = Editor::new(styk_doc::json::parse(first.get("document").unwrap().as_str().unwrap().as_bytes()).unwrap(), crate::Options { property_channels: true, layer_timeline: true, auto_key: false });
        editor.set_view(0.0, 0, crate::Selection { uid: Some(1), uids: vec![1], joint: -1 });
        editor
    }

    fn draft(editor: &mut Editor, text: &str) {
        let draft = styk_doc::json::parse(text.as_bytes()).unwrap();
        editor.report.make_obj().unwrap().get_mut("_styk").unwrap().make_obj().unwrap().set("simpleFrameDraft", draft);
    }

    fn frame_id(editor: &Editor) -> String {
        editor.report.path(&["keyframes"]).and_then(|frames| frames.item(0)).and_then(|frame| frame.path(&["_styk", "frameId"]).and_then(Value::as_str).map(str::to_string)).unwrap()
    }

    #[test]
    fn with_no_working_frame_it_ends_what_is_open_and_says_so() {
        let mut editor = editor();
        editor.call("beginDrag", &[]).unwrap();
        editor.call("moveSelection", &[Value::Num(10.0), Value::Num(0.0)]).unwrap();
        assert_eq!(editor.call("disableFrameDrafts", &[]).unwrap(), Value::Bool(false));
        assert!(editor.drag.is_none() && editor.state().can_undo, "the gesture was committed");
        let events = editor.take_events();
        assert_eq!(events.last().and_then(|event| event.get("kind")).and_then(Value::as_str), Some("frame-draft"));
        assert_eq!(editor.call("endFrameDraftPreview", &[]).unwrap(), Value::Bool(false));
        assert_eq!(editor.call("beginFrameDraftPreview", &[]).unwrap(), Value::Bool(false));
    }

    #[test]
    fn a_saved_update_draft_is_dropped_and_its_frame_shown() {
        let mut editor = editor();
        let id = frame_id(&editor);
        draft(&mut editor, &format!(r#"{{"version":1,"mode":"update","index":0,"frameId":"{id}"}}"#));
        assert_eq!(editor.call("disableFrameDrafts", &[]).unwrap(), Value::Bool(false));
        assert!(editor.report.path(&["_styk", "simpleFrameDraft"]).is_none());
        assert_eq!((editor.frame_index, editor.tick), (0, 0.0));
    }

    #[test]
    fn what_it_cannot_convert_is_refused_before_anything_changes() {
        let mut editor = editor();
        let id = frame_id(&editor);
        draft(&mut editor, &format!(r#"{{"version":1,"mode":"add","index":0,"frameId":"{id}","baseline":{{}}}}"#));
        assert!(matches!(editor.call("disableFrameDrafts", &[]), Err(EditError::Unported(_))));
        assert!(editor.report.path(&["_styk", "simpleFrameDraft"]).is_some(), "the draft is kept");
        draft(&mut editor, r#"{"version":1,"mode":"update","index":9,"frameId":"nope"}"#);
        assert!(matches!(editor.call("disableFrameDrafts", &[]), Err(EditError::Invalid(key)) if key == "errors.editorFrameDraft.invalidSimpleTimelineWorkingFrame"));
        for method in ["enableFrameDrafts", "beginFrameDraft", "commitFrameDraft", "discardFrameDraft", "updateDraftFrame", "addDraftFrame"] {
            assert!(matches!(editor.call(method, &[]), Err(EditError::Unported(why)) if why == "working frames are not edited by the engine"), "{method}");
        }
    }
}
