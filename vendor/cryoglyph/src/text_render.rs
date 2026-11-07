use crate::{
    ColorMode, FontSystem, GlyphDetails, GlyphToRender, GpuCacheStatus, PrepareError, RenderError,
    SwashCache, SwashContent, SwashImage, TextArea, TextAtlas, Viewport,
};
use cosmic_text::CacheKeyFlags;
use std::borrow::Cow;
use std::{num::NonZeroU64, slice};
use wgpu::util::StagingBelt;
use wgpu::{
    Buffer, BufferDescriptor, BufferUsages, COPY_BUFFER_ALIGNMENT, CommandEncoder,
    DepthStencilState, Device, Extent3d, MultisampleState, Origin3d, Queue, RenderPass,
    RenderPipeline, TexelCopyBufferLayout, TexelCopyTextureInfo, TextureAspect,
};

/// A text renderer that uses cached glyphs to render text into an existing render pass.
pub struct TextRenderer {
    staging_belt: StagingBelt,
    vertex_buffer: Buffer,
    vertex_buffer_size: u64,
    pipeline: RenderPipeline,
    glyph_vertices: Vec<GlyphToRender>,
    glyphs_to_render: u32,
    incomplete: bool,
}

impl TextRenderer {
    /// Creates a new `TextRenderer`.
    pub fn new(
        atlas: &mut TextAtlas,
        device: &Device,
        multisample: MultisampleState,
        depth_stencil: Option<DepthStencilState>,
    ) -> Self {
        let vertex_buffer_size = next_copy_buffer_size(4096);
        let vertex_buffer = device.create_buffer(&BufferDescriptor {
            label: Some("glyphon vertices"),
            size: vertex_buffer_size,
            usage: BufferUsages::VERTEX | BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let pipeline = atlas.get_or_create_pipeline(device, multisample, depth_stencil);

        Self {
            staging_belt: StagingBelt::new(device.clone(), vertex_buffer_size),
            vertex_buffer,
            vertex_buffer_size,
            pipeline,
            glyph_vertices: Vec::new(),
            glyphs_to_render: 0,
            incomplete: false,
        }
    }

    /// Whether the last `prepare` left glyphs out because a worker was still drawing them: the text is complete once
    /// the worker has drawn them and the text is prepared again (`begin_candidate` and `end_candidate` say it for a
    /// whole frame).
    pub fn incomplete(&self) -> bool {
        self.incomplete
    }

    /// Prepares all of the provided text areas for rendering.
    pub fn prepare_with_depth<'a>(
        &mut self,
        device: &Device,
        queue: &Queue,
        encoder: &mut CommandEncoder,
        font_system: &mut FontSystem,
        atlas: &mut TextAtlas,
        viewport: &Viewport,
        text_areas: impl IntoIterator<Item = TextArea<'a>>,
        cache: &mut SwashCache,
        mut metadata_to_depth: impl FnMut(usize) -> f32,
    ) -> Result<(), PrepareError> {
        self.staging_belt.recall();
        self.glyph_vertices.clear();
        self.incomplete = false;
        let drawing = viewport.glyph_drawing();
        let aliased = viewport.aliased();

        let resolution = viewport.resolution();

        for text_area in text_areas {
            let subpixel = text_area.subpixel && atlas.subpixel;
            let bounds_min_x = text_area.bounds.left.max(0);
            let bounds_min_y = text_area.bounds.top.max(0);
            let bounds_max_x = text_area.bounds.right.min(resolution.width as i32);
            let bounds_max_y = text_area.bounds.bottom.min(resolution.height as i32);

            let is_run_visible = |run: &cosmic_text::LayoutRun| {
                let start_y_physical = (text_area.top + (run.line_top * text_area.scale)) as i32;
                let end_y_physical = start_y_physical + (run.line_height * text_area.scale) as i32;

                start_y_physical <= text_area.bounds.bottom
                    && text_area.bounds.top <= end_y_physical
            };

            let layout_runs = text_area
                .text
                .skip_while(|run| !is_run_visible(run))
                .take_while(is_run_visible);

            for run in layout_runs {
                for glyph in run.glyphs.iter() {
                    let mut physical_glyph =
                        glyph.physical((text_area.left, text_area.top), text_area.scale);

                    if aliased {
                        physical_glyph.cache_key.flags |= CacheKeyFlags::ALIASED;
                    } else if subpixel {
                        physical_glyph.cache_key.flags |= CacheKeyFlags::LCD;
                    }
                    let cache_key = physical_glyph.cache_key;

                    let mask_generation = atlas.mask_atlas.generation;
                    let color_generation = atlas.color_atlas.generation;

                    let details = if let Some(details) =
                        atlas.mask_atlas.glyph_cache.get_mut(&cache_key)
                    {
                        details.last_used = mask_generation;
                        details
                    } else if let Some(details) = atlas.color_atlas.glyph_cache.get_mut(&cache_key)
                    {
                        details.last_used = color_generation;
                        details
                    } else {
                        let image = if drawing == crate::GlyphDrawing::Inline {
                            cache.get_image_uncached(font_system, cache_key)
                        } else {
                            match crate::raster::lookup(&cache_key, || font_system.get_font_instance(cache_key.font_id, cache_key.font_weight, cache_key.font_optical_size), drawing == crate::GlyphDrawing::DirectWrite) {
                                crate::raster::Lookup::Ready(image) => Some(image),
                                crate::raster::Lookup::Missing => {
                                    self.incomplete = true;
                                    None
                                }
                                crate::raster::Lookup::Absent => None,
                            }
                        };
                        let Some(image) = image else {
                            continue;
                        };

                        let content_type = match image.content {
                            SwashContent::Color => ContentType::Color,
                            SwashContent::Mask => ContentType::Mask,
                            SwashContent::SubpixelMask => ContentType::Lcd,
                        };

                        let (texels, atlas_width) = atlas_texels(&image);
                        let width = image.placement.width as usize;
                        let height = image.placement.height as usize;

                        let should_rasterize = width > 0 && height > 0;

                        let (gpu_cache, atlas_id, inner) = if should_rasterize {
                            let mut inner = atlas.inner_for_content_mut(content_type);

                            // Find a position in the packer
                            let allocation = loop {
                                match inner.try_allocate(atlas_width, height) {
                                    Some(a) => break a,
                                    None => {
                                        if !atlas.grow(device, queue, content_type) {
                                            return Err(PrepareError::AtlasFull);
                                        }

                                        inner = atlas.inner_for_content_mut(content_type);
                                    }
                                }
                            };
                            let atlas_min = allocation.rectangle.min;

                            queue.write_texture(
                                TexelCopyTextureInfo {
                                    texture: &inner.texture,
                                    mip_level: 0,
                                    origin: Origin3d {
                                        x: atlas_min.x as u32,
                                        y: atlas_min.y as u32,
                                        z: 0,
                                    },
                                    aspect: TextureAspect::All,
                                },
                                &texels,
                                TexelCopyBufferLayout {
                                    offset: 0,
                                    bytes_per_row: Some(atlas_width as u32 * inner.num_channels() as u32),
                                    rows_per_image: None,
                                },
                                Extent3d {
                                    width: atlas_width as u32,
                                    height: height as u32,
                                    depth_or_array_layers: 1,
                                },
                            );

                            (
                                GpuCacheStatus::InAtlas {
                                    x: atlas_min.x as u16,
                                    y: atlas_min.y as u16,
                                    content_type,
                                },
                                Some(allocation.id),
                                inner,
                            )
                        } else {
                            let inner = &mut atlas.color_atlas;
                            (GpuCacheStatus::SkipRasterization, None, inner)
                        };

                        // Insert the glyph into the cache and return the details reference
                        inner.glyph_cache.get_or_insert(cache_key, || GlyphDetails {
                            width: image.placement.width as u16,
                            height: image.placement.height as u16,
                            gpu_cache,
                            atlas_id,
                            top: image.placement.top as i16,
                            left: image.placement.left as i16,
                            last_used: inner.generation,
                        })
                    };

                    let mut x = physical_glyph.x + details.left as i32;
                    let mut y = baseline(&run, text_area.scale) + physical_glyph.y - details.top as i32;

                    let (mut atlas_x, mut atlas_y, content_type) = match details.gpu_cache {
                        GpuCacheStatus::InAtlas { x, y, content_type } => (x, y, content_type),
                        GpuCacheStatus::SkipRasterization => continue,
                    };

                    let mut width = details.width as i32;
                    let mut height = details.height as i32;

                    // Starts beyond right edge or ends beyond left edge
                    let max_x = x + width;
                    if x > bounds_max_x || max_x < bounds_min_x {
                        continue;
                    }

                    // Starts beyond bottom edge or ends beyond top edge
                    let max_y = y + height;
                    if y > bounds_max_y || max_y < bounds_min_y {
                        continue;
                    }

                    // Clip left ege
                    if x < bounds_min_x {
                        let right_shift = bounds_min_x - x;

                        x = bounds_min_x;
                        width = max_x - bounds_min_x;
                        atlas_x += (right_shift * if content_type == ContentType::Lcd { 3 } else { 1 }) as u16;
                    }

                    // Clip right edge
                    if x + width > bounds_max_x {
                        width = bounds_max_x - x;
                    }

                    // Clip top edge
                    if y < bounds_min_y {
                        let bottom_shift = bounds_min_y - y;

                        y = bounds_min_y;
                        height = max_y - bounds_min_y;
                        atlas_y += bottom_shift as u16;
                    }

                    // Clip bottom edge
                    if y + height > bounds_max_y {
                        height = bounds_max_y - y;
                    }

                    let color = match glyph.color_opt {
                        Some(some) => some,
                        None => text_area.default_color,
                    };

                    let depth = metadata_to_depth(glyph.metadata);

                    self.glyph_vertices.push(GlyphToRender {
                        pos: [x, y],
                        dim: [width as u16, height as u16],
                        uv: [atlas_x, atlas_y],
                        color: color.0,
                        content_type_with_srgb: [
                            content_type as u16,
                            match atlas.color_mode {
                                ColorMode::Accurate => TextColorConversion::ConvertToLinear,
                                ColorMode::Web => TextColorConversion::None,
                            } as u16,
                        ],
                        depth,
                    });
                }
            }
        }

        self.glyphs_to_render = self.glyph_vertices.len() as u32;

        let will_render = !self.glyph_vertices.is_empty();
        if !will_render {
            return Ok(());
        }

        let vertices = self.glyph_vertices.as_slice();
        let vertices_raw = unsafe {
            slice::from_raw_parts(
                vertices as *const _ as *const u8,
                std::mem::size_of_val(vertices),
            )
        };

        if self.vertex_buffer_size >= vertices_raw.len() as u64 {
            self.staging_belt
                .write_buffer(
                    encoder,
                    &self.vertex_buffer,
                    0,
                    NonZeroU64::new(vertices_raw.len() as u64).expect("Non-empty vertices"),
                )
                .copy_from_slice(vertices_raw);
        } else {
            self.vertex_buffer.destroy();

            let (buffer, buffer_size) = create_oversized_buffer(
                device,
                Some("glyphon vertices"),
                vertices_raw,
                BufferUsages::VERTEX | BufferUsages::COPY_DST,
            );

            self.vertex_buffer = buffer;
            self.vertex_buffer_size = buffer_size;

            self.staging_belt.finish();
            self.staging_belt = StagingBelt::new(device.clone(), buffer_size);
        }

        self.staging_belt.finish();

        Ok(())
    }

    pub fn prepare<'a>(
        &mut self,
        device: &Device,
        queue: &Queue,
        encoder: &mut CommandEncoder,
        font_system: &mut FontSystem,
        atlas: &mut TextAtlas,
        viewport: &Viewport,
        text_areas: impl IntoIterator<Item = TextArea<'a>>,
        cache: &mut SwashCache,
    ) -> Result<(), PrepareError> {
        self.prepare_with_depth(
            device,
            queue,
            encoder,
            font_system,
            atlas,
            viewport,
            text_areas,
            cache,
            zero_depth,
        )
    }

