//! Selection capture in the pixel worker (`drawing-lasso.mjs`): split a cel's tiles into
//! the selected pixels and the remainder, scanning only occupied tile rows with one
//! reusable tile-sized coverage buffer, within a working-memory budget.

use crate::error::{fail, Result, SELECTION_MEMORY};
use crate::mask::{lasso_bounds, Mask, MaskData};
use crate::tiles::{alpha_bounds, Pixels, Rect, TileStore, TILE, TILE_BYTES};

const AREA: usize = 64 * 64;

/// One captured tile: its selected pixels (`full` when the whole tile is selected, then
/// they are the cel's own) and what remains of it, with alpha bounds.
#[derive(Clone, Debug)]
pub struct Captured {
    pub tx: i32,
    pub ty: i32,
    pub pixels: Pixels,
    pub alpha: Option<Rect>,
    pub full: bool,
    pub remaining: Option<Pixels>,
    pub remaining_bounds: Option<Rect>,
}

/// `captureSelection(store, points, {maxBytes})`.
pub fn capture_selection(store: &TileStore, points: &[(f64, f64)], max_bytes: f64) -> Result<(Option<Rect>, Vec<Captured>)> {
    let bounds = lasso_bounds(points)?;
    let mut tiles = Vec::new();
    let Some(bounds) = bounds else { return Ok((None, tiles)) };
    if !max_bytes.is_finite() || max_bytes < 0.0 {
        return fail("errors.drawingLasso.invalidSelectionMemoryBudget");
    }
    let overhead = (points.len() * 128 + store.len() * 96 + AREA) as f64;
    let mut bytes = store.bytes() + overhead;
    if bytes > max_bytes {
        return fail(SELECTION_MEMORY);
    }
    let n = points.len();
    let mut edges: Vec<((f64, f64), (f64, f64))> = Vec::new();
    let mut j = n - 1;
    for i in 0..n {
        let (mut a, mut b) = (points[j], points[i]);
        j = i;
        if a.1 == b.1 {
            continue;
        }
        if a.1 > b.1 {
            std::mem::swap(&mut a, &mut b);
        }
        edges.push((a, b));
    }
    // Array.prototype.sort is stable.
    edges.sort_by(|u, v| (u.0 .1 - v.0 .1).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut rows: Vec<(i32, Vec<&crate::tiles::Tile>)> = Vec::new();
    for t in store.iter() {
        let (x, y) = (t.tx as i64 * TILE, t.ty as i64 * TILE);
        if x >= bounds.right() || x + TILE <= bounds.x || y >= bounds.bottom() || y + TILE <= bounds.y {
            continue;
        }
        match rows.iter_mut().find(|(ty, _)| *ty == t.ty) {
            Some((_, row)) => row.push(t),
            None => rows.push((t.ty, vec![t])),
        }
    }
    rows.sort_by_key(|(ty, _)| *ty);
    let mut active: Vec<((f64, f64), (f64, f64))> = Vec::new();
    let mut next = 0usize;
    let mut coverage = [0u8; AREA];
    for (ty, row) in rows {
        let mut spans: Vec<Vec<f64>> = Vec::with_capacity(64);
        let mut span_bytes = 0f64;
        for y in 0..TILE {
            let cy = ty as f64 * TILE as f64 + y as f64 + 0.5;
            active.retain(|e| e.1 .1 > cy);
            while next < edges.len() && edges[next].0 .1 <= cy {
                let e = edges[next];
                next += 1;
                if e.1 .1 > cy {
                    active.push(e);
                }
            }
            let mut xs: Vec<f64> = active.iter().map(|&(a, b)| a.0 + (cy - a.1) * (b.0 - a.0) / (b.1 - a.1)).collect();
            xs.sort_by(|a, b| (a - b).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal));
            span_bytes += (xs.len() * 16) as f64;
            if bytes + span_bytes > max_bytes {
                return fail(SELECTION_MEMORY);
            }
            spans.push(xs);
        }
        for t in row {
            coverage.fill(0);
            let ox = t.tx as i64 * TILE;
            let (mut selected, mut remaining, mut covered) = (0usize, 0usize, 0i64);
            for (y, xs) in spans.iter().enumerate() {
                let mut i = 0;
                while i + 1 < xs.len() {
                    let a = ((xs[i] - 0.5).ceil() as i64 - ox).max(0);
                    let b = ((xs[i + 1] - 0.5).ceil() as i64 - ox).min(TILE);
                    if b > a {
                        coverage[y * 64 + a as usize..y * 64 + b as usize].fill(1);
                        covered += b - a;
                    }
                    i += 2;
                }
            }
            if covered == 0 {
                continue;
            }
            if covered == AREA as i64 {
                if !t.transparent() {
                    selected = 1;
                }
            } else {
                for p in 0..AREA {
                    if t.pixels[p * 4 + 3] != 0 {
                        if coverage[p] != 0 {
                            selected += 1;
                        } else {
                            remaining += 1;
                        }
                    }
                }
            }
            if selected == 0 {
                continue;
            }
            let extra = if remaining > 0 { (TILE_BYTES * 2) as f64 } else { 0.0 };
            if bytes + span_bytes + extra > max_bytes {
                return fail(SELECTION_MEMORY);
            }
            bytes += extra;
            tiles.push(split(t, remaining > 0, |p| coverage[p] != 0));
        }
    }
    Ok((Some(bounds), tiles))
}

