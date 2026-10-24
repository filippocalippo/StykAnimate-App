//! The affine kernel shared by selection commits, paste and resampling
//! (`drawing-transform.mjs`, `transformSelectedPixels` in drawing-selection.mjs):
//! output tiles planned from occupied source tiles with the filter footprint, memory
//! preflighted, premultiplied bilinear sampling from box-reduced levels (nearest for
//! pixel art and exact lattice maps), one bounded source window per output tile, and
//! exact byte copies for whole-tile translations into empty space.

use std::collections::HashMap;

use crate::error::{fail, Result, SELECTION_MEMORY, TRANSFORM_MEMORY};
use crate::js::{is_integer, log2, max, min, round_u8};
use crate::levels::level_store;
use crate::tiles::{assert_tile, tile_changes, Alpha, Before, Rect, TileChange, TileStore, TILE, TILE_BYTES};

pub const TRANSFORM_BYTES: f64 = 384.0 * 1024.0 * 1024.0;

/// A rectangle in (possibly fractional) pixel coordinates.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RectF {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl From<Rect> for RectF {
    fn from(r: Rect) -> RectF {
        RectF { x: r.x as f64, y: r.y as f64, width: r.width as f64, height: r.height as f64 }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Filter {
    Smooth,
    Nearest,
}

impl Filter {
    pub fn named(name: &str) -> Result<Filter> {
        match name {
            "smooth" => Ok(Filter::Smooth),
            "nearest" => Ok(Filter::Nearest),
            _ => fail("errors.drawingTransform.invalidDrawingTransformFilter"),
        }
    }
}

pub type Matrix = [f64; 6];

/// `transformBounds(r, m)`: the integer box around the transformed corners.
pub fn transform_bounds(r: RectF, m: &Matrix) -> RectF {
    let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for x in [r.x, r.x + r.width] {
        for y in [r.y, r.y + r.height] {
            let tx = m[0] * x + m[2] * y + m[4];
            let ty = m[1] * x + m[3] * y + m[5];
            x0 = min(x0, tx);
            y0 = min(y0, ty);
            x1 = max(x1, tx);
            y1 = max(y1, ty);
        }
    }
    let (x, y) = (x0.floor(), y0.floor());
    RectF { x, y, width: x1.ceil() - x, height: y1.ceil() - y }
}

/// `inverseMatrix(m)`.
pub fn inverse_matrix(m: &Matrix) -> Result<Matrix> {
    if !m.iter().all(|v| v.is_finite()) {
        return fail("errors.drawingTransform.invalidDrawingTransform");
    }
    let [a, b, c, d, x, y] = *m;
    let det = a * d - b * c;
    if !det.is_finite() || det.abs() < 1e-12 {
        return fail("errors.drawingTransform.theDrawingTransformIsSingular");
    }
    Ok([d / det, -b / det, -c / det, a / det, (c * y - d * x) / det, (b * x - a * y) / det])
}

/// `multiplyMatrix(a, b)`.
pub fn multiply_matrix(a: &Matrix, b: &Matrix) -> Matrix {
    [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]]
}

/// `selectionMatrix(s)`: a floating selection's pose.
#[allow(clippy::too_many_arguments)]
pub fn selection_matrix(angle: f64, scale: f64, fx: f64, fy: f64, cx: f64, cy: f64, dx: f64, dy: f64) -> Matrix {
    let a = angle * std::f64::consts::PI / 180.0;
    let c = styk_math::cos(a) * scale;
    let n = styk_math::sin(a) * scale;
    [c * fx, n * fx, -n * fy, c * fy, cx + dx - c * fx * cx + n * fy * cy, cy + dy - n * fx * cx - c * fy * cy]
}

fn filter_level(m: &Matrix, filter: Filter) -> Result<u32> {
    inverse_matrix(m)?;
    let [a, b, c, d, ..] = *m;
    let det = a * d - b * c;
    let q = a * a + b * b + c * c + d * d;
    let largest = ((q + max(0.0, q * q - 4.0 * det * det).sqrt()) / 2.0).sqrt();
    let smallest = det.abs() / largest;
    Ok(match filter {
        Filter::Nearest => 0,
        Filter::Smooth => max(0.0, min(8.0, (log2(1.0 / smallest) + 1e-9).floor())) as u32,
    })
}

