//! The developer panels' views mounted in the toolkit's headless interface: a pointer click or a key reaches the widget, its
//! message goes through the application's real handler (`TopBand::update`, `Core::dispatch`, the extension effect, the host)
//! and the worker's real wake, and the test reads what the host and the rendered layer ended up holding.
use super::*;
use iced::Widget as _;
use iced::keyboard::{Key, key::Named};
use styk_core::dev_extension::{Panel, ids};
use styk_devtools::ui::{logs as logs_view, parameters as parameters_view, profiler as profiler_view};

fn mounted(top: &TopBand) -> Driver<'_, Message> {
    let element = iced::widget::stack![top.dock_view(Theme::Light), top.developer_overlay(Theme::Light)].boxed();
    Driver::new(element, Size::new(1560., 900.), &styk_design::fonts::ALL)
}

/// The messages a gesture on the mounted panel made, on a tree built from the host's current state.
fn gesture(top: &TopBand, act: impl FnOnce(&mut Driver<'_, Message>, &styk_design::widgets::focus::Snapshot)) -> Vec<Message> {
    let mut view = mounted(top);
    view.redraw();
    let snapshot = view.snapshot();
    act(&mut view, &snapshot);
    view.messages()
}

fn control(panel: Panel, slot: u64) -> styk_core::focus::FocusId {
    ids::slot(panel, slot)
}

/// A click on the centre of the control, as the pointer makes it.
fn click(top: &mut TopBand, driver: &mut Driver<'static, Message>, panel: Panel, slot: u64) {
    let id = control(panel, slot);
    let messages = gesture(top, |view, snapshot| {
        let bounds = snapshot.bounds_of(id).unwrap_or_else(|| panic!("control {slot} of {panel:?} is mounted"));
        view.click(bounds.center());
    });
    assert!(!messages.is_empty(), "a click on control {slot} of {panel:?} made no message");
    for message in messages {
        deliver(top, driver, message);
    }
}

/// Types `text` into the field one character at a time, rebuilding the tree from the host's state after each, as the runtime does.
fn type_into(top: &mut TopBand, driver: &mut Driver<'static, Message>, panel: Panel, slot: u64, text: &str) {
    let id = control(panel, slot);
    for c in text.chars() {
        let s = c.to_string();
        // A click at the end of the text puts the caret there, as a person who continues typing has it.
        let messages = gesture(top, |view, snapshot| {
            let bounds = snapshot.bounds_of(id).unwrap_or_else(|| panic!("field {slot} of {panel:?} is mounted"));
            view.click(iced::Point::new(bounds.x + bounds.width - 6.0, bounds.center_y()));
            view.tap(Key::Character(s.clone().into()), Some(&s));
        });
        assert!(!messages.is_empty(), "typing {c:?} made no message");
        for message in messages {
            deliver(top, driver, message);
        }
    }
}

fn press_enter(top: &mut TopBand, driver: &mut Driver<'static, Message>, panel: Panel, slot: u64) {
    let id = control(panel, slot);
    let messages = gesture(top, |view, _| {
        view.focus(id);
        view.press(Named::Enter);
    });
    assert!(!messages.is_empty(), "Enter in the field made no message");
    for message in messages {
        deliver(top, driver, message);
    }
}

/// Delivers the sample the host is due, then the worker's real wakes, until the host holds what the test waits for.
fn until(top: &mut TopBand, clock: &FixedClock, driver: &mut Driver<'static, Message>, done: impl Fn(&styk_devtools::panels::Host) -> bool) {
    deadline(top, clock, driver);
    for _ in 0..16 {
        if done(host(top)) {
            return;
        }
        let message = wake_message(top);
        deliver(top, driver, message);
    }
    panic!("the host never reached the awaited state");
}

fn host(top: &TopBand) -> &styk_devtools::panels::Host {
    top.developer.as_ref().expect("a developer host")
}

#[test]
fn view_profiler_buttons_start_stop_and_export_reach_the_core() {
    let _serial = CAPTURE_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let output = Arc::new(ExportProbe::default());
    let (mut top, clock, _runtime, mut driver) = setup_with_services(None, Arc::new(Default::default()), output.clone());
    panel(&mut top, &mut driver, Panel::Profiler, true);

    click(&mut top, &mut driver, Panel::Profiler, profiler_view::START);
    settle(&mut top, &mut driver);
    assert!(host(&top).profiler.recording, "Start reached the capture controller");

    click(&mut top, &mut driver, Panel::Profiler, profiler_view::STOP);
    stopped(&mut top, &clock, &mut driver);
    assert!(!host(&top).profiler.recording && host(&top).profiler.can_export, "Stop ended the capture and kept it for export");

    click(&mut top, &mut driver, Panel::Profiler, profiler_view::EXPORT);
    assert_eq!(host(&top).input, Some(CommandId::DevCaptureExport), "Export asked for its file through the registered command");
    type_into(&mut top, &mut driver, Panel::Profiler, profiler_view::PATH, "capture.json");
    assert_eq!(host(&top).draft, "capture.json", "typed text reached the host's draft");
    click(&mut top, &mut driver, Panel::Profiler, profiler_view::CONFIRM);
    settle(&mut top, &mut driver);
    assert!(host(&top).error.is_none(), "the export was accepted: {:?}", host(&top).error);
    assert_eq!(host(&top).input, None, "an accepted export retires its request");
    assert!(!output.bytes.lock().unwrap_or_else(|e| e.into_inner()).is_empty(), "the Perfetto file reached the output service");
}

#[test]
fn view_export_enter_and_cancel_reach_the_core() {
    let _serial = CAPTURE_TEST.lock().unwrap_or_else(|e| e.into_inner());
    let output = Arc::new(ExportProbe::default());
    let (mut top, clock, _runtime, mut driver) = setup_with_services(None, Arc::new(Default::default()), output.clone());
    panel(&mut top, &mut driver, Panel::Profiler, true);
    click(&mut top, &mut driver, Panel::Profiler, profiler_view::START);
    settle(&mut top, &mut driver);
    click(&mut top, &mut driver, Panel::Profiler, profiler_view::STOP);
    stopped(&mut top, &clock, &mut driver);

    click(&mut top, &mut driver, Panel::Profiler, profiler_view::EXPORT);
    type_into(&mut top, &mut driver, Panel::Profiler, profiler_view::PATH, "x");
    click(&mut top, &mut driver, Panel::Profiler, profiler_view::CANCEL);
    assert_eq!(host(&top).input, None, "Cancel withdrew the request");
    assert_eq!(host(&top).draft, "", "and its draft");

    click(&mut top, &mut driver, Panel::Profiler, profiler_view::EXPORT);
    type_into(&mut top, &mut driver, Panel::Profiler, profiler_view::PATH, "again.json");
    press_enter(&mut top, &mut driver, Panel::Profiler, profiler_view::PATH);
    settle(&mut top, &mut driver);
    assert!(host(&top).error.is_none(), "{:?}", host(&top).error);
    assert!(!output.bytes.lock().unwrap_or_else(|e| e.into_inner()).is_empty(), "Enter in the field exported the capture");
}

#[test]
fn view_parameter_step_and_reset_are_acknowledged() {
    let (mut top, _clock, _runtime, mut driver) = setup();
    panel(&mut top, &mut driver, Panel::Parameters, true);
    settle(&mut top, &mut driver);
    let row = |top: &TopBand| host(top).parameters.rows[0].clone();
    assert_eq!(row(&top).descriptor.name, "capture.cap_mb");
    assert_eq!(row(&top).effective, ParameterValue::from(24), "the startup override is the effective value");
    assert!(row(&top).modified);

    click(&mut top, &mut driver, Panel::Parameters, parameters_view::control(0) + 1);
    settle(&mut top, &mut driver);
    assert_eq!(row(&top).effective, ParameterValue::from(25), "the setter acknowledged the step");
    assert!(host(&top).error.is_none());

    click(&mut top, &mut driver, Panel::Parameters, parameters_view::reset(0));
    settle(&mut top, &mut driver);
    assert_eq!(row(&top).effective, ParameterValue::from(8), "reset returned the registered default");
    assert!(!row(&top).modified);
}

#[test]
fn view_log_filter_level_and_text_apply_in_the_worker() {
    let (mut top, clock, runtime, mut driver) = setup();
    runtime.logs.record(0, 3, "alpha::one", format_args!("first"));
    runtime.logs.record(0, 1, "alpha::two", format_args!("second"));
    runtime.logs.record(0, 3, "beta::three", format_args!("third"));
    panel(&mut top, &mut driver, Panel::Logs, true);
    until(&mut top, &clock, &mut driver, |host| host.logs.page.total == 3);
    assert_eq!(host(&top).logs.page.total, 3, "every line before a filter");

    type_into(&mut top, &mut driver, Panel::Logs, logs_view::MODULE, "alpha");
    assert_eq!(host(&top).logs.filter.module, "alpha", "typing reached the host's filter");
    until(&mut top, &clock, &mut driver, |host| host.logs.page.total == 2);
    let modules: Vec<_> = host(&top).logs.page.lines.iter().map(|line| line.module.clone()).collect();
    assert_eq!(modules, ["alpha::one", "alpha::two"], "the worker applied the module filter");

    click(&mut top, &mut driver, Panel::Logs, logs_view::LEVEL + 1);
    assert_eq!(host(&top).logs.filter.level, 1, "the Error chip set the level");
    until(&mut top, &clock, &mut driver, |host| host.logs.page.total == 1);
    let texts: Vec<_> = host(&top).logs.page.lines.iter().map(|line| line.text.clone()).collect();
    assert_eq!(texts, ["second"], "the worker applied the level filter on top");
}

#[test]
fn view_overlay_is_drawn_at_the_stage_and_takes_no_input() {
    let (mut top, _clock, _runtime, mut driver) = setup();
    let background = iced::Color::from_rgb8(255, 0, 255);
    let pixel = |view: &mut Driver<'_, Message>, x: f64, y: f64| {
        let (rgba, size) = view.render(&iced::Theme::Light, background, 1.0);
        let at = ((y as u32 * size.width + x as u32) * 4) as usize;
        [rgba[at], rgba[at + 1], rgba[at + 2]]
    };
    let magenta = [255, 0, 255];

    send(&mut top, &mut driver, Dev::Overlay(true));
    let bounds = host(&top).overlay.bounds.expect("the dock solved a stage");
    assert!(host(&top).overlay.visible);
    let (inside, outside) = ((bounds.x + 24.0, bounds.y + 24.0), (bounds.x + 4.0, bounds.y + 4.0));
    {
    let mut overlay = Driver::new(top.developer_overlay(Theme::Light), Size::new(1560., 900.), &styk_design::fonts::ALL);
    assert_ne!(pixel(&mut overlay, inside.0, inside.1), magenta, "the card is drawn inside the stage's corner");
    assert_eq!(pixel(&mut overlay, outside.0, outside.1), magenta, "and starts after the inset, over the stage's own rectangle");

    // A button under the card still gets the press: the overlay is input-transparent.
    let under = iced::widget::button(iced::widget::space().width(iced::Length::Fill).height(iced::Length::Fill)).on_press(Message::Frame).width(iced::Length::Fill).height(iced::Length::Fill);
    let mut stacked = Driver::new(iced::widget::stack![under, top.developer_overlay(Theme::Light)].boxed(), Size::new(1560., 900.), &styk_design::fonts::ALL);
    stacked.redraw();
    stacked.click(iced::Point::new(inside.0 as f32, inside.1 as f32));
    assert!(stacked.messages().iter().any(|message| matches!(message, Message::Frame)), "the press went through the card");
    }

    send(&mut top, &mut driver, Dev::Overlay(false));
    let mut hidden = Driver::new(top.developer_overlay(Theme::Light), Size::new(1560., 900.), &styk_design::fonts::ALL);
    assert_eq!(pixel(&mut hidden, inside.0, inside.1), magenta, "a hidden overlay draws nothing");
}
