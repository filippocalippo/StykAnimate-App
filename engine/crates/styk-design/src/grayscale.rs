//! Grayscale text where the browser draws grayscale text.
//!
//! The browser draws subpixel (ClearType) text only on opaque layers. Under a translucent or composited surface (a faded,
//! disabled panel; a menu with its own layer; a canvas) the same text is grayscale: `cargo xtask fonts surfaces` measures
//! which CSS surfaces those are, and `docs/native/typography.md` (section 6) lists them. Wrap the contents of such a
//! surface in [`grayscale`] and its text is drawn in grayscale whatever the system's smoothing says.

use iced::advanced::graphics::text::Grayscale;
use iced::advanced::layout::{self, Layout};
use iced::advanced::overlay;
use iced::advanced::renderer;
use iced::advanced::widget::{Meta, Operation, Tree, tree};
use iced::advanced::{Shell, Widget};
use iced::{Element, Event, Length, Rectangle, Size, Vector, mouse};

/// `content`, with every piece of text in it drawn in grayscale.
pub fn grayscale<'a, Message: 'a, Theme: 'a, Renderer: iced::advanced::Renderer + 'a>(content: impl Into<Element<'a, Message, Theme, Renderer>>) -> Element<'a, Message, Theme, Renderer> {
    GrayscaleText { content: content.into() }._boxed()
}

struct GrayscaleText<'a, Message, Theme, Renderer> {
    content: Element<'a, Message, Theme, Renderer>,
}

impl<Message, Theme, Renderer: iced::advanced::Renderer> Meta for GrayscaleText<'_, Message, Theme, Renderer> {}

impl<Message, Theme, Renderer: iced::advanced::Renderer> Widget<Message, Theme, Renderer> for GrayscaleText<'_, Message, Theme, Renderer> {
    fn tag(&self) -> tree::Tag {
        self.content.tag()
    }

    fn state(&self) -> tree::State {
        self.content.state()
    }

    fn diff(&mut self, tree: &mut Tree) {
        self.content.diff(tree);
    }

    fn size(&self) -> Size<Length> {
        self.content.size()
    }

    fn layout(&mut self, tree: &mut Tree, renderer: &Renderer, limits: &layout::Limits) {
        self.content.layout(tree, renderer, limits);
    }

    fn operate(&mut self, tree: &mut Tree, layout: Layout, viewport: &Rectangle, renderer: &Renderer, operation: &mut dyn Operation) {
        self.content.operate(tree, layout, viewport, renderer, operation);
    }

    fn update(&mut self, tree: &mut Tree, event: &Event, layout: Layout, cursor: mouse::Cursor, renderer: &Renderer, shell: &mut Shell<'_, Message>, viewport: &Rectangle) {
        self.content.update(tree, event, layout, cursor, renderer, shell, viewport);
    }

    fn mouse_interaction(&self, tree: &Tree, layout: Layout, cursor: mouse::Cursor, viewport: &Rectangle, renderer: &Renderer) -> mouse::Interaction {
        self.content.mouse_interaction(tree, layout, cursor, viewport, renderer)
    }

    fn draw(&self, tree: &Tree, renderer: &mut Renderer, theme: &Theme, style: &renderer::Style, layout: Layout, cursor: mouse::Cursor, viewport: &Rectangle) {
        let _scope = Grayscale::scope();
        self.content.draw(tree, renderer, theme, style, layout, cursor, viewport);
    }

    fn overlay<'b>(&'b mut self, tree: &'b mut Tree, layout: Layout, renderer: &Renderer, viewport: &Rectangle, translation: Vector, window: Size) -> Vec<overlay::Element<'b, Message, Theme, Renderer>> {
        self.content.overlay(tree, layout, renderer, viewport, translation, window)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use iced::advanced::graphics::text::grayscale_active;
    use iced::advanced::widget::tree::Tree;
    use std::cell::Cell;
    use std::rc::Rc;

    /// A widget that records whether a grayscale scope was active when it was drawn.
    struct Probe(Rc<Cell<Option<bool>>>);

    impl Meta for Probe {}

    impl Widget<(), iced::Theme, ()> for Probe {
        fn size(&self) -> Size<Length> {
            Size::new(Length::Shrink, Length::Shrink)
        }

        fn layout(&mut self, _: &mut Tree, _: &(), _: &layout::Limits) {}

        fn draw(&self, _: &Tree, _: &mut (), _: &iced::Theme, _: &renderer::Style, _: Layout, _: mouse::Cursor, _: &Rectangle) {
            self.0.set(Some(grayscale_active()));
        }
    }

    fn draw(element: &Element<'_, (), iced::Theme, ()>) {
        let tree = Tree::new(element);
        let size = Size::new(10.0, 10.0);
        element.draw(&tree, &mut (), &iced::Theme::Light, &renderer::Style { text_color: iced::Color::BLACK }, Layout::new(size), mouse::Cursor::Unavailable, &Rectangle::with_size(size));
    }

    #[test]
    fn text_inside_is_grayscale_and_text_outside_is_not() {
        let (inside, outside) = (Rc::new(Cell::new(None)), Rc::new(Cell::new(None)));
        draw(&grayscale(Probe(inside.clone())._boxed()));
        draw(&Probe(outside.clone())._boxed());
        assert_eq!(inside.get(), Some(true), "drawn inside a grayscale scope");
        assert_eq!(outside.get(), Some(false), "drawn outside it");
        assert!(!grayscale_active(), "the scope ends with the draw");
    }
}
