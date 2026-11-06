//! Per-instance style overlays (`_stykStyle`, `resolveInstanceFigure` in
//! src/animation-style.mjs). Resolved once at load per (figure, style) pair;
//! the shared definition is copied only for figures that are actually restyled.

use std::collections::HashMap;
use std::sync::Arc;

use styk_doc::Value;

use crate::doc::{Figure, Outline, Paint, PaintKind};

#[derive(Clone, Debug, Default)]
pub struct SegmentStyle {
    pub z: Option<f64>,
    pub paint: Option<Arc<Paint>>,
    pub color: Option<u32>,
    pub thickness: Option<f64>,
    pub gradient_color: Option<u32>,
    pub opacity: Option<f64>,
    pub gradient_opacity: Option<f64>,
}

#[derive(Clone, Debug, Default)]
pub struct PolygonStyle {
    pub color: Option<u32>,
    pub z: Option<f64>,
    pub opacity: Option<f64>,
}

#[derive(Clone, Debug, Default)]
pub struct ObjectStyle {
    pub outline_opacity: Option<f64>,
    pub outline_color: Option<u32>,
    pub outline_width: Option<f64>,
    pub segments: HashMap<u32, SegmentStyle>,
    pub polygons: HashMap<u32, PolygonStyle>,
    /// `meshColors`: palette index → RGB integer replacing a mesh colour.
    pub mesh_colors: Vec<(u32, u32)>,
    pub segment_colors: bool,
    /// Canonical text of the overlay, used to share resolved figures.
    pub key: String,
}

/// Covered flat style buffers/paints. Map table allocations are deliberately
/// uncovered: std HashMap's private bucket/control layout is not inferred.
pub(crate) fn observe_allocations(
    visitor: &mut crate::eval::retained::Visitor<'_>,
    style: &Arc<ObjectStyle>,
) -> Result<(), crate::eval::retained::Reason> {
    visitor.check()?;
    if visitor.allocations.arc(style)? {
        visitor.allocations.text(&style.key)?;
        visitor.allocations.buffer(&style.mesh_colors)?;
        if style.segments.capacity() != 0 || style.polygons.capacity() != 0 {
            visitor
                .uncovered
                .add(crate::eval::retained::Uncovered::MAP_TABLES);
        }
        for segment in style.segments.values() {
            visitor.check()?;
            if let Some(paint) = &segment.paint {
                visitor.allocations.resolved.paint(paint);
            }
        }
    }
    Ok(())
}

fn rgb_of(c: u32) -> [u8; 3] {
    [(c >> 16 & 255) as u8, (c >> 8 & 255) as u8, (c & 255) as u8]
}

fn alpha_byte(opacity: f64) -> f64 {
    ((1.0 - opacity) * 255.0).round()
}

pub fn parse(style: Option<&Value>, color_mode: Option<&Value>) -> Option<Arc<ObjectStyle>> {
    let segment_colors = color_mode.and_then(Value::as_str) == Some("segments");
    if style.is_none() && !segment_colors {
        return None;
    }
    let s = style.cloned().unwrap_or(Value::Null);
    let f = |v: &Value, k: &str| v.get(k).and_then(Value::as_f64);
    let mut out = ObjectStyle {
        outline_opacity: f(&s, "outlineOpacity"),
        outline_color: f(&s, "outlineColor").map(|v| v as u32),
        outline_width: f(&s, "outlineWidth"),
        segment_colors,
        key: format!("{}|{segment_colors}", s),
        ..Default::default()
    };
    if let Some(Value::Obj(map)) = s.get("segments") {
        for (id, v) in map.iter() {
            let Ok(id) = id.parse::<u32>() else { continue };
            out.segments.insert(
                id,
                SegmentStyle {
                    z: f(v, "zIndex"),
                    paint: crate::load::paint(v.get("paint")),
                    color: f(v, "color").map(|c| c as u32),
                    thickness: f(v, "thickness"),
                    gradient_color: f(v, "gradientColor").map(|c| c as u32),
                    opacity: f(v, "opacity"),
                    gradient_opacity: f(v, "gradientOpacity"),
                },
            );
        }
    }
    if let Some(Value::Obj(map)) = s.get("polygons") {
        for (id, v) in map.iter() {
            let Ok(id) = id.parse::<u32>() else { continue };
            out.polygons.insert(id, PolygonStyle { color: f(v, "color").map(|c| c as u32), z: f(v, "zIndex"), opacity: f(v, "opacity") });
        }
    }
    if let Some(Value::Obj(map)) = s.get("meshColors") {
        out.mesh_colors = map.iter().filter_map(|(index, v)| Some((index.parse::<u32>().ok()?, v.as_f64()? as u32))).collect();
    }
    Some(Arc::new(out))
}

