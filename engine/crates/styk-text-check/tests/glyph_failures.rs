//! A glyph worker that fails or dies never leaves a hole in a frame that is shown.
//!
//! A DirectWrite failure is drawn again by swash on the worker; a worker thread that dies is replaced, and the requests it
//! was holding are asked for again. (Its own test binary: the failures are the process's.)

mod support;

/// The tests of this file change process-wide state: one at a time.
static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

use cryoglyph::{fail_draws, kill_worker, slow_worker};
use iced::advanced::graphics::text::{self as graphics_text, GlyphDrawing};
use iced::Size;
use std::time::Duration;
use support::{ink, lines, Window};

const WORDS: [&str; 3] = ["Failing glyphs drawn again", "by the other rasterizer", "0123456789 and more"];

#[test]
fn a_directwrite_failure_is_drawn_again_by_swash_and_the_frame_is_whole() {
    let _serial = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(mut window) = Window::open(Size::new(480.0, 100.0)) else {
        eprintln!("skipped: no graphics adapter");
        return;
    };
    // What swash draws, asked for directly.
    let rendering = graphics_text::rendering();
    graphics_text::set_rendering(graphics_text::Rendering { glyphs: GlyphDrawing::Worker, ..rendering });
    let mut interface = window.interface(&lines(&WORDS), 15.0);
    let by_swash = window.until_complete(&mut interface).swap_remove(0);
    assert!(ink(&by_swash) > 300);

    // The same text with every DirectWrite draw failing, in a window that has not drawn these glyphs.
    let Some(mut other) = Window::open(Size::new(480.0, 100.0)) else { return };
    graphics_text::set_rendering(graphics_text::Rendering { glyphs: GlyphDrawing::DirectWrite, ..rendering });
    fail_draws(100_000);
    let mut interface = other.interface(&lines(&WORDS), 15.0);
    let shown = other.until_complete(&mut interface);
    fail_draws(0);
    for picture in &shown {
        assert_eq!(*picture, by_swash, "a frame shown while DirectWrite failed is the text drawn by swash, whole");
    }
}

#[test]
fn a_worker_that_dies_is_replaced_and_no_frame_shown_has_a_hole() {
    let _serial = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    slow_worker(Duration::from_millis(6));
    let (Some(mut reference), Some(mut window)) = (Window::open(Size::new(480.0, 100.0)), Window::open(Size::new(480.0, 100.0))) else {
        eprintln!("skipped: no graphics adapter");
        return;
    };
    let mut interface = reference.interface(&lines(&WORDS), 17.0);
    let whole = reference.until_complete(&mut interface).swap_remove(0);
    let blank = window.shown.clone();

    let mut interface = window.interface(&lines(&WORDS), 17.0);
    let mut presented = Vec::new();
    for step in 0..8 {
        if window.frame(&mut interface) {
            presented.push(window.shown.clone());
        }
        if step == 2 {
            // The worker dies with the glyphs it was holding.
            kill_worker();
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    presented.extend(window.until_complete(&mut interface));
    for picture in &presented {
        assert!(*picture == blank || *picture == whole, "a frame was shown with glyphs missing");
    }
    assert_eq!(window.shown, whole, "the text arrived whole after the worker was replaced");
    assert_eq!(window.renderer.glyph_state(), (0, 0), "nothing the dead worker held is still waited for");
}
