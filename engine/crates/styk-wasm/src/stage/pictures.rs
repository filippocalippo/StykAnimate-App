//! The stage's pictures for a document whose sprite layout has more pages than the sprite texture keeps
//! (`styk_engine::Residency`, docs/engine/memory.md): every picture has a soft copy in the soft atlas, always resident
//! (a few MiB: `styk_eval::assets::soften_image`), so a frame draws at once; the pages a frame shows are given layers,
//! the pictures of a page are decoded and uploaded one at a time when a frame needs them (or, ahead of one, when the
//! document's table of what each tick draws says playback or the person is about to), and the soft copy gives way to
//! the picture in one frame when it lands. A frame whose picture has no soft copy yet (a document just opened) waits:
//! the picture on show stays.

use std::collections::{HashMap, HashSet};

use styk_engine::{Acquired, DecodedImage, PlaceIndex, Residency};
use styk_eval::drawlist::DrawList;

use super::*;

/// What [`Stage::pictures_ready_for_view`] found.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ViewPictures {
    /// Every picture is in the sprite texture (or cannot be had): the view is final.
    Sharp,
    /// Some pictures are drawn from their soft copies and asked for sharp.
    Soft,
    /// A picture has no soft copy yet: nothing to draw it from.
    Wait,
}

/// Ticks after the one playback shows whose pictures are loaded ahead of it.
const PLAY_AHEAD: u32 = 72;
/// Ticks on each side of a tick the person went to (a jump, a drag) whose pictures are loaded.
const HINT_SPAN: u32 = 12;
/// Times a picture the engine could not decode for want of memory is asked for again before the frame stops waiting.
const RETRIES: u8 = 3;

/// What the stage holds of the pictures it asked for.
#[derive(Default)]
pub(super) struct Loading {
    /// Pictures (indices into the document's images) asked of the engine and not uploaded yet, by times asked.
    asked: HashMap<u32, u8>,
    /// Pictures that cannot be decoded: not waited for.
    lost: HashSet<u32>,
    /// What decoding the pictures of the document is mapped to (rebuilt for every revision).
    index: Option<(u64, Arc<PlaceIndex>)>,
    /// The pictures refused for want of memory the last time they were counted.
    refused: usize,
    /// A frame waits for pictures, or is drawn with soft ones: the sharp ones are uploaded as they come, not a slice a frame.
    waiting: bool,
    /// Pictures (indices into the document's images) whose soft copy is in the soft atlas.
    soft: HashSet<u32>,
    /// Pictures the last frame checked that draw soft.
    placeholders: usize,
}

impl Loading {
    /// Whether uploads are not sliced: a frame is waiting for pictures.
    pub(super) fn waiting(&self) -> bool {
        self.waiting
    }

    /// Pictures the last frame checked that draw soft.
    pub(super) fn placeholders(&self) -> usize {
        self.placeholders
    }
}

impl Stage {
    fn place_index(&mut self, generation: &Generation) -> Arc<PlaceIndex> {
        if let Some((id, index)) = &self.loading.index
            && *id == generation.id
        {
            return index.clone();
        }
        let index = Arc::new(PlaceIndex::new(&generation.assets));
        self.loading.index = Some((generation.id, index.clone()));
        index
    }

    /// The pages of `pictures`, ascending.
    fn pages_of_pictures(generation: &Generation, pictures: &[u32]) -> Vec<u32> {
        let mut pages: Vec<u32> = pictures.iter().filter_map(|&picture| generation.assets.atlas.get(picture as usize).filter(|entry| entry.valid).map(|entry| entry.layer)).collect();
        pages.sort_unstable();
        pages.dedup();
        pages
    }

