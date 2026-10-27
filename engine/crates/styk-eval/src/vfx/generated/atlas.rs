//! Procedural particle materials: 17 rows of
//! eight 128-pixel cells (smoke puffs, cartoon clouds, flames, star flares,
//! bokeh, wisps, bolts, shards, rocks, leaves, petals, snowflakes, drops,
//! splats, comic bursts, hearts and cartoon stars), each texel a coverage and a
//! shading value premultiplied by coverage, with three box-reduced levels.
//!
//! Rows are generated on first use and must be the editor's bytes: every value
//! is computed as the editor computes it, in `f64` with V8's trigonometry,
//! exponential and power, and stored in single precision where the editor stores a
//! `Float32Array` (`tests/generators.rs` compares the bytes of every row).
//!
//! Generation never waits for another thread: a row being generated elsewhere
//! is generated again and the first result kept (D7).

use std::f64::consts::PI;
use std::sync::atomic::{AtomicPtr, Ordering};

/// The atlas layout is the draw-list format's (`styk_draw::MATERIAL_*`).
pub const CELL: usize = styk_draw::MATERIAL_CELL as usize;
pub const COLUMNS: usize = styk_draw::MATERIAL_COLUMNS as usize;
pub const LEVELS: usize = styk_draw::MATERIAL_LEVELS as usize;
pub const ROWS: usize = styk_draw::MATERIAL_ROWS as usize;

const TAU: f64 = PI * 2.0;
const PX: f64 = 2.0 / CELL as f64;
const N: usize = CELL * CELL;
const LX: f64 = -0.42;
const LY: f64 = -0.72;
const LZ: f64 = 0.55;

/// One reduced level of a row: `width × height` texels of `[shade × coverage, coverage]`.
#[derive(Clone, Debug, PartialEq)]
pub struct Level {
    pub width: usize,
    pub height: usize,
    pub data: Vec<u8>,
}

/// One material row: its full-size strip and three reduced levels.
#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub index: usize,
    pub levels: Vec<Level>,
}

fn clamp(v: f64, a: f64, b: f64) -> f64 {
    if v < a {
        a
    } else if v > b {
        b
    } else {
        v
    }
}

