//! The band's controls in their states: icon buttons, word buttons, the workspace segments and the mark
//! (`components/icon-button.css`, `button.css`, `segmented.css`, `dot.css`, `layout/topbar.css`).
//!
//! Hover is the shell's (`Shell::hover`), so a glyph changes colour with its background, as an SVG inside an iced button
//! cannot follow the button's status; pressed comes from the button.

use super::{Message, button_style, name_style};
use iced::widget::{button, container, mouse_area, row, text};
use iced::{Alignment, Background, Border, Color, Element, Length, Padding, Shadow, Theme as IcedTheme, Vector, Widget as _};
use styk_core::focus::{FocusArea, FocusId};
use styk_core::shell::band::SegmentContent;
use styk_core::shell::workspace::Workspace;
use styk_core::shell::{Event, Hover};
use styk_design::widgets::focus::{Focusable, Ring};
use styk_design::widgets::icon;
use styk_design::{BoxShadow, Rgba, Theme, tokens};

/// The opacity of a disabled control (`opacity: 0.42`).
const DISABLED: f32 = 0.42;

pub(crate) fn color(rgba: Rgba) -> Color {
    Color::from(rgba)
}

/// `colour` as a disabled control shows it.
pub(crate) fn faded(colour: Color, enabled: bool) -> Color {
    if enabled { colour } else { Color { a: colour.a * DISABLED, ..colour } }
}

/// A CSS shadow list as iced can draw it: the first hairline ring (`0 0 0 1px`) as a border and the first soft shadow as
/// the quad's shadow. iced has one shadow per quad and no spread: a shadow that shrinks (a negative spread) is drawn
/// smaller and fainter, and an inset highlight is not drawn.
pub(crate) fn elevation(layers: &[BoxShadow]) -> (Option<(Color, f32)>, Shadow) {
    let outer = || layers.iter().filter(|layer| !layer.inset);
    let ring = outer().find(|layer| layer.blur == 0.0 && layer.x == 0.0 && layer.y == 0.0 && layer.spread > 0.0).map(|layer| (color(layer.color), layer.spread));
    let soft = outer().find(|layer| layer.blur > 0.0).map_or(Shadow::default(), |layer| {
        let k = if layer.spread < 0.0 { 0.6 } else { 1.0 };
        let colour = color(layer.color);
        Shadow { color: Color { a: colour.a * k, ..colour }, offset: Vector::new(layer.x * k, layer.y * k), blur_radius: layer.blur * k }
    });
    (ring, soft)
}

/// The hover event for an area.
pub(crate) fn hover(target: Hover) -> Message {
    Message::Shell(Event::Hover(Some(target)))
}

/// The hover event that clears it.
pub(crate) fn unhover() -> Message {
    Message::Shell(Event::Hover(None))
}

/// How a pressable surface looks at rest, hot and while it is pressed.
#[derive(Clone, Copy)]
pub(crate) struct Surface {
    pub rest: Option<Color>,
    pub hot: Option<Color>,
    pub active: Option<Color>,
    pub border: Option<(Color, f32)>,
    pub shadow: Shadow,
    pub radius: f32,
}

/// A surface the pointer and the keyboard operate: a button in a focus target, hovering through the shell.
/// What a pressable surface does: the shell's hover target, the message a press sends (none: disabled) and its focus target.
pub(crate) struct Action {
    pub target: Hover,
    pub press: Option<Message>,
    pub focus: FocusId,
}

