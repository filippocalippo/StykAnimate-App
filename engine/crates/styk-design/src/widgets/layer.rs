//! The window's overlay layer: boxes placed over the page at rectangles the core's placement arithmetic chose.
//!
//! A [`Layer`] sits above the page in a `stack!`. Each [`Placed`] child is laid out at its natural size, then the child's
//! closure (which calls `Menu::place`, `Tooltip::place` or `messages::position`) says where it goes and how large it may
//! be; the layer moves it there. The layer decides nothing else: a pointer press or release is reported with whether it
//! landed on any child (the core decides what that dismisses), and a child that takes the pointer swallows it so the page
//! behind never sees a press meant for a menu.

use iced::Widget as _;
use iced::advanced::layout::{Layout, Limits};
use iced::advanced::widget::{self, Operation, Tree};
use iced::advanced::{Renderer as _, Shell, Widget, overlay, renderer};
use iced::{Element, Event, Length, Point, Rectangle, Renderer, Size, Theme, Vector, mouse, touch};

/// Where a placed child goes and the room it may take.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Position {
    pub x: f32,
    pub y: f32,
    pub max_width: Option<f32>,
    pub max_height: Option<f32>,
}

impl Position {
    pub fn at(x: f32, y: f32) -> Position {
        Position { x, y, max_width: None, max_height: None }
    }
}

/// A pointer press or release, as the layer saw it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pointer {
    pub press: bool,
    /// It landed on one of the layer's children that takes the pointer.
    pub inside: bool,
    pub position: Point,
}

/// Where a child goes, given its natural size and the window's.
type Place<'a> = Box<dyn Fn(Size, Size) -> Position + 'a>;

/// A child of the layer.
pub struct Placed<'a, Message> {
    content: Element<'a, Message>,
    place: Place<'a>,
    passive: bool,
}

impl<'a, Message: 'a> Placed<'a, Message> {
    /// `place(natural, viewport)` is where the child goes.
    pub fn new(content: impl Widget<Message, Theme, Renderer> + 'a, place: impl Fn(Size, Size) -> Position + 'a) -> Self {
        Placed { content: content.boxed(), place: Box::new(place), passive: false }
    }

    /// The child never takes the pointer (`pointer-events: none`: a tooltip, the margins of the message band).
    pub fn passive(mut self) -> Self {
        self.passive = true;
        self
    }
}

/// The layer.
pub struct Layer<'a, Message> {
    contents: Vec<Element<'a, Message>>,
    places: Vec<(Place<'a>, bool)>,
    on_pointer: Option<Box<dyn Fn(Pointer) -> Message + 'a>>,
}

impl<'a, Message: 'a> Layer<'a, Message> {
    pub fn new(children: Vec<Placed<'a, Message>>) -> Self {
        let (contents, places) = children.into_iter().map(|child| (child.content, (child.place, child.passive))).unzip();
        Layer { contents, places, on_pointer: None }
    }

    /// Reports every press and release, so the core can dismiss what a press outside dismisses.
    pub fn on_pointer(mut self, f: impl Fn(Pointer) -> Message + 'a) -> Self {
        self.on_pointer = Some(Box::new(f));
        self
    }
}

impl<Message> widget::Meta for Layer<'_, Message> {}

