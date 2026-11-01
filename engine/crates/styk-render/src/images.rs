//! Sprites and drawing cel tiles: the texture-array atlas `styk_eval::assets`
//! lays out, filled with images decoded on the engine's worker threads.

use styk_eval::assets::{Assets, PAGE};
use styk_eval::doc::Document;

use crate::pictures::{PictureState, SOFT_LAYER, SOFT_PER_LAYER};
use crate::resources::array_texture;
use crate::Renderer;

pub use styk_eval::assets::DecodedImage;

/// Decodes every image of a document into atlas-ready pixels (tools; the engine
/// decodes in the background instead).
pub fn decode_images(doc: &Document, assets: &Assets) -> Vec<DecodedImage> {
    let mut images: Vec<DecodedImage> = (0..doc.images.len()).filter_map(|index| styk_eval::assets::decode_image(doc, assets, index)).collect();
    for (cel, _) in assets.cels.values() {
        images.extend(styk_eval::assets::decode_cel(assets, cel));
    }
    images
}


/// A page of the document's sprite layout that has no layer of the sprite texture.
pub(crate) const UNMAPPED: u32 = u32::MAX;

/// Pages a layout may have: one row of the table. A page beyond them has no layer, no picture of it is in the sprite
/// texture or the soft atlas, and what is drawn from it is nothing.
pub const MAX_PAGES: u32 = crate::resources::TABLE_WIDTH;

/// Where each page of the document's sprite layout (`styk_eval::assets`) lives in the sprite texture: the layer a
/// shader reads for a drawing cel's tile on that page (prim.wgsl `sprite_layer`; the pictures of the document have a
/// table of their own, [`PictureState`]). A renderer that holds the whole layout maps a page to the layer of its own
/// number; the stage's, for a document with more pages than it keeps (`styk_engine::Residency`), maps the pages that
/// are resident and reads -1 for every other page: nothing is drawn from it.
pub(crate) struct SpriteMap {
    pub(crate) texture: wgpu::Texture,
    pub(crate) view: wgpu::TextureView,
    /// The layer of each page, [`UNMAPPED`] for a page without one.
    layers: Vec<u32>,
}

impl SpriteMap {
    pub(crate) fn new(device: &wgpu::Device) -> SpriteMap {
        let (texture, view) = crate::resources::Table::allocate(device, "styk sprite pages", wgpu::TextureFormat::R32Float, 1);
        SpriteMap { texture, view, layers: Vec::new() }
    }

    /// Writes the table: a page with no layer reads -1.
    fn flush(&self, queue: &wgpu::Queue) {
        let mut row = vec![-1f32; MAX_PAGES as usize];
        for (page, &layer) in self.layers.iter().enumerate().take(MAX_PAGES as usize) {
            if layer != UNMAPPED {
                row[page] = layer as f32;
            }
        }
        queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: &self.texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            bytemuck::cast_slice(&row),
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(MAX_PAGES * 4), rows_per_image: Some(1) },
            wgpu::Extent3d { width: MAX_PAGES, height: 1, depth_or_array_layers: 1 },
        );
    }

    /// The layer of `page`, if it has one.
    pub(crate) fn layer(&self, page: u32) -> Option<u32> {
        self.layers.get(page as usize).copied().filter(|&layer| layer != UNMAPPED)
    }
}

