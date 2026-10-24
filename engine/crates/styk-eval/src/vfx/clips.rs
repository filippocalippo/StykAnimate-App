//! Effect clips (`_styk.vfxClips`, src/vfx-clips.mjs): effects applied to a
//! target over a range of ticks, with a strength, fades and keys per parameter.

use std::collections::HashMap;
use std::sync::Arc;

use super::{paint, Effect, ParamValue};
use crate::doc::Easing;
use crate::eval::eased_progress;

/// What a clip applies to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Target {
    /// The camera image.
    Scene,
    /// A figure instance (or movieclip container) by unique id.
    Figure { uid: u32 },
    /// One node of an instance. Without a figure type (`*`) it is never drawn;
    /// with another figure's type it is skipped.
    Segment { uid: u32, handle: u32, figure_type: Option<u32> },
}

impl Target {
    pub fn uid(&self) -> Option<u32> {
        match self {
            Target::Scene => None,
            Target::Figure { uid } | Target::Segment { uid, .. } => Some(*uid),
        }
    }
}

/// One key of a parameter (`{tick, value, interpolation, bezier}`), in clip-local ticks.
#[derive(Clone, Debug, PartialEq)]
pub struct Key {
    pub tick: f64,
    pub value: ParamValue,
    /// The outgoing curve.
    pub easing: Easing,
}

/// What a channel animates.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Field {
    /// `vfx1:type:id:enabled`, 0 or 1.
    Enabled,
    /// A parameter, by position in [`super::Kind::specs`].
    Param(usize),
}

/// The keys of one property of one effect of a clip (`clip.keys[property]`).
#[derive(Clone, Debug, PartialEq)]
pub struct Channel {
    /// The effect, by position in [`Clip::effects`].
    pub effect: usize,
    pub field: Field,
    /// Holds between keys (switches, options, seeds, `enabled`).
    pub discrete: bool,
    /// Interpolates as a colour.
    pub color: bool,
    /// Ordered by tick, never empty.
    pub keys: Arc<[Key]>,
}

/// One effect clip.
#[derive(Clone, Debug, PartialEq)]
pub struct Clip {
    pub id: Arc<str>,
    pub target: Target,
    pub start: f64,
    /// `None`: "Always", from tick 0 for the whole animation.
    pub duration: Option<f64>,
    /// Clip-local ticks skipped at the start (a trimmed start keeps its keys' phase).
    pub offset: f64,
    pub enabled: bool,
    /// 0–1, multiplied into each effect's strength with the fades.
    pub strength: f64,
    pub fade_in: f64,
    pub fade_out: f64,
    /// A figure clip that covers the figure's attached parts too.
    pub include_attached: bool,
    /// The effects at their unkeyed values, in render order.
    pub effects: Vec<Arc<Effect>>,
    /// Keys, in saved order.
    pub channels: Vec<Channel>,
}

impl Clip {
    /// `clipContains`.
    pub fn contains(&self, tick: f64) -> bool {
        match self.duration {
            None => true,
            Some(duration) => tick >= self.start && tick < self.start + duration,
        }
    }

    /// `clipTime`: the clip-local tick keys are sampled at.
    pub fn time(&self, tick: f64) -> f64 {
        (tick - self.start + self.offset).max(0.0)
    }

    /// `vfxFadeAt`: the fade envelope `elapsed` ticks after the clip's start.
    pub fn fade(&self, elapsed: f64) -> f64 {
        let Some(duration) = self.duration else { return 1.0 };
        let fade_in = if self.fade_in != 0.0 { (elapsed / self.fade_in).clamp(0.0, 1.0) } else { 1.0 };
        let fade_out = if self.fade_out != 0.0 { ((duration - elapsed) / self.fade_out).clamp(0.0, 1.0) } else { 1.0 };
        fade_in.min(fade_out)
    }

    pub fn has_filters(&self) -> bool {
        self.effects.iter().any(|effect| !effect.kind().is_generator())
    }

    pub fn has_generators(&self) -> bool {
        self.effects.iter().any(|effect| effect.kind().is_generator())
    }

