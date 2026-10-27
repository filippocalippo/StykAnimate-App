//! The tree: [`Value`] and its containers.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

#[path = "retention.rs"]
mod retention;
pub use retention::retained_bytes_checked;

/// One node of a document. Cloning is cheap: containers are reference counted and
/// shared until one side changes them.
#[derive(Clone, Debug)]
pub enum Value {
    Null,
    Bool(bool),
    Num(f64),
    Str(Arc<str>),
    /// An array with at least one element that is not a number.
    Arr(Arc<Vec<Value>>),
    /// An array of numbers only, packed. Its `Arc` is its identity: the file
    /// format stores arrays that share identity once (pose and key sequences).
    Nums(Arc<Nums>),
    Obj(Arc<Obj>),
    /// A string made of a literal prefix and the base64 of raw bytes (embedded
    /// images, original Pivot sources), kept as bytes. Equal to the string it stands for.
    Blob(Arc<Blob>),
}

/// A packed array of numbers. Single precision when every value is exactly a
/// 32-bit float, which holds for everything decoded from Pivot files.
#[derive(Clone, Debug, PartialEq)]
pub enum Nums {
    F32(Box<[f32]>),
    F64(Box<[f64]>),
}

impl Nums {
    /// Packs `values` in the smallest exact form.
    pub fn new(values: &[f64]) -> Nums {
        // `v as f32 as f64 == v` is false for NaN, so non-finite values stay double.
        if values.iter().all(|&v| (v as f32) as f64 == v) {
            Nums::F32(values.iter().map(|&v| v as f32).collect())
        } else {
            Nums::F64(values.into())
        }
    }

