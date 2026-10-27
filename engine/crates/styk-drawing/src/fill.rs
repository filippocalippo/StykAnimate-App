//! The fill (`drawing-fill.mjs`): a four-connected flood prepared tile by tile, masks
//! allocated only for tiles the flood and its gap/expansion halo reach, every allocation
//! reserved against a working-memory budget before it happens. The output and its undo
//! records are complete before anything is adopted, so a refused fill changes nothing.

use std::collections::HashMap;
use std::rc::Rc;

use crate::error::{fail, Result, FILL_MEMORY};
use crate::js::{clamp, is_safe_integer, round, u8c};
use crate::mask::{mask_value, Mask};
use crate::tiles::{assert_tile, tile_changes, Alpha, Before, Pixels, Rect, TileChange, TileStore, TILE, TILE_BYTES};

const AREA: usize = 64 * 64;
/// The limit of the optional dense composited source ("sample all layers").
pub const FILL_SOURCE_MAX_PIXELS: i64 = 64 * 1024 * 1024;

/// Fill options (`floodTiles(store, options)`).
#[derive(Clone, Debug)]
pub struct FillOptions<'a> {
    pub x: f64,
    pub y: f64,
    pub color: [f64; 4],
    pub tolerance: f64,
    pub expansion: f64,
    pub gap: f64,
    pub bounds: Rect,
    pub source: Option<&'a [u8]>,
    pub clip: Option<&'a Mask>,
    pub max_bytes: f64,
}

impl Default for FillOptions<'_> {
    fn default() -> Self {
        FillOptions { x: 0.0, y: 0.0, color: [0.0, 0.0, 0.0, 255.0], tolerance: 16.0, expansion: 0.0, gap: 0.0, bounds: Rect::new(0, 0, 0, 0), source: None, clip: None, max_bytes: 768.0 * 1024.0 * 1024.0 }
    }
}

#[derive(Clone)]
enum Open {
    No,
    All,
    Mask(Rc<[u8; AREA]>),
}

impl Open {
    fn at(&self, p: usize) -> bool {
        match self {
            Open::No => false,
            Open::All => true,
            Open::Mask(m) => m[p] != 0,
        }
    }
}

struct FillTile {
    tx: i64,
    ty: i64,
    x0: i64,
    y0: i64,
    x1: i64,
    y1: i64,
    filled: i64,
    matching: Option<Open>,
    open: Option<Open>,
    visited: Option<Box<[u8; AREA]>>,
    full: bool,
    pending: bool,
    output_reserved: bool,
}

struct Flood<'a> {
    store: &'a TileStore,
    source: Option<&'a [u8]>,
    left: i64,
    top: i64,
    right: i64,
    bottom: i64,
    width: i64,
    t0: (i64, i64),
    t1: (i64, i64),
    rgba: [u8; 4],
    r: f64,
    g: f64,
    b: f64,
    tolerance: f64,
    bytes: f64,
    max_bytes: f64,
    tiles: Vec<FillTile>,
    index: HashMap<(i64, i64), usize>,
    scratch: Vec<u8>,
}

