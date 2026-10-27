//! From the renderer's premultiplied pixels to what encoders take: straight RGBA, averaged
//! 2×2 for Smooth sprites, over black for video without transparency.

/// Resolves the rendered rows of a tile (`src`, premultiplied RGBA, `stride` bytes a row,
/// `valid` pixels wide and high) into `out`: straight RGBA of `valid / factor` pixels,
/// rows packed. With `factor` 2 each 2×2 block is averaged as `downsampleExportPixels`
/// does: alpha is the mean alpha, colour the alpha-weighted mean colour (the mean of the
/// premultiplied colours over the mean alpha). With `matte` the result is composited over
/// black and opaque (FFmpeg formats without alpha, `deliverFrame`'s black fill).
pub fn resolve(src: &[u8], stride: usize, valid: [u32; 2], factor: u32, matte: bool, out: &mut Vec<u8>) {
    let factor = factor.max(1) as usize;
    let (w, h) = (valid[0] as usize / factor, valid[1] as usize / factor);
    out.clear();
    out.resize(w * h * 4, 0);
    for y in 0..h {
        let row = &mut out[y * w * 4..(y + 1) * w * 4];
        if factor == 1 {
            let line = &src[y * stride..y * stride + w * 4];
            for (o, p) in row.as_chunks_mut::<4>().0.iter_mut().zip(line.as_chunks::<4>().0) {
                o.copy_from_slice(&straight([p[0] as u32, p[1] as u32, p[2] as u32], p[3] as u32, 1, matte));
            }
        } else {
            let (top, bottom) = (&src[2 * y * stride..], &src[(2 * y + 1) * stride..]);
            for (x, o) in row.as_chunks_mut::<4>().0.iter_mut().enumerate() {
                let (a, b) = (&top[8 * x..8 * x + 8], &bottom[8 * x..8 * x + 8]);
                let sum = |c: usize| a[c] as u32 + a[c + 4] as u32 + b[c] as u32 + b[c + 4] as u32;
                o.copy_from_slice(&straight([sum(0), sum(1), sum(2)], sum(3), 4, matte));
            }
        }
    }
}

/// Straight RGBA from premultiplied colour sums of `n` pixels and their alpha sum.
fn straight(color: [u32; 3], alpha: u32, n: u32, matte: bool) -> [u8; 4] {
    // Integer rounding to nearest, halves up, as `Math.round` on non-negative values.
    let mean = |v: u32| ((2 * v + n) / (2 * n)) as u8;
    if matte {
        return [mean(color[0]), mean(color[1]), mean(color[2]), 255];
    }
    if alpha == 0 {
        return [0; 4];
    }
    let unpremultiply = |c: u32| ((2 * 255 * c + alpha) / (2 * alpha)).min(255) as u8;
    [unpremultiply(color[0]), unpremultiply(color[1]), unpremultiply(color[2]), mean(alpha)]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `downsampleExportPixels` (src/export-sampling.mjs) on straight RGBA, for comparison.
    fn javascript_box(straight: &[[u8; 4]; 4]) -> [u8; 4] {
        let alpha: f64 = straight.iter().map(|p| p[3] as f64).sum();
        let mut out = [0u8; 4];
        out[3] = (alpha / 4.0).round() as u8;
        if alpha > 0.0 {
            for c in 0..3 {
                out[c] = (straight.iter().map(|p| p[c] as f64 * p[3] as f64).sum::<f64>() / alpha).round() as u8;
            }
        }
        out
    }

    fn premultiply(p: [u8; 4]) -> [u8; 4] {
        let k = |c: u8| ((c as f64 * p[3] as f64) / 255.0).round() as u8;
        [k(p[0]), k(p[1]), k(p[2]), p[3]]
    }

    #[test]
    fn opaque_and_transparent_pixels_pass_unchanged() {
        let src = [10, 20, 30, 255, 0, 0, 0, 0, 64, 0, 32, 128];
        let mut out = Vec::new();
        resolve(&src, 12, [3, 1], 1, false, &mut out);
        assert_eq!(out, [10, 20, 30, 255, 0, 0, 0, 0, 128, 0, 64, 128]);
        resolve(&src, 12, [3, 1], 1, true, &mut out);
        assert_eq!(out, [10, 20, 30, 255, 0, 0, 0, 255, 64, 0, 32, 255], "over black");
    }

    #[test]
    fn rows_are_read_at_the_stride() {
        // Two rows of one pixel, 256 bytes apart (the read-back's row alignment).
        let mut src = vec![0u8; 260];
        src[..4].copy_from_slice(&[1, 2, 3, 255]);
        src[256..].copy_from_slice(&[4, 5, 6, 255]);
        let mut out = Vec::new();
        resolve(&src, 256, [1, 2], 1, false, &mut out);
        assert_eq!(out, [1, 2, 3, 255, 4, 5, 6, 255]);
    }

    #[test]
    fn blocks_average_as_the_javascript_exporter_does() {
        // Edge blocks: one opaque, one translucent and two clear pixels, and the like.
        let blocks: [[[u8; 4]; 4]; 4] = [
            [[255, 0, 0, 255], [0, 0, 255, 128], [0, 0, 0, 0], [0, 0, 0, 0]],
            [[20, 200, 40, 255], [20, 200, 40, 255], [20, 200, 40, 255], [20, 200, 40, 254]],
            [[0, 0, 0, 0]; 4],
            [[250, 250, 250, 3], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
        ];
        for block in blocks {
            let p: Vec<[u8; 4]> = block.iter().map(|&q| premultiply(q)).collect();
            // The block as a 2×2 tile: top row p0 p1, bottom row p2 p3.
            let src: Vec<u8> = [p[0], p[1], p[2], p[3]].concat();
            let mut out = Vec::new();
            resolve(&src, 8, [2, 2], 2, false, &mut out);
            let expected = javascript_box(&block);
            for c in 0..4 {
                // The renderer stores premultiplied bytes, so a translucent colour is known to a level or so.
                let limit = match expected[3] {
                    _ if c == 3 => 0,
                    0 => 255,
                    255 => 0,
                    alpha => 255 / alpha as i32 + 1,
                };
                assert!((out[c] as i32 - expected[c] as i32).abs() <= limit, "{block:?}: {out:?} against {expected:?}");
            }
        }
    }
}
