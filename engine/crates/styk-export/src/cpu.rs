//! Export frames drawn by the CPU rasterizer (styk-raster), tile by tile: the export path
//! of a worker that has no GPU device. The frames are the GPU renderer's pixels by the
//! app-parity rule (docs/engine/rendering.md, CPU), from the same tiles, views and
//! resolve as [`crate::GpuExport`]; a tile is drawn when asked for, so nothing waits to be
//! read back.

use std::sync::Arc;

use styk_draw::DrawList;
use styk_eval::assets::{Assets, DecodedImage};
use styk_eval::doc::{Camera, Document};
use styk_raster::{Images, Raster};

use crate::pixels::resolve;
use crate::settings::Settings;
use crate::tiles::{tiles, Tile};
use crate::view::tile_view;

/// The largest tile side on the CPU: a tile's targets then hold at most about 8 MiB of
/// pixels (and its layers are cropped to it).
pub const TILE_SIDE: u32 = 1024;
/// Tiles drawn and waiting to be resolved at most.
pub const MAX_SLOTS: usize = 4;

pub struct CpuExport {
    raster: Raster,
    /// The pictures kept are bounded ([`Images`]); with the document's atlas (`use_assets`) a tile decodes again
    /// the ones it samples and the budget dropped.
    images: Images,
    assets: Option<Arc<Assets>>,
    settings: Settings,
    tiles: Vec<Tile>,
    /// Drawn tiles waiting to be resolved: premultiplied RGBA of a tile's size.
    slots: Vec<Vec<u8>>,
    /// The last resolved tile, straight RGBA.
    resolved: Vec<u8>,
}

impl CpuExport {
    /// An exporter of `settings` frames drawing tiles of at most `max_tile` (and
    /// [`TILE_SIDE`]) pixels a side.
    pub fn new(settings: Settings, max_tile: u32) -> CpuExport {
        let tiles = tiles(settings.render_size(), max_tile.clamp(2, TILE_SIDE), settings.smoothing.factor());
        // As many slots as one frame has tiles (within the bound): a worker drawing ahead
        // only while slots are free never draws the next frame before this one is read.
        let slots = vec![Vec::new(); tiles.len().clamp(1, MAX_SLOTS)];
        CpuExport { raster: Raster::new(settings.smoothing.edges()), images: Images::default(), assets: None, settings, tiles, slots, resolved: Vec::new() }
    }

    pub fn settings(&self) -> &Settings {
        &self.settings
    }

    /// Draws later frames in tiles of at most `max_tile` pixels, keeping the pictures.
    pub fn retile(&mut self, max_tile: u32) {
        self.tiles = tiles(self.settings.render_size(), max_tile.clamp(2, TILE_SIDE), self.settings.smoothing.factor());
        self.slots = vec![Vec::new(); self.tiles.len().clamp(1, MAX_SLOTS)];
    }

    pub fn tiles(&self) -> &[Tile] {
        &self.tiles
    }

    pub fn slots(&self) -> usize {
        self.slots.len()
    }

    /// The atlas of the document being exported: from here on a tile decodes again, from the document, a picture it
    /// samples that the budget made the exporter drop, instead of drawing without it.
    pub fn use_assets(&mut self, assets: Arc<Assets>) {
        self.assets = Some(assets);
    }

    /// The document's decoded pictures, shared (not copied).
    pub fn upload_images(&mut self, assets: &Assets, images: impl IntoIterator<Item = Arc<DecodedImage>>) {
        for image in images {
            self.images.add_shared(assets, image);
        }
    }

    /// Draws tile `index` of `list` seen through `camera` into `slot`.
    pub fn draw(&mut self, doc: &Document, list: &DrawList, camera: Option<&Camera>, index: usize, slot: usize) -> Result<(), String> {
        if let Some(assets) = &self.assets {
            self.images.ensure(list, doc, assets).map_err(|error| error.to_string())?;
        }
        self.raster.set_edges(self.settings.smoothing.edges_for(list));
        let tile = self.tiles[index];
        let view = tile_view(doc, camera, &self.settings, &tile);
        self.slots[slot] = self.raster.render(list, &self.images, &view, tile.size).pixels;
        Ok(())
    }

