//! The FFmpeg session against the real bundled FFmpeg: destination checks before any frame, atomic replacement,
//! cancellation of every wait (a suspended encoder, a full pool, the finish, the audio pass), a commit that loses a
//! race, odd sizes, transparency and a stalled encoder that resumes. These tests need `build/video-encoder/ffmpeg.exe`
//! (the encoder is git-ignored: copy it into the checkout's `build/video-encoder`); without it they **fail** with that
//! message, so a run without the encoder never counts as a pass.
#![cfg(windows)]

use std::fs;
use image::ImageEncoder;
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use styk_platform::video::{FfmpegVideoService, ReaderGate};
use styk_services::video::{Codec, Container, FfmpegRequest, Phase, Rate, VideoError, VideoRequest, VideoService, VideoSession};
use styk_services::Cancel;

#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtSuspendProcess(process: isize) -> i32;
    fn NtResumeProcess(process: isize) -> i32;
}
#[link(name = "kernel32")]
unsafe extern "system" {
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
    fn CloseHandle(handle: isize) -> i32;
}

fn suspend(pid: u32) {
    unsafe {
        let handle = OpenProcess(0x800, 0, pid);
        assert!(handle != 0, "open the encoder");
        NtSuspendProcess(handle);
        CloseHandle(handle);
    }
}

fn resume(pid: u32) {
    unsafe {
        let handle = OpenProcess(0x800, 0, pid);
        NtResumeProcess(handle);
        CloseHandle(handle);
    }
}

/// The bundled encoder. Panics, saying what to do, where it is not found: a missing encoder is a failed run, not a pass.
fn ffmpeg() -> Option<PathBuf> {
    let mut here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    loop {
        let candidate = here.join("build/video-encoder/ffmpeg.exe");
        if candidate.is_file() {
            return Some(candidate);
        }
        if !here.pop() {
            panic!("build/video-encoder/ffmpeg.exe was not found above {}: the video session tests need the bundled encoder (it is git-ignored). Copy it into this checkout's build/video-encoder and run again.", env!("CARGO_MANIFEST_DIR"));
        }
    }
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("styk-video-test-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn request(container: Container, codec: Codec, width: u32, height: u32, frames: u32) -> FfmpegRequest {
    FfmpegRequest { container, codec, width, height, fps: 16.0, total_frames: frames, rate: Rate { quality: 0.8, bitrate: None }, max_bytes: 1 << 30, audio: false }
}

/// A frame: a gradient and a block that moves with `index`, with `alpha` everywhere (or half of it clear).
fn frame(width: u32, height: u32, index: u32, alpha: u8, half_clear: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity((width * height * 4) as usize);
    for y in 0..height {
        for x in 0..width {
            let inside = x / 4 == (index * 3 + 2) % (width / 4 + 1);
            let a = if half_clear && x >= width / 2 { 0 } else { alpha };
            out.extend_from_slice(&[(x * 255 / width.max(1)) as u8, (y * 255 / height.max(1)) as u8, if inside { 255 } else { 40 }, a]);
        }
    }
    out
}

fn fill(session: &mut dyn VideoSession, frames: u32, make: &dyn Fn(u32) -> Vec<u8>) -> Result<(), VideoError> {
    for index in 0..frames {
        let mut buffer = session.acquire()?;
        buffer.bytes_mut().extend_from_slice(&make(index));
        session.submit(buffer)?;
    }
    Ok(())
}

fn stages(folder: &Path) -> Vec<String> {
    fs::read_dir(folder).unwrap().filter_map(Result::ok).map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.ends_with(".stage")).collect()
}

fn decoded_frames(ffmpeg: &Path, file: &Path, extra: &[&str]) -> (usize, String) {
    let mut args: Vec<&str> = vec!["-v", "info", "-hide_banner"];
    args.extend_from_slice(extra);
    let name = file.to_string_lossy().into_owned();
    args.extend(["-i", &name, "-map", "0:v:0", "-f", "framemd5", "-"]);
    let out = Command::new(ffmpeg).args(&args).output().unwrap();
    let lines = String::from_utf8_lossy(&out.stdout).lines().filter(|l| !l.starts_with('#')).count();
    (lines, String::from_utf8_lossy(&out.stderr).into_owned())
}

