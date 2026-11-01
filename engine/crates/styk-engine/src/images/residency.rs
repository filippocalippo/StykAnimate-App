//! Which pages of a document's sprite layout the stage keeps in its sprite texture.
//!
//! The layout (`styk_eval::assets`) gives every picture a place on a 4,096² page, for the whole document, and the draw
//! lists name those places. A document of more than [`ATLAS_PAGES`] pages does not get a texture of its own size: the
//! stage keeps the pages its frames show in a few layers ([`Residency`]), the least recently shown page leaves when
//! another is wanted. Pictures are loaded one at a time into the layer of their page, decoded from the document's
//! encoded bytes ([`crate::Engine::decode_images`]) when a frame (or, ahead of one, the document's table of what each
//! tick draws, [`crate::Engine::picture_row`]) needs them. The texture is bigger than that only when one frame shows
//! more pages.

use std::collections::HashSet;

use styk_draw::{DrawList, F_DRAWING, K_BG_IMAGE, K_IMAGE};
use styk_eval::assets::{Assets, DecodedImage};

/// Pages of the layout a document may have before its pictures are kept by [`Residency`] instead of all at once: the
/// layers of the sprite texture (the default of [`crate::Engine::atlas_pages`]), 64 MiB each. Measured on tdd2
/// (docs/engine/memory.md): one frame draws from at most 3 of its 20 pages, so 3 layers grow to 4 at once; with the
/// soft copies and the table of what each tick draws, 3 layers show a soft picture in 1 of 241 frames of playback and 6
/// in none, both at the speed of a document held whole.
pub const ATLAS_PAGES: u32 = 4;

/// Whether the pictures of `assets` are kept by [`Residency`]: their layout has more than `budget` pages.
pub fn on_demand(assets: &Assets, budget: u32) -> bool {
    assets.pages > budget
}

/// Which picture of the document an atlas place is: what a frame's records name (a page and the corner of a rectangle)
/// to the index of the image laid out there. Drawing cel tiles are not pictures of the document and are not in it.
#[derive(Default)]
pub struct PlaceIndex {
    pictures: std::collections::HashMap<u64, u32>,
}

impl PlaceIndex {
    pub fn new(assets: &Assets) -> PlaceIndex {
        PlaceIndex { pictures: assets.atlas.iter().enumerate().filter(|(_, entry)| entry.valid).map(|(index, entry)| (super::place(entry.layer, entry.x, entry.y), index as u32)).collect() }
    }
}

/// The pictures (indices into the document's images) `list` draws, in ascending order: its images and backgrounds, not
/// the drawing cels' tiles (their pages stay resident).
pub fn pictures_of(list: &DrawList, index: &PlaceIndex) -> Vec<u32> {
    let mut pictures: Vec<u32> = Vec::new();
    let mut last = u32::MAX;
    for prim in &list.prims {
        let (layer, u, v) = match prim.kind & 255 {
            K_IMAGE if prim.kind & F_DRAWING == 0 => (prim.b[2], prim.c[0], prim.c[1]),
            K_BG_IMAGE => (prim.a[2], prim.c[0], prim.c[1]),
            _ => continue,
        };
        let Some(&picture) = index.pictures.get(&super::record_place(layer, u, v)) else { continue };
        // Records of one picture follow each other: most repeat the one before them.
        if picture != last && !pictures.contains(&picture) {
            pictures.push(picture);
        }
        last = picture;
    }
    pictures.sort_unstable();
    pictures
}

/// The pictures (indices into the document's images) laid out on `page`.
pub fn images_on(assets: &Assets, page: u32) -> Vec<usize> {
    assets.atlas.iter().enumerate().filter(|(_, entry)| entry.valid && entry.layer == page).map(|(index, _)| index).collect()
}

/// Whether the pixels of `image` have a place to go: a soft copy always has one, a drawing cel's tile lies on a page that
/// never leaves, and a picture of the document needs its page to have a layer. Rows of a picture whose page has none
/// are not written: they would be missing from it when the page is given a layer again.
pub fn has_place(residency: &Residency, assets: &Assets, image: &DecodedImage) -> bool {
    if image.soft || image.drawing {
        return true;
    }
    assets.atlas.get(image.index as usize).filter(|entry| entry.valid).is_some_and(|entry| residency.layer_of(entry.layer).is_some())
}

