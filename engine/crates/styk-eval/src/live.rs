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
//! The module is pure: the host writes the [`Upload`]s into its atlas.

use std::collections::{HashMap, HashSet};

use crate::assets::{AtlasEntry, PAGE};
pub use crate::drawing::TILE_BYTES;
use crate::drawing::{bordered, down_tile, BORDER, MAX_LEVEL, TILE};


/// Texels a slot covers: a tile and its border on every side.
pub const CELL: u32 = TILE + 2 * BORDER;
/// Slots across and down a page.
const COLUMNS: u32 = (PAGE - 2 * BORDER - TILE) / CELL + 1;
/// Slots a page holds.
pub const PAGE_SLOTS: u32 = COLUMNS * COLUMNS;
/// Pages live cels may use together (4,096² texels each, 64 MiB).
pub const MAX_PAGES: u32 = 4;

/// The slots are all in use: the interface drops cels it can do without and tries again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Full;

impl std::fmt::Display for Full {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the live drawing slots are full")
    }
}

/// One slot's contents to write: [`CELL`]² straight-alpha RGBA texels at `(x, y)` of live page
/// `page`, where `(x, y)` is the corner of the tile itself (the border starts [`BORDER`] texels
/// before it).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Upload {
    pub page: u32,
    pub x: u32,
    pub y: u32,
    pub rgba: Vec<u8>,
}

/// Where a slot sits in the live pages.
fn place(slot: u32) -> (u32, u32, u32) {
    let (page, cell) = (slot / PAGE_SLOTS, slot % PAGE_SLOTS);
    (page, BORDER + CELL * (cell % COLUMNS), BORDER + CELL * (cell / COLUMNS))
}

struct Pool {
    free: Vec<u32>,
    /// Slots handed out so far at most: the pages the atlas needs.
    high: u32,
    capacity: u32,
}

impl Default for Pool {
    fn default() -> Self {
        Pool { free: Vec::new(), high: 0, capacity: MAX_PAGES * PAGE_SLOTS }
    }
}

impl Pool {
    /// Forgets every slot (no cel holds one any more).
    fn reset(&mut self) {
        *self = Pool { capacity: self.capacity, ..Pool::default() };
    }

    fn take(&mut self) -> Result<u32, Full> {
        if let Some(slot) = self.free.pop() {
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
            pool.free.extend(level.drain().map(|(_, slot)| slot));
        }
        *self = Layer::default();
    }

