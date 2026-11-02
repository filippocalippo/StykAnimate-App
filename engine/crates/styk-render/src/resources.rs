//! GPU record layouts and the resources every pass shares: lookup tables in
//! float textures (paint records, isolation group placements, polyline
//! vertices), array textures and buffers.

use bytemuck::{Pod, Zeroable};
use styk_draw::Prim;

use crate::FORMAT;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub(crate) struct GpuPrim {
    pub(crate) kind: u32,
    pub(crate) group: u32,
    pub(crate) color: u32,
    pub(crate) paint: u32,
    pub(crate) a: [f32; 4],
    pub(crate) b: [f32; 4],
    pub(crate) c: [f32; 4],
}

/// A group's placement for one frame: six texels of the group table, written by
/// [`crate::effects::record`] (layout in prim.wgsl, `Group`).
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub(crate) struct GpuGroup(pub [f32; crate::effects::GROUP_FLOATS]);

impl Default for GpuGroup {
    fn default() -> GpuGroup {
        let mut r = [0.0; crate::effects::GROUP_FLOATS];
        r[6] = -1.0;
        GpuGroup(r)
    }
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable, Default)]
pub(crate) struct GpuView {
    pub(crate) m: [f32; 4],
    pub(crate) t: [f32; 4],
    pub(crate) inv: [f32; 4],
    pub(crate) inv_t: [f32; 4],
    pub(crate) target: [f32; 4],
    pub(crate) artboard: [f32; 4],
    pub(crate) canvas_clip: [f32; 4],
    pub(crate) background_bounds: [f32; 4],
    pub(crate) paint_quad0: [f32; 4],
    pub(crate) paint_quad1: [f32; 4],
    /// The artboard's corners on screen when the view is rotated or mirrored (zero otherwise):
    /// (0,0) and (1,0), then (1,1) and (0,1) of the artboard rectangle.
    pub(crate) orient_quad0: [f32; 4],
    pub(crate) orient_quad1: [f32; 4],
    /// x: the artboard is the quad above; y: scene primitives of the frame pass are clipped to it.
    pub(crate) orient_flags: [f32; 4],
}

/// Texels per row of a lookup table (`TABLE_WIDTH` in prim.wgsl).
pub(crate) const TABLE_WIDTH: u32 = 1024;

pub(crate) fn table_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
        ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: false }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false },
        count: None,
    }
}

/// A table shaders index with `textureLoad`: `TABLE_WIDTH` texels per row, one record
/// (or half a record) per texel.
pub(crate) struct Table {
    pub(crate) texture: wgpu::Texture,
    pub(crate) view: wgpu::TextureView,
    pub(crate) rows: u32,
    pub(crate) format: wgpu::TextureFormat,
    pub(crate) texel_bytes: u32,
    pub(crate) label: &'static str,
    pub(crate) scratch: Vec<u8>,
}

impl Table {
    pub(crate) fn new(device: &wgpu::Device, label: &'static str, format: wgpu::TextureFormat, texel_bytes: u32) -> Table {
        let (texture, view) = Table::allocate(device, label, format, 1);
        Table { texture, view, rows: 1, format, texel_bytes, label, scratch: Vec::new() }
    }

