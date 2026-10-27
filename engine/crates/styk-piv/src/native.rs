//! StykAnimate's own documents (`.styk`, `.stkz`, `.stykmov`, `.json`).
//!
//! Their container format is not this crate's: the service reaches it through
//! [`NativeDocuments`]. [`Containers`] is the implementation backed by
//! `styk-formats`. What stays here is what the Python *service* did around the
//! container: unwrap the early project wrapper, check the shape of figure
//! files, and build the document a save writes.

use std::sync::Arc;

use styk_doc::Value;

use crate::error::{PyResult, api, type_error, value_error};
use crate::py::{self, HKey};

/// Why a native container could not be read or written. The service reports
/// the text as a `422 invalid_project`, as it did for `native_format`'s `ValueError`s.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeError {
    /// What failed, in the words the Python service used where it had them.
    pub message: String,
}

impl std::fmt::Display for NativeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for NativeError {}

/// Reads and writes StykAnimate containers for the codec service.
///
/// The service owns everything around these two calls: size limits, the source
/// cache, document validation and the response. An implementation only turns
/// bytes into a document tree and back.
pub trait NativeDocuments {
    /// The document stored in a `.styk`, `.stkz`, `.stykmov` or plain `.json`
    /// file (`native_format.decode` followed by JSON parsing). `filename` is
    /// the sanitized upload name; its extension says which container to expect.
    fn decode(&self, bytes: &[u8], filename: &str) -> Result<Value, NativeError>;

    /// The container of `kind` (`"styk"`, `"stkz"` or `"stykmov"`) holding
    /// `document` (`native_format.encode_v2`). `reserved` are payloads to store
    /// first in the payload section: the save path passes the original Pivot
    /// source there, where the app has always stored it.
    fn encode(&self, document: &Value, kind: &str, reserved: &[Arc<[u8]>]) -> Result<Vec<u8>, NativeError>;
}

/// [`NativeDocuments`] over `styk-formats`.
#[cfg(feature = "containers")]
#[derive(Clone, Copy, Debug, Default)]
pub struct Containers;

#[cfg(feature = "containers")]
mod containers {
    use super::*;
    use styk_formats::container::{self, ContainerError, Kind};

    /// The text `backend/native_format.py` raised for the same failure.
    fn message(error: &ContainerError) -> String {
        use ContainerError::*;
        match error {
            FileTooLarge { .. } => "The native file exceeds the compressed size limit.",
            Truncated(_) => "The StykAnimate file is truncated or has an invalid header.",
            WrongMagic { .. } => "The StykAnimate file type does not match its extension.",
            Unsupported(_) => "Unsupported StykAnimate file version. Update the app to open this file.",
            DeclaredTooLarge { .. } | MaterializedTooLarge | DocumentTooLarge(_) => "The native document exceeds the uncompressed size limit.",
            LengthMismatch(_) => "The StykAnimate file is truncated or has trailing data.",
            UnknownSectionKind { .. } => "The StykAnimate file has an unknown section kind.",
            SectionBounds { .. } => "The StykAnimate file is truncated or has an invalid section table.",
            PayloadLength { .. } => "The StykAnimate file is damaged (invalid payload length).",
            Checksum { .. } => "The StykAnimate file is damaged (checksum mismatch).",
            InvalidArraySection { .. } => "The StykAnimate file is damaged (invalid array section reference).",
            InvalidPayloadSection { .. } => "The StykAnimate file is damaged (invalid payload section reference).",
            MalformedMarker { .. } => "The StykAnimate file is damaged (malformed section marker).",
            NonFinite { .. } => "The StykAnimate document contains non-finite numbers.",
            Json(_) => return error.to_string(),
        }
        .to_string()
    }

    fn kind_of(name: &str) -> Option<Kind> {
        Kind::from_extension(name.rsplit('.').next().unwrap_or(""))
    }

    impl NativeDocuments for Containers {
        fn decode(&self, bytes: &[u8], filename: &str) -> Result<Value, NativeError> {
            let kind = kind_of(filename).ok_or_else(|| NativeError { message: "Unknown StykAnimate file kind.".to_string() })?;
            match container::decode(bytes, kind) {
                Ok(decoded) => Ok(decoded.document),
                Err(ContainerError::Json(error)) => {
                    // A plain JSON project: say what Python's parser said about the text.
                    let start = bytes.iter().position(|b| !matches!(b, 0xef | 0xbb | 0xbf)).unwrap_or(bytes.len());
                    let plain = bytes.iter().find(|b| !matches!(b, 0xef | 0xbb | 0xbf | b' ' | b'\t' | b'\r' | b'\n')) == Some(&b'{');
                    let message = match plain.then(|| crate::pyjson::diagnose(&bytes[start..])).flatten() {
                        Some(python) => python.msg,
                        None => ContainerError::Json(error).to_string(),
                    };
                    Err(NativeError { message })
                }
                Err(error) => Err(NativeError { message: message(&error) }),
            }
        }

