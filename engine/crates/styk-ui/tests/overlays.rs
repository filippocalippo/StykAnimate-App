//! The overlay views on the Core-owned host, through the production path and nothing injected.
//!
//! The window is the app's: the real widgets are mounted in the headless harness (`Driver`) under `overlays::layer_of` (the
//! function the app mounts), every message a widget sends goes through `message::update_at` and from there
//! `Core::dispatch(Command::Overlay { .. })` as `TopBand::update` does, the tasks it returns run on the tree rebuilt from the
//! new state (focus operations, the snapshot walk), the walk is forwarded to the core as the app forwards it, and raw inputs
//! pass through `message::raw_at` as `TopBand::raw` passes them. Time is injected: the wake the runtime schedules is a
//! `Command::Overlay { event: Tick, now }` the test sends at `Core::overlay_deadline()`.
//!
//! Every test asserts what is observable: the toolkit's focus equals the core's after every step, what the layer rendered,
//! and the messages the core's effects produced (`OverlayChoice`, `NotAvailable`, `OverlayEffect`).

use iced::advanced::widget::operate;
use iced::event::Status;
use iced::keyboard::{Key, Modifiers, key::Named};
use iced::widget::{Row, container, stack};
use iced::{Element, Event, Length, Padding, Point, Size, Widget as _, mouse};
use styk_core::app::Core;
use styk_core::commands::{Command, CommandId};
use styk_core::focus::{FocusArea, FocusId, FocusState, FocusTarget, TargetKind};
use styk_core::overlay::host::{Event as Overlay, message_button_id, row_id};
use styk_core::overlay::menu::{Anchor, Entry, Item};
use styk_core::overlay::messages::{Action, Message as Toast, Tone};
use styk_core::overlay::placement::Rect;
use styk_core::overlay::tooltip::Content;
use styk_core::overlay::{Effect as OverlayEffect, Kind, Reason};
use styk_design::widgets::button::{Button, IconButton};
use styk_design::widgets::dialog::{Dialog, DialogSize, modal};
use styk_design::widgets::focus::{self, Snapshot};
use styk_design::widgets::select::{Choice, Select};
use styk_design::widgets::testing::{Driver, key_event};
use styk_design::Theme;
use styk_ui::message::{self, Message, SelectRequest};
use styk_ui::overlays;

const OPENER: FocusId = FocusId(7);
const SELECT: FocusId = FocusId(8);
const DIALOG_OPENER: FocusId = FocusId(9);
const CANCEL: FocusId = FocusId(60);
const OK: FocusId = FocusId(61);
const WINDOW: Size = Size::new(640.0, 420.0);
const OPENER_AT: Rect = Rect { x: 24.0, y: 24.0, width: 32.0, height: 32.0 };

fn palette() -> &'static styk_design::Palette {
    Theme::Light.palette()
}

fn row(command: CommandId, label: &str) -> Entry {
    Entry::Item(Item::new(command, label))
}

fn menu_rows() -> Vec<Entry> {
    vec![
        row(CommandId::ZoomMenu, "Zoom"),
        row(CommandId::LayoutMenu, "Layout"),
        Entry::Separator,
        Entry::Item(Item { submenu: Some(vec![row(CommandId::Zoom25, "Copy"), row(CommandId::Zoom50, "Paste")]), ..Item::new(CommandId::Menu, "More") }),
        Entry::Item(Item { disabled: true, reason: "Nothing selected".into(), ..Item::new(CommandId::Delete, "Delete") }),
    ]
}

/// A list of `count` numbered rows, the 20th of which opens a submenu of as many.
fn tall_rows(count: usize, submenu_at: Option<usize>) -> Vec<Entry> {
    (0..count)
        .map(|n| match submenu_at {
            Some(at) if at == n => Entry::Item(Item { submenu: Some(tall_rows(count, None)), ..Item::new(CommandId::Menu, format!("Row {n}")) }),
            _ => row(CommandId::ZoomMenu, &format!("Row {n}")),
        })
        .collect()
}

fn open_menu(entries: Vec<Entry>, now: u64) -> Message {
    Message::Command(Command::Overlay { event: Overlay::OpenMenu { entries, anchor: Anchor::Root(OPENER_AT), invoker: Some(OPENER), keyboard: false }, now })
}

/// What the window shows besides the overlay layer.
#[derive(Clone, Copy, PartialEq)]
enum Page {
    /// An opener, a select and a button that opens a dialog.
    Controls,
    /// An opener only, in a short window (a tall menu has to scroll).
    Short,
}

