//! An export of a document with more pages than a few: the sprite layers it needs, not the layout.
//!
//! The layout gives every picture and every tile of a drawing cel of a document a place on a 4,096² page
//! (`styk_eval::assets`), 64 MiB a page, and a long document has twenty of them. An export used to decode everything and keep
//! every page on its device for as long as it ran: a first frame that waited for all of it, and a gigabyte or two of GPU memory
//! for a video of any length. Here the export keeps a few layers of the sprite texture ([`KEPT_LAYERS`],
//! [`styk_engine::Residency`]) and asks the engine for what a frame draws when that frame is the next to draw, and for what the
//! frames after it draw ahead of them; the page that was shown longest ago leaves when another is wanted. What a frame draws is
//! its pictures and its drawing cels (a cel is loaded whole, every display level of it, because the shader picks the level and
//! blends in the tile one level up).
//!
//! **A frame is drawn only when everything it shows is sharp in the texture** ([`Resident::ready`]): an export never draws a
//! soft copy (the soft atlas is not even made), and a frame whose pictures or cels are not in yet waits. A page that has no
//! layer for a frame that needs it makes the texture grow by a layer, so a frame is never drawn short of a picture. A picture
//! the engine could not decode is not waited for, as when the whole layout was decoded.

use std::collections::{HashMap, HashSet};

use styk_draw::{DrawList, F_DRAWING, K_IMAGE};
use styk_engine::export::ExportFrames;
use styk_engine::{images_on, pictures_of, Acquired, Generation, PlaceIndex, Residency};
use styk_eval::assets::{Assets, PAGE};

use crate::gpu::GpuExport;

/// Pages of the layout (64 MiB each) the export keeps in the sprite texture: the working set of playback measured on tdd2 needed
/// six (docs/engine/memory.md), and a frame that draws from more makes the texture grow.
pub const KEPT_LAYERS: u32 = 8;
/// Ticks after the frame being drawn whose pictures are loaded ahead of it, as many as the export prepares ahead.
const LOOK_AHEAD: u32 = 6;
/// Pixels of pictures uploaded in one call at most (a picture larger than this goes alone).
pub const UPLOAD_BYTES: usize = 32 << 20;

/// Whether an export of a document with this layout keeps pages in layers: it has more than the stage's [`styk_engine::ATLAS_PAGES`].
pub fn wanted(assets: &Assets) -> bool {
    styk_engine::on_demand(assets, styk_engine::ATLAS_PAGES)
}

/// An atlas place by its page and corner, as a draw-list record names it.
fn place(layer: u32, x: u32, y: u32) -> u64 {
    (layer as u64) << 32 | (y as u64) << 16 | x as u64
}

/// The drawing cels of the document: which cel each tile slot belongs to and which pages a cel's tiles are on.
struct Cels {
    /// The slot of each tile (`Assets::drawing`) by its place.
    slots: HashMap<u64, u32>,
    /// The cel each slot belongs to (`usize::MAX`: none).
    owner: Vec<usize>,
    /// The pages of each cel, ascending.
    pages: HashMap<usize, Vec<u32>>,
    /// The cels with tiles on each page.
    on_page: HashMap<u32, Vec<usize>>,
    /// The slots of each cel's tiles, every level.
    slots_of: HashMap<usize, Vec<u32>>,
}

impl Cels {
    fn new(assets: &Assets) -> Cels {
        let mut cels = Cels { slots: HashMap::new(), owner: vec![usize::MAX; assets.drawing.len()], pages: HashMap::new(), on_page: HashMap::new(), slots_of: HashMap::new() };
        for (index, entry) in assets.drawing.iter().enumerate().filter(|(_, entry)| entry.valid) {
            cels.slots.insert(place(entry.layer, entry.x, entry.y), index as u32);
        }
        for (&cel, (_, tile_slots)) in &assets.cels {
            let mut pages: Vec<u32> = Vec::new();
            let mut slots: Vec<u32> = Vec::new();
            // Every drawn tile has a slot of its own ([`Assets::cel_slots`]).
            for &slot in tile_slots.iter().flatten() {
                if let Some(owner) = cels.owner.get_mut(slot as usize) {
                    *owner = cel;
                }
                slots.push(slot);
                if let Some(entry) = assets.drawing.get(slot as usize).filter(|entry| entry.valid) {
                    pages.push(entry.layer);
                }
            }
            pages.sort_unstable();
            pages.dedup();
            for &page in &pages {
                cels.on_page.entry(page).or_default().push(cel);
            }
            cels.pages.insert(cel, pages);
            cels.slots_of.insert(cel, slots);
        }
        cels
    }

