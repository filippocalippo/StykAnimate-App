//! JSON text in and out, with JavaScript's exact behaviour.
//!
//! [`parse`] builds a tree the way `JSON.parse` does (key order, duplicate keys,
//! number rounding); [`write`] prints it the way `JSON.stringify` does. Reading a
//! file's JSON and writing it back therefore yields the same bytes, which the
//! file format's checksums depend on.

use std::collections::HashMap;
use std::sync::Arc;

use base64::Engine as _;

use crate::value::{Nums, Obj, Shape, Value, index_key};
use crate::{JsonError, format_number};

/// How deep arrays and objects may nest. Movieclips nest documents; sixteen
/// nested clips reach about 150 levels.
pub const MAX_DEPTH: usize = 512;

/// Decides what a string value becomes. The container reader uses it to turn
/// section markers into packed arrays and blobs while the tree is built.
pub trait StringHook {
    /// Called for every string value (not for keys). Return `None` to keep the string.
    fn string(&mut self, text: &str) -> Option<Result<Value, JsonError>>;
}

struct KeepStrings;
impl StringHook for KeepStrings {
    fn string(&mut self, _: &str) -> Option<Result<Value, JsonError>> {
        None
    }
}

/// Reads JSON text.
pub fn parse(text: &[u8]) -> Result<Value, JsonError> {
    parse_with(text, &mut KeepStrings)
}

/// Reads JSON text, passing every string value through `hook`.
pub fn parse_with(text: &[u8], hook: &mut dyn StringHook) -> Result<Value, JsonError> {
    let mut parser = Parser { text, at: 0, keys: HashMap::new(), shapes: HashMap::new(), scratch: String::new(), hook };
    // A leading byte-order mark is tolerated, as the app's own readers do before parsing.
    if text.starts_with(&[0xef, 0xbb, 0xbf]) {
        parser.at = 3;
    }
    parser.space();
    let value = parser.value(0)?;
    parser.space();
    if parser.at != text.len() {
        return Err(parser.error("unexpected text after the document"));
    }
    Ok(value)
}

/// A member of a scanned root object: its key, and the bytes of its value in the text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Member {
    pub key: String,
    pub value: std::ops::Range<usize>,
}

/// Checks JSON text without building a tree, as [`parse`] would read it, and returns where each
/// member of a root object lies (`None` when the root is not an object).
pub fn scan(text: &[u8]) -> Result<Option<Vec<Member>>, JsonError> {
    scan_with(text, &mut KeepStrings)
}

/// [`scan`], passing every string value through `hook` as [`parse_with`] does. An error from the
/// hook ends the scan; the values it returns are dropped, so a hook that only checks builds nothing.
pub fn scan_with(text: &[u8], hook: &mut dyn StringHook) -> Result<Option<Vec<Member>>, JsonError> {
    let mut parser = Parser { text, at: 0, keys: HashMap::new(), shapes: HashMap::new(), scratch: String::new(), hook };
    if text.starts_with(&[0xef, 0xbb, 0xbf]) {
        parser.at = 3;
    }
    parser.space();
    let members = if parser.text.get(parser.at) == Some(&b'{') {
        Some(parser.scan_root()?)
    } else {
        parser.skip(0)?;
        None
    };
    parser.space();
    if parser.at != text.len() {
        return Err(parser.error("unexpected text after the document"));
    }
    Ok(members)
}

struct Parser<'a> {
    text: &'a [u8],
    at: usize,
    /// One allocation per distinct key in the document.
    keys: HashMap<&'a [u8], Arc<str>>,
    /// One key list per distinct object layout, found by the addresses of its interned keys.
    shapes: HashMap<Vec<usize>, Arc<Shape>>,
    scratch: String,
    hook: &'a mut dyn StringHook,
}

impl<'a> Parser<'a> {
    fn error(&self, message: &'static str) -> JsonError {
        JsonError::Syntax { offset: self.at, message }
    }

    fn space(&mut self) {
        while let Some(&b) = self.text.get(self.at) {
            if b == b' ' || b == b'\n' || b == b'\r' || b == b'\t' {
                self.at += 1;
            } else {
                break;
            }
        }
    }

