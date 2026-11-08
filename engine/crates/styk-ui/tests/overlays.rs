//! The overlay views on the core's host, through the real widgets in the headless harness: keys reach the rows, the host decides,
//! the toolkit's focus follows and agrees with the core's after every step (`docs/native/overlays.md`).
//!
//! Time is injected: `Overlays::update` takes the application's milliseconds, and the hover intent, the typeahead window and
//! the message timeouts are the core's deadlines, so no test waits.

use iced::keyboard::{Modifiers, key::Named};
use iced::widget::{Row, container, stack};
use iced::{Element, Event, Length, Padding, Point, Size, Widget as _, mouse};
use styk_core::commands::CommandId;
use styk_core::focus::{FocusArea, FocusId, FocusState, FocusTarget, ScopeId, TargetKind};
use styk_core::overlay::host::{Hints, row_id};
use styk_core::overlay::menu::{Anchor, Entry, Item};
use styk_core::overlay::placement::Rect;
use styk_core::overlay::Reason;
use styk_design::widgets::button::{Button, IconButton};
use styk_design::widgets::dialog::{Dialog, DialogSize, modal};
use styk_design::widgets::focus::{self, Snapshot};
use styk_design::widgets::layer::Layer;
use styk_design::widgets::select::{Choice, Select};
use styk_design::widgets::testing::Driver;
use styk_design::Theme;
use styk_ui::message::SelectRequest;
use styk_ui::overlays::{Outcome, Overlays};
use styk_ui::Message;

const INVOKER: FocusId = FocusId(7);
const SELECT: FocusId = FocusId(8);
const WINDOW: Size = Size::new(640.0, 420.0);

fn palette() -> &'static styk_design::Palette {
    Theme::Light.palette()
}

fn row(command: CommandId, label: &str) -> Entry {
    Entry::Item(Item::new(command, label))
}

fn menu_rows() -> Vec<Entry> {
    vec![
        row(CommandId::Undo, "Undo"),
        row(CommandId::Redo, "Redo"),
        Entry::Separator,
        Entry::Item(Item { submenu: Some(vec![row(CommandId::Copy, "Copy"), row(CommandId::Paste, "Paste")]), ..Item::new(CommandId::Menu, "More") }),
        Entry::Item(Item { disabled: true, reason: "Nothing selected".into(), ..Item::new(CommandId::Delete, "Delete") }),
    ]
}

/// A window: the page (an opener and a select), the overlay layer, the core's focus state and a driver on the real tree.
struct Window {
    overlays: Overlays,
    focus: FocusState,
    driver: Option<Driver<'static, Message>>,
    now: u64,
    runs: Vec<CommandId>,
    picks: Vec<Message>,
    gates: Vec<bool>,
}

impl Window {
    fn new() -> Window {
        let mut window = Window { overlays: Overlays::new(Hints::default(), false), focus: FocusState::new(), driver: None, now: 0, runs: Vec::new(), picks: Vec::new(), gates: Vec::new() };
        window.rebuild();
        window.sync();
        window.focus.focus(INVOKER);
        window.apply_focus(vec![Some(INVOKER)]);
        window.sync();
        window
    }

