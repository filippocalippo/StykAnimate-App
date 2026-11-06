//! Isolation layers: translucent figures, outlines and onion skins render into
//! a layer atlas, one pass per nesting depth (ping-ponging between two
//! atlases), then composite into their parent. When a frame's layers do not fit
//! the atlas they are drawn in rounds, each at full resolution.

use styk_draw::DrawList;

use crate::effects::Slot;
use crate::resources::array_texture;
use crate::{Renderer, MAX_LAYER_PAGES};

pub(crate) struct LayerAtlas {
    pub(crate) texture: wgpu::Texture,
    pub(crate) view: wgpu::TextureView,
    pub(crate) size: [u32; 2],
    pub(crate) pages: u32,
}

/// Shelf packer for isolation layers inside fixed-size pages.
#[derive(Clone, Copy)]
pub(crate) struct Shelf {
    pub(crate) size: [u32; 2],
    pub(crate) page: u32,
    pub(crate) x: u32,
    pub(crate) y: u32,
    pub(crate) row: u32,
}

impl Shelf {
    pub(crate) fn place(&mut self, w: u32, h: u32, max_pages: u32) -> Option<(u32, u32, u32)> {
        if w > self.size[0] || h > self.size[1] {
            return None;
        }
        if self.x + w > self.size[0] {
            self.x = 0;
            self.y += self.row;
            self.row = 0;
        }
        if self.y + h > self.size[1] {
            self.page += 1;
            self.x = 0;
            self.y = 0;
            self.row = 0;
        }
        if self.page >= max_pages {
            return None;
        }
        let at = (self.page, self.x, self.y);
        self.x += w;
        self.row = self.row.max(h);
        Some(at)
    }
}

/// One round of isolation layers: a run of the frame's top-level groups, with
/// everything nested in them, placed in the atlases together.
pub(crate) struct Round {
    /// Group ids `first..end`: the run and its descendants (ids are given depth first).
    pub first: usize,
    pub end: usize,
    pub pages_per_depth: Vec<u32>,
    /// Where each drawn group of the round lands.
    pub placed: Vec<(usize, Slot)>,
    /// The run is a single group whose layers did not fit at full resolution.
    pub downscaled: bool,
}

/// Packs groups `first..end` (sizes in their layers' pixels, `[0, 0]` when not drawn)
/// into fresh pages of `page` at `scale`, tallest first per depth.
pub(crate) fn pack(list: &DrawList, sizes: &[[u32; 2]], page: [u32; 2], first: usize, end: usize, scale: f64) -> Option<(Vec<(usize, Slot)>, Vec<u32>)> {
    let max_depth = list.groups.iter().map(|g| g.depth).max().unwrap_or(0) as usize;
    let mut placed = Vec::with_capacity(end - first);
    let mut pages = vec![0u32; max_depth + 1];
    for depth in 1..=max_depth {
        let mut members: Vec<usize> = (first..end).filter(|&g| list.groups[g].depth as usize == depth && sizes[g][0] > 0 && sizes[g][1] > 0).collect();
        if members.is_empty() {
            continue;
        }
        members.sort_by(|&a, &b| sizes[b][1].cmp(&sizes[a][1]));
        let mut shelf = Shelf { size: page, page: 0, x: 0, y: 0, row: 0 };
        for g in members {
            let w = (sizes[g][0] as f64 * scale).ceil().max(1.0) as u32;
            let h = (sizes[g][1] as f64 * scale).ceil().max(1.0) as u32;
            let (at, x, y) = shelf.place(w, h, MAX_LAYER_PAGES)?;
            placed.push((g, Slot { page: at, offset: [x as f64, y as f64], scale }));
        }
        pages[depth] = shelf.page + 1;
    }
    Some((placed, pages))
}

