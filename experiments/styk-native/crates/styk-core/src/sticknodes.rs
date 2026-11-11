//! Imported Stick Nodes shapes (src/sticknodes/geometry.mjs): curved segments
//! and the drawables a shaped segment expands into.

use std::f64::consts::PI;
use std::sync::Arc;

use serde_json::Value;

use crate::doc::{Object, Segment};
use crate::geometry::{Item, ItemKind, ITEM_POLYLINE, ITEM_SEG_BRUSH, ITEM_SOLID};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    RoundedSegment,
    Segment,
    Trapezoid,
    Circle,
    Ellipse,
    Triangle,
    Polygon,
}

#[derive(Clone, Debug)]
pub struct Shape {
    pub kind: Kind,
    pub sagitta: f64,
    pub reversed: bool,
    pub circular: bool,
    pub connector: bool,
    pub draw_ratio: Option<f64>,
    pub draw_length: f64,
    pub top_ratio: f64,
    pub thickness_start: Option<f64>,
    pub thickness_end: Option<f64>,
    pub rounded_start: bool,
    pub rounded_end: bool,
    pub half_arc: bool,
    pub upside_down: bool,
    pub circle_outline: bool,
    pub hollow: bool,
    pub outline: Option<[u8; 3]>,
    pub outline_alpha: Option<f64>,
    pub right_direction: f64,
    pub vertices: f64,
}

pub fn parse(v: &Value) -> Option<Arc<Shape>> {
    let kind = match v.get("kind")?.as_str()? {
        "rounded-segment" => Kind::RoundedSegment,
        "segment" => Kind::Segment,
        "trapezoid" => Kind::Trapezoid,
        "circle" => Kind::Circle,
        "ellipse" => Kind::Ellipse,
        "triangle" => Kind::Triangle,
        _ => Kind::Polygon,
    };
    let f = |k: &str| v.get(k).and_then(Value::as_f64);
    let b = |k: &str| match v.get(k) {
        Some(Value::Bool(x)) => *x,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0),
        _ => false,
    };
    let rgb = v.get("outline").and_then(Value::as_array).and_then(|a| Some([a.first()?.as_u64()? as u8, a.get(1)?.as_u64()? as u8, a.get(2)?.as_u64()? as u8]));
    Some(Arc::new(Shape {
        kind,
        sagitta: f("sagitta").unwrap_or(0.0),
        reversed: b("reversed"),
        circular: b("curve_circulization"),
        connector: b("connector"),
        draw_ratio: f("drawRatio").filter(|&x| x != 0.0),
        draw_length: f("drawLength").unwrap_or(0.0),
        top_ratio: f("trapezoid_top_thickness_ratio").unwrap_or(0.5),
        thickness_start: f("trapezoid_thickness_start"),
        thickness_end: f("trapezoid_thickness_end"),
        rounded_start: b("trapezoid_is_rounded_start"),
        rounded_end: b("trapezoid_is_rounded_end"),
        half_arc: b("half_arc"),
        upside_down: b("triangle_upside_down"),
        circle_outline: b("use_circle_outline"),
        hollow: b("circle_is_hollow"),
        outline: rgb,
        outline_alpha: f("outlineAlpha"),
        right_direction: f("right_triangle_direction").unwrap_or(0.0),
        vertices: f("num_polygon_vertices").unwrap_or(5.0),
    }))
}

/// `sticknodesShape`: the effective shape when its primitive matches.
pub fn shape_for<'a>(seg: &'a Segment, obj: &'a Object) -> Option<&'a Shape> {
    let shape = obj.sticknodes_shapes.as_ref().and_then(|m| m.get(&seg.id)).or(seg.sticknodes_shape.as_ref())?;
    let primitive = match shape.kind {
        Kind::RoundedSegment => 0,
        Kind::Segment => 6,
        _ => 3,
    };
    (seg.prim as u8 == primitive).then_some(shape)
}

