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

/// A fast hasher for tile coordinates. The live cels look tiles up thousands of times per
/// edit, and the standard hasher (SipHash) cost more than the lookups it guards; nothing
/// here needs its resistance to chosen keys.
#[derive(Default, Clone, Copy)]
pub struct CoordHasher(u64);

impl CoordHasher {
    fn add(&mut self, word: u64) {
        self.0 = (self.0.rotate_left(5) ^ word).wrapping_mul(0x517c_c1b7_2722_0a95);
    }
}

impl std::hash::Hasher for CoordHasher {
    fn write(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            self.add(u64::from(byte));
        }
    }

    fn write_i32(&mut self, value: i32) {
        self.add(u64::from(value as u32));
    }

    fn finish(&self) -> u64 {
        // The multiplication leaves its entropy in the high bits; the table indexes with the low ones.
        self.0 ^ (self.0 >> 32)
    }
}

/// The hash state of the maps and sets keyed by tile coordinates.
pub type CoordBuild = std::hash::BuildHasherDefault<CoordHasher>;

/// Texels across the half of a tile a child tile reduces to.
const HALF: usize = TILE as usize / 2;

/// One texel of a reduced tile from the 2×2 block of the tile below that it covers (`a` is the block's upper row of
/// two texels, `b` its lower row): the alpha-weighted mean of the block, rounded half up, with the block's mean alpha.
#[inline]
fn reduce_block(a: &[u8], b: &[u8], texel: &mut [u8]) {
    // Most of a stroke's tile is empty or opaque: an empty block is one comparison.
    if u64::from_le_bytes(a.try_into().expect("eight bytes")) | u64::from_le_bytes(b.try_into().expect("eight bytes")) == 0 {
        texel.fill(0);
        return;
    }
    let pa = a[3] as u32 + a[7] as u32 + b[3] as u32 + b[7] as u32;
    if pa == 0 {
        texel.fill(0);
        return;
    }
    if pa == 4 * 255 {
        // Four opaque texels: (2 * 255 * sum + 1020) / 2040 is (sum + 2) / 4, without the division.
        for c in 0..3 {
            texel[c] = ((a[c] as u32 + a[4 + c] as u32 + b[c] as u32 + b[4 + c] as u32 + 2) / 4) as u8;
        }
        texel[3] = 255;
        return;
    }
    for c in 0..3 {
        let weighted = a[c] as u32 * a[3] as u32 + a[4 + c] as u32 * a[7] as u32 + b[c] as u32 * b[3] as u32 + b[4 + c] as u32 * b[7] as u32;
        texel[c] = ((2 * weighted + pa) / (2 * pa)) as u8;
    }
    texel[3] = ((pa + 2) / 4) as u8;
}

/// The four tiles of the level below that a reduced tile covers, in quadrant order (upper left, upper right, lower left, lower right).
fn children<'a, S: std::hash::BuildHasher>(below: &'a HashMap<(i32, i32), Vec<u8>, S>, tx: i32, ty: i32) -> [Option<&'a Vec<u8>>; 4] {
    [below.get(&(2 * tx, 2 * ty)), below.get(&(2 * tx + 1, 2 * ty)), below.get(&(2 * tx, 2 * ty + 1)), below.get(&(2 * tx + 1, 2 * ty + 1))]
}

/// `downTile`: one level-`n + 1` tile from the four level-`n` tiles below it.
/// Each output texel is the alpha-weighted mean of a 2×2 block, rounded half up,
/// with the block's mean alpha. `None` when none of the four exists.
pub(crate) fn down_tile<S: std::hash::BuildHasher>(below: &HashMap<(i32, i32), Vec<u8>, S>, tx: i32, ty: i32) -> Option<Vec<u8>> {
    let subs = children(below, tx, ty);
    if subs.iter().all(Option::is_none) {
        return None;
    }
    let mut out = vec![0u8; TILE_BYTES];
    let (t, line) = (TILE as usize, TILE as usize * 4);
    for (q, sub) in subs.iter().enumerate() {
        let Some(sub) = sub else { continue };
        let (ox, oy) = ((q & 1) * HALF, (q >> 1) * HALF);
        for py in 0..HALF {
            // Two source rows and the output row as slices: no index below is checked one texel at a time.
            let upper = &sub[2 * py * line..(2 * py + 1) * line];
            let lower = &sub[(2 * py + 1) * line..(2 * py + 2) * line];
            let row = &mut out[((oy + py) * t + ox) * 4..][..HALF * 4];
            for (px, texel) in row.chunks_exact_mut(4).enumerate() {
                reduce_block(&upper[px * 8..px * 8 + 8], &lower[px * 8..px * 8 + 8], texel);
            }
        }
    }
    Some(out)
}

