//! The recording side, compiled only with the `enabled` feature.
//!
//! Each thread owns one [`Ring`] of [`CAPACITY`] slots. Only that thread writes it, so a write is a handful of relaxed
//! atomic stores bracketed by a sequence number (a seqlock): a reader on another thread takes a slot only if the
//! sequence was even and unchanged around its reads, and skips a slot the writer is in the middle of. No lock is
//! held by a writer, and after a thread's first event (which registers its ring) a write allocates nothing.
//!
//! Call sites are `static` [`Site`]s created by the macros; a site registers itself once, on first use, and events
//! carry its small integer id, so the ring never holds a pointer.

use std::cell::OnceCell;
use std::sync::atomic::{AtomicU32, AtomicU64, AtomicUsize, Ordering, fence};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

/// Slots per thread: the most recent events a snapshot can show.
const CAPACITY: usize = 4096;

/// How many events each thread's ring keeps.
pub fn capacity() -> usize {
    CAPACITY
}

/// Nanoseconds since the first event or snapshot of this process: the clock every record uses.
pub fn now_ns() -> u64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_nanos() as u64
}

const UNREGISTERED: u32 = u32::MAX;

/// A named place in the code, created by `span!`, `counter!` or `mark!` as a `static`.
pub struct Site {
    name: &'static str,
    id: AtomicU32,
}

fn sites() -> &'static Mutex<Vec<&'static str>> {
    static SITES: Mutex<Vec<&'static str>> = Mutex::new(Vec::new());
    &SITES
}

impl Site {
    #[doc(hidden)]
    pub const fn new(name: &'static str) -> Site {
        Site { name, id: AtomicU32::new(UNREGISTERED) }
    }

    fn id(&self) -> u32 {
        let id = self.id.load(Ordering::Relaxed);
        if id != UNREGISTERED {
            return id;
        }
        let mut names = sites().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        // Another thread may have registered this site while this one waited for the lock.
        let id = self.id.load(Ordering::Relaxed);
        if id != UNREGISTERED {
            return id;
        }
        let id = names.len() as u32;
        names.push(self.name);
        self.id.store(id, Ordering::Relaxed);
        id
    }

    #[doc(hidden)]
    pub fn counter(&'static self, value: i64) {
        record(KIND_COUNTER, self.id(), now_ns(), value as u64);
    }

    #[doc(hidden)]
    pub fn mark(&'static self) {
        record(KIND_MARK, self.id(), now_ns(), 0);
    }
}

/// A span in progress: it is recorded, with its duration, when it drops.
#[must_use = "a span ends when its guard drops; bind it with `let _span = span!(..)`"]
pub struct Span {
    site: &'static Site,
    start_ns: u64,
}

impl Span {
    #[doc(hidden)]
    pub fn enter(site: &'static Site) -> Span {
        Span { site, start_ns: now_ns() }
    }
}

impl Drop for Span {
    fn drop(&mut self) {
        let end = now_ns();
        record(KIND_SPAN, self.site.id(), self.start_ns, end.saturating_sub(self.start_ns));
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
    /// The start (span, counter, mark), in nanoseconds.
    start: AtomicU64,
    /// The duration (span) or the value (counter).
    payload: AtomicU64,
}

struct Ring {
    thread_name: String,
    thread_index: u32,
    /// How many events this thread has recorded in all.
    written: AtomicUsize,
    slots: Box<[Slot]>,
}

fn registry() -> &'static Mutex<Vec<Arc<Ring>>> {
    static RINGS: Mutex<Vec<Arc<Ring>>> = Mutex::new(Vec::new());
    &RINGS
}

thread_local! {
    static RING: OnceCell<Arc<Ring>> = const { OnceCell::new() };
}

fn record(kind: u32, site: u32, start: u64, payload: u64) {
    // A thread whose local storage is already gone (the last events of a dying thread) records nothing.
    let _ = RING.try_with(|cell| {
        let ring = cell.get_or_init(|| {
            let mut rings = registry().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let thread = std::thread::current();
            let ring = Arc::new(Ring {
                thread_name: thread.name().map_or_else(|| format!("thread-{}", rings.len()), str::to_string),
                thread_index: rings.len() as u32,
                written: AtomicUsize::new(0),
                slots: (0..CAPACITY).map(|_| Slot::default()).collect(),
            });
            rings.push(ring.clone());
            ring
        });
        let index = ring.written.load(Ordering::Relaxed);
        let slot = &ring.slots[index % CAPACITY];
        let sequence = slot.sequence.load(Ordering::Relaxed);
        slot.sequence.store(sequence | 1, Ordering::Relaxed);
        fence(Ordering::Release);
        slot.kind_site.store(kind << 30 | site, Ordering::Relaxed);
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
    pub thread_name: String,
    /// The order in which threads first recorded: a stable, small number per thread.
    pub thread: u32,
    /// The name given to the macro.
    pub name: &'static str,
    /// What it is.
    pub kind: RecordKind,
    /// When it began, in nanoseconds on [`now_ns`]'s clock.
    pub start_ns: u64,
    /// How long it lasted (spans only; zero otherwise).
    pub duration_ns: u64,
}

/// The recent events of every thread that has recorded any (threads that have ended included), oldest first.
///
/// An event being written at the very moment of the call is left out rather than shown torn.
pub fn snapshot() -> Vec<Record> {
    let rings: Vec<Arc<Ring>> = registry().lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
    let names: Vec<&'static str> = sites().lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
    let mut records = Vec::new();
    for ring in rings {
        let written = ring.written.load(Ordering::Acquire);
        for index in written.saturating_sub(CAPACITY)..written {
            let slot = &ring.slots[index % CAPACITY];
            let before = slot.sequence.load(Ordering::Acquire);
            if before & 1 == 1 {
                continue;
            }
            let kind_site = slot.kind_site.load(Ordering::Relaxed);
            let start = slot.start.load(Ordering::Relaxed);
            let payload = slot.payload.load(Ordering::Relaxed);
            fence(Ordering::Acquire);
            if slot.sequence.load(Ordering::Relaxed) != before {
                continue;
            }
            let Some(&name) = names.get((kind_site & 0x3fff_ffff) as usize) else { continue };
            let (kind, duration_ns) = match kind_site >> 30 {
                KIND_SPAN => (RecordKind::Span, payload),
                KIND_COUNTER => (RecordKind::Counter(payload as i64), 0),
                _ => (RecordKind::Mark, 0),
            };
            records.push(Record { thread_name: ring.thread_name.clone(), thread: ring.thread_index, name, kind, start_ns: start, duration_ns });
        }
    }
    // Stable: events of one thread that share a timestamp keep the order they were written in.
    records.sort_by_key(|record| record.start_ns);
    records
}
