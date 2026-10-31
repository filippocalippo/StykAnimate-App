//! wgpu renderer for StykAnimate draw lists.
//!
//! * One instanced draw per pass, whatever the primitive mix. Primitive records are
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

//! Modules: [`pipeline`] (the shader pipeline and bind layouts), [`frame`]
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
mod glyphs;
#[cfg(feature = "gpu")]
mod images;
#[cfg(feature = "gpu")]
mod isolation;
#[cfg(feature = "gpu")]
mod materials;
#[cfg(feature = "gpu")]
mod pipeline;
#[cfg(feature = "gpu")]
mod present;
#[cfg(feature = "gpu")]
mod resources;
mod view;

#[cfg(feature = "gpu")]
pub use images::{decode_images, DecodedImage};
#[cfg(feature = "gpu")]
pub use present::read_frame;
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
    /// Atlas page size, and the frame size it grew from (pages fit the largest layer).
    pub(crate) page: [u32; 2],
    pub(crate) page_frame: [u32; 2],
    /// Frames in a row whose layers all fit pages of the frame's size.
    pub(crate) page_small: u32,
    /// Effect passes, created with the first frame that filters.
    pub(crate) executor: Option<effects::executor::Executor>,
    /// Depth runs (docs/engine/spatial.md): the pipelines and multisampled depth
    /// buffers of passes with depth-tested faces, created with the first list that has any.
    pub(crate) depth_pipelines: Option<pipeline::DepthPipelines>,
    pub(crate) depth_main: Option<(wgpu::Texture, [u32; 2])>,
    pub(crate) depth_layer: Option<(wgpu::Texture, [u32; 2])>,
    /// Ranges of the current list's prims that are depth-tested faces; empty when it has none.
    pub(crate) depth_faces: Vec<(u32, u32)>,
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

    /// Uploads a draw list unless it is already resident.
    pub fn set_list(&mut self, list: &Arc<DrawList>) {
        if self.list.as_ref().is_some_and(|l| Arc::ptr_eq(l, list)) {
            return;
        }
        let prims: &[GpuPrim] = bytemuck::cast_slice(prims_bytes(&list.prims));
        let need = std::mem::size_of_val(prims) as u64;
        if need > self.prims.size() {
            self.prims = buffer(&self.device, "styk prims", need.next_power_of_two(), wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST);
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
