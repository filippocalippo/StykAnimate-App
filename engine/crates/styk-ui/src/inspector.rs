//! The Properties panel's view: a generic kit that draws the core's descriptor ([`styk_core::inspector::model`]) and
//! sends [`Message`]s back. It decides nothing: every value, label, range, enabled state and section comes from the
//! model; a control's change is an [`Event`] for the core. The kit's look follows today's `.ui-*` components
//! (`src/styles/components/section.css`, `field.css`, `button.css`), built from `styk-design`'s tokens and widgets.

use std::cell::Cell;
use std::sync::Arc;

use iced::widget::{Column, Row, Space, button, column, container, pick_list, row, scrollable, text, toggler};
use iced::{Alignment, Background, Border, Color, Element, Length, Padding, Widget as _};
use styk_core::commands::Command;
use styk_core::focus::{FocusArea, FocusId};
use styk_core::field::Role;
use styk_core::i18n::{Label, Msg, english};
use styk_core::inspector::model::{self as m, Action, Inspector, Paint, Place, Tint};
use styk_core::inspector::property::PropertyKey;
use styk_core::inspector::{Event, FieldEvent, FieldView, RenameEvent, RenameView, Scrub};
use styk_core::number::{StepKeys, format};
use styk_design::typography::TextStyle;
use styk_design::widgets::field::EditField;
use styk_design::widgets::focus::{Focusable, Keys, Ring};
use styk_design::widgets::number_field::{self, ScrubLabel};
use styk_design::{Palette, Theme, tokens};

use crate::message::Message;

/// The panel's width in today's default layout (the right dock's Properties panel).
pub const WIDTH: f32 = 320.0;

const BASE_ID: u64 = 0x1_0000;

/// The focus ID of a number field's input, stable by its property.
pub fn input_id(key: PropertyKey) -> FocusId {
    FocusId(BASE_ID + 2 * key_index(key) + 1)
}

/// The focus ID of a number field's scrub label.
pub fn label_id(key: PropertyKey) -> FocusId {
    FocusId(BASE_ID + 2 * key_index(key))
}

fn key_index(key: PropertyKey) -> u64 {
    PropertyKey::ALL.iter().position(|candidate| *candidate == key).unwrap_or(0) as u64
}

const RENAME_ID: FocusId = FocusId(BASE_ID + 0x100);

/// What the view draws: the model and the panel's live field and rename, as the core holds them.
pub struct View<'a> {
    pub model: &'a Inspector,
    pub field: Option<FieldView>,
    pub rename: Option<RenameView>,
    pub theme: Theme,
    /// How a scrub asks the system whether the primary button is still down.
    pub button_probe: Option<fn() -> bool>,
}

struct Kit {
    palette: &'static Palette,
    field: Option<FieldView>,
    probe: Option<fn() -> bool>,
    /// Focus IDs for buttons, in drawing order: stable while the model is.
    next: Cell<u64>,
}

fn send(event: Event) -> Message {
    Message::Command(Command::Inspector(event))
}

fn style(role: &styk_design::TypeRole) -> TextStyle {
    TextStyle::from_role(role)
}

impl Kit {
    fn id(&self) -> FocusId {
        let id = self.next.get();
        self.next.set(id + 1);
        FocusId(BASE_ID + 0x200 + id)
    }

    fn ring(&self) -> Ring {
        Ring::of(self.palette, tokens::scale::RADIUS_XS)
    }

