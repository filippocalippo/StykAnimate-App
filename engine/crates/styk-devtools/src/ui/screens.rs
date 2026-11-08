//! The developer panels as catalogue screens: fixture models drawn through the same views the dock places, for the
//! engine-free preview and the app's `--screen`. They are new screens with no counterpart in today's app, so their
//! references are this build's own accepted captures (`docs/native/screens/devtools/`).

use super::{Context, Message, logs, overlay, parameters, profiler};
use crate::logs::{Filter, Line, Page};
use crate::panels::{Availability, Bounds, LogsModel, OverlayModel, ParametersModel, ProfilerModel};
use crate::params::{Descriptor, Kind as ParameterKind, Parameter};
use crate::runtime::Memory;
use crate::sampling::{Sample, Timing};
use iced::widget::{Space, container, stack};
use iced::{Background, Element, Length, Widget as _};
use styk_core::dev_extension::CommandId;
use styk_core::i18n::Presentation;
use styk_design::Theme;

/// What a screen shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// The profiler while a capture records.
    ProfilerRecording,
    /// The profiler after Stop: the summary, and the export asking for its file.
    Profiler,
    Logs,
    Parameters,
    /// The overlay over the stage's field.
    Overlay,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Screen {
    pub kind: Kind,
    pub dark: bool,
}

impl Screen {
    pub const ALL: [Screen; 10] = [
        Screen { kind: Kind::ProfilerRecording, dark: false },
        Screen { kind: Kind::ProfilerRecording, dark: true },
        Screen { kind: Kind::Profiler, dark: false },
        Screen { kind: Kind::Profiler, dark: true },
        Screen { kind: Kind::Logs, dark: false },
        Screen { kind: Kind::Logs, dark: true },
        Screen { kind: Kind::Parameters, dark: false },
        Screen { kind: Kind::Parameters, dark: true },
        Screen { kind: Kind::Overlay, dark: false },
        Screen { kind: Kind::Overlay, dark: true },
    ];

    /// The id `--screen` takes.
    pub const fn id(self) -> &'static str {
        match (self.kind, self.dark) {
            (Kind::ProfilerRecording, false) => "dev-profiler-recording",
            (Kind::ProfilerRecording, true) => "dev-profiler-recording-dark",
            (Kind::Profiler, false) => "dev-profiler",
            (Kind::Profiler, true) => "dev-profiler-dark",
            (Kind::Logs, false) => "dev-logs",
            (Kind::Logs, true) => "dev-logs-dark",
            (Kind::Parameters, false) => "dev-parameters",
            (Kind::Parameters, true) => "dev-parameters-dark",
            (Kind::Overlay, false) => "dev-overlay",
            (Kind::Overlay, true) => "dev-overlay-dark",
        }
    }

    pub fn from_id(id: &str) -> Option<Screen> {
        Screen::ALL.into_iter().find(|screen| screen.id() == id)
    }

    pub fn ids() -> String {
        Screen::ALL.iter().map(|screen| screen.id()).collect::<Vec<_>>().join(", ")
    }

    pub const fn theme(self) -> Theme {
        if self.dark { Theme::Dark } else { Theme::Light }
    }

    /// The window size the screen is captured at, in logical pixels.
    pub const fn size(self) -> (u32, u32) {
        match self.kind {
            Kind::ProfilerRecording => (480, 240),
            Kind::Profiler => (480, 380),
            Kind::Logs => (560, 420),
            Kind::Parameters => (360, 600),
            Kind::Overlay => (520, 400),
        }
    }
}

fn fixture_sample() -> Sample {
    let frames_ms: Vec<f64> = (0..240).map(|index| if index % 37 == 0 { 24.8 } else { 16.4 + f64::from(index % 5) * 0.2 }).collect();
    Sample {
        at_ns: 12_000_000_000,
        frames_ms,
        frame: Some(Timing { count: 240, p50_ms: 16.6, p95_ms: 17.2, maximum_ms: 24.8 }),
        interface: Some(Timing { count: 410, p50_ms: 0.4, p95_ms: 1.9, maximum_ms: 57.0 }),
        builder: Some(Timing { count: 238, p50_ms: 2.1, p95_ms: 5.3, maximum_ms: 9.8 }),
        painter: None,
        interface_stalls: 1,
        dropped: 0,
        truncated: false,
    }
}

fn fixture_memory() -> Memory {
    Memory { at_ns: 12_000_000_000, private_before: 350 * 1_048_576, private_after: 402 * 1_048_576, video: vec![("Fixture GPU".into(), "local".into(), 612 * 1_048_576, 3_900 * 1_048_576)], truncated: false }
}

fn line(sequence: u64, level: u8, module: &str, text: &str) -> Line {
    Line { sequence, time_ns: 1_000_000_000 + sequence * 137_000_000, level, module: module.into(), text: text.into(), truncated: false }
}

fn fixture_logs() -> LogsModel {
    let lines = vec![
        line(1, 3, "styk_app::top_band", "layout loaded from the profile"),
        line(2, 4, "styk_core::frames", "frame cache holds 18 of 64 pictures"),
        line(3, 2, "styk_platform::files", "the autosave folder is on a slow disk"),
        line(4, 1, "styk_core::stage", "the stage's paint worker restarted after a device loss"),
        line(5, 3, "styk_app::top_band", "workspace Animate"),
    ];
    LogsModel { filter: Filter { level: 4, module: "styk_".into(), text: String::new(), offset: 0 }, page: Page { total: 5, dropped: 12, lines } }
}

