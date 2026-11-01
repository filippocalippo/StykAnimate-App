//! Per-thread caches of small blocks in front of a shared allocator.
//!
//! Every thread of the engine's WebAssembly module allocates from one heap behind one lock. The open of a document, a frame
//! on a worker and the interface thread together make millions of calls, most of them for blocks of a few dozen bytes, and
//! each call used to take that lock. A thread now keeps a short list of free blocks for each small size ([`ThreadCache`]): an
//! allocation takes the head of its list, a free pushes onto it, and the shared allocator is reached only to fill an empty
//! list or to empty a full one, a batch of blocks under one hold of the lock.
//!
//! A block belongs to no thread. The size comes with every free (`Layout`), so a block freed by another thread than the one
//! that allocated it simply joins the freeing thread's list; nothing records who made it. Every small block is allocated at
//! the full size of its class, so a block of the class always holds the class's bytes, whichever allocation it came from.
//!
//! The cache of one thread holds at most twice a batch of each class (about 2 KiB; 2.5 KiB for the largest), so a thread's cache
//! stays under 125 KiB however it is used, and typically holds a few KiB.

use std::cell::Cell;
use std::ptr::null_mut;

/// The alignment small blocks are allocated with: what the shared allocator gives without asking for more.
pub const MAX_ALIGN: usize = 8;
/// Classes are 8 * k + 4 bytes for k = 1..=63: the room the shared allocator's chunks (8-byte steps, 4 bytes of header) give,
/// so a class wastes nothing the allocator would not have wasted on the same request.
pub const CLASSES: usize = 64;
/// The largest request served from a cache.
pub const MAX_SMALL: usize = class_bytes(CLASSES - 1);
/// About how many bytes of a class move between a cache and the shared allocator at a time.
pub const BATCH_BYTES: usize = 1024;

/// The class of a request of `size` bytes (1 to [`MAX_SMALL`]).
#[inline]
pub const fn class_of(size: usize) -> usize {
    let k = (size + 3) / 8;
    if k == 0 { 1 } else { k }
}

/// The bytes of every block of class `k`.
#[inline]
pub const fn class_bytes(k: usize) -> usize {
    8 * k + 4
}

/// How many blocks of class `k` move at a time: fewer of the large classes, more of the small ones, a batch being about 1 KiB.
#[inline]
pub const fn batch_of(k: usize) -> usize {
    let n = BATCH_BYTES / class_bytes(k);
    if n < 2 {
        2
    } else if n > 16 {
        16
    } else {
        n
    }
}

/// The free blocks of one thread, a list per class. Not shared: the owning thread alone touches it.
pub struct ThreadCache {
    heads: [Cell<*mut u8>; CLASSES],
    counts: [Cell<u8>; CLASSES],
}

impl ThreadCache {
    pub const fn new() -> ThreadCache {
        ThreadCache { heads: [const { Cell::new(null_mut()) }; CLASSES], counts: [const { Cell::new(0) }; CLASSES] }
    }

    /// The head of the list of class `k`, or null.
    ///
    /// # Safety
    /// Every block on the list is a free block of at least `class_bytes(k)` bytes that nothing else uses.
    #[inline]
    pub unsafe fn pop(&self, k: usize) -> *mut u8 {
        let head = self.heads[k].get();
        if !head.is_null() {
            // SAFETY: a block on the list holds the next link in its first word.
            self.heads[k].set(unsafe { *(head as *mut *mut u8) });
            self.counts[k].set(self.counts[k].get() - 1);
        }
        head
    }

    /// Puts a free block of class `k` on its list; true when the list is now over its limit (the caller empties half of it).
    ///
    /// # Safety
    /// `block` is a free block of `class_bytes(k)` bytes that nothing else uses and that stays unused until popped.
    #[inline]
    pub unsafe fn push(&self, k: usize, block: *mut u8) -> bool {
        // SAFETY: a block of a class holds at least a word.
        unsafe { *(block as *mut *mut u8) = self.heads[k].get() };
        self.heads[k].set(block);
        let count = self.counts[k].get() + 1;
        self.counts[k].set(count);
        count as usize > 2 * batch_of(k)
    }

    /// How many blocks of class `k` the cache holds.
    pub fn len(&self, k: usize) -> usize {
        self.counts[k].get() as usize
    }