    /// Replaces the tiles in `changes` (`None` removes one) and brings the reduced levels, the
    /// drawn tiles and the slots up to date. Returns the slots to write: each tile that
    /// changed, or has a neighbour that did, at every level that follows from it.
    fn apply(&mut self, pool: &mut Pool, changes: Vec<(Coord, Option<Vec<u8>>)>) -> Result<Vec<(u32, Vec<u8>)>, Full> {
        if self.drawn.is_empty() {
            self.reduced = (0..MAX_LEVEL).map(|_| Level::new()).collect();
            self.drawn = (0..=MAX_LEVEL).map(|_| Vec::new()).collect();
            self.slots = (0..=MAX_LEVEL).map(|_| HashMap::new()).collect();
        }
        let mut dirty: Vec<HashSet<Coord>> = vec![HashSet::new()];
        let mut membership = false;
        for (coord, pixels) in changes {
            match pixels.filter(|pixels| pixels.len() == TILE_BYTES && visible(pixels)) {
                Some(pixels) => {
                    if self.level0.get(&coord) != Some(&pixels) {
                        membership |= self.level0.insert(coord, pixels).is_none();
                        dirty[0].insert(coord);
                    }
                }
                None => {
                    if self.level0.remove(&coord).is_some() {
                        membership = true;
                        dirty[0].insert(coord);
                    }
                }
            }
        }
        // Reduced tiles: only the parents of a tile that changed can change.
        for n in 1..=MAX_LEVEL as usize {
            let parents: HashSet<Coord> = dirty[n - 1].iter().map(|&(x, y)| (x.div_euclid(2), y.div_euclid(2))).collect();
            let fresh: Vec<(Coord, Option<Vec<u8>>)> =
                parents.into_iter().map(|(x, y)| ((x, y), down_tile(self.level(n - 1), x, y).filter(|tile| visible(tile)))).collect();
            let mut changed = HashSet::new();
            for (coord, tile) in fresh {
                if self.reduced[n - 1].get(&coord) == tile.as_ref() {
                    continue;
                }
                match tile {
                    Some(tile) => {
                        self.reduced[n - 1].insert(coord, tile);
                    }
                    None => {
                        self.reduced[n - 1].remove(&coord);
                    }
                }
                changed.insert(coord);
            }
            dirty.push(changed);
        }
        // Drawn tiles and their slots follow the tile set.
        let mut fresh: Vec<HashSet<Coord>> = (0..=MAX_LEVEL).map(|_| HashSet::new()).collect();
        if membership {
            let tiles: Vec<Coord> = self.level0.keys().copied().collect();
            for n in 0..=MAX_LEVEL as usize {
                let covered: HashSet<Coord> = tiles.iter().map(|&(x, y)| (x >> n, y >> n)).collect();
                let mut drawn: Vec<Coord> = covered.iter().flat_map(|&(x, y)| (-1..=1).flat_map(move |dy| (-1..=1).map(move |dx| (x + dx, y + dy)))).collect::<HashSet<_>>().into_iter().collect();
                drawn.sort_unstable_by_key(|&(x, y)| (y, x));
                let gone: Vec<Coord> = self.slots[n].keys().filter(|coord| drawn.binary_search_by_key(&(coord.1, coord.0), |&(x, y)| (y, x)).is_err()).copied().collect();
                for coord in gone {
                    if let Some(slot) = self.slots[n].remove(&coord) {
                        pool.free.push(slot);
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
        let mut uploads = Vec::new();
        for n in 0..=MAX_LEVEL as usize {
            let mut want = std::mem::take(&mut fresh[n]);
            for &(x, y) in &dirty[n] {
                for dy in -1..=1 {
                    for dx in -1..=1 {
                        want.insert((x + dx, y + dy));
                    }
                }
            }
            let mut want: Vec<Coord> = want.into_iter().filter(|coord| self.slots[n].contains_key(coord)).collect();
            want.sort_unstable_by_key(|&(x, y)| (y, x));
            for coord in want {
                uploads.push((self.slots[n][&coord], bordered(self.level(n), coord.0, coord.1)));
            }
        }
        Ok(uploads)
    }

    /// Every slot's contents (the atlas was allocated again).
    fn all(&self) -> Vec<(u32, Vec<u8>)> {
        let mut out = Vec::new();
        for (n, slots) in self.slots.iter().enumerate() {
            for (&coord, &slot) in slots {
                out.push((slot, bordered(self.level(n), coord.0, coord.1)));
            }
        }
        out
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
#[derive(Default)]
pub struct LiveCels {
    cels: HashMap<String, LiveCel>,
    pool: Pool,
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
    /// Pages of the atlas the slots need after the document's own.
    pub fn pages(&self) -> u32 {
        self.pool.high.div_ceil(PAGE_SLOTS)
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
    /// first update and stays hidden until [`LiveCels::show`]. On [`Full`] the cel is
    /// dropped whole, since a partial update would draw wrong.
    pub fn update(&mut self, id: &str, float: bool, changes: Vec<(Coord, Option<Vec<u8>>)>) -> Result<Vec<Upload>, Full> {
        let cel = self.cels.entry(id.to_string()).or_default();
        let layer = if float { &mut cel.float } else { &mut cel.base };
        match layer.apply(&mut self.pool, changes) {
            Ok(slots) => Ok(slots
                .into_iter()
                .map(|(slot, rgba)| {
                    let (page, x, y) = place(slot);
                    Upload { page, x, y, rgba }
                })
                .collect()),
            Err(Full) => {
                self.drop_cel(id);
                Err(Full)
            }
        }
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

    /// Every slot in use, to write again after the atlas was allocated anew.
    pub fn uploads(&self) -> Vec<Upload> {
        self.cels
            .values()
            .flat_map(|cel| cel.base.all().into_iter().chain(cel.float.all()))
            .map(|(slot, rgba)| {
                let (page, x, y) = place(slot);
                Upload { page, x, y, rgba }
            })
            .collect()
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

impl Upload {
    /// The corner of the written rectangle in the page (the border included).
    pub fn origin(&self) -> (u32, u32) {
        (self.x - BORDER, self.y - BORDER)
    }
}

#[cfg(test)]
mod tests;
