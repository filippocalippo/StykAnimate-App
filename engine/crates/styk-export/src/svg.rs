//! A frame as SVG: the draw list of an export frame, written as editable vector artwork.
//!
//! The engine evaluates a frame once, into the draw list every renderer draws; an SVG is
//! another reader of it. Strokes, circles, polygons and text (as the triangles it is drawn
//! with, merged into one path per run so no seam shows), gradient fills and sprites become
//! SVG elements in painter order, inside one group that carries the scene camera, so the
//! file shows the picture the export would draw. Groups that are drawn translucent become
//! groups with an opacity. Sprites are embedded once and used wherever they appear.
//!
//! What has no vector form is exported as one picture of the whole frame instead
//! ([`picture`], drawn by the CPU rasterizer): filters and generated effects, 3D faces,
//! drawing cels, conic and diamond gradients, and the frames the document's effects policy
//! composites ([`DrawList::composited_export`]). [`vector`] returns `None` for those.

use std::collections::HashMap;
use std::fmt::Write;

use base64::Engine as _;
use styk_draw::*;
use styk_eval::assets::Assets;
use styk_eval::doc::{Camera, Document};
use styk_eval::view::{background_bounds, camera_matrix};

/// A number as short as SVG needs it: up to six decimals, no trailing zeros.
fn num(v: f64) -> String {
    let text = format!("{v:.6}");
    let text = text.trim_end_matches('0').trim_end_matches('.');
    if text == "-0" || text.is_empty() { "0".into() } else { text.into() }
}

fn hex(rgb: [u8; 3]) -> String {
    format!("#{:02x}{:02x}{:02x}", rgb[0], rgb[1], rgb[2])
}

/// The straight RGB and alpha (0 to 1) of an RGBA8 colour.
fn unpack(color: u32) -> ([u8; 3], f64) {
    ([color as u8, (color >> 8) as u8, (color >> 16) as u8], (color >> 24) as f64 / 255.0)
}

fn float_rgb(c: [f32; 4]) -> [u8; 3] {
    [0, 1, 2].map(|k| (c[k].clamp(0.0, 1.0) * 255.0).round() as u8)
}

/// Escapes text for an XML attribute or element.
fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// What an SVG of a frame needs to know.
pub struct Frame<'a> {
    pub doc: &'a Document,
    pub assets: &'a Assets,
    pub list: &'a DrawList,
    /// The frame's scene camera (seen through, as the export view does).
    pub camera: Option<&'a Camera>,
    /// The output size, in SVG user units of the file's `width` and `height`.
    pub size: [u32; 2],
    pub title: &'a str,
}

/// The frame as vector SVG, or `None` when part of it has no vector form and the frame
/// should be exported as [`picture`].
pub fn vector(frame: &Frame<'_>) -> Option<String> {
    if frame.list.composited_export || frame.list.layers.iter().any(needs_raster) {
        return None;
    }
    Writer::new(frame).write()
}

/// Whether a group's own raster stands for artwork that has no vector form.
fn needs_raster(layer: &EffectLayer) -> bool {
    layer.effects.is_some() || !matches!(layer.kind, LayerKind::Raster { .. })
}

/// A paint record as an SVG gradient, or `None` (conic and diamond gradients).
fn gradient(paints: &[[f32; 4]], offset: u32, id: &str) -> Option<String> {
    let row = |i: u32| paints.get(i as usize).copied();
    let head = row(offset)?;
    let g = row(offset + 1)?;
    let (kind, count) = (head[0], head[1] as u32);
    let mut stops = String::new();
    for i in 0..count {
        let at = offset + 3 + i * 2;
        let (position, color) = (row(at)?[0], row(at + 1)?);
        let _ = write!(stops, "<stop offset=\"{}\" stop-color=\"{}\"", num(position as f64), hex(float_rgb(color)));
        if color[3] < 1.0 {
            let _ = write!(stops, " stop-opacity=\"{}\"", num(color[3].clamp(0.0, 1.0) as f64));
        }
        stops.push_str("/>");
    }
    let f = |k: usize| num(g[k] as f64);
    if kind == P_LINEAR {
        Some(format!("<linearGradient id=\"{id}\" gradientUnits=\"userSpaceOnUse\" x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\">{stops}</linearGradient>", f(0), f(1), f(2), f(3)))
    } else if kind == P_RADIAL {
        Some(format!("<radialGradient id=\"{id}\" gradientUnits=\"userSpaceOnUse\" cx=\"{}\" cy=\"{}\" r=\"{}\">{stops}</radialGradient>", f(0), f(1), f(2)))
    } else if kind == P_RADIAL_RING {
        Some(format!("<radialGradient id=\"{id}\" gradientUnits=\"userSpaceOnUse\" cx=\"{}\" cy=\"{}\" fx=\"{}\" fy=\"{}\" fr=\"{}\" r=\"{}\">{stops}</radialGradient>", f(0), f(1), f(0), f(1), f(2), f(3)))
    } else {
        None
    }
}

