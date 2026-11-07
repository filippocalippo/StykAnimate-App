//! The text tool's compiler and the fonts it reads (`docs/native/text-tool.md`).
//!
//! A text figure is vector outlines embedded in the figure, laid out one glyph per UTF-16 unit with no shaping, exactly
//! as `src/text-authoring.mjs` does today. This module reproduces that module's output bit for bit: the same command
//! sequences, the same float32 coordinates and the same JSON text, so a document saved with a figure compiled here has
//! the same bytes as one compiled by the JavaScript app. Nothing in it touches a toolkit.

mod cff;
mod compile;
mod embedded;
mod font;
mod job;
mod kerning;
mod names;
mod names_data;
mod options;
mod paint;
mod path;
mod reader;
mod truetype;

use styk_doc::Value;

pub use compile::{compile_text_figure, compile_text_figure_checked, path_bounds, svg_path, Bounds, CompiledPath, Glyph};
pub use embedded::{
    can_edit_text_figure, compile_embedded_text_figure, read_text_figure_options, replace_text_asset_figure,
    text_asset_for,
};
pub use font::{Font, MAX_FONT_BYTES};
pub use job::{
    Busy, BundledFonts, CancelToken, CompileOutcome, CompileRequest, FontInfo, FontSource, JobEvent, TextCompiler, TextJob,
    MAX_FACES, MAX_RETAINED_FONT_BYTES,
};
pub use options::{TextOptions, TextSettings, MAX_TEXT_LENGTH};
pub use path::PathCmd;

/// Why a font file was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FontError {
    /// Empty, or larger than [`MAX_FONT_BYTES`].
    Size,
    /// Not a TrueType or OpenType file opentype.js reads (collections and web fonts are not).
    Unsupported,
    /// A read outside the file: opentype.js's `RangeError`.
    Range,
    /// A table opentype.js requires is absent.
    Missing(&'static str),
    /// A table fails one of opentype.js's checks.
    Invalid(&'static str),
    /// A glyph index the font has no glyph for (a `TypeError` there).
    GlyphOutOfRange(usize),
}

impl std::fmt::Display for FontError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FontError::Size => f.write_str("the font file is empty or larger than 32 MiB"),
            FontError::Unsupported => f.write_str("not a TrueType or OpenType font"),
            FontError::Range => f.write_str("a read outside the font file"),
            FontError::Missing(table) => write!(f, "the font has no {table} table"),
            FontError::Invalid(what) => write!(f, "invalid font: {what}"),
            FontError::GlyphOutOfRange(gid) => write!(f, "the font has no glyph {gid}"),
        }
    }
}

impl std::error::Error for FontError {}

/// A failure of the text tool. The localized sentence is the interface's: this carries the message key and its
/// parameters, the same `messageKey` and `messageParams` the JavaScript errors carry.
#[derive(Debug, Clone, PartialEq)]
pub enum TextError {
    Message { key: &'static str, params: Vec<(&'static str, Value)> },
    /// Imported text without the glyphs the new text needs (`MissingTextGlyphsError`).
    MissingGlyphs { missing: Vec<String>, family: String },
    Font(FontError),
    /// The compile was cancelled before it finished.
    Cancelled,
}

impl TextError {
    pub(crate) fn key(key: &'static str) -> TextError {
        TextError::Message { key, params: Vec::new() }
    }
    pub(crate) fn with(key: &'static str, params: Vec<(&'static str, Value)>) -> TextError {
        TextError::Message { key, params }
    }
}

impl From<FontError> for TextError {
    fn from(error: FontError) -> TextError {
        TextError::Font(error)
    }
}

impl std::fmt::Display for TextError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TextError::Message { key, .. } => f.write_str(key),
            TextError::MissingGlyphs { missing, family } => {
                write!(f, "Choose a font to add {}: the file only includes the characters used by {family}", missing.join(", "))
            }
            TextError::Font(error) => error.fmt(f),
            TextError::Cancelled => f.write_str("cancelled"),
        }
    }
}

impl std::error::Error for TextError {}
