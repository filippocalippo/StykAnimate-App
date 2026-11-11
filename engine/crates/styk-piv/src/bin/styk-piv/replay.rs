//! Replays requests recorded from the Python codec (`engine/tools/piv/oracle.py`)
//! against the Rust codec and compares every response.
//!
//! What "the same response" means, per kind of body:
//!
//! - JSON: the same document. Keys in the same order, strings identical,
//!   numbers the same IEEE doubles (`1` and `1.0` are equal; `-0` and `0` are
//!   not). The values of `decode_ms`, `total_ms` and `document_bytes` under
//!   `timings` are not compared; their keys are.
//! - `STYKPIV1`: the JSON header by the rule above, the frame bytes identical.
//! - exported `.piv`/`.stk` files and source records: identical bytes.
//! - exported native containers: the documents they hold, by the JSON rule
//!   (their bytes are the container crate's contract, not this one's).
//! - errors: the same status, `code` and message.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

use styk_doc::Value;
use styk_piv::{Codec, Limits, Response};

/// Fields of `/api/health` that name the implementation.
const HEALTH_IDENTITY: [&str; 4] = ["jsonEncoder", "processMemoryMiB", "nativeFrameScanner", "nativeFrameScannerInfo"];
/// Timing values that differ between runs and encoders.
const VOLATILE_TIMINGS: [&str; 3] = ["decode_ms", "total_ms", "document_bytes"];

#[derive(Default)]
pub struct Tally {
    pub same: usize,
    pub different: usize,
}

#[derive(Default)]
pub struct Summary {
    pub scenarios: usize,
    pub steps: usize,
    pub by_kind: BTreeMap<&'static str, Tally>,
    pub message_differences: usize,
    pub failures: Vec<String>,
    pub slowest: Vec<(f64, f64, String)>,
}

pub struct Options {
    pub only: Vec<String>,
    pub dump: bool,
    pub verbose: bool,
}

fn text(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

fn pairs(value: Option<&Value>) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for pair in value.and_then(Value::as_arr).unwrap_or(&[]) {
        if let Some(items) = pair.as_arr()
            && let (Some(name), Some(text)) = (items.first().and_then(Value::as_str), items.get(1).and_then(Value::as_str))
        {
            out.push((name.to_string(), text.to_string()));
        }
    }
    out
}

fn limits_of(name: &str) -> Limits {
    // The oracle is always a `BrowserCodec`, so `host` is "browser" whatever the sizes.
    let desktop = Limits { host: Some("browser"), ..Limits::desktop() };
    match name {
        "web" => Limits::web(),
        "tiny" => Limits { max_source: 1024, max_document: 2048, max_retained_sources: 1024, ..Limits::web() },
        other => match other.strip_prefix("retained:").and_then(|n| n.parse().ok()) {
            Some(bytes) => Limits { max_retained_sources: bytes, ..desktop },
            None => desktop,
        },
    }
}

/// Where two documents first differ, or `None` when they are the same document.
fn difference(expected: &Value, actual: &Value, path: &mut String, skip: &dyn Fn(&str) -> bool) -> Option<String> {
    match (expected, actual) {
        (Value::Null, Value::Null) => None,
        (Value::Bool(a), Value::Bool(b)) if a == b => None,
        (Value::Num(a), Value::Num(b)) => (a.to_bits() != b.to_bits()).then(|| format!("{path}: number {a:?} != {b:?}")),
        (Value::Str(_) | Value::Blob(_), Value::Str(_) | Value::Blob(_)) => {
            if matches!((expected, actual), (Value::Blob(a), Value::Blob(b)) if a.prefix == b.prefix && a.bytes == b.bytes) {
                return None;
            }
            let (a, b) = (expected.text().unwrap_or_default(), actual.text().unwrap_or_default());
            (a != b).then(|| {
                let at = a.bytes().zip(b.bytes()).position(|(x, y)| x != y).unwrap_or(a.len().min(b.len()));
                let cut = |s: &str| s.chars().skip(at.saturating_sub(20)).take(60).collect::<String>();
                format!("{path}: strings differ at byte {at} (lengths {} and {}): {:?} != {:?}", a.len(), b.len(), cut(&a), cut(&b))
            })
        }
        (Value::Obj(a), Value::Obj(b)) => {
            let (keys_a, keys_b): (Vec<&str>, Vec<&str>) = (a.keys().map(|k| &**k).collect(), b.keys().map(|k| &**k).collect());
            if keys_a != keys_b {
                let only_a: Vec<&&str> = keys_a.iter().filter(|k| !keys_b.contains(k)).collect();
                let only_b: Vec<&&str> = keys_b.iter().filter(|k| !keys_a.contains(k)).collect();
                return Some(format!("{path}: keys differ (expected only {only_a:?}, actual only {only_b:?}; order {})", if only_a.is_empty() && only_b.is_empty() { "differs" } else { "n/a" }));
            }
            for ((key, x), (_, y)) in a.iter().zip(b.iter()) {
                let length = path.len();
                path.push('/');
                path.push_str(key);
                let found = if skip(path) { None } else { difference(x, y, path, skip) };
                path.truncate(length);
                if found.is_some() {
                    return found;
                }
            }
            None
        }
        _ => match (expected.elements(), actual.elements()) {
            (Some(a), Some(b)) => {
                if a.len() != b.len() {
                    return Some(format!("{path}: array lengths {} != {}", a.len(), b.len()));
                }
                for (index, (x, y)) in a.iter().zip(b.iter()).enumerate() {
                    let length = path.len();
                    path.push_str(&format!("/{index}"));
                    let found = difference(&x, &y, path, skip);
                    path.truncate(length);
                    if found.is_some() {
                        return found;
                    }
                }
                None
            }
            _ => Some(format!("{path}: {} != {}", short(expected), short(actual))),
        },
    }
}

