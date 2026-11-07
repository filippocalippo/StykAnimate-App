//! The pad's pipeline: the cel's tiles from an atlas texture and the wet ink, drawn in the toolkit's own render pass.
//!
//! `prepare` is where the drawing worker's replies reach the GPU, and the whole of it is budgeted ([`PREPARE_NS`]): replies
//! are taken one at a time while the batches waiting hold little ([`TileSync::has_room`]); tiles are installed whole batch by
//! whole batch within [`TILES_PER_FRAME`] and the time left; the preview is built from the ledger, which is capped. The
//! residency policy (what is on the GPU, eviction, fetching what the view shows) is `styk_core::drawing::tile_sync`; this file
//! only performs its writes. The exact pixels and the end of their preview are in the same frame.

use super::core::{FrameRow, PadCore};
use bytemuck::{Pod, Zeroable};
use iced::Rectangle;
use iced::wgpu;
use iced::widget::shader::{self, Viewport};
use std::sync::Arc;
use styk_core::drawing::tile_sync::{TileRect, TileSync, Write};
use styk_core::drawing::worker::{FETCH_LIMIT, Reply, Request};

/// Tiles installed in one frame at most (the JavaScript stage's `96 tiles a call`); the first batch of a frame goes whole.
pub const TILES_PER_FRAME: usize = 96;
/// Nanoseconds a `prepare` may spend (the JavaScript stage's 6 ms for the calls of a frame, halved: the frame still has to draw).
pub const PREPARE_NS: u64 = 3_000_000;
/// Replies one `prepare` takes at most.
const MAX_REPLIES: usize = 64;
/// The atlas: columns by rows of 64 x 64 texel tiles (2048 tiles, 32 MiB).
const ATLAS_COLS: u32 = 64;
const ATLAS_ROWS: u32 = 32;
const TILE: u32 = 64;
const ATLAS_TEXELS: (u32, u32) = (ATLAS_COLS * TILE, ATLAS_ROWS * TILE);
/// Wet dabs one frame draws at most.
const WET_CAPACITY: usize = styk_core::drawing::wet::MAX_DABS;
/// Dabs drawn between the last dab and the newest pointer position, at most.
const GAP_FILL: usize = 64;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct TileInstance {
    origin: [f32; 2],
    size: [f32; 2],
    texel: [f32; 2],
    solid: f32,
    pad: f32,
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct WetInstance {
    center: [f32; 2],
    radius: f32,
    opacity: f32,
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Uniforms {
    size: [f32; 2],
    pan: [f32; 2],
    zoom: f32,
    atlas_w: f32,
    atlas_h: f32,
    srgb: f32,
    color: [f32; 4],
    wet: [f32; 4],
    paper: [f32; 4],
}

/// The paper the pad shows under the ink.
const PAPER: [f32; 4] = [1.0, 1.0, 1.0, 1.0];

/// What a frame draws, built by the widget each frame.
#[derive(Debug)]
pub struct InkPrimitive {
    pub core: Arc<PadCore>,
}

pub struct InkPipeline {
    format: wgpu::TextureFormat,
    tile_pipeline: wgpu::RenderPipeline,
    wet_pipeline: wgpu::RenderPipeline,
    uniforms: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
    atlas: wgpu::Texture,
    tile_instances: wgpu::Buffer,
    wet_instances: wgpu::Buffer,
    tile_count: u32,
    wet_count: u32,
    sync: TileSync,
}

impl shader::Pipeline for InkPipeline {
    fn new(device: &wgpu::Device, _queue: &wgpu::Queue, format: wgpu::TextureFormat) -> InkPipeline {
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("styk.ink_pad"), source: wgpu::ShaderSource::Wgsl(include_str!("ink.wgsl").into()) });
        let atlas = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("styk.ink_pad.atlas"),
            size: wgpu::Extent3d { width: ATLAS_TEXELS.0, height: ATLAS_TEXELS.1, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let view = atlas.create_view(&wgpu::TextureViewDescriptor::default());
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor { mag_filter: wgpu::FilterMode::Nearest, min_filter: wgpu::FilterMode::Nearest, ..Default::default() });
        let uniforms = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("styk.ink_pad.uniforms"),
            size: std::mem::size_of::<Uniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("styk.ink_pad.layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry { binding: 2, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
            ],
        });
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("styk.ink_pad.bind_group"),
            layout: &layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: uniforms.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&view) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&sampler) },
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("styk.ink_pad.pipeline_layout"), bind_group_layouts: &[Some(&layout)], immediate_size: 0 });
        let target = [Some(wgpu::ColorTargetState { format, blend: Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING), write_mask: wgpu::ColorWrites::ALL })];
        let make = |label: &str, vs: &str, fs: &str, attributes: &[wgpu::VertexAttribute], stride: u64| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
                layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &module,
                    entry_point: Some(vs),
                    buffers: &[Some(wgpu::VertexBufferLayout { array_stride: stride, step_mode: wgpu::VertexStepMode::Instance, attributes })],
                    compilation_options: wgpu::PipelineCompilationOptions::default(),
                },
                fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some(fs), targets: &target, compilation_options: wgpu::PipelineCompilationOptions::default() }),
                primitive: wgpu::PrimitiveState::default(),
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                multiview_mask: None,
                cache: None,
            })
        };
        let tile_pipeline = make("styk.ink_pad.tiles", "tile_vs", "tile_fs", &wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32x2, 2 => Float32x2, 3 => Float32], std::mem::size_of::<TileInstance>() as u64);
        let wet_pipeline = make("styk.ink_pad.wet", "wet_vs", "wet_fs", &wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32, 2 => Float32], std::mem::size_of::<WetInstance>() as u64);
        let buffer = |label: &str, size: usize| {
            device.create_buffer(&wgpu::BufferDescriptor { label: Some(label), size: size as u64, usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false })
        };
        InkPipeline {
            format,
            tile_pipeline,
            wet_pipeline,
            uniforms,
            bind_group,
            atlas,
            tile_instances: buffer("styk.ink_pad.tile_instances", (ATLAS_COLS * ATLAS_ROWS + 1) as usize * std::mem::size_of::<TileInstance>()),
            wet_instances: buffer("styk.ink_pad.wet_instances", WET_CAPACITY * std::mem::size_of::<WetInstance>()),
            tile_count: 0,
            wet_count: 0,
            sync: TileSync::new((ATLAS_COLS * ATLAS_ROWS) as usize),
        }
    }
}

