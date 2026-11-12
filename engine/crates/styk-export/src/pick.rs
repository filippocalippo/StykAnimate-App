//! Click-only artwork picking: which figure's artwork is under a point of the frame on the stage.
//!
//! The figures are drawn from the top down into a three-pixel surface centred on the point, one figure at a
//! time and without the background, by the CPU rasterizer (`styk-raster`) from the draw list the stage draws
//! from, so a click hits what is painted: fills, curves, pictures, meshes, movieclip contents and
//! transparency. A figure whose measured bounds do not reach the point is not drawn at all.
//!
//! The stage asks on every pointer move over the stage ([`shown`]): the scene of the frame on show, its figures' bounds and where
//! each figure's items lie are worked out once per frame and kept, and each candidate is encoded from its own items alone
//! ([`styk_eval::drawlist::encode_composed_span`]), so a pick on a frame of thousands of figures costs the figures under the point.
//! [`artwork`] works all of it out on every call: it is what [`shown`] answers.

use std::collections::HashSet;
use std::sync::Arc;

use styk_eval::assets::Assets;
use styk_eval::doc::Document;
use styk_eval::drawlist::{Overrides, app_bounds, encode_composed, encode_composed_span};
use styk_eval::eval::Frame;
use styk_eval::geometry::{ItemKind, Scene, build_shapes_cancellable};
use styk_raster::{Edges, Images, Raster, ViewParams};

/// The three-pixel surface a candidate is drawn on, the pictures that stay decoded between clicks, and what was worked out of the
/// frame picked last ([`shown`]).
pub struct Picker {
    raster: Raster,
    images: Images,
    held: Option<PickFrame>,
}

impl Default for Picker {
    fn default() -> Picker {
        Picker { raster: Raster::new(Edges::Smooth), images: Images::default(), held: None }
    }
}

impl Picker {
    /// Lets go of what was worked out of the frame picked last (its scene with it), answering it for the caller to drop where it wants.
    pub fn release(&mut self) -> Option<PickFrame> {
        self.held.take()
    }

    /// Takes what was worked out of a frame elsewhere ([`prepare`], on a worker while the frame is on show): the next pick of that frame
    /// starts from it. Answers what it replaces (to be let go of where the caller wants).
    pub fn take(&mut self, prepared: PickFrame) -> Option<PickFrame> {
        self.held.replace(prepared)
    }

    /// Whether what the picker holds was worked out of `frame` of `document`.
    pub fn holds(&self, document: u64, frame: &Arc<Frame>) -> bool {
        self.held.as_ref().is_some_and(|held| held.document == document && Arc::ptr_eq(&held.frame, frame))
    }
}

/// What a pick works out of a frame before it draws a candidate ([`prepare`]), kept for the frame on show ([`shown`]).
pub struct PickFrame {
    /// The caller's number for the document and its pictures, and the frame (held, so its address is never another frame's).
    document: u64,
    frame: Arc<Frame>,
    scene: Arc<Scene>,
    /// By slot: the figure's measured bounds ([`app_bounds`]), and the range of [`Scene::items`] from its first item to its last
    /// (`None` for a figure that draws nothing).
    bounds: Vec<Option<[f64; 4]>>,
    spans: Vec<Option<(usize, usize)>>,
    /// Whether the scene draws text ([`styk_eval::drawlist::has_text`]).
    text: bool,
}

/// Works out what a pick of `frame` (built as `scene`, what [`styk_eval::geometry::build_shapes`] builds) of `doc` needs before it draws a
/// candidate: the figures' measured bounds and where each figure's items lie. On any thread; `document` is the caller's number for `doc`
/// and its pictures ([`shown`]).
pub fn prepare(doc: &Document, document: u64, frame: &Arc<Frame>, scene: &Arc<Scene>) -> PickFrame {
    let bounds = app_bounds(scene, doc);
    let mut spans: Vec<Option<(usize, usize)>> = vec![None; frame.objects.len()];
    let mut text = false;
    for (at, item) in scene.items.iter().enumerate() {
        text |= item.kind == ItemKind::Text;
        if let Some(span) = spans.get_mut(item.slot as usize) {
            *span = Some(span.map_or((at, at + 1), |(first, _)| (first, at + 1)));
        }
    }
    PickFrame { document, frame: frame.clone(), scene: scene.clone(), bounds, spans, text }
}

/// What a click hit: the figure's slot in the frame and its identity.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Hit {
    pub slot: usize,
    pub uid: u32,
}

/// The figure whose artwork covers `point` (scene units) in `frame`, topmost first, skipping the figures
/// in `hidden` and `locked` (by identity). `scale` is the view's pixels per scene unit: the surface samples
/// the point at that magnification, so a thin line is hit as it is seen.
pub fn artwork(picker: &mut Picker, doc: &Document, assets: &Assets, frame: &Frame, point: [f64; 2], scale: f64, hidden: &HashSet<u32>, locked: &HashSet<u32>) -> Result<Option<Hit>, String> {
    artwork_cancellable(picker, doc, assets, frame, point, scale, hidden, locked, &|| false)
}

