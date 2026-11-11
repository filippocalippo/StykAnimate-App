//! The vocabulary of generated-effect layers:
//! the sub-emitters that effect styles compile into ([`super::styles`]) and the
//! batch packs into records ([`super::batch`]). Sizes and speeds are stage
//! pixels and pixels per frame; lives are frames.

use super::super::paint;
use super::super::Color;

/// Particle shapes (`SHAPE`).
pub const DISC: u8 = 0;
pub const STREAK: u8 = 1;
pub const RING: u8 = 2;
pub const CHUNK: u8 = 3;
pub const BEAM: u8 = 4;
pub const ARC: u8 = 5;
pub const SPRITE: u8 = 6;
pub const SQUARE: u8 = 7;

/// Emitters (`EMIT`).
pub const POINT: u8 = 0;
pub const BODY: u8 = 1;
pub const BEAM_LINE: u8 = 2;
pub const EMIT_RING: u8 = 3;
pub const BEAM_TIP: u8 = 4;
pub const GROUND: u8 = 5;
pub const LINE: u8 = 6;
pub const STAGE: u8 = 7;

/// Blending (`BLEND`): `AUTO` adds light on dark scenes and paints solid on light ones.
pub const NORMAL: u8 = 0;
pub const ADD: u8 = 1;
pub const AUTO: u8 = 2;

/// Sprite orientation (`ROTATE`): random with spin, along the motion, upright with a slight tilt, fixed.
pub const ROTATE_RANDOM: u8 = 0;
pub const ROTATE_MOTION: u8 = 1;
pub const ROTATE_UPRIGHT: u8 = 2;
pub const ROTATE_FIXED: u8 = 3;

/// Size over life (`GROW`): eased curve, fast puff, pop in and shrink away, flicker.
pub const GROW_CURVE: u8 = 0;
pub const GROW_PUFF: u8 = 1;
pub const GROW_POP: u8 = 2;
pub const GROW_FLICKER: u8 = 3;

pub const COLOR_STOPS: usize = 8;
/// "Forever" for untimed clips (`FAR`).
pub const FAR: f64 = 1e7;

/// Cells of the material atlas a material's particles choose from (`MATERIALS`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Material {
    pub row: u32,
    pub col: u32,
    pub count: u32,
}

/// Material rows of the procedural atlas, in atlas order (`ROW_LIST`).
pub const ROWS: [&str; 17] = ["smoke", "cloud", "flame", "toonFlame", "star", "bokeh", "wisp", "bolt", "shard", "rock", "leaf", "petal", "flake", "drop", "splat", "burst", "cute"];

/// `MATERIALS[name]`: every row but `cute` is one material of eight variants;
/// `cute` holds hearts (four) and cartoon stars (four).
pub fn material(name: &str) -> Material {
    match name {
        "heart" => Material { row: 16, col: 0, count: 4 },
        "toonStar" => Material { row: 16, col: 4, count: 4 },
        _ => Material { row: ROWS.iter().position(|row| *row == name && *row != "cute").unwrap_or_else(|| panic!("unknown particle material {name}")) as u32, col: 0, count: 8 },
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Placement {
    Front,
    Behind,
}

/// Trailing copies of the same particles a few frames earlier.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Echoes {
    pub count: u32,
    pub lag: f64,
    pub alpha: f64,
    pub size: f64,
}

/// A larger soft disc under each particle.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Halo {
    pub scale: f64,
    pub alpha: f64,
}

/// The particle drawn wider in a flat colour before its fill.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Outline {
    pub width: f64,
    pub color: [f64; 3],
}

/// The parameter a layer's emission follows when keyed (`rateParam`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RateParam {
    Density,
    Amount,
    Rate,
}

impl RateParam {
    pub fn name(self) -> &'static str {
        match self {
            RateParam::Density => "density",
            RateParam::Amount => "amount",
            RateParam::Rate => "rate",
        }
    }
}

