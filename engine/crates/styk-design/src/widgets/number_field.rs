//! The number field and its scrub label (`docs/native/text-input.md` sections 1 and 4).
//!
//! A scrub starts on a pointer press on the label and is owned by the label until it ends: it consumes the pointer's
//! moves and its release wherever the pointer is (winit captures the mouse while a button is down, so they arrive
//! outside the widget and the window too). It ends exactly once: release (`End`), Escape, the window losing focus or a
//! touch cancel (`Cancel`). A press that never moves past the drag slop is a click (`Click`).

use super::control::{FIELD_DISABLED, Preview, words};
use super::field::EditField;
use super::focus::{Focusable, Keys, Ring};
use super::frame::{self, FieldFrame};
use crate::typography::TextStyle;
use crate::{Palette, tokens};
use iced::advanced::layout::{self, Layout};
use iced::advanced::overlay;
use iced::advanced::renderer;
use iced::advanced::widget::{self, Operation, Tree, tree};
use iced::advanced::{Shell, Widget};
use iced::keyboard::{self, Key, Modifiers, key::Named};
use iced::widget::{Row, Space, container};
use iced::{Alignment, Element, Event, Length, Padding, Rectangle, Renderer, Size, Theme, Vector, Widget as _, mouse, touch};
use std::borrow::Cow;
use std::sync::Arc;
use styk_core::field::Role;
use styk_core::focus::{FocusArea, FocusId};

/// How far (in pixels) a press must move before it is a scrub rather than a click.
pub const DRAG_SLOP: f32 = 3.0;

/// What the scrub label reports.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Scrub {
    /// A press and release without scrubbing, or Enter on the label: focus the input and select its text.
    Click,
    /// The pointer moved past the drag slop: the gesture begins.
    Begin,
    /// The pointer moved `dx` pixels (positive to the right) since the previous movement, with the step modifiers held
    /// *at this movement*: the owner adds each one, as `property-controls.mjs` does, so a change of Shift mid-drag does
    /// not rescale what was travelled.
    Delta { dx: f32, shift: bool, alt: bool },
    /// The gesture ended by release: commit it (one history entry).
    End,
    /// The gesture was abandoned (Escape, the window lost focus, the button released elsewhere, a touch cancel, the
    /// label removed or disabled): roll it back. Exactly one of `End` and `Cancel` ends a gesture.
    Cancel,
    /// An arrow key (`+1` up or right, `-1` down or left) pressed on the label or in the input: one step, scaled by the
    /// modifiers. Holding the key repeats it inside one gesture.
    KeyStep { direction: i32, shift: bool, alt: bool },
    /// The arrow key was released: the held key's gesture ends.
    KeyEnd,
}

#[derive(Default)]
struct State {
    press: Option<Press>,
    modifiers: Modifiers,
    hovered: bool,
}

struct Press {
    start_x: f32,
    last_x: f32,
    started: bool,
}

/// The label that scrubs the number beside it.
pub struct ScrubLabel<'a, Message> {
    content: Element<'a, Message>,
    on_scrub: Arc<dyn Fn(Scrub) -> Message + 'a>,
    slop: f32,
    held: Option<fn() -> bool>,
    /// The dotted underline's colour (`text-decoration: underline dotted 1px var(--line-3)`).
    underline: Option<crate::Rgba>,
}

impl<'a, Message: 'a> ScrubLabel<'a, Message> {
    pub fn new(content: Element<'a, Message>, on_scrub: Arc<dyn Fn(Scrub) -> Message + 'a>) -> Self {
        ScrubLabel { content, on_scrub, slop: DRAG_SLOP, held: None, underline: None }
    }

    /// Says at rest that the label scrubs: a 1 px dotted line along the foot of its line box.
    pub fn underline(mut self, color: crate::Rgba) -> Self {
        self.underline = Some(color);
        self
    }

    /// Asks the system whether the primary button is still down. winit captures the mouse while a button is held, but
    /// when another window takes the capture no event says so: a scrub that sees the button up is cancelled.
    pub fn held(mut self, held: Option<fn() -> bool>) -> Self {
        self.held = held;
        self
    }

    /// Overrides the drag slop.
    pub fn slop(mut self, slop: f32) -> Self {
        self.slop = slop;
        self
    }
}

impl<Message> widget::Meta for ScrubLabel<'_, Message> {}

