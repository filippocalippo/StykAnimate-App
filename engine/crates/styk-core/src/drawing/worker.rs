//! The drawing worker: the thread that turns stroke commands into dabs and tiles.
//!
//! `BrushStroke::sample` generates every dab between two samples in one call, and one long gap with a fine brush is a
//! long call, so the path never runs on the interface thread (`docs/native/input.md` 3.4). The interface thread sends
//! commands over a channel and never waits; the worker's only waits are the channel's receive and the acknowledgement gate
//! below, and both are woken by a cancel or a shutdown.
//!
//! **Cancellation is by stroke.** Each stroke has its own abort flag, set by its `Cancel` (or by shutdown) as soon as the
//! command is sent, and read by the brush's own loops ([`styk_drawing::brush::StrokePath::abort`]), by the batch loop and
//! by the gate. Cancelling one stroke never touches another one's queued work.
//!
//! **Transfers are bounded.** A batch of dabs is cut at [`MAX_BATCH_TILES`] touched tiles (and the controller's dab limit),
//! so a reply carries at most that many 16 KiB tiles, and the worker rasterises at most [`MAX_OUTSTANDING`] batches ahead of
//! what the consumer has acknowledged ([`Worker::ack`]): the consumer is never handed more than that to hold. Undo, redo,
//! clear and a cancelled stroke answer with the coordinates of the tiles that changed, never their pixels; the consumer asks
//! for the ones it shows, at most [`FETCH_LIMIT`] at a time ([`Request::Fetch`]).
//!
//! The worker owns the cel's tiles (the pen lab's pad has one; the Draw workspace will have the document's), seeds a stroke
//! with the tiles its dabs can reach, runs the engine's `StrokeEngine`, and applies the stroke's exact undo records when it
//! ends. Dropping the handle never waits for the thread: it raises every abort flag and the thread ends by itself.

use super::mapping::Mapping;
use super::stroke_input::StrokeCommand;
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use styk_doc::{Value, json};
use styk_drawing::brush::{Brush, BrushStroke, Dab, Sample};
use styk_drawing::stroke::{SeedTile, StrokeEngine};
use styk_drawing::tiles::{TILE, Tile, TileChange, TileStore, apply_tile_changes, change_of};

/// Called after a reply is queued, to wake the interface's event loop.
pub type Waker = Arc<dyn Fn() + Send + Sync>;

/// A tile's new pixels, or `None` where it is empty.
pub type TileUpdate = (i64, i64, Option<Vec<u8>>);

/// The seed of path `index` of a mirrored stroke (`seed + index * 7919`).
const PATH_SEED_STEP: u32 = 7919;

/// Tiles one batch of dabs may touch (a single dab larger than that is a batch of its own).
pub const MAX_BATCH_TILES: usize = 64;

/// Batches rasterised and not yet acknowledged that the worker allows itself.
pub const MAX_OUTSTANDING: u64 = 4;

/// Tiles one [`Request::Fetch`] may ask for.
pub const FETCH_LIMIT: usize = 64;

/// Samples that may wait for the worker at once, across strokes; a sample past it is refused and the stroke ends.
pub const MAX_QUEUED_SAMPLES: usize = 131_072;

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
    Hold(Arc<(Mutex<bool>, Condvar)>),
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
    /// The tiles batch `seq` changed, with their pixels now (at most [`MAX_BATCH_TILES`] unless one dab is larger). The
    /// consumer acknowledges the sequence with [`Worker::ack`] once it has installed or discarded them.
    Tiles { stroke: u64, seq: u64, tiles: Vec<(i64, i64, Vec<u8>)>, raster_ms: f64, newest_ns: u64 },
    /// The stroke ended and is one undo step; its tiles were all sent in `Tiles`.
    Finished { stroke: u64, changed_tiles: usize, dabs: usize },
    /// The stroke was discarded: the cel holds its own pixels again in these tiles (fetch the ones shown).
    Cancelled { stroke: u64, restore: Vec<(i64, i64)> },
    /// Undo, redo or clear changed these tiles (fetch the ones shown).
    Changed { tiles: Vec<(i64, i64)> },
    /// The answer to a [`Request::Fetch`].
    Pixels { tiles: Vec<TileUpdate> },
    Failed { stroke: u64, message: String },
    Snapshot { token: u64, tiles: Vec<(i64, i64, Vec<u8>)> },
    Pong { token: u64 },
}

