//! Click-only artwork picking: which figure's artwork is under a point of the frame on the stage.
//!
//! The figures are drawn from the top down into a three-pixel surface centred on the point, one figure at a
//! time and without the background, by the CPU rasterizer (`styk-raster`) from the draw list the stage draws
//! from, so a click hits what is painted: fills, curves, pictures, meshes, movieclip contents and
//! transparency. A figure whose measured bounds do not reach the point is not drawn at all.

use std::collections::HashSet;

use styk_eval::assets::Assets;
use styk_eval::doc::Document;
use styk_eval::drawlist::{Overrides, app_bounds, encode_composed};
use styk_eval::eval::Frame;
use styk_eval::geometry::build_shapes;
use styk_raster::{Edges, Images, Raster, ViewParams};

/// The three-pixel surface a candidate is drawn on, and the pictures that stay decoded between clicks.
pub struct Picker {
    raster: Raster,
    images: Images,
}

impl Default for Picker {
    fn default() -> Picker {
        Picker { raster: Raster::new(Edges::Smooth), images: Images::default() }
    }
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
    if !point[0].is_finite() || !point[1].is_finite() {
        return Ok(None);
    }
    let scale = scale.abs().max(0.01);
    let scene = build_shapes(doc, frame, None);
    let bounds = app_bounds(&scene, doc);
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
    let drawn: HashSet<usize> = scene.items.iter().map(|item| item.slot as usize).collect();
    let mut flags = vec![true; frame.objects.len()];
    for &slot in frame.draw_order.iter().rev() {
        let slot = slot as usize;
        let Some(object) = frame.objects.get(slot) else { continue };
        if hidden.contains(&object.uid) || locked.contains(&object.uid) || !drawn.contains(&slot) {
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
        let list = encode_composed(doc, assets, &scene, &overrides, &[], None);
        flags[slot] = true;
        picker.images.ensure(&list, doc, assets).map_err(|error| error.to_string())?;
        let picture = picker.raster.render(&list, &picker.images, &view, [3, 3]);
        if picture.pixels[(3 + 1) * 4 + 3] != 0 {
            return Ok(Some(Hit { slot, uid: object.uid }));
        }
    }
    Ok(None)
}
