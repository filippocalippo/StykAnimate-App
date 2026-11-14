//! One particle of a batch: a pure function of its draw, the batch's table, its
//! instance index and the tick, so seeking, playback and export draw the same
//! particles. A particle's birth (when, where, which of the layer's keyed
//! parameters, its random choices) is worked out once; where it is at an age is
//! then cheap, which trails use. Arithmetic is [`super::fastmath`]: the same on
//! every platform.

use std::f64::consts::PI;

use super::batch::{row, Batch, Draw, SEGMENT};
use super::fastmath as fm;
use super::layers::*;

const TAU: f64 = PI * 2.0;
const INV32: f64 = 1.0 / 4294967296.0;

/// The PCG hash the shaders use.
#[inline]
pub fn pcg(v: u32) -> u32 {
    let s = v.wrapping_mul(747796405).wrapping_add(2891336453);
    let w = ((s >> ((s >> 28) + 4)) ^ s).wrapping_mul(277803737);
    (w >> 22) ^ w
}

#[inline]
fn int32(n: f64) -> u32 {
    if n.is_finite() { (n as i64) as u32 } else { 0 }
}

/// A uniform number in [0, 1) for particle `n`, channel `k` of a layer's `seed`.
#[inline]
pub fn hash(n: f64, k: u32, seed: u32) -> f64 {
    let inner = pcg(int32(n) ^ seed.wrapping_mul(1664525));
    (pcg(inner.wrapping_add(k.wrapping_mul(1013904223))) as f32) as f64 * INV32
}

#[inline]
fn hash2(x: f64, y: f64) -> f64 {
    (pcg(int32(x).wrapping_mul(73856093) ^ int32(y).wrapping_mul(19349663)) as f32) as f64 * INV32
}

