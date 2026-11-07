//! The number field and its scrub label (`docs/native/text-input.md` sections 1 and 4).
//!
//! A scrub starts on a pointer press on the label and is owned by the label until it ends: it consumes the pointer's
//! moves and its release wherever the pointer is (winit captures the mouse while a button is down, so they arrive
//! outside the widget and the window too). It ends exactly once: release (`End`), Escape, the window losing focus or a
//! touch cancel (`Cancel`). A press that never moves past the drag slop is a click (`Click`).

use super::dir::Dir;
use super::field::EditField;
use super::focus::{Focusable, Keys, Ring};
use crate::{Palette, tokens};
use iced::advanced::layout::{self, Layout};
use iced::advanced::overlay;
use iced::advanced::renderer;
use iced::advanced::widget::{self, Operation, Tree, tree};
use iced::advanced::{Shell, Widget};
use iced::keyboard::{self, Key, Modifiers, key::Named};
use iced::widget::{Row, text};
use iced::{Element, Event, Length, Rectangle, Renderer, Size, Theme, Vector, Widget as _, mouse, touch};
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
    /// The pointer is `dx` pixels from where it was pressed (positive to the right), with the step modifiers held.
    Delta { dx: f32, shift: bool, alt: bool },
    /// The gesture ended by release: commit it (one history entry).
    End,
    /// The gesture was abandoned (Escape, the window lost focus, a touch cancel): roll it back.
    Cancel,
    /// An arrow key or the wheel: one step up (`+1`) or down (`-1`), scaled by the modifiers.
    Step { direction: i32, shift: bool, alt: bool },
}

#[derive(Default)]
struct State {
    press: Option<Press>,
    modifiers: Modifiers,
    hovered: bool,
}

struct Press {
    x: f32,
    started: bool,
}

/// The label that scrubs the number beside it.
pub struct ScrubLabel<'a, Message> {
    content: Element<'a, Message>,
    on_scrub: Arc<dyn Fn(Scrub) -> Message + 'a>,
    slop: f32,
}

