//! Text assets are font-independent vector outlines. This module turns Pivot's
//! binary glyph opcodes and StykAnimate's SVG path strings into one absolute
//! path representation, and computes Pivot's text bounds (control points
//! included, each placement rounded to float32 like the native loader).

use std::sync::Arc;

use crate::doc::{Glyph, PathCmd, TextAsset};

/// Converts Pivot glyph opcodes (`M L C Z V H`, absolute) to path commands.
pub fn parse_glyph_commands(ops: &[(char, Vec<f64>)]) -> Vec<PathCmd> {
    let mut out = Vec::with_capacity(ops.len());
    let (mut x, mut y) = (0.0f32, 0.0f32);
    for (op, v) in ops {
        let v: Vec<f32> = v.iter().map(|&n| n as f32).collect();
        match op {
            'M' => {
                (x, y) = (v[0], v[1]);
                out.push(PathCmd::Move(x, y));
            }
            'L' => {
                (x, y) = (v[0], v[1]);
                out.push(PathCmd::Line(x, y));
            }
            'C' => {
                out.push(PathCmd::Cubic(v[0], v[1], v[2], v[3], v[4], v[5]));
                (x, y) = (v[4], v[5]);
            }
            'H' => {
                x = v[0];
                out.push(PathCmd::Line(x, y));
            }
            'V' => {
                y = v[0];
                out.push(PathCmd::Line(x, y));
            }
            _ => out.push(PathCmd::Close),
        }
    }
    out
}

/// Bounds over every stored point including cubic control points (FMX VA550C64).
pub fn path_bounds(path: &[PathCmd]) -> Option<[f32; 4]> {
    let mut b = [f32::INFINITY, f32::INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY];
    let mut any = false;
    let mut add = |x: f32, y: f32| {
        any = true;
        b[0] = b[0].min(x);
        b[1] = b[1].min(y);
        b[2] = b[2].max(x);
        b[3] = b[3].max(y);
    };
    for cmd in path {
        match *cmd {
            PathCmd::Move(x, y) | PathCmd::Line(x, y) => add(x, y),
            PathCmd::Cubic(a, b2, c, d, e, f) => {
                add(a, b2);
                add(c, d);
                add(e, f);
            }
            PathCmd::Close => {}
        }
    }
    any.then_some(b)
}

/// Accumulates placed glyphs of one Pivot text asset.
pub struct TextBuilder {
    index: u32,
    glyphs: Vec<(Vec<PathCmd>, Arc<Glyph>)>,
    raw: Vec<(u32, f32, f32)>,
    bounds: [f32; 4],
    any: bool,
}

impl TextBuilder {
    pub fn new(index: u32) -> Self {
        TextBuilder { index, glyphs: vec![], raw: vec![], bounds: [0.0; 4], any: false }
    }

    pub fn place(&mut self, path: &[PathCmd], x: f64, y: f64) {
        let gi = match self.glyphs.iter().position(|(p, _)| p.as_slice() == path) {
            Some(i) => i,
            None => {
                // Pivot's stored glyph bounds are its control-point bounds (`path_bounds`).
                let bounds = path_bounds(path).filter(|b| b[2] > b[0] && b[3] > b[1]).map(|b| b.map(f64::from));
                self.glyphs.push((path.to_vec(), Arc::new(Glyph { path: path.to_vec(), bounds })));
                self.glyphs.len() - 1
            }
        };
        if let Some(b) = path_bounds(path) {
            let placed = [
                (b[0] as f64 + x) as f32,
                (b[1] as f64 + y) as f32,
                (b[2] as f64 + x) as f32,
                (b[3] as f64 + y) as f32,
            ];
            if !self.any {
                self.bounds = placed;
                self.any = true;
            } else {
                self.bounds[0] = self.bounds[0].min(placed[0]);
                self.bounds[1] = self.bounds[1].min(placed[1]);
                self.bounds[2] = self.bounds[2].max(placed[2]);
                self.bounds[3] = self.bounds[3].max(placed[3]);
            }
        }
        self.raw.push((gi as u32, x as f32, y as f32));
    }

    pub fn finish(self) -> TextAsset {
        let [left, top, right, bottom] = self.bounds;
        let width = (right - left) as f64;
        let height = (bottom - top) as f64;
        let placements = self
            .raw
            .iter()
            .map(|&(g, x, y)| (g, (x as f64 - left as f64) as f32, (y as f64 - bottom as f64) as f32))
            .collect();
        TextAsset {
            index: self.index,
            glyphs: self.glyphs.into_iter().map(|(_, g)| g).collect(),
            placements,
            width: width as f32 as f64,
            height: height as f32 as f64,
        }
    }
}