fn support_bounds(b: RectF, m: &Matrix, filter: Filter, level: u32) -> RectF {
    let f = (1u64 << level) as f64;
    let halo = if filter == Filter::Nearest { 0.0 } else { f / 2.0 };
    let x = (b.x / f).floor() * f;
    let y = (b.y / f).floor() * f;
    let right = ((b.x + b.width) / f).ceil() * f;
    let bottom = ((b.y + b.height) / f).ceil() * f;
    transform_bounds(RectF { x: x - halo, y: y - halo, width: right - x + 2.0 * halo, height: bottom - y + 2.0 * halo }, m)
}

/// `transformSupportBounds(bounds, matrix, filter)`.
pub fn transform_support_bounds(bounds: RectF, m: &Matrix, filter: Filter) -> Result<RectF> {
    Ok(support_bounds(bounds, m, filter, filter_level(m, filter)?))
}

/// One source tile for planning: its coordinates and alpha bounds.
#[derive(Clone, Copy, Debug)]
pub struct PlanTile {
    pub tx: i64,
    pub ty: i64,
    pub alpha: Option<Rect>,
}

fn limit<T>() -> Result<T> {
    fail(TRANSFORM_MEMORY)
}

/// Candidate output tiles in first-planned order.
pub struct Plan {
    pub level: u32,
    pub candidates: Vec<(i64, i64)>,
    index: HashMap<(i64, i64), usize>,
}

impl Plan {
    fn remove(&mut self, tx: i64, ty: i64) {
        if let Some(i) = self.index.remove(&(tx, ty)) {
            self.candidates[i] = (i64::MIN, i64::MIN);
        }
    }
    pub fn has(&self, tx: i64, ty: i64) -> bool {
        self.index.contains_key(&(tx, ty))
    }
    pub fn len(&self) -> usize {
        self.index.len()
    }
    pub fn is_empty(&self) -> bool {
        self.index.is_empty()
    }
}

fn plan_transform(source: &[PlanTile], m: &Matrix, filter: Filter, max_bytes: f64, base_bytes: f64, tile_cost: f64) -> Result<Plan> {
    if !max_bytes.is_finite() || max_bytes < 0.0 {
        return fail("errors.drawingTransform.invalidDrawingTransformOptions");
    }
    let level = filter_level(m, filter)?;
    let mut coverage: Vec<std::collections::HashSet<(i64, i64)>> = vec![Default::default(); level as usize];
    let mut mip_bytes = 0f64;
    for t in source {
        for k in 1..=level {
            let f = 1i64 << k;
            if coverage[k as usize - 1].insert((t.tx.div_euclid(f), t.ty.div_euclid(f))) {
                mip_bytes += (TILE_BYTES + 96) as f64;
                if base_bytes + mip_bytes > max_bytes {
                    return limit();
                }
            }
        }
    }
    let mut plan = Plan { level, candidates: Vec::new(), index: HashMap::new() };
    let max_tiles = ((max_bytes - base_bytes - mip_bytes) / (tile_cost + 96.0)).floor();
    if max_tiles < 0.0 {
        return limit();
    }
    for tile in source {
        let Some(b) = tile.alpha else { continue };
        let rect = support_bounds(RectF { x: (tile.tx * TILE + b.x) as f64, y: (tile.ty * TILE + b.y) as f64, width: b.width as f64, height: b.height as f64 }, m, filter, level);
        let t = TILE as f64;
        let (x0, y0) = ((rect.x / t).floor(), (rect.y / t).floor());
        let (x1, y1) = (((rect.x + rect.width - 1.0) / t).floor(), ((rect.y + rect.height - 1.0) / t).floor());
        crate::tiles::assert_tile_f64(x0, y0)?;
        crate::tiles::assert_tile_f64(x1, y1)?;
        if (x1 - x0 + 1.0) * (y1 - y0 + 1.0) > max_tiles {
            return limit();
        }
        for ty in y0 as i64..=y1 as i64 {
            for tx in x0 as i64..=x1 as i64 {
                if !plan.index.contains_key(&(tx, ty)) {
                    if plan.index.len() as f64 >= max_tiles {
                        return limit();
                    }
                    plan.index.insert((tx, ty), plan.candidates.len());
                    plan.candidates.push((tx, ty));
                }
            }
        }
    }
    Ok(plan)
}

