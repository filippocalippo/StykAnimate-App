//! Buttons (`button.css`, `icon-button.css`): the text pill with its optional glyph, and the icon-only tile.
//!
//! A button reports one message; what it does is the owner's. Both are focus targets (Enter, or Space on release, press
//! them) and draw rest, hover, pressed, toggled-on, disabled and the focus ring. Colours, sizes and radii are tokens.

use iced::Widget as _;
use super::control::{DISABLED, Interaction, Preview, pill, words};
use super::focus::{Focusable, Ring};
use super::surface::{Look, Surface};
use crate::tokens::scale;
use crate::typography::TextStyle;
use crate::{Palette, Rgba};
use iced::widget::{Row, container};
use iced::{Alignment, Element, Length, Padding};
use styk_core::focus::{FocusArea, FocusId};

/// The text button's variants (`data-variant`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Variant {
    /// The everyday secondary button on the mist fill.
    #[default]
    Soft,
    /// The ink pill: the one main action of a surface.
    Primary,
    /// Vivid blue: the chosen pill in a row of choices.
    Accent,
    /// No fill until hover: row actions.
    Ghost,
    /// White with a hairline: a secondary action on a tinted surface.
    Outline,
    /// Red: a destructive confirm.
    Danger,
}

/// The text button's sizes (`data-size`): 28, 32 and 36 px.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Size {
    Sm,
    #[default]
    Md,
    Lg,
}

impl Size {
    fn height(self) -> f32 {
        match self {
            Size::Sm => scale::CONTROL_SM,
            Size::Md => scale::CONTROL_MD,
            Size::Lg => scale::CONTROL_LG,
        }
    }

    /// `--_px`: the padding either side of the words.
    fn padding(self) -> f32 {
        match self {
            Size::Sm => 11.0,
            Size::Md => 14.0,
            Size::Lg => 18.0,
        }
    }

    fn glyph(self) -> f32 {
        if self == Size::Sm { scale::ICON_SM } else { scale::ICON_MD }
    }

    fn gap(self) -> f32 {
        match self {
            Size::Sm => scale::SPACE_1,
            Size::Md => scale::SPACE_1_5,
            Size::Lg => scale::SPACE_2,
        }
    }
}

/// Who a button's words are set as.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Words {
    /// `--type-button`, Inter Tight 650.
    #[default]
    Button,
    /// `.ui-section-action.ui-button`: `--type-small-strong` in the quiet ink, 8 px either side.
    SectionAction,
}

/// The colours of one variant in each interaction.
struct Colors {
    fill: [Option<Rgba>; 3],
    ink: [Rgba; 3],
    ring: Option<(f32, Rgba)>,
    lift: &'static [crate::BoxShadow],
}

fn colors(palette: &Palette, variant: Variant, danger: bool, toggled: bool, words: Words) -> Colors {
    let mix = |color: Rgba, percent: f32| color.mix(percent, palette.text_1);
    let (mut fill, mut ink, ring, lift): ([Option<Rgba>; 3], Rgba, _, _) = match variant {
        Variant::Soft => ([Some(palette.control_soft), Some(palette.control_soft_hover), Some(palette.control_soft_pressed)], palette.text_1, None, &[][..]),
        Variant::Primary => ([Some(palette.primary), Some(palette.primary_hover), Some(palette.primary_pressed)], palette.on_primary, None, palette.primary_shadow),
        Variant::Accent => ([Some(palette.accent_strong), Some(mix(palette.accent_strong, 88.0)), Some(mix(palette.accent_strong, 80.0))], palette.text_on_strong, None, &[][..]),
        Variant::Ghost => ([None, Some(palette.surface_hover), Some(palette.surface_pressed)], palette.text_1, None, &[][..]),
        Variant::Outline => ([Some(palette.surface), Some(palette.surface_hover), Some(palette.surface_pressed)], palette.text_1, Some((1.0, palette.line_2)), &[][..]),
        Variant::Danger => ([Some(palette.danger_strong), Some(mix(palette.danger_strong, 88.0)), Some(mix(palette.danger_strong, 80.0))], palette.on_danger, None, &[][..]),
    };
    let mut hover_ink = ink;
    if words == Words::SectionAction {
        ink = palette.text_2;
        hover_ink = palette.text_1;
    }
    if danger && matches!(variant, Variant::Ghost | Variant::Outline) {
        ink = palette.danger_text;
        hover_ink = palette.danger_text;
        fill[1] = Some(palette.danger_soft);
        fill[2] = Some(palette.danger_soft);
    }
    if toggled && variant != Variant::Accent {
        fill = [Some(palette.accent_soft), Some(palette.accent_soft_hover), Some(palette.accent_soft_hover)];
        ink = palette.accent_text;
        hover_ink = palette.accent_text_strong;
    }
    Colors { fill, ink: [ink, hover_ink, hover_ink], ring, lift }
}

