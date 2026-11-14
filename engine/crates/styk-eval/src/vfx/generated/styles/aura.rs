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
    /// The effect colour: a colour or a gradient.
    color: crate::vfx::Color,
    col: [f64; 3],
    /// The effect colour's own ramp when it is a gradient.
    paint: Option<Ramp>,
    i: f64,
    s: f64,
    t: f64,
    /// Density, for layers that scale a count by it rather than follow it as a rate.
    density: f64,
    base: Spec,
}

fn aura_fire(a: &AuraInput) -> AuraParts {
    let AuraInput { col, i, s, t, ref base, .. } = *a;
    let li = i.min(1.0);
    // White-hot at the body, cooling within the colour's own hue to its embers.
    let FireTones { white_hot, heat, orange, ember, deep } = fire_tones(col);
    let light = |auto: f64| light_share(base.blend, auto);
    // Three flames inside one another, as fire is: white-hot along the body, the colour around it,
    // and an outer flame of orange cooling to deep red that gives the aura its silhouette and a
    // darker edge on a light page. A gradient runs from the heart of the fire to its edge.
    let (outer, middle, inner) = match a.paint {
        Some(_) => (gradient_part(&a.color, 0.55, 1.0), gradient_part(&a.color, 0.25, 0.75), gradient_part(&a.color, 0.0, 0.45)),
        None => (
            stops(&[(orange, 1.0), (tone(orange, 0.5, ember), 1.0), (ember, 1.0), (deep, 1.0)]),
            stops(&[(col, 1.0), (tone(col, 0.5, orange), 1.0), (orange, 1.0), (ember, 1.0)]),
            stops(&[(white_hot, 1.0), (heat, 1.0), (tone(heat, 0.5, col), 1.0), (col, 1.0)]),
        ),
    };
    // Tongues of flame born along the whole body, licking up and leaning in to a point above the head:
    // together they draw a flame the figure stands in, wider than the body.
    let tongues = tongues(a, 160.0 + 70.0 * s);
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
        // Its light: a tall glow on the figure and around it.
        glow: layer(
            Spec {
                placement: Placement::Behind, rate: 3.0, life_min: 14.0, life_max: 20.0, emit_shape: BODY, emit_radius: 4.0,
                speed_min: 0.2, speed_max: 0.6, angle: UP, spread: 0.6, gravity: -0.02, softness: 1.8, rotate: ROTATE_FIXED, aspect: 1.5,
                size0: 46.0 * s, size_over_life: Some(Curve::three(0.75, 0.4, 1.0, 1.15)), size_jitter: 0.15,
                alpha_over_life: Some(Curve::three(0.0, 0.4, 0.32 * li, 0.0)), blend: if base.blend == NORMAL { NORMAL } else { ADD },
                ..base.clone()
            },
            stops(&[(heat, 1.0), (col, 1.0)]),
        ),
        main: vec![
            // The outer flame, behind the figure: wide, reaching up past the head, cooling to deep red
            // and tearing apart at its tips.
            layer(Spec {
                placement: Placement::Behind, rate: 4.5, life_min: 16.0, life_max: 26.0, emit_radius: 36.0, squash: 0.4, radial: -0.55,
                speed_min: 2.4 * s, speed_max: 3.6 * s, gravity: -0.06 * s,
                size0: 40.0 * (0.7 + 0.3 * s), size_over_life: Some(Curve::four(0.55, 0.25, 1.0, 0.65, 0.8, 0.3)),
                erosion: Some(Erosion { from: 0.28, to: 0.85, power: 1.0, edge: 0.03, rim: 1.0, rim_width: 0.25, rim_color: deep }),
                emissive: Some(Curve::three(light(0.1), 0.5, light(0.05), 0.0)),
                ..tongues.clone()
            }, outer),
            // The flame of the colour inside it.
            layer(Spec {
                placement: Placement::Behind, rate: 4.5, life_min: 12.0, life_max: 18.0, emit_radius: 14.0, squash: 0.5, radial: -0.45,
                speed_min: 2.4 * s, speed_max: 3.8 * s, gravity: -0.06 * s,
                size0: 32.0 * (0.7 + 0.3 * s), size_over_life: Some(Curve::four(0.55, 0.25, 1.0, 0.65, 0.8, 0.3)),
                erosion: Some(Erosion { from: 0.25, to: 0.85, power: 1.0, edge: 0.04, rim: 0.7, rim_width: 0.2, rim_color: orange }),
                emissive: Some(Curve::three(light(0.25), 0.5, light(0.15), light(0.05))),
                ..tongues.clone()
            }, middle),
            // White-hot along the body.
            layer(Spec {
                placement: Placement::Behind, rate: 5.0, life_min: 7.0, life_max: 11.0, emit_radius: 4.0, squash: 0.6, radial: -0.3,
                speed_min: 2.6 * s, speed_max: 4.2 * s, gravity: -0.06 * s,
                size0: 22.0 * (0.7 + 0.3 * s), size_over_life: Some(Curve::four(0.6, 0.25, 1.0, 0.7, 0.8, 0.35)),
                erosion: Some(Erosion { from: 0.2, to: 0.8, power: 1.2, edge: 0.05, rim: 0.5, rim_width: 0.2, rim_color: col }),
                emissive: Some(Curve::three(light(0.5), 0.5, light(0.35), light(0.2))),
                ..tongues.clone()
            }, inner),
            // A few small licks in front, at the body's edges, that leave the figure readable.
            layer(Spec {
                placement: Placement::Front, rate: 0.8, life_min: 7.0, life_max: 11.0, emit_radius: 20.0, squash: 0.45, radial: -0.4,
                speed_min: 2.0 * s, speed_max: 3.2 * s, gravity: -0.06 * s,
                size0: 14.0, size_over_life: Some(Curve::four(0.5, 0.3, 1.0, 0.7, 0.7, 0.3)),
                erosion: Some(Erosion { from: 0.25, to: 0.85, power: 1.2, edge: 0.05, rim: 1.0, rim_width: 0.3, rim_color: ember }),
                alpha_over_life: Some(Curve::four(0.0, 0.1, 0.9, 0.7, 0.9, 0.0)),
                emissive: Some(Curve::three(light(0.5), 0.5, light(0.35), light(0.2))),
                ..tongues.clone()
            }, middle),
        ],
        // Embers flying up and swirling away.
        particles: layer(
            Spec {
                rate: 3.0, life_min: 26.0, life_max: 46.0, emit_shape: BODY, emit_radius: 28.0, squash: 0.5, speed_min: 1.4, speed_max: 3.4 * s,
                angle: UP, spread: 0.9, gravity: -0.04, drag: 0.02, curl: 18.0 * t, curl_scale: 0.02, flicker: 0.5,
                shape: SPARK, rotate: ROTATE_MOTION, aspect: 1.8, size0: 1.6, size_over_life: Some(Curve::three(1.0, 0.5, 0.8, 0.2)), size_jitter: 0.5,
                emissive: Some(Curve::three(light(0.6), 0.5, light(0.5), light(0.4))), alpha_over_life: Some(Curve::four(0.0, 0.1, 1.0, 0.7, 0.85, 0.0)),
                ..base.clone()
            },
            stops(&[(white_hot, 1.0), (heat, 1.0), (orange, 1.0), (ember, 1.0)]),
        ),
    }
}

