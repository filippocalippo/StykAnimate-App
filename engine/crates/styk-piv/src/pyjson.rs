//! JSON text as Python's `json` module writes it, and the error it reports
//! for text it cannot read.
//!
//! Three things use Python's spelling: the small envelopes and error bodies of
//! the service (so they are byte-identical to the Python service's), document
//! fingerprints (which hash Python's sorted, ASCII-escaped text), and
//! [`diagnose`], which gives a request body that failed to parse the message
//! `json.loads(body.decode("utf-8"))` raised for it.

use crate::error::{PyErr, PyResult, runtime_error, value_error};
use crate::pyfmt::{float_repr_into, py_number_into};

/// A small JSON value with Python's number types, for envelopes and metadata.
#[derive(Clone, Debug)]
pub(crate) enum Py {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Str(String),
    List(Vec<Py>),
    Dict(Vec<(&'static str, Py)>),
}

impl Py {
    pub fn str(text: &str) -> Py {
        Py::Str(text.to_string())
    }
}

/// `json.dumps(text)` with `ensure_ascii=True`.
pub(crate) fn write_string_ascii(text: &str, out: &mut Vec<u8>) {
    out.push(b'"');
    for ch in text.chars() {
        match ch {
            '"' => out.extend_from_slice(b"\\\""),
            '\\' => out.extend_from_slice(b"\\\\"),
            '\n' => out.extend_from_slice(b"\\n"),
            '\r' => out.extend_from_slice(b"\\r"),
            '\t' => out.extend_from_slice(b"\\t"),
            '\u{8}' => out.extend_from_slice(b"\\b"),
            '\u{c}' => out.extend_from_slice(b"\\f"),
            ' '..='~' => out.push(ch as u8),
            _ => {
                let mut units = [0u16; 2];
                for unit in ch.encode_utf16(&mut units) {
                    out.extend_from_slice(format!("\\u{:04x}", unit).as_bytes());
                }
            }
        }
    }
    out.push(b'"');
}

/// `json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":"))`.
pub(crate) fn write(value: &Py, out: &mut Vec<u8>) {
    match value {
        Py::Null => out.extend_from_slice(b"null"),
        Py::Bool(true) => out.extend_from_slice(b"true"),
        Py::Bool(false) => out.extend_from_slice(b"false"),
        Py::Int(n) => out.extend_from_slice(n.to_string().as_bytes()),
        Py::Float(n) => float_repr_into(*n, out),
        Py::Str(text) => write_string_ascii(text, out),
        Py::List(items) => {
            out.push(b'[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(b',');
                }
                write(item, out);
            }
            out.push(b']');
        }
        Py::Dict(items) => {
            out.push(b'{');
            for (index, (key, item)) in items.iter().enumerate() {
                if index > 0 {
                    out.push(b',');
                }
                write_string_ascii(key, out);
                out.push(b':');
                write(item, out);
            }
            out.push(b'}');
        }
    }
}

pub(crate) fn to_bytes(value: &Py) -> Vec<u8> {
    let mut out = Vec::new();
    write(value, &mut out);
    out
}

/// Who holds the number being fingerprinted.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Origin {
    /// A document this codec decoded from a file: Python held its numbers as they were read.
    Decoded,
    /// A document a JavaScript client sent: Python read the text `JSON.stringify` wrote.
    Client,
}

/// A document number in fingerprint text.
///
/// Python fingerprints a client's document from its JSON *text*, read with
/// orjson. JavaScript writes an integer below 1e21 as plain digits; orjson
/// reads digits that fit a signed or unsigned 64-bit integer as an `int`
/// (printed back unchanged) and anything else, exponent form included, as a
/// `float`. The digits JavaScript writes for an integer above 2^53 are its
/// shortest round-trip digits padded with zeros, not its exact value, so a
/// number between 2^53 and 2^64 fingerprints differently in a client document
/// than in a decoded one. That is the Python service's behaviour, and it is
/// reproduced here.
pub(crate) fn write_number(value: f64, canonical: bool, origin: Origin, out: &mut Vec<u8>) -> PyResult<()> {
    if !value.is_finite() {
        return Err(value_error(format!("Out of range float values are not JSON compliant: {}", crate::pyfmt::float_repr(value))));
    }
    if origin == Origin::Client && crate::pyfmt::is_integral(value) && value.abs() >= 9007199254740992.0 {
        let start = out.len();
        if value.abs() < 1e21 {
            styk_doc::format_number(value, out);
            let digits = std::str::from_utf8(&out[start..]).unwrap_or("");
            if digits.parse::<i64>().is_ok() || digits.parse::<u64>().is_ok() {
                return Ok(());
            }
            out.truncate(start);
        }
        // Python read a float: the fingerprint before canonical numbers printed it as one.
        if !canonical {
            float_repr_into(value, out);
            return Ok(());
        }
    }
    py_number_into(value, out);
    Ok(())
}

