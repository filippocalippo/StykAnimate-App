//! Filter effects on the CPU: an effect stack's recipe (`styk_render::effects::recipe`, the
//! passes the editor's WebGPU executor runs) run pass by pass on the layer's pixels, each
//! operation the arithmetic of styk-render's `passes.wgsl` in single precision, each pass
//! written to an RGBA8 slot as the GPU's are, sampled bilinearly with edges clamped.

use styk_render::effects::recipe::{Run, Step, Uniform, BLANK, SLOTS};

use crate::target::{quantize, Px};

const PI: f32 = std::f32::consts::PI;

/// A working slot: pixels of `size`, rows from the top.
#[derive(Clone, Default)]
struct Slot {
    size: [usize; 2],
    data: Vec<Px>,
}

/// A slot read by a pass: its texels as floats (0–1), converted once.
struct Read {
    size: [usize; 2],
    data: Vec<[f32; 4]>,
}

impl Read {
    fn of(slot: &Slot) -> Read {
        const K: f32 = 1.0 / 255.0;
        Read { size: slot.size, data: slot.data.iter().map(|p| [p[0] as f32 * K, p[1] as f32 * K, p[2] as f32 * K, p[3] as f32 * K]).collect() }
    }

    /// The texel position and weights of `slotAt(at, size)`: `at` in the pass's GL convention
    /// (y up), clamped to the texels of a `size` texture.
    #[inline]
    fn locate(&self, at: [f32; 2], size: [f32; 2]) -> Option<([usize; 4], f32, f32)> {
        let (w, h) = (self.size[0], self.size[1]);
        if w == 0 || h == 0 {
            return None;
        }
        // At least half a texel in, so the texel below is a truncation away.
        let x = (at[0] * size[0]).clamp(0.5, (size[0] - 0.5).max(0.5)) - 0.5;
        let y = ((1.0 - at[1]) * size[1]).clamp(0.5, (size[1] - 0.5).max(0.5)) - 0.5;
        let (ix, iy) = (x as usize, y as usize);
        let (fx, fy) = (x - ix as f32, y - iy as f32);
        let (x0, x1) = (ix.min(w - 1), (ix + 1).min(w - 1));
        let (y0, y1) = (iy.min(h - 1) * w, (iy + 1).min(h - 1) * w);
        Some(([y0 + x0, y0 + x1, y1 + x0, y1 + x1], fx, fy))
    }

    /// `textureSampleLevel(…, slotAt(at, size))`, filtered bilinearly.
    #[inline]
    fn at(&self, at: [f32; 2], size: [f32; 2]) -> [f32; 4] {
        let Some(([i, j, k, l], fx, fy)) = self.locate(at, size) else { return [0.0; 4] };
        let (a, b, c, d) = (self.data[i], self.data[j], self.data[k], self.data[l]);
        [0, 1, 2, 3].map(|n| {
            let top = a[n] + (b[n] - a[n]) * fx;
            let bottom = c[n] + (d[n] - c[n]) * fx;
            top + (bottom - top) * fy
        })
    }

    /// The alpha of [`Read::at`].
    #[inline]
    fn alpha_at(&self, at: [f32; 2], size: [f32; 2]) -> f32 {
        let Some(([i, j, k, l], fx, fy)) = self.locate(at, size) else { return 0.0 };
        let top = self.data[i][3] + (self.data[j][3] - self.data[i][3]) * fx;
        let bottom = self.data[k][3] + (self.data[l][3] - self.data[k][3]) * fx;
        top + (bottom - top) * fy
    }
}

