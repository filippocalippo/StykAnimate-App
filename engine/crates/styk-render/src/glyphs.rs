//! Masks of lone glyphs (styk-draw `K_GLYPH`, docs/engine/rendering.md): the glyph
//! textures of the editor's WebGPU renderer (`glyphTextureDescriptor`). A glyph is filled once per mask size, four samples per
//! texel, into a page of an atlas of one-channel pages, and kept across frames: every
//! instance of that glyph and size samples the same mask. Pages are square, 1,024 texels a
//! side until a frame needs a larger mask (then all of them grow, up to 4,096, and the masks
//! are filled again as they are drawn); the atlas holds at most [`BUDGET`] bytes of pages.
//! When a mask does not fit, the least recently used page that no instance of the frame
//! samples is emptied. An instance whose mask cannot be placed is drawn from its triangles
//! for that frame.

use std::collections::HashMap;
use std::sync::Arc;

use styk_draw::{DrawList, GlyphMask, GlyphMaskLayout};

use crate::isolation::Shelf;
use crate::resources::Table;
use crate::{Renderer, SAMPLES};

/// The side of an atlas page, at least and at most (smaller where the device's textures are).
const SMALLEST_PAGE: u32 = 1024;
const PAGE: u32 = 4096;
/// Bytes of pages the atlas may hold (64 MiB: four pages of 4,096 texels a side, 64 of 1,024).
pub(crate) const BUDGET: u64 = 64 << 20;
const MASK_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::R8Unorm;
/// Texels of the glyph table per instance (layout in prim.wgsl, `K_GLYPH`).
const ROW_TEXELS: usize = 3;

/// A mask's identity: the glyph's triangles (an allocation every instance of one glyph and
/// tessellation level shares) and the mask's size.
type Key = (usize, u32, u32);

struct Entry {
    page: u32,
    at: [u32; 2],
    /// Held so the allocation, and so the key, stays this glyph's.
    _triangles: Arc<[[f32; 2]]>,
}

struct Page {
    shelf: Shelf,
    /// The last frame an instance sampled a mask of this page.
    used: u64,
}

pub(crate) struct GlyphMasks {
    pub(crate) texture: wgpu::Texture,
    pub(crate) view: wgpu::TextureView,
    side: u32,
    pages: Vec<Page>,
    entries: HashMap<Key, Entry>,
    pipeline: Option<wgpu::RenderPipeline>,
    /// Where each instance of the current list is drawn from, for this frame.
    pub(crate) table: Table,
    rows: Vec<[f32; 4]>,
    frame: u64,
    /// Masks filled in the last frame.
    pub(crate) filled: u32,
    /// The atlas texture was replaced since the last bind.
    replaced: bool,
}

/// The atlas texture: `layers` pages (at least two, D11) of `side` texels.
fn atlas(device: &wgpu::Device, side: u32, layers: u32) -> (wgpu::Texture, wgpu::TextureView) {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("styk glyph masks"),
        size: wgpu::Extent3d { width: side, height: side, depth_or_array_layers: layers.max(2) },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: MASK_FORMAT,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = texture.create_view(&wgpu::TextureViewDescriptor { dimension: Some(wgpu::TextureViewDimension::D2Array), ..Default::default() });
    (texture, view)
}

impl GlyphMasks {
    /// An empty atlas of one texel a side until a list draws a lone glyph.
    pub(crate) fn new(device: &wgpu::Device) -> GlyphMasks {
        let (texture, view) = atlas(device, 1, 2);
        GlyphMasks {
            texture,
            view,
            side: 1,
            pages: Vec::new(),
            entries: HashMap::new(),
            pipeline: None,
            table: Table::new(device, "styk glyph instances", wgpu::TextureFormat::Rgba32Float, 16),
            rows: Vec::new(),
            frame: 0,
            filled: 0,
            replaced: false,
        }
    }

    /// GPU memory of the atlas (nothing until a list draws a lone glyph).
    pub(crate) fn bytes(&self) -> u64 {
        if self.pages.is_empty() {
            return 0;
        }
        self.side as u64 * self.side as u64 * self.texture.depth_or_array_layers() as u64
    }

    /// The masks kept.
    pub(crate) fn count(&self) -> usize {
        self.entries.len()
    }

