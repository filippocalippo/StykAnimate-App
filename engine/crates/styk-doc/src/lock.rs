//! Locks that code the interface thread runs may take.
//!
//! A browser's page thread may not wait (D7): the instruction a blocking `Mutex::lock` waits with, `memory.atomic.wait32`, throws there
//! (`RuntimeError: Atomics.wait cannot be called in this context`). The exception passes through the engine's own frames without
//! unwinding them, so the object the call was made on stays marked as borrowed for good and every later call on it, and on whatever it
//! was being used with, answers `recursive use of an object detected which would lead to unsafe aliasing in rust`: the stage stops
//! drawing and the document stops answering. A mutex that the interface thread and the workers both take, however short its critical
//! sections, is taken with [`once`] (a cache: skipped where busy) or, where the interface thread cannot go without it, [`spinning`].

use std::sync::{Mutex, MutexGuard, TryLockError};

/// One attempt at `mutex`: its guard, or nothing where another thread holds it (the data of one a thread panicked holding is given, as
/// [`spinning`] gives it). For what is an economy and not a necessity, a cache: where it is busy the work is done again.
pub fn once<T>(mutex: &Mutex<T>) -> Option<MutexGuard<'_, T>> {
    match mutex.try_lock() {
        Ok(guard) => Some(guard),
        Err(TryLockError::Poisoned(poisoned)) => Some(poisoned.into_inner()),
        Err(TryLockError::WouldBlock) => None,
    }
}

/// Takes `mutex`, spinning while another thread holds it, and the data of one a thread panicked holding (the critical sections these
/// locks guard only move values, so what a panic leaves is consistent).
pub fn spinning<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    loop {
        match mutex.try_lock() {
            Ok(guard) => return guard,
            Err(TryLockError::Poisoned(poisoned)) => return poisoned.into_inner(),
            Err(TryLockError::WouldBlock) => std::hint::spin_loop(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[test]
    fn a_lock_held_by_another_thread_is_waited_for_and_then_taken() {
        let mutex = Arc::new(Mutex::new(1));
        let held = Arc::new(AtomicBool::new(false));
        let holder = {
            let (mutex, held) = (mutex.clone(), held.clone());
            std::thread::spawn(move || {
                let mut guard = mutex.lock().unwrap();
                held.store(true, Ordering::SeqCst);
                std::thread::sleep(std::time::Duration::from_millis(30));
                *guard = 2;
            })
        };
        while !held.load(Ordering::SeqCst) {
            std::hint::spin_loop();
        }
        assert_eq!(*spinning(&mutex), 2, "the lock was taken after its holder let it go");
        holder.join().unwrap();
    }

    #[test]
    fn one_attempt_gives_nothing_where_the_lock_is_held_and_never_waits() {
        let mutex = Mutex::new(1);
        let guard = mutex.lock().unwrap();
        assert!(once(&mutex).is_none());
        drop(guard);
        assert_eq!(*once(&mutex).unwrap(), 1);
    }

    #[test]
    fn a_lock_whose_holder_panicked_gives_its_data() {
        let mutex = Arc::new(Mutex::new(7));
        let poisoner = mutex.clone();
        assert!(std::thread::spawn(move || { let _guard = poisoner.lock().unwrap(); panic!("poison"); }).join().is_err());
        assert_eq!(*spinning(&mutex), 7);
    }
}
