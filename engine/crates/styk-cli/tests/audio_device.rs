//! The real WASAPI device on this machine: the endpoint format and the path taken, the clock against a loopback capture of the
//! same endpoint, a stress run under frame-preparation-like load, decoding and an export, and scrub latency with a time-coded
//! signal. They play through the default output device at about -34 dBFS and never for long, so they are `#[ignore]`d: run
//! them on purpose with
//!
//!     STYK_FFMPEG=<bundled ffmpeg.exe> cargo test --release -p styk-cli --features app-tools --test audio_device -- --ignored --nocapture --test-threads=1
//!
//! Each test prints its numbers (lines starting `AUDIO:`) and asserts the criteria of `docs/native/audio.md`.
#![cfg(all(windows, feature = "app-tools"))]

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::channel;
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use styk_core::audio::{pcm_wave, AudioState, AudioTransport, Event, MediaClock, OfflineMixer, Then};
use styk_platform::audio::{FfmpegAudioDecoder, QpcClock, WasapiOutput};
use styk_services::audio::clock::Reading;
use styk_services::audio::HostClock;
use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, WAVEFORMATEX,
};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED};

const RATE: f64 = 48_000.0;
/// -34 dBFS: audible only on a quiet desk.
const LEVEL: f32 = 0.02;

fn ffmpeg() -> PathBuf {
    PathBuf::from(std::env::var_os("STYK_FFMPEG").expect("set STYK_FFMPEG to the bundled ffmpeg.exe"))
}

// ---- sources ----------------------------------------------------------------------------------------------------------

/// Stereo 48 kHz float: a 2 ms 2 kHz click at every 100 ms.
fn click_track(seconds: f64) -> Vec<u8> {
    let frames = (seconds * RATE) as usize;
    let mut samples = vec![0.0f32; frames * 2];
    let mut at = 0;
    while at + 96 <= frames {
        for i in 0..96 {
            let window = 0.5 - 0.5 * (2.0 * std::f64::consts::PI * (i as f64 + 0.5) / 96.0).cos();
            let v = (LEVEL as f64 * window * (2.0 * std::f64::consts::PI * 2000.0 * i as f64 / RATE).sin()) as f32;
            samples[(at + i) * 2] = v;
            samples[(at + i) * 2 + 1] = v;
        }
        at += 4800;
    }
    pcm_wave(&samples, 48_000)
}

/// 20 ms slots, slot k at 600 + 200 * (k mod 20) Hz: the frequency says which slot is playing.
fn slot_track(seconds: f64) -> Vec<u8> {
    let frames = (seconds * RATE) as usize;
    let mut samples = vec![0.0f32; frames * 2];
    let mut phase = 0.0f64;
    for i in 0..frames {
        let slot = i / 960;
        let frequency = 600.0 + 200.0 * (slot % 20) as f64;
        phase += 2.0 * std::f64::consts::PI * frequency / RATE;
        let v = (LEVEL as f64 * phase.sin()) as f32;
        samples[i * 2] = v;
        samples[i * 2 + 1] = v;
    }
    pcm_wave(&samples, 48_000)
}

