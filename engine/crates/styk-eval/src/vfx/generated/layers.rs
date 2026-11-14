//! The vocabulary of generated-effect layers: what effect styles compile into
//! ([`super::styles`]) and the batch packs ([`super::batch`]). A layer is one
//! emitter: when and how many particles are born, where, how they move, and how
//! each is drawn over its life. Sizes and speeds are stage pixels and pixels per
//! frame (of the effect's own time); lives are frames.

use super::super::paint;
use super::super::Color;

/// Particle shapes (`Spec::shape`).
pub const DISC: u8 = 0;
pub const STREAK: u8 = 1;
pub const RING: u8 = 2;
pub const CHUNK: u8 = 3;
/// A beam layer: one beam from the target to the aim.
pub const BEAM: u8 = 4;
/// Lightning arcs along a beam.
pub const ARC: u8 = 5;
pub const SPRITE: u8 = 6;
pub const SQUARE: u8 = 7;

/// Emitters (`Spec::emit_shape`).
pub const POINT: u8 = 0;
pub const BODY: u8 = 1;
pub const BEAM_LINE: u8 = 2;
pub const EMIT_RING: u8 = 3;
pub const BEAM_TIP: u8 = 4;
pub const GROUND: u8 = 5;
pub const LINE: u8 = 6;
pub const STAGE: u8 = 7;

/// Blending (`Spec::blend`): `AUTO` is the style's own mix of paint and light.
pub const NORMAL: u8 = 0;
pub const ADD: u8 = 1;
pub const AUTO: u8 = 2;

/// Sprite orientation (`Spec::rotate`): random with spin, along the motion, upright with a slight tilt, fixed.
pub const ROTATE_RANDOM: u8 = 0;
pub const ROTATE_MOTION: u8 = 1;
pub const ROTATE_UPRIGHT: u8 = 2;
pub const ROTATE_FIXED: u8 = 3;

/// Size over life (`Spec::size_mode`): eased curve, fast puff, pop in and shrink away, flicker.
pub const GROW_CURVE: u8 = 0;
pub const GROW_PUFF: u8 = 1;
pub const GROW_POP: u8 = 2;
pub const GROW_FLICKER: u8 = 3;

pub const COLOR_STOPS: usize = 8;
/// "Forever" for untimed clips.
pub const FAR: f64 = 1e7;

/// Cells of the material atlas a material's particles choose from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Material {
    pub row: u32,
    pub col: u32,
    pub count: u32,
}

/// Material rows of the procedural atlas, in atlas order.
pub const ROWS: [&str; 17] = ["smoke", "cloud", "flame", "toonFlame", "star", "bokeh", "wisp", "bolt", "shard", "rock", "leaf", "petal", "flake", "drop", "splat", "burst", "cute"];

/// Every row but `cute` is one material of eight variants; `cute` holds hearts (four) and cartoon stars (four).
pub fn material(name: &str) -> Material {
    match name {
        "heart" => Material { row: 16, col: 0, count: 4 },
        "toonStar" => Material { row: 16, col: 4, count: 4 },
        _ => Material { row: ROWS.iter().position(|row| *row == name && *row != "cute").unwrap_or_else(|| panic!("unknown particle material {name}")) as u32, col: 0, count: 8 },
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Placement {
    Front,
    Behind,
}

/// A trail behind each particle: where it was over the last `length` frames.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Echoes {
    pub count: u32,
    pub lag: f64,
    pub alpha: f64,
    pub size: f64,
}

/// A larger soft disc of light under each particle.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Halo {
    pub scale: f64,
    pub alpha: f64,
}

/// An ink line around each particle.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Outline {
    pub width: f64,
    pub color: [f64; 3],
}

/// The parameter a layer's emission follows when keyed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
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

/// One layer specification. Every field has a default ([`Spec::default`]); a
/// material makes the layer a textured sprite.
#[derive(Clone, Debug, PartialEq)]
pub struct Spec {
    pub placement: Placement,
    /// When the layer starts emitting, in the effect's time.
    pub start: f64,
    /// How long it emits; 0 is a burst of `count` at `start`.
    pub emit_dur: f64,
    pub count: f64,
    /// Particles a frame.
    pub rate: f64,
    pub life_min: f64,
    pub life_max: f64,
    pub speed_min: f64,
    pub speed_max: f64,
    /// Launch direction (radians, 0 = right, y down) and the spread around it.
    pub angle: f64,
    pub spread: f64,
    /// Constant acceleration, down and right (pixels a frame²).
    pub gravity: f64,
    pub wind: f64,
    /// Drag: velocity falls as `e^(-drag·age)`.
    pub drag: f64,
    /// Bends the launch away from (+) or toward (−) the emitter's centre.
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
    /// 0: colour over life; 1: a random place on the ramp per particle.
    pub color_mode: f64,
    pub emit_shape: u8,
    pub emit_radius: f64,
    /// Share of the emitter's velocity a particle starts with.
    pub inherit: f64,
    pub burst_jitter: f64,
    pub size_jitter: f64,
    /// The exponent of [`GROW_CURVE`].
    pub size_curve: f64,
    /// Lands on the ground (1) or passes through it (0).
    pub collide: f64,
    /// On landing: the share of the fall speed it bounces back with, and how fast its slide
    /// stops (per frame: its speed falls as `e^(-friction·t)`).
    pub bounce: f64,
    pub friction: f64,
    pub clip_fade_in: f64,
    pub clip_fade_out: f64,
    /// Starts already running: as if it had emitted for a lifetime before its start.
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
    /// Particles keep the place their target had when they were born.
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
    /// Direction, speed and size are read at each particle's birth (Particles).
    pub keyed: bool,
    /// Sizes, speeds, distances and forces are in units of the target's size, read at each
    /// particle's birth (auras): multiplied by the birth's body scale.
    pub body_scaled: bool,
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
            bounce: 0.0,
            friction: 0.15,
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
            body_scaled: false,
        }
    }
}

