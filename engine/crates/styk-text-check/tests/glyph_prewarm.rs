//! The interface's fixed glyphs are drawn before its first frame asks for them.
//!
//! Its own test binary: the warm glyphs wait in a mailbox that any interface thread in the process may take, so a second
//! window in the same process would race this one for them.

mod support;

use iced::advanced::shell;
use iced::widget::text;
use iced::{Color, Size, Widget, mouse, window};
use iced_runtime::UserInterface;
use iced_runtime::user_interface::Cache;
use std::time::{Duration, Instant};
use styk_design::repertoire;
use support::{ink, Window};

#[test]
fn the_interfaces_fixed_glyphs_are_ready_before_its_first_frame() {
    let Some(mut window) = Window::open(Size::new(480.0, 120.0)) else {
        eprintln!("skipped: no graphics adapter");
        return;
    };
    let feeder = repertoire::prewarm(1.0, "it-IT".to_string()).expect("a glyph worker");
    feeder.join().expect("the feeder ends");
    let started = Instant::now();
    while cryoglyph::worker_state().0 > 0 && started.elapsed() < Duration::from_secs(30) {
        std::thread::sleep(Duration::from_millis(5));
    }
    let (queued, warm_bytes) = cryoglyph::worker_state();
    assert_eq!(queued, 0, "the worker drew everything asked of it");
    assert!(warm_bytes > 100_000 && warm_bytes <= cryoglyph::MAX_WARM_BYTES, "{warm_bytes} bytes of warm glyphs");
    // Body-sized text in the app's Latin letters, digits and accents: the first candidate is whole.
    let style = styk_design::typography::TextStyle::from_role(&styk_design::tokens::scale::TYPE_BODY);
    let element: iced::Element<'static, (), iced::Theme, iced_wgpu::Renderer> = text("Posizione Rotazione 45,25° Zoom 100% — è più già").font(style.font).size(style.pixels()).line_height(style.line()).color(Color::BLACK).boxed();
    let mut interface = UserInterface::build(element, window.size, Cache::default(), &mut window.renderer);
    let _ = interface.update(&window::Headless, &shell::Waker::noop(), &[iced::event::Event::Window(window::Event::RedrawRequested(iced::time::Instant::now()))], mouse::Cursor::Unavailable, &mut window.renderer, &mut shell::Bus::new());
    assert!(window.frame(&mut interface), "the first frame was shown");
    assert!(!window.renderer.text_incomplete(), "no glyph of the fixed repertoire had to be waited for");
    assert!(ink(&window.shown) > 300);
}
