//! Energy beams: energy (spiral, retired, is energy with strands), laser, cartoon,
//! lightning and fire breath.

use super::*;
use crate::vfx::registry::{Beam, BeamStyle, DrawLayer, Prefill};

/// Energy: motes of energy drawn in from all around gather into an orb in the hand; the beam
/// fires with a white-hot core, a body of the colour and a glow, a swelling head racing to the
/// aim, energy streaking along it and lightning crawling round it (spiral strands when asked);
/// where it lands, a flare, light and sparks thrown back. Its core and glow are light (they
/// glow on a dark page); its body and sparks paint the colour, so it reads on a white one.
fn energy(p: &Beam, ctx: &Context, strands: bool, firing_at_once: bool) -> Vec<Spec> {
    let i = p.intensity;
    let li = i.min(1.0);
    let w = p.width;
    let wr = w / 16.0;
    let r = wr.sqrt();
    let charge = if firing_at_once { 0.0 } else { paint::js_round(p.charge) };
    let (core_c, col, deep) = beam_colors(p);
    let pale = tone(col, 0.55, WHITE);
    let fire_start = ctx.start + charge;
    let fire_end = ctx.end;
    let grow = if firing_at_once { 1.0 } else { p.travel.max(1.0) };
    let firing = (fire_end - fire_start).max(1.0);
    let fade = if ctx.fade_out != 0.0 && !ctx.fade_out.is_nan() { ctx.fade_out } else { 8.0 };
    let blend = glow_blend(p.blend);
    // How much light each part gives off: Glow is all light, Solid all paint, Auto the style's mix.
    let light = |auto: f64| light_share(blend, auto);
    let base = Spec {
        blend,
        beam_w: w,
        wobble: 0.15 * p.wobble,
        grow,
        fire_start,
        fire_end,
        fade_frames: if ctx.timed { 12.0f64.min(fade).max(4.0) } else { 1.0 },
        arc_amp: (10.0 * p.wobble + 5.0) * r.max(0.6),
        placement: behind(p.layer == DrawLayer::Behind),
        ..Spec::default()
    };
    let light_layer = if blend == NORMAL { NORMAL } else { ADD };
    // Charging: motes of energy streak in from all around and gather into the orb...
    let gathering = (p.charge_particles && charge > 0.0).then(|| layer(Spec {
        start: ctx.start, emit_dur: (charge - 2.0).max(1.0), rate: 7.0, life_min: 9.0, life_max: 13.0,
        emit_shape: EMIT_RING, emit_radius: 78.0 * r, radial: -1.0, speed_min: 3.5 * r, speed_max: 5.5 * r, attract: 0.8,
        shape: SPARK, rotate: ROTATE_MOTION, aspect: 2.6, size0: 2.4 * r.sqrt(), size_over_life: Some(Curve::three(0.5, 0.5, 1.0, 0.7)), size_jitter: 0.3,
        trail: Some(Trail { length: 6.0, segments: 5, width: 0.6, alpha: 0.85, glow: 0.4, emissive: None }),
        emissive: Some(Curve::three(light(0.1), 0.6, light(0.25), light(0.5))), alpha_over_life: Some(Curve::four(0.0, 0.2, 1.0, 0.85, 1.0, 0.0)),
        ..base.clone()
    }, stops(&[(deep, 1.0), (col, 1.0), (tone(col, 0.3, WHITE), 1.0)])));
    // ...and rings of it close in on the hand.
    let closing = (p.charge_particles && charge > 2.0).then(|| layer(Spec {
        start: ctx.start, emit_dur: (charge - 2.0).max(1.0), rate: 0.3, life_min: 7.0, life_max: 7.0,
        shape: RING, softness: 0.09, size_jitter: 0.0, size0: 64.0 * r, size_over_life: Some(Curve::three(1.0, 0.6, 0.4, 0.12)),
        alpha_over_life: Some(Curve::three(0.0, 0.55, 1.0, 0.0)), emissive: Some(Curve::three(light(0.15), 0.5, light(0.3), light(0.5))),
        ..base.clone()
    }, stops(&[(deep, 1.0), (col, 1.0)])));
    // The orb in the hand: a white-hot heart in a ball of the colour with a deep rim, swelling as it
    // charges, and its light.
    let orb = |size: f64, softness: f64, ramp: Ramp, emissive: f64, alpha: f64, blend: u8| layer(Spec {
        start: ctx.start, emit_dur: (fire_end - ctx.start).max(1.0), rate: 1.0, life_min: 6.0, life_max: 8.0, emit_radius: 0.6 * r,
        softness, size0: size, size_over_life: Some(Curve::three(0.88, 0.5, 1.0, 0.92)), size_jitter: 0.1,
        alpha_over_life: Some(Curve::three(0.0, 0.2, alpha, 0.0)),
        clip_fade_in: charge.max(1.0), clip_fade_out: if ctx.timed { 8.0 } else { 0.0 },
        blend, emissive: Some(Curve::three(emissive, 0.5, emissive, emissive)),
        ..base.clone()
    }, ramp);
    let beam = layer(Spec {
        shape: BEAM, count: 1.0, start: fire_start,
        beam_look: Some(BeamLook {
            core: [core_c[0], core_c[1], core_c[2], light(0.5)],
            body: [col[0], col[1], col[2], light(0.15)],
            // Its light outshines it on a dark page; at more than full intensity, more of it.
            glow: [col[0] * i, col[1] * i, col[2] * i, if blend == NORMAL { 0.0 } else { light(0.85) }],
            rim: [deep[0], deep[1], deep[2], light(0.0)],
            head: 1.0,
            strands,
            ink: None,
        }),
        ..base.clone()
    }, stops(&[(WHITE, 1.0), (col, 1.0)]));
    // As it fires: a flash and a ring at the hand.
    let muzzle = layer(Spec {
        start: fire_start, count: 1.0, life_min: 6.0, life_max: 6.0, shape: BURST, softness: 0.0, rotate: ROTATE_RANDOM, size_jitter: 0.0,
        size0: 30.0 * r, size_over_life: Some(Curve::three(0.5, 0.3, 1.0, 0.8)),
        alpha_over_life: Some(Curve::three(1.0, 0.5, 0.9, 0.0)), emissive: Some(Curve::three(light(0.4), 0.5, light(0.3), light(0.2))),
        ..base.clone()
    }, stops(&[(core_c, 1.0), (pale, 1.0), (col, 1.0)]));
    let recoil = layer(Spec {
        start: fire_start, count: 1.0, life_min: 9.0, life_max: 9.0, shape: RING, softness: 0.05, size_jitter: 0.0,
        size0: 70.0 * r, size_over_life: Some(Curve::three(0.12, 0.35, 0.75, 1.0)),
        alpha_over_life: Some(Curve::three(0.9, 0.4, 0.6, 0.0)), emissive: Some(Curve::three(light(0.3), 0.5, light(0.5), light(0.7))),
        ..base.clone()
    }, stops(&[(pale, 1.0), (col, 1.0), (deep, 1.0)]));
    let lightning = (p.arcs > 0).then(|| layer(Spec {
        shape: ARC, count: p.arcs as f64 * 16.0, arc_segs: 16.0, start: fire_start, arc_branches: 1.2, arc_rhythm: 2.0,
        size0: 0.8 * r, softness: 1.0 * li.max(0.3), outline: Some(Outline { width: 0.8 * r, color: deep }),
        emissive: Some(Curve::three(light(0.35), 0.5, light(0.35), light(0.35))),
        ..base.clone()
    }, stops(&[(tone(col, 0.6, WHITE), 1.0)])));
    let along = (p.sparks > 0.0).then(|| layer(Spec {
        start: fire_start, emit_dur: firing, rate: 6.0 * p.sparks, life_min: 8.0, life_max: 14.0,
        emit_shape: BEAM_LINE, emit_radius: 8.0 * wr, spread: 0.5, speed_min: 4.0, speed_max: 9.0, drag: 0.05,
        shape: SPARK, rotate: ROTATE_MOTION, aspect: 2.2, size0: 1.8 * r.sqrt(), size_over_life: Some(Curve::three(1.0, 0.5, 0.8, 0.3)),
        trail: Some(Trail { length: 3.0, segments: 3, width: 0.6, alpha: 0.6, glow: 0.5, emissive: None }),
        emissive: Some(Curve::three(light(0.5), 0.5, light(0.4), light(0.3))), alpha_over_life: Some(Curve::three(1.0, 0.6, 0.9, 0.0)),
        ..base.clone()
    }, stops(&[(pale, 1.0), (col, 1.0), (deep, 1.0)])));
    // Where it lands: its light, a flare, rings of impact and sparks thrown back.
    let tip_light = p.splash.then(|| layer(Spec {
        start: fire_start + grow, emit_dur: (firing - grow).max(1.0), rate: 1.0, life_min: 4.0, life_max: 5.0,
        emit_shape: BEAM_TIP, emit_radius: 2.0, softness: 1.6, size0: 46.0 * r, size_over_life: Some(Curve::three(0.8, 0.5, 1.0, 1.0)),
        alpha_over_life: Some(Curve::three(0.0, 0.3, 0.55 * li, 0.0)), blend: light_layer,
        ..base.clone()
    }, stops(&[(pale, i.max(1.0)), (col, i.max(1.0))])));
    let impact = p.splash.then(|| layer(Spec {
        start: fire_start + grow - 1.0, emit_dur: (firing - grow).max(1.0), rate: 0.4, life_min: 7.0, life_max: 7.0,
        emit_shape: BEAM_TIP, shape: RING, softness: 0.07, size_jitter: 0.1, size0: 46.0 * r, size_over_life: Some(Curve::three(0.2, 0.4, 0.8, 1.0)),
        alpha_over_life: Some(Curve::three(0.9, 0.5, 0.5, 0.0)), emissive: Some(Curve::three(light(0.3), 0.5, light(0.5), light(0.7))),
        ..base.clone()
    }, stops(&[(pale, 1.0), (col, 1.0), (deep, 1.0)])));
    let flare = p.splash.then(|| layer(Spec {
        start: fire_start + grow, emit_dur: (firing - grow).max(1.0), rate: 1.3, life_min: 4.0, life_max: 6.0,
        emit_shape: BEAM_TIP, emit_radius: 2.0, shape: SPARKLE, softness: 0.0, spin: 0.08, spin_jitter: 1.0,
        size0: 26.0 * r, size_over_life: Some(Curve::three(0.6, 0.35, 1.0, 0.7)),
        emissive: Some(Curve::three(light(0.55), 0.5, light(0.5), light(0.5))), alpha_over_life: Some(Curve::three(1.0, 0.5, 0.9, 0.0)),
        ..base.clone()
    }, stops(&[(core_c, 1.0), (pale, 1.0), (col, 1.0)])));
    let splash = (p.splash && p.sparks > 0.0).then(|| layer(Spec {
        start: fire_start + grow, emit_dur: (firing - grow - 4.0).max(1.0), rate: 9.0 * p.sparks, life_min: 8.0, life_max: 16.0,
        emit_shape: BEAM_TIP, emit_radius: 6.0 * wr, angle: std::f64::consts::PI, spread: 2.2, speed_min: 4.0, speed_max: 10.0, gravity: 0.15, drag: 0.05,
        shape: SPARK, rotate: ROTATE_MOTION, aspect: 2.0, size0: 2.0 * r.sqrt(), size_over_life: Some(Curve::three(1.0, 0.5, 0.8, 0.3)),
        trail: Some(Trail { length: 3.0, segments: 3, width: 0.6, alpha: 0.6, glow: 0.5, emissive: None }),
        emissive: Some(Curve::three(light(0.5), 0.5, light(0.4), light(0.3))), alpha_over_life: Some(Curve::three(1.0, 0.6, 0.9, 0.0)),
        ..base.clone()
    }, stops(&[(core_c, 1.0), (pale, 1.0), (col, 1.0), (deep, 1.0)])));
    let orbs = p.orb.then(|| {
        [
            orb(44.0 * wr, 1.8, stops(&[(pale, i.max(1.0)), (col, i.max(1.0))]), 1.0, 0.5 * li, light_layer),
            orb(14.0 * wr, 0.0, stops(&[(deep, 1.0)]), light(0.0), 1.0, blend),
            orb(11.5 * wr, 0.0, stops(&[(col, 1.0), (tone(col, 0.3, WHITE), 1.0)]), light(0.2), 1.0, blend),
            orb(7.5 * wr, 0.25, stops(&[(core_c, 1.0)]), light(0.4), 1.0, blend),
        ]
    });
    let (orb_glow, orb_body) = match orbs {
        Some([glow, rim, body, heart]) => (Some(glow), vec![rim, body, heart]),
        None => (None, Vec::new()),
    };
    let mut out: Vec<Spec> = [orb_glow, closing, gathering, along, Some(beam), lightning, tip_light, impact, splash, flare, Some(recoil)].into_iter().flatten().collect();
    out.extend(orb_body);
    out.push(muzzle);
    out
}

