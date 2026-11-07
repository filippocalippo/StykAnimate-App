//! The Windows output: a shared-mode, event-driven WASAPI stream on the default render endpoint, with the endpoint format
//! negotiated as `docs/native/audio.md` says, run by [`StreamDriver`] on a thread of the MMCSS "Pro Audio" class.
//!
//! 1. **Direct**: the endpoint's mix format is 48 kHz float: `IAudioClient3::InitializeSharedAudioStream` at the smallest
//!    period the engine reports, in the endpoint's own channel layout (stereo to the front pair, the rest silent).
//! 2. **Converted**: any other endpoint (44.1 kHz, 96 kHz, an integer or odd format) or a refused low-period start: the
//!    ordinary shared mode with `AUTOCONVERTPCM | SRC_DEFAULT_QUALITY`, the system converting rate and channels.
//!
//! Every COM object lives on the output thread. The interface thread holds only the wake event, the clock cell and the
//! control block.

use std::sync::mpsc::channel;
use std::sync::Arc;
use std::thread::JoinHandle;

use styk_services::audio::convert::map_channels;
use styk_services::audio::driver::{Endpoint, StreamDriver};
use styk_services::audio::{AudioError, AudioOutput, HostClock, OutputInfo, Path, RenderSource, StreamClock, StreamControl, RATE};
use windows::core::{w, GUID, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioClient3, IAudioClock, IAudioRenderClient, IMMDeviceEnumerator, MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_E_DEVICE_INVALIDATED, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED};
use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
use windows::Win32::System::Threading::{AvRevertMmThreadCharacteristics, AvSetMmThreadCharacteristicsW, CreateEventW, SetEvent, WaitForMultipleObjects, WaitForSingleObject, INFINITE};

const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;
const WAVE_FORMAT_EXTENSIBLE: u16 = 0xfffe;
/// `AUDCLNT_E_RESOURCES_INVALIDATED`: the endpoint's resources went away (another kind of loss).
const RESOURCES_INVALIDATED: i32 = 0x8889_0026_u32 as i32;
const IEEE_FLOAT: GUID = GUID::from_u128(0x00000003_0000_0010_8000_00aa00389b71);

/// A Win32 event, usable from any thread.
struct Event(HANDLE);

// SAFETY: an event handle may be signalled, waited on and closed from any thread.
unsafe impl Send for Event {}
unsafe impl Sync for Event {}

impl Event {
    fn new() -> Result<Event, AudioError> {
        // SAFETY: plain Win32 call; the handle is owned by the returned value.
        unsafe { CreateEventW(None, false, false, PCWSTR::null()) }.map(Event).map_err(device_error)
    }

    fn set(&self) {
        // SAFETY: the handle is valid until `drop`.
        let _ = unsafe { SetEvent(self.0) };
    }
}

impl Drop for Event {
    fn drop(&mut self) {
        // SAFETY: closed once, here.
        let _ = unsafe { CloseHandle(self.0) };
    }
}

/// An error on the output thread: the system code, no text (nothing is allocated where the device thread runs).
fn raw_error(error: windows::core::Error) -> AudioError {
    let code = error.code();
    if code == AUDCLNT_E_DEVICE_INVALIDATED || code.0 == RESOURCES_INVALIDATED {
        AudioError::DeviceLost
    } else {
        AudioError::Hresult(code.0)
    }
}

fn device_error(error: windows::core::Error) -> AudioError {
    let code = error.code();
    if code == AUDCLNT_E_DEVICE_INVALIDATED || code.0 == RESOURCES_INVALIDATED {
        AudioError::DeviceLost
    } else {
        AudioError::Device(format!("{} (0x{:08x})", error.message(), code.0 as u32))
    }
}

/// QueryPerformanceCounter in nanoseconds: the base the device reports its position timestamps in.
#[derive(Clone, Copy)]
pub struct QpcClock {
    frequency: i64,
}

