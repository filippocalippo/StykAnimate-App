//! Badges and chips: the small tinted tile that names a section, and the pill that filters or toggles in a catalogue.

use iced::Widget as _;
use super::control::{DISABLED, Interaction, Preview, words};
use super::focus::{Focusable, Ring};
use super::surface::{Look, Surface};
use crate::tokens::scale;
use crate::typography::TextStyle;
use crate::{Palette, Rgba};
use iced::widget::{Row, container};
use iced::{Alignment, Background, Border, Element, Length, Padding};
use styk_core::focus::{FocusArea, FocusId};

/// The concepts that have a tint (`--tint-*`): the colour a part of the interface carries wherever it appears.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tint {
    Select,
    Draw,
    Time,
    Library,
    Camera,
    Effects,
}

impl Tint {
    /// The soft background and the ink on it.
    pub fn colors(self, palette: &Palette) -> (Rgba, Rgba) {
        match self {
            Tint::Select => (palette.tint_select_soft, palette.tint_select_ink),
            Tint::Draw => (palette.tint_draw_soft, palette.tint_draw_ink),
            Tint::Time => (palette.tint_time_soft, palette.tint_time_ink),
            Tint::Library => (palette.tint_library_soft, palette.tint_library_ink),
            Tint::Camera => (palette.tint_camera_soft, palette.tint_camera_ink),
            Tint::Effects => (palette.tint_fx_soft, palette.tint_fx_ink),
        }
    }
}

/// A section's badge: a 22 px tile of the tint's soft colour with a 14 px glyph in its ink.
pub fn badge<'a, Message: 'a>(palette: &'static Palette, icon: &'static str, tint: Tint) -> Element<'a, Message> {
    let (soft, ink) = tint.colors(palette);
    container(super::icon(icon, scale::ICON_SM, ink))
        .center_x(Length::Fixed(22.0))
        .center_y(Length::Fixed(22.0))
        .style(move |_| container::Style { background: Some(Background::Color(soft.into())), border: Border { radius: scale::RADIUS_XS.into(), ..Border::default() }, ..container::Style::default() })
        .boxed()
}

/// A chip: a 32 px pill on the well (`--control-md`) in `--type-small-strong`. A button chip toggles (`aria-pressed`) and reads as the
/// accent's soft tint with a hairline when on; one without a press is a label.
pub struct Chip<'a, Message> {
    id: FocusId,
    area: FocusArea,
    palette: &'static Palette,
    label: String,
    icon: Option<&'static str>,
    on: bool,
    disabled: bool,
    on_press: Option<Message>,
    preview: Option<Preview>,
    _marker: std::marker::PhantomData<&'a ()>,
}

impl<'a, Message: Clone + 'a> Chip<'a, Message> {
    /// A chip that sends `on_press` (a toggle).
    pub fn new(id: FocusId, area: FocusArea, palette: &'static Palette, label: impl Into<String>, on_press: Message) -> Self {
        Chip { id, area, palette, label: label.into(), icon: None, on: false, disabled: false, on_press: Some(on_press), preview: None, _marker: std::marker::PhantomData }
    }

    pub fn icon(mut self, icon: &'static str) -> Self {
        self.icon = Some(icon);
        self
    }

    /// `aria-pressed="true"`.
    pub fn on(mut self, on: bool) -> Self {
        self.on = on;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn preview(mut self, preview: Option<Preview>) -> Self {
        self.preview = preview;
        self
    }

    pub fn into_element(self) -> Element<'a, Message> {
        let Chip { id, area, palette, label, icon, on, disabled, on_press, preview, .. } = self;
        let height = scale::CONTROL_MD;
        let opacity = if disabled { DISABLED } else { 1.0 };
        let ink = if on { palette.accent_text } else { palette.text_1 }.faded(opacity);
        let mut parts: Vec<Element<'a, Message>> = Vec::new();
        if let Some(icon) = icon {
            parts.push(super::icon(icon, scale::ICON_SM, ink).boxed());
        }
        parts.push(words(label, TextStyle::from_role(&scale::TYPE_SMALL_STRONG), ink));
        let line = Row::with_children(parts).spacing(scale::SPACE_1).align_y(Alignment::Center);
        let face = container(line).height(Length::Fixed(height)).center_y(Length::Fixed(height)).padding(Padding { top: 0.0, right: scale::SPACE_3 + 1.0, bottom: 0.0, left: scale::SPACE_3 + 1.0 });
        let radius = height / 2.0;
        let look = move |interaction: Interaction| {
            let hovered = !disabled && interaction != Interaction::Rest;
            let fill = if on { palette.accent_soft } else if hovered { palette.surface_pressed } else { palette.surface_well };
            Look { fill: Some(fill), border: 1.0, ring: on.then_some((1.0, palette.accent_line)), shadows: &[], radius, opacity, scale: 1.0 }
        };
        let message = on_press.filter(|_| !disabled);
        let surface = Surface::new(face.boxed(), look).on_press_maybe(message.clone()).preview(preview).height(Length::Fixed(height));
        let mut target = Focusable::new(id, area, surface.boxed(), Ring::of(palette, radius)).enabled(!disabled).ring_shown(preview == Some(Preview::Focus));
        if let Some(message) = message {
            target = target.on_activate(message);
        }
        target.boxed()
    }
}
