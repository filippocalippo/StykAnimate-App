//! Drawing cels (v2): a sparse blob of 64×64 PNG tiles in the cel's pixel space
//! (`drawing-tile-codec.mjs`). Tiles stay individually encoded; the renderer
//! uploads them into its image atlas like any other sprite.

use std::sync::Arc;

use crate::doc::ImageData;

pub const TILE: u32 = 64;

/// Returns `(x, y, image)` per tile, pushing each tile's PNG into `images`.
pub fn decode_tiles(bytes: &[u8], images: &mut Vec<ImageData>) -> Option<Vec<(f64, f64, u32)>> {
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
        images.push(ImageData { bytes: Arc::from(&bytes[offset..offset + length]), color_key: None });
        tiles.push((tx as f64 * TILE as f64, ty as f64 * TILE as f64, images.len() as u32 - 1));
        offset += length;
    }
    (offset == bytes.len()).then_some(tiles)
}
