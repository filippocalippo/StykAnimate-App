//! The allocator of the engine's WebAssembly modules.
//!
//! Rust's allocator on `wasm32-unknown-unknown` (dlmalloc) asks the host for more linear
//! memory exactly when its free space runs out: one 64 KiB page at a time for the many
//! small records of a document. Each `memory.grow` is a call into the host, which commits
//! the pages and replaces the memory's buffer, and costs about a millisecond whatever the
//! size of the step (measured in Node on Windows on a large memory: 1.1 to 1.7 ms for 1 page or 2048 pages
//! alike). Opening a large Pivot file made tens of thousands of them and spent most of its
//! time there.
//!
//! [`GrowAhead`] is the standard allocator, and whenever that allocator had to grow the
//! memory it grows it further in one step ([`grow_ahead_pages`]) and hands the extra pages
//! back to the allocator's free space. Allocation results are unchanged; the memory
//! reaches the same size in a few dozen steps instead of tens of thousands, and ends at
//! most one step larger than the document needs. A memory that cannot grow that far (its
//! maximum, D14) is grown by the largest step that fits, down to what the allocation asked.
//!
//! # Running out of memory
//!
//! A failed allocation that nothing checks aborts the module (`unreachable`), and a module that
//! aborted is gone for good. The allocator therefore counts the bytes it has handed out
//! ([`live_bytes`]) against a limit the host sets to the memory's maximum ([`set_limit`]) and keeps
//! the last sixteenth of it ([`ceiling`]) for the small allocations nothing can refuse (a record, a
//! string, an error message). A request of [`LARGE_BYTES`] or more that would reach into that
//! reserve is refused with a null pointer: code that allocates fallibly (`Vec::try_reserve`) gets
//! an error it can report. Work that allocates in many pieces (opening a document, decoding a
//! picture, an editing call) first [`reserve`]s the most it expects to need and refuses itself
//! when the memory cannot give it; the reservation counts against every other request until it is
//! dropped. Callers only ever see [`OutOfMemory`].
//!
//! A module whose limit is not set (the codec, the drawing engine) is never refused. Native builds
//! use the system allocator, which does not count: there [`live_bytes`] stays 0 and only a limit a
//! test sets ([`with_limit`]) makes [`admit`] refuse.

use std::sync::atomic::{AtomicUsize, Ordering};

/// WebAssembly pages are 64 KiB.
pub const PAGE_BYTES: usize = 64 * 1024;
/// The least memory added in one step: 16 MiB.
const MIN_AHEAD_PAGES: usize = 256;
/// The most memory added in one step: 128 MiB.
const MAX_AHEAD_PAGES: usize = 2048;
/// Requests of this size or more are refused when they would reach into the reserve: 256 KiB.
pub const LARGE_BYTES: usize = 256 * 1024;

/// How many pages to add ahead of the allocator when a memory of `current` pages had to
/// grow: an eighth of the memory, between 16 and 128 MiB, so the number of steps stays
/// logarithmic while the unused tail stays small next to a large document.
pub fn grow_ahead_pages(current: usize) -> usize {
    (current / 8).clamp(MIN_AHEAD_PAGES, MAX_AHEAD_PAGES)
}

/// Bytes the allocator has handed out and not taken back (WebAssembly modules only).
static LIVE: AtomicUsize = AtomicUsize::new(0);
/// The most bytes the host lets the module hold: the memory's maximum. Unset: no limit.
static LIMIT: AtomicUsize = AtomicUsize::new(usize::MAX);

/// Bytes work in progress has reserved ([`reserve`]) and not released yet.
static RESERVED: AtomicUsize = AtomicUsize::new(0);
/// The most bytes handed out at once since the module started or [`reset_peak`] (WebAssembly modules only).
static PEAK: AtomicUsize = AtomicUsize::new(0);

/// Bytes handed out and not freed yet, by the allocator of this module. Zero where the allocator does not count.
pub fn live_bytes() -> usize {
    LIVE.load(Ordering::Relaxed)
}

/// The most bytes that were handed out at once since the module started or the last [`reset_peak`].
pub fn peak_bytes() -> usize {
    PEAK.load(Ordering::Relaxed)
}

/// Starts measuring the peak again from what is handed out now.
pub fn reset_peak() {
    PEAK.store(LIVE.load(Ordering::Relaxed), Ordering::Relaxed);
}

/// Sets the memory the module may use: the maximum of the memory it was given. Once, when the engine starts.
pub fn set_limit(bytes: usize) {
    LIMIT.store(bytes, Ordering::Relaxed);
}

#[cfg(not(target_arch = "wasm32"))]
thread_local! {
    /// A limit a test sets for its own thread.
    static TEST_LIMIT: std::cell::Cell<Option<usize>> = const { std::cell::Cell::new(None) };
}

/// Runs `run` with the module's limit set to `bytes` on this thread: the way a native test makes [`admit`] refuse.
#[cfg(not(target_arch = "wasm32"))]
pub fn with_limit<T>(bytes: usize, run: impl FnOnce() -> T) -> T {
    struct Restore(Option<usize>);
    impl Drop for Restore {
        fn drop(&mut self) {
            TEST_LIMIT.with(|limit| limit.set(self.0));
        }
    }
    let _restore = Restore(TEST_LIMIT.with(|limit| limit.replace(Some(bytes))));
    run()
}

