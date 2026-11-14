//! Smoke: puffs that rise, drift and billow.

use super::*;
use crate::vfx::registry::{DrawLayer, Emission, Smoke};

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

pub(super) fn smoke(p: &Smoke, ctx: &Context) -> Vec<Spec> {
    let col = paint_color(&p.color);
    // Thick and Steam are retired into Soft: drawn as Soft with their opacity, amount, size, rise, life and shading.
    let style = (p.style.index() as usize).min(SMOKES.len() - 1);
    let look = &SMOKES[style];
    let soft = style <= 2;
    let ground = look.ground && !ctx.scene;
    let burst = p.emission == Emission::Burst;
    let size = p.size * look.size;
    let t = p.turbulence;
    let drag = 0.04;
    let rise = p.rise * look.rise;
    let life = p.life * look.life;
    // Its direction: the way it rises (up by default), the wind across it.
    let dir = p.direction.to_radians();
    let (dy, dx) = super::super::fastmath::sin_cos(dir);
    let base = Spec {
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
        angle: if rise >= 0.0 { dir } else { dir + std::f64::consts::PI },
        spread: if ground { 0.0 } else { 0.6 },
        speed_min: if ground { 1.0 + 0.5 * size / 24.0 } else { (rise.abs() * 0.6).max(0.0) },
        speed_max: if ground { 2.5 + size / 24.0 } else { (rise.abs() * if soft { 1.8 } else { 1.3 }).max(0.0) },
        // Drag settles puffs at the rise and wind speeds: constant forces over drag.
        drag,
        gravity: rise * drag * dy,
        wind: p.wind * drag + rise * drag * dx,
        collide: if ground { 1.0 } else { 0.0 },
        curl: 16.0 * t * (size / 24.0).sqrt(),
        curl_scale: 0.3 / size.max(4.0),
        clip_fade_in: if ctx.timed && !burst { 6.0 } else { 0.0 },
        clip_fade_out: if ctx.timed && !burst { 10.0 } else { 0.0 },
        blend: NORMAL,
        ..Spec::default()
    };
    if !soft {
        // Cartoon and dust, not restyled yet.
        return vec![layer(
            Spec {
                material: m(if look.toon { "cloud" } else { "smoke" }),
                rotate: if look.toon { ROTATE_FIXED } else { ROTATE_UPRIGHT },
                size_mode: if look.toon { GROW_POP } else { GROW_PUFF },
                size0: size * 0.45,
                size1: size * p.growth,
                size_jitter: 0.35,
                shade: look.shade.unwrap_or(1.0) * p.shading,
                alpha: look.alpha * p.opacity,
                fade_in: if look.toon { 0.0 } else { 0.12 },
                fade_out: if look.toon { 0.0 } else { 0.6 },
                outline: look.toon.then(|| Outline { width: (size / 12.0).max(1.2), color: ink(col) }),
                ..base
            },
            smoke_stops(style, col),
        )];
    }
    // Soft: puffs that billow out fast and slow down, lit from above, thinning and breaking up
    // softly as they rise; lighter where they are born, a little darker as they go.
    let colors = paint_or(&p.color, stops_with(&[(tone(col, 0.22, WHITE), 1.0, 1.0), (col, 1.0, 1.0), (tone(tone(col, 0.12, BLACK), 0.15, [0.5, 0.5, 0.5]), 1.0, 1.0)]));
    let g = p.growth.max(0.2);
    vec![layer(
        Spec {
            material: m("smoke"),
            rotate: ROTATE_UPRIGHT,
            spin: 0.006,
            spin_jitter: 1.0,
            size0: size,
            size_over_life: Some(Curve::three(0.45, 0.5, 0.45 + (g - 0.45) * 0.5, g)),
            size_jitter: 0.3,
            erosion: Some(Erosion { from: 0.0, to: 0.5, power: 1.3, edge: 0.5, ..Default::default() }),
            alpha: ((look.alpha / 0.45) * 0.62).min(1.0) * p.opacity,
            alpha_over_life: Some(Curve::four(0.0, 0.15, 1.0, 0.5, 0.75, 0.0)),
            shade: look.shade.map_or(0.55, |s| s * 1.1).min(1.0) * p.shading,
            value_jitter: 0.06,
            ..base
        },
        colors,
    )]
}
