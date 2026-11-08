//! The panel's small parts (`stepper.css`, `kbd.css`, `dot.css`, `crumb.css`, `island.css`, `list-row.css`, `section.css`,
//! `tabs.css`, `empty.css`, `split.css`, `splitter.css`, and the scroll areas): shapes that are drawn from a value the owner
//! holds. They decide nothing: a press or a drag is reported, and the owner (the core) says what it means.

use iced::Widget as _;
use super::badge::{Tint, badge};
use super::button::{IconButton, IconSize};
use super::card::Card;
use super::control::{FIELD_DISABLED, Interaction, Preview, pill, words};
use super::focus::{Focusable, Ring};
use super::roving::{RovingGroup, RovingItem};
use super::surface::{Look, Surface};
use crate::tokens::scale;
use crate::typography::TextStyle;
use crate::{Palette, Rgba};
use iced::widget::{Column, Row, Space, container, scrollable};
use iced::{Alignment, Background, Border, Color, Element, Length, Padding, Radians, Rotation};
use styk_core::focus::{FocusArea, FocusId, InputRole};
use styk_core::roving::Orientation;

fn tint_of(color: Rgba) -> Background {
    Background::Color(color.into())
}

// ---------------------------------------------------------------------------------------------------------------------
// Kbd, chord, dot, divider