impl InkPipeline {
    /// Writes a tile into its atlas slot.
    fn write_tile(&self, queue: &wgpu::Queue, write: &Write) {
        let (sx, sy) = (write.slot % ATLAS_COLS, write.slot / ATLAS_COLS);
        queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: &self.atlas, mip_level: 0, origin: wgpu::Origin3d { x: sx * TILE, y: sy * TILE, z: 0 }, aspect: wgpu::TextureAspect::All },
            &write.pixels,
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(TILE * 4), rows_per_image: Some(TILE) },
            wgpu::Extent3d { width: TILE, height: TILE, depth_or_array_layers: 1 },
        );
    }

    fn tile_list(&self) -> Vec<TileInstance> {
        let mut list = Vec::with_capacity(self.sync.resident_count() + 1);
        list.push(TileInstance { origin: [-1.0e6, -1.0e6], size: [2.0e6, 2.0e6], texel: [0.0, 0.0], solid: 1.0, pad: 0.0 });
        for ((tx, ty), slot) in self.sync.resident() {
            list.push(TileInstance {
                origin: [(tx * TILE as i64) as f32, (ty * TILE as i64) as f32],
                size: [TILE as f32, TILE as f32],
                texel: [((slot % ATLAS_COLS) * TILE) as f32, ((slot / ATLAS_COLS) * TILE) as f32],
                solid: 0.0,
                pad: 0.0,
            });
        }
        list
    }
}

impl shader::Primitive for InkPrimitive {
    type Pipeline = InkPipeline;

