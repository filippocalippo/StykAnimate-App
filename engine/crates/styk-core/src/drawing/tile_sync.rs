//! Which of the cel's tiles are on the GPU, and how the worker's replies get there: the residency of the pad's tile atlas.
//!
//! The cel lives in the drawing worker; the GPU holds only the tiles the view shows (a bounded atlas of `capacity` slots).
//! This type is the whole policy, with no GPU in it, so it is tested on its own; the pad's `prepare` only performs the
//! [`Write`]s it plans.
//!
//! - **Bounded ingestion.** Replies are taken one at a time while the queued batches hold less than [`PENDING_BYTES`]; the
//!   rest wait in the worker's channel, which the worker's own acknowledgement window keeps short.
//! - **Atomic batches.** A batch of tiles from a stroke is installed whole in one call or not at all, so the atlas never shows
//!   part of a batch while the wet ink still shows all of it (a soft edge would paint twice). At least one batch is installed
//!   a call, so the queue always advances; the rest respect the tile and time budgets.
//! - **Eviction.** A batch needs a slot for each of its visible tiles that is not resident. When none is free, tiles outside
//!   the view are evicted, least recently used first. A batch that needs more than the view can pin is deferred, and one that
//!   needs more than the whole atlas is dropped, both counted: a refused tile is never acknowledged as shown.
//! - **Residency by request.** Tiles that enter the view, and tiles changed by undo, redo, clear or a cancelled stroke, are
//!   fetched from the worker, [`FETCH_LIMIT`] at a time; a tile known to be empty is not asked for again. A fetched tile never
//!   overwrites what a stroke batch installed after the fetch was asked for.

use super::wet::WetLedger;
use super::worker::{FETCH_LIMIT, Reply};
use std::collections::{HashMap, HashSet, VecDeque};

/// Bytes of installed-but-waiting batches after which no further reply is taken in a call.
pub const PENDING_BYTES: usize = 4 * 1024 * 1024;

/// Tiles outside the view that still count as near it (kept resident when there is room).
const MARGIN: i64 = 1;

/// Tiles known to be empty that are remembered; past it the memory is cleared.
const EMPTY_MEMORY: usize = 16_384;

/// A rectangle of tile indices, inclusive.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TileRect {
    pub x0: i64,
    pub y0: i64,
    pub x1: i64,
    pub y1: i64,
}

impl TileRect {
    /// The tiles a window of `width` by `height` cel pixels whose top-left is cel pixel `(x, y)` shows.
    pub fn of_view(x: f64, y: f64, width: f64, height: f64) -> TileRect {
        let tile = |v: f64| (v / 64.0).floor() as i64;
        TileRect { x0: tile(x), y0: tile(y), x1: tile(x + width.max(1.0) - 1e-6), y1: tile(y + height.max(1.0) - 1e-6) }
    }

    pub fn contains(&self, tx: i64, ty: i64) -> bool {
        (self.x0..=self.x1).contains(&tx) && (self.y0..=self.y1).contains(&ty)
    }

    fn near(&self, tx: i64, ty: i64) -> bool {
        (self.x0 - MARGIN..=self.x1 + MARGIN).contains(&tx) && (self.y0 - MARGIN..=self.y1 + MARGIN).contains(&ty)
    }

    pub fn count(&self) -> usize {
        ((self.x1 - self.x0 + 1).max(0) as usize) * ((self.y1 - self.y0 + 1).max(0) as usize)
    }
}

/// A tile to write into an atlas slot.
#[derive(Debug)]
pub struct Write {
    pub slot: u32,
    pub tx: i64,
    pub ty: i64,
    pub pixels: Vec<u8>,
}

/// What the residency has done.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SyncStats {
    pub installed_tiles: u64,
    pub evicted: u64,
    /// Times a batch had to wait because the view pinned too many slots.
    pub deferred: u64,
    /// Batches dropped because they needed more slots than the atlas has.
    pub dropped_batches: u64,
    pub fetched: u64,
    /// Fetched tiles discarded because a stroke batch installed a newer version meanwhile.
    pub fetch_superseded: u64,
}

