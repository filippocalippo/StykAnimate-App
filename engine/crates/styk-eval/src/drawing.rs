//! Drawing cels (v2): a sparse blob of 64×64 PNG tiles in the cel's pixel space
//! (`drawing-tile-codec.mjs`), drawn the way the editor's JavaScript drawing display drew them
//! (docs/engine/drawing.md):
//!
//! * reduced levels 1–8 are exact integer box reductions of the level below
//!   (`downTile` in `drawing-raster.mjs`);
//! * a frame shows each cel at one level, `floor(-log2(screen pixels per cel
//!   pixel))` clamped to 0–8 (chosen by the shader, so draw lists stay view
//!   independent);
//! * texels are straight alpha; the shader premultiplies them and filters
//!   bilinearly across tile borders, and every empty tile next to an occupied
//!   one is drawn too (a halo), so filtering fades past the last tile.
//!
//! Each drawn tile is one atlas slot of 64×64 texels plus a two-texel border
//! holding its neighbours' edge texels (transparent where there is none). The
//! second texel lets Canvas-style Mitchell enlargement read across tile edges.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use crate::doc::DrawingTiles;

pub const TILE: u32 = 64;
/// Neighbour texels on each side of a drawn tile (the radius of Mitchell filtering).
pub const BORDER: u32 = 2;
pub const TILE_BYTES: usize = (TILE * TILE * 4) as usize;
/// Display levels 0..=MAX_LEVEL.
pub const MAX_LEVEL: u32 = 8;

/// Parses a tile blob: the cel's level-0 tiles as `(tx, ty, PNG bytes)`, in tile
/// coordinates. `None` when the blob is not a version 1 blob of 64-pixel tiles.
pub fn parse_tiles(bytes: &[u8]) -> Option<Vec<(i32, i32, Arc<[u8]>)>> {
    if bytes.len() < 16 || u32::from_be_bytes(bytes[0..4].try_into().ok()?) != 0x5459_5453 {
        return None;
    }
    let le = |o: usize| u32::from_le_bytes(bytes[o..o + 4].try_into().unwrap());
    if le(4) != 1 || le(8) != TILE {
        return None;
    }
    let count = le(12) as usize;
    let mut offset = 16;
    let mut tiles = Vec::with_capacity(count);
    for _ in 0..count {
        if offset + 12 > bytes.len() {
            return None;
        }
        let tx = le(offset) as i32;
        let ty = le(offset + 4) as i32;
        let length = le(offset + 8) as usize;
        offset += 12;
        if offset + length > bytes.len() {
            return None;
        }
        tiles.push((tx, ty, Arc::from(&bytes[offset..offset + length])));
        offset += length;
    }
    (offset == bytes.len()).then_some(tiles)
}

/// The tiles drawn at each display level: the cel's tiles reduced `2^level`
/// times (`levelStore` coverage), and every tile around one of them (the halo).
pub fn level_tiles(tiles: &[(i32, i32, Arc<[u8]>)]) -> Vec<Vec<(i32, i32)>> {
    (0..=MAX_LEVEL)
        .map(|level| {
            let span = 1i32 << level;
            let covered: HashSet<(i32, i32)> = tiles.iter().map(|&(tx, ty, _)| (tx.div_euclid(span), ty.div_euclid(span))).collect();
            let mut drawn: Vec<(i32, i32)> =
                covered.iter().flat_map(|&(x, y)| (-1..=1).flat_map(move |dy| (-1..=1).map(move |dx| (x + dx, y + dy)))).collect::<HashSet<_>>().into_iter().collect();
            drawn.sort_unstable_by_key(|&(x, y)| (y, x));
            drawn
        })
        .collect()
}

