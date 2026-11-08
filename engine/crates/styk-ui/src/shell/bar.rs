//! The top band: every item of `styk_core::shell::band::Layout` at the frame it gives.
//!
//! The band is a row of fixed-width items with spacers between them, so each lands where the solver put it; the gaps
//! are what the solver left, and a dragged tab's drop line sits in the gap beside the tab it would land next to.

use super::controls::{self, IconButton, Segment, Tone, WordButton, color};
use super::{Message, Params, strip, text};
use styk_core::i18n::Label;
use crate::band::{Controls, Hot, window_controls};
use iced::widget::{container, pin, row, space, stack, svg};
use iced::{Alignment, Border, Element, Length, Padding, Widget as _};
use styk_core::shell::band::{ButtonShape, Fold, Frame, Item, SegmentContent};
use styk_core::shell::session::ExportLook;
use styk_core::shell::strip::Side;
use styk_core::shell::workspace::Workspace;
use styk_core::shell::{Event, Hover, Menu, ids};
use styk_design::widgets::icon;
use styk_design::tokens;

/// The StykAnimate symbol the mark shows (`symbol.svg`).
const SYMBOL: &[u8] = include_bytes!("../../../../../symbol.svg");

/// The drop line's width and height (`.project-tab[data-drop]::after`: 2 px wide, inset 6 px above and below a 36 px tab).
const LINE: f32 = 2.0;
const LINE_HEIGHT: f32 = 24.0;

fn name_of(workspace: Workspace) -> Label {
    match workspace {
        Workspace::Animate => text::ANIMATE,
        Workspace::Draw => text::DRAW,
        Workspace::Build => text::BUILD,
    }
}

/// A gap of `width` as a spacer.
fn gap(width: f32) -> Vec<Element<'static, Message>> {
    if width <= 0.0 { Vec::new() } else { vec![space().width(width).boxed()] }
}

