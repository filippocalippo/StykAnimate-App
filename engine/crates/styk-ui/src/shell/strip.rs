//! A project tab (`components/project-tabs.css`, `src/shell/project-tabs-view.mjs`).
//!
//! A picture of the stage (a scene glyph until the stage has drawn it), the name, and the state's dot, which gives its
//! place to Close under the pointer. Which parts show is the band layout's (`TabLook`); the dot is `TabView::state`.

use super::controls::{color, elevation};
use super::{Message, controls};
use iced::advanced::text::{Ellipsis, Wrapping};
use iced::keyboard::{self, Key, key::Named};
use iced::widget::{button, container, mouse_area, row, space, text};
use iced::{Alignment, Background, Border, Color, Element, Length, Padding, Shadow, Theme as IcedTheme, Widget as _};
use styk_core::focus::FocusArea;
use styk_core::shell::band::{Frame, TabEnd, TabLook};
use styk_core::shell::strip::{TabKey, TabState};
use styk_core::shell::{Event, Hover, TabView, ids};
use styk_design::typography::TextStyle;
use styk_design::widgets::focus::{Focusable, Keys, Ring};
use styk_design::widgets::icon;
use styk_design::{Theme, tokens};

/// A resting tab shows 45% of itself while it is dragged (`[data-dragging] { opacity: 0.45 }`).
const DRAGGED: f32 = 0.45;
/// The picture's size, and the dot's.
const ART: (f32, f32) = (26.0, 16.0);
const DOT: f32 = 7.0;
/// The state slot at a tab's end (`--control-xs`), and its narrow form.
const END: f32 = 24.0;
const END_NARROW: f32 = 9.0;
/// A tab's padding and the gap between its parts.
const PAD_START: f32 = 8.0;
const PAD_END: f32 = 4.0;
const GAP: f32 = 6.0;

fn scaled(colour: Color, alpha: f32) -> Color {
    Color { a: colour.a * alpha, ..colour }
}

/// The key a focused tab answers, if it is one of the tab's (`project-tabs-view.mjs` keydown).
fn key_of(event: &keyboard::Event) -> Option<TabKey> {
    let keyboard::Event::KeyPressed { key, modifiers, .. } = event else { return None };
    if modifiers.control() || modifiers.alt() || modifiers.logo() {
        return None;
    }
    match key.as_ref() {
        Key::Named(Named::ArrowLeft) => Some(TabKey::Left),
        Key::Named(Named::ArrowRight) => Some(TabKey::Right),
        Key::Named(Named::Home) => Some(TabKey::Home),
        Key::Named(Named::End) => Some(TabKey::End),
        Key::Named(Named::Enter | Named::Space) => Some(TabKey::Activate),
        Key::Named(Named::Delete) => Some(TabKey::Delete),
        Key::Named(Named::F2) => Some(TabKey::Rename),
        Key::Named(Named::ContextMenu) => Some(TabKey::Menu),
        _ => None,
    }
}

/// The dot of a state: neutral for unsaved changes and a running save, success for a save that just landed, danger when
/// the last save failed.
fn dot_color(palette: &tokens::Palette, view: &TabView) -> Option<Color> {
    let state = view.state?;
    Some(color(if view.failed {
        palette.danger_dot
    } else if state == TabState::Saved {
        palette.success_dot
    } else {
        palette.neutral_dot
    }))
}