fn state(wav: &[u8], seconds: f64, clips: usize) -> AudioState {
    let mut encoded = Vec::new();
    styk_doc::json::base64_into(wav, &mut encoded);
    let clips_json: Vec<String> = (0..clips).map(|i| format!(r#"{{"id":"c{i}","assetId":"a","start":0,"offset":0,"duration":{seconds},"gain":{},"fadeIn":0,"fadeOut":0}}"#, 1.0 / clips as f64)).collect();
    let text = format!(
        r#"{{"version":1,"assets":{{"a":{{"id":"a","name":"a.wav","size":{},"duration":{seconds},"chunks":[{{"data_base64":"{}"}}],"peaks":[0.5]}}}},"tracks":[{{"id":"t1","name":"T","gain":1,"mute":false,"solo":false,"clips":[{}]}}]}}"#,
        wav.len(),
        String::from_utf8(encoded).unwrap(),
        clips_json.join(",")
    );
    AudioState::from_value(&styk_doc::json::parse(text.as_bytes()).unwrap()).unwrap()
}

fn transport() -> (AudioTransport, QpcClock) {
    transport_on(WasapiOutput::new().expect("an event"))
}

fn transport_on(output: WasapiOutput) -> (AudioTransport, QpcClock) {
    let work = std::env::temp_dir().join("styk-audio-device-test");
    let decoder = Arc::new(FfmpegAudioDecoder::new(ffmpeg(), work));
    let host = QpcClock::new();
    let transport = AudioTransport::new(Arc::new(styk_platform::spawn::ThreadSpawner), Box::new(output), Arc::new(host), decoder, 768 << 20).expect("the default audio endpoint opens");
    (transport, host)
}

fn until_started(transport: &mut AudioTransport) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        for event in transport.poll() {
            match event {
                Event::Started { .. } => return,
                Event::Failed { error, .. } => panic!("prepare failed: {error}"),
                _ => {}
            }
        }
        assert!(Instant::now() < deadline, "prepare did not finish");
        std::thread::sleep(Duration::from_millis(1));
    }
}

// ---- loopback capture of the same endpoint ------------------------------------------------------------------------------

struct Capture {
    rate: f64,
    /// (host ns of the packet's first frame, mono samples)
    packets: Vec<(u64, Vec<f32>)>,
}

struct Loopback {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<Capture>>,
}

impl Loopback {
    fn start() -> Loopback {
        let stop = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready) = channel::<()>();
        let flag = stop.clone();
        let thread = std::thread::spawn(move || unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).unwrap();
            let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole).unwrap();
            let client: IAudioClient = device.Activate(CLSCTX_ALL, None).unwrap();
            let mix = client.GetMixFormat().unwrap();
            let format: WAVEFORMATEX = std::ptr::read_unaligned(mix);
            let (channels, rate) = (format.nChannels as usize, format.nSamplesPerSec as f64);
            client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 10_000_000, 0, mix, None).unwrap();
            CoTaskMemFree(Some(mix as *const _));
            let capture: IAudioCaptureClient = client.GetService().unwrap();
            client.Start().unwrap();
            let _ = ready_tx.send(());
            let mut packets = Vec::new();
            while !flag.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(1));
                while capture.GetNextPacketSize().unwrap() > 0 {
                    let (mut data, mut frames, mut flags, mut qpc) = (std::ptr::null_mut(), 0u32, 0u32, 0u64);
                    capture.GetBuffer(&mut data, &mut frames, &mut flags, None, Some(&mut qpc)).unwrap();
                    let mono: Vec<f32> = if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 {
                        vec![0.0; frames as usize]
                    } else {
                        let all = std::slice::from_raw_parts(data as *const f32, frames as usize * channels);
                        all.chunks_exact(channels).map(|f| f.iter().sum::<f32>() / channels as f32).collect()
                    };
                    packets.push((qpc * 100, mono));
                    capture.ReleaseBuffer(frames).unwrap();
                }
            }
            let _ = client.Stop();
            CoUninitialize();
            Capture { rate, packets }
        });
        ready.recv().unwrap();
        Loopback { stop, thread: Some(thread) }
    }

    fn finish(mut self) -> Capture {
        self.stop.store(true, Ordering::SeqCst);
        self.thread.take().unwrap().join().unwrap()
    }
}

impl Capture {
    fn peak(&self) -> f32 {
        self.packets.iter().flat_map(|(_, p)| p.iter()).fold(0.0, |m, v| m.max(v.abs()))
    }

