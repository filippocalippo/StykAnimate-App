//! Segmented control (`segmented.css`): a pill track with a thumb under the chosen item. Two to four options; five or
//! more is a select.
//!
//! The group is one Tab stop (the chosen item) and the arrow keys move to the next item and choose it, as a radio group
//! does (`roving::RovingGroup`, `styk_core::roving`). A group of radios declares the radio role; a group of buttons (a mode
//! switch) none.

use iced::Widget as _;
use super::control::{DISABLED, Interaction, Preview, words};
use super::dir::Dir;
use super::focus::Ring;
use super::roving::{RovingGroup, RovingItem};
use super::surface::{Look, Surface};
use crate::tokens::scale;
use crate::typography::TextStyle;
use crate::Palette;
use iced::widget::{Row, container};
use iced::{Alignment, Element, Length, Padding};
use styk_core::focus::{FocusArea, FocusId, InputRole};
use styk_core::roving::Orientation;

/// The track's sizes (`data-size`): `sm` sets the items' words smaller; `lg` is a 36 px track.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SegmentSize {
    /// A 32 px track, `--type-ui-strong` words.
    #[default]
    Md,
    /// A 32 px track, `--type-small-strong` words and tighter padding.
    Sm,
    /// A 36 px track.
    Lg,
}

/// One option.
pub struct Segment {
    pub label: Option<String>,
    pub icon: Option<&'static str>,
    pub disabled: bool,
}

impl Segment {
    /// An option with words.
    pub fn text(label: impl Into<String>) -> Segment {
        Segment { label: Some(label.into()), icon: None, disabled: false }
    }

    /// An icon-only option.
    pub fn icon(icon: &'static str) -> Segment {
        Segment { label: None, icon: Some(icon), disabled: false }
    }

    pub fn with_icon(mut self, icon: &'static str) -> Segment {
        self.icon = Some(icon);
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Segment {
        self.disabled = disabled;
        self
    }
}

/// The segmented control. Item `i` is the focus target `FocusId(first.0 + i)`.
pub struct Segmented<'a, Message> {
    first: FocusId,
    area: FocusArea,
    palette: &'static Palette,
    items: Vec<Segment>,
    chosen: usize,
    size: SegmentSize,
    fill: bool,
    dir: Dir,
    radios: bool,
    on_choose: Box<dyn Fn(usize) -> Message + 'a>,
    preview: Option<(usize, Preview)>,
}

