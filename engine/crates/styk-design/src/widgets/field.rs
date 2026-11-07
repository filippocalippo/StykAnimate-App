//! Text fields: `EditField` for text, search and text areas (`docs/native/text-input.md` sections 1, 2 and 6).
//!
//! A controlled widget over iced's `text_input` with the role's Enter/Escape policy, the field's limits applied before
//! the editor mutates, composition and focus reported, and a forced base direction in right-to-left interfaces.

use super::dir::Dir;
use super::focus::{Anchor, widget_id};
use crate::{Palette, tokens};
use iced::advanced::text::editor::{self as editor_core, Binding, Intake, KeyPress, Room};
use iced::keyboard::{self, Key, key::Named};
use iced::widget::{container, text_input};
use iced::{Background, Border, Element, Length, Padding, Pixels, Theme, Widget as _};
use styk_core::field::{EnterAction, EscapeAction, Role};
use styk_core::focus::{FocusArea, FocusId, TargetKind};
use styk_core::limits::{Context, Limits};

/// The `Intake` that applies a field's [`Limits`] to incoming text.
pub fn intake(limits: Limits) -> Intake {
    Intake::new(move |room: &Room, incoming: &str| {
        let context = Context {
            chars: room.chars,
            selected: room.selected,
            units: room.units.clone(),
        };
        limits.admit_in(&context, incoming)
    })
    .with_units(limits.tracks_units())
}

/// A text field. Build it, then `Element::from` it.
pub struct EditField<'a, Message> {
    id: FocusId,
    area: FocusArea,
    role: Role,
    value: std::borrow::Cow<'a, str>,
    placeholder: &'a str,
    limits: Limits,
    dir: Dir,
    palette: &'static Palette,
    enabled: bool,
    invalid: bool,
    composing: bool,
    width: Length,
    height: Option<f32>,
    embedded: bool,
    on_input: Option<Box<dyn Fn(String) -> Message + 'a>>,
    on_enter: Option<Message>,
    on_escape: Option<Message>,
    on_clear: Option<Message>,
    on_step: Option<std::sync::Arc<dyn Fn(i32, bool, bool) -> Message + 'a>>,
    on_step_end: Option<Message>,
    on_focus_change: Option<Box<dyn Fn(bool) -> Message + 'a>>,
    on_compose: Option<Box<dyn Fn(bool) -> Message + 'a>>,
}

impl<'a, Message: Clone + 'a> EditField<'a, Message> {
    /// A field of `role` showing `value`.
    pub fn new(id: FocusId, area: FocusArea, role: Role, value: impl Into<std::borrow::Cow<'a, str>>, palette: &'static Palette) -> Self {
        let value = value.into();
        let limits = match role {
            Role::Number => Limits::number(),
            Role::Multiline => Limits::area(16384),
            _ => Limits::line(),
        };
        EditField {
            id,
            area,
            role,
            value,
            placeholder: "",
            limits,
            dir: Dir::Ltr,
            palette,
            enabled: true,
            invalid: false,
            composing: false,
            width: Length::Fill,
            height: None,
            embedded: false,
            on_input: None,
            on_enter: None,
            on_escape: None,
            on_clear: None,
            on_step: None,
            on_step_end: None,
            on_focus_change: None,
            on_compose: None,
        }
    }

    pub fn placeholder(mut self, placeholder: &'a str) -> Self {
        self.placeholder = placeholder;
        self
    }

    /// Replaces the role's default limits.
    pub fn limits(mut self, limits: Limits) -> Self {
        self.limits = limits;
        self
    }

    /// The interface direction. A number field ignores it: numbers stay left to right.
    pub fn dir(mut self, dir: Dir) -> Self {
        self.dir = dir;
        self
    }

    pub fn enabled(mut self, enabled: bool) -> Self {
        self.enabled = enabled;
        self
    }

    /// Shows the error state (the danger colour).
    pub fn invalid(mut self, invalid: bool) -> Self {
        self.invalid = invalid;
        self
    }

    /// Whether an input method has a composition open in this field (from the core's focus state): Enter and Escape
    /// then belong to the input method.
    pub fn composing(mut self, composing: bool) -> Self {
        self.composing = composing;
        self
    }

    pub fn width(mut self, width: impl Into<Length>) -> Self {
        self.width = width.into();
        self
    }

    /// The input sits inside a field box that draws itself (`.ui-field` with `.ui-field-input`: the Inspector's rows):
    /// no background, border or padding of its own, the value type role (`--type-value`).
    pub fn embedded(mut self) -> Self {
        self.embedded = true;
        self
    }

    /// The height of a multiline field.
    pub fn height(mut self, height: f32) -> Self {
        self.height = Some(height);
        self
    }

    /// The text changed (after the limits).
    pub fn on_input(mut self, on_input: impl Fn(String) -> Message + 'a) -> Self {
        self.on_input = Some(Box::new(on_input));
        self
    }

    /// Enter, where the role's policy publishes (commit, commit and blur, submit).
    pub fn on_enter(mut self, message: Message) -> Self {
        self.on_enter = Some(message);
        self
    }

    /// Escape, where the role's policy publishes (revert, or the dialog's cancel).
    pub fn on_escape(mut self, message: Message) -> Self {
        self.on_escape = Some(message);
        self
    }

    /// Escape in a non-empty search field: the owner empties it.
    pub fn on_clear(mut self, message: Message) -> Self {
        self.on_clear = Some(message);
        self
    }

    /// A number field's ArrowUp (+1) and ArrowDown (-1) inside the input, with Shift and Alt (Ctrl and Meta pass through to
    /// the text, as today).
    pub fn on_step(mut self, on_step: impl Fn(i32, bool, bool) -> Message + 'a) -> Self {
        self.on_step = Some(std::sync::Arc::new(on_step));
        self
    }

    /// The release of ArrowUp or ArrowDown after steps: the held key's gesture ends.
    pub fn on_step_end(mut self, message: Message) -> Self {
        self.on_step_end = Some(message);
        self
    }

    pub fn on_focus_change(mut self, on_focus_change: impl Fn(bool) -> Message + 'a) -> Self {
        self.on_focus_change = Some(Box::new(on_focus_change));
        self
    }

    pub fn on_compose(mut self, on_compose: impl Fn(bool) -> Message + 'a) -> Self {
        self.on_compose = Some(Box::new(on_compose));
        self
    }
}

