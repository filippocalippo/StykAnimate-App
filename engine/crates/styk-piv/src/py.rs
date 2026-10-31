//! Python's view of a document value.
//!
//! The writers and validators were written against Python dictionaries and
//! lists: truthiness, `dict.get`, `==`, and the exceptions a wrong type raises
//! decide which error a malformed document produces. These helpers give the
//! document tree the same behaviour, so the ported code reads like the code it
//! replaces and fails the same way.
//!
//! One difference is by design: the tree holds one number type. A number
//! without a fraction counts as a Python `int`, which is what the Python
//! service saw for every document a JavaScript client sent.

use styk_doc::{Elements, Value};

use crate::error::{PyResult, attribute_error, index_error, key_error, type_error};
use crate::pyfmt::{float_repr, is_integral, py_number};

/// `type(value).__name__`.
pub(crate) fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "NoneType",
        Value::Bool(_) => "bool",
        Value::Num(n) => {
            if is_integral(*n) {
                "int"
            } else {
                "float"
            }
        }
        Value::Str(_) | Value::Blob(_) => "str",
        Value::Arr(_) | Value::Nums(_) => "list",
        Value::Obj(_) => "dict",
    }
}

/// `bool(value)`: empty containers and strings, zero, `None` and `False` are false.
pub(crate) fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Num(n) => *n != 0.0,
        Value::Str(s) => !s.is_empty(),
        Value::Blob(b) => !b.prefix.is_empty() || !b.bytes.is_empty(),
        Value::Arr(items) => !items.is_empty(),
        Value::Nums(numbers) => !numbers.is_empty(),
        Value::Obj(object) => !object.is_empty(),
    }
}

/// `bool(value)` of an optional lookup result (`dict.get(key)`).
pub(crate) fn truthy_opt(value: Option<&Value>) -> bool {
    value.is_some_and(truthy)
}

/// A number, with `True`/`False` counting as 1/0 as they do in Python arithmetic.
fn numeric(value: &Value) -> Option<f64> {
    match value {
        Value::Num(n) => Some(*n),
        Value::Bool(b) => Some(*b as u8 as f64),
        _ => None,
    }
}

/// `a == b`: numbers by value (and `True == 1`), dictionaries regardless of key order.
pub(crate) fn eq(a: &Value, b: &Value) -> bool {
    if let (Some(x), Some(y)) = (numeric(a), numeric(b)) {
        return x == y;
    }
    match (a, b) {
        (Value::Null, Value::Null) => true,
        (Value::Str(x), Value::Str(y)) => x == y,
        (Value::Str(_) | Value::Blob(_), Value::Str(_) | Value::Blob(_)) => a == b,
        (Value::Obj(x), Value::Obj(y)) => {
            std::sync::Arc::ptr_eq(x, y) || (x.len() == y.len() && x.iter().all(|(key, value)| y.get(key).is_some_and(|other| eq(value, other))))
        }
        _ => match (a.elements(), b.elements()) {
            (Some(x), Some(y)) => x.len() == y.len() && x.iter().zip(y.iter()).all(|(p, q)| eq(&p, &q)),
            _ => false,
        },
    }
}

/// `isinstance(value, int) and not isinstance(value, bool)`.
pub(crate) fn is_int(value: &Value) -> bool {
    matches!(value, Value::Num(n) if is_integral(*n))
}

/// The integer a number is, when Python would have held an `int`.
pub(crate) fn as_int(value: &Value) -> Option<i64> {
    match value {
        Value::Num(n) if is_integral(*n) && n.abs() < 9.2e18 => Some(*n as i64),
        _ => None,
    }
}

pub(crate) fn is_str(value: &Value) -> bool {
    matches!(value, Value::Str(_) | Value::Blob(_))
}

pub(crate) fn is_list(value: &Value) -> bool {
    value.is_array()
}

