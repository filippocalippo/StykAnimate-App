//! The CPU stroke raster (`DrawingStroke` in drawing-pixels.mjs) and the stroke worker's
//! engine (`drawing-stroke-engine.mjs`).
//!
//! Dabs accumulate tile-local stroke coverage (single precision, as the JavaScript's
//! `Float32Array`); colour is composited once per batch from final coverage, the pixels
//! the stroke first saw and the blend mode. Opacity caps the whole stroke, flow
//! accumulates dabs, grain caps the coverage a pixel can reach, a selection mask clips
//! coverage. A provisional tail is rasterized into scratch coverage and replaced on every
//! update. Smudge composites every dab at once, since each reads the previous result.

use std::collections::{HashMap, HashSet};

use styk_doc::Value;

use crate::brush::{dab_shape, smudge_stride, Blend, Brush, BrushStroke, Dab, Grain, Point, Sample, Tip};
use crate::error::{fail, Result, WORKING_MEMORY};
use crate::js::{clamp01, max, min, round_u8, to_i32};
use crate::mask::{mask_value, Mask};
use crate::textures::{atlas, grain_base, hash, sample_grain, sample_tip, tip_base};
use crate::tiles::{change_of, TileChange, TileStore, Pixels, TILE, TILE_BYTES};

const AREA: usize = 64 * 64;
static ZERO: [u8; TILE_BYTES] = [0; TILE_BYTES];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Normal,
    Erase,
    Behind,
    Multiply,
    Screen,
    Overlay,
    Color,
    Smudge,
}

struct StrokeTile {
    tx: i64,
    ty: i64,
    before: Option<Pixels>,
    coverage: Box<[f32; AREA]>,
    pixels: Box<[u8; TILE_BYTES]>,
    grain: Option<Box<[f32; AREA]>>,
    pending: Option<(i64, i64, i64, i64)>,
}

/// An insertion-ordered set of tile indices (a JavaScript `Set` of tiles).
#[derive(Default)]
struct Order {
    items: Vec<usize>,
    present: HashSet<usize>,
}

impl Order {
    fn add(&mut self, i: usize) {
        if self.present.insert(i) {
            self.items.push(i);
        }
    }
    fn clear(&mut self) {
        self.items.clear();
        self.present.clear();
    }
    fn len(&self) -> usize {
        self.items.len()
    }
}

/// Stroke options beyond the brush (`settings.workingBytes`, the mask, seeded tiles).
#[derive(Clone, Debug, Default)]
pub struct StrokeOptions {
    pub working_bytes: Option<f64>,
    pub mask: Option<Mask>,
}

/// One stroke's raster on a tile store.
pub struct DrawingStroke {
    pub brush: Brush,
    mode: Mode,
    smudge: bool,
    lock: bool,
    skip_empty: bool,
    tip: Option<usize>,
    grain: Option<Option<usize>>,
    pub store: TileStore,
    seeded: Option<HashSet<(i64, i64)>>,
    mask: Option<Mask>,
    working_bytes: f64,
    tiles: Vec<StrokeTile>,
    index: HashMap<(i64, i64), usize>,
    dirty: Order,
    uncomposited: Order,
    tail_tiles: Order,
    tail_shapes: Vec<Dab>,
    tail_version: Option<u64>,
    pub dabs: usize,
    pub closed: bool,
    carry: Option<[f64; 4]>,
    soft: Option<std::rc::Rc<[f32]>>,
    pipeline: BrushStroke,
}

fn hash_pixel(x: i64, y: i64, seed: u32) -> f64 {
    hash(to_i32(x as f64), to_i32(y as f64), seed as i32)
}

const LUM: (f64, f64, f64) = (0.3, 0.59, 0.11);

fn lum(r: f64, g: f64, b: f64) -> f64 {
    LUM.0 * r + LUM.1 * g + LUM.2 * b
}

/// W3C non-separable SetLum/ClipColor on 0..255 channels (`setLum`).
fn set_lum(mut r: f64, mut g: f64, mut b: f64, l: f64) -> (f64, f64, f64) {
    let d = l - lum(r, g, b);
    r += d;
    g += d;
    b += d;
    let big_l = lum(r, g, b);
    let n = min(min(r, g), b);
    let x = max(max(r, g), b);
    if n < 0.0 {
        r = big_l + (r - big_l) * big_l / (big_l - n);
        g = big_l + (g - big_l) * big_l / (big_l - n);
        b = big_l + (b - big_l) * big_l / (big_l - n);
    }
    if x > 255.0 {
        r = big_l + (r - big_l) * (255.0 - big_l) / (x - big_l);
        g = big_l + (g - big_l) * (255.0 - big_l) / (x - big_l);
        b = big_l + (b - big_l) * (255.0 - big_l) / (x - big_l);
    }
    (r, g, b)
}

