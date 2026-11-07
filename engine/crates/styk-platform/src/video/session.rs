//! One export running in an encoder process: the frames go down its standard input from a writer thread, a reader
//! thread follows its progress, and the finish waits for it, adds the sound and moves the result over the destination.
//!
//! Every wait is an event wait: the writer blocks in the pipe write (ended by the process ending), the producer in the
//! frame pool (woken by the cancel), the finish in [`ChildGuard::wait`] (ended by the process ending). The
//! [`Cancel`] kills the process, which wakes all three. No timer.

use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;

use styk_services::video::{
    audio_bytes, Committed, FfmpegRequest, FrameBuf, FrameLayout, FramePool, Phase, Progress, VfwRequest, VideoError, VideoSession, VFW_MAX_OUTPUT_BYTES,
};
use styk_services::Cancel;

use super::args;
use super::json::{json_number, json_text};
use super::pixels::rgba_to_bgr24;
use super::process::{self, ChildGuard};
use super::staging::{self, CommitError, Stage};

/// Frame buffers in flight between the producer and the pipe.
pub(crate) const POOL: usize = 3;

pub(crate) enum Kind {
    Ffmpeg(FfmpegRequest),
    Vfw(VfwRequest),
}

/// What the reader threads learn, shared with the session and the writer.
#[derive(Default)]
struct Shared {
    failure: Mutex<Option<Failure>>,
    stderr: Mutex<(String, bool)>,
    stderr_done: Condvar,
    vfw: Mutex<VfwEvents>,
}

#[derive(Default)]
struct VfwEvents {
    ready_mismatch: bool,
    completed_frames: Option<u64>,
    error: Option<String>,
    oversized: bool,
}

#[derive(Clone)]
enum Failure {
    /// The pipe broke: the encoder is gone or going.
    Pipe,
    /// A message of the encoder's or of ours.
    Message(String),
}

impl Shared {
    fn fail(&self, failure: Failure) {
        let mut slot = self.failure.lock().unwrap_or_else(|e| e.into_inner());
        slot.get_or_insert(failure);
    }

    fn failed(&self) -> bool {
        self.failure.lock().unwrap_or_else(|e| e.into_inner()).is_some()
    }
}

pub(crate) struct Session {
    kind: Kind,
    program: PathBuf,
    layout: FrameLayout,
    pool: FramePool,
    tx: Option<Sender<FrameBuf>>,
    writer: Option<JoinHandle<()>>,
    /// The reader of the encoder's standard error and the one of its standard output, which the finish joins before it
    /// trusts the counters and terminal events the second one collected.
    stderr_reader: Option<JoinHandle<()>>,
    stdout_reader: Option<JoinHandle<()>>,
    child: ChildGuard,
    shared: Arc<Shared>,
    stage: Stage,
    output: PathBuf,
    destination: PathBuf,
    cancel: Cancel,
    progress: Arc<Progress>,
    submitted: u32,
    audio: Option<(File, u64)>,
    total_frames: u32,
}

fn tail(text: &str, max: usize) -> String {
    let mut start = text.len().saturating_sub(max);
    while !text.is_char_boundary(start) {
        start += 1;
    }
    text[start..].to_string()
}

/// Holds the reader of the encoder's standard output back until opened. Tests use it to make that reader slower than the
/// encoder; it is an event, not a delay.
#[derive(Clone, Default)]
pub struct ReaderGate(Arc<(Mutex<bool>, Condvar)>);

impl ReaderGate {
    pub fn new() -> ReaderGate {
        ReaderGate::default()
    }

    pub fn open(&self) {
        *self.0 .0.lock().unwrap_or_else(|e| e.into_inner()) = true;
        self.0 .1.notify_all();
    }

    fn wait(&self) {
        let mut open = self.0 .0.lock().unwrap_or_else(|e| e.into_inner());
        while !*open {
            open = self.0 .1.wait(open).unwrap_or_else(|e| e.into_inner());
        }
    }
}

