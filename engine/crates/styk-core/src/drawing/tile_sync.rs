//! Which of the cel's tiles are on the GPU, and how the worker's replies get there: the residency of the pad's tile atlas.
//!
//! The cel lives in the drawing worker; the GPU holds the tiles the view shows, in an atlas of pages. This type is the whole
//! policy, with no GPU in it, so it is tested on its own; the pad's `prepare` only performs the [`Write`]s it plans and grows the
//! texture to the pages it asks for.
//!
//! The model is today's (`src/drawing-resources.mjs` `reserve`): the tiles the view shows, and the batches being staged, are the
//! *required set*. The atlas holds the required set above its soft budget (one page) by growing a page at a time up to the hard
//! budget; only tiles out of view are ever evicted (least recently used first); above the hard budget a tile is refused, visibly
//! (`refused` in [`SyncStats`], which the pad reports). A visible tile is never evicted, so a view never loses a tile to make room
//! for another, and nothing is written in place over a tile the view shows.
//!
//! - **Bounded without a gate.** Every reply is taken as it comes: the worker rasterises at most
//!   [`MAX_OUTSTANDING`](super::worker::MAX_OUTSTANDING) batches ahead of the ones acknowledged, so what waits here is
//!   bounded by that window, and a lifecycle reply (a cancel, an undo) is never held behind tile data. A batch's parts are
//!   assembled as they arrive and only the tiles the view shows, or that are resident, are kept.
//! - **Atomic batches within a budget.** A batch of tiles from a stroke appears all at once, so the atlas never shows part of
//!   a batch while the wet ink still shows all of it (a soft edge would paint twice). Its tiles are written into *new* slots a
//!   few at a time over as many frames as the tile and time budgets need, and the batch is flipped into the view in the call
//!   that writes the last of them; every call places at least one tile, so the queue always advances. The tiles of a batch are
//!   protected from eviction while it is staged.
//! - **Versions by order.** The worker numbers what it changes and answers in order. Everything this type has queued is
//!   older than the reply being accepted, so an undo, redo, clear, cancel, failure or fetched tile removes the tile from every
//!   queued batch: a late batch can never cover newer pixels. A fetched tile of the open stroke holds the ink of every batch up
//!   to the one the reply names, so it waits until those batches are in the view (it would paint them over their preview).
//! - **Residency by request.** Tiles that enter the view, and tiles changed by undo, redo, clear or a cancelled or failed stroke,
//!   are fetched from the worker, [`FETCH_LIMIT`] at a time; a tile known to be empty is not asked for again. A request the
//!   worker refused is given back ([`TileSync::fetch_refused`]).

use super::wet::WetLedger;
use super::worker::{FETCH_LIMIT, Reply, TileUpdate};
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
    /// Tiles out of view that gave their slot to another.
    pub evicted: u64,
    /// Tiles refused a slot because the required set is above the hard budget: the memory is full (shown to the person).
    pub refused: u64,
    /// Tiles of stroke batches dropped on arrival because the view neither shows them nor holds them.
    pub hidden: u64,
    pub fetched: u64,
    /// Tiles removed from queued batches because a newer version of them had arrived (undo, redo, clear, cancel, fetch).
    pub superseded: u64,
    /// Pages the atlas grew by.
    pub pages_grown: u64,
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

/// Fetched tiles of the open stroke waiting for the batches they include to be in the view.
struct Held {
    upto: u64,
    tiles: Vec<TileUpdate>,
}

/// The residency of the tile atlas and the queue that feeds it.
pub struct TileSync {
    page_slots: usize,
    max_pages: usize,
    pages: usize,
    resident: HashMap<(i64, i64), Entry>,
    free: Vec<u32>,
    visible: TileRect,
    clock: u64,
    assembling: Option<Batch>,
    pending: VecDeque<Batch>,
    staging: Option<Staging>,
    held: Vec<Held>,
    requested: HashSet<(i64, i64)>,
    empty: HashSet<(i64, i64)>,
    refused: HashSet<(i64, i64)>,
    stale: Vec<(i64, i64)>,
    writes: Vec<Write>,
    exact_ns: u64,
    anchor: Option<(u64, f32, f32, f32)>,
    dirty: bool,
    stats: SyncStats,
}

