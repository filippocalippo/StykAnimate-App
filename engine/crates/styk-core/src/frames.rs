//! Bounded, nonblocking frame requests. See `docs/native/frames.md`.
//!
//! The interface owns only small requests and tickets. Workers own all dense
//! frames; presentation borrows a ready list for the duration of one callback.
//! Closing never joins a thread or destroys the document/cache on the caller.

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;
use styk_engine::frame_builder::{FrameBuilder, Options};
use styk_engine::{FrameData, Generation};
use styk_services::{Clock, SpawnError, Spawner};

pub use styk_engine::frame_builder::Onion;
pub use styk_engine::frame_builder::Options as SceneOptions;

pub const LOOKAHEAD: usize = 48;
pub const ONIONS: usize = 48;
pub const PREVIEWS: usize = 8;
pub const THUMBNAILS: usize = 8;
const SLOTS: usize = 1 + LOOKAHEAD + ONIONS + PREVIEWS + THUMBNAILS;
const MAX_HIDDEN: usize = 65_536;

/// K-doc supplies this seam. Called ONLY on workers. Return the immutable
/// generation for exactly this revision/resource epoch, or None; do not hold a
/// store lock while preparing it. A resource epoch changes when mutable image
/// or cel bounds change without a document edit.
pub trait FrameDocument: Send + Sync {
    fn snapshot(&self, revision: u64, resource_epoch: u64) -> Option<Arc<Generation>>;
}

pub type Wake = Arc<dyn Fn() + Send + Sync>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Priority {
    Stage,
    Playback,
    Onion,
    Preview,
    Thumbnail,
}

/// A consumer's stable identity, not a new queue node per pointer move.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Consumer {
    Stage,
    Playback(u8),
    Onion(u8),
    Preview(u8),
    Thumbnail(u8),
}

impl Consumer {
    fn slot(self) -> Option<usize> {
        match self {
            Self::Stage => Some(0),
            Self::Playback(i) if usize::from(i) < LOOKAHEAD => Some(1 + usize::from(i)),
            Self::Onion(i) if usize::from(i) < ONIONS => Some(1 + LOOKAHEAD + usize::from(i)),
            Self::Preview(i) if usize::from(i) < PREVIEWS => {
                Some(1 + LOOKAHEAD + ONIONS + usize::from(i))
            }
            Self::Thumbnail(i) if usize::from(i) < THUMBNAILS => {
                Some(1 + LOOKAHEAD + ONIONS + PREVIEWS + usize::from(i))
            }
            _ => None,
        }
    }
    fn priority(self) -> Priority {
        match self {
            Self::Stage => Priority::Stage,
            Self::Playback(_) => Priority::Playback,
            Self::Onion(_) => Priority::Onion,
            Self::Preview(_) => Priority::Preview,
            Self::Thumbnail(_) => Priority::Thumbnail,
        }
    }
}

/// Immutable, validated complete presentation inputs. Floats must be finite;
/// numeric equality gives signed zero a single cache identity.
#[derive(Clone, Debug, PartialEq)]
pub struct View {
    pub size: [u32; 2],
    pub zoom: f64,
    pub pan: [f64; 2],
    /// Backing density, e.g. 1, .75, .5 or .25.
    pub quality: f64,
    /// Preview edge sampling can change without changing backing density.
    pub samples: u8,
    pub scene: Options,
}

impl Default for View {
    fn default() -> Self {
        Self {
            size: [640, 480],
            zoom: 1.0,
            pan: [0.0; 2],
            quality: 1.0,
            samples: 4,
            scene: Options::default(),
        }
    }
}

impl View {
    fn valid(&self) -> bool {
        self.size.iter().all(|&s| s > 0)
            && self.zoom.is_finite()
            && self.zoom > 0.0
            && self.pan.iter().all(|v| v.is_finite())
            && self.quality.is_finite()
            && self.quality > 0.0
            && self.quality <= 1.0
            && matches!(self.samples, 1 | 4)
            && self.scene.hidden_uids.capacity() <= MAX_HIDDEN
            && self.scene.onions.len() <= ONIONS
            && self.scene.onions.capacity() <= ONIONS.next_power_of_two()
            && self.scene.translations.capacity() <= MAX_HIDDEN
            && self
                .scene
                .translations
                .iter()
                .all(|(_, offset)| offset.iter().all(|v| v.is_finite()))
            && self
                .scene
                .onions
                .iter()
                .try_fold(self.scene.hidden_uids.capacity(), |n, o| {
                    n.checked_add(o.hidden_uids.capacity())
                })
                .is_some_and(|n| n <= MAX_HIDDEN)
            && self.scene.onions.iter().all(|o| {
                o.tick.is_finite()
                    && o.tick >= 0.0
                    && o.opacity.is_finite()
                    && (0.0..=1.0).contains(&o.opacity)
            })
    }

