//! The lock of the shared allocator.
//!
//! Three states in one word: free (0), held (1), held with threads asleep on it (2). A thread that finds the lock held spins a
//! short while (the holder is usually inside the allocator for well under a microsecond), then sleeps on the word until the
//! holder wakes one thread as it lets go. A sleeping thread burns no core, where the toolchain's own allocator lock spins
//! for as long as it takes.
//!
//! The interface thread of a browser must never block (D7): it is told so (`can_sleep` false) and keeps spinning, which it
//! also did before. A thread sleeps only where the page allows it, and only after the spin, so a lock held for a moment never
//! costs a sleep.

use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};

/// How many times a thread looks at a held lock before it sleeps on it: a few microseconds. Measured on the open of a large document, the
/// holds are short (a thread that waited spun about five hundred times), and a sleep costs far more than that to end.
const SPINS: u32 = 4096;

/// Threads that found the lock held, and those of them that went to sleep on it (all threads together, since the module started).
static CONTENDED: AtomicUsize = AtomicUsize::new(0);
static SLEPT: AtomicUsize = AtomicUsize::new(0);

/// How often the lock was found held, and how often the thread that found it so went to sleep.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub fn contention() -> (usize, usize) {
    (CONTENDED.load(Ordering::Relaxed), SLEPT.load(Ordering::Relaxed))
}

pub struct Lock {
    state: AtomicU32,
}

impl Lock {
    pub const fn new() -> Lock {
        Lock { state: AtomicU32::new(0) }
    }

    #[inline]
    pub fn lock(&self, can_sleep: impl FnOnce() -> bool) {
        if self.state.compare_exchange(0, 1, Ordering::Acquire, Ordering::Relaxed).is_err() {
            self.lock_contended(can_sleep);
        }
    }

    #[cold]
    #[inline(never)]
    fn lock_contended(&self, can_sleep: impl FnOnce() -> bool) {
        CONTENDED.fetch_add(1, Ordering::Relaxed);
        let mut spins = 0;
        let mut can_sleep = Some(can_sleep);
        loop {
            if self.state.load(Ordering::Relaxed) == 0 && self.state.compare_exchange(0, 1, Ordering::Acquire, Ordering::Relaxed).is_ok() {
                return;
            }
            spins += 1;
            if spins >= SPINS {
                // Asked once, and only by a thread that has waited this long.
                if can_sleep.take().is_some_and(|may| may()) {
                    break;
                }
                spins = 0;
            }
            relax();
        }
        // Say that someone sleeps, so that the holder wakes one. Whoever takes the lock from here on leaves it marked: there may be
        // other sleepers, and one of them is woken by the next release.
        SLEPT.fetch_add(1, Ordering::Relaxed);
        while self.state.swap(2, Ordering::Acquire) != 0 {
            sleep(&self.state, 2);
        }
    }

    #[inline]
    pub fn unlock(&self) {
        if self.state.swap(0, Ordering::Release) == 2 {
            wake(&self.state);
        }
    }
}

#[inline]
fn relax() {
    #[cfg(target_arch = "wasm32")]
    {
        // WebAssembly has no pause instruction: the loop itself is the wait.
    }
    #[cfg(not(target_arch = "wasm32"))]
    std::hint::spin_loop();
}

#[cfg(all(target_arch = "wasm32", target_feature = "atomics"))]
fn sleep(word: &AtomicU32, while_value: u32) {
    // SAFETY: the word is in the shared memory; a thread that may not sleep never gets here.
    unsafe { core::arch::wasm32::memory_atomic_wait32(word.as_ptr() as *mut i32, while_value as i32, -1) };
}

#[cfg(all(target_arch = "wasm32", target_feature = "atomics"))]
fn wake(word: &AtomicU32) {
    // SAFETY: as above.
    unsafe { core::arch::wasm32::memory_atomic_notify(word.as_ptr() as *mut i32, 1) };
}

// Where there is no futex (the native tests): sleeping is giving up the processor, and nobody needs waking.
#[cfg(not(all(target_arch = "wasm32", target_feature = "atomics")))]
fn sleep(_word: &AtomicU32, _while_value: u32) {
    std::thread::yield_now();
}

#[cfg(not(all(target_arch = "wasm32", target_feature = "atomics")))]
fn wake(_word: &AtomicU32) {}
