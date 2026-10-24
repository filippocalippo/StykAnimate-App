//! Worker locking and one-shot interface readiness reads.
//!
//! [`Shared::lock`] spins under contention and belongs on workers. Interface
//! admission must use [`Shared::try_lock`] and preserve the previous owner when
//! unavailable; a short critical section does not justify waiting on the UI.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Condvar, Mutex, MutexGuard};

#[cfg(not(test))]
type LockGuard<'a, T> = MutexGuard<'a, T>;
#[cfg(test)]
pub(crate) struct LockGuard<'a, T> { guard: MutexGuard<'a, T>, traced: bool }
#[cfg(test)]
impl<T> std::ops::Deref for LockGuard<'_, T> { type Target = T; fn deref(&self) -> &T { &self.guard } }
#[cfg(test)]
impl<T> std::ops::DerefMut for LockGuard<'_, T> { fn deref_mut(&mut self) -> &mut T { &mut self.guard } }
#[cfg(test)]
impl<T> Drop for LockGuard<'_, T> { fn drop(&mut self) { crate::allocation::leave(self.traced); } }

pub struct Shared<T> {
    value: Mutex<T>,
    /// Counts publications of new work, so a worker never sleeps through one.
    sequence: AtomicU32,
    sleep: Mutex<()>,
    wake: Condvar,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn try_lock_is_one_attempt_and_does_not_enter_worker_pause() {
        let shared = Shared::new(7);
        let guard = shared.lock();
        let pointer = &shared as *const _ as usize;
        assert!(crate::allocation::with_failure(pointer, 1, || shared.try_lock()).is_none());
        drop(guard);
        let guard = crate::allocation::with_failure(pointer, 1, || shared.try_lock()).unwrap();
        assert_eq!(*guard, 7);
    }

    #[test]
    fn try_lock_recovers_same_poisoned_owner() {
        let shared = std::sync::Arc::new(Shared::new(7));
        let worker = shared.clone();
        assert!(std::thread::spawn(move || { *worker.lock() = 9; panic!("poison owner"); }).join().is_err());
        assert_eq!(*shared.try_lock().unwrap(), 9);
    }

    #[test]
    fn try_lock_preserves_allocator_guard_instrumentation() {
        let shared = Shared::new(7);
        let pointer = &shared as *const _ as usize;
        let (_, counts) = crate::allocation::watch(pointer, || {
            let mut guard = shared.try_lock().unwrap();
            assert!(crate::allocation::active());
            *guard = 9;
            drop(guard);
            assert!(!crate::allocation::active());
        });
        assert_eq!(counts, crate::allocation::Counts { locks: 1, allocations: 0, deallocations: 0 });
        assert_eq!(*shared.try_lock().unwrap(), 9);
    }
}

impl<T> Shared<T> {
    pub fn new(value: T) -> Shared<T> {
        Shared { value: Mutex::new(value), sequence: AtomicU32::new(0), sleep: Mutex::new(()), wake: Condvar::new() }
    }

    /// One attempt, with the same poisoning recovery and traced guard as lock.
    /// A busy owner returns None; this never spins, waits or enters a test pause.
    pub fn try_lock(&self) -> Option<LockGuard<'_, T>> {
        let guard = match self.value.try_lock() {
            Ok(guard) => guard,
            Err(std::sync::TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
            Err(std::sync::TryLockError::WouldBlock) => return None,
        };
        #[cfg(not(test))] { Some(guard) }
        #[cfg(test)] { Some(LockGuard { guard, traced: crate::allocation::enter(self as *const Self as usize) }) }
    }

    /// Takes the lock, spinning while another thread holds it.
    pub fn lock(&self) -> LockGuard<'_, T> {
        #[cfg(test)]
        crate::allocation::before_lock(self as *const Self as usize);
        loop {
            match self.value.try_lock() {
                Ok(guard) => {
                    #[cfg(not(test))] { return guard }
                    #[cfg(test)] { return LockGuard { guard, traced: crate::allocation::enter(self as *const Self as usize) } }
                },
                // A thread that panicked while holding the lock left consistent data:
                // critical sections here only move values.
                Err(std::sync::TryLockError::Poisoned(poisoned)) => {
                    let guard = poisoned.into_inner();
                    #[cfg(not(test))] { return guard }
                    #[cfg(test)] { return LockGuard { guard, traced: crate::allocation::enter(self as *const Self as usize) } }
                },
                Err(std::sync::TryLockError::WouldBlock) => std::hint::spin_loop(),
            }
        }
    }

    /// Wakes every sleeping worker. Call after publishing work, without the lock held.
    pub fn notify_all(&self) {
        self.sequence.fetch_add(1, Ordering::SeqCst);
        // Workers re-check the sequence under this mutex before sleeping. The interface
        // thread only tries it: if a worker is between its check and its sleep, the
        // timeout in `wait_for_work` bounds the delay.
        if let Ok(_guard) = self.sleep.try_lock() {
            self.wake.notify_all();
        } else {
            self.wake.notify_all();
        }
    }

    /// Sleeps the calling worker until work is published or `stopping` is set.
    pub fn wait_for_work(&self, stopping: &AtomicBool) {
        let seen = self.sequence.load(Ordering::SeqCst);
        let guard = match self.sleep.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        if self.sequence.load(Ordering::SeqCst) != seen || stopping.load(Ordering::SeqCst) {
            return;
        }
        // The timeout covers a notification that raced the check above.
        let _ = self.wake.wait_timeout(guard, std::time::Duration::from_millis(50));
    }
}