#[inline]
fn mix(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

#[inline]
pub fn smoothstep(a: f64, b: f64, x: f64) -> f64 {
    let t = clamp((x - a) / (b - a), 0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Smooth value noise.
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
    /// The layer parameters it was born with ([`Batch::specs`]).
    pub spec: u32,
    /// How far it reaches from its centre (shape, stretch and aspect included).
    pub reach: f64,
}

/// What is known of a particle at its birth.
#[derive(Clone, Copy, Debug)]
pub struct Birth {
    pub n: f64,
    /// In the effect's time.
    pub born: f64,
    pub life: f64,
    pub spec: u32,
    /// The emitter's place and its velocity per frame of the effect's time.
    anchor: [f64; 2],
    /// Where and how fast it was launched.
    p0: [f64; 2],
    v0: [f64; 2],
    scale: f64,
    size_key: f64,
    ground: f64,
    fade: f64,
}

/// Evaluates the particles of one draw at one tick.
pub struct Evaluator<'a> {
    pub batch: &'a Batch,
    pub draw: &'a Draw,
    spec: &'a Spec,
    /// The stepped tick, and the effect's own time then.
    te: f64,
    now: f64,
}

/// The tick held on twos or threes, counted from the clip's start.
pub fn stepped_time(draw: &Draw, tick: f64) -> f64 {
    if draw.step > 1.0 { draw.clip[0] + ((tick - draw.clip[0]) / draw.step).floor() * draw.step } else { tick }
}

impl<'a> Evaluator<'a> {
    pub fn new(batch: &'a Batch, draw: &'a Draw) -> Evaluator<'a> {
        Evaluator::at(batch, draw, draw.tick)
    }

    /// At another tick of the draw's document (a trail's earlier place).
    pub fn at(batch: &'a Batch, draw: &'a Draw, tick: f64) -> Evaluator<'a> {
        let te = stepped_time(draw, tick);
        Evaluator { batch, draw, spec: batch.spec(draw), te, now: draw.t0 + (te - draw.t0) * draw.time_scale }
    }

    /// The effect's own time.
    pub fn local(&self) -> f64 {
        self.now
    }

    /// The stepped tick.
    pub fn tick(&self) -> f64 {
        self.te
    }

    fn row(&self, k: usize) -> &[f32] {
        self.batch.row(self.draw, k)
    }

    /// Instance `ii`'s birth, or `None` when it is not alive (unborn, dead, thinned, faded out).
    pub fn birth(&self, ii: u32) -> Option<Birth> {
        let d = self.draw;
        let seed = d.seed;
        let (n, born);
        if d.emit_dur <= 0.0 {
            n = ii as f64;
            born = d.start + hash(n, 1, seed) * self.spec.burst_jitter;
        } else {
            let rr = d.rate.max(1e-4);
            let span = self.now - d.start;
            if span < 0.0 {
                return None;
            }
            let count = d.count as f64;
            let n_max = (span * rr).floor();
            let m = ((n_max - ii as f64) % count + count) % count;
            let ni = n_max - m;
            if ni < 0.0 {
                return None;
            }
            n = ni;
            born = d.start + (ni + hash(n, 1, seed)) / rr;
            if born > d.start + d.emit_dur {
                return None;
            }
        }
        let age = self.now - born;
        if age < 0.0 {
            return None;
        }
        // Its row: the tick it was born on.
        let real = d.t0 + (born - d.t0) / d.time_scale;
        let fb = real.floor();
        let ticks = d.ticks as f64;
        let k = clamp(fb - d.tick0, 0.0, ticks - 1.0) as usize;
        let k1 = (k + 1).min(d.ticks as usize - 1);
        let fr = clamp(real - fb, 0.0, 1.0);
        let r = self.row(k);
        // Thinning: each particle keeps its own chance, so the same ones stay.
        if hash(n, 15, seed) >= r[row::EMIT] as f64 * d.keep {
            return None;
        }
        let spec_index = r[row::SPEC] as u32;
        let s = &*self.batch.specs[spec_index as usize];
        let life = mix(s.life_min, s.life_max, hash(n, 2, seed));
        if age >= life {
            return None;
        }
        let mut fade = 1.0;
        if s.clip_fade_in > 0.0 {
            fade *= clamp((real - d.clip[0]) / s.clip_fade_in, 0.0, 1.0);
        }
        if s.clip_fade_out > 0.0 {
            fade *= clamp((d.clip[1] - real) / s.clip_fade_out, 0.0, 1.0);
        }
        if fade <= 0.001 {
            return None;
        }
        let r1 = self.row(k1);
        let (ax, ay) = (mix(r[row::X] as f64, r1[row::X] as f64, fr), mix(r[row::Y] as f64, r1[row::Y] as f64, fr));
        let scale = r[row::SCALE] as f64;
        let mut base = s.angle + r[row::DIR] as f64;
        let sq = s.squash.max(0.05);
        let (h3, h4) = (hash(n, 3, seed), hash(n, 4, seed));
        let er = s.emit_radius * scale;
        let (px, py);
        match s.emit_shape {
            BODY if d.block.is_some() => {
                let b = d.block.unwrap();
                let count = b.segments as usize;
                let row_at = if b.rows > 1 { clamp(fb - b.first, 0.0, (b.rows - 1) as f64) as usize } else { 0 };
                let o = b.start as usize + row_at * count * SEGMENT;
                let t = &self.batch.table;
                let lengths = &t[o + count * 4..o + count * 5];
                // A place on the outline by length: long limbs emit as much as their length.
                let total = lengths[count - 1] as f64;
                let u = h3 * total;
                let si = lengths.partition_point(|&l| (l as f64) < u).min(count - 1);
                let before = if si == 0 { 0.0 } else { lengths[si - 1] as f64 };
                let len = (lengths[si] as f64 - before).max(1e-6);
                let f = if total > 0.0 { clamp((u - before) / len, 0.0, 1.0) } else { h4 };
                let s4 = o + si * 4;
                let (dx, dy) = disc_offset(n, seed, sq);
                px = mix(t[s4] as f64, t[s4 + 2] as f64, f) + dx * er;
                py = mix(t[s4 + 1] as f64, t[s4 + 3] as f64, f) + dy * er;
            }
            BEAM_LINE | BEAM_TIP => {
                let [bx, by] = beam_tip(d, self.spec, self.now);
                let (ex, ey) = (bx - d.point[0], by - d.point[1]);
                let len = fm::hypot(ex, ey).max(1e-3);
                base += fm::atan2(ey, ex);
                if s.emit_shape == BEAM_LINE {
                    px = mix(d.point[0], bx, h4) - ey / len * (h3 - 0.5) * 2.0 * er;
                    py = mix(d.point[1], by, h4) + ex / len * (h3 - 0.5) * 2.0 * er;
                } else {
                    let (dx, dy) = disc_offset(n, seed, sq);
                    px = bx + dx * er;
                    py = by + dy * er;
                }
            }
            EMIT_RING => {
                let (sn, cs) = fm::sin_cos(h3 * TAU);
                px = ax + cs * er;
                py = ay + sn * er * sq;
            }
            GROUND => {
                px = ax + (h3 - 0.5) * 2.0 * er;
                py = r[row::GROUND] as f64 - 3.0;
            }
            LINE => {
                let (sn, cs) = fm::sin_cos(base);
                px = ax - sn * (h3 - 0.5) * 2.0 * er;
                py = ay + cs * (h3 - 0.5) * 2.0 * er;
            }
            STAGE => {
                // The stage edge the particles travel away from, spanning the whole stage.
                let (cy, cx) = fm::sin_cos(base);
                let (w, h) = (d.canvas[0], d.canvas[1]);
                let half = cx.abs() * w / 2.0 + cy.abs() * h / 2.0 + 20.0;
                let span = (cy.abs() * w + cx.abs() * h) * 1.2;
                px = w / 2.0 - cx * half - cy * (h3 - 0.5) * span;
                py = h / 2.0 - cy * half + cx * (h3 - 0.5) * span;
            }
            _ => {
                if er != 0.0 {
                    let (dx, dy) = disc_offset(n, seed, sq);
                    px = ax + dx * er;
                    py = ay + dy * er;
                } else {
                    px = ax;
                    py = ay;
                }
            }
        }
        let ang = base + (hash(n, 5, seed) - 0.5) * s.spread;
        let (sn, cs) = fm::sin_cos(ang);
        let (mut vx, mut vy) = (cs, sn);
        if s.emit_shape == GROUND {
            let sgn = if hash(n, 11, seed) > 0.5 { 1.0 } else { -1.0 };
            let up = -0.3 * hash(n, 12, seed);
            let l = fm::hypot(sgn, up);
            vx = sgn / l;
            vy = up / l;
        }
        if s.radial != 0.0 {
            let (rx, ry) = (px - ax, py - ay);
            let rl = fm::hypot(rx, ry);
            if rl > 1e-3 {
                let sg = s.radial.signum();
                let w = s.radial.abs();
                let mx = vx + (rx / rl * sg - vx) * w + 1e-5;
                let my = vy + (ry / rl * sg - vy) * w;
                let ml = fm::hypot(mx, my);
                vx = mx / ml;
                vy = my / ml;
            }
        }
        let spd = mix(s.speed_min, s.speed_max, hash(n, 6, seed)) * r[row::SPEED] as f64 * scale;
        vx *= spd;
        vy *= spd;
        if s.inherit != 0.0 && k > 0 {
            // The emitter's own velocity, per frame of the effect's time.
            let rp = self.row(k - 1);
            let per = 1.0 / d.time_scale;
            vx += s.inherit * (r[row::X] - rp[row::X]) as f64 * per;
            vy += s.inherit * (r[row::Y] - rp[row::Y]) as f64 * per;
        }
        Some(Birth { n, born, life, spec: spec_index, anchor: [ax, ay], p0: [px, py], v0: [vx, vy], scale, size_key: r[row::SIZE] as f64, ground: r[row::GROUND] as f64, fade })
    }

    /// Where a born particle is at `age`, and its velocity: launch, drag, gravity and
    /// wind, orbit, the ground, turbulence and flow.
    pub fn motion(&self, b: &Birth, age: f64) -> ([f64; 2], [f64; 2]) {
        let s = &*self.batch.specs[b.spec as usize];
        let seed = self.draw.seed;
        let (ax, ay) = (b.anchor[0], b.anchor[1]);
        let sc = b.scale;
        let (g, gx, kd) = (s.gravity * sc, s.wind * sc, s.drag);
        let ballistic = |t: f64| -> [f64; 4] {
            let (vx, vy) = (b.v0[0], b.v0[1]);
            if kd > 1e-4 {
                let e = fm::exp(-kd * t);
                let q = (1.0 - e) / kd;
                let w = (t - q) / kd;
                [b.p0[0] + vx * q + gx * w, b.p0[1] + vy * q + g * w, vx * e + gx * q, vy * e + g * q]
            } else {
                let h = 0.5 * t * t;
                [b.p0[0] + vx * t + gx * h, b.p0[1] + vy * t + g * h, vx + gx * t, vy + g * t]
            }
        };
        let [mut px, mut py, mut vx, mut vy] = ballistic(age);
        // Orbit around the emission anchor.
        let orb = s.orbit;
        if orb != 0.0 {
            let (sn, c) = fm::sin_cos(orb * age);
            let sq = s.squash.max(0.05);
            // The orbit turns the launch motion only; gravity and wind stay as they are.
            let [lx, ly, lvx, lvy] = {
                let gless = if kd > 1e-4 {
                    let w = (age - (1.0 - fm::exp(-kd * age)) / kd) / kd;
                    [gx * w, g * w, gx * (1.0 - fm::exp(-kd * age)) / kd, g * (1.0 - fm::exp(-kd * age)) / kd]
                } else {
                    let h = 0.5 * age * age;
                    [gx * h, g * h, gx * age, g * age]
                };
                [px - gless[0], py - gless[1], vx - gless[2], vy - gless[3]]
            };
            let (gpx, gpy, gvx, gvy) = (px - lx, py - ly, vx - lvx, vy - lvy);
            let rx = lx - ax;
            let (mut nx, mut ny, mut nvx, mut nvy);
            if s.emit_shape == BODY || s.emit_shape == LINE || s.emit_shape == GROUND {
                nx = ax + rx * c;
                ny = ly + rx * sn * sq;
                nvx = lvx * c - orb * rx * sn;
                nvy = lvy + (lvx * sn + orb * rx * c) * sq;
            } else {
                let ry = (ly - ay) / sq;
                let (wx, wy) = (lvx, lvy / sq);
                let (ox, oy) = (rx * c - ry * sn, rx * sn + ry * c);
                nx = ax + ox;
                ny = ay + oy * sq;
                nvx = wx * c - wy * sn - orb * oy;
                nvy = (wx * sn + wy * c + orb * ox) * sq;
            }
            nx += gpx;
            ny += gpy;
            nvx += gvx;
            nvy += gvy;
            px = nx;
            py = ny;
            vx = nvx;
            vy = nvy;
        }
        // The ground: land, bounce, slide to a stop.
        if s.collide > 0.5 {
            let gl = b.ground - 1.5;
            if py > gl && g > 0.0 {
                let start = ballistic(0.0);
                let t1 = if start[1] >= gl {
                    0.0
                } else {
                    let (mut lo, mut hi) = (0.0, age);
                    for _ in 0..16 {
                        let mid = 0.5 * (lo + hi);
                        if ballistic(mid)[1] > gl { hi = mid } else { lo = mid }
                    }
                    hi
                };
                let land = ballistic(t1);
                let (mut x, mut hvx, mut vfall, mut rest) = (land[0], land[2], land[3].max(0.0), age - t1);
                let mut bounce = s.bounce;
                let mut y = gl;
                let mut vy_out = 0.0;
                for _ in 0..3 {
                    let up = vfall * bounce;
                    if up < 0.6 || g <= 0.0 {
                        break;
                    }
                    let flight = 2.0 * up / g;
                    hvx *= 0.8;
                    if rest < flight {
                        x += hvx * rest;
                        y = gl - up * rest + 0.5 * g * rest * rest;
                        vy_out = -up + g * rest;
                        rest = -1.0;
                        break;
                    }
                    x += hvx * flight;
                    rest -= flight;
                    vfall = up;
                    bounce *= 0.6;
                }
                if rest >= 0.0 {
                    // Sliding: friction stops it.
                    let k = s.friction.max(0.01);
                    let e = fm::exp(-k * rest);
                    x += hvx * (1.0 - e) / k;
                    hvx *= e;
                    y = gl;
                    vy_out = 0.0;
                }
                px = x;
                py = y;
                vx = hvx;
                vy = vy_out;
            }
        }
        let an = age / b.life;
        let n = b.n;
        if s.turb > 0.0 {
            let ts = s.turb_scale / sc;
            let qx = b.p0[0] * ts + hash(n, 7, seed) * 37.0;
            let qy = b.p0[1] * ts;
            let tt = self.now * 0.035;
            let nx = vnoise(qx + tt, qy) * 2.0 - 1.0;
            let ny = vnoise(qx + 19.1, qy + tt) * 2.0 - 1.0;
            let amount = s.turb * sc;
            px += nx * amount * an;
            py += ny * amount * an;
            vx += nx * amount / b.life;
            vy += ny * amount / b.life;
        }
        // Curl noise: a divergence-free flow sampled where the particle is, so
        // neighbours swirl together like smoke.
        if s.curl > 0.0 {
            let cs = s.curl_scale / sc;
            let (qx, qy) = (px * cs, py * cs);
            let tt = self.now * 0.02;
            let e = 0.35;
            let psi = |x: f64, y: f64| vnoise(x + tt, y) + 0.5 * vnoise(x * 2.03 + 13.7, y * 2.03 - tt);
            let p0 = psi(qx, qy);
            let gxn = psi(qx + e, qy) - p0;
            let gyn = psi(qx, qy + e) - p0;
            let amount = s.curl * sc * an / e;
            px += gyn * amount;
            py -= gxn * amount;
        }
        ([px, py], [vx, vy])
    }

    /// Instance `ii` now, or `None` when it is not alive or not seen.
    pub fn particle(&self, ii: u32) -> Option<Particle> {
        let b = self.birth(ii)?;
        self.at_age(&b, self.now - b.born)
    }

    /// A born particle at `age`.
    pub fn at_age(&self, b: &Birth, age: f64) -> Option<Particle> {
        if age < 0.0 || age >= b.life {
            return None;
        }
        let s = &*self.batch.specs[b.spec as usize];
        let seed = self.draw.seed;
        let n = b.n;
        let ([px, py], [vx, vy]) = self.motion(b, age);
        let an = age / b.life;
        let grow = match s.size_mode {
            GROW_PUFF => {
                let q = 1.0 - an;
                1.0 - q * q * q
            }
            GROW_POP => {
                let q = 1.0 - (an * 4.0).min(1.0);
                1.0 - q * q
            }
            _ => fm::powf(an.max(1e-6), s.size_curve),
        };
        let mut size = b.size_key * b.scale * mix(s.size0, s.size1, grow) * (1.0 + (hash(n, 8, seed) - 0.5) * 2.0 * s.size_jitter) * mix(0.3, 1.0, b.fade);
        if s.size_mode == GROW_POP {
            size *= 1.0 - smoothstep(0.6, 1.0, an);
        } else if s.size_mode == GROW_FLICKER {
            let h = hash(n, 21, seed);
            size *= 0.55 + 0.9 * vnoise(self.now * 0.45 + h * 61.7, h * 17.3);
        }
        let fi = if s.fade_in <= 0.0 { 1.0 } else { smoothstep(0.0, s.fade_in, an) };
        let fo = if s.fade_out <= 0.0 { 1.0 } else { 1.0 - smoothstep(1.0 - s.fade_out, 1.0, an) };
        let mut alpha = s.alpha * self.draw.alpha * fi * fo * b.fade;
        if s.flicker > 0.0 {
            let h = hash(n, 22, seed);
            alpha *= 1.0 - s.flicker * vnoise(self.now * 0.8 + h * 53.1, h * 29.7);
        }
        let rotation = match s.rotate {
            ROTATE_MOTION => {
                if vx * vx + vy * vy > 1e-6 { fm::atan2(vy, vx) + PI / 2.0 } else { 0.0 }
            }
            ROTATE_UPRIGHT => (hash(n, 13, seed) - 0.5) * 0.35,
            ROTATE_FIXED => 0.0,
            _ => hash(n, 13, seed) * TAU + s.spin * age * (1.0 + s.spin_jitter * ((hash(n, 19, seed) * 2.0 - 1.0) * 1.5 - 1.0)),
        };
        let mut variant = 0;
        if let Some(m) = s.material
            && s.shape == SPRITE
        {
            let cells = m.count.max(1) as f64;
            let mut vi = (cells - 1.0).min((hash(n, 20, seed) * cells).floor());
            if s.frame_rate > 0.0 {
                vi = (vi + (age / s.frame_rate).floor()) % cells;
            }
            variant = m.col + vi as u32;
        }
        let size = size.max(0.0);
        if alpha <= 0.0 || size <= 0.0 {
            return None;
        }
        let speed = fm::hypot(vx, vy);
        let reach = match s.shape {
            RING => size * (1.0 + s.softness * 2.0),
            STREAK => size + speed * s.stretch,
            SPRITE => size.max(size * s.aspect + 0.5 * speed * s.stretch),
            SQUARE | CHUNK => size * 1.42,
            _ => size * s.aspect.max(1.0),
        };
        Some(Particle { x: px, y: py, vx, vy, size, alpha, color: if s.color_mode > 0.5 { hash(n, 16, seed) } else { an }, rotation, variant, n, spec: b.spec, reach })
    }
}

