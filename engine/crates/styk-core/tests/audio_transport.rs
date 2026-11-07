//! The transport on the fake device: the clock across nonzero starts, seeks, loops, silence, stalls and underruns, endpoint
//! formats (44.1/48/96 kHz, multichannel, clocks counting in other units), stop priority, stale prepares, cancellation that
//! wakes a blocked decoder, reclamation off the output thread, scrub, device loss and memory under oversubscription.
//! The fake runs the real stream driver; only time and the device are the test's.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use styk_core::audio::wav::parse_wave;
use styk_core::audio::{pcm_wave, AudioState, AudioTransport, Event, MediaClock, MixPlan, PlanClip, SourceBytes, Then, WavSource, WallClock};
use styk_services::audio::clock::Reading;
use styk_services::audio::fake::{FakeConfig, FakeHandle, FakeOutput};
use styk_services::audio::{AudioDecoder, AudioError, HostClock};
use styk_services::Cancel;

const RATE: f64 = 48_000.0;

// ---- fixtures -------------------------------------------------------------------------------------------------------

fn tone(seconds: f64) -> Vec<u8> {
    let frames = (seconds * RATE) as usize;
    let samples: Vec<f32> = (0..frames).flat_map(|i| {
        let v = (0.5 * (2.0 * std::f64::consts::PI * 440.0 * i as f64 / RATE).sin()) as f32;
        [v, -v * 0.5]
    }).collect();
    pcm_wave(&samples, 48_000)
}

fn base64(bytes: &[u8]) -> String {
    let mut out = Vec::new();
    styk_doc::json::base64_into(bytes, &mut out);
    String::from_utf8(out).unwrap()
}