/// Runs `run` (its passes' parameters in `records`) on `input`, a `size` layer; returns the result.
pub(crate) fn run(run: &Run, records: &[Uniform], input: Vec<Px>, size: [usize; 2]) -> Vec<Px> {
    let mut slots: Vec<Slot> = vec![Slot::default(); SLOTS];
    slots[0] = Slot { size, data: input };
    let blank = Slot { size: [1, 1], data: vec![[0; 4]] };
    for step in &run.steps {
        match *step {
            Step::Copy { from, to, size } => {
                let source = &slots[from as usize];
                let (w, h) = (size[0] as usize, size[1] as usize);
                let mut data = vec![[0u8; 4]; w * h];
                for y in 0..h.min(source.size[1]) {
                    let n = w.min(source.size[0]);
                    data[y * w..y * w + n].copy_from_slice(&source.data[y * source.size[0]..y * source.size[0] + n]);
                }
                slots[to as usize] = Slot { size: [w, h], data };
            }
            Step::Pass { source, target, size, original, mask, uniform, .. } => {
                let get = |i: u8| if i == BLANK { &blank } else { &slots[i as usize] };
                let out = pass(&records[uniform as usize], get(source), get(original), get(mask), [size[0] as usize, size[1] as usize]);
                slots[target as usize] = out;
            }
        }
    }
    let mut result = std::mem::take(&mut slots[run.result as usize]);
    if result.size != size {
        // A run always ends at the layer's size; keep the pixels' place should it not.
        let mut data = vec![[0u8; 4]; size[0] * size[1]];
        for y in 0..size[1].min(result.size[1]) {
            let n = size[0].min(result.size[0]);
            data[y * size[0]..y * size[0] + n].copy_from_slice(&result.data[y * result.size[0]..y * result.size[0] + n]);
        }
        result = Slot { size, data };
    }
    result.data
}

fn smoothstep(a: f32, b: f32, x: f32) -> f32 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn mix(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

fn mix4(a: [f32; 4], b: [f32; 4], t: f32) -> [f32; 4] {
    [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t), mix(a[3], b[3], t)]
}

fn hash_value(n0: u32) -> u32 {
    let mut n = n0;
    n ^= n >> 16;
    n = n.wrapping_mul(0x7feb_352d);
    n ^= n >> 15;
    n = n.wrapping_mul(0x846c_a68b);
    n ^= n >> 16;
    n
}

fn hash_point(xy: [f32; 2], seed: f32) -> f32 {
    let (vx, vy) = (xy[0].floor() as i32 as u32, xy[1].floor() as i32 as u32);
    (hash_value(vx.wrapping_mul(1973).wrapping_add(vy.wrapping_mul(9277)).wrapping_add((seed as u32).wrapping_mul(26699))) & 65535) as f32 / 65535.0
}

fn noise_at(pos: [f32; 2], seed: f32, smoothness: f32) -> f32 {
    let i = [pos[0].floor(), pos[1].floor()];
    let f = [pos[0] - i[0], pos[1] - i[1]];
    let f = [mix(0.0, f[0] * f[0] * (3.0 - 2.0 * f[0]), smoothness), mix(0.0, f[1] * f[1] * (3.0 - 2.0 * f[1]), smoothness)];
    mix(
        mix(hash_point(i, seed), hash_point([i[0] + 1.0, i[1]], seed), f[0]),
        mix(hash_point([i[0], i[1] + 1.0], seed), hash_point([i[0] + 1.0, i[1] + 1.0], seed), f[0]),
        f[1],
    )
}

