// SPDX-License-Identifier: MIT OR Apache-2.0

#[cfg(not(feature = "std"))]
use alloc::boxed::Box;
#[cfg(feature = "no_std")]
use core_maths::CoreFloat;

#[cfg(not(feature = "std"))]
use alloc::vec::Vec;
use core::fmt;
use swash::scale::{image::Content, ScaleContext};
use swash::scale::{Render, Source, StrikeWith};
use swash::zeno::{Format, Vector};

use crate::{CacheKey, CacheKeyFlags, Color, FontSystem, HashMap};

pub use swash::scale::image::{Content as SwashContent, Image as SwashImage};
pub use swash::zeno::{Angle, Command, Placement, Transform};

/// A scaler for the glyph's face at the glyph's size, with the `wght` and `opsz` coordinates the glyph was shaped at.
fn scaler_for<'a>(
    context: &'a mut ScaleContext,
    font: &'a crate::Font,
    cache_key: &CacheKey,
) -> swash::scale::Scaler<'a> {
    let variations = font.as_swash().variations();
    let mut builder = context
        .builder(font.as_swash())
        .size(f32::from_bits(cache_key.font_size_bits))
        .hint(!cache_key.flags.contains(CacheKeyFlags::DISABLE_HINTING));
    let wght = variations.find_by_tag(swash::Tag::from_be_bytes(*b"wght"));
    let opsz = variations
        .find_by_tag(swash::Tag::from_be_bytes(*b"opsz"))
        .zip(cache_key.font_optical_size.pixels());
    if wght.is_some() || opsz.is_some() {
        let mut coordinates = Vec::with_capacity(2);
        if let Some(axis) = wght {
            coordinates.push((
                swash::Tag::from_be_bytes(*b"wght"),
                f32::from(cache_key.font_weight.0).clamp(axis.min_value(), axis.max_value()),
            ));
        }
        if let Some((axis, pixels)) = opsz {
            coordinates.push((
                swash::Tag::from_be_bytes(*b"opsz"),
                pixels.clamp(axis.min_value(), axis.max_value()),
            ));
        }
        builder = builder.normalized_coords(variations.normalized_coords(coordinates));
    }
    builder.build()
}

fn swash_image(
    font_system: &mut FontSystem,
    context: &mut ScaleContext,
    cache_key: CacheKey,
) -> Option<SwashImage> {
    let Some(font) = font_system.get_font_instance(
        cache_key.font_id,
        cache_key.font_weight,
        cache_key.font_optical_size,
    ) else {
        log::warn!("did not find font {:?}", cache_key.font_id);
        return None;
    };

    let mut scaler = scaler_for(context, &font, &cache_key);

    // Compute the fractional offset-- you'll likely want to quantize this
    // in a real renderer
    let offset = if cache_key.flags.contains(CacheKeyFlags::PIXEL_FONT) {
        Vector::new(
            cache_key.x_bin.as_float().round(),
            cache_key.y_bin.as_float().round(),
        )
    } else {
        Vector::new(cache_key.x_bin.as_float(), cache_key.y_bin.as_float())
    };

    // Select our source order
    Render::new(&[
        // Color outline with the first palette
        Source::ColorOutline(0),
        // Color bitmap with best fit selection mode
        Source::ColorBitmap(StrikeWith::BestFit),
        // Standard scalable outline
        Source::Outline,
    ])
    // Select a subpixel format
    .format(Format::Alpha)
    // Apply the fractional offset
    .offset(offset)
    .transform(if cache_key.flags.contains(CacheKeyFlags::FAKE_ITALIC) {
        Some(Transform::skew(
            Angle::from_degrees(14.0),
            Angle::from_degrees(0.0),
        ))
    } else {
        None
    })
    // Render the image
    .render(&mut scaler, cache_key.glyph_id)
}

fn swash_outline_commands(
    font_system: &mut FontSystem,
    context: &mut ScaleContext,
    cache_key: CacheKey,
) -> Option<Box<[swash::zeno::Command]>> {
    use swash::zeno::PathData as _;

    let Some(font) = font_system.get_font_instance(
        cache_key.font_id,
        cache_key.font_weight,
        cache_key.font_optical_size,
    ) else {
        log::warn!("did not find font {:?}", cache_key.font_id);
        return None;
    };

    let mut scaler = scaler_for(context, &font, &cache_key);

    // Scale the outline
    let mut outline = scaler
        .scale_outline(cache_key.glyph_id)
        .or_else(|| scaler.scale_color_outline(cache_key.glyph_id))?;

    if cache_key.flags.contains(CacheKeyFlags::FAKE_ITALIC) {
        outline.transform(&Transform::skew(
            Angle::from_degrees(14.0),
            Angle::from_degrees(0.0),
        ));
    }

    // Get the path information of the outline
    let path = outline.path();

    // Return the commands
    Some(path.commands().collect())
}

/// Cache for rasterizing with the swash scaler
pub struct SwashCache {
    context: ScaleContext,
    pub image_cache: HashMap<CacheKey, Option<SwashImage>>,
    pub outline_command_cache: HashMap<CacheKey, Option<Box<[swash::zeno::Command]>>>,
}

