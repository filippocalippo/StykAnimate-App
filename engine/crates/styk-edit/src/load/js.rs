//! JavaScript's reading of a JSON document, for the validators the load transcribes: what
//! `value.field` is when the field, the value or its type is not what the validator expects
//! (`undefined`, a `null` that throws on access, `typeof`, `Array.isArray`, `Number.isInteger`),
//! so each check below reads like the JavaScript it comes from.

use std::collections::HashSet;

use styk_doc::{Obj, Value};

use crate::EditError;

/// A property of the document as JavaScript reads it: `None` is `undefined`.
pub(super) type V<'a> = Option<&'a Value>;

/// The error a JavaScript `TypeError` stands for (reading a property of `null` or `undefined`): the
/// load refuses the document without a message key.
pub const TYPE_ERROR: &str = "TypeError";

/// `String(n)` for a number: its JSON spelling.
pub(super) fn number_text(n: f64) -> String {
    styk_doc::json::to_string(&Value::Num(n))
}

/// `Number(text)` for a property name: white space trimmed, empty is zero, hexadecimal, octal and binary
/// spellings, the decimal ones; NaN for anything else.
pub(super) fn js_number(text: &str) -> f64 {
    let t = js_trim(text);
    if t.is_empty() {
        return 0.0;
    }
    let radix = |digits: &str, base: u32| u64::from_str_radix(digits, base).map(|n| n as f64).unwrap_or(f64::NAN);
    match t.get(..2) {
        Some("0x" | "0X") => return radix(&t[2..], 16),
        Some("0o" | "0O") => return radix(&t[2..], 8),
        Some("0b" | "0B") => return radix(&t[2..], 2),
        _ => {}
    }
    match t {
        "Infinity" | "+Infinity" => f64::INFINITY,
        "-Infinity" => f64::NEG_INFINITY,
        _ if t.bytes().any(|b| b.is_ascii_alphabetic() && b != b'e' && b != b'E') => f64::NAN,
        _ => t.parse::<f64>().unwrap_or(f64::NAN),
    }
}

pub(super) fn refuse(key: &str) -> EditError {
    EditError::Invalid(key.into())
}

pub(super) fn fail<T>(key: &str) -> Result<T, EditError> {
    Err(refuse(key))
}

/// `base.key` where `base` may be `null` or `undefined`, which throws.
pub(super) fn prop<'a>(base: V<'a>, key: &str) -> Result<V<'a>, EditError> {
    match base {
        None | Some(Value::Null) => Err(refuse(TYPE_ERROR)),
        Some(value) => Ok(value.get(key)),
    }
}

/// `base?.key`.
pub(super) fn get<'a>(base: V<'a>, key: &str) -> V<'a> {
    base.and_then(|value| value.get(key))
}

/// `base?.a?.b?.…`.
pub(super) fn path<'a>(base: V<'a>, keys: &[&str]) -> V<'a> {
    keys.iter().fold(base, |at, key| get(at, key))
}

/// Whether `value` is `undefined`.
pub(super) fn missing(value: V) -> bool {
    value.is_none()
}

/// `value ?? fallback`: `null` and `undefined` take the fallback.
pub(super) fn or<'a>(value: V<'a>, fallback: V<'a>) -> V<'a> {
    match value {
        None | Some(Value::Null) => fallback,
        some => some,
    }
}

/// Truthiness (`if (value)`).
pub(super) fn truthy(value: V) -> bool {
    value.is_some_and(Value::truthy)
}

pub(super) fn is_null(value: V) -> bool {
    matches!(value, Some(Value::Null))
}

/// `value != null`.
pub(super) fn is_given(value: V) -> bool {
    !matches!(value, None | Some(Value::Null))
}

pub(super) fn num(value: V) -> Option<f64> {
    value.and_then(Value::as_f64)
}

/// `typeof value === 'number' && Number.isFinite(value)`.
pub(super) fn finite(value: V) -> bool {
    num(value).is_some_and(f64::is_finite)
}

/// `Number.isInteger(value)`.
pub(super) fn integer(value: V) -> bool {
    num(value).is_some_and(|n| n.is_finite() && n.fract() == 0.0)
}

/// `Number.isInteger(value) && min <= value <= max`.
pub(super) fn integer_in(value: V, min: f64, max: f64) -> bool {
    num(value).is_some_and(|n| n.is_finite() && n.fract() == 0.0 && n >= min && n <= max)
}

