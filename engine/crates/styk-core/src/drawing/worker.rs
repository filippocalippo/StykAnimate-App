//! The drawing worker: the thread that turns stroke commands into dabs and tiles.
//!
//! One long gap with a fine brush is a long stretch of work (`docs/native/input.md` 3.4), so the path never runs on the
//! interface thread. The interface thread sends commands and never waits; the worker's only waits are the channel's receive
//! and the acknowledgement gate below, and both are woken by a cancel or a shutdown.
//!
//! **Bounded by construction, whatever the input.**
//! - *Generation streams.* The brush hands each dab to the worker as it is made; the worker keeps at most one batch of them
//!   ([`Batcher`]: at most the controller's dab limit, touching at most [`MAX_BATCH_TILES`] tiles unless one dab alone is
//!   larger) and rasterises it before making more. A gap of any length never holds its points or its dabs.
//! - *The stroke's own raster is capped.* The engine keeps the tiles a stroke touches (their undo records are the stroke);
//!   past [`WORKING_BYTES`] of them the stroke fails visibly instead of growing.
//! - *Transfers are bounded.* A batch's tiles travel in parts of at most [`MAX_BATCH_TILES`] tiles; the worker rasterises at
//!   most [`MAX_OUTSTANDING`] batches ahead of what the consumer has acknowledged, and the acknowledgement is a contiguous
//!   frontier, so an early acknowledgement of a later batch (a cancelled stroke's) cannot let batches out of turn. Undo, redo,
//!   clear and a cancelled stroke answer with tile coordinates and a stamp; the consumer fetches the pixels of the ones it
//!   shows, at most [`FETCH_LIMIT`] at a time.
//! - *The request queue is bounded.* At most [`MAX_OPEN`] strokes are open; each may end once, always; samples are refused
//!   past [`MAX_QUEUED_SAMPLES`] and other requests past [`MAX_QUEUED_CONTROL`].
//!
//! **Cancellation is by stroke and by name.** Each stroke has its own abort flag, raised by its `Cancel` the moment the
//! command is sent and read by the brush's own loops, the batch loop and the gate; a cancel for an id that is not the open
//! stroke changes nothing.
//!
//! **Versions.** Every tile the worker reports carries a stamp that only grows: a stroke batch's, or the one an undo, redo,
//! clear, cancel or commit gave the tile. A fetch answers with a tile's pixels (the open stroke's, if it touched the tile) and
//! its stamp; the consumer never installs a tile over a newer stamp, so a late batch cannot resurrect undone ink and a fetch
//! cannot erase a stroke's ink.
//!
//! Dropping the handle never waits for the thread: it raises every abort flag and the thread ends by itself.

use super::mapping::Mapping;
use super::stroke_input::StrokeCommand;
use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::Duration;
use styk_services::{Clock, SpawnError, Spawner};
use styk_doc::{Value, json};
use styk_drawing::brush::{Brush, BrushStroke, Dab, Sample};
use styk_drawing::stroke::{SeedTile, StrokeEngine};
use styk_drawing::tiles::{TILE, TILE_BYTES, Tile, TileChange, TileStore, apply_tile_changes, change_of};

/// Called after a reply is queued, to wake the interface's event loop.
pub type Waker = Arc<dyn Fn() + Send + Sync>;

/// A tile's pixels (or `None` where it is empty) and the stamp of its last change.
pub type TileUpdate = (i64, i64, Option<Vec<u8>>, u64);

/// The seed of path `index` of a mirrored stroke (`seed + index * 7919`).
const PATH_SEED_STEP: u32 = 7919;

/// Tiles one batch of dabs may touch (a single dab larger than that is a batch of its own) and tiles one reply carries.
pub const MAX_BATCH_TILES: usize = 64;

/// Batches rasterised and not yet acknowledged that the worker allows itself.
pub const MAX_OUTSTANDING: u64 = 4;

/// Tiles one [`Request::Fetch`] may ask for.
pub const FETCH_LIMIT: usize = 64;

/// Samples that may wait for the worker at once, across strokes; a sample past it is refused and the stroke ends.
pub const MAX_QUEUED_SAMPLES: usize = 131_072;

/// Requests other than samples that may wait at once.
pub const MAX_QUEUED_CONTROL: usize = 1024;

/// Strokes that may be open (begun and not ended) at once.
pub const MAX_OPEN: usize = 16;

/// Bytes of tiles one stroke may hold in the engine before it fails (the engine's own default is 768 MiB).
pub const WORKING_BYTES: f64 = 512.0 * 1024.0 * 1024.0;

/// What the interface sends.
pub enum Request {
    Begin { id: u64, erase: bool, mapping: Mapping, settings: Arc<str> },
    Sample { id: u64, x: f64, y: f64, pressure: f64, time_ms: f64, lean: Option<(f64, f64)> },
    End { id: u64 },
    Cancel { id: u64 },
    Undo,
    Redo,
    /// Erases the whole cel, as one undo step.
    Clear,
    /// The pixels of up to [`FETCH_LIMIT`] tiles (the rest of the list is ignored), answered with [`Reply::Pixels`].
    Fetch { tiles: Vec<(i64, i64)> },
    Snapshot { token: u64 },
    Ping { token: u64 },
    Shutdown,
    /// Holds the worker until released, so a test can queue work behind it.
    #[cfg(test)]
    Hold { release: Arc<(Mutex<bool>, Condvar)>, entered: Sender<()> },
}

