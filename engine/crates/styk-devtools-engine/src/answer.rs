//! Shared byte limits and error schema for CLI and control answers.
use serde_json::{Value, json};
pub const SHORT_BYTES: usize = 4096;
pub const FULL_BYTES: usize = 24 * 1024;
pub const STRING_BYTES: usize = 2048;
pub const ROWS: usize = 50;
pub fn text(text: &str) -> String {
    let mut end = text.len().min(STRING_BYTES - 16);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    if end == text.len() {
        text.into()
    } else {
        format!("{} [truncated]", &text[..end])
    }
}
pub fn error(what: &str, where_: &str, input: Value, cause: &str, hint: &str) -> Value {
    json!({"what":text(what),"where":text(where_),"input":input,"cause":text(cause),"hint":text(hint)})
}
pub fn encode(value: &Value, cap: usize) -> Result<Vec<u8>, String> {
    if cap > FULL_BYTES {
        return Err("answer cap exceeds 24 KiB".into());
    }
    struct Writer {
        data: Vec<u8>,
        cap: usize,
    }
    impl std::io::Write for Writer {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > self.cap - self.data.len() {
                return Err(std::io::Error::other("answer exceeds byte limit"));
            }
            self.data.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut writer = Writer {
        data: Vec::with_capacity(cap),
        cap,
    };
    serde_json::to_writer(&mut writer, value).map_err(|_| "answer exceeds byte limit")?;
    Ok(writer.data)
}
/// Lists are resumable. The host supplies one bounded page and its absolute offset.
fn strings(value: &mut Value, depth: usize, left: &mut usize) -> Result<bool, ()> {
    if *left == 0 || depth > 8 {
        return Err(());
    }
    *left -= 1;
    let mut cut = false;
    match value {
        Value::String(s) if s.len() > STRING_BYTES => {
            *s = text(s);
            cut = true;
        }
        Value::Array(rows) => {
            if rows.len() > ROWS {
                return Err(());
            }
            for row in rows {
                cut |= strings(row, depth + 1, left)?;
            }
        }
        Value::Object(fields) => {
            if fields.len() > ROWS {
                return Err(());
            }
            for (key, value) in fields {
                if key.len() > STRING_BYTES {
                    return Err(());
                }
                cut |= strings(value, depth + 1, left)?;
            }
        }
        _ => {}
    }
    Ok(cut)
}
pub fn envelope(id: Option<u64>, mut result: Value, full: bool) -> Value {
    let cap = if full { FULL_BYTES } else { SHORT_BYTES };
    let offset = result.get("offset").and_then(Value::as_u64).unwrap_or(0);
    let mut more = result.get("more").cloned().unwrap_or(Value::Null);
    let mut truncated = !more.is_null();
    if let Some(rows) = result.get_mut("rows").and_then(Value::as_array_mut) {
        if rows.len() > ROWS {
            rows.truncate(ROWS);
            more = json!(offset + ROWS as u64);
            truncated = true;
        }
    }
    let failure = || json!({"id":id,"ok":false,"error":error("answer exceeds byte limit","protocol",Value::Null,"query is too wide","request a narrower path or a smaller page")});
    match strings(&mut result, 0, &mut 1024) {
        Ok(cut) => truncated |= cut,
        Err(()) => return failure(),
    }
    let mut envelope = json!({"id":id,"ok":true,"truncated":truncated,"more":more});
    envelope["result"] = result;
    loop {
        if encode(&envelope, cap).is_ok() {
            return envelope;
        }
        if let Some(rows) = envelope["result"]
            .get_mut("rows")
            .and_then(Value::as_array_mut)
        {
            if rows.len() > 1 {
                rows.pop();
                let more = json!(offset + rows.len() as u64);
                envelope["more"] = more.clone();
                envelope["result"]["more"] = more;
                envelope["truncated"] = json!(true);
                continue;
            }
        }
        return failure();
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn strings_are_marked_in_the_actual_response() {
        let response = envelope(Some(2), json!({"value":"界".repeat(9000)}), false);
        assert_eq!(response["truncated"], true);
        assert!(response["result"]["value"].as_str().unwrap().len() < STRING_BYTES);
        assert!(encode(&response, SHORT_BYTES).is_ok());
    }
    #[test]
    fn pagination_reports_the_exact_next_row_and_fits_bytes() {
        let rows: Vec<_> = (0..50)
            .map(|i| json!({"id":i,"label":"x".repeat(1000)}))
            .collect();
        let e = envelope(
            Some(1),
            json!({"rows":rows,"n_total":500,"offset":100,"more":150}),
            false,
        );
        assert!(encode(&e, SHORT_BYTES).is_ok());
        let n = e["result"]["rows"].as_array().unwrap().len();
        assert_eq!(e["more"], 100 + n);
        assert_eq!(e["truncated"], true);
    }
    #[test]
    fn unicode_strings_are_capped_on_byte_boundaries() {
        let v = text(&"界".repeat(3000));
        assert!(v.len() < STRING_BYTES);
        assert!(v.ends_with("[truncated]"));
        assert!(encode(&json!("x".repeat(100)), 20).is_err());
    }
}