/// `Number.isSafeInteger(value)`.
pub(super) fn safe_integer(value: V) -> bool {
    num(value).is_some_and(|n| n.is_finite() && n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0)
}

/// `typeof value === 'number' && Number.isFinite(value) && min <= value <= max`.
pub(super) fn finite_in(value: V, min: f64, max: f64) -> bool {
    num(value).is_some_and(|n| n.is_finite() && n >= min && n <= max)
}

/// `Math.fround(value)`.
pub(super) fn fround(value: f64) -> f64 {
    value as f32 as f64
}

pub(super) fn text<'a>(value: V<'a>) -> Option<&'a str> {
    value.and_then(Value::as_str)
}

pub(super) fn boolean(value: V) -> bool {
    matches!(value, Some(Value::Bool(_)))
}

pub(super) fn is_array(value: V) -> bool {
    value.is_some_and(Value::is_array)
}

/// `value && typeof value === 'object' && !Array.isArray(value)`: a plain record.
pub(super) fn is_record(value: V) -> bool {
    value.is_some_and(Value::is_object)
}

/// `typeof value === 'object'` (arrays and `null` too).
pub(super) fn is_object_type(value: V) -> bool {
    matches!(value, Some(Value::Obj(_) | Value::Arr(_) | Value::Nums(_) | Value::Null))
}

pub(super) fn len(value: V) -> usize {
    value.and_then(Value::array_len).unwrap_or(0)
}

/// The elements of an array (`for (const x of value)`); an empty list for anything else.
pub(super) fn items(value: V) -> Vec<Value> {
    value.and_then(Value::elements).map(|elements| elements.iter().collect()).unwrap_or_default()
}

/// The own enumerable properties of an object, in JavaScript's order (`Object.entries`).
pub(super) fn entries<'a>(value: V<'a>) -> Vec<(std::sync::Arc<str>, &'a Value)> {
    value.and_then(Value::as_obj).map(|object| object.iter().map(|(key, value)| (key.clone(), value)).collect()).unwrap_or_default()
}

/// `Object.keys(value).length` (zero for anything but an object).
pub(super) fn key_count(value: V) -> usize {
    value.and_then(Value::as_obj).map_or(0, Obj::len)
}

/// `Object.hasOwn(value, key)` / `Object.prototype.hasOwnProperty.call(value, key)`.
pub(super) fn has_own(value: V, key: &str) -> bool {
    value.and_then(Value::as_obj).is_some_and(|object| object.contains(key))
}

/// A string's length in UTF-16 code units (`text.length`).
pub(super) fn js_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// JavaScript's `String.prototype.trim` white space, which is not Rust's: it takes U+FEFF and leaves U+0085.
fn is_space(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

/// `text.trim()`.
pub(super) fn js_trim(text: &str) -> &str {
    text.trim_matches(is_space)
}

/// `typeof value === 'string' && value.trim() && value.length <= max`.
pub(super) fn name(value: V, max: usize) -> bool {
    text(value).is_some_and(|t| !js_trim(t).is_empty() && js_len(t) <= max)
}

/// `/^(0|[1-9]\d*)$/`: a canonical non-negative integer.
pub(super) fn canonical(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()) && (value == "0" || !value.starts_with('0'))
}

/// `/^[1-9]\d*$/`.
pub(super) fn positive_canonical(value: &str) -> bool {
    canonical(value) && value != "0"
}

/// `Number(text)` for a canonical decimal.
pub(super) fn number_of(value: &str) -> f64 {
    value.parse::<f64>().unwrap_or(f64::NAN)
}

/// A JavaScript `Set` of numbers (SameValueZero), in insertion order.
#[derive(Default)]
pub(super) struct NumberSet {
    seen: HashSet<u64>,
}

impl NumberSet {
    fn key(value: f64) -> u64 {
        if value == 0.0 { 0.0f64.to_bits() } else if value.is_nan() { f64::NAN.to_bits() } else { value.to_bits() }
    }

    /// Adds `value`; false when it was there already.
    pub(super) fn insert(&mut self, value: f64) -> bool {
        self.seen.insert(Self::key(value))
    }

    pub(super) fn has(&self, value: f64) -> bool {
        self.seen.contains(&Self::key(value))
    }

    pub(super) fn len(&self) -> usize {
        self.seen.len()
    }
}
