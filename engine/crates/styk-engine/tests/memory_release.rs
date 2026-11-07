//! A very compressible Pivot file on the engine's own path. The first test reads the private bytes of the process: no other test here holds memory of size.
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use styk_engine::document::{OpenOptions, OpenSource};
use styk_engine::{Budgets, Engine};

fn clock() -> f64 {
    0.0
}

const APP: OpenOptions = OpenOptions { layer_timeline: true };
const STATE: &str = r#"{"propertyChannels":true,"layerTimeline":true,"tick":0,"frameIndex":0,"layerRevision":1,"nextFrameIdentity":2,"nextUid":2}"#;

/// A Pivot file with `padding` zero bytes after the project of a fixture: it inflates to a thousand times its size and more.
fn padded_with_zeros(padding: usize) -> Vec<u8> {
    let original = std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../styk-piv/tests/fixtures/modern-identities.piv")).unwrap();
    let mut payload = miniz_oxide::inflate::decompress_to_vec_zlib(&original).unwrap();
    payload.resize(payload.len() + padding, 0);
    miniz_oxide::deflate::compress_to_vec_zlib(&payload, 1)
}

/// The bytes the process holds privately (the commit charge), as the task manager shows them.
#[cfg(windows)]
fn private_bytes() -> usize {
    #[repr(C)]
    struct Counters {
        cb: u32,
        page_faults: u32,
        peak_working_set: usize,
        working_set: usize,
        quota_peak_paged_pool: usize,
        quota_paged_pool: usize,
        quota_peak_non_paged_pool: usize,
        quota_non_paged_pool: usize,
        pagefile: usize,
        peak_pagefile: usize,
        private: usize,
    }
    unsafe extern "system" {
        fn GetCurrentProcess() -> isize;
        fn K32GetProcessMemoryInfo(process: isize, counters: *mut Counters, size: u32) -> i32;
    }
    let mut counters = Counters { cb: std::mem::size_of::<Counters>() as u32, page_faults: 0, peak_working_set: 0, working_set: 0, quota_peak_paged_pool: 0, quota_paged_pool: 0, quota_peak_non_paged_pool: 0, quota_non_paged_pool: 0, pagefile: 0, peak_pagefile: 0, private: 0 };
    // SAFETY: the structure is the one the call fills, with its size in `cb`.
    assert_ne!(unsafe { K32GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, counters.cb) }, 0);
    counters.private
}

/// The largest private-byte count seen by a thread that looks every 2 ms, until it is stopped: by [`Sampler::stop`], or by the end of the scope of
/// the test, a panic included (a sampler that only a successful run stopped left a failing test waiting for it for ever).
struct Sampler {
    running: Arc<AtomicBool>,
    peak: Arc<AtomicUsize>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Sampler {
    fn start() -> Sampler {
        let (running, peak) = (Arc::new(AtomicBool::new(true)), Arc::new(AtomicUsize::new(0)));
        let (flag, seen) = (running.clone(), peak.clone());
        let thread = std::thread::spawn(move || {
            while flag.load(Ordering::Relaxed) {
                seen.fetch_max(private_bytes(), Ordering::Relaxed);
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
        });
        Sampler { running, peak, thread: Some(thread) }
    }

    fn stop(self) -> usize {
        self.peak.load(Ordering::Relaxed)
    }
}

impl Drop for Sampler {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// A very compressible file (250 MB of zeros after a project, a few hundred kilobytes) opens within the browser's 2 GiB, and once the
/// document is closed (the engine, its session and every handle dropped) the process holds what it held before. The WebAssembly memory
/// that stays at its high-water mark after such an open is the allocator's (`dlmalloc` never gives pages back), not the engine's.
#[cfg(windows)]
#[test]
fn a_very_compressible_file_opens_and_the_memory_it_held_is_released_when_the_document_closes() {
    let file = padded_with_zeros(250_000_000);
    assert!(file.len() < 2 << 20, "{} bytes of file", file.len());
    let before = private_bytes();
    let sampler = Sampler::start();
    let (engine, opened, session) = {
        let engine = Engine::new(clock, Budgets::for_device(None));
        let opened = styk_alloc::with_limit(2 << 30, || engine.open_document(OpenSource::File { bytes: &file, name: "Big.piv" }, APP, &|| false));
        let mut opened = opened.unwrap_or_else(|error| panic!("refused: {}", error.message));
        opened.attach_source(Arc::from(&file[..])).unwrap();
        engine.activate(&opened.typed, &opened.tree, 1).unwrap();
        let session = opened.start_session(STATE).unwrap();
        (engine, opened, session)
    };
    let held = private_bytes();
    drop((session, opened, engine));
    let open = sampler.stop();
    let after = private_bytes();
    let mib = |bytes: usize| bytes >> 20;
    eprintln!("MiB: before {}, peak while opening {}, open {}, after closing {}", mib(before), mib(open), mib(held), mib(after));
    assert!(held > before + (400 << 20), "the open document holds the padding ({} MiB held over {} MiB before)", mib(held), mib(before));
    assert!(after < before + (64 << 20), "{} MiB held after the document closed, {} MiB before it opened", mib(after), mib(before));
}

/// A test that fails while the sampler runs ends: the sampler is stopped as the panic unwinds.
#[cfg(windows)]
#[test]
fn a_failure_while_the_sampler_runs_ends_the_test_instead_of_hanging_it() {
    let outcome = std::panic::catch_unwind(|| {
        let _sampler = Sampler::start();
        panic!("a regression while the memory is being sampled");
    });
    assert!(outcome.is_err());
}
