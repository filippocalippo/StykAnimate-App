//! Developer-only payload boundary. No runtime, engine access or panel state lives here.
pub use crate::commands::CommandId;
use crate::{commands::Effect, i18n::Msg};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Panel {
    Profiler,
    Logs,
    Parameters,
}
impl Panel {
    pub const ALL: [Self; 3] = [Self::Profiler, Self::Logs, Self::Parameters];
    pub const fn id(self) -> &'static str {
        match self {
            Self::Profiler => "dev.profiler",
            Self::Logs => "dev.logs",
            Self::Parameters => "dev.parameters",
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Float(f64),
    Integer(i64),
    Bool(bool),
    Enum(String),
}
#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    /// A registered action requesting arguments, or explicit cancellation of that request.
    Input(Option<CommandId>),
    Panel {
        panel: Panel,
        open: bool,
    },
    Overlay(bool),
    ToggleOverlay,
    Start,
    Stop,
    Export(styk_services::files::FileTarget),
    Set {
        name: String,
        value: Value,
    },
    Reset(String),
    ChannelSet {
        name: String,
        value: Value,
    },
    SaveProfile(String),
    LoadProfile(String),
    ParametersPage(usize),
    Filter {
        level: u8,
        module: String,
        text: String,
        offset: usize,
    },
    Poll,
    Tick(u64),
}
/// All payload actions pass this dispatch boundary before extension handling.
#[inline(never)]
pub fn route(event: Event) -> Vec<Effect> {
    vec![Effect::Developer(event)]
}
pub const PANELS: &[crate::layout::PanelSpec] = &[
    crate::layout::PanelSpec {
        kind: "dev.profiler",
        min: crate::layout::Size { w: 256., h: 160. },
        pref: crate::layout::Size { w: 480., h: 300. },
        max: None,
        keep: 0,
        home: crate::layout::Side::Bottom,
        multi: 1,
    },
    crate::layout::PanelSpec {
        kind: "dev.logs",
        min: crate::layout::Size { w: 256., h: 160. },
        pref: crate::layout::Size { w: 480., h: 300. },
        max: None,
        keep: 0,
        home: crate::layout::Side::Bottom,
        multi: 1,
    },
    crate::layout::PanelSpec {
        kind: "dev.parameters",
        min: crate::layout::Size { w: 256., h: 160. },
        pref: crate::layout::Size { w: 320., h: 360. },
        max: None,
        keep: 0,
        home: crate::layout::Side::Right,
        multi: 1,
    },
];
pub fn command(id: CommandId) -> Event {
    match id {
        CommandId::DevProfiler => Event::Panel {
            panel: Panel::Profiler,
            open: true,
        },
        CommandId::DevLogs => Event::Panel {
            panel: Panel::Logs,
            open: true,
        },
        CommandId::DevParameters => Event::Panel {
            panel: Panel::Parameters,
            open: true,
        },
        CommandId::DevCaptureStart => Event::Start,
        CommandId::DevCaptureStop => Event::Stop,
        CommandId::DevOverlay => Event::ToggleOverlay,
        other => Event::Input(Some(other)),
    }
}
pub fn notice(reason: impl Into<String>) -> Msg {
    Msg::new("dev.error").with("reason", reason.into())
}
/// Kept in a separate, gated catalogue so a shipping build has none of this data.
#[path = "dev_extension_catalogue.rs"]
mod catalogue_data;
#[inline(never)]
pub fn catalogue(key: &str) -> Option<&'static str> {
    catalogue_data::CATALOGUE
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, v)| *v)
}
