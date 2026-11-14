//! Procedural noise materials of generated effects: smoke, flame, wisp and cartoon puff,
//! each a row of four 256-pixel cells (variants) with three box-reduced levels; 1,024
//! pixels square in all (`styk_draw::MATERIAL_*`), within every device's texture limit.
//!
//! A texel holds two fields, not a picture: **density** (0 outside, rising toward the
//! middle, broken up by noise), which a particle cuts at its erosion threshold so its
//! outline stays crisp at any magnification and breaks up as it ages; and **light** (0.5
//! neutral), the material lit from above (smoke, puff), its heat (flame) or its streaks
//! (wisp). Density is 0 for the outer eighth of every cell, so filtering never reads a
//! neighbour.
//!
//! Generation is pure arithmetic (`+ - * /`, `floor`, `sqrt`, integer hashes), so the bytes
//! are the same on every platform. It runs on the engine's workers when a document with
//! generated effects opens ([`row`]); the interface thread only looks ([`ready`]) and draws
//! soft discs until a material is there (D7). A material being generated elsewhere is
//! generated again rather than waited for, the first copy kept.

use std::sync::atomic::{AtomicPtr, Ordering};

/// The atlas layout is the draw-list format's (`styk_draw::MATERIAL_*`).
pub const CELL: usize = styk_draw::MATERIAL_CELL as usize;
pub const COLUMNS: usize = styk_draw::MATERIAL_COLUMNS as usize;
pub const LEVELS: usize = styk_draw::MATERIAL_LEVELS as usize;
/// Materials (rows).
pub const ROWS: usize = styk_draw::MATERIAL_ROWS as usize;

/// The materials, by row.
pub const SMOKE: u32 = 0;
pub const FLAME: u32 = 1;
pub const WISP: u32 = 2;
pub const PUFF: u32 = 3;
pub const NAMES: [&str; ROWS] = ["smoke", "flame", "wisp", "puff"];

/// One reduced level of a material: `width × height` texels of `[density, light]`.
#[derive(Clone, Debug, PartialEq)]
pub struct Level {
    pub width: usize,
    pub height: usize,
    pub data: Vec<u8>,
}

/// One material: its full-size row of cells and three reduced levels.
#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub index: usize,
    pub levels: Vec<Level>,
}

#[inline]
fn pcg(v: u32) -> u32 {
    let s = v.wrapping_mul(747796405).wrapping_add(2891336453);
    let w = ((s >> ((s >> 28) + 4)) ^ s).wrapping_mul(277803737);
    (w >> 22) ^ w
}

#[inline]
fn hash(x: i32, y: i32, seed: u32) -> f32 {
    pcg((x as u32).wrapping_mul(73856093) ^ (y as u32).wrapping_mul(19349663) ^ seed.wrapping_mul(83492791)) as f32 * (1.0 / 4294967296.0)
}

#[inline]
fn smooth(a: f32, b: f32, x: f32) -> f32 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Smooth value noise, 0–1.
fn noise(x: f32, y: f32, seed: u32) -> f32 {
    let (ix, iy) = (x.floor(), y.floor());
    let (fx, fy) = (x - ix, y - iy);
    let (ux, uy) = (fx * fx * (3.0 - 2.0 * fx), fy * fy * (3.0 - 2.0 * fy));
    let (ix, iy) = (ix as i32, iy as i32);
    let a = hash(ix, iy, seed) + (hash(ix + 1, iy, seed) - hash(ix, iy, seed)) * ux;
    let b = hash(ix, iy + 1, seed) + (hash(ix + 1, iy + 1, seed) - hash(ix, iy + 1, seed)) * ux;
    a + (b - a) * uy
}

/// Fractal noise of `octaves` octaves, 0–1, its octaves turned so no grid shows.
fn fbm(x: f32, y: f32, seed: u32, octaves: u32) -> f32 {
    let (mut x, mut y) = (x, y);
    let (mut sum, mut amp, mut total) = (0.0, 0.5, 0.0);
    for o in 0..octaves {
        sum += noise(x, y, seed.wrapping_add(o * 7919)) * amp;
        total += amp;
        // About 37° and ×2.03 each octave.
        let (nx, ny) = (x * 1.62 - y * 1.22, x * 1.22 + y * 1.62);
        x = nx + 3.1;
        y = ny - 1.7;
        amp *= 0.5;
    }
    sum / total
}

