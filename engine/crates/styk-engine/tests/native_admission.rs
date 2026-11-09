//! Repository-generated analogue of the compressed Pivot found in the K-doc review.
//! Lives beside the engine's existing miniz dependency; the native host is exercised end to end.
#[global_allocator]
static ALLOCATOR: styk_alloc::Counting = styk_alloc::Counting;

use std::sync::{Arc, mpsc};
use std::time::Duration;
use styk_core::documents::*;
use styk_core::engine::{Engine, Budgets};
use styk_services::{Job, SpawnError, Spawner};
use styk_services::files::{FileTarget, fake::MemoryFiles};

struct Threads;
impl Spawner for Threads {
    fn spawn(&self, name: &str, job: Job) -> Result<(), SpawnError> {
        std::thread::Builder::new().name(name.into()).spawn(job).map(|_| ()).map_err(|e| SpawnError(e.to_string()))
    }
}

#[test]
fn compressed_pivot_is_refused_before_installation_and_can_retry_after_memory_frees() {
    let original = include_bytes!("../../styk-piv/tests/fixtures/modern-identities.piv");
    let mut payload = miniz_oxide::inflate::decompress_to_vec_zlib(original).unwrap();
    payload.resize(payload.len() + (64 << 20), 0);
    let bytes: Arc<[u8]> = miniz_oxide::deflate::compress_to_vec_zlib(&payload, 1).into();
    drop(payload);
    assert!(bytes.len() < 1 << 20, "small compressed file, 64 MiB expansion");
    eprintln!("generated compressed bytes={}", bytes.len());
    let files = Arc::new(MemoryFiles::default());
    let target = FileTarget::new("compressible.piv");
    files.put(target.clone(), bytes);
    let (send, wake) = mpsc::channel();
    let startup = styk_doc::json::parse(include_bytes!("../../../tests/edit/startup.document.json")).unwrap();
    let mut docs = Documents::new();
    docs.attach_host(HostOptions { engine: Engine::new(|| 0.0, Budgets::for_device(None)), files, spawner: Arc::new(Threads), startup,
        clock: Arc::new(|| 0.0), notify: Arc::new(move || { let _ = send.send(()); }) }).unwrap();
    let next = |docs: &mut Documents| {
        for _ in 0..4000 {
            if let Some(effect) = docs.poll() { return effect; }
            let _ = wake.recv_timeout(Duration::from_millis(5));
        }
        panic!("open must terminate")
    };
    assert!(matches!(docs.dispatch(Request::New), Ok(Effect::Started(_))));
    let Effect::Opened(current) = next(&mut docs) else { panic!("startup") };
    let before = styk_alloc::live_bytes();
    styk_alloc::set_limit(128 << 20);
    styk_alloc::reset_peak();
    assert!(matches!(docs.dispatch(Request::OpenFile(target.clone())), Ok(Effect::Started(_))));
    let result = next(&mut docs);
    eprintln!("compressed open: live={} peak={} result={result:?}", styk_alloc::live_bytes(), styk_alloc::peak_bytes());
    assert!(matches!(result, Effect::Failed { error: HostError::Open(ref error), .. } if error.code.as_deref() == Some("out_of_memory")));
    assert_eq!(docs.active().unwrap().id(), current);
    assert_eq!(docs.tabs().len(), 1);
    assert_eq!(styk_alloc::reserved_bytes(), 0);
    assert!(styk_alloc::live_bytes() < before + (1 << 20), "refused owner released on worker");
    assert!(styk_alloc::peak_bytes() < 128 << 20, "reject the known expansion before allocating it");
    // The same limit gains headroom when another workload releases its reservation.
    styk_alloc::set_limit(768 << 20);
    let pressure = styk_alloc::reserve(640 << 20).unwrap();
    assert!(matches!(docs.dispatch(Request::OpenFile(target.clone())), Ok(Effect::Started(_))));
    assert!(matches!(next(&mut docs), Effect::Failed { error: HostError::Open(_), .. }));
    drop(pressure);
    assert!(matches!(docs.dispatch(Request::OpenFile(target)), Ok(Effect::Started(_))));
    assert!(matches!(next(&mut docs), Effect::Opened(_)), "same file succeeds after pressure releases");
    assert_eq!(styk_alloc::reserved_bytes(), 0);
    assert!(docs.active().unwrap().frame_records().is_ok());
}
