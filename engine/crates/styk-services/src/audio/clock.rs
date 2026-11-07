//! The stream clock: which project sample is being heard.
//!
//! The device thread (the [`super::StreamDriver`]) is the only writer. It keeps a [`ClockState`] and stores it, whole and
//! consistent, into the shared [`StreamClock`], a seqlock over atomic words: a reader on the interface thread copies the words
//! and retries if the writer was in the middle; it never blocks, waits or makes a system call.
//!
//! Units: the stream is 48 kHz, so a *stream frame* is 1/48000 s and, for the renderer, a project sample. The device position
//! is in the units of its own frequency; converting is the reader's job and uses the frequency stored beside the position,
//! never an assumed 48000. Host times are nanoseconds of the host clock (QPC on Windows).

use std::sync::atomic::{fence, AtomicU64, Ordering};
use std::sync::Arc;

use super::RATE;

/// Segments kept: a few seconds of periods, far more than the device's latency.
pub const RING: usize = 64;
const HEADER: usize = 12;
const SEGMENT_WORDS: usize = 4;
const WORDS: usize = HEADER + RING * SEGMENT_WORDS;

/// A stretch of the stream. `Playing`: stream frames `stream_start..+frames` are project samples `project..`. Otherwise it is
/// silence that is not project time and the media time holds at `project`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Segment {
    pub stream_start: u64,
    pub frames: u64,
    pub playing: bool,
    pub project: i64,
}

/// Everything the writer knows, for one epoch of the stream (an epoch begins at every device reset).
#[derive(Clone, Copy, Debug)]
pub struct ClockState {
    pub epoch: u64,
    /// The generation of the transport command the renderer is under.
    pub generation: u64,
    /// The stream is running (not idle).
    pub active: bool,
    /// The device has reported a position past 0 in this epoch: the first frame has reached the endpoint.
    pub device_valid: bool,
    /// Stream frames written to the device in this epoch, silence included.
    pub rendered: u64,
    /// The device position, in the units of `frequency`, and the host time (ns) it was taken at.
    pub position: u64,
    pub frequency: u64,
    pub host_ns: u64,
    pub underruns: u64,
    pub len: usize,
    pub segments: [Segment; RING],
}

impl Default for ClockState {
    fn default() -> ClockState {
        ClockState { epoch: 0, generation: 0, active: false, device_valid: false, rendered: 0, position: 0, frequency: RATE as u64, host_ns: 0, underruns: 0, len: 0, segments: [Segment::default(); RING] }
    }
}

impl ClockState {
    /// A new epoch: the device was reset, its position is 0 again.
    pub fn begin_epoch(&mut self) {
        self.epoch += 1;
        self.active = true;
        self.device_valid = false;
        self.rendered = 0;
        self.position = 0;
        self.host_ns = 0;
        self.len = 0;
    }

    /// The end of an epoch: nothing is queued, nothing is mapped.
    pub fn end_epoch(&mut self) {
        self.active = false;
        self.device_valid = false;
        self.rendered = 0;
        self.position = 0;
        self.len = 0;
    }

    /// Appends a stretch after the last, extending it when it continues it.
    pub fn push(&mut self, segment: Segment) {
        if segment.frames == 0 {
            return;
        }
        if let Some(last) = self.segments[..self.len].last_mut() {
            let contiguous = last.stream_start + last.frames == segment.stream_start;
            let continues = if segment.playing { last.playing && last.project + last.frames as i64 == segment.project } else { !last.playing && last.project == segment.project };
            if contiguous && continues {
                last.frames += segment.frames;
                return;
            }
        }
        if self.len == RING {
            self.segments.copy_within(1.., 0);
            self.len -= 1;
        }
        self.segments[self.len] = segment;
        self.len += 1;
    }