/// A keycap (`.ui-kbd`): for the keyboard shortcuts dialog only.
pub fn kbd<'a, Message: 'a>(palette: &'static Palette, text: impl Into<String>) -> Element<'a, Message> {
    let key = container(words(text, TextStyle::from_role(&scale::TYPE_MICRO), palette.text_2)).center_x(Length::Shrink).center_y(Length::Fixed(scale::SIZE_KBD)).padding(Padding { top: 0.0, right: scale::SPACE_1, bottom: 0.0, left: scale::SPACE_1 }).style(|_| container::Style::default());
    // `min-inline-size` and `block-size` are 20 px; the face has a hairline all round and a second one under it.
    Card::new(container(key).center_x(Length::Shrink).width(Length::Shrink).height(Length::Fixed(scale::SIZE_KBD)))
        .fill(palette.kbd_bg)
        .radius(scale::RADIUS_XS)
        .ring(1.0, palette.kbd_line)
        .underlay(1.0, palette.kbd_line)
        .boxed()
}

/// A chord: keycaps side by side.
pub fn chord<'a, Message: 'a>(palette: &'static Palette, keys: &[&str]) -> Element<'a, Message> {
    Row::with_children(keys.iter().map(|key| kbd(palette, *key)).collect::<Vec<_>>()).spacing(scale::SPACE_0_5).boxed()
}

/// What a dot says.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DotKind {
    Neutral,
    Success,
    Warning,
    Danger,
    Select,
    Library,
    Draw,
}

/// A 7 px circle (`.ui-dot`); `hollow` draws a ring instead of a fill.
pub fn dot<'a, Message: 'a>(palette: &'static Palette, kind: DotKind, hollow: bool) -> Element<'a, Message> {
    let color = match kind {
        DotKind::Neutral => palette.neutral_dot,
        DotKind::Success => palette.success_dot,
        DotKind::Warning => palette.warning_dot,
        DotKind::Danger => palette.danger_dot,
        DotKind::Select => palette.tint_select,
        DotKind::Library => palette.tint_library,
        DotKind::Draw => palette.tint_draw,
    };
    let side = 7.0;
    container(Space::new())
        .width(Length::Fixed(side))
        .height(Length::Fixed(side))
        .style(move |_| container::Style {
            background: (!hollow).then(|| tint_of(color)),
            border: Border { color: if hollow { color.into() } else { Color::TRANSPARENT }, width: if hollow { 1.5 } else { 0.0 }, radius: (side / 2.0).into() },
            ..container::Style::default()
        })
        .boxed()
}

/// A one-pixel rule (`--line-1`), as wide as its container.
pub fn divider<'a, Message: 'a>(palette: &'static Palette) -> Element<'a, Message> {
    let line = palette.line_1;
    container(Space::new()).width(Length::Fill).height(Length::Fixed(1.0)).style(move |_| container::Style { background: Some(tint_of(line)), ..container::Style::default() }).boxed()
}

// ---------------------------------------------------------------------------------------------------------------------
// Crumb

/// A crumb part you can press: a glyph, the words and (small, grey) the meta after them.
#[allow(clippy::too_many_arguments)] // A crumb part: its words, glyph, meta, message and the preview of a state.
pub fn crumb_item<'a, Message: Clone + 'a>(palette: &'static Palette, id: FocusId, area: FocusArea, label: impl Into<String>, icon: Option<&'static str>, meta: Option<String>, on_press: Message, preview: Option<Preview>) -> Element<'a, Message> {
    let label = label.into();
    let face_of = move |ink: Rgba| -> Element<'a, Message> {
        let mut parts: Vec<Element<'a, Message>> = Vec::new();
        if let Some(icon) = icon {
            parts.push(super::icon(icon, scale::ICON_SM, ink).boxed());
        }
        parts.push(words(label.clone(), TextStyle::from_role(&scale::TYPE_UI), ink));
        if let Some(meta) = &meta {
            parts.push(words(meta.clone(), TextStyle::from_role(&scale::TYPE_SMALL), palette.text_3));
        }
        container(Row::with_children(parts).spacing(scale::SPACE_1_5).align_y(Alignment::Center)).center_y(Length::Fixed(scale::CONTROL_MD)).padding(Padding { top: 0.0, right: scale::SPACE_2, bottom: 0.0, left: scale::SPACE_2 }).boxed()
    };
    let hover = palette.surface_hover;
    let look = move |interaction: Interaction| Look { fill: (interaction != Interaction::Rest).then_some(hover), border: 0.0, ring: None, shadows: &[], radius: scale::RADIUS_MD, opacity: 1.0, scale: 1.0 };
    let surface = Surface::new(face_of(palette.text_2), look).hover_face(face_of(palette.text_1)).on_press_maybe(Some(on_press.clone())).preview(preview).height(Length::Fixed(scale::CONTROL_MD));
    Focusable::new(id, area, surface.boxed(), Ring { offset: scale::FOCUS_OFFSET_INSET, ..Ring::of(palette, scale::RADIUS_MD) }).on_activate(on_press).ring_shown(preview == Some(Preview::Focus)).boxed()
}

/// The `›` between crumb parts.
pub fn crumb_sep<'a, Message: 'a>(palette: &'static Palette) -> Element<'a, Message> {
    container(words("\u{203a}", TextStyle::from_role(&scale::TYPE_UI), palette.text_3)).padding(Padding { left: scale::SPACE_0_5, right: scale::SPACE_0_5, ..Padding::ZERO }).boxed()
}

/// The part you are at (`.ui-crumb-here`): ink, strong.
pub fn crumb_here<'a, Message: 'a>(palette: &'static Palette, label: impl Into<String>, icon: Option<&'static str>) -> Element<'a, Message> {
    let mut parts: Vec<Element<'a, Message>> = Vec::new();
    if let Some(icon) = icon {
        parts.push(super::icon(icon, scale::ICON_SM, palette.text_1).boxed());
    }
    parts.push(words(label, TextStyle::from_role(&scale::TYPE_UI_STRONG), palette.text_1));
    container(Row::with_children(parts).spacing(scale::SPACE_1_5).align_y(Alignment::Center)).padding(Padding { left: scale::SPACE_1, right: scale::SPACE_1, ..Padding::ZERO }).boxed()
}

/// The background chip (`.ui-crumb-chip`): 18 x 13 of the scene's colour inside a visible border.
pub fn crumb_chip<'a, Message: 'a>(palette: &'static Palette, color: [u8; 3]) -> Element<'a, Message> {
    let fill = Rgba::new(color[0], color[1], color[2], 1.0);
    let line = palette.line_control;
    let chip = Card::new(Space::new().width(Length::Fixed(18.0)).height(Length::Fixed(13.0))).fill(fill).radius(scale::RADIUS_2XS).ring(1.0, line);
    container(chip).center_x(Length::Fixed(scale::CONTROL_MD)).center_y(Length::Fixed(scale::CONTROL_MD)).boxed()
}

// ---------------------------------------------------------------------------------------------------------------------
// Island, list rows, section heads

/// The floating panel (`.ui-island`): the surface on the window field, radius 16, with the island elevation (or the raised
/// one while it floats over the stage).
pub fn island<'a, Message: 'a>(palette: &'static Palette, content: Element<'a, Message>, floating: bool) -> Element<'a, Message> {
    Card::new(content).fill(palette.surface).radius(scale::RADIUS_XL).shadows(if floating { palette.elevation_3 } else { palette.elevation_island }).width(Length::Fill).height(Length::Fill).boxed()
}

/// An island's head: 44 px, its title in the section type, its actions at the end.
pub fn island_head<'a, Message: 'a>(palette: &'static Palette, title: impl Into<String>, actions: Vec<Element<'a, Message>>) -> Element<'a, Message> {
    let title = container(words(title, TextStyle::from_role(&scale::TYPE_SECTION), palette.text_1)).width(Length::Fill);
    let mut parts: Vec<Element<'a, Message>> = vec![title.boxed()];
    parts.extend(actions);
    let line = Row::with_children(parts).spacing(scale::SPACE_2).align_y(Alignment::Center);
    container(line).height(Length::Fixed(scale::CONTROL_2XL)).center_y(Length::Fixed(scale::CONTROL_2XL)).padding(Padding { top: 0.0, right: scale::SPACE_2, bottom: 0.0, left: scale::ISLAND_PAD }).boxed()
}

