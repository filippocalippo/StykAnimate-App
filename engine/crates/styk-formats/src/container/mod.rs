//! The StykAnimate container (`docs/native-file-format.md`).
//!
//! ```text
//! version 1:  header(56) | zlib(JSON document)
//! version 2:  header(56) | section count u32 | compressed JSON skeleton
//!             | count × section record(64) | compressed section payloads
//! ```
//!
//! In version 2 the skeleton holds marker strings where large values were moved
//! into sections: `S2B:<type>:<section>:<offset>:<count>` (a packed numeric
//! array), `S2S:<section>:<offset>:<count>` (base64 of raw bytes),
//! `S2D:<section>:<offset>:<count>:<prefix>` (a data URL with raw payload) and
//! `S2E:<rest>` (a literal string that looks like a marker).
//!
//! [`decode`] reads every form into a document tree; [`lift`] and [`encode_v2`]
//! write one. The writer makes the choices the JavaScript writer made (which
//! values move, in which order, with which numeric type), so a document that
//! did not change is written back to the same skeleton and section bytes.

mod read;
mod write;


pub use read::{Checked, Decoded, Parts, check, decode, decode_parts, member_value, parse_lifted, parse_lifted_owned, parse_lifted_owned_within, parse_lifted_owned_admitted_within, LiftedAdmitted};
pub use write::{Lifted, ViewLifter, ViewPart, encode_v1, encode_v2, encode_v2_with, lift, lift_within};

pub(crate) const HEADER: usize = 56;
pub(crate) const SECTION: usize = 64;
/// Limit of the compressed file and of each uncompressed section.
pub const MAX_BYTES: usize = 256 * 1024 * 1024;
/// Limit of the uncompressed JSON skeleton.
pub const MAX_SKELETON_BYTES: usize = 384 * 1024 * 1024;
/// Limit of the JSON a document stands for once every marker is expanded.
pub const MAX_MATERIALIZED_BYTES: usize = MAX_BYTES * 4;
/// Arrays shorter than this stay in the skeleton.
pub(crate) const LIFT_MIN_ARRAY: usize = 32;
/// Strings shorter than this (in UTF-16 units) stay in the skeleton.
pub(crate) const LIFT_MIN_STRING: usize = styk_doc::payload::MIN_LEN;
/// An upper bound of one number's JSON text.
pub(crate) const MAX_JSON_NUMBER_BYTES: usize = 32;

/// Which file a container is. The magic and the document rules differ.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// `.styk`, a project.
    Styk,
    /// `.stkz`, one figure (or a joined set) at one pose.
    Stkz,
    /// `.stykmov`, one movieclip.
    Stykmov,
}

impl Kind {
    pub fn from_extension(extension: &str) -> Option<Kind> {
        match extension.to_ascii_lowercase().as_str() {
            "styk" | "json" => Some(Kind::Styk),
            "stkz" => Some(Kind::Stkz),
            "stykmov" => Some(Kind::Stykmov),
            _ => None,
        }
    }

    pub fn magic(self) -> &'static [u8; 4] {
        match self {
            Kind::Styk => b"STYK",
            Kind::Stkz => b"STKZ",
            Kind::Stykmov => b"STMV",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Kind::Styk => "styk",
            Kind::Stkz => "stkz",
            Kind::Stykmov => "stykmov",
        }
    }
}

/// How a block is stored.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Codec {
    Stored = 0,
    Zlib = 1,
    Zstd = 2,
}

impl Codec {
    pub(crate) fn from_byte(byte: u8) -> Option<Codec> {
        match byte {
            0 => Some(Codec::Stored),
            1 => Some(Codec::Zlib),
            2 => Some(Codec::Zstd),
            _ => None,
        }
    }
}

