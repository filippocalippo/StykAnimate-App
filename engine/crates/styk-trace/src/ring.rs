//! The recording side, compiled only with the `enabled` feature.
//!
//! Each thread owns one [`Ring`] of [`CAPACITY`] slots. Only that thread writes it, so a write is a handful of relaxed
//! atomic stores bracketed by a sequence number (a seqlock): a reader on another thread takes a slot only if the
//! sequence was even and unchanged around its reads, and skips a slot the writer is in the middle of. No lock is
//! held by a writer, and after a thread's first event (which registers its ring) a write allocates nothing.
//!
//! Call sites are static and records carry a process-lifetime pointer; no interning lock or allocation.
//! A ring belongs to its thread: when the thread exits its ring is released (about 128 KiB each), and the thread's
//! last events move into one archive bounded to [`ARCHIVE_CAPACITY`] records for all finished threads together, so
//! neither memory nor a snapshot grows with the number of threads a process has ever spawned.

use std::cell::RefCell;
use std::sync::atomic::{AtomicPtr, AtomicU32, AtomicU64, AtomicUsize, Ordering, fence};
use std::sync::{Arc, Mutex, Weak};

/// Slots per thread: the most recent events a snapshot can show.
const CAPACITY: usize = 4096;
pub const MAX_RING_BYTES: usize = 24 * 1024 * 1024;
pub const MAX_SNAPSHOT_BYTES: usize = 24 * 1024 * 1024;
const NAME_BYTES: usize = 128;
pub const MAX_ARCHIVE_BYTES: usize =
    2 * ARCHIVE_CAPACITY * (std::mem::size_of::<Record>() + NAME_BYTES);
const RING_BYTES: usize =
    CAPACITY * std::mem::size_of::<Slot>() + std::mem::size_of::<Ring>() + NAME_BYTES + 128;
static RING_BUDGET: Budget = Budget::new(MAX_RING_BYTES);
static DROPPED: AtomicU64 = AtomicU64::new(0);
pub fn dropped() -> u64 {
    DROPPED.load(Ordering::Relaxed)
}
pub fn ring_bytes() -> usize {
    RING_BUDGET.used.load(Ordering::Relaxed)
}
fn refuse(n: u64) {
    DROPPED.fetch_add(n, Ordering::Relaxed);
}
struct Budget {
    used: AtomicUsize,
    limit: usize,
}
impl Budget {
    const fn new(limit: usize) -> Self {
        Self {
            used: AtomicUsize::new(0),
            limit,
        }
    }
    fn reserve(&self, bytes: usize) -> Option<Reservation<'_>> {
        self.used
            .try_update(Ordering::AcqRel, Ordering::Acquire, |used| {
                used.checked_add(bytes).filter(|total| *total <= self.limit)
            })
            .ok()?;
        Some(Reservation {
            budget: self,
            bytes,
        })
    }
}
struct Reservation<'a> {
    budget: &'a Budget,
    bytes: usize,
}
impl Drop for Reservation<'_> {
    fn drop(&mut self) {
        self.budget.used.fetch_sub(self.bytes, Ordering::AcqRel);
    }
}

/// How many events each thread's ring keeps.
pub fn capacity() -> usize {
    CAPACITY
}

/// How many events of finished threads are kept, all of them together.
pub const ARCHIVE_CAPACITY: usize = 4096;

/// How many threads have a ring right now: threads that have recorded and not yet exited.
pub fn live_threads() -> usize {
    registry().try_lock().map_or(0, |rings| {
        rings.iter().filter(|r| r.strong_count() > 0).count()
    })
}

/// Nanoseconds since the first event or snapshot of this process: the clock every record uses.
pub fn now_ns() -> u64 {
    crate::clock::now_ns()
}