impl TileSync {
    /// An atlas of one page of `page_slots` tiles (the soft budget) that may grow to `max_pages` (the hard budget).
    pub fn new(page_slots: usize, max_pages: usize) -> TileSync {
        TileSync {
            page_slots,
            max_pages: max_pages.max(1),
            pages: 1,
            resident: HashMap::new(),
            free: (0..page_slots as u32).rev().collect(),
            visible: TileRect { x0: 0, y0: 0, x1: -1, y1: -1 },
            clock: 0,
            assembling: None,
            pending: VecDeque::new(),
            staging: None,
            held: Vec::new(),
            requested: HashSet::new(),
            empty: HashSet::new(),
            refused: HashSet::new(),
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

    /// Slots the atlas has now (the pages it has grown to).
    pub fn capacity(&self) -> usize {
        self.pages * self.page_slots
    }

    /// Pages the atlas has now: the texture must have at least this many layers before the writes are performed.
    pub fn pages(&self) -> usize {
        self.pages
    }

    pub fn page_slots(&self) -> usize {
        self.page_slots
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
        self.refused.clear();
        for (key, entry) in self.resident.iter_mut() {
            if rect.contains(key.0, key.1) {
                entry.used = self.clock;
            }
        }
    }

    /// Gives a slot back. A refusal may have been for want of it, so refused tiles are asked for again.
    fn release_slot(&mut self, slot: u32) {
        self.free.push(slot);
        self.refused.clear();
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
        let mut freed = Vec::new();
        if let Some(staging) = self.staging.as_mut() {
            // Tiles not yet placed go; placed ones give their new slot back (the flip skips them).
            let tail = staging.batch.tiles.split_off(staging.next);
            let mut rest = Batch { stroke: 0, seq: 0, tiles: tail, newest_ns: 0 };
            strip(&mut rest);
            staging.batch.tiles.extend(rest.tiles);
            let mut kept = Vec::new();
            for placed in std::mem::take(&mut staging.placed) {
                if keys.contains(&placed.0) {
                    freed.push(placed.1);
                    removed += 1;
                } else {
                    kept.push(placed);
                }
            }
            staging.placed = kept;
        }
        for slot in freed {
            self.release_slot(slot);
        }
        // Fetched tiles still held are older than what arrived.
        for held in self.held.iter_mut() {
            held.tiles.retain(|(tx, ty, _, _)| !keys.contains(&(*tx, *ty)));
        }
        self.held.retain(|held| !held.tiles.is_empty());
        self.stats.superseded += removed;
    }

    fn mark_changed(&mut self, tiles: &[(i64, i64)]) {
        self.supersede(tiles);
        for &key in tiles {
            self.empty.remove(&key);
            self.refused.remove(&key);
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
                self.release_slot(slot);
            }
            ack(staging.batch.seq);
        }
    }

    /// The end of a stroke that was cancelled or failed: its preview and queued batches go, and the tiles it had reached (some of
    /// its batches may be in the view) are given back to the cel's own pixels.
    fn stroke_discarded(&mut self, stroke: u64, restore: &[(i64, i64)], ledger: &mut WetLedger, ack: &mut dyn FnMut(u64)) {
        ledger.stroke_dropped(stroke);
        self.drop_pending_of(stroke, ack);
        if self.anchor.is_some_and(|a| a.0 == stroke) {
            self.anchor = None;
        }
        self.mark_changed(restore);
        self.release_held();
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
            Reply::Failed { stroke, restore, .. } => self.stroke_discarded(stroke, &restore, ledger, ack),
            Reply::Cancelled { stroke, restore, .. } => self.stroke_discarded(stroke, &restore, ledger, ack),
            Reply::Changed { tiles, .. } => self.mark_changed(&tiles),
            Reply::Pixels { tiles, upto } => {
                let keys: Vec<(i64, i64)> = tiles.iter().map(|t| (t.0, t.1)).collect();
                self.supersede(&keys);
                self.held.push(Held { upto, tiles });
                self.release_held();
            }
            Reply::Snapshot { .. } | Reply::Pong { .. } => {}
        }
    }

    /// Installs the fetched tiles whose batches are all in the view: a tile of the open stroke holds the ink of every batch up to
    /// `upto`, and while any of them is still to appear the preview shows it, so the tile would paint it twice.
    fn release_held(&mut self) {
        let waiting = self.waiting_seq();
        let (ready, kept): (Vec<Held>, Vec<Held>) = std::mem::take(&mut self.held).into_iter().partition(|held| held.upto == 0 || waiting.is_none_or(|w| held.upto < w));
        self.held = kept;
        for held in ready {
            for (tx, ty, pixels, _) in held.tiles {
                self.install_fetched((tx, ty), pixels);
            }
        }
    }

