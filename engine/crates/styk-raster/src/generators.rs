//! Generated effects on the CPU (`K_PARTICLE`, `K_BEAM`; docs/engine/vfx.md): each
//! record is expanded into the same quad as the GPU's vertex shader (its corners in
//! the draw's local units, then the draw's transform, then the layer's), covered by the
//! GPU's samples, and shaded once a pixel at its centre by the fragment shader's
//! arithmetic, in single precision, then blended over the target (or added, `F_ADD`).

use styk_draw::*;
use styk_eval::vfx::generated::atlas;

use crate::coverage::quad;
use crate::frame::Layer;
use crate::shade::invert;
use crate::target::Target;

fn smooth(a: f32, b: f32, x: f32) -> f32 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn mix(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

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

fn vnoise(x: f32, y: f32) -> f32 {
    let (ix, iy) = (x.floor(), y.floor());
    let (fx, fy) = (x - ix, y - iy);
    let (ux, uy) = (fx * fx * (3.0 - 2.0 * fx), fy * fy * (3.0 - 2.0 * fy));
    let (ix, iy) = (ix as i32, iy as i32);
    mix(mix(hash2(ix, iy), hash2(ix + 1, iy), ux), mix(hash2(ix, iy + 1), hash2(ix + 1, iy + 1), ux), uy)
}

/// A record's corner `q` (-1..1): its local position, its shading coordinates and
/// per-record values (`particle_corner` in prim.wgsl).
fn corner(p: &Prim, q: [f32; 2], px: f32, r2: [f32; 4]) -> ([f32; 2], [f32; 2], [f32; 4]) {
    let kind = p.kind & 255;
    if kind == K_BEAM {
        let a = [p.a[0], p.a[1]];
        let d = [p.a[2] - a[0], p.a[3] - a[1]];
        let l = len(d[0], d[1]).max(1.0);
        let dn = [d[0] / l, d[1] / l];
        let nn = [-dn[1], dn[0]];
        let w = p.b[0];
        let halo = w * 3.5 + 8.0;
        let lx = mix(-halo, l + halo, q[0] * 0.5 + 0.5);
        let ly = q[1] * halo;
        return ([a[0] + dn[0] * lx + nn[0] * ly, a[1] + dn[1] * lx + nn[1] * ly], [lx, ly], [l, w, p.b[1], p.b[2]]);
    }
    let shape = particle_shape(p.kind);
    let softness = r2[0];
    if shape == P_ARC {
        let (p0, p1, r) = ([p.a[0], p.a[1]], [p.a[2], p.a[3]], p.b[0]);
        let d = [p1[0] - p0[0], p1[1] - p0[1]];
        let l = len(d[0], d[1]);
        let dn = if l > 1e-4 { [d[0] / l, d[1] / l] } else { [1.0, 0.0] };
        let hl = 0.5 * l;
        let e = r + r * 4.0;
        let local = [q[0] * (hl + e), q[1] * e];
        let centre = [(p0[0] + p1[0]) * 0.5, (p0[1] + p1[1]) * 0.5];
        return ([centre[0] + dn[0] * local[0] - dn[1] * local[1], centre[1] + dn[1] * local[0] + dn[0] * local[1]], local, [hl, r, px, 0.0]);
    }
    let centre = [p.a[0], p.a[1]];
    let (sz, rot) = (p.a[2], p.a[3]);
    let vel = [p.b[0], p.b[1]];
    let (cs, sn) = (rot.cos(), rot.sin());
    let turned = |e: [f32; 2]| [centre[0] + e[0] * cs - e[1] * sn, centre[1] + e[0] * sn + e[1] * cs];
    match shape {
        P_STREAK => {
            let sp = len(vel[0], vel[1]);
            let d = if sp > 1e-4 { [vel[0] / sp, vel[1] / sp] } else { [1.0, 0.0] };
            let hl = 0.5 * sp * r2[1];
            let rr = sz.max(px * 0.5);
            let local = [q[0] * (hl + rr + px), q[1] * (rr + px)];
            let base = [centre[0] - d[0] * hl, centre[1] - d[1] * hl];
            ([base[0] + d[0] * local[0] - d[1] * local[1], base[1] + d[1] * local[0] + d[0] * local[1]], local, [hl, rr, softness, px])
        }
        P_CHUNK => {
            let e = sz * 1.3 + px;
            (turned([q[0] * e, q[1] * e]), [q[0] * (1.3 + px / sz.max(1e-3)), q[1] * (1.3 + px / sz.max(1e-3))], [p.b[2], px / sz.max(1e-3), 0.0, 0.0])
        }
        P_SPRITE => {
            let hx = sz.max(px * 0.5);
            let hy = hx * r2[2] + 0.5 * len(vel[0], vel[1]) * r2[1];
            let cell = [(p.color & 255) as f32, (p.color >> 8) as f32];
            let uv = [(cell[0] + q[0] * 0.5 + 0.5) / MATERIAL_COLUMNS as f32, (cell[1] + q[1] * 0.5 + 0.5) / MATERIAL_ROWS as f32];
            let lod = (MATERIAL_CELL as f32 * px / (2.0 * hx.max(hy))).log2().clamp(0.0, (MATERIAL_LEVELS - 1) as f32);
            (turned([q[0] * hx, q[1] * hy]), uv, [0.0, lod, 0.0, 0.0])
        }
        P_SQUARE => {
            let rr = sz.max(px * 0.5);
            let e = rr + px;
            (turned([q[0] * e, q[1] * e]), [q[0] * (1.0 + px / rr), q[1] * (1.0 + px / rr)], [px / rr, 0.0, 0.0, 0.0])
        }
        _ => {
            let grow = if shape == P_RING { 1.0 + softness * 2.0 } else { 1.0 };
            let rr = sz.max(px * 0.5);
            let squash = if shape == P_DISC { r2[2] } else { 1.0 };
            let e = rr * grow + px;
            ([centre[0] + q[0] * e, centre[1] + q[1] * e * squash], [q[0] * (grow + px / rr), q[1] * (grow + px / rr)], [softness, px / rr, 0.0, 0.0])
        }
    }
}

fn soft(d: f32, s: f32, aa: f32) -> f32 {
    let edge = 1.0 - smooth(1.0 - aa, 1.0, d);
    (1.0 - d).max(1e-5).powf(s) * edge
}

fn shade_rgb(c: [f32; 3], s: f32) -> [f32; 3] {
    if s < 0.5 {
        let k = 0.25 + 1.5 * s;
        c.map(|v| v * k)
    } else {
        let k = (s - 0.5) * 1.4;
        c.map(|v| v + (1.0 - v) * k)
    }
}

/// Trilinear sample of the material atlas: (shading × coverage, coverage).
fn material(uv: [f32; 2], lod: f32) -> [f32; 2] {
    let level = |l: usize| -> [f32; 2] {
        let width = (MATERIAL_CELL * MATERIAL_COLUMNS) as usize >> l;
        let height = (MATERIAL_CELL * MATERIAL_ROWS) as usize >> l;
        let cell = (MATERIAL_CELL as usize) >> l;
        let x = uv[0] * width as f32 - 0.5;
        let y = uv[1] * height as f32 - 0.5;
        let (x0, y0) = (x.floor(), y.floor());
        let (fx, fy) = (x - x0, y - y0);
        let texel = |tx: i64, ty: i64| -> [f32; 2] {
            let tx = tx.clamp(0, width as i64 - 1) as usize;
            let ty = ty.clamp(0, height as i64 - 1) as usize;
            let row = atlas::row(ty / cell);
            let data = &row.levels[l].data;
            let o = ((ty % cell) * width + tx) * 2;
            [data[o] as f32 / 255.0, data[o + 1] as f32 / 255.0]
        };
        let (a, b, c, d) = (texel(x0 as i64, y0 as i64), texel(x0 as i64 + 1, y0 as i64), texel(x0 as i64, y0 as i64 + 1), texel(x0 as i64 + 1, y0 as i64 + 1));
        [0, 1].map(|k| mix(mix(a[k], b[k], fx), mix(c[k], d[k], fx), fy))
    };
    let l0 = lod.floor() as usize;
    let l1 = (l0 + 1).min(MATERIAL_LEVELS as usize - 1);
    let (s0, s1) = (level(l0), level(l1));
    let f = lod - l0 as f32;
    [mix(s0[0], s1[0], f), mix(s0[1], s1[1], f)]
}

/// A particle's premultiplied colour at `uv` (`particle_color`).
fn particle_color(p: &Prim, uv: [f32; 2], prm: [f32; 4], shade: f32) -> [f32; 4] {
    let shape = particle_shape(p.kind);
    let c = p.c;
    let cov = match shape {
        P_DISC => soft(len(uv[0], uv[1]), prm[0], (prm[1] * 1.5).min(1.0)),
        P_STREAK => {
            let hl = prm[0];
            let t = (uv[0] / hl.max(1e-3) * 0.5 + 0.5).clamp(0.0, 1.0);
            let w = if hl > 0.5 { mix(0.3, 1.0, t) } else { 1.0 };
            let d = len((uv[0].abs() - hl).max(0.0), uv[1] / w) / prm[1];
            let tail = if hl > 0.5 { t * t * (3.0 - 2.0 * t) * 0.9 + 0.1 } else { 1.0 };
            soft(d, prm[2], (prm[3] / prm[1] * 1.5).min(1.0)) * tail
        }
        P_RING => {
            let d = len(uv[0], uv[1]);
            let rd = (d - 1.0).abs() / prm[0].max(0.01);
            (1.0 - rd).max(0.0).powf(1.6) + 0.18 * (1.0 - smooth(0.0, 1.0, d)) * if d <= 1.0 { 1.0 } else { 0.0 }
        }
        P_CHUNK => {
            let (qx, qy) = (uv[0].abs(), uv[1].abs());
            let d = qx.max(qy * (0.55 + 0.6 * prm[0]) + qx * 0.25);
            1.0 - smooth(1.0 - (prm[1] * 1.5).min(1.0), 1.0, d)
        }
        P_ARC => {
            let d = len((uv[0].abs() - prm[0]).max(0.0), uv[1]);
            let r = prm[1];
            ((1.0 - (d - r) / prm[2]).clamp(0.0, 1.0) + (-d / (r * 2.5)).exp() * 0.55).min(1.0)
        }
        P_SPRITE => {
            let tex = material(uv, prm[1]);
            if tex[1] <= 0.002 {
                return [0.0; 4];
            }
            let rgb = shade_rgb([c[0], c[1], c[2]], mix(0.5, (tex[0] / tex[1]).clamp(0.0, 1.0), shade));
            let k = tex[1] * c[3];
            return [rgb[0] * k, rgb[1] * k, rgb[2] * k, k];
        }
        P_SQUARE => {
            let q = uv[0].abs().max(uv[1].abs());
            let aa = (prm[0] * 1.5).min(1.0);
            1.0 - smooth(1.0 - aa, 1.0, q)
        }
        _ => 0.0,
    };
    let k = cov * c[3];
    [c[0] * k, c[1] * k, c[2] * k, k]
}

/// A beam's premultiplied colour at `uv` (`beam_color`); `aa` is the pixel in local units.
fn beam_color(p: &Prim, uv: [f32; 2], prm: [f32; 4], aa: f32, c0: [f32; 4], c1: [f32; 4]) -> [f32; 4] {
    let (l, w) = (prm[0], prm[1]);
    if w <= 0.05 {
        return [0.0; 4];
    }
    let (t, x, style, opacity) = (p.b[3], uv[0], p.c[1] as u32, p.c[0]);
    let wob = (vnoise(x * 0.018 - t * 0.55, prm[3]) - 0.5) * 2.0 * prm[2] * w * smooth(0.0, 80.0, x);
    let y = uv[1] - wob;
    let ww = w * mix(0.55, 1.0, smooth(0.0, 70.0, x));
    let d = len((-x).max(x - l).max(0.0), y.abs());
    if style == 2 {
        let body = 1.0 - smooth(ww - aa, ww + aa, d);
        let core = 1.0 - smooth(ww * 0.45 - aa, ww * 0.45 + aa, d);
        let a = body * opacity;
        return [mix(c1[0], c0[0], core) * a, mix(c1[1], c0[1], core) * a, mix(c1[2], c0[2], core) * a, a];
    }
    let pulse = 0.8 + 0.4 * vnoise(x * 0.035 - t * 1.7, 3.0 + prm[3]);
    let (core, body, glow) = if style == 1 {
        (1.0 - smooth(ww * 0.2 - aa, ww * 0.2 + aa, d), 1.0 - smooth(ww * 0.5 - aa, ww * 0.5 + aa, d), (-d / (ww * 1.1 + 1.0)).exp() * 0.5)
    } else {
        (1.0 - smooth(ww * 0.26, ww * 0.42, d), 1.0 - smooth(ww * 0.45, ww, d), (-d / (ww * 0.9 + 1.0)).exp() * 0.45)
    };
    let factor = if style == 1 { 1.0 } else { pulse };
    let mut rgb = [0, 1, 2].map(|k| c0[k] * core + c1[k] * (body * 0.8 + glow) * factor);
    let mut a = core + body * 0.7 + glow * 0.5;
    if style == 3 {
        let period = (w * 3.2).max(24.0);
        let inside = if x >= 0.0 && x <= l { 1.0 } else { 0.0 };
        for s in 0..2 {
            let phase = x / period * std::f32::consts::TAU - t * 0.35 + s as f32 * std::f32::consts::PI;
            let sy = phase.sin() * ww * 0.95;
            let depth = 0.55 + 0.45 * phase.cos();
            let strand = (-(y - sy).abs() / (ww * 0.1 + 0.6)).exp() * depth * inside;
            for (k, v) in rgb.iter_mut().enumerate() {
                *v += c0[k] * strand;
            }
            a += strand * 0.8;
        }
    }
    let alpha = a.clamp(0.0, 1.0) * opacity;
    [rgb[0].min(1.0) * alpha, rgb[1].min(1.0) * alpha, rgb[2].min(1.0) * alpha, alpha]
}

/// Draws generated-effect record `p` of `list` into `target`, the pixels of `layer`, within
/// `clip` (x0, y0, x1, y1).
pub(crate) fn draw(list: &DrawList, p: &Prim, target: &mut Target, layer: &Layer, clip: [i64; 4], positions: &[[i64; 2]]) {
    let row = |i: u32| list.paints.get((p.paint + i) as usize).copied().unwrap_or([0.0; 4]);
    let (r0, r1, r2) = (row(0), row(1), row(2));
    // The layer's pixel in the draw's local units (`px` in prim.wgsl).
    let px = layer.aa / r1[2].max(1e-12);
    let m = layer.m32;
    let to_target = |local: [f32; 2]| -> [f32; 2] {
        let world = [r0[0] * local[0] + r0[2] * local[1] + r1[0], r0[1] * local[0] + r0[3] * local[1] + r1[1]];
        [m[0] * world[0] + m[2] * world[1] + m[4], m[1] * world[0] + m[3] * world[1] + m[5]]
    };
    let shaped = [[-1.0, -1.0], [1.0, -1.0], [-1.0, 1.0], [1.0, 1.0]].map(|q| corner(p, q, px, r2));
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
    let beam = p.kind & 255 == K_BEAM;
    let (c0, c1) = (row(3), row(4));
    let additive = p.kind & F_ADD != 0;
    let width = target.width;
    quad(corners, clip, positions, |x, y, mask| {
        let (cx, cy) = (x as f64 + 0.5, y as f64 + 0.5);
        let qx = (to_q[0] * cx + to_q[2] * cy + to_q[4]) as f32;
        let qy = (to_q[1] * cx + to_q[3] * cy + to_q[5]) as f32;
        let (sx, sy) = ((qx + 1.0) * 0.5, (qy + 1.0) * 0.5);
        let uv = [uv0[0] + (uv1[0] - uv0[0]) * sx + (uv2[0] - uv0[0]) * sy, uv0[1] + (uv1[1] - uv0[1]) * sx + (uv2[1] - uv0[1]) * sy];
        let color = if beam { beam_color(p, uv, prm, px, c0, c1) } else { particle_color(p, uv, prm, r1[3]) };
        // The fragment shader discards what it gives no alpha.
        if color[3] <= 0.0 {
            return;
        }
        target.blend(y as usize * width + x as usize, mask, color, additive);
    });
}

