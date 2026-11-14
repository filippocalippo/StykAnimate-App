//! Filter effects on the CPU: an effect stack's recipe (`styk_render::effects::recipe`) run pass by pass on the layer's
//! pixels, each operation the arithmetic of styk-render's effect shaders (`effects/shaders/`). Images are kept as floats from
//! the layer's conversion to the result's (dithered, as the GPU writes its eight-bit result), each the size its pass needs, and
//! let go after the last pass that reads it.

use styk_render::effects::recipe::{op, Run, Uniform, BLANK, INPUT};

use crate::target::{quantize, Px};

const PI: f32 = std::f32::consts::PI;

type C = [f32; 4];

/// A seed of the jump flood: a point on the edge in eighths of a pixel and its strength (0–65535), as the GPU's 16-bit integers
/// hold them; `None`: no seed.
type Seed = Option<[u16; 3]>;

/// An image of a run: premultiplied colour (or a mask), or the jump flood's seeds.
enum Pixels {
    Color(Vec<C>),
    Seeds(Vec<Seed>),
}

struct Img {
    size: [usize; 2],
    pixels: Pixels,
}

impl Img {
    fn color(&self) -> &[C] {
        match &self.pixels {
            Pixels::Color(c) => c,
            Pixels::Seeds(_) => &[],
        }
    }
    fn seeds(&self) -> &[Seed] {
        match &self.pixels {
            Pixels::Seeds(s) => s,
            Pixels::Color(_) => &[],
        }
    }
    /// Texel `(x, y)`, transparent outside.
    #[inline]
    fn load(&self, x: i64, y: i64) -> C {
        if x < 0 || y < 0 || x >= self.size[0] as i64 || y >= self.size[1] as i64 {
            return [0.0; 4];
        }
        self.color()[y as usize * self.size[0] + x as usize]
    }
    /// The bilinear read at texel position `t` (texel `m` spans `[m, m + 1)`), clamped to the image's texels, as the GPU's
    /// `sample` reads a pooled texture.
    #[inline]
    fn sample(&self, t: [f32; 2]) -> C {
        let [w, h] = self.size;
        if w == 0 || h == 0 {
            return [0.0; 4];
        }
        let x = t[0].clamp(0.5, (w as f32 - 0.5).max(0.5)) - 0.5;
        let y = t[1].clamp(0.5, (h as f32 - 0.5).max(0.5)) - 0.5;
        let (ix, iy) = (x as usize, y as usize);
        let (fx, fy) = (x - ix as f32, y - iy as f32);
        let (x1, y1) = ((ix + 1).min(w - 1), (iy + 1).min(h - 1));
        let d = self.color();
        let (a, b, c, e) = (d[iy * w + ix], d[iy * w + x1], d[y1 * w + ix], d[y1 * w + x1]);
        let mut out = [0.0; 4];
        for k in 0..4 {
            let top = a[k] + (b[k] - a[k]) * fx;
            let bottom = c[k] + (e[k] - c[k]) * fx;
            out[k] = top + (bottom - top) * fy;
        }
        out
    }
}

#[inline]
fn add(a: C, b: C, w: f32) -> C {
    [a[0] + b[0] * w, a[1] + b[1] * w, a[2] + b[2] * w, a[3] + b[3] * w]
}
#[inline]
fn scale(a: C, w: f32) -> C {
    [a[0] * w, a[1] * w, a[2] * w, a[3] * w]
}
#[inline]
fn mix4(a: C, b: C, t: f32) -> C {
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t]
}
#[inline]
fn mix(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}
fn smoothstep(a: f32, b: f32, x: f32) -> f32 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}
fn straight(c: C) -> [f32; 3] {
    if c[3] > 0.000001 { [c[0] / c[3], c[1] / c[3], c[2] / c[3]] } else { [0.0; 3] }
}
fn fract(v: f32) -> f32 {
    v - v.floor()
}

/// The dither of the GPU's eight-bit writes (`finish` in `common.wgsl`): interleaved gradient noise, less than half a level.
#[inline]
fn dither(x: usize, y: usize) -> f32 {
    (fract(52.982_918_9 * fract(x as f32 * 0.067_110_56 + y as f32 * 0.005_837_15)) - 0.5) * 0.998 / 255.0
}

/// Runs `run` (its passes' parameters in `records`) on `input`, a `size` layer; returns the result.
pub(crate) fn run(run: &Run, records: &[Uniform], input: Vec<Px>, size: [usize; 2]) -> Vec<Px> {
    if run.steps.is_empty() {
        return input;
    }
    const K: f32 = 1.0 / 255.0;
    let last = run.last_reads();
    let mut images: Vec<Option<Img>> = (0..run.images.len()).map(|_| None).collect();
    images[INPUT as usize] = Some(Img { size, pixels: Pixels::Color(input.iter().map(|p| [p[0] as f32 * K, p[1] as f32 * K, p[2] as f32 * K, p[3] as f32 * K]).collect()) });
    drop(input);
    for (i, step) in run.steps.iter().enumerate() {
        let target = run.images[step.target as usize].size;
        let out = {
            let get = |k: usize| (step.inputs[k] != BLANK).then(|| images[step.inputs[k] as usize].as_ref().expect("an image is written before it is read"));
            pass(&records[step.uniform as usize], [get(0), get(1), get(2), get(3)], [target[0] as usize, target[1] as usize])
        };
        images[step.target as usize] = Some(out);
        for id in step.inputs {
            if id != BLANK && last[id as usize] == Some(i) {
                images[id as usize] = None;
            }
        }
    }
    let result = images[run.result as usize].take().expect("the result");
    let w = result.size[0];
    let mut out = vec![[0u8; 4]; size[0] * size[1]];
    for y in 0..size[1].min(result.size[1]) {
        for x in 0..size[0].min(w) {
            let c = result.color()[y * w + x];
            let d = dither(x, y);
            out[y * size[0] + x] = c.map(|v| quantize(v + d));
        }
    }
    out
}