/// A row of a list (`.ui-list-row`): 32 px, a lead glyph, the label, a meta and the row's actions at the end.
pub struct ListRow<'a, Message> {
    id: FocusId,
    area: FocusArea,
    palette: &'static Palette,
    label: String,
    lead: Option<&'static str>,
    meta: Option<String>,
    level: u32,
    selected: bool,
    hidden: bool,
    actions: Vec<Element<'a, Message>>,
    on_press: Message,
    preview: Option<Preview>,
}

impl<'a, Message: Clone + 'a> ListRow<'a, Message> {
    pub fn new(id: FocusId, area: FocusArea, palette: &'static Palette, label: impl Into<String>, on_press: Message) -> Self {
        ListRow { id, area, palette, label: label.into(), lead: None, meta: None, level: 0, selected: false, hidden: false, actions: Vec::new(), on_press, preview: None }
    }

    pub fn lead(mut self, icon: &'static str) -> Self {
        self.lead = Some(icon);
        self
    }

    pub fn meta(mut self, meta: impl Into<String>) -> Self {
        self.meta = Some(meta.into());
        self
    }

    /// `--level`: each level indents 14 px.
    pub fn level(mut self, level: u32) -> Self {
        self.level = level;
        self
    }

    /// `aria-selected` or `aria-current`.
    pub fn selected(mut self, selected: bool) -> Self {
        self.selected = selected;
        self
    }

    /// `data-hidden`: the label goes quiet.
    pub fn hidden(mut self, hidden: bool) -> Self {
        self.hidden = hidden;
        self
    }

    pub fn actions(mut self, actions: Vec<Element<'a, Message>>) -> Self {
        self.actions = actions;
        self
    }

    pub fn preview(mut self, preview: Option<Preview>) -> Self {
        self.preview = preview;
        self
    }

    pub fn into_element(self) -> Element<'a, Message> {
        let ListRow { id, area, palette, label, lead, meta, level, selected, hidden, actions, on_press, preview } = self;
        let style = TextStyle::from_role(if selected { &scale::TYPE_UI_STRONG } else { &scale::TYPE_UI });
        let ink = if hidden { palette.text_3 } else { palette.text_1 };
        let mut parts: Vec<Element<'a, Message>> = Vec::new();
        if let Some(lead) = lead {
            parts.push(super::icon_stroked(lead, scale::ICON_SM, if selected { palette.accent_text } else { palette.text_3 }, 2.0).boxed());
        }
        parts.push(words(label, style, ink));
        if let Some(meta) = meta {
            parts.push(words(meta, TextStyle::from_role(&scale::TYPE_SMALL), palette.text_3));
        }
        parts.push(Space::new().width(Length::Fill).boxed());
        parts.extend(actions);
        let line = Row::with_children(parts).spacing(scale::SPACE_2).align_y(Alignment::Center);
        let left = scale::SPACE_2_5 + level as f32 * scale::SPACE_3_5;
        let face = container(line).width(Length::Fill).height(Length::Fixed(32.0)).center_y(Length::Fixed(32.0)).padding(Padding { top: 0.0, right: scale::SPACE_1, bottom: 0.0, left });
        let (hover, chosen) = (palette.surface_hover, palette.surface_selected);
        let look = move |interaction: Interaction| Look {
            fill: if selected { Some(chosen) } else { (interaction != Interaction::Rest).then_some(hover) },
            border: 0.0,
            ring: None,
            shadows: &[],
            radius: scale::RADIUS_SM,
            opacity: 1.0,
            scale: 1.0,
        };
        let surface = Surface::new(face.boxed(), look).on_press_maybe(Some(on_press.clone())).preview(preview).width(Length::Fill).height(Length::Fixed(32.0));
        Focusable::new(id, area, surface.boxed(), Ring { offset: scale::FOCUS_OFFSET_INSET, ..Ring::of(palette, scale::RADIUS_SM) }).on_activate(on_press).ring_shown(preview == Some(Preview::Focus)).boxed()
    }
}

