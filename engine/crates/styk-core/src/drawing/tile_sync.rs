//! Which of the cel's tiles are on the GPU, and how the worker's replies get there: the residency of the pad's tile atlas.
//!
//! The cel lives in the drawing worker; the GPU holds only the tiles the view shows (a bounded atlas of `capacity` slots).
//! This type is the whole policy, with no GPU in it, so it is tested on its own; the pad's `prepare` only performs the
//! [`Write`]s it plans.
//!
//! - **Bounded without a gate.** Every reply is taken as it comes: the worker rasterises at most
//!   [`MAX_OUTSTANDING`](super::worker::MAX_OUTSTANDING) batches ahead of the ones acknowledged, so what waits here is
//!   bounded by that window, and a lifecycle reply (a cancel, an undo) is never held behind tile data. A batch's parts are
//!   assembled as they arrive and only the tiles the view shows, or that are resident, are kept.
//! - **Atomic batches within a budget.** A batch of tiles from a stroke appears all at once, so the atlas never shows part of
//!   a batch while the wet ink still shows all of it (a soft edge would paint twice). Its tiles are written into *new* slots a
//!   few at a time over as many frames as the tile and time budgets need, and the batch is flipped into the view in the call
//!   that writes the last of them; every call places at least one tile, so the queue always advances.
//! - **Versions by order.** The worker numbers what it changes and answers in order. Everything this type has queued is
//!   older than the reply being accepted, so an undo, redo, clear, cancel or fetched tile removes the tile from every queued
//!   batch: a late batch can never cover newer pixels, and a tile is never left stale.
//! - **Eviction.** A tile needs a slot when it is shown and not resident. When none is free, tiles outside the view go first
//!   (least recently used first). The tiles of a stroke batch, which the person is drawing, may then take the slot of the least
//!   recently used visible tile; a fetched tile may not, and is declined (counted) until the view changes, so a view that pins
//!   more inked tiles than the atlas holds degrades to a view of the nearest ones instead of stalling or thrashing.
//! - **Residency by request.** Tiles that enter the view, and tiles changed by undo, redo, clear or a cancelled stroke, are
//!   fetched from the worker, [`FETCH_LIMIT`] at a time; a tile known to be empty is not asked for again.

use super::wet::WetLedger;
use super::worker::{FETCH_LIMIT, Reply};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;

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
    /// Tiles that could not be given a slot: every slot held a tile the view shows (counted when declined).
    pub unshown: u64,
    /// Tiles of stroke batches dropped on arrival because the view neither shows them nor holds them.
    pub hidden: u64,
    pub fetched: u64,
    /// Tiles removed from queued batches because a newer version of them had arrived (undo, redo, clear, cancel, fetch).
    pub superseded: u64,
}

struct Entry {
    slot: u32,
    used: u64,
}

struct Batch {
    stroke: u64,
    seq: u64,
    tiles: Vec<(i64, i64, Vec<u8>)>,
    newest_ns: u64,
}

/// A batch being written into new slots.
struct Staging {
    batch: Batch,
    /// The next tile of the batch to place.
    next: usize,
    /// `(key, new slot, slot of the resident tile it replaces)` for the tiles placed so far.
    placed: Vec<((i64, i64), u32, Option<u32>)>,
    keys: Arc<HashSet<(i64, i64)>>,
}

/// The residency of the tile atlas and the queue that feeds it.
pub struct TileSync {
    capacity: usize,
    resident: HashMap<(i64, i64), Entry>,
    free: Vec<u32>,
    visible: TileRect,
    clock: u64,
    assembling: Option<Batch>,
    pending: VecDeque<Batch>,
    staging: Option<Staging>,
    requested: HashSet<(i64, i64)>,
    empty: HashSet<(i64, i64)>,
    declined: HashSet<(i64, i64)>,
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
            assembling: None,
            pending: VecDeque::new(),
            staging: None,
            requested: HashSet::new(),
            empty: HashSet::new(),
            declined: HashSet::new(),
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

