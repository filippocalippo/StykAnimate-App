//! Scalar channels (`composeAnimationChannels` in src/animation-channels.mjs): after the
//! pose channels, every other channel that controls its property at the tick sets it on
//! the frame. Effect stacks first, then fill styles, then the rest in saved order;
//! positions, scales, opacities and rotations of figures last, parents before children,
//! a rotation carried into the figures joined below.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use super::{Animation, Channel, KeyValue, Property, Target};
use crate::doc::{Camera, Document, Object, PaintKind};
use crate::eval::Frame;
use crate::style::{ObjectStyle, PolygonStyle, SegmentStyle};
use crate::vfx::registry::{ParamKind, ParamValue};
use crate::vfx::{Effect, Field, StackKey, Stacks};

/// An overlay with nothing left in it is no overlay.
pub(crate) fn nonempty(style: ObjectStyle) -> Option<Arc<ObjectStyle>> {
    let empty = style.outline_opacity.is_none()
        && style.outline_color.is_none()
        && style.outline_width.is_none()
        && style.segments.is_empty()
        && style.polygons.is_empty()
        && style.mesh_colors.is_empty()
        && !style.segment_colors;
    (!empty).then(|| Arc::new(style))
}

/// Gives `object` the figure its (changed) style overlay and sprite resolve to
/// (`resolveInstanceFigure`, as the loader resolves saved overlays).
pub(crate) fn restyle(doc: &Document, object: &mut Object) {
    let Some(base) = doc.figure(object.figure) else { return };
    if object.style.is_none() && object.sticknodes_sprite.is_none() {
        object.figure_override = None;
        return;
    }
    let mut figure = match &object.style {
        Some(style) => crate::style::resolve(base, style),
        None => (**base).clone(),
    };
    if let Some(sprite) = &object.sticknodes_sprite {
        crate::sticknodes::sprite_figure(&mut figure, sprite);
    }
    figure.base = Some(base.clone());
    object.figure_override = Some(Arc::new(figure));
}

/// Values gathered for a figure's transform (`figureValues`).
#[derive(Default)]
struct Transform {
    x: Option<f64>,
    y: Option<f64>,
    scale: Option<f64>,
    opacity: Option<f64>,
    rotation: Option<f64>,
}

/// `vfxOwnerKey`: where a target's stack lives in `_stykVfx`.
fn stack_key(target: &Target) -> StackKey {
    match target {
        Target::Segment { handle, figure_type, .. } => StackKey::Segment { figure_type: *figure_type, handle: *handle },
        _ => StackKey::Figure,
    }
}

/// `setVfxStack`: an empty stack removes its entry, and no entry left removes the table.
fn set_stack(stacks: &mut Option<Arc<Stacks>>, key: StackKey, stack: Arc<[Arc<Effect>]>) {
    let mut table: Stacks = stacks.as_deref().cloned().unwrap_or_default();
    match table.entries.iter().position(|(k, _)| *k == key) {
        Some(at) if stack.is_empty() => {
            table.entries.remove(at);
        }
        Some(at) => table.entries[at].1 = stack,
        None if stack.is_empty() => {}
        None => table.entries.push((key, stack)),
    }
    *stacks = (!table.entries.is_empty()).then(|| Arc::new(table));
}

fn truthy(value: &KeyValue) -> bool {
    match value {
        KeyValue::Num(n) => *n != 0.0 && !n.is_nan(),
        KeyValue::Null | KeyValue::Pose(None) | KeyValue::Paint(None) => false,
        _ => true,
    }
}

/// `applyVfxParameter`: a parameter of an effect already in the stack (clamped to its
/// range, colours as they are), its `enabled` switch, the whole stack, or the scope.
fn apply_vfx(stacks: &mut Option<Arc<Stacks>>, scope: Option<&mut bool>, target: &Target, property: &Property, value: &KeyValue) {
    let key = stack_key(target);
    match property {
        Property::VfxScope => {
            if let Some(scope) = scope {
                *scope = truthy(value);
            }
        }
        Property::VfxStack => {
            if let KeyValue::Stack(stack) = value {
                set_stack(stacks, key, stack.clone());
            }
        }
        Property::Vfx { kind, id, field } => {
            let Some(stack) = stacks.as_ref().and_then(|s| s.get(key)) else { return };
            let Some(index) = stack.iter().position(|e| e.id == *id && e.kind() == *kind) else { return };
            let mut effect = (*stack[index]).clone();
            match field {
                Field::Enabled => effect.enabled = truthy(value),
                Field::Param(i) => {
                    let spec = kind.specs()[*i];
                    let resolved = match value {
                        KeyValue::Param(paint) => paint.clone(),
                        other if spec.kind == ParamKind::Color => ParamValue::Num(other.number()),
                        other => ParamValue::Num(other.number().min(spec.max).max(spec.min)),
                    };
                    effect.params.set(*i, &resolved);
                }
            }
            let mut next: Vec<Arc<Effect>> = stack.to_vec();
            next[index] = Arc::new(effect);
            set_stack(stacks, key, next.into());
        }
        _ => {}
    }
}

