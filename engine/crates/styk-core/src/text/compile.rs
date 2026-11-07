//! `compileTextFigure` of `src/text-authoring.mjs`: layout of a draft with a parsed font into a figure definition.
//!
//! Every operation is performed in the order, and in the number type, of the JavaScript module: doubles for outlines
//! and layout, rounded to float32 only where `Math.fround` is called. A change here that alters one bit of the output is
//! a behaviour change, caught by the fixtures in `tests/fixtures/text`.

use std::collections::HashMap;

use styk_doc::{format_number, Obj, Value};

use super::font::Font;
use super::options::{f32r, js_round, label, TextOptions, TextSettings};
use super::path::PathCmd;
use super::TextError;

/// One command of a glyph as the figure stores it: `op` and float32 `values`.
#[derive(Debug, Clone, PartialEq)]
pub struct CompiledPath {
    pub op: char,
    pub values: Vec<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Bounds {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}

/// One distinct character of the text.
#[derive(Debug, Clone, PartialEq)]
pub struct Glyph {
    pub utf16_code_unit: u16,
    pub commands: Vec<CompiledPath>,
    pub node_count: usize,
    pub bounds: Option<Bounds>,
    pub svg_path: String,
}

/// `pathCommands(path)`: cubic curves for Pivot's paths, float32 coordinates.
fn path_commands(path: &[PathCmd]) -> Vec<CompiledPath> {
    let (mut x, mut y, mut start_x, mut start_y) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    let mut commands = Vec::with_capacity(path.len());
    for command in path {
        let (op, values): (char, Vec<f64>) = match *command {
            PathCmd::M(cx, cy) => {
                start_x = cx;
                start_y = cy;
                ('M', vec![cx, cy])
            }
            PathCmd::L(cx, cy) => ('L', vec![cx, cy]),
            PathCmd::Q(x1, y1, cx, cy) => (
                'C',
                vec![
                    x + ((x1 - x) * 2.0) / 3.0,
                    y + ((y1 - y) * 2.0) / 3.0,
                    cx + ((x1 - cx) * 2.0) / 3.0,
                    cy + ((y1 - cy) * 2.0) / 3.0,
                    cx,
                    cy,
                ],
            ),
            PathCmd::C(x1, y1, x2, y2, cx, cy) => ('C', vec![x1, y1, x2, y2, cx, cy]),
            PathCmd::Z => {
                x = start_x;
                y = start_y;
                ('Z', Vec::new())
            }
        };
        if !matches!(command, PathCmd::Z) {
            // `x = command.x`: the end point of the command.
            match *command {
                PathCmd::M(cx, cy) | PathCmd::L(cx, cy) | PathCmd::Q(_, _, cx, cy) | PathCmd::C(_, _, _, _, cx, cy) => {
                    x = cx;
                    y = cy;
                }
                PathCmd::Z => {}
            }
        }
        commands.push(CompiledPath { op, values: values.into_iter().map(f32r).collect() });
    }
    commands
}

/// `Math.min`: NaN wins, and -0 is below +0.
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == 0.0 && b == 0.0 {
        if a.is_sign_negative() { a } else { b }
    } else if a < b {
        a
    } else {
        b
    }
}

fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == 0.0 && b == 0.0 {
        if a.is_sign_positive() { a } else { b }
    } else if a > b {
        a
    } else {
        b
    }
}

/// `pathBounds(commands)`: control points included, `None` when the path has no finite extent.
pub fn path_bounds(commands: &[CompiledPath]) -> Option<Bounds> {
    let (mut left, mut top, mut right, mut bottom) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    let (mut x, mut y, mut start_x, mut start_y) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    let mut point = |px: f64, py: f64| {
        left = js_min(left, px);
        right = js_max(right, px);
        top = js_min(top, py);
        bottom = js_max(bottom, py);
    };
    for command in commands {
        match command.op {
            'H' => {
                x = command.values[0];
                point(x, y);
            }
            'V' => {
                y = command.values[0];
                point(x, y);
            }
            'Z' => {
                x = start_x;
                y = start_y;
            }
            op => {
                for pair in command.values.chunks(2) {
                    point(pair[0], pair.get(1).copied().unwrap_or(f64::NAN));
                }
                let n = command.values.len();
                x = command.values[n - 2];
                y = command.values[n - 1];
                if op == 'M' {
                    start_x = x;
                    start_y = y;
                }
            }
        }
    }
    left.is_finite().then_some(Bounds { left, top, right, bottom })
}