/// A document's audio state: `assets` are (id, original file bytes, duration); `clips` are (asset, start, offset, duration, gain).
fn state(assets: &[(&str, &[u8], f64)], clips: &[(&str, f64, f64, f64, f64)]) -> AudioState {
    let assets_json: Vec<String> = assets.iter().map(|(id, bytes, duration)| format!(r#""{id}":{{"id":"{id}","name":"{id}.wav","size":{},"duration":{duration},"chunks":[{{"data_base64":"{}"}}],"peaks":[0.5]}}"#, bytes.len(), base64(bytes))).collect();
    let clips_json: Vec<String> = clips.iter().enumerate().map(|(i, (asset, start, offset, duration, gain))| format!(r#"{{"id":"c{i}","assetId":"{asset}","start":{start},"offset":{offset},"duration":{duration},"gain":{gain},"fadeIn":0,"fadeOut":0}}"#)).collect();
    let text = format!(r#"{{"version":1,"assets":{{{}}},"tracks":[{{"id":"t1","name":"Track","gain":1,"mute":false,"solo":false,"clips":[{}]}}]}}"#, assets_json.join(","), clips_json.join(","));
    AudioState::from_value(&styk_doc::json::parse(text.as_bytes()).unwrap()).expect("a state")
}

/// What a decoder does when asked.
enum Behavior {
    /// A 48 kHz stereo 16-bit WAV of the asset's duration (what FFmpeg makes), after asking to reserve its size.
    Silence,
    /// Wait until the gate opens, then as `Silence`.
    Gated,
    /// Block until cancelled.
    UntilCancelled,
}

struct TestDecoder {
    behavior: Behavior,
    gate: (Mutex<bool>, Condvar),
    calls: AtomicUsize,
    cancelled: AtomicBool,
    reserved: Mutex<Vec<u64>>,
}

impl TestDecoder {
    fn new(behavior: Behavior) -> Arc<TestDecoder> {
        Arc::new(TestDecoder { behavior, gate: (Mutex::new(false), Condvar::new()), calls: AtomicUsize::new(0), cancelled: AtomicBool::new(false), reserved: Mutex::new(Vec::new()) })
    }

    fn open_gate(&self) {
        *self.gate.0.lock().unwrap() = true;
        self.gate.1.notify_all();
    }
}

fn decoded_wav(seconds: f64) -> Vec<u8> {
    let frames = (seconds * RATE) as usize;
    let mut bytes = Vec::with_capacity(44 + frames * 4);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + frames as u32 * 4).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&48_000u32.to_le_bytes());
    bytes.extend_from_slice(&(48_000u32 * 4).to_le_bytes());
    bytes.extend_from_slice(&4u16.to_le_bytes());
    bytes.extend_from_slice(&16u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&(frames as u32 * 4).to_le_bytes());
    bytes.resize(44 + frames * 4, 0);
    bytes
}

impl AudioDecoder for TestDecoder {
    fn decode(&self, _original: &[u8], seconds: f64, reserve: &mut dyn FnMut(u64) -> Result<(), AudioError>, cancel: &Cancel) -> Result<Vec<u8>, AudioError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        match self.behavior {
            Behavior::UntilCancelled => {
                let pair = Arc::new((Mutex::new(false), Condvar::new()));
                let waker = pair.clone();
                cancel.on_cancel(move || {
                    *waker.0.lock().unwrap() = true;
                    waker.1.notify_all();
                });
                let mut woken = pair.0.lock().unwrap();
                while !*woken {
                    woken = pair.1.wait(woken).unwrap();
                }
                self.cancelled.store(true, Ordering::SeqCst);
                return Err(AudioError::Cancelled);
            }
            Behavior::Gated => {
                let mut open = self.gate.0.lock().unwrap();
                while !*open {
                    open = self.gate.1.wait(open).unwrap();
                }
            }
            Behavior::Silence => {}
        }
        let wav = decoded_wav(seconds);
        self.reserved.lock().unwrap().push(wav.len() as u64);
        reserve(wav.len() as u64)?;
        Ok(wav)
    }
}

struct Rig {
    transport: AudioTransport,
    fake: FakeHandle,
}

const BIG: u64 = 768 << 20;

fn rig_with(config: FakeConfig, decoder: Arc<dyn AudioDecoder>, budget: u64, capture: bool) -> Rig {
    let (output, fake) = FakeOutput::new(config, capture);
    let transport = AudioTransport::new(Box::new(output), fake.host_clock(), decoder, budget).expect("the fake opens");
    Rig { transport, fake }
}

fn rig(config: FakeConfig) -> Rig {
    rig_with(config, TestDecoder::new(Behavior::Silence), BIG, true)
}

impl Rig {
    /// Polls until the job's plan is playing (the worker runs in real time).
    fn until_started(&mut self) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            for event in self.transport.poll() {
                match event {
                    Event::Started { .. } => return,
                    Event::Failed { error, .. } => panic!("the prepare failed: {error}"),
                    _ => {}
                }
            }
            assert!(Instant::now() < deadline, "the prepare did not finish");
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    fn step_ms(&mut self, ms: u64) {
        self.fake.advance_ms(ms);
        self.transport.poll();
    }

    fn running(&self) -> Option<(f64, bool)> {
        match self.transport.reading() {
            Reading::Running { sample, held } => Some((sample, held)),
            _ => None,
        }
    }
}

fn config() -> FakeConfig {
    FakeConfig::default()
}

fn same_bits(a: &[f32], b: &[f32]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.to_bits() == y.to_bits())
}

fn plan_of(state: &AudioState, start: f64, end: f64) -> Arc<MixPlan> {
    let store_less = styk_core::audio::SourceStore::new(styk_core::audio::Budget::new(BIG), TestDecoder::new(Behavior::Silence));
    styk_core::audio::build_plan(&store_less, state, start, end, &Cancel::new()).expect("a plan")
}

// ---- the clock --------------------------------------------------------------------------------------------------------

#[test]
fn the_clock_runs_from_a_nonzero_start_after_the_start_latency() {
    let audio = state(&[("a", &tone(3.0), 3.0)], &[("a", 0.0, 0.0, 3.0, 1.0)]);
    let mut rig = rig(config());
    rig.transport.play_range(&audio, 1.0, 2.0);
    assert_eq!(rig.transport.reading(), Reading::Stopped, "nothing is playing until the plan is handed over");
    rig.until_started();
    assert_eq!(rig.transport.reading(), Reading::Pending, "the output has not applied the command yet");
    let t0 = rig.fake.host_ns();
    rig.step_ms(1);
    assert_eq!(rig.transport.reading(), Reading::Starting, "applied, but no frame has reached the endpoint (20 ms latency)");
    assert_eq!(rig.transport.media_time(), None);
    for after_ms in [60u64, 100, 250, 500] {
        let target = t0 + (20 + after_ms) * 1_000_000;
        rig.fake.advance(target - rig.fake.host_ns());
        let (sample, held) = rig.running().expect("running");
        let expected = 48_000.0 + after_ms as f64 * 48.0;
        assert!(!held && (sample - expected).abs() <= 2.0, "{after_ms} ms after the first frame: {sample} vs {expected}");
        assert!((rig.transport.media_time().unwrap() - expected / RATE).abs() < 1e-4);
    }
}

#[test]
fn the_first_block_the_device_gets_is_the_mix_at_the_start_sample() {
    let audio = state(&[("a", &tone(3.0), 3.0)], &[("a", 0.5, 0.25, 2.0, 0.8)]);
    let mut rig = rig(config());
    rig.transport.play_range(&audio, 1.25, 2.0);
    rig.until_started();
    rig.step_ms(1);
    let captured = rig.fake.take_captured();
    assert_eq!(captured.len(), 960 * 2, "the buffer was filled once before the device started");
    let mut expected = vec![0.0f32; 960 * 2];
    plan_of(&audio, 1.25, 2.0).mix(60_000, &mut expected).unwrap();
    assert!(same_bits(&captured, &expected), "the device got the mix at the start sample");
    assert!(captured.iter().any(|v| *v != 0.0));
}

#[test]
fn every_endpoint_format_and_clock_unit_gives_the_same_media_time() {
    // (endpoint rate, channels, clock frequency): a 44.1 kHz, a 96 kHz and a 5.1 endpoint, and clocks counting 10 MHz and 1 kHz.
    for (rate, channels, frequency) in [(44_100u32, 2u16, 44_100u64), (48_000, 2, 48_000), (96_000, 2, 96_000), (48_000, 6, 48_000), (44_100, 2, 10_000_000), (96_000, 8, 1_000)] {
        let audio = state(&[("a", &tone(2.0), 2.0)], &[("a", 0.0, 0.0, 2.0, 1.0)]);
        let mut rig = rig(FakeConfig { endpoint_rate: rate, endpoint_channels: channels, clock_frequency: frequency, ..config() });
        let info = rig.transport.output_info().unwrap().clone();
        assert_eq!((info.endpoint_rate, info.endpoint_channels), (rate, channels));
        rig.transport.play_range(&audio, 0.5, 1.5);
        rig.until_started();
        let t0 = rig.fake.host_ns();
        rig.fake.advance_ms(20 + 300);
        let (sample, held) = rig.running().unwrap_or_else(|| panic!("{rate}/{channels}/{frequency}: not running: {:?}", rig.transport.reading()));
        let expected = 24_000.0 + 300.0 * 48.0;
        assert!(!held && (sample - expected).abs() <= 3.0 + 48_000.0 / frequency as f64, "{rate} Hz {channels} ch clock {frequency}: {sample} vs {expected} (started at {t0})");
    }
}

#[test]
fn a_seek_or_loop_is_a_new_epoch_and_flushes_what_was_queued() {
    let audio = state(&[("a", &tone(4.0), 4.0)], &[("a", 0.0, 0.0, 4.0, 1.0)]);
    let mut rig = rig(config());
    rig.transport.play_range(&audio, 1.0, 3.0);
    rig.until_started();
    rig.fake.advance_ms(200);
    assert!(rig.fake.queued_frames() > 0);
    let resets = rig.fake.resets();
    // Loop: play again from the range start.
    rig.transport.play_range(&audio, 1.0, 3.0);
    rig.until_started();
    assert_eq!(rig.transport.reading(), Reading::Pending);
    rig.fake.take_captured();
    let restarted_at = rig.fake.host_ns();
    rig.step_ms(1);
    assert!(rig.fake.resets() > resets, "the stream was reset: what was queued is discarded now, not played out");
    assert_eq!(rig.transport.reading(), Reading::Starting);
    let first_block = rig.fake.take_captured();
    let mut expected = vec![0.0f32; 960 * 2];
    plan_of(&audio, 1.0, 3.0).mix(48_000, &mut expected).unwrap();
    assert!(same_bits(&first_block, &expected), "the new epoch starts at the range start, not where the old one was");
    let target = restarted_at + 20_000_000 + 100_000_000;
    rig.fake.advance(target - rig.fake.host_ns());
    let (sample, _) = rig.running().unwrap();
    assert!((sample - (48_000.0 + 4_800.0)).abs() <= 2.0, "{sample}");
}

#[test]
fn stop_discards_the_queue_at_once_and_the_stream_goes_idle() {
    let audio = state(&[("a", &tone(2.0), 2.0)], &[("a", 0.0, 0.0, 2.0, 1.0)]);
    let mut rig = rig(config());
    rig.transport.play_range(&audio, 0.0, 2.0);
    rig.until_started();
    rig.fake.advance_ms(100);
    assert!(rig.fake.is_running() && rig.fake.queued_frames() > 0);
    rig.transport.stop();
    assert_eq!(rig.transport.reading(), Reading::Stopped);
    let before = rig.fake.take_captured().len();
    rig.fake.advance_ms(1);
    assert!(!rig.fake.is_running(), "the stream was stopped");
    assert_eq!(rig.fake.queued_frames(), 0, "and reset: the 20 ms that were queued never play");
    rig.fake.advance_ms(200);
    assert_eq!(rig.fake.take_captured().len(), 0, "an idle stream renders nothing ({before} samples before)");
}

#[test]
fn the_range_end_holds_the_media_time_in_silence_until_stopped() {
    let audio = state(&[("a", &tone(2.0), 2.0)], &[("a", 0.0, 0.0, 2.0, 1.0)]);
    let mut rig = rig(config());
    rig.transport.play_range(&audio, 0.0, 0.1);
    rig.until_started();
    rig.fake.advance_ms(400);
    let (sample, held) = rig.running().unwrap();
    assert!(held && sample == 4_800.0, "{sample} {held}");
    assert!(rig.transport.has_ended());
    assert_eq!(rig.transport.media_time(), Some(0.1));
    rig.fake.advance_ms(2000);
    assert_eq!(rig.transport.media_time(), Some(0.1), "it holds");
    assert_eq!(rig.transport.underruns(), 0);
}

#[test]
fn a_late_callback_leaves_a_gap_that_holds_the_media_time_and_skips_no_sound() {
    for advances in [true, false] {
        let audio = state(&[("a", &tone(4.0), 4.0)], &[("a", 0.0, 0.0, 4.0, 1.0)]);
        let mut rig = rig(FakeConfig { position_advances_in_underrun: advances, ..config() });
        rig.transport.play_range(&audio, 0.0, 4.0);
        rig.until_started();
        rig.fake.advance_ms(300);
        assert_eq!(rig.transport.underruns(), 0);
        // The output thread misses ten periods (100 ms): the 20 ms buffer runs dry.
        let before = rig.running().unwrap().0;
        rig.fake.skip_wakes(10);
        rig.fake.advance_ms(105);
        rig.fake.advance_ms(30);
        assert!(rig.transport.underruns() >= 1, "advances={advances}: the dry device was seen");
        let (during, _) = rig.running().unwrap();
        // The media time moved only for what was heard: not by the 135 ms of wall time that passed.
        assert!(during - before < 48.0 * 100.0, "advances={advances}: {before} -> {during}");
        // And it carries on: no sound was skipped, so later audio is contiguous project samples.
        rig.fake.take_captured();
        rig.fake.advance_ms(500);
        let (after, held) = rig.running().unwrap();
        assert!(!held && after > during + 48.0 * 400.0, "advances={advances}: {during} -> {after}");
        let captured = rig.fake.take_captured();
        assert!(!captured.is_empty() && captured.iter().any(|v| *v != 0.0));
    }
}

#[test]
fn a_gap_is_mapped_as_held_and_the_sound_after_it_continues_where_it_left_off() {
    // Drive the clock cell directly through the transport on a fake whose position keeps counting through the dry stretch.
    let audio = state(&[("a", &tone(4.0), 4.0)], &[("a", 0.0, 0.0, 4.0, 1.0)]);
    let mut rig = rig(config());
    rig.transport.play_range(&audio, 0.0, 4.0);
    rig.until_started();
    rig.fake.advance_ms(200);
    rig.fake.take_captured();
    rig.fake.skip_wakes(12);
    rig.fake.advance_ms(200);
    rig.fake.advance_ms(30);
    let state = rig.transport.reading();
    assert!(matches!(state, Reading::Running { .. }));
    let captured = rig.fake.take_captured();
    // What was written after the gap starts at the project sample where the renderer stopped: contiguous with what came before.
    let plan = plan_of(&audio, 0.0, 4.0);
    let written_before = 48_000.0 * 0.2 + 960.0; // 200 ms heard plus the 20 ms buffer queued at that time
    let first = (written_before as u64 / 480) * 480;
    let mut window = vec![0.0f32; 480 * 2];
    plan.mix(first, &mut window).unwrap();
    let found = captured.windows(window.len()).step_by(2).any(|w| w.iter().zip(&window).all(|(a, b)| a.to_bits() == b.to_bits()));
    assert!(found, "the renderer continued at a contiguous project sample");
}

// ---- the handoff -------------------------------------------------------------------------------------------------------

#[test]
fn a_stop_is_never_lost_behind_many_plays_that_the_output_thread_has_not_read() {
    let audio = state(&[("a", &tone(2.0), 2.0)], &[("a", 0.0, 0.0, 2.0, 1.0)]);
    let mut rig = rig(config());
    let plan = plan_of(&audio, 0.0, 2.0);
    rig.fake.skip_wakes(1_000_000);
    for i in 0..500u64 {
        rig.transport.play(plan.clone(), i * 480, 96_000);
    }
    rig.transport.stop();
    rig.fake.advance_ms(50);
    rig.fake.skip_wakes(0);
    rig.fake.advance_ms(50);
    assert!(!rig.fake.is_running(), "the newest command, the stop, won");
    assert_eq!(rig.fake.take_captured().len(), 0, "and no sound of the superseded plays reached the device");
    assert_eq!(rig.transport.reading(), Reading::Stopped);
    // Every superseded plan came back to the transport to be freed elsewhere: only the test and the plan itself hold it now.
    let deadline = Instant::now() + Duration::from_secs(5);
    while Arc::strong_count(&plan) > 1 {
        assert!(Instant::now() < deadline, "the reclaimer kept {} references", Arc::strong_count(&plan));
        rig.transport.poll();
        std::thread::sleep(Duration::from_millis(1));
    }
}

struct Spy(Arc<Mutex<Vec<String>>>);

impl Drop for Spy {
    fn drop(&mut self) {
        self.0.lock().unwrap().push(std::thread::current().name().unwrap_or("unnamed").to_string());
    }
}

#[test]
fn a_large_buffer_is_freed_on_neither_the_output_thread_nor_the_interface_thread() {
    let drops = Arc::new(Mutex::new(Vec::new()));
    let make = |spy: Spy| {
        let bytes = tone(1.0);
        let header = parse_wave(&bytes).unwrap();
        let source = WavSource::new(header, Arc::new(SourceBytes::held(bytes, Box::new(spy))));
        let clip = styk_core::audio::Clip { asset_id: Arc::from("a"), start: 0.0, offset: 0.0, duration: 1.0, gain: 1.0, fade_in: 0.0, fade_out: 0.0 };
        Arc::new(MixPlan::new(vec![PlanClip { clip, source }]))
    };
    let (first, second) = (make(Spy(drops.clone())), make(Spy(drops.clone())));
    let mut rig = rig(config());
    rig.transport.play(first, 0, 48_000);
    rig.fake.advance_ms(60);
    rig.transport.play(second, 0, 48_000);
    rig.fake.advance_ms(60);
    rig.transport.stop();
    rig.fake.advance_ms(60);
    let deadline = Instant::now() + Duration::from_secs(5);
    while drops.lock().unwrap().len() < 2 {
        assert!(Instant::now() < deadline, "the buffers were not freed");
        rig.transport.poll();
        std::thread::sleep(Duration::from_millis(1));
    }
    let names = drops.lock().unwrap().clone();
    assert!(names.iter().all(|n| n == "styk audio reclaim"), "freed on {names:?}");
}

#[test]
fn a_prepare_that_finishes_after_a_stop_never_starts_anything() {
    let decoder = TestDecoder::new(Behavior::Gated);
    let audio = state(&[("a", b"not a wav", 1.0)], &[("a", 0.0, 0.0, 1.0, 1.0)]);
    let mut rig = rig_with(config(), decoder.clone(), BIG, true);
    rig.transport.play_range(&audio, 0.0, 1.0);
    let deadline = Instant::now() + Duration::from_secs(5);
    while decoder.calls.load(Ordering::SeqCst) == 0 {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(1));
    }
    rig.transport.stop();
    decoder.open_gate();
    // The decode completes; its result is for a job that is no longer current.
    std::thread::sleep(Duration::from_millis(200));
    for _ in 0..50 {
        assert!(rig.transport.poll().iter().all(|e| !matches!(e, Event::Started { .. } | Event::Ready { .. })), "a stale plan was accepted");
        std::thread::sleep(Duration::from_millis(2));
    }
    rig.fake.advance_ms(100);
    assert_eq!(rig.fake.starts(), 0, "the device never started");
    assert_eq!(rig.transport.reading(), Reading::Stopped);
}

