//! Pose channels (`composePoseChannels` in src/animation-pose.mjs): figures, layers,
//! the camera and the scene take the pose their own key track samples at the tick,
//! in place of the native evaluation's.
//!
//! A figure or layer channel replaces every figure it owns (a figure channel owns its
//! figure; a layer channel the layer's figures that no figure channel owns) with that
//! figure's pose in the sampled frame. Joins are resolved again by identity: a figure
//! whose parent is gone, or no longer has the joint, stays where it was drawn; a joined
//! figure turns with its parent's joint when the parent's pose changed. Each layer keeps
//! its sampled pose's stacking order.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use super::{Channel, Compiled, KeyValue, Property, Target};
use crate::doc::{Camera, Document, Figure, Join, Keyframe, Object};
use crate::eval::{Frame, FrameRef, KeyRef, Seq};

/// Who owns a figure for pose channels (`owner(uid)`).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum Owner {
    Figure(u32),
    Layer(Arc<str>),
}

/// `buildVirtualPoseTrack`: the channel's keys as a native timeline of their source
/// poses, each lasting until the next key (hidden keys last nothing). A key without
/// `interpolation` keeps its source pose's easing. Camera and scene tracks drop figures.
pub(crate) fn track(doc: &Document, channel: &Channel) -> Seq {
    let fixed = matches!(channel.target, Target::Camera | Target::Scene);
    let mut keys: Vec<&super::Key> = channel.keys.iter().collect();
    // Stable: equal ticks keep hidden keys first.
    keys.sort_by(|a, b| a.tick.total_cmp(&b.tick).then((b.hidden as u8).cmp(&(a.hidden as u8))));
    let blank = Arc::new(crate::eval::blank_keyframe());
    let refs = keys
        .iter()
        .enumerate()
        .map(|(i, key)| {
            let id = match &key.value {
                KeyValue::Pose(Some(id)) => Some(id),
                _ => None,
            };
            // A missing source (the editor refuses such a file) is read as an empty pose.
            let (source, origin) = match id.and_then(|id| Some((doc.pose_source(id)?, id))) {
                Some((frame, id)) => (frame.clone(), Some(FrameRef::Source(id.clone()))),
                None => (blank.clone(), None),
            };
            let source = if fixed && !source.objects.is_empty() {
                let mut frame: Keyframe = (*source).clone();
                frame.objects.clear();
                frame.draw_order.clear();
                frame.slot_of.clear();
                Arc::new(frame)
            } else {
                source
            };
            let duration = if key.hidden {
                0
            } else {
                keys.get(i + 1).map_or(1.0, |next| (next.tick - key.tick).max(0.0)) as u32
            };
            KeyRef { easing: key.easing.or(source.easing), duration, frame: source, origin: if fixed { None } else { origin } }
        })
        .collect();
    Seq { keys: refs, version: doc.version, auto_easing: doc.auto_easing, ticks: keys.iter().map(|k| k.tick).collect() }
}

/// `maskedAt`: whether `tick` lies in one of the ordered `[start, end)` ranges.
pub(crate) fn masked_at(ranges: &[(f64, f64)], tick: f64) -> bool {
    let at = ranges.partition_point(|range| range.0 <= tick);
    at > 0 && tick < ranges[at - 1].1
}

/// `blankPoseFrame(baseFrame)`: nothing posed, the default camera, the first background.
fn blank(base: &Frame) -> Frame {
    Frame {
        tick: base.tick,
        retained_vfx_tick: base.retained_vfx_tick,
        objects: Vec::new(),
        draw_order: Vec::new(),
        origins: Vec::new(),
        camera: Some(Camera::default()),
        background: 0,
        background_b: 0,
        background_mix: 0.0,
        continuations: base.continuations.clone(),
        background_color: None,
        pose_vfx: None,
        vfx: None,
        export_vfx: Vec::new(),
        parallax: None,
    }
}

/// `orderedObjects`: the slots in drawing order, then any the order leaves out.
fn ordered(frame: &Frame) -> Vec<usize> {
    let mut seen = vec![false; frame.objects.len()];
    let mut out = Vec::with_capacity(frame.objects.len());
    for &slot in &frame.draw_order {
        let slot = slot as usize;
        if slot < seen.len() && !seen[slot] {
            seen[slot] = true;
            out.push(slot);
        }
    }
    out.extend((0..seen.len()).filter(|&slot| !seen[slot]));
    out
}

