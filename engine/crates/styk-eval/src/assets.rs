//! Render-ready assets derived once per document: where every image lives in
//! the GPU sprite atlas (computed from image headers, so encoding never waits
//! for pixel decoding) and triangulated glyph outlines.

use std::collections::HashMap;
use std::io::Cursor as Cursor2;
use std::sync::Arc;

use lyon_path::math::point;
use lyon_path::Path;
use lyon_tessellation::{BuffersBuilder, FillOptions, FillRule, FillTessellator, FillVertex, LineCap, LineJoin, StrokeOptions, StrokeTessellator, StrokeVertex, VertexBuffers};

use crate::doc::{Document, DrawingTiles, Glyph, ImageData, PathCmd};

pub const PAGE: u32 = 4096;
const GUTTER: u32 = 1;

#[derive(Clone, Copy, Debug, Default)]
pub struct AtlasEntry {
    pub layer: u32,
    /// Stored pixel rectangle inside the page (excluding the gutter).
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
    /// Source pixel size (before any downscale to fit a page).
    pub source_w: u32,
    pub source_h: u32,
    pub valid: bool,
}

impl AtlasEntry {
    /// UV rectangle (u0, v0, u1, v1) in page coordinates.
    pub fn uv(&self) -> [f32; 4] {
        let p = PAGE as f32;
        [self.x as f32 / p, self.y as f32 / p, (self.x + self.w) as f32 / p, (self.y + self.h) as f32 / p]
    }
}

#[derive(Default, Clone)]
pub struct Assets {
    pub atlas: Vec<AtlasEntry>,
    pub pages: u32,
    /// Triangles (glyph space) per glyph, keyed by the glyph's address. The glyph is
    /// held so the address stays its own.
    pub glyphs: HashMap<usize, (Arc<Glyph>, Arc<[[f32; 2]]>)>,
    /// Triangles of glyph outlines stroked at a glyph-space width (figure outlines
    /// around text), keyed by the glyph's address and the width's bits.
    pub glyph_strokes: HashMap<(usize, u32), (Arc<Glyph>, Arc<[[f32; 2]]>)>,
    /// Atlas slots of drawing cel tiles (64×64 texels each, plus their border).
    pub drawing: Vec<AtlasEntry>,
    /// Per drawing cel, keyed by its address: the cel (held, so the address stays its
    /// own) and its first slot at each display level.
    pub cels: HashMap<usize, (Arc<DrawingTiles>, Vec<u32>)>,
    /// Where the next image goes.
    cursor: Cursor,
    /// Finer tessellations of glyphs drawn large ([`Assets::glyph_at`]), made when first
    /// drawn and shared by the revisions of one document.
    fine: Arc<FineGlyphs>,
}

/// Curve flattening of the tessellations a document's assets hold: within this many
/// glyph units of the outline (level 0).
pub const GLYPH_TOLERANCE: f32 = 0.02;
/// Text drawn large flattens finer, by halves (levels 1 to [`GLYPH_MAX_LEVEL`]), so that
/// its curves stay within this many world units of the outline the editor fills.
pub const GLYPH_WORLD_TOLERANCE: f64 = 0.1;
pub const GLYPH_MAX_LEVEL: u8 = 8;
/// Bytes of finer glyph tessellations kept per document; beyond, the cache starts over.
const FINE_BUDGET: usize = 64 << 20;

/// The tessellation level of glyphs drawn `xs` and `ys` world units per glyph unit: the
/// coarsest whose flattening, scaled to the world, is within [`GLYPH_WORLD_TOLERANCE`].
pub fn glyph_level(xs: f64, ys: f64) -> u8 {
    let scale = xs.abs().max(ys.abs());
    if !(scale.is_finite() && scale > 0.0) {
        return 0;
    }
    (scale * GLYPH_TOLERANCE as f64 / GLYPH_WORLD_TOLERANCE).log2().ceil().clamp(0.0, GLYPH_MAX_LEVEL as f64) as u8
}

/// Finer glyph tessellations by (glyph address, stroke width bits or `u32::MAX` for a fill,
/// level), with the glyph held so its address stays its own.
type FineMap = HashMap<(usize, u32, u8), (Arc<Glyph>, Arc<[[f32; 2]]>)>;

