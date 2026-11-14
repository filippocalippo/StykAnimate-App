//! Effect executor: runs effect stacks on layers of the isolation atlas. A layer is copied
//! into a texture, filtered through fragment passes (the recipe's [`Step`]s) and copied back
//! in place.
//!
//! **Pipelines** are one per operation family (`shaders/`), each a small shader created the
//! first time a frame needs it, so a document never compiles what its effects do not use.
//!
//! **Textures** are pooled: each frame places its images ([`Placement`]) in textures whose
//! sides are multiples of [`super::recipe::BUCKET`], reusing those of the frame before that
//! have the same size. A texture the frame does not use is released: it is destroyed when the
//! next frame is prepared (the encoder that last used it has been submitted by then), so what
//! one zoom level or one moment needed does not stay for the rest of the session. A pass uses
//! the corner of its texture its image covers.

use std::collections::HashMap;
use std::sync::Arc;

use styk_eval::vfx::Effect;

pub use super::recipe::{Frame, Run, Step};
use super::recipe::{record, Family, Placement, Texel, Uniform, BLANK, INPUT};

const COLOR8: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
/// Uniform record of one pass (`Params` in the effect shaders), padded to the binding alignment.
const UNIFORM_SIZE: u64 = 736;
const UNIFORM_STRIDE: u64 = 768;

const _: () = assert!(std::mem::size_of::<Uniform>() as u64 == UNIFORM_SIZE);

/// The shader of each family: the shared prelude, then the family's fragment stage.
fn source(family: Family) -> String {
    let own = match family {
        Family::Color => include_str!("shaders/color.wgsl"),
        Family::Box => include_str!("shaders/box.wgsl"),
        Family::Dilate => include_str!("shaders/dilate.wgsl"),
        Family::Composite => include_str!("shaders/composite.wgsl"),
        Family::Resample => include_str!("shaders/resample.wgsl"),
        Family::Warp => include_str!("shaders/warp.wgsl"),
    };
    format!("{}\n{own}", include_str!("shaders/common.wgsl"))
}

fn format(texel: Texel) -> wgpu::TextureFormat {
    match texel {
        Texel::Color8 => COLOR8,
    }
}

/// A texture of the pool.
struct Pooled {
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    size: [u32; 2],
    texel: Texel,
    /// Distinct for every texture the executor creates (bind groups are kept by it).
    id: u64,
}

/// Runs recorded runs of one frame on the GPU.
pub struct Executor {
    layout: wgpu::BindGroupLayout,
    pipeline_layout: wgpu::PipelineLayout,
    pipelines: HashMap<(Family, wgpu::TextureFormat), wgpu::RenderPipeline>,
    sampler: wgpu::Sampler,
    uniforms: wgpu::Buffer,
    uniform_slots: u64,
    blank: wgpu::TextureView,
    pool: Vec<Pooled>,
    /// Released by the frame before: destroyed when the next frame is prepared.
    retired: Vec<Pooled>,
    created: u64,
    /// The frame's placement: for each run (in the order prepared), the pool texture of each image.
    placed: Vec<Vec<usize>>,
    binds: HashMap<(u64, u64, u64), wgpu::BindGroup>,
    /// Uniform records of the frame being prepared.
    records: Vec<Uniform>,
    pub stats: Stats,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Stats {
    pub layers: u32,
    pub passes: u32,
    /// Bytes of the pool's textures (those released but not yet destroyed included).
    pub slot_bytes: u64,
    /// Effect pipelines created so far.
    pub pipelines: u32,
}

impl Executor {
    pub(crate) fn retained_bytes(&self) -> u64 {
        self.stats.slot_bytes.saturating_add(self.uniforms.size()).saturating_add(4)
    }

