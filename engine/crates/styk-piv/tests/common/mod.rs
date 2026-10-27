//! Shared helpers of the integration tests: a codec to talk to, the generated
//! fixtures, and short ways to read and edit a document tree.
#![allow(dead_code)]

use std::path::Path;

use styk_doc::{Obj, Value};
use styk_piv::{Codec, Limits, Response};

pub const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
pub const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
pub const C: &str = "cccccccccccccccccccccccccccccccc";

/// One of the files `engine/tools/piv/fixtures.py` generates.
pub fn fixture(name: &str) -> Vec<u8> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name);
    std::fs::read(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

/// The names of every generated fixture with this extension.
pub fn fixtures(extension: &str) -> Vec<String> {
    let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let mut names: Vec<String> = std::fs::read_dir(directory)
        .expect("fixtures directory")
        .map(|entry| entry.expect("fixture entry").file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(extension))
        .collect();
    names.sort();
    names
}

/// The inflated payload of a compressed Pivot file.
pub fn inflate(source: &[u8]) -> Vec<u8> {
    styk_piv::internals::zlib_inflate(source, usize::MAX).expect("a zlib stream").0
}

pub fn deflate(payload: &[u8]) -> Vec<u8> {
    styk_piv::internals::zlib_compress(payload)
}

/// A Pivot 5 project with bytes after its frame rate no writer would produce:
/// a regenerated file cannot stand in for it. Each `index` is another file.
pub fn opaque_source(index: usize) -> Vec<u8> {
    let mut payload = inflate(&fixture("modern-type-change.piv"));
    payload.extend_from_slice(b"\x00\xffunknown original bytes:");
    payload.extend_from_slice(index.to_string().as_bytes());
    deflate(&payload)
}

pub fn parse(body: &[u8]) -> Value {
    styk_doc::json::parse(body).unwrap_or_else(|error| panic!("not JSON ({error}): {}", String::from_utf8_lossy(&body[..body.len().min(200)])))
}

/// The JSON text a JavaScript client would send for `value`.
pub fn text(value: &Value) -> Vec<u8> {
    let mut out = Vec::new();
    styk_doc::json::write(value, &mut out);
    out
}

pub fn object(pairs: &[(&str, Value)]) -> Value {
    let mut object = Obj::new();
    for (key, value) in pairs {
        object.set(key, value.clone());
    }
    Value::object(object)
}

pub fn num(value: f64) -> Value {
    Value::Num(value)
}

pub fn string(value: &str) -> Value {
    Value::str(value)
}

/// The node at a `/`-separated path of keys and array indices.
pub fn at(value: &Value, path: &str) -> Value {
    let mut node = value.clone();
    for step in path.split('/').filter(|step| !step.is_empty()) {
        node = match step.parse::<usize>() {
            Ok(index) if node.is_array() => node.item(index),
            _ => node.get(step).cloned(),
        }
        .unwrap_or_else(|| panic!("no `{step}` in `{path}`"));
    }
    node
}

pub fn has(value: &Value, path: &str) -> bool {
    let mut node = value.clone();
    for step in path.split('/').filter(|step| !step.is_empty()) {
        let next = match step.parse::<usize>() {
            Ok(index) if node.is_array() => node.item(index),
            _ => node.get(step).cloned(),
        };
        match next {
            Some(next) => node = next,
            None => return false,
        }
    }
    true
}

pub fn number(value: &Value, path: &str) -> f64 {
    at(value, path).as_f64().unwrap_or_else(|| panic!("`{path}` is not a number"))
}

pub fn numbers(value: &Value, path: &str) -> Vec<f64> {
    let node = at(value, path);
    if node.array_len() == Some(0) { Vec::new() } else { node.numbers().unwrap_or_else(|| panic!("`{path}` is not a list of numbers")) }
}

pub fn str_at(value: &Value, path: &str) -> String {
    at(value, path).text().unwrap_or_else(|| panic!("`{path}` is not a string")).into_owned()
}

pub fn len(value: &Value, path: &str) -> usize {
    at(value, path).array_len().unwrap_or_else(|| panic!("`{path}` is not a list"))
}

/// `path` of every element of the list at `list`.
pub fn column(value: &Value, list: &str, path: &str) -> Vec<Value> {
    (0..len(value, list)).map(|index| at(value, &format!("{list}/{index}/{path}"))).collect()
}

pub fn column_numbers(value: &Value, list: &str, path: &str) -> Vec<f64> {
    column(value, list, path).iter().map(|v| v.as_f64().expect("a number")).collect()
}

/// Replaces the node at `path` (creating the last key of an object).
pub fn set(value: &mut Value, path: &str, new: Value) {
    fn walk(node: &mut Value, steps: &[&str], new: Value, path: &str) {
        let (step, rest) = (steps[0], &steps[1..]);
        if node.is_array() {
            let index: usize = step.parse().unwrap_or_else(|_| panic!("`{step}` is not an index in `{path}`"));
            let items = node.make_arr().expect("an array");
            if rest.is_empty() {
                items[index] = new;
            } else {
                walk(&mut items[index], rest, new, path);
            }
            node.repack();
            return;
        }
        let fields = node.make_obj().unwrap_or_else(|| panic!("`{step}` of `{path}` is inside a scalar"));
        if rest.is_empty() {
            fields.set(step, new);
        } else {
            walk(fields.get_mut(step).unwrap_or_else(|| panic!("no `{step}` in `{path}`")), rest, new, path);
        }
    }
    let steps: Vec<&str> = path.split('/').filter(|step| !step.is_empty()).collect();
    walk(value, &steps, new, path);
}

pub fn remove(value: &mut Value, path: &str) {
    let (parent, key) = path.rsplit_once('/').unwrap_or(("", path));
    let mut holder = at(value, parent);
    holder.make_obj().expect("an object").remove(key);
    if parent.is_empty() {
        *value = holder;
    } else {
        set(value, parent, holder);
    }
}

pub fn add(value: &mut Value, path: &str, delta: f64) {
    let current = number(value, path);
    set(value, path, Value::Num(current + delta));
}

pub fn push(value: &mut Value, path: &str, item: Value) {
    let mut list = at(value, path);
    list.make_arr().expect("an array").push(item);
    list.repack();
    set(value, path, list);
}

/// A response's status and, for an error, its machine code.
pub fn outcome(response: &Response) -> (u16, String) {
    let code = if response.status >= 400 { str_at(&parse(&response.body), "code") } else { String::new() };
    (response.status, code)
}

pub fn error_text(response: &Response) -> String {
    str_at(&parse(&response.body), "error")
}

pub fn header<'a>(response: &'a Response, name: &str) -> &'a str {
    response.headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str()).unwrap_or_else(|| panic!("no {name} header"))
}