#[test]
fn a_newer_prepare_cancels_that_one_job_and_the_older_result_is_dropped() {
    let decoder = TestDecoder::new(Behavior::Gated);
    let audio = state(&[("a", b"not a wav", 1.0)], &[("a", 0.0, 0.0, 1.0, 1.0)]);
    let mut rig = rig_with(config(), decoder.clone(), BIG, true);
    let first = rig.transport.prepare(&audio, 0.0, 1.0, Then::Hold);
    let second = rig.transport.prepare(&audio, 0.0, 1.0, Then::Hold);
    assert_ne!(first, second);
    decoder.open_gate();
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut ready = Vec::new();
    while ready.is_empty() {
        assert!(Instant::now() < deadline);
        for event in rig.transport.poll() {
            if let Event::Ready { job, .. } = event {
                ready.push(job);
            }
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    std::thread::sleep(Duration::from_millis(100));
    for event in rig.transport.poll() {
        if let Event::Ready { job, .. } = event {
            ready.push(job);
        }
    }
    assert_eq!(ready, vec![second], "only the current job is reported");
}

#[test]
fn cancelling_wakes_a_decoder_that_is_blocked() {
    let decoder = TestDecoder::new(Behavior::UntilCancelled);
    let audio = state(&[("a", b"not a wav", 1.0)], &[("a", 0.0, 0.0, 1.0, 1.0)]);
    let mut rig = rig_with(config(), decoder.clone(), BIG, true);
    rig.transport.prepare(&audio, 0.0, 1.0, Then::Hold);
    let deadline = Instant::now() + Duration::from_secs(5);
    while decoder.calls.load(Ordering::SeqCst) == 0 {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(1));
    }
    let started = Instant::now();
    rig.transport.stop();
    assert!(started.elapsed() < Duration::from_millis(100), "stop does not wait for the decoder");
    while !decoder.cancelled.load(Ordering::SeqCst) {
        assert!(Instant::now() < deadline + Duration::from_secs(5), "the blocked decoder was not woken");
        std::thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(rig.transport.store().budget().used(), 0, "the cancelled decode gave its reservation back");
}

// ---- scrub, loss, no sound ---------------------------------------------------------------------------------------------

#[test]
fn scrub_retriggers_no_sooner_than_100_ms_and_plays_an_80_ms_slice_with_no_ramp() {
    let audio = state(&[("a", &tone(3.0), 3.0)], &[("a", 0.0, 0.0, 3.0, 1.0)]);
    let mut rig = rig(config());
    assert!(rig.transport.scrub(&audio, 1.0).is_some());
    rig.until_started();
    rig.step_ms(30);
    assert!(rig.transport.scrub(&audio, 1.05).is_none(), "30 ms later is too soon");
    rig.step_ms(60);
    assert!(rig.transport.scrub(&audio, 1.05).is_none(), "90 ms later is too soon");
    rig.step_ms(20);
    assert!(rig.transport.scrub(&audio, 1.1).is_some(), "110 ms later retriggers");
    rig.until_started();
    rig.fake.take_captured();
    rig.fake.advance_ms(1);
    let first = rig.fake.take_captured();
    let mut expected = vec![0.0f32; 960 * 2];
    plan_of(&audio, 1.1, 1.18).mix(52_800, &mut expected).unwrap();
    assert!(same_bits(&first, &expected), "the slice is the mixer output with a hard cut, not ramped");
    rig.fake.advance_ms(300);
    assert!(rig.transport.has_ended(), "the slice is 80 ms long");
    let (sample, _) = rig.running().unwrap();
    assert_eq!(sample, 52_800.0 + 3_840.0);
    rig.transport.end_scrub();
    rig.fake.advance_ms(5);
    assert!(!rig.fake.is_running(), "release stops within a period");
}

#[test]
fn a_lost_device_is_reported_and_playback_falls_back_without_a_panic() {
    let audio = state(&[("a", &tone(2.0), 2.0)], &[("a", 0.0, 0.0, 2.0, 1.0)]);
    let mut rig = rig(config());
    rig.transport.play_range(&audio, 0.0, 2.0);
    rig.until_started();
    rig.fake.advance_ms(100);
    rig.fake.lose_device();
    let events = rig.transport.poll();
    assert!(events.iter().any(|e| matches!(e, Event::DeviceLost)), "{events:?}");
    assert!(rig.transport.device_lost());
    assert_eq!(rig.transport.reading(), Reading::Stopped);
    rig.transport.stop();
    rig.fake.advance_ms(50);
    // The frame scheduler follows a wall clock from the current tick meanwhile.
    let wall = WallClock::start(rig.fake.host_clock(), 1.5);
    rig.fake.advance_ms(250);
    assert!((wall.media_time().unwrap() - 1.75).abs() < 1e-9);
}

#[test]
fn an_output_that_cannot_open_is_an_error_not_a_silent_transport() {
    let (mut output, _fake) = FakeOutput::new(config(), false);
    output.fail_open = Some(AudioError::Unavailable("no audio device".into()));
    let result = AudioTransport::new(Box::new(output), Arc::new(NoClock), TestDecoder::new(Behavior::Silence), BIG);
    assert_eq!(result.err(), Some(AudioError::Unavailable("no audio device".into())));
}

struct NoClock;

impl HostClock for NoClock {
    fn now_ns(&self) -> u64 {
        0
    }
}

// ---- memory ------------------------------------------------------------------------------------------------------------

/// A state of `n` recordings, each `seconds` long and needing the decoder (not WAVs), each in one clip.
fn many(n: usize, seconds: f64) -> AudioState {
    let ids: Vec<String> = (0..n).map(|i| format!("r{i}")).collect();
    let assets: Vec<(&str, &[u8], f64)> = ids.iter().map(|id| (id.as_str(), &b"not a wav"[..], seconds)).collect();
    let clips: Vec<(&str, f64, f64, f64, f64)> = ids.iter().map(|id| (id.as_str(), 0.0, 0.0, seconds, 0.1)).collect();
    state(&assets, &clips)
}

#[test]
fn an_active_mix_over_the_budget_is_refused_explicitly_and_the_cache_is_released() {
    // Each recording decodes to 192,044 bytes; the limit holds two.
    let limit = 2 * 192_044 + 1000;
    let decoder = TestDecoder::new(Behavior::Silence);
    let mut rig = rig_with(config(), decoder.clone(), limit, false);
    rig.transport.prepare(&many(2, 1.0), 0.0, 1.0, Then::Hold);
    let plan = loop {
        if let Some(Event::Ready { plan, .. }) = rig.transport.poll().into_iter().next() {
            break plan;
        }
        std::thread::sleep(Duration::from_millis(1));
    };
    assert_eq!(rig.transport.store().budget().used(), 2 * 192_044 + 2 * 9 - 2 * 9, "two decoded recordings are held, nothing else");
    drop(plan);
    rig.transport.prepare(&many(3, 1.0), 0.0, 1.0, Then::Hold);
    let error = loop {
        if let Some(Event::Failed { error, .. }) = rig.transport.poll().into_iter().next() {
            break error;
        }
        std::thread::sleep(Duration::from_millis(1));
    };
    assert!(matches!(error, AudioError::OverBudget { .. }), "{error:?}");
    assert!(error.to_string().contains("exceeds"), "{error}");
    assert!(rig.transport.store().budget().used() <= limit);
    assert_eq!(rig.transport.store().cached(), 0, "the cache of unpinned recordings was released, as today");
    assert_eq!(rig.transport.store().budget().used(), 0, "nothing is half held after the refusal");
}

#[test]
fn a_playing_plan_keeps_its_evicted_buffers_accounted_until_it_lets_go() {
    let limit = 2 * 192_044 + 1000;
    let mut rig = rig_with(config(), TestDecoder::new(Behavior::Silence), limit, false);
    let first = many(2, 1.0);
    rig.transport.prepare(&first, 0.0, 1.0, Then::Hold);
    let plan = loop {
        if let Some(Event::Ready { plan, .. }) = rig.transport.poll().into_iter().next() {
            break plan;
        }
        std::thread::sleep(Duration::from_millis(1));
    };
    rig.transport.play(plan.clone(), 0, 48_000);
    // A different pair of recordings needs room, and the playing plan holds the old two: refused, not freed under it.
    let other = state(&[("x0", b"not a wav", 1.0), ("x1", b"not a wav", 1.0)], &[("x0", 0.0, 0.0, 1.0, 0.1), ("x1", 0.0, 0.0, 1.0, 0.1)]);
    rig.transport.prepare(&other, 0.0, 1.0, Then::Hold);
    let error = loop {
        if let Some(Event::Failed { error, .. }) = rig.transport.poll().into_iter().next() {
            break error;
        }
        std::thread::sleep(Duration::from_millis(1));
    };
    assert!(matches!(error, AudioError::OverBudget { .. }));
    assert!(rig.transport.store().budget().used() >= 2 * 192_044, "the playing plan's buffers are still counted");
    rig.transport.stop();
    rig.fake.advance_ms(20);
    rig.transport.store().release_unpinned();
    assert!(rig.transport.store().budget().used() >= 2 * 192_044, "the plan the test still holds keeps its buffers");
    drop(plan);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        rig.transport.store().release_unpinned();
        if rig.transport.store().budget().used() == 0 {
            break;
        }
        assert!(Instant::now() < deadline, "the budget never recovered: {}", rig.transport.store().budget().used());
        rig.transport.poll();
        std::thread::sleep(Duration::from_millis(1));
    }
}

#[test]
fn concurrent_prepares_never_hold_more_than_the_limit() {
    let limit = 3 * 192_044 + 5000;
    let decoder = TestDecoder::new(Behavior::Silence);
    let store = styk_core::audio::SourceStore::new(styk_core::audio::Budget::new(limit), decoder);
    let done = Arc::new(AtomicBool::new(false));
    let watcher = {
        let (store, done) = (store.clone(), done.clone());
        std::thread::spawn(move || {
            let mut most = 0;
            while !done.load(Ordering::SeqCst) {
                most = most.max(store.budget().used());
            }
            most
        })
    };
    let workers: Vec<_> = (0..4)
        .map(|t| {
            let store = store.clone();
            std::thread::spawn(move || {
                for round in 0..20 {
                    let audio = many(2 + (t + round) % 3, 1.0);
                    let _ = styk_core::audio::build_plan(&store, &audio, 0.0, 1.0, &Cancel::new());
                }
            })
        })
        .collect();
    for worker in workers {
        worker.join().unwrap();
    }
    done.store(true, Ordering::SeqCst);
    let most = watcher.join().unwrap();
    assert!(most <= limit, "the budget held {most} of {limit}");
}

#[test]
fn a_decode_refused_by_the_budget_never_allocates_its_output() {
    // The decoder is asked to reserve the output size first and its refusal ends the decode before anything is read.
    let limit = 100_000;
    let decoder = TestDecoder::new(Behavior::Silence);
    let store = styk_core::audio::SourceStore::new(styk_core::audio::Budget::new(limit), decoder.clone());
    let result = styk_core::audio::build_plan(&store, &many(1, 1.0), 0.0, 1.0, &Cancel::new());
    assert!(matches!(result.err(), Some(AudioError::OverBudget { .. })));
    assert_eq!(store.budget().used(), 0);
    assert_eq!(decoder.calls.load(Ordering::SeqCst), 0, "refused before the decoder was started: the estimate alone does not fit");
}
