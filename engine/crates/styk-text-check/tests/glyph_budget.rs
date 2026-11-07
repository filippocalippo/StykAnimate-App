//! The masks frames hold are bounded in bytes, from before they are drawn until they are uploaded.
//!
//! (Its own test binary: the budget is the process's.)

mod support;

/// The tests of this file change process-wide state: one at a time.
static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

use cryoglyph::{frame_bytes, overflow_draws, set_frame_budget};
use iced::Size;
use std::time::{Duration, Instant};
use support::{ink, Window};

const CAP: usize = 60_000;

fn many_sizes() -> Vec<(String, f32)> {
    (0..30).map(|index| ("abcdefghijklmnopqrstuvwxyz ABCDEFGHIJ".to_string(), 10.0 + index as f32 * 0.5)).collect()
}

#[test]
fn the_bytes_of_the_masks_in_flight_never_pass_the_budget_and_every_glyph_still_arrives() {
    let _serial = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    set_frame_budget(CAP);
    let Some(mut window) = Window::open(Size::new(900.0, 900.0)) else {
        eprintln!("skipped: no graphics adapter");
        return;
    };
    let mut interface = window.interface_sized(many_sizes());
    let (mut most, started) = (0, Instant::now());
    loop {
        window.frame(&mut interface);
        most = most.max(frame_bytes());
        if !window.renderer.text_incomplete() {
            break;
        }
        assert!(started.elapsed() < Duration::from_secs(60), "the screen never completed");
        std::thread::sleep(Duration::from_millis(1));
    }
    assert!(most > 0, "masks were reserved");
    assert!(most <= CAP, "{most} bytes of masks were held at once, over the budget of {CAP}");
    assert!(ink(&window.shown) > 2000);
    // Uploaded masks give their bytes back.
    for _ in 0..20 {
        window.frame(&mut interface);
        if frame_bytes() == 0 {
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    panic!("{} bytes are still held with nothing asked for", frame_bytes());
}

#[test]
fn a_mask_that_does_not_fit_what_was_reserved_is_asked_for_again_not_dropped() {
    let _serial = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    set_frame_budget(cryoglyph::FRAME_BYTES);
    let Some(mut window) = Window::open(Size::new(480.0, 120.0)) else {
        eprintln!("skipped: no graphics adapter");
        return;
    };
    // The next forty draws find their mask larger than the reservation and cannot get more.
    overflow_draws(40);
    let rows = vec![("Masks that overflow are drawn".to_string(), 16.0), ("when they are asked for again".to_string(), 16.0)];
    let mut interface = window.interface_sized(rows);
    let shown = window.until_complete(&mut interface);
    assert!(ink(&shown[0]) > 300, "the text arrived whole after its overflows");
    assert_eq!(window.renderer.glyph_state(), (0, 0));
}