/// A codec and the requests the tests send to it.
pub struct Service {
    pub codec: Codec,
}

impl Default for Service {
    fn default() -> Service {
        Service::new()
    }
}

impl Service {
    /// The desktop service.
    pub fn new() -> Service {
        Service::with(Limits::desktop())
    }

    pub fn with(limits: Limits) -> Service {
        Service { codec: Codec::new(limits) }
    }

    pub fn call(&mut self, method: &str, target: &str, headers: &[(&str, &str)], body: &[u8]) -> Response {
        let headers: Vec<(String, String)> = headers.iter().map(|(key, value)| (key.to_string(), value.to_string())).collect();
        self.codec.request(method, target, &headers, body, &|| false)
    }

    pub fn get(&mut self, target: &str) -> Response {
        self.call("GET", target, &[], b"")
    }

    pub fn post(&mut self, target: &str, body: &[u8]) -> Response {
        self.call("POST", target, &[], body)
    }

    pub fn post_json(&mut self, target: &str, body: &Value) -> Response {
        self.call("POST", target, &[], &text(body))
    }

    /// A successful JSON import: the whole response (`document`, `sourceId`, ...).
    pub fn import(&mut self, name: &str, bytes: &[u8]) -> Value {
        let response = self.post(&format!("/api/import?filename={name}"), bytes);
        assert_eq!(response.status, 200, "{name}: {}", String::from_utf8_lossy(&response.body));
        parse(&response.body)
    }