    /// A place for a `w`×`h` mask: in a page with room, a new page, or the least recently
    /// used page no instance of this frame samples, emptied. `None` when none is free.
    fn place(&mut self, device: &wgpu::Device, encoder: &mut wgpu::CommandEncoder, w: u32, h: u32) -> Option<(u32, [u32; 2])> {
        for (index, page) in self.pages.iter_mut().enumerate() {
            if let Some((_, x, y)) = page.shelf.place(w, h, 1) {
                return Some((index as u32, [x, y]));
            }
        }
        if (self.pages.len() as u64 + 1) * (self.side as u64 * self.side as u64) <= BUDGET {
            let index = self.pages.len() as u32;
            self.grow(device, encoder, index + 1);
            let mut page = Page { shelf: Shelf { size: [self.side, self.side], page: 0, x: 0, y: 0, row: 0 }, used: 0 };
            let (_, x, y) = page.shelf.place(w, h, 1)?;
            self.pages.push(page);
            return Some((index, [x, y]));
        }
        let (index, _) = self.pages.iter().enumerate().filter(|(_, p)| p.used < self.frame).min_by_key(|(_, p)| p.used)?;
        self.entries.retain(|_, e| e.page != index as u32);
        let page = &mut self.pages[index];
        page.shelf = Shelf { size: [self.side, self.side], page: 0, x: 0, y: 0, row: 0 };
        let (_, x, y) = page.shelf.place(w, h, 1)?;
        Some((index as u32, [x, y]))
    }

    /// Pages of at least `side` texels: when they are smaller, every mask is dropped and the
    /// pages start again at that side (masks are filled again as instances draw them).
    fn fit(&mut self, side: u32) {
        let side = side.max(SMALLEST_PAGE).next_power_of_two();
        if side > self.side {
            self.entries.clear();
            self.pages.clear();
            self.side = side;
        }
    }

    /// Makes room for `pages` pages, keeping the masks already filled.
    fn grow(&mut self, device: &wgpu::Device, encoder: &mut wgpu::CommandEncoder, pages: u32) {
        let layers = self.texture.depth_or_array_layers();
        if pages <= layers && self.texture.width() == self.side {
            return;
        }
        let (texture, view) = atlas(device, self.side, pages.max(layers));
        if !self.pages.is_empty() {
            let extent = wgpu::Extent3d { width: self.side, height: self.side, depth_or_array_layers: self.pages.len() as u32 };
            encoder.copy_texture_to_texture(self.texture.as_image_copy(), texture.as_image_copy(), extent);
        }
        self.texture = texture;
        self.view = view;
        self.replaced = true;
    }

