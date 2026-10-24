//! The engine facade.
//!
//! One [`Engine`] holds the open document and prepares its frames in the
//! background. It is shared by every thread: the interface thread asks for
//! frames and never waits; worker threads run [`Engine::work`].
//!
//! - [`Engine::open`] publishes a new document **generation**. Work in progress
//!   for an older generation finishes and is dropped.
//! - [`Engine::request`] replaces the list of wanted ticks (nearest first). It is
//!   how playback and scrubbing prefetch, and how obsolete work is cancelled: a
//!   tick that is no longer wanted and not yet started is never prepared.
//! - [`Engine::frame`] returns a prepared frame if one is ready.
//!
//! - [`Engine::export_frames`] pins a revision for an export ([`export`]).
//! - [`thumbnails`] draws small pictures of frames and library files on the CPU, on
//!   the thread that asks.
//!
//! Interface readiness and admission use one-shot try reads and return cold or
//! Busy on contention. [`sync::Shared::lock`] can wait and belongs on workers and
//! synchronous tools. Cache payload preparation and disposal run outside State;
//! presenter lifetime and shutdown contracts remain separate obligations.

#[cfg(test)]
mod allocation;
pub mod anchors;
pub mod document;
pub mod edit;
pub mod export;
mod frames;
mod images;
pub mod planning;
mod publication;
pub use publication::PublicationRetirement;
mod store;
mod sync;
pub mod thumbnails;
pub use store::Committed;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use styk_eval::assets::Assets;
use styk_eval::eval::Prepared;

pub use frames::{FrameAdmission, FrameData, FrameMetadata, FrameSnapshot, FrameStats, GenerationHeader};
pub use images::{DecodedImage, Uploaded};
use sync::Shared;

type Task = Box<dyn FnOnce(&Engine) + Send>;
enum OrdinaryTask { Run(Task), Redecode(images::DecodeScope), Decode(Arc<Generation>, images::Picture) }
type TaskQueue = std::collections::LinkedList<OrdinaryTask>;

/// Detach the first existing node without allocating or freeing it. The worker
/// pops/drops the detached node after releasing the UI-visible shared lock.
fn detach_task<T>(tasks: &mut std::collections::LinkedList<T>) -> Option<std::collections::LinkedList<T>> {
    if tasks.is_empty() { return None }
    let tail = tasks.split_off(1);
    Some(std::mem::replace(tasks, tail))
}

/// A monotonic clock in milliseconds. The engine cannot read one itself on every
/// platform (WebAssembly has none), so the host supplies it.
pub type Clock = fn() -> f64;

/// Called after the progress counter advanced, with the counter. A host that waits
/// on the counter's memory (`Atomics.waitAsync` in a browser) wakes its waiters here.
pub type Notifier = fn(&std::sync::atomic::AtomicU32);

/// Memory the frame cache may hold, by device class. Draw lists are small (tens
/// to hundreds of KiB), so even the smallest budget holds seconds of animation.
/// Decoded pictures wait for the renderer under a budget of their own, a share of the
/// memory the module may use.
#[derive(Clone, Copy, Debug)]
pub struct Budgets {
    pub frame_cache_bytes: usize,
    /// Pixels decoded and not yet taken by the renderer, at most (a picture is decoded only while
    /// the pictures waiting and being decoded are fewer than this). See [`Budgets::PICTURE_SHARE`].
    pub picture_bytes: usize,
}

impl Budgets {
    /// `memory_gib` is the host's device-memory hint (`navigator.deviceMemory`), if any.
    pub fn for_device(memory_gib: Option<f64>) -> Budgets {
        let frame_cache_bytes = match memory_gib {
            Some(gib) if gib <= 2.0 => 48 << 20,
            Some(gib) if gib <= 4.0 => 128 << 20,
            Some(_) => 384 << 20,
            None => 192 << 20,
        };
        let ceiling = styk_alloc::ceiling();
        Budgets { frame_cache_bytes: frame_cache_bytes.min(ceiling / Budgets::FRAME_CACHE_SHARE), picture_bytes: ceiling / Budgets::PICTURE_SHARE }
    }

    /// Pictures waiting for the renderer may take a thirtieth of the memory the module may use (64 MiB of a
    /// 2 GiB memory), and the frame cache an eighth (240 MiB), whatever the device claims to have. Where the
    /// module has no limit (native tools, tests) neither is a bound in practice.
    pub const PICTURE_SHARE: usize = 30;
    pub const FRAME_CACHE_SHARE: usize = 8;
}

/// One open document, immutable. A new one replaces it on every change.
pub struct Generation {
    pub id: u64,
    /// Generations of one lineage are revisions of the same project: they share an
    /// image atlas, so an edit never uploads pictures again.
    pub lineage: u64,
    /// The interface's revision counter this document corresponds to.
    pub revision: u64,
    pub prepared: Arc<Prepared>,
    pub assets: Arc<Assets>,
    pub open_ms: f64,
    /// Where generated effects' targets were on earlier ticks, kept across frames;
    /// `None` for a document without generated effects (set by [`Engine::publish`]).
    pub anchors: Option<Arc<anchors::Anchors>>,
}