/// `animationStyleValue(...) !== undefined`: whether a style channel applies to `object`
/// (its figure type, and a segment or polygon its definition has).
fn style_applies(doc: &Document, object: &Object, target: &Target, property: &Property) -> bool {
    let Some(figure) = doc.figure(object.figure) else { return false };
    match target {
        Target::Polygon { polygon, figure_type, .. } => *figure_type == object.figure && figure.polyfills.iter().any(|p| p.id == *polygon),
        Target::Segment { handle, figure_type, .. } => {
            if figure_type.is_some_and(|t| t != object.figure) {
                return false;
            }
            let Some(segment) = figure.segments.iter().find(|s| s.id == *handle) else { return false };
            if matches!(property, Property::GradientColor | Property::GradientOpacity) {
                // A second colour exists on a native gradient, or on a gradient fill style.
                let endpoint = object.style.as_ref().and_then(|s| s.segments.get(handle)).and_then(|s| s.paint.as_ref()).is_some_and(|p| p.kind != PaintKind::Solid);
                return segment.secondary.is_some() || endpoint;
            }
            true
        }
        _ => true,
    }
}

/// `setAnimationStyle`.
fn set_style(object: &mut Object, target: &Target, property: &Property, value: &KeyValue) {
    let mut style: ObjectStyle = object.style.as_deref().cloned().unwrap_or_default();
    let number = value.number();
    let color = || js_color(number);
    match target {
        Target::Figure { .. } => match property {
            Property::OutlineOpacity => style.outline_opacity = Some(number),
            Property::OutlineColor => style.outline_color = Some(color()),
            Property::OutlineWidth => style.outline_width = Some(number),
            _ => return,
        },
        Target::Polygon { polygon, .. } => {
            let entry: &mut PolygonStyle = style.polygons.entry(*polygon).or_default();
            match property {
                Property::Color => entry.color = Some(color()),
                Property::Opacity => entry.opacity = Some(number),
                Property::ZIndex => entry.z = Some(number),
                _ => return,
            }
        }
        Target::Segment { handle, .. } => {
            let entry: &mut SegmentStyle = style.segments.entry(*handle).or_default();
            match property {
                Property::Color => entry.color = Some(color()),
                Property::Opacity => entry.opacity = Some(number),
                Property::Thickness => entry.thickness = Some(number),
                Property::GradientColor => entry.gradient_color = Some(color()),
                Property::GradientOpacity => entry.gradient_opacity = Some(number),
                Property::ZIndex => entry.z = Some(number),
                Property::Paint => match value {
                    KeyValue::Paint(paint) => entry.paint = paint.clone(),
                    _ => return,
                },
                _ => return,
            }
        }
        _ => return,
    }
    style.key.push_str("|channel");
    object.style = Some(Arc::new(style));
}

/// A colour key's integer.
fn js_color(value: f64) -> u32 {
    if value.is_finite() { value.trunc().rem_euclid(4294967296.0) as u32 } else { 0 }
}