    fn view(&self) -> Element<'static, Message> {
        let palette = palette();
        let opener = IconButton::new(INVOKER, FocusArea::TopBand, palette, "more", Message::Idle).into_element();
        let options = vec![Choice { label: "Linear".into(), disabled: false }, Choice { label: "Hold".into(), disabled: false }, Choice { label: "Ease".into(), disabled: false }];
        let picks = vec![Message::Compose(false), Message::Compose(true), Message::Idle];
        let select = Select::new(
            SELECT,
            FocusArea::Panels,
            palette,
            options,
            Some(1),
            move |open| Message::OpenSelect(Box::new(SelectRequest { invoker: SELECT, anchor: open.anchor, keyboard: open.keyboard, options: vec![("Linear".into(), false), ("Hold".into(), false), ("Ease".into(), false)], chosen: Some(1), picks: picks.clone() })),
            |_| Message::Idle,
        )
        .into_element();
        let page = Row::with_children(vec![opener, container(select).width(Length::Fixed(160.0)).boxed()]).spacing(16.0);
        let base = container(page).padding(Padding { top: 24.0, left: 24.0, ..Padding::ZERO }).width(Length::Fill).height(Length::Fill);
        // The layer holds a copy of the overlay state for this frame, as the application's view borrows it.
        let owner: &'static Overlays = Box::leak(Box::new(self.overlays.clone()));
        let layer = owner.layer(palette, &self.focus, 0.0, None);
        stack![base.boxed(), layer].boxed()
    }

    fn rebuild(&mut self) {
        let view = self.view();
        self.driver = Some(match self.driver.take() {
            Some(driver) => driver.rebuild(view),
            None => Driver::new(view, WINDOW, &styk_design::fonts::ALL),
        });
    }

    fn driver(&mut self) -> &mut Driver<'static, Message> {
        self.driver.as_mut().expect("the driver exists")
    }

    /// What a walk of the tree found, given to the core and to the overlay owner, as the application does each frame.
    fn sync(&mut self) -> Snapshot {
        let snapshot = self.driver().snapshot();
        self.overlays.observe(&snapshot);
        let synced = focus::sync(&mut self.focus, &snapshot);
        assert_eq!(synced.unfocus, None, "no stale target holds focus");
        snapshot
    }

    fn apply_focus(&mut self, requests: Vec<Option<FocusId>>) {
        for request in requests {
            match request {
                Some(id) => self.driver().focus(id),
                None => self.driver().unfocus(),
            }
        }
    }

    fn carry(&mut self, outcome: Outcome) {
        self.runs.extend(outcome.run);
        self.picks.extend(outcome.pick);
        self.gates.extend(outcome.gate);
        // The tree is rebuilt from the new state first, then the focus tasks run on it (the runtime's order).
        self.rebuild();
        self.apply_focus(outcome.focus);
        self.sync();
    }

    /// Delivers what the widgets published to the overlay owner, until nothing more is asked.
    fn pump(&mut self) {
        for _ in 0..8 {
            let messages = self.driver().messages();
            if messages.is_empty() {
                break;
            }
            for message in messages {
                if matches!(message, Message::Overlay(_) | Message::OpenSelect(_) | Message::Toast(_)) {
                    let outcome = self.overlays.update(message, &mut self.focus, self.now);
                    self.carry(outcome);
                }
            }
        }
    }

    fn key(&mut self, named: Named) {
        self.driver().press(named);
        self.driver().release(named);
        self.pump();
        self.agree();
    }

    fn typed(&mut self, text: &str, now: u64) {
        self.now = now;
        self.driver().key_text(text);
        self.pump();
        self.agree();
    }

    fn open(&mut self, keyboard: bool) {
        let outcome = self.overlays.open_menu(menu_rows(), Anchor::Root(Rect { x: 24.0, y: 24.0, width: 32.0, height: 32.0 }), Some(INVOKER), keyboard, &mut self.focus);
        self.carry(outcome);
    }

    /// The core's focus and the toolkit's are the same target.
    fn agree(&mut self) {
        let snapshot = self.driver().snapshot();
        assert_eq!(snapshot.focused, self.focus.focused(), "the toolkit and the core hold the same focus");
    }

    fn current(&self) -> Option<usize> {
        self.overlays.host().menus().last().and_then(|open| open.current())
    }
}

#[test]
fn arrows_home_end_and_a_disabled_row_through_the_real_rows() {
    let mut w = Window::new();
    w.open(true);
    let id = w.overlays.host().menus()[0].id();
    assert_eq!(w.focus.focused(), Some(row_id(id, 0)));
    assert!(w.gates.contains(&true), "the hotkey gate closed when the menu opened");
    w.key(Named::ArrowDown);
    w.key(Named::ArrowDown);
    w.key(Named::ArrowDown);
    assert_eq!((w.current(), w.focus.focused()), (Some(3), Some(row_id(id, 3))), "the disabled row takes focus");
    w.key(Named::Enter);
    assert!(w.runs.is_empty(), "and does not run");
    w.key(Named::ArrowDown);
    assert_eq!(w.current(), Some(0), "arrows wrap");
    w.key(Named::End);
    assert_eq!(w.current(), Some(3));
    w.key(Named::Home);
    assert_eq!(w.current(), Some(0));
    w.key(Named::ArrowDown);
    w.key(Named::Enter);
    assert_eq!(w.runs, [CommandId::Redo]);
    assert!(w.overlays.host().menus().is_empty());
    assert_eq!(w.gates.last(), Some(&false), "the gate opened again");
    assert_eq!(w.focus.focused(), Some(INVOKER), "focus went back to the opener");
}