/// The brush of a pass at a full-size target's texel position (`brush` in `common.wgsl`).
fn brush(u: &Uniform, at: [f32; 2]) -> C {
    if u.paint_type == 0 {
        return u.stops[0];
    }
    let g = [u.origin[0] + at[0], u.origin[1] + at[1]];
    let mut pos = [g[0] / u.output_size[0] - 0.5, g[1] / u.output_size[1] - 0.5];
    let (cs, sn) = (u.paint_angle.cos(), u.paint_angle.sin());
    // mat2x2f(cs, -sn, sn, cs) * pos: columns (cs, -sn) and (sn, cs).
    pos = [cs * pos[0] + sn * pos[1], -sn * pos[0] + cs * pos[1]];
    let mut t = pos[0] + 0.5;
    if u.paint_type == 2 {
        t = (pos[0] * pos[0] + pos[1] * pos[1]).sqrt() * 2.0;
    }
    if u.paint_type == 3 {
        t = fract(pos[1].atan2(pos[0]) / (2.0 * PI) + 1.0);
    }
    if u.paint_type == 4 {
        t = (pos[0].abs() + pos[1].abs()) * 2.0;
    }
    let mut a = u.stops[0];
    let mut offset = u.stop_offsets[0];
    for i in 1..(u.stop_count.max(1) as usize).min(32) {
        let next = u.stop_offsets[i];
        if t < next {
            return mix4(a, u.stops[i], ((t - offset) / 0.00001f32.max(next - offset)).clamp(0.0, 1.0));
        }
        a = u.stops[i];
        offset = next;
    }
    a
}

/// A read along one axis through the cubic B-spline (`splineAxis` in `common.wgsl`): the texels and weights of its two bilinear
/// samples at texel position `u`, each clamped to an image of `n` texels.
fn spline_taps(u: f32, n: usize) -> [(usize, f32); 4] {
    let t = u - 0.5;
    let i = t.floor();
    let f = t - i;
    let (f2, f3) = (f * f, f * f * f);
    let w0 = (1.0 - f) * (1.0 - f) * (1.0 - f) / 6.0;
    let w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
    let w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
    let w3 = f3 / 6.0;
    let (g0, g1) = (w0 + w1, w2 + w3);
    let linear = |p: f32, g: f32| {
        let x = p.clamp(0.5, (n as f32 - 0.5).max(0.5)) - 0.5;
        let i = x as usize;
        let f = x - i as f32;
        [(i.min(n - 1), g * (1.0 - f)), ((i + 1).min(n - 1), g * f)]
    };
    let [a, b] = linear(i - 0.5 + w1 / g0, g0);
    let [c, d] = linear(i + 1.5 + w3 / g1, g1);
    [a, b, c, d]
}

/// Linear taps of the bilinear read along one axis at texel position `u` (clamped to `n` texels).
fn linear_taps(u: f32, n: usize) -> [(usize, f32); 4] {
    let x = u.clamp(0.5, (n as f32 - 0.5).max(0.5)) - 0.5;
    let i = x as usize;
    let f = x - i as f32;
    [(i.min(n - 1), 1.0 - f), ((i + 1).min(n - 1), f), (0, 0.0), (0, 0.0)]
}

/// Reads of an image mapped from a full-size target by `map`, displaced by `offset` target pixels, per column and per row:
/// smooth (the B-spline) for a halved image, bilinear otherwise (`read0` in `common.wgsl`).
struct Reader {
    columns: Vec<[(usize, f32); 4]>,
    rows: Vec<[(usize, f32); 4]>,
}

impl Reader {
    fn new(img: &Img, map: [f32; 4], offset: [f32; 2], size: [usize; 2]) -> Reader {
        let smooth = map[0] < 1.0;
        let taps = |u: f32, n: usize| if smooth { spline_taps(u, n) } else { linear_taps(u, n) };
        let columns = (0..size[0]).map(|x| taps((x as f32 + 0.5 - offset[0]) * map[0] + map[2], img.size[0])).collect();
        let rows = (0..size[1]).map(|y| taps((y as f32 + 0.5 - offset[1]) * map[1] + map[3], img.size[1])).collect();
        Reader { columns, rows }
    }
    #[inline]
    fn at(&self, img: &Img, x: usize, y: usize) -> C {
        let d = img.color();
        let w = img.size[0];
        let mut out = [0.0; 4];
        for &(row, wy) in &self.rows[y] {
            if wy == 0.0 {
                continue;
            }
            for &(column, wx) in &self.columns[x] {
                if wx != 0.0 {
                    out = add(out, d[row * w + column], wx * wy);
                }
            }
        }
        out
    }
}

