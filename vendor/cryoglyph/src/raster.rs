//! Glyph masks drawn off the interface thread.
//!
//! On Windows the program can ask for DirectWrite's masks (`TextRendering::direct_write`): the rasterizer Chromium uses.
//! A glyph missing from the atlas is requested here, drawn on a worker thread and picked up by a later `prepare`, which
//! uploads it; until then that glyph is left out of the frame. Nothing waits for the worker: a frame that finds glyphs
//! missing says so ([`TextRenderer::incomplete`](crate::TextRenderer::incomplete)) and the program asks for another frame
//! when the worker is done ([`set_glyph_notifier`]). Elsewhere, and for glyphs DirectWrite cannot draw as a mask (colour
//! glyphs), swash draws them in `prepare` as it always did.

use cosmic_text::{CacheKey, SwashImage};
use std::sync::atomic::{AtomicUsize, Ordering};

/// What a worker made of a glyph.
pub(crate) enum Outcome {
    /// The glyph's image.
    Image(SwashImage),
    /// A glyph the worker cannot draw: swash must.
    Unsupported,
}

static PENDING: AtomicUsize = AtomicUsize::new(0);

/// How many glyphs have been requested and not yet been picked up by a `prepare`: zero when the text on screen is
/// complete.
pub fn glyphs_pending() -> usize {
    PENDING.load(Ordering::Acquire)
}

#[cfg(windows)]
mod worker {
    use super::{Outcome, PENDING};
    use cosmic_text::dwrite::{DirectWrite, Rasterized};
    use cosmic_text::{CacheKey, Font, SwashContent, SwashImage};
    use std::collections::{HashMap, HashSet};
    use std::sync::atomic::Ordering;
    use std::sync::mpsc::{Receiver, Sender, channel};
    use std::sync::{Arc, Mutex, OnceLock, RwLock};

    type Notifier = Arc<dyn Fn() + Send + Sync>;

    static NOTIFIER: RwLock<Option<Notifier>> = RwLock::new(None);

    pub fn set_notifier(notifier: Notifier) {
        *NOTIFIER.write().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(notifier);
    }

    struct Job {
        key: CacheKey,
        font: Arc<Font>,
    }

    struct Shared {
        /// Glyphs drawn and not yet picked up.
        ready: Mutex<HashMap<CacheKey, Outcome>>,
        /// Glyphs requested and not yet picked up (drawing or ready), so one is never requested twice.
        requested: Mutex<HashSet<CacheKey>>,
    }

    pub struct Worker {
        shared: Arc<Shared>,
        sender: Sender<Job>,
    }

    static WORKER: OnceLock<Worker> = OnceLock::new();

    /// The worker, started on first use.
    pub fn worker() -> &'static Worker {
        WORKER.get_or_init(|| {
            let shared = Arc::new(Shared { ready: Mutex::new(HashMap::new()), requested: Mutex::new(HashSet::new()) });
            let (sender, receiver) = channel();
            let thread_shared = shared.clone();
            let _ = std::thread::Builder::new().name("glyphs".into()).spawn(move || run(receiver, thread_shared));
            Worker { shared, sender }
        })
    }

    impl Worker {
        /// The glyph, if the worker has drawn it.
        pub fn take(&self, key: &CacheKey) -> Option<Outcome> {
            let outcome = self.shared.ready.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(key)?;
            self.shared.requested.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(key);
            PENDING.fetch_sub(1, Ordering::AcqRel);
            Some(outcome)
        }

        /// Asks for the glyph, unless it has been asked for.
        pub fn request(&self, key: CacheKey, font: Arc<Font>) {
            if !self.shared.requested.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(key) {
                return;
            }
            PENDING.fetch_add(1, Ordering::AcqRel);
            if self.sender.send(Job { key, font }).is_err() {
                // The worker is gone: hand the glyph to swash.
                self.shared.ready.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(key, Outcome::Unsupported);
            }
        }
    }

    fn run(receiver: Receiver<Job>, shared: Arc<Shared>) {
        let mut direct_write = DirectWrite::new();
        while let Ok(Job { key, font }) = receiver.recv() {
            let outcome = match direct_write.as_mut() {
                Some(direct_write) => draw(direct_write, &key, &font),
                None => Outcome::Unsupported,
            };
            shared.ready.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(key, outcome);
            if let Some(notifier) = NOTIFIER.read().unwrap_or_else(|poisoned| poisoned.into_inner()).clone() {
                notifier();
            }
        }
    }

    fn draw(direct_write: &mut DirectWrite, key: &CacheKey, font: &Font) -> Outcome {
        let lcd = key.flags.contains(cosmic_text::CacheKeyFlags::LCD);
        match direct_write.rasterize(font, key.glyph_id, f32::from_bits(key.font_size_bits), key.font_weight.0, key.font_optical_size, key.x_bin.as_float(), lcd) {
            Rasterized::Unsupported => Outcome::Unsupported,
            Rasterized::Empty => Outcome::Image(SwashImage::default()),
            Rasterized::Mask(mask) => {
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
                Outcome::Image(image)
            }
        }
    }
}

/// Tells the program, from the worker's thread, that glyphs have been drawn and a frame will use them: it asks the window
/// for another frame. Without one, glyphs appear at the next frame something else asks for.
pub fn set_glyph_notifier(notifier: impl Fn() + Send + Sync + 'static) {
    #[cfg(windows)]
    worker::set_notifier(std::sync::Arc::new(notifier));
    #[cfg(not(windows))]
    let _ = notifier;
}

/// The glyph a worker has drawn, if it has: `None` while it is being drawn, which also asks for it.
#[cfg(windows)]
pub(crate) fn pick_up(key: &CacheKey, font: impl FnOnce() -> Option<std::sync::Arc<cosmic_text::Font>>) -> Option<Outcome> {
    let worker = worker::worker();
    if let Some(outcome) = worker.take(key) {
        return Some(outcome);
    }
    match font() {
        Some(font) => {
            worker.request(*key, font);
            None
        }
        // No font to draw it from: swash will find out as much.
        None => Some(Outcome::Unsupported),
    }
}

/// Without DirectWrite there is no worker: swash draws every glyph in `prepare`.
#[cfg(not(windows))]
pub(crate) fn pick_up(_: &CacheKey, _: impl FnOnce() -> Option<std::sync::Arc<cosmic_text::Font>>) -> Option<Outcome> {
    Some(Outcome::Unsupported)
}
