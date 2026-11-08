//! Recovery storage is asynchronous and receives an explicit directory from its platform owner.
//! A lease owns one copy until released; a record identifies the exact bytes offered to the person.
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use crate::{Cancel, files::FileError};

pub const MAX_BYTES: usize = 256 * 1024 * 1024;
pub const MAX_SLOTS: usize = 16;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Slot(Option<String>);
impl Slot {
    pub fn legacy() -> Self { Self(None) }
    pub fn named(value: &str) -> Option<Self> {
        (value.len() == 36 && value.bytes().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) { c == b'-' } else { c.is_ascii_digit() || (b'a'..=b'f').contains(&c) }
        })).then(|| Self(Some(value.into())))
    }
    pub fn id(&self) -> &str { self.0.as_deref().unwrap_or("recovery") }
    pub fn stem(&self) -> String { self.0.as_ref().map_or_else(|| "recovery".into(), |id| format!("recovery-{id}")) }
    pub fn is_legacy(&self) -> bool { self.0.is_none() }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Record {
    pub slot: Slot,
    pub name: String,
    /// Today's ISO-8601 UTC timestamp, also used to order the chooser newest first.
    pub saved_at: String,
    pub size: usize,
    /// Committed data's digest. Callers must return identities unchanged, never reconstruct them.
    pub version: [u8; 32],
    /// Listings seal the file attributes and metadata the person saw, or use `version` alone when
    /// metadata is unavailable. A write receipt has no selection seal: its data is committed even
    /// if optional metadata cannot be accessed.
    pub selection: Option<[u8; 32]>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RecoveryError { File(FileError), Changed, Owned, Missing, Invalid, Unavailable(String) }
impl From<FileError> for RecoveryError { fn from(error: FileError) -> Self { Self::File(error) } }
impl std::fmt::Display for RecoveryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "{self:?}") }
}
impl std::error::Error for RecoveryError {}
pub type RecoveryFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, RecoveryError>> + Send + 'a>>;

pub trait Recovery: Send + Sync {
    /// Only readable, unowned copies; unreadable files are never deleted.
    fn list<'a>(&'a self, cancel: &'a Cancel) -> RecoveryFuture<'a, Vec<Record>>;
    fn create<'a>(&'a self, cancel: &'a Cancel) -> RecoveryFuture<'a, Arc<dyn RecoveryCopy>>;
    /// Atomically reserve the selected identity, refusing a changed or already-owned copy.
    fn claim<'a>(&'a self, record: &'a Record, cancel: &'a Cancel) -> RecoveryFuture<'a, Arc<dyn RecoveryCopy>>;
}
pub trait RecoveryCopy: Send + Sync {
    fn slot(&self) -> &Slot;
    fn read<'a>(&'a self, record: &'a Record, maximum: usize, cancel: &'a Cancel) -> RecoveryFuture<'a, Arc<[u8]>>;
    /// `previous == None` requires an empty slot. A successful write returns its new identity.
    /// Data commits before optional display metadata; never publish partial data or a failed save.
    fn write<'a>(&'a self, previous: Option<&'a Record>, bytes: &'a [u8], name: &'a str, cancel: &'a Cancel) -> RecoveryFuture<'a, Record>;
    /// Success acknowledges data removal. Optional sidecar cleanup cannot undo that commit and is
    /// retried on later lease operations; an error means the data record must still be retained.
    fn remove<'a>(&'a self, record: &'a Record, cancel: &'a Cancel) -> RecoveryFuture<'a, ()>;
}

/// A secondary workspace's storage location is resolved on a worker, never by core file I/O.
pub trait Workspaces: Send + Sync {
    fn adopt<'a>(&'a self, cancel: &'a Cancel) -> RecoveryFuture<'a, crate::files::FileTarget>;
}

/// Today's sanitization and UTF-16 length limit. A split surrogate is replaced, as in UTF-8 JSON.
pub fn display_name(name: &str) -> String {
    let name = if name.is_empty() { "Untitled" } else { name };
    let clean: String = name.chars().map(|c| if c <= '\u{1f}' || c == '\u{7f}' || "\\/:*?\"<>|".contains(c) { '_' } else { c }).collect();
    let units: Vec<u16> = clean.encode_utf16().take(180).collect();
    let text = String::from_utf16_lossy(&units).trim().to_string();
    if text.is_empty() { "Untitled".into() } else { text }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn slots_accept_only_todays_issued_names_and_the_legacy_slot() {
        let id = "12345678-1234-4234-8234-123456789abc";
        assert_eq!(Slot::named(id).unwrap().stem(), format!("recovery-{id}"));
        assert_eq!(Slot::legacy().stem(), "recovery");
        for invalid in ["../project", "recovery", "12345678-1234-4234-8234-123456789ABC", "12345678-1234-4234-8234-123456789abg"] { assert!(Slot::named(invalid).is_none()); }
    }
    #[test]
    fn display_names_use_todays_sanitization_and_utf16_limit() {
        assert_eq!(display_name(" \tA/b:c*?\"<>|\\\u{7f}\n "), format!("_A_b_c{}", "_".repeat(9)));
        assert_eq!(display_name(""), "Untitled"); assert_eq!(display_name("   "), "Untitled");
        assert_eq!(display_name(&"😀".repeat(100)).encode_utf16().count(), 180);
    }
}