    /// Where the media is, as the project sample (fractional) the listener hears at host time `host_ns`.
    pub fn reading(&self, host_ns: u64, expected_generation: u64) -> Reading {
        if self.generation != expected_generation {
            return Reading::Pending;
        }
        if !self.active {
            return Reading::Stopped;
        }
        if !self.device_valid || self.len == 0 {
            return Reading::Starting;
        }
        let rate = RATE as f64;
        let at_anchor = self.position as f64 * rate / self.frequency.max(1) as f64;
        let since = (host_ns as f64 - self.host_ns as f64) * rate / 1e9;
        let heard = (at_anchor + since).clamp(0.0, self.rendered as f64);
        let segments = &self.segments[..self.len];
        let segment = segments.iter().rev().find(|s| s.stream_start as f64 <= heard).unwrap_or(&segments[0]);
        let into = (heard - segment.stream_start as f64).clamp(0.0, segment.frames as f64);
        if segment.playing {
            Reading::Running { sample: segment.project as f64 + into, held: false }
        } else {
            Reading::Running { sample: segment.project as f64, held: true }
        }
    }
}

/// What the transport sees of the stream under the generation it issued.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Reading {
    /// The output has not applied the transport's latest command yet.
    Pending,
    /// Applied, and the stream is idle.
    Stopped,
    /// Applied and running, but no frame has reached the endpoint yet.
    Starting,
    /// `sample` is the project sample being heard (fractional); `held` is true in silence past the end of the range or in a gap.
    Running { sample: f64, held: bool },
}

/// The shared, lock-free copy of the writer's [`ClockState`].
pub struct StreamClock {
    seq: AtomicU64,
    words: [AtomicU64; WORDS],
}

impl StreamClock {
    pub fn new() -> Arc<StreamClock> {
        Arc::new(StreamClock { seq: AtomicU64::new(0), words: std::array::from_fn(|_| AtomicU64::new(0)) })
    }

    /// Publishes `state`. One writer only.
    pub fn store(&self, state: &ClockState) {
        let start = self.seq.load(Ordering::Relaxed);
        self.seq.store(start + 1, Ordering::Relaxed);
        fence(Ordering::Release);
        let flags = state.active as u64 | (state.device_valid as u64) << 1;
        let header = [state.epoch, state.generation, flags, state.rendered, state.position, state.frequency, state.host_ns, state.underruns, state.len as u64];
        for (word, value) in self.words.iter().zip(header) {
            word.store(value, Ordering::Relaxed);
        }
        for (i, segment) in state.segments[..state.len].iter().enumerate() {
            let at = HEADER + i * SEGMENT_WORDS;
            self.words[at].store(segment.stream_start, Ordering::Relaxed);
            self.words[at + 1].store(segment.frames, Ordering::Relaxed);
            self.words[at + 2].store(segment.playing as u64, Ordering::Relaxed);
            self.words[at + 3].store(segment.project as u64, Ordering::Relaxed);
        }
        self.seq.store(start + 2, Ordering::Release);
    }

    /// A consistent copy, or `None` when the writer kept interrupting (the caller keeps its last reading).
    pub fn load(&self) -> Option<ClockState> {
        for _ in 0..16 {
            let before = self.seq.load(Ordering::Acquire);
            if before & 1 == 1 {
                std::hint::spin_loop();
                continue;
            }
            let word = |i: usize| self.words[i].load(Ordering::Relaxed);
            let mut state = ClockState { epoch: word(0), generation: word(1), rendered: word(3), position: word(4), frequency: word(5), host_ns: word(6), underruns: word(7), len: (word(8) as usize).min(RING), ..ClockState::default() };
            let flags = word(2);
            state.active = flags & 1 == 1;
            state.device_valid = flags & 2 == 2;
            for i in 0..state.len {
                let at = HEADER + i * SEGMENT_WORDS;
                state.segments[i] = Segment { stream_start: word(at), frames: word(at + 1), playing: word(at + 2) == 1, project: word(at + 3) as i64 };
            }
            fence(Ordering::Acquire);
            if self.seq.load(Ordering::Relaxed) == before {
                return Some(state);
            }
        }
        None
    }

