//! A fake output device with a clock the test owns and faults it can inject.
//!
//! The fake implements [`Endpoint`], so the real [`StreamDriver`] runs on it: the protocol (epochs, restarts, the clock cell,
//! underrun recovery) is the one WASAPI runs, with time that only [`FakeHandle::advance`] moves. It models a device with a
//! start latency, a stream clock counting in any frequency (44100, 96000, 10 MHz), a buffer of whole periods, queued sound that
//! plays out unless the stream is reset, and the faults: missed wakes (the thread was late), a stall, a lost device, a
//! position that keeps counting through an underrun or stops with it.
//!
//! The endpoint's own rate and channel count (44.1 kHz, 96 kHz, 5.1) are reported in [`OutputInfo`]; the system conversion
//! they imply is the operating system's, so the stream the renderer sees is always 48 kHz stereo, as it is on Windows.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use super::clock::StreamClock;
use super::driver::{Endpoint, StreamDriver};
use super::{AudioError, AudioOutput, HostClock, OutputInfo, Path, RenderSource, StreamControl, RATE};

#[derive(Clone, Debug)]
pub struct FakeConfig {
    pub device_name: String,
    pub endpoint_rate: u32,
    pub endpoint_channels: u16,
    /// Stream frames of one wake and of the buffer.
    pub period_frames: u32,
    pub buffer_frames: u32,
    /// Time from `start` until the first frame is heard.
    pub latency_ns: u64,
    /// The units the device position counts in, per second.
    pub clock_frequency: u64,
    /// Whether the position keeps counting while the device plays silence for want of data (a stream that glitches) or
    /// stops with the data.
    pub position_advances_in_underrun: bool,
}

impl Default for FakeConfig {
    fn default() -> FakeConfig {
        FakeConfig { device_name: "Fake output".into(), endpoint_rate: RATE, endpoint_channels: 2, period_frames: 480, buffer_frames: 960, latency_ns: 20_000_000, clock_frequency: RATE as u64, position_advances_in_underrun: true }
    }
}

#[derive(Default)]
struct Device {
    started: bool,
    started_at_ns: u64,
    /// The host time the device model has been advanced to.
    synced_ns: u64,
    /// Frames written and not yet played.
    queued: u64,
    /// Frames heard in this epoch.
    consumed: u64,
    /// Frames the clock counted while the device had nothing to play.
    dry: u64,
    /// The fractional frame carried between advances.
    carry: f64,
    resets: u64,
    starts: u64,
    captured: Vec<f32>,
    written_frames: u64,
    /// Every kept block with the device frame (in this epoch) it was placed at, when capturing: the truth the clock is held to.
    placed: Vec<(u64, Vec<f32>)>,
}

/// One-shot delays inside a wake, in frames of stream time: the thread was preempted between two device calls.
#[derive(Default)]
struct Delays {
    in_padding: u64,
    in_write: u64,
}

struct Inner {
    config: FakeConfig,
    host_ns: u64,
    next_wake_ns: u64,
    skip_wakes: u32,
    lost: bool,
    device: Device,
    driver: Option<StreamDriver>,
    control: Arc<StreamControl>,
    capture: bool,
    delays: Delays,
    host_cell: Arc<AtomicU64>,
}

struct FakeEndpoint<'a> {
    config: &'a FakeConfig,
    host_ns: &'a mut u64,
    delays: &'a mut Delays,
    host_cell: &'a AtomicU64,
    device: &'a mut Device,
    capture: bool,
}

impl FakeEndpoint<'_> {
    /// Time passes inside a device call.
    fn pass(&mut self, frames: u64) {
        *self.host_ns += frames * 1_000_000_000 / RATE as u64;
        self.host_cell.store(*self.host_ns, Ordering::SeqCst);
    }

    /// Plays the model forward to the host time.
    fn sync(&mut self) {
        let device = &mut *self.device;
        let elapsed = self.host_ns.saturating_sub(device.synced_ns);
        device.synced_ns = *self.host_ns;
        if !device.started {
            return;
        }
        let begins = device.started_at_ns + self.config.latency_ns;
        if *self.host_ns <= begins {
            return;
        }
        // Only the time past the start latency plays.
        let elapsed = elapsed.min(*self.host_ns - begins);
        let frames = elapsed as f64 * RATE as f64 / 1e9 + device.carry;
        let whole = frames.floor();
        device.carry = frames - whole;
        let whole = whole as u64;
        let played = whole.min(device.queued);
        device.queued -= played;
        device.consumed += played;
        device.dry += whole - played;
    }
}