/// One pass of `u.operation` into a new image of `size`.
fn pass(u: &Uniform, inputs: [Option<&Img>; 4], size: [usize; 2]) -> Img {
    let [w, h] = size;
    let color = |f: &mut dyn FnMut(usize, usize) -> C| {
        let mut data = Vec::with_capacity(w * h);
        for y in 0..h {
            for x in 0..w {
                data.push(f(x, y));
            }
        }
        Img { size, pixels: Pixels::Color(data) }
    };
    let input = |k: usize| inputs[k].expect("the pass reads this input");
    // Input k at a target texel's position: the map applied to the texel's centre.
    let mapped = |k: usize, x: f32, y: f32| [x * u.maps[k][0] + u.maps[k][2], y * u.maps[k][1] + u.maps[k][3]];
    let strengthen = |result: C, base: C| mix4(base, result, u.s[3]);
    let (p, q) = (u.p, u.q);
    match u.operation {
        op::TENT | op::BOX | op::BRIGHT => {
            let src = input(0);
            let bright = |c: C| {
                let rgb = straight(c);
                let l = rgb[0].max(rgb[1]).max(rgb[2]);
                scale(c, smoothstep(p[0] - p[1], p[0] + p[1], l))
            };
            color(&mut |x, y| {
                let c = mapped(0, x as f32 + 0.5, y as f32 + 0.5);
                if u.operation == op::BOX {
                    return src.sample(c);
                }
                let taps = [[-0.75, -0.75], [0.75, -0.75], [-0.75, 0.75], [0.75, 0.75]].map(|o| src.sample([c[0] + o[0], c[1] + o[1]]));
                let taps = if u.operation == op::BRIGHT { taps.map(bright) } else { taps };
                scale(add(add(add(taps[0], taps[1], 1.0), taps[2], 1.0), taps[3], 1.0), 0.25)
            })
        }
        op::CONVOLVE => {
            let src = input(0);
            let count = (u.seed[0] as usize).min(16);
            let samples: Vec<(f32, f32)> = (0..count).map(|i| (u.taps[i / 4][i % 4], u.weights[i / 4][i % 4])).collect();
            let along_x = p[0] != 0.0;
            let base = (p[2] > 0.0).then(|| input(1));
            // Along an axis a bilinear read is a linear one: the two texels of the row (or column) and their weights.
            let (n, d) = (if along_x { src.size[0] } else { src.size[1] }, src.color());
            color(&mut |x, y| {
                let c = mapped(0, x as f32 + 0.5, y as f32 + 0.5);
                let mut sum = [0.0; 4];
                for &(o, weight) in &samples {
                    let t = if along_x { c[0] + o } else { c[1] + o };
                    let v = t.clamp(0.5, (n as f32 - 0.5).max(0.5)) - 0.5;
                    let i = v as usize;
                    let f = v - i as f32;
                    let j = (i + 1).min(n - 1);
                    let (a, b) = if along_x {
                        let row = (c[1] as usize).min(src.size[1] - 1) * src.size[0];
                        (d[row + i.min(n - 1)], d[row + j])
                    } else {
                        let column = (c[0] as usize).min(src.size[0] - 1);
                        (d[i.min(n - 1) * src.size[0] + column], d[j * src.size[0] + column])
                    };
                    sum = add(sum, mix4(a, b, f), weight);
                }
                match base {
                    Some(base) => strengthen(sum, base.sample(mapped(1, x as f32 + 0.5, y as f32 + 0.5))),
                    None => sum,
                }
            })
        }
        op::SPLINE | op::ACCUMULATE => {
            let (coarse, this) = (input(0), input(1));
            let reader = Reader::new(coarse, u.maps[0], [0.0; 2], size);
            color(&mut |x, y| {
                let c = reader.at(coarse, x, y);
                let t = this.sample(mapped(1, x as f32 + 0.5, y as f32 + 0.5));
                if u.operation == op::ACCUMULATE { add(scale(c, p[0]), t, p[1]) } else { strengthen(c, t) }
            })
        }
        op::LIGHT | op::BLOOM => light(u, inputs, size),
        op::SEED | op::JUMP => flood(u, inputs, size),
        op::SPREAD | op::OUTLINE => distance_pass(u, inputs, size),
        op::LINE => {
            let (src, base) = (input(0), inputs[1]);
            let count = p[1] as usize;
            let first = -(p[1] - 1.0) * 0.5 * p[2];
            let turns: Vec<[f32; 3]> = (0..count)
                .map(|i| {
                    let t = first + i as f32 * p[2];
                    [t, t.cos(), t.sin()]
                })
                .collect();
            color(&mut |x, y| {
                let g = [u.origin[0] + x as f32 + 0.5 - q[0], u.origin[1] + y as f32 + 0.5 - q[1]];
                let mut sum = [0.0; 4];
                for &[t, c, s] in &turns {
                    let at = match p[0] as i32 {
                        2 => {
                            let e = t.exp();
                            [g[0] * e, g[1] * e]
                        }
                        3 => [c * g[0] - s * g[1], s * g[0] + c * g[1]],
                        _ => [g[0] + q[2] * t, g[1] + q[3] * t],
                    };
                    sum = add(sum, src.sample([at[0] + q[0] - u.origin[0], at[1] + q[1] - u.origin[1]]), 1.0);
                }
                let sum = scale(sum, 1.0 / p[1]);
                match (p[3] > 0.0, base) {
                    (true, Some(base)) => strengthen(sum, base.sample(mapped(1, x as f32 + 0.5, y as f32 + 0.5))),
                    _ => sum,
                }
            })
        }
        op::TINT | op::GRADE | op::VIGNETTE | op::SWEEP => {
            let (src, base) = (input(0), input(1));
            color(&mut |x, y| {
                let at = [x as f32 + 0.5, y as f32 + 0.5];
                let c = src.sample(mapped(0, at[0], at[1]));
                let b0 = base.sample(mapped(1, at[0], at[1]));
                strengthen(colour_op(u, c, at), b0)
            })
        }
        op::GRAIN | op::CLOUDS | op::DISSOLVE | op::TURBULENCE => {
            let (src, base) = (input(0), input(1));
            color(&mut |x, y| {
                let at = [x as f32 + 0.5, y as f32 + 0.5];
                let b0 = base.sample(mapped(1, at[0], at[1]));
                strengthen(noise_op(u, src, at), b0)
            })
        }
        op::SPLIT | op::WAVE | op::SHOCK | op::CRT => {
            let (src, base) = (input(0), input(1));
            color(&mut |x, y| {
                let at = [x as f32 + 0.5, y as f32 + 0.5];
                let b0 = base.sample(mapped(1, at[0], at[1]));
                strengthen(warp(u, src, at), b0)
            })
        }
        op::CELLS => {
            let src = input(0);
            let step = u.r[0];
            color(&mut |x, y| {
                let index = [x as f32 + q[0], y as f32 + q[1]];
                let low = [(p[2] + index[0] * p[0] - u.origin[0] + q[2]) / step, (p[3] + index[1] * p[1] - u.origin[1] + q[3]) / step];
                let high = [low[0] + p[0] / step, low[1] + p[1] / step];
                let mut sum = [0.0; 4];
                for ty in low[1].floor() as i64..high[1].ceil() as i64 {
                    let wy = high[1].min(ty as f32 + 1.0) - low[1].max(ty as f32);
                    for tx in low[0].floor() as i64..high[0].ceil() as i64 {
                        let wx = high[0].min(tx as f32 + 1.0) - low[0].max(tx as f32);
                        sum = add(sum, src.load(tx, ty), wx * wy);
                    }
                }
                scale(sum, 1.0 / ((high[0] - low[0]) * (high[1] - low[1])))
            })
        }
        op::SHOW => {
            let (cells, base) = (input(0), input(1));
            color(&mut |x, y| {
                let g = [u.origin[0] + x as f32 + 0.5, u.origin[1] + y as f32 + 0.5];
                let cell = [((g[0] - p[2]) / p[0]).floor() - q[0], ((g[1] - p[3]) / p[1]).floor() - q[1]];
                let cx = (cell[0].max(0.0) as usize).min(cells.size[0] - 1);
                let cy = (cell[1].max(0.0) as usize).min(cells.size[1] - 1);
                strengthen(cells.color()[cy * cells.size[0] + cx], base.sample(mapped(1, x as f32 + 0.5, y as f32 + 0.5)))
            })
        }
        _ => color(&mut |x, y| input(0).sample([x as f32 + 0.5, y as f32 + 0.5])),
    }
}

