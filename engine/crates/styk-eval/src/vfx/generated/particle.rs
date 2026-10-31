//! One particle of a batch (`evaluateParticle`, `rampColor`, `beamTip`,
//! `beamWidth` of the recorded editor; its WebGPU vertex shader
//! mirrors them line for line). A particle is a pure function of its draw's
//! record, the batch table, its instance index and the tick, so seeking,
//! playback and export draw the same particles. Arithmetic is the editor's
//! reference: `f64`, V8's trigonometry and exponential (`styk-math`).

use std::f64::consts::PI;

use super::batch::{Batch, Draw};
use super::layers::*;

const TAU: f64 = PI * 2.0;
const INV32: f64 = 1.0 / 4294967296.0;

/// The PCG hash the editor's shaders use.
pub fn pcg(v: u32) -> u32 {
    let s = v.wrapping_mul(747796405).wrapping_add(2891336453);
    let w = ((s >> ((s >> 28) + 4)) ^ s).wrapping_mul(277803737);
    (w >> 22) ^ w
}

/// `ToInt32` of an integral number, as JavaScript's bitwise operators take it.
fn int32(n: f64) -> u32 {
    if n.is_finite() { (n as i64) as u32 } else { 0 }
}

/// `hash(n, k, seed)`: a uniform number in [0, 1), bit-compatible with the shaders.
pub fn hash(n: f64, k: u32, seed: u32) -> f64 {
    let inner = pcg(int32(n) ^ seed.wrapping_mul(1664525));
    (pcg(inner.wrapping_add(k.wrapping_mul(1013904223))) as f32) as f64 * INV32
}

fn hash2(x: f64, y: f64) -> f64 {
    (pcg(int32(x).wrapping_mul(73856093) ^ int32(y).wrapping_mul(19349663)) as f32) as f64 * INV32
}