/// How far back a trail copy is per step: its lag rounded up to the drawing's step, so on twos
/// or threes every copy lands on a held frame of its own, never on the particle's.
pub fn trail_lag(lag: f64, step: f64) -> f64 {
    (lag / step.max(1.0)).ceil().max(1.0) * step.max(1.0)
}

/// A point in the unit disc for particle `n` (squashed vertically by `sq`).
#[inline]
fn disc_offset(n: f64, seed: u32, sq: f64) -> (f64, f64) {
    let (sn, cs) = fm::sin_cos(hash(n, 10, seed) * TAU);
    let dr = hash(n, 9, seed).sqrt();
    (cs * dr, sn * dr * sq)
}

/// Instance `ii` of a draw at its tick, or `None`.
pub fn evaluate(batch: &Batch, draw: &Draw, ii: u32) -> Option<Particle> {
    Evaluator::new(batch, draw).particle(ii)
}

/// Where a beam's tip is at the effect's time `te`, travelling from its origin to its aim.
pub fn beam_tip(draw: &Draw, s: &Spec, te: f64) -> [f64; 2] {
    let k = clamp((te - s.fire_start) / s.grow.max(1.0), 0.0, 1.0);
    let e = 1.0 - (1.0 - k) * (1.0 - k);
    [mix(draw.point[0], draw.aim[0], e), mix(draw.point[1], draw.aim[1], e)]
}