fn blend_channel(mode: Mode, b: f64, s: f64) -> f64 {
    match mode {
        Mode::Multiply => b * s / 255.0,
        Mode::Screen => b + s - b * s / 255.0,
        Mode::Overlay => {
            if b <= 127.5 {
                2.0 * b * s / 255.0
            } else {
                255.0 - 2.0 * (255.0 - b) * (255.0 - s) / 255.0
            }
        }
        _ => s,
    }
}

impl DrawingStroke {
    /// `new DrawingStroke(store, settings, {requireTile, mask})`; `seeded` refuses tiles
    /// the caller never supplied.
    pub fn new(store: TileStore, brush: Brush, options: StrokeOptions, seeded: Option<HashSet<(i64, i64)>>) -> DrawingStroke {
        let mode = if brush.erase {
            Mode::Erase
        } else {
            match brush.blend {
                Blend::Normal => Mode::Normal,
                Blend::Behind => Mode::Behind,
                Blend::Multiply => Mode::Multiply,
                Blend::Screen => Mode::Screen,
                Blend::Overlay => Mode::Overlay,
                Blend::Color => Mode::Color,
                Blend::Smudge => Mode::Smudge,
            }
        };
        let tip = if brush.tip == Tip::Round { None } else { tip_base(brush.tip.name()) };
        let grain = (brush.texture > 0.0).then(|| if brush.grain == Grain::Noise { None } else { grain_base(brush.grain.name()) });
        if tip.is_some() || matches!(grain, Some(Some(_))) {
            atlas();
        }
        DrawingStroke {
            pipeline: BrushStroke::new(brush.clone(), None),
            mode,
            smudge: mode == Mode::Smudge,
            lock: brush.alpha_lock && mode != Mode::Erase && mode != Mode::Behind,
            skip_empty: mode == Mode::Erase || (brush.alpha_lock && mode != Mode::Behind),
            tip,
            grain,
            brush,
            store,
            seeded,
            mask: options.mask,
            working_bytes: options.working_bytes.unwrap_or(768.0 * 1024.0 * 1024.0),
            tiles: Vec::new(),
            index: HashMap::new(),
            dirty: Order::default(),
            uncomposited: Order::default(),
            tail_tiles: Order::default(),
            tail_shapes: Vec::new(),
            tail_version: None,
            dabs: 0,
            closed: false,
            carry: None,
            soft: None,
        }
    }

    pub fn working_bytes(&self) -> f64 {
        self.working_bytes
    }

    fn tile(&mut self, tx: i64, ty: i64) -> Result<usize> {
        if let Some(&i) = self.index.get(&(tx, ty)) {
            return Ok(i);
        }
        if let Some(seeded) = &self.seeded {
            if !seeded.contains(&(tx, ty)) {
                return fail("errors.drawingStrokeEngine.aBrushDabReachedDrawingPixelsThatWere");
            }
        }
        let grain = self.brush.texture > 0.0;
        if ((self.tiles.len() + 1) * TILE_BYTES * if grain { 6 } else { 5 }) as f64 > self.working_bytes {
            return fail(WORKING_MEMORY);
        }
        let before = self.store.get(tx, ty).map(|t| t.pixels.clone());
        self.store.writable(tx, ty, true)?;
        let pixels: Box<[u8; TILE_BYTES]> = Box::new(match &before {
            Some(p) => **p,
            None => [0; TILE_BYTES],
        });
        let grain = if grain { Some(self.grain_tile(tx, ty)) } else { None };
        self.tiles.push(StrokeTile { tx, ty, before, coverage: Box::new([0f32; AREA]), pixels, grain, pending: None });
        let i = self.tiles.len() - 1;
        self.index.insert((tx, ty), i);
        Ok(i)
    }

    /// Per-pixel coverage cap `1 − texture·(1 − g)` over one tile.
    fn grain_tile(&self, tx: i64, ty: i64) -> Box<[f32; AREA]> {
        let mut out = Box::new([0f32; AREA]);
        let k = self.brush.texture;
        let (ox, oy) = (tx * TILE, ty * TILE);
        let base = self.grain.flatten();
        let scale = self.brush.grain_scale;
        for y in 0..TILE {
            for x in 0..TILE {
                let g = match base {
                    Some(base) => sample_grain(atlas(), base, (ox + x) as f64, (oy + y) as f64, scale),
                    None => hash_pixel(ox + x, oy + y, self.brush.seed),
                };
                out[(y * TILE + x) as usize] = (1.0 - k * (1.0 - g)) as f32;
            }
        }
        out
    }

