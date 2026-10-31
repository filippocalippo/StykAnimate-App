//! The effects of one evaluated frame: per-pose stacks composed with the clips
//! active at its tick (`frameWithVfxTime`, `vfxRenderFrame`, `renderVfxOwner`),
//! connected groups (`connectedVfxGeometry`) and generated effects
//! (the clip loop of `collectLayers`).

use std::sync::Arc;

use super::{active, is_active, Clip, Clips, Effect, Stack, StackKey, Target};
use crate::doc::Document;
use crate::eval::Frame;

/// Connected groups nest at most this deep (`MAX_DEPTH` in src/vfx-connected.mjs).
pub const MAX_DEPTH: u32 = 16;

/// Everything a renderer draws for effects at one tick. Every stack holds only
/// active effects (enabled filters that change their input), resolved, in
/// render order. A frame has none when nothing is to be drawn
/// (`Frame::vfx` is `None`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FrameVfx {
    /// The camera image's stack: the scene's per-pose stack, then its clips.
    pub scene: Stack,
    /// By object slot, `None` for an object without effects; empty when no
    /// object has any. [`FrameVfx::object`] reads it.
    pub objects: Vec<Option<ObjectVfx>>,
    /// The slots whose connected group is drawn ([`ObjectVfx::attached`]), in
    /// the order groups composite: smaller groups first, so nested groups are
    /// filtered before the groups that contain them.
    pub roots: Vec<u32>,
    /// Generated effects inside their clip's range, in clip order.
    pub generators: Vec<Generator>,
    /// One line per connected group nested deeper than [`MAX_DEPTH`].
    pub warnings: Vec<String>,
}

impl FrameVfx {
    /// The effects of the object in `slot`, if it has any.
    pub fn object(&self, slot: u32) -> Option<&ObjectVfx> {
        self.objects.get(slot as usize).and_then(Option::as_ref)
    }
}

/// The effects of one object.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ObjectVfx {
    /// The stack of the object's own artwork. For a movieclip instance, its
    /// container stack: the clip's own scene effects at the instance's local
    /// time, then the instance's. When the object is the root of a connected
    /// group, the effects the group applies are not repeated here.
    pub figure: Stack,
    /// The connected group this object owns, if it covers its attached parts.
    pub attached: Option<Attached>,
    /// Node stacks by handle id, for the nodes of the object's own figure type.
    pub segments: Vec<(u32, Stack)>,
}

/// A connected group (`vfxScope`, "Whole figure"): one stack filtering the
/// owner and every figure attached to it, below or at any depth, composited
/// together. The renderer skips the group when the owner is hidden and leaves
/// hidden members out.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Attached {
    pub stack: Stack,
    /// The owner first, then attached figures breadth first, by slot.
    pub members: Vec<u32>,
}

/// A generated effect inside its clip's range: the parameters a generator
/// compiles, never simulated here.
#[derive(Clone, Debug, PartialEq)]
pub struct Generator {
    /// The clip, by position in `Clips::clips`.
    pub clip: u32,
    /// The effect's position in its clip (generator seeds depend on it).
    pub index: u32,
    pub target: Target,
    /// Keys sampled at the tick, or just before the clip's end.
    pub effect: Arc<Effect>,
    /// Opacity: the clip's strength, its fades and the effect's strength.
    pub alpha: f64,
    /// When the effect starts: the clip's start plus the effect's start delay.
    pub start: f64,
}

/// The filters `clip` applies to its target at `tick` (`renderVfxOwner`),
/// sampled with its strength and fades; `None` when it applies nothing. A node
/// clip scoped to another figure type than `figure_type` is skipped.
fn applied(clip: &Clip, tick: f64, figure_type: Option<u32>) -> Option<Vec<Arc<Effect>>> {
    if !clip.enabled || !clip.contains(tick) || clip.strength == 0.0 {
        return None;
    }
    if let Target::Segment { figure_type: Some(scope), .. } = clip.target
        && Some(scope) != figure_type
    {
        return None;
    }
    if !clip.has_filters() {
        return None;
    }
    Some(clip.sample(tick, true).into_iter().filter(|effect| !effect.kind().is_generator()).collect())
}

fn extend_active(stack: &mut Stack, effects: &[Arc<Effect>]) {
    stack.extend(active(effects).cloned());
}

fn add_segment(segments: &mut Vec<(u32, Stack)>, handle: u32, effects: &[Arc<Effect>]) {
    match segments.iter_mut().find(|(h, _)| *h == handle) {
        Some((_, stack)) => extend_active(stack, effects),
        None => {
            let mut stack = Vec::new();
            extend_active(&mut stack, effects);
            segments.push((handle, stack));
        }
    }
}