/// Why a container could not be read or written.
///
/// [`ContainerError::message_key`] is the interface's message for it (the same
/// keys the JavaScript codec used), [`ContainerError::code`] the machine code
/// callers branch on; `Display` says what failed and where, for logs.
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum ContainerError {
    #[error("the file is {size} bytes, over the {MAX_BYTES} byte limit of a compressed file")]
    FileTooLarge { size: usize },
    #[error("the file is shorter than its header or section table ({0})")]
    Truncated(&'static str),
    #[error("the file starts with {found:?}, not the {expected:?} of a .{kind} file")]
    WrongMagic { found: [u8; 4], expected: &'static str, kind: &'static str },
    #[error("unsupported container: {0}")]
    Unsupported(&'static str),
    #[error("the {what} declares {size} uncompressed bytes, over its limit")]
    DeclaredTooLarge { what: &'static str, size: u64 },
    #[error("the file has {0}")]
    LengthMismatch(&'static str),
    #[error("section {index} has unknown kind {kind}")]
    UnknownSectionKind { index: usize, kind: u8 },
    #[error("section {index} does not fit the file ({what})")]
    SectionBounds { index: usize, what: &'static str },
    #[error("the {what} is damaged: its payload is not the declared length")]
    PayloadLength { what: String },
    #[error("the {what} is damaged: its checksum does not match")]
    Checksum { what: String },
    #[error("marker {marker:?} names an invalid numeric array range")]
    InvalidArraySection { marker: String },
    #[error("marker {marker:?} names an invalid payload range")]
    InvalidPayloadSection { marker: String },
    #[error("marker {marker:?} is malformed")]
    MalformedMarker { marker: String },
    #[error("a stored numeric array contains a value that is not finite ({marker:?})")]
    NonFinite { marker: String },
    #[error("the document expands to more than {MAX_MATERIALIZED_BYTES} bytes")]
    MaterializedTooLarge,
    #[error("the document is too large to store ({0})")]
    DocumentTooLarge(&'static str),
    #[error("the JSON document is invalid: {0}")]
    Json(#[from] styk_doc::JsonError),
}

impl ContainerError {
    /// The localized message of this error, under `errors.nativeContainer.` in the locale packs.
    pub fn message_key(&self) -> &'static str {
        use ContainerError::*;
        match self {
            FileTooLarge { .. } => "errors.nativeContainer.theNativeFileExceedsTheCompressedSizeLimit",
            Truncated(_) => "errors.nativeContainer.theStykanimateFileIsTruncatedOrHasAn",
            WrongMagic { .. } => "errors.nativeContainer.theStykanimateFileTypeDoesNotMatchIts",
            Unsupported(_) => "errors.nativeContainer.unsupportedStykanimateFileVersionUpdateTheAppTo",
            DeclaredTooLarge { .. } | MaterializedTooLarge => "errors.nativeContainer.theNativeDocumentExceedsTheUncompressedSizeLimit",
            LengthMismatch(_) => "errors.nativeContainer.theStykanimateFileIsTruncatedOrHasTrailing",
            UnknownSectionKind { .. } => "errors.nativeContainer.theStykanimateFileHasAnUnknownSectionKind",
            SectionBounds { .. } => "errors.nativeContainer.theStykanimateFileIsTruncatedOrHasAn2",
            PayloadLength { .. } => "errors.nativeContainer.theStykanimateFileIsDamagedInvalidPayloadLength",
            Checksum { .. } => "errors.nativeContainer.theStykanimateFileIsDamagedChecksumMismatch",
            InvalidArraySection { .. } => "errors.nativeContainer.theStykanimateFileIsDamagedInvalidArraySection",
            InvalidPayloadSection { .. } => "errors.nativeContainer.theStykanimateFileIsDamagedInvalidPayloadSection",
            MalformedMarker { .. } => "errors.nativeContainer.theStykanimateFileIsDamagedMalformedSectionMarker",
            NonFinite { .. } => "errors.nativeContainer.theStykanimateDocumentContainsNonFiniteNumbers",
            DocumentTooLarge(_) => "errors.nativeContainer.theStykanimateDocumentExceedsTheUncompressedSizeLimit",
            Json(_) => "errors.nativeContainer.projectDataMustBeAJsonObject",
        }
    }

    /// The machine code callers branch on, where the JavaScript codec set one.
    pub fn code(&self) -> Option<&'static str> {
        match self {
            ContainerError::DocumentTooLarge(_) => Some("document_too_large"),
            _ => None,
        }
    }
}

pub(crate) use styk_doc::digest::sha256;

/// Restores a stored block. The output is bounded by the declared length before
/// anything is allocated for it, and must match it exactly.
pub(crate) fn unpack(codec: Codec, stored: &[u8], raw_length: usize, what: &dyn Fn() -> String) -> Result<Vec<u8>, ContainerError> {
    let damaged = || ContainerError::PayloadLength { what: what() };
    match codec {
        Codec::Stored => {
            if stored.len() != raw_length {
                return Err(damaged());
            }
            Ok(stored.to_vec())
        }
        Codec::Zlib => {
            use std::io::Read;
            let mut out = Vec::with_capacity(raw_length);
            let mut decoder = flate2::read::ZlibDecoder::new(stored);
            // One byte past the declared length is enough to tell a longer stream apart.
            decoder.by_ref().take(raw_length as u64 + 1).read_to_end(&mut out).map_err(|_| damaged())?;
            // Trailing bytes after the stream are rejected, as the browser's decoder does.
            if out.len() != raw_length || decoder.total_in() != stored.len() as u64 {
                return Err(damaged());
            }
            Ok(out)
        }
        Codec::Zstd => {
            // A frame that states another size is refused before its output is allocated.
            if let Ok(Some(declared)) = zstd::zstd_safe::get_frame_content_size(stored)
                && declared != raw_length as u64
            {
                return Err(damaged());
            }
            let out = zstd::bulk::decompress(stored, raw_length).map_err(|_| damaged())?;
            if out.len() != raw_length {
                return Err(damaged());
            }
            Ok(out)
        }
    }
}

/// zstd at level 3 in one frame, as the app has always written sections.
pub(crate) fn pack_zstd(raw: &[u8]) -> Vec<u8> {
    zstd::bulk::compress(raw, 3).expect("in-memory zstd compression cannot fail")
}

pub(crate) fn pack_zlib(raw: &[u8]) -> Vec<u8> {
    use std::io::Write;
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(raw).expect("writing to memory cannot fail");
    encoder.finish().expect("writing to memory cannot fail")
}
