//! wgpu renderer for StykAnimate draw lists.
//!
//! * One instanced draw per pass, whatever the primitive mix (on a software rasterizer, one per
//!   run of primitives a simpler fragment entry point holds: [`shading`]). Primitive records are
//!   instance attributes and the tables shaders look up (gradients, isolation group
//!   placements, polyline vertices) are float textures, so the same pipeline runs on
//!   WebGPU, Vulkan/Metal/DX12 and WebGL2, which has no storage buffers.
//! * Draw lists are view independent: pan/zoom only rewrites a small view uniform.
//! * Translucent figures are isolated in an atlas: one pass per nesting depth
//!   (ping-ponging between two atlases), not one pass per figure. When the
//!   layers of a frame do not fit the atlas, they are drawn in rounds, each at
//!   full resolution, with the frame drawn between rounds.
//! * Sprites live in a texture array filled from images decoded on worker threads.
//! * Output is drawn into an offscreen `Rgba8Unorm` frame (gamma-space blending,
//!   like Canvas 2D) and copied into the host's surface.

//! Modules: [`pipeline`] (the shader's pipelines and bind layouts), [`shading`] (which fragment
//! entry point draws a run of primitives), [`frame`]
//! (passes of one frame), [`isolation`] (layer atlas and rounds), [`images`]
//! (sprite and drawing atlas), [`resources`] (record layouts, lookup tables),
//! [`present`] (surface copy and read-back), [`view`], [`effects`].
//!
//! The renderer is the `gpu` feature (on by default). Without it the crate is what both
//! renderers follow, which the CPU rasterizer (styk-raster) uses: [`ViewParams`],
//! [`Edges`], where each layer is drawn for a view (`effects::plan`, `effects::record`)
//! and effect recipes (`effects::recipe`).

#[cfg(feature = "gpu")]
use std::sync::Arc;

#[cfg(feature = "gpu")]
use styk_draw::DrawList;

#[cfg(feature = "gpu")]
pub use wgpu;

pub mod effects;
pub mod paint;
#[cfg(feature = "gpu")]
mod frame;
#[cfg(feature = "gpu")]
mod budget;
#[cfg(all(feature = "gpu", not(target_arch = "wasm32")))]
pub mod native_gpu;
#[cfg(feature = "gpu")]
mod glyphs;
#[cfg(feature = "gpu")]
mod images;
#[cfg(feature = "gpu")]
mod isolation;
#[cfg(feature = "gpu")]
mod materials;
#[cfg(feature = "gpu")]
mod pictures;
#[cfg(feature = "gpu")]
mod pipeline;
#[cfg(feature = "gpu")]
mod present;
#[cfg(feature = "gpu")]
mod resources;
#[cfg(feature = "gpu")]
mod shading;
#[cfg(all(test, feature = "gpu"))]
mod lifetime_tests;
mod view;

#[cfg(feature = "gpu")]
pub use images::{decode_images, DecodedImage, MAX_PAGES};
#[cfg(feature = "gpu")]
pub use frame::FramePlan;
#[cfg(feature = "gpu")]
pub use present::{read_frame, RenderedFrame};
pub use view::{ViewParams, CAMERA_PREVIEW_LIMIT};
pub use effects::plan::DrawingGrid;

#[cfg(feature = "gpu")]
use isolation::LayerAtlas;
#[cfg(feature = "gpu")]
use resources::{buffer, prims_bytes, GpuPrim, Table};

/// Samples per pixel of smooth edges (triangles; analytic shapes cover by distance).
pub const SAMPLES: u32 = 4;
#[cfg(feature = "gpu")]
pub(crate) const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
#[cfg(feature = "gpu")]
pub(crate) const MAX_LAYER_PAGES: u32 = 8;
#[cfg(feature = "gpu")]
pub(crate) const UNIFORM_STRIDE: u64 = 256;

