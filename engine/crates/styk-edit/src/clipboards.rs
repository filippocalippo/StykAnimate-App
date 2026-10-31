//! The clipboards as the interface holds them (`editor._sheetClipboard`, `_selectionClipboard`, `_cameraClipboard`, ...).
//!
//! The session keeps what the editor's copy commands copied, typed for the commands that paste it. The interface reads the
//! same clipboards (a Paste button that is enabled only after a copy, the shared clipboard that writes them to the system's)
//! and hands one from another window, tab or the system back: so a copy's answer carries the clipboard in the shape the
//! editor held it (`clipboard: {kind, data}`), and `@setClipboard(kind, data, foreign)` takes one the interface holds in its
//! place (`foreign`: it was copied in another document, so everything it pastes is new). `null` empties it.
//!
//! The drawing pixels the Draw tool copies are the interface's alone and never reach the session. An audio clip's recording
//! can be megabytes: a copy's answer only says that one was copied (the interface asks no more), and the recording moves to
//! another project's session when that one pastes it, read from the session that has it (`clipboard`, a read of the session).

use styk_doc::{Obj, Value};

use crate::{EditError, Editor};

/// The kind of clipboard a copy command fills.
pub(crate) fn copied_kind(method: &str) -> Option<&'static str> {
    Some(match method {
        "copySelection" | "cutSelection" => "figures",
        "sheetCopyFrames" => "sheet",
        "copyCameraMotion" => "cameraMotion",
        "copyCamera" => "camera",
        "copySegmentValues" => "segmentValues",
        "copyVfxClip" => "vfxClip",
        "copyAudioClip" | "cutAudioClip" => "audio",
        _ => return None,
    })
}

fn invalid() -> EditError {
    EditError::Invalid("errors.sharedClipboard.unsupportedClipboardType".into())
}

impl Editor {
    /// The clipboard of `kind` as the interface holds it, `None` where nothing is copied.
    pub(crate) fn clipboard_wire(&self, kind: &str) -> Option<Value> {
        match kind {
            "figures" => self.figure_clipboard.as_ref().map(|clipboard| clipboard.to_wire()),
            "sheet" => self.sheet_clipboard.as_ref().map(|clipboard| clipboard.to_wire()),
            "cameraMotion" => self.camera_motion_clipboard.clone(),
            "camera" => self.camera_clipboard.clone(),
            "segmentValues" => self.segment_values_clipboard.as_deref().map(Value::str),
            "vfxClip" => self.vfx_clip_clipboard.as_ref().map(|(clip, values)| {
                let mut wire = Obj::new();
                wire.set("clip", clip.clone());
                wire.set("values", values.clone().unwrap_or(Value::Null));
                Value::object(wire)
            }),
            "audio" => self.audio_clipboard.as_ref().map(|(clip, asset)| {
                let mut wire = Obj::new();
                wire.set("clip", clip.clone());
                wire.set("asset", asset.clone());
                Value::object(wire)
            }),
            _ => None,
        }
    }

    /// What a copy's answer carries of the clipboard of `kind`: all of it, but for an audio clip's recording (`null`).
    pub(crate) fn clipboard_answer(&self, kind: &str) -> Option<Value> {
        if kind == "audio" { self.audio_clipboard.is_some().then_some(Value::Null) } else { self.clipboard_wire(kind) }
    }

    /// `@setClipboard(kind, data, foreign)`: the interface hands the session the clipboard it holds (restored from another
    /// window or the system's clipboard, or copied in another tab).
    pub(crate) fn set_clipboard(&mut self, args: &[Value]) -> Result<Value, EditError> {
        let kind = args.first().and_then(Value::as_str).ok_or_else(invalid)?;
        let data = args.get(1).filter(|data| !data.is_null());
        let foreign = args.get(2).is_some_and(Value::truthy);
        let object = |data: &Value| data.is_object().then(|| data.clone()).ok_or_else(invalid);
        match kind {
            "figures" => self.figure_clipboard = data.map(|data| crate::figure_clipboard::FigureClipboard::from_wire(data, foreign)).transpose()?,
            "sheet" => self.sheet_clipboard = data.map(|data| crate::sheet_clipboard::Clipboard::from_wire(data, foreign)).transpose()?,
            "cameraMotion" => self.camera_motion_clipboard = data.map(object).transpose()?,
            "camera" => self.camera_clipboard = data.map(object).transpose()?,
            "segmentValues" => self.segment_values_clipboard = data.map(|data| data.as_str().map(str::to_string).ok_or_else(invalid)).transpose()?,
            "vfxClip" => {
                self.vfx_clip_clipboard = data
                    .map(|data| {
                        let clip = data.get("clip").filter(|clip| clip.is_object()).cloned().ok_or_else(invalid)?;
                        Ok::<_, EditError>((clip, data.get("values").filter(|values| !values.is_null()).cloned()))
                    })
                    .transpose()?;
            }
            "audio" => {
                self.audio_clipboard = data
                    .map(|data| {
                        let clip = data.get("clip").filter(|clip| clip.is_object()).cloned().ok_or_else(invalid)?;
                        Ok::<_, EditError>((clip, data.get("asset").cloned().unwrap_or(Value::Null)))
                    })
                    .transpose()?;
            }
            _ => return Err(invalid()),
        }
        Ok(Value::Null)
    }
}