/// Splits the frame's isolation layers into rounds that each fit the atlas at full
/// resolution: as many consecutive top-level groups per round as fit. A single group
/// whose layers alone do not fit is drawn at the largest scale that does.
pub(crate) fn plan_rounds(list: &DrawList, sizes: &[[u32; 2]], page: [u32; 2]) -> Vec<Round> {
    let n = list.groups.len();
    let max_depth = list.groups.iter().map(|g| g.depth).max().unwrap_or(0) as usize;
    if let Some((placed, pages_per_depth)) = pack(list, sizes, page, 1, n, 1.0) {
        return vec![Round { first: 1, end: n, pages_per_depth, placed, downscaled: false }];
    }
    // Top-level groups in order, each with the end of its subtree.
    let tops: Vec<usize> = (1..n).filter(|&g| list.groups[g].depth == 1).collect();
    let end_of = |k: usize| tops.get(k + 1).copied().unwrap_or(n);
    let mut rounds = Vec::new();
    let mut i = 0;
    while i < tops.len() {
        let fits = |count: usize| pack(list, sizes, page, tops[i], end_of(i + count - 1), 1.0);
        let Some(mut best) = fits(1) else {
            let mut scale = 0.5;
            let (placed, pages_per_depth) = loop {
                match pack(list, sizes, page, tops[i], end_of(i), scale) {
                    Some(found) => break found,
                    None if scale < 1e-3 => break (Vec::new(), vec![0; max_depth + 1]),
                    None => scale *= 0.5,
                }
            };
            rounds.push(Round { first: tops[i], end: end_of(i), pages_per_depth, placed, downscaled: true });
            i += 1;
            continue;
        };
        // The longest run that fits: grow by doubling, then bisect.
        let remaining = tops.len() - i;
        let (mut good, mut step) = (1, 1);
        let mut bad = None;
        while good < remaining {
            let count = (good + step).min(remaining);
            match fits(count) {
                Some(found) => {
                    best = found;
                    good = count;
                    step *= 2;
                }
                None => {
                    bad = Some(count);
                    break;
                }
            }
        }
        if let Some(mut bad) = bad {
            while bad - good > 1 {
                let middle = (good + bad) / 2;
                match fits(middle) {
                    Some(found) => {
                        best = found;
                        good = middle;
                    }
                    None => bad = middle,
                }
            }
        }
        rounds.push(Round { first: tops[i], end: end_of(i + good - 1), pages_per_depth: best.1, placed: best.0, downscaled: false });
        i += good;
    }
    if rounds.is_empty() {
        rounds.push(Round { first: 1, end: n, pages_per_depth: vec![0; max_depth + 1], placed: Vec::new(), downscaled: false });
    }
    rounds
}

/// The atlas page size for a frame of `size` whose largest layer is `largest`:
/// at least the frame, in steps of 256 pixels.
pub(crate) fn page_size(size: [u32; 2], largest: [u32; 2]) -> [u32; 2] {
    let step = |frame: u32, layer: u32| if layer <= frame { frame } else { layer.div_ceil(256) * 256 };
    [step(size[0], largest[0]), step(size[1], largest[1])]
}

impl Renderer {
    pub(crate) fn layer_bind(device: &wgpu::Device, layout: &wgpu::BindGroupLayout, view: &wgpu::TextureView) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("styk layers"),
            layout,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(view) }],
        })
    }

    pub(crate) fn ensure_layers(&mut self, parity: usize, size: [u32; 2], pages: u32) {
        let atlas = &self.layers[parity];
        if atlas.size == size && atlas.pages >= pages {
            return;
        }
        let pages = pages.max(atlas.pages).min(MAX_LAYER_PAGES);
        let (texture, view) = array_texture(&self.device, "styk layers", size, pages, true);
        self.layer_binds[parity] = Self::layer_bind(&self.device, &self.layout2, &view);
        self.layers[parity] = LayerAtlas { texture, view, size, pages };
    }

}

#[cfg(test)]
mod tests {
    use super::*;
    use styk_draw::{Group, Pass};

