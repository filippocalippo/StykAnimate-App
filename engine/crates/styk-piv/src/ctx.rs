//! Per-request context: cooperative cancellation, and shared object layouts.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

use styk_doc::{Obj, Shape, Value};

use crate::error::{PyResult, cancelled};

/// What every long-running step receives. `checkpoint` is called at the loop
/// and stage boundaries where the Python codec called `work_control.checkpoint`.
pub(crate) struct Ctx<'a> {
    cancel: &'a dyn Fn() -> bool,
}

impl<'a> Ctx<'a> {
    pub fn new(cancel: &'a dyn Fn() -> bool) -> Ctx<'a> {
        Ctx { cancel }
    }

    /// Fails with the cancellation error once the host asked to stop.
    #[inline]
    pub fn checkpoint(&self) -> PyResult<()> {
        if (self.cancel)() { Err(cancelled()) } else { Ok(()) }
    }
}

thread_local! {
    /// One `Arc<str>` per key the codec writes.
    static KEYS: RefCell<HashMap<&'static str, Arc<str>>> = RefCell::new(HashMap::new());
    /// One key list per record layout, found by the addresses of its interned keys.
    static SHAPES: RefCell<HashMap<Vec<usize>, Arc<Shape>>> = RefCell::new(HashMap::new());
}

/// The shared `Arc<str>` of a key the codec writes.
pub(crate) fn key(name: &'static str) -> Arc<str> {
    KEYS.with(|keys| keys.borrow_mut().entry(name).or_insert_with(|| Arc::from(name)).clone())
}

fn intern_shape(keys: Vec<Arc<str>>) -> Arc<Shape> {
    let identity: Vec<usize> = keys.iter().map(|k| Arc::as_ptr(k) as *const u8 as usize).collect();
    SHAPES.with(|shapes| shapes.borrow_mut().entry(identity).or_insert_with(|| Shape::new(keys)).clone())
}

/// The shared layout of a record with exactly these keys, in this order.
pub(crate) fn shape(names: &[&'static str]) -> Arc<Shape> {
    intern_shape(names.iter().map(|name| key(name)).collect())
}

/// Builds an object the way a Python `dict` literal followed by assignments
/// does: keys keep the order of their first assignment.
#[derive(Default)]
pub(crate) struct ObjB {
    keys: Vec<Arc<str>>,
    names: Vec<&'static str>,
    values: Vec<Value>,
}

impl ObjB {
    pub fn new() -> ObjB {
        ObjB::default()
    }

    /// `dict[key] = value`.
    pub fn set(&mut self, name: &'static str, value: impl Into<Value>) -> &mut ObjB {
        let value = value.into();
        match self.names.iter().position(|n| *n == name) {
            Some(at) => self.values[at] = value,
            None => {
                self.keys.push(key(name));
                self.names.push(name);
                self.values.push(value);
            }
        }
        self
    }

    /// `dict.setdefault(key, value)`.
    pub fn set_default(&mut self, name: &'static str, value: impl Into<Value>) -> &mut ObjB {
        if !self.names.contains(&name) {
            self.set(name, value);
        }
        self
    }

    pub fn num(&mut self, name: &'static str, value: impl Into<f64>) -> &mut ObjB {
        self.set(name, Value::Num(value.into()))
    }

    pub fn get(&self, name: &str) -> Option<&Value> {
        self.names.iter().position(|n| *n == name).map(|at| &self.values[at])
    }

    /// `dict(self)`: the object as it stands, leaving the builder usable.
    pub fn snapshot(&self) -> Value {
        Value::Obj(Arc::new(Obj::from_shape(intern_shape(self.keys.clone()), self.values.clone())))
    }

    pub fn build(self) -> Value {
        Value::Obj(Arc::new(Obj::from_shape(intern_shape(self.keys), self.values)))
    }

    pub fn build_obj(self) -> Obj {
        Obj::from_shape(intern_shape(self.keys), self.values)
    }
}

/// A list. Packed when it holds only numbers, as the JSON reader builds it.
pub(crate) fn list(items: Vec<Value>) -> Value {
    Value::array(items)
}

pub(crate) fn empty_list() -> Value {
    Value::Arr(Arc::new(Vec::new()))
}

pub(crate) fn text(value: &str) -> Value {
    Value::Str(Arc::from(value))
}

pub(crate) fn num(value: impl Into<f64>) -> Value {
    Value::Num(value.into())
}

/// A count or offset as a number (exact below 2^53, which every payload offset is).
pub(crate) fn int(value: usize) -> Value {
    Value::Num(value as f64)
}