    pub fn import_owned(&mut self, name: &str, bytes: &[u8], owner: &str) -> Value {
        let response = self.call("POST", &format!("/api/import?filename={name}"), &[("X-Styk-Source-Owner", owner)], bytes);
        assert_eq!(response.status, 200, "{name}: {}", String::from_utf8_lossy(&response.body));
        parse(&response.body)
    }

    /// A native-frame import: the metadata header and the frame bytes.
    pub fn import_frames(&mut self, name: &str, bytes: &[u8], owner: Option<&str>) -> (Value, Vec<u8>) {
        let mut headers = vec![("Accept", styk_piv::NATIVE_FRAMES_CONTENT_TYPE)];
        if let Some(owner) = owner {
            headers.push(("X-Styk-Source-Owner", owner));
        }
        let response = self.call("POST", &format!("/api/import?filename={name}"), &headers, bytes);
        assert_eq!(response.status, 200, "{name}: {}", String::from_utf8_lossy(&response.body));
        assert_eq!(header(&response, "Content-Type"), styk_piv::NATIVE_FRAMES_CONTENT_TYPE);
        assert!(response.body.starts_with(styk_piv::NATIVE_FRAMES_MAGIC));
        let size = u32::from_le_bytes(response.body[8..12].try_into().unwrap()) as usize;
        (parse(&response.body[12..12 + size]), response.body[12 + size..].to_vec())
    }

    /// Exports `document` (with the source of `imported`, when it has one).
    pub fn export(&mut self, document: &Value, source_id: Option<&str>, format: &str) -> Response {
        let mut request = vec![("document", document.clone()), ("format", string(format))];
        if let Some(id) = source_id {
            request.push(("sourceId", string(id)));
        }
        self.post_json("/api/export", &object(&request))
    }

    /// Exports what an import returned, unchanged or after the test edited its document.
    pub fn export_of(&mut self, imported: &Value, format: &str) -> Response {
        let source_id = str_at(imported, "sourceId");
        self.export(&at(imported, "document"), Some(&source_id), format)
    }

    pub fn exported(&mut self, imported: &Value, format: &str) -> Vec<u8> {
        let response = self.export_of(imported, format);
        assert_eq!(response.status, 200, "{}", String::from_utf8_lossy(&response.body));
        response.body
    }

    /// The original bytes and the metadata of `/api/source`.
    pub fn source_record(&mut self, source_id: &str) -> (Vec<u8>, Value) {
        let response = self.get(&format!("/api/source?id={source_id}"));
        assert_eq!(response.status, 200, "{}", String::from_utf8_lossy(&response.body));
        assert_eq!(&response.body[..8], b"STYKSRC1");
        let size = u32::from_le_bytes(response.body[8..12].try_into().unwrap()) as usize;
        (response.body[12 + size..].to_vec(), parse(&response.body[12..12 + size]))
    }

    pub fn retain(&mut self, source_id: &str, owner: &str) -> Response {
        self.post_json("/api/source/retain", &object(&[("sourceId", string(source_id)), ("ownerId", string(owner))]))
    }

    pub fn release(&mut self, owner: &str) -> Response {
        self.post_json("/api/source/release", &object(&[("ownerId", string(owner))]))
    }

    /// Imports more files than the cache holds entries, so everything imported before is evicted.
    pub fn evict(&mut self) {
        for index in 0..=self.codec.limits().max_cache_entries {
            self.import("library.piv", &opaque_source(1000 + index));
        }
    }
}

/// Decodes `bytes` without a service, as the engine does when it opens a file.
pub fn decode(bytes: &[u8], name: &str) -> Value {
    styk_piv::decode_document(bytes, name, &|| false).unwrap_or_else(|error| panic!("{name}: {error}")).document
}

pub fn sha256(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// What the Python codec answers for each fixture (`tests/fixtures/expected.json`,
/// written by `engine/tools/piv/fixtures.py`).
pub fn expected() -> Value {
    parse(&fixture("expected.json"))
}
