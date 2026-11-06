//! Drawing filters (`filterTiles` in drawing-pixels.mjs): blur, hue/saturation/lightness,
//! brightness/contrast and invert over a rectangle, weighted by an optional selection.
//! Point filters visit occupied tile intersections only; blur owns one bounded dense
//! surface. Pixels outside the selection keep their exact bytes.

use crate::error::{fail, Result};
use crate::js::{clamp, clamp01, is_safe_integer, max, min, round, round_u8, u8c};
use crate::mask::{mask_value, Mask, DRAWING_MAX_PIXELS};
use crate::tiles::{Alpha, Before, Rect, TileStore, TILE, TILE_BYTES};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Filter {
    Blur { radius: f64 },
    Hsl { hue: f64, saturation: f64, lightness: f64 },
    Brightness { brightness: f64, contrast: f64 },
    Invert,
}

fn assert_bounds(b: Rect) -> Result<()> {
    if ![b.x, b.y, b.width, b.height, b.x + b.width, b.y + b.height].iter().all(|&v| is_safe_integer(v as f64)) || b.width < 1 || b.height < 1 {
        return fail("errors.drawingPixels.invalidFilterBounds");
    }
    Ok(())
}

/// `pointFilterWork(store, bounds)`: occupied pixels and tile bytes a point filter visits.
pub fn point_filter_work(store: &TileStore, bounds: Rect) -> Result<(i64, i64)> {
    assert_bounds(bounds)?;
    let (mut pixels, mut bytes) = (0i64, 0i64);
    for tile in store.iter() {
        let (x, y) = (tile.tx as i64 * TILE, tile.ty as i64 * TILE);
        let width = (x + TILE).min(bounds.right()) - x.max(bounds.x);
        let height = (y + TILE).min(bounds.bottom()) - y.max(bounds.y);
        if width > 0 && height > 0 {
            pixels += width * height;
            bytes += TILE_BYTES as i64;
        }
    }
    Ok((pixels, bytes))
}

fn hue2rgb(p: f64, q: f64, mut t: f64) -> f64 {
    if t < 0.0 {
        t += 1.0;
    }
    if t > 1.0 {
        t -= 1.0;
    }
    if t < 1.0 / 6.0 {
        p + (q - p) * 6.0 * t
    } else if t < 0.5 {
        q
    } else if t < 2.0 / 3.0 {
        p + (q - p) * (2.0 / 3.0 - t) * 6.0
    } else {
        p
    }
}

#[allow(clippy::too_many_arguments)]
fn filter_hsl_tile(source: &[u8], out: &mut [u8], (x0, y0, x1, y1): (i64, i64, i64, i64), ox: i64, oy: i64, mask: Option<&Mask>, hue: f64, saturation: f64, lightness: f64) {
    for y in y0..y1 {
        for x in x0..x1 {
            let i = ((y * TILE + x) * 4) as usize;
            let w = match mask {
                Some(m) => mask_value(m, x + ox, y + oy),
                None => 1.0,
            };
            if w == 0.0 || w.is_nan() || source[i + 3] == 0 {
                continue;
            }
            let (mut r, mut g, mut b) = (source[i] as f64 / 255.0, source[i + 1] as f64 / 255.0, source[i + 2] as f64 / 255.0);
            let mx = max(max(r, g), b);
            let mn = min(min(r, g), b);
            let l = (mx + mn) / 2.0;
            let (mut h, mut s) = (0.0, 0.0);
            if mx != mn {
                let d = mx - mn;
                s = if l > 0.5 { d / (2.0 - mx - mn) } else { d / (mx + mn) };
                h = (if mx == r {
                    (g - b) / d + if g < b { 6.0 } else { 0.0 }
                } else if mx == g {
                    (b - r) / d + 2.0
                } else {
                    (r - g) / d + 4.0
                }) / 6.0;
            }
            h = ((h + hue / 360.0) % 1.0 + 1.0) % 1.0;
            s = clamp01(s * (1.0 + saturation / 100.0));
            let next_l = clamp01(if lightness >= 0.0 { l + (1.0 - l) * lightness / 100.0 } else { l * (1.0 + lightness / 100.0) });
            if s == 0.0 || s.is_nan() {
                r = next_l * 255.0;
                g = r;
                b = r;
            } else {
                let q = if next_l < 0.5 { next_l * (1.0 + s) } else { next_l + s - next_l * s };
                let p = 2.0 * next_l - q;
                r = hue2rgb(p, q, h + 1.0 / 3.0) * 255.0;
                g = hue2rgb(p, q, h) * 255.0;
                b = hue2rgb(p, q, h - 1.0 / 3.0) * 255.0;
            }
            out[i] = round_u8(source[i] as f64 + (clamp(r, 0.0, 255.0) - source[i] as f64) * w);
            out[i + 1] = round_u8(source[i + 1] as f64 + (clamp(g, 0.0, 255.0) - source[i + 1] as f64) * w);
            out[i + 2] = round_u8(source[i + 2] as f64 + (clamp(b, 0.0, 255.0) - source[i + 2] as f64) * w);
        }
    }
}