    fn retained_bytes(&self) -> usize {
        // Validated capacities also bound queued metadata. Shared view inputs
        // count once per entry conservatively, as shared glyphs/effects do.
        std::mem::size_of::<Self>()
            + 2 * std::mem::size_of::<usize>()
            + self.scene.hidden_uids.capacity() * std::mem::size_of::<u32>()
            + self.scene.translations.capacity() * std::mem::size_of::<(u32, [f64; 2])>()
            + self.scene.onions.capacity() * std::mem::size_of::<Onion>()
            + self
                .scene
                .onions
                .iter()
                .map(|onion| onion.hidden_uids.capacity() * std::mem::size_of::<u32>())
                .sum::<usize>()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Key {
    pub document: u64,
    pub revision: u64,
    pub resource_epoch: u64,
    pub tick: f64,
    pub view: Arc<View>,
}

#[derive(Clone, Copy, Debug)]
pub struct Config {
    pub workers: usize,
    /// Hard limit on retained ready draw-list allocations, including capacity,
    /// effect stacks and glyph slices. Preparation scratch is engine-owned.
    pub cache_bytes: usize,
    pub lookahead_bytes: usize,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            workers: 2,
            cache_bytes: 128 << 20,
            lookahead_bytes: 32 << 20,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Closed,
    InvalidRequest,
    IdentityExhausted,
    RevisionUnavailable,
    Accounting,
    Budget { required: usize, limit: usize },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Pending,
    Busy,
    Evicted,
    Ready,
    Failed(Error),
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Stats {
    pub cached_frames: usize,
    pub cached_bytes: usize,
    pub queued: usize,
    pub inflight: usize,
    pub prepared: u64,
    pub cache_hits: u64,
    pub discarded: u64,
}

/// Borrowed only while submitting a draw. Do not clone/retain the list's dense
/// fields; a presenter retains its own GPU resource, not a CPU frame lease.
pub struct Ready<'a> {
    pub key: &'a Key,
    pub list: &'a styk_eval::drawlist::DrawList,
    pub camera: Option<styk_eval::doc::Camera>,
    pub background: (u32, u32, f64),
    pub prepare_ms: f32,
    pub latency: Duration,
}

#[derive(Clone)]
struct Request {
    key: Key,
    slot: usize,
    priority: Priority,
    stamp: u64,
    epoch: u64,
    submitted: Duration,
}

struct Entry {
    key: Key,
    epoch: u64,
    frame: FrameData,
    bytes: usize,
    used: u64,
    priority: Priority,
    latency: Duration,
}

struct State {
    source: Option<Arc<dyn FrameDocument>>,
    pending: Vec<Option<Request>>,
    outcome: Vec<(u64, Status)>,
    cache: Vec<Entry>,
    stats: Stats,
    serial: u64,
    stage: Option<(u64, Key)>,
}

struct Shared {
    state: Mutex<State>,
    changed: Condvar,
    closed: AtomicBool,
    epoch: AtomicU64,
    tokens: [AtomicU64; SLOTS],
    lookahead_bytes: AtomicUsize,
    cache_bytes: usize,
    clock: Arc<dyn Clock>,
    progress: AtomicU64,
    wake: Wake,
}

/// One document lifetime and a bounded pool. K-doc owns this beside its session;
/// the host chooses worker counts within its application-wide CPU budget.
pub struct Frames {
    shared: Arc<Shared>,
    document: u64,
    revision: u64,
    resource_epoch: u64,
    serial: u64,
    wanted: Vec<Option<Request>>,
    dirty: [bool; SLOTS],
}

impl Frames {
    #[allow(clippy::too_many_arguments)] // The host supplies document identity and services once.
    pub fn new(
        document: u64,
        revision: u64,
        resource_epoch: u64,
        source: &Arc<dyn FrameDocument>,
        config: Config,
        spawner: &dyn Spawner,
        clock: Arc<dyn Clock>,
        wake: Wake,
    ) -> Result<Self, SpawnError> {
        if !(1..=8).contains(&config.workers) {
            return Err(SpawnError("frame pool needs 1 to 8 workers".into()));
        }
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                source: Some(source.clone()),
                pending: vec![None; SLOTS],
                outcome: vec![(0, Status::Pending); SLOTS],
                cache: Vec::with_capacity(SLOTS),
                stats: Stats::default(),
                serial: 0,
                stage: None,
            }),
            changed: Condvar::new(),
            closed: AtomicBool::new(false),
            epoch: AtomicU64::new(1),
            tokens: std::array::from_fn(|_| AtomicU64::new(0)),
            lookahead_bytes: AtomicUsize::new(config.lookahead_bytes.min(config.cache_bytes)),
            cache_bytes: config.cache_bytes,
            clock,
            progress: AtomicU64::new(0),
            wake,
        });
        for _ in 0..config.workers {
            let worker = shared.clone();
            if let Err(error) = spawner.spawn("styk-frames", Box::new(move || worker.run())) {
                shared.closed.store(true, Ordering::Release);
                shared.changed.notify_all();
                return Err(error);
            }
        }
        Ok(Self {
            shared,
            document,
            revision,
            resource_epoch,
            serial: 0,
            wanted: vec![None; SLOTS],
            dirty: [false; SLOTS],
        })
    }

    /// A new revision or resource state immediately invalidates every ticket,
    /// even if the worker is holding its queue lock. No engine/store read here.
    pub fn revise(&mut self, revision: u64, resource_epoch: u64) -> Result<(), Error> {
        if self.shared.closed.load(Ordering::Acquire) {
            return Err(Error::Closed);
        }
        if (revision, resource_epoch) == (self.revision, self.resource_epoch) {
            return Ok(());
        }
        let epoch = self
            .shared
            .epoch
            .load(Ordering::Relaxed)
            .checked_add(1)
            .ok_or(Error::IdentityExhausted)?;
        self.shared.epoch.store(epoch, Ordering::Release);
        self.revision = revision;
        self.resource_epoch = resource_epoch;
        for slot in 0..SLOTS {
            self.cancel_slot(slot);
        }
        self.flush();
        Ok(())
    }

    /// Latest wins within one consumer. Stage has its own reserved slot and can
    /// never be displaced by previews. Busy admission stays in the local outbox.
    pub fn request(
        &mut self,
        consumer: Consumer,
        tick: f64,
        view: Arc<View>,
    ) -> Result<Key, Error> {
        if self.shared.closed.load(Ordering::Acquire) {
            return Err(Error::Closed);
        }
        let slot = consumer.slot().ok_or(Error::InvalidRequest)?;
        if !tick.is_finite() || tick < 0.0 || !view.valid() {
            return Err(Error::InvalidRequest);
        }
        self.serial = self.serial.checked_add(1).ok_or(Error::IdentityExhausted)?;
        let key = Key {
            document: self.document,
            revision: self.revision,
            resource_epoch: self.resource_epoch,
            tick: if tick == 0.0 { 0.0 } else { tick },
            view,
        };
        let request = Request {
            key: key.clone(),
            slot,
            priority: consumer.priority(),
            stamp: self.serial,
            epoch: self.shared.epoch.load(Ordering::Acquire),
            submitted: self.shared.clock.now(),
        };
        self.shared.tokens[slot].store(request.stamp, Ordering::Release);
        self.wanted[slot] = Some(request);
        self.dirty[slot] = true;
        self.flush();
        Ok(key)
    }

    pub fn cancel(&mut self, consumer: Consumer) -> Result<(), Error> {
        let slot = consumer.slot().ok_or(Error::InvalidRequest)?;
        self.cancel_slot(slot);
        self.flush();
        Ok(())
    }

    fn cancel_slot(&mut self, slot: usize) {
        self.shared.tokens[slot].store(0, Ordering::Release);
        self.wanted[slot] = None;
        self.dirty[slot] = true;
    }

    /// Retry once on an event-loop turn (including an EngineProgress wake).
    /// False means the latest requests are still retained here, never lost.
    pub fn flush(&mut self) -> bool {
        let Ok(mut state) = self.shared.state.try_lock() else {
            // A queue owner may go idle without completing a frame. Schedule an
            // interface retry even then; the outbox alone is not a wakeup.
            (self.shared.wake)();
            return false;
        };
        for slot in 0..SLOTS {
            if self.dirty[slot] {
                state.pending[slot] = self.wanted[slot].clone();
                if slot == 0 {
                    state.stage = self.wanted[0].as_ref().map(|r| (r.stamp, r.key.clone()));
                }
                self.dirty[slot] = false;
            }
        }
        drop(state);
        self.shared.changed.notify_all();
        true
    }

    /// Queue the half-open playback range ahead of the playhead. Actual retained
    /// bytes, not a frame-size estimate, enforce the separate lookahead budget.
    #[allow(clippy::too_many_arguments)] // One replacement of a timeline's speculative range.
    pub fn lookahead(
        &mut self,
        start: u32,
        range: std::ops::Range<u32>,
        looping: bool,
        count: usize,
        bytes: usize,
        view: Arc<View>,
    ) -> Result<usize, Error> {
        if self.shared.closed.load(Ordering::Acquire) {
            return Err(Error::Closed);
        }
        if !view.valid() {
            return Err(Error::InvalidRequest);
        }
        self.shared
            .lookahead_bytes
            .store(bytes.min(self.shared.cache_bytes), Ordering::Release);
        let span = range.end.saturating_sub(range.start);
        let mut queued = 0;
        if span > 0 && bytes > 0 {
            let at = start.max(range.start);
            for index in 0..count.min(LOOKAHEAD).min(span as usize) {
                let tick = u64::from(at) + index as u64;
                if !looping && tick >= u64::from(range.end) {
                    break;
                }
                let tick =
                    u64::from(range.start) + (tick - u64::from(range.start)) % u64::from(span);
                self.request(Consumer::Playback(index as u8), tick as f64, view.clone())?;
                queued += 1;
            }
        }
        for slot in (1 + queued)..=LOOKAHEAD {
            self.cancel_slot(slot);
        }
        self.flush();
        Ok(queued)
    }

    /// No wait, evaluation, accounting walk, frame clone or last-owner drop.
    /// `draw` must submit/borrow only; GPU readback and preparation are not allowed.
    pub fn with_ready(&self, consumer: Consumer, draw: impl FnOnce(Ready<'_>)) -> Status {
        if self.shared.closed.load(Ordering::Acquire) {
            return Status::Failed(Error::Closed);
        }
        let Some(slot) = consumer.slot() else {
            return Status::Failed(Error::InvalidRequest);
        };
        let Some(wanted) = &self.wanted[slot] else {
            return Status::Pending;
        };
        let Ok(mut state) = self.shared.state.try_lock() else {
            return Status::Busy;
        };
        let (stamp, status) = state.outcome[slot];
        if stamp != wanted.stamp || !self.shared.current(wanted) {
            return Status::Pending;
        }
        if status != Status::Ready {
            return status;
        }
        state.serial = state.serial.wrapping_add(1);
        let serial = state.serial;
        let Some(entry) = state.cache.iter_mut().find(|entry| entry.key == wanted.key) else {
            return Status::Evicted;
        };
        entry.used = serial;
        draw(Ready {
            key: &entry.key,
            list: &entry.frame.list,
            camera: entry.frame.camera,
            background: entry.frame.background,
            prepare_ms: entry.frame.ms,
            latency: entry.latency,
        });
        Status::Ready
    }

    pub fn stats(&self) -> Option<Stats> {
        let state = self.shared.state.try_lock().ok()?;
        Some(Stats {
            cached_frames: state.cache.len(),
            queued: state.pending.iter().filter(|r| r.is_some()).count()
                + self.dirty.iter().filter(|d| **d).count(),
            ..state.stats
        })
    }

    pub fn progress(&self) -> u64 {
        self.shared.progress.load(Ordering::Acquire)
    }

    pub fn close(&mut self) {
        self.shared.closed.store(true, Ordering::Release);
        for slot in 0..SLOTS {
            self.cancel_slot(slot);
        }
        self.shared.changed.notify_all();
    }
}

