//! Smoke: a soft plume, cartoon puffs, dust kicked up from the ground.

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
    ground: bool,
}

/// Soft, thick, steam, cartoon and ground dust (`SMOKES`).
const SMOKES: [SmokeLook; 5] = [
    SmokeLook { alpha: 0.45, rate: 1.0, size: 1.0, rise: 1.0, life: 1.0, shade: None, ground: false },
    SmokeLook { alpha: 0.85, rate: 1.4, size: 1.2, rise: 0.8, life: 1.1, shade: None, ground: false },
    SmokeLook { alpha: 0.16, rate: 0.6, size: 0.8, rise: 1.7, life: 0.6, shade: Some(0.35), ground: false },
    SmokeLook { alpha: 1.0, rate: 0.7, size: 1.0, rise: 1.0, life: 0.8, shade: None, ground: false },
    SmokeLook { alpha: 0.6, rate: 1.0, size: 1.1, rise: 0.25, life: 0.9, shade: None, ground: true },
];

pub(super) fn smoke(p: &Smoke, ctx: &Context) -> Vec<Spec> {
    let col = paint_color(&p.color);
    // Thick and Steam are retired into Soft: drawn as Soft with their opacity, amount, size, rise, life and shading.
    let style = (p.style.index() as usize).min(SMOKES.len() - 1);
    let look = &SMOKES[style];
    let ground = look.ground && !ctx.scene;
    let burst = p.emission == Emission::Burst;
    let size = p.size * look.size;
    let rise = p.rise * look.rise;
    let life = p.life * look.life;
    // Its direction: the way it rises (up by default); the wind across it.
    let dir = p.direction.to_radians();
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
        collide: if ground { 1.0 } else { 0.0 },
        clip_fade_in: if ctx.timed && !burst { 6.0 } else { 0.0 },
        clip_fade_out: if ctx.timed && !burst { 10.0 } else { 0.0 },
        blend: NORMAL,
        ..Spec::default()
    };
    let flow = Flow::new(p, rise, size, dir);
    match style {
        3 => cartoon_puffs(p, &base, &flow, col, size),
        4 => ground_dust(p, &base, &flow, col, size, ground),
        _ => soft_plume(p, look, &base, &flow, col, size),
    }
}

/// How smoke moves: it leaves its source fast (a buoyant jet) and settles, slowed by drag, to
/// climbing along its direction with the wind across it; the jet and the climb scale with the rise,
/// the swirl with the turbulence and the puff size.
struct Flow {
    dir: f64,
    rise: f64,
    wind: f64,
    curl: f64,
    curl_scale: f64,
}

impl Flow {
    fn new(p: &Smoke, rise: f64, size: f64, dir: f64) -> Flow {
        Flow { dir, rise, wind: p.wind, curl: p.turbulence * (size / 24.0).sqrt(), curl_scale: 1.0 / size.max(4.0) }
    }

    /// `s` moving so: leaving at `jet` times the rise, settling at `drag` to climbing at `climb`
    /// times it, swirling by `curl` (times the turbulence) at `curl_scale` (over the puff size).
    fn moving(&self, s: Spec, jet: f64, climb: f64, drag: f64, curl: f64, curl_scale: f64) -> Spec {
        let (dy, dx) = super::super::fastmath::sin_cos(self.dir);
        let c = climb * self.rise;
        Spec {
            speed_min: jet * self.rise.abs() * 0.75,
            speed_max: jet * self.rise.abs() * 1.25,
            drag,
            gravity: c * drag * dy,
            wind: self.wind * drag + c * drag * dx,
            curl: curl * self.curl,
            curl_scale: curl_scale * self.curl_scale,
            ..s
        }
    }
}

