//! Small native preferences, serialized on one bounded platform worker.
//! The profile lock covers the read, user merge, and LocalFiles' sole staged replacement path.
use crate::files::{LocalFiles, cancelled, io, read_bounded};
use std::fs::{self, File, OpenOptions};
use std::future::Future;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::mpsc::{SyncSender, sync_channel};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};
use styk_services::files::{FileError, FileFuture, FileTarget, Files};
use styk_services::storage::{Storage, Update};
use styk_services::worker::run_future;
use styk_services::{Cancel, Spawner};
use windows_sys::Win32::Foundation::{ERROR_LOCK_VIOLATION, WAIT_FAILED};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE,
    LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY, LockFileEx,
};
use windows_sys::Win32::System::IO::OVERLAPPED;
use windows_sys::Win32::System::Threading::{CreateEventW, SetEvent, WaitForSingleObject};

const LOCK_NAME: &str = ".storage.lock";
const LOCK_RETRY_MS: u32 = 25;
type Job = Box<dyn FnOnce(&Path) + Send>;

/// One running request and at most one queued request. Overflow is a visible error, never a lost write.
pub struct LocalStorage {
    send: SyncSender<Job>,
    legacy: Option<PathBuf>,
}

impl LocalStorage {
    /// Native preferences are separate from Electron's roaming profile and its import sources.
    /// Construction starts a worker but performs no disk I/O and creates no settings directory.
    pub fn for_user(spawner: &dyn Spawner) -> Result<Self, FileError> {
        let base = std::env::var_os("LOCALAPPDATA")
            .filter(|value| !value.is_empty())
            .ok_or_else(|| FileError::Io("LOCALAPPDATA is unavailable".into()))?;
        let mut store = Self::new(
            PathBuf::from(base).join("StykAnimate").join("settings"),
            spawner,
        )?;
        store.legacy = std::env::var_os("STYK_USER_DATA_DIR").filter(|v| !v.is_empty()).map(PathBuf::from)
            .or_else(|| std::env::var_os("APPDATA").filter(|v| !v.is_empty()).map(|p| PathBuf::from(p).join("StykAnimate")));
        Ok(store)
    }

    /// Explicit profile for hosts and isolated tests. The caller owns the choice of directory.
    pub fn new(directory: impl Into<PathBuf>, spawner: &dyn Spawner) -> Result<Self, FileError> {
        let directory = directory.into();
        let legacy = Some(directory.clone());
        let (send, receive) = sync_channel::<Job>(1);
        spawner
            .spawn(
                "styk-storage",
                Box::new(move || {
                    while let Ok(job) = receive.recv() {
                        job(&directory);
                    }
                }),
            )
            .map_err(|error| FileError::Io(error.to_string()))?;
        Ok(Self { send, legacy })
    }

    /// Explicit native and read-only legacy roots, also used by migration tests.
    pub fn with_legacy(directory: impl Into<PathBuf>, legacy: impl Into<PathBuf>, spawner: &dyn Spawner) -> Result<Self, FileError> {
        let mut store = Self::new(directory, spawner)?;
        store.legacy = Some(legacy.into());
        Ok(store)
    }

    fn request<'a, T: Send + 'static>(
        &'a self,
        cancel: Cancel,
        operation: impl FnOnce(&Path, &Cancel) -> Result<T, FileError> + Send + 'static,
    ) -> FileFuture<'a, T> {
        // Captured outside the async body: dropping even an unpolled request cancels its token.
        let reply = Reply {
            shared: Arc::new(Mutex::new(Answer {
                result: None,
                waker: None,
            })),
            cancel,
            done: false,
        };
        Box::pin(async move {
            cancelled(&reply.cancel)?;
            let shared = reply.shared.clone();
            let cancel = reply.cancel.clone();
            let job = Box::new(move |directory: &Path| {
                let result = cancelled(&cancel).and_then(|()| operation(directory, &cancel));
                let wake = {
                    let mut answer = shared.lock().unwrap_or_else(|error| error.into_inner());
                    answer.result = Some(result);
                    answer.waker.take()
                };
                if let Some(wake) = wake {
                    wake.wake();
                }
            });
            self.send.try_send(job).map_err(|error| match error {
                std::sync::mpsc::TrySendError::Full(_) => {
                    FileError::Io("storage worker is busy; retry the request".into())
                }
                std::sync::mpsc::TrySendError::Disconnected(_) => {
                    FileError::Io("storage worker stopped".into())
                }
            })?;
            reply.await
        })
    }
}

struct Answer<T> {
    result: Option<Result<T, FileError>>,
    waker: Option<Waker>,
}
struct Reply<T> {
    shared: Arc<Mutex<Answer<T>>>,
    cancel: Cancel,
    done: bool,
}
impl<T> Future for Reply<T> {
    type Output = Result<T, FileError>;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        let result = {
            // No interface wait, and no callback/I/O under this exchange lock.
            let Ok(mut answer) = this.shared.try_lock() else {
                cx.waker().wake_by_ref();
                return Poll::Pending;
            };
            if answer.result.is_none() {
                answer.waker = Some(cx.waker().clone());
            }
            answer.result.take()
        };
        match result {
            Some(result) => {
                this.done = true;
                Poll::Ready(result)
            }
            None => Poll::Pending,
        }
    }
}
impl<T> Drop for Reply<T> {
    fn drop(&mut self) {
        if !self.done {
            self.cancel.cancel();
        }
    }
}