    /// Renders all layouts that were previously provided to `prepare`.
    pub fn render(
        &self,
        atlas: &TextAtlas,
        viewport: &Viewport,
        pass: &mut RenderPass<'_>,
    ) -> Result<(), RenderError> {
        if self.glyphs_to_render == 0 {
            return Ok(());
        }

        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &atlas.bind_group, &[]);
        pass.set_bind_group(1, &viewport.bind_group, &[]);
        pass.set_vertex_buffer(0, self.vertex_buffer.slice(..));
        pass.draw(0..4, 0..self.glyphs_to_render);

        Ok(())
    }
}

#[repr(u16)]
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum ContentType {
    Color = 0,
    Mask = 1,
    /// Subpixel coverage: three texels of the mask atlas per pixel, red, green and blue.
    Lcd = 2,
}

/// The texels a glyph occupies in its atlas and their width: the image as it is, or for subpixel coverage the red, green
/// and blue coverage of each pixel as three consecutive single-channel texels (three times as wide).
///
/// swash's subpixel mask holds, for each subpixel in turn, the coverage of a box one pixel wide centred on it: the same
/// filter a ClearType glyph has. A wider one (a second pass of the box: a triangle five subpixels across) was tried
/// against Chromium's text and drew fringes only half as strong; this one matches.
pub(crate) fn atlas_texels(image: &SwashImage) -> (Cow<'_, [u8]>, usize) {
    let width = image.placement.width as usize;
    match image.content {
        SwashContent::SubpixelMask => {
            let texels = image.data.chunks_exact(4).flat_map(|pixel| [pixel[0], pixel[1], pixel[2]]).collect();
            (Cow::Owned(texels), width * 3)
        }
        _ => (Cow::Borrowed(&image.data), width),
    }
}

