//! The stage drawn by the processor renderer (styk-raster) on the engine's workers, for a stage whose graphics device is
//! itself a software rasterizer (docs/engine/rendering.md, "The stage on the processor"; decision D21).
//!
//! The interface asks for a frame ([`StageRaster::request`]) and returns. A job on a worker readies what the frame needs
//! (the pictures handed over since the last frame, any picture it samples that is not held, decoded there from the
//! document; the lone glyphs' masks) and cuts the frame into bands of [`BAND_ROWS`] rows, each a task any worker takes;
//! each band writes its rows, straight RGBA, into the frame's buffer. The interface looks again when the engine reports
//! progress ([`StageRaster::poll`]) and shows the newest frame finished ([`StageRaster::ready`]); the picture on show stays
//! meanwhile. Nothing here waits on the interface thread (D7): it only queues tasks, swaps pointers and copies the frame.
//!
//! Bounded: one frame is drawn at a time and one more waits for it (a newer request replaces the waiting one, so a
//! gesture never piles up frames), one finished frame waits to be shown, and one buffer is kept for the next frame: at
//! most three frame buffers of the canvas's size. The pictures are the decoded images the stage takes from the engine
//! (shared, not copied), within [`Images`]' budget; everything is let go of with the stage, on a worker.

use std::cell::UnsafeCell;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use styk_eval::assets::{Assets, DecodedImage};
use styk_eval::drawlist::DrawList;
use styk_raster::{DrawingGrid, Edges, Images, Raster, ViewParams};

use crate::{Engine, Generation};

/// Rows of a frame one task draws: about a dozen tasks for a canvas of 1,200 × 700, so the workers share a frame
/// whatever part of it the figures crowd.
pub const BAND_ROWS: u32 = 64;

/// Pictures waiting to be handed to the frames' job beyond which a job takes them without a frame (bytes): an idle stage
/// taking in a document's pictures does not hold them twice.
const PENDING_BYTES: usize = 16 << 20;

/// A frame to draw.
pub struct Request {
    /// The document it is drawn from: its pictures are decoded from it where none was handed over.
    pub generation: Arc<Generation>,
    pub list: Arc<DrawList>,
    pub view: ViewParams,
    /// The turned or mirrored workspace view ([`Raster::set_orientation`]).
    pub orientation: Option<[f64; 6]>,
    pub size: [u32; 2],
    pub grid: DrawingGrid,
}

/// One frame being drawn or drawn: straight RGBA rows, written band by band (each band its own rows).
pub struct Shot {
    pub serial: u64,
    pub width: u32,
    pub height: u32,
    pixels: UnsafeCell<Vec<u8>>,
    /// The frame's job and its bands not ended yet.
    left: AtomicUsize,
    cancelled: AtomicBool,
    /// A picture it samples could not be held (the memory is full): it is not shown.
    failed: AtomicBool,
    /// When it was asked for, and microseconds of work its job and bands took in all.
    asked_ms: f64,
    done_ms: AtomicU64,
    work_us: AtomicU64,
}

// Bands write disjoint rows of `pixels`; the stage reads them only once every band has ended (`left` is 0).
unsafe impl Sync for Shot {}

impl Shot {
    fn ended(&self) -> bool {
        self.left.load(Ordering::Acquire) == 0
    }

    fn end(&self, engine: &Engine) {
        self.done_ms.fetch_max(engine.now().to_bits(), Ordering::Relaxed);
        self.left.fetch_sub(1, Ordering::AcqRel);
    }

    /// Rows `y0 .. y0 + rows`, for the band that draws them.
    #[allow(clippy::mut_from_ref)]
    unsafe fn rows(&self, y0: u32, rows: u32) -> &mut [u8] {
        let stride = self.width as usize * 4;
        let all = unsafe { &mut *self.pixels.get() };
        &mut all[y0 as usize * stride..(y0 + rows) as usize * stride]
    }

    /// The frame's pixels: straight RGBA rows, `width × 4` bytes each.
    pub fn pixels(&self) -> &[u8] {
        assert!(self.ended(), "a frame is read once it is drawn");
        unsafe { &*self.pixels.get() }
    }
}

/// What the stage hands to the frames' job, in order.
enum Change {
    /// A decoded picture the stage took from the engine (for the GPU atlas too), placed by `assets`.
    Image(Arc<Assets>, Arc<DecodedImage>),
    /// A live drawing cel's slot ([`Images::put_tile`]).
    Tile((u32, u32, u32), Arc<DecodedImage>),
    /// The live cels' pages moved: their tiles from this atlas layer on are let go of.
    DropTilesFrom(u32),
}