    fn text(&self, value: String, role: &styk_design::TypeRole, color: styk_design::Rgba) -> Element<'static, Message> {
        let style = style(role);
        text(value).font(style.font).size(style.size).line_height(iced::widget::text::LineHeight::Absolute(style.line_height.into())).color(Color::from(color)).boxed()
    }

    fn small(&self, value: String) -> Element<'static, Message> {
        self.text(value, &tokens::scale::TYPE_SMALL, self.palette.text_3)
    }

    fn icon(&self, name: &str, size: f32, color: styk_design::Rgba) -> Element<'static, Message> {
        styk_design::widgets::icon(name, size, color).boxed()
    }

    /// A button: an icon button (`.ui-icon-button`, 28 px) or a text button, ghost or outline.
    fn button(&self, item: &m::Button) -> Element<'static, Message> {
        let palette = self.palette;
        let message = match item.action {
            Action::Command(command) => Message::Command(Command::Run(command)),
            Action::Page(pager, step) => send(Event::Page(pager, step)),
        };
        let ink = if item.disabled { palette.text_disabled } else { palette.text_2 };
        let face: Element<'static, Message> = if item.text {
            let mut parts: Vec<Element<'static, Message>> = Vec::new();
            if let (Some(icon), true) = (item.icon, item.outline) {
                parts.push(self.icon(icon, 16.0, ink));
            }
            parts.push(self.text(english(&item.label), &tokens::scale::TYPE_UI, if item.disabled { palette.text_disabled } else { palette.text_1 }));
            Row::with_children(parts).spacing(tokens::scale::SPACE_1_5).align_y(Alignment::Center).boxed()
        } else {
            self.icon(item.icon.unwrap_or("file"), 16.0, ink)
        };
        let (width, height) = if item.text { (Length::Shrink, tokens::scale::CONTROL_SM) } else { (Length::Fixed(tokens::scale::CONTROL_SM), tokens::scale::CONTROL_SM) };
        let pressed = item.pressed == Some(true);
        let outline = item.outline;
        let face = container(face).center_y(Length::Fixed(height)).center_x(width).padding(if item.text { Padding::from([0.0, tokens::scale::SPACE_2_5]) } else { Padding::ZERO });
        let mut clickable = button(face).padding(0).style(move |_, status| {
            let hovered = matches!(status, button::Status::Hovered | button::Status::Pressed);
            let background = if pressed { palette.surface_selected } else if hovered { palette.surface_hover } else { Color::TRANSPARENT.into_rgba() };
            button::Style {
                background: Some(Background::Color(Color::from(background))),
                border: Border { color: if outline { palette.line_control.into() } else { Color::TRANSPARENT }, width: if outline { 1.0 } else { 0.0 }, radius: tokens::scale::RADIUS_SM.into() },
                ..button::Style::default()
            }
        });
        if !item.disabled {
            clickable = clickable.on_press(message.clone());
        }
        Focusable::new(self.id(), FocusArea::Panels, clickable.boxed(), self.ring()).on_activate(message).enabled(!item.disabled).boxed()
    }

    /// The sunken field box (`.ui-field`): 36 px, the label first.
    fn field_box(&self, content: Element<'static, Message>, disabled: bool) -> Element<'static, Message> {
        let palette = self.palette;
        container(content)
            .height(Length::Fixed(tokens::scale::CONTROL_LG))
            .width(Length::Fill)
            .align_y(Alignment::Center)
            .padding(Padding { top: 0.0, right: tokens::scale::SPACE_2, bottom: 0.0, left: tokens::scale::SPACE_2_5 })
            .style(move |_| container::Style {
                background: Some(Background::Color(Color::from(if disabled { palette.surface_well } else { palette.surface_sunken }))),
                border: Border { radius: tokens::scale::RADIUS_MD.into(), ..Border::default() },
                ..container::Style::default()
            })
            .boxed()
    }

    /// A number field: the label scrubs, the value is typed, the unit follows.
    fn number(&self, row: &m::NumberRow) -> Element<'static, Message> {
        let parts = self.number_parts(row);
        self.field_box(Row::with_children(parts).spacing(tokens::scale::SPACE_1).align_y(Alignment::Center).boxed(), row.disabled)
    }

    /// The parts of a number field (label, value, unit), for a field box that may hold more (a stepper's buttons).
    fn number_parts(&self, row: &m::NumberRow) -> Vec<Element<'static, Message>> {
        let palette = self.palette;
        let key = row.key;
        let active = self.field.as_ref().filter(|field| field.key == key);
        let value = match active {
            Some(field) => field.text.clone(),
            None if row.mixed => String::new(),
            None => format(row.value, row.display_precision),
        };
        let invalid = active.is_some_and(|field| field.invalid.is_some());
        let on_scrub = Arc::new(move |scrub: number_field::Scrub| match scrub {
            number_field::Scrub::Click => Message::FocusField(key),
            number_field::Scrub::Begin => send(Event::Field(key, FieldEvent::Scrub(Scrub::Begin))),
            number_field::Scrub::Delta { dx, shift, alt } => send(Event::Field(key, FieldEvent::Scrub(Scrub::Delta { dx: f64::from(dx), keys: StepKeys { shift, alt } }))),
            number_field::Scrub::End => send(Event::Field(key, FieldEvent::Scrub(Scrub::End))),
            number_field::Scrub::Cancel => send(Event::Field(key, FieldEvent::Scrub(Scrub::Cancel))),
            number_field::Scrub::KeyStep { direction, shift, alt } => send(Event::Field(key, FieldEvent::KeyStep { direction, keys: StepKeys { shift, alt } })),
            number_field::Scrub::KeyEnd => send(Event::Field(key, FieldEvent::KeyEnd)),
        });
        let label = self.small(row.label.english());
        let scrub = ScrubLabel::new(label, on_scrub.clone()).held(self.probe).boxed();
        let keys = {
            let on_scrub = on_scrub.clone();
            Keys::Custom(Box::new(move |event| {
                use iced::keyboard::{self, Key, key::Named};
                match event {
                    keyboard::Event::KeyPressed { key, modifiers, .. } if !modifiers.control() && !modifiers.logo() => {
                        let (shift, alt) = (modifiers.shift(), modifiers.alt());
                        match key.as_ref() {
                            Key::Named(Named::Enter) => Some(on_scrub(number_field::Scrub::Click)),
                            Key::Named(Named::ArrowUp | Named::ArrowRight) => Some(on_scrub(number_field::Scrub::KeyStep { direction: 1, shift, alt })),
                            Key::Named(Named::ArrowDown | Named::ArrowLeft) => Some(on_scrub(number_field::Scrub::KeyStep { direction: -1, shift, alt })),
                            _ => None,
                        }
                    }
                    keyboard::Event::KeyReleased { key: Key::Named(Named::ArrowUp | Named::ArrowDown | Named::ArrowLeft | Named::ArrowRight), .. } => Some(on_scrub(number_field::Scrub::KeyEnd)),
                    _ => None,
                }
            }))
        };
        let label = Focusable::new(label_id(key), FocusArea::Panels, scrub, Ring::of(palette, tokens::scale::RADIUS_2XS)).keys(keys).enabled(!row.disabled);
        let placeholder: &'static str = if row.mixed { "Mixed" } else { "" };
        // The value is as wide as its text and the unit follows it (`.ui-field-suffix`), as today.
        let chars = value.chars().count().max(if row.mixed { 5 } else { 1 }) as f32;
        let width = Length::Fixed((chars * 7.5 + 2.0).min(120.0));
        let input = EditField::new(input_id(key), FocusArea::Panels, Role::Number, value, palette)
            .embedded()
            .width(width)
            .enabled(!row.disabled)
            .invalid(invalid)
            .placeholder(placeholder)
            .on_input(move |text| send(Event::Field(key, FieldEvent::Input(text))))
            .on_enter(send(Event::Field(key, FieldEvent::Enter)))
            .on_escape(send(Event::Field(key, FieldEvent::Escape)))
            .on_focus_change(move |focused| send(Event::Field(key, if focused { FieldEvent::Focus } else { FieldEvent::Blur })))
            .on_step({
                let on_scrub = on_scrub.clone();
                move |direction, shift, alt| on_scrub(number_field::Scrub::KeyStep { direction, shift, alt })
            })
            .on_step_end(on_scrub(number_field::Scrub::KeyEnd))
            .into_element();
        let mut value = vec![input];
        if !row.unit.is_empty() {
            value.push(self.text(row.unit.to_owned(), &tokens::scale::TYPE_VALUE, palette.text_2));
        }
        // `GLUED_UNITS`: "100%", "172°"; other units read after a space ("8 px").
        let glued = matches!(row.unit, "%" | "°" | "×");
        let value = Row::with_children(value).spacing(if glued { 0.0 } else { 3.0 }).align_y(Alignment::Center).boxed();
        vec![label.boxed(), Space::new().width(tokens::scale::SPACE_1).boxed(), value, Space::new().width(Length::Fill).boxed()]
    }

    fn select(&self, row: &m::SelectRow) -> Element<'static, Message> {
        #[derive(Clone, Debug, PartialEq, Eq)]
        struct Choice {
            value: Arc<str>,
            label: String,
        }
        impl std::fmt::Display for Choice {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(&self.label)
            }
        }
        let palette = self.palette;
        let options: Vec<Choice> = row.options.iter().filter(|option| !option.disabled).map(|option| Choice { value: option.value.clone(), label: option.label.english() }).collect();
        let selected = row.value.as_ref().and_then(|value| options.iter().find(|option| &option.value == value).cloned());
        let choice = row.choice;
        let typed = style(&tokens::scale::TYPE_UI);
        let mut list = pick_list(selected, options, |option: &Choice| option.label.clone())
            .font(typed.font)
            .text_size(typed.size)
            .padding(Padding::ZERO)
            .width(Length::Fill)
            .style(move |_, _| pick_list::Style {
                text_color: Color::from(palette.text_1),
                placeholder_color: Color::from(palette.text_placeholder),
                handle_color: Color::from(palette.text_3),
                background: Background::Color(Color::TRANSPARENT),
                border: Border::default(),
            });
        if let Some(placeholder) = &row.placeholder {
            list = list.placeholder(english(placeholder));
        }
        if !row.disabled {
            list = list.on_select(move |option: Choice| send(Event::Choose(choice, option.value)));
        }
        let mut parts = Vec::new();
        if !row.bare {
            parts.push(self.small(english(&row.label)));
        }
        parts.push(list.boxed());
        self.field_box(Row::with_children(parts).spacing(tokens::scale::SPACE_2).align_y(Alignment::Center).boxed(), row.disabled)
    }

    fn switch(&self, row: &m::SwitchRow, boxed: bool) -> Element<'static, Message> {
        let palette = self.palette;
        let toggle = row.toggle;
        let mut control = toggler(row.checked).size(16.0).style(move |_, status| {
            let on = matches!(status, toggler::Status::Active { is_toggled: true } | toggler::Status::Hovered { is_toggled: true });
            toggler::Style {
                background: Background::Color(Color::from(if on { palette.accent } else { palette.line_3 })),
                background_border_width: 0.0,
                background_border_color: Color::TRANSPARENT,
                foreground: Background::Color(Color::WHITE),
                foreground_border_width: 0.0,
                foreground_border_color: Color::TRANSPARENT,
                text_color: None,
                border_radius: None,
                padding_ratio: 0.1,
            }
        });
        if !row.disabled {
            control = control.on_toggle(move |on| send(Event::Toggle(toggle, on)));
        }
        let line = row![self.small(english(&row.label)), Space::new().width(Length::Fill), control].align_y(Alignment::Center).spacing(tokens::scale::SPACE_2);
        if boxed { self.field_box(line.boxed(), row.disabled) } else { line.boxed() }
    }

    fn swatch(&self, rgb: [u8; 3], size: f32) -> Element<'static, Message> {
        let palette = self.palette;
        container(Space::new().width(size).height(size))
            .style(move |_| container::Style {
                background: Some(Background::Color(Color::from_rgb8(rgb[0], rgb[1], rgb[2]))),
                border: Border { color: palette.line_2.into(), width: 1.0, radius: tokens::scale::RADIUS_2XS.into() },
                ..container::Style::default()
            })
            .boxed()
    }

    fn color(&self, row: &m::ColorRow) -> Element<'static, Message> {
        let first = match &row.paint {
            Paint::Solid(rgb) => *rgb,
            Paint::Gradient(stops) => stops.first().map_or([0; 3], |stop| stop.1),
        };
        let caption = match (&row.caption, row.mixed) {
            (_, true) => english(&Msg::new("inspector.mixed")),
            (Some(caption), _) => caption.english(),
            (None, false) => format!("{:02X}{:02X}{:02X}", first[0], first[1], first[2]),
        };
        let target = row.target;
        // The label is the swatch's accessible name; the field shows the swatch and its caption.
        let line = row![self.swatch(first, 18.0), self.text(caption, &tokens::scale::TYPE_VALUE, self.palette.text_1)]
            .spacing(tokens::scale::SPACE_2)
            .align_y(Alignment::Center);
        let face = self.field_box(line.boxed(), false);
        let press = send(Event::Color(target));
        let clickable = button(face).padding(0).style(|_, _| button::Style::default()).on_press(press.clone());
        Focusable::new(self.id(), FocusArea::Panels, clickable.boxed(), self.ring()).on_activate(press).boxed()
    }

    fn segmented(&self, row: &m::SegmentedRow) -> Element<'static, Message> {
        let palette = self.palette;
        let segments = row.segments;
        let items: Vec<Element<'static, Message>> = row
            .options
            .iter()
            .map(|(value, label)| {
                let chosen = *value == row.value;
                let message = send(Event::Segment(segments, value));
                let face = container(self.text(english(label), &tokens::scale::TYPE_UI, if chosen { palette.text_1 } else { palette.text_2 })).center_x(Length::Fill).center_y(Length::Fixed(tokens::scale::CONTROL_SM));
                let clickable = button(face).padding(0).width(Length::Fill).on_press(message.clone()).style(move |_, _| button::Style {
                    background: Some(Background::Color(if chosen { Color::from(palette.surface_raised) } else { Color::TRANSPARENT })),
                    border: Border { radius: tokens::scale::RADIUS_SM.into(), ..Border::default() },
                    ..button::Style::default()
                });
                Focusable::new(self.id(), FocusArea::Panels, clickable.boxed(), self.ring()).on_activate(message).boxed()
            })
            .collect();
        container(Row::with_children(items).spacing(tokens::scale::SPACE_0_5))
            .padding(tokens::scale::SPACE_0_5)
            .style(move |_| container::Style {
                background: Some(Background::Color(Color::from(palette.surface_sunken))),
                border: Border { radius: tokens::scale::RADIUS_MD.into(), ..Border::default() },
                ..container::Style::default()
            })
            .boxed()
    }

    fn row(&self, row: &m::Row) -> Option<Element<'static, Message>> {
        Some(match row {
            m::Row::Grid { ratio, rows } => {
                let cells: Vec<(bool, Element<'static, Message>)> = rows.iter().filter_map(|row| Some((spans(row), self.row(row)?))).collect();
                let portions = match ratio {
                    m::Ratio::Even => (1, 1),
                    m::Ratio::ThreeTwo => (3, 2),
                };
                let mut lines: Vec<Element<'static, Message>> = Vec::new();
                let mut pending: Option<Element<'static, Message>> = None;
                for (span, cell) in cells {
                    if span {
                        if let Some(left) = pending.take() {
                            lines.push(row![container(left).width(Length::FillPortion(portions.0)), Space::new().width(Length::FillPortion(portions.1))].spacing(tokens::scale::SPACE_2).boxed());
                        }
                        lines.push(cell);
                    } else if let Some(left) = pending.take() {
                        lines.push(row![container(left).width(Length::FillPortion(portions.0)), container(cell).width(Length::FillPortion(portions.1))].spacing(tokens::scale::SPACE_2).boxed());
                    } else {
                        pending = Some(cell);
                    }
                }
                if let Some(left) = pending {
                    lines.push(row![container(left).width(Length::FillPortion(portions.0)), Space::new().width(Length::FillPortion(portions.1))].spacing(tokens::scale::SPACE_2).boxed());
                }
                Column::with_children(lines).spacing(tokens::scale::SPACE_2).boxed()
            }
            m::Row::Number(number) => self.number(number),
            // `.ui-field[data-steps]`: the steps sit inside the field, after the value.
            m::Row::Stepper(stepper) => {
                let mut parts = self.number_parts(&stepper.field);
                parts.push(self.button(&stepper.down));
                parts.push(self.button(&stepper.up));
                self.field_box(Row::with_children(parts).spacing(tokens::scale::SPACE_0_5).align_y(Alignment::Center).boxed(), stepper.field.disabled)
            }
            m::Row::Select(select) => self.select(select),
            m::Row::Switch(switch) => self.switch(switch, true),
            m::Row::Color(color) => self.color(color),
            m::Row::Actions(actions) => {
                let buttons: Vec<Element<'static, Message>> = actions.items.iter().map(|item| self.button(item)).collect();
                let buttons = Row::with_children(buttons).spacing(tokens::scale::SPACE_1).align_y(Alignment::Center);
                match &actions.label {
                    Some(label) => column![self.small(english(label)), buttons].spacing(tokens::scale::SPACE_1_5).boxed(),
                    None => buttons.boxed(),
                }
            }
            m::Row::Segmented(segmented) => self.segmented(segmented),
            m::Row::Value { label, text } => row![self.small(english(label)), Space::new().width(Length::Fill), self.text(text.english(), &tokens::scale::TYPE_VALUE, self.palette.text_1)].align_y(Alignment::Center).boxed(),
            m::Row::Meta(meta) => self.text(english(meta), &tokens::scale::TYPE_SMALL, self.palette.text_2),
            m::Row::Caption(parts) => self.small(parts.iter().map(Label::english).collect::<Vec<_>>().join(" · ")),
            m::Row::Swatches { items, .. } => {
                let swatches: Vec<Element<'static, Message>> = items.iter().map(|(rgb, _)| self.swatch(*rgb, 20.0)).collect();
                Row::with_children(swatches).spacing(tokens::scale::SPACE_1).wrap().boxed()
            }
            m::Row::Pager { text: page, previous, next, .. } => row![self.button(previous), Space::new().width(Length::Fill), self.small(page.to_string()), Space::new().width(Length::Fill), self.button(next)].align_y(Alignment::Center).boxed(),
            m::Row::Group { label, rows } => {
                let mut children = vec![self.small(english(label))];
                children.extend(rows.iter().filter_map(|row| self.row(row)));
                Column::with_children(children).spacing(tokens::scale::SPACE_1_5).boxed()
            }
            // Another chunk's part of the panel: its place is kept, it draws nothing until that chunk lands.
            m::Row::Slot(_) => return None,
        })
    }

    fn badge(&self, icon: &'static str, tint: Tint) -> Element<'static, Message> {
        let palette = self.palette;
        let (soft, ink) = match tint {
            Tint::Select => (palette.tint_select_soft, palette.tint_select_ink),
            Tint::Draw => (palette.tint_draw_soft, palette.tint_draw_ink),
            Tint::Time => (palette.tint_time_soft, palette.tint_time_ink),
            Tint::Library => (palette.tint_library_soft, palette.tint_library_ink),
            Tint::Camera => (palette.tint_camera_soft, palette.tint_camera_ink),
            Tint::Effects => (palette.tint_fx_soft, palette.tint_fx_ink),
        };
        container(self.icon(icon, 14.0, ink))
            .center_x(Length::Fixed(22.0))
            .center_y(Length::Fixed(22.0))
            .style(move |_| container::Style { background: Some(Background::Color(Color::from(soft))), border: Border { radius: tokens::scale::RADIUS_XS.into(), ..Border::default() }, ..container::Style::default() })
            .boxed()
    }

    fn section(&self, section: &m::Section, first: bool) -> Option<Element<'static, Message>> {
        let palette = self.palette;
        let titled = section.place == Place::Titled;
        let mut head: Vec<Element<'static, Message>> = Vec::new();
        let title = section.title.as_ref().map(|title| self.text(title.english(), &tokens::scale::TYPE_SECTION, palette.text_1));
        if titled {
            let mut toggle_parts: Vec<Element<'static, Message>> = Vec::new();
            if let Some((icon, tint)) = section.badge {
                toggle_parts.push(self.badge(icon, tint));
            }
            toggle_parts.extend(title);
            toggle_parts.push(Space::new().width(Length::Fill).boxed());
            toggle_parts.push(self.icon(if section.open { "chevron-down" } else { "chevron-right" }, 16.0, palette.text_3));
            let message = send(Event::Section { id: section.id, open: !section.open });
            let face = container(Row::with_children(toggle_parts).spacing(tokens::scale::SPACE_2).align_y(Alignment::Center)).center_y(Length::Fixed(tokens::scale::CONTROL_LG));
            let toggle = button(face).padding(0).width(Length::Fill).style(|_, _| button::Style::default()).on_press(message.clone());
            head.push(Focusable::new(self.id(), FocusArea::Panels, toggle.boxed(), self.ring()).on_activate(message).boxed());
            if let Some(switch) = &section.switch {
                head.push(self.switch(&m::SwitchRow { label: Msg::new(""), ..switch.clone() }, false));
            }
        } else if title.is_some() || !section.actions.is_empty() {
            if let Some((icon, tint)) = section.badge.filter(|_| title.is_some()) {
                head.push(self.badge(icon, tint));
            }
            head.extend(title);
            head.push(Space::new().width(Length::Fill).boxed());
        }
        for action in &section.actions {
            head.push(self.button(action));
        }
        let body: Vec<Element<'static, Message>> = if section.open { section.rows.iter().filter_map(|row| self.row(row)).collect() } else { Vec::new() };
        if head.is_empty() && body.is_empty() {
            return None;
        }
        let mut parts: Vec<Element<'static, Message>> = Vec::new();
        let has_head = !head.is_empty();
        if has_head {
            parts.push(container(Row::with_children(head).spacing(tokens::scale::SPACE_2).align_y(Alignment::Center)).height(Length::Shrink).boxed());
        }
        if !body.is_empty() {
            if has_head {
                parts.push(Space::new().height(if titled { tokens::scale::SPACE_2 } else { tokens::scale::SPACE_3 }).boxed());
            }
            parts.push(Column::with_children(body).spacing(tokens::scale::SPACE_2).boxed());
        }
        let padding = if titled {
            Padding { top: tokens::scale::SPACE_1_5, bottom: if section.open { tokens::scale::SPACE_4 } else { tokens::scale::SPACE_1_5 }, left: 0.0, right: 0.0 }
        } else {
            Padding::from([tokens::scale::SPACE_4, 0.0])
        };
        let element = container(Column::with_children(parts)).padding(padding).width(Length::Fill).boxed();
        // `.ui-section + .ui-section { box-shadow: inset 0 1px 0 var(--line-1) }`
        Some(if first { element } else { column![divider(palette), element].boxed() })
    }

    fn header(&self, model: &Inspector, rename: Option<RenameView>) -> Element<'static, Message> {
        let palette = self.palette;
        let target = &model.target;
        let mut line: Vec<Element<'static, Message>> = Vec::new();
        if let Some(glyph) = target.glyph {
            line.push(self.icon(glyph, 18.0, palette.text_2));
        }
        let name_style = style(&tokens::scale::TYPE_HEADING);
        match (rename, &target.rename) {
            (Some(rename), Some(how)) => {
                let field = EditField::new(RENAME_ID, FocusArea::Panels, Role::SingleLine, rename.text, palette)
                    .on_input(|text| send(Event::Rename(RenameEvent::Input(text))))
                    .on_enter(send(Event::Rename(RenameEvent::Commit)))
                    .on_escape(send(Event::Rename(RenameEvent::Cancel)))
                    // Leaving the field commits, as Enter does.
                    .on_focus_change(|focused| if focused { Message::Idle } else { send(Event::Rename(RenameEvent::Commit)) });
                let field = match how.max_chars {
                    Some(limit) => field.limits(styk_core::limits::Limits { max_chars: Some(limit), ..styk_core::limits::Limits::line() }),
                    None => field,
                };
                line.push(field.into_element());
            }
            (_, how) => {
                let name = text(target.name.english()).font(name_style.font).size(16.0).color(Color::from(palette.text_1)).wrapping(iced::widget::text::Wrapping::None);
                let name: Element<'static, Message> = match how {
                    Some(_) => mouse_double_click(name.boxed(), send(Event::Rename(RenameEvent::Begin))),
                    None => name.boxed(),
                };
                line.push(container(name).width(Length::Fill).clip(true).boxed());
            }
        }
        let mut header = vec![Row::with_children(line).spacing(tokens::scale::SPACE_2).align_y(Alignment::Center).height(Length::Fixed(tokens::scale::CONTROL_LG)).boxed()];
        if let Some(scope) = &model.scope {
            let dot = container(Space::new().width(6.0).height(6.0)).style(move |_| container::Style { background: Some(Background::Color(Color::from(palette.tint_select))), border: Border { radius: 3.0.into(), ..Border::default() }, ..container::Style::default() });
            header.push(row![dot, self.small(english(&scope.label)), Space::new().width(Length::Fill), self.button(&scope.stop)].spacing(tokens::scale::SPACE_2).align_y(Alignment::Center).boxed());
        }
        Column::with_children(header).spacing(tokens::scale::SPACE_1).boxed()
    }
}