#[test]
fn typeahead_jumps_by_the_first_letters_and_forgets_after_700_ms_of_injected_time() {
    let mut w = Window::new();
    w.open(true);
    w.typed("r", 1000);
    assert_eq!(w.current(), Some(1), "R finds Redo");
    w.typed("e", 1200);
    assert_eq!(w.current(), Some(1), "Re stays on Redo");
    w.typed("m", 2000);
    assert_eq!(w.current(), Some(2), "700 ms later M starts over and finds More");
}

#[test]
fn escape_closes_the_menu_and_the_opener_has_focus_again() {
    let mut w = Window::new();
    w.open(true);
    w.key(Named::Escape);
    assert!(w.overlays.host().menus().is_empty());
    assert_eq!(w.focus.focused(), Some(INVOKER));
    assert_eq!(w.driver().snapshot().focused, Some(INVOKER));
}

#[test]
fn a_press_outside_closes_the_menu_and_a_release_does_not() {
    let mut w = Window::new();
    w.open(false);
    w.driver().point_at(Point::new(420.0, 380.0));
    w.driver().events(&[Event::Mouse(mouse::Event::ButtonReleased(mouse::Button::Left))]);
    w.pump();
    assert_eq!(w.overlays.host().menus().len(), 1, "a release never dismisses");
    w.driver().events(&[Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left))]);
    w.pump();
    assert!(w.overlays.host().menus().is_empty(), "a press outside does");
    assert_eq!(w.gates.last(), Some(&false));
}

#[test]
fn a_press_on_the_opener_toggles_the_menu_closed() {
    let mut w = Window::new();
    w.open(false);
    let bounds = w.driver().snapshot().bounds_of(INVOKER).expect("the opener is laid out");
    w.driver().point_at(Point::new(bounds.x + 4.0, bounds.y + 4.0));
    w.driver().events(&[Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left))]);
    w.pump();
    assert!(w.overlays.host().menus().is_empty());
}

#[test]
fn hover_opens_a_submenu_at_the_core_deadline_and_not_before() {
    let mut w = Window::new();
    w.open(false);
    let id = w.overlays.host().menus()[0].id();
    let bounds = w.driver().snapshot().bounds_of(row_id(id, 2)).expect("the More row is laid out");
    w.now = 5000;
    w.driver().point_at(Point::new(bounds.x + 20.0, bounds.y + 10.0));
    w.driver().events(&[Event::Mouse(mouse::Event::CursorMoved { position: Point::new(bounds.x + 20.0, bounds.y + 10.0) })]);
    w.pump();
    assert_eq!(w.overlays.next_deadline(), Some(5150), "the hover intent is the core's 150 ms");
    let (outcome, _) = w.overlays.tick(&mut w.focus, 5149);
    w.carry(outcome);
    assert_eq!(w.overlays.host().menus().len(), 1);
    let (outcome, _) = w.overlays.tick(&mut w.focus, 5150);
    w.carry(outcome);
    assert_eq!(w.overlays.host().menus().len(), 2, "the submenu opened beside its row");
    assert_eq!(w.focus.focused(), Some(row_id(id, 2)), "and left the parent's focus alone");
    let child = w.driver().snapshot().bounds_of(row_id(w.overlays.host().menus()[1].id(), 0)).expect("the child's rows are in the tree");
    assert!(child.x >= bounds.x + bounds.width, "to the right of the row: {child:?} {bounds:?}");
}

#[test]
fn arrow_right_enters_the_submenu_and_a_command_there_runs_and_closes_the_tree() {
    let mut w = Window::new();
    w.open(true);
    w.typed("m", 100);
    w.key(Named::ArrowRight);
    let child = w.overlays.host().menus()[1].id();
    assert_eq!(w.focus.focused(), Some(row_id(child, 0)));
    w.key(Named::ArrowDown);
    w.key(Named::Enter);
    assert_eq!(w.runs, [CommandId::Paste]);
    assert!(w.overlays.host().menus().is_empty());
    assert_eq!(w.focus.focused(), Some(INVOKER));
}