    pub fn len(&self) -> usize {
        match self {
            Nums::F32(v) => v.len(),
            Nums::F64(v) => v.len(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn get(&self, index: usize) -> Option<f64> {
        match self {
            Nums::F32(v) => v.get(index).map(|&x| x as f64),
            Nums::F64(v) => v.get(index).copied(),
        }
    }

    pub fn iter(&self) -> impl ExactSizeIterator<Item = f64> + '_ {
        (0..self.len()).map(move |i| match self {
            Nums::F32(v) => v[i] as f64,
            Nums::F64(v) => v[i],
        })
    }

    pub fn to_vec(&self) -> Vec<f64> {
        self.iter().collect()
    }

    /// Bytes this array holds on the heap.
    pub fn heap_bytes(&self) -> usize {
        match self {
            Nums::F32(v) => v.len() * 4,
            Nums::F64(v) => v.len() * 8,
        }
    }
}

/// `prefix` followed by the base64 of `bytes`.
#[derive(Clone, Debug, PartialEq)]
pub struct Blob {
    pub prefix: Arc<str>,
    pub bytes: Arc<[u8]>,
}

impl Blob {
    /// Length of the string this blob stands for, in UTF-16 units (JavaScript's `length`).
    pub fn text_len(&self) -> usize {
        self.prefix.encode_utf16().count() + self.bytes.len().div_ceil(3) * 4
    }
}

/// The ordered key list of an object, shared by every object with the same keys.
#[derive(Debug)]
pub struct Shape {
    keys: Box<[Arc<str>]>,
    /// Built on first lookup for wide objects; narrow ones scan.
    index: OnceLock<HashMap<Arc<str>, u32>>,
}

const SCAN_KEYS: usize = 8;

impl Shape {
    pub fn new(keys: impl Into<Box<[Arc<str>]>>) -> Arc<Shape> {
        Arc::new(Shape { keys: keys.into(), index: OnceLock::new() })
    }

    pub fn empty() -> Arc<Shape> {
        static EMPTY: OnceLock<Arc<Shape>> = OnceLock::new();
        EMPTY.get_or_init(|| Shape::new(Vec::new())).clone()
    }

    pub fn keys(&self) -> &[Arc<str>] {
        &self.keys
    }

    pub fn position(&self, key: &str) -> Option<usize> {
        if self.keys.len() <= SCAN_KEYS {
            return self.keys.iter().position(|k| &**k == key);
        }
        self.index
            .get_or_init(|| self.keys.iter().enumerate().map(|(i, k)| (k.clone(), i as u32)).collect())
            .get(key)
            .map(|&i| i as usize)
    }
}

/// The array index a JavaScript engine sees in a property key: the canonical
/// decimal text of an integer from 0 to 2^32 - 2.
pub fn index_key(key: &str) -> Option<u32> {
    let bytes = key.as_bytes();
    if bytes.is_empty() || bytes.len() > 10 || (bytes[0] == b'0' && bytes.len() > 1) || !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    key.parse::<u64>().ok().filter(|&n| n < u32::MAX as u64).map(|n| n as u32)
}

/// An object, with its keys in the order JavaScript enumerates them: integer
/// keys (`"12"`) first, ascending, then the others in insertion order.
#[derive(Clone, Debug)]
pub struct Obj {
    shape: Arc<Shape>,
    values: Vec<Value>,
}

impl Default for Obj {
    fn default() -> Self {
        Obj { shape: Shape::empty(), values: Vec::new() }
    }
}

impl Obj {
    pub fn new() -> Obj {
        Obj::default()
    }

    /// An object over an existing shape. `values` must have one entry per key.
    pub fn from_shape(shape: Arc<Shape>, values: Vec<Value>) -> Obj {
        assert_eq!(shape.keys.len(), values.len(), "an object needs one value per key");
        Obj { shape, values }
    }

    pub fn len(&self) -> usize {
        self.values.len()
    }

    pub fn is_empty(&self) -> bool {
        self.values.is_empty()
    }

    pub fn shape(&self) -> &Arc<Shape> {
        &self.shape
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.shape.position(key).map(|i| &self.values[i])
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut Value> {
        self.shape.position(key).map(|i| &mut self.values[i])
    }

    pub fn contains(&self, key: &str) -> bool {
        self.shape.position(key).is_some()
    }

    pub fn keys(&self) -> impl ExactSizeIterator<Item = &Arc<str>> {
        self.shape.keys.iter()
    }

    pub fn values(&self) -> &[Value] {
        &self.values
    }

    pub fn iter(&self) -> impl ExactSizeIterator<Item = (&Arc<str>, &Value)> {
        self.shape.keys.iter().zip(self.values.iter())
    }

    /// Replaces the value of `key`, or appends the key (as `object[key] = value` does).
    pub fn set(&mut self, key: &str, value: Value) {
        match self.shape.position(key) {
            Some(i) => self.values[i] = value,
            None => {
                let mut keys: Vec<Arc<str>> = self.shape.keys.to_vec();
                let at = match index_key(key) {
                    // Among the leading integer keys, in ascending order.
                    Some(index) => keys.iter().position(|k| index_key(k).is_none_or(|other| other > index)).unwrap_or(keys.len()),
                    None => keys.len(),
                };
                keys.insert(at, Arc::from(key));
                self.shape = Shape::new(keys);
                self.values.insert(at, value);
            }
        }
    }

    /// Removes `key` (as `delete object[key]` does), returning its value.
    pub fn remove(&mut self, key: &str) -> Option<Value> {
        let i = self.shape.position(key)?;
        let mut keys: Vec<Arc<str>> = self.shape.keys.to_vec();
        keys.remove(i);
        self.shape = Shape::new(keys);
        Some(self.values.remove(i))
    }
}

/// Builds an object as a sequence of `object[key] = value` assignments would.
impl FromIterator<(Arc<str>, Value)> for Obj {
    fn from_iter<T: IntoIterator<Item = (Arc<str>, Value)>>(iter: T) -> Self {
        let mut object = Obj::new();
        for (key, value) in iter {
            object.set(&key, value);
        }
        object
    }
}

impl Value {
    pub fn str(text: &str) -> Value {
        Value::Str(Arc::from(text))
    }

    /// A packed array when every value is a number, an ordinary array otherwise.
    pub fn array(items: Vec<Value>) -> Value {
        if !items.is_empty() && items.iter().all(|v| matches!(v, Value::Num(_))) {
            let numbers: Vec<f64> = items.iter().map(|v| if let Value::Num(n) = v { *n } else { unreachable!() }).collect();
            Value::Nums(Arc::new(Nums::new(&numbers)))
        } else {
            Value::Arr(Arc::new(items))
        }
    }

    pub fn nums(values: &[f64]) -> Value {
        if values.is_empty() { Value::Arr(Arc::new(Vec::new())) } else { Value::Nums(Arc::new(Nums::new(values))) }
    }

    pub fn object(object: Obj) -> Value {
        Value::Obj(Arc::new(object))
    }

    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null)
    }

    pub fn as_f64(&self) -> Option<f64> {
        if let Value::Num(n) = self { Some(*n) } else { None }
    }

    pub fn as_bool(&self) -> Option<bool> {
        if let Value::Bool(b) = self { Some(*b) } else { None }
    }

    /// The text of a plain string. A [`Value::Blob`] has no borrowed text; use [`Value::text`].
    pub fn as_str(&self) -> Option<&str> {
        if let Value::Str(s) = self { Some(s) } else { None }
    }

    pub fn as_obj(&self) -> Option<&Obj> {
        if let Value::Obj(o) = self { Some(o) } else { None }
    }

    /// The elements of an ordinary array. A packed array is not one: see [`Value::as_nums`]
    /// and [`Value::array_len`].
    pub fn as_arr(&self) -> Option<&[Value]> {
        if let Value::Arr(a) = self { Some(a) } else { None }
    }

    pub fn as_nums(&self) -> Option<&Nums> {
        if let Value::Nums(n) = self { Some(n) } else { None }
    }

    pub fn is_array(&self) -> bool {
        matches!(self, Value::Arr(_) | Value::Nums(_))
    }

    /// Length of either kind of array.
    pub fn array_len(&self) -> Option<usize> {
        match self {
            Value::Arr(a) => Some(a.len()),
            Value::Nums(n) => Some(n.len()),
            _ => None,
        }
    }

    /// Element `index` of either kind of array.
    pub fn item(&self, index: usize) -> Option<Value> {
        match self {
            Value::Arr(a) => a.get(index).cloned(),
            Value::Nums(n) => n.get(index).map(Value::Num),
            _ => None,
        }
    }

    /// Either kind of array as a sequence of values. Elements are returned by value
    /// (a clone is one reference count or one number).
    pub fn elements(&self) -> Option<Elements<'_>> {
        match self {
            Value::Arr(items) => Some(Elements::Items(items)),
            Value::Nums(numbers) => Some(Elements::Numbers(numbers)),
            _ => None,
        }
    }

