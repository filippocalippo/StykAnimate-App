//! Glyph masks drawn off the interface thread.
//!
//! A program may ask for its glyphs to be drawn by a worker thread ([`GlyphDrawing`]): on Windows with DirectWrite, the
//! rasterizer Chromium uses there, elsewhere with swash. The interface thread then never draws a glyph; it asks and
//! picks up what is ready, and nothing in this module waits for the worker or takes a lock the worker holds:
//!
//! - **Requests** go to the worker through a bounded queue with nonblocking admission ([`MAX_JOBS`] jobs and
//!   [`MAX_INFLIGHT_BYTES`] of estimated masks outstanding per interface thread); a request that is not admitted is
//!   asked for again by the next frame.
//! - **Results** come back through a channel of the interface thread's own and are drained by it. Their bookkeeping
//!   (what is asked, what is ready) is owned by the interface thread and bounded by [`MAX_READY_BYTES`].
//! - **A candidate** is one frame the program is preparing: [`begin_candidate`] starts it, every glyph missing from the
//!   atlas that it needs is looked up ([`lookup`]) and [`end_candidate`] says whether it was complete. Readiness is the
//!   candidate's: a request that the candidate did not touch is obsolete when it ends, its job is skipped by the worker
//!   if it has not started, and its result is thrown away on arrival. A glyph a superseded frame wanted is never
//!   waited for.
//! - **Warm glyphs** ([`prewarm`]) are drawn before any frame wants them, by any thread that has the fonts; their
//!   results wait, bounded by [`MAX_WARM_BYTES`], for the first frame that does.

use cosmic_text::{CacheKey, CacheKeyFlags, Font, SwashCache, SwashImage};
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, SyncSender, TryRecvError, TrySendError, channel, sync_channel};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant};

/// Who draws the glyph masks.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum GlyphDrawing {
    /// swash, on the thread that prepares the text.
    #[default]
    Inline,
    /// swash, on the worker thread.
    Worker,
    /// DirectWrite on the worker thread (Windows; swash for the glyphs it cannot draw, and elsewhere).
    DirectWrite,
}

/// Jobs one interface thread may have outstanding at the worker.
pub const MAX_JOBS: usize = 256;
/// The estimated size of the masks of the jobs one interface thread may have outstanding.
pub const MAX_INFLIGHT_BYTES: usize = 2 << 20;
/// The masks drawn and not yet picked up by their frame.
pub const MAX_READY_BYTES: usize = 8 << 20;
/// The warm glyphs drawn and not yet used.
pub const MAX_WARM_BYTES: usize = 16 << 20;
/// The queue in front of the worker.
const QUEUE: usize = 1024;
/// The worker tells the program it has glyphs at least this often while it is busy, and whenever it runs dry.
const NOTIFY_EVERY: Duration = Duration::from_millis(4);

/// What looking a glyph up found.
pub(crate) enum Lookup {
    /// The glyph's image, drawn by the worker.
    Ready(SwashImage),
    /// Not drawn yet: it has been asked for, the candidate is incomplete.
    Missing,
    /// There is no font to draw it from: the glyph is left out and nothing waits for it.
    Absent,
}

type Notifier = Arc<dyn Fn() + Send + Sync>;

static NOTIFIER: RwLock<Option<Notifier>> = RwLock::new(None);

/// Tells the program, from the worker's thread, that glyphs have been drawn and a frame can use them: it asks the window
/// for another frame. Without one, glyphs appear at the next frame something else asks for.
pub fn set_glyph_notifier(notifier: impl Fn() + Send + Sync + 'static) {
    *NOTIFIER.write().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Arc::new(notifier));
}

struct Job {
    key: CacheKey,
    font: Arc<Font>,
    direct_write: bool,
    /// The candidate that last wanted the glyph; the job is obsolete once `floor` passes it.
    wanted: Arc<AtomicU64>,
    floor: Arc<AtomicU64>,
    estimate: usize,
    reply: Sender<Reply>,
    /// Whether the worker tells the program when this job is done.
    notify: bool,
}

struct Reply {
    key: CacheKey,
    wanted: Arc<AtomicU64>,
    estimate: usize,
    /// `None` when the worker skipped the job as obsolete.
    image: Option<SwashImage>,
}

/// Jobs waiting for the worker, frames' first and warm glyphs second.
static QUEUED: AtomicUsize = AtomicUsize::new(0);
static WARM_QUEUED: AtomicUsize = AtomicUsize::new(0);
static WARM_BYTES: AtomicUsize = AtomicUsize::new(0);

/// The two queues in front of the worker: a frame's glyphs are always drawn before the warm ones.
struct Lanes {
    frames: SyncSender<Job>,
    warm: SyncSender<Job>,
}