impl Generation {
    /// Ticks that can be evaluated: none for a document without keyframes.
    pub fn playable_ticks(&self) -> u32 {
        if self.prepared.doc.keyframes.is_empty() { 0 } else { self.prepared.total_ticks }
    }
}

/// What [`Engine::open`] reports.
#[derive(Clone, Debug)]
pub struct Opened {
    pub generation: u64,
    pub name: String,
    pub version: u32,
    pub canvas: [u32; 2],
    pub fps: f64,
    pub ticks: u32,
    pub figures: usize,
    pub keyframes: usize,
    pub images: usize,
    pub open_ms: f64,
    /// Features the file uses that the engine does not draw yet.
    pub unsupported: Vec<String>,
}

struct State {
    current: Option<Arc<Generation>>,
    frames: frames::Cache,
    images: images::Store,
    /// Background tasks that are not frames (image decoding), oldest first.
    tasks: TaskQueue,
    /// Read-only planning/cleanup tasks survive document replacement: payloads
    /// must be disposed on a worker, including jobs awaiting receiver ACKs.
    retained_tasks: std::collections::LinkedList<Box<dyn FnOnce(&Engine) + Send>>,
}

struct Inner {
    state: Shared<State>,
    /// The document in front (store.rs).
    store: std::sync::Mutex<store::Store>,
    clock: Clock,
    next_generation: AtomicU64,
    stopping: AtomicBool,
    /// [`Budgets::picture_bytes`].
    picture_bytes: usize,
    /// Pictures not decoded because the module was too low on memory ([`Engine::pictures_refused`]).
    pictures_refused: std::sync::atomic::AtomicUsize,
    progress: std::sync::atomic::AtomicU32,
    notifier: Option<Notifier>,
    planning: Shared<Option<Arc<planning::Core>>>,
}

/// The engine. Cheap to clone; every clone is the same engine.
#[derive(Clone)]
pub struct Engine {
    inner: Arc<Inner>,
}

impl Engine {
    pub fn new(clock: Clock, budgets: Budgets) -> Engine {
        Engine::with_notifier(clock, budgets, None)
    }

    /// An engine that calls `notifier` whenever background work finishes.
    pub fn with_notifier(clock: Clock, budgets: Budgets, notifier: Option<Notifier>) -> Engine {
        Engine {
            inner: Arc::new(Inner {
                state: Shared::new(State {
                    current: None,
                    frames: frames::Cache::new(budgets.frame_cache_bytes),
                    images: images::Store::default(),
                    tasks: Default::default(),
                    retained_tasks: Default::default(),
                }),
                store: Default::default(),
                clock,
                next_generation: AtomicU64::new(1),
                stopping: AtomicBool::new(false),
                picture_bytes: budgets.picture_bytes,
                pictures_refused: Default::default(),
                progress: std::sync::atomic::AtomicU32::new(0),
                notifier,
                planning: Shared::new(None),
            }),
        }
    }

    pub fn now(&self) -> f64 {
        (self.inner.clock)()
    }

    /// Decodes a file and publishes it as the open document. Runs on the calling
    /// thread: call it from a worker for anything but small files.
    pub fn open(&self, bytes: &[u8], extension: &str, name: &str) -> Result<Opened, styk_eval::Error> {
        let started = self.now();
        let document = styk_eval::open_bytes(bytes, extension, name)?;
        let prepared = Arc::new(Prepared::new(Arc::new(document)));
        let assets = Arc::new(Assets::build(&prepared.doc));
        let open_ms = self.now() - started;
        let lineage = self.inner.next_generation.fetch_add(1, Ordering::Relaxed);
        let doc = prepared.doc.clone();
        let ticks = prepared.total_ticks;
        let id = self.publish(Generation { id: 0, lineage, revision: 0, prepared, assets, open_ms, anchors: None });
        Ok(Opened {
            generation: id,
            name: doc.name.clone(),
            version: doc.version,
            canvas: doc.canvas,
            fps: doc.fps,
            ticks,
            figures: doc.figures.len(),
            keyframes: doc.keyframes.len(),
            images: doc.images.len(),
            open_ms,
            unsupported: doc.unsupported.clone(),
        })
    }

    /// Makes `generation` the open document and queues the decoding of its images
    /// that the previous revision did not already have. Returns its id.
    pub(crate) fn publish(&self, generation: Generation) -> u64 {
        let (id, retirement) = self.install_generation(generation);
        // What the replaced generation held is dropped on a worker, never on the interface thread.
        if retirement.needs_worker() { self.spawn_retained(move |_| drop(retirement)); }
        id
    }