/// Billowy fractal noise (folded): lumps rather than ripples.
fn billow(x: f32, y: f32, seed: u32, octaves: u32) -> f32 {
    let (mut x, mut y) = (x, y);
    let (mut sum, mut amp, mut total) = (0.0, 0.5, 0.0);
    for o in 0..octaves {
        sum += (1.0 - (noise(x, y, seed.wrapping_add(o * 7919)) * 2.0 - 1.0).abs()) * amp;
        total += amp;
        let (nx, ny) = (x * 1.62 - y * 1.22, x * 1.22 + y * 1.62);
        x = nx + 3.1;
        y = ny - 1.7;
        amp *= 0.5;
    }
    sum / total
}

fn len(x: f32, y: f32) -> f32 {
    (x * x + y * y).sqrt()
}

fn smin(a: f32, b: f32, k: f32) -> f32 {
    let h = (0.5 + 0.5 * (b - a) / k).clamp(0.0, 1.0);
    b + (a - b) * h - k * h * (1.0 - h)
}

/// A variant's random numbers.
struct Random(u32);

impl Random {
    fn next(&mut self) -> f32 {
        self.0 = pcg(self.0.wrapping_add(0x9E37_79B9));
        self.0 as f32 * (1.0 / 4294967296.0)
    }
}

/// The edge every cell keeps clear: density falls to 0 by 0.92 of its radius.
fn clear(u: f32, v: f32) -> f32 {
    smooth(0.92, 0.7, len(u, v))
}

/// Smoke: a billowing puff of a few lumps, lit from the upper left, darker underneath.
fn smoke(u: f32, v: f32, seed: u32, lumps: &[(f32, f32, f32)]) -> (f32, f32) {
    let field = |u: f32, v: f32| -> f32 {
        let mut shape = 0.0f32;
        for &(cx, cy, r) in lumps {
            let d = len(u - cx, v - cy) / r;
            shape = shape.max(1.0 - d * d);
        }
        let detail = billow(u * 3.1 + 11.0, v * 3.1 - 5.0, seed, 5);
        ((shape * 1.15 - 0.05) * (0.45 + 0.8 * detail)).clamp(0.0, 1.0) * clear(u, v)
    };
    let d = field(u, v);
    // Light: how much denser it is toward the light (a cheap self-shadow), and lower parts darker.
    let toward = field(u - 0.07, v - 0.11);
    let light = (0.55 + (d - toward) * -1.6 - v * 0.18).clamp(0.0, 1.0);
    (d, light)
}

/// Flame: a tongue of fire, wide and round at its foot, licking up to a torn point, a smaller tongue
/// forking off; light is its heat.
fn flame(u: f32, v: f32, seed: u32, lean: f32) -> (f32, f32) {
    // A tongue of fire: its outline torn by rising noise that grows toward the tip, a second, smaller
    // tongue forking off one side, its middle hottest at the foot.
    let tongue = |u: f32, v: f32, scale: f32, offset: f32, salt: u32| -> (f32, f32) {
        let up = ((0.62 - v) / 1.5).clamp(0.0, 1.0);
        let sway = (fbm(u * 2.2, v * 1.3 + 7.0, seed ^ salt, 4) - 0.5) * (0.25 + 0.75 * up);
        let tear = (fbm(u * 5.5 + 3.0, v * 3.2, seed ^ salt ^ 0x51, 3) - 0.5) * 0.35 * up;
        let x = (u - offset) / scale + sway * 0.7 + tear + lean * (0.4 - v) * 0.3;
        let y = (v - 0.62) / scale + 0.62 + (fbm(u * 3.3 + 4.0, v * 2.2, seed ^ salt ^ 0x33, 3) - 0.5) * 0.18;
        let t = ((0.62 - y) / 1.5).clamp(0.0, 1.0);
        let half = 0.46 * (1.0 - t).sqrt() * (0.5 + 0.5 * (1.0 - t)) + 0.015;
        let across = x.abs() / half.max(1e-3);
        let inside = (1.0 - across) * smooth(0.0, 0.1, t) * smooth(1.0, 0.9, t);
        let heat = ((1.0 - across).max(0.0) * super::fastmath::powf((1.0 - t) as f64, 0.9) as f32 * 1.3 - 0.12).clamp(0.0, 1.0);
        (inside, heat)
    };
    let (main, heat) = tongue(u, v, 1.0, 0.0, 0);
    let side = if lean > 0.0 { 0.24 } else { -0.24 };
    let (fork, fork_heat) = tongue(u, v, 0.55, side, 0x9e37);
    let detail = fbm(u * 6.0 + 2.0, v * 4.0, seed ^ 0x77, 3);
    let inside = main.max(fork * 0.9);
    let d = (inside * (0.72 + 0.56 * detail)).clamp(0.0, 1.0) * clear(u, v);
    (d, heat.max(fork_heat * 0.8))
}