impl Session {
    /// Starts `program` with `args` for the export of `kind`, writing `output` inside `stage`.
    pub(crate) fn start(program: &Path, arguments: Vec<String>, kind: Kind, layout: FrameLayout, stage: Stage, output: PathBuf, destination: &Path, cancel: &Cancel, gate: Option<ReaderGate>) -> Result<Session, VideoError> {
        let mut command = Command::new(program);
        command.args(&arguments);
        let (child, mut pipes) = process::spawn(&mut command, true).map_err(|e| VideoError::Unavailable(format!("Native video encoder could not start: {e}")))?;
        {
            let killer = child.clone();
            cancel.on_cancel(move || killer.terminate());
        }
        let shared = Arc::new(Shared::default());
        let progress = Arc::new(Progress::default());
        progress.set_phase(Phase::Preflight);
        let pool = FramePool::new(POOL, layout.bytes, cancel);
        let total_frames = match &kind {
            Kind::Ffmpeg(r) => r.total_frames,
            Kind::Vfw(r) => r.total_frames,
        };

        let stderr = pipes.stderr.take().expect("piped stderr");
        let stderr_reader = {
            let shared = shared.clone();
            std::thread::spawn(move || {
                let mut stderr = stderr;
                let mut buffer = [0u8; 4096];
                while let Ok(n) = stderr.read(&mut buffer) {
                    if n == 0 {
                        break;
                    }
                    let mut ring = shared.stderr.lock().unwrap_or_else(|e| e.into_inner());
                    ring.0.push_str(&String::from_utf8_lossy(&buffer[..n]));
                    ring.0 = tail(&ring.0, 8192);
                }
                shared.stderr.lock().unwrap_or_else(|e| e.into_inner()).1 = true;
                shared.stderr_done.notify_all();
            })
        };
        let stdout = pipes.stdout.take().expect("piped stdout");
        let stdout_reader = {
            let (shared, progress) = (shared.clone(), progress.clone());
            let vfw = match &kind {
                Kind::Vfw(r) => Some((layout_stride(r.width), layout_stride(r.width) as u64 * r.height as u64)),
                Kind::Ffmpeg(_) => None,
            };
            std::thread::spawn(move || {
                if let Some(gate) = gate {
                    gate.wait();
                }
                read_progress(stdout, vfw, &shared, &progress)
            })
        };

        let (tx, rx) = mpsc::channel::<FrameBuf>();
        let stdin = pipes.stdin.take().expect("piped stdin");
        let wire = match &kind {
            Kind::Vfw(r) => Wire::Bgr24(r.width, r.height),
            Kind::Ffmpeg(_) => Wire::Png(layout.width, layout.height),
        };
        let writer = {
            let (shared, progress) = (shared.clone(), progress.clone());
            std::thread::Builder::new().name("styk video pipe".into()).spawn(move || write_frames(rx, stdin, wire, &shared, &progress)).expect("a thread to feed the encoder")
        };
        Ok(Session {
            kind,
            program: program.to_path_buf(),
            layout,
            pool,
            tx: Some(tx),
            writer: Some(writer),
            stderr_reader: Some(stderr_reader),
            stdout_reader: Some(stdout_reader),
            child,
            shared,
            stage,
            output,
            destination: destination.to_path_buf(),
            cancel: cancel.clone(),
            progress,
            submitted: 0,
            audio: None,
            total_frames,
        })
    }

    fn stderr_text(&self) -> String {
        let mut ring = self.shared.stderr.lock().unwrap_or_else(|e| e.into_inner());
        while !ring.1 {
            ring = self.shared.stderr_done.wait(ring).unwrap_or_else(|e| e.into_inner());
        }
        ring.0.trim().to_string()
    }

    /// The error for a failure the threads recorded, once the encoder is gone.
    fn describe(&self) -> VideoError {
        if self.cancel.is_cancelled() {
            return VideoError::Cancelled;
        }
        let failure = self.shared.failure.lock().unwrap_or_else(|e| e.into_inner()).clone();
        match failure {
            Some(Failure::Message(message)) => VideoError::Encoder(message),
            Some(Failure::Pipe) | None => {
                let status = self.child.wait();
                let stderr = self.stderr_text();
                if status.success() && matches!(self.kind, Kind::Ffmpeg(_)) {
                    let encoded = self.progress.snapshot().encoded;
                    VideoError::Encoder(format!("Native video encoded {encoded} of {} frames. The video may exceed its size limit.", self.total_frames))
                } else {
                    VideoError::Encoder(format!("Native video encoder stopped. {stderr}").trim_end().to_string())
                }
            }
        }
    }

