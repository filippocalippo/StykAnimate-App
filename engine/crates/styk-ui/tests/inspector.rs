//! The Properties panel headless: every catalogue context drawn in both themes, the panel's interaction script
//! (`inspector.auto`, the app's automation language) run through the real widgets, and the focus contract driven by
//! keys. The scored comparison with today's panel is the screen catalogue's (`docs/native/screens/limits.toml`,
//! `cargo xtask check`).
use iced::keyboard::key::Named;
use iced::mouse;
use iced::{Event, Point, Size};
use styk_core::app::Core;
use styk_core::automation::{Expect, InspectorStep, Script, Step, Target};
use styk_core::commands::{Command, CommandId, Effect};
use styk_core::inspector::property::PropertyKey;
use styk_core::inspector::{Event as Panel, FieldEvent, FocusRequest, RenameEvent};
use styk_core::number::format;
use styk_core::screens::InspectorScreen;
use styk_design::Theme;
use styk_design::widgets::focus;
use styk_design::widgets::testing::Driver;
use styk_ui::inspector::{self, RENAME_ID, TARGET_NAME_ID, View, input_id, label_id};
use styk_ui::message::{Message, update};

const STARTUP: &[u8] = include_bytes!("../../../tests/edit/startup.document.json");
const SCRIPT: &str = include_str!("inspector.auto");
const SIZE: Size = Size::new(styk_ui::dock::DEFAULT_WIDTH, 502.0);

fn screen_core(context: InspectorScreen) -> Core {
    styk_core::screens::inspector(context, std::sync::Arc::new(styk_platform::spawn::ThreadSpawner), std::sync::Arc::new(|| {})).unwrap()
}

fn element(core: &Core, theme: Theme) -> iced::Element<'static, Message> {
    let panel = core.inspector();
    let view = inspector::view(View { model: panel.model().unwrap(), presentation: core.presentation(), field: panel.field(), rename: panel.rename(), theme, button_probe: None });
    styk_ui::dock::docked(view, theme)
}

/// Delivers every message the interface published to the core, as the application's `update` does.
fn deliver(core: &mut Core, driver: &mut Driver<'static, Message>) {
    for message in driver.messages() {
        // The tasks are the runtime's; the test carries out the focus ones it needs through the driver.
        let _ = update(core, message);
    }
}

fn value(core: &Core, key: PropertyKey) -> f64 {
    core.inspector().model().unwrap().number(key).unwrap().value
}

fn tab_event() -> Event {
    Event::Keyboard(iced::keyboard::Event::KeyPressed {
        key: iced::keyboard::Key::Named(Named::Tab),
        modified_key: iced::keyboard::Key::Named(Named::Tab),
        physical_key: iced::keyboard::key::Physical::Unidentified(iced::keyboard::key::NativeCode::Unidentified),
        location: iced::keyboard::Location::Standard,
        modifiers: iced::keyboard::Modifiers::default(),
        repeat: false,
        text: None,
    })
}

#[test]
fn every_catalogue_context_draws_in_both_themes() {
    for context in InspectorScreen::ALL {
        let mut core = screen_core(context);
        if context == InspectorScreen::Figures {
            for _ in 0..200_000 {
                core.refresh();
                if core.inspector().shown().bounds.is_some() {
                    break;
                }
                std::thread::yield_now();
            }
            assert!(core.inspector().shown().bounds.is_some(), "the facts lane delivered the bounds");
        }
        for theme in [Theme::Light, Theme::Dark] {
            let mut driver = Driver::new(element(&core, theme), SIZE, &styk_design::fonts::ALL);
            let (pixels, size) = driver.render(&styk_ui::base_theme(theme), iced::Color::from(theme.palette().surface_field), 1.0);
            assert_eq!(pixels.len(), (size.width * size.height * 4) as usize);
            let distinct = pixels.chunks(4).map(|p| [p[0], p[1], p[2]]).collect::<std::collections::HashSet<_>>().len();
            assert!(distinct > 16, "{} {theme:?} drew its controls ({distinct} colours)", context.name());
        }
    }
}