    /// The cels whose tiles `list` draws, ascending.
    fn of(&self, list: &DrawList) -> Vec<usize> {
        let page = PAGE as f32;
        let mut cels: Vec<usize> = Vec::new();
        let mut last = usize::MAX;
        for prim in &list.prims {
            if prim.kind & 255 != K_IMAGE || prim.kind & F_DRAWING == 0 {
                continue;
            }
            let at = place(prim.b[2] as u32, (prim.c[0] * page).round() as u32, (prim.c[1] * page).round() as u32);
            let Some(&slot) = self.slots.get(&at) else { continue };
            let cel = self.owner[slot as usize];
            if cel != usize::MAX && cel != last && !cels.contains(&cel) {
                cels.push(cel);
            }
            last = cel;
        }
        cels.sort_unstable();
        cels
    }
}

/// Which pages of the layout are in the sprite texture of an export, and which pictures and cels in them.
pub struct Resident {
    residency: Residency,
    index: PlaceIndex,
    cels: Cels,
    /// Pictures (indices into the document's images) whose pixels are in the texture and in the picture table.
    uploaded: HashSet<u32>,
    /// Pictures asked of the engine and not in yet.
    asked: HashSet<u32>,
    /// Pictures the engine could not decode: not waited for.
    lost: HashSet<u32>,
    /// Drawing cels with every tile in the texture.
    cels_in: HashSet<usize>,
    /// Drawing cels asked for and not in yet, with the number of the attempt whose result is awaited: a cel that left its layers and was
    /// asked for again has a newer number, and what an older attempt brings (tiles, or a refusal) is let go.
    cels_asked: HashMap<usize, u64>,
    /// The number of the last attempt asked for.
    attempts: u64,
}

impl Resident {
    /// Lays `gpu`'s sprite texture out for the document `frames` exports: two layers, none of the document's pages mapped. The
    /// engine decodes the drawing cels once, for the bounds every frame is made from, and nothing else until a frame needs it.
    pub fn begin(gpu: &mut GpuExport, frames: &ExportFrames) -> Resident {
        Resident::begin_with_layers(gpu, frames, KEPT_LAYERS)
    }

    /// [`Resident::begin`] with a working set of `layers` pages (a smaller one makes pages leave sooner).
    pub fn begin_with_layers(gpu: &mut GpuExport, frames: &ExportFrames, layers: u32) -> Resident {
        let generation = frames.generation().clone();
        let assets = &generation.assets;
        gpu.prepare_sprites_resident(generation.lineage, assets);
        frames.decode_cels();
        Resident {
            residency: Residency::new(assets.pages, layers),
            index: PlaceIndex::new(assets),
            cels: Cels::new(assets),
            uploaded: HashSet::new(),
            asked: HashSet::new(),
            lost: HashSet::new(),
            cels_in: HashSet::new(),
            cels_asked: HashMap::new(),
            attempts: 0,
        }
    }