fn split(t: &crate::tiles::Tile, partial: bool, inside: impl Fn(usize) -> bool) -> Captured {
    if !partial {
        return Captured { tx: t.tx, ty: t.ty, pixels: t.pixels.clone(), alpha: t.alpha_bounds(), full: true, remaining: None, remaining_bounds: None };
    }
    let mut pixels = *t.pixels;
    let mut rest = *t.pixels;
    for p in 0..AREA {
        if inside(p) {
            rest[p * 4 + 3] = 0;
        } else {
            pixels[p * 4 + 3] = 0;
        }
    }
    let alpha = alpha_bounds(&pixels);
    let remaining_bounds = alpha_bounds(&rest);
    Captured { tx: t.tx, ty: t.ty, pixels: std::sync::Arc::new(pixels), alpha, full: false, remaining: Some(std::sync::Arc::new(rest)), remaining_bounds }
}

/// `captureMaskSelection(store, mask, {maxBytes})`.
pub fn capture_mask_selection(store: &TileStore, mask: &Mask, max_bytes: f64) -> Result<(Option<Rect>, Vec<Captured>)> {
    let bytes_mask = match &mask.data {
        MaskData::Points(points) => return capture_selection(store, points, max_bytes),
        MaskData::Dense { mask: bytes, .. } => bytes,
    };
    if bytes_mask.len() as i64 != mask.width * mask.height {
        return fail("errors.drawingLasso.invalidSelectionMask");
    }
    let mut tiles = Vec::new();
    let mut bytes = store.bytes() + bytes_mask.len() as f64;
    for t in store.iter() {
        let at = |p: usize| {
            let x = t.tx as i64 * TILE + (p % 64) as i64 - mask.x;
            let y = t.ty as i64 * TILE + (p / 64) as i64 - mask.y;
            x >= 0 && y >= 0 && x < mask.width && y < mask.height && bytes_mask[(y * mask.width + x) as usize] != 0
        };
        let (mut selected, mut remaining) = (0usize, 0usize);
        for p in 0..AREA {
            if t.pixels[p * 4 + 3] != 0 {
                if at(p) {
                    selected += 1;
                } else {
                    remaining += 1;
                }
            }
        }
        if selected == 0 {
            continue;
        }
        let extra = if remaining > 0 { (TILE_BYTES * 2) as f64 } else { 0.0 };
        if bytes + extra > max_bytes {
            return fail(SELECTION_MEMORY);
        }
        bytes += extra;
        let mut captured = split(t, remaining > 0, at);
        if !captured.full {
            captured.alpha = alpha_bounds(&captured.pixels[..]);
        }
        tiles.push(captured);
    }
    Ok((Some(mask.rect()), tiles))
}