/// What every beam style starts from: its width, wobble, timing and where it draws.
fn beam_base(p: &Beam, ctx: &Context, fire_start: f64, grow: f64, wobble: f64) -> Spec {
    let fade = if ctx.fade_out != 0.0 && !ctx.fade_out.is_nan() { ctx.fade_out } else { 8.0 };
    Spec {
        blend: glow_blend(p.blend),
        beam_w: p.width,
        wobble,
        grow,
        fire_start,
        fire_end: ctx.end,
        fade_frames: if ctx.timed { 12.0f64.min(fade).max(4.0) } else { 1.0 },
        placement: behind(p.layer == DrawLayer::Behind),
        ..Spec::default()
    }
}

/// Laser: thin, straight and intense. A glint focuses at the emitter while lines of light converge on
/// it; the beam is a white-hot core in a saturated body with a deep edge; where it burns, a white-hot
/// spot, sparks spraying and a wisp of smoke.
fn laser(p: &Beam, ctx: &Context) -> Vec<Spec> {
    let i = p.intensity;
    let li = i.min(1.0);
    let r = (p.width / 6.0).sqrt();
    let (core_c, col, deep) = beam_colors(p);
    let pale = tone(col, 0.55, WHITE);
    let charge = if fires_at_once(p, ctx) { 0.0 } else { paint::js_round(p.charge) };
    let fire_start = ctx.start + charge;
    let grow = p.travel.max(1.0);
    let firing = (ctx.end - fire_start).max(1.0);
    let base = beam_base(p, ctx, fire_start, grow, 0.0);
    let blend = base.blend;
    let light = |auto: f64| light_share(blend, auto);
    let light_layer = if blend == NORMAL { NORMAL } else { ADD };
    let focus = (p.charge_particles && charge > 0.0).then(|| layer(Spec {
        start: ctx.start, emit_dur: (charge - 1.0).max(1.0), rate: 6.0, life_min: 6.0, life_max: 9.0,
        emit_shape: EMIT_RING, emit_radius: 46.0 * r, radial: -1.0, speed_min: 5.0 * r, speed_max: 7.0 * r, attract: 0.9,
        shape: SPARK, rotate: ROTATE_MOTION, aspect: 3.0, size0: 1.3 * r.sqrt(), size_over_life: Some(Curve::three(0.6, 0.5, 1.0, 0.8)),
        trail: Some(Trail { length: 5.0, segments: 4, width: 0.5, alpha: 0.8, glow: 0.3, emissive: None }),
        alpha_over_life: Some(Curve::four(0.0, 0.2, 1.0, 0.85, 1.0, 0.0)), emissive: Some(Curve::three(light(0.2), 0.5, light(0.35), light(0.5))),
        ..base.clone()
    }, stops(&[(deep, 1.0), (col, 1.0), (pale, 1.0)])));
    // The emitter: a glint that grows as it focuses and burns while it fires.
    let glint = p.orb.then(|| layer(Spec {
        start: ctx.start, emit_dur: (ctx.end - ctx.start).max(1.0), rate: 1.0, life_min: 4.0, life_max: 6.0, emit_radius: 0.5,
        softness: 0.2, size0: 3.6 * r, size_jitter: 0.25, size_over_life: Some(Curve::three(0.8, 0.4, 1.0, 0.85)), flicker: 0.25,
        clip_fade_in: charge.max(1.0), clip_fade_out: if ctx.timed { 6.0 } else { 0.0 },
        outline: Some(Outline { width: 0.9, color: deep }),
        alpha_over_life: Some(Curve::three(0.0, 0.3, 1.0, 0.0)), emissive: Some(Curve::three(light(0.55), 0.5, light(0.55), light(0.55))),
        ..base.clone()
    }, stops(&[(core_c, 1.0), (pale, 1.0)])));
    let glint_light = p.orb.then(|| layer(Spec {
        start: ctx.start, emit_dur: (ctx.end - ctx.start).max(1.0), rate: 1.0, life_min: 4.0, life_max: 5.0, emit_radius: 0.5,
        softness: 1.8, size0: 26.0 * r, clip_fade_in: charge.max(1.0), clip_fade_out: if ctx.timed { 6.0 } else { 0.0 },
        alpha_over_life: Some(Curve::three(0.0, 0.3, 0.55 * li, 0.0)), blend: light_layer,
        ..base.clone()
    }, stops(&[(pale, i.max(1.0)), (col, i.max(1.0))])));
    let beam = layer(Spec {
        shape: BEAM, count: 1.0, start: fire_start, beam_style: 1.0,
        beam_look: Some(BeamLook {
            core: [core_c[0], core_c[1], core_c[2], light(0.6)],
            body: [col[0], col[1], col[2], light(0.2)],
            glow: [col[0] * i, col[1] * i, col[2] * i, if blend == NORMAL { 0.0 } else { light(0.9) }],
            rim: [deep[0], deep[1], deep[2], light(0.0)],
            head: 0.3,
            strands: false,
            ink: None,
        }),
        ..base.clone()
    }, stops(&[(WHITE, 1.0), (col, 1.0)]));
    let along = (p.sparks > 0.0).then(|| layer(Spec {
        start: fire_start, emit_dur: firing, rate: 2.5 * p.sparks, life_min: 5.0, life_max: 9.0,
        emit_shape: BEAM_LINE, emit_radius: 3.0 * r, spread: 0.6, speed_min: 2.0, speed_max: 5.0, drag: 0.08,
        shape: SPARK, rotate: ROTATE_MOTION, aspect: 2.0, size0: 1.2, size_over_life: Some(Curve::three(1.0, 0.5, 0.8, 0.3)),
        emissive: Some(Curve::three(light(0.5), 0.5, light(0.4), light(0.3))), alpha_over_life: Some(Curve::three(1.0, 0.6, 0.9, 0.0)),
        ..base.clone()
    }, stops(&[(pale, 1.0), (col, 1.0), (deep, 1.0)])));
    // Where it burns.
    let hot_spot = p.splash.then(|| layer(Spec {
        start: fire_start + grow, emit_dur: (firing - grow).max(1.0), rate: 1.5, life_min: 3.0, life_max: 4.0, emit_shape: BEAM_TIP, emit_radius: 0.5,
        softness: 0.25, size0: 4.5 * r, size_jitter: 0.3, flicker: 0.3, outline: Some(Outline { width: 0.8, color: deep }),
        emissive: Some(Curve::three(light(0.5), 0.5, light(0.5), light(0.5))),
        ..base.clone()
    }, stops(&[(core_c, 1.0), (pale, 1.0)])));
    let tip_light = p.splash.then(|| layer(Spec {
        start: fire_start + grow, emit_dur: (firing - grow).max(1.0), rate: 1.0, life_min: 3.0, life_max: 4.0, emit_shape: BEAM_TIP, emit_radius: 1.0,
        softness: 1.7, size0: 30.0 * r, size_jitter: 0.2, flicker: 0.3,
        alpha_over_life: Some(Curve::three(0.0, 0.3, 0.6 * li, 0.0)), blend: light_layer,
        ..base.clone()
    }, stops(&[(pale, i.max(1.0)), (col, i.max(1.0))])));
    let spray = (p.splash && p.sparks > 0.0).then(|| layer(Spec {
        start: fire_start + grow, emit_dur: (firing - grow).max(1.0), rate: 10.0 * p.sparks, life_min: 6.0, life_max: 12.0,
        emit_shape: BEAM_TIP, emit_radius: 2.0, angle: std::f64::consts::PI, spread: 2.4, speed_min: 5.0, speed_max: 12.0, gravity: 0.3, drag: 0.04,
        collide: 1.0, bounce: 0.35,
        shape: SPARK, rotate: ROTATE_MOTION, aspect: 2.2, size0: 1.5, size_over_life: Some(Curve::three(1.0, 0.5, 0.8, 0.2)),
        trail: Some(Trail { length: 3.0, segments: 3, width: 0.6, alpha: 0.7, glow: 0.5, emissive: None }),
        emissive: Some(Curve::three(light(0.55), 0.5, light(0.45), light(0.35))), alpha_over_life: Some(Curve::three(1.0, 0.6, 0.9, 0.0)),
        ..base.clone()
    }, stops(&[(core_c, 1.0), (pale, 1.0), (col, 1.0), (deep, 1.0)])));
    let smoke = p.splash.then(|| layer(Spec {
        start: fire_start + grow + 2.0, emit_dur: (firing - grow - 2.0).max(1.0), rate: 1.0, life_min: 20.0, life_max: 30.0,
        emit_shape: BEAM_TIP, emit_radius: 2.0, angle: UP, spread: 0.5, speed_min: 0.5, speed_max: 1.2, gravity: -0.02, drag: 0.03, curl: 8.0, curl_scale: 0.02,
        material: m("smoke"), rotate: ROTATE_UPRIGHT, size0: 7.0, size_over_life: Some(Curve::three(0.5, 0.4, 1.0, 1.8)),
        erosion: Some(Erosion { from: 0.1, to: 0.7, power: 1.2, edge: 0.3, ..Default::default() }),
        alpha_over_life: Some(Curve::four(0.0, 0.15, 0.4, 0.6, 0.25, 0.0)), shade: 0.8, blend: NORMAL,
        ..base.clone()
    }, stops(&[([0.42, 0.4, 0.42], 1.0), ([0.55, 0.54, 0.56], 1.0)])));
    [glint_light, smoke, focus, along, Some(beam), tip_light, spray, hot_spot, glint].into_iter().flatten().collect()
}