impl QpcClock {
    pub fn new() -> QpcClock {
        let mut frequency = 0i64;
        // SAFETY: writes one i64.
        let _ = unsafe { QueryPerformanceFrequency(&mut frequency) };
        QpcClock { frequency: frequency.max(1) }
    }
}

impl Default for QpcClock {
    fn default() -> QpcClock {
        QpcClock::new()
    }
}

impl HostClock for QpcClock {
    fn now_ns(&self) -> u64 {
        let mut counter = 0i64;
        // SAFETY: writes one i64.
        let _ = unsafe { QueryPerformanceCounter(&mut counter) };
        (counter as u128 * 1_000_000_000 / self.frequency as u128) as u64
    }
}

/// The stream, as the driver sees the device.
struct Stream {
    client: IAudioClient3,
    render: IAudioRenderClient,
    position: IAudioClock,
    buffer_event: Event,
    buffer_frames: u32,
    frequency: u64,
    /// The channel count and layout of the buffer; 2 when the system converts.
    channels: u16,
    mask: u32,
    /// Stereo scratch for a direct stream with other than two channels.
    scratch: Vec<f32>,
    info: OutputInfo,
    clock: QpcClock,
}

impl Stream {
    /// Opens the default render endpoint: direct when its mix format allows, else converted.
    ///
    /// SAFETY: COM must be initialised on this thread, and the stream must stay on it.
    unsafe fn open(allow_direct: bool) -> Result<Stream, AudioError> {
        let enumerator: IMMDeviceEnumerator = unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }.map_err(device_error)?;
        let device = unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole) }.map_err(|e| match device_error(e) {
            AudioError::Device(m) => AudioError::Unavailable(format!("There is no audio output device: {m}")),
            other => other,
        })?;
        let probe: IAudioClient3 = unsafe { device.Activate(CLSCTX_ALL, None) }.map_err(device_error)?;
        let mix = unsafe { probe.GetMixFormat() }.map_err(device_error)?;
        // SAFETY: the format is a CoTaskMem block of at least a WAVEFORMATEX; packed fields are read by value.
        let format = unsafe { std::ptr::read_unaligned(mix) };
        let (tag, channels, rate, bits, extra) = (format.wFormatTag, format.nChannels, format.nSamplesPerSec, format.wBitsPerSample, format.cbSize);
        let (mask, float) = if tag == WAVE_FORMAT_EXTENSIBLE && extra >= 22 {
            let ext = unsafe { std::ptr::read_unaligned(mix as *const WAVEFORMATEXTENSIBLE) };
            let (mask, sub) = (ext.dwChannelMask, ext.SubFormat);
            (mask, sub == IEEE_FLOAT)
        } else {
            (0, tag == WAVE_FORMAT_IEEE_FLOAT)
        };
        let direct = allow_direct && float && bits == 32 && rate == RATE && channels >= 1;
        let mut opened = None;
        if direct {
            let (mut default, mut fundamental, mut least, mut most) = (0u32, 0u32, 0u32, 0u32);
            if unsafe { probe.GetSharedModeEnginePeriod(mix, &mut default, &mut fundamental, &mut least, &mut most) }.is_ok() && unsafe { probe.InitializeSharedAudioStream(AUDCLNT_STREAMFLAGS_EVENTCALLBACK, least, mix, None) }.is_ok() {
                opened = Some((probe.clone(), Path::Direct, channels, mask, least));
            }
        }
        unsafe { CoTaskMemFree(Some(mix as *const _)) };
        let (client, path, channels, mask, period) = match opened {
            Some(found) => found,
            None => {
                // The ordinary shared mode with the system converting. A client whose initialisation was refused is not reused.
                let client: IAudioClient3 = unsafe { device.Activate(CLSCTX_ALL, None) }.map_err(device_error)?;
                let wanted = WAVEFORMATEX { wFormatTag: WAVE_FORMAT_IEEE_FLOAT, nChannels: 2, nSamplesPerSec: RATE, nAvgBytesPerSec: RATE * 8, nBlockAlign: 8, wBitsPerSample: 32, cbSize: 0 };
                let flags = AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
                unsafe { client.Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 0, 0, &wanted, None) }.map_err(device_error)?;
                let mut default_period = 0i64;
                let _ = unsafe { client.GetDevicePeriod(Some(&mut default_period), None) };
                (client, Path::Converted, 2, 0, (default_period.max(0) as u64 * RATE as u64 / 10_000_000) as u32)
            }
        };
        let buffer_event = Event::new()?;
        unsafe { client.SetEventHandle(buffer_event.0) }.map_err(device_error)?;
        let buffer_frames = unsafe { client.GetBufferSize() }.map_err(device_error)?;
        let render: IAudioRenderClient = unsafe { client.GetService() }.map_err(device_error)?;
        let position: IAudioClock = unsafe { client.GetService() }.map_err(device_error)?;
        let frequency = unsafe { position.GetFrequency() }.map_err(device_error)?;
        let latency = unsafe { client.GetStreamLatency() }.unwrap_or(0).max(0) as u64 * 100;
        let info = OutputInfo { device_name: "Default audio output".into(), path, endpoint_rate: rate, endpoint_channels: channels, period_frames: period, buffer_frames, stream_latency_ns: latency };
        let scratch = if channels == 2 { Vec::new() } else { Vec::with_capacity(buffer_frames as usize * 2) };
        Ok(Stream { client, render, position, buffer_event, buffer_frames, frequency, channels, mask, scratch, info, clock: QpcClock::new() })
    }
}