        fn encode(&self, document: &Value, kind: &str, reserved: &[Arc<[u8]>]) -> Result<Vec<u8>, NativeError> {
            let kind = Kind::from_extension(kind).ok_or_else(|| NativeError { message: "Unknown StykAnimate file kind.".to_string() })?;
            let lifted = container::lift(document, reserved).map_err(|error| NativeError { message: message(&error) })?;
            container::encode_v2(&lifted, kind).map_err(|error| NativeError { message: message(&error) })
        }
    }
}

pub(crate) fn native_error(error: NativeError) -> Box<crate::error::PyErr> {
    value_error(error.message)
}

/// The early web save wrapper `{format: "stykanimate", version: 1, document}`
/// (`ProjectStore.import_bytes`): returns the document it wraps.
pub(crate) fn unwrap_early_wrapper(document: Value) -> PyResult<Value> {
    let Some(wrapper) = document.as_obj() else { return Ok(document) };
    if wrapper.get("format").and_then(Value::as_str) != Some("stykanimate") {
        return Ok(document);
    }
    let version_ok = wrapper.get("version").is_some_and(|v| py::eq(v, &Value::Num(1.0)));
    let inner = wrapper.get("document").filter(|inner| inner.is_object());
    let (true, Some(inner)) = (version_ok, inner) else {
        return Err(api(422, "invalid_native_version", "Unsupported StykAnimate project version."));
    };
    let mut inner = inner.clone();
    if let Some(source) = wrapper.get("_stykSource").filter(|source| py::truthy(source))
        && !inner.as_obj().is_some_and(|object| object.contains("_stykSource"))
        && let Some(object) = inner.make_obj()
    {
        object.set("_stykSource", source.clone());
    }
    Ok(inner)
}

/// `server.validate_native_figure`: a `.stkz`/`.stykmov` document holds
/// reusable figures and exactly one pose of them, and nothing else.
pub(crate) fn validate_native_figure(document: &Value, kind: &str) -> PyResult<()> {
    let shape_error = || api(422, "invalid_native_figure", &format!("A .{kind} file must contain reusable figures and one pose."));
    let dicts = |value: Option<&Value>| -> Option<Vec<Value>> {
        let items = value?.as_arr()?;
        (!items.is_empty() && items.iter().all(Value::is_object)).then(|| items.to_vec())
    };
    let figures = dicts(py::get(document, "figure_types")?).ok_or_else(shape_error)?;
    let frames = py::get(document, "keyframes")?.filter(|f| py::is_list(f) && f.array_len() == Some(1)).and_then(|f| f.item(0)).filter(Value::is_object).ok_or_else(shape_error)?;
    let objects = dicts(frames.get("objects")).ok_or_else(shape_error)?;
    let mut figure_ids: Vec<HKey> = Vec::with_capacity(figures.len());
    for figure in &figures {
        figure_ids.push(py::hkey(figure.get("figure_type_id").unwrap_or(&Value::Null))?);
    }
    let contained = api(422, "invalid_native_figure", &format!("The .{kind} figure must be self-contained."));
    let empty = Value::object(styk_doc::Obj::new());
    let metadata = py::get(document, "_styk")?.unwrap_or(&empty);
    if !metadata.is_object() {
        return Err(contained);
    }
    for object in &objects {
        if !figure_ids.contains(&py::hkey(object.get("figure_type_id").unwrap_or(&Value::Null))?) {
            return Err(contained);
        }
    }
    if py::truthy_opt(py::get(document, "backgrounds")?) || ["animation", "simpleFrameDraft", "layerSheet"].iter().any(|key| py::truthy_opt(metadata.get(key))) {
        return Err(contained);
    }
    for pose in &objects {
        let Some(join) = pose.get("join").filter(|join| !join.is_null()) else { continue };
        let slot = join.as_obj().and_then(|j| j.get("target_object_slot")).filter(|slot| py::is_int(slot)).and_then(py::as_int);
        if !slot.is_some_and(|slot| 0 <= slot && (slot as usize) < objects.len()) {
            return Err(api(422, "invalid_native_figure", "Figure set joins must stay inside the saved set."));
        }
    }
    if kind == "stykmov" {
        let joined = objects[0].get("join").is_some_and(|join| !join.is_null());
        let clip = match figures[0].get("_styk") {
            None => false,
            Some(meta) => py::truthy_opt(py::get(meta, "movieclip")?),
        };
        if figures.len() != 1 || objects.len() != 1 || joined || !clip {
            return Err(api(422, "invalid_movieclip", "A .stykmov file must contain one movieclip."));
        }
    }
    Ok(())
}

/// `{**document.get("_styk", {}), "format": "StykAnimate", "format_version": 1}`.
pub(crate) fn saved_metadata(document: &Value) -> PyResult<Value> {
    let mut metadata = match py::get(document, "_styk")? {
        None => styk_doc::Obj::new(),
        Some(Value::Obj(object)) => (**object).clone(),
        Some(other) => return Err(type_error(format!("'{}' object is not a mapping", py::type_name(other)))),
    };
    metadata.set("format", Value::str("StykAnimate"));
    metadata.set("format_version", Value::Num(1.0));
    Ok(Value::object(metadata))
}
