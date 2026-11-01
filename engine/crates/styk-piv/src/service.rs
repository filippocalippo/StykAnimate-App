//! The codec API without HTTP (`backend/browser_service.py`).
//!
//! [`Codec::request`] takes what an HTTP handler would have read from the wire
//! and returns what it would have written: the same routes, size rules, cache
//! and lease semantics, and the same JSON error bodies as the Python service.

use styk_doc::Value;

use crate::ctx::Ctx;
use crate::error::{CodecError, PyErr, PyResult, api, value_error};
use crate::native::NativeDocuments;
use crate::py;
use crate::pyjson::{self, Py};
use crate::store::{Store, StoreLimits};
use crate::wire;

const MIB: usize = 1024 * 1024;

/// Sizes a codec accepts and keeps.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Limits {
    /// Largest `.piv`/`.stk` upload, and what `/api/health` reports as `maxImportBytes`.
    pub max_source: usize,
    /// Largest native document upload and export request body.
    pub max_document: usize,
    /// Bytes the import cache may hold (uploads, encoded documents, frame transports).
    pub max_cache: usize,
    /// Bytes of original sources active documents may lease beyond the cache.
    pub max_retained_sources: usize,
    /// Imports the cache holds regardless of size.
    pub max_cache_entries: usize,
    /// Owners that may hold a lease at once.
    pub max_source_owners: usize,
    /// The `host` field of `/api/health`; `None` omits it, as the desktop HTTP service does.
    pub host: Option<&'static str>,
}

impl Limits {
    /// The browser build's limits (`browser_service.py`): 96 MiB sources,
    /// 128 MiB documents, a 160 MiB cache. WebAssembly memory is a shared 32-bit space.
    pub fn web() -> Limits {
        Limits { max_source: 96 * MIB, max_document: 128 * MIB, max_cache: 160 * MIB, max_retained_sources: 96 * MIB, max_cache_entries: 24, max_source_owners: 16, host: Some("browser") }
    }

    /// The desktop service's limits (`server.py`): 128 MiB sources, 256 MiB
    /// documents, a 384 MiB cache of at most 24 entries, and as much again for leases.
    pub fn desktop() -> Limits {
        Limits { max_source: 128 * MIB, max_document: 256 * MIB, max_cache: 384 * MIB, max_retained_sources: 384 * MIB, max_cache_entries: 24, max_source_owners: 16, host: None }
    }
}

/// One answer of the codec: what an HTTP server would send.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Response {
    pub status: u16,
    /// Header names and values, in the order the Python service set them.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// The Pivot codec service: imports, exports and the source cache behind them.
pub struct Codec {
    limits: Limits,
    store: Store,
}

const JSON: &str = "application/json; charset=utf-8";

fn header(name: &str, value: &str) -> (String, String) {
    (name.to_string(), value.to_string())
}

fn json_response(status: u16, value: &Py) -> Response {
    Response { status, headers: vec![header("Content-Type", JSON)], body: pyjson::to_bytes(value) }
}

/// `urllib.parse.urlsplit(target)`: the path and the query string.
fn urlsplit(target: &str) -> PyResult<(String, String)> {
    let trimmed = target.trim_start_matches(|c: char| c as u32 <= 0x20);
    let mut url: String = trimmed.chars().filter(|c| !matches!(c, '\t' | '\r' | '\n')).collect();
    if let Some(colon) = url.find(':')
        && colon > 0
        && url.as_bytes()[0].is_ascii_alphabetic()
        && url[..colon].bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'.'))
    {
        url = url[colon + 1..].to_string();
    }
    if let Some(rest) = url.strip_prefix("//") {
        let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
        let netloc = &rest[..end];
        if netloc.contains('[') != netloc.contains(']') {
            return Err(value_error("Invalid IPv6 URL"));
        }
        url = rest[end..].to_string();
    }
    let without_fragment = url.split('#').next().unwrap_or("");
    Ok(match without_fragment.split_once('?') {
        Some((path, query)) => (path.to_string(), query.to_string()),
        None => (without_fragment.to_string(), String::new()),
    })
}

/// `urllib.parse.unquote_plus`-style decoding of one query component.
fn unquote(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        match bytes[at] {
            b'+' => out.push(b' '),
            b'%' if bytes.get(at + 1..at + 3).is_some_and(|h| h.iter().all(u8::is_ascii_hexdigit)) => {
                let hex = std::str::from_utf8(&bytes[at + 1..at + 3]).unwrap_or("0");
                out.push(u8::from_str_radix(hex, 16).unwrap_or(0));
                at += 2;
            }
            byte => out.push(byte),
        }
        at += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `parse_qs(query).get(name, [default])[0]`: the first non-blank value of `name`.
fn query_value(query: &str, name: &str, default: &str) -> String {
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        if !value.is_empty() && unquote(key) == name {
            return unquote(value);
        }
    }
    default.to_string()
}