/// A change of the cel's history: the three requests a person can lose by a refusal, so the caller keeps them (see [`Worker::send`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HistoryOp {
    Undo,
    Redo,
    Clear,
}

impl HistoryOp {
    pub fn request(self) -> Request {
        match self {
            HistoryOp::Undo => Request::Undo,
            HistoryOp::Redo => Request::Redo,
            HistoryOp::Clear => Request::Clear,
        }
    }
}

/// History changes the worker refused (too many requests waiting), kept for a later try, in order. A person's undo is never dropped
/// silently: what does not fit the outbox is counted in `lost` for the caller to report.
#[derive(Debug, Default)]
pub struct HistoryOutbox {
    kept: VecDeque<HistoryOp>,
    pub lost: u64,
}

/// Changes an outbox keeps at most.
pub const MAX_KEPT_HISTORY: usize = 64;

impl HistoryOutbox {
    pub fn kept(&self) -> usize {
        self.kept.len()
    }

    /// Sends `op` after any kept before it. Returns false if it was lost (the outbox is full too).
    pub fn submit(&mut self, worker: &Worker, op: HistoryOp) -> bool {
        self.flush(worker);
        if self.kept.is_empty() && worker.send(op.request()) {
            return true;
        }
        if self.kept.len() >= MAX_KEPT_HISTORY {
            self.lost += 1;
            return false;
        }
        self.kept.push_back(op);
        true
    }

    /// Sends the kept changes, in order, until the worker refuses one.
    pub fn flush(&mut self, worker: &Worker) {
        while let Some(op) = self.kept.front().copied() {
            if !worker.send(op.request()) {
                break;
            }
            self.kept.pop_front();
        }
    }
}

/// One dab as the wet ink draws it: in cel pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WetDab {
    pub x: f32,
    pub y: f32,
    pub radius: f32,
    pub opacity: f32,
}

/// What the worker answers.
#[derive(Debug)]
pub enum Reply {
    /// The dabs of batch `seq`, known before the batch is rasterised: the wet ink shows them until `Tiles` with a
    /// sequence of at least `seq` is on the screen. `generate_ms` is the time the brush took to make them.
    Dabs { stroke: u64, seq: u64, dabs: Vec<WetDab>, generate_ms: f64, newest_ns: u64 },
    /// Part `part` of the tiles batch `seq` changed, at most [`MAX_BATCH_TILES`] of them, with their pixels now and the
    /// batch's `stamp`. The batch is complete at the part with `last` set; the consumer acknowledges the sequence with
    /// [`Worker::ack`] once it has installed or discarded the whole batch.
    Tiles { stroke: u64, seq: u64, stamp: u64, part: u32, last: bool, tiles: Vec<(i64, i64, Vec<u8>)>, raster_ms: f64, newest_ns: u64 },
    /// The stroke ended and is one undo step; its tiles were all sent in `Tiles`.
    Finished { stroke: u64, changed_tiles: usize, dabs: usize },
    /// The stroke was discarded: the cel holds its own pixels again in these tiles, from `stamp` on (fetch the ones shown).
    Cancelled { stroke: u64, restore: Vec<(i64, i64)>, stamp: u64 },
    /// Undo, redo or clear changed these tiles, at `stamp` (fetch the ones shown).
    Changed { tiles: Vec<(i64, i64)>, stamp: u64 },
    /// The answer to a [`Request::Fetch`]. `upto` is the newest stroke batch rasterised when it was made: a tile of the open stroke
    /// holds the ink of every batch up to it, so the consumer shows it only once those batches are in the view (or it would paint
    /// them over their own preview).
    Pixels { tiles: Vec<TileUpdate>, upto: u64 },
    /// The stroke failed (a bad brush, the working budget): the engine dropped it. The cel holds its own pixels in the tiles the
    /// stroke had reached, from `stamp` on, exactly as after a cancel: the consumer fetches the ones it shows.
    Failed { stroke: u64, message: String, restore: Vec<(i64, i64)>, stamp: u64 },
    Snapshot { token: u64, tiles: Vec<(i64, i64, Vec<u8>)> },
    Pong { token: u64 },
}

struct OpenStroke {
    id: u64,
    abort: Arc<AtomicBool>,
    /// Its one end (a `End` or a `Cancel`) has been sent.
    ended: bool,
}

/// The acknowledgements: every batch up to `frontier` is acknowledged; `later` holds acknowledgements past a gap.
#[derive(Default)]
struct Acks {
    frontier: u64,
    later: BTreeSet<u64>,
}