impl Flood<'_> {
    fn reserve(&mut self, n: f64) -> Result<()> {
        if self.bytes + n > self.max_bytes {
            return fail(FILL_MEMORY);
        }
        self.bytes += n;
        Ok(())
    }

    fn matches(&self, red: u8, green: u8, blue: u8, a: u8) -> bool {
        let a = a as f64;
        let tol = self.tolerance;
        (red as f64 * a / 255.0 - self.r).abs() <= tol && (green as f64 * a / 255.0 - self.g).abs() <= tol && (blue as f64 * a / 255.0 - self.b).abs() <= tol && (a - self.rgba[3] as f64).abs() <= tol
    }

    /// The tile record at (tx, ty), created (and reserved) on first use; `None` outside the bounds.
    fn tile(&mut self, tx: i64, ty: i64) -> Result<Option<usize>> {
        if tx < self.t0.0 || tx > self.t1.0 || ty < self.t0.1 || ty > self.t1.1 {
            return Ok(None);
        }
        if let Some(&i) = self.index.get(&(tx, ty)) {
            return Ok(Some(i));
        }
        self.reserve(512.0)?;
        if self.tiles.len() >= 0x100000 {
            return fail(FILL_MEMORY);
        }
        let t = FillTile {
            tx,
            ty,
            x0: (self.left - tx * TILE).max(0),
            y0: (self.top - ty * TILE).max(0),
            x1: (self.right - tx * TILE).min(TILE),
            y1: (self.bottom - ty * TILE).min(TILE),
            filled: 0,
            matching: None,
            open: None,
            visited: None,
            full: false,
            pending: false,
            output_reserved: false,
        };
        self.tiles.push(t);
        let i = self.tiles.len() - 1;
        self.index.insert((tx, ty), i);
        Ok(Some(i))
    }

    fn matching(&mut self, i: usize) -> Result<Open> {
        if let Some(m) = &self.tiles[i].matching {
            return Ok(m.clone());
        }
        let (tx, ty, x0, y0, x1, y1) = {
            let t = &self.tiles[i];
            (t.tx, t.ty, t.x0, t.y0, t.x1, t.y1)
        };
        let store = self.store;
        let tile_pixels = if self.source.is_none() { store.get(tx, ty).map(|t| t.pixels.clone()) } else { None };
        if self.source.is_none() && tile_pixels.is_none() {
            let m = if self.matches(0, 0, 0, 0) { Open::All } else { Open::No };
            self.tiles[i].matching = Some(m.clone());
            return Ok(m);
        }
        self.reserve(AREA as f64)?;
        let mut mask = [0u8; AREA];
        let (mut any, mut all) = (false, true);
        for py in y0..y1 {
            for px in x0..x1 {
                let (pixels, at): (&[u8], usize) = match self.source {
                    Some(src) => (src, (((ty * TILE + py - self.top) * self.width + tx * TILE + px - self.left) * 4) as usize),
                    None => (&tile_pixels.as_ref().unwrap()[..], ((py * TILE + px) * 4) as usize),
                };
                let value = self.matches(pixels[at], pixels[at + 1], pixels[at + 2], pixels[at + 3]);
                mask[(py * TILE + px) as usize] = value as u8;
                any |= value;
                all &= value;
            }
        }
        let m = if all || !any {
            self.bytes -= AREA as f64;
            if all { Open::All } else { Open::No }
        } else {
            Open::Mask(Rc::new(mask))
        };
        self.tiles[i].matching = Some(m.clone());
        Ok(m)
    }

    /// Manhattan distances to the nearest seed pixel over the tile and its halo of
    /// `radius` (the one shared scratch buffer), or `None` when there is no seed:
    /// non-matching pixels (gap closing), or filled pixels (`selected`, the growth).
    fn distances(&mut self, i: usize, radius: i64, selected: bool) -> Result<bool> {
        let width = TILE + 2 * radius;
        let (x, y) = (self.tiles[i].tx * TILE - radius, self.tiles[i].ty * TILE - radius);
        let n = (width * width) as usize;
        self.scratch[..n].fill((radius + 1) as u8);
        let mut any = false;
        for ty in y.div_euclid(TILE)..=(y + width - 1).div_euclid(TILE) {
            for tx in x.div_euclid(TILE)..=(x + width - 1).div_euclid(TILE) {
                let other = if selected { self.index.get(&(tx, ty)).copied() } else { self.tile(tx, ty)? };
                let Some(o) = other else { continue };
                if selected && self.tiles[o].filled == 0 {
                    continue;
                }
                let value: Option<Open> = if selected {
                    if self.tiles[o].full { Some(Open::All) } else { None }
                } else {
                    Some(self.matching(o)?)
                };
                if !selected && matches!(value, Some(Open::All)) {
                    continue;
                }
                let t = &self.tiles[o];
                let px0 = t.x0.max(x - tx * TILE);
                let py0 = t.y0.max(y - ty * TILE);
                let px1 = t.x1.min(x + width - tx * TILE);
                let py1 = t.y1.min(y + width - ty * TILE);
                for py in py0..py1 {
                    for px in px0..px1 {
                        let p = (py * TILE + px) as usize;
                        let seed = if selected {
                            match &value {
                                Some(Open::All) => true,
                                _ => t.visited.as_ref().is_some_and(|v| v[p] == 2),
                            }
                        } else {
                            match &value {
                                Some(Open::No) => true,
                                Some(Open::Mask(m)) => m[p] == 0,
                                _ => false,
                            }
                        };
                        if seed {
                            self.scratch[((ty * TILE + py - y) * width + tx * TILE + px - x) as usize] = 0;
                            any = true;
                        }
                    }
                }
            }
        }
        if !any {
            return Ok(false);
        }
        let w = width as usize;
        let s = &mut self.scratch;
        for py in 0..w {
            for px in 0..w {
                let p = py * w + px;
                let left = if px > 0 { s[p - 1] as u16 + 1 } else { 255 };
                let up = if py > 0 { s[p - w] as u16 + 1 } else { 255 };
                s[p] = (s[p] as u16).min(left).min(up) as u8;
            }
        }
        for py in (0..w).rev() {
            for px in (0..w).rev() {
                let p = py * w + px;
                let right = if px + 1 < w { s[p + 1] as u16 + 1 } else { 255 };
                let down = if py + 1 < w { s[p + w] as u16 + 1 } else { 255 };
                s[p] = (s[p] as u16).min(right).min(down) as u8;
            }
        }
        Ok(true)
    }

    fn eligible(&mut self, i: usize, gap: i64) -> Result<Open> {
        if let Some(o) = &self.tiles[i].open {
            return Ok(o.clone());
        }
        if gap == 0 {
            let m = self.matching(i)?;
            self.tiles[i].open = Some(m.clone());
            return Ok(m);
        }
        if !self.distances(i, gap, false)? {
            self.tiles[i].open = Some(Open::All);
            return Ok(Open::All);
        }
        let width = TILE + 2 * gap;
        let (x0, y0, x1, y1) = (self.tiles[i].x0, self.tiles[i].y0, self.tiles[i].x1, self.tiles[i].y1);
        let at = |s: &[u8], px: i64, py: i64| s[((py + gap) * width + px + gap) as usize] as i64 > gap;
        let (mut any, mut all) = (false, true);
        for py in y0..y1 {
            for px in x0..x1 {
                let value = at(&self.scratch, px, py);
                any |= value;
                all &= value;
            }
        }
        if all || !any {
            let o = if all { Open::All } else { Open::No };
            self.tiles[i].open = Some(o.clone());
            return Ok(o);
        }
        self.reserve(AREA as f64)?;
        let mut mask = [0u8; AREA];
        for py in y0..y1 {
            for px in x0..x1 {
                mask[(py * TILE + px) as usize] = at(&self.scratch, px, py) as u8;
            }
        }
        let o = Open::Mask(Rc::new(mask));
        self.tiles[i].open = Some(o.clone());
        Ok(o)
    }
}

