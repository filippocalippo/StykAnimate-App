//! Toolkit-free panel owner. The application feeds only effects emitted by Core::dispatch.
use std::sync::Arc;
use styk_core::dev_extension::{Event, Panel, Value, notice};
use styk_core::i18n::Msg;
use styk_devtools_engine::{
    ParameterValue,
    logs::{Filter, Page},
    params::Parameter,
    runtime::{Pending, Reply, Request, Runtime},
    sampling::Sample,
};
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
#[derive(Clone, Debug)]
pub struct OverlayModel {
    pub visible: bool,
    pub bounds: Option<Bounds>,
    pub sample: Sample,
    pub memory: Option<styk_devtools_engine::runtime::Memory>,
}
#[derive(Clone, Debug, Default)]
pub struct ProfilerModel {
    pub recording: bool,
    pub stopping: bool,
    pub bytes: usize,
    pub dropped: u64,
    pub summary: Option<ParameterValue>,
    pub can_export: bool,
}
#[derive(Clone, Debug, Default)]
pub struct LogsModel {
    pub filter: Filter,
    pub page: Page,
    pub previous: Option<usize>,
}
impl LogsModel {
    /// The offset of the page after this one (the documented cursor: offset plus the rows returned).
    pub fn next(&self) -> Option<usize> {
        let end = self.filter.offset.saturating_add(self.page.lines.len());
        (!self.page.lines.is_empty() && end < self.page.total).then_some(end)
    }
    /// The offset of the page before this one.
    pub fn previous(&self) -> Option<usize> {
        self.previous
    }
}
#[derive(Clone, Debug, Default)]
pub struct ParametersModel {
    pub rows: Vec<Parameter>,
    pub offset: usize,
    pub total: usize,
    pub next: Option<usize>,
    pub previous: Option<usize>,
}
impl ParametersModel {
    /// The offset of the page before this one.
    pub fn previous(&self) -> Option<usize> {
        self.previous
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Availability {
    pub start: bool,
    pub stop: bool,
    pub export: bool,
    pub parameters: bool,
    pub profiles: bool,
}
#[derive(Clone, Copy, Debug)]
pub struct PanelDescriptor {
    pub panel: Panel,
    pub title: &'static str,
    pub mark: &'static str,
    pub icon: &'static str,
}
pub const DESCRIPTORS: [PanelDescriptor; 3] = [
    PanelDescriptor {
        panel: Panel::Profiler,
        title: "dev.profiler",
        mark: "dev.mark",
        icon: Panel::Profiler.icon(),
    },
    PanelDescriptor {
        panel: Panel::Logs,
        title: "dev.logs",
        mark: "dev.mark",
        icon: Panel::Logs.icon(),
    },
    PanelDescriptor {
        panel: Panel::Parameters,
        title: "dev.parameters",
        mark: "dev.mark",
        icon: Panel::Parameters.icon(),
    },
];
#[derive(Clone, Copy)]
enum Intent {
    Start,
    Stop,
    Export,
    Other,
    Channel,
    Refresh(u64),
}
#[derive(Default)]
struct Cursors {
    current: usize,
    previous: std::collections::VecDeque<usize>,
}
impl Cursors {
    fn visit(&mut self, offset: usize) -> Option<usize> {
        if offset == 0 {
            self.previous.clear();
        } else if offset != self.current {
            if let Some(at) = self.previous.iter().position(|v| *v == offset) {
                self.previous.truncate(at);
            } else {
                if self.previous.len() == 256 {
                    self.previous.pop_front();
                }
                self.previous.push_back(self.current);
            }
        }
        self.current = offset;
        self.previous.back().copied()
    }
}
pub struct Host {
    log_cursors: Cursors,
    parameter_cursors: Cursors,
    runtime: Runtime,
    notify: Arc<dyn Fn() + Send + Sync>,
    open: [bool; 3],
    requested_overlay: bool,
    next_sample: Option<u64>,
    stop_retry: Option<u64>,
    stop: Option<Pending>,
    refresh: Option<(u64, usize)>,
    refresh_id: u64,
    refresh_retry: Option<u64>,
    pending: Option<(Pending, Intent)>,
    sample: Option<Pending>,
    memory: Option<Pending>,
    next_memory: Option<u64>,
    pub overlay: OverlayModel,
    pub profiler: ProfilerModel,
    pub logs: LogsModel,
    pub parameters: ParametersModel,
    pub error: Option<Msg>,
    pub control_result: Option<Result<ParameterValue, String>>,
    pub input: Option<styk_core::dev_extension::CommandId>,
    /// The text typed for the open argument request; bounded, and gone when the request ends.
    pub draft: String,
}
impl Host {
    pub fn new(runtime: Runtime, notify: Arc<dyn Fn() + Send + Sync>) -> Self {
        Self {
            log_cursors: Cursors::default(),
            parameter_cursors: Cursors::default(),
            runtime: runtime.client(),
            notify,
            open: [false; 3],
            requested_overlay: false,
            next_sample: None,
            stop_retry: None,
            stop: None,
            refresh: None,
            refresh_id: 0,
            refresh_retry: None,
            pending: None,
            sample: None,
            input: None,
            draft: String::new(),
            memory: None,
            next_memory: None,
            control_result: None,
            overlay: OverlayModel {
                visible: false,
                bounds: None,
                sample: Sample::default(),
                memory: None,
            },
            profiler: ProfilerModel::default(),
            logs: LogsModel::default(),
            parameters: ParametersModel::default(),
            error: None,
        }
    }
    /// Bounds and open membership are supplied by the dock owner, never inferred by a view.
    pub fn reconcile(&mut self, open: [bool; 3], stage: Option<Bounds>, now: u64) {
        if self.open[0] && !open[0] {
            self.runtime.clear_capture();
            self.profiler = ProfilerModel::default();
            self.stop_retry = None;
            self.stop = None;
            if self
                .pending
                .as_ref()
                .is_some_and(|(_, i)| matches!(i, Intent::Start | Intent::Stop | Intent::Export))
            {
                self.pending = None;
            }
        }
        if self.open[1] && !open[1] {
            self.logs.page = Page::default();
        }
        if self.open[2] && !open[2] {
            self.parameters = ParametersModel::default();
            self.parameter_cursors = Cursors::default();
            self.refresh = None;
            self.refresh_retry = None;
            if self
                .pending
                .as_ref()
                .is_some_and(|(_, i)| matches!(i, Intent::Refresh(_)))
            {
                self.pending = None;
            }
        }
        let parameters_opened = !self.open[2] && open[2];
        self.open = open;
        self.overlay.bounds = stage;
        self.overlay.visible = self.requested_overlay && stage.is_some();
        if self.overlay.visible {
            self.next_memory.get_or_insert(now);
        } else {
            self.next_memory = None;
            self.memory = None;
            self.overlay.memory = None;
        }
        if self.overlay.visible || open[1] {
            self.next_sample.get_or_insert(now);
        } else {
            self.next_sample = None;
            self.sample = None;
            self.overlay.sample = Sample::default();
        }
        if parameters_opened {
            self.request_refresh(0, now);
        }
        self.try_refresh(now);
    }
    pub fn deadline(&self) -> Option<u64> {
        [
            self.next_sample,
            self.next_memory,
            self.stop_retry,
            self.refresh_retry.filter(|_| self.pending.is_none()),
        ]
        .into_iter()
        .flatten()
        .min()
    }
    pub fn busy(&self) -> bool {
        self.pending.is_some() || self.stop.is_some()
    }
    pub fn availability(&self) -> Availability {
        let ready = !self.busy();
        Availability {
            start: ready && self.open[0] && !self.profiler.recording,
            stop: self.profiler.recording && !self.profiler.stopping,
            export: ready && self.profiler.can_export,
            parameters: ready,
            profiles: ready,
        }
    }
    pub fn is_open(&self, panel: Panel) -> bool {
        self.open[match panel {
            Panel::Profiler => 0,
            Panel::Logs => 1,
            Panel::Parameters => 2,
        }]
    }
    pub fn update(&mut self, event: Event, now: u64) {
        match event {
            Event::Input(id) => {
                if id.is_none() || id != self.input {
                    self.draft.clear();
                }
                self.input = id;
            }
            Event::Draft(text) => {
                if self.input.is_none() {
                    return;
                }
                if text.len() > 2048 {
                    self.error = Some(notice("text exceeds 2 KiB"));
                    return;
                }
                self.draft = text.as_str().to_owned();
            }
            Event::Panel { .. } => {
                // Membership was accepted by the dock before this effect.
                if self.input == Some(styk_core::dev_extension::CommandId::DevPanelClose) {
                    self.input = None;
                    self.draft.clear();
                }
            }
            Event::Overlay(on) => {
                self.requested_overlay = on;
                self.overlay.visible = on && self.overlay.bounds.is_some();
                if self.overlay.visible {
                    self.next_sample = Some(now);
                } else if !self.open[1] {
                    self.next_sample = None;
                    self.sample = None;
                }
            }
            Event::ToggleOverlay => self.update(Event::Overlay(!self.requested_overlay), now),
            Event::Start => {
                if self.open[0] {
                    self.issue(Request::Start, Intent::Start);
                } else {
                    self.error = Some(notice("open the profiler first"));
                }
            }
            Event::Stop => {
                if self.profiler.recording && !self.profiler.stopping {
                    self.profiler.stopping = true;
                    self.stop_retry = Some(now);
                    self.try_stop(now);
                }
            }
            Event::Export(target) => self.issue(Request::Export(target), Intent::Export),
            Event::Set { name, value } => {
                let value = match value {
                    Value::Float(v) if v.is_finite() => ParameterValue::from(v),
                    Value::Float(_) => {
                        self.error = Some(notice("expected finite number"));
                        return;
                    }
                    Value::Integer(v) => ParameterValue::from(v),
                    Value::Bool(v) => ParameterValue::from(v),
                    Value::Enum(v) => ParameterValue::from(v),
                };
                self.issue(Request::Set { name, value }, Intent::Other);
            }
            Event::ChannelSet { name, value } => {
                let value = match value {
                    Value::Float(v) if v.is_finite() => ParameterValue::from(v),
                    Value::Float(_) => {
                        self.control_result = Some(Err("expected finite number".into()));
                        return;
                    }
                    Value::Integer(v) => ParameterValue::from(v),
                    Value::Bool(v) => ParameterValue::from(v),
                    Value::Enum(v) => ParameterValue::from(v),
                };
                self.issue(
                    Request::Protocol {
                        op: "param.set".into(),
                        args: ParameterValue::Object(
                            [
                                ("name".into(), ParameterValue::from(name)),
                                ("value".into(), value),
                            ]
                            .into_iter()
                            .collect(),
                        ),
                    },
                    Intent::Channel,
                );
            }
            Event::Step { name, direction } => self.edit_parameter(&name, Some(direction), None),
            Event::Toggle(name) => self.edit_parameter(&name, None, None),
            Event::Choose { name, index } => self.edit_parameter(&name, None, Some(index)),
            Event::Reset(name) => self.issue(Request::Reset(name), Intent::Other),
            Event::ParametersPage(offset) => self.request_refresh(offset, now),
            Event::SaveProfile(name) => self.issue(Request::SaveProfile(name), Intent::Other),
            Event::LoadProfile(name) => self.issue(Request::LoadProfile(name), Intent::Other),
            Event::Filter {
                level,
                module,
                text,
            } => {
                if module.len() + text.len() > 2048 {
                    self.error = Some(notice("log filter exceeds 2 KiB"));
                    return;
                }
                self.logs.filter = Filter {
                    level,
                    module: module.as_str().to_owned(),
                    text: text.as_str().to_owned(),
                    offset: 0,
                };
                self.log_cursors = Cursors::default();
                self.logs.previous = None;
                if self.input == Some(styk_core::dev_extension::CommandId::DevLogsFilter) {
                    self.input = None;
                    self.draft.clear();
                }
                self.sample = None;
                self.logs.page = Page::default();
                if self.open[1] {
                    self.next_sample = Some(now);
                }
            }
            Event::LogsPage(offset) => {
                if Some(offset) == self.logs.next() || Some(offset) == self.logs.previous() {
                    self.logs.filter.offset = offset;
                    self.sample = None;
                    self.logs.page = Page::default();
                    if self.open[1] {
                        self.next_sample = Some(now);
                    }
                }
            }
            Event::Poll => self.poll(now),
            Event::Tick(at) => self.tick(at),
        }
    }
    fn edit_parameter(&mut self, name: &str, step: Option<i32>, choice: Option<usize>) {
        use styk_devtools_engine::params::Kind;
        let Some(row) = self
            .parameters
            .rows
            .iter()
            .find(|p| p.descriptor.name == name)
        else {
            self.error = Some(notice("parameter is not on the current page"));
            return;
        };
        let value = row.pending.as_ref().unwrap_or(&row.effective);
        let value = match (&row.descriptor.kind, step, choice) {
            (Kind::Integer { .. }, Some(n), None) => value
                .as_i64()
                .map(|v| ParameterValue::from(v.saturating_add(i64::from(n.signum())))),
            (Kind::Float { min, max }, Some(n), None) => value.as_f64().map(|v| {
                ParameterValue::from(
                    v + (if max > min { (max - min) / 100.0 } else { 1.0 }) * f64::from(n.signum()),
                )
            }),
            (Kind::Bool, None, None) => value.as_bool().map(|v| ParameterValue::from(!v)),
            (Kind::Enum(options), None, Some(i)) => {
                options.get(i).cloned().map(ParameterValue::from)
            }
            _ => None,
        };
        if let Some(value) = value {
            self.issue(
                Request::Set {
                    name: name.into(),
                    value,
                },
                Intent::Other,
            );
        } else {
            self.error = Some(notice("invalid parameter operation"));
        }
    }
    fn request_refresh(&mut self, offset: usize, now: u64) {
        self.refresh_id = self.refresh_id.wrapping_add(1);
        self.refresh = Some((self.refresh_id, offset));
        self.refresh_retry = None;
        self.try_refresh(now);
    }
    fn try_refresh(&mut self, now: u64) {
        let Some((id, offset)) = self.refresh else {
            return;
        };
        if self.pending.is_some() || self.refresh_retry.is_some_and(|at| now < at) {
            return;
        }
        match self
            .runtime
            .submit(Request::ParametersPage(offset), self.notify.clone())
        {
            Ok(p) => {
                self.pending = Some((p, Intent::Refresh(id)));
                self.refresh_retry = None;
            }
            Err(e) => {
                self.error = Some(notice(e));
                self.refresh_retry = Some(now.saturating_add(50));
            }
        }
    }
    fn try_stop(&mut self, now: u64) {
        if self.stop.is_some() || !self.stop_retry.is_some_and(|at| now >= at) {
            return;
        }
        match self.runtime.submit(Request::Stop, self.notify.clone()) {
            Ok(p) => {
                self.stop = Some(p);
                self.stop_retry = None;
                self.error = None;
            }
            Err(e) => {
                self.error = Some(notice(e));
                self.stop_retry = Some(now.saturating_add(50));
            }
        }
    }
    fn issue(&mut self, request: Request, intent: Intent) {
        use styk_core::dev_extension::CommandId as Id;
        let consumes_input = matches!(
            (&request, self.input),
            (Request::Set { .. }, Some(Id::DevParameterSet))
                | (Request::Reset(_), Some(Id::DevParameterReset))
                | (Request::SaveProfile(_), Some(Id::DevProfileSave))
                | (Request::LoadProfile(_), Some(Id::DevProfileLoad))
                | (Request::Export(_), Some(Id::DevCaptureExport))
        );
        if self.pending.is_some() {
            let e = "developer action is busy; retry when complete";
            self.error = Some(notice(e));
            if matches!(intent, Intent::Channel) {
                self.control_result = Some(Err(e.into()));
            }
            return;
        }
        match self.runtime.submit(request, self.notify.clone()) {
            Ok(p) => {
                self.pending = Some((p, intent));
                if consumes_input {
                    self.input = None;
                    self.draft.clear();
                }
                self.error = None;
            }
            Err(e) => {
                if matches!(intent, Intent::Channel) {
                    self.control_result = Some(Err(e.clone()));
                }
                self.error = Some(notice(e));
            }
        }
    }
    fn tick(&mut self, now: u64) {
        self.poll(now);
        if self.next_sample.is_some_and(|at| now >= at) {
            self.next_sample = Some(now.saturating_add(250)); // missed periods coalesce
            if self.sample.is_none() {
                match self.runtime.submit(
                    Request::Sample {
                        timings: self.overlay.visible,
                        logs: self.open[1].then(|| self.logs.filter.clone()),
                    },
                    self.notify.clone(),
                ) {
                    Ok(p) => self.sample = Some(p),
                    Err(e) => self.error = Some(notice(e)),
                }
            }
        }
        if self.next_memory.is_some_and(|at| now >= at) {
            self.next_memory = Some(now.saturating_add(500));
            if self.memory.is_none() {
                match self.runtime.submit(Request::Memory, self.notify.clone()) {
                    Ok(p) => self.memory = Some(p),
                    Err(e) => self.error = Some(notice(e)),
                }
            }
        }
    }
    fn poll(&mut self, now: u64) {
        if let Some(result) = self.stop.as_ref().and_then(Pending::take) {
            self.stop = None;
            self.action_reply(Some(Intent::Stop), result, now);
        }
        if let Some(result) = self.memory.as_ref().and_then(Pending::take) {
            self.memory = None;
            match result {
                Ok(Reply::Memory(m)) => self.overlay.memory = Some(m),
                Err(e) => self.error = Some(notice(e)),
                _ => self.error = Some(notice("unexpected memory response")),
            }
        }
        if let Some(result) = self.sample.as_ref().and_then(Pending::take) {
            self.sample = None;
            match result {
                Ok(Reply::Snapshot(s)) => {
                    if self.overlay.visible {
                        self.overlay.sample = s.sample;
                    }
                    if let Some(p) = s.logs {
                        self.logs.previous = self.log_cursors.visit(self.logs.filter.offset);
                        self.logs.page = p;
                    }
                }
                Err(e) => self.error = Some(notice(e)),
                _ => self.error = Some(notice("unexpected sampling response")),
            }
        }
        if let Some(result) = self.pending.as_ref().and_then(|(p, _)| p.take()) {
            let intent = self.pending.take().map(|(_, i)| i);
            self.action_reply(intent, result, now);
        }
        self.try_stop(now);
        self.try_refresh(now);
    }
    fn action_reply(&mut self, intent: Option<Intent>, result: Result<Reply, String>, now: u64) {
        if let Some(Intent::Refresh(id)) = intent {
            if !self.refresh.is_some_and(|(current, _)| current == id) {
                return;
            }
            self.refresh = None;
            self.refresh_retry = None;
            // A worker failure is visible and terminal; admission failures retain the intent.
            if result.is_ok() {
                self.error = None;
            }
        }
        if matches!(intent, Some(Intent::Channel)) {
            self.control_result = Some(match result {
                Ok(Reply::Value(v)) => Ok(v),
                Err(e) => Err(e),
                _ => Err("unexpected parameter acknowledgement".into()),
            });
            if self.open[2] && self.control_result.as_ref().is_some_and(Result::is_ok) {
                self.request_refresh(self.parameters.offset, now);
            }
            return;
        }
        match result {
            Err(e) => {
                self.error = Some(notice(e));
                if matches!(intent, Some(Intent::Stop)) {
                    self.profiler.stopping = false;
                    self.stop_retry = None;
                }
            }
            Ok(Reply::Parameters(rows)) => {
                self.parameters.rows = rows;
                self.parameters.offset = 0;
            }
            Ok(Reply::ParameterPage {
                rows,
                offset,
                total,
            }) => {
                let end = offset.saturating_add(rows.len());
                self.parameters = ParametersModel {
                    rows,
                    offset,
                    total,
                    next: (end < total).then_some(end),
                    previous: self.parameter_cursors.visit(offset),
                };
            }
            Ok(Reply::Stopped {
                bytes,
                dropped,
                summary,
            }) => {
                self.profiler = ProfilerModel {
                    bytes,
                    dropped,
                    summary: Some(summary),
                    can_export: true,
                    ..ProfilerModel::default()
                };
                self.stop_retry = None;
            }
            Ok(Reply::Value(value)) => match intent {
                Some(Intent::Start) => {
                    self.profiler = ProfilerModel {
                        recording: true,
                        ..ProfilerModel::default()
                    };
                }
                Some(Intent::Stop) if value["pending"] == true => {
                    self.profiler.stopping = true;
                    self.stop_retry = Some(now.saturating_add(50));
                }
                _ => {}
            },
            Ok(Reply::Snapshot(_) | Reply::Memory(_)) => {
                self.error = Some(notice("unexpected action response"))
            }
        }
    }
}
impl Drop for Host {
    fn drop(&mut self) {
        self.runtime.clear_capture();
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use styk_devtools_engine::logs::Line;
    fn line(sequence: u64) -> Line {
        Line {
            sequence,
            time_ns: 0,
            level: 3,
            module: "m".into(),
            text: "t".into(),
            truncated: false,
        }
    }
    #[test]
    fn log_pager_cursors_follow_the_returned_rows() {
        let mut model = LogsModel::default();
        assert_eq!(
            (model.next(), model.previous()),
            (None, None),
            "an empty page has neither"
        );
        model.page = Page {
            lines: (0..50).map(line).collect(),
            total: 120,
            dropped: 0,
        };
        assert_eq!((model.next(), model.previous()), (Some(50), None));
        model.filter.offset = 50;
        model.previous = Some(0);
        assert_eq!((model.next(), model.previous()), (Some(100), Some(0)));
        model.filter.offset = 100;
        model.previous = Some(50);
        model.page = Page {
            lines: (0..20).map(line).collect(),
            total: 120,
            dropped: 0,
        };
        assert_eq!(
            (model.next(), model.previous()),
            (None, Some(50)),
            "the last page has no next"
        );
    }
    #[test]
    fn parameter_pager_previous_steps_back_by_the_rows_shown() {
        let mut model = ParametersModel::default();
        assert_eq!(model.previous(), None);
        model.offset = 7;
        assert_eq!(
            model.previous(),
            None,
            "unknown predecessors are not guessed"
        );
    }
}
