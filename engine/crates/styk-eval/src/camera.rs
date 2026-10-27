//! Camera motion presets (src/camera-motion.mjs): shake, handheld, wobble,
//! impact and zoom pulse add a deterministic impulse to the authored camera.
//! Computed with V8's `Math` (styk-math, D16): the editor bakes and edits cameras through it.

use crate::doc::{Camera, CameraMotionClip};

fn smooth(t: f64) -> f64 {
    t * t * (3.0 - 2.0 * t)
}

/// `x | 0`: ECMAScript's ToInt32 (finite values below 2^63, as seeds and noise cells are).
fn int32(x: f64) -> i32 {
    x as i64 as i32
}

fn hash(n: f64, seed: f64) -> f64 {
    let mut x = int32(n) ^ int32(seed);
    x = (x ^ ((x as u32) >> 16) as i32).wrapping_mul(0x45d9f3b);
    x = (x ^ ((x as u32) >> 16) as i32).wrapping_mul(0x45d9f3b);
    ((x ^ ((x as u32) >> 16) as i32) as u32) as f64 / 2147483647.5 - 1.0
}

fn noise(t: f64, seed: f64) -> f64 {
    let i = t.floor();
    hash(i, seed) + (hash(i + 1.0, seed) - hash(i, seed)) * smooth(t - i)
}

/// What the non-follow presets add to the finished shot (`sampleCameraMotion`): output
/// pixels, radians and a zoom factor.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Impulse {
    pub x: f64,
    pub y: f64,
    pub rotation: f64,
    pub zoom: f64,
}

/// `sampleCameraMotion(state, tick, fps)` with V8's `Math` (styk-math) in the editor's order of
/// operations, since the editor stores cameras it computes from it; `None` when no clip moves
/// the camera at `tick`.
pub fn impulse(clips: &[CameraMotionClip], tick: f64, fps: f64) -> Option<Impulse> {
    use std::f64::consts::PI;
    let (mut x, mut y, mut rotation, mut log_zoom) = (0.0, 0.0, 0.0, 0.0);
    for clip in clips {
        let age = tick - clip.start;
        if clip.kind == "follow" || !clip.enabled || age < 0.0 || age >= clip.duration || clip.muted.iter().any(|r| tick >= r.0 && tick < r.1) {
            continue;
        }
        let p = |k: &str, d: f64| clip.params.get(k).copied().unwrap_or(d);
        let u = age / clip.duration;
        let time = age / fps;
        let phase = p("phase", 0.0) * PI / 180.0;
        let (fade_in, fade_out) = (p("fadeIn", 2.0), p("fadeOut", 4.0));
        let envelope = p("strength", 1.0)
            * (if fade_in != 0.0 { smooth((age / fade_in).min(1.0)) } else { 1.0 })
                .min(if fade_out != 0.0 { smooth(((clip.duration - age) / fade_out).min(1.0)) } else { 1.0 });
        let frequency = p("frequency", 8.0);
        let (nx, ny, nr, nz);
        match clip.kind.as_str() {
            "impact" => {
                // The final smooth taper returns exactly to neutral at the boundary.
                let kick = styk_math::cos(time * frequency * 2.0 * PI) * styk_math::exp(-p("recovery", 5.0) * u) * (1.0 - smooth(u));
                let direction = p("direction", 0.0);
                nx = kick * styk_math::cos(direction * PI / 180.0);
                ny = kick * styk_math::sin(direction * PI / 180.0);
                nr = kick;
                nz = kick;
            }
            "pulse" => {
                nx = 0.0;
                ny = 0.0;
                nr = 0.0;
                // `Math.sin(Math.PI * u) ** 2`, which V8 rounds as the product.
                let s = styk_math::sin(PI * u);
                nz = s * s;
            }
            "wobble" => {
                let a = time * frequency * 2.0 * PI + phase;
                nx = styk_math::sin(a);
                ny = styk_math::sin(a + PI / 2.0);
                nr = styk_math::sin(a);
                nz = styk_math::sin(a);
            }
            _ => {
                let a = time * frequency + phase / (2.0 * PI);
                let roughness = p("roughness", 0.5);
                let seed = p("seed", 1.0);
                let s = |seed: f64| (noise(a, seed) + roughness * 0.5 * noise(a * 2.17, seed + 91.0)) / (1.0 + roughness * 0.5);
                nx = s(seed);
                ny = s(seed + 17.0);
                nr = s(seed + 43.0);
                nz = s(seed + 71.0);
            }
        }
        x += envelope * p("moveX", 12.0) * nx;
        y += envelope * p("moveY", 12.0) * ny;
        rotation += envelope * p("roll", 1.0) * PI / 180.0 * nr;
        log_zoom += envelope * styk_math::log1p(p("zoom", 0.0)) * nz;
    }
    let zoom = styk_math::exp(log_zoom.clamp(-8.0, 8.0));
    // `!d.x && !d.y && !d.rotation && d.zoom === 1`: zero and NaN are both falsy.
    let falsy = |v: f64| v == 0.0 || v.is_nan();
    (!(falsy(x) && falsy(y) && falsy(rotation) && zoom == 1.0)).then_some(Impulse { x, y, rotation, zoom })
}

/// `cameraAtTime`'s composition: the camera `[x, y, scale, angle]` moved by the impulse, its
/// output-pixel displacement converted through the final inverse camera.
pub fn moved(camera: [f64; 4], d: &Impulse) -> [f64; 4] {
    let scale = camera[2] / d.zoom;
    let angle = camera[3] + d.rotation;
    let (cos, sin) = (styk_math::cos(angle), styk_math::sin(angle));
    [camera[0] + scale * (cos * d.x - sin * d.y), camera[1] + scale * (sin * d.x + cos * d.y), scale, angle]
}

/// `cameraAtTime` without follow clips: the authored camera plus the impulse.
pub fn at_time(camera: Option<Camera>, clips: &[CameraMotionClip], tick: f64, fps: f64) -> Option<Camera> {
    if clips.is_empty() {
        return camera;
    }
    let Some(d) = impulse(clips, tick, fps) else { return camera };
    let c = match camera {
        Some(c) if !c.is_default => c,
        _ => Camera { x: 0.0, y: 0.0, scale: 1.0, angle: 0.0, is_default: false, motion_offset: None },
    };
    let [x, y, scale, angle] = moved([c.x, c.y, c.scale, c.angle], &d);
    Some(Camera { x, y, scale, angle, is_default: false, motion_offset: c.motion_offset })
}