pub(crate) fn pressable(content: Element<'static, Message>, size: (f32, f32), surface: Surface, hovered: bool, action: Action, theme: Theme) -> Element<'static, Message> {
    let (width, height) = size;
    let Action { target, press, focus } = action;
    let enabled = press.is_some();
    let ring = Ring::of(theme.palette(), surface.radius);
    let face = button(content)
        .width(Length::Fixed(width))
        .height(Length::Fixed(height))
        .padding(0)
        .on_press_maybe(press.clone())
        .style(move |_: &IcedTheme, status| {
            let background = match status {
                button::Status::Pressed => surface.active.or(surface.hot).or(surface.rest),
                _ if hovered => surface.hot.or(surface.rest),
                _ => surface.rest,
            };
            let (border_color, border_width) = surface.border.unwrap_or((Color::TRANSPARENT, 0.0));
            button::Style { background: background.map(Background::Color), text_color: Color::TRANSPARENT, border: Border { color: border_color, width: border_width, radius: surface.radius.into() }, shadow: surface.shadow, snap: true }
        });
    let area = mouse_area(face).on_enter(hover(target)).on_exit(unhover());
    let mut focusable = Focusable::new(focus, FocusArea::TopBand, area.boxed(), ring).enabled(enabled);
    if let Some(press) = press {
        focusable = focusable.on_activate(press);
    }
    focusable.boxed()
}

/// An icon button (`.ui-icon-button`): a square with a glyph, ghost until hovered.
pub(crate) struct IconButton {
    pub name: &'static str,
    pub size: f32,
    pub glyph: f32,
    pub radius: f32,
    /// `aria-pressed`: a toggle that is on turns Styk blue on its soft tint.
    pub on: bool,
    /// `aria-expanded`: an open menu button keeps its pressed tile.
    pub expanded: bool,
    pub enabled: bool,
    pub hovered: bool,
    pub target: Hover,
    pub press: Message,
    pub focus: FocusId,
    pub theme: Theme,
}

pub(crate) fn icon_button(button: IconButton) -> Element<'static, Message> {
    let palette = button.theme.palette();
    let (rest, hot, active, fg, fg_hot) = if button.on {
        (Some(color(palette.accent_soft)), Some(color(palette.accent_soft_hover)), Some(color(palette.accent_soft_hover)), color(palette.accent), color(palette.accent_text))
    } else if button.expanded {
        (Some(color(palette.surface_pressed)), Some(color(palette.surface_pressed)), Some(color(palette.surface_pressed)), color(palette.text_1), color(palette.text_1))
    } else {
        (None, Some(color(palette.surface_hover)), Some(color(palette.surface_pressed)), color(palette.text_2), color(palette.text_1))
    };
    let enabled = button.enabled;
    let hovered = button.hovered && enabled;
    let surface = Surface { rest: rest.map(|c| faded(c, enabled)), hot: hot.map(|c| faded(c, enabled)), active: active.map(|c| faded(c, enabled)), border: None, shadow: Shadow::default(), radius: button.radius };
    let glyph = icon(button.name, button.glyph, faded(if hovered { fg_hot } else { fg }, enabled));
    let face = container(glyph).center_x(Length::Fixed(button.size)).center_y(Length::Fixed(button.size));
    pressable(face.boxed(), (button.size, button.size), surface, hovered, Action { target: button.target, press: enabled.then_some(button.press), focus: button.focus }, button.theme)
}

/// Which button of the design system.
#[derive(Clone, Copy)]
pub(crate) enum Tone {
    /// The ink pill: the one main action.
    Primary,
    /// No fill until hover.
    Ghost,
}

/// A pill button with a glyph and a word (`.ui-button`), or the glyph alone once the band folds the word.
pub(crate) struct WordButton {
    pub tone: Tone,
    pub label: &'static str,
    pub glyph: Option<&'static str>,
    pub folded: bool,
    pub width: f32,
    pub height: f32,
    pub hovered: bool,
    pub target: Hover,
    pub press: Message,
    pub focus: FocusId,
    pub theme: Theme,
}

/// The button's glyph size inside the band (`--icon-size: 15px`).
const BUTTON_GLYPH: f32 = 15.0;

pub(crate) fn word_button(button: WordButton) -> Element<'static, Message> {
    let palette = button.theme.palette();
    let radius = button.height / 2.0;
    let (surface, fg) = match button.tone {
        Tone::Primary => (
            Surface { rest: Some(color(palette.primary)), hot: Some(color(palette.primary_hover)), active: Some(color(palette.primary_pressed)), border: None, shadow: elevation(palette.primary_shadow).1, radius },
            color(palette.on_primary),
        ),
        Tone::Ghost => (Surface { rest: None, hot: Some(color(palette.surface_hover)), active: Some(color(palette.surface_pressed)), border: None, shadow: Shadow::default(), radius }, color(palette.text_1)),
    };
    let glyph = button.glyph.map(|name| icon(name, BUTTON_GLYPH, fg));
    let style = button_style();
    let label = text(button.label).font(style.font).size(style.size).line_height(style.line()).color(fg);
    let content: Element<'static, Message> = match (glyph, button.folded) {
        (Some(glyph), true) => glyph.boxed(),
        (Some(glyph), false) => row![glyph, label].spacing(tokens::scale::SPACE_1_5).align_y(Alignment::Center).boxed(),
        (None, _) => label.boxed(),
    };
    let face = container(content).center_x(Length::Fixed(button.width)).center_y(Length::Fixed(button.height));
    pressable(face.boxed(), (button.width, button.height), surface, button.hovered, Action { target: button.target, press: Some(button.press), focus: button.focus }, button.theme)
}

