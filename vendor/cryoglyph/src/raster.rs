//! Glyph masks drawn off the interface thread.
//!
//! A program may ask for its glyphs to be drawn by a worker thread ([`GlyphDrawing`]): on Windows with DirectWrite, the
//! rasterizer Chromium uses there, elsewhere with swash. The interface thread then never draws a glyph; it asks and
//! picks up what is ready, and nothing in this module waits for the worker or takes a lock the worker holds:
//!
//! - **Consumers.** Every [`Viewport`](crate::Viewport) (one per renderer, so one per window) is a consumer with a
//!   bookkeeping of its own: what it asked for, what came back, its candidate counter and its cancellation floor. One
//!   consumer ending a candidate never retires another's requests, and replies find their way back to who asked.
//! - **Requests** go to the worker through a bounded queue with nonblocking admission: at most [`MAX_JOBS`] jobs per
//!   consumer, and every job holds a byte `Reservation` against the budget of all masks ([`FRAME_BYTES`]) from before
//!   the mask is allocated until the mask has been uploaded or thrown away. A request that is not admitted is asked for
//!   again by the next candidate. A mask that turns out larger than was reserved and cannot be reserved is answered
//!   with an overflow, which removes the request so the next candidate asks again with the size learned. Nothing is
//!   dropped silently.
//! - **Results** come back on the consumer's own channel and are drained by its thread. They keep their reservation
//!   while they wait in the consumer's store.
//! - **A candidate** is one frame a consumer is preparing: `begin_candidate` starts it, every glyph missing from the
//!   atlas that it needs is looked up and `end_candidate` says whether it was complete. A request the candidate did not
//!   touch is obsolete when it ends: the worker skips its job if it has not started and its result is thrown away on
//!   arrival. A glyph a superseded frame wanted is never waited for.
//! - **Warm glyphs** ([`prewarm`]) are drawn before any frame wants them, by any thread that has the fonts, against a
//!   byte budget of their own ([`WARM_BYTES`]) reserved before they are queued. The consumers share them.
//! - **A failure never leaves a hole.** A DirectWrite failure (a panic, say) is drawn again by swash on the worker; if
//!   the worker thread itself dies, the jobs it had queued answer "lost" as they are dropped, the next request starts a
//!   new worker, and the consumers ask again.

use cosmic_text::{CacheKey, CacheKeyFlags, Font, SwashCache, SwashImage};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
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

/// Jobs one consumer may have outstanding at the worker.
pub const MAX_JOBS: usize = 256;
/// The bytes all masks asked for by frames may hold at once: reserved when asked, until uploaded or thrown away.
pub const FRAME_BYTES: usize = 16 << 20;
/// The bytes the warm masks may hold at once.
pub const WARM_BYTES: usize = 16 << 20;
/// The queue in front of the worker.
const QUEUE: usize = 1024;
/// The worker tells the program it has glyphs at least this often while it is busy, and whenever it runs dry.
const NOTIFY_EVERY: Duration = Duration::from_millis(4);

/// What looking a glyph up found.
pub(crate) enum Lookup {
    /// The glyph's image, drawn by the worker, with the reservation of its bytes: the caller keeps it until the mask has
    /// been uploaded.
    Ready(SwashImage, Option<Reservation>),
    /// Not drawn yet: it has been asked for, the candidate is incomplete.
    Missing,
    /// There is no font to draw it from: the glyph is left out and nothing waits for it.
    Absent,
}

// ---------------------------------------------------------------------------------------------------------------------
// Byte budgets

/// A byte budget shared by every holder of a `Reservation` against it.
struct Budget {
    cap: AtomicUsize,
    held: AtomicUsize,
}

impl Budget {
    const fn new(cap: usize) -> Self {
        Budget { cap: AtomicUsize::new(cap), held: AtomicUsize::new(0) }
    }

    /// Reserves `bytes`, or `None` when they do not fit. The budget never goes over its cap, except that a reservation
    /// is always granted when nothing else is held: one mask larger than the cap must still be able to pass, alone.
    fn reserve(&'static self, bytes: usize) -> Option<Reservation> {
        let cap = self.cap.load(Ordering::Acquire);
        self.held.try_update(Ordering::AcqRel, Ordering::Acquire, |held| (held == 0 || held + bytes <= cap).then_some(held + bytes)).ok()?;
        Some(Reservation { budget: self, bytes })
    }