fn validate_name(name: &str) -> Result<(), FileError> {
    // A small document name, never a path, stream, Windows device, or our lock/staging namespace.
    if name.is_empty() || name.len() > 128 {
        return Err(FileError::Io("invalid storage document name".into()));
    }
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let device = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'));
    if !name.as_bytes()[0].is_ascii_alphanumeric()
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        || name.ends_with('.')
        || device
    {
        return Err(FileError::Io("invalid storage document name".into()));
    }
    Ok(())
}

fn load(
    target: &FileTarget,
    maximum: usize,
    cancel: &Cancel,
) -> Result<Option<Arc<[u8]>>, FileError> {
    cancelled(cancel)?;
    let file = match File::open(target.path()) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io(error)),
    };
    read_bounded(file, maximum, cancel).map(Some)
}

/// Closing the file releases this byte-range lock, including on process death. The file is never
/// unlinked: deleting a shared lock file would let another process lock a different file identity.
fn acquire(directory: &Path, cancel: &Cancel) -> Result<File, FileError> {
    cancelled(cancel)?;
    fs::create_dir_all(directory).map_err(io)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(directory.join(LOCK_NAME))
        .map_err(io)?;
    let meta = file.metadata().map_err(io)?;
    if !meta.is_file() || meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(FileError::Io("invalid storage lock file".into()));
    }
    // One event and one weak cancellation registration for the whole acquisition, not per retry.
    // SAFETY: an unnamed manual-reset event, owned and closed exactly once by OwnedHandle.
    let handle = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
    if handle.is_null() {
        return Err(io(std::io::Error::last_os_error()));
    }
    let event = Arc::new(unsafe { OwnedHandle::from_raw_handle(handle) });
    let weak = Arc::downgrade(&event);
    cancel.on_cancel(move || {
        if let Some(event) = weak.upgrade() {
            // SAFETY: the upgraded Arc keeps the event live through SetEvent; it never waits.
            unsafe {
                SetEvent(event.as_raw_handle());
            }
        }
    });
    loop {
        cancelled(cancel)?;
        let mut overlap = OVERLAPPED::default();
        // SAFETY: valid file and stack OVERLAPPED; FAIL_IMMEDIATELY never leaves pending I/O.
        if unsafe {
            LockFileEx(
                file.as_raw_handle(),
                LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
                0,
                1,
                0,
                &mut overlap,
            )
        } != 0
        {
            cancelled(cancel)?;
            return Ok(file);
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(ERROR_LOCK_VIOLATION as i32) {
            return Err(io(error));
        }
        #[cfg(test)]
        tests::observe_wait();
        // SAFETY: this worker owns the event throughout the wait; cancellation wakes it immediately.
        if unsafe { WaitForSingleObject(event.as_raw_handle(), LOCK_RETRY_MS) } == WAIT_FAILED {
            return Err(io(std::io::Error::last_os_error()));
        }
    }
}

impl Storage for LocalStorage {
    fn load_legacy<'a>(&'a self, name: &'a str, maximum: usize) -> FileFuture<'a, Option<Arc<[u8]>>> {
        if let Err(error) = validate_name(name) { return Box::pin(async move { Err(error) }); }
        let Some(directory) = self.legacy.clone() else { return Box::pin(async { Ok(None) }); };
        let target = FileTarget::new(directory.join(name));
        self.request(Cancel::new(), move |_, cancel| load(&target, maximum, cancel))
    }
    fn load<'a>(&'a self, name: &'a str, maximum: usize) -> FileFuture<'a, Option<Arc<[u8]>>> {
        if let Err(error) = validate_name(name) {
            return Box::pin(async move { Err(error) });
        }
        let name = name.to_owned();
        self.request(Cancel::new(), move |directory, cancel| {
            load(&FileTarget::new(directory.join(name)), maximum, cancel)
        })
    }

    fn update<'a>(
        &'a self,
        name: &'a str,
        maximum: usize,
        update: Update,
        cancel: &'a Cancel,
    ) -> FileFuture<'a, ()> {
        if let Err(error) = validate_name(name) {
            return Box::pin(async move { Err(error) });
        }
        let name = name.to_owned();
        self.request(cancel.clone(), move |directory, cancel| {
            let target = FileTarget::new(directory.join(name));
            let _lock = acquire(directory, cancel)?;
            let current = load(&target, maximum, cancel)?;
            cancelled(cancel)?;
            let proposed = update(current.as_deref()).map_err(FileError::Io)?;
            if proposed.len() > maximum {
                return Err(FileError::TooLarge);
            }
            cancelled(cancel)?;
            run_future(LocalFiles.replace(&target, &proposed, cancel))
        })
    }
}

#[cfg(test)]
mod tests;
