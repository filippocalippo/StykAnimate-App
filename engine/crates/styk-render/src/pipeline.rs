//! The pipelines of the one shader every primitive kind draws with (prim.wgsl: the general
//! fragment entry point, and on a software rasterizer the simpler ones of `shading`), its bind
//! group layouts, and the copy of a finished frame onto the host's surface.

use crate::isolation::LayerAtlas;
use crate::resources::*;
use crate::shading::Shading;
use crate::{Edges, Renderer, Stats, FORMAT, SAMPLES, UNIFORM_STRIDE};

impl Renderer {
    /// Explicitly change edge coverage for an export frame. Keep the resident
    /// list, images, glyphs and effect caches; only sample-dependent pipelines
    /// and targets need rebuilding. Ordinary rendering never calls this.
    pub fn set_edges(&mut self, edges: Edges) {
        if self.edges() == edges { return; }
        self.crisp = edges == Edges::Crisp;
        self.use_samples(if self.crisp { 1 } else { SAMPLES });
    }

    /// Lowers the samples per pixel of smooth edges to one (`multisampled` false) or restores
    /// [`SAMPLES`]: the quality ladder of the editor's preview under load, which trades the edges
    /// of polygons and images for fill rate (analytic shapes stay covered by distance). The
    /// resident list, images, glyphs and effect caches stay. Crisp edges are always one sample.
    pub fn set_multisampled(&mut self, multisampled: bool) {
        if self.crisp { return; }
        self.use_samples(if multisampled { SAMPLES } else { 1 });
    }

    /// Whether smooth edges are drawn with [`SAMPLES`] samples a pixel.
    pub fn multisampled(&self) -> bool { self.samples > 1 }

    /// Changes the sample count: the sample-dependent pipelines and targets are rebuilt.
    fn use_samples(&mut self, samples: u32) {
        if self.samples == samples { return; }
        self.samples = samples;
        self.pipeline = prim_pipeline(&self.device, &self.prim_layout, &self.prim_shader, None, self.samples);
        self.pipeline_generated = None;
        self.shading_pipelines = Default::default();
        self.depth_pipelines = None;
        self.msaa_main = None;
        self.msaa_layer = None;
        self.depth_main = None;
        self.depth_layer = None;
    }

    /// A renderer with smooth edges, presenting into `present_format`.
    pub fn new(device: &wgpu::Device, queue: &wgpu::Queue, present_format: wgpu::TextureFormat) -> Renderer {
        Renderer::with_edges(device, queue, present_format, Edges::Smooth)
    }