    pub(crate) fn allocate(device: &wgpu::Device, label: &str, format: wgpu::TextureFormat, rows: u32) -> (wgpu::Texture, wgpu::TextureView) {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d { width: TABLE_WIDTH, height: rows, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let view = texture.create_view(&Default::default());
        (texture, view)
    }

    /// Uploads `data` (whole texels). Returns whether the texture was replaced by a
    /// larger one, in which case bind groups that hold its view must be rebuilt.
    pub(crate) fn write(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, data: &[u8]) -> bool {
        let row_bytes = (TABLE_WIDTH * self.texel_bytes) as usize;
        let rows = data.len().div_ceil(row_bytes).max(1) as u32;
        let mut replaced = false;
        if rows > self.rows {
            self.rows = rows.next_power_of_two();
            (self.texture, self.view) = Table::allocate(device, self.label, self.format, self.rows);
            warm_texture(queue, &self.texture);
            replaced = true;
        }
        if data.is_empty() {
            return replaced;
        }
        // The last row is padded: a texture write covers whole rows.
        let whole = data.len() / row_bytes * row_bytes;
        let copy = |bytes: &[u8], y: u32, height: u32| {
            queue.write_texture(
                wgpu::TexelCopyTextureInfo { texture: &self.texture, mip_level: 0, origin: wgpu::Origin3d { x: 0, y, z: 0 }, aspect: wgpu::TextureAspect::All },
                bytes,
                wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row_bytes as u32), rows_per_image: Some(height) },
                wgpu::Extent3d { width: TABLE_WIDTH, height, depth_or_array_layers: 1 },
            );
        };
        if whole > 0 {
            copy(&data[..whole], 0, (whole / row_bytes) as u32);
        }
        if whole < data.len() {
            self.scratch.clear();
            self.scratch.extend_from_slice(&data[whole..]);
            self.scratch.resize(row_bytes, 0);
            copy(&self.scratch, (whole / row_bytes) as u32, 1);
        }
        replaced
    }
}

/// A table of unsigned integers (the pictures' hash table), read with `textureLoad`.
pub(crate) fn uint_table_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Uint, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false },
        count: None,
    }
}

/// Writes one zero texel to every layer and mip level of `texture`, which has just been made and is to be written by the queue.
///
/// In a browser, `writeTexture` into a texture nothing has used yet is unreliable: a large write is sometimes lost (a picture of
/// the sprite atlas drawn as another's rows: an export of the same document did not always give the same frames), and from
/// shared memory (the engine's) its bytes are read after the call returns. The first use of a texture makes the browser zero it, and
/// a texel written to each layer and level makes that happen before the large write (not waited for: the queue keeps its order).
/// Every texel it writes is zero, as the texture is. Seen with no engine at all (scripts/probe-webgpu-shared-writes.mjs):
/// docs/engine/rendering.md, Uploads.
pub(crate) fn warm_texture(queue: &wgpu::Queue, texture: &wgpu::Texture) {
    let Some(texel) = texture.format().block_copy_size(None) else { return };
    let zero = [0u8; 16];
    for mip in 0..texture.mip_level_count() {
        let size = texture.size().mip_level_size(mip, texture.dimension());
        for layer in 0..size.depth_or_array_layers {
            queue.write_texture(
                wgpu::TexelCopyTextureInfo { texture, mip_level: mip, origin: wgpu::Origin3d { x: size.width - 1, y: size.height - 1, z: layer }, aspect: wgpu::TextureAspect::All },
                &zero[..texel as usize],
                wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(texel), rows_per_image: Some(1) },
                wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
            );
        }
    }
}

pub(crate) fn texture_entry(binding: u32, dimension: wgpu::TextureViewDimension) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: dimension, multisampled: false },
        count: None,
    }
}

pub(crate) fn sampler_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
        count: None,
    }
}

pub(crate) fn array_texture(device: &wgpu::Device, label: &str, size: [u32; 2], layers: u32, attachment: bool) -> (wgpu::Texture, wgpu::TextureView) {
    let mut usage = wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::COPY_SRC;
    if attachment {
        // Effect passes copy layers out of the atlas and back.
        usage |= wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC;
    }
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        // At least two layers: the OpenGL backend (WebGL2) creates a one-layer texture as a
        // plain 2D texture, which a 2D-array sampler then reads as opaque black.
        size: wgpu::Extent3d { width: size[0].max(1), height: size[1].max(1), depth_or_array_layers: layers.max(2) },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: FORMAT,
        usage,
        view_formats: &[],
    });
    let view = texture.create_view(&wgpu::TextureViewDescriptor { dimension: Some(wgpu::TextureViewDimension::D2Array), ..Default::default() });
    (texture, view)
}