/// The app's window: the Core, the toolkit's tree and what the runtime keeps between steps.
struct App {
    core: Core,
    /// The band's own focus state, which the band (not the overlays) moves with Tab.
    shell: FocusState,
    driver: Option<Driver<'static, Message>>,
    now: u64,
    page: Page,
    size: Size,
    entries: Vec<Entry>,
    dialog: Option<u64>,
    /// What the core's effects came back as (`OverlayChoice`, `NotAvailable`, `OverlayEffect`, `MessageDismissed`).
    effects: Vec<Message>,
}

impl App {
    fn new(page: Page, size: Size) -> App {
        let mut app = App { core: Core::default(), shell: FocusState::new(), driver: None, now: 0, page, size, entries: menu_rows(), dialog: None, effects: Vec::new() };
        app.rebuild();
        app.walk();
        app
    }

    fn view(&self) -> Element<'static, Message> {
        let palette = palette();
        let now = self.now;
        let opener = IconButton::new(OPENER, FocusArea::TopBand, palette, "more", open_menu(self.entries.clone(), now))
            .tooltip(Content { label: "Menu".into(), shortcut: "Alt+M".into() }, Message::Tooltip)
            .into_element();
        let mut parts: Vec<Element<'static, Message>> = vec![opener];
        if self.page == Page::Controls {
            let options = vec![Choice { label: "Linear".into(), disabled: false }, Choice { label: "Hold".into(), disabled: false }, Choice { label: "Ease".into(), disabled: false }];
            let picks = vec![Message::Command(Command::Run(CommandId::ZoomMenu)), Message::Command(Command::Run(CommandId::LayoutMenu)), Message::Command(Command::Run(CommandId::Menu))];
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
            parts.push(container(select).width(Length::Fixed(160.0)).boxed());
            let targets = vec![FocusTarget::new(CANCEL.0, FocusArea::Panels, TargetKind::Control), FocusTarget::new(OK.0, FocusArea::Panels, TargetKind::Control)];
            let open = Message::Command(Command::Overlay { event: Overlay::OpenOverlay { kind: Kind::Dialog, guarded: true, targets, initial: Some(OK) }, now });
            parts.push(Button::new(DIALOG_OPENER, FocusArea::Panels, palette, "Export", open).into_element());
        }
        let page = container(Row::with_children(parts).spacing(16.0)).padding(Padding { top: 24.0, left: 24.0, ..Padding::ZERO }).width(Length::Fill).height(Length::Fill);
        let host: &'static styk_core::overlay::host::Host = Box::leak(Box::new(self.core.overlays().clone()));
        let mut owned = Vec::new();
        if let Some(id) = self.dialog {
            let spec = Dialog {
                size: DialogSize::Sm,
                title: "Export".into(),
                description: None,
                body: Row::<Element<Message>>::new().boxed(),
                actions: vec![Button::new(CANCEL, FocusArea::Panels, palette, "Cancel", Message::Idle).into_element(), Button::new(OK, FocusArea::Panels, palette, "Export", Message::Idle).into_element()],
                meta: None,
                error: None,
                close: None,
            };
            owned.push(modal(palette, id, spec, self.size, host.phase(id)));
        }
        let layer = overlays::layer_of(host, self.core.focus().focus_visible(), palette, 0.0, None, owned);
        stack![page.boxed(), layer].boxed()
    }

    fn rebuild(&mut self) {
        let view = self.view();
        self.driver = Some(match self.driver.take() {
            Some(driver) => driver.rebuild(view),
            None => Driver::new(view, self.size, &styk_design::fonts::ALL),
        });
    }

    fn driver(&mut self) -> &mut Driver<'static, Message> {
        self.driver.as_mut().expect("the driver exists")
    }

    /// `TopBand::snapshot` and its forwarding: the walk of the rebuilt tree reaches the band's focus state and the core.
    fn walk(&mut self) {
        let snapshot = self.driver().snapshot();
        focus::sync(&mut self.shell, &snapshot);
        let task = message::update_at(&mut self.core, Message::Snapshot(snapshot), self.now);
        self.finish(task);
    }

    /// The runtime's order: the state was updated, the view is rebuilt, then the task's actions run on the new tree.
    fn finish(&mut self, task: iced::Task<Message>) {
        self.rebuild();
        let outputs = self.driver().run(task);
        self.effects.extend(outputs);
        // The next frame: widgets that follow state (a menu bringing the keyboard's row into view) do it on a redraw.
        self.driver().redraw();
    }

    /// What `TopBand::update` does with a message of the editor.
    fn send(&mut self, message: Message) {
        let task = message::update_at(&mut self.core, message, self.now);
        self.sync_dialog();
        self.finish(task);
        let snapshot = self.driver().snapshot();
        focus::sync(&mut self.shell, &snapshot);
        let task = message::update_at(&mut self.core, Message::Snapshot(snapshot), self.now);
        self.finish(task);
    }

    /// The dialog the owner mounts is the stack's dialog.
    fn sync_dialog(&mut self) {
        self.dialog = self.core.overlays().stack().entries().iter().find(|entry| entry.kind == Kind::Dialog).map(|entry| entry.id);
    }

    /// Delivers what the widgets published.
    fn settle(&mut self) {
        for _ in 0..16 {
            let messages = self.driver().messages();
            if messages.is_empty() {
                return;
            }
            for message in messages {
                self.send(message);
            }
        }
        panic!("the widgets kept publishing");
    }

    /// One raw input: the widgets see it, then the window routes it as `TopBand::raw` does.
    fn input(&mut self, event: Event) {
        if let Event::Mouse(mouse::Event::CursorMoved { position }) = &event {
            self.driver().point_at(*position);
        }
        let status = self.driver().events(std::slice::from_ref(&event))[0];
        self.settle();
        let ignored = status == Status::Ignored;
        if let Some(task) = message::raw_at(&mut self.core, &event, ignored, self.now) {
            self.sync_dialog();
            self.finish(task);
            self.walk();
        } else if ignored && let Some(id) = focus::navigate(&mut self.shell, &event) {
            self.finish(operate(focus::focus(id)).discard());
            self.walk();
        }
        // The band reads the tree's focus after every raw input it is given (`Message::Raw` reads focus), and the core follows.
        self.walk();
        self.settle();
        self.agree();
    }

    fn move_to(&mut self, point: Point) {
        self.input(Event::Mouse(mouse::Event::CursorMoved { position: point }));
    }

    fn press_button(&mut self) {
        self.input(Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left)));
    }

    fn release_button(&mut self) {
        self.input(Event::Mouse(mouse::Event::ButtonReleased(mouse::Button::Left)));
    }

    fn click(&mut self, point: Point) {
        self.move_to(point);
        self.press_button();
        self.release_button();
    }

    fn key(&mut self, named: Named) {
        self.key_with(named, Modifiers::default());
    }

    fn key_with(&mut self, named: Named, modifiers: Modifiers) {
        self.input(key_event(Key::Named(named), None, modifiers, true));
        self.input(key_event(Key::Named(named), None, modifiers, false));
    }

    fn typed(&mut self, text: &str, now: u64) {
        self.now = now;
        self.input(key_event(Key::Character(text.into()), Some(text), Modifiers::default(), true));
        self.input(key_event(Key::Character(text.into()), None, Modifiers::default(), false));
    }

    /// The wake the runtime scheduled at the core's deadline fires `ms` later; time is the test's.
    fn advance(&mut self, ms: u64) {
        self.now += ms;
        self.send(Message::Command(Command::Overlay { event: Overlay::Tick, now: self.now }));
        self.agree();
    }

    /// Advances to the deadline the core asked for, as the runtime's wake does.
    fn wake(&mut self) -> u64 {
        let deadline = self.core.overlay_deadline().expect("the core asked for a wake");
        self.now = self.now.max(deadline);
        self.send(Message::Command(Command::Overlay { event: Overlay::Tick, now: self.now }));
        deadline
    }

    /// The toolkit's focus is the core's.
    fn agree(&mut self) {
        let snapshot = self.driver().snapshot();
        assert_eq!(snapshot.focused, self.core.focus().focused(), "the toolkit and the core hold the same focus");
    }

    fn bounds(&mut self, id: FocusId) -> iced::Rectangle {
        self.driver().snapshot().bounds_of(id).unwrap_or_else(|| panic!("{id:?} is in the tree"))
    }

    fn centre(&mut self, id: FocusId) -> Point {
        let b = self.bounds(id);
        Point::new(b.x + b.width / 2.0, b.y + b.height / 2.0)
    }

    fn snapshot(&mut self) -> Snapshot {
        self.driver().snapshot()
    }

    fn menu(&self, at: usize) -> &styk_core::overlay::host::OpenMenu {
        &self.core.overlays().menus()[at]
    }

    fn open(&mut self) {
        let opener = self.centre(OPENER);
        self.click(opener);
        assert!(!self.core.overlays().menus().is_empty(), "the opener's press opened its menu");
        // Its entry runs its 160 ms; the frames the core asked for have passed.
        self.advance(300);
    }

    /// The band's Tab walk (`focus::navigate` on its own state) until `id` holds focus.
    fn tab_to(&mut self, id: FocusId) {
        for _ in 0..12 {
            if self.core.focus().focused() == Some(id) {
                return;
            }
            self.key(Named::Tab);
        }
        panic!("Tab never reached {id:?}");
    }

    fn rendered_ink(&mut self, row: u32, from: u32, to: u32, ink: [u8; 3]) -> usize {
        let (pixels, size) = self.driver().render(&iced::Theme::Light, iced::Color::WHITE, 1.0);
        (from..to).filter(|x| pixels[((row * size.width + x) * 4) as usize..][..3] == ink).count()
    }
}