/// One segment of the workspace switch (`.ui-segmented-item` in `.workspace-switch`).
pub(crate) struct Segment {
    pub workspace: Workspace,
    pub label: &'static str,
    pub content: SegmentContent,
    pub width: f32,
    pub height: f32,
    pub pressed: bool,
    pub hovered: bool,
    pub focus: FocusId,
    pub theme: Theme,
}

/// A workspace's colour: its dot, and the soft tint of its pill while it is the current one.
fn tint(palette: &tokens::Palette, workspace: Workspace) -> (Color, Color) {
    match workspace {
        Workspace::Animate => (color(palette.mode_animate), color(palette.tint_select_soft)),
        Workspace::Draw => (color(palette.mode_draw), color(palette.tint_draw_soft)),
        Workspace::Build => (color(palette.mode_build), color(palette.tint_library_soft)),
    }
}

/// The ring a pressed dot shows is 3 px on each side; the slot that holds it takes the room the ring needs, and the
/// padding beside it gives that room back so the segment keeps its width.
const DOT: f32 = 7.0;
const RING: f32 = 3.0;

fn glyph_of(workspace: Workspace) -> &'static str {
    match workspace {
        Workspace::Animate => "ws-animate",
        Workspace::Draw => "ws-draw",
        Workspace::Build => "ws-build",
    }
}

pub(crate) fn segment(segment: Segment) -> Element<'static, Message> {
    let palette = segment.theme.palette();
    let (mode, soft) = tint(palette, segment.workspace);
    let hot = segment.hovered && !segment.pressed;
    let fg = if segment.pressed || hot { color(palette.text_1) } else { color(palette.text_2) };
    // The band's own rule: the pressed segment is the surface with the thumb's shadow (`features/band.css`).
    let (rest, border, shadow_layer) = if segment.pressed {
        let (ring, soft) = elevation(palette.shadow_thumb);
        (Some(color(palette.surface)), ring, soft)
    } else {
        (None, None, Shadow::default())
    };
    let radius = segment.height / 2.0;
    let surface = Surface { rest, hot: rest, active: rest, border, shadow: shadow_layer, radius };
    let space = tokens::scale::SPACE_2;
    let content: Element<'static, Message> = match segment.content {
        SegmentContent::DotAndName => {
            let style = name_style();
            let dot_color = Color { a: if segment.pressed { 1.0 } else { 0.5 }, ..mode };
            let dot = container(container(iced::widget::space()).width(DOT).height(DOT).style(move |_| container::Style::default().background(dot_color).border(Border { radius: (DOT / 2.0).into(), ..Border::default() })))
                .center(DOT + 2.0 * RING)
                .style(move |_| container::Style::default().background(if segment.pressed { soft } else { Color::TRANSPARENT }).border(Border { radius: ((DOT + 2.0 * RING) / 2.0).into(), ..Border::default() }));
            let label = text(segment.label).font(style.font).size(style.size).line_height(style.line()).color(fg);
            let pad = Padding { top: 0.0, bottom: 0.0, left: 1.0 + tokens::scale::SPACE_3 - RING, right: 1.0 + 16.0 };
            container(row![dot, label].spacing(space - RING).align_y(Alignment::Center)).padding(pad).center_y(Length::Fixed(segment.height)).boxed()
        }
        SegmentContent::Name => {
            let style = name_style();
            let label = text(segment.label).font(style.font).size(style.size).line_height(style.line()).color(fg);
            container(label).center_x(Length::Fixed(segment.width)).center_y(Length::Fixed(segment.height)).boxed()
        }
        SegmentContent::Glyph => {
            let glyph_color = if segment.pressed { color(palette.accent_text) } else { fg };
            container(icon(glyph_of(segment.workspace), 17.0, glyph_color)).center_x(Length::Fixed(segment.width)).center_y(Length::Fixed(segment.height)).boxed()
        }
    };
    let action = Action { target: Hover::Workspace(segment.workspace), press: Some(Message::Shell(Event::Workspace(segment.workspace))), focus: segment.focus };
    pressable(content, (segment.width, segment.height), surface, segment.hovered, action, segment.theme)
}
