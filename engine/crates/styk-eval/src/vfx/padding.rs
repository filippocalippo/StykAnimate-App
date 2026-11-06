//! How far effects reach beyond their artwork (`vfxPadding`,
//! `vfxSamplingPadding`) and the working surfaces an executor keeps
//! (`vfxWorkingSlots`), in src/vfx.mjs.

use std::sync::Arc;

use super::paint::js_round;
use super::registry::{BlurMode, OutlinePlacement, Params};
use super::{active, Effect};

/// `blurPadding`: the reach of the executors' three box passes at their
/// downsample factor (with its interpolation footprint), or, for artwork
/// bounds, at least three radii.
fn blur_padding(radius: f64, sampling: bool) -> f64 {
    if radius <= 0.0 {
        return 0.0;
    }
    let factor = (radius / 20.0).ceil().max(1.0);
    let kernel = js_round(radius / factor * 0.57735).clamp(1.0, 128.0);
    let footprint = 3.0 * kernel * factor + if factor > 1.0 { 2.0 * factor } else { 0.0 };
    if sampling { footprint } else { (radius * 3.0).max(footprint) }
}

/// `stackPadding`: per active effect, its reach rounded up, summed.
fn stack(stack: &[Arc<Effect>], scale: f64, extent: f64, sampling: bool) -> f64 {
    let mut n = 0.0;
    for effect in active(stack) {
        let pad = match &effect.params {
            Params::Blur(p) if p.mode != BlurMode::Gaussian => (p.radius * scale * (if sampling { 1.0 } else { 3.0 })) + (if sampling { 2.0 } else { 0.0 }),
            Params::Blur(p) => blur_padding(p.radius * scale, sampling),
            Params::Glow(p) => blur_padding(p.radius * scale, sampling) + p.spread * scale,
            Params::Bloom(p) => blur_padding(p.radius * scale, sampling),
            Params::Shadow(p) => blur_padding(p.radius * scale, sampling) + p.spread * scale + p.offset_x.abs().max(p.offset_y.abs()) * scale,
            Params::Outline(p) => p.width * scale,
            Params::Pixelate(p) => 1f64.max(p.size * scale).max(if p.linked { p.size } else { p.size_y } * scale),
            Params::RgbSplit(p) => p.amount * p.red.abs().max(p.green.abs()).max(p.blue.abs()) * scale,
            Params::Turbulence(p) => p.amount * scale,
            Params::Wave(p) => p.strength.abs() * scale,
            Params::Shockwave(p) => p.strength.abs() * scale,
            Params::Crt(p) => p.chromatic * scale + p.curvature * extent,
            _ => 0.0,
        };
        n += pad.ceil();
    }
    n
}

/// `vfxPadding`: how far the active effects of `stack` extend artwork bounds,
/// in pixels, for artwork drawn at `scale`; `extent` is the longest side of the
/// surface (curved CRT displaces by a fraction of it).
pub fn padding(effects: &[Arc<Effect>], scale: f64, extent: f64) -> f64 {
    stack(effects, scale, extent, false)
}

/// `vfxSamplingPadding`: the neighbourhood the executors sample, which can be
/// smaller than [`padding`]. A curved CRT keeps the artwork padding.
pub fn sampling_padding(effects: &[Arc<Effect>], scale: f64, extent: f64) -> f64 {
    if active(effects).any(|effect| matches!(&effect.params, Params::Crt(p) if p.curvature != 0.0)) {
        return padding(effects, scale, extent);
    }
    stack(effects, scale, extent, true)
}

/// `vfxWorkingSlots`: the executor slots one filtered surface needs, in the
/// order the editor lists them (its GPU and CPU lists are the same). Empty
/// when no effect is active.
pub fn working_slots(effects: &[Arc<Effect>]) -> Vec<u8> {
    let list: Vec<&Arc<Effect>> = active(effects).collect();
    if list.is_empty() {
        return Vec::new();
    }
    let mut slots = vec![0u8, 1];
    let add = |slots: &mut Vec<u8>, slot: u8| {
        if !slots.contains(&slot) {
            slots.push(slot);
        }
    };
    let mut multiple = list.len() > 1;
    for effect in list {
        let p = &effect.params;
        if p.effect_strength() < 1.0 {
            add(&mut slots, 7);
            multiple = true;
        }
        if matches!(p, Params::Glow(_) | Params::Shadow(_) | Params::Outline(_) | Params::Bloom(_)) {
            add(&mut slots, 4);
            multiple = true;
        }
        if matches!(p, Params::Outline(o) if o.mode == OutlinePlacement::Center) {
            add(&mut slots, 5);
        }
        if matches!(p, Params::Blur(b) if b.mode == BlurMode::Gaussian) || matches!(p, Params::Glow(_) | Params::Shadow(_) | Params::Bloom(_)) {
            multiple = true;
        }
    }
    if multiple {
        add(&mut slots, 2);
    }
    slots
}
