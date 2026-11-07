//! Headless tests of the focus, field and scrub widgets, on the explicit-effect [`Driver`].
//!
//! The page below is the smallest app around the widgets: it owns the `FocusState` and the field values, turns the
//! widgets' messages into model changes, rebuilds the view, reads the tree's focus back (`snapshot`) and runs the
//! focus tasks the core asks for. Nothing here is a mock of a widget: the widgets are the real ones, in the real tree.

use super::dir::Dir;
use super::field::EditField;
use super::focus::{self, Focusable, Ring, Scope};
use super::number_field::{NumberField, Scrub};
use super::roving::{RovingGroup, RovingItem};
use super::testing::Driver;
use crate::{Theme as DesignTheme, tokens};
use iced::keyboard::{Key, Modifiers, key::Named};
use iced::widget::{Column, Stack, text};
use iced::{Element, Event, Length, Point, Size, Widget as _, mouse};
use iced_test::core::clipboard::Content;
use std::sync::Arc;
use std::time::{Duration, Instant};
use styk_core::field::{FieldValue, Role};
use styk_core::focus::{FocusArea, FocusId, FocusState, ScopeId, TargetKind};
use styk_core::number::{self, Baseline, StepKeys};
use styk_core::roving::Orientation;

const MODAL: ScopeId = ScopeId(7);

#[derive(Clone, Debug, PartialEq)]
enum Msg {
    Input(usize, String),
    Enter(usize),
    Escape(usize),
    Focus(usize, bool),
    Compose(usize, bool),
    Scrub(Scrub),
    NumberEnter,
    NumberEscape,
    NumberInput(String),
    Press(&'static str),
    Move(usize),
}

struct Page {
    dir: Dir,
    fields: Vec<FieldValue>,
    limit: Option<usize>,
    /// Replaces every field's limits (the role's single-line rule still applies).
    limits: Option<styk_core::limits::Limits>,
    /// The first field is disabled.
    first_disabled: bool,
    /// The first field's focus ID: changing it replaces the field by another at the same place in the tree.
    first_id: u64,
    number_enabled: bool,
    show_number: bool,
    show_second_field: bool,
    focus: FocusState,
    number: f64,
    number_text: FieldValue,
    baseline: Baseline,
    scrub_start: f64,
    scrubs: Vec<Scrub>,
    active: usize,
    modal: bool,
    log: Vec<Msg>,
}

impl Page {
    fn new(dir: Dir) -> Page {
        Page {
            dir,
            fields: vec![FieldValue::new(""), FieldValue::new(""), FieldValue::new("")],
            limit: None,
            limits: None,
            first_disabled: false,
            first_id: 10,
            number_enabled: true,
            show_number: true,
            show_second_field: true,
            focus: FocusState::new(),
            number: 10.0,
            number_text: FieldValue::new("10"),
            baseline: Baseline::new(10.0),
            scrub_start: 10.0,
            scrubs: Vec::new(),
            active: 0,
            modal: false,
            log: Vec::new(),
        }
    }

    fn update(&mut self, message: Msg) {
        self.log.push(message.clone());
        match message {
            Msg::Input(i, text) => self.fields[i].input(text),
            Msg::Enter(i) => self.fields[i].commit(),
            Msg::Escape(i) => self.fields[i].revert(),
            Msg::Compose(_, composing) => self.focus.set_composing(composing),
            Msg::NumberInput(text) => self.number_text.input(text),
            Msg::NumberEnter => {
                if let Ok(value) = number::parse(self.number_text.text(), number::Range::default()) {
                    self.number = value;
                    self.baseline.committed(value);
                }
                self.number_text.set(number::format(self.number, 2));
            }
            Msg::NumberEscape => {
                self.number = self.baseline.rollback();
                self.number_text.set(number::format(self.number, 2));
            }
            Msg::Scrub(scrub) => {
                self.scrubs.push(scrub);
                match scrub {
                    Scrub::Begin => self.scrub_start = self.number,
                    Scrub::Delta { dx, shift, alt } => self.number = self.scrub_start + f64::from(dx) * number::step(0.1, StepKeys { shift, alt }),
                    Scrub::End => self.baseline.committed(self.number),
                    Scrub::Cancel => self.number = self.baseline.rollback(),
                    Scrub::Step { direction, shift, alt } => {
                        self.number += f64::from(direction) * number::step(1.0, StepKeys { shift, alt });
                        self.baseline.committed(self.number);
                    }
                    Scrub::Click => {}
                }
                self.number_text.set(number::format(self.number, 2));
            }
            Msg::Move(index) => self.active = index,
            Msg::Focus(..) | Msg::Press(_) => {}
        }
    }

    fn ring(&self) -> Ring {
        Ring::of(DesignTheme::Light.palette(), tokens::scale::RADIUS_2XS)
    }

    fn button(&self, id: u64, label: &'static str, area: FocusArea, enabled: bool) -> Element<'static, Msg> {
        Focusable::new(FocusId(id), area, text(label).boxed(), self.ring()).on_activate(Msg::Press(label)).enabled(enabled).boxed()
    }

    fn field(&self, index: usize, id: u64, role: Role) -> Element<'static, Msg> {
        let id = if index == 0 { self.first_id } else { id };
        let mut field = EditField::new(FocusId(id), FocusArea::Panels, role, self.fields[index].text().to_owned(), DesignTheme::Light.palette())
            .dir(self.dir)
            .composing(self.focus.composing())
            .on_input(move |text| Msg::Input(index, text))
            .on_enter(Msg::Enter(index))
            .on_escape(Msg::Escape(index))
            .on_focus_change(move |focused| Msg::Focus(index, focused))
            .on_compose(move |composing| Msg::Compose(index, composing))
            .enabled(!(index == 0 && self.first_disabled));
        if let Some(limits) = self.limits {
            field = field.limits(limits);
        }
        if let Some(limit) = self.limit {
            field = field.limits(styk_core::limits::Limits { max_chars: Some(limit), ..styk_core::limits::Limits::line() });
        }
        field.into_element()
    }

