//! Scene → GPU draw list.
//!
//! Every primitive becomes one fixed-size [`Prim`] record that the GPU expands
//! into a quad and shades analytically (signed distance for strokes, arcs and
//! circles; MSAA for triangles). Records are in world units, so a draw list is
//! view independent: panning and zooming never re-encode or re-upload it.
//!
//! Pivot composites a translucent figure (and a translucent outline) as one
//! layer. Those become isolation [`Group`]s: the renderer draws every group of
//! one nesting depth into an atlas in a single pass, then composites each with
//! a `COMPOSITE` record at its place in the parent's painter order.

use std::f64::consts::PI;
use std::sync::Arc;

use rayon::prelude::*;

use crate::assets::Assets;
use crate::doc::*;
use crate::geometry::{mix_color, Item, ItemKind, Scene};

pub const K_CAPSULE: u32 = 1;
pub const K_ARC: u32 = 2;
pub const K_DISC: u32 = 3;
pub const K_RING: u32 = 4;
pub const K_TRI: u32 = 5;
pub const K_IMAGE: u32 = 6;
pub const K_COMPOSITE: u32 = 7;
pub const K_FILL_VIEW: u32 = 8;
pub const K_BG_IMAGE: u32 = 9;
pub const K_BOX: u32 = 10;
/// A whole open or closed polyline, shaded once per pixel (no joint overlap).
pub const K_POLYLINE: u32 = 11;
pub const F_CLOSED: u32 = 1 << 10;

pub const F_SMOOTH: u32 = 1 << 8;
pub const F_RING_FILL: u32 = 1 << 9;

pub const NO_PAINT: u32 = u32::MAX;

/// One GPU primitive (std430, 64 bytes).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Prim {
    pub kind: u32,
    pub group: u32,
    /// RGBA8, straight alpha.
    pub color: u32,
    /// Offset of a paint record in [`DrawList::paints`] (vec4 units), or `NO_PAINT`.
    pub paint: u32,
    pub a: [f32; 4],
    pub b: [f32; 4],
    pub c: [f32; 4],
}

#[derive(Clone, Copy, Debug)]
pub struct Group {
    pub parent: u32,
    pub depth: u32,
    pub opacity: f32,
    /// World-space bounds (x0, y0, x1, y1) of everything drawn in the group.
    pub bounds: [f32; 4],
}

#[derive(Clone, Copy, Debug)]
pub struct Pass {
    pub depth: u32,
    pub start: u32,
    pub end: u32,
}

#[derive(Clone, Debug, Default)]
pub struct DrawList {
    pub prims: Vec<Prim>,
    pub paints: Vec<[f32; 4]>,
    /// Polyline vertices referenced by `K_POLYLINE` records.
    pub points: Vec<[f32; 2]>,
    pub groups: Vec<Group>,
    /// Prim ranges per depth, deepest first; the last pass (depth 0) is the frame.
    pub passes: Vec<Pass>,
    /// Number of leading root prims that are background fills (drawn unclipped by figures).
    pub background_prims: u32,
}

impl DrawList {
    pub fn bytes(&self) -> usize {
        self.prims.len() * std::mem::size_of::<Prim>() + self.paints.len() * 16 + self.points.len() * 8 + self.groups.len() * 32
    }
}

pub fn rgba8(rgb: [u8; 3], alpha: f64) -> u32 {
    let a = (alpha.clamp(0.0, 1.0) * 255.0).round() as u32;
    rgb[0] as u32 | (rgb[1] as u32) << 8 | (rgb[2] as u32) << 16 | a << 24
}

fn argb8(raw: u32) -> u32 {
    let (a, r, g, b) = (raw >> 24, raw >> 16 & 255, raw >> 8 & 255, raw & 255);
    r | g << 8 | b << 16 | a << 24
}

/// Paint record kinds understood by the shader.
const P_LINEAR: f32 = 0.0;
const P_RADIAL: f32 = 1.0;
const P_ANGULAR: f32 = 2.0;
const P_DIAMOND: f32 = 3.0;
const P_RADIAL_RING: f32 = 4.0;

/// A local primitive list with world bounds, before groups are assigned.
#[derive(Default)]
struct Out {
    prims: Vec<Prim>,
    paints: Vec<[f32; 4]>,
    points: Vec<[f32; 2]>,
    bounds: [f32; 4],
}