    /// The bytes the cache holds.
    #[cfg(test)]
    pub fn bytes(&self) -> usize {
        (1..CLASSES).map(|k| self.len(k) * class_bytes(k)).sum()
    }
}

impl Default for ThreadCache {
    fn default() -> Self {
        ThreadCache::new()
    }
}

/// The allocator behind the caches. The caches take its lock once for a whole batch.
pub trait Shared {
    type Guard;
    /// Exclusive use of the allocator until the guard is dropped.
    fn lock(&self) -> Self::Guard;
    /// A block of `size` bytes (a class's), aligned to [`MAX_ALIGN`], or null.
    ///
    /// # Safety
    /// The guard is this allocator's.
    unsafe fn alloc(&self, guard: &Self::Guard, size: usize) -> *mut u8;
    /// Takes back a block `alloc` returned for `size` bytes.
    ///
    /// # Safety
    /// As [`Shared::alloc`], and `block` came from it with the same size.
    unsafe fn free(&self, guard: &Self::Guard, block: *mut u8, size: usize);
}

/// A block of class `k`: from the cache, else from a batch the shared allocator fills it with. Null when the allocator is out
/// of memory (what it could give goes to the cache).
///
/// # Safety
/// As [`ThreadCache::pop`].
#[inline]
pub unsafe fn alloc<S: Shared>(shared: &S, cache: &ThreadCache, k: usize) -> *mut u8 {
    let block = unsafe { cache.pop(k) };
    if !block.is_null() {
        return block;
    }
    unsafe { refill(shared, cache, k) }
}

#[cold]
#[inline(never)]
unsafe fn refill<S: Shared>(shared: &S, cache: &ThreadCache, k: usize) -> *mut u8 {
    let size = class_bytes(k);
    let guard = shared.lock();
    let first = unsafe { shared.alloc(&guard, size) };
    if first.is_null() {
        return first;
    }
    for _ in 1..batch_of(k) {
        let block = unsafe { shared.alloc(&guard, size) };
        if block.is_null() {
            break;
        }
        // The list was empty and takes at most a batch, below its limit.
        unsafe { cache.push(k, block) };
    }
    first
}

/// Takes back a block of class `k`: onto the cache, and when the list is over its limit, half of it to the shared allocator.
///
/// # Safety
/// As [`ThreadCache::push`].
#[inline]
pub unsafe fn free<S: Shared>(shared: &S, cache: &ThreadCache, k: usize, block: *mut u8) {
    if unsafe { cache.push(k, block) } {
        unsafe { flush(shared, cache, k, batch_of(k)) };
    }
}

#[cold]
#[inline(never)]
unsafe fn flush<S: Shared>(shared: &S, cache: &ThreadCache, k: usize, count: usize) {
    let size = class_bytes(k);
    let guard = shared.lock();
    for _ in 0..count {
        let block = unsafe { cache.pop(k) };
        if block.is_null() {
            break;
        }
        unsafe { shared.free(&guard, block, size) };
    }
}

