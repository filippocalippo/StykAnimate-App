//! The component sheet: the field and focus pages (`stykanimate --screen component-sheet`).
//!
//! Every field role in every state, the focus ring on every kind of control, a roving toolbar, a slider and a select
//! that answer the keyboard, and a dialog with its Tab boundaries. It is the screen the design is looked at and tested
//! on (`docs/native/text-input.md` section 8); it holds the same wiring the application will: widgets report, the core's
//! `FocusState` decides, and the answers run as focus tasks.

use iced::advanced::widget::operate;
use iced::widget::{Column, Row, Stack, container, scrollable, slider, text};
use iced::{Element, Event, Length, Subscription, Task, Widget as _, event, keyboard, mouse};
use styk_core::controls::{Select, SelectKey, SelectOutcome, SliderKey, slider_value};
use styk_core::field::{FieldValue, Role};
use styk_core::focus::{FocusArea, FocusId, FocusState, ScopeId};
use styk_core::number::{self, Baseline, StepKeys};
use styk_core::roving::Orientation;
use styk_core::text_entry::{Chord, command_allowed};
use styk_design::widgets::dir::Dir;
use styk_design::widgets::field::EditField;
use styk_design::widgets::focus::{self, Focusable, Keys, Ring, Scope};
use styk_design::widgets::number_field::{NumberField, Scrub};
use styk_design::widgets::roving::{RovingGroup, RovingItem};
use styk_design::{Theme, tokens};

const MODAL: ScopeId = ScopeId(1);

/// Focus IDs of the sheet's targets.
pub mod ids {
    use styk_core::focus::FocusId;

    pub const THEME: FocusId = FocusId(1);
    pub const DIR: FocusId = FocusId(2);
    pub const DIALOG: FocusId = FocusId(3);
    pub const DISABLED: FocusId = FocusId(4);
    pub const NAME: FocusId = FocusId(10);
    pub const SEARCH: FocusId = FocusId(11);
    pub const NOTES: FocusId = FocusId(12);
    pub const NUMBER_LABEL: FocusId = FocusId(20);
    pub const NUMBER: FocusId = FocusId(21);
    pub const TOOLBAR: FocusId = FocusId(30);
    pub const SLIDER: FocusId = FocusId(40);
    pub const SELECT: FocusId = FocusId(41);
    pub const TOGGLE: FocusId = FocusId(42);
    pub const DIALOG_OK: FocusId = FocusId(50);
    pub const DIALOG_NAME: FocusId = FocusId(51);
    pub const DIALOG_CANCEL: FocusId = FocusId(52);
}

const SELECT_OPTIONS: [&str; 4] = ["Linear", "Ease in", "Ease out", "Hold"];
const TOOLBAR_ICONS: [&str; 5] = ["move", "brush", "eraser", "hand", "zoom-in"];

/// Which text field a message is about.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Which {
    Name,
    Search,
    Notes,
    Dialog,
}

#[derive(Clone, Debug)]
pub enum Message {
    Input(Which, String),
    Enter(Which),
    Escape(Which),
    Clear(Which),
    Compose(bool),
    NumberInput(String),
    NumberEnter,
    NumberEscape,
    Scrub(Scrub),
    ToolbarMove(usize),
    ToolbarPress(usize),
    Slider(SliderKey, StepKeys),
    SliderTo(f64),
    SelectKey(SelectKey),
    ToggleSwitch,
    ToggleTheme,
    ToggleDir,
    OpenDialog,
    CloseDialog,
    Key(Event),
    PointerPressed,
    Snapshot(focus::Snapshot),
    /// Give a target focus (the input check, a command).
    Focus(FocusId),
    Noop,
}

