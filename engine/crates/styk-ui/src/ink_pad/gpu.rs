//! The pad's pipeline: the cel's tiles from an atlas texture and the wet ink, drawn in the toolkit's own render pass.
//!
//! `prepare` is where the drawing worker's replies reach the GPU, and the whole of it is budgeted ([`PREPARE_NS`]): replies
//! are taken one at a time within the time left (a lifecycle reply is never held behind tile data; what waits is bounded by the
//! worker's own window); tiles are written a few at a time within [`TILES_PER_FRAME`] and the time left, and a batch appears whole; the preview is built from the ledger, which is capped. The
//! residency policy (what is on the GPU, eviction, fetching what the view shows) is `styk_core::drawing::tile_sync`; this file
//! only performs its writes. The exact pixels and the end of their preview are in the same frame.
//!
//! The time of the graphics API's queue calls is measured apart from the rest: the budget governs the pad's own work, and a
//! driver that stalls under load shows in its own column. A uniform block that did not change is not written again.

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
/// The atlas: pages of columns by rows of 64 x 64 texel tiles (2048 tiles, 32 MiB a page). The first page is the soft budget; the
/// atlas grows a page at a time, to hold every tile the view shows and the batch being staged, up to the hard budget (today's
/// `reserve` in `drawing-resources.mjs`: hold the required set above the soft budget, refuse visibly above the hard one).
const ATLAS_COLS: u32 = 64;
const ATLAS_ROWS: u32 = 32;
const TILE: u32 = 64;
const ATLAS_TEXELS: (u32, u32) = (ATLAS_COLS * TILE, ATLAS_ROWS * TILE);
const PAGE_SLOTS: u32 = ATLAS_COLS * ATLAS_ROWS;
/// Pages at most: 128 MiB of tiles, 8192 tiles.
pub const MAX_PAGES: usize = 4;
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
    page: f32,
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

/// Whether `now` has to be written over `last` (nothing has been written, or a byte differs).
fn uniforms_changed(last: &Option<Uniforms>, now: &Uniforms) -> bool {
    last.as_ref().is_none_or(|last| bytemuck::bytes_of(last) != bytemuck::bytes_of(now))
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
    atlas_pages: u32,
    layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    /// Memory-full tiles already reported, so a report is made when the count grows.
    reported_refused: u64,
    tile_instances: wgpu::Buffer,
    wet_instances: wgpu::Buffer,
    tile_count: u32,
    wet_count: u32,
    sync: TileSync,
    /// The uniforms last written.
    last_uniforms: Option<Uniforms>,
}

impl shader::Pipeline for InkPipeline {
    fn new(device: &wgpu::Device, _queue: &wgpu::Queue, format: wgpu::TextureFormat) -> InkPipeline {
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("styk.ink_pad"), source: wgpu::ShaderSource::Wgsl(include_str!("ink.wgsl").into()) });
        let atlas = create_atlas(device, 1);
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
                    ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2Array, multisampled: false },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry { binding: 2, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
            ],
        });
        let bind_group = make_bind_group(device, &layout, &uniforms, &atlas, &sampler);
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
        let tile_pipeline = make("styk.ink_pad.tiles", "tile_vs", "tile_fs", &wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32x2, 2 => Float32x2, 3 => Float32, 4 => Float32], std::mem::size_of::<TileInstance>() as u64);
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
            atlas_pages: 1,
            layout,
            sampler,
            reported_refused: 0,
            tile_instances: buffer("styk.ink_pad.tile_instances", (ATLAS_COLS * ATLAS_ROWS + 1) as usize * std::mem::size_of::<TileInstance>()),
            wet_instances: buffer("styk.ink_pad.wet_instances", WET_CAPACITY * std::mem::size_of::<WetInstance>()),
            tile_count: 0,
            wet_count: 0,
            sync: TileSync::new(PAGE_SLOTS as usize, MAX_PAGES),
            last_uniforms: None,
        }
    }
}