/// [`FineMap`] and the bytes of its triangles.
#[derive(Default)]
struct FineGlyphs {
    map: std::sync::Mutex<(FineMap, usize)>,
}

impl FineGlyphs {
    /// Takes the map, spinning while another thread holds it: the interface thread may not
    /// wait (D7), and every critical section is a lookup or an insertion.
    fn lock(&self) -> std::sync::MutexGuard<'_, (FineMap, usize)> {
        loop {
            match self.map.try_lock() {
                Ok(guard) => return guard,
                Err(std::sync::TryLockError::Poisoned(poisoned)) => return poisoned.into_inner(),
                Err(std::sync::TryLockError::WouldBlock) => std::hint::spin_loop(),
            }
        }
    }

    /// The cached triangles of `key`, or `make()`'s, stored. Tessellation runs without the
    /// lock: two threads may both make one, and the first stored is kept.
    fn get(&self, glyph: &Arc<Glyph>, key: (usize, u32, u8), make: impl FnOnce() -> Arc<[[f32; 2]]>) -> Arc<[[f32; 2]]> {
        if let Some((_, triangles)) = self.lock().0.get(&key) {
            return triangles.clone();
        }
        let triangles = make();
        let mut guard = self.lock();
        let (map, bytes) = &mut *guard;
        if let Some((_, kept)) = map.get(&key) {
            return kept.clone();
        }
        let size = std::mem::size_of_val(&*triangles);
        if *bytes + size > FINE_BUDGET {
            map.clear();
            *bytes = 0;
        }
        *bytes += size;
        map.insert(key, (glyph.clone(), triangles.clone()));
        triangles
    }
}

/// The packer's position: images are only ever appended, so a rectangle handed
/// out stays valid for every later revision of the document.
#[derive(Default, Clone, Copy)]
struct Cursor {
    layer: u32,
    x: u32,
    y: u32,
    shelf: u32,
    used: bool,
}

/// The pixel size of an image from its header, without decoding it.
pub(crate) fn dimensions(data: &ImageData) -> Option<(u32, u32)> {
    image::ImageReader::new(Cursor2::new(&data.bytes[..])).with_guessed_format().ok()?.into_dimensions().ok()
}

impl Assets {
    pub fn build(doc: &Document) -> Assets {
        Assets::default().extended(doc)
    }

    /// The assets of a later revision of the same document: images the previous
    /// revision placed keep their rectangles, new ones are packed after them, and
    /// only new glyphs are tessellated.
    pub fn extended(&self, doc: &Document) -> Assets {
        let mut assets = self.clone();
        let known = assets.atlas.len().min(doc.images.len());
        let sizes: Vec<Option<(u32, u32)>> = crate::par::map(&doc.images[known..], 8, dimensions);
        assets.atlas.resize(doc.images.len(), AtlasEntry::default());
        pack(&sizes, &mut assets.atlas[known..], &mut assets.cursor, GUTTER);
        // Drawing cels new in this revision get slots after everything placed before.
        let mut cels = Vec::new();
        collect_cels(doc, &mut cels);
        cels.retain(|cel| !assets.cels.contains_key(&(Arc::as_ptr(cel) as usize)));
        cels.dedup_by(|a, b| Arc::ptr_eq(a, b));
        for cel in cels {
            if assets.cels.contains_key(&(Arc::as_ptr(&cel) as usize)) {
                continue;
            }
            let first = assets.drawing.len() as u32;
            let mut starts = Vec::with_capacity(cel.levels.len());
            let mut count = 0u32;
            for level in &cel.levels {
                starts.push(first + count);
                count += level.len() as u32;
            }
            let sizes = vec![Some((crate::drawing::TILE, crate::drawing::TILE)); count as usize];
            assets.drawing.resize(assets.drawing.len() + count as usize, AtlasEntry::default());
            pack(&sizes, &mut assets.drawing[first as usize..], &mut assets.cursor, crate::drawing::BORDER);
            assets.cels.insert(Arc::as_ptr(&cel) as usize, (cel, starts));
        }
        assets.pages = if assets.cursor.used { assets.cursor.layer + 1 } else { 0 };
        let mut glyph_list: Vec<Arc<Glyph>> = Vec::new();
        collect_glyphs(doc, &mut glyph_list);
        glyph_list.retain(|glyph| !assets.glyphs.contains_key(&(Arc::as_ptr(glyph) as usize)));
        glyph_list.dedup_by(|a, b| Arc::ptr_eq(a, b));
        for (glyph, triangles) in crate::par::map(&glyph_list, 8, |g| (g.clone(), tessellate(&g.path))) {
            assets.glyphs.insert(Arc::as_ptr(&glyph) as usize, (glyph, triangles));
        }
        let mut outlined: Vec<(Arc<Glyph>, f32)> = Vec::new();
        collect_outlined_glyphs(doc, &mut outlined);
        outlined.retain(|(glyph, width)| !assets.glyph_strokes.contains_key(&(Arc::as_ptr(glyph) as usize, width.to_bits())));
        outlined.sort_by_key(|(glyph, width)| (Arc::as_ptr(glyph) as usize, width.to_bits()));
        outlined.dedup_by(|a, b| Arc::ptr_eq(&a.0, &b.0) && a.1 == b.1);
        for (glyph, width, triangles) in crate::par::map(&outlined, 8, |(g, w)| (g.clone(), *w, stroke(&g.path, *w))) {
            assets.glyph_strokes.insert((Arc::as_ptr(&glyph) as usize, width.to_bits()), (glyph, triangles));
        }
        assets
    }

