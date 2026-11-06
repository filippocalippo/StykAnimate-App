//! The fragment arithmetic of styk-render's `prim.wgsl`, in single precision as the GPU
//! computes it: coverage by distance, the distance functions of strokes, and texture
//! sampling (nearest, bilinear and Canvas-style Mitchell, clamped to the edge).

use crate::target::Px;

pub(crate) const PI: f32 = std::f32::consts::PI;

/// Coverage of a pixel whose centre lies `d` world units outside a shape's edge, `aa`
/// world units a pixel (`coverage` in prim.wgsl); crisp edges cover fully or not at all.
#[inline]
pub(crate) fn coverage(d: f32, aa: f32, crisp: bool) -> f32 {
    if crisp {
        return if d <= 0.0 { 1.0 } else { 0.0 };
    }
    (0.5 - d / aa).clamp(0.0, 1.0)
}

#[inline]
pub(crate) fn premul(c: [f32; 4]) -> [f32; 4] {
    [c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]]
}

#[inline]
pub(crate) fn scale(c: [f32; 4], k: f32) -> [f32; 4] {
    [c[0] * k, c[1] * k, c[2] * k, c[3] * k]
}

/// Straight RGBA of a packed RGBA8 colour (`unpack4x8unorm`).
#[inline]
pub(crate) fn unpack(color: u32) -> [f32; 4] {
    [(color & 255) as f32 / 255.0, (color >> 8 & 255) as f32 / 255.0, (color >> 16 & 255) as f32 / 255.0, (color >> 24) as f32 / 255.0]
}

#[inline]
fn length(x: f32, y: f32) -> f32 {
    (x * x + y * y).sqrt()
}

pub(crate) fn sd_segment(p: [f32; 2], a: [f32; 2], b: [f32; 2]) -> f32 {
    let (pa, ba) = ([p[0] - a[0], p[1] - a[1]], [b[0] - a[0], b[1] - a[1]]);
    let h = ((pa[0] * ba[0] + pa[1] * ba[1]) / (ba[0] * ba[0] + ba[1] * ba[1]).max(1e-20)).clamp(0.0, 1.0);
    length(pa[0] - ba[0] * h, pa[1] - ba[1] * h)
}

pub(crate) fn sd_box(p: [f32; 2], a: [f32; 2], b: [f32; 2], hw: f32) -> f32 {
    let mut d = [b[0] - a[0], b[1] - a[1]];
    let len = length(d[0], d[1]);
    d = if len > 1e-12 { [d[0] / len, d[1] / len] } else { [1.0, 0.0] };
    let n = [-d[1], d[0]];
    let q = [p[0] - (a[0] + b[0]) * 0.5, p[1] - (a[1] + b[1]) * 0.5];
    let local = [(q[0] * d[0] + q[1] * d[1]).abs() - (len * 0.5 + hw), (q[0] * n[0] + q[1] * n[1]).abs() - hw];
    length(local[0].max(0.0), local[1].max(0.0)) + local[0].max(local[1]).min(0.0)
}

pub(crate) fn in_sweep(angle: f32, start: f32, sweep: f32) -> bool {
    let tau = 2.0 * PI;
    if sweep >= 0.0 {
        let d = angle - start;
        return d - (d / tau).floor() * tau <= sweep;
    }
    let d = start - angle;
    d - (d / tau).floor() * tau <= -sweep
}

pub(crate) fn sd_arc(p: [f32; 2], center: [f32; 2], r: f32, start: f32, sweep: f32) -> f32 {
    let v = [p[0] - center[0], p[1] - center[1]];
    let a = v[1].atan2(v[0]);
    if in_sweep(a, start, sweep) || sweep.abs() >= 2.0 * PI - 1e-6 {
        return (length(v[0], v[1]) - r).abs();
    }
    let e0 = [center[0] + r * start.cos(), center[1] + r * start.sin()];
    let e1 = [center[0] + r * (start + sweep).cos(), center[1] + r * (start + sweep).sin()];
    length(p[0] - e0[0], p[1] - e0[1]).min(length(p[0] - e1[0], p[1] - e1[1]))
}

/// Pixels in rows of `width`: premultiplied, or straight where `straight` (drawing cel
/// tiles, which the GPU premultiplies texel by texel before filtering).
#[derive(Clone, Copy, Debug)]
pub(crate) struct Texture<'a> {
    pub width: usize,
    pub height: usize,
    pub data: &'a [Px],
    pub straight: bool,
}