// Wisp: soft streaks drawn out along x, thinning at both ends.
fn wisp(u: f32, v: f32, seed: u32, bend: f32) -> (f32, f32) {
    let y = v - bend * (u * u - 0.3);
    let streaks = fbm(u * 1.3 + 9.0, y * 7.5, seed, 4);
    let body = smooth(0.95, 0.35, u.abs()) * smooth(0.42, 0.05, y.abs());
    let d = ((streaks * 1.6 - 0.35) * body).clamp(0.0, 1.0) * clear(u, v);
    let light = (0.4 + streaks * 0.7).clamp(0.0, 1.0);
    (d, light)
}

/// Puff: a cartoon cloud of round lobes: density rises steeply inside its outline, so a
/// threshold cuts a clean cartoon shape, and lumps within it erode it into smaller puffs.
fn puff(u: f32, v: f32, seed: u32, lobes: &[(f32, f32, f32)]) -> (f32, f32) {
    let sdf = |u: f32, v: f32| -> f32 {
        let mut d = 9.0f32;
        for &(cx, cy, r) in lobes {
            d = smin(d, len(u - cx, v - cy) - r, 0.1);
        }
        d
    };
    let d0 = sdf(u, v);
    let lumps = fbm(u * 2.4 + 1.3, v * 2.4 - 3.7, seed, 3);
    let d = (smooth(0.02, -0.4, d0) * (0.78 + 0.35 * lumps)).clamp(0.0, 1.0) * clear(u, v);
    // Lit from above: the outline's normal facing up is bright.
    let (gx, gy) = (sdf(u + 0.01, v) - sdf(u - 0.01, v), sdf(u, v + 0.01) - sdf(u, v - 0.01));
    let gl = len(gx, gy).max(1e-6);
    let light = (0.55 - gy / gl * 0.35 * smooth(-0.35, 0.0, d0) + (-v) * 0.12).clamp(0.0, 1.0);
    (d, light)
}