fn limit() -> usize {
    #[cfg(not(target_arch = "wasm32"))]
    if let Some(bytes) = TEST_LIMIT.with(std::cell::Cell::get) {
        return bytes;
    }
    LIMIT.load(Ordering::Relaxed)
}

/// What the module may hold before large requests are refused: its limit less the reserve (a sixteenth).
pub fn ceiling() -> usize {
    let limit = limit();
    limit - limit / 16
}

/// Bytes a request may still take before it reaches into the reserve: what is neither handed out nor reserved.
pub fn headroom() -> usize {
    ceiling().saturating_sub(live_bytes()).saturating_sub(RESERVED.load(Ordering::Relaxed))
}

/// Bytes work in progress has reserved.
pub fn reserved_bytes() -> usize {
    RESERVED.load(Ordering::Relaxed)
}

/// The module is too low on memory for the work asked of it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OutOfMemory {
    /// Bytes the work needs, as far as the caller knew.
    pub requested: usize,
    /// Bytes the module could still give.
    pub available: usize,
}

impl std::fmt::Display for OutOfMemory {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "the engine is out of memory: {} MiB wanted, {} MiB available", self.requested.div_ceil(1 << 20), self.available >> 20)
    }
}

impl std::error::Error for OutOfMemory {}

/// Whether the module can take `bytes` more without reaching into its reserve. For work that
/// allocates in many small pieces (a document's tree), where the caller knows its size ahead.
pub fn admit(bytes: usize) -> Result<(), OutOfMemory> {
    let available = headroom();
    if bytes > available { Err(OutOfMemory { requested: bytes, available }) } else { Ok(()) }
}

/// Memory set aside for work in progress, until dropped (see [`reserve`]).
#[derive(Debug)]
pub struct Reservation {
    bytes: usize,
}

impl Reservation {
    /// The bytes held.
    pub fn bytes(&self) -> usize {
        self.bytes
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        RESERVED.fetch_sub(self.bytes, Ordering::Relaxed);
    }
}

/// Sets `bytes` aside for work that is about to allocate about that much, in pieces nothing can refuse: the
/// work holds the reservation until it is done and goes without when the module cannot give it.
pub fn reserve(bytes: usize) -> Result<Reservation, OutOfMemory> {
    let mut reserved = RESERVED.load(Ordering::Relaxed);
    loop {
        let available = ceiling().saturating_sub(live_bytes()).saturating_sub(reserved);
        if bytes > available {
            return Err(OutOfMemory { requested: bytes, available });
        }
        match RESERVED.compare_exchange_weak(reserved, reserved + bytes, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => return Ok(Reservation { bytes }),
            Err(now) => reserved = now,
        }
    }
}

/// Whether the allocator refuses a request of `size` bytes with `live` bytes handed out under `limit`.
#[cfg(any(target_arch = "wasm32", test))]
fn refuses(size: usize, live: usize, limit: usize) -> bool {
    size >= LARGE_BYTES && live.saturating_add(size) > limit - limit / 16
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::{LIMIT, LIVE, PAGE_BYTES, PEAK, grow_ahead_pages, refuses};
    use std::alloc::{GlobalAlloc, Layout, System};
    use std::arch::wasm32::memory_size;
    use std::sync::atomic::Ordering;

    /// The standard allocator that grows the linear memory ahead of its needs and counts what it hands out.
    ///
    /// Install it with `#[global_allocator] static ALLOCATOR: styk_alloc::GrowAhead = styk_alloc::GrowAhead;`.
    pub struct GrowAhead;

    impl GrowAhead {
        /// Called after an allocation: if the memory grew to satisfy it, claim the next step
        /// now. The block is allocated from the standard allocator (which grows the memory
        /// by exactly its size) and freed at once; dlmalloc keeps the pages as free space
        /// and cannot give them back to WebAssembly, so they serve the allocations to come.
        /// A step the memory cannot grow by is halved until one fits; below a page the
        /// memory is at its maximum and the allocator carries on as it was.
        #[inline]
        unsafe fn after(before: usize) {
            let now = memory_size::<0>();
            if now == before {
                return;
            }
            let mut pages = grow_ahead_pages(now);
            while pages > 0 {
                // SAFETY: a nonzero size with a valid power-of-two alignment; the block is freed with its own layout.
                unsafe {
                    let layout = Layout::from_size_align_unchecked(pages * PAGE_BYTES, 16);
                    let block = System.alloc(layout);
                    if !block.is_null() {
                        System.dealloc(block, layout);
                        return;
                    }
                }
                pages /= 2;
            }
        }

        /// `size` more bytes are handed out.
        #[inline]
        fn took(size: usize) {
            let now = LIVE.fetch_add(size, Ordering::Relaxed) + size;
            if now > PEAK.load(Ordering::Relaxed) {
                PEAK.fetch_max(now, Ordering::Relaxed);
            }
        }

        /// Whether a request for `size` more bytes is refused to keep the reserve.
        #[inline]
        fn refuses(size: usize) -> bool {
            size >= super::LARGE_BYTES && refuses(size, LIVE.load(Ordering::Relaxed), LIMIT.load(Ordering::Relaxed))
        }
    }

    unsafe impl GlobalAlloc for GrowAhead {
        #[inline]
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            if Self::refuses(layout.size()) {
                return std::ptr::null_mut();
            }
            let before = memory_size::<0>();
            let pointer = unsafe { System.alloc(layout) };
            if !pointer.is_null() {
                Self::took(layout.size());
            }
            unsafe { Self::after(before) };
            pointer
        }

        #[inline]
        unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
            if Self::refuses(layout.size()) {
                return std::ptr::null_mut();
            }
            let before = memory_size::<0>();
            let pointer = unsafe { System.alloc_zeroed(layout) };
            if !pointer.is_null() {
                Self::took(layout.size());
            }
            unsafe { Self::after(before) };
            pointer
        }

        #[inline]
        unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
            LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
            unsafe { System.dealloc(pointer, layout) }
        }

        #[inline]
        unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
            if new_size > layout.size() && Self::refuses(new_size - layout.size()) {
                return std::ptr::null_mut();
            }
            let before = memory_size::<0>();
            let moved = unsafe { System.realloc(pointer, layout, new_size) };
            if !moved.is_null() {
                if new_size >= layout.size() {
                    Self::took(new_size - layout.size());
                } else {
                    LIVE.fetch_sub(layout.size() - new_size, Ordering::Relaxed);
                }
            }
            unsafe { Self::after(before) };
            moved
        }
    }
}