/// 0 to 1 as a beam fires and fades.
pub fn beam_width(s: &Spec, te: f64) -> f64 {
    smoothstep(s.fire_start - 1.0, s.fire_start + 2.0, te) * (1.0 - smoothstep(s.fire_end - s.fade_frames, s.fire_end, te))
}

/// The colour at ramp position `x` of `s` drawn with `blend`, 0–1 per channel, and the stop
/// opacity. Additive layers clip bright values toward white; normal layers keep their hue at
/// full saturation, lower intensity becoming transparency.
pub fn ramp(s: &Spec, blend: u8, x: f64) -> [f64; 4] {
    let colors = s.colors.unwrap_or([[1.0, 1.0, 1.0, 1.0]; COLOR_STOPS]);
    let opacity = s.opacity.unwrap_or([1.0; COLOR_STOPS]);
    let y = clamp(x, 0.0, 1.0) * (COLOR_STOPS - 1) as f64;
    let i = ((COLOR_STOPS - 2) as f64).min(y.floor()) as usize;
    let f = y - i as f64;
    let (a, b) = (colors[i], colors[i + 1]);
    let intensity = mix(a[3], b[3], f);
    let add = blend == ADD;
    let dim = !add && intensity < 1.0;
    let mut out = [0.0; 4];
    for c in 0..3 {
        out[c] = mix(a[c], b[c], f) * if dim { 1.0 } else { intensity };
    }
    let peak = if add { 1.0 } else { 1.0f64.max(out[0]).max(out[1]).max(out[2]) };
    for v in out.iter_mut().take(3) {
        *v = (*v / peak).min(1.0);
    }
    out[3] = mix(opacity[i], opacity[i + 1], f) * if dim { intensity.max(0.0) } else { 1.0 };
    out
}