    fn value(&mut self, depth: usize) -> Result<Value, JsonError> {
        match self.text.get(self.at) {
            Some(b'{') => self.object(depth),
            Some(b'[') => self.array(depth),
            Some(b'"') => {
                let (start, end, escaped) = self.string_span()?;
                let text: &str = if escaped {
                    self.unescape(start, end)?;
                    // The hook borrows the scratch buffer only for this call.
                    let scratch = std::mem::take(&mut self.scratch);
                    let result = self.finish_string(&scratch);
                    self.scratch = scratch;
                    return result;
                } else {
                    std::str::from_utf8(&self.text[start..end]).map_err(|_| self.error("invalid UTF-8 in a string"))?
                };
                self.finish_string(text)
            }
            Some(b't') => self.literal(b"true", Value::Bool(true)),
            Some(b'f') => self.literal(b"false", Value::Bool(false)),
            Some(b'n') => self.literal(b"null", Value::Null),
            Some(b'-' | b'0'..=b'9') => self.number().map(Value::Num),
            Some(_) => Err(self.error("unexpected character")),
            None => Err(self.error("unexpected end of text")),
        }
    }

    fn finish_string(&mut self, text: &str) -> Result<Value, JsonError> {
        match self.hook.string(text) {
            Some(result) => result,
            None => Ok(Value::Str(Arc::from(text))),
        }
    }

    fn literal(&mut self, word: &'static [u8], value: Value) -> Result<Value, JsonError> {
        if self.text[self.at..].starts_with(word) {
            self.at += word.len();
            Ok(value)
        } else {
            Err(self.error("unexpected character"))
        }
    }

    fn number(&mut self) -> Result<f64, JsonError> {
        let start = self.at;
        let text = self.text;
        let mut at = start;
        if text.get(at) == Some(&b'-') {
            at += 1;
        }
        let digits = at;
        match text.get(at) {
            Some(b'0') => at += 1,
            Some(b'1'..=b'9') => {
                while matches!(text.get(at), Some(b'0'..=b'9')) {
                    at += 1;
                }
            }
            _ => {
                self.at = at;
                return Err(self.error("a number needs digits"));
            }
        }
        let mut integer = true;
        if text.get(at) == Some(&b'.') {
            integer = false;
            at += 1;
            if !matches!(text.get(at), Some(b'0'..=b'9')) {
                self.at = at;
                return Err(self.error("a fraction needs digits"));
            }
            while matches!(text.get(at), Some(b'0'..=b'9')) {
                at += 1;
            }
        }
        if matches!(text.get(at), Some(b'e' | b'E')) {
            integer = false;
            at += 1;
            if matches!(text.get(at), Some(b'+' | b'-')) {
                at += 1;
            }
            if !matches!(text.get(at), Some(b'0'..=b'9')) {
                self.at = at;
                return Err(self.error("an exponent needs digits"));
            }
            while matches!(text.get(at), Some(b'0'..=b'9')) {
                at += 1;
            }
        }
        self.at = at;
        // Up to 15 digits are exact in a double: no general conversion needed.
        if integer && at - digits <= 15 {
            let magnitude = text[digits..at].iter().fold(0u64, |n, &d| n * 10 + (d - b'0') as u64) as f64;
            return Ok(if digits > start { -magnitude } else { magnitude });
        }
        // The grammar above admits ASCII only, and Rust's conversion rounds correctly, as JavaScript's does.
        let slice = unsafe { std::str::from_utf8_unchecked(&text[start..at]) };
        slice.parse::<f64>().map_err(|_| JsonError::Syntax { offset: start, message: "invalid number" })
    }

    /// Finds the closing quote. Returns the content span and whether it has escapes.
    fn string_span(&mut self) -> Result<(usize, usize, bool), JsonError> {
        let start = self.at + 1;
        let mut at = start;
        let mut escaped = false;
        loop {
            match self.text.get(at) {
                Some(b'"') => break,
                Some(b'\\') => {
                    escaped = true;
                    at += 2;
                }
                Some(&b) if b < 0x20 => {
                    self.at = at;
                    return Err(self.error("control character in a string"));
                }
                Some(_) => at += 1,
                None => {
                    self.at = at;
                    return Err(self.error("unterminated string"));
                }
            }
        }
        if at > self.text.len() {
            self.at = self.text.len();
            return Err(self.error("unterminated string"));
        }
        self.at = at + 1;
        Ok((start, at, escaped))
    }