#[cfg(target_arch = "wasm32")]
pub use wasm::GrowAhead;

#[cfg(test)]
mod tests {
    use super::*;

    /// The reservations are counted for the whole process: tests that look at the headroom take turns.
    static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn steps_scale_with_the_memory_between_the_bounds() {
        assert_eq!(grow_ahead_pages(0), MIN_AHEAD_PAGES);
        assert_eq!(grow_ahead_pages(1024), MIN_AHEAD_PAGES, "a 64 MiB memory still grows 16 MiB at a time");
        assert_eq!(grow_ahead_pages(8192), 1024, "a 512 MiB memory grows by 64 MiB");
        assert_eq!(grow_ahead_pages(32768), MAX_AHEAD_PAGES, "a 2 GiB memory grows by 128 MiB");
        assert_eq!(grow_ahead_pages(usize::MAX), MAX_AHEAD_PAGES);
    }

    #[test]
    fn a_memory_reaches_a_large_document_in_few_steps() {
        let (mut pages, mut steps) = (256usize, 0);
        while pages < 24_000 {
            pages += grow_ahead_pages(pages);
            steps += 1;
        }
        assert!(steps < 60, "{steps} steps to reach 1.5 GiB");
    }

    #[test]
    fn a_large_request_is_refused_before_the_reserve_is_touched() {
        let limit = 2usize << 30;
        let ceiling = limit - limit / 16;
        assert!(!refuses(LARGE_BYTES, ceiling - LARGE_BYTES, limit), "a request that ends at the ceiling is served");
        assert!(refuses(LARGE_BYTES, ceiling - LARGE_BYTES + 1, limit), "a request that passes the ceiling is refused");
        assert!(!refuses(LARGE_BYTES - 1, ceiling, limit), "a small request may use the reserve");
        assert!(!refuses(usize::MAX / 2, 0, usize::MAX), "a module without a limit is never refused");
    }

    #[test]
    fn reservations_count_against_each_other_until_dropped() {
        let _turn = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        with_limit(64 << 20, || {
            let first = reserve(40 << 20).unwrap();
            assert_eq!(first.bytes(), 40 << 20);
            let before = reserved_bytes();
            assert_eq!(headroom(), (60 << 20) - (40 << 20));
            let refused = reserve(21 << 20).unwrap_err();
            assert_eq!((refused.requested, refused.available), (21 << 20, 20 << 20));
            assert_eq!(reserved_bytes(), before, "a refusal reserves nothing");
            let second = reserve(20 << 20).unwrap();
            assert_eq!(headroom(), 0);
            drop(first);
            assert_eq!(headroom(), 40 << 20, "dropping a reservation gives its bytes back");
            drop(second);
        });
    }

    #[test]
    fn work_that_does_not_fit_is_refused_with_the_figures() {
        let _turn = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        with_limit(64 << 20, || {
            assert_eq!(ceiling(), 60 << 20);
            assert_eq!(admit(60 << 20), Ok(()));
            let refused = admit(61 << 20).unwrap_err();
            assert_eq!((refused.requested, refused.available), (61 << 20, 60 << 20));
            assert_eq!(refused.to_string(), "the engine is out of memory: 61 MiB wanted, 60 MiB available");
        });
        assert_eq!(admit(usize::MAX / 2), Ok(()), "the limit a test set ends with it");
    }
}
