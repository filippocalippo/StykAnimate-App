//! The Pivot codec as a WebAssembly module: `styk_piv::Codec` behind one
//! `request` call, for the app's codec worker (`src/codec-web-worker.mjs`).
//! The same module carries StykAnimate's own file containers for the import,
//! library-preview and document-export workers (`native`, `src/native-file-codec.mjs`).
//!
//! It is a separate module from the engine's: no threads, no shared memory,
//! built on stable Rust (`node scripts/engine-build.mjs`). The worker owns one
//! [`PivotCodec`] and sends it what an HTTP handler would have read; every
//! answer, error included, is a [`CodecResponse`] (`docs/engine/formats-piv.md`).
//!
//! Cancellation: the worker passes an object whose `cancelled()` the codec polls
//! at its checkpoints (per frame, record and table). The worker answers it from
//! a `SharedArrayBuffer` flag the page sets, so a running request stops without
//! the worker being terminated.

use styk_piv::{Codec, Limits};
use wasm_bindgen::prelude::*;

/// Memory grows ahead in large steps: a host `memory.grow` costs about a millisecond whatever its size (`styk-alloc`).
#[cfg(target_arch = "wasm32")]
#[global_allocator]
static ALLOCATOR: styk_alloc::GrowAhead = styk_alloc::GrowAhead;

mod native;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = error)]
    fn console_error(message: &str);
    #[wasm_bindgen(js_namespace = performance, js_name = now)]
    fn performance_now() -> f64;

    /// What the worker passes to [`PivotCodec::request`]: `cancelled()` is true
    /// once the page has cancelled the job the request belongs to.
    pub type CancelProbe;
    #[wasm_bindgen(method)]
    fn cancelled(this: &CancelProbe) -> bool;
}

/// Panics reach the console with their message and location before the module
/// aborts; the worker then replaces the instance (`__wbg_reset_state`).
#[wasm_bindgen(start)]
fn start() {
    std::panic::set_hook(Box::new(|info| console_error(&format!("StykAnimate Pivot codec panic: {info}"))));
}

/// Bytes of linear memory this instance holds. It grows with the largest working set and
/// never shrinks; `src/native-file-codec.mjs` replaces an instance that holds too much.
#[wasm_bindgen(js_name = memoryBytes)]
pub fn memory_bytes() -> f64 {
    #[cfg(target_arch = "wasm32")]
    {
        (core::arch::wasm32::memory_size::<0>() * 65536) as f64
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        0.0
    }
}

/// The codec service: imports, exports and the source cache behind them.
#[wasm_bindgen]
pub struct PivotCodec {
    codec: Codec,
}

#[wasm_bindgen]
impl PivotCodec {
    /// A codec with the limits of `"web"` (the browser build) or `"desktop"`.
    #[wasm_bindgen(constructor)]
    pub fn new(limits: &str) -> Result<PivotCodec, JsError> {
        let limits = limits_named(limits).ok_or_else(|| JsError::new(&format!("Unknown codec limits: {limits}")))?;
        let mut codec = Codec::new(limits);
        codec.set_clock(Box::new(performance_now));
        Ok(PivotCodec { codec })
    }

    /// Answers one API request. `headers` is a JSON object of header names and
    /// values; the response's headers are a JSON array of `[name, value]` pairs.
    /// Codec failures are error responses; only malformed `headers` throw.
    pub fn request(&mut self, method: &str, target: &str, headers: &str, body: &[u8], cancel: &CancelProbe) -> Result<CodecResponse, JsError> {
        let headers = parse_headers(headers).map_err(|error| JsError::new(&error))?;
        let response = self.codec.request(method, target, &headers, body, &|| cancel.cancelled());
        Ok(CodecResponse { status: response.status, headers: headers_json(&response.headers), body: response.body })
    }
}

/// One answer: what an HTTP server would have sent.
#[wasm_bindgen]
pub struct CodecResponse {
    status: u16,
    headers: String,
    body: Vec<u8>,
}

#[wasm_bindgen]
impl CodecResponse {
    #[wasm_bindgen(getter)]
    pub fn status(&self) -> u16 {
        self.status
    }

    /// `[[name, value], …]` in the order the service set them.
    #[wasm_bindgen(getter)]
    pub fn headers(&self) -> String {
        self.headers.clone()
    }

    /// The body, moved out (a second call returns nothing).
    #[wasm_bindgen(js_name = takeBody)]
    pub fn take_body(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.body)
    }
}

fn limits_named(name: &str) -> Option<Limits> {
    match name {
        "web" => Some(Limits::web()),
        "desktop" => Some(Limits::desktop()),
        _ => None,
    }
}

/// `{"Name": "value", …}` as the list the codec reads (later names win there, as in Python's dict).
fn parse_headers(text: &str) -> Result<Vec<(String, String)>, String> {
    let value = styk_doc::json::parse(text.as_bytes()).map_err(|error| format!("Codec request headers are not JSON: {error}"))?;
    let object = value.as_obj().ok_or("Codec request headers must be a JSON object.")?;
    object
        .iter()
        .map(|(name, value)| match value.as_str() {
            Some(text) => Ok((name.to_string(), text.to_string())),
            None => Err(format!("Codec request header {name} is not a string.")),
        })
        .collect()
}

fn headers_json(headers: &[(String, String)]) -> String {
    let mut out = String::from("[");
    for (index, (name, value)) in headers.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push('[');
        json_string(name, &mut out);
        out.push(',');
        json_string(value, &mut out);
        out.push(']');
    }
    out.push(']');
    out
}

fn json_string(text: &str, out: &mut String) {
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headers_round_trip_as_json() {
        let parsed = parse_headers(r#"{"Accept":"application/json","X-Styk-Job-Id":"ab"}"#).unwrap();
        assert_eq!(parsed, vec![("Accept".into(), "application/json".into()), ("X-Styk-Job-Id".into(), "ab".into())]);
        assert!(parse_headers("[]").is_err());
        assert!(parse_headers(r#"{"A":1}"#).is_err());
        assert!(parse_headers("{").is_err());
        let written = headers_json(&[("Content-Disposition".into(), "attachment; filename*=UTF-8''a\"b\\\u{1}".into())]);
        assert_eq!(written, r#"[["Content-Disposition","attachment; filename*=UTF-8''a\"b\\\u0001"]]"#);
    }

    #[test]
    fn limits_are_named() {
        assert_eq!(limits_named("web"), Some(Limits::web()));
        assert_eq!(limits_named("desktop"), Some(Limits::desktop()));
        assert_eq!(limits_named("server"), None);
    }
}
