//! The stage drawn by the processor renderer (styk-raster) on the engine's workers, for a device that is itself a
//! software rasterizer: the frame is cut into bands of rows, each band a task any worker takes, and the page shows the
//! newest finished frame on a canvas of its own (`engine-stage.mjs`). The interface thread only asks and, later, copies.

use std::cell::UnsafeCell;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use styk_engine::Engine;
use styk_eval::drawlist::DrawList;
use styk_raster::{DrawingGrid, Edges, Images, Raster, ViewParams};

/// Rows of the frame one task draws.
const BAND_ROWS: u32 = 64;

/// One frame being drawn or drawn: straight RGBA rows, written band by band by the workers (each band its own rows).
pub(crate) struct Shot {
    pub serial: u64,
    pub width: u32,
    pub height: u32,
    pixels: UnsafeCell<Vec<u8>>,
    /// Bands not ended yet (drawn or given up).
    left: AtomicUsize,
    cancelled: AtomicBool,
}

// Bands write disjoint rows of `pixels`; the stage reads them only once every band has ended (`left` is 0).
unsafe impl Sync for Shot {}

impl Shot {
    fn ended(&self) -> bool {
        self.left.load(Ordering::Acquire) == 0
    }

    /// Rows `y0..y0 + rows` of the frame, for the band that draws them.
    #[allow(clippy::mut_from_ref)]
    unsafe fn rows(&self, y0: u32, rows: u32) -> &mut [u8] {
        let stride = self.width as usize * 4;
        let all = unsafe { &mut *self.pixels.get() };
        &mut all[y0 as usize * stride..(y0 + rows) as usize * stride]
    }

    fn pixels(&self) -> &[u8] {
        debug_assert!(self.ended());
        unsafe { &*self.pixels.get() }
    }
}

/// What a frame is drawn from.
pub(crate) struct Request {
    /// Numbers the requests ([`Processor::serial`]).
    pub serial: u64,
    pub list: Arc<DrawList>,
    pub images: Arc<Images>,
    pub view: ViewParams,
    pub size: [u32; 2],
    pub grid: DrawingGrid,
}

/// The frames of one stage: at most one being drawn, one asked for after it, and one drawn and not yet shown.
#[derive(Default)]
pub(crate) struct Processor {
    serial: u64,
    drawing: Option<Arc<Shot>>,
    queued: Option<Request>,
    ready: Option<Arc<Shot>>,
    /// A buffer of a frame that was shown or dropped, for the next one.
    spare: Option<Vec<u8>>,
}

impl Processor {
    /// Asks for a frame: drawn now when no other is being drawn, else after it (replacing any other waiting).
    pub fn request(&mut self, engine: &Engine, mut request: Request) {
        self.serial += 1;
        request.serial = self.serial;
        self.poll(engine);
        if self.drawing.is_some() {
            self.queued = Some(request);
        } else {
            self.start(engine, request);
        }
    }

    fn start(&mut self, engine: &Engine, request: Request) {
        let [width, height] = [request.size[0].max(1), request.size[1].max(1)];
        let len = width as usize * height as usize * 4;
        let mut buffer = self.spare.take().unwrap_or_default();
        if buffer.len() != len {
            buffer.clear();
            buffer.resize(len, 0);
        }
        let bands = height.div_ceil(BAND_ROWS);
        let shot = Arc::new(Shot { serial: request.serial, width, height, pixels: UnsafeCell::new(buffer), left: AtomicUsize::new(bands as usize), cancelled: AtomicBool::new(false) });
        let request = Arc::new(request);
        for band in 0..bands {
            let (shot, request) = (shot.clone(), request.clone());
            engine.spawn(move |_| draw_band(&shot, &request, band * BAND_ROWS));
        }
        self.drawing = Some(shot);
    }

    /// A frame whose bands have all ended becomes the one to show (an older one not shown is dropped), and the frame
    /// asked for meanwhile starts. True while a frame is being drawn.
    pub fn poll(&mut self, engine: &Engine) -> bool {
        if self.drawing.as_ref().is_some_and(|shot| shot.ended()) {
            let shot = self.drawing.take().expect("checked");
            if !shot.cancelled.load(Ordering::Relaxed) {
                if let Some(old) = self.ready.replace(shot) {
                    self.recycle(old);
                }
            } else {
                self.recycle(shot);
            }
            if let Some(request) = self.queued.take() {
                self.start(engine, request);
            }
        }
        self.drawing.is_some()
    }

    /// The number of the last frame asked for.
    pub fn serial(&self) -> u64 {
        self.serial
    }

    /// The newest drawn frame not shown yet.
    pub fn ready(&self) -> Option<&Arc<Shot>> {
        self.ready.as_ref()
    }

    pub fn pixels(shot: &Shot) -> &[u8] {
        shot.pixels()
    }

    /// The page copied frame `serial`: its buffer serves the next frame.
    pub fn shown(&mut self, serial: u64) {
        if self.ready.as_ref().is_some_and(|shot| shot.serial == serial) {
            let shot = self.ready.take().expect("checked");
            self.recycle(shot);
        }
    }

    fn recycle(&mut self, shot: Arc<Shot>) {
        if let Ok(shot) = Arc::try_unwrap(shot) {
            self.spare = Some(shot.pixels.into_inner());
        }
    }

    /// Lets go of every frame; bands still running end early and free theirs.
    pub fn clear(&mut self) {
        if let Some(shot) = self.drawing.take() {
            shot.cancelled.store(true, Ordering::Relaxed);
        }
        self.queued = None;
        self.ready = None;
        self.spare = None;
    }
}

impl Drop for Processor {
    fn drop(&mut self) {
        self.clear();
    }
}

/// Draws the band of `request` whose first row is `y0` into `shot`: the frame's view moved up by `y0` rows, at the
/// band's height (each band draws the pixels the whole frame would have, as an export's tiles do).
fn draw_band(shot: &Shot, request: &Request, y0: u32) {
    let rows = BAND_ROWS.min(shot.height - y0);
    if !shot.cancelled.load(Ordering::Relaxed) {
        let mut raster = Raster::new(Edges::Smooth);
        raster.set_drawing_grid(request.grid);
        let v = request.view;
        let dy = y0 as f64;
        let view = ViewParams {
            matrix: styk_eval::view::compose([1.0, 0.0, 0.0, 1.0, 0.0, -dy], v.matrix),
            artboard: [v.artboard[0], v.artboard[1] - dy, v.artboard[2], v.artboard[3] - dy],
            pan: [v.pan[0], v.pan[1] - dy],
            ..v
        };
        let cancelled = || shot.cancelled.load(Ordering::Relaxed);
        if let Some(frame) = raster.render_cancellable(&request.list, &request.images, &view, [shot.width, rows], &cancelled) {
            let out = unsafe { shot.rows(y0, rows) };
            straighten(&frame.pixels, out);
        }
    }
    shot.left.fetch_sub(1, Ordering::AcqRel);
}

/// Premultiplied RGBA8 to straight, rounded as exports round (`styk_raster::Frame::straight`).
fn straighten(premultiplied: &[u8], out: &mut [u8]) {
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
