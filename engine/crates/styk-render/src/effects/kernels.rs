//! The arithmetic of the filter core that both renderers share (docs/engine/vfx.md, "The filter core"): how a Gaussian blur of a
//! given width is split into halvings and a small exact kernel, where each halved image lies on the global pixel grid, and how a
//! long directional, zoom or radial blur is split into passes. The recipe records passes from these numbers; the GPU shaders and
//! the CPU rasterizer then apply them. Nothing here needs a GPU.

/// The Gaussian's standard deviation for a blur `radius` (in layer pixels): the meaning the editor's three box passes gave
/// `radius` (`radius / factor * 0.57735` per box, three boxes), without its rounding.
pub fn sigma_of_radius(radius: f64) -> f64 {
    radius.max(0.0) * 0.57735
}

/// Variance (in level-0 pixels²) one 2× tent reduction from level `k` adds: the tent \[1 3 3 1\] / 8 has a variance of 0.75 of its
/// source's pixels².
fn reduction_variance(k: u32) -> f64 {
    0.75 * 4f64.powi(k as i32)
}

/// Variance (in level-0 pixels²) of reading a level-`level` image with the cubic B-spline (1/3 of that level's pixels²).
pub fn spline_variance(level: u32) -> f64 {
    if level == 0 { 0.0 } else { 4f64.powi(level as i32) / 3.0 }
}

/// Variance (in level-0 pixels²) the reductions from level 0 down to `level` add.
pub fn reductions_variance(level: u32) -> f64 {
    (0..level).map(reduction_variance).sum()
}

/// The residual blur below which a level is not worth its halving: the level is chosen so that the Gaussian left to do there is
/// between about 1.3 and 2.9 of its pixels, a kernel of at most 25 taps (13 bilinear samples).
const LEVEL_SIGMA: f64 = 1.5;
/// Halvings at most: a blur of radius 128 at density 8 is about 590 pixels wide, 2^8 times the level's kernel.
pub const MAX_LEVEL: u32 = 8;

/// How a Gaussian blur of `sigma` (level-0 pixels) is made: halved `level` times (each halving a tent on the global grid), blurred
/// there by `residual` (that level's pixels), then read back at full size with the cubic B-spline (when `level` > 0). The
/// variances add up to `sigma`², so the blur is the same at any size and grows continuously with `sigma`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GaussianPlan {
    pub level: u32,
    pub residual: f64,
}

pub fn gaussian(sigma: f64) -> GaussianPlan {
    let sigma = sigma.max(0.0);
    let level = if sigma < 2.0 * LEVEL_SIGMA { 0 } else { ((sigma / LEVEL_SIGMA).log2().floor() as u32).min(MAX_LEVEL) };
    let residual = residual(sigma, level, spline_variance(level));
    GaussianPlan { level, residual }
}

/// The blur left to do at `level` for a total of `sigma` (level-0 pixels) when the reductions and `after` (variance added once the
/// level is blurred, level-0 pixels²) are counted; 0 when they already exceed it.
pub fn residual(sigma: f64, level: u32, after: f64) -> f64 {
    let left = sigma * sigma - reductions_variance(level) - after;
    (left.max(0.0) / 4f64.powi(level as i32)).sqrt()
}

/// The discrete Gaussian kernel of standard deviation `sigma` (pixels): `T(n, t) = e^-t I_n(t)` with `t = sigma²`, whose variance is
/// exactly `sigma²` and which is the identity at 0, so a blur is continuous in its width down to nothing. Taps `0..=reach` (the
/// kernel is symmetric), renormalised after the cut at three and a half standard deviations.
pub fn discrete_gaussian(sigma: f64) -> Vec<f64> {
    let t = sigma * sigma;
    if t <= 1e-12 {
        return vec![1.0];
    }
    let reach = ((3.5 * sigma).ceil() as usize + 1).min(MAX_REACH);
    // I_n(t) by its series; t is at most about 9 here, so forty terms are far past convergence.
    let bessel = |n: usize| {
        let half = t / 2.0;
        let mut term = half.powi(n as i32) / (1..=n).map(|k| k as f64).product::<f64>();
        let mut sum = term;
        for k in 1..60 {
            term *= half * half / (k as f64 * (k + n) as f64);
            sum += term;
            if term < sum * 1e-17 {
                break;
            }
        }
        sum
    };
    let mut w: Vec<f64> = (0..=reach).map(|n| (-t).exp() * bessel(n)).collect();
    let total = w[0] + 2.0 * w[1..].iter().sum::<f64>();
    for v in &mut w {
        *v /= total;
    }
    w
}

