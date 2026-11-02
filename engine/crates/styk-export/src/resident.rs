//! An export of a document with more pages than a few: the sprite layers it needs, not the layout.
//!
//! The layout gives every picture of a document a place on a 4,096² page (`styk_eval::assets`), 64 MiB a page, and a long
//! document has twenty of them. An export used to decode every picture and keep every page on its device for as long as it
//! ran: a first frame that waited for all of them, and a gigabyte or two of GPU memory for a video of any length. Here the
//! export keeps a few layers of the sprite texture ([`KEPT_LAYERS`], [`styk_engine::Residency`]) and asks the engine for a
//! frame's pictures when that frame is the next to draw, and for the pictures of the frames after it ahead of them; the
//! page that was shown longest ago leaves when another is wanted.
//!
//! **A frame is drawn only when every picture it shows is sharp in the texture** ([`Resident::ready`]): an export never
//! draws a soft copy (the soft atlas is not even made), and a frame whose pictures are not in yet waits. A page that
//! has no layer for a frame that needs it makes the texture grow by a layer, so a frame is never drawn short of a picture.
//! A picture the engine could not decode is not waited for, as when the whole layout was decoded.

use std::collections::HashSet;

use styk_draw::DrawList;
use styk_engine::export::ExportFrames;
use styk_engine::{drawing_pages, images_on, pictures_of, Acquired, Generation, PlaceIndex, Residency};
use styk_eval::assets::Assets;

use crate::gpu::GpuExport;

/// Pages of the layout (64 MiB each) the export keeps in the sprite texture besides the drawing cels' pages: the working
/// set of playback measured on tdd2 needed six (docs/engine/memory.md), and a frame that draws from more makes the texture grow.
pub const KEPT_LAYERS: u32 = 8;
/// Ticks after the frame being drawn whose pictures are loaded ahead of it, as many as the export prepares ahead.
const LOOK_AHEAD: u32 = 6;
/// Pixels of pictures uploaded in one call at most (a picture larger than this goes alone).
pub const UPLOAD_BYTES: usize = 32 << 20;

/// Whether an export of a document with this layout keeps pages in layers: it has more than the stage's [`styk_engine::ATLAS_PAGES`].
pub fn wanted(assets: &Assets) -> bool {
    styk_engine::on_demand(assets, styk_engine::ATLAS_PAGES)
}

/// Which pages of the layout are in the sprite texture of an export, and which pictures in them.
pub struct Resident {
    residency: Residency,
    index: PlaceIndex,
    /// Pictures (indices into the document's images) whose pixels are in the texture and in the picture table.
    uploaded: HashSet<u32>,
    /// Pictures asked of the engine and not in yet.
    asked: HashSet<u32>,
    /// Pictures the engine could not decode: not waited for.
    lost: HashSet<u32>,
}

impl Resident {
    /// Lays `gpu`'s sprite texture out for the document `frames` exports: two layers, the drawing cels' pages mapped for good and
    /// the cels asked for. The engine decodes nothing else until a frame needs it.
    pub fn begin(gpu: &mut GpuExport, frames: &ExportFrames) -> Resident {
        let generation = frames.generation().clone();
        let assets = &generation.assets;
        let mut cels: Vec<u32> = drawing_pages(assets).into_iter().collect();
        cels.sort_unstable();
        gpu.prepare_sprites_resident(generation.lineage, assets);
        // The drawing cels' pages stay for good: their layers are made at once, not by a chain of copies as the texture grows.
        if cels.len() as u32 > 0 {
            gpu.grow_sprite_layers(cels.len() as u32 + 2);
        }
        let mut resident = Resident {
            residency: Residency::new(assets.pages, KEPT_LAYERS + cels.len() as u32),
            index: PlaceIndex::new(assets),
            uploaded: HashSet::new(),
            asked: HashSet::new(),
            lost: HashSet::new(),
        };
        for page in cels {
            if let Acquired::Given { layer, evicted } = resident.residency.acquire(page, &[], true) {
                resident.give(gpu, assets, vec![(page, layer, evicted)]);
            }
            resident.residency.pin(page);
        }
        frames.decode_cels();
        resident
    }

    /// Maps the pages the residency just gave layers; the pictures of the pages that left are no longer in.
    fn give(&mut self, gpu: &mut GpuExport, assets: &Assets, given: Vec<(u32, u32, Option<u32>)>) {
        for (page, layer, evicted) in given {
            let have = gpu.sprite_layers();
            if layer >= have {
                // Twice as many (at most what the residency may hold), so a video's working set is a chain of two copies, not of six.
                gpu.grow_sprite_layers((have * 2).min(self.residency.layers()).max(layer + 1));
            }
            if let Some(old) = evicted {
                gpu.map_page(old, None);
                for picture in images_on(assets, old) {
                    gpu.set_picture(&assets.atlas[picture], None);
                    self.uploaded.remove(&(picture as u32));
                    self.asked.remove(&(picture as u32));
                }
            }
            gpu.map_page(page, Some(layer));
        }
        gpu.flush_sprites();
    }

