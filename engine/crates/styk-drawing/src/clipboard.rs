//! The pixel clipboard's worker side (`drawing-clipboard.mjs`): version 2 packets carry
//! 64×64 PNG tiles as data URLs with the selection's full affine pose; version 1 (dense
//! PNG) packets remain readable. Indexes are validated before pixels are allocated.

use std::collections::HashSet;

use styk_doc::Value;

use crate::error::{fail, Result};
use crate::js::{is_integer, is_safe_integer};
use crate::png::decode_png;
use crate::tiles::{assert_tile_f64, Tile, TileStore, MAX_TILE, MIN_TILE, TILE, TILE_BYTES};
use crate::transform::inverse_matrix;

const PREFIX: &str = "data:image/png;base64,";
pub const PIXEL_CLIPBOARD_MAX_TILES: usize = 32768;
pub const PIXEL_CLIPBOARD_MAX_CHARACTERS: usize = 128 * 1024 * 1024;
const MAX_TILE_CHARACTERS: usize = 22 + 4 * 65536usize.div_ceil(3);
const SCRATCH_BYTES: f64 = 128.0 * 1024.0;

fn invalid<T>() -> Result<T> {
    fail("errors.drawingClipboard.invalidDrawingPixelClipboard")
}

fn memory<T>() -> Result<T> {
    fail("errors.drawingClipboard.thePixelClipboardExceedsTheDrawingWorkingMemory")
}

fn num(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64)
}

/// The data URL of PNG bytes.
pub fn png_data_url(png: &[u8]) -> String {
    let mut out = PREFIX.as_bytes().to_vec();
    styk_doc::json::base64_into(png, &mut out);
    String::from_utf8(out).unwrap()
}

fn png_bytes(url: &str) -> Result<Vec<u8>> {
    let Some(text) = url.strip_prefix(PREFIX) else { return fail("errors.drawingPng.drawingPixelsNeedAnEmbeddedPng") };
    styk_doc::json::base64_strict(text).ok_or(crate::error::DrawingError::new("errors.drawingPng.corruptPixelData"))
}

/// `validatePixelClipboard(data)`: `(pixel bytes, encoded bytes)`.
pub fn validate(data: &Value) -> Result<(f64, f64)> {
    let Some(o) = data.as_obj() else { return invalid() };
    if !matches!(num(o.get("pixelsPerUnit")), Some(v) if v == 1.0 || v == 2.0 || v == 4.0) {
        return invalid();
    }
    let world = o.get("world").and_then(Value::as_obj);
    if !world.is_some_and(|w| num(w.get("x")).is_some_and(f64::is_finite) && num(w.get("y")).is_some_and(f64::is_finite)) {
        return fail("errors.drawingClipboard.invalidDrawingPixelOrigin");
    }
    let matrix = o.get("matrix").filter(|m| !m.is_null() && !matches!(m, Value::Bool(false)));
    if let Some(m) = matrix {
        inverse_matrix(&matrix_of(m)?)?;
    }
    let version = o.get("version");
    if version.and_then(Value::as_f64) == Some(2.0) {
        let tiles = o.get("tiles").filter(|t| t.is_array());
        let Some(tiles) = tiles else { return invalid() };
        if matrix.is_none() || tiles.array_len().unwrap() > PIXEL_CLIPBOARD_MAX_TILES {
            return invalid();
        }
        let count = tiles.array_len().unwrap();
        let bounds = o.get("bounds");
        let rect = match bounds {
            Some(Value::Null) => {
                if count > 0 {
                    return invalid();
                }
                None
            }
            Some(Value::Obj(b)) => {
                let v = |k: &str| num(b.get(k)).unwrap_or(f64::NAN);
                let (x, y, w, h) = (v("x"), v("y"), v("width"), v("height"));
                let lo = (MIN_TILE * TILE) as f64;
                let hi = ((MAX_TILE + 1) * TILE) as f64;
                if ![x, y, w, h, x + w, y + h].iter().all(|&n| is_safe_integer(n)) || w < 1.0 || h < 1.0 || x < lo || y < lo || x + w > hi || y + h > hi || count == 0 {
                    return invalid();
                }
                Some((x, y, w, h))
            }
            _ => return invalid(),
        };
        let mut characters = 0usize;
        let mut seen = HashSet::new();
        for i in 0..count {
            let Some(Value::Obj(tile)) = tiles.item(i) else { return invalid() };
            let (tx, ty) = (num(tile.get("tx")).unwrap_or(f64::NAN), num(tile.get("ty")).unwrap_or(f64::NAN));
            assert_tile_f64(tx, ty)?;
            if !seen.insert((tx as i64, ty as i64)) {
                return invalid();
            }
            let png = tile.get("png").and_then(Value::text);
            let Some(png) = png else { return invalid() };
            if !png.starts_with(PREFIX) || png.encode_utf16().count() > MAX_TILE_CHARACTERS {
                return invalid();
            }
            characters += png.encode_utf16().count();
            if characters > PIXEL_CLIPBOARD_MAX_CHARACTERS {
                return invalid();
            }
            let (x, y, w, h) = rect.unwrap();
            let (px, py) = (tx * TILE as f64, ty * TILE as f64);
            if px >= x + w || px + TILE as f64 <= x || py >= y + h || py + TILE as f64 <= y {
                return invalid();
            }
        }
        return Ok(((count * TILE_BYTES) as f64, (characters * 2) as f64));
    }
    if version.is_some_and(|v| v.as_f64() != Some(1.0)) {
        return invalid();
    }
    let (w, h) = (num(o.get("width")).unwrap_or(f64::NAN), num(o.get("height")).unwrap_or(f64::NAN));
    let url = o.get("dataUrl").and_then(Value::text);
    let valid_size = |n: f64| is_integer(n) && n > 0.0 && n <= 8192.0;
    match url {
        Some(url) if valid_size(w) && valid_size(h) && w * h <= (16 * 1024 * 1024) as f64 && url.starts_with(PREFIX) && url.encode_utf16().count() <= 96 * 1024 * 1024 => Ok((w * h * 4.0, (url.encode_utf16().count() * 2) as f64)),
        _ => invalid(),
    }
}