impl<'a, Message: 'a> Widget<Message, Theme, Renderer> for ScrubLabel<'a, Message> {
    fn tag(&self) -> tree::Tag {
        tree::Tag::of::<State>()
    }

    fn state(&self) -> tree::State {
        tree::State::new(State::default())
    }

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

    fn update(
        &mut self,
        tree: &mut Tree,
        event: &Event,
        layout: Layout,
        cursor: mouse::Cursor,
        _renderer: &Renderer,
        shell: &mut Shell<'_, Message>,
        _viewport: &Rectangle,
    ) {
        let bounds = layout.bounds();
        let state = tree.state.downcast_mut::<State>();
        let hovered = cursor.is_over(bounds);
        if hovered != state.hovered {
            state.hovered = hovered;
            shell.request_redraw();
        }

        if let Event::Keyboard(keyboard::Event::ModifiersChanged(modifiers)) = event {
            state.modifiers = *modifiers;
        }
        let (shift, alt) = (state.modifiers.shift(), state.modifiers.alt());

        // The capture was lost (a system menu, another window took it): the button is up and no event says so.
        if matches!(event, Event::Mouse(mouse::Event::CursorMoved { .. }) | Event::Window(iced::window::Event::RedrawRequested(_)))
            && state.press.as_ref().is_some_and(|press| press.started)
            && self.held.is_some_and(|held| !held())
        {
            state.press = None;
            shell.publish((self.on_scrub)(Scrub::Cancel));
            shell.capture_event();
            return;
        }

        match event {
            Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left)) => {
                if let Some(press) = state.press.take() {
                    // A second press during a scrub ends it.
                    if press.started {
                        shell.publish((self.on_scrub)(Scrub::End));
                    }
                    shell.capture_event();
                } else if cursor.is_over(bounds)
                    && let Some(position) = cursor.position()
                {
                    state.press = Some(Press { start_x: position.x, last_x: position.x, started: false });
                    shell.capture_event();
                }
            }
            Event::Mouse(mouse::Event::CursorMoved { position }) => {
                if let Some(press) = &mut state.press {
                    // A press that has not travelled the drag slop is not a scrub yet.
                    if !press.started && (position.x - press.start_x).abs() < self.slop {
                        shell.capture_event();
                        return;
                    }
                    if !press.started {
                        press.started = true;
                        shell.publish((self.on_scrub)(Scrub::Begin));
                    }
                    let dx = position.x - press.last_x;
                    press.last_x = position.x;
                    shell.publish((self.on_scrub)(Scrub::Delta { dx, shift, alt }));
                    shell.capture_event();
                }
            }
            Event::Mouse(mouse::Event::ButtonReleased(mouse::Button::Left)) => {
                if let Some(press) = state.press.take() {
                    shell.publish((self.on_scrub)(if press.started { Scrub::End } else { Scrub::Click }));
                    shell.capture_event();
                }
            }
            Event::Keyboard(keyboard::Event::KeyPressed { key: Key::Named(Named::Escape), .. }) => {
                if let Some(press) = state.press.take() {
                    if press.started {
                        shell.publish((self.on_scrub)(Scrub::Cancel));
                    }
                    shell.capture_event();
                }
            }
            Event::Window(iced::window::Event::Unfocused) | Event::Touch(touch::Event::FingerLost { .. }) => {
                if let Some(press) = state.press.take()
                    && press.started
                {
                    shell.publish((self.on_scrub)(Scrub::Cancel));
                }
            }
            _ => {}
        }
    }

    fn mouse_interaction(
        &self,
        tree: &Tree,
        layout: Layout,
        cursor: mouse::Cursor,
        _viewport: &Rectangle,
        _renderer: &Renderer,
    ) -> mouse::Interaction {
        let state = tree.state.downcast_ref::<State>();
        if state.press.is_some() || cursor.is_over(layout.bounds()) {
            mouse::Interaction::ResizingHorizontally
        } else {
            mouse::Interaction::None
        }
    }

    fn draw(
        &self,
        tree: &Tree,
        renderer: &mut Renderer,
        theme: &Theme,
        style: &renderer::Style,
        layout: Layout,
        cursor: mouse::Cursor,
        viewport: &Rectangle,
    ) {
        self.content.draw(&tree.children[0], renderer, theme, style, layout, cursor, viewport);
        if let Some(color) = self.underline {
            use iced::advanced::Renderer as _;
            let bounds = layout.bounds();
            let (left, row) = (bounds.x.round(), (bounds.y + bounds.height).round() - 1.0);
            let dots = (bounds.width / 2.0).ceil() as u32;
            for dot in 0..dots {
                let at = Rectangle { x: left + 2.0 * dot as f32, y: row, width: 1.0, height: 1.0 };
                renderer.fill_quad(renderer::Quad { bounds: at, snap: true, ..renderer::Quad::default() }, iced::Color::from(color));
            }
        }
    }

    fn overlay<'b>(
        &'b mut self,
        tree: &'b mut Tree,
        layout: Layout,
        renderer: &Renderer,
        viewport: &Rectangle,
        translation: Vector,
        window: Size,
    ) -> Vec<overlay::Element<'b, Message, Theme, Renderer>> {
        self.content.overlay(&mut tree.children[0], layout, renderer, viewport, translation, window)
    }
}