    /// Triangles of `glyph`'s outline stroked `width` wide in glyph space, flattened at
    /// tessellation `level` ([`glyph_level`]): level 0 prepared for every outlined figure
    /// of the document (tessellated here for any other), finer levels when first drawn.
    pub fn glyph_stroke(&self, glyph: &Arc<Glyph>, width: f32, level: u8) -> Arc<[[f32; 2]]> {
        let address = Arc::as_ptr(glyph) as usize;
        if level > 0 {
            return self.fine.get(glyph, (address, width.to_bits(), level), || stroke_at(&glyph.path, width, level_tolerance(level)));
        }
        match self.glyph_strokes.get(&(address, width.to_bits())) {
            Some((_, triangles)) => triangles.clone(),
            None => stroke(&glyph.path, width),
        }
    }

    /// Triangles of `glyph` filled even-odd, flattened at tessellation `level`
    /// ([`glyph_level`]): level 0 prepared for the document, finer levels when first
    /// drawn (on the calling thread, cached for every later frame).
    pub fn glyph_at(&self, glyph: &Arc<Glyph>, level: u8) -> Option<Arc<[[f32; 2]]>> {
        if level == 0 {
            return self.glyph(glyph).cloned();
        }
        let address = Arc::as_ptr(glyph) as usize;
        self.glyphs.contains_key(&address).then(|| self.fine.get(glyph, (address, u32::MAX, level), || tessellate_at(&glyph.path, level_tolerance(level))))
    }

    /// The first atlas slot of each display level of `cel`.
    pub fn cel_levels(&self, cel: &Arc<DrawingTiles>) -> Option<&[u32]> {
        self.cels.get(&(Arc::as_ptr(cel) as usize)).map(|(_, starts)| starts.as_slice())
    }

    pub fn image(&self, index: u32) -> Option<&AtlasEntry> {
        self.atlas.get(index as usize).filter(|e| e.valid)
    }

    pub fn glyph(&self, glyph: &Arc<Glyph>) -> Option<&Arc<[[f32; 2]]>> {
        self.glyphs.get(&(Arc::as_ptr(glyph) as usize)).map(|(_, triangles)| triangles)
    }
}

fn collect_cels(doc: &Document, out: &mut Vec<Arc<DrawingTiles>>) {
    for f in &doc.figures {
        out.extend(f.images.iter().filter_map(|image| image.tiles.clone()));
        if let Some(m) = &f.movieclip {
            collect_cels(&m.document, out);
        }
    }
}

fn collect_glyphs(doc: &Document, out: &mut Vec<Arc<Glyph>>) {
    for f in &doc.figures {
        for t in &f.texts {
            out.extend(t.glyphs.iter().cloned());
        }
        if let Some(m) = &f.movieclip {
            collect_glyphs(&m.document, out);
        }
    }
}

/// The glyph-space width a figure outline strokes text with: twice the outline
/// width, as a canvas line width (`strokeWidth` in geometry.mjs rounds it to f32).
pub fn text_outline_width(outline: &crate::doc::Outline) -> f32 {
    (2.0 * outline.width) as f32
}

