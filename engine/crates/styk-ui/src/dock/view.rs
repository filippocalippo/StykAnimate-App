//! The docked window's views: the islands, the tab headers, the strips and flyouts, the splitters, the tool rail's place
//! and the drop overlay, each at the rectangle `styk_core::dock::Dock` solved.
//!
//! The views draw and send `Event`s; they decide nothing. Where a rectangle goes, which tab is active, what a drag over the
//! window would do and how it is named are all the core's (`docs/native/docking-views.md`).

use super::probe::probe;
use crate::message::Message;
use iced::widget::{Column, Space, container, mouse_area, stack};
use iced::advanced::Widget;
use iced::{Alignment, Element, Length, Padding, Widget as _};
use styk_core::commands::Command;
use styk_core::dock::{Dock, Event, ids};
use styk_core::focus::FocusArea;
use styk_core::i18n::{Msg, Presentation};
use styk_core::layout::{Axis, PanelId, Rect, Side, TabGroup};
use styk_design::tokens::scale;
use styk_design::typography::TextStyle;
use styk_design::widgets::button::{IconButton, IconSize};
use styk_design::widgets::card::Card;
use styk_design::widgets::control::words;
use styk_design::widgets::focus::{Focusable, Ring};
use styk_design::widgets::layer::{Layer, Placed, Position};
use styk_design::widgets::parts::{Tab, Tabs, empty_state};
use styk_design::widgets::splitter::{self, Event_ as Drag};
use styk_design::widgets::tooltip::Content;
use styk_design::{Palette, Theme};

/// The height of a group's header: the tabs' track and its 6 px above and below (`.shell-island > .shell-tabs`).
pub const HEADER_HEIGHT: f32 = 44.0;

/// The width of a strip (`.ui-strip`).
pub const STRIP_WIDTH: f32 = 40.0;

/// What the dock needs besides its core.
pub struct Params<'a> {
    pub dock: &'a Dock,
    pub theme: Theme,
    pub presentation: &'a Presentation,
    /// The band's height: the dock's origin is that far under the window's top, and the core's rectangles are the window's.
    pub top: f32,
}

fn send(event: Event) -> Message {
    Message::Command(Command::Dock(event))
}

/// The panel's name as the interface writes it.
fn title(presentation: &Presentation, panel: &PanelId) -> String {
    match Dock::title_key(&panel.kind) {
        Some(key) => presentation.text(&Msg::new(key)),
        None => match panel.kind.as_str() {
            "stage" => "Stage".into(),
            "layers" => "Layers".into(),
            "tools" => "Tools".into(),
            other => other.to_string(),
        },
    }
}

/// The panel's glyph (`panel-registry.mjs`).
fn icon_of(panel: &PanelId) -> &'static str {
    match panel.kind.as_str() {
        "properties" => "inspector",
        "vfx" => "fx",
        "library" => "library",
        "structure" => "structure",
        "timeline" => "timeline",
        "layers" => "layers",
        "tools" => "select",
        _ => "stage",
    }
}

fn fixed<'a>(content: impl Widget<Message, iced::Theme, iced::Renderer> + 'a, width: f32, height: f32) -> Element<'a, Message> {
    container(content).width(Length::Fixed(width)).height(Length::Fixed(height)).boxed()
}

fn at<'a>(x: f32, y: f32) -> impl Fn(iced::Size, iced::Size) -> Position + 'a {
    move |_, _| Position::at(x, y)
}

/// A group's body when no view exists for its panel yet: today's empty-state part with the panel's name, placed and sized
/// like the real panel.
fn empty<'a>(params: &Params<'_>, panel: &PanelId) -> Element<'a, Message> {
    let palette = params.theme.palette();
    container(empty_state(palette, Some(icon_of(panel)), title(params.presentation, panel), None, None, false)).width(Length::Fill).height(Length::Fill).center_y(Length::Fill).boxed()
}