    fn prepare(&self, pipeline: &mut InkPipeline, _device: &wgpu::Device, queue: &wgpu::Queue, bounds: &Rectangle, viewport: &Viewport) {
        let core = &self.core;
        let started = core.now_ns();
        // The whole of this call is budgeted: nothing below loops past it except the first batch of tiles, which a frame
        // always installs so the queue advances.
        let deadline = started + PREPARE_NS;
        let late = || core.now_ns() > deadline;
        let frame = core.next_frame();
        let scale = viewport.scale_factor();
        core.set_scale(scale);
        let view = core.view();
        let brush = core.brush();
        let switches = core.switches();
        let size_px = (bounds.width * scale, bounds.height * scale);
        let zoom = view.zoom.max(1e-6);
        pipeline.sync.set_visible(TileRect::of_view(view.pan.0, view.pan.1, size_px.0 as f64 / zoom, size_px.1 as f64 / zoom));

        // Replies, one at a time while the waiting batches hold little and the budget lasts.
        core.with_ledger(|ledger| ledger.begin_frame());
        let (mut generate_ms, mut raster_ms) = (None, None);
        let mut finished = 0u64;
        let mut errors = Vec::new();
        let mut replies_left = false;
        let mut taken = Vec::with_capacity(1);
        for _ in 0..MAX_REPLIES {
            if !pipeline.sync.has_room() || late() {
                replies_left = true;
                break;
            }
            taken.clear();
            core.worker.drain(&mut taken, 1);
            let Some(reply) = taken.pop() else { break };
            match &reply {
                Reply::Dabs { generate_ms: g, .. } => generate_ms = Some(*g),
                Reply::Tiles { raster_ms: r, .. } => raster_ms = Some(*r),
                Reply::Finished { .. } => finished += 1,
                Reply::Failed { message, .. } => errors.push(message.clone()),
                _ => {}
            }
            let worker = &core.worker;
            core.with_ledger(|ledger| pipeline.sync.accept(reply, ledger, &mut |seq| worker.ack(seq)));
        }
        let after_replies = core.now_ns();

        // Tiles: whole batches, within the frame's tile and time budgets.
        let worker = &core.worker;
        pipeline.sync.install(TILES_PER_FRAME, &mut || late(), &mut |seq| worker.ack(seq));
        let asked = pipeline.sync.plan_fetch(FETCH_LIMIT);
        if !asked.is_empty() {
            core.worker.send(Request::Fetch { tiles: asked });
        }
        let writes = pipeline.sync.take_writes();
        let uploaded_now = writes.len() as u32;
        for write in &writes {
            pipeline.write_tile(queue, write);
        }
        let (visible_dabs, newest_wet) = core.with_ledger(|ledger| {
            ledger.uploaded(pipeline.sync.waiting_seq());
            ledger.age();
            (ledger.visible_dabs(), ledger.newest_ns())
        });
        if pipeline.sync.take_dirty() {
            let list = pipeline.tile_list();
            pipeline.tile_count = list.len() as u32;
            queue.write_buffer(&pipeline.tile_instances, 0, bytemuck::cast_slice(&list));
        }
        let after_install = core.now_ns();

        // The wet ink: the batches the tiles do not yet replace (at most WET_CAPACITY dabs, the ledger's own cap), then the
        // newest pointer position of the stroke being drawn, if that stroke may be previewed.
        let mut wet: Vec<WetInstance> = Vec::new();
        core.with_ledger(|ledger| {
            for batch in ledger.visible() {
                wet.extend(batch.iter().map(|d| WetInstance { center: [d.x, d.y], radius: d.radius, opacity: d.opacity }));
            }
        });
        let live = core.with_live(|live| *live);
        let mut newest_wet_ns = if wet.is_empty() { 0 } else { newest_wet };
        if switches.wet_ink && live.show && live.eligible {
            // The anchor is the last dab of this stroke: a dab of an earlier stroke is never bridged from.
            let anchor = pipeline.sync.anchor().filter(|a| a.0 == live.stroke);
            let radius = anchor.map_or((brush.size as f32) / 2.0, |a| a.3);
            let target = live.predicted.or(live.raw.map(|r| (r.0, r.1)));
            match (anchor, target) {
                (Some(from), Some(to)) => {
                    let (dx, dy) = (to.0 - from.1, to.1 - from.2);
                    let length = (dx * dx + dy * dy).sqrt();
                    let steps = ((length / (radius * 0.35).max(0.5)).ceil() as usize).clamp(1, GAP_FILL);
                    for i in 1..=steps {
                        let t = i as f32 / steps as f32;
                        wet.push(WetInstance { center: [from.1 + dx * t, from.2 + dy * t], radius, opacity: 1.0 });
                    }
                }
                (None, Some(to)) => wet.push(WetInstance { center: [to.0, to.1], radius, opacity: 1.0 }),
                _ => {}
            }
            if let Some(raw) = live.raw {
                newest_wet_ns = newest_wet_ns.max(raw.2);
            }
        }
        debug_assert!(wet.len() <= WET_CAPACITY + GAP_FILL, "the ledger's cap bounds the preview");
        wet.truncate(WET_CAPACITY);
        pipeline.wet_count = wet.len() as u32;
        if !wet.is_empty() {
            queue.write_buffer(&pipeline.wet_instances, 0, bytemuck::cast_slice(&wet));
        }
        let [r, g, b] = brush.color;
        let uniforms = Uniforms {
            size: [size_px.0, size_px.1],
            pan: [view.pan.0 as f32, view.pan.1 as f32],
            zoom: zoom as f32,
            atlas_w: ATLAS_TEXELS.0 as f32,
            atlas_h: ATLAS_TEXELS.1 as f32,
            srgb: if pipeline.format.is_srgb() { 1.0 } else { 0.0 },
            color: [r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0, 1.0],
            wet: [brush.hardness as f32, brush.opacity as f32, 0.0, 0.0],
            paper: PAPER,
        };
        queue.write_buffer(&pipeline.uniforms, 0, bytemuck::bytes_of(&uniforms));

        let ended = core.now_ns();
        let sync_stats = pipeline.sync.stats();
        let resident = pipeline.sync.resident_count();
        let waiting = pipeline.sync.waiting();
        let exact_ns = pipeline.sync.exact_ns();
        let ledger_stats = core.with_ledger(|ledger| ledger.stats());
        core.with_gpu(|gpu| {
            gpu.frames = frame;
            gpu.tiles_uploaded += uploaded_now as u64;
            gpu.tiles_resident = resident;
            gpu.sync = sync_stats;
            gpu.replies_left = replies_left;
            gpu.batches_waiting = waiting;
            gpu.wet_instances = wet.len();
            gpu.prepare_last_us = (ended - started) / 1000;
            gpu.prepare_max_us = gpu.prepare_max_us.max(gpu.prepare_last_us);
            gpu.ledger = ledger_stats;
            gpu.pad_px = size_px;
        });
        core.with_inspector(|inspector| {
            if let Some(g) = generate_ms {
                inspector.last_generate_ms = g;
                inspector.max_generate_ms = inspector.max_generate_ms.max(g);
            }
            if let Some(r) = raster_ms {
                inspector.last_raster_ms = r;
                inspector.max_raster_ms = inspector.max_raster_ms.max(r);
            }
            inspector.worker_errors.extend(errors);
            inspector.finished_strokes += finished;
        });
        core.record_frame(FrameRow {
            frame,
            prepare_start_ns: started,
            prepare_end_ns: ended,
            newest_wet_ns,
            newest_exact_ns: exact_ns,
            wet_dabs: visible_dabs as u32,
            tiles_uploaded: uploaded_now,
            replies_us: ((after_replies - started) / 1000) as u32,
            install_us: ((after_install - after_replies) / 1000) as u32,
            wet_us: ((ended - after_install) / 1000) as u32,
            view_us: core.view_us() as u32,
            update_us: core.inspector_update_us() as u32,
        });
    }

    fn draw(&self, pipeline: &InkPipeline, pass: &mut wgpu::RenderPass<'_>) -> bool {
        pass.set_bind_group(0, &pipeline.bind_group, &[]);
        pass.set_pipeline(&pipeline.tile_pipeline);
        pass.set_vertex_buffer(0, pipeline.tile_instances.slice(..));
        pass.draw(0..6, 0..pipeline.tile_count);
        if pipeline.wet_count > 0 {
            pass.set_pipeline(&pipeline.wet_pipeline);
            pass.set_vertex_buffer(0, pipeline.wet_instances.slice(..));
            pass.draw(0..6, 0..pipeline.wet_count);
        }
        true
    }
}