struct Shared {
    strokes: Mutex<Vec<OpenStroke>>,
    shutdown: AtomicBool,
    acks: Mutex<Acks>,
    gate: Condvar,
    queued: AtomicUsize,
    control: AtomicUsize,
    refused: AtomicU64,
    /// Dabs the brush has made (tests: the generation is bounded, whatever the gap).
    #[cfg(test)]
    generated: AtomicUsize,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Shared {
    fn flag(&self, id: u64) -> Option<Arc<AtomicBool>> {
        lock(&self.strokes).iter().find(|s| s.id == id).map(|s| s.abort.clone())
    }

    fn forget(&self, id: u64) {
        lock(&self.strokes).retain(|s| s.id != id);
    }

    fn stopped(&self, abort: &AtomicBool) -> bool {
        abort.load(Ordering::SeqCst) || self.shutdown.load(Ordering::SeqCst)
    }

    /// Acknowledges batch `seq`. The frontier moves only over a closed run, so acknowledging a later batch first never frees
    /// room for more than [`MAX_OUTSTANDING`] unacknowledged ones.
    fn ack(&self, seq: u64) {
        let mut acks = lock(&self.acks);
        if seq <= acks.frontier {
            return;
        }
        acks.later.insert(seq);
        loop {
            let next = acks.frontier + 1;
            if !acks.later.remove(&next) {
                break;
            }
            acks.frontier = next;
        }
        self.gate.notify_all();
    }

    /// Waits until batch `seq` may be rasterised (at most [`MAX_OUTSTANDING`] past the frontier); false if the stroke or the
    /// worker was stopped meanwhile.
    fn wait_for_room(&self, seq: u64, abort: &AtomicBool) -> bool {
        let mut acks = lock(&self.acks);
        while seq.saturating_sub(acks.frontier) > MAX_OUTSTANDING {
            if self.stopped(abort) {
                return false;
            }
            acks = self.gate.wait_timeout(acks, Duration::from_millis(20)).unwrap_or_else(|p| p.into_inner()).0;
        }
        !self.stopped(abort)
    }
}

/// The handle on the worker thread.
pub struct Worker {
    requests: Sender<Request>,
    replies: Mutex<Receiver<Reply>>,
    shared: Arc<Shared>,
}

impl Worker {
    /// Starts the worker over a cel of `tiles` (empty for a blank cel) as a task of `spawner`; its timings are read from `clock`.
    pub fn spawn(tiles: Vec<(i64, i64, Vec<u8>)>, waker: Waker, clock: Arc<dyn Clock>, spawner: &dyn Spawner) -> Result<Worker, SpawnError> {
        let (requests, receiver) = channel();
        let (reply_sender, replies) = channel();
        let shared = Arc::new(Shared {
            strokes: Mutex::new(Vec::new()),
            shutdown: AtomicBool::new(false),
            acks: Mutex::new(Acks::default()),
            gate: Condvar::new(),
            queued: AtomicUsize::new(0),
            control: AtomicUsize::new(0),
            refused: AtomicU64::new(0),
            #[cfg(test)]
            generated: AtomicUsize::new(0),
        });
        let thread_shared = shared.clone();
        // The task is never joined: it ends when it sees the shutdown flag.
        spawner.spawn("styk-drawing", Box::new(move || run(tiles, receiver, reply_sender, thread_shared, waker, clock)))?;
        Ok(Worker { requests, replies: Mutex::new(replies), shared })
    }

    /// A weak handle on the state the thread holds: it is gone once the thread has ended.
    #[cfg(test)]
    fn alive(&self) -> std::sync::Weak<Shared> {
        Arc::downgrade(&self.shared)
    }

    /// Samples sent and not yet taken by the worker.
    pub fn queued(&self) -> usize {
        self.shared.queued.load(Ordering::Relaxed)
    }

    /// Requests refused because the worker was too far behind (samples past [`MAX_QUEUED_SAMPLES`], a stroke past
    /// [`MAX_OPEN`], other requests past [`MAX_QUEUED_CONTROL`]).
    pub fn refused(&self) -> u64 {
        self.shared.refused.load(Ordering::Relaxed)
    }

    /// Sends a stroke command; actions are the interface's and are ignored here. `settings` is the brush as JSON. Returns
    /// false for a command the worker is too far behind to take: the caller ends the stroke. A stroke's one end is never
    /// refused, and a second end for the same stroke, or one for a stroke that is not open, is dropped.
    pub fn command(&self, command: StrokeCommand, settings: &Arc<str>) -> bool {
        let request = match command {
            StrokeCommand::Begin { id, erase, mapping, .. } => {
                let mut strokes = lock(&self.shared.strokes);
                strokes.retain(|s| s.id != id);
                if strokes.len() >= MAX_OPEN {
                    self.shared.refused.fetch_add(1, Ordering::Relaxed);
                    return false;
                }
                strokes.push(OpenStroke { id, abort: Arc::new(AtomicBool::new(false)), ended: false });
                drop(strokes);
                Request::Begin { id, erase, mapping, settings: settings.clone() }
            }
            StrokeCommand::Sample { id, x, y, pressure, time_ms, lean } => {
                if self.shared.flag(id).is_none() {
                    return true;
                }
                if self.shared.queued.fetch_add(1, Ordering::Relaxed) >= MAX_QUEUED_SAMPLES {
                    self.shared.queued.fetch_sub(1, Ordering::Relaxed);
                    self.shared.refused.fetch_add(1, Ordering::Relaxed);
                    return false;
                }
                Request::Sample { id, x, y, pressure, time_ms, lean }
            }
            StrokeCommand::End { id } => {
                if !self.mark_ended(id) {
                    return true;
                }
                Request::End { id }
            }
            StrokeCommand::Cancel { id } => {
                // The flag stops the stroke at the brush's next check; the message wakes a worker that is waiting.
                if let Some(flag) = self.shared.flag(id) {
                    flag.store(true, Ordering::SeqCst);
                }
                self.shared.gate.notify_all();
                if !self.mark_ended(id) {
                    return true;
                }
                Request::Cancel { id }
            }
            StrokeCommand::Action(_) => return true,
        };
        let _ = self.requests.send(request);
        true
    }