    /// Tile `index`, drawn into `slot`, as output pixels (straight RGBA, `tile.valid / factor`
    /// pixels, rows packed; over black with `matte`); the slot is free again.
    pub fn resolve(&mut self, index: usize, slot: usize, matte: bool) -> Result<&[u8], String> {
        let tile = self.tiles[index];
        let pixels = std::mem::take(&mut self.slots[slot]);
        if pixels.len() < tile.size[0] as usize * tile.size[1] as usize * 4 {
            return Err("draw the tile before resolving it".into());
        }
        resolve(&pixels, tile.size[0] as usize * 4, tile.valid, self.settings.smoothing.factor(), matte, &mut self.resolved);
        Ok(&self.resolved)
    }

    /// Lets go of a drawn tile that will not be read.
    pub fn discard(&mut self, slot: usize) {
        self.slots[slot] = Vec::new();
    }

    /// The whole frame as output pixels (straight RGBA of the output size).
    pub fn frame(&mut self, doc: &Document, list: &DrawList, camera: Option<&Camera>, matte: bool) -> Result<Vec<u8>, String> {
        let (width, factor) = (self.settings.width as usize, self.settings.smoothing.factor());
        let mut out = vec![0u8; width * self.settings.height as usize * 4];
        for index in 0..self.tiles.len() {
            self.draw(doc, list, camera, index, 0)?;
            let tile = self.tiles[index];
            let pixels = self.resolve(index, 0, matte)?;
            crate::gpu::place(&mut out, width, &tile, factor, pixels);
        }
        Ok(out)
    }

    /// What the renderer drew last: layers, effect passes, peak target bytes, glyph masks.
    pub fn stats(&self) -> &styk_raster::Stats {
        &self.raster.stats
    }

    /// Bytes of the pictures held (shared with the engine) and of the drawn tiles waiting.
    pub fn bytes(&self) -> (usize, usize) {
        (self.images.bytes(), self.slots.iter().map(Vec::len).sum())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::Smoothing;

    #[test]
    fn tiles_stay_within_the_cpu_side_and_slots_hold_one_frame() {
        let settings = Settings::new(1920, 1080, Smoothing::Edges, crate::settings::MAX_PIXELS).unwrap();
        let export = CpuExport::new(settings, crate::TILE_SIDE);
        assert!(export.tiles().iter().all(|t| t.size[0] <= TILE_SIDE && t.size[1] <= TILE_SIDE));
        assert_eq!(export.tiles().len(), 4);
        assert_eq!(export.slots(), 4);
        let small = CpuExport::new(Settings::new(320, 180, Smoothing::Edges, crate::settings::MAX_PIXELS).unwrap(), crate::TILE_SIDE);
        assert_eq!((small.tiles().len(), small.slots()), (1, 1));
    }

    #[test]
    fn a_frame_is_its_tiles() {
        // A white artboard and a black stroke across tile edges, drawn whole and in small tiles.
        use styk_draw::{Group, Pass, Prim, K_CAPSULE, K_FILL_VIEW, NO_LAYER, NO_PAINT};
        let prims = vec![
            Prim { kind: K_FILL_VIEW, group: 0, color: 0xffff_ffff, paint: NO_PAINT, a: [0.0; 4], b: [0.0; 4], c: [0.0; 4] },
            Prim { kind: K_CAPSULE, group: 0, color: 0xff00_0000, paint: NO_PAINT, a: [10.0, 10.0, 290.0, 170.0], b: [6.0, 0.0, 0.0, 0.0], c: [0.0; 4] },
        ];
        let list = DrawList { prims, groups: vec![Group { parent: 0, depth: 0, opacity: 1.0, bounds: [0.0; 4], layer: NO_LAYER }], passes: vec![Pass { depth: 0, start: 0, end: 2 }], background_prims: 1, ..Default::default() };
        let doc = Document { canvas: [300, 180], ..Default::default() };
        let settings = Settings::new(300, 180, Smoothing::Edges, crate::settings::MAX_PIXELS).unwrap();
        let whole = CpuExport::new(settings, crate::TILE_SIDE).frame(&doc, &list, None, false).unwrap();
        let mut tiled = CpuExport::new(settings, 64);
        assert!(tiled.tiles().len() > 4);
        assert_eq!(tiled.frame(&doc, &list, None, false).unwrap(), whole, "every pixel as the whole frame draws it");
    }
}
