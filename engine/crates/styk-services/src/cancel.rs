//! Cancellation that wakes what is blocked.
//!
//! A flag nobody reads in time is not cancellation: a writer blocked in a pipe write, a producer waiting for a free
//! buffer or a thread waiting for a child to exit never looks at a flag. [`Cancel`] holds the flag and a list of
//! *wakers*. Whatever can block registers a waker when it starts (end the child process, notify the condition
//! variable); [`Cancel::cancel`] sets the flag and runs ready wakers on the calling thread. If it races a registration,
//! that registering worker delivers the pending wakes after unlocking; cancellation never waits for its lock.
//! Wakers themselves must not block.
//!
//! A job also has a **commit boundary**: [`Cancel::begin_commit`] succeeds only if the job was not cancelled, and from
//! then on a cancel is too late (it changes nothing and runs no waker). The flush of a finished file happens before the
//! boundary, so an edit during a slow flush still cancels; the replacing rename happens after it, so a cancel can
//! never be followed by a replaced destination.

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex};

type Waker = Box<dyn FnOnce() + Send>;

const RUNNING: u8 = 0;
const COMMITTING: u8 = 1;
const CANCELLED: u8 = 2;

#[derive(Default)]
struct Inner {
    state: AtomicU8,
    wakers: Mutex<Vec<Waker>>,
}

/// A cancellation shared by clones.
#[derive(Clone, Default)]
pub struct Cancel {
    inner: Arc<Inner>,
}

impl Cancel {
    pub fn new() -> Cancel {
        Cancel::default()
    }

    /// Whether the job was cancelled before its commit boundary.
    pub fn is_cancelled(&self) -> bool {
        self.inner.state.load(Ordering::SeqCst) == CANCELLED
    }

    /// Runs `waker` when the cancellation happens: at once when it already has. Each waker runs once.
    pub fn on_cancel(&self, waker: impl FnOnce() + Send + 'static) {
        let mut wakers = self.inner.wakers.lock().unwrap_or_else(|e| e.into_inner());
        wakers.push(Box::new(waker));
        // Cancellation never waits for registration's lock. The registering worker delivers every
        // pending wake if cancellation raced it, including wakes registered before this one.
        drop(wakers);
        // Test after releasing the lock: a cancel between the test and unlock must not lose wakes.
        if self.is_cancelled() { self.cancel(); }
    }

    /// Cancels without waiting for registration. Ready wakers run here; a racing registration delivers the rest.
    /// Cancelling twice is harmless.
    /// Returns whether the job is cancelled; it is not when the commit boundary was already crossed (too late).
    pub fn cancel(&self) -> bool {
        match self.inner.state.compare_exchange(RUNNING, CANCELLED, Ordering::SeqCst, Ordering::SeqCst) {
            Ok(_) | Err(CANCELLED) => {
                if let Ok(mut registered) = self.inner.wakers.try_lock() {
                    let wakers = std::mem::take(&mut *registered);
                    drop(registered);
                    for waker in wakers { waker(); }
                }
                true
            }
            Err(_) => false,
        }
    }

    /// Crosses the commit boundary: `true` when the job may replace its destination (and a cancel is from now on too
    /// late), `false` when it was cancelled first.
    pub fn begin_commit(&self) -> bool {
        self.inner.state.compare_exchange(RUNNING, COMMITTING, Ordering::SeqCst, Ordering::SeqCst).is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn cancel_never_waits_for_a_worker_registering_its_waker() {
        let cancel = Cancel::new();
        let registered = cancel.inner.wakers.lock().unwrap();
        let (send, receive) = std::sync::mpsc::channel();
        let worker = cancel.clone();
        let thread = std::thread::spawn(move || { send.send(worker.cancel()).unwrap(); });
        let result = receive.recv_timeout(std::time::Duration::from_secs(1));
        drop(registered);
        thread.join().unwrap();
        assert_eq!(result, Ok(true), "the cancel returns while the registration lock is held");
        let woken = Arc::new(AtomicUsize::new(0)); let seen = woken.clone();
        cancel.on_cancel(move || { seen.fetch_add(1, Ordering::SeqCst); });
        assert_eq!(woken.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn wakers_run_once_on_the_cancelling_thread_and_late_ones_run_at_once() {
        let cancel = Cancel::new();
        let count = Arc::new(AtomicUsize::new(0));
        let first = count.clone();
        cancel.on_cancel(move || {
            first.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(count.load(Ordering::SeqCst), 0);
        cancel.cancel();
        cancel.cancel();
        assert_eq!(count.load(Ordering::SeqCst), 1);
        let late = count.clone();
        cancel.on_cancel(move || {
            late.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(count.load(Ordering::SeqCst), 2);
        assert!(cancel.is_cancelled());
    }

    #[test]
    fn a_waker_wakes_a_blocked_thread() {
        let cancel = Cancel::new();
        let pair = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
        let waker = pair.clone();
        cancel.on_cancel(move || {
            *waker.0.lock().unwrap() = true;
            waker.1.notify_all();
        });
        let blocked = {
            let pair = pair.clone();
            std::thread::spawn(move || {
                let mut done = pair.0.lock().unwrap();
                while !*done {
                    done = pair.1.wait(done).unwrap();
                }
            })
        };
        cancel.cancel();
        blocked.join().unwrap();
    }

    #[test]
    fn a_cancel_before_the_commit_boundary_refuses_the_commit() {
        let cancel = Cancel::new();
        assert!(cancel.cancel());
        assert!(!cancel.begin_commit());
    }

    #[test]
    fn a_cancel_after_the_commit_boundary_is_too_late_and_wakes_nothing() {
        let cancel = Cancel::new();
        let woken = Arc::new(AtomicUsize::new(0));
        let seen = woken.clone();
        cancel.on_cancel(move || {
            seen.fetch_add(1, Ordering::SeqCst);
        });
        assert!(cancel.begin_commit());
        assert!(!cancel.cancel(), "the commit is under way");
        assert!(!cancel.is_cancelled());
        assert_eq!(woken.load(Ordering::SeqCst), 0);
    }
}
