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
            shape: ROCK, size0: 5.5 * s, size_jitter: 0.45, alpha_over_life: Some(Curve::three(1.0, 0.85, 1.0, 0.0)),
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
        some_if(p.debris > 0.0, || layer(Spec { start: s0, count: 20.0 * p.debris, burst_jitter: 2.0, life_min: 34.0, life_max: 56.0, emit_radius: 14.0 * s, angle: UP, spread: 2.8, speed_min: 6.0 * s, speed_max: 15.0 * s, gravity: 0.45, drag: 0.012, collide: 1.0, spin: 0.3, spin_jitter: 1.0, material: m("rock"), size0: 5.0 * s, size1: 5.0 * s, size_jitter: 0.6, fade_in: 0.0, fade_out: 0.15, ..flat.clone() }, stops(&[(ROCK_COLOR, 1.0), (tone(ROCK_COLOR, 0.3, BLACK), 1.0)]))),
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
        some_if(p.debris > 0.0, || layer(Spec { start: s0, count: 18.0 * p.debris, burst_jitter: 1.0, life_min: 24.0, life_max: 40.0, emit_radius: 14.0 * s, angle: UP, spread: 2.6, speed_min: 4.0 * s, speed_max: 10.0 * s, gravity: 0.45, drag: 0.012, collide: 1.0, spin: 0.3, spin_jitter: 1.0, material: m("rock"), size0: 3.5 * s, size1: 3.5 * s, size_jitter: 0.6, fade_in: 0.0, fade_out: 0.15, ..flat.clone() }, stops(&[(tone(ROCK_COLOR, 0.3, col), 1.0), (tone(ROCK_COLOR, 0.3, BLACK), 1.0)]))),
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