/// How a sprite is embedded: its source picture (kept as it is where it is a PNG, JPEG or
/// GIF without a colour key), as a data URL, and its size in pixels.
struct Sprite {
    href: String,
    size: [u32; 2],
}

fn sprite(doc: &Document, assets: &Assets, index: usize) -> Option<Sprite> {
    let data = doc.images.get(index)?;
    let entry = assets.atlas.get(index).filter(|entry| entry.valid)?;
    let bytes = &data.bytes;
    let mime = match bytes.as_ref() {
        [0x89, b'P', b'N', b'G', ..] => Some("image/png"),
        [0xff, 0xd8, 0xff, ..] => Some("image/jpeg"),
        [b'G', b'I', b'F', b'8', ..] => Some("image/gif"),
        _ => None,
    };
    let base64 = base64::engine::general_purpose::STANDARD;
    let href = match (mime, data.color_key) {
        (Some(mime), None) => format!("data:{mime};base64,{}", base64.encode(bytes.as_ref())),
        _ => {
            // A keyed colour becomes transparent, and other formats are written as PNG.
            let mut rgba = image::load_from_memory(bytes).ok()?.to_rgba8();
            if let Some(key) = data.color_key {
                for pixel in rgba.pixels_mut() {
                    if pixel.0[..3] == key {
                        pixel[3] = 0;
                    }
                }
            }
            format!("data:image/png;base64,{}", base64.encode(png(rgba.as_raw(), rgba.width(), rgba.height())?))
        }
    };
    Some(Sprite { href, size: [entry.source_w, entry.source_h] })
}

/// RGBA pixels as a PNG.
fn png(rgba: &[u8], width: u32, height: u32) -> Option<Vec<u8>> {
    use image::ImageEncoder;
    let mut out = Vec::new();
    image::codecs::png::PngEncoder::new(&mut out).write_image(rgba, width, height, image::ExtendedColorType::Rgba8).ok()?;
    Some(out)
}

/// The frame as an SVG holding one picture: `rgba` (straight, `size` pixels) embedded.
pub fn picture(size: [u32; 2], title: &str, rgba: &[u8]) -> Result<String, String> {
    let bytes = png(rgba, size[0], size[1]).ok_or("the frame could not be encoded as a PNG")?;
    let href = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{w}\" height=\"{h}\" viewBox=\"0 0 {w} {h}\"><title>{}</title><desc>StykAnimate composited artwork rendered as an embedded image.</desc><image width=\"{w}\" height=\"{h}\" href=\"data:image/png;base64,{href}\"/></svg>",
        escape(title),
        w = size[0],
        h = size[1]
    ))
}

/// A run of triangles of one colour or paint, written as one path.
struct Triangles {
    color: u32,
    paint: u32,
    d: String,
}

struct Writer<'a> {
    frame: &'a Frame<'a>,
    /// Each group's prims: one run of the list.
    runs: Vec<(usize, usize)>,
    defs: String,
    /// Gradients already written, by paint offset, and their ids.
    gradients: HashMap<u32, String>,
    /// Sprites already written, by (image, smooth), and their ids.
    sprites: HashMap<(usize, bool), (String, [u32; 2])>,
    /// The atlas rectangle of each image: (layer, uv bits) to image index.
    atlas: HashMap<(u32, [u32; 4]), usize>,
    body: String,
    /// The world rectangle the view shows (what a fill of the view covers).
    view: [f64; 4],
    tris: Option<Triangles>,
}