/// A double click on the name renames in place.
fn mouse_double_click(content: Element<'static, Message>, message: Message) -> Element<'static, Message> {
    iced::widget::mouse_area(content).on_double_click(message).boxed()
}

fn divider(palette: &'static Palette) -> Element<'static, Message> {
    container(Space::new().height(1.0).width(Length::Fill)).style(move |_| container::Style { background: Some(Background::Color(Color::from(palette.line_1))), ..container::Style::default() }).boxed()
}

fn spans(row: &m::Row) -> bool {
    match row {
        m::Row::Number(number) => number.span,
        m::Row::Select(select) => select.span,
        m::Row::Switch(switch) => switch.span,
        m::Row::Color(color) => color.span,
        m::Row::Actions(_) | m::Row::Grid { .. } | m::Row::Group { .. } | m::Row::Meta(_) | m::Row::Caption(_) | m::Row::Swatches { .. } | m::Row::Pager { .. } | m::Row::Segmented(_) | m::Row::Value { .. } => true,
        m::Row::Stepper(_) | m::Row::Slot(_) => false,
    }
}

trait IntoRgba {
    fn into_rgba(self) -> styk_design::Rgba;
}

impl IntoRgba for Color {
    fn into_rgba(self) -> styk_design::Rgba {
        let [r, g, b, _] = self.into_rgba8();
        styk_design::Rgba::new(r, g, b, self.a)
    }
}

/// The Properties panel for the core's model.
pub fn view(view: View<'_>) -> Element<'static, Message> {
    let palette = view.theme.palette();
    let kit = Kit { palette, field: view.field, probe: view.button_probe, next: Cell::new(0) };
    let mut sections: Vec<Element<'static, Message>> = Vec::new();
    for section in &view.model.sections {
        if let Some(element) = kit.section(section, sections.is_empty()) {
            sections.push(element);
        }
    }
    let body = scrollable(Column::with_children(sections).padding(Padding::from([0.0, tokens::scale::SPACE_4]))).height(Length::Fill);
    let header = container(kit.header(view.model, view.rename)).padding(Padding { top: tokens::scale::SPACE_2, right: tokens::scale::SPACE_4, bottom: tokens::scale::SPACE_1, left: tokens::scale::SPACE_4 });
    // The docked panel's card (`.shell-panel`).
    container(column![header, body])
        .width(Length::Fixed(WIDTH))
        .height(Length::Fill)
        .style(move |_| container::Style {
            background: Some(Background::Color(Color::from(palette.surface))),
            border: Border { color: palette.line_1.into(), width: 1.0, radius: tokens::scale::RADIUS_LG.into() },
            ..container::Style::default()
        })
        .boxed()
}