/// A group's label above its rows (`.ui-group-label`).
pub fn group_label<'a, Message: 'a>(palette: &'static Palette, text: impl Into<String>) -> Element<'a, Message> {
    container(words(text, TextStyle::from_role(&scale::TYPE_SMALL_STRONG), palette.text_3)).height(Length::Fixed(28.0)).center_y(Length::Fixed(28.0)).padding(Padding { top: scale::SPACE_1_5, right: scale::SPACE_2_5, bottom: scale::SPACE_0_5, left: scale::SPACE_2_5 }).boxed()
}

/// A section's head. A collapsible one is a row that opens it, with a chevron at its end that turns a quarter when open;
/// the badge names the section's kind.
pub struct SectionHead<'a, Message> {
    palette: &'static Palette,
    title: String,
    badge: Option<(&'static str, Tint)>,
    open: bool,
    toggle: Option<(FocusId, FocusArea, Message)>,
    actions: Vec<Element<'a, Message>>,
    preview: Option<Preview>,
}

impl<'a, Message: Clone + 'a> SectionHead<'a, Message> {
    pub fn new(palette: &'static Palette, title: impl Into<String>) -> Self {
        SectionHead { palette, title: title.into(), badge: None, open: false, toggle: None, actions: Vec::new(), preview: None }
    }

    pub fn badge(mut self, icon: &'static str, tint: Tint) -> Self {
        self.badge = Some((icon, tint));
        self
    }

    /// The section folds: the head is a button that sends `on_toggle`, and `open` says how the chevron sits.
    pub fn collapsible(mut self, id: FocusId, area: FocusArea, open: bool, on_toggle: Message) -> Self {
        self.toggle = Some((id, area, on_toggle));
        self.open = open;
        self
    }

    pub fn actions(mut self, actions: Vec<Element<'a, Message>>) -> Self {
        self.actions = actions;
        self
    }

    pub fn preview(mut self, preview: Option<Preview>) -> Self {
        self.preview = preview;
        self
    }

    pub fn into_element(self) -> Element<'a, Message> {
        let SectionHead { palette, title, badge: tile, open, toggle, actions, preview } = self;
        let mut parts: Vec<Element<'a, Message>> = Vec::new();
        if let Some((icon, tint)) = tile {
            parts.push(badge(palette, icon, tint));
        }
        parts.push(container(words(title, TextStyle::from_role(&scale::TYPE_SECTION).tracking_em(-0.005), palette.text_1)).width(Length::Fill).boxed());
        let Some((id, area, on_toggle)) = toggle else {
            parts.extend(actions);
            return container(Row::with_children(parts).spacing(scale::SPACE_2).align_y(Alignment::Center)).height(Length::Fixed(scale::CONTROL_SM)).center_y(Length::Fixed(scale::CONTROL_SM)).boxed();
        };
        let chevron = super::icon_stroked("chevron-right", scale::ICON_MD, palette.text_3, 2.0).rotation(Rotation::Floating(Radians(if open { std::f32::consts::FRAC_PI_2 } else { 0.0 })));
        let face = |parts: Vec<Element<'a, Message>>| -> Element<'a, Message> { container(Row::with_children(parts).spacing(scale::SPACE_2).align_y(Alignment::Center)).center_y(Length::Fixed(scale::CONTROL_LG)).padding(Padding { top: 0.0, right: scale::SPACE_2, bottom: 0.0, left: scale::SPACE_2 }).boxed() };
        parts.push(chevron.boxed());
        let hover = palette.surface_hover;
        let look = move |interaction: Interaction| Look { fill: (interaction != Interaction::Rest).then_some(hover), border: 0.0, ring: None, shadows: &[], radius: scale::RADIUS_MD, opacity: 1.0, scale: 1.0 };
        let surface = Surface::new(face(parts), look).on_press_maybe(Some(on_toggle.clone())).preview(preview).width(Length::Fill).height(Length::Fixed(scale::CONTROL_LG));
        let toggle = Focusable::new(id, area, surface.boxed(), Ring { offset: scale::FOCUS_OFFSET_INSET, ..Ring::of(palette, scale::RADIUS_MD) }).on_activate(on_toggle).ring_shown(preview == Some(Preview::Focus));
        toggle.boxed()
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Tabs

/// One tab.
pub struct Tab {
    pub label: String,
    pub icon: Option<&'static str>,
}

/// A view switch drawn like every other switch (`.ui-tabs`): a pill track on the well and a thumb under the shown tab; the
/// `rule` variant has no track. Item `i` is the focus target `FocusId(first.0 + i)`.
pub struct Tabs<'a, Message> {
    first: FocusId,
    area: FocusArea,
    palette: &'static Palette,
    tabs: Vec<Tab>,
    selected: usize,
    rule: bool,
    on_select: Box<dyn Fn(usize) -> Message + 'a>,
    /// A tab closes with its x (on the tab in front and on a hovered one) and with a middle click.
    on_close: Option<Box<dyn Fn(usize) -> Message + 'a>>,
    preview: Option<(usize, Preview)>,
}

