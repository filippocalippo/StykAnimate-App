//! Drawing cels held live: the pixels the drawing workspace is editing, shown before they
//! are published as tiles.
//!
//! A published cel (`DrawingTiles`) is decoded from a blob of PNG tiles on the engine's
//! workers and laid out once in the sprite atlas ([`crate::assets`]); a stroke, a fill or a
//! floating selection changes the cel many times before the blob is encoded. The interface
//! hands the engine the tiles that changed (raw straight-alpha RGBA, 64×64, in the cel's
//! pixel space); this module keeps the cel's reduced levels and its atlas slots current
//! with them, so the draw list shows the pixels as soon as they exist.
//!
//! A live cel draws exactly what the published cel of the same pixels draws
//! ([`crate::drawing`]): the same reduced levels (`down_tile`), halo and border texels
//! (`bordered`), tile order and parent records. Only the slots differ: they are
//! allocated from pages after the document's own ([`LiveView::base`]), a slot per drawn
//! tile that is reused when the tile goes, and written in place when a tile changes.
//!
//! * `base` is the cel's own pixels; shown, it replaces the published cel.
//! * `float` is a floating selection: its tiles drawn through `matrix` (cel pixels to cel
//!   pixels) right after the base, in the same place among the layers.
//!
//! Only the levels the view shows are written (the host says which with
//! [`LiveCels::set_resident`], from [`shown_levels`] of the list it is about to draw); the
//! others are remembered stale and written when a view first calls for them. The module is pure:
//! it marks the slots a change reaches and the host takes them as [`Run`]s ([`LiveCels::take_runs`]) once a
//! frame, writing them into its atlas.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap as StdMap, HashSet as StdSet};

use styk_draw::{DrawList, F_DRAWING, K_IMAGE};

use crate::assets::{AtlasEntry, PAGE};
pub use crate::drawing::TILE_BYTES;
use crate::drawing::{bordered, bordered_into, changed_rect, down_tile, down_tile_patch, CoordBuild, BORDER, MAX_LEVEL, TILE};

/// Maps and sets keyed by tile coordinates or slots.
type HashMap<K, V> = StdMap<K, V, CoordBuild>;
type HashSet<K> = StdSet<K, CoordBuild>;

/// A set of display levels: bit `n` is level `n`.
pub type Levels = u16;
/// Every level, 0 to [`MAX_LEVEL`].
pub const ALL_LEVELS: Levels = (1 << (MAX_LEVEL + 1)) - 1;

/// Texels a slot covers: a tile and its border on every side.
pub const CELL: u32 = TILE + 2 * BORDER;
/// Slots across and down a page.
const COLUMNS: u32 = (PAGE - 2 * BORDER - TILE) / CELL + 1;
/// Slots a page holds.
pub const PAGE_SLOTS: u32 = COLUMNS * COLUMNS;
/// Pages live cels may use together (4,096² texels each, 64 MiB).
pub const MAX_PAGES: u32 = 4;

/// Milliseconds after the last change to a live cel during which a frame has no time to spare for pictures
/// ([`LiveCels::picture_budget`]), and the ones after it during which a burst of them would still land on the frame a
/// next stroke begins on.
pub const CHANGING_MS: f64 = 250.0;
pub const SETTLING_MS: f64 = 1500.0;
/// The most decoded pictures a frame uploads in each of those periods.
pub const CHANGING_PICTURE_BYTES: usize = 512 << 10;
pub const SETTLING_PICTURE_BYTES: usize = 2 << 20;

/// The slots are all in use: the interface drops cels it can do without and tries again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Full;

impl std::fmt::Display for Full {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the live drawing slots are full")
    }
}

/// Slots written side by side in one row of a live page, as one rectangle of `cells` × [`CELL`]
/// straight-alpha RGBA texels at `(x, y)` (the corner of the first cell, border included).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Run {
    pub page: u32,
    pub x: u32,
    pub y: u32,
    pub cells: u32,
    pub rgba: Vec<u8>,
}

/// Where a slot sits in the live pages.
fn place(slot: u32) -> (u32, u32, u32) {
    let (page, cell) = (slot / PAGE_SLOTS, slot % PAGE_SLOTS);
    (page, BORDER + CELL * (cell % COLUMNS), BORDER + CELL * (cell / COLUMNS))
}