/// The pages that hold drawing cel tiles: they are decoded with the document and never leave.
pub fn drawing_pages(assets: &Assets) -> HashSet<u32> {
    assets.drawing.iter().filter(|entry| entry.valid).map(|entry| entry.layer).collect()
}

#[derive(Clone, Debug)]
struct Page {
    /// The layer of the sprite texture the page is in.
    layer: Option<u32>,
    /// When a frame last showed it.
    used: u64,
    /// Never leaves (drawing cels, live drawing slots).
    pinned: bool,
    /// Ticks from the one on show to the next that draws from it, where the document's table of what each tick draws
    /// says ([`Residency::set_next_use`]); `u32::MAX` for a page nothing near needs.
    next: u32,
}

impl Default for Page {
    fn default() -> Page {
        Page { layer: None, used: 0, pinned: false, next: u32::MAX }
    }
}

/// What [`Residency::acquire`] did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Acquired {
    /// The page already had a layer.
    Resident(u32),
    /// The page was given `layer`, which `evicted` held until now: its pictures are gone from it.
    Given { layer: u32, evicted: Option<u32> },
    /// Every layer is held by a page that may not leave.
    Full,
}

/// The pages of a layout that are in the sprite texture, and in which layer.
#[derive(Debug)]
pub struct Residency {
    /// Layers of the sprite texture.
    layers: u32,
    pages: Vec<Page>,
    free: Vec<u32>,
    clock: u64,
    /// Pages of the frame on show: nothing else's loading takes them.
    hold: Vec<u32>,
    /// Layers kept for the views that are not the frame on show (thumbnails), made when one first needs one: the frame on show
    /// and the ticks loaded ahead of it never take a page's place in them, and views never take a place of theirs
    /// ([`Residency::acquire_spare`]).
    pool: Vec<u32>,
    /// Pages given a layer, and pages that left for another, since the layout was laid out.
    pub loads: u64,
    pub evictions: u64,
}

impl Residency {
    /// A layout of `pages` pages (the live drawing pages included) and a texture of `budget` layers.
    pub fn new(pages: u32, budget: u32) -> Residency {
        Residency { layers: budget, pages: vec![Page::default(); pages as usize], free: (0..budget).rev().collect(), clock: 0, hold: Vec::new(), pool: Vec::new(), loads: 0, evictions: 0 }
    }

    /// Layers the sprite texture needs now (at least two are allocated: the texture is an array, [D11](../../../docs/engine/decisions/0011-array-textures-two-layers.md)).
    pub fn layers(&self) -> u32 {
        self.layers
    }

    /// The layout has `pages` pages now (it only grows: images are appended).
    pub fn extend(&mut self, pages: u32) {
        if self.pages.len() < pages as usize {
            self.pages.resize(pages as usize, Page::default());
        }
    }

    pub fn layer_of(&self, page: u32) -> Option<u32> {
        self.pages.get(page as usize).and_then(|page| page.layer)
    }

    /// How many pages are in the texture.
    pub fn resident(&self) -> usize {
        self.pages.iter().filter(|page| page.layer.is_some()).count()
    }

    /// Tells the residency when each page is next needed, in ticks from the one on show (pages not named are not needed
    /// soon): a page is given the layer of the page whose next use is the farthest, and, of the pages nothing near
    /// needs, of the least recently shown.
    pub fn set_next_use(&mut self, uses: &std::collections::HashMap<u32, u32>) {
        for (index, page) in self.pages.iter_mut().enumerate() {
            page.next = uses.get(&(index as u32)).copied().unwrap_or(u32::MAX);
        }
    }

    /// Stamps `pages` as shown now.
    pub fn touch(&mut self, pages: &[u32]) {
        self.clock += 1;
        for &page in pages {
            if let Some(page) = self.pages.get_mut(page as usize) {
                page.used = self.clock;
            }
        }
    }

    /// The pages of the frame on show.
    pub fn hold(&mut self, pages: &[u32]) {
        self.hold.clear();
        self.hold.extend_from_slice(pages);
    }

    /// Keeps `page` for good once it has a layer.
    pub fn pin(&mut self, page: u32) {
        if let Some(page) = self.pages.get_mut(page as usize) {
            page.pinned = true;
        }
    }