impl<'a, Message: 'a> Widget<Message, Theme, Renderer> for Layer<'a, Message> {
    fn size(&self) -> Size<Length> {
        Size::new(Length::Fill, Length::Fill)
    }

    fn diff(&mut self, tree: &mut Tree) {
        tree.diff_children(&mut self.contents);
    }

    fn layout(&mut self, tree: &mut Tree, renderer: &Renderer, limits: &Limits) {
        let viewport = limits.max;
        for ((content, (place, _)), state) in self.contents.iter_mut().zip(&self.places).zip(&mut tree.children) {
            content.layout(state, renderer, &Limits::new(Size::ZERO, viewport));
            let position = place(state.size, viewport);
            let (max_width, max_height) = (position.max_width.unwrap_or(viewport.width).min(viewport.width), position.max_height.unwrap_or(viewport.height).min(viewport.height));
            if max_width < state.size.width || max_height < state.size.height {
                content.layout(state, renderer, &Limits::new(Size::ZERO, Size::new(max_width, max_height)));
            }
            state.translation = Vector::new(position.x, position.y);
        }
        tree.size = viewport;
    }

    fn operate(&mut self, tree: &mut Tree, layout: Layout, viewport: &Rectangle, renderer: &Renderer, operation: &mut dyn Operation) {
        operation.container(None, layout.bounds(), viewport);
        operation.traverse(&mut |operation| {
            for (content, (layout, state)) in self.contents.iter_mut().zip(layout.iter_mut(&mut tree.children)) {
                content.operate(state, layout, viewport, renderer, operation);
            }
        });
    }

    fn update(&mut self, tree: &mut Tree, event: &Event, layout: Layout, cursor: mouse::Cursor, renderer: &Renderer, shell: &mut Shell<'_, Message>, viewport: &Rectangle) {
        let pointer = match event {
            Event::Mouse(mouse::Event::ButtonPressed(_)) | Event::Touch(touch::Event::FingerPressed { .. }) => Some(true),
            Event::Mouse(mouse::Event::ButtonReleased(_)) | Event::Touch(touch::Event::FingerLifted { .. }) => Some(false),
            _ => None,
        };
        let position = match event {
            Event::Touch(touch::Event::FingerPressed { position, .. } | touch::Event::FingerLifted { position, .. }) => Some(*position),
            _ => cursor.position(),
        };
        let mut inside = false;
        for ((content, (_, passive)), (layout, state)) in self.contents.iter_mut().zip(&self.places).zip(layout.iter_mut(&mut tree.children)).rev() {
            let over = position.is_some_and(|point| layout.bounds().contains(point));
            if over && !passive {
                inside = true;
            }
            content.update(state, event, layout, cursor, renderer, shell, viewport);
            // A box that takes the pointer takes every pointer event over it: a press on a menu's padding is the menu's.
            if over && !passive && matches!(event, Event::Mouse(_) | Event::Touch(_)) && !matches!(event, Event::Mouse(mouse::Event::CursorMoved { .. })) {
                shell.capture_event();
            }
            if shell.is_event_captured() {
                break;
            }
        }
        if let (Some(press), Some(on_pointer), Some(position)) = (pointer, &self.on_pointer, position)
            && !self.contents.is_empty()
        {
            shell.publish(on_pointer(Pointer { press, inside, position }));
        }
    }

    fn mouse_interaction(&self, tree: &Tree, layout: Layout, cursor: mouse::Cursor, viewport: &Rectangle, renderer: &Renderer) -> mouse::Interaction {
        for ((content, (_, passive)), (layout, state)) in self.contents.iter().zip(&self.places).zip(layout.iter(&tree.children)).rev() {
            if *passive || !cursor.is_over(layout.bounds()) {
                continue;
            }
            let interaction = content.mouse_interaction(state, layout, cursor, viewport, renderer);
            // The arrow, not nothing: the page under a menu must not think the pointer is over it.
            return if interaction == mouse::Interaction::None { mouse::Interaction::Idle } else { interaction };
        }
        mouse::Interaction::None
    }

    fn draw(&self, tree: &Tree, renderer: &mut Renderer, theme: &Theme, style: &renderer::Style, layout: Layout, cursor: mouse::Cursor, viewport: &Rectangle) {
        for (content, (layout, state)) in self.contents.iter().zip(layout.iter(&tree.children)) {
            // Each box is its own layer: a submenu's fill covers its parent's words where they overlap.
            renderer.with_layer(*viewport, |renderer| content.draw(state, renderer, theme, style, layout, cursor, viewport));
        }
    }

    fn overlay<'b>(&'b mut self, tree: &'b mut Tree, layout: Layout, renderer: &Renderer, viewport: &Rectangle, translation: Vector, window: Size) -> Vec<overlay::Element<'b, Message, Theme, Renderer>> {
        overlay::from_children(&mut self.contents, tree, layout, renderer, viewport, translation, window)
    }
}