fn aura_electric(a: &AuraInput) -> AuraParts {
    let AuraInput { col, i, s, t, ref base, .. } = *a;
    let li = i.min(1.0);
    let hot = tone(col, 0.75, WHITE);
    let pale = tone(col, 0.45, WHITE);
    let deep = deeper(col, 0.7);
    let light = |auto: f64| light_share(base.blend, auto);
    // Lightning crackling about the body: white-hot bolts inside a line of the colour, glowing, each
    // striking out from the body and struck again elsewhere every other frame.
    let bolts = |reach: f64, arcs: f64, thick: f64, ink: f64, placement: Placement| layer(Spec {
        placement, shape: ARC, count: (arcs * a.density).round().max(1.0) * 8.0, arc_segs: 8.0,
        emit_shape: BODY, emit_radius: 5.0, squash: 1.0, spread: 2.2, arc_reach: reach * s, arc_amp: reach * s * (0.18 + 0.08 * t),
        arc_branches: 1.6, arc_rhythm: 2.0, size0: thick, softness: 1.3 * li.max(0.3),
        outline: Some(Outline { width: ink, color: deep }),
        emissive: Some(Curve::three(light(0.3), 0.5, light(0.3), light(0.3))),
        rate_param: None,
        ..base.clone()
    }, stops(&[(hot, 1.0)]));
    AuraParts {
        // Static on the ground: sparks skittering away from the feet, and its light.
        ground: vec![layer(
            Spec {
                rate: 3.0, life_min: 6.0, life_max: 11.0, emit_shape: GROUND, emit_radius: 34.0, speed_min: 3.0, speed_max: 7.0,
                drag: 0.12, gravity: 0.3, collide: 1.0, bounce: 0.4,
                shape: SPARK, rotate: ROTATE_MOTION, aspect: 2.0, size0: 1.6, size_over_life: Some(Curve::three(1.0, 0.5, 0.8, 0.2)),
                trail: Some(Trail { length: 3.0, segments: 3, width: 0.6, alpha: 0.7, glow: 0.5, emissive: None }),
                emissive: Some(Curve::three(light(0.5), 0.5, light(0.45), light(0.4))), alpha_over_life: Some(Curve::three(1.0, 0.6, 0.9, 0.0)),
                ..base.clone()
            },
            stops(&[(hot, 1.0), (col, 1.0), (deep, 1.0)]),
        )],
        // Its cold light on the figure and around it, flickering with the strikes.
        glow: layer(
            Spec {
                placement: Placement::Behind, rate: 4.0, life_min: 6.0, life_max: 10.0, emit_shape: BODY, emit_radius: 4.0,
                speed_min: 0.1, speed_max: 0.4, spread: TAU, softness: 1.9, rotate: ROTATE_FIXED, aspect: 1.45,
                size0: 44.0 * s, size_over_life: Some(Curve::three(0.85, 0.4, 1.0, 1.1)), size_jitter: 0.15, flicker: 0.45,
                // Mostly light; a little paint, so a cold haze shows on a white page too.
                alpha_over_life: Some(Curve::three(0.0, 0.3, 0.32 * li, 0.0)), emissive: Some(Curve::three(light(0.8), 0.5, light(0.8), light(0.8))),
                ..base.clone()
            },
            stops(&[(pale, 1.0), (col, 1.0)]),
        ),
        main: vec![
            // Bolts behind the figure, reaching out of it.
            bolts(62.0, 5.0, 1.3, 1.5, Placement::Behind),
            // A few short ones crawling over it, thin enough to leave it readable.
            bolts(30.0, 2.0, 0.75, 1.1, Placement::Front),
        ],
        // Sparks spat out by the strikes, falling.
        particles: layer(
            Spec {
                rate: 4.0, life_min: 5.0, life_max: 10.0, emit_shape: BODY, emit_radius: 12.0, speed_min: 4.0, speed_max: 9.0,
                spread: TAU, gravity: 0.35, drag: 0.08,
                shape: SPARK, rotate: ROTATE_MOTION, aspect: 2.4, size0: 1.6, size_over_life: Some(Curve::three(1.0, 0.5, 0.8, 0.2)), size_jitter: 0.4,
                trail: Some(Trail { length: 3.0, segments: 3, width: 0.6, alpha: 0.7, glow: 0.5, emissive: None }),
                emissive: Some(Curve::three(light(0.55), 0.5, light(0.45), light(0.4))), alpha_over_life: Some(Curve::three(1.0, 0.6, 0.9, 0.0)),
                ..base.clone()
            },
            stops(&[(hot, 1.0), (pale, 1.0), (col, 1.0), (deep, 1.0)]),
        ),
    }
}