    /// Gives `page` a layer: a free one, else the one of the least recently shown page that is not pinned, held or in
    /// `protect`, else (with `grow`) a new one, which the texture must be given ([`Residency::layers`]).
    pub fn acquire(&mut self, page: u32, protect: &[u32], grow: bool) -> Acquired {
        let Some(slot) = self.pages.get(page as usize) else { return Acquired::Full };
        if let Some(layer) = slot.layer {
            return Acquired::Resident(layer);
        }
        let (layer, evicted) = if let Some(layer) = self.free.pop() {
            (layer, None)
        } else if let Some(victim) = self
            .pages
            .iter()
            .enumerate()
            .filter(|(index, page)| page.layer.is_some_and(|layer| !self.pool.contains(&layer)) && !page.pinned && !protect.contains(&(*index as u32)) && !self.hold.contains(&(*index as u32)))
            .max_by(|(_, a), (_, b)| a.next.cmp(&b.next).then(b.used.cmp(&a.used)))
            .map(|(index, _)| index)
        {
            let layer = self.pages[victim].layer.take().expect("a resident page has a layer");
            self.evictions += 1;
            (layer, Some(victim as u32))
        } else if grow {
            self.layers += 1;
            (self.layers - 1, None)
        } else {
            return Acquired::Full;
        };
        let slot = &mut self.pages[page as usize];
        slot.layer = Some(layer);
        slot.used = self.clock;
        self.loads += 1;
        Acquired::Given { layer, evicted }
    }
}

impl Residency {
    /// Gives `page` a layer of the pool for views that are not the frame on show: a free one, else the one of the least
    /// recently used page that is not in `keep` (the pages of the view being loaded) and not on show, else (with `grow`) a new
    /// one, which the texture must be given ([`Residency::layers`]). A page that is in the texture already, in any layer, is
    /// not moved. The pool only ever has as many layers as the most pages one view needed at once, so it always has room for
    /// the view being loaded, and what the frame on show holds is never touched.
    pub fn acquire_spare(&mut self, page: u32, keep: &[u32], grow: bool) -> Acquired {
        let Some(slot) = self.pages.get(page as usize) else { return Acquired::Full };
        if let Some(layer) = slot.layer {
            return Acquired::Resident(layer);
        }
        let held = |layer: u32| self.pages.iter().position(|page| page.layer == Some(layer)).map(|index| index as u32);
        let choice = self
            .pool
            .iter()
            .map(|&layer| (layer, held(layer)))
            .filter(|(_, held)| held.is_none_or(|held| !keep.contains(&held) && !self.hold.contains(&held) && !self.pages[held as usize].pinned))
            .min_by_key(|(_, held)| held.map_or(0, |held| self.pages[held as usize].used + 1));
        let (layer, evicted) = match choice {
            Some(choice) => choice,
            None if grow => {
                self.layers += 1;
                self.pool.push(self.layers - 1);
                (self.layers - 1, None)
            }
            None => return Acquired::Full,
        };
        if let Some(old) = evicted {
            self.pages[old as usize].layer = None;
            self.evictions += 1;
        }
        let slot = &mut self.pages[page as usize];
        slot.layer = Some(layer);
        slot.used = self.clock;
        self.loads += 1;
        Acquired::Given { layer, evicted }
    }

