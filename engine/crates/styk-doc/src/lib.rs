//! The StykAnimate document store.
//!
//! A project is a tree of plain data: the decoded Pivot report plus StykAnimate's
//! own `_styk` extensions, with fields this engine may not know. The store keeps
//! that tree **losslessly** (key order, exact numbers, unknown fields) so that an
//! unchanged project saves to identical bytes, and **cheaply**:
//!
//! - every array and object is an [`Arc`](std::sync::Arc): cloning a document is
//!   one pointer copy, and an edit clones only the records on the path it touches
//!   (copy-on-write through [`Value::make_obj`] and friends);
//! - arrays of numbers are packed ([`Nums`]), in 4 bytes per value when every
//!   value is exactly a 32-bit float, as Pivot poses are;
//! - objects share their key list ([`Shape`]), so a pose record costs its values.
//!
//! Evaluation does not read this tree directly on hot paths: `styk-eval` derives
//! typed views from it per record and keeps them while the record is unchanged.
//!
//! Text forms: [`json::parse`] reads JSON; [`json::write`] produces exactly what
//! JavaScript's `JSON.stringify` produces for the same data, which is what the
//! file format hashes and stores.

pub mod json;
mod number;
pub mod payload;
mod value;

pub use number::format_number;
pub use value::{Blob, Elements, Nums, Obj, Shape, Value, index_key, retained_bytes_checked};

/// What went wrong while reading text into the store, and where.
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum JsonError {
    #[error("invalid JSON at byte {offset}: {message}")]
    Syntax { offset: usize, message: &'static str },
    #[error("JSON nesting deeper than {0} levels")]
    Depth(usize),
}
