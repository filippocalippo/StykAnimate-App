//! The drawing worker: the thread that turns stroke commands into dabs and tiles.
//!
//! `BrushStroke::sample` generates every dab between two samples in one call, and one long gap with a fine brush is a
//! long call, so the path never runs on the interface thread (`docs/native/input.md` 3.4). The interface thread sends
//! commands over an unbounded channel whose depth is bounded by the 65 536-sample limit of a stroke and never waits; the
//! worker's only wait is the channel's receive, which a cancel wakes. Every reply carries the stroke and the batch
//! sequence it belongs to, so an old reply can be recognised and dropped.
//!
//! The worker owns the cel's tiles (the pen lab's pad has one; the Draw workspace will have the document's), seeds a
//! stroke with the tiles its dabs can reach, runs the engine's `StrokeEngine`, and applies the stroke's exact undo records
//! when it ends.

use super::mapping::Mapping;
use super::stroke_input::StrokeCommand;
use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
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
    Snapshot { token: u64 },
    Ping { token: u64 },
    Shutdown,
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
    /// sequence of at least `seq` is on the screen.
    Dabs { stroke: u64, seq: u64, dabs: Vec<WetDab>, generate_ms: f64, newest_ns: u64 },
    /// The tiles batch `seq` changed, with their pixels now.
    Tiles { stroke: u64, seq: u64, tiles: Vec<(i64, i64, Vec<u8>)>, raster_ms: f64, newest_ns: u64 },
    /// The stroke ended and is one undo step; its tiles were all sent in `Tiles`.
    Finished { stroke: u64, changed_tiles: usize, dabs: usize },
    /// The stroke was discarded: these tiles go back to what the cel holds.
    Cancelled { stroke: u64, restore: Vec<TileUpdate> },
    /// Undo, redo or clear changed these tiles.
    Replaced { tiles: Vec<TileUpdate> },
    Failed { stroke: u64, message: String },
    Snapshot { token: u64, tiles: Vec<(i64, i64, Vec<u8>)> },
    Pong { token: u64 },
}

/// The handle on the worker thread.
pub struct Worker {
    requests: Sender<Request>,
    replies: Mutex<Receiver<Reply>>,
    /// The highest stroke id cancelled: the worker stops a stroke whose id is at or below it between batches.
    cancelled: Arc<AtomicU64>,
    queued: Arc<AtomicUsize>,
    thread: Option<JoinHandle<()>>,
}

impl Worker {
    /// Starts the worker over a cel of `tiles` (empty for a blank cel).
    pub fn spawn(tiles: Vec<(i64, i64, Vec<u8>)>, waker: Waker) -> Worker {
        let (requests, receiver) = channel();
        let (reply_sender, replies) = channel();
        let cancelled = Arc::new(AtomicU64::new(0));
        let queued = Arc::new(AtomicUsize::new(0));
        let state = (cancelled.clone(), queued.clone());
        let thread = std::thread::Builder::new()
            .name("styk-drawing".into())
            .spawn(move || run(tiles, receiver, reply_sender, state.0, state.1, waker))
            .expect("the drawing worker thread starts");
        Worker { requests, replies: Mutex::new(replies), cancelled, queued, thread: Some(thread) }
    }

    /// Samples sent and not yet taken by the worker.
    pub fn queued(&self) -> usize {
        self.queued.load(Ordering::Relaxed)
    }

    /// Sends a stroke command; actions are the interface's and are ignored here. `settings` is the brush as JSON.
    pub fn command(&self, command: StrokeCommand, settings: &Arc<str>) {
        let request = match command {
            StrokeCommand::Begin { id, erase, mapping, .. } => Request::Begin { id, erase, mapping, settings: settings.clone() },
            StrokeCommand::Sample { id, x, y, pressure, time_ms, lean } => {
                self.queued.fetch_add(1, Ordering::Relaxed);
                Request::Sample { id, x, y, pressure, time_ms, lean }
            }
            StrokeCommand::End { id } => Request::End { id },
            StrokeCommand::Cancel { id } => {
                // The flag stops a batch in progress; the message wakes a worker that is waiting.
                self.cancelled.fetch_max(id, Ordering::SeqCst);
                Request::Cancel { id }
            }
            StrokeCommand::Action(_) => return,
        };
        let _ = self.requests.send(request);
    }