impl<'a, Message: Clone + 'a> Segmented<'a, Message> {
    /// A group of radios: `on_choose(index)` is sent when an item is pressed or an arrow key moves to it.
    pub fn new(first: FocusId, area: FocusArea, palette: &'static Palette, items: Vec<Segment>, chosen: usize, on_choose: impl Fn(usize) -> Message + 'a) -> Self {
        Segmented { first, area, palette, items, chosen, size: SegmentSize::Md, fill: false, dir: Dir::Ltr, radios: true, on_choose: Box::new(on_choose), preview: None }
    }

    /// A group of buttons that stay pressed (`aria-pressed`: the workspace switch, the timeline mode): not radios to the
    /// shortcut routing.
    pub fn buttons(mut self) -> Self {
        self.radios = false;
        self
    }

    pub fn size(mut self, size: SegmentSize) -> Self {
        self.size = size;
        self
    }

    /// The items share the row equally (`data-fill`).
    pub fn fill(mut self, fill: bool) -> Self {
        self.fill = fill;
        self
    }

    pub fn dir(mut self, dir: Dir) -> Self {
        self.dir = dir;
        self
    }

    /// Holds a state of one item fixed.
    pub fn preview(mut self, item: usize, preview: Preview) -> Self {
        self.preview = Some((item, preview));
        self
    }

    /// The track's height.
    pub fn height(size: SegmentSize) -> f32 {
        if size == SegmentSize::Lg { scale::CONTROL_LG } else { scale::CONTROL_MD }
    }

    pub fn into_element(self) -> Element<'a, Message> {
        let Segmented { first, area, palette, items, chosen, size, fill, dir, radios, on_choose, preview } = self;
        let track = Self::height(size);
        let item_height = track - 2.0 * scale::SPACE_0_5;
        let radius = item_height / 2.0;
        let style = TextStyle::from_role(if size == SegmentSize::Sm { &scale::TYPE_SMALL_STRONG } else { &scale::TYPE_UI_STRONG });
        let choose = std::sync::Arc::new(on_choose);
        let roving: Vec<RovingItem<'a, Message>> = items
            .into_iter()
            .enumerate()
            .map(|(index, item)| {
                let on = index == chosen;
                let icon_only = item.label.is_none();
                let padding = if icon_only {
                    scale::SPACE_2
                } else if fill {
                    scale::SPACE_1_5
                } else if size == SegmentSize::Sm {
                    scale::SPACE_2_5
                } else {
                    scale::SPACE_3
                };
                let glyph = if icon_only { scale::ICON_SM } else { scale::ICON_MD };
                let opacity = if item.disabled { DISABLED } else { 1.0 };
                let face = |ink: crate::Rgba| -> Element<'a, Message> {
                    let ink = ink.faded(opacity);
                    let mut parts: Vec<Element<'a, Message>> = Vec::new();
                    if let Some(icon) = item.icon {
                        parts.push(super::icon(icon, glyph, ink).boxed());
                    }
                    if let Some(label) = &item.label {
                        parts.push(words(label.clone(), style, ink));
                    }
                    let line = Row::with_children(parts).spacing(scale::SPACE_1_5).align_y(Alignment::Center);
                    let content = container(line).padding(Padding { top: 0.0, right: padding + 1.0, bottom: 0.0, left: padding + 1.0 }).height(Length::Fixed(item_height)).center_y(Length::Fixed(item_height));
                    // The item's 1 px transparent border is inside its padding; words centre in a filled item.
                    if fill { container(content).center_x(Length::Fill).boxed() } else { container(content).width(Length::Shrink).boxed() }
                };
                let held = preview.filter(|(at, _)| *at == index).map(|(_, preview)| preview);
                let look = move |_: Interaction| {
                    if on {
                        Look { fill: Some(palette.control_thumb), border: 1.0, ring: Some((1.0, palette.line_control)), shadows: palette.elevation_1, radius, opacity }
                    } else {
                        Look { fill: None, border: 1.0, ring: None, shadows: &[], radius, opacity }
                    }
                };
                let rest_ink = if on { palette.text_1 } else { palette.text_2 };
                let message = (!item.disabled).then(|| choose(index));
                let mut surface = Surface::new(face(rest_ink), look).on_press_maybe(message.clone()).preview(held).height(Length::Fixed(item_height));
                if fill {
                    surface = surface.width(Length::Fill);
                }
                if !on {
                    surface = surface.hover_face(face(palette.text_1));
                }
                RovingItem { id: FocusId(first.0 + index as u64), content: surface.boxed(), enabled: !item.disabled, on_activate: message }
            })
            .collect();
        let ring = Ring { offset: 0.0, ..Ring::of(palette, radius) };
        let on_move = choose.clone();
        let group = RovingGroup::new(area, roving, chosen, ring, move |index| on_move(index))
            .orientation(Orientation::Horizontal)
            .dir(dir)
            .spacing(scale::SPACE_0_5)
            .input_role(if radios { InputRole::Radio } else { InputRole::None })
            .width(if fill { Length::Fill } else { Length::Shrink })
            .into_element();
        let track_width = if fill { Length::Fill } else { Length::Shrink };
        container(group)
            .padding(scale::SPACE_0_5)
            .width(track_width)
            .height(Length::Fixed(track))
            .style(move |_| container::Style { background: Some(iced::Background::Color(palette.surface_well.into())), border: iced::Border { radius: (track / 2.0).into(), ..Default::default() }, ..Default::default() })
            .boxed()
    }
}
