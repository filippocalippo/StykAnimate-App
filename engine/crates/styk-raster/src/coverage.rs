//! Which samples of which pixels a triangle covers, by the rules GPUs rasterize with
//! (Direct3D 11, Vulkan, Metal): vertices snapped to 1/256 of a pixel, samples at the
//! standard positions of four-sample multisampling (or the pixel's centre for one sample),
//! and the top-left rule, so triangles sharing an edge cover each of its samples exactly
//! once: a mesh or a quad of two triangles has no seam and no doubled sample.

/// Sub-pixel units a pixel (8 bits of sub-pixel precision).
const SUB: f32 = 256.0;

/// Sample positions of four samples a pixel, in 1/256 pixel: (6, 2), (14, 6), (2, 10), (10, 14) sixteenths.
pub(crate) const FOUR: [[i64; 2]; 4] = [[96, 32], [224, 96], [32, 160], [160, 224]];
/// The one sample of crisp edges: the pixel's centre.
pub(crate) const ONE: [[i64; 2]; 1] = [[128, 128]];

/// The sample positions of a target with `samples` a pixel.
pub(crate) fn positions(samples: usize) -> &'static [[i64; 2]] {
    if samples == 4 { &FOUR } else { &ONE }
}

/// A triangle set up for rasterizing: its three edge functions, positive inside.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Triangle {
    /// Per edge: `a·x + b·y + c` (sub-pixel units), and the value a sample must reach
    /// (0 on a top or left edge, 1 elsewhere).
    edges: [[i64; 4]; 3],
    /// Twice the area, in sub-pixel units squared.
    pub area: i64,
    /// Pixel bounds: x0, y0, x1, y1 (exclusive).
    pub bounds: [i64; 4],
    /// Vertex `k` of the caller's order is vertex `order[k]` here (two are swapped to orient it).
    pub order: [usize; 3],
}

/// A triangle's edge values at the samples of a pixel, relative to the pixel's corner.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Samples {
    /// Per edge, each sample's offset.
    pub offsets: [[i64; 4]; 3],
    /// Per edge, the smallest and largest offset.
    low: [i64; 3],
    high: [i64; 3],
    count: usize,
    full: u8,
}

impl Triangle {
    /// The triangle of target-pixel positions `v`, or `None` when it covers no area.
    pub fn new(v: [[f32; 2]; 3]) -> Option<Triangle> {
        if !v.iter().all(|p| p[0].is_finite() && p[1].is_finite() && p[0].abs() < 1e7 && p[1].abs() < 1e7) {
            return None;
        }
        let snap = |p: [f32; 2]| [(p[0] * SUB).round() as i64, (p[1] * SUB).round() as i64];
        let mut p = [snap(v[0]), snap(v[1]), snap(v[2])];
        let mut order = [0, 1, 2];
        let mut area = (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[1][1] - p[0][1]) * (p[2][0] - p[0][0]);
        if area == 0 {
            return None;
        }
        if area < 0 {
            p.swap(1, 2);
            order = [0, 2, 1];
            area = -area;
        }
        let edge = |a: [i64; 2], b: [i64; 2]| {
            let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
            // y grows downwards: with this orientation a top edge runs right, a left edge up.
            let top_left = dy < 0 || (dy == 0 && dx > 0);
            [-dy, dx, dy * a[0] - dx * a[1], if top_left { 0 } else { 1 }]
        };
        let edges = [edge(p[1], p[2]), edge(p[2], p[0]), edge(p[0], p[1])];
        let (x0, x1) = (p.iter().map(|q| q[0]).min().unwrap(), p.iter().map(|q| q[0]).max().unwrap());
        let (y0, y1) = (p.iter().map(|q| q[1]).min().unwrap(), p.iter().map(|q| q[1]).max().unwrap());
        let bounds = [x0.div_euclid(256), y0.div_euclid(256), x1.div_euclid(256) + 1, y1.div_euclid(256) + 1];
        Some(Triangle { edges, area, bounds, order })
    }

    /// The edge functions at sample position `s` (sub-pixel units): the weights of the
    /// vertices opposite each edge, times twice the area.
    #[inline]
    pub fn at(&self, s: [i64; 2]) -> [i64; 3] {
        self.edges.map(|e| e[0] * s[0] + e[1] * s[1] + e[2])
    }

    /// The edge values at the samples `positions` of a pixel, relative to its corner.
    pub fn samples(&self, positions: &[[i64; 2]]) -> Samples {
        let mut offsets = [[0i64; 4]; 3];
        let (mut low, mut high) = ([i64::MAX; 3], [i64::MIN; 3]);
        for (e, edge) in self.edges.iter().enumerate() {
            for (k, s) in positions.iter().enumerate() {
                let o = edge[0] * s[0] + edge[1] * s[1];
                offsets[e][k] = o;
                low[e] = low[e].min(o);
                high[e] = high[e].max(o);
            }
        }
        Samples { offsets, low, high, count: positions.len(), full: ((1u16 << positions.len()) - 1) as u8 }
    }

