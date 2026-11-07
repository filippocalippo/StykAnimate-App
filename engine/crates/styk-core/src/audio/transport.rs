//! The transport: playing, stopping and scrubbing the mix, and the clock the frame scheduler follows.
//!
//! The interface thread talks to the output thread through a **single mailbox** (an atomic pointer). A newer command replaces
//! an unread older one, so a Stop can never be lost behind a full queue and nothing is queued that could overflow; the
//! replaced command comes back to the sender, who gives it to the reclaimer thread. The output thread never allocates, locks,
//! waits or frees: when it applies a command it moves the plan it was playing into the command's envelope and pushes that
//! envelope on a lock-free stack of spent ones; the sender takes the stack on every call and hands the envelopes to the
//! reclaimer, so the large buffers are freed on neither of those two threads. Events from the output thread are state, not
//! messages (the clock's generation and underrun count, the control's lost flag), so none can be dropped.
//! Design: `docs/native/audio.md`.

use std::collections::VecDeque;
use std::mem::ManuallyDrop;
use std::ptr;
use std::sync::atomic::{AtomicPtr, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;

use styk_services::audio::clock::Reading;
use styk_services::audio::{AudioDecoder, AudioError, AudioOutput, HostClock, Next, OutputInfo, RenderResult, RenderSource, StreamClock, StreamControl};
use styk_services::Cancel;

use super::model::{AudioState, RATE};
use super::plan::{build_plan, MixPlan};
use super::store::{Budget, SourceStore};

/// A scrub slice: 80 ms (`app.mjs`), and a retrigger no sooner than 100 ms after the last.
const SCRUB_SAMPLES: u64 = 3840;
const SCRUB_INTERVAL_NS: u64 = 100_000_000;

enum Command {
    Play { generation: u64, plan: Arc<MixPlan>, from: u64, end: u64 },
    Stop { generation: u64 },
    /// The plan has been taken by the renderer.
    Spent,
}

/// A command and the plan it replaced, travelling between the threads without allocating.
struct Envelope {
    command: Command,
    retired: Option<Arc<MixPlan>>,
    next: *mut Envelope,
}

// SAFETY: `next` is only touched by the thread that owns the envelope or by the stack's push and take, which hand it over whole.
unsafe impl Send for Envelope {}

struct Shared {
    mailbox: AtomicPtr<Envelope>,
    /// A stack of spent envelopes (the renderer pushes, the transport takes the whole stack).
    spent: AtomicPtr<Envelope>,
}

impl Shared {
    fn new() -> Arc<Shared> {
        Arc::new(Shared { mailbox: AtomicPtr::new(ptr::null_mut()), spent: AtomicPtr::new(ptr::null_mut()) })
    }

    /// Posts `command`; an unread command it replaces comes back.
    fn post(&self, command: Command) -> Option<Box<Envelope>> {
        let envelope = Box::into_raw(Box::new(Envelope { command, retired: None, next: ptr::null_mut() }));
        let old = self.mailbox.swap(envelope, Ordering::AcqRel);
        // SAFETY: a pointer swapped out of the mailbox is owned by whoever swapped it out; the renderer swaps with null and
        // never frees, so this one was made by `post` and nobody else has it.
        (!old.is_null()).then(|| unsafe { Box::from_raw(old) })
    }

    /// The output thread: the waiting command, if any. The envelope stays alive until the transport reclaims it.
    fn take_command(&self) -> *mut Envelope {
        self.mailbox.swap(ptr::null_mut(), Ordering::AcqRel)
    }

    /// The output thread: hands a spent envelope to the transport.
    fn push_spent(&self, envelope: *mut Envelope) {
        let mut head = self.spent.load(Ordering::Acquire);
        loop {
            // SAFETY: the renderer owns `envelope` until the exchange succeeds.
            unsafe { (*envelope).next = head };
            match self.spent.compare_exchange_weak(head, envelope, Ordering::AcqRel, Ordering::Acquire) {
                Ok(_) => return,
                Err(actual) => head = actual,
            }
        }
    }

    /// The transport: every envelope the output thread has spent.
    fn take_spent(&self) -> Vec<Box<Envelope>> {
        let mut head = self.spent.swap(ptr::null_mut(), Ordering::AcqRel);
        let mut envelopes = Vec::new();
        while !head.is_null() {
            // SAFETY: the stack was swapped out whole, so these envelopes belong to this thread now.
            let envelope = unsafe { Box::from_raw(head) };
            head = envelope.next;
            envelopes.push(envelope);
        }
        envelopes
    }
}

impl Drop for Shared {
    fn drop(&mut self) {
        // Both ends are gone: free what is left in the mailbox and on the stack.
        for mut head in [*self.mailbox.get_mut(), *self.spent.get_mut()] {
            while !head.is_null() {
                // SAFETY: nothing else holds the shared state any more, and each envelope is on exactly one of the two lists.
                let envelope = unsafe { Box::from_raw(head) };
                head = envelope.next;
            }
        }
    }
}

/// The renderer the output thread calls: applies commands, mixes blocks. No locks, allocation or frees.
struct Renderer {
    shared: Arc<Shared>,
    plan: Option<Arc<MixPlan>>,
    playing: bool,
    next_sample: u64,
    end_sample: u64,
    /// The generation of the last command applied.
    generation: u64,
}

impl Renderer {
    /// Applies the waiting command, if any: `Restart` when it replaces a play that was running, `Idle` when it stops one.
    fn apply_command(&mut self) -> Next {
        let was_playing = self.playing;
        let envelope = self.shared.take_command();
        if envelope.is_null() {
            return Next::Continue;
        }
        let mut next = Next::Continue;
        // SAFETY: the envelope was swapped out of the mailbox, so this thread owns it until it is pushed as spent.
        let spent = unsafe { &mut *envelope };
        match std::mem::replace(&mut spent.command, Command::Spent) {
            Command::Play { generation, plan, from, end } if generation > self.generation => {
                spent.retired = self.plan.replace(plan);
                self.playing = true;
                self.next_sample = from;
                self.end_sample = end;
                self.generation = generation;
                if was_playing {
                    next = Next::Restart;
                }
            }
            Command::Stop { generation } if generation > self.generation => {
                spent.retired = self.plan.take();
                self.playing = false;
                self.generation = generation;
                next = Next::Idle;
            }
            // Stale (an older generation than the one applied): ignored, its plan travels back in the envelope.
            Command::Play { plan, .. } => spent.retired = Some(plan),
            _ => {}
        }
        self.shared.push_spent(envelope);
        next
    }
}

impl RenderSource for Renderer {
    fn rewind(&mut self, frames: u32) {
        self.next_sample = self.next_sample.saturating_sub(frames as u64);
    }

    fn retire(&mut self) -> Box<dyn Send> {
        self.playing = false;
        Box::new(self.plan.take())
    }

    fn poll(&mut self) -> RenderResult {
        let next = self.apply_command();
        RenderResult { next, generation: self.generation, playing_frames: 0, project_start: 0, held_at: self.end_sample as i64 }
    }

    fn render(&mut self, out: &mut [f32]) -> RenderResult {
        let restart = self.apply_command() == Next::Restart;
        if !self.playing {
            out.fill(0.0);
            return RenderResult::idle(self.generation);
        }
        if restart {
            out.fill(0.0);
            return RenderResult { next: Next::Restart, generation: self.generation, playing_frames: 0, project_start: 0, held_at: self.end_sample as i64 };
        }
        let frames = out.len() / 2;
        let play = (self.end_sample.saturating_sub(self.next_sample) as usize).min(frames);
        if let Some(plan) = &self.plan {
            let mut done = 0;
            while done < play {
                let n = (play - done).min(RATE as usize);
                let _ = plan.mix(self.next_sample + done as u64, &mut out[done * 2..(done + n) * 2]);
                done += n;
            }
        }
        out[play * 2..].fill(0.0);
        let result = RenderResult { next: Next::Continue, generation: self.generation, playing_frames: play as u32, project_start: self.next_sample as i64, held_at: self.end_sample as i64 };
        self.next_sample += play as u64;
        result
    }
}

/// Frees what the two realtime-adjacent threads must not, and does it in bounded steps: the queue to the freeing thread is
/// bounded, what does not fit waits in a backlog of its own that is bounded too, and each call hands over a fixed number of
/// items. Past the backlog the oldest item is freed on the caller, and counted: the failure is visible and the transport goes on.
struct Reclaimer {
    tx: Option<SyncSender<Reclaim>>,
    thread: Option<JoinHandle<()>>,
    backlog: VecDeque<Reclaim>,
    overflows: u64,
}

enum Reclaim {
    Envelope(#[allow(dead_code)] Box<Envelope>),
    Plan(#[allow(dead_code)] Arc<MixPlan>),
}

/// Items the freeing thread's queue holds, the backlog beyond it, and how many go over per call.
const RECLAIM_QUEUE: usize = 256;
const RECLAIM_BACKLOG: usize = 256;
const RECLAIM_PER_CALL: usize = 64;

impl Reclaimer {
    fn new() -> Reclaimer {
        let (tx, rx) = sync_channel::<Reclaim>(RECLAIM_QUEUE);
        let thread = std::thread::Builder::new().name("styk audio reclaim".into()).spawn(move || for item in rx { drop(item) }).expect("a thread to free audio buffers");
        Reclaimer { tx: Some(tx), thread: Some(thread), backlog: VecDeque::new(), overflows: 0 }
    }

    fn give(&mut self, item: Reclaim) {
        self.backlog.push_back(item);
        self.flush();
    }

    /// Hands the backlog over, at most [`RECLAIM_PER_CALL`] items, never waiting.
    fn flush(&mut self) {
        for _ in 0..RECLAIM_PER_CALL {
            let Some(item) = self.backlog.pop_front() else { break };
            match self.tx.as_ref().map(|tx| tx.try_send(item)) {
                Some(Ok(())) => {}
                Some(Err(TrySendError::Full(item))) => {
                    self.backlog.push_front(item);
                    break;
                }
                Some(Err(TrySendError::Disconnected(item))) => drop(item),
                None => break,
            }
        }
        while self.backlog.len() > RECLAIM_BACKLOG {
            self.backlog.pop_front();
            self.overflows += 1;
        }
    }
}

/// What `prepare` does when its plan is ready.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Then {
    /// Report it ([`Event::Ready`]).
    Hold,
    /// Play from project sample `from` to `end`.
    Play { from: u64, end: u64 },
}

pub type JobId = u64;

#[derive(Debug)]
pub enum Event {
    /// The plan of `job` is ready (`Then::Hold`).
    Ready { job: JobId, plan: Arc<MixPlan> },
    /// The plan of `job` is playing (it was handed to the output).
    Started { job: JobId },
    Failed { job: JobId, error: AudioError },
    /// The output device was lost; playback stopped and the frame scheduler should fall back to the wall clock.
    DeviceLost,
}

type Prepared = (JobId, Result<Arc<MixPlan>, AudioError>);

struct Job {
    id: JobId,
    state: AudioState,
    start: f64,
    end: f64,
    cancel: Cancel,
}

#[derive(Default)]
struct Slot {
    /// The newest request waiting for the worker (a newer one replaces it).
    next: Option<Job>,
    /// The request the worker is on.
    running: Option<(JobId, Cancel)>,
    /// The newest result (an unpolled older one is replaced).
    done: Option<Prepared>,
    shutdown: bool,
}

/// Preparation: one worker thread, one request waiting, one result waiting. However many prepares are asked for, the process
/// has this one thread, and each handoff holds one item.
struct Jobs {
    slot: Mutex<Slot>,
    wake: Condvar,
}

impl Jobs {
    fn lock(&self) -> std::sync::MutexGuard<'_, Slot> {
        self.slot.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Cancels the job named `id`, wherever it is. No other job is touched.
    fn cancel(slot: &mut Slot, id: JobId) {
        if slot.next.as_ref().is_some_and(|job| job.id == id) {
            if let Some(job) = slot.next.take() {
                job.cancel.cancel();
            }
        }
        if let Some((running, cancel)) = &slot.running {
            if *running == id {
                cancel.cancel();
            }
        }
    }

    fn worker(self: Arc<Jobs>, store: Arc<SourceStore>) {
        loop {
            let job = {
                let mut slot = self.lock();
                loop {
                    if slot.shutdown {
                        return;
                    }
                    if let Some(job) = slot.next.take() {
                        slot.running = Some((job.id, job.cancel.clone()));
                        break job;
                    }
                    slot = self.wake.wait(slot).unwrap_or_else(|e| e.into_inner());
                }
            };
            let result = build_plan(&store, &job.state, job.start, job.end, &job.cancel);
            let replaced = {
                let mut slot = self.lock();
                slot.running = None;
                slot.done.replace((job.id, result))
            };
            // An older result nobody polled is freed here, on the worker.
            drop(replaced);
        }
    }
}

struct Pending {
    id: JobId,
    then: Then,
}

struct Active {
    generation: u64,
    end: u64,
}

pub struct AudioTransport {
    shared: ManuallyDrop<Arc<Shared>>,
    control: Arc<StreamControl>,
    clock: Arc<StreamClock>,
    host: Arc<dyn HostClock>,
    reclaimer: ManuallyDrop<Reclaimer>,
    output: Option<Box<dyn AudioOutput>>,
    info: Option<OutputInfo>,
    store: ManuallyDrop<Arc<SourceStore>>,
    jobs: ManuallyDrop<Arc<Jobs>>,
    worker: Option<JoinHandle<()>>,
    /// The generation of the last command issued.
    generation: u64,
    next_job: JobId,
    pending: Option<Pending>,
    active: Option<Active>,
    last_scrub_ns: Option<u64>,
    reported_lost: bool,
}

impl AudioTransport {
    /// A transport on `output` (opened now; a failure is returned and the transport is unusable but safe to drop).
    pub fn new(mut output: Box<dyn AudioOutput>, host: Arc<dyn HostClock>, decoder: Arc<dyn AudioDecoder>, budget_bytes: u64) -> Result<AudioTransport, AudioError> {
        let shared = Shared::new();
        let renderer = Renderer { shared: shared.clone(), plan: None, playing: false, next_sample: 0, end_sample: 0, generation: 0 };
        let info = output.open(Box::new(renderer))?;
        let store = SourceStore::new(Budget::new(budget_bytes), decoder);
        let jobs = Arc::new(Jobs { slot: Mutex::new(Slot::default()), wake: Condvar::new() });
        let worker = {
            let (jobs, store) = (jobs.clone(), store.clone());
            std::thread::Builder::new().name("styk audio prepare".into()).spawn(move || jobs.worker(store)).map_err(|e| AudioError::Io(e.to_string()))?
        };
        Ok(AudioTransport {
            shared: ManuallyDrop::new(shared),
            control: output.control(),
            clock: output.clock(),
            host,
            reclaimer: ManuallyDrop::new(Reclaimer::new()),
            output: Some(output),
            info: Some(info),
            store: ManuallyDrop::new(store),
            jobs: ManuallyDrop::new(jobs),
            worker: Some(worker),
            generation: 0,
            next_job: 0,
            pending: None,
            active: None,
            last_scrub_ns: None,
            reported_lost: false,
        })
    }

    pub fn output_info(&self) -> Option<&OutputInfo> {
        self.info.as_ref()
    }

    pub fn store(&self) -> &Arc<SourceStore> {
        &self.store
    }

    /// Items waiting to be handed to the freeing thread, and items that had to be freed on the caller because even the backlog
    /// was full. Both stay small; the second is zero unless the freeing thread is stuck.
    pub fn reclaim_backlog(&self) -> usize {
        self.reclaimer.backlog.len()
    }

    pub fn reclaim_overflows(&self) -> u64 {
        self.reclaimer.overflows
    }

    /// Hands what the output thread has finished with to the freeing thread: a bounded number of items per call.
    fn reclaim_spent(&mut self) {
        for envelope in self.shared.take_spent() {
            self.reclaimer.backlog.push_back(Reclaim::Envelope(envelope));
        }
        self.reclaimer.flush();
    }

    fn post(&mut self, command: Command) {
        if let Some(replaced) = self.shared.post(command) {
            self.reclaimer.give(Reclaim::Envelope(replaced));
        }
        self.reclaim_spent();
    }

    /// Starts preparing the plan for `[start, end)` seconds of `state`. The prepare before it, if still unfinished, is cancelled
    /// (that one job, by its identity); a result that is no longer the current job is dropped, never played.
    pub fn prepare(&mut self, state: &AudioState, start: f64, end: f64, then: Then) -> JobId {
        self.next_job += 1;
        let id = self.next_job;
        let cancel = Cancel::new();
        {
            let mut slot = self.jobs.lock();
            if let Some(previous) = self.pending.take() {
                Jobs::cancel(&mut slot, previous.id);
            }
            slot.next = Some(Job { id, state: state.clone(), start, end, cancel });
        }
        self.jobs.wake.notify_one();
        self.pending = Some(Pending { id, then });
        id
    }

    /// Plays a prepared plan from project sample `from` to `end` (a new generation: whatever is playing is cancelled).
    pub fn play(&mut self, plan: Arc<MixPlan>, from: u64, end: u64) {
        self.generation += 1;
        let generation = self.generation;
        self.active = Some(Active { generation, end });
        self.post(Command::Play { generation, plan, from, end });
        self.control.activate();
    }

    /// Prepares and plays `[start, end)` seconds.
    pub fn play_range(&mut self, state: &AudioState, start: f64, end: f64) -> JobId {
        let (from, until) = ((start * RATE as f64).round() as u64, (end * RATE as f64).round() as u64);
        self.prepare(state, start, end, Then::Play { from, end: until })
    }

    /// Stops: the preparing job is cancelled, the queued sound is discarded now, the stream goes idle.
    pub fn stop(&mut self) {
        if let Some(pending) = self.pending.take() {
            Jobs::cancel(&mut self.jobs.lock(), pending.id);
        }
        self.generation += 1;
        let generation = self.generation;
        self.active = None;
        self.post(Command::Stop { generation });
        self.control.wake();
    }

    /// A scrub slice at `time` seconds (`app.mjs` `scrubAudio`): needs more than 100 ms since the last one, an 80 ms slice with a
    /// hard cut. `None` when it is too soon. Like today's `audioScrubAt`, the time of the last slice is kept when a scrub ends.
    pub fn scrub(&mut self, state: &AudioState, time: f64) -> Option<JobId> {
        let now = self.host.now_ns();
        if self.last_scrub_ns.is_some_and(|last| now <= last.saturating_add(SCRUB_INTERVAL_NS)) {
            return None;
        }
        self.last_scrub_ns = Some(now);
        let from = (time * RATE as f64).round() as u64;
        Some(self.prepare(state, time, time + SCRUB_SAMPLES as f64 / RATE as f64, Then::Play { from, end: from + SCRUB_SAMPLES }))
    }

    /// The end of a scrub gesture (`stopAudioScrub`): the sound stops; the retrigger throttle is not reset.
    pub fn end_scrub(&mut self) {
        self.stop();
    }

    /// Collects the finished job and reports it; call once per frame. Never blocks, and does a fixed amount of work: one result
    /// at most, and a bounded number of items handed to the freeing thread.
    pub fn poll(&mut self) -> Vec<Event> {
        let mut events = Vec::new();
        let done = self.jobs.lock().done.take();
        if let Some((id, result)) = done {
            if self.pending.as_ref().is_some_and(|pending| pending.id == id) {
                let pending = self.pending.take().expect("the job is current");
                match (result, pending.then) {
                    (Ok(plan), Then::Hold) => events.push(Event::Ready { job: id, plan }),
                    (Ok(plan), Then::Play { from, end }) => {
                        self.play(plan, from, end);
                        events.push(Event::Started { job: id });
                    }
                    (Err(error), _) => events.push(Event::Failed { job: id, error }),
                }
            } else if let Ok(plan) = result {
                // A superseded or cancelled job: whatever it made is freed elsewhere and never reaches the output.
                self.reclaimer.give(Reclaim::Plan(plan));
            }
        }
        if self.control.is_lost() && !self.reported_lost {
            self.reported_lost = true;
            self.active = None;
            events.push(Event::DeviceLost);
        }
        self.reclaim_spent();
        events
    }

    /// Where the transport is, as the clock of the stream under the last command's generation.
    pub fn reading(&self) -> Reading {
        match &self.active {
            None => Reading::Stopped,
            Some(active) => self.clock.read(self.host.now_ns(), active.generation).unwrap_or(Reading::Pending),
        }
    }

    /// Whether the last play reached the end of its range (the stream holds in silence until `stop` or a new play).
    pub fn has_ended(&self) -> bool {
        match (&self.active, self.reading()) {
            (Some(active), Reading::Running { sample, held: true }) => sample >= active.end as f64,
            _ => false,
        }
    }

    /// Underruns the device thread detected since the stream was opened.
    pub fn underruns(&self) -> u64 {
        self.clock.load().map_or(0, |state| state.underruns)
    }

    pub fn device_lost(&self) -> bool {
        self.control.is_lost()
    }
}

impl Drop for AudioTransport {
    fn drop(&mut self) {
        // Everything that can hold decoded audio leaves for a thread of its own: the output, the plans queued in the mailbox and
        // in the command envelopes, the preparing worker and the result it may hold, the cache, the freeing thread's backlog and
        // what the output thread left in the control block's graveyard. None of it is freed on the interface thread.
        if let Some(pending) = self.pending.take() {
            Jobs::cancel(&mut self.jobs.lock(), pending.id);
        }
        let mut output = self.output.take();
        let worker = self.worker.take();
        let control = self.control.clone();
        // SAFETY: `drop` runs once and nothing reads these fields afterwards.
        let (shared, store, jobs, reclaimer) = unsafe { (ManuallyDrop::take(&mut self.shared), ManuallyDrop::take(&mut self.store), ManuallyDrop::take(&mut self.jobs), ManuallyDrop::take(&mut self.reclaimer)) };
        let _ = std::thread::Builder::new().name("styk audio close".into()).spawn(move || {
            {
                let mut slot = jobs.lock();
                slot.shutdown = true;
                if let Some(job) = slot.next.take() {
                    job.cancel.cancel();
                }
                if let Some((_, cancel)) = &slot.running {
                    cancel.cancel();
                }
            }
            jobs.wake.notify_all();
            if let Some(worker) = worker {
                let _ = worker.join();
            }
            if let Some(output) = output.as_mut() {
                output.close();
            }
            let junk = control.take_graveyard();
            drop(junk);
            drop(output);
            drop(shared);
            drop(store);
            drop(jobs);
            let Reclaimer { tx, thread, backlog, .. } = reclaimer;
            drop(backlog);
            drop(tx);
            if let Some(thread) = thread {
                let _ = thread.join();
            }
        });
    }
}

/// What the frame scheduler follows: the media time in seconds, or `None` while there is none (stopped, or the first sound
/// has not reached the device yet).
pub trait MediaClock {
    fn media_time(&self) -> Option<f64>;
}

impl MediaClock for AudioTransport {
    fn media_time(&self) -> Option<f64> {
        match (&self.active, self.reading()) {
            (Some(active), Reading::Running { sample, .. }) => Some(sample.min(active.end as f64) / RATE as f64),
            _ => None,
        }
    }
}

/// The clock of a transport with no sound (nothing audible, or no device): wall time from the start.
pub struct WallClock {
    host: Arc<dyn HostClock>,
    started_ns: u64,
    from: f64,
}

impl WallClock {
    pub fn start(host: Arc<dyn HostClock>, from: f64) -> WallClock {
        let started_ns = host.now_ns();
        WallClock { host, started_ns, from }
    }
}

impl MediaClock for WallClock {
    fn media_time(&self) -> Option<f64> {
        Some(self.from + (self.host.now_ns().saturating_sub(self.started_ns)) as f64 / 1e9)
    }
}
