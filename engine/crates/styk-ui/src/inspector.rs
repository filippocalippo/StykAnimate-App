//! The Properties panel's view: a generic kit that draws the core's descriptor ([`styk_core::inspector::model`]) and
//! sends [`Message`]s back. It decides nothing: every value, label, range, enabled state and section comes from the
//! model; a control's change is an [`Event`] for the core. The kit's look follows today's `.ui-*` components
//! (`src/styles/components/section.css`, `field.css`, `button.css`), built from `styk-design`'s tokens and widgets. Text is
//! formatted by the core's [`Presentation`] (locale, plural rules, numbers); the panel fills the bounds it is given (the
//! dock decides its size: [`crate::dock`]).

use std::cell::Cell;
use std::sync::Arc;

use iced::widget::{Column, Row, Space, button, container, row, scrollable, text};
use iced::{Alignment, Background, Border, Color, Element, Length, Padding, Widget as _};
use styk_core::commands::Command;
use styk_core::focus::{FocusArea, FocusId};
use styk_core::field::Role;
use styk_core::i18n::{Label, Msg, Presentation};
use styk_core::inspector::model::{self as m, Action, Inspector, Paint, Place, TextKey, Tint};
use styk_core::inspector::property::PropertyKey;
use styk_core::inspector::{Event, FieldEvent, FieldView, RenameEvent, RenameView, Scrub, TextEvent};
use styk_core::number::{StepKeys, format};
use styk_design::typography::TextStyle;
use styk_design::widgets::badge::{Tint as DesignTint, badge};
use styk_design::widgets::button::{Button, IconButton, IconSize, Variant};
use styk_design::widgets::color::{ColorField, SwatchSize, swatch};
use styk_design::widgets::field::EditField;
use styk_design::widgets::frame::{self, FieldFrame};
use styk_design::widgets::focus::{Focusable, Keys, Ring};
use styk_design::widgets::number_field::{self, NumberField};
use styk_design::widgets::segmented::{Segment, SegmentSize, Segmented};
use styk_design::widgets::select::{Choice, Select};
use styk_design::widgets::toggle::Switch;
use styk_design::{Palette, Theme, tokens};

use crate::message::Message;

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
    match key {
        // A fill's fields follow the fixed keys, two per fill.
        PropertyKey::PolygonOpacity(index) => PropertyKey::FIXED.len() as u64 + 2 * u64::from(index),
        PropertyKey::PolygonZOrder(index) => PropertyKey::FIXED.len() as u64 + 2 * u64::from(index) + 1,
        fixed => PropertyKey::FIXED.iter().position(|candidate| *candidate == fixed).unwrap_or(0) as u64,
    }
}

/// The focus ID of a text row's input.
pub fn text_id(key: TextKey) -> FocusId {
    match key {
        TextKey::LayerName => FocusId(BASE_ID + 0x102),
    }
}

/// The header's rename field and its name, focus targets the core asks for ([`styk_core::inspector::FocusRequest`]).
pub const RENAME_ID: FocusId = FocusId(BASE_ID + 0x100);
pub const TARGET_NAME_ID: FocusId = FocusId(BASE_ID + 0x101);

/// The focus ID of item `index` of a segmented control: stable by the control, so a choice by arrow key can focus its item.
fn segment_id(segments: m::Segments, index: usize) -> FocusId {
    let which = match segments {
        m::Segments::CameraTab => 0,
        m::Segments::ConnectorPart => 1,
    };
    FocusId(BASE_ID + 0x8000 + 8 * which + index as u64)
}

/// What the view draws: the model and the panel's live field and rename, as the core holds them.
pub struct View<'a> {
    pub model: &'a Inspector,
    pub presentation: &'a Presentation,
    pub field: Option<FieldView>,
    pub rename: Option<RenameView>,
    /// The text row being typed in and its text.
    pub text: Option<(TextKey, String)>,
    /// An input method has a composition open in the focused field (the core's focus state).
    pub composing: bool,
    pub theme: Theme,
    /// How a scrub asks the system whether the primary button is still down.
    pub button_probe: Option<fn() -> bool>,
}