fn export(service: &FfmpegVideoService, dest: &Path, request: &FfmpegRequest, make: &dyn Fn(u32) -> Vec<u8>) -> Result<styk_services::video::Committed, VideoError> {
    let mut session = service.begin(dest, &VideoRequest::Ffmpeg(request.clone()), &Cancel::new())?;
    if let Err(error) = fill(&mut *session, request.total_frames, make) {
        session.abort();
        return Err(error);
    }
    session.finish()
}

#[test]
fn an_export_commits_and_leaves_no_stage() {
    let Some(ffmpeg) = ffmpeg() else { return };
    let dir = scratch("commit");
    let service = FfmpegVideoService::new(&ffmpeg);
    let dest = dir.join("out.mp4");
    let req = request(Container::Mp4, Codec::H264, 64, 36, 8);
    let done = export(&service, &dest, &req, &|i| frame(64, 36, i, 255, false)).unwrap();
    assert_eq!((done.frames, done.path.as_path()), (8, dest.as_path()));
    assert_eq!(decoded_frames(&ffmpeg, &dest, &[]).0, 8);
    assert!(stages(&dir).is_empty());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn only_yuv420p_codecs_pad_odd_sizes() {
    let Some(ffmpeg) = ffmpeg() else { return };
    let dir = scratch("odd");
    let service = FfmpegVideoService::new(&ffmpeg);
    for (container, codec, name, expected) in [
        (Container::Mp4, Codec::H264, "a.mp4", "66x34"),
        (Container::Mp4, Codec::Mpeg4, "b.mp4", "66x34"),
        (Container::Asf, Codec::Wmv2, "c.wmv", "66x34"),
        (Container::Webm, Codec::Vp9, "d.webm", "65x33"),
        (Container::Avi, Codec::Ffv1, "e.avi", "65x33"),
        (Container::Avi, Codec::Rawvideo, "f.avi", "65x33"),
    ] {
        let dest = dir.join(name);
        let req = request(container, codec, 65, 33, 3);
        export(&service, &dest, &req, &|i| frame(65, 33, i, 255, false)).unwrap();
        let (_, text) = decoded_frames(&ffmpeg, &dest, &[]);
        assert!(text.contains(expected) && !text.contains(&format!("{}x{}", 66, 33)), "{codec:?}: expected {expected}\n{text}");
    }
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn webm_keeps_the_alpha_plane_exactly() {
    let Some(ffmpeg) = ffmpeg() else { return };
    let dir = scratch("alpha");
    let service = FfmpegVideoService::new(&ffmpeg);
    let dest = dir.join("a.webm");
    let req = request(Container::Webm, Codec::Vp9, 64, 36, 4);
    export(&service, &dest, &req, &|i| frame(64, 36, i, 127, true)).unwrap();
    // The native VP9 decoder ignores the alpha side channel: force libvpx-vp9 before the input.
    let name = dest.to_string_lossy().into_owned();
    let out = Command::new(&ffmpeg).args(["-v", "error", "-c:v", "libvpx-vp9", "-i", &name, "-f", "rawvideo", "-pix_fmt", "rgba", "-"]).output().unwrap();
    assert_eq!(out.stdout.len(), 64 * 36 * 4 * 4);
    let alphas: std::collections::BTreeSet<u8> = out.stdout.chunks_exact(4).map(|p| p[3]).collect();
    assert_eq!(alphas.into_iter().collect::<Vec<_>>(), [0, 127], "the decoded alpha plane holds exactly the source values");
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_destination_that_cannot_be_written_is_refused_before_a_frame_and_leaves_nothing() {
    let Some(ffmpeg) = ffmpeg() else { return };
    let dir = scratch("denied");
    let service = FfmpegVideoService::new(&ffmpeg);
    let req = VideoRequest::Ffmpeg(request(Container::Mp4, Codec::H264, 64, 36, 2));
    // A folder the user may not write into (an ACL deny, as a read-only share or a protected folder gives).
    let user = std::env::var("USERNAME").unwrap();
    let denied = dir.join("locked");
    fs::create_dir(&denied).unwrap();
    assert!(Command::new("icacls").arg(&denied).arg("/deny").arg(format!("{user}:(WD,AD)")).output().unwrap().status.success());
    let started = Instant::now();
    let error = service.begin(&denied.join("out.mp4"), &req, &Cancel::new()).err().expect("refused");
    let took = started.elapsed();
    assert!(Command::new("icacls").arg(&denied).arg("/remove:d").arg(&user).output().unwrap().status.success());
    match error {
        VideoError::Destination { path, .. } => assert_eq!(path, denied),
        other => panic!("{other:?}"),
    }
    assert!(took < Duration::from_millis(200), "refused in {took:?}");
    assert!(stages(&denied).is_empty());

    // An existing destination another program holds without delete sharing: replacing it would fail after the encode.
    let held = dir.join("held.mp4");
    fs::write(&held, b"precious").unwrap();
    let lock = fs::OpenOptions::new().read(true).share_mode(1).open(&held).unwrap();
    let error = service.begin(&held, &req, &Cancel::new()).err().expect("refused");
    assert!(matches!(&error, VideoError::Destination { path, .. } if *path == held), "{error:?}");
    drop(lock);
    // A read-only file.
    let mut permissions = fs::metadata(&held).unwrap().permissions();
    permissions.set_readonly(true);
    fs::set_permissions(&held, permissions.clone()).unwrap();
    assert!(matches!(service.begin(&held, &req, &Cancel::new()).err(), Some(VideoError::Destination { .. })));
    permissions.set_readonly(false);
    fs::set_permissions(&held, permissions).unwrap();
    assert_eq!(fs::read(&held).unwrap(), b"precious");
    assert!(stages(&dir).is_empty());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_failed_export_leaves_the_existing_destination_untouched() {
    let Some(ffmpeg) = ffmpeg() else { return };
    let dir = scratch("atomic");
    let service = FfmpegVideoService::new(&ffmpeg);
    let dest = dir.join("out.mp4");
    fs::write(&dest, b"the previous export").unwrap();
    let req = request(Container::Mp4, Codec::H264, 640, 360, 8);
    let make = |i| frame(640, 360, i, 255, false);

    // The encoder is killed at half way.
    let mut session = service.begin(&dest, &VideoRequest::Ffmpeg(req.clone()), &Cancel::new()).unwrap();
    fill(&mut *session, 4, &make).unwrap();
    let pid = session.encoder_pid().unwrap();
    assert!(Command::new("taskkill").args(["/PID", &pid.to_string(), "/F"]).output().unwrap().status.success());
    let error = (|| {
        fill(&mut *session, 4, &make)?;
        Ok::<(), VideoError>(())
    })();
    let error = match error {
        Err(error) => {
            session.abort();
            error
        }
        Ok(()) => session.finish().err().expect("the killed encoder fails the export"),
    };
    assert!(matches!(error, VideoError::Encoder(_)), "{error:?}");
    assert_eq!(fs::read(&dest).unwrap(), b"the previous export");
    assert!(stages(&dir).is_empty(), "{:?}", stages(&dir));

    // Cancelled at half way.
    let cancel = Cancel::new();
    let mut session = service.begin(&dest, &VideoRequest::Ffmpeg(req.clone()), &cancel).unwrap();
    fill(&mut *session, 4, &make).unwrap();
    cancel.cancel();
    assert_eq!(fill(&mut *session, 4, &make), Err(VideoError::Cancelled));
    session.abort();
    assert_eq!(fs::read(&dest).unwrap(), b"the previous export");
    assert!(stages(&dir).is_empty());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_cancel_wakes_a_writer_blocked_on_a_suspended_encoder_and_the_producer_behind_it() {
    let Some(ffmpeg) = ffmpeg() else { return };
    let dir = scratch("suspended");
    let service = FfmpegVideoService::new(&ffmpeg);
    let dest = dir.join("out.mp4");
    let req = request(Container::Mp4, Codec::H264, 640, 360, 40);
    let cancel = Cancel::new();
    let mut session = service.begin(&dest, &VideoRequest::Ffmpeg(req), &cancel).unwrap();
    let pid = session.encoder_pid().unwrap();
    suspend(pid);
    let done = Arc::new(AtomicU32::new(0));
    let producer = {
        let done = done.clone();
        std::thread::spawn(move || {
            let result = fill(&mut *session, 40, &|i| frame(640, 360, i, 255, false));
            done.store(1, Ordering::SeqCst);
            (result, session)
        })
    };
    // The pipe fills, the writer blocks in its write, the pool empties and the producer waits for a buffer.
    std::thread::sleep(Duration::from_millis(800));
    assert_eq!(done.load(Ordering::SeqCst), 0, "the producer is blocked behind the suspended encoder");
    let asked = Instant::now();
    cancel.cancel();
    let (result, session) = producer.join().unwrap();
    let latency = asked.elapsed();
    assert_eq!(result, Err(VideoError::Cancelled));
    session.abort();
    assert!(stages(&dir).is_empty());
    assert!(latency < Duration::from_secs(1), "cancel took {latency:?}");
    println!("cancel latency with a suspended encoder: {latency:?}");
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_cancel_during_the_finish_ends_the_wait_for_the_encoder() {
    let Some(ffmpeg) = ffmpeg() else { return };
    let dir = scratch("finishing");
    let service = FfmpegVideoService::new(&ffmpeg);
    let dest = dir.join("out.mp4");
    let req = request(Container::Mp4, Codec::H264, 64, 36, 4);
    let cancel = Cancel::new();
    let mut session = service.begin(&dest, &VideoRequest::Ffmpeg(req), &cancel).unwrap();
    fill(&mut *session, 4, &|i| frame(64, 36, i, 255, false)).unwrap();
    let pid = session.encoder_pid().unwrap();
    suspend(pid);
    let progress = session.progress();
    let finishing = std::thread::spawn(move || session.finish());
    while progress.snapshot().phase != Phase::Finalizing {
        std::thread::yield_now();
    }
    std::thread::sleep(Duration::from_millis(300));
    assert!(!finishing.is_finished(), "waiting for the suspended encoder");
    let asked = Instant::now();
    cancel.cancel();
    assert_eq!(finishing.join().unwrap(), Err(VideoError::Cancelled));
    println!("cancel latency during the finish: {:?}", asked.elapsed());
    assert!(asked.elapsed() < Duration::from_secs(1));
    assert!(stages(&dir).is_empty());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_cancel_during_the_audio_pass_ends_it_and_removes_the_files() {
    let Some(ffmpeg) = ffmpeg() else { return };
    let dir = scratch("audio-pass");
    let service = FfmpegVideoService::new(&ffmpeg);
    let dest = dir.join("out.mp4");
    // 600 frames at 1 frame a second: ten minutes of sound, which takes a few seconds to encode.
    let mut req = request(Container::Mp4, Codec::H264, 16, 16, 600);
    req.fps = 1.0;
    req.audio = true;
    let cancel = Cancel::new();
    let mut session = service.begin(&dest, &VideoRequest::Ffmpeg(req.clone()), &cancel).unwrap();
    fill(&mut *session, 600, &|i| frame(16, 16, i, 255, false)).unwrap();
    let samples: Vec<f32> = (0..96_000).map(|n| ((n / 2) as f32 * 0.05).sin() * 0.5).collect();
    for _ in 0..600 {
        session.write_audio(&samples).unwrap();
    }
    let progress = session.progress();
    let finishing = std::thread::spawn(move || session.finish());
    while progress.snapshot().phase != Phase::Finalizing {
        std::thread::yield_now();
    }
    // Let the video pass end and the audio pass begin, then cancel it.
    while !fs::read_dir(&dir).unwrap().filter_map(Result::ok).any(|stage| stage.path().join("mix.f32").exists()) || progress.snapshot().encoded < 600 {
        std::thread::yield_now();
    }
    std::thread::sleep(Duration::from_millis(400));
    assert!(!finishing.is_finished(), "the audio pass is still running");
    let asked = Instant::now();
    cancel.cancel();
    assert_eq!(finishing.join().unwrap(), Err(VideoError::Cancelled));
    println!("cancel latency during the audio pass: {:?}", asked.elapsed());
    assert!(asked.elapsed() < Duration::from_secs(1));
    assert!(stages(&dir).is_empty());
    assert!(!dest.exists());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn sound_is_muxed_with_the_video_copied() {
    let Some(ffmpeg) = ffmpeg() else { return };
    let dir = scratch("audio");
    let service = FfmpegVideoService::new(&ffmpeg);
    let dest = dir.join("out.mp4");
    let mut req = request(Container::Mp4, Codec::H264, 64, 36, 16);
    req.audio = true;
    let mut session = service.begin(&dest, &VideoRequest::Ffmpeg(req.clone()), &Cancel::new()).unwrap();
    fill(&mut *session, 16, &|i| frame(64, 36, i, 255, false)).unwrap();
    let samples: Vec<f32> = (0..48_000 * 2).map(|n| ((n / 2) as f32 * 0.05).sin() * 0.5).collect();
    session.write_audio(&samples).unwrap();
    // One second is 16 frames at 16 fps: all of it was sent.
    session.finish().unwrap();
    let (frames, text) = decoded_frames(&ffmpeg, &dest, &[]);
    assert_eq!(frames, 16);
    assert!(text.contains("Audio: aac"), "{text}");
    assert!(stages(&dir).is_empty());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_commit_that_loses_a_race_keeps_the_finished_video_for_another_try() {
    let Some(ffmpeg) = ffmpeg() else { return };
    let dir = scratch("race");
    let service = FfmpegVideoService::new(&ffmpeg);
    let dest = dir.join("out.mp4");
    fs::write(&dest, b"old").unwrap();
    let req = request(Container::Mp4, Codec::H264, 64, 36, 4);
    let mut session = service.begin(&dest, &VideoRequest::Ffmpeg(req), &Cancel::new()).unwrap();
    // The probe passed; now another program opens the destination without delete sharing.
    let lock = fs::OpenOptions::new().read(true).share_mode(1).open(&dest).unwrap();
    fill(&mut *session, 4, &|i| frame(64, 36, i, 255, false)).unwrap();
    let error = session.finish().err().expect("the commit fails");
    let VideoError::CommitFailed { artifact, destination, .. } = error else { panic!("{error:?}") };
    assert_eq!(destination, dest);
    assert!(artifact.is_file() && artifact.metadata().unwrap().len() > 100, "the finished video is kept");
    assert_eq!(fs::read(&dest).unwrap(), b"old");
    assert_eq!(fs::read_dir(artifact.parent().unwrap()).unwrap().count(), 1, "only the finished file is kept in the stage");
    drop(lock);
    let done = service.retry_commit(&artifact, &dest).unwrap();
    assert_eq!(done.path, dest);
    assert_eq!(decoded_frames(&ffmpeg, &dest, &[]).0, 4);
    assert!(stages(&dir).is_empty());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn an_encoder_suspended_for_a_while_ends_in_the_same_bytes() {
    let Some(ffmpeg) = ffmpeg() else { return };
    let dir = scratch("stall");
    let service = FfmpegVideoService::new(&ffmpeg);
    let req = request(Container::Mp4, Codec::H264, 640, 360, 24);
    let make = |i| frame(640, 360, i, 255, false);
    let calm = dir.join("calm.mp4");
    export(&service, &calm, &req, &make).unwrap();
    let stalled = dir.join("stalled.mp4");
    let mut session = service.begin(&stalled, &VideoRequest::Ffmpeg(req.clone()), &Cancel::new()).unwrap();
    let pid = session.encoder_pid().unwrap();
    fill(&mut *session, 6, &make).unwrap();
    suspend(pid);
    let resumer = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(3));
        resume(pid);
    });
    for index in 6..24 {
        let mut buffer = session.acquire().unwrap();
        buffer.bytes_mut().extend_from_slice(&make(index));
        session.submit(buffer).unwrap();
    }
    session.finish().unwrap();
    resumer.join().unwrap();
    assert_eq!(fs::read(&calm).unwrap(), fs::read(&stalled).unwrap());
    fs::remove_dir_all(dir).unwrap();
}

/// The 8 random bytes of a WebM's TrackUID and of its Tags/Targets TagTrackUID (EBML ids 73 C5 and 63 C5, size 8):
/// the fields that differ between two runs of today's exporter on identical input.
fn blank_random_uids(mut file: Vec<u8>) -> Vec<u8> {
    for id in [[0x73, 0xc5, 0x88], [0x63, 0xc5, 0x88]] {
        let mut at = 0;
        while at + 11 <= file.len() {
            if file[at..at + 3] == id {
                file[at + 3..at + 11].fill(0);
                at += 11;
            } else {
                at += 1;
            }
        }
    }
    file
}

/// The session's frames (PNG images, as today's app sends them) and PNG frames fed to FFmpeg with today's arguments give the
/// same bytes, also at widths whose rows are not aligned.
#[test]
fn the_session_gives_the_bytes_of_png_frames_fed_to_ffmpeg_directly_also_at_unaligned_sizes() {
    use std::io::Write;
    use styk_platform::video::args::encoder_args;
    let Some(ffmpeg) = ffmpeg() else { return };
    let dir = scratch("png");
    let service = FfmpegVideoService::new(&ffmpeg);
    for (width, height) in [(65u32, 33u32), (161, 91), (160, 90)] {
        let req = request(Container::Webm, Codec::Vp9, width, height, 6);
        let make = |i| frame(width, height, i, 127, true);
        // Native: the session.
        let native = dir.join(format!("native-{width}.webm"));
        export(&service, &native, &req, &make).unwrap();
        // Today's: PNG frames into the same arguments.
        let today = dir.join(format!("today-{width}.webm"));
        let mut child = Command::new(&ffmpeg).args(encoder_args(&req, &today.to_string_lossy())).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().unwrap();
        let mut stdin = child.stdin.take().unwrap();
        for index in 0..6 {
            let mut png = Vec::new();
            image::codecs::png::PngEncoder::new(&mut png).write_image(&make(index), width, height, image::ExtendedColorType::Rgba8).unwrap();
            stdin.write_all(&png).unwrap();
        }
        drop(stdin);
        assert!(child.wait().unwrap().success());
        let (a, b) = (blank_random_uids(fs::read(&native).unwrap()), blank_random_uids(fs::read(&today).unwrap()));
        assert_eq!(a.len(), b.len(), "{width}x{height}");
        assert!(a == b, "{width}x{height}: {} bytes differ", a.iter().zip(&b).filter(|(x, y)| x != y).count());
    }
    fs::remove_dir_all(dir).unwrap();
}

/// The observation behind the PNG input: with `-f rawvideo` the same frames give different bytes at 65 by 33. If this
/// ever starts passing the other way, FFmpeg changed and the choice of input deserves another look.
#[test]
fn raw_video_input_differs_from_png_input_at_an_unaligned_size() {
    use std::io::Write;
    use styk_platform::video::args::encoder_args;
    let Some(ffmpeg) = ffmpeg() else { return };
    let dir = scratch("raw");
    let (width, height) = (65u32, 33u32);
    let req = request(Container::Webm, Codec::Vp9, width, height, 6);
    let make = |i| frame(width, height, i, 127, true);
    let run = |name: &str, raw: bool| {
        let out = dir.join(name);
        let mut args = encoder_args(&req, &out.to_string_lossy());
        if raw {
            let at = args.iter().position(|a| a == "image2pipe").unwrap();
            args.splice(at..at + 3, ["rawvideo", "-pix_fmt", "rgba", "-video_size"].map(String::from).into_iter().chain([format!("{width}x{height}")]));
        }
        let mut child = Command::new(&ffmpeg).args(args).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().unwrap();
        let mut stdin = child.stdin.take().unwrap();
        for index in 0..6 {
            if raw {
                stdin.write_all(&make(index)).unwrap();
            } else {
                let mut png = Vec::new();
                image::codecs::png::PngEncoder::new(&mut png).write_image(&make(index), width, height, image::ExtendedColorType::Rgba8).unwrap();
                stdin.write_all(&png).unwrap();
            }
        }
        drop(stdin);
        assert!(child.wait().unwrap().success());
        blank_random_uids(fs::read(out).unwrap())
    };
    assert_ne!(run("png.webm", false), run("raw.webm", true), "raw input is not equivalent to PNG input at this size");
    fs::remove_dir_all(dir).unwrap();
}

// ---------------------------------------------------------------------------------------------------------------------
// The review's and the checker's findings, each with the test that fails without its fix.

#[link(name = "kernel32")]
unsafe extern "system" {
    fn WaitForSingleObject(handle: isize, milliseconds: u32) -> u32;
}

/// Whether process `pid` ends within `milliseconds` (a bounded wait for a process that is expected to be killed).
fn ends_within(pid: u32, milliseconds: u32) -> bool {
    unsafe {
        let handle = OpenProcess(0x0010_0000 /* SYNCHRONIZE */, 0, pid);
        if handle == 0 {
            return true;
        }
        let ended = WaitForSingleObject(handle, milliseconds) == 0;
        CloseHandle(handle);
        ended
    }
}

/// Sets the modification time of a file or a folder (a folder needs backup semantics to be opened on Windows).
fn set_modified(path: &Path, time: std::time::SystemTime) {
    let mut options = fs::OpenOptions::new();
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_WRITE_ATTRIBUTES, full sharing, FILE_FLAG_BACKUP_SEMANTICS.
        options.access_mode(0x100).share_mode(7).custom_flags(0x0200_0000);
    }
    #[cfg(not(windows))]
    options.write(true);
    options.open(path).unwrap().set_modified(time).unwrap();
}

fn kill(pid: u32) {
    let _ = Command::new("taskkill").args(["/PID", &pid.to_string(), "/F"]).output();
}

/// Finding 4 of the review: the finish waited for the encoder's exit but not for the reader that collects its frame
/// count, so a slow reader turned a good export into a failure. Here the reader is held back until the encoder has gone.
#[test]
fn a_slow_progress_reader_does_not_fail_a_good_export() {
    let Some(ffmpeg) = ffmpeg() else { return };
    let dir = scratch("slow-reader");
    let gate = ReaderGate::new();
    let service = FfmpegVideoService::new(&ffmpeg).with_progress_reader_gate(gate.clone());
    let dest = dir.join("out.mp4");
    let req = request(Container::Mp4, Codec::H264, 64, 36, 4);
    let mut session = service.begin(&dest, &VideoRequest::Ffmpeg(req), &Cancel::new()).unwrap();
    let pid = session.encoder_pid().unwrap();
    fill(&mut *session, 4, &|i| frame(64, 36, i, 255, false)).unwrap();
    let (sender, result) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(session.finish());
    });
    assert!(ends_within(pid, 20_000), "the encoder finishes");
    // The encoder is gone and its last progress lines are unread: the finish must wait for them, not judge without them.
    assert!(result.recv_timeout(Duration::from_millis(700)).is_err(), "the finish judged the export before its progress was read");
    gate.open();
    let done = result.recv_timeout(Duration::from_secs(20)).expect("finished once the reader had read").expect("a good export");
    assert_eq!(done.frames, 4);
    assert_eq!(decoded_frames(&ffmpeg, &dest, &[]).0, 4);
    fs::remove_dir_all(dir).unwrap();
}

/// Finding 5 of the review: a finish that rejects the count joined the pipe writer before ending the encoder, and a
/// writer blocked on a suspended encoder never returns.
#[test]
fn a_finish_that_rejects_the_frame_count_does_not_hang_behind_a_blocked_writer() {
    let Some(ffmpeg) = ffmpeg() else { return };
    let dir = scratch("early-finish");
    let service = FfmpegVideoService::new(&ffmpeg);
    let dest = dir.join("out.mp4");
    let req = request(Container::Mp4, Codec::H264, 640, 360, 40);
    let mut session = service.begin(&dest, &VideoRequest::Ffmpeg(req), &Cancel::new()).unwrap();
    let pid = session.encoder_pid().unwrap();
    suspend(pid);
    fill(&mut *session, 3, &|i| frame(640, 360, i, 255, false)).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    let (sender, result) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(session.finish());
    });
    let outcome = result.recv_timeout(Duration::from_secs(10));
    // Whatever happened, do not leave the encoder suspended behind a failing test.
    resume(pid);
    kill(pid);
    let error = outcome.expect("the finish returned").err().expect("fewer frames than asked is refused");
    assert!(error.to_string().contains("Send every video frame"), "{error}");
    assert!(stages(&dir).is_empty());
    fs::remove_dir_all(dir).unwrap();
}

/// Finding 6 of the review: the probe tried to make a file in the stage, so a folder that allows subfolders but not files
/// passed it and the rename failed after the encode. The probe now moves a file from the stage into the folder.
#[test]
fn a_folder_that_takes_subfolders_but_not_files_is_refused_before_a_frame() {
    let Some(ffmpeg) = ffmpeg() else { return };
    let dir = scratch("no-files");
    let service = FfmpegVideoService::new(&ffmpeg);
    let req = VideoRequest::Ffmpeg(request(Container::Mp4, Codec::H264, 64, 36, 2));
    let user = std::env::var("USERNAME").unwrap();
    let folder = dir.join("folders-only");
    fs::create_dir(&folder).unwrap();
    // WD: add a file. AD (add a subfolder) stays allowed.
    assert!(Command::new("icacls").arg(&folder).arg("/deny").arg(format!("{user}:(WD)")).output().unwrap().status.success());
    let error = service.begin(&folder.join("out.mp4"), &req, &Cancel::new()).err();
    assert!(Command::new("icacls").arg(&folder).arg("/remove:d").arg(&user).output().unwrap().status.success());
    match error {
        Some(VideoError::Destination { path, .. }) => assert_eq!(path, folder),
        other => panic!("expected the folder to be refused, got {other:?}"),
    }
    assert!(stages(&folder).is_empty());
    fs::remove_dir_all(dir).unwrap();
}

/// Checker finding 2: the stage name followed the destination's, so names of about 226 characters failed.
#[test]
fn a_destination_name_of_226_characters_exports_and_a_name_too_long_is_refused_naming_the_file() {
    let Some(ffmpeg) = ffmpeg() else { return };
    let dir = scratch("long-name");
    let service = FfmpegVideoService::new(&ffmpeg);
    let req = request(Container::Mp4, Codec::H264, 64, 36, 3);
    let long = dir.join(format!("{}.mp4", "n".repeat(226)));
    export(&service, &long, &req, &|i| frame(64, 36, i, 255, false)).unwrap();
    assert_eq!(decoded_frames(&ffmpeg, &long, &[]).0, 3);
    let too_long = dir.join(format!("{}.mp4", "n".repeat(300)));
    match service.begin(&too_long, &VideoRequest::Ffmpeg(req), &Cancel::new()).err() {
        Some(VideoError::Destination { path, message }) => {
            assert_eq!(path, too_long, "the error names the file");
            assert!(message.contains("too long"), "{message}");
        }
        other => panic!("{other:?}"),
    }
    assert!(stages(&dir).is_empty());
    fs::remove_dir_all(dir).unwrap();
}

/// The driver of the hard-kill test below: it begins an export, prints its encoder's process id and waits to be killed.
/// Without `STYK_TEST_DRIVER_FOLDER` it does nothing.
#[test]
fn hard_kill_driver_role() {
    let Ok(folder) = std::env::var("STYK_TEST_DRIVER_FOLDER") else { return };
    let Some(ffmpeg) = ffmpeg() else { return };
    let service = FfmpegVideoService::new(&ffmpeg);
    let req = request(Container::Mp4, Codec::H264, 640, 360, 40);
    let mut session = service.begin(&Path::new(&folder).join("out.mp4"), &VideoRequest::Ffmpeg(req), &Cancel::new()).unwrap();
    fill(&mut *session, 2, &|i| frame(640, 360, i, 255, false)).unwrap();
    // On a line of its own: the test harness prints "test … ... " in front of the first line it sees.
    println!("\nENCODER_PID={}", session.encoder_pid().unwrap());
    use std::io::Write;
    std::io::stdout().flush().unwrap();
    loop {
        std::thread::park();
    }
}

/// Checker finding 3: a hard kill of the app (no destructor runs) left the encoder alive, a suspended one for good, and a
/// hidden stage folder with a partial file. Every encoder is in a job object that kills its members when the app's last
/// handle to it closes, and the next export to that folder sweeps a stage whose process is gone and which sat untouched
/// for today's two minutes.
#[test]
fn a_hard_killed_app_leaves_no_encoder_and_the_next_export_sweeps_its_stage() {
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;
    let Some(ffmpeg) = ffmpeg() else { return };
    let dir = scratch("hard-kill");
    let mut driver = Command::new(std::env::current_exe().unwrap())
        .args(["hard_kill_driver_role", "--exact", "--nocapture", "--test-threads=1"])
        .env("STYK_TEST_DRIVER_FOLDER", &dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(driver.stdout.take().unwrap()).lines();
    let pid: u32 = loop {
        let line = lines.next().expect("the driver ended before it began an export").unwrap();
        if let Some(pid) = line.strip_prefix("ENCODER_PID=") {
            break pid.parse().unwrap();
        }
    };
    suspend(pid);
    let driver_pid = driver.id();
    kill(driver_pid);
    let _ = driver.wait();
    let gone = ends_within(pid, 10_000);
    if !gone {
        resume(pid);
        kill(pid);
    }
    assert!(gone, "the encoder outlived the app that was killed");
    // The killed app could not clean up: its stage is still there, partial.
    let left = stages(&dir);
    assert_eq!(left.len(), 1, "{left:?}");
    // A fresh stage is not swept (it could belong to an export that has just begun elsewhere)...
    let service = FfmpegVideoService::new(&ffmpeg);
    let req = request(Container::Mp4, Codec::H264, 64, 36, 2);
    export(&service, &dir.join("first.mp4"), &req, &|i| frame(64, 36, i, 255, false)).unwrap();
    assert_eq!(stages(&dir), left, "a stage younger than the two minutes stays");
    // ...an abandoned one is.
    let old = std::time::SystemTime::now() - Duration::from_secs(3600);
    let stage = dir.join(&left[0]);
    for entry in fs::read_dir(&stage).unwrap().filter_map(Result::ok) {
        set_modified(&entry.path(), old);
    }
    set_modified(&stage, old);
    export(&service, &dir.join("second.mp4"), &req, &|i| frame(64, 36, i, 255, false)).unwrap();
    assert!(stages(&dir).is_empty(), "{:?}", stages(&dir));
    fs::remove_dir_all(dir).unwrap();
}