#[test]
fn the_openers_press_opens_its_menu_and_arrows_home_end_and_a_disabled_row_follow_the_keyboard() {
    let mut app = App::new(Page::Controls, WINDOW);
    app.open();
    let id = app.menu(0).id();
    assert_eq!(app.core.focus().focused(), Some(row_id(id, 0)), "the first row holds focus");
    assert_eq!(app.snapshot().focused, Some(row_id(id, 0)), "in the toolkit too");
    app.key(Named::ArrowDown);
    app.key(Named::ArrowDown);
    app.key(Named::ArrowDown);
    assert_eq!(app.menu(0).current(), Some(3), "the disabled row takes focus");
    app.key(Named::Enter);
    assert!(app.effects.iter().all(|effect| !matches!(effect, Message::NotAvailable(_))), "and does not run");
    app.key(Named::ArrowDown);
    assert_eq!(app.menu(0).current(), Some(0), "arrows wrap");
    app.key(Named::End);
    assert_eq!(app.menu(0).current(), Some(3));
    app.key(Named::Home);
    app.key(Named::Enter);
    assert!(app.effects.contains(&Message::NotAvailable(CommandId::ZoomMenu)), "Enter on Zoom dispatched its command: {:?}", app.effects);
    assert!(app.core.overlays().menus().is_empty());
    assert_eq!(app.core.focus().focused(), Some(OPENER), "focus is back on the opener");
}

