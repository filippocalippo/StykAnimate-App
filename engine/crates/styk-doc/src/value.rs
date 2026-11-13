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
    index: OnceLock<Index>,
}

const SCAN_KEYS: usize = 8;

/// Where a wide shape's keys are. Every read of a field looks its key up, so the lookup is a fast hash of the key's text into a table
/// of slots, each the key's place and the hash's high half, searched from the hash's slot onwards (linear probing). A file chooses
/// its keys, and keys made to hash alike would make such a table quadratic: the table is only kept when every key lies within
/// [`PROBES`] slots of where its hash points, so a lookup, found or not, reads at most that many slots. Keys for which it cannot be made
/// are looked up through SipHash, as every wide shape was before.
#[derive(Debug)]
enum Index {
    /// `(hash >> 32) << 32 | place + 1` per slot, `0` for an empty slot; the length is a power of two.
    Probed(Box<[u64]>),
    Sip(HashMap<Arc<str>, u32>),
}

/// The most slots a key may lie past the one its hash points to; a lookup reads no more.
const PROBES: usize = 8;

/// The fast hash of a key's text (`fast::FastHasher`, which is not safe on its own for keys a file chooses: see [`Index`]).
#[inline]
fn key_hash(key: &str) -> u64 {
    use std::hash::Hasher;
    let mut hasher = crate::fast::FastHasher::default();
    hasher.write(key.as_bytes());
    hasher.finish()
}

impl Index {
    fn new(keys: &[Arc<str>]) -> Index {
        Index::probed(keys).unwrap_or_else(|| Index::Sip(keys.iter().enumerate().map(|(i, k)| (k.clone(), i as u32)).collect()))
    }

    /// The probed table of `keys`, between two and four slots a key; `None` when a key would lie [`PROBES`] slots or more from its place.
    fn probed(keys: &[Arc<str>]) -> Option<Index> {
        if keys.len() >= u32::MAX as usize {
            return None;
        }
        let size = (keys.len() * 2).next_power_of_two();
        let mask = size - 1;
        let mut slots = vec![0u64; size];
        for (place, key) in keys.iter().enumerate() {
            let hash = key_hash(key);
            let home = hash as usize & mask;
            let free = (0..PROBES).map(|step| (home + step) & mask).find(|&slot| slots[slot] == 0)?;
            slots[free] = (hash & !0xffff_ffff) | (place as u64 + 1);
        }
        Some(Index::Probed(slots.into_boxed_slice()))
    }

