//! The stage widget in the toolkit's own renderer (`docs/native/stage.md`, "The stage widget"): its draw path on a real device,
//! and what it makes of pointer, wheel and size. The logic those events reach is `styk_core::stage::Surface`'s, tested in
//! `styk-core/tests/stage_surface.rs`; here the widget is the unit.

use iced::advanced::renderer::{self, Headless};
use iced::advanced::shell;
use iced::{Event, Pixels, Point, Size, keyboard, mouse, window};
use iced_runtime::UserInterface;
use iced_runtime::user_interface::Cache;
use std::sync::Arc;
use std::time::Duration;
use styk_core::app::Core;
use styk_core::stage::{Call, PaintStatus, Surface};
use styk_design::{Theme, warm_up, widgets};
use styk_ui::Message;

struct Harness {
    renderer: iced::Renderer,
    core: Core,
    surface: Arc<Surface>,
    cache: Cache,
    size: Size,
    scale: f32,
    theme: Theme,
    /// The last frame's picture, RGBA, top row first.
    picture: Vec<u8>,
}

impl Harness {
    fn new(size: (u32, u32), scale: f32) -> Harness {
        let settings = iced::Settings { font: widgets::INTER, text_size: Pixels(16.0), ..iced::Settings::default() };
        let renderer = pollster::block_on(<iced::Renderer as Headless>::new(renderer::Settings::from(&settings), None)).expect("a graphics adapter is required; a missing one must not pass");
        let _ready = warm_up::install_bundled(styk_platform::font_smoothing::current());
        let clock: Arc<dyn styk_services::Clock> = Arc::new(styk_platform::clock::SystemClock::new());
        let core = styk_core::screens::stage(Arc::new(styk_platform::spawn::ThreadSpawner), clock, Arc::new(|| {}), [f64::from(size.0), f64::from(size.1)]).expect("the stage fixture opens");
        let surface = core.stage().expect("the active document has a stage");
        Harness { renderer, core, surface, cache: Cache::default(), size: Size::new(size.0 as f32, size.1 as f32), scale, theme: Theme::Light, picture: Vec::new() }
    }

    /// The toolkit's frame: the widget is built from the core, takes `events` and the cursor, its messages go to the core
    /// as the application would send them, and the frame is drawn (prepare, then the pass that presents).
    fn frame(&mut self, events: &[Event], cursor: mouse::Cursor) -> Vec<Message> {
        let view = styk_ui::stage::view(&self.core, None, self.theme).expect("the stage widget");
        let mut interface: UserInterface<'_, Message, iced::Theme, iced::Renderer> = UserInterface::build(view, self.size, std::mem::take(&mut self.cache), &mut self.renderer);
        let mut bus = shell::Bus::new();
        let _ = interface.update(&window::Headless, &shell::Waker::noop(), events, cursor, &mut self.renderer, &mut bus);
        let messages: Vec<Message> = bus.into_iter().collect();
        interface.draw(&mut self.renderer, &styk_ui::base_theme(self.theme), &renderer::Style { text_color: iced::Color::BLACK }, cursor);
        let physical = Size::new((self.size.width * self.scale).round() as u32, (self.size.height * self.scale).round() as u32);
        self.picture = Headless::screenshot(&mut self.renderer, physical, self.scale, styk_ui::window_style(self.theme).background_color);
        self.cache = interface.into_cache();
        for message in &messages {
            let _ = styk_ui::message::update(&mut self.core, message.clone());
        }
        messages
    }

