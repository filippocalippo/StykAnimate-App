//! The sparse, unbounded pixel surface (`drawing-tiles.mjs`): 64×64 straight-alpha RGBA
//! tiles keyed by signed 32-bit tile coordinates.
//!
//! Iteration follows insertion order, as a JavaScript `Map` does (re-setting a key keeps
//! its place, deleting and setting it again moves it to the end): the order of undo
//! records, of transform candidates and of everything returned to the editor depends on
//! it. Pixels are shared copy-on-write (`Arc`); `frozen` is kept because the transform's
//! memory plan reads it.

use std::cell::Cell;
use std::collections::HashMap;
use std::sync::Arc;

use crate::error::{fail, Result, COORDINATES};

pub const TILE: i64 = 64;
pub const TILE_USIZE: usize = 64;
pub const TILE_BYTES: usize = 64 * 64 * 4;
pub const MIN_TILE: i64 = -0x8000_0000;
pub const MAX_TILE: i64 = 0x7fff_ffff;

/// One tile's pixels, shared until written.
pub type Pixels = Arc<[u8; TILE_BYTES]>;

/// A zeroed tile.
pub fn zero_pixels() -> Pixels {
    Arc::new([0u8; TILE_BYTES])
}

/// Pixels copied from a full tile slice.
pub fn pixels_from(bytes: &[u8]) -> Pixels {
    let mut out = [0u8; TILE_BYTES];
    out.copy_from_slice(&bytes[..TILE_BYTES]);
    Arc::new(out)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
}

impl Rect {
    pub const fn new(x: i64, y: i64, width: i64, height: i64) -> Rect {
        Rect { x, y, width, height }
    }
    pub fn right(&self) -> i64 {
        self.x + self.width
    }
    pub fn bottom(&self) -> i64 {
        self.y + self.height
    }
}

/// `assertTileCoordinates`.
pub fn assert_tile(tx: i64, ty: i64) -> Result<()> {
    if !(MIN_TILE..=MAX_TILE).contains(&tx) || !(MIN_TILE..=MAX_TILE).contains(&ty) {
        return fail(COORDINATES);
    }
    Ok(())
}

/// `assertTileCoordinates` for JavaScript numbers.
pub fn assert_tile_f64(tx: f64, ty: f64) -> Result<()> {
    if !crate::js::is_integer(tx) || !crate::js::is_integer(ty) || tx < MIN_TILE as f64 || ty < MIN_TILE as f64 || tx > MAX_TILE as f64 || ty > MAX_TILE as f64 {
        return fail(COORDINATES);
    }
    Ok(())
}