    /// The edge values at the corner of pixel (`x`, `y`).
    #[inline]
    pub fn corner(&self, x: i64, y: i64) -> [i64; 3] {
        self.at([x * 256, y * 256])
    }

    /// The samples covered of the pixel whose corner has edge values `v`: none when one
    /// edge excludes them all, every one when no edge excludes any, else each by itself.
    #[inline]
    pub fn classify(&self, s: &Samples, v: [i64; 3]) -> u8 {
        let bias = [self.edges[0][3], self.edges[1][3], self.edges[2][3]];
        if v[0] + s.high[0] < bias[0] || v[1] + s.high[1] < bias[1] || v[2] + s.high[2] < bias[2] {
            return 0;
        }
        if v[0] + s.low[0] >= bias[0] && v[1] + s.low[1] >= bias[1] && v[2] + s.low[2] >= bias[2] {
            return s.full;
        }
        let mut mask = 0;
        for k in 0..s.count {
            if v[0] + s.offsets[0][k] >= bias[0] && v[1] + s.offsets[1][k] >= bias[1] && v[2] + s.offsets[2][k] >= bias[2] {
                mask |= 1 << k;
            }
        }
        mask
    }

    /// How much the edge values grow from one pixel to the next along a row.
    #[inline]
    pub fn step(&self) -> [i64; 3] {
        [self.edges[0][0] * 256, self.edges[1][0] * 256, self.edges[2][0] * 256]
    }

    /// The samples of pixel (`x`, `y`) inside the triangle (bit `k`: `positions[k]`).
    #[cfg(test)]
    pub fn mask(&self, x: i64, y: i64, positions: &[[i64; 2]]) -> u8 {
        self.classify(&self.samples(positions), self.corner(x, y))
    }

    /// Calls `f(x, y, mask, corner)` for every pixel inside `clip` (x0, y0, x1, y1, exclusive)
    /// with a covered sample; `corner` holds the edge values at the pixel's corner (add
    /// [`Samples::offsets`] for a sample's).
    pub fn scan(&self, clip: [i64; 4], samples: &Samples, mut f: impl FnMut(i64, i64, u8, [i64; 3])) {
        let [x0, y0, x1, y1] = [self.bounds[0].max(clip[0]), self.bounds[1].max(clip[1]), self.bounds[2].min(clip[2]), self.bounds[3].min(clip[3])];
        if x1 <= x0 {
            return;
        }
        let step = self.step();
        for y in y0..y1 {
            let mut v = self.corner(x0, y);
            for x in x0..x1 {
                let mask = self.classify(samples, v);
                if mask != 0 {
                    f(x, y, mask, v);
                }
                v = [v[0] + step[0], v[1] + step[1], v[2] + step[2]];
            }
        }
    }

    /// Calls `f(x, y, mask)` for every pixel inside `clip` with a covered sample.
    pub fn each(&self, clip: [i64; 4], positions: &[[i64; 2]], mut f: impl FnMut(i64, i64, u8)) {
        let samples = self.samples(positions);
        self.scan(clip, &samples, |x, y, mask, _| f(x, y, mask));
    }
}

/// A parallelogram drawn as the GPU draws a quad (corners `o`, `o + u`, `o + v`, `o + u + v`
/// as two triangles sharing the diagonal from `o + u` to `o + v`): `f(x, y, mask)` for every
/// pixel inside `clip` with a covered sample; each sample is covered by one triangle at most.
pub(crate) fn quad(c: [[f32; 2]; 4], clip: [i64; 4], positions: &[[i64; 2]], mut f: impl FnMut(i64, i64, u8)) {
    let triangles = [Triangle::new([c[0], c[1], c[2]]), Triangle::new([c[2], c[1], c[3]])];
    let bounds = match triangles {
        [Some(a), Some(b)] => [a.bounds[0].min(b.bounds[0]), a.bounds[1].min(b.bounds[1]), a.bounds[2].max(b.bounds[2]), a.bounds[3].max(b.bounds[3])],
        [Some(a), None] | [None, Some(a)] => a.bounds,
        [None, None] => return,
    };
    let [x0, y0, x1, y1] = [bounds[0].max(clip[0]), bounds[1].max(clip[1]), bounds[2].min(clip[2]), bounds[3].min(clip[3])];
    if x1 <= x0 {
        return;
    }
    let setup = triangles.map(|t| t.map(|t| (t, t.samples(positions), t.step())));
    for y in y0..y1 {
        let mut v = setup.map(|s| s.map(|(t, _, _)| t.corner(x0, y)).unwrap_or([0; 3]));
        for x in x0..x1 {
            let mut mask = 0;
            for (k, s) in setup.iter().enumerate() {
                if let Some((t, samples, step)) = s {
                    mask |= t.classify(samples, v[k]);
                    v[k] = [v[k][0] + step[0], v[k][1] + step[1], v[k][2] + step[2]];
                }
            }
            if mask != 0 {
                f(x, y, mask);
            }
        }
    }
}

