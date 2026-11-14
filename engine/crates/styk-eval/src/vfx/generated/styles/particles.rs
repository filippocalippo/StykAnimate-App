//! Particles: the general emitter. A look is two things: what one particle looks like (its
//! shape or material, its colours over life, how much of it is light) and the motion that
//! makes a cloud of them read as what the look is named. The motion is the effect's own
//! parameters, which a look sets when it is picked (`applies` in src/vfx-registry.mjs), so
//! every control stays the person's; what a look decides is here, one function per look.

use super::super::fastmath as fm;
use super::*;
use crate::vfx::registry::{DrawLayer, Emission, EmitShape, GeneratorBlend, ParticleLook, Particles, SizeMode, Space};

/// "Emit from" options (`EMITTERS`).
const EMITTERS: [u8; 4] = [POINT, EMIT_RING, BODY, LINE];
const DEG: f64 = PI / 180.0;

/// What a look draws from: the effect's parameters as a layer, before the look's own choices.
struct In<'a> {
    p: &'a Particles,
    col: [f64; 3],
    base: Spec,
    burst: bool,
    /// Emitted across the whole stage (a scene effect from a Line of no size): weather.
    stage: bool,
}

impl In<'_> {
    /// The look's colours over life from the effect's colour, or the effect's own gradient.
    fn ramp(&self, derived: Ramp) -> Ramp {
        paint_or(&self.p.color, derived)
    }

    /// Facing: the person's choice, or the look's own on Auto.
    fn rotate(&self, auto: u8) -> u8 {
        match self.p.rotation.index() {
            0 => auto,
            r => r - 1,
        }
    }

    /// Blending: Glow is all light, Solid all paint, Auto the look's own mix.
    fn blend(&self, auto: u8) -> u8 {
        match self.p.blend {
            GeneratorBlend::Glow => ADD,
            GeneratorBlend::Solid => NORMAL,
            GeneratorBlend::Auto => auto,
        }
    }

    /// Size over life: on Auto the look's own curve (built from the end size), otherwise the
    /// person's mode from `size0` to `size0 × end size`.
    fn sized(&self, s: Spec, size0: f64, auto: Curve) -> Spec {
        match self.p.size_mode {
            SizeMode::Auto => Spec { size0, size_over_life: Some(auto), ..s },
            mode => Spec { size0, size1: size0 * self.p.end_size, size_mode: mode.index() - 1, size_over_life: None, ..s },
        }
    }

    /// The look's own halo of light, made stronger by the Glow halo control.
    fn halo(&self, own: Halo) -> Option<Halo> {
        Some(Halo { alpha: own.alpha + 0.45 * self.p.glow, ..own })
    }

    /// The look's own ribbon, unless the Motion trail control asks for one.
    fn trail(&self, own: Trail) -> Option<Trail> {
        (self.p.trail == 0).then_some(own)
    }

    /// A share of the effect's particles for a layer that goes with the main one.
    fn share(&self, s: Spec, k: f64) -> Spec {
        if self.burst { Spec { count: (self.base.count * k).max(1.0), ..s } } else { Spec { rate: k, ..s } }
    }

    fn end(&self) -> f64 {
        self.p.end_size
    }
}