fn short(value: &Value) -> String {
    let text = value.to_string();
    if text.len() > 80 { format!("{}…", text.chars().take(80).collect::<String>()) } else { text }
}

fn json_difference(expected: &[u8], actual: &[u8], skip: &dyn Fn(&str) -> bool) -> Option<String> {
    let parse = |bytes: &[u8], side: &str| styk_doc::json::parse(bytes).map_err(|error| format!("the {side} body is not JSON: {error}"));
    let (expected, actual) = match (parse(expected, "recorded"), parse(actual, "replayed")) {
        (Ok(a), Ok(b)) => (a, b),
        (Err(error), _) | (_, Err(error)) => return Some(error),
    };
    difference(&expected, &actual, &mut String::new(), skip)
}

fn volatile(path: &str) -> bool {
    VOLATILE_TIMINGS.iter().any(|key| path == format!("/timings/{key}"))
}

fn wire_parts(body: &[u8]) -> Option<(&[u8], &[u8])> {
    if body.len() < 12 || &body[..8] != b"STYKPIV1" {
        return None;
    }
    let length = u32::from_le_bytes([body[8], body[9], body[10], body[11]]) as usize;
    (12 + length <= body.len()).then(|| (&body[12..12 + length], &body[12 + length..]))
}

fn container_difference(expected: &[u8], actual: &[u8], name: &str) -> Option<String> {
    use styk_formats::container::{self, Kind};
    let kind = Kind::from_extension(name.rsplit('.').next().unwrap_or("styk")).unwrap_or(Kind::Styk);
    let decode = |bytes: &[u8], side: &str| container::decode(bytes, kind).map(|d| d.document).map_err(|error| format!("the {side} container does not decode: {error}"));
    match (decode(expected, "recorded"), decode(actual, "replayed")) {
        (Ok(a), Ok(b)) => difference(&a, &b, &mut String::new(), &|_| false),
        (Err(error), _) | (_, Err(error)) => Some(error),
    }
}

fn first_byte_difference(expected: &[u8], actual: &[u8]) -> Option<String> {
    if expected == actual {
        return None;
    }
    let at = expected.iter().zip(actual.iter()).position(|(a, b)| a != b).unwrap_or(expected.len().min(actual.len()));
    Some(format!("bytes differ at offset {at} (lengths {} and {})", expected.len(), actual.len()))
}

struct Step<'a> {
    value: &'a Value,
    directory: &'a Path,
}

impl Step<'_> {
    fn body(&self) -> std::io::Result<Vec<u8>> {
        if let Some(file) = self.value.get("body_file").and_then(Value::as_str) {
            return std::fs::read(file);
        }
        match self.value.get("body").and_then(Value::as_str) {
            Some(name) => std::fs::read(self.directory.join(name)),
            None => Ok(Vec::new()),
        }
    }
}