/// A static callsite: records point to it, so there is no dynamic interning allocation or lock.
pub struct Site {
    name: &'static str,
}
impl Site {
    pub const fn new(name: &'static str) -> Self {
        Self { name }
    }
    pub fn counter(&'static self, value: i64) {
        record(KIND_COUNTER, self, now_ns(), value as u64);
    }
    pub fn mark(&'static self) {
        record(KIND_MARK, self, now_ns(), 0);
    }
}
/// A span in progress: it is recorded, with its duration, when it drops.
#[must_use = "a span ends when its guard drops; bind it with `let _span = span!(..)`"]
pub struct Span {
    site: &'static Site,
    start_ns: u64,
    clock: Option<Arc<dyn styk_services::clock::Clock>>,
    open: Option<(Arc<Ring>, usize)>,
    _thread: std::marker::PhantomData<std::rc::Rc<()>>,
}

impl Span {
    #[doc(hidden)]
    pub fn enter(site: &'static Site) -> Span {
        let clock = crate::clock::current();
        let start_ns = crate::clock::read(&clock);
        let mut open = None;
        with_ring(|ring| {
            if let Some(index) = ring
                .open
                .iter()
                .position(|slot| slot.site.load(Ordering::Relaxed).is_null())
            {
                let slot = &ring.open[index];
                let seq = slot.sequence.load(Ordering::Relaxed);
                slot.sequence.store(seq | 1, Ordering::Relaxed);
                fence(Ordering::Release);
                slot.start.store(start_ns, Ordering::Relaxed);
                slot.site
                    .store(std::ptr::from_ref(site).cast_mut(), Ordering::Relaxed);
                slot.sequence.store((seq | 1) + 1, Ordering::Release);
                open = Some((ring.clone(), index));
            } else {
                refuse(1);
            }
        });
        Span {
            site,
            start_ns,
            clock,
            open,
            _thread: std::marker::PhantomData,
        }
    }
}

impl Drop for Span {
    fn drop(&mut self) {
        let end = crate::clock::read(&self.clock);
        if let Some((ring, index)) = &self.open {
            ring.open[*index]
                .site
                .store(std::ptr::null_mut(), Ordering::Release);
        }
        record(
            KIND_SPAN,
            self.site,
            self.start_ns,
            end.saturating_sub(self.start_ns),
        );
    }
}

const KIND_SPAN: u32 = 0;
const KIND_COUNTER: u32 = 1;
const KIND_MARK: u32 = 2;

#[derive(Default)]
struct Slot {
    /// Odd while the writer is inside the slot; otherwise twice the number of times it was written.
    sequence: AtomicU64,
    /// The kind in the top two bits, the site id below.
    kind_site: AtomicU32,
    site: AtomicPtr<Site>,
    event: AtomicU64,
    /// The start (span, counter, mark), in nanoseconds.
    start: AtomicU64,
    /// The duration (span) or the value (counter).
    payload: AtomicU64,
}

struct Ring {
    thread_name: Arc<str>,
    /// The order in which threads first recorded, for the life of the process.
    thread_index: u32,
    /// How many events this thread has recorded in all.
    written: AtomicUsize,
    slots: Box<[Slot]>,
    open: [Slot; 64],
    _reservation: Reservation<'static>,
}

/// The rings of running threads.
fn registry() -> &'static Mutex<Vec<Weak<Ring>>> {
    static RINGS: Mutex<Vec<Weak<Ring>>> = Mutex::new(Vec::new());
    &RINGS
}

/// The finished threads' last events, at most [`ARCHIVE_CAPACITY`].
fn archive() -> &'static Mutex<Vec<Record>> {
    static ARCHIVE: Mutex<Vec<Record>> = Mutex::new(Vec::new());
    &ARCHIVE
}

/// A thread's hold on its ring. When the thread exits it unregisters the ring and archives the ring's events.
struct Local(Arc<Ring>);

