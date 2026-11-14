//! Particles: the general emitter, with every look and motion control.

use super::*;
use crate::vfx::registry::{DrawLayer, Emission, EmitShape, GeneratorBlend, ParticleLook, Particles};

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

pub(super) fn particles(p: &Particles, ctx: &Context) -> Vec<Spec> {
    let look = PARTICLE_LOOKS[(p.look.index() as usize).min(PARTICLE_LOOKS.len() - 1)];
    let v = p.variation;
    let burst = p.emission == Emission::Burst;
    let stage = ctx.scene && p.shape == EmitShape::Line && p.radius == 0.0;
    let emit_shape = if stage { STAGE } else { EMITTERS[p.shape.index() as usize] };
    let solid = look.solid || look.shape == Some(CHUNK);
    // Spark: a needle of light along its motion trailing a ribbon, white-hot at birth, cooling to the colour.
    let spark = p.look == ParticleLook::Spark;
    let col = paint_color(&p.color);
    let colors = if spark { paint_or(&p.color, stops(&[(tone(col, 0.3, WHITE), 1.0), (col, 1.0), (col, 1.0), (tone(col, 0.4, BLACK), 1.0)])) } else { paint_ramp(&p.color, 1.0) };
    // Gravity pulls toward its direction (90°: down); wind adds across.
    let (gy, gx) = super::super::fastmath::sin_cos(p.gravity_angle * DEG);
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
            gravity: p.gravity * gy,
            wind: p.wind + p.gravity * gx,
            drag: p.drag,
            turb: p.turbulence,
            turb_scale: 0.015,
            shape: if spark { SPARK } else { look.shape.unwrap_or(SPRITE) },
            material: look.material.map(material),
            softness: if spark { 0.0 } else { look.softness.unwrap_or(1.0) },
            stretch: if spark { p.stretch * 0.5 } else if look.shape == Some(STREAK) { p.stretch } else { look.stretch.unwrap_or(0.0) },
            blend: match p.blend {
                GeneratorBlend::Glow => ADD,
                GeneratorBlend::Solid => NORMAL,
                GeneratorBlend::Auto if solid => NORMAL,
                GeneratorBlend::Auto => AUTO,
            },
            // A spark is a needle: its size is its length's third, its width's half.
            size0: if spark { 0.5 } else { 1.0 },
            size1: if spark { 0.5 * p.end_size } else { p.end_size },
            size_jitter: v * 0.5,
            fade_in: p.fade_in,
            fade_out: p.fade,
            color_mode: p.color_mode.index() as f64,
            rotate: match p.rotation.index() {
                0 if spark => ROTATE_MOTION,
                0 => look.rotate.unwrap_or(ROTATE_RANDOM),
                r => r - 1,
            },
            spin: p.spin * DEG,
            spin_jitter: v,
            aspect: if spark { 3.4 } else { look.aspect.unwrap_or(1.0) },
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
            // A spark paints its colour and its glow is light: a faint one of its own, more with Glow halo.
            halo: if spark { Some(Halo { scale: 3.2, alpha: 0.3 + 0.45 * p.glow }) } else { (p.glow > 0.0).then_some(Halo { scale: 2.8, alpha: 0.45 * p.glow }) },
            outline: p.outline.then(|| Outline { width: p.outline_width, color: paint_color(&p.outline_color) }),
            echoes: (p.trail > 0).then_some(Echoes { count: p.trail, lag: 2.0, alpha: 0.6, size: 0.85 }),
            trail: (spark && p.trail == 0).then_some(Trail { length: 3.0, segments: 3, width: 0.55, alpha: 0.65, glow: 0.6, emissive: None }),
            emissive: spark.then_some(Curve::three(0.25, 0.5, 0.12, 0.05)),
            emit_shape,
            emit_radius: p.radius,
            collide: if p.ground { 1.0 } else { 0.0 },
            bounce: p.bounce,
            world: p.space == crate::vfx::registry::Space::LeaveTrail,
            body: emit_shape == BODY,
            burst_jitter: if burst { 2.0 } else { 0.0 },
            prewarm: if stage && !burst { 1.0 } else { 0.0 },
            keyed: true,
            ..Spec::default()
        },
        colors,
    )]
}