/// What one object contributes before connected groups are planned.
struct Owner {
    vfx: ObjectVfx,
    // Export also sees active unused scopes; drawing still uses only ObjectVfx.
    export_active: bool,
    /// `_stykVfxScope === 1` after clips (a clip including attached parts sets it).
    scope: bool,
    /// The connected stack before `activeVfx` (its identities leave the root's own stack).
    connected: Vec<Arc<Effect>>,
}

impl Owner {
    /// Whether the object owns a connected group (before the depth limit).
    fn roots(&self) -> bool {
        self.scope && self.connected.iter().any(|effect| is_active(effect))
    }
}

/// The effects of `frame` (evaluated at `frame.tick` from `doc`), or `None`
/// when nothing is to be drawn.
pub fn evaluate(doc: &Document, frame: &Frame) -> Option<Arc<FrameVfx>> {
    evaluate_with(doc, frame, true, None)
}

/// Capture export metadata in the same owner/clip sampling pass, without
/// retaining an otherwise-empty rendered FrameVfx or resampling effects.
pub(crate) fn evaluate_for_export(doc: &Document, frame: &Frame, export: &mut Vec<bool>) -> Option<Arc<FrameVfx>> {
    evaluate_with(doc, frame, true, Some(export))
}

/// `vfxRenderFrame` inherits retained source filters, while the generated-effect
/// census reads only the local document and its nested movieclip definitions.
pub(crate) fn inherited_filters(doc: &Document, frame: &Frame, export: &mut Vec<bool>) -> Option<Arc<FrameVfx>> {
    evaluate_with(doc, frame, false, Some(export))
}

fn evaluate_with(doc: &Document, frame: &Frame, include_generators: bool, export: Option<&mut Vec<bool>>) -> Option<Arc<FrameVfx>> {
    let tick = frame.tick;
    let clips = doc.vfx_clips.as_deref();
    let mut out = FrameVfx::default();
    if let Some(pose) = &frame.pose_vfx {
        extend_active(&mut out.scene, pose.figure());
    }
    for clip in clips.into_iter().flat_map(Clips::of_scene) {
        if let Some(effects) = applied(clip, tick, None) {
            extend_active(&mut out.scene, &effects);
        }
    }
    let mut owners: Vec<Option<Owner>> = frame.objects.iter().map(|object| owner(doc, clips, object, tick, export.is_some())).collect();
    if let Some(export) = export {
        export.clear();
        export.extend(owners.iter().map(|owner| owner.as_ref().is_some_and(|owner| owner.export_active)));
    }
    if owners.iter().any(|o| o.as_ref().is_some_and(Owner::roots)) {
        connect(frame, &mut owners, &mut out);
    }
    out.objects = owners.into_iter().map(|o| o.map(|o| o.vfx).filter(|v| !v.figure.is_empty() || v.attached.is_some() || !v.segments.is_empty())).collect();
    if include_generators && let Some(clips) = clips {
        out.generators = generators(clips, tick, &|_| 0.0);
    }
    let empty = out.scene.is_empty() && out.generators.is_empty() && out.objects.iter().all(Option::is_none);
    if empty {
        return None;
    }
    if out.objects.iter().all(Option::is_none) {
        out.objects.clear();
    }
    Some(Arc::new(out))
}

