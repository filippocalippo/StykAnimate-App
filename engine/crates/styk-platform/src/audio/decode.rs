//! Decoding recordings through the bundled FFmpeg, as today's desktop does (`desktop/audio-service.cjs`): the same arguments,
//! the same limits, the same temporary-file hand-over. The decoded WAV is 48 kHz stereo 16-bit, so imported waveforms and
//! exported soundtracks keep their bytes.
//!
//! The child is the video code's own ([`crate::video::process`]): ended from any thread by its handle, which wakes the wait
//! and closes its pipes. Cancellation is a waker on the shared [`Cancel`]; the 120 s limit is a timer thread that ends the
//! same child. The temporary folder is private to the call and removed on every path; leftovers of a crashed run are swept.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use styk_services::audio::{AudioDecoder, AudioError};
use styk_services::Cancel;

use crate::video::process;

/// `MAX_INPUT`, `MAX_OUTPUT` of the desktop service, and its timeout.
const MAX_INPUT: usize = 32 * 1024 * 1024;
const MAX_OUTPUT: u64 = 48_000 * 2 * 2 * 3600 + 4096;
const TIMEOUT: Duration = Duration::from_secs(120);
/// The diagnostics kept of the decoder (the last bytes of its standard error) and the scratch they are read through.
const TAIL: usize = 2048;
const SCRATCH: usize = 8192;
const PREFIX: &str = "stykanimate-audio-";
/// A folder this old belongs to a run that is gone.
const STALE: Duration = Duration::from_secs(3600);

pub struct FfmpegAudioDecoder {
    program: PathBuf,
    temp_root: PathBuf,
    timeout: Duration,
    child_started: Option<Arc<dyn Fn(process::ChildGuard) + Send + Sync>>,
}

/// A private folder, removed when dropped.
struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

impl FfmpegAudioDecoder {
    /// Decodes with `program` (the bundled `ffmpeg`), working in folders under `temp_root`. Folders left by an earlier run that
    /// ended badly are removed now.
    pub fn new(program: impl Into<PathBuf>, temp_root: impl Into<PathBuf>) -> FfmpegAudioDecoder {
        let decoder = FfmpegAudioDecoder { program: program.into(), temp_root: temp_root.into(), timeout: TIMEOUT, child_started: None };
        decoder.sweep();
        decoder
    }

    pub fn with_timeout(mut self, timeout: Duration) -> FfmpegAudioDecoder {
        self.timeout = timeout;
        self
    }

    /// Observes the child before its timeout starts (test synchronization).
    #[doc(hidden)]
    pub fn with_child_started(mut self, observer: impl Fn(process::ChildGuard) + Send + Sync + 'static) -> Self {
        self.child_started = Some(Arc::new(observer));
        self
    }