    /// `sampleVfxClip`: the effects with their keys sampled at `tick`. With
    /// `envelope`, each effect's strength is multiplied by the clip's strength
    /// and fades (`effectStrength × strength × fade`). Unkeyed effects are shared.
    pub fn sample(&self, tick: f64, envelope: bool) -> Vec<Arc<Effect>> {
        let age = self.time(tick);
        let strength = if envelope { self.strength * self.fade(tick - self.start) } else { 1.0 };
        self.effects
            .iter()
            .enumerate()
            .map(|(index, effect)| {
                let mut result: Option<Effect> = None;
                for channel in self.channels.iter().filter(|channel| channel.effect == index) {
                    let value = sample_keys(&channel.keys, age, channel.discrete, channel.color);
                    let sampled = result.get_or_insert_with(|| (**effect).clone());
                    match channel.field {
                        Field::Enabled => sampled.enabled = truthy(&value),
                        Field::Param(i) => {
                            sampled.params.set(i, &value);
                        }
                    }
                }
                if strength != 1.0 {
                    let scaled = result.get_or_insert_with(|| (**effect).clone());
                    scaled.params.set_effect_strength(scaled.params.effect_strength() * strength);
                }
                result.map_or_else(|| effect.clone(), Arc::new)
            })
            .collect()
    }

    /// `vfxClipActiveAt`: whether the inspector lists the clip "At playhead":
    /// enabled, with strength, in range, and with an effect whose keyed switch
    /// is on and keyed strength above zero. Fades and parameters are not consulted.
    pub fn active_at(&self, tick: f64) -> bool {
        if !self.enabled || self.strength == 0.0 || !self.contains(tick) {
            return false;
        }
        let time = self.time(tick);
        let keyed = |index: usize, field: Field| self.channels.iter().find(|c| c.effect == index && c.field == field).map(|c| sample_keys(&c.keys, time, c.discrete, c.color));
        self.effects.iter().enumerate().any(|(index, effect)| {
            let enabled = keyed(index, Field::Enabled).map_or(effect.enabled, |value| truthy(&value));
            let strength = match keyed(index, Field::Param(0)) {
                Some(ParamValue::Num(n)) => n,
                _ => effect.params.effect_strength(),
            };
            enabled && strength > 0.0
        })
    }
}

fn truthy(value: &ParamValue) -> bool {
    match value {
        ParamValue::Num(n) => *n != 0.0 && !n.is_nan(),
        ParamValue::Paint(_) => true,
    }
}

/// `sampleVfxKeys`: the value at clip-local `tick`. Before the first key and
/// after the last the nearest key holds; discrete values hold until the next
/// key; numbers interpolate along the earlier key's easing, colours with
/// [`paint::interpolate`]. `keys` must not be empty.
pub fn sample_keys(keys: &[Key], tick: f64, discrete: bool, color: bool) -> ParamValue {
    let low = keys.partition_point(|key| key.tick <= tick).saturating_sub(1);
    let a = &keys[low];
    let Some(b) = keys.get(low + 1) else { return a.value.clone() };
    if tick <= a.tick || discrete {
        return a.value.clone();
    }
    let t = eased_progress(Some(&a.easing), (tick - a.tick) / (b.tick - a.tick));
    if color {
        return paint::interpolate(&a.value, &b.value, t);
    }
    match (&a.value, &b.value) {
        (ParamValue::Num(x), ParamValue::Num(y)) => ParamValue::Num(x + (y - x) * t),
        _ => a.value.clone(),
    }
}

/// Every clip of a document, indexed by target (`indexFor`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Clips {
    /// In saved order: later clips apply after earlier ones.
    pub clips: Vec<Arc<Clip>>,
    /// Scene clips, by position in `clips`.
    pub scene: Vec<u32>,
    /// Figure and node clips by target uid, by position in `clips`.
    pub by_uid: HashMap<u32, Vec<u32>>,
}

impl Clips {
    pub fn new(clips: Vec<Arc<Clip>>) -> Clips {
        let mut scene = Vec::new();
        let mut by_uid: HashMap<u32, Vec<u32>> = HashMap::new();
        for (i, clip) in clips.iter().enumerate() {
            match clip.target.uid() {
                None => scene.push(i as u32),
                Some(uid) => by_uid.entry(uid).or_default().push(i as u32),
            }
        }
        Clips { clips, scene, by_uid }
    }

    /// The clips for `uid`, in saved order.
    pub fn of(&self, uid: u32) -> impl Iterator<Item = &Arc<Clip>> {
        self.by_uid.get(&uid).into_iter().flatten().map(|&i| &self.clips[i as usize])
    }

    pub fn of_scene(&self) -> impl Iterator<Item = &Arc<Clip>> {
        self.scene.iter().map(|&i| &self.clips[i as usize])
    }
}