impl<'a> Writer<'a> {
    fn new(frame: &'a Frame<'a>) -> Writer<'a> {
        let list = frame.list;
        let mut runs = vec![(usize::MAX, 0usize); list.groups.len().max(1)];
        for (i, p) in list.prims.iter().enumerate() {
            if let Some(run) = runs.get_mut(p.group as usize) {
                run.0 = run.0.min(i);
                run.1 = i + 1;
            }
        }
        for run in &mut runs {
            if run.0 == usize::MAX {
                *run = (0, 0);
            }
        }
        let atlas = (0..frame.doc.images.len())
            .filter_map(|index| {
                let entry = frame.assets.image(index as u32)?;
                Some(((entry.layer, entry.uv().map(f32::to_bits)), index))
            })
            .collect();
        let [width, height] = frame.doc.canvas.map(|side| side as f64);
        let rect = background_bounds(frame.doc, frame.camera, true, [0.0, 0.0, width, height]).rect;
        Writer { frame, runs, defs: String::new(), gradients: HashMap::new(), sprites: HashMap::new(), atlas, body: String::new(), view: rect, tris: None }
    }

    fn write(mut self) -> Option<String> {
        let frame = self.frame;
        self.group(0, 0)?;
        self.flush();
        // A coordinate that is not a number cannot be written as vectors.
        if self.body.contains("NaN") || self.body.contains("inf") {
            return None;
        }
        let [out_w, out_h] = frame.size;
        let [scene_w, scene_h] = frame.doc.canvas.map(|side| side.max(1));
        let matrix = camera_matrix(frame.doc, frame.camera, 1.0, [0.0, 0.0]).map(num).join(" ");
        Some(format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{out_w}\" height=\"{out_h}\" viewBox=\"0 0 {scene_w} {scene_h}\" preserveAspectRatio=\"none\"><title>{}</title><defs>{}</defs><g transform=\"matrix({matrix})\">{}</g></svg>",
            escape(frame.title),
            self.defs,
            self.body
        ))
    }

    /// Group `g`'s prims in painter order, each child group at its composite.
    fn group(&mut self, g: usize, depth: usize) -> Option<()> {
        // A group nested in itself would never end.
        if depth > self.frame.list.groups.len() {
            return None;
        }
        let (start, end) = *self.runs.get(g)?;
        for i in start..end {
            let p = self.frame.list.prims[i];
            if p.kind & 255 == K_COMPOSITE {
                self.flush();
                let child = p.b[0].to_bits() as usize;
                let (_, opacity) = unpack(p.color);
                let _ = write!(self.body, "<g opacity=\"{}\">", num(opacity));
                self.group(child, depth + 1)?;
                self.flush();
                self.body.push_str("</g>");
            } else {
                self.prim(&p)?;
            }
        }
        Some(())
    }

    fn flush(&mut self) {
        if let Some(tris) = self.tris.take() {
            let paint = self.paint(tris.color, tris.paint, "fill");
            let _ = write!(self.body, "<path d=\"{}\" {}/>", tris.d, paint.unwrap_or_default());
        }
    }

    /// The `fill` or `stroke` attributes for a colour or paint record.
    fn paint(&mut self, color: u32, paint: u32, attribute: &str) -> Option<String> {
        if paint == NO_PAINT {
            let (rgb, alpha) = unpack(color);
            return Some(if alpha < 1.0 { format!("{attribute}=\"{}\" {attribute}-opacity=\"{}\"", hex(rgb), num(alpha)) } else { format!("{attribute}=\"{}\"", hex(rgb)) });
        }
        let id = match self.gradients.get(&paint) {
            Some(id) => id.clone(),
            None => {
                let id = format!("gradient-{}", self.gradients.len() + 1);
                self.defs.push_str(&gradient(&self.frame.list.paints, paint, &id)?);
                self.gradients.insert(paint, id.clone());
                id
            }
        };
        Some(format!("{attribute}=\"url(#{id})\""))
    }

    /// A stroked path of `d`.
    fn stroke(&mut self, p: &Prim, d: &str, half_width: f32, cap: &str) -> Option<()> {
        let width = half_width as f64 * 2.0;
        if width <= 0.0 {
            return Some(());
        }
        let stroke = self.paint(p.color, p.paint, "stroke")?;
        let _ = write!(self.body, "<path d=\"{d}\" fill=\"none\" {stroke} stroke-width=\"{}\" stroke-linecap=\"{cap}\" stroke-linejoin=\"round\"/>", num(width));
        Some(())
    }

    fn prim(&mut self, p: &Prim) -> Option<()> {
        let kind = p.kind & 255;
        if kind == K_TRI && p.kind & F_DEPTH == 0 {
            let d = format!("M{} {}L{} {}L{} {}Z", num(p.a[0] as f64), num(p.a[1] as f64), num(p.a[2] as f64), num(p.a[3] as f64), num(p.b[0] as f64), num(p.b[1] as f64));
            match &mut self.tris {
                Some(run) if run.color == p.color && run.paint == p.paint => run.d.push_str(&d),
                _ => {
                    self.flush();
                    self.tris = Some(Triangles { color: p.color, paint: p.paint, d });
                }
            }
            return Some(());
        }
        self.flush();
        let f = |v: f32| num(v as f64);
        match kind {
            K_CAPSULE | K_BOX => {
                let d = format!("M{} {}L{} {}", f(p.a[0]), f(p.a[1]), f(p.a[2]), f(p.a[3]));
                self.stroke(p, &d, p.b[0], if kind == K_BOX { "square" } else { "round" })
            }
            K_ARC => {
                let (center, radius, start, sweep) = ([p.a[0] as f64, p.a[1] as f64], p.a[2] as f64, p.b[0] as f64, p.b[1] as f64);
                let at = |angle: f64| format!("{} {}", num(center[0] + radius * angle.cos()), num(center[1] + radius * angle.sin()));
                if sweep.abs() >= std::f64::consts::TAU - 1e-6 {
                    let stroke = self.paint(p.color, p.paint, "stroke")?;
                    let _ = write!(self.body, "<circle cx=\"{}\" cy=\"{}\" r=\"{}\" fill=\"none\" {stroke} stroke-width=\"{}\"/>", f(p.a[0]), f(p.a[1]), f(p.a[2]), num(p.a[3] as f64 * 2.0));
                    return Some(());
                }
                let large = (sweep.abs() > std::f64::consts::PI) as u8;
                let d = format!("M{}A{} {} 0 {large} {} {}", at(start), num(radius), num(radius), (sweep > 0.0) as u8, at(start + sweep));
                self.stroke(p, &d, p.a[3], "round")
            }
            K_DISC => {
                let fill = self.paint(p.color, p.paint, "fill")?;
                let _ = write!(self.body, "<circle cx=\"{}\" cy=\"{}\" r=\"{}\" {fill}/>", f(p.a[0]), f(p.a[1]), f(p.a[2]));
                Some(())
            }
            K_RING => {
                let width = p.a[3] as f64 * 2.0;
                let inside = if p.kind & F_RING_FILL != 0 {
                    let (rgb, alpha) = unpack(p.b[0].to_bits());
                    if alpha < 1.0 { format!("fill=\"{}\" fill-opacity=\"{}\"", hex(rgb), num(alpha)) } else { format!("fill=\"{}\"", hex(rgb)) }
                } else {
                    "fill=\"none\"".into()
                };
                let stroke = if width > 0.0 { format!(" {} stroke-width=\"{}\"", self.paint(p.color, p.paint, "stroke")?, num(width)) } else { String::new() };
                let _ = write!(self.body, "<circle cx=\"{}\" cy=\"{}\" r=\"{}\" {inside}{stroke}/>", f(p.a[0]), f(p.a[1]), f(p.a[2]));
                Some(())
            }
            K_POLYLINE => {
                let (first, count) = (p.b[1].to_bits() as usize, p.b[2].to_bits() as usize);
                let points = self.frame.list.points.get(first..first + count)?;
                let mut d = String::new();
                for (i, v) in points.iter().enumerate() {
                    let _ = write!(d, "{}{} {}", if i == 0 { "M" } else { "L" }, f(v[0]), f(v[1]));
                }
                if p.kind & F_CLOSED != 0 && count > 2 {
                    d.push('Z');
                }
                self.stroke(p, &d, p.b[0], "round")
            }
            K_IMAGE => {
                // A drawing cel is many tiles at several levels: the frame is exported as a picture.
                if p.kind & F_DRAWING != 0 {
                    return None;
                }
                let (id, size) = self.sprite(p.b[2] as u32, p.c, p.kind & F_SMOOTH != 0)?;
                let (_, alpha) = unpack(p.color);
                let (w, h) = (size[0].max(1) as f64, size[1].max(1) as f64);
                let m = [p.a[2] as f64 / w, p.a[3] as f64 / w, p.b[0] as f64 / h, p.b[1] as f64 / h, p.a[0] as f64, p.a[1] as f64].map(num).join(" ");
                let _ = write!(self.body, "<use href=\"#{id}\" transform=\"matrix({m})\"{}/>", opacity(alpha));
                Some(())
            }
            K_BG_IMAGE => self.background_picture(p),
            K_FILL_VIEW => {
                let fill = self.paint(p.color, p.paint, "fill")?;
                let r = self.view;
                let _ = write!(self.body, "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" {fill}/>", num(r[0]), num(r[1]), num(r[2]), num(r[3]));
                Some(())
            }
            // A lone glyph's own triangles follow its record and are drawn instead.
            K_GLYPH => Some(()),
            // Depth-tested faces, generated effects and anything unknown.
            _ => None,
        }
    }

    /// A background picture covering the canvas rectangle [0, a.x] × [0, a.y], its edge pixels
    /// stretched over the rest of the view (the renderers clamp to the edge): the picture as one
    /// element, with eight nested viewports showing its edge rows and columns beneath it. The edge
    /// pieces reach one unit under the picture, so no seam shows between them.
    fn background_picture(&mut self, p: &Prim) -> Option<()> {
        let (id, size) = self.sprite(p.a[2] as u32, p.c, false)?;
        let (_, alpha) = unpack(p.color);
        let (w, h) = (size[0].max(1) as f64, size[1].max(1) as f64);
        let (extent_x, extent_y) = (p.a[0] as f64, p.a[1] as f64);
        let [view_x, view_y, view_w, view_h] = self.view;
        // Per axis, the bands before the picture, over it and after it, where the view reaches them:
        // where each lies in the world (from, to) and the part of the picture it shows (from, size).
        let axis = |start: f64, end: f64, extent: f64, source: f64| [(start < 0.0).then_some((start, 1.0, 0.0, 1.0)), Some((0.0, extent, 0.0, source)), (end > extent).then_some((extent - 1.0, end, source - 1.0, 1.0))];
        let (xs, ys) = (axis(view_x, view_x + view_w, extent_x, w), axis(view_y, view_y + view_h, extent_y, h));
        let mut pieces = String::new();
        for (xi, x) in xs.iter().enumerate() {
            for (yi, y) in ys.iter().enumerate() {
                let (Some((x0, x1, sx, sw)), Some((y0, y1, sy, sh))) = (x, y) else { continue };
                if (xi, yi) == (1, 1) {
                    continue;
                }
                let _ = write!(
                    pieces,
                    "<svg x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" viewBox=\"{} {} {} {}\" preserveAspectRatio=\"none\"><use href=\"#{id}\"/></svg>",
                    num(*x0), num(*y0), num(x1 - x0), num(y1 - y0), num(*sx), num(*sy), num(*sw), num(*sh)
                );
            }
        }
        let _ = write!(self.body, "<g{}>{pieces}<use href=\"#{id}\" transform=\"matrix({} 0 0 {} 0 0)\"/></g>", opacity(alpha), num(extent_x / w), num(extent_y / h));
        Some(())
    }

    /// The `<image>` of atlas rectangle (`layer`, `uv`), written once: its id and pixel size.
    fn sprite(&mut self, layer: u32, uv: [f32; 4], smooth: bool) -> Option<(String, [u32; 2])> {
        let index = *self.atlas.get(&(layer, uv.map(f32::to_bits)))?;
        if let Some(found) = self.sprites.get(&(index, smooth)) {
            return Some(found.clone());
        }
        let sprite = sprite(self.frame.doc, self.frame.assets, index)?;
        let id = format!("image-{}", self.sprites.len() + 1);
        let rendering = if smooth { "auto" } else { "pixelated" };
        let _ = write!(self.defs, "<image id=\"{id}\" width=\"{}\" height=\"{}\" preserveAspectRatio=\"none\" image-rendering=\"{rendering}\" href=\"{}\"/>", sprite.size[0], sprite.size[1], sprite.href);
        self.sprites.insert((index, smooth), (id.clone(), sprite.size));
        Some((id, sprite.size))
    }
}

/// An ` opacity` attribute for a translucent element, or nothing.
fn opacity(alpha: f64) -> String {
    if alpha < 1.0 { format!(" opacity=\"{}\"", num(alpha)) } else { String::new() }
}