/// One layer specification (`layer()` over `LAYER`): every field with the
/// editor's default. A material makes it a textured sprite.
#[derive(Clone, Debug, PartialEq)]
pub struct Spec {
    pub placement: Placement,
    pub start: f64,
    pub emit_dur: f64,
    pub count: f64,
    pub rate: f64,
    pub life_min: f64,
    pub life_max: f64,
    pub speed_min: f64,
    pub speed_max: f64,
    pub angle: f64,
    pub spread: f64,
    pub gravity: f64,
    pub wind: f64,
    pub drag: f64,
    pub radial: f64,
    pub turb: f64,
    pub turb_scale: f64,
    pub spin: f64,
    pub spin_jitter: f64,
    pub shape: u8,
    pub blend: u8,
    pub size0: f64,
    pub size1: f64,
    pub stretch: f64,
    pub softness: f64,
    pub fade_in: f64,
    pub fade_out: f64,
    pub alpha: f64,
    pub color_mode: f64,
    pub emit_shape: u8,
    pub emit_radius: f64,
    pub inherit: f64,
    pub burst_jitter: f64,
    pub size_jitter: f64,
    pub size_curve: f64,
    pub collide: f64,
    pub clip_fade_in: f64,
    pub clip_fade_out: f64,
    pub prewarm: f64,
    pub beam_w: f64,
    pub wobble: f64,
    pub grow: f64,
    pub fire_start: f64,
    pub fire_end: f64,
    pub fade_frames: f64,
    pub arc_segs: f64,
    pub arc_amp: f64,
    pub beam_style: f64,
    /// Eight stops: `[r, g, b, intensity]` (`None`: white at intensity 1).
    pub colors: Option<[[f64; 4]; COLOR_STOPS]>,
    /// Stop opacities (`None`: opaque).
    pub opacity: Option<[f64; COLOR_STOPS]>,
    /// Particles keep the anchor their target had when they were born.
    pub world: bool,
    /// Explosions burst from a fixed point.
    pub fixed: Option<[f64; 2]>,
    /// The layer emits from the target's outline.
    pub body: bool,
    pub material: Option<Material>,
    pub shade: f64,
    pub rotate: u8,
    pub aspect: f64,
    pub frame_rate: f64,
    pub orbit: f64,
    pub squash: f64,
    pub curl: f64,
    pub curl_scale: f64,
    pub size_mode: u8,
    pub flicker: f64,
    pub echoes: Option<Echoes>,
    pub halo: Option<Halo>,
    pub outline: Option<Outline>,
    /// Streams leave toward the beam's aim (fire breath).
    pub aimed: bool,
    pub rate_param: Option<RateParam>,
    /// Direction, speed and size are read at each particle's birth tick (Particles).
    pub keyed: bool,
}

impl Default for Spec {
    fn default() -> Spec {
        Spec {
            placement: Placement::Front,
            start: 0.0,
            emit_dur: 0.0,
            count: 0.0,
            rate: 0.0,
            life_min: 10.0,
            life_max: 10.0,
            speed_min: 1.0,
            speed_max: 1.0,
            angle: 0.0,
            spread: 0.0,
            gravity: 0.0,
            wind: 0.0,
            drag: 0.0,
            radial: 0.0,
            turb: 0.0,
            turb_scale: 0.01,
            spin: 0.0,
            spin_jitter: 0.0,
            shape: DISC,
            blend: AUTO,
            size0: 4.0,
            size1: 4.0,
            stretch: 1.0,
            softness: 1.0,
            fade_in: 0.1,
            fade_out: 0.3,
            alpha: 1.0,
            color_mode: 0.0,
            emit_shape: POINT,
            emit_radius: 0.0,
            inherit: 0.0,
            burst_jitter: 0.0,
            size_jitter: 0.3,
            size_curve: 1.0,
            collide: 0.0,
            clip_fade_in: 0.0,
            clip_fade_out: 0.0,
            prewarm: 0.0,
            beam_w: 0.0,
            wobble: 0.0,
            grow: 1.0,
            fire_start: 0.0,
            fire_end: FAR,
            fade_frames: 1.0,
            arc_segs: 14.0,
            arc_amp: 0.0,
            beam_style: 0.0,
            colors: None,
            opacity: None,
            world: false,
            fixed: None,
            body: false,
            material: None,
            shade: 1.0,
            rotate: ROTATE_RANDOM,
            aspect: 1.0,
            frame_rate: 0.0,
            orbit: 0.0,
            squash: 1.0,
            curl: 0.0,
            curl_scale: 0.012,
            size_mode: GROW_CURVE,
            flicker: 0.0,
            echoes: None,
            halo: None,
            outline: None,
            aimed: false,
            rate_param: None,
            keyed: false,
        }
    }
}

