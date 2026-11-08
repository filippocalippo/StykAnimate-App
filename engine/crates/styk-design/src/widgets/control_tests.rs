//! Headless tests of the design system's controls, on the real widgets in the real tree ([`Driver`]).
//!
//! A slider's drag, keys and wheel, the number field's unit and width rules, the input role every input-like control
//! declares (through the shortcut routing, as the app uses it), the roving segmented group and the buttons' presses.

use super::badge::Chip;
use super::button::{Button, IconButton};
use super::color::ColorField;
use super::dir::Dir;
use super::field::EditField;
use super::number_field::{NumberField, value_width};
use super::parts::{Tab, Tabs, stepper};
use super::segmented::{Segment, Segmented};
use super::select::{Choice, Select};
use super::slider::{Slide, Slider};
use super::testing::Driver;
use super::toggle::{Checkbox, Checked, Radio, Switch};
use crate::Theme as DesignTheme;
use iced::keyboard::{Modifiers, key::Named};
use iced::widget::Column;
use iced::{Element, Event, Point, Size, Widget as _, mouse};
use styk_core::controls::{SliderKey, slider_value};
use styk_core::field::Role;
use styk_core::focus::{FocusArea, FocusId, FocusState, InputRole, ScopeId};
use styk_core::number::StepKeys;
use styk_core::shortcuts::{Platform, Press, Shortcuts};
use styk_core::text_entry::Chord;

const SLIDER: FocusId = FocusId(8);

#[derive(Clone, Debug, PartialEq)]
enum Msg {
    Slide(Slide),
    Toggle(bool),
    Pick(usize),
    Open(super::select::Open),
    Step(i32),
    Press(&'static str),
    Idle,
}

fn palette() -> &'static crate::Palette {
    DesignTheme::Light.palette()
}

fn driver(element: Element<'_, Msg>) -> Driver<'_, Msg> {
    Driver::new(element, Size::new(420.0, 700.0), &crate::fonts::ALL)
}

fn slider(value: f64, step: f64) -> Slider<'static, Msg> {
    Slider::new(SLIDER, FocusArea::Panels, palette(), value, (0.0, 100.0), step, Msg::Slide).width(220.0)
}

fn slides(messages: Vec<Msg>) -> Vec<Slide> {
    messages.into_iter().filter_map(|message| if let Msg::Slide(slide) = message { Some(slide) } else { None }).collect()
}

/// Where the slider is and the x of the thumb's centre for `value` in 0 to 100.
fn geometry(driver: &mut Driver<'_, Msg>) -> (iced::Rectangle, impl Fn(f64) -> f32 + use<>) {
    let bounds = driver.snapshot().bounds_of(SLIDER).expect("the slider is laid out");
    (bounds, move |value: f64| bounds.x + 7.0 + (value / 100.0) as f32 * (bounds.width - 14.0))
}

fn press_at(driver: &mut Driver<'_, Msg>, point: Point) {
    driver.point_at(point);
    driver.events(&[Event::Mouse(mouse::Event::CursorMoved { position: point }), Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left))]);
}

fn move_to(driver: &mut Driver<'_, Msg>, point: Point) {
    driver.point_at(point);
    driver.events(&[Event::Mouse(mouse::Event::CursorMoved { position: point })]);
}

fn release(driver: &mut Driver<'_, Msg>) {
    driver.events(&[Event::Mouse(mouse::Event::ButtonReleased(mouse::Button::Left))]);
}