    fn check(&self) -> Result<(), VideoError> {
        if self.cancel.is_cancelled() {
            return Err(VideoError::Cancelled);
        }
        if self.shared.failed() { Err(self.describe()) } else { Ok(()) }
    }

    fn end_threads(&mut self) {
        self.tx = None;
        if let Some(writer) = self.writer.take() {
            let _ = writer.join();
        }
    }

    fn join_readers(&mut self) {
        for reader in [self.stderr_reader.take(), self.stdout_reader.take()].into_iter().flatten() {
            let _ = reader.join();
        }
    }
}

fn layout_stride(width: u32) -> u32 {
    (width * 3).div_ceil(4) * 4
}

/// What the encoder reads on its standard input.
#[derive(Clone, Copy)]
enum Wire {
    /// FFmpeg: one PNG image a frame, as from today's app.
    Png(u32, u32),
    /// The Windows codec helper: bottom-up BGR24 rows padded to four bytes.
    Bgr24(u32, u32),
}

fn write_frames(rx: Receiver<FrameBuf>, mut stdin: std::process::ChildStdin, wire: Wire, shared: &Shared, progress: &Progress) {
    use image::ImageEncoder;
    let mut converted = Vec::new();
    for frame in rx.iter() {
        converted.clear();
        match wire {
            Wire::Bgr24(width, height) => rgba_to_bgr24(frame.bytes(), width, height, &mut converted),
            Wire::Png(width, height) => {
                // Fast compression: the pixels are what matter, and a small frame is what the encoder queues.
                let encoder = image::codecs::png::PngEncoder::new_with_quality(&mut converted, image::codecs::png::CompressionType::Fast, image::codecs::png::FilterType::Sub);
                if let Err(error) = encoder.write_image(frame.bytes(), width, height, image::ExtendedColorType::Rgba8) {
                    shared.fail(Failure::Message(format!("A video frame could not be encoded as PNG: {error}")));
                    return;
                }
            }
        }
        if let Err(error) = stdin.write_all(&converted) {
            shared.fail(if matches!(error.kind(), std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionReset) { Failure::Pipe } else { Failure::Message(format!("Native video encoder stopped accepting frames: {error}")) });
            return;
        }
        progress.add_written();
    }
}

/// Follows an encoder's progress on its standard output: FFmpeg's `-progress` lines or the VFW helper's JSON lines.
fn read_progress(stdout: std::process::ChildStdout, vfw: Option<(u32, u64)>, shared: &Shared, progress: &Progress) {
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        let line = line.trim();
        match vfw {
            None => {
                if let Some(frames) = line.strip_prefix("frame=").and_then(|n| n.trim().parse::<u64>().ok()) {
                    progress.set_encoded(frames);
                }
            }
            Some((stride, frame_bytes)) => {
                let mut events = shared.vfw.lock().unwrap_or_else(|e| e.into_inner());
                match json_text(line, "type").as_deref() {
                    Some("ready") => {
                        if json_number(line, "stride") != Some(stride as u64) || json_number(line, "frameBytes") != Some(frame_bytes) {
                            events.ready_mismatch = true;
                        }
                    }
                    Some("frame") => {
                        if let Some(index) = json_number(line, "index") {
                            progress.set_encoded(index + 1);
                        }
                        if json_number(line, "bytesWritten").is_some_and(|b| b > VFW_MAX_OUTPUT_BYTES) {
                            events.oversized = true;
                        }
                    }
                    Some("complete") => events.completed_frames = json_number(line, "frames"),
                    Some("error") => events.error = Some(json_text(line, "message").unwrap_or_else(|| "The Windows codec failed.".into())),
                    _ => {}
                }
            }
        }
    }
}

impl VideoSession for Session {
    fn layout(&self) -> &FrameLayout {
        &self.layout
    }

    fn acquire(&mut self) -> Result<FrameBuf, VideoError> {
        self.check()?;
        let buffer = self.pool.acquire()?;
        self.check()?;
        Ok(buffer)
    }

