//! The pad's pipeline: the cel's tiles from an atlas texture and the wet ink, drawn in the toolkit's own render pass.
//!
//! `prepare` is where the drawing worker's replies reach the GPU: it takes them without blocking, uploads the tiles with
//! `write_texture` (at most [`TILES_PER_FRAME`] a frame), and tells the wet-ink ledger which batches are now complete,
//! all before the frame's draw, so the exact pixels and the end of their preview are in the same frame.

use super::core::{FrameRow, PadCore};
use bytemuck::{Pod, Zeroable};
use iced::Rectangle;
use iced::wgpu;
use iced::widget::shader::{self, Viewport};
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use styk_core::drawing::worker::{Reply, TileUpdate};

/// Tiles uploaded in one frame at most (the JavaScript stage's `96 tiles a call`).
pub const TILES_PER_FRAME: usize = 96;
/// Nanoseconds one frame may spend uploading tiles before the rest wait for the next (the JavaScript stage's 6 ms for the
/// calls of a frame, halved: the frame still has to draw).
const UPLOAD_NS: u64 = 3_000_000;
/// Atlas width in tiles; the atlas holds `ATLAS_TILES^2` tiles of 64 x 64 texels.
const ATLAS_TILES: u32 = 32;
const TILE: u32 = 64;
const ATLAS_TEXELS: u32 = ATLAS_TILES * TILE;
/// Wet dabs one frame draws at most.
const WET_CAPACITY: usize = 32_768;
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
    atlas: f32,
    srgb: f32,
    pad: f32,
    color: [f32; 4],
    wet: [f32; 4],
    paper: [f32; 4],
}

/// The paper the pad shows under the ink.
const PAPER: [f32; 4] = [1.0, 1.0, 1.0, 1.0];

/// An upload waiting for its frame: one tile of a batch, or the end-of-batch marker of a batch that changed none.
struct Pending {
    /// The stroke the tile belongs to; 0 for a restore or a replacement.
    stroke: u64,
    seq: u64,
    newest_ns: u64,
    last: bool,
    tile: Option<(i64, i64, Vec<u8>)>,
}

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
    slots: HashMap<(i64, i64), u32>,
    free: Vec<u32>,
    tiles_dirty: bool,
    pending: VecDeque<Pending>,
    exact_ns: u64,
    anchor: Option<(f32, f32, f32)>,
}

impl shader::Pipeline for InkPipeline {
    fn new(device: &wgpu::Device, _queue: &wgpu::Queue, format: wgpu::TextureFormat) -> InkPipeline {
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("styk.ink_pad"), source: wgpu::ShaderSource::Wgsl(include_str!("ink.wgsl").into()) });
        let atlas = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("styk.ink_pad.atlas"),
            size: wgpu::Extent3d { width: ATLAS_TEXELS, height: ATLAS_TEXELS, depth_or_array_layers: 1 },
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
            tile_instances: buffer("styk.ink_pad.tile_instances", (ATLAS_TILES * ATLAS_TILES + 1) as usize * std::mem::size_of::<TileInstance>()),
            wet_instances: buffer("styk.ink_pad.wet_instances", WET_CAPACITY * std::mem::size_of::<WetInstance>()),
            tile_count: 0,
            wet_count: 0,
            slots: HashMap::new(),
            free: (0..ATLAS_TILES * ATLAS_TILES).rev().collect(),
            tiles_dirty: true,
            pending: VecDeque::new(),
            exact_ns: 0,
            anchor: None,
        }
    }
}

