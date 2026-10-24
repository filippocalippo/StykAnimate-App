//! Library previews: a figure, set or movieclip file of the asset library, as
//! `src/library-preview-worker.mjs` shows it.
//!
//! The file is opened here, apart from the engine's open document. Its artwork is
//! fitted, with a tenth of margin, into a square on transparency ([`fitted`]): no
//! background, no scene camera, every layer shown. The preview's clock
//! (`libraryPreviewTimeline`) runs at the file's rate, at least one tick a second, and
//! lasts as long as its timeline or its longest movieclip, whichever is longer; ticks
//! wrap around.
//!
//! * [`LibraryPreview::poster`]: tick 0, or the first of fifteen more evenly spaced
//!   ticks that has artwork, fitted to its own bounds (the PNG a saved asset keeps).
//! * [`LibraryPreview::begin`] then [`LibraryPreview::frame`]: the hover animation,
//!   fitted to the union of up to sixteen sampled frames' bounds, grown by every frame
//!   drawn since, so the artwork does not jump. `begin` returns each sample with its own
//!   bounds, which the interface draws at 40 pixels a side to choose the card's backdrop
//!   from their colours (`libraryPreviewMatte`).

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use styk_draw::DrawList;
use styk_eval::assets::{Assets, DecodedImage};
use styk_eval::drawlist::{artwork_bounds, encode_with, Overrides};
use styk_eval::eval::Prepared;
use styk_eval::geometry::build;

use super::Framing;
use crate::anchors::Anchors;
use crate::Clock;

/// The poster's and the animation's side (`OffscreenCanvas(320, 320)`).
pub const SIZE: u32 = 320;
/// The side of the samples the backdrop is chosen from.
pub const SAMPLE: u32 = 40;
/// Samples taken to fit the animation (and to find a poster frame with artwork).
pub const SAMPLES: u32 = 16;
/// How long fitting the animation may take before it stops sampling (ms).
const SAMPLING_MS: f64 = 250.0;

/// Each library file opened gets an atlas lineage of its own, counted down from the top
/// so it never meets a document's (whose lineages count up).
static NEXT_LINEAGE: AtomicU64 = AtomicU64::new(u64::MAX);

/// One frame of the file: its draw list and the rectangle its artwork covers (world
/// units: x, y, width, height), `None` when nothing is drawn.
pub struct Sample {
    pub list: Arc<DrawList>,
    pub bounds: Option<[f64; 4]>,
    /// The frame has artwork (`geometry.drawables.length`).
    pub drawn: bool,
}

/// One library file, opened for its previews. Owned by one thread.
pub struct LibraryPreview {
    prepared: Arc<Prepared>,
    assets: Arc<Assets>,
    anchors: Option<Arc<Anchors>>,
    /// The atlas lineage of this file's pictures.
    pub lineage: u64,
    /// Ticks a second, and ticks before the preview wraps around (may be fractional).
    pub fps: f64,
    pub duration: f64,
    /// The union of the bounds of the animation's frames so far.
    bounds: Option<[f64; 4]>,
}

fn union(a: Option<[f64; 4]>, b: Option<[f64; 4]>) -> Option<[f64; 4]> {
    match (a, b) {
        (Some(a), Some(b)) => {
            let (x0, y0) = (a[0].min(b[0]), a[1].min(b[1]));
            Some([x0, y0, (a[0] + a[2]).max(b[0] + b[2]) - x0, (a[1] + a[3]).max(b[1] + b[3]) - y0])
        }
        (a, None) => a,
        (None, b) => b,
    }
}

/// `bounds` (x, y, width, height) fitted, with a tenth of margin, into a square of `size`:
/// the editor's `paint` (`scale(size × 0.9 / max(1, width, height))` about the centres).
pub fn fitted(bounds: [f64; 4], size: u32) -> Framing {
    let s = size as f64;
    let scale = s * 0.9 / bounds[2].max(bounds[3]).max(1.0);
    let (cx, cy) = (bounds[0] + bounds[2] / 2.0, bounds[1] + bounds[3] / 2.0);
    let pan = [s / 2.0 - scale * cx, s / 2.0 - scale * cy];
    Framing { matrix: [scale, 0.0, 0.0, scale, pan[0], pan[1]], artboard: [0.0, 0.0, s, s], zoom: scale, pan }
}

/// `bounds` (x, y, width, height) fitted into a `width × height` picture with `margin` pixels
/// around it (at least one world unit is fitted), centred: the framing of a figure's thumbnail.
pub fn fit(bounds: [f64; 4], width: u32, height: u32, margin: f64) -> Framing {
    let (w, h) = (width as f64, height as f64);
    let scale = ((w - 2.0 * margin) / bounds[2].max(1.0)).min((h - 2.0 * margin) / bounds[3].max(1.0)).max(1e-6);
    let (cx, cy) = (bounds[0] + bounds[2] / 2.0, bounds[1] + bounds[3] / 2.0);
    let pan = [w / 2.0 - scale * cx, h / 2.0 - scale * cy];
    Framing { matrix: [scale, 0.0, 0.0, scale, pan[0], pan[1]], artboard: [0.0, 0.0, w, h], zoom: scale, pan }
}

/// The rectangle a frame's artwork covers when it covers nothing (`{0, 0, 1, 1}`).
pub const NOWHERE: [f64; 4] = [0.0, 0.0, 1.0, 1.0];