/// The effects of an edit frame: a pose the editor evaluated itself, whose
/// stacks already hold its clips (`vfxRenderFrame`: `_stykVfx` composed per key,
/// `_vfxConnectedEffects`, a scope turned on by a clip, and the scene's
/// `_vfxTimelineScene` read into [`Frame::pose_vfx`]). Nothing is sampled
/// here, so nothing is applied twice; movieclip contents are evaluated by the
/// engine as in [`evaluate`]. `None` when nothing is to be drawn.
pub fn composed(doc: &Document, frame: &Frame) -> Option<Arc<FrameVfx>> {
    let has_vfx = frame.pose_vfx.is_some()
        || frame.objects.iter().any(|o| o.vfx.is_some() || o.vfx_connected.is_some() || doc.figure(o.figure).and_then(|f| f.movieclip.as_ref()).is_some_and(|clip| clip.prepared.has_vfx));
    if !has_vfx {
        return None;
    }
    let mut out = FrameVfx::default();
    if let Some(pose) = &frame.pose_vfx {
        extend_active(&mut out.scene, pose.figure());
    }
    let mut owners: Vec<Option<Owner>> = frame
        .objects
        .iter()
        .map(|object| {
            let mut owner = owner(doc, None, object, frame.tick, false)?;
            // `connectedStack`: the composed group stack, or the figure's own.
            if let Some(connected) = &object.vfx_connected {
                owner.connected = connected.to_vec();
            } else {
                owner.connected = object.vfx.as_deref().map_or(&[][..], |p| p.figure()).to_vec();
            }
            Some(owner)
        })
        .collect();
    if owners.iter().any(|o| o.as_ref().is_some_and(Owner::roots)) {
        connect(frame, &mut owners, &mut out);
    }
    out.objects = owners.into_iter().map(|o| o.map(|o| o.vfx).filter(|v| !v.figure.is_empty() || v.attached.is_some() || !v.segments.is_empty())).collect();
    if out.scene.is_empty() && out.objects.iter().all(Option::is_none) {
        return None;
    }
    if out.objects.iter().all(Option::is_none) {
        out.objects.clear();
    }
    Some(Arc::new(out))
}

/// One object's stacks: its per-pose stacks, then its clips in order.
fn owner(doc: &Document, clips: Option<&Clips>, object: &crate::doc::Object, tick: f64, capture_export: bool) -> Option<Owner> {
    let own_clips = clips.and_then(|c| c.by_uid.get(&object.uid).map(|_| c));
    let container = doc.figure(object.figure).and_then(|f| f.movieclip.as_ref());
    let inner = container.filter(|clip| clip.prepared.has_vfx).zip(object.clip_time);
    if object.vfx.is_none() && own_clips.is_none() && inner.is_none() {
        return None;
    }
    let pose_figure: &[Arc<Effect>] = object.vfx.as_deref().map_or(&[], |p| p.figure());
    let mut vfx = ObjectVfx::default();
    // Regular drawables retain all pose scopes. Movieclip drawables retain
    // their child's pose; the outer owner carries only container figure and
    // inner Scene stacks (movieclip-geometry.mjs), never container node scopes.
    let mut export_active = capture_export && object.vfx.as_ref().is_some_and(|pose| {
        if container.is_some() { active(pose.figure()).next().is_some() }
        else { pose.entries.iter().any(|(_, stack)| active(stack).next().is_some()) }
    });
    // A container composites the clip's own scene effects first (`buildMovieclipGeometrySteps`).
    if let Some((clip, local)) = inner
        && let Some(scene) = clip.prepared.evaluate_clip(clip.source_start + local).vfx
    {
        vfx.figure.extend(scene.scene.iter().cloned());
    }
    extend_active(&mut vfx.figure, pose_figure);
    export_active |= capture_export && !vfx.figure.is_empty();
    if container.is_none()
        && let Some(pose) = &object.vfx
    {
        for (key, stack) in &pose.entries {
            if let StackKey::Segment { figure_type: Some(scope), handle } = *key
                && scope == object.figure
            {
                add_segment(&mut vfx.segments, handle, stack);
            }
        }
    }
    let mut scope = object.vfx_scope;
    let mut connected: Vec<Arc<Effect>> = if object.vfx_scope { pose_figure.to_vec() } else { Vec::new() };
    for clip in own_clips.into_iter().flat_map(|c| c.of(object.uid)) {
        let Some(effects) = applied(clip, tick, Some(object.figure)) else { continue };
        export_active |= capture_export && (container.is_none() || matches!(clip.target, Target::Figure { .. })) && effects.iter().any(|effect| is_active(effect));
        match clip.target {
            Target::Figure { .. } => {
                extend_active(&mut vfx.figure, &effects);
                if clip.include_attached {
                    connected.extend(effects);
                    scope = true;
                }
            }
            // A container's nodes are not drawn: its clip's own artwork is.
            Target::Segment { figure_type: Some(_), handle, .. } if container.is_none() => add_segment(&mut vfx.segments, handle, &effects),
            // Unscoped node effects are saved under `*/handle`, which no renderer reads.
            _ => {}
        }
    }
    vfx.segments.retain(|(_, stack)| !stack.is_empty());
    Some(Owner { vfx, export_active, scope, connected })
}