pub(crate) fn buffer(device: &wgpu::Device, label: &str, size: u64, usage: wgpu::BufferUsages) -> wgpu::Buffer {
    device.create_buffer(&wgpu::BufferDescriptor { label: Some(label), size: size.max(256), usage, mapped_at_creation: false })
}

pub(crate) fn prims_bytes(prims: &[Prim]) -> &[u8] {
    // `Prim` and `GpuPrim` share one #[repr(C)] layout of 16 four-byte fields.
    const _: () = assert!(std::mem::size_of::<Prim>() == std::mem::size_of::<GpuPrim>());
    unsafe { std::slice::from_raw_parts(prims.as_ptr() as *const u8, std::mem::size_of_val(prims)) }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A layout test of what `warm_texture` writes. It cannot show that it makes a browser's first large write reliable (native
    /// adapters never lost one): scripts/probe-webgpu-shared-writes.mjs does, on a browser's GPU. With no adapter it prints "skipped" and passes.
    #[test]
    fn a_new_texture_is_warmed_with_one_zero_texel_a_layer_and_level_and_nothing_else() {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
        let Ok(adapter) = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())) else {
            eprintln!("skipped: no GPU adapter");
            return;
        };
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).expect("device");
        let (side, layers, mips) = (16u32, 3u32, 3u32);
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: None,
            size: wgpu::Extent3d { width: side, height: side, depth_or_array_layers: layers },
            mip_level_count: mips,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        // Every texel of every level and layer is 0xff first, so what warming writes is what reads back as zero.
        for mip in 0..mips {
            let width = side >> mip;
            queue.write_texture(
                wgpu::TexelCopyTextureInfo { texture: &texture, mip_level: mip, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
                &vec![0xffu8; (width * width * 4 * layers) as usize],
                wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(width * 4), rows_per_image: Some(width) },
                wgpu::Extent3d { width, height: width, depth_or_array_layers: layers },
            );
        }
        warm_texture(&queue, &texture);
        for mip in 0..mips {
            let width = side >> mip;
            let stride = (width * 4).next_multiple_of(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
            for layer in 0..layers {
                let back = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: stride as u64 * width as u64, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
                let mut encoder = device.create_command_encoder(&Default::default());
                encoder.copy_texture_to_buffer(
                    wgpu::TexelCopyTextureInfo { texture: &texture, mip_level: mip, origin: wgpu::Origin3d { x: 0, y: 0, z: layer }, aspect: wgpu::TextureAspect::All },
                    wgpu::TexelCopyBufferInfo { buffer: &back, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(stride), rows_per_image: Some(width) } },
                    wgpu::Extent3d { width, height: width, depth_or_array_layers: 1 },
                );
                queue.submit([encoder.finish()]);
                back.slice(..).map_async(wgpu::MapMode::Read, |result| result.expect("mapped"));
                device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
                let mapped = back.slice(..).get_mapped_range().expect("range");
                for y in 0..width as usize {
                    for x in 0..width as usize {
                        let texel = &mapped[y * stride as usize + x * 4..y * stride as usize + x * 4 + 4];
                        let corner = x == width as usize - 1 && y == width as usize - 1;
                        assert_eq!(texel, if corner { [0u8; 4] } else { [0xffu8; 4] }, "level {mip} layer {layer} texel {x},{y}");
                    }
                }
            }
        }
        // Texels of other sizes: nothing to write for a format with no copy size, and no panic for the others.
        for format in [wgpu::TextureFormat::R32Float, wgpu::TextureFormat::Rgba32Uint, wgpu::TextureFormat::Rg8Unorm] {
            let table = device.create_texture(&wgpu::TextureDescriptor {
                label: None,
                size: wgpu::Extent3d { width: TABLE_WIDTH, height: 2, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format,
                usage: wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            });
            warm_texture(&queue, &table);
        }
        device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
    }
}