impl InkPipeline {
    /// Grows the texture to `pages` layers, keeping what the pages it had hold.
    fn ensure_pages(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, pages: u32) {
        if pages <= self.atlas_pages {
            return;
        }
        let grown = create_atlas(device, pages);
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("styk.ink_pad.grow") });
        encoder.copy_texture_to_texture(
            self.atlas.as_image_copy(),
            grown.as_image_copy(),
            wgpu::Extent3d { width: ATLAS_TEXELS.0, height: ATLAS_TEXELS.1, depth_or_array_layers: self.atlas_pages },
        );
        queue.submit([encoder.finish()]);
        self.atlas = grown;
        self.atlas_pages = pages;
        self.bind_group = make_bind_group(device, &self.layout, &self.uniforms, &self.atlas, &self.sampler);
    }

    /// Writes a tile into its atlas slot.
    fn write_tile(&self, queue: &wgpu::Queue, write: &Write) {
        let (page, local) = (write.slot / PAGE_SLOTS, write.slot % PAGE_SLOTS);
        let (sx, sy) = (local % ATLAS_COLS, local / ATLAS_COLS);
        queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: &self.atlas, mip_level: 0, origin: wgpu::Origin3d { x: sx * TILE, y: sy * TILE, z: page }, aspect: wgpu::TextureAspect::All },
            &write.pixels,
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(TILE * 4), rows_per_image: Some(TILE) },
            wgpu::Extent3d { width: TILE, height: TILE, depth_or_array_layers: 1 },
        );
    }

    fn tile_list(&self) -> Vec<TileInstance> {
        let mut list = Vec::with_capacity(self.sync.resident_count() + 1);
        list.push(TileInstance { origin: [-1.0e6, -1.0e6], size: [2.0e6, 2.0e6], texel: [0.0, 0.0], solid: 1.0, page: 0.0 });
        for ((tx, ty), slot) in self.sync.resident() {
            list.push(TileInstance {
                origin: [(tx * TILE as i64) as f32, (ty * TILE as i64) as f32],
                size: [TILE as f32, TILE as f32],
                texel: [(((slot % PAGE_SLOTS) % ATLAS_COLS) * TILE) as f32, (((slot % PAGE_SLOTS) / ATLAS_COLS) * TILE) as f32],
                solid: 0.0,
                page: (slot / PAGE_SLOTS) as f32,
            });
        }
        list
    }
}

impl shader::Primitive for InkPrimitive {
    type Pipeline = InkPipeline;