static LANES: RwLock<Option<Lanes>> = RwLock::new(None);

fn spawn_worker() -> Option<Lanes> {
    let (frames, frames_receiver) = sync_channel(QUEUE);
    let (warm, warm_receiver) = sync_channel(QUEUE);
    std::thread::Builder::new().name("glyphs".into()).spawn(move || run(frames_receiver, warm_receiver)).ok()?;
    Some(Lanes { frames, warm })
}

/// Queues `job` without waiting: `Err` gives it back when the queue is full or no worker can be started.
fn submit(mut job: Job) -> Result<(), Job> {
    for attempt in 0..2 {
        let warm = !job.notify;
        let result = match LANES.read().unwrap_or_else(|poisoned| poisoned.into_inner()).as_ref() {
            Some(lanes) => (if warm { &lanes.warm } else { &lanes.frames }).try_send(job),
            None => Err(TrySendError::Disconnected(job)),
        };
        match result {
            Ok(()) => {
                (if warm { &WARM_QUEUED } else { &QUEUED }).fetch_add(1, Ordering::AcqRel);
                return Ok(());
            }
            Err(TrySendError::Full(job)) => return Err(job),
            Err(TrySendError::Disconnected(returned)) => {
                job = returned;
                if attempt == 0 {
                    // No worker yet, or it is gone: start one.
                    *LANES.write().unwrap_or_else(|poisoned| poisoned.into_inner()) = spawn_worker();
                }
            }
        }
    }
    Err(job)
}

/// Draws glyphs: DirectWrite where asked and possible, swash otherwise.
struct Drawer {
    #[cfg(windows)]
    direct_write: Option<cosmic_text::dwrite::DirectWrite>,
    swash: SwashCache,
}

impl Drawer {
    fn new() -> Self {
        Self {
            #[cfg(windows)]
            direct_write: cosmic_text::dwrite::DirectWrite::new(),
            swash: SwashCache::new(),
        }
    }

    fn image(&mut self, job: &Job) -> SwashImage {
        let flags = job.key.flags;
        // DirectWrite draws the glyph as the font says; the synthetic styles, unhinted and pixel-snapped glyphs are
        // swash's.
        let swash_only = flags.intersects(CacheKeyFlags::FAKE_ITALIC | CacheKeyFlags::DISABLE_HINTING | CacheKeyFlags::PIXEL_FONT);
        #[cfg(windows)]
        if job.direct_write && !swash_only {
            if let Some(direct_write) = self.direct_write.as_mut() {
                use cosmic_text::dwrite::{Rasterized, Smoothing};
                let smoothing = if flags.contains(CacheKeyFlags::LCD) {
                    Smoothing::ClearType
                } else if flags.contains(CacheKeyFlags::ALIASED) {
                    Smoothing::Aliased
                } else {
                    Smoothing::Grayscale
                };
                match direct_write.rasterize(&job.font, job.key.glyph_id, f32::from_bits(job.key.font_size_bits), job.key.font_weight.0, job.key.font_optical_size, job.key.x_bin.as_float(), smoothing) {
                    Rasterized::Empty => return SwashImage::default(),
                    Rasterized::Mask(mask) => return mask_image(mask),
                    Rasterized::Unsupported => {}
                }
            }
        }
        let _ = swash_only;
        self.swash.get_image_of_font(&job.font, job.key).unwrap_or_default()
    }
}

#[cfg(windows)]
fn mask_image(mask: cosmic_text::dwrite::Mask) -> SwashImage {
    use cosmic_text::SwashContent;
    let mut image = SwashImage::default();
    image.placement.left = mask.left;
    image.placement.top = mask.top;
    image.placement.width = mask.width;
    image.placement.height = mask.height;
    if mask.lcd {
        image.content = SwashContent::SubpixelMask;
        image.data = mask.data.chunks_exact(3).flat_map(|pixel| [pixel[0], pixel[1], pixel[2], 255]).collect();
    } else {
        image.content = SwashContent::Mask;
        image.data = mask.data;
    }
    image
}