/// A text button: its words, an optional glyph before them.
pub struct Button<'a, Message> {
    id: FocusId,
    area: FocusArea,
    palette: &'static Palette,
    label: String,
    icon: Option<&'static str>,
    variant: Variant,
    size: Size,
    words: Words,
    danger: bool,
    toggled: bool,
    disabled: bool,
    fill: bool,
    on_press: Option<Message>,
    preview: Option<Preview>,
    _marker: std::marker::PhantomData<&'a ()>,
}

impl<'a, Message: Clone + 'a> Button<'a, Message> {
    /// A button with `label` that sends `on_press`, the focus target `id` in `area`.
    pub fn new(id: FocusId, area: FocusArea, palette: &'static Palette, label: impl Into<String>, on_press: Message) -> Self {
        Button {
            id,
            area,
            palette,
            label: label.into(),
            icon: None,
            variant: Variant::Soft,
            size: Size::Md,
            words: Words::Button,
            danger: false,
            toggled: false,
            disabled: false,
            fill: false,
            on_press: Some(on_press),
            preview: None,
            _marker: std::marker::PhantomData,
        }
    }

    /// A glyph before the words (`.ui-icon`).
    pub fn icon(mut self, icon: &'static str) -> Self {
        self.icon = Some(icon);
        self
    }

    pub fn variant(mut self, variant: Variant) -> Self {
        self.variant = variant;
        self
    }

    pub fn size(mut self, size: Size) -> Self {
        self.size = size;
        self
    }

    /// `data-tone="danger"` on a ghost or outline button: "Delete", "Don't save".
    pub fn danger(mut self, danger: bool) -> Self {
        self.danger = danger;
        self
    }

    /// `aria-pressed="true"`: a toggle that is on reads as the accent's soft tint.
    pub fn toggled(mut self, toggled: bool) -> Self {
        self.toggled = toggled;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// The button fills its cell and centres its words (a grid of fields).
    pub fn fill(mut self, fill: bool) -> Self {
        self.fill = fill;
        self
    }

    /// A section title's action (`.ui-section-action.ui-button`): a small ghost pill with its words in the quiet ink.
    pub fn section_action(mut self) -> Self {
        self.words = Words::SectionAction;
        self.size = Size::Sm;
        self.variant = Variant::Ghost;
        self
    }

    /// Holds a state fixed (the component sheet and tests).
    pub fn preview(mut self, preview: Option<Preview>) -> Self {
        self.preview = preview;
        self
    }

    /// The button as an element.
    pub fn into_element(self) -> Element<'a, Message> {
        let Button { id, area, palette, label, icon, variant, size, words: role, danger, toggled, disabled, fill, on_press, preview, .. } = self;
        let colors = colors(palette, variant, danger, toggled, role);
        let height = size.height();
        let opacity = if disabled { DISABLED } else { 1.0 };
        let style = match role {
            Words::Button => TextStyle::from_role(&scale::TYPE_BUTTON).tracking_em(-0.005),
            Words::SectionAction => TextStyle::from_role(&scale::TYPE_SMALL_STRONG),
        };
        // `.ui-button`: a 1 px transparent border, then `--_px` of padding; a leading glyph sits 2 px into it.
        let padding = if role == Words::SectionAction { scale::SPACE_2 } else { size.padding() };
        let left = 1.0 + padding - if icon.is_some() { scale::SPACE_0_5 } else { 0.0 };
        let face = |ink: Rgba| -> Element<'a, Message> {
            let ink = ink.faded(opacity);
            let mut parts: Vec<Element<'a, Message>> = Vec::new();
            if let Some(icon) = icon {
                parts.push(super::icon(icon, size.glyph(), ink).boxed());
            }
            parts.push(words(label.clone(), style, ink));
            let line = Row::with_children(parts).spacing(size.gap()).align_y(Alignment::Center);
            let face = container(line).height(Length::Fixed(height)).center_y(Length::Fixed(height)).padding(Padding { top: 0.0, right: 1.0 + padding, bottom: 0.0, left });
            if fill { container(face).center_x(Length::Fill).boxed() } else { face.boxed() }
        };
        let radius = pill(height);
        let fills = colors.fill;
        let (ring, lift) = (colors.ring, colors.lift);
        let look = move |interaction: Interaction| Look {
            fill: fills[interaction as usize],
            border: 1.0,
            ring,
            shadows: lift,
            radius,
            opacity,
        };
        let message = on_press.filter(|_| !disabled);
        let mut surface = Surface::new(face(colors.ink[0]), look).on_press_maybe(message.clone()).preview(preview).height(Length::Fixed(height));
        if fill {
            surface = surface.width(Length::Fill);
        }
        if colors.ink[1] != colors.ink[0] {
            surface = surface.hover_face(face(colors.ink[1]));
        }
        let mut target = Focusable::new(id, area, surface.boxed(), Ring::of(palette, radius)).enabled(!disabled).ring_shown(preview == Some(Preview::Focus));
        if let Some(message) = message {
            target = target.on_activate(message);
        }
        target.boxed()
    }
}

