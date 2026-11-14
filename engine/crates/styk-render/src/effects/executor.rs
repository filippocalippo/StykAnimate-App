//! Effect executor: runs effect stacks on layers of the isolation atlas. A layer is copied into a texture, filtered through
//! fragment passes (the recipe's [`Step`]s) and copied back in place.
//!
//! **Pipelines** are one per operation family (`shaders/`), each a small shader created the first time a frame needs it, so a
//! document never compiles what its effects do not use.
//!
//! **Precision**: images between passes (`Texel::Work`) are half floats where the device renders to and filters them
//! (WebGPU and native always; WebGL2 when the host says its context can, [`Executor::new`]), else eight bits, dithered by the
//! shaders. The run's result is eight bits, dithered: the atlas's format.
//!
//! **Textures** are pooled: each frame places its images ([`Placement`]) in textures whose sides are multiples of
//! [`super::recipe::BUCKET`], reusing those of the frame before that have the same size. A texture the frame does not use is
//! released: it is destroyed when the next frame is prepared (the encoder that last used it has been submitted by then), so what
//! one zoom level or one moment needed does not stay for the rest of the session. A pass uses the corner of its texture its image
//! covers.

use std::collections::HashMap;
use std::sync::Arc;

use styk_eval::vfx::Effect;

pub use super::recipe::{Frame, Run, Step};
use super::recipe::{record, Family, Placement, Texel, Uniform, BLANK, INPUT, INPUTS, UNIFORM_BYTES};

const COLOR8: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
const HALF: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;
const SEEDS: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Uint;
/// Uniform record of one pass, at the binding alignment.
const UNIFORM_SIZE: u64 = UNIFORM_BYTES as u64;
const UNIFORM_STRIDE: u64 = 1024;
/// Bindings of the effect shaders (`shaders/common.wgsl`).
const SEEDS_BINDING: u32 = INPUTS as u32;
const SAMPLER_BINDING: u32 = INPUTS as u32 + 1;
const UNIFORM_BINDING: u32 = INPUTS as u32 + 2;