// ---- what json.loads says about text it rejects ----------------------------

/// The `UnicodeDecodeError` text of `bytes.decode("utf-8")`, if it fails.
fn utf8_error(bytes: &[u8]) -> Option<String> {
    let invalid = match std::str::from_utf8(bytes) {
        Ok(_) => return None,
        Err(error) => error.valid_up_to(),
    };
    let rest = &bytes[invalid..];
    let lead = rest[0];
    let continuation = |index: usize| rest.get(index).map(|&b| (0x80..0xc0).contains(&b));
    // How many bytes of the sequence are well-formed, or `None` when the data just ends.
    let (reason, length): (&str, usize) = if !(0xc2..0xf5).contains(&lead) {
        ("invalid start byte", 1)
    } else if lead < 0xe0 {
        match continuation(1) {
            None => ("unexpected end of data", rest.len()),
            _ => ("invalid continuation byte", 1),
        }
    } else if lead < 0xf0 {
        let second_ok = |b: u8| (0x80..0xc0).contains(&b) && !(if b < 0xa0 { lead == 0xe0 } else { lead == 0xed });
        match rest.get(1) {
            None => ("unexpected end of data", rest.len()),
            Some(&b) if !second_ok(b) => ("invalid continuation byte", 1),
            Some(_) => match continuation(2) {
                None => ("unexpected end of data", rest.len()),
                _ => ("invalid continuation byte", 2),
            },
        }
    } else {
        let second_ok = |b: u8| (0x80..0xc0).contains(&b) && !(if b < 0x90 { lead == 0xf0 } else { lead == 0xf4 });
        match rest.get(1) {
            None => ("unexpected end of data", rest.len()),
            Some(&b) if !second_ok(b) => ("invalid continuation byte", 1),
            Some(_) => match continuation(2) {
                None => ("unexpected end of data", rest.len()),
                Some(false) => ("invalid continuation byte", 2),
                Some(true) => match continuation(3) {
                    None => ("unexpected end of data", rest.len()),
                    _ => ("invalid continuation byte", 3),
                },
            },
        }
    };
    Some(if length == 1 {
        format!("'utf-8' codec can't decode byte {:#04x} in position {}: {}", lead, invalid, reason)
    } else {
        format!("'utf-8' codec can't decode bytes in position {}-{}: {}", invalid, invalid + length - 1, reason)
    })
}

struct Scanner<'a> {
    text: &'a [u8],
    at: usize,
}