pub(crate) fn tab(view: &TabView, look: TabLook, frame: Frame, hover: Option<Hover>, theme: Theme) -> Element<'static, Message> {
    let palette = theme.palette();
    let id = view.id;
    let over = matches!(hover, Some(Hover::Tab(over) | Hover::TabClose(over)) if over == id);
    let over_close = hover == Some(Hover::TabClose(id));
    let alpha = if view.dragging { DRAGGED } else { 1.0 };
    let fg = scaled(if view.front || over { color(palette.text_1) } else { color(palette.text_2) }, alpha);
    let style = TextStyle::from_role(if view.front { &tokens::scale::TYPE_UI_STRONG } else { &tokens::scale::TYPE_UI });

    // The picture of the stage, until the stage has drawn it a scene glyph on the placeholder.
    let art = container(icon("scene", 11.0, scaled(Color::from_rgb8(0x6b, 0x72, 0x82), alpha)))
        .center(Length::Fixed(ART.0))
        .height(ART.1)
        .style(move |_| container::Style::default().background(scaled(color(palette.artboard_placeholder), alpha)).border(Border { color: scaled(color(palette.swatch_ring), alpha), width: 1.0, radius: tokens::scale::RADIUS_2XS.into() }));
    let mut front: Vec<Element<'static, Message>> = vec![art.boxed()];
    if look.name {
        let name = text(view.name.clone()).font(style.font).size(style.size).line_height(style.line()).color(fg).wrapping(Wrapping::None).ellipsis(Ellipsis::End).width(Length::Fill);
        front.push(name.boxed());
    } else {
        front.push(space().width(Length::Fill).boxed());
    }
    let left = mouse_area(container(row(front).spacing(GAP).align_y(Alignment::Center).width(Length::Fill)).padding(Padding { left: PAD_START, right: GAP, ..Padding::ZERO }).center_y(Length::Fixed(frame.height)).width(Length::Fill))
        .on_press(Message::Shell(Event::TabPressed(id)))
        .on_enter(controls::hover(Hover::Tab(id)))
        .on_exit(controls::unhover())
        .on_double_click(Message::Shell(Event::TabRename(id)))
        .on_middle_release(Message::Shell(Event::TabClose(id)))
        .on_right_release(Message::Shell(Event::TabMenu(id)));

    let dot = dot_color(palette, view).map(|c| scaled(c, alpha));
    let show_close = look.close && (over || (view.front && view.state.is_none()));
    let end: Element<'static, Message> = match look.end {
        TabEnd::Gone => space().width(0.0).boxed(),
        TabEnd::Narrow => {
            let dot = dot.map_or_else(|| space().width(DOT).height(DOT).boxed(), |c| dot_widget(c));
            container(dot).center(Length::Fixed(END_NARROW)).height(Length::Fixed(END)).boxed()
        }
        TabEnd::Full if show_close => close_button(id, over_close, fg, theme),
        TabEnd::Full => {
            let slot: Element<'static, Message> = dot.map_or_else(|| space().boxed(), |c| dot_widget(c));
            container(slot).center(Length::Fixed(END)).boxed()
        }
    };
    let right = mouse_area(container(end).padding(Padding { right: PAD_END, ..Padding::ZERO }).center_y(Length::Fixed(frame.height)))
        .on_press(Message::Shell(Event::TabPressed(id)))
        .on_enter(controls::hover(Hover::TabClose(id)))
        .on_exit(controls::unhover())
        .on_middle_release(Message::Shell(Event::TabClose(id)))
        .on_right_release(Message::Shell(Event::TabMenu(id)));

    let (background, ring, tab_shadow) = if view.front {
        let (ring, soft) = elevation(palette.elevation_1);
        (Some(scaled(color(palette.surface), alpha)), ring, soft)
    } else if over {
        (Some(scaled(color(palette.surface_hover), alpha)), None, Shadow::default())
    } else {
        (None, None, Shadow::default())
    };
    let radius = tokens::scale::RADIUS_MD;
    let body = container(row![left, right].align_y(Alignment::Center))
        .width(Length::Fixed(frame.width))
        .height(Length::Fixed(frame.height))
        .style(move |_| container::Style { background: background.map(Background::Color), border: Border { color: ring.map_or(Color::TRANSPARENT, |(c, _)| scaled(c, alpha)), width: ring.map_or(0.0, |(_, w)| w), radius: radius.into() }, shadow: tab_shadow, ..container::Style::default() });
    let keys = Keys::Custom(Box::new(move |event| key_of(event).map(|key| Message::Shell(Event::TabKey(id, key)))));
    Focusable::new(ids::tab(id), FocusArea::TopBand, body.boxed(), Ring::of(palette, radius)).keys(keys).tab_stop(view.front).boxed()
}

fn dot_widget(colour: Color) -> Element<'static, Message> {
    container(space()).width(DOT).height(DOT).style(move |_| container::Style::default().background(colour).border(Border { radius: (DOT / 2.0).into(), ..Border::default() })).boxed()
}

fn close_button(id: styk_core::documents::DocumentId, hot: bool, fg: Color, theme: Theme) -> Element<'static, Message> {
    let palette = theme.palette();
    let hover_bg = color(palette.surface_pressed);
    let glyph = icon("close", 13.0, if hot { color(palette.text_1) } else { fg });
    let face = container(glyph).center(Length::Fixed(END));
    let radius = tokens::scale::RADIUS_XS;
    button(face)
        .width(END)
        .height(END)
        .padding(0)
        .on_press(Message::Shell(Event::TabClose(id)))
        .style(move |_: &IcedTheme, status| button::Style {
            background: (hot || matches!(status, button::Status::Pressed)).then_some(Background::Color(hover_bg)),
            text_color: Color::TRANSPARENT,
            border: Border { radius: radius.into(), ..Border::default() },
            shadow: Shadow::default(),
            snap: true,
        })
        .boxed()
}
