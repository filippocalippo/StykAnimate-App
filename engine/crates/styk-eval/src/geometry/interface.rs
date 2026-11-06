//! The geometry the interface reads of a frame (docs/engine/evaluation.md, "The interface's geometry"):
//! per object its root, joints, every segment and polygon as built (drawn or not), the 3D frames of its
//! bones and what inverse kinematics solved, as a packet of 64-bit floats for `src/engine/engine-shown.mjs`,
//! which makes them the groups the canvas, the handles and the pickers read.
//!
//! Written from a scene built by [`super::build_shapes`]. Numbers are the exact values the scene holds, as
//! they are (a non-finite one stays non-finite; the reader treats it as the JSON `null` it was).
//!
//! A packet is a flat sequence of words, so that nothing is formatted, parsed or copied value by value on the
//! way to the interface (and a native host could read the same words). [`GroupWriter`] writes one group:
//!
//! - `flags`: [`DRAWN`], [`BOUNDS`], [`SOLVED`], [`SOLVED_LENGTHS`];
//! - `root` (x, y);
//! - `ends`: a count, then the joint of each segment of the figure, `x0, y0, x1, y1, …` (NaN where it was not built);
//! - `raws` and `startRaws`: each a count (0 for none), then triples (x, y, z) before perspective, NaN where there is none;
//! - `segs`: a count of rows, then the rows ([`segment`]);
//! - `polys`: a count, then the polygons ([`poly`]);
//! - when `flags` say so, `solved` (a count and the angles, then, for [`SOLVED_LENGTHS`], a count and the lengths) and `bounds`
//!   (four numbers).

use std::collections::HashMap;

use super::{Item, ItemKind, ITEM_CULLED, Scene};
use crate::doc::Figure;
use crate::rig::SpatialFrame;

/// The `flags` word of a group.
pub const DRAWN: u32 = 1;
pub const BOUNDS: u32 = 2;
pub const SOLVED: u32 = 4;
pub const SOLVED_LENGTHS: u32 = 8;

/// The `flags` of a segment row.
pub const START: u32 = 1;
pub const END: u32 = 2;
pub const POINTS: u32 = 4;
pub const CONNECTOR: u32 = 8;
pub const SPATIAL: u32 = 16;

/// The `flags` of a polygon.
pub const CULLED_POLY: u32 = 1;
pub const DEPTH_POLY: u32 = 2;

/// The words of the 3D frame of a bone: `q` (4), `t` (3), `dual` (4), `nativeBend`, `authoredBend`, `motionValue`, `origin` (3),
/// `axis` (3), `stretch`, then `1, choiceScale` or `0, 0`, then `1, width, taper, restLength` or `0, 0, 0, 0`.
pub const SPATIAL_WORDS: usize = 27;

fn same(a: [f64; 2], b: [f64; 2]) -> bool {
    a[0].to_bits() == b[0].to_bits() && a[1].to_bits() == b[1].to_bits()
}

fn count(out: &mut Vec<f64>, n: usize) {
    out.push(n as f64);
}

/// Points as `[x0,y0,x1,y1,…]`, counted by numbers.
fn flat(out: &mut Vec<f64>, points: &[[f64; 2]]) {
    count(out, points.len() * 2);
    for p in points {
        out.extend_from_slice(p);
    }
}

fn spatial_frame(out: &mut Vec<f64>, frame: &SpatialFrame) {
    out.extend_from_slice(&frame.q);
    out.extend_from_slice(&frame.t);
    out.extend_from_slice(&frame.dual);
    out.extend_from_slice(&[frame.native_bend, frame.authored_bend, frame.motion_value]);
    out.extend_from_slice(&frame.origin);
    out.extend_from_slice(&frame.axis);
    out.push(frame.stretch);
    match frame.choice_scale {
        Some(scale) => out.extend_from_slice(&[1.0, scale]),
        None => out.extend_from_slice(&[0.0, 0.0]),
    }
    match &frame.shape {
        Some(shape) => out.extend_from_slice(&[1.0, shape.width, shape.taper, frame.rest_length]),
        None => out.extend_from_slice(&[0.0; 4]),
    }
}

/// Points before perspective as `x0, y0, z0, x1, y1, z1, …`, one triple for each place in the figure (NaN where there is none).
fn raws(out: &mut Vec<f64>, points: impl ExactSizeIterator<Item = Option<[f64; 3]>>) {
    count(out, points.len() * 3);
    for raw in points {
        out.extend_from_slice(&raw.unwrap_or([f64::NAN; 3]));
    }
}

/// One segment of an object as a row (nothing the reader can work out): its `index` in the figure, `angle`, `bend`,
/// `length`, `thickness`, `z`, `r`, `g`, `b`, `alpha`, `opacity` and `flags`, then in this order what the flags say follows: where it
/// starts when that is not where its parent ends (`START`: x, y), where it is drawn to when that is not its joint (`END`: x, y;
/// a connector's joint is its slider), its curve (`POINTS`: a count, then `x0, y0, …`) and the 3D frame of a bone (`SPATIAL`:
/// [`SPATIAL_WORDS`] words).
fn segment(out: &mut Vec<f64>, scene: &Scene, slot: usize, fig: &Figure, item: &Item) {
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
    out.extend_from_slice(&[index as f64, item.angle, item.bend, item.length, item.thickness, item.z, item.rgb[0] as f64, item.rgb[1] as f64, item.rgb[2] as f64, item.alpha, item.opacity, flags as f64]);
    if flags & START != 0 {
        out.extend_from_slice(&item.start);
    }
    if flags & END != 0 {
        out.extend_from_slice(&item.end);
    }
    if flags & POINTS != 0 {
        flat(out, points);
    }
    if let Some(frame) = frame {
        spatial_frame(out, frame);
    }
}

