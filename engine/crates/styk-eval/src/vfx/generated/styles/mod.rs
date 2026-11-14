//! Looks of generated effects: each effect type and style compiles its parameters into
//! layers ([`Spec`]). One module per type (`aura`, `beam`, `explosion`, `smoke`,
//! `particles`); what they share is here and in [`super::layers`].

use std::f64::consts::PI;

use super::layers::*;
use crate::vfx::registry::{AnimateOn, GeneratorBlend};

mod aura;
mod beam;
mod explosion;
mod particles;
mod smoke;

use aura::aura;
use beam::beam;
use explosion::explosion;
use particles::particles;
use smoke::smoke;
use crate::vfx::{paint, Params};

pub(super) const TAU: f64 = PI * 2.0;
pub(super) const UP: f64 = -PI / 2.0;

/// What a style compiles against (`ctx`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Context {
    /// The effect's start (the clip's start plus its delay).
    pub start: f64,
    /// The clip's end, or [`FAR`].
    pub end: f64,
    /// Ticks the effect emits for, or [`FAR`].
    pub window: f64,
    pub timed: bool,
    /// The clip's fade-out (0 when it has none).
    pub fade_out: f64,
    pub scene: bool,
    pub start_point: [f64; 2],
    /// Continuous layers start already running, as if they had emitted for a lifetime.
    pub prefill: bool,
}

/// Glow layers: Auto adds light on dark scenes and paints solid colour on light ones.
pub(super) fn glow_blend(blend: GeneratorBlend) -> u8 {
    match blend {
        GeneratorBlend::Glow => ADD,
        GeneratorBlend::Solid => NORMAL,
        GeneratorBlend::Auto => AUTO,
    }
}

/// Figures are authored at many scales; auras follow the target's size (`Anchor::measure`,
/// which its pose does not change): the scale of a layer with `body_scaled` at a birth.
pub fn body_scale(measure: f64) -> f64 {
    let m = if measure > 0.0 && measure.is_finite() { measure } else { 200.0 };
    clamp(m / 200.0, 0.25, 4.0)
}

pub(super) const ROCK_COLOR: [f64; 3] = [0.42, 0.38, 0.36];
pub(super) fn smoke_colors() -> [[f64; 3]; 3] {
    [rgb(0x4a3b35), rgb(0x3a3436), rgb(0x2e2c31)]
}

/// A deeper tone of `c` for the edges and undersides of light colours, so they read on a light
/// page: more saturated and darker (`value`, the brightest channel), its hue turned a little toward
/// whichever neighbour is darker (cyan toward blue, gold toward orange).
pub(super) fn deeper(c: [f64; 3], value: f64) -> [f64; 3] {
    // A twentieth of a turn either way about the grey axis.
    let (cs, sn) = (0.951_056_516_295_153_6, 0.309_016_994_374_947_4);
    let turn = |sn: f64| {
        let k = (1.0 - cs) / 3.0;
        let r = 0.577_350_269_189_625_8 * sn;
        let m = [[cs + k, k - r, k + r], [k + r, cs + k, k - r], [k - r, k + r, cs + k]];
        [0, 1, 2].map(|i| clamp(m[i][0] * c[0] + m[i][1] * c[1] + m[i][2] * c[2], 0.0, 1.0))
    };
    let luma = |c: [f64; 3]| 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    let (a, b) = (turn(sn), turn(-sn));
    let h = if luma(a) <= luma(b) { a } else { b };
    let (hi, lo) = (h[0].max(h[1]).max(h[2]), h[0].min(h[1]).min(h[2]));
    if hi - lo < 1e-3 {
        return c.map(|v| v * value);
    }
    // Saturated: pushed away from its least channel, brightest channel at `value`.
    let floor = lo * 0.85;
    h.map(|v| clamp((v - floor) / (hi - floor), 0.0, 1.0) * value)
}

pub(super) fn m(name: &str) -> Option<Material> {
    Some(material(name))
}

/// The effect colour's own ramp when it is a gradient (its stops and their opacities);
/// otherwise the style's ramp derived from its colour.
pub(super) fn paint_or(color: &crate::vfx::Color, derived: Ramp) -> Ramp {
    if paint::is_gradient(color) { paint_ramp(color, 1.0) } else { derived }
}

pub(super) fn behind(on: bool) -> Placement {
    if on {
        Placement::Behind
    } else {
        Placement::Front
    }
}

/// `compileEffect`: the effect's layers, without those that emit nothing.
pub fn compile(params: &Params, ctx: &Context) -> Vec<Spec> {
    let layers = match params {
        Params::Aura(p) => aura(p, ctx),
        Params::Beam(p) => beam(p, ctx),
        Params::Explosion(p) => explosion(p, ctx),
        Params::Particles(p) => particles(p, ctx),
        Params::Smoke(p) => smoke(p, ctx),
        _ => Vec::new(),
    };
    // A beam that charges plays its charge from nothing; one that starts firing starts running.
    let prefill = match params {
        Params::Beam(p) => ctx.prefill && beam::fires_at_once(p, ctx),
        _ => ctx.prefill,
    };
    layers
        .into_iter()
        .filter(|l| l.shape == BEAM || l.shape == ARC || l.count > 0.0 || l.rate > 0.0 || l.rate_param.is_some())
        .map(|mut l| {
            // Started already running: continuous layers emitted for a lifetime before the
            // effect's start, so nothing fades in from empty. Layers that begin later (a beam's
            // sparks once it fires, an impact) are events of the effect and wait for their moment.
            if prefill && l.emit_dur > 0.0 && !l.is_beam() && l.start <= ctx.start {
                l.prewarm = 1.0;
                l.clip_fade_in = 0.0;
            }
            l
        })
        .collect()
}

/// The step an effect animates on (`p.step + 1`).
pub fn step(params: &Params) -> f64 {
    let on = match params {
        Params::Particles(p) => p.step,
        Params::Aura(p) => p.step,
        Params::Beam(p) => p.step,
        Params::Smoke(p) => p.step,
        Params::Explosion(p) => p.step,
        _ => AnimateOn::Ones,
    };
    on.index() as f64 + 1.0
}