/// The embedded input: transparent, its box drawn by the row around it.
fn embedded_style(palette: &'static Palette, invalid: bool) -> impl Fn(&Theme, text_input::Status) -> text_input::Style {
    move |_theme, status| {
        let disabled = matches!(status, text_input::Status::Disabled);
        text_input::Style {
            background: Background::Color(iced::Color::TRANSPARENT),
            border: Border { color: iced::Color::TRANSPARENT, width: 0.0, radius: 0.0.into() },
            placeholder: palette.text_placeholder.into(),
            value: if invalid { palette.danger_text } else if disabled { palette.text_disabled } else { palette.text_1 }.into(),
            selection: palette.text_selection.into(),
        }
    }
}

fn style(palette: &'static Palette, invalid: bool) -> impl Fn(&Theme, text_input::Status) -> text_input::Style {
    move |_theme, status| {
        let line = if invalid { palette.danger_text } else { palette.line_control };
        let (border, width) = match status {
            text_input::Status::Focused { .. } => (if invalid { palette.danger_text } else { palette.accent }, 1.5),
            text_input::Status::Hovered => (palette.line_2, 1.0),
            _ => (line, 1.0),
        };
        let disabled = matches!(status, text_input::Status::Disabled);
        text_input::Style {
            background: Background::Color(palette.surface_field.into()),
            border: Border { color: border.into(), width, radius: tokens::scale::RADIUS_XS.into() },
            placeholder: palette.text_placeholder.into(),
            value: if disabled { palette.text_disabled } else { palette.text_1 }.into(),
            selection: palette.text_selection.into(),
        }
    }
}