fn mix(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

/// A darker, fuller tone of `c`'s hue, `t` of the way: the edge and shadow a pale colour needs
/// on white, and what a hot colour cools to.
fn deep(c: [f64; 3], t: f64) -> [f64; 3] {
    let hi = c[0].max(c[1]).max(c[2]);
    let lo = c[0].min(c[1]).min(c[2]);
    let dark = if hi - lo > 0.06 { c.map(|v| 0.06 + (v - lo) / (hi - lo) * 0.42) } else { c.map(|v| v * 0.4) };
    tone(c, t, dark)
}

/// `c` heated toward a warm white.
fn hot(c: [f64; 3], t: f64) -> [f64; 3] {
    tone(c, t, [1.0, 0.97, 0.88])
}

pub(super) fn particles(p: &Particles, ctx: &Context) -> Vec<Spec> {
    let i = input(p, ctx);
    let look: fn(&In<'_>) -> Vec<Spec> = match p.look {
        ParticleLook::SoftGlow => soft_glow,
        ParticleLook::Spark => spark,
        ParticleLook::Dot => dot,
        ParticleLook::Ring => bubble,
        ParticleLook::Shard => shard,
        ParticleLook::Smoke => smoke,
        ParticleLook::Star => star,
        ParticleLook::Bokeh => bokeh,
        ParticleLook::Flame => flame,
        ParticleLook::CartoonCloud => cartoon_cloud,
        ParticleLook::CartoonFlame => cartoon_flame,
        // Retired: Leaf is drawn as Petal, in its own colour.
        ParticleLook::Leaf | ParticleLook::Petal => petal,
        ParticleLook::Snowflake => snowflake,
        ParticleLook::Drop => drop,
        ParticleLook::Heart => heart,
        ParticleLook::CartoonStar => cartoon_star,
        ParticleLook::Pixel => pixel,
        ParticleLook::Lightning => lightning,
        ParticleLook::Wisp => wisp,
        ParticleLook::Rock => rock,
        ParticleLook::Splat => splat,
        ParticleLook::Burst => burst,
    };
    look(&i)
}

/// Every control of the effect as a layer: emission, life, launch, forces, fades, trail, halo and outline.
fn input<'a>(p: &'a Particles, ctx: &Context) -> In<'a> {
    let v = p.variation;
    let burst = p.emission == Emission::Burst;
    let stage = ctx.scene && p.shape == EmitShape::Line && p.radius == 0.0;
    let emit_shape = if stage { STAGE } else { EMITTERS[p.shape.index() as usize] };
    // Gravity pulls toward its direction (90°: down); wind adds across.
    let (gy, gx) = fm::sin_cos(p.gravity_angle * DEG);
    let base = Spec {
        placement: behind(p.layer == DrawLayer::Behind),
        start: ctx.start,
        emit_dur: if burst { 0.0 } else { ctx.window },
        count: if burst { p.count } else { 0.0 },
        rate: if burst { 0.0 } else { 1.0 },
        rate_param: (!burst).then_some(RateParam::Rate),
        burst_jitter: if burst { 2.0 } else { 0.0 },
        life_min: (p.life * (1.0 - v * 0.5)).max(1.0),
        life_max: (p.life * (1.0 + v * 0.5)).max(1.0),
        speed_min: 1.0 - v * 0.6,
        speed_max: 1.0 + v * 0.6,
        spread: p.spread * DEG,
        gravity: p.gravity * gy,
        wind: p.wind + p.gravity * gx,
        drag: p.drag,
        turb: p.turbulence,
        turb_scale: 0.015,
        curl: p.flow,
        curl_scale: 0.015,
        orbit: p.swirl * DEG,
        spin: p.spin * DEG,
        spin_jitter: v,
        size_jitter: v * 0.5,
        fade_in: p.fade_in,
        fade_out: p.fade,
        flicker: p.twinkle,
        color_mode: p.color_mode.index() as f64,
        shade: p.shading,
        halo: (p.glow > 0.0).then_some(Halo { scale: 2.8, alpha: 0.45 * p.glow }),
        outline: p.outline.then(|| Outline { width: p.outline_width, color: paint_color(&p.outline_color) }),
        echoes: (p.trail > 0).then_some(Echoes { count: p.trail, lag: 2.0, alpha: 0.6, size: 0.85 }),
        emit_shape,
        emit_radius: p.radius,
        body: emit_shape == BODY,
        collide: if p.ground { 1.0 } else { 0.0 },
        bounce: p.bounce,
        world: p.space == Space::LeaveTrail,
        prewarm: if stage && !burst { 1.0 } else { 0.0 },
        keyed: true,
        // Only looks that stretch along their motion say so.
        stretch: 0.0,
        // Crisp unless a look is soft.
        softness: 0.0,
        blend: AUTO,
        ..Spec::default()
    };
    In { p, col: paint_color(&p.color), base, burst, stage }
}