#[test]
fn a_select_opens_from_space_enter_and_alt_down_chooses_with_the_arrows_and_gives_focus_back_on_escape() {
    for opening in ["space", "enter", "alt-down"] {
        let mut w = Window::new();
        w.driver().focus(SELECT);
        w.focus.focus(SELECT);
        w.sync();
        match opening {
            "space" => w.driver().press(Named::Space).len(),
            "enter" => w.driver().press(Named::Enter).len(),
            _ => {
                w.driver().modifiers(Modifiers::ALT);
                let n = w.driver().press(Named::ArrowDown).len();
                w.driver().modifiers(Modifiers::default());
                n
            }
        };
        w.pump();
        assert_eq!(w.overlays.host().menus().len(), 1, "{opening} opened the list");
        let id = w.overlays.host().menus()[0].id();
        assert_eq!(w.focus.focused(), Some(row_id(id, 1)), "{opening}: the list opens on the chosen option");
        assert!(w.focus.focus_visible(), "{opening}: a key opened it, so the ring shows");
        w.agree();
        w.key(Named::ArrowDown);
        assert_eq!(w.current(), Some(2));
        w.key(Named::Escape);
        assert!(w.overlays.host().menus().is_empty(), "{opening}: Escape closes");
        assert_eq!(w.focus.focused(), Some(SELECT), "{opening}: focus is back on the select");
        assert!(w.picks.is_empty(), "{opening}: nothing was chosen");
    }
}

#[test]
fn a_select_reports_the_message_of_the_chosen_option() {
    let mut w = Window::new();
    w.driver().focus(SELECT);
    w.focus.focus(SELECT);
    w.sync();
    w.driver().press(Named::Enter);
    w.pump();
    w.key(Named::ArrowUp);
    w.key(Named::Enter);
    assert_eq!(w.picks, [Message::Compose(false)], "the first option's message, once");
    assert!(w.overlays.host().menus().is_empty());
    assert_eq!(w.focus.focused(), Some(SELECT));
}

#[test]
fn a_press_on_a_select_opens_its_list_with_no_ring_until_a_key() {
    let mut w = Window::new();
    let bounds = w.driver().snapshot().bounds_of(SELECT).expect("laid out");
    w.driver().click(Point::new(bounds.x + 30.0, bounds.y + bounds.height / 2.0));
    w.pump();
    assert_eq!(w.overlays.host().menus().len(), 1);
    assert!(!w.focus.focus_visible(), "a pointer opened it");
    w.key(Named::ArrowDown);
    assert!(w.focus.focus_visible(), "the first key brings the ring");
}

#[test]
fn a_dialog_traps_focus_asks_its_guard_before_closing_and_returns_focus() {
    let mut w = Window::new();
    let ok = FocusId(60);
    let cancel = FocusId(61);
    let targets = vec![FocusTarget::new(cancel.0, FocusArea::Panels, TargetKind::Control), FocusTarget::new(ok.0, FocusArea::Panels, TargetKind::Control)];
    let (id, outcome) = w.overlays.open_dialog(true, targets, Some(ok), &mut w.focus);
    assert!(outcome.gate == Some(true) && outcome.release_keys, "a dialog closes the hotkey gate and releases held keys");
    assert_eq!(w.focus.focused(), Some(ok));
    assert_eq!(w.focus.tab(true), Some(cancel), "Tab stays inside the dialog");
    assert_eq!(w.focus.tab(true), Some(ok));
    // Escape asks the guard first: the dialog stays until the owner allows it.
    let outcome = w.overlays.escape(&mut w.focus);
    assert_eq!(outcome.check_close, [(id, Reason::Escape)]);
    assert_eq!(w.overlays.host().stack().entries().len(), 1);
    let outcome = w.overlays.resolve_close(id, false, &mut w.focus);
    assert!(outcome.check_close.is_empty() && w.overlays.host().stack().entries().len() == 1, "a refused guard keeps it open");
    assert!(w.overlays.escape(&mut w.focus).check_close.len() == 1, "and Escape asks again");
    let outcome = w.overlays.resolve_close(id, true, &mut w.focus);
    assert!(w.overlays.host().stack().entries().is_empty());
    assert_eq!(outcome.gate, Some(false));
    assert_eq!(w.focus.focused(), Some(INVOKER), "focus returned to what held it before");
}