/// The island of a group at `rect`: its header, then the active panel's view.
fn island<'a>(params: &Params<'_>, group: &TabGroup, rect: Rect, body: Element<'a, Message>) -> Placed<'a, Message> {
    let palette = params.theme.palette();
    let id = group.id;
    let active = &group.tabs[group.active];
    let (width, height) = (rect.w as f32, rect.h as f32);
    let area = Dock::area_of(active);
    let mut column: Vec<Element<'a, Message>> = Vec::new();
    let solo_stage = group.tabs.len() == 1 && active.kind == "stage";
    if group.tabs.len() > 1 {
        let tabs: Vec<Tab> = group.tabs.iter().map(|panel| Tab { label: title(params.presentation, panel), icon: None }).collect();
        let strip = Tabs::new(ids::tabs(id), FocusArea::Panels, palette, tabs, group.active, move |index| send(Event::TabSelected { group: id, index })).into_element();
        let header = fixed(container(strip).padding(Padding { top: scale::SPACE_1_5, right: scale::SPACE_2, bottom: scale::SPACE_1_5, left: scale::SPACE_2 }), width, HEADER_HEIGHT);
        column.push(probe(header, move |at| send(Event::HeaderPressed { group: id, tab: None, x: f64::from(at.x), y: f64::from(at.y) })));
    } else if solo_stage {
        // The stage's own header (scene, view toggles, zoom) is the stage chunk's: its place is kept, and it drags the group.
        let blank = fixed(Space::new(), width, HEADER_HEIGHT);
        column.push(probe(blank, move |at| send(Event::HeaderPressed { group: id, tab: None, x: f64::from(at.x), y: f64::from(at.y) })));
    }
    // The body: the stage and the Properties panel's views, or the panel's empty state.
    let body: Element<'a, Message> = if group.tabs.len() == 1 && !solo_stage {
        // A panel that draws its own header is dragged by the strip along its top, under whatever it puts there.
        let grip = probe(fixed(Space::new(), width, HEADER_HEIGHT), move |at| send(Event::HeaderPressed { group: id, tab: None, x: f64::from(at.x), y: f64::from(at.y) }));
        stack![grip, body].width(Length::Fill).height(Length::Fill).boxed()
    } else {
        body
    };
    let ring = Ring { color: palette.focus_ring.into(), width: 2.0, offset: -3.0, radius: scale::RADIUS_XL - 2.0 };
    let body: Element<'a, Message> = if group.tabs.len() == 1 { Focusable::new(ids::body(id), area, container(body).width(Length::Fill).height(Length::Fill).boxed(), ring).boxed() } else { body };
    column.push(container(body).width(Length::Fill).height(Length::Fill).boxed());
    let card = Card::new(Column::with_children(column).width(Length::Fill).height(Length::Fill)).fill(palette.surface).radius(scale::RADIUS_XL).shadows(palette.elevation_island).width(Length::Fixed(width)).height(Length::Fixed(height)).clip(true);
    Placed::new(card, at(rect.x as f32, rect.y as f32 - params.top))
}

/// A strip: the icons of a folded or collapsed group, one per tab.
fn strip<'a>(params: &Params<'_>, group: &TabGroup, rect: Rect, side: Side) -> Placed<'a, Message> {
    let palette = params.theme.palette();
    let id = group.id;
    let vertical = matches!(side, Side::Left | Side::Right);
    let buttons: Vec<Element<'a, Message>> = group
        .tabs
        .iter()
        .enumerate()
        .map(|(index, panel)| {
            let name = title(params.presentation, panel);
            IconButton::new(ids::strip(id, index), FocusArea::Panels, palette, icon_of(panel), send(Event::Open { group: id, tab: index }))
                .toggled(params.dock.open() == Some(id) && group.active == index)
                .tooltip(Content { label: name, shortcut: String::new() }, Message::Tooltip)
                .into_element()
        })
        .collect();
    let inner: Element<'a, Message> = if vertical {
        Column::with_children(buttons).spacing(scale::SPACE_0_5).align_x(Alignment::Center).boxed()
    } else {
        iced::widget::Row::with_children(buttons).spacing(scale::SPACE_0_5).align_y(Alignment::Center).boxed()
    };
    let pad = if vertical { Padding { top: scale::SPACE_1_5, right: 0.0, bottom: scale::SPACE_1_5, left: 0.0 } } else { Padding { top: 0.0, right: scale::SPACE_1_5, bottom: 0.0, left: scale::SPACE_1_5 } };
    let content = container(inner).padding(pad).width(Length::Fill).height(Length::Fill).center_x(Length::Fill);
    let card = Card::new(content).fill(palette.surface).radius(scale::RADIUS_XL).shadows(palette.elevation_island).width(Length::Fixed(rect.w as f32)).height(Length::Fixed(rect.h as f32));
    Placed::new(card, at(rect.x as f32, rect.y as f32 - params.top))
}