impl Spec {
    /// A beam or its arcs, rather than particles.
    pub fn is_beam(&self) -> bool {
        self.shape == BEAM || self.shape == ARC
    }

    /// How long a trail reaches back (frames).
    pub fn trail_span(&self) -> f64 {
        self.echoes.map_or(0.0, |e| e.count as f64 * e.lag)
    }
}

/// A colour ramp: eight `[r, g, b, intensity]` stops and their opacities.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Ramp {
    pub colors: [[f64; 4]; COLOR_STOPS],
    pub opacity: [f64; COLOR_STOPS],
}

/// The finished specification with its colour ramp. A material makes it a sprite.
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

/// `0xRRGGBB` as 0–1 channels.
pub fn rgb(hex: u32) -> [f64; 3] {
    [(hex >> 16 & 255) as f64 / 255.0, (hex >> 8 & 255) as f64 / 255.0, (hex & 255) as f64 / 255.0]
}

/// `c` moved toward `to` by `t`.
pub fn tone(c: [f64; 3], t: f64, to: [f64; 3]) -> [f64; 3] {
    [0, 1, 2].map(|i| c[i] + (to[i] - c[i]) * t)
}

pub const WHITE: [f64; 3] = [1.0, 1.0, 1.0];
pub const BLACK: [f64; 3] = [0.0, 0.0, 0.0];

/// The effect colour's middle, 0–1 per channel.
pub fn paint_color(color: &Color) -> [f64; 3] {
    let (c, _) = paint::sample_color(color, 0.5);
    c.map(|v| v / 255.0)
}

/// Eight evenly spaced stops from `[colour, intensity, opacity]` entries.
pub fn ramp(stops: &[([f64; 3], f64, f64)]) -> Ramp {
    let mut out = Ramp { colors: [[0.0; 4]; COLOR_STOPS], opacity: [0.0; COLOR_STOPS] };
    let n = stops.len();
    for i in 0..COLOR_STOPS {
        let x = i as f64 / (COLOR_STOPS - 1) as f64 * (n - 1) as f64;
        let j = (n as i64 - 2).min(x.floor() as i64);
        let f = if n > 1 { x - j as f64 } else { 0.0 };
        let (a, b) = if n > 1 { (stops[j as usize], stops[j as usize + 1]) } else { (stops[0], stops[0]) };
        out.colors[i] = [mix(a.0[0], b.0[0], f), mix(a.0[1], b.0[1], f), mix(a.0[2], b.0[2], f), mix(a.1, b.1, f)];
        out.opacity[i] = mix(a.2, b.2, f);
    }
    out
}

/// A ramp from `[colour, intensity]` pairs, opaque.
pub fn stops(entries: &[([f64; 3], f64)]) -> Ramp {
    let mut full = [([0.0; 3], 0.0, 1.0); COLOR_STOPS];
    let n = entries.len().min(COLOR_STOPS);
    for (slot, &(c, i)) in full.iter_mut().zip(entries) {
        *slot = (c, i, 1.0);
    }
    ramp(&full[..n])
}

/// [`stops`] with stop opacities.
pub fn stops_with(entries: &[([f64; 3], f64, f64)]) -> Ramp {
    ramp(entries)
}

/// The effect colour sampled at eight stops.
pub fn paint_ramp(color: &Color, intensity: f64) -> Ramp {
    let mut out = Ramp { colors: [[0.0; 4]; COLOR_STOPS], opacity: [0.0; COLOR_STOPS] };
    for i in 0..COLOR_STOPS {
        let (c, opacity) = paint::sample_color(color, i as f64 / (COLOR_STOPS - 1) as f64);
        out.colors[i] = [c[0] / 255.0, c[1] / 255.0, c[2] / 255.0, intensity];
        out.opacity[i] = opacity;
    }
    out
}

/// A dark colour of the same hue family, for outlines.
pub fn ink(c: [f64; 3]) -> [f64; 3] {
    let m = c[0].max(c[1]).max(c[2]).max(1e-3);
    c.map(|v| clamp(v / m * 0.18, 0.0, 1.0))
}