impl Renderer {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn sprite_bind(device: &wgpu::Device, layout: &wgpu::BindGroupLayout, view: &wgpu::TextureView, linear: &wgpu::Sampler, materials: &wgpu::TextureView, material_sampler: &wgpu::Sampler, glyphs: &wgpu::TextureView, pages: &wgpu::TextureView, pictures: &PictureState) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("styk sprites"),
            layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(view) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(linear) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(materials) },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::Sampler(material_sampler) },
                wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::TextureView(glyphs) },
                wgpu::BindGroupEntry { binding: 5, resource: wgpu::BindingResource::TextureView(pages) },
                wgpu::BindGroupEntry { binding: 6, resource: wgpu::BindingResource::TextureView(&pictures.soft_view) },
                wgpu::BindGroupEntry { binding: 7, resource: wgpu::BindingResource::TextureView(&pictures.table_view) },
            ],
        })
    }

    /// Binds the sprite atlas, the particle materials and the glyph masks again (one was replaced).
    pub(crate) fn rebind_sprites(&mut self) {
        self.sprite_bind = Self::sprite_bind(&self.device, &self.layout1, &self.sprite_view, &self.linear, &self.materials.view, &self.material_sampler, &self.glyphs.view, &self.sprite_map.view, &self.pictures);
    }

    /// Allocates the sprite atlas for a document (pages from its asset layout).
    pub fn prepare_sprites(&mut self, assets: &Assets) {
        self.prepare_sprites_live(assets, 0);
    }

    /// Allocates the sprite atlas for a document, with `live` more pages after its own for the
    /// drawing cels held live ([`styk_eval::live`]).
    pub fn prepare_sprites_live(&mut self, assets: &Assets, live: u32) {
        self.install_sprites(assets, live).destroy();
    }

    /// Allocates the texture of [`Renderer::prepare_sprites_live`] and returns the one it replaces. A texture the
    /// last handle to is dropped is not given back until the browser collects it (WebGPU frees it on `destroy`),
    /// so what a renderer replaces is destroyed, once nothing needs its texels.
    fn install_sprites(&mut self, assets: &Assets, live: u32) -> wgpu::Texture {
        let pages = assets.pages + live;
        let size = if pages == 0 { [1, 1] } else { [PAGE, PAGE] };
        let (texture, view) = array_texture(&self.device, "styk sprites", size, pages.max(1), false);
        self.sprite_view = view;
        self.sprite_map.layers = (0..pages.min(MAX_PAGES)).collect();
        self.sprite_map.flush(&self.queue);
        // Every picture is in, in the layer of its page.
        let held = PictureState::new(&self.device, &self.queue, assets, 0, true, |entry| Some(entry.layer));
        std::mem::replace(&mut self.pictures, held).destroy();
        let old = std::mem::replace(&mut self.sprites, texture);
        self.rebind_sprites();
        old
    }

    /// Allocates the sprite texture of a document whose layout is `assets`, with `live` more pages for the drawing cels
    /// held live, for a renderer that keeps `layers` pages of it at a time: a page is given a layer with
    /// [`Renderer::map_sprite_page`] (drawing cels' tiles) and a picture is put in one with [`Renderer::set_picture`] once
    /// its pixels are uploaded; a picture that is not in draws its soft copy ([`Renderer::upload_rows`]), which draws
    /// nothing until it is uploaded. Nothing is in yet.
    pub fn prepare_sprites_resident(&mut self, assets: &Assets, live: u32, layers: u32) {
        let pages = assets.pages + live;
        let (texture, view) = array_texture(&self.device, "styk sprites", [PAGE, PAGE], layers.max(2), false);
        self.sprite_view = view;
        self.sprite_map.layers = vec![UNMAPPED; pages.min(MAX_PAGES) as usize];
        self.sprite_map.flush(&self.queue);
        let held = PictureState::new(&self.device, &self.queue, assets, assets.pages, false, |_| None);
        std::mem::replace(&mut self.pictures, held).destroy();
        let old = std::mem::replace(&mut self.sprites, texture);
        self.rebind_sprites();
        old.destroy();
    }

    /// Makes the table know every picture of `assets`, the layout of the document drawn now: a revision that appended
    /// pictures (to a page that existed, as often as to a new one) has some the table was not made with, and a picture
    /// the table does not know is drawn from its soft copy, which a renderer that holds the whole layout does not have.
    /// What is in stays in; a new picture is in when the renderer holds the whole layout, and has its soft copy only
    /// otherwise. Returns whether the table and the soft atlas were replaced (a renderer sharing them shares them again).
    pub fn sync_pictures(&mut self, assets: &Assets) -> bool {
        if assets.atlas.len() == self.pictures.known {
            return false;
        }
        let (values, whole) = (self.pictures.values(), self.pictures.whole);
        let soft_pages = if whole { 0 } else { assets.pages };
        let pages = self.sprite_map.layers.clone();
        let held = PictureState::new(&self.device, &self.queue, assets, soft_pages, whole, |entry| match values.get(&(entry.layer, entry.y << 12 | entry.x)) {
            Some(value) => value.checked_sub(1),
            None => whole.then(|| pages.get(entry.layer as usize).copied().filter(|&layer| layer != UNMAPPED)).flatten(),
        });
        let old = std::mem::replace(&mut self.pictures, held);
        if old.has_soft() {
            let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("styk soft sprites grow") });
            encoder.copy_texture_to_texture(
                wgpu::TexelCopyTextureInfo { texture: &old.soft, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
                wgpu::TexelCopyTextureInfo { texture: &self.pictures.soft, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
                wgpu::Extent3d { width: SOFT_LAYER, height: SOFT_LAYER, depth_or_array_layers: old.soft.depth_or_array_layers().min(self.pictures.soft.depth_or_array_layers()) },
            );
            self.queue.submit([encoder.finish()]);
        }
        old.destroy();
        self.rebind_sprites();
        true
    }

    /// The picture at `entry` is in layer `layer` of the sprite texture (`None`: it is not, its soft copy draws). Takes
    /// effect with [`Renderer::flush_pictures`].
    pub fn set_picture(&mut self, entry: &styk_eval::assets::AtlasEntry, layer: Option<u32>) {
        self.pictures.set(entry, layer);
    }

    /// Writes the pictures put in or taken out since the last call to the table shaders read.
    pub fn flush_pictures(&mut self) {
        self.pictures.flush(&self.queue);
    }

    /// Gives `page` of the layout the layer `layer` of the sprite texture (`None`: takes its layer away, the page
    /// draws nothing). The layout may have grown since the texture was prepared. Takes effect with
    /// [`Renderer::flush_sprite_map`].
    pub fn map_sprite_page(&mut self, page: u32, layer: Option<u32>) {
        if page >= MAX_PAGES {
            return;
        }
        let map = &mut self.sprite_map.layers;
        if map.len() <= page as usize {
            map.resize(page as usize + 1, UNMAPPED);
        }
        map[page as usize] = layer.unwrap_or(UNMAPPED);
    }

    /// Writes the pages mapped since the last call to the table shaders read.
    pub fn flush_sprite_map(&self) {
        self.sprite_map.flush(&self.queue);
    }

    /// Gives the sprite texture `layers` layers (at least as many as it has), keeping every texel written. The old
    /// texture exists until the copy has run, so this is for a working set the texture was too small for, not a
    /// routine step.
    pub fn resize_sprite_layers(&mut self, layers: u32) {
        let have = self.sprites.depth_or_array_layers();
        if layers <= have {
            return;
        }
        let old = self.sprites.clone();
        let (texture, view) = array_texture(&self.device, "styk sprites", [PAGE, PAGE], layers, false);
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("styk sprites grow") });
        encoder.copy_texture_to_texture(
            wgpu::TexelCopyTextureInfo { texture: &old, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            wgpu::TexelCopyTextureInfo { texture: &texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            wgpu::Extent3d { width: PAGE, height: PAGE, depth_or_array_layers: have },
        );
        self.queue.submit([encoder.finish()]);
        self.sprites = texture;
        self.sprite_view = view;
        self.rebind_sprites();
        old.destroy();
    }

    /// Makes room for `live` pages after the document's own, keeping every texel written
    /// (the pages are copied on the GPU): the document's pictures are not decoded again.
    pub fn grow_sprites(&mut self, assets: &Assets, live: u32) {
        let wanted = (assets.pages + live).max(2);
        let have = self.sprites.depth_or_array_layers();
        if wanted <= have && self.sprites.width() == PAGE {
            // The texture has the layers (it always has two): the pages of the live cels still need their rows of the
            // map, or they read no layer and nothing written to them lands.
            self.sprite_map.layers = (0..(assets.pages + live).min(MAX_PAGES)).collect();
            self.sprite_map.flush(&self.queue);
            return;
        }
        let old = self.install_sprites(assets, live);
        if old.width() == PAGE {
            let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("styk sprites grow") });
            encoder.copy_texture_to_texture(
                wgpu::TexelCopyTextureInfo { texture: &old, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
                wgpu::TexelCopyTextureInfo { texture: &self.sprites, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
                wgpu::Extent3d { width: PAGE, height: PAGE, depth_or_array_layers: have },
            );
            self.queue.submit([encoder.finish()]);
        }
        old.destroy();
    }

    /// Whether the sprite texture is made of pages (a renderer with no pictures and no live cels has a one-texel placeholder).
    pub fn holds_pages(&self) -> bool {
        self.sprites.width() == PAGE
    }

    /// The layout gained document pages (`old_pages` to `pages`: pictures are only ever appended) and live pages (`old_live`
    /// to `live`) in a texture that holds the earlier ones: the pages that were there keep their layers, so the pictures and
    /// the live tiles stay where they are and none is decoded or written again, and the new pages take layers that are free.
    /// The live pages follow the document's in the layout, so the page map is what moves them. The texture is copied into a
    /// larger one only when it has no free layer left.
    pub fn extend_sprites(&mut self, old_pages: u32, old_live: u32, pages: u32, live: u32) {
        let layer_of = |page: u32| self.sprite_map.layers.get(page as usize).copied().unwrap_or(UNMAPPED);
        let kept_documents: Vec<u32> = (0..old_pages).map(layer_of).collect();
        let kept_live: Vec<u32> = (0..old_live).map(|k| layer_of(old_pages + k)).collect();
        let taken: std::collections::HashSet<u32> = kept_documents.iter().chain(&kept_live).copied().filter(|&layer| layer != UNMAPPED).collect();
        let wanted = (pages - old_pages.min(pages)) + (live - old_live.min(live));
        let have = self.sprites.depth_or_array_layers();
        let free_now = have.saturating_sub(taken.len() as u32);
        if wanted > free_now {
            self.resize_sprite_layers(have + (wanted - free_now));
        }
        let mut free = (0..self.sprites.depth_or_array_layers()).filter(|layer| !taken.contains(layer));
        let mut next = || free.next().unwrap_or(UNMAPPED);
        let mut map = kept_documents;
        map.extend((old_pages..pages).map(|_| next()));
        map.extend(kept_live);
        map.extend((old_live..live).map(|_| next()));
        self.sprite_map.layers = map;
        self.sprite_map.flush(&self.queue);
    }

    /// The sprite atlas: its pages (layers) and its bytes of GPU memory.
    pub fn sprite_memory(&self) -> (u32, u64) {
        let pages = self.sprites.depth_or_array_layers();
        (pages, self.sprites.width() as u64 * self.sprites.height() as u64 * 4 * pages as u64)
    }

    /// Bytes of GPU memory of the soft atlas and the table of pictures.
    pub fn soft_memory(&self) -> u64 {
        self.pictures.bytes()
    }

    /// Writes live drawing slots, `base` being the layer of the first live page.
    pub fn upload_live(&mut self, base: u32, runs: &[styk_eval::live::Run]) {
        for run in runs {
            let width = run.cells * styk_eval::live::CELL;
            // A page without a layer (the live pages of a resident renderer have one) takes nothing.
            let Some(layer) = self.sprite_map.layer(base + run.page) else { continue };
            self.queue.write_texture(
                wgpu::TexelCopyTextureInfo { texture: &self.sprites, mip_level: 0, origin: wgpu::Origin3d { x: run.x, y: run.y, z: layer }, aspect: wgpu::TextureAspect::All },
                &run.rgba,
                wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(width * 4), rows_per_image: Some(styk_eval::live::CELL) },
                wgpu::Extent3d { width, height: styk_eval::live::CELL, depth_or_array_layers: 1 },
            );
        }
    }

    /// Writes the soft copy of the picture at `entry` into the soft atlas, at its place on the page: where a draw list's
    /// uv rectangle of the picture would be, one texel to `SOFT_SCALE` of the page's.
    fn upload_soft(&mut self, entry: &styk_eval::assets::AtlasEntry, img: &DecodedImage) {
        if !self.pictures.has_soft() || entry.layer >= MAX_PAGES {
            return;
        }
        let (layer, cell) = (entry.layer / SOFT_PER_LAYER, entry.layer % SOFT_PER_LAYER);
        if layer >= self.pictures.soft.depth_or_array_layers() {
            return;
        }
        let (x, y, ..) = styk_eval::assets::soft_rect(entry);
        let (side, page) = (SOFT_LAYER / 2, styk_eval::assets::SOFT_PAGE);
        debug_assert_eq!(side, page);
        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &self.pictures.soft,
                mip_level: 0,
                origin: wgpu::Origin3d { x: cell % 2 * page + x, y: cell / 2 * page + y, z: layer },
                aspect: wgpu::TextureAspect::All,
            },
            &img.rgba,
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(img.width * 4), rows_per_image: Some(img.height) },
            wgpu::Extent3d { width: img.width, height: img.height, depth_or_array_layers: 1 },
        );
    }

    /// Samples `other`'s sprite atlas: the same texture, not a copy. A second renderer on
    /// the same device draws another view of the same document with the pictures `other`
    /// uploads (the stage's camera monitor). Call it again after `other` prepares a new atlas.
    pub fn share_sprites(&mut self, other: &Renderer) {
        self.sprites = other.sprites.clone();
        self.sprite_view = other.sprite_view.clone();
        self.sprite_map.texture = other.sprite_map.texture.clone();
        self.sprite_map.view = other.sprite_map.view.clone();
        self.pictures.soft = other.pictures.soft.clone();
        self.pictures.soft_view = other.pictures.soft_view.clone();
        self.pictures.table = other.pictures.table.clone();
        self.pictures.table_view = other.pictures.table_view.clone();
        self.rebind_sprites();
    }

    /// Uploads decoded images into the atlas prepared by [`prepare_sprites`].
    pub fn upload_images<'a>(&mut self, assets: &Assets, images: impl IntoIterator<Item = &'a DecodedImage>) {
        for img in images {
            self.upload_rows(assets, img, 0, img.height);
        }
    }

    /// Uploads rows `first..first + rows` of a decoded image: a large picture goes in over several calls, so no
    /// frame is made to wait for all of it.
    pub fn upload_rows(&mut self, assets: &Assets, img: &DecodedImage, first: u32, rows: u32) {
        if assets.pages == 0 || first >= img.height {
            return;
        }
        let rows = rows.min(img.height - first);
        let entry = if img.drawing { assets.drawing.get(img.index as usize) } else { assets.atlas.get(img.index as usize) };
        let Some(e) = entry.filter(|e| e.valid) else { return };
        if img.soft {
            self.upload_soft(e, img);
            return;
        }
        // A page without a layer (taken away while the picture was decoded) takes nothing.
        let Some(layer) = self.sprite_map.layer(e.layer) else { return };
        let border = if img.drawing { styk_eval::drawing::BORDER } else { 1 };
        let row_bytes = img.width as usize * 4;
        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &self.sprites,
                mip_level: 0,
                origin: wgpu::Origin3d { x: e.x - border, y: e.y - border + first, z: layer },
                aspect: wgpu::TextureAspect::All,
            },
            &img.rgba[first as usize * row_bytes..(first + rows) as usize * row_bytes],
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(img.width * 4), rows_per_image: Some(rows) },
            wgpu::Extent3d { width: img.width, height: rows, depth_or_array_layers: 1 },
        );
    }

}

