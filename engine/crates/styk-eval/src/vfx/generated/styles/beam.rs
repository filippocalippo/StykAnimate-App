//! Energy beams: energy, laser, cartoon, spiral (retired into energy with strands),
//! lightning and fire breath.

use super::*;
use crate::vfx::registry::{Beam, DrawLayer};

// ---------------------------------------------------------------------------
// Beams: energy, laser, cartoon, spiral, lightning and fire breath.
// ---------------------------------------------------------------------------

/// `BEAM_STYLE`.
const BEAM_ENERGY: f64 = 0.0;
const BEAM_LASER: f64 = 1.0;
const BEAM_TOON: f64 = 2.0;
const BEAM_SPIRAL: f64 = 3.0;

pub(super) fn beam(p: &Beam, ctx: &Context) -> Vec<Spec> {
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

