//! What `Value::unshared` allocates is never more than `Value::unshared_cost` says, whatever the tree holds: the call that copies a clip reserves
//! the estimate before it copies, and a copy that outgrows it runs the module out of memory. Measured with an allocator that counts what each
//! allocation asks for (summed, not the peak: the estimate is meant to bound what the copy asks for in all).
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

use styk_doc::{Obj, Value};

struct Count;
thread_local! {
    /// The bytes the allocations of this thread have asked for.
    static ASKED: Cell<usize> = const { Cell::new(0) };
}
unsafe impl GlobalAlloc for Count {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ASKED.with(|asked| asked.set(asked.get() + layout.size()));
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) { unsafe { System.dealloc(ptr, layout) } }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new: usize) -> *mut u8 {
        ASKED.with(|asked| asked.set(asked.get() + new));
        unsafe { System.realloc(ptr, layout, new) }
    }
}
#[global_allocator]
static COUNT: Count = Count;

/// The bytes `tree.unshared()` asks for, and the estimate.
fn measured(tree: &Value) -> (usize, usize) {
    let estimate = tree.unshared_cost();
    let before = ASKED.with(Cell::get);
    let copy = tree.unshared();
    let asked = ASKED.with(Cell::get) - before;
    drop(copy);
    (asked, estimate)
}

fn within(name: &str, tree: Value) {
    let (asked, estimate) = measured(&tree);
    assert!(estimate >= asked, "{name}: the copy asked for {asked} bytes and the estimate is {estimate}");
}

fn object(pairs: Vec<(String, Value)>) -> Value {
    let mut object = Obj::new();
    for (key, value) in pairs { object.set(&key, value); }
    Value::object(object)
}

#[test]
fn the_estimate_bounds_what_the_copy_asks_for() {
    // 4,096 empty strings: nothing to copy, and a list of the copies not made.
    within("empty strings", Value::array(vec![Value::str(""); 4096]));
    within("nested arrays of strings", Value::array((0..64).map(|_| Value::array(vec![Value::str("a"); 64])).collect()));
    within("a map of strings", object((0..200).map(|i| (format!("k{i}"), Value::str("v"))).collect()));
    within("a wide string-only subtree beside a packed array", Value::array(vec![Value::nums(&[1.0, 2.0]), Value::array(vec![Value::str("x"); 4096])]));
    within("a mixed tree", object(vec![
        ("names".into(), Value::array(vec![Value::str("a"); 300])),
        ("pose".into(), Value::nums(&[0.5; 70])),
        ("nested".into(), Value::array((0..50).map(|i| object(vec![("id".into(), Value::Num(i as f64)), ("angles".into(), Value::nums(&[1.0, 2.0, 3.0])), ("label".into(), Value::str("figure"))])).collect())),
        ("flags".into(), Value::array(vec![Value::Bool(true); 500])),
    ]));
    within("two thousand small arrays", Value::array(vec![Value::nums(&[0.0]); 2000]));
    within("a deep chain of arrays", (0..200).fold(Value::nums(&[1.0]), |inner, _| Value::array(vec![inner, Value::str("s")])));
    let shared = Value::nums(&[1.0, 2.0, 3.0]);
    within("an array shared by many records", Value::array((0..500).map(|_| object(vec![("angles".into(), shared.clone()), ("id".into(), Value::Num(1.0))])).collect()));
}