/// One horizontal-then-vertical box blur pass over premultiplied RGBA (single precision
/// storage, as the JavaScript's `Float32Array`s).
fn box_blur(src: &[f32], dst: &mut [f32], tmp: &mut [f32], width: usize, height: usize, r: i64) {
    let w = (2 * r + 1) as f64;
    let wi = width as i64;
    let hi = height as i64;
    for y in 0..height {
        let row = y * width;
        for c in 0..4 {
            let mut sum = 0f64;
            for x in -r..=r {
                sum += src[(row + x.clamp(0, wi - 1) as usize) * 4 + c] as f64;
            }
            for x in 0..wi {
                tmp[(row + x as usize) * 4 + c] = (sum / w) as f32;
                sum += src[(row + (x + r + 1).min(wi - 1) as usize) * 4 + c] as f64 - src[(row + (x - r).max(0) as usize) * 4 + c] as f64;
            }
        }
    }
    for x in 0..width {
        for c in 0..4 {
            let mut sum = 0f64;
            for y in -r..=r {
                sum += tmp[(y.clamp(0, hi - 1) as usize * width + x) * 4 + c] as f64;
            }
            for y in 0..hi {
                dst[(y as usize * width + x) * 4 + c] = (sum / w) as f32;
                sum += tmp[((y + r + 1).min(hi - 1) as usize * width + x) * 4 + c] as f64 - tmp[((y - r).max(0) as usize * width + x) * 4 + c] as f64;
            }
        }
    }
}

fn blur_tiles(store: &mut TileStore, bounds: Rect, mask: Option<&Mask>, radius: f64) -> Result<()> {
    if bounds.width * bounds.height > DRAWING_MAX_PIXELS {
        return fail("errors.drawingPixels.invalidFilterBounds");
    }
    let Rect { x: bx, y: by, width, height } = bounds;
    let source = store.read_rect(bx, by, width, height);
    let mut out = source.clone();
    let r = max(1.0, round(clamp(radius, 1.0, 64.0) / 3f64.sqrt())) as i64;
    let n = source.len();
    let mut pre = vec![0f32; n];
    let mut next = vec![0f32; n];
    let mut scratch = vec![0f32; n];
    for i in (0..n).step_by(4) {
        let a = source[i + 3] as f64 / 255.0;
        pre[i] = (source[i] as f64 * a) as f32;
        pre[i + 1] = (source[i + 1] as f64 * a) as f32;
        pre[i + 2] = (source[i + 2] as f64 * a) as f32;
        pre[i + 3] = source[i + 3] as f32;
    }
    let (w, h) = (width as usize, height as usize);
    box_blur(&pre, &mut next, &mut scratch, w, h, r);
    box_blur(&next, &mut pre, &mut scratch, w, h, r);
    box_blur(&pre, &mut next, &mut scratch, w, h, r);
    for y in 0..height {
        for x in 0..width {
            let wv = match mask {
                Some(m) => mask_value(m, x + bx, y + by),
                None => 1.0,
            };
            if wv == 0.0 || wv.is_nan() {
                continue;
            }
            let i = ((y * width + x) * 4) as usize;
            let a = next[i + 3] as f64;
            let blurred = if a > 0.0 { [next[i] as f64 * 255.0 / a, next[i + 1] as f64 * 255.0 / a, next[i + 2] as f64 * 255.0 / a, a] } else { [0.0; 4] };
            for c in 0..4 {
                out[i + c] = round_u8(source[i + c] as f64 + (blurred[c] - source[i + c] as f64) * wv);
            }
        }
    }
    store.write_rect(bx, by, width, height, &out)
}

