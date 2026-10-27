//! What the interface's file workers ask of a native file.
//!
//! The editor's document is a JavaScript object, so a file reaches it, and leaves
//! it, in the form the document store shares with the interface (`container::lift`):
//! a JSON skeleton whose large number arrays and images are markers into two byte
//! sections. [`open`] reads a container into that form and applies the document
//! rules; [`save`] writes the skeleton and sections the interface lifted from its
//! document as a version 2 container. Both run inside the codec module of the
//! app's workers (`styk-codec-wasm`), and neither keeps any state: the caller
//! owns the cache of compressed blocks.

use styk_doc::json;

use crate::container::{self, ContainerError, Kind, encode_v2_with, pack_zstd};
use crate::native::{self, NativeError};

/// Why a file could not be opened or saved: the interface's message for it
/// (`errors.nativeContainer.*`), the machine code callers branch on, and the
/// file kind some messages name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileError {
    pub message_key: &'static str,
    pub code: Option<&'static str>,
    /// The `kind` parameter of the message (`stkz`, `stykmov`), where it has one.
    pub kind: Option<&'static str>,
    /// What failed and where, in English, for logs.
    pub detail: String,
}

impl std::fmt::Display for FileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.detail)
    }
}

impl std::error::Error for FileError {}

impl From<ContainerError> for FileError {
    fn from(error: ContainerError) -> Self {
        FileError { message_key: error.message_key(), code: error.code(), kind: None, detail: error.to_string() }
    }
}

impl From<NativeError> for FileError {
    fn from(error: NativeError) -> Self {
        let kind = match error {
            NativeError::FigureShape(kind) | NativeError::FigureNotSelfContained(kind) => Some(kind),
            _ => None,
        };
        FileError { message_key: error.message_key(), code: error.code(), kind, detail: error.to_string() }
    }
}

/// Which document rules [`open`] applies after decoding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rules {
    /// Unwrap the early project wrapper, check the figure-file shape and drop fields
    /// only older builds or the browser wrote (`native::normalize_decoded`).
    pub normalize: bool,
    /// Check the embedded original source against its fingerprint (`native::verify_embedded_source`).
    /// Only meaningful with `normalize`.
    pub verify_source: bool,
}

impl Rules {
    /// The container as stored, with no document rules.
    pub const RAW: Rules = Rules { normalize: false, verify_source: false };
    /// What opening a project does.
    pub const PROJECT: Rules = Rules { normalize: true, verify_source: true };
    /// What a preview does: the document rules, without reading the embedded source.
    pub const PREVIEW: Rules = Rules { normalize: true, verify_source: false };
}

/// An opened file in the interface's form.
pub struct Opened {
    /// `0` for a plain JSON project, otherwise the container version.
    pub version: u8,
    /// An upper bound of the JSON the document stands for, as the importer reports it.
    pub materialized_bytes: usize,
    /// The skeleton's JSON text. Markers in it name ranges of `sections`; arrays and images
    /// shared in the file are shared in the skeleton: one marker names them wherever they occur.
    pub skeleton: Vec<u8>,
    /// Whether the skeleton holds markers. A plain JSON project or a version 1 file handed over
    /// as stored is the document itself, and a string in it that looks like a marker is a string.
    pub markers: bool,
    /// The sections the markers name, by the index they use.
    pub sections: Vec<Vec<u8>>,
}

/// Reads a `.styk`, `.stkz` or `.stykmov` file (or a plain JSON project) and puts
/// the document it holds in the interface's form.
///
/// A project whose document the rules leave as it is (nearly every one) is checked by a scan of its
/// skeleton and handed over as the file stores it: no tree is built, and nothing is written again.
/// A document the rules rewrite, a figure file (small, and its shape needs the tree) and one too
/// large to admit without measuring are decoded into the store and lifted from it.
pub fn open(bytes: &[u8], kind: Kind, rules: Rules) -> Result<Opened, FileError> {
    let checked = container::check(bytes, kind)?;
    if checked.within_limit && keeps_document(&checked, kind, rules)? {
        let container::Checked { parts, .. } = checked;
        let materialized_bytes = parts.skeleton.len() + 3 * parts.sections.iter().map(|(_, bytes)| bytes.len()).sum::<usize>();
        return Ok(Opened { version: parts.version, materialized_bytes, skeleton: parts.skeleton, markers: parts.version >= 2, sections: parts.sections.into_iter().map(|(_, bytes)| bytes).collect() });
    }
    drop(checked);
    let decoded = container::decode(bytes, kind)?;
    let mut document = decoded.document;
    if rules.normalize {
        document = native::normalize_decoded(document, kind)?;
        if rules.verify_source {
            native::verify_embedded_source(&document)?;
        }
    }
    let lifted = container::lift(&document, &[])?;
    let materialized_bytes = lifted.skeleton.len() + 3 * (lifted.arrays.len() + lifted.payloads.len());
    Ok(Opened { version: decoded.version, materialized_bytes, skeleton: lifted.skeleton, markers: true, sections: vec![lifted.arrays, lifted.payloads] })
}

