//! Moving figures between layers and deleting a layer on a layer sheet (src/editor-layer-sheet.mjs
//! `sheetAssignFigures`, `sheetDeleteLayer`, src/editor-layers.mjs `assignFiguresToLayer`, `deleteLayer`):
//! planned by the sheet kernel in `layer_planning.rs`, which keeps every figure's poses where it moves,
//! and published as one history entry.

use styk_doc::Value;

use crate::layer_planning::{sheet_layer_plan, Request};
use crate::{EditError, Editor};

/// The most pose sources a move keeps while it samples (the planner's own bound is lower still).
const SOURCE_BYTES: usize = 128 * 1024 * 1024;

impl Editor {
    /// Plans a membership change against the document and publishes it. Nothing is planned on a document without
    /// a layer sheet (the app gives every document one).
    fn publish_sheet_layers(&mut self, method: &str, uids: &[u32], target: &str, deleted: Option<&str>) -> Result<bool, EditError> {
        if !self.sheet() {
            return Err(EditError::Unported(format!("{method} on a native timeline")));
        }
        self.finish_gesture()?;
        let prepared = self.prepared()?;
        let request = Request { uids, target_layer: target, deleted_layer: deleted, next_frame_identity: self.next_frame_identity, max_source_bytes: SOURCE_BYTES, focus: self.focus_lock.as_ref() };
        let plan = {
            let mut cache = self.eval.borrow_mut();
            sheet_layer_plan(&self.report, &prepared, &mut cache.loader, request, || Ok(()), |_| {}, || 0.0)?
        };
        match plan {
            Some(plan) => self.publish_sheet_migration(plan),
            None => Ok(false),
        }
    }

    /// `assignFiguresToLayer(uids, id)`: the figures belong to the layer from now on and keep every pose they had.
    pub(crate) fn assign_figures_to_layer(&mut self, uids: &Value, id: &Value) -> Result<bool, EditError> {
        let mut figures = Vec::new();
        for uid in uids.elements().map(|e| e.iter().collect::<Vec<_>>()).unwrap_or_default() {
            match uid.as_f64() {
                Some(uid) if uid.fract() == 0.0 && (0.0..=u32::MAX as f64).contains(&uid) => figures.push(uid as u32),
                _ => return Err(EditError::Invalid("errors.editorLayerAsync.chooseFiguresPresentInThisAnimation".into())),
            }
        }
        self.publish_sheet_layers("assignFiguresToLayer", &figures, id.as_str().unwrap_or(""), None)
    }

    /// `deleteLayer(id)`: the layer's figures move to the first other layer, with their poses, and the layer goes.
    pub(crate) fn delete_layer(&mut self, id: &Value, options: &Value) -> Result<bool, EditError> {
        if options.get("targetLayerId").is_some_and(|target| !target.is_null()) {
            return Err(EditError::Unported("deleting a layer into a layer of your choice".into()));
        }
        self.publish_sheet_layers("deleteLayer", &[], "", Some(id.as_str().unwrap_or("")))
    }
}