    /// Host times (ns) at which a click starts: the first sample past a quarter of the peak, 50 ms apart at least.
    fn clicks(&self) -> Vec<u64> {
        let threshold = self.peak() * 0.25;
        let mut found: Vec<u64> = Vec::new();
        for (qpc, samples) in &self.packets {
            for (i, v) in samples.iter().enumerate() {
                if v.abs() > threshold {
                    let at = qpc + (i as f64 * 1e9 / self.rate) as u64;
                    if found.last().is_none_or(|last| at > last + 50_000_000) {
                        found.push(at);
                    }
                }
            }
        }
        found
    }

    /// The mono samples from host time `from_ns` on, as many as `count`.
    fn window(&self, from_ns: u64, count: usize) -> Vec<f32> {
        let mut out = Vec::new();
        for (qpc, samples) in &self.packets {
            let end = qpc + (samples.len() as f64 * 1e9 / self.rate) as u64;
            if end <= from_ns {
                continue;
            }
            let skip = from_ns.saturating_sub(*qpc) as f64 * self.rate / 1e9;
            out.extend(samples.iter().skip(skip as usize));
            if out.len() >= count {
                break;
            }
        }
        out.truncate(count);
        out
    }
}

/// Media time (project samples) at host time `at`, interpolated between the readings sampled during the run.
fn media_at(readings: &[(u64, f64)], at: u64) -> Option<f64> {
    let after = readings.iter().position(|(t, _)| *t >= at)?;
    if after == 0 {
        return None;
    }
    let ((t0, m0), (t1, m1)) = (readings[after - 1], readings[after]);
    Some(m0 + (m1 - m0) * (at - t0) as f64 / (t1 - t0).max(1) as f64)
}

fn stats(values: &mut [f64]) -> (f64, f64, f64, f64) {
    values.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    let at = |q: f64| values[((values.len() - 1) as f64 * q).round() as usize];
    (mean, at(0.5), at(0.99), values[values.len() - 1])
}

/// Plays `[0, seconds)` of a click track and returns the readings sampled every ~2 ms and the loopback capture.
fn play_clicks(transport: &mut AudioTransport, host: &QpcClock, seconds: f64, during: &mut dyn FnMut()) -> (Vec<(u64, f64)>, Capture) {
    let audio = state(&click_track(seconds + 0.5), seconds + 0.5, 1);
    let capture = Loopback::start();
    transport.play_range(&audio, 0.0, seconds);
    until_started(transport);
    let mut readings = Vec::new();
    let end = Instant::now() + Duration::from_secs_f64(seconds + 0.3);
    while Instant::now() < end && !transport.has_ended() {
        transport.poll();
        if let Reading::Running { sample, held: false } = transport.reading() {
            readings.push((host.now_ns(), sample));
        }
        during();
        std::thread::sleep(Duration::from_millis(2));
    }
    transport.stop();
    std::thread::sleep(Duration::from_millis(100));
    (readings, capture.finish())
}

/// The error of the clock against the loopback, in ms, for every click heard.
fn click_errors(readings: &[(u64, f64)], capture: &Capture) -> Vec<f64> {
    capture
        .clicks()
        .iter()
        .filter_map(|&at| {
            let media = media_at(readings, at)?;
            let k = (media / 4800.0).round();
            Some((media - k * 4800.0) / RATE * 1000.0)
        })
        .collect()
}

// ---- the tests ----------------------------------------------------------------------------------------------------------