#[test]
fn typeahead_follows_the_injected_clock() {
    let mut app = App::new(Page::Controls, WINDOW);
    app.open();
    app.typed("l", 1000);
    assert_eq!(app.menu(0).current(), Some(1), "L finds Layout");
    app.typed("o", 1200);
    assert_eq!(app.menu(0).current(), Some(1), "Lo matches nothing and stays");
    app.typed("z", 2000);
    assert_eq!(app.menu(0).current(), Some(0), "700 ms later Z starts over and finds Zoom");
}

#[test]
fn escape_closes_and_a_press_outside_closes_while_a_release_does_not() {
    let mut app = App::new(Page::Controls, WINDOW);
    app.open();
    app.key(Named::Escape);
    assert!(app.core.overlays().menus().is_empty());
    assert_eq!(app.core.focus().focused(), Some(OPENER));
    app.open();
    app.move_to(Point::new(560.0, 380.0));
    app.release_button();
    assert_eq!(app.core.overlays().menus().len(), 1, "a release never dismisses");
    app.press_button();
    assert!(app.core.overlays().menus().is_empty(), "a press outside does");
}

#[test]
fn the_opener_pressed_again_closes_the_menu_once() {
    let mut app = App::new(Page::Controls, WINDOW);
    app.open();
    let opener = app.centre(OPENER);
    app.click(opener);
    assert!(app.core.overlays().menus().is_empty(), "the second press on the opener toggled it closed, and did not reopen it");
}

#[test]
fn the_pointer_filling_rows_follows_it_and_leaving_a_row_or_the_menus_clears_what_was_pending() {
    let mut app = App::new(Page::Controls, WINDOW);
    app.open();
    let id = app.menu(0).id();
    let (first, second, more) = (app.centre(row_id(id, 0)), app.centre(row_id(id, 1)), app.centre(row_id(id, 2)));
    app.move_to(first);
    assert_eq!(app.menu(0).hovered(), Some(0));
    app.move_to(second);
    assert_eq!(app.menu(0).hovered(), Some(1), "moving between rows moves the fill");
    // A row that opens a submenu starts the hover intent; leaving every menu before it fires cancels it.
    app.move_to(more);
    assert!(app.core.overlay_deadline().is_some(), "the hover intent is scheduled");
    app.move_to(Point::new(560.0, 380.0));
    assert_eq!(app.menu(0).hovered(), None, "leaving the menus clears the fill");
    assert_eq!(app.core.overlay_deadline(), None, "and the intent died with the pointer");
    app.advance(500);
    assert_eq!(app.core.overlays().menus().len(), 1, "no submenu opened");
}