#[test]
fn a_press_on_the_track_jumps_the_thumb_and_a_drag_follows_the_pointer_wherever_it_goes() {
    let mut driver = driver(slider(50.0, 1.0).into_element());
    let (bounds, thumb_x) = geometry(&mut driver);
    let y = bounds.y + bounds.height / 2.0;
    press_at(&mut driver, Point::new(thumb_x(20.0), y));
    assert_eq!(slides(driver.messages()), [Slide { value: 20.0, commit: false }], "a press on the track jumps to the pointer");
    move_to(&mut driver, Point::new(thumb_x(35.0), y));
    // Far outside the widget and the window: winit has captured the mouse, the value pins at the end.
    move_to(&mut driver, Point::new(bounds.x + bounds.width + 400.0, y + 300.0));
    let moved = slides(driver.messages());
    assert_eq!(moved, [Slide { value: 35.0, commit: false }, Slide { value: 100.0, commit: false }]);
    release(&mut driver);
    assert_eq!(slides(driver.messages()), [Slide { value: 100.0, commit: true }], "the release commits the last value once");
    move_to(&mut driver, Point::new(thumb_x(10.0), y));
    release(&mut driver);
    assert!(slides(driver.messages()).is_empty(), "nothing is reported after the gesture has ended");
}

#[test]
fn a_press_on_the_thumb_grabs_it_without_moving_it() {
    let mut driver = driver(slider(50.0, 1.0).into_element());
    let (bounds, thumb_x) = geometry(&mut driver);
    let y = bounds.y + bounds.height / 2.0;
    press_at(&mut driver, Point::new(thumb_x(50.0) + 5.0, y));
    assert!(slides(driver.messages()).is_empty(), "grabbing the thumb four pixels off its centre does not nudge the value");
    move_to(&mut driver, Point::new(thumb_x(60.0) + 5.0, y));
    assert_eq!(slides(driver.messages()), [Slide { value: 60.0, commit: false }], "the grab offset is kept");
    release(&mut driver);
    assert_eq!(slides(driver.messages()), [Slide { value: 60.0, commit: true }]);
}

#[test]
fn a_drag_snaps_to_the_step_and_stays_inside_the_range() {
    let mut driver = driver(slider(0.0, 5.0).into_element());
    let (bounds, thumb_x) = geometry(&mut driver);
    let y = bounds.y + bounds.height / 2.0;
    press_at(&mut driver, Point::new(thumb_x(0.0), y));
    driver.messages();
    for (value, expected) in [(12.0, 10.0), (13.0, 15.0), (99.0, 100.0)] {
        move_to(&mut driver, Point::new(thumb_x(value), y));
        assert_eq!(slides(driver.messages()).last().map(|slide| slide.value), Some(expected), "{value} snaps to {expected}");
    }
    move_to(&mut driver, Point::new(bounds.x - 300.0, y));
    assert_eq!(slides(driver.messages()).last().map(|slide| slide.value), Some(0.0), "left of the track is the minimum");
}

#[test]
fn a_right_to_left_slider_runs_from_the_right() {
    let mut driver = driver(slider(25.0, 1.0).dir(Dir::Rtl).into_element());
    let (bounds, _) = geometry(&mut driver);
    let y = bounds.y + bounds.height / 2.0;
    press_at(&mut driver, Point::new(bounds.x + bounds.width - 7.0 - 0.1 * (bounds.width - 14.0), y));
    assert_eq!(slides(driver.messages()).last().map(|slide| slide.value), Some(10.0), "a press near the right end asks for a low value");
}

#[test]
fn a_disabled_slider_takes_no_pointer_and_no_keys() {
    let mut driver = driver(slider(50.0, 1.0).disabled(true).into_element());
    let (bounds, thumb_x) = geometry(&mut driver);
    press_at(&mut driver, Point::new(thumb_x(80.0), bounds.y + bounds.height / 2.0));
    release(&mut driver);
    driver.focus(SLIDER);
    driver.press(Named::ArrowRight);
    assert!(driver.messages().is_empty());
}

