//! The Properties panel headless: every context drawn in both themes, and one interaction of each kind (a drag of a
//! scrub label, typing with Enter, an arrow step, undo) through the real widgets, the messages they publish, the core
//! and back into the view. `STYK_INSPECTOR_PNG_DIR=<dir>` also writes each context's picture there for the screenshot
//! comparison with today's panel.
use iced::keyboard::key::Named;
use iced::mouse;
use iced::{Event, Point, Size};
use styk_core::app::Core;
use styk_core::commands::{Command, CommandId};
use styk_core::inspector::model::Kind;
use styk_core::inspector::property::PropertyKey;
use styk_core::view_state::{InspectorContext, InspectorTab};
use styk_design::Theme;
use styk_design::widgets::testing::Driver;
use styk_ui::inspector::{self, View, input_id, label_id};
use styk_ui::message::{Message, update};

const STARTUP: &[u8] = include_bytes!("../../../tests/edit/startup.document.json");
const SHEET: &[u8] = include_bytes!("../../../tests/edit/property-sheet.document.json");
const SPRITE: &[u8] = include_bytes!("../../../tests/edit/sprite-segment-sparse-native.document.json");
// The panel as today's default layout docks it at 1440 × 900.
const SIZE: Size = Size::new(inspector::WIDTH, 502.0);

fn core(bytes: &[u8]) -> Core {
    styk_core::testing::core_with_document(bytes, "Test.styk").unwrap()
}

fn element(core: &Core, theme: Theme) -> iced::Element<'static, Message> {
    let panel = core.inspector();
    inspector::view(View { model: panel.model().unwrap(), field: panel.field(), rename: panel.rename(), theme, button_probe: None })
}

fn call(core: &mut Core, method: &str, args: &str) {
    styk_core::testing::call(core, method, args).unwrap();
}

/// Delivers every message the interface published to the core, as the application's `update` does.
fn deliver(core: &mut Core, driver: &mut Driver<'static, Message>) -> usize {
    let messages = driver.messages();
    let count = messages.len();
    for message in messages {
        // Focus tasks are the runtime's; the test runs the ones it needs through the driver.
        let _ = update(core, message);
    }
    count
}

fn rebuild(core: &Core, driver: Driver<'static, Message>) -> Driver<'static, Message> {
    driver.rebuild(element(core, Theme::Light))
}

fn value(core: &Core, key: PropertyKey) -> f64 {
    core.inspector().model().unwrap().number(key).unwrap().value
}

fn undo_depth(core: &Core) -> usize {
    styk_core::testing::undo_depth(core)
}

fn contexts() -> Vec<(&'static str, Core)> {
    let mut list = Vec::new();
    let mut scene = core(STARTUP);
    call(&mut scene, "select", "[null,-1]");
    list.push(("scene", scene));
    list.push(("figure", core(STARTUP)));
    let mut joint = core(STARTUP);
    call(&mut joint, "select", "[1,1]");
    list.push(("joint", joint));
    let mut figures = core(SHEET);
    call(&mut figures, "selectMany", "[[1,2,3]]");
    list.push(("figures", figures));
    let mut sprite = core(SPRITE);
    call(&mut sprite, "select", "[3,-1]");
    list.push(("image", sprite));
    for (name, context) in [("camera", InspectorContext::Camera), ("layer", InspectorContext::Layer)] {
        let mut core = core(STARTUP);
        core.view_state_mut().set_context(context);
        core.refresh();
        list.push((name, core));
    }
    let mut frame = core(STARTUP);
    frame.view_state_mut().set_tab(InspectorTab::Animation);
    frame.refresh();
    list.push(("frame", frame));
    list
}

#[test]
fn every_context_draws_in_both_themes() {
    let out = std::env::var_os("STYK_INSPECTOR_PNG_DIR").map(std::path::PathBuf::from);
    for (name, core) in contexts() {
        for theme in [Theme::Light, Theme::Dark] {
            let mut driver = Driver::new(element(&core, theme), SIZE, &styk_design::fonts::ALL);
            let (pixels, size) = driver.render(&styk_ui::base_theme(theme), iced::Color::from(theme.palette().surface_field), 1.0);
            assert_eq!(pixels.len(), (size.width * size.height * 4) as usize);
            let distinct = pixels.chunks(4).map(|p| [p[0], p[1], p[2]]).collect::<std::collections::HashSet<_>>().len();
            assert!(distinct > 16, "{name} {theme:?} drew its controls ({distinct} colours)");
            if let Some(dir) = &out {
                let file = std::fs::File::create(dir.join(format!("{name}-{theme:?}.png").to_lowercase())).unwrap();
                let mut encoder = png::Encoder::new(file, size.width, size.height);
                encoder.set_color(png::ColorType::Rgba);
                encoder.set_depth(png::BitDepth::Eight);
                encoder.write_header().unwrap().write_image_data(&pixels).unwrap();
            }
        }
    }
}

#[test]
fn drag_type_step_and_undo_through_the_panel() {
    let mut core = core(STARTUP);
    assert_eq!(core.inspector().model().unwrap().kind, Kind::Figure);
    let mut driver = Driver::new(element(&core, Theme::Light), SIZE, &styk_design::fonts::ALL);
    driver.redraw();

    // Drag X's label 20 px to the right: one gesture, one history entry.
    let snapshot = driver.snapshot();
    let label = snapshot.bounds.iter().find(|(id, _)| *id == label_id(PropertyKey::RootX)).map(|(_, bounds)| *bounds).expect("X's label is laid out");
    let start = Point::new(label.x + label.width / 2.0, label.y + label.height / 2.0);
    driver.point_at(start);
    driver.events(&[Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left))]);
    for step in 1..=4 {
        let at = Point::new(start.x + 5.0 * step as f32, start.y);
        driver.point_at(at);
        driver.events(&[Event::Mouse(mouse::Event::CursorMoved { position: at })]);
    }
    deliver(&mut core, &mut driver);
    assert_eq!(undo_depth(&core), 0, "the scrub is still open");
    driver.events(&[Event::Mouse(mouse::Event::ButtonReleased(mouse::Button::Left))]);
    deliver(&mut core, &mut driver);
    assert_eq!(undo_depth(&core), 1);
    assert!(value(&core, PropertyKey::RootX) > 480.0, "scrubbed right: {}", value(&core, PropertyKey::RootX));
    let scrubbed = value(&core, PropertyKey::RootX);
    let mut driver = rebuild(&core, driver);

    // Type a value into Y and press Enter: one entry, and the field leaves.
    driver.focus(input_id(PropertyKey::RootY));
    driver.events(&[]);
    deliver(&mut core, &mut driver);
    let mut driver = rebuild(&core, driver);
    driver.focus(input_id(PropertyKey::RootY));
    for _ in 0..3 {
        driver.tap(iced::keyboard::Key::Named(Named::Backspace), None);
    }
    driver.typewrite("300");
    deliver(&mut core, &mut driver);
    let mut driver = rebuild(&core, driver);
    driver.focus(input_id(PropertyKey::RootY));
    driver.press(Named::Enter);
    deliver(&mut core, &mut driver);
    assert_eq!(value(&core, PropertyKey::RootY), 300.0);
    assert_eq!(undo_depth(&core), 2);
    let mut driver = rebuild(&core, driver);

    // An arrow on the scale's label steps it once, released: one entry.
    driver.focus(label_id(PropertyKey::Scale));
    driver.press(Named::ArrowUp);
    driver.release(Named::ArrowUp);
    deliver(&mut core, &mut driver);
    assert_eq!(value(&core, PropertyKey::Scale), 101.0);
    assert_eq!(undo_depth(&core), 3);

    // Undo three times through the same message path the menu and shortcut use.
    for _ in 0..3 {
        let _ = update(&mut core, Message::Command(Command::Run(CommandId::Undo)));
    }
    assert_eq!((value(&core, PropertyKey::RootX), value(&core, PropertyKey::RootY), value(&core, PropertyKey::Scale)), (480.0, 280.0, 100.0));
    let _ = update(&mut core, Message::Command(Command::Run(CommandId::Redo)));
    assert_eq!(value(&core, PropertyKey::RootX), scrubbed);
    let driver = rebuild(&core, driver);
    drop(driver);
}

