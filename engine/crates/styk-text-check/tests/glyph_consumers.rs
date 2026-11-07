//! Two windows on one thread: each one's candidates are its own.
//!
//! Window A's requests are not retired when window B ends a frame, and replies go to who asked.

mod support;

use cryoglyph::slow_worker;
use iced::Size;
use std::time::{Duration, Instant};
use support::{ink, lines, Window};

#[test]
fn two_renderers_alternating_on_one_thread_both_complete() {
    slow_worker(Duration::from_millis(2));
    let size = Size::new(480.0, 100.0);
    let (Some(mut a), Some(mut b)) = (Window::open(size), Window::open(size)) else {
        eprintln!("skipped: no graphics adapter");
        return;
    };
    let mut first = a.interface(&lines(&["Window A has its own words", "and its own sizes 0123456789"]), 16.0);
    let mut second = b.interface(&lines(&["Quite different text in B", "Zulu Yankee Xray Whiskey"]), 13.0);
    let started = Instant::now();
    let (mut a_whole, mut b_whole) = (false, false);
    // One frame of each in turn, as two windows of one program are drawn.
    while !(a_whole && b_whole) {
        assert!(started.elapsed() < Duration::from_secs(20), "one window starved the other: A whole {a_whole}, B whole {b_whole}");
        if a.frame(&mut first) && !a.renderer.text_incomplete() {
            a_whole = true;
        }
        if b.frame(&mut second) && !b.renderer.text_incomplete() {
            b_whole = true;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    assert!(ink(&a.shown) > 300 && ink(&b.shown) > 300);
    // Neither window ever stopped wanting what it had asked for, so nothing was cancelled: window B ending a frame did not
    // retire window A's requests, nor the other way round.
    assert_eq!(cryoglyph::skipped_jobs(), 0, "one window's candidate retired the other's requests");
    assert_ne!(a.shown, b.shown);
    // Each window's own bookkeeping ends empty.
    for _ in 0..50 {
        a.frame(&mut first);
        b.frame(&mut second);
        if a.renderer.glyph_state() == (0, 0) && b.renderer.glyph_state() == (0, 0) {
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    panic!("A keeps {:?} and B {:?}", a.renderer.glyph_state(), b.renderer.glyph_state());
}