    /// Puts the pictures the engine has decoded since into the texture (a picture whose page left in the meantime is dropped
    /// and asked for again when a frame needs it). Returns the drawing cels still to be decoded, which frames wait for.
    pub fn upload(&mut self, gpu: &mut GpuExport, frames: &ExportFrames, max_bytes: usize) -> usize {
        let generation = frames.generation().clone();
        let assets = &generation.assets;
        let mut any = false;
        for image in frames.take_images(max_bytes) {
            if image.soft {
                continue;
            }
            if image.drawing {
                gpu.upload_images(assets, [&*image]);
                continue;
            }
            let Some(entry) = assets.atlas.get(image.index as usize).filter(|entry| entry.valid) else { continue };
            let Some(layer) = self.residency.layer_of(entry.layer) else {
                self.asked.remove(&image.index);
                continue;
            };
            gpu.upload_images(assets, [&*image]);
            gpu.set_picture(entry, Some(layer));
            self.uploaded.insert(image.index);
            self.asked.remove(&image.index);
            any = true;
        }
        if any {
            gpu.flush_sprites();
        }
        frames.images_left()
    }

    /// Gives the pages of `wanted` layers and asks the engine for the pictures that are not in or on their way. `keep` holds the
    /// pages nothing may take a layer from, and gains the pages of `wanted`. Without `grow`, a page that finds no layer to take ends
    /// the call (false).
    fn load(&mut self, gpu: &mut GpuExport, frames: &ExportFrames, generation: &Generation, wanted: &[u32], keep: &mut Vec<u32>, grow: bool) -> bool {
        let assets = &generation.assets;
        let (mut given, mut request, mut complete) = (Vec::new(), Vec::new(), true);
        for &picture in wanted {
            let Some(entry) = assets.atlas.get(picture as usize).filter(|entry| entry.valid) else { continue };
            if entry.layer >= styk_render::MAX_PAGES {
                self.lost.insert(picture);
                continue;
            }
            if !keep.contains(&entry.layer) {
                keep.push(entry.layer);
            }
            if self.uploaded.contains(&picture) || self.asked.contains(&picture) || self.lost.contains(&picture) {
                continue;
            }
            match self.residency.acquire(entry.layer, keep, grow) {
                Acquired::Resident(_) => {}
                Acquired::Given { layer, evicted } => given.push((entry.layer, layer, evicted)),
                Acquired::Full => {
                    complete = false;
                    break;
                }
            }
            self.asked.insert(picture);
            request.push(picture);
        }
        self.give(gpu, assets, given);
        if !request.is_empty() {
            frames.request_pictures(&request);
        }
        complete
    }

    /// Whether every picture of `list`, the frame about to be drawn, is sharp in the texture. What is missing is asked for (and
    /// given pages, the texture growing if it must); the pictures of the frames after `tick`, up to `last`, are asked for ahead
    /// of them, as far as pages are free or were shown longest ago. The caller waits for the engine's progress and asks again.
    pub fn ready(&mut self, gpu: &mut GpuExport, frames: &ExportFrames, list: &DrawList, tick: Option<u32>, last: u32) -> bool {
        self.upload(gpu, frames, UPLOAD_BYTES);
        let generation = frames.generation().clone();
        let assets = &generation.assets;
        let wanted = pictures_of(list, &self.index);
        let mut pages: Vec<u32> = wanted.iter().filter_map(|&picture| assets.atlas.get(picture as usize).filter(|entry| entry.valid).map(|entry| entry.layer)).collect();
        pages.sort_unstable();
        pages.dedup();
        self.residency.touch(&pages);
        self.residency.hold(&pages);
        let mut keep = pages.clone();
        self.load(gpu, frames, &generation, &wanted, &mut keep, true);
        let missing = |this: &Resident| {
            wanted.iter().any(|picture| assets.atlas.get(*picture as usize).is_some_and(|entry| entry.valid) && !this.uploaded.contains(picture) && !this.lost.contains(picture))
        };
        if missing(self) && frames.pictures_in_flight() == 0 {
            // Asked for, and nothing on its way: the engine could not decode them.
            for &picture in &wanted {
                if self.asked.remove(&picture) {
                    self.lost.insert(picture);
                }
            }
        }
        if let Some(tick) = tick {
            for next in tick + 1..=last.min(tick.saturating_add(LOOK_AHEAD)) {
                let Some(frame) = frames.ready(next) else { break };
                let ahead = pictures_of(&frame.list, &self.index);
                if !self.load(gpu, frames, &generation, &ahead, &mut keep, false) {
                    break;
                }
            }
        }
        !missing(self)
    }

    /// Layers of the sprite texture the export may hold pages in, the pages in it now, the pages given a layer and the pages that left.
    pub fn stats(&self) -> (u32, usize, u64, u64) {
        (self.residency.layers(), self.residency.resident(), self.residency.loads, self.residency.evictions)
    }
}
