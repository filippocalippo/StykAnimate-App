//! Sprites and drawing cel tiles: the texture-array atlas `styk_eval::assets`
//! lays out, filled with images decoded on the engine's worker threads.

use styk_eval::assets::{Assets, PAGE};
use styk_eval::doc::Document;

use crate::resources::{array_texture, staging, submit_staged, write_texture};
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
        self.install_sprites(assets, live).destroy();
    }

    /// Allocates the texture of [`Renderer::prepare_sprites_live`] and returns the one it replaces. A texture whose
    /// last handle is dropped is not given back until the browser collects it (WebGPU frees it on `destroy`), so what a
    /// renderer replaces is destroyed once nothing needs its texels.
    fn install_sprites(&mut self, assets: &Assets, live: u32) -> wgpu::Texture {
        let pages = assets.pages + live;
        let size = if pages == 0 { [1, 1] } else { [PAGE, PAGE] };
        let (texture, view) = array_texture(&self.device, "styk sprites", size, pages.max(1), false);
        let old = std::mem::replace(&mut self.sprites, texture);
        self.sprite_view = view;
        self.rebind_sprites();
        old
    }

    /// Makes room for `live` pages after the document's own, keeping every texel written
    /// (the pages are copied on the GPU): the document's pictures are not decoded again.
    pub fn grow_sprites(&mut self, assets: &Assets, live: u32) {
        let wanted = (assets.pages + live).max(2);
        let have = self.sprites.depth_or_array_layers();
        if wanted <= have && self.sprites.width() == PAGE {
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

    /// The sprite atlas: its pages (layers) and its bytes of GPU memory.
    pub fn sprite_memory(&self) -> (u32, u64) {
        let pages = self.sprites.depth_or_array_layers();
        (pages, self.sprites.width() as u64 * self.sprites.height() as u64 * 4 * pages as u64)
    }

    /// Writes live drawing slots, `base` being the layer of the first live page.
    pub fn upload_live(&mut self, base: u32, runs: &[styk_eval::live::Run]) {
        for run in runs {
            let width = run.cells * styk_eval::live::CELL;
            write_texture(
                &self.device,
                &self.queue,
                wgpu::TexelCopyTextureInfo { texture: &self.sprites, mip_level: 0, origin: wgpu::Origin3d { x: run.x, y: run.y, z: base + run.page }, aspect: wgpu::TextureAspect::All },
                &run.rgba,
                width * 4,
                styk_eval::live::CELL,
                wgpu::Extent3d { width, height: styk_eval::live::CELL, depth_or_array_layers: 1 },
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
    ///
    /// The pixels go through staging buffers this renderer fills itself and copies from on the GPU, not through
    /// `Queue::write_texture`: a browser's `writeTexture` from the engine's shared memory left a picture of the atlas
    /// with rows of another's bytes in about two of five exports of tdd2 (an export of the same document twice did not give
    /// the same frames; docs/engine/rendering.md, Exports). Native adapters never showed it.
    pub fn upload_images<'a>(&mut self, assets: &Assets, images: impl IntoIterator<Item = &'a DecodedImage>) {
        if assets.pages == 0 {
            return;
        }
        let mut batch: Vec<(&DecodedImage, [u32; 3], u64)> = Vec::new();
        let mut bytes = 0u64;
        for img in images {
            let entry = if img.drawing { assets.drawing.get(img.index as usize) } else { assets.atlas.get(img.index as usize) };
            let Some(e) = entry.filter(|e| e.valid) else { continue };
            if img.width == 0 || img.height == 0 {
                continue;
            }
            let border = if img.drawing { styk_eval::drawing::BORDER } else { 1 };
            let size = staged_stride(img.width) as u64 * img.height as u64;
            if !batch.is_empty() && bytes + size > STAGING_BYTES {
                self.copy_staged(&batch, bytes);
                batch.clear();
                bytes = 0;
            }
            batch.push((img, [e.x - border, e.y - border, e.layer], bytes));
            bytes += size;
        }
        if !batch.is_empty() {
            self.copy_staged(&batch, bytes);
        }
    }

    /// Copies `batch` (pictures, the atlas place of each and where its rows start in the staging buffer) into the atlas
    /// through one staging buffer of `bytes`, given back once the GPU has finished with it.
    fn copy_staged(&self, batch: &[(&DecodedImage, [u32; 3], u64)], bytes: u64) {
        let source = staging(&self.device, bytes);
        {
            let mut mapped = source.slice(..).get_mapped_range_mut().expect("a buffer made mapped is mapped");
            for &(img, _, offset) in batch {
                let (row, stride) = (img.width as usize * 4, staged_stride(img.width) as usize);
                for (y, pixels) in img.rgba.chunks_exact(row).enumerate() {
                    let at = offset as usize + y * stride;
                    mapped.slice(at..at + row).copy_from_slice(pixels);
                }
            }
        }
        source.unmap();
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("styk picture upload") });
        for &(img, [x, y, layer], offset) in batch {
            encoder.copy_buffer_to_texture(
                wgpu::TexelCopyBufferInfo { buffer: &source, layout: wgpu::TexelCopyBufferLayout { offset, bytes_per_row: Some(staged_stride(img.width)), rows_per_image: Some(img.height) } },
                wgpu::TexelCopyTextureInfo { texture: &self.sprites, mip_level: 0, origin: wgpu::Origin3d { x, y, z: layer }, aspect: wgpu::TextureAspect::All },
                wgpu::Extent3d { width: img.width, height: img.height, depth_or_array_layers: 1 },
            );
        }
        submit_staged(&self.queue, encoder, source);
    }

}

/// Bytes a picture's row takes in a staging buffer (a copy's rows start at multiples of 256).
fn staged_stride(width: u32) -> u32 {
    (width * 4).div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT) * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT
}