#[cfg(feature = "gpu")]
pub struct Stats {
    pub prims: u32,
    pub groups: u32,
    pub passes: u32,
    /// A group's layers were drawn below full resolution (they alone exceed the atlas).
    pub downscaled: bool,
    /// Rounds of isolation layers the last frame needed (1 when they all fit the atlas).
    pub rounds: u32,
    /// Layers the last frame filtered, and the effect passes it ran.
    pub effect_layers: u32,
    pub effect_passes: u32,
    /// GPU memory of the effect working slots and of the isolation atlases.
    pub effect_bytes: u64,
    pub layer_bytes: u64,
    /// GPU memory of the multisampled depth buffers of depth runs (3D faces); 0 without any.
    pub depth_bytes: u64,
    /// GPU memory of the particle material atlas (generated effects); 0 until a list needs it.
    pub material_bytes: u64,
    /// Lone glyphs drawn from masks (styk-draw `K_GLYPH`): the masks kept, those the last
    /// frame filled, and the GPU memory of their atlas (0 until a list draws one).
    pub glyph_masks: u32,
    pub glyph_masks_filled: u32,
    pub glyph_bytes: u64,
}

/// How a renderer covers shape edges.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Edges {
    /// Antialiased: four samples a pixel, analytic shapes covered by distance (the editor's
    /// WebGPU renderer, and exports' Smooth edges and Smooth sprites).
    Smooth,
    /// Aliased, as Pivot's "No smoothing" exports: one sample a pixel at its centre, every
    /// shape fully in or out, lone glyphs from their outlines, layers and drawing cels
    /// resampled to the nearest texel. Opacity is kept. See `docs/export-sampling.md`.
    Crisp,
}