/// Parses SVG path data (M L H V C S Q T A Z, absolute and relative).
/// Quadratic curves become cubics; arcs are approximated by their chord.
pub fn parse_svg_path(data: &str) -> Vec<PathCmd> {
    let bytes = data.as_bytes();
    let mut i = 0;
    let mut out = Vec::new();
    let (mut x, mut y) = (0.0f64, 0.0f64);
    let (mut sx, mut sy) = (0.0f64, 0.0f64);
    let mut last_ctrl: Option<(f64, f64)> = None;
    let mut last_quad: Option<(f64, f64)> = None;
    let mut cmd = b'M';
    let skip = |i: &mut usize| {
        while *i < bytes.len() && (bytes[*i].is_ascii_whitespace() || bytes[*i] == b',') {
            *i += 1;
        }
    };
    let number = |i: &mut usize| -> Option<f64> {
        skip(i);
        let start = *i;
        let mut seen_dot = false;
        let mut seen_exp = false;
        if *i < bytes.len() && (bytes[*i] == b'-' || bytes[*i] == b'+') {
            *i += 1;
        }
        while *i < bytes.len() {
            let c = bytes[*i];
            if c.is_ascii_digit() {
                *i += 1;
            } else if c == b'.' && !seen_dot && !seen_exp {
                seen_dot = true;
                *i += 1;
            } else if (c == b'e' || c == b'E') && !seen_exp {
                seen_exp = true;
                *i += 1;
                if *i < bytes.len() && (bytes[*i] == b'-' || bytes[*i] == b'+') {
                    *i += 1;
                }
            } else {
                break;
            }
        }
        if *i == start {
            return None;
        }
        data[start..*i].parse().ok()
    };
    loop {
        skip(&mut i);
        if i >= bytes.len() {
            break;
        }
        if bytes[i].is_ascii_alphabetic() {
            cmd = bytes[i];
            i += 1;
        }
        let rel = cmd.is_ascii_lowercase();
        let (ox, oy) = if rel { (x, y) } else { (0.0, 0.0) };
        match cmd.to_ascii_uppercase() {
            b'Z' => {
                out.push(PathCmd::Close);
                (x, y) = (sx, sy);
                last_ctrl = None;
                last_quad = None;
                continue;
            }
            b'M' => {
                let (Some(a), Some(b)) = (number(&mut i), number(&mut i)) else { break };
                (x, y) = (ox + a, oy + b);
                (sx, sy) = (x, y);
                out.push(PathCmd::Move(x as f32, y as f32));
                cmd = if rel { b'l' } else { b'L' };
                last_ctrl = None;
                last_quad = None;
            }
            b'L' => {
                let (Some(a), Some(b)) = (number(&mut i), number(&mut i)) else { break };
                (x, y) = (ox + a, oy + b);
                out.push(PathCmd::Line(x as f32, y as f32));
                last_ctrl = None;
                last_quad = None;
            }
            b'H' => {
                let Some(a) = number(&mut i) else { break };
                x = if rel { x + a } else { a };
                out.push(PathCmd::Line(x as f32, y as f32));
                last_ctrl = None;
                last_quad = None;
            }
            b'V' => {
                let Some(a) = number(&mut i) else { break };
                y = if rel { y + a } else { a };
                out.push(PathCmd::Line(x as f32, y as f32));
                last_ctrl = None;
                last_quad = None;
            }
            b'C' => {
                let v: Option<Vec<f64>> = (0..6).map(|_| number(&mut i)).collect();
                let Some(v) = v else { break };
                let (c1x, c1y, c2x, c2y) = (ox + v[0], oy + v[1], ox + v[2], oy + v[3]);
                (x, y) = (ox + v[4], oy + v[5]);
                out.push(PathCmd::Cubic(c1x as f32, c1y as f32, c2x as f32, c2y as f32, x as f32, y as f32));
                last_ctrl = Some((c2x, c2y));
                last_quad = None;
            }
            b'S' => {
                let v: Option<Vec<f64>> = (0..4).map(|_| number(&mut i)).collect();
                let Some(v) = v else { break };
                let (c1x, c1y) = last_ctrl.map(|(cx, cy)| (2.0 * x - cx, 2.0 * y - cy)).unwrap_or((x, y));
                let (c2x, c2y) = (ox + v[0], oy + v[1]);
                (x, y) = (ox + v[2], oy + v[3]);
                out.push(PathCmd::Cubic(c1x as f32, c1y as f32, c2x as f32, c2y as f32, x as f32, y as f32));
                last_ctrl = Some((c2x, c2y));
                last_quad = None;
            }
            b'Q' | b'T' => {
                let (qx, qy, ex, ey);
                if cmd.to_ascii_uppercase() == b'Q' {
                    let v: Option<Vec<f64>> = (0..4).map(|_| number(&mut i)).collect();
                    let Some(v) = v else { break };
                    (qx, qy, ex, ey) = (ox + v[0], oy + v[1], ox + v[2], oy + v[3]);
                } else {
                    let (Some(a), Some(b)) = (number(&mut i), number(&mut i)) else { break };
                    let (px, py) = last_quad.map(|(cx, cy)| (2.0 * x - cx, 2.0 * y - cy)).unwrap_or((x, y));
                    (qx, qy, ex, ey) = (px, py, ox + a, oy + b);
                }
                let c1 = (x + 2.0 / 3.0 * (qx - x), y + 2.0 / 3.0 * (qy - y));
                let c2 = (ex + 2.0 / 3.0 * (qx - ex), ey + 2.0 / 3.0 * (qy - ey));
                out.push(PathCmd::Cubic(c1.0 as f32, c1.1 as f32, c2.0 as f32, c2.1 as f32, ex as f32, ey as f32));
                (x, y) = (ex, ey);
                last_quad = Some((qx, qy));
                last_ctrl = None;
            }
            b'A' => {
                let v: Option<Vec<f64>> = (0..7).map(|_| number(&mut i)).collect();
                let Some(v) = v else { break };
                (x, y) = (ox + v[5], oy + v[6]);
                out.push(PathCmd::Line(x as f32, y as f32));
                last_ctrl = None;
                last_quad = None;
            }
            _ => break,
        }
    }
    out
}