fn run(frames: Receiver<Job>, warm_glyphs: Receiver<Job>) {
    let mut drawer = Drawer::new();
    let mut last_notice = Instant::now();
    loop {
        // A frame's glyphs first; the warm ones when none waits; asleep (waking for the warm ones) when neither does.
        let job = match frames.try_recv() {
            Ok(job) => {
                QUEUED.fetch_sub(1, Ordering::AcqRel);
                job
            }
            Err(TryRecvError::Disconnected) => break,
            Err(TryRecvError::Empty) => match warm_glyphs.try_recv() {
                Ok(job) => {
                    WARM_QUEUED.fetch_sub(1, Ordering::AcqRel);
                    job
                }
                Err(_) => match frames.recv_timeout(Duration::from_millis(20)) {
                    Ok(job) => {
                        QUEUED.fetch_sub(1, Ordering::AcqRel);
                        job
                    }
                    Err(RecvTimeoutError::Timeout) => continue,
                    Err(RecvTimeoutError::Disconnected) => break,
                },
            },
        };
        let warm = !job.notify;
        let obsolete = job.wanted.load(Ordering::Acquire) < job.floor.load(Ordering::Acquire) || (warm && WARM_BYTES.load(Ordering::Acquire) >= MAX_WARM_BYTES);
        let image = (!obsolete).then(|| std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drawer.image(&job))).unwrap_or_default());
        if warm {
            if let Some(image) = &image {
                WARM_BYTES.fetch_add(image.data.len(), Ordering::AcqRel);
            }
        }
        let notify = job.notify && image.is_some();
        let _ = job.reply.send(Reply { key: job.key, wanted: job.wanted, estimate: job.estimate, image });
        // Wake the program when the worker runs dry and, while it is busy, every few milliseconds.
        if notify && (QUEUED.load(Ordering::Acquire) == 0 || last_notice.elapsed() >= NOTIFY_EVERY) {
            last_notice = Instant::now();
            if let Some(notifier) = NOTIFIER.read().unwrap_or_else(|poisoned| poisoned.into_inner()).clone() {
                notifier();
            }
        }
    }
}

fn release_warm(bytes: usize) {
    let _ = WARM_BYTES.try_update(Ordering::AcqRel, Ordering::Acquire, |held| Some(held.saturating_sub(bytes)));
}

enum Entry {
    /// Asked for; the worker is drawing it or will.
    Requested { wanted: Arc<AtomicU64>, },
    /// Drawn, waiting for the frame that wants it.
    Ready { wanted: Arc<AtomicU64>, image: SwashImage, bytes: usize },
}

/// One interface thread's side of the protocol.
struct Client {
    /// The candidate being prepared, counting up.
    epoch: u64,
    /// The oldest candidate whose requests are still wanted: shared with the worker.
    floor: Arc<AtomicU64>,
    entries: HashMap<CacheKey, Entry>,
    replies: Receiver<Reply>,
    sender: Sender<Reply>,
    jobs: usize,
    job_bytes: usize,
    ready_bytes: usize,
    missing: bool,
    warm: HashMap<CacheKey, SwashImage>,
}

static WARM: OnceLock<(Sender<Reply>, Mutex<Receiver<Reply>>)> = OnceLock::new();

fn warm_channel() -> &'static (Sender<Reply>, Mutex<Receiver<Reply>>) {
    WARM.get_or_init(|| {
        let (sender, receiver) = channel();
        (sender, Mutex::new(receiver))
    })
}

thread_local! {
    static CLIENT: RefCell<Client> = RefCell::new(Client::new());
}

fn estimate(key: &CacheKey) -> usize {
    let side = (f32::from_bits(key.font_size_bits) * 1.5).ceil() as usize + 2;
    side * side * if key.flags.contains(CacheKeyFlags::LCD) { 3 } else { 1 } + 96
}

impl Client {
    fn new() -> Self {
        let (sender, replies) = channel();
        Client { epoch: 0, floor: Arc::new(AtomicU64::new(0)), entries: HashMap::new(), replies, sender, jobs: 0, job_bytes: 0, ready_bytes: 0, missing: false, warm: HashMap::new() }
    }

    /// Takes in what the worker has finished. Never waits.
    fn drain(&mut self) {
        while let Ok(reply) = self.replies.try_recv() {
            self.jobs = self.jobs.saturating_sub(1);
            self.job_bytes = self.job_bytes.saturating_sub(reply.estimate);
            let current = matches!(self.entries.get(&reply.key), Some(Entry::Requested { wanted }) if Arc::ptr_eq(wanted, &reply.wanted));
            if !current {
                // Retired while the worker drew it, or asked for again since.
                continue;
            }
            match reply.image {
                Some(image) if self.ready_bytes + image.data.len() <= MAX_READY_BYTES => {
                    let bytes = image.data.len();
                    self.ready_bytes += bytes;
                    self.entries.insert(reply.key, Entry::Ready { wanted: reply.wanted, image, bytes });
                }
                _ => {
                    self.entries.remove(&reply.key);
                }
            }
        }
        if let Ok(warm) = warm_channel().1.try_lock() {
            while let Ok(reply) = warm.try_recv() {
                if let Some(image) = reply.image {
                    if let Some(old) = self.warm.insert(reply.key, image) {
                        release_warm(old.data.len());
                    }
                }
            }
        }
    }