    /// Batches not yet in the view: being assembled, queued or being written.
    pub fn waiting(&self) -> usize {
        self.pending.len() + usize::from(self.staging.is_some()) + usize::from(self.assembling.is_some())
    }

    /// The sequence of the oldest batch not yet in the view, if any.
    pub fn waiting_seq(&self) -> Option<u64> {
        self.staging.iter().map(|s| s.batch.seq).chain(self.pending.front().map(|b| b.seq)).chain(self.assembling.iter().map(|b| b.seq)).min()
    }

    /// The newest sample time whose tiles are in the view.
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

    /// Sets the tiles the view shows.
    pub fn set_visible(&mut self, rect: TileRect) {
        if rect == self.visible {
            return;
        }
        self.visible = rect;
        self.clock += 1;
        self.declined.clear();
        for (key, entry) in self.resident.iter_mut() {
            if rect.contains(key.0, key.1) {
                entry.used = self.clock;
            }
        }
    }

    /// Tiles whose newest version the worker has: whatever this type has queued for them is older.
    fn supersede(&mut self, tiles: &[(i64, i64)]) {
        let keys: HashSet<(i64, i64)> = tiles.iter().copied().collect();
        let mut removed = 0u64;
        let mut strip = |batch: &mut Batch| {
            let before = batch.tiles.len();
            batch.tiles.retain(|(tx, ty, _)| !keys.contains(&(*tx, *ty)));
            removed += (before - batch.tiles.len()) as u64;
        };
        if let Some(batch) = self.assembling.as_mut() {
            strip(batch);
        }
        for batch in self.pending.iter_mut() {
            strip(batch);
        }
        if let Some(staging) = self.staging.as_mut() {
            // Tiles not yet placed go; placed ones give their new slot back (the flip skips them).
            let tail = staging.batch.tiles.split_off(staging.next);
            let mut rest = Batch { stroke: 0, seq: 0, tiles: tail, newest_ns: 0 };
            strip(&mut rest);
            staging.batch.tiles.extend(rest.tiles);
            let mut kept = Vec::new();
            for placed in std::mem::take(&mut staging.placed) {
                if keys.contains(&placed.0) {
                    self.free.push(placed.1);
                    removed += 1;
                } else {
                    kept.push(placed);
                }
            }
            staging.placed = kept;
        }
        self.stats.superseded += removed;
    }

    fn mark_changed(&mut self, tiles: &[(i64, i64)]) {
        self.supersede(tiles);
        for &key in tiles {
            self.empty.remove(&key);
            self.declined.remove(&key);
            if (self.resident.contains_key(&key) || self.visible.contains(key.0, key.1)) && !self.stale.contains(&key) {
                self.stale.push(key);
            }
        }
    }