// ---------------------------------------------------------------------------
// Light: glows, sparks, stars, bokeh, lightning.
// ---------------------------------------------------------------------------

/// Soft glow: soft orbs of light that swell in and shrink away as they drift; a coloured body
/// that paints, a paler centre, and light around them.
fn soft_glow(i: &In<'_>) -> Vec<Spec> {
    let col = i.col;
    let ramp = i.ramp(stops(&[(deep(col, 0.2), 1.0), (deep(col, 0.3), 1.0), (deep(col, 0.4), 1.0)]));
    let s = Spec {
        shape: DISC, softness: 0.9, core: 0.6, rotate: ROTATE_FIXED,
        emissive: Some(Curve::three(0.25, 0.5, 0.2, 0.15)), blend: i.blend(AUTO),
        halo: i.halo(Halo { scale: 2.4, alpha: 0.35 }),
        hue_jitter: 0.02, value_jitter: 0.06,
        ..i.base.clone()
    };
    vec![layer(i.sized(s, 1.0, Curve::four(0.35, 0.12, 1.0, 0.55, mix(1.0, i.end(), 0.5), i.end())), ramp)]
}

/// Spark: few, bright, fast; thrown out on arcs, a needle along its motion that shortens as it
/// slows, white-hot at its head and cooling through the colour to a deep ember as it dies; with
/// the ground on, some land and bounce.
fn spark(i: &In<'_>) -> Vec<Spec> {
    let col = i.col;
    // The needle's white-hot middle is the shader's; its body paints the colour, so it reads on white.
    let ramp = i.ramp(stops(&[(hot(col, 0.3), 1.0), (col, 1.0), (col, 1.0), (deep(col, 0.25), 1.0), (deep(col, 0.5), 1.0), (deep(col, 0.75), 1.0)]));
    let s = Spec {
        shape: SPARK, rotate: i.rotate(ROTATE_MOTION), aspect: 2.0, softness: 0.0, stretch: i.p.stretch * 0.5,
        emissive: Some(Curve::three(0.3, 0.35, 0.12, 0.04)), blend: i.blend(AUTO),
        trail: i.trail(Trail { length: 3.0, segments: 3, width: 0.55, alpha: 0.7, glow: 0.5, emissive: Some(0.15) }),
        halo: i.halo(Halo { scale: 3.0, alpha: 0.25 }),
        hue_jitter: 0.015, value_jitter: 0.12,
        ..i.base.clone()
    };
    vec![layer(i.sized(s, 0.6, Curve::three(1.0, 0.55, mix(1.0, i.end(), 0.35), i.end())), ramp)]
}

/// Star: four-pointed glints that pop in, twinkle and turn slowly, shrinking away.
fn star(i: &In<'_>) -> Vec<Spec> {
    let col = i.col;
    let ramp = i.ramp(stops(&[(col, 1.0), (col, 1.0), (deep(col, 0.25), 1.0)]));
    let s = Spec {
        material: m("star"), rotate: i.rotate(ROTATE_RANDOM), core: 0.8,
        emissive: Some(Curve::three(0.35, 0.5, 0.3, 0.2)), blend: i.blend(AUTO),
        halo: i.halo(Halo { scale: 2.0, alpha: 0.25 }),
        value_jitter: 0.08,
        ..i.base.clone()
    };
    vec![layer(i.sized(s, 1.0, Curve::four(0.0, 0.18, 1.0, 0.55, mix(1.0, i.end(), 0.6), i.end())), ramp)]
}

