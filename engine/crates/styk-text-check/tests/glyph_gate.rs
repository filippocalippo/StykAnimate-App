//! Glyphs drawn by a worker never reach the screen half drawn.
//!
//! The window shows frames, and a frame that lacks glyphs the worker is still drawing would show holes in its text. The
//! renderer keeps the last complete frame instead (`hold_frame`) and the window shows the new one when it is whole. These
//! tests run a window's loop headless: draw a candidate, read it back, show it unless the renderer holds it.

mod support;

use iced::advanced::shell;
use iced::widget::text;
use iced::{Color, Size, Widget, mouse, window};
use iced_runtime::UserInterface;
use iced_runtime::user_interface::Cache;
use std::time::{Duration, Instant};
use styk_design::widgets;
use support::{ink, lines, Window};

#[test]
fn a_screen_switch_never_shows_text_with_glyphs_missing() {
    let Some(mut window) = Window::open(Size::new(480.0, 200.0)) else {
        eprintln!("skipped: no graphics adapter");
        return;
    };
    let mut first = window.interface(&lines(&["Alpha Bravo Charlie", "Delta Echo Foxtrot", "Golf Hotel India"]), 13.0);
    let first_picture = window.until_complete(&mut first).swap_remove(0);
    assert!(ink(&first_picture) > 500, "the first screen has text ({} pixels)", ink(&first_picture));

    // The second screen is in other letters and another size: none of its glyphs is drawn yet.
    let mut second = window.interface(&lines(&["Zulu Xray Whiskey 0123456789", "Quebec Papa Oscar $%&", "Mike Lima Kilo ÀÉÎÕÜ"]), 17.0);
    window.held = 0;
    let shown = window.until_complete(&mut second);
    let complete = shown[0].clone();
    assert_ne!(complete, first_picture, "the second screen is not the first");
    assert!(window.held > 0, "the first candidates of the second screen lacked glyphs and were held back");
    for (index, picture) in shown.iter().enumerate() {
        assert!(*picture == first_picture || *picture == complete, "the frame shown at step {index} of the switch is neither the first screen nor the whole second one ({} ink pixels, first {}, second {})", ink(picture), ink(&first_picture), ink(&complete));
    }
}

#[test]
fn glyphs_wanted_by_a_superseded_screen_are_not_waited_for() {
    let Some(mut window) = Window::open(Size::new(480.0, 200.0)) else {
        eprintln!("skipped: no graphics adapter");
        return;
    };
    // A screen of many glyphs is asked for and, before the worker is done, replaced by another.
    let mut abandoned = window.interface(&lines(&["Abandoned glyphs of 21 px", "Abandoned glyphs of 21 px, again"]), 21.0);
    window.frame(&mut abandoned);
    assert!(window.renderer.text_incomplete(), "the abandoned screen's glyphs were not ready at its first frame");
    let mut kept = window.interface(&lines(&["Kept text"]), 15.0);
    let shown = window.until_complete(&mut kept);
    assert!(ink(&shown[0]) > 100);
    // Nothing the abandoned screen asked for stays asked for: the worker's answers are retired as they come.
    let started = Instant::now();
    let mut state = cryoglyph::client_state();
    while state != (0, 0) && started.elapsed() < Duration::from_secs(5) {
        window.frame(&mut kept);
        std::thread::sleep(Duration::from_millis(5));
        state = cryoglyph::client_state();
    }
    assert_eq!(state, (0, 0), "no job and no mask of the superseded screen is kept (jobs, entries)");
}

#[test]
fn requests_beyond_the_bound_wait_for_the_next_candidate_and_all_arrive() {
    let Some(mut window) = Window::open(Size::new(900.0, 1000.0)) else {
        eprintln!("skipped: no graphics adapter");
        return;
    };
    // More distinct glyphs than the bound admits at once: 26 letters at 40 sizes, a size per row.
    let rows: Vec<(String, f32)> = (0..40).map(|index| ("abcdefghijklmnopqrstuvwxyz".to_string(), 10.0 + index as f32 * 0.5)).collect();
    let mut interface = window.interface_sized(rows);
    let mut most = 0;
    let started = Instant::now();
    loop {
        window.frame(&mut interface);
        most = most.max(cryoglyph::client_state().0);
        if !window.renderer.text_incomplete() {
            break;
        }
        assert!(started.elapsed() < Duration::from_secs(20), "the screen never completed");
        std::thread::sleep(Duration::from_millis(1));
    }
    assert!(most <= cryoglyph::MAX_JOBS, "{most} jobs were outstanding at once");
    assert!(most > 0 && ink(&window.shown) > 1000);
}

/// The ink of the upper and lower half of the picture, as the mean column of its pixels.
fn lean(picture: &[u8], width: usize) -> f32 {
    let height = picture.len() / 4 / width;
    let centroid = |rows: std::ops::Range<usize>| {
        let (mut sum, mut count) = (0.0f64, 0.0f64);
        for y in rows {
            for x in 0..width {
                if picture[(y * width + x) * 4] < 128 {
                    sum += x as f64;
                    count += 1.0;
                }
            }
        }
        (sum / count.max(1.0)) as f32
    };
    centroid(0..height / 2) - centroid(height / 2..height)
}

#[test]
fn a_synthetic_italic_is_drawn_by_the_worker_too() {
    use iced::font::Style;
    let Some(mut window) = Window::open(Size::new(480.0, 60.0)) else {
        eprintln!("skipped: no graphics adapter");
        return;
    };
    let mut draw = |style: Style| {
        let element: iced::Element<'static, (), iced::Theme, iced_wgpu::Renderer> = text("llllllllllllll IIIIIIIIIIII").font(widgets::INTER.style(style)).size(40.0).color(Color::BLACK).boxed();
        let mut interface = UserInterface::build(element, window.size, Cache::default(), &mut window.renderer);
        let _ = interface.update(&window::Headless, &shell::Waker::noop(), &[iced::event::Event::Window(window::Event::RedrawRequested(iced::time::Instant::now()))], mouse::Cursor::Unavailable, &mut window.renderer, &mut shell::Bus::new());
        window.until_complete(&mut interface).swap_remove(0)
    };
    let upright = lean(&draw(Style::Normal), 480);
    let italic = lean(&draw(Style::Italic), 480);
    assert!(upright.abs() < 1.0, "upright text does not lean ({upright})");
    assert!(italic > upright + 2.5, "the upper half of an italic drawn from an upright face sits to the right of its lower half ({italic} against {upright})");
}