    /// A renderer covering edges as `edges` says (exports choose; the editor's view is smooth).
    pub fn with_edges(device: &wgpu::Device, queue: &wgpu::Queue, present_format: wgpu::TextureFormat, edges: Edges) -> Renderer {
        let samples = if edges == Edges::Crisp { 1 } else { SAMPLES };
        let device = device.clone();
        let float_effects = crate::effects::executor::float_by_default(&device);
        let queue = queue.clone();
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("styk prims"),
            source: wgpu::ShaderSource::Wgsl(include_str!("prim.wgsl").into()),
        });
        let blit_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("styk blit"),
            source: wgpu::ShaderSource::Wgsl(include_str!("blit.wgsl").into()),
        });
        let layout0 = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("styk scene"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: true,
                        min_binding_size: wgpu::BufferSize::new(std::mem::size_of::<GpuView>() as u64),
                    },
                    count: None,
                },
                table_entry(1),
                table_entry(2),
                table_entry(3),
                // Where each lone glyph is drawn from this frame (glyphs.rs).
                table_entry(4),
            ],
        });
        let layout1 = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("styk sprites"),
            // Sprites and drawings, the particle materials of generated effects, the glyph masks.
            entries: &[
                texture_entry(0, wgpu::TextureViewDimension::D2Array),
                sampler_entry(1),
                texture_entry(2, wgpu::TextureViewDimension::D2),
                sampler_entry(3),
                texture_entry(4, wgpu::TextureViewDimension::D2Array),
                // Where each page of the sprite layout is in the sprite texture (drawing cels' tiles).
                table_entry(5),
                // The soft copies of the document's pictures, and which of them are in the sprite texture (prim.wgsl `picture_layer`).
                texture_entry(6, wgpu::TextureViewDimension::D2Array),
                uint_table_entry(7),
            ],
        });
        let layout2 = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("styk layers"),
            entries: &[texture_entry(0, wgpu::TextureViewDimension::D2Array)],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("styk prims"),
            bind_group_layouts: &[Some(&layout0), Some(&layout1), Some(&layout2)],
            immediate_size: 0,
        });
        let pipeline = prim_pipeline(&device, &pipeline_layout, &shader, None, samples);
        let blit_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("styk blit"),
            entries: &[texture_entry(0, wgpu::TextureViewDimension::D2), sampler_entry(1)],
        });
        let blit_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("styk blit"),
            bind_group_layouts: &[Some(&blit_layout)],
            immediate_size: 0,
        });
        let presentation_pipeline = |blend| device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("styk blit"),
            layout: Some(&blit_pipeline_layout),
            vertex: wgpu::VertexState { module: &blit_shader, entry_point: Some("vs_blit"), compilation_options: Default::default(), buffers: &[] },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &blit_shader,
                entry_point: Some(if present_format.is_srgb() { "fs_blit_srgb" } else { "fs_blit" }),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState { format: present_format, blend, write_mask: wgpu::ColorWrites::ALL })],
            }),
            multiview_mask: None,
            cache: None,
        });
        let blit = presentation_pipeline(None);
        let composite = presentation_pipeline(Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING));
        let nearest = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("styk nearest"),
            mag_filter: wgpu::FilterMode::Nearest,
            min_filter: wgpu::FilterMode::Nearest,
            ..Default::default()
        });
        let linear = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("styk linear"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let (sprites, sprite_view) = array_texture(&device, "styk sprites", [1, 1], 1, false);
        let materials = crate::materials::Materials::placeholder(&device);
        let material_sampler = crate::materials::sampler(&device);
        let glyphs = crate::glyphs::GlyphMasks::new(&device);
        let sprite_map = crate::images::SpriteMap::new(&device);
        let pictures = crate::pictures::PictureState::new(&device, &queue, &styk_eval::assets::Assets::default(), 0, false, |_| None);
        let sprite_bind = Self::sprite_bind(&device, &layout1, &sprite_view, &linear, &materials.view, &material_sampler, &glyphs.view, &sprite_map.view, &pictures);
        let make_layers = |label: &str| {
            let (texture, view) = array_texture(&device, label, [1, 1], 1, true);
            LayerAtlas { texture, view, size: [1, 1], pages: 1 }
        };
        let layers = [make_layers("styk layers 0"), make_layers("styk layers 1")];
        let layer_binds = [Self::layer_bind(&device, &layout2, &layers[0].view), Self::layer_bind(&device, &layout2, &layers[1].view)];
        Renderer {
            uniforms: buffer(&device, "styk views", UNIFORM_STRIDE * 8, wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST),
            uniform_slots: 8,
            prims: buffer(&device, "styk prims", 64 * 1024, wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST),
            paints: Table::new(&device, "styk paints", wgpu::TextureFormat::Rgba32Float, 16),
            groups: Table::new(&device, "styk groups", wgpu::TextureFormat::Rgba32Float, 16),
            points: Table::new(&device, "styk polyline points", wgpu::TextureFormat::Rg32Float, 8),
            bind0: None,
            depth_pipelines: None,
            depth_main: None,
            depth_layer: None,
            depth_faces: Vec::new(),
            shading_runs: std::sync::Arc::from(Vec::new()),
            shading_pipelines: Default::default(),
            // Only a software rasterizer runs every branch of a fragment shader: on a graphics card the general shader is as
            // fast and one shader keeps the frame the same whatever compiler builds it (Direct3D 12's moved a pixel by a level).
            shading_on: device.adapter_info().device_type == wgpu::DeviceType::Cpu,
            prim_shader: shader,
            prim_layout: pipeline_layout,
            samples,
            crisp: edges == Edges::Crisp,
            drawing_grid: crate::DrawingGrid::World,
            paint_context: crate::paint::PaintContext::Native,
            orientation: None,
            root_gpu_source: false,
            keep_frames: false,
            kept: None,
            within: None,
            clear_part: None,
            knockout: None,
            device,
            queue,
            pipeline,
            blit,
            composite,
            blit_layout,
            layout0,
            layout1,
            layout2,
            sprites,
            sprite_view,
            sprite_map,
            pictures,
            sprite_bind,
            materials,
            material_sampler,
            glyphs,
            pipeline_generated: None,
            generated_ranges: Vec::new(),
            nearest,
            linear,
            layers,
            layer_binds,
            msaa_main: None,
            msaa_layer: None,
            output: None,
            list: None,
            list_prims: 0,
            changes: None,
            group_runs: Vec::new(),
            composites: Vec::new(),
            page: [0, 0],
            page_frame: [0, 0],
            exact_sizes: false,
            executor: None,
            float_effects,
            stats: Stats { prims: 0, groups: 0, passes: 0, downscaled: false, rounds: 0, effect_layers: 0, effect_passes: 0, effect_bytes: 0, layer_bytes: 0, depth_bytes: 0, material_bytes: 0, glyph_masks: 0, glyph_masks_filled: 0, glyph_bytes: 0, part: false },
        }
    }
}