impl Out {
    fn new() -> Out {
        Out { prims: Vec::new(), paints: Vec::new(), points: Vec::new(), bounds: [f32::INFINITY, f32::INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY] }
    }
    fn grow(&mut self, x0: f64, y0: f64, x1: f64, y1: f64) {
        self.bounds[0] = self.bounds[0].min(x0 as f32);
        self.bounds[1] = self.bounds[1].min(y0 as f32);
        self.bounds[2] = self.bounds[2].max(x1 as f32);
        self.bounds[3] = self.bounds[3].max(y1 as f32);
    }
    fn push(&mut self, p: Prim, bounds: [f64; 4]) {
        self.grow(bounds[0], bounds[1], bounds[2], bounds[3]);
        self.prims.push(p);
    }
    /// One polyline record (vertex offsets are local and fixed up when merged).
    fn polyline(&mut self, pts: &[[f64; 2]], hw: f64, closed: bool, color: u32, paint: u32) {
        if pts.len() < 2 {
            return;
        }
        // Very long polylines split into overlapping-free runs of 512 vertices.
        let mut start = 0;
        while start + 1 < pts.len() {
            let end = (start + 512).min(pts.len());
            let run = &pts[start..end];
            let at = self.points.len() as u32;
            let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
            for p in run {
                self.points.push([p[0] as f32, p[1] as f32]);
                x0 = x0.min(p[0]);
                y0 = y0.min(p[1]);
                x1 = x1.max(p[0]);
                y1 = y1.max(p[1]);
            }
            let whole = closed && start == 0 && end == pts.len();
            let flags = if whole { F_CLOSED } else { 0 };
            let b = [x0 - hw, y0 - hw, x1 + hw, y1 + hw];
            self.push(
                Prim {
                    kind: K_POLYLINE | flags,
                    group: 0,
                    color,
                    paint,
                    a: [x0 as f32, y0 as f32, x1 as f32, y1 as f32],
                    b: [hw as f32, f32::from_bits(at), f32::from_bits(run.len() as u32), 0.0],
                    c: [0.0; 4],
                },
                b,
            );
            if end == pts.len() {
                break;
            }
            start = end - 1;
        }
    }

    /// Stores a paint record; offsets are local and fixed up when merged.
    fn paint(&mut self, kind: f32, geom: [f32; 4], extra: [f32; 4], stops: &[(f32, [f32; 4])]) -> u32 {
        let at = self.paints.len() as u32;
        self.paints.push([kind, stops.len() as f32, 0.0, 0.0]);
        self.paints.push(geom);
        self.paints.push(extra);
        for &(offset, color) in stops {
            self.paints.push([offset, 0.0, 0.0, 0.0]);
            self.paints.push(color);
        }
        at
    }
}

fn prim(kind: u32, color: u32, paint: u32, a: [f64; 4], b: [f64; 4], c: [f64; 4]) -> Prim {
    let f = |v: [f64; 4]| [v[0] as f32, v[1] as f32, v[2] as f32, v[3] as f32];
    Prim { kind, group: 0, color, paint, a: f(a), b: f(b), c: f(c) }
}

fn stop_color(rgb: [u8; 3], opacity: f64) -> [f32; 4] {
    [rgb[0] as f32 / 255.0, rgb[1] as f32 / 255.0, rgb[2] as f32 / 255.0, opacity.clamp(0.0, 1.0) as f32]
}

/// Colour mapping of a figure's override (`objectColor`).
fn object_color(c: [u8; 3], color: u32) -> [u8; 3] {
    mix_color(c, color)
}

/// `paintGeometry` + record for a paint between two world points.
fn paint_record(out: &mut Out, p: &Paint, stops: &[(f32, [f32; 4])], start: [f64; 2], end: [f64; 2]) -> u32 {
    let length = (end[0] - start[0]).hypot(end[1] - start[1]).max(0.001);
    let angle = (end[1] - start[1]).atan2(end[0] - start[0]) + p.angle * PI / 180.0;
    let (cx, cy) = ((start[0] + end[0]) / 2.0, (start[1] + end[1]) / 2.0);
    let (dx, dy) = (angle.cos() * length / 2.0, angle.sin() * length / 2.0);
    match p.kind {
        PaintKind::Radial => out.paint(P_RADIAL, [cx as f32, cy as f32, (length / 2.0) as f32, 0.0], [0.0; 4], stops),
        PaintKind::Angular => out.paint(P_ANGULAR, [cx as f32, cy as f32, angle as f32, 0.0], [0.0; 4], stops),
        PaintKind::Diamond => out.paint(P_DIAMOND, [cx as f32, cy as f32, angle as f32, (length / 2.0) as f32], [0.0; 4], stops),
        PaintKind::Linear | PaintKind::Solid => {
            out.paint(P_LINEAR, [(cx - dx) as f32, (cy - dy) as f32, (cx + dx) as f32, (cy + dy) as f32], [0.0; 4], stops)
        }
    }
}

struct Ctx<'a> {
    scene: &'a Scene,
    assets: &'a Assets,
}

impl<'a> Ctx<'a> {
    fn figure(&self, it: &Item) -> &Figure {
        &self.scene.figures[it.figure as usize]
    }