fn mix(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

pub fn smoothstep(a: f64, b: f64, x: f64) -> f64 {
    let t = clamp((x - a) / (b - a), 0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// `vnoise(x, y)`: smooth value noise.
pub fn vnoise(x: f64, y: f64) -> f64 {
    let (ix, iy) = (x.floor(), y.floor());
    let (fx, fy) = (x - ix, y - iy);
    let (ux, uy) = (fx * fx * (3.0 - 2.0 * fx), fy * fy * (3.0 - 2.0 * fy));
    mix(mix(hash2(ix, iy), hash2(ix + 1.0, iy), ux), mix(hash2(ix, iy + 1.0), hash2(ix + 1.0, iy + 1.0), ux), uy)
}

/// One evaluated particle, in its draw's local coordinates ([`Batch::matrix`] maps them to the stage).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Particle {
    pub x: f64,
    pub y: f64,
    pub vx: f64,
    pub vy: f64,
    pub size: f64,
    /// Before the colour stop's own opacity ([`ramp`]).
    pub alpha: f64,
    /// Where on the colour ramp it is: its age, or a random place per particle.
    pub color: f64,
    pub rotation: f64,
    /// The atlas column of a sprite.
    pub variant: u32,
    /// Its emission index.
    pub n: f64,
}

/// `steppedTime`: the tick, held on twos or threes.
pub fn stepped_time(r: &[f32]) -> f64 {
    let (t, cs, step) = (r[54] as f64, r[50] as f64, r[6] as f64);
    if step > 1.0 { cs + ((t - cs) / step).floor() * step } else { t }
}

/// `beamTip`: where a beam's tip is, travelling from its origin to its aim.
pub fn beam_tip(r: &[f32], te: f64) -> [f64; 2] {
    let k = clamp((te - r[59] as f64) / (r[58] as f64).max(1.0), 0.0, 1.0);
    let e = 1.0 - (1.0 - k) * (1.0 - k);
    [mix(r[36] as f64, r[38] as f64, e), mix(r[37] as f64, r[39] as f64, e)]
}

/// `beamWidth`: 0 to 1 as a beam fires and fades.
pub fn beam_width(r: &[f32], te: f64) -> f64 {
    let (fire_start, fire_end, fade) = (r[59] as f64, r[60] as f64, r[61] as f64);
    smoothstep(fire_start - 1.0, fire_start + 2.0, te) * (1.0 - smoothstep(fire_end - fade, fire_end, te))
}

/// `rampColor`: the colour at ramp position `x`, 0–1 per channel, and the stop
/// opacity. Additive layers clip bright values toward white; normal layers keep
/// their hue at full saturation, lower intensity becoming transparency.
pub fn ramp(r: &[f32], x: f64) -> [f64; 4] {
    let y = clamp(x, 0.0, 1.0) * (COLOR_STOPS - 1) as f64;
    let i = ((COLOR_STOPS - 2) as f64).min(y.floor()) as usize;
    let f = y - i as f64;
    let (a, b) = (64 + i * 4, 64 + i * 4 + 4);
    let intensity = mix(r[a + 3] as f64, r[b + 3] as f64, f);
    let add = r[19] as f64 == ADD as f64;
    let dim = !add && intensity < 1.0;
    let mut out = [0.0; 4];
    for c in 0..3 {
        out[c] = mix(r[a + c] as f64, r[b + c] as f64, f) * if dim { 1.0 } else { intensity };
    }
    let peak = if add { 1.0 } else { 1.0f64.max(out[0]).max(out[1]).max(out[2]) };
    for v in out.iter_mut().take(3) {
        *v = (*v / peak).min(1.0);
    }
    out[3] = mix(r[96 + i] as f64, r[97 + i] as f64, f) * if dim { intensity.max(0.0) } else { 1.0 };
    out
}

/// `evaluateParticle`: instance `ii` of a draw, or `None` when it is not alive
/// (unborn, dead, thinned, faded out, or of no size or opacity).
pub fn evaluate(batch: &Batch, draw: &Draw, ii: u32) -> Option<Particle> {
    let r = batch.record(draw);
    let t = &batch.table;
    let v = |i: usize| r[i] as f64;
    let te = stepped_time(r);
    let seed = r[7] as u32;
    let (start, emit_dur, k_count, rate) = (v(0), v(1), v(2), v(3));
    let (n, born);
    if emit_dur <= 0.0 {
        n = ii as f64;
        born = start + hash(n, 1, seed) * v(41);
    } else {
        let rr = rate.max(1e-4);
        let span = te - start;
        if span < 0.0 {
            return None;
        }
        let n_max = (span * rr).floor();
        let m = ((n_max - ii as f64) % k_count + k_count) % k_count;
        let ni = n_max - m;
        if ni < 0.0 {
            return None;
        }
        n = ni;
        born = start + (ni + hash(n, 1, seed)) / rr;
        if born > start + emit_dur {
            return None;
        }
    }
    let age = te - born;
    let life = mix(v(4), v(5), hash(n, 2, seed));
    if age < 0.0 || age >= life {
        return None;
    }
    let an = age / life;
    let (tick0, ticks, tb) = (v(31), v(32), v(30));
    let fb = born.floor();
    let k = clamp(fb - tick0, 0.0, ticks - 1.0);
    let k1 = (k + 1.0).min(ticks - 1.0);
    let fr = clamp(born - fb, 0.0, 1.0);
    let row = |kk: f64, c: usize| t[((tb + kk * 2.0) * 4.0) as usize + c] as f64;
    let row2 = |kk: f64, c: usize| t[((tb + kk * 2.0 + 1.0) * 4.0) as usize + c] as f64;
    if hash(n, 15, seed) >= row(k, 2) {
        return None;
    }
    let mut fade = 1.0;
    if v(52) > 0.0 {
        fade *= clamp((born - v(50)) / v(52), 0.0, 1.0);
    }
    if v(53) > 0.0 {
        fade *= clamp((v(51) - born) / v(53), 0.0, 1.0);
    }
    if fade <= 0.001 {
        return None;
    }
    let (ax, ay) = (mix(row(k, 0), row(k1, 0), fr), mix(row(k, 1), row(k1, 1), fr));
    let (mut px, mut py): (f64, f64);
    let mut base = v(10) + row(k, 3);
    // Squash flattens point and ring emitters into the plane an orbit turns in.
    let sq = v(123);
    let (r1, r2) = (hash(n, 3, seed), hash(n, 4, seed));
    let da = hash(n, 10, seed) * TAU;
    let dr = hash(n, 9, seed).sqrt();
    let (dx, dy) = (styk_math::cos(da) * dr, styk_math::sin(da) * dr * sq);
    let (es, er) = (v(28), v(29));
    let emit = es as u8;
    if emit == BODY && v(34) > 0.0 {
        // Shared outline block: one row per birth tick, or one fixed outline.
        let count = v(34);
        let si = (r1 * count).floor().min(count - 1.0);
        let rows = v(35);
        let row_at = if rows > 0.0 { clamp(fb - v(111), 0.0, rows - 1.0) } else { 0.0 };
        let s = ((v(33) + row_at * count + si) * 4.0) as usize;
        px = mix(t[s] as f64, t[s + 2] as f64, r2) + dx * er;
        py = mix(t[s + 1] as f64, t[s + 3] as f64, r2) + dy * er;
    } else if emit == BEAM_LINE || emit == BEAM_TIP {
        let [bx, by] = beam_tip(r, te);
        let (ex, ey) = (bx - v(36), by - v(37));
        let len = styk_math::hypot(ex, ey).max(1e-3);
        base += styk_math::atan2(ey, ex);
        if emit == BEAM_LINE {
            px = mix(v(36), bx, r2) - ey / len * (r1 - 0.5) * 2.0 * er;
            py = mix(v(37), by, r2) + ex / len * (r1 - 0.5) * 2.0 * er;
        } else {
            px = bx + dx * er;
            py = by + dy * er;
        }
    } else if emit == EMIT_RING {
        px = ax + styk_math::cos(r1 * TAU) * er;
        py = ay + styk_math::sin(r1 * TAU) * er * sq;
    } else if emit == GROUND {
        px = ax + (r1 - 0.5) * 2.0 * er;
        py = v(45) - 3.0;
    } else if emit == LINE {
        px = ax - styk_math::sin(base) * (r1 - 0.5) * 2.0 * er;
        py = ay + styk_math::cos(base) * (r1 - 0.5) * 2.0 * er;
    } else if emit == STAGE {
        // The stage edge the particles travel away from, spanning the whole stage.
        let (cx, cy) = (styk_math::cos(base), styk_math::sin(base));
        let half = cx.abs() * v(46) / 2.0 + cy.abs() * v(47) / 2.0 + 20.0;
        let span = (cy.abs() * v(46) + cx.abs() * v(47)) * 1.2;
        px = v(46) / 2.0 - cx * half - cy * (r1 - 0.5) * span;
        py = v(47) / 2.0 - cy * half + cx * (r1 - 0.5) * span;
    } else {
        px = ax + dx * er;
        py = ay + dy * er;
    }
    let ang = base + (hash(n, 5, seed) - 0.5) * v(11);
    let (mut vx, mut vy) = (styk_math::cos(ang), styk_math::sin(ang));
    if emit == GROUND {
        let sgn = if hash(n, 11, seed) > 0.5 { 1.0 } else { -1.0 };
        let up = -0.3 * hash(n, 12, seed);
        let l = styk_math::hypot(sgn, up);
        vx = sgn / l;
        vy = up / l;
    }
    if v(14) != 0.0 {
        let (rx, ry) = (px - ax, py - ay);
        let rl = styk_math::hypot(rx, ry);
        if rl > 1e-3 {
            let sg = sign(v(14));
            let w = v(14).abs();
            let mx = vx + (rx / rl * sg - vx) * w + 1e-5;
            let my = vy + (ry / rl * sg - vy) * w;
            let ml = styk_math::hypot(mx, my);
            vx = mx / ml;
            vy = my / ml;
        }
    }
    let spd = mix(v(8), v(9), hash(n, 6, seed)) * row2(k, 0);
    vx *= spd;
    vy *= spd;
    if v(40) != 0.0 {
        let kp = (k - 1.0).max(0.0);
        vx += v(40) * (row(k, 0) - row(kp, 0));
        vy += v(40) * (row(k, 1) - row(kp, 1));
    }
    // Launch velocity with drag, plus constant gravity and wind accelerations.
    let (p0x, p0y, g, gx, kd) = (px, py, v(12), v(127), v(13));
    let (gdx, gdy, gvx, gvy);
    if kd > 1e-4 {
        let e = styk_math::exp(-kd * age);
        let q = (1.0 - e) / kd;
        let w = (age - q) / kd;
        px += vx * q;
        py += vy * q;
        vx *= e;
        vy *= e;
        gdx = gx * w;
        gdy = g * w;
        gvx = gx * q;
        gvy = g * q;
    } else {
        let h = 0.5 * age * age;
        px += vx * age;
        py += vy * age;
        gdx = gx * h;
        gdy = g * h;
        gvx = gx * age;
        gvy = g * age;
    }
    // Orbit around the emission anchor: a flattened ring around the vertical axis
    // at each particle's own height for body, line and ground emitters, otherwise
    // a turn of the whole offset in the squashed plane.
    let orb = v(117);
    if orb != 0.0 {
        let a = orb * age;
        let (c, s) = (styk_math::cos(a), styk_math::sin(a));
        let rx = px - ax;
        let wx = vx;
        if emit == BODY || emit == LINE || emit == GROUND {
            px = ax + rx * c;
            py += rx * s * sq;
            vx = wx * c - orb * rx * s;
            vy += (wx * s + orb * rx * c) * sq;
        } else {
            let ry = (py - ay) / sq;
            let wy = vy / sq;
            let nx = rx * c - ry * s;
            let ny = rx * s + ry * c;
            px = ax + nx;
            py = ay + ny * sq;
            vx = wx * c - wy * s - orb * ny;
            vy = (wx * s + wy * c + orb * nx) * sq;
        }
    }
    px += gdx;
    py += gdy;
    vx += gvx;
    vy += gvy;
    if v(15) > 0.0 {
        let qx = p0x * v(16) + hash(n, 7, seed) * 37.0;
        let qy = p0y * v(16);
        let tt = te * 0.035;
        let nx = vnoise(qx + tt, qy) * 2.0 - 1.0;
        let ny = vnoise(qx + 19.1, qy + tt) * 2.0 - 1.0;
        px += nx * v(15) * an;
        py += ny * v(15) * an;
        vx += nx * v(15) / life;
        vy += ny * v(15) / life;
    }
    // Curl noise: a divergence-free flow sampled where the particle is, so
    // neighbours swirl together like smoke.
    if v(118) > 0.0 {
        let sc = v(119);
        let (qx, qy) = (px * sc, py * sc);
        let tt = te * 0.02;
        let e = 0.35;
        let psi = |x: f64, y: f64| vnoise(x + tt, y) + 0.5 * vnoise(x * 2.03 + 13.7, y * 2.03 - tt);
        let p0 = psi(qx, qy);
        let gxn = psi(qx + e, qy) - p0;
        let gyn = psi(qx, qy + e) - p0;
        let amount = v(118) * an / e;
        px += gyn * amount;
        py -= gxn * amount;
    }
    if v(44) > 0.5 && py > v(45) - 1.5 {
        py = v(45) - 1.5;
        vy = 0.0;
    }
    let sm = v(120) as u8;
    let grow = if sm == GROW_PUFF {
        let q = 1.0 - an;
        1.0 - q * q * q
    } else if sm == GROW_POP {
        let q = 1.0 - (an * 4.0).min(1.0);
        1.0 - q * q
    } else {
        styk_math::pow(an.max(1e-6), v(43))
    };
    let mut size = row2(k, 1) * mix(v(20), v(21), grow) * (1.0 + (hash(n, 8, seed) - 0.5) * 2.0 * v(42)) * mix(0.3, 1.0, fade);
    if sm == GROW_POP {
        size *= 1.0 - smoothstep(0.6, 1.0, an);
    } else if sm == GROW_FLICKER {
        let h = hash(n, 21, seed);
        size *= 0.55 + 0.9 * vnoise(te * 0.45 + h * 61.7, h * 17.3);
    }
    // Echo, halo and outline draws scale or widen the same particle.
    size = if size > 0.0 { size * v(121) + v(122) } else { 0.0 };
    let fi = if v(24) <= 0.0 { 1.0 } else { smoothstep(0.0, v(24), an) };
    let fo = if v(25) <= 0.0 { 1.0 } else { 1.0 - smoothstep(1.0 - v(25), 1.0, an) };
    let mut alpha = v(26) * fi * fo * fade;
    if v(124) > 0.0 {
        let h = hash(n, 22, seed);
        alpha *= 1.0 - v(124) * vnoise(te * 0.8 + h * 53.1, h * 29.7);
    }
    let rm = v(115) as u8;
    let rotation = if rm == ROTATE_MOTION {
        if vx * vx + vy * vy > 1e-6 { styk_math::atan2(vy, vx) + PI / 2.0 } else { 0.0 }
    } else if rm == ROTATE_UPRIGHT {
        (hash(n, 13, seed) - 0.5) * 0.35
    } else if rm == ROTATE_FIXED {
        0.0
    } else {
        hash(n, 13, seed) * TAU + v(17) * age * (1.0 + v(116) * ((hash(n, 19, seed) * 2.0 - 1.0) * 1.5 - 1.0))
    };
    let mut variant = 0;
    if v(112) > 0.0 && v(18) == SPRITE as f64 {
        let code = v(113);
        let cells = (code % 16.0).max(1.0);
        let frame_rate = v(126);
        let mut vi = (cells - 1.0).min((hash(n, 20, seed) * cells).floor());
        if frame_rate > 0.0 {
            vi = (vi + (age / frame_rate).floor()) % cells;
        }
        variant = ((code / 16.0).floor() + vi) as u32;
    }
    let size = size.max(0.0);
    (alpha > 0.0 && size > 0.0).then_some(Particle {
        x: px,
        y: py,
        vx,
        vy,
        size,
        alpha,
        color: if v(27) > 0.5 { hash(n, 16, seed) } else { an },
        rotation,
        variant,
        n,
    })
}

/// `Math.sign`.
fn sign(x: f64) -> f64 {
    if x > 0.0 {
        1.0
    } else if x < 0.0 {
        -1.0
    } else {
        x
    }
}

/// A beam's quad as the editor's vertex shader builds it: its origin and tip,
/// width (0 when it is not drawn) and time.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BeamQuad {
    pub a: [f64; 2],
    pub b: [f64; 2],
    pub width: f64,
    pub te: f64,
}

/// The beam of a beam draw at its tick, or `None` before it fires and after it ends.
pub fn beam(batch: &Batch, draw: &Draw) -> Option<BeamQuad> {
    let r = batch.record(draw);
    let te = stepped_time(r);
    if te < r[59] as f64 - 1.0 || te > r[60] as f64 {
        return None;
    }
    let mut w = r[56] as f64 * beam_width(r, te);
    if w > 0.05 {
        w = w * r[121] as f64 + r[122] as f64;
    }
    if w <= 0.05 {
        return None;
    }
    Some(BeamQuad { a: [r[36] as f64, r[37] as f64], b: beam_tip(r, te), width: w, te })
}

/// One segment of a lightning arc: its ends, radius, colour and opacity.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ArcSegment {
    pub p0: [f64; 2],
    pub p1: [f64; 2],
    pub radius: f64,
    pub rgb: [f64; 3],
    pub alpha: f64,
}