    fn drop_pending_of(&mut self, stroke: u64, ack: &mut dyn FnMut(u64)) {
        if self.assembling.as_ref().is_some_and(|b| b.stroke == stroke) {
            let batch = self.assembling.take().expect("assembling");
            ack(batch.seq);
        }
        let mut kept = VecDeque::new();
        while let Some(batch) = self.pending.pop_front() {
            if batch.stroke == stroke {
                ack(batch.seq);
            } else {
                kept.push_back(batch);
            }
        }
        self.pending = kept;
        if self.staging.as_ref().is_some_and(|s| s.batch.stroke == stroke) {
            let staging = self.staging.take().expect("staging");
            for (_, slot, _) in staging.placed {
                self.free.push(slot);
            }
            ack(staging.batch.seq);
        }
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
            Reply::Tiles { stroke, seq, part, last, tiles, newest_ns, .. } => {
                if !ledger.is_stroke_open(stroke) {
                    if last {
                        self.assembling = None;
                        ack(seq);
                    }
                    return;
                }
                if part == 0 || self.assembling.as_ref().is_none_or(|b| b.seq != seq) {
                    self.assembling = Some(Batch { stroke, seq, tiles: Vec::new(), newest_ns });
                }
                let (visible, hidden): (Vec<_>, Vec<_>) = tiles.into_iter().partition(|(tx, ty, _)| self.visible.contains(*tx, *ty) || self.resident.contains_key(&(*tx, *ty)));
                self.stats.hidden += hidden.len() as u64;
                if let Some(batch) = self.assembling.as_mut() {
                    batch.tiles.extend(visible);
                }
                if last {
                    let batch = self.assembling.take().expect("assembling");
                    ledger.tiles_received(stroke, seq);
                    self.pending.push_back(batch);
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
            Reply::Cancelled { stroke, restore, .. } => {
                ledger.stroke_dropped(stroke);
                self.drop_pending_of(stroke, ack);
                if self.anchor.is_some_and(|a| a.0 == stroke) {
                    self.anchor = None;
                }
                self.mark_changed(&restore);
            }
            Reply::Changed { tiles, .. } => self.mark_changed(&tiles),
            Reply::Pixels { tiles } => {
                let keys: Vec<(i64, i64)> = tiles.iter().map(|t| (t.0, t.1)).collect();
                self.supersede(&keys);
                for (tx, ty, pixels, _) in tiles {
                    self.install_fetched((tx, ty), pixels);
                }
            }
            Reply::Snapshot { .. } | Reply::Pong { .. } => {}
        }
    }

    fn install_fetched(&mut self, key: (i64, i64), pixels: Option<Vec<u8>>) {
        self.requested.remove(&key);
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
                match self.slot_for(key, allocate, None) {
                    Some(slot) => {
                        self.writes.push(Write { slot, tx: key.0, ty: key.1, pixels });
                        self.stats.fetched += 1;
                    }
                    None if allocate => {
                        self.declined.insert(key);
                        self.stats.unshown += 1;
                    }
                    None => {}
                }
            }
        }
    }

    /// A slot for a tile: its own if resident, else a free one, else one taken from the least recently used tile outside the
    /// view. With `priority` (the keys of a stroke batch) the least recently used visible tile outside those keys may go too.
    /// `None` when no slot can be had.
    fn slot_for(&mut self, key: (i64, i64), allocate: bool, priority: Option<&HashSet<(i64, i64)>>) -> Option<u32> {
        if let Some(entry) = self.resident.get_mut(&key) {
            entry.used = self.clock;
            return Some(entry.slot);
        }
        if !allocate {
            return None;
        }
        let slot = self.new_slot(priority)?;
        self.resident.insert(key, Entry { slot, used: self.clock });
        self.dirty = true;
        Some(slot)
    }

    /// A free slot, or one freed by evicting (see [`slot_for`](Self::slot_for)).
    fn new_slot(&mut self, priority: Option<&HashSet<(i64, i64)>>) -> Option<u32> {
        if let Some(slot) = self.free.pop() {
            return Some(slot);
        }
        let outside = self.resident.iter().filter(|(k, _)| !self.visible.contains(k.0, k.1)).min_by_key(|(k, e)| (self.visible.near(k.0, k.1), e.used)).map(|(k, _)| *k);
        let victim = outside.or_else(|| priority.and_then(|keys| self.resident.iter().filter(|(k, _)| !keys.contains(*k)).min_by_key(|(_, e)| e.used).map(|(k, _)| *k)))?;
        let entry = self.resident.remove(&victim).expect("the victim is resident");
        self.stats.evicted += 1;
        self.dirty = true;
        Some(entry.slot)
    }

    /// Writes waiting batches into the atlas: at least one tile a call, then while the tiles placed stay within `max_tiles` and
    /// `out_of_time` says no. A batch goes into the view in the call that places its last tile, and is acknowledged then.
    /// Returns how many tiles were written.
    pub fn install(&mut self, max_tiles: usize, out_of_time: &mut dyn FnMut() -> bool, ack: &mut dyn FnMut(u64)) -> usize {
        let mut written = 0;
        loop {
            if self.staging.is_none() {
                let Some(batch) = self.pending.pop_front() else { break };
                let keys = Arc::new(batch.tiles.iter().map(|t| (t.0, t.1)).collect());
                self.staging = Some(Staging { batch, next: 0, placed: Vec::new(), keys });
            }
            // Place tiles until the batch is done or the budget is.
            loop {
                let (index, len) = {
                    let staging = self.staging.as_ref().expect("staging");
                    (staging.next, staging.batch.tiles.len())
                };
                if index >= len {
                    break;
                }
                if written > 0 && (written >= max_tiles || out_of_time()) {
                    return written;
                }
                let (tx, ty, pixels) = {
                    let staging = self.staging.as_mut().expect("staging");
                    staging.next += 1;
                    let tile = &mut staging.batch.tiles[index];
                    (tile.0, tile.1, std::mem::take(&mut tile.2))
                };
                let key = (tx, ty);
                let keys = Arc::clone(&self.staging.as_ref().expect("staging").keys);
                self.empty.remove(&key);
                if !self.visible.contains(tx, ty) && !self.resident.contains_key(&key) {
                    continue;
                }
                // A new slot, so the tile appears with the whole batch; in place (not atomic) only when there is no spare slot.
                let replaced = self.resident.get(&key).map(|e| e.slot);
                let fresh = self.new_slot_for_stage(&keys);
                match (fresh, replaced) {
                    (Some(slot), old) => {
                        self.writes.push(Write { slot, tx, ty, pixels });
                        self.staging.as_mut().expect("staging").placed.push((key, slot, old));
                    }
                    (None, Some(slot)) => self.writes.push(Write { slot, tx, ty, pixels }),
                    (None, None) => {
                        self.stats.unshown += 1;
                        continue;
                    }
                }
                written += 1;
                self.stats.installed_tiles += 1;
            }
            // The last tile is placed: the batch goes into the view whole.
            let staging = self.staging.take().expect("staging");
            for (key, slot, old) in staging.placed {
                if let Some(old) = old {
                    self.free.push(old);
                }
                self.resident.insert(key, Entry { slot, used: self.clock });
            }
            self.dirty = true;
            self.exact_ns = self.exact_ns.max(staging.batch.newest_ns);
            ack(staging.batch.seq);
        }
        written
    }

    /// A slot for a staged tile; the victims never include a tile of the batch.
    fn new_slot_for_stage(&mut self, keys: &HashSet<(i64, i64)>) -> Option<u32> {
        self.new_slot(Some(keys))
    }

    /// The tiles to ask the worker for now: changed ones that are resident or shown, then shown ones that are neither resident,
    /// asked for, declined nor known to be empty, at most `limit` (and [`FETCH_LIMIT`]).
    pub fn plan_fetch(&mut self, limit: usize) -> Vec<(i64, i64)> {
        let limit = limit.min(FETCH_LIMIT);
        let mut out: Vec<(i64, i64)> = Vec::new();
        while out.len() < limit {
            let Some(key) = self.stale.pop() else { break };
            if (self.resident.contains_key(&key) || self.visible.contains(key.0, key.1)) && !out.contains(&key) {
                out.push(key);
            }
        }
        if out.len() < limit {
            'scan: for ty in self.visible.y0..=self.visible.y1 {
                for tx in self.visible.x0..=self.visible.x1 {
                    let key = (tx, ty);
                    if !self.resident.contains_key(&key) && !self.requested.contains(&key) && !self.empty.contains(&key) && !self.declined.contains(&key) && !out.contains(&key) {
                        out.push(key);
                        if out.len() >= limit {
                            break 'scan;
                        }
                    }
                }
            }
        }
        for key in &out {
            self.requested.insert(*key);
        }
        out
    }
}

#[cfg(test)]
#[path = "tile_sync_tests.rs"]
mod tests;
