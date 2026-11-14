//! Auras: each style supplies a ground effect, a body glow, main layers and particles;
//! the effect's switches choose which of them draw. Sizes, speeds and forces are in units
//! of a body 200 pixels tall, scaled at each birth by the target's size.

use super::*;
use crate::vfx::registry::{Aura, EffectPlacement};

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
    /// The effect colour's own ramp when it is a gradient.
    paint: Option<Ramp>,
    i: f64,
    s: f64,
    t: f64,
    sc: f64,
    base: Spec,
}

fn aura_fire(a: &AuraInput) -> AuraParts {
    let AuraInput { col, i, s, t, ref base, .. } = *a;
    let li = i.min(1.0);
    let heat = tone(col, 0.55, [1.0, 0.95, 0.72]);
    // Whatever the colour, fire cools through orange to ember red: the colour leads, the warm end follows.
    let orange = tone(col, 0.55, [1.0, 0.42, 0.08]);
    let ember = tone(col, 0.35, [0.62, 0.1, 0.04]);
    // Flames burn white-hot at the body, through the colour to ember red at their tips.
    let flame = a.paint.unwrap_or_else(|| stops(&[(tone(col, 0.3, [1.0, 0.92, 0.55]), 1.0), (col, 1.0), (tone(col, 0.5, orange), 1.0), (orange, 1.0), (tone(orange, 0.5, ember), 1.0), (ember, 1.0)]));
    // Tongues of flame licking up from the whole body, shrinking and breaking up as they rise.
    let tongues = Spec {
        emit_shape: BODY, emit_radius: 9.0, angle: UP, spread: 0.25, radial: 0.3, speed_min: 1.2 * s, speed_max: 2.8 * s, drag: 0.03, gravity: -0.07 * s,
        curl: 8.0 * t, curl_scale: 0.014, inherit: 0.5,
        material: m("flame"), rotate: ROTATE_MOTION, frame_rate: 2.0, aspect: 1.35,
        size_over_life: Some(Curve::four(0.55, 0.3, 1.0, 0.7, 0.75, 0.4)), size_jitter: 0.35,
        erosion: Some(Erosion { from: 0.18, to: 0.72, power: 1.4, edge: 0.04, rim: 1.0, rim_width: 0.32, rim_color: tone(orange, 0.6, ember) }),
        alpha_over_life: Some(Curve::four(0.0, 0.06, 1.0, 0.85, 1.0, 0.0)), shade: 0.9,
        emissive: Some(Curve::three(0.3, 0.5, 0.15, 0.05)), hue_jitter: 0.012, value_jitter: 0.04,
        ..base.clone()
    };
    AuraParts {
        // Heat haze and soot kicked up around the feet.
        ground: vec![layer(
            Spec {
                placement: Placement::Behind, rate: 2.0, life_min: 26.0, life_max: 44.0, emit_shape: GROUND, emit_radius: 46.0,
                speed_min: 1.0, speed_max: 2.6 * s, drag: 0.06, gravity: -0.012, collide: 1.0,
                material: m("smoke"), rotate: ROTATE_UPRIGHT, spin: 0.01, spin_jitter: 1.0,
                size0: 20.0 * s, size_over_life: Some(Curve::three(0.5, 0.4, 1.3, 1.8)),
                erosion: Some(Erosion { from: 0.05, to: 0.6, power: 1.3, edge: 0.3, ..Default::default() }),
                alpha_over_life: Some(Curve::four(0.0, 0.15, 0.45, 0.6, 0.35, 0.0)), shade: 0.8, blend: NORMAL,
                curl: 8.0 * t, curl_scale: 0.02,
                ..base.clone()
            },
            stops(&[(tone([0.42, 0.36, 0.33], 0.25, col), 1.0), ([0.5, 0.47, 0.45], 1.0)]),
        )],
        // Its light on the figure and around it.
        glow: layer(
            Spec {
                placement: Placement::Behind, rate: 4.0, life_min: 12.0, life_max: 18.0, emit_shape: BODY, emit_radius: 6.0,
                speed_min: 0.2, speed_max: 0.8, angle: UP, spread: 1.0, gravity: -0.02, softness: 1.8,
                size0: 34.0 * s, size_over_life: Some(Curve::three(0.7, 0.4, 1.0, 1.2)),
                alpha_over_life: Some(Curve::three(0.0, 0.35, 0.3 * li, 0.0)), blend: if base.blend == NORMAL { NORMAL } else { ADD },
                ..base.clone()
            },
            stops(&[(heat, 1.0), (col, 1.0)]),
        ),
        main: vec![
            // The great flames behind the figure.
            layer(Spec { placement: Placement::Behind, rate: 11.0, life_min: 16.0, life_max: 26.0, size0: 30.0 * (0.7 + 0.3 * s), ..tongues.clone() }, flame),
            // A few smaller licks in front of it.
            layer(Spec { placement: Placement::Front, rate: 1.6, life_min: 10.0, life_max: 15.0, size0: 14.0, speed_min: 1.2 * s, speed_max: 2.2 * s, emit_radius: 2.0, ..tongues.clone() }, flame),
        ],
        // Embers flying up and swirling away.
        particles: layer(
            Spec {
                rate: 3.5, life_min: 26.0, life_max: 46.0, emit_shape: BODY, emit_radius: 18.0, speed_min: 1.0, speed_max: 2.8 * s,
                angle: UP, spread: 1.0, gravity: -0.04, drag: 0.02, curl: 18.0 * t, curl_scale: 0.02, flicker: 0.5,
                shape: SPARK, rotate: ROTATE_MOTION, aspect: 1.8, size0: 1.3, size_over_life: Some(Curve::three(1.0, 0.5, 0.8, 0.2)), size_jitter: 0.5,
                emissive: Some(Curve::three(0.6, 0.5, 0.5, 0.4)), alpha_over_life: Some(Curve::four(0.0, 0.1, 1.0, 0.7, 0.85, 0.0)),
                ..base.clone()
            },
            stops(&[([1.0, 0.9, 0.55], 1.0), (heat, 1.0), (orange, 1.0), (ember, 1.0)]),
        ),
    }
}

