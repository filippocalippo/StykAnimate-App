//! Video export, as a service.
//!
//! The types an export exchanges with the encoder (a request, the frame layout, progress, errors), the two traits that
//! hide the encoder (`VideoService`, `VideoSession`) and a fake for tests. No OS code: `styk-platform::video` runs the
//! bundled FFmpeg and the Video for Windows helper behind these traits. See `docs/native/video-export.md`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Condvar, Mutex};

use crate::cancel::Cancel;

/// The largest output side and the most pixels a frame may have for FFmpeg video (`validateConfig`).
pub const MAX_SIDE: u32 = 16_384;
pub const MAX_FFMPEG_PIXELS: u64 = 16 * 1024 * 1024;
/// The most pixels of a frame the VFW helper takes (the interface's export limit).
pub const MAX_VFW_PIXELS: u64 = 67_108_864;
pub const MAX_FRAMES: u32 = 1_000_000;
pub const MAX_OUTPUT_BYTES: u64 = 1 << 30;
pub const MIN_OUTPUT_BYTES: u64 = 1024;
/// A sound track the export mixes: 48 kHz stereo f32, at most one hour.
pub const AUDIO_RATE: u32 = 48_000;
pub const MAX_AUDIO_SECONDS: f64 = 3600.0;
pub const VFW_MAX_FRAME_BYTES: u64 = 64 << 20;
pub const VFW_MAX_OUTPUT_BYTES: u64 = 256 << 20;

/// JavaScript's `Math.round` on a finite number (halves go up).
pub fn js_round(value: f64) -> f64 {
    let floor = value.floor();
    if value - floor >= 0.5 { floor + 1.0 } else { floor }
}

/// The bytes of the sound track an export of `frames` at `fps` carries (`round(frames / fps * 48000)` stereo f32 pairs).
pub fn audio_bytes(frames: u32, fps: f64) -> u64 {
    js_round(frames as f64 / fps * AUDIO_RATE as f64) as u64 * 8
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Container {
    Webm,
    Mp4,
    Avi,
    /// `.wmv`
    Asf,
}

impl Container {
    pub fn muxer(self) -> &'static str {
        match self {
            Container::Webm => "webm",
            Container::Mp4 => "mp4",
            Container::Avi => "avi",
            Container::Asf => "asf",
        }
    }

    pub fn extension(self) -> &'static str {
        match self {
            Container::Asf => "wmv",
            other => other.muxer(),
        }
    }

    /// The codec the sound track gets in this container.
    pub fn audio_codec(self) -> &'static str {
        match self {
            Container::Mp4 => "aac",
            Container::Webm => "libopus",
            Container::Avi => "pcm_s16le",
            Container::Asf => "wmav2",
        }
    }

    /// The interface's format id.
    pub fn parse(id: &str) -> Option<Container> {
        match id {
            "webm" => Some(Container::Webm),
            "mp4" => Some(Container::Mp4),
            "avi" => Some(Container::Avi),
            "wmv" => Some(Container::Asf),
            _ => None,
        }
    }

    /// The codecs the container offers, the default first.
    pub fn codecs(self) -> &'static [Codec] {
        match self {
            Container::Webm => &[Codec::Vp9],
            Container::Mp4 => &[Codec::H264, Codec::Mpeg4],
            Container::Avi => &[Codec::Mpeg4, Codec::Ffv1, Codec::Rawvideo],
            Container::Asf => &[Codec::Wmv2],
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Codec {
    Vp9,
    H264,
    Mpeg4,
    Wmv2,
    Ffv1,
    Rawvideo,
}

impl Codec {
    pub fn id(self) -> &'static str {
        match self {
            Codec::Vp9 => "vp9",
            Codec::H264 => "h264",
            Codec::Mpeg4 => "mpeg4",
            Codec::Wmv2 => "wmv2",
            Codec::Ffv1 => "ffv1",
            Codec::Rawvideo => "rawvideo",
        }
    }

    pub fn parse(id: &str) -> Option<Codec> {
        [Codec::Vp9, Codec::H264, Codec::Mpeg4, Codec::Wmv2, Codec::Ffv1, Codec::Rawvideo].into_iter().find(|c| c.id() == id)
    }

    /// FFmpeg's encoder name.
    pub fn encoder(self) -> &'static str {
        match self {
            Codec::Vp9 => "libvpx-vp9",
            Codec::H264 => "libx264",
            Codec::Mpeg4 => "mpeg4",
            Codec::Wmv2 => "wmv2",
            Codec::Ffv1 => "ffv1",
            Codec::Rawvideo => "rawvideo",
        }
    }

    pub fn pixel_format(self) -> &'static str {
        match self {
            Codec::Vp9 => "yuva420p",
            Codec::H264 | Codec::Mpeg4 | Codec::Wmv2 => "yuv420p",
            Codec::Ffv1 => "bgr0",
            Codec::Rawvideo => "bgr24",
        }
    }

    /// Keeps the alpha plane (the engine's straight RGBA goes in; every other codec gets the black matte).
    pub fn alpha(self) -> bool {
        self == Codec::Vp9
    }

    /// Takes a quality or a bitrate (the lossless ones take neither).
    pub fn quality(self) -> bool {
        !matches!(self, Codec::Ffv1 | Codec::Rawvideo)
    }

    /// Odd sizes are padded by a black pixel only for `yuv420p` codecs.
    pub fn pads(self) -> bool {
        self.pixel_format() == "yuv420p"
    }
}

