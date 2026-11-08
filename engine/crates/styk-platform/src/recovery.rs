//! Windows recovery files. Construct with an explicit directory; never discover or touch a profile here.
//! All futures are polled on the documents worker. A deny-sharing, delete-on-close lease survives
//! for the open tab, excludes other processes and is released by the OS after a crash.
use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use ring::rand::{SecureRandom, SystemRandom};
use sha2::{Digest, Sha256};
use styk_services::{Cancel, files::{FileError, FileTarget, Files}, recovery::*};
use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_DELETE_ON_CLOSE, FILE_FLAG_OPEN_REPARSE_POINT, FILE_ATTRIBUTE_REPARSE_POINT, FILE_SHARE_READ, FILE_DISPOSITION_INFO, FileDispositionInfo, SetFileInformationByHandle};
use crate::files::LocalFiles;

mod metadata;
pub mod workspace;
#[cfg(test)]
mod tests;

#[derive(Clone)]
pub struct LocalRecovery { directory: PathBuf }
impl LocalRecovery {
    pub fn new(directory: impl Into<PathBuf>) -> Self { Self { directory: directory.into() } }
    pub fn directory(&self) -> &Path { &self.directory }
    fn ensure_directory(&self) -> Result<(), RecoveryError> {
        fs::create_dir_all(&self.directory).map_err(io)?;
        let meta = fs::symlink_metadata(&self.directory).map_err(io)?;
        if !meta.is_dir() || meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 { return Err(RecoveryError::Invalid); }
        Ok(())
    }
    fn path(&self, slot: &Slot, extension: &str) -> PathBuf { self.directory.join(format!("{}.{}", slot.stem(), extension)) }
    fn lease(&self, slot: Slot) -> Result<LocalCopy, RecoveryError> {
        self.ensure_directory()?;
        let lock = OpenOptions::new().read(true).write(true).access_mode(0x8000_0000 | 0x4000_0000 | 0x0001_0000).create_new(true).share_mode(0)
            .custom_flags(FILE_FLAG_DELETE_ON_CLOSE | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(self.path(&slot, "lock")).map_err(|error| {
                if error.kind() == std::io::ErrorKind::AlreadyExists || matches!(error.raw_os_error(), Some(5 | 32 | 33)) { RecoveryError::Owned } else { io(error) }
            })?;
        if lock.metadata().map_err(io)?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 { return Err(RecoveryError::Invalid); }
        Ok(LocalCopy { store: self.clone(), slot, _lock: lock })
    }
    fn slots(&self) -> Result<Vec<Slot>, RecoveryError> {
        let entries = match fs::read_dir(&self.directory) { Ok(entries) => entries, Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()), Err(error) => return Err(io(error)) };
        let mut slots = vec![Slot::legacy()];
        for entry in entries {
            let entry = entry.map_err(io)?;
            let name = entry.file_name(); let name = name.to_string_lossy();
            if let Some(id) = name.strip_prefix("recovery-").and_then(|name| name.strip_suffix(".styk"))
                && let Some(slot) = Slot::named(id) { slots.push(slot); }
        }
        Ok(slots)
    }
    fn prune(&self, cancel: &Cancel) -> Result<(), RecoveryError> {
        let mut owned = 0;
        let mut spare = Vec::new();
        for slot in self.slots()?.into_iter().filter(|slot| !slot.is_legacy()) {
            check(cancel)?;
            match self.lease(slot) {
                Ok(copy) => { if let Ok(record) = copy.describe_mode(cancel, false) { spare.push(record); } }
                Err(RecoveryError::Owned) => owned += 1,
                Err(_) => {} // Unreadable copies are never removed.
            }
        }
        spare.sort_by(|a, b| b.saved_at.cmp(&a.saved_at));
        for record in spare.into_iter().skip(MAX_SLOTS.saturating_sub(owned)) {
            check(cancel)?;
            // Reclaim only an unchanged, still-unowned copy. A tab may have claimed it since listing.
            if let Ok(copy) = self.lease(record.slot.clone()) && copy.describe_mode(cancel, false)? == record {
                let selected = copy.describe(cancel)?;
                copy.remove_checked(&selected, &Cancel::new())?;
            }
        }
        Ok(())
    }
}

