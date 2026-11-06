//! StykAnimate file formats.
//!
//! - [`container`]: the `.styk` (project), `.stkz` (figure) and `.stykmov`
//!   (movieclip) containers, versions 1 and 2, and plain JSON projects. Contract:
//!   `docs/native-file-format.md`. Reading yields a [`styk_doc::Value`] tree;
//!   writing an unchanged tree yields the bytes it was read from.
//! - [`native`]: the document-level rules every reader applies after decoding
//!   (wrapper unwrap, figure-file shape, embedded source fingerprint).
//!
//! - [`files`]: what the interface's file workers ask of a native file: open one
//!   into the form the interface shares with the store, and save one from it.
//!
//! Pivot `.piv`/`.stk` files live in the `styk-piv` crate.

pub mod container;
pub mod files;
pub mod native;

pub use container::{ContainerError, Kind};