fn plan_tiles(store: &TileStore) -> Vec<PlanTile> {
    store.iter().map(|t| PlanTile { tx: t.tx as i64, ty: t.ty as i64, alpha: t.alpha_bounds() }).collect()
}

/// `transformTileCoverage(source, matrix, filter, maxBytes)`: the destination tiles a
/// transform can reach, including its filter footprint.
pub fn transform_tile_coverage(source: &TileStore, m: &Matrix, filter: Filter, max_bytes: f64) -> Result<Vec<(i64, i64)>> {
    let plan = plan_transform(&plan_tiles(source), m, filter, max_bytes, source.bytes(), TILE_BYTES as f64)?;
    Ok(plan.candidates)
}

/// `indexedTileCoverage(tiles, matrix, filter, maxBytes)`: the same from a tile index,
/// every tile taken as fully covered.
pub fn indexed_tile_coverage(tiles: &[(i64, i64)], m: &Matrix, filter: Filter, max_bytes: f64) -> Result<Vec<(i64, i64)>> {
    let source: Vec<PlanTile> = tiles.iter().map(|&(tx, ty)| PlanTile { tx, ty, alpha: Some(Rect::new(0, 0, TILE, TILE)) }).collect();
    let plan = plan_transform(&source, m, filter, max_bytes, (tiles.len() * TILE_BYTES) as f64, TILE_BYTES as f64)?;
    Ok(plan.candidates)
}