#[test]
fn moving_between_rows_up_or_down_keeps_the_row_it_reached_and_a_submenu_deadline_still_fires() {
    let mut app = App::new(Page::Controls, WINDOW);
    app.entries = tall_rows(6, Some(2));
    app.rebuild();
    app.open();
    let id = app.menu(0).id();
    let at = |app: &mut App, n: usize| app.centre(row_id(id, n));
    // Down onto the submenu row: its intent is scheduled, and the row stays hovered after the row above leaves.
    let (above, row2) = (at(&mut app, 1), at(&mut app, 2));
    app.now = 4000;
    app.move_to(above);
    app.move_to(row2);
    assert_eq!(app.menu(0).hovered(), Some(2), "moving down keeps the row reached");
    assert_eq!(app.core.overlay_deadline(), Some(4150), "and the submenu row's hover intent is pending");
    let (from, onto) = (at(&mut app, 3), at(&mut app, 2));
    app.move_to(from);
    assert_eq!(app.core.overlay_deadline(), None, "leaving the submenu row for the next cancelled its intent");
    // Up: the new row's hover arrives before the old row's leave, which must not clear it.
    app.now = 5000;
    app.move_to(from);
    app.move_to(from);
    assert_eq!(app.menu(0).hovered(), Some(3));
    app.move_to(onto);
    assert_eq!(app.menu(0).hovered(), Some(2), "moving up keeps the row reached");
    assert_eq!(app.core.overlay_deadline(), Some(5150), "and the submenu row's hover intent is still pending");
    app.advance(150);
    assert_eq!(app.core.overlays().menus().len(), 2, "the deadline fired and opened the submenu");
    // Up again, off a row that has no submenu, and down onto rows in order.
    let (r1, r0) = (at(&mut app, 1), at(&mut app, 0));
    app.move_to(r1);
    assert_eq!(app.menu(0).hovered(), Some(1), "moving up past the submenu row");
    app.move_to(r0);
    assert_eq!(app.menu(0).hovered(), Some(0));
    for n in 1..5 {
        let down = at(&mut app, n);
        app.move_to(down);
        assert_eq!(app.menu(0).hovered(), Some(n), "moving down to row {n}");
    }
    // Leaving the whole menu still clears it.
    app.move_to(Point::new(560.0, 380.0));
    assert_eq!(app.menu(0).hovered(), None);
}

#[test]
fn hover_opens_a_submenu_at_the_core_deadline_and_the_pointer_can_cross_into_it() {
    let mut app = App::new(Page::Controls, WINDOW);
    app.open();
    let id = app.menu(0).id();
    let more = app.centre(row_id(id, 2));
    app.now = 5000;
    app.move_to(more);
    assert_eq!(app.core.overlay_deadline(), Some(5150), "the 150 ms hover intent");
    app.advance(149);
    assert_eq!(app.core.overlays().menus().len(), 1);
    app.advance(1);
    assert_eq!(app.core.overlays().menus().len(), 2, "the submenu opened");
    let child = app.menu(1).id();
    assert_eq!(app.core.focus().focused(), Some(row_id(id, 2)), "and left the parent's focus alone");
    let into = app.centre(row_id(child, 1));
    assert!(into.x > more.x, "the child is beside its row");
    app.move_to(into);
    assert_eq!(app.core.overlays().menus().len(), 2, "moving from the parent into the child keeps it open");
    assert_eq!(app.menu(1).hovered(), Some(1));
    app.advance(1000);
    assert_eq!(app.core.overlays().menus().len(), 2);
}

