//! Document fingerprints (`server.document_digest`, version 3).
//!
//! The service decides "is this document still the file it was imported from?"
//! by comparing SHA-256 fingerprints of a canonical text: Python's JSON with
//! sorted keys and ASCII escapes, numbers without a fraction written as
//! integers, the root keys `_stykSource`, `_styk` and `_stykWeb` left out, and
//! the legacy `runtime_segments` pose cache removed from every frame object.
//! Native saves store this fingerprint, so its bytes are a file-format contract.

use std::collections::HashMap;

use sha2::{Digest, Sha256};
use styk_doc::json::base64_into;
use styk_doc::{Obj, Shape, Value};

use crate::ctx::Ctx;
use crate::error::PyResult;
use crate::piv::v5::hex;
use crate::pyjson::{Origin, write_number, write_string_ascii};

struct Emitter {
    out: Vec<u8>,
    canonical: bool,
    origin: Origin,
    /// Key order of each object layout, sorted as Python sorts strings.
    orders: HashMap<*const Shape, std::sync::Arc<[u32]>>,
}

impl Emitter {
    fn sorted(&mut self, object: &Obj) -> std::sync::Arc<[u32]> {
        let shape = object.shape();
        self.orders
            .entry(std::sync::Arc::as_ptr(shape))
            .or_insert_with(|| {
                let keys = shape.keys();
                let mut order: Vec<u32> = (0..keys.len() as u32).collect();
                order.sort_by(|&a, &b| keys[a as usize].as_bytes().cmp(keys[b as usize].as_bytes()));
                order.into()
            })
            .clone()
    }

    /// Writes `value`; `skip` names a key left out of this object only.
    fn value(&mut self, value: &Value, skip: Option<&str>) -> PyResult<()> {
        match value {
            Value::Null => self.out.extend_from_slice(b"null"),
            Value::Bool(true) => self.out.extend_from_slice(b"true"),
            Value::Bool(false) => self.out.extend_from_slice(b"false"),
            Value::Num(n) => write_number(*n, self.canonical, self.origin, &mut self.out)?,
            Value::Str(text) => write_string_ascii(text, &mut self.out),
            Value::Blob(blob) => {
                write_string_ascii(&blob.prefix, &mut self.out);
                self.out.pop();
                base64_into(&blob.bytes, &mut self.out);
                self.out.push(b'"');
            }
            Value::Nums(numbers) => {
                self.out.push(b'[');
                for (index, n) in numbers.iter().enumerate() {
                    if index > 0 {
                        self.out.push(b',');
                    }
                    write_number(n, self.canonical, self.origin, &mut self.out)?;
                }
                self.out.push(b']');
            }
            Value::Arr(items) => {
                self.out.push(b'[');
                for (index, item) in items.iter().enumerate() {
                    if index > 0 {
                        self.out.push(b',');
                    }
                    self.value(item, None)?;
                }
                self.out.push(b']');
            }
            Value::Obj(object) => {
                let order = self.sorted(object);
                let keys = object.shape().keys();
                let values = object.values();
                self.out.push(b'{');
                let mut first = true;
                for &at in order.iter() {
                    let key = &keys[at as usize];
                    if skip == Some(&**key) {
                        continue;
                    }
                    if !first {
                        self.out.push(b',');
                    }
                    first = false;
                    write_string_ascii(key, &mut self.out);
                    self.out.push(b':');
                    self.value(&values[at as usize], None)?;
                }
                self.out.push(b'}');
            }
        }
        Ok(())
    }

    /// One keyframe, without the `runtime_segments` cache of its objects.
    fn frame(&mut self, frame: &Value, strip_cache: bool) -> PyResult<()> {
        let Some(object) = frame.as_obj().filter(|_| strip_cache) else {
            return self.value(frame, None);
        };
        let order = self.sorted(object);
        let keys = object.shape().keys();
        let values = object.values();
        self.out.push(b'{');
        for (index, &at) in order.iter().enumerate() {
            if index > 0 {
                self.out.push(b',');
            }
            let key = &keys[at as usize];
            write_string_ascii(key, &mut self.out);
            self.out.push(b':');
            match (&**key, &values[at as usize]) {
                ("objects", Value::Arr(items)) => {
                    self.out.push(b'[');
                    for (index, item) in items.iter().enumerate() {
                        if index > 0 {
                            self.out.push(b',');
                        }
                        self.value(item, Some("runtime_segments"))?;
                    }
                    self.out.push(b']');
                }
                (_, other) => self.value(other, None)?,
            }
        }
        self.out.push(b'}');
        Ok(())
    }
}

