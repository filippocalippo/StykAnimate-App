//! Effects: drawing groups the way the editor filters artwork. [`plan`] places
//! layers for a view, [`record`] turns a placed group into the shader's group
//! record, [`recipe`] records an effect stack as the passes that filter a layer,
//! and [`executor`] runs them on the GPU. See `docs/engine/vfx.md` (Rendering).
//!
//! Everything but the executor is arithmetic the CPU rasterizer (styk-raster)
//! follows too, so both renderers place, filter and composite layers alike; it is
//! built without the `gpu` feature.

#[cfg(feature = "gpu")]
pub mod executor;
pub mod plan;
pub mod recipe;

use plan::{Affine, Filter, Placement};
use styk_eval::view::{compose, invert};

/// Floats of one group's record in the group table (six texels, see prim.wgsl).
pub const GROUP_FLOATS: usize = 24;

/// Where a placed group landed in the atlas.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Slot {
    pub page: u32,
    /// Atlas pixel of the layer's first pixel.
    pub offset: [f64; 2],
    /// Atlas pixels per layer pixel (1, or less in a downscaled round).
    pub scale: f64,
}

/// A group's record and its world → atlas map, for a group placed in `slot`
/// (`None`: not drawn). `parent` maps world units to the parent's target (the
/// view for groups of the frame).
pub fn record(placement: &Placement, parent: Affine, slot: Option<Slot>) -> ([f32; GROUP_FLOATS], Affine) {
    let mut r = [0f32; GROUP_FLOATS];
    let Some(slot) = slot.filter(|_| placement.drawn()) else {
        r[6] = -1.0;
        return (r, placement.space);
    };
    let (k, o, rect) = (slot.scale, slot.offset, placement.rect);
    // world -> layer pixels -> atlas pixels
    let to_atlas: Affine = [k, 0.0, 0.0, k, o[0] - rect[0] * k, o[1] - rect[1] * k];
    let m = compose(to_atlas, placement.space);
    let density = (m[0] * m[3] - m[1] * m[2]).abs().sqrt();
    let size = placement.size();
    let clip = [o[0], o[1], o[0] + (size[0] as f64 * k).ceil(), o[1] + (size[1] as f64 * k).ceil()];
    let (p, show) = match placement.camera {
        Some(camera) => {
            let from_atlas: Affine = [1.0 / k, 0.0, 0.0, 1.0 / k, rect[0] - o[0] / k, rect[1] - o[1] / k];
            let s = camera.show;
            (compose(camera.to_screen, from_atlas), [o[0] + (s[0] - rect[0]) * k, o[1] + (s[1] - rect[1]) * k, o[0] + (s[2] - rect[0]) * k, o[1] + (s[3] - rect[1]) * k])
        }
        None => (compose(parent, invert(m)), clip),
    };
    let f = |v: f64| v as f32;
    r[0..4].copy_from_slice(&[f(m[0]), f(m[1]), f(m[2]), f(m[3])]);
    r[4..8].copy_from_slice(&[f(m[4]), f(m[5]), slot.page as f32, f(1.0 / density.max(1e-12))]);
    r[8..12].copy_from_slice(&clip.map(f));
    r[12..16].copy_from_slice(&[f(p[0]), f(p[1]), f(p[2]), f(p[3])]);
    r[16..20].copy_from_slice(&[f(p[4]), f(p[5]), if placement.canvas { 1.0 } else { 0.0 }, 0.0]);
    r[20..24].copy_from_slice(&show.map(f));
    (r, m)
}

/// A filter for a layer drawn at `scale` atlas pixels per layer pixel.
pub fn scaled(filter: Filter, scale: f64) -> Filter {
    Filter { scale: filter.scale * scale, origin: filter.origin.map(|v| v * scale), output_size: filter.output_size.map(|v| v * scale) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use plan::CameraComposite;
    use styk_eval::view::apply;

    #[test]
    fn a_screen_group_composites_in_place() {
        // A plain group in the view's space, placed at (10, 20) in the atlas.
        let view: Affine = [2.0, 0.0, 0.0, 2.0, 5.0, 7.0];
        let p = Placement { space: view, rect: [100.0, 50.0, 300.0, 150.0], filter: None, camera: None, canvas: false };
        let (r, m) = record(&p, view, Some(Slot { page: 3, offset: [10.0, 20.0], scale: 1.0 }));
        assert_eq!(apply(m, [47.5, 21.5]), [10.0, 20.0], "the layer's first pixel at the slot");
        assert_eq!(r[6], 3.0);
        assert_eq!(&r[8..12], &[10.0, 20.0, 210.0, 120.0]);
        // Its composite maps atlas pixels straight back onto the screen rectangle.
        let back = [r[12] as f64, r[13] as f64, r[14] as f64, r[15] as f64, r[16] as f64, r[17] as f64];
        assert_eq!(apply(back, [10.0, 20.0]), [100.0, 50.0]);
        assert_eq!(&r[20..24], &r[8..12]);
    }

    #[test]
    fn the_camera_shows_its_centre() {
        let camera = CameraComposite { to_screen: [0.5, 0.0, 0.0, 0.5, 100.0, 100.0], show: [6.0, 6.0, 106.0, 56.0] };
        let p = Placement { space: [1.0, 0.0, 0.0, 1.0, 6.0, 6.0], rect: [0.0, 0.0, 112.0, 62.0], filter: None, camera: Some(camera), canvas: false };
        let (r, _) = record(&p, [1.0, 0.0, 0.0, 1.0, 0.0, 0.0], Some(Slot { page: 0, offset: [200.0, 0.0], scale: 1.0 }));
        assert_eq!(&r[20..24], &[206.0, 6.0, 306.0, 56.0]);
        let to_screen = [r[12] as f64, r[13] as f64, r[14] as f64, r[15] as f64, r[16] as f64, r[17] as f64];
        assert_eq!(apply(to_screen, [206.0, 6.0]), [103.0, 103.0]);
    }

    #[test]
    fn unplaced_groups_are_not_drawn() {
        let p = Placement { space: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0], rect: [0.0; 4], filter: None, camera: None, canvas: false };
        assert_eq!(record(&p, p.space, Some(Slot { page: 0, offset: [0.0; 2], scale: 1.0 })).0[6], -1.0);
    }
}