impl Drop for Frames {
    fn drop(&mut self) {
        self.close();
    }
}

impl Shared {
    fn current(&self, request: &Request) -> bool {
        !self.closed.load(Ordering::Acquire)
            && self.epoch.load(Ordering::Acquire) == request.epoch
            && self.tokens[request.slot].load(Ordering::Acquire) == request.stamp
    }

    fn notify(&self) {
        self.progress.fetch_add(1, Ordering::Release);
        (self.wake)();
    }

    fn run(&self) {
        let mut builder = FrameBuilder::default();
        loop {
            if self.step(&mut builder) {
                continue;
            }
            // Dense reuse state is retired on its worker before it sleeps.
            builder = FrameBuilder::default();
            if self.closed.load(Ordering::Acquire) {
                self.clear();
                return;
            }
            let state = styk_doc::lock::spinning(&self.state);
            if state.pending.iter().any(Option::is_some) {
                continue;
            }
            // Only workers wait. The timeout also closes the notify-before-wait
            // race for a lock-free close/revise; interface methods never wait.
            let waited = self.changed.wait_timeout(state, Duration::from_millis(25));
            drop(waited);
        }
    }

    fn clear(&self) {
        let retired = {
            let mut state = styk_doc::lock::spinning(&self.state);
            state.pending.fill(None);
            state.stage = None;
            state.stats.cached_bytes = 0;
            (std::mem::take(&mut state.cache), state.source.take())
        };
        drop(retired);
        self.notify();
    }