    fn soft_lut(&mut self) -> std::rc::Rc<[f32]> {
        if self.soft.is_none() {
            let n = 4096usize;
            let soft = 1.0 / max(1e-6, 1.0 - self.brush.hardness);
            let lut: Vec<f32> = (0..=n)
                .map(|i| {
                    let t = clamp01((1.0 - (i as f64 / n as f64).sqrt()) * soft);
                    (t * t * (3.0 - 2.0 * t)) as f32
                })
                .collect();
            self.soft = Some(lut.into());
        }
        self.soft.clone().unwrap()
    }

    /// Rasterizes final dab shapes, then optionally replaces the provisional tail.
    pub fn paint(&mut self, shapes: &[Dab], tail: Option<&[Dab]>) -> Result<()> {
        if self.closed {
            return fail("errors.drawingBrush.theStrokeHasAlreadyEnded");
        }
        for shape in shapes {
            self.add_shape(shape)?;
        }
        self.composite();
        match tail {
            Some(tail) => self.set_tail(tail.to_vec())?,
            None => {
                if !shapes.is_empty() && self.tail_tiles.len() > 0 {
                    let shapes = std::mem::take(&mut self.tail_shapes);
                    self.set_tail(shapes)?;
                }
            }
        }
        Ok(())
    }

    /// Paints one path point as a single dab (`dab(p)`).
    pub fn dab(&mut self, p: &Point) -> Result<()> {
        let shape = dab_shape(&self.brush, p, self.brush.seed);
        self.paint(shape.as_slice(), None)
    }

    fn add_shape(&mut self, shape: &Dab) -> Result<()> {
        self.dabs += 1;
        if self.smudge { self.smudge_dab(shape) } else { self.accumulate(shape, None) }
    }