/// The shader of each family: the shared prelude, the helpers it uses, then the family's fragment stage.
fn source(family: Family) -> String {
    let (helpers, own) = match family {
        Family::Reduce => ("", include_str!("shaders/reduce.wgsl")),
        Family::Convolve => ("", include_str!("shaders/convolve.wgsl")),
        Family::Expand => ("", include_str!("shaders/expand.wgsl")),
        Family::Light => ("", include_str!("shaders/light.wgsl")),
        Family::Flood => ("", include_str!("shaders/flood.wgsl")),
        Family::Spread => (include_str!("shaders/distance.wgsl"), include_str!("shaders/spread.wgsl")),
        Family::Outline => (include_str!("shaders/distance.wgsl"), include_str!("shaders/outline.wgsl")),
        Family::Line => ("", include_str!("shaders/line.wgsl")),
        Family::Color => ("", include_str!("shaders/color.wgsl")),
        Family::Noise => (include_str!("shaders/valuenoise.wgsl"), include_str!("shaders/noise.wgsl")),
        Family::Dissolve => (include_str!("shaders/valuenoise.wgsl"), include_str!("shaders/dissolve.wgsl")),
        Family::Turbulence => (include_str!("shaders/valuenoise.wgsl"), include_str!("shaders/turbulence.wgsl")),
        Family::Warp => ("", include_str!("shaders/warp.wgsl")),
        Family::Cells => ("", include_str!("shaders/cells.wgsl")),
    };
    format!("{}\n{helpers}\n{own}", include_str!("shaders/common.wgsl"))
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
    blank_seeds: wgpu::TextureView,
    /// Working images are half floats (else eight bits, dithered).
    float: bool,
    pool: Vec<Pooled>,
    /// Released by the frame before: destroyed when the next frame is prepared.
    retired: Vec<Pooled>,
    created: u64,
    /// The frame's placement: for each run (in the order prepared), the pool texture of each image.
    placed: Vec<Vec<usize>>,
    binds: HashMap<[u64; INPUTS + 1], wgpu::BindGroup>,
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

/// Whether a device renders to and filters half-float colour: WebGPU and the native backends always do; WebGL2 only with
/// `EXT_color_buffer_float`, which the renderer cannot ask its device about (the host's adapter can: `Renderer::set_float_effects`).
pub fn float_by_default(device: &wgpu::Device) -> bool {
    device.adapter_info().backend != wgpu::Backend::Gl
}

/// Bytes of a Work texel on a device whose working images are (`float`) half floats.
pub fn work_bytes(float: bool) -> u64 {
    if float { 8 } else { 4 }
}

impl Executor {
    pub(crate) fn retained_bytes(&self) -> u64 {
        self.stats.slot_bytes.saturating_add(self.uniforms.size()).saturating_add(8)
    }

    /// An executor whose working images are half floats (`float`) or eight bits.
    pub fn new(device: &wgpu::Device, float: bool) -> Executor {
        let texture = |binding: u32, sample_type| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture { sample_type, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false },
            count: None,
        };
        let colour = wgpu::TextureSampleType::Float { filterable: true };
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("styk effects"),
            entries: &[
                texture(0, colour),
                texture(1, colour),
                texture(2, colour),
                texture(3, colour),
                texture(SEEDS_BINDING, wgpu::TextureSampleType::Uint),
                wgpu::BindGroupLayoutEntry { binding: SAMPLER_BINDING, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
                wgpu::BindGroupLayoutEntry {
                    binding: UNIFORM_BINDING,
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
        let blank = |format, label| {
            device
                .create_texture(&wgpu::TextureDescriptor {
                    label: Some(label),
                    size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format,
                    usage: wgpu::TextureUsages::TEXTURE_BINDING,
                    view_formats: &[],
                })
                .create_view(&Default::default())
        };
        Executor {
            layout,
            pipeline_layout,
            pipelines: HashMap::new(),
            sampler,
            uniforms: device.create_buffer(&wgpu::BufferDescriptor { label: Some("styk effect passes"), size: UNIFORM_STRIDE * 64, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false }),
            uniform_slots: 64,
            blank: blank(COLOR8, "styk effects blank"),
            blank_seeds: blank(SEEDS, "styk effects blank seeds"),
            float,
            pool: Vec::new(),
            retired: Vec::new(),
            created: 0,
            placed: Vec::new(),
            binds: HashMap::new(),
            records: Vec::new(),
            stats: Stats::default(),
        }
    }

    /// Whether working images are half floats.
    pub fn float(&self) -> bool {
        self.float
    }

    fn format(&self, texel: Texel) -> wgpu::TextureFormat {
        match texel {
            Texel::Color8 => COLOR8,
            Texel::Work if self.float => HALF,
            Texel::Work => COLOR8,
            Texel::Seeds => SEEDS,
        }
    }

    /// Records `stack` on a `size` layer (image 0) into the executor's own records, for a frame prepared with
    /// [`Executor::prepare_own`].
    pub fn record(&mut self, stack: &[Arc<Effect>], frame: Frame, size: [u32; 2]) -> Run {
        record(&mut self.records, stack, frame, size)
    }

    /// Prepares the frame's recorded runs with the records [`Executor::record`] collected.
    pub fn prepare_own(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, runs: &[&Run]) {
        let records = std::mem::take(&mut self.records);
        self.prepare(device, queue, records, runs);
    }

    /// Prepares a frame: its runs' images placed in the pool (textures of earlier frames reused, those it does not use released),
    /// the pipelines its passes need created, the uniforms written. `runs` are then encoded by their position here. A frame
    /// without runs releases every texture.
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
                        format: self.format(texel),
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
        for (run, placed) in runs.iter().zip(&self.placed) {
            for step in &run.steps {
                let record = &mut records[step.uniform as usize];
                for (k, &image) in step.inputs.iter().enumerate() {
                    if image != BLANK {
                        let size = self.pool[placed[image as usize]].size;
                        record.inputs[k][0] = 1.0 / size[0] as f32;
                        record.inputs[k][1] = 1.0 / size[1] as f32;
                    }
                }
                let target = self.format(run.images[step.target as usize].texel);
                record.dither = if target == COLOR8 { 1.0 } else { 0.0 };
                let family = Family::of(step.op);
                if !self.pipelines.contains_key(&(family, target)) {
                    let pipeline = self.pipeline(device, family, target);
                    self.pipelines.insert((family, target), pipeline);
                    self.stats.pipelines += 1;
                }
            }
        }
        let work = work_bytes(self.float);
        self.stats.slot_bytes = self.pool.iter().chain(&self.retired).map(|p| p.size[0] as u64 * p.size[1] as u64 * super::recipe::texel_bytes(p.texel, work)).sum();
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

    /// The bind group of a pass reading pool textures `inputs` (`None`: a blank); a seeds image is bound to the seeds binding.
    fn bind(&mut self, device: &wgpu::Device, inputs: [Option<usize>; INPUTS]) -> wgpu::BindGroup {
        let seeds = inputs.iter().flatten().find(|&&t| self.pool[t].texel == Texel::Seeds).copied();
        let colour = inputs.map(|t| t.filter(|&t| self.pool[t].texel != Texel::Seeds));
        let id = |t: Option<usize>| t.map_or(0, |t| self.pool[t].id);
        let key = [id(colour[0]), id(colour[1]), id(colour[2]), id(colour[3]), id(seeds)];
        if let Some(bind) = self.binds.get(&key) {
            return bind.clone();
        }
        let view = |t: Option<usize>| t.map_or(&self.blank, |t| &self.pool[t].view);
        let seeds_view = seeds.map_or(&self.blank_seeds, |t| &self.pool[t].view);
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("styk effect pass"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(view(colour[0])) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(view(colour[1])) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(view(colour[2])) },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(view(colour[3])) },
                wgpu::BindGroupEntry { binding: SEEDS_BINDING, resource: wgpu::BindingResource::TextureView(seeds_view) },
                wgpu::BindGroupEntry { binding: SAMPLER_BINDING, resource: wgpu::BindingResource::Sampler(&self.sampler) },
                wgpu::BindGroupEntry {
                    binding: UNIFORM_BINDING,
                    resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding { buffer: &self.uniforms, offset: 0, size: wgpu::BufferSize::new(UNIFORM_SIZE) }),
                },
            ],
        });
        self.binds.insert(key, bind.clone());
        bind
    }

    /// Encodes run `index` of the prepared frame on the layer at `place` (its top-left texel on an atlas page): the layer copied
    /// into its input texture, the passes, the result copied back in place.
    pub fn encode(&mut self, device: &wgpu::Device, encoder: &mut wgpu::CommandEncoder, index: usize, run: &Run, place: wgpu::TexelCopyTextureInfo<'_>) {
        if run.steps.is_empty() {
            return;
        }
        let placed = self.placed[index].clone();
        let extent = wgpu::Extent3d { width: run.size[0], height: run.size[1], depth_or_array_layers: 1 };
        encoder.copy_texture_to_texture(place, self.pool[placed[INPUT as usize]].texture.as_image_copy(), extent);
        for step in &run.steps {
            let bind = self.bind(device, step.inputs.map(|image| (image != BLANK).then(|| placed[image as usize])));
            let image = run.images[step.target as usize];
            let pipeline = &self.pipelines[&(Family::of(step.op), self.format(image.texel))];
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("styk effect pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &self.pool[placed[step.target as usize]].view,
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
            pass.set_bind_group(0, &bind, &[(step.uniform as u64 * UNIFORM_STRIDE) as u32]);
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