/// The pixels of `clip` (x0, y0, x1, y1, exclusive) a convex polygon `poly` (target pixels)
/// touches, row by row: `f(y, x0, x1)`, `x1` exclusive. Shapes covered by distance are
/// shaded over their quad's pixels only, not over its whole bounding box.
pub(crate) fn spans(poly: &[[f32; 2]], clip: [i64; 4], mut f: impl FnMut(i64, i64, i64)) {
    if poly.is_empty() || !poly.iter().all(|p| p[0].is_finite() && p[1].is_finite()) {
        return;
    }
    let y_min = poly.iter().map(|p| p[1]).fold(f32::INFINITY, f32::min);
    let y_max = poly.iter().map(|p| p[1]).fold(f32::NEG_INFINITY, f32::max);
    let (y0, y1) = ((y_min.floor() as i64).max(clip[1]), (y_max.ceil() as i64).min(clip[3]));
    for y in y0..y1 {
        let (top, bottom) = (y as f32, y as f32 + 1.0);
        let (mut lo, mut hi) = (f32::INFINITY, f32::NEG_INFINITY);
        for (k, a) in poly.iter().enumerate() {
            let b = poly[(k + 1) % poly.len()];
            if a[1] >= top && a[1] <= bottom {
                lo = lo.min(a[0]);
                hi = hi.max(a[0]);
            }
            for line in [top, bottom] {
                if (a[1] < line) != (b[1] < line) {
                    let x = a[0] + (b[0] - a[0]) * (line - a[1]) / (b[1] - a[1]);
                    lo = lo.min(x);
                    hi = hi.max(x);
                }
            }
        }
        if lo > hi {
            continue;
        }
        let (x0, x1) = ((lo.floor() as i64).max(clip[0]), (hi.ceil() as i64).min(clip[2]));
        if x1 > x0 {
            f(y, x0, x1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spans_cover_a_rotated_quad() {
        // A thin diagonal strip from (1, 1) to (9, 9), about one pixel wide.
        let poly = [[1.0, 0.3], [9.7, 9.0], [9.0, 9.7], [0.3, 1.0]];
        let mut rows = Vec::new();
        spans(&poly, [0, 0, 20, 20], |y, x0, x1| rows.push((y, x0, x1)));
        assert_eq!(rows.first(), Some(&(0, 0, 2)));
        assert!(rows.iter().all(|&(y, x0, x1)| x1 - x0 <= 3 && x0 <= y && y < x1 + 1), "{rows:?}");
        assert_eq!(rows.len(), 10);
    }

    /// Two triangles sharing an edge cover every sample along it once.
    #[test]
    fn a_shared_edge_is_covered_once() {
        let a = Triangle::new([[0.3, 0.2], [9.7, 1.1], [2.2, 8.9]]).unwrap();
        let b = Triangle::new([[9.7, 1.1], [8.4, 9.6], [2.2, 8.9]]).unwrap();
        let mut counts = vec![0u8; 12 * 12 * 4];
        for t in [a, b] {
            t.each([0, 0, 12, 12], &FOUR, |x, y, mask| {
                for k in 0..4 {
                    if mask >> k & 1 != 0 {
                        counts[((y * 12 + x) * 4 + k) as usize] += 1;
                    }
                }
            });
        }
        assert!(counts.iter().all(|&c| c <= 1), "no sample is covered twice");
        // Every sample strictly inside the union is covered (a pixel well inside it, and one on the edge).
        assert_eq!(&counts[(5 * 12 + 5) * 4..(5 * 12 + 5) * 4 + 4], &[1, 1, 1, 1]);
    }

    #[test]
    fn samples_follow_the_standard_positions() {
        // A vertical edge at x = 0.5 of pixel 0: samples left of it are x = 0.375 and 0.125.
        let t = Triangle::new([[0.0, -10.0], [0.5, -10.0], [0.5, 10.0]]).unwrap();
        let rect = Triangle::new([[0.0, -10.0], [0.5, 10.0], [0.0, 10.0]]).unwrap();
        let mask = t.mask(0, 0, &FOUR) | rect.mask(0, 0, &FOUR);
        assert_eq!(mask, 0b0101, "samples 0 (x = 0.375) and 2 (x = 0.125)");
    }
}
