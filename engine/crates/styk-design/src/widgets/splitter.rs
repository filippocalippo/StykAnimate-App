//! Splitter (`splitter.css`): an 8 px separator between islands with a 2 px accent line on hover, focus and drag, and a 16 px
//! hit area across it.
//!
//! It reports a drag (where the press began and how far the pointer has moved along the axis) and the keys of a separator;
//! the docking core decides sizes, limits, the default size and what Escape cancels.

use iced::Widget as _;
use super::focus::{Focusable, Keys, Ring};
use crate::Palette;
use crate::tokens::scale;
use iced::advanced::layout::{self, Layout};
use iced::advanced::widget::{self, Tree, tree};
use iced::advanced::{Shell, Widget, renderer};
use iced::keyboard::{self, Key, key::Named};
use iced::{Element, Event, Length, Point, Rectangle, Renderer, Size, Theme, mouse, touch};
use styk_core::focus::{FocusArea, FocusId};

/// Which way the separator runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Axis {
    /// A vertical bar between side-by-side islands: dragged along x.
    Vertical,
    /// A horizontal bar between stacked islands: dragged along y.
    Horizontal,
}

/// A drag or a key.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Event_ {
    DragStart,
    /// The pointer is `delta` logical pixels along the axis from where the drag began.
    DragMove(f32),
    DragEnd,
    /// An arrow key (`+1` towards the end), with Shift for the bigger step.
    Step { direction: i32, shift: bool },
    /// Home or Enter: the default size.
    Reset,
    /// End: the largest size.
    Largest,
    /// Escape while dragging.
    Cancel,
}

#[derive(Default)]
struct State {
    origin: Option<Point>,
    over: bool,
}

struct Bar<'a, Message> {
    axis: Axis,
    palette: &'static Palette,
    on_event: Box<dyn Fn(Event_) -> Message + 'a>,
    shown: bool,
}

impl<Message> widget::Meta for Bar<'_, Message> {}

impl<'a, Message: 'a> Widget<Message, Theme, Renderer> for Bar<'a, Message> {
    fn tag(&self) -> tree::Tag {
        tree::Tag::of::<State>()
    }

    fn state(&self) -> tree::State {
        tree::State::new(State::default())
    }

    fn size(&self) -> Size<Length> {
        match self.axis {
            Axis::Vertical => Size::new(Length::Fixed(8.0), Length::Fill),
            Axis::Horizontal => Size::new(Length::Fill, Length::Fixed(8.0)),
        }
    }

    fn layout(&mut self, tree: &mut Tree, _renderer: &Renderer, limits: &layout::Limits) {
        let size = self.size();
        tree.size = layout::atomic(limits, size.width, size.height);
    }

    fn update(&mut self, tree: &mut Tree, event: &Event, layout: Layout, cursor: mouse::Cursor, _renderer: &Renderer, shell: &mut Shell<'_, Message>, _viewport: &Rectangle) {
        // The hit area reaches 4 px past the bar either side.
        let bounds = layout.bounds();
        let hit = match self.axis {
            Axis::Vertical => Rectangle { x: bounds.x - scale::SPACE_1, width: bounds.width + 2.0 * scale::SPACE_1, ..bounds },
            Axis::Horizontal => Rectangle { y: bounds.y - scale::SPACE_1, height: bounds.height + 2.0 * scale::SPACE_1, ..bounds },
        };
        let state = tree.state.downcast_mut::<State>();
        let along = |point: Point, origin: Point| match self.axis {
            Axis::Vertical => point.x - origin.x,
            Axis::Horizontal => point.y - origin.y,
        };
        let over = cursor.is_over(hit);
        if over != state.over {
            state.over = over;
            shell.request_redraw();
        }
        match event {
            Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left)) | Event::Touch(touch::Event::FingerPressed { .. }) if over => {
                state.origin = cursor.position();
                shell.publish((self.on_event)(Event_::DragStart));
                shell.capture_event();
                shell.request_redraw();
            }
            Event::Mouse(mouse::Event::CursorMoved { position }) | Event::Touch(touch::Event::FingerMoved { position, .. }) => {
                if let Some(origin) = state.origin {
                    shell.publish((self.on_event)(Event_::DragMove(along(*position, origin))));
                    shell.capture_event();
                }
            }
            Event::Mouse(mouse::Event::ButtonReleased(mouse::Button::Left)) | Event::Touch(touch::Event::FingerLifted { .. } | touch::Event::FingerLost { .. }) if state.origin.is_some() => {
                state.origin = None;
                shell.publish((self.on_event)(Event_::DragEnd));
                shell.capture_event();
                shell.request_redraw();
            }
            Event::Keyboard(keyboard::Event::KeyPressed { key: Key::Named(Named::Escape), .. }) if state.origin.is_some() => {
                state.origin = None;
                shell.publish((self.on_event)(Event_::Cancel));
                shell.capture_event();
            }
            _ => {}
        }
    }

    fn mouse_interaction(&self, _tree: &Tree, layout: Layout, cursor: mouse::Cursor, _viewport: &Rectangle, _renderer: &Renderer) -> mouse::Interaction {
        let hit = layout.bounds().expand(scale::SPACE_1);
        if !cursor.is_over(hit) {
            return mouse::Interaction::None;
        }
        match self.axis {
            Axis::Vertical => mouse::Interaction::ResizingColumn,
            Axis::Horizontal => mouse::Interaction::ResizingRow,
        }
    }

    fn draw(&self, tree: &Tree, renderer: &mut Renderer, _theme: &Theme, _style: &renderer::Style, layout: Layout, _cursor: mouse::Cursor, _viewport: &Rectangle) {
        let state = tree.state.downcast_ref::<State>();
        if !(state.over || state.origin.is_some() || self.shown) {
            return;
        }
        let bounds = layout.bounds();
        let line = match self.axis {
            Axis::Vertical => Rectangle { x: bounds.x + 3.0, width: 2.0, ..bounds },
            Axis::Horizontal => Rectangle { y: bounds.y + 3.0, height: 2.0, ..bounds },
        };
        super::control::paint_fill(renderer, line, 1.0, self.palette.accent_line);
    }
}

/// A splitter between two islands. `shown` holds the line (a preview of hover); focus shows it too.
pub fn splitter<'a, Message: Clone + 'a>(palette: &'static Palette, id: FocusId, area: FocusArea, axis: Axis, shown: bool, on_event: impl Fn(Event_) -> Message + 'a + Clone) -> Element<'a, Message> {
    let bar = Bar { axis, palette, on_event: Box::new(on_event.clone()), shown };
    let keys = Keys::Custom(Box::new(move |event| {
        let keyboard::Event::KeyPressed { key: Key::Named(named), modifiers, .. } = event else { return None };
        let (back, forward) = match axis {
            Axis::Vertical => (Named::ArrowLeft, Named::ArrowRight),
            Axis::Horizontal => (Named::ArrowUp, Named::ArrowDown),
        };
        let shift = modifiers.shift();
        Some(on_event(match named {
            n if *n == back => Event_::Step { direction: -1, shift },
            n if *n == forward => Event_::Step { direction: 1, shift },
            Named::End => Event_::Largest,
            Named::Home | Named::Enter => Event_::Reset,
            _ => return None,
        }))
    }));
    // The focused separator shows its line; no outline.
    let ring = Ring { color: palette.accent_line.into(), width: 0.0, offset: 0.0, radius: 0.0 };
    Focusable::new(id, area, bar.boxed(), ring).keys(keys).boxed()
}