/// `downTile`: one level-`n + 1` tile from the four level-`n` tiles below it.
/// Each output texel is the alpha-weighted mean of a 2×2 block, rounded half up,
/// with the block's mean alpha. `None` when none of the four exists.
pub(crate) fn down_tile(below: &HashMap<(i32, i32), Vec<u8>>, tx: i32, ty: i32) -> Option<Vec<u8>> {
    let subs = [below.get(&(2 * tx, 2 * ty)), below.get(&(2 * tx + 1, 2 * ty)), below.get(&(2 * tx, 2 * ty + 1)), below.get(&(2 * tx + 1, 2 * ty + 1))];
    if subs.iter().all(Option::is_none) {
        return None;
    }
    let mut out = vec![0u8; TILE_BYTES];
    let (t, h) = (TILE as usize, TILE as usize / 2);
    for (q, sub) in subs.iter().enumerate() {
        let Some(sub) = sub else { continue };
        let (ox, oy) = ((q & 1) * h, (q >> 1) * h);
        for py in 0..h {
            for px in 0..h {
                let i = ((2 * py) * t + 2 * px) * 4;
                let j = i + t * 4;
                let texels = [i, i + 4, j, j + 4];
                let pa: u32 = texels.iter().map(|&k| sub[k + 3] as u32).sum();
                if pa == 0 {
                    continue;
                }
                let o = ((oy + py) * t + ox + px) * 4;
                for c in 0..3 {
                    let weighted: u32 = texels.iter().map(|&k| sub[k + c] as u32 * sub[k + 3] as u32).sum();
                    out[o + c] = ((2 * weighted + pa) / (2 * pa)) as u8;
                }
                out[o + 3] = ((pa + 2) / 4) as u8;
            }
        }
    }
    Some(out)
}

/// One drawn tile's slot contents: `(TILE + 2 * BORDER)²` straight-alpha RGBA
/// texels, its own in the middle and its eight neighbours' edges around them.
pub(crate) fn bordered(level: &HashMap<(i32, i32), Vec<u8>>, tx: i32, ty: i32) -> Vec<u8> {
    let t = TILE as i32;
    let border = BORDER as i32;
    let side = (t + 2 * border) as usize;
    let mut out = vec![0u8; side * side * 4];
    for dy in -1..=1 {
        for dx in -1..=1 {
            let Some(pixels) = level.get(&(tx + dx, ty + dy)) else { continue };
            // All of this tile, two edge rows/columns of a neighbour, or their corner.
            let xs: Vec<i32> = match dx {
                -1 => (t - border..t).collect(),
                0 => (0..t).collect(),
                _ => (0..border).collect(),
            };
            let ys: Vec<i32> = match dy {
                -1 => (t - border..t).collect(),
                0 => (0..t).collect(),
                _ => (0..border).collect(),
            };
            for &sy in &ys {
                let oy = (sy + dy * t + border) as usize;
                for &sx in &xs {
                    let ox = (sx + dx * t + border) as usize;
                    let s = ((sy * t + sx) * 4) as usize;
                    let o = (oy * side + ox) * 4;
                    out[o..o + 4].copy_from_slice(&pixels[s..s + 4]);
                }
            }
        }
    }
    out
}

