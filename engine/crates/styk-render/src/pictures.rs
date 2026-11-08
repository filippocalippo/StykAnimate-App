//! Which pictures of the document's sprite layout are in the sprite texture, and the soft copies drawn for the rest.
//!
//! Every picture of the layout (`styk_eval::assets`) has a place (a page and the corner of its rectangle). A shader
//! that draws a picture asks the picture table (prim.wgsl `picture_layer`) for the layer of the sprite texture that
//! holds it, and draws its soft copy (a `SOFT_SCALE` times smaller picture, always resident, in the soft atlas) when the
//! table says it has none: a document whose pages are not all in the texture ([`styk_engine::Residency`]) shows
//! every picture at once, soft, and sharp once its pixels are in. A renderer that holds the whole layout has every
//! picture in the table at its own page's layer.
//!
//! The table is a hash table of one `[corner, page, layer + 1, 0]` entry per picture (`u32`s, 16 bytes), probed linearly
//! at most [`PROBES`] entries from its hash: the same hash and probes in the shader and here.

use std::collections::HashMap;

use styk_eval::assets::{Assets, AtlasEntry, SOFT_PAGE};

use crate::resources::{array_texture, Table, TABLE_WIDTH};

/// Entries the shader reads at most to find a picture; a table that would need more is made larger.
pub(crate) const PROBES: usize = 16;

/// Soft pages along a side of a layer of the soft atlas, and in a layer.
const SOFT_SIDE: u32 = 2;
pub(crate) const SOFT_PER_LAYER: u32 = SOFT_SIDE * SOFT_SIDE;
/// Texels along a side of a layer of the soft atlas.
pub(crate) const SOFT_LAYER: u32 = SOFT_PAGE * SOFT_SIDE;

/// The corner of the rectangle of a picture, packed: its row and column in the page (twelve bits each; never zero, a
/// picture lies a gutter inside its page).
fn corner(entry: &AtlasEntry) -> u32 {
    entry.y << 12 | entry.x
}

fn hash(page: u32, corner: u32) -> u32 {
    let h = page.wrapping_mul(0x9E37_79B1) ^ corner.wrapping_mul(0x85EB_CA6B);
    h ^ (h >> 15)
}

/// The sprite texture's layer of every picture, as the picture table holds it, and the soft atlas.
pub(crate) struct PictureState {
    pub(crate) soft: wgpu::Texture,
    pub(crate) soft_view: wgpu::TextureView,
    pub(crate) table: wgpu::Texture,
    pub(crate) table_view: wgpu::TextureView,
    entries: Vec<[u32; 4]>,
    /// The entry of each picture, by page and corner.
    slots: HashMap<(u32, u32), usize>,
    dirty: bool,
    /// The renderer holds the whole layout: every picture is in at its page's layer, new ones too.
    pub(crate) whole: bool,
    /// The pictures of the layout the table was made for ([`styk_eval::assets::Assets::atlas`] entries): a layout with more
    /// has pictures the table does not know.
    pub(crate) known: usize,
}

impl PictureState {
    /// A table of the pictures of `assets` whose layer is `layer_of`'s (`None`: only the soft copy draws), and a soft atlas
    /// for `soft_pages` pages of the layout (a one texel placeholder for none).
    pub(crate) fn new(device: &wgpu::Device, queue: &wgpu::Queue, assets: &Assets, soft_pages: u32, whole: bool, layer_of: impl Fn(&AtlasEntry) -> Option<u32>) -> PictureState {
        Self::new_bounded(device, queue, assets, soft_pages, whole, layer_of, u64::MAX)
            .expect("unbounded picture table")
    }

