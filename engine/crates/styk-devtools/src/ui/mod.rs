//! The views of the first developer panels (`docs/native/devtools-panels.md`): the developer mark, the profiler, the
//! logs and the live parameters, and the performance overlay.
//!
//! The views draw the models `panels::Host` supplies and send typed events through `Core::dispatch`
//! (`Message::Command(Command::Developer(event))`, or `Command::Run` for a registered command). They own no
//! timer, sample, placement or availability rule, and every string goes through the presentation.

mod chrome;
pub mod logs;
mod overlay;
pub mod parameters;
pub mod profiler;
pub mod screens;

use crate::panels::{Availability, Bounds, Host, LogsModel, OverlayModel, ParametersModel, ProfilerModel};
use iced::Element;
use styk_core::commands::Command;
use styk_core::dev_extension::{CommandId, Event, Panel};
use styk_core::i18n::{Msg, Presentation};
use styk_core::layout::PanelId;
use styk_design::Theme;
use styk_design::widgets::button::{Button, IconButton};
use styk_design::widgets::tooltip::Content;

/// What the interface sends: the one message type of `styk_ui`.
pub type Message = styk_ui::Message;

/// What the panels draw: borrowed models, the presentation and the interface state a view needs.
pub struct Context<'a> {
    pub overlay: &'a OverlayModel,
    pub profiler: &'a ProfilerModel,
    pub logs: &'a LogsModel,
    pub parameters: &'a ParametersModel,
    pub availability: Availability,
    pub error: Option<&'a Msg>,
    /// The registered command whose argument is being asked for.
    pub input: Option<CommandId>,
    /// The text typed for that argument.
    pub draft: &'a str,
    pub presentation: &'a Presentation,
    pub theme: Theme,
    /// The focus state's composition, handed to every text field (`docs/native/text-input.md`).
    pub composing: bool,
}

/// What the host and the interface supply to build a [`Context`].
pub struct Surroundings<'a> {
    pub presentation: &'a Presentation,
    pub theme: Theme,
    pub composing: bool,
}

impl<'a> Context<'a> {
    /// The models of `host` as they are now.
    pub fn of(host: &'a Host, around: Surroundings<'a>) -> Context<'a> {
        Context {
            overlay: &host.overlay,
            profiler: &host.profiler,
            logs: &host.logs,
            parameters: &host.parameters,
            availability: host.availability(),
            error: host.error.as_ref(),
            input: host.input,
            draft: &host.draft,
            presentation: around.presentation,
            theme: around.theme,
            composing: around.composing,
        }
    }

    fn palette(&self) -> &'static styk_design::Palette {
        self.theme.palette()
    }

    /// A catalogue message in the selected locale.
    fn say(&self, msg: Msg) -> String {
        self.presentation.text(&msg)
    }

    fn word(&self, key: &'static str) -> String {
        self.say(Msg::new(key))
    }
}

/// The event as the message that reaches `Core::dispatch`.
fn send(event: Event) -> Message {
    Message::Command(Command::Developer(event))
}

/// A registered command as the message that reaches `Core::dispatch`.
fn run(id: CommandId) -> Message {
    Message::Command(Command::Run(id))
}

fn id(panel: Panel, slot: u64) -> styk_core::focus::FocusId {
    styk_core::dev_extension::ids::slot(panel, slot)
}

/// The view of the developer panel `panel` the dock places, or `None` for a panel that is not a developer tool.
pub fn panel<'a>(context: &Context<'_>, panel: &PanelId) -> Option<Element<'a, Message>> {
    match Panel::from_kind(&panel.kind)? {
        Panel::Profiler => Some(profiler::view(context)),
        Panel::Logs => Some(logs::view(context)),
        Panel::Parameters => Some(parameters::view(context)),
    }
}

/// The performance overlay: a layer over the whole window that takes no input, drawn at the rectangle and visibility the
/// host supplies (nothing while it is hidden).
pub fn overlay<'a>(context: &Context<'_>) -> Element<'a, Message> {
    overlay::view(context)
}

/// The window rectangle `bounds` as a point.
fn origin(bounds: Bounds) -> (f32, f32) {
    (bounds.x as f32, bounds.y as f32)
}

/// A text button of the panels' controls.
fn button<'a>(context: &Context<'_>, slot: u64, panel: Panel, label: String, icon: &'static str, enabled: bool, message: Message) -> Button<'a, Message> {
    Button::new(id(panel, slot), styk_core::focus::FocusArea::Panels, context.palette(), label, message).icon(icon).disabled(!enabled)
}

/// An icon button with its name as the tooltip.
fn icon_button<'a>(context: &Context<'_>, slot: u64, panel: Panel, icon: &'static str, label: String, enabled: bool, message: Message) -> Element<'a, Message> {
    IconButton::new(id(panel, slot), styk_core::focus::FocusArea::Panels, context.palette(), icon, message)
        .tooltip(Content { label, shortcut: String::new() }, Message::Tooltip)
        .disabled(!enabled)
        .into_element()
}

#[cfg(test)]
mod tests {
    use styk_core::dev_extension::catalogue;

    /// Every `"dev.…"` message key a view names is in the developer catalogue (a missing key would be shown as the key).
    #[test]
    fn every_key_the_views_name_is_in_the_catalogue() {
        let sources = [include_str!("mod.rs"), include_str!("chrome.rs"), include_str!("profiler.rs"), include_str!("logs.rs"), include_str!("parameters.rs"), include_str!("overlay.rs")];
        let mut found = 0;
        for source in sources {
            for part in source.split('"').skip(1).step_by(2) {
                if part.starts_with("dev.") && part.len() > 4 && part.chars().all(|c| c.is_ascii_alphanumeric() || c == '.') {
                    assert!(catalogue(part).is_some(), "{part} is not in the developer catalogue");
                    found += 1;
                }
            }
        }
        assert!(found > 30, "the scan found the views' keys ({found})");
    }
}