/// `composeAnimationChannels`.
pub(crate) fn compose(doc: &Document, animation: &Animation, mut frame: Frame, tick: f64) -> Frame {
    let mut active: Vec<(&Channel, KeyValue)> =
        animation.channels.iter().filter(|c| c.property != Property::Pose).filter_map(|c| Some((c, c.sample(tick)?))).collect();
    if active.is_empty() {
        return frame;
    }
    // Whole stacks first, then fill styles: what a parameter or a colour then changes.
    active.sort_by_key(|(c, _)| std::cmp::Reverse(2 * (c.property == Property::VfxStack) as u8 + (c.property == Property::Paint) as u8));
    let mut slots: Option<HashMap<u32, usize>> = None;
    let slot_of = |slots: &mut Option<HashMap<u32, usize>>, frame: &Frame, uid: u32| -> Option<usize> {
        slots.get_or_insert_with(|| frame.objects.iter().enumerate().map(|(slot, o)| (o.uid, slot)).collect()).get(&uid).copied()
    };
    let mut transforms: HashMap<usize, Transform> = HashMap::new();
    let (mut background, mut color): (Option<f64>, Option<KeyValue>) = (None, None);
    let mut camera_copied = false;
    let mut scoped: HashSet<(u8, u32, u32, String)> = HashSet::new();
    let mut restyled: HashSet<usize> = HashSet::new();
    for (channel, value) in &active {
        let target = &channel.target;
        let property = &channel.property;
        if property.is_vfx() {
            if *target == Target::Scene {
                apply_vfx(&mut frame.pose_vfx, None, target, property, value);
                continue;
            }
            let Some(slot) = target.uid().and_then(|uid| slot_of(&mut slots, &frame, uid)) else { continue };
            // `animationPropertyValue(..., 'vfxStack')`: a node stack needs its node.
            if let Target::Segment { handle, figure_type, .. } = target {
                let object = &frame.objects[slot];
                let known = doc.figure(object.figure).is_some_and(|f| f.segments.iter().any(|s| s.id == *handle));
                if figure_type.is_some_and(|t| t != object.figure) || !known {
                    continue;
                }
            }
            let object = Arc::make_mut(&mut frame.objects[slot]);
            apply_vfx(&mut object.vfx, Some(&mut object.vfx_scope), target, property, value);
            continue;
        }
        match target {
            Target::Camera => {
                if !camera_copied {
                    let base = frame.camera.unwrap_or(Camera { is_default: false, ..Camera::default() });
                    frame.camera = Some(Camera { is_default: false, ..base });
                    camera_copied = true;
                }
                let camera = frame.camera.as_mut().expect("copied above");
                let number = value.number();
                match property {
                    Property::X => camera.x = number,
                    Property::Y => camera.y = number,
                    Property::Scale => camera.scale = number,
                    Property::Rotation => camera.angle = number,
                    _ => {}
                }
            }
            Target::Scene => match property {
                Property::BackgroundId => background = Some(value.number()),
                Property::Color => color = Some(value.clone()),
                _ => {}
            },
            Target::Figure { uid } | Target::Segment { uid, .. } | Target::Polygon { uid, .. } => {
                let Some(slot) = slot_of(&mut slots, &frame, *uid) else { continue };
                let figure_kind = matches!(target, Target::Figure { .. });
                if figure_kind && *property == Property::Color {
                    Arc::make_mut(&mut frame.objects[slot]).color = js_color(value.number());
                    continue;
                }
                if figure_kind && *property == Property::ZIndex {
                    Arc::make_mut(&mut frame.objects[slot]).z_index = value.number();
                    continue;
                }
                let style_property = !figure_kind || matches!(property, Property::OutlineOpacity | Property::OutlineColor | Property::OutlineWidth);
                if style_property {
                    // Missing or replaced nodes stay dormant instead of styling another one.
                    if !style_applies(doc, &frame.objects[slot], target, property) {
                        continue;
                    }
                    // A definition scope wins over the unscoped curve, whatever their saved order.
                    let (kind, part, is_scoped) = match target {
                        Target::Segment { handle, figure_type, .. } => (1u8, *handle, figure_type.is_some()),
                        Target::Polygon { polygon, .. } => (2u8, *polygon, true),
                        _ => (0u8, 0, false),
                    };
                    let identity = (kind, *uid, part, format!("{property:?}"));
                    if !is_scoped && scoped.contains(&identity) {
                        continue;
                    }
                    set_style(Arc::make_mut(&mut frame.objects[slot]), target, property, value);
                    restyled.insert(slot);
                    if is_scoped {
                        scoped.insert(identity);
                    }
                    continue;
                }
                let values = transforms.entry(slot).or_default();
                let number = value.number();
                match property {
                    Property::X => values.x = Some(number),
                    Property::Y => values.y = Some(number),
                    Property::Scale => values.scale = Some(number),
                    Property::Opacity => values.opacity = Some(number),
                    Property::Rotation => values.rotation = Some(number),
                    _ => {}
                }
            }
            Target::Layer { .. } => {}
        }
    }
    // Colour and image selection are independent properties, whatever their edit order.
    if let Some(id) = background {
        frame.background = js_color(id);
        frame.background_b = 0;
        frame.background_mix = 0.0;
        frame.background_color = None;
    }
    match color {
        Some(KeyValue::Null) => frame.background_color = None,
        Some(value) => frame.background_color = Some(js_color(value.number())),
        None => {}
    }
    for slot in restyled {
        restyle(doc, Arc::make_mut(&mut frame.objects[slot]));
    }
    if !transforms.is_empty() {
        transform(doc, &mut frame, &transforms);
    }
    frame
}