    /// One production worker unit, also driven by deterministic unit tests.
    fn step(&self, builder: &mut FrameBuilder) -> bool {
        if self.closed.load(Ordering::Acquire) {
            return false;
        }
        let (request, source, stale) = {
            let mut state = styk_doc::lock::spinning(&self.state);
            let mut stale = Vec::new();
            // Old revisions are removed lazily on a worker, never on revise().
            let epoch = self.epoch.load(Ordering::Acquire);
            let mut i = 0;
            while i < state.cache.len() {
                if state.cache[i].epoch != epoch {
                    let entry = state.cache.swap_remove(i);
                    state.stats.cached_bytes -= entry.bytes;
                    stale.push(entry);
                } else {
                    i += 1;
                }
            }
            if let Some((_, key)) = state
                .stage
                .clone()
                .filter(|(stamp, _)| *stamp == self.tokens[0].load(Ordering::Acquire))
                && let Some(entry) = state.cache.iter_mut().find(|entry| entry.key == key)
            {
                entry.priority = Priority::Stage;
            }
            let limit = self.lookahead_bytes.load(Ordering::Acquire);
            while state
                .cache
                .iter()
                .filter(|e| e.priority == Priority::Playback)
                .map(|e| e.bytes)
                .sum::<usize>()
                > limit
            {
                let victim = state
                    .cache
                    .iter()
                    .enumerate()
                    .filter(|(_, e)| e.priority == Priority::Playback)
                    .min_by_key(|(_, e)| e.used)
                    .map(|(i, _)| i);
                let Some(victim) = victim else {
                    break;
                };
                let entry = state.cache.swap_remove(victim);
                state.stats.cached_bytes -= entry.bytes;
                stale.push(entry);
            }
            let next = state
                .pending
                .iter()
                .enumerate()
                .filter_map(|(slot, r)| r.as_ref().map(|r| (r.priority, slot)))
                .min();
            let request = next.and_then(|(_, slot)| state.pending[slot].take());
            (request, state.source.clone(), stale)
        };
        drop(stale);
        let Some(request) = request else {
            return false;
        };
        if !self.current(&request) {
            return true;
        }
        {
            let mut state = styk_doc::lock::spinning(&self.state);
            if let Some(entry) = state
                .cache
                .iter_mut()
                .find(|entry| entry.key == request.key)
            {
                entry.priority = entry.priority.min(request.priority);
                state.outcome[request.slot] = (request.stamp, Status::Ready);
                state.stats.cache_hits += 1;
                drop(state);
                self.notify();
                return true;
            }
            state.stats.inflight += 1;
        }
        let answer = source
            .and_then(|source| source.snapshot(request.key.revision, request.key.resource_epoch))
            .filter(|generation| generation.revision == request.key.revision)
            .ok_or(Error::RevisionUnavailable)
            .and_then(|generation| {
                if request.key.tick >= f64::from(generation.playable_ticks()) {
                    return Err(Error::InvalidRequest);
                }
                let frame = builder.prepare(
                    &generation,
                    request.key.tick,
                    &request.key.view.scene,
                    || self.clock.now().as_secs_f64() * 1000.0,
                    || !self.current(&request),
                );
                let Some(frame) = frame else {
                    return Ok(None);
                };
                let bytes = styk_eval::drawlist::retained_bytes_checked(&frame.list)
                    .map_err(|_| Error::Accounting)?
                    .checked_add(std::mem::size_of::<Entry>())
                    .and_then(|bytes| bytes.checked_add(request.key.view.retained_bytes()))
                    .ok_or(Error::Accounting)?;
                Ok(Some((frame, bytes)))
            });
        self.finish(request, answer);
        true
    }

