//! One accounting token for the typed resources of a document lineage.
//! Reservation counters are atomic; no UI lock or cache registry is needed.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

/// Aggregate derived scenes retained by the movieclip caches of one typed
/// document lineage, including nested clips and still-live revisions/jobs.
/// It does not account authored document payloads, caller-held scenes, temporary
/// evaluation buffers, allocator overhead or other engine caches.
#[derive(Debug)]
pub struct SceneBudget {
    bytes: AtomicUsize,
    entries: AtomicUsize,
    byte_limit: usize,
    entry_limit: usize,
}

impl Default for SceneBudget {
    fn default() -> Self {
        Self::with_limits(Self::DEFAULT_BYTES, Self::DEFAULT_ENTRIES)
    }
}

impl SceneBudget {
    pub const DEFAULT_BYTES: usize = 64 * 1024 * 1024;
    pub const DEFAULT_ENTRIES: usize = 1024;

    pub fn with_limits(bytes: usize, entries: usize) -> Self {
        Self { bytes: AtomicUsize::new(0), entries: AtomicUsize::new(0), byte_limit: bytes, entry_limit: entries }
    }

    /// O(1); reservations include admissions still being published by workers.
    pub fn retained_bytes(&self) -> usize {
        self.bytes.load(Ordering::Acquire)
    }

    pub fn retained_entries(&self) -> usize {
        self.entries.load(Ordering::Acquire)
    }

    pub fn limits(&self) -> (usize, usize) {
        (self.byte_limit, self.entry_limit)
    }

    pub(super) fn reserve(self: &Arc<Self>, bytes: usize) -> Option<Reservation> {
        if !claim(&self.bytes, bytes, self.byte_limit) {
            return None;
        }
        if !claim(&self.entries, 1, self.entry_limit) {
            self.bytes.fetch_sub(bytes, Ordering::AcqRel);
            return None;
        }
        Some(Reservation {owner: self.clone(), bytes})
    }
}

fn claim(counter: &AtomicUsize, charge: usize, limit: usize) -> bool {
    let mut used = counter.load(Ordering::Acquire);
    loop {
        let Some(next) = used.checked_add(charge).filter(|&next| next <= limit) else { return false };
        match counter.compare_exchange_weak(used, next, Ordering::AcqRel, Ordering::Acquire) {
            Ok(_) => return true,
            Err(current) => used = current,
        }
    }
}

/// The cache entry owns its charge. Rejection, eviction, clear, cache disposal
/// and generation disposal all release through this single lifetime path.
#[derive(Debug)]
pub(super) struct Reservation {
    owner: Arc<SceneBudget>,
    bytes: usize,
}

impl Drop for Reservation {
    fn drop(&mut self) {
        self.owner.bytes.fetch_sub(self.bytes, Ordering::AcqRel);
        self.owner.entries.fetch_sub(1, Ordering::AcqRel);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checked_byte_and_entry_failures_release_partial_reservations() {
        let budget = Arc::new(SceneBudget::with_limits(usize::MAX, 1));
        let full = budget.reserve(usize::MAX).unwrap();
        assert!(budget.reserve(1).is_none(), "addition must not wrap");
        assert_eq!(budget.retained_bytes(), usize::MAX);
        assert_eq!(budget.retained_entries(), 1);
        drop(full);
        let first = budget.reserve(3).unwrap();
        assert!(budget.reserve(4).is_none(), "entry rejection rolls its byte charge back");
        assert_eq!(budget.retained_bytes(), 3);
        assert_eq!(budget.retained_entries(), 1);
        drop(first);
        assert_eq!(budget.retained_bytes(), 0);
        assert_eq!(budget.retained_entries(), 0);
    }

    #[test]
    fn simultaneous_reservations_cannot_cross_either_limit() {
        for (bytes, entries, admitted) in [(70, 5, 5), (50, 7, 3), (usize::MAX, 2, 2)] {
            let budget = Arc::new(SceneBudget::with_limits(bytes, entries));
            let start = Arc::new(std::sync::Barrier::new(32));
            let finish = Arc::new(std::sync::Barrier::new(32));
            let successes = AtomicUsize::new(0);
            std::thread::scope(|scope| {
                for _ in 0..32 {
                    let budget = budget.clone();
                    let start = start.clone();
                    let finish = finish.clone();
                    let successes = &successes;
                    scope.spawn(move || {
                        start.wait();
                        let reservation = budget.reserve(13);
                        if reservation.is_some() {
                            successes.fetch_add(1, Ordering::Relaxed);
                        }
                        finish.wait();
                        assert!(budget.retained_bytes() <= bytes);
                        assert!(budget.retained_entries() <= entries);
                        drop(reservation);
                    });
                }
            });
            assert_eq!(successes.load(Ordering::Relaxed), admitted);
            assert_eq!(budget.retained_bytes(), 0);
            assert_eq!(budget.retained_entries(), 0);
        }
    }
}