    /// Fills the glyph `triangles` into a new mask laid out as `mask` at `page`, `at`: four samples a
    /// texel (as the editor's Canvas 2D fills its glyph textures, with coverage), resolved,
    /// then copied into place.
    fn fill(&mut self, device: &wgpu::Device, encoder: &mut wgpu::CommandEncoder, triangles: &[[f32; 2]], mask: &GlyphMaskLayout, page: u32, at: [u32; 2]) {
        let (w, h) = (mask.width, mask.height);
        use wgpu::util::DeviceExt;
        let pipeline = self.pipeline.get_or_insert_with(|| mask_pipeline(device));
        let target = |label: &str, samples: u32, usage: wgpu::TextureUsages| {
            device.create_texture(&wgpu::TextureDescriptor {
                label: Some(label),
                size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: samples,
                dimension: wgpu::TextureDimension::D2,
                format: MASK_FORMAT,
                usage,
                view_formats: &[],
            })
        };
        let msaa = target("styk glyph mask samples", SAMPLES, wgpu::TextureUsages::RENDER_ATTACHMENT);
        let resolved = target("styk glyph mask", 1, wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC);
        // Glyph space → the mask's texels (`setTransform(scaleX, 0, 0, scaleY, …)`) → clip space.
        let [sx, sy, tx, ty] = mask.from_glyph;
        let clip: Vec<[f32; 2]> = triangles
            .iter()
            .map(|p| {
                let (u, v) = (sx * p[0] as f64 + tx, sy * p[1] as f64 + ty);
                [(u / w as f64 * 2.0 - 1.0) as f32, (1.0 - v / h as f64 * 2.0) as f32]
            })
            .collect();
        let vertices = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("styk glyph mask"), contents: bytemuck::cast_slice(&clip), usage: wgpu::BufferUsages::VERTEX });
        {
            let msaa_view = msaa.create_view(&Default::default());
            let resolved_view = resolved.create_view(&Default::default());
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("styk glyph mask"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &msaa_view,
                    depth_slice: None,
                    resolve_target: Some(&resolved_view),
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Discard },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(pipeline);
            pass.set_vertex_buffer(0, vertices.slice(..));
            pass.draw(0..clip.len() as u32, 0..1);
        }
        encoder.copy_texture_to_texture(
            resolved.as_image_copy(),
            wgpu::TexelCopyTextureInfo { texture: &self.texture, mip_level: 0, origin: wgpu::Origin3d { x: at[0], y: at[1], z: page }, aspect: wgpu::TextureAspect::All },
            wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        );
        self.filled += 1;
    }

    /// Plans the lone glyphs of `list` for a frame at raster density `resolution`: each
    /// instance's mask (filled now if no frame did yet) or its triangles, written to the
    /// glyph table. Returns whether the atlas texture was replaced (bind groups that hold it
    /// must be rebuilt) and whether the table was.
    pub(crate) fn prepare(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, encoder: &mut wgpu::CommandEncoder, list: &DrawList, resolution: f64, masks: bool) -> (bool, bool) {
        self.frame += 1;
        self.filled = 0;
        self.replaced = false;
        self.rows.clear();
        let max = (PAGE.min(device.limits().max_texture_dimension_2d) as f64).min(GlyphMask::MAX_DIMENSION);
        // Pages as large as this frame's largest mask, before any is placed.
        let largest = list.glyphs.iter().filter(|_| masks).filter_map(|g| g.mask.layout(resolution, GlyphMask::MAX_DIMENSION)).map(|m| m.width.max(m.height)).filter(|&d| d as f64 <= max).max();
        if let Some(largest) = largest {
            self.fit(largest);
        }
        for instance in &list.glyphs {
            let placed = instance.mask.layout(resolution, GlyphMask::MAX_DIMENSION).filter(|m| masks && (m.width as f64) <= max && (m.height as f64) <= max).and_then(|mask| {
                let key = (Arc::as_ptr(&instance.triangles) as *const u8 as usize, mask.width, mask.height);
                let (page, at) = match self.entries.get(&key) {
                    Some(e) => (e.page, e.at),
                    None => {
                        let (page, at) = self.place(device, encoder, mask.width, mask.height)?;
                        self.fill(device, encoder, &instance.triangles, &mask, page, at);
                        self.entries.insert(key, Entry { page, at, _triangles: instance.triangles.clone() });
                        (page, at)
                    }
                };
                self.pages[page as usize].used = self.frame;
                Some((mask, page, at))
            });
            match placed {
                Some((mask, page, at)) => {
                    let m = mask.to_world;
                    self.rows.push([m[0] as f32, m[1] as f32, m[2] as f32, m[3] as f32]);
                    self.rows.push([m[4] as f32, m[5] as f32, mask.width as f32, mask.height as f32]);
                    self.rows.push([at[0] as f32, at[1] as f32, page as f32, 1.0]);
                }
                // Drawn from its triangles: the record collapses, its `F_GLYPH_VECTOR` triangles draw.
                None => self.rows.extend([[0.0; 4]; ROW_TEXELS]),
            }
        }
        let table_replaced = self.table.write(device, queue, bytemuck::cast_slice(&self.rows));
        (self.replaced, table_replaced)
    }
}

/// Fills glyph triangles (already in clip space) with full coverage, four samples a texel.
fn mask_pipeline(device: &wgpu::Device) -> wgpu::RenderPipeline {
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("styk glyph mask"), source: wgpu::ShaderSource::Wgsl(include_str!("glyph.wgsl").into()) });
    let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("styk glyph mask"), bind_group_layouts: &[], immediate_size: 0 });
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("styk glyph mask"),
        layout: Some(&layout),
        vertex: wgpu::VertexState {
            module: &shader,
            entry_point: Some("vs_mask"),
            compilation_options: Default::default(),
            buffers: &[Some(wgpu::VertexBufferLayout { array_stride: 8, step_mode: wgpu::VertexStepMode::Vertex, attributes: &wgpu::vertex_attr_array![0 => Float32x2] })],
        },
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState { count: SAMPLES, mask: !0, alpha_to_coverage_enabled: false },
        fragment: Some(wgpu::FragmentState {
            module: &shader,
            entry_point: Some("fs_mask"),
            compilation_options: Default::default(),
            targets: &[Some(wgpu::ColorTargetState { format: MASK_FORMAT, blend: None, write_mask: wgpu::ColorWrites::ALL })],
        }),
        multiview_mask: None,
        cache: None,
    })
}

impl Renderer {
    /// Plans the current list's lone glyphs for raster density `resolution` (see
    /// [`GlyphMasks::prepare`]) and rebinds what was replaced.
    pub(crate) fn prepare_glyphs(&mut self, encoder: &mut wgpu::CommandEncoder, list: &DrawList, resolution: f64) {
        if list.glyphs.is_empty() {
            self.glyphs.filled = 0;
            return;
        }
        // Crisp edges draw every glyph from its outline: a mask's coverage is smooth.
        let (atlas, table) = self.glyphs.prepare(&self.device, &self.queue, encoder, list, resolution, !self.crisp);
        if atlas {
            self.rebind_sprites();
        }
        if table {
            self.rebind();
        }
    }
}