/// Compares one response; `Err` says what differs. `Ok(true)` flags an error whose message alone differs.
fn compare(step: &Value, expected_body: &[u8], response: &Response) -> Result<bool, String> {
    let status = step.get("status").and_then(Value::as_f64).unwrap_or(0.0) as u16;
    if status != response.status {
        return Err(format!("status {} != {} ({})", status, response.status, String::from_utf8_lossy(&response.body[..response.body.len().min(200)])));
    }
    let expected_headers = pairs(step.get("response_headers"));
    let names = |headers: &[(String, String)]| headers.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>();
    if names(&expected_headers) != names(&response.headers) {
        return Err(format!("headers {:?} != {:?}", names(&expected_headers), names(&response.headers)));
    }
    for ((name, expected), (_, actual)) in expected_headers.iter().zip(&response.headers) {
        let same = if name == "Server-Timing" {
            let stages = |text: &str| text.split(", ").map(|part| part.split(';').next().unwrap_or("").to_string()).collect::<Vec<_>>();
            stages(expected) == stages(actual)
        } else {
            expected == actual
        };
        if !same {
            return Err(format!("header {name}: {expected:?} != {actual:?}"));
        }
    }
    let content_type = response.headers.iter().find(|(n, _)| n == "Content-Type").map(|(_, v)| v.as_str()).unwrap_or("");
    let hint = text(step, "compare");
    if hint == "health" {
        let skip = |path: &str| HEALTH_IDENTITY.iter().any(|key| path == format!("/{key}"));
        return json_difference(expected_body, &response.body, &skip).map_or(Ok(false), Err);
    }
    if content_type.starts_with("application/json") && !response.body.is_empty() {
        if status >= 400 {
            let skip_message = |path: &str| path == "/error";
            if let Some(found) = json_difference(expected_body, &response.body, &skip_message) {
                return Err(found);
            }
            return match json_difference(expected_body, &response.body, &|_| false) {
                None => Ok(false),
                Some(found) => {
                    eprintln!("    message: {found}");
                    Ok(true)
                }
            };
        }
        return json_difference(expected_body, &response.body, &volatile).map_or(Ok(false), Err);
    }
    if content_type == styk_piv::NATIVE_FRAMES_CONTENT_TYPE {
        let (Some((expected_header, expected_frames)), Some((header, frames))) = (wire_parts(expected_body), wire_parts(&response.body)) else {
            return Err("a body is not a STYKPIV1 response".to_string());
        };
        if let Some(found) = json_difference(expected_header, header, &volatile) {
            return Err(format!("header {found}"));
        }
        return first_byte_difference(expected_frames, frames).map_or(Ok(false), |found| Err(format!("frames: {found}")));
    }
    if hint == "container" && status == 200 {
        let name = response.headers.iter().find(|(n, _)| n == "Content-Disposition").map(|(_, v)| v.as_str()).unwrap_or("x.styk");
        return container_difference(expected_body, &response.body, name).map_or(Ok(false), Err);
    }
    first_byte_difference(expected_body, &response.body).map_or(Ok(false), Err)
}

fn kind_of(step: &Value, response: &Response) -> &'static str {
    let target = text(step, "target");
    let wire = response.body.starts_with(b"STYKPIV1");
    match () {
        _ if response.status >= 400 => "error responses",
        _ if target.starts_with("/api/import") && wire => "import STYKPIV1",
        _ if target.starts_with("/api/import") => "import JSON",
        _ if target.starts_with("/api/export") && text(step, "compare") == "container" => "export native container",
        _ if target.starts_with("/api/export") => "export bytes",
        _ => "other routes",
    }
}

fn scenario_directories(root: &Path) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = std::fs::read_dir(root).into_iter().flatten().filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.join("steps.json").is_file()).collect();
    found.sort();
    found
}

pub fn replay(root: &Path, options: &Options) -> Summary {
    let mut summary = Summary::default();
    for directory in scenario_directories(root) {
        let Ok(text_bytes) = std::fs::read(directory.join("steps.json")) else { continue };
        let Ok(scenario) = styk_doc::json::parse(&text_bytes) else {
            summary.failures.push(format!("{}: steps.json is not JSON", directory.display()));
            continue;
        };
        let name = text(&scenario, "name");
        if !options.only.is_empty() && !options.only.iter().any(|only| name.to_lowercase().contains(&only.to_lowercase())) {
            continue;
        }
        summary.scenarios += 1;
        let mut codec = Codec::new(limits_of(&text(&scenario, "limits")));
        let mut failed = 0;
        for (index, step) in scenario.get("steps").and_then(Value::as_arr).unwrap_or(&[]).iter().enumerate() {
            summary.steps += 1;
            let body = match (Step { value: step, directory: &directory }).body() {
                Ok(body) => body,
                Err(error) => {
                    summary.failures.push(format!("{name} step {index}: cannot read the request body: {error}"));
                    continue;
                }
            };
            let expected_body = std::fs::read(directory.join(text(step, "response"))).unwrap_or_default();
            let headers = pairs(step.get("headers"));
            let started = Instant::now();
            let response = codec.request(&text(step, "method"), &text(step, "target"), &headers, &body, &|| false);
            let seconds = started.elapsed().as_secs_f64();
            let oracle_seconds = step.get("oracle_seconds").and_then(Value::as_f64).unwrap_or(0.0);
            let label = format!("{name} step {index} [{} {}] {}", text(step, "method"), text(step, "target"), text(step, "note"));
            summary.slowest.push((oracle_seconds, seconds, label.clone()));
            let tally = summary.by_kind.entry(kind_of(step, &response)).or_default();
            match compare(step, &expected_body, &response) {
                Ok(message_only) => {
                    tally.same += 1;
                    if message_only {
                        summary.message_differences += 1;
                        summary.failures.push(format!("{label}: the error message differs"));
                    }
                }
                Err(found) => {
                    tally.different += 1;
                    failed += 1;
                    summary.failures.push(format!("{label}: {found}"));
                    if options.dump {
                        let _ = std::fs::write(directory.join(format!("actual-{index:03}.bin")), &response.body);
                    }
                }
            }
        }
        if options.verbose || failed > 0 {
            eprintln!("{} {name}", if failed == 0 { "ok  " } else { "FAIL" });
        }
    }
    summary
}
