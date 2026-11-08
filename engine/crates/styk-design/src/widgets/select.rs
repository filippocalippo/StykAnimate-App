//! Select (`select.css`): a field that shows the chosen option and a chevron, and opens its options as an anchored menu.
//!
//! The select owns its look and the keys that open it, not the choice. A click, Space, Enter or Alt+Down asks the owner to
//! open the list (`on_open`, with the field's rectangle for `Menu::place` and whether the keyboard asked); Up and Down while
//! it holds focus ask for the neighbouring option (`on_step`: the owner knows which options are available). The list is the
//! overlay host's menu over the options (`styk_core::overlay::host::option_rows`), so arrows, typeahead, Escape and focus
//! restoration are the menu's. Its role is [`InputRole::Select`], declared here, so a focused select keeps Delete and the
//! arrow keys from the document.

use iced::Widget as _;
use super::control::{FIELD_DISABLED, Preview, words};
use super::focus::{Focusable, Keys, Ring};
use super::frame::{self, FieldFrame};
use crate::tokens::scale;
use crate::typography::TextStyle;
use crate::Palette;
use iced::advanced::layout::{self, Layout};
use iced::advanced::widget::operation::{self, Outcome};
use iced::advanced::widget::{self, Operation, Tree};
use iced::advanced::{Shell, Widget, overlay, renderer};
use iced::keyboard::{self, Key, key::Named};
use iced::widget::{Row, container};
use iced::{Alignment, Color, Element, Event, Length, Padding, Rectangle, Renderer, Size, Theme, Vector, mouse};
use styk_core::focus::{FocusArea, FocusId, InputRole};

/// One option of a select.
#[derive(Clone, Debug, PartialEq)]
pub struct Choice {
    pub label: String,
    pub disabled: bool,
}

/// A request to open a select's list.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Open {
    /// The select's rectangle in the window: the list is placed under it.
    pub anchor: Rectangle,
    /// A key asked (the list opens on the chosen option with the ring showing); otherwise a press did.
    pub keyboard: bool,
}

/// Whether anything in a subtree holds focus.
struct AnyFocused(bool);

impl Operation for AnyFocused {
    fn traverse(&mut self, operate: &mut dyn FnMut(&mut dyn Operation<()>)) {
        operate(self);
    }

    fn focusable(&mut self, _id: Option<&widget::Id>, _bounds: Rectangle, state: &mut dyn operation::Focusable) {
        self.0 |= state.is_focused();
    }

    fn finish(&self) -> Outcome<()> {
        Outcome::None
    }
}

/// Turns a press on the field, and the opening keys while it holds focus, into `on_open` and `on_step`.
struct Opener<'a, Message> {
    content: Element<'a, Message>,
    on_open: Box<dyn Fn(Open) -> Message + 'a>,
    on_step: Box<dyn Fn(i32) -> Message + 'a>,
    enabled: bool,
}

impl<Message> widget::Meta for Opener<'_, Message> {}

impl<'a, Message: 'a> Widget<Message, Theme, Renderer> for Opener<'a, Message> {
    fn size(&self) -> Size<Length> {
        self.content.size()
    }

    fn diff(&mut self, tree: &mut Tree) {
        tree.diff_children(std::slice::from_mut(&mut self.content));
    }

    fn layout(&mut self, tree: &mut Tree, renderer: &Renderer, limits: &layout::Limits) {
        self.content.layout(&mut tree.children[0], renderer, limits);
        tree.size = tree.children[0].size;
    }

    fn operate(&mut self, tree: &mut Tree, layout: Layout, viewport: &Rectangle, renderer: &Renderer, operation: &mut dyn Operation) {
        self.content.operate(&mut tree.children[0], layout, viewport, renderer, operation);
    }

    fn update(&mut self, tree: &mut Tree, event: &Event, layout: Layout, cursor: mouse::Cursor, renderer: &Renderer, shell: &mut Shell<'_, Message>, viewport: &Rectangle) {
        self.content.update(&mut tree.children[0], event, layout, cursor, renderer, shell, viewport);
        if !self.enabled || shell.is_event_captured() {
            return;
        }
        let anchor = layout.bounds();
        match event {
            Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left)) if cursor.is_over(anchor) => {
                shell.publish((self.on_open)(Open { anchor, keyboard: false }));
                shell.capture_event();
            }
            Event::Keyboard(keyboard::Event::KeyPressed { key, modifiers, repeat: false, .. }) => {
                let mut probe = AnyFocused(false);
                self.content.operate(&mut tree.children[0], layout, viewport, renderer, &mut probe);
                if !probe.0 {
                    return;
                }
                let message = match key.as_ref() {
                    Key::Named(Named::Space | Named::Enter) => Some((self.on_open)(Open { anchor, keyboard: true })),
                    Key::Named(Named::ArrowDown) if modifiers.alt() => Some((self.on_open)(Open { anchor, keyboard: true })),
                    Key::Named(Named::ArrowDown) => Some((self.on_step)(1)),
                    Key::Named(Named::ArrowUp) => Some((self.on_step)(-1)),
                    _ => None,
                };
                if let Some(message) = message {
                    shell.publish(message);
                    shell.capture_event();
                }
            }
            _ => {}
        }
    }

    fn mouse_interaction(&self, tree: &Tree, layout: Layout, cursor: mouse::Cursor, viewport: &Rectangle, renderer: &Renderer) -> mouse::Interaction {
        self.content.mouse_interaction(&tree.children[0], layout, cursor, viewport, renderer)
    }

    fn draw(&self, tree: &Tree, renderer: &mut Renderer, theme: &Theme, style: &renderer::Style, layout: Layout, cursor: mouse::Cursor, viewport: &Rectangle) {
        self.content.draw(&tree.children[0], renderer, theme, style, layout, cursor, viewport);
    }

    fn overlay<'b>(&'b mut self, tree: &'b mut Tree, layout: Layout, renderer: &Renderer, viewport: &Rectangle, translation: Vector, window: Size) -> Vec<overlay::Element<'b, Message, Theme, Renderer>> {
        self.content.overlay(&mut tree.children[0], layout, renderer, viewport, translation, window)
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
    /// The standalone form of dialogs and popovers (`.ui-select`), not the inspector's field (`.ui-field[data-select]`).
    form: bool,
    on_open: Box<dyn Fn(Open) -> Message + 'a>,
    on_step: Box<dyn Fn(i32) -> Message + 'a>,
    preview: Option<Preview>,
}