/// A scrub of a large selection's X, timed per pointer movement: the core's update (dispatch and refresh) and the
/// view (building the panel, laying it out and drawing it). Run with `STYK_TIMING_DOCUMENT=<a large .piv>` and
/// `--ignored --nocapture` in a release build; it needs a document from outside the repository.
#[test]
#[ignore = "needs STYK_TIMING_DOCUMENT, a large document from outside the repository"]
fn timing_a_scrub_of_a_large_selection() {
    use std::time::Instant;
    let path = std::env::var("STYK_TIMING_DOCUMENT").expect("STYK_TIMING_DOCUMENT names the document to time");
    let bytes = std::fs::read(&path).expect("the timing document is readable");
    let name = std::path::Path::new(&path).file_name().and_then(|name| name.to_str()).unwrap_or("timing.piv").to_owned();
    let opened = Instant::now();
    let mut core = styk_core::testing::core_with_document(&bytes, &name).unwrap();
    let open_ms = opened.elapsed().as_secs_f64() * 1000.0;
    let selected = styk_core::testing::select_all(&mut core).unwrap();
    assert_eq!(core.inspector().model().unwrap().kind, Kind::Figures);
    let mut driver = Driver::new(element(&core, Theme::Light), SIZE, &styk_design::fonts::ALL);
    let send = |core: &mut Core, event| {
        let _ = update(core, Message::Command(Command::Inspector(event)));
    };
    use styk_core::inspector::{Event as Panel, FieldEvent, Scrub};
    send(&mut core, Panel::Field(PropertyKey::GroupX, FieldEvent::Scrub(Scrub::Begin)));
    let (mut updates, mut views) = (Vec::new(), Vec::new());
    for _ in 0..60 {
        let started = Instant::now();
        send(&mut core, Panel::Field(PropertyKey::GroupX, FieldEvent::Scrub(Scrub::Delta { dx: 1.0, keys: Default::default() })));
        updates.push(started.elapsed().as_secs_f64() * 1000.0);
        let started = Instant::now();
        driver = driver.rebuild(element(&core, Theme::Light));
        let _ = driver.render(&styk_ui::base_theme(Theme::Light), iced::Color::WHITE, 1.0);
        views.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    send(&mut core, Panel::Field(PropertyKey::GroupX, FieldEvent::Scrub(Scrub::End)));
    assert_eq!(undo_depth(&core), 1, "one entry for the scrub");
    let summary = |name: &str, samples: &mut Vec<f64>| {
        samples.sort_by(f64::total_cmp);
        let at = |q: f64| samples[((samples.len() - 1) as f64 * q).round() as usize];
        println!("{name}: p50 {:.2} ms, p95 {:.2} ms, max {:.2} ms over {} moves", at(0.5), at(0.95), at(1.0), samples.len());
    };
    println!("{selected} figures selected; open {open_ms:.0} ms");
    summary("update (dispatch + refresh)", &mut updates);
    summary("view (build + layout + draw, software renderer)", &mut views);
}