    /// Brush of a segment: paint, two-colour gradient, or solid colour.
    fn brush(&self, out: &mut Out, it: &Item, outline: bool) -> (u32, u32) {
        let seg = &self.figure(it).segments[it.index as usize];
        let solid = rgba8(it.rgb, it.alpha);
        if outline || it.color >> 24 == 255 || it.flags & crate::geometry::ITEM_SOLID != 0 {
            return (solid, NO_PAINT);
        }
        if let Some(paint) = &seg.paint {
            let mut stops: Vec<(f32, [f32; 4])> =
                paint.stops.iter().map(|s| (s.offset as f32, stop_color(object_color(s.rgb, it.color), s.opacity))).collect();
            stops.sort_by(|a, b| a.0.total_cmp(&b.0));
            stops[0].1 = stop_color(object_color(seg.rgb, it.color), seg.alpha);
            if let Some((rgb, a)) = seg.secondary
                && stops.len() > 1
            {
                let last = stops.len() - 1;
                stops[last].1 = stop_color(object_color(rgb, it.color), 1.0 - a as f64 / 255.0);
            }
            if stops.len() == 1 || paint.kind == PaintKind::Solid {
                let c = stops[0].1;
                return (rgba8([(c[0] * 255.0).round() as u8, (c[1] * 255.0).round() as u8, (c[2] * 255.0).round() as u8], c[3] as f64), NO_PAINT);
            }
            return (solid, paint_record(out, paint, &stops, it.start, it.end));
        }
        if let Some((rgb, a)) = seg.secondary {
            let mut end = it.end;
            let (dx, dy) = (it.end[0] - it.start[0], it.end[1] - it.start[1]);
            if it.bend.abs() > 1e-7 && matches!(it.kind, ItemKind::Line | ItemKind::SquareLine) {
                let pts = self.scene.points_of(it);
                let (mut minx, mut miny, mut maxx, mut maxy) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
                for p in pts {
                    minx = minx.min(p[0]);
                    maxx = maxx.max(p[0]);
                    miny = miny.min(p[1]);
                    maxy = maxy.max(p[1]);
                }
                let (w, h) = (maxx - minx, maxy - miny);
                if w > 1e-6 && h > 1e-6 {
                    let d = dx * dx / (w * w) + dy * dy / (h * h);
                    let (gx, gy) = (dx / (w * w * d), dy / (h * h * d));
                    let norm = gx * gx + gy * gy;
                    if norm > 0.0 {
                        end = [it.start[0] + gx / norm, it.start[1] + gy / norm];
                    }
                }
            }
            let stops = [(0.0, stop_color(it.rgb, it.alpha)), (1.0, stop_color(object_color(rgb, it.color), 1.0 - a as f64 / 255.0))];
            let rec = out.paint(P_LINEAR, [it.start[0] as f32, it.start[1] as f32, end[0] as f32, end[1] as f32], [0.0; 4], &stops);
            return (solid, rec);
        }
        (solid, NO_PAINT)
    }

    /// Emits one drawable. `outline` is the outline half-extension (0 = normal pass).
    fn item(&self, out: &mut Out, it: &Item, outline: f64, outline_rgb: [u8; 3]) {
        let fig = self.figure(it);
        match it.kind {
            ItemKind::Poly => self.poly(out, it, outline, outline_rgb),
            ItemKind::Line | ItemKind::SquareLine => {
                let width = it.thickness + 2.0 * outline;
                if width <= 0.0 {
                    return;
                }
                let (color, paint) = if outline > 0.0 { (rgba8(outline_rgb, 1.0), NO_PAINT) } else { self.brush(out, it, false) };
                let hw = width / 2.0;
                let square = it.kind == ItemKind::SquareLine;
                if it.flags & crate::geometry::ITEM_POLYLINE != 0 {
                    // Curved Stick Nodes strokes: one polyline, round caps and joins.
                    let pts = self.scene.points_of(it);
                    out.polyline(pts, hw, false, color, paint);
                } else if it.bend.abs() > 1e-7 {
                    self.arc(out, it, hw, color, paint);
                } else {
                    let (s, e) = (it.start, it.end);
                    let pad = if square { hw * std::f64::consts::SQRT_2 } else { hw };
                    let b = [s[0].min(e[0]) - pad, s[1].min(e[1]) - pad, s[0].max(e[0]) + pad, s[1].max(e[1]) + pad];
                    let kind = if square { K_BOX } else { K_CAPSULE };
                    out.push(prim(kind, color, paint, [s[0], s[1], e[0], e[1]], [hw, 0.0, 0.0, 0.0], [0.0; 4]), b);
                }
            }
            ItemKind::Circle | ItemKind::CircleFill | ItemKind::CircleClear => {
                let width = it.thickness + 2.0 * outline;
                let filled = it.kind == ItemKind::CircleFill || width >= it.length.abs();
                let radius = (it.length.abs() + if filled { width } else { 0.0 }) / 2.0;
                if radius == 0.0 {
                    return;
                }
                let c = [(it.start[0] + it.end[0]) / 2.0, (it.start[1] + it.end[1]) / 2.0];
                let (color, paint) = if outline > 0.0 { (rgba8(outline_rgb, 1.0), NO_PAINT) } else { self.brush(out, it, false) };
                if filled {
                    out.push(prim(K_DISC, color, paint, [c[0], c[1], radius, 0.0], [0.0; 4], [0.0; 4]), [c[0] - radius, c[1] - radius, c[0] + radius, c[1] + radius]);
                    return;
                }
                let hw = width / 2.0;
                let outer = radius + hw.max(0.0);
                let bounds = [c[0] - outer, c[1] - outer, c[0] + outer, c[1] + outer];
                if it.kind == ItemKind::Circle {
                    // White interior (or the brush itself when outlining), then the ring.
                    let fill = if outline > 0.0 { color } else { rgba8([255, 255, 255], it.alpha) };
                    let flags = F_RING_FILL;
                    let kind = if width > 0.0 { K_RING } else { K_DISC };
                    if kind == K_DISC {
                        out.push(prim(K_DISC, fill, NO_PAINT, [c[0], c[1], radius, 0.0], [0.0; 4], [0.0; 4]), bounds);
                    } else {
                        out.push(
                            prim(K_RING | flags, color, paint, [c[0], c[1], radius, hw], [f32::from_bits(fill) as f64, 0.0, 0.0, 0.0], [0.0; 4]),
                            bounds,
                        );
                    }
                } else if width > 0.0 {
                    out.push(prim(K_RING, color, paint, [c[0], c[1], radius, hw], [0.0; 4], [0.0; 4]), bounds);
                }
            }
            ItemKind::Image => {
                if outline > 0.0 {
                    return;
                }
                let seg = &fig.segments[it.index as usize];
                let Some(asset) = fig.image(seg.asset) else { return };
                self.image(out, it, seg, asset);
            }
            ItemKind::Text => {
                if outline > 0.0 {
                    return;
                }
                let seg = &fig.segments[it.index as usize];
                let Some(text) = fig.text(seg.asset) else { return };
                self.text(out, it, seg, text);
            }
        }
    }