/// `segmentCurve`: a sagitta curve in segment space.
fn segment_curve(length: f64, sagitta: f64, circular: bool, out: &mut Vec<[f64; 2]>) {
    let l = length.max(0.0);
    let h = sagitta.abs();
    let sign = if sagitta > 0.0 { 1.0 } else if sagitta < 0.0 { -1.0 } else { 1.0 };
    let n = 48usize;
    if h < 1e-7 {
        out.push([0.0, 0.0]);
        out.push([l, 0.0]);
        return;
    }
    if l < 1e-7 {
        let r = h / 2.0;
        for i in 0..=n {
            let a = sign * (PI / 2.0 + 2.0 * PI * i as f64 / n as f64);
            out.push([r * a.cos(), -sign * r + r * a.sin()]);
        }
        return;
    }
    if !circular && h < l / 2.0 {
        for i in 0..=n {
            let a = PI - PI * i as f64 / n as f64;
            out.push([l / 2.0 + l / 2.0 * a.cos(), -sign * h * a.sin()]);
        }
        return;
    }
    let r = (l * l / 4.0 + h * h) / (2.0 * h);
    let cy = sign * (r - h);
    let a0 = (-cy).atan2(-l / 2.0);
    let sweep = sign * 4.0 * h.atan2(l / 2.0);
    for i in 0..=n {
        let a = a0 + sweep * i as f64 / n as f64;
        out.push([l / 2.0 + r * a.cos(), cy + r * a.sin()]);
    }
}

/// `sticknodesCurve`: the curve placed along a segment.
pub fn curve(shape: &Shape, reversed: bool, start: [f64; 2], angle: f64, length: f64, scale: f64, out: &mut Vec<[f64; 2]>) {
    let (s, c) = angle.sin_cos();
    let at = out.len();
    segment_curve(length, shape.sagitta * scale.abs() * if reversed { -1.0 } else { 1.0 }, shape.circular, out);
    for p in &mut out[at..] {
        *p = [start[0] + c * p[0] - s * p[1], start[1] + s * p[0] + c * p[1]];
    }
}

