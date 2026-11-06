//! Document JSON for responses.
//!
//! This is `styk_doc::json::write` (JavaScript's `JSON.stringify` text) with one
//! difference: negative zero is written as `-0`, not `0`. Pivot poses contain
//! negative zeros, the Python service transported them (`-0.0`), and the import
//! response must carry the same doubles.

use styk_doc::json::{base64_into, write_string};
use styk_doc::{Value, format_number};

#[inline]
fn number(value: f64, out: &mut Vec<u8>) {
    if value == 0.0 && value.is_sign_negative() {
        out.extend_from_slice(b"-0");
    } else {
        format_number(value, out);
    }
}

/// Appends `value` as JSON text.
pub(crate) fn write(value: &Value, out: &mut Vec<u8>) {
    match value {
        Value::Null => out.extend_from_slice(b"null"),
        Value::Bool(true) => out.extend_from_slice(b"true"),
        Value::Bool(false) => out.extend_from_slice(b"false"),
        Value::Num(n) => number(*n, out),
        Value::Str(text) => write_string(text, out),
        Value::Blob(blob) => {
            write_string(&blob.prefix, out);
            out.pop();
            base64_into(&blob.bytes, out);
            out.push(b'"');
        }
        Value::Nums(numbers) => {
            out.push(b'[');
            for (index, n) in numbers.iter().enumerate() {
                if index > 0 {
                    out.push(b',');
                }
                number(n, out);
            }
            out.push(b']');
        }
        Value::Arr(items) => {
            out.push(b'[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(b',');
                }
                write(item, out);
            }
            out.push(b']');
        }
        Value::Obj(object) => {
            out.push(b'{');
            for (index, (key, item)) in object.iter().enumerate() {
                if index > 0 {
                    out.push(b',');
                }
                write_string(key, out);
                out.push(b':');
                write(item, out);
            }
            out.push(b'}');
        }
    }
}

/// `value` as JSON bytes.
pub(crate) fn to_bytes(value: &Value) -> Vec<u8> {
    let mut out = Vec::new();
    write(value, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn negative_zero_keeps_its_sign() {
        let value = Value::nums(&[-0.0, 0.0, 1.5, -2.0]);
        assert_eq!(to_bytes(&value), b"[-0,0,1.5,-2]");
        let parsed = styk_doc::json::parse(&to_bytes(&value)).unwrap();
        let numbers = parsed.numbers().unwrap();
        assert!(numbers[0].is_sign_negative() && !numbers[1].is_sign_negative());
    }
}
