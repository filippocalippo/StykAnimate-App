//! The DirectWrite glyph masks against DirectWrite drawn directly (Windows).
//!
//! The masks the text stack uses come from `IDWriteGlyphRunAnalysis` through cosmic-text's in-memory font loading. Here a
//! glyph of an installed font is drawn another way, by DirectWrite's own GDI bitmap render target from the system font
//! collection, with rendering parameters that add no gamma or contrast, and the two must agree pixel for pixel.

use iced::advanced::graphics::text::cosmic_text::dwrite::{DirectWrite, Rasterized, Smoothing};
use iced::advanced::graphics::text::cosmic_text::fontdb::{Style, Weight as FontWeight};
use iced::advanced::graphics::text::cosmic_text::{OpticalSize, Weight};
use iced::advanced::graphics::text::font_system;
use windows::Win32::Foundation::COLORREF;
use windows::Win32::Graphics::DirectWrite::{
    DWriteCreateFactory, IDWriteFactory, DWRITE_FACTORY_TYPE_SHARED, DWRITE_FONT_STRETCH_NORMAL, DWRITE_FONT_STYLE_NORMAL,
    DWRITE_FONT_WEIGHT_REGULAR, DWRITE_GLYPH_OFFSET, DWRITE_GLYPH_RUN, DWRITE_MEASURING_MODE_NATURAL,
    DWRITE_PIXEL_GEOMETRY_RGB, DWRITE_RENDERING_MODE_NATURAL,
};
use windows::Win32::Graphics::Gdi::{GetCurrentObject, GetObjectW, PatBlt, BITMAP, OBJ_BITMAP, WHITENESS};
use windows::core::BOOL;

const SIZE: f32 = 13.0;
const ORIGIN: (i32, i32) = (20, 30);

/// The coverage of `character` of "Segoe UI" drawn by the GDI bitmap render target: rows of (red, green, blue) coverage in
/// a 64 x 48 picture, black text on white with no gamma or contrast.
fn drawn_directly(character: char) -> Option<Vec<[u8; 3]>> {
    // SAFETY: plain DirectWrite and GDI calls on objects this function creates; the bitmap's bits are read while it lives.
    unsafe {
        let factory: IDWriteFactory = DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED).ok()?;
        let mut collection = None;
        factory.GetSystemFontCollection(&mut collection, false).ok()?;
        let collection = collection?;
        let (mut index, mut exists) = (0u32, BOOL(0));
        collection.FindFamilyName(windows::core::w!("Segoe UI"), &mut index, &mut exists).ok()?;
        if !exists.as_bool() {
            return None;
        }
        let font = collection.GetFontFamily(index).ok()?.GetFirstMatchingFont(DWRITE_FONT_WEIGHT_REGULAR, DWRITE_FONT_STRETCH_NORMAL, DWRITE_FONT_STYLE_NORMAL).ok()?;
        let face = font.CreateFontFace().ok()?;
        let codepoint = character as u32;
        let mut glyph = 0u16;
        face.GetGlyphIndices(&codepoint, 1, &mut glyph).ok()?;

        let target = factory.GetGdiInterop().ok()?.CreateBitmapRenderTarget(None, 64, 48).ok()?;
        let hdc = target.GetMemoryDC();
        let _ = PatBlt(hdc, 0, 0, 64, 48, WHITENESS);
        let parameters = factory.CreateCustomRenderingParams(1.0, 0.0, 1.0, DWRITE_PIXEL_GEOMETRY_RGB, DWRITE_RENDERING_MODE_NATURAL).ok()?;
        let (advance, offset) = (0.0f32, DWRITE_GLYPH_OFFSET::default());
        let run = DWRITE_GLYPH_RUN {
            fontFace: std::mem::ManuallyDrop::new(Some(face.clone())),
            fontEmSize: SIZE,
            glyphCount: 1,
            glyphIndices: &glyph,
            glyphAdvances: &advance,
            glyphOffsets: &offset,
            isSideways: BOOL(0),
            bidiLevel: 0,
        };
        let drawn = target.DrawGlyphRun(ORIGIN.0 as f32, ORIGIN.1 as f32, DWRITE_MEASURING_MODE_NATURAL, &run, &parameters, COLORREF(0), None);
        drop(std::mem::ManuallyDrop::into_inner(run.fontFace));
        drawn.ok()?;

        let mut bitmap = BITMAP::default();
        let object = GetCurrentObject(hdc, OBJ_BITMAP);
        if GetObjectW(object, std::mem::size_of::<BITMAP>() as i32, Some((&mut bitmap as *mut BITMAP).cast())) == 0 || bitmap.bmBitsPixel != 32 {
            return None;
        }
        let rows = std::slice::from_raw_parts(bitmap.bmBits.cast::<u8>(), bitmap.bmWidthBytes as usize * bitmap.bmHeight as usize);
        let mut coverage = Vec::with_capacity(64 * 48);
        for y in 0..bitmap.bmHeight as usize {
            for x in 0..bitmap.bmWidth as usize {
                let pixel = &rows[y * bitmap.bmWidthBytes as usize + x * 4..][..4];
                // The bitmap is blue, green, red, unused.
                coverage.push([255 - pixel[2], 255 - pixel[1], 255 - pixel[0]]);
            }
        }
        Some(coverage)
    }
}