struct Entry {
    slot: u32,
    used: u64,
    /// The batch counter when a stroke batch last wrote the tile.
    batch: u64,
}

struct PendingBatch {
    stroke: u64,
    seq: u64,
    tiles: Vec<(i64, i64, Vec<u8>)>,
    newest_ns: u64,
}

/// The residency of the tile atlas and the queue that feeds it.
pub struct TileSync {
    capacity: usize,
    resident: HashMap<(i64, i64), Entry>,
    free: Vec<u32>,
    visible: TileRect,
    clock: u64,
    batch_counter: u64,
    pending: VecDeque<PendingBatch>,
    pending_bytes: usize,
    requested: HashMap<(i64, i64), u64>,
    empty: HashSet<(i64, i64)>,
    stale: Vec<(i64, i64)>,
    writes: Vec<Write>,
    exact_ns: u64,
    anchor: Option<(u64, f32, f32, f32)>,
    dirty: bool,
    stats: SyncStats,
}

impl TileSync {
    pub fn new(capacity: usize) -> TileSync {
        TileSync {
            capacity,
            resident: HashMap::new(),
            free: (0..capacity as u32).rev().collect(),
            visible: TileRect { x0: 0, y0: 0, x1: -1, y1: -1 },
            clock: 0,
            batch_counter: 0,
            pending: VecDeque::new(),
            pending_bytes: 0,
            requested: HashMap::new(),
            empty: HashSet::new(),
            stale: Vec::new(),
            writes: Vec::new(),
            exact_ns: 0,
            anchor: None,
            dirty: true,
            stats: SyncStats::default(),
        }
    }

    pub fn stats(&self) -> SyncStats {
        self.stats
    }

    pub fn resident_count(&self) -> usize {
        self.resident.len()
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }

    /// Batches waiting to be installed.
    pub fn waiting(&self) -> usize {
        self.pending.len()
    }

    /// The sequence of the oldest batch still waiting, if any.
    pub fn waiting_seq(&self) -> Option<u64> {
        self.pending.front().map(|b| b.seq)
    }

    /// The newest sample time whose tiles are installed.
    pub fn exact_ns(&self) -> u64 {
        self.exact_ns
    }

    /// The last dab of the stroke being drawn, for the preview to continue from: `(stroke, x, y, radius)`.
    pub fn anchor(&self) -> Option<(u64, f32, f32, f32)> {
        self.anchor
    }

    /// Whether the resident set changed since the last call (the draw list must be rebuilt).
    pub fn take_dirty(&mut self) -> bool {
        std::mem::take(&mut self.dirty)
    }

    /// The writes planned since the last call.
    pub fn take_writes(&mut self) -> Vec<Write> {
        std::mem::take(&mut self.writes)
    }