/// Glow, shadow and bloom over the artwork (`light.wgsl`).
fn light(u: &Uniform, inputs: [Option<&Img>; 4], size: [usize; 2]) -> Img {
    let [w, h] = size;
    let (p, q) = (u.p, u.q);
    let mask = inputs[0].expect("a mask");
    let front = inputs[1].expect("the artwork");
    let mut data = Vec::with_capacity(w * h);
    let at_of = |k: usize, at: [f32; 2]| [at[0] * u.maps[k][0] + u.maps[k][2], at[1] * u.maps[k][1] + u.maps[k][3]];
    if u.operation == op::BLOOM {
        let reader = Reader::new(mask, u.maps[0], [0.0; 2], size);
        for y in 0..h {
            for x in 0..w {
                let at = [x as f32 + 0.5, y as f32 + 0.5];
                let b = brush(u, at);
                let f = front.sample(at_of(1, at));
                let c = scale(reader.at(mask, x, y), p[1]);
                let top = f[3].max(c[3]);
                let k = b[3] * p[0];
                let lit = [(f[0] + c[0] * b[0] * k).min(top), (f[1] + c[1] * b[1] * k).min(top), (f[2] + c[2] * b[2] * k).min(top), top];
                data.push(mix4(f, lit, u.s[3]));
            }
        }
        return Img { size, pixels: Pixels::Color(data) };
    }
    let base = inputs[2].expect("the base");
    let reader = Reader::new(mask, u.maps[0], [q[0], q[1]], size);
    let colours = inputs[3].filter(|_| q[2] > 0.0).map(|c| (c, Reader::new(c, u.maps[3], [q[0], q[1]], size)));
    let modes = p[2] as i32;
    for y in 0..h {
        for x in 0..w {
            let at = [x as f32 + 0.5, y as f32 + 0.5];
            let f = front.sample(at_of(1, at));
            let b0 = base.sample(at_of(2, at));
            let m = reader.at(mask, x, y);
            let b = brush(u, at);
            let (glow, reach) = match &colours {
                Some((img, r)) => (straight(r.at(img, x, y)).map(|v| v.clamp(0.0, 1.0)), 1.0),
                None => ([b[0], b[1], b[2]], b[3]),
            };
            let mut pixel = f;
            if modes & 1 != 0 {
                let inner = if q[3] > 0.0 { m[0] } else { 1.0 - m[3] };
                let a = (inner.max(0.0).powf(p[1]) * p[0] * reach).clamp(0.0, 1.0);
                let mut rgb = [0, 1, 2].map(|k| mix(f[k], glow[k] * f[3], a));
                if p[3] == 1.0 {
                    rgb = [0, 1, 2].map(|k| (f[k] + glow[k] * f[3] * a).min(f[3]));
                }
                if p[3] == 2.0 {
                    rgb = [0, 1, 2].map(|k| f[k] + glow[k] * a * (f[3] - f[k]));
                }
                pixel = [rgb[0], rgb[1], rgb[2], f[3]];
            }
            if modes & 2 != 0 {
                let a = (m[3].max(0.0).powf(p[1]) * p[0] * reach).clamp(0.0, 1.0);
                let under = [glow[0] * a, glow[1] * a, glow[2] * a, a];
                let top = pixel[3].max(a);
                pixel = if p[3] == 1.0 {
                    [(pixel[0] + under[0]).min(top), (pixel[1] + under[1]).min(top), (pixel[2] + under[2]).min(top), top]
                } else if p[3] == 2.0 {
                    [pixel[0] + under[0] - pixel[0] * under[0], pixel[1] + under[1] - pixel[1] * under[1], pixel[2] + under[2] - pixel[2] * under[2], top]
                } else {
                    add(pixel, under, 1.0 - pixel[3])
                };
            }
            data.push(mix4(b0, pixel, u.s[3]));
        }
    }
    Img { size, pixels: Pixels::Color(data) }
}

