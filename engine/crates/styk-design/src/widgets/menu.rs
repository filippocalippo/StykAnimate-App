//! Menus (`menu.css`): the lists the core's overlay host opens, drawn from its state.
//!
//! The host decides which menus are open, which row holds focus, what a key or a hover does and where each menu goes
//! (`Menu::place`). This only draws that state and reports what the person did, as [`Event`]s the owner hands to
//! `Host::key`, `hover`, `press` and `pointer`:
//!
//! - rows: a lead column (the glyph, or a check, or the radio dot, or a pad so labels line up), the label, the shortcut hint
//!   from the registry as plain grey text, a chevron on a submenu row, and a disabled row's reason under its label;
//! - the focused row takes the hover fill, and the ring only when the keyboard moved focus there (`:focus-visible`);
//! - every row is a focus target (`row_id`) inside the tree's one scope, so Tab, the snapshot and the core agree.

use iced::Widget as _;
use super::card::Card;
use super::control::words;
use super::focus::{Focusable, Keys, Ring, Scope};
use super::layer::{Layer, Placed, Position};
use crate::tokens::scale;
use crate::typography::TextStyle;
use crate::{Palette, Rgba};
use iced::advanced::layout::{self, Layout};
use iced::advanced::widget::{self, Operation, Tree, tree};
use iced::advanced::{Shell, Widget, overlay, renderer};
use iced::keyboard::{self, Key, key::Named};
use iced::widget::{Column, Row, Space, container};
use iced::{Alignment, Background, Color, Element, Event as IcedEvent, Length, Padding, Rectangle, Renderer, Size, Theme, Vector, mouse, touch};
use std::rc::Rc;
use styk_core::focus::{FocusArea, ScopeId};
use styk_core::overlay::host::{Host, OpenMenu, Purpose, row_id};
use styk_core::overlay::menu::{Anchor, Entry, Item, Menu};
use styk_core::overlay::placement::{Rect, Size as PlaceSize};

/// A key the person pressed while a menu is open, in the names the core's `menu::Key` uses.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyPress {
    pub key: String,
    pub ctrl: bool,
    pub meta: bool,
    pub alt: bool,
}

/// What a menu view reports.
#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    /// A key reached a focused row.
    Key(KeyPress),
    /// The pointer moved onto the item `index` of menu `menu`.
    Hover { menu: u64, index: usize },
    /// A click on the item `index` of menu `menu`.
    Press { menu: u64, index: usize },
    /// A pointer press or release: where it landed and whether on a menu.
    Pointer { press: bool, inside: bool, x: f32, y: f32 },
}

/// The core's name for a key, or nothing for a key a menu does not use (a lone modifier).
pub fn key_press(event: &keyboard::Event) -> Option<KeyPress> {
    let keyboard::Event::KeyPressed { key, modifiers, .. } = event else { return None };
    let name = match key.as_ref() {
        Key::Named(Named::ArrowDown) => "ArrowDown".to_owned(),
        Key::Named(Named::ArrowUp) => "ArrowUp".to_owned(),
        Key::Named(Named::ArrowLeft) => "ArrowLeft".to_owned(),
        Key::Named(Named::ArrowRight) => "ArrowRight".to_owned(),
        Key::Named(Named::Home) => "Home".to_owned(),
        Key::Named(Named::End) => "End".to_owned(),
        Key::Named(Named::PageUp) => "PageUp".to_owned(),
        Key::Named(Named::PageDown) => "PageDown".to_owned(),
        Key::Named(Named::Enter) => "Enter".to_owned(),
        Key::Named(Named::Space) => " ".to_owned(),
        Key::Named(Named::Escape) => "Escape".to_owned(),
        Key::Named(Named::Tab) => "Tab".to_owned(),
        Key::Character(text) => text.to_owned(),
        _ => return None,
    };
    Some(KeyPress { key: name, ctrl: modifiers.control(), meta: modifiers.logo(), alt: modifiers.alt() })
}

/// How a row is drawn, from the core's state.
#[derive(Clone, Copy)]
struct Look {
    /// The hover fill (and, for a danger row, its red tint).
    lit: bool,
    ring: bool,
    danger: bool,
}

#[derive(Default)]
struct State {
    over: bool,
    pressed: bool,
}

/// One row: reports the pointer arriving and a click, draws the fill and the ring the core's state asks for.
struct Row_<'a, Message> {
    content: Element<'a, Message>,
    look: Look,
    palette: &'static Palette,
    on_hover: Message,
    on_press: Message,
}

