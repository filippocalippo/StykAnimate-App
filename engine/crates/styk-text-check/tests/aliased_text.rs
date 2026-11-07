//! With the system's font smoothing off, text is drawn without antialiasing: every pixel is covered or not.
//!
//! The setting is the program's (`graphics::text::set_rendering`); the test never touches the system's own.

mod support;

use iced::advanced::graphics::text::{self as graphics_text, GlyphDrawing, Rendering};
use iced::Size;
use support::{ink, lines, Window};

/// How many pixels of the picture are neither the white background nor the black ink.
fn blended(picture: &[u8]) -> usize {
    picture.chunks_exact(4).filter(|pixel| pixel[..3].iter().any(|channel| *channel != 0 && *channel != 255)).count()
}

#[test]
fn text_is_aliased_when_smoothing_is_off_and_antialiased_otherwise() {
    let Some(mut window) = Window::open(Size::new(300.0, 80.0)) else {
        eprintln!("skipped: no graphics adapter");
        return;
    };
    let drawn = |window: &mut Window, rendering: Rendering| {
        graphics_text::set_rendering(rendering);
        let mut interface = window.interface(&lines(&["Aliased text 0123", "and a second line"]), 15.0);
        window.until_complete(&mut interface).swap_remove(0)
    };
    let smooth = drawn(&mut window, Rendering { subpixel: None, adjustment: None, glyphs: GlyphDrawing::DirectWrite, aliased: false });
    assert!(ink(&smooth) > 300 && blended(&smooth) > 100, "antialiased text has partly covered pixels ({} of {})", blended(&smooth), ink(&smooth));
    let aliased = drawn(&mut window, Rendering { subpixel: None, adjustment: None, glyphs: GlyphDrawing::DirectWrite, aliased: true });
    assert!(ink(&aliased) > 200, "the text is there ({} pixels)", ink(&aliased));
    assert_eq!(blended(&aliased), 0, "aliased text has only covered and uncovered pixels");
    // The worker's swash path honours it as well.
    let swash = drawn(&mut window, Rendering { subpixel: None, adjustment: None, glyphs: GlyphDrawing::Worker, aliased: true });
    assert!(ink(&swash) > 200 && blended(&swash) == 0, "swash: {} ink, {} blended", ink(&swash), blended(&swash));
}
