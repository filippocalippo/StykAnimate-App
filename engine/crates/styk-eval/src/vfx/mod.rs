//! Visual-effect evaluation: which effects apply to what at one tick, and with
//! which parameter values (src/vfx.mjs, src/vfx-clips.mjs, src/vfx-connected.mjs).
//! Drawing them is the renderer's; see `docs/engine/vfx.md`.
//!
//! Effects come from two places. Per-pose stacks (`_stykVfx` on a pose object
//! or on the scene, [`Stacks`]) tween with the pose ([`interpolate`]). Effect
//! clips (`_styk.vfxClips`, [`Clips`]) apply over a range of ticks with their
//! own strength, fades and keys. [`evaluate`] composes both for an evaluated
//! frame into a [`FrameVfx`]: the scene stack, each object's stacks and its
//! connected group, and the generated effects, every effect resolved
//! ([`Effect`]) the way the editor hands it to an effect executor.

pub mod clips;
pub mod generated;
pub mod frame;
pub mod layers;
pub mod padding;
pub mod paint;
mod owner;
pub mod parity;
pub mod parse;
pub mod registry;
pub(crate) mod retained;

use std::sync::Arc;

pub use clips::{Channel, Clip, Clips, Field, Key, Target};
pub use frame::{evaluate, generators, Attached, FrameVfx, Generator, ObjectVfx};
pub use padding::{padding, sampling_padding, working_slots};
pub use owner::remap_owner;
pub use registry::{Color, Kind, Param, ParamKind, ParamValue, Params, Spec};

use crate::doc::Document;

/// One resolved effect (`resolvedVfx`): every parameter present and valid,
/// version 1 records already given their compatible defaults.
#[derive(Clone, Debug, PartialEq)]
pub struct Effect {
    /// Stable identity within its stack or clip; keys and tweens match on it.
    pub id: Arc<str>,
    pub enabled: bool,
    pub params: Params,
}

impl Effect {
    pub fn kind(&self) -> Kind {
        self.params.kind()
    }
}

/// An ordered effect stack: the first effect filters first.
pub type Stack = Vec<Arc<Effect>>;

/// Whether `activeVfx` keeps an effect: enabled, a filter, and not neutral.
pub fn is_active(effect: &Effect) -> bool {
    effect.enabled && !effect.kind().is_generator() && !effect.params.neutral()
}

/// `activeVfx`: the effects of `stack` an executor runs, in order.
pub fn active(stack: &[Arc<Effect>]) -> impl Iterator<Item = &Arc<Effect>> {
    stack.iter().filter(|effect| is_active(effect))
}

/// Where a per-pose stack applies (the keys of `_stykVfx`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum StackKey {
    /// `figure`: the whole figure, a movieclip container, or the scene.
    Figure,
    /// `<figure type>/<handle>` or `*/<handle>`: one node. Renderers look node
    /// stacks up by the object's own figure type, so `*` stacks are never drawn.
    Segment { figure_type: Option<u32>, handle: u32 },
}

/// The per-pose effects of an object or of the scene (`_stykVfx`), in saved order.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Stacks {
    pub entries: Vec<(StackKey, Arc<[Arc<Effect>]>)>,
}

impl Stacks {
    pub fn get(&self, key: StackKey) -> Option<&[Arc<Effect>]> {
        self.entries.iter().find(|(k, _)| *k == key).map(|(_, stack)| &**stack)
    }

    /// The `figure` stack (empty when there is none).
    pub fn figure(&self) -> &[Arc<Effect>] {
        self.get(StackKey::Figure).unwrap_or(&[])
    }
}

/// `interpolateVfx`: the stacks of a pose tweened toward the next pose's at
/// `t` (the pose tween's own progress). Each effect of `a` whose identity and
/// type `b` also has interpolates its numbers (clamped to their range) and
/// colours; switches, options, seeds, order, membership and `enabled` come
/// from `a`. Effects only in `b` do not appear before their pose.
///
/// Values of property channels (`vfx1:*`, `vfxStack`, `vfxScope`) apply to the
/// result of this tween, before clips ([`crate::channels::scalar`]).
pub fn interpolate(a: &Arc<Stacks>, b: Option<&Arc<Stacks>>, t: f64) -> Arc<Stacks> {
    let Some(b) = b else { return a.clone() };
    if Arc::ptr_eq(a, b) || t == 0.0 {
        return a.clone();
    }
    let entries = a
        .entries
        .iter()
        .map(|(key, stack)| {
            let next = b.get(*key).unwrap_or(&[]);
            let tweened: Arc<[Arc<Effect>]> = stack
                .iter()
                .map(|effect| {
                    // A `Map` by identity: the last effect with an identity wins.
                    match next.iter().rev().find(|other| other.id == effect.id) {
                        Some(other) if other.kind() == effect.kind() => Arc::new(tween(effect, other, t)),
                        _ => effect.clone(),
                    }
                })
                .collect();
            (*key, tweened)
        })
        .collect();
    Arc::new(Stacks { entries })
}

fn tween(a: &Effect, b: &Effect, t: f64) -> Effect {
    let mut params = a.params.clone();
    for (i, spec) in a.kind().specs().iter().enumerate() {
        let value = match spec.kind {
            ParamKind::Integer | ParamKind::Toggle | ParamKind::Choice => continue,
            ParamKind::Color => paint::interpolate(&a.params.get(i), &b.params.get(i), t),
            ParamKind::Number => {
                let (ParamValue::Num(x), ParamValue::Num(y)) = (a.params.get(i), b.params.get(i)) else { continue };
                ParamValue::Num((x + (y - x) * t).min(spec.max).max(spec.min))
            }
        };
        params.set(i, &value);
    }
    Effect { id: a.id.clone(), enabled: a.enabled, params }
}

/// `documentHasVfx`: whether anything in the document carries effects (effect
/// clips, a per-pose stack on any pose or scene, a property channel of an
/// effect), its movieclips included. Saving to Pivot formats refuses such a
/// document. Presence counts, not activity: an empty `_stykVfx` counts.
pub fn document_has_vfx(doc: &Document) -> bool {
    has_own_vfx(doc) || doc.vfx_elsewhere || doc.figures.iter().any(|figure| figure.movieclip.as_ref().is_some_and(|clip| document_has_vfx(&clip.document)))
}

/// Whether evaluating `doc` itself can produce effects: clips, or stacks on
/// its poses. Movieclips are checked through their own prepared documents.
pub(crate) fn has_own_vfx(doc: &Document) -> bool {
    doc.vfx_clips.is_some() || doc.keyframes.iter().chain(doc.frame_sources.values()).any(|frame| frame.vfx.is_some() || frame.objects.iter().any(|object| object.vfx.is_some()))
}