fn io(error: std::io::Error) -> RecoveryError {
    if error.kind() == std::io::ErrorKind::NotFound { return RecoveryError::Missing; }
    RecoveryError::File(match error.kind() {
        std::io::ErrorKind::PermissionDenied => FileError::ReadOnly,
        std::io::ErrorKind::StorageFull => FileError::Full,
        _ => FileError::Io(error.to_string()),
    })
}
fn check(cancel: &Cancel) -> Result<(), RecoveryError> { if cancel.is_cancelled() { Err(FileError::Cancelled.into()) } else { Ok(()) } }
fn open_regular(path: &Path) -> Result<File, RecoveryError> {
    open_access(path, false)
}
fn open_access(path: &Path, delete: bool) -> Result<File, RecoveryError> {
    // Stable handles deny writes and renames while a chosen identity is checked/read/removed.
    let access = 0x8000_0000 | if delete { 0x0001_0000 } else { 0 }; // GENERIC_READ | DELETE
    let file = OpenOptions::new().access_mode(access).share_mode(FILE_SHARE_READ).custom_flags(FILE_FLAG_OPEN_REPARSE_POINT).open(path).map_err(io)?;
    let meta = file.metadata().map_err(io)?;
    if !meta.is_file() || meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 { return Err(RecoveryError::Invalid); }
    Ok(file)
}
fn remove_handle(file: &File) -> Result<(), RecoveryError> {
    let info = FILE_DISPOSITION_INFO { DeleteFile: true };
    // The handle names the verified file even if an unrelated path is later replaced.
    let ok = unsafe { SetFileInformationByHandle(file.as_raw_handle(), FileDispositionInfo, (&info as *const FILE_DISPOSITION_INFO).cast(), std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32) };
    if ok == 0 { Err(io(std::io::Error::last_os_error())) } else { Ok(()) }
}