/// A number as `String(n)` prints it, `NaN` and the infinities included.
pub(crate) fn js_number_text(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_string();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.to_string();
    }
    let mut out = Vec::new();
    format_number(value, &mut out);
    String::from_utf8(out).expect("number text is ASCII")
}

/// `svgPath(commands, dx, dy)`.
pub fn svg_path(commands: &[CompiledPath], dx: f64, dy: f64) -> String {
    let mut out = String::new();
    for (index, command) in commands.iter().enumerate() {
        if index > 0 {
            out.push(' ');
        }
        out.push(command.op);
        for (i, n) in command.values.iter().enumerate() {
            if i > 0 {
                out.push(' ');
            }
            let offset = if command.op == 'V' || (command.op != 'H' && i % 2 == 1) { dy } else { dx };
            let v = n + offset;
            out.push_str(&if v == 0.0 { "0".to_string() } else { js_number_text(v) });
        }
    }
    out
}

struct Placement {
    character_index: usize,
    unit: u16,
    glyph_index: usize,
    visible: bool,
    x: f64,
    y: f64,
}

/// `textBounds(glyphs, placements)`; the interchange decoder's bounds, float32 and including control points.
pub fn text_bounds(glyphs: &[Glyph], placements: &[(usize, f64, f64)]) -> Result<(Bounds, f64, f64), TextError> {
    let (mut left, mut top, mut right, mut bottom) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for &(glyph_index, x, y) in placements {
        let Some(bounds) = glyphs[glyph_index].bounds else { continue };
        left = js_min(left, f32r(bounds.left + x));
        right = js_max(right, f32r(bounds.right + x));
        top = js_min(top, f32r(bounds.top + y));
        bottom = js_max(bottom, f32r(bounds.bottom + y));
    }
    if !left.is_finite() || right <= left || bottom <= top {
        return Err(TextError::key("errors.textAuthoring.textHasNoVisibleGlyphOutlines"));
    }
    Ok((Bounds { left, top, right, bottom }, f32r(right - left), f32r(bottom - top)))
}

pub(crate) fn num(v: f64) -> Value {
    Value::Num(v)
}

pub(crate) fn nums(values: &[f64]) -> Value {
    Value::array(values.iter().map(|&v| Value::Num(v)).collect())
}

fn command_value(c: &CompiledPath) -> Value {
    let mut o = Obj::new();
    o.set("op", Value::str(&c.op.to_string()));
    o.set("values", nums(&c.values));
    Value::object(o)
}

pub(crate) fn bounds_value(bounds: Option<Bounds>) -> Value {
    match bounds {
        None => Value::Null,
        Some(b) => {
            let mut o = Obj::new();
            o.set("left", num(b.left));
            o.set("top", num(b.top));
            o.set("right", num(b.right));
            o.set("bottom", num(b.bottom));
            Value::object(o)
        }
    }
}

pub(crate) fn glyph_value(g: &Glyph) -> Value {
    let mut o = Obj::new();
    o.set("utf16_code_unit", num(g.utf16_code_unit as f64));
    o.set("commands", Value::array(g.commands.iter().map(command_value).collect()));
    o.set("node_count", num(g.node_count as f64));
    o.set("bounds", bounds_value(g.bounds));
    o.set("svg_path", Value::str(&g.svg_path));
    Value::object(o)
}

pub(crate) fn alignment_code(alignment: &str) -> f64 {
    match alignment {
        "right" => 2.0,
        "center" => 0.0,
        _ => 1.0,
    }
}

/// `Math.max(...widths)`.
fn max_width(widths: &[f64]) -> f64 {
    widths.iter().fold(f64::NEG_INFINITY, |a, &b| js_max(a, b))
}