    /// Whether `id` is open and had not been ended; marks it ended.
    fn mark_ended(&self, id: u64) -> bool {
        match lock(&self.shared.strokes).iter_mut().find(|s| s.id == id) {
            Some(stroke) if !stroke.ended => {
                stroke.ended = true;
                true
            }
            _ => false,
        }
    }

    /// Sends a request other than a stroke command (those go through [`command`](Self::command), which admits and bounds
    /// them). Returns false if too many are waiting.
    pub fn send(&self, request: Request) -> bool {
        match request {
            Request::Shutdown => return self.requests.send(request).is_ok(),
            Request::Begin { .. } | Request::Sample { .. } | Request::End { .. } | Request::Cancel { .. } => return false,
            _ => {}
        }
        if self.shared.control.fetch_add(1, Ordering::Relaxed) >= MAX_QUEUED_CONTROL {
            self.shared.control.fetch_sub(1, Ordering::Relaxed);
            self.shared.refused.fetch_add(1, Ordering::Relaxed);
            return false;
        }
        self.requests.send(request).is_ok()
    }

    /// Tells the worker the consumer is done with batch `seq` (installed on the GPU, or not needed), so it may rasterise
    /// further ahead once every earlier batch is acknowledged too.
    pub fn ack(&self, seq: u64) {
        self.shared.ack(seq);
    }

    /// Up to `max` of the replies waiting, without blocking; the rest stay for the next call.
    pub fn drain(&self, out: &mut Vec<Reply>, max: usize) {
        let replies = lock(&self.replies);
        while out.len() < max {
            match replies.try_recv() {
                Ok(reply) => out.push(reply),
                Err(_) => break,
            }
        }
    }

    /// Waits for one reply; for tests and tools, never for the interface thread.
    pub fn wait(&self, timeout: Duration) -> Option<Reply> {
        let replies = lock(&self.replies);
        match replies.recv_timeout(timeout) {
            Ok(reply) => Some(reply),
            Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => None,
        }
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        // Never a join: the thread may be in the middle of a long gap. It is told to stop, wherever it is, and ends itself.
        self.shared.shutdown.store(true, Ordering::SeqCst);
        for stroke in lock(&self.shared.strokes).iter() {
            stroke.abort.store(true, Ordering::SeqCst);
        }
        self.shared.gate.notify_all();
        let _ = self.requests.send(Request::Shutdown);
    }
}

struct Path {
    flips: (bool, bool),
    stroke: BrushStroke,
}

/// The dabs of the batch being gathered, and the tiles they touch.
struct Batcher {
    dabs: Vec<Dab>,
    tiles: Vec<(i64, i64)>,
    known: HashSet<(i64, i64)>,
    last_range: Option<(std::ops::RangeInclusive<i64>, std::ops::RangeInclusive<i64>)>,
    limit: usize,
}

type Batch = (Vec<Dab>, Vec<(i64, i64)>);

impl Batcher {
    fn new(limit: usize) -> Batcher {
        Batcher { dabs: Vec::new(), tiles: Vec::new(), known: HashSet::new(), last_range: None, limit }
    }

    /// Adds a dab. When it does not fit the batch being gathered (the dab limit, or the tile limit while the batch is not
    /// empty), the batch gathered so far is returned complete and the dab starts the next one.
    fn push(&mut self, dab: Dab) -> Option<Batch> {
        let range = (tile_range(dab.left, dab.right), tile_range(dab.top, dab.bottom));
        let fresh: Vec<(i64, i64)> = if self.last_range.as_ref() == Some(&range) {
            Vec::new()
        } else {
            range.1.clone().flat_map(|ty| range.0.clone().map(move |tx| (tx, ty))).filter(|key| !self.known.contains(key)).collect()
        };
        let full = !self.dabs.is_empty() && (self.dabs.len() >= self.limit || self.tiles.len() + fresh.len() > MAX_BATCH_TILES);
        let out = if full { Some(self.take()) } else { None };
        let fresh: Vec<(i64, i64)> = if full { range.1.clone().flat_map(|ty| range.0.clone().map(move |tx| (tx, ty))).collect() } else { fresh };
        for key in fresh {
            if self.known.insert(key) {
                self.tiles.push(key);
            }
        }
        self.last_range = Some(range);
        self.dabs.push(dab);
        out
    }