/// Taps of one side of a kernel at most: σ is below 3 at its level, three and a half of them are 11 pixels.
pub const MAX_REACH: usize = 12;
/// Samples of one convolution pass at most (\`Uniform::taps\`).
pub const MAX_SAMPLES: usize = 16;

/// A symmetric kernel `w[0..=reach]` as bilinear samples (offset in pixels along the axis, weight): the centre alone, then pairs
/// of taps merged into one sample between them. A GPU pass reads the samples; the CPU applies the taps themselves.
pub fn bilinear_samples(w: &[f64]) -> Vec<(f64, f64)> {
    let mut out = vec![(0.0, w[0])];
    let mut n = 1;
    while n < w.len() {
        let (a, b) = (w[n], w.get(n + 1).copied().unwrap_or(0.0));
        let sum = a + b;
        if sum > 0.0 {
            let at = n as f64 + b / sum;
            out.push((at, sum));
            out.push((-at, sum));
        }
        n += 2;
    }
    out
}

/// The global grid of the halved images: level `k`'s texel `j` covers level-0 pixels `[j·2^k − a_k, (j+1)·2^k − a_k)` of a layer
/// whose first pixel is at global position `origin`, so every level's texel edges lie at global multiples of `2^k` and a halved
/// image is the same wherever the layer is cropped or panned (by whole pixels). `a_k` per axis.
pub fn level_offset(origin: [f64; 2], level: u32) -> [f64; 2] {
    let step = (1u64 << level) as f64;
    origin.map(|o| o.round().rem_euclid(step))
}

/// The size of level `level` of a `size` layer (`level_offset` for `origin`).
pub fn level_size(size: [u32; 2], origin: [f64; 2], level: u32) -> [u32; 2] {
    let a = level_offset(origin, level);
    let step = (1u64 << level) as f64;
    [0, 1].map(|k| ((size[k] as f64 + a[k]) / step).ceil().max(1.0) as u32)
}

/// Where the cubic B-spline reads a texel row for continuous coordinate `u` (texel `m` spans `[m, m + 1)`): two bilinear samples
/// (position, weight) that together weigh texels `i − 1 … i + 2` by the B-spline of the fraction.
pub fn spline_samples(u: f64) -> [(f64, f64); 2] {
    let t = u - 0.5;
    let i = t.floor();
    let f = t - i;
    let w = spline_weights(f);
    let (g0, g1) = (w[0] + w[1], w[2] + w[3]);
    [(i - 0.5 + w[1] / g0, g0), (i + 1.5 + w[3] / g1, g1)]
}

