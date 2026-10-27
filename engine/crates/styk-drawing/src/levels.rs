//! Reduced levels (`downTile`, `levelStore`, `invalidateLevels` in drawing-raster.mjs):
//! level `k` tiles are exact 2×2 box reductions of level `k − 1`, alpha-weighted and
//! rounded half up, built lazily from the tiles that cover them.

use std::collections::HashSet;
use std::sync::Arc;

use crate::js::round;
use crate::tiles::{Rect, Tile, TileStore, TILE, TILE_BYTES};

/// `downTile`: one level-(n+1) tile from the four below it, or `None` when none exists.
pub fn down_tile(subs: [Option<&[u8]>; 4]) -> Option<[u8; TILE_BYTES]> {
    if subs.iter().all(Option::is_none) {
        return None;
    }
    let mut out = [0u8; TILE_BYTES];
    let h = 32usize;
    let t = 64usize;
    for (q, sub) in subs.iter().enumerate() {
        let Some(sub) = sub else { continue };
        let (ox, oy) = ((q & 1) * h, (q >> 1) * h);
        for py in 0..h {
            let mut i = (2 * py * t) * 4;
            let mut o = ((oy + py) * t + ox) * 4;
            for _ in 0..h {
                let j = i + t * 4;
                let (a0, a1, a2, a3) = (sub[i + 3] as u32, sub[i + 7] as u32, sub[j + 3] as u32, sub[j + 7] as u32);
                let pa = a0 + a1 + a2 + a3;
                if pa != 0 {
                    for c in 0..3 {
                        let sum = sub[i + c] as u32 * a0 + sub[i + 4 + c] as u32 * a1 + sub[j + c] as u32 * a2 + sub[j + 4 + c] as u32 * a3;
                        out[o + c] = round(sum as f64 / pa as f64) as u8;
                    }
                    out[o + 3] = round(pa as f64 / 4.0) as u8;
                }
                i += 8;
                o += 4;
            }
        }
    }
    Some(out)
}

/// A cel's derived reduced levels (`entry.levels`, `levelKnown`, `mipCoverage`).
#[derive(Clone, Debug, Default)]
pub struct Levels {
    levels: Vec<Option<TileStore>>,
    known: Vec<HashSet<(i64, i64)>>,
    coverage: Option<(u64, Vec<HashSet<(i64, i64)>>)>,
}

impl Levels {
    pub fn new() -> Levels {
        Levels::default()
    }

    fn build(&mut self, store: &TileStore, n: usize, tx: i64, ty: i64) -> Option<Tile> {
        if n == 0 {
            return store.get(tx, ty).cloned();
        }
        while self.levels.len() < n {
            self.levels.push(None);
        }
        while self.known.len() < n {
            self.known.push(HashSet::new());
        }
        if self.levels[n - 1].is_none() {
            self.levels[n - 1] = Some(TileStore::new());
        }
        if !self.coverage.as_ref().unwrap().1[n - 1].contains(&(tx, ty)) {
            return None;
        }
        {
            let level = self.levels[n - 1].as_ref().unwrap();
            if level.has(tx, ty) || self.known[n - 1].contains(&(tx, ty)) {
                return level.get(tx, ty).cloned();
            }
        }
        let a = self.build(store, n - 1, 2 * tx, 2 * ty);
        let b = self.build(store, n - 1, 2 * tx + 1, 2 * ty);
        let c = self.build(store, n - 1, 2 * tx, 2 * ty + 1);
        let d = self.build(store, n - 1, 2 * tx + 1, 2 * ty + 1);
        let pixels = down_tile([a.as_ref().map(|t| &t.pixels[..]), b.as_ref().map(|t| &t.pixels[..]), c.as_ref().map(|t| &t.pixels[..]), d.as_ref().map(|t| &t.pixels[..])]);
        self.known[n - 1].insert((tx, ty));
        let pixels = pixels?;
        let tile = Tile::new(tx as i32, ty as i32, Arc::new(pixels));
        if tile.transparent() {
            return None;
        }
        let level = self.levels[n - 1].as_mut().unwrap();
        level.insert(tile.clone());
        level.revision += 1;
        Some(tile)
    }

    /// `levelStore(entry, k, rect)`: level `k` of `store` (built where `rect`, in source
    /// pixels, needs it; everywhere without one).
    pub fn level(&mut self, store: &TileStore, k: usize, rect: Option<Rect>) -> TileStore {
        if k == 0 {
            return store.clone();
        }
        let stale = match &self.coverage {
            None => true,
            Some((revision, levels)) => *revision != store.revision || levels.len() < k,
        };
        if stale {
            let mut levels = vec![HashSet::new(); k];
            for t in store.iter() {
                for (n, set) in levels.iter_mut().enumerate() {
                    let f = 1i64 << (n + 1);
                    set.insert(((t.tx as i64).div_euclid(f), (t.ty as i64).div_euclid(f)));
                }
            }
            self.coverage = Some((store.revision, levels));
        }
        let f = 1i64 << k;
        let mut keys = HashSet::new();
        let coords: Vec<(i64, i64)> = store
            .iter()
            .filter(|t| match rect {
                Some(r) => {
                    let (x, y) = (t.tx as i64 * TILE, t.ty as i64 * TILE);
                    !(x >= r.right() || x + TILE <= r.x || y >= r.bottom() || y + TILE <= r.y)
                }
                None => true,
            })
            .map(|t| ((t.tx as i64).div_euclid(f), (t.ty as i64).div_euclid(f)))
            .collect();
        for (tx, ty) in coords {
            if !keys.insert((tx, ty)) {
                continue;
            }
            self.build(store, k, tx, ty);
        }
        while self.levels.len() < k {
            self.levels.push(None);
        }
        self.levels[k - 1].get_or_insert_with(TileStore::new).clone()
    }

    /// `invalidateLevels(entry, dirty)`: drops the derived tiles covering `dirty` (source
    /// pixels) at every level; `None` clears the chain.
    pub fn invalidate(&mut self, dirty: Option<Rect>) {
        if self.levels.is_empty() {
            return;
        }
        let Some(dirty) = dirty else {
            self.levels.clear();
            self.known.clear();
            return;
        };
        for k in 1..=self.levels.len() {
            let Some(level) = self.levels[k - 1].as_mut() else { continue };
            let f = TILE << k;
            let (x0, y0) = (dirty.x.div_euclid(f), dirty.y.div_euclid(f));
            let (x1, y1) = ((dirty.x + dirty.width - 1).div_euclid(f), (dirty.y + dirty.height - 1).div_euclid(f));
            if (x1 - x0 + 1) * (y1 - y0 + 1) > 4096 {
                self.levels[k - 1] = None;
                if let Some(known) = self.known.get_mut(k - 1) {
                    known.clear();
                }
                continue;
            }
            for ty in y0..=y1 {
                for tx in x0..=x1 {
                    level.delete(tx, ty);
                    if let Some(known) = self.known.get_mut(k - 1) {
                        known.remove(&(tx, ty));
                    }
                }
            }
        }
    }
}

/// Level `k` of a store built from scratch (`levelStore({store}, k)`).
pub fn level_store(store: &TileStore, k: usize) -> TileStore {
    Levels::new().level(store, k, None)
}
