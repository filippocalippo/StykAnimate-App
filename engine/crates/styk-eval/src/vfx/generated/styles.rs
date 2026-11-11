//! Looks of generated effects: each effect type
//! and style compiles its parameters into layer specifications. Operation for
//! operation as the editor, so the records the batch packs are the same bits.

use std::f64::consts::PI;

use super::layers::*;
use crate::vfx::registry::{AnimateOn, Aura, Beam, DrawLayer, Emission, EmitShape, Explosion, GeneratorBlend, Particles, Smoke};
use crate::vfx::{paint, Params};

const TAU: f64 = PI * 2.0;
const UP: f64 = -PI / 2.0;

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
    /// The target's height in 4-pixel steps; `None` for the scene.
    pub body_height: Option<f64>,
    pub start_point: [f64; 2],
}

/// Glow layers: Auto adds light on dark scenes and paints solid colour on light ones.
fn glow_blend(blend: GeneratorBlend) -> u8 {
    match blend {
        GeneratorBlend::Glow => ADD,
        GeneratorBlend::Solid => NORMAL,
        GeneratorBlend::Auto => AUTO,
    }
}

/// Figures are authored at many scales; auras follow the target's height.
fn body_scale(height: Option<f64>) -> f64 {
    // `(height || 200) / 200`: no height, or none at all, counts as 200.
    let h = match height {
        Some(h) if h != 0.0 && !h.is_nan() => h,
        _ => 200.0,
    };
    clamp(h / 200.0, 0.25, 4.0)
}

const DUST: [f64; 3] = [0.54, 0.58, 0.65];
const ROCK: [f64; 3] = [0.42, 0.38, 0.36];
fn smoke_colors() -> [[f64; 3]; 3] {
    [rgb(0x4a3b35), rgb(0x3a3436), rgb(0x2e2c31)]
}

fn m(name: &str) -> Option<Material> {
    Some(material(name))
}

fn behind(on: bool) -> Placement {
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
    layers.into_iter().filter(|l| l.shape == BEAM || l.shape == ARC || l.count > 0.0 || l.rate > 0.0 || l.rate_param.is_some()).collect()
}

// ---------------------------------------------------------------------------
// Auras. Each style supplies a ground effect, body glow, main layers and
// particles; the effect's toggles choose which of them draw.
// ---------------------------------------------------------------------------

struct AuraParts {
    ground: Vec<Spec>,
    glow: Spec,
    main: Vec<Spec>,
    particles: Spec,
}

struct AuraInput {
    col: [f64; 3],
    i: f64,
    s: f64,
    t: f64,
    sc: f64,
    base: Spec,
}

fn aura_fire(a: &AuraInput) -> AuraParts {
    let AuraInput { col, i, s, t, sc, ref base } = *a;
    let hot = tone(col, 0.6, WHITE);
    let deep = tone(col, 0.55, BLACK);
    let dust = tone(DUST, 0.25, col);
    AuraParts {
        ground: vec![layer(
            Spec { placement: Placement::Behind, rate: 2.2, life_min: 26.0, life_max: 44.0, emit_shape: GROUND, emit_radius: 44.0 * sc, speed_min: 1.2 * sc, speed_max: 3.2 * s * sc, drag: 0.06, gravity: -0.01 * sc, collide: 1.0, material: m("smoke"), rotate: ROTATE_UPRIGHT, size_mode: GROW_PUFF, size0: 8.0 * sc, size1: 30.0 * s * sc, alpha: 0.3, blend: NORMAL, fade_in: 0.15, fade_out: 0.6, curl: 8.0 * t * sc, curl_scale: 0.02 / sc, ..base.clone() },
            stops(&[(tone(dust, 0.2, col), 1.0), (dust, 1.0)]),
        )],
        glow: layer(
            Spec { placement: Placement::Behind, rate: 5.0, life_min: 10.0, life_max: 16.0, emit_shape: BODY, emit_radius: 8.0 * sc, speed_min: 0.2 * sc, speed_max: 0.7 * sc, angle: UP, spread: 1.0, gravity: -0.02 * sc, size0: 26.0 * s * sc, size1: 38.0 * s * sc, softness: 2.2, alpha: 0.22, fade_in: 0.3, fade_out: 0.5, ..base.clone() },
            stops(&[(col, 1.3 * i), (col, 1.0 * i), (col, 0.5 * i)]),
        ),
        main: vec![
            layer(
                Spec { placement: Placement::Behind, rate: 24.0, life_min: 14.0, life_max: 24.0, emit_shape: BODY, emit_radius: 6.0 * sc, speed_min: 1.2 * s * sc, speed_max: 3.0 * s * sc, angle: UP, spread: 0.55, gravity: -0.1 * s * sc, drag: 0.05, curl: 12.0 * t * sc, curl_scale: 0.016 / sc, material: m("flame"), rotate: ROTATE_MOTION, frame_rate: 3.0, aspect: 1.35, size0: 13.0 * (0.7 + 0.3 * s) * sc, size1: 4.0 * sc, size_curve: 0.8, alpha: 0.7, inherit: 0.6, fade_in: 0.12, fade_out: 0.5, ..base.clone() },
                stops(&[(hot, 2.0 * i), (col, 1.6 * i), (col, 1.0 * i), (deep, 0.6 * i)]),
            ),
            layer(
                Spec { placement: Placement::Front, rate: 6.0, life_min: 8.0, life_max: 14.0, emit_shape: BODY, emit_radius: 4.0 * sc, speed_min: 1.0 * s * sc, speed_max: 2.4 * s * sc, angle: UP, spread: 0.5, gravity: -0.08 * s * sc, drag: 0.05, curl: 8.0 * t * sc, curl_scale: 0.02 / sc, material: m("flame"), rotate: ROTATE_MOTION, frame_rate: 2.0, aspect: 1.3, size0: 8.0 * sc, size1: 2.5 * sc, alpha: 0.4, inherit: 0.6, fade_in: 0.15, fade_out: 0.5, ..base.clone() },
                stops(&[(hot, 2.2 * i), (col, 1.4 * i), (deep, 0.5 * i)]),
            ),
        ],
        particles: layer(
            Spec { rate: 3.0, life_min: 25.0, life_max: 45.0, emit_shape: BODY, emit_radius: 22.0 * sc, speed_min: 1.0 * sc, speed_max: 2.6 * s * sc, angle: UP, spread: 1.2, gravity: -0.035 * sc, drag: 0.02, curl: 18.0 * t * sc, curl_scale: 0.02 / sc, size0: 2.4 * sc, size1: 0.8 * sc, softness: 0.35, size_jitter: 0.5, flicker: 0.5, ..base.clone() },
            stops(&[(WHITE, 3.5 * i), (tone(col, 0.4, WHITE), 3.0 * i), (col, 2.2 * i), (col, 1.0 * i)]),
        ),
    }
}

fn aura_electric(a: &AuraInput) -> AuraParts {
    let AuraInput { col, i, s, t, sc, ref base } = *a;
    let hot = tone(col, 0.55, WHITE);
    AuraParts {
        ground: vec![layer(
            Spec { rate: 2.5, life_min: 3.0, life_max: 6.0, emit_shape: GROUND, emit_radius: 40.0 * sc, speed_min: 0.0, speed_max: 0.0, material: m("bolt"), rotate: ROTATE_FIXED, frame_rate: 1.0, aspect: 0.7, size0: 16.0 * sc, size1: 16.0 * sc, flicker: 0.6, fade_in: 0.0, fade_out: 0.3, ..base.clone() },
            stops(&[(WHITE, 2.4 * i), (hot, 2.0 * i), (col, 1.4 * i)]),
        )],
        glow: layer(
            Spec { placement: Placement::Behind, rate: 5.0, life_min: 8.0, life_max: 14.0, emit_shape: BODY, emit_radius: 8.0 * sc, speed_min: 0.2 * sc, speed_max: 0.6 * sc, spread: TAU, size0: 24.0 * s * sc, size1: 34.0 * s * sc, softness: 2.4, alpha: 0.2, flicker: 0.35, fade_in: 0.2, fade_out: 0.5, ..base.clone() },
            stops(&[(col, 1.4 * i), (col, 1.0 * i), (col, 0.5 * i)]),
        ),
        main: vec![
            layer(
                Spec { placement: Placement::Behind, rate: 9.0, life_min: 3.0, life_max: 6.0, emit_shape: BODY, emit_radius: 10.0 * sc, speed_min: 0.0, speed_max: 0.4 * sc, spread: TAU, curl: 4.0 * t * sc, material: m("bolt"), frame_rate: 1.0, size0: 20.0 * s * sc, size1: 16.0 * s * sc, size_jitter: 0.45, flicker: 0.55, fade_in: 0.0, fade_out: 0.35, ..base.clone() },
                stops(&[(WHITE, 2.6 * i), (hot, 2.2 * i), (col, 1.6 * i), (col, 1.0 * i)]),
            ),
            layer(
                Spec { rate: 4.0, life_min: 2.0, life_max: 4.0, emit_shape: BODY, emit_radius: 6.0 * sc, speed_min: 0.0, speed_max: 0.3 * sc, spread: TAU, material: m("bolt"), frame_rate: 1.0, size0: 13.0 * s * sc, size1: 11.0 * s * sc, size_jitter: 0.4, flicker: 0.6, fade_in: 0.0, fade_out: 0.3, ..base.clone() },
                stops(&[(WHITE, 2.8 * i), (hot, 2.2 * i), (col, 1.6 * i)]),
            ),
        ],
        particles: layer(
            Spec { rate: 5.0, life_min: 5.0, life_max: 11.0, emit_shape: BODY, emit_radius: 12.0 * sc, speed_min: 3.0 * sc, speed_max: 8.0 * sc, spread: TAU, gravity: 0.18 * sc, drag: 0.05, shape: STREAK, stretch: 1.1, size0: 1.6 * sc, size1: 0.6 * sc, softness: 0.7, fade_out: 0.5, ..base.clone() },
            stops(&[(WHITE, 2.6 * i), (hot, 2.0 * i), (col, 1.4 * i)]),
        ),
    }
}

fn aura_shadow(a: &AuraInput) -> AuraParts {
    let AuraInput { col, i, s, t, sc, ref base } = *a;
    let dark = tone(col, 0.85, BLACK);
    let abyss = tone(col, 0.94, BLACK);
    let rim = tone(col, 0.25, WHITE);
    AuraParts {
        ground: vec![layer(
            Spec { placement: Placement::Behind, rate: 2.4, life_min: 30.0, life_max: 52.0, emit_shape: GROUND, emit_radius: 46.0 * sc, speed_min: 0.6 * sc, speed_max: 2.0 * sc, drag: 0.05, gravity: -0.004 * sc, collide: 1.0, material: m("smoke"), rotate: ROTATE_UPRIGHT, size_mode: GROW_PUFF, size0: 10.0 * sc, size1: 34.0 * s * sc, alpha: 0.55, blend: NORMAL, shade: 0.6, fade_in: 0.2, fade_out: 0.55, curl: 10.0 * t * sc, curl_scale: 0.02 / sc, ..base.clone() },
            stops(&[(dark, 1.0), (abyss, 1.0)]),
        )],
        glow: layer(
            Spec { placement: Placement::Behind, rate: 4.0, life_min: 10.0, life_max: 18.0, emit_shape: BODY, emit_radius: 8.0 * sc, speed_min: 0.2 * sc, speed_max: 0.6 * sc, angle: UP, spread: 1.0, gravity: -0.02 * sc, size0: 26.0 * s * sc, size1: 38.0 * s * sc, softness: 2.0, alpha: 0.3, fade_in: 0.3, fade_out: 0.5, ..base.clone() },
            stops(&[(col, 1.2 * i), (col, 0.8 * i), (col, 0.4 * i)]),
        ),
        main: vec![
            layer(
                Spec { placement: Placement::Behind, rate: 10.0, life_min: 22.0, life_max: 38.0, emit_shape: BODY, emit_radius: 6.0 * sc, speed_min: 0.6 * s * sc, speed_max: 1.8 * s * sc, angle: UP, spread: 0.9, gravity: -0.05 * s * sc, drag: 0.04, curl: 16.0 * t * sc, curl_scale: 0.018 / sc, material: m("smoke"), rotate: ROTATE_UPRIGHT, size_mode: GROW_PUFF, size0: 7.0 * sc, size1: 24.0 * s * sc, alpha: 0.62, blend: NORMAL, shade: 0.7, inherit: 0.5, fade_in: 0.15, fade_out: 0.55, ..base.clone() },
                stops_with(&[(abyss, 1.0, 1.0), (dark, 1.0, 1.0), (tone(col, 0.7, BLACK), 1.0, 0.8)]),
            ),
            layer(
                Spec { placement: Placement::Behind, rate: 6.0, life_min: 14.0, life_max: 24.0, emit_shape: BODY, emit_radius: 4.0 * sc, speed_min: 0.8 * s * sc, speed_max: 2.0 * s * sc, angle: UP, spread: 0.8, gravity: -0.05 * s * sc, drag: 0.04, curl: 12.0 * t * sc, curl_scale: 0.02 / sc, material: m("wisp"), rotate: ROTATE_MOTION, aspect: 0.8, size0: 12.0 * sc, size1: 18.0 * s * sc, alpha: 0.5, inherit: 0.5, fade_in: 0.2, fade_out: 0.5, ..base.clone() },
                stops(&[(rim, 1.4 * i), (col, 1.2 * i), (col, 0.6 * i)]),
            ),
        ],
        particles: layer(
            Spec { rate: 3.0, life_min: 26.0, life_max: 44.0, emit_shape: BODY, emit_radius: 18.0 * sc, speed_min: 0.6 * sc, speed_max: 1.6 * sc, angle: UP, spread: 1.4, gravity: -0.02 * sc, curl: 14.0 * t * sc, curl_scale: 0.02 / sc, size0: 2.2 * sc, size1: 1.0 * sc, softness: 0.4, flicker: 0.45, ..base.clone() },
            stops(&[(rim, 2.2 * i), (col, 1.8 * i), (col, 1.0 * i)]),
        ),
    }
}