/// Bokeh: out-of-focus discs of light with brighter rims, drifting slowly, fading in and out.
fn bokeh(i: &In<'_>) -> Vec<Spec> {
    let col = i.col;
    let ramp = i.ramp(stops_with(&[(deep(col, 0.2), 1.0, 0.6), (deep(col, 0.3), 1.0, 0.55), (deep(col, 0.4), 1.0, 0.45)]));
    let s = Spec {
        material: m("bokeh"), rotate: ROTATE_FIXED,
        emissive: Some(Curve::three(0.4, 0.5, 0.35, 0.3)), blend: i.blend(AUTO),
        hue_jitter: 0.03, value_jitter: 0.1,
        ..i.base.clone()
    };
    vec![layer(i.sized(s, 1.0, Curve::three(0.85, 0.5, mix(0.85, i.end(), 0.5), i.end())), ramp)]
}

/// Lightning: forked bolts that crackle out from the emitter to a flash where they strike, struck
/// again in a new shape every other frame: the colour, darker on a white page, around a white-hot core.
fn lightning(i: &In<'_>) -> Vec<Spec> {
    let col = i.col;
    let ramp = i.ramp(stops(&[(deep(col, 0.45), 1.0), (deep(col, 0.55), 1.0), (deep(col, 0.65), 1.0)]));
    let s = Spec {
        shape: DISC, softness: 1.2, core: 0.9, rotate: ROTATE_FIXED,
        strike: 0.3, arc_amp: 0.22, arc_branches: 0.8, arc_rhythm: 2.0,
        emissive: Some(Curve::three(0.45, 0.5, 0.4, 0.35)), blend: i.blend(AUTO),
        halo: i.halo(Halo { scale: 2.0, alpha: 0.3 }),
        ..i.base.clone()
    };
    vec![layer(i.sized(s, 0.5, Curve::three(1.0, 0.5, mix(1.0, i.end(), 0.5), i.end())), ramp)]
}

// ---------------------------------------------------------------------------
// Fire and smoke.
// ---------------------------------------------------------------------------

/// Flame: torn tongues licking upward, white-hot at their root and cooling through the colour
/// and orange to ember red at their tips as they break up; a few embers fly off.
fn flame(i: &In<'_>) -> Vec<Spec> {
    let col = i.col;
    let orange = tone(col, 0.55, [1.0, 0.42, 0.08]);
    let ember = tone(col, 0.35, [0.62, 0.1, 0.04]);
    let ramp = i.ramp(stops(&[(tone(col, 0.3, [1.0, 0.92, 0.55]), 1.0), (col, 1.0), (tone(col, 0.5, orange), 1.0), (orange, 1.0), (tone(orange, 0.5, ember), 1.0), (ember, 1.0)]));
    let s = Spec {
        material: m("flame"), rotate: i.rotate(ROTATE_MOTION), frame_rate: 2.0, aspect: 1.35,
        erosion: Some(Erosion { from: 0.18, to: 0.72, power: 1.4, edge: 0.04, rim: 1.0, rim_width: 0.32, rim_color: tone(orange, 0.6, ember) }),
        shade: 0.9 * i.p.shading, emissive: Some(Curve::three(0.3, 0.5, 0.15, 0.05)), blend: i.blend(AUTO),
        hue_jitter: 0.012, value_jitter: 0.04,
        ..i.base.clone()
    };
    let flames = layer(i.sized(s.clone(), 1.0, Curve::four(0.55, 0.3, 1.0, 0.7, mix(1.0, i.end(), 0.5), i.end())), ramp);
    // Its light, behind it: glows on a dark page, nothing on a white one.
    let light = Spec {
        material: None, shape: DISC, softness: 1.6, erosion: None, frame_rate: 0.0, placement: Placement::Behind, blend: if i.blend(AUTO) == NORMAL { NORMAL } else { ADD },
        speed_min: s.speed_min * 0.6, speed_max: s.speed_max * 0.6, alpha: 0.22, fade_in: 0.3, fade_out: 0.5, halo: None, outline: None, echoes: None,
        ..s
    };
    let light = layer(i.share(Spec { size0: 1.6, size_over_life: Some(Curve::three(0.7, 0.4, 1.0, 1.2)), ..light }, 0.25), stops(&[(hot(col, 0.3), 1.0), (orange, 1.0)]));
    let embers = Spec {
        material: None, shape: SPARK, rotate: ROTATE_MOTION, aspect: 1.8, frame_rate: 0.0, erosion: None, shade: 0.0,
        life_min: i.base.life_min * 1.4, life_max: i.base.life_max * 1.8, speed_min: i.base.speed_min * 1.2, speed_max: i.base.speed_max * 1.6,
        curl: i.base.curl + 12.0, flicker: (i.base.flicker + 0.5).min(1.0), fade_in: 0.1, fade_out: 0.4,
        emissive: Some(Curve::three(0.6, 0.5, 0.5, 0.4)), blend: i.blend(AUTO), halo: None,
        ..i.base.clone()
    };
    let embers = layer(i.share(Spec { size0: 0.13, size_over_life: Some(Curve::three(1.0, 0.5, 0.8, 0.2)), ..embers }, 0.2), stops(&[([1.0, 0.9, 0.55], 1.0), (hot(col, 0.4), 1.0), (orange, 1.0), (ember, 1.0)]));
    vec![light, flames, embers]
}