    fn arc(&self, out: &mut Out, it: &Item, hw: f64, color: u32, paint: u32) {
        let r = it.length / it.bend;
        let (s, c) = it.angle.sin_cos();
        let center = [it.start[0] - r * s, it.start[1] + r * c];
        let radius = r.abs();
        let theta0 = if r > 0.0 { it.angle - PI / 2.0 } else { it.angle + PI / 2.0 };
        let sweep = it.bend.clamp(-2.0 * PI, 2.0 * PI);
        // Bounds: the points of the sampled arc, padded by the half width.
        let pts = self.scene.points_of(it);
        let mut b = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
        for p in pts {
            b = [b[0].min(p[0]), b[1].min(p[1]), b[2].max(p[0]), b[3].max(p[1])];
        }
        // Chords stay inside the arc's own bulge; add the sagitta of one step.
        let pad = hw + radius * (1.0 - (sweep.abs() / 16.0).cos()).abs() + 0.5;
        b = [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
        out.push(prim(K_ARC, color, paint, [center[0], center[1], radius, hw], [theta0, sweep, 0.0, 0.0], [0.0; 4]), b);
    }

    fn poly(&self, out: &mut Out, it: &Item, outline: f64, outline_rgb: [u8; 3]) {
        let pts = self.scene.points_of(it);
        if pts.len() < 3 {
            return;
        }
        if outline > 0.0 {
            // Stroke of the closed outline path, width 2*outline, round joins.
            out.polyline(pts, outline, true, rgba8(outline_rgb, 1.0), NO_PAINT);
            return;
        }
        let (color, paint) = if it.flags & crate::geometry::ITEM_SEG_BRUSH != 0 { self.brush(out, it, false) } else { (rgba8(it.rgb, it.alpha), NO_PAINT) };
        if convex(pts) {
            for k in 1..pts.len() - 1 {
                tri(out, color, paint, pts[0], pts[k], pts[k + 1]);
            }
            return;
        }
        let mut builder = lyon_path::Path::builder();
        builder.begin(lyon_path::math::point(pts[0][0] as f32, pts[0][1] as f32));
        for p in &pts[1..] {
            builder.line_to(lyon_path::math::point(p[0] as f32, p[1] as f32));
        }
        builder.end(true);
        let tris = crate::assets::triangulate(&builder.build(), lyon_tessellation::FillRule::EvenOdd, 0.05);
        for t in tris.chunks_exact(3) {
            let f = |v: [f32; 2]| [v[0] as f64, v[1] as f64];
            tri(out, color, paint, f(t[0]), f(t[1]), f(t[2]));
        }
    }

    /// Sprite placement (`drawPrimitives` image branch).
    fn image(&self, out: &mut Out, it: &Item, seg: &Segment, a: &ImageAsset) {
        if a.anchor_length == 0.0 {
            return;
        }
        let mirror = seg.mirror != it.image_text_flags;
        let start = if seg.reverse { it.end } else { it.start };
        let theta = (if mirror { it.angle + a.anchor_angle - PI } else { it.angle - a.anchor_angle }) + if seg.reverse { PI } else { 0.0 };
        let k = (it.end[0] - it.start[0]).hypot(it.end[1] - it.start[1]) / a.anchor_length;
        let sx = if mirror { -k } else { k };
        let (sin, cos) = theta.sin_cos();
        let place = |anchor: [f64; 2], px: f64, py: f64| -> [f64; 2] {
            let (lx, ly) = (sx * (px - anchor[0]), k * (py - anchor[1]));
            [start[0] + cos * lx - sin * ly, start[1] + sin * lx + cos * ly]
        };
        let color = rgba8([255, 255, 255], it.alpha);
        let flags = if a.smooth { F_SMOOTH } else { 0 };
        let mut quad = |anchor: [f64; 2], x: f64, y: f64, w: f64, h: f64, image: u32| {
            let Some(e) = self.assets.image(image) else { return };
            let o = place(anchor, x, y);
            let u = place(anchor, x + w, y);
            let v = place(anchor, x, y + h);
            let (ux, uy, vx, vy) = (u[0] - o[0], u[1] - o[1], v[0] - o[0], v[1] - o[1]);
            let far = [o[0] + ux + vx, o[1] + uy + vy];
            let xs = [o[0], u[0], v[0], far[0]];
            let ys = [o[1], u[1], v[1], far[1]];
            let b = [
                xs.iter().copied().fold(f64::INFINITY, f64::min),
                ys.iter().copied().fold(f64::INFINITY, f64::min),
                xs.iter().copied().fold(f64::NEG_INFINITY, f64::max),
                ys.iter().copied().fold(f64::NEG_INFINITY, f64::max),
            ];
            let uv = e.uv();
            out.push(
                prim(K_IMAGE | flags, color, NO_PAINT, [o[0], o[1], ux, uy], [vx, vy, e.layer as f64, 0.0], [uv[0] as f64, uv[1] as f64, uv[2] as f64, uv[3] as f64]),
                b,
            );
        };
        if let Some(tiles) = &a.tiles {
            for &(x, y, image) in &tiles.tiles {
                quad(tiles.anchor, x, y, crate::drawing::TILE as f64, crate::drawing::TILE as f64, image);
            }
            return;
        }
        let Some(image) = a.image else { return };
        let Some(e) = self.assets.image(image) else { return };
        let [w, h] = a.display_size.unwrap_or([e.source_w as f64, e.source_h as f64]);
        quad(a.anchor_start, 0.0, 0.0, w, h, image);
    }

    /// Vector text (`drawPrimitives` text branch), even-odd filled glyphs.
    fn text(&self, out: &mut Out, it: &Item, seg: &Segment, t: &TextAsset) {
        if t.width == 0.0 || t.placements.is_empty() {
            return;
        }
        let mirror = seg.mirror != it.image_text_flags;
        let start = if seg.reverse { it.end } else { it.start };
        let theta = it.angle + if seg.reverse { PI } else { 0.0 } - if mirror { PI } else { 0.0 };
        let xs = (it.end[0] - it.start[0]).hypot(it.end[1] - it.start[1]) / t.width;
        let sx = if mirror { -xs } else { xs };
        let sy = it.scale;
        let (sin, cos) = theta.sin_cos();
        let place = |x: f64, y: f64| -> [f64; 2] {
            let (lx, ly) = (sx * x, sy * y);
            [start[0] + cos * lx - sin * ly, start[1] + sin * lx + cos * ly]
        };
        let (color, paint) = if it.color >> 24 != 255 && seg.secondary.is_some() {
            // Vertical gradient from the baseline to the top of the text.
            let (rgb, a) = seg.secondary.unwrap();
            let stops = [(0.0, stop_color(it.rgb, it.alpha)), (1.0, stop_color(object_color(rgb, it.color), 1.0 - a as f64 / 255.0))];
            let p0 = place(0.0, 0.0);
            let p1 = place(0.0, -t.height);
            (rgba8(it.rgb, it.alpha), out.paint(P_LINEAR, [p0[0] as f32, p0[1] as f32, p1[0] as f32, p1[1] as f32], [0.0; 4], &stops))
        } else {
            (rgba8(it.rgb, it.alpha), NO_PAINT)
        };
        for &(g, dx, dy) in &t.placements {
            let Some(tris) = t.glyphs.get(g as usize).and_then(|glyph| self.assets.glyph(glyph)) else { continue };
            for tr in tris.chunks_exact(3) {
                let p = |v: [f32; 2]| place(v[0] as f64 + dx as f64, v[1] as f64 + dy as f64);
                let (a, b, c) = (p(tr[0]), p(tr[1]), p(tr[2]));
                let bounds = [a[0].min(b[0]).min(c[0]), a[1].min(b[1]).min(c[1]), a[0].max(b[0]).max(c[0]), a[1].max(b[1]).max(c[1])];
                out.push(prim(K_TRI, color, paint, [a[0], a[1], b[0], b[1]], [c[0], c[1], 0.0, 0.0], [0.0; 4]), bounds);
            }
        }
    }
}

fn tri(out: &mut Out, color: u32, paint: u32, a: [f64; 2], b: [f64; 2], c: [f64; 2]) {
    let bounds = [a[0].min(b[0]).min(c[0]), a[1].min(b[1]).min(c[1]), a[0].max(b[0]).max(c[0]), a[1].max(b[1]).max(c[1])];
    out.push(prim(K_TRI, color, paint, [a[0], a[1], b[0], b[1]], [c[0], c[1], 0.0, 0.0], [0.0; 4]), bounds);
}

/// Strictly convex simple polygon (same turn direction everywhere, one winding).
fn convex(p: &[[f64; 2]]) -> bool {
    let n = p.len();
    if n < 3 {
        return false;
    }
    let mut sign = 0.0;
    let mut turn = 0.0;
    for i in 0..n {
        let (a, b, c) = (p[i], p[(i + 1) % n], p[(i + 2) % n]);
        let (ux, uy, vx, vy) = (b[0] - a[0], b[1] - a[1], c[0] - b[0], c[1] - b[1]);
        let cross = ux * vy - uy * vx;
        if cross.abs() < 1e-12 {
            continue;
        }
        if sign == 0.0 {
            sign = cross.signum();
        } else if cross.signum() != sign {
            return false;
        }
        turn += (ux * vy - uy * vx).atan2(ux * vx + uy * vy);
    }
    sign != 0.0 && (turn.abs() - 2.0 * PI).abs() < 1e-3
}

/// One object's primitives with its isolation structure.
struct ObjectOut {
    opacity: f64,
    outline_alpha: f64,
    outline: Out,
    items: Out,
}

/// The background layers (`drawBackground`), as view-filling primitives.
fn background(doc: &Document, assets: &Assets, scene: &Scene, out: &mut Out) {
    // `sceneBackgroundColor`: a hidden Scene layer is transparent; a colour key replaces the fill.
    let scene_hidden = doc.layers.as_ref().is_some_and(|l| !l.scene_visible);
    let key = if scene_hidden { Some(0) } else { scene.background_color };
    if let Some(argb) = key {
        let everywhere = [f64::NEG_INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::INFINITY];
        out.push(prim(K_FILL_VIEW, argb8(argb), NO_PAINT, [0.0; 4], [0.0; 4], [0.0; 4]), everywhere);
        return;
    }
    let (a, b, mix) = scene.background;
    let (w, h) = (doc.canvas[0] as f64, doc.canvas[1] as f64);
    let mut layer = |id: u32, alpha: f64| {
        let bg = doc.backgrounds.iter().find(|x| x.id == id);
        let fill = |color: u32, paint: u32| prim(K_FILL_VIEW, color, paint, [0.0; 4], [0.0; 4], [0.0; 4]);
        let everywhere = [f64::NEG_INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::INFINITY];
        let with_alpha = |c: u32| -> u32 {
            let a = ((c >> 24) as f64 * alpha).round() as u32;
            (c & 0x00ff_ffff) | a.min(255) << 24
        };
        let argb_stop = |raw: u32| -> [f32; 4] {
            [(raw >> 16 & 255) as f32 / 255.0, (raw >> 8 & 255) as f32 / 255.0, (raw & 255) as f32 / 255.0, ((raw >> 24) as f64 / 255.0 * alpha) as f32]
        };
        match bg.map(|b| &b.kind) {
            None => out.push(fill(with_alpha(0xffff_ffff), NO_PAINT), everywhere),
            Some(BackgroundKind::Solid { argb }) => out.push(fill(with_alpha(argb8(*argb)), NO_PAINT), everywhere),
            Some(BackgroundKind::Linear { a, b, x1, y1, x2, y2 }) => {
                let rec = out.paint(P_LINEAR, [(x1 * w) as f32, (y1 * h) as f32, (x2 * w) as f32, (y2 * h) as f32], [0.0; 4], &[(0.0, argb_stop(*a)), (1.0, argb_stop(*b))]);
                out.push(fill(0, rec), everywhere);
            }
            Some(BackgroundKind::Radial { a, b, x1, y1, x2, y2 }) => {
                let outer = y2 * h;
                if outer <= 0.0 {
                    out.push(fill(with_alpha(argb8(*a)), NO_PAINT), everywhere);
                } else {
                    let inner = (x2 * h).max(0.0).min(0.99 * outer);
                    let rec = out.paint(
                        P_RADIAL_RING,
                        [(x1 * w) as f32, (y1 * h) as f32, inner as f32, outer as f32],
                        [0.0; 4],
                        &[(0.0, argb_stop(*b)), (1.0, argb_stop(*a))],
                    );
                    out.push(fill(0, rec), everywhere);
                }
            }
            Some(BackgroundKind::Paint(p)) => {
                let stops: Vec<(f32, [f32; 4])> = p.stops.iter().map(|s| (s.offset as f32, stop_color(s.rgb, s.opacity * alpha))).collect();
                if stops.len() == 1 || p.kind == PaintKind::Solid {
                    let c = stops[0].1;
                    out.push(fill(rgba8([(c[0] * 255.0) as u8, (c[1] * 255.0) as u8, (c[2] * 255.0) as u8], c[3] as f64), NO_PAINT), everywhere);
                } else {
                    let rec = paint_record(out, p, &stops, [0.0, h / 2.0], [w, h / 2.0]);
                    out.push(fill(0, rec), everywhere);
                }
            }
            Some(BackgroundKind::Image { image }) => {
                let Some(e) = image.and_then(|i| assets.image(i)) else { return };
                let (iw, ih) = (e.source_w as f64, e.source_h as f64);
                let s = (w / iw).max(h / ih);
                let uv = e.uv();
                out.push(
                    prim(K_BG_IMAGE, rgba8([255, 255, 255], alpha), NO_PAINT, [iw * s, ih * s, e.layer as f64, 0.0], [0.0; 4], [uv[0] as f64, uv[1] as f64, uv[2] as f64, uv[3] as f64]),
                    everywhere,
                );
            }
        }
    };
    layer(a, 1.0);
    if mix > 0.0 {
        layer(b, mix / 255.0);
    }
}

/// Encodes a scene. Objects encode in parallel; groups are merged in order.
pub fn encode(doc: &Document, assets: &Assets, scene: &Scene) -> DrawList {
    let ctx = Ctx { scene, assets };
    // Leaf runs: consecutive items of one figure instance (same slot and clip chain).
    let mut runs: Vec<(usize, usize)> = Vec::new();
    let mut i = 0;
    while i < scene.items.len() {
        let (slot, chain) = (scene.items[i].slot, scene.items[i].chain);
        let mut j = i + 1;
        while j < scene.items.len() && scene.items[j].slot == slot && scene.items[j].chain == chain {
            j += 1;
        }
        runs.push((i, j));
        i = j;
    }
    let encode_run = |&(a, b): &(usize, usize)| -> Option<ObjectOut> {
        let first = &scene.items[a];
        let opacity = first.opacity;
        if opacity <= 0.0 {
            return None;
        }
        let fig = &scene.figures[first.figure as usize];
        let mut outline = Out::new();
        let mut outline_alpha = 1.0;
        if let Some(o) = &fig.outline {
            outline_alpha = o.alpha;
            if outline_alpha > 0.0 {
                for it in &scene.items[a..b] {
                    if it.kind != ItemKind::Image {
                        ctx.item(&mut outline, it, o.width * it.scale.abs(), o.rgb);
                    }
                }
            }
        }
        let mut items = Out::new();
        for it in &scene.items[a..b] {
            ctx.item(&mut items, it, 0.0, [0, 0, 0]);
        }
        Some(ObjectOut { opacity, outline_alpha, outline, items })
    };
    let objects: Vec<Option<ObjectOut>> = if runs.len() >= 16 { runs.par_iter().map(encode_run).collect() } else { runs.iter().map(encode_run).collect() };

    let mut b = Builder::new();
    let mut root = Out::new();
    background(doc, assets, scene, &mut root);
    let background_prims = root.prims.len() as u32;
    b.add(0, root);
    // Open movieclip owner groups: (level key, owner, group or pass-through, skipped).
    let mut stack: Vec<Open> = Vec::new();
    for (k, &(a, _)) in runs.iter().enumerate() {
        let first = &scene.items[a];
        // Owner path of this run: one entry per enclosing movieclip.
        let path: Vec<(u32, u32)> = match first.chain {
            crate::geometry::NO_CHAIN => vec![],
            c => {
                let chain = &scene.chains[c as usize];
                chain.iter().enumerate().map(|(level, &(owner, _))| (if level == 0 { first.slot } else { chain[level - 1].1 }, owner)).collect()
            }
        };
        let common = stack.iter().zip(path.iter()).take_while(|(o, p)| o.key == p.0 && o.owner == p.1).count();
        while stack.len() > common {
            let open = stack.pop().unwrap();
            b.close(open, stack.last());
        }
        for &(key, owner) in &path[common..] {
            let opacity = scene.owners[owner as usize];
            let parent = stack.last().map(|o| o.target).unwrap_or(0);
            let skipped = stack.last().is_some_and(|o| o.skipped) || opacity <= 0.0;
            let target = if !skipped && opacity < 1.0 { b.open(parent, opacity) } else { parent };
            stack.push(Open { key, owner, target, isolated: target != parent, skipped, opacity });
        }
        if stack.last().is_some_and(|o| o.skipped) {
            continue;
        }
        let Some(o) = objects[k].as_ref() else { continue };
        let parent = stack.last().map(|o| o.target).unwrap_or(0);
        b.object(parent, o);
    }
    while let Some(open) = stack.pop() {
        b.close(open, stack.last());
    }
    let (prims, paints, points, groups, passes) = b.finish();
    DrawList { prims, paints, points, groups, passes, background_prims }
}

struct Open {
    key: u32,
    owner: u32,
    /// Group receiving this owner's content (its own group, or the parent's when opaque).
    target: usize,
    isolated: bool,
    skipped: bool,
    opacity: f64,
}

/// Collects prims per isolation group, then orders them deepest first.
struct Builder {
    groups: Vec<Group>,
    prims: Vec<Vec<Prim>>,
    paints: Vec<[f32; 4]>,
    points: Vec<[f32; 2]>,
}

impl Builder {
    fn new() -> Builder {
        let empty = [f32::INFINITY, f32::INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY];
        Builder { groups: vec![Group { parent: 0, depth: 0, opacity: 1.0, bounds: empty }], prims: vec![Vec::new()], paints: Vec::new(), points: Vec::new() }
    }