/// A beam's quad: its origin and tip, width (0 when it is not drawn) and time.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BeamQuad {
    pub a: [f64; 2],
    pub b: [f64; 2],
    pub width: f64,
    pub te: f64,
}

/// The beam of a beam draw at its tick, or `None` before it fires and after it ends.
pub fn beam(batch: &Batch, draw: &Draw) -> Option<BeamQuad> {
    let s = batch.spec(draw);
    let te = Evaluator::new(batch, draw).local();
    if te < s.fire_start - 1.0 || te > s.fire_end {
        return None;
    }
    let w = s.beam_w * beam_width(s, te);
    if w <= 0.05 {
        return None;
    }
    Some(BeamQuad { a: draw.point, b: beam_tip(draw, s, te), width: w, te })
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

/// Instance `ii` of an arc draw (arcs of `arc_segs` segments each), or `None`.
pub fn arc_segment(batch: &Batch, draw: &Draw, ii: u32) -> Option<ArcSegment> {
    let s = batch.spec(draw);
    let ev = Evaluator::new(batch, draw);
    let te = ev.local();
    if te < s.fire_start + s.grow || te > s.fire_end {
        return None;
    }
    let segs = (s.arc_segs as u32).max(1);
    let (arc, k) = (ii / segs, ii % segs);
    let seed = draw.seed;
    // A new shape every other frame of the drawing (every frame held on twos or threes).
    let period = (ev.tick() / draw.step.max(2.0)).floor();
    let key = pcg(seed.wrapping_add(arc.wrapping_mul(7919)).wrapping_add(int32(period).wrapping_mul(104729)));
    if hash(arc as f64, 99, key) < 0.3 {
        return None;
    }
    let a = draw.point;
    let b = beam_tip(draw, s, te);
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let len = fm::hypot(dx, dy).max(1.0);
    let (nx, ny) = (-dy / len, dx / len);
    let (f0, f1) = (k as f64 / segs as f64, (k + 1) as f64 / segs as f64);
    let amp = s.arc_amp * (0.6 + 0.8 * hash(arc as f64, 98, key));
    let o0 = (hash(k as f64, 3, key) - 0.5) * 2.0 * amp * fm::sin(PI * f0);
    let o1 = (hash((k + 1) as f64, 3, key) - 0.5) * 2.0 * amp * fm::sin(PI * f1);
    let col = ramp(s, draw.blend, 0.0);
    let alpha = draw.alpha * s.alpha * col[3] * beam_width(s, te);
    (alpha > 0.0).then_some(ArcSegment {
        p0: [mix(a[0], b[0], f0) + nx * o0, mix(a[1], b[1], f0) + ny * o0],
        p1: [mix(a[0], b[0], f1) + nx * o1, mix(a[1], b[1], f1) + ny * o1],
        radius: s.size0,
        rgb: [col[0], col[1], col[2]],
        alpha,
    })
}