impl<'a, Message: Clone + 'a> Tabs<'a, Message> {
    pub fn new(first: FocusId, area: FocusArea, palette: &'static Palette, tabs: Vec<Tab>, selected: usize, on_select: impl Fn(usize) -> Message + 'a) -> Self {
        Tabs { first, area, palette, tabs, selected, rule: false, on_select: Box::new(on_select), on_close: None, preview: None }
    }

    /// `data-variant="rule"`: no track.
    pub fn rule(mut self, rule: bool) -> Self {
        self.rule = rule;
        self
    }

    pub fn preview(mut self, item: usize, preview: Preview) -> Self {
        self.preview = Some((item, preview));
        self
    }

    /// Tabs that close: the owner decides whether one may (the last stage stays) and what closing means.
    pub fn closable(mut self, on_close: impl Fn(usize) -> Message + 'a) -> Self {
        self.on_close = Some(Box::new(on_close));
        self
    }

    pub fn into_element(self) -> Element<'a, Message> {
        let Tabs { first, area, palette, tabs, selected, rule, on_select, on_close, preview } = self;
        let track = scale::CONTROL_MD;
        let height = track - 2.0 * scale::SPACE_0_5;
        let radius = pill(height);
        let choose = std::sync::Arc::new(on_select);
        let style = TextStyle::from_role(&scale::TYPE_BUTTON);
        let items: Vec<RovingItem<'a, Message>> = tabs
            .into_iter()
            .enumerate()
            .map(|(index, tab)| {
                let on = index == selected;
                // The x sits in the tab's right padding, so a tab is as wide with it as without. The rest face holds the pressable x
                // (a tab not hovered draws it clear, and cannot be pressed); the hover face draws it.
                let close = on_close.as_ref().map(|close| close(index));
                let face = |ink: Rgba, x: Option<Rgba>| -> Element<'a, Message> {
                    let mut parts: Vec<Element<'a, Message>> = Vec::new();
                    if let Some(icon) = tab.icon {
                        parts.push(super::icon(icon, scale::ICON_MD, ink).boxed());
                    }
                    parts.push(words(tab.label.clone(), style, ink));
                    let label = container(Row::with_children(parts).spacing(scale::SPACE_1_5).align_y(Alignment::Center)).height(Length::Fixed(height)).center_y(Length::Fixed(height)).padding(Padding { top: 0.0, right: scale::SPACE_3, bottom: 0.0, left: scale::SPACE_3 });
                    match (&close, x) {
                        (Some(message), Some(ink)) => {
                            let glyph = container(super::icon("close", scale::ICON_SM - 2.0, ink)).center_x(Length::Fixed(scale::ICON_SM + 2.0)).center_y(Length::Fixed(height));
                            let x = Surface::new(glyph.boxed(), |_| Look::plain(scale::RADIUS_SM)).on_press_maybe(Some(message.clone())).height(Length::Fixed(height));
                            let at_end = container(x).width(Length::Fill).height(Length::Fixed(height)).align_right(Length::Fill);
                            iced::widget::stack![label, at_end].height(Length::Fixed(height)).boxed()
                        }
                        _ => label.boxed(),
                    }
                };
                let clear = Rgba { a: 0.0, ..palette.text_3 };
                let held = preview.filter(|(at, _)| *at == index).map(|(_, preview)| preview);
                let look = move |_: Interaction| {
                    if on {
                        Look { fill: Some(palette.control_thumb), border: 0.0, ring: None, shadows: palette.shadow_thumb, radius, opacity: 1.0, scale: 1.0 }
                    } else {
                        Look::plain(radius)
                    }
                };
                let message = choose(index);
                let mut surface = Surface::new(face(if on { palette.text_1 } else { palette.text_2 }, Some(if on { palette.text_3 } else { clear })), look).on_press_maybe(Some(message.clone())).on_middle_maybe(close.clone()).preview(held).height(Length::Fixed(height));
                if !on {
                    surface = surface.hover_face(face(palette.text_1, Some(palette.text_3)));
                }
                RovingItem { id: FocusId(first.0 + index as u64), content: surface.boxed(), enabled: true, on_activate: Some(message) }
            })
            .collect();
        let ring = Ring { offset: -2.0, ..Ring::of(palette, radius) };
        let on_move = choose.clone();
        let group = RovingGroup::new(area, items, selected, ring, move |index| on_move(index)).orientation(Orientation::Horizontal).spacing(scale::SPACE_0_5).input_role(InputRole::Radio).ring_shown(preview.filter(|(_, preview)| *preview == Preview::Focus).map(|(item, _)| item)).into_element();
        let well = palette.surface_well;
        container(group).padding(scale::SPACE_0_5).height(Length::Fixed(track)).style(move |_| container::Style { background: (!rule).then(|| tint_of(well)), border: Border { radius: (track / 2.0).into(), ..Border::default() }, ..container::Style::default() }).boxed()
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Scroll areas

