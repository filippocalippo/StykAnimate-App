//! Atomic preference transactions. Implementations run on a storage worker, never in the interface event loop.
use crate::{Cancel, files::FileFuture};
use std::sync::Arc;

/// Invoked once while the worker holds an OS-backed interprocess lock over read, merge and replacement.
/// Returning an error preserves the file. The worker caps both the read and proposed write before publication.
pub type Update = Box<dyn FnOnce(Option<&[u8]>) -> Result<Vec<u8>, String> + Send>;

pub trait Storage: Send + Sync {
    /// Read without creating or rewriting a missing file.
    fn load<'a>(&'a self, name: &'a str, maximum: usize) -> FileFuture<'a, Option<Arc<[u8]>>>;
    /// Acquire the per-profile lock on the worker, read under the lock, call update, stage, flush and replace.
    /// Observe cancellation while acquiring the lock and doing bounded I/O. Stage and flush first,
    /// then call Cancel::begin_commit immediately before atomic replacement. If it refuses, nothing
    /// is replaced. Cancellation after that boundary is too late; report the committed result.
    /// Every pre-commit failure (callback, staging/flush, cancellation, or a dropped future) preserves
    /// the existing file byte-for-byte and removes only this transaction's staging. A dropped future
    /// must cancel its worker and wake blocking waits; dropping a handle must not detach an uncancelled write.
    /// A process crash releases the OS lock; no existence-based lock files. Completion is ordered per service.
    fn update<'a>(
        &'a self,
        name: &'a str,
        maximum: usize,
        update: Update,
        cancel: &'a Cancel,
    ) -> FileFuture<'a, ()>;
}

