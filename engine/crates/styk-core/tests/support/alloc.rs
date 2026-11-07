//! A counting global allocator for the tests that bound memory: bytes live now, the peak since the last reset, and the bytes
//! freed on the calling thread. Include it from a test binary with its own `#[global_allocator]`:
//!
//!     #[path = "support/alloc.rs"] mod alloc;
//!     #[global_allocator] static COUNTING: alloc::Counting = alloc::Counting;
#![allow(dead_code)]

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::sync::atomic::{AtomicUsize, Ordering};

static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

thread_local! {
    static FREED_HERE: Cell<usize> = const { Cell::new(0) };
}

pub struct Counting;

// SAFETY: every call is forwarded to the system allocator; the counters are atomics or a const-initialised thread local without
// a destructor, so counting never allocates.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() {
            let live = LIVE.fetch_add(layout.size(), Ordering::SeqCst) + layout.size();
            PEAK.fetch_max(live, Ordering::SeqCst);
        }
        pointer
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { System.dealloc(pointer, layout) };
        LIVE.fetch_sub(layout.size(), Ordering::SeqCst);
        let _ = FREED_HERE.try_with(|freed| freed.set(freed.get() + layout.size()));
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc_zeroed(layout) };
        if !pointer.is_null() {
            let live = LIVE.fetch_add(layout.size(), Ordering::SeqCst) + layout.size();
            PEAK.fetch_max(live, Ordering::SeqCst);
        }
        pointer
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let moved = unsafe { System.realloc(pointer, layout, new_size) };
        if !moved.is_null() {
            if new_size >= layout.size() {
                let live = LIVE.fetch_add(new_size - layout.size(), Ordering::SeqCst) + (new_size - layout.size());
                PEAK.fetch_max(live, Ordering::SeqCst);
            } else {
                LIVE.fetch_sub(layout.size() - new_size, Ordering::SeqCst);
                let _ = FREED_HERE.try_with(|freed| freed.set(freed.get() + (layout.size() - new_size)));
            }
        }
        moved
    }
}

/// Bytes allocated and not freed.
pub fn live() -> usize {
    LIVE.load(Ordering::SeqCst)
}

/// Restarts the peak from the bytes live now; returns them.
pub fn reset_peak() -> usize {
    let now = live();
    PEAK.store(now, Ordering::SeqCst);
    now
}

/// The most bytes live at once since `reset_peak`.
pub fn peak() -> usize {
    PEAK.load(Ordering::SeqCst)
}

/// Bytes the calling thread has freed so far.
pub fn freed_here() -> usize {
    FREED_HERE.with(|freed| freed.get())
}