    /// One dab's coverage into each tile's final coverage, or into `scratch` (tile →
    /// coverage copy, in insertion order) for the provisional tail. As in the JavaScript,
    /// a tile the stroke already holds gets its scratch copy when the dab visits it.
    fn accumulate(&mut self, shape: &Dab, mut scratch: Option<&mut Vec<(usize, Box<[f32; AREA]>)>>) -> Result<()> {
        let Dab { x: cx, y: cy, radius, opacity, flow, cos, sin, left, top, right, bottom } = *shape;
        let roundness = self.brush.roundness;
        let ellipse = roundness < 0.999;
        let inv = 1.0 / roundness;
        let r2 = radius * radius;
        let hard = self.brush.hardness >= 0.999;
        let inner = if radius >= 1.0 { (radius - 1.0) * (radius - 1.0) } else { -1.0 };
        let inv_r = 1.0 / radius;
        let tip = self.tip;
        let tip_atlas = if tip.is_some() { Some(atlas()) } else { None };
        let rotate = ellipse || tip_atlas.is_some();
        let lut = if hard { None } else { Some(self.soft_lut()) };
        let scale = lut.as_ref().map_or(0.0, |l| (l.len() - 1) as f64 / r2);
        let mask = self.mask.take();
        let result = (|| -> Result<()> {
            let mut ty = (top / TILE as f64).floor() as i64;
            while ((ty * TILE) as f64) < bottom {
                let mut tx = (left / TILE as f64).floor() as i64;
                while ((tx * TILE) as f64) < right {
                    let mut tile = self.index.get(&(tx, ty)).copied();
                    if tile.is_none() && self.skip_empty && !self.store.has(tx, ty) {
                        tx += 1;
                        continue;
                    }
                    // Where this dab reads and writes coverage in this tile.
                    let mut slot: Option<Slot> = tile.map(|i| resolve(&self.tiles, scratch.as_deref_mut(), i));
                    let (mut x0d, mut y0d, mut x1d, mut y1d) = (TILE, TILE, -1i64, -1i64);
                    let (ox, oy) = (tx * TILE, ty * TILE);
                    let y0 = max(top, oy as f64) as i64;
                    let y1 = min(bottom, (oy + TILE) as f64) as i64;
                    for y in y0..y1 {
                        let dy = y as f64 + 0.5 - cy;
                        let mut x0 = max(left, ox as f64);
                        let mut x1 = min(right, (ox + TILE) as f64);
                        if !ellipse {
                            let span = r2 - dy * dy;
                            if span <= 0.0 {
                                continue;
                            }
                            let w = span.sqrt();
                            x0 = max(x0, (cx - w - 0.5).floor());
                            x1 = min(x1, (cx + w + 0.5).ceil());
                        }
                        let row = (y - oy) * TILE - ox;
                        let mut row_hit = false;
                        let (x0, x1) = (x0 as i64, x1 as i64);
                        for x in x0..x1 {
                            let q = (row + x) as usize;
                            let previous = match slot {
                                Some(Slot::Final(i)) => self.tiles[i].coverage[q] as f64,
                                Some(Slot::Scratch(k)) => scratch.as_deref().unwrap()[k].1[q] as f64,
                                None => 0.0,
                            };
                            if previous >= opacity {
                                continue;
                            }
                            let mut dx = x as f64 + 0.5 - cx;
                            let mut ddy = dy;
                            if rotate {
                                let u = dx * cos + ddy * sin;
                                ddy = (ddy * cos - dx * sin) * inv;
                                dx = u;
                            }
                            let d2 = dx * dx + ddy * ddy;
                            if d2 >= r2 {
                                continue;
                            }
                            let mut e = (match &lut {
                                None => {
                                    if d2 <= inner { 1.0 } else { clamp01(radius - d2.sqrt()) }
                                }
                                Some(lut) => lut[to_i32(d2 * scale) as usize] as f64,
                            }) * flow;
                            if let (Some(bytes), Some(base)) = (tip_atlas, tip) {
                                e *= sample_tip(bytes, base, dx * inv_r, ddy * inv_r);
                            }
                            if let Some(mask) = &mask {
                                e *= mask_value(mask, x, y);
                            }
                            // NaN is not `<= 0` in JavaScript either.
                            if e <= 0.0 {
                                continue;
                            }
                            let i = match tile {
                                Some(i) => i,
                                None => {
                                    let i = self.tile(tx, ty)?;
                                    tile = Some(i);
                                    slot = Some(resolve(&self.tiles, scratch.as_deref_mut(), i));
                                    i
                                }
                            };
                            let cap = match &self.tiles[i].grain {
                                Some(g) => opacity * g[q] as f64,
                                None => opacity,
                            };
                            if previous >= cap {
                                continue;
                            }
                            let value = (previous + (cap - previous) * e) as f32;
                            match slot.unwrap() {
                                Slot::Final(i) => self.tiles[i].coverage[q] = value,
                                Slot::Scratch(k) => scratch.as_deref_mut().unwrap()[k].1[q] = value,
                            }
                            row_hit = true;
                            let lx = x - ox;
                            if lx < x0d {
                                x0d = lx;
                            }
                            if lx > x1d {
                                x1d = lx;
                            }
                        }
                        if row_hit {
                            let ly = y - oy;
                            if ly < y0d {
                                y0d = ly;
                            }
                            y1d = ly;
                        }
                    }
                    if x1d >= 0 && scratch.is_none() {
                        let i = tile.unwrap();
                        let t = &mut self.tiles[i];
                        match &mut t.pending {
                            Some(d) => {
                                d.0 = d.0.min(x0d);
                                d.1 = d.1.min(y0d);
                                d.2 = d.2.max(x1d);
                                d.3 = d.3.max(y1d);
                            }
                            None => t.pending = Some((x0d, y0d, x1d, y1d)),
                        }
                        self.dirty.add(i);
                        self.uncomposited.add(i);
                    }
                    tx += 1;
                }
                ty += 1;
            }
            Ok(())
        })();
        self.mask = mask;
        result
    }

    /// Replaces the provisional tail: tiles it covers composite final coverage plus the
    /// tail, tiles it left return to final coverage alone.
    fn set_tail(&mut self, shapes: Vec<Dab>) -> Result<()> {
        let mut scratch: Vec<(usize, Box<[f32; AREA]>)> = Vec::new();
        for shape in &shapes {
            self.accumulate(shape, Some(&mut scratch))?;
        }
        let mut order: Vec<usize> = self.tail_tiles.items.clone();
        let mut seen: HashSet<usize> = order.iter().copied().collect();
        for (i, _) in &scratch {
            if seen.insert(*i) {
                order.push(*i);
            }
        }
        for i in order {
            match scratch.iter().find(|(k, _)| *k == i) {
                Some((_, cov)) => {
                    let cov = cov.clone();
                    self.composite_tile(i, &cov[..], 0, 0, TILE - 1, TILE - 1);
                }
                None => {
                    let cov = self.tiles[i].coverage.clone();
                    self.composite_tile(i, &cov[..], 0, 0, TILE - 1, TILE - 1);
                }
            }
            self.dirty.add(i);
        }
        self.tail_tiles.clear();
        for (i, _) in &scratch {
            self.tail_tiles.add(*i);
        }
        self.tail_shapes = shapes;
        Ok(())
    }