/// `handleOrientation`: the direction of joint `handle` of `object` (where a joined
/// figure hangs). `None` when the figure or the joint is missing.
fn handle_orientation(doc: &Document, object: Option<&Object>, handle: u32) -> Option<f64> {
    let object = object?;
    let figure = doc.figure(object.figure)?;
    if figure.origin.is_some() {
        return crate::origin::handle_orientation(figure, object, handle);
    }
    let index = if handle == 0 { 0 } else { *figure.plan.index_of.get(&handle)? as usize };
    let segment = figure.segments.get(index)?;
    let angle = object.angles.get(index).copied().unwrap_or(segment.angle);
    if handle == 0 {
        return Some(angle);
    }
    let bend = match &object.bends {
        Some(bends) => bends.get(index).copied().unwrap_or(0.0),
        None => segment.bend,
    };
    Some(angle + bend)
}

/// `nativeAppearance`: a replaced figure keeps the native evaluation's scale,
/// transparency, colour, depth and outline style (a pose track with `nativeProperties`).
fn native_appearance(doc: &Document, object: &Arc<Object>, native: Option<&Arc<Object>>) -> Arc<Object> {
    let Some(native) = native.filter(|native| native.figure == object.figure) else { return object.clone() };
    let mut out = (**object).clone();
    out.scale = native.scale;
    out.transparency = native.transparency;
    out.color = native.color;
    out.z_index = native.z_index;
    if object.style.is_some() || native.style.is_some() {
        let mut style = object.style.as_deref().cloned().unwrap_or_default();
        let from = native.style.as_deref();
        style.outline_color = from.and_then(|s| s.outline_color);
        style.outline_width = from.and_then(|s| s.outline_width);
        style.outline_opacity = from.and_then(|s| s.outline_opacity);
        out.style = super::scalar::nonempty(style);
        super::scalar::restyle(doc, &mut out);
    }
    Arc::new(out)
}

/// Where a composed figure came from: the native frame or a sampled one, and its slot there.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Source {
    Base,
    Sampled(usize),
}

struct Record {
    object: Arc<Object>,
    source: Source,
    slot: usize,
}