    pub fn new(device: &wgpu::Device) -> Executor {
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
                format: COLOR8,
                usage: wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            })
            .create_view(&Default::default());
        Executor {
            layout,
            pipeline_layout,
            pipelines: HashMap::new(),
            sampler,
            uniforms: device.create_buffer(&wgpu::BufferDescriptor { label: Some("styk effect passes"), size: UNIFORM_STRIDE * 64, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false }),
            uniform_slots: 64,
            blank,
            pool: Vec::new(),
            retired: Vec::new(),
            created: 0,
            placed: Vec::new(),
            binds: HashMap::new(),
            records: Vec::new(),
            stats: Stats::default(),
        }
    }

    /// Records `stack` on a `size` layer (image 0) into the executor's own records, for a frame
    /// prepared with [`Executor::prepare_own`]. Mirrors `VfxWebGPU.run`.
    pub fn record(&mut self, stack: &[Arc<Effect>], frame: Frame, size: [u32; 2]) -> Run {
        record(&mut self.records, stack, frame, size)
    }

    /// Prepares the frame's recorded runs with the records [`Executor::record`] collected.
    pub fn prepare_own(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, runs: &[&Run]) {
        let records = std::mem::take(&mut self.records);
        self.prepare(device, queue, records, runs);
    }

    /// Prepares a frame: its runs' images placed in the pool (textures of earlier frames reused,
    /// those it does not use released), the pipelines its passes need created, the uniforms
    /// written. `runs` are then encoded by their position here. A frame without runs releases
    /// every texture.
    pub fn prepare(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, mut records: Vec<Uniform>, runs: &[&Run]) {
        for p in self.retired.drain(..) {
            p.texture.destroy();
        }
        self.stats = Stats { layers: runs.len() as u32, pipelines: self.stats.pipelines, ..Default::default() };
        let placement = Placement::of(runs);
        // Each texture the frame needs takes a pooled one of its size, or a new one.
        let mut pool: Vec<Option<Pooled>> = std::mem::take(&mut self.pool).into_iter().map(Some).collect();
        let mut kept: Vec<Pooled> = Vec::with_capacity(placement.textures.len());
        for &(size, texel) in &placement.textures {
            match pool.iter_mut().find(|p| p.as_ref().is_some_and(|p| p.size == size && p.texel == texel)) {
                Some(found) => kept.push(found.take().expect("found")),
                None => {
                    let texture = device.create_texture(&wgpu::TextureDescriptor {
                        label: Some("styk effect slot"),
                        size: wgpu::Extent3d { width: size[0], height: size[1], depth_or_array_layers: 1 },
                        mip_level_count: 1,
                        sample_count: 1,
                        dimension: wgpu::TextureDimension::D2,
                        format: format(texel),
                        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::COPY_DST,
                        view_formats: &[],
                    });
                    let view = texture.create_view(&Default::default());
                    self.created += 1;
                    kept.push(Pooled { texture, view, size, texel, id: self.created });
                }
            }
        }
        // Bind groups name textures by id; those of released textures are never asked for again.
        self.retired.extend(pool.into_iter().flatten());
        if !self.retired.is_empty() {
            self.binds.clear();
        }
        self.pool = kept;
        self.placed = placement.images.iter().map(|images| images.iter().map(|&t| t as usize).collect()).collect();
        let texel_of = |p: &Pooled| [1.0 / p.size[0] as f32, 1.0 / p.size[1] as f32];
        for (run, placed) in runs.iter().zip(&self.placed) {
            for step in &run.steps {
                let Step::Pass { operation, source, original, mask, uniform, .. } = *step;
                let record = &mut records[uniform as usize];
                record.texel = texel_of(&self.pool[placed[source as usize]]);
                let other = if original != BLANK { original } else { mask };
                if other != BLANK {
                    record.texel_other = texel_of(&self.pool[placed[other as usize]]);
                }
                let family = Family::of(operation);
                let target = format(run.images[step.target() as usize].texel);
                if !self.pipelines.contains_key(&(family, target)) {
                    let pipeline = self.pipeline(device, family, target);
                    self.pipelines.insert((family, target), pipeline);
                    self.stats.pipelines += 1;
                }
            }
        }
        let bytes = |size: [u32; 2], texel: Texel| size[0] as u64 * size[1] as u64 * super::recipe::texel_bytes(texel);
        self.stats.slot_bytes = self.pool.iter().chain(&self.retired).map(|p| bytes(p.size, p.texel)).sum::<u64>();
        let need = records.len() as u64;
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
            for (i, record) in records.iter().enumerate() {
                let o = i * UNIFORM_STRIDE as usize;
                bytes[o..o + UNIFORM_SIZE as usize].copy_from_slice(bytemuck::bytes_of(record));
            }
            queue.write_buffer(&self.uniforms, 0, &bytes);
        }
    }

    fn pipeline(&self, device: &wgpu::Device, family: Family, target: wgpu::TextureFormat) -> wgpu::RenderPipeline {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("styk effects"), source: wgpu::ShaderSource::Wgsl(source(family).into()) });
        device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("styk effects"),
            layout: Some(&self.pipeline_layout),
            vertex: wgpu::VertexState { module: &shader, entry_point: Some("vertex"), compilation_options: Default::default(), buffers: &[] },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fragment"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState { format: target, blend: None, write_mask: wgpu::ColorWrites::ALL })],
            }),
            multiview_mask: None,
            cache: None,
        })
    }

    fn bind(&mut self, device: &wgpu::Device, textures: [Option<usize>; 3]) -> wgpu::BindGroup {
        let id = |t: Option<usize>| t.map_or(0, |t| self.pool[t].id);
        let key = (id(textures[0]), id(textures[1]), id(textures[2]));
        if let Some(bind) = self.binds.get(&key) {
            return bind.clone();
        }
        let view = |t: Option<usize>| t.map_or(&self.blank, |t| &self.pool[t].view);
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("styk effect pass"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(view(textures[0])) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(view(textures[1])) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(view(textures[2])) },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::Sampler(&self.sampler) },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding { buffer: &self.uniforms, offset: 0, size: wgpu::BufferSize::new(UNIFORM_SIZE) }),
                },
            ],
        });
        self.binds.insert(key, bind.clone());
        bind
    }

    /// Encodes run `index` of the prepared frame on the layer at `place` (its top-left texel on an
    /// atlas page): the layer copied into its input texture, the passes, the result copied back in
    /// place.
    pub fn encode(&mut self, device: &wgpu::Device, encoder: &mut wgpu::CommandEncoder, index: usize, run: &Run, place: wgpu::TexelCopyTextureInfo<'_>) {
        if run.steps.is_empty() {
            return;
        }
        let placed = self.placed[index].clone();
        let extent = wgpu::Extent3d { width: run.size[0], height: run.size[1], depth_or_array_layers: 1 };
        encoder.copy_texture_to_texture(place, self.pool[placed[INPUT as usize]].texture.as_image_copy(), extent);
        for step in &run.steps {
            let Step::Pass { operation, source, target, original, mask, uniform } = *step;
            let texture = |image: u16| (image != BLANK).then(|| placed[image as usize]);
            let bind = self.bind(device, [texture(source), texture(original), texture(mask)]);
            let image = run.images[target as usize];
            let pipeline = &self.pipelines[&(Family::of(operation), format(image.texel))];
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("styk effect pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &self.pool[placed[target as usize]].view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_viewport(0.0, 0.0, image.size[0] as f32, image.size[1] as f32, 0.0, 1.0);
            pass.set_scissor_rect(0, 0, image.size[0], image.size[1]);
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, &bind, &[(uniform as u64 * UNIFORM_STRIDE) as u32]);
            pass.draw(0..3, 0..1);
            self.stats.passes += 1;
        }
        encoder.copy_texture_to_texture(self.pool[placed[run.result as usize]].texture.as_image_copy(), place, extent);
    }
}

impl Drop for Executor {
    fn drop(&mut self) {
        for p in self.retired.drain(..).chain(self.pool.drain(..)) {
            p.texture.destroy();
        }
    }
}
