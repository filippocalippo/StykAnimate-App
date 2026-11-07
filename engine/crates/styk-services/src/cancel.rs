//! Cancellation that wakes what is blocked.
//!
//! A flag nobody reads in time is not cancellation: a writer blocked in a pipe write, a producer waiting for a free
//! buffer or a thread waiting for a child to exit never looks at a flag. [`Cancel`] holds the flag and a list of
//! *wakers*. Whatever can block registers a waker when it starts (end the child process, notify the condition
//! variable); [`Cancel::cancel`] sets the flag and runs them on the calling thread, so it returns at once and does not
//! depend on the thread that is blocked.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

type Waker = Box<dyn FnOnce() + Send>;

#[derive(Default)]
struct Inner {
    cancelled: AtomicBool,
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

    pub fn is_cancelled(&self) -> bool {
        self.inner.cancelled.load(Ordering::SeqCst)
    }

    /// Runs `waker` when the cancellation happens: at once when it already has. Each waker runs once.
    pub fn on_cancel(&self, waker: impl FnOnce() + Send + 'static) {
        let mut wakers = self.inner.wakers.lock().unwrap_or_else(|e| e.into_inner());
        if self.is_cancelled() {
            drop(wakers);
            waker();
        } else {
            wakers.push(Box::new(waker));
        }
    }

    /// Cancels: sets the flag, then runs every waker registered so far on this thread. Cancelling twice is harmless.
    pub fn cancel(&self) {
        let wakers = {
            let mut wakers = self.inner.wakers.lock().unwrap_or_else(|e| e.into_inner());
            self.inner.cancelled.store(true, Ordering::SeqCst);
            std::mem::take(&mut *wakers)
        };
        for waker in wakers {
            waker();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

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
}