impl Drop for Local {
    fn drop(&mut self) {
        let last = read(&self.0);
        let Ok(mut archive) = archive().try_lock() else {
            refuse(last.len() as u64);
            return;
        };
        if archive.capacity() < 2 * ARCHIVE_CAPACITY {
            let needed = 2 * ARCHIVE_CAPACITY - archive.len();
            if archive.try_reserve_exact(needed).is_err() {
                refuse(last.len() as u64);
                return;
            }
        }
        archive.extend(last);
        archive.sort_unstable_by_key(|record| (record.start_ns, record.thread, record.sequence));
        if archive.len() > ARCHIVE_CAPACITY {
            let excess = archive.len() - ARCHIVE_CAPACITY;
            archive.drain(..excess);
            refuse(excess as u64);
        }
    }
}

thread_local! {
    static RING: RefCell<Option<Local>> = const { RefCell::new(None) };
}

static THREADS: AtomicU32 = AtomicU32::new(0);

fn with_ring(use_ring: impl FnOnce(&Arc<Ring>)) {
    // Cold registration uses only try_lock. Refused threads can retry after capacity is released.
    let _ = RING.try_with(|cell| {
        let Ok(mut local) = cell.try_borrow_mut() else {
            refuse(1);
            return;
        };
        if local.is_none() {
            let Some(reservation) = RING_BUDGET.reserve(RING_BYTES) else {
                refuse(1);
                return;
            };
            let mut slots = Vec::new();
            if slots.try_reserve_exact(CAPACITY).is_err() {
                refuse(1);
                return;
            }
            slots.resize_with(CAPACITY, Slot::default);
            let thread_index = THREADS.fetch_add(1, Ordering::Relaxed);
            let thread = std::thread::current();
            let name = thread.name().unwrap_or("unnamed");
            let mut end = name.len().min(NAME_BYTES);
            while !name.is_char_boundary(end) {
                end -= 1;
            }
            let ring = Arc::new(Ring {
                thread_name: name[..end].into(),
                thread_index,
                written: AtomicUsize::new(0),
                slots: slots.into_boxed_slice(),
                open: std::array::from_fn(|_| Slot::default()),
                _reservation: reservation,
            });
            let Ok(mut registry) = registry().try_lock() else {
                refuse(1);
                return;
            };
            registry.retain(|ring| ring.strong_count() > 0);
            registry.push(Arc::downgrade(&ring));
            *local = Some(Local(ring));
        }
        let Some(local) = local.as_ref() else {
            return;
        };
        let ring = &local.0;
        use_ring(ring);
    });
}

fn record(kind: u32, site: &'static Site, start: u64, payload: u64) {
    with_ring(|ring| {
        let index = ring.written.load(Ordering::Relaxed);
        let slot = &ring.slots[index % CAPACITY];
        if index >= CAPACITY {
            refuse(1);
        }
        let sequence = slot.sequence.load(Ordering::Relaxed);
        slot.sequence.store(sequence | 1, Ordering::Relaxed);
        fence(Ordering::Release);
        slot.kind_site.store(kind, Ordering::Relaxed);
        slot.site
            .store(std::ptr::from_ref(site).cast_mut(), Ordering::Relaxed);
        slot.event.store(index as u64 + 1, Ordering::Relaxed);
        slot.start.store(start, Ordering::Relaxed);
        slot.payload.store(payload, Ordering::Relaxed);
        slot.sequence.store((sequence | 1) + 1, Ordering::Release);
        ring.written.store(index + 1, Ordering::Release);
    });
}
/// What a record is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecordKind {
    /// A span: its start and duration are in the record.
    Span,
    /// A value at the record's start.
    Counter(i64),
    /// An instant.
    Mark,
}

/// One recorded event.
#[derive(Clone, Debug)]
pub struct Record {
    /// The thread's name, or `thread-N` for an unnamed one.
    pub thread_name: Arc<str>,
    /// The order in which threads first recorded: a small number, unique for the life of the process.
    pub thread: u32,
    /// Publication sequence within this thread, used by drains to avoid duplicates.
    pub sequence: u64,
    /// The name given to the macro.
    pub name: &'static str,
    /// What it is.
    pub kind: RecordKind,
    /// When it began, in nanoseconds on [`now_ns`]'s clock.
    pub start_ns: u64,
    /// How long it lasted (spans only; zero otherwise).
    pub duration_ns: u64,
}

