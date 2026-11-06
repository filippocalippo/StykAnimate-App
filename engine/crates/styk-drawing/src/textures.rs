//! Brush textures (`drawing-brush-textures.mjs`): image tips (tip-local alpha masks) and
//! paper grains (tileable height fields anchored to the cel), generated procedurally and
//! deterministically into one atlas, byte for byte as the JavaScript generates them
//! (its `Float32Array` intermediates included), and sampled with the same bilinear formulas.

use std::sync::OnceLock;

use crate::js::{max, min, round, to_u8};

pub const TIP_SIZE: usize = 128;
pub const GRAIN_SIZE: usize = 256;
pub const TEXTURE_TIPS: [&str; 3] = ["chalk", "bristle", "sponge"];
pub const TEXTURE_GRAINS: [&str; 2] = ["paper", "canvas"];
const TIP_BYTES: usize = TIP_SIZE * TIP_SIZE;
const GRAIN_BYTES: usize = GRAIN_SIZE * GRAIN_SIZE;
pub const ATLAS_BYTES: usize = TEXTURE_TIPS.len() * TIP_BYTES + TEXTURE_GRAINS.len() * GRAIN_BYTES;

/// Byte offset of a tip in the atlas, or `None` for the analytic round tip.
pub fn tip_base(tip: &str) -> Option<usize> {
    TEXTURE_TIPS.iter().position(|t| *t == tip).map(|i| i * TIP_BYTES)
}

/// Byte offset of a grain in the atlas, or `None` for per-pixel noise.
pub fn grain_base(grain: &str) -> Option<usize> {
    TEXTURE_GRAINS.iter().position(|g| *g == grain).map(|i| TEXTURE_TIPS.len() * TIP_BYTES + i * GRAIN_BYTES)
}

/// The editor's lattice hash in [0, 1).
pub fn hash(x: i32, y: i32, seed: i32) -> f64 {
    let mut h = (x.wrapping_mul(374761393) ^ y.wrapping_mul(668265263) ^ seed.wrapping_mul(974711)) as u32;
    h = ((h ^ (h >> 13)) as i32).wrapping_mul(1274126177) as u32;
    (h ^ (h >> 16)) as f64 / 4294967296.0
}

fn smooth(t: f64) -> f64 {
    t * t * (3.0 - 2.0 * t)
}

fn smoothstep(a: f64, b: f64, v: f64) -> f64 {
    let t = max(0.0, min(1.0, (v - a) / (b - a)));
    t * t * (3.0 - 2.0 * t)
}

/// Tileable fractal value noise (`fbm`), as single-precision values.
fn fbm(size: usize, mut period: usize, octaves: usize, seed: i32) -> Vec<f32> {
    let gain = 0.5;
    let mut out = vec![0f32; size * size];
    let mut amplitude = 1.0f64;
    let mut total = 0.0f64;
    let mut o = 0;
    while o < octaves && period <= size {
        let mut lattice = vec![0f32; period * period];
        let cell = size as f64 / period as f64;
        for (i, v) in lattice.iter_mut().enumerate() {
            *v = hash((i % period) as i32, (i / period) as i32, seed.wrapping_mul(31).wrapping_add(o as i32)) as f32;
        }
        for y in 0..size {
            let gy = y as f64 / cell;
            let y0 = gy.floor();
            let fy = smooth(gy - y0);
            let y0 = y0 as usize;
            let r0 = (y0 % period) * period;
            let r1 = ((y0 + 1) % period) * period;
            for x in 0..size {
                let gx = x as f64 / cell;
                let x0 = gx.floor();
                let fx = smooth(gx - x0);
                let x0 = x0 as usize;
                let c0 = x0 % period;
                let c1 = (x0 + 1) % period;
                let l = |i: usize| lattice[i] as f64;
                let top = l(r0 + c0) + (l(r0 + c1) - l(r0 + c0)) * fx;
                let bottom = l(r1 + c0) + (l(r1 + c1) - l(r1 + c0)) * fx;
                let i = y * size + x;
                out[i] = (out[i] as f64 + (top + (bottom - top) * fy) * amplitude) as f32;
            }
        }
        total += amplitude;
        o += 1;
        period *= 2;
        amplitude *= gain;
    }
    for v in out.iter_mut() {
        *v = (*v as f64 / total) as f32;
    }
    out
}

