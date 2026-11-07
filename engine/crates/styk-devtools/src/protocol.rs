//! Transport-independent JSON-lines protocol. No document data is returned implicitly.
use serde_json::{Value, json};
pub const MAX_REQUEST: usize = 16 * 1024;
pub const MAX_RESPONSE: usize = 24 * 1024;
pub const OPS: &[&str] = &[
    "hello",
    "metrics.get",
    "state.get",
    "trace.start",
    "trace.stop",
];
/// A connection decoder. An oversized line closes the connection; it is never silently truncated.
#[derive(Default)]
pub struct Decoder {
    pending: Vec<u8>,
    failed: bool,
}
impl Decoder {
    pub fn byte(&mut self, byte: u8) -> Result<Option<Value>, String> {
        if self.failed {
            return Err("connection closed".into());
        }
        if byte == b'\n' {
            let value = serde_json::from_slice(&self.pending)
                .map_err(|_| "invalid request JSON".to_string());
            self.pending.clear();
            return value.map(Some);
        }
        if self.pending.len() == MAX_REQUEST {
            self.failed = true;
            self.pending.clear();
            return Err("request exceeds 16 KiB; connection closed".into());
        }
        self.pending.push(byte);
        Ok(None)
    }
}
/// Host receives only supported operations; mutations must use normal core effects.
pub trait Host {
    fn request(&mut self, op: &str, args: &Value) -> Result<Value, String>;
}
pub fn respond(request: Value, host: &mut impl Host) -> Vec<u8> {
    let id = request.get("id").and_then(Value::as_u64);
    let op = request.get("op").and_then(Value::as_str).unwrap_or("");
    let result = if id.is_none() {
        Err("id must be an unsigned integer".into())
    } else if op == "hello" {
        if request["version"] != 1 {
            Err("supported protocol version: 1".into())
        } else {
            Ok(json!({"version":1,"ops":OPS}))
        }
    } else if OPS.contains(&op) {
        host.request(op, &request["args"])
    } else {
        Err(format!("unknown operation; supported: {}", OPS.join(", ")))
    };
    let value = match result {
        Ok(value) => json!({"id":id,"ok":true,"result":value,"truncated":false}),
        Err(reason) => {
            json!({"id":id,"ok":false,"error":{"what":"request failed","where":"protocol","cause":reason.chars().take(512).collect::<String>(),"hint":"check operation and host availability"}})
        }
    };
    let mut out = Vec::new();
    // Serialization refuses while writing, before allocating an unbounded answer.
    struct Limited<'a>(&'a mut Vec<u8>);
    impl std::io::Write for Limited<'_> {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > MAX_RESPONSE - self.0.len() {
                return Err(std::io::Error::other("answer too large"));
            }
            self.0.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    if serde_json::to_writer(Limited(&mut out), &value).is_err() {
        out = format!("{{\"id\":{},\"ok\":false,\"error\":{{\"what\":\"answer exceeds 24 KiB\",\"hint\":\"request a smaller page\"}}}}", id.map_or("null".into(), |n| n.to_string())).into_bytes();
    }
    out.push(b'\n');
    out
}
#[cfg(test)]
mod tests {
    use super::*;
    struct Fake;
    impl Host for Fake {
        fn request(&mut self, _: &str, _: &Value) -> Result<Value, String> {
            Ok(json!("x".repeat(MAX_RESPONSE * 2)))
        }
    }
    #[test]
    fn framing_and_overflow() {
        let mut d = Decoder::default();
        for b in b"{\"id\":1}\n" {
            if let Some(v) = d.byte(*b).unwrap() {
                assert_eq!(v["id"], 1);
            }
        }
        for _ in 0..MAX_REQUEST {
            d.byte(b' ').unwrap();
        }
        assert!(d.byte(b' ').is_err());
        assert!(d.byte(b'\n').is_err());
    }
    #[test]
    fn version_unknown_and_answer_budget() {
        for request in [
            json!({"id":7,"op":"hello","version":2}),
            json!({"id":7,"op":"oops"}),
            json!({"id":7,"op":"state.get"}),
        ] {
            let bytes = respond(request, &mut Fake);
            assert!(bytes.len() <= MAX_RESPONSE);
            let v: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(v["ok"], false);
            assert_eq!(v["id"], 7);
        }
        let v: Value = serde_json::from_slice(&respond(
            json!({"id":1,"op":"hello","version":1}),
            &mut Fake,
        ))
        .unwrap();
        assert_eq!(v["ok"], true);
    }
}
