// SPDX-License-Identifier: MIT OR Apache-2.0

//! Glyph masks drawn by DirectWrite, the rasterizer Chromium uses on Windows.
//!
//! The choices are Skia's `SkScalerContext_DW`, which is how Chromium draws web text on Windows: `NATURAL` measuring,
//! the rendering mode and size by the font's `gasp` table and instructions (`scaler_choice`), the glyph shifted by its
//! subpixel offset. A glyph of
//! ClearType text is the `CLEARTYPE_3x1` alpha texture (three bytes per pixel, red green blue); a glyph of grayscale
//! text is the grayscale-antialiased `ALIASED_1x1` texture.
//!
//! Fonts reach DirectWrite from memory, whatever their origin: the bytes cosmic-text already holds are registered
//! through an in-memory font file loader, and a variable font's `wght` and `opsz` axes are set on the face the way
//! Skia sets them (`IDWriteFontResource::CreateFontFace` with axis values). A [`DirectWrite`] is used from one thread,
//! the one that made it.

use crate::{Font, OpticalSize};
use alloc::vec::Vec;
use core::mem::ManuallyDrop;
use linebender_resource_handle::Blob;
use std::collections::HashMap;
use windows::core::{Interface, BOOL};
use windows::Win32::Graphics::DirectWrite::{
    DWriteCreateFactory, IDWriteFactory, IDWriteFactory2, IDWriteFactory5, IDWriteFactory6, IDWriteFontFace, IDWriteInMemoryFontFileLoader,
    DWRITE_FACTORY_TYPE_SHARED, DWRITE_FONT_AXIS_TAG_OPTICAL_SIZE, DWRITE_FONT_AXIS_TAG_WEIGHT,
    DWRITE_FONT_AXIS_VALUE, DWRITE_FONT_SIMULATIONS_NONE, DWRITE_GLYPH_OFFSET, DWRITE_GLYPH_RUN,
    DWRITE_GRID_FIT_MODE, DWRITE_GRID_FIT_MODE_ENABLED, DWRITE_MATRIX, DWRITE_RENDERING_MODE, DWRITE_RENDERING_MODE_NATURAL, DWRITE_MEASURING_MODE_NATURAL,
    DWRITE_RENDERING_MODE_NATURAL_SYMMETRIC, DWRITE_TEXTURE_ALIASED_1x1, DWRITE_TEXTURE_CLEARTYPE_3x1,
    DWRITE_TEXT_ANTIALIAS_MODE_CLEARTYPE, DWRITE_TEXT_ANTIALIAS_MODE_GRAYSCALE,
};

/// What DirectWrite made of a glyph.
#[derive(Debug)]
pub enum Rasterized {
    /// The glyph's mask.
    Mask(Mask),
    /// The glyph has no ink (a space).
    Empty,
    /// DirectWrite cannot draw this glyph the way the caller needs: a colour glyph, or a failure. Another rasterizer
    /// must.
    Unsupported,
}

/// A glyph's coverage and where it sits.
#[derive(Debug)]
pub struct Mask {
    /// Pixels from the glyph origin to the mask's left edge.
    pub left: i32,
    /// Pixels from the baseline up to the mask's top edge.
    pub top: i32,
    /// Width in pixels.
    pub width: u32,
    /// Height in pixels.
    pub height: u32,
    /// Whether the mask is ClearType (red, green, blue coverage per pixel, `width * height * 3` bytes) or grayscale
    /// (one byte per pixel).
    pub lcd: bool,
    /// The coverage, rows top to bottom.
    pub data: Vec<u8>,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct FaceKey {
    font: fontdb::ID,
    weight: u16,
    optical_size: OpticalSize,
}

/// What Skia reads of a font to choose how DirectWrite draws it (`SkScalerContext_DW`): whether it carries TrueType
/// instructions, and its `gasp` ranges.
#[derive(Clone, Debug, Default)]
struct Hints {
    /// `maxp` version 1.0 with `maxSizeOfInstructions` above zero.
    instructions: bool,
    /// `gasp` version, and its ranges as (largest ppem, behaviour flags).
    gasp: Option<(u16, Vec<(u16, u16)>)>,
}

impl Hints {
    fn of(font: &skrifa::FontRef<'_>) -> Self {
        use skrifa::raw::TableProvider as _;
        let instructions = font.maxp().ok().and_then(|maxp| maxp.max_size_of_instructions()).is_some_and(|size| size > 0);
        let gasp = font.table_data(skrifa::Tag::new(b"gasp")).and_then(|table| {
            let bytes = table.as_bytes();
            let word = |at: usize| bytes.get(at..at + 2).map(|pair| u16::from_be_bytes([pair[0], pair[1]]));
            let (version, count) = (word(0)?, word(2)?);
            if version > 1 || count > 1024 {
                return None;
            }
            let ranges = (0..usize::from(count)).map(|i| Some((word(4 + 4 * i)?, word(6 + 4 * i)?))).collect::<Option<Vec<_>>>()?;
            Some((version, ranges))
        });
        Hints { instructions, gasp }
    }