    /// The resident tiles and their slots.
    pub fn resident(&self) -> impl Iterator<Item = ((i64, i64), u32)> + '_ {
        self.resident.iter().map(|(key, entry)| (*key, entry.slot))
    }

    /// Whether another reply may be taken: the waiting batches hold less than [`PENDING_BYTES`].
    pub fn has_room(&self) -> bool {
        self.pending_bytes < PENDING_BYTES
    }

    /// Sets the tiles the view shows.
    pub fn set_visible(&mut self, rect: TileRect) {
        if rect == self.visible {
            return;
        }
        self.visible = rect;
        self.clock += 1;
        for (key, entry) in self.resident.iter_mut() {
            if rect.contains(key.0, key.1) {
                entry.used = self.clock;
            }
        }
    }

    fn mark_changed(&mut self, tiles: impl IntoIterator<Item = (i64, i64)>) {
        for key in tiles {
            self.empty.remove(&key);
            if (self.resident.contains_key(&key) || self.visible.contains(key.0, key.1)) && !self.stale.contains(&key) {
                self.stale.push(key);
            }
        }
    }

    fn drop_pending_of(&mut self, stroke: u64, ack: &mut dyn FnMut(u64)) {
        let mut kept = VecDeque::new();
        while let Some(batch) = self.pending.pop_front() {
            if batch.stroke == stroke {
                self.pending_bytes -= batch.tiles.iter().map(|t| t.2.len()).sum::<usize>();
                ack(batch.seq);
            } else {
                kept.push_back(batch);
            }
        }
        self.pending = kept;
    }

    /// Takes one reply of the worker.
    pub fn accept(&mut self, reply: Reply, ledger: &mut WetLedger, ack: &mut dyn FnMut(u64)) {
        match reply {
            Reply::Dabs { stroke, seq, dabs, newest_ns, .. } => {
                if let Some(last) = dabs.last() {
                    self.anchor = Some((stroke, last.x, last.y, last.radius));
                }
                ledger.dabs(stroke, seq, dabs, newest_ns);
            }
            Reply::Tiles { stroke, seq, tiles, newest_ns, .. } => {
                if ledger.tiles_received(stroke, seq) {
                    self.pending_bytes += tiles.iter().map(|t| t.2.len()).sum::<usize>();
                    self.pending.push_back(PendingBatch { stroke, seq, tiles, newest_ns });
                } else {
                    ack(seq);
                }
            }
            Reply::Finished { stroke, .. } => {
                ledger.stroke_ended(stroke);
                if self.anchor.is_some_and(|a| a.0 == stroke) {
                    self.anchor = None;
                }
            }
            Reply::Failed { stroke, .. } => {
                ledger.stroke_dropped(stroke);
                self.drop_pending_of(stroke, ack);
                if self.anchor.is_some_and(|a| a.0 == stroke) {
                    self.anchor = None;
                }
            }
            Reply::Cancelled { stroke, restore } => {
                ledger.stroke_dropped(stroke);
                self.drop_pending_of(stroke, ack);
                if self.anchor.is_some_and(|a| a.0 == stroke) {
                    self.anchor = None;
                }
                self.mark_changed(restore);
            }
            Reply::Changed { tiles } => self.mark_changed(tiles),
            Reply::Pixels { tiles } => {
                for (tx, ty, pixels) in tiles {
                    self.install_fetched((tx, ty), pixels);
                }
            }
            Reply::Snapshot { .. } | Reply::Pong { .. } => {}
        }
    }

    fn install_fetched(&mut self, key: (i64, i64), pixels: Option<Vec<u8>>) {
        let asked = self.requested.remove(&key);
        if let (Some(asked), Some(entry)) = (asked, self.resident.get(&key)) {
            if entry.batch > asked {
                self.stats.fetch_superseded += 1;
                return;
            }
        }
        match pixels {
            None => {
                if let Some(entry) = self.resident.remove(&key) {
                    self.free.push(entry.slot);
                    self.dirty = true;
                }
                if self.empty.len() >= EMPTY_MEMORY {
                    self.empty.clear();
                }
                self.empty.insert(key);
            }
            Some(pixels) => {
                self.empty.remove(&key);
                let allocate = self.visible.contains(key.0, key.1);
                if let Some(slot) = self.slot_for(key, allocate) {
                    self.writes.push(Write { slot, tx: key.0, ty: key.1, pixels });
                    self.stats.fetched += 1;
                }
            }
        }
    }

    /// A slot for a tile: its own if resident, else a free one, else one taken from the least recently used tile outside the
    /// view. `None` when every slot holds a tile the view shows.
    fn slot_for(&mut self, key: (i64, i64), allocate: bool) -> Option<u32> {

        if let Some(entry) = self.resident.get_mut(&key) {
            entry.used = self.clock;
            return Some(entry.slot);
        }
        if !allocate {
            return None;
        }
        let slot = match self.free.pop() {
            Some(slot) => slot,
            None => {
                let victim = self.resident.iter().filter(|(k, _)| !self.visible.contains(k.0, k.1)).min_by_key(|(k, e)| (self.visible.near(k.0, k.1), e.used)).map(|(k, _)| *k)?;
                let entry = self.resident.remove(&victim).expect("the victim is resident");
                self.stats.evicted += 1;
                entry.slot
            }
        };
        self.resident.insert(key, Entry { slot, used: self.clock, batch: self.batch_counter });
        self.dirty = true;
        Some(slot)
    }

    /// Slots a batch would need that are not resident, and whether the atlas could supply them (free ones plus evictable ones).
    fn plan(&self, tiles: &[(i64, i64, Vec<u8>)]) -> (usize, bool) {
        let needed = tiles.iter().filter(|(tx, ty, _)| !self.resident.contains_key(&(*tx, *ty)) && self.visible.contains(*tx, *ty)).count();
        let evictable = self.resident.keys().filter(|k| !self.visible.contains(k.0, k.1)).count();
        (needed, needed <= self.free.len() + evictable)
    }

    /// Installs waiting batches: the first always (the queue advances), the rest while they fit `max_tiles` and `out_of_time`
    /// says no. Every installed or dropped batch is acknowledged. Returns how many tiles were written.
    pub fn install(&mut self, max_tiles: usize, out_of_time: &mut dyn FnMut() -> bool, ack: &mut dyn FnMut(u64)) -> usize {
        let mut written = 0;
        let mut first = true;
        while let Some(front) = self.pending.front() {
            if !first && (written + front.tiles.len() > max_tiles || out_of_time()) {
                break;
            }
            let (needed, fits) = self.plan(&front.tiles);
            if needed > self.capacity {
                let batch = self.pending.pop_front().expect("a front");
                self.pending_bytes -= batch.tiles.iter().map(|t| t.2.len()).sum::<usize>();
                self.stats.dropped_batches += 1;
                ack(batch.seq);
                first = false;
                continue;
            }
            if !fits {
                self.stats.deferred += 1;
                break;
            }
            let batch = self.pending.pop_front().expect("a front");
            self.pending_bytes -= batch.tiles.iter().map(|t| t.2.len()).sum::<usize>();
            self.batch_counter += 1;
            for (tx, ty, pixels) in batch.tiles {
                let key = (tx, ty);
                // A tile already resident is kept current; one that is new takes a slot only if the view shows it.
                let allocate = self.visible.contains(tx, ty);
                if let Some(slot) = self.slot_for(key, allocate) {
                    if let Some(entry) = self.resident.get_mut(&key) {
                        entry.batch = self.batch_counter;
                    }
                    self.writes.push(Write { slot, tx, ty, pixels });
                    written += 1;
                    self.stats.installed_tiles += 1;
                }
                self.empty.remove(&key);
            }
            self.exact_ns = self.exact_ns.max(batch.newest_ns);
            ack(batch.seq);
            first = false;
        }
        written
    }

    /// The tiles to ask the worker for now: changed ones that are resident or shown, then shown ones that are neither resident,
    /// asked for nor known to be empty, at most `limit` (and [`FETCH_LIMIT`]).
    pub fn plan_fetch(&mut self, limit: usize) -> Vec<(i64, i64)> {
        let limit = limit.min(FETCH_LIMIT);
        let mut out: Vec<(i64, i64)> = Vec::new();
        while out.len() < limit {
            let Some(key) = self.stale.pop() else { break };
            if self.resident.contains_key(&key) || self.visible.contains(key.0, key.1) {
                out.push(key);
            }
        }
        if out.len() < limit {
            'scan: for ty in self.visible.y0..=self.visible.y1 {
                for tx in self.visible.x0..=self.visible.x1 {
                    let key = (tx, ty);
                    if !self.resident.contains_key(&key) && !self.requested.contains_key(&key) && !self.empty.contains(&key) && !out.contains(&key) {
                        out.push(key);
                        if out.len() >= limit {
                            break 'scan;
                        }
                    }
                }
            }
        }
        for key in &out {
            self.requested.insert(*key, self.batch_counter);
        }
        out
    }
}


#[cfg(test)]
#[path = "tile_sync_tests.rs"]
mod tests;
