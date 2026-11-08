//! The pressable surface the buttons, chips and segmented items are built on: a box that draws a fill, a ring and shadows
//! for the interaction it is in, shows one of two faces (a control's ink changes on hover: an icon button's glyph goes from
//! `--text-2` to `--text-1`), and publishes its message when a press that began on it ends on it.
//!
//! It is not a focus target: `focus::Focusable` wraps it, so Tab, the ring and Enter and Space come from the one wrapper.
//! The cursor stays an arrow (the stylesheets set no `cursor` on buttons).

use super::control::{Interaction, Preview, paint_fill, paint_ring, paint_shadows};
use crate::{BoxShadow, Rgba};
use iced::advanced::layout::{self, Layout};
use iced::advanced::renderer;
use iced::advanced::widget::{self, Operation, Tree, tree};
use iced::advanced::{Shell, Widget};
use iced::{Element, Event, Length, Rectangle, Renderer, Size, Theme, Vector, mouse, touch};

/// How a surface looks in one interaction.
#[derive(Clone, Debug)]
pub struct Look {
    pub fill: Option<Rgba>,
    /// The transparent border the ring sits inside (`border: 1px solid transparent` with `box-shadow: inset`): the ring is
    /// drawn this far in from the edge.
    pub border: f32,
    /// An inset ring: its width and colour.
    pub ring: Option<(f32, Rgba)>,
    pub shadows: &'static [BoxShadow],
    pub radius: f32,
    /// Multiplies every colour drawn (a disabled control).
    pub opacity: f32,
    /// The look is drawn at this scale about its centre (`transform: scale(var(--press-scale))` while a button is pressed).
    pub scale: f32,
}

impl Look {
    /// A flat look of `radius` with nothing drawn.
    pub fn plain(radius: f32) -> Look {
        Look { fill: None, border: 0.0, ring: None, shadows: &[], radius, opacity: 1.0, scale: 1.0 }
    }
}

#[derive(Default)]
struct State {
    pressed: bool,
}

/// The surface.
pub struct Surface<'a, Message> {
    rest: Element<'a, Message>,
    hover: Option<Element<'a, Message>>,
    look: Box<dyn Fn(Interaction) -> Look + 'a>,
    on_press: Option<Message>,
    preview: Option<Preview>,
    width: Length,
    height: Length,
}

impl<'a, Message: Clone + 'a> Surface<'a, Message> {
    /// A surface showing `face`, drawn as `look` says for each interaction.
    pub fn new(face: Element<'a, Message>, look: impl Fn(Interaction) -> Look + 'a) -> Self {
        Surface { rest: face, hover: None, look: Box::new(look), on_press: None, preview: None, width: Length::Shrink, height: Length::Shrink }
    }

    /// The face shown while hovered or pressed, when it differs from the rest face (the same size).
    pub fn hover_face(mut self, face: Element<'a, Message>) -> Self {
        self.hover = Some(face);
        self
    }

    /// Published when a press that began here is released here. A surface with none is inert (disabled).
    pub fn on_press_maybe(mut self, message: Option<Message>) -> Self {
        self.on_press = message;
        self
    }

    /// Holds a state fixed (the component sheet and tests).
    pub fn preview(mut self, preview: Option<Preview>) -> Self {
        self.preview = preview;
        self
    }

    pub fn width(mut self, width: impl Into<Length>) -> Self {
        self.width = width.into();
        self
    }

    pub fn height(mut self, height: impl Into<Length>) -> Self {
        self.height = height.into();
        self
    }

    fn interaction(&self, state: &State, bounds: Rectangle, cursor: mouse::Cursor) -> Interaction {
        if let Some(held) = self.preview.and_then(Preview::interaction) {
            return held;
        }
        if self.on_press.is_none() {
            return Interaction::Rest;
        }
        match (cursor.is_over(bounds), state.pressed) {
            (true, true) => Interaction::Pressed,
            (true, false) => Interaction::Hover,
            _ => Interaction::Rest,
        }
    }
}

impl<Message> widget::Meta for Surface<'_, Message> {}