/// The transform part of `composeAnimationChannels`: scale, opacity and rotation in one
/// pass from the roots down (a rotation turns the figures joined below it too), the
/// animation origins corrected, then positions: a joined figure moves its root figure.
fn transform(doc: &Document, frame: &mut Frame, transforms: &HashMap<usize, Transform>) {
    let count = frame.objects.len();
    let mut parents: Vec<Option<usize>> = vec![None; count];
    let mut children: Vec<Vec<usize>> = vec![Vec::new(); count];
    let mut roots: Vec<usize> = (0..count).collect();
    let mut ordered: Vec<usize> = Vec::with_capacity(count);
    for (slot, object) in frame.objects.iter().enumerate() {
        match object.join.map(|j| j.slot as usize) {
            // The editor refuses an attachment to a missing figure; it is read as none.
            Some(parent) if parent < count => {
                parents[slot] = Some(parent);
                children[parent].push(slot);
            }
            _ => ordered.push(slot),
        }
    }
    let mut i = 0;
    while i < ordered.len() {
        let slot = ordered[i];
        for &child in &children[slot] {
            roots[child] = roots[slot];
            ordered.push(child);
        }
        i += 1;
    }
    // Figures in a join cycle (the editor refuses one) are left out.
    let mut deltas = vec![0.0f64; count];
    for &slot in &ordered {
        let values = transforms.get(&slot);
        let mut delta = parents[slot].map_or(0.0, |parent| deltas[parent]);
        if values.is_some_and(|v| v.scale.is_some() || v.opacity.is_some() || v.rotation.is_some()) {
            let values = values.expect("checked");
            let object = Arc::make_mut(&mut frame.objects[slot]);
            if let Some(scale) = values.scale {
                object.scale = scale;
            }
            if let Some(opacity) = values.opacity {
                object.transparency = crate::vfx::paint::js_round(255.0 * (1.0 - opacity));
            }
            if let Some(rotation) = values.rotation {
                delta = rotation
                    - match doc.figure(object.figure) {
                        Some(figure) => crate::origin::rotation(figure, object),
                        None => object.angles.first().copied().unwrap_or(0.0),
                    };
            }
        }
        deltas[slot] = delta;
        if delta != 0.0 {
            let figure = doc.figure(frame.objects[slot].figure).cloned();
            let object = Arc::make_mut(&mut frame.objects[slot]);
            object.angles = object.angles.iter().map(|angle| angle + delta).collect();
            super::pose::rotate_origin_support(figure.as_deref(), object, delta);
        }
    }
    crate::eval::correct_origins(doc, frame);
    let needs_world = transforms.iter().any(|(slot, v)| parents[*slot].is_some() && (v.x.is_some() || v.y.is_some()));
    let world = needs_world.then(|| crate::geometry::build(doc, frame));
    let mut shifts = [vec![0.0f64; count], vec![0.0f64; count]];
    for &slot in &ordered {
        let Some(values) = transforms.get(&slot).filter(|v| v.x.is_some() || v.y.is_some()) else { continue };
        let root = roots[slot];
        let object = frame.objects[slot].clone();
        let mut base = world.as_ref().and_then(|w| w.objects.get(slot)).filter(|g| g.resolved).map(|g| g.root);
        if let Some(origin) = &object.origin {
            if parents[slot].is_none() {
                base = Some([origin.x, origin.y]);
            } else if let (Some(at), Some(figure)) = (base, doc.figure(object.figure)) {
                let offset = crate::origin::offset(figure, &object);
                base = Some([at[0] + offset[0], at[1] + offset[1]]);
            }
        }
        for (axis, value) in [(0usize, values.x), (1usize, values.y)] {
            let Some(value) = value else { continue };
            let delta = value - (base.map_or(object.root[axis], |b| b[axis]) + shifts[axis][root]);
            if delta != 0.0 {
                let moved = Arc::make_mut(&mut frame.objects[root]);
                moved.root[axis] += delta;
                if let Some(origin) = moved.origin.as_mut() {
                    let origin = Arc::make_mut(origin);
                    if axis == 0 {
                        origin.x += delta;
                    } else {
                        origin.y += delta;
                    }
                }
            }
            shifts[axis][root] += delta;
        }
    }
}
