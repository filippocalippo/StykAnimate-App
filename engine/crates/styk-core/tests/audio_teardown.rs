//! Closing the transport frees the decoded audio on neither the thread that closes it nor the output thread: every exit path hands
//! the plans, queued or playing, to a thread that exists to free them. A counting allocator reads the bytes the calling thread
//! frees while it drops the transport.

#[path = "support/alloc.rs"]
mod alloc;
mod support;

use std::time::{Duration, Instant};

use support::audio::*;
use styk_core::audio::Then;

#[global_allocator]
static COUNTING: alloc::Counting = alloc::Counting;

/// What the calling thread may free dropping a transport: bookkeeping, never a 192 KB recording.
const SMALL: usize = 48 * 1024;

fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !done() {
        assert!(Instant::now() < deadline, "{what}");
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn recording() -> styk_core::audio::AudioState {
    // Not a WAV, so the decoder double makes the 192,044-byte decoded buffer.
    state(&[("a", b"not a wav", 1.0)], &[("a", 0.0, 0.0, 1.0, 1.0)])
}

#[test]
fn closing_frees_the_audio_elsewhere_on_every_exit_path() {
    // Close while playing.
    {
        let mut rig = rig(config());
        rig.transport.play_range(&recording(), 0.0, 1.0);
        rig.until_started();
        rig.fake.advance_ms(100);
        rig.transport.store().clear();
        let (before, transport) = (alloc::freed_here(), rig.transport);
        drop(transport);
        assert!(alloc::freed_here() - before < SMALL, "closing while playing freed {} bytes on the caller", alloc::freed_here() - before);
    }
    // The device is lost before the stop applies.
    {
        let mut rig = rig(config());
        rig.transport.play_range(&recording(), 0.0, 1.0);
        rig.until_started();
        rig.fake.advance_ms(100);
        rig.fake.lose_device();
        rig.transport.stop();
        rig.transport.store().clear();
        let (before, transport) = (alloc::freed_here(), rig.transport);
        drop(transport);
        assert!(alloc::freed_here() - before < SMALL, "closing after a lost device freed {} bytes on the caller", alloc::freed_here() - before);
    }
    // A prepare completes and nobody polls it: the finished plan waits in the transport.
    {
        let mut rig = rig(config());
        rig.transport.prepare(&recording(), 0.0, 1.0, Then::Hold);
        wait_until("the prepare did not finish", || rig.transport.store().cached() == 1);
        std::thread::sleep(Duration::from_millis(300));
        rig.transport.store().clear();
        let (before, transport) = (alloc::freed_here(), rig.transport);
        drop(transport);
        assert!(alloc::freed_here() - before < SMALL, "closing after an unpolled prepare freed {} bytes on the caller", alloc::freed_here() - before);
    }
}