/// `urllib.parse.quote(text)`: everything but unreserved characters and `/` percent-encoded.
fn quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for &byte in text.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-' | b'~' | b'/') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// `server.decoded_json`: a request body as a document tree, or the error
/// Python's parser raised for it.
fn decoded_json(body: &[u8]) -> PyResult<Value> {
    // The store's reader tolerates a byte-order mark; Python's does not.
    if !body.starts_with(&[0xef, 0xbb, 0xbf])
        && let Ok(value) = styk_doc::json::parse(body)
    {
        return Ok(value);
    }
    match pyjson::diagnose(body) {
        Some(error) => Err(error),
        // Text Python reads and the document store does not (see docs/engine/formats-piv.md).
        None => Err(value_error(match styk_doc::json::parse(body) {
            Err(error) => error.to_string(),
            Ok(_) => "invalid JSON".to_string(),
        })),
    }
}

impl Codec {
    /// A codec with these limits that reads and writes native documents through `styk-formats`.
    pub fn new(limits: Limits) -> Codec {
        #[cfg(feature = "containers")]
        let native: Option<Box<dyn NativeDocuments>> = Some(Box::new(crate::native::Containers));
        #[cfg(not(feature = "containers"))]
        let native: Option<Box<dyn NativeDocuments>> = None;
        Codec::with_native_documents(limits, native)
    }

    /// A codec that reaches native documents through `native`. With `None`,
    /// native imports and exports answer `415` as an unsupported format.
    pub fn with_native_documents(limits: Limits, native: Option<Box<dyn NativeDocuments>>) -> Codec {
        let store = Store::new(
            StoreLimits {
                max_cache: limits.max_cache,
                max_retained_sources: limits.max_retained_sources,
                max_source_owners: limits.max_source_owners,
                max_cache_entries: limits.max_cache_entries,
            },
            native,
        );
        Codec { limits, store }
    }

    /// Supplies the time, in milliseconds from any origin, for the timing fields
    /// of responses. Without a clock they are zero (the library reads no clock itself).
    pub fn set_clock(&mut self, clock: Box<dyn Fn() -> f64>) {
        self.store.clock = Some(clock);
    }

    /// The limits this codec was created with.
    pub fn limits(&self) -> &Limits {
        &self.limits
    }