/// Gives every block of the cache back to the shared allocator (a thread that is ending).
///
/// # Safety
/// As [`ThreadCache::pop`].
pub unsafe fn drain<S: Shared>(shared: &S, cache: &ThreadCache) {
    for k in 1..CLASSES {
        if cache.len(k) > 0 {
            unsafe { flush(shared, cache, k, cache.len(k)) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lock::Lock;
    use std::alloc::{Layout, alloc as system_alloc, dealloc as system_dealloc};
    use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
    use std::sync::{Arc, mpsc};

    /// The system allocator behind a real lock, counting its holds and the blocks it has out.
    struct Heap {
        lock: Lock,
        holds: AtomicUsize,
        out: AtomicUsize,
        /// Blocks it still gives before it reports being out of memory.
        budget: AtomicUsize,
    }

    struct Held<'a>(&'a Lock);

    impl Drop for Held<'_> {
        fn drop(&mut self) {
            self.0.unlock();
        }
    }

    impl Heap {
        fn new() -> Heap {
            Heap { lock: Lock::new(), holds: AtomicUsize::new(0), out: AtomicUsize::new(0), budget: AtomicUsize::new(usize::MAX) }
        }
    }

    impl Shared for Heap {
        type Guard = Held<'static>;

        fn lock(&self) -> Held<'static> {
            self.lock.lock(|| false);
            self.holds.fetch_add(1, Relaxed);
            // SAFETY: the tests keep the heap alive (a local that outlives its guards, or an Arc) for as long as any guard.
            Held(unsafe { &*(&self.lock as *const Lock) })
        }

        unsafe fn alloc(&self, _: &Held<'static>, size: usize) -> *mut u8 {
            if self.budget.try_update(Relaxed, Relaxed, |b| b.checked_sub(1)).is_err() {
                return null_mut();
            }
            self.out.fetch_add(1, Relaxed);
            unsafe { system_alloc(Layout::from_size_align(size, MAX_ALIGN).unwrap()) }
        }

        unsafe fn free(&self, _: &Held<'static>, block: *mut u8, size: usize) {
            self.out.fetch_sub(1, Relaxed);
            unsafe { system_dealloc(block, Layout::from_size_align(size, MAX_ALIGN).unwrap()) }
        }
    }

    unsafe fn take(heap: &Heap, cache: &ThreadCache, k: usize) -> *mut u8 {
        let block = unsafe { alloc(heap, cache, k) };
        assert!(!block.is_null());
        block
    }

    #[test]
    fn a_request_is_served_by_the_smallest_class_that_holds_it() {
        assert_eq!((class_of(1), class_of(12), class_of(13), class_of(20), class_of(21)), (1, 1, 2, 2, 3));
        assert_eq!(class_of(MAX_SMALL), CLASSES - 1);
        assert_eq!(MAX_SMALL, 508);
        for size in 1..=MAX_SMALL {
            let k = class_of(size);
            assert!(class_bytes(k) >= size, "{size} fits its class");
            assert!(k == 1 || class_bytes(k - 1) < size, "{size} is in the smallest class that holds it");
            assert_eq!(class_bytes(k) % MAX_ALIGN, 4, "classes are what the allocator's 8-byte chunks hold after their header");
        }
    }

    #[test]
    fn a_cache_stays_small_whatever_it_is_used_for() {
        let worst: usize = (1..CLASSES).map(|k| (2 * batch_of(k) + 1) * class_bytes(k)).sum();
        assert!(worst < 125 * 1024, "{worst} bytes at most");
        for k in 1..CLASSES {
            assert!((2..=16).contains(&batch_of(k)));
            assert!((2 * batch_of(k) + 1) * class_bytes(k) <= 2600, "class {k}");
        }
    }

    #[test]
    fn most_calls_never_touch_the_shared_heap() {
        let heap = Heap::new();
        let cache = ThreadCache::new();
        let k = class_of(40);
        let blocks: Vec<*mut u8> = (0..10_000).map(|_| unsafe { take(&heap, &cache, k) }).collect();
        for block in blocks {
            unsafe { free(&heap, &cache, k, block) };
        }
        assert!(heap.holds.load(Relaxed) * 8 < 20_000, "{} holds for 20000 calls", heap.holds.load(Relaxed));
        assert!(cache.len(k) <= 2 * batch_of(k), "a list is emptied when it passes its limit");
        unsafe { drain(&heap, &cache) };
        assert_eq!(cache.bytes(), 0);
        assert_eq!(heap.out.load(Relaxed), 0, "everything went back");
    }

    #[test]
    fn live_blocks_of_every_class_keep_their_bytes_apart() {
        let heap = Heap::new();
        let cache = ThreadCache::new();
        let mut live = Vec::new();
        for round in 0..4usize {
            for size in 1..=MAX_SMALL {
                let k = class_of(size);
                let block = unsafe { take(&heap, &cache, k) };
                let tag = (size * 7 + round) as u8;
                unsafe { block.write_bytes(tag, class_bytes(k)) };
                live.push((block, k, tag));
            }
            // Free every third block, so that later rounds reuse blocks from the lists.
            let mut kept = Vec::new();
            for (i, (block, k, tag)) in live.drain(..).enumerate() {
                let bytes = unsafe { std::slice::from_raw_parts(block, class_bytes(k)) };
                assert!(bytes.iter().all(|b| *b == tag), "a block of class {k} was overwritten");
                if i % 3 == 0 {
                    unsafe { free(&heap, &cache, k, block) }
                } else {
                    kept.push((block, k, tag));
                }
            }
            live = kept;
        }
        for (block, k, _) in live {
            unsafe { free(&heap, &cache, k, block) };
        }
        unsafe { drain(&heap, &cache) };
        assert_eq!(heap.out.load(Relaxed), 0);
    }

    #[test]
    fn a_heap_that_runs_out_refuses_the_request_and_loses_nothing() {
        let heap = Heap::new();
        let cache = ThreadCache::new();
        let k = class_of(100);
        // Room for a batch and a half: the second batch gives what it can and the request after it is refused.
        let room = batch_of(k) + batch_of(k) / 2;
        heap.budget.store(room, Relaxed);
        let mut blocks = Vec::new();
        loop {
            let block = unsafe { alloc(&heap, &cache, k) };
            if block.is_null() {
                break;
            }
            blocks.push(block);
        }
        assert_eq!(blocks.len(), room, "every block the heap gave was handed out");
        assert_eq!(cache.len(k), 0);
        heap.budget.store(usize::MAX, Relaxed);
        for block in blocks {
            unsafe { free(&heap, &cache, k, block) };
        }
        unsafe { drain(&heap, &cache) };
        assert_eq!(heap.out.load(Relaxed), 0);
    }

    #[test]
    fn blocks_freed_by_another_thread_than_their_allocator_are_not_lost() {
        let heap = Arc::new(Heap::new());
        let (to_consumer, from_producer) = mpsc::channel::<(usize, usize)>();
        let (to_producer, from_consumer) = mpsc::channel::<(usize, usize)>();
        let producer = {
            let heap = heap.clone();
            std::thread::spawn(move || {
                let heap: &Heap = &heap;
                let cache = ThreadCache::new();
                let mut returned = 0;
                for i in 0..20_000usize {
                    let k = class_of(8 + i % 400);
                    let block = unsafe { take(&heap, &cache, k) };
                    unsafe { (block as *mut u32).write(i as u32) };
                    to_consumer.send((block as usize, k)).unwrap();
                    while let Ok((block, k)) = from_consumer.try_recv() {
                        unsafe { free(heap, &cache, k, block as *mut u8) };
                        returned += 1;
                    }
                }
                drop(to_consumer);
                while let Ok((block, k)) = from_consumer.recv() {
                    unsafe { free(heap, &cache, k, block as *mut u8) };
                    returned += 1;
                }
                unsafe { drain(heap, &cache) };
                returned
            })
        };
        let consumer = {
            let heap = heap.clone();
            std::thread::spawn(move || {
                let heap: &Heap = &heap;
                let cache = ThreadCache::new();
                let mut seen = 0;
                while let Ok((block, k)) = from_producer.recv() {
                    assert_eq!(unsafe { (block as *mut u32).read() } as usize, seen, "blocks arrive intact and in order");
                    seen += 1;
                    if seen % 2 == 0 {
                        // Half are freed here, though another thread allocated them; the others are handed back.
                        unsafe { free(heap, &cache, k, block as *mut u8) };
                    } else {
                        to_producer.send((block, k)).unwrap();
                    }
                }
                unsafe { drain(heap, &cache) };
                seen
            })
        };
        assert_eq!(consumer.join().unwrap(), 20_000);
        assert_eq!(producer.join().unwrap(), 10_000);
        assert_eq!(heap.out.load(Relaxed), 0, "every block went back to the heap");
    }

    #[test]
    fn the_lock_lets_one_thread_in_at_a_time() {
        struct Counter(std::cell::UnsafeCell<u64>);
        unsafe impl Sync for Counter {}
        let lock = Arc::new(Lock::new());
        let counter = Arc::new(Counter(std::cell::UnsafeCell::new(0)));
        let threads: Vec<_> = (0..8)
            .map(|id| {
                let (lock, counter) = (lock.clone(), counter.clone());
                std::thread::spawn(move || {
                    for _ in 0..50_000 {
                        // Half the threads may sleep, half only spin (the interface thread).
                        lock.lock(|| id % 2 == 0);
                        unsafe { *counter.0.get() += 1 };
                        lock.unlock();
                    }
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        assert_eq!(unsafe { *counter.0.get() }, 8 * 50_000);
    }
}