/// How wide a field's value is set (`--type-value`, tabular, `field-sizing: content`): its text's width, at least one `0`.
pub fn value_width(value: &str) -> f32 {
    use iced::advanced::graphics::text::Paragraph;
    use iced::advanced::text::{Alignment as TextAlignment, Ellipsis, Paragraph as _, Shaping, Text, Wrapping};
    let style = TextStyle::from_role(&tokens::scale::TYPE_VALUE).tabular();
    let width = |content: &str| {
        Paragraph::with_text(Text {
            content,
            bounds: iced::Size::new(f32::INFINITY, f32::INFINITY),
            size: style.pixels(),
            line_height: style.line(),
            font: style.font,
            align_x: TextAlignment::Default,
            align_y: iced::alignment::Vertical::Top,
            shaping: Shaping::Advanced,
            wrapping: Wrapping::None,
            ellipsis: Ellipsis::None,
            hint_factor: None,
        })
        .min_width()
    };
    width(value).max(width("0"))
}

/// A number field: its label (which scrubs), the value (typed, as wide as its text), the unit after it, in the field box.
/// Numbers stay left to right. The input declares the text role, so a focused field keeps editing keys from the document.
pub struct NumberField<'a, Message> {
    label_id: FocusId,
    field_id: FocusId,
    area: FocusArea,
    label: Cow<'a, str>,
    value: Cow<'a, str>,
    unit: Option<Cow<'a, str>>,
    placeholder: Cow<'a, str>,
    palette: &'static Palette,
    enabled: bool,
    invalid: bool,
    composing: bool,
    in_grid: bool,
    scrubbing: bool,
    preview: Option<Preview>,
    on_input: Option<Box<dyn Fn(String) -> Message + 'a>>,
    on_enter: Option<Message>,
    on_escape: Option<Message>,
    on_scrub: Option<Arc<dyn Fn(Scrub) -> Message + 'a>>,
    on_focus_change: Option<Box<dyn Fn(bool) -> Message + 'a>>,
    on_compose: Option<Box<dyn Fn(bool) -> Message + 'a>>,
    button_probe: Option<fn() -> bool>,
}

/// The parts of a number field before they are framed: the label, the value with its unit, and the value's width.
pub struct Parts<'a, Message> {
    pub label: Element<'a, Message>,
    pub value: Element<'a, Message>,
    pub value_width: f32,
}