/// `repr(text)` for the plain keys and names the codec reports.
pub(crate) fn repr_str(text: &str) -> String {
    let quote = if text.contains('\'') && !text.contains('"') { '"' } else { '\'' };
    let mut out = String::with_capacity(text.len() + 2);
    out.push(quote);
    for ch in text.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c == quote => {
                out.push('\\');
                out.push(c);
            }
            c if (c as u32) < 0x20 || c as u32 == 0x7f => out.push_str(&format!("\\x{:02x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push(quote);
    out
}

/// `repr(value)`.
pub(crate) fn repr(value: &Value) -> String {
    match value {
        Value::Null => "None".to_string(),
        Value::Bool(true) => "True".to_string(),
        Value::Bool(false) => "False".to_string(),
        Value::Num(n) => {
            if is_integral(*n) {
                py_number(*n)
            } else {
                float_repr(*n)
            }
        }
        Value::Str(_) | Value::Blob(_) => repr_str(&value.text().unwrap_or_default()),
        Value::Arr(_) | Value::Nums(_) => {
            let items: Vec<String> = value.elements().map(|e| e.iter().map(|item| repr(&item)).collect()).unwrap_or_default();
            format!("[{}]", items.join(", "))
        }
        Value::Obj(object) => {
            let items: Vec<String> = object.iter().map(|(key, item)| format!("{}: {}", repr_str(key), repr(item))).collect();
            format!("{{{}}}", items.join(", "))
        }
    }
}

/// `str(value)`.
pub(crate) fn str_of(value: &Value) -> String {
    match value {
        Value::Str(_) | Value::Blob(_) => value.text().unwrap_or_default().into_owned(),
        other => repr(other),
    }
}

/// `value.get(key)`: only dictionaries have it.
pub(crate) fn get<'a>(value: &'a Value, key: &str) -> PyResult<Option<&'a Value>> {
    match value {
        Value::Obj(object) => Ok(object.get(key)),
        other => Err(attribute_error(format!("'{}' object has no attribute 'get'", type_name(other)))),
    }
}

/// `value.get(key)` where a missing key and `None` are the same to the caller.
pub(crate) fn get_some<'a>(value: &'a Value, key: &str) -> PyResult<Option<&'a Value>> {
    Ok(get(value, key)?.filter(|v| !v.is_null()))
}

/// `value[key]` with a string key.
pub(crate) fn item<'a>(value: &'a Value, key: &str) -> PyResult<&'a Value> {
    match value {
        Value::Obj(object) => object.get(key).ok_or_else(|| key_error(key)),
        Value::Arr(_) | Value::Nums(_) => Err(type_error("list indices must be integers or slices, not str")),
        Value::Str(_) | Value::Blob(_) => Err(type_error("string indices must be integers, not 'str'")),
        other => Err(type_error(format!("'{}' object is not subscriptable", type_name(other)))),
    }
}

/// `key in value` for a string key.
pub(crate) fn contains_key(value: &Value, key: &str) -> PyResult<bool> {
    match value {
        Value::Obj(object) => Ok(object.contains(key)),
        Value::Str(_) | Value::Blob(_) => Ok(value.text().is_some_and(|text| text.contains(key))),
        Value::Arr(_) | Value::Nums(_) => Ok(value.elements().is_some_and(|e| e.iter().any(|v| v.as_str() == Some(key)))),
        other => Err(type_error(format!("argument of type '{}' is not iterable", type_name(other)))),
    }
}

/// `len(value)`.
pub(crate) fn len(value: &Value) -> PyResult<usize> {
    match value {
        Value::Arr(items) => Ok(items.len()),
        Value::Nums(numbers) => Ok(numbers.len()),
        Value::Obj(object) => Ok(object.len()),
        Value::Str(text) => Ok(text.chars().count()),
        Value::Blob(_) => Ok(value.text().map(|t| t.chars().count()).unwrap_or(0)),
        other => Err(type_error(format!("object of type '{}' has no len()", type_name(other)))),
    }
}

/// What `for item in value` yields.
pub(crate) enum Seq<'a> {
    List(Elements<'a>),
    /// The characters of a string, or the keys of a dictionary.
    Owned(Vec<Value>),
}

