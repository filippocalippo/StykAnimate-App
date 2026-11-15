//! Effect executor: runs effect stacks on layers of the isolation atlas. A layer is copied into a texture, filtered through
//! fragment passes (the recipe's [`Step`]s) and copied back in place.
//!
//! **Pipelines** are one per operation and the options its shader branches on ([`Variant`]): the family's shader (`shaders/`)
//! with those fixed as constants, so each compiles only its own code. A pipeline is created the first time a frame needs it, so a
//! document never compiles what its effects do not use. On WebGL2 the browser compiles on the interface thread, tens of
//! milliseconds a pipeline: there a frame may create only a few ([`Executor::set_compile_limit`]), its other filtered layers drawn
//! unfiltered until a later frame has their pipelines ([`Executor::pending`]).
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
use super::recipe::{record, Family, Placement, Texel, Uniform, Variant, BLANK, INPUT, INPUTS, UNIFORM_BYTES};

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

/// The shader of a variant: its constants, the shared prelude, the helpers its family uses, then the family's fragment stage.
pub fn source(variant: &Variant) -> String {
    let (helpers, own) = match Family::of(variant.op) {
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
    format!("{}{}\n{helpers}\n{own}", variant.constants(), include_str!("shaders/common.wgsl"))
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
    /// Pipelines created, by variant and target format (an index into `compiled`).
    pipelines: HashMap<(Variant, wgpu::TextureFormat), usize>,
    compiled: Vec<wgpu::RenderPipeline>,
    /// Pipelines a frame may create (`None`: every one it needs).
    compile_limit: Option<u32>,
    /// The device compiles on the thread that draws (WebGL2, GL).
    slow_compiles: bool,
    /// For each run of the frame, the pipeline of each pass, or `None` while one is still to be created.
    passes: Vec<Option<Vec<usize>>>,
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
    /// Bytes of the textures the frame placed its images in.
    pub slot_bytes: u64,
    /// Bytes of the textures the frame released, destroyed when the next frame is prepared.
    pub released_bytes: u64,
    /// Effect pipelines created so far.
    pub pipelines: u32,
    /// Runs of the frame drawn unfiltered because a pipeline they need is still to be created.
    pub waiting: u32,
}

/// Whether a device renders to and filters half-float colour: WebGPU and the native backends always do; WebGL2 only with
/// `EXT_color_buffer_float`, which the renderer cannot ask its device about (the host's adapter can: [`float_supported`]).
pub fn float_by_default(device: &wgpu::Device) -> bool {
    device.adapter_info().backend != wgpu::Backend::Gl
}

/// Whether `adapter`'s devices render to, sample and filter half-float colour, as the working images need: always on WebGPU and
/// the native backends; on WebGL2 where the context has `EXT_color_buffer_float` (or the half-float one), which wgpu reports as
/// `Rgba16Float`'s features. Every host that draws effects on such a device passes it to `Renderer::set_float_effects`.
pub fn float_supported(adapter: &wgpu::Adapter) -> bool {
    if adapter.get_info().backend != wgpu::Backend::Gl {
        return true;
    }
    let features = adapter.get_texture_format_features(HALF);
    features.allowed_usages.contains(wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING) && features.flags.contains(wgpu::TextureFormatFeatureFlags::FILTERABLE)
}

/// Bytes of a Work texel on a device whose working images are (`float`) half floats.
pub fn work_bytes(float: bool) -> u64 {
    if float { 8 } else { 4 }
}

impl Executor {
    pub(crate) fn retained_bytes(&self) -> u64 {
        self.stats.slot_bytes.saturating_add(self.stats.released_bytes).saturating_add(self.uniforms.size()).saturating_add(8)
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
            compiled: Vec::new(),
            compile_limit: None,
            slow_compiles: device.adapter_info().backend == wgpu::Backend::Gl,
            passes: Vec::new(),
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

    /// Whether the device compiles a pipeline on the thread that draws (WebGL2: the interface thread), so that a frame should
    /// create few ([`Executor::set_compile_limit`]).
    pub fn slow_compiles(&self) -> bool {
        self.slow_compiles
    }

    /// Limits the pipelines a frame creates to `limit` (`None`: every one it needs). A run whose pipelines are not all there
    /// yet is not encoded: its layer stays as drawn, unfiltered, and [`Executor::pending`] says to draw again.
    pub fn set_compile_limit(&mut self, limit: Option<u32>) {
        self.compile_limit = limit;
    }

    /// Whether the frame prepared last drew a filtered layer unfiltered because its pipelines were still to be created.
    pub fn pending(&self) -> bool {
        self.stats.waiting > 0
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
        let mut budget = self.compile_limit.unwrap_or(u32::MAX);
        self.passes.clear();
        for (run, placed) in runs.iter().zip(&self.placed) {
            let mut passes = Some(Vec::with_capacity(run.steps.len()));
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
                let key = (Variant::of(step.op, record), target);
                let pipeline = match self.pipelines.get(&key) {
                    Some(&index) => Some(index),
                    None if budget > 0 => {
                        budget -= 1;
                        let pipeline = self.pipeline(device, &key.0, target);
                        self.compiled.push(pipeline);
                        self.pipelines.insert(key, self.compiled.len() - 1);
                        self.stats.pipelines += 1;
                        Some(self.compiled.len() - 1)
                    }
                    None => None,
                };
                match (pipeline, &mut passes) {
                    (Some(index), Some(passes)) => passes.push(index),
                    _ => passes = None,
                }
            }
            if passes.is_none() {
                self.stats.waiting += 1;
            }
            self.passes.push(passes);
        }
        let work = work_bytes(self.float);
        let bytes = |p: &Pooled| p.size[0] as u64 * p.size[1] as u64 * super::recipe::texel_bytes(p.texel, work);
        self.stats.slot_bytes = self.pool.iter().map(bytes).sum();
        self.stats.released_bytes = self.retired.iter().map(bytes).sum();
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

    fn pipeline(&self, device: &wgpu::Device, variant: &Variant, target: wgpu::TextureFormat) -> wgpu::RenderPipeline {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("styk effects"), source: wgpu::ShaderSource::Wgsl(source(variant).into()) });
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
    /// into its input texture, the passes, the result copied back in place. Whether it was filtered: not when the run has no
    /// passes or its pipelines are still to be created ([`Executor::set_compile_limit`]).
    pub fn encode(&mut self, device: &wgpu::Device, encoder: &mut wgpu::CommandEncoder, index: usize, run: &Run, place: wgpu::TexelCopyTextureInfo<'_>) -> bool {
        if run.steps.is_empty() {
            return false;
        }
        let Some(passes) = self.passes[index].clone() else { return false };
        let placed = self.placed[index].clone();
        let extent = wgpu::Extent3d { width: run.size[0], height: run.size[1], depth_or_array_layers: 1 };
        encoder.copy_texture_to_texture(place, self.pool[placed[INPUT as usize]].texture.as_image_copy(), extent);
        for (step, &pipeline) in run.steps.iter().zip(&passes) {
            let bind = self.bind(device, step.inputs.map(|image| (image != BLANK).then(|| placed[image as usize])));
            let image = run.images[step.target as usize];
            let pipeline = &self.compiled[pipeline];
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
        true
    }
}

impl Drop for Executor {
    fn drop(&mut self) {
        for p in self.retired.drain(..).chain(self.pool.drain(..)) {
            p.texture.destroy();
        }
    }
}