/// `filterTiles(store, {bounds, kind, mask, …, before})`. Point filters record the
/// original pixels of the tiles they change in `before` (blur's caller captures them).
pub fn filter_tiles(store: &mut TileStore, bounds: Rect, filter: Filter, mask: Option<&Mask>, mut before: Option<&mut Before>) -> Result<()> {
    assert_bounds(bounds)?;
    if let Filter::Blur { radius } = filter {
        return blur_tiles(store, bounds, mask, radius);
    }
    if point_filter_work(store, bounds)?.0 > DRAWING_MAX_PIXELS {
        return fail("errors.drawingPixels.invalidFilterBounds");
    }
    let (brightness_values, brightness_bytes) = match filter {
        Filter::Brightness { brightness, contrast } => {
            let k = clamp(1.0 + contrast / 100.0, 0.0, 4.0);
            let o = brightness * 2.55;
            let values: Vec<f64> = (0..256).map(|value| clamp((value as f64 - 128.0) * k + 128.0 + o, 0.0, 255.0)).collect();
            // A Uint8ClampedArray of Math.round(i + (value - i)).
            let bytes: Option<Vec<u8>> = if mask.is_none() { Some(values.iter().enumerate().map(|(i, &v)| u8c(round(i as f64 + (v - i as f64)))).collect()) } else { None };
            (Some(values), bytes)
        }
        _ => (None, None),
    };
    let keys = store.keys();
    for (tx, ty) in keys {
        let tile = store.get(tx as i64, ty as i64).unwrap();
        let (ox, oy) = (tx as i64 * TILE, ty as i64 * TILE);
        let x0 = (bounds.x - ox).max(0);
        let y0 = (bounds.y - oy).max(0);
        let x1 = (bounds.right() - ox).min(TILE);
        let y1 = (bounds.bottom() - oy).min(TILE);
        if x0 >= x1 || y0 >= y1 {
            continue;
        }
        let source = tile.pixels.clone();
        let mut out: [u8; TILE_BYTES] = *source;
        if mask.is_none() && (filter == Filter::Invert || brightness_bytes.is_some()) {
            for y in y0..y1 {
                let mut i = ((y * TILE + x0) * 4) as usize;
                let end = ((y * TILE + x1) * 4) as usize;
                while i < end {
                    if source[i + 3] != 0 {
                        match &brightness_bytes {
                            Some(table) => {
                                out[i] = table[source[i] as usize];
                                out[i + 1] = table[source[i + 1] as usize];
                                out[i + 2] = table[source[i + 2] as usize];
                            }
                            None => {
                                out[i] = 255 - source[i];
                                out[i + 1] = 255 - source[i + 1];
                                out[i + 2] = 255 - source[i + 2];
                            }
                        }
                    }
                    i += 4;
                }
            }
        } else if let Filter::Hsl { hue, saturation, lightness } = filter {
            filter_hsl_tile(&source[..], &mut out, (x0, y0, x1, y1), ox, oy, mask, hue, saturation, lightness);
        } else {
            for y in y0..y1 {
                for x in x0..x1 {
                    let i = ((y * TILE + x) * 4) as usize;
                    let w = match mask {
                        Some(m) => mask_value(m, x + ox, y + oy),
                        None => 1.0,
                    };
                    if w == 0.0 || w.is_nan() || source[i + 3] == 0 {
                        continue;
                    }
                    let (mut r, mut g, mut b) = (source[i] as f64, source[i + 1] as f64, source[i + 2] as f64);
                    if filter == Filter::Invert {
                        r = 255.0 - r;
                        g = 255.0 - g;
                        b = 255.0 - b;
                    } else {
                        let v = brightness_values.as_ref().unwrap();
                        r = v[r as usize];
                        g = v[g as usize];
                        b = v[b as usize];
                    }
                    out[i] = round_u8(source[i] as f64 + (clamp(r, 0.0, 255.0) - source[i] as f64) * w);
                    out[i + 1] = round_u8(source[i + 1] as f64 + (clamp(g, 0.0, 255.0) - source[i + 1] as f64) * w);
                    out[i + 2] = round_u8(source[i + 2] as f64 + (clamp(b, 0.0, 255.0) - source[i + 2] as f64) * w);
                }
            }
        }
        if out[..] != source[..] {
            if let Some(before) = before.as_deref_mut() {
                if !before.has(tx, ty) {
                    before.set(tx, ty, Some(source.clone()));
                }
            }
            store.adopt(tx as i64, ty as i64, std::sync::Arc::new(out), Alpha::Unknown)?;
        }
    }
    Ok(())
}
