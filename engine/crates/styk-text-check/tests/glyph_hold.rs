//! A frame with glyphs missing is never shown, however slow the worker is and however fast the screens change.
//!
//! The worker is slowed so that a screen takes about a second to draw, far past any deadline a window could have for it.
//! (Its own test binary: the slowing is the process's.)

mod support;

use cryoglyph::slow_worker;
use iced::Size;
use std::time::{Duration, Instant};
use support::{lines, Window};

const SCREENS: [(&[&str], f32); 3] = [
    (&["Alpha Bravo Charlie", "Delta Echo Foxtrot", "Golf Hotel India"], 14.0),
    (&["Zulu Xray Whiskey 0123456789", "Quebec Papa Oscar $%&"], 16.0),
    (&["Mike Lima Kilo Juliet", "Yankee Tango Sierra", "Romeo ÀÉÎÕÜ"], 18.0),
];

#[test]
fn quick_screen_switches_never_show_a_frame_with_glyphs_missing_however_slow_the_worker_is() {
    slow_worker(Duration::from_millis(25));
    let size = Size::new(480.0, 120.0);
    let (Some(mut reference), Some(mut window)) = (Window::open(size), Window::open(size)) else {
        eprintln!("skipped: no graphics adapter");
        return;
    };
    // What each screen looks like whole, drawn in a window of its own.
    let blank = window.shown.clone();
    let whole: Vec<Vec<u8>> = SCREENS
        .iter()
        .map(|(words, pixels)| {
            let mut interface = reference.interface(&lines(words), *pixels);
            reference.until_complete(&mut interface).swap_remove(0)
        })
        .collect();
    assert!(whole.iter().all(|picture| *picture != blank) && whole[0] != whole[1] && whole[1] != whole[2]);

    // The window under test switches screens every 400 ms, each time before the screen before is whole (each takes about
    // a second): past the 150 ms a deadline would allow, with the next candidate inheriting the wait of the last.
    let mut presented = Vec::new();
    let started = Instant::now();
    for (index, (words, pixels)) in SCREENS.iter().enumerate() {
        let mut interface = window.interface(&lines(words), *pixels);
        if index + 1 < SCREENS.len() {
            let until = Instant::now() + Duration::from_millis(400);
            while Instant::now() < until {
                if window.frame(&mut interface) {
                    presented.push(window.shown.clone());
                }
                std::thread::sleep(Duration::from_millis(8));
            }
        } else {
            presented.extend(window.until_complete(&mut interface));
        }
    }
    assert!(window.held > 40, "the window kept its last frame through the switches ({} candidates held)", window.held);
    assert!(started.elapsed() > Duration::from_millis(800));
    for (index, picture) in presented.iter().enumerate() {
        let known = *picture == blank || whole.iter().any(|whole| whole == picture);
        assert!(known, "the frame shown at step {index} is neither the empty window nor a screen drawn whole: it has glyphs missing");
    }
    assert_eq!(presented.iter().filter(|picture| **picture != blank).count(), 1, "the only frame shown is the last screen, whole");
    assert_eq!(window.shown, whole[2]);
    let held = iced::advanced::graphics::text::held_frames();
    assert!(held.frames as usize >= window.held && held.longest_millis >= 800, "the developer tools' counters saw the waits: {held:?}");
}