fn fixture_parameters() -> ParametersModel {
    let descriptor = |name: &str, kind: ParameterKind, default: crate::ParameterValue, unit: &str, restart: bool| Descriptor { name: name.into(), kind, default, unit: unit.into(), restart };
    let rows = vec![
        Parameter { descriptor: descriptor("capture.cap_mb", ParameterKind::Integer { min: 1, max: 256 }, 8.into(), "MiB", false), effective: 24.into(), pending: None, modified: true },
        Parameter { descriptor: descriptor("overlay.budget_ms", ParameterKind::Float { min: 4.0, max: 33.3 }, crate::ParameterValue::from(16.7), "ms", false), effective: crate::ParameterValue::from(16.7), pending: None, modified: false },
        Parameter { descriptor: descriptor("drag.preview", ParameterKind::Bool, true.into(), "", true), effective: false.into(), pending: Some(true.into()), modified: true },
        Parameter { descriptor: descriptor("brush.smoothing", ParameterKind::Enum(vec!["off".into(), "light".into(), "heavy".into()]), "light".into(), "", false), effective: "heavy".into(), pending: None, modified: true },
    ];
    ParametersModel { total: rows.len(), offset: 0, next: None, rows }
}

fn fixture_summary() -> crate::ParameterValue {
    let figures: [(&str, crate::ParameterValue); 7] = [("n", 18_432.into()), ("mean", 0.412.into()), ("p50", 0.31.into()), ("p95", 1.204.into()), ("p99", 2.87.into()), ("max", 14.6.into()), ("truncated", false.into())];
    crate::ParameterValue::Object(figures.into_iter().map(|(key, value)| (key.to_string(), value)).collect())
}

/// The screen as an element of the size `Screen::size` names.
pub fn view(screen: Screen) -> Element<'static, ()> {
    let presentation = Presentation::english();
    let palette = screen.theme().palette();
    let mut overlay_model = OverlayModel { visible: false, bounds: None, sample: Sample::default(), memory: None };
    let mut profiler_model = ProfilerModel::default();
    let mut logs_model = LogsModel::default();
    let mut parameters_model = ParametersModel::default();
    let mut input = None;
    let mut availability = Availability { start: true, stop: false, export: false, parameters: true, profiles: true };
    let (width, height) = screen.size();
    match screen.kind {
        Kind::ProfilerRecording => {
            profiler_model = ProfilerModel { recording: true, ..ProfilerModel::default() };
            availability = Availability { start: false, stop: true, ..availability };
        }
        Kind::Profiler => {
            profiler_model = ProfilerModel { bytes: 4_718_592, dropped: 3, summary: Some(fixture_summary()), can_export: true, ..ProfilerModel::default() };
            availability = Availability { export: true, ..availability };
            input = Some(CommandId::DevCaptureExport);
        }
        Kind::Logs => logs_model = fixture_logs(),
        Kind::Parameters => parameters_model = fixture_parameters(),
        Kind::Overlay => overlay_model = OverlayModel { visible: true, bounds: Some(Bounds { x: 0.0, y: 0.0, width: f64::from(width), height: f64::from(height) }), sample: fixture_sample(), memory: Some(fixture_memory()) },
    }
    let draft = if input.is_some() { "captures/session.json" } else { "" };
    let context = Context {
        overlay: &overlay_model,
        profiler: &profiler_model,
        logs: &logs_model,
        parameters: &parameters_model,
        availability,
        error: None,
        input,
        draft,
        presentation: &presentation,
        theme: screen.theme(),
        composing: false,
    };
    let field = palette.surface_field;
    let body: Element<'static, Message> = match screen.kind {
        Kind::ProfilerRecording | Kind::Profiler => profiler::view(&context),
        Kind::Logs => logs::view(&context),
        Kind::Parameters => parameters::view(&context),
        Kind::Overlay => stack![
            container(Space::new().width(Length::Fill).height(Length::Fill)).style(move |_| container::Style { background: Some(Background::Color(field.into())), ..container::Style::default() }),
            overlay::view(&context)
        ]
        .boxed(),
    };
    let fill = if screen.kind == Kind::Overlay { field } else { palette.surface };
    container(body.map(|_| ())).width(Length::Fill).height(Length::Fill).style(move |_| container::Style { background: Some(Background::Color(fill.into())), ..container::Style::default() }).boxed()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_screen_is_found_by_its_unique_id_and_has_a_size() {
        for screen in Screen::ALL {
            assert_eq!(Screen::from_id(screen.id()), Some(screen));
            assert!(screen.size().0 > 0 && screen.size().1 > 0);
            assert_eq!(screen.id().ends_with("-dark"), screen.dark);
        }
        let mut ids: Vec<_> = Screen::ALL.iter().map(|screen| screen.id()).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), Screen::ALL.len());
        assert_eq!(Screen::from_id("dev-nope"), None);
    }
}