/// The distance from a pixel's centre to the 1/2 contour of a straight edge through it (`edgeDistance` in `flood.wgsl`).
fn edge_distance(g: [f32; 2], a: f32) -> f32 {
    if g[0] == 0.0 || g[1] == 0.0 {
        return 0.5 - a;
    }
    let (mut gx, mut gy) = (g[0].abs(), g[1].abs());
    if gx < gy {
        std::mem::swap(&mut gx, &mut gy);
    }
    let a1 = 0.5 * gy / gx;
    if a < a1 {
        return 0.5 * (gx + gy) - (2.0 * gx * gy * a).sqrt();
    }
    if a < 1.0 - a1 {
        return (0.5 - a) * gx;
    }
    -0.5 * (gx + gy) + (2.0 * gx * gy * (1.0 - a)).sqrt()
}

/// The jump flood's passes (`flood.wgsl`).
fn flood(u: &Uniform, inputs: [Option<&Img>; 4], size: [usize; 2]) -> Img {
    let [w, h] = size;
    let mut data = Vec::with_capacity(w * h);
    let square = u.p[1] > 0.0;
    let packed = |e: [f32; 2], strength: f32| Some([(e[0] * 8.0).round().clamp(0.0, 65535.0) as u16, (e[1] * 8.0).round().clamp(0.0, 65535.0) as u16, (strength.clamp(0.0, 1.0) * 65535.0).round() as u16]);
    if u.operation == op::SEED {
        let art = inputs[1].expect("the artwork");
        let alpha = |x: i64, y: i64| art.load(x, y)[3];
        for y in 0..h as i64 {
            for x in 0..w as i64 {
                let a = alpha(x, y);
                let (l, r, up, d) = (alpha(x - 1, y), alpha(x + 1, y), alpha(x, y - 1), alpha(x, y + 1));
                let (ul, ur, dl, dr) = (alpha(x - 1, y - 1), alpha(x + 1, y - 1), alpha(x - 1, y + 1), alpha(x + 1, y + 1));
                let centre = [x as f32 + 0.5, y as f32 + 0.5];
                let inside = a >= 0.5;
                let across = (l >= 0.5) != inside || (r >= 0.5) != inside || (up >= 0.5) != inside || (d >= 0.5) != inside;
                if across {
                    // A whole pixel beside a partly covered one across the edge leaves the edge to that one.
                    let partly = |n: f32| (n >= 0.5) != inside && n > 0.0 && n < 1.0;
                    if (a <= 0.0 || a >= 1.0) && (partly(l) || partly(r) || partly(up) || partly(d)) {
                        data.push(None);
                        continue;
                    }
                    let g = [(ur + 2.0 * r + dr) - (ul + 2.0 * l + dl), (dl + 2.0 * d + dr) - (ul + 2.0 * up + ur)];
                    let length = (g[0] * g[0] + g[1] * g[1]).sqrt();
                    let n = if length > 0.000001 { [g[0] / length, g[1] / length] } else { [0.0; 2] };
                    let e = edge_distance(n, a);
                    data.push(packed([centre[0] + n[0] * e, centre[1] + n[1] * e], 1.0));
                    continue;
                }
                let ridge = a > 0.0 && !inside && a >= l.max(r).max(up).max(d).max(ul).max(ur).max(dl).max(dr);
                data.push(if ridge { packed(centre, a * 2.0) } else { None });
            }
        }
        return Img { size, pixels: Pixels::Seeds(data) };
    }
    let seeds = inputs[0].expect("the seeds");
    let s = seeds.seeds();
    let k = u.p[0] as i64;
    for y in 0..h as i64 {
        for x in 0..w as i64 {
            let centre = [x as f32 + 0.5, y as f32 + 0.5];
            let mut best: Seed = None;
            let mut nearest = f32::INFINITY;
            for n in 0..9 {
                let (qx, qy) = (x + (n % 3 - 1) * k, y + (n / 3 - 1) * k);
                if qx < 0 || qy < 0 || qx >= w as i64 || qy >= h as i64 {
                    continue;
                }
                let Some(e) = s[qy as usize * w + qx as usize] else { continue };
                let v = [e[0] as f32 / 8.0 - centre[0], e[1] as f32 / 8.0 - centre[1]];
                let d = if square { v[0].abs().max(v[1].abs()) } else { v[0] * v[0] + v[1] * v[1] };
                if d < nearest {
                    nearest = d;
                    best = Some(e);
                }
            }
            data.push(best);
        }
    }
    Img { size, pixels: Pixels::Seeds(data) }
}

/// The spread mask and the outline, from the signed distance to the artwork's edge (`spread.wgsl`, `outline.wgsl`).
fn distance_pass(u: &Uniform, inputs: [Option<&Img>; 4], size: [usize; 2]) -> Img {
    let [w, h] = size;
    let (p, q) = (u.p, u.q);
    let seeds = inputs[0].expect("the seeds").seeds();
    let art = inputs[1].expect("the artwork");
    let square = u.operation == op::OUTLINE && q[1] > 0.0;
    let mut data = Vec::with_capacity(w * h);
    for y in 0..h {
        for x in 0..w {
            let at = [x as f32 + 0.5, y as f32 + 0.5];
            let front = art.sample([at[0] * u.maps[1][0] + u.maps[1][2], at[1] * u.maps[1][1] + u.maps[1][3]]);
            let mut d = 1e6f32;
            let mut strength = 1.0f32;
            if let Some(e) = seeds[y * w + x] {
                let v = [e[0] as f32 / 8.0 - at[0], e[1] as f32 / 8.0 - at[1]];
                d = if square { v[0].abs().max(v[1].abs()) } else { (v[0] * v[0] + v[1] * v[1]).sqrt() };
                strength = e[2] as f32 / 65535.0;
            }
            if front[3] >= 0.5 {
                d = -d;
            }
            if u.operation == op::SPREAD {
                data.push([(p[0] + 0.5 + d).clamp(0.0, 1.0), 0.0, 0.0, (p[0] + 0.5 - d).clamp(0.0, 1.0) * strength]);
                continue;
            }
            let b = brush(u, at);
            let opacity = p[3] * b[3];
            // Each band's coverage: the artwork grown by the width less the artwork, the artwork less the artwork shrunk by it.
            let outer = if p[0] > 0.0 { (((p[0] - d) / p[2] + 0.5).clamp(0.0, 1.0) * strength - front[3]).max(0.0) } else { 0.0 };
            let inner = if p[1] > 0.0 { (front[3] - ((-p[1] - d) / p[2] + 0.5).clamp(0.0, 1.0)).max(0.0) } else { 0.0 };
            let pixel = if q[0] > 0.0 {
                let ring = (outer + inner).clamp(0.0, 1.0) * opacity;
                [b[0] * ring, b[1] * ring, b[2] * ring, ring]
            } else {
                let share = (inner / front[3].max(0.000001) * opacity).clamp(0.0, 1.0);
                let ring = outer * opacity;
                [
                    mix(front[0], b[0] * front[3], share) + b[0] * ring,
                    mix(front[1], b[1] * front[3], share) + b[1] * ring,
                    mix(front[2], b[2] * front[3], share) + b[2] * ring,
                    front[3] + ring,
                ]
            };
            data.push(mix4(front, pixel, u.s[3]));
        }
    }
    Img { size, pixels: Pixels::Color(data) }
}

