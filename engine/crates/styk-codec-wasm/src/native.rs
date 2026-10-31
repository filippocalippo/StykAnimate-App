//! StykAnimate's own files (`.styk`, `.stkz`, `.stykmov`) for the app's workers.
//!
//! The import and library-preview workers load this module and call [`open_native_file`]
//! directly, beside the Pivot codec's [`crate::PivotCodec`] (`docs/engine/formats.md`).
//! The work is `styk_formats::files`; this is its binding: bytes in, bytes out, failures as a
//! [`NativeFailure`] that carries the interface's message key. The app writes its files
//! from the engine's document (`styk_engine::save`); [`save_native_document`] writes a
//! document given as JSON, for the tests and tools that make files to read.

use styk_formats::container::Kind;
use styk_formats::container;
use styk_formats::files::{self, FileError, NoStore, Rules};
use wasm_bindgen::prelude::*;

/// Why a file could not be opened or saved. `messageKey` names the interface's
/// message (`errors.nativeContainer.*`); `code` and `kind` are empty when the
/// failure has none.
#[wasm_bindgen]
pub struct NativeFailure {
    message_key: String,
    code: Option<String>,
    kind: Option<String>,
    detail: String,
}

#[wasm_bindgen]
impl NativeFailure {
    #[wasm_bindgen(getter, js_name = messageKey)]
    pub fn message_key(&self) -> String {
        self.message_key.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn code(&self) -> Option<String> {
        self.code.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn kind(&self) -> Option<String> {
        self.kind.clone()
    }

    /// What failed, in English, for logs.
    #[wasm_bindgen(getter)]
    pub fn detail(&self) -> String {
        self.detail.clone()
    }
}

impl From<FileError> for NativeFailure {
    fn from(error: FileError) -> Self {
        NativeFailure { message_key: error.message_key.to_string(), code: error.code.map(str::to_string), kind: error.kind.map(str::to_string), detail: error.detail }
    }
}

fn kind_named(name: &str) -> Result<Kind, NativeFailure> {
    Kind::from_extension(name).ok_or_else(|| {
        NativeFailure {
            message_key: "errors.nativeContainer.unsupportedStykanimateFileVersionUpdateTheAppTo".to_string(),
            code: None,
            kind: None,
            detail: format!("unknown file kind {name:?}"),
        }
    })
}

/// A file read into the interface's form: the skeleton's JSON text and the sections
/// its markers name, by index. Each `take…` moves its bytes out once.
#[wasm_bindgen]
pub struct OpenedFile {
    version: u8,
    markers: bool,
    materialized_bytes: usize,
    skeleton: Vec<u8>,
    sections: Vec<Vec<u8>>,
}

#[wasm_bindgen]
impl OpenedFile {
    /// `0` for a plain JSON project, otherwise the container version.
    #[wasm_bindgen(getter)]
    pub fn version(&self) -> u8 {
        self.version
    }

    /// Whether the skeleton holds markers that name ranges of the sections.
    #[wasm_bindgen(getter)]
    pub fn markers(&self) -> bool {
        self.markers
    }

    #[wasm_bindgen(getter, js_name = materializedBytes)]
    pub fn materialized_bytes(&self) -> f64 {
        self.materialized_bytes as f64
    }

    #[wasm_bindgen(js_name = takeSkeleton)]
    pub fn take_skeleton(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.skeleton)
    }

    #[wasm_bindgen(getter, js_name = sectionCount)]
    pub fn section_count(&self) -> usize {
        self.sections.len()
    }

    #[wasm_bindgen(js_name = takeSection)]
    pub fn take_section(&mut self, index: usize) -> Vec<u8> {
        self.sections.get_mut(index).map(std::mem::take).unwrap_or_default()
    }
}

/// Reads a `.styk`, `.stkz` or `.stykmov` file (or a plain JSON project).
/// `normalize` applies the document rules (early wrapper, figure-file shape,
/// browser fields); `verifySource` also checks the embedded original source.
#[wasm_bindgen(js_name = openNativeFile)]
pub fn open_native_file(bytes: &[u8], kind: &str, normalize: bool, verify_source: bool) -> Result<OpenedFile, NativeFailure> {
    let opened = files::open(bytes, kind_named(kind)?, Rules { normalize, verify_source })?;
    Ok(OpenedFile { version: opened.version, markers: opened.markers, materialized_bytes: opened.materialized_bytes, skeleton: opened.skeleton, sections: opened.sections })
}

/// A container written.
#[wasm_bindgen]
pub struct SavedFile {
    bytes: Vec<u8>,
    raw_bytes: usize,
}

#[wasm_bindgen]
impl SavedFile {
    /// The file, moved out.
    #[wasm_bindgen(js_name = takeBytes)]
    pub fn take_bytes(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.bytes)
    }

    /// The skeleton and both sections before compression.
    #[wasm_bindgen(getter, js_name = containerRawBytes)]
    pub fn container_raw_bytes(&self) -> f64 {
        self.raw_bytes as f64
    }
}

/// Writes a version 2 container of `kind` around the document `json` holds, lifted as the app's writer lifts a
/// document (`styk_formats::container::lift`). A `.stkz` or `.stykmov` must be the self-contained figure the file stores.
#[wasm_bindgen(js_name = saveNativeDocument)]
pub fn save_native_document(kind: &str, json: &[u8]) -> Result<SavedFile, NativeFailure> {
    let document = styk_doc::json::parse(json).map_err(|error| NativeFailure::from(FileError::from(container::ContainerError::from(error))))?;
    let lifted = container::lift(&document, &[]).map_err(|error| NativeFailure::from(FileError::from(error)))?;
    let saved = files::save(kind_named(kind)?, &lifted.skeleton, &lifted.arrays, &lifted.payloads, &mut NoStore)?;
    Ok(SavedFile { bytes: saved.bytes, raw_bytes: saved.stats.container_raw_bytes })
}