struct Pool {
    /// Slots given back, the lowest taken first: the pages fill from the start, and the tiles of a
    /// row of the cel tend to sit side by side in a row of the page, which [`LiveCels::take_runs`] writes at once.
    free: BinaryHeap<Reverse<u32>>,
    /// Slots handed out so far at most: the pages the atlas needs.
    high: u32,
    capacity: u32,
}

impl Default for Pool {
    fn default() -> Self {
        Pool { free: BinaryHeap::new(), high: 0, capacity: MAX_PAGES * PAGE_SLOTS }
    }
}

impl Pool {
    /// Forgets every slot (no cel holds one any more).
    fn reset(&mut self) {
        *self = Pool { capacity: self.capacity, ..Pool::default() };
    }

    /// Counts the first page as needed, so the atlas has room for it before the first slot is taken.
    fn reserve_page(&mut self) {
        if self.high == 0 {
            self.high = 1;
            self.free.push(Reverse(0));
        }
    }

    fn take(&mut self) -> Result<u32, Full> {
        if let Some(Reverse(slot)) = self.free.pop() {
            return Ok(slot);
        }
        if self.high >= self.capacity {
            return Err(Full);
        }
        self.high += 1;
        Ok(self.high - 1)
    }
}

type Coord = (i32, i32);
type Level = HashMap<Coord, Vec<u8>>;

/// One set of tiles with its reduced levels and slots.
#[derive(Default)]
pub struct Layer {
    level0: Level,
    /// Levels 1 to [`MAX_LEVEL`] (index `n - 1`): the nonempty reduced tiles.
    reduced: Vec<Level>,
    /// The tiles drawn at each level 0 to [`MAX_LEVEL`], by row, then column: those covering
    /// a tile of the layer, and the ones around them (the halo).
    drawn: Vec<Vec<Coord>>,
    slots: Vec<HashMap<Coord, u32>>,
    /// The slots (by level) whose contents changed while their level was not resident: the
    /// atlas holds older pixels there until [`Layer::flush`] writes them.
    stale: Vec<HashSet<Coord>>,
    /// The slots to write before the next frame, by slot: the level and tile whose contents they take. A
    /// slot changed by several calls is built once, from the pixels as they are then.
    pending: HashMap<u32, (usize, Coord)>,
}

/// Whether the texels of a tile that its neighbour at `(dx, dy)` holds in its border differ between two
/// versions of the tile (`None`: no tile, transparent). The neighbour's slot changes only if they do.
fn facing_differs(before: Option<&[u8]>, after: Option<&[u8]>, dx: i32, dy: i32) -> bool {
    let (t, border) = (TILE as usize, BORDER as usize);
    let span = |d: i32| match d {
        -1 => (0, border),
        0 => (0, t),
        _ => (t - border, t),
    };
    let ((x0, x1), (y0, y1)) = (span(dx), span(dy));
    (y0..y1).any(|y| {
        let (from, to) = ((y * t + x0) * 4, (y * t + x1) * 4);
        match (before, after) {
            (Some(a), Some(b)) => a[from..to] != b[from..to],
            (Some(only), None) | (None, Some(only)) => only[from..to].iter().any(|&texel| texel != 0),
            (None, None) => false,
        }
    })
}

/// The texels of a whole tile as a rectangle `[x0, y0, x1, y1)`.
const WHOLE: [usize; 4] = [0, 0, TILE as usize, TILE as usize];

/// A tile that changed in an update: what it held before (`None`: nothing) and the rectangle of texels that may differ
/// from it now.
struct Dirt {
    before: Option<Vec<u8>>,
    rect: [usize; 4],
}

/// Notes that the tile at `coord` changed. A tile changed twice in one update keeps what it held first.
fn note(dirty: &mut HashMap<Coord, Dirt>, coord: Coord, before: Option<Vec<u8>>, rect: [usize; 4]) {
    match dirty.entry(coord) {
        std::collections::hash_map::Entry::Occupied(mut held) => {
            let held = held.get_mut();
            held.rect = [held.rect[0].min(rect[0]), held.rect[1].min(rect[1]), held.rect[2].max(rect[2]), held.rect[3].max(rect[3])];
        }
        std::collections::hash_map::Entry::Vacant(slot) => {
            slot.insert(Dirt { before, rect });
        }
    }
}

fn visible(pixels: &[u8]) -> bool {
    pixels.chunks_exact(4).any(|texel| texel[3] != 0)
}