/// `composePoseChannels`.
pub(crate) fn compose(doc: &Document, compiled: &Compiled, base: Frame, tick: f64) -> Frame {
    let channels: Vec<(usize, &Channel)> = compiled.animation.channels.iter().enumerate().filter(|(_, c)| c.property == Property::Pose).collect();
    if channels.is_empty() {
        return base;
    }
    let mut sampled: Vec<Frame> = Vec::new();
    let mut replacements: Vec<(Owner, Source, bool)> = Vec::new();
    // The frame's own fields, which camera and scene tracks replace; figures come last.
    let mut result = Frame {
        tick: base.tick,
        retained_vfx_tick: base.retained_vfx_tick,
        objects: Vec::new(),
        draw_order: Vec::new(),
        camera: base.camera,
        background: base.background,
        background_b: base.background_b,
        background_mix: base.background_mix,
        origins: Vec::new(),
        continuations: base.continuations.clone(),
        background_color: base.background_color,
        pose_vfx: base.pose_vfx.clone(),
        vfx: base.vfx.clone(),
        export_vfx: Vec::new(),
        parallax: base.parallax.clone(),
    };
    for &(index, channel) in &channels {
        let frame = if masked_at(&channel.masked, tick) {
            None
        } else if channel.use_base_pose {
            Some(Source::Base)
        } else {
            // A figure's track tweens that figure alone (`sampleUids`).
            let only = match &channel.target {
                Target::Figure { uid } => Some(std::slice::from_ref(uid)),
                _ => None,
            };
            compiled.tracks[index].as_ref().and_then(|seq| crate::eval::sample_pose_track_only(doc, seq, tick, only)).map(|frame| {
                sampled.push(frame);
                Source::Sampled(sampled.len() - 1)
            })
        };
        let source = frame.unwrap_or_else(|| {
            sampled.push(blank(&base));
            Source::Sampled(sampled.len() - 1)
        });
        let frame = match source {
            Source::Base => &base,
            Source::Sampled(i) => &sampled[i],
        };
        match &channel.target {
            Target::Layer { id } => set(&mut replacements, Owner::Layer(id.clone()), source, channel.native_properties),
            Target::Figure { uid } => set(&mut replacements, Owner::Figure(*uid), source, channel.native_properties),
            Target::Camera => result.camera = Some(frame.camera.unwrap_or_default()),
            Target::Scene => {
                result.background = frame.background;
                result.background_b = frame.background_b;
                result.background_mix = frame.background_mix;
                result.background_color = frame.background_color;
                result.pose_vfx = frame.pose_vfx.clone();
            }
            _ => {}
        }
    }
    if replacements.is_empty() {
        return Frame { objects: base.objects, draw_order: base.draw_order, origins: base.origins, ..result };
    }
    let frame_of = |source: Source| -> &Frame {
        match source {
            Source::Base => &base,
            Source::Sampled(i) => &sampled[i],
        }
    };
    // Who owns a figure (`owner(uid)`): its own channel, else its layer's, by replacement.
    let mut by_figure: HashMap<u32, usize> = HashMap::new();
    let mut by_layer: HashMap<&str, usize> = HashMap::new();
    for (r, (owner, _, _)) in replacements.iter().enumerate() {
        match owner {
            Owner::Figure(uid) => {
                by_figure.insert(*uid, r);
            }
            Owner::Layer(id) => {
                by_layer.insert(id, r);
            }
        }
    }
    let replacement_of = |uid: u32| -> Option<usize> {
        match by_figure.get(&uid) {
            Some(&r) => Some(r),
            None => by_layer.get(doc.layers.as_ref().map_or("layer-1", |layers| layers.layer_of(uid))).copied(),
        }
    };
    // The figures each replacement brings, in its frame's drawing order.
    let brought: Vec<Vec<usize>> = replacements
        .iter()
        .enumerate()
        .map(|(r, (_, source, _))| {
            let frame = frame_of(*source);
            ordered(frame).into_iter().filter(|&slot| replacement_of(frame.objects[slot].uid) == Some(r)).collect()
        })
        .collect();
    let mut records: Vec<Record> = Vec::new();
    let mut included: HashSet<u32> = HashSet::new();
    // Unchanged figures keep their native slots; new appearances follow in source order.
    for (slot, object) in base.objects.iter().enumerate() {
        if replacement_of(object.uid).is_none() {
            records.push(Record { object: object.clone(), source: Source::Base, slot });
            included.insert(object.uid);
        }
    }
    for (r, (_, source, _)) in replacements.iter().enumerate() {
        for &slot in &brought[r] {
            let object = &frame_of(*source).objects[slot];
            if included.insert(object.uid) {
                records.push(Record { object: object.clone(), source: *source, slot });
            }
        }
    }
    let slots: HashMap<u32, usize> = records.iter().enumerate().map(|(slot, record)| (record.object.uid, slot)).collect();
    let natives: HashMap<u32, &Arc<Object>> = if replacements.iter().any(|(_, _, native)| *native) { base.objects.iter().map(|object| (object.uid, object)).collect() } else { HashMap::new() };
    // Where a figure was drawn in its own frame, for one that comes loose.
    let mut geometry: HashMap<usize, crate::geometry::Scene> = HashMap::new();
    let key = |source: Source| match source {
        Source::Base => usize::MAX,
        Source::Sampled(i) => i,
    };
    let mut objects: Vec<Arc<Object>> = Vec::with_capacity(records.len());
    let mut origins: Vec<Option<(FrameRef, u32)>> = Vec::with_capacity(records.len());
    for record in &records {
        let native = replacement_of(record.object.uid).is_some_and(|r| replacements[r].2);
        let mut object = if native { native_appearance(doc, &record.object, natives.get(&record.object.uid).copied()) } else { record.object.clone() };
        let source = frame_of(record.source);
        let mut origin = source.origins.get(record.slot).cloned().flatten();
        if !Arc::ptr_eq(&object, &record.object) {
            origin = None;
        }
        if let Some(join) = object.join {
            let parent = source.objects.get(join.slot as usize).and_then(|parent| slots.get(&parent.uid)).copied();
            let target = parent.map(|slot| &*records[slot].object);
            match parent.filter(|_| handle_orientation(doc, target, join.handle).is_some()) {
                Some(parent) => {
                    if parent as u32 != join.slot {
                        Arc::make_mut(&mut object).join = Some(Join { slot: parent as u32, handle: join.handle });
                        origin = None;
                    }
                }
                None => {
                    let scene = geometry.entry(key(record.source)).or_insert_with(|| crate::geometry::build(doc, source));
                    let root = scene.objects.get(record.slot).filter(|g| g.resolved).map_or(record.object.root, |g| g.root);
                    let loose = Arc::make_mut(&mut object);
                    loose.root = root;
                    loose.join = None;
                    origin = None;
                }
            }
        }
        objects.push(object);
        origins.push(origin);
    }
    // Parents before children: a joined figure turns with its parent's joint.
    let count = objects.len();
    let mut done = vec![false; count];
    for start in 0..count {
        if done[start] {
            continue;
        }
        let (mut path, mut visiting) = (Vec::new(), HashSet::new());
        let mut slot = start;
        while !done[slot] {
            // A cycle (the editor refuses it) leaves its figures as they are.
            if !visiting.insert(slot) {
                break;
            }
            path.push(slot);
            match objects[slot].join {
                Some(join) if (join.slot as usize) < count => slot = join.slot as usize,
                _ => break,
            }
        }
        for &child in path.iter().rev() {
            if done[child] {
                continue;
            }
            if let Some(join) = objects[child].join {
                let record = &records[child];
                let before = record.object.join.and_then(|j| frame_of(record.source).objects.get(j.slot as usize));
                let before = handle_orientation(doc, before.map(|o| &**o), join.handle);
                let after = handle_orientation(doc, objects.get(join.slot as usize).map(|o| &**o), join.handle);
                let delta = match (before, after) {
                    (Some(before), Some(after)) => after - before,
                    _ => 0.0,
                };
                if delta.abs() > 1e-12 {
                    let figure = doc.figure(objects[child].figure).cloned();
                    let turned = Arc::make_mut(&mut objects[child]);
                    turned.angles = turned.angles.iter().map(|angle| angle + delta).collect();
                    rotate_origin_support(figure.as_deref(), turned, delta);
                    origins[child] = None;
                }
            }
            done[child] = true;
        }
    }
    // Each layer keeps its sampled pose's stacking order; anchored figures follow their anchor.
    let mut stack = Stacking {
        objects: &objects,
        slots: &slots,
        anchors: HashMap::new(),
        anchored: HashSet::new(),
        order: Vec::with_capacity(count),
        placed: vec![false; count],
    };
    for (_, channel) in &channels {
        if let (Some(anchor), Target::Figure { uid }) = (channel.order_anchor, &channel.target) {
            stack.anchors.entry(anchor).or_default().push(*uid);
        }
    }
    let mut emitted = vec![false; replacements.len()];
    let mut emit = |stack: &mut Stacking, r: usize| {
        if std::mem::replace(&mut emitted[r], true) {
            return;
        }
        let frame = frame_of(replacements[r].1);
        for &slot in &brought[r] {
            stack.append(frame.objects[slot].uid);
        }
    };
    for slot in ordered(&base) {
        let uid = base.objects[slot].uid;
        match replacement_of(uid) {
            Some(r) => emit(&mut stack, r),
            None => stack.append(uid),
        }
        stack.append_anchors(uid);
    }
    for r in 0..replacements.len() {
        emit(&mut stack, r);
    }
    let mut order = std::mem::take(&mut stack.order);
    order.extend((0..count).filter(|&slot| !stack.placed[slot]).map(|slot| slot as u32));
    Frame { objects, origins, draw_order: order, ..result }
}