/// Smoke: puffs that billow out and slow, lit from above, thinning and breaking up softly as they rise.
fn smoke(i: &In<'_>) -> Vec<Spec> {
    let col = i.col;
    let ramp = i.ramp(stops(&[(tone(col, 0.22, WHITE), 1.0), (col, 1.0), (tone(tone(col, 0.12, BLACK), 0.15, [0.5, 0.5, 0.5]), 1.0)]));
    let s = Spec {
        material: m("smoke"), rotate: i.rotate(ROTATE_UPRIGHT),
        erosion: Some(Erosion { from: 0.0, to: 0.5, power: 1.3, edge: 0.5, ..Default::default() }),
        shade: 0.9 * i.p.shading, blend: i.blend(NORMAL), alpha: 0.75, value_jitter: 0.06,
        ..i.base.clone()
    };
    vec![layer(i.sized(s, 1.0, Curve::three(0.45, 0.5, mix(0.45, i.end(), 0.5), i.end())), ramp)]
}

/// Wisp: ghostly streams that curl and drift, pale at their heart, fading as they stretch out.
fn wisp(i: &In<'_>) -> Vec<Spec> {
    let col = i.col;
    let ramp = i.ramp(stops(&[(deep(col, 0.25), 1.0), (deep(col, 0.4), 1.0), (deep(col, 0.55), 1.0)]));
    let s = Spec {
        material: m("wisp"), rotate: i.rotate(ROTATE_MOTION), frame_rate: 3.0,
        erosion: Some(Erosion { from: 0.05, to: 0.6, power: 1.2, edge: 0.35, ..Default::default() }),
        shade: 0.6 * i.p.shading, emissive: Some(Curve::three(0.3, 0.5, 0.25, 0.2)), blend: i.blend(AUTO),
        halo: if i.p.glow > 0.0 { i.base.halo } else { None },
        ..i.base.clone()
    };
    vec![layer(i.sized(s, 1.0, Curve::three(0.6, 0.4, mix(0.6, i.end(), 0.6), i.end())), ramp)]
}

// ---------------------------------------------------------------------------
// Things thrown: dots, shards, rocks, splats, bursts.
// ---------------------------------------------------------------------------

