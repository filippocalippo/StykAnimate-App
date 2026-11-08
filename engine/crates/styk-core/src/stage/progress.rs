//! The stage's coalesced wake: what the frame scheduler, the paint worker and the platform's pen queue call from their
//! own threads when they have made progress, turned into at most one event-loop message (`docs/native/stage.md`).
//!
//! Any number of [`Progress::notify`] calls between two polls are one [`Progress::poll`] answer; a poll that finds
//! nothing leaves a waker, which the next notification wakes. The interface turns the answers into one
//! `Event::Progress`, whose handling is the one redraw (`styk_ui::stage::progress`). The one lock moves a waker and
//! is never held for anything else.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::task::Waker;

/// What a worker calls to say it made progress (the same closure type the frame scheduler and the painter take).
pub type Wake = Arc<dyn Fn() + Send + Sync>;

#[derive(Default)]
pub struct Progress {
    pending: AtomicBool,
    waker: Mutex<Option<Waker>>,
}

impl Progress {
    pub fn new() -> Arc<Progress> {
        Arc::new(Progress::default())
    }

    fn waker(&self) -> MutexGuard<'_, Option<Waker>> {
        self.waker.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Progress was made: the next poll answers, and a poll that is waiting is woken.
    pub fn notify(&self) {
        self.pending.store(true, Ordering::Release);
        let waker = self.waker().take();
        if let Some(waker) = waker {
            waker.wake();
        }
    }

    /// The closure the scheduler, the painter and the input queue call.
    pub fn wake(self: &Arc<Progress>) -> Wake {
        let progress = self.clone();
        Arc::new(move || progress.notify())
    }

    /// Whether progress was made since the last answer. When it was not, `waker` is woken by the next notification.
    pub fn poll(&self, waker: &Waker) -> bool {
        if self.pending.swap(false, Ordering::AcqRel) {
            return true;
        }
        *self.waker() = Some(waker.clone());
        // A notification between the check and the registration found no waker: take it from the flag.
        self.pending.swap(false, Ordering::AcqRel)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    struct Count(AtomicUsize);
    impl std::task::Wake for Count {
        fn wake(self: Arc<Self>) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[test]
    fn many_notifications_are_one_answer_and_one_wake() {
        let progress = Progress::new();
        let count = Arc::new(Count(AtomicUsize::new(0)));
        let waker = Waker::from(count.clone());
        assert!(!progress.poll(&waker), "nothing happened yet");
        for _ in 0..1000 {
            progress.notify();
        }
        assert_eq!(count.0.load(Ordering::SeqCst), 1, "the waiting poll is woken once");
        assert!(progress.poll(&waker), "a thousand notifications are one answer");
        assert!(!progress.poll(&waker), "and the next poll waits");
        progress.wake()();
        assert_eq!(count.0.load(Ordering::SeqCst), 2);
    }
}