impl<'a> View<'a> {
    /// The panel as the core holds it, when it has a model.
    pub fn of(core: &'a styk_core::app::Core, theme: Theme) -> Option<View<'a>> {
        let panel = core.inspector();
        Some(View { model: panel.model()?, presentation: core.presentation(), field: panel.field(), rename: panel.rename(), text: panel.text_draft(), composing: core.focus().composing(), theme, button_probe: None })
    }
}

struct Kit<'a> {
    palette: &'static Palette,
    presentation: &'a Presentation,
    field: Option<FieldView>,
    probe: Option<fn() -> bool>,
    text: Option<(TextKey, String)>,
    composing: bool,
    /// Focus IDs for buttons, in drawing order: stable while the model is.
    next: Cell<u64>,
    /// Whether the rows drawn now are a field grid's cells (`.ui-field-grid > .ui-field`: 6/4 px padding, 4 px gaps).
    in_grid: Cell<bool>,
}

fn send(event: Event) -> Message {
    Message::Command(Command::Inspector(event))
}

fn style(role: &styk_design::TypeRole) -> TextStyle {
    TextStyle::from_role(role)
}

impl Kit<'_> {
    fn say(&self, msg: &Msg) -> String {
        self.presentation.text(msg)
    }

    fn label(&self, label: &Label) -> String {
        self.presentation.label(label)
    }

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

    fn styled(&self, value: String, style: TextStyle, color: styk_design::Rgba) -> Element<'static, Message> {
        text(value).font(style.font).size(style.size).line_height(style.line()).color(Color::from(color)).boxed()
    }

    /// The gap between a field's parts (`--_gap`): 4 px in a grid, 8 px elsewhere.
    fn field_gap(&self) -> f32 {
        if self.in_grid.get() { tokens::scale::SPACE_1 } else { tokens::scale::SPACE_2 }
    }

    fn small(&self, value: String) -> Element<'static, Message> {
        self.text(value, &tokens::scale::TYPE_SMALL, self.palette.text_3)
    }

    fn icon(&self, name: &str, size: f32, color: styk_design::Rgba) -> Element<'static, Message> {
        styk_design::widgets::icon(name, size, color).boxed()
    }

    /// A button as today's components draw it: an icon button (`.ui-icon-button`: 32 px, radius 10, an 18 px glyph; a
    /// small one 28 px, radius 8, 16 px) or a text button (`.ui-button`: a 32 px pill, Inter Tight 650 words, a 16 px
    /// glyph before them), ghost or outline (white with a `--line-2` ring). Both are the design system's buttons
    /// (`styk_design::widgets::button`); a text button in a field grid fills its cell.
    fn button(&self, item: &m::Button, size: ButtonSize) -> Element<'static, Message> {
        let message = match item.action {
            Action::Command(command) => Message::Command(Command::Run(command)),
            Action::Panel(action) => send(Event::Act(action)),
        };
        let pressed = item.pressed == Some(true);
        if item.text {
            let mut button = Button::new(self.id(), FocusArea::Panels, self.palette, self.say(&item.label), message)
                .variant(if item.outline { Variant::Outline } else { Variant::Ghost })
                .toggled(pressed)
                .disabled(item.disabled)
                .fill(self.in_grid.get());
            if let Some(icon) = item.icon {
                button = button.icon(icon);
            }
            return button.into_element();
        }
        let size = if size == ButtonSize::Small { IconSize::Sm } else { IconSize::Md };
        IconButton::new(self.id(), FocusArea::Panels, self.palette, item.icon.unwrap_or("file"), message).size(size).toggled(pressed).disabled(item.disabled).into_element()
    }

    /// A section title's action: an icon button, or words (Join…, Rotate 15°) in `--type-small-strong` on a 28 px pill
    /// (`.ui-section-action.ui-button`).
    fn title_action(&self, item: &m::Button) -> Element<'static, Message> {
        if !item.text {
            return self.button(item, ButtonSize::Small);
        }
        let message = match item.action {
            Action::Command(command) => Message::Command(Command::Run(command)),
            Action::Panel(action) => send(Event::Act(action)),
        };
        Button::new(self.id(), FocusArea::Panels, self.palette, self.say(&item.label), message).section_action().disabled(item.disabled).into_element()
    }

    /// The field box (`.ui-field`) around `content`: 36 px, the label first; its 1 px transparent border sits inside the
    /// padding (10/8 px, 6/4 px in a grid).
    fn field_box(&self, content: Element<'static, Message>) -> Element<'static, Message> {
        let (left, right) = frame::padding(self.in_grid.get());
        FieldFrame::new(content, self.palette, Length::Fill, frame::HEIGHT, Padding { top: 0.0, right, bottom: 0.0, left }).boxed()
    }

    /// A number field: the label scrubs, the value is typed, the unit follows.
    fn number(&self, row: &m::NumberRow) -> Element<'static, Message> {
        self.number_field(row).into_element()
    }

    /// The design system's number field for a row, with the panel's live field state and the scrub's messages.
    fn number_field(&self, row: &m::NumberRow) -> NumberField<'static, Message> {
        let key = row.key;
        let active = self.field.as_ref().filter(|field| field.key == key);
        let value = match active {
            Some(field) => field.text.clone(),
            // Mixed (several values), or a fact still being made on a worker: shown empty.
            None if row.mixed || row.pending => String::new(),
            None => format(row.value, row.display_precision),
        };
        let invalid = active.is_some_and(|field| field.invalid.is_some());
        let placeholder = if row.mixed { self.say(&Msg::new("inspector.mixed")) } else { String::new() };
        let mut field = NumberField::new(label_id(key), input_id(key), FocusArea::Panels, self.label(&row.label), value, self.palette)
            .placeholder(placeholder)
            .enabled(!row.disabled && !row.pending)
            .invalid(invalid)
            .in_grid(self.in_grid.get())
            .button_probe(self.probe)
            .composing(self.composing)
            .on_compose(Message::Compose)
            .on_input(move |text| send(Event::Field(key, FieldEvent::Input(text))))
            .on_enter(send(Event::Field(key, FieldEvent::Enter)))
            .on_escape(send(Event::Field(key, FieldEvent::Escape)))
            .on_focus_change(move |focused| send(Event::Field(key, if focused { FieldEvent::Focus } else { FieldEvent::Blur })))
            .on_scrub(move |scrub: number_field::Scrub| match scrub {
                number_field::Scrub::Click => Message::FocusField(key),
                number_field::Scrub::Begin => send(Event::Field(key, FieldEvent::Scrub(Scrub::Begin))),
                number_field::Scrub::Delta { dx, shift, alt } => send(Event::Field(key, FieldEvent::Scrub(Scrub::Delta { dx: f64::from(dx), keys: StepKeys { shift, alt } }))),
                number_field::Scrub::End => send(Event::Field(key, FieldEvent::Scrub(Scrub::End))),
                number_field::Scrub::Cancel => send(Event::Field(key, FieldEvent::Scrub(Scrub::Cancel))),
                number_field::Scrub::KeyStep { direction, shift, alt } => send(Event::Field(key, FieldEvent::KeyStep { direction, keys: StepKeys { shift, alt } })),
                number_field::Scrub::KeyEnd => send(Event::Field(key, FieldEvent::KeyEnd)),
            });
        if !row.unit.is_empty() {
            field = field.unit(row.unit);
        }
        field
    }

    fn select(&self, row: &m::SelectRow) -> Element<'static, Message> {
        let choice = row.choice;
        let options: Vec<Choice> = row.options.iter().map(|option| Choice { label: self.label(&option.label), disabled: option.disabled }).collect();
        let chosen = row.value.as_ref().and_then(|value| row.options.iter().position(|option| !option.disabled && &option.value == value));
        let values: Vec<Arc<str>> = row.options.iter().map(|option| option.value.clone()).collect();
        let mut select = Select::new(
            self.id(),
            FocusArea::Panels,
            self.palette,
            options,
            chosen,
            move |index| send(Event::Choose(choice, values[index].clone())),
            move |step| send(Event::ChooseStep(choice, step)),
        )
        .disabled(row.disabled)
        .in_grid(self.in_grid.get());
        if !row.bare {
            select = select.label(self.say(&row.label));
        }
        if let Some(placeholder) = &row.placeholder {
            select = select.placeholder(self.say(placeholder));
        }
        select.into_element()
    }

    fn switch(&self, row: &m::SwitchRow, boxed: bool) -> Element<'static, Message> {
        let toggle = row.toggle;
        let switch = Switch::new(self.id(), FocusArea::Panels, self.palette, row.checked, move |on| send(Event::Toggle(toggle, on))).disabled(row.disabled);
        if boxed { switch.field(self.say(&row.label), self.in_grid.get()) } else { switch.into_element() }
    }

    /// A text field: its label, then the name, proportional figures (`.ui-field` with a text input).
    fn text_row(&self, row: &m::TextRow) -> Element<'static, Message> {
        let key = row.key;
        let value = self.text.as_ref().filter(|(typing, _)| *typing == key).map_or_else(|| row.value.to_string(), |(_, text)| text.clone());
        let input = EditField::new(text_id(key), FocusArea::Panels, Role::SingleLine, value, self.palette)
            .embedded()
            .proportional()
            .limits(styk_core::limits::Limits { max_chars: row.max_chars, ..styk_core::limits::Limits::line() })
            .on_input(move |text| send(Event::Text(key, TextEvent::Input(text))))
            .on_enter(send(Event::Text(key, TextEvent::Enter)))
            .on_escape(send(Event::Text(key, TextEvent::Escape)))
            .on_focus_change(move |focused| send(Event::Text(key, if focused { TextEvent::Focus } else { TextEvent::Blur })))
            .composing(self.composing)
            .on_compose(Message::Compose)
            .into_element();
        self.field_box(row![self.small(self.say(&row.label)), input].spacing(self.field_gap()).align_y(Alignment::Center).boxed())
    }

    fn color(&self, row: &m::ColorRow) -> Element<'static, Message> {
        let first = match &row.paint {
            Paint::Solid(rgb) => *rgb,
            Paint::Gradient(stops) => stops.first().map_or([0; 3], |stop| stop.1),
        };
        let caption = match (&row.caption, row.mixed) {
            (_, true) => self.say(&Msg::new("inspector.mixed")),
            (Some(caption), _) => self.label(caption),
            (None, false) => format!("{:02X}{:02X}{:02X}", first[0], first[1], first[2]),
        };
        // The label is the swatch's accessible name; the field shows the swatch and its caption. The paint picker is a
        // button, which centres what it holds unless it spans the row.
        ColorField::new(self.id(), FocusArea::Panels, self.palette, first, caption, send(Event::Color(row.target)))
            .centered(row.paint_picker && !row.span)
            .in_grid(self.in_grid.get())
            .disabled(row.disabled)
            .into_element()
    }

    fn segmented(&self, row: &m::SegmentedRow) -> Element<'static, Message> {
        let segments = row.segments;
        let first = segment_id(segments, 0);
        let values: Vec<&'static str> = row.options.iter().map(|(value, _)| *value).collect();
        let items: Vec<Segment> = row.options.iter().map(|(_, label)| Segment::text(self.say(label))).collect();
        let chosen = row.options.iter().position(|(value, _)| *value == row.value).unwrap_or(0);
        // An arrow key moves to the next item and chooses it, so focus follows the choice.
        Segmented::new(first, FocusArea::Panels, self.palette, items, chosen, move |index| Message::Focusing(Box::new(send(Event::Segment(segments, values[index]))), segment_id(segments, index)))
            .size(SegmentSize::Sm)
            .fill(true)
            .into_element()
    }

    fn row(&self, row: &m::Row) -> Option<Element<'static, Message>> {
        Some(match row {
            m::Row::Grid { ratio, rows } => {
                let outer = self.in_grid.replace(true);
                let cells: Vec<(bool, bool, Element<'static, Message>)> = rows.iter().filter_map(|row| Some((spans(row), matches!(row, m::Row::Stepper(_)), self.row(row)?))).collect();
                self.in_grid.set(outer);
                let portions = match ratio {
                    m::Ratio::Even => (1, 1),
                    m::Ratio::ThreeTwo => (3, 2),
                };
                let mut lines: Vec<Element<'static, Message>> = Vec::new();
                let mut pending: Option<Element<'static, Message>> = None;
                for (span, stepper, cell) in cells {
                    if span {
                        if let Some(left) = pending.take() {
                            lines.push(row![container(left).width(Length::FillPortion(portions.0)), Space::new().width(Length::FillPortion(portions.1))].spacing(tokens::scale::SPACE_2).boxed());
                        }
                        lines.push(cell);
                    } else if let Some(left) = pending.take() {
                        // `minmax(min-content, 2fr)`: at the dock's width a stepper's own width is the larger.
                        let right = if stepper && portions == (3, 2) { container(cell).width(Length::Shrink) } else { container(cell).width(Length::FillPortion(portions.1)) };
                        let left = container(left).width(if stepper && portions == (3, 2) { Length::Fill } else { Length::FillPortion(portions.0) });
                        lines.push(row![left, right].spacing(tokens::scale::SPACE_2).boxed());
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
            m::Row::Stepper(stepper) => self.number_field(&stepper.field).stepper(self.button(&stepper.down, ButtonSize::Small), self.button(&stepper.up, ButtonSize::Small)),
            m::Row::Select(select) => self.select(select),
            m::Row::Switch(switch) => self.switch(switch, true),
            m::Row::Text(text) => self.text_row(text),
            m::Row::Color(color) => self.color(color),
            m::Row::Actions(actions) => {
                // `.ui-action-row`: its label names the row for assistive technology and is not drawn; in a grid the
                // row fills its cell and centres there.
                let buttons: Vec<Element<'static, Message>> = actions.items.iter().map(|item| self.button(item, ButtonSize::Regular)).collect();
                let buttons = Row::with_children(buttons).spacing(tokens::scale::SPACE_1).align_y(Alignment::Center);
                if self.in_grid.get() { container(buttons).center_y(Length::Fixed(tokens::scale::CONTROL_LG)).width(Length::Fill).boxed() } else { buttons.boxed() }
            }
            m::Row::Segmented(segmented) => self.segmented(segmented),
            m::Row::Value { label, text } => row![self.small(self.say(label)), Space::new().width(Length::Fill), self.text(self.label(text), &tokens::scale::TYPE_VALUE, self.palette.text_1)].align_y(Alignment::Center).boxed(),
            // `.inspector-meta`: small, tabular, the quiet ink.
            m::Row::Meta(meta) => self.styled(self.say(meta), style(&tokens::scale::TYPE_SMALL).tabular(), self.palette.text_3),
            // `.inspector-preview-caption`: its parts spread across the row ("960 × 540" at the start, "100% zoom" at the end).
            m::Row::Caption(parts) => {
                let mut line: Vec<Element<'static, Message>> = Vec::new();
                for (at, part) in parts.iter().enumerate() {
                    if at > 0 {
                        line.push(Space::new().width(Length::Fill).boxed());
                    }
                    line.push(self.small(self.label(part)));
                }
                Row::with_children(line).align_y(Alignment::Center).boxed()
            }
            m::Row::Swatches { items, .. } => {
                let swatches: Vec<Element<'static, Message>> = items.iter().map(|(rgb, _)| swatch(self.palette, *rgb, SwatchSize::Md)).collect();
                Row::with_children(swatches).spacing(tokens::scale::SPACE_1).wrap().boxed()
            }
            m::Row::Pager { text: page, previous, next, .. } => row![self.button(previous, ButtonSize::Small), Space::new().width(Length::Fill), self.small(page.to_string()), Space::new().width(Length::Fill), self.button(next, ButtonSize::Small)].align_y(Alignment::Center).boxed(),
            m::Row::Group { label, rows } => {
                let mut children = vec![self.small(self.say(label))];
                children.extend(rows.iter().filter_map(|row| self.row(row)));
                Column::with_children(children).spacing(tokens::scale::SPACE_1_5).boxed()
            }
            // Another chunk's part of the panel: its place is kept, it draws nothing until that chunk lands.
            m::Row::Slot(slot) => Space::new().width(Length::Fill).height(slot_height(*slot)?).boxed(),
        })
    }

    fn badge(&self, icon: &'static str, tint: Tint) -> Element<'static, Message> {
        let tint = match tint {
            Tint::Select => DesignTint::Select,
            Tint::Draw => DesignTint::Draw,
            Tint::Time => DesignTint::Time,
            Tint::Library => DesignTint::Library,
            Tint::Camera => DesignTint::Camera,
            Tint::Effects => DesignTint::Effects,
        };
        badge(self.palette, icon, tint)
    }

    fn section(&self, section: &m::Section, first: bool) -> Option<Element<'static, Message>> {
        let palette = self.palette;
        let titled = section.place == Place::Titled;
        let mut head: Vec<Element<'static, Message>> = Vec::new();
        let title = section.title.as_ref().map(|title| self.styled(self.label(title), style(&tokens::scale::TYPE_SECTION).tracking_em(-0.005), palette.text_1));
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
            head.push(self.title_action(action));
        }
        let body: Vec<Element<'static, Message>> = if section.open { section.rows.iter().filter_map(|row| self.row(row)).collect() } else { Vec::new() };
        if head.is_empty() && body.is_empty() {
            return None;
        }
        let mut parts: Vec<Element<'static, Message>> = Vec::new();
        let has_head = !head.is_empty();
        if has_head {
            // `.ui-section-head`: at least 28 px (`--control-sm`), its parts centred; a titled one is its 36 px toggle.
            let line = Row::with_children(head).spacing(tokens::scale::SPACE_2).align_y(Alignment::Center);
            parts.push(if titled { line.boxed() } else { container(line).center_y(Length::Fixed(tokens::scale::CONTROL_SM)).boxed() });
        }
        if !body.is_empty() {
            if has_head {
                parts.push(Space::new().height(if titled { tokens::scale::SPACE_2 } else { tokens::scale::SPACE_3 }).boxed());
            }
            parts.push(Column::with_children(body).spacing(tokens::scale::SPACE_2).boxed());
        }
        // `.ui-section`: 16 px above and below; a titled one 6 px (16 px below while open); the first shown sits 8 px
        // under the header.
        let top = if first { tokens::scale::SPACE_2 } else if titled { tokens::scale::SPACE_1_5 } else { tokens::scale::SPACE_4 };
        let bottom = if titled && !section.open { tokens::scale::SPACE_1_5 } else { tokens::scale::SPACE_4 };
        let element = container(Column::with_children(parts)).padding(Padding { top, bottom, left: 0.0, right: 0.0 }).width(Length::Fill).boxed();
        // `.ui-section + .ui-section { box-shadow: inset 0 1px 0 var(--line-1) }`: the hairline takes no room.
        Some(if first { element } else { hairline(palette, element) })
    }

    fn header(&self, model: &Inspector, rename: Option<RenameView>) -> Element<'static, Message> {
        let palette = self.palette;
        let target = &model.target;
        let mut line: Vec<Element<'static, Message>> = Vec::new();
        // `.ui-target-kind`: the kind's 16 px glyph in the quiet ink.
        if let Some(glyph) = target.glyph {
            line.push(self.icon(glyph, 16.0, palette.text_3));
        }
        // `--type-heading` with `--tracking-heading` (-0.01em).
        let name_style = style(&tokens::scale::TYPE_HEADING).tracking_em(-0.01);
        match (rename, &target.rename) {
            (Some(rename), Some(how)) => {
                let field = EditField::new(RENAME_ID, FocusArea::Panels, Role::SingleLine, rename.text, palette)
                    .on_input(|text| send(Event::Rename(RenameEvent::Input(text))))
                    .on_enter(send(Event::Rename(RenameEvent::Commit)))
                    .on_escape(send(Event::Rename(RenameEvent::Cancel)))
                    // Leaving the field commits, as Enter does.
                    .on_focus_change(|focused| if focused { Message::Idle } else { send(Event::Rename(RenameEvent::Commit)) })
                    .composing(self.composing)
                    .on_compose(Message::Compose);
                let field = match how.max_chars {
                    Some(limit) => field.limits(styk_core::limits::Limits { max_chars: Some(limit), ..styk_core::limits::Limits::line() }),
                    None => field,
                };
                line.push(field.into_element());
            }
            (_, how) => {
                let name = text(self.label(&target.name)).font(name_style.font).size(name_style.size).line_height(name_style.line()).color(Color::from(palette.text_1)).wrapping(iced::widget::text::Wrapping::None);
                let name: Element<'static, Message> = match how {
                    Some(_) => {
                        let keys = Keys::Custom(Box::new(|event| {
                            use iced::keyboard::{self, Key, key::Named};
                            match event {
                                keyboard::Event::KeyPressed { key: Key::Named(Named::Enter | Named::F2), modifiers, .. } if !modifiers.alt() && !modifiers.control() && !modifiers.logo() => {
                                    Some(send(Event::Rename(RenameEvent::Begin)))
                                }
                                _ => None,
                            }
                        }));
                        let named = mouse_double_click(name.boxed(), send(Event::Rename(RenameEvent::Begin)));
                        Focusable::new(TARGET_NAME_ID, FocusArea::Panels, named, Ring::of(palette, tokens::scale::RADIUS_2XS)).keys(keys).boxed()
                    }
                    None => name.boxed(),
                };
                line.push(container(name).width(Length::Fill).clip(true).boxed());
            }
        }
        // `.inspector-header`: the target line, then the target's ⋯ menu, whose place is kept until the chunk that builds
        // menus fills it (K-widgets, its commands K-cmd). 36 px under 12 px of air: 48 px.
        let target_line = Row::with_children(line).spacing(tokens::scale::SPACE_1_5).align_y(Alignment::Center).width(Length::Fill);
        let menu = Space::new().width(tokens::scale::CONTROL_SM).height(tokens::scale::CONTROL_SM);
        let line = row![target_line, menu].spacing(tokens::scale::SPACE_2).align_y(Alignment::Center).height(Length::Fixed(tokens::scale::CONTROL_LG));
        container(line).padding(Padding { top: tokens::scale::SPACE_3, right: tokens::scale::SPACE_4 - tokens::scale::SPACE_1_5, bottom: 0.0, left: tokens::scale::SPACE_4 }).boxed()
    }

    /// `.inspector-head`: the scope line, then the quick actions' place, kept until the command registry fills it
    /// (K-cmd): 52 px under 12 px of air, 4 px below.
    fn head(&self, model: &Inspector) -> Option<Element<'static, Message>> {
        let palette = self.palette;
        let mut parts: Vec<Element<'static, Message>> = Vec::new();
        if let Some(scope) = &model.scope {
            let dot = container(Space::new().width(6.0).height(6.0)).style(move |_| container::Style { background: Some(Background::Color(Color::from(palette.tint_select))), border: Border { radius: 3.0.into(), ..Border::default() }, ..container::Style::default() });
            parts.push(row![dot, self.small(self.say(&scope.label)), Space::new().width(Length::Fill), self.button(&scope.stop, ButtonSize::Small)].spacing(tokens::scale::SPACE_2).align_y(Alignment::Center).boxed());
        }
        if model.quick.is_some() {
            parts.push(Space::new().width(Length::Fill).height(tokens::scale::SPACE_3 + 52.0).boxed());
        }
        if parts.is_empty() {
            return None;
        }
        Some(container(Column::with_children(parts)).padding(Padding { top: 0.0, right: tokens::scale::SPACE_4, bottom: tokens::scale::SPACE_1, left: tokens::scale::SPACE_4 }).boxed())
    }
}