/// Decodes a cel and builds every drawn tile at every level, in the order of
/// [`level_tiles`]: `(level, index within the level, slot pixels)`. Tiles that
/// fail to decode are left out (they draw transparent, as an undecodable tile
/// does in the editor).
pub fn decode_cel(cel: &DrawingTiles) -> Vec<(u32, u32, Vec<u8>)> {
    let mut level: HashMap<(i32, i32), Vec<u8>> = HashMap::with_capacity(cel.tiles.len());
    for (tx, ty, png) in &cel.tiles {
        let Ok(image) = image::load_from_memory(png) else { continue };
        let rgba = image.to_rgba8();
        if rgba.width() == TILE && rgba.height() == TILE {
            level.insert((*tx, *ty), rgba.into_raw());
        }
    }
    // This runs beside PNG decoding on the existing resource workers. Keep only
    // the derived rectangle, shared by revisions that reuse this immutable cel.
    let mut bounds = [i64::MAX, i64::MAX, i64::MIN, i64::MIN];
    for (&(tx, ty), rgba) in &level {
        if let Some(alpha) = styk_drawing::tiles::alpha_bounds(rgba) {
            let x = tx as i64 * TILE as i64 + alpha.x;
            let y = ty as i64 * TILE as i64 + alpha.y;
            bounds[0] = bounds[0].min(x);
            bounds[1] = bounds[1].min(y);
            bounds[2] = bounds[2].max(x + alpha.width);
            bounds[3] = bounds[3].max(y + alpha.height);
        }
    }
    let alpha = (bounds[0] != i64::MAX).then(|| [bounds[0] as f64, bounds[1] as f64, (bounds[2] - bounds[0]) as f64, (bounds[3] - bounds[1]) as f64]);
    let _ = cel.decoded_bounds.set(alpha);
    let mut out = Vec::new();
    for (n, drawn) in cel.levels.iter().enumerate() {
        if n > 0 {
            let reduced: HashMap<(i32, i32), Vec<u8>> = cel.levels[n]
                .iter()
                .filter_map(|&(tx, ty)| down_tile(&level, tx, ty).filter(|tile| tile.chunks_exact(4).any(|texel| texel[3] != 0)).map(|tile| ((tx, ty), tile)))
                .collect();
            level = reduced;
        }
        for (index, &(tx, ty)) in drawn.iter().enumerate() {
            out.push((n as u32, index as u32, bordered(&level, tx, ty)));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tile(f: impl Fn(usize, usize) -> [u8; 4]) -> Vec<u8> {
        (0..TILE as usize * TILE as usize).flat_map(|i| f(i % TILE as usize, i / TILE as usize)).collect()
    }

    #[test]
    fn reduction_is_the_alpha_weighted_mean_rounded_half_up() {
        // One opaque red texel and one half-transparent blue texel in a 2×2 block.
        let mut sub = vec![0u8; TILE_BYTES];
        sub[0..4].copy_from_slice(&[255, 0, 0, 255]);
        sub[4..8].copy_from_slice(&[0, 0, 255, 128]);
        let below = HashMap::from([((0, 0), sub)]);
        let out = down_tile(&below, 0, 0).expect("a reduced tile");
        // pa = 383; red = (2·255·255 + 383) / 766 = 170, blue = (2·255·128 + 383) / 766 = 85, alpha = (383 + 2) / 4 = 96.
        assert_eq!(&out[0..4], &[170, 0, 85, 96]);
        assert!(down_tile(&below, 5, 5).is_none());
    }

    #[test]
    fn halos_surround_every_level() {
        let tiles = vec![(0, 0, Arc::from(&[][..])), (5, 0, Arc::from(&[][..]))];
        let levels = level_tiles(&tiles);
        assert_eq!(levels.len(), MAX_LEVEL as usize + 1);
        assert_eq!(levels[0].len(), 18, "two separate tiles, each with eight neighbours");
        // At level 3 both fall in tile (0, 0): one tile and its halo.
        assert_eq!(levels[3].len(), 9);
        assert!(levels[3].contains(&(-1, -1)) && levels[3].contains(&(1, 1)));
    }

    #[test]
    fn a_slot_borders_its_tile_with_its_neighbours_edges() {
        let left = tile(|x, _| [x as u8, 0, 0, 255]);
        let middle = tile(|_, y| [0, y as u8, 0, 255]);
        let level = HashMap::from([((-1, 0), left), ((0, 0), middle)]);
        let slot = bordered(&level, 0, 0);
        let side = (TILE + 2 * BORDER) as usize;
        let at = |x: usize, y: usize| &slot[(y * side + x) * 4..(y * side + x) * 4 + 4];
        assert_eq!(at(0, 10), &[62, 0, 0, 255], "the border holds the second-last neighbour column");
        assert_eq!(at(1, 10), &[63, 0, 0, 255], "and the last column, without repeating it");
        assert_eq!(at(2, 10), &[0, 8, 0, 255], "the tile itself, shifted by the border");
        assert_eq!(at(66, 10), &[0, 0, 0, 0], "no right neighbour: transparent");
        assert_eq!(at(0, 0), &[0, 0, 0, 0], "no upper-left neighbour: transparent");
    }

    #[test]
    fn a_border_reads_real_neighbours_across_negative_tile_edges_and_corners() {
        // Unique values in a 3×3 neighborhood make an off-by-one, repeated edge or wrong
        // negative-coordinate neighbour visible, including both rows/columns at corners.
        let level: HashMap<_, _> = (-2..=0).flat_map(|ty| (-2..=0).map(move |tx| {
            ((tx, ty), tile(|x, y| [((tx + 2) * 64 + x as i32) as u8, ((ty + 2) * 64 + y as i32) as u8, 120, 255]))
        })).collect();
        let slot = bordered(&level, -1, -1);
        let side = (TILE + 2 * BORDER) as usize;
        for y in 0..side {
            for x in 0..side {
                let i = (y * side + x) * 4;
                assert_eq!(&slot[i..i + 4], &[62 + x as u8, 62 + y as u8, 120, 255], "slot ({x}, {y})");
            }
        }
    }
}
