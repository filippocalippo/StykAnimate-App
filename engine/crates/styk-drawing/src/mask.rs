//! Pixel selections (`drawing-pixels.mjs`, `drawing-lasso.mjs`): a bounded byte mask on
//! one cel, or a polygon outline for selections too large for a mask; the magic wand's
//! flood; combining, inverting, cropping and outlining masks; filling a selection.

use crate::error::{fail, Result};
use crate::js::{clamp, round, round_u8};
use crate::tiles::{tiles_in_rect, Rect, TileStore, MAX_TILE, MIN_TILE, TILE};

/// `DRAWING_MAX_PIXELS`: the dense-surface limit (16 megapixels).
pub const DRAWING_MAX_PIXELS: i64 = 16 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq)]
pub enum MaskData {
    /// One byte per pixel, read as `byte / max`.
    Dense { mask: Vec<u8>, max: f64 },
    /// An even-odd polygon in cel pixels.
    Points(Vec<(f64, f64)>),
}

/// A selection: `{x, y, width, height, mask}` or `{x, y, width, height, points}`.
#[derive(Clone, Debug, PartialEq)]
pub struct Mask {
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
    pub data: MaskData,
}

impl Mask {
    pub fn dense(x: i64, y: i64, width: i64, height: i64, mask: Vec<u8>) -> Mask {
        Mask { x, y, width, height, data: MaskData::Dense { mask, max: 1.0 } }
    }
    pub fn rect(&self) -> Rect {
        Rect::new(self.x, self.y, self.width, self.height)
    }
    pub fn bytes(&self) -> Option<&[u8]> {
        match &self.data {
            MaskData::Dense { mask, .. } => Some(mask),
            MaskData::Points(_) => None,
        }
    }
    pub fn points(&self) -> Option<&[(f64, f64)]> {
        match &self.data {
            MaskData::Points(p) => Some(p),
            MaskData::Dense { .. } => None,
        }
    }
}

/// `maskValue(m, x, y)`.
#[inline]
pub fn mask_value(m: &Mask, x: i64, y: i64) -> f64 {
    if x < m.x || y < m.y || x >= m.x + m.width || y >= m.y + m.height {
        return 0.0;
    }
    match &m.data {
        MaskData::Points(points) => lasso_contains(points, x as f64, y as f64) as u8 as f64,
        MaskData::Dense { mask, max } => mask[((y - m.y) * m.width + x - m.x) as usize] as f64 / max,
    }
}

