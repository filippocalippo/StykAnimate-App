//! Native test instrumentation of allocations/deallocations under one Shared lock.
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::{Cell, RefCell};
use std::sync::{Arc, Barrier};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Counts { pub locks: usize, pub allocations: usize, pub deallocations: usize }
thread_local! {
    static TARGET: Cell<usize> = const { Cell::new(0) };
    static ACTIVE: Cell<bool> = const { Cell::new(false) };
    static COUNTS: Cell<Counts> = const { Cell::new(Counts { locks: 0, allocations: 0, deallocations: 0 }) };
    static PAUSE: RefCell<Option<Pause>> = const { RefCell::new(None) };
}
enum Action { Wait(Arc<[Barrier; 2]>), Fail }
struct Pause { pointer: usize, remaining: usize, action: Action }

/// A deterministic native-test barrier before the selected actual lock. The
/// worker never waits at this barrier while it owns the shared critical section.
pub(crate) fn before_lock(pointer: usize) {
    let action = PAUSE.with(|pause| {
        let mut pause = pause.borrow_mut();
        let next = pause.as_mut().filter(|next| next.pointer == pointer)?;
        next.remaining -= 1;
        if next.remaining != 0 { return None }
        Some(pause.take().expect("selected pause").action)
    });
    match action { Some(Action::Wait(barriers)) => { barriers[0].wait(); barriers[1].wait(); }, Some(Action::Fail) => panic!("injected worker preparation failure"), None => {} }
}
pub(crate) fn with_pause<T>(pointer: usize, nth: usize, barriers: Arc<[Barrier; 2]>, run: impl FnOnce() -> T) -> T {
    with_action(pointer, nth, Action::Wait(barriers), run)
}
pub(crate) fn with_failure<T>(pointer: usize, nth: usize, run: impl FnOnce() -> T) -> T {
    with_action(pointer, nth, Action::Fail, run)
}
fn with_action<T>(pointer: usize, nth: usize, action: Action, run: impl FnOnce() -> T) -> T {
    assert!(nth > 0);
    struct Reset;
    impl Drop for Reset { fn drop(&mut self) { PAUSE.with(|pause| { pause.borrow_mut().take(); }); } }
    let _reset = Reset;
    PAUSE.with(|pause| { *pause.borrow_mut() = Some(Pause { pointer, remaining: nth, action }); });
    run()
}
struct Allocator;
#[global_allocator]
static ALLOCATOR: Allocator = Allocator;
unsafe impl GlobalAlloc for Allocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        count(true);
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        count(true);
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        count(true); count(false);
        unsafe { System.realloc(pointer, layout, new_size) }
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        count(false);
        unsafe { System.dealloc(pointer, layout) }
    }
}
fn count(allocation: bool) {
    if ACTIVE.try_with(Cell::get).unwrap_or(false) {
        let _ = COUNTS.try_with(|counts| { let mut value = counts.get(); if allocation { value.allocations += 1 } else { value.deallocations += 1 }; counts.set(value); });
    }
}
pub(crate) fn enter(pointer: usize) -> bool {
    if !TARGET.with(|target| target.get() == pointer) { return false }
    COUNTS.with(|counts| { let mut value = counts.get(); value.locks += 1; counts.set(value); });
    ACTIVE.with(|active| active.set(true));
    true
}
pub(crate) fn active() -> bool { ACTIVE.with(Cell::get) }
pub(crate) fn leave(traced: bool) { if traced { ACTIVE.with(|active| active.set(false)); } }
pub(crate) fn watch<T>(pointer: usize, run: impl FnOnce() -> T) -> (T, Counts) {
    struct Reset;
    impl Drop for Reset { fn drop(&mut self) { ACTIVE.with(|active| active.set(false)); TARGET.with(|target| target.set(0)); } }
    let _reset = Reset;
    COUNTS.with(|counts| counts.set(Counts::default()));
    TARGET.with(|target| target.set(pointer));
    let result = run();
    (result, COUNTS.with(Cell::get))
}