    /// Smudge: carries the colour under the tip along the stroke, compositing at once.
    fn smudge_dab(&mut self, shape: &Dab) -> Result<()> {
        let Dab { radius, opacity, flow, .. } = *shape;
        let strength = opacity * flow;
        let roundness = self.brush.roundness;
        let ellipse = roundness < 0.999;
        let inv = 1.0 / roundness;
        let r2 = radius * radius;
        let hard = self.brush.hardness >= 0.999;
        let lut = if hard { None } else { Some(self.soft_lut()) };
        let scale = lut.as_ref().map_or(0.0, |l| (l.len() - 1) as f64 / r2);
        let mask = self.mask.take();
        let result = self.smudge_with(shape, strength, ellipse, inv, r2, hard, lut, scale, &mask);
        self.mask = mask;
        result
    }

    #[allow(clippy::too_many_arguments)]
    fn smudge_with(&mut self, shape: &Dab, strength: f64, ellipse: bool, inv: f64, r2: f64, hard: bool, lut: Option<std::rc::Rc<[f32]>>, scale: f64, mask: &Option<Mask>) -> Result<()> {
        let Dab { x: cx, y: cy, radius, cos, sin, left, top, right, bottom, .. } = *shape;
        let weight = |x: i64, y: i64| -> f64 {
            let mut dx = x as f64 + 0.5 - cx;
            let mut dy = y as f64 + 0.5 - cy;
            if ellipse {
                let u = dx * cos + dy * sin;
                dy = (dy * cos - dx * sin) * inv;
                dx = u;
            }
            let d2 = dx * dx + dy * dy;
            if d2 >= r2 {
                return 0.0;
            }
            let mut e = if hard {
                if d2 <= (radius - 1.0) * (radius - 1.0) { 1.0 } else { clamp01(radius - d2.sqrt()) }
            } else {
                lut.as_ref().unwrap()[to_i32(d2 * scale) as usize] as f64
            };
            if let Some(mask) = mask {
                e *= mask_value(mask, x, y);
            }
            e
        };
        let stride = smudge_stride(right - left, bottom - top);
        let (mut sr, mut sg, mut sb, mut sa, mut sw) = (0f64, 0f64, 0f64, 0f64, 0f64);
        let t = TILE as f64;
        let mut ty = (top / t).floor() as i64;
        while ((ty * TILE) as f64) < bottom {
            let mut tx = (left / t).floor() as i64;
            while ((tx * TILE) as f64) < right {
                let (ox, oy) = ((tx * TILE) as f64, (ty * TILE) as f64);
                let pixels: Option<&[u8]> = match self.index.get(&(tx, ty)) {
                    Some(&i) => Some(&self.tiles[i].pixels[..]),
                    None => self.store.get(tx, ty).map(|tile| &tile.pixels[..]),
                };
                let x0 = left + ((max(left, ox) - left) / stride).ceil() * stride;
                let y0 = top + ((max(top, oy) - top) / stride).ceil() * stride;
                let x1 = min(right, ox + t);
                let y1 = min(bottom, oy + t);
                let mut y = y0;
                while y < y1 {
                    let mut x = x0;
                    while x < x1 {
                        let e = weight(x as i64, y as i64);
                        if e != 0.0 && !e.is_nan() {
                            sw += e;
                            if let Some(p) = pixels {
                                let j = (((y - oy) as i64 * TILE + (x - ox) as i64) * 4) as usize;
                                let a = p[j + 3] as f64 / 255.0;
                                sr += p[j] as f64 * a * e;
                                sg += p[j + 1] as f64 * a * e;
                                sb += p[j + 2] as f64 * a * e;
                                sa += a * e;
                            }
                        }
                        x += stride;
                    }
                    y += stride;
                }
                tx += 1;
            }
            ty += 1;
        }
        if sw == 0.0 || sw.is_nan() {
            return Ok(());
        }
        let sample = [sr / sw, sg / sw, sb / sw, sa / sw];
        let length = self.brush.smudge_length;
        let rate = self.brush.color_rate;
        let mut carry = match self.carry {
            Some(c) => [0, 1, 2, 3].map(|i| c[i] * length + sample[i] * (1.0 - length)),
            None => sample,
        };
        if rate > 0.0 {
            let [br, bg, bb] = self.brush.color;
            let brush = [br, bg, bb, 1.0];
            for i in 0..4 {
                carry[i] = carry[i] * (1.0 - rate) + (if i < 3 { brush[i] } else { 1.0 }) * rate;
            }
        }
        self.carry = Some(carry);
        let mut ty = (top / t).floor() as i64;
        while ((ty * TILE) as f64) < bottom {
            let mut tx = (left / t).floor() as i64;
            while ((tx * TILE) as f64) < right {
                let mut tile = self.index.get(&(tx, ty)).copied();
                let mut changed = false;
                let ys = max(top, (ty * TILE) as f64) as i64;
                let ye = min(bottom, (ty * TILE + TILE) as f64) as i64;
                let xs = max(left, (tx * TILE) as f64) as i64;
                let xe = min(right, (tx * TILE + TILE) as f64) as i64;
                for y in ys..ye {
                    for x in xs..xe {
                        let e = weight(x, y) * strength;
                        if e <= 0.0 {
                            continue;
                        }
                        let i = match tile {
                            Some(i) => i,
                            None => {
                                if (carry[3] == 0.0 || carry[3].is_nan()) && !self.store.has(tx, ty) {
                                    continue;
                                }
                                let i = self.tile(tx, ty)?;
                                tile = Some(i);
                                i
                            }
                        };
                        let px = &mut self.tiles[i].pixels;
                        let j = (((y - ty * TILE) * TILE + x - tx * TILE) * 4) as usize;
                        let a = px[j + 3] as f64 / 255.0;
                        let pa = a * (1.0 - e) + carry[3] * e;
                        if pa <= 0.0 {
                            px[j..j + 4].fill(0);
                            changed = true;
                            continue;
                        }
                        px[j] = round_u8((px[j] as f64 * a * (1.0 - e) + carry[0] * e) / pa);
                        px[j + 1] = round_u8((px[j + 1] as f64 * a * (1.0 - e) + carry[1] * e) / pa);
                        px[j + 2] = round_u8((px[j + 2] as f64 * a * (1.0 - e) + carry[2] * e) / pa);
                        px[j + 3] = round_u8(pa * 255.0);
                        changed = true;
                    }
                }
                if changed {
                    self.dirty.add(tile.unwrap());
                }
                tx += 1;
            }
            ty += 1;
        }
        Ok(())
    }