impl Endpoint for Stream {
    fn buffer_frames(&self) -> u32 {
        self.buffer_frames
    }

    fn frequency(&self) -> u64 {
        self.frequency
    }

    fn padding(&mut self) -> Result<u32, AudioError> {
        // SAFETY: called on the output thread that owns the client.
        unsafe { self.client.GetCurrentPadding() }.map_err(raw_error)
    }

    fn write(&mut self, frames: u32, fill: &mut dyn FnMut(&mut [f32]) -> bool) -> Result<u64, AudioError> {
        // SAFETY: the buffer GetBuffer returns holds `frames` frames of the stream's format until ReleaseBuffer.
        unsafe {
            let data = self.render.GetBuffer(frames).map_err(raw_error)?;
            let kept = if self.channels == 2 {
                fill(std::slice::from_raw_parts_mut(data as *mut f32, frames as usize * 2))
            } else {
                self.scratch.clear();
                self.scratch.resize(frames as usize * 2, 0.0);
                let kept = fill(&mut self.scratch);
                map_channels(&self.scratch, std::slice::from_raw_parts_mut(data as *mut f32, frames as usize * self.channels as usize), self.channels, self.mask);
                kept
            };
            let submitted = self.clock.now_ns();
            self.render.ReleaseBuffer(frames, if kept { 0 } else { AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 }).map_err(raw_error)?;
            Ok(submitted)
        }
    }

    fn position(&mut self) -> Result<(u64, u64), AudioError> {
        let (mut position, mut qpc) = (0u64, 0u64);
        // SAFETY: writes two u64.
        unsafe { self.position.GetPosition(&mut position, Some(&mut qpc)) }.map_err(raw_error)?;
        // The pair's time is QPC in 100 ns units.
        Ok((position, qpc * 100))
    }

    fn start(&mut self) -> Result<(), AudioError> {
        // SAFETY: the output thread owns the client.
        unsafe { self.client.Start() }.map_err(raw_error)
    }

    fn stop_and_reset(&mut self) -> Result<(), AudioError> {
        // SAFETY: as above. Reset needs a stopped stream.
        unsafe {
            self.client.Stop().map_err(raw_error)?;
            self.client.Reset().map_err(raw_error)
        }
    }
}