fn aura_holy(a: &AuraInput) -> AuraParts {
    let AuraInput { col, i, s, t, sc, ref base } = *a;
    let soft = tone(col, 0.55, WHITE);
    AuraParts {
        ground: vec![layer(
            Spec { placement: Placement::Behind, rate: 0.6, life_min: 18.0, life_max: 24.0, emit_shape: GROUND, emit_radius: 0.0, speed_min: 0.0, speed_max: 0.0, aspect: 0.22, softness: 1.4, size0: 56.0 * sc, size1: 70.0 * sc, size_jitter: 0.1, alpha: 0.45, fade_in: 0.35, fade_out: 0.45, ..base.clone() },
            stops(&[(soft, 1.4 * i), (col, 1.0 * i)]),
        )],
        glow: layer(
            Spec { placement: Placement::Behind, rate: 4.0, life_min: 12.0, life_max: 20.0, emit_shape: BODY, emit_radius: 10.0 * sc, speed_min: 0.1 * sc, speed_max: 0.4 * sc, angle: UP, spread: 1.0, gravity: -0.01 * sc, size0: 32.0 * s * sc, size1: 44.0 * s * sc, softness: 2.6, alpha: 0.26, fade_in: 0.3, fade_out: 0.5, ..base.clone() },
            stops(&[(soft, 1.3 * i), (col, 1.0 * i), (col, 0.5 * i)]),
        ),
        main: vec![
            layer(
                Spec { placement: Placement::Behind, rate: 8.0, life_min: 18.0, life_max: 30.0, emit_shape: BODY, emit_radius: 14.0 * sc, speed_min: 1.2 * s * sc, speed_max: 2.4 * s * sc, angle: UP, spread: 0.08, shape: STREAK, stretch: 6.0, size0: 2.2 * sc, size1: 1.0 * sc, softness: 1.2, alpha: 0.55, inherit: 0.4, fade_in: 0.3, fade_out: 0.5, ..base.clone() },
                stops(&[(WHITE, 1.6 * i), (soft, 1.4 * i), (col, 1.0 * i)]),
            ),
            layer(
                Spec { rate: 1.2, life_min: 14.0, life_max: 22.0, emit_shape: BODY, emit_radius: 16.0 * sc, speed_min: 0.2 * sc, speed_max: 0.6 * sc, angle: UP, spread: 1.0, gravity: -0.02 * sc, material: m("star"), size_mode: GROW_POP, spin: 0.04, spin_jitter: 1.0, size0: 5.0 * sc, size1: 9.0 * sc, alpha: 0.9, fade_in: 0.1, fade_out: 0.4, ..base.clone() },
                stops(&[(WHITE, 2.0 * i), (soft, 1.6 * i)]),
            ),
        ],
        particles: layer(
            Spec { rate: 3.0, life_min: 30.0, life_max: 50.0, emit_shape: BODY, emit_radius: 24.0 * sc, speed_min: 0.4 * sc, speed_max: 1.2 * sc, angle: UP, spread: 1.2, gravity: -0.015 * sc, curl: 10.0 * t * sc, curl_scale: 0.02 / sc, material: m("bokeh"), rotate: ROTATE_FIXED, size0: 3.6 * sc, size1: 1.8 * sc, size_jitter: 0.5, flicker: 0.4, alpha: 0.8, ..base.clone() },
            stops(&[(WHITE, 1.8 * i), (soft, 1.4 * i), (col, 1.0 * i)]),
        ),
    }
}

fn aura_ice(a: &AuraInput) -> AuraParts {
    let AuraInput { col, i, s, t, sc, ref base } = *a;
    let frost = tone(col, 0.6, WHITE);
    let deep = tone(col, 0.35, BLACK);
    AuraParts {
        ground: vec![layer(
            Spec { rate: 1.6, life_min: 16.0, life_max: 26.0, emit_shape: GROUND, emit_radius: 40.0 * sc, speed_min: 0.0, speed_max: 0.0, material: m("shard"), rotate: ROTATE_UPRIGHT, aspect: 1.7, size_mode: GROW_POP, size0: 3.0 * sc, size1: 12.0 * s * sc, size_jitter: 0.5, blend: NORMAL, fade_in: 0.0, fade_out: 0.2, outline: Some(Outline { width: 1.2 * sc, color: ink(deep) }), ..base.clone() },
            stops(&[(frost, 1.0), (col, 1.0)]),
        )],
        glow: layer(
            Spec { placement: Placement::Behind, rate: 4.0, life_min: 12.0, life_max: 20.0, emit_shape: BODY, emit_radius: 8.0 * sc, speed_min: 0.1 * sc, speed_max: 0.5 * sc, spread: TAU, size0: 26.0 * s * sc, size1: 36.0 * s * sc, softness: 2.4, alpha: 0.2, fade_in: 0.3, fade_out: 0.5, ..base.clone() },
            stops(&[(frost, 1.2 * i), (col, 0.9 * i), (col, 0.4 * i)]),
        ),
        main: vec![
            layer(
                Spec { placement: Placement::Behind, rate: 7.0, life_min: 26.0, life_max: 44.0, emit_shape: BODY, emit_radius: 10.0 * sc, speed_min: 0.3 * sc, speed_max: 1.0 * sc, angle: PI / 2.0, spread: 2.6, gravity: 0.012 * sc, drag: 0.05, curl: 12.0 * t * sc, curl_scale: 0.018 / sc, material: m("smoke"), rotate: ROTATE_UPRIGHT, size_mode: GROW_PUFF, size0: 8.0 * sc, size1: 26.0 * s * sc, alpha: 0.2, shade: 0.6, fade_in: 0.2, fade_out: 0.55, ..base.clone() },
                stops_with(&[(frost, 1.0 * i, 1.0), (col, 0.8 * i, 0.6)]),
            ),
            layer(
                Spec { rate: 1.4, life_min: 12.0, life_max: 20.0, emit_shape: BODY, emit_radius: 14.0 * sc, speed_min: 0.1 * sc, speed_max: 0.4 * sc, spread: TAU, material: m("star"), size_mode: GROW_POP, spin: 0.03, spin_jitter: 1.0, size0: 4.0 * sc, size1: 7.0 * sc, fade_in: 0.1, fade_out: 0.4, ..base.clone() },
                stops(&[(WHITE, 2.0 * i), (frost, 1.6 * i)]),
            ),
        ],
        particles: layer(
            Spec { rate: 2.4, life_min: 30.0, life_max: 52.0, emit_shape: BODY, emit_radius: 24.0 * sc, speed_min: 0.3 * sc, speed_max: 1.0 * sc, angle: UP, spread: 2.0, gravity: -0.01 * sc, curl: 14.0 * t * sc, curl_scale: 0.02 / sc, material: m("flake"), spin: 0.05, spin_jitter: 1.0, size0: 4.5 * sc, size1: 3.0 * sc, size_jitter: 0.4, alpha: 0.9, fade_in: 0.15, fade_out: 0.35, ..base.clone() },
            stops(&[(WHITE, 1.4 * i), (frost, 1.2 * i)]),
        ),
    }
}

fn aura_wind(a: &AuraInput) -> AuraParts {
    let AuraInput { col, i, s, t, sc, ref base } = *a;
    let pale = tone(col, 0.5, WHITE);
    let dust = tone([0.62, 0.6, 0.55], 0.3, col);
    let swirl = 0.1 + 0.06 * t;
    AuraParts {
        ground: vec![layer(
            Spec { placement: Placement::Behind, rate: 3.0, life_min: 18.0, life_max: 30.0, emit_shape: GROUND, emit_radius: 30.0 * sc, speed_min: 2.0 * sc, speed_max: 5.0 * sc, drag: 0.07, gravity: -0.01 * sc, collide: 1.0, material: m("smoke"), rotate: ROTATE_UPRIGHT, size_mode: GROW_PUFF, size0: 6.0 * sc, size1: 20.0 * sc, alpha: 0.3, blend: NORMAL, fade_in: 0.1, fade_out: 0.6, curl: 10.0 * t * sc, curl_scale: 0.02 / sc, ..base.clone() },
            stops(&[(dust, 1.0)]),
        )],
        glow: layer(
            Spec { placement: Placement::Behind, rate: 3.0, life_min: 12.0, life_max: 20.0, emit_shape: BODY, emit_radius: 10.0 * sc, speed_min: 0.1 * sc, speed_max: 0.4 * sc, spread: TAU, size0: 22.0 * s * sc, size1: 30.0 * s * sc, softness: 2.6, alpha: 0.14, fade_in: 0.3, fade_out: 0.5, ..base.clone() },
            stops(&[(pale, 1.0 * i), (col, 0.7 * i)]),
        ),
        main: vec![
            layer(
                Spec { rate: 6.0, life_min: 16.0, life_max: 26.0, emit_shape: BODY, emit_radius: 26.0 * s * sc, speed_min: 0.2 * sc, speed_max: 0.6 * sc, angle: UP, spread: 0.6, gravity: -0.03 * s * sc, orbit: swirl, squash: 0.32, material: m("wisp"), rotate: ROTATE_MOTION, aspect: 0.7, size0: 16.0 * s * sc, size1: 24.0 * s * sc, alpha: 0.6, shade: 0.6, fade_in: 0.25, fade_out: 0.45, ..base.clone() },
                stops(&[(WHITE, 1.2 * i), (pale, 1.1 * i), (col, 0.9 * i)]),
            ),
            layer(
                Spec { placement: Placement::Behind, rate: 4.0, life_min: 16.0, life_max: 26.0, emit_shape: BODY, emit_radius: 22.0 * s * sc, speed_min: 0.2 * sc, speed_max: 0.6 * sc, angle: UP, spread: 0.6, gravity: -0.03 * s * sc, orbit: -swirl * 0.9, squash: 0.32, material: m("wisp"), rotate: ROTATE_MOTION, aspect: 0.7, size0: 14.0 * s * sc, size1: 20.0 * s * sc, alpha: 0.4, shade: 0.6, fade_in: 0.25, fade_out: 0.45, ..base.clone() },
                stops(&[(pale, 1.0 * i), (col, 0.8 * i)]),
            ),
        ],
        particles: layer(
            Spec { rate: 2.0, life_min: 24.0, life_max: 40.0, emit_shape: BODY, emit_radius: 30.0 * sc, speed_min: 0.4 * sc, speed_max: 1.2 * sc, angle: UP, spread: 0.8, gravity: -0.03 * sc, orbit: swirl * 1.2, squash: 0.35, material: m("leaf"), spin: 0.12, spin_jitter: 1.0, size0: 4.0 * sc, size1: 4.0 * sc, size_jitter: 0.4, blend: NORMAL, fade_in: 0.1, fade_out: 0.3, ..base.clone() },
            stops(&[(tone([0.45, 0.7, 0.3], 0.3, col), 1.0), (tone([0.75, 0.62, 0.25], 0.3, col), 1.0)]),
        ),
    }
}

fn aura_toon(a: &AuraInput) -> AuraParts {
    let AuraInput { col, i, s, t, sc, ref base } = *a;
    let light = tone(col, 0.45, WHITE);
    let line = ink(col);
    let flat = Spec { blend: NORMAL, ..base.clone() };
    AuraParts {
        ground: vec![layer(
            Spec { rate: 1.8, life_min: 12.0, life_max: 20.0, emit_shape: GROUND, emit_radius: 36.0 * sc, speed_min: 1.2 * sc, speed_max: 2.6 * sc, drag: 0.08, gravity: -0.02 * sc, collide: 1.0, material: m("cloud"), rotate: ROTATE_FIXED, size_mode: GROW_POP, size0: 3.0 * sc, size1: 13.0 * sc, size_jitter: 0.4, fade_in: 0.0, fade_out: 0.0, outline: Some(Outline { width: 2.0 * sc, color: line }), ..flat.clone() },
            stops(&[([0.96, 0.95, 0.93], 1.0), ([0.86, 0.85, 0.84], 1.0)]),
        )],
        glow: layer(
            Spec { placement: Placement::Behind, rate: 4.0, life_min: 10.0, life_max: 16.0, emit_shape: BODY, emit_radius: 8.0 * sc, speed_min: 0.2 * sc, speed_max: 0.6 * sc, angle: UP, spread: 1.0, size0: 24.0 * s * sc, size1: 34.0 * s * sc, softness: 1.6, alpha: 0.2, fade_in: 0.3, fade_out: 0.5, ..base.clone() },
            stops(&[(light, 1.0 * i), (col, 0.8 * i)]),
        ),
        main: vec![layer(
            Spec { placement: Placement::Behind, rate: 14.0, life_min: 10.0, life_max: 16.0, emit_shape: BODY, emit_radius: 8.0 * sc, speed_min: 1.6 * s * sc, speed_max: 3.2 * s * sc, angle: UP, spread: 0.4, gravity: -0.1 * s * sc, drag: 0.05, curl: 6.0 * t * sc, curl_scale: 0.02 / sc, material: m("toonFlame"), rotate: ROTATE_MOTION, frame_rate: 2.0, aspect: 1.3, size_mode: GROW_POP, size0: 6.0 * sc, size1: 17.0 * (0.7 + 0.3 * s) * sc, size_jitter: 0.35, inherit: 0.6, fade_in: 0.0, fade_out: 0.0, outline: Some(Outline { width: 2.5 * sc, color: line }), ..flat.clone() },
            stops(&[(light, 1.0), (col, 1.0), (col, 1.0), (tone(col, 0.3, BLACK), 1.0)]),
        )],
        particles: layer(
            Spec { rate: 1.2, life_min: 14.0, life_max: 22.0, emit_shape: BODY, emit_radius: 24.0 * sc, speed_min: 0.6 * sc, speed_max: 1.4 * sc, angle: UP, spread: 1.4, gravity: -0.02 * sc, material: m("toonStar"), spin: 0.08, spin_jitter: 1.0, size_mode: GROW_POP, size0: 2.0 * sc, size1: 6.0 * sc, fade_in: 0.0, fade_out: 0.0, outline: Some(Outline { width: 1.5 * sc, color: line }), ..flat.clone() },
            stops(&[(tone(col, 0.7, WHITE), 1.0), (light, 1.0)]),
        ),
    }
}