#[test]
fn a_drag_whose_capture_was_lost_ends_once_with_the_value_it_had() {
    fn up() -> bool {
        false
    }
    let mut driver = driver(slider(50.0, 1.0).held(Some(up)).into_element());
    let (bounds, thumb_x) = geometry(&mut driver);
    let y = bounds.y + bounds.height / 2.0;
    press_at(&mut driver, Point::new(thumb_x(30.0), y));
    driver.messages();
    move_to(&mut driver, Point::new(thumb_x(40.0), y));
    let ended = slides(driver.messages());
    assert_eq!(ended, [Slide { value: 30.0, commit: true }], "the capture check ends the drag before the move is applied");
    move_to(&mut driver, Point::new(thumb_x(60.0), y));
    assert!(slides(driver.messages()).is_empty());
}

#[test]
fn the_window_losing_focus_ends_a_drag() {
    let mut driver = driver(slider(50.0, 1.0).into_element());
    let (bounds, thumb_x) = geometry(&mut driver);
    let y = bounds.y + bounds.height / 2.0;
    press_at(&mut driver, Point::new(thumb_x(70.0), y));
    driver.messages();
    driver.events(&[Event::Window(iced::window::Event::Unfocused)]);
    assert_eq!(slides(driver.messages()), [Slide { value: 70.0, commit: true }]);
}

#[test]
fn a_focused_slider_answers_its_keys_and_each_answer_is_final() {
    let mut driver = driver(slider(50.0, 1.0).into_element());
    driver.focus(SLIDER);
    let keys = StepKeys { shift: false, alt: false };
    for (named, key) in [
        (Named::ArrowRight, SliderKey::Increase),
        (Named::ArrowUp, SliderKey::Increase),
        (Named::ArrowLeft, SliderKey::Decrease),
        (Named::ArrowDown, SliderKey::Decrease),
        (Named::PageUp, SliderKey::PageUp),
        (Named::PageDown, SliderKey::PageDown),
        (Named::Home, SliderKey::Home),
        (Named::End, SliderKey::End),
    ] {
        driver.press(named);
        assert_eq!(slides(driver.messages()), [Slide { value: slider_value(50.0, 0.0, 100.0, 1.0, key, keys), commit: true }], "{named:?}");
    }
    driver.modifiers(Modifiers::SHIFT);
    driver.press(Named::ArrowRight);
    assert_eq!(slides(driver.messages()), [Slide { value: 50.1, commit: true }], "Shift takes a tenth of a step, as in number fields");
    driver.modifiers(Modifiers::ALT);
    driver.press(Named::ArrowRight);
    assert_eq!(slides(driver.messages()), [Slide { value: 50.01, commit: true }], "Alt takes a hundredth");
}

#[test]
fn keys_stay_inside_the_range_and_mirror_in_a_right_to_left_interface() {
    let mut driver = driver(slider(100.0, 1.0).into_element());
    driver.focus(SLIDER);
    driver.press(Named::ArrowRight);
    assert_eq!(slides(driver.messages()), [Slide { value: 100.0, commit: true }], "the maximum is not passed");
    let mut rtl = super::testing::Driver::new(slider(50.0, 1.0).dir(Dir::Rtl).into_element(), Size::new(420.0, 100.0), &crate::fonts::ALL);
    rtl.focus(SLIDER);
    rtl.press(Named::ArrowRight);
    assert_eq!(slides(rtl.messages()), [Slide { value: 49.0, commit: true }], "Right is toward the start in right-to-left");
}

#[test]
fn a_hovered_slider_that_is_not_focused_takes_no_keys() {
    let mut driver = driver(slider(50.0, 1.0).into_element());
    let (bounds, _) = geometry(&mut driver);
    driver.point_at(Point::new(bounds.x + 20.0, bounds.y + 10.0));
    driver.press(Named::ArrowRight);
    driver.press(Named::End);
    assert!(driver.messages().is_empty());
}

fn wheel(driver: &mut Driver<'_, Msg>, y: f32) {
    driver.events(&[Event::Mouse(mouse::Event::WheelScrolled { delta: mouse::ScrollDelta::Lines { x: 0.0, y } })]);
}