    /// The behaviour flags of the `gasp` range that holds `ppem`, and the table's version, if the font has a `gasp`.
    fn gasp_range(&self, ppem: u16) -> Option<(u16, u16)> {
        let (version, ranges) = self.gasp.as_ref()?;
        let range = ranges.iter().find(|(largest, _)| ppem <= *largest)?;
        Some((*version, range.1))
    }
}

struct Face {
    hints: Hints,
    face: IDWriteFontFace,
    /// A face with colour tables (COLR, SVG, bitmaps): DirectWrite's alpha texture would draw it as one colour.
    color: bool,
    /// The font's bytes, which the file reference points into for as long as the face exists.
    _data: Blob<u8>,
}

/// DirectWrite, ready to draw glyph masks.
pub struct DirectWrite {
    factory: IDWriteFactory5,
    resources: IDWriteFactory6,
    analysis: IDWriteFactory2,
    loader: IDWriteInMemoryFontFileLoader,
    faces: HashMap<FaceKey, Option<Face>>,
}

impl DirectWrite {
    /// Starts DirectWrite, or `None` where it cannot (a Windows without `IDWriteFactory5`).
    pub fn new() -> Option<Self> {
        // SAFETY: plain factory creation and registration of the in-memory loader, which this value unregisters.
        unsafe {
            let factory: IDWriteFactory5 = DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED).ok()?;
            let analysis = factory.cast::<IDWriteFactory2>().ok()?;
            let resources = factory.cast::<IDWriteFactory6>().ok()?;
            let loader = factory.CreateInMemoryFontFileLoader().ok()?;
            factory.RegisterFontFileLoader(&loader).ok()?;
            Some(Self { factory, resources, analysis, loader, faces: HashMap::new() })
        }
    }

    fn face(&mut self, font: &Font, weight: u16, optical_size: OpticalSize) -> Option<&Face> {
        let key = FaceKey { font: font.id(), weight, optical_size };
        if !self.faces.contains_key(&key) {
            let face = self.make_face(font, weight, optical_size);
            self.faces.insert(key, face);
        }
        self.faces.get(&key).and_then(Option::as_ref)
    }

    fn make_face(&self, font: &Font, weight: u16, optical_size: OpticalSize) -> Option<Face> {
        let data = font.font_data().data.clone();
        let index = font.font_data().index;
        let bytes: &[u8] = font.data();
        let color = skrifa::FontRef::from_index(bytes, index).map_or(true, |font_ref| {
            use skrifa::raw::TableProvider as _;
            font_ref.colr().is_ok() || font_ref.svg().is_ok() || font_ref.sbix().is_ok() || font_ref.cbdt().is_ok()
        });
        // SAFETY: the file reference points into `data`, which the face keeps alive.
        unsafe {
            let file = self.loader.CreateInMemoryFontFileReference(&self.factory, bytes.as_ptr().cast(), bytes.len() as u32, None::<&windows::core::IUnknown>).ok()?;
            let resource = self.resources.CreateFontResource(&file, index).ok()?;
            let count = resource.GetFontAxisCount() as usize;
            let mut axes = alloc::vec![DWRITE_FONT_AXIS_VALUE::default(); count];
            if count > 0 {
                resource.GetDefaultFontAxisValues(&mut axes).ok()?;
            }
            for axis in &mut axes {
                if axis.axisTag == DWRITE_FONT_AXIS_TAG_WEIGHT {
                    axis.value = f32::from(weight);
                } else if axis.axisTag == DWRITE_FONT_AXIS_TAG_OPTICAL_SIZE {
                    if let Some(pixels) = optical_size.pixels() {
                        axis.value = pixels;
                    }
                }
            }
            let face = resource.CreateFontFace(DWRITE_FONT_SIMULATIONS_NONE, &axes).ok()?;
            let hints = skrifa::FontRef::from_index(bytes, index).map(|font_ref| Hints::of(&font_ref)).unwrap_or_default();
            Some(Face { hints, face: face.cast().ok()?, color, _data: data })
        }
    }