/// A divider: the splitter widget over the gap between two islands.
fn divider<'a>(params: &Params<'_>, divider: &styk_core::layout::Divider) -> Placed<'a, Message> {
    let palette = params.theme.palette();
    let (split, index) = (divider.split, divider.index);
    let vertical_bar = divider.axis == Axis::Horizontal;
    let bar = splitter::splitter(palette, ids::divider(split, index), FocusArea::Panels, if vertical_bar { splitter::Axis::Vertical } else { splitter::Axis::Horizontal }, params.dock.resizing() == Some((split, index)), move |event| {
        send(match event {
            Drag::DragStart => Event::DividerPressed { split, index },
            Drag::DragMove(delta) => Event::DividerMoved(f64::from(delta)),
            Drag::DragEnd => Event::DividerReleased,
            Drag::Step { direction, shift } => Event::DividerStep { split, index, direction, shift },
            Drag::Reset => Event::DividerReset { split, index },
            Drag::Largest => Event::DividerLargest { split, index },
            Drag::Cancel => Event::Escape,
        })
    });
    // The splitter is 8 px across and sits centred on the gap, the way the islands' gutter does.
    let r = divider.rect;
    let (x, y, w, h) = if vertical_bar { (r.x as f32 + (r.w as f32 - 8.0) / 2.0, r.y as f32, 8.0, r.h as f32) } else { (r.x as f32, r.y as f32 + (r.h as f32 - 8.0) / 2.0, r.w as f32, 8.0) };
    Placed::new(fixed(bar, w, h), at(x, y - params.top))
}

/// The flyout or sheet of the open group: a press anywhere else closes it.
fn flyout<'a>(params: &Params<'_>, group: &TabGroup, body: Element<'a, Message>, out: &mut Vec<Placed<'a, Message>>) {
    let dock = params.dock;
    let solution = dock.solution();
    let (Some(sheet), palette) = (solution.sheets.get(&group.id), params.theme.palette()) else { return };
    let side = solution.fit.sides.get(&group.id).copied().unwrap_or(Side::Right);
    let window = dock.window();
    // Beside the strip when there is one, else at the window's edge (a sheet).
    let edge = |side: Side| solution.strips.get(&group.id).map(|s| match side {
        Side::Left => s.x + s.w + 8.0,
        Side::Right => s.x - 8.0,
        Side::Top => s.y + s.h + 8.0,
        Side::Bottom => s.y - 8.0,
    });
    let (w, h) = (sheet.w, sheet.h);
    let (x, y, w, h) = match side {
        Side::Left => (edge(Side::Left).unwrap_or(sheet.x), sheet.y, w, h),
        Side::Right => (edge(Side::Right).unwrap_or(window.w - 8.0) - w, sheet.y, w, h),
        Side::Top | Side::Bottom => {
            let width = window.w - 16.0;
            let height = group.flyout_px.min(sheet.h * 0.6).max(120.0);
            (8.0, edge(Side::Bottom).unwrap_or(window.h - 8.0) - height, width, height)
        }
    };
    let id = group.id;
    let scrim = mouse_area(Space::new().width(Length::Fill).height(Length::Fill)).on_press(send(Event::Escape));
    out.push(Placed::new(container(scrim).width(Length::Fill).height(Length::Fill), at(0.0, 0.0)));
    let mut column: Vec<Element<'a, Message>> = Vec::new();
    let tabs: Vec<Tab> = group.tabs.iter().map(|panel| Tab { label: title(params.presentation, panel), icon: None }).collect();
    let tabs = Tabs::new(ids::tabs(id), FocusArea::Panels, palette, tabs, group.active, move |index| send(Event::Open { group: id, tab: index })).into_element();
    let pin = IconButton::new(ids::pin(id), FocusArea::Panels, palette, "pin", send(Event::Pin(id))).size(IconSize::Sm).into_element();
    let header = iced::widget::Row::with_children(vec![container(tabs).width(Length::Fill).boxed(), pin]).align_y(Alignment::Center).spacing(scale::SPACE_1);
    column.push(fixed(container(header).padding(Padding { top: scale::SPACE_1_5, right: scale::SPACE_2, bottom: scale::SPACE_1_5, left: scale::SPACE_2 }), w as f32, HEADER_HEIGHT));
    column.push(container(body).width(Length::Fill).height(Length::Fill).boxed());
    let card = Card::new(Column::with_children(column)).fill(palette.surface).radius(scale::RADIUS_XL).shadows(palette.elevation_3).width(Length::Fixed(w as f32)).height(Length::Fixed(h as f32)).clip(true);
    out.push(Placed::new(card, at(x as f32, y as f32 - params.top)));
}