/// What the frames' job keeps from one frame to the next, taken by one job at a time on a worker.
struct Painter {
    raster: Raster,
    images: Arc<Images>,
    /// The document lineage the pictures are laid out for.
    lineage: u64,
}

/// What a frame cost, for the stage's statistics.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Stats {
    /// Frames shown, and frames asked for that a newer one replaced before they were drawn.
    pub shown: u64,
    pub replaced: u64,
    /// The last frame shown: from its request to its last band, and the work of its job and bands in all (ms).
    pub frame_ms: f64,
    pub work_ms: f64,
    pub bands: u32,
    /// Bytes of the frame buffers held, and of the pictures the job holds after the last frame.
    pub buffer_bytes: usize,
    pub picture_bytes: usize,
}

/// The frames of one stage drawn on the engine's workers.
pub struct StageRaster {
    engine: Engine,
    serial: u64,
    drawing: Option<Arc<Shot>>,
    queued: Option<Request>,
    ready: Option<Arc<Shot>>,
    spare: Option<Vec<u8>>,
    painter: Arc<Mutex<Painter>>,
    changes: Vec<Change>,
    change_bytes: usize,
    picture_bytes: Arc<AtomicUsize>,
    failed: bool,
    stats: Stats,
}

impl StageRaster {
    pub fn new(engine: &Engine) -> StageRaster {
        let painter = Painter { raster: Raster::new(Edges::Smooth), images: Arc::new(Images::default()), lineage: 0 };
        StageRaster { engine: engine.clone(), serial: 0, drawing: None, queued: None, ready: None, spare: None, painter: Arc::new(Mutex::new(painter)), changes: Vec::new(),
            change_bytes: 0, picture_bytes: Arc::default(), failed: false, stats: Stats::default() }
    }

    /// Asks for a frame: drawn now when no other is being drawn, else once it is (replacing any other waiting).
    pub fn request(&mut self, request: Request) {
        self.serial += 1;
        self.poll();
        if self.drawing.is_some() {
            if self.queued.replace(request).is_some() {
                self.stats.replaced += 1;
            }
        } else {
            self.start(request, self.serial);
        }
    }

    /// The number of the last frame asked for: a frame shown carries the number of its request.
    pub fn serial(&self) -> u64 {
        self.serial
    }

    fn start(&mut self, request: Request, serial: u64) {
        let [width, height] = request.size.map(|n| n.max(1));
        let len = width as usize * height as usize * 4;
        let mut buffer = self.spare.take().unwrap_or_default();
        if buffer.len() != len {
            // Every byte is written by a band before the frame is read.
            buffer = vec![0; len];
        }
        let bands = height.div_ceil(BAND_ROWS);
        let shot = Arc::new(Shot { serial, width, height, pixels: UnsafeCell::new(buffer), left: AtomicUsize::new(bands as usize + 1), cancelled: AtomicBool::new(false),
            failed: AtomicBool::new(false), asked_ms: self.engine.now(), done_ms: AtomicU64::new(0), work_us: AtomicU64::new(0) });
        let changes = std::mem::take(&mut self.changes);
        self.change_bytes = 0;
        let (painter, job, sizes) = (self.painter.clone(), shot.clone(), self.picture_bytes.clone());
        self.engine.spawn(move |engine| frame_job(engine, &painter, changes, Arc::new(request), job, &sizes));
        self.drawing = Some(shot);
    }

    /// A frame whose job and bands have all ended becomes the one to show (an older one not shown is dropped), and the
    /// frame asked for meanwhile starts. True while a frame is being drawn.
    pub fn poll(&mut self) -> bool {
        if self.drawing.as_ref().is_some_and(|shot| shot.ended()) {
            let shot = self.drawing.take().expect("checked");
            if shot.failed.load(Ordering::Relaxed) {
                self.failed = true;
                self.recycle(shot);
            } else if shot.cancelled.load(Ordering::Relaxed) {
                self.recycle(shot);
            } else {
                self.stats.frame_ms = f64::from_bits(shot.done_ms.load(Ordering::Relaxed)) - shot.asked_ms;
                self.stats.work_ms = shot.work_us.load(Ordering::Relaxed) as f64 / 1000.0;
                self.stats.bands = shot.height.div_ceil(BAND_ROWS);
                if let Some(old) = self.ready.replace(shot) {
                    self.recycle(old);
                }
            }
            if let Some(request) = self.queued.take() {
                self.start(request, self.serial);
            }
        }
        self.drawing.is_some()
    }

