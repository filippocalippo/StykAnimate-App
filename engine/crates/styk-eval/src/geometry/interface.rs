//! The geometry the interface reads of a frame (docs/engine/evaluation.md, "The interface's geometry"):
//! per object its root, joints, every segment and polygon as built (drawn or not), the 3D frames of its
//! bones and what inverse kinematics solved, as JSON for `src/engine/engine-shown.mjs`, which makes
//! them the groups the canvas, the handles and the pickers read.
//!
//! Written from a scene built by [`super::build_shapes`]. Numbers are the exact values the scene holds
//! (non-finite ones are `null`).

use std::collections::HashMap;

use styk_doc::format_number;

use super::{Item, ItemKind, ITEM_CULLED, Scene};
use crate::doc::Figure;
use crate::rig::SpatialFrame;

fn num(out: &mut Vec<u8>, value: f64) {
    format_number(value, out);
}

fn point(out: &mut Vec<u8>, p: [f64; 2]) {
    out.push(b'[');
    num(out, p[0]);
    out.push(b',');
    num(out, p[1]);
    out.push(b']');
}

fn numbers(out: &mut Vec<u8>, values: &[f64]) {
    out.push(b'[');
    for (i, &value) in values.iter().enumerate() {
        if i > 0 {
            out.push(b',');
        }
        num(out, value);
    }
    out.push(b']');
}

/// Points as `[x0,y0,x1,y1,…]`.
fn flat(out: &mut Vec<u8>, points: &[[f64; 2]]) {
    out.push(b'[');
    for (i, p) in points.iter().enumerate() {
        if i > 0 {
            out.push(b',');
        }
        num(out, p[0]);
        out.push(b',');
        num(out, p[1]);
    }
    out.push(b']');
}

fn key(out: &mut Vec<u8>, name: &str) {
    out.push(b',');
    out.push(b'"');
    out.extend_from_slice(name.as_bytes());
    out.extend_from_slice(b"\":");
}

fn rgb(out: &mut Vec<u8>, c: [u8; 3]) {
    out.extend_from_slice(format!("[{},{},{}]", c[0], c[1], c[2]).as_bytes());
}

fn spatial_frame(out: &mut Vec<u8>, frame: &SpatialFrame) {
    out.extend_from_slice(b"{\"q\":");
    numbers(out, &frame.q);
    key(out, "t");
    numbers(out, &frame.t);
    key(out, "dual");
    numbers(out, &frame.dual);
    key(out, "nativeBend");
    num(out, frame.native_bend);
    key(out, "authoredBend");
    num(out, frame.authored_bend);
    key(out, "motionValue");
    num(out, frame.motion_value);
    key(out, "origin");
    numbers(out, &frame.origin);
    key(out, "axis");
    numbers(out, &frame.axis);
    key(out, "stretch");
    num(out, frame.stretch);
    if let Some(scale) = frame.choice_scale {
        key(out, "choiceScale");
        num(out, scale);
    }
    if let Some(shape) = &frame.shape {
        key(out, "shape");
        out.extend_from_slice(b"{\"width\":");
        num(out, shape.width);
        key(out, "taper");
        num(out, shape.taper);
        out.push(b'}');
        key(out, "restLength");
        num(out, frame.rest_length);
    }
    out.push(b'}');
}

/// Points before perspective as `[x0, y0, z0, x1, y1, z1, …]`, one triple for each place in the figure (`null`s where there is none).
fn raws(out: &mut Vec<u8>, points: impl Iterator<Item = Option<[f64; 3]>>) {
    out.push(b'[');
    for (i, raw) in points.enumerate() {
        if i > 0 {
            out.push(b',');
        }
        let [x, y, z] = raw.unwrap_or([f64::NAN; 3]);
        num(out, x);
        out.push(b',');
        num(out, y);
        out.push(b',');
        num(out, z);
    }
    out.push(b']');
}

/// The `flags` of a segment row.
const START: u32 = 1;
const END: u32 = 2;
const POINTS: u32 = 4;
const CONNECTOR: u32 = 8;
const SPATIAL: u32 = 16;