    fn submit(&mut self, frame: FrameBuf) -> Result<(), VideoError> {
        self.check()?;
        if frame.bytes().len() != self.layout.bytes {
            return Err(VideoError::Io(format!("A video frame holds {} bytes, {} were expected.", frame.bytes().len(), self.layout.bytes)));
        }
        if self.submitted >= self.total_frames {
            return Err(VideoError::Io("More frames than the export was started for.".into()));
        }
        let sent = self.tx.as_ref().map(|tx| tx.send(frame));
        match sent {
            Some(Ok(())) => {
                self.submitted += 1;
                self.progress.add_submitted();
                Ok(())
            }
            _ => Err(self.describe()),
        }
    }

    fn write_audio(&mut self, samples: &[f32]) -> Result<(), VideoError> {
        let Kind::Ffmpeg(request) = &self.kind else {
            return Err(VideoError::Io("Installed Windows codecs cannot carry sound.".into()));
        };
        if !request.audio {
            return Err(VideoError::Io("Enable audio when beginning the video export.".into()));
        }
        self.check()?;
        let expected = audio_bytes(request.total_frames, request.fps);
        let (file, written) = match &mut self.audio {
            Some(audio) => audio,
            slot => {
                let file = fs::OpenOptions::new().write(true).create_new(true).open(self.stage.path("mix.f32")).map_err(|e| VideoError::Io(format!("Audio writing stopped: {e}")))?;
                slot.insert((file, 0))
            }
        };
        if samples.is_empty() || samples.len() % 2 != 0 || *written + samples.len() as u64 * 4 > expected || samples.iter().any(|s| !s.is_finite() || s.abs() > 1.0) {
            return Err(VideoError::Invalid { key: "desktop.videoExportService.errors.invalidStereoAudioChunk".into(), message: "Invalid stereo audio chunk.".into() });
        }
        let mut bytes = Vec::with_capacity(samples.len() * 4);
        for sample in samples {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        file.write_all(&bytes).map_err(|e| VideoError::Io(format!("Audio writing stopped: {e}")))?;
        *written += bytes.len() as u64;
        Ok(())
    }

    fn progress(&self) -> Arc<Progress> {
        self.progress.clone()
    }

    fn encoder_pid(&self) -> Option<u32> {
        Some(self.child.pid())
    }

    fn finish(mut self: Box<Self>) -> Result<Committed, VideoError> {
        let result = self.finish_inner();
        // On an error the encoder may still be alive (a count that does not add up, a stalled pipe): end it before
        // joining the writer that may be blocked writing to it.
        if result.is_err() {
            self.child.terminate();
        }
        self.end_threads();
        self.child.terminate();
        self.join_readers();
        result
    }

    fn abort(mut self: Box<Self>) {
        self.child.terminate();
        self.end_threads();
        self.join_readers();
    }
}

impl Session {
    fn finish_inner(&mut self) -> Result<Committed, VideoError> {
        self.check()?;
        if self.submitted != self.total_frames {
            return Err(VideoError::Io("Send every video frame before finishing the export.".into()));
        }
        self.progress.set_phase(Phase::Finalizing);
        // Closing the channel lets the writer drain what is queued and close the pipe.
        self.tx = None;
        if let Some(writer) = self.writer.take() {
            let _ = writer.join();
        }
        let status = self.child.wait();
        // The exit does not mean the last progress lines were read: join the reader that holds the counters and the
        // terminal events before they are trusted (a reader that is slow must not turn a good export into a failure).
        if let Some(reader) = self.stdout_reader.take() {
            let _ = reader.join();
        }
        self.check()?;
        let stderr = self.stderr_text();
        if !status.success() {
            return Err(match &self.kind {
                Kind::Ffmpeg(_) => VideoError::Encoder(format!("Native video encoding failed. {stderr}").trim_end().to_string()),
                Kind::Vfw(_) => VideoError::Encoder(if stderr.is_empty() { format!("Windows codec export stopped before completion (code {}).", status.code().unwrap_or(-1)) } else { stderr }),
            });
        }
        let max_bytes = match &self.kind {
            Kind::Ffmpeg(request) => {
                let encoded = self.progress.snapshot().encoded;
                if encoded != request.total_frames as u64 {
                    return Err(VideoError::Encoder(format!("Native video encoded {encoded} of {} frames. The video may exceed its size limit.", request.total_frames)));
                }
                request.max_bytes
            }
            Kind::Vfw(request) => {
                let events = self.shared.vfw.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(message) = &events.error {
                    return Err(VideoError::Encoder(message.clone()));
                }
                if events.ready_mismatch {
                    return Err(VideoError::Encoder("Windows codec input dimensions do not match.".into()));
                }
                if events.oversized {
                    return Err(VideoError::Encoder("Video output exceeds the 256 MiB limit.".into()));
                }
                if events.completed_frames != Some(request.total_frames as u64) {
                    return Err(VideoError::Encoder(format!("Windows codec export stopped before completion (code {}).", status.code().unwrap_or(0))));
                }
                VFW_MAX_OUTPUT_BYTES
            }
        };
        if let Kind::Ffmpeg(request) = &self.kind
            && request.audio
        {
            self.mux_audio(&request.clone())?;
        }
        let size = fs::metadata(&self.output).map_err(|e| VideoError::Io(e.to_string()))?.len();
        let (low, message) = match &self.kind {
            Kind::Ffmpeg(_) => (1, "Encoded video exceeds its size limit."),
            Kind::Vfw(_) => (256, "The Windows codec produced an empty or oversized AVI file."),
        };
        if size < low || size > max_bytes {
            return Err(VideoError::Encoder(message.into()));
        }
        self.progress.set_phase(Phase::Committing);
        // The flush happens before the commit boundary, the rename after it: a cancel (an edit, a close) during the flush
        // still cancels, and none can be followed by a replaced destination.
        match staging::commit_gated(&self.output, &self.destination, &self.cancel, &|| {}) {
            Err(CommitError::Cancelled) => Err(VideoError::Cancelled),
            Ok(bytes) => {
                self.progress.set_phase(Phase::Done);
                Ok(Committed { path: self.destination.clone(), bytes, frames: self.total_frames })
            }
            Err(CommitError::Io(error)) => {
                // The finished file stays for another try; only the intermediates go.
                for name in ["mix.f32", "video.mp4", "video.webm", "video.avi", "video.wmv"] {
                    if self.stage.path(name) != self.output {
                        let _ = fs::remove_file(self.stage.path(name));
                    }
                }
                self.stage.keep();
                Err(VideoError::CommitFailed { artifact: self.output.clone(), destination: self.destination.clone(), message: error.to_string() })
            }
        }
    }