    /// The newest frame drawn and not shown yet.
    pub fn ready(&self) -> Option<&Arc<Shot>> {
        self.ready.as_ref()
    }

    /// The frame `serial` is on show (the interface copied it): its buffer serves the next frame.
    pub fn shown(&mut self, serial: u64) {
        if self.ready.as_ref().is_some_and(|shot| shot.serial == serial) {
            let shot = self.ready.take().expect("checked");
            self.stats.shown += 1;
            self.recycle(shot);
        }
    }

    /// Whether a frame could not be drawn because a picture it samples could not be held: the stage draws with its
    /// graphics device instead.
    pub fn failed(&self) -> bool {
        self.failed
    }

    fn recycle(&mut self, shot: Arc<Shot>) {
        if let Ok(shot) = Arc::try_unwrap(shot) {
            self.spare = Some(shot.pixels.into_inner());
        }
    }

    /// A decoded picture the stage took from the engine, laid out by `assets`: frames sample it from the next one on.
    pub fn add_image(&mut self, assets: &Arc<Assets>, image: Arc<DecodedImage>) {
        self.change_bytes += image.rgba.len();
        self.changes.push(Change::Image(assets.clone(), image));
        self.hand_over();
    }

    /// Slots of the live drawing cels (`styk_eval::live::LiveCels::take_runs`, the cels' first page at atlas layer `base`):
    /// each cell becomes a drawing tile of its place.
    pub fn add_live(&mut self, base: u32, runs: &[styk_eval::live::Run]) {
        use styk_eval::live::CELL;
        let border = styk_eval::drawing::BORDER;
        for run in runs {
            let width = (run.cells * CELL) as usize * 4;
            for cell in 0..run.cells {
                let mut rgba = Vec::with_capacity((CELL * CELL * 4) as usize);
                for row in 0..CELL as usize {
                    let at = row * width + (cell * CELL) as usize * 4;
                    rgba.extend_from_slice(&run.rgba[at..at + CELL as usize * 4]);
                }
                let image = DecodedImage { index: 0, drawing: true, soft: false, width: CELL, height: CELL, rgba, placement: 0 };
                self.change_bytes += image.rgba.len();
                self.changes.push(Change::Tile((base + run.page, run.x + border + cell * CELL, run.y + border), Arc::new(image)));
            }
        }
        self.hand_over();
    }

    /// The live cels' pages moved to another atlas layer: their tiles are let go of (the stage writes them again).
    pub fn drop_live_from(&mut self, layer: u32) {
        self.changes.push(Change::DropTilesFrom(layer));
    }

    /// Pictures pile up while no frame is asked for (the stage taking in a document's pictures while idle): a job takes them.
    fn hand_over(&mut self) {
        if self.change_bytes < PENDING_BYTES {
            return;
        }
        let changes = std::mem::take(&mut self.changes);
        self.change_bytes = 0;
        let (painter, sizes) = (self.painter.clone(), self.picture_bytes.clone());
        self.engine.spawn(move |_| {
            let mut painter = painter.lock().unwrap_or_else(|e| e.into_inner());
            apply(&mut painter, changes, None);
            sizes.store(painter.images.bytes(), Ordering::Relaxed);
        });
    }

    pub fn stats(&self) -> Stats {
        let frames = [&self.drawing, &self.ready].iter().filter_map(|shot| shot.as_ref()).map(|shot| shot.width as usize * shot.height as usize * 4).sum::<usize>();
        Stats { buffer_bytes: frames + self.spare.as_ref().map_or(0, Vec::len), picture_bytes: self.picture_bytes.load(Ordering::Relaxed), ..self.stats }
    }

    /// Lets go of every frame and picture: bands still running end early and free theirs, the pictures go on a worker.
    pub fn clear(&mut self) {
        if let Some(shot) = self.drawing.take() {
            shot.cancelled.store(true, Ordering::Relaxed);
        }
        self.queued = None;
        self.ready = None;
        self.spare = None;
        self.changes.clear();
        self.change_bytes = 0;
        let painter = std::mem::replace(&mut self.painter, Arc::new(Mutex::new(Painter { raster: Raster::new(Edges::Smooth), images: Arc::new(Images::default()), lineage: 0 })));
        self.engine.spawn(move |_| drop(painter));
    }
}