fn to_bytes(values: &[f32]) -> Vec<u8> {
    values.iter().map(|&v| to_u8(round(max(0.0, min(1.0, v as f64)) * 255.0))).collect()
}

fn chalk() -> Vec<u8> {
    let n = TIP_SIZE;
    let noise = fbm(n, 8, 4, 3);
    let rim = fbm(n, 4, 3, 5);
    let mut out = vec![0f32; n * n];
    for y in 0..n {
        for x in 0..n {
            let u = (x as f64 + 0.5) / n as f64 * 2.0 - 1.0;
            let v = (y as f64 + 0.5) / n as f64 * 2.0 - 1.0;
            let d = styk_math::hypot(u, v);
            let i = y * n + x;
            let edge = 0.72 + 0.2 * rim[i] as f64;
            out[i] = (smoothstep(edge, edge - 0.14, d) * smoothstep(0.22, 0.55, noise[i] as f64)) as f32;
        }
    }
    to_bytes(&out)
}

fn bristle() -> Vec<u8> {
    let n = TIP_SIZE;
    let mut out = vec![0f32; n * n];
    let count = 17;
    for k in 0..count {
        let v0 = -0.86 + 1.72 * k as f64 / (count - 1) as f64 + (hash(k, 1, 7) - 0.5) * 0.06;
        let u0 = (hash(k, 2, 7) - 0.5) * 0.5;
        let r = 0.05 + 0.05 * hash(k, 3, 7);
        let strength = 0.55 + 0.45 * hash(k, 4, 7);
        for y in 0..n {
            for x in 0..n {
                let u = (x as f64 + 0.5) / n as f64 * 2.0 - 1.0;
                let v = (y as f64 + 0.5) / n as f64 * 2.0 - 1.0;
                let d = styk_math::hypot((u - u0) * 0.45, v - v0);
                let i = y * n + x;
                out[i] = max(out[i] as f64, smoothstep(r, r * 0.35, d) * strength) as f32;
            }
        }
    }
    to_bytes(&out)
}

fn sponge() -> Vec<u8> {
    let n = TIP_SIZE;
    let noise = fbm(n, 8, 4, 11);
    let mut out = vec![0f32; n * n];
    for y in 0..n {
        for x in 0..n {
            let u = (x as f64 + 0.5) / n as f64 * 2.0 - 1.0;
            let v = (y as f64 + 0.5) / n as f64 * 2.0 - 1.0;
            let i = y * n + x;
            out[i] = (smoothstep(0.95, 0.7, styk_math::hypot(u, v)) * smoothstep(0.4, 0.6, noise[i] as f64)) as f32;
        }
    }
    to_bytes(&out)
}

fn paper() -> Vec<u8> {
    let n = GRAIN_SIZE;
    let tooth = fbm(n, 64, 3, 23);
    let hills = fbm(n, 16, 3, 21);
    let out: Vec<f32> = (0..n * n).map(|i| (1.0 - smoothstep(0.5, 0.78, tooth[i] as f64 * 0.8 + hills[i] as f64 * 0.2) * 0.9) as f32).collect();
    to_bytes(&out)
}