fn aura_spirit(a: &AuraInput) -> AuraParts {
    let AuraInput { col, i, s, t: _, sc, ref base } = *a;
    let hot = tone(col, 0.6, WHITE);
    let dust = tone([0.6, 0.58, 0.55], 0.2, col);
    AuraParts {
        ground: vec![
            layer(
                Spec { placement: Placement::Behind, rate: 3.5, life_min: 14.0, life_max: 24.0, emit_shape: GROUND, emit_radius: 14.0 * sc, speed_min: 4.0 * sc, speed_max: 8.0 * sc, drag: 0.1, collide: 1.0, material: m("smoke"), rotate: ROTATE_UPRIGHT, size_mode: GROW_PUFF, size0: 6.0 * sc, size1: 22.0 * sc, alpha: 0.32, blend: NORMAL, fade_in: 0.1, fade_out: 0.6, ..base.clone() },
                stops(&[(dust, 1.0)]),
            ),
            layer(
                Spec { rate: 0.9, life_min: 40.0, life_max: 70.0, emit_shape: GROUND, emit_radius: 50.0 * sc, speed_min: 0.3 * sc, speed_max: 0.9 * sc, angle: UP, spread: 0.3, gravity: -0.012 * sc, drag: 0.01, material: m("rock"), spin: 0.04, spin_jitter: 1.0, size0: 3.0 * sc, size1: 3.0 * sc, size_jitter: 0.6, blend: NORMAL, fade_in: 0.15, fade_out: 0.2, ..base.clone() },
                stops(&[(ROCK, 1.0), (tone(ROCK, 0.3, BLACK), 1.0)]),
            ),
        ],
        glow: layer(
            Spec { placement: Placement::Behind, rate: 5.0, life_min: 8.0, life_max: 14.0, emit_shape: BODY, emit_radius: 8.0 * sc, speed_min: 0.4 * sc, speed_max: 1.0 * sc, angle: UP, spread: 0.6, gravity: -0.04 * sc, size0: 26.0 * s * sc, size1: 36.0 * s * sc, softness: 2.2, alpha: 0.24, fade_in: 0.3, fade_out: 0.5, ..base.clone() },
            stops(&[(hot, 1.3 * i), (col, 1.0 * i), (col, 0.5 * i)]),
        ),
        main: vec![
            layer(
                Spec { placement: Placement::Behind, rate: 18.0, life_min: 8.0, life_max: 14.0, emit_shape: BODY, emit_radius: 10.0 * sc, speed_min: 4.0 * s * sc, speed_max: 8.0 * s * sc, angle: UP, spread: 0.12, drag: 0.02, shape: STREAK, stretch: 2.6, size0: 3.0 * sc, size1: 1.2 * sc, softness: 1.1, alpha: 0.7, inherit: 0.4, fade_in: 0.15, fade_out: 0.5, ..base.clone() },
                stops(&[(WHITE, 2.2 * i), (hot, 1.8 * i), (col, 1.3 * i), (col, 0.6 * i)]),
            ),
            layer(
                Spec { rate: 6.0, life_min: 6.0, life_max: 10.0, emit_shape: BODY, emit_radius: 6.0 * sc, speed_min: 5.0 * s * sc, speed_max: 9.0 * s * sc, angle: UP, spread: 0.1, shape: STREAK, stretch: 2.2, size0: 1.6 * sc, size1: 0.6 * sc, softness: 0.9, alpha: 0.6, inherit: 0.4, fade_in: 0.15, fade_out: 0.5, ..base.clone() },
                stops(&[(WHITE, 2.6 * i), (hot, 1.8 * i)]),
            ),
        ],
        particles: layer(
            Spec { rate: 0.8, life_min: 3.0, life_max: 5.0, emit_shape: BODY, emit_radius: 14.0 * sc, speed_min: 0.0, speed_max: 0.0, material: m("bolt"), frame_rate: 1.0, size0: 14.0 * sc, size1: 12.0 * sc, flicker: 0.5, fade_in: 0.0, fade_out: 0.3, ..base.clone() },
            stops(&[(WHITE, 2.4 * i), (hot, 2.0 * i), (col, 1.4 * i)]),
        ),
    }
}

fn aura(p: &Aura, ctx: &Context) -> Vec<Spec> {
    let style: fn(&AuraInput) -> AuraParts = match p.style.index() {
        1 => aura_electric,
        2 => aura_shadow,
        3 => aura_holy,
        4 => aura_ice,
        5 => aura_wind,
        6 => aura_toon,
        7 => aura_spirit,
        _ => aura_fire,
    };
    let sc = body_scale(ctx.body_height);
    let base = Spec {
        start: ctx.start,
        emit_dur: ctx.window,
        clip_fade_in: if ctx.timed { 14.0 } else { 0.0 },
        clip_fade_out: if ctx.timed { 16.0 } else { 0.0 },
        world: p.trail,
        body: true,
        rate_param: Some(RateParam::Density),
        blend: glow_blend(p.blend),
        ..Spec::default()
    };
    let parts = style(&AuraInput { col: paint_color(&p.color), i: p.intensity, s: p.height, t: p.turbulence, sc, base });
    let mut out = Vec::new();
    if p.dust {
        out.extend(parts.ground);
    }
    if p.glow {
        out.push(parts.glow);
    }
    if p.flames {
        out.extend(parts.main);
    }
    if p.embers {
        out.push(parts.particles);
    }
    out
}

// ---------------------------------------------------------------------------
// Beams: energy, laser, cartoon, spiral, lightning and fire breath.
// ---------------------------------------------------------------------------

/// `BEAM_STYLE`.
const BEAM_ENERGY: f64 = 0.0;
const BEAM_LASER: f64 = 1.0;
const BEAM_TOON: f64 = 2.0;
const BEAM_SPIRAL: f64 = 3.0;

fn beam(p: &Beam, ctx: &Context) -> Vec<Spec> {
    let col = paint_color(&p.color);
    let hot = tone(col, 0.5, WHITE);
    let i = p.intensity;
    let w = p.width;
    let wr = w / 16.0;
    let charge = paint::js_round(p.charge);
    let placement = behind(p.layer == DrawLayer::Behind);
    let style = p.style.index();
    let toon = style == 2;
    let line = ink(col);
    let fire_start = ctx.start + charge;
    let fire_end = ctx.end;
    let grow = p.travel.max(1.0);
    let firing = (fire_end - fire_start).max(1.0);
    let fade = if ctx.fade_out != 0.0 && !ctx.fade_out.is_nan() { ctx.fade_out } else { 8.0 };
    let beam = Spec {
        blend: if toon { NORMAL } else { glow_blend(p.blend) },
        beam_w: w,
        wobble: if style == 1 { 0.0 } else { 0.35 * p.wobble },
        grow,
        fire_start,
        fire_end,
        fade_frames: if ctx.timed { 12.0f64.min(fade).max(4.0) } else { 1.0 },
        arc_amp: (14.0 * p.wobble + 6.0) * wr.sqrt().max(0.6),
        placement,
        ..Spec::default()
    };
    let soft = |toon_value: f64, value: f64| if toon { toon_value } else { value };
    let charge_in = (p.charge_particles && charge > 0.0).then(|| {
        layer(
            Spec { start: ctx.start, emit_dur: charge + 2.0, rate: if style == 1 { 8.0 } else { 14.0 }, life_min: 9.0, life_max: 13.0, emit_shape: EMIT_RING, emit_radius: 72.0 * wr.sqrt(), radial: -1.0, speed_min: 6.0 * wr.sqrt(), speed_max: 6.0 * wr.sqrt(), shape: STREAK, stretch: 2.6, size0: 2.6, size1: 1.2, softness: soft(0.05, 0.9), fade_in: 0.25, fade_out: 0.3, ..beam.clone() },
            stops(&[(tone(col, 0.5, WHITE), 2.2 * i), (col, 2.6 * i), (WHITE, 4.0 * i), (WHITE, 4.0 * i)]),
        )
    });
    let orb = p.orb.then(|| {
        layer(
            Spec {
                start: ctx.start,
                emit_dur: (fire_end - ctx.start).max(1.0),
                rate: 1.5,
                life_min: 6.0,
                life_max: 8.0,
                emit_radius: 2.0,
                size0: (if style == 1 { 12.0 } else { 18.0 }) * wr,
                size1: (if style == 1 { 15.0 } else { 22.0 }) * wr,
                softness: soft(0.05, 1.6),
                alpha: 0.9,
                fade_in: soft(0.0, 0.2),
                fade_out: soft(0.0, 0.6),
                clip_fade_in: charge.max(1.0),
                clip_fade_out: if ctx.timed { 8.0 } else { 0.0 },
                size_jitter: 0.15,
                size_mode: if toon { GROW_FLICKER } else { GROW_CURVE },
                outline: toon.then_some(Outline { width: 3.0, color: line }),
                ..beam.clone()
            },
            stops(&[(WHITE, 3.0 * i), (tone(col, 0.3, WHITE), 2.2 * i), (col, 2.0 * i), (col, 1.0 * i)]),
        )
    });
    let flare = layer(
        Spec {
            start: fire_start + grow,
            emit_dur: (firing - grow).max(1.0),
            rate: soft(0.8, 1.6),
            life_min: 5.0,
            life_max: 7.0,
            emit_shape: BEAM_TIP,
            emit_radius: 2.0,
            material: m(if toon { "burst" } else { "star" }),
            size_mode: if toon { GROW_POP } else { GROW_CURVE },
            size0: 24.0 * wr.sqrt(),
            size1: 34.0 * wr.sqrt(),
            size_jitter: 0.3,
            fade_in: soft(0.0, 0.1),
            fade_out: soft(0.0, 0.6),
            outline: toon.then_some(Outline { width: 3.0, color: line }),
            ..beam.clone()
        },
        stops(&[(WHITE, 2.6 * i), (hot, 2.0 * i), (col, 1.4 * i)]),
    );
    let sparks = (p.sparks > 0.0).then(|| {
        layer(
            Spec { start: fire_start, emit_dur: firing, rate: 7.0 * p.sparks, life_min: 7.0, life_max: 15.0, emit_shape: BEAM_LINE, emit_radius: 10.0 * wr, spread: 0.35, speed_min: 7.0, speed_max: 14.0, shape: STREAK, stretch: 1.2, size0: 2.2, size1: 0.8, softness: soft(0.05, 0.8), fade_in: 0.1, fade_out: 0.5, ..beam.clone() },
            stops(&[(tone(col, 0.6, WHITE), 2.4 * i), (col, 1.8 * i), (col, 1.2 * i), (col, 0.6 * i)]),
        )
    });
    let splash = (p.splash && p.sparks > 0.0).then(|| {
        layer(
            Spec { start: fire_start + grow, emit_dur: (firing - grow - 4.0).max(1.0), rate: (if style == 1 { 10.0 } else { 7.0 }) * p.sparks, life_min: 8.0, life_max: 18.0, emit_shape: BEAM_TIP, emit_radius: 8.0 * wr, angle: PI, spread: 2.4, speed_min: 4.0, speed_max: 11.0, gravity: 0.28, drag: 0.04, shape: STREAK, stretch: 1.1, size0: 2.6, size1: 1.0, softness: soft(0.05, 0.7), fade_out: 0.4, ..beam.clone() },
            stops(&[(WHITE, 4.0 * i), (tone(col, 0.5, WHITE), 3.0 * i), (col, 2.0 * i), (col, 0.8 * i)]),
        )
    });
    let arcs = |n: f64, width: f64, spread: f64, glow: f64| {
        (n > 0.0).then(|| {
            layer(
                Spec { shape: ARC, count: n * 14.0, start: fire_start, arc_amp: beam.arc_amp * spread, size0: 1.6 * width * (wr * 0.6).max(1.0), ..beam.clone() },
                stops(&[(tone(col, 0.35, WHITE), glow * i)]),
            )
        })
    };
    let core = |beam_style: f64| {
        layer(
            Spec { shape: BEAM, count: 1.0, start: fire_start, beam_style, outline: toon.then_some(Outline { width: 3.0, color: line }), ..beam.clone() },
            stops(&[(WHITE, 3.2 * i), (col, 1.5 * i)]),
        )
    };
    let arcs_count = p.arcs as f64;
    if style == 4 {
        // Lightning: forked arcs carry the strike, flashing where it starts and lands.
        let flash = |at: u8| {
            layer(
                Spec { start: fire_start, emit_dur: firing, rate: 1.0, life_min: 2.0, life_max: 3.0, emit_shape: at, emit_radius: 2.0, material: m("star"), size0: 30.0 * wr.sqrt(), size1: 26.0 * wr.sqrt(), flicker: 0.6, fade_in: 0.0, fade_out: 0.4, ..beam.clone() },
                stops(&[(WHITE, 3.0 * i), (hot, 2.2 * i), (col, 1.4 * i)]),
            )
        };
        return [charge_in, arcs(arcs_count.max(3.0), 1.0, 1.6, 1.7), Some(flash(POINT)), p.splash.then(|| flash(BEAM_TIP)), splash].into_iter().flatten().collect();
    }
    if style == 5 {
        // Fire breath: flames stream toward the aim and reach it at the end of their life.
        let stream = Spec { placement, blend: beam.blend, start: fire_start, emit_dur: firing, aimed: true, clip_fade_out: if ctx.timed { 12.0f64.min(fade).max(4.0) } else { 0.0 }, ..Spec::default() };
        let orb_layer = orb.as_ref().map(|orb| Spec { start: fire_start, emit_dur: firing, clip_fade_in: 1.0, size0: 14.0 * wr, size1: 18.0 * wr, ..orb.clone() });
        let mut out: Vec<Spec> = orb_layer.into_iter().collect();
        out.push(layer(
            Spec { blend: NORMAL, start: fire_start + 3.0, rate: 6.0, life_min: 22.0, life_max: 30.0, emit_radius: 0.3 * w, spread: 0.3, speed_min: 4.2, speed_max: 5.0, curl: 10.0 + 8.0 * p.wobble, curl_scale: 0.015, gravity: -0.05, material: m("smoke"), rotate: ROTATE_UPRIGHT, size_mode: GROW_PUFF, size0: 0.6 * w, size1: 2.4 * w, alpha: 0.28, fade_in: 0.3, fade_out: 0.6, ..stream.clone() },
            stops(&[([0.46, 0.44, 0.47], 1.0), ([0.3, 0.29, 0.31], 1.0)]),
        ));
        out.push(layer(
            Spec { rate: 26.0, life_min: 13.0, life_max: 18.0, emit_radius: 0.2 * w, spread: 0.24, speed_min: 6.2, speed_max: 7.2, curl: 6.0 + 8.0 * p.wobble, curl_scale: 0.02, gravity: -0.03, material: m("flame"), rotate: ROTATE_MOTION, frame_rate: 2.0, aspect: 1.2, size_mode: GROW_PUFF, size0: 0.35 * w, size1: 1.6 * w, size_jitter: 0.3, alpha: 0.8, fade_in: 0.05, fade_out: 0.45, ..stream.clone() },
            stops(&[(WHITE, 2.4 * i), (hot, 2.0 * i), (col, 1.6 * i), (tone(col, 0.5, BLACK), 0.8 * i), (rgb(0x2a2220), 0.3)]),
        ));
        if p.sparks > 0.0 {
            out.push(layer(
                Spec { rate: 8.0 * p.sparks, life_min: 12.0, life_max: 20.0, emit_radius: 0.2 * w, spread: 0.4, speed_min: 6.5, speed_max: 8.5, gravity: -0.02, curl: 10.0, curl_scale: 0.03, size0: 1.8, size1: 0.6, softness: 0.4, flicker: 0.5, ..stream.clone() },
                stops(&[(WHITE, 3.0 * i), (hot, 2.4 * i), (col, 1.6 * i)]),
            ));
        }
        return out;
    }
    let kind = if style == 1 {
        BEAM_LASER
    } else if toon {
        BEAM_TOON
    } else if style == 3 {
        BEAM_SPIRAL
    } else {
        BEAM_ENERGY
    };
    let lightning = if style == 1 || toon { None } else { arcs(if style == 3 { (arcs_count / 2.0).ceil() } else { arcs_count }, 1.0, 1.0, 2.6) };
    [charge_in, orb, Some(core(kind)), sparks, lightning, splash, p.splash.then_some(flare)].into_iter().flatten().collect()
}