    pub fn is_object(&self) -> bool {
        matches!(self, Value::Obj(_))
    }

    /// A number as an integer, when it is one (JavaScript's `Number.isInteger`) and fits.
    pub fn as_i64(&self) -> Option<i64> {
        self.as_f64().filter(|n| n.fract() == 0.0 && n.abs() < 9.3e18).map(|n| n as i64)
    }

    /// The numbers of an array of numbers, whichever way it is stored. `None` when
    /// the value is not an array or holds anything else.
    pub fn numbers(&self) -> Option<Vec<f64>> {
        match self {
            Value::Nums(n) => Some(n.to_vec()),
            Value::Arr(a) => a.iter().map(Value::as_f64).collect(),
            _ => None,
        }
    }

    /// `object[key]`, or `None` when this is not an object or has no such key.
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.as_obj()?.get(key)
    }

    /// Follows object keys from this node.
    pub fn path(&self, keys: &[&str]) -> Option<&Value> {
        keys.iter().try_fold(self, |node, key| node.get(key))
    }

    /// The string this value stands for, for both plain strings and blobs.
    pub fn text(&self) -> Option<std::borrow::Cow<'_, str>> {
        match self {
            Value::Str(s) => Some(std::borrow::Cow::Borrowed(s)),
            Value::Blob(b) => {
                let mut out = String::with_capacity(b.prefix.len() + b.bytes.len().div_ceil(3) * 4);
                out.push_str(&b.prefix);
                crate::json::base64_into(&b.bytes, unsafe { out.as_mut_vec() });
                Some(std::borrow::Cow::Owned(out))
            }
            _ => None,
        }
    }

    /// The bytes behind a base64 field or a `data:…;base64,` URL, whether the value is
    /// a blob or plain text. `None` for anything else, including malformed base64.
    pub fn payload_bytes(&self) -> Option<Arc<[u8]>> {
        match self {
            Value::Blob(blob) => Some(blob.bytes.clone()),
            Value::Str(text) => {
                let encoded = match text.find(";base64,") {
                    Some(at) if text.starts_with("data:") => &text[at + 8..],
                    _ if text.starts_with("data:") => return None,
                    _ => text,
                };
                crate::json::base64_strict(encoded.trim()).map(Arc::from)
            }
            _ => None,
        }
    }

    /// JavaScript truthiness.
    pub fn truthy(&self) -> bool {
        match self {
            Value::Null => false,
            Value::Bool(b) => *b,
            Value::Num(n) => *n != 0.0 && !n.is_nan(),
            Value::Str(s) => !s.is_empty(),
            Value::Blob(b) => !b.prefix.is_empty() || !b.bytes.is_empty(),
            Value::Arr(_) | Value::Nums(_) | Value::Obj(_) => true,
        }
    }

    /// Mutable access to an object, cloning it first if it is shared (copy-on-write).
    pub fn make_obj(&mut self) -> Option<&mut Obj> {
        if let Value::Obj(o) = self { Some(Arc::make_mut(o)) } else { None }
    }

    /// Mutable access to an ordinary array, cloning it first if it is shared. A packed
    /// array is unpacked in place; call [`Value::repack`] when done if it may be all numbers.
    pub fn make_arr(&mut self) -> Option<&mut Vec<Value>> {
        if let Value::Nums(n) = self {
            *self = Value::Arr(Arc::new(n.iter().map(Value::Num).collect()));
        }
        if let Value::Arr(a) = self { Some(Arc::make_mut(a)) } else { None }
    }

    /// Packs an ordinary array again when every element is a number.
    pub fn repack(&mut self) {
        if let Value::Arr(a) = self
            && !a.is_empty()
            && a.iter().all(|v| matches!(v, Value::Num(_)))
        {
            *self = Value::array(a.to_vec());
        }
    }

    /// Whether two values are the same node (the same shared container), which is
    /// what "unchanged" means for derived caches.
    pub fn same_node(&self, other: &Value) -> bool {
        match (self, other) {
            (Value::Null, Value::Null) => true,
            (Value::Bool(a), Value::Bool(b)) => a == b,
            (Value::Num(a), Value::Num(b)) => a.to_bits() == b.to_bits(),
            (Value::Str(a), Value::Str(b)) => Arc::ptr_eq(a, b),
            (Value::Arr(a), Value::Arr(b)) => Arc::ptr_eq(a, b),
            (Value::Nums(a), Value::Nums(b)) => Arc::ptr_eq(a, b),
            (Value::Obj(a), Value::Obj(b)) => Arc::ptr_eq(a, b),
            (Value::Blob(a), Value::Blob(b)) => Arc::ptr_eq(a, b),
            _ => false,
        }
    }

    /// Bytes this node and everything below it holds, counting shared nodes each
    /// time they are reached. An estimate for cache and history budgets.
    pub fn heap_bytes(&self) -> usize {
        const NODE: usize = std::mem::size_of::<Value>();
        match self {
            Value::Null | Value::Bool(_) | Value::Num(_) => 0,
            Value::Str(s) => s.len(),
            Value::Blob(b) => b.prefix.len() + b.bytes.len(),
            Value::Nums(n) => n.heap_bytes(),
            Value::Arr(a) => a.len() * NODE + a.iter().map(Value::heap_bytes).sum::<usize>(),
            Value::Obj(o) => o.values.len() * NODE + o.values.iter().map(Value::heap_bytes).sum::<usize>(),
        }
    }
}