impl<'a, Message: Clone + 'a> NumberField<'a, Message> {
    /// A number field showing the text `value`, its label focusable as `label_id` and its input as `field_id`.
    pub fn new(label_id: FocusId, field_id: FocusId, area: FocusArea, label: impl Into<Cow<'a, str>>, value: impl Into<Cow<'a, str>>, palette: &'static Palette) -> Self {
        NumberField {
            label_id,
            field_id,
            area,
            label: label.into(),
            value: value.into(),
            unit: None,
            placeholder: Cow::Borrowed(""),
            palette,
            enabled: true,
            invalid: false,
            composing: false,
            in_grid: false,
            scrubbing: false,
            preview: None,
            on_input: None,
            on_enter: None,
            on_escape: None,
            on_scrub: None,
            on_focus_change: None,
            on_compose: None,
            button_probe: None,
        }
    }

    /// How a scrub asks the system whether the primary button is still down (see [`ScrubLabel::held`]).
    pub fn button_probe(mut self, probe: Option<fn() -> bool>) -> Self {
        self.button_probe = probe;
        self
    }

    pub fn unit(mut self, unit: impl Into<Cow<'a, str>>) -> Self {
        self.unit = Some(unit.into());
        self
    }

    /// Shown while the value is empty ("Mixed" for a selection whose values differ).
    pub fn placeholder(mut self, placeholder: impl Into<Cow<'a, str>>) -> Self {
        self.placeholder = placeholder.into();
        self
    }

    pub fn enabled(mut self, enabled: bool) -> Self {
        self.enabled = enabled;
        self
    }

    pub fn invalid(mut self, invalid: bool) -> Self {
        self.invalid = invalid;
        self
    }

    pub fn composing(mut self, composing: bool) -> Self {
        self.composing = composing;
        self
    }

    /// The field is a cell of a grid of fields (`.ui-field-grid > .ui-field`: tighter padding and gaps).
    pub fn in_grid(mut self, in_grid: bool) -> Self {
        self.in_grid = in_grid;
        self
    }

    /// A scrub is under way (`[data-scrubbing]`): the field draws as focused.
    pub fn scrubbing(mut self, scrubbing: bool) -> Self {
        self.scrubbing = scrubbing;
        self
    }

    /// Holds a state of the field's frame fixed (the component sheet and tests).
    pub fn preview(mut self, preview: Option<Preview>) -> Self {
        self.preview = preview;
        self
    }

    pub fn on_input(mut self, on_input: impl Fn(String) -> Message + 'a) -> Self {
        self.on_input = Some(Box::new(on_input));
        self
    }

    /// Enter in the input: commit and leave the field.
    pub fn on_enter(mut self, message: Message) -> Self {
        self.on_enter = Some(message);
        self
    }

    /// Escape in the input: cancel the edit; the field keeps focus (today's number fields do).
    pub fn on_escape(mut self, message: Message) -> Self {
        self.on_escape = Some(message);
        self
    }

    /// The scrub label's events and the steps of the arrow keys.
    pub fn on_scrub(mut self, on_scrub: impl Fn(Scrub) -> Message + 'a) -> Self {
        self.on_scrub = Some(Arc::new(on_scrub));
        self
    }

    pub fn on_focus_change(mut self, on_focus_change: impl Fn(bool) -> Message + 'a) -> Self {
        self.on_focus_change = Some(Box::new(on_focus_change));
        self
    }

    pub fn on_compose(mut self, on_compose: impl Fn(bool) -> Message + 'a) -> Self {
        self.on_compose = Some(Box::new(on_compose));
        self
    }

    /// The gap between a field's parts (`--_gap`): 4 px in a grid, 8 px elsewhere.
    fn gap(&self) -> f32 {
        if self.in_grid { tokens::scale::SPACE_1 } else { tokens::scale::SPACE_2 }
    }

    /// The label and the value with its unit, unframed.
    pub fn parts(self) -> Parts<'a, Message> {
        let NumberField { label_id, field_id, area, label, value, unit, placeholder, palette, enabled, invalid, composing, on_input, on_enter, on_escape, on_scrub, on_focus_change, on_compose, button_probe, .. } = self;
        let fade = |color: crate::Rgba| if enabled { color } else { color.faded(FIELD_DISABLED) };
        let shown = if value.is_empty() { placeholder.to_string() } else { value.to_string() };
        let value_width = value_width(&shown);
        let mut input = EditField::new(field_id, area, Role::Number, value, palette)
            .embedded()
            .width(Length::Fixed(value_width))
            .enabled(enabled)
            .invalid(invalid)
            .placeholder(placeholder)
            .composing(composing);
        if let Some(on_input) = on_input {
            input = input.on_input(on_input);
        }
        if let Some(message) = on_enter {
            input = input.on_enter(message);
        }
        if let Some(message) = on_escape {
            input = input.on_escape(message);
        }
        if let Some(on_focus_change) = on_focus_change {
            input = input.on_focus_change(on_focus_change);
        }
        if let Some(on_compose) = on_compose {
            input = input.on_compose(on_compose);
        }

        let mut label_element: Element<'a, Message> = words(label.into_owned(), TextStyle::from_role(&tokens::scale::TYPE_SMALL), fade(palette.text_3));
        let mut keys: Keys<'a, Message> = Keys::Button;
        if let Some(on_scrub) = on_scrub {
            label_element = ScrubLabel::new(label_element, on_scrub.clone()).held(button_probe).underline(fade(palette.line_3)).boxed();
            let on_scrub_keys = on_scrub.clone();
            keys = Keys::Custom(Box::new(move |event| match event {
                // Ctrl and Meta arrows pass through, as today.
                keyboard::Event::KeyPressed { key, modifiers, .. } if !modifiers.control() && !modifiers.logo() => {
                    let (shift, alt) = (modifiers.shift(), modifiers.alt());
                    match key.as_ref() {
                        Key::Named(Named::Enter) => Some(on_scrub_keys(Scrub::Click)),
                        Key::Named(Named::ArrowUp | Named::ArrowRight) => Some(on_scrub_keys(Scrub::KeyStep { direction: 1, shift, alt })),
                        Key::Named(Named::ArrowDown | Named::ArrowLeft) => Some(on_scrub_keys(Scrub::KeyStep { direction: -1, shift, alt })),
                        _ => None,
                    }
                }
                keyboard::Event::KeyReleased { key: Key::Named(Named::ArrowUp | Named::ArrowDown | Named::ArrowLeft | Named::ArrowRight), .. } => Some(on_scrub_keys(Scrub::KeyEnd)),
                _ => None,
            }));
            input = input
                .on_step({
                    let on_scrub = on_scrub.clone();
                    move |direction, shift, alt| on_scrub(Scrub::KeyStep { direction, shift, alt })
                })
                .on_step_end(on_scrub(Scrub::KeyEnd));
        }
        let label = Focusable::new(label_id, area, label_element, Ring::of(palette, tokens::scale::RADIUS_2XS)).keys(keys).enabled(enabled);

        // The unit follows its value (`.ui-field-suffix`): against it for `%`, `°` and `×`, a quarter em away otherwise.
        let mut value_row: Vec<Element<'a, Message>> = vec![input.into_element()];
        let mut spacing = 0.0;
        if let Some(unit) = &unit
            && !unit.is_empty()
        {
            value_row.push(words(unit.to_string(), TextStyle::from_role(&tokens::scale::TYPE_VALUE), fade(palette.text_2)));
            spacing = if styk_core::number::unit_is_glued(unit) { 0.0 } else { 0.25 * tokens::scale::TYPE_VALUE.size };
        }
        let value = Row::with_children(value_row).spacing(spacing).align_y(Alignment::Center).boxed();
        Parts { label: label.boxed(), value, value_width }
    }

    /// The field as an element: a field box holding the label, the value and the unit.
    pub fn into_element(self) -> Element<'a, Message> {
        let (palette, disabled, invalid, scrubbing, in_grid, preview, gap) = (self.palette, !self.enabled, self.invalid, self.scrubbing, self.in_grid, self.preview, self.gap());
        let Parts { label, value, .. } = self.parts();
        let line = Row::with_children([label, value, Space::new().width(Length::Fill).boxed()]).spacing(gap).align_y(Alignment::Center);
        let (left, right) = frame::padding(in_grid);
        FieldFrame::new(line.boxed(), palette, Length::Fill, frame::HEIGHT, Padding { top: 0.0, right, bottom: 0.0, left }).disabled(disabled).invalid(invalid).engaged(scrubbing).preview(preview).boxed()
    }

    /// The field with a step button each side of the value (`.ui-field[data-steps]`: "Order ↓ 2 ↑"): the label, the step
    /// down, the value centred in at least three digits, the step up; 2 px of padding, no gaps, as wide as its parts.
    pub fn stepper(self, down: Element<'a, Message>, up: Element<'a, Message>) -> Element<'a, Message> {
        let (palette, disabled, invalid, scrubbing, preview) = (self.palette, !self.enabled, self.invalid, self.scrubbing, self.preview);
        let Parts { label, value, value_width: shown } = self.parts();
        let label = container(label).padding(Padding { top: 0.0, right: tokens::scale::SPACE_0_5, bottom: 0.0, left: tokens::scale::SPACE_1 });
        let value = container(value).center_x(Length::Fixed(shown.max(3.0 * value_width("0"))));
        let line = Row::with_children([label.boxed(), down, value.boxed(), up]).align_y(Alignment::Center);
        FieldFrame::new(line.boxed(), palette, Length::Shrink, frame::HEIGHT, Padding::from([0.0, tokens::scale::SPACE_0_5 + 1.0])).disabled(disabled).invalid(invalid).engaged(scrubbing).preview(preview).boxed()
    }
}