/// A `JSONDecodeError`: its message and the byte offset it points at.
type Fail = (&'static str, usize);

/// How deep Python's scanner recurses before it raises `RecursionError`
/// (CPython 3.12's C recursion limit; measured against the reference service).
const PYTHON_RECURSION_LIMIT: usize = 10_000;

enum Outcome {
    Ok,
    Syntax(&'static str, usize),
    Other(Box<PyErr>),
}

impl Scanner<'_> {
    fn space(&mut self) {
        while matches!(self.text.get(self.at), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.at += 1;
        }
    }

    /// Characters left from byte offset `at`, counted up to `limit`.
    fn chars_from(&self, at: usize, limit: usize) -> usize {
        self.text[at.min(self.text.len())..].iter().filter(|&&b| (b & 0xc0) != 0x80).take(limit).count()
    }

    fn hex4(&self, at: usize) -> Option<u32> {
        let digits = self.text.get(at..at + 4)?;
        digits.iter().try_fold(0u32, |n, &d| (d as char).to_digit(16).map(|v| n * 16 + v))
    }

    /// `scanstring`, entered with `at` on the opening quote.
    fn string(&mut self) -> Result<(), Fail> {
        let begin = self.at;
        let mut at = begin + 1;
        loop {
            match self.text.get(at) {
                None => return Err(("Unterminated string starting at", begin)),
                Some(b'"') => {
                    self.at = at + 1;
                    return Ok(());
                }
                Some(&b) if b < 0x20 => return Err(("Invalid control character at", at)),
                Some(b'\\') => {
                    let Some(&code) = self.text.get(at + 1) else {
                        return Err(("Unterminated string starting at", begin));
                    };
                    if code != b'u' {
                        if !matches!(code, b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't') {
                            return Err(("Invalid \\escape", at));
                        }
                        at += 2;
                        continue;
                    }
                    // Four hex digits, and the string must go on after them.
                    let digits = at + 2;
                    let Some(unit) = self.hex4(digits).filter(|_| self.chars_from(digits, 5) >= 5) else {
                        return Err(("Invalid \\uXXXX escape", at + 1));
                    };
                    at = digits + 4;
                    if (0xd800..0xdc00).contains(&unit) && self.chars_from(at, 7) >= 7 && self.text.get(at..at + 2) == Some(b"\\u") {
                        match self.hex4(at + 2) {
                            None => return Err(("Invalid \\uXXXX escape", at + 1)),
                            Some(low) if (0xdc00..0xe000).contains(&low) => at += 6,
                            Some(_) => {}
                        }
                    }
                }
                Some(_) => at += 1,
            }
        }
    }

    /// `_match_number_unicode` and the named constants; `Err(None)` is Python's `StopIteration`.
    fn scalar(&mut self) -> Result<(), Option<Box<PyErr>>> {
        let text = self.text;
        let start = self.at;
        let rest = &text[start..];
        for word in [&b"null"[..], b"true", b"false", b"NaN", b"Infinity", b"-Infinity"] {
            if rest.starts_with(word) {
                self.at = start + word.len();
                return Ok(());
            }
        }
        let end = text.len() - 1;
        let mut at = start;
        if text[at] == b'-' {
            at += 1;
            if at > end {
                return Err(None);
            }
        }
        let digits = at;
        match text[at] {
            b'1'..=b'9' => {
                at += 1;
                while at <= end && text[at].is_ascii_digit() {
                    at += 1;
                }
            }
            b'0' => at += 1,
            _ => return Err(None),
        }
        let integer_end = at;
        let mut is_float = false;
        if at < end && text[at] == b'.' && text[at + 1].is_ascii_digit() {
            is_float = true;
            at += 2;
            while at <= end && text[at].is_ascii_digit() {
                at += 1;
            }
        }
        if at < end && (text[at] == b'e' || text[at] == b'E') {
            let e_start = at;
            at += 1;
            if at < end && (text[at] == b'-' || text[at] == b'+') {
                at += 1;
            }
            while at <= end && text[at].is_ascii_digit() {
                at += 1;
            }
            if text[at - 1].is_ascii_digit() {
                is_float = true;
            } else {
                at = e_start;
            }
        }
        if !is_float && integer_end - digits > 4300 {
            return Err(Some(value_error(format!(
                "Exceeds the limit (4300 digits) for integer string conversion: value has {} digits; use sys.set_int_max_str_digits() to increase the limit",
                integer_end - digits
            ))));
        }
        self.at = at;
        Ok(())
    }

    fn document(&mut self) -> Outcome {
        // `true` for an object, `false` for an array.
        let mut stack: Vec<bool> = Vec::new();
        self.space();
        'value: loop {
            // A value is expected at `self.at`.
            match self.text.get(self.at) {
                None => return Outcome::Syntax("Expecting value", self.at),
                Some(b'"') => {
                    if let Err((message, at)) = self.string() {
                        return Outcome::Syntax(message, at);
                    }
                }
                Some(&open @ (b'{' | b'[')) => {
                    if stack.len() >= PYTHON_RECURSION_LIMIT {
                        let what = if open == b'{' { "object" } else { "array" };
                        return Outcome::Other(runtime_error(format!("maximum recursion depth exceeded while decoding a JSON {what} from a unicode string")));
                    }
                    self.at += 1;
                    self.space();
                    if open == b'[' {
                        if self.text.get(self.at) != Some(&b']') {
                            stack.push(false);
                            continue 'value;
                        }
                        self.at += 1;
                    } else if self.text.get(self.at) != Some(&b'}') {
                        stack.push(true);
                        if let Some(outcome) = self.key() {
                            return outcome;
                        }
                        continue 'value;
                    } else {
                        self.at += 1;
                    }
                }
                Some(_) => match self.scalar() {
                    Ok(()) => {}
                    Err(None) => return Outcome::Syntax("Expecting value", self.at),
                    Err(Some(error)) => return Outcome::Other(error),
                },
            }
            // A value just ended: close containers or move to the next element.
            loop {
                let Some(&is_object) = stack.last() else {
                    self.space();
                    return if self.at != self.text.len() { Outcome::Syntax("Extra data", self.at) } else { Outcome::Ok };
                };
                self.space();
                let closer = if is_object { b'}' } else { b']' };
                match self.text.get(self.at) {
                    Some(&b) if b == closer => {
                        self.at += 1;
                        stack.pop();
                    }
                    Some(b',') => {
                        self.at += 1;
                        self.space();
                        if is_object && let Some(outcome) = self.key() {
                            return outcome;
                        }
                        continue 'value;
                    }
                    _ => return Outcome::Syntax("Expecting ',' delimiter", self.at),
                }
            }
        }
    }

    /// An object key and its colon; leaves `at` on the value.
    fn key(&mut self) -> Option<Outcome> {
        if self.text.get(self.at) != Some(&b'"') {
            return Some(Outcome::Syntax("Expecting property name enclosed in double quotes", self.at));
        }
        if let Err((message, at)) = self.string() {
            return Some(Outcome::Syntax(message, at));
        }
        self.space();
        if self.text.get(self.at) != Some(&b':') {
            return Some(Outcome::Syntax("Expecting ':' delimiter", self.at));
        }
        self.at += 1;
        self.space();
        None
    }
}