    fn view(&self) -> Element<'static, Msg> {
        let palette = DesignTheme::Light.palette();
        let roving = RovingGroup::new(
            FocusArea::Tools,
            (0..3)
                .map(|i| RovingItem { id: FocusId(30 + i), content: text(format!("tool {i}")).boxed(), enabled: i != 1, on_activate: Some(Msg::Press("tool")) })
                .collect(),
            self.active,
            self.ring(),
            Msg::Move,
        )
        .orientation(Orientation::Horizontal)
        .dir(self.dir)
        .spacing(8.0)
        .into_element();
        let number_text = self.number_text.text().to_owned();
        let number = NumberField::new(FocusId(20), FocusId(21), FocusArea::Panels, "X", number_text, palette)
            .on_input(Msg::NumberInput)
            .on_enter(Msg::NumberEnter)
            .on_escape(Msg::NumberEscape)
            .on_scrub(Msg::Scrub)
            .on_compose(|c| Msg::Compose(9, c))
            .enabled(self.number_enabled)
            .into_element();

        let mut column = Column::new()
            .spacing(10.0)
            .padding(10.0)
            .push(self.button(1, "first", FocusArea::TopBand, true))
            .push(self.field(0, 10, Role::SingleLine));
        if self.show_number {
            column = column.push(number);
        }
        column = column
            .push(roving)
            .push(self.button(2, "disabled", FocusArea::Panels, false));
        if self.show_second_field {
            column = column.push(self.field(1, 11, Role::Multiline));
        }
        column = column.push(self.button(3, "last", FocusArea::Timeline, true));
        let base: Element<'static, Msg> = column.width(Length::Fill).boxed();
        // The page is always the first layer of a stack, so opening a dialog does not rebuild its widgets' state.
        let layers = Stack::new().push(base);
        if self.modal {
            let dialog = Column::new()
                .spacing(10.0)
                .padding(10.0)
                .push(self.button(50, "ok", FocusArea::Panels, true))
                .push(self.field(2, 51, Role::DialogLine))
                .push(self.button(52, "cancel", FocusArea::Panels, true));
            layers.push(Scope::new(MODAL, dialog.boxed()).boxed()).boxed()
        } else {
            layers.boxed()
        }
    }
}

struct Harness {
    page: Page,
    driver: Option<Driver<'static, Msg>>,
}

impl Harness {
    fn new(page: Page) -> Harness {
        let driver = Driver::new(page.view(), Size::new(420.0, 520.0), &crate::fonts::ALL);
        let mut harness = Harness { page, driver: Some(driver) };
        harness.settle();
        harness
    }

    fn d(&mut self) -> &mut Driver<'static, Msg> {
        self.driver.as_mut().expect("driver")
    }

    /// Messages to the model, the view rebuilt, the tree's focus read back into the core.
    fn settle(&mut self) {
        let messages = self.d().messages();
        for message in messages {
            self.page.update(message);
        }
        let driver = self.driver.take().expect("driver").rebuild(self.page.view());
        self.driver = Some(driver);
        let snapshot = self.d().snapshot();
        focus::sync(&mut self.page.focus, &snapshot);
    }

    /// Delivers events; a navigation key nothing captured goes to the core, whose answer is run as a focus task.
    fn events(&mut self, events: &[Event]) {
        let statuses = self.d().events(events);
        for (event, status) in events.iter().zip(statuses) {
            if status == iced::event::Status::Ignored
                && let Some(target) = focus::navigate(&mut self.page.focus, event)
            {
                self.d().focus(target);
            }
        }
        self.settle();
    }

    fn press(&mut self, named: Named, modifiers: Modifiers) {
        let key = Key::Named(named);
        let physical = iced::keyboard::key::Physical::Unidentified(iced::keyboard::key::NativeCode::Unidentified);
        self.events(&[Event::Keyboard(iced::keyboard::Event::KeyPressed {
            key: key.clone(),
            modified_key: key.clone(),
            physical_key: physical,
            location: iced::keyboard::Location::Standard,
            modifiers,
            repeat: false,
            text: None,
        })]);
        self.events(&[Event::Keyboard(iced::keyboard::Event::KeyReleased { key: key.clone(), modified_key: key, physical_key: physical, location: iced::keyboard::Location::Standard, modifiers })]);
    }

    fn tab(&mut self) {
        self.press(Named::Tab, Modifiers::default());
    }

    fn shift_tab(&mut self) {
        self.press(Named::Tab, Modifiers::SHIFT);
    }

    fn click_target(&mut self, id: u64) {
        let bounds = self.d().snapshot().bounds_of(FocusId(id)).expect("target on screen");
        let center = Point::new(bounds.x + bounds.width / 2.0, bounds.y + bounds.height / 2.0);
        self.d().point_at(center);
        self.page.focus.pointer_pressed();
        self.events(&[Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left)), Event::Mouse(mouse::Event::ButtonReleased(mouse::Button::Left))]);
    }

    fn focused(&self) -> Option<u64> {
        self.page.focus.focused().map(|id| id.0)
    }

    fn type_text(&mut self, text: &str) {
        self.d().typewrite(text);
        self.settle();
    }

    fn chord(&mut self, letter: char, shift: bool) {
        self.d().chord(letter, shift);
        self.settle();
    }

    /// Answers the oldest clipboard read, then lets the model catch up.
    fn paste_reply(&mut self, text: &str) {
        self.d().reply_clipboard(text);
        self.settle();
    }

    fn text(&self, index: usize) -> &str {
        self.page.fields[index].text()
    }
}

fn harness() -> Harness {
    Harness::new(Page::new(Dir::Ltr))
}

#[test]
fn tab_walks_every_stop_once_skips_the_disabled_and_counts_the_roving_group_as_one() {
    let mut h = harness();
    let mut order = Vec::new();
    for _ in 0..8 {
        h.tab();
        order.push(h.focused().unwrap());
    }
    // first, text field, number label, number input, the roving group's active item, multiline, last, then around.
    assert_eq!(order, [1, 10, 20, 21, 30, 11, 3, 1]);
    h.shift_tab();
    assert_eq!(h.focused(), Some(3), "Shift+Tab goes back, wrapping");
}

