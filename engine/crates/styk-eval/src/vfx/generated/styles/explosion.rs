//! Explosions: every layer bursts from where the target was when the effect started; the
//! style decides what the blast is made of.

use super::*;
use crate::vfx::registry::{EffectPlacement, Explosion};

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

pub(super) fn some_if(on: bool, f: impl FnOnce() -> Spec) -> Option<Spec> {
    on.then(f)
}

/// Fire's colour over life from the effect's colour `col` (or its gradient's stops): white-hot,
/// yellow, the colour, ember red, then smoke.
fn fire_ramp(p: &Explosion, col: [f64; 3]) -> Ramp {
    let ember = tone(col, 0.6, [0.5, 0.07, 0.03]);
    paint_or(
        &p.color,
        stops_with(&[
            ([1.0, 0.96, 0.78], 1.0, 1.0),
            (tone(col, 0.5, [1.0, 0.84, 0.3]), 1.0, 1.0),
            (tone(col, 0.15, [1.0, 0.75, 0.2]), 1.0, 1.0),
            (col, 1.0, 1.0),
            (tone(col, 0.5, ember), 1.0, 1.0),
            (ember, 1.0, 1.0),
            ([0.27, 0.15, 0.12], 1.0, 1.0),
            ([0.22, 0.19, 0.19], 1.0, 1.0),
        ]),
    )
}