/// The sheet's state.
pub struct Sheet {
    pub theme: Theme,
    pub dir: Dir,
    pub focus: FocusState,
    pub name: FieldValue,
    pub search: FieldValue,
    pub notes: FieldValue,
    pub dialog_name: FieldValue,
    pub number: f64,
    pub number_text: FieldValue,
    baseline: Baseline,
    scrub_start: f64,
    pub toolbar_active: usize,
    pub slider: f64,
    pub select: Select,
    pub switch_on: bool,
    pub dialog_open: bool,
    /// The last thing that happened, shown at the bottom.
    pub status: String,
    /// What the last walk of the tree found: where each target is.
    pub snapshot: focus::Snapshot,
}

impl Sheet {
    pub fn new(theme: Theme, dir: Dir) -> Sheet {
        Sheet {
            theme,
            dir,
            focus: FocusState::new(),
            name: FieldValue::new("Layer 1"),
            search: FieldValue::new(""),
            notes: FieldValue::new("Two lines\nof notes"),
            dialog_name: FieldValue::new("Untitled"),
            number: 45.25,
            number_text: FieldValue::new("45.25"),
            baseline: Baseline::new(45.25),
            scrub_start: 45.25,
            toolbar_active: 0,
            slider: 50.0,
            select: Select::new(0),
            switch_on: true,
            dialog_open: false,
            status: String::new(),
            snapshot: focus::Snapshot::default(),
        }
    }

    fn field_mut(&mut self, which: Which) -> &mut FieldValue {
        match which {
            Which::Name => &mut self.name,
            Which::Search => &mut self.search,
            Which::Notes => &mut self.notes,
            Which::Dialog => &mut self.dialog_name,
        }
    }

    fn after(&self) -> Task<Message> {
        operate(focus::snapshot()).map(Message::Snapshot)
    }

    fn focus_task(&self, id: FocusId) -> Task<Message> {
        operate(focus::focus(id)).discard().chain(self.after())
    }

    /// Handles a message; the answer is the focus work to run.
    pub fn update(&mut self, message: Message) -> Task<Message> {
        match message {
            Message::Input(which, text) => self.field_mut(which).input(text),
            Message::Enter(which) => {
                self.field_mut(which).commit();
                self.status = format!("{which:?}: Enter");
                if which == Which::Dialog {
                    return self.close_dialog();
                }
            }
            Message::Escape(which) => {
                self.field_mut(which).revert();
                self.status = format!("{which:?}: Escape");
                if which == Which::Dialog {
                    return self.close_dialog();
                }
            }
            Message::Clear(which) => self.field_mut(which).clear(),
            Message::Compose(composing) => self.focus.set_composing(composing),
            Message::NumberInput(text) => self.number_text.input(text),
            Message::NumberEnter => {
                match number::parse(self.number_text.text(), number::Range::default()) {
                    Ok(value) => {
                        self.number = value;
                        self.baseline.committed(value);
                    }
                    Err(_) => {}
                }
                self.number_text.set(number::format(self.number, 2));
            }
            Message::NumberEscape => {
                self.number = self.baseline.rollback();
                self.number_text.set(number::format(self.number, 2));
            }
            Message::Scrub(scrub) => return self.scrub(scrub),
            Message::ToolbarMove(index) => {
                self.toolbar_active = index;
                return self.focus_task(FocusId(ids::TOOLBAR.0 + index as u64));
            }
            Message::ToolbarPress(index) => self.status = format!("tool {}", TOOLBAR_ICONS[index]),
            Message::Slider(key, keys) => self.slider = slider_value(self.slider, 0.0, 100.0, 1.0, key, keys),
            Message::SliderTo(value) => self.slider = value,
            Message::SelectKey(key) => {
                let outcome = self.select.key(key, SELECT_OPTIONS.len(), |_| false);
                self.status = format!("select: {outcome:?}");
                if matches!(outcome, SelectOutcome::Closed | SelectOutcome::Chosen(_)) {
                    return self.focus_task(ids::SELECT);
                }
            }
            Message::ToggleSwitch => self.switch_on = !self.switch_on,
            Message::ToggleTheme => {
                self.theme = if self.theme == Theme::Light { Theme::Dark } else { Theme::Light };
            }
            Message::ToggleDir => self.dir = if self.dir.is_rtl() { Dir::Ltr } else { Dir::Rtl },
            Message::OpenDialog => {
                self.dialog_open = true;
                self.status = "dialog opened".into();
                // The scope opens once the next view has put its targets in the tree (the snapshot below).
                return self.after();
            }
            Message::CloseDialog => return self.close_dialog(),
            Message::Key(event) => return self.key(&event),
            Message::PointerPressed => self.focus.pointer_pressed(),
            Message::Snapshot(snapshot) => return self.synced(snapshot),
            Message::Focus(id) => return self.focus_task(id),
            Message::Noop => {}
        }
        self.after()
    }

