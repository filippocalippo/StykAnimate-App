#[path = "support/allocator_drag.rs"]
mod measurement;
#[test]
#[ignore = "release allocation measurement; requires STYK_ALLOC_DRAG_FILE"]
fn allocator_drag_system() { measurement::run(false); }