/// `server.document_digest(document, canonical=canonical)`.
///
/// With `canonical` false this is the fingerprint native files stored before
/// numbers were canonicalized (the pose cache is kept, and numbers print as
/// Python held them). `origin` says whether the document was decoded here or
/// sent by a client, which decides how integers beyond 2^53 are spelled.
pub(crate) fn document_digest(ctx: &Ctx<'_>, document: &Value, canonical: bool, origin: Origin) -> PyResult<String> {
    let mut hasher = Sha256::new();
    let mut emitter = Emitter { out: Vec::new(), canonical, origin, orders: HashMap::new() };
    let Some(root) = document.as_obj() else {
        emitter.value(document, None)?;
        styk_doc::digest::update(&mut hasher, &emitter.out);
        return Ok(hex(&hasher.finalize()));
    };
    let mut keys: Vec<(&str, &Value)> = root.iter().map(|(key, value)| (&**key, value)).filter(|(key, _)| !matches!(*key, "_stykSource" | "_styk" | "_stykWeb")).collect();
    keys.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    emitter.out.push(b'{');
    for (index, (key, value)) in keys.into_iter().enumerate() {
        ctx.checkpoint()?;
        if index > 0 {
            emitter.out.push(b',');
        }
        write_string_ascii(key, &mut emitter.out);
        emitter.out.push(b':');
        match (key, value) {
            ("keyframes", Value::Arr(frames)) => {
                emitter.out.push(b'[');
                for (index, frame) in frames.iter().enumerate() {
                    ctx.checkpoint()?;
                    if index > 0 {
                        emitter.out.push(b',');
                    }
                    emitter.frame(frame, canonical)?;
                    // One frame of text at a time: the fingerprint never holds a second document.
                    styk_doc::digest::update(&mut hasher, &emitter.out);
                    emitter.out.clear();
                }
                emitter.out.push(b']');
            }
            (_, other) => emitter.value(other, None)?,
        }
        styk_doc::digest::update(&mut hasher, &emitter.out);
        emitter.out.clear();
    }
    emitter.out.push(b'}');
    styk_doc::digest::update(&mut hasher, &emitter.out);
    Ok(hex(&hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fingerprint(json: &str, canonical: bool, origin: Origin) -> String {
        let never = || false;
        document_digest(&Ctx::new(&never), &styk_doc::json::parse(json.as_bytes()).unwrap(), canonical, origin).unwrap()
    }

    fn digest(json: &str) -> String {
        fingerprint(json, true, Origin::Client)
    }

    #[test]
    fn fingerprints_match_the_python_service() {
        // `server.document_digest(server.decoded_json(text))`, then with `canonical=False`, in the Python service.
        assert_eq!(digest("{}"), "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
        for (text, canonical, original) in [
            (
                r#"{"known":[1,0,1.25,true,null],"opaque":{"number_text":"1.0","negative_zero_text":"-0.0","integer":9007199254740991}}"#,
                "7d0ebe44ac442243034e11178e3a78b27ad85c7f0e3c76dea027c2835fbd87b3",
                "7d0ebe44ac442243034e11178e3a78b27ad85c7f0e3c76dea027c2835fbd87b3",
            ),
            (
                // Numbers spelled as JavaScript spells them: beyond 2^53, beyond 64 bits and beyond 1e21 included.
                r#"{"keyframes":[{"objects":[{"angles":[1,0,0.125,36893488147419103000,1e+21,100000002004087730000,999999984306749400,-999999984306749400,18446744073709550000,-9223372036854776000],"runtime_segments":["cache"],"opaque":{"runtime_segments":["keep"]}}],"opaque":"\u2603\ud83c\udfac"}],"z":{"_styk":{"keep":true}},"a":[true,false,null,1.0000000000000002,1e-200,1e+200,"1.0"],"_stykSource":{"ignore":1},"_stykWeb":{},"_styk":{}}"#,
                "690268312a3ae682d9a12a6c909e23b7d3175a9d21d5435a59c63bf27f6b487e",
                "4c85fce1427f114bd185d6546d9bec8feb125d858debb4a569ae4dc0a151795d",
            ),
            (r#"{"keyframes":[]}"#, "7d023b69b3a8126274b8bb9d197d4b54cc101185537d105acfa257805b1a9fb5", "7d023b69b3a8126274b8bb9d197d4b54cc101185537d105acfa257805b1a9fb5"),
            (
                r#"{"runtime_segments":"root","keyframes":[{"objects":[{"root_x":0.25,"runtime_segments":[1,2]}]}],"opaque":{"runtime_segments":"nested"}}"#,
                "8c388c62d5c460c4600aa1a9d74ea7378a58236571ef6a826e94688725dd6ad2",
                "0e3f32681867ff49c09a23480098dc15c5795d0388a9a50d9046dde486dc92d1",
            ),
        ] {
            assert_eq!(fingerprint(text, true, Origin::Client), canonical, "{text}");
            assert_eq!(fingerprint(text, false, Origin::Client), original, "{text}");
        }
    }

    #[test]
    fn a_decoded_document_fingerprints_the_exact_value_of_large_integers() {
        // The same doubles as the JavaScript-spelled document above, held as floats by the Python decoder.
        let text = r#"{"keyframes":[{"objects":[{"angles":[1,0,0.125,36893488147419103000,1e+21,100000002004087730000,999999984306749400,-999999984306749400,18446744073709550000,-9223372036854776000],"runtime_segments":["cache"],"opaque":{"runtime_segments":["keep"]}}],"opaque":"\u2603\ud83c\udfac"}],"z":{"_styk":{"keep":true}},"a":[true,false,null,1.0000000000000002,1e-200,1e+200,"1.0"]}"#;
        assert_eq!(fingerprint(text, true, Origin::Decoded), "b1343b65c6ac37fec1cf27021fa3a22e89aaed334e3b5ed1ca6f7f04e3a52709");
    }

    #[test]
    fn number_spelling_and_key_order_do_not_change_a_fingerprint() {
        assert_eq!(
            digest(r#"{"keyframes":[{"objects":[{"angles":[1.0,-0.0,0.125],"runtime_segments":[7]}]}],"b":"\u2603","a":[true,null,1e-7,1e22]}"#),
            digest(r#"{"a":[true,null,1e-07,10000000000000000000000],"b":"\u2603","keyframes":[{"objects":[{"angles":[1,0,0.125]}]}],"_styk":{"x":1}}"#)
        );
    }

    #[test]
    fn only_the_known_pose_cache_and_root_metadata_are_left_out() {
        let original = r#"{"keyframes":[{"objects":[{"angles":[1,0],"runtime_segments":[7]}]}]}"#;
        let other_cache = r#"{"keyframes":[{"objects":[{"angles":[1,0],"runtime_segments":[99]}]}],"_styk":{"ui":1},"_stykSource":{"bytes":"ignored"},"_stykWeb":{}}"#;
        assert_eq!(digest(original), digest(other_cache));
        for changed in [
            r#"{"keyframes":[{"objects":[{"angles":[1,0],"runtime_segments":[7]}]}],"runtime_segments":[]}"#,
            r#"{"keyframes":[{"objects":[{"angles":[1,0],"runtime_segments":[7]}]}],"unknown":{"_styk":0}}"#,
            r#"{"keyframes":[{"objects":[{"angles":[1,0.001]}]}]}"#,
            r#"{"keyframes":[{"objects":[{"angles":[1,0]}],"runtime_segments":[7]}]}"#,
        ] {
            assert_ne!(digest(original), digest(changed), "{changed}");
        }
        // The pre-canonical fingerprint keeps the pose cache, so it is another hash.
        assert_ne!(digest(original), fingerprint(original, false, Origin::Client));
    }
}