#[test]
fn a_click_shows_no_ring_and_the_keyboard_shows_it() {
    let mut h = harness();
    let palette = DesignTheme::Light.palette();
    let ring: iced::Color = palette.focus_ring.into();
    let ring_pixel = |h: &mut Harness| -> [u8; 4] {
        let bounds = h.d().snapshot().bounds_of(FocusId(1)).unwrap();
        let (pixels, size) = h.d().render(&iced::Theme::Light, iced::Color::WHITE, 1.0);
        // The ring's stroke sits 2 to 4 pixels outside the control: sample its middle, left of the control.
        let (x, y) = ((bounds.x - 3.0) as usize, (bounds.y + bounds.height / 2.0) as usize);
        let at = (y * size.width as usize + x) * 4;
        [pixels[at], pixels[at + 1], pixels[at + 2], pixels[at + 3]]
    };
    let ring8 = ring.into_rgba8();
    h.click_target(1);
    assert_eq!(h.focused(), Some(1));
    assert_ne!(ring_pixel(&mut h), ring8, "a click shows no ring on a button");
    h.tab();
    h.shift_tab();
    assert_eq!(h.focused(), Some(1));
    assert_eq!(ring_pixel(&mut h), ring8, "arriving by the keyboard shows the ring");
}

#[test]
fn button_keys_act_only_while_it_holds_focus() {
    let mut h = harness();
    // Pointer over a button that is not focused: its keys do nothing.
    let bounds = h.d().snapshot().bounds_of(FocusId(3)).unwrap();
    h.d().point_at(Point::new(bounds.x + 2.0, bounds.y + 2.0));
    h.press(Named::Enter, Modifiers::default());
    assert!(!h.page.log.contains(&Msg::Press("last")), "{:?}", h.page.log);
    h.tab(); // first
    h.press(Named::Enter, Modifiers::default());
    assert!(h.page.log.contains(&Msg::Press("first")));
    h.press(Named::Space, Modifiers::default());
    assert_eq!(h.page.log.iter().filter(|m| **m == Msg::Press("first")).count(), 2, "Space activates on release");
}

#[test]
fn a_roving_group_moves_with_arrows_skips_disabled_and_mirrors_in_rtl() {
    for (dir, forward) in [(Dir::Ltr, Named::ArrowRight), (Dir::Rtl, Named::ArrowLeft)] {
        let mut h = Harness::new(Page::new(dir));
        for _ in 0..5 {
            h.tab();
        }
        assert_eq!(h.focused(), Some(30));
        h.press(forward, Modifiers::default());
        assert_eq!(h.page.active, 2, "item 1 is disabled and skipped ({dir:?})");
        h.d().focus(FocusId(32));
        h.settle();
        h.tab();
        assert_eq!(h.focused(), Some(11), "the group is one Tab stop: the next is the multiline field");
    }
}

#[test]
fn typed_hello_and_a_paste_undo_in_two_steps_and_redo_with_ctrl_shift_z() {
    let mut h = harness();
    h.tab();
    h.tab();
    assert_eq!(h.focused(), Some(10));
    h.type_text("Hello");
    assert_eq!(h.text(0), "Hello");
    h.chord('a', false);
    h.chord('c', false);
    assert_eq!(h.d().clipboard_writes, ["Hello"]);
    h.d().modifiers(Modifiers::default());
    h.press(Named::End, Modifiers::default());
    h.chord('v', false);
    assert_eq!(h.d().clipboard_reads.len(), 1);
    h.paste_reply("Hello");
    assert_eq!(h.text(0), "HelloHello");
    h.chord('z', false);
    assert_eq!(h.text(0), "Hello", "the paste is one step");
    h.chord('z', false);
    assert_eq!(h.text(0), "", "the typed word is one step");
    h.chord('z', true);
    assert_eq!(h.text(0), "Hello", "Ctrl+Shift+Z redoes");
    h.chord('y', false);
    assert_eq!(h.text(0), "HelloHello", "Ctrl+Y redoes");
}

#[test]
fn typing_after_a_pause_is_a_new_undo_step() {
    let mut h = harness();
    h.tab();
    h.tab();
    h.type_text("ab");
    std::thread::sleep(Duration::from_millis(1100));
    h.type_text("cd");
    assert_eq!(h.text(0), "abcd");
    h.chord('z', false);
    assert_eq!(h.text(0), "ab");
    h.chord('z', false);
    assert_eq!(h.text(0), "");
}

#[test]
fn the_undo_history_is_bounded() {
    let mut h = harness();
    h.tab();
    h.tab();
    // Each paste is its own step: 230 pastes, 200 remembered.
    for _ in 0..230 {
        h.chord('v', false);
        h.paste_reply("x");
    }
    assert_eq!(h.text(0).len(), 230);
    for _ in 0..260 {
        h.chord('z', false);
    }
    assert_eq!(h.text(0).len(), 30, "only the last 200 steps could be undone");
}

#[test]
fn one_key_with_two_scalars_inserts_both() {
    let mut h = harness();
    h.tab();
    h.tab();
    h.d().key_text("لا");
    h.settle();
    assert_eq!(h.text(0), "لا", "the lam-alef key keeps its second character");
}

#[test]
fn pasting_lines_joins_them_and_an_oversized_paste_is_cut_before_it_is_shaped() {
    let mut h = harness();
    h.tab();
    h.tab();
    h.chord('v', false);
    h.paste_reply("a\nb");
    assert_eq!(h.text(0), "ab");

    // The multiline field takes 16384 characters.
    h.tab();
    h.tab();
    h.tab();
    h.tab();
    assert_eq!(h.focused(), Some(11));
    let big = "x".repeat(5_000_000);
    h.chord('v', false);
    let start = Instant::now();
    h.d().reply_clipboard(&big);
    let elapsed = start.elapsed();
    h.settle();
    assert_eq!(h.text(1).chars().count(), 16384, "the paste is cut to the limit");
    assert!(elapsed < Duration::from_millis(33), "a 5 MB paste took {elapsed:?} on the interface thread");
    h.chord('v', false);
    h.paste_reply("more");
    assert_eq!(h.text(1).chars().count(), 16384, "a full field takes nothing, without panic");
}

