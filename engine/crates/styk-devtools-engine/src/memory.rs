//! Shared, explicit memory capture used by offline CLI and developer workers.
use serde_json::{Value, json};
use styk_services::diagnostics::{MemoryDiagnostics, MemoryReport};

pub fn request(
    service: &dyn MemoryDiagnostics,
    complete: Box<dyn FnOnce(Result<Value, String>) + Send>,
) -> Result<(), String> {
    service.memory(Box::new(move |result| complete(result.map(encode))))
}
fn encode(report: MemoryReport) -> Value {
    json!({
        "private_before": report.private_before, "private_after": report.private_after,
        "regions":report.regions, "truncated":report.truncated, "limitations":report.limitations,
        "groups":report.groups.into_iter().map(|g| json!({"base":g.allocation_base,"kind":g.kind,"module":g.module,"committed":g.committed,"writable":g.writable})).collect::<Vec<_>>(),
        "video":report.video.into_iter().map(|v| json!({"adapter":v.adapter,"segment":v.segment,"budget":v.budget,"usage":v.usage,"reservation":v.reservation})).collect::<Vec<_>>()
    })
}
/// Each group is an independent bounded capture chunk; existing capture admission applies.
fn append(capture: &mut crate::capture::Capture, report: &Value) -> Result<(), String> {
    if let Some(groups) = report.get("groups").and_then(Value::as_array) {
        for group in groups {
            let chunk =
                serde_json::to_vec(&json!({"memory_group":group})).map_err(|e| e.to_string())?;
            capture.push(&chunk)?;
        }
    }
    let mut summary = report.clone();
    if let Some(object) = summary.as_object_mut() {
        object.remove("groups");
    }
    capture.push(&serde_json::to_vec(&json!({"memory":summary})).map_err(|e| e.to_string())?)
}

/// An explicit one-shot memory capture. No polling, listener or collector exists until requested.
pub fn request_capture(
    service: &dyn MemoryDiagnostics,
    cap: usize,
    complete: Box<dyn FnOnce(Result<crate::capture::Capture, String>) + Send>,
) -> Result<(), String> {
    let mut capture = crate::capture::Capture::new(cap)?;
    request(
        service,
        Box::new(move |report| {
            complete(report.and_then(|report| {
                append(&mut capture, &report)?;
                Ok(capture)
            }));
        }),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    struct Fake;
    impl MemoryDiagnostics for Fake {
        fn memory(
            &self,
            complete: Box<dyn FnOnce(Result<MemoryReport, String>) + Send>,
        ) -> Result<(), String> {
            complete(Ok(MemoryReport {
                private_before: 123,
                private_after: 124,
                ..Default::default()
            }));
            Ok(())
        }
    }
    #[test]
    fn capture_uses_service_and_preserves_evidence() {
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        request_capture(&Fake, 4096, Box::new(move |r| tx.send(r).unwrap())).unwrap();
        let capture = rx.recv().unwrap().unwrap();
        let record: Value = serde_json::from_slice(capture.chunks().next().unwrap()).unwrap();
        assert_eq!(record["memory"]["private_before"], 123);
    }
    #[test]
    fn capture_refuses_insufficient_space() {
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        request_capture(&Fake, 12, Box::new(move |r| tx.send(r).unwrap())).unwrap();
        assert!(rx.recv().unwrap().is_err());
    }
}