#[test]
fn a_dialog_view_marks_its_buttons_as_one_scope_the_core_can_trap() {
    let palette = palette();
    let spec = Dialog {
        size: DialogSize::Sm,
        title: "Export".into(),
        description: None,
        body: Row::<Element<Message>>::new().boxed(),
        actions: vec![Button::new(FocusId(60), FocusArea::Panels, palette, "Cancel", Message::Idle).into_element(), Button::new(FocusId(61), FocusArea::Panels, palette, "Export", Message::Idle).into_element()],
        meta: None,
        error: None,
        close: Some((FocusId(62), Message::Idle)),
    };
    let layer: Element<'static, Message> = Layer::new(vec![modal(palette, 9, spec, WINDOW)]).boxed();
    let mut driver = Driver::new(layer, WINDOW, &styk_design::fonts::ALL);
    let snapshot = driver.snapshot();
    let ids: Vec<u64> = snapshot.targets(ScopeId(9)).iter().map(|target| target.id.0).collect();
    assert!(ids.contains(&60) && ids.contains(&61) && ids.contains(&62), "the dialog's controls are its scope's targets: {ids:?}");
    assert!(snapshot.targets(ScopeId::ROOT).is_empty(), "and nothing of the dialog leaks into the page's scope");
}

#[test]
fn messages_expire_at_the_core_deadline_and_a_close_button_dismisses_them() {
    use styk_core::overlay::messages::{Message as Toast, Tone};
    let mut w = Window::new();
    w.overlays.host_mut().messages_mut().push(Toast::new(1, "saved", Tone::Success, false, vec![]), 100);
    assert_eq!(w.overlays.next_deadline(), Some(4100), "a plain message lasts 4 s");
    let (_, expired) = w.overlays.tick(&mut w.focus, 4099);
    assert_eq!(expired, None);
    let (_, expired) = w.overlays.tick(&mut w.focus, 4100);
    assert_eq!(expired, Some(1));
    assert!(w.overlays.host().messages().current().is_none());
    let mut error = Toast::new(2, "failed", Tone::Error, false, vec![]);
    error.text = "The disk is full.".into();
    w.overlays.host_mut().messages_mut().push(error, 5000);
    assert_eq!(w.overlays.next_deadline(), None, "an error never expires");
    w.rebuild();
    let outcome = w.overlays.update(Message::Toast(styk_design::widgets::toast::Event::Dismiss(2)), &mut w.focus, 6000);
    w.carry(outcome);
    assert!(w.overlays.host().messages().current().is_none());
}

#[test]
fn the_tooltip_waits_500_ms_and_switches_at_once_within_300_ms_of_hiding() {
    use styk_core::overlay::tooltip::{Content, Tip};
    let tip = |target| Tip { target, content: Content { label: "Undo".into(), shortcut: "Ctrl+Z".into() } };
    let mut w = Window::new();
    w.overlays.host_mut().tooltip_mut().schedule(tip(1), 1000, false, false);
    assert_eq!(w.overlays.next_deadline(), Some(1500));
    let (_, _) = w.overlays.tick(&mut w.focus, 1499);
    assert!(w.overlays.host().tooltip().visible().is_none());
    let (_, _) = w.overlays.tick(&mut w.focus, 1500);
    assert!(w.overlays.host().tooltip().visible().is_some());
    w.overlays.host_mut().tooltip_mut().hide(1600);
    w.overlays.host_mut().tooltip_mut().schedule(tip(2), 1800, false, false);
    assert!(w.overlays.host().tooltip().visible().is_some(), "within 300 ms of hiding the next one shows at once");
    w.overlays.host_mut().tooltip_mut().hide(1900);
    w.overlays.host_mut().tooltip_mut().schedule(tip(3), 2300, false, false);
    assert!(w.overlays.host().tooltip().visible().is_none(), "later it waits again");
    w.overlays.host_mut().tooltip_mut().hide(2400);
    w.overlays.host_mut().tooltip_mut().schedule(tip(4), 3000, true, false);
    assert!(w.overlays.next_deadline().is_none(), "touch hover schedules nothing");
    w.overlays.host_mut().tooltip_mut().schedule(tip(4), 3000, true, true);
    assert_eq!(w.overlays.next_deadline(), Some(3500), "keyboard focus does");
}
