//! Effect executor: runs an effect stack on one layer of the isolation atlas,
//! pass for pass as the editor's WebGPU executor does (`VfxWebGPU.run` in
//! src/vfx-webgpu.mjs). The layer is copied into a working slot, filtered
//! through fragment passes (`passes.wgsl`) and copied back in place. What the
//! passes are is the stack's recipe ([`super::recipe`]); this encodes it.
//!
//! Working slots are pooled: eight textures of one size, grown to the largest
//! layer a frame filters and kept across frames, so a steady animation creates
//! no texture. A pass uses the top-left corner of its slot.

use std::collections::HashMap;
use std::sync::Arc;

use styk_eval::vfx::Effect;

pub use super::recipe::{Frame, Run, Step};
use super::recipe::{record, Uniform, BLANK, SLOTS};

const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
/// Uniform record of one pass (`Params` in passes.wgsl), padded to the binding alignment.
const UNIFORM_SIZE: u64 = 736;
const UNIFORM_STRIDE: u64 = 768;

const _: () = assert!(std::mem::size_of::<Uniform>() as u64 == UNIFORM_SIZE);

/// Records runs for one frame, then encodes them.
pub struct Executor {
    pipeline: wgpu::RenderPipeline,
    layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    uniforms: wgpu::Buffer,
    uniform_slots: u64,
    blank: wgpu::TextureView,
    slots: Vec<Option<(wgpu::Texture, wgpu::TextureView)>>,
    /// Size every slot is allocated at.
    pub slot_size: [u32; 2],
    binds: HashMap<(u8, u8, u8), wgpu::BindGroup>,
    /// Uniform records of the frame being recorded.
    records: Vec<Uniform>,
    /// Frames since one needed slots of the current size (shrinks after a while).
    idle: u32,
    pub stats: Stats,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Stats {
    pub layers: u32,
    pub passes: u32,
    pub slot_bytes: u64,
}

impl Executor {
    pub fn new(device: &wgpu::Device) -> Executor {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("styk effects"), source: wgpu::ShaderSource::Wgsl(include_str!("passes.wgsl").into()) });
        let texture = |binding: u32| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false },
            count: None,
        };
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("styk effects"),
            entries: &[
                texture(0),
                texture(1),
                texture(2),
                wgpu::BindGroupLayoutEntry { binding: 3, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
                wgpu::BindGroupLayoutEntry {
                    binding: 4,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: true, min_binding_size: wgpu::BufferSize::new(UNIFORM_SIZE) },
                    count: None,
                },
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("styk effects"), bind_group_layouts: &[Some(&layout)], immediate_size: 0 });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("styk effects"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState { module: &shader, entry_point: Some("vertex"), compilation_options: Default::default(), buffers: &[] },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fragment"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState { format: FORMAT, blend: None, write_mask: wgpu::ColorWrites::ALL })],
            }),
            multiview_mask: None,
            cache: None,
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("styk effects"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let blank = device
            .create_texture(&wgpu::TextureDescriptor {
                label: Some("styk effects blank"),
                size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: FORMAT,
                usage: wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            })
            .create_view(&Default::default());
        Executor {
            pipeline,
            layout,
            sampler,
            uniforms: device.create_buffer(&wgpu::BufferDescriptor { label: Some("styk effect passes"), size: UNIFORM_STRIDE * 64, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false }),
            uniform_slots: 64,
            blank,
            slots: (0..SLOTS).map(|_| None).collect(),
            slot_size: [0, 0],
            binds: HashMap::new(),
            records: Vec::new(),
            idle: 0,
            stats: Stats::default(),
        }
    }

    /// Starts a frame's recording.
    pub fn begin(&mut self) {
        self.records.clear();
        self.stats = Stats { slot_bytes: self.stats.slot_bytes, ..Default::default() };
    }

    /// Records `stack` on a `size` layer (in slot 0). Mirrors `VfxWebGPU.run`.
    pub fn record(&mut self, stack: &[Arc<Effect>], frame: Frame, size: [u32; 2]) -> Run {
        let run = record(&mut self.records, stack, frame, size);
        self.stats.layers += 1;
        run
    }

    /// Prepares the frame's recorded runs: slots of at least `largest`, uniforms written.
    pub fn prepare(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, largest: [u32; 2]) {
        if largest[0] == 0 || largest[1] == 0 {
            // No effect this frame: release the slots after a while (a quiet period).
            self.idle += 1;
            if self.idle > 240 && self.slots.iter().any(Option::is_some) {
                self.release();
            }
            return;
        }
        let bucket = |n: u32| n.div_ceil(256) * 256;
        let fits = self.slot_size[0] >= largest[0] && self.slot_size[1] >= largest[1];
        // Shrink when this frame needs less than a quarter of the area for a while.
        let small = (largest[0] as u64 * largest[1] as u64) * 4 < self.slot_size[0] as u64 * self.slot_size[1] as u64;
        self.idle = if fits && small { self.idle + 1 } else { 0 };
        if !fits || self.idle > 240 {
            let size = if fits { [bucket(largest[0]), bucket(largest[1])] } else { [bucket(largest[0]).max(self.slot_size[0]), bucket(largest[1]).max(self.slot_size[1])] };
            self.release();
            self.slot_size = size;
            self.idle = 0;
        }
        let texel = [1.0 / self.slot_size[0].max(1) as f32, 1.0 / self.slot_size[1].max(1) as f32];
        for record in &mut self.records {
            record.texel = texel;
        }
        let need = self.records.len() as u64;
        if need > self.uniform_slots {
            self.uniform_slots = need.next_power_of_two();
            self.uniforms = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("styk effect passes"),
                size: UNIFORM_STRIDE * self.uniform_slots,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            self.binds.clear();
        }
        if need > 0 {
            let mut bytes = vec![0u8; (UNIFORM_STRIDE * need) as usize];
            for (i, record) in self.records.iter().enumerate() {
                let o = i * UNIFORM_STRIDE as usize;
                bytes[o..o + UNIFORM_SIZE as usize].copy_from_slice(bytemuck::bytes_of(record));
            }
            queue.write_buffer(&self.uniforms, 0, &bytes);
        }
    }

    fn release(&mut self) {
        for slot in &mut self.slots {
            if let Some((texture, _)) = slot.take() {
                texture.destroy();
            }
        }
        self.binds.clear();
        self.slot_size = [0, 0];
        self.stats.slot_bytes = 0;
    }

    fn slot(&mut self, device: &wgpu::Device, index: u8) -> &wgpu::TextureView {
        let size = self.slot_size;
        if self.slots[index as usize].is_none() {
            let texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("styk effect slot"),
                size: wgpu::Extent3d { width: size[0], height: size[1], depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: FORMAT,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            });
            let view = texture.create_view(&Default::default());
            self.stats.slot_bytes += size[0] as u64 * size[1] as u64 * 4;
            self.slots[index as usize] = Some((texture, view));
        }
        &self.slots[index as usize].as_ref().unwrap().1
    }

    /// The texture of slot `index` (allocated on demand).
    pub fn slot_texture(&mut self, device: &wgpu::Device, index: u8) -> &wgpu::Texture {
        self.slot(device, index);
        &self.slots[index as usize].as_ref().unwrap().0
    }

    fn bind(&mut self, device: &wgpu::Device, source: u8, original: u8, mask: u8) -> wgpu::BindGroup {
        if let Some(bind) = self.binds.get(&(source, original, mask)) {
            return bind.clone();
        }
        for index in [source, original, mask] {
            if index != BLANK {
                self.slot(device, index);
            }
        }
        let view = |index: u8| if index == BLANK { &self.blank } else { &self.slots[index as usize].as_ref().unwrap().1 };
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("styk effect pass"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(view(source)) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(view(original)) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(view(mask)) },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::Sampler(&self.sampler) },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding { buffer: &self.uniforms, offset: 0, size: wgpu::BufferSize::new(UNIFORM_SIZE) }),
                },
            ],
        });
        self.binds.insert((source, original, mask), bind.clone());
        bind
    }

    /// Encodes the steps of `run` (after [`Executor::prepare`]).
    pub fn encode(&mut self, device: &wgpu::Device, encoder: &mut wgpu::CommandEncoder, run: &Run) {
        for step in &run.steps {
            match *step {
                Step::Copy { from, to, size } => {
                    self.slot(device, from);
                    self.slot(device, to);
                    let (a, b) = (&self.slots[from as usize].as_ref().unwrap().0, &self.slots[to as usize].as_ref().unwrap().0);
                    encoder.copy_texture_to_texture(a.as_image_copy(), b.as_image_copy(), wgpu::Extent3d { width: size[0], height: size[1], depth_or_array_layers: 1 });
                }
                Step::Pass { operation: _, source, source_size: _, target, size, original, mask, uniform } => {
                    let bind = self.bind(device, source, original, mask);
                    let view = self.slot(device, target).clone();
                    let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                        label: Some("styk effect pass"),
                        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                            view: &view,
                            depth_slice: None,
                            resolve_target: None,
                            ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store },
                        })],
                        depth_stencil_attachment: None,
                        timestamp_writes: None,
                        occlusion_query_set: None,
                        multiview_mask: None,
                    });
                    pass.set_viewport(0.0, 0.0, size[0] as f32, size[1] as f32, 0.0, 1.0);
                    pass.set_scissor_rect(0, 0, size[0], size[1]);
                    pass.set_pipeline(&self.pipeline);
                    pass.set_bind_group(0, &bind, &[(uniform as u64 * UNIFORM_STRIDE) as u32]);
                    pass.draw(0..3, 0..1);
                    self.stats.passes += 1;
                }
            }
        }
    }
}
