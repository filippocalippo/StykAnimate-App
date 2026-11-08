//! Opt-in control channel. A worker answers published read models; owner operations use a bounded inbox.
use crate::{
    drain::Drain,
    protocol::{self, Host},
};
use serde_json::{Value, json};
use std::sync::Arc;
use styk_services::{
    Spawner,
    clock::Clock,
    control::{Inbox, Running, Transport},
};
pub struct Channel {
    pub inbox: Arc<Inbox>,
    _server: Box<dyn Running>,
}
impl Channel {
    pub fn start(
        transport: &dyn Transport,
        spawner: &dyn Spawner,
        endpoint: &str,
    ) -> Result<Self, String> {
        let inbox = Arc::new(Inbox::default());
        let server = transport.serve(spawner, endpoint, inbox.clone())?;
        Ok(Self {
            inbox,
            _server: server,
        })
    }
    /// Worker-only dispatch, at most one message per turn. The interface only publishes the fixed-size Slot.
    pub fn poll(&self, host: &mut impl Host) -> Result<bool, String> {
        let Some(request) = self.inbox.pop() else {
            return Ok(false);
        };
        if request.is_cancelled() {
            return Ok(true);
        }
        let response = match serde_json::from_slice::<Value>(&request.bytes) {
            Ok(value) => protocol::respond(value, host),
            Err(_) => protocol::respond(Value::Null, host),
        };
        request.respond(response)?;
        Ok(true)
    }
}
pub struct Reader {
    stop: std::sync::mpsc::SyncSender<()>,
}
impl Drop for Reader {
    fn drop(&mut self) {
        let _ = self.stop.try_send(());
    }
}
/// Start only on explicit request. App adapters publish a fixed-size state record, never service tool work in view/update.
pub fn start_reader(
    endpoint: &str,
    state: Arc<styk_services::inspection::Slot>,
    spawner: Arc<dyn Spawner>,
    clock: Arc<dyn Clock>,
) -> Result<Reader, String> {
    let channel = Channel::start(&styk_platform::LocalControl, &*spawner, endpoint)?;
    let mut host = ReadHost::new(state, spawner.clone(), clock);
    let (stop, receiver) = std::sync::mpsc::sync_channel(1);
    spawner
        .spawn(
            "devtools.control",
            Box::new(move || {
                loop {
                    let _ = channel.poll(&mut host);
                    match receiver.recv_timeout(std::time::Duration::from_millis(10)) {
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                        _ => break,
                    }
                }
            }),
        )
        .map_err(|e| e.to_string())?;
    Ok(Reader { stop })
}
/// The shell currently has no documents owner; publish only facts it owns.
pub fn shell_reader() -> Result<Reader, String> {
    let state = Arc::new(styk_services::inspection::Slot::default());
    state.publish(0,br#"{"host":"native-shell","documents":"unavailable: documents adapter not installed","gpu_timing":"unavailable: K-stage"}"#)?;
    start_reader(
        &format!("stykanimate-dev-{}", std::process::id()),
        state,
        Arc::new(styk_platform::spawn::ThreadSpawner),
        styk_trace::clock::current().ok_or("initialize the developer clock before control")?,
    )
}
/// Snapshot-only host, also usable by app adapters. No document data is obtained implicitly.
pub struct ReadHost {
    pub state: Arc<styk_services::inspection::Slot>,
    pub spawner: Arc<dyn Spawner>,
    pub clock: Arc<dyn Clock>,
    drain: Option<Drain>,
    capture: Option<crate::capture::Capture>,
    document: Option<styk_core::inspect::DocumentSnapshot>,
}
impl ReadHost {
    pub fn new(
        state: Arc<styk_services::inspection::Slot>,
        spawner: Arc<dyn Spawner>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self {
            state,
            spawner,
            clock,
            drain: None,
            capture: None,
            document: None,
        }
    }
    /// An explicit document-inspection request pins the owner's immutable ticket, on this worker.
    pub fn set_document(&mut self, document: Option<styk_core::inspect::DocumentSnapshot>) {
        self.document = document;
    }
    pub fn take_capture(&mut self) -> Option<crate::capture::Capture> {
        self.capture.take()
    }
}
impl Host for ReadHost {
    fn request(&mut self, op: &str, args: &Value) -> Result<Value, String> {
        match op {
            "doc.tree" | "doc.node" => {
                let document = self
                    .document
                    .as_ref()
                    .ok_or("document inspection was not requested from its owner")?;
                if args
                    .get("revision")
                    .and_then(Value::as_u64)
                    .is_some_and(|r| r != document.revision)
                {
                    return Err("inspection revision changed; restart paging".into());
                }
                let path = args
                    .get("path")
                    .and_then(Value::as_array)
                    .map(Vec::as_slice)
                    .unwrap_or(&[]);
                if path.len() > 32 {
                    return Err("inspection path too deep".into());
                }
                let path: Vec<_> = path
                    .iter()
                    .map(|p| p.as_str().ok_or("path components must be strings"))
                    .collect::<Result<_, _>>()?;
                let node = |n: styk_core::inspect::Node| json!({"key":n.key,"kind":n.kind,"children":n.children,"value":n.value,"truncated":n.truncated});
                if op == "doc.node" {
                    Ok(json!({"revision":document.revision,"node":node(document.node_raw(&path)?)}))
                } else {
                    let offset =
                        usize::try_from(args.get("cursor").and_then(Value::as_u64).unwrap_or(0))
                            .map_err(|_| "cursor exceeds address space")?;
                    let page = document.tree(&path, offset)?;
                    Ok(
                        json!({"revision":document.revision,"rows":page.rows.into_iter().map(node).collect::<Vec<_>>(),"n_total":page.n_total,"offset":offset,"more":page.more}),
                    )
                }
            }
            "state.get" => {
                let state = self.state.read()?.ok_or("owner snapshot not ready")?;
                serde_json::from_slice(state.bytes()).map_err(|e| e.to_string())
            }
            "metrics.get" => Ok(
                json!({"trace":{"ring_bytes":styk_trace::ring_bytes(),"dropped":styk_trace::dropped(),"clock_missing":styk_trace::clock::missing_reads()},"inspection_refused":self.state.refused(),"capture_accounting":crate::capture::accounting(),"drain_accounting":crate::drain::accounting(),"control_accounting":styk_platform::LocalControl::accounting()}),
            ),
            "trace.start" => {
                if self.drain.is_some() {
                    return Err("capture already active".into());
                }
                let mb = args.get("cap_mb").and_then(Value::as_u64).unwrap_or(8);
                let cap = usize::try_from(mb)
                    .ok()
                    .and_then(|n| n.checked_mul(1024 * 1024))
                    .ok_or("capture cap overflow")?;
                let drain = Drain::start(&*self.spawner, self.clock.clone(), cap)?;
                self.capture = None;
                self.drain = Some(drain);
                Ok(json!({"started":true,"cap_bytes":cap}))
            }
            "trace.stop" => {
                let drain = self.drain.as_ref().ok_or("no active capture")?;
                drain.stop();
                if let Some(result) = drain.take() {
                    self.drain = None;
                    let capture = result?;
                    let answer =
                        json!({"stopped":true,"bytes":capture.bytes(),"dropped":capture.dropped});
                    self.capture = Some(capture);
                    Ok(answer)
                } else {
                    Ok(json!({"stopped":false,"pending":true,"retry":"trace.stop"}))
                }
            }
            "trace.ring" | "threads.get" => {
                let offset = usize::try_from(args.get("cursor").and_then(Value::as_u64).unwrap_or(0))
                    .map_err(|_| "cursor exceeds address space")?;
                if op == "trace.ring" {
                    let records = styk_trace::snapshot();
                    let rows: Vec<_> = records
                        .iter()
                        .skip(offset)
                        .take(50)
                        .map(crate::capture::event)
                        .collect();
                    let end = offset.saturating_add(rows.len());
                    Ok(
                        json!({"rows":rows,"offset":offset,"n_total":records.len(),"more":(end<records.len()).then_some(end)}),
                    )
                } else {
                    let threads = styk_trace::threads();
                    let rows: Vec<_> = threads
                        .iter()
                        .skip(offset)
                        .take(50)
                        .map(|thread| json!({"id":thread.id,"name":&*thread.name,"open_spans":styk_trace::open_spans(thread.id).len()}))
                        .collect();
                    let end = offset.saturating_add(rows.len());
                    Ok(
                        json!({"rows":rows,"offset":offset,"n_total":threads.len(),"more":(end<threads.len()).then_some(end)}),
                    )
                }
            }
            _ => Err(format!(
                "{op} needs its owning core adapter; not available on a snapshot-only host"
            )),
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn threads_include_an_open_span_before_its_first_completed_event() {
        let _serial = crate::TRACE_TEST_LOCK.lock().unwrap();
        let _span = styk_trace::span!("channel.inspect_open");
        let id = styk_trace::threads()
            .into_iter()
            .find(|thread| {
                styk_trace::open_spans(thread.id)
                    .iter()
                    .any(|span| span.name == "channel.inspect_open")
            })
            .unwrap()
            .id;
        let mut host = ReadHost::new(
            Arc::new(styk_services::inspection::Slot::default()),
            Arc::new(styk_services::ManualSpawner::new()),
            Arc::new(styk_services::clock::FixedClock::new()),
        );
        let result = host.request("threads.get", &json!({})).unwrap();
        assert!(
            result["rows"]
                .as_array()
                .unwrap()
                .iter()
                .any(|row| row["id"] == id && row["open_spans"].as_u64().unwrap() > 0)
        );
    }
    #[test]
    fn a_real_pipe_answers_only_published_snapshots() {
        let state = Arc::new(styk_services::inspection::Slot::default());
        state.publish(7, br#"{"revision":7}"#).unwrap();
        let spawner = Arc::new(styk_platform::spawn::ThreadSpawner);
        let clock = Arc::new(styk_platform::clock::SystemClock::new());
        let endpoint = format!("stykanimate-dev-{}-read-host", std::process::id());
        let reader = start_reader(&endpoint, state, spawner.clone(), clock.clone()).unwrap();
        let operation = styk_platform::LocalControl
            .request(
                &*spawner,
                &endpoint,
                br#"{"id":9,"op":"state.get"}"#.to_vec(),
            )
            .unwrap();
        loop {
            if let Some(answer) = operation.take() {
                let answer: Value = serde_json::from_slice(&answer.unwrap()).unwrap();
                assert_eq!(answer["id"], 9);
                assert_eq!(answer["result"]["revision"], 7);
                break;
            }
            assert!(clock.now() < std::time::Duration::from_secs(5));
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        drop(reader);
    }
}