fn same(a: [f64; 2], b: [f64; 2]) -> bool {
    a[0].to_bits() == b[0].to_bits() && a[1].to_bits() == b[1].to_bits()
}

/// One segment of an object as a row (no keys, nothing the reader can work out): its `index` in the figure, `angle`, `bend`,
/// `length`, `thickness`, `z`, `r`, `g`, `b`, `alpha`, `opacity` and `flags`, then in this order what the flags say follows: where it
/// starts when that is not where its parent ends (`START`: x, y), where it is drawn to when that is not its joint (`END`: x, y;
/// a connector's joint is its slider), its curve (`POINTS`: an array `[x0, y0, …]`) and the 3D frame of a bone (`SPATIAL`: an object).
fn segment(out: &mut Vec<u8>, scene: &Scene, slot: usize, fig: &Figure, item: &Item) {
    let object = &scene.objects[slot];
    let index = item.index as usize;
    let parent = fig.plan.parent.get(index).copied().filter(|&parent| parent != u32::MAX).map(|parent| object.ends[parent as usize]).filter(|end| !end[0].is_nan());
    let origin = parent.unwrap_or(object.root);
    let connector = object.rig.as_ref().and_then(|rig| rig.get(index)).is_some_and(|joint| joint.connector);
    let points = scene.points_of(item);
    let frame = object.spatial.as_ref().and_then(|spatial| spatial.frames.get(index)).and_then(Option::as_ref);
    let mut flags = 0;
    if !same(item.start, origin) {
        flags |= START;
    }
    if !same(item.end, object.ends[index]) {
        flags |= END;
    }
    if !points.is_empty() {
        flags |= POINTS;
    }
    if connector {
        flags |= CONNECTOR;
    }
    if frame.is_some() {
        flags |= SPATIAL;
    }
    out.push(b'[');
    for (n, value) in [index as f64, item.angle, item.bend, item.length, item.thickness, item.z, item.rgb[0] as f64, item.rgb[1] as f64, item.rgb[2] as f64, item.alpha, item.opacity, flags as f64].into_iter().enumerate() {
        if n > 0 {
            out.push(b',');
        }
        num(out, value);
    }
    if flags & START != 0 {
        out.push(b',');
        num(out, item.start[0]);
        out.push(b',');
        num(out, item.start[1]);
    }
    if flags & END != 0 {
        out.push(b',');
        num(out, item.end[0]);
        out.push(b',');
        num(out, item.end[1]);
    }
    if flags & POINTS != 0 {
        out.push(b',');
        flat(out, points);
    }
    if let Some(frame) = frame {
        out.push(b',');
        spatial_frame(out, frame);
    }
    out.push(b']');
}

fn poly(out: &mut Vec<u8>, scene: &Scene, item: &Item) {
    out.extend_from_slice(b"{\"index\":");
    num(out, item.index as f64);
    key(out, "points");
    flat(out, scene.points_of(item));
    key(out, "z");
    num(out, item.z);
    key(out, "rgb");
    rgb(out, item.rgb);
    key(out, "alpha");
    num(out, item.alpha);
    key(out, "opacity");
    num(out, item.opacity);
    if item.flags & ITEM_CULLED != 0 {
        key(out, "culled");
        out.extend_from_slice(b"true");
    } else if item.depth.1 > item.depth.0 {
        key(out, "depthValues");
        numbers(out, scene.depths_of(item));
    }
    out.push(b'}');
}