/// `resolveInstanceFigure`.
pub fn resolve(figure: &Figure, style: &ObjectStyle) -> Figure {
    let mut out = figure.clone();
    if style.segment_colors {
        out.segment_colors = true;
    }
    if style.outline_opacity.is_some() || style.outline_color.is_some() || style.outline_width.is_some() {
        let base = figure.outline.clone().unwrap_or(Outline { width: 0.0, rgb: [0, 0, 0], alpha: 1.0 });
        let width = style.outline_width.map(|w| w as f32 as f64).unwrap_or(base.width);
        let rgb = style.outline_color.map(rgb_of).unwrap_or(base.rgb);
        let alpha = style.outline_opacity.map(|o| 1.0 - alpha_byte(o) / 255.0).unwrap_or(base.alpha);
        out.outline = (width > 0.0 && width.is_finite()).then_some(Outline { width, rgb, alpha });
    }
    for seg in out.segments.iter_mut() {
        let Some(o) = style.segments.get(&seg.id) else { continue };
        if let Some(z) = o.z {
            seg.z = z;
        }
        if let Some(p) = &o.paint {
            let first = p.stops[0];
            let last = *p.stops.last().unwrap();
            seg.paint = Some(p.clone());
            seg.rgb = first.rgb;
            seg.alpha = 1.0 - alpha_byte(first.opacity) / 255.0;
            seg.secondary = if p.kind == PaintKind::Solid { None } else { Some((last.rgb, alpha_byte(last.opacity) as u8)) };
        }
        if let Some(c) = o.color {
            seg.rgb = rgb_of(c);
        }
        if let Some(t) = o.thickness {
            seg.thickness = t;
            seg.visible = t > 0.01 || seg.prim as u8 > 0;
        }
        if let (Some(c), Some(sec)) = (o.gradient_color, seg.secondary.as_mut()) {
            sec.0 = rgb_of(c);
        }
        if let Some(op) = o.opacity {
            seg.alpha = 1.0 - alpha_byte(op) / 255.0;
        }
        if let (Some(op), Some(sec)) = (o.gradient_opacity, seg.secondary.as_mut()) {
            sec.1 = alpha_byte(op) as u8;
        }
    }
    // `meshPaletteColor`: the instance recolours palette entries; the mesh itself stays shared.
    if !style.mesh_colors.is_empty() && !out.mesh_colors.is_empty() {
        let mut palette = out.mesh_colors.to_vec();
        for &(index, color) in &style.mesh_colors {
            if let Some(entry) = palette.get_mut(index as usize) {
                *entry = rgb_of(color);
            }
        }
        out.mesh_colors = palette.into();
    }
    for poly in out.polyfills.iter_mut() {
        let Some(o) = style.polygons.get(&poly.id) else { continue };
        if let Some(c) = o.color {
            poly.rgb = rgb_of(c);
        }
        if let Some(z) = o.z {
            poly.z = z;
        }
        if let Some(op) = o.opacity {
            poly.alpha = 1.0 - alpha_byte(op) / 255.0;
        }
    }
    out
}