struct LocalCopy { store: LocalRecovery, slot: Slot, _lock: File }
impl LocalCopy {
    fn describe(&self, cancel: &Cancel) -> Result<Record, RecoveryError> {
        self.describe_mode(cancel, true)
    }
    fn describe_mode(&self, cancel: &Cancel, fingerprint: bool) -> Result<Record, RecoveryError> {
        let mut file = open_regular(&self.store.path(&self.slot, "styk"))?;
        self.describe_file(&mut file, cancel, fingerprint)
    }
    fn describe_file(&self, file: &mut File, cancel: &Cancel, fingerprint: bool) -> Result<Record, RecoveryError> {
        let mut metadata = match open_regular(&self.store.path(&self.slot, "json")) {
            Ok(file) => Some(file), Err(RecoveryError::Missing) => None, Err(error) => return Err(error),
        };
        self.describe_files(file, metadata.as_mut(), cancel, fingerprint)
    }
    fn describe_files(&self, file: &mut File, metadata: Option<&mut File>, cancel: &Cancel, fingerprint: bool) -> Result<Record, RecoveryError> {
        check(cancel)?;
        let meta = file.metadata().map_err(io)?;
        let size = usize::try_from(meta.len()).map_err(|_| RecoveryError::Invalid)?;
        if size == 0 || size > MAX_BYTES { return Err(RecoveryError::Invalid); }
        let mut hash = Sha256::new();
        hash.update(meta.last_write_time().to_le_bytes());
        hash.update(meta.len().to_le_bytes());
        // A room check reads only stat/sidecar data, as today's store does. Hash complete payloads
        // only for an offered identity or an actual prune victim, not all spare files every autosave.
        if fingerprint {
            let mut count = 0usize; let mut scratch = [0; 64 * 1024];
            loop {
                check(cancel)?;
                let n = file.read(&mut scratch).map_err(io)?;
                if n == 0 { break; }
                count = count.checked_add(n).ok_or(RecoveryError::Invalid)?;
                if count > MAX_BYTES { return Err(RecoveryError::Invalid); }
                hash.update(&scratch[..n]);
            }
            if count != size { return Err(RecoveryError::Changed); }
        }
        let metadata = match metadata {
            Some(file) => {
                let length = file.metadata().map_err(io)?.len();
                if length < 4096 {
                    let mut bytes = Vec::new(); file.by_ref().take(4096).read_to_end(&mut bytes).map_err(io)?;
                    hash.update(&bytes); bytes
                } else { hash.update(length.to_le_bytes()); Vec::new() }
            }
            None => Vec::new(),
        };
        let (name, saved_at) = metadata::decode(&metadata).unwrap_or_default();
        Ok(Record { slot: self.slot.clone(), name: if name.is_empty() { "Recovered animation".into() } else { String::from_utf16_lossy(&name.encode_utf16().take(180).collect::<Vec<_>>()) },
            saved_at: if saved_at.is_empty() { metadata::file_time(meta.last_write_time()) } else { saved_at }, size, version: hash.finalize().into() })
    }
    fn verify(&self, record: &Record, cancel: &Cancel) -> Result<(), RecoveryError> {
        if record.slot != self.slot || self.describe(cancel)? != *record { Err(RecoveryError::Changed) } else { Ok(()) }
    }
    fn remove_checked(&self, record: &Record, cancel: &Cancel) -> Result<(), RecoveryError> {
        let mut file = open_access(&self.store.path(&self.slot, "styk"), true)?;
        let mut metadata = match open_access(&self.store.path(&self.slot, "json"), true) {
            Ok(file) => Some(file), Err(RecoveryError::Missing) => None, Err(error) => return Err(error),
        };
        if self.describe_files(&mut file, metadata.as_mut(), cancel, true)? != *record { return Err(RecoveryError::Changed); }
        if !cancel.begin_commit() { return Err(FileError::Cancelled.into()); }
        remove_handle(&file)?;
        // Optional display metadata is removed only after the selected data was removed.
        if let Some(file) = metadata { remove_handle(&file)?; }
        Ok(())
    }
}
impl Recovery for LocalRecovery {
    fn list<'a>(&'a self, cancel: &'a Cancel) -> RecoveryFuture<'a, Vec<Record>> {
        Box::pin(async move {
            let mut records = Vec::new();
            for slot in self.slots()? {
                check(cancel)?;
                if let Ok(copy) = self.lease(slot) && let Ok(record) = copy.describe(cancel) { records.push(record); }
            }
            records.sort_by(|a, b| b.saved_at.cmp(&a.saved_at)); Ok(records)
        })
    }
    fn create<'a>(&'a self, cancel: &'a Cancel) -> RecoveryFuture<'a, Arc<dyn RecoveryCopy>> {
        Box::pin(async move {
            check(cancel)?;
            loop {
                let mut bytes = [0u8; 16]; SystemRandom::new().fill(&mut bytes).map_err(|_| RecoveryError::Unavailable("random identity unavailable".into()))?;
                bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
                let id = bytes.iter().enumerate().map(|(i, byte)| format!("{}{:02x}", if [4, 6, 8, 10].contains(&i) { "-" } else { "" }, byte)).collect::<String>();
                let slot = Slot::named(&id).ok_or(RecoveryError::Invalid)?;
                let copy = self.lease(slot)?;
                if !self.path(&copy.slot, "styk").try_exists().map_err(io)? && !self.path(&copy.slot, "json").try_exists().map_err(io)? { return Ok(Arc::new(copy) as Arc<dyn RecoveryCopy>); }
                check(cancel)?;
            }
        })
    }
    fn claim<'a>(&'a self, record: &'a Record, cancel: &'a Cancel) -> RecoveryFuture<'a, Arc<dyn RecoveryCopy>> {
        Box::pin(async move { check(cancel)?; let copy = self.lease(record.slot.clone())?; copy.verify(record, cancel)?; Ok(Arc::new(copy) as Arc<dyn RecoveryCopy>) })
    }
}
impl RecoveryCopy for LocalCopy {
    fn slot(&self) -> &Slot { &self.slot }
    fn read<'a>(&'a self, record: &'a Record, maximum: usize, cancel: &'a Cancel) -> RecoveryFuture<'a, Arc<[u8]>> {
        Box::pin(async move {
            use std::io::{Seek, SeekFrom};
            if record.size > maximum { return Err(FileError::TooLarge.into()); }
            let mut file = open_regular(&self.store.path(&self.slot, "styk"))?;
            if self.describe_file(&mut file, cancel, true)? != *record { return Err(RecoveryError::Changed); }
            file.seek(SeekFrom::Start(0)).map_err(io)?;
            let mut bytes = Vec::new(); bytes.try_reserve_exact(record.size).map_err(|_| RecoveryError::File(FileError::TooLarge))?;
            let mut scratch = [0; 64 * 1024];
            loop {
                check(cancel)?; let n = file.read(&mut scratch).map_err(io)?; if n == 0 { break; }
                if n > record.size.saturating_sub(bytes.len()) { return Err(RecoveryError::Changed); }
                bytes.extend_from_slice(&scratch[..n]);
            }
            if bytes.len() != record.size { return Err(RecoveryError::Changed); }
            Ok(Arc::from(bytes))
        })
    }
    fn write<'a>(&'a self, previous: Option<&'a Record>, bytes: &'a [u8], name: &'a str, cancel: &'a Cancel) -> RecoveryFuture<'a, Record> {
        Box::pin(async move {
            check(cancel)?;
            if bytes.is_empty() || bytes.len() > MAX_BYTES { return Err(RecoveryError::Invalid); }
            if let Some(record) = previous { self.verify(record, cancel)?; }
            else if self.store.path(&self.slot, "styk").try_exists().map_err(io)? { return Err(RecoveryError::Changed); }
            let target = FileTarget::new(self.store.path(&self.slot, "styk"));
            LocalFiles.replace(&target, bytes, cancel).await?;
            let metadata = metadata::encode(&display_name(name), &metadata::now());
            // Data is committed. Metadata failure must not turn a successful copy into a lost identity:
            // describe whatever landed, as at a crash between the two atomic replacements.
            let target = FileTarget::new(self.store.path(&self.slot, "json"));
            let _metadata_result = LocalFiles.replace(&target, &metadata, &Cancel::new()).await;
            let record = self.describe(&Cancel::new())?;
            let _prune_result = self.store.prune(&Cancel::new());
            Ok(record)
        })
    }
    fn remove<'a>(&'a self, record: &'a Record, cancel: &'a Cancel) -> RecoveryFuture<'a, ()> {
        Box::pin(async move { self.remove_checked(record, cancel) })
    }
}
