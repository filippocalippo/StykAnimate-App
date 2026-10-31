//! The stage's pictures for a document whose sprite layout has more pages than the sprite texture keeps
//! (`styk_engine::Residency`, docs/engine/memory.md): the pages a frame shows are given layers, their pictures are
//! decoded again when they left, and a frame whose pictures are not all in waits (the picture on show stays) instead of
//! drawing blank where one is missing.

use std::collections::HashMap;

use styk_engine::{pages_of, Acquired, DecodedImage, Residency};
use styk_eval::drawlist::DrawList;

use super::*;

/// Ticks after the one on show whose prepared frames are looked through for pages to load before playback gets there.
const LOOKAHEAD: u32 = 48;

/// The pages the prepared frames after the one on show draw, by tick, for one generation and cache epoch.
#[derive(Default)]
pub(super) struct Ahead {
    key: (u64, u64),
    pages: HashMap<u32, Vec<u32>>,
}

impl Stage {
    /// Gives each of `wanted` a layer, taking the one of the least recently shown page when none is free, and starts
    /// decoding the pictures of the pages that were given one. Pages in `protect` and the frame on show keep theirs.
    /// With `grow` the sprite texture gets a layer for a page nothing can leave for (the frame about to be drawn); without,
    /// a page that finds none is left out and false is returned.
    fn load_pages(&mut self, generation: &Arc<Generation>, wanted: &[u32], protect: &[u32], grow: bool) -> bool {
        let Some(residency) = self.residency.as_mut() else { return true };
        let mut keep = protect.to_vec();
        keep.extend_from_slice(wanted);
        let mut complete = true;
        let mut given = Vec::new();
        for &page in wanted {
            match residency.acquire(page, &keep, grow) {
                Acquired::Resident(_) => {}
                Acquired::Given { layer, evicted } => given.push((page, layer, evicted)),
                Acquired::Full => complete = false,
            }
        }
        if given.is_empty() {
            return complete;
        }
        let layers = residency.layers();
        if layers > self.renderer.sprite_memory().0 {
            self.renderer.resize_sprite_layers(layers);
            self.atlas_serial += 1;
        }
        for (page, layer, evicted) in given {
            if let Some(old) = evicted {
                self.renderer.map_sprite_page(old, None);
                self.uploaded.forget_page(old);
            }
            self.renderer.map_sprite_page(page, Some(layer));
            self.uploaded.forget_page(page);
            let images = styk_engine::images_on(&generation.assets, page);
            if let Some(residency) = self.residency.as_mut() {
                residency.set_missing(page, images.len() as u32);
            }
            self.engine.decode_images(generation, &images);
        }
        self.renderer.flush_sprite_map();
        complete
    }

    /// Whether the pictures `list` draws are all in the sprite texture, asking for the pages that are not. `None`
    /// until they are (the frame is not drawn: the picture on show stays and [`Stage::pictures_pending`] says what
    /// to wait for); otherwise the pages the list draws. A document that fits the texture has nothing to wait for.
    pub(super) fn pictures_ready(&mut self, generation: &Arc<Generation>, list: &DrawList) -> Option<Vec<u32>> {
        self.residency.as_ref()?;
        let need = pages_of(list);
        // The frame being drawn takes what it needs, from the pages of the frame before it if it must: that picture
        // is on the screen already.
        if let Some(residency) = self.residency.as_mut() {
            residency.hold(&need);
            residency.touch(&need);
        }
        let complete = self.load_pages(generation, &need, &[], true);
        let (decoding, decoded) = self.engine.images_backlog();
        let residency = self.residency.as_mut().expect("checked above");
        let mut ready = complete;
        for &page in &need {
            if !residency.loaded(page) {
                // A picture that cannot be decoded never comes: once nothing is on its way the page is as loaded as it gets.
                if decoding + decoded == 0 && residency.layer_of(page).is_some() {
                    residency.set_missing(page, 0);
                } else {
                    ready = false;
                }
            }
        }
        if ready {
            return Some(need);
        }
        self.pictures = if decoded > 0 { PICTURES_DECODED } else { PICTURES_DECODING };
        None
    }

    /// [`Stage::pictures_ready`] for a view that is not the stage's frame (a thumbnail): it takes layers only from pages
    /// the frame on show does not need, and the texture does not grow for it.
    pub(crate) fn pictures_ready_for_view(&mut self, generation: &Arc<Generation>, list: &DrawList) -> bool {
        if self.residency.is_none() {
            return self.engine.images_pending() == 0;
        }
        let need = pages_of(list);
        if !self.load_pages(generation, &need, &[], false) {
            return false;
        }
        let residency = self.residency.as_mut().expect("checked above");
        residency.touch(&need);
        let (decoding, decoded) = self.engine.images_backlog();
        need.iter().all(|&page| {
            if !residency.loaded(page) && decoding + decoded == 0 && residency.layer_of(page).is_some() {
                residency.set_missing(page, 0);
            }
            residency.loaded(page)
        })
    }

    /// The frame about to be drawn was drawn: its pages are what is on show.
    pub(super) fn pictures_shown(&mut self, pages: Vec<u32>) {
        if let Some(residency) = self.residency.as_mut() {
            residency.hold(&pages);
        }
        self.shown_pages = pages;
    }