/// Pictures a staging buffer holds at most (one picture at least).
const STAGING_BYTES: u64 = 64 << 20;

#[cfg(test)]
mod tests {
    use super::*;
    use styk_eval::assets::AtlasEntry;

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

    /// The RGBA of a rectangle of the sprite atlas's page `layer`, read back from the GPU.
    fn read_atlas(renderer: &Renderer, layer: u32, x: u32, y: u32, width: u32, height: u32) -> Vec<u8> {
        let stride = (width * 4).div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT) * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        let buffer = renderer.device.create_buffer(&wgpu::BufferDescriptor { label: None, size: stride as u64 * height as u64, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
        let mut encoder = renderer.device.create_command_encoder(&Default::default());
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo { texture: &renderer.sprites, mip_level: 0, origin: wgpu::Origin3d { x, y, z: layer }, aspect: wgpu::TextureAspect::All },
            wgpu::TexelCopyBufferInfo { buffer: &buffer, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(stride), rows_per_image: Some(height) } },
            wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
        );
        renderer.queue.submit([encoder.finish()]);
        buffer.slice(..).map_async(wgpu::MapMode::Read, |result| result.expect("mapped"));
        renderer.device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
        let mapped = buffer.slice(..).get_mapped_range().expect("mapped range");
        (0..height as usize).flat_map(|row| mapped[row * stride as usize..row * stride as usize + width as usize * 4].to_vec()).collect()
    }

    fn picture(index: u32, drawing: bool, width: u32, height: u32, seed: u8) -> DecodedImage {
        let rgba = (0..width * height * 4).map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed)).collect();
        DecodedImage { index, drawing, width, height, rgba }
    }

    /// Pictures land in their atlas places row for row, whatever their width (rows are padded to 256 bytes in the staging
    /// buffer), with the gutter or border outside the place, across more than one staging buffer, and leave their
    /// neighbours' texels alone.
    #[test]
    fn uploaded_pictures_land_in_their_places_row_for_row() {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
        let Ok(adapter) = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())) else {
            eprintln!("skipped: no GPU adapter");
            return;
        };
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).expect("device");
        let mut renderer = Renderer::new(&device, &queue, wgpu::TextureFormat::Rgba8Unorm);
        let mut assets = assets(2);
        let place = |layer, x, y, w, h| AtlasEntry { layer, x, y, w, h, source_w: w, source_h: h, valid: true };
        // Images keep a one-texel gutter around the place, drawing cels a border of BORDER.
        assets.atlas = vec![place(0, 11, 13, 3, 2), place(1, 40, 8, 69, 5)];
        assets.drawing = vec![place(0, 100, 50, 7, 6)];
        let border = styk_eval::drawing::BORDER;
        let pictures = [picture(0, false, 5, 4, 1), picture(1, false, 71, 7, 2), picture(0, true, 7 + 2 * border, 6 + 2 * border, 3)];
        renderer.prepare_sprites(&assets);
        renderer.upload_images(&assets, pictures.iter());
        for (picture, (layer, x, y)) in pictures.iter().zip([(0, 10, 12), (1, 39, 7), (0, 100 - border, 50 - border)]) {
            assert_eq!(read_atlas(&renderer, layer, x, y, picture.width, picture.height), picture.rgba, "picture {} (drawing: {})", picture.index, picture.drawing);
        }
        assert!(read_atlas(&renderer, 0, 9, 12, 1, 4).iter().all(|b| *b == 0), "the texels beside a picture are untouched");
        // A second call, as a document's later pictures arrive.
        let later = picture(1, false, 33, 9, 9);
        renderer.upload_images(&assets, [&later]);
        assert_eq!(read_atlas(&renderer, 1, 39, 7, 33, 9), later.rgba);
        assert_eq!(read_atlas(&renderer, 0, 10, 12, 5, 4), pictures[0].rgba, "an earlier picture is kept");
    }

    fn assets(pages: u32) -> Assets {
        let mut assets = Assets::default();
        assets.pages = pages;
        assets
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