/// The tool rail's place over the stage (`.studio-rail`: 52 px wide, 12 px inside the stage, centred on its height): a
/// bare bar until the tools chunk fills it.
fn rail<'a>(params: &Params<'_>, stage: Rect, side: Side) -> Placed<'a, Message> {
    let palette = params.theme.palette();
    let (w, h) = (52.0_f32, 220.0_f32);
    let (x, y) = (if side == Side::Right { (stage.x + stage.w) as f32 - 12.0 - w } else { stage.x as f32 + 12.0 }, (stage.y as f32 + stage.h as f32 / 2.0 - h / 2.0).round());
    let card = Card::new(Space::new()).fill(palette.surface).radius(20.0).shadows(palette.elevation_2).width(Length::Fixed(w)).height(Length::Fixed(h));
    Placed::new(card, at(x, y - params.top)).passive()
}

/// The drop overlay: the rectangle the panel would take, named, and the title following the pointer.
fn overlay<'a>(params: &Params<'_>, out: &mut Vec<Placed<'a, Message>>) {
    let Some(drag) = params.dock.drag() else { return };
    let palette = params.theme.palette();
    let name = title(params.presentation, &drag.source);
    if let Some(r) = drag.preview {
        // `.ui-drop-zone`: the accent's soft fill at 72 %, a 1.5 px accent line inside, the radius of the islands.
        let soft = styk_design::Rgba { a: 0.72, ..palette.accent_soft };
        let zone = Card::new(Space::new()).fill(soft).ring(1.5, palette.accent_line).radius(scale::RADIUS_XL).width(Length::Fixed(r.w as f32)).height(Length::Fixed(r.h as f32));
        out.push(Placed::new(zone, at(r.x as f32, r.y as f32 - params.top)).passive());
        out.push(pill(palette, drag.label, (r.x + r.w / 2.0) as f32, (r.y + r.h / 2.0) as f32 - params.top, true));
    } else if !drag.label.is_empty() {
        out.push(pill(palette, drag.label, drag.pointer.0 as f32, drag.pointer.1 as f32 - params.top + 28.0, true));
    }
    // The dragged panel's title follows the pointer.
    out.push(pill(palette, &name, drag.pointer.0 as f32 + 14.0, drag.pointer.1 as f32 - params.top + 14.0, false));
}

/// `.ui-drop-label`: a pill on the raised surface naming a place (centred on the point), or a title pill (from the point).
fn pill<'a>(palette: &'static Palette, text: &str, x: f32, y: f32, centred: bool) -> Placed<'a, Message> {
    let style = TextStyle::from_role(&scale::TYPE_SMALL_STRONG);
    let ink = if centred { palette.accent_text } else { palette.text_1 };
    let label = container(words(text.to_string(), style, ink)).center_y(Length::Fixed(scale::CONTROL_MD)).padding(Padding { top: 0.0, right: scale::SPACE_3, bottom: 0.0, left: scale::SPACE_3 });
    let card = Card::new(label).fill(palette.surface_raised).radius(scale::RADIUS_PILL).shadows(palette.elevation_1).height(Length::Fixed(scale::CONTROL_MD));
    if centred {
        Placed::new(card, move |natural, _| Position::at(x - natural.width / 2.0, y - natural.height / 2.0)).passive()
    } else {
        Placed::new(card, at(x, y)).passive()
    }
}

/// The docked window below the band: every group at its rectangle, then the strips, splitters, the rail, the flyout and the
/// drop overlay. `panel` gives each shown panel's view; `None` is today's empty state with the panel's name.
pub fn view<'a>(params: &Params<'_>, panel: &mut dyn FnMut(&PanelId) -> Option<Element<'a, Message>>) -> Element<'a, Message> {
    let dock = params.dock;
    let solution = dock.solution();
    let layout = dock.layout();
    let mut children: Vec<Placed<'a, Message>> = Vec::new();
    let mut open_body: Option<(TabGroup, Element<'a, Message>)> = None;
    for group in layout.groups() {
        let active = &group.tabs[group.active];
        if let Some(rect) = solution.groups.get(&group.id) {
            let body = panel(active).unwrap_or_else(|| empty(params, active));
            children.push(island(params, group, *rect, body));
        } else if dock.open() == Some(group.id) {
            let body = panel(active).unwrap_or_else(|| empty(params, active));
            open_body = Some((group.clone(), body));
        }
        if let Some(rect) = solution.strips.get(&group.id) {
            let side = solution.fit.sides.get(&group.id).copied().unwrap_or(Side::Right);
            children.push(strip(params, group, *rect, side));
        }
    }
    for d in dock.dividers() {
        children.push(divider(params, d));
    }
    if let Some(side) = layout.stage_tools {
        for stage in solution.stages.values() {
            children.push(rail(params, *stage, side));
        }
    }
    if let Some((group, body)) = open_body {
        flyout(params, &group, body, &mut children);
    }
    overlay(params, &mut children);
    Layer::new(children).boxed()
}

