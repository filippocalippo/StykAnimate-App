//! Failures, classified the way the Python codec classified them.
//!
//! The Python service turned exceptions into responses by class
//! (`server.error_response`): its own `ApiError`s keep their status and code,
//! `ValueError`/`TypeError`/`KeyError`/`IndexError`/`struct.error` become
//! `422 invalid_project` with the exception text, and anything else is a
//! `500 codec_error` with a fixed text. Code in this crate that used to catch
//! "a `ValueError`" or "a `PivError`" asks [`PyErr::is`] the same question, so
//! the same failures are wrapped, rethrown or passed through.

use std::fmt;

/// The exception classes the codec raised, with Python's subclass relations
/// expressed in [`PyErr::is`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Exc {
    /// `server.ApiError` (a `ValueError`): carries its own status and code.
    Api,
    /// `jobs.JobError` (cancellation): carries its own status and code, not a `ValueError`.
    Job,
    /// `piv_codec.PivError` (a `ValueError`).
    Piv,
    /// `piv_codec.PivIdentityError` (a `PivError`).
    PivIdentity,
    /// `piv_side_tables.SideTableError` (a `ValueError`).
    SideTable,
    /// `piv_asset_writer.AssetWriteError` (a `SideTableError`).
    AssetWrite,
    /// `piv_legacy_v2.LegacyDecodeError` and plain `ValueError`s of the legacy readers.
    Value,
    Type,
    Key,
    Index,
    Attribute,
    Struct,
    Overflow,
    /// `zlib.error`: not a `ValueError`, so it ends as `500 codec_error` unless wrapped.
    Zlib,
    /// `RecursionError` and other failures the service reported as `codec_error`.
    Runtime,
}

/// The classes `except` clauses named.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Class {
    Piv,
    Value,
    Type,
    Key,
    Index,
    Attribute,
    Struct,
    Overflow,
}

/// One failure: its class, the text `str(exception)` gave, and, for service
/// errors, the HTTP status and machine code.
#[derive(Clone, Debug)]
pub(crate) struct PyErr {
    pub exc: Exc,
    pub msg: String,
    pub status: u16,
    pub code: &'static str,
}

pub(crate) type PyResult<T> = Result<T, Box<PyErr>>;

impl PyErr {
    fn new(exc: Exc, msg: impl Into<String>) -> Box<PyErr> {
        Box::new(PyErr { exc, msg: msg.into(), status: 0, code: "" })
    }

    /// Whether `except <class>` would catch this failure.
    pub fn is(&self, class: Class) -> bool {
        use Exc::*;
        match class {
            Class::Piv => matches!(self.exc, Piv | PivIdentity),
            Class::Value => matches!(self.exc, Api | Piv | PivIdentity | SideTable | AssetWrite | Value),
            Class::Type => self.exc == Type,
            Class::Key => self.exc == Key,
            Class::Index => self.exc == Index,
            Class::Attribute => self.exc == Attribute,
            Class::Struct => self.exc == Struct,
            Class::Overflow => self.exc == Overflow,
        }
    }

    pub fn is_any(&self, classes: &[Class]) -> bool {
        classes.iter().any(|&class| self.is(class))
    }
}

pub(crate) fn api(status: u16, code: &'static str, msg: &str) -> Box<PyErr> {
    Box::new(PyErr { exc: Exc::Api, msg: msg.to_string(), status, code })
}

/// What a cancelled request answers (`jobs.JobCancelled`).
pub(crate) fn cancelled() -> Box<PyErr> {
    Box::new(PyErr { exc: Exc::Job, msg: "The file operation was cancelled.".to_string(), status: 499, code: "cancelled" })
}

pub(crate) fn piv(msg: impl Into<String>) -> Box<PyErr> {
    PyErr::new(Exc::Piv, msg)
}
pub(crate) fn piv_identity(msg: impl Into<String>) -> Box<PyErr> {
    PyErr::new(Exc::PivIdentity, msg)
}
pub(crate) fn side_table(msg: impl Into<String>) -> Box<PyErr> {
    PyErr::new(Exc::SideTable, msg)
}
pub(crate) fn asset_write(msg: impl Into<String>) -> Box<PyErr> {
    PyErr::new(Exc::AssetWrite, msg)
}
pub(crate) fn value_error(msg: impl Into<String>) -> Box<PyErr> {
    PyErr::new(Exc::Value, msg)
}
pub(crate) fn type_error(msg: impl Into<String>) -> Box<PyErr> {
    PyErr::new(Exc::Type, msg)
}
/// `KeyError(key)`: its text is the key's `repr`.
pub(crate) fn key_error(key: &str) -> Box<PyErr> {
    PyErr::new(Exc::Key, crate::py::repr_str(key))
}
pub(crate) fn key_error_repr(repr: String) -> Box<PyErr> {
    PyErr::new(Exc::Key, repr)
}
pub(crate) fn index_error(msg: impl Into<String>) -> Box<PyErr> {
    PyErr::new(Exc::Index, msg)
}
pub(crate) fn attribute_error(msg: impl Into<String>) -> Box<PyErr> {
    PyErr::new(Exc::Attribute, msg)
}
pub(crate) fn struct_error(msg: impl Into<String>) -> Box<PyErr> {
    PyErr::new(Exc::Struct, msg)
}
pub(crate) fn overflow_error(msg: impl Into<String>) -> Box<PyErr> {
    PyErr::new(Exc::Overflow, msg)
}
pub(crate) fn zlib_error(msg: impl Into<String>) -> Box<PyErr> {
    PyErr::new(Exc::Zlib, msg)
}
pub(crate) fn runtime_error(msg: impl Into<String>) -> Box<PyErr> {
    PyErr::new(Exc::Runtime, msg)
}

/// A failure as callers of this crate see it: the HTTP status, machine code
/// and text the service answers with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CodecError {
    /// HTTP status of the error response (422 for a file that cannot be read).
    pub status: u16,
    /// Machine code the editor branches on (`invalid_project`, `source_expired`, ...).
    pub code: String,
    /// What failed, in the words the Python codec used.
    pub message: String,
}

impl fmt::Display for CodecError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({} {})", self.message, self.status, self.code)
    }
}

impl std::error::Error for CodecError {}

impl From<Box<PyErr>> for CodecError {
    /// `server.error_response`.
    fn from(error: Box<PyErr>) -> CodecError {
        use Exc::*;
        match error.exc {
            Api | Job => CodecError { status: error.status, code: error.code.to_string(), message: error.msg },
            Piv | PivIdentity | SideTable | AssetWrite | Value | Type | Key | Index | Struct => {
                CodecError { status: 422, code: "invalid_project".to_string(), message: error.msg }
            }
            Attribute | Overflow | Zlib | Runtime => {
                CodecError { status: 500, code: "codec_error".to_string(), message: "The project operation failed.".to_string() }
            }
        }
    }
}
