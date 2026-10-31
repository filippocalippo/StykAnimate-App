//! The view an export frame is drawn with: the canvas scaled to the output, through the
//! scene camera, as `drawExportScene` places it (`scale(output / canvas)` then the camera).

use styk_eval::doc::{Camera, Document};
use styk_eval::view::{camera_matrix, compose};
use styk_render::ViewParams;

use crate::settings::Settings;
use crate::tiles::Tile;

/// The view of `tile` of an export frame of `doc` seen through `camera` (the frame's scene
/// camera; the camera layer's visibility is the document's). Transparent where the scene
/// draws nothing: the background is part of the draw list.
pub fn tile_view(doc: &Document, camera: Option<&Camera>, settings: &Settings, tile: &Tile) -> ViewParams {
    let [width, height] = settings.render_size();
    let (sx, sy) = (width as f64 / doc.canvas[0].max(1) as f64, height as f64 / doc.canvas[1].max(1) as f64);
    let (tx, ty) = (tile.x as f64, tile.y as f64);
    let matrix = compose([sx, 0.0, 0.0, sy, -tx, -ty], camera_matrix(doc, camera, 1.0, [0.0, 0.0]));
    ViewParams {
        matrix,
        artboard: [-tx, -ty, width as f64 - tx, height as f64 - ty],
        clip_to_artboard: true,
        clear: [0.0; 4],
        zoom: sx,
        pan: [-tx, -ty],
        stretch: sy / sx,
        camera_view: true,
        camera_limit: f64::INFINITY,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::Smoothing;
    use styk_eval::view::apply;

    fn doc(canvas: [u32; 2]) -> Document {
        Document { canvas, ..Default::default() }
    }

    #[test]
    fn the_canvas_fills_the_output() {
        let d = doc([800, 450]);
        let settings = Settings::new(1600, 900, Smoothing::Edges, crate::settings::MAX_PIXELS).unwrap();
        let tile = Tile { x: 0, y: 0, size: [1600, 900], valid: [1600, 900] };
        let v = tile_view(&d, None, &settings, &tile);
        assert_eq!(apply(v.matrix, [800.0, 450.0]), [1600.0, 900.0]);
        assert_eq!(v.artboard, [0.0, 0.0, 1600.0, 900.0]);
        // A stretched size, and a later tile of a supersampled frame.
        let wide = Settings::new(1600, 450, Smoothing::Sprites, crate::settings::MAX_PIXELS).unwrap();
        let tile = Tile { x: 2048, y: 0, size: [1600, 900], valid: [1152, 900] };
        let v = tile_view(&d, None, &wide, &tile);
        assert_eq!(apply(v.matrix, [800.0, 450.0]), [3200.0 - 2048.0, 900.0]);
        assert_eq!(v.stretch, 0.5, "4 pixels a unit across, 2 down");
    }

    #[test]
    fn the_scene_camera_is_seen_through() {
        let d = doc([800, 450]);
        let settings = Settings::new(800, 450, Smoothing::Edges, crate::settings::MAX_PIXELS).unwrap();
        let tile = Tile { x: 0, y: 0, size: [800, 450], valid: [800, 450] };
        // A camera zoomed in twice on the canvas centre shows its centre at the output's centre.
        let camera = Camera { x: 0.0, y: 0.0, scale: 0.5, angle: 0.0, is_default: false, motion_offset: None };
        let v = tile_view(&d, Some(&camera), &settings, &tile);
        assert_eq!(apply(v.matrix, [400.0, 225.0]), [400.0, 225.0]);
        assert_eq!(apply(v.matrix, [500.0, 225.0]), [600.0, 225.0]);
    }
}