    /// How many layers the pool has.
    pub fn pool_layers(&self) -> u32 {
        self.pool.len() as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn given(acquired: Acquired) -> (u32, Option<u32>) {
        match acquired {
            Acquired::Given { layer, evicted } => (layer, evicted),
            other => panic!("expected a new layer, got {other:?}"),
        }
    }

    #[test]
    fn pages_take_free_layers_then_the_least_recently_shown_leaves() {
        let mut residency = Residency::new(10, 2);
        assert_eq!(residency.layers(), 2);
        residency.touch(&[0]);
        let first = given(residency.acquire(0, &[], false));
        residency.touch(&[1]);
        let second = given(residency.acquire(1, &[], false));
        assert_eq!((first.1, second.1), (None, None));
        assert_ne!(first.0, second.0);
        assert!(first.0 < 2 && second.0 < 2, "the layers are 0 and 1");
        // Page 0 was shown before page 1: it leaves for page 2, and takes its layer's place.
        residency.touch(&[2]);
        let third = given(residency.acquire(2, &[], false));
        assert_eq!(third, (first.0, Some(0)));
        assert_eq!(residency.layer_of(0), None);
        assert_eq!(residency.layer_of(2), Some(first.0));
        assert_eq!(residency.resident(), 2);
        assert_eq!((residency.loads, residency.evictions), (3, 1));
    }

    #[test]
    fn the_pictures_of_a_list_are_those_its_image_and_background_records_name() {
        use styk_eval::assets::AtlasEntry;
        let mut assets = Assets::default();
        for (layer, x) in [(1, 1), (1, 600), (2, 1), (5, 1)] {
            assets.atlas.push(AtlasEntry { layer, x, y: 1, w: 500, h: 500, source_w: 500, source_h: 500, valid: true });
        }
        let index = PlaceIndex::new(&assets);
        let prim = |kind: u32, entry: usize| {
            let layer = assets.atlas[entry].layer as f32;
            styk_draw::Prim { kind, group: 0, color: 0, paint: 0, a: [0.0, 0.0, layer, 0.0], b: [0.0, 0.0, layer, 0.0], c: assets.atlas[entry].uv() }
        };
        let list = DrawList { prims: vec![prim(K_IMAGE, 3), prim(K_IMAGE, 3), prim(K_BG_IMAGE, 2), prim(K_IMAGE | F_DRAWING, 0), prim(K_IMAGE, 1), prim(0, 0), prim(K_IMAGE, 3)], ..Default::default() };
        assert_eq!(pictures_of(&list, &index), vec![1, 2, 3]);
    }

    #[test]
    fn pixels_of_a_picture_whose_page_has_no_layer_have_no_place() {
        use styk_eval::assets::AtlasEntry;
        let mut assets = Assets::default();
        assets.atlas.push(AtlasEntry { layer: 1, x: 1, y: 1, w: 8, h: 8, source_w: 8, source_h: 8, valid: true });
        let image = |soft: bool, drawing: bool| DecodedImage { index: 0, drawing, soft, width: 10, height: 10, rgba: Vec::new() };
        let mut residency = Residency::new(4, 1);
        assert!(!has_place(&residency, &assets, &image(false, false)), "its page has no layer yet");
        assert!(has_place(&residency, &assets, &image(true, false)), "a soft copy always has a place");
        assert!(has_place(&residency, &assets, &image(false, true)), "a drawing tile's page never leaves");
        given(residency.acquire(1, &[], false));
        assert!(has_place(&residency, &assets, &image(false, false)));
        // Another page takes the only layer: the picture has none again.
        given(residency.acquire(2, &[], false));
        assert!(!has_place(&residency, &assets, &image(false, false)));
    }

    #[test]
    fn the_page_needed_farthest_in_the_future_leaves_first() {
        let mut residency = Residency::new(10, 3);
        for page in 0..3 {
            residency.touch(&[page]);
            given(residency.acquire(page, &[], false));
        }
        // Page 0 was shown longest ago, but it is the next needed; page 2 is needed last; page 1 not at all soon.
        residency.set_next_use(&[(0, 2), (2, 40), (5, 3)].into_iter().collect());
        assert_eq!(given(residency.acquire(5, &[], false)).1, Some(1), "pages nothing near needs go first");
        assert_eq!(given(residency.acquire(6, &[], false)).1, Some(2), "then the one needed last, though it was shown most recently");
        assert_eq!(residency.layer_of(0).is_some() && residency.layer_of(5).is_some(), true, "the pages needed soon stay");
    }

    #[test]
    fn a_live_page_takes_a_layer_when_the_budget_is_full_and_keeps_it() {
        // Four document pages and a live page (page 4); two layers, both held by document pages.
        let mut residency = Residency::new(5, 2);
        residency.touch(&[0]);
        given(residency.acquire(0, &[], false));
        residency.touch(&[1]);
        given(residency.acquire(1, &[], false));
        // The first stroke: the live page is given a layer for good, the document page shown longest ago gives its layer up.
        let (live_layer, evicted) = given(residency.acquire(4, &[], true));
        residency.pin(4);
        assert_eq!(evicted, Some(0));
        assert_eq!(residency.layer_of(0), None);
        // Document pages come and go; the live page never leaves.
        residency.touch(&[2]);
        assert_eq!(given(residency.acquire(2, &[], false)).1, Some(1));
        assert_eq!(residency.acquire(3, &[2], false), Acquired::Full, "nothing may leave: the live page is pinned, the frame needs page 2");
        // A frame that needs both makes the texture grow (once) instead of taking the live page's layer.
        assert_eq!(residency.acquire(3, &[2], true), Acquired::Given { layer: 2, evicted: None });
        assert_eq!(residency.layers(), 3);
        assert_eq!(residency.layer_of(4), Some(live_layer), "the live page kept its layer");
    }

    #[test]
    fn views_that_are_not_the_frame_load_in_a_pool_of_their_own_the_frame_never_takes_from() {
        let mut residency = Residency::new(10, 2);
        for page in 0..2 {
            residency.touch(&[page]);
            given(residency.acquire(page, &[], false));
        }
        // The frame on show holds both layers: nothing is spare, and a view of page 5 gets a layer of its own, once.
        residency.hold(&[0, 1]);
        assert_eq!(residency.acquire(5, &[], false), Acquired::Full);
        let first = given(residency.acquire_spare(5, &[5], true));
        assert_eq!((first.0, first.1, residency.layers(), residency.pool_layers()), (2, None, 3, 1));
        // The next view's page takes that layer: it is not in the pool's keep, so page 5 leaves, and the texture does not grow.
        let second = given(residency.acquire_spare(6, &[6], true));
        assert_eq!((second.0, second.1, residency.layers()), (2, Some(5), 3));
        assert_eq!(residency.layer_of(5), None);
        // A page already in the texture is not moved, whichever layer it is in.
        assert_eq!(residency.acquire_spare(0, &[0], true), Acquired::Resident(residency.layer_of(0).unwrap()));
        // A view of two pages not in the texture needs two layers at once: the pool grows to that and stops.
        given(residency.acquire_spare(7, &[7, 8], true));
        given(residency.acquire_spare(8, &[7, 8], true));
        assert_eq!((residency.layers(), residency.pool_layers()), (4, 2));
        assert_eq!(residency.acquire_spare(9, &[7, 8, 9], false), Acquired::Full, "without growth a view whose layers are all kept is refused");
        // The frame's own loads never take a pool layer, even with nothing else to give.
        residency.hold(&[]);
        assert_eq!(residency.acquire(3, &[0, 1], false), Acquired::Full);
        // Neither does a view take the page of the frame on show, when the frame moves onto one in the pool.
        residency.hold(&[8]);
        given(residency.acquire_spare(9, &[9], true));
        assert!(residency.layer_of(8).is_some(), "the frame holds page 8");
    }

    #[test]
    fn a_page_the_frame_needs_never_leaves() {
        let mut residency = Residency::new(10, 2);
        residency.touch(&[0]);
        given(residency.acquire(0, &[], false));
        residency.touch(&[1]);
        given(residency.acquire(1, &[], false));
        // Page 0 is the older, but the frame needs it: page 1 leaves.
        assert_eq!(given(residency.acquire(2, &[0], false)).1, Some(1));
        // Both layers are protected: nothing leaves, and the texture grows only when it may.
        assert_eq!(residency.acquire(3, &[0, 2], false), Acquired::Full);
        assert_eq!(residency.acquire(3, &[0, 2], true), Acquired::Given { layer: 2, evicted: None });
        assert_eq!(residency.layers(), 3);
    }

    #[test]
    fn pinned_and_held_pages_stay() {
        let mut residency = Residency::new(10, 2);
        given(residency.acquire(0, &[], false));
        residency.pin(0);
        given(residency.acquire(1, &[], false));
        residency.hold(&[1]);
        assert_eq!(residency.acquire(2, &[], false), Acquired::Full);
        residency.hold(&[]);
        assert_eq!(given(residency.acquire(2, &[], false)).1, Some(1));
    }

    #[test]
    fn a_resident_page_is_not_given_another_layer() {
        let mut residency = Residency::new(4, 2);
        let (layer, _) = given(residency.acquire(0, &[], false));
        assert_eq!(residency.acquire(0, &[], false), Acquired::Resident(layer));
        assert_eq!(residency.loads, 1);
    }

    #[test]
    fn the_layout_grows_without_losing_a_layer() {
        let mut residency = Residency::new(2, 2);
        let (layer, _) = given(residency.acquire(1, &[], false));
        residency.extend(5);
        assert_eq!(residency.layer_of(1), Some(layer));
        given(residency.acquire(4, &[], false));
    }
}