impl LibraryPreview {
    /// Opens a library file (`stkz`, `stykmov`, or any document the engine reads).
    pub fn open(bytes: &[u8], extension: &str) -> Result<LibraryPreview, String> {
        let document = styk_eval::open_bytes(bytes, extension, "library").map_err(|e| e.to_string())?;
        let prepared = Arc::new(Prepared::new(Arc::new(document)));
        let doc = &prepared.doc;
        let assets = Arc::new(Assets::build(doc));
        let fps = if doc.fps.is_finite() && doc.fps > 0.0 { doc.fps.max(1.0) } else { 24.0 };
        let mut duration = prepared.total_ticks.max(1) as f64;
        for object in doc.keyframes.first().map_or(&[][..], |frame| &frame.objects[..]) {
            if let Some(clip) = doc.figure(object.figure).and_then(|figure| figure.movieclip.as_ref()) {
                duration = duration.max(clip.duration * fps / clip.document.fps);
            }
        }
        let anchors = styk_eval::vfx::generated::has_generators(doc).then(|| Arc::new(Anchors::new()));
        let lineage = NEXT_LINEAGE.fetch_sub(1, Ordering::Relaxed);
        Ok(LibraryPreview { prepared, assets, anchors, lineage, fps, duration, bounds: None })
    }

    /// The file's document.
    pub fn doc(&self) -> &styk_eval::doc::Document {
        &self.prepared.doc
    }

    /// Where the file's pictures are laid out.
    pub fn assets(&self) -> &Arc<Assets> {
        &self.assets
    }

    /// Every picture of the file, decoded now (library files hold few, if any).
    pub fn images(&self) -> Vec<DecodedImage> {
        decode_all(&self.prepared.doc, &self.assets)
    }

    /// The preview's tick at `elapsed` seconds of the animation.
    pub fn tick_at(&self, elapsed: f64) -> f64 {
        (elapsed * self.fps).floor() % self.duration
    }

    /// The file at `tick` (wrapped into the preview's duration), with the clock that
    /// bounds nothing: every earlier anchor of generated effects is evaluated.
    pub fn sample(&self, tick: f64, clock: Clock) -> Sample {
        self.sample_on(tick, clock, Some(0))
    }

    /// [`LibraryPreview::sample`] on `background` (ARGB) instead of transparency, or on the
    /// document's own backgrounds with `None`.
    pub fn sample_on(&self, tick: f64, clock: Clock, background: Option<u32>) -> Sample {
        let tick = ((tick % self.duration) + self.duration) % self.duration;
        let prepared = &self.prepared;
        let doc = &prepared.doc;
        let frame = prepared.evaluate(tick);
        let scene = build(doc, &frame);
        let batch = self.anchors.as_ref().and_then(|anchors| {
            let sampler = anchors.sampler(clock, f64::INFINITY);
            styk_eval::vfx::generated::build(prepared, &frame, &scene, Some(tick), Some(&sampler), 1.0)
        });
        // Every layer shown; by default no background: the artwork alone, on transparency.
        let overrides = Overrides { background, generators: batch.as_ref(), ..Default::default() };
        let list = Arc::new(encode_with(doc, &self.assets, &scene, &overrides));
        // `objectBounds` of the artwork (with its effects' reach), joined with what the
        // generated effects cover.
        let artwork = artwork_bounds(&self.assets, &scene);
        let drawn = artwork.is_some();
        let effects = batch.as_ref().and_then(|batch| batch.bounds());
        Sample { list, bounds: union(artwork, effects), drawn }
    }

    /// The poster: tick 0, or the first of the evenly spaced samples that has artwork,
    /// and the bounds it is fitted to (its own).
    pub fn poster(&self, clock: Clock) -> (Sample, [f64; 4]) {
        let mut sample = self.sample(0.0, clock);
        // A clip may begin on an intentionally empty frame; find a useful poster.
        let mut i = 1;
        while !sample.drawn && i < SAMPLES {
            sample = self.sample(i as f64 * (self.duration - 1.0) / (SAMPLES - 1) as f64, clock);
            i += 1;
        }
        let bounds = sample.bounds.unwrap_or(NOWHERE);
        (sample, bounds)
    }

    /// Fits the animation: up to sixteen evenly spaced samples (fewer if evaluating them
    /// takes longer than 250 ms), the union of their bounds kept for
    /// [`LibraryPreview::frame`]. Returns the samples that have artwork, each with its own bounds.
    pub fn begin(&mut self, clock: Clock) -> Vec<(Sample, [f64; 4])> {
        let started = clock();
        self.bounds = None;
        let mut samples = Vec::new();
        for i in 0..SAMPLES {
            let sample = self.sample(i as f64 * (self.duration - 1.0) / (SAMPLES - 1) as f64, clock);
            if let Some(bounds) = sample.bounds {
                self.bounds = union(self.bounds, Some(bounds));
                samples.push((sample, bounds));
            }
            if clock() - started > SAMPLING_MS {
                break;
            }
        }
        samples
    }

    /// The animation's frame at `elapsed` seconds, the bounds of every frame so far (this
    /// one's included) it is fitted to, and its tick.
    pub fn frame(&mut self, elapsed: f64, clock: Clock) -> (Sample, [f64; 4], f64) {
        let tick = self.tick_at(elapsed);
        let sample = self.sample(tick, clock);
        self.bounds = union(self.bounds, sample.bounds);
        (sample, self.bounds.unwrap_or(NOWHERE), tick)
    }
}

/// Every picture of `doc` decoded for its atlas (sprites and drawing cels at every level).
fn decode_all(doc: &styk_eval::doc::Document, assets: &Assets) -> Vec<DecodedImage> {
    let mut images: Vec<DecodedImage> = (0..doc.images.len()).filter_map(|index| styk_eval::assets::decode_image(doc, assets, index)).collect();
    for (cel, _) in assets.cels.values() {
        images.extend(styk_eval::assets::decode_cel(assets, cel));
    }
    images
}