fn aura_shadow(a: &AuraInput) -> AuraParts {
    let AuraInput { col, i, s, t, ref base, .. } = *a;
    let li = i.min(1.0);
    let abyss = tone(col, 0.92, BLACK);
    let dark = tone(col, 0.8, BLACK);
    let dusk = tone(col, 0.5, BLACK);
    let rim = tone(col, 0.3, WHITE);
    let lit = |auto: f64| light_share(base.blend, auto);
    // Darkness rising as black flames, their torn edges lit by the colour; the colour itself burns
    // close to the body.
    let (outer, inner) = match a.paint {
        Some(_) => (gradient_part(&a.color, 0.5, 1.0), gradient_part(&a.color, 0.0, 0.5)),
        None => (stops(&[(dark, 1.0), (abyss, 1.0), (abyss, 1.0)]), stops(&[(col, 1.0), (dusk, 1.0), (dark, 1.0)])),
    };
    let tongue = Spec { curl: 12.0 * t, frame_rate: 3.0, shade: 0.6, ..tongues(a, 150.0 + 70.0 * s) };
    AuraParts {
        // Darkness pooling round the feet and creeping out along the ground.
        ground: vec![layer(
            Spec {
                placement: Placement::Behind, rate: 2.4, life_min: 30.0, life_max: 52.0, emit_shape: GROUND, emit_radius: 40.0,
                speed_min: 0.6, speed_max: 2.0, drag: 0.05, gravity: -0.004, collide: 1.0,
                material: m("smoke"), rotate: ROTATE_UPRIGHT, spin: 0.01, spin_jitter: 1.0,
                size0: 26.0 * s, size_over_life: Some(Curve::three(0.4, 0.4, 1.0, 1.4)),
                erosion: Some(Erosion { from: 0.05, to: 0.65, power: 1.3, edge: 0.25, rim: 0.6, rim_width: 0.2, rim_color: col }),
                alpha_over_life: Some(Curve::four(0.0, 0.2, 0.75, 0.6, 0.6, 0.0)), shade: 0.5,
                emissive: Some(Curve::three(lit(0.1), 0.5, lit(0.1), lit(0.1))),
                curl: 10.0 * t, curl_scale: 0.02,
                ..base.clone()
            },
            stops(&[(dark, 1.0), (abyss, 1.0)]),
        )],
        // The colour's light behind the figure, which the darkness stands out against on a dark page.
        glow: layer(
            Spec {
                placement: Placement::Behind, rate: 3.0, life_min: 14.0, life_max: 22.0, emit_shape: BODY, emit_radius: 4.0,
                speed_min: 0.2, speed_max: 0.6, angle: UP, spread: 0.6, gravity: -0.02, softness: 1.8, rotate: ROTATE_FIXED, aspect: 1.55,
                size0: 52.0 * s, size_over_life: Some(Curve::three(0.8, 0.4, 1.0, 1.1)), size_jitter: 0.15,
                alpha_over_life: Some(Curve::three(0.0, 0.4, 0.45 * li, 0.0)), blend: if base.blend == NORMAL { NORMAL } else { ADD },
                ..base.clone()
            },
            stops(&[(rim, 1.0), (col, 1.0)]),
        ),
        main: vec![
            layer(Spec {
                placement: Placement::Behind, rate: 4.5, life_min: 18.0, life_max: 28.0, emit_radius: 34.0, squash: 0.4, radial: -0.5,
                speed_min: 1.8 * s, speed_max: 2.8 * s, gravity: -0.04 * s,
                size0: 42.0 * (0.7 + 0.3 * s), size_over_life: Some(Curve::four(0.55, 0.25, 1.0, 0.65, 0.85, 0.3)),
                erosion: Some(Erosion { from: 0.25, to: 0.85, power: 1.0, edge: 0.04, rim: 0.9, rim_width: 0.14, rim_color: col }),
                emissive: Some(Curve::three(lit(0.1), 0.5, lit(0.15), lit(0.2))),
                ..tongue.clone()
            }, outer),
            layer(Spec {
                placement: Placement::Behind, rate: 3.0, life_min: 9.0, life_max: 14.0, emit_radius: 8.0, squash: 0.55, radial: -0.35,
                speed_min: 2.2 * s, speed_max: 3.4 * s, gravity: -0.05 * s,
                size0: 22.0 * (0.7 + 0.3 * s), size_over_life: Some(Curve::four(0.6, 0.25, 1.0, 0.7, 0.8, 0.35)),
                erosion: Some(Erosion { from: 0.25, to: 0.85, power: 1.0, edge: 0.05, rim: 0.8, rim_width: 0.25, rim_color: rim }),
                emissive: Some(Curve::three(lit(0.5), 0.5, lit(0.35), lit(0.2))),
                ..tongue.clone()
            }, inner),
            // A few wisps of darkness drifting across the front.
            layer(Spec {
                placement: Placement::Front, rate: 0.7, life_min: 10.0, life_max: 16.0, emit_radius: 24.0, squash: 0.45, radial: -0.4,
                speed_min: 1.6 * s, speed_max: 2.6 * s, gravity: -0.04 * s,
                size0: 13.0, size_over_life: Some(Curve::four(0.5, 0.3, 1.0, 0.7, 0.7, 0.3)),
                erosion: Some(Erosion { from: 0.3, to: 0.9, power: 1.0, edge: 0.05, rim: 1.0, rim_width: 0.3, rim_color: col }),
                alpha_over_life: Some(Curve::four(0.0, 0.15, 0.85, 0.7, 0.8, 0.0)),
                emissive: Some(Curve::three(lit(0.15), 0.5, lit(0.2), lit(0.2))),
                ..tongue.clone()
            }, outer),
        ],
        // Flecks of darkness rising and swirling, a few glinting with the colour.
        particles: layer(
            Spec {
                rate: 3.0, life_min: 26.0, life_max: 44.0, emit_shape: BODY, emit_radius: 30.0, squash: 0.5, speed_min: 0.6, speed_max: 1.8 * s,
                angle: UP, spread: 1.2, gravity: -0.025, curl: 16.0 * t, curl_scale: 0.02, flicker: 0.3,
                shape: SHARD, softness: 0.0, spin: 0.08, spin_jitter: 1.0, size0: 2.6, size_over_life: Some(Curve::three(1.0, 0.6, 0.8, 0.2)), size_jitter: 0.5,
                hue_jitter: 0.02, value_jitter: 0.3, color_mode: 1.0,
                emissive: Some(Curve::three(lit(0.15), 0.5, lit(0.2), lit(0.25))), alpha_over_life: Some(Curve::four(0.0, 0.1, 1.0, 0.7, 0.85, 0.0)),
                ..base.clone()
            },
            stops(&[(abyss, 1.0), (dark, 1.0), (abyss, 1.0), (dark, 1.0), (col, 1.0)]),
        ),
    }
}