    fn lookup(&mut self, key: &CacheKey, font: impl FnOnce() -> Option<Arc<Font>>, direct_write: bool) -> Lookup {
        self.drain();
        if let Some(image) = self.warm.remove(key) {
            release_warm(image.data.len());
            return Lookup::Ready(image);
        }
        match self.entries.get(key) {
            Some(Entry::Ready { .. }) => {
                if let Some(Entry::Ready { image, bytes, .. }) = self.entries.remove(key) {
                    self.ready_bytes = self.ready_bytes.saturating_sub(bytes);
                    return Lookup::Ready(image);
                }
                unreachable!("the entry was just seen")
            }
            Some(Entry::Requested { wanted }) => {
                wanted.store(self.epoch, Ordering::Release);
                self.missing = true;
                return Lookup::Missing;
            }
            None => {}
        }
        let Some(font) = font() else {
            return Lookup::Absent;
        };
        self.missing = true;
        let estimate = estimate(key);
        if self.jobs >= MAX_JOBS || self.job_bytes + estimate > MAX_INFLIGHT_BYTES {
            // Not admitted: the next candidate asks again.
            return Lookup::Missing;
        }
        let wanted = Arc::new(AtomicU64::new(self.epoch));
        let job = Job { key: *key, font, direct_write, wanted: wanted.clone(), floor: self.floor.clone(), estimate, reply: self.sender.clone(), notify: true };
        if submit(job).is_ok() {
            self.jobs += 1;
            self.job_bytes += estimate;
            self.entries.insert(*key, Entry::Requested { wanted });
        }
        Lookup::Missing
    }

    fn begin(&mut self) {
        self.epoch += 1;
        self.missing = false;
        self.drain();
    }

    fn end(&mut self) -> bool {
        self.drain();
        let epoch = self.epoch;
        self.floor.store(epoch, Ordering::Release);
        let mut freed = 0;
        self.entries.retain(|_, entry| match entry {
            Entry::Requested { wanted } => wanted.load(Ordering::Acquire) >= epoch,
            Entry::Ready { wanted, bytes, .. } => {
                let wanted = wanted.load(Ordering::Acquire) >= epoch;
                if !wanted {
                    freed += *bytes;
                }
                wanted
            }
        });
        self.ready_bytes = self.ready_bytes.saturating_sub(freed);
        self.missing
    }
}

/// Starts preparing a candidate frame on this thread.
pub fn begin_candidate() {
    CLIENT.with(|client| client.borrow_mut().begin());
}

/// Ends the candidate frame: whether glyphs it needs are still being drawn (it is incomplete). Whatever it did not ask
/// for again is obsolete.
pub fn end_candidate() -> bool {
    CLIENT.with(|client| client.borrow_mut().end())
}

pub(crate) fn lookup(key: &CacheKey, font: impl FnOnce() -> Option<Arc<Font>>, direct_write: bool) -> Lookup {
    CLIENT.with(|client| client.borrow_mut().lookup(key, font, direct_write))
}

/// Asks the worker to draw glyphs before any frame wants them. Any thread may call it: the results wait for the first
/// frame that needs them. Takes glyphs from the front of `glyphs` while the queue (bounded) and the warm results'
/// budget have room, and returns how many it took; the rest stay.
pub fn prewarm(glyphs: &mut std::collections::VecDeque<(CacheKey, Arc<Font>)>, direct_write: bool) -> usize {
    static EVER: OnceLock<Arc<AtomicU64>> = OnceLock::new();
    static NEVER: OnceLock<Arc<AtomicU64>> = OnceLock::new();
    let wanted = EVER.get_or_init(|| Arc::new(AtomicU64::new(u64::MAX))).clone();
    let floor = NEVER.get_or_init(|| Arc::new(AtomicU64::new(0))).clone();
    let mut admitted = 0;
    while let Some((key, font)) = glyphs.pop_front() {
        if WARM_BYTES.load(Ordering::Acquire) >= MAX_WARM_BYTES {
            glyphs.push_front((key, font));
            break;
        }
        let job = Job { key, font, direct_write, wanted: wanted.clone(), floor: floor.clone(), estimate: 0, reply: warm_channel().0.clone(), notify: false };
        match submit(job) {
            Ok(()) => admitted += 1,
            Err(job) => {
                glyphs.push_front((job.key, job.font));
                break;
            }
        }
    }
    admitted
}

/// How many jobs wait in front of the worker (frames' and warm) and how many bytes of warm glyphs wait for their first frame.
pub fn worker_state() -> (usize, usize) {
    (QUEUED.load(Ordering::Acquire) + WARM_QUEUED.load(Ordering::Acquire), WARM_BYTES.load(Ordering::Acquire))
}

/// How many jobs this thread has outstanding and how many masks wait: for tests and diagnostics.
pub fn client_state() -> (usize, usize) {
    CLIENT.with(|client| {
        let client = client.borrow();
        (client.jobs, client.entries.len())
    })
}
