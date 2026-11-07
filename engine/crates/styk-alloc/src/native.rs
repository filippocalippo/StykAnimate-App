//! The counting allocator of native programs: the system allocator, with the bytes handed out counted ([`crate::live_bytes`],
//! [`crate::peak_bytes`]), so that [`crate::reserve`] and [`crate::Reservation::overrun`] see what a native program holds as they do
//! in WebAssembly. It refuses nothing itself: work that can be refused asks (`reserve`, `overrun`) between its steps.
//!
//! Install it with `#[global_allocator] static ALLOCATOR: styk_alloc::Counting = styk_alloc::Counting;`. A program that does not
//! install it counts nothing, as before.

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::Ordering;

use crate::{LIVE, PEAK};

/// The system allocator, counting.
pub struct Counting;

#[inline]
fn add(bytes: usize) {
    let now = LIVE.fetch_add(bytes, Ordering::Relaxed).wrapping_add(bytes);
    PEAK.fetch_max((now as isize).max(0) as usize, Ordering::Relaxed);
}

#[inline]
fn take(bytes: usize) {
    LIVE.fetch_sub(bytes, Ordering::Relaxed);
}

// SAFETY: every call is the system allocator's, with the size counted around it.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() {
            add(layout.size());
        }
        pointer
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc_zeroed(layout) };
        if !pointer.is_null() {
            add(layout.size());
        }
        pointer
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let moved = unsafe { System.realloc(pointer, layout, new_size) };
        if !moved.is_null() {
            take(layout.size());
            add(new_size);
        }
        moved
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { System.dealloc(pointer, layout) };
        take(layout.size());
    }
}