    /// Decodes escapes of `text[start..end]` into the scratch buffer.
    fn unescape(&mut self, start: usize, end: usize) -> Result<(), JsonError> {
        let source = &self.text[start..end];
        let mut out = std::mem::take(&mut self.scratch);
        out.clear();
        let fail = |offset: usize, message: &'static str| JsonError::Syntax { offset: start + offset, message };
        let hex4 = |at: usize| -> Result<u32, JsonError> {
            let digits = source.get(at..at + 4).ok_or(fail(at, "incomplete \\u escape"))?;
            digits.iter().try_fold(0u32, |n, &d| (d as char).to_digit(16).map(|v| n * 16 + v)).ok_or(fail(at, "invalid \\u escape"))
        };
        let mut at = 0;
        let mut run = 0;
        while at < source.len() {
            if source[at] != b'\\' {
                at += 1;
                continue;
            }
            out.push_str(std::str::from_utf8(&source[run..at]).map_err(|_| fail(run, "invalid UTF-8 in a string"))?);
            let code = *source.get(at + 1).ok_or(fail(at, "incomplete escape"))?;
            at += 2;
            match code {
                b'"' => out.push('"'),
                b'\\' => out.push('\\'),
                b'/' => out.push('/'),
                b'b' => out.push('\u{8}'),
                b'f' => out.push('\u{c}'),
                b'n' => out.push('\n'),
                b'r' => out.push('\r'),
                b't' => out.push('\t'),
                b'u' => {
                    let unit = hex4(at)?;
                    at += 4;
                    let scalar = if (0xd800..0xdc00).contains(&unit) && source.get(at..at + 2) == Some(b"\\u") {
                        let low = hex4(at + 2)?;
                        if (0xdc00..0xe000).contains(&low) {
                            at += 6;
                            0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00)
                        } else {
                            unit
                        }
                    } else {
                        unit
                    };
                    // A surrogate without its pair has no UTF-8 form. JavaScript keeps it; the
                    // store replaces it (see docs/engine/formats.md, "Known deviations").
                    out.push(char::from_u32(scalar).unwrap_or('\u{fffd}'));
                }
                _ => return Err(fail(at - 2, "unknown escape")),
            }
            run = at;
        }
        out.push_str(std::str::from_utf8(&source[run..]).map_err(|_| fail(run, "invalid UTF-8 in a string"))?);
        self.scratch = out;
        Ok(())
    }

    /// Passes a string value to the hook, keeping nothing.
    fn check_string(&mut self, start: usize, end: usize, escaped: bool) -> Result<(), JsonError> {
        let result = if escaped {
            self.unescape(start, end)?;
            let scratch = std::mem::take(&mut self.scratch);
            let result = self.hook.string(&scratch);
            self.scratch = scratch;
            result
        } else {
            let text = std::str::from_utf8(&self.text[start..end]).map_err(|_| self.error("invalid UTF-8 in a string"))?;
            self.hook.string(text)
        };
        match result {
            Some(Err(error)) => Err(error),
            _ => Ok(()),
        }
    }

    /// Reads a key without interning it, returning its text.
    fn key_text(&mut self) -> Result<String, JsonError> {
        if self.text.get(self.at) != Some(&b'"') {
            return Err(self.error("expected a key"));
        }
        let (start, end, escaped) = self.string_span()?;
        if escaped {
            self.unescape(start, end)?;
            return Ok(self.scratch.clone());
        }
        std::str::from_utf8(&self.text[start..end]).map(str::to_string).map_err(|_| self.error("invalid UTF-8 in a key"))
    }

    /// Validates a key without copying or interning it.
    fn skip_key(&mut self) -> Result<(), JsonError> {
        if self.text.get(self.at) != Some(&b'"') {
            return Err(self.error("expected a key"));
        }
        let (start, end, escaped) = self.string_span()?;
        if escaped {
            self.unescape(start, end)
        } else {
            std::str::from_utf8(&self.text[start..end]).map(drop).map_err(|_| self.error("invalid UTF-8 in a key"))
        }
    }

    /// The members of the root object, each value skipped and its bytes noted.
    fn scan_root(&mut self) -> Result<Vec<Member>, JsonError> {
        self.at += 1;
        self.space();
        let mut members = Vec::new();
        if self.text.get(self.at) == Some(&b'}') {
            self.at += 1;
            return Ok(members);
        }
        loop {
            let key = self.key_text()?;
            self.space();
            if self.text.get(self.at) != Some(&b':') {
                return Err(self.error("expected : after a key"));
            }
            self.at += 1;
            self.space();
            let start = self.at;
            self.skip(1)?;
            members.push(Member { key, value: start..self.at });
            self.space();
            match self.text.get(self.at) {
                Some(b',') => {
                    self.at += 1;
                    self.space();
                }
                Some(b'}') => {
                    self.at += 1;
                    return Ok(members);
                }
                _ => return Err(self.error("expected , or } in an object")),
            }
        }
    }

    /// Reads one value as `value` does and builds nothing.
    fn skip(&mut self, depth: usize) -> Result<(), JsonError> {
        match self.text.get(self.at) {
            Some(b'{') => {
                if depth >= MAX_DEPTH {
                    return Err(JsonError::Depth(MAX_DEPTH));
                }
                self.at += 1;
                self.space();
                if self.text.get(self.at) == Some(&b'}') {
                    self.at += 1;
                    return Ok(());
                }
                loop {
                    self.skip_key()?;
                    self.space();
                    if self.text.get(self.at) != Some(&b':') {
                        return Err(self.error("expected : after a key"));
                    }
                    self.at += 1;
                    self.space();
                    self.skip(depth + 1)?;
                    self.space();
                    match self.text.get(self.at) {
                        Some(b',') => {
                            self.at += 1;
                            self.space();
                        }
                        Some(b'}') => {
                            self.at += 1;
                            return Ok(());
                        }
                        _ => return Err(self.error("expected , or } in an object")),
                    }
                }
            }
            Some(b'[') => {
                if depth >= MAX_DEPTH {
                    return Err(JsonError::Depth(MAX_DEPTH));
                }
                self.at += 1;
                self.space();
                if self.text.get(self.at) == Some(&b']') {
                    self.at += 1;
                    return Ok(());
                }
                loop {
                    self.skip(depth + 1)?;
                    self.space();
                    match self.text.get(self.at) {
                        Some(b',') => {
                            self.at += 1;
                            self.space();
                        }
                        Some(b']') => {
                            self.at += 1;
                            return Ok(());
                        }
                        _ => return Err(self.error("expected , or ] in an array")),
                    }
                }
            }
            Some(b'"') => {
                let (start, end, escaped) = self.string_span()?;
                self.check_string(start, end, escaped)
            }
            Some(b't') => self.literal(b"true", Value::Null).map(drop),
            Some(b'f') => self.literal(b"false", Value::Null).map(drop),
            Some(b'n') => self.literal(b"null", Value::Null).map(drop),
            Some(b'-' | b'0'..=b'9') => self.number().map(drop),
            Some(_) => Err(self.error("unexpected character")),
            None => Err(self.error("unexpected end of text")),
        }
    }

    fn array(&mut self, depth: usize) -> Result<Value, JsonError> {
        if depth >= MAX_DEPTH {
            return Err(JsonError::Depth(MAX_DEPTH));
        }
        self.at += 1;
        self.space();
        if self.text.get(self.at) == Some(&b']') {
            self.at += 1;
            return Ok(Value::Arr(Arc::new(Vec::new())));
        }
        // Most arrays are numbers only: collect them unboxed until something else appears.
        let mut numbers: Vec<f64> = Vec::new();
        let mut items: Option<Vec<Value>> = None;
        loop {
            if items.is_none() && matches!(self.text.get(self.at), Some(b'-' | b'0'..=b'9')) {
                numbers.push(self.number()?);
            } else {
                let value = self.value(depth + 1)?;
                match (&mut items, value) {
                    (None, Value::Num(n)) => numbers.push(n),
                    (None, value) => {
                        let mut list: Vec<Value> = numbers.drain(..).map(Value::Num).collect();
                        list.push(value);
                        items = Some(list);
                    }
                    (Some(list), value) => list.push(value),
                }
            }
            self.space();
            match self.text.get(self.at) {
                Some(b',') => {
                    self.at += 1;
                    self.space();
                }
                Some(b']') => {
                    self.at += 1;
                    break;
                }
                _ => return Err(self.error("expected , or ] in an array")),
            }
        }
        Ok(match items {
            Some(list) => Value::Arr(Arc::new(list)),
            None => Value::Nums(Arc::new(Nums::new(&numbers))),
        })
    }

    fn key(&mut self) -> Result<Arc<str>, JsonError> {
        if self.text.get(self.at) != Some(&b'"') {
            return Err(self.error("expected a key"));
        }
        let (start, end, escaped) = self.string_span()?;
        if escaped {
            self.unescape(start, end)?;
            return Ok(Arc::from(self.scratch.as_str()));
        }
        let bytes = &self.text[start..end];
        if let Some(key) = self.keys.get(bytes) {
            return Ok(key.clone());
        }
        let key: Arc<str> = Arc::from(std::str::from_utf8(bytes).map_err(|_| self.error("invalid UTF-8 in a key"))?);
        self.keys.insert(bytes, key.clone());
        Ok(key)
    }

    fn object(&mut self, depth: usize) -> Result<Value, JsonError> {
        if depth >= MAX_DEPTH {
            return Err(JsonError::Depth(MAX_DEPTH));
        }
        self.at += 1;
        self.space();
        let mut keys: Vec<Arc<str>> = Vec::new();
        let mut values: Vec<Value> = Vec::new();
        // Duplicate or integer-like keys need JavaScript's ordering rules: rebuild through `Obj::set`.
        let mut plain = true;
        if self.text.get(self.at) == Some(&b'}') {
            self.at += 1;
            return Ok(Value::Obj(Arc::new(Obj::new())));
        }
        loop {
            let key = self.key()?;
            self.space();
            if self.text.get(self.at) != Some(&b':') {
                return Err(self.error("expected : after a key"));
            }
            self.at += 1;
            self.space();
            let value = self.value(depth + 1)?;
            if plain && (key.as_bytes().first().is_some_and(u8::is_ascii_digit) && index_key(&key).is_some() || keys.iter().any(|k| Arc::ptr_eq(k, &key) || **k == *key)) {
                plain = false;
            }
            keys.push(key);
            values.push(value);
            self.space();
            match self.text.get(self.at) {
                Some(b',') => {
                    self.at += 1;
                    self.space();
                }
                Some(b'}') => {
                    self.at += 1;
                    break;
                }
                _ => return Err(self.error("expected , or } in an object")),
            }
        }
        if !plain {
            return Ok(Value::Obj(Arc::new(keys.into_iter().zip(values).collect())));
        }
        let identity: Vec<usize> = keys.iter().map(|k| Arc::as_ptr(k) as *const u8 as usize).collect();
        let shape = match self.shapes.get(&identity) {
            Some(shape) => shape.clone(),
            None => {
                let shape = Shape::new(keys);
                self.shapes.insert(identity, shape.clone());
                shape
            }
        };
        Ok(Value::Obj(Arc::new(Obj::from_shape(shape, values))))
    }
}