    /// Reserve the GPU table before any capacity growth; collisions must not
    /// silently turn a small advertised table into an unbounded allocation.
    pub(crate) fn new_bounded(device: &wgpu::Device, queue: &wgpu::Queue, assets: &Assets, soft_pages: u32, whole: bool, layer_of: impl Fn(&AtlasEntry) -> Option<u32>, table_bytes: u64) -> Result<PictureState, u64> {
        let pictures: Vec<&AtlasEntry> = assets.atlas.iter().filter(|entry| entry.valid && entry.layer < crate::MAX_PAGES).collect();
        let mut capacity = pictures.len().checked_mul(4).and_then(usize::checked_next_power_of_two)
            .ok_or(u64::MAX)?.max(TABLE_WIDTH as usize);
        let (entries, slots) = loop {
            let required = (capacity as u64).saturating_mul(16);
            if required > table_bytes { return Err(required); }
            let mut entries = vec![[0u32; 4]; capacity];
            let mut slots = HashMap::with_capacity(pictures.len());
            let placed = pictures.iter().all(|entry| {
                let at = corner(entry);
                let start = hash(entry.layer, at) as usize;
                (0..PROBES).any(|probe| {
                    let slot = (start + probe) & (capacity - 1);
                    let free = entries[slot][0] == 0;
                    if free {
                        entries[slot] = [at, entry.layer, layer_of(entry).map_or(0, |layer| layer + 1), 0];
                        slots.insert((entry.layer, at), slot);
                    }
                    free
                })
            });
            if placed {
                break (entries, slots);
            }
            capacity = capacity.checked_mul(2).ok_or(u64::MAX)?;
        };
        let (table, table_view) = Table::allocate(device, "styk pictures", wgpu::TextureFormat::Rgba32Uint, (capacity / TABLE_WIDTH as usize) as u32);
        let (soft, soft_view) = if soft_pages == 0 {
            array_texture(device, "styk soft sprites", [1, 1], 1, false)
        } else {
            array_texture(device, "styk soft sprites", [SOFT_LAYER, SOFT_LAYER], soft_pages.min(crate::MAX_PAGES).div_ceil(SOFT_PER_LAYER), false)
        };
        crate::resources::warm_texture(queue, &table);
        crate::resources::warm_texture(queue, &soft);
        let mut state = PictureState { soft, soft_view, table, table_view, entries, slots, dirty: true, whole, known: assets.atlas.len() };
        state.flush(queue);
        Ok(state)
    }

    /// The layer of the picture at `entry` in the sprite texture, if it is in.
    pub(crate) fn layer(&self, entry: &AtlasEntry) -> Option<u32> {
        let slot = *self.slots.get(&(entry.layer, corner(entry)))?;
        self.entries[slot][2].checked_sub(1)
    }

    /// The pictures that are in the sprite texture, by page and corner, with their layers plus one.
    pub(crate) fn values(&self) -> HashMap<(u32, u32), u32> {
        self.slots.iter().map(|(&key, &slot)| (key, self.entries[slot][2])).collect()
    }

    /// The picture at `entry` is in layer `layer` of the sprite texture (`None`: it is not, its soft copy draws).
    /// Takes effect with [`PictureState::flush`].
    pub(crate) fn set(&mut self, entry: &AtlasEntry, layer: Option<u32>) {
        if let Some(&slot) = self.slots.get(&(entry.layer, corner(entry))) {
            let value = layer.map_or(0, |layer| layer + 1);
            if self.entries[slot][2] != value {
                self.entries[slot][2] = value;
                self.dirty = true;
            }
        }
    }

    pub(crate) fn flush(&mut self, queue: &wgpu::Queue) {
        if !std::mem::take(&mut self.dirty) {
            return;
        }
        let rows = (self.entries.len() / TABLE_WIDTH as usize) as u32;
        queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: &self.table, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            bytemuck::cast_slice(&self.entries),
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(TABLE_WIDTH * 16), rows_per_image: Some(rows) },
            wgpu::Extent3d { width: TABLE_WIDTH, height: rows, depth_or_array_layers: 1 },
        );
    }

    /// Whether the soft atlas is the real one, not the placeholder.
    pub(crate) fn has_soft(&self) -> bool {
        self.soft.width() == SOFT_LAYER
    }

    /// Bytes of GPU memory the soft atlas and the table hold.
    pub(crate) fn bytes(&self) -> u64 {
        self.soft.width() as u64 * self.soft.height() as u64 * 4 * self.soft.depth_or_array_layers() as u64 + self.entries.len() as u64 * 16
    }

    /// Gives the textures back at once.
    pub(crate) fn destroy(&self) {
        self.soft.destroy();
        self.table.destroy();
    }
}