    fn scrub(&mut self, scrub: Scrub) -> Task<Message> {
        match scrub {
            Scrub::Click => return self.focus_then_select(),
            Scrub::Begin => self.scrub_start = self.number,
            Scrub::Delta { dx, shift, alt } => self.number = self.scrub_start + f64::from(dx) * number::step(0.1, StepKeys { shift, alt }),
            Scrub::End => self.baseline.committed(self.number),
            Scrub::Cancel => self.number = self.baseline.rollback(),
            Scrub::Step { direction, shift, alt } => {
                self.number += f64::from(direction) * number::step(1.0, StepKeys { shift, alt });
                self.baseline.committed(self.number);
            }
        }
        self.number_text.set(number::format(self.number, 2));
        self.after()
    }

    fn focus_then_select(&self) -> Task<Message> {
        self.focus_task(ids::NUMBER)
    }

    fn close_dialog(&mut self) -> Task<Message> {
        self.dialog_open = false;
        let restored = self.focus.close_scope();
        match restored {
            Some(id) => self.focus_task(id),
            None => self.after(),
        }
    }

    fn key(&mut self, event: &Event) -> Task<Message> {
        if let Some(target) = focus::navigate(&mut self.focus, event) {
            return self.focus_task(target);
        }
        if let Event::Keyboard(keyboard::Event::KeyPressed { key, modifiers, .. }) = event
            && let keyboard::Key::Character(character) = key.as_ref()
        {
            let chord = Chord { key: format!("Key{}", character.to_uppercase()), ctrl: modifiers.control(), alt: modifiers.alt(), shift: modifiers.shift(), meta: modifiers.logo(), alt_graph: false };
            self.status = if command_allowed(&self.focus, &chord) {
                format!("hotkey {} runs its command", chord.key)
            } else {
                format!("hotkey {} suppressed", chord.key)
            };
        }
        self.after()
    }

    /// The tree's focus state arrived: give it to the core; a dialog that was just opened takes focus now.
    fn synced(&mut self, snapshot: focus::Snapshot) -> Task<Message> {
        self.snapshot = snapshot.clone();
        if self.dialog_open && self.focus.top_scope() != MODAL {
            let targets = snapshot.targets(MODAL).to_vec();
            if !targets.is_empty() {
                focus::sync(&mut self.focus, &snapshot);
                let first = self.focus.open_scope(MODAL, targets, None);
                return match first {
                    Some(id) => self.focus_task(id),
                    None => Task::none(),
                };
            }
        }
        focus::sync(&mut self.focus, &snapshot);
        Task::none()
    }

    /// Keys nothing in the tree captured, and pointer presses.
    pub fn subscription(&self) -> Subscription<Message> {
        event::listen_with(|event, status, _window| match (&event, status) {
            (Event::Keyboard(keyboard::Event::KeyPressed { .. }), event::Status::Ignored) => Some(Message::Key(event)),
            (Event::Mouse(mouse::Event::ButtonPressed(_)), _) => Some(Message::PointerPressed),
            _ => None,
        })
    }

    fn ring(&self) -> Ring {
        Ring::of(self.theme.palette(), tokens::scale::RADIUS_2XS)
    }