#[test]
fn the_wheel_does_nothing_unless_the_slider_asks_for_it_and_then_up_raises_the_value() {
    let mut plain = driver(slider(50.0, 1.0).into_element());
    let (bounds, _) = geometry(&mut plain);
    let over = Point::new(bounds.x + 30.0, bounds.y + 10.0);
    plain.point_at(over);
    wheel(&mut plain, 1.0);
    assert!(plain.messages().is_empty(), "a native range does not take the wheel");

    let mut driver = driver(slider(50.0, 1.0).wheel(5.0).into_element());
    driver.point_at(over);
    wheel(&mut driver, 1.0);
    wheel(&mut driver, -1.0);
    assert_eq!(slides(driver.messages()), [Slide { value: 55.0, commit: true }, Slide { value: 45.0, commit: true }]);
    driver.point_at(Point::new(bounds.x + 30.0, bounds.y + 300.0));
    wheel(&mut driver, 1.0);
    assert!(driver.messages().is_empty(), "a wheel away from the slider is not its");
}

#[test]
fn the_wheel_stops_at_the_ends() {
    let mut driver = driver(slider(98.0, 1.0).wheel(5.0).into_element());
    let (bounds, _) = geometry(&mut driver);
    driver.point_at(Point::new(bounds.x + 30.0, bounds.y + 10.0));
    wheel(&mut driver, 1.0);
    assert_eq!(slides(driver.messages()), [Slide { value: 100.0, commit: true }]);
}

#[test]
fn a_value_is_at_least_one_digit_wide_and_as_wide_as_its_text() {
    assert_eq!(value_width(""), value_width("0"), "an empty value holds one zero");
    assert!(value_width("1234") > value_width("12"), "a value is as wide as its text");
}

/// One of every input-like control and the controls that are not, in one tree.
fn every_control<'a>() -> Element<'a, Msg> {
    let palette = palette();
    let area = FocusArea::Panels;
    let mut column = Column::new().spacing(6.0);
    column = column
        .push(EditField::new(FocusId(1), area, Role::SingleLine, "name", palette).on_input(|_| Msg::Idle).into_element())
        .push(NumberField::new(FocusId(2), FocusId(3), area, "X", "12", palette).on_input(|_| Msg::Idle).on_scrub(|_| Msg::Idle).into_element())
        .push(Select::new(FocusId(4), area, palette, vec![Choice { label: "Linear".into(), disabled: false }, Choice { label: "Hold".into(), disabled: false }], Some(0), Msg::Open, Msg::Step).into_element())
        .push(Checkbox::new(FocusId(5), area, palette, Checked::No, Msg::Toggle).label("Visible").into_element())
        .push(Switch::new(FocusId(6), area, palette, false, Msg::Toggle).into_element())
        .push(Radio::new(FocusId(7), area, palette, true, Msg::Press("radio")).label("Linear").into_element())
        .push(slider(40.0, 1.0).into_element())
        .push(ColorField::new(FocusId(9), area, palette, [200, 80, 40], "C85028", Msg::Press("colour")).into_element())
        .push(Segmented::new(FocusId(10), area, palette, vec![Segment::text("One"), Segment::text("Two")], 0, Msg::Pick).into_element())
        .push(Segmented::new(FocusId(20), area, palette, vec![Segment::text("Animate"), Segment::text("Draw")], 0, Msg::Pick).buttons().into_element())
        .push(Button::new(FocusId(30), area, palette, "Export", Msg::Press("export")).into_element())
        .push(IconButton::new(FocusId(31), area, palette, "plus", Msg::Press("add")).into_element())
        .push(Chip::new(FocusId(32), area, palette, "Figures", Msg::Press("chip")).into_element())
        .push(Tabs::new(FocusId(40), area, palette, vec![Tab { label: "Props".into(), icon: None }, Tab { label: "Effects".into(), icon: None }], 0, |_| Msg::Idle).into_element())
        .push(stepper(palette, FocusId(50), area, "3", false, false, |_| Msg::Idle));
    column.width(300.0).boxed()
}

