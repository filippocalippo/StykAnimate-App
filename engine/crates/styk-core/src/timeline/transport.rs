//! Playback pacing with injected time and explicit submission acknowledgement. No timer, document or frame cache.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum State {
    #[default]
    Paused,
    Starting,
    Playing,
    Buffering,
}
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Model {
    pub state: State,
    pub looping: bool,
    pub range: Option<(u32, u32)>,
    pub shown_frames: u64,
    pub measured_fps: Option<f64>,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Audio {
    Silent,
    Preparing,
    Starting,
    Running(f64),
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Demand {
    pub token: u64,
    pub tick: f64,
}
#[derive(Default)]
pub struct Transport {
    pub model: Model,
    generation: u64,
    pending: Option<Demand>,
    start_tick: f64,
    deadline: Option<f64>,
    readout: Option<u64>,
    started_at: u64,
    presented: u64,
    audio_retry: Option<u64>,
    presentations: std::collections::VecDeque<(u64, u64)>,
}
pub fn normalize(range: Option<(u32, u32)>, total: u32) -> (u32, u32) {
    if total == 0 {
        return (0, 0);
    }
    match range {
        Some((first, last)) => {
            let first = first.min(total - 1);
            (first, last.max(first + 1).min(total))
        }
        None => (0, total),
    }
}
pub fn startup_frames(fps: f64, compile_ms: f64, cores: usize) -> usize {
    let seconds = if compile_ms > 500. / fps { 0.25 } else { 0.1 };
    let lookahead = (24. * (cores as f64 / 8.).min(1.)).round().max(8.) as usize;
    lookahead.min((fps * seconds).ceil().max(2.) as usize)
}
impl Transport {
    pub fn playing(&self) -> bool {
        self.model.state != State::Paused
    }
    pub fn pending(&self) -> Option<Demand> {
        self.pending
    }
    pub fn start(&mut self, tick: f64, total: u32, now: u64) -> bool {
        let (first, end) = normalize(self.model.range, total);
        if end <= first {
            return false;
        }
        self.pause();
        self.start_tick = if tick < first as f64 || tick >= (end - 1) as f64 { first as f64 } else { tick };
        self.model.state = State::Starting;
        self.deadline = Some(now as f64);
        self.readout = Some(now.saturating_add(250));
        self.presentations.clear();
        self.started_at = now;
        self.presented = 0;
        self.model.shown_frames = 0;
        self.model.measured_fps = None;
        true
    }
    pub fn pause(&mut self) {
        self.model.state = State::Paused;
        self.pending = None;
        self.deadline = None;
        self.readout = None;
        self.audio_retry = None;
        self.generation = self.generation.wrapping_add(1);
    }
    pub fn range(&mut self, range: Option<(u32, u32)>, total: u32) {
        self.model.range = range.map(|range| normalize(Some(range), total));
    }
    pub fn tick(&mut self, now: u64, tick: f64, fps: f64, total: u32, audio: Audio, ready: bool) -> Option<Demand> {
        if !self.playing() || !fps.is_finite() || fps <= 0. {
            return None;
        }
        self.observe(now);
        if self.pending.is_some() {
            return None;
        }
        self.audio_retry = None;
        if audio == Audio::Preparing {
            self.audio_retry = Some(now.saturating_add(200));
            return None;
        }
        if audio == Audio::Starting {
            self.audio_retry = Some(now.saturating_add((1000. / fps).ceil() as u64));
            return None;
        }
        if self.deadline.is_some_and(|at| (now as f64) < at) {
            return None;
        }
        if let Audio::Running(seconds) = audio {
            if self.model.state != State::Starting && seconds + 0.00001 < (tick + 1.) / fps {
                self.audio_retry = Some(now.saturating_add((((tick + 1.) / fps - seconds) * 1000.).ceil().max(1.) as u64));
                return None;
            }
        }
        let Some(next) = self.next(tick, total) else {
            self.pause();
            return None;
        };
        if !ready {
            if self.model.state != State::Starting {
                self.model.state = State::Buffering;
            }
            return None;
        }
        self.generation = self.generation.wrapping_add(1);
        let demand = Demand { token: self.generation, tick: next };
        self.pending = Some(demand);
        Some(demand)
    }
    pub fn observe(&mut self, now: u64) {
        if self.readout.is_some_and(|at| now >= at) {
            self.trim(now);
            self.model.shown_frames = self.presented;
            let elapsed = now.saturating_sub(self.started_at);
            self.model.measured_fps = (elapsed >= 500)
                .then(|| self.presentations.iter().map(|(_, count)| count).sum::<u64>() as f64 * 1000. / elapsed.min(1000) as f64);
            self.readout = Some(now.saturating_add(250));
        }
    }
    fn trim(&mut self, now: u64) {
        while self.presentations.front().is_some_and(|(at, _)| at.saturating_add(1000) <= now) {
            self.presentations.pop_front();
        }
    }
    pub fn next(&self, tick: f64, total: u32) -> Option<f64> {
        if !self.playing() {
            return None;
        }
        let (first, end) = normalize(self.model.range, total);
        if end <= first {
            return None;
        }
        let next = if self.model.state == State::Starting { self.start_tick.max(first as f64).min((end - 1) as f64) } else { tick + 1. };
        if next >= end as f64 { if self.model.looping { Some(first as f64) } else { None } } else { Some(next) }
    }
    pub fn submitted(&mut self, demand: Demand, now: u64, fps: f64) -> bool {
        if self.pending != Some(demand) || !self.playing() {
            return false;
        }
        self.pending = None;
        self.presented += 1;
        self.trim(now);
        // At most 1000 distinct millisecond buckets; same-time submissions aggregate without losing a presentation.
        if let Some((at, count)) = self.presentations.back_mut().filter(|(at, _)| *at == now) {
            let _ = at;
            *count += 1;
        } else {
            self.presentations.push_back((now, 1));
        }
        let interval = 1000. / fps;
        self.deadline = Some(if self.model.state != State::Playing {
            now as f64 + interval
        } else {
            (self.deadline.unwrap_or(now as f64) + interval).max(now as f64)
        });
        self.model.state = State::Playing;
        true
    }
    pub fn deadline(&self) -> Option<u64> {
        // While awaiting a picture, worker/submission wakes drive progress; only the slow readout has a timer.
        let frame = self.audio_retry.or_else(|| {
            (self.model.state == State::Playing && self.pending.is_none()).then_some(self.deadline).flatten().map(|n| n.ceil() as u64)
        });
        [frame, self.readout].into_iter().flatten().min()
    }
}

/// Exact automatic-quality policy from preview-quality.mjs; thresholds are the reference contract.
#[derive(Default)]
pub struct Quality {
    pub index: usize,
    low_since: Option<u64>,
    high_since: Option<u64>,
    changed_at: u64,
}
impl Quality {
    pub fn update(&mut self, fps: Option<f64>, target: f64, now: u64, buffering: bool) -> bool {
        let Some(fps) = fps.filter(|fps| fps.is_finite() && target.is_finite() && target > 0. && !buffering) else {
            self.low_since = None;
            self.high_since = None;
            return false;
        };
        self.low_since = (fps < target * 0.92).then(|| self.low_since.unwrap_or(now));
        self.high_since = (fps >= target * 0.98 && self.index > 0).then(|| self.high_since.unwrap_or(now));
        if now.saturating_sub(self.changed_at) <= 2500 {
            return false;
        }
        if self.index < 2 && self.low_since.is_some_and(|at| now.saturating_sub(at) > 2000) {
            self.index += 1;
        } else if self.index > 0 && self.high_since.is_some_and(|at| now.saturating_sub(at) > 6000) {
            self.index -= 1;
        } else {
            return false;
        }
        self.changed_at = now;
        self.low_since = None;
        self.high_since = None;
        true
    }
}