#[cfg(feature = "gpu")]
pub struct Renderer {
    pub(crate) device: wgpu::Device,
    pub(crate) queue: wgpu::Queue,
    pub(crate) pipeline: wgpu::RenderPipeline,
    pub(crate) blit: wgpu::RenderPipeline,
    pub(crate) composite: wgpu::RenderPipeline,
    pub(crate) blit_layout: wgpu::BindGroupLayout,
    pub(crate) layout0: wgpu::BindGroupLayout,
    pub(crate) layout1: wgpu::BindGroupLayout,
    pub(crate) layout2: wgpu::BindGroupLayout,
    pub(crate) uniforms: wgpu::Buffer,
    pub(crate) uniform_slots: u64,
    pub(crate) prims: wgpu::Buffer,
    pub(crate) paints: Table,
    pub(crate) groups: Table,
    pub(crate) points: Table,
    pub(crate) bind0: Option<wgpu::BindGroup>,
    pub(crate) sprites: wgpu::Texture,
    pub(crate) sprite_view: wgpu::TextureView,
    pub(crate) sprite_map: images::SpriteMap,
    /// Which pictures of the layout are in the sprite texture, and the soft copies of the rest.
    pub(crate) pictures: pictures::PictureState,
    pub(crate) sprite_bind: wgpu::BindGroup,
    /// The particle material atlas of generated effects, and its trilinear sampler.
    pub(crate) materials: materials::Materials,
    pub(crate) material_sampler: wgpu::Sampler,
    /// The masks of lone glyphs (styk-draw `K_GLYPH`) and where each instance is drawn from.
    pub(crate) glyphs: glyphs::GlyphMasks,
    /// Additive blending (generated effects), created with the first list that has any.
    pub(crate) pipeline_add: Option<wgpu::RenderPipeline>,
    /// Ranges of the current list's prims drawn additively; empty when it has none.
    pub(crate) add_ranges: Vec<(u32, u32)>,
    pub(crate) nearest: wgpu::Sampler,
    pub(crate) linear: wgpu::Sampler,
    pub(crate) layers: [LayerAtlas; 2],
    pub(crate) layer_binds: [wgpu::BindGroup; 2],
    pub(crate) msaa_main: Option<(wgpu::Texture, [u32; 2])>,
    pub(crate) msaa_layer: Option<(wgpu::Texture, [u32; 2])>,
    pub(crate) output: Option<(wgpu::Texture, wgpu::TextureView, wgpu::BindGroup, [u32; 2])>,
    pub(crate) list: Option<Arc<DrawList>>,
    pub(crate) list_prims: u32,
    /// A list to be set next that holds what another list holds but in some ranges of primitives ([`Renderer::note_changes`]).
    pub(crate) changes: Option<(Arc<DrawList>, Arc<DrawList>, Vec<(u32, u32)>)>,
    /// Of the current list: each group's first and past-last primitive (`u32::MAX, 0` for none), and where its composites are, worked
    /// out when the list is set rather than at every frame drawn of it (a dense list is hundreds of thousands of primitives).
    pub(crate) group_runs: Vec<(u32, u32)>,
    pub(crate) composites: Vec<u32>,
    /// Atlas page size, and the frame size it grew from (pages fit the largest layer).
    pub(crate) page: [u32; 2],
    pub(crate) page_frame: [u32; 2],
    /// Sizes that depend on the frame alone ([`Renderer::set_exact_sizes`]).
    pub(crate) exact_sizes: bool,
    /// Effect passes, created with the first frame that filters.
    pub(crate) executor: Option<effects::executor::Executor>,
    /// Depth runs (docs/engine/spatial.md): the pipelines and multisampled depth
    /// buffers of passes with depth-tested faces, created with the first list that has any.
    pub(crate) depth_pipelines: Option<pipeline::DepthPipelines>,
    pub(crate) depth_main: Option<(wgpu::Texture, [u32; 2])>,
    pub(crate) depth_layer: Option<(wgpu::Texture, [u32; 2])>,
    /// Ranges of the current list's prims that are depth-tested faces; empty when it has none.
    pub(crate) depth_faces: Vec<(u32, u32)>,
    /// Of the current list: the runs of prims and the fragment shader each draws with ([`shading`]), and the pipelines of the
    /// simpler shaders (`shading::Shading::SIMPLER`), each created with the first frame that draws with it. Off ([`Renderer::set_shading_runs`]:
    /// the default but on a software rasterizer), every prim draws with the general one.
    pub(crate) shading_runs: Arc<[(u32, u32, shading::Shading)]>,
    /// By form (`[general view, plain]`, `shading::Shading::entry`), then by simpler shader.
    pub(crate) shading_pipelines: [[Option<wgpu::RenderPipeline>; 5]; 2],
    pub(crate) shading_on: bool,
    pub(crate) prim_shader: wgpu::ShaderModule,
    pub(crate) prim_layout: wgpu::PipelineLayout,
    /// Samples per pixel of the frame and layer passes: [`SAMPLES`], or 1 for [`Edges::Crisp`].
    pub(crate) samples: u32,
    pub(crate) crisp: bool,
    pub(crate) drawing_grid: DrawingGrid,
    pub(crate) paint_context: paint::PaintContext,
    /// The workspace view's rotation and mirroring, applied after the scene camera ([`Renderer::set_orientation`]).
    pub(crate) orientation: Option<effects::plan::Affine>,
    /// Set only by completed effect execution plus actual parent consumption.
    pub(crate) root_gpu_source: bool,
    pub stats: Stats,
}

#[cfg(feature = "gpu")]
impl Renderer {
    /// Selects the portable pixel-grid policy for eligible filtered drawings.
    /// The current draw list, decoded images and raster caches stay shared.
    pub fn set_drawing_grid(&mut self, grid: DrawingGrid) { self.drawing_grid = grid; }

    /// Makes a frame depend on the frame alone, not on the frames drawn before it (an export asks for it; the stage keeps what it
    /// has, because reallocating and refilling is the cost). It sizes layer-page and effect-slot dimensions by each frame (the effect
    /// passes address a slot by normalized position, 1 / its size, so one kept from a larger frame moves the last bit of those
    /// positions and a pixel here and there by one level), brings every particle material row in (the atlas is sampled
    /// trilinearly, so a texel at a row's edge read a neighbour that was there only when a list before had named it), and places
    /// the lone glyph masks afresh (a mask is sampled at `(place + position in the mask) / atlas side`, which rounds with the place,
    /// so a glyph drawn after others, which took the first places, differed by a level at its edges). Textures it replaces are
    /// destroyed, not dropped: a browser frees a dropped texture only when it collects it, which measured 28 GiB on a 4K video.
    /// Capacity and unused owners stay until document/export teardown; page count and primitive capacity never shrink per frame.
    pub fn set_exact_sizes(&mut self, exact: bool) {
        self.exact_sizes = exact;
        if let Some(executor) = &mut self.executor {
            executor.set_exact(exact);
        }
    }