    fn take(&mut self) -> Batch {
        self.known.clear();
        self.last_range = None;
        (std::mem::take(&mut self.dabs), std::mem::take(&mut self.tiles))
    }

    fn is_empty(&self) -> bool {
        self.dabs.is_empty()
    }
}

/// What the dabs of a stroke are gathered and rasterised through; separate from the brush paths so a batch can be rasterised
/// from inside the brush's own call.
struct Sink {
    id: u64,
    abort: Arc<AtomicBool>,
    batcher: Batcher,
    seeded: HashSet<(i64, i64)>,
    tail_version: u64,
    dabs: usize,
    /// The device time of the newest sample the batches so far include.
    newest_ns: u64,
    /// Time spent inside the brush's calls minus the time spent rasterising within them.
    generate: Duration,
    /// Set when a batch could not be rasterised: the message.
    failure: Option<String>,
}

struct Current {
    mapping: Mapping,
    paths: Vec<Path>,
    sink: Sink,
}

struct State {
    cel: TileStore,
    engine: StrokeEngine,
    current: Option<Current>,
    seq: u64,
    stamp: u64,
    tile_stamp: HashMap<(i64, i64), u64>,
    undo: Vec<Vec<TileChange>>,
    redo: Vec<Vec<TileChange>>,
    replies: Sender<Reply>,
    shared: Arc<Shared>,
    waker: Waker,
    clock: Arc<dyn Clock>,
}

fn run(tiles: Vec<(i64, i64, Vec<u8>)>, requests: Receiver<Request>, replies: Sender<Reply>, shared: Arc<Shared>, waker: Waker, clock: Arc<dyn Clock>) {
    let mut cel = TileStore::new();
    for (tx, ty, pixels) in tiles {
        let _ = cel.set(tx, ty, Some(&pixels));
    }
    let mut state = State { cel, engine: StrokeEngine::new(), current: None, seq: 0, stamp: 0, tile_stamp: HashMap::new(), undo: Vec::new(), redo: Vec::new(), replies, shared: shared.clone(), waker, clock };
    while let Ok(first) = requests.recv() {
        // Everything that arrived while the last batch was drawn is one batch of samples.
        let mut batch = vec![first];
        while let Ok(next) = requests.try_recv() {
            batch.push(next);
        }
        for request in batch {
            if shared.shutdown.load(Ordering::SeqCst) {
                return;
            }
            match request {
                Request::Sample { .. } => {
                    shared.queued.fetch_sub(1, Ordering::Relaxed);
                }
                Request::Begin { .. } | Request::End { .. } | Request::Cancel { .. } | Request::Shutdown => {}
                _ => {
                    shared.control.fetch_sub(1, Ordering::Relaxed);
                }
            }
            if !state.handle(request) {
                return;
            }
        }
        state.flush();
    }
}

impl State {
    fn reply(&self, reply: Reply) {
        let _ = self.replies.send(reply);
        (self.waker)();
    }

    fn next_stamp(&mut self) -> u64 {
        self.stamp += 1;
        self.stamp
    }

    fn handle(&mut self, request: Request) -> bool {
        match request {
            Request::Shutdown => return false,
            Request::Begin { id, erase, mapping, settings } => self.begin(id, erase, mapping, &settings),
            Request::Sample { id, x, y, pressure, time_ms, lean } => self.sample(id, (x, y), pressure, time_ms, lean),
            Request::End { id } => self.end(id),
            Request::Cancel { id } => self.cancel(id),
            Request::Undo => self.step(true),
            Request::Redo => self.step(false),
            Request::Clear => self.clear(),
            Request::Fetch { tiles } => {
                let open = self.current.as_ref().map(|c| c.sink.id);
                let tiles = tiles
                    .iter()
                    .take(FETCH_LIMIT)
                    .map(|&(tx, ty)| {
                        // What the cel will hold once the open stroke is kept: the stroke's pixels where it touched the tile.
                        let pixels = open.and_then(|id| self.engine.tile(id, tx, ty)).or_else(|| self.cel.get(tx, ty).map(|tile| tile.pixels.to_vec()));
                        (tx, ty, pixels, self.tile_stamp.get(&(tx, ty)).copied().unwrap_or(0))
                    })
                    .collect();
                self.reply(Reply::Pixels { tiles, upto: self.seq });
            }
            Request::Snapshot { token } => {
                let tiles = self.cel.iter().map(|tile| (tile.tx as i64, tile.ty as i64, tile.pixels.to_vec())).collect();
                self.reply(Reply::Snapshot { token, tiles });
            }
            Request::Ping { token } => self.reply(Reply::Pong { token }),
            #[cfg(test)]
            Request::Hold { release: hold, entered } => {
                let (released, signal) = &*hold;
                let mut released = lock(released);
                entered.send(()).expect("the test waits for the hold");
                while !*released {
                    released = signal.wait(released).unwrap_or_else(|p| p.into_inner());
                }
            }
        }
        true
    }