/// The groups of `slots` of a scene built by [`super::build_shapes`], each as JSON text (`null` for
/// an object the scene could not resolve): `root` `[x, y]`, `ends` (the joint of each segment of the figure, `[x0, y0, x1, y1, …]`,
/// `null` where it was not built), `raws` and `startRaws` (where the pose has a camera: what each joint and each bone's start are before
/// perspective, a triple for each place in the figure, see [`raws`]), `segs` (a row per segment built, see [`segment`]), `polys`, and as they
/// apply `solved`, `drawn` and `bounds`. A dense frame is megabytes of text, so a row names nothing and holds nothing the reader works out (where a
/// segment starts and ends are the joints of its parent and of itself unless it says otherwise). `bounds` is
/// [`crate::drawlist::app_bounds`] of the scene, by slot.
pub fn write_groups(scene: &Scene, slots: &[usize], bounds: &[Option<[f64; 4]>]) -> Vec<String> {
    let mut by_slot: HashMap<u32, Vec<&Item>> = HashMap::new();
    let wanted: std::collections::HashSet<u32> = slots.iter().map(|&slot| slot as u32).collect();
    for item in &scene.measured {
        if wanted.contains(&item.slot) {
            by_slot.entry(item.slot).or_default().push(item);
        }
    }
    // The objects that have artwork to draw (the others keep their handles only).
    let drawn: std::collections::HashSet<u32> = scene.items.iter().map(|item| item.slot).filter(|slot| wanted.contains(slot)).collect();
    slots.iter().map(|&slot| {
        let Some(object) = scene.objects.get(slot).filter(|object| object.resolved) else { return "null".to_string() };
        let Some(fig) = scene.figure_for(slot) else { return "null".to_string() };
        let items = by_slot.get(&(slot as u32)).map(Vec::as_slice).unwrap_or(&[]);
        let mut out: Vec<u8> = Vec::with_capacity(256 + items.len() * 220);
        out.extend_from_slice(b"{\"root\":");
        point(&mut out, object.root);
        // Where each segment's joint is, by place in the figure (`null`: the segment was not built).
        key(&mut out, "ends");
        out.push(b'[');
        for (i, end) in object.ends.iter().enumerate() {
            if i > 0 {
                out.push(b',');
            }
            num(&mut out, end[0]);
            out.push(b',');
            num(&mut out, end[1]);
        }
        out.push(b']');
        // What a 3D bone's joint and start are before perspective (`rawPoint`, `start.rawPoint`), where the pose has a camera.
        if let Some(spatial) = &object.spatial {
            if spatial.depths.iter().any(|depth| depth.raw.is_some()) {
                key(&mut out, "raws");
                raws(&mut out, spatial.depths.iter().map(|depth| depth.raw));
            }
            if spatial.start_raws.iter().any(Option::is_some) {
                key(&mut out, "startRaws");
                raws(&mut out, spatial.start_raws.iter().copied());
            }
        }
        key(&mut out, "segs");
        out.push(b'[');
        if fig.movieclip.is_some() {
            // A movieclip instance is its handle: forty units from the root along its angle.
            out.extend_from_slice(b"[0,");
            num(&mut out, object.angles.first().copied().unwrap_or(0.0));
            out.extend_from_slice(b",0,");
            num(&mut out, object.lengths.first().copied().unwrap_or(0.0));
            out.extend_from_slice(b",0,0,0,0,0,1,1,0]");
        } else {
            let mut shapes: Vec<&Item> = items.iter().copied().filter(|item| !matches!(item.kind, ItemKind::Poly | ItemKind::Mesh)).collect();
            shapes.sort_by_key(|item| item.index);
            for (n, item) in shapes.into_iter().enumerate() {
                if n > 0 {
                    out.push(b',');
                }
                segment(&mut out, scene, slot, fig, item);
            }
        }
        out.push(b']');
        key(&mut out, "polys");
        out.push(b'[');
        let mut first = true;
        for item in items.iter().filter(|item| item.kind == ItemKind::Poly) {
            if !first {
                out.push(b',');
            }
            first = false;
            poly(&mut out, scene, item);
        }
        out.push(b']');
        if let Some(solution) = &object.solution {
            key(&mut out, "solved");
            out.extend_from_slice(b"{\"angles\":");
            numbers(&mut out, &solution.angles);
            if let Some(lengths) = &solution.lengths {
                key(&mut out, "lengths");
                numbers(&mut out, lengths);
            }
            out.push(b'}');
        }
        if drawn.contains(&(slot as u32)) {
            key(&mut out, "drawn");
            out.extend_from_slice(b"true");
        }
        if let Some(Some(rect)) = bounds.get(slot) {
            key(&mut out, "bounds");
            numbers(&mut out, rect);
        }
        out.push(b'}');
        // The writer emits ASCII punctuation, numbers and the text of identifiers only.
        unsafe { String::from_utf8_unchecked(out) }
    }).collect()
}
