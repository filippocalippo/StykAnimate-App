//! Atomic preference transactions. Implementations run on a storage worker, never in the interface event loop.
use crate::files::FileFuture;
use std::sync::Arc;

/// Invoked once while the worker holds an OS-backed interprocess lock over read, merge and replacement.
/// Returning an error preserves the file. The worker caps both the read and proposed write before publication.
pub type Update = Box<dyn FnOnce(Option<&[u8]>) -> Result<Vec<u8>, String> + Send>;

pub trait Storage: Send + Sync {
    /// Read without creating or rewriting a missing file.
    fn load<'a>(&'a self, name: &'a str, maximum: usize) -> FileFuture<'a, Option<Arc<[u8]>>>;
    /// Acquire the per-profile lock on the worker, read under the lock, call update, stage, flush and replace.
    /// A process crash releases the OS lock; no existence-based lock files. Completion is ordered per service.
    fn update<'a>(&'a self, name: &'a str, maximum: usize, update: Update) -> FileFuture<'a, ()>;
}