fn collect_outlined_glyphs(doc: &Document, out: &mut Vec<(Arc<Glyph>, f32)>) {
    for f in &doc.figures {
        if let Some(outline) = &f.outline {
            let width = text_outline_width(outline);
            for t in &f.texts {
                out.extend(t.glyphs.iter().map(|g| (g.clone(), width)));
            }
        }
        if let Some(m) = &f.movieclip {
            collect_outlined_glyphs(&m.document, out);
        }
    }
}

/// Shelf packing into `PAGE`-sized layers, tallest images first, continuing at `cursor`.
fn pack(sizes: &[Option<(u32, u32)>], entries: &mut [AtlasEntry], cursor: &mut Cursor, gutter: u32) {
    let max = PAGE - 2 * gutter;
    let mut order: Vec<usize> = (0..sizes.len()).filter(|&i| sizes[i].is_some()).collect();
    let fit = |w: u32, h: u32| -> (u32, u32) {
        if w <= max && h <= max {
            return (w.max(1), h.max(1));
        }
        let s = (max as f64 / w as f64).min(max as f64 / h as f64);
        (((w as f64 * s).floor() as u32).max(1), ((h as f64 * s).floor() as u32).max(1))
    };
    order.sort_by_key(|&i| {
        let (w, h) = sizes[i].unwrap();
        std::cmp::Reverse(fit(w, h).1)
    });
    let Cursor { mut layer, mut x, mut y, mut shelf, mut used } = *cursor;
    for i in order {
        let (sw, sh) = sizes[i].unwrap();
        let (w, h) = fit(sw, sh);
        let (cw, ch) = (w + 2 * gutter, h + 2 * gutter);
        if x + cw > PAGE {
            x = 0;
            y += shelf;
            shelf = 0;
        }
        if y + ch > PAGE {
            layer += 1;
            x = 0;
            y = 0;
            shelf = 0;
        }
        entries[i] = AtlasEntry { layer, x: x + gutter, y: y + gutter, w, h, source_w: sw, source_h: sh, valid: true };
        used = true;
        x += cw;
        shelf = shelf.max(ch);
    }
    *cursor = Cursor { layer, x, y, shelf, used };
}

/// The path of a glyph. A subpath is closed only where the glyph says so
/// (`close_all` closes every one, which a fill does anyway).
fn glyph_path(path: &[PathCmd], close_all: bool) -> Path {
    let mut builder = Path::builder();
    let mut open = false;
    for cmd in path {
        match *cmd {
            PathCmd::Move(x, y) => {
                if open {
                    builder.end(close_all);
                }
                builder.begin(point(x, y));
                open = true;
            }
            PathCmd::Line(x, y) => {
                if !open {
                    builder.begin(point(x, y));
                    open = true;
                } else {
                    builder.line_to(point(x, y));
                }
            }
            PathCmd::Cubic(a, b, c, d, e, f) => {
                if !open {
                    builder.begin(point(a, b));
                    open = true;
                }
                builder.cubic_bezier_to(point(a, b), point(c, d), point(e, f));
            }
            PathCmd::Close => {
                if open {
                    builder.end(true);
                    open = false;
                }
            }
        }
    }
    if open {
        builder.end(close_all);
    }
    builder.build()
}

/// The flattening tolerance of tessellation `level`, in glyph units.
fn level_tolerance(level: u8) -> f32 {
    GLYPH_TOLERANCE / (1u32 << level.min(GLYPH_MAX_LEVEL)) as f32
}

/// Even-odd fill triangulation of one glyph (glyph space).
pub fn tessellate(path: &[PathCmd]) -> Arc<[[f32; 2]]> {
    tessellate_at(path, GLYPH_TOLERANCE)
}

/// [`tessellate`] flattening curves within `tolerance` glyph units.
pub fn tessellate_at(path: &[PathCmd], tolerance: f32) -> Arc<[[f32; 2]]> {
    triangulate(&glyph_path(path, true), FillRule::EvenOdd, tolerance)
}

/// A glyph's outline stroked `width` wide with round joins and caps (glyph space),
/// as the editor strokes text for a figure outline.
pub fn stroke(path: &[PathCmd], width: f32) -> Arc<[[f32; 2]]> {
    stroke_at(path, width, GLYPH_TOLERANCE)
}