/// The alpha bounds of one tile's pixels (tile-local), or `None` when it is transparent.
pub fn alpha_bounds(pixels: &[u8]) -> Option<Rect> {
    let t = TILE_USIZE;
    let mut y0 = t;
    let (mut x0, mut x1, mut y1) = (t, 0usize, 0usize);
    for y in 0..t {
        let row = &pixels[y * t * 4..(y + 1) * t * 4];
        let first = (0..t).find(|&x| row[x * 4 + 3] != 0);
        if let Some(first) = first {
            let last = (0..t).rev().find(|&x| row[x * 4 + 3] != 0).unwrap();
            if y0 == t {
                y0 = y;
            }
            y1 = y;
            x0 = x0.min(first);
            x1 = x1.max(last);
        }
    }
    if y0 == t {
        return None;
    }
    Some(Rect::new(x0 as i64, y0 as i64, (x1 - x0 + 1) as i64, (y1 - y0 + 1) as i64))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Alpha {
    Unknown,
    Empty,
    Bounds(Rect),
}

impl Alpha {
    pub fn from(bounds: Option<Rect>) -> Alpha {
        match bounds {
            Some(rect) => Alpha::Bounds(rect),
            None => Alpha::Empty,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Tile {
    pub tx: i32,
    pub ty: i32,
    pub pixels: Pixels,
    pub frozen: bool,
    alpha: Cell<Alpha>,
    /// The tile's published PNG, while its pixels are unchanged.
    pub png: Option<Arc<[u8]>>,
}

impl Tile {
    pub fn new(tx: i32, ty: i32, pixels: Pixels) -> Tile {
        Tile { tx, ty, pixels, frozen: false, alpha: Cell::new(Alpha::Unknown), png: None }
    }
    pub fn with_alpha(tx: i32, ty: i32, pixels: Pixels, alpha: Alpha) -> Tile {
        Tile { tx, ty, pixels, frozen: false, alpha: Cell::new(alpha), png: None }
    }
    /// The tile's alpha bounds, computed once (`tile.alphaBounds`).
    pub fn alpha_bounds(&self) -> Option<Rect> {
        match self.alpha.get() {
            Alpha::Unknown => {
                let bounds = alpha_bounds(&self.pixels[..]);
                self.alpha.set(Alpha::from(bounds));
                bounds
            }
            Alpha::Empty => None,
            Alpha::Bounds(rect) => Some(rect),
        }
    }
    /// The cached alpha state without computing it.
    pub fn alpha_state(&self) -> Alpha {
        self.alpha.get()
    }
    pub fn set_alpha(&self, alpha: Alpha) {
        self.alpha.set(alpha);
    }
    /// `tileTransparent(tile)`.
    pub fn transparent(&self) -> bool {
        self.alpha_bounds().is_none()
    }
    /// Writable pixels (copied first when shared).
    pub fn pixels_mut(&mut self) -> &mut [u8; TILE_BYTES] {
        Arc::make_mut(&mut self.pixels)
    }
}

/// A sparse tile store with JavaScript `Map` iteration order.
#[derive(Clone, Debug, Default)]
pub struct TileStore {
    entries: Vec<Option<Tile>>,
    index: HashMap<(i32, i32), usize>,
    live: usize,
    bounds: Cell<Option<Option<Rect>>>,
    tile_bounds: Cell<Option<Option<Rect>>>,
    pub revision: u64,
}

fn key(tx: i64, ty: i64) -> Option<(i32, i32)> {
    if (MIN_TILE..=MAX_TILE).contains(&tx) && (MIN_TILE..=MAX_TILE).contains(&ty) { Some((tx as i32, ty as i32)) } else { None }
}

impl TileStore {
    pub fn new() -> TileStore {
        TileStore::default()
    }

    /// The number of tiles.
    pub fn len(&self) -> usize {
        self.live
    }
    pub fn is_empty(&self) -> bool {
        self.live == 0
    }
    /// `store.bytes`.
    pub fn bytes(&self) -> f64 {
        (self.live * TILE_BYTES) as f64
    }
    pub fn get(&self, tx: i64, ty: i64) -> Option<&Tile> {
        let k = key(tx, ty)?;
        self.index.get(&k).and_then(|&i| self.entries[i].as_ref())
    }
    pub fn get_mut(&mut self, tx: i64, ty: i64) -> Option<&mut Tile> {
        let k = key(tx, ty)?;
        let i = *self.index.get(&k)?;
        self.entries[i].as_mut()
    }
    pub fn has(&self, tx: i64, ty: i64) -> bool {
        key(tx, ty).is_some_and(|k| self.index.contains_key(&k))
    }
    /// Tiles in `Map` order.
    pub fn iter(&self) -> impl Iterator<Item = &Tile> {
        self.entries.iter().filter_map(Option::as_ref)
    }
    /// Tile coordinates in `Map` order.
    pub fn keys(&self) -> Vec<(i32, i32)> {
        self.iter().map(|t| (t.tx, t.ty)).collect()
    }

    fn changed(&mut self) {
        self.bounds.set(None);
        self.tile_bounds.set(None);
        self.revision += 1;
    }

    /// `tiles.set(key, tile)`: inserts or replaces without other bookkeeping (decoders and
    /// selection assembly), keeping the key's place when it exists.
    pub fn insert(&mut self, tile: Tile) {
        let k = (tile.tx, tile.ty);
        self.bounds.set(None);
        self.tile_bounds.set(None);
        match self.index.get(&k) {
            Some(&i) => self.entries[i] = Some(tile),
            None => {
                self.index.insert(k, self.entries.len());
                self.entries.push(Some(tile));
                self.live += 1;
            }
        }
    }

    /// `tiles.delete(key)` without other bookkeeping.
    pub fn remove(&mut self, tx: i64, ty: i64) -> Option<Tile> {
        let k = key(tx, ty)?;
        let i = self.index.remove(&k)?;
        let tile = self.entries[i].take();
        self.live -= 1;
        self.bounds.set(None);
        self.tile_bounds.set(None);
        if self.entries.len() > 64 && self.live * 2 < self.entries.len() {
            self.compact();
        }
        tile
    }

    fn compact(&mut self) {
        let entries = std::mem::take(&mut self.entries);
        self.index.clear();
        for tile in entries.into_iter().flatten() {
            self.index.insert((tile.tx, tile.ty), self.entries.len());
            self.entries.push(Some(tile));
        }
    }

    /// `writable(tx, ty, {create})`: the tile, made private (a frozen tile is copied),
    /// its cached PNG and alpha bounds dropped. `None` when absent and `create` is false.
    pub fn writable(&mut self, tx: i64, ty: i64, create: bool) -> Result<Option<&mut Tile>> {
        assert_tile(tx, ty)?;
        let k = (tx as i32, ty as i32);
        self.changed();
        match self.index.get(&k) {
            None => {
                if !create {
                    self.revision -= 1;
                    return Ok(None);
                }
                self.index.insert(k, self.entries.len());
                self.entries.push(Some(Tile::new(k.0, k.1, zero_pixels())));
                self.live += 1;
                let i = self.entries.len() - 1;
                Ok(self.entries[i].as_mut())
            }
            Some(&i) => {
                let tile = self.entries[i].as_mut().unwrap();
                if tile.frozen {
                    tile.pixels = Arc::new(*tile.pixels);
                    tile.frozen = false;
                }
                tile.png = None;
                tile.alpha.set(Alpha::Unknown);
                Ok(Some(tile))
            }
        }
    }

    /// `writable(tx, ty)` with creation: the tile's writable pixels.
    pub fn writable_pixels(&mut self, tx: i64, ty: i64) -> Result<&mut [u8; TILE_BYTES]> {
        Ok(self.writable(tx, ty, true)?.unwrap().pixels_mut())
    }

    /// `set(tx, ty, pixels)`: four bytes fill the tile with one colour, a full tile is
    /// copied, `None` deletes.
    pub fn set(&mut self, tx: i64, ty: i64, pixels: Option<&[u8]>) -> Result<()> {
        assert_tile(tx, ty)?;
        let Some(pixels) = pixels else {
            self.delete(tx, ty);
            return Ok(());
        };
        let full = match pixels.len() {
            4 => uniform(pixels),
            TILE_BYTES => pixels_from(pixels),
            _ => return fail("errors.drawingTiles.tilePixelsMustBe4UniformBytesOr"),
        };
        self.adopt(tx, ty, full, Alpha::Unknown)
    }

    /// `adopt(tx, ty, pixels, alphaBounds)`: takes the pixels as they are.
    pub fn adopt(&mut self, tx: i64, ty: i64, pixels: Pixels, alpha: Alpha) -> Result<()> {
        assert_tile(tx, ty)?;
        self.insert(Tile::with_alpha(tx as i32, ty as i32, pixels, alpha));
        self.revision += 1;
        Ok(())
    }

    /// `delete(tx, ty)`.
    pub fn delete(&mut self, tx: i64, ty: i64) {
        if self.remove(tx, ty).is_some() {
            self.revision += 1;
        }
    }

    /// Marks every tile frozen (`freeze()`).
    pub fn freeze(&mut self) {
        for tile in self.entries.iter_mut().flatten() {
            tile.frozen = true;
        }
    }

    /// `bounds`: the union of every tile's alpha bounds, in pixels.
    pub fn bounds(&self) -> Option<Rect> {
        if let Some(bounds) = self.bounds.get() {
            return bounds;
        }
        let (mut x0, mut y0, mut x1, mut y1) = (i64::MAX, i64::MAX, i64::MIN, i64::MIN);
        for tile in self.iter() {
            let Some(a) = tile.alpha_bounds() else { continue };
            let x = tile.tx as i64 * TILE + a.x;
            let y = tile.ty as i64 * TILE + a.y;
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x + a.width);
            y1 = y1.max(y + a.height);
        }
        let bounds = (x0 != i64::MAX).then(|| Rect::new(x0, y0, x1 - x0, y1 - y0));
        self.bounds.set(Some(bounds));
        bounds
    }

    /// `tileBounds`: the tile-aligned rectangle containing every tile.
    pub fn tile_bounds(&self) -> Option<Rect> {
        if let Some(bounds) = self.tile_bounds.get() {
            return bounds;
        }
        let (mut x0, mut y0, mut x1, mut y1) = (i64::MAX, i64::MAX, i64::MIN, i64::MIN);
        for tile in self.iter() {
            x0 = x0.min(tile.tx as i64);
            y0 = y0.min(tile.ty as i64);
            x1 = x1.max(tile.tx as i64);
            y1 = y1.max(tile.ty as i64);
        }
        let bounds = (x0 != i64::MAX).then(|| Rect::new(x0 * TILE, y0 * TILE, (x1 - x0 + 1) * TILE, (y1 - y0 + 1) * TILE));
        self.tile_bounds.set(Some(bounds));
        bounds
    }

    /// `readRect(x, y, width, height)`.
    pub fn read_rect(&self, x: i64, y: i64, width: i64, height: i64) -> Vec<u8> {
        let mut out = vec![0u8; (width.max(0) * height.max(0) * 4) as usize];
        for (tx, ty) in tiles_in_rect(x, y, width, height) {
            let Some(tile) = self.get(tx, ty) else { continue };
            let (ox, oy) = (tx * TILE, ty * TILE);
            let sx = (x - ox).max(0);
            let ex = (x + width - ox).min(TILE);
            if sx >= ex {
                continue;
            }
            for py in (y - oy).max(0)..(y + height - oy).min(TILE) {
                let src = &tile.pixels[((py * TILE + sx) * 4) as usize..((py * TILE + ex) * 4) as usize];
                let at = (((py + oy - y) * width + sx + ox - x) * 4) as usize;
                out[at..at + src.len()].copy_from_slice(src);
            }
        }
        out
    }

    /// `writeRect(x, y, width, height, pixels)`.
    pub fn write_rect(&mut self, x: i64, y: i64, width: i64, height: i64, pixels: &[u8]) -> Result<()> {
        for (tx, ty) in tiles_in_rect(x, y, width, height) {
            let tile = self.writable_pixels(tx, ty)?;
            let (ox, oy) = (tx * TILE, ty * TILE);
            let sx = (x - ox).max(0);
            let ex = (x + width - ox).min(TILE);
            if sx >= ex {
                continue;
            }
            for py in (y - oy).max(0)..(y + height - oy).min(TILE) {
                let from = (((py + oy - y) * width + sx + ox - x) * 4) as usize;
                let to = (((py + oy - y) * width + ex + ox - x) * 4) as usize;
                let at = ((py * TILE + sx) * 4) as usize;
                tile[at..at + (to - from)].copy_from_slice(&pixels[from..to]);
            }
        }
        Ok(())
    }

    /// `pixel(x, y)`.
    pub fn pixel(&self, x: i64, y: i64) -> [u8; 4] {
        let (tx, ty) = (x.div_euclid(TILE), y.div_euclid(TILE));
        let Some(tile) = self.get(tx, ty) else { return [0; 4] };
        let i = (((y - ty * TILE) * TILE + (x - tx * TILE)) * 4) as usize;
        [tile.pixels[i], tile.pixels[i + 1], tile.pixels[i + 2], tile.pixels[i + 3]]
    }

    /// `prune()`: drops transparent tiles, returning their coordinates.
    pub fn prune(&mut self) -> Vec<(i32, i32)> {
        let transparent: Vec<(i32, i32)> = self.iter().filter(|t| t.transparent()).map(|t| (t.tx, t.ty)).collect();
        for &(tx, ty) in &transparent {
            self.remove(tx as i64, ty as i64);
        }
        if !transparent.is_empty() {
            self.changed();
        }
        transparent
    }
}

/// A tile of one colour from four bytes.
pub fn uniform(color: &[u8]) -> Pixels {
    let mut out = [0u8; TILE_BYTES];
    for px in out.chunks_exact_mut(4) {
        px.copy_from_slice(&color[..4]);
    }
    Arc::new(out)
}

/// `TileStore.tilesInRect(x, y, width, height)`: tile coordinates row by row.
pub fn tiles_in_rect(x: i64, y: i64, width: i64, height: i64) -> Vec<(i64, i64)> {
    if width <= 0 || height <= 0 {
        return Vec::new();
    }
    let x1 = (x + width - 1).div_euclid(TILE);
    let y1 = (y + height - 1).div_euclid(TILE);
    let mut out = Vec::new();
    for ty in y.div_euclid(TILE)..=y1 {
        for tx in x.div_euclid(TILE)..=x1 {
            out.push((tx, ty));
        }
    }
    out
}

/// `tileAlignedRect(x, y, width, height)`.
pub fn tile_aligned_rect(x: i64, y: i64, width: i64, height: i64) -> Rect {
    let x0 = x.div_euclid(TILE) * TILE;
    let y0 = y.div_euclid(TILE) * TILE;
    let x1 = (x + width + TILE - 1).div_euclid(TILE) * TILE;
    let y1 = (y + height + TILE - 1).div_euclid(TILE) * TILE;
    Rect::new(x0, y0, x1 - x0, y1 - y0)
}

/// One side of an undo record: absent, a uniform colour (four bytes) or a full tile.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Side {
    Absent,
    Uniform([u8; 4]),
    Full(Pixels),
}

impl Side {
    pub fn bytes(&self) -> usize {
        match self {
            Side::Absent => 0,
            Side::Uniform(_) => 4,
            Side::Full(_) => TILE_BYTES,
        }
    }
    pub fn as_slice(&self) -> Option<&[u8]> {
        match self {
            Side::Absent => None,
            Side::Uniform(c) => Some(&c[..]),
            Side::Full(p) => Some(&p[..]),
        }
    }
    pub fn from_slice(bytes: Option<&[u8]>) -> Side {
        match bytes {
            None => Side::Absent,
            Some(b) if b.len() == 4 => Side::Uniform([b[0], b[1], b[2], b[3]]),
            Some(b) => Side::Full(pixels_from(b)),
        }
    }
}

/// One tile's undo record (`{tx, ty, before, after}`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TileChange {
    pub tx: i32,
    pub ty: i32,
    pub before: Side,
    pub after: Side,
}

/// `compactTile(bytes)`: a tile of one colour becomes its four bytes.
pub fn compact(pixels: Option<&Pixels>) -> Side {
    let Some(pixels) = pixels else { return Side::Absent };
    let first = [pixels[0], pixels[1], pixels[2], pixels[3]];
    if pixels.chunks_exact(4).all(|px| px == first) { Side::Uniform(first) } else { Side::Full(pixels.clone()) }
}

/// A uniform transparent side equals an absent tile (`normSide`).
pub fn norm_side(side: Side) -> Side {
    match side {
        Side::Uniform(c) if c[3] == 0 => Side::Absent,
        other => other,
    }
}

/// The undo record of one tile, or `None` when nothing changed.
pub fn change_of(tx: i32, ty: i32, before: Option<&Pixels>, after: Option<&Pixels>) -> Option<TileChange> {
    match (before, after) {
        (None, None) => return None,
        (Some(b), Some(a)) if Arc::ptr_eq(b, a) || b[..] == a[..] => return None,
        _ => {}
    }
    let before = norm_side(compact(before));
    let after = norm_side(compact(after));
    if before == Side::Absent && after == Side::Absent {
        return None;
    }
    Some(TileChange { tx, ty, before, after })
}

/// `tileChanges(store, beforeTiles)`: the exact undo records of every tile in `before`
/// (in its order), against the store's current pixels.
pub fn tile_changes(store: &TileStore, before: &[((i32, i32), Option<Pixels>)]) -> Vec<TileChange> {
    before
        .iter()
        .filter_map(|(k, b)| change_of(k.0, k.1, b.as_ref(), store.get(k.0 as i64, k.1 as i64).map(|t| &t.pixels)))
        .collect()
}

/// `applyTileChanges(store, changes, direction)`.
pub fn apply_tile_changes(store: &mut TileStore, changes: &[TileChange], after: bool) -> Result<()> {
    for change in changes {
        let side = if after { &change.after } else { &change.before };
        store.set(change.tx as i64, change.ty as i64, side.as_slice())?;
    }
    Ok(())
}

/// An insertion-ordered record of the pixels tiles had before an edit (`before` maps).
#[derive(Clone, Debug, Default)]
pub struct Before {
    order: Vec<((i32, i32), Option<Pixels>)>,
    index: HashMap<(i32, i32), usize>,
}

impl Before {
    pub fn new() -> Before {
        Before::default()
    }
    pub fn has(&self, tx: i32, ty: i32) -> bool {
        self.index.contains_key(&(tx, ty))
    }
    /// `before.set(key, pixels)` (replacing keeps the place).
    pub fn set(&mut self, tx: i32, ty: i32, pixels: Option<Pixels>) {
        match self.index.get(&(tx, ty)) {
            Some(&i) => self.order[i].1 = pixels,
            None => {
                self.index.insert((tx, ty), self.order.len());
                self.order.push(((tx, ty), pixels));
            }
        }
    }
    pub fn entries(&self) -> &[((i32, i32), Option<Pixels>)] {
        &self.order
    }
    pub fn bytes(&self) -> f64 {
        self.order.iter().map(|(_, p)| if p.is_some() { TILE_BYTES as f64 } else { 0.0 }).sum()
    }
    pub fn len(&self) -> usize {
        self.order.len()
    }
    pub fn is_empty(&self) -> bool {
        self.order.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn map_order_follows_javascript() {
        let mut store = TileStore::new();
        for (tx, ty) in [(0, 0), (1, 0), (2, 0)] {
            store.writable(tx, ty, true).unwrap();
        }
        store.writable(0, 0, true).unwrap();
        assert_eq!(store.keys(), vec![(0, 0), (1, 0), (2, 0)]);
        store.delete(1, 0);
        store.set(1, 0, Some(&[1, 2, 3, 4])).unwrap();
        assert_eq!(store.keys(), vec![(0, 0), (2, 0), (1, 0)]);
    }

    #[test]
    fn bounds_cover_alpha_only() {
        let mut store = TileStore::new();
        let px = store.writable_pixels(-1, 2).unwrap();
        px[(5 * 64 + 7) * 4 + 3] = 9;
        assert_eq!(store.bounds(), Some(Rect::new(-64 + 7, 128 + 5, 1, 1)));
        assert_eq!(store.tile_bounds(), Some(Rect::new(-64, 128, 64, 64)));
    }
}