impl Layer {
    fn level(&self, n: usize) -> &Level {
        if n == 0 { &self.level0 } else { &self.reduced[n - 1] }
    }

    /// The tiles drawn at `level`, in draw order.
    pub fn drawn(&self, level: usize) -> &[Coord] {
        self.drawn.get(level).map_or(&[], Vec::as_slice)
    }

    /// The slot of the tile `coord` drawn at `level`.
    pub fn slot(&self, level: usize, coord: Coord) -> Option<u32> {
        self.slots.get(level)?.get(&coord).copied()
    }

    /// Tiles with any visible texel.
    pub fn len(&self) -> usize {
        self.level0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.level0.is_empty()
    }

    /// Slots in use.
    pub fn slot_count(&self) -> usize {
        self.slots.iter().map(HashMap::len).sum()
    }

    /// The tile pixels of `coord` at level 0, when it holds any.
    pub fn tile(&self, coord: Coord) -> Option<&[u8]> {
        self.level0.get(&coord).map(Vec::as_slice)
    }

    /// The contents of the slot of `coord` at `level`.
    pub fn slot_pixels(&self, level: usize, coord: Coord) -> Vec<u8> {
        bordered(self.level(level), coord.0, coord.1)
    }

    fn release(&mut self, pool: &mut Pool) {
        for level in &mut self.slots {
            pool.free.extend(level.drain().map(|(_, slot)| Reverse(slot)));
        }
        *self = Layer::default();
    }