/// Soft: a plume. Small dense puffs leave the source fast, slow to a steady climb as they take in
/// air, widen, tumble in the flow and thin out, eroding into wisps at the top; the wind leans it.
/// Lit from above, a little lighter where it is born. One frame shows the column (narrow and dense
/// at its source, wide and ragged at its top); the frames show it climbing.
fn soft_plume(p: &Smoke, look: &SmokeLook, base: &Spec, flow: &Flow, col: [f64; 3], size: f64) -> Vec<Spec> {
    let colors = paint_or(&p.color, stops_with(&[(tone(col, 0.22, WHITE), 1.0, 1.0), (col, 1.0, 1.0), (tone(tone(col, 0.12, BLACK), 0.15, [0.5, 0.5, 0.5]), 1.0, 1.0)]));
    let g = p.growth.max(0.2);
    // Thicker looks (the retired Thick) stay denser at the top; thinner ones (Steam) fade sooner.
    let thick = (look.alpha / 0.45).min(2.0);
    let (birth, end) = (0.5, 0.5 + 0.75 * g);
    let puffs = Spec {
        rate: base.rate * 0.6,
        spread: 0.6,
        material: m("smoke"),
        rotate: ROTATE_UPRIGHT,
        size0: size,
        // Born small at the source, widening with the height it climbs.
        size_over_life: Some(Curve::three(birth, 0.35, birth + (end - birth) * 0.45, end)),
        size_jitter: 0.35,
        erosion: Some(Erosion { from: 0.18, to: 0.62, power: 1.5, edge: 0.35, ..Default::default() }),
        alpha: (0.6 * thick).min(1.0) * p.opacity,
        // Dense at the source; the wide puffs at the top overlap many times, so each is fainter.
        alpha_over_life: Some(Curve::four(0.0, 0.05, 1.0, 0.45, 0.4 * thick.min(1.4), 0.0)),
        shade: look.shade.map_or(0.45, |s| s * 1.1).min(1.0) * p.shading,
        value_jitter: 0.06,
        ..base.clone()
    };
    vec![layer(flow.moving(puffs, 3.6, 2.2, 0.05, 26.0, 0.35), colors)]
}

/// Cartoon: smoke as an effects animator draws it. Round puffs pop out of the source, roll up
/// growing, each painted flat with a shadow side and an ink line, and shrink away at the top; few of
/// them, strong shapes; its style brings twos.
fn cartoon_puffs(p: &Smoke, base: &Spec, flow: &Flow, col: [f64; 3], size: f64) -> Vec<Spec> {
    let g = p.growth.max(0.2);
    let line = ink(col);
    let light = tone(col, 0.35, WHITE);
    let shade = tone(tone(col, 0.3, BLACK), 0.25, [0.35, 0.3, 0.5]);
    let colors = paint_or(&p.color, stops(&[(light, 1.0), (tone(col, 0.15, WHITE), 1.0), (col, 1.0)]));
    let big = 0.6 + 0.4 * g;
    let puffs = Spec {
        rate: base.rate * 0.15,
        spread: 0.5,
        shape: DISC,
        softness: 0.0,
        stretch: 0.0,
        size0: size * 0.55,
        size_over_life: Some(Curve::four(0.3, 0.1, 1.0, 0.7, big, 0.0)),
        size_jitter: 0.3,
        alpha: p.opacity,
        fade_in: 0.0,
        fade_out: 0.0,
        outline: Some(Outline { width: (size * 0.09).clamp(1.2, 6.0), color: line }),
        cel: Some(Cel { color: shade, depth: 0.3, strength: p.shading }),
        ..base.clone()
    };
    vec![layer(flow.moving(puffs, 4.0, 3.0, 0.06, 8.0, 0.3), colors)]
}

/// Dust: kicked up from the ground under the target (or, on the scene, from its point). Billows
/// roll out along the ground both ways, slowing, swelling and rising a little as they settle into a
/// haze. Earthy, lit from above.
fn ground_dust(p: &Smoke, base: &Spec, flow: &Flow, col: [f64; 3], size: f64, ground: bool) -> Vec<Spec> {
    let g = p.growth.max(0.2);
    let colors = paint_or(&p.color, stops(&[(tone(col, 0.3, WHITE), 1.0), (col, 1.0), (tone(col, 0.15, BLACK), 1.0)]));
    let (birth, end) = (0.45, 0.4 + 0.6 * g);
    // Along the ground the jet is sideways (the ground emitter throws both ways); on the scene, out from its point.
    let roll = (2.0 + size / 16.0) * 1.4;
    let billows = Spec {
        rate: base.rate * 0.6,
        spread: if ground { 0.0 } else { 2.4 },
        material: m("smoke"),
        rotate: ROTATE_UPRIGHT,
        size0: size,
        size_over_life: Some(Curve::three(birth, 0.3, birth + (end - birth) * 0.55, end)),
        size_jitter: 0.3,
        erosion: Some(Erosion { from: 0.02, to: 0.55, power: 1.3, edge: 0.35, ..Default::default() }),
        alpha: 0.7 * p.opacity,
        alpha_over_life: Some(Curve::four(0.0, 0.06, 1.0, 0.5, 0.45, 0.0)),
        shade: 0.45 * p.shading,
        value_jitter: 0.06,
        ..base.clone()
    };
    let mut billows = flow.moving(billows, 0.0, 1.2, 0.07, 18.0, 0.35);
    billows.speed_min = roll * 0.6;
    billows.speed_max = roll * 1.4;
    vec![layer(billows, colors)]
}
