//! A roving group: a toolbar, rail or tab list that is one Tab stop, with arrow keys inside
//! (`docs/native/text-input.md` section 4; the key model is `styk_core::roving`).
//!
//! The group is stateless: the owner keeps which item is active and moves focus when the group publishes `on_move`.
//! Only the active item is a Tab stop; the others are focusable by arrows and programmatically. A disabled item is
//! skipped. In a right-to-left interface the horizontal arrows are mirrored.

use super::dir::Dir;
use super::focus::{Focusable, Keys, Ring};
use iced::keyboard::{self, Key, key::Named};
use iced::widget::Column;
use iced::{Element, Length, Widget as _};
use std::sync::Arc;
use styk_core::focus::{FocusArea, FocusId, InputRole};
use styk_core::roving::{NavKey, Orientation, next_index};

/// One item of a roving group.
pub struct RovingItem<'a, Message> {
    pub id: FocusId,
    pub content: Element<'a, Message>,
    pub enabled: bool,
    /// Published by Enter and Space on the item.
    pub on_activate: Option<Message>,
}

/// The group.
pub struct RovingGroup<'a, Message> {
    area: FocusArea,
    items: Vec<RovingItem<'a, Message>>,
    active: usize,
    orientation: Orientation,
    dir: Dir,
    wrap: bool,
    spacing: f32,
    ring: Ring,
    width: Length,
    role: InputRole,
    on_move: Arc<dyn Fn(usize) -> Message + 'a>,
}

impl<'a, Message: Clone + 'a> RovingGroup<'a, Message> {
    /// A group of `items` with item `active` as its Tab stop; `on_move(index)` is published when an arrow key moves
    /// to another item.
    pub fn new(
        area: FocusArea,
        items: Vec<RovingItem<'a, Message>>,
        active: usize,
        ring: Ring,
        on_move: impl Fn(usize) -> Message + 'a,
    ) -> Self {
        RovingGroup {
            area,
            items,
            active,
            orientation: Orientation::Horizontal,
            dir: Dir::Ltr,
            wrap: true,
            spacing: 0.0,
            ring,
            width: Length::Shrink,
            role: InputRole::None,
            on_move: Arc::new(on_move),
        }
    }

    pub fn orientation(mut self, orientation: Orientation) -> Self {
        self.orientation = orientation;
        self
    }

    pub fn dir(mut self, dir: Dir) -> Self {
        self.dir = dir;
        self
    }

    pub fn wrap(mut self, wrap: bool) -> Self {
        self.wrap = wrap;
        self
    }

    pub fn spacing(mut self, spacing: f32) -> Self {
        self.spacing = spacing;
        self
    }

    /// The width of a horizontal group (`Length::Fill` for items that share the row).
    pub fn width(mut self, width: impl Into<Length>) -> Self {
        self.width = width.into();
        self
    }

    /// The input role of every item (a radio group's items are radios to the shortcut routing).
    pub fn input_role(mut self, role: InputRole) -> Self {
        self.role = role;
        self
    }
}

/// The navigation key of a keyboard key, mirrored for right-to-left horizontal arrows.
fn nav_key(key: &Key, dir: Dir) -> Option<NavKey> {
    let named = match key.as_ref() {
        Key::Named(named) => named,
        _ => return None,
    };
    Some(match named {
        Named::Home => NavKey::Home,
        Named::End => NavKey::End,
        Named::ArrowUp => NavKey::ArrowUp,
        Named::ArrowDown => NavKey::ArrowDown,
        Named::ArrowLeft => if dir.is_rtl() { NavKey::ArrowRight } else { NavKey::ArrowLeft },
        Named::ArrowRight => if dir.is_rtl() { NavKey::ArrowLeft } else { NavKey::ArrowRight },
        _ => return None,
    })
}

impl<'a, Message: Clone + 'a> RovingGroup<'a, Message> {
    /// The group as an element.
    pub fn into_element(self) -> Element<'a, Message> {
        let group = self;
        let RovingGroup { area, items, active, orientation, dir, wrap, spacing, ring, width, role, on_move } = group;
        let count = items.len();
        let enabled: Arc<[bool]> = items.iter().map(|item| item.enabled).collect();

        let children: Vec<Element<'a, Message>> = items
            .into_iter()
            .enumerate()
            .map(|(index, item)| {
                let enabled = enabled.clone();
                let on_move = on_move.clone();
                let on_activate = item.on_activate.clone();
                let keys = Keys::Custom(Box::new(move |event| match event {
                    keyboard::Event::KeyPressed { key, modifiers, .. } if !modifiers.control() && !modifiers.alt() && !modifiers.logo() => {
                        if let Some(nav) = nav_key(key, dir) {
                            let next = next_index(nav, Some(index), count, orientation, wrap, |i| !enabled[i])?;
                            return (next != index).then(|| on_move(next));
                        }
                        match key.as_ref() {
                            Key::Named(Named::Enter | Named::Space) => on_activate.clone(),
                            _ => None,
                        }
                    }
                    _ => None,
                }));
                let mut target = Focusable::new(item.id, area, item.content, ring)
                    .keys(keys)
                    .enabled(item.enabled)
                    .tab_stop(index == active)
                    .input_role(role);
                if let Some(message) = item.on_activate {
                    target = target.on_activate(message);
                }
                target.boxed()
            })
            .collect();

        match orientation {
            Orientation::Vertical => Column::with_children(children).spacing(spacing).width(Length::Fit).boxed(),
            _ => dir.row(children).spacing(spacing).width(width).boxed(),
        }
    }
}