    fn held(&self) -> usize {
        self.held.load(Ordering::Acquire)
    }
}

/// Bytes held against a [`Budget`], released when dropped.
pub(crate) struct Reservation {
    budget: &'static Budget,
    bytes: usize,
}

impl Reservation {
    /// Changes the reservation to `bytes`: a smaller one always succeeds, a larger one only if the difference fits (or
    /// this is all the budget holds).
    fn resize(&mut self, bytes: usize) -> bool {
        if bytes <= self.bytes {
            self.budget.held.fetch_sub(self.bytes - bytes, Ordering::AcqRel);
            self.bytes = bytes;
            return true;
        }
        let (cap, extra, mine) = (self.budget.cap.load(Ordering::Acquire), bytes - self.bytes, self.bytes);
        let granted = self.budget.held.try_update(Ordering::AcqRel, Ordering::Acquire, |held| (held == mine || held + extra <= cap).then_some(held + extra)).is_ok();
        if granted {
            self.bytes = bytes;
        }
        granted
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        self.budget.held.fetch_sub(self.bytes, Ordering::AcqRel);
    }
}

static FRAMES: Budget = Budget::new(FRAME_BYTES);
static WARM: Budget = Budget::new(WARM_BYTES);

/// How many bytes of masks frames hold now (asked for, drawn, or waiting for their frame).
pub fn frame_bytes() -> usize {
    FRAMES.held()
}

/// The size a glyph's mask is reserved at before it is drawn: its largest plausible box, at the largest bytes a pixel
/// the pipeline holds at once (a ClearType mask is held as three bytes and again as four).
fn estimate(key: &CacheKey) -> usize {
    let side = (f32::from_bits(key.font_size_bits) * 1.5).ceil() as usize + 2;
    side * side * if key.flags.contains(CacheKeyFlags::LCD) { 7 } else { 4 } + 96
}

// ---------------------------------------------------------------------------------------------------------------------
// The worker

type Notifier = Arc<dyn Fn() + Send + Sync>;

static NOTIFIER: RwLock<Option<Notifier>> = RwLock::new(None);

/// Tells the program, from the worker's thread, that glyphs have been drawn and a frame can use them: it asks the window
/// for another frame. Without one, glyphs appear at the next frame something else asks for.
pub fn set_glyph_notifier(notifier: impl Fn() + Send + Sync + 'static) {
    *NOTIFIER.write().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Arc::new(notifier));
}

enum Outcome {
    /// The mask, with its reservation.
    Drawn { image: SwashImage, reservation: Reservation },
    /// The job was obsolete, or lost with its worker.
    Skipped,
    /// The mask needs this many bytes and they were not granted.
    Overflow(usize),
}

struct Reply {
    key: CacheKey,
    wanted: Arc<AtomicU64>,
    outcome: Outcome,
}

/// The right to an answer: a job that is dropped unanswered (its worker died) answers "lost".
struct Ticket {
    key: CacheKey,
    wanted: Arc<AtomicU64>,
    reply: Option<Sender<Reply>>,
}

impl Ticket {
    fn answer(mut self, outcome: Outcome) {
        if let Some(reply) = self.reply.take() {
            let _ = reply.send(Reply { key: self.key, wanted: self.wanted.clone(), outcome });
        }
    }
}

impl Drop for Ticket {
    fn drop(&mut self) {
        if let Some(reply) = self.reply.take() {
            let _ = reply.send(Reply { key: self.key, wanted: self.wanted.clone(), outcome: Outcome::Skipped });
        }
    }
}

struct Job {
    font: Arc<Font>,
    direct_write: bool,
    ticket: Ticket,
    /// The oldest candidate whose requests the consumer still wants: a job older than it is obsolete.
    floor: Arc<AtomicU64>,
    reservation: Reservation,
    /// Whether the worker tells the program when this job is done (a frame waits for it).
    notify: bool,
}

/// Jobs waiting for the worker: frames' and warm ones.
static QUEUED: AtomicUsize = AtomicUsize::new(0);
static WARM_QUEUED: AtomicUsize = AtomicUsize::new(0);

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

/// Queues `job` without waiting: `Err` gives it back when the queue is full or no worker can be started. A dead worker
/// is replaced.
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