#[test]
fn every_input_like_control_declares_its_role_and_keeps_delete_from_the_document() {
    let mut driver = driver(every_control());
    let snapshot = driver.snapshot();
    let mut focus = FocusState::new();
    focus.register(ScopeId::ROOT, snapshot.targets(ScopeId::ROOT).to_vec());
    let delete = Chord::new("Delete", false, false, false);
    let press = |focus: &FocusState| Shortcuts::new(Platform::Control, true).press(focus, &delete, &[], styk_core::shortcuts::Input::default(), |_| true);
    // (focus id, what kind of control it is, the role it declares)
    for (id, kind, role) in [
        (1, "text field", InputRole::Text),
        (3, "number field's input", InputRole::Text),
        (4, "select", InputRole::Select),
        (5, "checkbox", InputRole::Checkbox),
        (6, "switch", InputRole::Checkbox),
        (7, "radio", InputRole::Radio),
        (8, "slider", InputRole::Other),
        (9, "colour field", InputRole::Other),
        (10, "radio segmented group, chosen item", InputRole::Radio),
        (11, "radio segmented group, other item", InputRole::Radio),
        (2, "number field's scrub label", InputRole::None),
        (20, "button segmented group", InputRole::None),
        (30, "button", InputRole::None),
        (31, "icon button", InputRole::None),
        (32, "chip", InputRole::None),
        (40, "tabs, shown tab", InputRole::Radio),
        (41, "tabs, other tab", InputRole::Radio),
        (50, "stepper's minus", InputRole::Text),
        (51, "stepper's plus", InputRole::Text),
    ] {
        focus.reconcile(Some(FocusId(id)));
        assert_eq!(focus.input_role(), role, "{kind} declares {role:?}");
        if role == InputRole::None {
            assert!(matches!(press(&focus), Press::Run(_)), "{kind} is not an input: Delete reaches the document");
        } else {
            assert_eq!(press(&focus), Press::Ignored, "{kind} owns Delete while focused");
        }
    }
}

#[test]
fn a_segmented_group_is_one_tab_stop_and_an_arrow_key_chooses_the_next_item() {
    let items = || vec![Segment::text("One"), Segment::text("Two"), Segment::text("Three").disabled(true)];
    let mut driver = driver(Segmented::new(FocusId(10), FocusArea::Panels, palette(), items(), 1, Msg::Pick).into_element());
    let stops: Vec<u64> = driver.snapshot().targets(ScopeId::ROOT).iter().filter(|target| target.enabled && target.tab_stop).map(|target| target.id.0).collect();
    assert_eq!(stops, [11], "the chosen item is the one stop");
    driver.focus(FocusId(11));
    driver.press(Named::ArrowLeft);
    assert_eq!(driver.messages(), [Msg::Pick(0)]);
    driver.press(Named::ArrowRight);
    assert_eq!(driver.messages(), [Msg::Pick(0)], "from the second item the disabled third is skipped and the group wraps to the first");
}

#[test]
fn a_press_on_a_button_needs_a_release_on_it_and_a_disabled_one_is_inert() {
    let build = |disabled: bool| Button::new(FocusId(30), FocusArea::Panels, palette(), "Export", Msg::Press("export")).disabled(disabled).into_element();
    let mut driver = driver(build(false));
    let bounds = driver.snapshot().bounds_of(FocusId(30)).expect("laid out");
    let inside = Point::new(bounds.x + 10.0, bounds.y + 10.0);
    press_at(&mut driver, inside);
    assert!(driver.messages().is_empty(), "nothing before the release");
    release(&mut driver);
    assert_eq!(driver.messages(), [Msg::Press("export")]);
    press_at(&mut driver, inside);
    move_to(&mut driver, Point::new(bounds.x + 400.0, bounds.y));
    release(&mut driver);
    assert!(driver.messages().is_empty(), "a press that ends elsewhere is not a click");
    let mut disabled = super::testing::Driver::new(build(true), Size::new(420.0, 100.0), &crate::fonts::ALL);
    press_at(&mut disabled, inside);
    release(&mut disabled);
    disabled.focus(FocusId(30));
    disabled.press(Named::Enter);
    assert!(disabled.messages().is_empty());
}