    /// Gives layers to the pages the residency just assigned: the sprite texture grows if it must, the pages that left
    /// lose their pictures (the stage forgets they were uploaded or asked for) and the new ones are mapped.
    fn give_layers(&mut self, generation: &Generation, given: Vec<(u32, u32, Option<u32>)>) {
        let Some(residency) = self.residency.as_ref() else { return };
        let layers = residency.layers();
        if layers > self.renderer.sprite_memory().0 {
            self.renderer.resize_sprite_layers(layers);
            self.atlas_serial += 1;
        }
        for (page, layer, evicted) in given {
            if let Some(old) = evicted {
                self.renderer.map_sprite_page(old, None);
                self.uploaded.forget_page(old);
                // The pictures of that page draw their soft copies from now on.
                for picture in styk_engine::images_on(&generation.assets, old) {
                    self.renderer.set_picture(&generation.assets.atlas[picture], None);
                }
                let on_old = |picture: &u32| generation.assets.atlas.get(*picture as usize).is_some_and(|entry| entry.layer == old);
                self.loading.asked.retain(|picture, _| !on_old(picture));
                self.loading.lost.retain(|picture| !on_old(picture));
                // Rows of a picture of that page still to go would land in whatever the layer holds next.
                if self.partial.as_ref().is_some_and(|(image, _)| !image.drawing && on_old(&image.index)) {
                    self.partial = None;
                }
            }
            self.renderer.map_sprite_page(page, Some(layer));
            self.uploaded.forget_page(page);
        }
        self.renderer.flush_sprite_map();
        self.renderer.flush_pictures();
    }

    /// Asks for the pictures `wanted` (indices into the document's images) that are not in the sprite texture or on
    /// their way: their pages are given layers (the least recently shown page leaves; pages in `protect`, the frame
    /// on show and what was asked for before in this call stay), and the engine decodes them, `urgent` ones ahead of
    /// the queue. With `grow` the texture gets a layer for a page nothing can leave for (the frame about to be drawn);
    /// without, the first picture whose page finds none ends the call and false is returned.
    fn request_pictures(&mut self, generation: &Arc<Generation>, wanted: &[u32], protect: &[u32], grow: bool, urgent: bool) -> bool {
        let Some(residency) = self.residency.as_mut() else { return true };
        let mut keep = protect.to_vec();
        // The frame about to be drawn keeps every page it draws from; what is loaded ahead of it, nearest first, keeps the
        // pages of the pictures before it only, so a page needed sooner may take the layer of one needed later.
        if grow {
            keep.extend(Self::pages_of_pictures(generation, wanted));
        }
        let (mut complete, mut given, mut decode) = (true, Vec::new(), Vec::new());
        for &picture in wanted {
            let Some(entry) = generation.assets.atlas.get(picture as usize).filter(|entry| entry.valid) else { continue };
            if !grow {
                keep.push(entry.layer);
            }
            if self.uploaded.has(entry) || self.loading.asked.contains_key(&picture) || self.loading.lost.contains(&picture) {
                continue;
            }
            if entry.layer >= styk_render::MAX_PAGES {
                // A page the renderer has no row for: nothing of it is drawn.
                self.loading.lost.insert(picture);
                continue;
            }
            match residency.acquire(entry.layer, &keep, grow) {
                Acquired::Resident(_) => {}
                Acquired::Given { layer, evicted } => given.push((entry.layer, layer, evicted)),
                Acquired::Full => {
                    complete = false;
                    if grow {
                        continue;
                    }
                    break;
                }
            }
            decode.push(picture);
        }
        self.give_layers(generation, given);
        for &picture in &decode {
            *self.loading.asked.entry(picture).or_insert(0) += 1;
        }
        let decode: Vec<usize> = decode.into_iter().map(|picture| picture as usize).collect();
        self.engine.decode_images(generation, &decode, urgent);
        complete
    }

    /// Whether the pictures `wanted` can be drawn: each is in the sprite texture or, unless `sharp`, has its soft copy
    /// (`self.loading.placeholders` counts those that draw soft). One that cannot be decoded is not waited for, and one the
    /// engine refused for want of memory is asked for again a few times first.
    fn pictures_in(&mut self, generation: &Generation, wanted: &[u32], sharp: bool) -> bool {
        let (decoding, decoded) = self.engine.images_backlog();
        // A picture being uploaded a few rows a frame is on its way too.
        let decoded = decoded + usize::from(self.partial.is_some());
        let refused = self.engine.pictures_refused();
        let grew = refused != self.loading.refused;
        self.loading.refused = refused;
        let (mut all, mut placeholders) = (true, 0);
        for &picture in wanted {
            let Some(entry) = generation.assets.atlas.get(picture as usize).filter(|entry| entry.valid) else { continue };
            if self.uploaded.has(entry) {
                continue;
            }
            let soft = !sharp && self.loading.soft.contains(&picture);
            if self.loading.lost.contains(&picture) {
                placeholders += usize::from(soft);
                continue;
            }
            if decoding + decoded == 0 && self.loading.asked.contains_key(&picture) {
                if self.loading.asked.get(&picture).is_some_and(|&times| grew && times < RETRIES) {
                    // Nothing is on its way and the engine refused some: it is asked for again.
                    self.loading.asked.remove(&picture);
                } else {
                    self.loading.asked.remove(&picture);
                    self.loading.lost.insert(picture);
                    placeholders += usize::from(soft);
                    continue;
                }
            }
            if soft {
                placeholders += 1;
            } else {
                all = false;
            }
        }
        self.loading.placeholders = placeholders;
        all
    }