    fn prepare(&self, pipeline: &mut InkPipeline, device: &wgpu::Device, queue: &wgpu::Queue, bounds: &Rectangle, viewport: &Viewport) {
        let core = &self.core;
        let started = core.now_ns();
        // The whole of this call is budgeted: nothing below loops past it except the first batch of tiles, which a frame
        // always installs so the queue advances.
        let deadline = started + PREPARE_NS;
        let late = || core.now_ns() > deadline;
        // A history change the worker refused earlier goes first, in order.
        core.retry_history();
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
            if late() {
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
                Reply::Failed { message, stroke, .. } => {
                    errors.push(message.clone());
                    core.clear_live_of(*stroke);
                }
                // A stroke the worker discarded (a cancel, or a history change during it) leaves no raw preview behind.
                Reply::Cancelled { stroke, .. } => core.clear_live_of(*stroke),
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
        if !asked.is_empty() && !core.worker.send(Request::Fetch { tiles: asked.clone() }) {
            // Too many requests are waiting: the tiles were never asked for, so they are asked for again.
            pipeline.sync.fetch_refused(&asked);
        }
        pipeline.ensure_pages(device, queue, pipeline.sync.pages() as u32);
        let writes = pipeline.sync.take_writes();
        let uploaded_now = writes.len() as u32;
        let mut wgpu_ns = 0u64;
        let wgpu_started = core.now_ns();
        for write in &writes {
            pipeline.write_tile(queue, write);
        }
        wgpu_ns += core.now_ns() - wgpu_started;
        let (visible_dabs, newest_wet) = core.with_ledger(|ledger| {
            ledger.uploaded(pipeline.sync.waiting_seq());
            ledger.age();
            (ledger.visible_dabs(), ledger.newest_ns())
        });
        if pipeline.sync.take_dirty() {
            let list = pipeline.tile_list();
            pipeline.tile_count = list.len() as u32;
            let began = core.now_ns();
            queue.write_buffer(&pipeline.tile_instances, 0, bytemuck::cast_slice(&list));
            wgpu_ns += core.now_ns() - began;
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
        // A raw preview belongs to a stroke the worker still has open: not to one it cancelled or refused.
        let live_open = live.show && live.eligible && core.with_ledger(|ledger| ledger.is_stroke_open(live.stroke));
        if switches.wet_ink && live_open {
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
            let began = core.now_ns();
            queue.write_buffer(&pipeline.wet_instances, 0, bytemuck::cast_slice(&wet));
            wgpu_ns += core.now_ns() - began;
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
        let uniform_skipped = !uniforms_changed(&pipeline.last_uniforms, &uniforms);
        if !uniform_skipped {
            let began = core.now_ns();
            queue.write_buffer(&pipeline.uniforms, 0, bytemuck::bytes_of(&uniforms));
            wgpu_ns += core.now_ns() - began;
            pipeline.last_uniforms = Some(uniforms);
        }

        let ended = core.now_ns();
        let sync_stats = pipeline.sync.stats();
        let memory_full = sync_stats.refused > pipeline.reported_refused;
        pipeline.reported_refused = sync_stats.refused;
        let resident = pipeline.sync.resident_count();
        let waiting = pipeline.sync.waiting();
        let exact_ns = pipeline.sync.exact_ns();
        let ledger_stats = core.with_ledger(|ledger| ledger.stats());
        core.with_gpu(|gpu| {
            gpu.frames = frame;
            gpu.tiles_uploaded += uploaded_now as u64;
            gpu.tiles_resident = resident;
            gpu.pages = pipeline.sync.pages();
            gpu.sync = sync_stats;
            gpu.replies_left = replies_left;
            gpu.batches_waiting = waiting;
            gpu.wet_instances = wet.len();
            gpu.prepare_last_us = (ended - started) / 1000;
            gpu.prepare_max_us = gpu.prepare_max_us.max(gpu.prepare_last_us);
            gpu.wgpu_last_us = wgpu_ns / 1000;
            gpu.wgpu_max_us = gpu.wgpu_max_us.max(gpu.wgpu_last_us);
            gpu.own_last_us = gpu.prepare_last_us.saturating_sub(gpu.wgpu_last_us);
            gpu.own_max_us = gpu.own_max_us.max(gpu.own_last_us);
            gpu.uniform_writes_skipped += u64::from(uniform_skipped);
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
            if memory_full {
                inspector.worker_errors.push(format!("drawing memory is full: {} tiles were not shown (the atlas is at its {} page limit)", sync_stats.refused, MAX_PAGES));
            }
            let extra = inspector.worker_errors.len().saturating_sub(32);
            inspector.worker_errors.drain(..extra);
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
            wgpu_us: (wgpu_ns / 1000) as u32,
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

fn create_atlas(device: &wgpu::Device, pages: u32) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some("styk.ink_pad.atlas"),
        size: wgpu::Extent3d { width: ATLAS_TEXELS.0, height: ATLAS_TEXELS.1, depth_or_array_layers: pages },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    })
}

fn make_bind_group(device: &wgpu::Device, layout: &wgpu::BindGroupLayout, uniforms: &wgpu::Buffer, atlas: &wgpu::Texture, sampler: &wgpu::Sampler) -> wgpu::BindGroup {
    let view = atlas.create_view(&wgpu::TextureViewDescriptor { dimension: Some(wgpu::TextureViewDimension::D2Array), ..Default::default() });
    device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("styk.ink_pad.bind_group"),
        layout,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: uniforms.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&view) },
            wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(sampler) },
        ],
    })
}