impl<Message> widget::Meta for Row_<'_, Message> {}

impl<'a, Message: Clone + 'a> Widget<Message, Theme, Renderer> for Row_<'a, Message> {
    fn tag(&self) -> tree::Tag {
        tree::Tag::of::<State>()
    }

    fn state(&self) -> tree::State {
        tree::State::new(State::default())
    }

    fn size(&self) -> Size<Length> {
        Size::new(Length::Fill, Length::Shrink)
    }

    fn diff(&mut self, tree: &mut Tree) {
        tree.diff_children(std::slice::from_mut(&mut self.content));
    }

    fn layout(&mut self, tree: &mut Tree, renderer: &Renderer, limits: &layout::Limits) {
        let content = &mut self.content;
        layout::contained(tree, limits, Length::Fill, Length::Shrink, |child, limits| {
            content.layout(child, renderer, limits);
            child.size
        });
    }

    fn operate(&mut self, tree: &mut Tree, layout: Layout, viewport: &Rectangle, renderer: &Renderer, operation: &mut dyn Operation) {
        self.content.operate(&mut tree.children[0], layout, viewport, renderer, operation);
    }

    fn update(&mut self, tree: &mut Tree, event: &IcedEvent, layout: Layout, cursor: mouse::Cursor, renderer: &Renderer, shell: &mut Shell<'_, Message>, viewport: &Rectangle) {
        self.content.update(&mut tree.children[0], event, layout, cursor, renderer, shell, viewport);
        let state = tree.state.downcast_mut::<State>();
        let over = cursor.is_over(layout.bounds());
        match event {
            IcedEvent::Mouse(mouse::Event::CursorMoved { .. }) if over && !state.over => {
                state.over = true;
                shell.publish(self.on_hover.clone());
            }
            IcedEvent::Mouse(mouse::Event::CursorMoved { .. }) if !over => state.over = false,
            IcedEvent::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left)) | IcedEvent::Touch(touch::Event::FingerPressed { .. }) if over => {
                state.pressed = true;
                shell.capture_event();
            }
            IcedEvent::Mouse(mouse::Event::ButtonReleased(mouse::Button::Left)) | IcedEvent::Touch(touch::Event::FingerLifted { .. }) if state.pressed => {
                state.pressed = false;
                if over {
                    shell.publish(self.on_press.clone());
                }
                shell.capture_event();
            }
            IcedEvent::Window(iced::window::Event::Unfocused) => state.pressed = false,
            _ => {}
        }
    }

    fn mouse_interaction(&self, _tree: &Tree, _layout: Layout, _cursor: mouse::Cursor, _viewport: &Rectangle, _renderer: &Renderer) -> mouse::Interaction {
        mouse::Interaction::None
    }

    fn draw(&self, tree: &Tree, renderer: &mut Renderer, theme: &Theme, style: &renderer::Style, layout: Layout, cursor: mouse::Cursor, viewport: &Rectangle) {
        let bounds = layout.bounds();
        if self.look.lit {
            let fill = if self.look.danger { self.palette.danger_soft } else { self.palette.surface_hover };
            super::control::paint_fill(renderer, bounds, scale::RADIUS_SM, fill);
        }
        if self.look.ring {
            super::control::paint_ring(renderer, bounds, scale::RADIUS_SM, scale::FOCUS_WIDTH, self.palette.focus_ring);
        }
        self.content.draw(&tree.children[0], renderer, theme, style, layout, cursor, viewport);
    }

    fn overlay<'b>(&'b mut self, tree: &'b mut Tree, layout: Layout, renderer: &Renderer, viewport: &Rectangle, translation: Vector, window: Size) -> Vec<overlay::Element<'b, Message, Theme, Renderer>> {
        self.content.overlay(&mut tree.children[0], layout, renderer, viewport, translation, window)
    }
}

fn nothing<'a, Message: 'a>() -> Element<'a, Message> {
    Space::new().width(Length::Fixed(0.0)).height(Length::Fixed(0.0)).boxed()
}