/// One polygon: its `index`, `points` (a count, then `x0, y0, …`), `z`, `r`, `g`, `b`, `alpha`, `opacity` and `flags`; with
/// [`DEPTH_POLY`] the depth of each point follows (a count, then the values).
fn poly(out: &mut Vec<f64>, scene: &Scene, item: &Item) {
    out.push(item.index as f64);
    flat(out, scene.points_of(item));
    let mut flags = 0;
    if item.flags & ITEM_CULLED != 0 {
        flags |= CULLED_POLY;
    } else if item.depth.1 > item.depth.0 {
        flags |= DEPTH_POLY;
    }
    out.extend_from_slice(&[item.z, item.rgb[0] as f64, item.rgb[1] as f64, item.rgb[2] as f64, item.alpha, item.opacity, flags as f64]);
    if flags & DEPTH_POLY != 0 {
        let depths = scene.depths_of(item);
        count(out, depths.len());
        out.extend_from_slice(depths);
    }
}

/// The groups of `slots` of a scene built by [`super::build_shapes`], appended to `out` one after the other as `slot, length, words`
/// (a length of 0 is an object the scene could not resolve): see the module for a group's words. A dense frame is megabytes of text
/// as JSON, so nothing is formatted: a row names nothing and holds nothing the reader works out (where a segment starts and ends are the
/// joints of its parent and of itself unless it says otherwise). `bounds` is [`crate::drawlist::app_bounds`] of the scene, by slot.
pub fn pack_groups(scene: &Scene, slots: &[usize], bounds: &[Option<[f64; 4]>], out: &mut Vec<f64>) {
    let mut by_slot: HashMap<u32, Vec<&Item>> = HashMap::new();
    let wanted: std::collections::HashSet<u32> = slots.iter().map(|&slot| slot as u32).collect();
    for item in &scene.measured {
        if wanted.contains(&item.slot) {
            by_slot.entry(item.slot).or_default().push(item);
        }
    }
    // The objects that have artwork to draw (the others keep their handles only).
    let drawn: std::collections::HashSet<u32> = scene.items.iter().map(|item| item.slot).filter(|slot| wanted.contains(slot)).collect();
    for &slot in slots {
        out.push(slot as f64);
        let length_at = out.len();
        out.push(0.0);
        let (Some(object), Some(fig)) = (scene.objects.get(slot).filter(|object| object.resolved), scene.figure_for(slot)) else { continue };
        let items = by_slot.get(&(slot as u32)).map(Vec::as_slice).unwrap_or(&[]);
        let start = out.len();
        let solved = object.solution.as_ref();
        let mut flags = 0;
        if drawn.contains(&(slot as u32)) {
            flags |= DRAWN;
        }
        let rect = bounds.get(slot).copied().flatten();
        if rect.is_some() {
            flags |= BOUNDS;
        }
        if let Some(solution) = solved {
            flags |= SOLVED;
            if solution.lengths.is_some() {
                flags |= SOLVED_LENGTHS;
            }
        }
        out.push(flags as f64);
        out.extend_from_slice(&object.root);
        // Where each segment's joint is, by place in the figure (NaN: the segment was not built).
        count(out, object.ends.len() * 2);
        for end in &object.ends {
            out.extend_from_slice(end);
        }
        // What a 3D bone's joint and start are before perspective (`rawPoint`, `start.rawPoint`), where the pose has a camera.
        let spatial = object.spatial.as_ref();
        match spatial.filter(|spatial| spatial.depths.iter().any(|depth| depth.raw.is_some())) {
            Some(spatial) => raws(out, spatial.depths.iter().map(|depth| depth.raw)),
            None => count(out, 0),
        }
        match spatial.filter(|spatial| spatial.start_raws.iter().any(Option::is_some)) {
            Some(spatial) => raws(out, spatial.start_raws.iter().copied()),
            None => count(out, 0),
        }
        if fig.movieclip.is_some() {
            // A movieclip instance is its handle: forty units from the root along its angle.
            count(out, 1);
            out.extend_from_slice(&[0.0, object.angles.first().copied().unwrap_or(0.0), 0.0, object.lengths.first().copied().unwrap_or(0.0), 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0]);
        } else {
            let mut shapes: Vec<&Item> = items.iter().copied().filter(|item| !matches!(item.kind, ItemKind::Poly | ItemKind::Mesh)).collect();
            shapes.sort_by_key(|item| item.index);
            count(out, shapes.len());
            for item in shapes {
                segment(out, scene, slot, fig, item);
            }
        }
        let polys: Vec<&&Item> = items.iter().filter(|item| item.kind == ItemKind::Poly).collect();
        count(out, polys.len());
        for item in polys {
            poly(out, scene, item);
        }
        if let Some(solution) = solved {
            count(out, solution.angles.len());
            out.extend_from_slice(&solution.angles);
            if let Some(lengths) = &solution.lengths {
                count(out, lengths.len());
                out.extend_from_slice(lengths);
            }
        }
        if let Some(rect) = rect {
            out.extend_from_slice(&rect);
        }
        out[length_at] = (out.len() - start) as f64;
    }
}
