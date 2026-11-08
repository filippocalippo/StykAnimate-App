//! Local document I/O, polled only by the document job worker. No dialog or target state lives here.
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use styk_services::Cancel;
use styk_services::files::{FileError, FileFuture, FileTarget, Files};

static SERIAL: AtomicU64 = AtomicU64::new(0);
const PIECE: usize = 256 * 1024;
#[derive(Default)]
pub struct LocalFiles;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WriteStep { Created, Written, Flushed, Commit, Renamed }
#[cfg(test)]
type Observer = Box<dyn Fn(WriteStep, &Path, &Path)>;
#[cfg(test)]
thread_local! { pub(crate) static WRITE_OBSERVER: std::cell::RefCell<Option<Observer>> = const { std::cell::RefCell::new(None) }; }
#[cfg(test)]
thread_local! { pub(crate) static WRITE_FAILURE: std::cell::Cell<Option<WriteStep>> = const { std::cell::Cell::new(None) }; }
fn observe(step: WriteStep, target: &Path, stage: &Path) -> Result<(), FileError> {
    #[cfg(test)]
    WRITE_OBSERVER.with(|observer| { if let Some(observer) = observer.borrow().as_ref() { observer(step, target, stage); } });
    #[cfg(not(test))]
    let _ = (step, target, stage);
    #[cfg(test)]
    if matches!(step, WriteStep::Created | WriteStep::Written | WriteStep::Flushed)
        && WRITE_FAILURE.with(|failure| failure.get() == Some(step)) { return Err(FileError::Full); }
    Ok(())
}

pub(crate) fn io(error: std::io::Error) -> FileError {
    match error.kind() {
        std::io::ErrorKind::PermissionDenied => FileError::ReadOnly,
        std::io::ErrorKind::StorageFull => FileError::Full,
        _ => FileError::Io(error.to_string()),
    }
}
pub(crate) fn cancelled(cancel: &Cancel) -> Result<(), FileError> {
    if cancel.is_cancelled() { Err(FileError::Cancelled) } else { Ok(()) }
}
struct Stage { path: PathBuf, committed: bool }
impl Drop for Stage {
    fn drop(&mut self) { if !self.committed { let _ = fs::remove_file(&self.path); } }
}

/// Shared bounded reader for documents and small preference files; worker-only.
pub(crate) fn read_bounded(mut file: File, maximum: usize, cancel: &Cancel) -> Result<Arc<[u8]>, FileError> {
    cancelled(cancel)?;
    let length = usize::try_from(file.metadata().map_err(io)?.len()).map_err(|_| FileError::TooLarge)?;
    if length > maximum { return Err(FileError::TooLarge); }
    let mut bytes = Vec::new();
    bytes.try_reserve_exact(length).map_err(|_| FileError::TooLarge)?;
    let mut buffer = vec![0; PIECE.min(maximum.saturating_add(1))];
    loop {
        cancelled(cancel)?;
        // At most one excess byte, even if the file grows after its metadata was read.
        let remaining = buffer.len().min(maximum.saturating_sub(bytes.len()).saturating_add(1));
        let count = file.read(&mut buffer[..remaining]).map_err(io)?;
        if count == 0 { break; }
        if count > maximum.saturating_sub(bytes.len()) { return Err(FileError::TooLarge); }
        bytes.try_reserve_exact(count).map_err(|_| FileError::TooLarge)?;
        bytes.extend_from_slice(&buffer[..count]);
    }
    cancelled(cancel)?;
    Ok(Arc::from(bytes))
}

impl Files for LocalFiles {
    fn read<'a>(&'a self, target: &'a FileTarget, maximum: usize, cancel: &'a Cancel) -> FileFuture<'a, Arc<[u8]>> {
        Box::pin(async move {
            cancelled(cancel)?;
            read_bounded(File::open(target.path()).map_err(io)?, maximum, cancel)
        })
    }

    fn replace<'a>(&'a self, target: &'a FileTarget, bytes: &'a [u8], cancel: &'a Cancel) -> FileFuture<'a, ()> {
        Box::pin(async move {
            cancelled(cancel)?;
            let destination = target.path();
            if destination.file_name().is_none() { return Err(FileError::Io("the destination has no file name".into())); }
            match fs::metadata(destination) {
                Ok(meta) if meta.permissions().readonly() => return Err(FileError::ReadOnly),
                Ok(meta) if !meta.is_file() => return Err(FileError::Io("the destination is not a file".into())),
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(io(error)),
            }
            let parent = destination.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
            // Short independent component; create_new refuses collisions and never owns another process's file.
            let (mut stage, mut file) = loop {
                cancelled(cancel)?;
                let serial = SERIAL.fetch_add(1, Ordering::Relaxed);
                let path = parent.join(format!(".styk-doc-{}-{serial:x}.tmp", std::process::id()));
                match OpenOptions::new().write(true).create_new(true).open(&path) {
                    Ok(file) => break (Stage { path, committed: false }, file),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(error) => return Err(io(error)),
                }
            };
            observe(WriteStep::Created, destination, &stage.path)?;
            for piece in bytes.chunks(PIECE) {
                cancelled(cancel)?;
                file.write_all(piece).map_err(io)?;
                observe(WriteStep::Written, destination, &stage.path)?;
            }
            cancelled(cancel)?;
            file.sync_all().map_err(io)?;
            observe(WriteStep::Flushed, destination, &stage.path)?;
            drop(file);
            observe(WriteStep::Commit, destination, &stage.path)?;
            if !cancel.begin_commit() { return Err(FileError::Cancelled); }
            // On Windows std::fs::rename uses a replacing move on the same volume. No copy/delete fallback.
            fs::rename(&stage.path, destination).map_err(io)?;
            stage.committed = true;
            observe(WriteStep::Renamed, destination, &stage.path)?;
            Ok(())
        })
    }
}