/// The box passes (3, 4) and alpha dilations (5, 6) of a source as large as their target:
/// every sample falls on a texel's centre, so the window is a run of whole texels, those
/// outside the source counting as transparent (`sampleAt` gives nothing there). Summed with
/// prefix sums and maximised with a monotonic queue, so a pass costs the same at any radius.
fn window(u: &Uniform, source: &Slot) -> Slot {
    let [w, h] = source.size;
    let op = u.operation;
    let radius = (u.p[0] as i32).clamp(0, 128) as usize;
    let along_rows = op == 3 || op == 5;
    let (lines, length) = if along_rows { (h, w) } else { (w, h) };
    let at = |line: usize, i: usize| if along_rows { line * w + i } else { i * w + line };
    let mut data = vec![[0u8; 4]; w * h];
    let n = (radius * 2 + 1) as f32;
    let mut prefix = vec![[0u32; 4]; length + 1];
    let mut queue: std::collections::VecDeque<usize> = std::collections::VecDeque::new();
    for line in 0..lines {
        if op == 3 || op == 4 {
            for i in 0..length {
                let p = source.data[at(line, i)];
                prefix[i + 1] = [0, 1, 2, 3].map(|c| prefix[i][c] + p[c] as u32);
            }
            for i in 0..length {
                let (lo, hi) = (i.saturating_sub(radius), (i + radius).min(length - 1));
                let sum = [0, 1, 2, 3].map(|c| prefix[hi + 1][c] - prefix[lo][c]);
                data[at(line, i)] = sum.map(|s| quantize(s as f32 / 255.0 / n));
            }
        } else {
            // The largest alpha within the window, every channel set to it.
            queue.clear();
            let alpha = |i: usize| source.data[at(line, i)][3];
            let mut next = 0;
            for i in 0..length {
                let hi = (i + radius).min(length - 1);
                while next <= hi {
                    while queue.back().is_some_and(|&b| alpha(b) <= alpha(next)) {
                        queue.pop_back();
                    }
                    queue.push_back(next);
                    next += 1;
                }
                while queue.front().is_some_and(|&f| f + radius < i) {
                    queue.pop_front();
                }
                let a = queue.front().map_or(0, |&f| alpha(f));
                data[at(line, i)] = [a; 4];
            }
        }
    }
    Slot { size: [w, h], data }
}

/// One pass of `params.operation` into a new slot of `size`.
fn pass(u: &Uniform, source: &Slot, original: &Slot, mask: &Slot, size: [usize; 2]) -> Slot {
    let dims = u.dimensions;
    if matches!(u.operation, 3..=6) && source.size == size && dims == [size[0] as f32, size[1] as f32] && u.target == dims && size[0] > 0 && size[1] > 0 {
        return window(u, source);
    }
    general(u, source, original, mask, size)
}