    /// Replaces the tiles in `changes` (`None` removes one) and brings the reduced levels, the
    /// drawn tiles and the slots up to date. Marks the slots to write: each tile that
    /// changed, or has a neighbour that did, at every level that follows from it and is in
    /// `resident`; the same slots of the other levels are remembered stale.
    fn apply(&mut self, pool: &mut Pool, resident: Levels, changes: Vec<(Coord, Option<Vec<u8>>)>) -> Result<(), Full> {
        if self.drawn.is_empty() {
            self.reduced = (0..MAX_LEVEL).map(|_| Level::default()).collect();
            self.drawn = (0..=MAX_LEVEL).map(|_| Vec::new()).collect();
            self.slots = (0..=MAX_LEVEL).map(|_| HashMap::default()).collect();
            self.stale = (0..=MAX_LEVEL).map(|_| HashSet::default()).collect();
        }
        // The tiles that changed at each level, with what each held before (`None`: nothing).
        let mut dirty: Vec<HashMap<Coord, Dirt>> = vec![HashMap::default()];
        let mut membership = false;
        for (coord, pixels) in changes {
            match pixels.filter(|pixels| pixels.len() == TILE_BYTES && visible(pixels)) {
                Some(pixels) => {
                    if self.level0.get(&coord) != Some(&pixels) {
                        let rect = changed_rect(self.level0.get(&coord).map(Vec::as_slice), Some(pixels.as_slice())).unwrap_or(WHOLE);
                        let before = self.level0.insert(coord, pixels);
                        membership |= before.is_none();
                        note(&mut dirty[0], coord, before, rect);
                    }
                }
                None => {
                    if let Some(before) = self.level0.remove(&coord) {
                        membership = true;
                        let rect = changed_rect(Some(before.as_slice()), None).unwrap_or(WHOLE);
                        note(&mut dirty[0], coord, Some(before), rect);
                    }
                }
            }
        }
        // Reduced tiles: only the parents of a tile that changed can change.
        for n in 1..=MAX_LEVEL as usize {
            // The part of each parent its changed children reach (in the parent's texels): the union of what may differ in them.
            let mut parents: HashMap<Coord, [usize; 4]> = HashMap::default();
            for (&(x, y), dirt) in &dirty[n - 1] {
                let [x0, y0, x1, y1] = dirt.rect;
                let (ox, oy) = ((x.rem_euclid(2) as usize) * (TILE as usize / 2), (y.rem_euclid(2) as usize) * (TILE as usize / 2));
                let rect = [ox + x0 / 2, oy + y0 / 2, ox + x1.div_ceil(2), oy + y1.div_ceil(2)];
                parents
                    .entry((x.div_euclid(2), y.div_euclid(2)))
                    .and_modify(|union| *union = [union[0].min(rect[0]), union[1].min(rect[1]), union[2].max(rect[2]), union[3].max(rect[3])])
                    .or_insert(rect);
            }
            // A parent made again only where its children changed may differ from what it held only there; one made whole, anywhere.
            let fresh: Vec<(Coord, Option<Vec<u8>>, [usize; 4])> = parents
                .into_iter()
                .map(|((x, y), rect)| {
                    let (reduced, may_differ) = match self.reduced[n - 1].get(&(x, y)) {
                        Some(previous) => (Some(down_tile_patch(self.level(n - 1), x, y, previous, rect)), rect),
                        None => (down_tile(self.level(n - 1), x, y), WHOLE),
                    };
                    ((x, y), reduced.filter(|tile| visible(tile)), may_differ)
                })
                .collect();
            let mut changed = HashMap::default();
            for (coord, tile, rect) in fresh {
                if self.reduced[n - 1].get(&coord) == tile.as_ref() {
                    continue;
                }
                let before = match tile {
                    Some(tile) => self.reduced[n - 1].insert(coord, tile),
                    None => self.reduced[n - 1].remove(&coord),
                };
                changed.insert(coord, Dirt { before, rect });
            }
            dirty.push(changed);
        }
        // Drawn tiles and their slots follow the tile set.
        let mut fresh: Vec<HashSet<Coord>> = (0..=MAX_LEVEL).map(|_| HashSet::default()).collect();
        if membership {
            let tiles: Vec<Coord> = self.level0.keys().copied().collect();
            for n in 0..=MAX_LEVEL as usize {
                let covered: HashSet<Coord> = tiles.iter().map(|&(x, y)| (x >> n, y >> n)).collect();
                let mut drawn: Vec<Coord> = covered.iter().flat_map(|&(x, y)| (-1..=1).flat_map(move |dy| (-1..=1).map(move |dx| (x + dx, y + dy)))).collect::<HashSet<_>>().into_iter().collect();
                drawn.sort_unstable_by_key(|&(x, y)| (y, x));
                let gone: Vec<Coord> = self.slots[n].keys().filter(|coord| drawn.binary_search_by_key(&(coord.1, coord.0), |&(x, y)| (y, x)).is_err()).copied().collect();
                for coord in gone {
                    self.stale[n].remove(&coord);
                    if let Some(slot) = self.slots[n].remove(&coord) {
                        pool.free.push(Reverse(slot));
                    }
                }
                for &coord in &drawn {
                    if !self.slots[n].contains_key(&coord) {
                        let slot = pool.take()?;
                        self.slots[n].insert(coord, slot);
                        fresh[n].insert(coord);
                    }
                }
                self.drawn[n] = drawn;
            }
        }
        for n in 0..=MAX_LEVEL as usize {
            let mut want = std::mem::take(&mut fresh[n]);
            for (&(x, y), dirt) in &dirty[n] {
                let before = &dirt.before;
                want.insert((x, y));
                // A neighbour's border holds this tile's facing edge: it is written again only when that edge changed.
                let after = self.level(n).get(&(x, y)).map(Vec::as_slice);
                for dy in -1..=1 {
                    for dx in -1..=1 {
                        if (dx, dy) != (0, 0) && facing_differs(before.as_deref(), after, dx, dy) {
                            want.insert((x + dx, y + dy));
                        }
                    }
                }
            }
            let want = want.into_iter().filter(|coord| self.slots[n].contains_key(coord));
            if resident >> n & 1 == 0 {
                self.stale[n].extend(want);
                continue;
            }
            for coord in want {
                self.pending.insert(self.slots[n][&coord], (n, coord));
            }
        }
        Ok(())
    }

    /// Marks the stale slots of the levels in `levels` to write: they are current once written.
    fn flush(&mut self, levels: Levels) {
        for n in 0..self.stale.len() {
            if levels >> n & 1 == 0 {
                continue;
            }
            for coord in self.stale[n].drain() {
                if let Some(&slot) = self.slots[n].get(&coord) {
                    self.pending.insert(slot, (n, coord));
                }
            }
        }
    }

    /// Marks up to `limit` of the stale slots of the level `n` to write; returns how many were marked.
    fn warm(&mut self, n: usize, limit: usize) -> usize {
        let coords: Vec<Coord> = self.stale[n].iter().take(limit).copied().collect();
        let mut marked = 0;
        for coord in coords {
            self.stale[n].remove(&coord);
            if let Some(&slot) = self.slots[n].get(&coord) {
                self.pending.insert(slot, (n, coord));
                marked += 1;
            }
        }
        marked
    }