    fn open(&mut self, parent: usize, opacity: f64) -> usize {
        let id = self.groups.len();
        let empty = [f32::INFINITY, f32::INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY];
        self.groups.push(Group { parent: parent as u32, depth: self.groups[parent].depth + 1, opacity: opacity as f32, bounds: empty });
        self.prims.push(Vec::new());
        id
    }

    /// Finishes a group: its composite lands at this point of the parent's order.
    fn close(&mut self, open: Open, _parent: Option<&Open>) {
        if !open.isolated {
            return;
        }
        let g = self.groups[open.target];
        let bounds = g.bounds;
        let parent = g.parent as usize;
        if bounds[0] <= bounds[2] {
            self.prims[parent].push(composite(open.target as u32, open.opacity, bounds));
            self.grow(parent, bounds);
        }
    }

    fn grow(&mut self, group: usize, b: [f32; 4]) {
        let g = &mut self.groups[group].bounds;
        *g = union(*g, b);
    }

    fn add(&mut self, target: usize, out: Out) {
        self.add_ref(target, &out);
    }

    fn add_ref(&mut self, target: usize, out: &Out) {
        let base = self.paints.len() as u32;
        let point_base = self.points.len() as u32;
        self.paints.extend_from_slice(&out.paints);
        self.points.extend_from_slice(&out.points);
        if out.bounds[0] <= out.bounds[2] {
            self.grow(target, out.bounds);
        }
        for p in &out.prims {
            let mut p = *p;
            if p.paint != NO_PAINT {
                p.paint += base;
            }
            if p.kind & 255 == K_POLYLINE {
                p.b[1] = f32::from_bits(p.b[1].to_bits() + point_base);
            }
            self.prims[target].push(p);
        }
    }

