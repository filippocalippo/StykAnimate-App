//! Asynchronous document file service. The core owns targets; dialogs are core effects.
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use crate::Cancel;

/// An opaque local target. Only the platform opens it; a future platform can supply its own handle.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct FileTarget(PathBuf);
impl FileTarget {
    pub fn new(path: impl Into<PathBuf>) -> Self { Self(path.into()) }
    pub fn path(&self) -> &Path { &self.0 }
    pub fn name(&self) -> String { self.0.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default() }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FileError { Cancelled, ReadOnly, Full, TooLarge, Io(String) }
impl std::fmt::Display for FileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "{self:?}") }
}
impl std::error::Error for FileError {}
pub type FileFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, FileError>> + Send + 'a>>;

pub trait Files: Send + Sync {
    /// Refuse before allocating beyond `maximum`; read in bounded pieces and observe cancellation.
    fn read<'a>(&'a self, target: &'a FileTarget, maximum: usize, cancel: &'a Cancel) -> FileFuture<'a, Arc<[u8]>>;
    /// Stage beside the destination, flush, then cross `begin_commit` and atomically replace it.
    /// Every failure before that boundary preserves the destination and removes only this call's stage.
    fn replace<'a>(&'a self, target: &'a FileTarget, bytes: &'a [u8], cancel: &'a Cancel) -> FileFuture<'a, ()>;
}

/// Failure injection belongs to the service, so document tests exercise the real host workflow.
pub mod fake {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
    pub enum Failure { #[default] None, ReadOnly, Full, CancelBeforeCommit }
    #[derive(Default)]
    pub struct MemoryFiles { files: Mutex<HashMap<FileTarget, Arc<[u8]>>>, failure: Mutex<Failure> }
    impl MemoryFiles {
        pub fn put(&self, target: FileTarget, bytes: Arc<[u8]>) { self.files.lock().unwrap_or_else(|e| e.into_inner()).insert(target, bytes); }
        pub fn get(&self, target: &FileTarget) -> Option<Arc<[u8]>> { self.files.lock().unwrap_or_else(|e| e.into_inner()).get(target).cloned() }
        pub fn fail(&self, failure: Failure) { *self.failure.lock().unwrap_or_else(|e| e.into_inner()) = failure; }
    }
    impl Files for MemoryFiles {
        fn read<'a>(&'a self, target: &'a FileTarget, maximum: usize, cancel: &'a Cancel) -> FileFuture<'a, Arc<[u8]>> {
            Box::pin(async move {
                if cancel.is_cancelled() { return Err(FileError::Cancelled); }
                let bytes = self.get(target).ok_or_else(|| FileError::Io("missing file".into()))?;
                if bytes.len() > maximum { return Err(FileError::TooLarge); }
                Ok(bytes)
            })
        }
        fn replace<'a>(&'a self, target: &'a FileTarget, bytes: &'a [u8], cancel: &'a Cancel) -> FileFuture<'a, ()> {
            Box::pin(async move {
                let failure = *self.failure.lock().unwrap_or_else(|e| e.into_inner());
                if failure == Failure::ReadOnly { return Err(FileError::ReadOnly); }
                if cancel.is_cancelled() { return Err(FileError::Cancelled); }
                let staged = Arc::from(bytes);
                // The write has staged data, but has not replaced its target. Model a failed flush
                // or a cancellation at that boundary, not a refusal before saving even started.
                match failure {
                    Failure::Full => return Err(FileError::Full),
                    Failure::CancelBeforeCommit => { cancel.cancel(); }
                    _ => {}
                }
                if !cancel.begin_commit() { return Err(FileError::Cancelled); }
                self.put(target.clone(), staged);
                Ok(())
            })
        }
    }
}