#[test]
fn a_rejected_key_makes_no_message_and_no_history_entry() {
    let mut page = Page::new(Dir::Ltr);
    page.limit = Some(3);
    let mut h = Harness::new(page);
    h.tab();
    h.tab();
    h.type_text("ab");
    h.chord('v', false);
    h.paste_reply("c");
    assert_eq!(h.text(0), "abc");
    let before = h.page.log.len();
    h.type_text("d");
    assert_eq!(h.text(0), "abc");
    assert_eq!(h.page.log.len(), before, "a refused key publishes nothing");
    h.chord('z', false);
    assert_eq!(h.text(0), "ab", "the paste is still its own step");
    h.chord('z', false);
    assert_eq!(h.text(0), "");
}

#[test]
fn a_paste_reply_after_focus_moved_reaches_no_field() {
    let mut h = harness();
    h.tab();
    h.tab(); // text field 10
    h.chord('v', false);
    let (_, id) = h.d().clipboard_reads[0];
    h.tab(); // number label
    h.tab(); // number input 21
    h.d().reply_clipboard_to(id, "stray");
    h.settle();
    assert_eq!(h.text(0), "");
    assert_eq!(h.page.number_text.text(), "10", "the field that has focus now did not take it");
}

#[test]
fn a_second_paste_while_one_is_pending_and_an_unknown_reply_do_nothing() {
    let mut h = harness();
    h.tab();
    h.tab();
    h.chord('v', false);
    h.chord('v', false);
    assert_eq!(h.d().clipboard_reads.len(), 1, "one request in flight");
    h.d().reply_clipboard_to(iced_test::core::clipboard::RequestId(999_999), "stray");
    h.settle();
    assert_eq!(h.text(0), "");
    h.paste_reply("ok");
    assert_eq!(h.text(0), "ok");
}

#[test]
fn composition_reports_commits_through_the_limits_and_silences_hotkeys() {
    use iced_test::core::input_method;
    use styk_core::text_entry::{Chord, command_allowed};
    let mut h = harness();
    h.tab();
    h.tab();
    h.d().redraw();
    h.events(&[Event::InputMethod(input_method::Event::Opened)]);
    h.events(&[Event::InputMethod(input_method::Event::Preedit("にほん".to_owned(), Some(0..9)))]);
    assert!(h.page.focus.composing());
    assert!(!command_allowed(&h.page.focus, &Chord::new("KeyV", false, false, false)));
    assert!(!command_allowed(&h.page.focus, &Chord::new("F6", false, false, false)), "nothing runs while composing");
    // The caret rectangle handed to the input method is the caret's, inside the field.
    h.d().redraw();
    let bounds = h.d().snapshot().bounds_of(FocusId(10)).unwrap();
    match &h.d().input_method {
        input_method::InputMethod::Enabled { cursor, .. } => {
            assert!(cursor.x >= bounds.x && cursor.x <= bounds.x + bounds.width, "{cursor:?} in {bounds:?}");
            assert!(cursor.y >= bounds.y && cursor.y + cursor.height <= bounds.y + bounds.height + 1.0, "{cursor:?} in {bounds:?}");
        }
        other => panic!("the focused field enables the input method: {other:?}"),
    }
    h.events(&[Event::InputMethod(input_method::Event::Commit("日本".to_owned()))]);
    h.events(&[Event::InputMethod(input_method::Event::Preedit(String::new(), None))]);
    assert_eq!(h.text(0), "日本");
    assert!(!h.page.focus.composing());
    assert!(command_allowed(&h.page.focus, &Chord::new("F6", false, false, false)));
    assert!(!command_allowed(&h.page.focus, &Chord::new("KeyV", false, false, false)), "still a text field");
}

#[test]
fn enter_and_escape_follow_the_role() {
    let mut h = harness();
    h.tab();
    h.tab();
    h.type_text("abc");
    h.press(Named::Enter, Modifiers::default());
    assert_eq!(h.page.fields[0].baseline(), "abc", "Enter commits");
    assert_eq!(h.focused(), Some(10), "and the field keeps focus");
    h.type_text("d");
    h.press(Named::Escape, Modifiers::default());
    assert_eq!(h.text(0), "abc", "Escape reverts to the committed text");
    assert_eq!(h.focused(), None, "and leaves the field");
    assert_eq!(h.page.focus.text_entry(), None);
}

#[test]
fn a_multiline_field_keeps_enter_for_line_breaks_and_a_dialog_field_does_not_blur_on_enter() {
    let mut h = harness();
    for _ in 0..6 {
        h.tab();
    }
    assert_eq!(h.focused(), Some(11));
    h.type_text("a");
    h.press(Named::Enter, Modifiers::default());
    h.type_text("b");
    assert_eq!(h.text(1), "a\nb");
    h.press(Named::Escape, Modifiers::default());
    assert_eq!(h.text(1), "a\nb", "Escape keeps a multiline field's text");

    h.page.modal = true;
    h.settle();
    let targets = h.d().snapshot().targets(MODAL).to_vec();
    let first = h.page.focus.open_scope(MODAL, targets, None).unwrap();
    h.d().focus(first);
    h.settle();
    h.tab();
    assert_eq!(h.focused(), Some(51));
    h.type_text("x");
    h.press(Named::Enter, Modifiers::default());
    assert_eq!(h.focused(), Some(51), "Enter does not blur a dialog field");
    assert!(h.page.log.contains(&Msg::Enter(2)), "it submits");
}

#[test]
fn escape_in_a_number_field_returns_to_the_latest_gesture() {
    let mut h = harness();
    h.d().focus(FocusId(20));
    h.settle();
    // An arrow step on the label commits 11 without blurring.
    h.press(Named::ArrowUp, Modifiers::default());
    assert_eq!(h.page.number, 11.0);
    // Then the user types 50 into the input and presses Escape.
    h.tab();
    assert_eq!(h.focused(), Some(21));
    h.d().chord('a', false);
    h.type_text("50");
    h.press(Named::Escape, Modifiers::default());
    assert_eq!(h.page.number, 11.0, "only the latest gesture reverts");
    assert_eq!(h.page.number_text.text(), "11");
    assert_eq!(h.focused(), None);
}