    /// Writes each pending tile span's colour from its final coverage.
    fn composite(&mut self) {
        let items = std::mem::take(&mut self.uncomposited.items);
        self.uncomposited.present.clear();
        for i in items {
            let Some(d) = self.tiles[i].pending.take() else { continue };
            let cov = std::mem::replace(&mut self.tiles[i].coverage, Box::new([0f32; AREA]));
            self.composite_tile(i, &cov[..], d.0, d.1, d.2, d.3);
            self.tiles[i].coverage = cov;
        }
    }

    /// The colour of a tile span from `cov`: final coverage, the pixels the stroke first
    /// saw and the blend mode.
    fn composite_tile(&mut self, i: usize, cov: &[f32], x0: i64, y0: i64, x1: i64, y1: i64) {
        let mode = self.mode;
        let lock = self.lock;
        let separable = matches!(mode, Mode::Multiply | Mode::Screen | Mode::Overlay | Mode::Color);
        let [sr, sg, sb] = self.brush.color;
        let tile = &mut self.tiles[i];
        let src: &[u8] = match &tile.before {
            Some(p) => &p[..],
            None => &ZERO[..],
        };
        let px = &mut tile.pixels;
        for y in y0..=y1 {
            let mut q = (y * TILE + x0) as usize;
            let end = (y * TILE + x1) as usize;
            while q <= end {
                let c = cov[q] as f64;
                let j = q * 4;
                q += 1;
                if c == 0.0 || c.is_nan() {
                    px[j..j + 4].copy_from_slice(&src[j..j + 4]);
                    continue;
                }
                let ba = src[j + 3] as f64 / 255.0;
                let (br, bg, bb) = (src[j] as f64, src[j + 1] as f64, src[j + 2] as f64);
                if mode == Mode::Erase {
                    px[j + 3] = round_u8(ba * (1.0 - c) * 255.0);
                    px[j] = src[j];
                    px[j + 1] = src[j + 1];
                    px[j + 2] = src[j + 2];
                    continue;
                }
                if mode == Mode::Behind {
                    let out = ba + c * (1.0 - ba);
                    let k = c * (1.0 - ba);
                    px[j + 3] = round_u8(out * 255.0);
                    px[j] = round_u8((br * ba + sr * k) / out);
                    px[j + 1] = round_u8((bg * ba + sg * k) / out);
                    px[j + 2] = round_u8((bb * ba + sb * k) / out);
                    continue;
                }
                let (mut r, mut g, mut b) = (sr, sg, sb);
                if separable && ba > 0.0 {
                    let (mr, mg, mb) = if mode == Mode::Color {
                        set_lum(sr, sg, sb, lum(br, bg, bb))
                    } else {
                        (blend_channel(mode, br, sr), blend_channel(mode, bg, sg), blend_channel(mode, bb, sb))
                    };
                    r = (1.0 - ba) * sr + ba * mr;
                    g = (1.0 - ba) * sg + ba * mg;
                    b = (1.0 - ba) * sb + ba * mb;
                }
                if lock {
                    px[j + 3] = src[j + 3];
                    px[j] = round_u8(br + (r - br) * c);
                    px[j + 1] = round_u8(bg + (g - bg) * c);
                    px[j + 2] = round_u8(bb + (b - bb) * c);
                    continue;
                }
                let out = c + ba * (1.0 - c);
                let k = ba * (1.0 - c);
                px[j + 3] = round_u8(out * 255.0);
                px[j] = round_u8((r * c + br * k) / out);
                px[j + 1] = round_u8((g * c + bg * k) / out);
                px[j + 2] = round_u8((b * c + bb * k) / out);
            }
        }
    }