// ---------------------------------------------------------------------------
// Explosions. Every layer bursts from where the target was when the clip
// began; the style decides what the blast is made of.
// ---------------------------------------------------------------------------

struct Blast<'a> {
    p: &'a Explosion,
    col: [f64; 3],
    hot: [f64; 3],
    low: [f64; 3],
    i: f64,
    s: f64,
    d: f64,
    s0: f64,
    window: f64,
    multi: bool,
    base: Spec,
}

fn some_if(on: bool, f: impl FnOnce() -> Spec) -> Option<Spec> {
    on.then(f)
}

fn blast_fireball(b: &Blast<'_>) -> Vec<Option<Spec>> {
    let Blast { p, col, hot, low, i, s, d, s0, window, ref base, .. } = *b;
    let dust = rgb(0x8b7d73);
    let smoke = smoke_colors();
    vec![
        some_if(p.dust, || layer(Spec { placement: Placement::Behind, start: s0 + 2.0, count: 26.0 * d, burst_jitter: 4.0, life_min: 30.0, life_max: 56.0, emit_shape: GROUND, emit_radius: 80.0 * s, speed_min: 3.0 * s, speed_max: 8.0 * s, drag: 0.07, gravity: -0.004, collide: 1.0, material: m("smoke"), rotate: ROTATE_UPRIGHT, size_mode: GROW_PUFF, size0: 12.0 * s, size1: 42.0 * s, alpha: 0.4, shade: 0.9, blend: NORMAL, fade_in: 0.1, fade_out: 0.6, ..base.clone() }, stops(&[(dust, 1.0)]))),
        some_if(p.smoke > 0.0, || layer(Spec { start: s0 + 4.0, emit_dur: 8.0f64.min(window).max(2.0), rate: 5.0 * p.smoke * d, life_min: 50.0, life_max: 90.0, emit_radius: 26.0 * s, spread: TAU, speed_min: 0.5 * s, speed_max: 2.2 * s, gravity: -0.035 * s, drag: 0.04, curl: 22.0 * s, curl_scale: 0.009 / s, material: m("smoke"), rotate: ROTATE_UPRIGHT, size_mode: GROW_PUFF, size0: 18.0 * s, size1: 64.0 * s, size_jitter: 0.3, alpha: 0.62 * 1.0f64.min(p.smoke), blend: NORMAL, fade_in: 0.1, fade_out: 0.55, ..base.clone() }, stops(&[(smoke[0], 1.0), (smoke[1], 1.0), (smoke[2], 1.0)]))),
        some_if(p.debris > 0.0, || layer(Spec { start: s0, count: 22.0 * p.debris, burst_jitter: 1.0, life_min: 34.0, life_max: 56.0, emit_radius: 12.0 * s, angle: UP, spread: 3.6, speed_min: 5.0 * s, speed_max: 13.0 * s, gravity: 0.45, drag: 0.012, collide: 1.0, spin: 0.3, spin_jitter: 1.0, material: m("rock"), size0: 4.5 * s, size1: 4.5 * s, size_jitter: 0.6, blend: NORMAL, fade_in: 0.0, fade_out: 0.15, ..base.clone() }, stops(&[(tone(col, 0.4, [0.35, 0.2, 0.12]), 1.4), (rgb(0x4a3a30), 1.0), (rgb(0x2a2422), 1.0), (rgb(0x2a2422), 1.0)]))),
        some_if(p.fireball, || layer(Spec { start: s0, count: 34.0 * d, burst_jitter: 3.0, life_min: 18.0, life_max: 34.0, emit_radius: 14.0 * s, spread: TAU, speed_min: 1.5 * s, speed_max: 6.0 * s, drag: 0.11, gravity: -0.06 * s, curl: 14.0 * s, curl_scale: 0.012 / s, material: m("smoke"), spin: 0.03, spin_jitter: 1.0, size_mode: GROW_PUFF, size0: 14.0 * s, size1: 46.0 * s, size_jitter: 0.35, shade: 0.8, alpha: 0.6, fade_in: 0.03, fade_out: 0.5, ..base.clone() }, stops(&[(hot, 1.3 * i), (col, 1.3 * i), (col, 1.1 * i), (low, 0.9 * i), (rgb(0x2a1a16), 0.4)]))),
        some_if(p.fireball, || layer(Spec { start: s0, count: 16.0 * d, burst_jitter: 1.0, life_min: 8.0, life_max: 14.0, emit_radius: 8.0 * s, spread: TAU, speed_min: 4.0 * s, speed_max: 9.0 * s, drag: 0.12, material: m("flame"), rotate: ROTATE_MOTION, aspect: 1.4, size0: 22.0 * s, size1: 8.0 * s, alpha: 0.6, fade_in: 0.0, fade_out: 0.5, ..base.clone() }, stops(&[(WHITE, 2.0 * i), (hot, 1.6 * i), (col, 1.2 * i)]))),
        some_if(p.sparks, || layer(Spec { start: s0, count: 36.0 * d, burst_jitter: 2.0, life_min: 14.0, life_max: 32.0, emit_radius: 10.0 * s, angle: UP, spread: TAU, speed_min: 6.0 * s, speed_max: 19.0 * s, gravity: 0.36, drag: 0.03, collide: 1.0, shape: STREAK, stretch: 1.3, halo: Some(Halo { scale: 2.4, alpha: 0.35 }), size0: 2.4, size1: 0.9, softness: 0.6, fade_out: 0.4, ..base.clone() }, stops(&[(WHITE, 1.3 * i), (hot, 1.3 * i), (col, 1.3 * i), (low, 1.1 * i)]))),
        some_if(p.sparks, || layer(Spec { start: s0 + 2.0, count: 30.0 * d, burst_jitter: 8.0, life_min: 30.0, life_max: 60.0, emit_radius: 30.0 * s, spread: TAU, speed_min: 0.5 * s, speed_max: 2.0 * s, gravity: -0.03 * s, drag: 0.03, curl: 20.0 * s, curl_scale: 0.015 / s, size0: 2.0 * s, size1: 0.8 * s, softness: 0.4, flicker: 0.5, ..base.clone() }, stops(&[(WHITE, 2.5 * i), (hot, 2.0 * i), (col, 1.5 * i), (col, 0.6 * i)]))),
        some_if(p.ring, || layer(Spec { start: s0 + 1.0, count: 1.0, life_min: 14.0, life_max: 14.0, shape: RING, size0: 24.0 * s, size1: 260.0 * s, size_curve: 0.45, softness: 0.08, size_jitter: 0.0, alpha: 0.8, fade_in: 0.0, fade_out: 0.75, ..base.clone() }, stops(&[(hot, 0.8 * i), (col, 0.6 * i), (col, 0.4 * i), (col, 0.15 * i)]))),
        some_if(p.flash, || layer(Spec { start: s0, count: 1.0, life_min: 6.0, life_max: 6.0, size0: 80.0 * s, size1: 170.0 * s, size_curve: 0.5, softness: 2.4, size_jitter: 0.0, fade_in: 0.0, fade_out: 0.85, ..base.clone() }, stops(&[(WHITE, 1.0 * i), (hot, 0.9 * i), (col, 0.7 * i), (col, 0.25 * i)]))),
    ]
}