/// The lead column of an item: its glyph, its check or radio dot (only while it is on), or a pad.
fn lead<'a, Message: 'a>(item: &Item, palette: &'static Palette, glyph: Rgba, disabled: bool) -> Element<'a, Message> {
    let side = Length::Fixed(scale::ICON_MD);
    match (item.checked, item.radio) {
        (Some(on), true) => {
            let dot = palette.accent;
            let dot = if on {
                container(Space::new()).width(7.0).height(7.0).style(move |_| container::Style { background: Some(Background::Color(dot.into())), border: iced::Border { radius: 3.5.into(), ..iced::Border::default() }, ..container::Style::default() }).boxed()
            } else {
                nothing()
            };
            container(dot).center_x(side).center_y(side).boxed()
        }
        (Some(on), false) => {
            let mark: Element<'a, Message> = if on { super::icon_stroked("check", scale::ICON_SM, palette.accent, 2.5).boxed() } else { nothing() };
            container(mark).center_x(side).center_y(side).boxed()
        }
        (None, _) => match item.icon.as_deref().filter(|name| super::super::icons::lookup(name).is_some()) {
            Some(name) => super::icon(name, scale::ICON_MD, if disabled { palette.text_disabled } else { glyph }).boxed(),
            None => Space::new().width(side).height(Length::Fixed(0.0)).boxed(),
        },
    }
}

/// The menu `open` as a box (without a position): its rows, separators and group labels.
pub fn menu_box<'a, Message: Clone + 'a>(palette: &'static Palette, open: &'a OpenMenu, child_from: Option<usize>, ring: bool, send: &Rc<dyn Fn(Event) -> Message + 'a>) -> Element<'a, Message> {
    let id = open.id();
    let mut rows: Vec<Element<'a, Message>> = Vec::new();
    // `min-inline-size: 240px` over a 1 px border and 6 px of padding: the rows' share is 226 px.
    rows.push(Space::new().width(Length::Fixed(240.0 - 14.0)).height(Length::Fixed(0.0)).boxed());
    let mut index = 0;
    for (position, entry) in open.entries().iter().enumerate() {
        match entry {
            Entry::Separator => {
                let line = palette.line_1;
                rows.push(
                    container(container(Space::new()).width(Length::Fill).height(1.0).style(move |_| container::Style { background: Some(Background::Color(line.into())), ..container::Style::default() }))
                        .padding(Padding { top: scale::SPACE_1_5, right: scale::SPACE_1, bottom: scale::SPACE_1_5, left: scale::SPACE_1 })
                        .boxed(),
                );
            }
            Entry::Label(text) => {
                let first = position == 0;
                let style = TextStyle::from_role(&scale::TYPE_EYEBROW).tracking_em(0.01);
                rows.push(container(words(text.clone(), style, palette.text_3)).padding(Padding { top: if first { scale::SPACE_1 } else { scale::SPACE_2_5 }, right: scale::SPACE_2_5, bottom: scale::SPACE_1, left: scale::SPACE_2_5 }).boxed());
            }
            Entry::Item(item) => {
                let current = open.current() == Some(index);
                let expanded = child_from == Some(index);
                let disabled = item.disabled;
                let hovered = open.hovered() == Some(index);
                let lit = (current && ring) || ((hovered || expanded) && !disabled);
                let ink = if disabled { palette.text_disabled } else if item.danger { palette.danger_text } else { palette.text_1 };
                let glyph = if item.danger { palette.danger_text } else if lit { palette.text_1 } else { palette.text_2 };
                let label = words(item.label.clone(), TextStyle::from_role(&scale::TYPE_UI), ink);
                let hint = open.hint(index);
                let shortcut: Element<'a, Message> = if hint.text.is_empty() {
                    nothing()
                } else {
                    container(words(hint.text.clone(), TextStyle::from_role(&scale::TYPE_SMALL), palette.text_3)).padding(Padding { left: scale::SPACE_6, ..Padding::ZERO }).boxed()
                };
                let chevron: Element<'a, Message> = if item.submenu.is_some() {
                    container(super::icon("chevron-right", scale::ICON_SM, if disabled { palette.text_disabled } else { palette.text_3 })).padding(Padding { left: scale::SPACE_3, ..Padding::ZERO }).boxed()
                } else {
                    nothing()
                };
                let line = Row::with_children(vec![lead(item, palette, glyph, disabled), container(label).width(Length::Fill).boxed(), shortcut, chevron]).spacing(scale::SPACE_2_5).align_y(Alignment::Center);
                let body: Element<'a, Message> = if item.reason.is_empty() {
                    container(line).height(Length::Fixed(scale::CONTROL_MD)).center_y(Length::Fixed(scale::CONTROL_MD)).padding(Padding { top: 0.0, right: scale::SPACE_2_5, bottom: 0.0, left: scale::SPACE_2_5 }).boxed()
                } else {
                    // `.ui-menu-reason`: under the label, in the micro type; the row takes 4 px of air above and below.
                    let mut micro = TextStyle::from_role(&scale::TYPE_MICRO);
                    micro.font = micro.font.weight(super::weight::MEDIUM);
                    let reason = container(words(item.reason.clone(), micro, palette.text_3)).padding(Padding { left: scale::ICON_MD + scale::SPACE_2_5, ..Padding::ZERO });
                    container(Column::with_children(vec![line.boxed(), reason.boxed()]).spacing(scale::SPACE_1_5)).padding(Padding { top: scale::SPACE_1, right: scale::SPACE_2_5, bottom: scale::SPACE_1, left: scale::SPACE_2_5 }).boxed()
                };
                let row = Row_ { content: body, look: Look { lit, ring: current && ring, danger: item.danger }, palette, on_hover: send(Event::Hover { menu: id, index }), on_press: send(Event::Press { menu: id, index }) };
                let key_send = send.clone();
                let no_ring = Ring { color: Color::TRANSPARENT, width: 0.0, offset: 0.0, radius: 0.0 };
                let target = Focusable::new(row_id(id, index), FocusArea::Panels, row.boxed(), no_ring)
                    .input_role(if matches!(open.purpose(), Purpose::Select { .. }) { styk_core::focus::InputRole::Select } else { styk_core::focus::InputRole::None })
                    .keys(Keys::Custom(Box::new(move |event| key_press(event).map(|key| key_send(Event::Key(key))))));
                rows.push(target.boxed());
                index += 1;
            }
        }
    }
    Card::new(Column::with_children(rows).width(Length::Shrink)).fill(palette.surface_raised).radius(scale::RADIUS_XL).shadows(palette.elevation_3).padding(Padding::new(scale::SPACE_1_5 + 1.0)).boxed()
}

