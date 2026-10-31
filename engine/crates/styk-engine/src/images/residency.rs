//! Which pages of a document's sprite layout the stage keeps in its sprite texture.
//!
//! The layout (`styk_eval::assets`) gives every picture a place on a 4,096² page, for the whole document, and the draw
//! lists name those places. A document of more than [`ATLAS_PAGES`] pages does not get a texture of its own size: the
//! stage keeps the pages its frames show in a few layers ([`Residency`]), the least recently shown page leaves when
//! another is wanted, and a page that comes back is decoded again from the document's encoded pictures
//! ([`crate::Engine::decode_images`]). The texture is bigger than that only when one frame shows more pages.

use std::collections::HashSet;

use styk_draw::{DrawList, F_DRAWING, K_BG_IMAGE, K_IMAGE};
use styk_eval::assets::Assets;

/// Pages of the layout a document may have before its pictures are kept by [`Residency`] instead of all at once: the
/// pages the sprite texture holds beside the layer nothing is written to, 384 MiB of video memory. Measured on the
/// private documents (`styk pages`): one frame shows at most 3 pages of a 20 page document and the 48 frames after it
/// 5 on average, so six keep a document playing without loading while a document of 16 pictures of 4K is not
/// held whole.
pub const ATLAS_PAGES: u32 = 6;

/// Whether the pictures of `assets` are kept by [`Residency`]: their layout has more pages than [`ATLAS_PAGES`].
pub fn on_demand(assets: &Assets) -> bool {
    assets.pages > ATLAS_PAGES
}

/// The pages of the layout whose pictures `list` draws (the pictures and backgrounds; the drawing cels' pages stay
/// resident), in ascending order.
pub fn pages_of(list: &DrawList) -> Vec<u32> {
    let mut pages: Vec<u32> = Vec::new();
    let mut last = u32::MAX;
    for prim in &list.prims {
        let page = match prim.kind & 255 {
            K_IMAGE if prim.kind & F_DRAWING == 0 => prim.b[2] as u32,
            K_BG_IMAGE => prim.a[2] as u32,
            _ => continue,
        };
        // Records of one picture follow each other: most repeat the page before them.
        if page != last && !pages.contains(&page) {
            pages.push(page);
        }
        last = page;
    }
    pages.sort_unstable();
    pages
}

/// The pictures (indices into the document's images) laid out on `page`.
pub fn images_on(assets: &Assets, page: u32) -> Vec<usize> {
    assets.atlas.iter().enumerate().filter(|(_, entry)| entry.valid && entry.layer == page).map(|(index, _)| index).collect()
}

/// The pages that hold drawing cel tiles: they are decoded with the document and never leave.
pub fn drawing_pages(assets: &Assets) -> HashSet<u32> {
    assets.drawing.iter().filter(|entry| entry.valid).map(|entry| entry.layer).collect()
}

#[derive(Clone, Debug, Default)]
struct Page {
    /// The layer of the sprite texture the page is in.
    layer: Option<u32>,
    /// When a frame last showed it.
    used: u64,
    /// Never leaves (drawing cels, live drawing slots).
    pinned: bool,
    /// Pictures of the page whose pixels are not in the layer yet.
    missing: u32,
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
    /// Layers of the sprite texture, the empty layer 0 included.
    layers: u32,
    pages: Vec<Page>,
    free: Vec<u32>,
    clock: u64,
    /// Pages of the frame on show: nothing else's loading takes them.
    hold: Vec<u32>,
    /// Pages given a layer, and pages that left for another, since the layout was laid out.
    pub loads: u64,
    pub evictions: u64,
}

impl Residency {
    /// A layout of `pages` pages (the live drawing pages included) and a texture of the empty layer and `budget` more.
    pub fn new(pages: u32, budget: u32) -> Residency {
        Residency { layers: 1 + budget, pages: vec![Page::default(); pages as usize], free: (1..=budget).rev().collect(), clock: 0, hold: Vec::new(), loads: 0, evictions: 0 }
    }

    /// Layers the sprite texture needs now.
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

    /// Pictures of `page` still to be uploaded.
    pub fn missing(&self, page: u32) -> u32 {
        self.pages.get(page as usize).map_or(0, |page| page.missing)
    }

    pub fn set_missing(&mut self, page: u32, count: u32) {
        if let Some(page) = self.pages.get_mut(page as usize) {
            page.missing = count;
        }
    }

    /// A picture of `page` was uploaded.
    pub fn arrived(&mut self, page: u32) {
        if let Some(page) = self.pages.get_mut(page as usize) {
            page.missing = page.missing.saturating_sub(1);
        }
    }

    /// Whether every picture of `page` is in its layer.
    pub fn loaded(&self, page: u32) -> bool {
        self.pages.get(page as usize).is_some_and(|page| page.layer.is_some() && page.missing == 0)
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
            .filter(|(index, page)| page.layer.is_some() && !page.pinned && !protect.contains(&(*index as u32)) && !self.hold.contains(&(*index as u32)))
            .min_by_key(|(_, page)| page.used)
            .map(|(index, _)| index)
        {
            let layer = self.pages[victim].layer.take().expect("a resident page has a layer");
            self.pages[victim].missing = 0;
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
        slot.missing = 0;
        self.loads += 1;
        Acquired::Given { layer, evicted }
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
        assert_eq!(residency.layers(), 3);
        residency.touch(&[0]);
        let first = given(residency.acquire(0, &[], false));
        residency.touch(&[1]);
        let second = given(residency.acquire(1, &[], false));
        assert_eq!((first.1, second.1), (None, None));
        assert_ne!(first.0, second.0);
        assert!(first.0 >= 1 && second.0 >= 1, "layer 0 stays empty");
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
    fn the_pages_of_a_list_are_those_of_its_pictures_and_backgrounds() {
        let prim = |kind: u32, background: f32, image: f32| styk_draw::Prim { kind, group: 0, color: 0, paint: 0, a: [0.0, 0.0, background, 0.0], b: [0.0, 0.0, image, 0.0], c: [0.0; 4] };
        let list = DrawList {
            prims: vec![prim(K_IMAGE, 0.0, 5.0), prim(K_IMAGE, 0.0, 5.0), prim(K_BG_IMAGE, 2.0, 0.0), prim(K_IMAGE | F_DRAWING, 0.0, 9.0), prim(K_IMAGE, 0.0, 1.0), prim(0, 7.0, 7.0), prim(K_IMAGE, 0.0, 5.0)],
            ..Default::default()
        };
        assert_eq!(pages_of(&list), vec![1, 2, 5]);
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
        assert_eq!(residency.acquire(3, &[0, 2], true), Acquired::Given { layer: 3, evicted: None });
        assert_eq!(residency.layers(), 4);
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
    fn a_page_is_loaded_when_its_pictures_have_arrived() {
        let mut residency = Residency::new(4, 2);
        assert!(!residency.loaded(0));
        given(residency.acquire(0, &[], false));
        assert!(residency.loaded(0));
        residency.set_missing(0, 2);
        assert!(!residency.loaded(0));
        residency.arrived(0);
        residency.arrived(0);
        residency.arrived(0);
        assert!(residency.loaded(0));
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