/// The pad on a real GPU device, drawn offscreen: skipped (and said so) on a machine with no adapter.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::ink_pad::core::BrushConfig;
    use iced::advanced::renderer::Scale;
    use iced::{Point, Size};
    use shader::Pipeline as _;
    use shader::Primitive as _;
    use std::time::Duration;
    use styk_core::drawing::mapping::Mapping;
    use styk_core::drawing::stroke_input::StrokeCommand;
    use styk_core::drawing::worker::Worker;
    use styk_services::input::{InputQueue, Modifiers};
    use styk_services::{Clock, FixedClock};

    /// A test that needs a tool fails when the tool is missing: a machine with no adapter says so instead of passing.
    const NO_GPU: &str = "these tests need a GPU adapter (a hardware or a software one) and none was found: the pad's drawing was not checked";

    const SIZE: u32 = 256;

    struct Gpu {
        device: wgpu::Device,
        queue: wgpu::Queue,
        target: wgpu::Texture,
    }

    fn gpu() -> Option<Gpu> {
        let instance = wgpu::Instance::default();
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())).ok()?;
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).ok()?;
        let target = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("test target"),
            size: wgpu::Extent3d { width: SIZE, height: SIZE, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        Some(Gpu { device, queue, target })
    }

    /// One frame: prepare, draw into the target, read the pixels back (straight RGBA, SIZE x SIZE).
    fn frame(gpu: &Gpu, pipeline: &mut InkPipeline, primitive: &InkPrimitive) -> Vec<u8> {
        let bounds = Rectangle::new(Point::ORIGIN, Size::new(SIZE as f32, SIZE as f32));
        let viewport = Viewport::with_physical_size(Size::new(SIZE, SIZE), Scale::default());
        primitive.prepare(pipeline, &gpu.device, &gpu.queue, &bounds, &viewport);
        let view = gpu.target.create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("test pass"),
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
            assert!(primitive.draw(pipeline, &mut pass));
        }
        let row = SIZE * 4;
        let buffer = gpu.device.create_buffer(&wgpu::BufferDescriptor { label: Some("readback"), size: (row * SIZE) as u64, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
        encoder.copy_texture_to_buffer(
            gpu.target.as_image_copy(),
            wgpu::TexelCopyBufferInfo { buffer: &buffer, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row), rows_per_image: None } },
            wgpu::Extent3d { width: SIZE, height: SIZE, depth_or_array_layers: 1 },
        );
        gpu.queue.submit([encoder.finish()]);
        let slice = buffer.slice(..);
        slice.map_async(wgpu::MapMode::Read, |_| {});
        let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
        let pixels = slice.get_mapped_range().expect("the readback maps").to_vec();
        pixels
    }

    fn core() -> Arc<PadCore> {
        let clock: Arc<dyn Clock> = Arc::new(FixedClock::new());
        let worker = Worker::spawn(Vec::new(), Arc::new(|| {}), clock.clone(), &styk_platform::spawn::ThreadSpawner).expect("the worker starts");
        PadCore::new(InputQueue::new(), worker, clock)
    }

    /// What the cel's tiles are over white paper, as SIZE x SIZE pixels (the pad shows cel pixels 1:1 from 0, 0).
    fn expected(tiles: &[(i64, i64, Vec<u8>)]) -> Vec<u8> {
        let mut out = vec![255u8; (SIZE * SIZE * 4) as usize];
        for (tx, ty, pixels) in tiles {
            for y in 0..64 {
                for x in 0..64 {
                    let (px, py) = (tx * 64 + x, ty * 64 + y);
                    if !(0..SIZE as i64).contains(&px) || !(0..SIZE as i64).contains(&py) {
                        continue;
                    }
                    let src = &pixels[((y * 64 + x) * 4) as usize..][..4];
                    let at = ((py as u32 * SIZE + px as u32) * 4) as usize;
                    let a = src[3] as f32 / 255.0;
                    for c in 0..3 {
                        out[at + c] = (src[c] as f32 * a + 255.0 * (1.0 - a)).round() as u8;
                    }
                }
            }
        }
        out
    }

    #[test]
    fn the_pad_draws_the_cel_the_worker_holds_pixel_for_pixel_and_keeps_no_preview_once_the_tiles_are_in() {
        let gpu = gpu().expect(NO_GPU);
        let core = core();
        let mut pipeline = InkPipeline::new(&gpu.device, &gpu.queue, wgpu::TextureFormat::Rgba8Unorm);
        let primitive = InkPrimitive { core: core.clone() };
        // A firm round stroke across the pad, through the real worker.
        core.with_ledger(|ledger| ledger.stroke_started(1, true));
        let brush = BrushConfig { size: 14.0, hardness: 1.0, ..BrushConfig::default() }.to_json();
        let send = |command: StrokeCommand| {
            core.worker.command(command, &brush);
        };
        send(StrokeCommand::Begin { id: 1, erase: false, mapping: Mapping::default(), modifiers: Modifiers::NONE });
        for i in 0..30 {
            send(StrokeCommand::Sample { id: 1, x: 20.0 + i as f64 * 7.0, y: 100.0 + (i as f64 * 0.4).sin() * 30.0, pressure: 1.0, time_ms: i as f64, lean: None });
        }
        send(StrokeCommand::End { id: 1 });
        let mut last = Vec::new();
        for _ in 0..400 {
            last = frame(&gpu, &mut pipeline, &primitive);
            if core.inspector().finished_strokes >= 1 && core.gpu_stats().batches_waiting == 0 && core.with_ledger(|l| l.visible_dabs()) == 0 {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(core.gpu_stats().wet_instances, 0, "no preview is drawn once the tiles are in");
        // Once the tiles are in, the frame is the cel: pixel for pixel what the worker holds, over white.
        core.worker.send(styk_core::drawing::worker::Request::Snapshot { token: 1 });
        let snapshot = loop {
            // The pad's own prepare reads the replies for it; the test only needs the snapshot.
            if let styk_core::drawing::worker::Reply::Snapshot { tiles, .. } = core.worker.wait(Duration::from_secs(10)).expect("the worker answers") {
                break tiles;
            }
        };
        let want = expected(&snapshot);
        let ink = want.chunks_exact(4).filter(|p| p[0] < 128).count();
        assert!(ink > 500, "the stroke has ink: {ink} dark pixels");
        let wrong = last.chunks_exact(4).zip(want.chunks_exact(4)).filter(|(a, b)| a.iter().zip(b.iter()).any(|(x, y)| (*x as i32 - *y as i32).abs() > 2)).count();
        assert_eq!(wrong, 0, "{wrong} pixels of the frame differ from the cel");

        // Clear and undo change tiles the pad holds: it is told which, asks for the ones it shows and draws what comes back.
        let until = |core: &Arc<PadCore>, pipeline: &mut InkPipeline, target: &[u8]| {
            for _ in 0..400 {
                let image = frame(&gpu, pipeline, &InkPrimitive { core: core.clone() });
                if image.chunks_exact(4).zip(target.chunks_exact(4)).all(|(a, b)| a.iter().zip(b.iter()).all(|(x, y)| (*x as i32 - *y as i32).abs() <= 2)) {
                    return true;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            false
        };
        core.worker.send(styk_core::drawing::worker::Request::Clear);
        assert!(until(&core, &mut pipeline, &vec![255u8; (SIZE * SIZE * 4) as usize]), "after a clear the pad shows blank paper");
        core.worker.send(styk_core::drawing::worker::Request::Undo);
        assert!(until(&core, &mut pipeline, &want), "after undoing the clear the pad shows the stroke again");
        // Moving the view away evicts nothing it needs and back again shows the same pixels.
        core.set_view(crate::ink_pad::View { zoom: 1.0, pan: (4096.0, 0.0) });
        assert!(until(&core, &mut pipeline, &vec![255u8; (SIZE * SIZE * 4) as usize]), "a view over empty cel is blank paper");
        core.set_view(crate::ink_pad::View { zoom: 1.0, pan: (0.0, 0.0) });
        assert!(until(&core, &mut pipeline, &want), "the view back over the stroke shows it again");
    }

    // B1: moving the view over tiles a stroke inked while they were out of sight must show that ink, mid-stroke and after it.
    #[test]
    fn a_view_that_moves_over_the_open_strokes_ink_shows_it_and_keeps_it() {
        let gpu = gpu().expect(NO_GPU);
        let core = core();
        let mut pipeline = InkPipeline::new(&gpu.device, &gpu.queue, wgpu::TextureFormat::Rgba8Unorm);
        let primitive = InkPrimitive { core: core.clone() };
        core.with_ledger(|ledger| ledger.stroke_started(1, true));
        let brush = BrushConfig { size: 14.0, hardness: 1.0, ..BrushConfig::default() }.to_json();
        let send = |command: StrokeCommand| {
            core.worker.command(command, &brush);
        };
        // Every frame drawn once the view is over the ink, to compare with today's sequence: the preview of a batch overlaps its tiles
        // for one presented frame at most, so no frame is ever darker than the finished cel (a double paint darkens a soft edge).
        let shown: std::cell::RefCell<Vec<Vec<u8>>> = std::cell::RefCell::new(Vec::new());
        let moved = std::cell::Cell::new(false);
        let settle = |pipeline: &mut InkPipeline, frames: usize| {
            for _ in 0..frames {
                let image = frame(&gpu, pipeline, &primitive);
                if moved.get() {
                    shown.borrow_mut().push(image);
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        };
        send(StrokeCommand::Begin { id: 1, erase: false, mapping: Mapping::default(), modifiers: Modifiers::NONE });
        let sample = |i: usize| StrokeCommand::Sample { id: 1, x: 280.0 + i as f64 * 7.0, y: 100.0 + (i as f64 * 0.4).sin() * 30.0, pressure: 1.0, time_ms: i as f64, lean: None };
        // The first half is inked in tiles 4 and 5, which the view (cel pixels 0 to 256) does not show.
        for i in 0..15 {
            send(sample(i));
        }
        settle(&mut pipeline, 60);
        // The view moves over them while the stroke is still open, and the stroke goes on.
        core.set_view(crate::ink_pad::View { zoom: 1.0, pan: (256.0, 0.0) });
        moved.set(true);
        settle(&mut pipeline, 60);
        for i in 15..30 {
            send(sample(i));
        }
        send(StrokeCommand::End { id: 1 });
        let mut last = Vec::new();
        for _ in 0..400 {
            last = frame(&gpu, &mut pipeline, &primitive);
            shown.borrow_mut().push(last.clone());
            if core.inspector().finished_strokes >= 1 && core.gpu_stats().batches_waiting == 0 && core.with_ledger(|l| l.visible_dabs()) == 0 {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        core.worker.send(styk_core::drawing::worker::Request::Snapshot { token: 1 });
        let snapshot = loop {
            if let styk_core::drawing::worker::Reply::Snapshot { tiles, .. } = core.worker.wait(Duration::from_secs(10)).expect("the worker answers") {
                break tiles;
            }
        };
        // The cel pixels 256 to 512 are what the view shows: the same as the tiles moved four to the left.
        let want = expected(&snapshot.iter().map(|(tx, ty, px)| (tx - 4, *ty, px.clone())).collect::<Vec<_>>());
        let ink = want.chunks_exact(4).filter(|p| p[0] < 128).count();
        assert!(ink > 300, "the first half of the stroke is in the view: {ink} dark pixels");
        let wrong = last.chunks_exact(4).zip(want.chunks_exact(4)).filter(|(a, b)| a.iter().zip(b.iter()).any(|(x, y)| (*x as i32 - *y as i32).abs() > 2)).count();
        assert_eq!(wrong, 0, "{wrong} pixels of the frame differ from the cel: ink drawn before the view arrived is missing");
        let darker: usize = shown.borrow().iter().map(|image| image.chunks_exact(4).zip(want.chunks_exact(4)).filter(|(a, b)| (0..3).any(|c| (a[c] as i32) < (b[c] as i32) - 2)).count()).sum();
        assert_eq!(darker, 0, "{darker} pixels over {} frames were darker than the finished cel: ink was painted twice", shown.borrow().len());
    }

    // Today's model: the view's tiles are held above the soft budget by growing the atlas a page at a time; nothing visible is evicted.
    #[test]
    fn a_view_that_shows_more_tiles_than_a_page_holds_grows_the_texture_and_draws_every_tile() {
        let gpu = gpu().expect(NO_GPU);
        let core = core();
        let mut pipeline = InkPipeline::new(&gpu.device, &gpu.queue, wgpu::TextureFormat::Rgba8Unorm);
        // A page of two tiles: the stroke below inks far more than that in the 4 x 4 tiles the view shows.
        pipeline.sync = TileSync::new(2, 8);
        let primitive = InkPrimitive { core: core.clone() };
        core.with_ledger(|ledger| ledger.stroke_started(1, true));
        let brush = BrushConfig { size: 14.0, hardness: 1.0, ..BrushConfig::default() }.to_json();
        let send = |command: StrokeCommand| {
            core.worker.command(command, &brush);
        };
        send(StrokeCommand::Begin { id: 1, erase: false, mapping: Mapping::default(), modifiers: Modifiers::NONE });
        for i in 0..30 {
            send(StrokeCommand::Sample { id: 1, x: 20.0 + i as f64 * 7.0, y: 100.0 + (i as f64 * 0.4).sin() * 30.0, pressure: 1.0, time_ms: i as f64, lean: None });
        }
        send(StrokeCommand::End { id: 1 });
        let mut last = Vec::new();
        for _ in 0..400 {
            last = frame(&gpu, &mut pipeline, &primitive);
            if core.inspector().finished_strokes >= 1 && core.gpu_stats().batches_waiting == 0 && core.with_ledger(|l| l.visible_dabs()) == 0 {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        core.worker.send(styk_core::drawing::worker::Request::Snapshot { token: 1 });
        let snapshot = loop {
            if let styk_core::drawing::worker::Reply::Snapshot { tiles, .. } = core.worker.wait(Duration::from_secs(10)).expect("the worker answers") {
                break tiles;
            }
        };
        assert!(snapshot.len() > 2, "the stroke inks more tiles than a page holds: {}", snapshot.len());
        assert!(core.gpu_stats().pages > 1 && pipeline.atlas_pages as usize == core.gpu_stats().pages, "the atlas grew: {} pages", core.gpu_stats().pages);
        assert_eq!(core.gpu_stats().sync.refused, 0);
        let want = expected(&snapshot);
        let wrong = last.chunks_exact(4).zip(want.chunks_exact(4)).filter(|(a, b)| a.iter().zip(b.iter()).any(|(x, y)| (*x as i32 - *y as i32).abs() > 2)).count();
        assert_eq!(wrong, 0, "{wrong} pixels of the frame differ from the cel: a tile on a later page is missing or wrong");
    }

    #[test]
    fn a_uniform_block_that_has_not_changed_is_not_written_again() {
        let uniforms = Uniforms { size: [10.0, 10.0], pan: [0.0, 0.0], zoom: 1.0, atlas_w: 4096.0, atlas_h: 2048.0, srgb: 0.0, color: [0.0; 4], wet: [1.0, 1.0, 0.0, 0.0], paper: PAPER };
        assert!(uniforms_changed(&None, &uniforms), "the first block is always written");
        assert!(!uniforms_changed(&Some(uniforms), &uniforms), "an identical block is skipped");
        let moved = Uniforms { pan: [1.0, 0.0], ..uniforms };
        assert!(uniforms_changed(&Some(uniforms), &moved), "a block that differs is written");
    }
}
