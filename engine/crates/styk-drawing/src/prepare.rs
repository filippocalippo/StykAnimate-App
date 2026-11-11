//! Commit preparation in the pixel worker (`materializeDrawingTiles` in
//! drawing-preparation.mjs): replacement tiles expanded from their compact undo sides,
//! with alpha bounds, in batches of at most 1 MiB.

use crate::error::{fail, Result};
use crate::tiles::{Alpha, Pixels, Rect, TileStore, TILE_BYTES};

pub const DRAWING_PREPARATION_BYTES: usize = 1024 * 1024;
const BATCH_TILES: usize = DRAWING_PREPARATION_BYTES / TILE_BYTES;

/// One prepared tile: its pixels and alpha bounds, or `None` when it ends up empty.
#[derive(Clone, Debug)]
pub struct Prepared {
    pub tx: i64,
    pub ty: i64,
    pub pixels: Option<(Pixels, Rect)>,
}

/// `materializeDrawingTiles(input)`: `input` holds absent sides (`None`), four-byte
/// uniform colours and full tiles.
pub fn materialize(input: Vec<(i64, i64, Option<Vec<u8>>)>) -> Result<Vec<Prepared>> {
    if input.len() > BATCH_TILES {
        return fail("errors.drawingPreparation.drawingPreparationBatchIsTooLarge");
    }
    let mut store = TileStore::new();
    let mut out = Vec::with_capacity(input.len());
    for (tx, ty, pixels) in input {
        if let Some(p) = &pixels {
            if p.len() != 4 && p.len() != TILE_BYTES {
                return fail("errors.drawingPreparation.invalidDrawingPreparationPixels");
            }
        }
        match &pixels {
            Some(p) if p.len() == TILE_BYTES => store.adopt(tx, ty, crate::tiles::pixels_from(p), Alpha::Unknown)?,
            _ => store.set(tx, ty, pixels.as_deref())?,
        }
        let visible = store.get(tx, ty).and_then(|t| t.alpha_bounds().map(|b| (t.pixels.clone(), b)));
        out.push(Prepared { tx, ty, pixels: visible });
    }
    Ok(out)
}