    /// Paints from one input sample through the brush pipeline (`sample(input)`).
    pub fn sample(&mut self, input: &Sample) -> Result<()> {
        if self.closed {
            return fail("errors.drawingBrush.theStrokeHasAlreadyEnded");
        }
        let mut shapes = Vec::new();
        self.pipeline.sample(input, &mut |d| shapes.push(d))?;
        for shape in &shapes {
            self.add_shape(shape)?;
        }
        self.composite();
        if self.pipeline.has_tail() && Some(self.pipeline.tail_version) != self.tail_version {
            self.tail_version = Some(self.pipeline.tail_version);
            let tail = self.pipeline.tail_shapes().to_vec();
            self.set_tail(tail)?;
        }
        Ok(())
    }

    /// Restores every touched tile (`cancel()`).
    pub fn cancel(&mut self) {
        if self.closed {
            return;
        }
        for t in &self.tiles {
            match &t.before {
                Some(p) => {
                    let _ = self.store.adopt(t.tx, t.ty, p.clone(), crate::tiles::Alpha::Unknown);
                }
                None => self.store.delete(t.tx, t.ty),
            }
        }
        self.closed = true;
    }

    /// Ends the stroke: the exact undo records of every changed tile, in the order the
    /// stroke first touched them.
    pub fn finish(&mut self) -> Result<Vec<TileChange>> {
        if self.closed {
            return Ok(Vec::new());
        }
        let mut shapes = Vec::new();
        self.pipeline.finish(&mut |d| shapes.push(d));
        for shape in &shapes {
            self.add_shape(shape)?;
        }
        self.composite();
        if self.tail_tiles.len() > 0 {
            self.set_tail(Vec::new())?;
        }
        self.closed = true;
        let mut changes = Vec::new();
        for t in &self.tiles {
            let after: Pixels = std::sync::Arc::new(*t.pixels);
            if let Some(change) = change_of(t.tx as i32, t.ty as i32, t.before.as_ref(), Some(&after)) {
                changes.push(change);
            }
            let _ = self.store.adopt(t.tx, t.ty, after, crate::tiles::Alpha::Unknown);
        }
        Ok(changes)
    }

    /// Tiles changed since the last call, with their current pixels, in the order they
    /// were first marked (`dirtyTiles`).
    pub fn take_dirty(&mut self) -> Vec<(i64, i64, Vec<u8>)> {
        let items = std::mem::take(&mut self.dirty.items);
        self.dirty.present.clear();
        items.into_iter().map(|i| (self.tiles[i].tx, self.tiles[i].ty, self.tiles[i].pixels.to_vec())).collect()
    }

    /// The pixels of every tile the stroke touched, as they are now (tests and previews).
    pub fn current(&self) -> TileStore {
        let mut store = self.store.clone();
        for t in &self.tiles {
            let _ = store.adopt(t.tx, t.ty, std::sync::Arc::new(*t.pixels), crate::tiles::Alpha::Unknown);
        }
        store
    }
}