fn canvas() -> Vec<u8> {
    let n = GRAIN_SIZE;
    let noise = fbm(n, 64, 3, 29);
    let fibre = fbm(n, 128, 2, 31);
    let mut out = vec![0f32; n * n];
    let thread = 4usize;
    let pi = std::f64::consts::PI;
    for y in 0..n {
        for x in 0..n {
            let cx = x / thread;
            let cy = y / thread;
            let fx = ((x % thread) as f64 + 0.5) / thread as f64;
            let fy = ((y % thread) as f64 + 0.5) / thread as f64;
            let warp = styk_math::sin(fx * pi);
            let weft = styk_math::sin(fy * pi);
            let over = (cx + cy) & 1 == 0;
            let height = if over {
                max(warp * (0.55 + 0.45 * styk_math::sin(fy * pi)), weft * 0.45)
            } else {
                max(weft * (0.55 + 0.45 * styk_math::sin(fx * pi)), warp * 0.45)
            };
            out[y * n + x] = (0.2 + height * 0.55 + noise[y * n + x] as f64 * 0.15 + fibre[y * n + x] as f64 * 0.1) as f32;
        }
    }
    to_bytes(&out)
}

/// The whole atlas, every texture generated (once per process).
pub fn atlas() -> &'static [u8] {
    static ATLAS: OnceLock<Vec<u8>> = OnceLock::new();
    ATLAS.get_or_init(|| {
        let mut out = vec![0u8; ATLAS_BYTES];
        for (name, generate) in [("chalk", chalk as fn() -> Vec<u8>), ("bristle", bristle), ("sponge", sponge), ("paper", paper), ("canvas", canvas)] {
            let base = tip_base(name).or_else(|| grain_base(name)).unwrap();
            let bytes = generate();
            out[base..base + bytes.len()].copy_from_slice(&bytes);
        }
        out
    })
}

/// `sampleTip`: the bilinear tip mask at tip-local (u, v) ∈ [-1, 1]², clamped at the edges.
#[inline]
pub fn sample_tip(bytes: &[u8], base: usize, u: f64, v: f64) -> f64 {
    let n = TIP_SIZE as f64;
    let px = max(0.0, min(n - 1.0, (u * 0.5 + 0.5) * n - 0.5));
    let py = max(0.0, min(n - 1.0, (v * 0.5 + 0.5) * n - 0.5));
    let x0 = px.floor();
    let y0 = py.floor();
    let fx = px - x0;
    let fy = py - y0;
    let (x0, y0) = (x0 as usize, y0 as usize);
    let x1 = (x0 + 1).min(TIP_SIZE - 1);
    let y1 = (y0 + 1).min(TIP_SIZE - 1);
    let at = |x: usize, y: usize| bytes[base + y * TIP_SIZE + x] as f64;
    let (a, b, c, d) = (at(x0, y0), at(x1, y0), at(x0, y1), at(x1, y1));
    (a + (b - a) * fx + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy) / 255.0
}

/// `sampleGrain`: the bilinear grain height at cel pixel (x, y), wrapping every
/// `GRAIN_SIZE / scale` pixels.
#[inline]
pub fn sample_grain(bytes: &[u8], base: usize, x: f64, y: f64, scale: f64) -> f64 {
    let n = GRAIN_SIZE as i64;
    let px = (x + 0.5) / scale - 0.5;
    let py = (y + 0.5) / scale - 0.5;
    let fx0 = px.floor();
    let fy0 = py.floor();
    let fx = px - fx0;
    let fy = py - fy0;
    // `&` on JavaScript numbers works on their 32-bit integer values.
    let (ix, iy) = (crate::js::to_i32(fx0) as i64, crate::js::to_i32(fy0) as i64);
    let x0 = (ix & (n - 1)) as usize;
    let y0 = (iy & (n - 1)) as usize;
    let x1 = (crate::js::to_i32(fx0 + 1.0) as i64 & (n - 1)) as usize;
    let y1 = (crate::js::to_i32(fy0 + 1.0) as i64 & (n - 1)) as usize;
    let at = |x: usize, y: usize| bytes[base + y * GRAIN_SIZE + x] as f64;
    let (a, b, c, d) = (at(x0, y0), at(x1, y0), at(x0, y1), at(x1, y1));
    (a + (b - a) * fx + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy) / 255.0
}