/// The primitive pipeline. With `depth`, passes have a depth attachment: depth runs
/// (styk-draw `K_DEPTH_RESET`, `F_DEPTH`) draw their faces depth tested, everything
/// else draws as before, in painter order. `samples` per pixel.
pub(crate) fn prim_pipeline(device: &wgpu::Device, layout: &wgpu::PipelineLayout, shader: &wgpu::ShaderModule, depth: Option<wgpu::DepthStencilState>, samples: u32) -> wgpu::RenderPipeline {
    shaded_pipeline(device, layout, shader, depth, samples, Shading::Full, false)
}

/// Generated effects (styk-draw `K_PARTICLE`, `K_BEAM`): their own entry points (`vs_particle`, `fs_particle`), so a list
/// without them never compiles their shading, and the premultiplied blend: a record that gives off light carries less alpha
/// than colour (docs/engine/vfx.md).
pub(crate) fn generated_pipeline(device: &wgpu::Device, layout: &wgpu::PipelineLayout, shader: &wgpu::ShaderModule, depth: Option<wgpu::DepthStencilState>, samples: u32) -> wgpu::RenderPipeline {
    let blend = wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING;
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some(if depth.is_some() { "styk generated effects with depth" } else { "styk generated effects" }),
        layout: Some(layout),
        vertex: wgpu::VertexState {
            module: shader,
            entry_point: Some("vs_particle"),
            compilation_options: Default::default(),
            buffers: &[Some(wgpu::VertexBufferLayout {
                array_stride: std::mem::size_of::<GpuPrim>() as u64,
                step_mode: wgpu::VertexStepMode::Instance,
                attributes: &wgpu::vertex_attr_array![0 => Uint32x4, 1 => Float32x4, 2 => Float32x4, 3 => Float32x4],
            })],
        },
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: depth,
        multisample: wgpu::MultisampleState { count: samples, mask: !0, alpha_to_coverage_enabled: false },
        fragment: Some(wgpu::FragmentState {
            module: shader,
            entry_point: Some("fs_particle"),
            compilation_options: Default::default(),
            targets: &[Some(wgpu::ColorTargetState { format: FORMAT, blend: Some(blend), write_mask: wgpu::ColorWrites::ALL })],
        }),
        multiview_mask: None,
        cache: None,
    })
}

/// [`prim_pipeline`] with the vertex and fragment entry points of `shading` ([`crate::shading`]), in their `plain` form.
pub(crate) fn shaded_pipeline(device: &wgpu::Device, layout: &wgpu::PipelineLayout, shader: &wgpu::ShaderModule, depth: Option<wgpu::DepthStencilState>, samples: u32, shading: Shading, plain: bool) -> wgpu::RenderPipeline {
    let entry = shading.entry(plain);
    let premultiplied = wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING;
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some(match depth.is_some() {
            false if entry != "fs_main" => "styk simpler prims",
            false => "styk prims",
            true => "styk prims with depth",
        }),
        layout: Some(layout),
        vertex: wgpu::VertexState {
            module: shader,
            entry_point: Some(shading.vertex_entry()),
            compilation_options: Default::default(),
            buffers: &[Some(wgpu::VertexBufferLayout {
                array_stride: std::mem::size_of::<GpuPrim>() as u64,
                step_mode: wgpu::VertexStepMode::Instance,
                attributes: &wgpu::vertex_attr_array![0 => Uint32x4, 1 => Float32x4, 2 => Float32x4, 3 => Float32x4],
            })],
        },
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: depth,
        multisample: wgpu::MultisampleState { count: samples, mask: !0, alpha_to_coverage_enabled: false },
        fragment: Some(wgpu::FragmentState {
            module: shader,
            entry_point: Some(entry),
            compilation_options: Default::default(),
            targets: &[Some(wgpu::ColorTargetState { format: FORMAT, blend: Some(premultiplied), write_mask: wgpu::ColorWrites::ALL })],
        }),
        multiview_mask: None,
        cache: None,
    })
}

