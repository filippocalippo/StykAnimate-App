//! Live previews of the document fields the interface edits with a slider: a camera-motion clip's values and a layer's
//! parallax (`src/camera-motion-ui.mjs`). The field is set in the document as the pointer moves, without a history entry,
//! and put back by the next call that is not another preview; the call that commits the edit (`setCameraMotion`,
//! `setLayerParallax`) therefore records the field as it was, and a preview that is never committed leaves nothing.

use styk_doc::{Obj, Value};

use crate::{EditError, Editor};

/// The field a preview changed, as it was.
#[derive(Clone, Debug)]
pub(crate) enum Preview {
    CameraMotion(Option<Value>),
    Parallax { id: String, before: Option<Value> },
}

/// The calls a preview survives: the previews themselves and the ones that only move the view.
fn keeps_preview(method: &str) -> bool {
    method.starts_with('@')
        || matches!(
            method,
            "previewCameraMotion" | "previewLayerParallax" | "cancelDocumentPreview" | "select" | "selectMany" | "selectPolygon" | "toggleSegment"
                | "selectBranch" | "seek" | "setActiveLayer" | "selectSheetLayer" | "keepSelectionOnSeek"
        )
}

impl Editor {
    /// Before a call: an open preview is put back unless the call keeps it.
    pub(crate) fn end_preview_for(&mut self, method: &str) {
        if self.preview.is_some() && !keeps_preview(method) {
            self.restore_preview();
        }
    }

    /// Puts the previewed field back. Whether a preview was open.
    pub(crate) fn restore_preview(&mut self) -> bool {
        let Some(preview) = self.preview.take() else { return false };
        match preview {
            Preview::CameraMotion(before) => {
                if let Some(styk) = self.report.make_obj().and_then(|report| report.get_mut("_styk")).and_then(Value::make_obj) {
                    match before {
                        Some(before) => styk.set("cameraMotion", before),
                        None => {
                            styk.remove("cameraMotion");
                        }
                    }
                }
            }
            Preview::Parallax { id, before } => {
                if let Some(layer) = self.layer_record_mut(&id) {
                    match before {
                        Some(before) => layer.set("parallax", before),
                        None => {
                            layer.remove("parallax");
                        }
                    }
                }
                self.layer_revision += 1;
                self.layer_event_pending = true;
            }
        }
        true
    }

    fn layer_record_mut(&mut self, id: &str) -> Option<&mut Obj> {
        self.report.make_obj()?.get_mut("_styk")?.make_obj()?.get_mut("layers")?.make_obj()?.get_mut("byId")?.make_obj()?.get_mut(id)?.make_obj()
    }

    /// `previewCameraMotion(id, patch)`: what `setCameraMotion(id, patch)` would make of the clip, shown without recording it.
    pub(crate) fn preview_camera_motion(&mut self, id: &Value, patch: &Value) -> Result<bool, EditError> {
        self.restore_preview();
        let list = self.camera_motion_after(self.camera_clips(), id, patch)?;
        let mut table = Obj::new();
        table.set("version", Value::Num(1.0));
        table.set("clips", Value::array(list));
        let next = Value::object(table);
        crate::camera_motion::validate(&next)?;
        let before = self.report.path(&["_styk", "cameraMotion"]).cloned();
        if let Some(styk) = self.report.make_obj().and_then(|report| report.get_mut("_styk")).and_then(Value::make_obj) {
            styk.set("cameraMotion", next);
        }
        self.preview = Some(Preview::CameraMotion(before));
        self.emit("edit", vec![("live", Value::Bool(true)), ("camera", Value::Bool(true)), ("cameraMotion", Value::Bool(true))]);
        Ok(true)
    }

    /// `previewLayerParallax(id, patch)`: what `setLayerParallax(id, patch)` would make of the layer's response.
    pub(crate) fn preview_layer_parallax(&mut self, id: &Value, patch: &Value) -> Result<bool, EditError> {
        self.restore_preview();
        let (id, parallax) = self.parallax_after(id, patch)?;
        let before = self.report.path(&["_styk", "layers", "byId", &id, "parallax"]).cloned();
        if let Some(layer) = self.layer_record_mut(&id) {
            layer.set("parallax", parallax);
        }
        self.preview = Some(Preview::Parallax { id, before });
        self.layer_revision += 1;
        self.layer_event_pending = true;
        self.emit("edit", vec![("live", Value::Bool(true)), ("parallax", Value::Bool(true))]);
        Ok(true)
    }

    /// `cancelDocumentPreview()`: the previewed field as it was. Whether a preview was open.
    pub(crate) fn cancel_document_preview(&mut self) -> bool {
        let was = self.restore_preview();
        if was {
            self.emit("edit", vec![("live", Value::Bool(true)), ("camera", Value::Bool(true))]);
        }
        was
    }
}