/// Fireball: a flash and a starburst on the first frames, a shock ring, a billowing fireball
/// that glows white-hot, burns orange and red and breaks up into dark smoke; sparks with
/// trails, rocks that bounce, embers drifting up, dust along the ground. The fire is painted
/// in its colours, so it reads on a white page and covers what it is in front of; its heat
/// and the flash give off light, so it glows on a dark one.
fn blast_fireball(b: &Blast<'_>) -> Vec<Option<Spec>> {
    let Blast { p, col, i, s, d, s0, window, ref base, .. } = *b;
    let fire = fire_ramp(p, col);
    let hot = tone(col, 0.55, [1.0, 0.93, 0.62]);
    let ember = tone(col, 0.6, [0.5, 0.07, 0.03]);
    let li = i.min(1.0);
    vec![
        // Dust thrown out along the ground, behind the target.
        some_if(p.dust, || layer(Spec {
            placement: Placement::Behind, start: s0 + 2.0, count: 14.0 * d, burst_jitter: 4.0, life_min: 36.0, life_max: 60.0,
            emit_shape: GROUND, emit_radius: 60.0 * s, speed_min: 4.0 * s, speed_max: 9.0 * s, drag: 0.09, collide: 1.0,
            material: m("smoke"), rotate: ROTATE_UPRIGHT, spin: 0.01, spin_jitter: 1.0,
            size0: 22.0 * s, size_over_life: Some(Curve::three(0.5, 0.3, 1.4, 2.0)), size_jitter: 0.3,
            erosion: Some(Erosion { from: 0.02, to: 0.5, power: 1.2, edge: 0.3, ..Default::default() }),
            alpha_over_life: Some(Curve::four(0.0, 0.08, 0.7, 0.6, 0.5, 0.0)), shade: 0.7, blend: NORMAL,
            ..base.clone()
        }, stops(&[(rgb(0xa39484), 1.0), (rgb(0x8e8175), 1.0)]))),
        // Its light on everything around, while it burns.
        some_if(p.fireball, || layer(Spec {
            placement: Placement::Behind, start: s0, count: 1.0, life_min: 22.0, life_max: 22.0, softness: 1.6, size_jitter: 0.0,
            size0: 150.0 * s, size_over_life: Some(Curve::three(0.6, 0.2, 1.0, 1.1)),
            alpha_over_life: Some(Curve::three(0.0, 0.1, 0.55 * li, 0.0)), blend: ADD,
            ..base.clone()
        }, stops(&[(hot, 1.0), (col, 1.0)]))),
        // The smoke it leaves: dark, rising, curling, thinning out.
        some_if(p.smoke > 0.0, || layer(Spec {
            start: s0 + 6.0, emit_dur: 10.0f64.min(window).max(3.0), rate: 1.6 * p.smoke * d, life_min: 55.0, life_max: 90.0,
            emit_radius: 30.0 * s, spread: TAU, angle: UP, speed_min: 0.6 * s, speed_max: 1.6 * s, drag: 0.04, gravity: -0.05 * s,
            curl: 14.0 * s, curl_scale: 0.008 / s,
            material: m("smoke"), rotate: ROTATE_UPRIGHT, spin: 0.006, spin_jitter: 1.0,
            size0: 46.0 * s, size_over_life: Some(Curve::three(0.6, 0.4, 1.25, 1.7)), size_jitter: 0.3,
            erosion: Some(Erosion { from: 0.04, to: 0.55, power: 1.5, edge: 0.3, ..Default::default() }),
            alpha_over_life: Some(Curve::four(0.0, 0.15, 0.85 * p.smoke.min(1.0), 0.55, 0.65 * p.smoke.min(1.0), 0.0)),
            shade: 0.9, blend: NORMAL,
            ..base.clone()
        }, stops(&[([0.2, 0.16, 0.15], 1.0), ([0.27, 0.25, 0.25], 1.0), ([0.42, 0.41, 0.42], 1.0)]))),
        // Rocks thrown up, falling, bouncing and coming to rest.
        some_if(p.debris > 0.0, || layer(Spec {
            start: s0, count: 9.0 * p.debris, burst_jitter: 1.0, life_min: 40.0, life_max: 60.0,
            emit_radius: 10.0 * s, angle: UP, spread: 2.2, speed_min: 6.0 * s, speed_max: 12.0 * s, gravity: 0.5, drag: 0.01,
            collide: 1.0, bounce: 0.35, friction: 0.25, spin: 0.3, spin_jitter: 1.0,
            shape: ROCK, stretch: 0.0, size0: 5.5 * s, size_jitter: 0.45, alpha_over_life: Some(Curve::three(1.0, 0.85, 1.0, 0.0)),
            value_jitter: 0.2, blend: NORMAL,
            ..base.clone()
        }, stops(&[(rgb(0x4a3a30), 1.0), (rgb(0x3a2e29), 1.0)]))),
        // The fireball: big billows thrown out fast and hanging, eroding from the edge as they cool.
        some_if(p.fireball, || layer(Spec {
            start: s0, count: 16.0 * d, burst_jitter: 2.0, life_min: 20.0, life_max: 34.0,
            emit_radius: 16.0 * s, spread: TAU, speed_min: 2.5 * s, speed_max: 7.0 * s, drag: 0.2, gravity: -0.06 * s,
            curl: 8.0 * s, curl_scale: 0.01 / s,
            material: m("smoke"), spin: 0.015, spin_jitter: 1.0,
            size0: 40.0 * s, size_over_life: Some(Curve::four(0.35, 0.15, 1.0, 0.6, 1.2, 1.3)), size_jitter: 0.3,
            erosion: Some(Erosion { from: 0.0, to: 0.85, power: 2.2, edge: 0.1, rim: 0.7, rim_width: 0.18, rim_color: ember }),
            alpha_over_life: Some(Curve::three(1.0, 0.8, 1.0, 0.0)), emissive: Some(Curve::four(0.35, 0.12, 0.2, 0.35, 0.0, 0.0)),
            shade: 0.55, hue_jitter: 0.015, value_jitter: 0.06,
            ..base.clone()
        }, fire)),
        // Its white-hot heart, burning out over the first frames.
        some_if(p.fireball, || layer(Spec {
            start: s0, count: 5.0, burst_jitter: 1.0, life_min: 8.0, life_max: 12.0,
            emit_radius: 8.0 * s, spread: TAU, speed_min: 0.5 * s, speed_max: 2.0 * s, drag: 0.2,
            material: m("smoke"), spin: 0.03, spin_jitter: 1.0,
            size0: 46.0 * s, size_over_life: Some(Curve::three(0.4, 0.3, 1.0, 0.95)), size_jitter: 0.2,
            erosion: Some(Erosion { from: 0.05, to: 0.9, power: 1.3, edge: 0.08, rim: 0.9, rim_width: 0.3, rim_color: tone(col, 0.2, [1.0, 0.8, 0.25]) }),
            emissive: Some(Curve::three(0.6, 0.5, 0.35, 0.2)), shade: 0.25,
            ..base.clone()
        }, stops(&[([1.0, 0.98, 0.88], 1.0), (hot, 1.0)]))),
        // A shock ring racing out.
        some_if(p.ring, || layer(Spec {
            start: s0 + 1.0, count: 1.0, life_min: 10.0, life_max: 10.0, shape: RING, softness: 0.03, size_jitter: 0.0,
            size0: 220.0 * s, size_over_life: Some(Curve::four(0.1, 0.3, 0.7, 0.7, 0.93, 1.0)),
            alpha_over_life: Some(Curve::three(0.9 * li, 0.3, 0.55 * li, 0.0)), emissive: Some(Curve::three(0.25, 0.5, 0.5, 0.8)),
            ..base.clone()
        }, stops(&[(tone(col, 0.25, [1.0, 0.8, 0.3]), 1.0), (col, 1.0)]))),
        // The flash: a burst of light, and a starburst for the eye on any page, on the first frames.
        some_if(p.flash, || layer(Spec {
            start: s0, count: 1.0, life_min: 6.0, life_max: 6.0, softness: 1.7, size_jitter: 0.0,
            size0: 190.0 * s, size_over_life: Some(Curve::three(0.6, 0.25, 1.0, 1.1)),
            alpha_over_life: Some(Curve::three(0.95 * li, 0.3, 0.5 * li, 0.0)), blend: ADD,
            ..base.clone()
        }, stops(&[([1.0, 0.96, 0.82], 1.0), (hot, 1.0)]))),
        some_if(p.flash, || layer(Spec {
            start: s0, count: 1.0, life_min: 5.0, life_max: 5.0, shape: BURST, rotate: ROTATE_RANDOM, size_jitter: 0.0,
            size0: 70.0 * s, size_over_life: Some(Curve::three(0.5, 0.35, 1.0, 0.75)),
            alpha_over_life: Some(Curve::three(1.0, 0.6, 0.9, 0.0)), emissive: Some(Curve::three(0.25, 0.5, 0.1, 0.0)),
            ..base.clone()
        }, stops(&[([1.0, 0.95, 0.6], 1.0), (tone(col, 0.4, [1.0, 0.85, 0.35]), 1.0), (col, 1.0)]))),
        // Sparks: needles along their motion trailing ribbons, falling.
        some_if(p.sparks, || layer(Spec {
            start: s0, count: 26.0 * d, burst_jitter: 2.0, life_min: 12.0, life_max: 24.0,
            emit_radius: 10.0 * s, spread: TAU, speed_min: 10.0 * s, speed_max: 20.0 * s, drag: 0.08, gravity: 0.3, collide: 1.0, bounce: 0.3,
            shape: SPARK, rotate: ROTATE_MOTION, aspect: 2.2, stretch: 0.8, size0: 2.4 * s.sqrt(), size_over_life: Some(Curve::three(1.0, 0.6, 0.8, 0.3)),
            trail: Some(Trail { length: 4.0, segments: 4, width: 0.5, alpha: 0.6, glow: 0.7, emissive: None }),
            emissive: Some(Curve::three(0.3, 0.5, 0.2, 0.1)), alpha_over_life: Some(Curve::three(1.0, 0.7, 1.0, 0.0)),
            ..base.clone()
        }, stops(&[([1.0, 0.86, 0.4], 1.0), (tone(col, 0.2, [1.0, 0.7, 0.2]), 1.0), (col, 1.0), (ember, 1.0)]))),
        // Embers drifting up after the blast, flickering.
        some_if(p.sparks, || layer(Spec {
            start: s0 + 3.0, count: 18.0 * d, burst_jitter: 10.0, life_min: 30.0, life_max: 60.0,
            emit_radius: 34.0 * s, spread: TAU, speed_min: 0.4 * s, speed_max: 1.6 * s, drag: 0.03, gravity: -0.035 * s,
            curl: 16.0 * s, curl_scale: 0.015 / s, flicker: 0.5,
            softness: 0.0, size0: 2.2 * s.sqrt(), size_over_life: Some(Curve::three(1.0, 0.5, 0.8, 0.25)),
            emissive: Some(Curve::three(0.5, 0.5, 0.4, 0.3)), alpha_over_life: Some(Curve::four(0.0, 0.1, 1.0, 0.7, 0.8, 0.0)),
            ..base.clone()
        }, stops(&[([1.0, 0.82, 0.35], 1.0), (col, 1.0), (ember, 1.0)]))),
    ]
}