/// Material `row`, generated.
pub fn generate(row: usize) -> Row {
    let width = CELL * COLUMNS;
    let mut base = vec![0u8; width * CELL * 2];
    for k in 0..COLUMNS {
        let seed = ((row as u32 + 1).wrapping_mul(0x9E37_79B9)) ^ ((k as u32 + 1).wrapping_mul(40503));
        let mut r = Random(seed);
        // Each variant's own lumps, lobes, lean and bend.
        let lumps: Vec<(f32, f32, f32)> = (0..6).map(|i| {
            let a = i as f32 / 6.0 * 6.2832 + r.next() * 0.8;
            let d = if i == 0 { 0.0 } else { 0.18 + r.next() * 0.22 };
            (d * fast_cos(a), d * fast_sin(a) * 0.85 + 0.04, 0.32 + r.next() * 0.2 - if i == 0 { 0.0 } else { 0.06 })
        }).collect();
        let lobes: Vec<(f32, f32, f32)> = (0..7).map(|i| {
            let a = i as f32 / 7.0 * 6.2832 + r.next() * 0.5;
            let d = if i == 0 { 0.0 } else { 0.3 + r.next() * 0.12 };
            (d * fast_cos(a), d * fast_sin(a) * 0.8, if i == 0 { 0.42 } else { 0.22 + r.next() * 0.1 })
        }).collect();
        let lean = r.next() * 2.0 - 1.0;
        let bend = (r.next() - 0.5) * 0.5;
        for y in 0..CELL {
            let v = (y as f32 + 0.5) / CELL as f32 * 2.0 - 1.0;
            for x in 0..CELL {
                let u = (x as f32 + 0.5) / CELL as f32 * 2.0 - 1.0;
                let (d, l) = match row as u32 {
                    SMOKE => smoke(u, v, seed, &lumps),
                    FLAME => flame(u, v, seed, lean),
                    WISP => wisp(u, v, seed, bend),
                    _ => puff(u, v, seed, &lobes),
                };
                let o = (y * width + k * CELL + x) * 2;
                base[o] = (d.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
                base[o + 1] = (l.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
            }
        }
    }
    let mut levels = vec![Level { width, height: CELL, data: base }];
    for _ in 1..LEVELS {
        let previous = levels.last().unwrap();
        let (sw, w, h) = (previous.width, previous.width >> 1, previous.height >> 1);
        let src = &previous.data;
        let mut data = vec![0u8; w * h * 2];
        for y in 0..h {
            for x in 0..w {
                for c in 0..2 {
                    let at = |xx: usize, yy: usize| src[(yy * sw + xx) * 2 + c] as u32;
                    let sum = at(2 * x, 2 * y) + at(2 * x + 1, 2 * y) + at(2 * x, 2 * y + 1) + at(2 * x + 1, 2 * y + 1);
                    data[(y * w + x) * 2 + c] = ((sum + 2) / 4) as u8;
                }
            }
        }
        levels.push(Level { width: w, height: h, data });
    }
    Row { index: row, levels }
}

/// `cos` and `sin` for the variants' layout (a short series; exact operations only).
fn fast_cos(a: f32) -> f32 {
    fast_sin(a + 1.570_796_3)
}

fn fast_sin(a: f32) -> f32 {
    let x = a - (a / 6.283_185_5).round() * 6.283_185_5;
    let x2 = x * x;
    x * (1.0 - x2 / 6.0 * (1.0 - x2 / 20.0 * (1.0 - x2 / 42.0 * (1.0 - x2 / 72.0 * (1.0 - x2 / 110.0)))))
}

static GENERATED: [AtomicPtr<Row>; ROWS] = [const { AtomicPtr::new(std::ptr::null_mut()) }; ROWS];

/// Material `row` when it has been generated, without generating it.
pub fn ready(row: usize) -> Option<&'static Row> {
    let ptr = GENERATED.get(row)?.load(Ordering::Acquire);
    // Published pointers come from `Box::leak` and are never freed.
    (!ptr.is_null()).then(|| unsafe { &*ptr })
}

/// Whether every material has been generated.
pub fn all_ready() -> bool {
    (0..ROWS).all(|row| ready(row).is_some())
}

/// Material `row`, generated on first use. One another thread is still generating is
/// generated here too (never waited for); the first published copy is the one kept. Not on
/// the interface thread: it takes a few hundred milliseconds.
pub fn row(row: usize) -> &'static Row {
    if let Some(done) = ready(row) {
        return done;
    }
    let ours = Box::into_raw(Box::new(generate(row)));
    match GENERATED[row].compare_exchange(std::ptr::null_mut(), ours, Ordering::AcqRel, Ordering::Acquire) {
        Ok(_) => unsafe { &*ours },
        Err(theirs) => {
            // Another thread published first: ours was never shared.
            drop(unsafe { Box::from_raw(ours) });
            unsafe { &*theirs }
        }
    }
}

/// Every material (on a worker, before drawing what needs them).
pub fn prepare() {
    for r in 0..ROWS {
        row(r);
    }
}

#[cfg(test)]
mod timing_tmp {
    #[test]
    fn time_atlas() {
        for r in 0..4 {
            let t = std::time::Instant::now();
            let _ = super::generate(r);
            eprintln!("material {r}: {:.0} ms", t.elapsed().as_secs_f64() * 1000.0);
        }
    }
}