impl Texture<'_> {
    /// Texel (`x`, `y`), edges clamped, premultiplied.
    #[inline]
    pub fn texel(&self, x: i64, y: i64) -> [f32; 4] {
        let x = x.clamp(0, self.width as i64 - 1) as usize;
        let y = y.clamp(0, self.height as i64 - 1) as usize;
        self.at(y * self.width + x)
    }

    /// Texel `i`, premultiplied, as floats.
    #[inline]
    fn at(&self, i: usize) -> [f32; 4] {
        const K: f32 = 1.0 / 255.0;
        let p = self.data[i];
        let c = [p[0] as f32 * K, p[1] as f32 * K, p[2] as f32 * K, p[3] as f32 * K];
        if self.straight { premul(c) } else { c }
    }

    /// Bilinear filtering at texel coordinates `t` (texel centres at halves), edges clamped.
    #[inline]
    pub fn bilinear(&self, t: [f32; 2]) -> [f32; 4] {
        let (x, y) = (t[0] - 0.5, t[1] - 0.5);
        let (ix, iy) = (floor(x), floor(y));
        let (fx, fy) = (x - ix as f32, y - iy as f32);
        let (w, h) = (self.width as i64, self.height as i64);
        let (a, b, c, d) = if ix >= 0 && iy >= 0 && ix + 1 < w && iy + 1 < h {
            let i = (iy * w + ix) as usize;
            (self.at(i), self.at(i + 1), self.at(i + self.width), self.at(i + self.width + 1))
        } else {
            (self.texel(ix, iy), self.texel(ix + 1, iy), self.texel(ix, iy + 1), self.texel(ix + 1, iy + 1))
        };
        [0, 1, 2, 3].map(|k| {
            let top = a[k] + (b[k] - a[k]) * fx;
            let bottom = c[k] + (d[k] - c[k]) * fx;
            top + (bottom - top) * fy
        })
    }

    /// Canvas 2D's 'high' smoothing when enlarging: separable Mitchell-Netravali
    /// B=C=1/3 at texel coordinates (centres at halves), premultiplied first.
    /// Arithmetic and clamping follow prim.wgsl::tile_mitchell.
    pub fn mitchell(&self, t: [f32; 2]) -> [f32; 4] {
        let (x, y) = (t[0] - 0.5, t[1] - 0.5);
        let (ix, iy) = (floor(x), floor(y));
        let (fx, fy) = (x - ix as f32, y - iy as f32);
        let weights = |f: f32| [mitchell_weight(f + 1.0), mitchell_weight(f), mitchell_weight(1.0 - f), mitchell_weight(2.0 - f)];
        let (wx, wy) = (weights(fx), weights(fy));
        let mut sum = [0.0; 4];
        for j in 0..4 {
            let mut row = [0.0; 4];
            for i in 0..4 {
                let c = self.texel(ix + i as i64 - 1, iy + j as i64 - 1);
                for k in 0..4 {
                    row[k] += c[k] * wx[i];
                }
            }
            for k in 0..4 {
                sum[k] += row[k] * wy[j];
            }
        }
        let alpha = sum[3].clamp(0.0, 1.0);
        [sum[0].clamp(0.0, alpha), sum[1].clamp(0.0, alpha), sum[2].clamp(0.0, alpha), alpha]
    }

    /// The texel holding texel coordinates `t`, edges clamped.
    #[inline]
    pub fn nearest(&self, t: [f32; 2]) -> [f32; 4] {
        self.texel(floor(t[0]), floor(t[1]))
    }
}

/// Mitchell-Netravali B=C=1/3, evaluated in the same order as prim.wgsl.
#[inline]
fn mitchell_weight(t: f32) -> f32 {
    let x = t.abs();
    if x < 1.0 {
        ((7.0 / 6.0 * x - 2.0) * x) * x + 8.0 / 9.0
    } else if x < 2.0 {
        ((-7.0 / 18.0 * x + 2.0) * x - 10.0 / 3.0) * x + 16.0 / 9.0
    } else {
        0.0
    }
}

/// `x.floor()` as an integer, without a library call where the target has no rounding
/// instruction.
#[inline]
pub(crate) fn floor(x: f32) -> i64 {
    let i = x as i64;
    if (i as f32) > x { i - 1 } else { i }
}

/// A one-channel coverage mask (glyph masks), sampled bilinearly.
pub(crate) struct Mask {
    pub width: usize,
    pub height: usize,
    pub data: Vec<u8>,
}

impl Mask {
    #[inline]
    fn texel(&self, x: i64, y: i64) -> f32 {
        let x = x.clamp(0, self.width as i64 - 1) as usize;
        let y = y.clamp(0, self.height as i64 - 1) as usize;
        self.data[y * self.width + x] as f32 / 255.0
    }

    #[inline]
    pub fn bilinear(&self, t: [f32; 2]) -> f32 {
        let (x, y) = (t[0] - 0.5, t[1] - 0.5);
        let (ix, iy) = (floor(x), floor(y));
        let (fx, fy) = (x - ix as f32, y - iy as f32);
        let top = self.texel(ix, iy) + (self.texel(ix + 1, iy) - self.texel(ix, iy)) * fx;
        let bottom = self.texel(ix, iy + 1) + (self.texel(ix + 1, iy + 1) - self.texel(ix, iy + 1)) * fx;
        top + (bottom - top) * fy
    }
}