/// Dot: crisp round specks, each a little different.
fn dot(i: &In<'_>) -> Vec<Spec> {
    let col = i.col;
    let ramp = i.ramp(stops(&[(tone(col, 0.2, WHITE), 1.0), (col, 1.0), (deep(col, 0.3), 1.0)]));
    let s = Spec {
        shape: DISC, softness: 0.0, rotate: ROTATE_FIXED,
        emissive: Some(Curve::three(0.2, 0.5, 0.1, 0.05)), blend: i.blend(AUTO),
        hue_jitter: 0.02, value_jitter: 0.12,
        ..i.base.clone()
    };
    vec![layer(i.sized(s, 1.0, Curve::three(1.0, 0.6, mix(1.0, i.end(), 0.3), i.end())), ramp)]
}

/// Shard: glassy splinters thrown out spinning, catching the light as they turn and fall.
fn shard(i: &In<'_>) -> Vec<Spec> {
    let col = i.col;
    let ramp = i.ramp(stops(&[(deep(col, 0.2), 1.0), (deep(col, 0.35), 1.0), (deep(col, 0.5), 1.0)]));
    let s = Spec {
        material: m("shard"), rotate: i.rotate(ROTATE_RANDOM), core: 0.7,
        emissive: Some(Curve::three(0.15, 0.5, 0.1, 0.05)), blend: i.blend(AUTO),
        hue_jitter: 0.02, value_jitter: 0.3,
        ..i.base.clone()
    };
    vec![layer(i.sized(s, 1.0, Curve::three(1.0, 0.7, 1.0, i.end())), ramp)]
}

/// Rock: stones thrown up that tumble, fall, land and bounce.
fn rock(i: &In<'_>) -> Vec<Spec> {
    let col = i.col;
    let ramp = i.ramp(stops(&[(tone(col, 0.1, WHITE), 1.0), (col, 1.0), (tone(col, 0.15, BLACK), 1.0)]));
    let s = Spec { material: m("rock"), rotate: i.rotate(ROTATE_RANDOM), blend: i.blend(NORMAL), value_jitter: 0.25, ..i.base.clone() };
    vec![layer(i.sized(s, 1.0, Curve::three(1.0, 0.5, 1.0, i.end())), ramp)]
}

/// Splat: blobs of liquid thrown out that land and spread.
fn splat(i: &In<'_>) -> Vec<Spec> {
    let col = i.col;
    let ramp = i.ramp(stops(&[(tone(col, 0.25, WHITE), 1.0), (col, 1.0), (deep(col, 0.2), 1.0)]));
    let s = Spec { material: m("splat"), rotate: i.rotate(ROTATE_RANDOM), blend: i.blend(NORMAL), value_jitter: 0.1, ..i.base.clone() };
    vec![layer(i.sized(s, 1.0, Curve::four(0.6, 0.2, 0.9, 0.6, mix(0.9, i.end(), 0.6), i.end())), ramp)]
}

/// Burst: impact stars that pop out in a frame and shrink away.
fn burst(i: &In<'_>) -> Vec<Spec> {
    let col = i.col;
    let ramp = i.ramp(stops(&[(hot(col, 0.6), 1.0), (col, 1.0), (deep(col, 0.3), 1.0)]));
    let s = Spec {
        material: m("burst"), rotate: i.rotate(ROTATE_RANDOM),
        emissive: Some(Curve::three(0.45, 0.5, 0.25, 0.1)), blend: i.blend(AUTO),
        ..i.base.clone()
    };
    vec![layer(i.sized(s, 1.0, Curve::four(0.2, 0.15, 1.0, 0.6, mix(1.0, i.end(), 0.6), i.end())), ramp)]
}

// ---------------------------------------------------------------------------
// Drifting and falling: bubbles, petals, snow, drops, hearts.
// ---------------------------------------------------------------------------