/// Runs the panel's automation script through the widgets: a scrub is a drag of the label from its laid-out bounds,
/// a typed value is focus, keys and Enter in the input, a step is an arrow on the focused label.
#[test]
fn the_interaction_script_runs_through_the_widgets() {
    let script = Script::parse(SCRIPT).unwrap();
    let mut core = styk_core::testing::core_with_document(STARTUP, "Test.styk", std::sync::Arc::new(styk_platform::spawn::ThreadSpawner)).unwrap();
    let mut driver = Driver::new(element(&core, Theme::Light), SIZE, &styk_design::fonts::ALL);
    driver.redraw();
    let key = |name: &str| PropertyKey::from_id(name).unwrap_or_else(|| panic!("{name} is a property"));
    for (line, step) in script.steps {
        driver = driver.rebuild(element(&core, Theme::Light));
        driver.redraw();
        match step {
            Step::Select { uids, joint } => {
                let args = match uids.as_slice() {
                    [] => "[null,-1]".to_string(),
                    [uid] => format!("[{uid},{joint}]"),
                    many => format!("[[{}]]", many.iter().map(u32::to_string).collect::<Vec<_>>().join(",")),
                };
                styk_core::testing::call(&mut core, if uids.len() > 1 { "selectMany" } else { "select" }, &args).unwrap();
            }
            Step::Inspector(InspectorStep::Scrub { key: name, dx }) => {
                let label = driver.snapshot().bounds.iter().find(|(id, _)| *id == label_id(key(&name))).map(|(_, bounds)| *bounds).unwrap_or_else(|| panic!("line {line}: {name}'s label is laid out"));
                let start = Point::new(label.x + label.width / 2.0, label.y + label.height / 2.0);
                driver.point_at(start);
                driver.events(&[Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left))]);
                for step in 1..=4 {
                    let at = Point::new(start.x + dx as f32 * step as f32 / 4.0, start.y);
                    driver.point_at(at);
                    driver.events(&[Event::Mouse(mouse::Event::CursorMoved { position: at })]);
                }
                driver.events(&[Event::Mouse(mouse::Event::ButtonReleased(mouse::Button::Left))]);
                deliver(&mut core, &mut driver);
            }
            Step::Inspector(InspectorStep::Type { key: name, text }) => {
                driver.focus(input_id(key(&name)));
                driver.events(&[]);
                deliver(&mut core, &mut driver);
                driver = driver.rebuild(element(&core, Theme::Light));
                driver.focus(input_id(key(&name)));
                for _ in 0..12 {
                    driver.tap(iced::keyboard::Key::Named(Named::Backspace), None);
                }
                driver.typewrite(&text);
                deliver(&mut core, &mut driver);
                driver = driver.rebuild(element(&core, Theme::Light));
                driver.focus(input_id(key(&name)));
                driver.press(Named::Enter);
                deliver(&mut core, &mut driver);
            }
            Step::Inspector(InspectorStep::Step { key: name, up }) => {
                driver.focus(label_id(key(&name)));
                let arrow = if up { Named::ArrowUp } else { Named::ArrowDown };
                driver.press(arrow);
                driver.release(arrow);
                deliver(&mut core, &mut driver);
            }
            Step::Click(Target::Undo) => drop(update(&mut core, Message::Command(Command::Run(CommandId::Undo)))),
            Step::Click(Target::Redo) => drop(update(&mut core, Message::Command(Command::Run(CommandId::Redo)))),
            Step::Expect(Expect::Property(name, expected)) => assert_eq!(format(value(&core, key(&name)), 3), expected, "line {line}: {name}"),
            Step::Expect(Expect::History(entries)) => assert_eq!(styk_core::testing::undo_depth(&core), entries, "line {line}: history"),
            other => panic!("line {line}: the panel's runner has no {other:?}"),
        }
    }
}