    #[inline]
    fn position(&self, keys: &[Arc<str>], key: &str) -> Option<usize> {
        match self {
            Index::Probed(slots) => {
                let hash = key_hash(key);
                let (mask, tag) = (slots.len() - 1, hash & !0xffff_ffff);
                let home = hash as usize & mask;
                for step in 0..PROBES {
                    let slot = slots[(home + step) & mask];
                    if slot == 0 {
                        return None;
                    }
                    // The first key in probe order that is `key`: the first of equal keys, as a scan finds it.
                    let place = (slot & 0xffff_ffff) as usize - 1;
                    if slot & !0xffff_ffff == tag && &*keys[place] == key {
                        return Some(place);
                    }
                }
                None
            }
            Index::Sip(index) => index.get(key).map(|&i| i as usize),
        }
    }
}

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

    #[inline]
    pub fn position(&self, key: &str) -> Option<usize> {
        if self.keys.len() <= SCAN_KEYS {
            return self.keys.iter().position(|k| &**k == key);
        }
        self.index.get_or_init(|| Index::new(&self.keys)).position(&self.keys, key)
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

    /// Sets each of `entries` in turn, as `object[key] = value` does, making the keys of the result once: a key is found or added in a single
    /// pass over the object, not by copying and indexing the whole key list for each new one (a table of hundreds of pose sources gets one
    /// new key for each source a command captured).
    pub fn set_all<K: AsRef<str>>(&mut self, entries: impl IntoIterator<Item = (K, Value)>) {
        let mut added: Vec<(Arc<str>, Value)> = Vec::new();
        let mut added_at: HashMap<Arc<str>, usize> = HashMap::new();
        for (key, value) in entries {
            let key = key.as_ref();
            if let Some(i) = self.shape.position(key) {
                self.values[i] = value;
            } else if let Some(&at) = added_at.get(key) {
                added[at].1 = value;
            } else {
                let key: Arc<str> = Arc::from(key);
                added_at.insert(key.clone(), added.len());
                added.push((key, value));
            }
        }
        if added.is_empty() {
            return;
        }
        // The keys are in the order JavaScript enumerates them: the integer keys ascending, then the others as they were added.
        let leading = self.shape.keys.iter().take_while(|key| index_key(key).is_some()).count();
        let (mut integers, others): (Vec<(Arc<str>, Value)>, Vec<(Arc<str>, Value)>) = added.into_iter().partition(|(key, _)| index_key(key).is_some());
        integers.sort_by_key(|(key, _)| index_key(key));
        let keys = std::mem::replace(&mut self.shape, Shape::empty()).keys.to_vec();
        let values = std::mem::take(&mut self.values);
        let mut existing: Vec<(Arc<str>, Value)> = keys.into_iter().zip(values).collect();
        let rest = existing.split_off(leading);
        let mut merged: Vec<(Arc<str>, Value)> = Vec::with_capacity(existing.len() + integers.len() + rest.len() + others.len());
        let (mut old, mut new) = (existing.into_iter().peekable(), integers.into_iter().peekable());
        loop {
            let take_old = match (old.peek(), new.peek()) {
                (Some((a, _)), Some((b, _))) => index_key(a) <= index_key(b),
                (Some(_), None) => true,
                (None, Some(_)) => false,
                (None, None) => break,
            };
            merged.push(if take_old { old.next() } else { new.next() }.expect("peeked"));
        }
        merged.extend(rest);
        merged.extend(others);
        let (keys, values): (Vec<Arc<str>>, Vec<Value>) = merged.into_iter().unzip();
        self.shape = Shape::new(keys);
        self.values = values;
    }

    /// Removes each of `keys` (as `delete object[key]` does), making the keys of the result once.
    pub fn remove_all<'a>(&mut self, keys: impl IntoIterator<Item = &'a str>) {
        let gone: std::collections::HashSet<usize> = keys.into_iter().filter_map(|key| self.shape.position(key)).collect();
        if gone.is_empty() {
            return;
        }
        let kept: Vec<usize> = (0..self.values.len()).filter(|at| !gone.contains(at)).collect();
        let keys: Vec<Arc<str>> = kept.iter().map(|&at| self.shape.keys[at].clone()).collect();
        let values: Vec<Value> = kept.iter().map(|&at| self.values[at].clone()).collect();
        self.shape = Shape::new(keys);
        self.values = values;
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
    /// The value as a document parsed from text has it: no packed array shared with another place. A tree edited copy-on-write shares the
    /// arrays its records have in common, and the writer stores an array of 32 numbers or more that two places share once, so the file of
    /// a document that came by its nodes differs from the file of the same document that came as text. Only what holds an array is copied.
    pub fn unshared(&self) -> Value {
        self.unshared_arrays().unwrap_or_else(|| self.clone())
    }

    /// The bytes [`Value::unshared`] allocates for this value, counted conservatively before any of it is made: every packed array is copied,
    /// and so is every container that holds one. Every container, whether it holds one or not, allocates the list of its elements' copies
    /// while it looks, and a container that is copied allocates its new list and its owner besides. Each allocation is charged its header and
    /// alignment; a tree of two million arrays of one number costs what two million allocations do, which its text (a few characters for each)
    /// does not say. Walks the tree without allocating.
    pub fn unshared_cost(&self) -> usize {
        self.unshared_cost_of().0
    }

    /// The cost, and whether this value is copied at all.
    fn unshared_cost_of(&self) -> (usize, bool) {
        // An allocation's header and alignment, rounded up.
        const ALLOCATION: usize = 64;
        const ENTRY: usize = std::mem::size_of::<Option<Value>>();
        const NODE: usize = std::mem::size_of::<Value>();
        let walk = |items: &[Value]| -> (usize, bool) {
            let (mut cost, mut copied) = (0usize, false);
            for item in items {
                let (item_cost, item_copied) = item.unshared_cost_of();
                cost = cost.saturating_add(item_cost);
                copied |= item_copied;
            }
            // The list of copies made on the way, which is allocated whether anything is copied or not.
            (cost.saturating_add(items.len().saturating_mul(ENTRY)).saturating_add(ALLOCATION), copied)
        };
        match self {
            Value::Nums(numbers) => (ALLOCATION + std::mem::size_of::<Nums>() + numbers.heap_bytes() + ALLOCATION, true),
            Value::Arr(items) => {
                let (cost, copied) = walk(items);
                // The new list and its owner.
                if copied { (cost.saturating_add(items.len().saturating_mul(NODE)).saturating_add(2 * ALLOCATION), true) } else { (cost, false) }
            }
            Value::Obj(object) => {
                let (cost, copied) = walk(object.values());
                if copied { (cost.saturating_add(object.values().len().saturating_mul(NODE)).saturating_add(2 * ALLOCATION + std::mem::size_of::<Obj>()), true) } else { (cost, false) }
            }
            _ => (0, false),
        }
    }

    fn unshared_arrays(&self) -> Option<Value> {
        match self {
            Value::Nums(numbers) => Some(Value::Nums(Arc::new((**numbers).clone()))),
            Value::Arr(items) => {
                let copies: Vec<Option<Value>> = items.iter().map(Value::unshared_arrays).collect();
                copies.iter().any(Option::is_some).then(|| Value::Arr(Arc::new(items.iter().zip(copies).map(|(item, copy)| copy.unwrap_or_else(|| item.clone())).collect())))
            }
            Value::Obj(object) => {
                let copies: Vec<Option<Value>> = object.values().iter().map(Value::unshared_arrays).collect();
                copies.iter().any(Option::is_some).then(|| Value::Obj(Arc::new(Obj::from_shape(object.shape().clone(), object.values().iter().zip(copies).map(|(item, copy)| copy.unwrap_or_else(|| item.clone())).collect()))))
            }
            _ => None,
        }
    }

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

    /// Whether two values hold the same data to the bit, however it is shared: numbers compare by their bits (`-0` is not `0`).
    pub fn same_data(&self, other: &Value) -> bool {
        match (self, other) {
            (Value::Null, Value::Null) => true,
            (Value::Bool(a), Value::Bool(b)) => a == b,
            (Value::Num(a), Value::Num(b)) => a.to_bits() == b.to_bits(),
            (Value::Str(a), Value::Str(b)) => Arc::ptr_eq(a, b) || a == b,
            (Value::Blob(a), Value::Blob(b)) => Arc::ptr_eq(a, b) || a == b,
            (Value::Nums(a), Value::Nums(b)) => Arc::ptr_eq(a, b) || (a.len() == b.len() && (0..a.len()).all(|i| a.get(i).map(f64::to_bits) == b.get(i).map(f64::to_bits))),
            (Value::Arr(a), Value::Arr(b)) => Arc::ptr_eq(a, b) || (a.len() == b.len() && a.iter().zip(b.iter()).all(|(x, y)| x.same_data(y))),
            (Value::Obj(a), Value::Obj(b)) => Arc::ptr_eq(a, b) || (a.len() == b.len() && a.iter().zip(b.iter()).all(|((ka, va), (kb, vb))| ka == kb && va.same_data(vb))),
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
    fn the_cost_of_an_unshared_tree_counts_each_array_it_copies_and_the_lists_made_on_the_way() {
        let number = Value::Num(1.0);
        let strings = Value::array(vec![Value::str("a"), Value::str("b")]);
        // A tree with no packed array is not copied, but the list of the copies not made is allocated while it is looked through.
        assert!(strings.unshared_cost() > 0 && strings.unshared_cost() < 500, "{}", strings.unshared_cost());
        assert!(strings.unshared().same_node(&strings), "and it is the tree itself that comes back");
        assert_eq!(number.unshared_cost(), 0);
        let one = Value::nums(&[0.0]);
        // Two million arrays of one number: far more than the few characters each takes in text.
        let many = Value::array(vec![one.clone(); 2_000_000]);
        assert!(many.unshared_cost() > 2_000_000 * 100, "{}", many.unshared_cost());
        // The cost is of the copy that is made: what a tree holds once is not counted for what points at it twice.
        assert!(Value::array(vec![one.clone(), one.clone()]).unshared_cost() >= 2 * (64 + 64));
    }

    #[test]
    fn an_unshared_tree_has_each_packed_array_to_itself() {
        let pose = Value::nums(&(0..40).map(f64::from).collect::<Vec<_>>());
        let small = Value::nums(&[1.0, 2.0]);
        let plain = Value::object([(Arc::from("name"), Value::str("n"))].into_iter().collect());
        let tree = Value::Arr(Arc::new(vec![
            Value::object([(Arc::from("pose"), pose.clone()), (Arc::from("again"), pose.clone())].into_iter().collect()),
            Value::Arr(Arc::new(vec![pose.clone(), small.clone(), plain.clone()])),
            plain.clone(),
        ]));
        let copy = tree.unshared();
        assert_eq!(copy, tree);
        let arrays = |value: &Value| -> Vec<Arc<Nums>> {
            let (first, second) = (value.as_arr().unwrap()[0].as_obj().unwrap(), value.as_arr().unwrap()[1].as_arr().unwrap());
            [first.get("pose"), first.get("again"), Some(&second[0])].into_iter().flatten().filter_map(|v| if let Value::Nums(n) = v { Some(n.clone()) } else { None }).collect()
        };
        let (before, after) = (arrays(&tree), arrays(&copy));
        assert!(Arc::ptr_eq(&before[0], &before[1]) && Arc::ptr_eq(&before[0], &before[2]));
        assert!(!Arc::ptr_eq(&after[0], &after[1]) && !Arc::ptr_eq(&after[0], &after[2]) && !Arc::ptr_eq(&after[1], &after[2]));
        // What holds no array is the same node, not a copy.
        assert!(copy.as_arr().unwrap()[2].same_node(&plain));
    }

    #[test]
    fn keys_chosen_to_collide_in_a_fast_hash_do_not_slow_a_lookup() {
        // A file picks the keys of an object. Sixteen ASCII bytes per key, the second word chosen so the multiply-and-rotate hash of
        // [`crate::fast::FastHasher`] reaches the same state for every key: they would all land in one bucket of a map using it.
        let seed = crate::fast::SEED;
        let mut keys: Vec<Arc<str>> = Vec::new();
        let mut counter = 0u64;
        while keys.len() < 24_000 {
            counter += 1;
            // Four free ASCII bytes, the other four fixed: no two keys alike.
            let first = 0x2020_2020_0000_0000u64 | (counter & 0x7f) | ((counter >> 7 & 0x7f) << 8) | ((counter >> 14 & 0x7f) << 16) | ((counter >> 21 & 0x7f) << 24);
            let state = first.wrapping_mul(seed);
            let second = state.rotate_left(5);
            let (a, b) = (first.to_le_bytes(), second.to_le_bytes());
            if a.iter().chain(b.iter()).all(u8::is_ascii) {
                let bytes: Vec<u8> = a.iter().chain(b.iter()).copied().collect();
                keys.push(Arc::from(std::str::from_utf8(&bytes).unwrap()));
            }
        }
        let shape = Shape::new(keys.clone());
        let started = std::time::Instant::now();
        assert!(keys.iter().enumerate().all(|(at, key)| shape.position(key) == Some(at)));
        assert!(started.elapsed() < std::time::Duration::from_secs(2), "{:?}", started.elapsed());
        // They cannot lie close to where the fast hash points: the shape looks them up through SipHash.
        assert!(matches!(shape.index.get(), Some(Index::Sip(_))));
        // Nine of them are enough to leave the fast table, and a key they do not hold is not found.
        let few = Shape::new(keys[..9].to_vec());
        assert!(keys[..9].iter().enumerate().all(|(at, key)| few.position(key) == Some(at)));
        assert!(matches!(few.index.get(), Some(Index::Sip(_))));
        assert_eq!(few.position(&keys[9]), None);
    }

    #[test]
    fn a_wide_shape_finds_each_key_where_a_scan_finds_it() {
        // Keys as documents have them: field names, numbered ones, integer keys, long ones sharing a prefix, the empty key, non-ASCII ones.
        let mut names: Vec<String> = ["object_slot", "unique_id", "figure_type_id", "root_x", "root_y", "scale", "color_override_raw", "field28", "angles",
            "len_flag", "lengths", "bend_flag", "bends", "join", "", "é", "日本", "_stykIK"].iter().map(|key| key.to_string()).collect();
        names.extend((0..300).map(|n| n.to_string()));
        names.extend((0..300).map(|n| format!("segment_{n}_color_with_a_long_common_prefix_and_suffix")));
        let lookups: Vec<String> = names.iter().cloned().chain(["missing", "object_slot2", "unique_i", "0x", "-1", "segment_300_color_with_a_long_common_prefix_and_suffix"].map(String::from)).collect();
        let mut probed = 0;
        for width in [9, 10, 16, 17, 31, 64, 100, 257, names.len()] {
            for start in [0, 5, 17] {
                let keys: Vec<Arc<str>> = names.iter().cycle().skip(start).take(width).map(|key| Arc::from(key.as_str())).collect();
                let shape = Shape::new(keys.clone());
                for key in &lookups {
                    assert_eq!(shape.position(key), keys.iter().position(|k| &**k == key.as_str()), "{key:?} in {width} keys from {start}");
                }
                probed += usize::from(matches!(shape.index.get(), Some(Index::Probed(_))));
            }
        }
        assert!(probed > 0, "the fast table holds keys like these");
    }

    #[test]
    fn a_blob_equals_the_string_it_stands_for() {
        let blob = Value::Blob(Arc::new(Blob { prefix: Arc::from("data:x;base64,"), bytes: Arc::from(&b"hi!"[..]) }));
        assert_eq!(blob, Value::str("data:x;base64,aGkh"));
        assert_eq!(blob.text().unwrap(), "data:x;base64,aGkh");
    }
}

#[cfg(test)]
mod bulk_tests {
    use super::*;

    fn text(object: &Obj) -> String {
        object.iter().map(|(key, value)| format!("{key}={}", value.as_f64().unwrap_or(f64::NAN))).collect::<Vec<_>>().join(",")
    }

    #[test]
    fn setting_and_removing_many_keys_is_setting_and_removing_them_one_by_one() {
        let mut start = Obj::new();
        for (key, value) in [("b", 1.0), ("a", 2.0), ("7", 3.0), ("3", 4.0), ("c", 5.0)] { start.set(key, Value::Num(value)); }
        let entries = [("z", 10.0), ("a", 11.0), ("5", 12.0), ("z", 13.0), ("10", 14.0), ("0", 15.0), ("y", 16.0)];
        let mut one_by_one = start.clone();
        for (key, value) in entries { one_by_one.set(key, Value::Num(value)); }
        let mut at_once = start.clone();
        at_once.set_all(entries.iter().map(|(key, value)| (*key, Value::Num(*value))));
        assert_eq!(text(&at_once), text(&one_by_one));
        assert_eq!(text(&at_once), "0=15,3=4,5=12,7=3,10=14,b=1,a=11,c=5,z=13,y=16");
        assert_eq!(at_once.get("y").and_then(Value::as_f64), Some(16.0));
        let gone = ["a", "7", "missing", "z"];
        for key in gone { one_by_one.remove(key); }
        at_once.remove_all(gone);
        assert_eq!(text(&at_once), text(&one_by_one));
        assert_eq!(text(&at_once), "0=15,3=4,5=12,10=14,b=1,c=5,y=16");
        let mut wide = Obj::new();
        wide.set_all((0..1000).map(|n| (format!("key{n}"), Value::Num(n as f64))));
        assert_eq!(wide.len(), 1000);
        assert_eq!(wide.get("key731").and_then(Value::as_f64), Some(731.0));
    }
}