impl<'a, Message: 'a> ScrubLabel<'a, Message> {
    pub fn new(content: Element<'a, Message>, on_scrub: Arc<dyn Fn(Scrub) -> Message + 'a>) -> Self {
        ScrubLabel { content, on_scrub, slop: DRAG_SLOP }
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
                    state.press = Some(Press { x: position.x, started: false });
                    shell.capture_event();
                }
            }
            Event::Mouse(mouse::Event::CursorMoved { position }) => {
                if let Some(press) = &mut state.press {
                    let dx = position.x - press.x;
                    if !press.started && dx.abs() >= self.slop {
                        press.started = true;
                        shell.publish((self.on_scrub)(Scrub::Begin));
                    }
                    if press.started {
                        shell.publish((self.on_scrub)(Scrub::Delta { dx, shift, alt }));
                    }
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
            Event::Mouse(mouse::Event::WheelScrolled { delta }) if hovered && state.press.is_none() => {
                let y = match delta {
                    mouse::ScrollDelta::Lines { y, .. } | mouse::ScrollDelta::Pixels { y, .. } => *y,
                };
                if y != 0.0 {
                    shell.publish((self.on_scrub)(Scrub::Step { direction: if y > 0.0 { 1 } else { -1 }, shift, alt }));
                    shell.capture_event();
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

/// A number field: a scrub label, the input and an optional unit. Numbers stay left to right.
pub struct NumberField<'a, Message> {
    label_id: FocusId,
    field_id: FocusId,
    area: FocusArea,
    label: &'a str,
    value: std::borrow::Cow<'a, str>,
    unit: Option<&'a str>,
    palette: &'static Palette,
    enabled: bool,
    invalid: bool,
    composing: bool,
    on_input: Option<Box<dyn Fn(String) -> Message + 'a>>,
    on_enter: Option<Message>,
    on_escape: Option<Message>,
    on_scrub: Option<Arc<dyn Fn(Scrub) -> Message + 'a>>,
    on_focus_change: Option<Box<dyn Fn(bool) -> Message + 'a>>,
    on_compose: Option<Box<dyn Fn(bool) -> Message + 'a>>,
}

impl<'a, Message: Clone + 'a> NumberField<'a, Message> {
    /// A number field showing the text `value`, its label focusable as `label_id` and its input as `field_id`.
    pub fn new(
        label_id: FocusId,
        field_id: FocusId,
        area: FocusArea,
        label: &'a str,
        value: impl Into<std::borrow::Cow<'a, str>>,
        palette: &'static Palette,
    ) -> Self {
        NumberField {
            label_id,
            field_id,
            area,
            label,
            value: value.into(),
            unit: None,
            palette,
            enabled: true,
            invalid: false,
            composing: false,
            on_input: None,
            on_enter: None,
            on_escape: None,
            on_scrub: None,
            on_focus_change: None,
            on_compose: None,
        }
    }

    pub fn unit(mut self, unit: &'a str) -> Self {
        self.unit = Some(unit);
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

    pub fn on_input(mut self, on_input: impl Fn(String) -> Message + 'a) -> Self {
        self.on_input = Some(Box::new(on_input));
        self
    }

    /// Enter in the input: commit and leave the field.
    pub fn on_enter(mut self, message: Message) -> Self {
        self.on_enter = Some(message);
        self
    }

    /// Escape in the input: roll back to the gesture baseline and leave the field.
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
}

impl<'a, Message: Clone + 'a> NumberField<'a, Message> {
    /// The field as an element.
    pub fn into_element(self) -> Element<'a, Message> {
        let field = self;
        let NumberField {
            label_id,
            field_id,
            area,
            label,
            value,
            unit,
            palette,
            enabled,
            invalid,
            composing,
            on_input,
            on_enter,
            on_escape,
            on_scrub,
            on_focus_change,
            on_compose,
        } = field;

        let label_text = text(label).size(tokens::scale::TYPE_SMALL.size).font(super::INTER).color(iced::Color::from(palette.text_2));
        let mut label_element: Element<'a, Message> = label_text.boxed();
        let mut keys: Keys<'a, Message> = Keys::Button;

        if let Some(on_scrub) = on_scrub {
            label_element = ScrubLabel::new(label_element, on_scrub.clone()).boxed();
            keys = Keys::Custom(Box::new(move |event| match event {
                keyboard::Event::KeyPressed { key, modifiers, .. } => {
                    let (shift, alt) = (modifiers.shift(), modifiers.alt());
                    match key.as_ref() {
                        Key::Named(Named::Enter) => Some(on_scrub(Scrub::Click)),
                        Key::Named(Named::ArrowUp | Named::ArrowRight) => Some(on_scrub(Scrub::Step { direction: 1, shift, alt })),
                        Key::Named(Named::ArrowDown | Named::ArrowLeft) => Some(on_scrub(Scrub::Step { direction: -1, shift, alt })),
                        _ => None,
                    }
                }
                _ => None,
            }));
        }

        let label_target = Focusable::new(label_id, area, label_element, Ring::of(palette, tokens::scale::RADIUS_2XS))
            .keys(keys)
            .enabled(enabled);

        let mut input = EditField::new(field_id, area, Role::Number, value, palette)
            .dir(Dir::Ltr)
            .enabled(enabled)
            .invalid(invalid)
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

        let mut children: Vec<Element<'a, Message>> = vec![label_target.boxed(), input.into_element()];
        if let Some(unit) = unit {
            children.push(text(unit).size(tokens::scale::TYPE_SMALL.size).font(super::INTER).color(iced::Color::from(palette.text_3)).boxed());
        }
        Row::with_children(children).spacing(tokens::scale::SPACE_1).align_y(iced::alignment::Vertical::Center).boxed()
    }
}
