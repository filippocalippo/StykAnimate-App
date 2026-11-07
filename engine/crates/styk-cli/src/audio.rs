//! `styk audio <project> <out.wav> [--start <seconds>] [--duration <seconds>] [--ffmpeg <path>]`: mixes a project's soundtrack
//! to a 32-bit float stereo WAV the way the app mixes it for playback and export (the core's mixer, the bundled FFmpeg for
//! recordings that are not plain WAVs). Prints one JSON line: the clips, the frames and the SHA-256 of the written file.
//! The tool is how the mixer is held to today's `src/audio-pcm.mjs` end to end, from a saved project.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use sha2::{Digest, Sha256};
use styk_core::audio::{build_plan, pcm_wave, AudioState, Budget, OfflineMixer, SourceStore, CACHE_BYTES};
use styk_core::export::flow::AudioSource;
use styk_platform::audio::FfmpegAudioDecoder;
use styk_services::Cancel;

fn clock() -> f64 {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    START.get_or_init(std::time::Instant::now).elapsed().as_secs_f64() * 1000.0
}

struct Options {
    start: f64,
    duration: Option<f64>,
    ffmpeg: Option<PathBuf>,
}

fn options(rest: &[String]) -> Result<Options, String> {
    let mut options = Options { start: 0.0, duration: None, ffmpeg: std::env::var_os("STYK_FFMPEG").map(PathBuf::from) };
    let mut args = rest.iter();
    while let Some(flag) = args.next() {
        let mut value = |name: &str| args.next().cloned().ok_or_else(|| format!("{name} needs a value"));
        match flag.as_str() {
            "--start" => options.start = value("--start")?.parse().map_err(|_| "--start is seconds".to_string())?,
            "--duration" => options.duration = Some(value("--duration")?.parse().map_err(|_| "--duration is seconds".to_string())?),
            "--ffmpeg" => options.ffmpeg = Some(PathBuf::from(value("--ffmpeg")?)),
            other => return Err(format!("unknown option {other}")),
        }
    }
    if !(options.start >= 0.0) || options.duration.is_some_and(|d| !(d > 0.0)) {
        return Err("--start must be 0 or more and --duration above 0".into());
    }
    Ok(options)
}

pub fn audio(path: &str, out: &str, rest: &[String]) -> i32 {
    let options = match options(rest) {
        Ok(options) => options,
        Err(message) => {
            eprintln!("styk audio: {message}");
            return 2;
        }
    };
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) => {
            eprintln!("{path}: {error}");
            return 2;
        }
    };
    let name = Path::new(path).file_name().and_then(|n| n.to_str()).unwrap_or("document");
    let engine = styk_engine::Engine::new(clock, styk_engine::Budgets::for_device(None));
    let source = if name.to_ascii_lowercase().ends_with(".json") { styk_engine::document::OpenSource::Json { bytes: &bytes, name } } else { styk_engine::document::OpenSource::File { bytes: &bytes, name } };
    let opened = match engine.open_document(source, styk_engine::document::OpenOptions { layer_timeline: false }, &|| false) {
        Ok(opened) => opened,
        Err(error) => {
            println!("{{\"file\":{path:?},\"error\":{}}}", error.to_json());
            return 1;
        }
    };
    let Some(state) = AudioState::from_document(&opened.tree) else {
        eprintln!("{path}: the audio state is not in a shape this tool reads");
        return 1;
    };
    let duration = options.duration.unwrap_or_else(|| (state.end() - options.start).max(0.0));
    if !(duration > 0.0) {
        eprintln!("{path}: there is no audio after {} s", options.start);
        return 1;
    }
    let ffmpeg = options.ffmpeg.unwrap_or_else(|| PathBuf::from("ffmpeg.exe"));
    let decoder = FfmpegAudioDecoder::new(ffmpeg, std::env::temp_dir());
    let store = SourceStore::new(Budget::new(CACHE_BYTES), Arc::new(decoder));
    let plan = match build_plan(&store, &state, options.start, options.start + duration, &Cancel::new()) {
        Ok(plan) => plan,
        Err(error) => {
            eprintln!("{path}: {error}");
            return 1;
        }
    };
    let clips = plan.clips().len();
    let mut mixer = OfflineMixer::for_seconds(plan, options.start, duration);
    let (mut samples, mut chunk) = (Vec::new(), Vec::new());
    loop {
        match mixer.next_chunk(&mut chunk) {
            Ok(true) => samples.extend_from_slice(&chunk),
            Ok(false) => break,
            Err(error) => {
                eprintln!("{path}: {error}");
                return 1;
            }
        }
    }
    let wave = pcm_wave(&samples, 48_000);
    if let Err(error) = std::fs::write(out, &wave) {
        eprintln!("{out}: {error}");
        return 2;
    }
    let digest: String = Sha256::digest(&wave).iter().map(|b| format!("{b:02x}")).collect();
    println!("{{\"file\":{path:?},\"clips\":{clips},\"frames\":{},\"sha256\":\"{digest}\"}}", samples.len() / 2);
    0
}