fn aura_holy(a: &AuraInput) -> AuraParts {
    let AuraInput { col, i, s, t, ref base, .. } = *a;
    let li = i.min(1.0);
    let soft = tone(col, 0.6, WHITE);
    let gold = deeper(col, 0.85);
    let amber = deeper(col, 0.6);
    let lit = |auto: f64| light_share(base.blend, auto);
    let sheen = a.paint.unwrap_or_else(|| stops(&[(soft, 1.0), (tone(col, 0.5, gold), 1.0), (gold, 1.0)]));
    AuraParts {
        // A pool of light on the ground.
        ground: vec![layer(
            Spec {
                placement: Placement::Behind, rate: 0.6, life_min: 20.0, life_max: 26.0, emit_shape: GROUND, emit_radius: 0.0, speed_min: 0.0, speed_max: 0.0,
                rotate: ROTATE_FIXED, aspect: 0.2, softness: 1.4, size0: 70.0 * s, size_jitter: 0.1, size_over_life: Some(Curve::three(0.8, 0.5, 1.0, 1.1)),
                alpha_over_life: Some(Curve::three(0.0, 0.5, 0.5 * li, 0.0)), emissive: Some(Curve::three(lit(0.7), 0.5, lit(0.7), lit(0.7))),
                ..base.clone()
            },
            stops(&[(soft, 1.0), (col, 1.0)]),
        )],
        // The figure lit from within.
        glow: layer(
            Spec {
                placement: Placement::Behind, rate: 3.0, life_min: 16.0, life_max: 24.0, emit_shape: BODY, emit_radius: 4.0,
                speed_min: 0.1, speed_max: 0.4, angle: UP, spread: 0.6, gravity: -0.01, softness: 2.0, rotate: ROTATE_FIXED, aspect: 1.6,
                size0: 44.0 * s, size_over_life: Some(Curve::three(0.85, 0.4, 1.0, 1.1)), size_jitter: 0.12,
                alpha_over_life: Some(Curve::three(0.0, 0.4, 0.16 * li, 0.0)), blend: if base.blend == NORMAL { NORMAL } else { ADD },
                ..base.clone()
            },
            stops(&[(WHITE, 1.0), (soft, 1.0)]),
        ),
        main: vec![
            // Rays of light radiating from the figure, behind it.
            layer(Spec {
                placement: Placement::Behind, rate: 4.0, life_min: 14.0, life_max: 22.0, emit_shape: BODY, emit_radius: 6.0,
                spread: 0.2, radial: 1.0, speed_min: 3.0 * s, speed_max: 4.5 * s, drag: 0.06,
                shape: STREAK, stretch: 5.0, softness: 0.8, size0: 2.6, size_jitter: 0.4,
                alpha_over_life: Some(Curve::four(0.0, 0.2, 0.75, 0.6, 0.6, 0.0)), emissive: Some(Curve::three(lit(0.45), 0.5, lit(0.45), lit(0.45))),
                ..base.clone()
            }, stops(&[(WHITE, 1.0), (soft, 1.0), (gold, 1.0)])),
            // A gentle flame of golden light, see-through, leaning in above the head.
            layer(Spec {
                placement: Placement::Behind, rate: 4.0, life_min: 16.0, life_max: 24.0, emit_radius: 22.0, squash: 0.45, radial: -0.4,
                speed_min: 1.4 * s, speed_max: 2.2 * s, gravity: -0.03 * s, aspect: 1.8, curl: 6.0 * t,
                size0: 30.0 * (0.7 + 0.3 * s), size_over_life: Some(Curve::four(0.55, 0.3, 1.0, 0.7, 0.85, 0.35)),
                erosion: Some(Erosion { from: 0.3, to: 0.9, power: 1.0, edge: 0.06, rim: 0.9, rim_width: 0.2, rim_color: amber }),
                alpha_over_life: Some(Curve::four(0.0, 0.15, 0.7, 0.75, 0.6, 0.0)),
                emissive: Some(Curve::three(lit(0.5), 0.5, lit(0.4), lit(0.3))),
                ..tongues(a, 170.0 + 60.0 * s)
            }, sheen),
            // Feathers drifting about the figure, white in a golden line.
            layer(Spec {
                placement: Placement::Front, rate: 0.5, life_min: 40.0, life_max: 60.0, emit_shape: BODY, emit_radius: 44.0, squash: 0.6,
                angle: UP, spread: 2.2, speed_min: 0.3, speed_max: 0.8, gravity: 0.008, drag: 0.02, curl: 10.0 * t, curl_scale: 0.02,
                shape: PETAL, softness: 0.0, aspect: 2.0, size0: 5.0, size_jitter: 0.3, spin: 0.03, spin_jitter: 1.0,
                outline: Some(Outline { width: 0.45, color: gold }),
                alpha_over_life: Some(Curve::four(0.0, 0.1, 1.0, 0.8, 1.0, 0.0)), emissive: Some(Curve::three(lit(0.3), 0.5, lit(0.3), lit(0.3))),
                ..base.clone()
            }, stops(&[(WHITE, 1.0), (soft, 1.0)])),
        ],
        // Glints winking in and out about the figure.
        particles: layer(
            Spec {
                rate: 2.2, life_min: 10.0, life_max: 18.0, emit_shape: BODY, emit_radius: 36.0, squash: 0.6, speed_min: 0.1, speed_max: 0.4,
                angle: UP, spread: 1.0, gravity: -0.015, shape: SPARKLE, softness: 0.0, rotate: ROTATE_FIXED, size0: 3.6, size_jitter: 0.5, size_over_life: Some(POP),
                outline: Some(Outline { width: 0.35, color: gold }),
                alpha_over_life: Some(Curve::three(1.0, 0.7, 1.0, 0.0)), emissive: Some(Curve::three(lit(0.55), 0.5, lit(0.55), lit(0.55))),
                ..base.clone()
            },
            stops(&[(WHITE, 1.0), (soft, 1.0)]),
        ),
    }
}

