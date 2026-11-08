//! Switch, checkbox and radio (`switch.css`, `check.css`): the controls that hold a choice.
//!
//! Each declares its input role in its constructor (a switch and a checkbox own Delete, Backspace and the other editing keys
//! while focused, as a native checkbox does; `InputRole`), so no screen can leave a toggle looking like a button to the
//! shortcut routing. They report the choice a press or Space asks for; the owner decides.

use iced::Widget as _;
use super::control::{DISABLED, Interaction, Preview, words};
use super::dir::Dir;
use super::focus::{Focusable, Keys, Ring};
use super::frame::{self, FieldFrame};
use super::surface::{Look, Surface};
use crate::tokens::scale;
use crate::typography::TextStyle;
use crate::{Palette, Rgba};
use iced::widget::{Row, Space, container, svg};
use iced::{Alignment, Element, Length, Padding};
use styk_core::focus::{FocusArea, FocusId, InputRole};

/// `.ui-switch`: 32 by 18.
const SWITCH_WIDTH: f32 = 32.0;
const SWITCH_HEIGHT: f32 = 18.0;
/// The knob off (10 px, 4 px in) and on (14 px, 2 px in).
const KNOB_OFF: (f32, f32) = (10.0, 4.0);
const KNOB_ON: (f32, f32) = (14.0, 2.0);
/// `.ui-checkbox`, `.ui-radio`: 16 px.
const BOX: f32 = 16.0;

/// A switch. `on_toggle` is given the state a press asks for.
pub struct Switch<'a, Message> {
    id: FocusId,
    area: FocusArea,
    palette: &'static Palette,
    checked: bool,
    disabled: bool,
    dir: Dir,
    on_toggle: Box<dyn Fn(bool) -> Message + 'a>,
    preview: Option<Preview>,
}

impl<'a, Message: Clone + 'a> Switch<'a, Message> {
    pub fn new(id: FocusId, area: FocusArea, palette: &'static Palette, checked: bool, on_toggle: impl Fn(bool) -> Message + 'a) -> Self {
        Switch { id, area, palette, checked, disabled: false, dir: Dir::Ltr, on_toggle: Box::new(on_toggle), preview: None }
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// In a right-to-left interface the knob starts at the right and slides left.
    pub fn dir(mut self, dir: Dir) -> Self {
        self.dir = dir;
        self
    }

    pub fn preview(mut self, preview: Option<Preview>) -> Self {
        self.preview = preview;
        self
    }

    /// The bare switch.
    pub fn into_element(self) -> Element<'a, Message> {
        let Switch { id, area, palette, checked, disabled, dir, on_toggle, preview } = self;
        let opacity = if disabled { DISABLED } else { 1.0 };
        let face = |knob: Rgba| -> Element<'a, Message> {
            let (size, inset) = if checked { KNOB_ON } else { KNOB_OFF };
            let dot = container(Space::new().width(size).height(size)).style(move |_| iced::widget::container::Style {
                background: Some(iced::Background::Color(knob.faded(opacity).into())),
                border: iced::Border { radius: (size / 2.0).into(), ..Default::default() },
                ..Default::default()
            });
            // The knob's place is an inline-start inset, in the knob's size: `translate: 14px` slides it to the other end.
            let slide = if checked { SWITCH_WIDTH - 2.0 * KNOB_ON.1 - KNOB_ON.0 } else { 0.0 };
            let (left, right) = if dir.is_rtl() { (0.0, inset + slide) } else { (inset + slide, 0.0) };
            container(dot).padding(Padding { top: inset, right, bottom: 0.0, left }).width(Length::Fixed(SWITCH_WIDTH)).height(Length::Fixed(SWITCH_HEIGHT)).boxed()
        };
        // Off: a sunken track in a 1.5 px `--line-control` ring and a quiet knob; on: the strong accent. Hover darkens the
        // ring and knob (off) or the track (on).
        let look = move |interaction: Interaction| {
            let hovered = !disabled && interaction != Interaction::Rest;
            if checked {
                let fill = if hovered { palette.accent_strong.mix(86.0, palette.text_1) } else { palette.accent_strong };
                Look { fill: Some(fill), border: 0.0, ring: None, shadows: &[], radius: SWITCH_HEIGHT / 2.0, opacity }
            } else {
                let ring = if hovered { palette.text_2 } else { palette.line_control };
                Look { fill: Some(palette.surface_sunken), border: 0.0, ring: Some((1.5, ring)), shadows: &[], radius: SWITCH_HEIGHT / 2.0, opacity }
            }
        };
        let message = on_toggle(!checked);
        let knob = if checked { palette.switch_knob_on } else { palette.switch_knob_off };
        let mut surface = Surface::new(face(knob), look).on_press_maybe((!disabled).then(|| message.clone())).preview(preview);
        if !checked {
            surface = surface.hover_face(face(palette.text_2));
        }
        Focusable::new(id, area, surface.boxed(), Ring::of(palette, SWITCH_HEIGHT / 2.0))
            .input_role(InputRole::Checkbox)
            .keys(Keys::Toggle)
            .on_activate(message)
            .enabled(!disabled)
            .ring_shown(preview == Some(Preview::Focus))
            .boxed()
    }

    /// The switch in a field of the grid (`.ui-field[data-switch-field]`): the label first, the switch at its end.
    pub fn field(self, label: String, in_grid: bool) -> Element<'a, Message> {
        let palette = self.palette;
        let disabled = self.disabled;
        let preview = self.preview;
        let style = TextStyle::from_role(&scale::TYPE_SMALL);
        let ink = if disabled { palette.text_3.faded(super::control::FIELD_DISABLED) } else { palette.text_3 };
        let line = Row::with_children([words(label, style, ink), Space::new().width(Length::Fill).boxed(), self.into_element()]).spacing(scale::SPACE_2).align_y(Alignment::Center);
        let (left, right) = frame::padding(in_grid);
        FieldFrame::new(line.boxed(), palette, Length::Fill, frame::HEIGHT, Padding { top: 0.0, right, bottom: 0.0, left }).disabled(disabled).preview(preview.filter(|preview| *preview != Preview::Focus)).boxed()
    }

    /// The switch at the end of a row (`.ui-switch-row`): `--type-ui` words, 36 px at least.
    pub fn row(self, label: String) -> Element<'a, Message> {
        let palette = self.palette;
        let ink = if self.disabled { palette.text_disabled } else { palette.text_1 };
        let line = Row::with_children([words(label, TextStyle::from_role(&scale::TYPE_UI), ink), Space::new().width(Length::Fill).boxed(), self.into_element()]).spacing(scale::SPACE_2).align_y(Alignment::Center);
        container(line).height(Length::Fixed(scale::CONTROL_LG)).center_y(Length::Fixed(scale::CONTROL_LG)).boxed()
    }
}

