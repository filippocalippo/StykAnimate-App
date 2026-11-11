//! Rendering a frame in tiles, so the GPU memory of an export does not grow with its size.
//!
//! The renderer's targets (the frame, its four samples a pixel, the isolation atlas pages,
//! depth buffers) are sized by the frame it draws. An export draws its frame as equal tiles
//! of at most [`TILE_SIDE`] pixels, each the same view shifted by whole pixels, so the
//! renderer keeps one set of targets for the whole export and every tile draws the pixels
//! the whole frame would have (layers are cropped to what reaches the tile on the complete
//! layer's grid, see `styk_render::effects::plan`). The last row and column may reach past
//! the frame; those pixels are drawn and dropped.

/// The largest tile side, in rendered pixels: about the editor's own view at 1080p, so an
/// export needs no more GPU memory than the stage.
pub const TILE_SIDE: u32 = 2048;

/// One tile, in rendered pixels: where it starts, the part of it inside the frame, and
/// the size every tile of the export is drawn at.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Tile {
    pub x: u32,
    pub y: u32,
    /// Drawn size (the same for every tile of a frame).
    pub size: [u32; 2],
    /// The part inside the frame: `size` clipped to the frame's edge.
    pub valid: [u32; 2],
}

/// Splits a `render`-sized frame into equal tiles of at most `max_side` pixels, each side a
/// multiple of `factor` so a 2×2 block never straddles two tiles.
pub fn tiles(render: [u32; 2], max_side: u32, factor: u32) -> Vec<Tile> {
    let factor = factor.max(1);
    let max_side = (max_side / factor * factor).max(factor);
    let along = |length: u32| {
        let count = length.div_ceil(max_side).max(1);
        let side = length.div_ceil(count).div_ceil(factor) * factor;
        (count, side)
    };
    let (columns, width) = along(render[0]);
    let (rows, height) = along(render[1]);
    let mut out = Vec::with_capacity((columns * rows) as usize);
    for row in 0..rows {
        for column in 0..columns {
            let (x, y) = (column * width, row * height);
            if x >= render[0] || y >= render[1] {
                continue;
            }
            out.push(Tile { x, y, size: [width, height], valid: [width.min(render[0] - x), height.min(render[1] - y)] });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn covers(render: [u32; 2], tiles: &[Tile]) -> bool {
        let mut seen = vec![0u8; (render[0] * render[1]) as usize];
        for t in tiles {
            for y in t.y..t.y + t.valid[1] {
                for x in t.x..t.x + t.valid[0] {
                    seen[(y * render[0] + x) as usize] += 1;
                }
            }
        }
        seen.iter().all(|&n| n == 1)
    }

    #[test]
    fn a_frame_within_a_tile_is_one_tile() {
        assert_eq!(tiles([1920, 1080], TILE_SIDE, 1), vec![Tile { x: 0, y: 0, size: [1920, 1080], valid: [1920, 1080] }]);
    }

    #[test]
    fn larger_frames_split_into_equal_tiles_that_cover_every_pixel_once() {
        let t = tiles([3840, 2160], TILE_SIDE, 1);
        assert_eq!(t.len(), 4);
        assert!(t.iter().all(|t| t.size == [1920, 1080]));
        assert!(covers([3840, 2160], &t));
        let odd = tiles([4097, 2049], TILE_SIDE, 1);
        assert_eq!(odd.len(), 6, "three columns, two rows");
        assert!(odd.iter().all(|t| t.size == odd[0].size && t.size[0] <= TILE_SIDE && t.size[1] <= TILE_SIDE));
        assert!(covers([4097, 2049], &odd));
    }

    #[test]
    fn supersampled_tiles_keep_whole_blocks() {
        let t = tiles([7680, 4320], TILE_SIDE, 2);
        assert!(t.iter().all(|t| t.x % 2 == 0 && t.y % 2 == 0 && t.size[0] % 2 == 0 && t.size[1] % 2 == 0 && t.valid[0] % 2 == 0 && t.valid[1] % 2 == 0));
        assert!(covers([7680, 4320], &t));
        // A small device limit still gives whole blocks.
        let small = tiles([1282, 722], 511, 2);
        assert!(small.iter().all(|t| t.size[0] <= 510 && t.size[0] % 2 == 0));
        assert!(covers([1282, 722], &small));
    }
}
