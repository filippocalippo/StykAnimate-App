//! Audio output and decoding, as services.
//!
//! The renderer (`styk-core::audio`) fills blocks of 48 kHz stereo `f32`; an [`AudioOutput`] plays them on the device and
//! the [`StreamClock`] it keeps says which project sample is being heard. The protocol between a renderer and a device (the
//! three kinds of stop, underrun recovery, the clock) is one [`StreamDriver`] that runs against an [`Endpoint`]: WASAPI
//! implements `Endpoint` in `styk-platform::audio`, and [`fake::FakeOutput`] implements it with a clock the test owns, so the
//! protocol is tested without a device and runs unchanged on one. Design: `docs/native/audio.md`.
//!
//! No OS code here.

pub mod clock;
pub mod convert;
pub mod driver;
pub mod fake;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

pub use clock::{Reading, Segment, StreamClock};
pub use driver::{Endpoint, StreamDriver};

/// The stream's and the project's rate.
pub const RATE: u32 = 48_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AudioError {
    /// No device, or the audio service is unavailable.
    Unavailable(String),
    /// The device went away (unplugged, disabled, its format changed).
    DeviceLost,
    /// A device call failed.
    Device(String),
    /// The decoder could not decode the recording; the text is its message.
    Decode(String),
    Cancelled,
    /// The active mix does not fit the decoded-audio budget.
    OverBudget { needed: u64, limit: u64 },
    Io(String),
}

impl std::fmt::Display for AudioError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AudioError::Unavailable(m) | AudioError::Device(m) | AudioError::Decode(m) | AudioError::Io(m) => f.write_str(m),
            AudioError::DeviceLost => f.write_str("the audio device was disconnected"),
            AudioError::Cancelled => f.write_str("audio operation cancelled"),
            AudioError::OverBudget { limit, .. } => write!(f, "the active audio mix exceeds the {} MiB limit", limit >> 20),
        }
    }
}

impl std::error::Error for AudioError {}

/// What the renderer does after a block.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Next {
    /// The block is valid; keep going.
    Continue,
    /// A new transport command was applied: discard what is queued in the device (stop, reset), begin a new epoch, ask again.
    Restart,
    /// The transport stopped: discard what is queued, stop the device and wait for the next activation.
    Idle,
}

/// What a block holds, in project terms: its first `playing_frames` frames are project samples `project_start`, `+1`, ...;
/// the rest of the block is silence that is not project time and holds at `held_at`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RenderResult {
    pub next: Next,
    /// The generation of the transport command the renderer is under now.
    pub generation: u64,
    pub playing_frames: u32,
    pub project_start: i64,
    pub held_at: i64,
}

impl RenderResult {
    pub fn idle(generation: u64) -> RenderResult {
        RenderResult { next: Next::Idle, generation, playing_frames: 0, project_start: 0, held_at: 0 }
    }
}

/// The renderer the device thread calls. It runs on a realtime thread: no locks, allocation or I/O.
pub trait RenderSource: Send {
    /// Fills `out` (interleaved stereo, `out.len() / 2` frames). With `Restart` or `Idle` the block is discarded.
    fn render(&mut self, out: &mut [f32]) -> RenderResult;

    /// Applies a waiting transport command without making sound, so a stop or a new play takes effect at the next wake even when
    /// the device has no room for a block. `Restart` or `Idle` when the command ends the current playing, otherwise `Continue`.
    fn poll(&mut self) -> RenderResult;
}

/// How the stream was opened.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Path {
    /// The endpoint's own format at its smallest period; channel mapping is ours.
    Direct,
    /// The ordinary shared mode with the system converting rate and channels.
    Converted,
    /// A device with no hardware (the fake).
    Simulated,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutputInfo {
    pub device_name: String,
    pub path: Path,
    pub endpoint_rate: u32,
    pub endpoint_channels: u16,
    /// Frames of one period and of the whole buffer, in stream frames.
    pub period_frames: u32,
    pub buffer_frames: u32,
    /// What the device reports as the stream's latency, in nanoseconds.
    pub stream_latency_ns: u64,
}

/// What the transport tells the device thread, and what the device thread tells the transport.
pub struct StreamControl {
    active: AtomicBool,
    shutdown: AtomicBool,
    lost: AtomicBool,
    waker: OnceLock<Box<dyn Fn() + Send + Sync>>,
}

impl StreamControl {
    pub fn new() -> Arc<StreamControl> {
        Arc::new(StreamControl { active: AtomicBool::new(false), shutdown: AtomicBool::new(false), lost: AtomicBool::new(false), waker: OnceLock::new() })
    }

    /// The device sets how to wake its thread, once.
    pub fn set_waker(&self, waker: impl Fn() + Send + Sync + 'static) {
        let _ = self.waker.set(Box::new(waker));
    }

    /// Wakes the device thread without asking it to start (a command is waiting in the mailbox).
    pub fn wake(&self) {
        if let Some(waker) = self.waker.get() {
            waker();
        }
    }

    /// Asks the device to run its stream: begin an epoch if it is idle. The renderer's first block decides what plays.
    pub fn activate(&self) {
        self.active.store(true, Ordering::SeqCst);
        self.wake();
    }

    pub fn take_activation(&self) -> bool {
        self.active.swap(false, Ordering::SeqCst)
    }

    pub fn shutdown(&self) {
        self.shutdown.store(true, Ordering::SeqCst);
        self.wake();
    }

    pub fn is_shutdown(&self) -> bool {
        self.shutdown.load(Ordering::SeqCst)
    }

    /// The device thread ended because the device was lost.
    pub fn mark_lost(&self) {
        self.lost.store(true, Ordering::SeqCst);
    }

    pub fn is_lost(&self) -> bool {
        self.lost.load(Ordering::SeqCst)
    }
}

/// An output device and its thread.
pub trait AudioOutput: Send {
    /// Opens the default device, negotiates its format and starts its thread (idle: nothing plays until `control().activate()`).
    fn open(&mut self, source: Box<dyn RenderSource>) -> Result<OutputInfo, AudioError>;
    fn clock(&self) -> Arc<StreamClock>;
    fn control(&self) -> Arc<StreamControl>;
    /// Ends the thread and releases the device. Never blocks on the caller's behalf for more than a period.
    fn close(&mut self);
}

/// A monotonic host clock in nanoseconds on the same base as the device's position timestamps (QPC on Windows).
pub trait HostClock: Send + Sync {
    fn now_ns(&self) -> u64;
}

/// The decoder of recordings the mixer does not read directly. `original` is the recording's file. On success the result is
/// a WAV file; `reserve(bytes)` is called with the size of the decoded output before it is read into memory, and an error from
/// it ends the decode. The decode ends promptly when `cancel` is cancelled, whatever it is blocked on.
pub trait AudioDecoder: Send + Sync {
    fn decode(&self, original: &[u8], expected_seconds: f64, reserve: &mut dyn FnMut(u64) -> Result<(), AudioError>, cancel: &crate::Cancel) -> Result<Vec<u8>, AudioError>;
}