    /// `load` then [`ClockState::reading`].
    pub fn read(&self, host_ns: u64, expected_generation: u64) -> Option<Reading> {
        self.load().map(|state| state.reading(host_ns, expected_generation))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(generation: u64) -> ClockState {
        let mut s = ClockState { generation, ..ClockState::default() };
        s.begin_epoch();
        s
    }

    #[test]
    fn a_reading_waits_for_its_generation_and_for_the_first_heard_frame() {
        let mut s = state(7);
        s.push(Segment { stream_start: 0, frames: 480, playing: true, project: 48_000 });
        s.rendered = 480;
        assert_eq!(s.reading(0, 8), Reading::Pending, "the output has not applied generation 8");
        assert_eq!(s.reading(0, 7), Reading::Starting, "applied, but the device has not played a frame yet");
        s.position = 100;
        s.host_ns = 1_000_000;
        s.device_valid = true;
        assert_eq!(s.reading(1_000_000, 7), Reading::Running { sample: 48_100.0, held: false });
        s.end_epoch();
        assert_eq!(s.reading(0, 7), Reading::Stopped);
    }

    #[test]
    fn the_frequency_of_the_device_position_is_used_not_assumed() {
        // The same instant heard through a clock counting 44100 and 10 MHz per second.
        for frequency in [44_100u64, 96_000, 10_000_000, 48_000] {
            let mut s = state(1);
            s.push(Segment { stream_start: 0, frames: 48_000, playing: true, project: 1000 });
            s.rendered = 48_000;
            s.frequency = frequency;
            s.position = frequency / 2; // half a second heard
            s.host_ns = 5_000_000_000;
            s.device_valid = true;
            let Reading::Running { sample, .. } = s.reading(5_000_000_000, 1) else { panic!("running") };
            assert!((sample - (1000.0 + 24_000.0)).abs() < 1e-6, "{frequency}: {sample}");
            // 10 ms later by the host clock the media has moved 480 samples, whatever the device units are.
            let Reading::Running { sample, .. } = s.reading(5_010_000_000, 1) else { panic!("running") };
            assert!((sample - (1000.0 + 24_480.0)).abs() < 1e-6, "{frequency}: {sample}");
        }
    }

    #[test]
    fn the_reading_never_runs_past_what_was_written_and_follows_segments() {
        let mut s = state(1);
        s.push(Segment { stream_start: 0, frames: 480, playing: true, project: 0 });
        s.push(Segment { stream_start: 480, frames: 480, playing: true, project: 480 });
        assert_eq!(s.len, 1, "contiguous stretches coalesce");
        s.push(Segment { stream_start: 960, frames: 480, playing: false, project: 960 });
        s.push(Segment { stream_start: 1440, frames: 480, playing: true, project: 960 });
        assert_eq!(s.len, 3);
        s.rendered = 1920;
        s.device_valid = true;
        s.position = 1000;
        s.host_ns = 0;
        assert_eq!(s.reading(0, 1), Reading::Running { sample: 960.0, held: true }, "silence holds the media time");
        s.position = 1500;
        assert_eq!(s.reading(0, 1), Reading::Running { sample: 960.0 + 60.0, held: false });
        assert_eq!(s.reading(10_000_000_000, 1), Reading::Running { sample: 960.0 + 480.0, held: false }, "extrapolation stops at what was written");
    }

    #[test]
    fn the_ring_keeps_the_newest_segments() {
        let mut s = state(1);
        for i in 0..(RING as u64 + 10) {
            s.push(Segment { stream_start: i * 10, frames: 10, playing: i % 2 == 0, project: (i * 1000) as i64 });
        }
        assert_eq!(s.len, RING);
        assert_eq!(s.segments[RING - 1].stream_start, (RING as u64 + 9) * 10);
        assert_eq!(s.segments[0].stream_start, 10 * 10);
    }

    #[test]
    fn a_reader_never_sees_a_torn_state_while_the_writer_runs() {
        let clock = StreamClock::new();
        let writer = {
            let clock = clock.clone();
            std::thread::spawn(move || {
                let mut s = state(0);
                for n in 1..=200_000u64 {
                    s.generation = n;
                    s.rendered = n;
                    s.position = n;
                    s.host_ns = n;
                    s.underruns = n;
                    s.len = 0;
                    s.push(Segment { stream_start: n, frames: n, playing: true, project: n as i64 });
                    clock.store(&s);
                }
            })
        };
        let mut seen = 0u64;
        while !writer.is_finished() {
            if let Some(s) = clock.load() {
                let n = s.generation;
                assert!(s.rendered == n && s.position == n && s.host_ns == n && s.underruns == n, "a torn read at {n}");
                if n > 0 {
                    assert_eq!((s.len, s.segments[0].stream_start, s.segments[0].frames), (1, n, n));
                }
                assert!(n >= seen, "time went backwards");
                seen = n;
            }
        }
        writer.join().unwrap();
        assert_eq!(clock.load().unwrap().generation, 200_000);
    }
}