/// The icon button's sizes (`data-size`): 24, 28, 32 and 36 px, glyphs 14, 16, 18 and 18.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum IconSize {
    Xs,
    Sm,
    #[default]
    Md,
    Lg,
}

impl IconSize {
    pub fn side(self) -> f32 {
        match self {
            IconSize::Xs => scale::CONTROL_XS,
            IconSize::Sm => scale::CONTROL_SM,
            IconSize::Md => scale::CONTROL_MD,
            IconSize::Lg => scale::CONTROL_LG,
        }
    }

    fn glyph(self) -> f32 {
        match self {
            IconSize::Xs => scale::ICON_SM,
            IconSize::Sm => scale::ICON_MD,
            IconSize::Md | IconSize::Lg => scale::ICON_LG,
        }
    }

    fn radius(self) -> f32 {
        match self {
            IconSize::Xs | IconSize::Sm => scale::RADIUS_SM,
            IconSize::Md => scale::RADIUS_MD,
            IconSize::Lg => scale::RADIUS_LG,
        }
    }
}

/// An icon-only button.
pub struct IconButton<'a, Message> {
    id: FocusId,
    area: FocusArea,
    palette: &'static Palette,
    icon: &'static str,
    size: IconSize,
    soft: bool,
    danger: bool,
    round: bool,
    toggled: bool,
    expanded: bool,
    disabled: bool,
    on_press: Option<Message>,
    preview: Option<Preview>,
    _marker: std::marker::PhantomData<&'a ()>,
}

impl<'a, Message: Clone + 'a> IconButton<'a, Message> {
    pub fn new(id: FocusId, area: FocusArea, palette: &'static Palette, icon: &'static str, on_press: Message) -> Self {
        IconButton { id, area, palette, icon, size: IconSize::Md, soft: false, danger: false, round: false, toggled: false, expanded: false, disabled: false, on_press: Some(on_press), preview: None, _marker: std::marker::PhantomData }
    }

    pub fn size(mut self, size: IconSize) -> Self {
        self.size = size;
        self
    }

    /// `data-variant="soft"`: on the mist fill.
    pub fn soft(mut self, soft: bool) -> Self {
        self.soft = soft;
        self
    }

    /// `data-tone="danger"`: the hover turns red.
    pub fn danger(mut self, danger: bool) -> Self {
        self.danger = danger;
        self
    }

    /// `data-shape="round"`.
    pub fn round(mut self, round: bool) -> Self {
        self.round = round;
        self
    }

    /// `aria-pressed="true"`: a toggle that is on turns Styk blue on its soft tint.
    pub fn toggled(mut self, toggled: bool) -> Self {
        self.toggled = toggled;
        self
    }

    /// `aria-expanded="true"`: an open menu button keeps its pressed tile.
    pub fn expanded(mut self, expanded: bool) -> Self {
        self.expanded = expanded;
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
        let IconButton { id, area, palette, icon, size, soft, danger, round, toggled, expanded, disabled, on_press, preview, .. } = self;
        let side = size.side();
        let radius = if round { pill(side) } else { size.radius() };
        let opacity = if disabled { DISABLED } else { 1.0 };
        let (mut fill, mut ink, mut hover_ink) = if soft {
            ([None, Some(palette.control_soft_hover), Some(palette.control_soft_pressed)], palette.text_1, palette.text_1)
        } else {
            ([None, Some(palette.surface_hover), Some(palette.surface_pressed)], palette.text_2, palette.text_1)
        };
        let rest = if soft { Some(palette.control_soft) } else { None };
        let mut rest = rest;
        if danger {
            hover_ink = palette.danger_text;
            fill[1] = Some(palette.danger_soft);
        }
        if toggled {
            rest = Some(palette.accent_soft);
            fill = [None, Some(palette.accent_soft_hover), Some(palette.accent_soft_hover)];
            ink = palette.accent;
            hover_ink = palette.accent_text;
        } else if expanded {
            rest = Some(palette.surface_pressed);
            ink = palette.text_1;
        }
        fill[0] = rest;
        let face = |ink: Rgba| -> Element<'a, Message> {
            container(super::icon(icon, size.glyph(), ink.faded(opacity))).center_x(Length::Fixed(side)).center_y(Length::Fixed(side)).boxed()
        };
        let look = move |interaction: Interaction| Look { fill: fill[interaction as usize], border: 1.0, ring: None, shadows: &[], radius, opacity };
        let message = on_press.filter(|_| !disabled);
        let mut surface = Surface::new(face(ink), look).on_press_maybe(message.clone()).preview(preview).width(Length::Fixed(side)).height(Length::Fixed(side));
        if hover_ink != ink {
            surface = surface.hover_face(face(hover_ink));
        }
        let mut target = Focusable::new(id, area, surface.boxed(), Ring::of(palette, radius)).enabled(!disabled).ring_shown(preview == Some(Preview::Focus));
        if let Some(message) = message {
            target = target.on_activate(message);
        }
        target.boxed()
    }
}