    fn install_fetched(&mut self, key: (i64, i64), pixels: Option<Vec<u8>>) {
        self.requested.remove(&key);
        match pixels {
            None => {
                if let Some(entry) = self.resident.remove(&key) {
                    self.release_slot(entry.slot);
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
                match self.slot_for(key, allocate) {
                    Some(slot) => {
                        self.writes.push(Write { slot, tx: key.0, ty: key.1, pixels });
                        self.stats.fetched += 1;
                    }
                    None if allocate => {
                        self.refused.insert(key);
                        self.stats.refused += 1;
                    }
                    None => {}
                }
            }
        }
    }

    /// A slot for a tile: its own if resident, else a new one (see [`new_slot`](Self::new_slot)) when `allocate`.
    fn slot_for(&mut self, key: (i64, i64), allocate: bool) -> Option<u32> {
        if let Some(entry) = self.resident.get_mut(&key) {
            entry.used = self.clock;
            return Some(entry.slot);
        }
        if !allocate {
            return None;
        }
        let slot = self.new_slot()?;
        self.resident.insert(key, Entry { slot, used: self.clock });
        self.dirty = true;
        Some(slot)
    }

    /// A free slot; else the slot of the least recently used tile out of view that no staged batch is about to replace; else a new
    /// page, up to the hard budget. `None` above it: the memory is full. A tile the view shows is never evicted.
    fn new_slot(&mut self) -> Option<u32> {
        if let Some(slot) = self.free.pop() {
            return Some(slot);
        }
        let protect = self.staging.as_ref().map(|s| Arc::clone(&s.keys));
        let victim = self
            .resident
            .iter()
            .filter(|(k, _)| !self.visible.contains(k.0, k.1) && !protect.as_ref().is_some_and(|keys| keys.contains(*k)))
            .min_by_key(|(k, e)| (self.visible.near(k.0, k.1), e.used))
            .map(|(k, _)| *k);
        if let Some(victim) = victim {
            let entry = self.resident.remove(&victim).expect("the victim is resident");
            self.stats.evicted += 1;
            self.dirty = true;
            return Some(entry.slot);
        }
        if self.pages < self.max_pages {
            let first = (self.pages * self.page_slots) as u32;
            self.pages += 1;
            self.stats.pages_grown += 1;
            self.free.extend((first..first + self.page_slots as u32).rev());
            return self.free.pop();
        }
        None
    }

    /// Writes waiting batches into the atlas: at least one tile a call, then while the tiles placed stay within `max_tiles` and
    /// `out_of_time` says no. A batch goes into the view in the call that places its last tile, and is acknowledged then.
    /// Returns how many tiles were written.
    pub fn install(&mut self, max_tiles: usize, out_of_time: &mut dyn FnMut() -> bool, ack: &mut dyn FnMut(u64)) -> usize {
        let written = self.install_batches(max_tiles, out_of_time, ack);
        self.release_held();
        written
    }

    fn install_batches(&mut self, max_tiles: usize, out_of_time: &mut dyn FnMut() -> bool, ack: &mut dyn FnMut(u64)) -> usize {
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
                self.empty.remove(&key);
                if !self.visible.contains(tx, ty) && !self.resident.contains_key(&key) {
                    continue;
                }
                // Always a new slot, so the tile appears with the whole batch and the old pixels show until then.
                let Some(slot) = self.new_slot() else {
                    self.stats.refused += 1;
                    continue;
                };
                let old = self.resident.get(&key).map(|e| e.slot);
                self.writes.push(Write { slot, tx, ty, pixels });
                self.staging.as_mut().expect("staging").placed.push((key, slot, old));
                written += 1;
                self.stats.installed_tiles += 1;
            }
            // The last tile is placed: the batch goes into the view whole.
            let staging = self.staging.take().expect("staging");
            for (key, slot, old) in staging.placed {
                if let Some(old) = old {
                    self.release_slot(old);
                }
                self.resident.insert(key, Entry { slot, used: self.clock });
            }
            self.dirty = true;
            self.exact_ns = self.exact_ns.max(staging.batch.newest_ns);
            ack(staging.batch.seq);
        }
        written
    }

    /// The tiles to ask the worker for now: changed ones that are resident or shown, then shown ones that are neither resident,
    /// asked for, refused nor known to be empty, at most `limit` (and [`FETCH_LIMIT`]).
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
                    if !self.resident.contains_key(&key) && !self.requested.contains(&key) && !self.empty.contains(&key) && !self.refused.contains(&key) && !out.contains(&key) {
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

    /// The worker refused the request for these tiles (too many waiting): they were never asked for, so they are asked for again.
    pub fn fetch_refused(&mut self, keys: &[(i64, i64)]) {
        for key in keys {
            self.requested.remove(key);
            if !self.stale.contains(key) {
                self.stale.push(*key);
            }
        }
    }
}

#[cfg(test)]
#[path = "tile_sync_tests.rs"]
mod tests;