fn aura_electric(a: &AuraInput) -> AuraParts {
    let AuraInput { col, i, s, t, sc, ref base, .. } = *a;
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
    let AuraInput { col, i, s, t, sc, ref base, .. } = *a;
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
    let AuraInput { col, i, s, t, sc, ref base, .. } = *a;
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
    let AuraInput { col, i, s, t, sc, ref base, .. } = *a;
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
    let AuraInput { col, i, s, t, sc, ref base, .. } = *a;
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
    let AuraInput { col, i, s, t, sc, ref base, .. } = *a;
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
    let AuraInput { col, i, s, t: _, sc, ref base, .. } = *a;
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
                stops(&[(ROCK_COLOR, 1.0), (tone(ROCK_COLOR, 0.3, BLACK), 1.0)]),
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

pub(super) fn aura(p: &Aura, ctx: &Context) -> Vec<Spec> {
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
    // Sizes, speeds and forces are in units of the body's size, scaled at each birth.
    let sc = 1.0;
    let base = Spec {
        body_scaled: true,
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
    let paint = paint::is_gradient(&p.color).then(|| paint_ramp(&p.color, 1.0));
    let parts = style(&AuraInput { col: paint_color(&p.color), paint, i: p.intensity, s: p.height, t: p.turbulence, sc, base });
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
    for l in &mut out {
        // Width: how far from the body the aura reaches.
        l.emit_radius *= p.width;
        // Where it draws: as the style places each layer, or all behind or in front of the figure.
        match p.layer {
            EffectPlacement::Behind => l.placement = Placement::Behind,
            EffectPlacement::InFront => l.placement = Placement::Front,
            EffectPlacement::Both => {}
        }
    }
    out
}