/// The focus contract with keys: Tab reaches the switches, selects and the renamable name through the core's focus
/// state; Space toggles a switch, an arrow steps a select; Enter on the name opens the rename field with focus, and
/// committing brings focus back to the name.
#[test]
fn tab_reaches_every_control_and_rename_moves_focus_in_and_out() {
    let mut core = styk_core::testing::core_with_document(STARTUP, "Test.styk", std::sync::Arc::new(styk_platform::spawn::ThreadSpawner)).unwrap();
    styk_core::testing::call(&mut core, "select", "[1,1]").unwrap();
    let mut driver = Driver::new(element(&core, Theme::Light), SIZE, &styk_design::fonts::ALL);
    driver.redraw();
    let _ = update(&mut core, Message::Snapshot(driver.snapshot()));
    // Walk the panel with Tab as the application does: the key reaches no widget, the core's focus state moves focus
    // and the runtime (the driver here) carries out the focus operation it answers.
    let tab = tab_event();
    let (mut toggled, mut stepped, mut visited) = (false, false, Vec::new());
    for _ in 0..64 {
        let Some(id) = focus::navigate(core.focus_mut(), &tab) else { break };
        if visited.contains(&id) {
            break;
        }
        visited.push(id);
        driver.focus(id);
        driver.press(Named::Space);
        driver.release(Named::Space);
        driver.press(Named::ArrowDown);
        for message in driver.messages() {
            match message {
                Message::Command(Command::Inspector(Panel::Toggle(..))) => toggled = true,
                Message::Command(Command::Inspector(Panel::ChooseStep(..))) => stepped = true,
                _ => {}
            }
        }
    }
    assert!(toggled, "a switch is a Tab stop that Space toggles");
    assert!(stepped, "a select is a Tab stop that an arrow steps");

    styk_core::testing::call(&mut core, "select", "[1,-1]").unwrap();
    let mut driver = Driver::new(element(&core, Theme::Light), SIZE, &styk_design::fonts::ALL);
    driver.redraw();
    let _ = update(&mut core, Message::Snapshot(driver.snapshot()));
    let mut reached = false;
    for _ in 0..64 {
        let Some(id) = focus::navigate(core.focus_mut(), &tab) else { break };
        driver.focus(id);
        if id == TARGET_NAME_ID {
            reached = true;
            break;
        }
    }
    assert!(reached, "the name is a Tab stop");
    driver.press(Named::Enter);
    assert!(driver.messages().contains(&Message::Command(Command::Inspector(Panel::Rename(RenameEvent::Begin)))), "Enter on the name renames");
    let effects = core.dispatch(Command::Inspector(Panel::Rename(RenameEvent::Begin)));
    core.refresh();
    assert!(effects.contains(&Effect::Focus(FocusRequest::Rename)), "renaming asks for focus in the field: {effects:?}");
    let mut driver = driver.rebuild(element(&core, Theme::Light));
    driver.focus(RENAME_ID);
    assert_eq!(driver.snapshot().focused, Some(RENAME_ID));
    for _ in 0..8 {
        driver.tap(iced::keyboard::Key::Named(Named::Backspace), None);
    }
    driver.typewrite("Walker");
    for message in driver.messages() {
        if let Message::Command(command) = message {
            let _ = core.dispatch(command);
        }
    }
    let effects = core.dispatch(Command::Inspector(Panel::Rename(RenameEvent::Commit)));
    core.refresh();
    assert!(effects.contains(&Effect::Focus(FocusRequest::TargetName)), "focus comes back to the name: {effects:?}");
    assert_eq!(core.inspector().model().unwrap().target.name, styk_core::i18n::Label::plain("Walker"));
    let mut driver = driver.rebuild(element(&core, Theme::Light));
    driver.focus(TARGET_NAME_ID);
    assert_eq!(driver.snapshot().focused, Some(TARGET_NAME_ID));
}

/// A scrub on a large selection, timed per pointer movement: the core's update (dispatch and refresh) and the view
/// (building the panel, laying it out and drawing it). Run with `STYK_TIMING_DOCUMENT=<a large .piv>` and
/// `--ignored --nocapture` in a release build; it needs a document from outside the repository.
#[test]
#[ignore = "needs STYK_TIMING_DOCUMENT, a large document from outside the repository"]
fn timing_a_scrub_of_a_large_selection() {
    use std::time::Instant;
    let path = std::env::var("STYK_TIMING_DOCUMENT").expect("STYK_TIMING_DOCUMENT names the document to time");
    let bytes = std::fs::read(&path).expect("the timing document is readable");
    let name = std::path::Path::new(&path).file_name().and_then(|name| name.to_str()).unwrap_or("timing.piv").to_owned();
    let opened = Instant::now();
    let mut core = styk_core::testing::core_with_document(&bytes, &name, std::sync::Arc::new(styk_platform::spawn::ThreadSpawner)).unwrap();
    let open_ms = opened.elapsed().as_secs_f64() * 1000.0;
    let selected = styk_core::testing::select_all(&mut core).unwrap();
    styk_core::testing::settle_facts(&mut core).unwrap();
    let mut driver = Driver::new(element(&core, Theme::Light), SIZE, &styk_design::fonts::ALL);
    let send = |core: &mut Core, event| {
        let _ = update(core, Message::Command(Command::Inspector(event)));
    };
    use styk_core::inspector::Scrub;
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
    assert_eq!(styk_core::testing::undo_depth(&core), 1, "one entry for the scrub");
    let summary = |name: &str, samples: &mut Vec<f64>| {
        samples.sort_by(f64::total_cmp);
        let at = |q: f64| samples[((samples.len() - 1) as f64 * q).round() as usize];
        println!("{name}: p50 {:.2} ms, p95 {:.2} ms, max {:.2} ms over {} moves", at(0.5), at(0.95), at(1.0), samples.len());
    };
    println!("{selected} figures selected; open {open_ms:.0} ms");
    summary("update (dispatch + refresh)", &mut updates);
    summary("view (build + layout + draw, software renderer)", &mut views);
}