/// The elements of either kind of array (see [`Value::elements`]).
#[derive(Clone, Copy)]
pub enum Elements<'a> {
    Items(&'a [Value]),
    Numbers(&'a Nums),
}

impl<'a> Elements<'a> {
    pub fn len(&self) -> usize {
        match self {
            Elements::Items(items) => items.len(),
            Elements::Numbers(numbers) => numbers.len(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn get(&self, index: usize) -> Option<Value> {
        match self {
            Elements::Items(items) => items.get(index).cloned(),
            Elements::Numbers(numbers) => numbers.get(index).map(Value::Num),
        }
    }

    pub fn iter(self) -> impl ExactSizeIterator<Item = Value> + 'a {
        (0..self.len()).map(move |i| self.get(i).expect("index within length"))
    }
}

/// Structural equality: the same data, however it is stored or shared. Numbers
/// compare as JavaScript's `===` does, except that NaN equals NaN.
impl PartialEq for Value {
    fn eq(&self, other: &Value) -> bool {
        match (self, other) {
            (Value::Null, Value::Null) => true,
            (Value::Bool(a), Value::Bool(b)) => a == b,
            (Value::Num(a), Value::Num(b)) => a == b || (a.is_nan() && b.is_nan()),
            (Value::Str(a), Value::Str(b)) => a == b,
            (Value::Blob(a), Value::Blob(b)) => Arc::ptr_eq(a, b) || a == b,
            (Value::Str(_), Value::Blob(_)) | (Value::Blob(_), Value::Str(_)) => self.text() == other.text(),
            (Value::Nums(a), Value::Nums(b)) => Arc::ptr_eq(a, b) || (a.len() == b.len() && a.iter().zip(b.iter()).all(|(x, y)| x == y || (x.is_nan() && y.is_nan()))),
            (Value::Arr(a), Value::Arr(b)) => Arc::ptr_eq(a, b) || a == b,
            (Value::Nums(n), Value::Arr(a)) | (Value::Arr(a), Value::Nums(n)) => {
                n.len() == a.len() && n.iter().zip(a.iter()).all(|(x, y)| y.as_f64().is_some_and(|y| x == y || (x.is_nan() && y.is_nan())))
            }
            (Value::Obj(a), Value::Obj(b)) => {
                Arc::ptr_eq(a, b)
                    || (a.len() == b.len() && a.iter().zip(b.iter()).all(|((ka, va), (kb, vb))| ka == kb && va == vb))
            }
            _ => false,
        }
    }
}

/// JSON text, as `JSON.stringify` prints it.
impl std::fmt::Display for Value {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&crate::json::to_string(self))
    }
}

impl<'a> IntoIterator for Elements<'a> {
    type Item = Value;
    type IntoIter = Box<dyn ExactSizeIterator<Item = Value> + 'a>;
    fn into_iter(self) -> Self::IntoIter {
        Box::new(self.iter())
    }
}

impl From<f64> for Value {
    fn from(value: f64) -> Value {
        Value::Num(value)
    }
}
impl From<bool> for Value {
    fn from(value: bool) -> Value {
        Value::Bool(value)
    }
}
impl From<&str> for Value {
    fn from(value: &str) -> Value {
        Value::str(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_pack_single_precision_only_when_exact() {
        assert!(matches!(Nums::new(&[0.5, 1.0, -3.25]), Nums::F32(_)));
        assert!(matches!(Nums::new(&[0.1]), Nums::F64(_)));
        assert!(matches!(Nums::new(&[16777217.0]), Nums::F64(_)));
        assert!(matches!(Nums::new(&[f64::NAN]), Nums::F64(_)));
        let packed = Nums::new(&[1.5, -2.0]);
        assert_eq!(packed.to_vec(), vec![1.5, -2.0]);
    }

    #[test]
    fn an_edit_clones_only_the_object_it_touches() {
        let pose = Value::object([(Arc::from("x"), Value::Num(1.0))].into_iter().collect());
        let frame = Value::Arr(Arc::new(vec![pose.clone(), pose.clone()]));
        let mut edited = frame.clone();
        edited.make_arr().unwrap()[0].make_obj().unwrap().set("x", Value::Num(2.0));
        // The original frame is untouched, and the unedited pose is still the shared node.
        assert_eq!(frame.as_arr().unwrap()[0].get("x"), Some(&Value::Num(1.0)));
        assert_eq!(edited.as_arr().unwrap()[0].get("x"), Some(&Value::Num(2.0)));
        assert!(edited.as_arr().unwrap()[1].same_node(&pose));
        assert!(!edited.as_arr().unwrap()[0].same_node(&pose));
    }

    #[test]
    fn objects_keep_insertion_order_through_set_and_remove() {
        let mut object = Obj::new();
        object.set("b", Value::Num(1.0));
        object.set("a", Value::Num(2.0));
        object.set("b", Value::Num(3.0));
        assert_eq!(object.keys().map(|k| &**k).collect::<Vec<_>>(), ["b", "a"]);
        assert_eq!(object.remove("b"), Some(Value::Num(3.0)));
        assert_eq!(object.keys().map(|k| &**k).collect::<Vec<_>>(), ["a"]);
    }

    #[test]
    fn integer_keys_come_first_in_ascending_order() {
        let mut object = Obj::new();
        for key in ["b", "10", "2", "a", "07", "0"] {
            object.set(key, Value::Null);
        }
        // What `Object.keys` returns for the same assignments ("07" is not an index).
        assert_eq!(object.keys().map(|k| &**k).collect::<Vec<_>>(), ["0", "2", "10", "b", "a", "07"]);
    }

    #[test]
    fn a_blob_equals_the_string_it_stands_for() {
        let blob = Value::Blob(Arc::new(Blob { prefix: Arc::from("data:x;base64,"), bytes: Arc::from(&b"hi!"[..]) }));
        assert_eq!(blob, Value::str("data:x;base64,aGkh"));
        assert_eq!(blob.text().unwrap(), "data:x;base64,aGkh");
    }
}