    /// Draws `glyph` of `font` at `size` device pixels, `x_offset` pixels (0 to 1) to the right of its origin.
    /// `lcd` asks for ClearType coverage, otherwise grayscale.
    pub fn rasterize(&mut self, font: &Font, glyph: u16, size: f32, weight: u16, optical_size: OpticalSize, x_offset: f32, lcd: bool) -> Rasterized {
        let analysis = self.analysis.clone();
        let factory: IDWriteFactory = self.factory.cast().expect("a factory 5 is a factory");
        let Some(face) = self.face(font, weight, optical_size) else {
            return Rasterized::Unsupported;
        };
        if face.color {
            return Rasterized::Unsupported;
        }
        let (mode, render_size, grid_fit) = scaler_choice(&face.hints, size);
        let advance = 0.0f32;
        let offset = DWRITE_GLYPH_OFFSET::default();
        let run = DWRITE_GLYPH_RUN {
            fontFace: ManuallyDrop::new(Some(face.face.clone())),
            fontEmSize: render_size,
            glyphCount: 1,
            glyphIndices: &glyph,
            glyphAdvances: &advance,
            glyphOffsets: &offset,
            isSideways: BOOL(0),
            bidiLevel: 0,
        };
        let matrix = DWRITE_MATRIX { m11: 1.0, m12: 0.0, m21: 0.0, m22: 1.0, dx: x_offset, dy: 0.0 };
        let (texture, antialias) = if lcd { (DWRITE_TEXTURE_CLEARTYPE_3x1, DWRITE_TEXT_ANTIALIAS_MODE_CLEARTYPE) } else { (DWRITE_TEXTURE_ALIASED_1x1, DWRITE_TEXT_ANTIALIAS_MODE_GRAYSCALE) };
        // SAFETY: `run` points at locals that outlive the calls; the font face reference it holds is released below.
        let result = unsafe {
            let result = (|| {
                // Skia: the grid fit and anti-alias mode arguments of DirectWrite 2 only where grid fitting is off or the
                // text is grayscale; otherwise the original call.
                let analysis = if !lcd {
                    analysis.CreateGlyphRunAnalysis(&run, Some(&matrix), mode, DWRITE_MEASURING_MODE_NATURAL, grid_fit, antialias, 0.0, 0.0).ok()?
                } else {
                    factory.CreateGlyphRunAnalysis(&run, 1.0, Some(&matrix), mode, DWRITE_MEASURING_MODE_NATURAL, 0.0, 0.0).ok()?
                };
                let bounds = analysis.GetAlphaTextureBounds(texture).ok()?;
                if bounds.left >= bounds.right || bounds.top >= bounds.bottom {
                    return Some(Rasterized::Empty);
                }
                let (width, height) = ((bounds.right - bounds.left) as u32, (bounds.bottom - bounds.top) as u32);
                let mut data = alloc::vec![0u8; width as usize * height as usize * if lcd { 3 } else { 1 }];
                analysis.CreateAlphaTexture(texture, &bounds, &mut data).ok()?;
                Some(Rasterized::Mask(Mask { left: bounds.left, top: -bounds.top, width, height, lcd, data }))
            })();
            drop(ManuallyDrop::into_inner(run.fontFace));
            result
        };
        result.unwrap_or(Rasterized::Unsupported)
    }
}