/// A vertical scroll area with the drawn 6 px scrollbar (`::-webkit-scrollbar`): the thumb in `--scrollbar-thumb-hover`,
/// a 3 px radius, no track.
pub fn scroll<'a, Message: 'a>(palette: &'static Palette, content: Element<'a, Message>) -> Element<'a, Message> {
    let thumb = palette.scrollbar_thumb_hover;
    scrollable(content)
        .direction(scrollable::Direction::Vertical(scrollable::Scrollbar::new().width(6.0).scroller_width(6.0).margin(0.0)))
        .style(move |_, _| {
            let rail = scrollable::Rail { background: None, border: Border::default(), scroller: scrollable::Scroller { background: tint_of(thumb), border: Border { radius: 3.0.into(), ..Border::default() } } };
            scrollable::Style { container: container::Style::default(), vertical_rail: rail, horizontal_rail: rail, gap: None, auto_scroll: scrollable::AutoScroll { background: tint_of(thumb), border: Border::default(), shadow: iced::Shadow::default(), icon: thumb.into() } }
        })
        .boxed()
}

// ---------------------------------------------------------------------------------------------------------------------
// Stepper, empty state, split button

/// A stepper (`.ui-stepper`): a 36 px sunken group of a minus, the value and a plus. The value is the owner's; a press on
/// either end asks for a step of -1 or +1 and the owner applies its limits.
pub fn stepper<'a, Message: Clone + 'a>(palette: &'static Palette, first: FocusId, area: FocusArea, value: impl Into<String>, disabled: bool, focused: bool, on_step: impl Fn(i32) -> Message + 'a) -> Element<'a, Message> {
    let ink = if disabled { palette.text_1.faded(FIELD_DISABLED) } else { palette.text_1 };
    let shown = container(words(value, TextStyle::from_role(&scale::TYPE_VALUE), ink)).center_x(Length::Fixed(40.0)).center_y(Length::Fill);
    let end = |id: FocusId, icon: &'static str, step: i32| IconButton::new(id, area, palette, icon, on_step(step)).size(IconSize::Xs).input_role(InputRole::Text).disabled(disabled).into_element();
    let row = Row::with_children(vec![end(first, "minus", -1), shown.boxed(), end(FocusId(first.0 + 1), "plus", 1)]).spacing(scale::SPACE_0_5).align_y(Alignment::Center);
    let card = Card::new(row).radius(scale::RADIUS_MD).height(Length::Fixed(scale::CONTROL_LG)).padding(scale::SPACE_0_5);
    if focused { card.fill(palette.surface).ring(1.5, palette.accent_line).halo(palette.focus_halo) } else { card.fill(palette.surface_sunken) }.boxed()
}