    /// Whether the pictures `list` draws are all in the sprite texture, asking for the ones that are not. `None`
    /// until they are (the frame is not drawn: the picture on show stays and [`Stage::pictures_pending`] says what
    /// to wait for); otherwise the pages the list draws. A document that fits the texture has nothing to wait for.
    pub(super) fn pictures_ready(&mut self, generation: &Arc<Generation>, list: &DrawList) -> Option<Vec<u32>> {
        self.residency.as_ref()?;
        let index = self.place_index(generation);
        let wanted = styk_engine::pictures_of(list, &index);
        let pages = Self::pages_of_pictures(generation, &wanted);
        // The frame being drawn takes what it needs, from the pages of the frame before it if it must: that picture
        // is on the screen already.
        if let Some(residency) = self.residency.as_mut() {
            residency.hold(&pages);
            residency.touch(&pages);
        }
        self.request_pictures(generation, &wanted, &[], true, true);
        let ready = self.pictures_in(generation, &wanted, false);
        // Only a frame that cannot be drawn takes every decoded picture whole: the sharp pictures of a frame drawn soft are
        // uploaded a slice a frame, so no frame waits for the upload of a picture that was not asked for by it.
        self.loading.waiting = !ready;
        if ready {
            return Some(pages);
        }
        let (_, decoded) = self.engine.images_backlog();
        let decoded = decoded + usize::from(self.partial.is_some());
        self.pictures = if decoded > 0 { PICTURES_DECODED } else { PICTURES_DECODING };
        None
    }

    /// Asks for the pictures `wanted` of a view that is not the stage's frame (a thumbnail): each page that is not in the
    /// texture takes a layer of the pool the frame on show never holds ([`Residency::acquire_spare`]), which grows by a layer
    /// when the view needs more pages at once than it has, and the engine decodes them behind everything else. The frame on
    /// show and the ticks loaded ahead of it keep their layers.
    fn request_view_pictures(&mut self, generation: &Arc<Generation>, wanted: &[u32]) {
        let Some(residency) = self.residency.as_mut() else { return };
        let keep = Self::pages_of_pictures(generation, wanted);
        let (mut given, mut decode) = (Vec::new(), Vec::new());
        for &picture in wanted {
            let Some(entry) = generation.assets.atlas.get(picture as usize).filter(|entry| entry.valid) else { continue };
            if self.uploaded.has(entry) || self.loading.asked.contains_key(&picture) || self.loading.lost.contains(&picture) {
                continue;
            }
            if entry.layer >= styk_render::MAX_PAGES {
                self.loading.lost.insert(picture);
                continue;
            }
            match residency.acquire_spare(entry.layer, &keep, true) {
                Acquired::Resident(_) => {}
                Acquired::Given { layer, evicted } => given.push((entry.layer, layer, evicted)),
                Acquired::Full => continue,
            }
            decode.push(picture);
        }
        self.give_layers(generation, given);
        for &picture in &decode {
            *self.loading.asked.entry(picture).or_insert(0) += 1;
        }
        let decode: Vec<usize> = decode.into_iter().map(|picture| picture as usize).collect();
        self.engine.decode_images(generation, &decode, false);
    }