/// The tab strip (`.project-tabs`): the tabs and New at their offsets inside it, clipped to it. A tab that cannot shrink
/// further runs under New, as it does in the page, so the items are pinned and not laid in a row.
fn strip_element(params: &Params<'_>) -> Option<Element<'static, Message>> {
    let shell = params.shell;
    let theme = params.theme;
    let layout = shell.layout();
    let hover = shell.hover();
    let strip = layout.strip;
    let mut layers: Vec<Element<'static, Message>> = Vec::new();
    for placed in &layout.items {
        let frame = placed.frame;
        match placed.item {
            Item::Tab(id, look) => {
                let Some(view) = shell.tabs().iter().find(|tab| tab.id == id) else { continue };
                layers.push(pin(strip::tab(view, look, frame, hover, theme)).x(frame.x - strip.x).y(frame.y - strip.y).boxed());
                // The line a dragged tab would land beside, in the gap next to this one.
                let line_x = match view.drop {
                    Some(Side::Before) => Some(frame.x - strip.x - LINE),
                    Some(Side::After) => Some(frame.right() - strip.x),
                    None => None,
                };
                if let Some(x) = line_x {
                    let accent = color(theme.palette().accent_line);
                    let line = container(space()).width(LINE).height(LINE_HEIGHT).style(move |_| container::Style::default().background(accent).border(Border { radius: 1.0.into(), ..Border::default() }));
                    layers.push(pin(line).x(x).y(frame.y - strip.y + (frame.height - LINE_HEIGHT) / 2.0).boxed());
                }
            }
            Item::AddTab => {
                let button = controls::icon_button(IconButton { name: "plus", size: frame.width, glyph: tokens::scale::ICON_MD, radius: tokens::scale::RADIUS_SM, on: false, expanded: false, enabled: true, hovered: hover == Some(Hover::AddTab), target: Hover::AddTab, press: Message::Shell(Event::New), focus: ids::ADD, theme });
                layers.push(pin(button).x(frame.x - strip.x).y(frame.y - strip.y).boxed());
            }
            _ => {}
        }
    }
    if layers.is_empty() {
        return None;
    }
    Some(container(stack(layers)).width(Length::Fixed(strip.width)).height(Length::Fixed(strip.height)).clip(true).boxed())
}

pub(crate) fn view(params: &Params<'_>) -> Element<'static, Message> {
    let shell = params.shell;
    let theme = params.theme;
    let palette = theme.palette();
    let layout = shell.layout();
    let hover = shell.hover();
    let hovered = |target: Hover| hover == Some(target);
    let history = shell.history();
    let height = layout.height;
    let glyphs = layout.segments == SegmentContent::Glyph;
    let md = tokens::scale::RADIUS_MD;

    let mut parts: Vec<Element<'static, Message>> = Vec::new();
    let mut cursor = 0.0_f32;
    let mut track_done = false;
    let mut strip = strip_element(params);

    for placed in &layout.items {
        let frame: Frame = placed.frame;
        let item = &placed.item;
        let (start, element, right): (f32, Element<'static, Message>, f32) = match *item {
            Item::Mark => {
                let expanded = shell.menu() == Some(Menu::Mark);
                let hot = hovered(Hover::Mark) || expanded;
                let tile = color(palette.surface_hover);
                let surface = controls::Surface { rest: expanded.then_some(tile), hot: Some(tile), active: Some(tile), border: None, shadow: iced::Shadow::default(), radius: md };
                let (left, end) = if glyphs { (tokens::scale::SPACE_1, tokens::scale::SPACE_0_5) } else { (tokens::scale::SPACE_1_5, tokens::scale::SPACE_1) };
                let picture = svg(svg::Handle::from_memory(SYMBOL)).width(22.0).height(22.0);
                let chevron = icon("chevronDown", 12.0, color(palette.text_3));
                let content = container(row![picture, chevron].spacing(tokens::scale::SPACE_0_5).align_y(Alignment::Center)).padding(Padding { left, right: end, ..Padding::ZERO }).center_y(Length::Fixed(frame.height));
                (frame.x, controls::pressable(content.boxed(), (frame.width, frame.height), surface, hot, controls::Action { target: Hover::Mark, press: Some(Message::Shell(Event::Mark)), focus: ids::MARK }, theme), frame.right())
            }
            Item::Home => (
                frame.x,
                controls::icon_button(IconButton { name: "home", size: frame.width, glyph: tokens::scale::ICON_LG, radius: md, on: shell.home(), expanded: false, enabled: true, hovered: hovered(Hover::Home), target: Hover::Home, press: Message::Shell(Event::Home), focus: ids::HOME, theme }),
                frame.right(),
            ),
            Item::Tab(..) | Item::AddTab => match strip.take() {
                Some(element) => (layout.strip.x, element, layout.strip.right()),
                None => continue,
            },
            Item::Workspace(_) => {
                if track_done {
                    continue;
                }
                track_done = true;
                let segments: Vec<Element<'static, Message>> = layout
                    .items
                    .iter()
                    .filter_map(|p| match p.item {
                        Item::Workspace(workspace) => Some(controls::segment(Segment {
                            workspace,
                            label: params.presentation.label(&name_of(workspace)),
                            content: layout.segments,
                            width: p.frame.width,
                            height: p.frame.height,
                            pressed: shell.pressed() == Some(workspace),
                            hovered: hovered(Hover::Workspace(workspace)),
                            focus: ids::workspace(workspace),
                            theme,
                        })),
                        _ => None,
                    })
                    .collect();
                let well = color(palette.surface_well);
                let track = layout.track;
                let element = container(row(segments).spacing(tokens::scale::SPACE_0_5).align_y(Alignment::Center))
                    .padding(3.0)
                    .width(Length::Fixed(track.width))
                    .height(Length::Fixed(track.height))
                    .style(move |_| container::Style::default().background(well).border(Border { radius: (track.height / 2.0).into(), ..Border::default() }))
                    .boxed();
                (track.x, element, track.right())
            }
            Item::Undo | Item::Redo => {
                let undo = matches!(item, Item::Undo);
                let (name, event, enabled, target, focus) = if undo { ("undo", Event::Undo, history.undo, Hover::Undo, ids::UNDO) } else { ("redo", Event::Redo, history.redo, Hover::Redo, ids::REDO) };
                (frame.x, controls::icon_button(IconButton { name, size: frame.width, glyph: tokens::scale::ICON_LG, radius: md, on: false, expanded: false, enabled, hovered: hovered(target), target, press: Message::Shell(event), focus, theme }), frame.right())
            }
            Item::Save => (
                frame.x,
                controls::icon_button(IconButton { name: "save", size: frame.width, glyph: tokens::scale::ICON_LG, radius: md, on: false, expanded: false, enabled: history.open, hovered: hovered(Hover::Save), target: Hover::Save, press: Message::Shell(Event::Save), focus: ids::SAVE, theme }),
                frame.right(),
            ),
            Item::Properties => (
                frame.x,
                controls::icon_button(IconButton { name: "inspector", size: frame.width, glyph: tokens::scale::ICON_LG, radius: md, on: false, expanded: false, enabled: true, hovered: hovered(Hover::Properties), target: Hover::Properties, press: Message::Shell(Event::Properties), focus: ids::PROPERTIES, theme }),
                frame.right(),
            ),
            Item::Export(look, shape) => (
                frame.x,
                controls::word_button(WordButton {
                    tone: if look == ExportLook::Primary { Tone::Primary } else { Tone::Ghost },
                    label: params.presentation.label(&text::EXPORT),
                    glyph: Some("export"),
                    folded: shape == ButtonShape::Glyph,
                    width: frame.width,
                    height: frame.height,
                    hovered: hovered(Hover::Export),
                    target: Hover::Export,
                    press: Message::Shell(Event::Export),
                    focus: ids::EXPORT,
                    theme,
                }),
                frame.right(),
            ),
            Item::Cancel => (
                frame.x,
                controls::word_button(WordButton { tone: Tone::Ghost, label: params.presentation.label(&text::CANCEL), glyph: None, folded: false, width: frame.width, height: frame.height, hovered: hovered(Hover::Cancel), target: Hover::Cancel, press: Message::Shell(Event::Cancel), focus: ids::CANCEL, theme }),
                frame.right(),
            ),
            Item::TestRig(shape) => (
                frame.x,
                controls::word_button(WordButton { tone: Tone::Ghost, label: params.presentation.label(&text::TEST_RIG), glyph: Some("test-rig"), folded: shape == ButtonShape::Glyph, width: frame.width, height: frame.height, hovered: hovered(Hover::TestRig), target: Hover::TestRig, press: Message::Shell(Event::TestRig), focus: ids::TEST_RIG, theme }),
                frame.right(),
            ),
            Item::Done(done, shape) => (
                frame.x,
                controls::word_button(WordButton { tone: Tone::Primary, label: params.presentation.label(&text::DONE), glyph: Some("check"), folded: shape == ButtonShape::Glyph, width: frame.width, height: frame.height, hovered: hovered(Hover::Done(done)), target: Hover::Done(done), press: Message::Shell(Event::Done(done)), focus: ids::DONE, theme }),
                frame.right(),
            ),
            Item::Minimize => {
                let folded = layout.folds.contains(&Fold::WinCtl);
                let controls = Controls {
                    theme,
                    folded,
                    height: frame.height,
                    maximize: params.maximize,
                    hover: match hover {
                        Some(Hover::Minimize) => Some(Hot::Minimize),
                        Some(Hover::Close) => Some(Hot::Close),
                        _ => None,
                    },
                };
                let fold = |hot: Option<Hot>| {
                    Message::Shell(Event::Hover(hot.map(|hot| match hot {
                        Hot::Minimize => Hover::Minimize,
                        Hot::Close => Hover::Close,
                    })))
                };
                let right = layout.items.iter().rev().find(|p| matches!(p.item, Item::Close)).map_or(frame.right(), |p| p.frame.right());
                (frame.x, window_controls(controls, Message::Minimize, Message::CloseWindow, fold), right)
            }
            // The maximize and close controls are drawn with the row Minimize starts.
            Item::Maximize | Item::Close => continue,
        };
        parts.extend(gap(start - cursor));
        parts.push(element);
        cursor = right;
    }

    let surface = color(palette.surface);
    let line = color(palette.line_1);
    let band = container(row(parts).align_y(Alignment::Center).height(Length::Fixed(height))).width(Length::Fill).height(Length::Fixed(height)).style(move |_| container::Style::default().background(surface));
    // `box-shadow: inset 0 -1px 0 var(--line-1)`: a line over the band's last pixel row.
    let rule = container(container(space()).width(Length::Fill).height(Length::Fixed(1.0)).style(move |_| container::Style::default().background(line))).width(Length::Fill).height(Length::Fixed(height)).align_bottom(Length::Fixed(height));
    stack![band, rule].boxed()
}