fn blast_cartoon(b: &Blast<'_>) -> Vec<Option<Spec>> {
    let Blast { p, col, s, d, s0, ref base, .. } = *b;
    let flat = Spec { blend: NORMAL, ..base.clone() };
    let line = ink(col);
    let light = tone(col, 0.55, WHITE);
    let line_w = (3.0 * s).max(1.5);
    vec![
        some_if(p.dust, || layer(Spec { placement: Placement::Behind, start: s0 + 2.0, count: 12.0 * d, burst_jitter: 3.0, life_min: 16.0, life_max: 26.0, emit_shape: GROUND, emit_radius: 60.0 * s, speed_min: 3.0 * s, speed_max: 7.0 * s, drag: 0.1, collide: 1.0, material: m("cloud"), rotate: ROTATE_FIXED, size_mode: GROW_POP, size0: 6.0 * s, size1: 20.0 * s, fade_in: 0.0, fade_out: 0.0, outline: Some(Outline { width: line_w * 0.8, color: line }), ..flat.clone() }, stops(&[([0.95, 0.93, 0.9], 1.0), ([0.84, 0.82, 0.8], 1.0)]))),
        some_if(p.smoke > 0.0, || layer(Spec { start: s0 + 6.0, emit_dur: 6.0, rate: 3.0 * p.smoke * d, life_min: 26.0, life_max: 40.0, emit_radius: 30.0 * s, spread: TAU, speed_min: 0.6 * s, speed_max: 2.0 * s, gravity: -0.04 * s, drag: 0.05, material: m("cloud"), rotate: ROTATE_FIXED, size_mode: GROW_POP, size0: 10.0 * s, size1: 34.0 * s, size_jitter: 0.3, fade_in: 0.0, fade_out: 0.0, outline: Some(Outline { width: line_w * 0.8, color: [0.1, 0.09, 0.1] }), ..flat.clone() }, stops(&[([0.9, 0.89, 0.9], 1.0), ([0.72, 0.7, 0.74], 1.0)]))),
        some_if(p.debris > 0.0, || layer(Spec { start: s0, count: 12.0 * p.debris, burst_jitter: 1.0, life_min: 26.0, life_max: 44.0, emit_radius: 12.0 * s, angle: UP, spread: 3.6, speed_min: 6.0 * s, speed_max: 13.0 * s, gravity: 0.45, drag: 0.012, collide: 1.0, spin: 0.3, spin_jitter: 1.0, material: m("shard"), size0: 5.0 * s, size1: 5.0 * s, size_jitter: 0.5, fade_in: 0.0, fade_out: 0.0, outline: Some(Outline { width: line_w * 0.5, color: line }), ..flat.clone() }, stops(&[([0.5, 0.44, 0.4], 1.0), ([0.36, 0.3, 0.28], 1.0)]))),
        some_if(p.fireball, || layer(Spec { start: s0, count: 16.0 * d, burst_jitter: 2.0, life_min: 14.0, life_max: 24.0, emit_radius: 14.0 * s, spread: TAU, speed_min: 2.0 * s, speed_max: 6.0 * s, drag: 0.14, gravity: -0.05 * s, material: m("cloud"), rotate: ROTATE_FIXED, size_mode: GROW_POP, size0: 12.0 * s, size1: 40.0 * s, size_jitter: 0.35, fade_in: 0.0, fade_out: 0.0, outline: Some(Outline { width: line_w, color: line }), ..flat.clone() }, stops(&[([1.0, 0.97, 0.7], 1.0), (light, 1.0), (col, 1.0), (tone(col, 0.35, BLACK), 1.0)]))),
        some_if(p.sparks, || layer(Spec { start: s0, count: 22.0 * d, burst_jitter: 1.0, life_min: 6.0, life_max: 10.0, emit_radius: 30.0 * s, spread: TAU, speed_min: 14.0 * s, speed_max: 22.0 * s, drag: 0.1, shape: STREAK, stretch: 1.6, size0: 3.0 * s, size1: 1.0 * s, softness: 0.05, fade_in: 0.0, fade_out: 0.3, ..flat.clone() }, stops(&[(WHITE, 1.0), (light, 1.0)]))),
        some_if(p.sparks, || layer(Spec { start: s0 + 2.0, count: 6.0 * d, burst_jitter: 3.0, life_min: 14.0, life_max: 22.0, emit_radius: 40.0 * s, spread: TAU, speed_min: 2.0 * s, speed_max: 4.0 * s, drag: 0.06, material: m("toonStar"), spin: 0.15, spin_jitter: 1.0, size_mode: GROW_POP, size0: 3.0 * s, size1: 9.0 * s, fade_in: 0.0, fade_out: 0.0, outline: Some(Outline { width: line_w * 0.6, color: line }), ..flat.clone() }, stops(&[([1.0, 0.92, 0.4], 1.0)]))),
        some_if(p.ring, || layer(Spec { start: s0 + 1.0, count: 1.0, life_min: 10.0, life_max: 10.0, shape: RING, size0: 30.0 * s, size1: 200.0 * s, size_curve: 0.5, softness: 0.05, size_jitter: 0.0, fade_in: 0.0, fade_out: 0.5, ..flat.clone() }, stops(&[(WHITE, 1.0), (light, 1.0)]))),
        some_if(p.flash, || layer(Spec { start: s0, count: 1.0, life_min: 6.0, life_max: 6.0, material: m("burst"), size0: 60.0 * s, size1: 90.0 * s, size_jitter: 0.0, fade_in: 0.0, fade_out: 0.0, outline: Some(Outline { width: line_w, color: line }), ..flat.clone() }, stops(&[(WHITE, 1.0), (light, 1.0)]))),
    ]
}

fn blast_plasma(b: &Blast<'_>) -> Vec<Option<Spec>> {
    let Blast { p, col, hot, i, s, d, s0, ref base, .. } = *b;
    // Energy gathers for five frames, then bursts.
    let burst = s0 + 5.0;
    let pale = tone(col, 0.7, WHITE);
    vec![
        Some(layer(Spec { start: s0, emit_dur: 5.0, rate: 24.0 * d, life_min: 5.0, life_max: 6.0, emit_shape: EMIT_RING, emit_radius: 90.0 * s, radial: -1.0, speed_min: 16.0 * s, speed_max: 18.0 * s, shape: STREAK, stretch: 1.6, size0: 2.2, size1: 1.2, softness: 0.8, fade_in: 0.3, fade_out: 0.2, ..base.clone() }, stops(&[(col, 1.6 * i), (WHITE, 2.6 * i)]))),
        some_if(p.dust, || layer(Spec { placement: Placement::Behind, start: burst, count: 1.0, life_min: 26.0, life_max: 26.0, emit_shape: GROUND, aspect: 0.22, softness: 1.2, size0: 60.0 * s, size1: 170.0 * s, size_mode: GROW_PUFF, size_jitter: 0.0, alpha: 0.6, fade_in: 0.0, fade_out: 0.7, ..base.clone() }, stops(&[(pale, 1.4 * i), (col, 1.0 * i)]))),
        some_if(p.smoke > 0.0, || layer(Spec { start: burst + 2.0, count: 10.0 * p.smoke * d, burst_jitter: 4.0, life_min: 30.0, life_max: 50.0, emit_radius: 30.0 * s, spread: TAU, speed_min: 0.5 * s, speed_max: 2.0 * s, drag: 0.04, curl: 18.0 * s, curl_scale: 0.01 / s, material: m("smoke"), size_mode: GROW_PUFF, size0: 20.0 * s, size1: 60.0 * s, alpha: 0.25, shade: 0.5, fade_in: 0.2, fade_out: 0.6, ..base.clone() }, stops(&[(col, 0.8 * i), (col, 0.4 * i)]))),
        some_if(p.debris > 0.0, || layer(Spec { start: burst, emit_dur: 14.0, rate: 1.6 * p.debris, life_min: 3.0, life_max: 6.0, emit_radius: 50.0 * s, material: m("bolt"), frame_rate: 1.0, size0: 40.0 * s, size1: 30.0 * s, size_jitter: 0.4, flicker: 0.5, fade_in: 0.0, fade_out: 0.4, ..base.clone() }, stops(&[(WHITE, 2.6 * i), (hot, 2.0 * i), (col, 1.4 * i)]))),
        some_if(p.fireball, || layer(Spec { start: burst, count: 3.0, burst_jitter: 2.0, life_min: 14.0, life_max: 20.0, emit_radius: 6.0 * s, size0: 40.0 * s, size1: 110.0 * s, size_mode: GROW_PUFF, softness: 1.8, size_jitter: 0.2, alpha: 0.45, fade_in: 0.0, fade_out: 0.7, ..base.clone() }, stops(&[(WHITE, 2.0 * i), (pale, 1.6 * i), (col, 1.2 * i), (col, 0.4 * i)]))),
        some_if(p.sparks, || layer(Spec { start: burst, count: 50.0 * d, burst_jitter: 2.0, life_min: 18.0, life_max: 30.0, emit_radius: 10.0 * s, spread: TAU, speed_min: 8.0 * s, speed_max: 12.0 * s, drag: 0.08, material: m("star"), spin: 0.1, spin_jitter: 1.0, size0: 7.0 * s, size1: 2.0 * s, flicker: 0.3, echoes: Some(Echoes { count: 3, lag: 2.0, alpha: 0.5, size: 0.8 }), ..base.clone() }, stops(&[(WHITE, 2.4 * i), (pale, 2.0 * i), (col, 1.5 * i)]))),
        some_if(p.sparks, || layer(Spec { start: burst, count: 28.0 * d, burst_jitter: 1.0, life_min: 10.0, life_max: 20.0, emit_radius: 8.0 * s, spread: TAU, speed_min: 10.0 * s, speed_max: 22.0 * s, drag: 0.05, shape: STREAK, stretch: 1.3, size0: 2.0, size1: 0.8, softness: 0.7, fade_out: 0.4, ..base.clone() }, stops(&[(WHITE, 2.4 * i), (pale, 2.0 * i), (col, 1.4 * i)]))),
        some_if(p.ring, || layer(Spec { start: burst, count: 1.0, life_min: 14.0, life_max: 14.0, shape: RING, size0: 20.0 * s, size1: 240.0 * s, size_curve: 0.4, softness: 0.12, size_jitter: 0.0, fade_in: 0.0, fade_out: 0.7, ..base.clone() }, stops(&[(WHITE, 1.4 * i), (pale, 1.2 * i), (col, 0.8 * i)]))),
        some_if(p.ring, || layer(Spec { start: burst + 4.0, count: 1.0, life_min: 16.0, life_max: 16.0, shape: RING, size0: 10.0 * s, size1: 170.0 * s, size_curve: 0.5, softness: 0.2, size_jitter: 0.0, alpha: 0.6, fade_in: 0.0, fade_out: 0.7, ..base.clone() }, stops(&[(pale, 1.2 * i), (col, 0.8 * i)]))),
        some_if(p.flash, || layer(Spec { start: burst, count: 1.0, life_min: 7.0, life_max: 7.0, size0: 90.0 * s, size1: 180.0 * s, size_curve: 0.5, softness: 2.2, size_jitter: 0.0, fade_in: 0.0, fade_out: 0.85, ..base.clone() }, stops(&[(WHITE, 1.2 * i), (pale, 1.0 * i), (col, 0.6 * i)]))),
    ]
}

fn blast_smoke_bomb(b: &Blast<'_>) -> Vec<Option<Spec>> {
    let Blast { p, col, i, s, d, s0, window, ref base, .. } = *b;
    let flat = Spec { blend: NORMAL, ..base.clone() };
    let light = tone(col, 0.35, WHITE);
    let deep = tone(col, 0.35, BLACK);
    vec![
        some_if(p.dust, || layer(Spec { placement: Placement::Behind, start: s0 + 1.0, count: 18.0 * d, burst_jitter: 3.0, life_min: 40.0, life_max: 70.0, emit_shape: GROUND, emit_radius: 70.0 * s, speed_min: 4.0 * s, speed_max: 9.0 * s, drag: 0.08, collide: 1.0, material: m("smoke"), rotate: ROTATE_UPRIGHT, size_mode: GROW_PUFF, size0: 14.0 * s, size1: 48.0 * s, alpha: 0.7, fade_in: 0.05, fade_out: 0.6, ..flat.clone() }, stops(&[(light, 1.0), (col, 1.0)]))),
        some_if(p.fireball, || layer(Spec { start: s0, count: 30.0 * d, burst_jitter: 3.0, life_min: 60.0, life_max: 110.0, emit_radius: 20.0 * s, spread: TAU, speed_min: 2.0 * s, speed_max: 7.0 * s, drag: 0.08, gravity: -0.01 * s, curl: 20.0 * s, curl_scale: 0.01 / s, material: m("smoke"), rotate: ROTATE_UPRIGHT, size_mode: GROW_PUFF, size0: 16.0 * s, size1: 70.0 * s, size_jitter: 0.3, alpha: 0.85, fade_in: 0.03, fade_out: 0.5, ..flat.clone() }, stops(&[(light, 1.0), (col, 1.0), (deep, 1.0)]))),
        some_if(p.smoke > 0.0, || layer(Spec { start: s0 + 6.0, emit_dur: 24.0f64.min(window).max(4.0), rate: 1.5 * p.smoke * d, life_min: 50.0, life_max: 80.0, emit_radius: 50.0 * s, spread: 1.0, angle: UP, speed_min: 0.4 * s, speed_max: 1.2 * s, gravity: -0.02 * s, drag: 0.03, curl: 24.0 * s, curl_scale: 0.009 / s, material: m("smoke"), rotate: ROTATE_UPRIGHT, size_mode: GROW_PUFF, size0: 20.0 * s, size1: 60.0 * s, alpha: 0.6, fade_in: 0.2, fade_out: 0.6, ..flat.clone() }, stops_with(&[(col, 1.0, 1.0), (light, 1.0, 0.7)]))),
        some_if(p.debris > 0.0, || layer(Spec { start: s0, count: 6.0 * p.debris, burst_jitter: 1.0, life_min: 20.0, life_max: 30.0, emit_radius: 8.0 * s, angle: UP, spread: 3.4, speed_min: 8.0 * s, speed_max: 14.0 * s, gravity: 0.18, drag: 0.05, material: m("smoke"), rotate: ROTATE_UPRIGHT, size0: 9.0 * s, size1: 5.0 * s, echoes: Some(Echoes { count: 5, lag: 2.0, alpha: 0.85, size: 0.92 }), alpha: 0.8, fade_in: 0.0, fade_out: 0.5, ..flat.clone() }, stops(&[(col, 1.0), (light, 1.0)]))),
        some_if(p.sparks, || layer(Spec { start: s0, count: 20.0 * d, burst_jitter: 1.0, life_min: 8.0, life_max: 16.0, emit_radius: 6.0 * s, spread: TAU, speed_min: 6.0 * s, speed_max: 12.0 * s, gravity: 0.3, drag: 0.05, shape: STREAK, stretch: 1.2, size0: 2.0, size1: 0.8, softness: 0.6, fade_out: 0.4, ..base.clone() }, stops(&[(WHITE, 2.0 * i), ([1.0, 0.8, 0.4], 1.6 * i), ([1.0, 0.5, 0.2], 1.0 * i)]))),
        some_if(p.ring, || layer(Spec { start: s0 + 1.0, count: 1.0, life_min: 12.0, life_max: 12.0, shape: RING, size0: 20.0 * s, size1: 170.0 * s, size_curve: 0.45, softness: 0.2, size_jitter: 0.0, alpha: 0.4, fade_in: 0.0, fade_out: 0.7, ..flat.clone() }, stops(&[(light, 1.0)]))),
        some_if(p.flash, || layer(Spec { start: s0, count: 1.0, life_min: 4.0, life_max: 4.0, size0: 40.0 * s, size1: 70.0 * s, softness: 2.0, size_jitter: 0.0, fade_in: 0.0, fade_out: 0.85, ..base.clone() }, stops(&[(WHITE, 1.0 * i), ([1.0, 0.85, 0.6], 0.8 * i)]))),
    ]
}

