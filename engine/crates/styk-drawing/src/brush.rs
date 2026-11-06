//! The brush model (`drawing-brush.mjs`, `drawing-smoother.mjs`): settings, the pen
//! pressure curve, the stroke path (stabilization, quadratic midpoint curves, dab spacing
//! by arc length, tapers) and `dab_shape`, which turns each path dab into its final tip
//! with exact pixel bounds. Pure geometry: no pixels.
//!
//! The JavaScript shares point objects between its path fields (a pulled string's anchor
//! is also the previous raw point, whose pressure the resting string updates), so points
//! here are shared cells where JavaScript shares objects.

use std::cell::Cell;
use std::rc::Rc;

use styk_doc::Value;

use crate::error::{fail, Result};
use crate::js::{clamp, clamp01, max, min, to_u32};

pub const BLENDS: [&str; 7] = ["normal", "behind", "multiply", "screen", "overlay", "color", "smudge"];
pub const LINEAR_PRESSURE: [f64; 4] = [0.25, 0.25, 0.75, 0.75];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Blend {
    Normal,
    Behind,
    Multiply,
    Screen,
    Overlay,
    Color,
    Smudge,
}

impl Blend {
    fn named(name: &str) -> Option<Blend> {
        Some(match name {
            "normal" => Blend::Normal,
            "behind" => Blend::Behind,
            "multiply" => Blend::Multiply,
            "screen" => Blend::Screen,
            "overlay" => Blend::Overlay,
            "color" => Blend::Color,
            "smudge" => Blend::Smudge,
            _ => return None,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tip {
    Round,
    Chalk,
    Bristle,
    Sponge,
}

impl Tip {
    pub fn name(self) -> &'static str {
        match self {
            Tip::Round => "round",
            Tip::Chalk => "chalk",
            Tip::Bristle => "bristle",
            Tip::Sponge => "sponge",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Grain {
    Noise,
    Paper,
    Canvas,
}

impl Grain {
    pub fn name(self) -> &'static str {
        match self {
            Grain::Noise => "noise",
            Grain::Paper => "paper",
            Grain::Canvas => "canvas",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AngleMode {
    Fixed,
    Direction,
    Tilt,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stabilizer {
    Average,
    String,
}

/// Normalized brush settings (`normalizeBrush`).
#[derive(Clone, Debug, PartialEq)]
pub struct Brush {
    pub size: f64,
    pub color: [f64; 3],
    pub opacity: f64,
    pub flow: f64,
    pub hardness: f64,
    pub erase: bool,
    pub pressure_size: bool,
    pub pressure_opacity: bool,
    pub pressure_flow: bool,
    pub size_curve: f64,
    pub opacity_curve: f64,
    pub pressure_curve: [f64; 4],
    pub stabilization: f64,
    pub stabilizer_mode: Stabilizer,
    pub spacing_ratio: f64,
    pub tip: Tip,
    pub roundness: f64,
    pub angle: f64,
    pub angle_mode: AngleMode,
    pub scatter: f64,
    pub size_jitter: f64,
    pub opacity_jitter: f64,
    pub angle_jitter: f64,
    pub taper_in: f64,
    pub taper_out: f64,
    pub texture: f64,
    pub grain: Grain,
    pub grain_scale: f64,
    pub blend: Blend,
    pub alpha_lock: bool,
    pub smudge_length: f64,
    pub color_rate: f64,
    pub seed: u32,
    pub pixels_per_unit: f64,
}

/// JavaScript truthiness of a settings value (`Boolean(value)`).
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Num(n) => *n != 0.0 && !n.is_nan(),
        Value::Str(s) => !s.is_empty(),
        _ => true,
    }
}

const NUMBERS: [&str; 21] = [
    "size", "opacity", "flow", "hardness", "sizeCurve", "opacityCurve", "stabilization", "spacingRatio", "roundness", "angle", "scatter", "sizeJitter", "opacityJitter", "angleJitter", "taperIn", "taperOut", "texture",
    "grainScale", "smudgeLength", "colorRate", "pixelsPerUnit",
];

fn default_number(key: &str) -> f64 {
    match key {
        "size" => 8.0,
        "opacity" | "flow" | "hardness" | "sizeCurve" | "opacityCurve" | "roundness" | "grainScale" | "pixelsPerUnit" => 1.0,
        "spacingRatio" => 0.12,
        "smudgeLength" => 0.8,
        _ => 0.0,
    }
}

impl Brush {
    /// `normalizeBrush(settings)` of a settings object (JSON, as the editor posts it).
    /// Unknown keys are ignored; a non-finite number or a malformed colour is refused.
    pub fn normalize(settings: &Value) -> Result<Brush> {
        let invalid = || fail("errors.drawingBrush.invalidBrushSettings");
        let get = |key: &str| settings.as_obj().and_then(|o| o.get(key));
        let mut numbers = [0f64; 21];
        for (i, key) in NUMBERS.iter().enumerate() {
            numbers[i] = match get(key) {
                None => default_number(key),
                Some(v) => match v.as_f64() {
                    Some(n) if n.is_finite() => n,
                    _ => return invalid(),
                },
            };
        }
        let n = |key: &str| numbers[NUMBERS.iter().position(|k| *k == key).unwrap()];
        let color = match get("color") {
            None => [0.0; 3],
            Some(v) => {
                let items: Vec<f64> = match v.as_nums() {
                    Some(nums) => nums.to_vec(),
                    None => match v.as_arr() {
                        Some(items) => {
                            let mut out = Vec::new();
                            for item in items {
                                match item.as_f64() {
                                    Some(x) => out.push(x),
                                    None => return invalid(),
                                }
                            }
                            out
                        }
                        None => return invalid(),
                    },
                };
                if items.len() != 3 || !items.iter().all(|x| x.is_finite()) {
                    return invalid();
                }
                [items[0], items[1], items[2]]
            }
        };
        let flag = |key: &str, default: bool| get(key).map_or(default, truthy);
        let text = |key: &str| get(key).and_then(Value::as_str);
        let curve = match get("pressureCurve") {
            Some(v) => {
                let items: Option<Vec<f64>> = v.as_nums().map(|n| n.to_vec()).or_else(|| v.as_arr().and_then(|a| a.iter().map(Value::as_f64).collect()));
                match items {
                    Some(c) if c.len() == 4 && c.iter().all(|x| x.is_finite()) => [clamp01(c[0]), clamp01(c[1]), clamp01(c[2]), clamp01(c[3])],
                    _ => LINEAR_PRESSURE,
                }
            }
            None => LINEAR_PRESSURE,
        };
        let erase = flag("erase", false);
        let blend = text("blend").and_then(Blend::named).unwrap_or(Blend::Normal);
        let smudge = blend == Blend::Smudge && !erase;
        let tip = match text("tip") {
            Some("round") | None => Tip::Round,
            Some("chalk") => Tip::Chalk,
            Some("bristle") => Tip::Bristle,
            Some("sponge") => Tip::Sponge,
            Some(_) => Tip::Round,
        };
        let seed = match get("seed") {
            None => 0,
            Some(Value::Num(x)) => to_u32(*x),
            Some(Value::Bool(b)) => *b as u32,
            Some(_) => 0,
        };
        Ok(Brush {
            size: clamp(n("size"), 0.5, 8192.0),
            color: [clamp(color[0], 0.0, 255.0), clamp(color[1], 0.0, 255.0), clamp(color[2], 0.0, 255.0)],
            opacity: clamp01(n("opacity")),
            flow: clamp01(n("flow")),
            hardness: clamp01(n("hardness")),
            erase,
            pressure_size: flag("pressureSize", true),
            pressure_opacity: flag("pressureOpacity", false),
            pressure_flow: flag("pressureFlow", false),
            size_curve: clamp(n("sizeCurve"), 0.1, 4.0),
            opacity_curve: clamp(n("opacityCurve"), 0.1, 4.0),
            pressure_curve: curve,
            stabilization: clamp(n("stabilization"), 0.0, 0.95),
            stabilizer_mode: if text("stabilizerMode") == Some("string") { Stabilizer::String } else { Stabilizer::Average },
            spacing_ratio: clamp(n("spacingRatio"), 0.01, 1.0),
            tip: if smudge { Tip::Round } else { tip },
            roundness: clamp(n("roundness"), 0.05, 1.0),
            angle: ((n("angle") % 360.0) + 360.0) % 360.0,
            angle_mode: match text("angleMode") {
                Some("direction") => AngleMode::Direction,
                Some("tilt") => AngleMode::Tilt,
                _ => AngleMode::Fixed,
            },
            scatter: clamp(n("scatter"), 0.0, 4.0),
            size_jitter: clamp01(n("sizeJitter")),
            opacity_jitter: clamp01(n("opacityJitter")),
            angle_jitter: clamp01(n("angleJitter")),
            taper_in: clamp(n("taperIn"), 0.0, 1e5),
            taper_out: if smudge { 0.0 } else { clamp(n("taperOut"), 0.0, 1e5) },
            texture: if smudge { 0.0 } else { clamp01(n("texture")) },
            grain: match text("grain") {
                Some("paper") => Grain::Paper,
                Some("canvas") => Grain::Canvas,
                _ => Grain::Noise,
            },
            grain_scale: clamp(n("grainScale"), 0.05, 64.0),
            blend,
            alpha_lock: flag("alphaLock", false),
            smudge_length: clamp01(n("smudgeLength")),
            color_rate: clamp01(n("colorRate")),
            seed,
            pixels_per_unit: clamp(n("pixelsPerUnit"), 0.01, 64.0),
        })
    }

    /// `dabRadius(brush, pressure)`: the radius at a (curve-mapped) pressure before jitter
    /// and taper.
    pub fn dab_radius(&self, pressure: f64) -> f64 {
        self.size * (if self.pressure_size { max(0.05, styk_math::pow(clamp01(pressure), self.size_curve)) } else { 1.0 }) / 2.0
    }

    pub fn smudge(&self) -> bool {
        self.blend == Blend::Smudge && !self.erase
    }
}

/// `smudgeStride(width, height)`: smudge samples every `stride` pixels, at most 64×64.
pub fn smudge_stride(width: f64, height: f64) -> f64 {
    max(1.0, (max(width, height) / 64.0).ceil())
}

/// The pen pressure curve as its 257-entry table (`pressureMap`); `None` for the identity.
#[derive(Clone, Debug)]
pub struct PressureMap {
    lut: Vec<f32>,
}

impl PressureMap {
    pub fn new(curve: [f64; 4]) -> Option<PressureMap> {
        let [x1, y1, x2, y2] = curve;
        if (x1 - y1).abs() < 1e-6 && (x2 - y2).abs() < 1e-6 {
            return None;
        }
        let bez = |t: f64, a: f64, b: f64| 3.0 * (1.0 - t) * (1.0 - t) * t * a + 3.0 * (1.0 - t) * t * t * b + t * t * t;
        let mut lut = vec![0f32; 257];
        for (i, v) in lut.iter_mut().enumerate() {
            let x = i as f64 / 256.0;
            let (mut lo, mut hi) = (0.0f64, 1.0f64);
            for _ in 0..32 {
                let mid = (lo + hi) / 2.0;
                if bez(mid, x1, x2) < x {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            *v = clamp01(bez((lo + hi) / 2.0, y1, y2)) as f32;
        }
        Some(PressureMap { lut })
    }
    pub fn map(&self, p: f64) -> f64 {
        let f = clamp01(p) * 256.0;
        let i = min(255.0, f.floor());
        let at = |k: f64| self.lut[k as usize] as f64;
        at(i) + (at(i + 1.0) - at(i)) * (f - i)
    }
}

/// `jitterAt(seed, index, channel)`: a hash in [0, 1).
pub fn jitter_at(seed: u32, index: f64, channel: u32) -> f64 {
    let mut h = (seed ^ 0x9E37_79B9).wrapping_mul(0x85EB_CA6B) ^ to_u32(index + 1.0).wrapping_mul(0xC2B2_AE35) ^ (channel + 1).wrapping_mul(0x27D4_EB2F);
    h = (h ^ (h >> 16)).wrapping_mul(0x7FEB_352D);
    h = (h ^ (h >> 15)).wrapping_mul(0x846C_A68B);
    (h ^ (h >> 16)) as f64 / 4294967296.0
}

/// A path point (`{x, y, pressure, time, ax, ay}` with the fields the pipeline adds).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
    pub pressure: f64,
    pub time: f64,
    pub ax: f64,
    pub ay: f64,
    pub dir: f64,
    pub dist: f64,
    pub index: f64,
    pub taper: f64,
}

impl Default for Point {
    /// JavaScript reads absent fields as `pressure ?? 1`, `taper ?? 1`, `index ?? 0`, `dir ?? 0`.
    fn default() -> Point {
        Point { x: 0.0, y: 0.0, pressure: 1.0, time: 0.0, ax: 0.0, ay: 0.0, dir: 0.0, dist: 0.0, index: 0.0, taper: 1.0 }
    }
}

/// One input sample (pointer position in cel pixels, pressure and tilt).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sample {
    pub x: f64,
    pub y: f64,
    pub pressure: Option<f64>,
    pub time: Option<f64>,
    pub ax: Option<f64>,
    pub ay: Option<f64>,
}

/// The final tip of one dab, with its pixel bounds `[left, right) × [top, bottom)`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Dab {
    pub x: f64,
    pub y: f64,
    pub radius: f64,
    pub opacity: f64,
    pub flow: f64,
    pub cos: f64,
    pub sin: f64,
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}

/// Floats per dab in the packed form exchanged with JavaScript.
pub const DAB_FLOATS: usize = 11;

impl Dab {
    pub fn pack(&self, out: &mut Vec<f64>) {
        out.extend_from_slice(&[self.x, self.y, self.radius, self.opacity, self.flow, self.cos, self.sin, self.left, self.top, self.right, self.bottom]);
    }
    pub fn unpack(v: &[f64]) -> Dab {
        Dab { x: v[0], y: v[1], radius: v[2], opacity: v[3], flow: v[4], cos: v[5], sin: v[6], left: v[7], top: v[8], right: v[9], bottom: v[10] }
    }
}

/// `dabShape(brush, p, seed)`; `None` for a dab that deposits nothing.
pub fn dab_shape(brush: &Brush, p: &Point, seed: u32) -> Option<Dab> {
    let pressure = clamp01(p.pressure);
    let i = p.index;
    let mut radius = brush.dab_radius(pressure) * p.taper;
    if brush.size_jitter > 0.0 {
        radius *= 1.0 - brush.size_jitter * jitter_at(seed, i, 0);
    }
    let (mut x, mut y) = (p.x, p.y);
    if brush.scatter > 0.0 {
        let a = jitter_at(seed, i, 3) * std::f64::consts::PI * 2.0;
        let d = jitter_at(seed, i, 4) * brush.scatter * brush.size / 2.0;
        x += styk_math::cos(a) * d;
        y += styk_math::sin(a) * d;
    }
    let mut opacity = brush.opacity * if brush.pressure_opacity { styk_math::pow(pressure, brush.opacity_curve) } else { 1.0 };
    if brush.opacity_jitter > 0.0 {
        opacity *= 1.0 - brush.opacity_jitter * jitter_at(seed, i, 1);
    }
    let flow = brush.flow * if brush.pressure_flow { pressure } else { 1.0 };
    if opacity <= 0.0 || flow <= 0.0 || radius <= 0.0 {
        return None;
    }
    let turn = match brush.angle_mode {
        AngleMode::Direction => p.dir,
        AngleMode::Tilt if (p.ax != 0.0 && !p.ax.is_nan()) || (p.ay != 0.0 && !p.ay.is_nan()) => styk_math::atan2(p.ay, p.ax),
        _ => 0.0,
    };
    let mut theta = brush.angle * std::f64::consts::PI / 180.0 + turn;
    if brush.angle_jitter > 0.0 {
        theta += (jitter_at(seed, i, 2) * 2.0 - 1.0) * std::f64::consts::PI * brush.angle_jitter;
    }
    let cos = styk_math::cos(theta);
    let sin = styk_math::sin(theta);
    let (mut hx, mut hy) = (radius, radius);
    if brush.roundness < 0.999 {
        let rb = radius * brush.roundness;
        hx = ((radius * cos) * (radius * cos) + (rb * sin) * (rb * sin)).sqrt();
        hy = ((radius * sin) * (radius * sin) + (rb * cos) * (rb * cos)).sqrt();
    }
    Some(Dab { x, y, radius, opacity, flow, cos, sin, left: (x - hx).floor(), top: (y - hy).floor(), right: (x + hx).ceil(), bottom: (y + hy).ceil() })
}

fn lerp(a: &Point, b: &Point, t: f64) -> Point {
    Point {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        pressure: a.pressure + (b.pressure - a.pressure) * t,
        time: a.time + (b.time - a.time) * t,
        ax: a.ax + (b.ax - a.ax) * t,
        ay: a.ay + (b.ay - a.ay) * t,
        ..Point::default()
    }
}

/// `taperCurve(t)`: rises quickly from a point and eases into full size.
pub fn taper_curve(t: f64) -> f64 {
    if t >= 1.0 {
        return 1.0;
    }
    let u = 1.0 - max(0.0, t);
    max(0.02, 1.0 - u * u)
}

pub const MAX_SMOOTHING_SAMPLES: usize = 4096;

/// `DrawingSmoother`: a distance-windowed, linear-ramp centroid with running sums.
#[derive(Clone, Debug)]
pub struct Smoother {
    window: f64,
    points: Vec<([f64; 6], f64, f64, f64)>,
    head: usize,
    sum: [f64; 6],
    weighted: [f64; 6],
    origin: Option<[f64; 6]>,
}

impl Smoother {
    pub fn new(window: f64) -> Smoother {
        Smoother { window, points: Vec::new(), head: 0, sum: [0.0; 6], weighted: [0.0; 6], origin: None }
    }
    pub fn size(&self) -> usize {
        self.points.len() - self.head
    }
    pub fn add(&mut self, p: &Point) -> Point {
        let raw = [p.x, p.y, p.pressure, p.time, p.ax, p.ay];
        let origin = *self.origin.get_or_insert(raw);
        let distance = match self.points.last() {
            Some(&(_, distance, px, py)) => distance + styk_math::hypot(p.x - px, p.y - py),
            None => 0.0,
        };
        let mut values = [0.0; 6];
        for i in 0..6 {
            values[i] = raw[i] - origin[i];
        }
        let weight = (self.size() + 1) as f64;
        self.points.push((values, distance, p.x, p.y));
        for i in 0..6 {
            self.sum[i] += values[i];
            self.weighted[i] += weight * values[i];
        }
        while self.size() > 2 && (distance - self.points[self.head].1 > self.window || self.size() > MAX_SMOOTHING_SAMPLES) {
            self.shift();
        }
        self.value()
    }
    pub fn shift(&mut self) {
        let old = self.points[self.head].0;
        self.head += 1;
        for i in 0..6 {
            self.weighted[i] -= self.sum[i];
            self.sum[i] -= old[i];
        }
        if self.head >= 1024 && self.head * 2 >= self.points.len() {
            self.points.drain(..self.head);
            self.head = 0;
        }
    }
    pub fn value(&self) -> Point {
        let size = self.size() as f64;
        let divisor = size * (size + 1.0) / 2.0;
        let origin = self.origin.unwrap_or([0.0; 6]);
        let v: Vec<f64> = (0..6).map(|i| origin[i] + self.weighted[i] / divisor).collect();
        Point { x: v[0], y: v[1], pressure: v[2], time: v[3], ax: v[4], ay: v[5], ..Point::default() }
    }
}

type Shared = Rc<Cell<Point>>;

fn shared(p: Point) -> Shared {
    Rc::new(Cell::new(p))
}

/// `StrokePath`: input path → evenly spaced dabs carrying their arc length.
#[derive(Debug)]
pub struct StrokePath {
    size: f64,
    pressure_size: bool,
    size_curve: f64,
    spacing_ratio: f64,
    stabilization: f64,
    stabilizer_mode: Stabilizer,
    pixels_per_unit: f64,
    taper_in: f64,
    pub count: usize,
    pub dist: f64,
    pub dir: Option<f64>,
    last_dab: Option<Shared>,
    prev_raw: Option<Shared>,
    prev_mid: Option<Shared>,
    remaining: f64,
    smoother: Option<Smoother>,
    anchor: Option<Shared>,
    raw_last: Option<Shared>,
    pub closed: bool,
}

impl StrokePath {
    pub fn new(brush: &Brush) -> StrokePath {
        StrokePath {
            size: brush.size,
            pressure_size: brush.pressure_size,
            size_curve: brush.size_curve,
            spacing_ratio: brush.spacing_ratio,
            stabilization: brush.stabilization,
            stabilizer_mode: brush.stabilizer_mode,
            pixels_per_unit: brush.pixels_per_unit,
            taper_in: brush.taper_in,
            count: 0,
            dist: 0.0,
            dir: None,
            last_dab: None,
            prev_raw: None,
            prev_mid: None,
            remaining: 0.0,
            smoother: None,
            anchor: None,
            raw_last: None,
            closed: false,
        }
    }

    /// Dab spacing at this pressure before the 0.25 px floor.
    pub fn raw_spacing(&self, pressure: f64) -> f64 {
        self.size * self.spacing_ratio * if self.pressure_size { max(0.05, styk_math::pow(clamp01(pressure), self.size_curve)) } else { 1.0 }
    }

    fn string_length(&self) -> f64 {
        self.stabilization * 64.0 * self.pixels_per_unit
    }

    /// The last dab's point (`lastDab`).
    pub fn last_dab(&self) -> Option<Point> {
        self.last_dab.as_ref().map(|p| p.get())
    }

    fn spacing_scale(&self, dist: f64) -> f64 {
        if self.taper_in > 0.0 { taper_curve(dist / self.taper_in) } else { 1.0 }
    }

    fn out(&mut self, p: &Shared, dist: f64, emit: &mut dyn FnMut(Point)) {
        self.last_dab = Some(p.clone());
        self.count += 1;
        let v = p.get();
        let mut copy = lerp(&v, &v, 0.0);
        copy.dir = self.dir.unwrap_or(0.0);
        copy.dist = dist;
        emit(copy);
    }

    pub fn sample(&mut self, input: &Sample, emit: &mut dyn FnMut(Point)) -> Result<()> {
        if self.closed {
            return fail("errors.drawingBrush.theStrokeHasAlreadyEnded");
        }
        let pressure = input.pressure.unwrap_or(1.0);
        let time = input.time.unwrap_or(0.0);
        if ![input.x, input.y, pressure, time].iter().all(|v| v.is_finite()) {
            return Ok(());
        }
        let finite = |v: Option<f64>| v.filter(|v| v.is_finite()).unwrap_or(0.0);
        let p = shared(Point { x: input.x, y: input.y, pressure, time, ax: finite(input.ax), ay: finite(input.ay), ..Point::default() });
        self.raw_last = Some(p.clone());
        if self.stabilization <= 0.0 {
            self.push(p, emit);
            return Ok(());
        }
        if self.stabilizer_mode == Stabilizer::String {
            let Some(a) = self.anchor.clone() else {
                self.anchor = Some(p.clone());
                self.push(p, emit);
                return Ok(());
            };
            let (av, pv) = (a.get(), p.get());
            let dx = pv.x - av.x;
            let dy = pv.y - av.y;
            let d = styk_math::hypot(dx, dy);
            let length = self.string_length();
            if d <= length {
                let mut rest = av;
                rest.pressure = pv.pressure;
                a.set(rest);
                return Ok(());
            }
            let k = (d - length) / d;
            let anchor = shared(Point { x: av.x + dx * k, y: av.y + dy * k, ..pv });
            self.anchor = Some(anchor.clone());
            self.push(anchor, emit);
            return Ok(());
        }
        let window = self.stabilization * 48.0 * self.pixels_per_unit;
        let smoothed = self.smoother.get_or_insert_with(|| Smoother::new(window)).add(&p.get());
        self.push(shared(smoothed), emit);
        Ok(())
    }

    /// Joins a path point to the previous one with a quadratic midpoint segment.
    fn push(&mut self, p: Shared, emit: &mut dyn FnMut(Point)) {
        let Some(prev) = self.prev_raw.clone() else {
            self.out(&p, 0.0, emit);
            self.prev_raw = Some(p);
            self.prev_mid = None;
            self.remaining = 0.0;
            return;
        };
        let mid = shared(lerp(&prev.get(), &p.get(), 0.5));
        let start = self.prev_mid.clone().unwrap_or_else(|| prev.clone());
        self.curve(start.get(), prev.get(), mid.get(), emit);
        self.prev_raw = Some(p);
        self.prev_mid = Some(mid);
    }

    fn curve(&mut self, a: Point, c: Point, b: Point, emit: &mut dyn FnMut(Point)) {
        let scale = self.spacing_scale(self.dist);
        let spacing_at = |me: &StrokePath, pressure: f64| max(0.25, me.raw_spacing(pressure) * scale);
        let spacing = min(min(spacing_at(self, a.pressure), spacing_at(self, c.pressure)), spacing_at(self, b.pressure));
        let q = |t: f64| {
            let u = 1.0 - t;
            let (w0, w1, w2) = (u * u, 2.0 * u * t, t * t);
            Point {
                x: w0 * a.x + w1 * c.x + w2 * b.x,
                y: w0 * a.y + w1 * c.y + w2 * b.y,
                pressure: w0 * a.pressure + w1 * c.pressure + w2 * b.pressure,
                time: w0 * a.time + w1 * c.time + w2 * b.time,
                ax: w0 * a.ax + w1 * c.ax + w2 * b.ax,
                ay: w0 * a.ay + w1 * c.ay + w2 * b.ay,
                ..Point::default()
            }
        };
        let length = styk_math::hypot(c.x - a.x, c.y - a.y) + styk_math::hypot(b.x - c.x, b.y - c.y);
        let steps = max(4.0, min(64.0, (length / (spacing / 2.0)).ceil()));
        let steps = if steps.is_nan() { 0 } else { steps as usize };
        let mut prev = a;
        for i in 1..=steps {
            let p = q(i as f64 / steps as f64);
            let seg = styk_math::hypot(p.x - prev.x, p.y - prev.y);
            if seg > 0.0 {
                self.dir = Some(styk_math::atan2(p.y - prev.y, p.x - prev.x));
            }
            let step = min(spacing_at(self, prev.pressure), spacing_at(self, p.pressure));
            let mut pos = (1.0 - self.remaining) * step;
            while seg > 0.0 && seg >= pos {
                let dab = shared(lerp(&prev, &p, pos / seg));
                let dist = self.dist + pos;
                self.out(&dab, dist, emit);
                pos += step;
            }
            self.remaining = (self.remaining + seg / step) % 1.0;
            self.dist += seg;
            prev = p;
        }
    }

    pub fn finish(&mut self, emit: &mut dyn FnMut(Point)) {
        if self.closed {
            return;
        }
        self.closed = true;
        if self.smoother.is_some() {
            while self.smoother.as_ref().unwrap().size() > 1 {
                let smoother = self.smoother.as_mut().unwrap();
                smoother.shift();
                let value = smoother.value();
                self.push(shared(value), emit);
            }
        }
        let end = self.anchor.clone().or_else(|| self.raw_last.clone());
        if let (Some(prev), Some(end)) = (self.prev_raw.clone(), end) {
            let (e, pr) = (end.get(), prev.get());
            if e.x != pr.x || e.y != pr.y {
                self.push(end.clone(), emit);
            }
            let prev = self.prev_raw.clone().unwrap();
            self.push(prev, emit);
            let e = end.get();
            let last = self.last_dab.as_ref().map(|p| p.get());
            if last.map(|l| l.x) != Some(e.x) || last.map(|l| l.y) != Some(e.y) {
                let dist = self.dist;
                self.out(&end, dist, emit);
            }
        }
    }
}

/// `BrushStroke`: pressure curve → path → tapers → dab shapes, in order. With a taper-out
/// the dabs within `taper_out` of the pen stay provisional (`tail_shapes`) until the end.
#[derive(Debug)]
pub struct BrushStroke {
    pub brush: Brush,
    pub seed: u32,
    pressure: Option<PressureMap>,
    index: f64,
    tail: Vec<Point>,
    pub tail_version: u64,
    tail_cache: Option<(u64, Vec<Dab>)>,
    pub path: StrokePath,
    pub closed: bool,
}

impl BrushStroke {
    pub fn new(brush: Brush, seed: Option<u32>) -> BrushStroke {
        let seed = seed.unwrap_or(brush.seed);
        BrushStroke {
            pressure: PressureMap::new(brush.pressure_curve),
            path: StrokePath::new(&brush),
            brush,
            seed,
            index: 0.0,
            tail: Vec::new(),
            tail_version: 0,
            tail_cache: None,
            closed: false,
        }
    }

    fn taper_in(&self, dist: f64) -> f64 {
        if self.brush.taper_in > 0.0 { taper_curve(dist / self.brush.taper_in) } else { 1.0 }
    }

    /// The pressure an input value maps to through the pen curve.
    pub fn map_pressure(&self, pressure: f64) -> f64 {
        self.pressure.as_ref().map_or(pressure, |m| m.map(pressure))
    }

    /// Maps one input sample through the pressure curve into the path; final dabs reach `paint`.
    pub fn sample(&mut self, input: &Sample, paint: &mut dyn FnMut(Dab)) -> Result<()> {
        if self.closed {
            return fail("errors.drawingBrush.theStrokeHasAlreadyEnded");
        }
        let mut input = *input;
        if let (Some(map), Some(p)) = (&self.pressure, input.pressure) {
            input.pressure = Some(map.map(p));
        }
        let mut points = Vec::new();
        self.path.sample(&input, &mut |p| points.push(p))?;
        for p in points {
            self.emit(p, paint);
        }
        Ok(())
    }

    fn emit(&mut self, mut p: Point, paint: &mut dyn FnMut(Dab)) {
        p.index = self.index;
        self.index += 1.0;
        let length = self.brush.taper_out;
        if length.is_nan() || length <= 0.0 {
            let taper = self.taper_in(p.dist);
            self.final_dab(p, taper, paint);
            return;
        }
        self.tail.push(p);
        self.tail_version += 1;
        let mut n = 0;
        while n + 1 < self.tail.len() && p.dist - self.tail[n].dist >= length {
            n += 1;
        }
        if n > 0 {
            let done: Vec<Point> = self.tail.drain(..n).collect();
            for q in done {
                let taper = self.taper_in(q.dist);
                self.final_dab(q, taper, paint);
            }
        }
    }

    fn final_dab(&self, mut p: Point, taper: f64, paint: &mut dyn FnMut(Dab)) {
        p.taper = taper;
        if let Some(shape) = dab_shape(&self.brush, &p, self.seed) {
            paint(shape);
        }
    }

    /// The provisional shapes of the untapered tail, cached until the tail changes.
    pub fn tail_shapes(&mut self) -> &[Dab] {
        if self.tail_cache.as_ref().map(|c| c.0) != Some(self.tail_version) {
            let mut shapes = Vec::new();
            for p in &self.tail {
                let mut q = *p;
                q.taper = self.taper_in(p.dist);
                if let Some(shape) = dab_shape(&self.brush, &q, self.seed) {
                    shapes.push(shape);
                }
            }
            self.tail_cache = Some((self.tail_version, shapes));
        }
        &self.tail_cache.as_ref().unwrap().1
    }

    pub fn has_tail(&self) -> bool {
        self.brush.taper_out > 0.0
    }

    pub fn finish(&mut self, paint: &mut dyn FnMut(Dab)) {
        if self.closed {
            return;
        }
        let mut points = Vec::new();
        self.path.finish(&mut |p| points.push(p));
        for p in points {
            self.emit(p, paint);
        }
        self.closed = true;
        let tail = std::mem::take(&mut self.tail);
        self.tail_version += 1;
        if self.path.dist < 1.0 {
            for p in &tail {
                self.final_dab(*p, 1.0, paint);
            }
            if tail.is_empty() && self.brush.taper_in > 0.0 {
                if let Some(last) = self.path.last_dab() {
                    let p = Point { dir: self.path.dir.unwrap_or(0.0), dist: 0.0, index: self.index, ..last };
                    self.index += 1.0;
                    self.final_dab(p, 1.0, paint);
                }
            }
            return;
        }
        if !tail.is_empty() {
            self.taper_tail(&tail, paint);
        }
    }

    fn taper_tail(&mut self, tail: &[Point], paint: &mut dyn FnMut(Dab)) {
        let end = tail[tail.len() - 1].dist;
        let length = self.brush.taper_out;
        let mut i = 0usize;
        let mut d = tail[0].dist;
        while d <= end {
            while i + 2 < tail.len() && tail[i + 1].dist < d {
                i += 1;
            }
            let a = tail[i];
            let b = tail[(i + 1).min(tail.len() - 1)];
            let span = b.dist - a.dist;
            let t = if span > 0.0 { clamp01((d - a.dist) / span) } else { 0.0 };
            let mut p = lerp(&a, &b, t);
            let taper = min(self.taper_in(d), taper_curve((end - d) / length));
            p.dir = if t < 0.5 { a.dir } else { b.dir };
            p.dist = d;
            p.index = self.index;
            self.index += 1.0;
            self.final_dab(p, taper, paint);
            d += max(0.25, self.path.raw_spacing(p.pressure) * taper);
        }
    }
}