impl InkPipeline {
    /// Writes a tile into the atlas, or removes it. Returns false when the atlas has no slot left.
    fn upload(&mut self, queue: &wgpu::Queue, (tx, ty, pixels): &TileUpdate) -> bool {
        let key = (*tx, *ty);
        let Some(pixels) = pixels else {
            if let Some(slot) = self.slots.remove(&key) {
                self.free.push(slot);
                self.tiles_dirty = true;
            }
            return true;
        };
        let slot = match self.slots.get(&key) {
            Some(slot) => *slot,
            None => {
                let Some(slot) = self.free.pop() else { return false };
                self.slots.insert(key, slot);
                self.tiles_dirty = true;
                slot
            }
        };
        let (sx, sy) = (slot % ATLAS_TILES, slot / ATLAS_TILES);
        queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: &self.atlas, mip_level: 0, origin: wgpu::Origin3d { x: sx * TILE, y: sy * TILE, z: 0 }, aspect: wgpu::TextureAspect::All },
            pixels,
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(TILE * 4), rows_per_image: Some(TILE) },
            wgpu::Extent3d { width: TILE, height: TILE, depth_or_array_layers: 1 },
        );
        true
    }

    fn tile_list(&self) -> Vec<TileInstance> {
        let mut list = Vec::with_capacity(self.slots.len() + 1);
        list.push(TileInstance { origin: [-1.0e6, -1.0e6], size: [2.0e6, 2.0e6], texel: [0.0, 0.0], solid: 1.0, pad: 0.0 });
        for (&(tx, ty), &slot) in &self.slots {
            list.push(TileInstance {
                origin: [(tx * TILE as i64) as f32, (ty * TILE as i64) as f32],
                size: [TILE as f32, TILE as f32],
                texel: [((slot % ATLAS_TILES) * TILE) as f32, ((slot / ATLAS_TILES) * TILE) as f32],
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
        let started = self.core.now_ns();
        let frame = self.core.next_frame();
        let scale = viewport.scale_factor();
        self.core.set_scale(scale);
        let view = self.core.view();
        let brush = self.core.brush();
        let switches = self.core.switches();
        let mut uploaded_now = 0u32;
        let mut atlas_full = 0u64;

        let mut replies = Vec::new();
        self.core.worker.drain(&mut replies);
        self.core.with_ledger(|ledger| ledger.begin_frame());
        let mut errors = Vec::new();
        let mut finished = 0u64;
        let (mut generate_ms, mut raster_ms) = (None, None);
        for reply in replies {
            match reply {
                Reply::Dabs { stroke, seq, dabs, generate_ms: g, newest_ns } => {
                    generate_ms = Some(g);
                    if let Some(last) = dabs.last() {
                        pipeline.anchor = Some((last.x, last.y, last.radius));
                    }
                    self.core.with_ledger(|ledger| ledger.dabs(stroke, seq, dabs, newest_ns));
                }
                Reply::Tiles { stroke, seq, tiles, raster_ms: r, newest_ns } => {
                    raster_ms = Some(r);
                    if self.core.with_ledger(|ledger| ledger.tiles_received(stroke, seq)) {
                        if tiles.is_empty() {
                            pipeline.pending.push_back(Pending { stroke, seq, newest_ns, last: true, tile: None });
                        }
                        let count = tiles.len();
                        for (i, (tx, ty, pixels)) in tiles.into_iter().enumerate() {
                            pipeline.pending.push_back(Pending { stroke, seq, newest_ns, last: i + 1 == count, tile: Some((tx, ty, pixels)) });
                        }
                    }
                }
                Reply::Finished { stroke, .. } => {
                    finished += 1;
                    self.core.with_ledger(|ledger| ledger.stroke_ended(stroke));
                }
                Reply::Cancelled { stroke, restore } => {
                    self.core.with_ledger(|ledger| ledger.stroke_dropped(stroke));
                    // What the stroke had queued is void; the cel's own pixels replace what it already uploaded.
                    pipeline.pending.retain(|p| p.stroke != stroke);
                    for tile in restore {
                        pipeline.pending.push_back(Pending { stroke: 0, seq: 0, newest_ns: 0, last: true, tile: Some((tile.0, tile.1, tile.2.unwrap_or_default())) });
                    }
                }
                Reply::Replaced { tiles } => {
                    for tile in tiles {
                        pipeline.pending.push_back(Pending { stroke: 0, seq: 0, newest_ns: 0, last: true, tile: Some((tile.0, tile.1, tile.2.unwrap_or_default())) });
                    }
                }
                Reply::Failed { stroke, message } => {
                    self.core.with_ledger(|ledger| ledger.stroke_dropped(stroke));
                    pipeline.pending.retain(|p| p.stroke != stroke);
                    errors.push(message);
                }
                Reply::Snapshot { .. } | Reply::Pong { .. } => {}
            }
        }

        // Restores and replacements (sequence 0) bypass the budget; a batch's tiles are paid for one by one.
        let mut budget = TILES_PER_FRAME;
        while let Some(front) = pipeline.pending.front() {
            let cost = usize::from(front.seq != 0 && front.tile.is_some());
            if cost > budget || (uploaded_now > 0 && self.core.now_ns() - started > UPLOAD_NS) {
                break;
            }
            let item = pipeline.pending.pop_front().expect("the queue has a front");
            budget -= cost;
            if let Some(tile) = &item.tile {
                // An empty pixel vector is the worker's "this tile is empty now".
                let update: TileUpdate = (tile.0, tile.1, if tile.2.is_empty() { None } else { Some(tile.2.clone()) });
                if pipeline.upload(queue, &update) {
                    uploaded_now += 1;
                } else {
                    atlas_full += 1;
                }
            }
            if item.last {
                pipeline.exact_ns = pipeline.exact_ns.max(item.newest_ns);
            }
        }
        let waiting = pipeline.pending.iter().find(|p| p.seq != 0).map(|p| p.seq);
        let (visible_dabs, newest_wet) = self.core.with_ledger(|ledger| {
            ledger.uploaded(waiting);
            ledger.age();
            (ledger.visible_dabs(), ledger.newest_ns())
        });

        // The wet ink: the batches the tiles do not yet replace, then the newest pointer position.
        let mut wet: Vec<WetInstance> = Vec::new();
        let eligible_now = switches.wet_ink && brush.wet_eligible(switches.erase_tool);
        let live = self.core.with_live(|live| *live);
        self.core.with_ledger(|ledger| {
            for batch in ledger.visible() {
                for d in batch {
                    wet.push(WetInstance { center: [d.x, d.y], radius: d.radius, opacity: d.opacity });
                }
            }
        });
        let mut wet_overflow = 0u64;
        let mut newest_wet_ns = if wet.is_empty() { 0 } else { newest_wet };
        if eligible_now && live.show {
            let radius = pipeline.anchor.map_or((brush.size as f32) / 2.0, |a| a.2);
            let target = live.predicted.or(live.raw.map(|r| (r.0, r.1)));
            if let (Some(from), Some(to)) = (pipeline.anchor, target) {
                let (dx, dy) = (to.0 - from.0, to.1 - from.1);
                let length = (dx * dx + dy * dy).sqrt();
                let steps = ((length / (radius * 0.35).max(0.5)).ceil() as usize).clamp(1, GAP_FILL);
                for i in 1..=steps {
                    let t = i as f32 / steps as f32;
                    wet.push(WetInstance { center: [from.0 + dx * t, from.1 + dy * t], radius, opacity: 1.0 });
                }
            } else if let Some(to) = target {
                wet.push(WetInstance { center: [to.0, to.1], radius, opacity: 1.0 });
            }
            if let Some(raw) = live.raw {
                newest_wet_ns = newest_wet_ns.max(raw.2);
            }
        }
        if wet.len() > WET_CAPACITY {
            wet_overflow = (wet.len() - WET_CAPACITY) as u64;
            wet.drain(..wet.len() - WET_CAPACITY);
        }
        pipeline.wet_count = wet.len() as u32;
        if !wet.is_empty() {
            queue.write_buffer(&pipeline.wet_instances, 0, bytemuck::cast_slice(&wet));
        }
        if pipeline.tiles_dirty {
            let list = pipeline.tile_list();
            pipeline.tile_count = list.len() as u32;
            queue.write_buffer(&pipeline.tile_instances, 0, bytemuck::cast_slice(&list));
            pipeline.tiles_dirty = false;
        }
        let [r, g, b] = brush.color;
        let uniforms = Uniforms {
            size: [bounds.width * scale, bounds.height * scale],
            pan: [view.pan.0 as f32, view.pan.1 as f32],
            zoom: (view.zoom as f32) * 1.0,
            atlas: ATLAS_TEXELS as f32,
            srgb: if pipeline.format.is_srgb() { 1.0 } else { 0.0 },
            pad: 0.0,
            color: [r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0, 1.0],
            wet: [brush.hardness as f32, brush.opacity as f32, 0.0, 0.0],
            paper: PAPER,
        };
        queue.write_buffer(&pipeline.uniforms, 0, bytemuck::bytes_of(&uniforms));

        let ended = self.core.now_ns();
        let used = pipeline.slots.len();
        let ledger_stats = self.core.with_ledger(|ledger| ledger.stats());
        let waiting_tiles = pipeline.pending.len();
        let exact_ns = pipeline.exact_ns;
        self.core.with_gpu(|gpu| {
            gpu.frames = frame;
            gpu.tiles_uploaded += uploaded_now as u64;
            gpu.tiles_resident = used;
            gpu.atlas_full += atlas_full;
            gpu.wet_instances = wet.len();
            gpu.wet_overflow += wet_overflow;
            gpu.prepare_last_us = (ended - started) / 1000;
            gpu.prepare_max_us = gpu.prepare_max_us.max(gpu.prepare_last_us);
            gpu.ledger = ledger_stats;
            gpu.upload_waiting = waiting_tiles;
            gpu.pad_px = (bounds.width * scale, bounds.height * scale);
        });
        self.core.with_inspector(|inspector| {
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
        self.core.record_frame(FrameRow {
            frame,
            prepare_start_ns: started,
            prepare_end_ns: ended,
            newest_wet_ns: newest_wet_ns,
            newest_exact_ns: exact_ns,
            wet_dabs: visible_dabs as u32,
            tiles_uploaded: uploaded_now,
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