fn blast_mushroom(b: &Blast<'_>) -> Vec<Option<Spec>> {
    let Blast { p, col, hot, low, i, s, d, s0, window, ref base, .. } = *b;
    let flat = Spec { blend: NORMAL, ..base.clone() };
    let smoke = smoke_colors();
    let fire = [(WHITE, 1.4), (hot, 1.3), (col, 1.2), (low, 1.0), (smoke[0], 1.0), (smoke[2], 1.0)];
    let dust = rgb(0x8b7d73);
    vec![
        some_if(p.dust, || layer(Spec { placement: Placement::Behind, start: s0 + 3.0, count: 34.0 * d, burst_jitter: 6.0, life_min: 50.0, life_max: 80.0, emit_shape: GROUND, emit_radius: 140.0 * s, speed_min: 4.0 * s, speed_max: 10.0 * s, drag: 0.06, collide: 1.0, material: m("smoke"), rotate: ROTATE_UPRIGHT, size_mode: GROW_PUFF, size0: 16.0 * s, size1: 56.0 * s, alpha: 0.55, fade_in: 0.05, fade_out: 0.6, ..flat.clone() }, stops(&[(dust, 1.0)]))),
        some_if(p.smoke > 0.0, || layer(Spec { start: s0 + 1.0, emit_dur: 24.0f64.min(window).max(6.0), rate: 6.0 * 2.0f64.min(p.smoke) * d, life_min: 45.0, life_max: 75.0, emit_radius: 14.0 * s, angle: UP, spread: 0.12, speed_min: 3.0 * s, speed_max: 8.0 * s, drag: 0.035, gravity: -0.01 * s, curl: 10.0 * s, curl_scale: 0.012 / s, material: m("smoke"), rotate: ROTATE_UPRIGHT, size_mode: GROW_PUFF, size0: 12.0 * s, size1: 34.0 * s, alpha: 0.9, fade_in: 0.05, fade_out: 0.4, ..flat.clone() }, stops(&fire))),
        some_if(p.fireball, || layer(Spec { start: s0 + 2.0, count: 40.0 * d, burst_jitter: 5.0, life_min: 70.0, life_max: 110.0, emit_radius: 18.0 * s, angle: UP, spread: 0.7, speed_min: 11.0 * s, speed_max: 15.0 * s, drag: 0.06, gravity: -0.02 * s, curl: 16.0 * s, curl_scale: 0.01 / s, material: m("smoke"), rotate: ROTATE_UPRIGHT, size_mode: GROW_PUFF, size0: 20.0 * s, size1: 62.0 * s, size_jitter: 0.3, alpha: 0.95, fade_in: 0.02, fade_out: 0.35, ..flat.clone() }, stops(&fire))),
        some_if(p.fireball, || layer(Spec { start: s0 + 2.0, count: 14.0 * d, burst_jitter: 4.0, life_min: 24.0, life_max: 40.0, emit_radius: 18.0 * s, angle: UP, spread: 0.6, speed_min: 11.0 * s, speed_max: 14.0 * s, drag: 0.06, material: m("smoke"), size_mode: GROW_PUFF, size0: 18.0 * s, size1: 50.0 * s, alpha: 0.7, shade: 0.6, fade_in: 0.05, fade_out: 0.6, ..base.clone() }, stops(&[(WHITE, 1.4 * i), (hot, 1.3 * i), (col, 1.0 * i), (low, 0.4 * i)]))),
        some_if(p.debris > 0.0, || layer(Spec { start: s0, count: 20.0 * p.debris, burst_jitter: 2.0, life_min: 34.0, life_max: 56.0, emit_radius: 14.0 * s, angle: UP, spread: 2.8, speed_min: 6.0 * s, speed_max: 15.0 * s, gravity: 0.45, drag: 0.012, collide: 1.0, spin: 0.3, spin_jitter: 1.0, material: m("rock"), size0: 5.0 * s, size1: 5.0 * s, size_jitter: 0.6, fade_in: 0.0, fade_out: 0.15, ..flat.clone() }, stops(&[(ROCK, 1.0), (tone(ROCK, 0.3, BLACK), 1.0)]))),
        some_if(p.sparks, || layer(Spec { start: s0 + 3.0, count: 40.0 * d, burst_jitter: 12.0, life_min: 40.0, life_max: 70.0, emit_radius: 40.0 * s, spread: TAU, speed_min: 0.5 * s, speed_max: 2.5 * s, gravity: -0.05 * s, drag: 0.03, curl: 24.0 * s, curl_scale: 0.012 / s, size0: 2.2 * s, size1: 0.8 * s, softness: 0.4, flicker: 0.5, ..base.clone() }, stops(&[(WHITE, 2.5 * i), (hot, 2.0 * i), (col, 1.5 * i), (col, 0.6 * i)]))),
        some_if(p.ring, || layer(Spec { start: s0 + 1.0, count: 1.0, life_min: 20.0, life_max: 20.0, shape: RING, size0: 40.0 * s, size1: 420.0 * s, size_curve: 0.45, softness: 0.1, size_jitter: 0.0, alpha: 0.7, fade_in: 0.0, fade_out: 0.75, ..base.clone() }, stops(&[(hot, 0.9 * i), (col, 0.6 * i), (col, 0.3 * i)]))),
        some_if(p.flash, || layer(Spec { start: s0, count: 1.0, life_min: 9.0, life_max: 9.0, size0: 140.0 * s, size1: 300.0 * s, size_curve: 0.5, softness: 2.4, size_jitter: 0.0, fade_in: 0.0, fade_out: 0.85, ..base.clone() }, stops(&[(WHITE, 1.2 * i), (hot, 1.0 * i), (col, 0.7 * i), (col, 0.25 * i)]))),
    ]
}

fn blast_firework(b: &Blast<'_>) -> Vec<Option<Spec>> {
    let Blast { p, col, hot, i, s, d, s0, multi, ref base, .. } = *b;
    let colors = if multi { paint_ramp(&p.color, 1.6 * i) } else { stops(&[(WHITE, 2.6 * i), (hot, 2.0 * i), (col, 1.6 * i), (tone(col, 0.4, BLACK), 1.0 * i)]) };
    let mode = if multi { 1.0 } else { 0.0 };
    vec![
        some_if(p.fireball, || layer(Spec { start: s0, count: 70.0 * d, burst_jitter: 1.0, life_min: 30.0, life_max: 44.0, emit_radius: 3.0 * s, spread: TAU, speed_min: 7.0 * s, speed_max: 8.5 * s, drag: 0.06, gravity: 0.05, material: m("star"), spin: 0.08, spin_jitter: 1.0, size0: 11.0 * s, size1: 3.0 * s, flicker: 0.35, color_mode: mode, halo: Some(Halo { scale: 2.2, alpha: 0.3 }), echoes: Some(Echoes { count: 4, lag: 2.0, alpha: 0.6, size: 0.8 }), fade_in: 0.0, fade_out: 0.4, ..base.clone() }, colors)),
        some_if(p.sparks, || layer(Spec { start: s0 + 14.0, count: 40.0 * d, burst_jitter: 10.0, life_min: 8.0, life_max: 18.0, emit_radius: 100.0 * s, material: m("star"), size0: 4.0 * s, size1: 2.0 * s, flicker: 0.9, color_mode: mode, fade_in: 0.2, fade_out: 0.4, ..base.clone() }, colors)),
        some_if(p.sparks, || layer(Spec { start: s0, count: 40.0 * d, burst_jitter: 1.0, life_min: 20.0, life_max: 34.0, emit_radius: 3.0 * s, spread: TAU, speed_min: 4.0 * s, speed_max: 7.0 * s, drag: 0.05, gravity: 0.06, shape: STREAK, stretch: 1.6, size0: 1.6, size1: 0.6, softness: 0.7, color_mode: mode, fade_out: 0.5, ..base.clone() }, colors)),
        some_if(p.smoke > 0.0, || layer(Spec { blend: NORMAL, start: s0 + 4.0, count: 8.0 * p.smoke * d, burst_jitter: 4.0, life_min: 40.0, life_max: 70.0, emit_radius: 60.0 * s, speed_min: 0.2, speed_max: 0.6, gravity: -0.01, curl: 16.0 * s, curl_scale: 0.01 / s, material: m("smoke"), rotate: ROTATE_UPRIGHT, size_mode: GROW_PUFF, size0: 20.0 * s, size1: 50.0 * s, alpha: 0.09, fade_in: 0.3, fade_out: 0.6, ..base.clone() }, stops(&[([0.6, 0.6, 0.64], 1.0)]))),
        some_if(p.ring, || layer(Spec { start: s0, count: 1.0, life_min: 12.0, life_max: 12.0, shape: RING, size0: 10.0 * s, size1: 140.0 * s, size_curve: 0.5, softness: 0.15, size_jitter: 0.0, alpha: 0.45, fade_in: 0.0, fade_out: 0.7, ..base.clone() }, stops(&[(hot, 1.0 * i), (col, 0.6 * i)]))),
        some_if(p.flash, || layer(Spec { start: s0, count: 1.0, life_min: 5.0, life_max: 5.0, size0: 30.0 * s, size1: 60.0 * s, softness: 2.0, size_jitter: 0.0, fade_in: 0.0, fade_out: 0.8, ..base.clone() }, stops(&[(WHITE, 1.4 * i), (hot, 1.0 * i)]))),
    ]
}

fn blast_electric(b: &Blast<'_>) -> Vec<Option<Spec>> {
    let Blast { p, col, i, s, d, s0, ref base, .. } = *b;
    let pale = tone(col, 0.6, WHITE);
    vec![
        some_if(p.dust, || layer(Spec { start: s0, emit_dur: 10.0, rate: 1.6 * d, life_min: 3.0, life_max: 5.0, emit_shape: GROUND, emit_radius: 80.0 * s, material: m("bolt"), rotate: ROTATE_FIXED, frame_rate: 1.0, aspect: 0.6, size0: 22.0 * s, size1: 22.0 * s, flicker: 0.6, fade_in: 0.0, fade_out: 0.3, ..base.clone() }, stops(&[(WHITE, 2.4 * i), (pale, 2.0 * i), (col, 1.4 * i)]))),
        some_if(p.smoke > 0.0, || layer(Spec { start: s0 + 2.0, count: 8.0 * p.smoke * d, burst_jitter: 4.0, life_min: 24.0, life_max: 40.0, emit_radius: 30.0 * s, spread: TAU, speed_min: 0.4 * s, speed_max: 1.4 * s, drag: 0.04, curl: 14.0 * s, curl_scale: 0.012 / s, material: m("smoke"), size_mode: GROW_PUFF, size0: 18.0 * s, size1: 50.0 * s, alpha: 0.22, shade: 0.5, fade_in: 0.2, fade_out: 0.6, ..base.clone() }, stops(&[(col, 0.8 * i), (col, 0.3 * i)]))),
        some_if(p.fireball, || layer(Spec { start: s0, count: 12.0 * d, burst_jitter: 4.0, life_min: 3.0, life_max: 7.0, emit_radius: 26.0 * s, speed_min: 0.0, speed_max: 1.0 * s, spread: TAU, material: m("bolt"), frame_rate: 1.0, size0: 44.0 * s, size1: 60.0 * s, size_jitter: 0.3, flicker: 0.5, fade_in: 0.0, fade_out: 0.4, ..base.clone() }, stops(&[(WHITE, 2.8 * i), (pale, 2.2 * i), (col, 1.6 * i)]))),
        some_if(p.debris > 0.0, || layer(Spec { start: s0 + 2.0, emit_dur: 16.0, rate: 2.0 * p.debris * d, life_min: 3.0, life_max: 6.0, emit_radius: 70.0 * s, material: m("bolt"), frame_rate: 1.0, size0: 26.0 * s, size1: 20.0 * s, size_jitter: 0.4, flicker: 0.6, fade_in: 0.0, fade_out: 0.35, ..base.clone() }, stops(&[(WHITE, 2.4 * i), (pale, 2.0 * i), (col, 1.2 * i)]))),
        some_if(p.fireball, || layer(Spec { start: s0, count: 2.0, life_min: 10.0, life_max: 14.0, emit_radius: 4.0 * s, size0: 40.0 * s, size1: 80.0 * s, softness: 1.8, size_jitter: 0.2, flicker: 0.4, alpha: 0.8, fade_in: 0.0, fade_out: 0.7, ..base.clone() }, stops(&[(WHITE, 2.0 * i), (pale, 1.4 * i), (col, 0.8 * i)]))),
        some_if(p.sparks, || layer(Spec { start: s0, count: 32.0 * d, burst_jitter: 3.0, life_min: 8.0, life_max: 18.0, emit_radius: 10.0 * s, spread: TAU, speed_min: 8.0 * s, speed_max: 20.0 * s, gravity: 0.2, drag: 0.05, collide: 1.0, shape: STREAK, stretch: 1.2, size0: 2.0, size1: 0.7, softness: 0.6, fade_out: 0.4, ..base.clone() }, stops(&[(WHITE, 2.4 * i), (pale, 2.0 * i), (col, 1.4 * i)]))),
        some_if(p.ring, || layer(Spec { start: s0 + 1.0, count: 1.0, life_min: 12.0, life_max: 12.0, shape: RING, size0: 20.0 * s, size1: 220.0 * s, size_curve: 0.45, softness: 0.1, size_jitter: 0.0, flicker: 0.4, fade_in: 0.0, fade_out: 0.7, ..base.clone() }, stops(&[(WHITE, 1.2 * i), (pale, 1.0 * i), (col, 0.6 * i)]))),
        some_if(p.flash, || layer(Spec { start: s0, count: 1.0, life_min: 6.0, life_max: 6.0, size0: 80.0 * s, size1: 160.0 * s, softness: 2.4, size_jitter: 0.0, fade_in: 0.0, fade_out: 0.85, ..base.clone() }, stops(&[(WHITE, 1.2 * i), (pale, 1.0 * i), (col, 0.5 * i)]))),
    ]
}