/// The W3C compositing spec's luminance, SetLum and ClipColor (`color.wgsl`).
fn luminance(c: [f32; 3]) -> f32 {
    c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11
}
fn with_luminance(c: [f32; 3], l: f32) -> [f32; 3] {
    let d = l - luminance(c);
    let mut v = c.map(|x| x + d);
    let m = luminance(v);
    let low = v[0].min(v[1]).min(v[2]);
    let high = v[0].max(v[1]).max(v[2]);
    if low < 0.0 {
        v = v.map(|x| m + (x - m) * m / (m - low).max(0.000001));
    }
    if high > 1.0 {
        v = v.map(|x| m + (x - m) * (1.0 - m) / (high - m).max(0.000001));
    }
    v
}

/// Tint, grade, vignette and light sweep (`color.wgsl`), before the strength.
fn colour_op(u: &Uniform, c: C, at: [f32; 2]) -> C {
    let (p, q) = (u.p, u.q);
    let mut rgb = straight(c);
    let g = [u.origin[0] + at[0], u.origin[1] + at[1]];
    match u.operation {
        op::TINT => {
            let b = brush(u, at);
            let k = p[0] * b[3];
            let bc = [b[0], b[1], b[2]];
            let blended = match p[1] as i32 {
                1 => [0, 1, 2].map(|i| rgb[i] * bc[i]),
                2 => [0, 1, 2].map(|i| 1.0 - (1.0 - rgb[i]) * (1.0 - bc[i])),
                3 => [0, 1, 2].map(|i| if rgb[i] < 0.5 { 2.0 * rgb[i] * bc[i] } else { 1.0 - 2.0 * (1.0 - rgb[i]) * (1.0 - bc[i]) }),
                4 => with_luminance(bc, luminance(rgb)),
                5 => [0, 1, 2].map(|i| (rgb[i] + bc[i]).min(1.0)),
                _ => bc,
            };
            [mix(rgb[0], blended[0], k) * c[3], mix(rgb[1], blended[1], k) * c[3], mix(rgb[2], blended[2], k) * c[3], c[3]]
        }
        op::GRADE => {
            let e = p[0].exp2();
            rgb = rgb.map(|x| ((x * e) - 0.5) * p[1] + 0.5);
            let l = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
            rgb = rgb.map(|x| mix(l, x, p[2]));
            let (k, n) = (u.r[0], u.r[1]);
            let dot = |a: [f32; 3]| rgb[0] * a[0] + rgb[1] * a[1] + rgb[2] * a[2];
            rgb = [
                dot([0.213 + k * 0.787 - n * 0.213, 0.715 - k * 0.715 - n * 0.715, 0.072 - k * 0.072 + n * 0.928]),
                dot([0.213 - k * 0.213 + n * 0.143, 0.715 + k * 0.285 + n * 0.14, 0.072 - k * 0.072 - n * 0.283]),
                dot([0.213 - k * 0.213 - n * 0.787, 0.715 - k * 0.715 + n * 0.715, 0.072 + k * 0.928 + n * 0.072]),
            ];
            rgb = [rgb[0] + p[3] * 0.12, rgb[1] + q[0] * 0.12, rgb[2] - p[3] * 0.12];
            let lc = l.clamp(0.0, 1.0);
            let lift = q[1] * (1.0 - lc).powf(2.0) * 0.4 + q[2] * lc.powf(2.0) * 0.4;
            rgb = rgb.map(|x| (x + lift).max(0.0).powf(1.0 / q[3]));
            [rgb[0].clamp(0.0, 1.0) * c[3], rgb[1].clamp(0.0, 1.0) * c[3], rgb[2].clamp(0.0, 1.0) * c[3], c[3]]
        }
        op::VIGNETTE => {
            let mut xy = [(g[0] / u.output_size[0] - q[0]) * 2.0, (g[1] / u.output_size[1] - q[1]) * 2.0];
            xy[0] /= q[2];
            let distance = mix(xy[0].abs().max(xy[1].abs()), (xy[0] * xy[0] + xy[1] * xy[1]).sqrt() / std::f32::consts::SQRT_2, q[3]) / p[2];
            let dark = smoothstep(1.0 - p[1], 1.0, distance) * p[0];
            let b = brush(u, at);
            let k = dark * b[3];
            [mix(c[0], b[0] * c[3], k), mix(c[1], b[1] * c[3], k), mix(c[2], b[2] * c[3], k), c[3]]
        }
        _ => {
            let xy = [g[0] / u.output_size[0] - 0.5, g[1] / u.output_size[1] - 0.5];
            let position = xy[0] * p[1].cos() + xy[1] * p[1].sin() + 0.5;
            let distance = (position - p[0]).abs() * 2.0 / p[2];
            let light = 1.0 - smoothstep(1.0 - p[3], 1.0, distance);
            let b = brush(u, at);
            let k = b[3] * light * q[0] * c[3];
            [(c[0] + b[0] * k).clamp(0.0, c[3]), (c[1] + b[1] * k).clamp(0.0, c[3]), (c[2] + b[2] * k).clamp(0.0, c[3]), c[3]]
        }
    }
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

fn hash_point(i: [f32; 2], seed: u32) -> f32 {
    let (vx, vy) = (i[0] as i32 as u32, i[1] as i32 as u32);
    (hash_value(vx.wrapping_mul(1973).wrapping_add(vy.wrapping_mul(9277)).wrapping_add(seed.wrapping_mul(26699))) & 65535) as f32 / 65535.0
}

/// Value noise (`noiseAt` in `valuenoise.wgsl`).
fn noise_at(pos: [f32; 2], seed: u32, smoothness: f32) -> f32 {
    let i = [pos[0].floor(), pos[1].floor()];
    let f = [pos[0] - i[0], pos[1] - i[1]];
    let f = [mix(0.0, f[0] * f[0] * (3.0 - 2.0 * f[0]), smoothness), mix(0.0, f[1] * f[1] * (3.0 - 2.0 * f[1]), smoothness)];
    mix(
        mix(hash_point(i, seed), hash_point([i[0] + 1.0, i[1]], seed), f[0]),
        mix(hash_point([i[0], i[1] + 1.0], seed), hash_point([i[0] + 1.0, i[1] + 1.0], seed), f[0]),
        f[1],
    )
}

/// Value noise evolving along `z` (`noiseAtTime` in `valuenoise.wgsl`).
fn noise_at_time(pos: [f32; 2], z: f32, seed: u32, smoothness: f32) -> f32 {
    let zi = z.floor();
    let zf = z - zi;
    let s = seed.wrapping_add((zi as i32 as u32).wrapping_mul(7919));
    let a = noise_at(pos, s, smoothness);
    if zf == 0.0 {
        return a;
    }
    mix(a, noise_at(pos, s.wrapping_add(7919), smoothness), zf * zf * (3.0 - 2.0 * zf))
}

/// Four turned octaves of evolving value noise (`clouds` in `noise.wgsl`).
fn clouds(pos: [f32; 2], z: f32, seed: u32) -> f32 {
    let (mut total, mut weight, mut sum) = (0.0f32, 1.0f32, 0.0f32);
    let mut at = pos;
    for i in 0..4u32 {
        total += noise_at_time(at, z * (1.0 + i as f32 * 0.5), seed.wrapping_add(i * 1013), 1.0) * weight;
        sum += weight;
        weight *= 0.5;
        // mat2x2f(.8, .6, -.6, .8) * at * 2: columns (.8, .6) and (-.6, .8).
        at = [(0.8 * at[0] - 0.6 * at[1]) * 2.0, (0.6 * at[0] + 0.8 * at[1]) * 2.0];
    }
    ((total / sum - 0.5) * 1.6 + 0.5).clamp(0.0, 1.0)
}

/// Grain, clouds, dissolve and turbulence (`noise.wgsl`, `dissolve.wgsl`, `turbulence.wgsl`), before the strength.
fn noise_op(u: &Uniform, src: &Img, at: [f32; 2]) -> C {
    let (p, q) = (u.p, u.q);
    let g = [u.origin[0] + at[0], u.origin[1] + at[1]];
    match u.operation {
        op::TURBULENCE => {
            let mut xy = [g[0] / p[1], g[1] / p[1]];
            let mut offset = [0.0f32; 2];
            let (mut weight, mut total) = (1.0f32, 0.0f32);
            for i in 0..p[3] as u32 {
                let seed = u.seed[0].wrapping_add(i * 37);
                offset[0] += noise_at_time(xy, p[2], seed, 1.0) * weight;
                offset[1] += noise_at_time([xy[0] + 19.1, xy[1] + 7.7], p[2], seed.wrapping_add(131), 1.0) * weight;
                total += weight;
                weight *= 0.5;
                xy = [xy[0] * 2.0, xy[1] * 2.0];
            }
            let total = total.max(0.000001);
            let moved = [g[0] + (offset[0] / total * 2.0 - 1.0) * p[0], g[1] + (offset[1] / total * 2.0 - 1.0) * p[0]];
            src.sample([moved[0] - u.origin[0], moved[1] - u.origin[1]])
        }
        op::DISSOLVE => {
            let c = src.sample(at);
            let mut n = noise_at([g[0] / p[1], g[1] / p[1]], u.seed[0], 1.0);
            if q[0] > 0.0 {
                let xy = [g[0] / u.output_size[0] - 0.5, g[1] / u.output_size[1] - 0.5];
                let along = ((xy[0] * q[1] + xy[1] * q[2]) / (q[1].abs() + q[2].abs()).max(0.000001) + 0.5).clamp(0.0, 1.0);
                n = mix(n, along * 0.8 + n * 0.2, q[0]);
            }
            let keep = if p[0] <= 0.0 {
                1.0
            } else if p[0] >= 1.0 {
                0.0
            } else {
                smoothstep(p[0] - p[2], p[0] + p[2], n)
            };
            let edge = (1.0 - smoothstep(p[0], p[0] + p[3] + p[2], n)) * keep;
            let b = brush(u, at);
            let k = edge * b[3];
            [mix(c[0], b[0] * c[3], k) * keep, mix(c[1], b[1] * c[3], k) * keep, mix(c[2], b[2] * c[3], k) * keep, c[3] * keep]
        }
        _ => {
            let c = src.sample(at);
            let rgb = straight(c);
            let xy = [g[0] / p[1], g[1] / p[1]];
            let grain = if u.operation == op::CLOUDS {
                let seed = u.seed[1];
                let n = clouds(xy, q[1], seed) - 0.5;
                if q[0] > 0.0 { [n, clouds(xy, q[1], seed.wrapping_add(131)) - 0.5, clouds(xy, q[1], seed.wrapping_add(719)) - 0.5] } else { [n; 3] }
            } else {
                let seed = u.seed[0];
                let n = noise_at(xy, seed, p[3]) - 0.5;
                if q[0] > 0.0 { [n, noise_at(xy, seed.wrapping_add(131), p[3]) - 0.5, noise_at(xy, seed.wrapping_add(719), p[3]) - 0.5] } else { [n; 3] }
            };
            let k = p[0] * p[2];
            [(rgb[0] + grain[0] * k).clamp(0.0, 1.0) * c[3], (rgb[1] + grain[1] * k).clamp(0.0, 1.0) * c[3], (rgb[2] + grain[2] * k).clamp(0.0, 1.0) * c[3], c[3]]
        }
    }
}

/// RGB split, wave, shockwave and CRT (`warp.wgsl`), before the strength.
fn warp(u: &Uniform, src: &Img, at: [f32; 2]) -> C {
    let (p, q) = (u.p, u.q);
    let xy = [u.origin[0] + at[0], u.origin[1] + at[1]];
    let size = [src.size[0] as f32, src.size[1] as f32];
    let global = |g: [f32; 2]| {
        let t = [g[0] - u.origin[0], g[1] - u.origin[1]];
        if t[0] < 0.0 || t[1] < 0.0 || t[0] > size[0] || t[1] > size[1] { [0.0; 4] } else { src.sample(t) }
    };
    match u.operation {
        op::SPLIT => {
            let delta = [p[1].cos() * p[0], p[1].sin() * p[0]];
            let red = global([xy[0] + delta[0] * q[0], xy[1] + delta[1] * q[0]]);
            let green = global([xy[0] + delta[0] * q[1], xy[1] + delta[1] * q[1]]);
            let blue = global([xy[0] + delta[0] * q[2], xy[1] + delta[1] * q[2]]);
            [red[0], green[1], blue[2], red[3].max(green[3].max(blue[3]))]
        }
        op::WAVE => {
            let axis = [p[2].cos(), p[2].sin()];
            let wave = ((xy[0] * axis[0] + xy[1] * axis[1]) * 2.0 * PI / p[1] + p[3]).sin();
            global([xy[0] - axis[1] * wave * p[0], xy[1] + axis[0] * wave * p[0]])
        }
        op::SHOCK => {
            let delta = [xy[0] - q[0] * u.output_size[0], xy[1] - q[1] * u.output_size[1]];
            let distance = (delta[0] * delta[0] + delta[1] * delta[1]).sqrt();
            let ring = (distance - p[0]) / p[1];
            let strength = (ring * PI).sin() * (1.0 - ring.abs()).max(0.0).powf(p[3]) * p[2];
            let k = strength / distance.max(0.0001);
            global([xy[0] + delta[0] * k, xy[1] + delta[1] * k])
        }
        _ => {
            let curve = [xy[0] / u.output_size[0] * 2.0 - 1.0, xy[1] / u.output_size[1] * 2.0 - 1.0];
            let bend = 1.0 + p[2] * (curve[0] * curve[0] + curve[1] * curve[1]);
            let warped = [(curve[0] * bend * 0.5 + 0.5) * u.output_size[0], (curve[1] * bend * 0.5 + 0.5) * u.output_size[1]];
            let mut s = global(warped);
            if warped[0] < 0.0 || warped[1] < 0.0 || warped[0] >= u.output_size[0] || warped[1] >= u.output_size[1] {
                s = [0.0; 4];
            }
            if p[3] > 0.0 {
                s[0] = global([warped[0] + p[3], warped[1]])[0];
                s[2] = global([warped[0] - p[3], warped[1]])[2];
                s = [s[0].min(s[3]), s[1].min(s[3]), s[2].min(s[3]), s[3]];
            }
            let line = (0.5 + 0.5 * ((xy[1] + q[0]) * 2.0 * PI / p[1]).cos()) * p[0];
            let b = brush(u, at);
            let k = line * b[3];
            [mix(s[0], b[0] * s[3], k), mix(s[1], b[1] * s[3], k), mix(s[2], b[2] * s[3], k), s[3]]
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use styk_eval::vfx::registry::{Params, Tint};
    use styk_eval::vfx::{Color, Effect};
    use styk_render::effects::recipe::{record, Frame};

    #[test]
    fn a_tint_mixes_towards_its_colour() {
        let tint = Effect { id: Arc::from("t"), enabled: true, params: Params::Tint(Tint { color: Color::Rgb(0x0000ff), mix: 0.5, ..Default::default() }) };
        let mut records = Vec::new();
        let recorded = record(&mut records, &[Arc::new(tint)], Frame { scale: 1.0, origin: [0.0; 2], output_size: [2.0, 1.0] }, [2, 1]);
        // An opaque red pixel and a half-transparent white one.
        let out = run(&recorded, &records, vec![[255, 0, 0, 255], [128, 128, 128, 128]], [2, 1]);
        assert!(out[0][0].abs_diff(128) <= 1 && out[0][1] == 0 && out[0][2].abs_diff(128) <= 1 && out[0][3] == 255, "{:?}", out[0]);
        assert!(out[1][0].abs_diff(64) <= 1 && out[1][2].abs_diff(128) <= 1 && out[1][3] == 128, "{:?}", out[1]);
    }
}