/// Which edge a padded size added a black pixel to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Edge {
    Right,
    Bottom,
    Both,
}

impl Edge {
    pub fn message(self, width: u32, height: u32) -> String {
        let edge = match self {
            Edge::Both => "right and bottom",
            Edge::Right => "right",
            Edge::Bottom => "bottom",
        };
        format!("Video will include a one-pixel black edge on the {edge} ({width}\u{d7}{height}).")
    }
}

/// The size a codec encodes `width` by `height` at, and the edge it pads (`codecDimensions`).
pub fn codec_dimensions(codec: Codec, width: u32, height: u32) -> (u32, u32, Option<Edge>) {
    let (right, bottom) = (codec.pads() && width % 2 == 1, codec.pads() && height % 2 == 1);
    let edge = match (right, bottom) {
        (true, true) => Some(Edge::Both),
        (true, false) => Some(Edge::Right),
        (false, true) => Some(Edge::Bottom),
        (false, false) => None,
    };
    (width + right as u32, height + bottom as u32, edge)
}

/// What the encoder is asked for: a quality in 0..=1 kept beside an optional bitrate (VP9 with a bitrate still gets
/// its CRF from the quality).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rate {
    pub quality: f64,
    /// bit/s, as typed (rounded when it is handed to the encoder).
    pub bitrate: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FfmpegRequest {
    pub container: Container,
    pub codec: Codec,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub total_frames: u32,
    pub rate: Rate,
    pub max_bytes: u64,
    /// A sound track follows (`VideoSession::write_audio` before `finish`).
    pub audio: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Arch {
    X86,
    X64,
}

/// An installed Video for Windows codec and its settings (`desktop/vfw-export-service.cjs`).
#[derive(Clone, Debug, PartialEq)]
pub struct VfwRequest {
    pub arch: Arch,
    pub handler: u32,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub total_frames: u32,
    /// 0..=1; passed as `round(q * 10000)` only when the codec advertises quality, else -1.
    pub quality: f64,
    pub keyframe_every: u32,
    /// bit/s; passed as bytes per second only when the codec advertises a data rate.
    pub bitrate: u32,
    pub supports_quality: bool,
    pub supports_keyframes: bool,
    pub supports_data_rate: bool,
    /// An opaque codec configuration saved by the helper's `--configure`.
    pub state_file: Option<PathBuf>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum VideoRequest {
    Ffmpeg(FfmpegRequest),
    Vfw(VfwRequest),
}

/// What a frame handed to a session looks like: straight or black-matted RGBA, rows packed, of the input size.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FrameLayout {
    pub width: u32,
    pub height: u32,
    pub bytes: usize,
    /// The producer composites over black (every codec without alpha); otherwise straight RGBA.
    pub matte: bool,
    /// The size the encoder writes (a padded edge), and the edge when it differs.
    pub encoded: (u32, u32),
    pub edge: Option<Edge>,
}

/// A frame buffer on loan from a [`FramePool`]; dropping it returns it.
pub struct FrameBuf {
    data: Vec<u8>,
    pool: Arc<PoolInner>,
}

impl FrameBuf {
    pub fn bytes(&self) -> &[u8] {
        &self.data
    }

    pub fn bytes_mut(&mut self) -> &mut Vec<u8> {
        &mut self.data
    }
}

impl Drop for FrameBuf {
    fn drop(&mut self) {
        let data = std::mem::take(&mut self.data);
        let mut free = self.pool.free.lock().unwrap_or_else(|e| e.into_inner());
        free.push(data);
        self.pool.available.notify_one();
    }
}

struct PoolInner {
    free: Mutex<Vec<Vec<u8>>>,
    available: Condvar,
}

/// A fixed number of frame buffers. The producer waits for a free one and never allocates; cancelling wakes the wait.
#[derive(Clone)]
pub struct FramePool {
    inner: Arc<PoolInner>,
    cancel: Cancel,
}

impl FramePool {
    pub fn new(buffers: usize, bytes: usize, cancel: &Cancel) -> FramePool {
        let inner = Arc::new(PoolInner { free: Mutex::new((0..buffers).map(|_| Vec::with_capacity(bytes)).collect()), available: Condvar::new() });
        let waker = inner.clone();
        cancel.on_cancel(move || {
            // Taking the lock first means a waiter that checked the flag has either not started waiting or is in `wait`.
            drop(waker.free.lock().unwrap_or_else(|e| e.into_inner()));
            waker.available.notify_all();
        });
        FramePool { inner, cancel: cancel.clone() }
    }

    /// A free buffer (empty, its capacity kept), or `Err(Cancelled)`.
    pub fn acquire(&self) -> Result<FrameBuf, VideoError> {
        let mut free = self.inner.free.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if self.cancel.is_cancelled() {
                return Err(VideoError::Cancelled);
            }
            if let Some(mut data) = free.pop() {
                data.clear();
                return Ok(FrameBuf { data, pool: self.inner.clone() });
            }
            free = self.inner.available.wait(free).unwrap_or_else(|e| e.into_inner());
        }
    }

    /// Buffers not on loan.
    pub fn idle(&self) -> usize {
        self.inner.free.lock().unwrap_or_else(|e| e.into_inner()).len()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Phase {
    Preflight = 0,
    Rendering = 1,
    Finalizing = 2,
    Committing = 3,
    Done = 4,
}

/// Counters a UI or a tool reads while the export runs; written with atomics, never behind a lock.
#[derive(Default)]
pub struct Progress {
    submitted: AtomicU64,
    written: AtomicU64,
    encoded: AtomicU64,
    phase: AtomicU8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProgressSnapshot {
    /// Frames handed to the session.
    pub submitted: u64,
    /// Frames written to the encoder's input.
    pub written: u64,
    /// Frames the encoder reports done.
    pub encoded: u64,
    pub phase: Phase,
}

impl Progress {
    pub fn snapshot(&self) -> ProgressSnapshot {
        let phase = match self.phase.load(Ordering::Relaxed) {
            0 => Phase::Preflight,
            1 => Phase::Rendering,
            2 => Phase::Finalizing,
            3 => Phase::Committing,
            _ => Phase::Done,
        };
        ProgressSnapshot { submitted: self.submitted.load(Ordering::Relaxed), written: self.written.load(Ordering::Relaxed), encoded: self.encoded.load(Ordering::Relaxed), phase }
    }

    pub fn set_phase(&self, phase: Phase) {
        self.phase.store(phase as u8, Ordering::Relaxed);
    }

    pub fn add_submitted(&self) {
        self.submitted.fetch_add(1, Ordering::Relaxed);
    }

    pub fn add_written(&self) {
        self.written.fetch_add(1, Ordering::Relaxed);
    }

    pub fn set_encoded(&self, frames: u64) {
        self.encoded.store(frames, Ordering::Relaxed);
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum VideoError {
    Cancelled,
    /// A request outside the limits: the localisation key of the message and its English text.
    Invalid { key: String, message: String },
    /// No working encoder, or the format is not offered by it.
    Unavailable(String),
    /// The destination cannot be written or replaced; named before any frame is drawn.
    Destination { path: PathBuf, message: String },
    /// The encoder failed or stopped; its last words.
    Encoder(String),
    /// The finished file could not be moved over the destination. It is kept at `artifact` for another try.
    CommitFailed { artifact: PathBuf, destination: PathBuf, message: String },
    Io(String),
}

impl std::fmt::Display for VideoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VideoError::Cancelled => write!(f, "Video export cancelled."),
            VideoError::Invalid { message, .. } | VideoError::Unavailable(message) | VideoError::Encoder(message) | VideoError::Io(message) => write!(f, "{message}"),
            VideoError::Destination { path, message } => write!(f, "{}: {message}", path.display()),
            VideoError::CommitFailed { artifact, destination, message } => {
                write!(f, "The video is finished but could not be saved to {}: {message} (kept at {})", destination.display(), artifact.display())
            }
        }
    }
}

impl std::error::Error for VideoError {}

/// A video that was written to its destination.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Committed {
    pub path: PathBuf,
    pub bytes: u64,
    pub frames: u32,
}

/// One format and codec and whether the encoder offers it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CodecSupport {
    pub container: Container,
    pub codec: Codec,
    pub supported: bool,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Capabilities {
    pub available: bool,
    pub reason: Option<String>,
    pub version: String,
    pub codecs: Vec<CodecSupport>,
}

pub trait VideoService: Send + Sync {
    /// What the encoder offers. Blocking: probes the encoder, so call it from a job.
    fn capabilities(&self) -> Capabilities;

    /// Preflight and start: validates `request`, checks that `destination` can be written and replaced (before any
    /// frame is drawn), creates the job's staging directory beside it and starts the encoder. `cancel` ends it.
    fn begin(&self, destination: &Path, request: &VideoRequest, cancel: &Cancel) -> Result<Box<dyn VideoSession>, VideoError>;

    /// Tries again to move a finished video kept after [`VideoError::CommitFailed`] onto `destination`.
    fn retry_commit(&self, artifact: &Path, destination: &Path) -> Result<Committed, VideoError>;
}

pub trait VideoSession: Send {
    fn layout(&self) -> &FrameLayout;

    /// A free frame buffer to draw into; waits (cancellably) while the encoder is behind.
    fn acquire(&mut self) -> Result<FrameBuf, VideoError>;

    /// Hands a drawn frame over, in order. Never blocks on the encoder: the pool bounds the queue.
    fn submit(&mut self, frame: FrameBuf) -> Result<(), VideoError>;

    /// Appends stereo f32 samples (interleaved, finite, at most 1 in magnitude) of the 48 kHz mix.
    fn write_audio(&mut self, samples: &[f32]) -> Result<(), VideoError>;

    fn progress(&self) -> Arc<Progress>;

    /// Closes the input, waits for the encoder, adds the sound, checks the result and moves it over the destination.
    fn finish(self: Box<Self>) -> Result<Committed, VideoError>;

    /// Ends the encoder and removes everything this job made; an existing destination is never touched.
    fn abort(self: Box<Self>);
}

/// A service that keeps what it is given, for tests of the code above it.
pub mod fake {
    use super::*;

    /// What a [`FakeVideoService`] session received.
    #[derive(Default)]
    pub struct Recording {
        pub frames: Vec<Vec<u8>>,
        pub audio: Vec<f32>,
        pub committed: bool,
        pub aborted: bool,
    }

    /// Records frames; fails once `fail_after` frames were recorded, when set.
    #[derive(Clone, Default)]
    pub struct FakeVideoService {
        pub recording: Arc<Mutex<Recording>>,
        pub fail_after: Option<usize>,
    }

    impl VideoService for FakeVideoService {
        fn capabilities(&self) -> Capabilities {
            Capabilities { available: true, reason: None, version: "fake".into(), codecs: Vec::new() }
        }

        fn begin(&self, _destination: &Path, request: &VideoRequest, cancel: &Cancel) -> Result<Box<dyn VideoSession>, VideoError> {
            let (width, height, matte, encoded, edge) = match request {
                VideoRequest::Ffmpeg(r) => {
                    let (w, h, edge) = codec_dimensions(r.codec, r.width, r.height);
                    (r.width, r.height, !r.codec.alpha(), (w, h), edge)
                }
                VideoRequest::Vfw(r) => (r.width, r.height, true, (r.width, r.height), None),
            };
            let layout = FrameLayout { width, height, bytes: width as usize * height as usize * 4, matte, encoded, edge };
            let pool = FramePool::new(3, layout.bytes, cancel);
            Ok(Box::new(FakeSession { layout, pool, recording: self.recording.clone(), fail_after: self.fail_after, progress: Arc::new(Progress::default()), cancel: cancel.clone() }))
        }

        fn retry_commit(&self, artifact: &Path, _destination: &Path) -> Result<Committed, VideoError> {
            Ok(Committed { path: artifact.to_path_buf(), bytes: 0, frames: 0 })
        }
    }

    struct FakeSession {
        layout: FrameLayout,
        pool: FramePool,
        recording: Arc<Mutex<Recording>>,
        fail_after: Option<usize>,
        progress: Arc<Progress>,
        cancel: Cancel,
    }

    impl VideoSession for FakeSession {
        fn layout(&self) -> &FrameLayout {
            &self.layout
        }

        fn acquire(&mut self) -> Result<FrameBuf, VideoError> {
            self.pool.acquire()
        }

        fn submit(&mut self, frame: FrameBuf) -> Result<(), VideoError> {
            if self.cancel.is_cancelled() {
                return Err(VideoError::Cancelled);
            }
            let mut recording = self.recording.lock().unwrap();
            if self.fail_after == Some(recording.frames.len()) {
                return Err(VideoError::Encoder("the fake encoder stopped".into()));
            }
            recording.frames.push(frame.bytes().to_vec());
            self.progress.add_submitted();
            self.progress.add_written();
            Ok(())
        }

        fn write_audio(&mut self, samples: &[f32]) -> Result<(), VideoError> {
            self.recording.lock().unwrap().audio.extend_from_slice(samples);
            Ok(())
        }

        fn progress(&self) -> Arc<Progress> {
            self.progress.clone()
        }

        fn finish(self: Box<Self>) -> Result<Committed, VideoError> {
            let mut recording = self.recording.lock().unwrap();
            recording.committed = true;
            Ok(Committed { path: PathBuf::from("fake"), bytes: 0, frames: recording.frames.len() as u32 })
        }

        fn abort(self: Box<Self>) {
            self.recording.lock().unwrap().aborted = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_round_rounds_halves_up_and_keeps_the_double_below_a_half_down() {
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(0.49999999999999994), 0.0);
        assert_eq!(js_round(27.0), 27.0);
    }

    #[test]
    fn padding_is_for_yuv420p_codecs_only() {
        assert_eq!(codec_dimensions(Codec::H264, 65, 33), (66, 34, Some(Edge::Both)));
        assert_eq!(codec_dimensions(Codec::Wmv2, 64, 33), (64, 34, Some(Edge::Bottom)));
        assert_eq!(codec_dimensions(Codec::Mpeg4, 65, 32), (66, 32, Some(Edge::Right)));
        for codec in [Codec::Vp9, Codec::Ffv1, Codec::Rawvideo] {
            assert_eq!(codec_dimensions(codec, 65, 33), (65, 33, None), "{codec:?}");
        }
    }

    #[test]
    fn audio_length_follows_the_frame_count() {
        assert_eq!(audio_bytes(48, 24.0), 2 * 48_000 * 8);
        assert_eq!(audio_bytes(1, 29.97), 1602 * 8);
    }

    #[test]
    fn a_cancel_wakes_a_producer_waiting_for_a_buffer() {
        let cancel = Cancel::new();
        let pool = FramePool::new(1, 16, &cancel);
        let held = pool.acquire().unwrap();
        let waiting = {
            let pool = pool.clone();
            std::thread::spawn(move || pool.acquire().err())
        };
        std::thread::sleep(std::time::Duration::from_millis(50));
        cancel.cancel();
        assert_eq!(waiting.join().unwrap(), Some(VideoError::Cancelled));
        drop(held);
        assert_eq!(pool.idle(), 1);
    }

    #[test]
    fn a_dropped_buffer_returns_to_the_pool() {
        let cancel = Cancel::new();
        let pool = FramePool::new(2, 16, &cancel);
        let a = pool.acquire().unwrap();
        let b = pool.acquire().unwrap();
        assert_eq!(pool.idle(), 0);
        drop(a);
        assert_eq!(pool.idle(), 1);
        drop(b);
        assert_eq!(pool.idle(), 2);
    }
}