/// In-memory transaction service with an explicit staging boundary for failure tests.
#[cfg(any(test, feature = "test-fakes"))]
pub mod fake {
    use super::*;
    use crate::files::FileError;
    use std::{
        collections::BTreeMap,
        future::Future,
        pin::Pin,
        sync::Mutex,
        task::{Context, Poll, Waker},
    };
    #[derive(Clone, Copy, Default, PartialEq, Eq)]
    pub enum Failure {
        #[default]
        None,
        Stage,
        CancelBeforeCommit,
        PauseBeforeCommit,
    }
    #[derive(Default)]
    struct State {
        files: BTreeMap<String, Vec<u8>>,
        busy: bool,
        staged: bool,
        failure: Failure,
        waiters: Vec<Waker>,
    }
    #[derive(Default)]
    pub struct MemoryStorage(Mutex<State>);
    impl MemoryStorage {
        pub fn get(&self, name: &str) -> Option<Vec<u8>> {
            self.0
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .files
                .get(name)
                .cloned()
        }
        pub fn put(&self, name: &str, bytes: Vec<u8>) {
            self.0
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .files
                .insert(name.into(), bytes);
        }
        pub fn staged(&self) -> bool {
            self.0.lock().unwrap_or_else(|e| e.into_inner()).staged
        }
        pub fn fail(&self, failure: Failure) {
            let waiters = {
                let mut s = self.0.lock().unwrap_or_else(|e| e.into_inner());
                s.failure = failure;
                std::mem::take(&mut s.waiters)
            };
            for w in waiters {
                w.wake();
            }
        }
    }
    struct Transaction<'a> {
        store: &'a MemoryStorage,
        name: &'a str,
        max: usize,
        update: Option<Update>,
        cancel: &'a Cancel,
        bytes: Option<Vec<u8>>,
        acquired: bool,
        done: bool,
    }
    impl Transaction<'_> {
        fn finish(&mut self, result: Result<(), FileError>) -> Poll<Result<(), FileError>> {
            self.bytes = None;
            self.done = true;
            self.release();
            Poll::Ready(result)
        }
        fn release(&mut self) {
            if !self.acquired {
                return;
            }
            self.acquired = false;
            let waiters = {
                let mut s = self.store.0.lock().unwrap_or_else(|e| e.into_inner());
                s.busy = false;
                s.staged = false;
                std::mem::take(&mut s.waiters)
            };
            for w in waiters {
                w.wake();
            }
        }
    }
    impl Drop for Transaction<'_> {
        fn drop(&mut self) {
            if !self.done {
                self.cancel.cancel();
            }
            self.bytes = None;
            self.release();
        }
    }
    impl Future for Transaction<'_> {
        type Output = Result<(), FileError>;
        fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
            let this = self.get_mut();
            if this.cancel.is_cancelled() {
                return this.finish(Err(FileError::Cancelled));
            }
            if !this.acquired {
                let old = {
                    let mut s = this.store.0.lock().unwrap_or_else(|e| e.into_inner());
                    if s.busy {
                        if !s.waiters.iter().any(|w| w.will_wake(cx.waker())) {
                            s.waiters.push(cx.waker().clone());
                            let wake = cx.waker().clone();
                            this.cancel.on_cancel(move || wake.wake());
                        }
                        return Poll::Pending;
                    }
                    s.busy = true;
                    this.acquired = true;
                    s.files.get(this.name).cloned()
                };
                if old.as_ref().is_some_and(|b| b.len() > this.max) {
                    return this.finish(Err(FileError::TooLarge));
                }
                let Some(update) = this.update.take() else {
                    return this.finish(Err(FileError::Io("transaction already completed".into())));
                };
                let bytes = match update(old.as_deref()) {
                    Ok(b) => b,
                    Err(e) => return this.finish(Err(FileError::Io(e))),
                };
                if bytes.len() > this.max {
                    return this.finish(Err(FileError::TooLarge));
                }
                this.bytes = Some(bytes);
                this.store
                    .0
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .staged = true;
            }
            let failure = this
                .store
                .0
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .failure;
            match failure {
                Failure::Stage => return this.finish(Err(FileError::Full)),
                Failure::CancelBeforeCommit => {
                    this.cancel.cancel();
                }
                Failure::PauseBeforeCommit => {
                    let mut s = this.store.0.lock().unwrap_or_else(|e| e.into_inner());
                    if !s.waiters.iter().any(|w| w.will_wake(cx.waker())) {
                        s.waiters.push(cx.waker().clone());
                        let wake = cx.waker().clone();
                        this.cancel.on_cancel(move || wake.wake());
                    }
                    return Poll::Pending;
                }
                Failure::None => {}
            }
            if !this.cancel.begin_commit() {
                return this.finish(Err(FileError::Cancelled));
            }
            if let Some(bytes) = this.bytes.take() {
                this.store.put(this.name, bytes);
            }
            this.finish(Ok(()))
        }
    }
    impl Storage for MemoryStorage {
        fn load<'a>(&'a self, name: &'a str, maximum: usize) -> FileFuture<'a, Option<Arc<[u8]>>> {
            Box::pin(async move {
                let bytes = self.get(name);
                if bytes.as_ref().is_some_and(|b| b.len() > maximum) {
                    Err(FileError::TooLarge)
                } else {
                    Ok(bytes.map(Arc::from))
                }
            })
        }
        fn update<'a>(
            &'a self,
            name: &'a str,
            maximum: usize,
            update: Update,
            cancel: &'a Cancel,
        ) -> FileFuture<'a, ()> {
            Box::pin(Transaction {
                store: self,
                name,
                max: maximum,
                update: Some(update),
                cancel,
                bytes: None,
                acquired: false,
                done: false,
            })
        }
    }
}
#[cfg(test)]
mod tests {
    use super::fake::{Failure, MemoryStorage};
    use super::*;
    use crate::files::FileError;
    use std::task::{Context, Poll, Waker};
    #[test]
    fn every_precommit_failure_preserves_bytes_and_cleans_stage() {
        let storage = MemoryStorage::default();
        storage.put("layout", b"old".to_vec());
        for failure in [
            Failure::Stage,
            Failure::CancelBeforeCommit,
            Failure::PauseBeforeCommit,
        ] {
            storage.fail(failure);
            let cancel = Cancel::new();
            let mut future =
                storage.update("layout", 32, Box::new(|_| Ok(b"new".to_vec())), &cancel);
            let result = future
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop()));
            if failure == Failure::PauseBeforeCommit {
                assert!(result.is_pending());
                assert!(storage.staged());
            } else {
                assert!(matches!(result, Poll::Ready(Err(_))));
            }
            drop(future);
            assert!(!storage.staged());
            assert_eq!(storage.get("layout").unwrap(), b"old");
        }
        storage.fail(Failure::None);
        let cancel = Cancel::new();
        let mut callback = storage.update(
            "layout",
            32,
            Box::new(|_| Err("callback refused".into())),
            &cancel,
        );
        assert!(matches!(
            callback
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop())),
            Poll::Ready(Err(FileError::Io(_)))
        ));
        assert!(!storage.staged());
        assert_eq!(storage.get("layout").unwrap(), b"old");
    }
    #[test]
    fn cancellation_wakes_staged_transaction_and_commit_is_final() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        struct Wake(AtomicUsize);
        impl std::task::Wake for Wake {
            fn wake(self: Arc<Self>) {
                self.0.fetch_add(1, Ordering::Relaxed);
            }
        }
        let wake = Arc::new(Wake(AtomicUsize::new(0)));
        let waker = Waker::from(wake.clone());
        let storage = MemoryStorage::default();
        storage.put("layout", b"old".to_vec());
        storage.fail(Failure::PauseBeforeCommit);
        let cancel = Cancel::new();
        let mut future = storage.update("layout", 32, Box::new(|_| Ok(b"new".to_vec())), &cancel);
        assert!(
            future
                .as_mut()
                .poll(&mut Context::from_waker(&waker))
                .is_pending()
        );
        cancel.cancel();
        assert!(wake.0.load(Ordering::Relaxed) > 0);
        assert!(matches!(
            future.as_mut().poll(&mut Context::from_waker(&waker)),
            Poll::Ready(Err(FileError::Cancelled))
        ));
        assert!(!storage.staged());
        assert_eq!(storage.get("layout").unwrap(), b"old");
        drop(future);
        storage.fail(Failure::None);
        let cancel = Cancel::new();
        let mut future = storage.update("layout", 32, Box::new(|_| Ok(b"new".to_vec())), &cancel);
        assert!(matches!(
            future.as_mut().poll(&mut Context::from_waker(&waker)),
            Poll::Ready(Ok(()))
        ));
        assert!(!cancel.cancel());
        drop(future);
        assert_eq!(storage.get("layout").unwrap(), b"new");
    }
}
