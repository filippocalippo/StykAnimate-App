//! Window pixels to cel pixels.
//!
//! The JavaScript controller maps a pointer through three steps: the view (`screenToWorld`), the symmetry mirrors in
//! world space, and the inverse of the cel's pixel matrix (`inversePoint`). The same steps run here in the same order
//! with the same arithmetic, so the same pointer lands on the same cel position.

/// `[a, b, c, d, e, f]`: `x' = a*x + c*y + e`, `y' = b*x + d*y + f`.
pub type Matrix = [f64; 6];

pub const IDENTITY: Matrix = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/// A point through a matrix.
pub fn apply(m: &Matrix, x: f64, y: f64) -> (f64, f64) {
    (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])
}

/// `inversePoint(matrix, p)`; `None` where the matrix has no inverse (a zero drawing scale).
pub fn inverse_point(m: &Matrix, x: f64, y: f64) -> Option<(f64, f64)> {
    let [a, b, c, d, e, f] = *m;
    let det = a * d - b * c;
    if det.abs() < 1e-12 {
        return None;
    }
    Some(((d * (x - e) - c * (y - f)) / det, (a * (y - f) - b * (x - e)) / det))
}

/// How a stroke's pointer positions reach its cel.
#[derive(Clone, Debug, PartialEq)]
pub struct Mapping {
    /// Window pixels to world units (the stage's view).
    pub world_from_window: Matrix,
    /// The cel's pixels to world units.
    pub pixel_matrix: Matrix,
    /// The world-space axes symmetry mirrors across, if the mirror is on.
    pub mirror_x: Option<f64>,
    pub mirror_y: Option<f64>,
}

impl Default for Mapping {
    fn default() -> Mapping {
        Mapping { world_from_window: IDENTITY, pixel_matrix: IDENTITY, mirror_x: None, mirror_y: None }
    }
}

impl Mapping {
    /// The mirror of each path: the stroke itself, then X, then Y, then both, for those that are on.
    pub fn paths(&self) -> Vec<(bool, bool)> {
        let mut paths = vec![(false, false)];
        if self.mirror_x.is_some() {
            paths.push((true, false));
        }
        if self.mirror_y.is_some() {
            paths.push((false, true));
        }
        if self.mirror_x.is_some() && self.mirror_y.is_some() {
            paths.push((true, true));
        }
        paths
    }

    fn world(&self, flips: (bool, bool), window: (f64, f64)) -> (f64, f64) {
        let (mut x, mut y) = apply(&self.world_from_window, window.0, window.1);
        if let (true, Some(axis)) = (flips.0, self.mirror_x) {
            x = 2.0 * axis - x;
        }
        if let (true, Some(axis)) = (flips.1, self.mirror_y) {
            y = 2.0 * axis - y;
        }
        (x, y)
    }

    /// One path's cel position for a window position (`inversePoint(matrix, map(world))`).
    pub fn cel_point(&self, flips: (bool, bool), window: (f64, f64)) -> Option<(f64, f64)> {
        let (x, y) = self.world(flips, window);
        inverse_point(&self.pixel_matrix, x, y)
    }

    /// The position and tilt direction of one path (`feedStroke`): the lean point is mapped like the position and
    /// `(ax, ay)` is the unit vector from one to the other, zero when they are closer than 1e-9.
    pub fn cel_sample(&self, flips: (bool, bool), window: (f64, f64), lean: Option<(f64, f64)>) -> Option<(f64, f64, f64, f64)> {
        let p = self.cel_point(flips, window)?;
        let (mut ax, mut ay) = (0.0, 0.0);
        if let Some(lean) = lean {
            let q = self.cel_point(flips, lean)?;
            let n = styk_math::hypot(q.0 - p.0, q.1 - p.1);
            if n > 1e-9 {
                ax = (q.0 - p.0) / n;
                ay = (q.1 - p.1) / n;
            }
        }
        Some((p.0, p.1, ax, ay))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_identity_maps_a_point_to_itself() {
        assert_eq!(Mapping::default().cel_point((false, false), (3.5, -2.0)), Some((3.5, -2.0)));
    }

    #[test]
    fn a_view_then_the_inverse_pose_in_the_javascript_order() {
        // Zoom 2 and pan (10, 20) from window to world; the cel is placed at (100, 50) at scale 4.
        let mapping = Mapping { world_from_window: [0.5, 0.0, 0.0, 0.5, -5.0, -10.0], pixel_matrix: [4.0, 0.0, 0.0, 4.0, 100.0, 50.0], mirror_x: None, mirror_y: None };
        let (wx, wy) = apply(&mapping.world_from_window, 230.0, 180.0);
        let expected = inverse_point(&mapping.pixel_matrix, wx, wy).unwrap();
        assert_eq!(mapping.cel_point((false, false), (230.0, 180.0)), Some(expected));
        assert_eq!(expected, (2.5, 7.5));
    }

    #[test]
    fn mirrors_reflect_in_world_space_before_the_pose() {
        let mapping = Mapping { mirror_x: Some(100.0), mirror_y: Some(50.0), ..Mapping::default() };
        assert_eq!(mapping.paths(), [(false, false), (true, false), (false, true), (true, true)]);
        assert_eq!(mapping.cel_point((true, false), (30.0, 20.0)), Some((170.0, 20.0)));
        assert_eq!(mapping.cel_point((false, true), (30.0, 20.0)), Some((30.0, 80.0)));
        assert_eq!(mapping.cel_point((true, true), (30.0, 20.0)), Some((170.0, 80.0)));
    }

    #[test]
    fn a_zero_scale_pose_has_no_inverse() {
        let mapping = Mapping { pixel_matrix: [0.0; 6], ..Mapping::default() };
        assert_eq!(mapping.cel_point((false, false), (1.0, 1.0)), None);
    }

    #[test]
    fn tilt_becomes_a_unit_vector_through_the_pose() {
        let mapping = Mapping::default();
        let (_, _, ax, ay) = mapping.cel_sample((false, false), (10.0, 10.0), Some((10.0, 26.0))).unwrap();
        assert_eq!((ax, ay), (0.0, 1.0));
        // A pose rotated a quarter turn turns the lean with it.
        let rotated = Mapping { pixel_matrix: [0.0, 1.0, -1.0, 0.0, 0.0, 0.0], ..Mapping::default() };
        let (_, _, ax, ay) = rotated.cel_sample((false, false), (10.0, 10.0), Some((10.0, 26.0))).unwrap();
        assert!((ax - 1.0).abs() < 1e-12 && ay.abs() < 1e-12, "{ax} {ay}");
        let (_, _, ax, ay) = mapping.cel_sample((false, false), (10.0, 10.0), Some((10.0, 10.0))).unwrap();
        assert_eq!((ax, ay), (0.0, 0.0));
    }
}