    /// Answers one API request. Never panics and never fails: every failure is
    /// a JSON error response, as `server.error_response` builds it.
    ///
    /// `cancel` is polled at the codec's loop and stage boundaries; once it
    /// returns `true` the request ends with `499 cancelled`.
    pub fn request(&mut self, method: &str, target: &str, headers: &[(String, String)], body: &[u8], cancel: &dyn Fn() -> bool) -> Response {
        let ctx = Ctx::new(cancel);
        // A panic is a bug, but it must not take the host down with it: where the
        // build unwinds, it becomes the service's generic failure response.
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.route(&ctx, &method.to_uppercase(), target, headers, body)));
        match outcome {
            Ok(Ok(response)) => response,
            Ok(Err(error)) => error_response(error),
            Err(_) => error_response(crate::error::runtime_error("the codec panicked")),
        }
    }

    fn limit(&self, filename: &str) -> usize {
        let lower = filename.to_lowercase();
        if [".styk", ".stkz", ".stykmov", ".json"].iter().any(|suffix| lower.ends_with(suffix)) { self.limits.max_document } else { self.limits.max_source }
    }

    fn route(&mut self, ctx: &Ctx<'_>, method: &str, target: &str, headers: &[(String, String)], body: &[u8]) -> PyResult<Response> {
        // Later headers of the same name win, as in the dictionary the Python service built.
        let header_value = |name: &str| headers.iter().rev().find(|(key, _)| key.to_lowercase() == name).map(|(_, value)| value.as_str());
        let (path, query) = urlsplit(target)?;
        let prefer_native = header_value("accept").is_some_and(|accept| accept.contains(wire::CONTENT_TYPE));
        let too_large = || api(413, "body_too_large", "The request exceeds the configured size limit.");
        match (method, path.as_str()) {
            ("GET", "/api/health") => {
                let mut payload = vec![
                    ("ok", Py::Bool(true)),
                    ("name", Py::str("StykAnimate-webapp")),
                    ("schemaVersion", Py::Int(1)),
                    ("jobs", Py::Dict(vec![("active", Py::Int(0)), ("queued", Py::Int(0)), ("capacity", Py::Int(1)), ("recentCancellations", Py::Int(0))])),
                    ("codec", Py::str("Pivot verified grammar / bulk reader")),
                    ("versions", Py::List(vec![Py::Int(2), Py::Int(3), Py::Int(4), Py::Int(5)])),
                    ("formats", Py::List(["piv", "stk", "styk", "stkz", "stykmov"].iter().map(|f| Py::str(f)).collect())),
                    ("maxImportBytes", Py::Int(self.limits.max_source as i64)),
                    // What implements the codec: these four differ from the Python service by design.
                    ("jsonEncoder", Py::str("rust")),
                    ("processMemoryMiB", Py::Null),
                    ("nativeFrameScanner", Py::str("rust")),
                    ("nativeFrameScannerInfo", Py::Null),
                    ("session", Py::Null),
                ];
                if let Some(host) = self.limits.host {
                    payload.push(("host", Py::str(host)));
                }
                Ok(json_response(200, &Py::Dict(payload)))
            }
            ("GET", "/api/samples") => Ok(json_response(200, &Py::Dict(vec![("ok", Py::Bool(true)), ("samples", Py::List(Vec::new()))]))),
            ("GET", "/api/source") => {
                let source_id = query_value(&query, "id", "");
                let (source, meta) = self.store.source_record(ctx, &source_id)?;
                let mut payload = Vec::with_capacity(12 + meta.len() + source.len());
                payload.extend_from_slice(b"STYKSRC1");
                payload.extend_from_slice(&(meta.len() as u32).to_le_bytes());
                payload.extend_from_slice(&meta);
                payload.extend_from_slice(&source);
                Ok(Response { status: 200, headers: vec![header("Content-Type", "application/octet-stream")], body: payload })
            }
            ("POST", "/api/cancel") => Ok(Response { status: 204, headers: vec![header("Content-Type", "application/json")], body: Vec::new() }),
            ("POST", "/api/import") => {
                let name = query_value(&query, "filename", "imported.piv");
                if body.len() > self.limit(&name) {
                    return Err(too_large());
                }
                let result = self.store.import_bytes(ctx, body, &name, prefer_native, header_value("x-styk-source-owner"))?;
                let kind = if result.starts_with(wire::MAGIC) { wire::CONTENT_TYPE } else { JSON };
                Ok(Response { status: 200, headers: vec![header("Content-Type", kind)], body: result })
            }
            ("POST", "/api/source/keep") => {
                let name = query_value(&query, "filename", "imported.piv");
                if body.len() > self.limit(&name) {
                    return Err(too_large());
                }
                let kept = self.store.keep_upload(ctx, body, &name, header_value("x-styk-source-owner"))?;
                Ok(json_response(200, &kept))
            }
            ("POST", "/api/export") => {
                let started = self.store.clock.as_ref().map_or(0.0, |clock| clock());
                if body.len() > self.limits.max_document {
                    return Err(too_large());
                }
                let request = decoded_json(body)?;
                let now = |codec: &Codec| codec.store.clock.as_ref().map_or(0.0, |clock| clock());
                let mut timings = vec![("receive", 0.0), ("parse", now(self) - started)];
                if !request.is_object() {
                    return Err(api(400, "invalid_request", "The request must be a JSON object."));
                }
                let (data, name) = self.store.export(ctx, &request, &mut timings)?;
                timings.push(("total", now(self) - started));
                let stages: Vec<String> = timings.iter().map(|(stage, duration)| format!("{stage};dur={duration:.3}")).collect();
                Ok(Response {
                    status: 200,
                    headers: vec![
                        header("Content-Type", "application/octet-stream"),
                        header("X-Styk-Request-Bytes", &body.len().to_string()),
                        header("Server-Timing", &stages.join(", ")),
                        header("Content-Disposition", &format!("attachment; filename*=UTF-8''{}", quote(&name))),
                    ],
                    body: data,
                })
            }
            ("POST", "/api/open") => Err(api(404, "workspace_unavailable", "Opening files by path needs the desktop app.")),
            ("POST", "/api/source/retain" | "/api/source/release") => {
                if body.len() > 4096 {
                    return Err(too_large());
                }
                let request = decoded_json(body)?;
                if !request.is_object() {
                    return Err(api(400, "invalid_request", "The request must be a JSON object."));
                }
                if path == "/api/source/retain" {
                    let retained = self.store.retain_source(py::get(&request, "sourceId")?, py::get(&request, "ownerId")?)?;
                    return Ok(json_response(200, &Py::Dict(vec![("ok", Py::Bool(true)), ("retained", Py::Bool(retained))])));
                }
                self.store.release_source(py::get(&request, "ownerId")?)?;
                Ok(Response { status: 204, headers: vec![header("Content-Type", "application/json")], body: Vec::new() })
            }
            _ => Err(api(404, "route_not_found", "Unknown codec endpoint.")),
        }
    }
}

/// `server.error_response` as a response.
fn error_response(error: Box<PyErr>) -> Response {
    let error = CodecError::from(error);
    json_response(error.status, &Py::Dict(vec![("ok", Py::Bool(false)), ("error", Py::Str(error.message)), ("code", Py::Str(error.code))]))
}