    /// A frame of `count` translucent figures, each covering most of a 400×300 view,
    /// with one nested translucent outline each.
    fn crowded(count: usize) -> DrawList {
        let mut groups = vec![Group { parent: 0, depth: 0, opacity: 1.0, bounds: [0.0, 0.0, 400.0, 300.0], layer: styk_draw::NO_LAYER }];
        for _ in 0..count {
            let top = groups.len() as u32;
            groups.push(Group { parent: 0, depth: 1, opacity: 0.5, bounds: [10.0, 10.0, 390.0, 290.0], layer: styk_draw::NO_LAYER });
            groups.push(Group { parent: top, depth: 2, opacity: 0.5, bounds: [20.0, 20.0, 380.0, 280.0], layer: styk_draw::NO_LAYER });
        }
        DrawList { groups, passes: vec![Pass { depth: 0, start: 0, end: 0 }], ..Default::default() }
    }

    /// Layer sizes as the renderer plans them for a 400×300 view.
    fn sizes(list: &DrawList) -> Vec<[u32; 2]> {
        let view = crate::effects::plan::View { matrix: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0], size: [400, 300], zoom: 1.0, pan: [0.0; 2], orient: crate::effects::plan::IDENTITY, stretch: 1.0, camera_view: false, camera_limit: 2048.0, max_texture: 8192 };
        crate::effects::plan::plan(list, &view).iter().map(|p| p.size()).collect()
    }

    #[test]
    fn layers_that_fit_take_one_round() {
        let list = crowded(5);
        let rounds = plan_rounds(&list, &sizes(&list), [400, 300]);
        assert_eq!(rounds.len(), 1);
        assert!(!rounds[0].downscaled);
        assert_eq!(rounds[0].placed.len(), 10);
    }

    /// More full-frame layers than atlas pages: every one is still drawn at full
    /// resolution, in rounds, each group exactly once and with its nested group.
    #[test]
    fn overflowing_layers_are_drawn_in_full_resolution_rounds() {
        let list = crowded(21);
        let rounds = plan_rounds(&list, &sizes(&list), [400, 300]);
        assert!(rounds.len() > 1, "21 full-frame layers cannot share {MAX_LAYER_PAGES} pages");
        let mut seen = vec![0; list.groups.len()];
        let mut next = 1;
        for round in &rounds {
            assert!(!round.downscaled);
            assert_eq!(round.first, next, "rounds are consecutive runs");
            next = round.end;
            assert!(round.pages_per_depth.iter().all(|&pages| pages <= MAX_LAYER_PAGES));
            for &(g, entry) in &round.placed {
                assert!((round.first..round.end).contains(&g));
                assert_eq!(entry.scale, 1.0);
                seen[g] += 1;
            }
        }
        assert_eq!(next, list.groups.len());
        assert!(seen[1..].iter().all(|&count| count == 1), "every layer placed once: {seen:?}");
    }

    /// A single group whose nested layers alone exceed the atlas is the one case drawn smaller.
    #[test]
    fn a_group_too_large_alone_is_downscaled() {
        let mut groups = vec![Group { parent: 0, depth: 0, opacity: 1.0, bounds: [0.0, 0.0, 400.0, 300.0], layer: styk_draw::NO_LAYER }];
        groups.push(Group { parent: 0, depth: 1, opacity: 0.5, bounds: [0.0, 0.0, 400.0, 300.0], layer: styk_draw::NO_LAYER });
        for _ in 0..(MAX_LAYER_PAGES as usize + 4) {
            groups.push(Group { parent: 1, depth: 2, opacity: 0.5, bounds: [0.0, 0.0, 400.0, 300.0], layer: styk_draw::NO_LAYER });
        }
        let list = DrawList { groups, passes: vec![Pass { depth: 0, start: 0, end: 0 }], ..Default::default() };
        let rounds = plan_rounds(&list, &sizes(&list), [400, 300]);
        assert_eq!(rounds.len(), 1);
        assert!(rounds[0].downscaled);
        assert_eq!(rounds[0].placed.len(), list.groups.len() - 1);
    }

    #[test]
    fn pages_grow_for_layers_larger_than_the_frame() {
        assert_eq!(page_size([400, 300], [380, 280]), [400, 300]);
        assert_eq!(page_size([400, 300], [601, 300]), [768, 300]);
    }
}