/// The tile [`down_tile`] makes when only the texels of `rect` (`[x0, y0, x1, y1)` of the reduced tile) can differ from `previous`,
/// the reduction before the tiles below changed: the other texels are `previous`'s, the texels of `rect` are made again.
pub(crate) fn down_tile_patch<S: std::hash::BuildHasher>(below: &HashMap<(i32, i32), Vec<u8>, S>, tx: i32, ty: i32, previous: &[u8], rect: [usize; 4]) -> Vec<u8> {
    let subs = children(below, tx, ty);
    let mut out = previous.to_vec();
    let (t, line) = (TILE as usize, TILE as usize * 4);
    for y in rect[1]..rect[3] {
        for x in rect[0]..rect[2] {
            let texel = &mut out[(y * t + x) * 4..][..4];
            match subs[(y / HALF) * 2 + x / HALF] {
                None => texel.fill(0),
                Some(sub) => {
                    let (gx, gy) = (x % HALF, y % HALF);
                    reduce_block(&sub[2 * gy * line + gx * 8..][..8], &sub[(2 * gy + 1) * line + gx * 8..][..8], texel);
                }
            }
        }
    }
    out
}

/// The smallest rectangle `[x0, y0, x1, y1)` of texels outside which two versions of a tile are equal (`None`: a tile that is not
/// there, transparent), or `None` when they are equal.
pub(crate) fn changed_rect(before: Option<&[u8]>, after: Option<&[u8]>) -> Option<[usize; 4]> {
    let (t, line) = (TILE as usize, TILE as usize * 4);
    let zero = [0u8; TILE_BYTES];
    let (before, after) = (before.unwrap_or(&zero), after.unwrap_or(&zero));
    let mut rect: Option<[usize; 4]> = None;
    for y in 0..t {
        let (x, z) = (&before[y * line..(y + 1) * line], &after[y * line..(y + 1) * line]);
        if x == z {
            continue;
        }
        let first = x.iter().zip(z).position(|(p, q)| p != q).expect("the rows differ") / 4;
        let last = x.iter().zip(z).rposition(|(p, q)| p != q).expect("the rows differ") / 4;
        let rect = rect.get_or_insert([first, y, last + 1, y + 1]);
        rect[0] = rect[0].min(first);
        rect[2] = rect[2].max(last + 1);
        rect[3] = y + 1;
    }
    rect
}

/// One drawn tile's slot contents: `(TILE + 2 * BORDER)²` straight-alpha RGBA
/// texels, its own in the middle and its eight neighbours' edges around them.
pub(crate) fn bordered<S: std::hash::BuildHasher>(level: &HashMap<(i32, i32), Vec<u8>, S>, tx: i32, ty: i32) -> Vec<u8> {
    let side = (TILE + 2 * BORDER) as usize;
    let mut out = vec![0u8; side * side * 4];
    bordered_into(level, tx, ty, &mut out, side, 0);
    out
}

/// Writes [`bordered`]'s texels into `out`, a zeroed buffer `stride` texels wide, with the slot's left edge
/// at texel `column` (a run of slots side by side is built in one buffer).
pub(crate) fn bordered_into<S: std::hash::BuildHasher>(level: &HashMap<(i32, i32), Vec<u8>, S>, tx: i32, ty: i32, out: &mut [u8], stride: usize, column: usize) {
    let (t, border) = (TILE as usize, BORDER as usize);
    // Where a neighbour's texels come from and go to along one axis: the far edge of the tile before,
    // all of this one, the near edge of the tile after.
    let span = |d: i32| match d {
        -1 => (t - border, 0, border),
        0 => (0, border, t),
        _ => (0, border + t, border),
    };
    for dy in -1..=1 {
        for dx in -1..=1 {
            let Some(pixels) = level.get(&(tx + dx, ty + dy)) else { continue };
            let ((sx, ox, width), (sy, oy, height)) = (span(dx), span(dy));
            for row in 0..height {
                let from = ((sy + row) * t + sx) * 4;
                let to = ((oy + row) * stride + column + ox) * 4;
                out[to..to + width * 4].copy_from_slice(&pixels[from..from + width * 4]);
            }
        }
    }
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