/// An empty state (`.ui-empty`): a glyph, a title, at most one quiet line and at most one action, centred (or at the start).
pub fn empty_state<'a, Message: 'a>(palette: &'static Palette, icon: Option<&'static str>, title: impl Into<String>, text: Option<String>, action: Option<Element<'a, Message>>, start: bool) -> Element<'a, Message> {
    let align = if start { Alignment::Start } else { Alignment::Center };
    let mut column: Vec<Element<'a, Message>> = Vec::new();
    if let Some(icon) = icon {
        column.push(super::icon(icon, scale::ICON_LG, palette.text_3).boxed());
    }
    column.push(words(title, TextStyle::from_role(&scale::TYPE_HEADING).tracking_em(scale::TRACKING_HEADING_EM), palette.text_1));
    if let Some(text) = text {
        column.push(words(text, TextStyle::from_role(&scale::TYPE_SMALL), palette.text_2));
    }
    if let Some(action) = action {
        column.push(container(action).padding(Padding { top: scale::SPACE_1, ..Padding::ZERO }).boxed());
    }
    let column = Column::with_children(column).spacing(scale::SPACE_2).align_x(align);
    let pad = Padding { top: scale::SPACE_6, right: if start { 0.0 } else { scale::SPACE_4 }, bottom: scale::SPACE_6, left: if start { 0.0 } else { scale::SPACE_4 } };
    container(column).width(Length::Fill).center_x(Length::Fill).padding(pad).boxed()
}

/// A split button (`.ui-split`): the action and, attached to it, a 24 px chevron that opens its settings. The two halves
/// share one hover and keep their own focus rings.
#[allow(clippy::too_many_arguments)] // Two halves with their ids, the glyph, two messages and the three states the owner holds.
pub fn split_button<'a, Message: Clone + 'a>(palette: &'static Palette, ids: (FocusId, FocusId), area: FocusArea, icon: &'static str, on_main: Message, on_more: Message, toggled: bool, hovered: bool, expanded: bool) -> Element<'a, Message> {
    let (main_side, more_width, height) = (scale::CONTROL_MD, scale::CONTROL_SM, scale::CONTROL_MD);
    let fill = if toggled { palette.accent_soft } else { palette.surface_hover };
    let tile = move |interaction: Interaction, base: bool| Look { fill: if toggled && base { Some(palette.accent_soft) } else if hovered || interaction != Interaction::Rest || (expanded && !base) { Some(fill) } else { None }, border: 1.0, ring: None, shadows: &[], radius: 0.0, opacity: 1.0, scale: 1.0 };
    let glyph = |ink: Rgba, size: f32, name: &'static str, wide: f32| -> Element<'a, Message> { container(super::icon(name, size, ink)).center_x(Length::Fixed(wide)).center_y(Length::Fixed(height)).boxed() };
    let glyph_stroked = |ink: Rgba, size: f32, name: &'static str, wide: f32| -> Element<'a, Message> { container(super::icon_stroked(name, size, ink, 2.0)).center_x(Length::Fixed(wide)).center_y(Length::Fixed(height)).boxed() };
    let ink = if toggled { palette.accent } else { palette.text_2 };
    let r = scale::RADIUS_MD;
    let main = Surface::new(glyph(ink, scale::ICON_LG, icon, main_side), move |interaction| Look { radius: r, ..tile(interaction, true) }).corners([r, 0.0, 0.0, r]).on_press_maybe(Some(on_main.clone())).width(Length::Fixed(main_side)).height(Length::Fixed(height));
    let more_ink = if expanded { palette.text_1 } else { palette.text_3 };
    let more = Surface::new(glyph_stroked(more_ink, scale::ICON_XS, "chevron-down", more_width), move |interaction| Look { radius: r, ..tile(interaction, false) }).corners([0.0, r, r, 0.0]).on_press_maybe(Some(on_more.clone())).width(Length::Fixed(more_width)).height(Length::Fixed(height));
    let main = Focusable::new(ids.0, area, main.boxed(), Ring::of(palette, scale::RADIUS_MD)).on_activate(on_main);
    let more = Focusable::new(ids.1, area, more.boxed(), Ring::of(palette, scale::RADIUS_MD)).on_activate(on_more);
    Row::with_children(vec![main.boxed(), more.boxed()]).align_y(Alignment::Center).boxed()
}