#[derive(Clone, Copy)]
enum Slot {
    Final(usize),
    Scratch(usize),
}

/// The coverage a dab uses in tile `i`: its final coverage, or its scratch copy (made
/// from the final coverage on first use) while painting the provisional tail.
fn resolve(tiles: &[StrokeTile], scratch: Option<&mut Vec<(usize, Box<[f32; AREA]>)>>, i: usize) -> Slot {
    match scratch {
        None => Slot::Final(i),
        Some(s) => match s.iter().position(|(k, _)| *k == i) {
            Some(k) => Slot::Scratch(k),
            None => {
                s.push((i, tiles[i].coverage.clone()));
                Slot::Scratch(s.len() - 1)
            }
        },
    }
}

/// A tile the main thread seeds a stroke with: its pixels, or `None` for an empty tile.
pub struct SeedTile {
    pub tx: i64,
    pub ty: i64,
    pub pixels: Option<Vec<u8>>,
}

/// What a batch changed: the dirty tiles and the rectangle covering them.
pub struct BatchResult {
    pub tiles: Vec<(i64, i64, Vec<u8>)>,
    pub dirty: Option<crate::tiles::Rect>,
}

struct EngineStroke {
    seeded: HashSet<(i64, i64)>,
    stroke: DrawingStroke,
    seq: f64,
}

/// The stroke worker's engine: strokes by id, batches in sequence order, every dab
/// confined to tiles the main thread seeded.
#[derive(Default)]
pub struct StrokeEngine {
    strokes: HashMap<u64, EngineStroke>,
}

impl StrokeEngine {
    pub fn new() -> StrokeEngine {
        StrokeEngine::default()
    }

    /// `begin(id, settings)`.
    pub fn begin(&mut self, id: u64, settings: &Value, mask: Option<Mask>) -> Result<()> {
        self.strokes.remove(&id);
        let brush = Brush::normalize(settings)?;
        let working_bytes = settings.as_obj().and_then(|o| o.get("workingBytes")).and_then(Value::as_f64);
        let stroke = DrawingStroke::new(TileStore::new(), brush, StrokeOptions { working_bytes, mask }, Some(HashSet::new()));
        self.strokes.insert(id, EngineStroke { seeded: HashSet::new(), stroke, seq: 0.0 });
        Ok(())
    }

    /// `dabs(id, seq, dabs, tiles, tail)`: `None` for an unknown stroke or a stale batch.
    pub fn dabs(&mut self, id: u64, seq: f64, dabs: &[Dab], tiles: Vec<SeedTile>, tail: Option<&[Dab]>) -> Result<Option<BatchResult>> {
        let Some(s) = self.strokes.get_mut(&id) else { return Ok(None) };
        if seq <= s.seq {
            return Ok(None);
        }
        s.seq = seq;
        if s.stroke.store.bytes() + (tiles.len() * TILE_BYTES) as f64 > s.stroke.working_bytes() / 2.0 {
            return fail(WORKING_MEMORY);
        }
        for t in tiles {
            if !s.seeded.insert((t.tx, t.ty)) {
                continue;
            }
            s.stroke.seeded.as_mut().unwrap().insert((t.tx, t.ty));
            if let Some(pixels) = &t.pixels {
                s.stroke.store.set(t.tx, t.ty, Some(pixels))?;
            }
        }
        s.stroke.paint(dabs, tail)?;
        let changed = s.stroke.take_dirty();
        let mut dirty: Option<crate::tiles::Rect> = None;
        for (tx, ty, _) in &changed {
            let (x, y) = (tx * TILE, ty * TILE);
            dirty = Some(match dirty {
                None => crate::tiles::Rect::new(x, y, TILE, TILE),
                Some(d) => {
                    let x0 = d.x.min(x);
                    let y0 = d.y.min(y);
                    crate::tiles::Rect::new(x0, y0, (d.x + d.width).max(x + TILE) - x0, (d.y + d.height).max(y + TILE) - y0)
                }
            });
        }
        Ok(Some(BatchResult { tiles: changed, dirty }))
    }

    /// `end(id)`: the stroke's undo records, or `None` for an unknown stroke.
    pub fn end(&mut self, id: u64) -> Result<Option<Vec<TileChange>>> {
        let Some(mut s) = self.strokes.remove(&id) else { return Ok(None) };
        Ok(Some(s.stroke.finish()?))
    }

    /// `cancel(id)`.
    pub fn cancel(&mut self, id: u64) {
        self.strokes.remove(&id);
    }
}