#[test]
fn number_steps_scale_with_shift_and_alt_and_enter_commits_and_blurs() {
    let mut h = harness();
    h.d().focus(FocusId(20));
    h.settle();
    h.press(Named::ArrowUp, Modifiers::SHIFT);
    assert!((h.page.number - 10.1).abs() < 1e-9, "{}", h.page.number);
    h.press(Named::ArrowDown, Modifiers::ALT);
    assert!((h.page.number - 10.09).abs() < 1e-9, "{}", h.page.number);
    h.tab();
    h.d().chord('a', false);
    h.type_text("42");
    h.press(Named::Enter, Modifiers::default());
    assert_eq!(h.page.number, 42.0);
    assert_eq!(h.focused(), None, "Enter commits and blurs");
}

#[test]
fn a_scrub_follows_the_pointer_outside_the_widget_and_ends_once_on_release() {
    let mut h = harness();
    let label = h.d().snapshot().bounds_of(FocusId(20)).unwrap();
    let start = Point::new(label.x + 2.0, label.y + label.height / 2.0);
    h.d().point_at(start);
    h.events(&[Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left))]);
    // Far outside the label, and beyond the window's edge.
    for x in [start.x + 20.0, start.x + 100.0, 900.0] {
        h.d().point_at(Point::new(x, 600.0));
        h.events(&[Event::Mouse(mouse::Event::CursorMoved { position: Point::new(x, 600.0) })]);
    }
    h.events(&[Event::Mouse(mouse::Event::ButtonReleased(mouse::Button::Left))]);
    let scrubs = &h.page.scrubs;
    assert_eq!(scrubs.iter().filter(|s| **s == Scrub::Begin).count(), 1);
    assert_eq!(scrubs.iter().filter(|s| **s == Scrub::End).count(), 1, "{scrubs:?}");
    assert!(scrubs.iter().any(|s| matches!(s, Scrub::Delta { dx, .. } if *dx > 800.0)), "moves outside the window still count");
    // Further movement after release changes nothing.
    let count = h.page.scrubs.len();
    h.events(&[Event::Mouse(mouse::Event::CursorMoved { position: Point::new(10.0, 10.0) })]);
    assert_eq!(h.page.scrubs.len(), count);
}

#[test]
fn a_scrub_cancels_on_escape_and_when_the_window_loses_focus_and_rolls_back() {
    for cancel in [
        Event::Keyboard(iced::keyboard::Event::KeyPressed {
            key: Key::Named(Named::Escape),
            modified_key: Key::Named(Named::Escape),
            physical_key: iced::keyboard::key::Physical::Unidentified(iced::keyboard::key::NativeCode::Unidentified),
            location: iced::keyboard::Location::Standard,
            modifiers: Modifiers::default(),
            repeat: false,
            text: None,
        }),
        Event::Window(iced::window::Event::Unfocused),
        Event::Touch(iced::touch::Event::FingerLost { id: iced::touch::Finger(0), position: Point::ORIGIN }),
    ] {
        let mut h = harness();
        let label = h.d().snapshot().bounds_of(FocusId(20)).unwrap();
        let start = Point::new(label.x + 2.0, label.y + label.height / 2.0);
        h.d().point_at(start);
        h.events(&[Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left))]);
        h.events(&[Event::Mouse(mouse::Event::CursorMoved { position: Point::new(start.x + 50.0, start.y) })]);
        assert_ne!(h.page.number, 10.0, "the scrub moved the value");
        h.events(&[cancel.clone()]);
        assert_eq!(h.page.number, 10.0, "{cancel:?} rolls the gesture back");
        h.events(&[Event::Mouse(mouse::Event::ButtonReleased(mouse::Button::Left))]);
        assert_eq!(h.page.scrubs.iter().filter(|s| **s == Scrub::End).count(), 0, "a cancelled gesture does not also end");
        assert_eq!(h.page.number, 10.0);
    }
}

#[test]
fn a_press_without_movement_is_a_click_not_a_scrub() {
    let mut h = harness();
    h.click_target(20);
    assert_eq!(h.page.scrubs, [Scrub::Click]);
}

#[test]
fn f6_cycles_areas_from_inside_a_text_field_without_touching_the_text() {
    let mut h = harness();
    h.tab();
    h.tab();
    h.type_text("abc");
    assert_eq!(h.page.focus.text_entry(), Some(FocusId(10)));
    h.press(Named::F6, Modifiers::default());
    assert_ne!(h.focused(), Some(10), "the area changed");
    assert_eq!(h.text(0), "abc");
    assert_eq!(h.page.focus.text_entry(), None);
}

#[test]
fn a_modal_traps_tab_at_both_edges_and_closing_restores_the_invoker() {
    let mut h = harness();
    h.d().focus(FocusId(1));
    h.settle();
    h.page.modal = true;
    h.settle();
    let targets = h.d().snapshot().targets(MODAL).to_vec();
    assert_eq!(targets.iter().map(|t| t.id.0).collect::<Vec<_>>(), [50, 51, 52]);
    let first = h.page.focus.open_scope(MODAL, targets, None).unwrap();
    h.d().focus(first);
    h.settle();
    assert_eq!(h.focused(), Some(50));
    h.shift_tab();
    assert_eq!(h.focused(), Some(52), "Shift+Tab from the first wraps inside the dialog");
    h.tab();
    assert_eq!(h.focused(), Some(50), "Tab from the last wraps to the first, never to the page below");
    h.page.modal = false;
    let restored = h.page.focus.close_scope();
    assert_eq!(restored, Some(FocusId(1)));
    h.d().focus(FocusId(1));
    h.settle();
    assert_eq!(h.focused(), Some(1));
}

