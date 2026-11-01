//! The global allocator of the WebAssembly modules (see the crate's documentation).

use super::{LARGE_BYTES, LIMIT, LIVE, PAGE_BYTES, PEAK, grow_ahead_pages, refuses};
use std::alloc::{GlobalAlloc, Layout, System};
use std::arch::wasm32::memory_size;
use std::sync::atomic::Ordering;

/// Bytes the module has handed out: the counter, plus what the calling thread has counted for itself and not yet added ([`Local::delta`]);
/// the other threads' own are not seen (at most [`DELTA_FLUSH`] each). Frees can reach the counter before the allocations they undo (they
/// come from another thread), so it wraps and is read as signed.
#[inline]
pub fn live() -> usize {
    #[allow(unused_mut)]
    let mut counter = LIVE.load(Ordering::Relaxed) as isize;
    #[cfg(target_feature = "atomics")]
    if let Some(own) = thread::with(|local| local.delta.get()) {
        counter = counter.wrapping_add(own);
    }
    counter.max(0) as usize
}

/// Adds `bytes` (negative to take away) to the counter and the peak.
#[inline]
fn publish(bytes: isize) {
    let now = LIVE.fetch_add(bytes as usize, Ordering::Relaxed).wrapping_add(bytes as usize);
    let now = (now as isize).max(0) as usize;
    if bytes > 0 && now > PEAK.load(Ordering::Relaxed) {
        PEAK.fetch_max(now, Ordering::Relaxed);
    }
}