#[test]
fn a_select_opens_from_space_enter_alt_down_and_a_press_and_chooses_through_the_core() {
    for opening in ["space", "enter", "alt-down", "press"] {
        let mut app = App::new(Page::Controls, WINDOW);
        let select = app.centre(SELECT);
        match opening {
            "press" => app.click(select),
            _ => {
                // Tab walks the page to the select (the band's navigation), then the key opens it.
                app.tab_to(SELECT);
                assert_eq!(app.core.focus().focused(), Some(SELECT), "{opening}: the select holds focus");
                match opening {
                    "space" => app.key(Named::Space),
                    "enter" => app.key(Named::Enter),
                    _ => app.key_with(Named::ArrowDown, Modifiers::ALT),
                }
            }
        }
        assert_eq!(app.core.overlays().menus().len(), 1, "{opening} opened the list");
        let id = app.menu(0).id();
        assert_eq!(app.core.focus().focused(), Some(row_id(id, 1)), "{opening}: the list opens on the chosen option");
        assert_eq!(app.core.focus().focus_visible(), opening != "press", "{opening}: the ring shows for a key only");
        app.key(Named::ArrowDown);
        app.key(Named::ArrowUp);
        app.key(Named::ArrowUp);
        app.key(Named::Enter);
        assert!(app.core.overlays().menus().is_empty(), "{opening}: choosing closes it");
        assert!(app.effects.contains(&Message::OverlayChoice { invoker: SELECT, index: 0 }), "{opening}: the core reported the choice: {:?}", app.effects);
        assert!(app.effects.contains(&Message::NotAvailable(CommandId::ZoomMenu)), "{opening}: and dispatched the option's command");
        assert_eq!(app.core.focus().focused(), Some(SELECT), "{opening}: focus is back on the select");
    }
}

#[test]
fn a_select_pressed_twice_closes_once_and_does_not_reopen() {
    let mut app = App::new(Page::Controls, WINDOW);
    let select = app.centre(SELECT);
    app.click(select);
    assert_eq!(app.core.overlays().menus().len(), 1);
    app.click(select);
    assert!(app.core.overlays().menus().is_empty(), "the second press closed the list and the opener did not reopen it");
    app.click(select);
    assert_eq!(app.core.overlays().menus().len(), 1, "a third, separate press opens it again");
}

#[test]
fn escape_on_an_open_select_returns_focus_to_it_and_chooses_nothing() {
    let mut app = App::new(Page::Controls, WINDOW);
    let select = app.centre(SELECT);
    app.click(select);
    app.key(Named::Escape);
    assert!(app.core.overlays().menus().is_empty());
    assert_eq!(app.core.focus().focused(), Some(SELECT));
    assert!(app.effects.iter().all(|effect| !matches!(effect, Message::OverlayChoice { .. })));
}

#[test]
fn a_dialog_traps_tab_asks_its_guard_on_escape_and_returns_focus() {
    let mut app = App::new(Page::Controls, WINDOW);
    let opener = app.centre(DIALOG_OPENER);
    app.click(opener);
    let id = app.dialog.expect("the dialog is the stack's");
    assert_eq!(app.core.focus().focused(), Some(OK));
    assert_eq!(app.snapshot().focused, Some(OK), "the toolkit holds focus on its button");
    assert!(app.snapshot().targets(styk_core::focus::ScopeId(id)).iter().any(|target| target.id == CANCEL), "the dialog's buttons are its scope's targets");
    // The window routes the Tab no widget took to the core while a dialog is open: it stays inside.
    app.key(Named::Tab);
    assert_eq!(app.core.focus().focused(), Some(CANCEL));
    app.key(Named::Tab);
    assert_eq!(app.core.focus().focused(), Some(OK), "the walk wrapped inside the dialog, never reaching the page");
    app.key(Named::Escape);
    assert!(app.effects.contains(&Message::OverlayEffect(OverlayEffect::CheckClose { id, reason: Reason::Escape })), "Escape asked the guard: {:?}", app.effects);
    assert_eq!(app.core.overlays().stack().entries().len(), 1, "and the dialog stays until the owner allows it");
    app.send(Message::Command(Command::Overlay { event: Overlay::ResolveClose { id, allow: false }, now: 0 }));
    assert_eq!(app.core.overlays().stack().entries().len(), 1, "a refusal keeps it");
    app.key(Named::Escape);
    app.send(Message::Command(Command::Overlay { event: Overlay::ResolveClose { id, allow: true }, now: 0 }));
    app.sync_dialog();
    app.rebuild();
    app.walk();
    assert!(app.core.overlays().stack().entries().is_empty());
    assert_eq!(app.core.focus().focused(), Some(DIALOG_OPENER), "focus returned to what opened it");
    assert!(app.snapshot().targets(styk_core::focus::ScopeId(id)).is_empty(), "and the dialog's buttons left the tree");
    app.agree();
}

