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
}

impl<'a, Message: 'a> ScrubLabel<'a, Message> {
    pub fn new(content: Element<'a, Message>, on_scrub: Arc<dyn Fn(Scrub) -> Message + 'a>) -> Self {
        ScrubLabel { content, on_scrub, slop: DRAG_SLOP, held: None }
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
    button_probe: Option<fn() -> bool>,
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
            button_probe: None,
        }
    }

    /// How a scrub asks the system whether the primary button is still down (see [`ScrubLabel::held`]).
    pub fn button_probe(mut self, probe: Option<fn() -> bool>) -> Self {
        self.button_probe = probe;
        self
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
            button_probe,
        } = field;

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

        let label_text = text(label).size(tokens::scale::TYPE_SMALL.size).font(super::INTER).color(iced::Color::from(palette.text_2));
        let mut label_element: Element<'a, Message> = label_text.boxed();
        let mut keys: Keys<'a, Message> = Keys::Button;

        if let Some(on_scrub) = on_scrub {
            label_element = ScrubLabel::new(label_element, on_scrub.clone()).held(button_probe).boxed();
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
                keyboard::Event::KeyReleased { key: Key::Named(Named::ArrowUp | Named::ArrowDown | Named::ArrowLeft | Named::ArrowRight), .. } => {
                    Some(on_scrub_keys(Scrub::KeyEnd))
                }
                _ => None,
            }));
            input = input
                .on_step({
                    let on_scrub = on_scrub.clone();
                    move |direction, shift, alt| on_scrub(Scrub::KeyStep { direction, shift, alt })
                })
                .on_step_end(on_scrub(Scrub::KeyEnd));
        }

        let label_target = Focusable::new(label_id, area, label_element, Ring::of(palette, tokens::scale::RADIUS_2XS))
            .keys(keys)
            .enabled(enabled);

        let mut children: Vec<Element<'a, Message>> = vec![label_target.boxed(), input.into_element()];
        if let Some(unit) = unit {
            children.push(text(unit).size(tokens::scale::TYPE_SMALL.size).font(super::INTER).color(iced::Color::from(palette.text_3)).boxed());
        }
        Row::with_children(children).spacing(tokens::scale::SPACE_1).align_y(iced::alignment::Vertical::Center).boxed()
    }
}
