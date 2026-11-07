//! TrueType (`glyf`) outlines, a line-for-line port of opentype.js's `parseGlyph`, `buildPath` and `getPath`.
//!
//! The arithmetic is in doubles in opentype.js's order (`transformPoints`, the midpoint of two off-curve points as
//! `(a + b) * 0.5`); skrifa scales in single precision and resolves composites differently, so it cannot give the same bits.

use std::collections::HashMap;
use std::rc::Rc;

use super::path::PathCmd;
use super::reader::{Data, Parser, R};
use super::FontError;

#[derive(Clone, Copy, Debug)]
pub(crate) struct Point {
    pub x: f64,
    pub y: f64,
    pub on_curve: bool,
    pub last_of_contour: bool,
}

/// Nesting deeper than this is a loop in the font: opentype.js overflows its stack on one.
const MAX_COMPOSITE_DEPTH: usize = 256;

pub(crate) struct Glyf {
    /// Offset of the `glyf` table.
    pub start: i64,
    /// `numGlyphs + 1` byte offsets into `glyf`.
    pub loca: Vec<u32>,
}

impl Glyf {
    pub fn glyph_count(&self) -> usize {
        self.loca.len().saturating_sub(1)
    }

    /// The outline of one glyph in font units, as `Glyph.path.commands`.
    pub fn path(&self, data: Data, gid: usize) -> R<Vec<PathCmd>> {
        let mut resolver = Resolver { glyf: self, data, memo: HashMap::new(), moved: 0 };
        match resolver.points(gid, 0)? {
            Some(points) => contour_path(&points),
            None => Ok(Vec::new()),
        }
    }
}

/// Points one outline may copy while its composites are resolved. Real glyphs have hundreds; a stack of composites that
/// doubles its points at every level would otherwise exhaust memory.
const MAX_POINTS_MOVED: usize = 4_000_000;

/// Resolves composites the way opentype.js does: each glyph once (it keeps the resolved points on the glyph), so a glyph
/// that many composites share costs once, not once per reference. The memo lives for one outline.
struct Resolver<'a> {
    glyf: &'a Glyf,
    data: Data<'a>,
    memo: HashMap<usize, Option<Rc<Vec<Point>>>>,
    moved: usize,
}

impl Resolver<'_> {
    fn spend(&mut self, points: usize) -> R<()> {
        self.moved = self.moved.saturating_add(points);
        if self.moved > MAX_POINTS_MOVED {
            return Err(FontError::Invalid("composite glyphs are too complex"));
        }
        Ok(())
    }

    /// `glyph.points` after `getPath()`; `None` for a glyph with no data (opentype.js leaves `points` undefined).
    fn points(&mut self, gid: usize, depth: usize) -> R<Option<Rc<Vec<Point>>>> {
        if let Some(done) = self.memo.get(&gid) {
            return Ok(done.clone());
        }
        if depth > MAX_COMPOSITE_DEPTH {
            return Err(FontError::Invalid("composite glyphs nest too deeply"));
        }
        let resolved = self.resolve(gid, depth)?.map(Rc::new);
        self.memo.insert(gid, resolved.clone());
        Ok(resolved)
    }

    fn resolve(&mut self, gid: usize, depth: usize) -> R<Option<Vec<Point>>> {
        let (offset, next) = match (self.glyf.loca.get(gid), self.glyf.loca.get(gid + 1)) {
            (Some(&a), Some(&b)) => (a, b),
            _ => return Err(FontError::GlyphOutOfRange(gid)),
        };
        if offset == next {
            return Ok(None);
        }
        let mut p = Parser::new(self.data, self.glyf.start + offset as i64);
        let contours = p.i16()?;
        p.skip(8); // xMin, yMin, xMax, yMax
        if contours > 0 {
            let points = simple_points(&mut p, contours as usize)?;
            self.spend(points.len())?;
            return Ok(Some(points));
        }
        if contours == 0 {
            return Ok(Some(Vec::new()));
        }
        let mut points: Vec<Point> = Vec::new();
        let mut flags;
        loop {
            flags = p.u16()?;
            let glyph_index = p.u16()? as usize;
            let (mut dx, mut dy) = (0.0f64, 0.0f64);
            let mut matched: Option<(usize, usize)> = None;
            if flags & 1 > 0 {
                if flags & 2 > 0 {
                    dx = p.i16()? as f64;
                    dy = p.i16()? as f64;
                } else {
                    matched = Some((p.u16()? as usize, p.u16()? as usize));
                }
            } else if flags & 2 > 0 {
                dx = p.i8()? as f64;
                dy = p.i8()? as f64;
            } else {
                matched = Some((p.u8()? as usize, p.u8()? as usize));
            }
            let (mut x_scale, mut scale01, mut scale10, mut y_scale) = (1.0f64, 0.0f64, 0.0f64, 1.0f64);
            if flags & 8 > 0 {
                x_scale = p.f2dot14()?;
                y_scale = x_scale;
            } else if flags & 64 > 0 {
                x_scale = p.f2dot14()?;
                y_scale = p.f2dot14()?;
            } else if flags & 128 > 0 {
                x_scale = p.f2dot14()?;
                scale01 = p.f2dot14()?;
                scale10 = p.f2dot14()?;
                y_scale = p.f2dot14()?;
            }
            self.spend(1)?;
            if let Some(component) = self.points(glyph_index, depth + 1)? {
                let transform = Transform { x_scale, scale01, scale10, y_scale, dx, dy };
                self.spend(component.len())?;
                let transformed = match matched {
                    None => transform_points(&component, &transform),
                    Some((first, second)) => {
                        if first + 1 > points.len() || second + 1 > component.len() {
                            return Err(FontError::Invalid("matched points out of range"));
                        }
                        let first_pt = points[first];
                        let second_pt = component[second];
                        let mut t = Transform { dx: 0.0, dy: 0.0, ..transform };
                        let moved = transform_points(&[second_pt], &t)[0];
                        t.dx = first_pt.x - moved.x;
                        t.dy = first_pt.y - moved.y;
                        transform_points(&component, &t)
                    }
                };
                points.extend(transformed);
            }
            if flags & 32 == 0 {
                break;
            }
        }
        if flags & 0x100 != 0 {
            let length = p.u16()? as usize;
            self.data.slice(p.at(), length)?;
        }
        Ok(Some(points))
    }
}

