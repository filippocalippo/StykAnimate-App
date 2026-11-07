//! The FFmpeg audio decoder against the real bundled FFmpeg: today's arguments and output bytes, limits, a failed decode, the
//! budget asked before the output is read, cancellation and the timeout waking a child that never exits, and the temporary
//! folders. The bundled encoder is git-ignored: set `STYK_FFMPEG` or copy it to `build/video-encoder/ffmpeg.exe`. A missing
//! encoder fails these tests loudly; it never makes them pass.
#![cfg(windows)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use styk_platform::audio::FfmpegAudioDecoder;
use styk_services::audio::{AudioDecoder, AudioError};
use styk_services::Cancel;

fn ffmpeg() -> PathBuf {
    if let Some(path) = std::env::var_os("STYK_FFMPEG") {
        return PathBuf::from(path);
    }
    let mut here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    loop {
        let candidate = here.join("build/video-encoder/ffmpeg.exe");
        if candidate.is_file() {
            return candidate;
        }
        assert!(here.pop(), "the bundled FFmpeg was not found: set STYK_FFMPEG or copy it to build/video-encoder/ffmpeg.exe");
    }
}

fn scratch(name: &str) -> PathBuf {
    static N: AtomicU32 = AtomicU32::new(0);
    let dir = std::env::temp_dir().join(format!("styk-audio-test-{}-{}-{name}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A real MP3 of a one second 440 Hz tone, made by the bundled FFmpeg.
fn mp3(dir: &Path, seconds: f64) -> Vec<u8> {
    let path = dir.join("tone.mp3");
    let status = Command::new(ffmpeg())
        .args(["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i"])
        .arg(format!("sine=frequency=440:sample_rate=44100:duration={seconds}"))
        .args(["-c:a", "libmp3lame", "-b:a", "128k"])
        .arg(&path)
        .status()
        .expect("run FFmpeg");
    assert!(status.success(), "FFmpeg could not make a test MP3");
    std::fs::read(path).unwrap()
}

fn no_reserve() -> impl FnMut(u64) -> Result<(), AudioError> {
    |_| Ok(())
}

fn leftovers(root: &Path) -> Vec<String> {
    std::fs::read_dir(root).map(|d| d.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.starts_with("stykanimate-audio-")).collect()).unwrap_or_default()
}

#[test]
fn an_mp3_decodes_to_the_bytes_todays_desktop_service_makes() {
    let dir = scratch("bytes");
    let original = mp3(&dir, 1.0);
    let decoder = FfmpegAudioDecoder::new(ffmpeg(), dir.join("work"));
    let mut reserved = Vec::new();
    let decoded = decoder.decode(&original, 1.0, &mut |n| { reserved.push(n); Ok(()) }, &Cancel::new()).expect("decode");
    // Today's service: the same arguments, run once by hand on the same input.
    let input = dir.join("input.media");
    std::fs::write(&input, &original).unwrap();
    let reference = dir.join("reference.wav");
    let status = Command::new(ffmpeg()).args(FfmpegAudioDecoder::arguments(&input, &reference)).status().unwrap();
    assert!(status.success());
    assert_eq!(decoded, std::fs::read(&reference).unwrap(), "the decoded WAV is byte for byte what the service's command line makes");
    assert_eq!(reserved, vec![decoded.len() as u64], "the output was reserved once, before it was read");
    assert_eq!(&decoded[0..4], b"RIFF");
    // 48 kHz stereo 16-bit.
    assert_eq!((u16::from_le_bytes([decoded[22], decoded[23]]), u32::from_le_bytes(decoded[24..28].try_into().unwrap()), u16::from_le_bytes([decoded[34], decoded[35]])), (2, 48_000, 16));
    assert!(leftovers(&dir.join("work")).is_empty(), "the temporary folder is removed: {:?}", leftovers(&dir.join("work")));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn the_arguments_are_todays() {
    let args = FfmpegAudioDecoder::arguments(Path::new("in.media"), Path::new("out.wav"));
    assert_eq!(
        args.join(" "),
        "-hide_banner -loglevel error -nostdin -y -protocol_whitelist file,pipe -format_whitelist wav,mp3,flac,ogg,mov,matroska,webm,aac,aiff -i in.media -map 0:a:0 -vn -sn -dn -t 3600.001 -ar 48000 -ac 2 -c:a pcm_s16le -f wav out.wav"
    );
}

#[test]
fn a_recording_that_is_not_audio_fails_with_the_decoders_message_and_leaves_nothing() {
    let dir = scratch("garbage");
    let decoder = FfmpegAudioDecoder::new(ffmpeg(), dir.join("work"));
    let error = decoder.decode(b"this is not audio at all, just words", 1.0, &mut no_reserve(), &Cancel::new()).unwrap_err();
    let AudioError::Decode(message) = error else { panic!("{error:?}") };
    assert!(message.starts_with("This recording could not be decoded:"), "{message}");
    assert!(leftovers(&dir.join("work")).is_empty());
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn input_over_32_mib_is_refused_and_a_refusing_budget_ends_the_decode_before_the_output_is_read() {
    let dir = scratch("limits");
    let decoder = FfmpegAudioDecoder::new(ffmpeg(), dir.join("work"));
    let error = decoder.decode(&vec![0u8; 32 * 1024 * 1024 + 1], 1.0, &mut no_reserve(), &Cancel::new()).unwrap_err();
    assert_eq!(error, AudioError::Decode("Audio recordings must be at most 32 MiB.".into()));
    let original = mp3(&dir, 0.5);
    let refusal = AudioError::OverBudget { needed: 1, limit: 0 };
    let error = decoder.decode(&original, 0.5, &mut |_| Err(refusal.clone()), &Cancel::new()).unwrap_err();
    assert_eq!(error, refusal);
    assert!(leftovers(&dir.join("work")).is_empty());
    let _ = std::fs::remove_dir_all(dir);
}

/// A program that takes its arguments and never finishes (a decoder that hangs), for the waits.
fn hanging_program(dir: &Path) -> PathBuf {
    let path = dir.join("hang.cmd");
    std::fs::write(&path, "@echo off\r\nping -n 6 127.0.0.1 >nul\r\n").unwrap();
    path
}

#[test]
fn cancel_ends_a_child_that_never_exits_at_once() {
    let dir = scratch("cancel");
    let decoder = FfmpegAudioDecoder::new(hanging_program(&dir), dir.join("work"));
    let cancel = Cancel::new();
    let worker = {
        let cancel = cancel.clone();
        std::thread::spawn(move || {
            let started = Instant::now();
            let result = decoder.decode(b"anything", 1.0, &mut no_reserve(), &cancel);
            (result, started.elapsed())
        })
    };
    std::thread::sleep(Duration::from_millis(500));
    let cancelled_at = Instant::now();
    cancel.cancel();
    let (result, total) = worker.join().unwrap();
    assert_eq!(result.unwrap_err(), AudioError::Cancelled);
    assert!(cancelled_at.elapsed() < Duration::from_secs(1), "the wait woke at once: {:?} (the child would have run for 5 s, total {total:?})", cancelled_at.elapsed());
    assert!(leftovers(&dir.join("work")).is_empty());
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_cancel_before_the_decode_starts_runs_nothing() {
    let dir = scratch("early");
    let decoder = FfmpegAudioDecoder::new(hanging_program(&dir), dir.join("work"));
    let cancel = Cancel::new();
    cancel.cancel();
    assert_eq!(decoder.decode(b"anything", 1.0, &mut no_reserve(), &cancel).unwrap_err(), AudioError::Cancelled);
    assert!(!dir.join("work").exists() || leftovers(&dir.join("work")).is_empty());
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn the_timeout_ends_a_child_that_never_exits() {
    let dir = scratch("timeout");
    let decoder = FfmpegAudioDecoder::new(hanging_program(&dir), dir.join("work")).with_timeout(Duration::from_millis(300));
    let started = Instant::now();
    let error = decoder.decode(b"anything", 1.0, &mut no_reserve(), &Cancel::new()).unwrap_err();
    assert_eq!(error, AudioError::Decode("Audio decoding timed out.".into()));
    assert!(started.elapsed() < Duration::from_secs(3), "{:?}", started.elapsed());
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_missing_decoder_is_reported_not_hidden() {
    let dir = scratch("missing");
    let decoder = FfmpegAudioDecoder::new(dir.join("no-such-ffmpeg.exe"), dir.join("work"));
    assert!(matches!(decoder.decode(b"anything", 1.0, &mut no_reserve(), &Cancel::new()), Err(AudioError::Unavailable(_))));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn leftover_folders_of_a_run_that_ended_badly_are_swept() {
    let dir = scratch("sweep");
    let work = dir.join("work");
    let old = work.join("stykanimate-audio-dead-0");
    let fresh = work.join("stykanimate-audio-live-0");
    let other = work.join("keep-me");
    for folder in [&old, &fresh, &other] {
        std::fs::create_dir_all(folder).unwrap();
    }
    // Age the first folder two hours.
    let two_hours_ago = std::time::SystemTime::now() - Duration::from_secs(7200);
    use std::os::windows::fs::OpenOptionsExt;
    // A directory is opened with backup semantics on Windows.
    std::fs::OpenOptions::new().write(true).custom_flags(0x0200_0000).open(&old).unwrap().set_modified(two_hours_ago).unwrap();
    let _decoder = FfmpegAudioDecoder::new(ffmpeg(), &work);
    assert!(!old.exists(), "a folder of a dead run is removed");
    assert!(fresh.exists() && other.exists(), "a recent one (maybe another running instance) and a stranger are left alone");
    let _ = std::fs::remove_dir_all(dir);
}