    /// Stale slots at the levels in `levels`.
    fn stale_in(&self, levels: Levels) -> usize {
        self.stale.iter().enumerate().filter(|(n, _)| levels >> n & 1 == 1).map(|(_, set)| set.len()).sum()
    }

    /// Marks every slot of the levels in `resident` to write (the atlas was allocated again); every
    /// slot of the other levels is stale.
    fn all(&mut self, resident: Levels) {
        for n in 0..self.slots.len() {
            if resident >> n & 1 == 0 {
                self.stale[n] = self.slots[n].keys().copied().collect();
                continue;
            }
            self.stale[n].clear();
            for (&coord, &slot) in &self.slots[n] {
                self.pending.insert(slot, (n, coord));
            }
        }
    }
}

/// A drawing cel held live.
pub struct LiveCel {
    pub base: Layer,
    pub float: Layer,
    /// The floating selection's transform: cel pixel `(x, y)` goes to
    /// `(a x + c y + e, b x + d y + f)` for `[a, b, c, d, e, f]`.
    pub matrix: [f64; 6],
    /// The base replaces the published cel in the draw list.
    pub show_base: bool,
    /// The floating selection is drawn too.
    pub show_float: bool,
}

impl Default for LiveCel {
    fn default() -> Self {
        LiveCel { base: Layer::default(), float: Layer::default(), matrix: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0], show_base: false, show_float: false }
    }
}

/// The live cels of a stage, by cel id (`_styk.drawing.celId`), sharing a pool of atlas slots.
pub struct LiveCels {
    cels: StdMap<String, LiveCel>,
    pool: Pool,
    /// The levels written as tiles change; the others wait ([`LiveCels::set_resident`]).
    resident: Levels,
    /// When (the host's clock, milliseconds) a cel last changed.
    changed_at: Option<f64>,
}

impl Default for LiveCels {
    /// Every level resident: nothing waits.
    fn default() -> Self {
        LiveCels::new(ALL_LEVELS)
    }
}

impl std::fmt::Debug for LiveCels {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "LiveCels {{ {:?} }}", self.stats())
    }
}

/// What the stage holds, for reports.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Stats {
    pub cels: usize,
    pub tiles: usize,
    pub slots: usize,
    pub pages: u32,
}

impl LiveCels {
    /// Live cels that write the levels in `resident` as tiles change.
    pub fn new(resident: Levels) -> Self {
        LiveCels { cels: StdMap::new(), pool: Pool::default(), resident, changed_at: None }
    }

    /// Pages of the atlas the slots need after the document's own.
    pub fn pages(&self) -> u32 {
        self.pool.high.div_ceil(PAGE_SLOTS)
    }

    /// Makes the first page count, before any cel holds a slot: the host allocates the atlas texture when the drawing
    /// workspace opens, not at the first stroke.
    pub fn reserve(&mut self) {
        self.pool.reserve_page();
    }