/// The exception `json.loads(body.decode("utf-8"))` raises for `body`, or
/// `None` when Python reads it.
pub(crate) fn diagnose(body: &[u8]) -> Option<Box<PyErr>> {
    if let Some(message) = utf8_error(body) {
        return Some(value_error(message));
    }
    let located = |message: &str, at: usize| {
        let before = &body[..at.min(body.len())];
        let chars = |bytes: &[u8]| bytes.iter().filter(|&&b| (b & 0xc0) != 0x80).count();
        let position = chars(before);
        let line = before.iter().filter(|&&b| b == b'\n').count() + 1;
        let column = match before.iter().rposition(|&b| b == b'\n') {
            Some(newline) => chars(&before[newline + 1..]) + 1,
            None => position + 1,
        };
        value_error(format!("{message}: line {line} column {column} (char {position})"))
    };
    if body.starts_with(&[0xef, 0xbb, 0xbf]) {
        return Some(located("Unexpected UTF-8 BOM (decode using utf-8-sig)", 0));
    }
    match (Scanner { text: body, at: 0 }).document() {
        Outcome::Ok => None,
        Outcome::Syntax(message, at) => Some(located(message, at)),
        Outcome::Other(error) => Some(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(body: &[u8]) -> Option<String> {
        diagnose(body).map(|error| error.msg)
    }

    #[test]
    fn syntax_errors_read_like_python() {
        // Each expectation is `str(exception)` of `json.loads(body.decode())` in CPython 3.12.
        for (body, expected) in [
            (&b""[..], "Expecting value: line 1 column 1 (char 0)"),
            (b"[", "Expecting value: line 1 column 2 (char 1)"),
            (b"[1,]", "Expecting value: line 1 column 4 (char 3)"),
            (b"{\"a\":1,}", "Expecting property name enclosed in double quotes: line 1 column 8 (char 7)"),
            (b"{\"a\" 1}", "Expecting ':' delimiter: line 1 column 6 (char 5)"),
            (b"[1 2]", "Expecting ',' delimiter: line 1 column 4 (char 3)"),
            (b"{} x", "Extra data: line 1 column 4 (char 3)"),
            (b"01", "Extra data: line 1 column 2 (char 1)"),
            (b"\"abc", "Unterminated string starting at: line 1 column 1 (char 0)"),
            (b"\"a\\x\"", "Invalid \\escape: line 1 column 3 (char 2)"),
            (b"\"\\u12\"", "Invalid \\uXXXX escape: line 1 column 3 (char 2)"),
            (b"\"a\nb\"", "Invalid control character at: line 1 column 3 (char 2)"),
            (b"[\n1,\n x]", "Expecting value: line 3 column 2 (char 6)"),
            (b"nul", "Expecting value: line 1 column 1 (char 0)"),
            (b"-", "Expecting value: line 1 column 1 (char 0)"),
            (b"\xef\xbb\xbf{}", "Unexpected UTF-8 BOM (decode using utf-8-sig): line 1 column 1 (char 0)"),
            (b"\xff", "'utf-8' codec can't decode byte 0xff in position 0: invalid start byte"),
            (b"\"\xe2\x82\"", "'utf-8' codec can't decode bytes in position 1-2: invalid continuation byte"),
            (b"\"\xe2\x82", "'utf-8' codec can't decode bytes in position 1-2: unexpected end of data"),
        ] {
            assert_eq!(message(body).as_deref(), Some(expected), "{:?}", String::from_utf8_lossy(body));
        }
    }

    #[test]
    fn text_python_reads_is_not_an_error() {
        for body in [&b"{}"[..], b" [1, 2.5e3, -0, NaN, Infinity, -Infinity, \"\\ud800\", null] ", b"{\"a\":{\"a\":1}}", b"1.", b"1e"] {
            // `1.` and `1e` read `1` and leave text behind: that is "Extra data", not acceptance.
            let expected = !matches!(body, b"1." | b"1e");
            assert_eq!(message(body).is_none(), expected, "{:?}", String::from_utf8_lossy(body));
        }
    }

    #[test]
    fn python_style_values_serialize_as_json_dumps_does() {
        let value = Py::Dict(vec![("ok", Py::Bool(false)), ("error", Py::str("caf\u{e9} \"x\" \u{1f600}")), ("n", Py::Float(1.0)), ("i", Py::Int(-3))]);
        assert_eq!(String::from_utf8(to_bytes(&value)).unwrap(), "{\"ok\":false,\"error\":\"caf\\u00e9 \\\"x\\\" \\ud83d\\ude00\",\"n\":1.0,\"i\":-3}");
    }
}