/// `prepareFloodTiles`: the output tiles and the undo `before` side, without changing
/// the store.
pub fn prepare_flood(store: &TileStore, o: &FillOptions) -> Result<(TileStore, Before)> {
    let b = o.bounds;
    let invalid_bounds = || fail("errors.drawingFill.invalidFillBounds");
    if b.width < 1 || b.height < 1 || ![b.x, b.y, b.width, b.height, b.x + b.width - 1, b.y + b.height - 1].iter().all(|&v| is_safe_integer(v as f64)) {
        return invalid_bounds();
    }
    let (left, top, right, bottom) = (b.x, b.y, b.x + b.width, b.y + b.height);
    let (tx0, ty0, tx1, ty1) = (left.div_euclid(TILE), top.div_euclid(TILE), (right - 1).div_euclid(TILE), (bottom - 1).div_euclid(TILE));
    assert_tile(tx0, ty0)?;
    assert_tile(tx1, ty1)?;
    if ![o.x, o.y, o.tolerance, o.expansion, o.gap, o.max_bytes].iter().all(|v| v.is_finite())
        || o.max_bytes < 0.0
        || !o.color.iter().all(|v| v.is_finite())
        || o.source.is_some_and(|s| b.width * b.height > FILL_SOURCE_MAX_PIXELS || s.len() as i64 != b.width * b.height * 4)
    {
        return fail("errors.drawingFill.invalidFillOptions");
    }
    let mut output = TileStore::new();
    let mut before = Before::new();
    let (x, y) = (o.x.floor() as i64, o.y.floor() as i64);
    if x < left || y < top || x >= right || y >= bottom {
        return Ok((output, before));
    }
    let tolerance = clamp(o.tolerance, 0.0, 255.0);
    let expansion = round(clamp(o.expansion, 0.0, 16.0)) as i64;
    let gap = round(clamp(o.gap, 0.0, 8.0)) as i64;
    let color = o.color.map(u8c);
    let word = u32::from_le_bytes(color);
    let rgba = match o.source {
        Some(src) => {
            let at = (((y - top) * b.width + x - left) * 4) as usize;
            [src[at], src[at + 1], src[at + 2], src[at + 3]]
        }
        None => store.pixel(x, y),
    };
    let alpha = rgba[3] as f64 / 255.0;
    let mut f = Flood {
        store,
        source: o.source,
        left,
        top,
        right,
        bottom,
        width: b.width,
        t0: (tx0, ty0),
        t1: (tx1, ty1),
        rgba,
        r: rgba[0] as f64 * alpha,
        g: rgba[1] as f64 * alpha,
        b: rgba[2] as f64 * alpha,
        tolerance,
        bytes: store.bytes() + o.source.map_or(0.0, |s| s.len() as f64),
        max_bytes: o.max_bytes,
        tiles: Vec::new(),
        index: HashMap::new(),
        scratch: Vec::new(),
    };
    f.reserve(0.0)?;
    let radius = gap + expansion;
    let side = TILE + 2 * radius;
    f.reserve(if radius != 0 { (side * side) as f64 } else { 0.0 })?;
    if radius != 0 {
        f.scratch = vec![0u8; (side * side) as usize];
    }
    f.reserve(4096.0)?;
    let mut stack: Vec<u32> = Vec::with_capacity(1024);
    let mut capacity = 1024usize;
    let mut filled: Vec<usize> = Vec::new();
    let blank = o.source.is_none() && store.is_empty();

    // `push(t, p)`.
    fn push(f: &mut Flood, stack: &mut Vec<u32>, capacity: &mut usize, t: Option<usize>, p: usize, gap: i64) -> Result<()> {
        let Some(i) = t else { return Ok(()) };
        {
            let t = &f.tiles[i];
            if t.full || t.pending || t.visited.as_ref().is_some_and(|v| v[p] != 0) {
                return Ok(());
            }
        }
        let open = f.eligible(i, gap)?;
        if !open.at(p) {
            return Ok(());
        }
        if matches!(open, Open::All) {
            f.tiles[i].pending = true;
        } else {
            if f.tiles[i].visited.is_none() {
                f.reserve(AREA as f64)?;
                f.tiles[i].visited = Some(Box::new([0u8; AREA]));
            }
            f.tiles[i].visited.as_mut().unwrap()[p] = 1;
        }
        if stack.len() == *capacity {
            // Uint32Array growth: reserve the doubled buffer, then release the old one.
            f.reserve((*capacity * 4 * 2) as f64)?;
            f.bytes -= (*capacity * 4) as f64;
            *capacity *= 2;
        }
        stack.push((i as u32).wrapping_mul(AREA as u32).wrapping_add(p as u32));
        Ok(())
    }

    if blank {
        if color.iter().all(|&c| c == 0) {
            return Ok((output, before));
        }
        let count = ((tx1 - tx0 + 1) * (ty1 - ty0 + 1)) as f64;
        if count > ((o.max_bytes - f.bytes) / (TILE_BYTES + 832) as f64).floor() {
            return fail(FILL_MEMORY);
        }
        for ty in ty0..=ty1 {
            for tx in tx0..=tx1 {
                let i = f.tile(tx, ty)?.unwrap();
                let t = &mut f.tiles[i];
                t.full = true;
                t.filled = (t.x1 - t.x0) * (t.y1 - t.y0);
                filled.push(i);
            }
        }
    } else {
        let start = f.tile(x.div_euclid(TILE), y.div_euclid(TILE))?.unwrap();
        let (stx, sty) = (f.tiles[start].tx, f.tiles[start].ty);
        push(&mut f, &mut stack, &mut capacity, Some(start), ((y - sty * TILE) * TILE + x - stx * TILE) as usize, gap)?;
    }
    while let Some(seed) = stack.pop() {
        let i = (seed / AREA as u32) as usize;
        let p = (seed % AREA as u32) as usize;
        if f.tiles[i].full || f.tiles[i].visited.as_ref().is_some_and(|v| v[p] == 2) {
            continue;
        }
        if f.tiles[i].filled == 0 {
            let (tx, ty) = (f.tiles[i].tx, f.tiles[i].ty);
            if word != 0 && !store.has(tx, ty) {
                f.reserve((TILE_BYTES + 256) as f64)?;
                f.tiles[i].output_reserved = true;
            }
            filled.push(i);
        }
        let open = f.eligible(i, gap)?;
        let (tx, ty, x0, y0, x1, y1) = {
            let t = &f.tiles[i];
            (t.tx, t.ty, t.x0, t.y0, t.x1, t.y1)
        };
        if matches!(open, Open::All) {
            f.tiles[i].full = true;
            f.tiles[i].filled = (x1 - x0) * (y1 - y0);
            if x0 == 0 {
                let other = f.tile(tx - 1, ty)?;
                for py in y0..y1 {
                    push(&mut f, &mut stack, &mut capacity, other, (py * TILE + TILE - 1) as usize, gap)?;
                }
            }
            if x1 == TILE {
                let other = f.tile(tx + 1, ty)?;
                for py in y0..y1 {
                    push(&mut f, &mut stack, &mut capacity, other, (py * TILE) as usize, gap)?;
                }
            }
            if y0 == 0 {
                let other = f.tile(tx, ty - 1)?;
                for px in x0..x1 {
                    push(&mut f, &mut stack, &mut capacity, other, ((TILE - 1) * TILE + px) as usize, gap)?;
                }
            }
            if y1 == TILE {
                let other = f.tile(tx, ty + 1)?;
                for px in x0..x1 {
                    push(&mut f, &mut stack, &mut capacity, other, px as usize, gap)?;
                }
            }
            continue;
        }
        let row = (p as i64) / TILE;
        let row_start = row * TILE;
        let mut px = (p as i64) % TILE;
        let open_at = |o: &Open, q: i64| o.at(q as usize);
        let visited_at = |f: &Flood, q: i64| f.tiles[i].visited.as_ref().map_or(0, |v| v[q as usize]);
        while px > x0 && open_at(&open, row_start + px - 1) && visited_at(&f, row_start + px - 1) != 2 {
            px -= 1;
        }
        if px == 0 {
            let other = f.tile(tx - 1, ty)?;
            push(&mut f, &mut stack, &mut capacity, other, (row_start + TILE - 1) as usize, gap)?;
        }
        while px < x1 && open_at(&open, row_start + px) && visited_at(&f, row_start + px) != 2 {
            f.tiles[i].visited.as_mut().unwrap()[(row_start + px) as usize] = 2;
            f.tiles[i].filled += 1;
            if row > y0 {
                push(&mut f, &mut stack, &mut capacity, Some(i), ((row - 1) * TILE + px) as usize, gap)?;
            } else if row == 0 {
                let other = f.tile(tx, ty - 1)?;
                push(&mut f, &mut stack, &mut capacity, other, ((TILE - 1) * TILE + px) as usize, gap)?;
            }
            if row + 1 < y1 {
                push(&mut f, &mut stack, &mut capacity, Some(i), ((row + 1) * TILE + px) as usize, gap)?;
            } else if row == TILE - 1 {
                let other = f.tile(tx, ty + 1)?;
                push(&mut f, &mut stack, &mut capacity, other, px as usize, gap)?;
            }
            px += 1;
        }
        if px == TILE {
            let other = f.tile(tx + 1, ty)?;
            push(&mut f, &mut stack, &mut capacity, other, row_start as usize, gap)?;
        }
    }
    let halo = if radius != 0 && !blank { 1 } else { 0 };
    let mut candidates: Vec<usize> = Vec::new();
    let mut is_candidate: std::collections::HashSet<usize> = std::collections::HashSet::new();
    for k in 0..filled.len() {
        let (ftx, fty) = (f.tiles[filled[k]].tx, f.tiles[filled[k]].ty);
        for dy in -halo..=halo {
            for dx in -halo..=halo {
                if let Some(c) = f.tile(ftx + dx, fty + dy)? {
                    if is_candidate.insert(c) {
                        f.reserve(64.0)?;
                        candidates.push(c);
                    }
                }
            }
        }
    }
    let clip = o.clip;
    let width = TILE + 2 * radius;
    for c in candidates {
        let (tx, ty, x0, y0, x1, y1, full) = {
            let t = &f.tiles[c];
            (t.tx, t.ty, t.x0, t.y0, t.x1, t.y1, t.full)
        };
        let old: Option<Pixels> = store.get(tx, ty).map(|t| t.pixels.clone());
        let has_distance = if radius != 0 && !full { f.distances(c, radius, true)? } else { false };
        if !full && radius != 0 && !has_distance {
            continue;
        }
        let mut pixels: Option<Box<[u8; TILE_BYTES]>> = None;
        let output_reserved = f.tiles[c].output_reserved;
        let mut writable = |f: &mut Flood, pixels: &mut Option<Box<[u8; TILE_BYTES]>>| -> Result<()> {
            if !output_reserved {
                f.reserve((TILE_BYTES + 256) as f64)?;
            }
            *pixels = Some(Box::new(match &old {
                Some(p) => **p,
                None => [0; TILE_BYTES],
            }));
            before.set(tx as i32, ty as i32, old.clone());
            Ok(())
        };
        if clip.is_none() && full && x0 == 0 && y0 == 0 && x1 == TILE && y1 == TILE {
            let same = match &old {
                Some(p) => p.chunks_exact(4).all(|px| u32::from_le_bytes([px[0], px[1], px[2], px[3]]) == word),
                None => word == 0,
            };
            if same {
                continue;
            }
            writable(&mut f, &mut pixels)?;
            for px in pixels.as_mut().unwrap().chunks_exact_mut(4) {
                px.copy_from_slice(&color);
            }
        } else {
            for py in y0..y1 {
                for px in x0..x1 {
                    if !full {
                        let inside = if radius != 0 {
                            (f.scratch[((py + radius) * width + px + radius) as usize] as i64) <= radius
                        } else {
                            f.tiles[c].visited.as_ref().is_some_and(|v| v[(py * TILE + px) as usize] == 2)
                        };
                        if !inside {
                            continue;
                        }
                    }
                    if let Some(clip) = clip {
                        let v = mask_value(clip, tx * TILE + px, ty * TILE + py);
                        if v == 0.0 || v.is_nan() {
                            continue;
                        }
                    }
                    let i = ((py * TILE + px) * 4) as usize;
                    let o4 = |k: usize| old.as_ref().map_or(0, |p| p[i + k]);
                    if color[0] == o4(0) && color[1] == o4(1) && color[2] == o4(2) && color[3] == o4(3) {
                        continue;
                    }
                    if pixels.is_none() {
                        writable(&mut f, &mut pixels)?;
                    }
                    pixels.as_mut().unwrap()[i..i + 4].copy_from_slice(&color);
                }
            }
        }
        if let Some(p) = pixels {
            output.adopt(tx, ty, std::sync::Arc::new(*p), Alpha::Unknown)?;
        }
    }
    Ok((output, before))
}

/// `floodTiles(store, options)`: prepares the fill, then adopts it; the undo records.
pub fn flood_tiles(store: &mut TileStore, o: &FillOptions) -> Result<Vec<TileChange>> {
    let (output, before) = prepare_flood(store, o)?;
    let changes = tile_changes(&output, before.entries());
    for tile in output.iter() {
        store.adopt(tile.tx as i64, tile.ty as i64, tile.pixels.clone(), Alpha::Unknown)?;
    }
    Ok(changes)
}