#[derive(Clone, Debug)]
pub struct Thread {
    pub id: u32,
    pub name: Arc<str>,
}
pub fn threads() -> Vec<Thread> {
    registry()
        .try_lock()
        .map(|rings| {
            rings
                .iter()
                .filter_map(Weak::upgrade)
                .map(|ring| Thread {
                    id: ring.thread_index,
                    name: ring.thread_name.clone(),
                })
                .collect()
        })
        .unwrap_or_default()
}
#[derive(Clone, Copy, Debug)]
pub struct OpenSpan {
    pub name: &'static str,
    pub start_ns: u64,
}
pub fn open_spans(thread: u32) -> Vec<OpenSpan> {
    let ring = registry().try_lock().ok().and_then(|rings| {
        rings
            .iter()
            .filter_map(Weak::upgrade)
            .find(|r| r.thread_index == thread)
    });
    let Some(ring) = ring else { return Vec::new() };
    let mut rows = Vec::with_capacity(64);
    for slot in &ring.open {
        let before = slot.sequence.load(Ordering::Acquire);
        if before & 1 != 0 {
            continue;
        }
        let site = slot.site.load(Ordering::Acquire);
        let start_ns = slot.start.load(Ordering::Relaxed);
        fence(Ordering::Acquire);
        if site.is_null() || slot.sequence.load(Ordering::Relaxed) != before {
            continue;
        }
        // SAFETY: every site pointer is a macro-owned static, including after its span ends.
        rows.push(OpenSpan {
            name: unsafe { (*site).name },
            start_ns,
        });
    }
    rows
}
pub fn ring_snapshot(seconds: f64) -> Vec<Record> {
    let end = now_ns();
    let duration = if seconds.is_finite() && seconds >= 0. {
        (seconds * 1e9).min(u64::MAX as f64) as u64
    } else {
        0
    };
    snapshot()
        .into_iter()
        .filter(|r| r.start_ns >= end.saturating_sub(duration))
        .collect()
}
/// Latest values in bounded ring history. Counters without a recent sample are absent.
pub fn counters() -> Vec<(&'static str, i64)> {
    let mut values = std::collections::BTreeMap::new();
    for record in snapshot() {
        if let RecordKind::Counter(value) = record.kind {
            if values.len() < 256 || values.contains_key(record.name) {
                values.insert(record.name, value);
            } else {
                refuse(1);
            }
        }
    }
    values.into_iter().collect()
}
pub fn gauges() -> Vec<(&'static str, i64)> {
    counters()
}

/// The recent events of every thread that has recorded any, oldest first: those of running threads, and the last
/// events of finished ones (at most [`ARCHIVE_CAPACITY`] in all).
///
/// An event being written at the very moment of the call is left out rather than shown torn.
pub fn snapshot() -> Vec<Record> {
    let rings: Vec<Arc<Ring>> = registry()
        .try_lock()
        .map(|rings| rings.iter().filter_map(Weak::upgrade).collect())
        .unwrap_or_default();
    let max = MAX_SNAPSHOT_BYTES / (std::mem::size_of::<Record>() + NAME_BYTES);
    let mut records = Vec::with_capacity(max);
    if let Ok(archive) = archive().try_lock() {
        records.extend(archive.iter().cloned().take(max));
    } else {
        refuse(1);
    }
    for ring in rings {
        let rows = read(&ring);
        let room = max.saturating_sub(records.len());
        if rows.len() > room {
            refuse((rows.len() - room) as u64);
        }
        records.extend(rows.into_iter().take(room));
    }
    // Stable: events of one thread that share a timestamp keep the order they were written in.
    records.sort_unstable_by_key(|record| (record.start_ns, record.thread, record.sequence));
    records
}