impl<'a, Message: Clone + 'a> Select<'a, Message> {
    /// A select over `options` showing `chosen`; `on_open` when its list should open, `on_step(±1)` for an arrow key.
    pub fn new(id: FocusId, area: FocusArea, palette: &'static Palette, options: Vec<Choice>, chosen: Option<usize>, on_open: impl Fn(Open) -> Message + 'a, on_step: impl Fn(i32) -> Message + 'a) -> Self {
        Select { id, area, palette, label: None, options, chosen, placeholder: None, disabled: false, in_grid: false, form: false, on_open: Box::new(on_open), on_step: Box::new(on_step), preview: None }
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
    /// The select as a dialog or popover holds it (`.ui-select`): its chevron is `--icon-sm`, 10 px from the end, where the
    /// inspector's field draws `--icon-xs` (`select.css`).
    pub fn form(mut self, form: bool) -> Self {
        self.form = form;
        self
    }

    pub fn in_grid(mut self, in_grid: bool) -> Self {
        self.in_grid = in_grid;
        self
    }

    pub fn preview(mut self, preview: Option<Preview>) -> Self {
        self.preview = preview;
        self
    }

    pub fn into_element(self) -> Element<'a, Message> {
        let Select { id, area, palette, label, options, chosen, placeholder, disabled, in_grid, form, on_open, on_step, preview } = self;
        let (left, right) = frame::padding(in_grid);
        // `.ui-select > svg`: `--icon-sm` at 10 px from the end, the value clear of it by `--space-1-5`; `.ui-field-chev`: `--icon-xs`.
        let (glyph, clear, edge) = if form { (scale::ICON_SM, scale::SPACE_1_5, scale::SPACE_2_5 - right) } else { (scale::ICON_XS, scale::SPACE_1, scale::SPACE_2 - scale::SPACE_1) };
        let ink = |color: crate::Rgba| if disabled { color.faded(FIELD_DISABLED) } else { color };
        let typed = TextStyle::from_role(&scale::TYPE_VALUE);
        let (text, hint, handle) = (ink(palette.text_1), ink(palette.text_placeholder), ink(palette.text_3));
        let shown = chosen
            .and_then(|chosen| options.get(chosen))
            .map(|option| words(option.label.clone(), typed, text))
            .or_else(|| placeholder.map(|placeholder| words(placeholder, typed, hint)));
        let value = container(shown.unwrap_or_else(|| words(String::new(), typed, text))).width(Length::Fill).padding(Padding { right: scale::SPACE_2 + glyph + clear, ..Padding::ZERO });
        let mut parts: Vec<Element<'a, Message>> = Vec::new();
        if let Some(label) = label {
            parts.push(words(label, TextStyle::from_role(&scale::TYPE_SMALL), ink(palette.text_3)));
        }
        // `.ui-field-chev`: drawn over the select's end, so a press there still opens it.
        let chevron = container(super::icon("chevron-down", glyph, handle))
            .align_right(Length::Fill)
            .center_y(Length::Fill)
            .padding(Padding { right: edge, ..Padding::ZERO });
        parts.push(iced::widget::stack![value, chevron].boxed());
        let line = Row::with_children(parts).spacing(scale::SPACE_2).align_y(Alignment::Center);
        // The field shows focus with its own accent ring (`select:focus` draws no outline), so the target's ring is empty.
        let no_ring = Ring { color: Color::TRANSPARENT, width: 0.0, offset: 0.0, radius: 0.0 };
        let target = Focusable::new(id, area, line.boxed(), no_ring).input_role(InputRole::Select).keys(Keys::Custom(Box::new(|_| None))).enabled(!disabled);
        let framed = FieldFrame::new(target.boxed(), palette, Length::Fill, frame::HEIGHT, Padding { top: 0.0, right, bottom: 0.0, left }).disabled(disabled).preview(preview);
        Opener { content: framed.boxed(), on_open, on_step, enabled: !disabled }.boxed()
    }
}