/// A double click on the name renames in place.
fn mouse_double_click(content: Element<'static, Message>, message: Message) -> Element<'static, Message> {
    iced::widget::mouse_area(content).on_double_click(message).boxed()
}

/// A hairline over the top edge of `content`, taking no room.
fn hairline(palette: &'static Palette, content: Element<'static, Message>) -> Element<'static, Message> {
    let line = container(Space::new().height(1.0).width(Length::Fill)).width(Length::Fill).style(move |_| container::Style { background: Some(Background::Color(Color::from(palette.line_1))), ..container::Style::default() });
    iced::widget::stack![content, line].boxed()
}

fn spans(row: &m::Row) -> bool {
    match row {
        m::Row::Number(number) => number.span,
        m::Row::Select(select) => select.span,
        m::Row::Switch(switch) => switch.span,
        m::Row::Text(text) => text.span,
        m::Row::Color(color) => color.span,
        // An action row is one cell of a grid (`.ui-field-grid > .ui-action-row`).
        m::Row::Actions(_) => false,
        m::Row::Grid { .. } | m::Row::Group { .. } | m::Row::Meta(_) | m::Row::Caption(_) | m::Row::Swatches { .. } | m::Row::Pager { .. } | m::Row::Segmented(_) | m::Row::Value { .. } => true,
        m::Row::Stepper(_) | m::Row::Slot(_) => false,
    }
}