fn aura_ice(a: &AuraInput) -> AuraParts {
    let AuraInput { col, i, s, t, ref base, .. } = *a;
    let li = i.min(1.0);
    let frost = tone(col, 0.65, WHITE);
    let deep = deeper(col, 0.62);
    let lit = |auto: f64| light_share(base.blend, auto);
    let mist = a.paint.unwrap_or_else(|| stops(&[(frost, 1.0), (tone(col, 0.35, WHITE), 1.0)]));
    AuraParts {
        // Crystals of ice growing up out of the ground about the feet.
        ground: vec![layer(
            Spec {
                rate: 1.4, life_min: 22.0, life_max: 34.0, emit_shape: GROUND, emit_radius: 44.0, speed_min: 0.0, speed_max: 0.0,
                shape: SHARD, softness: 0.0, rotate: ROTATE_UPRIGHT, aspect: 1.9, size0: 8.0 * s, size_jitter: 0.5,
                size_over_life: Some(Curve::three(0.0, 0.2, 1.0, 0.9)), alpha_over_life: Some(Curve::three(1.0, 0.8, 1.0, 0.0)),
                outline: Some(Outline { width: 1.0, color: deep }), emissive: Some(Curve::three(lit(0.1), 0.5, lit(0.1), lit(0.1))),
                ..base.clone()
            },
            stops(&[(frost, 1.0), (col, 1.0)]),
        )],
        glow: layer(
            Spec {
                placement: Placement::Behind, rate: 3.0, life_min: 14.0, life_max: 22.0, emit_shape: BODY, emit_radius: 4.0,
                speed_min: 0.1, speed_max: 0.4, spread: TAU, softness: 1.9, rotate: ROTATE_FIXED, aspect: 1.5,
                size0: 44.0 * s, size_over_life: Some(Curve::three(0.85, 0.4, 1.0, 1.1)), size_jitter: 0.12,
                alpha_over_life: Some(Curve::three(0.0, 0.4, 0.26 * li, 0.0)), blend: if base.blend == NORMAL { NORMAL } else { ADD },
                ..base.clone()
            },
            stops(&[(frost, 1.0), (col, 1.0)]),
        ),
        main: vec![
            // Frost mist rolling off the body and sinking, pale on top, the colour beneath.
            layer(Spec {
                placement: Placement::Behind, rate: 3.0, life_min: 30.0, life_max: 46.0, emit_shape: BODY, emit_radius: 20.0, squash: 0.6,
                angle: PI / 2.0, spread: 1.8, speed_min: 0.3, speed_max: 0.8, gravity: 0.012, drag: 0.04, curl: 10.0 * t, curl_scale: 0.018,
                material: m("smoke"), rotate: ROTATE_UPRIGHT, spin: 0.01, spin_jitter: 1.0,
                size0: 22.0 * s, size_over_life: Some(Curve::three(0.5, 0.4, 1.0, 1.5)), size_jitter: 0.3,
                erosion: Some(Erosion { from: 0.1, to: 0.7, power: 1.3, edge: 0.3, ..Default::default() }),
                alpha_over_life: Some(Curve::four(0.0, 0.2, 0.7, 0.6, 0.5, 0.0)), shade: 0.85,
                emissive: Some(Curve::three(lit(0.25), 0.5, lit(0.25), lit(0.25))),
                ..base.clone()
            }, mist),
            // Ice forming on the body, glinting: crystals that grow and melt away.
            layer(Spec {
                placement: Placement::Behind, rate: 2.2, life_min: 14.0, life_max: 22.0, emit_shape: BODY, emit_radius: 12.0, speed_min: 0.0, speed_max: 0.2,
                shape: SHARD, softness: 0.0, aspect: 1.7, size0: 6.5, size_jitter: 0.4, size_over_life: Some(Curve::three(0.0, 0.25, 1.0, 0.7)),
                outline: Some(Outline { width: 0.6, color: deep }),
                alpha_over_life: Some(Curve::three(1.0, 0.75, 1.0, 0.0)), emissive: Some(Curve::three(lit(0.3), 0.5, lit(0.3), lit(0.3))),
                ..base.clone()
            }, stops(&[(WHITE, 1.0), (frost, 1.0)])),
        ],
        // Snowflakes swirling up about the figure.
        particles: layer(
            Spec {
                rate: 2.4, life_min: 30.0, life_max: 52.0, emit_shape: BODY, emit_radius: 32.0, squash: 0.6, speed_min: 0.3, speed_max: 0.9,
                angle: UP, spread: 2.0, gravity: -0.008, curl: 12.0 * t, curl_scale: 0.02,
                shape: FLAKE, softness: 0.0, spin: 0.05, spin_jitter: 1.0, size0: 5.0, size_jitter: 0.4,
                outline: Some(Outline { width: 0.5, color: deep }),
                alpha_over_life: Some(Curve::four(0.0, 0.15, 1.0, 0.75, 1.0, 0.0)), emissive: Some(Curve::three(lit(0.3), 0.5, lit(0.3), lit(0.3))),
                ..base.clone()
            },
            stops(&[(frost, 1.0), (tone(col, 0.4, WHITE), 1.0)]),
        ),
    }
}