    /// [`Stage::pictures_ready`] for a view that is not the stage's frame (a thumbnail). A picture that is not in the sprite
    /// texture is drawn from its soft copy, so a thumbnail is never held up by the pictures of a far tick; the sharp pictures
    /// are asked for in the thumbnails' pool of layers ([`Stage::request_view_pictures`]), so they always come, whatever the
    /// frame on show holds. [`ViewPictures::Soft`] says it was drawn so, and is not the thumbnail that is kept: it is drawn
    /// again until every picture is in.
    pub(crate) fn pictures_ready_for_view(&mut self, generation: &Arc<Generation>, list: &DrawList) -> ViewPictures {
        if self.residency.is_none() {
            return if self.engine.images_pending() == 0 { ViewPictures::Sharp } else { ViewPictures::Wait };
        }
        let index = self.place_index(generation);
        let missing: Vec<u32> = styk_engine::pictures_of(list, &index)
            .into_iter()
            .filter(|&picture| generation.assets.atlas.get(picture as usize).is_some_and(|entry| entry.valid && !self.uploaded.has(entry)))
            .collect();
        if missing.is_empty() {
            return ViewPictures::Sharp;
        }
        self.request_view_pictures(generation, &missing);
        if let Some(residency) = self.residency.as_mut() {
            residency.touch(&Self::pages_of_pictures(generation, &missing));
        }
        if !self.pictures_in(generation, &missing, false) {
            return ViewPictures::Wait;
        }
        // Pictures that cannot be decoded are never sharper than they are.
        if missing.iter().all(|picture| self.loading.lost.contains(picture)) { ViewPictures::Sharp } else { ViewPictures::Soft }
    }

    /// The frame about to be drawn was drawn: its pages are what is on show.
    pub(super) fn pictures_shown(&mut self, pages: Vec<u32>) {
        if let Some(residency) = self.residency.as_mut() {
            residency.hold(&pages);
        }
        self.shown_pages = pages;
    }

    /// Loads the pictures of the ticks `ahead` after `tick` and `behind` before it, nearest first, from the document's
    /// table of what each tick draws (made on the workers when nothing else waits): playback finds them in when it
    /// gets there, and so do the neighbours of a tick the person jumped to. Pages the frame on show needs are not taken;
    /// when no page is free the rest wait for the frame that needs them.
    pub(super) fn prefetch_pictures(&mut self, tick: f64, ahead: u32, behind: u32) {
        if self.residency.is_none() || !tick.is_finite() || tick < 0.0 {
            return;
        }
        let Some(generation) = self.engine.generation() else { return };
        let total = generation.playable_ticks();
        if total == 0 {
            return;
        }
        self.engine.request_picture_table(&generation);
        let base = tick.floor() as i64;
        let mut wanted: Vec<u32> = Vec::new();
        // When each page is next needed: the nearest tick that draws from it.
        let mut uses: HashMap<u32, u32> = HashMap::new();
        for step in 1..=ahead.max(behind) as i64 {
            for (reaches, at) in [(step <= ahead as i64, base + step), (step <= behind as i64, base - step)] {
                if !reaches {
                    continue;
                }
                if let Some(row) = self.engine.picture_row(generation.id, at.rem_euclid(total as i64) as u32) {
                    for picture in Self::pages_of_pictures(&generation, &row) {
                        uses.entry(picture).or_insert(step as u32);
                    }
                    let fresh: Vec<u32> = row.iter().copied().filter(|picture| !wanted.contains(picture)).collect();
                    wanted.extend(fresh);
                }
            }
        }
        if let Some(residency) = self.residency.as_mut() {
            residency.set_next_use(&uses);
        }
        if wanted.is_empty() {
            return;
        }
        let protect = self.shown_pages.clone();
        self.request_pictures(&generation, &wanted, &protect, false, false);
    }

    /// The picture on show is the tick `tick` the person went to: the pictures of the ticks around it are loaded.
    pub(super) fn pictures_near(&mut self, tick: f64) {
        self.prefetch_pictures(tick, HINT_SPAN, HINT_SPAN);
    }

    /// Ticks after the one playback shows whose pictures are loaded ahead of it.
    pub(super) fn pictures_ahead(&mut self, tick: f64) {
        self.prefetch_pictures(tick, PLAY_AHEAD, 0);
    }

    /// Whether the pixels of `image` have a place to go (`styk_engine::has_place`).
    pub(super) fn has_place(&self, assets: &styk_eval::assets::Assets, image: &DecodedImage) -> bool {
        self.residency.as_ref().is_none_or(|residency| styk_engine::has_place(residency, assets, image))
    }

