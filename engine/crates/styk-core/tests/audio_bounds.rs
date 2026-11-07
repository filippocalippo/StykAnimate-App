//! Preparation is bounded: any number of prepare calls run on one worker with the newest request waiting, so the process does
//! not gain a thread (or a blocked waiter) per call. Threads are counted by the operating system, for the whole process, so this
//! binary holds this one test.
#![cfg(windows)]

mod support;

use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use support::audio::*;
use styk_core::audio::Then;

/// Threads of this process.
fn threads() -> usize {
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32};
    use windows_sys::Win32::Foundation::CloseHandle;
    // SAFETY: a snapshot handle opened and closed here, and a struct whose size is set as the API requires.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        let mut entry: THREADENTRY32 = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
        let (pid, mut count) = (std::process::id(), 0);
        let mut more = Thread32First(snapshot, &mut entry);
        while more != 0 {
            if entry.th32OwnerProcessID == pid {
                count += 1;
            }
            more = Thread32Next(snapshot, &mut entry);
        }
        CloseHandle(snapshot);
        count
    }
}

#[test]
fn a_hundred_prepares_cost_no_more_than_one_worker() {
    let decoder = TestDecoder::new(Behavior::Gated);
    let audio = state(&[("a", b"not a wav", 1.0)], &[("a", 0.0, 0.0, 1.0, 1.0)]);
    let mut rig = rig_with(config(), decoder.clone(), BIG, false);
    std::thread::sleep(Duration::from_millis(200));
    let before = threads();
    // Each request is made after the previous one started working, as a person dragging does.
    let ids: Vec<u64> = (0..100)
        .map(|_| {
            let id = rig.transport.prepare(&audio, 0.0, 1.0, Then::Hold);
            std::thread::sleep(Duration::from_millis(3));
            id
        })
        .collect();
    std::thread::sleep(Duration::from_millis(300));
    let during = threads();
    assert!(during <= before + 3, "100 prepares took the process from {before} to {during} threads");
    decoder.open_gate();
    // Only the newest request is reported, and the decoder ran for at most the one that was in flight and the newest.
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut ready = Vec::new();
    while ready.is_empty() {
        assert!(Instant::now() < deadline, "no plan was prepared");
        for event in rig.transport.poll() {
            if let styk_core::audio::Event::Ready { job, .. } = event {
                ready.push(job);
            }
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    assert_eq!(ready, vec![*ids.last().unwrap()]);
    assert!(decoder.calls.load(Ordering::SeqCst) <= 2, "{} decodes ran", decoder.calls.load(Ordering::SeqCst));
}