pub struct WasapiOutput {
    control: Arc<StreamControl>,
    clock: Arc<StreamClock>,
    wake: Arc<Event>,
    thread: Option<JoinHandle<()>>,
    allow_direct: bool,
}

impl WasapiOutput {
    pub fn new() -> Result<WasapiOutput, AudioError> {
        Ok(WasapiOutput { control: StreamControl::new(), clock: StreamClock::new(), wake: Arc::new(Event::new()?), thread: None, allow_direct: true })
    }

    /// An output that never takes the low-period direct path: the ordinary shared mode with the system converting. It is what a
    /// 44.1 kHz or 96 kHz endpoint gets, and what the direct path falls back to; this makes it testable on any endpoint.
    pub fn converted_only() -> Result<WasapiOutput, AudioError> {
        let mut output = WasapiOutput::new()?;
        output.allow_direct = false;
        Ok(output)
    }
}

fn run(allow_direct: bool, source: Box<dyn RenderSource>, clock: Arc<StreamClock>, control: Arc<StreamControl>, wake: Arc<Event>, opened: std::sync::mpsc::Sender<Result<OutputInfo, AudioError>>) {
    // SAFETY: COM is initialised and released on this thread, and every COM object is created and dropped on it.
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let mut task_index = 0u32;
        let mmcss = AvSetMmThreadCharacteristicsW(w!("Pro Audio"), &mut task_index).ok();
        match Stream::open(allow_direct) {
            Err(error) => {
                let _ = opened.send(Err(error));
            }
            Ok(mut stream) => {
                let _ = opened.send(Ok(stream.info.clone()));
                let mut driver = StreamDriver::new(source, clock, control.clone());
                let handles = [stream.buffer_event.0, wake.0];
                while !control.is_shutdown() {
                    if driver.is_running() {
                        // A device that stops signalling is still looked at every 100 ms.
                        WaitForMultipleObjects(&handles, false, 100);
                    } else {
                        WaitForSingleObject(wake.0, INFINITE);
                    }
                    if control.is_shutdown() {
                        break;
                    }
                    if driver.wake(&mut stream).is_err() {
                        control.mark_lost();
                        break;
                    }
                }
                let _ = stream.client.Stop();
                // Whatever the renderer holds leaves for the thread that closes the output, on every way out of the loop.
                driver.retire();
            }
        }
        if let Some(handle) = mmcss {
            let _ = AvRevertMmThreadCharacteristics(handle);
        }
        CoUninitialize();
    }
}

impl AudioOutput for WasapiOutput {
    fn open(&mut self, source: Box<dyn RenderSource>) -> Result<OutputInfo, AudioError> {
        if self.thread.is_some() {
            return Err(AudioError::Device("the output is already open".into()));
        }
        let wake = self.wake.clone();
        self.control.set_waker(move || wake.set());
        let (opened, result) = channel();
        let (clock, control, wake, allow_direct) = (self.clock.clone(), self.control.clone(), self.wake.clone(), self.allow_direct);
        let thread = std::thread::Builder::new().name("styk audio output".into()).spawn(move || run(allow_direct, source, clock, control, wake, opened)).map_err(|e| AudioError::Device(e.to_string()))?;
        match result.recv() {
            Ok(Ok(info)) => {
                self.thread = Some(thread);
                Ok(info)
            }
            Ok(Err(error)) => {
                let _ = thread.join();
                Err(error)
            }
            Err(_) => Err(AudioError::Device("the audio output thread ended while opening".into())),
        }
    }

    fn clock(&self) -> Arc<StreamClock> {
        self.clock.clone()
    }

    fn control(&self) -> Arc<StreamControl> {
        self.control.clone()
    }

    fn close(&mut self) {
        self.control.shutdown();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for WasapiOutput {
    fn drop(&mut self) {
        self.close();
    }
}