#[test]
fn closing_a_modal_after_its_invoker_is_gone_still_lands_somewhere() {
    let mut h = harness();
    h.d().focus(FocusId(11));
    h.settle();
    h.page.modal = true;
    h.settle();
    let targets = h.d().snapshot().targets(MODAL).to_vec();
    let first = h.page.focus.open_scope(MODAL, targets, None).unwrap();
    h.d().focus(first);
    h.settle();
    // The page rebuilds without the invoker while the dialog is open, then the dialog closes.
    h.page.show_second_field = false;
    h.page.modal = false;
    h.settle();
    let restored = h.page.focus.close_scope();
    assert!(restored.is_some(), "the nearest target of the page");
    assert_ne!(restored, Some(FocusId(11)));
}

#[test]
fn removing_the_focused_field_clears_the_text_entry_state() {
    let mut h = harness();
    for _ in 0..6 {
        h.tab();
    }
    assert_eq!(h.page.focus.text_entry(), Some(FocusId(11)));
    h.page.show_second_field = false;
    h.settle();
    assert_eq!(h.page.focus.text_entry(), None, "hotkeys are not suppressed by a field that is gone");
    assert!(styk_core::text_entry::document_undo_reachable(&h.page.focus));
}

#[test]
fn the_rtl_page_is_the_mirror_of_the_ltr_page_except_what_stays_left_to_right() {
    let mut ltr = Harness::new(Page::new(Dir::Ltr));
    let mut rtl = Harness::new(Page::new(Dir::Rtl));
    let (ltr, rtl) = (ltr.d().snapshot(), rtl.d().snapshot());
    // The roving group is a row built with `Dir::row`: its items run in reading order, so they mirror.
    let order = |s: &focus::Snapshot| {
        let mut items: Vec<(u64, f32)> = [30, 31, 32].iter().map(|id| (*id, s.bounds_of(FocusId(*id)).unwrap().x)).collect();
        items.sort_by(|a, b| a.1.total_cmp(&b.1));
        items.into_iter().map(|(id, _)| id).collect::<Vec<_>>()
    };
    assert_eq!(order(&ltr), [30, 31, 32]);
    assert_eq!(order(&rtl), [32, 31, 30], "the group reads right to left");
    for id in [30, 31, 32] {
        let (l, r) = (ltr.bounds_of(FocusId(id)).unwrap(), rtl.bounds_of(FocusId(id)).unwrap());
        assert!((l.width - r.width).abs() < 1.0, "item {id} keeps its width");
    }
    // The group occupies the same box: the mirrored items are the reflections inside it.
    let (first, last) = (ltr.bounds_of(FocusId(30)).unwrap(), ltr.bounds_of(FocusId(32)).unwrap());
    let (left, right) = (first.x, last.x + last.width);
    for id in [30, 31, 32] {
        let (l, r) = (ltr.bounds_of(FocusId(id)).unwrap(), rtl.bounds_of(FocusId(id)).unwrap());
        let reflected = left + right - (l.x + l.width);
        assert!((r.x - reflected).abs() < 1.0, "item {id}: {} against {reflected}", r.x);
    }
    // The number field stays left to right by contract: it does not move.
    assert_eq!(ltr.bounds_of(FocusId(21)), rtl.bounds_of(FocusId(21)));
    assert_eq!(ltr.bounds_of(FocusId(20)), rtl.bounds_of(FocusId(20)));
}

#[test]
fn target_kinds_reach_the_core() {
    let mut h = harness();
    let snapshot = h.d().snapshot();
    let kinds: Vec<(u64, TargetKind, bool)> = snapshot.targets(ScopeId::ROOT).iter().map(|t| (t.id.0, t.kind, t.enabled)).collect();
    assert!(kinds.contains(&(10, TargetKind::TextEntry, true)), "{kinds:?}");
    assert!(kinds.contains(&(2, TargetKind::Control, false)), "{kinds:?}");
}

/// The caret offsets Chromium visits for repeated arrow presses, against the native editor's, for the same strings.
#[test]
fn arrow_keys_visit_the_same_offsets_as_chromium_in_mixed_direction_text() {
    use iced::advanced::graphics::text::Editor;
    use iced::advanced::text::editor::{Action, Editor as _, Motion};
    use iced::advanced::text::parser::PlainText;
    use iced::advanced::text::{Alignment, LineHeight, Wrapping};

    for font in &crate::fonts::ALL {
        iced::advanced::graphics::text::font_system().write().unwrap().load_font(std::borrow::Cow::Borrowed(font));
    }
    let fixture = include_str!("../../tests/fixtures/chromium-caret.txt");
    let mut checked = 0;
    for line in fixture.lines().filter(|line| !line.starts_with('#') && !line.is_empty()) {
        let parts: Vec<&str> = line.split(" | ").collect();
        let (name, text, from, key, expected) = (parts[0], parts[1], parts[2], parts[3], parts[4]);
        let expected: Vec<usize> = expected.split(' ').map(|n| n.parse().unwrap()).collect();

        let mut editor = Editor::with_text(text);
        editor.update(Size::new(700.0, 40.0), iced::Font::default(), iced::Pixels(16.0), LineHeight::default(), Wrapping::None, Alignment::Default, None, &mut PlainText);
        editor.perform(Action::Move(if from == "start" { Motion::DocumentStart } else { Motion::DocumentEnd }));
        let offset = |editor: &Editor| {
            let index = editor.cursor().position.index;
            text[..index].encode_utf16().count()
        };
        let mut seen = vec![offset(&editor)];
        for _ in 0..text.len() + 3 {
            editor.perform(Action::Move(if key == "ArrowLeft" { Motion::Left } else { Motion::Right }));
            let at = offset(&editor);
            if Some(&at) == seen.last() {
                break;
            }
            seen.push(at);
        }
        assert_eq!(seen, expected, "{name}: {key} from the {from} of {text:?}");
        checked += 1;
    }
    assert_eq!(checked, 24);
}

// ---- Findings of the independent review and the checker (each fails without its fix) ----

fn distinct_units(text: &str) -> usize {
    styk_core::limits::distinct_units(text)
}

/// The longest run of combining marks in `text`.
fn longest_mark_run(text: &str) -> usize {
    let (mut longest, mut run) = (0, 0);
    for c in text.chars() {
        if ('\u{300}'..='\u{36f}').contains(&c) {
            run += 1;
            longest = longest.max(run);
        } else {
            run = 0;
        }
    }
    longest
}