/// `replacements.set(id, frame)`: a later channel of the same owner takes its place;
/// `native` is whether a channel of the owner keeps the native appearance.
fn set(replacements: &mut Vec<(Owner, Source, bool)>, id: Owner, source: Source, native: bool) {
    match replacements.iter_mut().find(|(owner, _, _)| *owner == id) {
        Some(entry) => {
            entry.1 = source;
            entry.2 |= native;
        }
        None => replacements.push((id, source, native)),
    }
}

/// The drawing order being built (`append`, `appendAnchors`).
struct Stacking<'a> {
    objects: &'a [Arc<Object>],
    slots: &'a HashMap<u32, usize>,
    anchors: HashMap<u32, Vec<u32>>,
    anchored: HashSet<u32>,
    order: Vec<u32>,
    placed: Vec<bool>,
}

impl Stacking<'_> {
    fn append(&mut self, uid: u32) {
        if let Some(&slot) = self.slots.get(&uid)
            && !self.placed[slot]
        {
            self.placed[slot] = true;
            self.order.push(slot as u32);
        }
        self.append_anchors(uid);
    }

    fn append_anchors(&mut self, uid: u32) {
        if !self.anchored.insert(uid) {
            return;
        }
        for child in self.anchors.get(&uid).cloned().unwrap_or_default() {
            match self.slots.get(&child) {
                Some(&slot) => self.append(self.objects[slot].uid),
                None => self.append_anchors(child),
            }
        }
    }
}

/// `rotateOriginSupport`: the ghost bones of a figure's retained support graph turn too.
pub(crate) fn rotate_origin_support(figure: Option<&Figure>, object: &mut Object, delta: f64) {
    if delta == 0.0 || !figure.is_some_and(|f| f.origin.as_ref().is_some_and(|o| matches!(o.kind, crate::origin::Kind::Support(_)))) {
        return;
    }
    if let Some(origin) = object.origin.as_mut().filter(|o| !o.ghosts.is_empty()) {
        for ghost in Arc::make_mut(origin).ghosts.values_mut() {
            ghost.angle += delta;
        }
    }
}
