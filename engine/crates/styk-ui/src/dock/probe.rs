//! A press probe: reports where the primary button went down inside its content, and changes nothing else.
//!
//! The dock's header holds widgets that take their own presses (the tabs). The probe wraps them, lets them have the event first
//! and then says where the press was, so the core can start a drag from the press whatever it landed on. It reports every
//! primary press over its content, a captured one included: the probe is the header's own, and sits under any control it does
//! not own (a panel's header buttons are above it, in a stack, and keep their presses).

use iced::Widget as _;
use iced::advanced::layout::{self, Layout, Limits};
use iced::advanced::widget::{self, Operation, Tree, tree};
use iced::advanced::{Shell, Widget, overlay, renderer};
use iced::{Element, Event, Length, Padding, Point, Rectangle, Renderer, Size, Theme, Vector, mouse};

struct Probe<'a, Message> {
    content: Element<'a, Message>,
    on_press: Box<dyn Fn(Point) -> Message + 'a>,
}

/// `content`, reporting a primary press over it with the pointer's window position.
pub fn probe<'a, Message: 'a>(content: Element<'a, Message>, on_press: impl Fn(Point) -> Message + 'a) -> Element<'a, Message> {
    Probe { content, on_press: Box::new(on_press) }.boxed()
}

impl<Message> widget::Meta for Probe<'_, Message> {}

impl<Message> Widget<Message, Theme, Renderer> for Probe<'_, Message> {
    fn tag(&self) -> tree::Tag {
        tree::Tag::stateless()
    }

    fn state(&self) -> tree::State {
        tree::State::None
    }

    fn size(&self) -> Size<Length> {
        self.content.size()
    }

    fn diff(&mut self, tree: &mut Tree) {
        tree.diff_children(std::slice::from_mut(&mut self.content));
    }

    fn layout(&mut self, tree: &mut Tree, renderer: &Renderer, limits: &Limits) {
        let size = self.content.size();
        let content = &mut self.content;
        layout::padded(tree, limits, size.width, size.height, Padding::ZERO, |child, limits| {
            content.layout(child, renderer, limits);
            child.size
        });
    }

    fn operate(&mut self, tree: &mut Tree, layout: Layout, viewport: &Rectangle, renderer: &Renderer, operation: &mut dyn Operation) {
        operation.traverse(&mut |operation| {
            if let Some((layout, tree)) = layout.iter_mut(&mut tree.children).next() {
                self.content.operate(tree, layout, viewport, renderer, operation);
            }
        });
    }

    fn update(&mut self, tree: &mut Tree, event: &Event, layout: Layout, cursor: mouse::Cursor, renderer: &Renderer, shell: &mut Shell<'_, Message>, viewport: &Rectangle) {
        if let Some((child, state)) = layout.iter_mut(&mut tree.children).next() {
            self.content.update(state, event, child, cursor, renderer, shell, viewport);
        }
        if let Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left)) = event
            && let Some(position) = cursor.position_over(layout.bounds())
        {
            shell.publish((self.on_press)(position));
        }
    }

    fn mouse_interaction(&self, tree: &Tree, layout: Layout, cursor: mouse::Cursor, viewport: &Rectangle, renderer: &Renderer) -> mouse::Interaction {
        layout.iter(&tree.children).next().map_or(mouse::Interaction::None, |(layout, tree)| self.content.mouse_interaction(tree, layout, cursor, viewport, renderer))
    }

    fn draw(&self, tree: &Tree, renderer: &mut Renderer, theme: &Theme, style: &renderer::Style, layout: Layout, cursor: mouse::Cursor, viewport: &Rectangle) {
        if let Some((layout, tree)) = layout.iter(&tree.children).next() {
            self.content.draw(tree, renderer, theme, style, layout, cursor, viewport);
        }
    }

    fn overlay<'b>(&'b mut self, tree: &'b mut Tree, layout: Layout, renderer: &Renderer, viewport: &Rectangle, translation: Vector, window: Size) -> Vec<overlay::Element<'b, Message, Theme, Renderer>> {
        match layout.iter_mut(&mut tree.children).next() {
            Some((layout, tree)) => self.content.overlay(tree, layout, renderer, viewport, translation, window),
            None => Vec::new(),
        }
    }
}
