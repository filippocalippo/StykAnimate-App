//! The frame cache's existing storage, mutated exclusively on workers.
use super::*;
use std::sync::Mutex;

/// One admission attempt on the interface. Busy has changed no cache control.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Admission { Busy = 0, Unchanged = 1, Applied = 2 }

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum Reset { #[default] None, Clear, Requeue, Discard }

/// The single cache owner: small admission control in State, worker storage
/// behind its own mutex. Interface reads only try this storage mutex.
pub(crate) struct Cache {
    pub(super) generation: u64,
    pub(crate) epoch: u64,
    pub(crate) hidden: Arc<[u32]>,
    pub(crate) effects: bool,
    pub(super) playhead: Sample,
    pub(super) total: u32,
    pub(super) summary: FrameStats,
    pub(super) budget: usize,
    reset: Reset,
    request: Option<Vec<Sample>>,
    pub(super) storage: Arc<Mutex<Storage>>,
}

impl Cache {
    pub(crate) fn new(budget: usize) -> Self {
        Self { generation: 0, epoch: 0, hidden: Arc::from(Vec::new()), effects: true, playhead: Sample::default(), total: 1,
            summary: FrameStats::default(), budget, reset: Reset::None, request: None, storage: Arc::new(Mutex::new(Storage::new(budget))) }
    }

    /// Only control/head movement. The caller drops displaced demand outside State.
    pub(super) fn reset(&mut self, generation: u64) -> Option<Vec<Sample>> {
        self.generation = generation;
        self.epoch = self.epoch.wrapping_add(1);
        self.reset = Reset::Clear;
        self.summary = FrameStats::default();
        self.request.take()
    }

    pub(crate) fn invalidate_resources(&mut self) {
        self.epoch = self.epoch.wrapping_add(1);
        if self.reset == Reset::None { self.reset = Reset::Requeue; }
        self.summary.cached = 0;
        self.summary.cached_bytes = 0;
    }

    pub(super) fn request(&mut self, playhead: Sample, total: u32, wanted: Vec<Sample>) -> Option<Vec<Sample>> {
        self.playhead = playhead;
        self.total = total;
        // A request accepted after invalidation replaces the already logically
        // requeued union. Later coalesced invalidation must not resurrect it.
        if self.reset == Reset::Requeue { self.reset = Reset::Discard; }
        self.request.replace(wanted)
    }

    pub(crate) fn maintenance_due(&self) -> bool { self.reset != Reset::None }
    /// Called by the displaced retirement owner outside State. Preserve the
    /// existing empty-head behavior: no cleanup task for a fresh empty cache.
    pub(crate) fn has_storage(&self) -> bool {
        let storage = self.storage.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        storage.entries.capacity() != 0 || storage.wanted.capacity() != 0 || storage.inflight.capacity() != 0
            || !self.hidden.is_empty() || self.request.as_ref().is_some_and(|request| request.capacity() != 0)
    }

    pub(crate) fn exchange_publication(&mut self, mut fresh: Cache, generation: u64) -> Cache {
        fresh.generation = generation;
        fresh.epoch = self.epoch.wrapping_add(1);
        fresh.budget = self.budget;
        fresh.playhead = self.playhead;
        fresh.total = self.total;
        fresh.effects = self.effects;
        std::mem::swap(&mut fresh.hidden, &mut self.hidden);
        // This worker-prebuilt head has never been exposed. Initialize only
        // scalars through its exclusive borrow, with no mutex acquisition or
        // allocation; an empty publication must not invent a maintenance job.
        let storage = Arc::get_mut(&mut fresh.storage).expect("unpublished cache head").get_mut().unwrap_or_else(|poisoned| poisoned.into_inner());
        storage.generation = fresh.generation;
        storage.epoch = fresh.epoch;
        storage.budget = fresh.budget;
        storage.playhead = fresh.playhead;
        storage.total = fresh.total;
        std::mem::replace(self, fresh)
    }

    pub(crate) fn work(&self, generation: Option<Arc<Generation>>) -> Work {
        Work { generation, storage: self.storage.clone() }
    }
}

pub(crate) struct Work {
    generation: Option<Arc<Generation>>,
    pub(super) storage: Arc<Mutex<Storage>>,
}

struct Control {
    generation: u64, epoch: u64, hidden: Arc<[u32]>, effects: bool,
    playhead: Sample, total: u32, budget: usize,
    reset: Reset, request: Option<Vec<Sample>>, allow_frames: bool,
}

impl Work {
    fn current(&self, state: &crate::State) -> bool {
        Arc::ptr_eq(&self.storage, &state.frames.storage)
            && match (&self.generation, &state.current) {
                (None, None) => true,
                (Some(a), Some(b)) => Arc::ptr_eq(a, b),
                _ => false,
            }
    }

    /// Storage is acquired before taking pending controls, so reordered workers
    /// cannot steal/lose a reset or latest request from an earlier worker.
    fn apply(&self, engine: &Engine, storage: &mut Storage) -> Option<(Control, bool)> {
        let mut control = {
            let mut state = engine.inner.state.lock();
            if !self.current(&state) { return None; }
            let allow_frames = !state.images.preparation_active() && !engine.inner.stopping.load(std::sync::atomic::Ordering::SeqCst);
            let cache = &mut state.frames;
            Control { generation: cache.generation, epoch: cache.epoch, hidden: cache.hidden.clone(), effects: cache.effects,
                playhead: cache.playhead, total: cache.total, budget: cache.budget,
                reset: std::mem::take(&mut cache.reset), request: cache.request.take(), allow_frames }
        };
        // Replacing demand alone is not completed background work. In particular,
        // an empty/fully cached request must preserve the old step/progress contract.
        let changed = storage.generation != control.generation || storage.epoch != control.epoch;
        storage.budget = control.budget;
        storage.playhead = control.playhead;
        storage.total = control.total;
        if storage.generation != control.generation || control.reset == Reset::Clear {
            storage.reset(control.generation);
        } else if control.reset == Reset::Discard {
            storage.entries.clear(); storage.bytes = 0; storage.inflight.clear(); storage.wanted.clear();
        }
        // Requeue only occurs before a later request, which changes the pending
        // mode to Discard. A request preceding the resource event is included.
        if let Some(request) = control.request.take() {
            storage.wanted = request;
            storage.wanted.retain(|sample| sample.time() < control.total as f64);
        }
        if control.reset == Reset::Requeue { storage.invalidate_resources(); }
        storage.generation = control.generation;
        storage.epoch = control.epoch;
        self.summary(engine, storage);
        Some((control, changed))
    }

    fn summary(&self, engine: &Engine, storage: &Storage) -> bool {
        let mut state = engine.inner.state.lock();
        if !self.current(&state) || state.frames.generation != storage.generation || state.frames.epoch != storage.epoch { return false; }
        state.frames.summary = FrameStats { cached: storage.entries.len(), cached_bytes: storage.bytes, ..storage.stats };
        true
    }

    pub(crate) fn step(&self, engine: &Engine) -> bool {
        let mut storage = self.storage.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some((control, changed)) = self.apply(engine, &mut storage) else { return false; };
        if !control.allow_frames { return changed; }
        let Some(generation) = &self.generation else { return changed; };
        {
            let state = engine.inner.state.lock();
            if !self.current(&state) || state.frames.epoch != control.epoch { return true; }
        }
        let Some(tick) = storage.take_wanted() else { return changed; };
        drop(storage);
        let data = produce(generation, tick.time(), &control.hidden, control.effects, engine.inner.clock);
        // Returned/ignored and stale data all remain owned outside State.
        self.finish(engine, tick, control.epoch, &control.hidden, control.effects, data, false);
        true
    }

    pub(super) fn finish(&self, engine: &Engine, tick: Sample, epoch: u64, hidden: &Arc<[u32]>, effects: bool, data: FrameData, inline: bool) -> Option<Arc<FrameData>> {
        let mut storage = self.storage.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let controls = {
            let state = engine.inner.state.lock();
            if !self.current(&state) || state.frames.epoch != epoch || !Arc::ptr_eq(&state.frames.hidden, hidden) || state.frames.effects != effects { None }
            else { Some((state.frames.playhead, state.frames.total, state.frames.budget)) }
        };
        let (playhead, total, budget) = controls?; // Rejected data drops after the State guard.
        // Linearize completion against the actual current request controls.
        // Later requests remain pending and may supersede demand afterward.
        storage.playhead = playhead;
        storage.total = total;
        storage.budget = budget;
        let frame = storage.finish(data.generation, epoch, tick, Some(data));
        if inline && frame.is_some() { storage.stats.inline += 1; }
        self.summary(engine, &storage).then_some(frame).flatten()
    }

    pub(super) fn prepare_now(&self, engine: &Engine, tick: Sample) -> Option<FrameSnapshot> {
        let mut storage = self.storage.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let (control, _) = self.apply(engine, &mut storage)?;
        let generation = self.generation.as_ref()?;
        if tick.time() >= generation.playable_ticks() as f64 { return None; }
        drop(storage);
        let data = produce(generation, tick.time(), &control.hidden, control.effects, engine.inner.clock);
        let frame = self.finish(engine, tick, control.epoch, &control.hidden, control.effects, data, true)?;
        Some(FrameSnapshot { generation: generation.clone(), frame, epoch: control.epoch })
    }
}

pub(super) struct Entry {
    pub(super) data: Arc<FrameData>,
    bytes: usize,
}

pub(super) struct Storage {
    pub(super) generation: u64,
    /// Resource and session changes also supersede work within one generation.
    pub(crate) epoch: u64,
    pub(super) entries: HashMap<Sample, Entry>,
    pub(super) bytes: usize,
    pub(super) budget: usize,
    /// Ticks to prepare, most urgent first.
    pub(super) wanted: Vec<Sample>,
    pub(super) inflight: HashSet<Sample>,
    /// The tick playback is at: the cache evicts what is farthest ahead of it.
    pub(super) playhead: Sample,
    pub(super) total: u32,
    pub(super) stats: FrameStats,
}

impl Storage {
    pub fn new(budget: usize) -> Storage {
        Storage { generation: 0, epoch: 0, entries: HashMap::new(), bytes: 0, budget, wanted: Vec::new(), inflight: HashSet::new(), playhead: Sample::default(), total: 1, stats: FrameStats::default() }
    }

    pub fn reset(&mut self, generation: u64) {
        self.generation = generation;
        self.epoch = self.epoch.wrapping_add(1);
        self.entries.clear();
        self.bytes = 0;
        self.wanted.clear();
        self.inflight.clear();
        self.stats = FrameStats::default();
    }

    /// A decoded cel changed the rectangles effects read. Rebuild previously
    /// requested work, and reject any worker still producing the earlier grid.
    pub(crate) fn invalidate_resources(&mut self) {
        self.epoch = self.epoch.wrapping_add(1);
        let mut redo: Vec<Sample> = self.entries.keys().chain(self.inflight.iter()).copied().collect();
        let total = self.total.max(1);
        redo.sort_unstable_by(|a, b| a.ahead(self.playhead, total).total_cmp(&b.ahead(self.playhead, total)));
        let mut seen: HashSet<Sample> = self.wanted.iter().copied().collect();
        self.wanted.extend(redo.into_iter().filter(|tick| seen.insert(*tick)));
        self.entries.clear();
        self.bytes = 0;
        self.inflight.clear();
    }

    /// The next tick a worker should prepare, marked as in progress.
    pub fn take_wanted(&mut self) -> Option<Sample> {
        let at = self.wanted.iter().position(|tick| !self.entries.contains_key(tick) && !self.inflight.contains(tick))?;
        let tick = self.wanted[at];
        self.wanted.drain(..=at);
        self.inflight.insert(tick);
        Some(tick)
    }

    /// Stores a finished frame, unless the document changed while it was prepared.
    pub fn finish(&mut self, generation: u64, epoch: u64, tick: Sample, data: Option<FrameData>) -> Option<Arc<FrameData>> {
        if generation != self.generation || epoch != self.epoch {
            return None;
        }
        self.inflight.remove(&tick);
        let data = Arc::new(data?);
        self.stats.prepared += 1;
        self.stats.total_ms += data.ms as f64;
        self.stats.worst_ms = self.stats.worst_ms.max(data.ms);
        let bytes = data.list.bytes() + 256;
        if let Some(old) = self.entries.insert(tick, Entry { data: data.clone(), bytes }) {
            self.bytes -= old.bytes;
        }
        self.bytes += bytes;
        self.trim();
        Some(data)
    }

    /// Keeps the cache within its budget by dropping the frames playback will reach last.
    fn trim(&mut self) {
        if self.bytes <= self.budget {
            return;
        }
        let (total, playhead) = (self.total.max(1), self.playhead);
        let mut ticks: Vec<Sample> = self.entries.keys().copied().collect();
        ticks.sort_by(|a, b| b.ahead(playhead, total).total_cmp(&a.ahead(playhead, total)));
        for tick in ticks {
            if self.bytes <= self.budget / 10 * 9 {
                break;
            }
            if tick != playhead
                && let Some(entry) = self.entries.remove(&tick)
            {
                self.bytes -= entry.bytes;
            }
        }
    }
}