/// Reads a project file into the document store: the container, the document rules and the embedded
/// source's fingerprint, as [`open`] applies them for a project (`Rules::PROJECT`), but as a tree the
/// caller keeps rather than as the interface's lifted form.
pub fn open_document(bytes: &[u8], kind: Kind) -> Result<styk_doc::Value, FileError> {
    let decoded = container::decode(bytes, kind)?;
    let document = native::normalize_decoded(decoded.document, kind)?;
    native::verify_embedded_source(&document)?;
    Ok(document)
}

/// Whether the rules leave a checked document exactly as it is stored, verifying what they verify.
/// `false` sends it down the path that builds the document.
fn keeps_document(checked: &container::Checked, kind: Kind, rules: Rules) -> Result<bool, FileError> {
    if !rules.normalize {
        return Ok(true);
    }
    // A figure file's shape is checked on the tree; a root that is not an object is the tree's error to report.
    let (Kind::Styk, Some(members)) = (kind, &checked.members) else { return Ok(false) };
    let last = |key: &str| members.iter().rev().find(|member| member.key == key);
    if ["editable_paths", "_codec", "_stykWeb"].iter().any(|key| last(key).is_some()) {
        return Ok(false);
    }
    if let Some(format) = last("format")
        && container::member_value(checked, format)?.as_str() == Some("stykanimate")
    {
        return Ok(false);
    }
    if rules.verify_source
        && let Some(source) = last("_stykSource")
    {
        let mut document = styk_doc::Obj::new();
        document.set("_stykSource", container::member_value(checked, source)?);
        native::verify_embedded_source(&styk_doc::Value::object(document))?;
    }
    Ok(true)
}

/// Where [`save`] looks for the compressed form of a block it compresses again,
/// and where it leaves the ones it compressed. Keys name the block's codec,
/// level, length and SHA-256, so a hit is the same bytes.
pub trait BlockStore {
    fn get(&mut self, key: &str) -> Option<Vec<u8>>;
    fn put(&mut self, key: &str, stored: &[u8]);
}

/// A store that keeps nothing.
pub struct NoStore;

impl BlockStore for NoStore {
    fn get(&mut self, _key: &str) -> Option<Vec<u8>> {
        None
    }
    fn put(&mut self, _key: &str, _stored: &[u8]) {}
}

/// What a save reused.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SaveStats {
    pub hits: u32,
    pub misses: u32,
    pub raw_bytes_reused: usize,
    pub compressed_bytes_reused: usize,
    /// The skeleton and both sections before compression.
    pub container_raw_bytes: usize,
}

pub struct Saved {
    pub bytes: Vec<u8>,
    pub stats: SaveStats,
}

fn hex(digest: &[u8; 32]) -> String {
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Writes a version 2 container of `kind` around a lifted document. A `.stkz` or
/// `.stykmov` skeleton must be the self-contained figure the file stores
/// (`native::validate_figure`). The caller's `store` supplies the compressed form
/// of blocks it has compressed before.
pub fn save(kind: Kind, skeleton: &[u8], arrays: &[u8], payloads: &[u8], store: &mut dyn BlockStore) -> Result<Saved, FileError> {
    if kind != Kind::Styk {
        native::validate_figure(&json::parse(skeleton).map_err(ContainerError::from)?, kind)?;
    }
    let mut stats = SaveStats { container_raw_bytes: skeleton.len() + arrays.len() + payloads.len(), ..SaveStats::default() };
    let bytes = encode_v2_with(skeleton, arrays, payloads, kind, &mut |raw, digest| {
        let key = format!("2:3:{}:{}", raw.len(), hex(digest));
        if let Some(stored) = store.get(&key) {
            stats.hits += 1;
            stats.raw_bytes_reused += raw.len();
            stats.compressed_bytes_reused += stored.len();
            return stored;
        }
        stats.misses += 1;
        let stored = pack_zstd(raw);
        store.put(&key, &stored);
        stored
    })
    .map_err(|error| FileError { code: Some("document_too_large"), ..FileError::from(error) })?;
    Ok(Saved { bytes, stats })
}
