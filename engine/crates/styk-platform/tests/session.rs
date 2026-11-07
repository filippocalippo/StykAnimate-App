//! The FFmpeg session against the real bundled FFmpeg: destination checks before any frame, atomic replacement,
//! cancellation of every wait (a suspended encoder, a full pool, the finish, the audio pass), a commit that loses a
//! race, odd sizes, transparency and a stalled encoder that resumes. Skipped, loudly, where `build/video-encoder/ffmpeg.exe`
//! is not found (the encoder is git-ignored; copy it into the checkout's `build/video-encoder`).
#![cfg(windows)]

use std::fs;
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use styk_platform::video::FfmpegVideoService;
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

fn ffmpeg() -> Option<PathBuf> {
    let mut here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    loop {
        let candidate = here.join("build/video-encoder/ffmpeg.exe");
        if candidate.is_file() {
            return Some(candidate);
        }
        if !here.pop() {
            eprintln!("skipped: build/video-encoder/ffmpeg.exe not found");
            return None;
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