/// `font_style` of a text asset: bit 0 bold, bit 1 italic.
pub(crate) fn font_style(bold: bool, italic: bool) -> f64 {
    (bold as u8 | ((italic as u8) << 1)) as f64
}

/// The figure around a text asset, shared with the editing of imported text (`segments`, `segment_decode` and the
/// metadata block are built once, here).
pub(crate) fn figure_value(o: &TextSettings, family: &str, asset: Value, bounds_width: f64, extra: Vec<(&'static str, Value)>) -> Value {
    let transparency = js_round((1.0 - o.opacity) * 255.0);
    let mut segment = Obj::new();
    segment.set("segment_id", num(1.0));
    segment.set("parent_id", num(0.0));
    segment.set("length", num(bounds_width));
    segment.set("angle_rad", num(0.0));
    segment.set("thickness", num(0.0));
    segment.set("bend_rad", num(0.0));
    segment.set("primitive_code", num(5.0));
    segment.set("aux_code", num(0.0));
    segment.set("flags", num(2.0));
    segment.set("segment_type", Value::str("text"));
    segment.set("segment_kind", Value::str("text"));
    if let Some(paint) = &o.paint {
        segment.set("paint", paint.clone());
    }
    segment.set("color_rgb", nums(&o.color));
    segment.set("transparency", num(transparency));
    segment.set(
        "secondary",
        match o.gradient_color {
            Some(rgb) => {
                let mut s = Obj::new();
                s.set("rgb", nums(&rgb));
                let alpha = match &o.paint {
                    Some(paint) => {
                        let stops = paint.get("stops").and_then(Value::elements).expect("normalized paint has stops");
                        let last = stops.get(stops.len() - 1).expect("at least one stop");
                        let opacity = last.get("opacity").and_then(Value::as_f64).expect("normalized stop opacity");
                        js_round((1.0 - opacity) * 255.0)
                    }
                    None => transparency,
                };
                s.set("a", num(alpha));
                Value::object(s)
            }
            None => Value::Null,
        },
    );
    segment.set("extra_u16", num(0.0));
    segment.set("extra_u8_a", num(0.0));
    segment.set("extra_u8_b", num(0.0));
    segment.set("extra", nums(&[0.0, 0.0, 0.0]));
    segment.set("visible", Value::Bool(true));
    segment.set("z_order", num(1.0));

    let mut style = Obj::new();
    style.set("u28", num((o.outline_width as f32).to_bits() as f64));
    style.set("outline_thickness", num(f32r(o.outline_width)));
    style.set("rgb", nums(&o.outline_color));
    style.set("u30", num(0.0));
    style.set("outline_transparency", num(0.0));
    let mut decode = Obj::new();
    decode.set("global_style", Value::object(style));

    let mut authoring = Obj::new();
    authoring.set("version", num(1.0));
    let settings = o.to_object();
    for (key, value) in settings.iter() {
        authoring.set(key, value.clone());
    }
    authoring.set("fontFamily", Value::str(family));
    for (key, value) in extra {
        authoring.set(key, value);
    }
    let mut styk = Obj::new();
    styk.set("sourceName", Value::str(&o.name));
    styk.set("textAuthoring", Value::object(authoring));

    let mut figure = Obj::new();
    figure.set("figure_type_id", num(o.figure_type_id));
    figure.set("name", Value::str(&label(&o.name)));
    figure.set("segment_count", num(1.0));
    figure.set("segments", Value::array(vec![Value::object(segment)]));
    figure.set("segment_decode", Value::object(decode));
    figure.set("polyfills", Value::array(Vec::new()));
    figure.set("image_assets", Value::array(Vec::new()));
    figure.set("text_assets", Value::array(vec![asset]));
    figure.set("_styk", Value::object(styk));
    Value::object(figure)
}

/// `compileTextFigure(options, font)`: a complete figure definition ready for `importFigure`.
pub fn compile_text_figure(options: &TextOptions, font: &Font) -> Result<Value, TextError> {
    compile_text_figure_checked(options, font, &|| false)
}

/// [`compile_text_figure`] that ends with [`TextError::Cancelled`] when `cancelled` answers true. It is asked once the draft's
/// glyphs have been read and then before each line, never in the middle of reading glyphs: the JavaScript worker cannot be
/// interrupted, so a draft it started always read all of its glyphs, and for a CFF font that reading is state (a glyph's
/// advance becomes the one its charstring declares) which the next draft's layout sees. Reading glyphs is bounded (255
/// distinct units, and composite resolution has a work limit), so cancellation still takes effect promptly.
pub fn compile_text_figure_checked(options: &TextOptions, font: &Font, cancelled: &dyn Fn() -> bool) -> Result<Value, TextError> {
    let o = TextSettings::validate(options, true)?;
    if font.units_per_em == 0 {
        return Err(TextError::key("errors.textAuthoring.aParsedOutlineFontIsRequired"));
    }
    let family = o.font_family.clone().unwrap_or_else(|| font.family());
    let units_per_em = font.units_per_em as f64;
    let scale = o.font_size / units_per_em;
    let text: Vec<u16> = o.text.encode_utf16().collect();

    let mut glyphs: Vec<Glyph> = Vec::new();
    let mut by_unit: HashMap<u16, usize> = HashMap::new();
    // `fontGlyphs`: unit → glyph index of the font (`None` for a tab or a line break), in order of first use.
    let mut font_glyphs: Vec<(u16, Option<usize>)> = Vec::new();
    for &unit in &text {
        if by_unit.contains_key(&unit) {
            continue;
        }
        let invisible = unit == b'\n' as u16 || unit == b'\t' as u16;
        let source = if invisible { None } else { Some(font.glyph_index(unit)?) };
        if source == Some(0) {
            let character = String::from_utf16_lossy(&[unit]);
            return Err(TextError::with(
                "errors.textAuthoring.doesNotContainU",
                vec![
                    ("family", Value::str(&family)),
                    ("char", Value::str(&character)),
                    ("value", Value::str(&format!("{:04X}", unit))),
                ],
            ));
        }
        let commands = match source {
            Some(gid) => path_commands(&font.scaled_path(gid, o.font_size)?),
            None => Vec::new(),
        };
        by_unit.insert(unit, glyphs.len());
        font_glyphs.push((unit, source));
        let node_count = commands.iter().map(|c| if c.op == 'C' { 3 } else { 1 }).sum();
        glyphs.push(Glyph {
            utf16_code_unit: unit,
            bounds: path_bounds(&commands),
            svg_path: svg_path(&commands, 0.0, 0.0),
            commands,
            node_count,
        });
    }
    if cancelled() {
        return Err(TextError::Cancelled);
    }
    let source_of = |unit: u16| -> Option<Option<usize>> { font_glyphs.iter().find(|(u, _)| *u == unit).map(|(_, g)| *g) };

    let space_gid = font.glyph_index(b' ' as u16)?;
    let space_width = font.advance_width(space_gid).filter(|w| *w != 0.0 && !w.is_nan()).unwrap_or(units_per_em / 4.0);
    let space_advance = space_width * scale;
    let advance_of = |gid: Option<usize>| -> f64 {
        gid.and_then(|g| font.advance_width(g)).filter(|w| *w != 0.0 && !w.is_nan()).unwrap_or(0.0)
    };

    struct Line {
        units: Vec<u16>,
        offsets: Vec<f64>,
        width: f64,
    }
    let mut lines: Vec<Line> = Vec::new();
    for units in text.split(|&u| u == b'\n' as u16) {
        if cancelled() {
            return Err(TextError::Cancelled);
        }
        let mut width = 0.0f64;
        let mut offsets = Vec::with_capacity(units.len());
        for i in 0..units.len() {
            offsets.push(width);
            let current = source_of(units[i]).flatten();
            let next = units.get(i + 1).and_then(|&u| source_of(u)).flatten();
            width += if units[i] == b'\t' as u16 { space_advance * 4.0 } else { advance_of(current) * scale };
            if let (Some(left), Some(right)) = (current, next) {
                width += font.kerning(left, right)? * scale;
            }
        }
        lines.push(Line { units: units.to_vec(), offsets, width });
    }
    let layout_width = max_width(&lines.iter().map(|l| l.width).collect::<Vec<_>>());

    let mut placements: Vec<Placement> = Vec::new();
    let place = |unit: u16, x: f64, y: f64, placements: &mut Vec<Placement>| {
        let glyph_index = by_unit[&unit];
        let visible = !glyphs[glyph_index].commands.is_empty();
        placements.push(Placement {
            character_index: placements.len(),
            unit,
            glyph_index,
            visible,
            x: if visible { f32r(x) } else { 0.0 },
            y: if visible { f32r(y) } else { 0.0 },
        });
    };
    let last_row = lines.len() - 1;
    for (row, line) in lines.iter().enumerate() {
        let dx = match o.alignment.as_str() {
            "right" => layout_width - line.width,
            "center" => (layout_width - line.width) / 2.0,
            _ => 0.0,
        };
        for i in 0..line.units.len() {
            place(line.units[i], line.offsets[i] + dx, row as f64 * o.font_size * o.line_height, &mut placements);
        }
        if row < last_row {
            place(10, 0.0, 0.0, &mut placements);
        }
    }

    let (bounds, width, height) =
        text_bounds(&glyphs, &placements.iter().map(|p| (p.glyph_index, p.x, p.y)).collect::<Vec<_>>())?;
    let svg = placements
        .iter()
        .filter(|p| p.visible)
        .map(|p| svg_path(&glyphs[p.glyph_index].commands, p.x, p.y))
        .collect::<Vec<_>>()
        .join(" ");
    let normalized_svg = placements
        .iter()
        .filter(|p| p.visible)
        .map(|p| svg_path(&glyphs[p.glyph_index].commands, p.x - bounds.left, p.y - bounds.bottom))
        .collect::<Vec<_>>()
        .join(" ");

    let mut asset = Obj::new();
    asset.set("kind", Value::str("text"));
    asset.set("asset_index", num(0.0));
    asset.set("table_index", num(0.0));
    asset.set("font_name", Value::str(&family));
    asset.set("font_style", num(font_style(o.bold, o.italic)));
    asset.set("bold", Value::Bool(o.bold));
    asset.set("italic", Value::Bool(o.italic));
    asset.set("underline", Value::Bool(false));
    asset.set("strikeout", Value::Bool(false));
    asset.set("alignment", num(alignment_code(&o.alignment)));
    asset.set("text", Value::str(&o.text));
    asset.set("font_size", num(o.font_size));
    asset.set("glyphs", Value::array(glyphs.iter().map(glyph_value).collect()));
    asset.set("placements", Value::array(placements.iter().map(placement_value).collect()));
    let mut bounds_object = Obj::new();
    bounds_object.set("left", num(bounds.left));
    bounds_object.set("top", num(bounds.top));
    bounds_object.set("right", num(bounds.right));
    bounds_object.set("bottom", num(bounds.bottom));
    bounds_object.set("width", num(width));
    bounds_object.set("height", num(height));
    asset.set("bounds", Value::object(bounds_object));
    asset.set("normalized_origin", Value::str("lower_left"));
    asset.set("svg_path", Value::str(&svg));
    asset.set("normalized_svg_path", Value::str(&normalized_svg));

    let mut advances = Obj::new();
    for &(unit, source) in &font_glyphs {
        let advance = match source {
            Some(gid) => advance_of(Some(gid)) * scale,
            None if unit == 9 => space_advance * 4.0,
            None => 0.0,
        };
        advances.set(&unit.to_string(), num(advance));
    }
    Ok(figure_value(
        &o,
        &family,
        Value::object(asset),
        width,
        vec![("glyphAdvances", Value::object(advances)), ("spaceAdvance", num(space_advance))],
    ))
}

fn placement_value(p: &Placement) -> Value {
    let mut o = Obj::new();
    o.set("character_index", num(p.character_index as f64));
    o.set("utf16_code_unit", num(p.unit as f64));
    o.set("glyph_index", num(p.glyph_index as f64));
    o.set("visible", Value::Bool(p.visible));
    o.set("x", num(p.x));
    o.set("y", num(p.y));
    Value::object(o)
}