fn aura_wind(a: &AuraInput) -> AuraParts {
    let AuraInput { col, i, s, t, ref base, .. } = *a;
    let li = i.min(1.0);
    let pale = tone(col, 0.5, WHITE);
    let deep = deeper(col, 0.7);
    let dust = tone([0.62, 0.6, 0.55], 0.3, col);
    let swirl = 0.12 + 0.05 * t;
    let lit = |auto: f64| light_share(base.blend, auto);
    let streaks = a.paint.unwrap_or_else(|| stops(&[(col, 1.0), (tone(col, 0.5, deep), 1.0), (deep, 1.0)]));
    // Gusts spiralling round the figure and up: each a ribbon through where it has been.
    let gust = |placement: Placement, rate: f64, size: f64, length: f64, turn: f64| layer(Spec {
        placement, rate, life_min: 22.0, life_max: 32.0, emit_shape: BODY, emit_radius: 30.0, squash: 0.32,
        angle: UP, spread: 0.3, speed_min: 1.4 * s, speed_max: 2.2 * s, gravity: -0.02 * s, orbit: turn,
        softness: 0.0, size0: size, size_jitter: 0.3, size_over_life: Some(Curve::three(0.6, 0.4, 1.0, 0.5)),
        trail: Some(Trail { length, segments: 10, width: 1.0, alpha: 0.9, glow: 0.3, emissive: None }),
        alpha_over_life: Some(Curve::four(0.0, 0.15, 1.0, 0.75, 0.9, 0.0)), emissive: Some(Curve::three(lit(0.2), 0.5, lit(0.2), lit(0.2))),
        ..base.clone()
    }, streaks);
    AuraParts {
        // Dust whirled up off the ground.
        ground: vec![layer(
            Spec {
                placement: Placement::Behind, rate: 3.0, life_min: 18.0, life_max: 30.0, emit_shape: GROUND, emit_radius: 30.0,
                speed_min: 2.0, speed_max: 5.0, drag: 0.07, gravity: -0.01, collide: 1.0, orbit: swirl * 0.5,
                material: m("smoke"), rotate: ROTATE_UPRIGHT, spin: 0.02, spin_jitter: 1.0,
                size0: 16.0 * s, size_over_life: Some(Curve::three(0.4, 0.4, 1.0, 1.4)),
                erosion: Some(Erosion { from: 0.05, to: 0.65, power: 1.3, edge: 0.3, ..Default::default() }),
                alpha_over_life: Some(Curve::four(0.0, 0.15, 0.5, 0.6, 0.35, 0.0)), shade: 0.8, blend: NORMAL,
                curl: 10.0 * t, curl_scale: 0.02,
                ..base.clone()
            },
            stops(&[(dust, 1.0), (tone(dust, 0.3, WHITE), 1.0)]),
        )],
        glow: layer(
            Spec {
                placement: Placement::Behind, rate: 3.0, life_min: 12.0, life_max: 20.0, emit_shape: BODY, emit_radius: 4.0,
                speed_min: 0.1, speed_max: 0.4, spread: TAU, softness: 2.0, rotate: ROTATE_FIXED, aspect: 1.5,
                size0: 40.0 * s, size_over_life: Some(Curve::three(0.85, 0.4, 1.0, 1.1)),
                alpha_over_life: Some(Curve::three(0.0, 0.4, 0.16 * li, 0.0)), blend: if base.blend == NORMAL { NORMAL } else { ADD },
                ..base.clone()
            },
            stops(&[(pale, 1.0), (col, 1.0)]),
        ),
        main: vec![gust(Placement::Behind, 3.0, 2.2, 14.0, swirl), gust(Placement::Front, 1.2, 1.6, 11.0, swirl * 1.1)],
        // Leaves caught in it.
        particles: layer(
            Spec {
                rate: 1.6, life_min: 24.0, life_max: 40.0, emit_shape: BODY, emit_radius: 34.0, squash: 0.35, speed_min: 0.4, speed_max: 1.2,
                angle: UP, spread: 0.8, gravity: -0.03, orbit: swirl * 1.2, shape: PETAL, softness: 0.0, aspect: 1.6, spin: 0.12, spin_jitter: 1.0,
                size0: 3.6, size_jitter: 0.4, value_jitter: 0.15, hue_jitter: 0.02, blend: NORMAL,
                alpha_over_life: Some(Curve::four(0.0, 0.1, 1.0, 0.8, 1.0, 0.0)),
                ..base.clone()
            },
            stops(&[(tone([0.42, 0.66, 0.28], 0.25, col), 1.0), (tone([0.72, 0.6, 0.24], 0.25, col), 1.0)]),
        ),
    }
}