fn focus_field(h: &mut Harness, id: u64) {
    h.d().focus(FocusId(id));
    h.settle();
    assert_eq!(h.focused(), Some(id));
}

#[test]
fn a_huge_paste_into_a_single_line_field_is_bounded_and_does_not_freeze_the_interface() {
    let mut h = harness();
    focus_field(&mut h, 10);
    h.chord('v', false);
    let (_, id) = h.d().clipboard_reads[0];
    let huge = Arc::new(Content::Text("x".repeat(5_000_000)));
    let start = Instant::now();
    h.d().reply_clipboard_with(id, huge);
    let elapsed = start.elapsed();
    h.settle();
    assert!(h.text(0).chars().count() <= 4096, "{} characters were taken", h.text(0).chars().count());
    assert!(elapsed < Duration::from_millis(33), "a 5 MB paste took {elapsed:?} on the interface thread");
}

#[test]
fn a_100_megabyte_paste_costs_the_interface_thread_almost_nothing() {
    let mut h = harness();
    focus_field(&mut h, 10);
    h.chord('v', false);
    let (_, id) = h.d().clipboard_reads[0];
    let huge = Arc::new(Content::Text("y".repeat(100_000_000)));
    let start = Instant::now();
    h.d().reply_clipboard_with(id, huge);
    let elapsed = start.elapsed();
    assert!(elapsed < Duration::from_millis(33), "a 100 MB paste took {elapsed:?} on the interface thread");
}

#[test]
fn a_paste_of_one_letter_and_thousands_of_combining_marks_cannot_stall_the_next_frame() {
    let mut h = harness();
    for _ in 0..6 {
        h.tab();
    }
    assert_eq!(h.focused(), Some(11));
    let marks = format!("a{}", "\u{301}".repeat(16_383));
    h.chord('v', false);
    h.paste_reply(&marks);
    assert!(longest_mark_run(h.text(1)) <= 16, "a run of {} combining marks was accepted", longest_mark_run(h.text(1)));
    let start = Instant::now();
    h.d().redraw();
    assert!(start.elapsed() < Duration::from_millis(200), "the frame after the paste took {:?}", start.elapsed());
}

#[test]
fn a_paste_of_millions_of_line_breaks_is_bounded_and_fast() {
    let mut h = harness();
    for _ in 0..6 {
        h.tab();
    }
    h.chord('v', false);
    let (_, id) = h.d().clipboard_reads[0];
    let content = Arc::new(Content::Text("\n".repeat(5_000_000)));
    let start = Instant::now();
    h.d().reply_clipboard_with(id, content);
    let elapsed = start.elapsed();
    h.settle();
    assert!(h.text(1).lines().count() <= 1001, "{} lines were accepted", h.text(1).lines().count());
    assert!(elapsed < Duration::from_millis(33), "5 million line breaks took {elapsed:?}");
}

#[test]
fn a_lone_carriage_return_in_a_paste_becomes_a_line_break_in_a_multiline_field() {
    let mut h = harness();
    for _ in 0..6 {
        h.tab();
    }
    h.chord('v', false);
    h.paste_reply("a\rb\r\nc");
    assert_eq!(h.text(1), "a\nb\nc");
}

#[test]
fn the_text_tools_255_distinct_units_are_enforced_before_the_edit() {
    let mut page = Page::new(Dir::Ltr);
    page.limits = Some(styk_core::limits::Limits::text_tool());
    let mut h = Harness::new(page);
    focus_field(&mut h, 10);
    h.chord('v', false);
    let many: String = (0..400u32).map(|n| char::from_u32(0x100 + n).unwrap()).collect();
    h.paste_reply(&many);
    assert!(distinct_units(h.text(0)) <= 255, "{} distinct units were accepted", distinct_units(h.text(0)));
    // The field holds 255; a 256th distinct character is refused and a repeat is taken.
    let held = h.text(0).to_owned();
    h.type_text("\u{2200}");
    assert_eq!(h.text(0), held, "a new distinct unit past the limit is refused");
    let again = held.chars().next().unwrap().to_string();
    h.type_text(&again);
    assert_eq!(h.text(0).chars().count(), held.chars().count() + 1, "a repeated unit is taken");
}

#[test]
fn enter_cannot_push_a_full_multiline_field_past_its_limit() {
    let mut page = Page::new(Dir::Ltr);
    page.limit = Some(5);
    let mut h = Harness::new(page);
    for _ in 0..6 {
        h.tab();
    }
    assert_eq!(h.focused(), Some(11));
    h.type_text("abcde");
    h.press(Named::Enter, Modifiers::default());
    assert_eq!(h.text(1), "abcde", "the line break would be a sixth character");
}

#[test]
fn ctrl_c_and_ctrl_x_with_no_selection_are_handled_by_the_field() {
    let mut h = harness();
    focus_field(&mut h, 10);
    for letter in ['c', 'x'] {
        let status = h.d().chord_status(letter, false);
        assert_eq!(status, iced::event::Status::Captured, "Ctrl+{letter} with nothing selected reached the document");
    }
    assert!(h.d().clipboard_writes.is_empty(), "nothing is written for an empty selection");
}

#[test]
fn arrow_keys_inside_a_number_input_step_it_and_escape_keeps_focus() {
    let mut h = harness();
    focus_field(&mut h, 21);
    h.press(Named::ArrowUp, Modifiers::default());
    assert_eq!(h.page.number, 11.0, "ArrowUp in the input steps the value");
    h.press(Named::ArrowDown, Modifiers::SHIFT);
    assert!((h.page.number - 10.9).abs() < 1e-9, "{}", h.page.number);
    h.d().chord('a', false);
    h.type_text("50");
    h.press(Named::Escape, Modifiers::default());
    assert_eq!(h.focused(), Some(21), "Escape cancels the edit and keeps focus, as today");
    assert_eq!(h.page.number_text.text(), "10.9");
}