    fn fail(&mut self, stroke: u64, message: impl Into<String>) {
        let seeded = self.current.take().map(|c| c.sink.seeded).unwrap_or_default();
        self.engine.cancel(stroke);
        self.failed(stroke, message.into(), seeded);
    }

    /// Reports a stroke that failed: it is forgotten, and the tiles it had reached are restored through the same stamped path as a
    /// cancel (batches of it may be in the view already).
    fn failed(&mut self, stroke: u64, message: String, seeded: impl IntoIterator<Item = (i64, i64)>) {
        self.shared.forget(stroke);
        let restore: Vec<(i64, i64)> = seeded.into_iter().collect();
        let stamp = if restore.is_empty() { 0 } else { self.restamp(&restore) };
        self.reply(Reply::Failed { stroke, message, restore, stamp });
    }

    fn begin(&mut self, id: u64, erase: bool, mapping: Mapping, settings: &str) {
        // A new press while a stroke is open: the open one keeps its ink.
        if let Some(open) = self.current.as_ref().map(|c| c.sink.id) {
            self.end(open);
        }
        let parsed = json::parse(settings.as_bytes()).map_err(|error| format!("{error:?}")).and_then(|mut value| {
            let object = value.make_obj().ok_or("the brush settings are not an object")?;
            object.set("erase", Value::Bool(erase));
            object.set("seed", Value::Num(id as f64));
            let wanted = object.get("workingBytes").and_then(Value::as_f64);
            object.set("workingBytes", Value::Num(working_bytes_for(wanted)));
            Ok(value)
        });
        let value = match parsed {
            Ok(value) => value,
            Err(message) => return self.failed(id, message, []),
        };
        let brush = match Brush::normalize(&value) {
            Ok(brush) => brush,
            Err(error) => return self.failed(id, error.to_string(), []),
        };
        if let Err(error) = self.engine.begin(id, &value, None) {
            return self.failed(id, error.to_string(), []);
        }
        let abort = self.shared.flag(id).unwrap_or_default();
        let paths = mapping
            .paths()
            .into_iter()
            .enumerate()
            .map(|(index, flips)| {
                let mut stroke = BrushStroke::new(brush.clone(), Some(brush.seed.wrapping_add(PATH_SEED_STEP.wrapping_mul(index as u32))));
                stroke.path.abort = Some(abort.clone());
                Path { flips, stroke }
            })
            .collect();
        // Batches are at most `max(512, min(8192, floor(262144 / (2.2 * r * 2 + 2)^2)))` dabs, as in the JavaScript controller.
        let diameter = 2.2 * brush.size + 2.0;
        let limit = (262_144.0 / (diameter * diameter)).floor().clamp(512.0, 8192.0) as usize;
        let sink = Sink { id, abort, batcher: Batcher::new(limit), seeded: HashSet::new(), tail_version: 0, dabs: 0, newest_ns: 0, generate: Duration::ZERO, failure: None };
        self.current = Some(Current { mapping, paths, sink });
    }

    fn sample(&mut self, id: u64, window: (f64, f64), pressure: f64, time_ms: f64, lean: Option<(f64, f64)>) {
        let Some(mut current) = self.current.take() else { return };
        if current.sink.id != id || current.sink.abort.load(Ordering::SeqCst) {
            self.current = Some(current);
            return;
        }
        current.sink.newest_ns = (time_ms * 1e6).round() as u64;
        let started = self.clock.now();
        let mut rastered = Duration::ZERO;
        let Current { mapping, paths, sink } = &mut current;
        let mut brush_error = None;
        for path in paths.iter_mut() {
            let Some((x, y, ax, ay)) = mapping.cel_sample(path.flips, window, lean) else { continue };
            let input = Sample { x, y, pressure: Some(pressure), time: Some(time_ms), ax: Some(ax), ay: Some(ay) };
            // Each dab goes into the batch being gathered; a full batch is rasterised on the spot, before the brush makes more.
            let result = path.stroke.sample(&input, &mut |dab| {
                if sink.failure.is_some() {
                    return;
                }
                #[cfg(test)]
                self.shared.generated.fetch_add(1, Ordering::Relaxed);
                if let Some((dabs, tiles)) = sink.batcher.push(dab) {
                    let began = self.clock.now();
                    self.raster(sink, dabs, tiles, None);
                    rastered += self.clock.now().saturating_sub(began);
                }
            });
            if let Err(error) = result {
                brush_error = Some(error.to_string());
                break;
            }
        }
        current.sink.generate += self.clock.now().saturating_sub(started).saturating_sub(rastered);
        let failure = brush_error.or_else(|| current.sink.failure.take());
        match failure {
            Some(message) => {
                self.current = Some(current);
                self.fail(id, message)
            }
            None => self.current = Some(current),
        }
    }