    pub fn stats(&self) -> Stats {
        Stats {
            cels: self.cels.len(),
            tiles: self.cels.values().map(|cel| cel.base.len() + cel.float.len()).sum(),
            slots: self.cels.values().map(|cel| cel.base.slot_count() + cel.float.slot_count()).sum(),
            pages: self.pages(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.cels.is_empty()
    }

    pub fn get(&self, id: &str) -> Option<&LiveCel> {
        self.cels.get(id)
    }

    /// Replaces tiles of a cel's base (or its floating selection). The cel is created on its
    /// first update and stays hidden until [`LiveCels::show`]. The slots that change are marked for
    /// [`LiveCels::take_runs`]. On [`Full`] the cel is dropped whole, since a partial update would draw wrong.
    pub fn update(&mut self, id: &str, float: bool, changes: Vec<(Coord, Option<Vec<u8>>)>) -> Result<(), Full> {
        let cel = self.cels.entry(id.to_string()).or_default();
        let layer = if float { &mut cel.float } else { &mut cel.base };
        let result = layer.apply(&mut self.pool, self.resident, changes);
        if result.is_err() {
            self.drop_cel(id);
        }
        result
    }

    /// A cel's tiles changed at `now` (the host's clock, milliseconds).
    pub fn changed(&mut self, now: f64) {
        self.changed_at = Some(now);
    }

    /// The most decoded pictures of the document a frame at `now` uploads, at most `full`. The published
    /// copies of the pixels being drawn (the engine decodes every level of a cel again after each publication) are
    /// not what the frame shows, and a burst of them lands on the frame a stroke may begin on: while a cel changed
    /// a moment ago a frame takes a slice, and a smaller slice for a moment after. Time ends it, so a stage that
    /// draws nothing, or a document whose cel is held after Draw was left, loads at `full` again by itself.
    pub fn picture_budget(&self, now: f64, full: usize) -> usize {
        match self.changed_at {
            Some(at) if !self.cels.is_empty() && now - at < CHANGING_MS => CHANGING_PICTURE_BYTES.min(full),
            Some(at) if !self.cels.is_empty() && now - at < CHANGING_MS + SETTLING_MS => SETTLING_PICTURE_BYTES.min(full),
            _ => full,
        }
    }

    /// Whether a cel changed within the last [`CHANGING_MS`] (at `now`, the host's clock): a stroke, an undo or a move is
    /// being drawn, and nothing that can wait should take the frame's time.
    pub fn changing(&self, now: f64) -> bool {
        !self.cels.is_empty() && self.changed_at.is_some_and(|at| now - at < CHANGING_MS)
    }

    /// Writes up to `slots` of the stale slots of the levels beside the ones `shown`, nearest first, and returns how many
    /// stale slots are left at those levels. A level that is not drawn is not written as its tiles change; when the view
    /// zooms to it the slots changed since are written before the frame, all at once. Called in the quiet of an idle
    /// stage, a slice at a time, it leaves a zoom next to nothing to write: the writes change no pixel a frame shows.
    pub fn warm(&mut self, shown: Levels, slots: usize) -> usize {
        if shown == 0 {
            return 0;
        }
        let (low, high) = (shown.trailing_zeros() as usize, 15 - shown.leading_zeros() as usize);
        let mut order: Vec<usize> = (0..=MAX_LEVEL as usize).filter(|n| shown >> n & 1 == 0).collect();
        order.sort_by_key(|&n| if n < low { low - n } else { n - high });
        let mut budget = slots;
        for n in order {
            for cel in self.cels.values_mut() {
                for layer in [&mut cel.base, &mut cel.float] {
                    if budget > 0 && n < layer.stale.len() {
                        budget -= layer.warm(n, budget);
                    }
                }
            }
        }
        let beside = ALL_LEVELS & !shown;
        self.cels.values().map(|cel| cel.base.stale_in(beside) + cel.float.stale_in(beside)).sum()
    }

    /// Chooses the levels written as tiles change: those the next frame shows. Marks the slots
    /// of the levels that were not resident and changed meanwhile, to write before that frame is drawn.
    pub fn set_resident(&mut self, resident: Levels) {
        let newly = resident & !self.resident;
        self.resident = resident;
        if newly != 0 {
            for cel in self.cels.values_mut() {
                cel.base.flush(newly);
                cel.float.flush(newly);
            }
        }
    }

    /// The slots marked since the last call as the fewest rectangles to write, each slot built once from
    /// the pixels as they are now: a slot several calls changed (a tile's neighbourhood is rewritten by
    /// each call that changes a tile beside it) costs one build, and slots next to each other in a page row
    /// are one rectangle.
    pub fn take_runs(&mut self) -> Vec<Run> {
        let mut slots: Vec<((u32, u32, u32), &Level, Coord)> = Vec::new();
        for cel in self.cels.values() {
            for layer in [&cel.base, &cel.float] {
                for (&slot, &(n, coord)) in &layer.pending {
                    // A slot given back, or to another tile, since it was marked is not this tile's to write.
                    if layer.slots.get(n).and_then(|level| level.get(&coord)) == Some(&slot) {
                        let (page, x, y) = place(slot);
                        slots.push(((page, y, x), layer.level(n), coord));
                    }
                }
            }
        }
        slots.sort_unstable_by_key(|(key, _, _)| *key);
        let mut runs = Vec::new();
        let mut at = 0;
        while at < slots.len() {
            let (page, y, x) = slots[at].0;
            let mut end = at + 1;
            while end < slots.len() && slots[end].0 == (page, y, x + CELL * (end - at) as u32) {
                end += 1;
            }
            let (cells, width) = (end - at, (end - at) * CELL as usize);
            let mut rgba = vec![0u8; width * CELL as usize * 4];
            for (index, (_, level, coord)) in slots[at..end].iter().enumerate() {
                bordered_into(level, coord.0, coord.1, &mut rgba, width, index * CELL as usize);
            }
            runs.push(Run { page, x: x - BORDER, y: y - BORDER, cells: cells as u32, rgba });
            at = end;
        }
        drop(slots);
        for cel in self.cels.values_mut() {
            cel.base.pending.clear();
            cel.float.pending.clear();
        }
        runs
    }

    /// The levels written as tiles change.
    pub fn resident(&self) -> Levels {
        self.resident
    }

    /// Chooses what a cel shows: its base in place of the published cel, and its floating
    /// selection over it. A cel not held is ignored.
    pub fn show(&mut self, id: &str, base: bool, float: bool) {
        if let Some(cel) = self.cels.get_mut(id) {
            cel.show_base = base;
            cel.show_float = base && float;
        }
    }

    pub fn set_matrix(&mut self, id: &str, matrix: [f64; 6]) {
        if let Some(cel) = self.cels.get_mut(id) {
            cel.matrix = matrix;
        }
    }

    /// Empties a cel's floating selection.
    pub fn clear_float(&mut self, id: &str) {
        if let Some(cel) = self.cels.get_mut(id) {
            cel.float.release(&mut self.pool);
            cel.show_float = false;
        }
    }

    pub fn drop_cel(&mut self, id: &str) {
        if let Some(mut cel) = self.cels.remove(id) {
            cel.base.release(&mut self.pool);
            cel.float.release(&mut self.pool);
        }
        if self.cels.is_empty() {
            self.pool.reset();
        }
    }

    pub fn clear(&mut self) {
        self.cels.clear();
        self.pool.reset();
    }

    /// Marks the slots in use at the resident levels to write again after the atlas was allocated
    /// anew (those of the other levels are stale).
    pub fn rewrite_all(&mut self) {
        let resident = self.resident;
        for cel in self.cels.values_mut() {
            cel.base.all(resident);
            cel.float.all(resident);
        }
    }
}

/// The live cels as a draw list sees them: the atlas layer of the first live page.
#[derive(Clone, Copy)]
pub struct LiveView<'a> {
    pub cels: &'a LiveCels,
    pub base: u32,
}

impl std::fmt::Debug for LiveView<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "LiveView {{ cels: {}, base: {} }}", self.cels.cels.len(), self.base)
    }
}