impl Endpoint for FakeEndpoint<'_> {
    fn buffer_frames(&self) -> u32 {
        self.config.buffer_frames
    }

    fn frequency(&self) -> u64 {
        self.config.clock_frequency
    }

    fn padding(&mut self) -> Result<u32, AudioError> {
        let delay = std::mem::take(&mut self.delays.in_padding);
        self.pass(delay);
        self.sync();
        Ok(self.device.queued as u32)
    }

    fn write(&mut self, frames: u32, fill: &mut dyn FnMut(&mut [f32]) -> bool) -> Result<u64, AudioError> {
        let delay = std::mem::take(&mut self.delays.in_write);
        self.pass(delay);
        self.sync();
        let placed_at = self.device.consumed + self.device.dry + self.device.queued;
        let submitted_ns = *self.host_ns;
        assert!(self.device.queued + frames as u64 <= self.config.buffer_frames as u64, "the driver wrote more than the buffer's free space");
        let mut block = vec![0.0f32; frames as usize * 2];
        let kept = fill(&mut block);
        if !kept {
            block.fill(0.0);
        }
        self.device.queued += frames as u64;
        self.device.written_frames += frames as u64;
        if self.capture && kept {
            self.device.captured.extend_from_slice(&block);
            self.device.placed.push((placed_at, block));
        }
        Ok(submitted_ns)
    }

    fn position(&mut self) -> Result<(u64, u64), AudioError> {
        self.sync();
        let frames = self.device.consumed + if self.config.position_advances_in_underrun { self.device.dry } else { 0 };
        Ok((frames * self.config.clock_frequency / RATE as u64, *self.host_ns))
    }

    fn start(&mut self) -> Result<(), AudioError> {
        self.sync();
        self.device.started = true;
        self.device.started_at_ns = *self.host_ns;
        self.device.starts += 1;
        Ok(())
    }

    fn stop_and_reset(&mut self) -> Result<(), AudioError> {
        self.sync();
        let device = &mut *self.device;
        device.started = false;
        device.queued = 0;
        device.consumed = 0;
        device.dry = 0;
        device.carry = 0.0;
        device.placed.clear();
        device.resets += 1;
        Ok(())
    }
}

impl Inner {
    fn wake(&mut self) {
        if self.lost {
            self.control.mark_lost();
            return;
        }
        let Some(driver) = self.driver.as_mut() else { return };
        let mut host = self.host_ns;
        let mut endpoint = FakeEndpoint { config: &self.config, host_ns: &mut host, delays: &mut self.delays, host_cell: &self.host_cell, device: &mut self.device, capture: self.capture };
        let failed = driver.wake(&mut endpoint).is_err();
        self.host_ns = host;
        if failed {
            self.lost = true;
            self.control.mark_lost();
        }
    }
}

/// The test's handle on a [`FakeOutput`] the transport owns.
#[derive(Clone)]
pub struct FakeHandle {
    inner: Arc<Mutex<Inner>>,
    pending_wake: Arc<AtomicBool>,
    host: Arc<AtomicU64>,
}

impl FakeHandle {
    /// Moves time forward, waking the device thread at every period boundary on the way (and at once when the transport
    /// activated the stream or posted a command).
    pub fn advance(&self, ns: u64) {
        let mut inner = self.inner.lock().unwrap();
        let target = inner.host_ns + ns;
        loop {
            if self.pending_wake.swap(false, Ordering::SeqCst) {
                inner.wake();
            }
            let period_ns = inner.config.period_frames as u64 * 1_000_000_000 / RATE as u64;
            if inner.next_wake_ns > target {
                break;
            }
            inner.host_ns = inner.next_wake_ns;
            self.host.store(inner.host_ns, Ordering::SeqCst);
            inner.next_wake_ns += period_ns;
            if inner.skip_wakes > 0 {
                inner.skip_wakes -= 1;
            } else {
                inner.wake();
            }
        }
        inner.host_ns = target;
        self.host.store(target, Ordering::SeqCst);
        if self.pending_wake.swap(false, Ordering::SeqCst) {
            inner.wake();
        }
    }

    pub fn advance_ms(&self, ms: u64) {
        self.advance(ms * 1_000_000);
    }

    /// The next `n` wakes do not happen: the thread was late.
    pub fn skip_wakes(&self, n: u32) {
        self.inner.lock().unwrap().skip_wakes = n;
    }

    /// The device is unplugged: every call fails from now on.
    pub fn lose_device(&self) {
        self.inner.lock().unwrap().lost = true;
        self.pending_wake.store(true, Ordering::SeqCst);
        self.advance(0);
    }

    /// The next padding query takes `frames` of stream time (the thread was preempted after it read the position).
    pub fn delay_in_padding(&self, frames: u64) {
        self.inner.lock().unwrap().delays.in_padding = frames;
    }