/// Cartoon: drawn like hand-drawn effects animation. A spiky white flash and action lines on the
/// first frames; a cluster of fire balls punched out fast that hang, painted in flat colour with a
/// shadow side and a bold ink line, turning from yellow to orange to red and then to smoke, each
/// shrinking away; grey smoke balls rolling up and popping out; shards and stars flung out;
/// dust clouds rolling along the ground. Few elements, strong shapes; its style brings twos.
fn blast_cartoon(b: &Blast<'_>) -> Vec<Option<Spec>> {
    let Blast { p, col, s, d, s0, ref base, .. } = *b;
    // Paint only, crisp, no fades: drawn shapes pop on and off (each shrinks, then is gone); it reads the same on any page.
    let flat = Spec { blend: AUTO, softness: 0.0, stretch: 0.0, fade_in: 0.0, fade_out: 0.0, alpha_over_life: Some(Curve::four(1.0, 0.9, 1.0, 0.97, 0.0, 0.0)), emissive: Some(Curve::three(0.0, 0.5, 0.0, 0.0)), ..base.clone() };
    let k = 1.35 * s;
    let line = ink(col);
    let line_w = (2.6 * s.sqrt()).max(1.4);
    let pale = tone(col, 0.75, [1.0, 0.98, 0.82]);
    let light = tone(col, 0.45, [1.0, 0.93, 0.55]);
    let deep = tone(col, 0.45, tone(col, 0.6, [0.55, 0.06, 0.04]));
    let shadow = |c: [f64; 3], t: f64| Cel { color: tone(c, t, tone(line, 0.4, [0.25, 0.1, 0.35])), depth: 0.32, strength: 1.0 };
    let smoke = rgb(0x8f8a96);
    // Fire balls cool to smoke: pale, yellow, the colour, deep, then smoke grey.
    let fire = paint_or(&p.color, stops(&[(pale, 1.0), (light, 1.0), (light, 1.0), (col, 1.0), (col, 1.0), (deep, 1.0), (tone(deep, 0.5, smoke), 1.0), (smoke, 1.0)]));
    let pop = |hold: f64| Curve::four(0.35, 0.12, 1.0, hold, 1.08, 0.3);
    vec![
        // Dust rolling out along the ground, behind the target.
        some_if(p.dust, || layer(Spec {
            placement: Placement::Behind, start: s0 + 2.0, count: 8.0 * d, burst_jitter: 4.0, life_min: 18.0, life_max: 28.0,
            emit_shape: GROUND, emit_radius: 30.0 * k, speed_min: 3.0 * k, speed_max: 6.5 * k, drag: 0.12, collide: 1.0,
            shape: CLOUD, rotate: ROTATE_UPRIGHT, size0: 15.0 * k, size_over_life: Some(pop(0.6)), size_jitter: 0.35,
            outline: Some(Outline { width: line_w * 0.85, color: ink(rgb(0xb7a68e)) }), cel: Some(shadow(rgb(0xd8ccb8), 0.45)),
            ..flat.clone()
        }, stops(&[(rgb(0xece4d6), 1.0), (rgb(0xd8ccb8), 1.0)]))),
        // Smoke balls left behind, rolling up, each popping out.
        some_if(p.smoke > 0.0, || layer(Spec {
            start: s0 + 7.0, count: 7.0 * p.smoke.min(2.0) * d, burst_jitter: 8.0, life_min: 30.0, life_max: 48.0,
            emit_radius: 34.0 * k, spread: 1.2, angle: UP, speed_min: 0.6 * k, speed_max: 1.6 * k, gravity: -0.05 * k, drag: 0.04,
            size0: 16.0 * k * (0.8 + 0.2 * p.smoke.min(4.0)), size_over_life: Some(pop(0.55)), size_jitter: 0.35,
            outline: Some(Outline { width: line_w * 0.85, color: tone(ink(smoke), 0.3, line) }), cel: Some(shadow(smoke, 0.5)),
            ..flat.clone()
        }, stops(&[(tone(smoke, 0.35, WHITE), 1.0), (tone(smoke, 0.2, WHITE), 1.0), (smoke, 1.0)]))),
        // Shards flung out, spinning, landing.
        some_if(p.debris > 0.0, || layer(Spec {
            start: s0, count: 7.0 * p.debris, burst_jitter: 1.0, life_min: 24.0, life_max: 40.0,
            emit_radius: 12.0 * k, angle: UP, spread: 3.4, speed_min: 7.0 * k, speed_max: 13.0 * k, gravity: 0.5, drag: 0.015,
            collide: 1.0, bounce: 0.3, friction: 0.3, spin: 0.35, spin_jitter: 1.0, shape: SHARD, size0: 5.5 * k, size_jitter: 0.45,
            alpha_over_life: Some(Curve::three(1.0, 0.85, 1.0, 0.0)), outline: Some(Outline { width: line_w * 0.6, color: line }),
            ..flat.clone()
        }, stops(&[(rgb(0x6a5a52), 1.0), (rgb(0x4d413c), 1.0)]))),
        // The fire balls: punched out fast, hanging, cooling and shrinking away.
        some_if(p.fireball, || layer(Spec {
            start: s0, count: (9.0 * d).max(3.0), burst_jitter: 1.5, life_min: 18.0, life_max: 26.0,
            emit_radius: 12.0 * k, spread: TAU, speed_min: 4.0 * k, speed_max: 8.0 * k, ease: 2.5, gravity: -0.03 * k,
            size0: 24.0 * k, size_over_life: Some(pop(0.62)), size_jitter: 0.35,
            outline: Some(Outline { width: line_w, color: line }), cel: Some(shadow(deep, 0.35)),
            ..flat.clone()
        }, fire)),
        // Its hot middle on the first frames.
        some_if(p.fireball, || layer(Spec {
            start: s0, count: 4.0, burst_jitter: 1.0, life_min: 9.0, life_max: 12.0,
            emit_radius: 10.0 * k, spread: TAU, speed_min: 1.0 * k, speed_max: 2.5 * k, ease: 2.0,
            size0: 16.0 * k, size_over_life: Some(Curve::four(0.5, 0.2, 1.0, 0.5, 0.9, 0.0)), size_jitter: 0.25,
            outline: Some(Outline { width: line_w * 0.8, color: line }), cel: Some(shadow(light, 0.25)),
            ..flat.clone()
        }, stops(&[([1.0, 1.0, 0.95], 1.0), (pale, 1.0), (light, 1.0)]))),
        // Action lines: needles punched outward on the first frames.
        some_if(p.sparks, || layer(Spec {
            start: s0, count: 10.0 * d, burst_jitter: 1.0, life_min: 6.0, life_max: 9.0,
            emit_radius: 26.0 * k, spread: TAU, radial: 1.0, speed_min: 12.0 * k, speed_max: 18.0 * k, ease: 1.5,
            shape: SPARK, rotate: ROTATE_MOTION, size0: 13.0 * k, size_over_life: Some(Curve::three(1.0, 0.5, 0.8, 0.0)), size_jitter: 0.3,
            outline: Some(Outline { width: line_w * 0.55, color: line }),
            ..flat.clone()
        }, stops(&[([1.0, 1.0, 0.95], 1.0), (pale, 1.0)]))),
        // Stars popping around it.
        some_if(p.sparks, || layer(Spec {
            start: s0 + 2.0, count: 5.0 * d, burst_jitter: 4.0, life_min: 12.0, life_max: 18.0,
            emit_radius: 46.0 * k, spread: TAU, radial: 1.0, speed_min: 1.5 * k, speed_max: 3.0 * k, drag: 0.08,
            shape: TOON_STAR, spin: 0.15, spin_jitter: 1.0, size0: 7.0 * k, size_over_life: Some(Curve::four(0.2, 0.2, 1.0, 0.7, 1.0, 0.0)),
            outline: Some(Outline { width: line_w * 0.6, color: line }), cel: Some(shadow(light, 0.3)),
            ..flat.clone()
        }, stops(&[([1.0, 0.92, 0.35], 1.0)]))),
        // A shock ring: a thin drawn circle racing out.
        some_if(p.ring, || layer(Spec {
            start: s0 + 1.0, count: 1.0, life_min: 8.0, life_max: 8.0, shape: RING, softness: 0.025, size_jitter: 0.0,
            size0: 150.0 * k, size_over_life: Some(Curve::four(0.15, 0.4, 0.75, 0.8, 0.95, 1.0)),
            alpha_over_life: Some(Curve::three(1.0, 0.6, 0.8, 0.0)),
            ..flat.clone()
        }, stops(&[(tone(col, 0.25, line), 1.0)]))),
        // The flash: a spiky star, a yellow one behind a white-hot one, held two frames and gone.
        some_if(p.flash, || layer(Spec {
            start: s0, count: 1.0, life_min: 4.0, life_max: 4.0, shape: BURST, rotate: ROTATE_RANDOM, size_jitter: 0.0,
            size0: 62.0 * k, size_over_life: Some(Curve::four(0.7, 0.3, 1.0, 0.7, 0.95, 0.6)),
            emissive: Some(Curve::three(0.15, 0.5, 0.1, 0.0)),
            ..flat.clone()
        }, stops(&[(tone(light, 0.3, col), 1.0)]))),
        some_if(p.flash, || layer(Spec {
            start: s0, count: 1.0, life_min: 3.0, life_max: 3.0, shape: BURST, rotate: ROTATE_RANDOM, size_jitter: 0.0,
            size0: 41.0 * k, size_over_life: Some(Curve::four(0.7, 0.3, 1.0, 0.7, 0.9, 0.5)),
            emissive: Some(Curve::three(0.3, 0.5, 0.2, 0.0)),
            ..flat.clone()
        }, stops(&[([1.0, 0.97, 0.72], 1.0)]))),
    ]
}