/// What drawing a glyph came to.
enum Drawn {
    Image(SwashImage),
    /// The mask needs this many bytes and they were not granted.
    Overflow(usize),
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

    /// Draws the glyph of `key`, holding its mask within `reservation`. DirectWrite is tried first where `direct_write`
    /// allows; swash draws what it does not.
    fn image(&mut self, key: &CacheKey, font: &Font, direct_write: bool, reservation: &mut Reservation) -> Drawn {
        if OVERFLOWS.try_update(Ordering::AcqRel, Ordering::Acquire, |left| left.checked_sub(1)).is_ok() {
            return Drawn::Overflow(reservation.bytes + 1);
        }
        let flags = key.flags;
        // DirectWrite draws the glyph as the font says; the synthetic styles, unhinted and pixel-snapped glyphs are
        // swash's.
        let swash_only = flags.intersects(CacheKeyFlags::FAKE_ITALIC | CacheKeyFlags::DISABLE_HINTING | CacheKeyFlags::PIXEL_FONT);
        #[cfg(windows)]
        if direct_write && !swash_only {
            if let Some(drawer) = self.direct_write.as_mut() {
                use cosmic_text::dwrite::{Rasterized, Smoothing};
                if FAIL_DRAWS.try_update(Ordering::AcqRel, Ordering::Acquire, |left| left.checked_sub(1)).is_ok() {
                    panic!("an injected DirectWrite failure");
                }
                let smoothing = if flags.contains(CacheKeyFlags::LCD) {
                    Smoothing::ClearType
                } else if flags.contains(CacheKeyFlags::ALIASED) {
                    Smoothing::Aliased
                } else {
                    Smoothing::Grayscale
                };
                let mut needed = 0;
                let drawn = drawer.rasterize(font, key.glyph_id, f32::from_bits(key.font_size_bits), key.font_weight.0, key.font_optical_size, key.x_bin.as_float(), smoothing, &mut |pixels, lcd| {
                    // The mask's bytes, and for ClearType the four-byte copy the atlas upload is made from.
                    needed = if lcd { pixels * 7 } else { pixels };
                    reservation.resize(needed)
                });
                match drawn {
                    Rasterized::Empty => return Drawn::Image(SwashImage::default()),
                    Rasterized::Mask(mask) => return Drawn::Image(mask_image(mask)),
                    Rasterized::Overflow => return Drawn::Overflow(needed),
                    Rasterized::Unsupported => {}
                }
            }
        }
        let _ = (swash_only, direct_write);
        let image = self.swash.get_image_of_font(font, *key).unwrap_or_default();
        if image.data.len() > reservation.bytes && !reservation.resize(image.data.len()) {
            return Drawn::Overflow(image.data.len());
        }
        Drawn::Image(image)
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

// Test seams: they exist so that the tests can make the worker slow, make DirectWrite fail and kill the worker.
static DELAY_MILLIS: AtomicU64 = AtomicU64::new(0);
#[cfg(windows)]
static FAIL_DRAWS: AtomicUsize = AtomicUsize::new(0);
static KILL: AtomicBool = AtomicBool::new(false);
static SKIPPED: AtomicUsize = AtomicUsize::new(0);

/// How many frame jobs the worker has skipped as obsolete, in all: a request that no candidate wanted any more. For tests
/// and diagnostics.
pub fn skipped_jobs() -> usize {
    SKIPPED.load(Ordering::Acquire)
}
static OVERFLOWS: AtomicUsize = AtomicUsize::new(0);

/// For tests: the worker waits this long before each frame glyph it draws.
#[doc(hidden)]
pub fn slow_worker(delay: Duration) {
    DELAY_MILLIS.store(delay.as_millis() as u64, Ordering::Release);
}

/// For tests: the next `count` DirectWrite draws panic.
#[doc(hidden)]
pub fn fail_draws(count: usize) {
    #[cfg(windows)]
    FAIL_DRAWS.store(count, Ordering::Release);
    #[cfg(not(windows))]
    let _ = count;
}

/// For tests: the next `count` draws find their mask larger than what was reserved for it, and cannot get more.
#[doc(hidden)]
pub fn overflow_draws(count: usize) {
    OVERFLOWS.store(count, Ordering::Release);
}

/// For tests: the worker thread dies at its next job (the next request starts a new one).
#[doc(hidden)]
pub fn kill_worker() {
    KILL.store(true, Ordering::Release);
}

/// For tests: the cap of the frames' byte budget (the default is [`FRAME_BYTES`]).
#[doc(hidden)]
pub fn set_frame_budget(bytes: usize) {
    FRAMES.cap.store(bytes, Ordering::Release);
}

fn run(frames: Receiver<Job>, warm_glyphs: Receiver<Job>) {
    let mut drawer = Drawer::new();
    let mut last_notice = Instant::now();
    loop {
        if KILL.swap(false, Ordering::AcqRel) {
            panic!("the glyph worker was killed by a test");
        }
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
        let Job { font, direct_write, ticket, floor, mut reservation, notify } = job;
        if ticket.wanted.load(Ordering::Acquire) < floor.load(Ordering::Acquire) {
            if notify {
                SKIPPED.fetch_add(1, Ordering::AcqRel);
            }
            ticket.answer(Outcome::Skipped);
            continue;
        }
        if notify {
            let delay = DELAY_MILLIS.load(Ordering::Acquire);
            if delay > 0 {
                std::thread::sleep(Duration::from_millis(delay));
            }
        }
        let key = ticket.key;
        let attempt = |drawer: &mut Drawer, reservation: &mut Reservation, direct_write: bool| std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drawer.image(&key, &font, direct_write, reservation)));
        // A failure of DirectWrite is drawn again by swash; a failure of both leaves an empty glyph (nothing to show).
        let drawn = attempt(&mut drawer, &mut reservation, direct_write).or_else(|_| attempt(&mut drawer, &mut reservation, false)).unwrap_or_else(|_| Drawn::Image(SwashImage::default()));
        let outcome = match drawn {
            Drawn::Image(image) => {
                reservation.resize(image.data.len().max(1));
                Outcome::Drawn { image, reservation }
            }
            Drawn::Overflow(needed) => Outcome::Overflow(needed),
        };
        ticket.answer(outcome);
        // Wake the program when the worker runs dry and, while it is busy, every few milliseconds.
        if notify && (QUEUED.load(Ordering::Acquire) == 0 || last_notice.elapsed() >= NOTIFY_EVERY) {
            last_notice = Instant::now();
            if let Some(notifier) = NOTIFIER.read().unwrap_or_else(|poisoned| poisoned.into_inner()).clone() {
                notifier();
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// The warm glyphs, shared by every consumer

struct Shelved {
    image: SwashImage,
    _reservation: Reservation,
}

/// The warm glyphs drawn and waiting for a frame. Only interface threads lock this, and only with `try_lock`.
static SHELF: Mutex<Option<HashMap<CacheKey, Shelved>>> = Mutex::new(None);
static WARM_MAILBOX: OnceLock<(Sender<Reply>, Mutex<Receiver<Reply>>)> = OnceLock::new();
static CONSUMERS: AtomicUsize = AtomicUsize::new(0);

fn warm_mailbox() -> &'static (Sender<Reply>, Mutex<Receiver<Reply>>) {
    WARM_MAILBOX.get_or_init(|| {
        let (sender, receiver) = channel();
        (sender, Mutex::new(receiver))
    })
}

/// Moves what the worker drew for the warm glyphs onto the shelf. Never waits: what cannot be taken now stays in the
/// mailbox for the next time.
fn drain_warm() {
    let Ok(receiver) = warm_mailbox().1.try_lock() else { return };
    let Ok(mut shelf) = SHELF.try_lock() else { return };
    let shelf = shelf.get_or_insert_with(HashMap::new);
    while let Ok(reply) = receiver.try_recv() {
        if let Outcome::Drawn { image, reservation } = reply.outcome {
            shelf.insert(reply.key, Shelved { image, _reservation: reservation });
        }
        // A warm glyph that was skipped or did not fit is asked for the ordinary way when a frame needs it.
    }
}

fn take_warm(key: &CacheKey) -> Option<(SwashImage, Option<Reservation>)> {
    let Ok(mut shelf) = SHELF.try_lock() else { return None };
    let shelf = shelf.as_mut()?;
    // With one consumer the warm glyph has done its job once it is in that consumer's atlas; with several, each needs it.
    if CONSUMERS.load(Ordering::Acquire) <= 1 { shelf.remove(key).map(|warm| (warm.image, Some(warm._reservation))) } else { shelf.get(key).map(|warm| (warm.image.clone(), None)) }
}

/// Asks the worker to draw glyphs before any frame wants them. Any thread may call it: the results wait on a shelf for
/// the frames that need them. Takes glyphs from the front of `glyphs` while the queue and the warm byte budget have room
/// (each glyph's bytes are reserved before it is queued), and returns how many it took; the rest stay.
pub fn prewarm(glyphs: &mut std::collections::VecDeque<(CacheKey, Arc<Font>)>, direct_write: bool) -> usize {
    static EVER: OnceLock<Arc<AtomicU64>> = OnceLock::new();
    static NEVER: OnceLock<Arc<AtomicU64>> = OnceLock::new();
    let wanted = EVER.get_or_init(|| Arc::new(AtomicU64::new(u64::MAX))).clone();
    let floor = NEVER.get_or_init(|| Arc::new(AtomicU64::new(0))).clone();
    let mut admitted = 0;
    while let Some((key, font)) = glyphs.pop_front() {
        let Some(reservation) = WARM.reserve(estimate(&key)) else {
            glyphs.push_front((key, font));
            break;
        };
        let ticket = Ticket { key, wanted: wanted.clone(), reply: Some(warm_mailbox().0.clone()) };
        match submit(Job { font, direct_write, ticket, floor: floor.clone(), reservation, notify: false }) {
            Ok(()) => admitted += 1,
            Err(job) => {
                let key = job.ticket.key;
                glyphs.push_front((key, job.font.clone()));
                break;
            }
        }
    }
    admitted
}

/// How many jobs wait in front of the worker (frames' and warm) and how many bytes of warm glyphs are held.
pub fn worker_state() -> (usize, usize) {
    (QUEUED.load(Ordering::Acquire) + WARM_QUEUED.load(Ordering::Acquire), WARM.held())
}

// ---------------------------------------------------------------------------------------------------------------------
// A consumer

enum Entry {
    /// Asked for; the worker is drawing it or will.
    Requested { wanted: Arc<AtomicU64> },
    /// Drawn, waiting for the frame that wants it.
    Ready { wanted: Arc<AtomicU64>, image: SwashImage, _reservation: Reservation },
}

/// One consumer's side of the protocol (one per [`Viewport`](crate::Viewport)).
pub(crate) struct Client {
    /// The candidate being prepared, counting up.
    epoch: u64,
    /// The oldest candidate whose requests are still wanted: shared with the worker.
    floor: Arc<AtomicU64>,
    entries: HashMap<CacheKey, Entry>,
    replies: Receiver<Reply>,
    sender: Sender<Reply>,
    jobs: usize,
    missing: bool,
    /// Masks that did not fit their reservation: what they need, for the next request.
    larger: HashMap<CacheKey, usize>,
}

impl std::fmt::Debug for Client {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Client").field("epoch", &self.epoch).field("jobs", &self.jobs).field("entries", &self.entries.len()).finish_non_exhaustive()
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        CONSUMERS.fetch_sub(1, Ordering::AcqRel);
    }
}

impl Client {
    pub(crate) fn new() -> Self {
        CONSUMERS.fetch_add(1, Ordering::AcqRel);
        let (sender, replies) = channel();
        Client { epoch: 0, floor: Arc::new(AtomicU64::new(0)), entries: HashMap::new(), replies, sender, jobs: 0, missing: false, larger: HashMap::new() }
    }

    /// Takes in what the worker has finished. Never waits.
    fn drain(&mut self) {
        while let Ok(reply) = self.replies.try_recv() {
            self.jobs = self.jobs.saturating_sub(1);
            let current = matches!(self.entries.get(&reply.key), Some(Entry::Requested { wanted }) if Arc::ptr_eq(wanted, &reply.wanted));
            if !current {
                // Retired while the worker drew it, or asked for again since.
                continue;
            }
            match reply.outcome {
                Outcome::Drawn { image, reservation } => {
                    self.entries.insert(reply.key, Entry::Ready { wanted: reply.wanted, image, _reservation: reservation });
                }
                Outcome::Overflow(needed) => {
                    // Recoverable: the request is removed, the candidate stays incomplete, and the next one asks again
                    // with the size the mask turned out to need.
                    if self.larger.len() > 1024 {
                        self.larger.clear();
                    }
                    self.larger.insert(reply.key, needed);
                    self.entries.remove(&reply.key);
                }
                Outcome::Skipped => {
                    self.entries.remove(&reply.key);
                }
            }
        }
        drain_warm();
    }

    pub(crate) fn lookup(&mut self, key: &CacheKey, font: impl FnOnce() -> Option<Arc<Font>>, direct_write: bool) -> Lookup {
        self.drain();
        if let Some((image, reservation)) = take_warm(key) {
            return Lookup::Ready(image, reservation);
        }
        match self.entries.get(key) {
            Some(Entry::Ready { .. }) => {
                if let Some(Entry::Ready { image, _reservation, .. }) = self.entries.remove(key) {
                    return Lookup::Ready(image, Some(_reservation));
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
        if self.jobs >= MAX_JOBS {
            // Not admitted: the next candidate asks again.
            return Lookup::Missing;
        }
        let Some(reservation) = FRAMES.reserve(self.larger.get(key).copied().unwrap_or_else(|| estimate(key))) else {
            return Lookup::Missing;
        };
        let wanted = Arc::new(AtomicU64::new(self.epoch));
        let ticket = Ticket { key: *key, wanted: wanted.clone(), reply: Some(self.sender.clone()) };
        if submit(Job { font, direct_write, ticket, floor: self.floor.clone(), reservation, notify: true }).is_ok() {
            self.jobs += 1;
            self.entries.insert(*key, Entry::Requested { wanted });
        }
        Lookup::Missing
    }

    pub(crate) fn begin(&mut self) {
        self.epoch += 1;
        self.missing = false;
        self.drain();
    }

    pub(crate) fn end(&mut self) -> bool {
        self.drain();
        let epoch = self.epoch;
        self.floor.store(epoch, Ordering::Release);
        self.entries.retain(|_, entry| match entry {
            Entry::Requested { wanted } | Entry::Ready { wanted, .. } => wanted.load(Ordering::Acquire) >= epoch,
        });
        self.missing
    }

    /// How many jobs this consumer has outstanding and how many entries (asked for or waiting) it keeps.
    pub(crate) fn state(&self) -> (usize, usize) {
        (self.jobs, self.entries.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    static TEST_BUDGET: Budget = Budget::new(1000);

    #[test]
    fn a_budget_never_goes_over_its_cap_and_gives_bytes_back() {
        let first = TEST_BUDGET.reserve(600).expect("fits");
        assert!(TEST_BUDGET.reserve(500).is_none(), "600 + 500 is over 1000");
        let second = TEST_BUDGET.reserve(400).expect("exactly the cap");
        assert_eq!(TEST_BUDGET.held(), 1000);
        drop(first);
        assert_eq!(TEST_BUDGET.held(), 400, "dropping a reservation gives its bytes back");
        drop(second);
        assert_eq!(TEST_BUDGET.held(), 0);
    }

    #[test]
    fn a_mask_larger_than_the_cap_passes_alone_and_only_alone() {
        static SMALL: Budget = Budget::new(100);
        let alone = SMALL.reserve(5000).expect("nothing else is held: one large mask can still pass");
        assert!(SMALL.reserve(1).is_none(), "but nothing joins it");
        drop(alone);
        let small = SMALL.reserve(50).expect("fits");
        assert!(SMALL.reserve(5000).is_none(), "a large mask does not pass while others are held");
        drop(small);
    }

    #[test]
    fn a_reservation_grows_only_when_the_difference_fits_and_shrinks_always() {
        static GROW: Budget = Budget::new(1000);
        let other = GROW.reserve(500).expect("fits");
        let mut mine = GROW.reserve(400).expect("fits");
        assert!(!mine.resize(600), "400 + 500 + 200 is over 1000");
        assert_eq!((mine.bytes, GROW.held()), (400, 900), "a refused growth changes nothing");
        assert!(mine.resize(500));
        assert_eq!(GROW.held(), 1000);
        assert!(mine.resize(100));
        assert_eq!(GROW.held(), 600, "shrinking gives the difference back");
        drop(other);
        assert!(mine.resize(5000), "when it is all the budget holds, it can grow past the cap");
        drop(mine);
        assert_eq!(GROW.held(), 0);
    }
}