    /// Runs `task` in the background: on a worker inside [`Engine::work`], or on the
    /// next [`Engine::step`] of a host without workers. Tasks run before frames.
    pub fn spawn(&self, task: impl FnOnce(&Engine) + Send + 'static) {
        let mut node = TaskQueue::new();
        node.push_back(OrdinaryTask::Run(Box::new(task)));
        self.inner.state.lock().tasks.append(&mut node);
        self.inner.state.notify_all();
    }

    /// Internal planning continuations: coalesced to one per active job and
    /// retained across generation replacement until a worker disposes the job.
    fn spawn_retained(&self, task: impl FnOnce(&Engine) + Send + 'static) {
        let mut node = std::collections::LinkedList::new();
        node.push_back(Box::new(task) as Box<dyn FnOnce(&Engine) + Send>);
        self.inner.state.lock().retained_tasks.append(&mut node);
        self.inner.state.notify_all();
    }

    fn notify_progress(&self) {
        self.inner.progress.fetch_add(1, Ordering::SeqCst);
        if let Some(notify) = self.inner.notifier { notify(&self.inner.progress); }
    }

    /// A counter that advances whenever background work finishes (a frame, an image,
    /// a task). A host that cannot be called back watches it instead of polling results.
    pub fn progress(&self) -> &std::sync::atomic::AtomicU32 {
        &self.inner.progress
    }

    /// The open document, if any.
    pub fn generation(&self) -> Option<Arc<Generation>> {
        self.inner.state.lock().current.clone()
    }

    /// One coherent scalar readiness read. None means busy; an unopened Engine
    /// returns zeros. No strong document/cache owner crosses this interface.
    pub fn generation_identity_now(&self) -> Option<[u64; 3]> {
        self.try_generation_header().ok().map(|header| header.map_or([0; 3], |header| {
            [header.generation, header.lineage, header.revision]
        }))
    }

    /// Asks every worker to return from [`Engine::work`].
    pub fn stop(&self) {
        planning::cancel_current(self);
        {
            let mut state = self.inner.state.lock();
            // Workers return once the flag is set, so a decode being prepared must not be installed after it.
            state.images.cancel_preparation();
            self.inner.stopping.store(true, Ordering::SeqCst);
        }
        self.inner.state.notify_all();
    }

    /// Runs background work on the calling thread until [`Engine::stop`]. Blocks while
    /// there is nothing to do, so it must not be called on a browser's interface thread.
    pub fn work(&self) {
        loop {
            if self.inner.stopping.load(Ordering::SeqCst) {
                // Cancellation retains cleanup until a worker runs it.
                let task = detach_task(&mut self.inner.state.lock().retained_tasks);
                if let Some(mut node) = task { node.pop_front().expect("detached task")(self); self.notify_progress(); continue; }
                return;
            }
            if !self.step() {
                self.inner.state.wait_for_work(&self.inner.stopping);
            }
        }
    }

    /// Runs one unit of background work on the calling thread, if there is any.
    /// A host without worker threads calls this between its own tasks.
    pub fn step(&self) -> bool {
        planning::expire_current(self);
        let job = {
            let mut state = self.inner.state.lock();
            if let Some(task) = detach_task(&mut state.retained_tasks) {
                Job::Retained(task)
            } else if state.images.preparation_active() {
                // Coalesced maintenance may dispose stale storage while this
                // image barrier defers evaluation; no ordinary task is reordered.
                if state.frames.maintenance_due() { Job::Frames(state.frames.work(state.current.clone())) }
                else { return false; }
            } else if let Some(task) = next_task(&mut state, self.inner.picture_bytes) {
                if let Some(OrdinaryTask::Redecode(scope)) = task.front()
                    && !self.inner.stopping.load(Ordering::SeqCst) { state.images.start_preparation(*scope); }
                Job::Task(task)
            } else {
                Job::Frames(state.frames.work(state.current.clone()))
            }
        };
        match job {
            Job::Retained(mut node) => node.pop_front().expect("detached retained task")(self),
            Job::Task(mut node) => match node.pop_front().expect("detached task") {
                OrdinaryTask::Run(task) => task(self),
                OrdinaryTask::Redecode(scope) => self.prepare_redecode(scope),
                OrdinaryTask::Decode(generation, picture) => self.decode_picture(&generation, picture),
            },
            Job::Frames(work) => { if !work.step(self) { return false; } }
        }
        self.notify_progress();
        true
    }
}

/// The next ordinary task. A picture to decode while the pictures waiting for the renderer are at their budget is
/// parked (its node moves to the store, nothing is allocated) until the renderer takes some ([`Engine::take_images`]).
fn next_task(state: &mut State, picture_bytes: usize) -> Option<TaskQueue> {
    loop {
        let mut task = detach_task(&mut state.tasks)?;
        if let Some(OrdinaryTask::Decode(generation, picture)) = task.front()
            && !state.images.admit_decode(picture_bytes, images::estimate(generation, *picture))
        {
            state.images.park(&mut task);
            continue;
        }
        return Some(task);
    }
}

enum Job {
    Retained(std::collections::LinkedList<Task>),
    Task(TaskQueue),
    Frames(frames::Work),
}