/// [`stroke`] flattening curves within `tolerance` glyph units.
pub fn stroke_at(path: &[PathCmd], width: f32, tolerance: f32) -> Arc<[[f32; 2]]> {
    let path = glyph_path(path, false);
    let mut buffers: VertexBuffers<[f32; 2], u32> = VertexBuffers::new();
    let options = StrokeOptions::tolerance(tolerance).with_line_width(width).with_line_join(LineJoin::Round).with_line_cap(LineCap::Round);
    let ok = StrokeTessellator::new()
        .tessellate_path(&path, &options, &mut BuffersBuilder::new(&mut buffers, |v: StrokeVertex| v.position().to_array()))
        .is_ok();
    if !ok {
        return Arc::from(Vec::new());
    }
    buffers.indices.iter().map(|&i| buffers.vertices[i as usize]).collect::<Vec<_>>().into()
}

pub fn triangulate(path: &Path, rule: FillRule, tolerance: f32) -> Arc<[[f32; 2]]> {
    let mut buffers: VertexBuffers<[f32; 2], u32> = VertexBuffers::new();
    let mut tess = FillTessellator::new();
    let options = FillOptions::tolerance(tolerance).with_fill_rule(rule);
    let ok = tess
        .tessellate_path(path, &options, &mut BuffersBuilder::new(&mut buffers, |v: FillVertex| v.position().to_array()))
        .is_ok();
    if !ok {
        return Arc::from(Vec::new());
    }
    buffers.indices.iter().map(|&i| buffers.vertices[i as usize]).collect::<Vec<_>>().into()
}