fn mix(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

fn len(x: f64, y: f64) -> f64 {
    (x * x + y * y).sqrt()
}

fn sstep(a: f64, b: f64, x: f64) -> f64 {
    let t = clamp((x - a) / (b - a), 0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Coverage of a signed distance in cell units (negative inside), one texel wide.
fn aa(d: f64) -> f64 {
    clamp(0.5 - d / PX, 0.0, 1.0)
}

fn sin(x: f64) -> f64 {
    styk_math::sin(x)
}

fn cos(x: f64) -> f64 {
    styk_math::cos(x)
}

fn atan2(y: f64, x: f64) -> f64 {
    styk_math::atan2(y, x)
}

fn exp(x: f64) -> f64 {
    styk_math::exp(x)
}

fn pow(x: f64, y: f64) -> f64 {
    styk_math::pow(x, y)
}

fn sign(x: f64) -> f64 {
    if x > 0.0 {
        1.0
    } else if x < 0.0 {
        -1.0
    } else {
        x
    }
}

fn js_round(x: f64) -> f64 {
    crate::vfx::paint::js_round(x)
}

/// `random(seed)`: mulberry32.
struct Random(u32);

impl Random {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b79f5);
        let s = self.0;
        let mut t = (s ^ (s >> 15)).wrapping_mul(1 | s);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
        (t ^ (t >> 14)) as f64 / 4294967296.0
    }
}

fn int32(n: f64) -> u32 {
    (n as i64) as u32
}

fn hash2(x: f64, y: f64, s: f64) -> f64 {
    let mut h = int32(x).wrapping_mul(374761393).wrapping_add(int32(y).wrapping_mul(668265263)).wrapping_add(int32(s).wrapping_mul(-2048144789i32 as u32));
    h = (h ^ (h >> 13)).wrapping_mul(1274126177);
    h ^= h >> 16;
    h as f64 / 4294967296.0
}

fn noise(x: f64, y: f64, s: f64) -> f64 {
    let (ix, iy) = (x.floor(), y.floor());
    let (fx, fy) = (x - ix, y - iy);
    let (ux, uy) = (fx * fx * (3.0 - 2.0 * fx), fy * fy * (3.0 - 2.0 * fy));
    let (a, b, c, d) = (hash2(ix, iy, s), hash2(ix + 1.0, iy, s), hash2(ix, iy + 1.0, s), hash2(ix + 1.0, iy + 1.0, s));
    a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy
}

fn fbm(mut x: f64, mut y: f64, s: f64, octaves: u32) -> f64 {
    let (mut sum, mut amp, mut norm) = (0.0, 0.5, 0.0);
    for i in 0..octaves {
        sum += noise(x, y, s + i as f64 * 101.0) * amp;
        norm += amp;
        x = x * 2.03 + 17.1;
        y = y * 2.03 - 9.7;
        amp *= 0.5;
    }
    sum / norm
}

fn segment(px: f64, py: f64, ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    let (dx, dy) = (bx - ax, by - ay);
    let denominator = dx * dx + dy * dy;
    let t = clamp(((px - ax) * dx + (py - ay) * dy) / if denominator == 0.0 || denominator.is_nan() { 1.0 } else { denominator }, 0.0, 1.0);
    let (x, y) = (px - ax - dx * t, py - ay - dy * t);
    (x * x + y * y).sqrt()
}

/// Signed distance to a closed polygon `[x0, y0, x1, y1, …]`.
fn polygon(px: f64, py: f64, pts: &[f64]) -> f64 {
    let mut d = f64::INFINITY;
    let mut inside = false;
    let mut j = pts.len() - 2;
    let mut i = 0;
    while i < pts.len() {
        let (ax, ay, bx, by) = (pts[j], pts[j + 1], pts[i], pts[i + 1]);
        let q = segment(px, py, ax, ay, bx, by);
        if q < d {
            d = q;
        }
        if (ay > py) != (by > py) && px < (bx - ax) * (py - ay) / (by - ay) + ax {
            inside = !inside;
        }
        j = i;
        i += 2;
    }
    if inside { -d } else { d }
}

/// Nearest distance to discs packed as `[x, y, radius, …]`.
fn discs(u: f64, v: f64, c: &[f64]) -> f64 {
    let mut d = f64::INFINITY;
    for k in c.as_chunks::<3>().0 {
        let (x, y) = (u - k[0], v - k[1]);
        let q = (x * x + y * y).sqrt() - k[2];
        if q < d {
            d = q;
        }
    }
    d
}

/// Smooth noise on a coarse grid, bilinearly expanded to one value per texel.
fn noise_grid(scale_x: f64, scale_y: f64, ox: f64, oy: f64, seed: f64, octaves: u32) -> Vec<f32> {
    const G: usize = CELL / 2 + 1;
    let mut g = vec![0f32; G * G];
    for j in 0..G {
        for i in 0..G {
            g[j * G + i] = fbm((i as f64 / (G - 1) as f64 * 2.0 - 1.0) * scale_x + ox, (j as f64 / (G - 1) as f64 * 2.0 - 1.0) * scale_y + oy, seed, octaves) as f32;
        }
    }
    let mut out = vec![0f32; N];
    let mut i = 0;
    for j in 0..CELL {
        let y = (j as f64 + 0.5) / 2.0;
        let iy = (G - 2).min(y as usize);
        let fy = y - iy as f64;
        for x in 0..CELL {
            let xx = (x as f64 + 0.5) / 2.0;
            let ix = (G - 2).min(xx as usize);
            let fx = xx - ix as f64;
            let o = iy * G + ix;
            out[i] = mix(mix(g[o] as f64, g[o + 1] as f64, fx), mix(g[o + G] as f64, g[o + G + 1] as f64, fx), fy) as f32;
            i += 1;
        }
    }
    out
}

/// Cell coordinates of texel centres, -1 to 1 (`U`, a `Float32Array`).
fn coordinates() -> [f64; CELL] {
    let mut u = [0.0; CELL];
    for (i, v) in u.iter_mut().enumerate() {
        *v = ((i as f64 + 0.5) / CELL as f64 * 2.0 - 1.0) as f32 as f64;
    }
    u
}

fn edge_fade(u: f64, v: f64) -> f64 {
    1.0 - sstep(0.9, 0.98, u.abs().max(v.abs()))
}

/// Coverage and shading of one cell, as the painters write them (`Float32Array`s).
struct Cell {
    a: Vec<f32>,
    s: Vec<f32>,
}

/// Visits every texel with its column, row and index.
fn each(mut f: impl FnMut(usize, usize, usize)) {
    let mut i = 0;
    for j in 0..CELL {
        for x in 0..CELL {
            f(x, j, i);
            i += 1;
        }
    }
}

/// Crisp shapes: coverage from a signed-distance grid, then toon shading with
/// a shadow crescent away from the light and highlight spots.
fn toon(c: &mut Cell, d: &[f32], shadow: f64, offset: f64, highlights: &[f64]) {
    let u = &coordinates();
    let dx = js_round(-LX * offset * 1.3 / PX) as i64;
    let dy = js_round(-LY * offset / PX) as i64;
    each(|x, j, i| {
        let a = aa(d[i] as f64);
        c.a[i] = a as f32;
        if a <= 0.0 {
            return;
        }
        let (sx, sy) = (x as i64 + dx, j as i64 + dy);
        let dd = if sx < CELL as i64 && sy < CELL as i64 { d[sy as usize * CELL + sx as usize] as f64 } else { 1.0 };
        let dark = clamp(0.5 + dd / PX, 0.0, 1.0);
        let (uu, vv) = (u[x], u[j]);
        let mut s = mix(0.5, shadow, dark);
        for h in highlights.as_chunks::<3>().0 {
            s = mix(s, 0.76, aa(len(uu - h[0], vv - h[1]) - h[2]) * (1.0 - dark));
        }
        c.s[i] = s as f32;
    });
}

fn paint_smoke(k: usize, r: &mut Random, c: &mut Cell) {
    // Soft union of billowing lobes with noisy edges, lit from the lobes' shape.
    let u = &coordinates();
    let mut lobes = vec![0.0, 0.06, 0.56 + r.next() * 0.08];
    let n = 4 + (r.next() * 3.0).floor() as usize;
    for _ in 0..n {
        let a = r.next() * TAU;
        let d = 0.22 + r.next() * 0.2;
        let rad = 0.34 + r.next() * 0.16;
        let (x, y) = (cos(a) * d, sin(a) * d * 0.8 - 0.02);
        let f = 1.0f64.min((0.84 - rad) / len(x, y).max(1e-3));
        lobes.extend_from_slice(&[x * f, y * f, rad]);
    }
    let kf = k as f64;
    let (mut dd, mut ff) = (vec![0f32; N], vec![0f32; N]);
    let detail = noise_grid(2.0, 2.0, kf * 3.1, -kf * 1.7, kf * 977.0 + 11.0, 4);
    each(|x, j, i| {
        let (uu, vv) = (u[x], u[j]);
        let mut keep = 1.0;
        for l in lobes.as_chunks::<3>().0 {
            let (du, dv) = (uu - l[0], vv - l[1]);
            let q = 1.0 - (du * du + dv * dv) / (l[2] * l[2]);
            if q > 0.0 {
                keep *= 1.0 - q;
            }
        }
        let base = 1.0 - keep;
        let nn = detail[i] as f64;
        dd[i] = (base + (nn - 0.5) * 0.8 * sstep(0.0, 0.35, base)) as f32;
        ff[i] = (base + (nn - 0.5) * 0.25) as f32;
    });
    each(|x, j, i| {
        let (uu, vv) = (u[x], u[j]);
        let nn = detail[i] as f64;
        let a = sstep(0.02, 0.62, dd[i] as f64) * (1.0 - sstep(0.84, 0.97, len(uu, vv))) * (0.74 + 0.26 * sstep(0.3, 0.7, nn));
        c.a[i] = a as f32;
        if a <= 0.0 {
            return;
        }
        let gx = ff[i + usize::from(x < CELL - 1)] as f64 - ff[i - usize::from(x > 0)] as f64;
        let gy = ff[i + if j < CELL - 1 { CELL } else { 0 }] as f64 - ff[i - if j > 0 { CELL } else { 0 }] as f64;
        let (nx, ny) = (-gx * CELL as f64 / 14.0, -gy * CELL as f64 / 14.0);
        let lambert = ((nx * LX + ny * LY + LZ) / (nx * nx + ny * ny + 1.0).sqrt()).max(0.0);
        c.s[i] = clamp(0.34 + 0.36 * lambert - 0.08 * vv + 0.1 * (nn - 0.5) - 0.06 * sstep(0.6, 1.2, dd[i] as f64), 0.0, 1.0) as f32;
    });
}

fn paint_cloud(_k: usize, r: &mut Random, c: &mut Cell) {
    // Cartoon cloud: overlapping circles with a crisp edge and cel shading.
    let u = &coordinates();
    let mut cc = vec![0.0, 0.14, 0.44 + r.next() * 0.05];
    let n = 3 + (r.next() * 3.0).floor() as usize;
    for i in 0..n {
        let a = -PI * (0.05 + r.next() * 0.9) + if i % 2 == 1 { 0.0 } else { PI * 0.12 };
        let d = 0.28 + r.next() * 0.18;
        let rad = 0.24 + r.next() * 0.15;
        let (x, y) = (cos(a) * d, sin(a) * d * 0.9 + 0.08);
        let s = 1.0f64.min((0.92 - rad) / len(x, y));
        cc.extend_from_slice(&[x * s, y * s, rad]);
    }
    let mut lights = Vec::new();
    for i in (0..9).step_by(3) {
        lights.extend_from_slice(&[cc[i] - cc[i + 2] * 0.36, cc[i + 1] - cc[i + 2] * 0.42, cc[i + 2] * 0.22]);
    }
    let mut d = vec![0f32; N];
    each(|x, j, i| d[i] = discs(u[x], u[j], &cc) as f32);
    toon(c, &d, 0.28, 0.11, &lights);
}

fn paint_flame(k: usize, _r: &mut Random, c: &mut Cell) {
    let u = &coordinates();
    let kf = k as f64;
    let tongues: &[f64] = if k >= 5 { &[-0.16, 0.9, 1.0, 0.2, 0.72, 0.8] } else { &[0.0, 1.0, 1.0] };
    let ragged = noise_grid(3.4, 2.1, kf, -kf * 0.7, kf * 631.0 + 6.0, 4);
    let mut sways: Vec<Vec<f32>> = Vec::new();
    for t in tongues.as_chunks::<3>().0 {
        let mut s = vec![0f32; 65];
        for (q, value) in s.iter_mut().enumerate() {
            let h = q as f64 / 64.0;
            *value = ((fbm(h * 1.7 + kf * 2.3, kf * 5.1 + t[0] * 9.0, kf * 631.0 + 5.0, 3) - 0.5) * 0.75 * pow(h, 1.5)) as f32;
        }
        sways.push(s);
    }
    each(|x, j, i| {
        let (uu, vv) = (u[x], u[j]);
        let mut d = -1.0f64;
        for (ti, t) in tongues.as_chunks::<3>().0.iter().enumerate() {
            let h = (0.86 - vv) / (1.76 * t[1]);
            if !(0.0..=1.0).contains(&h) {
                continue;
            }
            let w = 0.44 * t[2] * if h < 0.28 { (1.0 - ((0.28 - h) / 0.28) * ((0.28 - h) / 0.28)).max(0.0).sqrt() } else { pow(1.0 - (h - 0.28) / 0.72, 0.85) };
            let sway = sways[ti][js_round(h * 64.0) as usize] as f64;
            d = d.max(1.0 - (uu - t[0] - sway).abs() / w.max(1e-3));
        }
        d += (ragged[i] as f64 - 0.5) * 0.75;
        c.a[i] = (sstep(0.0, 0.42, d) * (1.0 - sstep(0.9, 0.98, uu.abs()))) as f32;
        c.s[i] = (0.5 + 0.5 * sstep(0.2, 0.95, d) * (1.0 - 0.55 * sstep(0.2, 1.0, -vv))) as f32;
    });
}

fn paint_toon_flame(k: usize, r: &mut Random, c: &mut Cell) {
    // Hard-edged cartoon flame licks with a lighter inner core.
    let u = &coordinates();
    let mut licks = Vec::new();
    let n = if k < 4 { 1 } else { 2 + (k & 1) };
    for i in 0..n {
        if i == 0 {
            let x = (r.next() - 0.5) * 0.12;
            licks.extend_from_slice(&[x, 1.0, 1.0, r.next() * 10.0]);
        } else {
            let x = (r.next() - 0.5) * 0.5;
            let height = 0.55 + r.next() * 0.25;
            let width = 0.55 + r.next() * 0.3;
            licks.extend_from_slice(&[x, height, width, r.next() * 10.0]);
        }
    }
    let field = |uu: f64, vv: f64, inner: bool| -> f64 {
        let mut e = f64::NEG_INFINITY;
        for l in licks.as_chunks::<4>().0 {
            let h = (0.86 - vv) / (1.76 * l[1]);
            if !(0.0..=1.0).contains(&h) {
                continue;
            }
            let sway = sin(h * 3.2 + l[3]) * 0.12 * pow(h, 1.3);
            let w = 0.42 * l[2] * if inner { 0.52 } else { 1.0 } * if h < 0.26 { (1.0 - ((0.26 - h) / 0.26) * ((0.26 - h) / 0.26)).max(0.0).sqrt() } else { pow(1.0 - (h - 0.26) / 0.74, if inner { 1.3 } else { 0.9 }) };
            e = e.max(w - (uu - l[0] - sway * if inner { 0.8 } else { 1.0 }).abs());
        }
        e
    };
    each(|x, j, i| {
        let (uu, vv) = (u[x], u[j]);
        c.a[i] = aa(-field(uu, vv, false)) as f32;
        if c.a[i] > 0.0 {
            c.s[i] = mix(0.5, 0.82, aa(-field(uu, vv + 0.1, true))) as f32;
        }
    });
}

fn paint_star(k: usize, _r: &mut Random, c: &mut Cell) {
    let u = &coordinates();
    let points = [4.0, 4.0, 6.0, 8.0, 4.0, 6.0, 5.0, 8.0][k];
    let sharp = [8.0, 14.0, 10.0, 12.0, 22.0, 16.0, 9.0, 18.0][k];
    let offset = if k == 2 || k == 5 { PI / 6.0 } else { 0.0 };
    let reach = [0.92, 0.95, 0.8, 0.88, 0.95, 0.72, 0.85, 0.9][k];
    each(|x, j, i| {
        let (uu, vv) = (u[x], u[j]);
        let rr = len(uu, vv);
        let a = atan2(vv, uu) + offset;
        let mut spikes = pow(cos(a * points / 2.0).abs(), sharp);
        if points == 8.0 {
            spikes = pow(cos(a * 2.0).abs(), sharp).max(0.55 * pow(sin(a * 2.0).abs(), sharp));
        }
        let core = exp(-(rr * rr) / 0.0144);
        let ray = pow((1.0 - rr / (reach * mix(0.1, 1.0, spikes))).max(0.0), 2.2) * pow(spikes, 0.35);
        let glow = exp(-rr * 6.0) * 0.5;
        c.a[i] = (clamp(core + ray + glow, 0.0, 1.0) * (1.0 - sstep(0.9, 0.98, rr))) as f32;
        c.s[i] = (0.5 + 0.5 * clamp(core * 1.3 + ray * 0.5, 0.0, 1.0)) as f32;
    });
}

fn paint_bokeh(k: usize, r: &mut Random, c: &mut Cell) {
    let u = &coordinates();
    let hex = k >= 5;
    let rim = 0.25 + r.next() * 0.55;
    let grain = noise_grid(3.0, 3.0, 0.0, 0.0, k as f64 * 37.0 + 2.0, 3);
    each(|x, j, i| {
        let (uu, vv) = (u[x], u[j]);
        let q = if hex { (uu.abs() * 0.866 + vv.abs() * 0.5).max(vv.abs()) - 0.74 } else { len(uu, vv) - 0.8 };
        let edge = clamp(0.5 - q / (PX * 2.5), 0.0, 1.0);
        let ring = exp(-q.abs() / 0.07) * rim;
        c.a[i] = clamp(edge * (0.55 + 0.12 * (grain[i] as f64 - 0.5)) + ring * edge * 0.6, 0.0, 1.0) as f32;
        c.s[i] = (0.5 + 0.4 * ring) as f32;
    });
}

fn paint_wisp(k: usize, r: &mut Random, c: &mut Cell) {
    // Tapered crescents: [radius, half angle, scale] per arc.
    let u = &coordinates();
    let mut arcs = vec![0.55 + r.next() * 0.3, 1.0 + r.next() * 0.6, 1.0];
    if k >= 4 {
        let a = 0.4 + r.next() * 0.25;
        let b = 0.9 + r.next() * 0.5;
        arcs.extend_from_slice(&[a, b, 0.7]);
    }
    let grain = noise_grid(4.0, 4.0, k as f64, 0.0, k as f64 * 13.0 + 7.0, 3);
    each(|x, j, i| {
        let (uu, vv) = (u[x], u[j]);
        let (mut a, mut s) = (0.0f64, 0.5f64);
        for arc in arcs.as_chunks::<3>().0 {
            let (radius, half, scale) = (arc[0], arc[1], arc[2]);
            let dy = vv - (radius - 0.45 * scale);
            let t = atan2(uu, -dy) / half * 0.5 + 0.5;
            if !(0.0..=1.0).contains(&t) {
                continue;
            }
            let th = (0.16 * scale * pow(sin(PI * t), 0.7) * (1.0 - 0.35 * t)).max(1e-3);
            let q = (len(uu, dy) - radius).abs() / th;
            let cov = exp(-q * q * 2.2) * (0.65 + 0.35 * grain[i] as f64);
            if cov > a {
                a = cov;
                s = 0.5 + 0.3 * exp(-q * q * 6.0);
            }
        }
        c.a[i] = (a * edge_fade(uu, vv)) as f32;
        c.s[i] = s as f32;
    });
}

fn paint_bolt(_k: usize, r: &mut Random, c: &mut Cell) {
    // A jagged main strike with a few forks; the core is white-hot.
    let u = &coordinates();
    let mut main = vec![-0.86, (r.next() - 0.5) * 0.3];
    let n = 7 + (r.next() * 3.0).floor() as usize;
    for i in 1..=n {
        let x = -0.86 + 1.72 * i as f64 / n as f64;
        let y = if i == n { (r.next() - 0.5) * 0.3 } else { (r.next() - 0.5) * 0.55 };
        main.extend_from_slice(&[x, y]);
    }
    let count = main.len() / 2;
    let mut lines = Vec::new();
    for i in 0..count - 1 {
        lines.extend_from_slice(&[main[i * 2], main[i * 2 + 1], main[i * 2 + 2], main[i * 2 + 3], 0.034 * (1.0 - 0.4 * i as f64 / count as f64)]);
    }
    let forks = 1 + (r.next() * 2.0).floor() as usize;
    for _ in 0..forks {
        let at = 2 + (r.next() * (count - 4) as f64).floor() as usize;
        let (mut x, mut y) = (main[at * 2], main[at * 2 + 1]);
        let side = if r.next() > 0.5 { 1.0 } else { -1.0 };
        let dir = side * (0.5 + r.next() * 0.6);
        for s in 0..3 {
            let nx = clamp(x + 0.14 + r.next() * 0.12, -0.9, 0.9);
            let ny = clamp(y + dir * (0.08 + r.next() * 0.12), -0.88, 0.88);
            lines.extend_from_slice(&[x, y, nx, ny, 0.02 * (1.0 - s as f64 / 3.0)]);
            x = nx;
            y = ny;
        }
    }
    each(|x, j, i| {
        let (uu, vv) = (u[x], u[j]);
        let (mut core, mut d) = (0.0f64, f64::INFINITY);
        for l in lines.as_chunks::<5>().0 {
            let q = segment(uu, vv, l[0], l[1], l[2], l[3]);
            if q < d {
                d = q;
            }
            let cv = aa(q - l[4]);
            if cv > core {
                core = cv;
            }
        }
        c.a[i] = (clamp(core + exp(-d / 0.06) * 0.55 + exp(-d / 0.2) * 0.18, 0.0, 1.0) * edge_fade(uu, vv)) as f32;
        c.s[i] = (0.5 + 0.5 * core) as f32;
    });
}

fn paint_shard(_k: usize, r: &mut Random, c: &mut Cell) {
    let u = &coordinates();
    let n = 3 + (r.next() * 3.0).floor() as usize;
    let mut angles: Vec<f64> = (0..n).map(|i| (i as f64 + 0.2 + r.next() * 0.6) / n as f64 * TAU).collect();
    angles.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let stretch = 0.45 + r.next() * 0.35;
    let mut pts = Vec::new();
    for a in &angles {
        let rad = 0.5 + r.next() * 0.38;
        pts.extend_from_slice(&[cos(*a) * rad * stretch, sin(*a) * rad]);
    }
    let cut = r.next() * TAU;
    let (cx, cy) = (cos(cut), sin(cut));
    each(|x, j, i| {
        let (uu, vv) = (u[x], u[j]);
        let d = polygon(uu, vv, &pts);
        c.a[i] = aa(d) as f32;
        if c.a[i] > 0.0 {
            c.s[i] = ((if uu * cx + vv * cy > 0.0 { 0.66 } else { 0.36 }) + (if -d < 0.07 { 0.14 } else { 0.0 }) + (uu * LX + vv * LY) * 0.1) as f32;
        }
    });
}

fn paint_rock(k: usize, r: &mut Random, c: &mut Cell) {
    let u = &coordinates();
    let n = 7 + (r.next() * 3.0).floor() as usize;
    let mut pts = Vec::new();
    for i in 0..n {
        let a = (i as f64 + r.next() * 0.5) / n as f64 * TAU;
        let rad = 0.55 + r.next() * 0.28;
        pts.extend_from_slice(&[cos(a) * rad, sin(a) * rad * 0.85]);
    }
    let grain = noise_grid(4.0, 4.0, 0.0, 0.0, k as f64 * 71.0 + 9.0, 4);
    each(|x, j, i| {
        let (uu, vv) = (u[x], u[j]);
        let d = polygon(uu, vv, &pts);
        c.a[i] = aa(d) as f32;
        if c.a[i] <= 0.0 {
            return;
        }
        let (nx, ny) = (uu / 0.8, vv / 0.8);
        let nz = (1.0 - nx * nx - ny * ny).max(0.0).sqrt();
        c.s[i] = clamp(0.2 + 0.5 * (nx * LX + ny * LY + nz * LZ).max(0.0) + 0.22 * (grain[i] as f64 - 0.5) - if -d < 0.05 { 0.08 } else { 0.0 }, 0.0, 1.0) as f32;
    });
}

fn paint_leaf(_k: usize, r: &mut Random, c: &mut Cell) {
    let u = &coordinates();
    let bend = (r.next() - 0.5) * 0.5;
    let width = 0.22 + r.next() * 0.1;
    let radius = 0.9;
    let dd = radius - width;
    let b = (radius * radius - dd * dd).sqrt();
    let veins = 4.0 + (r.next() * 3.0).floor();
    each(|x, j, i| {
        let (uu, vv) = (u[x], u[j]);
        let bx = uu + bend * vv * vv;
        let (ax, ay) = (bx.abs(), (vv + 0.06).abs());
        let shape = if (ay - b) * dd > ax * b { len(ax, ay - b) } else { len(ax + dd, ay) - radius };
        let stem = segment(uu, vv, -bend * (b - 0.14) * (b - 0.14), b - 0.14, 0.03 - bend * 0.85, 0.92) - 0.022;
        let d = shape.min(stem);
        c.a[i] = aa(d) as f32;
        if c.a[i] <= 0.0 {
            return;
        }
        let vein = ax < 0.018 || (((vv + 0.06) * veins + ax * 3.2) % 1.0 - 0.5).abs() > 0.44 && ax < width * 0.8;
        c.s[i] = if stem < 0.0 {
            0.4
        } else if vein {
            0.66
        } else if bx > 0.0 {
            0.42
        } else {
            0.54
        };
    });
}

fn paint_petal(_k: usize, r: &mut Random, c: &mut Cell) {
    let u = &coordinates();
    let radius = 0.42 + r.next() * 0.08;
    let (cy, tip) = (-0.12, 0.86);
    let lean = (r.next() - 0.5) * 0.3;
    let notch = 0.1 + r.next() * 0.07;
    each(|x, j, i| {
        let (uu, vv) = (u[x], u[j]);
        // Beyond the round top and the tip the width is zero: measure to those points instead.
        let lx = uu - lean * (vv - cy);
        let w = if vv < cy { (radius * radius - (vv - cy) * (vv - cy)).max(0.0).sqrt() } else { radius * pow((1.0 - (vv - cy) / (tip - cy)).max(0.0), 1.15) };
        let d = if vv < cy - radius {
            len(lx, vv - cy + radius)
        } else if vv > tip {
            len(lx, vv - tip)
        } else {
            lx.abs() - w
        };
        let a = aa(d) * aa(notch - len(lx, vv - (cy - radius - 0.02)));
        c.a[i] = a as f32;
        if a > 0.0 {
            c.s[i] = (mix(0.48, 0.72, sstep(cy, tip, vv)) - if -d < 0.05 { 0.06 } else { 0.0 }) as f32;
        }
    });
}

fn paint_flake(k: usize, r: &mut Random, c: &mut Cell) {
    let u = &coordinates();
    let mut branches = Vec::new();
    let n = 2 + (r.next() * 2.0).floor() as usize;
    for i in 0..n {
        let a = 0.28 + i as f64 * 0.18 + r.next() * 0.06;
        let b = 0.1 + r.next() * 0.12;
        branches.extend_from_slice(&[a, b]);
    }
    let plate = if k >= 6 { 0.16 } else { 0.0 };
    let th = 0.036 + r.next() * 0.014;
    let sector = PI / 3.0;
    each(|x, j, i| {
        let (uu, vv) = (u[x], u[j]);
        let rr = len(uu, vv);
        let a = atan2(vv, uu);
        let f = (a - sector * js_round(a / sector)).abs();
        let (fx, fy) = (rr * cos(f), rr * sin(f));
        let mut d = segment(fx, fy, 0.0, 0.0, 0.82, 0.0) - th;
        for b in branches.as_chunks::<2>().0 {
            d = d.min(segment(fx, fy, b[0], 0.0, b[0] + b[1] * 0.5, b[1] * 0.866) - th * 0.8);
        }
        if plate != 0.0 {
            d = d.min(rr * cos(PI / 6.0 - f) - plate * 0.866);
        }
        c.a[i] = (clamp(aa(d) + exp(-d.max(0.0) / 0.05) * 0.22, 0.0, 1.0) * (1.0 - sstep(0.9, 0.98, rr))) as f32;
        c.s[i] = (0.62 + 0.26 * aa(d + th * 0.5)) as f32;
    });
}

fn paint_drop(_k: usize, r: &mut Random, c: &mut Cell) {
    // Round leading head (cell top) with a trailing tail toward the cell bottom.
    let u = &coordinates();
    let radius = 0.36 + r.next() * 0.06;
    let cy = -0.3;
    let tail = 0.62 + r.next() * 0.28;
    each(|x, j, i| {
        let (uu, vv) = (u[x], u[j]);
        let w = if vv < cy { (radius * radius - (vv - cy) * (vv - cy)).max(0.0).sqrt() } else { radius * pow((1.0 - (vv - cy) / (tail - cy)).max(0.0), 1.5) };
        let d = if vv < cy - radius {
            len(uu, vv - cy + radius)
        } else if vv > tail {
            len(uu, vv - tail)
        } else {
            uu.abs() - w
        };
        c.a[i] = aa(d) as f32;
        if c.a[i] <= 0.0 {
            return;
        }
        c.s[i] = mix(clamp(0.5 - 0.22 * sstep(-0.2, 0.4, uu / radius) + 0.1 * sstep(0.2, 0.8, -uu / radius) * sstep(cy, tail, vv), 0.0, 1.0), 0.95, aa(len(uu + radius * 0.36, vv - cy + radius * 0.38) - radius * 0.2)) as f32;
    });
}

fn paint_splat(_k: usize, r: &mut Random, c: &mut Cell) {
    let u = &coordinates();
    let lobes = 5.0 + (r.next() * 4.0).floor();
    let phase = r.next() * TAU;
    let mut spikes = Vec::new();
    let n = 2 + (r.next() * 3.0).floor() as usize;
    for _ in 0..n {
        let a = r.next() * TAU;
        let l = 0.52 + r.next() * 0.22;
        let t = 0.045 + r.next() * 0.035;
        spikes.extend_from_slice(&[cos(a) * l, sin(a) * l, t, l]);
    }
    let mut drops = Vec::new();
    let n = 5 + (r.next() * 5.0).floor() as usize;
    for _ in 0..n {
        let a = r.next() * TAU;
        let l = 0.56 + r.next() * 0.3;
        let rad = 0.025 + r.next() * 0.05;
        let s = 1.0f64.min((0.92 - rad) / l);
        drops.extend_from_slice(&[cos(a) * l * s, sin(a) * l * s, rad]);
    }
    let sdf = |uu: f64, vv: f64| -> f64 {
        let a = atan2(vv, uu);
        let rr = len(uu, vv);
        let mut d = rr - (0.34 + 0.06 * sin(a * lobes + phase) + 0.03 * sin(a * (lobes + 3.0) - phase * 2.0));
        for s in spikes.as_chunks::<4>().0 {
            let (x, y, t) = (s[0], s[1], s[2]);
            d = d.min(segment(uu, vv, 0.0, 0.0, x, y) - t * (1.0 - 0.4 * rr / s[3])).min(len(uu - x, vv - y) - t * 1.5);
        }
        d.min(discs(uu, vv, &drops))
    };
    let mut d = vec![0f32; N];
    each(|x, j, i| d[i] = sdf(u[x], u[j]) as f32);
    toon(c, &d, 0.4, 0.06, &[-0.12, -0.14, 0.08]);
}

fn paint_burst(_k: usize, r: &mut Random, c: &mut Cell) {
    // Comic starburst with a lighter inner band. It is star-shaped around its
    // centre, so inside means closer than the outline along the same ray.
    let u = &coordinates();
    let n = 9 + (r.next() * 7.0).floor() as usize;
    let m = n * 2;
    let step = TAU / m as f64;
    let mut v = vec![0.0f64; m * 2];
    let mut ang = vec![0.0f64; m + 1];
    for i in 0..m {
        let a = (i as f64 + (r.next() - 0.5) * 0.35) * step;
        let rad = if i % 2 == 1 { 0.38 + r.next() * 0.12 } else { 0.72 + r.next() * 0.22 };
        ang[i] = a;
        v[i * 2] = cos(a) * rad;
        v[i * 2 + 1] = sin(a) * rad;
    }
    ang[m] = ang[0] + TAU;
    let edge = |uu: f64, vv: f64, scale: f64| -> f64 {
        let mut a = (atan2(vv, uu) + TAU) % TAU;
        if a < ang[0] {
            a += TAU;
        }
        let mut e = (m - 1).min((a / step).floor() as usize);
        while e > 0 && a < ang[e] {
            e -= 1;
        }
        while e < m - 1 && a >= ang[e + 1] {
            e += 1;
        }
        let (p, q) = (e, (e + 1) % m);
        let (px, py) = (v[p * 2], v[p * 2 + 1]);
        let (ex, ey) = (v[q * 2] - px, v[q * 2 + 1] - py);
        let (dx, dy) = (cos(a), sin(a));
        let reach = (px * ey - py * ex) / (dx * ey - dy * ex) * scale;
        let mut d = f64::INFINITY;
        for o in -1i64..=1 {
            let s0 = ((e as i64 + o) % m as i64 + m as i64) as usize % m;
            let s1 = (s0 + 1) % m;
            let s = segment(uu, vv, v[s0 * 2] * scale, v[s0 * 2 + 1] * scale, v[s1 * 2] * scale, v[s1 * 2 + 1] * scale);
            if s < d {
                d = s;
            }
        }
        if len(uu, vv) < reach { -d } else { d }
    };
    each(|x, j, i| {
        let (uu, vv) = (u[x], u[j]);
        c.a[i] = aa(edge(uu, vv, 1.0)) as f32;
        if c.a[i] > 0.0 {
            c.s[i] = mix(0.5, 0.84, aa(edge(uu, vv, 0.56))) as f32;
        }
    });
}

fn paint_cute(k: usize, _r: &mut Random, c: &mut Cell) {
    let u = &coordinates();
    let mut d = vec![0f32; N];
    let light: [f64; 3];
    if k < 4 {
        // Heart (Inigo Quilez's exact distance), tip down.
        let s = 0.74 + k as f64 * 0.02;
        let tilt = (k as f64 - 1.5) * 0.08;
        let (cu, su) = (cos(tilt), sin(tilt));
        light = [-0.3, -0.3, 0.1];
        let sdf = |uu: f64, vv: f64| -> f64 {
            let x = ((uu * cu - vv * su) * s).abs();
            let y = (0.72 - (uu * su + vv * cu)) * s;
            if y + x > 1.0 {
                return (len(x - 0.25, y - 0.75) - std::f64::consts::SQRT_2 / 4.0) / s;
            }
            let m = 0.5 * (x + y).max(0.0);
            (x * x + (y - 1.0) * (y - 1.0)).min((x - m) * (x - m) + (y - m) * (y - m)).sqrt() * sign(x - y) / s
        };
        each(|x, j, i| d[i] = sdf(u[x], u[j]) as f32);
    } else {
        // Rounded five-point star (Inigo Quilez's sdStar5).
        let rad = 0.66;
        let rf = 0.48 + (k as f64 - 4.0) * 0.03;
        let (k1x, k1y) = (0.809016994375, -0.587785252292);
        let (bax, bay) = (rf * -k1y, rf * k1x - 1.0);
        let bb = bax * bax + bay * bay;
        light = [-0.16, -0.2, 0.1];
        let sdf = |uu: f64, vv: f64| -> f64 {
            let (mut x, mut y) = (uu.abs(), -vv + 0.06);
            let mut dd = (k1x * x + k1y * y).max(0.0);
            x -= 2.0 * dd * k1x;
            y -= 2.0 * dd * k1y;
            dd = (-k1x * x + k1y * y).max(0.0);
            x += 2.0 * dd * k1x;
            y -= 2.0 * dd * k1y;
            x = x.abs();
            y -= rad;
            let h = clamp((x * bax + y * bay) / bb, 0.0, rad);
            len(x - bax * h, y - bay * h) * sign(y * bax - x * bay) - 0.07
        };
        each(|x, j, i| d[i] = sdf(u[x], u[j]) as f32);
    }
    toon(c, &d, 0.34, 0.1, &light);
}

type Painter = fn(usize, &mut Random, &mut Cell);

const PAINTERS: [Painter; ROWS] = [
    paint_smoke,
    paint_cloud,
    paint_flame,
    paint_toon_flame,
    paint_star,
    paint_bokeh,
    paint_wisp,
    paint_bolt,
    paint_shard,
    paint_rock,
    paint_leaf,
    paint_petal,
    paint_flake,
    paint_drop,
    paint_splat,
    paint_burst,
    paint_cute,
];

/// `atlasRow(row)` computed afresh: the full-size strip of eight cells and its
/// reduced levels, `[shade × coverage, coverage]` per texel.
pub fn generate(row: usize) -> Row {
    let width = CELL * COLUMNS;
    let mut base = vec![0u8; width * CELL * 2];
    let mut cell = Cell { a: vec![0f32; N], s: vec![0f32; N] };
    for k in 0..COLUMNS {
        cell.a.fill(0.0);
        cell.s.fill(0.5);
        let seed = ((row as u32 + 1).wrapping_mul(-1640531535i32 as u32)) ^ ((k as u32 + 1).wrapping_mul(40503));
        PAINTERS[row](k, &mut Random(seed), &mut cell);
        let mut i = 0;
        for y in 0..CELL {
            let mut o = (y * width + k * CELL) * 2;
            for _ in 0..CELL {
                let a = clamp(cell.a[i] as f64, 0.0, 1.0);
                base[o] = (clamp(cell.s[i] as f64, 0.0, 1.0) * a * 255.0 + 0.5) as u8;
                base[o + 1] = (a * 255.0 + 0.5) as u8;
                i += 1;
                o += 2;
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
                let a = ((y * 2) * sw + x * 2) * 2;
                let b = a + sw * 2;
                let o = (y * w + x) * 2;
                data[o] = ((src[a] as u32 + src[a + 2] as u32 + src[b] as u32 + src[b + 2] as u32 + 2) >> 2) as u8;
                data[o + 1] = ((src[a + 1] as u32 + src[a + 3] as u32 + src[b + 1] as u32 + src[b + 3] as u32 + 2) >> 2) as u8;
            }
        }
        levels.push(Level { width: w, height: h, data });
    }
    Row { index: row, levels }
}

/// Rows generated so far in this process, shared by every renderer. A row is
/// published once and kept for the process's life (5.9 MB for all of them).
static GENERATED: [AtomicPtr<Row>; ROWS] = [const { AtomicPtr::new(std::ptr::null_mut()) }; ROWS];

/// The row, if some thread has generated it.
pub fn ready(row: usize) -> Option<&'static Row> {
    let ptr = GENERATED.get(row)?.load(Ordering::Acquire);
    // Published pointers come from `Box::leak` and are never freed.
    (!ptr.is_null()).then(|| unsafe { &*ptr })
}

/// `atlasRow(row)`: the row, generated on first use. A row another thread is
/// still generating is generated here too (never waited for); the first
/// published copy is the one kept.
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

/// `shadeColor`: a material's shading applied to a particle colour. 0.5 keeps
/// it, lower darkens toward a quarter, higher lightens toward white.
pub fn shade(rgb: [f64; 3], s: f64) -> [f64; 3] {
    if s < 0.5 {
        let k = 0.25 + 1.5 * s;
        rgb.map(|c| c * k)
    } else {
        let k = (s - 0.5) * 1.4;
        rgb.map(|c| c + (1.0 - c) * k)
    }
}
