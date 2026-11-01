//! A list of numbers that is an ordinary array in the document (a packed list that a command unpacked to edit it and did not pack again)
//! is stored as the lists of numbers are, and two different lists are two different lists in the file, wherever the allocator places the
//! temporary the writer packs each of them in. This test binary has an allocator that hands out again the block it freed last for that
//! temporary, so a writer that tells arrays apart by the address of a temporary finds the second list "already stored" as the first.
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::sync::Arc;

use styk_doc::{Nums, Obj, Value, json};
use styk_formats::container::{ViewLifter, lift, lift_together_within, parse_lifted};
use styk_formats::files::Host;

/// The size of what `Arc::new(Nums)` allocates: the two counts and the `Nums`.
const TEMPORARY: usize = std::mem::size_of::<Nums>() + 2 * std::mem::size_of::<usize>();

thread_local! {
    static REUSING: Cell<bool> = const { Cell::new(false) };
    static FREED: Cell<*mut u8> = const { Cell::new(std::ptr::null_mut()) };
}

struct Reusing;

fn the_temporary(layout: Layout) -> bool {
    layout.size() == TEMPORARY && layout.align() == std::mem::align_of::<usize>() && REUSING.try_with(Cell::get).unwrap_or(false)
}

unsafe impl GlobalAlloc for Reusing {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if the_temporary(layout) {
            let freed = FREED.try_with(|freed| freed.replace(std::ptr::null_mut())).unwrap_or(std::ptr::null_mut());
            if !freed.is_null() {
                return freed;
            }
        }
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        if the_temporary(layout) && FREED.try_with(|freed| freed.get().is_null()).unwrap_or(false) {
            let _ = FREED.try_with(|freed| freed.set(pointer));
            return;
        }
        unsafe { System.dealloc(pointer, layout) }
    }
}

#[global_allocator]
static ALLOCATOR: Reusing = Reusing;

/// A list of `count` numbers, an ordinary array of the document, different for every `seed`.
fn plain(seed: usize, count: usize) -> Value {
    Value::Arr(Arc::new((0..count).map(|i| Value::Num(((i + 1) * (seed + 1)) as f64 * 0.25 + seed as f64)).collect()))
}

fn record(lists: Vec<Value>) -> Value {
    let mut object = Obj::new();
    for (i, list) in lists.into_iter().enumerate() {
        object.set(&format!("list{i}"), list);
    }
    Value::object(object)
}

/// The document of the tests: records of several different plain lists each, one list shared by two records (one array, as the document
/// shares it), and a packed list among them.
fn document() -> Value {
    let shared = plain(99, 40);
    let mut records = Vec::new();
    for r in 0..8 {
        let mut lists: Vec<Value> = (0..3).map(|l| plain(r * 3 + l, 32 + l)).collect();
        if r % 3 == 0 {
            lists.push(shared.clone());
        }
        lists.push(Value::nums(&(0..36).map(|i| (i * (r + 7)) as f64).collect::<Vec<_>>()));
        records.push(record(lists));
    }
    let mut root = Obj::new();
    root.set("records", Value::array(records));
    Value::object(root)
}

fn reuse<T>(work: impl FnOnce() -> T) -> T {
    REUSING.with(|reusing| reusing.set(true));
    let result = work();
    REUSING.with(|reusing| reusing.set(false));
    let freed = FREED.with(|freed| freed.replace(std::ptr::null_mut()));
    if !freed.is_null() {
        // Given back to the system by the layout it was made with.
        unsafe { System.dealloc(freed, Layout::from_size_align(TEMPORARY, std::mem::align_of::<usize>()).unwrap()) };
    }
    result
}

fn read_back(lifted: &styk_formats::container::Lifted) -> Value {
    parse_lifted(&lifted.skeleton, &lifted.arrays, &lifted.payloads).unwrap()
}

/// The guard of the other tests: the block of a temporary that was freed is the next temporary's.
#[test]
fn the_allocator_of_this_test_hands_out_the_block_it_freed_last() {
    reuse(|| {
        let first = Arc::new(Nums::new(&[1.0, 2.0]));
        let address = Arc::as_ptr(&first) as usize;
        drop(first);
        let second = Arc::new(Nums::new(&[3.0, 4.0]));
        assert_eq!(Arc::as_ptr(&second) as usize, address);
    });
}

#[test]
fn different_plain_lists_of_numbers_are_written_as_themselves() {
    let document = document();
    let lifted = reuse(|| lift(&document, &[]).unwrap());
    assert_eq!(json::to_string(&read_back(&lifted)), json::to_string(&document));
}

#[test]
fn a_plain_list_that_two_records_share_is_still_written_once() {
    let document = document();
    let lifted = lift(&document, &[]).unwrap();
    let text = String::from_utf8(lifted.skeleton.clone()).unwrap();
    let markers: Vec<&str> = text.match_indices("S2B:").map(|(at, _)| &text[at..text[at..].find('"').map_or(text.len(), |end| at + end)]).collect();
    let distinct: std::collections::HashSet<&&str> = markers.iter().collect();
    // Eight records each hold three lists of their own and a packed one; three of them also hold the shared list.
    assert_eq!(markers.len(), 8 * 4 + 3, "{text}");
    assert_eq!(distinct.len(), 8 * 4 + 1, "the shared list is written once and named by the other two: {text}");
}

#[test]
fn the_view_of_the_document_names_the_lists_it_holds() {
    let document = document();
    let records = document.get("records").unwrap().elements().unwrap();
    let parts: Vec<_> = reuse(|| {
        let mut lifter = ViewLifter::new();
        records.iter().map(|record| lifter.part(&record, "").unwrap()).collect()
    });
    let whole = lift(&document, &[]).unwrap();
    let mut arrays = Vec::new();
    for part in &parts {
        arrays.extend_from_slice(&part.arrays);
    }
    assert_eq!(arrays, whole.arrays);
    let skeletons: Vec<String> = parts.iter().map(|part| String::from_utf8(part.skeleton.clone()).unwrap()).collect();
    let wanted = String::from_utf8(whole.skeleton.clone()).unwrap();
    let wanted = json::parse(wanted.as_bytes()).unwrap();
    for (skeleton, record) in skeletons.iter().zip(wanted.get("records").unwrap().elements().unwrap().iter()) {
        assert_eq!(json::parse(skeleton.as_bytes()).unwrap(), record);
    }
}

/// A host with threads to spare in name only: the pieces are lifted in turn, and the lists they hold wait as holes for the splice.
struct Alone;

impl Host for Alone {
    fn cancelled(&self) -> bool {
        false
    }
    fn threads(&self) -> usize {
        4
    }
}

#[test]
fn lists_lifted_in_pieces_are_the_lists_of_the_whole() {
    // Enough records for the lift to go in pieces.
    let mut records = Vec::new();
    for r in 0..300 {
        records.push(record((0..3).map(|l| plain(r * 3 + l, 32 + l)).collect()));
    }
    let mut root = Obj::new();
    root.set("records", Value::array(records));
    let document = Value::object(root);
    let whole = lift(&document, &[]).unwrap();
    let (pieces, _) = reuse(|| lift_together_within(&document, &[], usize::MAX / 8, &Alone).unwrap());
    assert_eq!(pieces.skeleton, whole.skeleton);
    assert_eq!(pieces.arrays, whole.arrays);
    assert_eq!(json::to_string(&read_back(&pieces)), json::to_string(&document));
}