    /// Loads the pages of the prepared frames after `tick` (as many as playback prepares ahead) while playback is still
    /// on the one shown, so they are in when it gets there. Pages the frame on show and the frames before them need are
    /// not taken; when none is free the rest wait for the frame that needs them.
    pub(super) fn prefetch_pictures(&mut self, tick: f64) {
        if self.residency.is_none() || !tick.is_finite() {
            return;
        }
        let base = tick.floor();
        let mut protect = self.shown_pages.clone();
        for step in 1..=LOOKAHEAD {
            let time = base + step as f64;
            let Some(snapshot) = self.engine.prepared_frame(time, None) else { continue };
            let key = (snapshot.generation.id, snapshot.epoch);
            if self.ahead.key != key {
                self.ahead = Ahead { key, pages: HashMap::new() };
            }
            let slot = time as u32;
            let pages = self.ahead.pages.entry(slot).or_insert_with(|| pages_of(&snapshot.frame.list)).clone();
            if pages.is_empty() {
                continue;
            }
            let fits = self.load_pages(&snapshot.generation, &pages, &protect, false);
            if let Some(residency) = self.residency.as_mut() {
                residency.touch(&pages);
            }
            protect.extend(pages);
            if !fits {
                break;
            }
        }
        // Frames behind the playhead are not looked at again.
        self.ahead.pages.retain(|&slot, _| slot as f64 > base);
    }

    /// A picture of the document's image `index` was uploaded (or not: the page left while it was decoded).
    pub(super) fn picture_arrived(&mut self, assets: &styk_eval::assets::Assets, image: &DecodedImage) -> bool {
        let page = if image.drawing { None } else { assets.atlas.get(image.index as usize).filter(|entry| entry.valid).map(|entry| entry.layer) };
        if let (Some(residency), Some(page)) = (&self.residency, page)
            && residency.layer_of(page).is_none()
        {
            return false;
        }
        let new = self.uploaded.record(assets, image);
        if new && let (Some(residency), Some(page)) = (self.residency.as_mut(), page) {
            residency.arrived(page);
        }
        true
    }

    /// Images a later revision added to pages that are in the texture are decoded for them.
    fn new_pictures(&mut self, generation: &Arc<Generation>) {
        let Some(residency) = self.residency.as_mut() else { return };
        let count = generation.prepared.doc.images.len();
        let mut added = Vec::new();
        for index in self.residency_images.min(count)..count {
            if let Some(entry) = generation.assets.atlas.get(index).filter(|entry| entry.valid)
                && residency.layer_of(entry.layer).is_some()
            {
                residency.set_missing(entry.layer, residency.missing(entry.layer) + 1);
                added.push(index);
            }
        }
        self.residency_images = count;
        self.engine.decode_images(generation, &added);
    }

    /// Lays the sprite texture out for `generation`'s document when its layout has more pages than the texture keeps
    /// ([`styk_engine::on_demand`]): the drawing cels' pages and the live drawing slots are given layers for good, and
    /// every other page is loaded when a frame needs it. Without such a document the texture is the layout's size.
    pub(super) fn sync_atlas_resident(&mut self, generation: &Arc<Generation>, live_pages: u32) {
        let layout = (generation.lineage, generation.assets.pages);
        let pages = generation.assets.pages;
        if self.atlas_of == Some(layout) && self.residency.is_some() && live_pages <= self.live_pages {
            self.new_pictures(generation);
            return;
        }
        let grew = self.residency.is_some() && self.atlas_of.is_some_and(|(lineage, before)| lineage == layout.0 && before <= pages) && live_pages == 0 && self.live_pages == 0;
        if grew {
            // Pictures are only ever appended: the pages that are in stay where they are.
            if let Some(residency) = self.residency.as_mut() {
                residency.extend(pages);
            }
            self.atlas_of = Some(layout);
            self.new_pictures(generation);
            return;
        }
        if self.residency.is_some() && self.atlas_of == Some(layout) && live_pages > self.live_pages {
            // More live slots: their pages are given layers beside the ones held.
            let base = pages;
            if let Some(residency) = self.residency.as_mut() {
                residency.extend(base + live_pages);
            }
            for page in base + self.live_pages..base + live_pages {
                self.pin_page(generation, page);
            }
            self.live_pages = live_pages;
            self.renderer.flush_sprite_map();
            return;
        }
        // Another project, or a layout that moved the live pages: the texture is allocated again.
        let pinned = styk_engine::drawing_pages(&generation.assets);
        let residency = Residency::new(pages + live_pages, styk_engine::ATLAS_PAGES + pinned.len() as u32 + live_pages);
        self.renderer.prepare_sprites_resident(pages + live_pages, residency.layers());
        self.residency = Some(residency);
        self.residency_images = generation.prepared.doc.images.len();
        self.shown_pages.clear();
        self.ahead = Ahead::default();
        self.live_pages = live_pages;
        self.atlas_serial += 1;
        self.uploaded.clear();
        if self.atlas_of.is_some_and(|(lineage, _)| lineage == layout.0) {
            self.engine.redecode_images();
        }
        self.atlas_of = Some(layout);
        let mut pinned: Vec<u32> = pinned.into_iter().collect();
        pinned.sort_unstable();
        for page in pinned {
            self.pin_page(generation, page);
        }
        for page in pages..pages + live_pages {
            self.pin_page(generation, page);
        }
        self.renderer.flush_sprite_map();
        // The live slots lived in the texture that was replaced.
        let uploads = self.live.uploads();
        self.write_live(&uploads);
    }

    /// Gives `page` a layer for good and starts loading its pictures.
    fn pin_page(&mut self, generation: &Arc<Generation>, page: u32) {
        self.load_pages(generation, &[page], &[], true);
        if let Some(residency) = self.residency.as_mut() {
            residency.pin(page);
        }
    }

    /// Layers the stage's sprite texture keeps pages in, the pages it has in them, the pages loaded and the pages that left.
    pub(super) fn residency_stats(&self) -> (usize, u64, u64) {
        self.residency.as_ref().map_or((0, 0, 0), |residency| (residency.resident(), residency.loads, residency.evictions))
    }
}
