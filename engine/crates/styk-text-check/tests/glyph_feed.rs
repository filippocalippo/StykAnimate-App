//! Feeding the glyph worker never waits for the font system.
//!
//! The interface thread takes the font system synchronously (D7): anything that holds it for long, or that waits for it
//! on the interface's behalf, stalls the window. The repertoire's layout and font collection need it and are done before
//! readiness is published (`warm_up`); feeding the worker after that must not touch it.

use iced::advanced::graphics::text::font_system;
use std::time::{Duration, Instant};
use styk_design::{repertoire, warm_up};

#[test]
fn feeding_the_worker_does_not_touch_the_font_system() {
    let _ready = warm_up::install_bundled();
    let started = Instant::now();
    let prepared = repertoire::prepare(1.0, "it-IT").expect("glyphs are drawn by a worker");
    println!("the repertoire of {} glyphs was laid out in {} ms", prepared.len(), started.elapsed().as_millis());
    assert!(prepared.len() > 1000, "the repertoire has {} glyphs", prepared.len());

    // The interface thread holds the font system (as it does while it lays out text): the feeder must not need it.
    let guard = font_system().write().unwrap_or_else(|poisoned| poisoned.into_inner());
    let feeder = prepared.feed().expect("a feeder thread");
    let started = Instant::now();
    while !feeder.is_finished() && started.elapsed() < Duration::from_secs(20) {
        std::thread::sleep(Duration::from_millis(5));
    }
    let finished = feeder.is_finished();
    drop(guard);
    assert!(finished, "the feeder waited for the font system the interface thread held");
    feeder.join().expect("the feeder ends");
}
