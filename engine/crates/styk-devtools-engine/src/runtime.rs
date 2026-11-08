//! Process-lived developer worker; all producers share the same registry and capture owner.
use crate::{
    channel::ReadHost,
    logs::{Filter, Logs, Page},
    params::{Descriptor, Kind, Registry},
    protocol::Host as _,
    sampling::Sample,
};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        mpsc::{self, Receiver, SyncSender},
    },
    time::Duration,
};
use styk_services::{
    Cancel, Clock, Spawner,
    files::{FileError, FileTarget, Files, StreamFiles},
    storage::Storage,
};

#[derive(Clone, Debug)]
pub enum Request {
    Memory,
    Sample { timings: bool, logs: Option<Filter> },
    Start,
    Stop,
    ClearCapture,
    Set { name: String, value: Value },
    Reset(String),
    SaveProfile(String),
    LoadProfile(String),
    Export(FileTarget),
    Parameters,
    ParametersPage(usize),
    Protocol { op: String, args: Value },
}
impl Request {
    fn bytes(&self) -> usize {
        match self {
            Self::Set { name, value } => name
                .capacity()
                .saturating_add(value_bytes(value, 0))
                .saturating_add(256),
            Self::Reset(s) | Self::SaveProfile(s) | Self::LoadProfile(s) => s.capacity() + 256,
            Self::Sample { logs: Some(f), .. } => f.module.capacity() + f.text.capacity() + 256,
            Self::Export(p) => p.path().as_os_str().len() * 2 + 256,
            Self::Protocol { op, args } => op
                .capacity()
                .saturating_add(value_bytes(args, 0))
                .saturating_add(256),
            _ => 256,
        }
    }
}
fn value_bytes(value: &Value, depth: usize) -> usize {
    if depth > 8 {
        return usize::MAX;
    }
    match value {
        Value::String(s) => s.capacity().saturating_add(std::mem::size_of::<Value>()),
        Value::Array(a) => {
            if a.capacity() > 256 {
                return usize::MAX;
            }
            a.iter()
                .try_fold(a.capacity() * std::mem::size_of::<Value>(), |n, v| {
                    let n = n.saturating_add(value_bytes(v, depth + 1));
                    (n <= 8192).then_some(n)
                })
                .unwrap_or(usize::MAX)
        }
        Value::Object(m) => {
            if m.len() > 32 {
                return usize::MAX;
            }
            m.iter()
                .try_fold(1024usize, |n, (k, v)| {
                    let n = n
                        .saturating_add(k.capacity())
                        .saturating_add(256)
                        .saturating_add(value_bytes(v, depth + 1));
                    (n <= 8192).then_some(n)
                })
                .unwrap_or(usize::MAX)
        }
        _ => std::mem::size_of::<Value>(),
    }
}
#[derive(Clone, Debug, Default)]
pub struct Snapshot {
    pub sample: Sample,
    pub logs: Option<Page>,
}
#[derive(Clone, Debug)]
pub struct Memory {
    pub at_ns: u64,
    pub private_before: u64,
    pub private_after: u64,
    pub video: Vec<(String, String, u64, u64)>,
    pub truncated: bool,
}
#[derive(Clone, Debug)]
pub enum Reply {
    Snapshot(Snapshot),
    Memory(Memory),
    Parameters(Vec<crate::params::Parameter>),
    ParameterPage {
        rows: Vec<crate::params::Parameter>,
        offset: usize,
        total: usize,
    },
    Value(Value),
    Stopped {
        bytes: usize,
        dropped: u64,
        summary: Value,
    },
}
struct Admission(Arc<AtomicUsize>);
impl Drop for Admission {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}
pub struct Pending {
    receive: Receiver<Result<Reply, String>>,
    cancel: Arc<Cancel>,
    _admission: Arc<Admission>,
}
impl Pending {
    pub fn take(&self) -> Option<Result<Reply, String>> {
        match self.receive.try_recv() {
            Ok(r) => Some(r),
            Err(mpsc::TryRecvError::Disconnected) => Some(Err("developer worker stopped".into())),
            Err(mpsc::TryRecvError::Empty) => None,
        }
    }
    /// Control transport only: never used on the interface thread.
    pub fn wait(&self) -> Result<Reply, String> {
        self.receive
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "developer request timed out".to_owned())?
    }
}
impl Drop for Pending {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}
struct Packet {
    request: Request,
    reply: SyncSender<Result<Reply, String>>,
    notify: Arc<dyn Fn() + Send + Sync>,
    cancel: Arc<Cancel>,
    _admission: Arc<Admission>,
    owner: Arc<AtomicU64>,
    generation: u64,
}
impl Packet {
    fn complete(self, result: Result<Reply, String>) {
        if !self.cancel.is_cancelled() {
            let _ = self.reply.try_send(result);
            (self.notify)();
        }
    }
}
enum Work {
    Request(Packet),
    Wake,
}
struct Shared {
    send: SyncSender<Work>,
    stop: Arc<AtomicBool>,
    admitted: Arc<AtomicUsize>,
}
impl Drop for Shared {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = self.send.try_send(Work::Wake);
    }
}
#[derive(Clone)]
pub struct Runtime {
    shared: Arc<Shared>,
    pub logs: Arc<Logs>,
    owner: Arc<AtomicU64>,
    pub bridge: crate::bridge::Bridge,
}
pub struct Services {
    pub spawner: Arc<dyn Spawner>,
    pub clock: Arc<dyn Clock>,
    pub files: Arc<dyn Files>,
    pub output: Arc<dyn StreamFiles>,
    pub storage: Arc<dyn Storage>,
    pub memory: Arc<dyn styk_services::diagnostics::MemoryDiagnostics>,
}
pub struct Startup {
    pub profiles: Vec<FileTarget>,
    pub overrides: Vec<String>,
}
impl Runtime {
    pub fn start(services: Services, startup: Startup) -> Result<Self, String> {
        if startup.profiles.len() > 256
            || startup.overrides.len() > 256
            || startup
                .overrides
                .iter()
                .map(String::capacity)
                .sum::<usize>()
                + startup
                    .profiles
                    .iter()
                    .map(|p| p.path().as_os_str().len() * 2)
                    .sum::<usize>()
                > crate::params::MAX_BYTES
        {
            return Err("startup parameters exceed admission bounds".into());
        }
        let (send, receive) = mpsc::sync_channel::<Work>(9); // eight admitted requests plus a reserved lifecycle wake
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let logs = Arc::new(Logs::default());
        let worker_logs = logs.clone();
        let spawner = services.spawner.clone();
        spawner.spawn("devtools.panels",Box::new(move || {
            let mut state=State::new(services,worker_logs);
            let initialized=state.startup(startup);
            let mut capture_owner:Option<(Arc<AtomicU64>,u64)>=None;
            while !stopping.load(Ordering::Acquire) {
                if capture_owner.as_ref().is_some_and(|(o,g)|o.load(Ordering::Acquire)!=*g) { state.reader.clear(); capture_owner=None; }
                let packet=match receive.recv() { Ok(Work::Request(p))=>p,Ok(Work::Wake)=>continue,Err(_)=>break };
                if packet.cancel.is_cancelled() { continue; }
                if matches!(packet.request,Request::Memory) && initialized.is_ok() {
                    let at_ns=state.services.clock.now().as_nanos().min(u128::from(u64::MAX)) as u64;
                    let reply=packet.reply.clone(); let notify=packet.notify.clone();
                    let result=state.services.memory.memory(Box::new(move |result| {
                        let result=result.map(|r|Reply::Memory(Memory{at_ns,private_before:r.private_before,private_after:r.private_after,truncated:r.truncated || r.video.len()>16,video:r.video.into_iter().take(16).map(|v|(crate::answer::text(&v.adapter),v.segment.into(),v.usage,v.budget)).collect()}));
                        packet.complete(result);
                    }));
                    if let Err(e)=result {let _=reply.try_send(Err(e));notify();}
                    continue;
                }
                let start=matches!(&packet.request,Request::Start) || matches!(&packet.request,Request::Protocol{op,..} if op=="trace.start");
                let capture_action=matches!(&packet.request,Request::Stop|Request::ClearCapture|Request::Export(_)) || matches!(&packet.request,Request::Protocol{op,..} if op=="trace.stop");
                let allowed=!capture_action || capture_owner.as_ref().is_none_or(|(o,_)|Arc::ptr_eq(o,&packet.owner));
                let result=if allowed { initialized.clone().and_then(|()| state.run(packet.request,&packet.cancel)).map_err(|e|crate::answer::text(&e)) } else {Err("capture belongs to another developer client".into())};
                if start && result.is_ok() { capture_owner=Some((packet.owner,packet.generation)); }
                let _=packet.reply.try_send(result); (packet.notify)();
            }
            // State and captures are destroyed here, never by the closing window.
        })).map_err(|e|e.to_string())?;
        Ok(Self {
            shared: Arc::new(Shared {
                send,
                stop,
                admitted: Arc::new(AtomicUsize::new(0)),
            }),
            logs,
            owner: Arc::new(AtomicU64::new(0)),
            bridge: crate::bridge::Bridge::default(),
        })
    }
    pub fn client(&self) -> Self {
        Self {
            shared: self.shared.clone(),
            logs: self.logs.clone(),
            owner: Arc::new(AtomicU64::new(0)),
            bridge: self.bridge.clone(),
        }
    }
    pub fn clear_capture(&self) {
        self.owner.fetch_add(1, Ordering::AcqRel);
        let _ = self.shared.send.try_send(Work::Wake);
    }
    pub fn submit(
        &self,
        request: Request,
        notify: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<Pending, String> {
        if request.bytes() > 8192 {
            return Err("developer request exceeds 8 KiB".into());
        }
        self.shared
            .admitted
            .try_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < 8).then_some(n + 1)
            })
            .map_err(|_| "developer replies are full")?;
        let admission = Arc::new(Admission(self.shared.admitted.clone()));
        let (reply, receive) = mpsc::sync_channel(1);
        let cancel = Arc::new(Cancel::new());
        self.shared
            .send
            .try_send(Work::Request(Packet {
                request,
                reply,
                notify,
                cancel: cancel.clone(),
                _admission: admission.clone(),
                generation: self.owner.load(Ordering::Acquire),
                owner: self.owner.clone(),
            }))
            .map_err(|_| "developer queue busy")?;
        Ok(Pending {
            receive,
            cancel,
            _admission: admission,
        })
    }
}
struct State {
    services: Services,
    reader: ReadHost,
    registry: Registry,
    logs: Arc<Logs>,
}
impl State {
    fn new(services: Services, logs: Arc<Logs>) -> Self {
        let reader = ReadHost::new(
            Arc::new(styk_services::inspection::Slot::default()),
            services.spawner.clone(),
            services.clock.clone(),
        );
        Self {
            services,
            reader,
            registry: Registry::default(),
            logs,
        }
    }
    fn startup(&mut self, startup: Startup) -> Result<(), String> {
        self.reader.state.publish(0,br#"{"host":"native-shell","documents":"unavailable: documents adapter not installed","gpu_timing":"unavailable: K-stage"}"#)?;
        self.registry.register(
            Descriptor {
                name: "capture.cap_mb".into(),
                kind: Kind::Integer { min: 1, max: 256 },
                default: json!(8),
                unit: "MiB".into(),
                restart: false,
            },
            |_| Ok(()),
        )?;
        let mut profiles = Vec::new();
        let mut left = crate::params::MAX_BYTES;
        for target in startup.profiles {
            let bytes = styk_services::worker::run_future(self.services.files.read(
                &target,
                left,
                &Cancel::new(),
            ))
            .map_err(|e| e.to_string())?;
            left = left
                .checked_sub(bytes.len())
                .ok_or("startup profiles too large")?;
            profiles.push(bytes.to_vec());
        }
        self.registry.startup(&profiles, &startup.overrides)
    }
    fn run(&mut self, request: Request, cancel: &Cancel) -> Result<Reply, String> {
        match request {
            Request::Memory => Err("memory request needs asynchronous service".into()),
            Request::Sample { timings, logs } => Ok(Reply::Snapshot(Snapshot {
                sample: if timings {
                    crate::sampling::capture(
                        self.services
                            .clock
                            .now()
                            .as_nanos()
                            .min(u128::from(u64::MAX)) as u64,
                    )?
                } else {
                    Sample::default()
                },
                logs: logs.map(|f| self.logs.page(&f)).transpose()?,
            })),
            Request::ParametersPage(offset) => Ok(Reply::ParameterPage {
                rows: self.registry.page(offset),
                offset,
                total: self.registry.len(),
            }),
            Request::Parameters => Ok(Reply::Parameters(self.registry.page(0))),
            Request::Start => self.start_capture(None),
            Request::Stop => {
                let answer = self.reader.request("trace.stop", &Value::Null)?;
                if answer["pending"] == true {
                    return Ok(Reply::Value(answer));
                }
                let capture = self.reader.capture().ok_or("capture missing")?;
                let mut durations = Vec::new();
                let mut truncated = false;
                for chunk in capture.chunks() {
                    if cancel.is_cancelled() {
                        return Err("cancelled".into());
                    }
                    let v: Value = serde_json::from_slice(chunk).map_err(|e| e.to_string())?;
                    if let Some(d) = v.get("dur").and_then(Value::as_f64) {
                        if durations.len() < 100_000 {
                            durations.push(d / 1000.);
                        } else {
                            truncated = true;
                        }
                    }
                }
                let mut summary = if durations.is_empty() {
                    json!({"n":0})
                } else {
                    crate::stats::summary(&durations)?
                };
                summary["truncated"] = json!(truncated);
                Ok(Reply::Stopped {
                    bytes: capture.bytes(),
                    dropped: capture.dropped,
                    summary,
                })
            }
            Request::ClearCapture => {
                self.reader.clear();
                Ok(Reply::Value(Value::Null))
            }
            Request::Set { name, value } => {
                let value = self.registry.set(&name, value, false)?;
                self.changed(&name, &value);
                Ok(Reply::ParameterPage {
                    rows: self.registry.page(0),
                    offset: 0,
                    total: self.registry.len(),
                })
            }
            Request::Reset(name) => {
                let value = self.registry.reset(&name)?;
                self.changed(&name, &value);
                Ok(Reply::ParameterPage {
                    rows: self.registry.page(0),
                    offset: 0,
                    total: self.registry.len(),
                })
            }
            Request::SaveProfile(name) => {
                let path = profile_path(&name)?;
                let bytes = self.registry.profile(&name)?;
                styk_services::worker::run_future(self.services.storage.update(
                    &path,
                    crate::params::MAX_BYTES,
                    Box::new(move |_| Ok(bytes)),
                    cancel,
                ))
                .map_err(|e| e.to_string())?;
                Ok(Reply::Value(json!({"saved":true})))
            }
            Request::LoadProfile(name) => {
                let path = profile_path(&name)?;
                let bytes = styk_services::worker::run_future(
                    self.services.storage.load(&path, crate::params::MAX_BYTES),
                )
                .map_err(|e| e.to_string())?
                .ok_or("profile missing")?;
                if cancel.is_cancelled() {
                    return Err("cancelled".into());
                }
                for (name, value) in self.registry.assignments(&bytes)? {
                    let value = self.registry.set(&name, value, false).map_err(|e| {
                        format!("{name}: {e}; earlier acknowledged values remain applied")
                    })?;
                    self.changed(&name, &value);
                }
                Ok(Reply::ParameterPage {
                    rows: self.registry.page(0),
                    offset: 0,
                    total: self.registry.len(),
                })
            }
            Request::Export(target) => {
                let capture = self
                    .reader
                    .capture()
                    .ok_or("stop a capture before exporting")?;
                styk_services::worker::run_future(self.services.output.replace_stream(
                    &target,
                    Box::new(|out| capture.perfetto(out).map_err(FileError::Io)),
                    cancel,
                ))
                .map_err(|e| e.to_string())?;
                Ok(Reply::Value(json!({"exported":true})))
            }
            Request::Protocol { op, args } => match op.as_str() {
                "param.set" => {
                    let name = args["name"].as_str().ok_or("param.set needs name")?;
                    let value = self.registry.set(name, args["value"].clone(), false)?;
                    self.changed(name, &value);
                    Ok(Reply::Value(json!({"value":value})))
                }
                "trace.start" => self.start_capture(args.get("cap_mb").cloned()),
                "trace.stop" => self.run(Request::Stop, cancel),
                _ => Ok(Reply::Value(self.reader.request(&op, &args)?)),
            },
        }
    }
    fn start_capture(&mut self, cap: Option<Value>) -> Result<Reply, String> {
        let cap = cap
            .or_else(|| self.registry.get("capture.cap_mb").cloned())
            .ok_or("capture cap missing")?;
        if !cap.as_u64().is_some_and(|n| (1..=256).contains(&n)) {
            return Err("capture cap must be 1..256 MiB".into());
        }
        let answer = self.reader.request("trace.start", &json!({"cap_mb":cap}))?;
        let initial: Value = serde_json::from_slice(&self.registry.profile("capture")?)
            .map_err(|e| e.to_string())?;
        if let Err(e)=self.reader.note(&json!({"name":"parameters.initial","ph":"i","s":"g","pid":1,"tid":0,"ts":self.services.clock.now().as_micros() as u64,"args":initial})) {self.reader.clear();return Err(e);}
        Ok(Reply::Value(answer))
    }
    fn changed(&self, name: &str, value: &Value) {
        let now = self
            .services
            .clock
            .now()
            .as_nanos()
            .min(u128::from(u64::MAX)) as u64;
        self.logs
            .record(now, 3, "parameters", format_args!("{name}={value}"));
        if let Err(e)=self.reader.note(&json!({"name":"parameters.changed","ph":"i","s":"g","pid":1,"tid":0,"ts":now/1000,"args":{"parameter":name,"value":value}})) {self.logs.record(now,1,"capture",format_args!("{e}"));}
    }
}
fn profile_path(name: &str) -> Result<String, String> {
    if name.is_empty()
        || name.len() > 64
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(
            "profile name must contain 1..64 letters, digits, hyphens or underscores".into(),
        );
    }
    Ok(format!("{name}.json"))
}
#[cfg(test)]
mod tests;
