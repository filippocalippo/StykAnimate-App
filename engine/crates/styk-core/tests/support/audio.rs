//! Shared fixtures of the audio tests: a tone, an audio state with embedded recordings, a decoder double, and a rig of a
//! transport on the fake device.
#![allow(dead_code)]

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use styk_core::audio::{pcm_wave, AudioState, AudioTransport, Event, MixPlan};
use styk_services::audio::clock::Reading;
use styk_services::audio::fake::{FakeConfig, FakeHandle, FakeOutput};
use styk_services::audio::{AudioDecoder, AudioError};
use styk_services::Cancel;

pub const RATE: f64 = 48_000.0;

// ---- fixtures -------------------------------------------------------------------------------------------------------

pub fn tone(seconds: f64) -> Vec<u8> {
    let frames = (seconds * RATE) as usize;
    let samples: Vec<f32> = (0..frames).flat_map(|i| {
        let v = (0.5 * (2.0 * std::f64::consts::PI * 440.0 * i as f64 / RATE).sin()) as f32;
        [v, -v * 0.5]
    }).collect();
    pcm_wave(&samples, 48_000)
}

pub fn base64(bytes: &[u8]) -> String {
    let mut out = Vec::new();
    styk_doc::json::base64_into(bytes, &mut out);
    String::from_utf8(out).unwrap()
}

/// A document's audio state: `assets` are (id, original file bytes, duration); `clips` are (asset, start, offset, duration, gain).
pub fn state(assets: &[(&str, &[u8], f64)], clips: &[(&str, f64, f64, f64, f64)]) -> AudioState {
    let assets_json: Vec<String> = assets.iter().map(|(id, bytes, duration)| format!(r#""{id}":{{"id":"{id}","name":"{id}.wav","size":{},"duration":{duration},"chunks":[{{"data_base64":"{}"}}],"peaks":[0.5]}}"#, bytes.len(), base64(bytes))).collect();
    let clips_json: Vec<String> = clips.iter().enumerate().map(|(i, (asset, start, offset, duration, gain))| format!(r#"{{"id":"c{i}","assetId":"{asset}","start":{start},"offset":{offset},"duration":{duration},"gain":{gain},"fadeIn":0,"fadeOut":0}}"#)).collect();
    let text = format!(r#"{{"version":1,"assets":{{{}}},"tracks":[{{"id":"t1","name":"Track","gain":1,"mute":false,"solo":false,"clips":[{}]}}]}}"#, assets_json.join(","), clips_json.join(","));
    AudioState::from_value(&styk_doc::json::parse(text.as_bytes()).unwrap()).expect("a state")
}

/// What a decoder does when asked.
pub enum Behavior {
    /// A 48 kHz stereo 16-bit WAV of the asset's duration (what FFmpeg makes), after asking to reserve its size.
    Silence,
    /// Wait until the gate opens, then as `Silence`.
    Gated,
}

pub struct TestDecoder {
    pub behavior: Behavior,
    pub gate: (Mutex<bool>, Condvar),
    pub calls: AtomicUsize,
    pub reserved: Mutex<Vec<u64>>,
}

impl TestDecoder {
    pub fn new(behavior: Behavior) -> Arc<TestDecoder> {
        Arc::new(TestDecoder { behavior, gate: (Mutex::new(false), Condvar::new()), calls: AtomicUsize::new(0), reserved: Mutex::new(Vec::new()) })
    }

    pub fn open_gate(&self) {
        *self.gate.0.lock().unwrap() = true;
        self.gate.1.notify_all();
    }
}

pub fn decoded_wav(seconds: f64) -> Vec<u8> {
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
    fn decode(&self, _original: &[u8], seconds: f64, reserve: &mut dyn FnMut(u64) -> Result<(), AudioError>, _cancel: &Cancel) -> Result<Vec<u8>, AudioError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        match self.behavior {
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

/// A spawner on plain threads, for the tests: `styk-core` must not reach `styk-platform`, where the real one lives.
pub struct TestSpawner;

impl styk_services::Spawner for TestSpawner {
    fn spawn(&self, name: &str, job: styk_services::Job) -> Result<(), styk_services::SpawnError> {
        std::thread::Builder::new().name(name.to_string()).spawn(job).map(|_| ()).map_err(|e| styk_services::SpawnError(e.to_string()))
    }
}

pub fn thread_spawner() -> Arc<dyn styk_services::Spawner> {
    Arc::new(TestSpawner)
}

pub struct Rig {
    pub transport: AudioTransport,
    pub fake: FakeHandle,
}

pub const BIG: u64 = 768 << 20;

pub fn rig_with(config: FakeConfig, decoder: Arc<dyn AudioDecoder>, budget: u64, capture: bool) -> Rig {
    let (output, fake) = FakeOutput::new(config, capture);
    let transport = AudioTransport::new(thread_spawner(), Box::new(output), fake.host_clock(), decoder, budget).expect("the fake opens");
    Rig { transport, fake }
}

pub fn rig(config: FakeConfig) -> Rig {
    rig_with(config, TestDecoder::new(Behavior::Silence), BIG, true)
}

impl Rig {
    /// Polls until the job's plan is playing (the worker runs in real time).
    pub fn until_started(&mut self) {
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

    pub fn step_ms(&mut self, ms: u64) {
        self.fake.advance_ms(ms);
        self.transport.poll();
    }

    pub fn running(&self) -> Option<(f64, bool)> {
        match self.transport.reading() {
            Reading::Running { sample, held } => Some((sample, held)),
            _ => None,
        }
    }
}

pub fn config() -> FakeConfig {
    FakeConfig::default()
}

pub fn same_bits(a: &[f32], b: &[f32]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.to_bits() == y.to_bits())
}

pub fn plan_of(state: &AudioState, start: f64, end: f64) -> Arc<MixPlan> {
    let store_less = styk_core::audio::SourceStore::new(styk_core::audio::Budget::new(BIG), TestDecoder::new(Behavior::Silence));
    styk_core::audio::build_plan(&store_less, state, start, end, &Cancel::new()).expect("a plan")
}