#[test]
fn tabbing_into_a_filled_field_selects_its_text() {
    let mut page = Page::new(Dir::Ltr);
    page.fields[0].set("abc");
    let mut h = Harness::new(page);
    h.tab();
    h.tab();
    assert_eq!(h.focused(), Some(10));
    h.type_text("x");
    assert_eq!(h.text(0), "x", "the text was selected by the Tab, so typing replaced it");
    // The number input too: Tab from its label.
    h.d().focus(FocusId(20));
    h.settle();
    h.tab();
    assert_eq!(h.focused(), Some(21));
    h.type_text("7");
    assert_eq!(h.page.number_text.text(), "7");
}

#[test]
fn typing_stops_being_one_undo_step_when_the_caret_moves() {
    let mut h = harness();
    focus_field(&mut h, 10);
    h.type_text("a");
    h.press(Named::ArrowLeft, Modifiers::default());
    h.press(Named::ArrowRight, Modifiers::default());
    h.type_text("b");
    assert_eq!(h.text(0), "ab");
    h.chord('z', false);
    assert_eq!(h.text(0), "a", "the caret move ended the first typing group");
}

#[test]
fn one_typing_run_is_not_unboundedly_one_undo_step() {
    let mut h = harness();
    focus_field(&mut h, 10);
    h.type_text(&"x".repeat(3000));
    assert_eq!(h.text(0).chars().count(), 3000);
    h.chord('z', false);
    let left = h.text(0).chars().count();
    assert!(left > 0 && left < 3000, "one undo took the whole run of 3000 (left {left})");
}

#[test]
fn undo_history_is_bounded_by_what_it_holds_not_only_by_how_many() {
    let mut h = harness();
    for _ in 0..6 {
        h.tab();
    }
    assert_eq!(h.focused(), Some(11));
    for n in 0..100u32 {
        h.chord('a', false);
        h.chord('v', false);
        let body: String = std::iter::once(char::from_u32(0x41 + n % 26).unwrap()).chain(std::iter::repeat_n('z', 15_999)).collect();
        h.paste_reply(&body);
    }
    let mut undos = 0;
    for _ in 0..150 {
        let before = h.text(1).to_owned();
        h.chord('z', false);
        if h.text(1) != before {
            undos += 1;
        }
    }
    assert!((8..100).contains(&undos), "{undos} undo steps were kept for 100 large replacements");
}

#[test]
fn disabling_the_focused_field_drops_its_focus_and_enabling_it_again_does_not_bring_it_back() {
    let mut h = harness();
    h.tab();
    h.tab();
    assert_eq!(h.focused(), Some(10));
    h.page.first_disabled = true;
    h.settle();
    assert_eq!(h.focused(), None);
    h.page.first_disabled = false;
    h.settle();
    assert_eq!(h.focused(), None, "re-enabling the field must not resurrect its focus");
    assert_eq!(h.page.focus.text_entry(), None);
}

#[test]
fn replacing_a_field_by_another_does_not_hand_over_focus_or_a_pending_paste() {
    let mut h = harness();
    h.tab();
    h.tab();
    h.chord('v', false);
    let (_, id) = h.d().clipboard_reads[0];
    // Field 10 is replaced by field 60 at the same place in the tree.
    h.page.first_id = 60;
    h.settle();
    assert_ne!(h.focused(), Some(60), "the new field starts unfocused");
    h.d().reply_clipboard_to(id, "stray");
    h.settle();
    assert_eq!(h.text(0), "", "the old field's paste did not land in the new one");
}

#[test]
fn a_dialog_contains_pointer_and_focus_so_a_field_behind_it_cannot_be_clicked() {
    let mut h = harness();
    h.page.modal = true;
    h.settle();
    let targets = h.d().snapshot().targets(MODAL).to_vec();
    let first = h.page.focus.open_scope(MODAL, targets, None).unwrap();
    h.d().focus(first);
    h.settle();
    assert_eq!(h.focused(), Some(50));
    h.click_target(10);
    assert_eq!(h.focused(), Some(50), "a click behind the dialog must not move focus out of it");
    assert_eq!(h.page.focus.text_entry(), None);
    // Typing goes nowhere behind the dialog either.
    h.type_text("z");
    assert_eq!(h.text(0), "");
}

#[test]
fn ctrl_f6_goes_to_the_previous_area_and_shift_f6_is_not_navigation() {
    let mut h = harness();
    h.press(Named::F6, Modifiers::default());
    assert_eq!(h.focused(), Some(1), "F6 goes to the first area, the top band");
    h.press(Named::F6, Modifiers::CTRL);
    assert_eq!(h.focused(), Some(3), "Ctrl+F6 goes to the previous area, wrapping to the timeline");
    h.press(Named::F6, Modifiers::SHIFT);
    assert_eq!(h.focused(), Some(3), "Shift+F6 is Remove keyframes, not a way to move focus");
}

#[test]
fn navigation_waits_while_an_input_method_composes() {
    use iced_test::core::input_method;
    let mut h = harness();
    h.tab();
    h.tab();
    h.events(&[Event::InputMethod(input_method::Event::Opened)]);
    h.events(&[Event::InputMethod(input_method::Event::Preedit("に".to_owned(), Some(0..3)))]);
    assert!(h.page.focus.composing());
    h.press(Named::F6, Modifiers::default());
    assert_eq!(h.focused(), Some(10), "F6 must not leave a composing field");
}

#[test]
fn a_disabled_number_label_takes_no_pointer_input() {
    let mut page = Page::new(Dir::Ltr);
    page.number_enabled = false;
    let mut h = Harness::new(page);
    let label = h.d().snapshot().bounds_of(FocusId(20)).unwrap();
    let start = Point::new(label.x + 2.0, label.y + label.height / 2.0);
    h.d().point_at(start);
    h.events(&[Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left))]);
    h.events(&[Event::Mouse(mouse::Event::CursorMoved { position: Point::new(start.x + 40.0, start.y) })]);
    h.events(&[Event::Mouse(mouse::Event::ButtonReleased(mouse::Button::Left))]);
    assert!(h.page.scrubs.is_empty(), "{:?}", h.page.scrubs);
}