/// Cartoon: drawn like hand-drawn effects animation, flat and bold in an ink line. An orb swells in
/// the hand, the beam bursts out in a flat body with a lighter core band, a burst pops where it lands
/// and cartoon stars fly back; drawn on twos by the style's own default.
fn toon(p: &Beam, ctx: &Context) -> Vec<Spec> {
    let wr = p.width / 22.0;
    let r = wr.sqrt();
    let col = paint_color(&p.color);
    let light_c = tone(col, 0.55, WHITE);
    let line = ink(col);
    let (core_c, body_c) = if paint::is_gradient(&p.color) {
        let at = |t: f64| paint::sample_color(&p.color, t).0.map(|v| v / 255.0);
        (at(0.0), at(1.0))
    } else {
        (light_c, col)
    };
    let charge = if fires_at_once(p, ctx) { 0.0 } else { paint::js_round(p.charge) };
    let fire_start = ctx.start + charge;
    let grow = p.travel.max(1.0);
    let firing = (ctx.end - fire_start).max(1.0);
    let base = Spec { blend: NORMAL, ..beam_base(p, ctx, fire_start, grow, 0.25 * p.wobble) };
    let line_w = (3.0 * r).max(1.5);
    let orb = p.orb.then(|| layer(Spec {
        start: ctx.start, emit_dur: (ctx.end - ctx.start).max(1.0), rate: 1.0, life_min: 4.0, life_max: 4.0, emit_radius: 0.5,
        softness: 0.0, size0: 14.0 * wr, size1: 14.0 * wr, size_mode: GROW_FLICKER, size_jitter: 0.05, clip_fade_in: charge.max(1.0), clip_fade_out: if ctx.timed { 6.0 } else { 0.0 },
        outline: Some(Outline { width: line_w, color: line }), fade_in: 0.0, fade_out: 0.0,
        ..base.clone()
    }, stops(&[(core_c, 1.0)])));
    // Charging: a few stars spun in to the hand.
    let gather = (p.charge_particles && charge > 0.0).then(|| layer(Spec {
        start: ctx.start, emit_dur: (charge - 2.0).max(1.0), rate: 1.2, life_min: 8.0, life_max: 10.0,
        emit_shape: EMIT_RING, emit_radius: 60.0 * r, radial: -1.0, speed_min: 3.0, speed_max: 4.0, attract: 0.85, orbit: 0.08,
        shape: TOON_STAR, softness: 0.0, spin: 0.2, spin_jitter: 1.0, size0: 5.0 * r, size_over_life: Some(POP), outline: Some(Outline { width: line_w * 0.6, color: line }),
        fade_in: 0.0, fade_out: 0.0,
        ..base.clone()
    }, stops(&[(light_c, 1.0)])));
    let beam = layer(Spec {
        shape: BEAM, count: 1.0, start: fire_start, beam_style: 2.0,
        beam_look: Some(BeamLook { core: [core_c[0], core_c[1], core_c[2], 0.0], body: [body_c[0], body_c[1], body_c[2], 0.0], glow: [body_c[0], body_c[1], body_c[2], 0.0], rim: [body_c[0], body_c[1], body_c[2], 0.0], head: 1.0, strands: false, ink: Some((line, line_w)) }),
        ..base.clone()
    }, stops(&[(WHITE, 1.0), (col, 1.0)]));
    let burst = |at: u8, start: f64, size: f64, rate: f64| layer(Spec {
        start, emit_dur: if at == POINT { 0.0 } else { (firing - grow).max(1.0) }, count: 1.0, rate, life_min: 5.0, life_max: 6.0,
        emit_shape: at, shape: BURST, softness: 0.0, rotate: ROTATE_RANDOM, size0: size * r, size_over_life: Some(POP), size_jitter: 0.2,
        outline: Some(Outline { width: line_w, color: line }), fade_in: 0.0, fade_out: 0.0,
        ..base.clone()
    }, stops(&[(core_c, 1.0), (body_c, 1.0)]));
    let stars = (p.splash && p.sparks > 0.0).then(|| layer(Spec {
        start: fire_start + grow, emit_dur: (firing - grow).max(1.0), rate: 1.5 * p.sparks, life_min: 10.0, life_max: 14.0,
        emit_shape: BEAM_TIP, emit_radius: 4.0, angle: std::f64::consts::PI, spread: 2.6, speed_min: 3.0, speed_max: 6.0, gravity: 0.2, drag: 0.03,
        shape: TOON_STAR, softness: 0.0, spin: 0.2, spin_jitter: 1.0, size0: 5.5 * r, size_over_life: Some(POP), outline: Some(Outline { width: line_w * 0.6, color: line }),
        fade_in: 0.0, fade_out: 0.0,
        ..base.clone()
    }, stops(&[(light_c, 1.0), (col, 1.0)])));
    let splash = p.splash.then(|| burst(BEAM_TIP, fire_start + grow, 26.0, 0.5));
    [gather, Some(beam), stars, splash, orb, Some(burst(POINT, fire_start, 22.0, 0.0))].into_iter().flatten().collect()
}