/// Writes `value` as `JSON.stringify(value)` would.
pub fn write(value: &Value, out: &mut Vec<u8>) {
    match value {
        Value::Null => out.extend_from_slice(b"null"),
        Value::Bool(true) => out.extend_from_slice(b"true"),
        Value::Bool(false) => out.extend_from_slice(b"false"),
        Value::Num(n) => format_number(*n, out),
        Value::Str(s) => write_string(s, out),
        Value::Blob(blob) => {
            write_string(&blob.prefix, out);
            out.pop();
            base64_into(&blob.bytes, out);
            out.push(b'"');
        }
        Value::Nums(numbers) => write_numbers(numbers, out),
        Value::Arr(items) => {
            out.push(b'[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                write(item, out);
            }
            out.push(b']');
        }
        Value::Obj(object) => {
            out.push(b'{');
            for (i, (key, item)) in object.iter().enumerate() {
                if i > 0 {
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

/// `JSON.stringify(value)` as text.
pub fn to_string(value: &Value) -> String {
    let mut out = Vec::new();
    write(value, &mut out);
    // The writer emits UTF-8 from `str` data and ASCII punctuation only.
    unsafe { String::from_utf8_unchecked(out) }
}

/// Writes a packed array as `[a,b,…]`.
pub fn write_numbers(numbers: &Nums, out: &mut Vec<u8>) {
    out.push(b'[');
    for (i, n) in numbers.iter().enumerate() {
        if i > 0 {
            out.push(b',');
        }
        format_number(n, out);
    }
    out.push(b']');
}

/// Writes a quoted string with `JSON.stringify`'s escapes: `"` and `\`, the short
/// forms for backspace, form feed, newline, return and tab, `\u00xx` for other
/// control characters, and everything else as it is.
pub fn write_string(text: &str, out: &mut Vec<u8>) {
    out.push(b'"');
    let bytes = text.as_bytes();
    let mut run = 0;
    for (i, &b) in bytes.iter().enumerate() {
        let escape: &[u8] = match b {
            b'"' => b"\\\"",
            b'\\' => b"\\\\",
            0x08 => b"\\b",
            0x0c => b"\\f",
            b'\n' => b"\\n",
            b'\r' => b"\\r",
            b'\t' => b"\\t",
            0..0x20 => {
                out.extend_from_slice(&bytes[run..i]);
                out.extend_from_slice(b"\\u00");
                out.push(b"0123456789abcdef"[(b >> 4) as usize]);
                out.push(b"0123456789abcdef"[(b & 15) as usize]);
                run = i + 1;
                continue;
            }
            _ => continue,
        };
        out.extend_from_slice(&bytes[run..i]);
        out.extend_from_slice(escape);
        run = i + 1;
    }
    out.extend_from_slice(&bytes[run..]);
    out.push(b'"');
}

/// The UTF-8 length of `text` as a JSON string, quotes included, without building it.
pub fn string_bytes(text: &str) -> usize {
    2 + text.bytes().map(|b| match b {
        b'"' | b'\\' | 0x08 | 0x09 | 0x0a | 0x0c | 0x0d => 2,
        0..0x20 => 6,
        _ => 1,
    }).sum::<usize>()
}

/// `JSON.stringify(value).length`: UTF-16 code units, without allocating the JSON
/// text or encoded blobs. Traverses the value, so call on a preparation worker for
/// document-sized data. This uses the same numeric formatter and string escapes
/// as [`write`].
pub fn utf16_units(value: &Value) -> usize {
    match utf16_units_checked(value, || Ok::<(), std::convert::Infallible>(())) {
        Ok(units) => units,
        Err(error) => match error {},
    }
}

/// The same JSON weight owner, with cooperative cancellation/stale/progress
/// checks during a dense single string or numeric array as well as containers.
/// The caller owns the worker and its cancellation contract. Checks run before
/// traversal and after at most 4096 visited nodes, numbers, or text characters.
pub fn utf16_units_checked<E>(
    value: &Value,
    mut check: impl FnMut() -> Result<(), E>,
) -> Result<usize, E> {
    fn touch<E>(pending: &mut usize, check: &mut impl FnMut() -> Result<(), E>) -> Result<(), E> {
        *pending += 1;
        if *pending == 4096 {
            *pending = 0;
            check()?;
        }
        Ok(())
    }
    fn string<E>(
        text: &str,
        pending: &mut usize,
        check: &mut impl FnMut() -> Result<(), E>,
    ) -> Result<usize, E> {
        let mut units = 2;
        for character in text.chars() {
            touch(pending, check)?;
            units += match character {
                '"' | '\\' | '\u{08}' | '\t' | '\n' | '\u{0c}' | '\r' => 2,
                '\0'..='\u{1f}' => 6,
                _ => character.len_utf16(),
            };
        }
        Ok(units)
    }
    fn count<E>(
        value: &Value,
        number: &mut Vec<u8>,
        pending: &mut usize,
        check: &mut impl FnMut() -> Result<(), E>,
    ) -> Result<usize, E> {
        touch(pending, check)?;
        Ok(match value {
            Value::Null => 4,
            Value::Bool(true) => 4,
            Value::Bool(false) => 5,
            Value::Num(n) => {
                number.clear();
                format_number(*n, number);
                number.len()
            }
            Value::Str(text) => string(text, pending, check)?,
            Value::Blob(blob) => {
                string(&blob.prefix, pending, check)? + blob.bytes.len().div_ceil(3) * 4
            }
            Value::Nums(numbers) => {
                let mut units = 2 + numbers.len().saturating_sub(1);
                for n in numbers.iter() {
                    touch(pending, check)?;
                    number.clear();
                    format_number(n, number);
                    units += number.len();
                }
                units
            }
            Value::Arr(items) => {
                let mut units = 2 + items.len().saturating_sub(1);
                for item in items.iter() {
                    units += count(item, number, pending, check)?;
                }
                units
            }
            Value::Obj(object) => {
                let mut units = 2 + object.len().saturating_sub(1);
                for (key, item) in object.iter() {
                    units +=
                        string(key, pending, check)? + 1 + count(item, number, pending, check)?;
                }
                units
            }
        })
    }
    check()?;
    count(value, &mut Vec::with_capacity(32), &mut 0, &mut check)
}

/// Appends the standard, padded base64 of `bytes`.
pub fn base64_into(bytes: &[u8], out: &mut Vec<u8>) {
    let start = out.len();
    out.resize(start + bytes.len().div_ceil(3) * 4, 0);
    base64::engine::general_purpose::STANDARD.encode_slice(bytes, &mut out[start..]).expect("the output was sized for the input");
}

/// Decodes standard, padded base64 as the app does: `None` unless `text` is
/// exactly the canonical encoding of the returned bytes.
pub fn base64_strict(text: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::STANDARD.decode(text).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip(text: &str) {
        assert_eq!(to_string(&parse(text.as_bytes()).unwrap()), text);
    }

    #[test]
    fn text_written_by_javascript_round_trips_byte_for_byte() {
        // Each line is `JSON.stringify` output from V8.
        for text in [
            r#"{"version":5,"fps":33,"keyframes":[{"objects":[{"unique_id":1,"angles":[0,1.5707963267948966,-0.25],"join":null}]}]}"#,
            r#"{"a":"quote \" slash \\ tab \t newline \n unit \u001f é 漢 😀 /"}"#,
            r#"[1e+21,1e-7,0.000001,123456789012345680000,-0.5,5e-324,1.7976931348623157e+308]"#,
            r#"{"0":"x","2":"y","10":"z","b":true,"a":false,"07":null}"#,
            r#"[[],{},[[]],[{}],"",[null,1],[1,null]]"#,
        ] {
            round_trip(text);
        }
    }

    #[test]
    fn keys_are_ordered_and_deduplicated_as_json_parse_does() {
        // JSON.parse('{"b":1,"2":2,"a":3,"1":4,"b":5}') enumerates 1, 2, b, a and keeps the last b.
        let value = parse(br#"{"b":1,"2":2,"a":3,"1":4,"b":5}"#).unwrap();
        assert_eq!(to_string(&value), r#"{"1":4,"2":2,"b":5,"a":3}"#);
    }

    #[test]
    fn number_arrays_are_packed_and_others_are_not() {
        let value = parse(b"[[1,2,3],[1,\"a\"],[0.5,0.25],[0.1]]").unwrap();
        let items = value.as_arr().unwrap();
        assert!(matches!(items[0].as_nums(), Some(Nums::F32(_))));
        assert!(items[1].as_arr().is_some());
        assert!(matches!(items[2].as_nums(), Some(Nums::F32(_))));
        assert!(matches!(items[3].as_nums(), Some(Nums::F64(_))));
    }

    #[test]
    fn objects_with_the_same_keys_share_one_key_list() {
        let value = parse(br#"[{"x":1,"y":2},{"x":3,"y":4},{"y":5,"x":6}]"#).unwrap();
        let items = value.as_arr().unwrap();
        let shape = |i: usize| items[i].as_obj().unwrap().shape().clone();
        assert!(Arc::ptr_eq(&shape(0), &shape(1)));
        assert!(!Arc::ptr_eq(&shape(0), &shape(2)));
    }

    #[test]
    fn numbers_round_as_javascript_rounds_them() {
        for (text, expected) in [
            ("9007199254740993", 9007199254740992.0),
            ("0.1", 0.1),
            ("1e400", f64::INFINITY),
            ("-0", -0.0),
            ("123456789012345678", 123456789012345680.0),
            ("2.2250738585072011e-308", 2.225073858507201e-308),
        ] {
            let parsed = parse(text.as_bytes()).unwrap().as_f64().unwrap();
            assert_eq!(parsed.to_bits(), f64::to_bits(expected), "{text}");
        }
    }

    #[test]
    fn malformed_text_is_rejected_with_its_position() {
        for text in ["", "{", "[1,]", "{\"a\":}", "01", "1.", "\"\\x\"", "[1] 2", "nul", "\"a\nb\"", "{\"a\" 1}"] {
            assert!(matches!(parse(text.as_bytes()), Err(JsonError::Syntax { .. })), "{text:?} must not parse");
        }
        let deep = "[".repeat(MAX_DEPTH + 1);
        assert_eq!(parse(deep.as_bytes()), Err(JsonError::Depth(MAX_DEPTH)));
    }

    #[test]
    fn surrogate_pairs_decode_and_escaped_keys_work() {
        let value = parse(br#"{"k\u0041":"\ud83d\ude00 \u00e9"}"#).unwrap();
        assert_eq!(value.get("kA").and_then(Value::as_str), Some("😀 é"));
    }

    #[test]
    fn a_hook_can_replace_strings() {
        struct Upper;
        impl StringHook for Upper {
            fn string(&mut self, text: &str) -> Option<Result<Value, JsonError>> {
                text.starts_with('!').then(|| Ok(Value::Num(text.len() as f64)))
            }
        }
        let value = parse_with(br#"["!abc","abc",{"!k":"!\n"}]"#, &mut Upper).unwrap();
        assert_eq!(to_string(&value), r#"[4,"abc",{"!k":2}]"#);
    }

    #[test]
    fn string_bytes_matches_the_writer() {
        for text in ["", "plain", "q\"b\\s", "\u{1}\t\n", "é漢😀"] {
            let mut out = Vec::new();
            write_string(text, &mut out);
            assert_eq!(string_bytes(text), out.len(), "{text:?}");
        }
    }

    #[test]
    fn utf16_units_matches_javascript_text_length_without_building_it() {
        for text in [r#"{"quote\"":"😀é漢\u0000\n","numbers":[0,1.2,1e+21,1e-7],"array":[true,false,null]}"#, "[]", "{}", "\"\"", "[1,2,3]"] {
            let value = parse(text.as_bytes()).unwrap();
            assert_eq!(utf16_units(&value), to_string(&value).encode_utf16().count());
        }
        for n in [f64::NAN, f64::INFINITY, -0.0, 5e-324] {
            let value = Value::Num(n);
            assert_eq!(utf16_units(&value), to_string(&value).encode_utf16().count());
        }
        let value=Value::Blob(Arc::new(crate::value::Blob { prefix:Arc::from("data:🦊;base64,\n"),bytes:Arc::from([0,1,2,3,4]) }));
        assert_eq!(utf16_units(&value),to_string(&value).encode_utf16().count());
    }

    #[test]
    fn dense_single_values_check_before_completion_without_mutating() {
        for value in [Value::nums(&vec![1.25; 100_000]), Value::str(&"🦊".repeat(100_000))] {
            let mut checks = 0;
            let result = utf16_units_checked(&value, || { checks += 1; if checks == 3 { Err("cancelled") } else { Ok(()) } });
            assert_eq!(result,Err("cancelled"));
            assert_eq!(checks,3);
            assert_eq!(utf16_units_checked(&value,||Ok::<_, &str>(())).unwrap(),utf16_units(&value));
        }
    }

    /// A hook that notes every string value it is given.
    struct Seen(Vec<String>);
    impl StringHook for Seen {
        fn string(&mut self, text: &str) -> Option<Result<Value, JsonError>> {
            self.0.push(text.to_string());
            None
        }
    }

    #[test]
    fn a_scan_accepts_and_refuses_exactly_what_a_parse_does() {
        for text in [
            r#"{"version":5,"fps":33,"keyframes":[{"objects":[{"unique_id":1,"angles":[0,1.5707963267948966,-0.25],"join":null}]}]}"#,
            r#"{"a":"quote \" slash \\ tab \t unit \u001f é 漢 😀 \ud83d\ude00 \ud800"}"#,
            r#"[1e+21,1e-7,0.000001,-0.5,5e-324,true,false,null]"#,
            r#"  {"b":1,"2":2,"b":5}  "#,
            r#"[[],{},[[]],[{}],""]"#,
            "\u{feff}{}",
            r#""just a string""#,
            "12",
            // refused
            "", "{", "[1,]", "[,1]", r#"{"a":1,}"#, r#"{"a" 1}"#, r#"{a:1}"#, r#"{"a":01}"#, r#"{"a":1.}"#, r#"{"a":1e}"#, "tru", "nul", r#"{"a":"\q"}"#,
            r#"{"a":"\u12"}"#, "\"line\nbreak\"", r#"{"a":1} x"#, r#"["unterminated"#, r#"{"a":[}"#,
        ] {
            assert_eq!(scan(text.as_bytes()).is_ok(), parse(text.as_bytes()).is_ok(), "{text:?}");
        }
        let deep = "[".repeat(MAX_DEPTH + 1) + &"]".repeat(MAX_DEPTH + 1);
        assert_eq!(scan(deep.as_bytes()), Err(JsonError::Depth(MAX_DEPTH)));
        assert_eq!(parse(deep.as_bytes()).err(), Some(JsonError::Depth(MAX_DEPTH)));
        let nested = "[".repeat(MAX_DEPTH) + &"]".repeat(MAX_DEPTH);
        assert!(scan(nested.as_bytes()).is_ok() && parse(nested.as_bytes()).is_ok());
    }

    #[test]
    fn a_scan_reports_the_root_members_and_every_string_value() {
        let text = br#" {"a": 1, "b\u0063": {"x":"in"}, "d":["s",{"k":"v"}], "e": "t"} "#;
        let mut seen = Seen(Vec::new());
        let members = scan_with(text, &mut seen).unwrap().unwrap();
        assert_eq!(members.iter().map(|m| m.key.as_str()).collect::<Vec<_>>(), ["a", "bc", "d", "e"]);
        let slice = |i: usize| std::str::from_utf8(&text[members[i].value.clone()]).unwrap();
        assert_eq!((slice(0), slice(1), slice(2), slice(3)), ("1", r#"{"x":"in"}"#, r#"["s",{"k":"v"}]"#, r#""t""#));
        assert_eq!(seen.0, ["in", "s", "v", "t"], "string values in document order; keys are not strings values");
        assert_eq!(scan(b"[1]").unwrap(), None);
        assert_eq!(scan(b"{}").unwrap(), Some(Vec::new()));
        assert_eq!(scan("\u{feff}{\"a\":2}".as_bytes()).unwrap().unwrap()[0].value, 8..9);
    }

    #[test]
    fn a_hook_error_ends_a_scan() {
        struct Refuse;
        impl StringHook for Refuse {
            fn string(&mut self, text: &str) -> Option<Result<Value, JsonError>> {
                (text == "bad").then_some(Err(JsonError::Syntax { offset: 0, message: "refused" }))
            }
        }
        assert!(scan_with(br#"{"a":["ok","bad"]}"#, &mut Refuse).is_err());
        assert!(scan_with(br#"{"a":["ok","fine"]}"#, &mut Refuse).is_ok());
    }
}