#[test]
fn enter_and_a_released_space_activate_a_focused_button() {
    let mut driver = driver(Button::new(FocusId(30), FocusArea::Panels, palette(), "Export", Msg::Press("export")).into_element());
    driver.focus(FocusId(30));
    driver.press(Named::Enter);
    assert_eq!(driver.messages(), [Msg::Press("export")]);
    driver.press(Named::Space);
    assert!(driver.messages().is_empty(), "Space activates on release");
    driver.release(Named::Space);
    assert_eq!(driver.messages(), [Msg::Press("export")]);
}

#[test]
fn a_switch_and_a_checkbox_ask_for_the_opposite_state_and_a_mixed_checkbox_asks_for_checked() {
    let mut driver = driver(
        Column::new()
            .push(Switch::new(FocusId(6), FocusArea::Panels, palette(), true, Msg::Toggle).into_element())
            .push(Checkbox::new(FocusId(5), FocusArea::Panels, palette(), Checked::Mixed, Msg::Toggle).into_element())
            .boxed(),
    );
    driver.focus(FocusId(6));
    driver.press(Named::Space);
    driver.release(Named::Space);
    assert_eq!(driver.messages(), [Msg::Toggle(false)]);
    driver.focus(FocusId(5));
    driver.press(Named::Space);
    driver.release(Named::Space);
    assert_eq!(driver.messages(), [Msg::Toggle(true)]);
}

#[test]
fn rgba_mix_is_css_color_mix_in_srgb() {
    let white = crate::Rgba::new(255, 255, 255, 1.0);
    let black = crate::Rgba::new(0, 0, 0, 1.0);
    assert_eq!(white.mix(50.0, black), crate::Rgba::new(128, 128, 128, 1.0));
    assert_eq!(white.mix(100.0, black), white);
    assert_eq!(white.faded(0.42).a, 0.42);
}

fn select_element<'a>() -> Element<'a, Msg> {
    let options = vec![Choice { label: "Linear".into(), disabled: false }, Choice { label: "Hold".into(), disabled: false }];
    Select::new(FocusId(4), FocusArea::Panels, palette(), options, Some(0), Msg::Open, Msg::Step).label("Easing").into_element()
}

#[test]
fn a_press_on_a_select_asks_the_owner_to_open_its_list_under_the_whole_field() {
    let mut driver = driver(select_element());
    let line = driver.snapshot().bounds_of(FocusId(4)).expect("the select is laid out");
    driver.click(Point::new(line.x + 60.0, line.y + line.height / 2.0));
    let opened = driver.messages();
    let [Msg::Open(open)] = opened.as_slice() else { panic!("one request: {opened:?}") };
    assert!(!open.keyboard, "a press asked");
    assert_eq!(open.anchor.height, super::frame::HEIGHT, "the anchor is the field, not its inner line");
    assert!(open.anchor.x < line.x && open.anchor.x + open.anchor.width > line.x + line.width, "and it is wider than the line inside the frame's padding");
}

#[test]
fn space_enter_and_alt_down_open_a_focused_select_and_plain_arrows_step_it() {
    let mut driver = driver(select_element());
    driver.focus(FocusId(4));
    driver.press(Named::Space);
    driver.press(Named::Enter);
    driver.modifiers(iced::keyboard::Modifiers::ALT);
    driver.press(Named::ArrowDown);
    driver.modifiers(iced::keyboard::Modifiers::default());
    let messages = driver.messages();
    assert_eq!(messages.len(), 3, "{messages:?}");
    assert!(messages.iter().all(|message| matches!(message, Msg::Open(open) if open.keyboard)), "each asked by the keyboard: {messages:?}");
    driver.press(Named::ArrowDown);
    assert_eq!(driver.messages(), [Msg::Step(1)], "without Alt the arrow steps the value");
}