fn aura_toon(a: &AuraInput) -> AuraParts {
    let AuraInput { col, i, s, ref base, .. } = *a;
    let li = i.min(1.0);
    let light_c = tone(col, 0.55, WHITE);
    let line = ink(col);
    let flat = Spec { blend: NORMAL, ..base.clone() };
    let (outer, inner) = match a.paint {
        Some(_) => (gradient_part(&a.color, 0.5, 1.0), gradient_part(&a.color, 0.0, 0.5)),
        None => (stops(&[(col, 1.0)]), stops(&[(light_c, 1.0)])),
    };
    // Bold cartoon flames: flat shapes in an ink line, the colour outside and a lighter flame inside,
    // popping up and away; few, and drawn on twos by the style's own default.
    let flame = Spec {
        emit_shape: BODY, angle: UP, spread: 0.2, radial_above: Some(160.0 + 60.0 * s), inherit: 0.5,
        shape: FLAME, softness: 0.0, rotate: ROTATE_MOTION, size_over_life: Some(POP), size_jitter: 0.3, aspect: 1.25, fade_in: 0.0, fade_out: 0.0,
        ..flat.clone()
    };
    AuraParts {
        ground: vec![layer(
            Spec {
                rate: 1.6, life_min: 12.0, life_max: 20.0, emit_shape: GROUND, emit_radius: 36.0, speed_min: 1.2, speed_max: 2.6, drag: 0.08,
                gravity: -0.02, collide: 1.0, shape: CLOUD, softness: 0.0, rotate: ROTATE_FIXED, size_over_life: Some(POP), size0: 12.0, size_jitter: 0.4, fade_in: 0.0, fade_out: 0.0,
                outline: Some(Outline { width: 2.0, color: line }), alpha: 1.0,
                ..flat.clone()
            },
            stops(&[([0.96, 0.95, 0.93], 1.0), ([0.86, 0.85, 0.84], 1.0)]),
        )],
        glow: layer(
            Spec {
                placement: Placement::Behind, rate: 3.0, life_min: 12.0, life_max: 18.0, emit_shape: BODY, emit_radius: 4.0,
                speed_min: 0.2, speed_max: 0.6, angle: UP, spread: 0.6, softness: 1.6, rotate: ROTATE_FIXED, aspect: 1.5,
                size0: 44.0 * s, alpha_over_life: Some(Curve::three(0.0, 0.4, 0.22 * li, 0.0)), blend: if base.blend == NORMAL { NORMAL } else { ADD },
                ..base.clone()
            },
            stops(&[(light_c, 1.0), (col, 1.0)]),
        ),
        main: vec![
            layer(Spec {
                placement: Placement::Behind, rate: 4.0, life_min: 10.0, life_max: 16.0, emit_radius: 28.0, squash: 0.4, radial: -0.5,
                speed_min: 2.0 * s, speed_max: 3.2 * s, gravity: -0.06 * s, size0: 17.0 * (0.7 + 0.3 * s),
                outline: Some(Outline { width: 2.4, color: line }),
                ..flame.clone()
            }, outer),
            layer(Spec {
                placement: Placement::Behind, rate: 4.0, life_min: 8.0, life_max: 12.0, emit_radius: 8.0, squash: 0.5, radial: -0.35,
                speed_min: 2.2 * s, speed_max: 3.4 * s, gravity: -0.06 * s, size0: 10.0 * (0.7 + 0.3 * s),
                ..flame.clone()
            }, inner),
        ],
        particles: layer(
            Spec {
                rate: 1.0, life_min: 14.0, life_max: 22.0, emit_shape: BODY, emit_radius: 30.0, squash: 0.6, speed_min: 0.6, speed_max: 1.4,
                angle: UP, spread: 1.4, gravity: -0.02, shape: TOON_STAR, softness: 0.0, spin: 0.08, spin_jitter: 1.0, size_over_life: Some(POP), size0: 5.0, fade_in: 0.0, fade_out: 0.0,
                outline: Some(Outline { width: 1.5, color: line }),
                ..flat.clone()
            },
            stops(&[(tone(col, 0.75, WHITE), 1.0), (light_c, 1.0)]),
        ),
    }
}

fn aura_spirit(a: &AuraInput) -> AuraParts {
    let AuraInput { col, i, s, t, ref base, .. } = *a;
    let li = i.min(1.0);
    let hot = tone(col, 0.75, WHITE);
    let pale = tone(col, 0.4, WHITE);
    let deep = deeper(col, 0.68);
    let dust = tone([0.62, 0.58, 0.54], 0.15, col);
    let lit = |auto: f64| light_share(base.blend, auto);
    let (outer, inner) = match a.paint {
        Some(_) => (gradient_part(&a.color, 0.4, 1.0), gradient_part(&a.color, 0.0, 0.5)),
        None => (stops(&[(col, 1.0), (tone(col, 0.5, deep), 1.0), (deep, 1.0)]), stops(&[(hot, 1.0), (pale, 1.0), (col, 1.0)])),
    };
    // Energy flaring up fast and see-through, in long tongues leaning in to a point high above the head.
    let tongue = Spec { aspect: 2.3, frame_rate: 1.0, curl: 4.0 * t, flicker: 0.25, shade: 0.5, inherit: 0.6, ..tongues(a, 180.0 + 80.0 * s) };
    AuraParts {
        ground: vec![
            // The power blasts dust out along the ground.
            layer(
                Spec {
                    placement: Placement::Behind, rate: 3.0, life_min: 16.0, life_max: 28.0, emit_shape: GROUND, emit_radius: 14.0,
                    speed_min: 5.0, speed_max: 9.0, drag: 0.1, collide: 1.0, gravity: -0.01,
                    material: m("smoke"), rotate: ROTATE_UPRIGHT, spin: 0.01, spin_jitter: 1.0,
                    size0: 16.0, size_over_life: Some(Curve::three(0.4, 0.4, 1.1, 1.6)),
                    erosion: Some(Erosion { from: 0.05, to: 0.6, power: 1.3, edge: 0.3, ..Default::default() }),
                    alpha_over_life: Some(Curve::four(0.0, 0.1, 0.6, 0.6, 0.4, 0.0)), shade: 0.8, blend: NORMAL,
                    ..base.clone()
                },
                stops(&[(dust, 1.0), (tone(dust, 0.25, WHITE), 1.0)]),
            ),
            // Rocks lifted off the ground, floating up, turning.
            layer(
                Spec {
                    rate: 0.8, life_min: 40.0, life_max: 70.0, emit_shape: GROUND, emit_radius: 50.0, speed_min: 0.2, speed_max: 0.5,
                    angle: UP, spread: 0.3, gravity: -0.03, drag: 0.02, shape: ROCK, softness: 0.0, spin: 0.05, spin_jitter: 1.0,
                    size0: 3.2, size_jitter: 0.6, value_jitter: 0.2, alpha_over_life: Some(Curve::four(0.0, 0.1, 1.0, 0.8, 1.0, 0.0)), blend: NORMAL,
                    ..base.clone()
                },
                stops(&[(ROCK_COLOR, 1.0), (tone(ROCK_COLOR, 0.3, BLACK), 1.0)]),
            ),
        ],
        glow: layer(
            Spec {
                placement: Placement::Behind, rate: 3.0, life_min: 10.0, life_max: 16.0, emit_shape: BODY, emit_radius: 4.0,
                speed_min: 0.2, speed_max: 0.6, angle: UP, spread: 0.6, gravity: -0.03, softness: 1.8, rotate: ROTATE_FIXED, aspect: 1.6,
                size0: 50.0 * s, size_over_life: Some(Curve::three(0.8, 0.4, 1.0, 1.15)), size_jitter: 0.12, flicker: 0.2,
                alpha_over_life: Some(Curve::three(0.0, 0.4, 0.42 * li, 0.0)), blend: if base.blend == NORMAL { NORMAL } else { ADD },
                ..base.clone()
            },
            stops(&[(pale, 1.0), (col, 1.0)]),
        ),
        main: vec![
            layer(Spec {
                placement: Placement::Behind, rate: 5.0, life_min: 9.0, life_max: 14.0, emit_radius: 32.0, squash: 0.4, radial: -0.5,
                speed_min: 4.5 * s, speed_max: 6.5 * s, gravity: -0.1 * s,
                size0: 34.0 * (0.7 + 0.3 * s), size_over_life: Some(Curve::four(0.5, 0.25, 1.0, 0.7, 0.85, 0.3)),
                erosion: Some(Erosion { from: 0.32, to: 0.9, power: 1.0, edge: 0.04, rim: 1.0, rim_width: 0.35, rim_color: deep }),
                alpha_over_life: Some(Curve::four(0.0, 0.12, 0.85, 0.8, 0.85, 0.0)),
                emissive: Some(Curve::three(lit(0.45), 0.5, lit(0.4), lit(0.3))),
                ..tongue.clone()
            }, outer),
            layer(Spec {
                placement: Placement::Behind, rate: 6.0, life_min: 6.0, life_max: 10.0, emit_radius: 10.0, squash: 0.5, radial: -0.35,
                speed_min: 5.0 * s, speed_max: 7.5 * s, gravity: -0.1 * s,
                size0: 24.0 * (0.7 + 0.3 * s), size_over_life: Some(Curve::four(0.55, 0.25, 1.0, 0.7, 0.85, 0.35)),
                erosion: Some(Erosion { from: 0.3, to: 0.85, power: 1.0, edge: 0.05, rim: 0.7, rim_width: 0.25, rim_color: col }),
                alpha_over_life: Some(Curve::four(0.0, 0.12, 0.9, 0.8, 0.9, 0.0)),
                emissive: Some(Curve::three(lit(0.65), 0.5, lit(0.55), lit(0.45))),
                ..tongue.clone()
            }, inner),
            // Streaks racing up through it, a few in front.
            layer(Spec {
                placement: Placement::Front, rate: 2.0, life_min: 5.0, life_max: 8.0, emit_shape: BODY, emit_radius: 22.0, squash: 0.5,
                angle: UP, spread: 0.08, radial: -0.35, radial_above: Some(180.0 + 80.0 * s), speed_min: 6.0 * s, speed_max: 9.0 * s, inherit: 0.6,
                shape: STREAK, stretch: 2.0, softness: 0.6, size0: 1.5, size_over_life: Some(Curve::three(1.0, 0.5, 0.9, 0.4)), size_jitter: 0.4,
                alpha_over_life: Some(Curve::four(0.0, 0.15, 1.0, 0.7, 0.9, 0.0)),
                emissive: Some(Curve::three(lit(0.55), 0.5, lit(0.5), lit(0.45))),
                ..base.clone()
            }, stops(&[(WHITE, 1.0), (hot, 1.0), (col, 1.0)])),
        ],
        // Motes of energy shooting up and away.
        particles: layer(
            Spec {
                rate: 3.0, life_min: 14.0, life_max: 24.0, emit_shape: BODY, emit_radius: 30.0, squash: 0.5, speed_min: 3.0, speed_max: 6.0 * s,
                angle: UP, spread: 0.6, drag: 0.04, curl: 10.0 * t, curl_scale: 0.02,
                shape: DISC, softness: 0.0, size0: 1.8, size_over_life: Some(Curve::three(1.0, 0.5, 0.8, 0.2)), size_jitter: 0.5,
                trail: Some(Trail { length: 4.0, segments: 3, width: 0.8, alpha: 0.7, glow: 0.4, emissive: None }),
                emissive: Some(Curve::three(lit(0.5), 0.5, lit(0.45), lit(0.4))), alpha_over_life: Some(Curve::four(0.0, 0.1, 1.0, 0.7, 0.85, 0.0)),
                ..base.clone()
            },
            stops(&[(hot, 1.0), (col, 1.0), (deep, 1.0)]),
        ),
    }
}