impl<'a> LiveView<'a> {
    /// The cel `id` when it replaces the published one.
    pub fn cel(&self, id: &str) -> Option<&'a LiveCel> {
        self.cels.get(id).filter(|cel| cel.show_base)
    }

    /// The atlas rectangle of `slot`.
    pub fn entry(&self, slot: u32) -> AtlasEntry {
        let (page, x, y) = place(slot);
        AtlasEntry { layer: self.base + page, x, y, w: TILE, h: TILE, source_w: TILE, source_h: TILE, valid: true }
    }
}

/// The levels of live cels a view shows: those whose tiles the shader draws at `scale` (the
/// view's world-to-target scale), and the level above each, which a tile blends in
/// (`prim.wgsl`, `F_DRAWING`). `base` is the atlas layer of the first live page. A drawing tile
/// in an isolation group is drawn at a scale this does not know, so it asks for every level.
pub fn shown_levels(list: &DrawList, base: u32, scale: f64) -> Levels {
    // The shader's own test in single precision; the margin keeps a boundary on both sides.
    const MARGIN: f64 = 1.0 / 64.0;
    let mut shown: Levels = 0;
    for prim in &list.prims {
        if prim.kind & 255 != K_IMAGE || prim.kind & F_DRAWING == 0 || (prim.b[2] as u32) < base {
            continue;
        }
        if prim.group != 0 {
            return ALL_LEVELS;
        }
        let level = prim.b[3] as u32;
        let pixels = f64::from(prim.a[2]).hypot(f64::from(prim.a[3])) * scale / f64::from(TILE);
        if (level == 0 || pixels <= 1.0 + MARGIN) && (level == MAX_LEVEL || pixels > 0.5 - MARGIN) {
            shown |= 3 << level;
        }
    }
    shown & ALL_LEVELS
}

#[cfg(test)]
mod tests;