impl Seq<'_> {
    pub fn len(&self) -> usize {
        match self {
            Seq::List(elements) => elements.len(),
            Seq::Owned(items) => items.len(),
        }
    }

    pub fn iter(&self) -> impl Iterator<Item = Value> + '_ {
        (0..self.len()).map(move |index| match self {
            Seq::List(elements) => elements.get(index).unwrap_or(Value::Null),
            Seq::Owned(items) => items[index].clone(),
        })
    }
}

fn characters(value: &Value) -> Vec<Value> {
    value.text().map(|text| text.chars().map(|c| Value::Str(std::sync::Arc::from(c.to_string()))).collect()).unwrap_or_default()
}

/// `for item in value`: the items of a list, the characters of a string, the
/// keys of a dictionary; anything else is not iterable.
pub(crate) fn iter(value: &Value) -> PyResult<Seq<'_>> {
    match value {
        Value::Arr(_) | Value::Nums(_) => match value.elements() {
            Some(elements) => Ok(Seq::List(elements)),
            None => Ok(Seq::Owned(Vec::new())),
        },
        Value::Str(_) | Value::Blob(_) => Ok(Seq::Owned(characters(value))),
        Value::Obj(object) => Ok(Seq::Owned(object.keys().map(|key| Value::Str(key.clone())).collect())),
        other => Err(type_error(format!("'{}' object is not iterable", type_name(other)))),
    }
}

/// `[*value]`: like iteration, with the unpacking operator's own complaint.
pub(crate) fn star(value: &Value) -> PyResult<Vec<Value>> {
    match iter(value) {
        Ok(items) => Ok(items.iter().collect()),
        Err(_) => Err(type_error(format!("Value after * must be an iterable, not {}", type_name(value)))),
    }
}

/// `value[index]` with an integer index.
pub(crate) fn at(value: &Value, index: usize) -> PyResult<Value> {
    match value {
        Value::Arr(_) | Value::Nums(_) => value.item(index).ok_or_else(|| index_error("list index out of range")),
        Value::Str(_) | Value::Blob(_) => characters(value).into_iter().nth(index).ok_or_else(|| index_error("string index out of range")),
        Value::Obj(_) => Err(crate::error::key_error_repr(index.to_string())),
        other => Err(type_error(format!("'{}' object is not subscriptable", type_name(other)))),
    }
}

/// The key a value has in a Python `dict` or `set`: numbers by value (`1`,
/// `1.0` and `True` are one key), strings by text.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub(crate) enum HKey {
    None,
    /// The bits of the number, with negative zero folded into zero.
    Num(u64),
    Str(String),
}

/// `hash(value)`: lists and dictionaries are unhashable.
pub(crate) fn hkey(value: &Value) -> PyResult<HKey> {
    match value {
        Value::Null => Ok(HKey::None),
        Value::Bool(b) => Ok(HKey::Num((*b as u8 as f64).to_bits())),
        Value::Num(n) => Ok(HKey::Num(if *n == 0.0 { 0f64.to_bits() } else { n.to_bits() })),
        Value::Str(_) | Value::Blob(_) => Ok(HKey::Str(value.text().unwrap_or_default().into_owned())),
        other => Err(type_error(format!("unhashable type: '{}'", type_name(other)))),
    }
}

pub(crate) fn hkey_int(value: i64) -> HKey {
    HKey::Num((value as f64).to_bits())
}

/// `a < b` and friends between two values, which Python only defines within numbers
/// (and within strings).
pub(crate) fn cmp(a: &Value, b: &Value, op: &str) -> PyResult<std::cmp::Ordering> {
    if let (Some(x), Some(y)) = (numeric(a), numeric(b)) {
        return Ok(x.partial_cmp(&y).unwrap_or(std::cmp::Ordering::Equal));
    }
    if let (Some(x), Some(y)) = (a.as_str(), b.as_str()) {
        return Ok(x.cmp(y));
    }
    Err(type_error(format!("'{}' not supported between instances of '{}' and '{}'", op, type_name(a), type_name(b))))
}