/// Connected groups (`connectedVfxGeometry`): each object whose scope covers
/// its attached parts and whose connected stack is active owns a group of
/// itself and its descendants by join, unless scopes nest deeper than
/// [`MAX_DEPTH`]. The root's own stack drops the effects the group applies.
fn connect(frame: &Frame, owners: &mut [Option<Owner>], out: &mut FrameVfx) {
    let count = frame.objects.len();
    let mut children: Vec<Vec<u32>> = vec![Vec::new(); count];
    for (slot, object) in frame.objects.iter().enumerate() {
        if let Some(join) = object.join
            && (join.slot as usize) < count
        {
            children[join.slot as usize].push(slot as u32);
        }
    }
    // A scope counts even on an object without effects.
    let scope = |slot: usize| owners[slot].as_ref().map_or(frame.objects[slot].vfx_scope, |o| o.scope);
    // `scopeDepths`: the number of scopes from a free figure down to each object.
    let mut depth: Vec<Option<u32>> = vec![None; count];
    let mut queue: Vec<u32> = (0..count as u32).filter(|&slot| frame.objects[slot as usize].join.is_none()).collect();
    let mut at = 0;
    while at < queue.len() {
        let slot = queue[at] as usize;
        at += 1;
        if depth[slot].is_some() {
            continue;
        }
        let parent = frame.objects[slot].join.and_then(|join| depth.get(join.slot as usize).copied().flatten()).unwrap_or(0);
        depth[slot] = Some(parent + scope(slot) as u32);
        queue.extend_from_slice(&children[slot]);
    }
    let mut groups: Vec<(usize, Vec<u32>)> = Vec::new();
    let mut seen = vec![false; count];
    for slot in 0..count {
        if !owners[slot].as_ref().is_some_and(Owner::roots) {
            continue;
        }
        if depth[slot].is_some_and(|d| d > MAX_DEPTH) {
            out.warnings.push(format!("Connected VFX ({}): Connected VFX support at most {MAX_DEPTH} nested groups.", frame.objects[slot].uid));
            continue;
        }
        // `descendants`: breadth first through joins.
        seen[slot] = true;
        let mut members = vec![slot as u32];
        let mut next = 0;
        while next < members.len() {
            for &child in &children[members[next] as usize] {
                if !seen[child as usize] {
                    seen[child as usize] = true;
                    members.push(child);
                }
            }
            next += 1;
        }
        for &member in &members {
            seen[member as usize] = false;
        }
        groups.push((slot, members));
    }
    // Smaller groups first (a stable sort, as `roots.sort` by member count).
    groups.sort_by_key(|(_, members)| members.len());
    for (root, members) in groups {
        let Some(Owner { vfx, connected, .. }) = owners[root].as_mut() else { continue };
        vfx.figure.retain(|effect| !connected.iter().any(|c| c.id == effect.id));
        vfx.attached = Some(Attached { stack: active(connected).cloned().collect(), members });
        out.roots.push(root as u32);
    }
}

/// The generated effects drawn at `tick` (the clip loop of `collectLayers`):
/// enabled clips with strength that hold a generator, from their start until
/// their end plus `tail(clip)` ticks (particles outlive their clip by their
/// lifetime; the generator compiler knows by how much). Each generator effect
/// that is enabled, visible and past its start delay is listed with its keys
/// sampled at `tick` (at most just before the clip's end) and its opacity.
/// Whether its target is present is the generator's to check.
pub fn generators(clips: &Clips, tick: f64, tail: &dyn Fn(&Clip) -> f64) -> Vec<Generator> {
    let mut out = Vec::new();
    for (index, clip) in clips.clips.iter().enumerate() {
        // `generatorClipActiveAt`.
        if !clip.enabled || clip.strength == 0.0 || !clip.has_generators() || tick < clip.start {
            continue;
        }
        if let Some(duration) = clip.duration
            && tick >= clip.start + duration + tail(clip)
        {
            continue;
        }
        let strength = clip.strength
            * match clip.duration {
                Some(duration) => clip.fade((tick - clip.start).clamp(0.0, duration)),
                None => 1.0,
            };
        if strength <= 0.0 {
            continue;
        }
        let at = match clip.duration {
            Some(duration) => tick.min(clip.start + duration - 1e-6),
            None => tick,
        };
        for (position, effect) in clip.sample(at, false).into_iter().enumerate() {
            if !effect.kind().is_generator() || !effect.enabled {
                continue;
            }
            let alpha = strength * effect.params.effect_strength();
            let delay = effect.params.delay();
            if alpha <= 0.0 || clip.duration.is_some_and(|duration| delay >= duration) || tick < clip.start + delay {
                continue;
            }
            out.push(Generator { clip: index as u32, index: position as u32, target: clip.target, start: clip.start + delay, alpha, effect });
        }
    }
    out
}