impl<'a, Message: Clone + 'a> Widget<Message, Theme, Renderer> for Surface<'a, Message> {
    fn tag(&self) -> tree::Tag {
        tree::Tag::of::<State>()
    }

    fn state(&self) -> tree::State {
        tree::State::new(State::default())
    }

    fn size(&self) -> Size<Length> {
        Size::new(self.width, self.height)
    }

    fn diff(&mut self, tree: &mut Tree) {
        let mut faces: Vec<&mut Element<'a, Message>> = vec![&mut self.rest];
        faces.extend(self.hover.iter_mut());
        tree.diff_children(&mut faces);
    }

    fn layout(&mut self, tree: &mut Tree, renderer: &Renderer, limits: &layout::Limits) {
        let (width, height) = (self.width, self.height);
        let rest = &mut self.rest;
        layout::contained(tree, limits, width, height, |child, limits| {
            rest.layout(child, renderer, limits);
            child.size
        });
        // The hover face is laid out in the same limits, so the two are the same size.
        if let Some(hover) = &mut self.hover {
            hover.layout(&mut tree.children[1], renderer, &limits.width(width).height(height));
            tree.children[1].translation = Vector::ZERO;
        }
    }

    fn operate(&mut self, tree: &mut Tree, layout: Layout, viewport: &Rectangle, renderer: &Renderer, operation: &mut dyn Operation) {
        self.rest.operate(&mut tree.children[0], layout, viewport, renderer, operation);
    }

    fn update(&mut self, tree: &mut Tree, event: &Event, layout: Layout, cursor: mouse::Cursor, renderer: &Renderer, shell: &mut Shell<'_, Message>, viewport: &Rectangle) {
        let bounds = layout.bounds();
        self.rest.update(&mut tree.children[0], event, layout, cursor, renderer, shell, viewport);
        let state = tree.state.downcast_mut::<State>();
        let was = (cursor.is_over(bounds), state.pressed);
        match event {
            Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left)) | Event::Touch(touch::Event::FingerPressed { .. })
                if self.on_press.is_some() && cursor.is_over(bounds) && !shell.is_event_captured() =>
            {
                state.pressed = true;
                shell.capture_event();
            }
            Event::Mouse(mouse::Event::ButtonReleased(mouse::Button::Left)) | Event::Touch(touch::Event::FingerLifted { .. }) if state.pressed => {
                state.pressed = false;
                if cursor.is_over(bounds)
                    && let Some(message) = &self.on_press
                {
                    shell.publish(message.clone());
                }
                shell.capture_event();
            }
            Event::Window(iced::window::Event::Unfocused) | Event::Touch(touch::Event::FingerLost { .. }) => state.pressed = false,
            _ => {}
        }
        if self.on_press.is_none() {
            state.pressed = false;
        }
        if (cursor.is_over(bounds), state.pressed) != was {
            shell.request_redraw();
        }
    }

    fn mouse_interaction(&self, _tree: &Tree, _layout: Layout, _cursor: mouse::Cursor, _viewport: &Rectangle, _renderer: &Renderer) -> mouse::Interaction {
        mouse::Interaction::None
    }

    fn draw(&self, tree: &Tree, renderer: &mut Renderer, theme: &Theme, style: &renderer::Style, layout: Layout, cursor: mouse::Cursor, viewport: &Rectangle) {
        let bounds = layout.bounds();
        let interaction = self.interaction(tree.state.downcast_ref::<State>(), bounds, cursor);
        let look = (self.look)(interaction);
        // A pressed button is drawn at `--press-scale` about its centre; its words keep their size (the 3 % is about a pixel).
        let (width, height) = (bounds.width * look.scale, bounds.height * look.scale);
        let bounds = Rectangle { x: bounds.x + (bounds.width - width) / 2.0, y: bounds.y + (bounds.height - height) / 2.0, width, height };
        paint_shadows(renderer, bounds, look.radius, look.shadows, look.opacity);
        if let Some(fill) = look.fill {
            paint_fill(renderer, bounds, look.radius, fill.faded(look.opacity));
        }
        if let Some((ring, color)) = look.ring {
            let inner = Rectangle { x: bounds.x + look.border, y: bounds.y + look.border, width: bounds.width - 2.0 * look.border, height: bounds.height - 2.0 * look.border };
            paint_ring(renderer, inner, (look.radius - look.border).max(0.0), ring, color.faded(look.opacity));
        }
        match (&self.hover, interaction) {
            (Some(hover), Interaction::Hover | Interaction::Pressed) => hover.draw(&tree.children[1], renderer, theme, style, layout, cursor, viewport),
            _ => self.rest.draw(&tree.children[0], renderer, theme, style, layout, cursor, viewport),
        }
    }
}