#[test]
fn a_dialog_enters_over_240_ms_and_the_core_stops_asking_for_frames_when_it_is_settled() {
    let mut app = App::new(Page::Controls, WINDOW);
    let opener = app.centre(DIALOG_OPENER);
    app.now = 1000;
    app.click(opener);
    let id = app.dialog.expect("open");
    assert_eq!(app.core.overlays().phase(id), 0.0);
    assert!(app.core.overlay_deadline().is_some(), "the core asks for the next frame while it enters");
    // Frame by frame at the deadlines the core asks for, as the runtime's wake does.
    for _ in 0..40 {
        if app.core.overlay_deadline().is_none() {
            break;
        }
        app.wake();
    }
    assert_eq!(app.core.overlays().phase(id), 1.0);
    assert_eq!(app.core.overlay_deadline(), None, "nothing redraws while no animation runs");
}

#[test]
fn a_tooltip_shows_after_500_ms_of_hover_at_its_control_and_a_press_hides_it() {
    let mut app = App::new(Page::Controls, WINDOW);
    let ink = palette().surface_inverse;
    let ink = [ink.r, ink.g, ink.b];
    let opener = app.centre(OPENER);
    app.now = 1000;
    app.move_to(opener);
    assert_eq!(app.core.overlay_deadline(), Some(1500), "the core's 500 ms delay");
    app.advance(499);
    assert_eq!(app.rendered_ink(75, 8, 120, ink), 0, "nothing is drawn before the delay");
    app.advance(1);
    assert!(app.core.overlays().tooltip().visible().is_some());
    assert!(app.rendered_ink(75, 8, 120, ink) > 20, "the tooltip's pill is drawn under its control");
    app.press_button();
    assert_eq!(app.rendered_ink(75, 8, 120, ink), 0, "a press hides it");
}

#[test]
fn keyboard_focus_shows_a_tooltip_with_no_pointer_at_all() {
    let mut app = App::new(Page::Controls, WINDOW);
    let ink = palette().surface_inverse;
    let ink = [ink.r, ink.g, ink.b];
    app.now = 2000;
    app.key(Named::Tab);
    assert_eq!(app.core.focus().focused(), Some(OPENER), "Tab reached the opener");
    app.advance(500);
    assert!(app.core.overlays().tooltip().visible().is_some(), "keyboard focus shows it");
    assert!(app.rendered_ink(75, 8, 120, ink) > 20);
    app.key(Named::Escape);
    assert!(app.core.overlays().tooltip().visible().is_none(), "Escape hides it");
}

#[test]
fn a_message_waits_while_the_pointer_or_keyboard_focus_is_on_it_and_its_action_dispatches() {
    let mut app = App::new(Page::Controls, WINDOW);
    let undo = Action { command: CommandId::ZoomMenu.into(), label: "Undo".into(), dismiss: true, outline: false };
    app.now = 100;
    app.send(Message::Command(Command::Overlay { event: Overlay::ShowMessage(Toast::new(1, "deleted", Tone::Warning, false, vec![undo])), now: 100 }));
    assert!(app.core.overlay_deadline().is_some(), "the message's entry and its timeout are due");
    let button = message_button_id(1, 0);
    let on = app.centre(button);
    app.move_to(on);
    app.advance(9000);
    assert!(app.core.overlays().messages().current().is_some(), "hovered: the 8 s timeout waits");
    app.move_to(Point::new(560.0, 380.0));
    app.advance(9000);
    assert!(app.core.overlays().messages().current().is_none(), "left: it resumed and expired");
    assert!(app.effects.contains(&Message::MessageDismissed(1)));

    // Keyboard focus on its button waits too: the core derives it from the focus walk.
    app.now = 20000;
    let undo = Action { command: CommandId::ZoomMenu.into(), label: "Undo".into(), dismiss: true, outline: false };
    app.send(Message::Command(Command::Overlay { event: Overlay::ShowMessage(Toast::new(2, "again", Tone::Warning, false, vec![undo])), now: 20000 }));
    app.tab_to(message_button_id(2, 0));
    assert_eq!(app.core.focus().focused(), Some(message_button_id(2, 0)), "Tab reached the message's button");
    app.advance(9000);
    assert!(app.core.overlays().messages().current().is_some(), "focus on its button: it waits");
    let on = app.centre(message_button_id(2, 0));
    app.click(on);
    assert!(app.effects.contains(&Message::NotAvailable(CommandId::ZoomMenu)), "the action dispatched its command");
    assert!(app.core.overlays().messages().current().is_none(), "and dismissed the message");
}