    fn sweep(&self) {
        let Ok(entries) = std::fs::read_dir(&self.temp_root) else { return };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let stale = name.to_string_lossy().starts_with(PREFIX) && entry.metadata().and_then(|m| m.modified()).ok().and_then(|t| SystemTime::now().duration_since(t).ok()).is_some_and(|age| age > STALE);
            if stale {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }

    fn scratch(&self) -> Result<Scratch, AudioError> {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        std::fs::create_dir_all(&self.temp_root).map_err(|e| AudioError::Io(e.to_string()))?;
        // A short, generated name: nothing of a user-chosen name reaches the file system.
        let path = self.temp_root.join(format!("{PREFIX}{:x}-{:x}", std::process::id(), COUNTER.fetch_add(1, Ordering::SeqCst)));
        std::fs::create_dir(&path).map_err(|e| AudioError::Io(e.to_string()))?;
        Ok(Scratch(path))
    }

    /// The arguments of today's `finish`.
    pub fn arguments(input: &Path, output: &Path) -> Vec<String> {
        let mut args: Vec<String> = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-protocol_whitelist", "file,pipe", "-format_whitelist", "wav,mp3,flac,ogg,mov,matroska,webm,aac,aiff", "-i"].map(String::from).into();
        args.push(input.to_string_lossy().into_owned());
        args.extend(["-map", "0:a:0", "-vn", "-sn", "-dn", "-t", "3600.001", "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", "-f", "wav"].map(String::from));
        args.push(output.to_string_lossy().into_owned());
        args
    }
}

impl AudioDecoder for FfmpegAudioDecoder {
    fn decode(&self, original: &[u8], _expected_seconds: f64, reserve: &mut dyn FnMut(u64) -> Result<(), AudioError>, cancel: &Cancel) -> Result<Vec<u8>, AudioError> {
        if original.is_empty() || original.len() > MAX_INPUT {
            return Err(AudioError::Decode("Audio recordings must be at most 32 MiB.".into()));
        }
        if cancel.is_cancelled() {
            return Err(AudioError::Cancelled);
        }
        let scratch = self.scratch()?;
        let input = scratch.0.join("input.media");
        let output = scratch.0.join("decoded.wav");
        std::fs::write(&input, original).map_err(|e| AudioError::Io(e.to_string()))?;

        let mut command = Command::new(&self.program);
        command.args(Self::arguments(&input, &output));
        let (child, mut pipes) = process::spawn(&mut command, false).map_err(|_| AudioError::Unavailable("The local audio decoder is unavailable. Rebuild the bundled video encoder.".into()))?;
        // Nothing may leave the child blocked on a full pipe: standard output is drained, the end of standard error is kept.
        let stdout = pipes.stdout.take().map(|mut pipe| std::thread::spawn(move || std::io::copy(&mut pipe, &mut std::io::sink())));
        let stderr = pipes.stderr.take().map(|mut pipe| {
            std::thread::spawn(move || {
                // Drained through a fixed scratch; only the last 2,048 bytes are kept, as today's service keeps them.
                let mut tail: Vec<u8> = Vec::with_capacity(TAIL + SCRATCH);
                let mut scratch = [0u8; SCRATCH];
                while let Ok(n) = pipe.read(&mut scratch) {
                    if n == 0 {
                        break;
                    }
                    tail.extend_from_slice(&scratch[..n]);
                    if tail.len() > TAIL {
                        tail.drain(..tail.len() - TAIL);
                    }
                }
                String::from_utf8_lossy(&tail).into_owned()
            })
        });
        if let Some(observer) = &self.child_started { observer(child.clone()); }
        let timed_out = Arc::new(AtomicBool::new(false));
        let (done, finished) = channel::<()>();
        let timer = {
            let (child, timed_out, limit) = (child.clone(), timed_out.clone(), self.timeout);
            std::thread::spawn(move || {
                if finished.recv_timeout(limit) == Err(RecvTimeoutError::Timeout) {
                    timed_out.store(true, Ordering::SeqCst);
                    child.terminate();
                }
            })
        };
        {
            let child = child.clone();
            cancel.on_cancel(move || child.terminate());
        }
        let status = child.wait();
        drop(done);
        let _ = timer.join();
        // An ended child may have left a grandchild holding its pipes: the readers are not waited for on the paths that end it,
        // they finish by themselves when the pipes close.
        if cancel.is_cancelled() {
            return Err(AudioError::Cancelled);
        }
        if timed_out.load(Ordering::SeqCst) {
            return Err(AudioError::Decode("Audio decoding timed out.".into()));
        }
        let _ = stdout.map(|t| t.join());
        let message = stderr.and_then(|t| t.join().ok()).unwrap_or_default();
        if !status.success() {
            return Err(AudioError::Decode(format!("This recording could not be decoded: {}", message.trim())));
        }
        let size = std::fs::metadata(&output).map_err(|e| AudioError::Io(e.to_string()))?.len();
        if size < 44 || size > MAX_OUTPUT {
            return Err(AudioError::Decode("Decoded audio exceeds the one-hour limit.".into()));
        }
        // The output is reserved before it is read into memory.
        reserve(size)?;
        let mut bytes = Vec::with_capacity(size as usize);
        std::fs::File::open(&output).and_then(|file| file.take(size).read_to_end(&mut bytes)).map_err(|e| AudioError::Io(e.to_string()))?;
        if bytes.len() as u64 != size {
            return Err(AudioError::Decode("Decoded audio is incomplete.".into()));
        }
        Ok(bytes)
    }
}