struct Shared {
    /// The abort flag of each stroke between its `Begin` and its end.
    strokes: Mutex<Vec<(u64, Arc<AtomicBool>)>>,
    shutdown: AtomicBool,
    /// The highest batch sequence the consumer has acknowledged.
    acked: Mutex<u64>,
    gate: Condvar,
    queued: AtomicUsize,
    refused: AtomicU64,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Shared {
    fn flag(&self, id: u64) -> Option<Arc<AtomicBool>> {
        lock(&self.strokes).iter().find(|(s, _)| *s == id).map(|(_, flag)| flag.clone())
    }

    fn forget(&self, id: u64) {
        lock(&self.strokes).retain(|(s, _)| *s != id);
    }

    fn stopped(&self, abort: &AtomicBool) -> bool {
        abort.load(Ordering::SeqCst) || self.shutdown.load(Ordering::SeqCst)
    }

    /// Waits until batch `seq` may be rasterised (at most [`MAX_OUTSTANDING`] ahead of the acknowledgements); false if the
    /// stroke or the worker was stopped meanwhile.
    fn wait_for_room(&self, seq: u64, abort: &AtomicBool) -> bool {
        let mut acked = lock(&self.acked);
        while seq.saturating_sub(*acked) > MAX_OUTSTANDING {
            if self.stopped(abort) {
                return false;
            }
            acked = self.gate.wait_timeout(acked, Duration::from_millis(20)).unwrap_or_else(|p| p.into_inner()).0;
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
    /// Starts the worker over a cel of `tiles` (empty for a blank cel).
    pub fn spawn(tiles: Vec<(i64, i64, Vec<u8>)>, waker: Waker) -> Worker {
        let (requests, receiver) = channel();
        let (reply_sender, replies) = channel();
        let shared = Arc::new(Shared {
            strokes: Mutex::new(Vec::new()),
            shutdown: AtomicBool::new(false),
            acked: Mutex::new(0),
            gate: Condvar::new(),
            queued: AtomicUsize::new(0),
            refused: AtomicU64::new(0),
        });
        let thread_shared = shared.clone();
        // The thread is never joined: it ends when it sees the shutdown flag.
        std::thread::Builder::new().name("styk-drawing".into()).spawn(move || run(tiles, receiver, reply_sender, thread_shared, waker)).expect("the drawing worker thread starts");
        Worker { requests, replies: Mutex::new(replies), shared }
    }

    /// Samples sent and not yet taken by the worker.
    pub fn queued(&self) -> usize {
        self.shared.queued.load(Ordering::Relaxed)
    }

    /// Samples refused because [`MAX_QUEUED_SAMPLES`] were already waiting.
    pub fn refused(&self) -> u64 {
        self.shared.refused.load(Ordering::Relaxed)
    }

    /// Sends a stroke command; actions are the interface's and are ignored here. `settings` is the brush as JSON. Returns
    /// false for a sample the worker is too far behind to take: the caller ends the stroke (an `End` is never refused).
    pub fn command(&self, command: StrokeCommand, settings: &Arc<str>) -> bool {
        let request = match command {
            StrokeCommand::Begin { id, erase, mapping, .. } => {
                let mut strokes = lock(&self.shared.strokes);
                strokes.retain(|(s, _)| *s != id);
                strokes.push((id, Arc::new(AtomicBool::new(false))));
                drop(strokes);
                Request::Begin { id, erase, mapping, settings: settings.clone() }
            }
            StrokeCommand::Sample { id, x, y, pressure, time_ms, lean } => {
                if self.shared.queued.fetch_add(1, Ordering::Relaxed) >= MAX_QUEUED_SAMPLES {
                    self.shared.queued.fetch_sub(1, Ordering::Relaxed);
                    self.shared.refused.fetch_add(1, Ordering::Relaxed);
                    return false;
                }
                Request::Sample { id, x, y, pressure, time_ms, lean }
            }
            StrokeCommand::End { id } => Request::End { id },
            StrokeCommand::Cancel { id } => {
                // The flag stops the stroke at the brush's next check; the message wakes a worker that is waiting.
                if let Some(flag) = self.shared.flag(id) {
                    flag.store(true, Ordering::SeqCst);
                }
                self.shared.gate.notify_all();
                Request::Cancel { id }
            }
            StrokeCommand::Action(_) => return true,
        };
        let _ = self.requests.send(request);
        true
    }

    pub fn send(&self, request: Request) {
        let _ = self.requests.send(request);
    }

    /// Tells the worker the consumer is done with batches up to `seq` (installed on the GPU, or not needed), so it may
    /// rasterise further ahead.
    pub fn ack(&self, seq: u64) {
        let mut acked = lock(&self.shared.acked);
        if seq > *acked {
            *acked = seq;
            self.shared.gate.notify_all();
        }
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
        for (_, flag) in lock(&self.shared.strokes).iter() {
            flag.store(true, Ordering::SeqCst);
        }
        self.shared.gate.notify_all();
        let _ = self.requests.send(Request::Shutdown);
    }
}

struct Path {
    flips: (bool, bool),
    stroke: BrushStroke,
}

struct Current {
    id: u64,
    abort: Arc<AtomicBool>,
    mapping: Mapping,
    paths: Vec<Path>,
    pending: Vec<Dab>,
    seeded: HashSet<(i64, i64)>,
    tail_version: u64,
    batch_limit: usize,
    dabs: usize,
    /// The device time of the newest sample the batches so far include.
    newest_ns: u64,
    /// Time the brush has spent generating dabs since the last batch was reported.
    generate: Duration,
}

struct State {
    cel: TileStore,
    engine: StrokeEngine,
    current: Option<Current>,
    seq: u64,
    undo: Vec<Vec<TileChange>>,
    redo: Vec<Vec<TileChange>>,
    replies: Sender<Reply>,
    shared: Arc<Shared>,
    waker: Waker,
}

fn run(tiles: Vec<(i64, i64, Vec<u8>)>, requests: Receiver<Request>, replies: Sender<Reply>, shared: Arc<Shared>, waker: Waker) {
    let mut cel = TileStore::new();
    for (tx, ty, pixels) in tiles {
        let _ = cel.set(tx, ty, Some(&pixels));
    }
    let mut state = State { cel, engine: StrokeEngine::new(), current: None, seq: 0, undo: Vec::new(), redo: Vec::new(), replies, shared: shared.clone(), waker };
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
            if matches!(request, Request::Sample { .. }) {
                shared.queued.fetch_sub(1, Ordering::Relaxed);
            }
            if !state.handle(request) {
                return;
            }
        }
        state.flush(false);
    }
}

impl State {
    fn reply(&self, reply: Reply) {
        let _ = self.replies.send(reply);
        (self.waker)();
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
                let tiles = tiles.iter().take(FETCH_LIMIT).map(|&(tx, ty)| (tx, ty, self.cel.get(tx, ty).map(|tile| tile.pixels.to_vec()))).collect();
                self.reply(Reply::Pixels { tiles });
            }
            Request::Snapshot { token } => {
                let tiles = self.cel.iter().map(|tile| (tile.tx as i64, tile.ty as i64, tile.pixels.to_vec())).collect();
                self.reply(Reply::Snapshot { token, tiles });
            }
            Request::Ping { token } => self.reply(Reply::Pong { token }),
            #[cfg(test)]
            Request::Hold(hold) => {
                let (released, signal) = &*hold;
                let mut released = lock(released);
                while !*released {
                    released = signal.wait(released).unwrap_or_else(|p| p.into_inner());
                }
            }
        }
        true
    }

    fn fail(&mut self, stroke: u64, message: impl Into<String>) {
        self.current = None;
        self.shared.forget(stroke);
        self.engine.cancel(stroke);
        self.reply(Reply::Failed { stroke, message: message.into() });
    }

    fn begin(&mut self, id: u64, erase: bool, mapping: Mapping, settings: &str) {
        // A new press while a stroke is open: the open one keeps its ink.
        if let Some(open) = self.current.as_ref().map(|c| c.id) {
            self.end(open);
        }
        let parsed = json::parse(settings.as_bytes()).map_err(|error| format!("{error:?}")).and_then(|mut value| {
            let object = value.make_obj().ok_or("the brush settings are not an object")?;
            object.set("erase", Value::Bool(erase));
            object.set("seed", Value::Num(id as f64));
            Ok(value)
        });
        let value = match parsed {
            Ok(value) => value,
            Err(message) => return self.reply(Reply::Failed { stroke: id, message }),
        };
        let brush = match Brush::normalize(&value) {
            Ok(brush) => brush,
            Err(error) => return self.reply(Reply::Failed { stroke: id, message: error.to_string() }),
        };
        if let Err(error) = self.engine.begin(id, &value, None) {
            return self.reply(Reply::Failed { stroke: id, message: error.to_string() });
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
        let batch_limit = (262_144.0 / (diameter * diameter)).floor().clamp(512.0, 8192.0) as usize;
        self.current = Some(Current {
            id,
            abort,
            mapping,
            paths,
            pending: Vec::new(),
            seeded: HashSet::new(),
            tail_version: 0,
            batch_limit,
            dabs: 0,
            newest_ns: 0,
            generate: Duration::ZERO,
        });
    }

    fn sample(&mut self, id: u64, window: (f64, f64), pressure: f64, time_ms: f64, lean: Option<(f64, f64)>) {
        let Some(current) = self.current.as_mut().filter(|c| c.id == id) else { return };
        if current.abort.load(Ordering::SeqCst) {
            return;
        }
        current.newest_ns = (time_ms * 1e6).round() as u64;
        let started = Instant::now();
        for path in &mut current.paths {
            let Some((x, y, ax, ay)) = current.mapping.cel_sample(path.flips, window, lean) else { continue };
            let input = Sample { x, y, pressure: Some(pressure), time: Some(time_ms), ax: Some(ax), ay: Some(ay) };
            if let Err(error) = path.stroke.sample(&input, &mut |dab| current.pending.push(dab)) {
                return self.fail(id, error.to_string());
            }
        }
        current.generate += started.elapsed();
    }

    /// The dabs of the next batch: as many as the batch limit allows while they touch at most [`MAX_BATCH_TILES`] tiles.
    fn next_chunk(current: &mut Current) -> (Vec<Dab>, Vec<(i64, i64)>) {
        let mut tiles: Vec<(i64, i64)> = Vec::new();
        let mut known: HashSet<(i64, i64)> = HashSet::new();
        let mut take = 0;
        let mut last_range = None;
        for dab in current.pending.iter().take(current.batch_limit) {
            let range = (tile_range(dab.left, dab.right), tile_range(dab.top, dab.bottom));
            if last_range.as_ref() != Some(&range) {
                let fresh: Vec<(i64, i64)> = range.1.clone().flat_map(|ty| range.0.clone().map(move |tx| (tx, ty))).filter(|key| !known.contains(key)).collect();
                if take > 0 && tiles.len() + fresh.len() > MAX_BATCH_TILES {
                    break;
                }
                for key in fresh {
                    known.insert(key);
                    tiles.push(key);
                }
                last_range = Some(range);
            }
            take += 1;
        }
        let dabs: Vec<Dab> = current.pending.drain(..take).collect();
        (dabs, tiles)
    }

    /// Rasterises the dabs waiting, a batch at a time, never more than [`MAX_OUTSTANDING`] ahead of the consumer.
    fn flush(&mut self, finishing: bool) {
        loop {
            let Some(current) = self.current.as_mut() else { return };
            let id = current.id;
            if self.shared.stopped(&current.abort) {
                current.pending.clear();
                return;
            }
            let tail_version: u64 = current.paths.iter().map(|path| path.stroke.tail_version).sum();
            let tail_changed = !finishing && current.paths[0].stroke.has_tail() && tail_version != current.tail_version;
            if current.pending.is_empty() && !tail_changed {
                return;
            }
            let seq = self.seq + 1;
            if !self.shared.wait_for_room(seq, &current.abort) {
                current.pending.clear();
                return;
            }
            self.seq = seq;
            let (dabs, mut batch_tiles) = Self::next_chunk(current);
            let last = current.pending.is_empty();
            let tail: Option<Vec<Dab>> = (last && tail_changed).then(|| {
                current.tail_version = tail_version;
                current.paths.iter_mut().flat_map(|path| path.stroke.tail_shapes().to_vec()).collect()
            });
            for dab in tail.iter().flatten() {
                for ty in tile_range(dab.top, dab.bottom) {
                    for tx in tile_range(dab.left, dab.right) {
                        if !batch_tiles.contains(&(tx, ty)) {
                            batch_tiles.push((tx, ty));
                        }
                    }
                }
            }
            current.dabs += dabs.len();
            let seeds: Vec<SeedTile> = batch_tiles
                .iter()
                .filter(|key| current.seeded.insert(**key))
                .map(|&(tx, ty)| SeedTile { tx, ty, pixels: self.cel.get(tx, ty).map(|tile| tile.pixels.to_vec()) })
                .collect();
            let wet = dabs.iter().map(|d| WetDab { x: d.x as f32, y: d.y as f32, radius: d.radius as f32, opacity: (d.opacity * d.flow) as f32 }).collect();
            let generate_ms = std::mem::take(&mut current.generate).as_secs_f64() * 1e3;
            let newest_ns = current.newest_ns;
            self.reply(Reply::Dabs { stroke: id, seq, dabs: wet, generate_ms, newest_ns });
            let started = Instant::now();
            match self.engine.dabs(id, seq as f64, &dabs, seeds, tail.as_deref()) {
                Ok(Some(result)) => {
                    let raster_ms = started.elapsed().as_secs_f64() * 1e3;
                    self.reply(Reply::Tiles { stroke: id, seq, tiles: result.tiles, raster_ms, newest_ns });
                }
                Ok(None) => {}
                Err(error) => return self.fail(id, error.to_string()),
            }
        }
    }

    fn end(&mut self, id: u64) {
        if self.current.as_ref().is_none_or(|c| c.id != id) {
            return;
        }
        self.flush(false);
        let Some(current) = self.current.as_mut() else { return };
        if !self.shared.stopped(&current.abort) {
            let started = Instant::now();
            for path in &mut current.paths {
                path.stroke.finish(&mut |dab| current.pending.push(dab));
            }
            current.generate += started.elapsed();
        }
        self.flush(true);
        let Some(current) = self.current.take() else { return };
        self.shared.forget(id);
        if self.shared.stopped(&current.abort) {
            // Told to stop while ending: the stroke is discarded like a cancelled one (its `Cancel` finds nothing open).
            self.engine.cancel(id);
            let restore = current.seeded.into_iter().collect();
            return self.reply(Reply::Cancelled { stroke: id, restore });
        }
        match self.engine.end(id) {
            Ok(Some(changes)) => {
                let changed_tiles = changes.len();
                if apply_tile_changes(&mut self.cel, &changes, true).is_err() {
                    return self.reply(Reply::Failed { stroke: id, message: "the stroke's tiles could not be applied".into() });
                }
                if !changes.is_empty() {
                    self.undo.push(changes);
                    self.redo.clear();
                }
                self.reply(Reply::Finished { stroke: id, changed_tiles, dabs: current.dabs });
            }
            Ok(None) => {}
            Err(error) => self.reply(Reply::Failed { stroke: id, message: error.to_string() }),
        }
    }

    fn cancel(&mut self, id: u64) {
        self.shared.forget(id);
        let Some(current) = self.current.take().filter(|c| c.id == id) else { return };
        self.engine.cancel(id);
        let restore = current.seeded.into_iter().collect();
        self.reply(Reply::Cancelled { stroke: id, restore });
    }

    fn step(&mut self, undo: bool) {
        let (from, to) = if undo { (&mut self.undo, &mut self.redo) } else { (&mut self.redo, &mut self.undo) };
        let Some(changes) = from.pop() else { return };
        if apply_tile_changes(&mut self.cel, &changes, !undo).is_err() {
            return;
        }
        let tiles = changes.iter().map(|c| (c.tx as i64, c.ty as i64)).collect();
        to.push(changes);
        self.reply(Reply::Changed { tiles });
    }

    fn clear(&mut self) {
        let before: Vec<Tile> = self.cel.iter().cloned().collect();
        let changes: Vec<TileChange> = before.iter().filter_map(|tile| change_of(tile.tx, tile.ty, Some(&tile.pixels), None)).collect();
        if changes.is_empty() || apply_tile_changes(&mut self.cel, &changes, true).is_err() {
            return;
        }
        let tiles = changes.iter().map(|c| (c.tx as i64, c.ty as i64)).collect();
        self.undo.push(changes);
        self.redo.clear();
        self.reply(Reply::Changed { tiles });
    }
}

/// The tile indices a pixel range `[low, high)` touches.
fn tile_range(low: f64, high: f64) -> std::ops::RangeInclusive<i64> {
    let first = (low / TILE as f64).floor() as i64;
    let last = ((high - 1.0) / TILE as f64).floor() as i64;
    first..=last.max(first)
}

#[cfg(test)]
#[path = "worker_tests.rs"]
mod tests;
