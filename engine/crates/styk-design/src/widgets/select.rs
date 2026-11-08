//! Select (`select.css`): a field that shows the chosen option and a chevron, and lists the options in a pick list.
//!
//! The select owns its look and its keys, not the choice: Up and Down while it holds focus ask for the neighbouring option
//! (`on_step`: the owner knows which options are available), a press in the list asks for that one (`on_choose`). Its role is
//! [`InputRole::Select`], declared here, so a focused select keeps Delete and the arrow keys from the document.

use iced::Widget as _;
use super::control::{FIELD_DISABLED, Preview, words};
use super::focus::{Focusable, Keys, Ring};
use super::frame::{self, FieldFrame};
use crate::tokens::scale;
use crate::typography::TextStyle;
use crate::Palette;
use iced::keyboard::{self, Key, key::Named};
use iced::widget::{Row, container, pick_list};
use iced::{Alignment, Background, Border, Color, Element, Length, Padding};
use styk_core::focus::{FocusArea, FocusId, InputRole};

/// One option of a select.
#[derive(Clone, Debug, PartialEq)]
pub struct Choice {
    pub label: String,
    pub disabled: bool,
}

/// An option as the pick list holds it: its place among the select's options and its words.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Item {
    index: usize,
    label: String,
}

impl std::fmt::Display for Item {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.label)
    }
}

/// A select.
pub struct Select<'a, Message> {
    id: FocusId,
    area: FocusArea,
    palette: &'static Palette,
    label: Option<String>,
    options: Vec<Choice>,
    chosen: Option<usize>,
    placeholder: Option<String>,
    disabled: bool,
    in_grid: bool,
    on_choose: Box<dyn Fn(usize) -> Message + 'a>,
    on_step: Box<dyn Fn(i32) -> Message + 'a>,
    preview: Option<Preview>,
}

impl<'a, Message: Clone + 'a> Select<'a, Message> {
    /// A select over `options` showing `chosen`; `on_choose(index)` when an option is picked, `on_step(±1)` for an arrow key.
    pub fn new(id: FocusId, area: FocusArea, palette: &'static Palette, options: Vec<Choice>, chosen: Option<usize>, on_choose: impl Fn(usize) -> Message + 'a, on_step: impl Fn(i32) -> Message + 'a) -> Self {
        Select { id, area, palette, label: None, options, chosen, placeholder: None, disabled: false, in_grid: false, on_choose: Box::new(on_choose), on_step: Box::new(on_step), preview: None }
    }

    /// The label inside the field (`.ui-field[data-select]`: "Layer  Bubble"); none is a bare select.
    pub fn label(mut self, label: impl Into<String>) -> Self {
        self.label = Some(label.into());
        self
    }

    /// Shown while nothing is chosen.
    pub fn placeholder(mut self, placeholder: impl Into<String>) -> Self {
        self.placeholder = Some(placeholder.into());
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// The select is a cell of a grid of fields (tighter padding).
    pub fn in_grid(mut self, in_grid: bool) -> Self {
        self.in_grid = in_grid;
        self
    }

    pub fn preview(mut self, preview: Option<Preview>) -> Self {
        self.preview = preview;
        self
    }

    pub fn into_element(self) -> Element<'a, Message> {
        let Select { id, area, palette, label, options, chosen, placeholder, disabled, in_grid, on_choose, on_step, preview } = self;
        let ink = |color: crate::Rgba| if disabled { color.faded(FIELD_DISABLED) } else { color };
        let items: Vec<Item> = options.iter().enumerate().filter(|(_, option)| !option.disabled).map(|(index, option)| Item { index, label: option.label.clone() }).collect();
        let selected = chosen.and_then(|chosen| items.iter().find(|item| item.index == chosen).cloned());
        let typed = TextStyle::from_role(&scale::TYPE_VALUE);
        let (text, hint, handle) = (ink(palette.text_1), ink(palette.text_placeholder), ink(palette.text_3));
        let mut list = pick_list(selected, items, |item: &Item| item.label.clone())
            .font(typed.font)
            .text_size(typed.size)
            .padding(Padding { right: scale::SPACE_2 + scale::ICON_XS + scale::SPACE_1, ..Padding::ZERO })
            .width(Length::Fill)
            .handle(pick_list::Handle::None)
            .style(move |_, _| pick_list::Style {
                text_color: Color::from(text),
                placeholder_color: Color::from(hint),
                handle_color: Color::from(handle),
                background: Background::Color(Color::TRANSPARENT),
                border: Border::default(),
            });
        if let Some(placeholder) = placeholder {
            list = list.placeholder(placeholder);
        }
        if !disabled {
            list = list.on_select(move |item: Item| on_choose(item.index));
        }
        let mut parts: Vec<Element<'a, Message>> = Vec::new();
        if let Some(label) = label {
            parts.push(words(label, TextStyle::from_role(&scale::TYPE_SMALL), ink(palette.text_3)));
        }
        // `.ui-field-chev`: drawn over the select's end, so a press there still opens it.
        let chevron = container(super::icon("chevron-down", scale::ICON_XS, handle))
            .align_right(Length::Fill)
            .center_y(Length::Fill)
            .padding(Padding { right: scale::SPACE_2 - scale::SPACE_1, ..Padding::ZERO });
        parts.push(iced::widget::stack![list, chevron].boxed());
        let line = Row::with_children(parts).spacing(scale::SPACE_2).align_y(Alignment::Center);
        let keys = Keys::Custom(Box::new(move |event| match event {
            keyboard::Event::KeyPressed { key: Key::Named(Named::ArrowDown), .. } => Some(on_step(1)),
            keyboard::Event::KeyPressed { key: Key::Named(Named::ArrowUp), .. } => Some(on_step(-1)),
            _ => None,
        }));
        // The field shows focus with its own accent ring (`select:focus` draws no outline), so the target's ring is empty.
        let no_ring = Ring { color: Color::TRANSPARENT, width: 0.0, offset: 0.0, radius: 0.0 };
        let target = Focusable::new(id, area, line.boxed(), no_ring).input_role(InputRole::Select).keys(keys).enabled(!disabled);
        let (left, right) = frame::padding(in_grid);
        FieldFrame::new(target.boxed(), palette, Length::Fill, frame::HEIGHT, Padding { top: 0.0, right, bottom: 0.0, left }).disabled(disabled).preview(preview).boxed()
    }
}