/// A checkbox's state.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Checked {
    #[default]
    No,
    Yes,
    /// `:indeterminate`, `aria-checked="mixed"`.
    Mixed,
}

/// The tick of `.ui-checkbox::before` (a 9 by 5 corner of 2 px lines turned 45 degrees, lifted 1 px), and the bar of a mixed
/// one, in the 16 px box. They are drawn in `--text-on-strong` by tinting.
const TICK: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M3.757 7.707L6.586 10.536L12.243 4.879" fill="none" stroke="#000" stroke-width="2" stroke-linejoin="miter" stroke-miterlimit="4"/></svg>"##;
const BAR: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect x="4" y="7" width="8" height="2" fill="#000"/></svg>"##;

fn mark<'a, Message: 'a>(bytes: &'static [u8], color: Rgba) -> Element<'a, Message> {
    let color = iced::Color::from(color);
    svg(svg::Handle::from_memory(bytes)).width(Length::Fixed(BOX)).height(Length::Fixed(BOX)).style(move |_, _| svg::Style { color: Some(color) }).boxed()
}

/// A checkbox. `on_toggle` is given the state a press asks for.
pub struct Checkbox<'a, Message> {
    id: FocusId,
    area: FocusArea,
    palette: &'static Palette,
    checked: Checked,
    disabled: bool,
    label: Option<String>,
    on_toggle: Box<dyn Fn(bool) -> Message + 'a>,
    preview: Option<Preview>,
}