/// A cancelled query returns no hit and never publishes a partly decoded picture.
#[allow(clippy::too_many_arguments)]
pub fn artwork_cancellable(picker: &mut Picker, doc: &Document, assets: &Assets, frame: &Frame, point: [f64; 2], scale: f64, hidden: &HashSet<u32>, locked: &HashSet<u32>, cancelled: &(dyn Fn() -> bool + Sync)) -> Result<Option<Hit>, String> {
    if !point[0].is_finite() || !point[1].is_finite() {
        return Ok(None);
    }
    let Some(scene) = build_shapes_cancellable(doc, frame, None, cancelled) else { return Ok(None); };
    let bounds = app_bounds(&scene, doc);
    let drawn: HashSet<usize> = scene.items.iter().map(|item| item.slot as usize).collect();
    let drawn: Vec<bool> = (0..frame.objects.len()).map(|slot| drawn.contains(&slot)).collect();
    candidates(picker, doc, assets, frame, &scene, &bounds, &drawn, None, point, scale, hidden, locked, cancelled)
}

/// [`artwork`] of the frame on show, for a caller that asks again and again (every pointer move). `scene`, when given, is what
/// [`styk_eval::geometry::build_shapes`] builds of `frame` against `doc` (the session's scene of the frame on show is that).
/// `document` is the caller's number for `doc` and `assets` together (the engine's generation): while it and `frame` (and `scene`)
/// are the last call's, nothing of the frame is worked out again.
#[allow(clippy::too_many_arguments)]
pub fn shown(picker: &mut Picker, doc: &Document, assets: &Assets, document: u64, frame: &Arc<Frame>, scene: Option<&Arc<Scene>>, point: [f64; 2], scale: f64, hidden: &HashSet<u32>, locked: &HashSet<u32>) -> Result<Option<Hit>, String> {
    if !point[0].is_finite() || !point[1].is_finite() {
        return Ok(None);
    }
    let kept = picker.held.as_ref().is_some_and(|held| held.document == document && Arc::ptr_eq(&held.frame, frame) && scene.is_none_or(|scene| Arc::ptr_eq(scene, &held.scene)));
    if !kept {
        // The last frame's scene goes before this one's is built.
        picker.held = None;
        let scene = match scene {
            Some(scene) => scene.clone(),
            None => Arc::new(build_shapes_cancellable(doc, frame, None, &|| false).expect("an uncancelled build")),
        };
        picker.held = Some(prepare(doc, document, frame, &scene));
    }
    let held = picker.held.take().expect("held above");
    let drawn: Vec<bool> = held.spans.iter().map(Option::is_some).collect();
    let hit = candidates(picker, doc, assets, frame, &held.scene, &held.bounds, &drawn, Some((&held.spans[..], held.text)), point, scale, hidden, locked, &|| false);
    picker.held = Some(held);
    hit
}

/// Draws the figures that can be picked at `point`, topmost first, until one paints it. With `spans`, each is encoded from its own
/// items; without, from the whole scene with the others hidden.
#[allow(clippy::too_many_arguments)]
fn candidates(picker: &mut Picker, doc: &Document, assets: &Assets, frame: &Frame, scene: &Scene, bounds: &[Option<[f64; 4]>], drawn: &[bool], spans: Option<(&[Option<(usize, usize)>], bool)>, point: [f64; 2], scale: f64, hidden: &HashSet<u32>, locked: &HashSet<u32>, cancelled: &(dyn Fn() -> bool + Sync)) -> Result<Option<Hit>, String> {
    let scale = scale.abs().max(0.01);
    // A pixel and a little more around the point: what a stroke's edge or a pixel of antialiasing reaches.
    let reach = 2.0 / scale;
    let view = ViewParams {
        matrix: [scale, 0.0, 0.0, scale, 1.5 - point[0] * scale, 1.5 - point[1] * scale],
        artboard: [0.0, 0.0, 3.0, 3.0],
        clip_to_artboard: false,
        clear: [0.0; 4],
        zoom: scale,
        pan: [1.5 - point[0] * scale, 1.5 - point[1] * scale],
        stretch: 1.0,
        camera_view: false,
        camera_limit: styk_render::CAMERA_PREVIEW_LIMIT,
    };
    let mut flags = vec![true; frame.objects.len()];
    for &slot in frame.draw_order.iter().rev() {
        if cancelled() { return Ok(None); }
        let slot = slot as usize;
        let Some(object) = frame.objects.get(slot) else { continue };
        if hidden.contains(&object.uid) || locked.contains(&object.uid) || !drawn.get(slot).copied().unwrap_or(false) {
            continue;
        }
        // A movieclip's instance measures only its handle, which paints nothing: its contents are always candidates.
        let clip = scene.figure_for(slot).is_some_and(|figure| figure.movieclip.is_some());
        if !clip {
            let Some([min_x, min_y, max_x, max_y]) = bounds.get(slot).copied().flatten() else { continue };
            if point[0] < min_x - reach || point[0] > max_x + reach || point[1] < min_y - reach || point[1] > max_y + reach {
                continue;
            }
        }
        flags[slot] = false;
        let overrides = Overrides { hidden: &flags, translations: &[], background: Some(0), bypass_effects: true, generators: None, live: None };
        let list = match spans.and_then(|(spans, text)| Some((spans.get(slot).copied().flatten()?, text))) {
            Some((span, text)) => encode_composed_span(doc, assets, scene, &overrides, span, text),
            None => encode_composed(doc, assets, scene, &overrides, &[], None),
        };
        flags[slot] = true;
        picker.images.ensure_cancellable(&list, doc, assets, cancelled).map_err(|error| error.to_string())?;
        let Some(picture) = picker.raster.render_cancellable(&list, &picker.images, &view, [3, 3], cancelled) else { return Ok(None); };
        if picture.pixels[(3 + 1) * 4 + 3] != 0 {
            return Ok(Some(Hit { slot, uid: object.uid }));
        }
    }
    Ok(None)
}