fn blast_magic(b: &Blast<'_>) -> Vec<Option<Spec>> {
    let Blast { p, col, i, s, d, s0, multi, ref base, .. } = *b;
    let pale = tone(col, 0.6, WHITE);
    let colors = if multi { paint_ramp(&p.color, 1.6 * i) } else { stops(&[(WHITE, 2.2 * i), (pale, 1.8 * i), (col, 1.4 * i)]) };
    let mode = if multi { 1.0 } else { 0.0 };
    vec![
        some_if(p.dust, || layer(Spec { placement: Placement::Behind, start: s0, count: 1.0, life_min: 30.0, life_max: 30.0, emit_shape: GROUND, aspect: 0.24, softness: 1.2, size0: 40.0 * s, size1: 150.0 * s, size_mode: GROW_PUFF, size_jitter: 0.0, alpha: 0.55, fade_in: 0.1, fade_out: 0.7, ..base.clone() }, stops(&[(pale, 1.4 * i), (col, 1.0 * i)]))),
        some_if(p.smoke > 0.0, || layer(Spec { start: s0 + 2.0, count: 8.0 * p.smoke * d, burst_jitter: 4.0, life_min: 30.0, life_max: 50.0, emit_radius: 40.0 * s, spread: TAU, speed_min: 0.3 * s, speed_max: 1.2 * s, gravity: -0.02 * s, drag: 0.04, curl: 18.0 * s, curl_scale: 0.012 / s, material: m("smoke"), size_mode: GROW_PUFF, size0: 16.0 * s, size1: 46.0 * s, alpha: 0.22, shade: 0.4, color_mode: mode, fade_in: 0.2, fade_out: 0.6, ..base.clone() }, colors)),
        some_if(p.fireball, || layer(Spec { start: s0, count: 40.0 * d, burst_jitter: 2.0, life_min: 24.0, life_max: 40.0, emit_radius: 10.0 * s, spread: TAU, speed_min: 2.0 * s, speed_max: 7.0 * s, drag: 0.08, gravity: -0.02 * s, material: m("bokeh"), rotate: ROTATE_FIXED, size0: 7.0 * s, size1: 3.0 * s, size_jitter: 0.5, flicker: 0.3, color_mode: mode, fade_in: 0.0, fade_out: 0.5, ..base.clone() }, colors)),
        some_if(p.fireball, || layer(Spec { start: s0, count: 30.0 * d, burst_jitter: 1.0, life_min: 30.0, life_max: 45.0, emit_radius: 10.0 * s, spread: TAU, radial: 1.0, speed_min: 3.0 * s, speed_max: 5.0 * s, drag: 0.05, orbit: 0.12, material: m("star"), spin: 0.1, spin_jitter: 1.0, size0: 6.0 * s, size1: 2.0 * s, color_mode: mode, echoes: Some(Echoes { count: 2, lag: 2.0, alpha: 0.5, size: 0.8 }), fade_in: 0.0, fade_out: 0.4, ..base.clone() }, colors)),
        some_if(p.debris > 0.0, || layer(Spec { start: s0 + 2.0, count: 14.0 * p.debris, burst_jitter: 2.0, life_min: 30.0, life_max: 50.0, emit_radius: 10.0 * s, angle: UP, spread: 3.0, speed_min: 4.0 * s, speed_max: 9.0 * s, gravity: 0.2, drag: 0.03, material: m("toonStar"), spin: 0.15, spin_jitter: 1.0, size0: 4.0 * s, size1: 3.0 * s, color_mode: mode, fade_in: 0.0, fade_out: 0.3, ..base.clone() }, colors)),
        some_if(p.sparks, || layer(Spec { start: s0 + 4.0, emit_dur: 20.0, rate: 3.0 * d, life_min: 10.0, life_max: 18.0, emit_radius: 110.0 * s, material: m("star"), size_mode: GROW_POP, size0: 3.0 * s, size1: 7.0 * s, flicker: 0.4, color_mode: mode, fade_in: 0.1, fade_out: 0.4, ..base.clone() }, colors)),
        some_if(p.ring, || layer(Spec { start: s0, count: 1.0, life_min: 16.0, life_max: 16.0, shape: RING, size0: 20.0 * s, size1: 200.0 * s, size_curve: 0.5, softness: 0.12, size_jitter: 0.0, fade_in: 0.0, fade_out: 0.7, ..base.clone() }, stops(&[(pale, 1.2 * i), (col, 0.9 * i)]))),
        some_if(p.ring, || layer(Spec { start: s0 + 5.0, count: 1.0, life_min: 14.0, life_max: 14.0, shape: RING, size0: 10.0 * s, size1: 130.0 * s, size_curve: 0.5, softness: 0.3, size_jitter: 0.0, alpha: 0.6, fade_in: 0.0, fade_out: 0.7, ..base.clone() }, stops(&[(pale, 1.0 * i), (col, 0.7 * i)]))),
        some_if(p.flash, || layer(Spec { start: s0, count: 1.0, life_min: 12.0, life_max: 12.0, material: m("star"), rotate: ROTATE_FIXED, size_mode: GROW_PUFF, size0: 50.0 * s, size1: 110.0 * s, size_jitter: 0.0, fade_in: 0.0, fade_out: 0.8, ..base.clone() }, stops(&[(WHITE, 2.0 * i), (pale, 1.6 * i), (col, 1.0 * i)]))),
    ]
}

fn blast_dust(b: &Blast<'_>) -> Vec<Option<Spec>> {
    let Blast { p, col, s, d, s0, window, ref base, .. } = *b;
    let flat = Spec { blend: NORMAL, ..base.clone() };
    let light = tone(col, 0.3, WHITE);
    let deep = tone(col, 0.3, BLACK);
    vec![
        some_if(p.dust, || layer(Spec { placement: Placement::Behind, start: s0, count: 20.0 * d, burst_jitter: 3.0, life_min: 36.0, life_max: 66.0, emit_shape: GROUND, emit_radius: 30.0 * s, speed_min: 3.0 * s, speed_max: 9.0 * s, drag: 0.07, gravity: -0.004, collide: 1.0, curl: 12.0 * s, curl_scale: 0.012 / s, material: m("smoke"), rotate: ROTATE_UPRIGHT, size_mode: GROW_PUFF, size0: 14.0 * s, size1: 54.0 * s, size_jitter: 0.3, alpha: 0.75, fade_in: 0.03, fade_out: 0.6, ..flat.clone() }, stops(&[(light, 1.0), (col, 1.0)]))),
        some_if(p.fireball, || layer(Spec { start: s0, count: 12.0 * d, burst_jitter: 2.0, life_min: 30.0, life_max: 56.0, emit_radius: 14.0 * s, angle: UP, spread: 1.6, speed_min: 2.0 * s, speed_max: 5.0 * s, drag: 0.07, gravity: 0.01, curl: 14.0 * s, curl_scale: 0.012 / s, material: m("smoke"), rotate: ROTATE_UPRIGHT, size_mode: GROW_PUFF, size0: 16.0 * s, size1: 46.0 * s, size_jitter: 0.3, alpha: 0.8, fade_in: 0.03, fade_out: 0.55, ..flat.clone() }, stops(&[(light, 1.0), (col, 1.0), (deep, 1.0)]))),
        some_if(p.smoke > 0.0, || layer(Spec { start: s0 + 6.0, emit_dur: 16.0f64.min(window).max(4.0), rate: 1.2 * p.smoke * d, life_min: 40.0, life_max: 70.0, emit_radius: 50.0 * s, angle: UP, spread: 1.0, speed_min: 0.2 * s, speed_max: 0.8 * s, gravity: -0.01 * s, drag: 0.03, curl: 16.0 * s, curl_scale: 0.01 / s, material: m("smoke"), rotate: ROTATE_UPRIGHT, size_mode: GROW_PUFF, size0: 16.0 * s, size1: 50.0 * s, alpha: 0.4, fade_in: 0.2, fade_out: 0.6, ..flat.clone() }, stops(&[(col, 1.0), (light, 1.0)]))),
        some_if(p.debris > 0.0, || layer(Spec { start: s0, count: 18.0 * p.debris, burst_jitter: 1.0, life_min: 24.0, life_max: 40.0, emit_radius: 14.0 * s, angle: UP, spread: 2.6, speed_min: 4.0 * s, speed_max: 10.0 * s, gravity: 0.45, drag: 0.012, collide: 1.0, spin: 0.3, spin_jitter: 1.0, material: m("rock"), size0: 3.5 * s, size1: 3.5 * s, size_jitter: 0.6, fade_in: 0.0, fade_out: 0.15, ..flat.clone() }, stops(&[(tone(ROCK, 0.3, col), 1.0), (tone(ROCK, 0.3, BLACK), 1.0)]))),
        some_if(p.sparks, || layer(Spec { start: s0, count: 24.0 * d, burst_jitter: 1.0, life_min: 14.0, life_max: 26.0, emit_radius: 10.0 * s, angle: UP, spread: 2.8, speed_min: 6.0 * s, speed_max: 14.0 * s, gravity: 0.5, drag: 0.02, collide: 1.0, spin: 0.4, spin_jitter: 1.0, material: m("rock"), size0: 1.4 * s, size1: 1.4 * s, size_jitter: 0.5, fade_in: 0.0, fade_out: 0.2, ..flat.clone() }, stops(&[(deep, 1.0)]))),
        some_if(p.ring, || layer(Spec { start: s0 + 1.0, count: 1.0, life_min: 14.0, life_max: 14.0, shape: RING, size0: 20.0 * s, size1: 180.0 * s, size_curve: 0.45, softness: 0.3, size_jitter: 0.0, alpha: 0.35, fade_in: 0.0, fade_out: 0.7, ..flat.clone() }, stops(&[(light, 1.0)]))),
    ]
}

fn blast_pixel(b: &Blast<'_>) -> Vec<Option<Spec>> {
    let Blast { p, col, hot, low, s, d, s0, ref base, .. } = *b;
    // `{...flat, ...square}`: solid, square, fixed, no fades or size jitter.
    let square = Spec { blend: NORMAL, shape: SQUARE, rotate: ROTATE_FIXED, fade_in: 0.0, fade_out: 0.0, size_jitter: 0.0, ..base.clone() };
    let steps = stops(&[(WHITE, 1.0), ([1.0, 0.95, 0.45], 1.0), (hot, 1.0), (col, 1.0), (low, 1.0), (tone(low, 0.5, BLACK), 1.0)]);
    vec![
        some_if(p.dust, || layer(Spec { placement: Placement::Behind, start: s0 + 1.0, count: 16.0 * d, burst_jitter: 2.0, life_min: 16.0, life_max: 26.0, emit_shape: GROUND, emit_radius: 50.0 * s, speed_min: 2.0 * s, speed_max: 5.0 * s, drag: 0.08, collide: 1.0, size0: 5.0 * s, size1: 2.0 * s, ..square.clone() }, stops(&[([0.72, 0.66, 0.6], 1.0), ([0.55, 0.5, 0.46], 1.0)]))),
        some_if(p.smoke > 0.0, || layer(Spec { start: s0 + 4.0, count: 14.0 * p.smoke * d, burst_jitter: 4.0, life_min: 26.0, life_max: 40.0, emit_radius: 26.0 * s, angle: UP, spread: 1.4, speed_min: 0.6 * s, speed_max: 1.6 * s, gravity: -0.03 * s, drag: 0.04, size0: 9.0 * s, size1: 3.0 * s, ..square.clone() }, stops(&[([0.55, 0.54, 0.58], 1.0), ([0.38, 0.37, 0.42], 1.0)]))),
        some_if(p.debris > 0.0, || layer(Spec { start: s0, count: 16.0 * p.debris, burst_jitter: 1.0, life_min: 24.0, life_max: 40.0, emit_radius: 8.0 * s, angle: UP, spread: 3.0, speed_min: 5.0 * s, speed_max: 12.0 * s, gravity: 0.45, drag: 0.01, collide: 1.0, size0: 3.0 * s, size1: 3.0 * s, ..square.clone() }, stops(&[([0.45, 0.4, 0.36], 1.0)]))),
        some_if(p.fireball, || layer(Spec { start: s0, count: 40.0 * d, burst_jitter: 2.0, life_min: 14.0, life_max: 26.0, emit_radius: 10.0 * s, spread: TAU, speed_min: 2.0 * s, speed_max: 8.0 * s, drag: 0.1, gravity: 0.05, size0: 7.0 * s, size1: 2.0 * s, ..square.clone() }, steps)),
        some_if(p.sparks, || layer(Spec { start: s0, count: 30.0 * d, burst_jitter: 1.0, life_min: 10.0, life_max: 18.0, emit_radius: 6.0 * s, spread: TAU, speed_min: 9.0 * s, speed_max: 16.0 * s, drag: 0.06, gravity: 0.3, collide: 1.0, size0: 2.0 * s, size1: 2.0 * s, ..square.clone() }, steps)),
        some_if(p.ring, || layer(Spec { start: s0 + 1.0, count: 28.0, life_min: 10.0, life_max: 10.0, emit_shape: EMIT_RING, emit_radius: 14.0 * s, radial: 1.0, speed_min: 12.0 * s, speed_max: 12.0 * s, drag: 0.1, size0: 4.0 * s, size1: 2.0 * s, ..square.clone() }, stops(&[(WHITE, 1.0), (hot, 1.0)]))),
        some_if(p.flash, || layer(Spec { start: s0, count: 1.0, life_min: 3.0, life_max: 3.0, size0: 34.0 * s, size1: 44.0 * s, ..square.clone() }, stops(&[(WHITE, 1.0)]))),
    ]
}