#[test]
fn a_tall_root_menu_scrolls_to_the_last_row_by_keyboard_and_back_by_wheel() {
    let mut app = App::new(Page::Short, Size::new(640.0, 300.0));
    app.entries = tall_rows(40, Some(20));
    app.rebuild();
    app.open();
    let id = app.menu(0).id();
    let first = app.bounds(row_id(id, 0));
    assert!(first.y >= 0.0 && first.y + first.height <= 300.0, "the first row is in the window");
    let last = row_id(id, 39);
    assert!(app.bounds(last).y > 300.0, "the last row is below the window until it scrolls");
    app.key(Named::End);
    assert_eq!(app.menu(0).current(), Some(39));
    let at = app.bounds(last);
    assert!(at.y >= 0.0 && at.y + at.height <= 300.0, "the keyboard brought the last row into view: {at:?}");
    // The wheel scrolls it back up over the menu.
    let over = Point::new(at.x + 10.0, at.y);
    app.move_to(over);
    let before = app.bounds(row_id(id, 0)).y;
    app.input(Event::Mouse(mouse::Event::WheelScrolled { delta: mouse::ScrollDelta::Lines { x: 0.0, y: 30.0 } }));
    assert!(app.bounds(row_id(id, 0)).y > before, "the wheel moved the rows");
    app.agree();
}

#[test]
fn rows_scrolled_out_of_view_take_no_pointer_while_the_visible_ones_still_do() {
    let mut app = App::new(Page::Short, Size::new(640.0, 300.0));
    app.entries = tall_rows(40, None);
    app.rebuild();
    app.open();
    let id = app.menu(0).id();
    app.key(Named::End);
    assert_eq!(app.menu(0).current(), Some(39));
    // The rows the viewport shows hover; walk up from the last one until the pointer reaches rows it has scrolled away.
    let mut shown = 0;
    let mut last_shown = 39;
    let mut clipped = None;
    for n in (0..40).rev() {
        let centre = app.centre(row_id(id, n));
        app.move_to(centre);
        if app.menu(0).hovered() == Some(n) {
            assert!(clipped.is_none(), "row {n} hovers above a row that did not");
            shown += 1;
            last_shown = n;
        } else if clipped.is_none() {
            clipped = Some(n);
        } else {
            assert_eq!(app.menu(0).hovered(), None, "row {n} is clipped away and took the pointer");
            assert_eq!(app.menu(0).current(), Some(last_shown), "and the keyboard's row did not move");
        }
    }
    assert!(shown >= 5, "the visible rows hovered ({shown})");
    assert!(clipped.is_some(), "some rows are scrolled out of view");
    // The release still ends a press cleanly after all that.
    app.release_button();
    app.agree();
}

#[test]
fn a_tall_submenu_scrolls_too() {
    let mut app = App::new(Page::Short, Size::new(640.0, 300.0));
    app.entries = tall_rows(40, Some(2));
    app.rebuild();
    app.open();
    let id = app.menu(0).id();
    app.key(Named::ArrowDown);
    app.key(Named::ArrowDown);
    app.key(Named::ArrowRight);
    assert_eq!(app.core.overlays().menus().len(), 2, "the keyboard opened the submenu");
    let child = app.menu(1).id();
    assert_eq!(app.core.focus().focused(), Some(row_id(child, 0)));
    app.key(Named::End);
    let last = app.bounds(row_id(child, 39));
    assert!(last.y >= 0.0 && last.y + last.height <= 300.0, "the submenu's last row is in view: {last:?}");
    let _ = id;
    let over = Point::new(last.x + 10.0, last.y);
    app.move_to(over);
    let before = app.bounds(row_id(child, 0)).y;
    app.input(Event::Mouse(mouse::Event::WheelScrolled { delta: mouse::ScrollDelta::Lines { x: 0.0, y: 30.0 } }));
    assert!(app.bounds(row_id(child, 0)).y > before, "the wheel scrolled the submenu");
    app.agree();
}

#[test]
fn nothing_is_asked_of_the_runtime_while_nothing_animates_or_waits() {
    let mut app = App::new(Page::Controls, WINDOW);
    assert_eq!(app.core.overlay_deadline(), None);
    app.open();
    app.advance(400);
    assert_eq!(app.core.overlay_deadline(), None, "a settled menu is quiet: no frames are asked for");
}