/// `lassoContains(points, x, y)`: even-odd at the centre of the pixel.
pub fn lasso_contains(points: &[(f64, f64)], x: f64, y: f64) -> bool {
    let x = x.floor() + 0.5;
    let y = y.floor() + 0.5;
    let mut inside = false;
    let n = points.len();
    if n == 0 {
        return false;
    }
    let mut j = n - 1;
    for i in 0..n {
        let (a, b) = (points[j], points[i]);
        if (a.1 > y) != (b.1 > y) && x < a.0 + (y - a.1) * (b.0 - a.0) / (b.1 - a.1) {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// `lassoBounds(points)`: validated, or `None` below three points or with no area.
pub fn lasso_bounds(points: &[(f64, f64)]) -> Result<Option<Rect>> {
    let lo = (MIN_TILE * TILE) as f64;
    let hi = ((MAX_TILE + 1) * TILE) as f64;
    if points.len() > 8192 || points.iter().any(|p| !(p.0.is_finite() && p.1.is_finite() && p.0 >= lo && p.0 <= hi && p.1 >= lo && p.1 <= hi)) {
        return fail("errors.drawingLasso.invalidLassoCoordinates");
    }
    if points.len() < 3 {
        return Ok(None);
    }
    let x = points.iter().map(|p| p.0).fold(f64::INFINITY, f64::min).floor();
    let y = points.iter().map(|p| p.1).fold(f64::INFINITY, f64::min).floor();
    let width = points.iter().map(|p| p.0).fold(f64::NEG_INFINITY, f64::max).ceil() - x;
    let height = points.iter().map(|p| p.1).fold(f64::NEG_INFINITY, f64::max).ceil() - y;
    Ok((width != 0.0 && height != 0.0).then(|| Rect::new(x as i64, y as i64, width as i64, height as i64)))
}

/// `lassoMask(points)`: a mask over the polygon's bounding box, or the polygon itself when
/// that box exceeds 16 megapixels.
pub fn lasso_mask(points: &[(f64, f64)]) -> Mask {
    let x0 = points.iter().map(|p| p.0).fold(f64::INFINITY, f64::min).floor();
    let y0 = points.iter().map(|p| p.1).fold(f64::INFINITY, f64::min).floor();
    let width = points.iter().map(|p| p.0).fold(f64::NEG_INFINITY, f64::max).ceil() - x0;
    let height = points.iter().map(|p| p.1).fold(f64::NEG_INFINITY, f64::max).ceil() - y0;
    let (x0i, y0i, wi, hi) = (x0 as i64, y0 as i64, width as i64, height as i64);
    if width * height > DRAWING_MAX_PIXELS as f64 {
        return Mask { x: x0i, y: y0i, width: wi, height: hi, data: MaskData::Points(points.to_vec()) };
    }
    let (w, h) = (wi.max(0), hi.max(0));
    let mut mask = vec![0u8; (w * h) as usize];
    if points.len() < 3 || wi < 1 || hi < 1 {
        return Mask::dense(x0i, y0i, w, h, mask);
    }
    let n = points.len();
    for y in 0..hi {
        let mut crosses = Vec::new();
        let wy = y0 + y as f64 + 0.5;
        let mut j = n - 1;
        for i in 0..n {
            let (a, b) = (points[i], points[j]);
            if (a.1 > wy) != (b.1 > wy) {
                crosses.push(a.0 + (wy - a.1) * (b.0 - a.0) / (b.1 - a.1));
            }
            j = i;
        }
        crosses.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let mut i = 0;
        while i + 1 < crosses.len() {
            let from = (crosses[i] - 0.5 - x0).ceil().max(0.0) as i64;
            let to = ((crosses[i + 1] - 0.5 - x0).ceil()).min(wi as f64) as i64;
            for x in from..to {
                mask[(y * wi + x) as usize] = 1;
            }
            i += 2;
        }
    }
    Mask::dense(x0i, y0i, wi, hi, mask)
}

/// `rectPoints(a, b)`.
pub fn rect_points(a: (f64, f64), b: (f64, f64)) -> Vec<(f64, f64)> {
    let (x0, y0, x1, y1) = (a.0.min(b.0), a.1.min(b.1), a.0.max(b.0), a.1.max(b.1));
    vec![(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
}

/// `ellipsePoints(a, b, n)`.
pub fn ellipse_points(a: (f64, f64), b: (f64, f64), n: usize) -> Vec<(f64, f64)> {
    let (cx, cy) = ((a.0 + b.0) / 2.0, (a.1 + b.1) / 2.0);
    let (rx, ry) = ((b.0 - a.0).abs() / 2.0, (b.1 - a.1).abs() / 2.0);
    (0..n)
        .map(|i| {
            let t = i as f64 / n as f64 * std::f64::consts::PI * 2.0;
            (cx + styk_math::cos(t) * rx, cy + styk_math::sin(t) * ry)
        })
        .collect()
}

/// `rectMask(rect)`.
pub fn rect_mask(rect: Rect) -> Mask {
    if rect.width * rect.height > DRAWING_MAX_PIXELS {
        let points = rect_points((rect.x as f64, rect.y as f64), ((rect.x + rect.width) as f64, (rect.y + rect.height) as f64));
        return Mask { x: rect.x, y: rect.y, width: rect.width, height: rect.height, data: MaskData::Points(points) };
    }
    Mask::dense(rect.x, rect.y, rect.width, rect.height, vec![1u8; (rect.width * rect.height) as usize])
}

/// `cropMask(m)`: the mask cropped to its occupied box, or `None` when empty.
pub fn crop_mask(m: Mask) -> Option<Mask> {
    let MaskData::Dense { mask, max } = &m.data else { return Some(m) };
    let (w, h) = (m.width, m.height);
    let (mut x0, mut y0, mut x1, mut y1) = (w, h, -1i64, -1i64);
    for py in 0..h {
        for px in 0..w {
            if mask[(py * w + px) as usize] != 0 {
                x0 = x0.min(px);
                x1 = x1.max(px);
                y0 = y0.min(py);
                y1 = py;
            }
        }
    }
    if x1 < 0 {
        return None;
    }
    if x0 == 0 && y0 == 0 && x1 == w - 1 && y1 == h - 1 {
        return Some(m);
    }
    let (width, height) = (x1 - x0 + 1, y1 - y0 + 1);
    let mut out = vec![0u8; (width * height) as usize];
    for py in 0..height {
        let from = ((py + y0) * w + x0) as usize;
        out[(py * width) as usize..((py + 1) * width) as usize].copy_from_slice(&mask[from..from + width as usize]);
    }
    Some(Mask { x: m.x + x0, y: m.y + y0, width, height, data: MaskData::Dense { mask: out, max: *max } })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Combine {
    Replace,
    Add,
    Subtract,
    Intersect,
}

/// `combineMasks(a, b, mode)`.
pub fn combine_masks(a: Option<Mask>, b: Option<Mask>, mode: Combine) -> Result<Option<Mask>> {
    let Some(a) = a.filter(|_| mode != Combine::Replace) else {
        return Ok(if matches!(mode, Combine::Subtract | Combine::Intersect) { None } else { b.and_then(crop_mask) });
    };
    let Some(b) = b else {
        return Ok(if mode == Combine::Intersect { None } else { crop_mask(a) });
    };
    let x = a.x.min(b.x);
    let y = a.y.min(b.y);
    let width = (a.x + a.width).max(b.x + b.width) - x;
    let height = (a.y + a.height).max(b.y + b.height) - y;
    if width * height > DRAWING_MAX_PIXELS {
        return fail("errors.drawingPixels.combinedSelectionExceedsThe16MegapixelMaskLimit");
    }
    let mut out = vec![0u8; (width * height) as usize];
    // Bitwise operators work on the values' 32-bit integers.
    let int = |v: f64| crate::js::to_i32(v);
    for py in 0..height {
        for px in 0..width {
            let u = mask_value(&a, px + x, py + y);
            let v = mask_value(&b, px + x, py + y);
            out[(py * width + px) as usize] = match mode {
                Combine::Add => crate::js::to_u8((int(u) | int(v)) as f64),
                Combine::Subtract => (u != 0.0 && v == 0.0) as u8,
                _ => crate::js::to_u8((int(u) & int(v)) as f64),
            };
        }
    }
    Ok(crop_mask(Mask::dense(x, y, width, height, out)))
}

/// `invertMask(m, bounds)`.
pub fn invert_mask(m: Option<&Mask>, bounds: Rect) -> Result<Option<Mask>> {
    if bounds.width * bounds.height > DRAWING_MAX_PIXELS {
        return fail("errors.drawingPixels.invertedSelectionExceedsThe16MegapixelMaskLimit");
    }
    let mut out = vec![1u8; (bounds.width * bounds.height) as usize];
    if let Some(m) = m {
        for py in 0..m.height {
            for px in 0..m.width {
                if mask_value(m, px + m.x, py + m.y) == 0.0 {
                    continue;
                }
                let (x, y) = (px + m.x - bounds.x, py + m.y - bounds.y);
                if x >= 0 && y >= 0 && x < bounds.width && y < bounds.height {
                    out[(y * bounds.width + x) as usize] = 0;
                }
            }
        }
    }
    Ok(crop_mask(Mask::dense(bounds.x, bounds.y, bounds.width, bounds.height, out)))
}

/// `maskEdges(m, limit)`: boundary segments `[x0, y0, x1, y1, …]`, or `None` past `limit`.
pub fn mask_edges(m: &Mask, limit: usize) -> Option<Vec<i64>> {
    let MaskData::Dense { mask, .. } = &m.data else { return None };
    let (w, h) = (m.width, m.height);
    let at = |px: i64, py: i64| if px >= 0 && py >= 0 && px < w && py < h { mask[(py * w + px) as usize] } else { 0 };
    let mut out = Vec::new();
    for py in 0..=h {
        let mut start = -1i64;
        for px in 0..=w {
            let edge = px < w && at(px, py) != at(px, py - 1);
            if edge && start < 0 {
                start = px;
            } else if !edge && start >= 0 {
                out.extend_from_slice(&[m.x + start, m.y + py, m.x + px, m.y + py]);
                start = -1;
                if out.len() > limit * 4 {
                    return None;
                }
            }
        }
    }
    for px in 0..=w {
        let mut start = -1i64;
        for py in 0..=h {
            let edge = py < h && at(px, py) != at(px - 1, py);
            if edge && start < 0 {
                start = py;
            } else if !edge && start >= 0 {
                out.extend_from_slice(&[m.x + px, m.y + start, m.x + px, m.y + py]);
                start = -1;
                if out.len() > limit * 4 {
                    return None;
                }
            }
        }
    }
    Some(out)
}

/// `fillMaskTiles(store, {mask, color})`: source-over `color` on every selected pixel.
pub fn fill_mask_tiles(store: &mut TileStore, mask: &Mask, color: [f64; 4]) -> Result<()> {
    let [r, g, b, a] = color.map(|n| clamp(n, 0.0, 255.0));
    let alpha = a / 255.0;
    if alpha == 0.0 || alpha.is_nan() {
        return Ok(());
    }
    for (tx, ty) in tiles_in_rect(mask.x, mask.y, mask.width, mask.height) {
        let (ox, oy) = (tx * TILE, ty * TILE);
        let mut written = false;
        for py in (mask.y - oy).max(0)..(mask.y + mask.height - oy).min(TILE) {
            for px in (mask.x - ox).max(0)..(mask.x + mask.width - ox).min(TILE) {
                let value = mask_value(mask, px + ox, py + oy);
                if value == 0.0 || value.is_nan() {
                    continue;
                }
                let p = if written {
                    store.get_mut(tx, ty).unwrap().pixels_mut()
                } else {
                    written = true;
                    store.writable_pixels(tx, ty)?
                };
                let j = ((py * TILE + px) * 4) as usize;
                let ba = p[j + 3] as f64 / 255.0;
                let out = alpha + ba * (1.0 - alpha);
                let k = ba * (1.0 - alpha);
                p[j] = round_u8((r * alpha + p[j] as f64 * k) / out);
                p[j + 1] = round_u8((g * alpha + p[j + 1] as f64 * k) / out);
                p[j + 2] = round_u8((b * alpha + p[j + 2] as f64 * k) / out);
                p[j + 3] = round_u8(out * 255.0);
            }
        }
    }
    Ok(())
}

/// `dilateL1`: every pixel within Manhattan distance `k` of a set pixel, within `box`
/// grown by `k`. `k <= 0` returns the input.
fn dilate_l1(src: &[u8], width: i64, height: i64, k: i64, bx: (i64, i64, i64, i64)) -> Vec<u8> {
    if k <= 0 {
        return src.to_vec();
    }
    let x0 = (bx.0 - k).max(0);
    let y0 = (bx.1 - k).max(0);
    let x1 = (width - 1).min(bx.2 + k);
    let y1 = (height - 1).min(bx.3 + k);
    let mut out = vec![0u8; (width * height) as usize];
    let at = |p: i64| src[p as usize];
    if k == 1 {
        for y in y0..=y1 {
            let row = y * width;
            for x in x0..=x1 {
                let p = row + x;
                if at(p) != 0 || (x > 0 && at(p - 1) != 0) || (x < width - 1 && at(p + 1) != 0) || (y > 0 && at(p - width) != 0) || (y < height - 1 && at(p + width) != 0) {
                    out[p as usize] = 1;
                }
            }
        }
        return out;
    }
    let cap = (k + 1) as u8;
    let d = &mut out;
    for y in y0..=y1 {
        let row = y * width;
        for x in x0..=x1 {
            let p = (row + x) as usize;
            let mut v = if at(p as i64) != 0 { 0 } else { cap };
            if v != 0 {
                if x > x0 && d[p - 1] as u16 + 1 < v as u16 {
                    v = d[p - 1] + 1;
                }
                if y > y0 && (d[p - width as usize] as u16) + 1 < v as u16 {
                    v = d[p - width as usize] + 1;
                }
            }
            d[p] = v;
        }
    }
    for y in (y0..=y1).rev() {
        let row = y * width;
        for x in (x0..=x1).rev() {
            let p = (row + x) as usize;
            let mut v = d[p];
            if v == 0 {
                continue;
            }
            if x < x1 && (d[p + 1] as u16) + 1 < v as u16 {
                v = d[p + 1] + 1;
            }
            if y < y1 && (d[p + width as usize] as u16) + 1 < v as u16 {
                v = d[p + width as usize] + 1;
            }
            d[p] = v;
        }
    }
    for y in y0..=y1 {
        let row = y * width;
        for x in x0..=x1 {
            let p = (row + x) as usize;
            d[p] = (d[p] as i64 <= k) as u8;
        }
    }
    out
}

/// Options of the dense flood (`floodTiles` in drawing-pixels.mjs).
#[derive(Clone, Debug)]
pub struct DenseFlood<'a> {
    pub x: f64,
    pub y: f64,
    pub color: [f64; 4],
    pub tolerance: f64,
    pub expansion: f64,
    pub gap: f64,
    pub bounds: Rect,
    pub source: Option<&'a [u8]>,
    pub clip: Option<&'a Mask>,
}

/// What a dense flood produced.
#[derive(Debug, PartialEq)]
pub enum Flooded {
    /// The start was outside the bounds or not fillable.
    Nothing,
    /// The selected region (`select`), or `None` when empty.
    Selection(Option<Mask>),
    /// The store was filled.
    Filled,
}

/// The dense flood within explicit bounds (`floodTiles` of drawing-pixels.mjs): the magic
/// wand (`select`) and the legacy dense fill.
pub fn flood_dense(store: &mut TileStore, o: &DenseFlood, select: bool) -> Result<Flooded> {
    let b = o.bounds;
    if b.width < 1 || b.height < 1 || b.width * b.height > DRAWING_MAX_PIXELS {
        return fail("errors.drawingFill.invalidFillBounds");
    }
    let (width, height) = (b.width, b.height);
    let count = (width * height) as usize;
    let x = o.x.floor() - b.x as f64;
    let y = o.y.floor() - b.y as f64;
    if x < 0.0 || y < 0.0 || x >= width as f64 || y >= height as f64 || x.is_nan() || y.is_nan() {
        return Ok(Flooded::Nothing);
    }
    let (x, y) = (x as i64, y as i64);
    if ![o.tolerance, o.expansion, o.gap].iter().all(|v| v.is_finite()) || !o.color.iter().all(|v| v.is_finite()) {
        return fail("errors.drawingFill.invalidFillOptions");
    }
    let tolerance = clamp(o.tolerance, 0.0, 255.0);
    let expansion = round(clamp(o.expansion, 0.0, 16.0)) as i64;
    let gap = round(clamp(o.gap, 0.0, 8.0)) as i64;
    let sample = |px: i64, py: i64| -> [u8; 4] {
        match o.source {
            Some(src) => {
                let i = ((py * width + px) * 4) as usize;
                [src[i], src[i + 1], src[i + 2], src[i + 3]]
            }
            None => store.pixel(b.x + px, b.y + py),
        }
    };
    let t = sample(x, y);
    let ta = t[3] as f64;
    let (tr, tg, tb) = (t[0] as f64 * ta, t[1] as f64 * ta, t[2] as f64 * ta);
    let tol = tolerance * 255.0;
    let eligible = |r: u8, g: u8, bl: u8, a: u8| -> u8 {
        let a = a as f64;
        if (a - ta).abs() > tolerance {
            return 0;
        }
        let dr = r as f64 * a - tr;
        let dg = g as f64 * a - tg;
        let db = bl as f64 * a - tb;
        (dr <= tol && dr >= -tol && dg <= tol && dg >= -tol && db <= tol && db >= -tol) as u8
    };
    let mut open = vec![0u8; count];
    let empty = eligible(0, 0, 0, 0);
    if let Some(src) = o.source {
        for p in 0..count {
            let i = p * 4;
            open[p] = eligible(src[i], src[i + 1], src[i + 2], src[i + 3]);
        }
    } else {
        for (tx, ty) in tiles_in_rect(b.x, b.y, width, height) {
            let (ox, oy) = (tx * TILE - b.x, ty * TILE - b.y);
            let (sx, ex, sy, ey) = ((-ox).max(0), (width - ox).min(TILE), (-oy).max(0), (height - oy).min(TILE));
            match store.get(tx, ty) {
                None => {
                    if empty != 0 {
                        for py in sy..ey {
                            let row = (py + oy) * width + ox;
                            open[(row + sx) as usize..(row + ex) as usize].fill(1);
                        }
                    }
                }
                Some(tile) => {
                    let src = &tile.pixels;
                    for py in sy..ey {
                        let row = (py + oy) * width + ox;
                        for px in sx..ex {
                            let i = ((py * TILE + px) * 4) as usize;
                            open[(row + px) as usize] = eligible(src[i], src[i + 1], src[i + 2], src[i + 3]);
                        }
                    }
                }
            }
        }
    }
    if gap != 0 {
        let closed_count: i64 = open.iter().map(|&v| 1 - v as i64).sum();
        if closed_count * (2 * gap * gap + 2 * gap + 1) < 4 * count as i64 {
            let mut blocked = vec![0u8; count];
            for p in 0..count as i64 {
                if open[p as usize] != 0 {
                    continue;
                }
                let px = p % width;
                let py = (p - px) / width;
                for dy in -gap..=gap {
                    let yy = py + dy;
                    if yy < 0 || yy >= height {
                        continue;
                    }
                    let w = gap - dy.abs();
                    let row = yy * width;
                    blocked[(row + (px - w).max(0)) as usize..(row + (width - 1).min(px + w) + 1) as usize].fill(1);
                }
            }
            for p in 0..count {
                if blocked[p] != 0 {
                    open[p] = 0;
                }
            }
        } else {
            let closed: Vec<u8> = open.iter().map(|&v| 1 - v).collect();
            let blocked = dilate_l1(&closed, width, height, gap, (0, 0, width - 1, height - 1));
            for p in 0..count {
                if blocked[p] != 0 {
                    open[p] = 0;
                }
            }
        }
    }
    let clip_at = |p: i64| -> Result<u8> {
        let clip = o.clip.unwrap();
        let cx = p % width + b.x - clip.x;
        let cy = (p - p % width) / width + b.y - clip.y;
        let Some(bytes) = clip.bytes() else { return fail("errors.drawingLasso.invalidSelectionMask") };
        Ok(if cx >= 0 && cy >= 0 && cx < clip.width && cy < clip.height { bytes[(cy * clip.width + cx) as usize] } else { 0 })
    };
    if o.clip.is_some() {
        for p in 0..count {
            if open[p] != 0 && clip_at(p as i64)? == 0 {
                open[p] = 0;
            }
        }
    }
    let start = (y * width + x) as usize;
    if open[start] == 0 {
        return Ok(if select { Flooded::Selection(None) } else { Flooded::Nothing });
    }
    let mut mask = vec![0u8; count];
    let mut stack = vec![start as i64];
    let mut bx = (x, y, x, y);
    while let Some(p) = stack.pop() {
        if mask[p as usize] != 0 || open[p as usize] == 0 {
            continue;
        }
        let row = p - p % width;
        let ry = row / width;
        let (mut l, mut r) = (p, p);
        while l > row && open[(l - 1) as usize] != 0 && mask[(l - 1) as usize] == 0 {
            l -= 1;
        }
        while r < row + width - 1 && open[(r + 1) as usize] != 0 && mask[(r + 1) as usize] == 0 {
            r += 1;
        }
        mask[l as usize..=r as usize].fill(1);
        bx.0 = bx.0.min(l - row);
        bx.2 = bx.2.max(r - row);
        bx.1 = bx.1.min(ry);
        bx.3 = bx.3.max(ry);
        for next in [row - width, row + width] {
            if next < 0 || next >= count as i64 {
                continue;
            }
            let off = next - row;
            let mut in_run = false;
            for q in (l + off)..=(r + off) {
                if open[q as usize] != 0 && mask[q as usize] == 0 {
                    if !in_run {
                        stack.push(q);
                        in_run = true;
                    }
                } else {
                    in_run = false;
                }
            }
        }
    }
    let k = gap + expansion;
    let mut grown = dilate_l1(&mask, width, height, k, bx);
    let (gx0, gy0, gx1, gy1) = ((bx.0 - k).max(0), (bx.1 - k).max(0), (width - 1).min(bx.2 + k), (height - 1).min(bx.3 + k));
    if o.clip.is_some() {
        for py in gy0..=gy1 {
            for px in gx0..=gx1 {
                let p = py * width + px;
                if grown[p as usize] != 0 && clip_at(p)? == 0 {
                    grown[p as usize] = 0;
                }
            }
        }
    }
    if select {
        let (w, h) = (gx1 - gx0 + 1, gy1 - gy0 + 1);
        let mut out = vec![0u8; (w * h) as usize];
        for py in 0..h {
            let from = ((py + gy0) * width + gx0) as usize;
            out[(py * w) as usize..((py + 1) * w) as usize].copy_from_slice(&grown[from..from + w as usize]);
        }
        return Ok(Flooded::Selection(crop_mask(Mask::dense(b.x + gx0, b.y + gy0, w, h, out))));
    }
    // A whole tile takes the colour through a `Uint8ClampedArray`, partial tiles as one
    // 32-bit word built with shifts (`ToInt32`), exactly as the JavaScript does.
    let uniform = o.color.map(crate::js::u8c);
    let c = o.color.map(crate::js::to_i32);
    let word = ((c[3] << 24) | (c[2] << 16) | (c[1] << 8) | c[0]) as u32;
    let color = word.to_le_bytes();
    for (tx, ty) in tiles_in_rect(b.x + gx0, b.y + gy0, gx1 - gx0 + 1, gy1 - gy0 + 1) {
        let (ox, oy) = (tx * TILE - b.x, ty * TILE - b.y);
        let (sx, ex, sy, ey) = ((-ox).max(0), (width - ox).min(TILE), (-oy).max(0), (height - oy).min(TILE));
        let mut filled = 0;
        for py in sy..ey {
            let row = (py + oy) * width + ox;
            for px in sx..ex {
                filled += grown[(row + px) as usize] as i64;
            }
        }
        if filled == 0 {
            continue;
        }
        if filled == TILE * TILE {
            store.set(tx, ty, Some(&uniform))?;
            continue;
        }
        let px_out = store.writable_pixels(tx, ty)?;
        for py in sy..ey {
            let row = (py + oy) * width + ox;
            for px in sx..ex {
                if grown[(row + px) as usize] != 0 {
                    let j = ((py * TILE + px) * 4) as usize;
                    px_out[j..j + 4].copy_from_slice(&color);
                }
            }
        }
    }
    Ok(Flooded::Filled)
}
