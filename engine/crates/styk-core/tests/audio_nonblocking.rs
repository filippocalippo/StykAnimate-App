//! The interface side of the transport takes no lock the preparing worker holds. The worker is held inside the decoder (where it
//! stays the longest, with the cache's decode lock and everything else it owns), and every call the interface makes still returns
//! at once: prepare (a newer request replacing the one running), poll, stop, scrub, play, reading, the counters, and closing.

mod support;

use std::time::{Duration, Instant};

use styk_core::audio::{MediaClock, Then};
use support::audio::*;

/// The longest any interface call may take while the worker is held. Generous: a held lock would be seconds.
const LIMIT: Duration = Duration::from_millis(250);

fn timed<T>(what: &str, worst: &mut Duration, call: impl FnOnce() -> T) -> T {
    let started = Instant::now();
    let value = call();
    let took = started.elapsed();
    *worst = (*worst).max(took);
    assert!(took < LIMIT, "{what} took {took:?} while the worker was held");
    value
}

#[test]
fn every_interface_call_returns_while_the_worker_is_held_inside_the_decoder() {
    let decoder = TestDecoder::new(Behavior::Gated);
    let audio = state(&[("a", b"not a wav", 1.0)], &[("a", 0.0, 0.0, 1.0, 1.0)]);
    let playable = state(&[("p", &tone(1.0), 1.0)], &[("p", 0.0, 0.0, 1.0, 1.0)]);
    let plan = plan_of(&playable, 0.0, 1.0);
    let mut rig = rig_with(config(), decoder.clone(), BIG, false);
    rig.transport.prepare(&audio, 0.0, 1.0, Then::Hold);
    let deadline = Instant::now() + Duration::from_secs(5);
    while decoder.calls.load(std::sync::atomic::Ordering::SeqCst) == 0 {
        assert!(Instant::now() < deadline, "the worker never reached the decoder");
        std::thread::sleep(Duration::from_millis(1));
    }
    let mut worst = Duration::ZERO;
    for round in 0..200u64 {
        timed("prepare", &mut worst, || rig.transport.prepare(&audio, 0.0, 1.0, Then::Hold));
        timed("poll", &mut worst, || rig.transport.poll());
        timed("scrub", &mut worst, || rig.transport.scrub(&audio, round as f64 * 0.001));
        timed("play", &mut worst, || rig.transport.play(plan.clone(), 0, 48_000));
        timed("reading", &mut worst, || rig.transport.reading());
        timed("media time", &mut worst, || rig.transport.media_time());
        timed("counters", &mut worst, || (rig.transport.underruns(), rig.transport.reclaim_backlog(), rig.transport.device_lost()));
        timed("stop", &mut worst, || rig.transport.stop());
        rig.fake.advance_ms(2);
    }
    println!("the slowest interface call took {worst:?} with the worker held");
    // Closing returns at once as well, with the worker still inside the decoder; the worker is freed to end afterwards.
    let transport = rig.transport;
    let started = Instant::now();
    drop(transport);
    assert!(started.elapsed() < LIMIT, "closing took {:?}", started.elapsed());
    decoder.open_gate();
}