/// How Skia chooses DirectWrite's rendering for a font at a device size (`SkScalerContext_DW` with Chromium's hinting on
/// Windows, normal): the rendering mode, the size to render at and whether the grid is fitted (always: it only matters
/// for fonts with instructions). The font's `gasp` table, its instructions and the size decide:
///
/// - a `gasp` of version 1 gives the mode by its symmetric smoothing flag, at the device size;
/// - above 20 pixels, or without instructions, the mode is natural symmetric, at the device size;
/// - otherwise (a hinted font below 20 pixels with no such `gasp`: Segoe UI, Microsoft YaHei UI) it is natural, at the
///   size rounded to 1/64 pixel, which the instructions were tested at.
///
/// Measured against Chromium (`cargo xtask fonts`), this is what Chromium draws: with grid fitting disabled instead the
/// error of the Chinese and Arabic rows is 0.5 and 0.15; with it, 0.01 and 0.03.
fn scaler_choice(hints: &Hints, size: f32) -> (DWRITE_RENDERING_MODE, f32, DWRITE_GRID_FIT_MODE) {
    // The size the GDI-compatible modes use: rounded to 1/64 pixel.
    let gdi = ((size * 64.0).round() / 64.0).max(1.0 / 64.0);
    let ppem = gdi.round().clamp(0.0, f32::from(u16::MAX)) as u16;
    if let Some((_, flags)) = hints.gasp_range(ppem).filter(|(version, _)| *version >= 1) {
        // GASP_SYMMETRIC_SMOOTHING is 0x0008.
        let mode = if flags & 0x0008 != 0 { DWRITE_RENDERING_MODE_NATURAL_SYMMETRIC } else { DWRITE_RENDERING_MODE_NATURAL };
        return (mode, size, DWRITE_GRID_FIT_MODE_ENABLED);
    }
    if size > 20.0 || !hints.instructions {
        return (DWRITE_RENDERING_MODE_NATURAL_SYMMETRIC, size, DWRITE_GRID_FIT_MODE_ENABLED);
    }
    (DWRITE_RENDERING_MODE_NATURAL, gdi, DWRITE_GRID_FIT_MODE_ENABLED)
}

impl core::fmt::Debug for DirectWrite {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("DirectWrite").field("faces", &self.faces.len()).finish_non_exhaustive()
    }
}

impl Drop for DirectWrite {
    fn drop(&mut self) {
        self.faces.clear();
        // SAFETY: unregisters the loader registered in `new`.
        unsafe {
            let _ = self.factory.UnregisterFontFileLoader(&self.loader);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hints(instructions: bool, gasp: Option<(u16, Vec<(u16, u16)>)>) -> Hints {
        Hints { instructions, gasp }
    }

    #[test]
    fn a_hinted_font_below_twenty_pixels_is_drawn_natural_at_the_rounded_size() {
        let (mode, size, grid) = scaler_choice(&hints(true, None), 13.0);
        assert_eq!((mode, size, grid), (DWRITE_RENDERING_MODE_NATURAL, 13.0, DWRITE_GRID_FIT_MODE_ENABLED));
        // A size that is not a multiple of 1/64 renders at the nearest one.
        assert_eq!(scaler_choice(&hints(true, None), 13.0 + 1.0 / 200.0).1, 13.0);
    }

    #[test]
    fn an_unhinted_font_or_a_large_size_is_drawn_natural_symmetric_at_the_device_size() {
        assert_eq!(scaler_choice(&hints(false, None), 13.0).0, DWRITE_RENDERING_MODE_NATURAL_SYMMETRIC);
        let (mode, size, _) = scaler_choice(&hints(true, None), 21.5);
        assert_eq!((mode, size), (DWRITE_RENDERING_MODE_NATURAL_SYMMETRIC, 21.5));
    }

    #[test]
    fn a_gasp_of_version_one_chooses_by_its_symmetric_smoothing_flag() {
        let gasp = |flags| Some((1, vec![(8, 0x0003), (0xffff, flags)]));
        assert_eq!(scaler_choice(&hints(true, gasp(0x000f)), 13.0).0, DWRITE_RENDERING_MODE_NATURAL_SYMMETRIC);
        assert_eq!(scaler_choice(&hints(true, gasp(0x0007)), 13.0).0, DWRITE_RENDERING_MODE_NATURAL);
        // Version 0 says nothing about smoothing: the instructions and the size decide.
        assert_eq!(scaler_choice(&hints(true, Some((0, vec![(0xffff, 0x000f)]))), 13.0).0, DWRITE_RENDERING_MODE_NATURAL);
    }
}