    /// Rotates and mirrors the workspace view: `orientation` maps the neutral view's screen pixels
    /// to the shown ones (the editor rotates the Draw view about the artboard's centre and mirrors
    /// it, `cameraMatrix` in renderer-geometry.mjs). `ViewParams::matrix` must already include it;
    /// the renderer places what is bound to the artboard (the background, the camera image of scene
    /// effects, the artboard clip) by it. `None`, the default, is the upright view. Stays until set again.
    pub fn set_orientation(&mut self, orientation: Option<effects::plan::Affine>) { self.orientation = orientation; }

    /// Explicit root painter policy. Child targets remain Native; their
    /// completed composite receives the root clip exactly once.
    pub fn set_paint_context(&mut self, context: paint::PaintContext) { self.paint_context = context; }

    /// Whether this last foreground frame actually consumed a completed GPU
    /// effect source at the root. Ordinary views leave this receipt false.
    pub fn root_gpu_source(&self) -> bool { self.root_gpu_source }

    /// Says that `list`, to be set next, holds the primitives `since` holds but in the ranges `prims` (each `start..end`, in order) and as many
    /// of them: when `since` is the list this renderer holds, [`Renderer::set_list`] writes only those ranges. What else a list holds (paints,
    /// points, groups) is written as for any list. Forgotten at the next `set_list`, whatever it sets.
    pub fn note_changes(&mut self, list: &Arc<DrawList>, since: &Arc<DrawList>, prims: Vec<(u32, u32)>) {
        self.changes = Some((list.clone(), since.clone(), prims));
    }

    /// Uploads a draw list unless it is already resident.
    pub fn set_list(&mut self, list: &Arc<DrawList>) {
        if self.list.as_ref().is_some_and(|l| Arc::ptr_eq(l, list)) {
            return;
        }
        let changes = self.changes.take();
        // A list that is the one held but in some primitives (a gesture that moves a figure of a dense frame): only those are written, and
        // what is worked out of a list's primitives stays unless one of them composites, draws faces or adds light.
        if let Some((next, since, ranges)) = changes
            && Arc::ptr_eq(&next, list)
            && self.list.as_ref().is_some_and(|held| Arc::ptr_eq(held, &since))
            && since.prims.len() == list.prims.len()
            && since.groups.len() == list.groups.len()
            && ranges.iter().all(|&(start, end)| start <= end && end as usize <= list.prims.len())
        {
            let structural = |p: &styk_draw::Prim| p.kind & (styk_draw::F_DEPTH | styk_draw::F_ADD) != 0 || p.kind & 255 == styk_draw::K_COMPOSITE;
            let mut same = since.background_prims == list.background_prims;
            for &(start, end) in &ranges {
                let (start, end) = (start as usize, end as usize);
                same &= !list.prims[start..end].iter().any(structural) && !since.prims[start..end].iter().any(structural)
                    && list.prims[start..end].iter().zip(&since.prims[start..end]).all(|(a, b)| a.group == b.group && shading::shading(a) == shading::shading(b));
                self.queue.write_buffer(&self.prims, (start * std::mem::size_of::<GpuPrim>()) as u64, prims_bytes(&list.prims[start..end]));
            }
            let mut rebind = self.bind0.is_none();
            rebind |= self.paints.write(&self.device, &self.queue, bytemuck::cast_slice(&list.paints));
            rebind |= self.points.write(&self.device, &self.queue, bytemuck::cast_slice(&list.points));
            if rebind {
                self.rebind();
            }
            self.list = Some(list.clone());
            if same {
                self.ensure_materials(list.materials);
            } else {
                self.derive(list);
            }
            return;
        }
        let prims: &[GpuPrim] = bytemuck::cast_slice(prims_bytes(&list.prims));
        let need = std::mem::size_of_val(prims) as u64;
        let capacity = need.max(65536).next_power_of_two();
        if need > self.prims.size() {
            let next = buffer(&self.device, "styk prims", capacity, wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST);
            let old = std::mem::replace(&mut self.prims, next);
            if self.exact_sizes { old.destroy(); }
        }
        if !prims.is_empty() {
            self.queue.write_buffer(&self.prims, 0, bytemuck::cast_slice(prims));
        }
        let mut rebind = self.bind0.is_none();
        rebind |= self.paints.write(&self.device, &self.queue, bytemuck::cast_slice(&list.paints));
        rebind |= self.points.write(&self.device, &self.queue, bytemuck::cast_slice(&list.points));
        if rebind {
            self.rebind();
        }
        self.list_prims = list.prims.len() as u32;
        self.list = Some(list.clone());
        self.derive(list);
    }