    pub fn send(&self, request: Request) {
        let _ = self.requests.send(request);
    }

    /// The replies waiting, without blocking.
    pub fn drain(&self, out: &mut Vec<Reply>) {
        let replies = self.replies.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        while let Ok(reply) = replies.try_recv() {
            out.push(reply);
        }
    }

    /// Waits for one reply; for tests and tools, never for the interface thread.
    pub fn wait(&self, timeout: Duration) -> Option<Reply> {
        let replies = self.replies.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        match replies.recv_timeout(timeout) {
            Ok(reply) => Some(reply),
            Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => None,
        }
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.requests.send(Request::Shutdown);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

struct Path {
    flips: (bool, bool),
    stroke: BrushStroke,
}

struct Current {
    id: u64,
    mapping: Mapping,
    paths: Vec<Path>,
    pending: Vec<Dab>,
    seeded: HashSet<(i64, i64)>,
    tail_version: u64,
    batch_limit: usize,
    dabs: usize,
    /// The device time of the newest sample the batches so far include.
    newest_ns: u64,
}

struct State {
    cel: TileStore,
    engine: StrokeEngine,
    current: Option<Current>,
    seq: u64,
    undo: Vec<Vec<TileChange>>,
    redo: Vec<Vec<TileChange>>,
    replies: Sender<Reply>,
    cancelled: Arc<AtomicU64>,
    waker: Waker,
}

fn run(tiles: Vec<(i64, i64, Vec<u8>)>, requests: Receiver<Request>, replies: Sender<Reply>, cancelled: Arc<AtomicU64>, queued: Arc<AtomicUsize>, waker: Waker) {
    let mut cel = TileStore::new();
    for (tx, ty, pixels) in tiles {
        let _ = cel.set(tx, ty, Some(&pixels));
    }
    let mut state = State { cel, engine: StrokeEngine::new(), current: None, seq: 0, undo: Vec::new(), redo: Vec::new(), replies, cancelled, waker };
    while let Ok(first) = requests.recv() {
        // Everything that arrived while the last batch was drawn is one batch of samples.
        let mut batch = vec![first];
        while let Ok(next) = requests.try_recv() {
            batch.push(next);
        }
        for request in batch {
            if matches!(request, Request::Sample { .. }) {
                queued.fetch_sub(1, Ordering::Relaxed);
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
            Request::Snapshot { token } => {
                let tiles = self.cel.iter().map(|tile| (tile.tx as i64, tile.ty as i64, tile.pixels.to_vec())).collect();
                self.reply(Reply::Snapshot { token, tiles });
            }
            Request::Ping { token } => self.reply(Reply::Pong { token }),
        }
        true
    }

    fn fail(&mut self, stroke: u64, message: impl Into<String>) {
        self.current = None;
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
        let paths = mapping
            .paths()
            .into_iter()
            .enumerate()
            .map(|(index, flips)| Path { flips, stroke: BrushStroke::new(brush.clone(), Some(brush.seed.wrapping_add(PATH_SEED_STEP.wrapping_mul(index as u32)))) })
            .collect();
        // Batches are at most `max(512, min(8192, floor(262144 / (2.2 * r * 2 + 2)^2)))` dabs, as in the JavaScript controller.
        let diameter = 2.2 * brush.size + 2.0;
        let batch_limit = (262_144.0 / (diameter * diameter)).floor().clamp(512.0, 8192.0) as usize;
        self.current = Some(Current { id, mapping, paths, pending: Vec::new(), seeded: HashSet::new(), tail_version: 0, batch_limit, dabs: 0, newest_ns: 0 });
    }

    fn sample(&mut self, id: u64, window: (f64, f64), pressure: f64, time_ms: f64, lean: Option<(f64, f64)>) {
        let Some(current) = self.current.as_mut().filter(|c| c.id == id) else { return };
        current.newest_ns = (time_ms * 1e6).round() as u64;
        for path in &mut current.paths {
            let Some((x, y, ax, ay)) = current.mapping.cel_sample(path.flips, window, lean) else { continue };
            let input = Sample { x, y, pressure: Some(pressure), time: Some(time_ms), ax: Some(ax), ay: Some(ay) };
            if let Err(error) = path.stroke.sample(&input, &mut |dab| current.pending.push(dab)) {
                return self.fail(id, error.to_string());
            }
        }
    }

    /// Rasterises the dabs waiting, a batch at a time, with one batch outstanding.
    fn flush(&mut self, finishing: bool) {
        loop {
            let Some(current) = self.current.as_mut() else { return };
            let id = current.id;
            if self.cancelled.load(Ordering::SeqCst) >= id {
                current.pending.clear();
                return;
            }
            let tail_version: u64 = current.paths.iter().map(|path| path.stroke.tail_version).sum();
            let tail_changed = !finishing && current.paths[0].stroke.has_tail() && tail_version != current.tail_version;
            if current.pending.is_empty() && !tail_changed {
                return;
            }
            let take = current.pending.len().min(current.batch_limit);
            let dabs: Vec<Dab> = current.pending.drain(..take).collect();
            let last = current.pending.is_empty();
            let tail: Option<Vec<Dab>> = (last && tail_changed).then(|| {
                current.tail_version = tail_version;
                current.paths.iter_mut().flat_map(|path| path.stroke.tail_shapes().to_vec()).collect()
            });
            current.dabs += dabs.len();
            let generated = Instant::now();
            let mut seeds = Vec::new();
            for dab in dabs.iter().chain(tail.iter().flatten()) {
                for ty in tile_range(dab.top, dab.bottom) {
                    for tx in tile_range(dab.left, dab.right) {
                        if current.seeded.insert((tx, ty)) {
                            seeds.push(SeedTile { tx, ty, pixels: self.cel.get(tx, ty).map(|tile| tile.pixels.to_vec()) });
                        }
                    }
                }
            }
            self.seq += 1;
            let seq = self.seq;
            let wet = dabs.iter().map(|d| WetDab { x: d.x as f32, y: d.y as f32, radius: d.radius as f32, opacity: (d.opacity * d.flow) as f32 }).collect();
            let generate_ms = generated.elapsed().as_secs_f64() * 1e3;
            let newest_ns = self.current.as_ref().map_or(0, |c| c.newest_ns);
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
        for path in &mut current.paths {
            path.stroke.finish(&mut |dab| current.pending.push(dab));
        }
        self.flush(true);
        let Some(current) = self.current.take() else { return };
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
        let Some(current) = self.current.take().filter(|c| c.id == id) else { return };
        self.engine.cancel(id);
        let restore = current.seeded.iter().map(|&(tx, ty)| (tx, ty, self.cel.get(tx, ty).map(|tile| tile.pixels.to_vec()))).collect();
        self.reply(Reply::Cancelled { stroke: id, restore });
    }

    fn step(&mut self, undo: bool) {
        let (from, to) = if undo { (&mut self.undo, &mut self.redo) } else { (&mut self.redo, &mut self.undo) };
        let Some(changes) = from.pop() else { return };
        if apply_tile_changes(&mut self.cel, &changes, !undo).is_err() {
            return;
        }
        let tiles = changes.iter().map(|c| (c.tx as i64, c.ty as i64, self.cel.get(c.tx as i64, c.ty as i64).map(|tile| tile.pixels.to_vec()))).collect();
        to.push(changes);
        self.reply(Reply::Replaced { tiles });
    }

    fn clear(&mut self) {
        let before: Vec<Tile> = self.cel.iter().cloned().collect();
        let changes: Vec<TileChange> = before.iter().filter_map(|tile| change_of(tile.tx, tile.ty, Some(&tile.pixels), None)).collect();
        if changes.is_empty() || apply_tile_changes(&mut self.cel, &changes, true).is_err() {
            return;
        }
        let tiles = changes.iter().map(|c| (c.tx as i64, c.ty as i64, None)).collect();
        self.undo.push(changes);
        self.redo.clear();
        self.reply(Reply::Replaced { tiles });
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