/// The glyph of "Segoe UI" in the text stack's font system, and our mask of it at `SIZE`.
fn drawn_by_the_text_stack(character: char) -> Option<(i32, i32, u32, u32, Vec<u8>)> {
    crate::warm_up::install_bundled();
    let mut system = font_system().write().ok()?;
    let id = system.raw().db().faces().find(|face| face.families.iter().any(|(name, _)| name == "Segoe UI") && face.weight == FontWeight::NORMAL && face.style == Style::Normal)?.id;
    let font = system.raw().get_font_instance(id, Weight::NORMAL, OpticalSize::DEFAULT)?;
    let glyph = font.as_swash().charmap().map(character);
    let mut direct_write = DirectWrite::new()?;
    match direct_write.rasterize(&font, glyph, SIZE, 400, OpticalSize::DEFAULT, 0.0, Smoothing::ClearType) {
        Rasterized::Mask(mask) if mask.lcd => Some((mask.left, mask.top, mask.width, mask.height, mask.data)),
        _ => None,
    }
}

#[test]
fn a_mask_is_what_directwrite_draws_directly() {
    for character in ['P', 'e', 'g', 'W'] {
        // Windows ships Segoe UI and DirectWrite 5: a failure to draw is a failure of the test, not a reason to skip it.
        let direct = drawn_directly(character).unwrap_or_else(|| panic!("{character}: DirectWrite's own drawing of Segoe UI failed"));
        let (left, top, width, height, data) = drawn_by_the_text_stack(character).unwrap_or_else(|| panic!("{character}: the text stack's DirectWrite mask of Segoe UI failed"));
        let (mut compared, mut worst) = (0, 0u8);
        for y in 0..height as i32 {
            for x in 0..width as i32 {
                // Mask row 0 is `top` pixels above the baseline; column 0 is `left` pixels right of the origin.
                let (px, py) = (ORIGIN.0 + left + x, ORIGIN.1 - top + y);
                let ours = &data[(y as usize * width as usize + x as usize) * 3..][..3];
                let theirs = direct[py as usize * 64 + px as usize];
                for channel in 0..3 {
                    worst = worst.max(ours[channel].abs_diff(theirs[channel]));
                }
                compared += 1;
            }
        }
        assert!(compared > 20, "{character}: the glyph has ink");
        assert!(worst <= 3, "{character}: the mask differs from DirectWrite's own drawing by {worst} of 255");
        // And nothing outside the mask: the render target has no ink where our bounds say there is none.
        let outside: u32 = direct.iter().enumerate().filter(|(index, _)| {
            let (x, y) = ((index % 64) as i32 - ORIGIN.0 - left, (index / 64) as i32 - ORIGIN.1 + top);
            x < 0 || y < 0 || x >= width as i32 || y >= height as i32
        }).map(|(_, pixel)| u32::from(pixel.iter().max().copied().unwrap_or(0))).sum();
        assert!(outside <= 40, "{character}: DirectWrite drew ink outside the mask's bounds ({outside})");
    }
}

#[test]
fn the_instances_of_a_variable_font_share_one_file_and_the_unused_are_evicted() {
    use iced::advanced::graphics::text::cosmic_text::dwrite::MAX_FACES;
    crate::warm_up::install_bundled();
    let mut system = font_system().write().unwrap();
    let id = system.raw().db().faces().find(|face| face.families.iter().any(|(name, _)| name == "Inter") && matches!(face.source, iced::advanced::graphics::text::cosmic_text::fontdb::Source::Binary(_))).expect("the bundled Inter").id;
    let mut direct_write = DirectWrite::new().expect("DirectWrite 5");
    let (mut drawn, mut most_faces) = (0, 0);
    // Eighty-one weights of one variable file: more instances than are kept.
    for weight in (100..=900).step_by(10) {
        let font = system.raw().get_font_instance(id, Weight(weight), OpticalSize::DEFAULT).expect("an instance of Inter");
        let glyph = font.as_swash().charmap().map('A');
        if matches!(direct_write.rasterize(&font, glyph, 13.0, weight, OpticalSize::DEFAULT, 0.0, Smoothing::ClearType), Rasterized::Mask(_)) {
            drawn += 1;
        }
        most_faces = most_faces.max(direct_write.held().0);
    }
    assert_eq!(drawn, 81, "every weight drew");
    assert!(most_faces <= MAX_FACES, "{most_faces} face instances were held at once");
    assert_eq!(direct_write.held().1, 1, "one copy of the font file served all of them");
}