fn rect(bounds: Rectangle) -> Rect {
    Rect { x: f64::from(bounds.x), y: f64::from(bounds.y), width: f64::from(bounds.width), height: f64::from(bounds.height) }
}

/// The layer holding every open menu of `host`, each at the place `Menu::place` gives it, and every tree in its own focus
/// scope. `top_inset` is the lowest top a menu may take (the title band and a margin).
pub fn layer<'a, Message: Clone + 'a>(palette: &'static Palette, host: &'a Host, ring: bool, top_inset: f32, extra: Vec<Placed<'a, Message>>, send: impl Fn(Event) -> Message + 'a) -> Element<'a, Message> {
    let send: Rc<dyn Fn(Event) -> Message + 'a> = Rc::new(send);
    let mut placed: Vec<Placed<'a, Message>> = Vec::new();
    for open in host.menus() {
        let root = {
            let mut at = open;
            while let Some(parent) = at.parent().and_then(|id| host.menus().iter().find(|menu| menu.id() == id)) {
                at = parent;
            }
            at.id()
        };
        let child_from = host.menus().iter().find(|menu| menu.parent() == Some(open.id())).and_then(|menu| menu.from_row());
        let content = Scope::passive(ScopeId(root), menu_box(palette, open, child_from, ring, &send));
        let (anchor, rtl) = (open.anchor(), open.rtl());
        placed.push(Placed::new(content, move |natural, viewport| {
            let placed = Menu::place(anchor, PlaceSize { width: f64::from(natural.width), height: f64::from(natural.height) }, PlaceSize { width: f64::from(viewport.width), height: f64::from(viewport.height) }, f64::from(top_inset), rtl);
            Position { x: placed.rect.x as f32, y: placed.rect.y as f32, max_width: placed.max_width.map(|w| w as f32), max_height: placed.max_height.map(|h| h as f32) }
        }));
    }
    placed.extend(extra);
    let pointer = send.clone();
    Layer::new(placed).on_pointer(move |p| pointer(Event::Pointer { press: p.press, inside: p.inside, x: p.position.x, y: p.position.y })).boxed()
}

/// The anchor rectangle of a widget, for `Anchor::Root`.
pub fn anchor_of(bounds: Rectangle) -> Anchor {
    Anchor::Root(rect(bounds))
}

/// The rectangle the core uses for a measured widget.
pub fn rect_of(bounds: Rectangle) -> Rect {
    rect(bounds)
}