    /// The second pass: the silent video copied beside the mix, into `mixed.<ext>`.
    fn mux_audio(&mut self, request: &FfmpegRequest) -> Result<(), VideoError> {
        let expected = audio_bytes(request.total_frames, request.fps);
        let mix = self.stage.path("mix.f32");
        match self.audio.take() {
            Some((file, written)) if written == expected => {
                drop(file);
            }
            _ => return Err(VideoError::Io("Send the entire audio mix before finishing video export.".into())),
        }
        let extension = request.container.extension();
        let mixed = self.stage.path(&format!("mixed.{extension}"));
        let arguments = args::mux_args(request, &self.output.to_string_lossy(), &mix.to_string_lossy(), &mixed.to_string_lossy());
        let mut command = Command::new(&self.program);
        command.args(&arguments);
        let (child, mut pipes) = process::spawn(&mut command, false).map_err(|e| VideoError::Unavailable(format!("Native video encoder could not start: {e}")))?;
        let killer = child.clone();
        self.cancel.on_cancel(move || killer.terminate());
        // The pass writes nothing to standard output; its standard error is read to the end.
        drop(pipes.stdout.take());
        let mut text = String::new();
        if let Some(mut stderr) = pipes.stderr.take() {
            let mut bytes = Vec::new();
            let _ = stderr.read_to_end(&mut bytes);
            text = tail(&String::from_utf8_lossy(&bytes), 4096);
        }
        let status = child.wait();
        if self.cancel.is_cancelled() {
            return Err(VideoError::Cancelled);
        }
        if !status.success() {
            return Err(VideoError::Encoder(format!("Audio encoding failed. {text}").trim_end().to_string()));
        }
        let _ = fs::remove_file(&self.output);
        let _ = fs::remove_file(&mix);
        self.output = mixed;
        Ok(())
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.child.terminate();
    }
}