/// Mushroom cloud: a blinding flash; a fireball punched straight up that slows high above and
/// spreads into a cap, burning white-hot to orange to ember and cooling to dark smoke lit from
/// above; a stem of smoke and dust climbing into it; a surge of dust rolling out along the ground
/// with a ring racing ahead of it; stones, embers. Slow and huge after a fast start.
fn blast_mushroom(b: &Blast<'_>) -> Vec<Option<Spec>> {
    let Blast { p, col, i, s, d, s0, window, ref base, .. } = *b;
    let li = i.min(1.0);
    // Burning for the first third of its life, then dark smoke.
    let ember = tone(col, 0.6, [0.5, 0.07, 0.03]);
    let fire = paint_or(&p.color, stops(&[([1.0, 0.96, 0.8], 1.0), (col, 1.0), (ember, 1.0), (rgb(0x4a3631), 1.0), (rgb(0x3e3536), 1.0), (rgb(0x403a3a), 1.0), (rgb(0x46403f), 1.0), (rgb(0x57514f), 1.0)]));
    let hot = tone(col, 0.55, [1.0, 0.93, 0.62]);
    let dust = paint_or(&p.color, stops(&[(rgb(0xb3a596), 1.0), (rgb(0x95887c), 1.0), (rgb(0x7a7069), 1.0)]));
    // The cap rises `h` above the ground: thrown up at `h · drag` it comes to rest there.
    let h = 230.0 * s;
    let kd = 0.075;
    let burn = |from: f64, to: f64| Some(Erosion { from, to, power: 1.8, edge: 0.14, rim: 0.6, rim_width: 0.2, rim_color: ember });
    vec![
        // The surge: dust rolling out along the ground, behind the target.
        some_if(p.dust, || layer(Spec {
            placement: Placement::Behind, start: s0 + 3.0, count: 24.0 * d, burst_jitter: 6.0, life_min: 60.0, life_max: 95.0,
            emit_shape: GROUND, emit_radius: 40.0 * s, speed_min: 5.0 * s, speed_max: 12.0 * s, drag: 0.06, gravity: -0.01 * s, collide: 1.0,
            curl: 12.0 * s, curl_scale: 0.01 / s, material: m("smoke"), rotate: ROTATE_UPRIGHT,
            size0: 22.0 * s, size_over_life: Some(Curve::three(0.5, 0.3, 1.3, 2.0)), size_jitter: 0.3,
            erosion: Some(Erosion { from: 0.02, to: 0.55, power: 1.3, edge: 0.3, ..Default::default() }),
            alpha_over_life: Some(Curve::four(0.0, 0.06, 0.85, 0.6, 0.55, 0.0)), shade: 0.7, blend: NORMAL, value_jitter: 0.06,
            ..base.clone()
        }, dust.clone())),
        // A ring of dust racing out along the ground ahead of the surge.
        some_if(p.ring, || layer(Spec {
            placement: Placement::Behind, start: s0 + 1.0, count: 1.0, life_min: 22.0, life_max: 22.0, emit_shape: GROUND,
            shape: RING, softness: 0.1, aspect: 0.2, rotate: ROTATE_FIXED, size_jitter: 0.0,
            size0: 260.0 * s, size_over_life: Some(Curve::four(0.08, 0.3, 0.6, 0.8, 0.92, 1.0)),
            alpha_over_life: Some(Curve::three(0.65, 0.5, 0.4, 0.0)), blend: NORMAL,
            ..base.clone()
        }, stops(&[(rgb(0xd4c8bb), 1.0)]))),
        // The stem: smoke and dust climbing into the cap.
        some_if(p.smoke > 0.0, || layer(Spec {
            start: s0 + 2.0, emit_dur: 34.0f64.min(window.max(6.0)), rate: 2.2 * p.smoke.min(2.5) * d, life_min: 50.0, life_max: 80.0,
            emit_shape: GROUND_LAUNCH, emit_radius: 10.0 * s, angle: UP, spread: 0.1, speed_min: h * kd * 0.35, speed_max: h * kd * 0.95, drag: kd, gravity: -0.012 * s,
            curl: 8.0 * s, curl_scale: 0.012 / s, material: m("smoke"), rotate: ROTATE_UPRIGHT,
            size0: 15.0 * s, size_over_life: Some(Curve::three(0.6, 0.4, 1.0, 1.35)), size_jitter: 0.3,
            erosion: Some(Erosion { from: 0.02, to: 0.5, power: 1.4, edge: 0.3, ..Default::default() }),
            alpha_over_life: Some(Curve::four(0.0, 0.08, 0.9, 0.6, 0.65, 0.0)), shade: 0.75, blend: NORMAL,
            ..base.clone()
        }, stops(&[(rgb(0x8d7f74), 1.0), (rgb(0x6d6560), 1.0), (rgb(0x5d5856), 1.0)]))),
        // The cap: thrown up hard, hanging high above, burning out to dark smoke.
        some_if(p.fireball, || layer(Spec {
            start: s0, count: 22.0 * d, burst_jitter: 3.0, life_min: 110.0, life_max: 150.0,
            emit_shape: GROUND_LAUNCH, emit_radius: 16.0 * s, angle: UP, spread: 0.55, speed_min: h * kd * 0.85, speed_max: h * kd * 1.05, drag: kd, gravity: -0.008 * s,
            curl: 14.0 * s, curl_scale: 0.008 / s, material: m("smoke"), spin: 0.004, spin_jitter: 1.0,
            size0: 44.0 * s, size_over_life: Some(Curve::four(0.35, 0.12, 0.9, 0.5, 1.25, 1.45)), size_jitter: 0.3,
            erosion: burn(0.0, 0.62), alpha_over_life: Some(Curve::four(1.0, 0.7, 1.0, 0.85, 0.7, 0.0)),
            emissive: Some(Curve::four(0.4, 0.08, 0.25, 0.25, 0.0, 0.0)), shade: 0.6, hue_jitter: 0.015, value_jitter: 0.06,
            ..base.clone()
        }, fire.clone())),
        // Its shoulders: thrown up and out, rolling over the sides of the cap.
        some_if(p.fireball, || layer(Spec {
            start: s0 + 1.0, count: 16.0 * d, burst_jitter: 4.0, life_min: 105.0, life_max: 142.0,
            emit_shape: GROUND_LAUNCH, emit_radius: 16.0 * s, angle: UP, spread: 1.7, speed_min: h * kd * 0.65, speed_max: h * kd * 0.85, drag: kd, gravity: -0.004 * s,
            curl: 14.0 * s, curl_scale: 0.008 / s, material: m("smoke"), spin: 0.004, spin_jitter: 1.0,
            size0: 30.0 * s, size_over_life: Some(Curve::four(0.35, 0.12, 0.9, 0.5, 1.2, 1.4)), size_jitter: 0.3,
            erosion: burn(0.0, 0.62), alpha_over_life: Some(Curve::four(1.0, 0.7, 1.0, 0.85, 0.7, 0.0)),
            emissive: Some(Curve::four(0.35, 0.08, 0.2, 0.25, 0.0, 0.0)), shade: 0.6, hue_jitter: 0.015, value_jitter: 0.06,
            ..base.clone()
        }, fire)),
        // Stones thrown out, landing.
        some_if(p.debris > 0.0, || layer(Spec {
            start: s0, count: 10.0 * p.debris, burst_jitter: 2.0, life_min: 40.0, life_max: 60.0,
            emit_radius: 14.0 * s, angle: UP, spread: 2.6, speed_min: 7.0 * s, speed_max: 15.0 * s, gravity: 0.45, drag: 0.012,
            collide: 1.0, bounce: 0.3, friction: 0.25, spin: 0.3, spin_jitter: 1.0, shape: ROCK, stretch: 0.0, size0: 5.0 * s, size_jitter: 0.5,
            alpha_over_life: Some(Curve::three(1.0, 0.85, 1.0, 0.0)), value_jitter: 0.2, blend: NORMAL,
            ..base.clone()
        }, stops(&[(rgb(0x4a3a30), 1.0), (rgb(0x3a2e29), 1.0)]))),
        // Embers carried up with it, flickering.
        some_if(p.sparks, || layer(Spec {
            start: s0 + 3.0, count: 26.0 * d, burst_jitter: 14.0, life_min: 40.0, life_max: 70.0,
            emit_radius: 30.0 * s, angle: UP, spread: 1.4, speed_min: h * kd * 0.3, speed_max: h * kd * 0.9, drag: kd, gravity: -0.02 * s,
            curl: 20.0 * s, curl_scale: 0.012 / s, flicker: 0.5, softness: 0.0, rotate: ROTATE_MOTION, size0: 2.2 * s.sqrt(), size_over_life: Some(Curve::three(1.0, 0.5, 0.8, 0.25)),
            emissive: Some(Curve::three(0.5, 0.5, 0.4, 0.3)), alpha_over_life: Some(Curve::four(0.0, 0.1, 1.0, 0.7, 0.8, 0.0)),
            ..base.clone()
        }, stops(&[([1.0, 0.82, 0.35], 1.0), (col, 1.0), (ember, 1.0)]))),
        // The flash: light over everything, and a white-hot disc.
        some_if(p.flash, || layer(Spec {
            start: s0, count: 1.0, life_min: 10.0, life_max: 10.0, softness: 1.6, size_jitter: 0.0,
            size0: 260.0 * s, size_over_life: Some(Curve::three(0.6, 0.25, 1.0, 1.1)),
            alpha_over_life: Some(Curve::three(0.9 * li, 0.3, 0.45 * li, 0.0)), blend: ADD,
            ..base.clone()
        }, stops(&[([1.0, 0.97, 0.85], 1.0), (hot, 1.0)]))),
        some_if(p.flash, || layer(Spec {
            start: s0, count: 1.0, life_min: 6.0, life_max: 6.0, softness: 0.25, size_jitter: 0.0,
            size0: 34.0 * s, size_over_life: Some(Curve::three(0.6, 0.3, 1.0, 0.7)),
            alpha_over_life: Some(Curve::three(1.0, 0.6, 0.9, 0.0)), emissive: Some(Curve::three(0.6, 0.5, 0.4, 0.2)),
            ..base.clone()
        }, stops(&[([1.0, 1.0, 0.95], 1.0), (hot, 1.0)]))),
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

/// Dust: an impact in the earth, no fire. A dome of dust punched up and out that hangs and slowly
/// settles, a surge rolling out along the ground both ways, clods and stones thrown up on arcs
/// trailing dust and landing, grit raining down, a pale ring racing along the ground; then a haze
/// that rises and drifts. Earthy colours lit from above, so it reads on any page.
fn blast_dust(b: &Blast<'_>) -> Vec<Option<Spec>> {
    let Blast { p, col, s, d, s0, window, ref base, .. } = *b;
    let flat = Spec { blend: NORMAL, softness: 0.0, ..base.clone() };
    let light = tone(col, 0.3, WHITE);
    let deep = tone(col, 0.3, BLACK);
    let earth = paint_or(&p.color, stops(&[(light, 1.0), (col, 1.0), (tone(col, 0.12, BLACK), 1.0)]));
    let stone = tone(ROCK_COLOR, 0.35, deep);
    let billow = |from: f64, to: f64| Some(Erosion { from, to, power: 1.3, edge: 0.32, ..Default::default() });
    vec![
        // The surge: billows rolling out along the ground both ways, behind the target.
        some_if(p.dust, || layer(Spec {
            placement: Placement::Behind, start: s0 + 1.0, count: 16.0 * d, burst_jitter: 4.0, life_min: 40.0, life_max: 70.0,
            emit_shape: GROUND, emit_radius: 24.0 * s, speed_min: 4.0 * s, speed_max: 10.0 * s, drag: 0.08, gravity: -0.008 * s, collide: 1.0,
            curl: 10.0 * s, curl_scale: 0.012 / s, material: m("smoke"), rotate: ROTATE_UPRIGHT,
            size0: 22.0 * s, size_over_life: Some(Curve::three(0.45, 0.3, 1.2, 1.9)), size_jitter: 0.3,
            erosion: billow(0.02, 0.55), alpha_over_life: Some(Curve::four(0.0, 0.06, 0.85, 0.55, 0.6, 0.0)), shade: 0.75, value_jitter: 0.06,
            ..flat.clone()
        }, earth)),
        // The dome: dust punched up and out, hanging, swelling and settling.
        some_if(p.fireball, || layer(Spec {
            start: s0, count: 18.0 * d, burst_jitter: 2.0, life_min: 34.0, life_max: 60.0,
            emit_shape: GROUND_LAUNCH, emit_radius: 14.0 * s, angle: UP, spread: 1.5, speed_min: 6.0 * s, speed_max: 12.0 * s, ease: 2.5,
            gravity: 0.03 * s, curl: 12.0 * s, curl_scale: 0.01 / s, material: m("smoke"), rotate: ROTATE_UPRIGHT,
            size0: 40.0 * s, size_over_life: Some(Curve::three(0.4, 0.25, 1.0, 1.45)), size_jitter: 0.3,
            erosion: billow(0.0, 0.6), alpha_over_life: Some(Curve::four(0.0, 0.04, 1.0, 0.5, 0.75, 0.0)), shade: 0.7, value_jitter: 0.07,
            ..flat.clone()
        }, earth)),
        // The haze it leaves, rising and drifting.
        some_if(p.smoke > 0.0, || layer(Spec {
            start: s0 + 8.0, emit_dur: 14.0f64.min(window).max(4.0), rate: 1.0 * p.smoke * d, life_min: 50.0, life_max: 80.0,
            emit_radius: 46.0 * s, angle: UP, spread: 1.2, speed_min: 0.3 * s, speed_max: 1.0 * s, gravity: -0.012 * s, drag: 0.03,
            curl: 16.0 * s, curl_scale: 0.01 / s, material: m("smoke"), rotate: ROTATE_UPRIGHT,
            size0: 34.0 * s, size_over_life: Some(Curve::three(0.6, 0.4, 1.1, 1.5)), size_jitter: 0.3,
            erosion: billow(0.05, 0.6), alpha_over_life: Some(Curve::four(0.0, 0.2, 0.5 * p.smoke.min(1.5), 0.55, 0.35 * p.smoke.min(1.5), 0.0)), shade: 0.6,
            ..flat.clone()
        }, stops(&[(tone(light, 0.2, WHITE), 1.0), (light, 1.0)]))),
        // Clods and stones thrown up on arcs, trailing dust, landing and rolling to a stop.
        some_if(p.debris > 0.0, || layer(Spec {
            start: s0, count: 10.0 * p.debris, burst_jitter: 1.0, life_min: 36.0, life_max: 56.0,
            emit_shape: GROUND_LAUNCH, emit_radius: 12.0 * s, angle: UP, spread: 2.0, speed_min: 6.0 * s, speed_max: 12.0 * s, gravity: 0.5, drag: 0.012,
            collide: 1.0, bounce: 0.3, friction: 0.3, spin: 0.25, spin_jitter: 1.0,
            shape: ROCK, stretch: 0.0, size0: 4.5 * s, size_jitter: 0.5, value_jitter: 0.2, alpha_over_life: Some(Curve::three(1.0, 0.85, 1.0, 0.0)),
            trail: Some(Trail { length: 8.0, segments: 6, width: 1.6, alpha: 0.45, glow: 0.0, emissive: None }),
            ..flat.clone()
        }, stops(&[(stone, 1.0), (tone(stone, 0.3, BLACK), 1.0)]))),
        // Grit raining down.
        some_if(p.sparks, || layer(Spec {
            start: s0, count: 22.0 * d, burst_jitter: 2.0, life_min: 18.0, life_max: 32.0,
            emit_shape: GROUND_LAUNCH, emit_radius: 10.0 * s, angle: UP, spread: 2.0, speed_min: 5.0 * s, speed_max: 13.0 * s, gravity: 0.5, drag: 0.03,
            collide: 1.0, bounce: 0.2, spin: 0.4, spin_jitter: 1.0, shape: ROCK, stretch: 0.0, size0: 1.5 * s, size_jitter: 0.5,
            alpha_over_life: Some(Curve::three(1.0, 0.8, 1.0, 0.0)),
            ..flat.clone()
        }, stops(&[(deep, 1.0)]))),
        // A ring of dust racing out along the ground.
        some_if(p.ring, || layer(Spec {
            placement: Placement::Behind, start: s0 + 1.0, count: 1.0, life_min: 16.0, life_max: 16.0, emit_shape: GROUND,
            shape: RING, softness: 0.12, aspect: 0.22, rotate: ROTATE_FIXED, size_jitter: 0.0,
            size0: 170.0 * s, size_over_life: Some(Curve::four(0.12, 0.35, 0.7, 0.8, 0.95, 1.0)),
            alpha_over_life: Some(Curve::three(0.55, 0.5, 0.35, 0.0)),
            ..flat.clone()
        }, stops(&[(light, 1.0)]))),
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

pub(super) fn explosion(p: &Explosion, ctx: &Context) -> Vec<Spec> {
    let col = paint_color(&p.color);
    let style: fn(&Blast<'_>) -> Vec<Option<Spec>> = match p.style.index() {
        1 => blast_cartoon,
        // Retired: Plasma is drawn as Magic, Smoke bomb as Dust.
        2 | 7 => blast_magic,
        3 | 8 => blast_dust,
        4 => blast_mushroom,
        5 => blast_firework,
        6 => blast_electric,
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
    let mut out: Vec<Spec> = style(&blast).into_iter().flatten().collect();
    // Where it draws: as the style places each layer, or all behind or in front of the target.
    for l in &mut out {
        match p.layer {
            EffectPlacement::Behind => l.placement = Placement::Behind,
            EffectPlacement::InFront => l.placement = Placement::Front,
            EffectPlacement::Both => {}
        }
    }
    out
}