    /// What is worked out of a list's primitives when it is set: each group's run, where its composites, faces and additive draws are.
    fn derive(&mut self, list: &Arc<DrawList>) {
        self.group_runs.clear();
        self.group_runs.resize(list.groups.len(), (u32::MAX, 0));
        self.composites.clear();
        for (i, p) in list.prims.iter().enumerate() {
            if let Some(run) = self.group_runs.get_mut(p.group as usize) {
                run.0 = run.0.min(i as u32);
                run.1 = i as u32 + 1;
            }
            if p.kind & 255 == styk_draw::K_COMPOSITE {
                self.composites.push(i as u32);
            }
        }
        // Generated effects: the materials their sprites sample.
        self.ensure_materials(list.materials);
        // Where the depth-tested faces are and where generated effects add light: passes
        // switch pipelines there. (A reset without faces draws nothing, with or without a
        // depth buffer.)
        self.depth_faces.clear();
        self.add_ranges.clear();
        let extend = |ranges: &mut Vec<(u32, u32)>, i: u32| match ranges.last_mut() {
            Some(last) if last.1 == i => last.1 = i + 1,
            _ => ranges.push((i, i + 1)),
        };
        for (i, p) in list.prims.iter().enumerate() {
            if p.kind & (styk_draw::F_DEPTH | styk_draw::F_ADD) == 0 {
                continue;
            }
            match p.kind & 255 {
                styk_draw::K_TRI if p.kind & styk_draw::F_DEPTH != 0 => extend(&mut self.depth_faces, i as u32),
                styk_draw::K_PARTICLE | styk_draw::K_BEAM if p.kind & styk_draw::F_ADD != 0 => extend(&mut self.add_ranges, i as u32),
                _ => {}
            }
        }
        if !self.add_ranges.is_empty() {
            self.additive_pipeline();
        }
        // The background (the root pass's leading fills) is drawn in a call of its own.
        let root = list.passes.iter().find(|p| p.depth == 0).map_or((0, 0), |p| (p.start, p.end));
        let background = root.0..root.0 + list.background_prims.min(root.1.saturating_sub(root.0));
        self.shading_runs = shading::runs(&list.prims, background).into();
    }

    /// Whether runs of prims draw with the simpler fragment shaders that hold their kinds or every prim with the general one.
    /// A renderer starts with them on where its device is a software rasterizer (`wgpu::DeviceType::Cpu`: SwiftShader, which
    /// Chromium draws WebGL2 with when there is no usable graphics card, llvmpipe, WARP), where they make a frame several times
    /// faster, and off on a graphics card. The pixels are the same either way on every adapter `tests/shading.rs` compares but
    /// Direct3D 12's compiler, which moved one pixel of the Canvas painter by a level.
    pub fn set_shading_runs(&mut self, on: bool) {
        self.shading_on = on;
    }

    /// Whether runs of prims draw with the simpler fragment shaders ([`Renderer::set_shading_runs`]).
    pub fn shading_runs(&self) -> bool {
        self.shading_on
    }

    pub fn device(&self) -> &wgpu::Device {
        &self.device
    }

    /// How this renderer covers edges.
    pub fn edges(&self) -> Edges {
        if self.crisp { Edges::Crisp } else { Edges::Smooth }
    }
    pub fn queue(&self) -> &wgpu::Queue {
        &self.queue
    }
}

#[cfg(all(feature = "inspect", feature = "gpu"))]
pub mod inspect;