    fn finish(&self, request: Request, answer: Result<Option<(FrameData, usize)>, Error>) {
        let mut retired = Vec::new();
        let mut state = styk_doc::lock::spinning(&self.state);
        state.stats.inflight -= 1;
        if !self.current(&request) {
            state.stats.discarded += 1;
            drop(state);
            drop(answer);
            self.notify();
            return;
        }
        // Another worker may have prepared the same key for another consumer.
        // Keep one payload/charge and retire the duplicate off the queue lock.
        if let Some(entry) = state
            .cache
            .iter_mut()
            .find(|entry| entry.key == request.key)
        {
            entry.priority = entry.priority.min(request.priority);
            state.outcome[request.slot] = (request.stamp, Status::Ready);
            state.stats.cache_hits += 1;
            drop(state);
            drop(answer);
            self.notify();
            return;
        }
        let status = match answer {
            Err(error) => Status::Failed(error),
            Ok(None) => Status::Pending,
            Ok(Some((frame, bytes))) => {
                state.stats.prepared += 1;
                let limit = if request.priority == Priority::Playback {
                    self.lookahead_bytes
                        .load(Ordering::Acquire)
                        .min(self.cache_bytes)
                } else {
                    self.cache_bytes
                };
                let playback_bytes = |state: &State| {
                    state
                        .cache
                        .iter()
                        .filter(|e| e.priority == Priority::Playback)
                        .map(|e| e.bytes)
                        .sum::<usize>()
                };
                while bytes <= limit
                    && (state.stats.cached_bytes > self.cache_bytes - bytes
                        || state.cache.len() >= SLOTS
                        || (request.priority == Priority::Playback
                            && playback_bytes(&state) > limit - bytes))
                {
                    // Stage is protected until superseded. Lower-priority work
                    // cannot evict higher-priority work to make itself fit.
                    let protected = |entry: &Entry| {
                        state.stage.as_ref().is_some_and(|(stamp, key)| {
                            *stamp == self.tokens[0].load(Ordering::Acquire) && *key == entry.key
                        })
                    };
                    let effective_priority = |entry: &Entry| {
                        if entry.priority == Priority::Stage && !protected(entry) {
                            Priority::Thumbnail
                        } else {
                            entry.priority
                        }
                    };
                    let victim = state
                        .cache
                        .iter()
                        .enumerate()
                        .filter(|(_, e)| !protected(e) && effective_priority(e) >= request.priority)
                        .max_by_key(|(_, e)| (effective_priority(e), std::cmp::Reverse(e.used)))
                        .map(|(i, _)| i);
                    let Some(victim) = victim else {
                        break;
                    };
                    let entry = state.cache.swap_remove(victim);
                    state.stats.cached_bytes -= entry.bytes;
                    retired.push(entry);
                }
                if bytes > limit
                    || state.stats.cached_bytes > self.cache_bytes.saturating_sub(bytes)
                    || state.cache.len() >= SLOTS
                    || (request.priority == Priority::Playback
                        && playback_bytes(&state) > limit.saturating_sub(bytes))
                {
                    retired.push(Entry {
                        key: request.key.clone(),
                        epoch: request.epoch,
                        frame,
                        bytes,
                        used: 0,
                        priority: request.priority,
                        latency: Duration::ZERO,
                    });
                    Status::Failed(Error::Budget {
                        required: bytes,
                        limit,
                    })
                } else {
                    state.serial = state.serial.wrapping_add(1);
                    let used = state.serial;
                    state.stats.cached_bytes += bytes;
                    state.cache.push(Entry {
                        key: request.key.clone(),
                        epoch: request.epoch,
                        frame,
                        bytes,
                        used,
                        priority: request.priority,
                        latency: self.clock.now().saturating_sub(request.submitted),
                    });
                    Status::Ready
                }
            }
        };
        state.outcome[request.slot] = (request.stamp, status);
        drop(state);
        drop(retired);
        self.notify();
    }
}

#[cfg(test)]
mod tests;