/// Instance `ii` of an arc draw (arcs of `arcSegs` segments each), or `None`.
pub fn arc_segment(batch: &Batch, draw: &Draw, ii: u32) -> Option<ArcSegment> {
    let r = batch.record(draw);
    let te = stepped_time(r);
    if te < r[59] as f64 + r[58] as f64 || te > r[60] as f64 {
        return None;
    }
    let segs = (r[62] as u32).max(1);
    let (arc, k) = (ii / segs, ii % segs);
    let seed = r[7] as u32;
    let key = pcg(seed.wrapping_add(arc.wrapping_mul(7919)).wrapping_add(int32((te / 2.0).floor()).wrapping_mul(104729)));
    if hash(arc as f64, 99, key) < 0.3 {
        return None;
    }
    let a = [r[36] as f64, r[37] as f64];
    let b = beam_tip(r, te);
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let len = styk_math::hypot(dx, dy).max(1.0);
    let (nx, ny) = (-dy / len, dx / len);
    let (f0, f1) = (k as f64 / segs as f64, (k + 1) as f64 / segs as f64);
    let amp = r[63] as f64 * (0.6 + 0.8 * hash(arc as f64, 98, key));
    let o0 = (hash(k as f64, 3, key) - 0.5) * 2.0 * amp * styk_math::sin(PI * f0);
    let o1 = (hash((k + 1) as f64, 3, key) - 0.5) * 2.0 * amp * styk_math::sin(PI * f1);
    let col = ramp(r, 0.0);
    let alpha = r[26] as f64 * col[3] * beam_width(r, te);
    (alpha > 0.0).then_some(ArcSegment {
        p0: [mix(a[0], b[0], f0) + nx * o0, mix(a[1], b[1], f0) + ny * o0],
        p1: [mix(a[0], b[0], f1) + nx * o1, mix(a[1], b[1], f1) + ny * o1],
        radius: r[20] as f64,
        rgb: [col[0], col[1], col[2]],
        alpha,
    })
}
