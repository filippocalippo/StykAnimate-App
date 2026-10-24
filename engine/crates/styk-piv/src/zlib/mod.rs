//! zlib streams, with the reference library's exact behaviour.
//!
//! Pivot files are zlib streams, and two contracts depend on the reference
//! implementation (zlib 1.3.1, the one CPython links):
//!
//! - **Writing**: an exported file must be the bytes Python's `zlib.compress`
//!   produced. [`compress`] ports zlib's level-6 `deflate_slow` and its block
//!   and Huffman-tree decisions, so the output is bit-identical.
//! - **Reading**: a damaged stream must fail with zlib's diagnosis
//!   (`invalid distance too far back`, `incorrect data check`, ...), which the
//!   Python service reports verbatim. [`inflate`] detects the same conditions
//!   in the same order.

mod checksum;
mod deflate;
mod inflate;

pub(crate) use checksum::crc32;
pub(crate) use deflate::compress;
pub(crate) use inflate::{StreamEnd, inflate};
