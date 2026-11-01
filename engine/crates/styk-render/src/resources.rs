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
            replaced = true;
        }
        if data.is_empty() {
            return replaced;
        }
        // The last row is padded: a texture write covers whole rows.
        let whole = data.len() / row_bytes * row_bytes;
        let copy = |bytes: &[u8], y: u32, height: u32| {
            write_texture(
                device,
                queue,
                wgpu::TexelCopyTextureInfo { texture: &self.texture, mip_level: 0, origin: wgpu::Origin3d { x: 0, y, z: 0 }, aspect: wgpu::TextureAspect::All },
                bytes,
                row_bytes as u32,
                height,
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

/// Writes of at least this many bytes go through a staging buffer ([`write_buffer`], [`write_texture`]).
const STAGED_FROM: usize = 64 << 10;

/// A buffer of `size` bytes (a multiple of 4) the CPU fills now, to be copied from on the GPU.
pub(crate) fn staging(device: &wgpu::Device, size: u64) -> wgpu::Buffer {
    device.create_buffer(&wgpu::BufferDescriptor { label: Some("styk staging"), size, usage: wgpu::BufferUsages::COPY_SRC, mapped_at_creation: true })
}

thread_local! {
    /// Staging buffers the GPU may still read, each with the flag its queue sets once it has finished with them.
    static RETIRING: std::cell::RefCell<Vec<(std::sync::Arc<std::sync::atomic::AtomicBool>, wgpu::Buffer)>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Gives back the staging buffers the GPU has finished with (WebGPU frees a buffer on `destroy`, not when its last handle is
/// dropped). Called with every staged write and every frame, on the thread that made them.
pub(crate) fn retire_staging() {
    RETIRING.with(|retiring| {
        retiring.borrow_mut().retain(|(done, buffer)| {
            let finished = done.load(std::sync::atomic::Ordering::Acquire);
            if finished {
                buffer.destroy();
            }
            !finished
        });
    });
}

/// Submits `encoder`, whose copies read `source`, and keeps `source` until the GPU has finished with it ([`retire_staging`]).
pub(crate) fn submit_staged(queue: &wgpu::Queue, encoder: wgpu::CommandEncoder, source: wgpu::Buffer) {
    queue.submit([encoder.finish()]);
    let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flag = done.clone();
    queue.on_submitted_work_done(move || flag.store(true, std::sync::atomic::Ordering::Release));
    retire_staging();
    RETIRING.with(|retiring| retiring.borrow_mut().push((done, source)));
}

/// `Queue::write_buffer`, except that a large write is copied on the GPU from a staging buffer this fills itself.
///
/// A browser's `writeBuffer` and `writeTexture` from the engine's shared memory sometimes leave part of a large write
/// out: an export of the same document did not always give the same frames, with pictures drawn from rows of other
/// bytes (docs/engine/rendering.md, Exports). Native adapters never showed it.
pub(crate) fn write_buffer(device: &wgpu::Device, queue: &wgpu::Queue, buffer: &wgpu::Buffer, offset: u64, data: &[u8]) {
    let size = data.len().next_multiple_of(wgpu::COPY_BUFFER_ALIGNMENT as usize) as u64;
    if data.len() < STAGED_FROM || offset % wgpu::COPY_BUFFER_ALIGNMENT != 0 || offset + size > buffer.size() {
        queue.write_buffer(buffer, offset, data);
        return;
    }
    let source = staging(device, size);
    source.slice(..).get_mapped_range_mut().expect("a buffer made mapped is mapped").slice(..data.len()).copy_from_slice(data);
    source.unmap();
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("styk staged write") });
    encoder.copy_buffer_to_buffer(&source, 0, buffer, offset, size);
    submit_staged(queue, encoder, source);
}

/// `Queue::write_texture` of `rows` rows of `row_bytes` bytes (`data`), staged as [`write_buffer`] stages.
pub(crate) fn write_texture(device: &wgpu::Device, queue: &wgpu::Queue, texture: wgpu::TexelCopyTextureInfo<'_>, data: &[u8], row_bytes: u32, rows: u32, extent: wgpu::Extent3d) {
    if data.len() < STAGED_FROM {
        queue.write_texture(texture, data, wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row_bytes), rows_per_image: Some(rows) }, extent);
        return;
    }
    let stride = row_bytes.next_multiple_of(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
    let source = staging(device, stride as u64 * rows as u64);
    {
        let mut mapped = source.slice(..).get_mapped_range_mut().expect("a buffer made mapped is mapped");
        for (y, row) in data.chunks_exact(row_bytes as usize).enumerate() {
            mapped.slice(y * stride as usize..y * stride as usize + row_bytes as usize).copy_from_slice(row);
        }
    }
    source.unmap();
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("styk staged write") });
    encoder.copy_buffer_to_texture(
        wgpu::TexelCopyBufferInfo { buffer: &source, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(stride), rows_per_image: Some(rows) } },
        texture,
        extent,
    );
    submit_staged(queue, encoder, source);
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