/// The events one ring holds, oldest first.
fn read(ring: &Ring) -> Vec<Record> {
    let mut records = Vec::with_capacity(CAPACITY);
    let written = ring.written.load(Ordering::Acquire);
    for index in written.saturating_sub(CAPACITY)..written {
        let slot = &ring.slots[index % CAPACITY];
        let before = slot.sequence.load(Ordering::Acquire);
        if before & 1 == 1 {
            continue;
        }
        let kind_site = slot.kind_site.load(Ordering::Relaxed);
        let site = slot.site.load(Ordering::Relaxed);
        let event = slot.event.load(Ordering::Relaxed);
        let start = slot.start.load(Ordering::Relaxed);
        let payload = slot.payload.load(Ordering::Relaxed);
        fence(Ordering::Acquire);
        if event != index as u64 + 1 || slot.sequence.load(Ordering::Relaxed) != before {
            continue;
        }
        if site.is_null() {
            continue;
        }
        // SAFETY: only &'static Site pointers are published, and all slot payloads are atomic.
        let name = unsafe { (*site).name };
        let (kind, duration_ns) = match kind_site {
            KIND_SPAN => (RecordKind::Span, payload),
            KIND_COUNTER => (RecordKind::Counter(payload as i64), 0),
            _ => (RecordKind::Mark, 0),
        };
        records.push(Record {
            thread_name: ring.thread_name.clone(),
            thread: ring.thread_index,
            sequence: index as u64 + 1,
            name,
            kind,
            start_ns: start,
            duration_ns,
        });
    }
    records
}

#[cfg(test)]
mod budget_tests {
    use super::*;
    #[test]
    fn a_refused_production_ring_allocates_nothing_and_can_retry() {
        let _turn = crate::TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let used = ring_bytes();
        let hold = RING_BUDGET.reserve(MAX_RING_BYTES - used).unwrap();
        let before = dropped();
        std::thread::spawn(|| {
            static SITE: Site = Site::new("test.total.refusal");
            SITE.mark();
        })
        .join()
        .unwrap();
        assert_eq!(ring_bytes(), MAX_RING_BYTES);
        assert!(dropped() > before);
        drop(hold);
        assert_eq!(ring_bytes(), used);
    }
    #[test]
    fn open_spans_and_completed_durations_use_the_injected_clock() {
        let _turn = crate::TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        std::thread::Builder::new()
            .name("open-inspection".into())
            .spawn(|| {
                let clock = styk_services::clock::FixedClock::new();
                let _clock = crate::clock::scoped(Arc::new(clock.clone()));
                static SITE: Site = Site::new("test.open.inspect");
                let span = Span::enter(&SITE);
                let thread = threads()
                    .into_iter()
                    .find(|t| t.name.as_ref() == "open-inspection")
                    .unwrap()
                    .id;
                assert_eq!(open_spans(thread)[0].start_ns, 0);
                clock.advance(std::time::Duration::from_nanos(17));
                drop(span);
                assert!(open_spans(thread).is_empty());
                assert_eq!(
                    snapshot()
                        .iter()
                        .find(|r| r.thread == thread && r.name == "test.open.inspect")
                        .unwrap()
                        .duration_ns,
                    17
                );
            })
            .unwrap()
            .join()
            .unwrap();
    }
    #[test]
    fn admission_precedes_allocation_and_releases_exactly() {
        let b = Budget::new(RING_BYTES);
        let r = b.reserve(RING_BYTES).unwrap();
        assert!(b.reserve(1).is_none());
        assert_eq!(b.used.load(Ordering::Relaxed), RING_BYTES);
        drop(r);
        assert!(b.reserve(RING_BYTES).is_some());
    }
    #[test]
    fn contended_registration_drops_without_waiting() {
        let _turn = crate::TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let before = dropped();
        let guard = registry().lock().unwrap();
        std::thread::spawn(|| {
            static SITE: Site = Site::new("test.refusal");
            SITE.mark();
        })
        .join()
        .unwrap();
        drop(guard);
        assert!(dropped() > before);
    }
}