#[cfg(test)]
mod tests {
    use super::*;

    /// Whether writing to `texture` is refused because it was destroyed.
    fn refused(renderer: &Renderer, texture: &wgpu::Texture) -> bool {
        let scope = renderer.device.push_error_scope(wgpu::ErrorFilter::Validation);
        renderer.queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            &[0; 4],
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(4), rows_per_image: Some(1) },
            wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
        );
        pollster::block_on(scope.pop()).is_some()
    }

    fn assets(pages: u32) -> Assets {
        let mut assets = Assets::default();
        assets.pages = pages;
        assets
    }

    /// A document page and a live page added to a texture that holds the earlier ones take free layers and move nothing.
    #[test]
    fn new_pages_take_free_layers_and_the_live_pages_keep_theirs() {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
        let Ok(adapter) = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())) else {
            eprintln!("skipped: no GPU adapter");
            return;
        };
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).expect("device");
        let mut renderer = Renderer::new(&device, &queue, wgpu::TextureFormat::Rgba8Unorm);
        // A blank document and one live page: two layers, the live page in layer 0.
        renderer.prepare_sprites(&assets(0));
        renderer.grow_sprites(&assets(0), 1);
        assert_eq!(renderer.sprites.depth_or_array_layers(), 2);
        let texture = renderer.sprites.clone();
        // The first stroke adds a document page: it takes the spare layer, the live page (now page 1) keeps layer 0.
        renderer.extend_sprites(0, 1, 1, 1);
        assert_eq!(renderer.sprite_map.layers, vec![1, 0]);
        assert!(!refused(&renderer, &texture), "the texture was not replaced");
        assert_eq!(renderer.sprites.depth_or_array_layers(), 2);
        // Another document page and a second live page: no layer is free, the texture grows, and nothing moves.
        renderer.extend_sprites(1, 1, 2, 2);
        assert_eq!(renderer.sprites.depth_or_array_layers(), 4);
        assert_eq!(&renderer.sprite_map.layers[..3], &[1, 2, 0]);
        assert!(renderer.sprite_map.layers[3] == 3, "the second live page has the last layer");
        assert!(refused(&renderer, &texture), "the old texture went when the layers were copied");
    }

    /// A replaced sprite texture is given back at once, not when the browser next collects it.
    #[test]
    fn a_replaced_sprite_texture_is_destroyed() {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
        let Ok(adapter) = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())) else {
            eprintln!("skipped: no GPU adapter");
            return;
        };
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).expect("device");
        let mut renderer = Renderer::new(&device, &queue, wgpu::TextureFormat::Rgba8Unorm);
        renderer.prepare_sprites(&assets(2));
        let first = renderer.sprites.clone();
        assert!(!refused(&renderer, &first), "the texture in use takes writes");
        // Another document: a new texture, and the first is gone.
        renderer.prepare_sprites(&assets(3));
        assert!(refused(&renderer, &first), "the replaced texture was destroyed");
        let second = renderer.sprites.clone();
        assert!(!refused(&renderer, &second));
        // Live pages that need more room: the texture grows, keeps what it held and the old one is destroyed.
        renderer.grow_sprites(&assets(3), 2);
        assert_eq!(renderer.sprites.depth_or_array_layers(), 5);
        assert!(refused(&renderer, &second), "the texture that was grown from was destroyed");
        assert!(!refused(&renderer, &renderer.sprites.clone()));
    }
}