    /// Rasterises one batch (and a provisional tail with the last batch of a call): waits for room, reports the dabs for the
    /// preview, runs the engine, reports the tiles in parts. A failure is left in `sink.failure` and stops the stroke.
    fn raster(&mut self, sink: &mut Sink, dabs: Vec<Dab>, mut tiles: Vec<(i64, i64)>, tail: Option<Vec<Dab>>) {
        let seq = self.seq + 1;
        if !self.shared.wait_for_room(seq, &sink.abort) {
            return;
        }
        self.seq = seq;
        for dab in tail.iter().flatten() {
            for ty in tile_range(dab.top, dab.bottom) {
                for tx in tile_range(dab.left, dab.right) {
                    if !tiles.contains(&(tx, ty)) {
                        tiles.push((tx, ty));
                    }
                }
            }
        }
        sink.dabs += dabs.len();
        let seeds: Vec<SeedTile> = tiles.iter().filter(|key| sink.seeded.insert(**key)).map(|&(tx, ty)| SeedTile { tx, ty, pixels: self.cel.get(tx, ty).map(|tile| tile.pixels.to_vec()) }).collect();
        let wet = dabs.iter().map(|d| WetDab { x: d.x as f32, y: d.y as f32, radius: d.radius as f32, opacity: (d.opacity * d.flow) as f32 }).collect();
        let generate_ms = std::mem::take(&mut sink.generate).as_secs_f64() * 1e3;
        let newest_ns = sink.newest_ns;
        self.reply(Reply::Dabs { stroke: sink.id, seq, dabs: wet, generate_ms, newest_ns });
        let started = self.clock.now();
        match self.engine.dabs(sink.id, seq as f64, &dabs, seeds, tail.as_deref()) {
            Ok(Some(result)) => {
                let raster_ms = self.clock.now().saturating_sub(started).as_secs_f64() * 1e3;
                let stamp = self.next_stamp();
                for (tx, ty, _) in &result.tiles {
                    self.tile_stamp.insert((*tx, *ty), stamp);
                }
                let mut parts: Vec<Vec<(i64, i64, Vec<u8>)>> = Vec::new();
                let mut rest = result.tiles;
                while rest.len() > MAX_BATCH_TILES {
                    let tail = rest.split_off(MAX_BATCH_TILES);
                    parts.push(std::mem::replace(&mut rest, tail));
                }
                parts.push(rest);
                let count = parts.len();
                for (part, tiles) in parts.into_iter().enumerate() {
                    self.reply(Reply::Tiles { stroke: sink.id, seq, stamp, part: part as u32, last: part + 1 == count, tiles, raster_ms, newest_ns });
                }
            }
            Ok(None) => self.shared.ack(seq),
            Err(error) => {
                self.shared.ack(seq);
                sink.failure = Some(error.to_string());
                sink.abort.store(true, Ordering::SeqCst);
            }
        }
    }

    /// Rasterises what the batch being gathered holds (and the provisional tail of the stroke, if it changed).
    fn flush(&mut self) {
        self.flush_current(false);
    }

    fn flush_current(&mut self, finishing: bool) {
        let Some(mut current) = self.current.take() else { return };
        let id = current.sink.id;
        if self.shared.stopped(&current.sink.abort) {
            current.sink.batcher.take();
            self.current = Some(current);
            return;
        }
        let tail_version: u64 = current.paths.iter().map(|path| path.stroke.tail_version).sum();
        let tail_changed = !finishing && current.paths[0].stroke.has_tail() && tail_version != current.sink.tail_version;
        if !current.sink.batcher.is_empty() || tail_changed {
            let (dabs, tiles) = current.sink.batcher.take();
            let tail: Option<Vec<Dab>> = tail_changed.then(|| {
                current.sink.tail_version = tail_version;
                current.paths.iter_mut().flat_map(|path| path.stroke.tail_shapes().to_vec()).collect()
            });
            self.raster(&mut current.sink, dabs, tiles, tail);
        }
        match current.sink.failure.take() {
            Some(message) => {
                self.current = Some(current);
                self.fail(id, message);
            }
            None => self.current = Some(current),
        }
    }