    /// Maps the pages the residency just gave layers; the pictures and cels of the pages that left are no longer in.
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
                for cel in self.cels.on_page.get(&old).into_iter().flatten() {
                    self.cels_in.remove(cel);
                    self.cels_asked.remove(cel);
                }
            }
            gpu.map_page(page, Some(layer));
        }
        gpu.flush_sprites();
    }

    /// Puts the pictures and cel tiles the engine has decoded since into the texture (what lost its page in the meantime is dropped
    /// and asked for again when a frame needs it). Returns the drawing cels still to be decoded for their bounds, which frames wait
    /// for.
    pub fn upload(&mut self, gpu: &mut GpuExport, frames: &ExportFrames, max_bytes: usize) -> usize {
        let generation = frames.generation().clone();
        let assets = &generation.assets;
        let mut any = false;
        for image in frames.take_images(max_bytes) {
            if image.soft {
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
        for landed in frames.take_landed_cels(max_bytes) {
            // An attempt that is not the one awaited (the cel's pages left their layers since, perhaps to come back and ask again) is
            // let go whole: its tiles are not in the places of the newer attempt, and its refusal is not the newer one's.
            if self.cels_asked.get(&landed.cel) != Some(&landed.attempt) {
                continue;
            }
            self.cels_asked.remove(&landed.cel);
            if landed.images.is_empty() {
                // A cel with tiles that came with none: the engine refused to decode it (the memory could not hold its work). It is not
                // shown, as a picture that cannot be decoded is not, so its places must not show what their layer held before.
                any |= self.clear_cel(gpu, assets, landed.cel);
            } else {
                gpu.upload_images(assets, landed.images.iter().map(|image| &**image));
                any = true;
            }
            self.cels_in.insert(landed.cel);
        }
        if any {
            gpu.flush_sprites();
        }
        frames.images_left()
    }

    /// Writes transparent texels over the places of the tiles of `cel`, whose pages hold what their layers held before. Returns
    /// whether it wrote any.
    fn clear_cel(&mut self, gpu: &mut GpuExport, assets: &Assets, cel: usize) -> bool {
        let slots = self.cels.slots_of.get(&cel).map(Vec::as_slice).unwrap_or_default();
        let side = styk_eval::drawing::TILE + 2 * styk_eval::drawing::BORDER;
        let mut blank = styk_eval::assets::DecodedImage { index: 0, drawing: true, soft: false, width: side, height: side, rgba: vec![0; side as usize * side as usize * 4], placement: 0 };
        for &slot in slots {
            blank.index = slot;
            gpu.upload_images(assets, [&blank]);
        }
        !slots.is_empty()
    }

    /// Gives the pages of `wanted` pictures and `cels` layers and asks the engine for what is not in or on its way. `keep` holds the
    /// pages nothing may take a layer from, and gains the pages of everything wanted. Without `grow`, a page that finds no layer to
    /// take ends the call (false).
    fn load(&mut self, gpu: &mut GpuExport, frames: &ExportFrames, generation: &Generation, wanted: &[u32], cels: &[usize], keep: &mut Vec<u32>, grow: bool) -> bool {
        let assets = &generation.assets;
        let (mut given, mut request, mut request_cels, mut complete) = (Vec::new(), Vec::new(), Vec::<(usize, u64)>::new(), true);
        'pictures: for &picture in wanted {
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
                    break 'pictures;
                }
            }
            self.asked.insert(picture);
            request.push(picture);
        }
        'cels: for &cel in cels {
            if !complete {
                break;
            }
            let pages = self.cels.pages.get(&cel).cloned().unwrap_or_default();
            for &page in &pages {
                if !keep.contains(&page) {
                    keep.push(page);
                }
            }
            if self.cels_in.contains(&cel) || self.cels_asked.contains_key(&cel) {
                continue;
            }
            for &page in &pages {
                if page >= styk_render::MAX_PAGES {
                    continue;
                }
                match self.residency.acquire(page, keep, grow) {
                    Acquired::Resident(_) => {}
                    Acquired::Given { layer, evicted } => given.push((page, layer, evicted)),
                    Acquired::Full => {
                        complete = false;
                        break 'cels;
                    }
                }
            }
            self.attempts += 1;
            self.cels_asked.insert(cel, self.attempts);
            request_cels.push((cel, self.attempts));
        }
        self.give(gpu, assets, given);
        if !request.is_empty() {
            frames.request_pictures(&request);
        }
        if !request_cels.is_empty() {
            frames.request_cels(&request_cels);
        }
        complete
    }

    /// The pages of the pictures and cels a frame draws.
    fn pages_of(&self, assets: &Assets, wanted: &[u32], cels: &[usize]) -> Vec<u32> {
        let mut pages: Vec<u32> = wanted.iter().filter_map(|&picture| assets.atlas.get(picture as usize).filter(|entry| entry.valid).map(|entry| entry.layer)).collect();
        pages.extend(cels.iter().flat_map(|cel| self.cels.pages.get(cel).into_iter().flatten().copied()));
        pages.sort_unstable();
        pages.dedup();
        pages
    }

    /// Whether every picture and cel of `list`, the frame about to be drawn, is sharp in the texture. What is missing is asked for (and
    /// given pages, the texture growing if it must); what the frames after `tick`, up to `last`, draw is asked for ahead of them, as
    /// far as pages are free or were shown longest ago. The caller waits for the engine's progress and asks again.
    pub fn ready(&mut self, gpu: &mut GpuExport, frames: &ExportFrames, list: &DrawList, tick: Option<u32>, last: u32) -> bool {
        self.upload(gpu, frames, UPLOAD_BYTES);
        let generation = frames.generation().clone();
        let assets = &generation.assets;
        let wanted = pictures_of(list, &self.index);
        let cels = self.cels.of(list);
        let pages = self.pages_of(assets, &wanted, &cels);
        self.residency.touch(&pages);
        self.residency.hold(&pages);
        let mut keep = pages.clone();
        self.load(gpu, frames, &generation, &wanted, &cels, &mut keep, true);
        let missing = |this: &Resident| {
            wanted.iter().any(|picture| assets.atlas.get(*picture as usize).is_some_and(|entry| entry.valid) && !this.uploaded.contains(picture) && !this.lost.contains(picture))
                || cels.iter().any(|cel| !this.cels_in.contains(cel))
        };
        if missing(self) && frames.pictures_in_flight() == 0 {
            // Asked for, and nothing on its way: the engine could not decode the pictures.
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
                let ahead_cels = self.cels.of(&frame.list);
                if !self.load(gpu, frames, &generation, &ahead, &ahead_cels, &mut keep, false) {
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