impl<'a, Message: Clone + 'a> EditField<'a, Message> {
    /// The field as an element.
    pub fn into_element(self) -> Element<'a, Message> {
        let field = self;
        let EditField {
            id,
            area,
            role,
            value,
            placeholder,
            limits,
            dir,
            palette,
            enabled,
            invalid,
            composing,
            width,
            height,
            embedded,
            on_input,
            on_enter,
            on_escape,
            on_clear,
            on_step,
            on_step_end,
            on_focus_change,
            on_compose,
        } = field;

        let dir = if role == Role::Number { Dir::Ltr } else { dir };
        let is_empty = value.is_empty();
        let limits = Limits { single_line: role.single_line(), ..limits };

        let (font, size, padding) = if embedded {
            let value = crate::typography::TextStyle::from_role(&tokens::scale::TYPE_VALUE).tabular();
            (value.font, value.size, Padding::ZERO)
        } else {
            (super::INTER, tokens::scale::TYPE_UI.size, Padding { top: 6.0, right: 8.0, bottom: 6.0, left: 8.0 })
        };
        let mut input = text_input(placeholder, value)
            .id(widget_id(id))
            .font(font)
            .size(Pixels(size))
            .padding(padding)
            .width(Length::Fill)
            .intake(intake(limits))
            .style(if embedded { Box::new(embedded_style(palette, invalid)) as Box<dyn Fn(&Theme, text_input::Status) -> text_input::Style> } else { Box::new(style(palette, invalid)) })
            .base_direction(match (dir, role) {
                (Dir::Rtl, _) => editor_core::BaseDirection::RightToLeft,
                (Dir::Ltr, Role::Number) => editor_core::BaseDirection::LeftToRight,
                _ => editor_core::BaseDirection::Auto,
            });

        if role == Role::Multiline {
            input = input.multiline(Some(iced::advanced::text::Wrapping::WordOrGlyph));
        }
        if enabled && let Some(on_input) = on_input {
            input = input.on_input(on_input);
        }
        if let Some(on_focus_change) = on_focus_change {
            input = input.on_focus_change(on_focus_change);
        }
        if let Some(on_compose) = on_compose {
            input = input.on_compose(on_compose);
        }

        input = input.key_binding(move |key_press: &KeyPress| -> Option<Binding<Message>> {
            let is_enter = matches!(key_press.modified_key.as_ref(), Key::Named(Named::Enter));
            let is_escape = matches!(key_press.modified_key.as_ref(), Key::Named(Named::Escape));
            let step = match key_press.modified_key.as_ref() {
                Key::Named(Named::ArrowUp) => Some(1),
                Key::Named(Named::ArrowDown) => Some(-1),
                _ => None,
            };
            if !key_press.is_focused || !(is_enter || is_escape || step.is_some()) {
                return None;
            }
            if composing {
                // The input method owns Enter (commit), Escape (cancel the composition) and the arrows.
                return Some(Binding::Sequence(Vec::new()));
            }
            if let (Some(direction), Some(on_step)) = (step, &on_step) {
                if role == Role::Number && !key_press.modifiers.control() && !key_press.modifiers.logo() {
                    return Some(Binding::Custom(on_step(direction, key_press.modifiers.shift(), key_press.modifiers.alt())));
                }
                return None;
            }
            if step.is_some() {
                return None;
            }
            if is_enter {
                let action = if key_press.modifiers.command() { role.ctrl_enter() } else { role.enter() };
                return match (action, &on_enter) {
                    (EnterAction::Default, _) | (_, None) => None,
                    (EnterAction::Commit | EnterAction::Submit, Some(message)) => Some(Binding::Custom(message.clone())),
                    (EnterAction::CommitAndBlur, Some(message)) => {
                        Some(Binding::Sequence(vec![Binding::Custom(message.clone()), Binding::Unfocus]))
                    }
                };
            }
            match role.escape() {
                EscapeAction::Blur => Some(Binding::Unfocus),
                EscapeAction::PassToDialog => on_escape.clone().map(Binding::Custom),
                EscapeAction::Revert => on_escape.clone().map(Binding::Custom),
                EscapeAction::RevertAndBlur => match &on_escape {
                    Some(message) => Some(Binding::Sequence(vec![Binding::Custom(message.clone()), Binding::Unfocus])),
                    None => Some(Binding::Unfocus),
                },
                EscapeAction::ClearOrBlur => match (&on_clear, is_empty) {
                    (Some(message), false) => Some(Binding::Custom(message.clone())),
                    _ => Some(Binding::Unfocus),
                },
            }
        });

        let mut element: Element<'a, Message> = input.boxed();
        if role == Role::Multiline {
            element = container(element).width(width).height(Length::Fixed(height.unwrap_or(96.0))).boxed();
        } else if width != Length::Fill {
            element = container(element).width(width).boxed();
        }

        let mut anchor = Anchor::new(id, area, TargetKind::TextEntry, enabled, element);
        if let Some(message) = on_step_end {
            anchor = anchor.on_key_release(move |event| match event {
                keyboard::Event::KeyReleased { key: Key::Named(Named::ArrowUp | Named::ArrowDown), .. } => Some(message.clone()),
                _ => None,
            });
        }
        anchor.boxed()
    }
}