#[test]
fn an_unfocused_select_ignores_the_opening_keys() {
    let mut driver = driver(select_element());
    driver.press(Named::Space);
    driver.press(Named::Enter);
    assert!(driver.messages().is_empty());
}

#[test]
fn a_focused_select_asks_for_the_neighbouring_option_with_the_arrow_keys_and_a_disabled_one_is_inert() {
    let mut driver = driver(select_element());
    driver.focus(FocusId(4));
    driver.press(Named::ArrowDown);
    driver.press(Named::ArrowUp);
    assert_eq!(driver.messages(), [Msg::Step(1), Msg::Step(-1)]);
    let options = vec![Choice { label: "Linear".into(), disabled: false }, Choice { label: "Hold".into(), disabled: false }];
    let off = Select::new(FocusId(4), FocusArea::Panels, palette(), options, Some(0), Msg::Open, Msg::Step).disabled(true).into_element();
    let mut disabled = super::testing::Driver::new(off, Size::new(420.0, 300.0), &crate::fonts::ALL);
    let bounds = disabled.snapshot().bounds_of(FocusId(4)).expect("laid out");
    disabled.click(Point::new(bounds.x + 60.0, bounds.y + 10.0));
    disabled.redraw();
    disabled.click(Point::new(bounds.x + 60.0, bounds.y + bounds.height + 14.0));
    disabled.focus(FocusId(4));
    disabled.press(Named::ArrowDown);
    assert!(disabled.messages().is_empty());
}

fn labelled<'a>(radio: bool) -> Element<'a, Msg> {
    if radio {
        Radio::new(FocusId(7), FocusArea::Panels, palette(), false, Msg::Press("radio")).label("Linear").into_element()
    } else {
        Checkbox::new(FocusId(5), FocusArea::Panels, palette(), Checked::No, Msg::Toggle).label("Visible").into_element()
    }
}

#[test]
fn a_click_on_a_checks_or_radios_label_focuses_it_so_space_and_delete_are_its_own() {
    for (radio, id, role) in [(false, FocusId(5), InputRole::Checkbox), (true, FocusId(7), InputRole::Radio)] {
        let mut driver = driver(labelled(radio));
        let bounds = driver.snapshot().bounds_of(id).expect("the control is laid out");
        // The words start 24 px in, after the 16 px box and the 8 px gap: 40 px in is on them, not on the box.
        let on_the_words = Point::new(bounds.x + 40.0, bounds.y + bounds.height / 2.0);
        driver.click(on_the_words);
        let first = driver.messages();
        assert_eq!(first.len(), 1, "a click on the words presses the control once: {first:?}");
        let snapshot = driver.snapshot();
        assert_eq!(snapshot.focused, Some(id), "the click focused the control");
        driver.press(Named::Space);
        driver.release(Named::Space);
        assert_eq!(driver.messages(), first, "Space activates it again");
        let mut focus = FocusState::new();
        focus.register(ScopeId::ROOT, snapshot.targets(ScopeId::ROOT).to_vec());
        focus.reconcile(snapshot.focused);
        assert_eq!(focus.input_role(), role);
        let delete = Chord::new("Delete", false, false, false);
        let press = Shortcuts::new(Platform::Control, true).press(&focus, &delete, &[], styk_core::shortcuts::Input::default(), |_| true);
        assert_eq!(press, Press::Ignored, "Delete stays with the focused control");
    }
}

#[test]
fn a_labelled_control_is_one_focus_target() {
    let mut driver = driver(labelled(false));
    let targets: Vec<u64> = driver.snapshot().targets(ScopeId::ROOT).iter().map(|target| target.id.0).collect();
    assert_eq!(targets, [5]);
}