impl Drop for StageRaster {
    fn drop(&mut self) {
        self.clear();
    }
}

/// Applies `changes` to the pictures the frames sample, for the document `lineage` when one is given (the pictures of
/// another are let go of).
fn apply(painter: &mut Painter, changes: Vec<Change>, lineage: Option<u64>) {
    if let Some(lineage) = lineage
        && lineage != painter.lineage
    {
        painter.images = Arc::new(Images::default());
        painter.raster.release();
        painter.lineage = lineage;
    }
    if changes.is_empty() {
        return;
    }
    // The bands of the frame before may still read the set they were given: this one is taken further as a copy of the tables.
    let images = Arc::make_mut(&mut painter.images);
    for change in changes {
        match change {
            Change::Image(assets, image) => images.add_shared(&assets, image),
            Change::Tile(place, image) => images.put_tile(place, image),
            Change::DropTilesFrom(layer) => images.drop_tiles_from(layer),
        }
    }
}

/// The frame's job: the pictures and glyph masks it needs, then a task for each band.
fn frame_job(engine: &Engine, painter: &Mutex<Painter>, changes: Vec<Change>, request: Arc<Request>, shot: Arc<Shot>, sizes: &AtomicUsize) {
    let started = engine.now();
    let cancelled = || shot.cancelled.load(Ordering::Relaxed);
    let prepared = {
        let mut painter = painter.lock().unwrap_or_else(|e| e.into_inner());
        apply(&mut painter, changes, Some(request.generation.lineage));
        let held = if cancelled() { Ok(()) } else { Arc::make_mut(&mut painter.images).ensure_cancellable(&request.list, &request.generation.prepared.doc, &request.generation.assets, &cancelled) };
        sizes.store(painter.images.bytes(), Ordering::Relaxed);
        match held {
            Err(_) => {
                shot.failed.store(true, Ordering::Relaxed);
                None
            }
            Ok(()) => {
                painter.raster.set_drawing_grid(request.grid);
                painter.raster.set_orientation(request.orientation);
                painter.raster.bands(&request.list, &request.view, &cancelled).map(|bands| (bands, painter.images.clone()))
            }
        }
    };
    let bands = shot.height.div_ceil(BAND_ROWS);
    match prepared {
        Some((prepared, images)) => {
            let (prepared, images) = (Arc::new(prepared), images);
            for band in 0..bands {
                let (shot, request, prepared, images) = (shot.clone(), request.clone(), prepared.clone(), images.clone());
                engine.spawn(move |engine| draw_band(engine, &shot, &request, &prepared, &images, band * BAND_ROWS));
            }
        }
        // Nothing to draw: the bands end at once.
        None => {
            shot.cancelled.fetch_or(shot.failed.load(Ordering::Relaxed), Ordering::Relaxed);
            shot.left.fetch_sub(bands as usize, Ordering::AcqRel);
        }
    }
    shot.work_us.fetch_add(((engine.now() - started) * 1000.0).max(0.0) as u64, Ordering::Relaxed);
    shot.end(engine);
}

/// Draws the band whose first row is `y0` into `shot`.
fn draw_band(engine: &Engine, shot: &Shot, request: &Request, bands: &styk_raster::Bands, images: &Images, y0: u32) {
    let started = engine.now();
    let rows = BAND_ROWS.min(shot.height - y0);
    let cancelled = || shot.cancelled.load(Ordering::Relaxed);
    if let Some((frame, _)) = bands.render(&request.list, images, &request.view, [shot.width, shot.height], y0, rows, &cancelled) {
        straighten(&frame.pixels, unsafe { shot.rows(y0, rows) });
    }
    shot.work_us.fetch_add(((engine.now() - started) * 1000.0).max(0.0) as u64, Ordering::Relaxed);
    shot.end(engine);
}

/// Premultiplied RGBA8 to straight, rounded as exports round (`styk_raster::Frame::straight`): what a canvas takes.
pub fn straighten(premultiplied: &[u8], out: &mut [u8]) {
    for (p, o) in premultiplied.as_chunks::<4>().0.iter().zip(out.as_chunks_mut::<4>().0) {
        let a = p[3] as u32;
        *o = match a {
            0 => [0; 4],
            255 => *p,
            _ => {
                let c = |v: u8| ((2 * 255 * v as u32 + a) / (2 * a)).min(255) as u8;
                [c(p[0]), c(p[1]), c(p[2]), p[3]]
            }
        };
    }
}