/// `sticknodesDrawables`: replace one shaped segment by its drawables.
pub fn expand(it: &Item, shape: &Shape, item_points: &[[f64; 2]], points: &mut Vec<[f64; 2]>, out: &mut Vec<Item>) {
    let n = shape;
    let scale = it.scale.abs();
    let l = if n.connector { n.draw_ratio.map(|r| it.length * r).unwrap_or(n.draw_length * scale) } else { it.length };
    let t = it.thickness;
    let (sn, c) = it.angle.sin_cos();
    let point = |mut x: f64, mut y: f64| -> [f64; 2] {
        if n.reversed {
            x = it.length - x;
            y = -y;
        }
        [it.start[0] + c * x - sn * y, it.start[1] + sn * x + c * y]
    };
    let start = point(0.0, 0.0);
    let end = point(l, 0.0);
    let mut base = it.clone();
    base.start = if n.reversed { end } else { start };
    base.end = if n.reversed { start } else { end };
    base.length = l;
    let push_points = |points: &mut Vec<[f64; 2]>, list: &[[f64; 2]]| -> (u32, u32) {
        let p0 = points.len() as u32;
        points.extend_from_slice(list);
        (p0, points.len() as u32)
    };
    let poly = |points: &mut Vec<[f64; 2]>, out: &mut Vec<Item>, list: &[[f64; 2]]| {
        let mut p = base.clone();
        p.kind = ItemKind::Poly;
        p.flags |= ITEM_SEG_BRUSH;
        p.points = push_points(points, list);
        out.push(p);
    };
    let circle = |out: &mut Vec<Item>, center: [f64; 2], r: f64, color: Option<[u8; 3]>, inner: f64| {
        let length = if inner != 0.0 { r + inner } else { 2.0 * r };
        let thickness = if inner != 0.0 { r - inner } else { 0.0 };
        let mut p = base.clone();
        p.kind = if inner != 0.0 { ItemKind::CircleClear } else { ItemKind::CircleFill };
        p.start = [center[0] - c * length / 2.0, center[1] - sn * length / 2.0];
        p.end = [center[0] + c * length / 2.0, center[1] + sn * length / 2.0];
        p.length = length;
        p.thickness = thickness;
        p.points = (0, 0);
        if let Some(rgb) = color {
            p.flags |= ITEM_SOLID;
            p.rgb = rgb;
            p.alpha = n.outline_alpha.unwrap_or(1.0);
        }
        out.push(p);
    };
    let oval = |cx: f64, rx: f64, ry: f64, half: bool, flipped: bool| -> Vec<[f64; 2]> {
        let count = if half { 65 } else { 64 };
        (0..count)
            .map(|i| {
                let a = if half { -PI / 2.0 + PI * i as f64 / 64.0 } else { PI * i as f64 / 32.0 };
                point(cx + if flipped { -1.0 } else { 1.0 } * rx * a.cos(), ry * a.sin())
            })
            .collect()
    };
    let curve_points = || -> Vec<[f64; 2]> {
        let is_curve = it.flags & ITEM_POLYLINE != 0;
        if it.bend.abs() > 1e-7 && !is_curve {
            let mut v = item_points.to_vec();
            if n.reversed {
                v.reverse();
            }
            v
        } else if n.sagitta != 0.0 {
            let mut v = Vec::new();
            curve(n, false, start, it.angle + if n.reversed { PI } else { 0.0 }, l, scale, &mut v);
            v
        } else {
            vec![start, end]
        }
    };
    match n.kind {
        Kind::RoundedSegment => {
            let mut line = base.clone();
            let pts = curve_points();
            line.flags |= ITEM_POLYLINE;
            line.points = push_points(points, &pts);
            out.push(line);
        }
        Kind::Segment | Kind::Trapezoid => {
            let pts = curve_points();
            let (mut ws, mut we) = (t, t);
            if n.kind == Kind::Trapezoid {
                let ratio = n.top_ratio;
                we = (t * ratio).abs();
                if ratio < 0.0 {
                    ws = n.thickness_start.unwrap_or(t).abs() * scale;
                    we = n.thickness_end.unwrap_or(t / 2.0).abs() * scale;
                }
            }
            let m = pts.len();
            let mut a = Vec::with_capacity(m * 2);
            let mut b = Vec::with_capacity(m);
            for i in 0..m {
                let prev = pts[i.saturating_sub(1)];
                let next = pts[(i + 1).min(m - 1)];
                let d = (next[0] - prev[0]).hypot(next[1] - prev[1]);
                let d = if d == 0.0 { 1.0 } else { d };
                let r = (ws + (we - ws) * i as f64 / (m - 1).max(1) as f64) / 2.0;
                let (dx, dy) = (-(next[1] - prev[1]) / d * r, (next[0] - prev[0]) / d * r);
                a.push([pts[i][0] + dx, pts[i][1] + dy]);
                b.push([pts[i][0] - dx, pts[i][1] - dy]);
            }
            b.reverse();
            a.extend(b);
            poly(points, out, &a);
            if n.rounded_start {
                circle(out, start, ws / 2.0, None, 0.0);
            }
            if n.rounded_end {
                circle(out, end, we / 2.0, None, 0.0);
            }
        }
        Kind::Circle => {
            let r = (l + t) / 2.0;
            let inner = ((l - t) / 2.0).max(0.0);
            let mid = point(l / 2.0, 0.0);
            if n.half_arc {
                let list = oval(if n.upside_down { l + t / 2.0 } else { -t / 2.0 }, l + t, l + t, true, n.upside_down);
                poly(points, out, &list);
            } else if n.circle_outline && n.hollow {
                circle(out, mid, r, n.outline, inner);
            } else {
                circle(out, mid, r, if n.circle_outline { n.outline } else { None }, 0.0);
                if n.circle_outline && inner > 0.0 {
                    circle(out, mid, inner, None, 0.0);
                }
            }
        }
        Kind::Ellipse => {
            let cx = if n.half_arc { if n.upside_down { l } else { 0.0 } } else { l / 2.0 };
            let list = oval(cx, if n.half_arc { l } else { l / 2.0 }, t / 2.0, n.half_arc, n.upside_down && n.half_arc);
            poly(points, out, &list);
        }
        Kind::Triangle => {
            let dir = if n.right_direction > 0.0 { 1.0 } else if n.right_direction < 0.0 { -1.0 } else { 0.0 };
            let list: Vec<[f64; 2]> = [[0.0, -t / 2.0], [0.0, t / 2.0], [l, dir * t / 2.0]]
                .iter()
                .map(|&[x, y]| point(if n.upside_down { l - x } else { x }, y))
                .collect();
            poly(points, out, &list);
        }
        Kind::Polygon => {
            let count = (n.vertices as i64).clamp(3, 256) as usize;
            let r = (l + t) / 2.0;
            let list: Vec<[f64; 2]> = (0..count)
                .map(|i| {
                    let a = i as f64 * 2.0 * PI / count as f64;
                    point(l / 2.0 + r * a.cos(), r * a.sin())
                })
                .collect();
            poly(points, out, &list);
        }
    }
}