fn matrix_of(m: &Value) -> Result<[f64; 6]> {
    let values: Option<Vec<f64>> = m.as_nums().map(|n| n.to_vec()).or_else(|| m.as_arr().map(|a| a.iter().map(|v| v.as_f64().unwrap_or(f64::NAN)).collect()));
    match values {
        Some(v) if v.len() == 6 => Ok([v[0], v[1], v[2], v[3], v[4], v[5]]),
        _ => fail("errors.drawingTransform.invalidDrawingTransform"),
    }
}

/// `decodePixelClipboard(data, {maxBytes})`: the packet's pixels as a tile store and its
/// encoded size.
pub fn decode(data: &Value, max_bytes: f64) -> Result<(TileStore, f64)> {
    let (pixel_bytes, encoded_bytes) = validate(data)?;
    let o = data.as_obj().unwrap();
    let v2 = o.get("version").and_then(Value::as_f64) == Some(2.0);
    let mut store = TileStore::new();
    let count = if v2 { o.get("tiles").and_then(Value::array_len).unwrap_or(0) } else { 0 };
    let concurrency = if v2 { count.min(8) } else { 1 };
    if !max_bytes.is_finite() || pixel_bytes * if v2 { 1.0 } else { 3.0 } + encoded_bytes + SCRATCH_BYTES * concurrency.max(1) as f64 > max_bytes {
        return memory();
    }
    if v2 {
        let tiles = o.get("tiles").unwrap();
        let mut decoded = Vec::with_capacity(count);
        for i in 0..count {
            let Some(Value::Obj(tile)) = tiles.item(i) else { return invalid() };
            let (tx, ty) = (num(tile.get("tx")).unwrap(), num(tile.get("ty")).unwrap());
            let url = tile.get("png").and_then(Value::text).unwrap();
            let image = decode_png(&png_bytes(&url)?, Some((64, 64)))?;
            decoded.push(Tile::new(tx as i32, ty as i32, crate::tiles::pixels_from(&image.pixels)));
        }
        for tile in decoded {
            store.insert(tile);
        }
    } else {
        let w = num(o.get("width")).unwrap() as usize;
        let h = num(o.get("height")).unwrap() as usize;
        let url = o.get("dataUrl").and_then(Value::text).unwrap();
        let image = decode_png(&png_bytes(&url)?, Some((w, h)))?;
        store.write_rect(0, 0, image.width as i64, image.height as i64, &image.pixels)?;
        store.prune();
    }
    Ok((store, encoded_bytes))
}

/// A tile to copy: exact pixels, or the PNG already published for it.
pub enum ClipTile {
    Pixels { tx: f64, ty: f64, pixels: Vec<u8> },
    Png { tx: f64, ty: f64, png: Vec<u8> },
}

/// `encodeClipboardTiles(tiles, {maxBytes})`: `(tx, ty, data URL)` per tile.
pub fn encode_tiles(tiles: &[ClipTile], max_bytes: f64) -> Result<Vec<(i32, i32, String)>> {
    if tiles.len() > PIXEL_CLIPBOARD_MAX_TILES || !max_bytes.is_finite() || max_bytes < 0.0 {
        return invalid();
    }
    let input_bytes: f64 = tiles.iter().map(|t| match t {
        ClipTile::Png { png, .. } => png.len() as f64,
        ClipTile::Pixels { pixels, .. } => pixels.len() as f64,
    }).sum();
    if input_bytes + SCRATCH_BYTES > max_bytes {
        return memory();
    }
    let mut out = Vec::with_capacity(tiles.len());
    let mut seen = HashSet::new();
    let mut characters = 0usize;
    for t in tiles {
        let (tx, ty) = match t {
            ClipTile::Png { tx, ty, .. } | ClipTile::Pixels { tx, ty, .. } => (*tx, *ty),
        };
        assert_tile_f64(tx, ty)?;
        if !seen.insert((tx as i64, ty as i64)) {
            return invalid();
        }
        let png = match t {
            ClipTile::Png { png, .. } => {
                if png.len() > 65536 {
                    return invalid();
                }
                png_data_url(png)
            }
            ClipTile::Pixels { pixels, .. } => {
                if pixels.len() != TILE_BYTES {
                    return invalid();
                }
                png_data_url(&crate::png::encode_rgba_png(pixels, 64, 64))
            }
        };
        characters += png.len();
        if characters > PIXEL_CLIPBOARD_MAX_CHARACTERS {
            return invalid();
        }
        if input_bytes + (characters * 4) as f64 + SCRATCH_BYTES > max_bytes {
            return memory();
        }
        out.push((tx as i32, ty as i32, png));
    }
    Ok(out)
}