struct Transform {
    x_scale: f64,
    scale01: f64,
    scale10: f64,
    y_scale: f64,
    dx: f64,
    dy: f64,
}

fn transform_points(points: &[Point], t: &Transform) -> Vec<Point> {
    points
        .iter()
        .map(|pt| Point {
            x: t.x_scale * pt.x + t.scale01 * pt.y + t.dx,
            y: t.scale10 * pt.x + t.y_scale * pt.y + t.dy,
            on_curve: pt.on_curve,
            last_of_contour: pt.last_of_contour,
        })
        .collect()
}

fn coordinate(p: &mut Parser, flag: u8, previous: f64, short_bit: u8, same_bit: u8) -> R<f64> {
    Ok(if flag & short_bit > 0 {
        let mut v = p.u8()? as f64;
        if flag & same_bit == 0 {
            v = -v;
        }
        previous + v
    } else if flag & same_bit > 0 {
        previous
    } else {
        previous + p.i16()? as f64
    })
}

fn simple_points(p: &mut Parser, contours: usize) -> R<Vec<Point>> {
    let mut ends = Vec::with_capacity(contours);
    for _ in 0..contours {
        ends.push(p.u16()? as usize);
    }
    let instruction_length = p.u16()? as usize;
    p.data.slice(p.at(), instruction_length)?;
    p.skip(instruction_length as i64);
    let count = ends[ends.len() - 1] + 1;
    let mut flags: Vec<u8> = Vec::with_capacity(count);
    let mut i = 0;
    while i < count {
        let flag = p.u8()?;
        flags.push(flag);
        if flag & 8 > 0 {
            let repeat = p.u8()?;
            for _ in 0..repeat {
                flags.push(flag);
                i += 1;
            }
        }
        i += 1;
    }
    if flags.len() != count {
        return Err(FontError::Invalid("bad glyph flags"));
    }
    let mut points: Vec<Point> = flags
        .iter()
        .enumerate()
        .map(|(i, &flag)| Point { x: 0.0, y: 0.0, on_curve: flag & 1 != 0, last_of_contour: ends.contains(&i) })
        .collect();
    let mut px = 0.0;
    for (i, point) in points.iter_mut().enumerate() {
        point.x = coordinate(p, flags[i], px, 2, 16)?;
        px = point.x;
    }
    let mut py = 0.0;
    for (i, point) in points.iter_mut().enumerate() {
        point.y = coordinate(p, flags[i], py, 4, 32)?;
        py = point.y;
    }
    Ok(points)
}

/// `glyf.getPath(points)`.
fn contour_path(points: &[Point]) -> R<Vec<PathCmd>> {
    let mut contours: Vec<&[Point]> = Vec::new();
    let mut from = 0;
    for (i, pt) in points.iter().enumerate() {
        if pt.last_of_contour {
            contours.push(&points[from..=i]);
            from = i + 1;
        }
    }
    if from != points.len() {
        return Err(FontError::Invalid("points left over after the last contour"));
    }
    let mut out = Vec::new();
    for contour in contours {
        let mut curr = contour[contour.len() - 1];
        let mut next = contour[0];
        if curr.on_curve {
            out.push(PathCmd::M(curr.x, curr.y));
        } else if next.on_curve {
            out.push(PathCmd::M(next.x, next.y));
        } else {
            out.push(PathCmd::M((curr.x + next.x) * 0.5, (curr.y + next.y) * 0.5));
        }
        for i in 0..contour.len() {
            curr = next;
            next = contour[(i + 1) % contour.len()];
            if curr.on_curve {
                out.push(PathCmd::L(curr.x, curr.y));
            } else {
                let end = if next.on_curve { (next.x, next.y) } else { ((curr.x + next.x) * 0.5, (curr.y + next.y) * 0.5) };
                out.push(PathCmd::Q(curr.x, curr.y, end.0, end.1));
            }
        }
        out.push(PathCmd::Z);
    }
    Ok(out)
}