    fn button(&self, id: FocusId, label: &'static str, on_press: Message, enabled: bool) -> Element<'static, Message> {
        let palette = self.theme.palette();
        let face = container(text(label).size(tokens::scale::TYPE_UI.size).font(styk_design::widgets::INTER).color(iced::Color::from(palette.text_1)))
            .padding([6.0, 12.0])
            .style(move |_| container::Style::default().background(iced::Color::from(palette.control_soft)).border(iced::Border { radius: tokens::scale::RADIUS_XS.into(), ..Default::default() }));
        Focusable::new(id, FocusArea::Panels, face.boxed(), self.ring()).on_activate(on_press).enabled(enabled).boxed()
    }

    fn label(&self, label: &'static str) -> Element<'static, Message> {
        text(label).size(tokens::scale::TYPE_SMALL.size).font(styk_design::widgets::INTER).color(iced::Color::from(self.theme.palette().text_3)).boxed()
    }

    fn heading(&self, label: &'static str) -> Element<'static, Message> {
        text(label).size(tokens::scale::TYPE_EMPHASIS.size).font(styk_design::widgets::INTER).color(iced::Color::from(self.theme.palette().text_1)).boxed()
    }

    fn field(&self, id: FocusId, which: Which, role: Role, value: &FieldValue) -> EditField<'static, Message> {
        EditField::new(id, FocusArea::Panels, role, value.text().to_owned(), self.theme.palette())
            .dir(self.dir)
            .composing(self.focus.composing())
            .on_input(move |text| Message::Input(which, text))
            .on_enter(Message::Enter(which))
            .on_escape(Message::Escape(which))
            .on_clear(Message::Clear(which))
            .on_compose(Message::Compose)
    }

    pub fn view(&self) -> Element<'_, Message> {
        let palette = self.theme.palette();
        let dir = self.dir;
        let number_text = self.number_text.text().to_owned();

        let toolbar = RovingGroup::new(
            FocusArea::Tools,
            TOOLBAR_ICONS
                .iter()
                .enumerate()
                .map(|(i, icon)| RovingItem {
                    id: FocusId(ids::TOOLBAR.0 + i as u64),
                    content: container(styk_design::widgets::icon(dir.icon(icon), 18.0, palette.text_1)).padding(6.0).boxed(),
                    enabled: i != 3,
                    on_activate: Some(Message::ToolbarPress(i)),
                })
                .collect(),
            self.toolbar_active,
            self.ring(),
            Message::ToolbarMove,
        )
        .orientation(Orientation::Horizontal)
        .dir(dir)
        .spacing(4.0)
        .into_element();

        let slider_target = Focusable::new(
            ids::SLIDER,
            FocusArea::Panels,
            slider(0.0..=100.0, self.slider, Message::SliderTo).width(Length::Fixed(220.0)).boxed(),
            self.ring(),
        )
        .keys(Keys::Custom(Box::new(move |event| match event {
            keyboard::Event::KeyPressed { key, modifiers, .. } => {
                let keys = StepKeys { shift: modifiers.shift(), alt: modifiers.alt() };
                let rtl = dir.is_rtl();
                let slider_key = match key.as_ref() {
                    keyboard::Key::Named(keyboard::key::Named::ArrowRight) => if rtl { SliderKey::Decrease } else { SliderKey::Increase },
                    keyboard::Key::Named(keyboard::key::Named::ArrowLeft) => if rtl { SliderKey::Increase } else { SliderKey::Decrease },
                    keyboard::Key::Named(keyboard::key::Named::ArrowUp) => SliderKey::Increase,
                    keyboard::Key::Named(keyboard::key::Named::ArrowDown) => SliderKey::Decrease,
                    keyboard::Key::Named(keyboard::key::Named::PageUp) => SliderKey::PageUp,
                    keyboard::Key::Named(keyboard::key::Named::PageDown) => SliderKey::PageDown,
                    keyboard::Key::Named(keyboard::key::Named::Home) => SliderKey::Home,
                    keyboard::Key::Named(keyboard::key::Named::End) => SliderKey::End,
                    _ => return None,
                };
                Some(Message::Slider(slider_key, keys))
            }
            _ => None,
        })));

        let select_face = {
            let label = if self.select.open { format!("{}  (open)", SELECT_OPTIONS[self.select.index]) } else { SELECT_OPTIONS[self.select.index].to_owned() };
            container(text(label).size(tokens::scale::TYPE_UI.size).font(styk_design::widgets::INTER).color(iced::Color::from(palette.text_1)))
                .padding([6.0, 12.0])
                .width(Length::Fixed(160.0))
                .style(move |_| container::Style::default().background(iced::Color::from(palette.surface_field)).border(iced::Border { color: palette.line_control.into(), width: 1.0, radius: tokens::scale::RADIUS_XS.into() }))
        };
        let select_target = Focusable::new(ids::SELECT, FocusArea::Panels, select_face.boxed(), self.ring()).keys(Keys::Custom(Box::new(|event| match event {
            keyboard::Event::KeyPressed { key, modifiers, .. } => {
                use keyboard::key::Named;
                let select_key = match key.as_ref() {
                    keyboard::Key::Named(Named::Space | Named::Enter) => SelectKey::Activate,
                    keyboard::Key::Named(Named::ArrowDown) if modifiers.alt() => SelectKey::Activate,
                    keyboard::Key::Named(Named::ArrowDown) => SelectKey::Down,
                    keyboard::Key::Named(Named::ArrowUp) => SelectKey::Up,
                    keyboard::Key::Named(Named::Home) => SelectKey::Home,
                    keyboard::Key::Named(Named::End) => SelectKey::End,
                    keyboard::Key::Named(Named::Escape) => SelectKey::Escape,
                    _ => return None,
                };
                Some(Message::SelectKey(select_key))
            }
            _ => None,
        })));

        let switch_face = text(if self.switch_on { "On" } else { "Off" }).size(tokens::scale::TYPE_UI.size).font(styk_design::widgets::INTER).color(iced::Color::from(palette.text_1));
        let switch = Focusable::new(ids::TOGGLE, FocusArea::Panels, container(switch_face).padding([6.0, 12.0]).boxed(), self.ring()).keys(Keys::Toggle).on_activate(Message::ToggleSwitch);

        let number = NumberField::new(ids::NUMBER_LABEL, ids::NUMBER, FocusArea::Panels, "Rotation", number_text, palette)
            .unit("°")
            .composing(self.focus.composing())
            .on_input(Message::NumberInput)
            .on_enter(Message::NumberEnter)
            .on_escape(Message::NumberEscape)
            .on_scrub(Message::Scrub)
            .on_compose(Message::Compose)
            .into_element();

        let disabled = self.field(FocusId(13), Which::Name, Role::SingleLine, &self.name).enabled(false).placeholder("Disabled").into_element();
        let invalid = EditField::new(FocusId(14), FocusArea::Panels, Role::SingleLine, "not a number", palette).invalid(true).dir(dir).on_input(|_| Message::Noop).into_element();

        let page = Column::new()
            .spacing(14.0)
            .padding(24.0)
            .width(Length::Fixed(560.0))
            .push(self.heading("Text fields"))
            .push(self.label("Single line (Enter commits, Escape reverts)"))
            .push(self.field(ids::NAME, Which::Name, Role::SingleLine, &self.name).placeholder("Name").into_element())
            .push(self.label("Search (Enter submits, Escape clears)"))
            .push(self.field(ids::SEARCH, Which::Search, Role::Search, &self.search).placeholder("Search fonts").into_element())
            .push(self.label("Multiline (Enter is a line break)"))
            .push(self.field(ids::NOTES, Which::Notes, Role::Multiline, &self.notes).height(80.0).into_element())
            .push(self.label("Number (scrub the label, arrows step, Escape rolls back)"))
            .push(number)
            .push(self.label("Disabled and error"))
            .push(Row::with_children([disabled, invalid]).spacing(8.0).boxed())
            .push(self.heading("Focus"))
            .push(self.label("Buttons"))
            .push(
                dir.row([
                self.button(ids::THEME, "Theme", Message::ToggleTheme, true),
                self.button(ids::DIR, "Direction", Message::ToggleDir, true),
                self.button(ids::DIALOG, "Dialog", Message::OpenDialog, true),
                self.button(ids::DISABLED, "Disabled", Message::Noop, false),
            ])
                .spacing(8.0)
                .boxed(),
            )
            .push(self.label("Roving toolbar (one Tab stop, arrows move)"))
            .push(toolbar)
            .push(self.label("Slider, select and switch answer their own keys"))
            .push(Row::with_children([slider_target.boxed(), select_target.boxed(), switch.boxed()]).spacing(12.0).align_y(iced::alignment::Vertical::Center).boxed())
            .push(self.label("Status"))
            .push(text(self.status.clone()).size(tokens::scale::TYPE_SMALL.size).font(styk_design::widgets::INTER).color(iced::Color::from(palette.text_2)).boxed());

        let base: Element<'_, Message> = scrollable(container(page).width(Length::Fill).align_x(iced::alignment::Horizontal::Center)).boxed();
        if self.dialog_open {
            let dialog = Column::new()
                .spacing(12.0)
                .padding(20.0)
                .width(Length::Fixed(320.0))
                .push(self.heading("Rename"))
                .push(self.field(ids::DIALOG_NAME, Which::Dialog, Role::DialogLine, &self.dialog_name).into_element())
                .push(Row::with_children([self.button(ids::DIALOG_OK, "OK", Message::CloseDialog, true), self.button(ids::DIALOG_CANCEL, "Cancel", Message::CloseDialog, true)]).spacing(8.0).boxed());
            let panel = container(dialog.boxed()).style(move |_| {
                container::Style::default().background(iced::Color::from(palette.surface)).border(iced::Border { color: palette.line_2.into(), width: 1.0, radius: tokens::scale::RADIUS_MD.into() })
            });
            let backdrop = container(Scope::new(MODAL, container(panel).center(Length::Fill).boxed()))
                .width(Length::Fill)
                .height(Length::Fill)
                .style(move |_| container::Style::default().background(iced::Color::from(palette.surface_backdrop)));
            Stack::new().push(base).push(backdrop.boxed()).boxed()
        } else {
            // Always a stack, so opening the dialog keeps the page's widget state.
            Stack::new().push(base).boxed()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use iced::Size;
    use styk_design::widgets::testing::Driver;
    use styk_core::focus::TargetKind;

    fn driver(sheet: &Sheet) -> Driver<'_, Message> {
        Driver::new(sheet.view(), Size::new(800.0, 900.0), &styk_design::fonts::ALL)
    }

    #[test]
    fn the_sheet_exposes_every_field_and_control_to_the_focus_model() {
        let sheet = Sheet::new(Theme::Light, Dir::Ltr);
        let mut driver = driver(&sheet);
        let snapshot = driver.snapshot();
        let targets = snapshot.targets(ScopeId::ROOT);
        let text_entries: Vec<u64> = targets.iter().filter(|t| t.kind == TargetKind::TextEntry).map(|t| t.id.0).collect();
        assert_eq!(text_entries, [ids::NAME.0, ids::SEARCH.0, ids::NOTES.0, ids::NUMBER.0, 13, 14]);
        let stops: Vec<u64> = targets.iter().filter(|t| t.enabled && t.tab_stop).map(|t| t.id.0).collect();
        assert_eq!(
            stops,
            [10, 11, 12, 20, 21, 14, 1, 2, 3, 30, 40, 41, 42],
            "the fields and the number field, the buttons, one stop for the toolbar, then slider, select and switch"
        );
        assert!(targets.iter().any(|t| t.id == ids::DISABLED && !t.enabled));
    }

    #[test]
    fn a_hovered_slider_takes_no_keys_and_a_focused_one_has_a_single_keyboard_owner() {
        use iced::keyboard::key::Named;
        let sheet = Sheet::new(Theme::Light, Dir::Ltr);
        let mut driver = driver(&sheet);
        let bounds = driver.snapshot().bounds_of(ids::SLIDER).unwrap();
        driver.point_at(iced::Point::new(bounds.x + 5.0, bounds.y + 5.0));
        driver.press(Named::ArrowUp);
        driver.press(Named::ArrowDown);
        let messages = driver.messages();
        assert!(messages.iter().all(|m| !matches!(m, Message::SliderTo(_) | Message::Slider(..))), "an unfocused slider under the pointer reacted: {messages:?}");

        driver.focus(ids::SLIDER);
        driver.press(Named::ArrowUp);
        let messages = driver.messages();
        assert!(messages.iter().any(|m| matches!(m, Message::Slider(SliderKey::Increase, _))), "{messages:?}");
        assert!(messages.iter().all(|m| !matches!(m, Message::SliderTo(_))), "the slider answered its own way as well: {messages:?}");
    }

    #[test]
    fn slider_select_and_switch_answer_their_keys_only_while_focused() {
        use iced::keyboard::key::Named;
        let sheet = Sheet::new(Theme::Light, Dir::Ltr);
        let mut driver = driver(&sheet);
        // Nothing is focused: the keys reach nobody, wherever the pointer is.
        let bounds = driver.snapshot().bounds_of(ids::SLIDER).unwrap();
        driver.point_at(iced::Point::new(bounds.x + 5.0, bounds.y + 5.0));
        driver.press(Named::ArrowRight);
        assert!(driver.messages().iter().all(|m| !matches!(m, Message::Slider(..))));

        driver.focus(ids::SLIDER);
        driver.press(Named::ArrowRight);
        driver.press(Named::End);
        let messages = driver.messages();
        assert!(messages.iter().any(|m| matches!(m, Message::Slider(SliderKey::Increase, _))), "{messages:?}");
        assert!(messages.iter().any(|m| matches!(m, Message::Slider(SliderKey::End, _))), "{messages:?}");

        driver.focus(ids::SELECT);
        driver.press(Named::Space);
        driver.press(Named::ArrowDown);
        let messages = driver.messages();
        assert!(messages.iter().any(|m| matches!(m, Message::SelectKey(SelectKey::Activate))), "{messages:?}");
        assert!(messages.iter().any(|m| matches!(m, Message::SelectKey(SelectKey::Down))), "{messages:?}");

        driver.focus(ids::TOGGLE);
        driver.press(Named::Space);
        driver.release(Named::Space);
        assert!(driver.messages().iter().any(|m| matches!(m, Message::ToggleSwitch)));
    }

    #[test]
    fn the_sheet_draws_in_both_themes_and_directions() {
        for (theme, dir) in [(Theme::Light, Dir::Ltr), (Theme::Dark, Dir::Ltr), (Theme::Light, Dir::Rtl)] {
            let mut sheet = Sheet::new(theme, dir);
            sheet.dialog_open = true;
            let mut driver = driver(&sheet);
            let (pixels, size) = driver.render(&iced::Theme::Light, iced::Color::from(theme.palette().surface_field), 1.0);
            assert_eq!(pixels.len(), (size.width * size.height * 4) as usize);
            let distinct = pixels.chunks(4).map(|p| [p[0], p[1], p[2]]).take(200_000).collect::<std::collections::HashSet<_>>().len();
            assert!(distinct > 8, "{theme:?} {dir:?} drew something");
            if let Ok(dir_name) = std::env::var("STYK_SHEET_PNG_DIR") {
                let path = std::path::Path::new(&dir_name).join(format!("sheet-{theme:?}-{dir:?}.png"));
                let file = std::fs::File::create(path).unwrap();
                let mut encoder = png::Encoder::new(file, size.width, size.height);
                encoder.set_color(png::ColorType::Rgba);
                encoder.set_depth(png::BitDepth::Eight);
                encoder.write_header().unwrap().write_image_data(&pixels).unwrap();
            }
        }
    }
}