/// An affine map `[a, b, c, d, e, f]`: x' = a·x + c·y + e, y' = b·x + d·y + f.
pub(crate) type Affine = [f64; 6];

#[inline]
pub(crate) fn apply(m: Affine, p: [f64; 2]) -> [f64; 2] {
    [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]]
}

/// `m` in single precision applied to a single-precision point, as a vertex shader does.
#[inline]
pub(crate) fn apply32(m: &[f32; 6], p: [f32; 2]) -> [f32; 2] {
    [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]]
}

pub(crate) fn invert(m: Affine) -> Affine {
    let det = m[0] * m[3] - m[1] * m[2];
    let (a, b, c, d) = (m[3] / det, -m[1] / det, -m[2] / det, m[0] / det);
    [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])]
}

#[inline]
pub(crate) fn single(m: Affine) -> [f32; 6] {
    m.map(|v| v as f32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mitchell_enlargement_spreads_an_impulse_without_transparent_colour_leaking() {
        let mut pixels = vec![[0, 0, 255, 0]; 8 * 8];
        pixels[3 * 8 + 3] = [255, 0, 0, 128];
        let texture = Texture { width: 8, height: 8, data: &pixels, straight: true };
        let c = texture.mitchell([3.5, 3.5]);
        // An impulse at the texel centre has the separable Mitchell centre weight (8/9)².
        let expected = 128.0 / 255.0 * 64.0 / 81.0;
        assert!((c[0] - expected).abs() < 1e-6 && (c[3] - expected).abs() < 1e-6, "{c:?}");
        assert_eq!([c[1], c[2]], [0.0, 0.0], "transparent blue cannot tint the red ink");
        assert!(texture.bilinear([3.5, 3.5])[3] > c[3] + 0.1, "enlargement does not silently stay bilinear");
        assert_eq!(texture.mitchell([5.0, 3.5]), [0.0; 4], "negative lobes are clamped before blending");
    }

    #[test]
    fn mitchell_clamps_overshoot_and_preserves_flat_premultiplied_colour() {
        let pixels: Vec<_> = (0..8 * 8).map(|i| if i % 8 < 4 { [255, 255, 255, 255] } else { [0; 4] }).collect();
        let step = Texture { width: 8, height: 8, data: &pixels, straight: true };
        assert_eq!(step.mitchell([2.8, 3.5]), [1.0; 4], "a bright edge cannot overshoot its coverage");
        let pixels = [[160, 80, 40, 128]; 8 * 8];
        let flat = Texture { width: 8, height: 8, data: &pixels, straight: true };
        for point in [[3.125, 2.875], [0.1, 0.2], [7.9, 7.8]] {
            let expected = flat.texel(0, 0);
            let actual = flat.mitchell(point);
            assert!(actual.into_iter().zip(expected).all(|(a, b)| (a - b).abs() < 1e-6), "{point:?}: {actual:?} != {expected:?}");
        }
    }

    #[test]
    fn mitchell_tiles_match_an_untiled_image_across_edges_and_corners() {
        // A 2×2 tiling of high-contrast translucent ink, with two real neighbor texels
        // in each slot. Sampling either side of both internal edges gives the same
        // colour as the untiled image, including the corner shared by all four tiles.
        let pixel = |x: usize, y: usize| [(x * 47 % 256) as u8, (y * 73 % 256) as u8, ((x + y) * 19 % 256) as u8, if (x + 3 * y) % 5 == 0 { 0 } else { 180 }];
        let whole: Vec<_> = (0..132 * 132).map(|i| pixel(i % 132, i / 132)).collect();
        let full = Texture { width: 132, height: 132, data: &whole, straight: true };
        for ty in 0..2 {
            for tx in 0..2 {
                let slot: Vec<_> = (0..68 * 68).map(|i| pixel(tx * 64 + i % 68, ty * 64 + i / 68)).collect();
                let tile = Texture { width: 68, height: 68, data: &slot, straight: true };
                for y in [0.01, 0.125, 0.5, 63.5, 63.875, 63.99] {
                    for x in [0.01, 0.125, 0.5, 63.5, 63.875, 63.99] {
                        let actual = tile.mitchell([x + 2.0, y + 2.0]);
                        let expected = full.mitchell([tx as f32 * 64.0 + x + 2.0, ty as f32 * 64.0 + y + 2.0]);
                        assert!(actual.into_iter().zip(expected).all(|(a, b)| (a - b).abs() < 2e-5), "tile ({tx},{ty}), ({x},{y}): {actual:?} != {expected:?}");
                    }
                }
            }
        }
    }
}