    fn end(&mut self, id: u64) {
        if self.current.as_ref().is_none_or(|c| c.sink.id != id) {
            return;
        }
        self.flush_current(false);
        let Some(mut current) = self.current.take() else { return };
        if !self.shared.stopped(&current.sink.abort) {
            let started = self.clock.now();
            let mut rastered = Duration::ZERO;
            let Current { paths, sink, .. } = &mut current;
            for path in paths.iter_mut() {
                path.stroke.finish(&mut |dab| {
                    if sink.failure.is_some() {
                        return;
                    }
                    if let Some((dabs, tiles)) = sink.batcher.push(dab) {
                        let began = self.clock.now();
                        self.raster(sink, dabs, tiles, None);
                        rastered += self.clock.now().saturating_sub(began);
                    }
                });
            }
            current.sink.generate += self.clock.now().saturating_sub(started).saturating_sub(rastered);
        }
        self.current = Some(current);
        // The rest of the stroke's dabs, then the stroke is complete.
        if let Some(current) = self.current.as_mut() {
            if !self.shared.stopped(&current.sink.abort) && !current.sink.batcher.is_empty() {
                let (dabs, tiles) = current.sink.batcher.take();
                let Some(mut taken) = self.current.take() else { return };
                self.raster(&mut taken.sink, dabs, tiles, None);
                self.current = Some(taken);
            }
        }
        let Some(mut current) = self.current.take() else { return };
        self.shared.forget(id);
        if let Some(message) = current.sink.failure.take() {
            self.engine.cancel(id);
            return self.failed(id, message, current.sink.seeded);
        }
        if self.shared.stopped(&current.sink.abort) {
            // Told to stop while ending: the stroke is discarded like a cancelled one (its `Cancel` finds nothing open).
            self.engine.cancel(id);
            let restore: Vec<(i64, i64)> = current.sink.seeded.into_iter().collect();
            let stamp = self.restamp(&restore);
            return self.reply(Reply::Cancelled { stroke: id, restore, stamp });
        }
        match self.engine.end(id) {
            Ok(Some(changes)) => {
                let changed_tiles = changes.len();
                if apply_tile_changes(&mut self.cel, &changes, true).is_err() {
                    return self.failed(id, "the stroke's tiles could not be applied".into(), current.sink.seeded);
                }
                let keys: Vec<(i64, i64)> = changes.iter().map(|c| (c.tx as i64, c.ty as i64)).collect();
                self.restamp(&keys);
                if !changes.is_empty() {
                    self.undo.push(changes);
                    self.redo.clear();
                }
                self.reply(Reply::Finished { stroke: id, changed_tiles, dabs: current.sink.dabs });
            }
            Ok(None) => {}
            Err(error) => self.failed(id, error.to_string(), current.sink.seeded),
        }
    }

    /// Gives these tiles a new stamp: their pixels are the cel's now. Returns the stamp.
    fn restamp(&mut self, tiles: &[(i64, i64)]) -> u64 {
        let stamp = self.next_stamp();
        for key in tiles {
            self.tile_stamp.insert(*key, stamp);
        }
        stamp
    }

    /// Discards the open stroke if it is the one named; a cancel for any other id changes nothing.
    fn cancel(&mut self, id: u64) {
        self.shared.forget(id);
        if self.current.as_ref().is_none_or(|c| c.sink.id != id) {
            return;
        }
        let Some(current) = self.current.take() else { return };
        self.engine.cancel(id);
        let restore: Vec<(i64, i64)> = current.sink.seeded.into_iter().collect();
        let stamp = self.restamp(&restore);
        self.reply(Reply::Cancelled { stroke: id, restore, stamp });
    }

    /// A history change discards the open stroke first, as today's controller does (`drawing-controller.mjs`: a `history` change
    /// cancels the gesture): the stroke was rasterised over pixels the change is about to replace.
    fn cancel_open_for_history(&mut self) {
        if let Some(open) = self.current.as_ref().map(|c| c.sink.id) {
            self.cancel(open);
        }
    }

    fn step(&mut self, undo: bool) {
        if (if undo { &self.undo } else { &self.redo }).is_empty() {
            return;
        }
        self.cancel_open_for_history();
        let (from, to) = if undo { (&mut self.undo, &mut self.redo) } else { (&mut self.redo, &mut self.undo) };
        let Some(changes) = from.pop() else { return };
        if apply_tile_changes(&mut self.cel, &changes, !undo).is_err() {
            return;
        }
        let tiles: Vec<(i64, i64)> = changes.iter().map(|c| (c.tx as i64, c.ty as i64)).collect();
        to.push(changes);
        let stamp = self.restamp(&tiles);
        self.reply(Reply::Changed { tiles, stamp });
    }

    fn clear(&mut self) {
        if self.cel.iter().next().is_none() {
            return;
        }
        self.cancel_open_for_history();
        let before: Vec<Tile> = self.cel.iter().cloned().collect();
        let changes: Vec<TileChange> = before.iter().filter_map(|tile| change_of(tile.tx, tile.ty, Some(&tile.pixels), None)).collect();
        if changes.is_empty() || apply_tile_changes(&mut self.cel, &changes, true).is_err() {
            return;
        }
        let tiles: Vec<(i64, i64)> = changes.iter().map(|c| (c.tx as i64, c.ty as i64)).collect();
        self.undo.push(changes);
        self.redo.clear();
        let stamp = self.restamp(&tiles);
        self.reply(Reply::Changed { tiles, stamp });
    }
}

/// The working budget a stroke gets: what its brush asks for, never more than the worker's cap.
fn working_bytes_for(requested: Option<f64>) -> f64 {
    requested.filter(|b| b.is_finite() && *b > 0.0).map_or(WORKING_BYTES, |b| b.min(WORKING_BYTES))
}

/// The tile indices a pixel range `[low, high)` touches.
fn tile_range(low: f64, high: f64) -> std::ops::RangeInclusive<i64> {
    let first = (low / TILE as f64).floor() as i64;
    let last = ((high - 1.0) / TILE as f64).floor() as i64;
    first..=last.max(first)
}

/// Bytes of one tile.
pub const TILE_SIZE_BYTES: usize = TILE_BYTES;

#[cfg(test)]
#[path = "worker_tests.rs"]
mod tests;
