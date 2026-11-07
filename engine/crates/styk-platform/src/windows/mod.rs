//! The Windows implementations of the shell services (`docs/native/shell.md`).

pub mod chrome;
pub mod instance;
pub mod monitors;
pub mod probe;
pub mod registry;
pub mod updates;

/// UTF-16 with a terminating zero, for the wide-character APIs.
pub(crate) fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}