/// The sampler's four cached tiles, by coordinate parity.
struct Sampler<'a> {
    store: &'a TileStore,
    slots: [Option<(i64, i64, Option<&'a [u8]>)>; 4],
}

impl<'a> Sampler<'a> {
    fn read(&mut self, x: i64, y: i64, weight: f64, out: &mut [f64; 4]) {
        if weight == 0.0 || weight.is_nan() {
            return;
        }
        let (tx, ty) = (x.div_euclid(TILE), y.div_euclid(TILE));
        let slot = ((tx & 1) + 2 * (ty & 1)) as usize;
        let cached = match self.slots[slot] {
            Some((cx, cy, p)) if cx == tx && cy == ty => p,
            _ => {
                let p = self.store.get(tx, ty).map(|t| &t.pixels[..]);
                self.slots[slot] = Some((tx, ty, p));
                p
            }
        };
        let Some(p) = cached else { return };
        let i = (((y - ty * TILE) * TILE + x - tx * TILE) * 4) as usize;
        let alpha = p[i + 3] as f64 * weight;
        out[0] += p[i] as f64 * alpha;
        out[1] += p[i + 1] as f64 * alpha;
        out[2] += p[i + 2] as f64 * alpha;
        out[3] += alpha;
    }
}

/// `transformTiles(source, matrix, {target, before, filter, maxBytes})`: affine
/// source-over of `source` into `target`; `before` collects exact undo sides.
pub fn transform_tiles(source: &TileStore, m: &Matrix, target: &mut TileStore, mut before: Option<&mut Before>, filter: Filter, max_bytes: f64) -> Result<()> {
    let history_bytes = before.as_ref().map_or(0.0, |b| b.bytes());
    let base_bytes = source.bytes() + target.bytes() + history_bytes + (256 * 256 * 4) as f64;
    let tile_cost = TILE_BYTES as f64 * if before.is_some() && target.iter().any(|t| t.frozen) { 2.0 } else { 1.0 };
    let mut plan = plan_transform(&plan_tiles(source), m, filter, max_bytes, base_bytes, tile_cost)?;
    let f = (1u64 << plan.level) as f64;
    let input = if plan.level == 0 { None } else { Some(level_store(source, plan.level as usize)) };
    let input: &TileStore = input.as_ref().unwrap_or(source);
    let scaled = [m[0] * f, m[1] * f, m[2] * f, m[3] * f, m[4], m[5]];
    let inv = inverse_matrix(&scaled)?;
    let lattice = inv.iter().all(|&v| is_integer(v)) && inv[0] * inv[0] + inv[1] * inv[1] == 1.0 && inv[2] * inv[2] + inv[3] * inv[3] == 1.0 && inv[0] * inv[2] + inv[1] * inv[3] == 0.0;
    let nearest = filter == Filter::Nearest || lattice;
    if plan.level == 0 && m[0] == 1.0 && m[1] == 0.0 && m[2] == 0.0 && m[3] == 1.0 && m[4] % TILE as f64 == 0.0 && m[5] % TILE as f64 == 0.0 {
        let (dx, dy) = (m[4] / TILE as f64, m[5] / TILE as f64);
        for tile in source.iter() {
            if tile.transparent() {
                continue;
            }
            let (txf, tyf) = (tile.tx as f64 + dx, tile.ty as f64 + dy);
            let (tx, ty) = (txf as i64, tyf as i64);
            if target.has(tx, ty) {
                continue;
            }
            if let Some(before) = before.as_deref_mut() {
                if !before.has(tx as i32, ty as i32) {
                    assert_tile(tx, ty)?;
                    before.set(tx as i32, ty as i32, None);
                }
            }
            let alpha = tile.alpha_bounds();
            let out = target.writable_pixels(tx, ty)?;
            out.copy_from_slice(&tile.pixels[..]);
            for px in out.chunks_exact_mut(4) {
                if px[3] == 0 {
                    px[0] = 0;
                    px[1] = 0;
                    px[2] = 0;
                }
            }
            target.get(tx, ty).unwrap().set_alpha(Alpha::from(alpha));
            plan.remove(tx, ty);
        }
    }
    let mut sampler = Sampler { store: input, slots: [None; 4] };
    let candidates: Vec<(i64, i64)> = plan.candidates.iter().copied().filter(|&(tx, ty)| tx != i64::MIN && plan.has(tx, ty)).collect();
    for (tx, ty) in candidates {
        let rect = transform_bounds(RectF { x: (tx * TILE) as f64, y: (ty * TILE) as f64, width: TILE as f64, height: TILE as f64 }, &inv);
        let (wx, wy, ww, wh) = (rect.x - 1.0, rect.y - 1.0, rect.width + 3.0, rect.height + 3.0);
        let window = if ww <= 256.0 && wh <= 256.0 { Some(input.read_rect(wx as i64, wy as i64, ww as i64, wh as i64)) } else { None };
        let (wxi, wyi, wwi) = (wx as i64, wy as i64, ww as i64);
        // Reads past the window are `undefined` in JavaScript, NaN in arithmetic.
        let at = |w: &[u8], i: i64| -> f64 { if i >= 0 { w.get(i as usize).map_or(f64::NAN, |&v| v as f64) } else { f64::NAN } };
        // The output tile's pixels while it is written (`target.writable(tx, ty).pixels`).
        let mut written: Option<Box<[u8; TILE_BYTES]>> = None;
        for py in 0..TILE {
            let y = (ty * TILE + py) as f64 + 0.5;
            let ox = (tx * TILE) as f64 + 0.5;
            let start_x = inv[0] * ox + inv[2] * y + inv[4] - 0.5;
            let start_y = inv[1] * ox + inv[3] * y + inv[5] - 0.5;
            for px in 0..TILE {
                let x = start_x + px as f64 * inv[0];
                let y = start_y + px as f64 * inv[1];
                let (pr, pg, pb, alpha);
                if let Some(w) = &window {
                    if nearest {
                        let i = (((y + 0.5).floor() as i64 - wyi) * wwi + (x + 0.5).floor() as i64 - wxi) * 4;
                        alpha = at(w, i + 3);
                        pr = at(w, i) * alpha;
                        pg = at(w, i + 1) * alpha;
                        pb = at(w, i + 2) * alpha;
                    } else {
                        let (ix, iy) = (x.floor(), y.floor());
                        let (fx, fy) = (x - ix, y - iy);
                        let i = ((iy as i64 - wyi) * wwi + ix as i64 - wxi) * 4;
                        let j = i + wwi * 4;
                        let a0 = at(w, i + 3) * (1.0 - fx) * (1.0 - fy);
                        let a1 = at(w, i + 7) * fx * (1.0 - fy);
                        let a2 = at(w, j + 3) * (1.0 - fx) * fy;
                        let a3 = at(w, j + 7) * fx * fy;
                        alpha = a0 + a1 + a2 + a3;
                        pr = at(w, i) * a0 + at(w, i + 4) * a1 + at(w, j) * a2 + at(w, j + 4) * a3;
                        pg = at(w, i + 1) * a0 + at(w, i + 5) * a1 + at(w, j + 1) * a2 + at(w, j + 5) * a3;
                        pb = at(w, i + 2) * a0 + at(w, i + 6) * a1 + at(w, j + 2) * a2 + at(w, j + 6) * a3;
                    }
                } else {
                    let mut rgba = [0f64; 4];
                    if nearest {
                        sampler.read((x + 0.5).floor() as i64, (y + 0.5).floor() as i64, 1.0, &mut rgba);
                    } else {
                        let (ixf, iyf) = (x.floor(), y.floor());
                        let (fx, fy) = (x - ixf, y - iyf);
                        let (ix, iy) = (ixf as i64, iyf as i64);
                        sampler.read(ix, iy, (1.0 - fx) * (1.0 - fy), &mut rgba);
                        sampler.read(ix + 1, iy, fx * (1.0 - fy), &mut rgba);
                        sampler.read(ix, iy + 1, (1.0 - fx) * fy, &mut rgba);
                        sampler.read(ix + 1, iy + 1, fx * fy, &mut rgba);
                    }
                    pr = rgba[0];
                    pg = rgba[1];
                    pb = rgba[2];
                    alpha = rgba[3];
                }
                let j = ((py * TILE + px) * 4) as usize;
                if alpha <= 0.0 {
                    continue;
                }
                if alpha < 0.5 {
                    let dest = match &written {
                        Some(p) => p[j + 3],
                        None => target.get(tx, ty).map_or(0, |t| t.pixels[j + 3]),
                    };
                    if dest == 0 {
                        continue;
                    }
                }
                if written.is_none() {
                    if let Some(before) = before.as_deref_mut() {
                        if !before.has(tx as i32, ty as i32) {
                            assert_tile(tx, ty)?;
                            before.set(tx as i32, ty as i32, target.get(tx, ty).map(|t| t.pixels.clone()));
                        }
                    }
                    let tile = target.writable(tx, ty, true)?.unwrap();
                    written = Some(Box::new(*tile.pixels));
                }
                let pixels = written.as_mut().unwrap();
                let base = pixels[j + 3] as f64 * (1.0 - alpha / 255.0);
                let out = alpha + base;
                pixels[j] = round_u8((pr + pixels[j] as f64 * base) / out);
                pixels[j + 1] = round_u8((pg + pixels[j + 1] as f64 * base) / out);
                pixels[j + 2] = round_u8((pb + pixels[j + 2] as f64 * base) / out);
                pixels[j + 3] = round_u8(out);
            }
        }
        if let Some(pixels) = written {
            target.get_mut(tx, ty).unwrap().pixels = std::sync::Arc::new(*pixels);
        }
    }
    Ok(())
}

/// `transformSelectedPixels(store, {source, matrix, remove, filter, maxBytes})`: lifts the
/// selected pixels out of `store` and, unless `remove`, lays the transformed selection
/// back; the exact undo records.
pub fn transform_selected_pixels(store: &mut TileStore, source: &TileStore, m: &Matrix, remove: bool, filter: Filter, max_bytes: f64) -> Result<Vec<TileChange>> {
    inverse_matrix(m)?;
    let mut before = Before::new();
    let mut bytes = store.bytes() + source.bytes();
    if !max_bytes.is_finite() || bytes > max_bytes {
        return fail(SELECTION_MEMORY);
    }
    for selected in source.iter() {
        let (tx, ty) = (selected.tx as i64, selected.ty as i64);
        let Some(tile) = store.get(tx, ty) else { continue };
        let original = tile.pixels.clone();
        let mut writing = false;
        for i in (3..TILE_BYTES).step_by(4) {
            if selected.pixels[i] != 0 && original[i] != 0 {
                if !writing {
                    if bytes + (TILE_BYTES * 2) as f64 > max_bytes {
                        return fail(SELECTION_MEMORY);
                    }
                    bytes += (TILE_BYTES * 2) as f64;
                    before.set(selected.tx, selected.ty, Some(original.clone()));
                    store.writable(tx, ty, true)?;
                    writing = true;
                }
                store.get_mut(tx, ty).unwrap().pixels_mut()[i] = 0;
            }
        }
    }
    if !remove {
        transform_tiles(source, m, store, Some(&mut before), filter, max_bytes)?;
    }
    Ok(tile_changes(store, before.entries()))
}