/// Fire breath: flames pour from the mouth toward the aim and reach it at the end of their life,
/// white-hot where they leave, the colour, then orange and red tongues breaking into smoke; embers fly
/// out of it.
fn breath(p: &Beam, ctx: &Context) -> Vec<Spec> {
    let w = p.width;
    let i = p.intensity;
    let li = i.min(1.0);
    let col = paint_color(&p.color);
    let FireTones { white_hot, heat, orange, ember, deep } = fire_tones(col);
    let charge = if fires_at_once(p, ctx) { 0.0 } else { paint::js_round(p.charge) };
    let fire_start = ctx.start + charge;
    let firing = (ctx.end - fire_start).max(1.0);
    let fade = if ctx.fade_out != 0.0 && !ctx.fade_out.is_nan() { ctx.fade_out } else { 8.0 };
    let blend = glow_blend(p.blend);
    let light = |auto: f64| light_share(blend, auto);
    let stream = Spec {
        placement: behind(p.layer == DrawLayer::Behind), blend, start: fire_start, emit_dur: firing, aimed: true,
        clip_fade_out: if ctx.timed { 12.0f64.min(fade).max(4.0) } else { 0.0 },
        ..Spec::default()
    };
    let flames = paint_or(&p.color, stops(&[(white_hot, 1.0), (heat, 1.0), (col, 1.0), (orange, 1.0), (ember, 1.0), (deep, 1.0)]));
    let mut out = Vec::new();
    // The light at the mouth, building while it draws breath.
    if p.orb {
        out.push(layer(Spec {
            start: ctx.start, emit_dur: (ctx.end - ctx.start).max(1.0), clip_fade_in: charge.max(1.0),
            rate: 1.0, life_min: 4.0, life_max: 5.0, emit_radius: 0.5, softness: 1.8, size0: 1.6 * w, size_jitter: 0.2, flicker: 0.3,
            alpha_over_life: Some(Curve::three(0.0, 0.3, 0.5 * li, 0.0)), aimed: false, blend: if blend == NORMAL { NORMAL } else { ADD },
            ..stream.clone()
        }, stops(&[(heat, i.max(1.0)), (col, i.max(1.0))])));
    }
    // Smoke rolling off the end of it.
    out.push(layer(Spec {
        start: fire_start + 3.0, emit_dur: (firing - 3.0).max(1.0), rate: 4.0, life_min: 24.0, life_max: 32.0, emit_radius: 0.3 * w, spread: 0.3,
        speed_min: 4.2, speed_max: 5.0, curl: 10.0 + 8.0 * p.wobble, curl_scale: 0.015, gravity: -0.05,
        material: m("smoke"), rotate: ROTATE_UPRIGHT, spin: 0.01, spin_jitter: 1.0,
        size0: 1.4 * w, size_over_life: Some(Curve::three(0.4, 0.5, 1.2, 1.8)),
        erosion: Some(Erosion { from: 0.05, to: 0.6, power: 1.3, edge: 0.3, ..Default::default() }),
        alpha_over_life: Some(Curve::four(0.0, 0.35, 0.55, 0.7, 0.4, 0.0)), shade: 0.85, blend: NORMAL,
        ..stream.clone()
    }, stops(&[([0.32, 0.28, 0.28], 1.0), ([0.45, 0.43, 0.44], 1.0)])));
    // The flames: tongues growing as they go, eroding into ragged red tips.
    out.push(layer(Spec {
        rate: 20.0, life_min: 13.0, life_max: 18.0, emit_radius: 0.2 * w, spread: 0.22, speed_min: 6.2, speed_max: 7.2,
        curl: 6.0 + 8.0 * p.wobble, curl_scale: 0.02, gravity: -0.03,
        material: m("flame"), rotate: ROTATE_MOTION, frame_rate: 2.0, aspect: 1.2, size_jitter: 0.3, hue_jitter: 0.012, value_jitter: 0.05,
        size0: 1.2 * w, size_over_life: Some(Curve::three(0.3, 0.5, 1.0, 1.4)),
        erosion: Some(Erosion { from: 0.1, to: 0.9, power: 1.2, edge: 0.04, rim: 1.0, rim_width: 0.3, rim_color: deep }),
        alpha_over_life: Some(Curve::four(0.0, 0.06, 1.0, 0.8, 1.0, 0.0)), shade: 0.8,
        emissive: Some(Curve::three(light(0.45), 0.4, light(0.15), light(0.0))),
        ..stream.clone()
    }, flames));
    // White-hot where it leaves the mouth.
    out.push(layer(Spec {
        rate: 10.0, life_min: 5.0, life_max: 8.0, emit_radius: 0.15 * w, spread: 0.16, speed_min: 6.2, speed_max: 7.2,
        material: m("flame"), rotate: ROTATE_MOTION, frame_rate: 2.0, aspect: 1.2, size_jitter: 0.25,
        size0: 0.7 * w, size_over_life: Some(Curve::three(0.4, 0.5, 1.0, 1.0)),
        erosion: Some(Erosion { from: 0.15, to: 0.8, power: 1.2, edge: 0.05, rim: 0.6, rim_width: 0.25, rim_color: col }),
        alpha_over_life: Some(Curve::four(0.0, 0.08, 1.0, 0.8, 1.0, 0.0)),
        emissive: Some(Curve::three(light(0.6), 0.5, light(0.45), light(0.3))),
        ..stream.clone()
    }, stops(&[(white_hot, 1.0), (heat, 1.0), (col, 1.0)])));
    if p.sparks > 0.0 {
        out.push(layer(Spec {
            rate: 6.0 * p.sparks, life_min: 14.0, life_max: 22.0, emit_radius: 0.2 * w, spread: 0.45, speed_min: 6.5, speed_max: 8.5,
            gravity: -0.03, curl: 12.0, curl_scale: 0.03, flicker: 0.5,
            shape: SPARK, rotate: ROTATE_MOTION, aspect: 1.8, size0: 1.6, size_over_life: Some(Curve::three(1.0, 0.5, 0.8, 0.2)),
            emissive: Some(Curve::three(light(0.6), 0.5, light(0.5), light(0.4))), alpha_over_life: Some(Curve::four(0.0, 0.1, 1.0, 0.7, 0.85, 0.0)),
            ..stream.clone()
        }, stops(&[(white_hot, 1.0), (heat, 1.0), (orange, 1.0), (ember, 1.0)])));
    }
    out
}