/// One pass, every pixel shaded as the fragment stage of passes.wgsl shades it.
fn general(u: &Uniform, source: &Slot, original: &Slot, mask: &Slot, size: [usize; 2]) -> Slot {
    let dims = u.dimensions;
    let target = u.target;
    let (p, q) = (u.p, u.q);
    let op = u.operation;
    let src = Read::of(source);
    // The saved artwork and the inner ring, for the passes that read them.
    let orig = matches!(op, 7 | 15 | 22 | 25 | 26).then(|| Read::of(original));
    let inner = (op == 25).then(|| Read::of(mask));
    let outside = |at: [f32; 2]| at[0] < 0.0 || at[1] < 0.0 || at[0] > 1.0 || at[1] > 1.0;
    let sample = |at: [f32; 2]| -> [f32; 4] { if outside(at) { [0.0; 4] } else { src.at(at, dims) } };
    let alpha_of = |at: [f32; 2]| -> f32 { if outside(at) { 0.0 } else { src.alpha_at(at, dims) } };
    let sample_orig = |at: [f32; 2]| orig.as_ref().map_or([0.0; 4], |o| o.at(at, target));
    let sample_mask = |at: [f32; 2]| inner.as_ref().map_or([0.0; 4], |m| m.at(at, target));
    let global = |uv: [f32; 2]| [uv[0] * dims[0] + u.origin[0], (1.0 - uv[1]) * dims[1] + u.origin[1]];
    let sample_global = |at: [f32; 2]| {
        let pos = [(at[0] - u.origin[0]) / dims[0], (at[1] - u.origin[1]) / dims[1]];
        sample([pos[0], 1.0 - pos[1]])
    };
    let stop_offset = |i: usize| u.stop_offsets[i];
    let brush = |uv: [f32; 2]| -> [f32; 4] {
        if u.paint_type == 0 {
            return u.stops[0];
        }
        let g = global(uv);
        let mut pos = [g[0] / u.output_size[0] - 0.5, g[1] / u.output_size[1] - 0.5];
        let (cs, sn) = (u.paint_angle.cos(), u.paint_angle.sin());
        // mat2x2f(cs, -sn, sn, cs) * pos: columns (cs, -sn) and (sn, cs).
        pos = [cs * pos[0] + sn * pos[1], -sn * pos[0] + cs * pos[1]];
        let mut t = pos[0] + 0.5;
        if u.paint_type == 2 {
            t = (pos[0] * pos[0] + pos[1] * pos[1]).sqrt() * 2.0;
        }
        if u.paint_type == 3 {
            let v = pos[1].atan2(pos[0]) / (2.0 * PI) + 1.0;
            t = v - v.floor();
        }
        if u.paint_type == 4 {
            t = (pos[0].abs() + pos[1].abs()) * 2.0;
        }
        let mut a = u.stops[0];
        let mut offset = stop_offset(0);
        for i in 1..32 {
            if i as i32 >= u.stop_count {
                break;
            }
            let next = stop_offset(i);
            if t < next {
                return mix4(a, u.stops[i], ((t - offset) / 0.00001f32.max(next - offset)).clamp(0.0, 1.0));
            }
            a = u.stops[i];
            offset = next;
        }
        a
    };
    let [w, h] = size;
    // The sixteen directions of a rounded dilation (operation 14), as offsets of `uv`.
    let rounded: [[f32; 2]; 16] = std::array::from_fn(|i| {
        let angle = i as f32 * PI / 8.0;
        [angle.cos() * p[0] / dims[0], angle.sin() * p[0] / dims[1]]
    });
    let mut data = vec![[0u8; 4]; w * h];
    for y in 0..h {
        for x in 0..w {
            let frag = [x as f32 + 0.5, y as f32 + 0.5];
            let uv = [frag[0] / target[0], 1.0 - frag[1] / target[1]];
            let c = sample(uv);
            let rgb = if c[3] > 0.000001 { [c[0] / c[3], c[1] / c[3], c[2] / c[3]] } else { [0.0; 3] };
            let out: [f32; 4] = match op {
                1 => {
                    let b = brush(uv);
                    let k = p[0] * b[3];
                    [mix(rgb[0], b[0], k) * c[3], mix(rgb[1], b[1], k) * c[3], mix(rgb[2], b[2], k) * c[3], c[3]]
                }
                2 => {
                    let e = p[0].exp2();
                    let mut v = rgb.map(|x| ((x * e) - 0.5) * p[1] + 0.5);
                    let l = v[0] * 0.2126 + v[1] * 0.7152 + v[2] * 0.0722;
                    v = v.map(|x| mix(l, x, p[2]));
                    v = [v[0] + p[3] * 0.12, v[1] + q[0] * 0.12, v[2] - p[3] * 0.12];
                    let lc = l.clamp(0.0, 1.0);
                    let lift = q[1] * (1.0 - lc).powf(2.0) * 0.4 + q[2] * lc.powf(2.0) * 0.4;
                    v = v.map(|x| (x + lift).max(0.0).powf(1.0 / q[3]));
                    [v[0].clamp(0.0, 1.0) * c[3], v[1].clamp(0.0, 1.0) * c[3], v[2].clamp(0.0, 1.0) * c[3], c[3]]
                }
                3 | 4 => {
                    let delta = if op == 3 { [1.0 / dims[0], 0.0] } else { [0.0, 1.0 / dims[1]] };
                    let radius = (p[0] as i32).clamp(0, 128);
                    let mut sum = [0.0f32; 4];
                    for i in -radius..=radius {
                        let s = sample([uv[0] + delta[0] * i as f32, uv[1] + delta[1] * i as f32]);
                        sum = [sum[0] + s[0], sum[1] + s[1], sum[2] + s[2], sum[3] + s[3]];
                    }
                    let n = (radius * 2 + 1) as f32;
                    sum.map(|v| v / n)
                }
                5 | 6 => {
                    let delta = if op == 5 { [1.0 / dims[0], 0.0] } else { [0.0, 1.0 / dims[1]] };
                    let radius = (p[0] as i32).clamp(0, 128);
                    let mut alpha = 0.0f32;
                    for i in -radius..=radius {
                        alpha = alpha.max(alpha_of([uv[0] + delta[0] * i as f32, uv[1] + delta[1] * i as f32]));
                    }
                    [alpha; 4]
                }
                7 => {
                    let front = sample_orig(uv);
                    let b = brush(uv);
                    let shadow = alpha_of([uv[0] - q[0] / dims[0], uv[1] + q[1] / dims[1]]);
                    let a = (shadow.powf(p[1]) * p[0] * b[3]).clamp(0.0, 1.0);
                    if p[2] > 0.0 {
                        let mut f = [mix(front[0], b[0] * front[3], a), mix(front[1], b[1] * front[3], a), mix(front[2], b[2] * front[3], a)];
                        if p[3] == 1.0 {
                            f = [0, 1, 2].map(|k| (front[k] + b[k] * front[3] * a).min(front[3]));
                        }
                        if p[3] == 2.0 {
                            f = [0, 1, 2].map(|k| front[k] + b[k] * a * (front[3] - front[k]));
                        }
                        [f[0], f[1], f[2], front[3]]
                    } else {
                        let under = [b[0] * a, b[1] * a, b[2] * a, a];
                        let mut pixel = [0, 1, 2, 3].map(|k| front[k] + under[k] * (1.0 - front[3]));
                        if p[3] == 1.0 {
                            let top = front[3].max(a);
                            pixel = [(front[0] + under[0]).min(top), (front[1] + under[1]).min(top), (front[2] + under[2]).min(top), top];
                        }
                        if p[3] == 2.0 {
                            pixel = [front[0] + under[0] - front[0] * under[0], front[1] + under[1] - front[1] * under[1], front[2] + under[2] - front[2] * under[2], front[3].max(a)];
                        }
                        pixel
                    }
                }
                8 => {
                    let xy = global(uv);
                    let size = [p[0], p[1]];
                    let cell = [
                        (((xy[0] - q[0]) / size[0]).floor() + 0.5) * size[0] + q[0],
                        (((xy[1] - q[1]) / size[1]).floor() + 0.5) * size[1] + q[1],
                    ];
                    let cell = [cell[0].clamp(0.5, u.output_size[0] - 0.5), cell[1].clamp(0.5, u.output_size[1] - 0.5)];
                    sample_global(cell)
                }
                9 => {
                    let g = global(uv);
                    let xy = [g[0] / p[1], g[1] / p[1]];
                    let seed = p[2] + p[3];
                    let smoothness = q[2].max(q[3]);
                    let n = noise_at(xy, seed, smoothness) - 0.5;
                    let grain = if q[0] > 0.0 { [n, noise_at(xy, seed + 131.0, smoothness) - 0.5, noise_at(xy, seed + 719.0, smoothness) - 0.5] } else { [n; 3] };
                    let k = p[0] * q[1];
                    [(rgb[0] + grain[0] * k).clamp(0.0, 1.0) * c[3], (rgb[1] + grain[1] * k).clamp(0.0, 1.0) * c[3], (rgb[2] + grain[2] * k).clamp(0.0, 1.0) * c[3], c[3]]
                }
                10 => {
                    let g = global(uv);
                    let mut xy = [(g[0] / u.output_size[0] - q[0]) * 2.0, (g[1] / u.output_size[1] - q[1]) * 2.0];
                    xy[0] /= q[2];
                    let distance = mix(xy[0].abs().max(xy[1].abs()), (xy[0] * xy[0] + xy[1] * xy[1]).sqrt() / std::f32::consts::SQRT_2, q[3]) / p[2];
                    let dark = smoothstep(1.0 - p[1], 1.0, distance) * p[0];
                    let b = brush(uv);
                    let k = dark * b[3];
                    [mix(c[0], b[0] * c[3], k), mix(c[1], b[1] * c[3], k), mix(c[2], b[2] * c[3], k), c[3]]
                }
                11 => {
                    let xy = [(frag[0] * p[0] - p[1]) / dims[0], (frag[1] * p[0] - p[2]) / dims[1]];
                    sample([xy[0], 1.0 - xy[1]])
                }
                12 => {
                    let xy = [(frag[0] + p[1]) / p[0] / dims[0], (frag[1] + p[2]) / p[0] / dims[1]];
                    sample([xy[0], 1.0 - xy[1]])
                }
                13 => [1.0 - c[3]; 4],
                14 => {
                    let mut a = c[3];
                    for d in &rounded {
                        a = a.max(alpha_of([uv[0] + d[0], uv[1] + d[1]]));
                    }
                    [a; 4]
                }
                15 => {
                    let front = sample_orig(uv);
                    let b = brush(uv);
                    let mut a = if p[1] > 0.0 { c[3] * front[3] } else { (c[3] - front[3]).max(0.0) };
                    a *= p[0] * b[3];
                    if p[2] > 0.0 {
                        [b[0] * a, b[1] * a, b[2] * a, a]
                    } else if p[1] > 0.0 {
                        let k = (c[3] * p[0] * b[3]).clamp(0.0, 1.0);
                        [mix(front[0], b[0] * front[3], k), mix(front[1], b[1] * front[3], k), mix(front[2], b[2] * front[3], k), front[3]]
                    } else {
                        let over = [b[0] * a, b[1] * a, b[2] * a, a];
                        [0, 1, 2, 3].map(|k| front[k] + over[k] * (1.0 - front[3]))
                    }
                }
                16 => {
                    let xy = global(uv);
                    let delta = [xy[0] - q[0] * u.output_size[0], xy[1] - q[1] * u.output_size[1]];
                    let mut dir = if p[1] == 1.0 {
                        [p[2].cos(), p[2].sin()]
                    } else {
                        let (dx, dy) = (delta[0] + 0.00001, delta[1] + 0.00001);
                        let l = (dx * dx + dy * dy).sqrt();
                        [dx / l, dy / l]
                    };
                    if p[1] == 3.0 {
                        dir = [-dir[1], dir[0]];
                    }
                    let mut sum = [0.0f32; 4];
                    for i in 0..33 {
                        let t = i as f32 / 32.0 - 0.5;
                        let s = sample_global([xy[0] + dir[0] * p[0] * t * 2.0, xy[1] + dir[1] * p[0] * t * 2.0]);
                        sum = [sum[0] + s[0], sum[1] + s[1], sum[2] + s[2], sum[3] + s[3]];
                    }
                    sum.map(|v| v / 33.0)
                }
                17 => {
                    let g = global(uv);
                    let n = noise_at([g[0] / p[1], g[1] / p[1]], p[3], 1.0);
                    let keep = if p[0] <= 0.0 {
                        1.0
                    } else if p[0] >= 1.0 {
                        0.0
                    } else {
                        smoothstep(p[0] - p[2], p[0] + p[2], n)
                    };
                    let edge = (1.0 - smoothstep(p[0], p[0] + q[0] + p[2], n)) * keep;
                    let b = brush(uv);
                    let k = edge * b[3];
                    [mix(c[0], b[0] * c[3], k) * keep, mix(c[1], b[1] * c[3], k) * keep, mix(c[2], b[2] * c[3], k) * keep, c[3] * keep]
                }
                18 => {
                    let delta = [p[1].cos() * p[0], p[1].sin() * p[0]];
                    let xy = global(uv);
                    let red = sample_global([xy[0] + delta[0] * q[0], xy[1] + delta[1] * q[0]]);
                    let green = sample_global([xy[0] + delta[0] * q[1], xy[1] + delta[1] * q[1]]);
                    let blue = sample_global([xy[0] + delta[0] * q[2], xy[1] + delta[1] * q[2]]);
                    [red[0], green[1], blue[2], red[3].max(green[3].max(blue[3]))]
                }
                19 => {
                    let axis = [p[2].cos(), p[2].sin()];
                    let xy = global(uv);
                    let wave = ((xy[0] * axis[0] + xy[1] * axis[1]) * 2.0 * PI / p[1] + p[3]).sin();
                    sample_global([xy[0] - axis[1] * wave * p[0], xy[1] + axis[0] * wave * p[0]])
                }
                20 => {
                    let xy = global(uv);
                    let delta = [xy[0] - q[0] * u.output_size[0], xy[1] - q[1] * u.output_size[1]];
                    let distance = (delta[0] * delta[0] + delta[1] * delta[1]).sqrt();
                    let ring = (distance - p[0]) / p[1];
                    let strength = (ring * PI).sin() * (1.0 - ring.abs()).max(0.0).powf(p[3]) * p[2];
                    let k = strength / distance.max(0.0001);
                    sample_global([xy[0] + delta[0] * k, xy[1] + delta[1] * k])
                }
                21 => {
                    let l = rgb[0].max(rgb[1].max(rgb[2]));
                    let m = smoothstep(p[0] - p[1], p[0] + p[1], l);
                    c.map(|v| v * m)
                }
                22 => {
                    let front = sample_orig(uv);
                    let b = brush(uv);
                    let top = front[3].max(c[3]);
                    let k = b[3] * p[0];
                    [(front[0] + c[0] * b[0] * k).min(top), (front[1] + c[1] * b[1] * k).min(top), (front[2] + c[2] * b[2] * k).min(top), top]
                }
                23 => {
                    let g = global(uv);
                    let xy = [g[0] / u.output_size[0] - 0.5, g[1] / u.output_size[1] - 0.5];
                    let position = xy[0] * p[1].cos() + xy[1] * p[1].sin() + 0.5;
                    let distance = (position - p[0]).abs() * 2.0 / p[2];
                    let light = 1.0 - smoothstep(1.0 - p[3], 1.0, distance);
                    let b = brush(uv);
                    let k = b[3] * light * q[0] * c[3];
                    [(c[0] + b[0] * k).clamp(0.0, c[3]), (c[1] + b[1] * k).clamp(0.0, c[3]), (c[2] + b[2] * k).clamp(0.0, c[3]), c[3]]
                }
                24 => {
                    let xy = global(uv);
                    let pos = [xy[0] / u.output_size[0] * 2.0 - 1.0, xy[1] / u.output_size[1] * 2.0 - 1.0];
                    let bend = 1.0 + p[2] * (pos[0] * pos[0] + pos[1] * pos[1]);
                    let warped = [(pos[0] * bend * 0.5 + 0.5) * u.output_size[0], (pos[1] * bend * 0.5 + 0.5) * u.output_size[1]];
                    let mut s = sample_global(warped);
                    if warped[0] < 0.0 || warped[1] < 0.0 || warped[0] >= u.output_size[0] || warped[1] >= u.output_size[1] {
                        s = [0.0; 4];
                    }
                    if p[3] > 0.0 {
                        s[0] = sample_global([warped[0] + p[3], warped[1]])[0];
                        s[2] = sample_global([warped[0] - p[3], warped[1]])[2];
                        s = [s[0].min(s[3]), s[1].min(s[3]), s[2].min(s[3]), s[3]];
                    }
                    let line = (0.5 + 0.5 * ((xy[1] + q[0]) * 2.0 * PI / p[1]).cos()) * p[0];
                    let b = brush(uv);
                    let k = line * b[3];
                    [mix(s[0], b[0] * s[3], k), mix(s[1], b[1] * s[3], k), mix(s[2], b[2] * s[3], k), s[3]]
                }
                25 => {
                    let front = sample_orig(uv);
                    let inner = sample_mask(uv);
                    let b = brush(uv);
                    let outer = (c[3] - front[3]).max(0.0) * p[0] * b[3];
                    let add = [b[0] * outer, b[1] * outer, b[2] * outer, outer];
                    let ring = [0, 1, 2, 3].map(|k| inner[k] + add[k] * (1.0 - inner[3]));
                    if p[1] > 0.0 { ring } else { [0, 1, 2, 3].map(|k| ring[k] + front[k] * (1.0 - ring[3])) }
                }
                26 => mix4(sample_orig(uv), c, p[0]),
                27 => {
                    let g = global(uv);
                    let mut xy = [g[0] / p[1] + p[2] * 0.73, g[1] / p[1] + p[2] * 1.17];
                    let mut offset = [0.0f32; 2];
                    let (mut weight, mut total) = (1.0f32, 0.0f32);
                    for i in 0..4 {
                        if i as f32 >= q[0] {
                            break;
                        }
                        offset[0] += noise_at(xy, p[3] + i as f32 * 37.0, 1.0) * weight;
                        offset[1] += noise_at([xy[0] + 19.1, xy[1] + 7.7], p[3] + 131.0 + i as f32 * 37.0, 1.0) * weight;
                        total += weight;
                        weight *= 0.5;
                        xy = [xy[0] * 2.0, xy[1] * 2.0];
                    }
                    let d = [(offset[0] / total * 2.0 - 1.0) * p[0], (offset[1] / total * 2.0 - 1.0) * p[0]];
                    sample_global([g[0] + d[0], g[1] + d[1]])
                }
                _ => c,
            };
            data[y * w + x] = out.map(quantize);
        }
    }
    Slot { size, data }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use styk_eval::vfx::registry::{Params, Tint};
    use styk_eval::vfx::{Color, Effect};
    use styk_render::effects::recipe::{record, Frame};

    /// The windowed box passes and dilations give what shading every pixel gives.
    #[test]
    fn windows_equal_the_shader() {
        let size = [23usize, 17usize];
        let data: Vec<Px> = (0..size[0] * size[1]).map(|i| {
            let a = ((i * 37 + 11) % 256) as u8;
            [a / 2, a / 3, a, a]
        }).collect();
        let source = Slot { size, data };
        let blank = Slot { size: [1, 1], data: vec![[0; 4]] };
        for operation in 3..=6 {
            for radius in [0.0, 1.0, 3.0, 9.0, 40.0] {
                let u = Uniform {
                    dimensions: [size[0] as f32, size[1] as f32],
                    origin: [0.0; 2],
                    output_size: [size[0] as f32, size[1] as f32],
                    paint_type: 0,
                    stop_count: 1,
                    paint_angle: 0.0,
                    operation,
                    target: [size[0] as f32, size[1] as f32],
                    texel: [0.0; 2],
                    unused: [0.0; 2],
                    p: [radius, 0.0, 0.0, 0.0],
                    q: [0.0; 4],
                    stops: [[0.0; 4]; 32],
                    stop_offsets: [0.0; 32],
                };
                let (fast, slow) = (window(&u, &source), general(&u, &source, &blank, &blank, size));
                let worst = fast.data.iter().zip(&slow.data).flat_map(|(a, b)| (0..4).map(move |c| a[c].abs_diff(b[c]))).max().unwrap();
                assert!(worst <= 1, "operation {operation}, radius {radius}: {worst} levels apart");
            }
        }
    }

    #[test]
    fn a_tint_mixes_towards_its_colour() {
        let tint = Effect { id: Arc::from("t"), enabled: true, params: Params::Tint(Tint { color: Color::Rgb(0x0000ff), mix: 0.5, ..Default::default() }) };
        let mut records = Vec::new();
        let recorded = record(&mut records, &[Arc::new(tint)], Frame { scale: 1.0, origin: [0.0; 2], output_size: [2.0, 1.0] }, [2, 1]);
        // An opaque red pixel and a half-transparent white one.
        let out = run(&recorded, &records, vec![[255, 0, 0, 255], [128, 128, 128, 128]], [2, 1]);
        assert_eq!(out[0], [128, 0, 128, 255]);
        assert_eq!(out[1], [64, 64, 128, 128]);
    }
}
