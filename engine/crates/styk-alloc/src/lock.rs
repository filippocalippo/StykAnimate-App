//! The lock of the shared allocator.
//!
//! One word, free (0) or held (1); a thread that finds it held spins until it is free. The holds are short (a batch of blocks moved
//! between a cache and the heap, a few hundred nanoseconds, or a `memory.grow` of a millisecond or two), and a thread that sleeps
//! instead has to be woken, which costs far more than it saves. The interface thread of a browser must not block (D7) in any case,
//! and only the page's own thread can be told from the others by the page: wasm-bindgen runs a module's start function on the first
//! thread only.

use std::sync::atomic::{AtomicU32, Ordering};

pub struct Lock {
    state: AtomicU32,
}

impl Lock {
    pub const fn new() -> Lock {
        Lock { state: AtomicU32::new(0) }
    }

    #[inline]
    pub fn lock(&self) {
        while self.state.compare_exchange_weak(0, 1, Ordering::Acquire, Ordering::Relaxed).is_err() {
            // Look at the word without writing it until it is free, so that the waiting threads do not take the line from the holder.
            while self.state.load(Ordering::Relaxed) != 0 {
                std::hint::spin_loop();
            }
        }
    }

    #[inline]
    pub fn unlock(&self) {
        self.state.store(0, Ordering::Release);
    }
}