fn explosion(p: &Explosion, ctx: &Context) -> Vec<Spec> {
    let col = paint_color(&p.color);
    let style: fn(&Blast<'_>) -> Vec<Option<Spec>> = match p.style.index() {
        1 => blast_cartoon,
        2 => blast_plasma,
        3 => blast_smoke_bomb,
        4 => blast_mushroom,
        5 => blast_firework,
        6 => blast_electric,
        7 => blast_magic,
        8 => blast_dust,
        9 => blast_pixel,
        _ => blast_fireball,
    };
    let blast = Blast {
        p,
        col,
        hot: tone(col, 0.7, WHITE),
        low: tone(col, 0.45, BLACK),
        i: p.intensity,
        s: p.size,
        d: p.density,
        s0: ctx.start,
        window: ctx.window,
        multi: paint::is_gradient(&p.color),
        base: Spec { fixed: Some(ctx.start_point), blend: glow_blend(p.blend), ..Spec::default() },
    };
    style(&blast).into_iter().flatten().collect()
}

// ---------------------------------------------------------------------------
// Smoke: procedural puffs that rise, drift and billow.
// ---------------------------------------------------------------------------

struct SmokeLook {
    alpha: f64,
    rate: f64,
    size: f64,
    rise: f64,
    life: f64,
    shade: Option<f64>,
    toon: bool,
    ground: bool,
}

/// Soft, thick, steam, cartoon and ground dust (`SMOKES`).
const SMOKES: [SmokeLook; 5] = [
    SmokeLook { alpha: 0.45, rate: 1.0, size: 1.0, rise: 1.0, life: 1.0, shade: None, toon: false, ground: false },
    SmokeLook { alpha: 0.85, rate: 1.4, size: 1.2, rise: 0.8, life: 1.1, shade: None, toon: false, ground: false },
    SmokeLook { alpha: 0.16, rate: 0.6, size: 0.8, rise: 1.7, life: 0.6, shade: Some(0.35), toon: false, ground: false },
    SmokeLook { alpha: 1.0, rate: 0.7, size: 1.0, rise: 1.0, life: 0.8, shade: None, toon: true, ground: false },
    SmokeLook { alpha: 0.6, rate: 1.0, size: 1.1, rise: 0.25, life: 0.9, shade: None, toon: false, ground: true },
];

fn smoke_stops(style: usize, c: [f64; 3]) -> Ramp {
    match style {
        1 => stops(&[(tone(c, 0.15, WHITE), 1.0), (c, 1.0), (tone(c, 0.35, BLACK), 1.0)]),
        2 => stops_with(&[(tone(c, 0.6, WHITE), 1.0, 1.0), (tone(c, 0.4, WHITE), 1.0, 0.8)]),
        3 => stops(&[(tone(c, 0.25, WHITE), 1.0), (c, 1.0)]),
        4 => stops(&[(tone(c, 0.2, WHITE), 1.0), (c, 1.0)]),
        _ => stops_with(&[(tone(c, 0.2, WHITE), 1.0, 0.9), (c, 1.0, 1.0), (c, 1.0, 0.7)]),
    }
}

fn smoke(p: &Smoke, ctx: &Context) -> Vec<Spec> {
    let col = paint_color(&p.color);
    let style = (p.style.index() as usize).min(SMOKES.len() - 1);
    let look = &SMOKES[style];
    let ground = look.ground && !ctx.scene;
    let burst = p.emission == Emission::Burst;
    let size = p.size * look.size;
    let t = p.turbulence;
    let drag = 0.04;
    let rise = p.rise * look.rise;
    let life = p.life * look.life;
    vec![layer(
        Spec {
            placement: behind(p.layer == DrawLayer::Behind),
            start: ctx.start,
            emit_dur: if burst { 0.0 } else { ctx.window },
            count: if burst { p.count } else { 0.0 },
            rate: if burst { 0.0 } else { look.rate },
            rate_param: (!burst).then_some(RateParam::Amount),
            burst_jitter: if burst { 3.0 } else { 0.0 },
            life_min: (life * 0.75).max(2.0),
            life_max: (life * 1.25).max(3.0),
            world: p.space == crate::vfx::registry::Space::LeaveTrail,
            emit_shape: if ground { GROUND } else { POINT },
            emit_radius: p.spread,
            angle: UP,
            spread: if ground { 0.0 } else { 0.6 },
            speed_min: if ground { 1.0 + 0.5 * size / 24.0 } else { (rise * 0.6).max(0.0) },
            speed_max: if ground { 2.5 + size / 24.0 } else { (rise * 1.3).max(0.0) },
            // Drag settles puffs at the rise and wind speeds: constant forces over drag.
            drag,
            gravity: -rise * drag,
            wind: p.wind * drag,
            collide: if ground { 1.0 } else { 0.0 },
            curl: 16.0 * t * (size / 24.0).sqrt(),
            curl_scale: 0.3 / size.max(4.0),
            material: m(if look.toon { "cloud" } else { "smoke" }),
            rotate: if look.toon { ROTATE_FIXED } else { ROTATE_UPRIGHT },
            size_mode: if look.toon { GROW_POP } else { GROW_PUFF },
            size0: size * 0.45,
            size1: size * p.growth,
            size_jitter: 0.35,
            shade: look.shade.unwrap_or(1.0) * p.shading,
            alpha: look.alpha,
            blend: NORMAL,
            fade_in: if look.toon { 0.0 } else { 0.12 },
            fade_out: if look.toon { 0.0 } else { 0.6 },
            clip_fade_in: if ctx.timed && !burst { 6.0 } else { 0.0 },
            clip_fade_out: if ctx.timed && !burst { 10.0 } else { 0.0 },
            outline: look.toon.then(|| Outline { width: (size / 12.0).max(1.2), color: ink(col) }),
            ..Spec::default()
        },
        smoke_stops(style, col),
    )]
}

// ---------------------------------------------------------------------------
// Particles: the general emitter with every material and motion control.
// ---------------------------------------------------------------------------

/// One option of the Particles effect's "Look" (`PARTICLE_LOOKS`).
#[derive(Clone, Copy)]
struct Look {
    shape: Option<u8>,
    softness: Option<f64>,
    material: Option<&'static str>,
    solid: bool,
    rotate: Option<u8>,
    size_mode: Option<u8>,
    aspect: Option<f64>,
    frame_rate: Option<f64>,
    stretch: Option<f64>,
}

const fn look(shape: Option<u8>, softness: Option<f64>, material: Option<&'static str>, solid: bool) -> Look {
    Look { shape, softness, material, solid, rotate: None, size_mode: None, aspect: None, frame_rate: None, stretch: None }
}

const PARTICLE_LOOKS: [Look; 23] = [
    look(Some(DISC), Some(1.4), None, false),
    look(Some(STREAK), Some(0.6), None, false),
    look(Some(DISC), Some(0.12), None, false),
    look(Some(RING), Some(0.12), None, false),
    look(None, None, Some("shard"), true),
    Look { rotate: Some(ROTATE_UPRIGHT), size_mode: Some(GROW_PUFF), ..look(None, None, Some("smoke"), true) },
    look(None, None, Some("star"), false),
    Look { rotate: Some(ROTATE_FIXED), ..look(None, None, Some("bokeh"), false) },
    Look { rotate: Some(ROTATE_MOTION), aspect: Some(1.3), frame_rate: Some(3.0), ..look(None, None, Some("flame"), false) },
    Look { rotate: Some(ROTATE_FIXED), ..look(None, None, Some("cloud"), true) },
    Look { rotate: Some(ROTATE_MOTION), aspect: Some(1.3), frame_rate: Some(2.0), ..look(None, None, Some("toonFlame"), true) },
    look(None, None, Some("leaf"), true),
    look(None, None, Some("petal"), true),
    look(None, None, Some("flake"), false),
    Look { rotate: Some(ROTATE_MOTION), stretch: Some(0.4), ..look(None, None, Some("drop"), true) },
    Look { rotate: Some(ROTATE_UPRIGHT), ..look(None, None, Some("heart"), true) },
    look(None, None, Some("toonStar"), true),
    Look { rotate: Some(ROTATE_FIXED), ..look(Some(SQUARE), None, None, true) },
    Look { frame_rate: Some(1.0), ..look(None, None, Some("bolt"), false) },
    Look { rotate: Some(ROTATE_MOTION), ..look(None, None, Some("wisp"), false) },
    look(None, None, Some("rock"), true),
    look(None, None, Some("splat"), true),
    look(None, None, Some("burst"), true),
];

/// "Emit from" options (`EMITTERS`).
const EMITTERS: [u8; 4] = [POINT, EMIT_RING, BODY, LINE];
const DEG: f64 = PI / 180.0;

fn particles(p: &Particles, ctx: &Context) -> Vec<Spec> {
    let look = PARTICLE_LOOKS[(p.look.index() as usize).min(PARTICLE_LOOKS.len() - 1)];
    let v = p.variation;
    let burst = p.emission == Emission::Burst;
    let stage = ctx.scene && p.shape == EmitShape::Line && p.radius == 0.0;
    let emit_shape = if stage { STAGE } else { EMITTERS[p.shape.index() as usize] };
    let solid = look.solid || look.shape == Some(CHUNK);
    vec![layer(
        Spec {
            placement: behind(p.layer == DrawLayer::Behind),
            start: ctx.start,
            emit_dur: if burst { 0.0 } else { ctx.window },
            count: if burst { p.count } else { 0.0 },
            rate: if burst { 0.0 } else { 1.0 },
            rate_param: (!burst).then_some(RateParam::Rate),
            life_min: (p.life * (1.0 - v * 0.5)).max(1.0),
            life_max: (p.life * (1.0 + v * 0.5)).max(1.0),
            speed_min: 1.0 - v * 0.6,
            speed_max: 1.0 + v * 0.6,
            spread: p.spread * DEG,
            gravity: p.gravity,
            wind: p.wind,
            drag: p.drag,
            turb: p.turbulence,
            turb_scale: 0.015,
            shape: look.shape.unwrap_or(SPRITE),
            material: look.material.map(material),
            softness: look.softness.unwrap_or(1.0),
            stretch: if look.shape == Some(STREAK) { p.stretch } else { look.stretch.unwrap_or(0.0) },
            blend: match p.blend {
                GeneratorBlend::Glow => ADD,
                GeneratorBlend::Solid => NORMAL,
                GeneratorBlend::Auto if solid => NORMAL,
                GeneratorBlend::Auto => AUTO,
            },
            size0: 1.0,
            size1: p.end_size,
            size_jitter: v * 0.5,
            fade_in: 0.08,
            fade_out: p.fade,
            color_mode: p.color_mode.index() as f64,
            rotate: match p.rotation.index() {
                0 => look.rotate.unwrap_or(ROTATE_RANDOM),
                r => r - 1,
            },
            spin: p.spin * DEG,
            spin_jitter: v,
            aspect: look.aspect.unwrap_or(1.0),
            frame_rate: look.frame_rate.unwrap_or(0.0),
            size_mode: match p.size_mode.index() {
                0 => look.size_mode.unwrap_or(GROW_CURVE),
                s => s - 1,
            },
            orbit: p.swirl * DEG,
            curl: p.flow,
            curl_scale: 0.015,
            flicker: p.twinkle,
            shade: p.shading,
            halo: (p.glow > 0.0).then_some(Halo { scale: 2.8, alpha: 0.45 * p.glow }),
            outline: p.outline.then(|| Outline { width: p.outline_width, color: paint_color(&p.outline_color) }),
            echoes: (p.trail > 0).then_some(Echoes { count: p.trail, lag: 2.0, alpha: 0.6, size: 0.85 }),
            emit_shape,
            emit_radius: p.radius,
            collide: if p.ground { 1.0 } else { 0.0 },
            world: p.space == crate::vfx::registry::Space::LeaveTrail,
            body: emit_shape == BODY,
            burst_jitter: if burst { 2.0 } else { 0.0 },
            prewarm: if stage && !burst { 1.0 } else { 0.0 },
            keyed: true,
            ..Spec::default()
        },
        paint_ramp(&p.color, 1.0),
    )]
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