    /// Frames until the picture on show answers the newest demand, as the toolkit's redraws do while it is pending.
    fn settle(&mut self) {
        let began = std::time::Instant::now();
        loop {
            self.frame(&[Event::Window(window::Event::RedrawRequested(iced::time::Instant::now()))], mouse::Cursor::Unavailable);
            match self.surface.status() {
                PaintStatus::Ready => return,
                PaintStatus::Failed(error) => panic!("the stage failed: {error:?}"),
                _ => {}
            }
            assert!(began.elapsed() < Duration::from_secs(45), "the stage did not settle");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn pixel(&self, x: u32, y: u32) -> [u8; 4] {
        let width = (self.size.width * self.scale).round() as u32;
        let at = ((y * width + x) * 4) as usize;
        [self.picture[at], self.picture[at + 1], self.picture[at + 2], self.picture[at + 3]]
    }
}

fn at(x: f32, y: f32) -> mouse::Cursor {
    mouse::Cursor::Available(Point::new(x, y))
}

#[test]
fn the_draw_path_updates_then_presents_never_waits_and_shows_the_document() {
    let mut stage = Harness::new((900, 560), 1.0);
    // The first frame returns at once, with no picture: the paint worker has its own time.
    stage.frame(&[], mouse::Cursor::Unavailable);
    assert_ne!(stage.surface.status(), PaintStatus::Ready, "nothing waited for the first picture");
    let calls = stage.surface.take_calls();
    let order = |call: Call| calls.iter().position(|c| *c == call).unwrap_or_else(|| panic!("{call:?} in {calls:?}"));
    assert!(order(Call::Observe) < order(Call::Attach) && order(Call::Attach) < order(Call::Update) && order(Call::Update) < order(Call::Present), "{calls:?}");
    assert_eq!(calls.iter().filter(|c| **c == Call::Update).count(), 1, "one update per frame");
    assert_eq!(calls.iter().filter(|c| **c == Call::Present).count(), 1, "one present per frame");
    stage.settle();
    let field = [0xec, 0xef, 0xf4, 255];
    assert_eq!(stage.pixel(5, 5), field, "the window field around the artboard");
    assert_eq!(stage.pixel(100, 100), [255, 255, 255, 255], "the artboard: the document's white");
    let blue = (0..560).flat_map(|y| (0..900).map(move |x| (x, y))).filter(|&(x, y)| stage.pixel(x, y) == [13, 153, 255, 255]).count();
    assert!(blue > 2000, "the figure is drawn in its blue: {blue} pixels");
    // The surface was told its place: the widget's size and the window's density.
    let viewport = stage.surface.viewport().expect("viewport");
    assert_eq!((viewport.size, viewport.dpr), ([900.0, 560.0], 1.0));
}

#[test]
fn the_widget_reports_the_density_of_its_window() {
    let mut stage = Harness::new((600, 400), 2.0);
    stage.frame(&[], mouse::Cursor::Unavailable);
    let viewport = stage.surface.viewport().expect("viewport");
    assert_eq!((viewport.size, viewport.dpr), ([600.0, 400.0], 2.0));
    stage.settle();
    assert_eq!(stage.surface.shown_key().expect("a picture").view.size, [1200, 800], "the picture is made at the backing size");
}

#[test]
fn a_middle_drag_and_the_wheel_become_stage_commands_that_move_the_view() {
    let mut stage = Harness::new((900, 560), 1.0);
    stage.settle();
    let before = stage.surface.view().expect("view");
    let down = stage.frame(&[Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Middle))], at(300.0, 300.0));
    assert_eq!(down.len(), 1, "one stage command for the press");
    stage.frame(&[Event::Mouse(mouse::Event::CursorMoved { position: Point::new(340.0, 280.0) })], at(340.0, 280.0));
    stage.frame(&[Event::Mouse(mouse::Event::ButtonReleased(mouse::Button::Middle))], at(340.0, 280.0));
    let panned = stage.surface.view().expect("view");
    assert_eq!([panned.pan[0] - before.pan[0], panned.pan[1] - before.pan[1]], [40.0, -20.0]);
    assert_eq!(panned.zoom, before.zoom);
    assert_eq!(stage.surface.cursor(), styk_core::stage::Cursor::Default, "the drag ended with the button");
    // A plain wheel pans (a notch down moves the view up); Ctrl zooms about the pointer.
    stage.frame(&[Event::Mouse(mouse::Event::WheelScrolled { delta: mouse::ScrollDelta::Lines { x: 0.0, y: -1.0 } })], at(450.0, 280.0));
    assert_eq!(stage.surface.view().expect("view").pan[1], panned.pan[1] - 100.0);
    stage.frame(&[Event::Keyboard(keyboard::Event::ModifiersChanged(keyboard::Modifiers::CTRL))], at(450.0, 280.0));
    stage.frame(&[Event::Mouse(mouse::Event::WheelScrolled { delta: mouse::ScrollDelta::Pixels { x: 0.0, y: 19.0 } })], at(450.0, 280.0));
    assert!(stage.surface.view().expect("view").zoom > panned.zoom * 1.09);
    // A press over the stage that is not navigation goes back to the tool owner and moves nothing.
    let view = stage.surface.view();
    stage.frame(&[Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left))], at(450.0, 280.0));
    stage.frame(&[Event::Mouse(mouse::Event::CursorMoved { position: Point::new(500.0, 300.0) })], at(500.0, 300.0));
    stage.frame(&[Event::Mouse(mouse::Event::ButtonReleased(mouse::Button::Left))], at(500.0, 300.0));
    assert_eq!(stage.surface.view(), view);
}

#[test]
fn space_held_over_the_stage_makes_a_left_drag_pan_and_events_outside_it_are_not_the_stages() {
    let mut stage = Harness::new((900, 560), 1.0);
    stage.settle();
    let before = stage.surface.view().expect("view");
    stage.frame(&[Event::Keyboard(keyboard::Event::KeyPressed {
        key: keyboard::Key::Named(keyboard::key::Named::Space),
        modified_key: keyboard::Key::Named(keyboard::key::Named::Space),
        physical_key: keyboard::key::Physical::Code(keyboard::key::Code::Space),
        location: keyboard::Location::Standard,
        modifiers: keyboard::Modifiers::empty(),
        text: None,
        repeat: false,
    })], at(300.0, 300.0));
    assert_eq!(stage.surface.cursor(), styk_core::stage::Cursor::Grab);
    stage.frame(&[Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left))], at(300.0, 300.0));
    assert_eq!(stage.surface.cursor(), styk_core::stage::Cursor::Grabbing);
    stage.frame(&[Event::Mouse(mouse::Event::CursorMoved { position: Point::new(310.0, 330.0) })], at(310.0, 330.0));
    stage.frame(&[Event::Mouse(mouse::Event::ButtonReleased(mouse::Button::Left))], at(310.0, 330.0));
    let panned = stage.surface.view().expect("view");
    assert_eq!([panned.pan[0] - before.pan[0], panned.pan[1] - before.pan[1]], [10.0, 30.0]);
    // A wheel with the cursor outside the stage is not its.
    let none = stage.frame(&[Event::Mouse(mouse::Event::WheelScrolled { delta: mouse::ScrollDelta::Lines { x: 0.0, y: -1.0 } })], at(-10.0, 300.0));
    assert!(none.is_empty());
}