/// Ring: bubbles that wobble as they rise, swelling a little before they pop.
fn bubble(i: &In<'_>) -> Vec<Spec> {
    let col = i.col;
    let ramp = i.ramp(stops(&[(deep(col, 0.2), 1.0), (deep(col, 0.3), 1.0)]));
    let s = Spec { shape: RING, softness: 0.08, core: 0.6, rotate: ROTATE_FIXED, emissive: Some(Curve::three(0.25, 0.5, 0.2, 0.2)), blend: i.blend(AUTO), value_jitter: 0.05, ..i.base.clone() };
    vec![layer(i.sized(s, 1.0, Curve::four(0.45, 0.25, 0.9, 0.85, mix(0.9, i.end(), 0.8), i.end())), ramp)]
}

/// Petal (and the retired Leaf): petals and leaves that tumble, sway and drift down.
fn petal(i: &In<'_>) -> Vec<Spec> {
    let col = i.col;
    let ramp = i.ramp(stops(&[(tone(col, 0.35, WHITE), 1.0), (col, 1.0), (deep(col, 0.2), 1.0)]));
    let s = Spec { material: m("petal"), rotate: i.rotate(ROTATE_RANDOM), emissive: Some(Curve::three(0.1, 0.5, 0.05, 0.0)), blend: i.blend(NORMAL), hue_jitter: 0.025, value_jitter: 0.15, ..i.base.clone() };
    vec![layer(i.sized(s, 1.0, Curve::three(1.0, 0.5, 1.0, i.end())), ramp)]
}

/// Snowflake: flakes that drift down, sway and turn slowly; on the stage, smaller flakes further away.
fn snowflake(i: &In<'_>) -> Vec<Spec> {
    let col = i.col;
    let ramp = i.ramp(stops(&[(col, 1.0), (tone(col, 0.15, [0.75, 0.82, 0.92]), 1.0)]));
    let s = Spec { material: m("flake"), rotate: i.rotate(ROTATE_RANDOM), emissive: Some(Curve::three(0.35, 0.5, 0.3, 0.3)), blend: i.blend(AUTO), value_jitter: 0.06, ..i.base.clone() };
    let mut out = vec![layer(i.sized(s, 1.0, Curve::three(1.0, 0.5, 1.0, i.end())), ramp)];
    if i.stage {
        let far = Spec {
            shape: DISC, softness: 0.4, rotate: ROTATE_FIXED, outline: None, speed_min: i.base.speed_min * 0.55, speed_max: i.base.speed_max * 0.55, alpha: 0.7,
            emissive: Some(Curve::three(0.35, 0.5, 0.3, 0.3)), blend: i.blend(AUTO), life_min: i.base.life_min * 1.6, life_max: i.base.life_max * 1.8,
            ..i.base.clone()
        };
        out.insert(0, layer(i.share(Spec { size0: 0.35, ..far }, 1.2), ramp));
    }
    out
}

/// Drop: drops of water stretched along their fall; on the stage, rain.
fn drop(i: &In<'_>) -> Vec<Spec> {
    let col = i.col;
    let ramp = i.ramp(stops(&[(hot(col, 0.45), 1.0), (col, 1.0), (deep(col, 0.2), 1.0)]));
    let s = Spec {
        material: m("drop"), rotate: i.rotate(ROTATE_MOTION), stretch: i.p.stretch * 0.35,
        emissive: Some(Curve::three(0.2, 0.5, 0.1, 0.1)), blend: i.blend(AUTO), value_jitter: 0.06,
        ..i.base.clone()
    };
    vec![layer(i.sized(s, 1.0, Curve::three(1.0, 0.5, 1.0, i.end())), ramp)]
}

/// Heart: hearts that pop in, float up wobbling and fade.
fn heart(i: &In<'_>) -> Vec<Spec> {
    let col = i.col;
    let ramp = i.ramp(stops(&[(tone(col, 0.3, WHITE), 1.0), (col, 1.0), (deep(col, 0.25), 1.0)]));
    let s = Spec { material: m("heart"), rotate: i.rotate(ROTATE_UPRIGHT), emissive: Some(Curve::three(0.25, 0.5, 0.15, 0.1)), blend: i.blend(AUTO), hue_jitter: 0.02, value_jitter: 0.08, ..i.base.clone() };
    vec![layer(i.sized(s, 1.0, Curve::four(0.0, 0.12, 1.15, 0.3, 1.0, i.end())), ramp)]
}