/// After a hold of the lock in which the memory grew: claim the next step now. The block is allocated from the standard allocator
/// (which grows the memory by exactly its size) and freed at once; dlmalloc keeps the pages as free space and cannot give them
/// back to WebAssembly, so they serve the allocations to come. A step the memory cannot grow by is halved until one fits; below a
/// page the memory is at its maximum and the allocator carries on as it was.
///
/// # Safety
/// The lock is held.
#[inline]
unsafe fn grow_ahead(before: usize) {
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

/// Where the threads of the module are told apart, and the allocator's lock and caches.
#[cfg(target_feature = "atomics")]
mod thread {
    use crate::cache::ThreadCache;
    use crate::lock::Lock;
    use std::cell::Cell;

    // The LLVM intrinsic behind the compiler's own thread-local accesses: this thread's `__tls_base`.
    unsafe extern "C" {
        #[link_name = "llvm.wasm.tls.base"]
        fn tls_base() -> *mut u8;
    }

    /// What one thread keeps for itself.
    pub struct Local {
        pub cache: ThreadCache,
        /// Bytes this thread has handed out less bytes it has taken back, not yet added to the shared counter.
        pub delta: Cell<isize>,
        /// Whether this thread may sleep: the interface thread of a browser may not.
        pub may_sleep: Cell<bool>,
    }

    thread_local! {
        static LOCAL: Local = const { Local { cache: ThreadCache::new(), delta: Cell::new(0), may_sleep: Cell::new(false) } };
    }

    /// This thread's `__tls_base`, or 0 when it has none to use. `wasm-bindgen` starts a thread by allocating its stack and its
    /// thread-local block, with the base still 0, and ends it by freeing them with the base set to an address no memory has.
    #[inline]
    pub fn base() -> usize {
        let base = unsafe { tls_base() } as usize;
        if base == 0 || base >= 0x8000_0000 { 0 } else { base }
    }

    /// Runs `f` on this thread's cache and counters; `None` while the thread has no thread-local block.
    #[inline]
    pub fn with<R>(f: impl FnOnce(&Local) -> R) -> Option<R> {
        if base() == 0 { None } else { Some(LOCAL.with(f)) }
    }

    static LOCK: Lock = Lock::new();

    #[inline]
    pub fn lock() {
        LOCK.lock(|| with(|local| local.may_sleep.get()).unwrap_or(false));
    }

    #[inline]
    pub fn unlock() {
        LOCK.unlock();
    }
}

/// How often the lock has been taken. Written only by the thread that holds it, so it is read and written, not added to.
#[cfg(target_feature = "atomics")]
static HOLDS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

#[cfg(target_feature = "atomics")]
pub fn holds() -> usize {
    HOLDS.load(Ordering::Relaxed)
}

/// The lock held, the standard allocator at hand.
pub struct Held {
    before: usize,
}

impl Held {
    #[inline]
    fn new() -> Held {
        #[cfg(target_feature = "atomics")]
        {
            thread::lock();
            HOLDS.store(HOLDS.load(Ordering::Relaxed).wrapping_add(1), Ordering::Relaxed);
        }
        Held { before: memory_size::<0>() }
    }
}

impl Drop for Held {
    #[inline]
    fn drop(&mut self) {
        // SAFETY: the lock is still held.
        unsafe { grow_ahead(self.before) };
        #[cfg(target_feature = "atomics")]
        thread::unlock();
    }
}

#[cfg(target_feature = "atomics")]
mod small {
    //! The caches in front of the heap.

    use super::{Held, System, publish, thread};
    use crate::cache::{self, MAX_ALIGN, MAX_SMALL, Shared, class_bytes, class_of};
    use std::alloc::{GlobalAlloc, Layout};

    /// The heap behind the caches.
    pub struct Heap;

    impl Shared for Heap {
        type Guard = Held;

        #[inline]
        fn lock(&self) -> Held {
            Held::new()
        }

        #[inline]
        unsafe fn alloc(&self, _: &Held, size: usize) -> *mut u8 {
            unsafe { System.alloc(Layout::from_size_align_unchecked(size, MAX_ALIGN)) }
        }

        #[inline]
        unsafe fn free(&self, _: &Held, block: *mut u8, size: usize) {
            unsafe { System.dealloc(block, Layout::from_size_align_unchecked(size, MAX_ALIGN)) }
        }
    }

    /// Whether a block of this layout is a small block (one of a class, whichever thread allocates or frees it).
    #[inline]
    pub fn is_small(layout: Layout) -> bool {
        layout.size() <= MAX_SMALL && layout.align() <= MAX_ALIGN
    }

    /// A block for a small layout.
    #[inline]
    pub unsafe fn alloc(layout: Layout) -> *mut u8 {
        let k = class_of(layout.size());
        match thread::with(|local| unsafe { cache::alloc(&Heap, &local.cache, k) }) {
            Some(block) => block,
            None => {
                let guard = Held::new();
                unsafe { Heap.alloc(&guard, class_bytes(k)) }
            }
        }
    }

    /// Takes back a block of a small layout.
    #[inline]
    pub unsafe fn free(block: *mut u8, layout: Layout) {
        let k = class_of(layout.size());
        if thread::with(|local| unsafe { cache::free(&Heap, &local.cache, k, block) }).is_none() {
            unsafe { free_to_heap(block, layout) };
        }
    }

    /// Takes back a block of a small layout straight to the heap, for a thread that has no cache to put it in.
    pub unsafe fn free_to_heap(block: *mut u8, layout: Layout) {
        let guard = Held::new();
        unsafe { Heap.free(&guard, block, class_bytes(class_of(layout.size()))) };
    }

    /// The thread is freeing its own thread-local block, the last thing it does with the allocator (`__wbindgen_thread_destroy`; the
    /// cache lives in that block): what it kept goes back to the heap, and what it counted for itself is added.
    pub unsafe fn retire() {
        thread::with(|local| {
            unsafe { cache::drain(&Heap, &local.cache) };
            let owed = local.delta.replace(0);
            if owed != 0 {
                publish(owed);
            }
        });
    }
}

/// The least a thread counts for itself before it adds to the shared counter, and the largest request it counts that way.
#[cfg(target_feature = "atomics")]
const DELTA_FLUSH: isize = 16 * 1024;
#[cfg(target_feature = "atomics")]
const DELTA_MAX_REQUEST: usize = 8 * 1024;

/// `size` more bytes are handed out.
#[inline]
fn took(size: usize) {
    #[cfg(target_feature = "atomics")]
    if size <= DELTA_MAX_REQUEST {
        let flushed = thread::with(|local| {
            let delta = local.delta.get() + size as isize;
            if delta >= DELTA_FLUSH {
                local.delta.set(0);
                Some(delta)
            } else {
                local.delta.set(delta);
                None
            }
        });
        match flushed {
            Some(Some(delta)) => publish(delta),
            Some(None) => {}
            None => publish(size as isize),
        }
        return;
    }
    publish(size as isize);
}

/// `size` bytes are taken back.
#[inline]
fn gave(size: usize) {
    #[cfg(target_feature = "atomics")]
    if size <= DELTA_MAX_REQUEST {
        let flushed = thread::with(|local| {
            let delta = local.delta.get() - size as isize;
            if delta <= -DELTA_FLUSH {
                local.delta.set(0);
                Some(delta)
            } else {
                local.delta.set(delta);
                None
            }
        });
        match flushed {
            Some(Some(delta)) => publish(delta),
            Some(None) => {}
            None => publish(-(size as isize)),
        }
        return;
    }
    publish(-(size as isize));
}

/// Marks the calling thread as one that may sleep on the allocator's lock: every thread but the interface thread of a page.
pub fn this_thread_may_sleep() {
    #[cfg(target_feature = "atomics")]
    thread::with(|local| local.may_sleep.set(true));
}

/// The standard allocator that grows the linear memory ahead of its needs, counts what it hands out, and keeps small blocks in
/// a cache for each thread.
///
/// Install it with `#[global_allocator] static ALLOCATOR: styk_alloc::GrowAhead = styk_alloc::GrowAhead;`.
pub struct GrowAhead;

impl GrowAhead {
    /// Whether a request for `size` more bytes is refused to keep the reserve.
    #[inline]
    fn refuses(size: usize) -> bool {
        size >= LARGE_BYTES && refuses(size, live(), LIMIT.load(Ordering::Relaxed))
    }
}

unsafe impl GlobalAlloc for GrowAhead {
    #[inline]
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        #[cfg(target_feature = "atomics")]
        if small::is_small(layout) {
            let block = unsafe { small::alloc(layout) };
            if !block.is_null() {
                took(layout.size());
            }
            return block;
        }
        if Self::refuses(layout.size()) {
            return std::ptr::null_mut();
        }
        let pointer = {
            let _held = Held::new();
            unsafe { System.alloc(layout) }
        };
        if !pointer.is_null() {
            took(layout.size());
        }
        pointer
    }

    #[inline]
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        #[cfg(target_feature = "atomics")]
        if small::is_small(layout) {
            let block = unsafe { small::alloc(layout) };
            if !block.is_null() {
                // SAFETY: the block holds at least the layout's size.
                unsafe { block.write_bytes(0, layout.size()) };
                took(layout.size());
            }
            return block;
        }
        if Self::refuses(layout.size()) {
            return std::ptr::null_mut();
        }
        let pointer = {
            let _held = Held::new();
            unsafe { System.alloc_zeroed(layout) }
        };
        if !pointer.is_null() {
            took(layout.size());
        }
        pointer
    }

    #[inline]
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        gave(layout.size());
        #[cfg(target_feature = "atomics")]
        {
            let retiring = pointer as usize == thread::base();
            if retiring {
                unsafe { small::retire() };
            }
            // A block of a class goes back to its class: the heap's when the thread is gone, else this thread's cache.
            if small::is_small(layout) {
                return if retiring { unsafe { small::free_to_heap(pointer, layout) } } else { unsafe { small::free(pointer, layout) } };
            }
        }
        let _held = Held::new();
        unsafe { System.dealloc(pointer, layout) }
    }

    #[inline]
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        #[cfg(target_feature = "atomics")]
        {
            // SAFETY: the new size is the caller's, valid for the layout's alignment.
            let grown = unsafe { Layout::from_size_align_unchecked(new_size, layout.align()) };
            if small::is_small(layout) || small::is_small(grown) {
                // A block of a class holds the class's bytes: a request that stays in its class keeps its block.
                if small::is_small(layout) && small::is_small(grown) && crate::cache::class_of(layout.size()) == crate::cache::class_of(new_size) {
                    if new_size >= layout.size() {
                        took(new_size - layout.size());
                    } else {
                        gave(layout.size() - new_size);
                    }
                    return pointer;
                }
                let moved = unsafe { self.alloc(grown) };
                if !moved.is_null() {
                    // SAFETY: both blocks hold at least the smaller size, and they are different blocks.
                    unsafe {
                        std::ptr::copy_nonoverlapping(pointer, moved, layout.size().min(new_size));
                        self.dealloc(pointer, layout);
                    }
                }
                return moved;
            }
        }
        if new_size > layout.size() && Self::refuses(new_size - layout.size()) {
            return std::ptr::null_mut();
        }
        let moved = {
            let _held = Held::new();
            unsafe { System.realloc(pointer, layout, new_size) }
        };
        if !moved.is_null() {
            if new_size >= layout.size() {
                took(new_size - layout.size());
            } else {
                gave(layout.size() - new_size);
            }
        }
        moved
    }
}