/// The depth format of depth runs: the editor's mesh raster uses `depth24plus`.
pub(crate) const DEPTH_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Depth24Plus;

/// The two pipelines of a pass with a depth attachment: `flat` draws every record in
/// painter order (a depth reset writes the far depth, other records write theirs,
/// which no later face reads before a reset); `faces` depth tests a run's faces,
/// a face at an equal depth replacing the one before it (`less-equal`).
pub(crate) struct DepthPipelines {
    pub(crate) flat: wgpu::RenderPipeline,
    pub(crate) faces: wgpu::RenderPipeline,
    /// The generated-effects pipeline ([`generated_pipeline`]) of a pass with faces.
    pub(crate) flat_generated: wgpu::RenderPipeline,
}

impl Renderer {
    pub(crate) fn depth_pipelines(&mut self) -> &DepthPipelines {
        let (device, layout, shader, samples) = (&self.device, &self.prim_layout, &self.prim_shader, self.samples);
        self.depth_pipelines.get_or_insert_with(|| {
            let state = |compare| wgpu::DepthStencilState { format: DEPTH_FORMAT, depth_write_enabled: Some(true), depth_compare: Some(compare), stencil: Default::default(), bias: Default::default() };
            DepthPipelines {
                flat: prim_pipeline(device, layout, shader, Some(state(wgpu::CompareFunction::Always)), samples),
                faces: prim_pipeline(device, layout, shader, Some(state(wgpu::CompareFunction::LessEqual)), samples),
                flat_generated: generated_pipeline(device, layout, shader, Some(state(wgpu::CompareFunction::Always)), samples),
            }
        })
    }

    /// The pipelines of the simpler fragment shaders the current list's runs draw with ([`crate::shading`]), in their `plain`
    /// form or the one for any view, each created with the first frame that draws with it; `None` for those the list does not use.
    pub(crate) fn shading_pipelines(&mut self, plain: bool) -> [Option<wgpu::RenderPipeline>; 5] {
        let (device, layout, shader, samples) = (&self.device, &self.prim_layout, &self.prim_shader, self.samples);
        let made = &mut self.shading_pipelines[usize::from(plain)];
        let mut used = [false; 5];
        for &(_, _, shading) in self.shading_runs.iter() {
            if let Some(i) = shading.simpler() {
                used[i] = true;
            }
        }
        std::array::from_fn(|i| {
            if !used[i] {
                return None;
            }
            Some(made[i].get_or_insert_with(|| shaded_pipeline(device, layout, shader, None, samples, Shading::SIMPLER[i], plain)).clone())
        })
    }

    /// Creates the generated-effects pipeline now instead of with the first list that has them. Compiling its shading
    /// takes from a few hundred milliseconds to over a second on Direct3D (WebGPU and WebGL on Windows), during which the
    /// graphics process draws nothing: the stage does it when it is made, with the app's start, so the first frame of a
    /// particle effect (often one of playback) does not wait for it. Renderers that may never draw one (exports,
    /// thumbnails) leave it to their first list.
    pub fn prepare_effects(&mut self) {
        self.effects_pipeline();
    }

    /// The generated-effects pipeline ([`generated_pipeline`]), created with the first list that has them.
    pub(crate) fn effects_pipeline(&mut self) -> wgpu::RenderPipeline {
        let (device, layout, shader, samples) = (&self.device, &self.prim_layout, &self.prim_shader, self.samples);
        self.pipeline_generated.get_or_insert_with(|| generated_pipeline(device, layout, shader, None, samples)).clone()
    }

    pub(crate) fn rebind(&mut self) {
        self.bind0 = Some(self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("styk scene"),
            layout: &self.layout0,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                        buffer: &self.uniforms,
                        offset: 0,
                        size: wgpu::BufferSize::new(std::mem::size_of::<GpuView>() as u64),
                    }),
                },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&self.paints.view) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&self.groups.view) },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(&self.points.view) },
                wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::TextureView(&self.glyphs.table.view) },
            ],
        }));
    }

}
