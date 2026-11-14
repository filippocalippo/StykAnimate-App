//! Generated effects on the CPU (`K_PARTICLE`, `K_BEAM`; docs/engine/vfx.md): each
//! record is expanded into the same quad as the GPU's vertex shader (its corners in
//! the draw's local units, then the draw's transform, then the layer's), covered by the
//! GPU's samples, and shaded once a pixel at its centre by the fragment shader's
//! arithmetic (prim.wgsl `particle_color`, `beam_color`), in single precision, then
//! blended over the target. Emissive light is premultiplied colour with less alpha than
//! colour: one blend draws paint and light alike.

use styk_draw::*;
use styk_eval::vfx::generated::atlas;

use crate::coverage::quad;
use crate::frame::Layer;
use crate::shade::invert;
use crate::target::Target;

#[inline]
fn smooth(a: f32, b: f32, x: f32) -> f32 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

#[inline]
fn mix(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

#[inline]
fn len(x: f32, y: f32) -> f32 {
    (x * x + y * y).sqrt()
}

fn pcg(v: u32) -> u32 {
    let s = v.wrapping_mul(747796405).wrapping_add(2891336453);
    let w = ((s >> ((s >> 28) + 4)) ^ s).wrapping_mul(277803737);
    (w >> 22) ^ w
}

fn hash2(x: i32, y: i32) -> f32 {
    pcg((x as u32).wrapping_mul(73856093) ^ (y as u32).wrapping_mul(19349663)) as f32 * (1.0 / 4294967296.0)
}

/// A shape's random number `k` from its seed, 0–1 (`shape_hash` in prim.wgsl).
fn shape_hash(seed: u32, k: u32) -> f32 {
    pcg(seed.wrapping_mul(2654435761).wrapping_add(k.wrapping_mul(40503))) as f32 * (1.0 / 4294967296.0)
}

fn vnoise(x: f32, y: f32) -> f32 {
    let (ix, iy) = (x.floor(), y.floor());
    let (fx, fy) = (x - ix, y - iy);
    let (ux, uy) = (fx * fx * (3.0 - 2.0 * fx), fy * fy * (3.0 - 2.0 * fy));
    let (ix, iy) = (ix as i32, iy as i32);
    mix(mix(hash2(ix, iy), hash2(ix + 1, iy), ux), mix(hash2(ix, iy + 1), hash2(ix + 1, iy + 1), ux), uy)
}

// ---------------------------------------------------------------------------
// Shapes as signed distances in a particle's own units (its radius 1, y down, its
// "front" toward -y), negative inside (`sd_*` in prim.wgsl).
// ---------------------------------------------------------------------------

fn sd_segment(px: f32, py: f32, ax: f32, ay: f32, bx: f32, by: f32) -> f32 {
    let (pax, pay, bax, bay) = (px - ax, py - ay, bx - ax, by - ay);
    let h = ((pax * bax + pay * bay) / (bax * bax + bay * bay).max(1e-12)).clamp(0.0, 1.0);
    len(pax - bax * h, pay - bay * h)
}

fn sd_box(px: f32, py: f32, bx: f32, by: f32) -> f32 {
    let (dx, dy) = (px.abs() - bx, py.abs() - by);
    len(dx.max(0.0), dy.max(0.0)) + dx.max(dy).min(0.0)
}

fn sd_rhombus(px: f32, py: f32, bx: f32, by: f32) -> f32 {
    let (px, py) = (px.abs(), py.abs());
    let ndot = (bx - 2.0 * px) * bx - (by - 2.0 * py) * by;
    let h = (ndot / (bx * bx + by * by)).clamp(-1.0, 1.0);
    let (qx, qy) = (px - 0.5 * bx * (1.0 - h), py - 0.5 * by * (1.0 + h));
    let s = px * by + py * bx - bx * by;
    len(qx, qy) * if s < 0.0 { -1.0 } else { 1.0 }
}

/// A star of `n` points of radius `r`, its points' sharpness `m` (2 is a polygon of sticks, `n` a polygon).
fn sd_star(px: f32, py: f32, r: f32, n: f32, m: f32) -> f32 {
    let an = std::f32::consts::PI / n;
    let en = std::f32::consts::PI / m;
    let (acx, acy) = (an.cos(), an.sin());
    let (ecx, ecy) = (en.cos(), en.sin());
    let a = px.atan2(-py);
    let bn = (a.rem_euclid(2.0 * an)) - an;
    let l = len(px, py);
    let (mut qx, mut qy) = (l * bn.cos(), l * bn.sin().abs());
    qx -= r * acx;
    qy -= r * acy;
    let t = (-(qx * ecx + qy * ecy)).clamp(0.0, r * acy / ecy);
    qx += ecx * t;
    qy += ecy * t;
    len(qx, qy) * if qx < 0.0 { -1.0 } else { 1.0 }
}

fn sd_uneven_capsule(px: f32, py: f32, r1: f32, r2: f32, h: f32) -> f32 {
    let px = px.abs();
    let b = (r1 - r2) / h;
    let a = (1.0 - b * b).max(0.0).sqrt();
    let k = -b * px + a * py;
    if k < 0.0 {
        return len(px, py) - r1;
    }
    if k > a * h {
        return len(px, py - h) - r2;
    }
    a * px + b * py - r1
}

fn sd_heart(px: f32, py: f32) -> f32 {
    let px = px.abs();
    if py + px > 1.0 {
        return len(px - 0.25, py - 0.75) - std::f32::consts::SQRT_2 / 4.0;
    }
    let a = (px * px + (py - 1.0) * (py - 1.0)).sqrt();
    let s = 0.5 * (px + py).max(0.0);
    let b = len(px - s, py - s);
    a.min(b) * if px - py < 0.0 { -1.0 } else { 1.0 }
}

fn sd_vesica(px: f32, py: f32, r: f32, d: f32) -> f32 {
    let (px, py) = (px.abs(), py.abs());
    let b = (r * r - d * d).max(0.0).sqrt();
    if (py - b) * d > px * b { len(px, py - b) } else { len(px + d, py) - r }
}

fn sd_triangle(px: f32, py: f32, p: [[f32; 2]; 3]) -> f32 {
    let e = [[p[1][0] - p[0][0], p[1][1] - p[0][1]], [p[2][0] - p[1][0], p[2][1] - p[1][1]], [p[0][0] - p[2][0], p[0][1] - p[2][1]]];
    let v = [[px - p[0][0], py - p[0][1]], [px - p[1][0], py - p[1][1]], [px - p[2][0], py - p[2][1]]];
    let s = (e[0][0] * e[2][1] - e[0][1] * e[2][0]).signum();
    let mut d = f32::MAX;
    let mut sg = f32::MAX;
    for i in 0..3 {
        let h = ((v[i][0] * e[i][0] + v[i][1] * e[i][1]) / (e[i][0] * e[i][0] + e[i][1] * e[i][1]).max(1e-12)).clamp(0.0, 1.0);
        let (qx, qy) = (v[i][0] - e[i][0] * h, v[i][1] - e[i][1] * h);
        d = d.min(qx * qx + qy * qy);
        sg = sg.min(s * (v[i][0] * e[i][1] - v[i][1] * e[i][0]));
    }
    -d.sqrt() * sg.signum()
}

/// A polar outline `r(θ)` (rocks, splats, bursts) as an approximate distance.
fn sd_polar(px: f32, py: f32, r: f32) -> f32 {
    len(px, py) - r
}

/// Piecewise-linear radius between `n` seeded corners (rocks: 0.72–1).
fn rock_radius(a: f32, seed: u32, n: u32, lo: f32) -> f32 {
    let t = (a / std::f32::consts::TAU).rem_euclid(1.0) * n as f32;
    let i = t.floor() as u32 % n;
    let f = t - t.floor();
    let r0 = mix(lo, 1.0, shape_hash(seed, i));
    let r1 = mix(lo, 1.0, shape_hash(seed, (i + 1) % n));
    mix(r0, r1, f)
}

fn smin(a: f32, b: f32, k: f32) -> f32 {
    let h = (0.5 + 0.5 * (b - a) / k).clamp(0.0, 1.0);
    mix(b, a, h) - k * h * (1.0 - h)
}

/// The signed distance of particle shape `shape` at `q` (its own units), with its `seed`.
pub(crate) fn shape_distance(shape: u32, qx: f32, qy: f32, seed: u32) -> f32 {
    use std::f32::consts::{PI, TAU};
    match shape {
        P_SQUARE => sd_box(qx, qy, 1.0, 1.0),
        P_RHOMBUS => sd_rhombus(qx, qy, 0.72, 1.0),
        P_STAR => sd_star(qx, qy, 1.0, 5.0, 2.6),
        P_SPARKLE => sd_star(qx, qy, 1.0, 4.0, 2.08),
        P_SPARK => sd_rhombus(qx, qy, 0.2, 1.0),
        P_SHARD => {
            let j = |k: u32| (shape_hash(seed, k) - 0.5) * 0.35;
            sd_triangle(qx, qy, [[0.0 + j(1), -1.0], [0.62 + j(2), 0.75 + j(3)], [-0.55 + j(4), 0.6 + j(5)]])
        }
        P_ROCK => {
            let r = rock_radius(qx.atan2(qy), seed, 7, 0.68);
            sd_polar(qx, qy, r) * 0.9
        }
        P_DROP => sd_uneven_capsule(qx, qy + 0.4, 0.58, 0.04, 1.4),
        P_HEART => sd_heart(qx * 0.82, -qy * 0.82 + 0.6) / 0.82,
        P_BURST => {
            let n = 11.0;
            let a = qx.atan2(-qy) + PI;
            let k = (a / TAU * n).floor() as u32;
            let outer = mix(0.78, 1.0, shape_hash(seed, k));
            sd_star(qx, qy, outer, n, 2.25)
        }
        P_CLOUD => {
            let c = [(-0.48, 0.18, 0.42), (-0.05, -0.18, 0.55), (0.45, 0.08, 0.44), (-0.2, 0.36, 0.38), (0.25, 0.38, 0.36)];
            let mut d = f32::MAX;
            for (cx, cy, r) in c {
                d = smin(d, len(qx - cx, qy - cy) - r, 0.12);
            }
            d.max(qy - 0.62)
        }
        P_FLAKE => {
            // Six arms with side branches: folded into one twelfth of the turn.
            let a = qx.atan2(-qy);
            let sector = PI / 3.0;
            let a = (a.rem_euclid(sector)) - sector / 2.0;
            let r = len(qx, qy);
            let (fx, fy) = (r * a.sin().abs(), r * a.cos());
            let arm = sd_segment(fx, fy, 0.0, 0.0, 0.0, 0.95) - 0.09;
            let side = sd_segment(fx, fy, 0.0, 0.5, 0.3, 0.75) - 0.06;
            arm.min(side).min(len(qx, qy) - 0.2)
        }
        P_PETAL => sd_vesica(qx, qy, 1.0, 0.62),
        P_BOLT => {
            let pts = [(-0.05, -1.0), (0.32, -0.18), (-0.12, -0.02), (0.18, 1.0)];
            let mut d = f32::MAX;
            for k in 0..3 {
                let w = mix(0.2, 0.08, k as f32 / 2.0);
                d = d.min(sd_segment(qx, qy, pts[k].0, pts[k].1, pts[k + 1].0, pts[k + 1].1) - w);
            }
            d
        }
        P_FLAME => {
            // A tongue: round at the bottom, curling to a point at the top.
            let lean = 0.22 * (shape_hash(seed, 1) - 0.5) * 2.0;
            let wx = qx + lean * (1.0 - qy) * (1.0 - qy) * 0.25;
            let body = sd_uneven_capsule(wx, -(qy - 0.42), 0.55, 0.02, 1.35);
            let side = sd_uneven_capsule(wx + 0.32, -(qy - 0.35), 0.24, 0.01, 0.75);
            smin(body, side, 0.1)
        }
        P_SPLAT => {
            let a = qx.atan2(qy);
            let r = 0.68 + 0.14 * (a * 3.0 + shape_hash(seed, 1) * 6.0).sin() + 0.09 * (a * 7.0 + shape_hash(seed, 2) * 6.0).sin();
            let blob = sd_polar(qx, qy, r);
            let k = (shape_hash(seed, 3) * TAU, shape_hash(seed, 4) * TAU);
            let d1 = len(qx - 0.9 * k.0.cos(), qy - 0.9 * k.0.sin()) - 0.12;
            let d2 = len(qx - 0.85 * k.1.cos(), qy - 0.85 * k.1.sin()) - 0.09;
            blob.min(d1).min(d2)
        }
        P_TOON_STAR => sd_star(qx, qy, 0.86, 5.0, 3.3) - 0.12,
        // Discs and bokeh: the unit circle.
        _ => len(qx, qy) - 1.0,
    }
}

/// Coverage at signed distance `d` (shape units): crisp within `px` (a pixel in shape units), or
/// a falloff `soft` deep inside the outline.
#[inline]
fn edge(d: f32, soft: f32, px: f32) -> f32 {
    if soft <= 0.001 {
        (0.5 - d / px).clamp(0.0, 1.0)
    } else {
        smooth(px * 0.5, -soft, d)
    }
}

/// The record's per-draw rows (`rows` in drawlist/generators.rs).
#[derive(Clone, Copy)]
struct Rows {
    /// Softness, stretch, aspect, outline width (local units).
    shape: [f32; 4],
    shade: f32,
    outline: [f32; 4],
    /// Erosion edge, rim width, rim amount.
    erosion: [f32; 4],
    rim: [f32; 4],
}

/// A record's corner `q` (-1..1): its local position, its shading coordinates and
/// per-record values (`particle_corner` in prim.wgsl).
fn corner(p: &Prim, q: [f32; 2], px: f32, rows: &Rows) -> ([f32; 2], [f32; 2], [f32; 4]) {
    let kind = p.kind & 255;
    if kind == K_BEAM {
        let a = [p.a[0], p.a[1]];
        let d = [p.a[2] - a[0], p.a[3] - a[1]];
        let l = len(d[0], d[1]).max(1.0);
        let dn = [d[0] / l, d[1] / l];
        let nn = [-dn[1], dn[0]];
        let w = p.b[0];
        let halo = w * 3.0 + 8.0 + px;
        let lx = mix(-halo, l + halo, q[0] * 0.5 + 0.5);
        let ly = q[1] * halo;
        return ([a[0] + dn[0] * lx + nn[0] * ly, a[1] + dn[1] * lx + nn[1] * ly], [lx, ly], [l, w, p.b[1], p.b[2]]);
    }
    let shape = particle_shape(p.kind);
    let softness = rows.shape[0];
    if shape == P_SEGMENT {
        let (p0, p1) = ([p.a[0], p.a[1]], [p.a[2], p.a[3]]);
        let d = [p1[0] - p0[0], p1[1] - p0[1]];
        let l = len(d[0], d[1]);
        let dn = if l > 1e-4 { [d[0] / l, d[1] / l] } else { [1.0, 0.0] };
        let hl = 0.5 * l;
        let r = p.b[0].max(p.b[1]);
        let e = r * (1.0 + softness * 3.0) + px;
        let local = [q[0] * (hl + e), q[1] * e];
        let centre = [(p0[0] + p1[0]) * 0.5, (p0[1] + p1[1]) * 0.5];
        return ([centre[0] + dn[0] * local[0] - dn[1] * local[1], centre[1] + dn[1] * local[0] + dn[0] * local[1]], local, [hl, px, 0.0, 0.0]);
    }
    let centre = [p.a[0], p.a[1]];
    let (sz, rot) = (p.a[2], p.a[3]);
    let vel = [p.b[0], p.b[1]];
    let (sn, cs) = rot.sin_cos();
    let turned = |e: [f32; 2]| [centre[0] + e[0] * cs - e[1] * sn, centre[1] + e[0] * sn + e[1] * cs];
    if shape == P_STREAK {
        let sp = len(vel[0], vel[1]);
        let d = if sp > 1e-4 { [vel[0] / sp, vel[1] / sp] } else { [1.0, 0.0] };
        let hl = 0.5 * sp * rows.shape[1];
        let rr = sz.max(px * 0.5);
        let local = [q[0] * (hl + rr + px), q[1] * (rr + px)];
        let base = [centre[0] - d[0] * hl, centre[1] - d[1] * hl];
        return ([base[0] + d[0] * local[0] - d[1] * local[1], base[1] + d[1] * local[0] + d[0] * local[1]], local, [hl, rr, softness, px]);
    }
    let hx = sz.max(px * 0.5);
    let hy = hx * rows.shape[2] + 0.5 * len(vel[0], vel[1]) * rows.shape[1];
    let ow = rows.shape[3];
    let grow = if shape == P_RING { hx * softness * 2.0 } else { 0.0 };
    let pad = px + ow + grow;
    let e = [q[0] * (hx + pad), q[1] * (hy + pad)];
    let lod = if shape == P_MATERIAL { (atlas::CELL as f32 * px / (2.0 * hx.max(hy))).log2().clamp(0.0, (atlas::LEVELS - 1) as f32) } else { 0.0 };
    (turned(e), [e[0] / hx, e[1] / hy], [px / hx.min(hy), ow / hx, lod, 0.0])
}

/// Trilinear sample of a material's cell: (density, light).
fn material(cell: u32, u: f32, v: f32, lod: f32) -> [f32; 2] {
    let (m, variant) = ((cell >> 4) as usize, cell & 15);
    let Some(row) = atlas::ready(m) else { return [0.0, 0.5] };
    let level = |l: usize| -> [f32; 2] {
        let lv = &row.levels[l];
        let cell_px = (atlas::CELL as usize) >> l;
        let (w, h) = (lv.width, lv.height);
        // Inside its own cell, half a texel in.
        let x = (variant as f32 + u.clamp(0.0, 1.0)) * cell_px as f32 - 0.5;
        let y = v.clamp(0.0, 1.0) * cell_px as f32 - 0.5;
        let lo_x = (variant as usize * cell_px) as f32;
        let x = x.clamp(lo_x, lo_x + cell_px as f32 - 1.0);
        let y = y.clamp(0.0, cell_px as f32 - 1.0);
        let (x0, y0) = (x.floor(), y.floor());
        let (fx, fy) = (x - x0, y - y0);
        let (x0, y0) = (x0 as usize, y0 as usize);
        let (x1, y1) = ((x0 + 1).min(w - 1), (y0 + 1).min(h - 1));
        let t = |tx: usize, ty: usize| -> [f32; 2] {
            let o = (ty * w + tx) * 2;
            [lv.data[o] as f32 / 255.0, lv.data[o + 1] as f32 / 255.0]
        };
        let (a, b, c, d) = (t(x0, y0), t(x1, y0), t(x0, y1), t(x1, y1));
        [0, 1].map(|k| mix(mix(a[k], b[k], fx), mix(c[k], d[k], fx), fy))
    };
    let l0 = lod.floor() as usize;
    let l1 = (l0 + 1).min(atlas::LEVELS - 1);
    let (s0, s1) = (level(l0), level(l1));
    let f = lod - l0 as f32;
    [mix(s0[0], s1[0], f), mix(s0[1], s1[1], f)]
}

/// Premultiplied colour of a paint layer: `rgb` at coverage `k`, emitting `e` of its light.
#[inline]
fn lit(rgb: [f32; 3], k: f32, e: f32) -> [f32; 4] {
    [rgb[0] * k, rgb[1] * k, rgb[2] * k, k * (1.0 - e)]
}

/// `top` over `under`, both premultiplied with emissive alpha.
#[inline]
fn over(top: [f32; 4], under: [f32; 4]) -> [f32; 4] {
    let keep = 1.0 - top[3];
    [top[0] + under[0] * keep, top[1] + under[1] * keep, top[2] + under[2] * keep, top[3] + under[3] * keep]
}

/// Where the light comes from in the world, for cartoon shadows (`CEL_LIGHT` in prim.wgsl).
const CEL_LIGHT: [f32; 2] = [-0.45, -0.893];

/// A crisp shape's cartoon shadow side (`cel_shadow` in prim.wgsl): where the shape moved toward the
/// light no longer covers `uv`, its colour turns to the shadow's, with a hard edge.
fn cel_shadow(p: &Prim, uv: [f32; 2], shape: u32, px: f32, rows: &Rows) -> [f32; 3] {
    let (sn, cs) = (p.a[3].sin(), p.a[3].cos());
    let depth = rows.rim[3];
    let l = [(CEL_LIGHT[0] * cs + CEL_LIGHT[1] * sn) * depth, (-CEL_LIGHT[0] * sn + CEL_LIGHT[1] * cs) / rows.shape[2].max(0.05) * depth];
    let (x, y) = (uv[0] - l[0], uv[1] - l[1]);
    let d = if shape == P_DISC { len(x, y) - 1.0 } else { shape_distance(shape, x, y, p.color & 0xffff) };
    let s = (1.0 - (0.5 - d / px).clamp(0.0, 1.0)) * rows.erosion[3];
    [0, 1, 2].map(|i| mix(p.c[i], rows.rim[i], s))
}

/// A particle's premultiplied colour at `uv` (`particle_color` in prim.wgsl); its alpha is
/// what it covers of the target, less where it emits light.
fn particle_color(p: &Prim, uv: [f32; 2], prm: [f32; 4], rows: &Rows) -> [f32; 4] {
    let shape = particle_shape(p.kind);
    let c = p.c;
    let mut rgb = [c[0], c[1], c[2]];
    if rows.erosion[3] > 0.0 && !matches!(shape, P_SEGMENT | P_STREAK | P_MATERIAL | P_RING | P_BOKEH) {
        rgb = cel_shadow(p, uv, shape, prm[0], rows);
    }
    let e = p.b[2];
    let softness = rows.shape[0];
    let cov = match shape {
        P_SEGMENT => {
            let (hl, px) = (prm[0], prm[1]);
            let t = ((uv[0] + hl) / (2.0 * hl).max(1e-4)).clamp(0.0, 1.0);
            let r = mix(p.b[0], p.b[1], t).max(px * 0.35);
            let caps = p.kind >> 24;
            let along = uv[0].abs() - hl;
            let d = if along > 0.0 && (if uv[0] < 0.0 { caps & 1 != 0 } else { caps & 2 != 0 }) { len(along, uv[1]) } else if along > 0.0 { f32::MAX } else { uv[1].abs() };
            let core = (0.5 - (d - r) / px).clamp(0.0, 1.0);
            // The glow fades out before the quad's side.
            let glow = if softness > 0.0 && d < f32::MAX { (-(d - r).max(0.0) / (r * softness * 1.2 + px)).exp() * 0.6 * (1.0 - smooth(r + r * softness * 1.8, r + r * softness * 3.0 + px, d)) } else { 0.0 };
            let alpha = mix(c[3], p.b[3], t);
            let k = core.max(glow) * alpha;
            // The glow around the core is light; the core takes the record's own emission.
            let ek = if core >= glow { e } else { e.max(0.85) };
            return lit(rgb, k, ek);
        }
        P_STREAK => {
            let hl = prm[0];
            let t = (uv[0] / hl.max(1e-3) * 0.5 + 0.5).clamp(0.0, 1.0);
            let w = if hl > 0.5 { mix(0.3, 1.0, t) } else { 1.0 };
            let d = len((uv[0].abs() - hl).max(0.0), uv[1] / w) / prm[1];
            let tail = if hl > 0.5 { t * t * (3.0 - 2.0 * t) * 0.9 + 0.1 } else { 1.0 };
            let aa = (prm[3] / prm[1] * 1.5).min(1.0);
            let edge_cov = 1.0 - smooth(1.0 - aa, 1.0, d);
            (1.0 - d).max(1e-5).powf(prm[2].max(0.05)) * edge_cov * tail
        }
        P_MATERIAL => {
            let tex = material(p.color & 0xffff, uv[0] * 0.5 + 0.5, uv[1] * 0.5 + 0.5, prm[2]);
            let (f, light) = (tex[0], tex[1]);
            let th = p.b[3];
            let w = rows.erosion[0].max(prm[0] * 1.2);
            let k = smooth(th, th + w, f);
            let ow = prm[1];
            let line = if rows.shape[3] > 0.0 { smooth(th - ow * 0.5, th - ow * 0.5 + w * 0.5, f) } else { k };
            if line <= 0.0 {
                return [0.0; 4];
            }
            // Lit from above: shading darkens what faces away; the rim recolours the edge.
            let shade = mix(1.0, 0.45 + 1.1 * light, rows.shade);
            let mut col = rgb.map(|v| v * shade);
            if rows.erosion[2] > 0.0 {
                let r = (1.0 - smooth(th, th + rows.erosion[1].max(w), f)) * rows.erosion[2];
                col = [0, 1, 2].map(|i| mix(col[i], rows.rim[i], r));
            }
            let fill = lit(col, k * c[3], e);
            let band = (line - k).max(0.0) * rows.outline[3] * c[3];
            return [fill[0] + rows.outline[0] * band, fill[1] + rows.outline[1] * band, fill[2] + rows.outline[2] * band, fill[3] + band];
        }
        P_DISC | P_RING | P_BOKEH => {
            let r = len(uv[0], uv[1]);
            let px = prm[0];
            let k = match shape {
                P_RING => {
                    let hw = softness.max(0.02);
                    let band = (0.5 - ((r - 1.0).abs() - hw) / px).clamp(0.0, 1.0);
                    band * mix(0.55, 1.0, smooth(1.0 - hw, 1.0, r)) + 0.12 * (1.0 - smooth(0.0, 1.0, r)) * if r <= 1.0 { 1.0 } else { 0.0 }
                }
                P_BOKEH => edge(r - 1.0, 0.0, px) * mix(0.5, 1.0, smooth(0.62, 0.96, r)),
                _ if softness < 0.15 => edge(r - 1.0, 0.0, px),
                _ => (1.0 - r).max(0.0).powf(softness) * (1.0 - smooth(1.0 - px, 1.0, r)),
            };
            if rows.shape[3] > 0.0 {
                let line = edge(r - 1.0 - prm[1], 0.0, px);
                let fill = lit(rgb, k * c[3], e);
                let band = (line - k.min(1.0)).max(0.0) * rows.outline[3] * c[3];
                return [fill[0] + rows.outline[0] * band, fill[1] + rows.outline[1] * band, fill[2] + rows.outline[2] * band, fill[3] + band];
            }
            k
        }
        _ => {
            let d = shape_distance(shape, uv[0], uv[1], p.color & 0xffff);
            let px = prm[0];
            let k = edge(d, softness, px);
            if rows.shape[3] > 0.0 {
                let line = edge(d - prm[1], 0.0, px);
                let fill = lit(rgb, k * c[3], e);
                let band = (line - k).max(0.0) * rows.outline[3] * c[3];
                return [fill[0] + rows.outline[0] * band, fill[1] + rows.outline[1] * band, fill[2] + rows.outline[2] * band, fill[3] + band];
            }
            // A spark's and a sparkle's middle is hotter than its points.
            if shape == P_SPARK || shape == P_SPARKLE {
                let r = len(uv[0], uv[1]);
                let core = (1.0 - smooth(0.0, 0.45, r)) * 0.6;
                return lit([0, 1, 2].map(|i| mix(rgb[i], 1.0, core)), k * c[3], e);
            }
            k
        }
    };
    lit(rgb, cov * c[3], e)
}

/// A beam's premultiplied colour at `uv` (`beam_color` in prim.wgsl); `aa` is the pixel in local units.
fn beam_color(p: &Prim, uv: [f32; 2], prm: [f32; 4], aa: f32, colors: &[[f32; 4]; 5]) -> [f32; 4] {
    let (l, w) = (prm[0], prm[1]);
    if w <= 0.05 {
        return [0.0; 4];
    }
    let (t, x, style, opacity) = (p.b[3], uv[0], p.c[1] as u32, p.c[0]);
    let seed = prm[3];
    let strands = p.c[2];
    let [core_c, body_c, glow_c, extra, rim_c] = *colors;
    let wob = (vnoise(x * 0.018 - t * 0.55, seed) - 0.5) * 2.0 * prm[2] * w * smooth(0.0, 80.0, x);
    let y = uv[1] - wob;
    // Thin at the muzzle, full along the body, a rounded swell at the travelling head.
    let head = smooth(l - w * 2.5, l - w * 0.4, x) * extra[0];
    let ww = w * mix(0.55, 1.0, smooth(0.0, 60.0, x)) * (1.0 + 0.35 * head);
    let d = len((-x).max(x - l).max(0.0), y.abs());
    if style == 2 {
        // Cartoon: a flat body with a lighter core band and an ink line.
        let ink = 1.0 - smooth(ww + p.c[3] - aa, ww + p.c[3] + aa, d);
        let body = 1.0 - smooth(ww - aa, ww + aa, d);
        let core = 1.0 - smooth(ww * 0.45 - aa, ww * 0.45 + aa, d);
        let col = [0, 1, 2].map(|i| mix(body_c[i], core_c[i], core));
        let a = body * opacity;
        let band = (ink - body).max(0.0) * opacity;
        return [col[0] * a + extra[1] * band, col[1] * a + extra[2] * band, col[2] * a + extra[3] * band, a + band];
    }
    // Energy flows along it: brighter streaks travelling toward the tip.
    let flow = 0.8 + 0.45 * vnoise(x * 0.045 - t * 1.6, y / ww.max(1.0) * 1.3 + seed);
    let (core_w, body_w, glow_w) = if style == 1 { (0.18, 0.42, 0.7) } else { (0.2, 0.68, 0.9) };
    let core = 1.0 - smooth(ww * core_w - aa, ww * (core_w + 0.1) + aa, d);
    let body = 1.0 - smooth(ww * body_w - aa, ww * body_w + aa * 2.0, d);
    // The glow fades out before the quad's side (w · 3 + 8 from the axis).
    let halo = w * 3.0 + 8.0;
    let glow = (-(d - ww * body_w * 0.8).max(0.0) / (ww * glow_w + 1.0)).exp() * 0.55 * (1.0 - smooth(halo * 0.6, halo, d));
    let mut out = lit([glow_c[0], glow_c[1], glow_c[2]], glow * opacity, glow_c[3]);
    let bright = if style == 1 { 1.0 } else { flow };
    // The body turns to its rim colour over its outer half: a deeper tone of the hue gives a light
    // beam an edge that reads on a light page.
    let edge = smooth(ww * body_w * 0.4, ww * body_w, d);
    let body_rgb = [0, 1, 2].map(|i| mix(body_c[i], rim_c[i], edge));
    out = over(lit(body_rgb, body * opacity * bright.min(1.0), mix(body_c[3], rim_c[3], edge)), out);
    if strands > 0.5 {
        // Two strands winding round the body.
        let period = (w * 3.2).max(24.0);
        let inside = if x >= 0.0 && x <= l { 1.0 } else { 0.0 };
        for s in 0..2 {
            let phase = x / period * std::f32::consts::TAU - t * 0.35 + s as f32 * std::f32::consts::PI;
            let sy = phase.sin() * ww * 0.95;
            let depth = 0.55 + 0.45 * phase.cos();
            let strand = (-(y - sy).abs() / (ww * 0.1 + 0.6)).exp() * depth * inside;
            out = over(lit(core_c[..3].try_into().unwrap(), (strand * opacity).min(1.0), core_c[3]), out);
        }
    }
    let hot = [0, 1, 2].map(|i| (core_c[i] * bright).min(1.0));
    over(lit(hot, core * opacity, core_c[3]), out)
}

/// Draws generated-effect record `p` of `list` into `target`, the pixels of `layer`, within
/// `clip` (x0, y0, x1, y1).
pub(crate) fn draw(list: &DrawList, p: &Prim, target: &mut Target, layer: &Layer, clip: [i64; 4], positions: &[[i64; 2]]) {
    let row = |i: u32| list.paints.get((p.paint + i) as usize).copied().unwrap_or([0.0; 4]);
    let (r0, r1) = (row(0), row(1));
    let beam = p.kind & 255 == K_BEAM;
    let rows = Rows { shape: row(2), shade: r1[3], outline: row(3), erosion: row(4), rim: row(5) };
    // The layer's pixel in the draw's local units (`px` in prim.wgsl).
    let px = layer.aa / r1[2].max(1e-12);
    let m = layer.m32;
    let to_target = |local: [f32; 2]| -> [f32; 2] {
        let world = [r0[0] * local[0] + r0[2] * local[1] + r1[0], r0[1] * local[0] + r0[3] * local[1] + r1[1]];
        [m[0] * world[0] + m[2] * world[1] + m[4], m[1] * world[0] + m[3] * world[1] + m[5]]
    };
    let shaped = [[-1.0, -1.0], [1.0, -1.0], [-1.0, 1.0], [1.0, 1.0]].map(|q| corner(p, q, px, &rows));
    let corners = shaped.map(|(local, _, _)| to_target(local));
    let prm = shaped[0].2;
    // The quad is the affine image of q ∈ [-1, 1]²: q at a pixel centre, then uv, which the
    // GPU interpolates affinely between the corners.
    let (o, u, v) = (corners[0], corners[1], corners[2]);
    let from_q = [((u[0] - o[0]) / 2.0) as f64, ((u[1] - o[1]) / 2.0) as f64, ((v[0] - o[0]) / 2.0) as f64, ((v[1] - o[1]) / 2.0) as f64, ((u[0] + v[0]) / 2.0) as f64, ((u[1] + v[1]) / 2.0) as f64];
    if (from_q[0] * from_q[3] - from_q[1] * from_q[2]).abs() < 1e-12 {
        return;
    }
    let to_q = invert(from_q);
    let (uv0, uv1, uv2) = (shaped[0].1, shaped[1].1, shaped[2].1);
    let colors = [row(2), row(3), row(4), row(5), row(6)];
    let width = target.width;
    quad(corners, clip, positions, |x, y, mask| {
        let (cx, cy) = (x as f64 + 0.5, y as f64 + 0.5);
        let qx = (to_q[0] * cx + to_q[2] * cy + to_q[4]) as f32;
        let qy = (to_q[1] * cx + to_q[3] * cy + to_q[5]) as f32;
        let (sx, sy) = ((qx + 1.0) * 0.5, (qy + 1.0) * 0.5);
        let uv = [uv0[0] + (uv1[0] - uv0[0]) * sx + (uv2[0] - uv0[0]) * sy, uv0[1] + (uv1[1] - uv0[1]) * sx + (uv2[1] - uv0[1]) * sy];
        let color = if beam { beam_color(p, uv, prm, px, &colors) } else { particle_color(p, uv, prm, &rows) };
        // The fragment shader discards what gives nothing.
        if color[3] <= 0.0 && color[0] <= 0.0 && color[1] <= 0.0 && color[2] <= 0.0 {
            return;
        }
        target.blend(y as usize * width + x as usize, mask, color, false);
    });
}
