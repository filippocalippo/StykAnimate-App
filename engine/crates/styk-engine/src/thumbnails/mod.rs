//! Thumbnails and library previews: what is drawn, and how it is framed.
//!
//! The editor shows small pictures of frames in three places: the timeline's filmstrip,
//! the export dialog's previews, and the asset library's posters and hover animations.
//! They are drawn by the GPU renderer, as the stage draws (`styk-wasm`: frame thumbnails
//! on the stage's own device, library previews in the preview worker); this module holds
//! what does not depend on the device:
//!
//! * [`card`]: how a frame thumbnail is framed: the canvas
//!   scaled to fit and centred on a light grey card, seen through the scene camera. The
//!   frame itself is the one exports and playback draw ([`crate::export::ExportFrames`]:
//!   effects drawn, only the document's hidden layers hidden), prepared on the engine's
//!   workers, never on the interface thread.
//! * [`library::LibraryPreview`]: a library file opened on its own (it is not the open
//!   document), its frames, and the square they are fitted to on transparency.

pub mod library;
pub mod monitor;

/// The largest thumbnail side.
pub const MAX_SIDE: u32 = 512;
/// The card colour around the canvas (`#f5f5f5`), straight RGBA.
pub const CARD: [f64; 4] = [245.0 / 255.0, 245.0 / 255.0, 245.0 / 255.0, 1.0];

/// How a picture is framed: world → output pixels, and the output rectangle the scene
/// is clipped to (x0, y0, x1, y1). `zoom` and `pan` are the transform without the scene
/// camera (where the canvas lands).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Framing {
    pub matrix: [f64; 6],
    pub artboard: [f64; 4],
    pub zoom: f64,
    pub pan: [f64; 2],
}

/// A frame thumbnail on a `width × height` card: the canvas scaled uniformly to fit,
/// centred, seen through `camera` (the camera layer's visibility is the document's).
pub fn card(doc: &styk_eval::doc::Document, camera: Option<&styk_eval::doc::Camera>, width: u32, height: u32) -> Framing {
    let (cw, ch) = (doc.canvas[0].max(1) as f64, doc.canvas[1].max(1) as f64);
    let zoom = (width as f64 / cw).min(height as f64 / ch);
    let pan = [(width as f64 - cw * zoom) / 2.0, (height as f64 - ch * zoom) / 2.0];
    Framing { matrix: styk_eval::view::camera_matrix(doc, camera, zoom, pan), artboard: [pan[0], pan[1], pan[0] + cw * zoom, pan[1] + ch * zoom], zoom, pan }
}

#[cfg(test)]
mod tests {
    use super::*;
    use styk_eval::doc::{Camera, Document};
    use styk_eval::view::apply;

    #[test]
    fn a_card_fits_the_canvas_and_centres_it() {
        let doc = Document { canvas: [1600, 900], ..Default::default() };
        // Wider than 16:9: grey bars left and right.
        let f = card(&doc, None, 200, 90);
        assert_eq!(f.artboard, [20.0, 0.0, 180.0, 90.0]);
        assert_eq!(apply(f.matrix, [1600.0, 900.0]), [180.0, 90.0]);
        // Taller: bars above and below.
        let f = card(&doc, None, 160, 160);
        assert_eq!(f.artboard, [0.0, 35.0, 160.0, 125.0]);
        // Through a camera zoomed in twice on the canvas centre, the centre stays put.
        let camera = Camera { x: 0.0, y: 0.0, scale: 0.5, angle: 0.0, is_default: false, motion_offset: None };
        let f = card(&doc, Some(&camera), 160, 90);
        assert_eq!(apply(f.matrix, [800.0, 450.0]), [80.0, 45.0]);
        assert_eq!(apply(f.matrix, [900.0, 450.0]), [100.0, 45.0]);
    }
}