    /// The next write is submitted `frames` of stream time late (preempted inside the call).
    pub fn delay_in_write(&self, frames: u64) {
        self.inner.lock().unwrap().delays.in_write = frames;
    }

    /// The stereo frame the device is playing now (needs `capture`): the truth a clock reading is held to. `None` while it plays
    /// silence that was not written.
    pub fn heard_content_now(&self) -> Option<[f32; 2]> {
        let mut inner = self.inner.lock().unwrap();
        let inner = &mut *inner;
        let mut host = inner.host_ns;
        let mut endpoint = FakeEndpoint { config: &inner.config, host_ns: &mut host, delays: &mut inner.delays, host_cell: &self.host, device: &mut inner.device, capture: inner.capture };
        endpoint.sync();
        let at = endpoint.device.consumed + endpoint.device.dry;
        inner.device.placed.iter().find(|(start, block)| at >= *start && at < start + block.len() as u64 / 2).map(|(start, block)| {
            let i = (at - start) as usize * 2;
            [block[i], block[i + 1]]
        })
    }

    pub fn set_latency_ns(&self, ns: u64) {
        self.inner.lock().unwrap().config.latency_ns = ns;
    }

    pub fn host_ns(&self) -> u64 {
        self.host.load(Ordering::SeqCst)
    }

    pub fn host_clock(&self) -> Arc<dyn HostClock> {
        Arc::new(FakeHost(self.host.clone()))
    }

    /// Frames the device has played in this epoch.
    pub fn heard_frames(&self) -> u64 {
        self.inner.lock().unwrap().device.consumed
    }

    pub fn queued_frames(&self) -> u64 {
        self.inner.lock().unwrap().device.queued
    }

    /// Resets of the stream (one per transport cancel).
    pub fn resets(&self) -> u64 {
        self.inner.lock().unwrap().device.resets
    }

    pub fn starts(&self) -> u64 {
        self.inner.lock().unwrap().device.starts
    }

    pub fn is_running(&self) -> bool {
        self.inner.lock().unwrap().device.started
    }

    /// Everything the renderer wrote since the last `take_captured`, interleaved stereo (needs `capture`).
    pub fn take_captured(&self) -> Vec<f32> {
        std::mem::take(&mut self.inner.lock().unwrap().device.captured)
    }
}

struct FakeHost(Arc<AtomicU64>);

impl HostClock for FakeHost {
    fn now_ns(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}

pub struct FakeOutput {
    inner: Arc<Mutex<Inner>>,
    clock: Arc<StreamClock>,
    control: Arc<StreamControl>,
    /// The first open can fail (no device); set before `open`.
    pub fail_open: Option<AudioError>,
}

impl FakeOutput {
    /// A device and the handle the test steps it with. `capture` keeps every written sample for the test to read.
    pub fn new(config: FakeConfig, capture: bool) -> (FakeOutput, FakeHandle) {
        let control = StreamControl::new();
        let pending_wake = Arc::new(AtomicBool::new(false));
        {
            let flag = pending_wake.clone();
            control.set_waker(move || flag.store(true, Ordering::SeqCst));
        }
        let period_ns = config.period_frames as u64 * 1_000_000_000 / RATE as u64;
        let host = Arc::new(AtomicU64::new(0));
        let inner = Arc::new(Mutex::new(Inner { config, host_ns: 0, next_wake_ns: period_ns, skip_wakes: 0, lost: false, device: Device::default(), driver: None, control: control.clone(), capture, delays: Delays::default(), host_cell: host.clone() }));
        let handle = FakeHandle { inner: inner.clone(), pending_wake, host };
        (FakeOutput { inner, clock: StreamClock::new(), control, fail_open: None }, handle)
    }
}

impl AudioOutput for FakeOutput {
    fn open(&mut self, source: Box<dyn RenderSource>) -> Result<OutputInfo, AudioError> {
        if let Some(error) = self.fail_open.take() {
            return Err(error);
        }
        let mut inner = self.inner.lock().unwrap();
        inner.driver = Some(StreamDriver::new(source, self.clock.clone(), self.control.clone()));
        let c = &inner.config;
        Ok(OutputInfo {
            device_name: c.device_name.clone(),
            path: Path::Simulated,
            endpoint_rate: c.endpoint_rate,
            endpoint_channels: c.endpoint_channels,
            period_frames: c.period_frames,
            buffer_frames: c.buffer_frames,
            stream_latency_ns: c.latency_ns,
        })
    }

    fn clock(&self) -> Arc<StreamClock> {
        self.clock.clone()
    }

    fn control(&self) -> Arc<StreamControl> {
        self.control.clone()
    }

    fn close(&mut self) {
        self.control.shutdown();
        if let Some(driver) = self.inner.lock().unwrap().driver.take() {
            driver.retire();
        }
    }
}