impl<'a, Message: Clone + 'a> Checkbox<'a, Message> {
    pub fn new(id: FocusId, area: FocusArea, palette: &'static Palette, checked: Checked, on_toggle: impl Fn(bool) -> Message + 'a) -> Self {
        Checkbox { id, area, palette, checked, disabled: false, label: None, on_toggle: Box::new(on_toggle), preview: None }
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// The words after the box (`.ui-check-row`); a press on them toggles too.
    pub fn label(mut self, label: impl Into<String>) -> Self {
        self.label = Some(label.into());
        self
    }

    pub fn preview(mut self, preview: Option<Preview>) -> Self {
        self.preview = preview;
        self
    }

    pub fn into_element(self) -> Element<'a, Message> {
        let Checkbox { id, area, palette, checked, disabled, label, on_toggle, preview } = self;
        let opacity = if disabled { DISABLED } else { 1.0 };
        let radius = scale::RADIUS_2XS;
        let on = checked != Checked::No;
        let look = move |interaction: Interaction| {
            if on {
                Look { fill: Some(palette.accent_strong), border: 0.0, ring: None, shadows: &[], radius, opacity }
            } else {
                let ring = if !disabled && interaction != Interaction::Rest { palette.text_2 } else { palette.line_control };
                Look { fill: Some(palette.surface), border: 0.0, ring: Some((1.5, ring)), shadows: &[], radius, opacity }
            }
        };
        let face: Element<'a, Message> = match checked {
            Checked::No => Space::new().width(BOX).height(BOX).boxed(),
            Checked::Yes => mark(TICK, palette.text_on_strong.faded(opacity)),
            Checked::Mixed => mark(BAR, palette.text_on_strong.faded(opacity)),
        };
        let message = on_toggle(checked != Checked::Yes);
        let surface = Surface::new(face, look).on_press_maybe((!disabled).then(|| message.clone())).preview(preview).width(Length::Fixed(BOX)).height(Length::Fixed(BOX));
        let target: Element<'a, Message> = Focusable::new(id, area, surface.boxed(), Ring::of(palette, radius))
            .input_role(InputRole::Checkbox)
            .keys(Keys::Toggle)
            .on_activate(message.clone())
            .enabled(!disabled)
            .ring_shown(preview == Some(Preview::Focus))
            .boxed();
        match label {
            None => target,
            Some(label) => check_row(palette, target, label, disabled, message),
        }
    }
}

/// A radio button. A radio reports that it was chosen; one in a group stays chosen when pressed again.
pub struct Radio<'a, Message> {
    id: FocusId,
    area: FocusArea,
    palette: &'static Palette,
    checked: bool,
    disabled: bool,
    label: Option<String>,
    on_select: Message,
    preview: Option<Preview>,
    _marker: std::marker::PhantomData<&'a ()>,
}

impl<'a, Message: Clone + 'a> Radio<'a, Message> {
    pub fn new(id: FocusId, area: FocusArea, palette: &'static Palette, checked: bool, on_select: Message) -> Self {
        Radio { id, area, palette, checked, disabled: false, label: None, on_select, preview: None, _marker: std::marker::PhantomData }
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn label(mut self, label: impl Into<String>) -> Self {
        self.label = Some(label.into());
        self
    }

    pub fn preview(mut self, preview: Option<Preview>) -> Self {
        self.preview = preview;
        self
    }

    pub fn into_element(self) -> Element<'a, Message> {
        let Radio { id, area, palette, checked, disabled, label, on_select, preview, .. } = self;
        let opacity = if disabled { DISABLED } else { 1.0 };
        let radius = BOX / 2.0;
        // Chosen: a 5 px ring of the strong accent around the surface-coloured dot (`inset 0 0 0 5px`).
        let look = move |interaction: Interaction| {
            let ring = if checked {
                (5.0, palette.accent_strong)
            } else if !disabled && interaction != Interaction::Rest {
                (1.5, palette.text_2)
            } else {
                (1.5, palette.line_control)
            };
            Look { fill: Some(palette.surface), border: 0.0, ring: Some(ring), shadows: &[], radius, opacity }
        };
        let surface = Surface::new(Space::new().width(BOX).height(BOX).boxed(), look)
            .on_press_maybe((!disabled).then(|| on_select.clone()))
            .preview(preview)
            .width(Length::Fixed(BOX))
            .height(Length::Fixed(BOX));
        let target: Element<'a, Message> = Focusable::new(id, area, surface.boxed(), Ring::of(palette, radius))
            .input_role(InputRole::Radio)
            .keys(Keys::Toggle)
            .on_activate(on_select.clone())
            .enabled(!disabled)
            .ring_shown(preview == Some(Preview::Focus))
            .boxed();
        match label {
            None => target,
            Some(label) => check_row(palette, target, label, disabled, on_select),
        }
    }
}

/// `.ui-check-row`: the box first, its words after it, 8 px apart, 36 px at least; a press on the words presses the box.
fn check_row<'a, Message: Clone + 'a>(palette: &'static Palette, control: Element<'a, Message>, label: String, disabled: bool, message: Message) -> Element<'a, Message> {
    let ink = if disabled { palette.text_disabled } else { palette.text_1 };
    let line = Row::with_children([control, words(label, TextStyle::from_role(&scale::TYPE_UI), ink)]).spacing(scale::SPACE_2).align_y(Alignment::Center);
    let row = container(line).height(Length::Fixed(scale::CONTROL_LG)).center_y(Length::Fixed(scale::CONTROL_LG));
    Surface::new(row.boxed(), |_| Look::plain(0.0)).on_press_maybe((!disabled).then_some(message)).boxed()
}