/// The cubic B-spline's weights of the four texels around a fraction `f` (0–1) between the middle two.
pub fn spline_weights(f: f64) -> [f64; 4] {
    let (f2, f3) = (f * f, f * f * f);
    [(1.0 - f).powi(3) / 6.0, (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0, (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0, f3 / 6.0]
}

/// A blur along a family of transforms (directional: a shift; zoom: a scale about the centre; radial: a turn about it), split
/// into passes that each average `taps` evenly spaced transforms. Composed, they average `taps^passes` transforms evenly spaced
/// over `[-extent, extent]`: a long blur is many samples with no gaps, not a few copies.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LinePlan {
    pub passes: u32,
    pub taps: u32,
    /// The spacing of the composed transforms, in the family's parameter.
    pub step: f64,
}

/// Taps of a line pass at most (\`Uniform\` loops up to it).
pub const MAX_LINE_TAPS: u32 = 32;

/// The plan of a line blur whose transforms range over `[-extent, extent]` of their parameter and move the farthest pixel the blur
/// reaches by `length` pixels over that range: samples are at most a pixel apart there.
pub fn line(extent: f64, length: f64) -> LinePlan {
    let needed = (length.max(0.0).ceil() as u64 + 1).max(2);
    let mut passes = 1u32;
    while (MAX_LINE_TAPS as u64).pow(passes) < needed && passes < 4 {
        passes += 1;
    }
    let mut taps = (needed as f64).powf(1.0 / passes as f64).ceil() as u32;
    taps = taps.clamp(2, MAX_LINE_TAPS);
    let total = (taps as f64).powi(passes as i32);
    LinePlan { passes, taps, step: 2.0 * extent / (total - 1.0) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_discrete_gaussian_has_the_asked_variance_and_sums_to_one() {
        for sigma in [0.0, 0.05, 0.3, 0.8, 1.3, 2.0, 2.9] {
            let w = discrete_gaussian(sigma);
            let sum = w[0] + 2.0 * w[1..].iter().sum::<f64>();
            let variance = 2.0 * w.iter().enumerate().map(|(n, v)| (n * n) as f64 * v).sum::<f64>();
            assert!((sum - 1.0).abs() < 1e-12, "{sigma}: {sum}");
            assert!((variance - sigma * sigma).abs() < 3e-3 * (sigma * sigma).max(0.01), "{sigma}: variance {variance}");
        }
        assert_eq!(discrete_gaussian(0.0), vec![1.0], "no blur is the identity");
    }

    #[test]
    fn a_plan_adds_up_to_the_asked_blur_at_every_width() {
        let mut previous = None;
        let mut sigma = 0.0;
        while sigma < 600.0 {
            let plan = gaussian(sigma);
            let total = reductions_variance(plan.level) + spline_variance(plan.level) + plan.residual * plan.residual * 4f64.powi(plan.level as i32);
            if sigma > 2.0 {
                assert!((total - sigma * sigma).abs() < 1e-6 * sigma * sigma, "{sigma}: {plan:?}");
            }
            assert!(plan.residual <= 3.0 + 1e-9, "{sigma}: the kernel stays small: {plan:?}");
            if let Some(GaussianPlan { level, .. }) = previous {
                assert!(plan.level >= level && plan.level <= level + 1);
            }
            previous = Some(plan);
            sigma += 0.01;
        }
    }

    #[test]
    fn levels_lie_on_the_global_grid() {
        // A layer whose first pixel is at global 37: level 2's texels start at 36, so a_2 = 1.
        assert_eq!(level_offset([37.0, -3.0], 2), [1.0, 1.0]);
        assert_eq!(level_size([10, 10], [37.0, -3.0], 2), [3, 3]);
        // Moving the layer by whole pixels moves the levels by whole texels.
        for shift in 0..9 {
            let a = level_offset([37.0 + shift as f64, 0.0], 3)[0];
            assert_eq!((37.0 + shift as f64 - a).rem_euclid(8.0), 0.0);
        }
    }

    #[test]
    fn spline_samples_weigh_the_four_texels() {
        for u in [3.5, 3.6, 4.0, 4.49] {
            let [(p0, g0), (p1, g1)] = spline_samples(u);
            assert!((g0 + g1 - 1.0).abs() < 1e-12);
            assert!(p0 < p1 && p1 - p0 >= 1.0);
        }
    }

    #[test]
    fn a_long_line_blur_has_no_gaps() {
        for length in [0.4, 3.0, 31.0, 32.0, 200.0, 1000.0, 5000.0] {
            let plan = line(length / 2.0, length);
            let total = (plan.taps as f64).powi(plan.passes as i32);
            assert!(total >= length, "{length}: {plan:?}");
            assert!(plan.step <= 1.0 + 1e-9, "{length}: samples at most a pixel apart: {plan:?}");
            assert!(plan.taps <= MAX_LINE_TAPS);
        }
    }
}