/// The part of a gradient from `from` to `to` (0–1) as a ramp: a gradient gives each of a style's
/// nested layers its own stretch, from the heart of the effect to its edge.
fn gradient_part(color: &crate::vfx::Color, from: f64, to: f64) -> Ramp {
    let mut r = Ramp { colors: [[0.0; 4]; COLOR_STOPS], opacity: [0.0; COLOR_STOPS] };
    for k in 0..COLOR_STOPS {
        let (c, o) = paint::sample_color(color, from + (to - from) * k as f64 / (COLOR_STOPS - 1) as f64);
        r.colors[k] = [c[0] / 255.0, c[1] / 255.0, c[2] / 255.0, 1.0];
        r.opacity[k] = o;
    }
    r
}

/// Tongues of an aura born along the whole body and leaning in to a point `apex` above the target's
/// lowest point: the template an aura's flame layers are made from (each sets its rate, life, reach,
/// speed, size, erosion and light).
fn tongues(a: &AuraInput, apex: f64) -> Spec {
    Spec {
        emit_shape: BODY, angle: UP, spread: 0.18, radial_above: Some(apex), drag: 0.02,
        curl: 8.0 * a.t, curl_scale: 0.012, inherit: 0.5,
        material: m("flame"), rotate: ROTATE_MOTION, frame_rate: 2.0, aspect: 1.6,
        size_jitter: 0.35, shade: 0.9, hue_jitter: 0.012, value_jitter: 0.05,
        alpha_over_life: Some(Curve::four(0.0, 0.14, 1.0, 0.8, 1.0, 0.0)),
        ..a.base.clone()
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
    // Sizes, speeds and forces are in units of the body's size, scaled at each birth (`body_scaled`).
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
    let parts = style(&AuraInput { color: p.color.clone(), col: paint_color(&p.color), paint, i: p.intensity, s: p.height, t: p.turbulence, density: p.density, base });
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
        l.arc_reach *= p.width;
        // Where it draws: as the style places each layer, or all behind or in front of the figure.
        match p.layer {
            EffectPlacement::Behind => l.placement = Placement::Behind,
            EffectPlacement::InFront => l.placement = Placement::Front,
            EffectPlacement::Both => {}
        }
    }
    out
}

