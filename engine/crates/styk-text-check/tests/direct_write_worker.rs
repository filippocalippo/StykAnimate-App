//! Glyph masks drawn by DirectWrite arrive from a worker thread (Windows).
//!
//! The first frame of a text finds none of its glyphs in the atlas: it asks the worker for them, leaves them out and says
//! so (`glyphs_pending`). The frames after it have them. The interface thread never draws a glyph.

#![cfg(windows)]

use iced::advanced::renderer::{self, Headless};
use iced::advanced::shell;
use iced::widget::{column, text};
use iced::{Size, Widget, mouse, window};
use iced_runtime::UserInterface;
use iced_runtime::user_interface::Cache;
use styk_design::typography::TextStyle;
use styk_design::{glyphs, tokens::scale, warm_up, widgets};

/// How many pixels of `rgba` differ from `background`.
fn ink(rgba: &[u8], background: [u8; 4]) -> usize {
    rgba.chunks_exact(4).filter(|pixel| pixel[..3] != background[..3]).count()
}

#[test]
fn the_first_frame_lacks_the_glyphs_a_worker_is_drawing_and_a_later_frame_has_them() {
    let settings = iced::Settings { font: widgets::INTER, ..iced::Settings::default() };
    let Some(mut renderer) = pollster::block_on(<iced::Renderer as Headless>::new(renderer::Settings::from(&settings), None)) else {
        eprintln!("skipped: no graphics adapter");
        return;
    };
    let _ready = warm_up::install_bundled();
    assert!(iced::advanced::graphics::text::rendering().direct_write, "DirectWrite is the rasterizer on Windows");

    let style = TextStyle::from_role(&scale::TYPE_BODY);
    let rows: Vec<iced::Element<'_, ()>> = (0..8).map(|index| text(format!("Position Rotation 45.25 Zoom 100% {index}")).font(style.font).size(style.pixels()).line_height(style.line()).boxed()).collect();
    let bounds = Size::new(480.0, 8.0 * style.line_height);
    let mut interface: UserInterface<'_, (), iced::Theme, iced::Renderer> = UserInterface::build(column(rows).boxed(), bounds, Cache::default(), &mut renderer);
    let _ = interface.update(&window::Headless, &shell::Waker::noop(), &[iced::event::Event::Window(window::Event::RedrawRequested(iced::time::Instant::now()))], mouse::Cursor::Unavailable, &mut renderer, &mut shell::Bus::new());
    let background = iced::Color::WHITE;
    let mut frame = |renderer: &mut iced::Renderer| {
        interface.draw(renderer, &iced::Theme::Light, &renderer::Style { text_color: iced::Color::BLACK }, mouse::Cursor::Unavailable);
        Headless::screenshot(renderer, bounds_physical(bounds), 1.0, background)
    };

    let first = frame(&mut renderer);
    let pending_after_the_first = glyphs::pending();
    assert!(pending_after_the_first > 0, "the first frame asked the worker for its glyphs");
    let first_ink = ink(&first, [255, 255, 255, 255]);

    let mut last = first.clone();
    for _ in 0..500 {
        last = frame(&mut renderer);
        if glyphs::pending() == 0 {
            last = frame(&mut renderer);
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    assert_eq!(glyphs::pending(), 0, "the worker finished");
    let last_ink = ink(&last, [255, 255, 255, 255]);
    assert!(last_ink > 1500, "the text is on screen once the glyphs have arrived ({last_ink} pixels)");
    assert!(first_ink < last_ink / 2, "the first frame had little of it: {first_ink} pixels against {last_ink}");
}

fn bounds_physical(bounds: Size) -> Size<u32> {
    Size::new(bounds.width as u32, bounds.height as u32)
}