/// Lightning: the strike is forked bolts between the hand and the aim, white-hot inside a line of the
/// colour and glowing, struck again every other frame; sparks crackling in the hand while it charges,
/// a flash where it leaves and where it lands, a ring of impact and sparks thrown back.
fn lightning(p: &Beam, ctx: &Context) -> Vec<Spec> {
    let i = p.intensity;
    let li = i.min(1.0);
    let w = p.width;
    let r = (w / 16.0).sqrt().max(0.6);
    let (hot, col, deep) = beam_colors(p);
    let pale = tone(col, 0.5, WHITE);
    let charge = paint::js_round(p.charge);
    let fire_start = ctx.start + charge;
    let fire_end = ctx.end;
    let grow = p.travel.max(1.0);
    let firing = (fire_end - fire_start).max(1.0);
    let fade = if ctx.fade_out != 0.0 && !ctx.fade_out.is_nan() { ctx.fade_out } else { 8.0 };
    let blend = glow_blend(p.blend);
    let light = |auto: f64| light_share(blend, auto);
    let light_layer = if blend == NORMAL { NORMAL } else { ADD };
    let base = Spec {
        blend,
        beam_w: w,
        grow,
        fire_start,
        fire_end,
        fade_frames: if ctx.timed { 12.0f64.min(fade).max(4.0) } else { 1.0 },
        arc_amp: (12.0 * p.wobble + 6.0) * r,
        placement: behind(p.layer == DrawLayer::Behind),
        ..Spec::default()
    };
    let arcs = p.arcs.max(1) as f64;
    let main = 1.0;
    let bolts = |n: f64, thick: f64, amp: f64, branches: f64, ink: f64| layer(Spec {
        shape: ARC, count: n * 16.0, arc_segs: 16.0, start: fire_start, arc_branches: branches, arc_rhythm: 2.0,
        arc_amp: base.arc_amp * amp, size0: thick * r, softness: 1.4 * li.max(0.25),
        outline: Some(Outline { width: ink * r, color: deep }),
        emissive: Some(Curve::three(light(0.2), 0.5, light(0.2), light(0.2))),
        ..base.clone()
    }, stops(&[(hot, 1.0)]));
    // Charging: sparks crackle in the hand and its light grows.
    let crackle = (p.charge_particles && charge > 0.0).then(|| layer(Spec {
        start: ctx.start, emit_dur: charge, rate: 5.0, life_min: 3.0, life_max: 6.0, emit_radius: 6.0 * r,
        spread: TAU, speed_min: 2.0 * r, speed_max: 5.0 * r, drag: 0.2,
        shape: SPARK, rotate: ROTATE_MOTION, aspect: 2.2, size0: 1.6 * r, size_over_life: Some(Curve::three(1.0, 0.5, 0.8, 0.2)),
        trail: Some(Trail { length: 2.0, segments: 2, width: 0.6, alpha: 0.7, glow: 0.5, emissive: None }),
        emissive: Some(Curve::three(light(0.5), 0.5, light(0.45), light(0.4))), flicker: 0.5,
        ..base.clone()
    }, stops(&[(hot, 1.0), (col, 1.0), (deep, 1.0)])));
    let hand_light = layer(Spec {
        start: ctx.start, emit_dur: (fire_end - ctx.start).max(1.0), rate: 1.0, life_min: 3.0, life_max: 4.0, emit_radius: 1.0,
        softness: 1.8, size0: 40.0 * r, size_jitter: 0.25, flicker: 0.5, clip_fade_in: charge.max(1.0),
        alpha_over_life: Some(Curve::three(0.0, 0.3, 0.5 * li, 0.0)), blend: light_layer,
        ..base.clone()
    }, stops(&[(pale, i.max(1.0)), (col, i.max(1.0))]));
    // A flash at each end while it strikes.
    let flash = |at: u8, size: f64| layer(Spec {
        start: if at == POINT { fire_start } else { fire_start + grow }, emit_dur: firing, rate: 0.7, life_min: 2.0, life_max: 4.0,
        emit_shape: at, emit_radius: 2.0, shape: SPARKLE, softness: 0.0, spin: 0.2, spin_jitter: 1.0, size0: size * r, size_jitter: 0.3,
        size_over_life: Some(Curve::three(0.7, 0.3, 1.0, 0.6)), alpha_over_life: Some(Curve::three(1.0, 0.5, 0.9, 0.0)),
        outline: Some(Outline { width: 0.8 * r, color: deep }),
        emissive: Some(Curve::three(light(0.6), 0.5, light(0.6), light(0.6))),
        ..base.clone()
    }, stops(&[(hot, 1.0), (pale, 1.0)]));
    let tip_light = p.splash.then(|| layer(Spec {
        start: fire_start + grow, emit_dur: (firing - grow).max(1.0), rate: 1.0, life_min: 3.0, life_max: 4.0,
        emit_shape: BEAM_TIP, emit_radius: 2.0, softness: 1.7, size0: 52.0 * r, size_jitter: 0.3, flicker: 0.5,
        alpha_over_life: Some(Curve::three(0.0, 0.3, 0.6 * li, 0.0)), blend: light_layer,
        ..base.clone()
    }, stops(&[(pale, i.max(1.0)), (col, i.max(1.0))])));
    let impact = p.splash.then(|| layer(Spec {
        start: fire_start + grow, emit_dur: (firing - grow).max(1.0), rate: 0.3, life_min: 6.0, life_max: 6.0,
        emit_shape: BEAM_TIP, shape: RING, softness: 0.06, size_jitter: 0.1, size0: 40.0 * r, size_over_life: Some(Curve::three(0.15, 0.4, 0.8, 1.0)),
        alpha_over_life: Some(Curve::three(0.9, 0.5, 0.5, 0.0)), emissive: Some(Curve::three(light(0.3), 0.5, light(0.5), light(0.7))),
        ..base.clone()
    }, stops(&[(pale, 1.0), (col, 1.0), (deep, 1.0)])));
    let splash = (p.splash && p.sparks > 0.0).then(|| layer(Spec {
        start: fire_start + grow, emit_dur: (firing - grow).max(1.0), rate: 7.0 * p.sparks, life_min: 5.0, life_max: 11.0,
        emit_shape: BEAM_TIP, emit_radius: 4.0, angle: std::f64::consts::PI, spread: 2.6, speed_min: 4.0, speed_max: 11.0, gravity: 0.3, drag: 0.06,
        collide: 1.0, bounce: 0.35,
        shape: SPARK, rotate: ROTATE_MOTION, aspect: 2.2, size0: 1.7, size_over_life: Some(Curve::three(1.0, 0.5, 0.8, 0.2)),
        trail: Some(Trail { length: 3.0, segments: 3, width: 0.6, alpha: 0.7, glow: 0.5, emissive: None }),
        emissive: Some(Curve::three(light(0.5), 0.5, light(0.45), light(0.4))), alpha_over_life: Some(Curve::three(1.0, 0.6, 0.9, 0.0)),
        ..base.clone()
    }, stops(&[(hot, 1.0), (pale, 1.0), (col, 1.0), (deep, 1.0)])));
    // The rest strike round the main channel, every other one at a time, so the strike stays one bolt.
    let thin = (arcs > main).then(|| bolts(((arcs - main) / 2.0).ceil(), 0.7, 1.6, 1.0, 0.9));
    [Some(hand_light), crackle, tip_light, thin, Some(bolts(main, 2.2, 1.0, 2.4, 1.7)), impact, splash, Some(flash(POINT, 11.0)), p.splash.then(|| flash(BEAM_TIP, 15.0))]
        .into_iter()
        .flatten()
        .collect()
}

