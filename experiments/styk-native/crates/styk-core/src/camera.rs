//! Camera motion presets (src/camera-motion.mjs): shake, handheld, wobble,
//! impact and zoom pulse add a deterministic impulse to the authored camera.

use crate::doc::{Camera, CameraMotionClip};

fn smooth(t: f64) -> f64 {
    t * t * (3.0 - 2.0 * t)
}

fn hash(n: f64, seed: i32) -> f64 {
    let mut x = (n as i64 as i32) ^ seed;
    x = (x ^ ((x as u32) >> 16) as i32).wrapping_mul(0x45d9f3b);
    x = (x ^ ((x as u32) >> 16) as i32).wrapping_mul(0x45d9f3b);
    ((x ^ ((x as u32) >> 16) as i32) as u32) as f64 / 2147483647.5 - 1.0
}

fn noise(t: f64, seed: i32) -> f64 {
    let i = t.floor();
    hash(i, seed) + (hash(i + 1.0, seed) - hash(i, seed)) * smooth(t - i)
}

struct Impulse {
    x: f64,
    y: f64,
    rotation: f64,
    zoom: f64,
}

fn sample(clips: &[CameraMotionClip], tick: f64, fps: f64) -> Impulse {
    let (mut x, mut y, mut rotation, mut log_zoom) = (0.0, 0.0, 0.0, 0.0);
    for clip in clips {
        let age = tick - clip.start;
        if clip.kind == "follow" || !clip.enabled || age < 0.0 || age >= clip.duration || clip.muted.iter().any(|r| tick >= r.0 && tick < r.1) {
            continue;
        }
        let p = |k: &str, d: f64| clip.params.get(k).copied().unwrap_or(d);
        let u = age / clip.duration;
        let time = age / fps;
        let phase = p("phase", 0.0).to_radians();
        let (fade_in, fade_out) = (p("fadeIn", 2.0), p("fadeOut", 4.0));
        let envelope = p("strength", 1.0)
            * (if fade_in != 0.0 { smooth((age / fade_in).min(1.0)) } else { 1.0 })
                .min(if fade_out != 0.0 { smooth(((clip.duration - age) / fade_out).min(1.0)) } else { 1.0 });
        let frequency = p("frequency", 8.0);
        let (nx, ny, nr, nz);
        match clip.kind.as_str() {
            "impact" => {
                let kick = (time * frequency * 2.0 * std::f64::consts::PI).cos() * (-p("recovery", 5.0) * u).exp() * (1.0 - smooth(u));
                let direction = p("direction", 0.0).to_radians();
                nx = kick * direction.cos();
                ny = kick * direction.sin();
                nr = kick;
                nz = kick;
            }
            "pulse" => {
                nx = 0.0;
                ny = 0.0;
                nr = 0.0;
                nz = (std::f64::consts::PI * u).sin().powi(2);
            }
            "wobble" => {
                let a = time * frequency * 2.0 * std::f64::consts::PI + phase;
                nx = a.sin();
                ny = (a + std::f64::consts::PI / 2.0).sin();
                nr = a.sin();
                nz = a.sin();
            }
            _ => {
                let a = time * frequency + phase / (2.0 * std::f64::consts::PI);
                let roughness = p("roughness", 0.5);
                let seed = p("seed", 1.0) as i32;
                let s = |seed: i32| (noise(a, seed) + roughness * 0.5 * noise(a * 2.17, seed + 91)) / (1.0 + roughness * 0.5);
                nx = s(seed);
                ny = s(seed + 17);
                nr = s(seed + 43);
                nz = s(seed + 71);
            }
        }
        x += envelope * p("moveX", 12.0) * nx;
        y += envelope * p("moveY", 12.0) * ny;
        rotation += envelope * p("roll", 1.0).to_radians() * nr;
        log_zoom += envelope * p("zoom", 0.0).ln_1p() * nz;
    }
    Impulse { x, y, rotation, zoom: log_zoom.clamp(-8.0, 8.0).exp() }
}

/// `cameraAtTime` without follow clips: the authored camera plus the impulse.
pub fn at_time(camera: Option<Camera>, clips: &[CameraMotionClip], tick: f64, fps: f64) -> Option<Camera> {
    if clips.is_empty() {
        return camera;
    }
    let d = sample(clips, tick, fps);
    if d.x == 0.0 && d.y == 0.0 && d.rotation == 0.0 && d.zoom == 1.0 {
        return camera;
    }
    let c = match camera {
        Some(c) if !c.is_default => c,
        _ => Camera { x: 0.0, y: 0.0, scale: 1.0, angle: 0.0, is_default: false },
    };
    let scale = c.scale / d.zoom;
    let angle = c.angle + d.rotation;
    Some(Camera {
        x: c.x + scale * (angle.cos() * d.x - angle.sin() * d.y),
        y: c.y + scale * (angle.sin() * d.x + angle.cos() * d.y),
        scale,
        angle,
        is_default: false,
    })
}
