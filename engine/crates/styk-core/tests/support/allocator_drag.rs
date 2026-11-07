//! Run only as an explicitly requested release measurement. Input is read in place and never written.
use std::sync::Arc;
use std::time::Instant;
use styk_core::documents::{Documents, PreparedDocument};
use styk_core::engine::Value;
use styk_engine::{Budgets, Engine};

pub fn run(counted: bool) {
    // Compile this explicitly ignored probe in both profiles, but reject a debug invocation at runtime.
    assert!(!std::hint::black_box(cfg!(debug_assertions)), "allocation timing requires --release");
    let path = std::env::var_os("STYK_ALLOC_DRAG_FILE").expect("set the in-place measurement input");
    let bytes: Arc<[u8]> = std::fs::read(path).expect("read measurement input in place").into();
    styk_alloc::set_limit(usize::try_from(8u64 << 30).unwrap_or(isize::MAX as usize));
    let engine = Engine::new(|| 0.0, Budgets::for_device(Some(8.0)));
    let prepared = PreparedDocument::open_bytes(&engine, bytes, "measurement.piv", &|| false).unwrap();
    let mut documents = Documents::new();
    let id = documents.open(prepared).map_err(|(error, _)| error).unwrap();
    // Exercise the allocation-heavy frame, not the first-frame load default of the panel seam.
    let tree = documents.get(id).unwrap().records();
    let index = tree.get("keyframes").unwrap().elements().unwrap().iter().enumerate()
        .max_by_key(|(_, frame)| frame.get("objects").and_then(Value::array_len).unwrap_or(0)).unwrap().0;
    let tick = styk_edit::timeline_rows(tree)[index].0;
    documents.call(id, "seek", &[Value::Num(tick)], &Value::Null).unwrap().result.unwrap();
    let frame = documents.get(id).unwrap().frame_records().unwrap();
    let selected: Vec<_> = frame.get("objects").unwrap().elements().unwrap().iter().map(|object| object.get("unique_id").unwrap().clone()).collect();
    let objects = selected.len(); assert!(objects > 1, "the measurement must exercise a dense frame");
    documents.call(id, "selectMany", &[Value::array(selected)], &Value::Null).unwrap().result.unwrap();
    let original = documents.get(id).unwrap().records().clone();
    let options = styk_doc::json::parse(br#"{"fromStart":true}"#).unwrap();
    let mut timings = Vec::new();
    styk_alloc::reset_peak();
    for sample in 0..4 {
        documents.call(id, "beginTranslationDrag", &[], &Value::Null).unwrap().result.unwrap();
        let started = Instant::now();
        for step in 1..=120 {
            let moved = documents.call(id, "moveSelection", &[Value::Num(step as f64), Value::Num(0.0), options.clone()], &Value::Null).unwrap().result.unwrap();
            assert!(moved.truthy(), "each measured step must actually move the selection");
            let frame = documents.get(id).unwrap().frame_records().unwrap();
            assert!(frame.get("objects").and_then(Value::array_len).unwrap_or(0) > 0);
            std::hint::black_box(frame);
        }
        let elapsed = started.elapsed().as_secs_f64() * 1_000_000.0 / 120.0;
        documents.call(id, "cancelDrag", &[], &Value::Null).unwrap().result.unwrap();
        assert!(documents.get(id).unwrap().records().same_node(&original), "each gesture cancellation restores the original head");
        if sample > 0 { timings.push(elapsed); }
    }
    assert_eq!(styk_alloc::live_bytes() > 0, counted);
    println!("ALLOCATOR_DRAG counted={counted} objects={objects} samples_us={timings:?} live_bytes={} peak_bytes={}", styk_alloc::live_bytes(), styk_alloc::peak_bytes());
}