#[test]
#[ignore = "plays through the default output device"]
fn the_endpoint_opens_and_the_clock_advances_at_the_stream_rate() {
    let (mut transport, host) = transport();
    let info = transport.output_info().unwrap().clone();
    println!("AUDIO: endpoint {info:?}");
    let audio = state(&click_track(2.5), 2.5, 1);
    transport.play_range(&audio, 0.5, 2.0);
    until_started(&mut transport);
    let mut samples = Vec::new();
    let end = Instant::now() + Duration::from_millis(1200);
    while Instant::now() < end {
        transport.poll();
        if let Reading::Running { sample, .. } = transport.reading() {
            samples.push((host.now_ns(), sample));
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    assert!(samples.len() > 100, "the clock never started: {:?}", transport.reading());
    let ((t0, m0), (t1, m1)) = (samples[0], *samples.last().unwrap());
    let rate = (m1 - m0) / ((t1 - t0) as f64 / 1e9);
    println!("AUDIO: first reading {:.1} ms after the start (project 24000), rate {rate:.1} samples/s over {:.2} s, underruns {}", (m0 - 24000.0) / 48.0, (t1 - t0) as f64 / 1e9, transport.underruns());
    assert!((rate / RATE - 1.0).abs() < 0.005, "the media clock runs at {rate} samples per second");
    assert!(samples.windows(2).all(|w| w[1].1 >= w[0].1), "the media time never goes backwards");
    assert!(transport.media_time().unwrap() > 0.5);
    transport.stop();
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(transport.reading(), Reading::Stopped);
    assert_eq!(transport.underruns(), 0);
}

#[test]
#[ignore = "plays through the default output device"]
fn the_clock_agrees_with_a_loopback_capture_of_the_clicks() {
    let (mut transport, host) = transport();
    println!("AUDIO: endpoint {:?}", transport.output_info().unwrap());
    let (readings, capture) = play_clicks(&mut transport, &host, 4.0, &mut || {});
    let mut errors = click_errors(&readings, &capture);
    assert!(errors.len() >= 35, "only {} of 40 clicks were captured (peak {})", errors.len(), capture.peak());
    let (mean, median, p99, max) = stats(&mut errors);
    println!("AUDIO: clock minus loopback over {} clicks: mean {mean:.2} ms, median {median:.2}, p99 {p99:.2}, max {max:.2}; underruns {}", errors.len(), transport.underruns());
    let jitter = errors.iter().map(|e| (e - mean).abs()).fold(0.0, f64::max);
    println!("AUDIO: jitter around the mean (max) {jitter:.2} ms");
    assert!(mean.abs() < 30.0, "the clock is {mean} ms from what the loopback hears");
    assert!(jitter < 6.0, "the clock jitters {jitter} ms against the loopback");
    assert_eq!(transport.underruns(), 0);
}

#[test]
#[ignore = "plays through the default output device"]
fn playing_under_preparation_decoding_and_an_export_keeps_the_clock_and_the_sound() {
    let (mut transport, host) = transport();
    let stop = Arc::new(AtomicBool::new(false));
    let mut load: Vec<JoinHandle<()>> = Vec::new();
    // Frame preparation: floating-point work on most of the other cores.
    let cores = std::thread::available_parallelism().map_or(4, |n| n.get());
    for t in 0..cores.saturating_sub(2).max(2) {
        let stop = stop.clone();
        load.push(std::thread::spawn(move || {
            let mut x = 1.0f64 + t as f64;
            let mut buffer = vec![0.5f32; 1 << 20];
            while !stop.load(Ordering::Relaxed) {
                for v in buffer.iter_mut() {
                    x = (x * 1.000001).sin().abs() + 0.5;
                    *v = (*v * 0.999 + x as f32 * 0.001).fract();
                }
            }
        }));
    }
    // Decoding: FFmpeg turning an MP3 into WAV over and over.
    let work = std::env::temp_dir().join("styk-audio-device-stress");
    std::fs::create_dir_all(&work).unwrap();
    let mp3 = work.join("load.mp3");
    assert!(std::process::Command::new(ffmpeg()).args(["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=60", "-c:a", "libmp3lame"]).arg(&mp3).status().unwrap().success());
    let decoded_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    {
        let (stop, count, original) = (stop.clone(), decoded_count.clone(), std::fs::read(&mp3).unwrap());
        let decoder = FfmpegAudioDecoder::new(ffmpeg(), work.join("decode"));
        load.push(std::thread::spawn(move || {
            use styk_services::audio::AudioDecoder;
            while !stop.load(Ordering::Relaxed) {
                if decoder.decode(&original, 60.0, &mut |_| Ok(()), &styk_services::Cancel::new()).is_ok() {
                    count.fetch_add(1, Ordering::SeqCst);
                }
            }
        }));
    }
    // An export: the offline mixer over 32 voices written to disk.
    let exported = Arc::new(std::sync::atomic::AtomicU64::new(0));
    {
        let (stop, exported, file) = (stop.clone(), exported.clone(), work.join("export.f32"));
        let plan = {
            let audio = state(&click_track(10.0), 10.0, 32);
            let store = styk_core::audio::SourceStore::new(styk_core::audio::Budget::new(768 << 20), Arc::new(FfmpegAudioDecoder::new(ffmpeg(), work.join("export-decode"))));
            styk_core::audio::build_plan(&store, &audio, 0.0, 10.0, &styk_services::Cancel::new()).unwrap()
        };
        load.push(std::thread::spawn(move || {
            use std::io::Write;
            use styk_core::export::flow::AudioSource;
            while !stop.load(Ordering::Relaxed) {
                let mut mixer = OfflineMixer::for_seconds(plan.clone(), 0.0, 10.0);
                let mut out = std::fs::File::create(&file).unwrap();
                let mut chunk = Vec::new();
                while !stop.load(Ordering::Relaxed) && mixer.next_chunk(&mut chunk).unwrap() {
                    let bytes: Vec<u8> = chunk.iter().flat_map(|v| v.to_le_bytes()).collect();
                    out.write_all(&bytes).unwrap();
                    exported.fetch_add(bytes.len() as u64, Ordering::SeqCst);
                }
            }
        }));
    }
    std::thread::sleep(Duration::from_millis(500));
    let started = Instant::now();
    let (readings, capture) = play_clicks(&mut transport, &host, 5.0, &mut || {});
    let seconds = started.elapsed().as_secs_f64();
    stop.store(true, Ordering::SeqCst);
    for thread in load {
        thread.join().unwrap();
    }
    let mut errors = click_errors(&readings, &capture);
    let heard = errors.len();
    let clicks = capture.clicks();
    let intervals: Vec<f64> = clicks.windows(2).map(|w| (w[1] - w[0]) as f64 / 1e6).collect();
    let worst_interval = intervals.iter().map(|i| (i - 100.0).abs()).fold(0.0, f64::max);
    let heard_clicks: Vec<i64> = clicks.iter().filter_map(|&at| media_at(&readings, at)).map(|m| (m / 4800.0).round() as i64).collect();
    let missing: Vec<i64> = (0..50).filter(|k| !heard_clicks.contains(k)).collect();
    println!("AUDIO: clicks not heard (index of 50): {missing:?}");
    let (mean, _, p99, max) = stats(&mut errors);
    println!(
        "AUDIO: stress over {seconds:.1} s with {} busy threads, {} decodes and {:.0} MB exported: {heard} clicks heard of 50, worst click interval error {worst_interval:.2} ms, clock minus loopback mean {mean:.2} ms p99 {p99:.2} max {max:.2}, underruns {}",
        cores.saturating_sub(2).max(2),
        decoded_count.load(Ordering::SeqCst),
        exported.load(Ordering::SeqCst) as f64 / 1e6,
        transport.underruns()
    );
    assert!(decoded_count.load(Ordering::SeqCst) >= 1 && exported.load(Ordering::SeqCst) > 10_000_000, "the load really ran");
    assert!(heard >= 48, "{heard} of 50 clicks");
    assert!(worst_interval < 3.0, "a click arrived {worst_interval} ms off the 100 ms grid");
    assert!(max - mean < 8.0, "the clock jumped {} ms against the loopback", max - mean);
    assert_eq!(transport.underruns(), 0);
}

/// The frequency of the first 15 ms of `samples`, from its zero crossings.
fn frequency(samples: &[f32], rate: f64) -> f64 {
    let n = (0.015 * rate) as usize;
    let crossings = samples[..n.min(samples.len())].windows(2).filter(|w| (w[0] < 0.0) != (w[1] < 0.0)).count();
    crossings as f64 / 2.0 / (n as f64 / rate)
}

#[test]
#[ignore = "plays through the default output device"]
fn scrub_latency_and_position_with_a_time_coded_signal() {
    let (mut transport, host) = transport();
    let audio = state(&slot_track(12.0), 12.0, 1);
    // Warm: the first prepare decodes and caches the recording, like a scrub gesture that has begun.
    transport.play_range(&audio, 0.0, 0.1);
    until_started(&mut transport);
    std::thread::sleep(Duration::from_millis(300));
    transport.stop();
    std::thread::sleep(Duration::from_millis(100));
    let capture = Loopback::start();
    let mut calls = Vec::new();
    for slot in [100u64, 237, 311, 415, 503, 577] {
        let time = slot as f64 * 0.02;
        let called = host.now_ns();
        let job = transport.scrub(&audio, time).expect("not throttled");
        until_started(&mut transport);
        let _ = job;
        calls.push((called, slot));
        std::thread::sleep(Duration::from_millis(250));
        transport.end_scrub();
        std::thread::sleep(Duration::from_millis(150));
    }
    let capture = capture.finish();
    let mut latencies = Vec::new();
    let mut position_errors = 0;
    for (called, slot) in &calls {
        // Relative to the level the signal was written at, not to the capture peak (other programs may sound on the endpoint).
        let threshold = LEVEL * 0.25;
        let onset = capture.packets.iter().filter(|(q, p)| *q + (p.len() as f64 * 1e9 / capture.rate) as u64 > *called).find_map(|(q, p)| p.iter().position(|v| v.abs() > threshold).map(|i| q + (i as f64 * 1e9 / capture.rate) as u64)).unwrap_or_else(|| panic!("scrub to slot {slot} made no sound at the loopback (capture peak {}, {} packets)", capture.peak(), capture.packets.len()));
        latencies.push((onset - called) as f64 / 1e6);
        let heard = frequency(&capture.window(onset, 800), capture.rate);
        let expected = 600.0 + 200.0 * (*slot % 20) as f64;
        if (heard - expected).abs() > 150.0 {
            position_errors += 1;
            println!("AUDIO: scrub to slot {slot}: heard {heard:.0} Hz, expected {expected:.0} Hz");
        }
    }
    let (mean, median, _, max) = stats(&mut latencies.clone());
    println!("AUDIO: scrub call to first sound at the loopback: {latencies:.1?} ms (mean {mean:.1}, median {median:.1}, max {max:.1}); wrong slots {position_errors} of 6");
    assert_eq!(position_errors, 0, "a scrub slice started at the wrong place");
    assert!(max < 120.0, "scrub latency {max} ms");
    let _ = Then::Hold;
}

#[test]
#[ignore = "plays through the default output device"]
fn the_converted_path_the_system_resampling_keeps_the_clock_as_well() {
    let (mut transport, host) = transport_on(WasapiOutput::converted_only().expect("an event"));
    let info = transport.output_info().unwrap().clone();
    println!("AUDIO: converted path {info:?}");
    assert_eq!(info.path, styk_services::audio::Path::Converted);
    let (readings, capture) = play_clicks(&mut transport, &host, 3.0, &mut || {});
    let mut errors = click_errors(&readings, &capture);
    assert!(errors.len() >= 25, "only {} clicks", errors.len());
    let (mean, median, p99, max) = stats(&mut errors);
    let jitter = errors.iter().map(|e| (e - mean).abs()).fold(0.0, f64::max);
    println!("AUDIO: converted path, clock minus loopback over {} clicks: mean {mean:.2} ms, median {median:.2}, p99 {p99:.2}, max {max:.2}, jitter {jitter:.2}; underruns {}", errors.len(), transport.underruns());
    assert!(mean.abs() < 40.0 && jitter < 6.0, "mean {mean} jitter {jitter}");
    assert_eq!(transport.underruns(), 0);
}