/// A colour ramp: eight `[r, g, b, intensity]` stops and their opacities.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Ramp {
    pub colors: [[f64; 4]; COLOR_STOPS],
    pub opacity: [f64; COLOR_STOPS],
}

/// `layer(options)`: the finished specification with its colour ramp. A material
/// makes it a sprite (no style gives a material layer a shape of its own).
pub fn layer(spec: Spec, ramp: Ramp) -> Spec {
    let mut spec = Spec { colors: Some(ramp.colors), opacity: Some(ramp.opacity), ..spec };
    if spec.material.is_some() {
        spec.shape = SPRITE;
    }
    spec
}

fn mix(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

pub fn clamp(v: f64, a: f64, b: f64) -> f64 {
    if v < a {
        a
    } else if v > b {
        b
    } else {
        v
    }
}

/// `rgb(0xRRGGBB)`.
pub fn rgb(hex: u32) -> [f64; 3] {
    [(hex >> 16 & 255) as f64 / 255.0, (hex >> 8 & 255) as f64 / 255.0, (hex & 255) as f64 / 255.0]
}

/// `tone(c, t, to)`: `c` moved toward `to` by `t`.
pub fn tone(c: [f64; 3], t: f64, to: [f64; 3]) -> [f64; 3] {
    [0, 1, 2].map(|i| c[i] + (to[i] - c[i]) * t)
}

pub const WHITE: [f64; 3] = [1.0, 1.0, 1.0];
pub const BLACK: [f64; 3] = [0.0, 0.0, 0.0];

/// `paintColor(value)`: the effect colour's middle, 0–1 per channel.
pub fn paint_color(color: &Color) -> [f64; 3] {
    let (c, _) = paint::sample_color(color, 0.5);
    c.map(|v| v / 255.0)
}

/// `ramp(stops)`: eight evenly spaced stops from `[colour, intensity, opacity]` entries.
pub fn ramp(stops: &[([f64; 3], f64, f64)]) -> Ramp {
    let mut out = Ramp { colors: [[0.0; 4]; COLOR_STOPS], opacity: [0.0; COLOR_STOPS] };
    let n = stops.len();
    for i in 0..COLOR_STOPS {
        let x = i as f64 / (COLOR_STOPS - 1) as f64 * (n - 1) as f64;
        // `Math.min(stops.length - 2, Math.floor(x))`: -1 for a single stop, which then reads the stop itself.
        let j = (n as i64 - 2).min(x.floor() as i64);
        let f = if n > 1 { x - j as f64 } else { 0.0 };
        let (a, b) = if n > 1 { (stops[j as usize], stops[j as usize + 1]) } else { (stops[0], stops[0]) };
        out.colors[i] = [mix(a.0[0], b.0[0], f), mix(a.0[1], b.0[1], f), mix(a.0[2], b.0[2], f), mix(a.1, b.1, f)];
        out.opacity[i] = mix(a.2, b.2, f);
    }
    out
}

/// `stops(...)`: a ramp from `[colour, intensity]` pairs, opaque.
pub fn stops(entries: &[([f64; 3], f64)]) -> Ramp {
    let full: Vec<([f64; 3], f64, f64)> = entries.iter().map(|&(c, i)| (c, i, 1.0)).collect();
    ramp(&full)
}

/// `stops(...)` with stop opacities.
pub fn stops_with(entries: &[([f64; 3], f64, f64)]) -> Ramp {
    ramp(entries)
}

/// `paintRamp(value, intensity)`: the effect colour sampled at eight stops.
pub fn paint_ramp(color: &Color, intensity: f64) -> Ramp {
    let mut out = Ramp { colors: [[0.0; 4]; COLOR_STOPS], opacity: [0.0; COLOR_STOPS] };
    for i in 0..COLOR_STOPS {
        let (c, opacity) = paint::sample_color(color, i as f64 / (COLOR_STOPS - 1) as f64);
        out.colors[i] = [c[0] / 255.0, c[1] / 255.0, c[2] / 255.0, intensity];
        out.opacity[i] = opacity;
    }
    out
}

/// `ink(c)`: a dark colour of the same hue family, for outlines.
pub fn ink(c: [f64; 3]) -> [f64; 3] {
    let m = c[0].max(c[1]).max(c[2]).max(1e-3);
    c.map(|v| clamp(v / m * 0.18, 0.0, 1.0))
}