// ---------------------------------------------------------------------------
// Drawn by hand: cartoon clouds, flames and stars; pixels.
// ---------------------------------------------------------------------------

/// Cartoon cloud: flat puffs that pop out, hang and pop away.
fn cartoon_cloud(i: &In<'_>) -> Vec<Spec> {
    let col = i.col;
    let ramp = i.ramp(stops(&[(tone(col, 0.1, WHITE), 1.0), (col, 1.0), (tone(col, 0.1, BLACK), 1.0)]));
    let s = Spec { material: m("cloud"), rotate: i.rotate(ROTATE_FIXED), blend: i.blend(NORMAL), ..i.base.clone() };
    vec![layer(i.sized(s, 1.0, Curve::four(0.25, 0.15, 1.0, 0.7, mix(1.0, i.end(), 0.3), i.end())), ramp)]
}

/// Cartoon flame: flat flame shapes, yellow at their root to the colour, flicking up.
fn cartoon_flame(i: &In<'_>) -> Vec<Spec> {
    let col = i.col;
    let ramp = i.ramp(stops(&[(tone(col, 0.65, [1.0, 0.95, 0.45]), 1.0), (tone(col, 0.3, [1.0, 0.85, 0.3]), 1.0), (col, 1.0), (deep(col, 0.25), 1.0)]));
    let s = Spec { material: m("toonFlame"), rotate: i.rotate(ROTATE_MOTION), aspect: 1.25, blend: i.blend(NORMAL), ..i.base.clone() };
    let curve = Curve::four(0.3, 0.15, 1.0, 0.6, mix(1.0, i.end(), 0.4), i.end());
    let outer = layer(i.sized(s.clone(), 1.0, curve), ramp);
    // The yellow heart of the fire: smaller, slower, shorter-lived, no ink, over the flames' roots.
    let heart = Spec {
        outline: None, speed_min: s.speed_min * 0.6, speed_max: s.speed_max * 0.7, life_min: s.life_min * 0.6, life_max: s.life_max * 0.7,
        ..s
    };
    let heart = layer(i.share(i.sized(heart, 0.5, curve), 0.8), stops(&[(tone(col, 0.7, [1.0, 0.97, 0.6]), 1.0), (tone(col, 0.45, [1.0, 0.9, 0.35]), 1.0)]));
    vec![outer, heart]
}

/// Cartoon star: flat stars that pop out spinning and fall away.
fn cartoon_star(i: &In<'_>) -> Vec<Spec> {
    let col = i.col;
    let ramp = i.ramp(stops(&[(tone(col, 0.35, WHITE), 1.0), (col, 1.0)]));
    let s = Spec { material: m("toonStar"), rotate: i.rotate(ROTATE_RANDOM), blend: i.blend(NORMAL), ..i.base.clone() };
    vec![layer(i.sized(s, 1.0, Curve::four(0.0, 0.12, 1.15, 0.3, 1.0, i.end())), ramp)]
}

/// Pixel: square pixels on a grid, stepping through their colours.
fn pixel(i: &In<'_>) -> Vec<Spec> {
    let col = i.col;
    let ramp = i.ramp(stops(&[(tone(col, 0.6, WHITE), 1.0), (tone(col, 0.25, WHITE), 1.0), (col, 1.0), (deep(col, 0.3), 1.0), (deep(col, 0.6), 1.0)]));
    let s = Spec { shape: SQUARE, rotate: ROTATE_FIXED, snap: 1.0, blend: i.blend(NORMAL), size_jitter: 0.0, ..i.base.clone() };
    vec![layer(i.sized(s, 1.0, Curve::three(1.0, 0.5, mix(1.0, i.end(), 0.5), i.end())), ramp)]
}