/// A beam's colours: its white-hot core, its body and a deeper, more saturated rim (so a light hue
/// keeps an edge on a white page), or a gradient's start, middle and end.
fn beam_colors(p: &Beam) -> ([f64; 3], [f64; 3], [f64; 3]) {
    if paint::is_gradient(&p.color) {
        let at = |t: f64| paint::sample_color(&p.color, t).0.map(|v| v / 255.0);
        (at(0.0), at(0.5), at(1.0))
    } else {
        let col = paint_color(&p.color);
        (tone(col, 0.7, WHITE), col, deeper(col, 0.62))
    }
}

/// Start firing: the beam is already firing at its start, without a charge (Auto: when its clip has no end).
pub(super) fn fires_at_once(p: &Beam, ctx: &Context) -> bool {
    match p.prefill {
        Prefill::On => true,
        Prefill::Off => false,
        Prefill::Auto => !ctx.timed,
    }
}

pub(super) fn beam(p: &Beam, ctx: &Context) -> Vec<Spec> {
    match p.style {
        // Spiral is Energy with its strands (retired into it).
        BeamStyle::Energy | BeamStyle::Spiral => energy(p, ctx, p.strands || p.style == BeamStyle::Spiral, fires_at_once(p, ctx)),
        BeamStyle::Laser => laser(p, ctx),
        BeamStyle::Cartoon => toon(p, ctx),
        BeamStyle::Lightning => lightning(p, ctx),
        BeamStyle::FireBreath => breath(p, ctx),
    }
}