    /// One figure instance: object opacity layer, outline layer, then its items.
    fn object(&mut self, parent: usize, o: &ObjectOut) {
        let isolate = o.opacity < 1.0;
        let target = if isolate { self.open(parent, o.opacity) } else { parent };
        if !o.outline.prims.is_empty() {
            if o.outline_alpha < 1.0 {
                let id = self.open(target, o.outline_alpha);
                self.add_ref(id, &o.outline);
                self.close(Open { key: 0, owner: 0, target: id, isolated: true, skipped: false, opacity: o.outline_alpha }, None);
            } else {
                self.add_ref(target, &o.outline);
            }
        }
        self.add_ref(target, &o.items);
        if isolate {
            self.close(Open { key: 0, owner: 0, target, isolated: true, skipped: false, opacity: o.opacity }, None);
        }
    }

    fn finish(mut self) -> (Vec<Prim>, Vec<[f32; 4]>, Vec<[f32; 2]>, Vec<Group>, Vec<Pass>) {
        let max_depth = self.groups.iter().map(|g| g.depth).max().unwrap_or(0);
        let mut prims = Vec::with_capacity(self.prims.iter().map(Vec::len).sum());
        let mut passes = Vec::new();
        for depth in (0..=max_depth).rev() {
            let start = prims.len() as u32;
            for (gi, list) in self.prims.iter_mut().enumerate() {
                if self.groups[gi].depth != depth {
                    continue;
                }
                for mut p in list.drain(..) {
                    p.group = gi as u32;
                    prims.push(p);
                }
            }
            passes.push(Pass { depth, start, end: prims.len() as u32 });
        }
        (prims, self.paints, self.points, self.groups, passes)
    }
}

fn union(a: [f32; 4], b: [f32; 4]) -> [f32; 4] {
    [a[0].min(b[0]), a[1].min(b[1]), a[2].max(b[2]), a[3].max(b[3])]
}

fn composite(group: u32, opacity: f64, bounds: [f32; 4]) -> Prim {
    Prim {
        kind: K_COMPOSITE,
        group: 0,
        color: rgba8([255, 255, 255], opacity),
        paint: NO_PAINT,
        a: bounds,
        b: [f32::from_bits(group), 0.0, 0.0, 0.0],
        c: [0.0; 4],
    }
}

/// Shared handle for a draw list produced on a worker thread.
pub type SharedDrawList = Arc<DrawList>;