/// Premultiplied RGBA pixels of one image, sized for its atlas rectangle with a
/// one-pixel gutter that repeats its edges (so filtering never reads a neighbour).
pub struct DecodedImage {
    /// An index into `Document::images`, or into [`Assets::drawing`] when `drawing` is set.
    pub index: u32,
    /// A drawing cel tile: straight alpha, with its neighbours' texels as its border.
    pub drawing: bool,
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// Decodes a drawing cel into its atlas slots (every level, see [`crate::drawing`]).
pub fn decode_cel(assets: &Assets, cel: &Arc<DrawingTiles>) -> Vec<DecodedImage> {
    let Some(starts) = assets.cel_levels(cel) else { return Vec::new() };
    let side = crate::drawing::TILE + 2 * crate::drawing::BORDER;
    crate::drawing::decode_cel(cel)
        .into_iter()
        .map(|(level, index, rgba)| DecodedImage { index: starts[level as usize] + index, drawing: true, width: side, height: side, rgba })
        .collect()
}

/// One picture to decode: an image of the document, or a drawing cel (every display level of it).
#[derive(Clone, Copy, Debug)]
pub enum Picture {
    /// An index into `Document::images`.
    Image(usize),
    /// A drawing cel, by its key in [`Assets::cels`].
    Cel(usize),
}

impl Assets {
    /// The pixels decoding `picture` produces, as far as is known without decoding it: its atlas places.
    pub fn picture_bytes(&self, picture: Picture) -> usize {
        match picture {
            Picture::Image(index) => self.atlas.get(index).filter(|entry| entry.valid).map_or(0, |entry| (entry.w as usize + 2) * (entry.h as usize + 2) * 4),
            Picture::Cel(cel) => {
                let side = (crate::drawing::TILE + 2 * crate::drawing::BORDER) as usize;
                self.cels.get(&cel).map_or(0, |(tiles, _)| tiles.levels.iter().map(Vec::len).sum::<usize>() * side * side * 4)
            }
        }
    }
}

/// Decodes `picture` of `doc` (an image, or every display level of a drawing cel) for the atlas `assets` laid out.
/// The decoders allocate in pieces nothing can refuse, so a picture is decoded only when the memory can hold its
/// work; an error says it cannot (see `styk_alloc::reserve`).
pub fn decode_picture(doc: &Document, assets: &Assets, picture: Picture) -> Result<Vec<DecodedImage>, styk_alloc::OutOfMemory> {
    match picture {
        Picture::Image(index) => {
            let _working = styk_alloc::reserve(decode_image_working_bytes(assets, index))?;
            Ok(decode_image(doc, assets, index).into_iter().collect())
        }
        Picture::Cel(cel) => {
            let Some((tiles, _)) = assets.cels.get(&cel) else { return Ok(Vec::new()) };
            let _working = styk_alloc::reserve(3 * assets.picture_bytes(picture))?;
            Ok(decode_cel(assets, tiles))
        }
    }
}

/// The most memory [`decode_image`] holds at once: the picture decoded at its own size (twice: the decoder keeps
/// its own copy), then resized and bordered at the size of its atlas place (twice). Zero for an image without one.
pub fn decode_image_working_bytes(assets: &Assets, index: usize) -> usize {
    let Some(entry) = assets.atlas.get(index).filter(|entry| entry.valid) else { return 0 };
    let source = entry.source_w as usize * entry.source_h as usize * 4;
    let stored = (entry.w as usize + 2) * (entry.h as usize + 2) * 4;
    2 * source + 2 * stored
}

/// Decodes image `index` of `doc` for the atlas `assets` laid out. `None` when the
/// image has no place in the atlas or cannot be decoded.
pub fn decode_image(doc: &Document, assets: &Assets, index: usize) -> Option<DecodedImage> {
    let data = doc.images.get(index)?;
    let entry = assets.atlas.get(index).filter(|entry| entry.valid)?;
    let mut rgba = image::load_from_memory(&data.bytes).ok()?.to_rgba8();
    if let Some(key) = data.color_key {
        for pixel in rgba.pixels_mut() {
            if pixel[0] == key[0] && pixel[1] == key[1] && pixel[2] == key[2] {
                pixel[3] = 0;
            }
        }
    }
    if rgba.width() != entry.w || rgba.height() != entry.h {
        rgba = image::imageops::resize(&rgba, entry.w, entry.h, image::imageops::FilterType::Triangle);
    }
    let (w, h) = (entry.w as usize, entry.h as usize);
    let (gw, gh) = (w + 2, h + 2);
    // The one allocation of the picture's size that is not the decoder's: a failure is a picture that cannot be shown.
    let mut out = Vec::new();
    out.try_reserve_exact(gw * gh * 4).ok()?;
    out.resize(gw * gh * 4, 0u8);
    let source = rgba.as_raw();
    for gy in 0..gh {
        let sy = gy.saturating_sub(1).min(h - 1);
        for gx in 0..gw {
            let sx = gx.saturating_sub(1).min(w - 1);
            let p = &source[(sy * w + sx) * 4..(sy * w + sx) * 4 + 4];
            let a = p[3] as u32;
            let o = (gy * gw + gx) * 4;
            out[o] = ((p[0] as u32 * a + 127) / 255) as u8;
            out[o + 1] = ((p[1] as u32 * a + 127) / 255) as u8;
            out[o + 2] = ((p[2] as u32 * a + 127) / 255) as u8;
            out[o + 3] = a as u8;
        }
    }
    Some(DecodedImage { index: index as u32, drawing: false, width: gw as u32, height: gh as u32, rgba: out })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drawing_padding_does_not_change_sprite_gutters_or_overlap_slots() {
        let mut cursor = Cursor::default();
        let mut entries = [AtlasEntry::default(); 3];
        let sizes = [Some((64, 64))];
        pack(&sizes, &mut entries[..1], &mut cursor, GUTTER);
        pack(&sizes, &mut entries[1..2], &mut cursor, crate::drawing::BORDER);
        pack(&sizes, &mut entries[2..], &mut cursor, GUTTER);
        assert_eq!([entries[0].x, entries[0].y], [1, 1], "sprite gutter stays one texel");
        assert_eq!([entries[1].x, entries[1].y], [68, 2], "the drawing reserves two texels");
        assert_eq!([entries[2].x, entries[2].y], [135, 1], "the next sprite keeps its own gutter");
        for entry in entries {
            assert_eq!([entry.w, entry.h, entry.source_w, entry.source_h], [64; 4], "padding never changes image UVs or size");
        }
        assert_eq!(entries[0].x + entries[0].w + 1, entries[1].x - crate::drawing::BORDER);
        assert_eq!(entries[1].x + entries[1].w + crate::drawing::BORDER, entries[2].x - 1);
    }
}