impl fmt::Debug for SwashCache {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.pad("SwashCache { .. }")
    }
}

impl SwashCache {
    /// Create a new swash cache
    pub fn new() -> Self {
        Self {
            context: ScaleContext::new(),
            image_cache: HashMap::default(),
            outline_command_cache: HashMap::default(),
        }
    }

    /// Create a swash Image from a cache key, without caching results
    pub fn get_image_uncached(
        &mut self,
        font_system: &mut FontSystem,
        cache_key: CacheKey,
    ) -> Option<SwashImage> {
        swash_image(font_system, &mut self.context, cache_key)
    }

    /// Create a swash Image from a cache key, caching results
    pub fn get_image(
        &mut self,
        font_system: &mut FontSystem,
        cache_key: CacheKey,
    ) -> &Option<SwashImage> {
        self.image_cache
            .entry(cache_key)
            .or_insert_with(|| swash_image(font_system, &mut self.context, cache_key))
    }

    /// Creates outline commands
    pub fn get_outline_commands(
        &mut self,
        font_system: &mut FontSystem,
        cache_key: CacheKey,
    ) -> Option<&[swash::zeno::Command]> {
        self.outline_command_cache
            .entry(cache_key)
            .or_insert_with(|| swash_outline_commands(font_system, &mut self.context, cache_key))
            .as_deref()
    }

    /// Creates outline commands, without caching results
    pub fn get_outline_commands_uncached(
        &mut self,
        font_system: &mut FontSystem,
        cache_key: CacheKey,
    ) -> Option<Box<[swash::zeno::Command]>> {
        swash_outline_commands(font_system, &mut self.context, cache_key)
    }

    /// Enumerate pixels in an Image, use `with_image` for better performance
    pub fn with_pixels<F: FnMut(i32, i32, Color)>(
        &mut self,
        font_system: &mut FontSystem,
        cache_key: CacheKey,
        base: Color,
        mut f: F,
    ) {
        if let Some(image) = self.get_image(font_system, cache_key) {
            let x = image.placement.left;
            let y = -image.placement.top;

            match image.content {
                Content::Mask => {
                    let mut i = 0;
                    for off_y in 0..image.placement.height as i32 {
                        for off_x in 0..image.placement.width as i32 {
                            //TODO: blend base alpha?
                            f(
                                x + off_x,
                                y + off_y,
                                Color((u32::from(image.data[i]) << 24) | base.0 & 0xFF_FF_FF),
                            );
                            i += 1;
                        }
                    }
                }
                Content::Color => {
                    let mut i = 0;
                    for off_y in 0..image.placement.height as i32 {
                        for off_x in 0..image.placement.width as i32 {
                            //TODO: blend base alpha?
                            f(
                                x + off_x,
                                y + off_y,
                                Color::rgba(
                                    image.data[i],
                                    image.data[i + 1],
                                    image.data[i + 2],
                                    image.data[i + 3],
                                ),
                            );
                            i += 4;
                        }
                    }
                }
                Content::SubpixelMask => {
                    log::warn!("TODO: SubpixelMask");
                }
            }
        }
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use swash::{FontRef, Setting, Tag};

    // variations() resizes context.coords in place (stale values persist),
    // whereas using normalized_coords() clears and replaces them.
    #[test]
    fn no_coord_leakage_across_fonts() {
        let [Ok(sfns), Ok(sfns_italic)] = [
            "/System/Library/Fonts/SFNS.ttf",
            "/System/Library/Fonts/SFNSItalic.ttf",
        ]
        .map(std::fs::read) else {
            return;
        };
        let regular = FontRef::from_index(&sfns, 0).unwrap();
        let italic = FontRef::from_index(&sfns_italic, 0).unwrap();
        let wght = Tag::from_be_bytes(*b"wght");

        let render = |ctx: &mut ScaleContext, font: FontRef, weight: f32, use_normalized| {
            let mut b = ctx.builder(font).size(16.0).hint(true);
            if use_normalized {
                b = b.normalized_coords(font.variations().normalized_coords([(wght, weight)]));
            } else {
                b = b.variations(std::iter::once(Setting {
                    tag: wght,
                    value: weight,
                }));
            }
            Render::new(&[Source::Outline])
                .format(Format::Alpha)
                .render(&mut b.build(), 36)
        };

        // reference: regular@400 with no prior context
        let mut ctx = ScaleContext::new();
        let reference = render(&mut ctx, regular, 400.0, false).map(|i| i.data);

        // variations(): pollute ctx with italic@700, then render regular@400
        let mut ctx = ScaleContext::new();
        render(&mut ctx, italic, 700.0, false);
        let not_normalized = render(&mut ctx, regular, 400.0, false).map(|i| i.data);

        // normalized_coords(): same sequence
        let mut ctx = ScaleContext::new();
        render(&mut ctx, italic, 700.0, true);
        let normalized = render(&mut ctx, regular, 400.0, true).map(|i| i.data);

        assert_ne!(not_normalized, reference, "variations leak across fonts");
        assert_eq!(
            normalized, reference,
            "normalized_coords match clean render"
        );
    }
}