    /// A picture was uploaded (or not: the page left while it was decoded). Whether it was.
    pub(super) fn picture_arrived(&mut self, assets: &styk_eval::assets::Assets, image: &DecodedImage) -> bool {
        if image.soft {
            self.loading.soft.insert(image.index);
            return true;
        }
        if !image.drawing {
            if let (Some(residency), Some(entry)) = (&self.residency, assets.atlas.get(image.index as usize).filter(|entry| entry.valid))
                && residency.layer_of(entry.layer).is_none()
            {
                return false;
            }
            self.loading.asked.remove(&image.index);
        }
        self.uploaded.record(assets, image);
        // The picture is in: its frame draws it, not its soft copy, from the next frame on.
        if let (Some(residency), Some(entry)) = (&self.residency, assets.atlas.get(image.index as usize).filter(|entry| !image.drawing && entry.valid)) {
            self.renderer.set_picture(entry, residency.layer_of(entry.layer));
        }
        true
    }

    /// Lays the sprite texture out for `generation`'s document when its layout has more pages than the texture keeps
    /// ([`styk_engine::on_demand`]): the drawing cels' pages and the live drawing slots are given layers for good, and
    /// every other page is given one when a picture on it is needed. Without such a document the texture is the
    /// layout's size.
    pub(super) fn sync_atlas_resident(&mut self, generation: &Arc<Generation>, live_pages: u32) {
        let layout = (generation.lineage, generation.assets.pages);
        let pages = generation.assets.pages;
        if self.atlas_of == Some(layout) && self.residency.is_some() && live_pages <= self.live_pages {
            return;
        }
        let grew = self.residency.is_some() && self.atlas_of.is_some_and(|(lineage, before)| lineage == layout.0 && before <= pages) && live_pages == 0 && self.live_pages == 0;
        if grew {
            // Pictures are only ever appended: the pages that are in stay where they are.
            if let Some(residency) = self.residency.as_mut() {
                residency.extend(pages);
            }
            self.atlas_of = Some(layout);
            return;
        }
        if self.residency.is_some() && self.atlas_of == Some(layout) && live_pages > self.live_pages {
            // More live slots: their pages are given layers beside the ones held.
            if let Some(residency) = self.residency.as_mut() {
                residency.extend(pages + live_pages);
            }
            for page in pages + self.live_pages..pages + live_pages {
                self.pin_page(generation, page);
            }
            self.live_pages = live_pages;
            return;
        }
        // Another project, or a layout that moved the live pages: the texture is allocated again.
        let pinned = styk_engine::drawing_pages(&generation.assets);
        let residency = Residency::new(pages + live_pages, self.engine.atlas_pages() + pinned.len() as u32 + live_pages);
        self.renderer.prepare_sprites_resident(&generation.assets, live_pages, residency.layers());
        self.residency = Some(residency);
        self.shown_pages.clear();
        self.loading = Loading::default();
        self.live_pages = live_pages;
        self.atlas_serial += 1;
        self.uploaded.clear();
        if self.atlas_of.is_some_and(|(lineage, _)| lineage == layout.0) {
            self.engine.redecode_images();
        }
        self.atlas_of = Some(layout);
        let mut pinned: Vec<u32> = pinned.into_iter().collect();
        pinned.sort_unstable();
        for page in pinned.into_iter().chain(pages..pages + live_pages) {
            self.pin_page(generation, page);
        }
        // The live slots lived in the texture that was replaced.
        self.live.rewrite_all();
        self.flush_live();
    }

    /// Gives `page` a layer for good.
    fn pin_page(&mut self, generation: &Generation, page: u32) {
        let Some(residency) = self.residency.as_mut() else { return };
        if let Acquired::Given { layer, evicted } = residency.acquire(page, &[], true) {
            self.give_layers(generation, vec![(page, layer, evicted)]);
        }
        if let Some(residency) = self.residency.as_mut() {
            residency.pin(page);
        }
    }

    /// Layers the stage's sprite texture keeps pages in, the pages it has in them, the pages loaded and the pages that left.
    pub(super) fn residency_stats(&self) -> (usize, u64, u64) {
        self.residency.as_ref().map_or((0, 0, 0), |residency| (residency.resident(), residency.loads, residency.evictions))
    }
}