/// The Properties panel for the core's model.
pub fn view(view: View<'_>) -> Element<'static, Message> {
    let palette = view.theme.palette();
    let kit = Kit { palette, presentation: view.presentation, field: view.field, probe: view.button_probe, text: view.text, composing: view.composing, next: Cell::new(0), in_grid: Cell::new(false) };
    let mut sections: Vec<Element<'static, Message>> = Vec::new();
    for section in &view.model.sections {
        if let Some(element) = kit.section(section, sections.is_empty()) {
            sections.push(element);
        }
    }
    // `#inspector`: the island's 16 px inline padding and 16 px below; `scrollbar-gutter: stable` keeps 10 px for the
    // scrollbar on the right, so the sections are 278 px wide in a 320 px panel.
    let body = scrollable(Column::with_children(sections).padding(Padding { top: 0.0, right: tokens::scale::SPACE_4 + SCROLLBAR_GUTTER, bottom: tokens::scale::SPACE_4, left: tokens::scale::SPACE_4 }))
        .direction(scrollable::Direction::Vertical(scrollable::Scrollbar::new().width(0.0).scroller_width(0.0)))
        .height(Length::Fill);
    let mut panel = vec![kit.header(view.model, view.rename)];
    panel.extend(kit.head(view.model));
    panel.push(body.boxed());
    // The Library's footer: its place under a hairline, kept until that chunk fills it (6 px of air, a 32 px button, 8 px).
    if view.model.library {
        panel.push(crate::dock::hairline_over(Space::new().width(Length::Fill).height(FOOTER_HEIGHT).boxed(), view.theme));
    }
    // The panel fills the bounds the dock gives it.
    Column::with_children(panel).width(Length::Fill).height(Length::Fill).boxed()
}

/// The room `scrollbar-gutter: stable` keeps beside the body (Chromium's overlay-free scrollbar on Windows, 10 px here).
const SCROLLBAR_GUTTER: f32 = 10.0;

/// The place another chunk's part keeps until it lands: today's size of what it draws there.
fn slot_height(slot: m::Slot) -> Option<f32> {
    match slot {
        // The monitor is 139 px with its caption 6 px under it; the caption is the next row, 8 px on.
        m::Slot::CameraMonitor => Some(137.0),
        // The Transform and Motion switch (`.ui-segmented`, 32 px).
        m::Slot::CameraMotion => Some(tokens::scale::CONTROL_MD),
        // The IK section: its 28 px title, 12 px, the Use IK field (36 px).
        m::Slot::Ik => Some(tokens::scale::CONTROL_SM + tokens::scale::SPACE_3 + tokens::scale::CONTROL_LG),
        // The Parallax block, closed (`inspector-bare`, 55 px edge to edge): its section's 16 px above and below hold
        // the rest.
        m::Slot::Parallax => Some(55.0 - 2.0 * tokens::scale::SPACE_4),
        // Not on a screen yet: no place until its chunk measures it.
        m::Slot::DrawingSets | m::Slot::Movieclip | m::Slot::Spatial | m::Slot::DrawTools | m::Slot::BuilderSurface => None,
    }
}

/// Today's two button sizes in the panel: regular (32 px) and small (28 px: section titles, steppers, pagers).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ButtonSize {
    Regular,
    Small,
}

/// The Library footer's height (`.properties-library-save`).
const FOOTER_HEIGHT: f32 = 46.0;