/// The baseline of a line in physical pixels, placed as Chromium places it so that text sits on the same pixel rows as
/// in the browser: the font's ascent and descent are rounded to whole logical (CSS) pixels, the leading of the line
/// height is split with the half above the baseline floored, and the sum is scaled to the pixel grid and rounded.
/// Measured against Chromium at 100 % and 150 % (`cargo xtask fonts`): rounding at the drawn size instead puts the
/// text one pixel higher at 150 %.
fn baseline(run: &cosmic_text::LayoutRun<'_>, scale: f32) -> i32 {
    let ascent = run.line_ascent.round();
    let descent = run.line_descent.round();
    let leading = ((run.line_height - (ascent + descent)) / 2.0).floor();
    ((run.line_top + ascent + leading) * scale).round() as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A one-line run: Inter at `size` has ascent 0.96875 em and descent 0.2412 em.
    fn run(size: f32, line_height: f32, line_top: f32) -> cosmic_text::LayoutRun<'static> {
        cosmic_text::LayoutRun {
            line_i: 0,
            text: "",
            rtl: false,
            glyphs: &[],
            decorations: &[],
            line_y: 0.0,
            line_ascent: size * 0.96875,
            line_descent: size * 0.2412,
            line_top,
            line_height,
            line_w: 0.0,
        }
    }

    #[test]
    fn subpixel_coverage_is_uploaded_as_three_texels_per_pixel() {
        use cosmic_text::SwashImage;
        let mut image = SwashImage::default();
        image.content = SwashContent::SubpixelMask;
        image.placement.width = 2;
        image.placement.height = 1;
        image.data = vec![1, 2, 3, 255, 4, 5, 6, 255];
        let (texels, width) = atlas_texels(&image);
        assert_eq!((&texels[..], width), (&[1u8, 2, 3, 4, 5, 6][..], 6), "red, green and blue of each pixel, the alpha dropped");
    }

    #[test]
    fn a_grayscale_glyph_is_uploaded_as_it_is() {
        use cosmic_text::SwashImage;
        let mut image = SwashImage::default();
        image.content = SwashContent::Mask;
        image.placement.width = 2;
        image.placement.height = 1;
        image.data = vec![10, 200];
        let (texels, width) = atlas_texels(&image);
        assert_eq!((&texels[..], width), (&[10u8, 200][..], 2));
    }

    #[test]
    fn the_baseline_sits_where_chromium_puts_it() {
        // Measured in Chromium (`cargo xtask fonts`): 13 px on an 18 px line has its baseline 14 px down, 18 px on a
        // 24 px line 18 px down (the half leading is floored), 11 px on a 15 px line 11 px down.
        assert_eq!(baseline(&run(13.0, 18.0, 0.0), 1.0), 14);
        assert_eq!(baseline(&run(18.0, 24.0, 0.0), 1.0), 18);
        assert_eq!(baseline(&run(11.0, 15.0, 0.0), 1.0), 11);
        assert_eq!(baseline(&run(13.0, 18.0, 36.0), 1.0), 50, "the second line of a paragraph");
    }

    #[test]
    fn the_baseline_at_150_percent_is_the_scaled_logical_baseline() {
        // Chromium rounds the font's metrics in logical pixels, then scales: 14 * 1.5 = 21. Rounding at the drawn
        // size (the first version of this code) gave 20, one pixel above Chromium on 70 of the 98 rows measured.
        assert_eq!(baseline(&run(13.0, 18.0, 0.0), 1.5), 21);
        assert_eq!(baseline(&run(18.0, 24.0, 0.0), 1.5), 27);
    }
}

#[repr(u16)]
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
enum TextColorConversion {
    None = 0,
    ConvertToLinear = 1,
}

fn next_copy_buffer_size(size: u64) -> u64 {
    let align_mask = COPY_BUFFER_ALIGNMENT - 1;
    ((size.next_power_of_two() + align_mask) & !align_mask).max(COPY_BUFFER_ALIGNMENT)
}

fn create_oversized_buffer(
    device: &Device,
    label: Option<&str>,
    contents: &[u8],
    usage: BufferUsages,
) -> (Buffer, u64) {
    let size = next_copy_buffer_size(contents.len() as u64);
    let buffer = device.create_buffer(&BufferDescriptor {
        label,
        size,
        usage,
        mapped_at_creation: true,
    });
    buffer
        .slice(..)
        .get_mapped_range_mut()
        .unwrap()
        .slice(..contents.len())
        .copy_from_slice(contents);
    buffer.unmap();
    (buffer, size)
}

fn zero_depth(_: usize) -> f32 {
    0f32
}
