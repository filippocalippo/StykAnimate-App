//! Rules every reader applies to a decoded native document.

use std::sync::Arc;

use styk_doc::{Obj, Value};

use crate::Kind;

/// Why a decoded document is not an acceptable project or figure file.
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum NativeError {
    #[error("the project wrapper has an unsupported version")]
    WrapperVersion,
    #[error("project data must be a JSON object")]
    NotAnObject,
    #[error("a .{0} file must contain reusable figures and one pose of them")]
    FigureShape(&'static str),
    #[error("the figure in a .{0} file must be self-contained (no backgrounds, animation or layer sheet)")]
    FigureNotSelfContained(&'static str),
    #[error("a figure set's joins must stay inside the saved figures")]
    FigureJoins,
    #[error("a .stykmov file must contain exactly one movieclip")]
    Movieclip,
    #[error("the embedded original source is not valid")]
    SourceInvalid,
    #[error("the embedded original source is corrupted")]
    SourceCorrupted,
    #[error("the embedded original source does not match its recorded fingerprint")]
    SourceFingerprint,
}

impl NativeError {
    /// The interface's message for this error.
    pub fn message_key(&self) -> &'static str {
        match self {
            NativeError::WrapperVersion => "errors.nativeContainer.unsupportedStykanimateProjectVersion",
            NativeError::NotAnObject => "errors.nativeContainer.projectDataMustBeAJsonObject",
            NativeError::FigureShape(_) => "errors.nativeContainer.aFileMustContainReusableFiguresAndOne",
            NativeError::FigureNotSelfContained(_) => "errors.nativeContainer.theFigureMustBeSelfContained",
            NativeError::FigureJoins => "errors.nativeContainer.figureSetJoinsMustStayInsideTheSaved",
            NativeError::Movieclip => "errors.nativeContainer.aStykmovFileMustContainOneMovieclip",
            NativeError::SourceInvalid => "errors.nativeContainer.invalidEmbeddedOriginalSource",
            NativeError::SourceCorrupted => "errors.nativeContainer.corruptedEmbeddedOriginalSource",
            NativeError::SourceFingerprint => "errors.nativeContainer.embeddedOriginalSourceFingerprintDoesNotMatch",
        }
    }

    pub fn code(&self) -> Option<&'static str> {
        match self {
            NativeError::WrapperVersion => Some("invalid_native_version"),
            NativeError::NotAnObject => Some("invalid_document"),
            NativeError::FigureShape(_) | NativeError::FigureNotSelfContained(_) | NativeError::FigureJoins => Some("invalid_native_figure"),
            NativeError::Movieclip => Some("invalid_movieclip"),
            _ => None,
        }
    }
}

fn objects_of(value: Option<&Value>) -> Option<&[Value]> {
    let items = value?.as_arr()?;
    items.iter().all(|item| item.as_obj().is_some()).then_some(items)
}

/// The self-contained shape of `.stkz` and `.stykmov` documents: figure
/// definitions and one frame holding one pose of each saved instance.
pub fn validate_figure(document: &Value, kind: Kind) -> Result<(), NativeError> {
    let name = kind.name();
    let figures = objects_of(document.get("figure_types")).filter(|f| !f.is_empty()).ok_or(NativeError::FigureShape(name))?;
    let frames = document.get("keyframes").and_then(Value::as_arr).filter(|f| f.len() == 1 && f[0].as_obj().is_some()).ok_or(NativeError::FigureShape(name))?;
    let objects = objects_of(frames[0].get("objects")).filter(|o| !o.is_empty()).ok_or(NativeError::FigureShape(name))?;
    let meta = document.get("_styk");
    let meta_object = match meta {
        None => None,
        Some(Value::Obj(object)) => Some(object),
        // A missing, null, false, zero or empty `_styk` counts as none; anything else that is not an object is invalid.
        Some(other) if !other.truthy() => None,
        Some(_) => return Err(NativeError::FigureNotSelfContained(name)),
    };
    let known = |object: &Value| figures.iter().any(|figure| figure.get("figure_type_id") == object.get("figure_type_id"));
    let truthy = |object: Option<&Arc<Obj>>, key: &str| object.and_then(|o| o.get(key)).is_some_and(Value::truthy);
    if !objects.iter().all(known)
        || document.get("backgrounds").and_then(Value::array_len).is_some_and(|n| n > 0)
        || truthy(meta_object, "animation")
        || truthy(meta_object, "simpleFrameDraft")
        || truthy(meta_object, "layerSheet")
    {
        return Err(NativeError::FigureNotSelfContained(name));
    }
    for pose in objects {
        match pose.get("join") {
            None | Some(Value::Null) => {}
            Some(join) => {
                let slot = join.as_obj().and_then(|j| j.get("target_object_slot")).and_then(Value::as_f64);
                if !slot.is_some_and(|s| s.fract() == 0.0 && s >= 0.0 && (s as usize) < objects.len()) {
                    return Err(NativeError::FigureJoins);
                }
            }
        }
    }
    if kind == Kind::Stykmov {
        let joined = !matches!(objects[0].get("join"), None | Some(Value::Null));
        let movieclip = figures[0].path(&["_styk", "movieclip"]).is_some_and(Value::truthy);
        if figures.len() != 1 || objects.len() != 1 || joined || !movieclip {
            return Err(NativeError::Movieclip);
        }
    }
    Ok(())
}

/// What every reader does to a decoded document before the editor sees it: unwrap
/// the early `{format: "stykanimate", version: 1, document}` wrapper, check the
/// figure-file shape, and drop fields only older builds or the browser wrote.
pub fn normalize_decoded(document: Value, kind: Kind) -> Result<Value, NativeError> {
    let mut document = document;
    if kind == Kind::Styk && document.get("format").and_then(Value::as_str) == Some("stykanimate") {
        let inner = document.get("document").filter(|inner| inner.as_obj().is_some());
        match (document.get("version").and_then(Value::as_f64), inner) {
            (Some(1.0), Some(inner)) => document = inner.clone(),
            _ => return Err(NativeError::WrapperVersion),
        }
    }
    if document.as_obj().is_none() {
        return Err(NativeError::NotAnObject);
    }
    if kind != Kind::Styk {
        validate_figure(&document, kind)?;
    }
    let object = document.make_obj().expect("checked above");
    for key in ["editable_paths", "_codec", "_stykWeb"] {
        object.remove(key);
    }
    Ok(document)
}

/// Checks the embedded original Pivot source against its recorded fingerprint.
pub fn verify_embedded_source(document: &Value) -> Result<(), NativeError> {
    let Some(metadata) = document.get("_stykSource").filter(|m| m.truthy()) else { return Ok(()) };
    const LIMIT: usize = 256 * 1024 * 1024 * 4 / 3 + 8;
    let digest = match metadata.get("source_base64") {
        Some(Value::Blob(blob)) if blob.prefix.is_empty() => {
            if blob.text_len() > LIMIT {
                return Err(NativeError::SourceInvalid);
            }
            styk_doc::digest::sha256(&blob.bytes)
        }
        Some(Value::Str(text)) => {
            if text.len() > LIMIT {
                return Err(NativeError::SourceInvalid);
            }
            styk_doc::digest::sha256(&styk_doc::json::base64_strict(text).ok_or(NativeError::SourceCorrupted)?)
        }
        _ => return Err(NativeError::SourceInvalid),
    };
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    if metadata.get("sha256").and_then(Value::as_str) != Some(hex.as_str()) {
        return Err(NativeError::SourceFingerprint);
    }
    Ok(())
}
