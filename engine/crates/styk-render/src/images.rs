//! Sprites and drawing cel tiles: the texture-array atlas `styk_eval::assets`
//! lays out, filled with images decoded on the engine's worker threads.

use styk_eval::assets::{Assets, PAGE};
use styk_eval::doc::Document;

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


impl Renderer {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn sprite_bind(device: &wgpu::Device, layout: &wgpu::BindGroupLayout, view: &wgpu::TextureView, linear: &wgpu::Sampler, materials: &wgpu::TextureView, material_sampler: &wgpu::Sampler, glyphs: &wgpu::TextureView) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("styk sprites"),
            layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(view) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(linear) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(materials) },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::Sampler(material_sampler) },
                wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::TextureView(glyphs) },
            ],
        })
    }

    /// Binds the sprite atlas, the particle materials and the glyph masks again (one was replaced).
    pub(crate) fn rebind_sprites(&mut self) {
        self.sprite_bind = Self::sprite_bind(&self.device, &self.layout1, &self.sprite_view, &self.linear, &self.materials.view, &self.material_sampler, &self.glyphs.view);
    }

    /// Allocates the sprite atlas for a document (pages from its asset layout).
    pub fn prepare_sprites(&mut self, assets: &Assets) {
        self.prepare_sprites_live(assets, 0);
    }

    /// Allocates the sprite atlas for a document, with `live` more pages after its own for the
    /// drawing cels held live ([`styk_eval::live`]).
    pub fn prepare_sprites_live(&mut self, assets: &Assets, live: u32) {
        let pages = assets.pages + live;
        let size = if pages == 0 { [1, 1] } else { [PAGE, PAGE] };
        let (texture, view) = array_texture(&self.device, "styk sprites", size, pages.max(1), false);
        self.sprites = texture;
        self.sprite_view = view;
        self.rebind_sprites();
    }

    /// Makes room for `live` pages after the document's own, keeping every texel written
    /// (the pages are copied on the GPU): the document's pictures are not decoded again.
    pub fn grow_sprites(&mut self, assets: &Assets, live: u32) {
        let wanted = (assets.pages + live).max(2);
        let have = self.sprites.depth_or_array_layers();
        if wanted <= have && self.sprites.width() == PAGE {
            return;
        }
        let old = self.sprites.clone();
        self.prepare_sprites_live(assets, live);
        if old.width() == PAGE {
            let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("styk sprites grow") });
            encoder.copy_texture_to_texture(
                wgpu::TexelCopyTextureInfo { texture: &old, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
                wgpu::TexelCopyTextureInfo { texture: &self.sprites, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
                wgpu::Extent3d { width: PAGE, height: PAGE, depth_or_array_layers: have },
            );
            self.queue.submit([encoder.finish()]);
        }
    }

    /// The sprite atlas: its pages (layers) and its bytes of GPU memory.
    pub fn sprite_memory(&self) -> (u32, u64) {
        let pages = self.sprites.depth_or_array_layers();
        (pages, self.sprites.width() as u64 * self.sprites.height() as u64 * 4 * pages as u64)
    }

    /// Writes live drawing slots, `base` being the layer of the first live page.
    pub fn upload_live(&mut self, base: u32, uploads: &[styk_eval::live::Upload]) {
        for upload in uploads {
            let (x, y) = upload.origin();
            self.queue.write_texture(
                wgpu::TexelCopyTextureInfo { texture: &self.sprites, mip_level: 0, origin: wgpu::Origin3d { x, y, z: base + upload.page }, aspect: wgpu::TextureAspect::All },
                &upload.rgba,
                wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(styk_eval::live::CELL * 4), rows_per_image: Some(styk_eval::live::CELL) },
                wgpu::Extent3d { width: styk_eval::live::CELL, height: styk_eval::live::CELL, depth_or_array_layers: 1 },
            );
        }
    }

    /// Samples `other`'s sprite atlas: the same texture, not a copy. A second renderer on
    /// the same device draws another view of the same document with the pictures `other`
    /// uploads (the stage's camera monitor). Call it again after `other` prepares a new atlas.
    pub fn share_sprites(&mut self, other: &Renderer) {
        self.sprites = other.sprites.clone();
        self.sprite_view = other.sprite_view.clone();
        self.rebind_sprites();
    }

    /// Uploads decoded images into the atlas prepared by [`prepare_sprites`].
    pub fn upload_images<'a>(&mut self, assets: &Assets, images: impl IntoIterator<Item = &'a DecodedImage>) {
        if assets.pages == 0 {
            return;
        }
        for img in images {
            let entry = if img.drawing { assets.drawing.get(img.index as usize) } else { assets.atlas.get(img.index as usize) };
            let Some(e) = entry.filter(|e| e.valid) else { continue };
            let border = if img.drawing { styk_eval::drawing::BORDER } else { 1 };
            self.queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &self.sprites,
                    mip_level: 0,
                    origin: wgpu::Origin3d { x: e.x - border, y: e.y - border, z: e.layer },
                    aspect: wgpu::TextureAspect::All,
                },
                &img.rgba,
                wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(img.width * 4), rows_per_image: Some(img.height) },
                wgpu::Extent3d { width: img.width, height: img.height, depth_or_array_layers: 1 },
            );
        }
    }

}
