#[global_allocator]
static ALLOCATOR: styk_alloc::Counting = styk_alloc::Counting;
#[path = "support/allocator_drag.rs"]
mod measurement;
#[test]
#[ignore = "release allocation measurement; requires STYK_ALLOC_DRAG_FILE"]
fn allocator_drag_counted() { measurement::run(true); }
