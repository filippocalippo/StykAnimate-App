//! Render-ready assets derived once per document: where every image lives in
//! the GPU sprite atlas (computed from image headers, so encoding never waits
//! for pixel decoding) and triangulated glyph outlines.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::io::Cursor as Cursor2;
use std::sync::Arc;

use lyon_path::math::point;
use lyon_path::Path;
use lyon_tessellation::{BuffersBuilder, FillOptions, FillRule, FillTessellator, FillVertex, LineCap, LineJoin, StrokeOptions, StrokeTessellator, StrokeVertex, VertexBuffers};

use crate::doc::{Document, DrawingTiles, Glyph, ImageData, PathCmd};

pub const PAGE: u32 = 4096;
/// A soft copy of a picture (a placeholder the renderer draws until the picture itself is on the GPU) has one texel
/// for every [`SOFT_SCALE`]² of the atlas page it lies on.
pub const SOFT_SCALE: u32 = 8;
/// A page of the soft atlas, in soft texels.
pub const SOFT_PAGE: u32 = PAGE / SOFT_SCALE;
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
    /// Per drawing cel, keyed by its pixels' identity ([`DrawingTiles::key`]): the cel (held, so the key stays
    /// its own) and the slot of each of its drawn tiles, by display level and index in [`DrawingTiles::levels`]. A cel whose
    /// bounds or revision changed with the same pixels is the same entry.
    pub cels: HashMap<usize, (Arc<DrawingTiles>, Vec<Vec<u32>>)>,
    /// The number of each placed cel's placement (by its key).
    placements: HashMap<usize, Placement>,
    /// The numbers of the placements in `placements`.
    serials: HashSet<u64>,
    /// Slots of [`Assets::drawing`] no cel holds: a cel the document no longer has gave them back, the cels placed after it take them first
    /// (lowest first, so a cel's tiles stay together on the pages).
    free: BTreeSet<u32>,
    /// Where the next image goes.
    cursor: Cursor,
    /// Finer tessellations of glyphs drawn large ([`Assets::glyph_at`]), made when first
    /// drawn and shared by the revisions of one document.
    fine: Arc<FineGlyphs>,
    /// Triangles of filled polygons, shared like `fine` by the revisions of one document ([`Assets::fill`]).
    fills: Arc<FillMemory>,
    /// Which assets these are: an [`Assets::extended`] that adds something is numbered anew, unlike the address it lives at (an address is
    /// reused once the assets are dropped); one that adds nothing places everything where the assets before it did and keeps the number.
    /// 0 for assets that were not built.
    id: u64,
}

/// A number no other placement of a cel ever had, the cel's identity in the document (`CelRef::id`), and which of its tiles are to be written:
/// all of them (`None`), or those `dirty` says (by level and index), the others being in the slots of the cel it replaced, where that cel's
/// decode left them.
#[derive(Clone)]
struct Placement {
    serial: u64,
    id: Option<Arc<str>>,
    dirty: Option<Vec<Vec<bool>>>,
}

/// Numbers the placements of cels.
static NEXT_PLACEMENT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// Numbers the assets [`Assets::extended`] makes.
static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

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

/// Triangles of the concave polygons figures fill, by the polygon: the points of a polygon come out the same every frame the figure
/// does not move, and tessellating them is most of what encoding a frame of such figures costs.
#[derive(Default)]
struct FillMemory {
    map: std::sync::Mutex<(HashMap<Box<[[u32; 2]]>, Arc<[[f32; 2]]>>, usize)>,
    /// How many polygons were tessellated.
    made: std::sync::atomic::AtomicUsize,
}

/// Bytes the memory may hold per document, counted as it holds them: the triangles, the polygon that names them, and what a table entry and
/// an `Arc` cost besides; beyond, the memory starts over.
const FILL_BUDGET: usize = 4 << 20;
/// What an entry costs beyond its triangles and its polygon: the table's slot and hash, the key's box, the triangles' `Arc` counts.
const FILL_ENTRY_OVERHEAD: usize = 96;

impl FillMemory {
    /// The triangles of the polygon with these points (as `f32` bits), or `make()`'s, stored. The tessellation runs without the lock: two
    /// threads may both make one, and the first stored is kept. The lock is spun for, never waited on (D7).
    fn get(&self, points: &[[u32; 2]], make: impl FnOnce() -> Arc<[[f32; 2]]>) -> Arc<[[f32; 2]]> {
        let lock = || loop {
            match self.map.try_lock() {
                Ok(guard) => return guard,
                Err(std::sync::TryLockError::Poisoned(poisoned)) => return poisoned.into_inner(),
                Err(std::sync::TryLockError::WouldBlock) => std::hint::spin_loop(),
            }
        };
        if let Some(kept) = lock().0.get(points) {
            return kept.clone();
        }
        let triangles = make();
        self.made.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let mut guard = lock();
        let (map, bytes) = &mut *guard;
        if let Some(kept) = map.get(points) {
            return kept.clone();
        }
        let size = std::mem::size_of_val(&*triangles) + std::mem::size_of_val(points) + FILL_ENTRY_OVERHEAD;
        if *bytes + size > FILL_BUDGET {
            map.clear();
            *bytes = 0;
        }
        *bytes += size;
        map.insert(points.into(), triangles.clone());
        triangles
    }
}

/// The packer's position: images are only ever appended, so a rectangle handed
/// out stays valid for every later revision of the document.
#[derive(Default, Clone)]
struct Cursor {
    layer: u32,
    x: u32,
    y: u32,
    shelf: u32,
    used: bool,
    /// Free space earlier pages left behind.
    holes: Vec<Hole>,
}

/// The pixel size of an image from its header, without decoding it.
pub(crate) fn dimensions(data: &ImageData) -> Option<(u32, u32)> {
    image::ImageReader::new(Cursor2::new(&data.bytes[..])).with_guessed_format().ok()?.into_dimensions().ok()
}

impl Assets {
    /// The number these assets were made under (see the field).
    pub fn id(&self) -> u64 {
        self.id
    }

    pub fn build(doc: &Document) -> Assets {
        Assets::default().extended(doc)
    }

    /// The assets of a later revision of the same document: images the previous
    /// revision placed keep their rectangles, new ones are packed after them, and
    /// only new glyphs are tessellated.
    pub fn extended(&self, doc: &Document) -> Assets {
        self.extended_inheriting(doc, false)
    }

    /// [`Assets::extended`], where a cel that replaces one with the same identity (`CelRef::id`) takes the slots of the tiles they share when
    /// `inherit` says that cel's decode is over and its pixels are all in the atlas: the tiles that did not change keep their slots and are
    /// not written again ([`Assets::cel_dirty`]). Without it every cel is written whole.
    pub fn extended_inheriting(&self, doc: &Document, inherit: bool) -> Assets {
        let mut assets = self.clone();
        let held = (self.atlas.len(), self.drawing.len(), self.cels.len(), self.glyphs.len(), self.glyph_strokes.len());
        let known = assets.atlas.len().min(doc.images.len());
        let sizes: Vec<Option<(u32, u32)>> = crate::par::map(&doc.images[known..], 8, dimensions);
        assets.atlas.resize(doc.images.len(), AtlasEntry::default());
        pack(&sizes, &mut assets.atlas[known..], &mut assets.cursor, GUTTER);
        // Drawing cels the document no longer has (the edit that replaced them was published before this one) give their slots back.
        let mut cels = Vec::new();
        collect_cels(doc, &mut cels);
        let wanted: HashSet<usize> = cels.iter().map(|(_, cel)| cel.key()).collect();
        let gone: Vec<usize> = assets.cels.keys().copied().filter(|key| !wanted.contains(key)).collect();
        let mut given_back: Vec<(Option<Arc<str>>, Arc<DrawingTiles>, Vec<Vec<u32>>)> = Vec::new();
        for key in &gone {
            let removed = assets.cels.remove(key);
            if let (Some((tiles, slots)), Some(placement)) = (removed, assets.placements.remove(key)) {
                assets.serials.remove(&placement.serial);
                given_back.push((placement.id, tiles, slots));
            }
        }
        cels.retain(|(_, cel)| !assets.cels.contains_key(&cel.key()));
        cels.dedup_by(|a, b| a.1.key() == b.1.key());
        let placed = !cels.is_empty() || !gone.is_empty();
        // A cel that replaces one given back keeps the slots of the tiles they share, when the one it replaces is all in the atlas.
        let mut inherited_slots: HashSet<u32> = HashSet::new();
        let mut plans: Vec<(Option<Arc<str>>, Arc<DrawingTiles>, Vec<Vec<Option<u32>>>, Option<Vec<Vec<bool>>>)> = Vec::new();
        for (id, cel) in cels {
            let mut plan: Vec<Vec<Option<u32>>> = cel.levels.iter().map(|level| vec![None; level.len()]).collect();
            let mut dirty = None;
            let before = if inherit && id.is_some() { given_back.iter().position(|(was, tiles, _)| *was == id && tiles.tile_ink.get().is_some()) } else { None };
            if let Some(at) = before {
                let (_, old, old_slots) = given_back.swap_remove(at);
                if let Some(ink) = old.tile_ink.get() {
                    let _ = cel.inherited_ink.set(ink.clone());
                }
                for (n, level) in cel.levels.iter().enumerate() {
                    let Some(was) = old.levels.get(n) else { continue };
                    for (i, &(x, y)) in level.iter().enumerate() {
                        if let Ok(j) = was.binary_search_by_key(&(y, x), |&(x, y)| (y, x)) {
                            plan[n][i] = Some(old_slots[n][j]);
                            inherited_slots.insert(old_slots[n][j]);
                        }
                    }
                }
                dirty = Some(crate::drawing::dirty_tiles(&old, &cel));
                // The old cel's slots that the new one does not use are free below.
                given_back.push((None, old, old_slots));
            }
            plans.push((id, cel, plan, dirty));
        }
        for (_, _, slots) in given_back {
            assets.free.extend(slots.into_iter().flatten().filter(|slot| !inherited_slots.contains(slot)));
        }
        // The tiles that inherited no slot are given the slots given back, then slots after everything placed before.
        for (id, cel, plan, dirty) in plans {
            let slots: Vec<Vec<u32>> = plan
                .into_iter()
                .map(|level| {
                    let missing = level.iter().filter(|slot| slot.is_none()).count();
                    let mut fresh = assets.take_slots(missing).into_iter();
                    level.into_iter().map(|slot| slot.unwrap_or_else(|| fresh.next().expect("a slot for every tile"))).collect()
                })
                .collect();
            let serial = NEXT_PLACEMENT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            assets.serials.insert(serial);
            assets.placements.insert(cel.key(), Placement { serial, id, dirty });
            assets.cels.insert(cel.key(), (cel, slots));
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
        if self.id == 0 || placed || held != (assets.atlas.len(), assets.drawing.len(), assets.cels.len(), assets.glyphs.len(), assets.glyph_strokes.len()) {
            assets.id = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
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

    /// `count` slots of [`Assets::drawing`] for the tiles of one display level of a cel: the lowest slots given back, then new ones packed
    /// after everything placed.
    fn take_slots(&mut self, count: usize) -> Vec<u32> {
        let mut slots = Vec::with_capacity(count);
        while slots.len() < count {
            match self.free.pop_first() {
                Some(slot) => slots.push(slot),
                None => break,
            }
        }
        let more = count - slots.len();
        if more > 0 {
            let first = self.drawing.len();
            let sizes = vec![Some((crate::drawing::TILE, crate::drawing::TILE)); more];
            self.drawing.resize(first + more, AtlasEntry::default());
            pack(&sizes, &mut self.drawing[first..], &mut self.cursor, crate::drawing::BORDER);
            slots.extend((first..first + more).map(|slot| slot as u32));
        }
        slots
    }

    /// The number of the placement of the cel with key `cel` (0 when it has none): the tiles decoded for it carry it ([`DecodedImage::placement`]).
    pub fn placement(&self, cel: usize) -> u64 {
        self.placements.get(&cel).map_or(0, |placement| placement.serial)
    }

    /// Every placement of a cel: its number and the slots of [`Assets::drawing`] its decode writes (all of its tiles', or the dirty ones').
    pub fn placements(&self) -> impl Iterator<Item = (u64, Vec<u32>)> + '_ {
        self.cels.iter().filter_map(|(key, (_, slots))| {
            let placement = self.placements.get(key)?;
            let written = slots
                .iter()
                .enumerate()
                .flat_map(|(n, level)| level.iter().enumerate().filter(move |(i, _)| placement.dirty.as_ref().is_none_or(|dirty| dirty[n][*i])).map(|(_, slot)| *slot))
                .collect();
            Some((placement.serial, written))
        })
    }

    /// Which tiles of `cel` its decode is to write, by level and index (`None`: all of them): the others are in the slots of the cel it replaced.
    pub fn cel_dirty(&self, cel: usize) -> Option<&[Vec<bool>]> {
        self.placements.get(&cel)?.dirty.as_deref()
    }

    /// Whether the placement numbered `serial` is still the place of a cel: the slots a tile decoded for it names are that cel's.
    pub fn holds_placement(&self, serial: u64) -> bool {
        self.serials.contains(&serial)
    }

    /// How many concave polygons were tessellated for these assets and the revisions after them (the rest were kept).
    pub fn fills_made(&self) -> usize {
        self.fills.made.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// The triangles of the concave polygon `points` filled even-odd (what [`triangulate`] makes of it at tolerance 0.05), kept for the frames
    /// that draw the same polygon again.
    pub fn fill(&self, points: &[[f64; 2]]) -> Arc<[[f32; 2]]> {
        let key: Vec<[u32; 2]> = points.iter().map(|p| [(p[0] as f32).to_bits(), (p[1] as f32).to_bits()]).collect();
        self.fills.get(&key, || {
            let mut builder = lyon_path::Path::builder();
            builder.begin(lyon_path::math::point(points[0][0] as f32, points[0][1] as f32));
            for p in &points[1..] {
                builder.line_to(lyon_path::math::point(p[0] as f32, p[1] as f32));
            }
            builder.end(true);
            triangulate(&builder.build(), FillRule::EvenOdd, 0.05)
        })
    }

    /// The atlas slot of each drawn tile of `cel`, by display level and index in [`DrawingTiles::levels`].
    pub fn cel_slots(&self, cel: &Arc<DrawingTiles>) -> Option<&[Vec<u32>]> {
        self.cels.get(&cel.key()).map(|(_, slots)| slots.as_slice())
    }

    pub fn image(&self, index: u32) -> Option<&AtlasEntry> {
        self.atlas.get(index as usize).filter(|e| e.valid)
    }

    pub fn glyph(&self, glyph: &Arc<Glyph>) -> Option<&Arc<[[f32; 2]]>> {
        self.glyphs.get(&(Arc::as_ptr(glyph) as usize)).map(|(_, triangles)| triangles)
    }
}

fn collect_cels(doc: &Document, out: &mut Vec<(Option<Arc<str>>, Arc<DrawingTiles>)>) {
    for f in &doc.figures {
        out.extend(f.images.iter().filter_map(|image| image.tiles.clone().map(|tiles| (image.cel.as_ref().map(|cel| cel.id.clone()), tiles))));
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

/// Free space on a page that the packer left behind: images that no longer fit the
/// shelf being filled go here before a new page is opened.
#[derive(Clone, Copy)]
struct Hole {
    layer: u32,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
}

/// Shelf packing into `PAGE`-sized layers, tallest images first, continuing at `cursor`.
/// An image that fits neither the shelf being filled nor the next one takes the best-fitting
/// free space an earlier page left (`cursor.holes`) before a new page is opened: a 4K picture
/// leaves strips beside and below it, which a document of many large pictures would
/// otherwise leave empty in every page (video memory is allocated per page).
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
    let Cursor { mut layer, mut x, mut y, mut shelf, mut used, .. } = *cursor;
    let mut holes = std::mem::take(&mut cursor.holes);
    let keep = |holes: &mut Vec<Hole>, hole: Hole| {
        if hole.w > 0 && hole.h > 0 {
            holes.push(hole);
        }
    };
    for i in order {
        let (sw, sh) = sizes[i].unwrap();
        let (w, h) = fit(sw, sh);
        let (cw, ch) = (w + 2 * gutter, h + 2 * gutter);
        let (at_layer, at_x, at_y);
        if used && x + cw <= PAGE && y + ch <= PAGE {
            (at_layer, at_x, at_y) = (layer, x, y);
            x += cw;
            shelf = shelf.max(ch);
        } else if !used || (x + cw > PAGE && y + shelf + ch <= PAGE) {
            // The next shelf of this page (the first, for the first image).
            if used {
                keep(&mut holes, Hole { layer, x, y, w: PAGE - x, h: shelf });
                y += shelf;
            }
            (at_layer, at_x, at_y) = (layer, 0, y);
            x = cw;
            shelf = ch;
            used = true;
        } else if let Some(index) = best_hole(&holes, cw, ch) {
            let hole = holes.swap_remove(index);
            (at_layer, at_x, at_y) = (hole.layer, hole.x, hole.y);
            keep(&mut holes, Hole { layer: hole.layer, x: hole.x + cw, y: hole.y, w: hole.w - cw, h: ch });
            keep(&mut holes, Hole { layer: hole.layer, x: hole.x, y: hole.y + ch, w: hole.w, h: hole.h - ch });
        } else {
            // A new page; what the old one has left stays available.
            keep(&mut holes, Hole { layer, x, y, w: PAGE - x, h: PAGE - y });
            keep(&mut holes, Hole { layer, x: 0, y: y + shelf, w: x, h: PAGE - y - shelf });
            layer += 1;
            (at_layer, at_x, at_y) = (layer, 0, 0);
            x = cw;
            y = 0;
            shelf = ch;
        }
        entries[i] = AtlasEntry { layer: at_layer, x: at_x + gutter, y: at_y + gutter, w, h, source_w: sw, source_h: sh, valid: true };
    }
    *cursor = Cursor { layer, x, y, shelf, used, holes };
}

/// The free space that takes `cw` by `ch` with the least left over its shorter side (the
/// earliest page, then the topmost, on a tie).
fn best_hole(holes: &[Hole], cw: u32, ch: u32) -> Option<usize> {
    holes
        .iter()
        .enumerate()
        .filter(|(_, hole)| hole.w >= cw && hole.h >= ch)
        .min_by_key(|(_, hole)| ((hole.w - cw).min(hole.h - ch), hole.layer, hole.y, hole.x))
        .map(|(index, _)| index)
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
    /// The soft copy of an image of the document ([`soften_image`]) instead of the image: `width` by `height` texels
    /// of the soft atlas at [`soft_rect`] of its place.
    pub soft: bool,
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
    /// The placement ([`Assets::placement`]) of the drawing cel the tile is of, 0 for a picture. A cel the document replaced gives its
    /// slots to the next, so a tile decoded for the one before must not be written once they are: the engine drops those.
    pub placement: u64,
}

/// Decodes a drawing cel into its atlas slots (every level, see [`crate::drawing`]).
pub fn decode_cel(assets: &Assets, cel: &Arc<DrawingTiles>) -> Vec<DecodedImage> {
    let Some(slots) = assets.cel_slots(cel) else { return Vec::new() };
    let placement = assets.placement(cel.key());
    let side = crate::drawing::TILE + 2 * crate::drawing::BORDER;
    crate::drawing::decode_cel(cel)
        .into_iter()
        .map(|(level, index, rgba)| DecodedImage { index: slots[level as usize][index as usize], drawing: true, soft: false, width: side, height: side, rgba, placement })
        .collect()
}

/// [`decode_cel`] for the tiles the cel's placement writes (`Assets::cel_dirty`): the whole cel when it writes it whole.
pub fn decode_cel_changed(assets: &Assets, cel: &Arc<DrawingTiles>) -> Vec<DecodedImage> {
    let Some(dirty) = assets.cel_dirty(cel.key()) else { return decode_cel(assets, cel) };
    let Some(slots) = assets.cel_slots(cel) else { return Vec::new() };
    let placement = assets.placement(cel.key());
    let side = crate::drawing::TILE + 2 * crate::drawing::BORDER;
    crate::drawing::decode_cel_dirty(cel, dirty)
        .into_iter()
        .map(|(level, index, rgba)| DecodedImage { index: slots[level as usize][index as usize], drawing: true, soft: false, width: side, height: side, rgba, placement })
        .collect()
}

/// One picture to decode: an image of the document, or a drawing cel (every display level of it).
#[derive(Clone, Copy, Debug)]
pub enum Picture {
    /// An index into `Document::images`.
    Image(usize),
    /// A drawing cel, by its key in [`Assets::cels`].
    Cel(usize),
    /// The tiles of a drawing cel that its placement writes ([`Assets::cel_dirty`]): the others are in the slots of the cel it replaced.
    /// The whole cel when its placement writes it whole.
    CelChanged(usize),
    /// The soft copy of an image of the document, without the image ([`soften_image`]).
    Soft(usize),
}

impl Assets {
    /// The pixels decoding `picture` produces, as far as is known without decoding it: its atlas places.
    pub fn picture_bytes(&self, picture: Picture) -> usize {
        match picture {
            Picture::Image(index) | Picture::Soft(index) => self.atlas.get(index).filter(|entry| entry.valid).map_or(0, |entry| (entry.w as usize + 2) * (entry.h as usize + 2) * 4),
            Picture::Cel(cel) => {
                let side = (crate::drawing::TILE + 2 * crate::drawing::BORDER) as usize;
                self.cels.get(&cel).map_or(0, |(tiles, _)| tiles.levels.iter().map(Vec::len).sum::<usize>() * side * side * 4)
            }
            Picture::CelChanged(cel) => {
                let side = (crate::drawing::TILE + 2 * crate::drawing::BORDER) as usize;
                let tiles = match self.cel_dirty(cel) {
                    Some(dirty) => dirty.iter().flatten().filter(|dirty| **dirty).count(),
                    None => self.cels.get(&cel).map_or(0, |(tiles, _)| tiles.levels.iter().map(Vec::len).sum::<usize>()),
                };
                tiles * side * side * 4
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
        Picture::Soft(index) => {
            let _working = styk_alloc::reserve(soften_working_bytes(assets, index))?;
            Ok(soften_image(doc, assets, index).into_iter().collect())
        }
        Picture::Cel(cel) => {
            let Some((tiles, _)) = assets.cels.get(&cel) else { return Ok(Vec::new()) };
            let _working = styk_alloc::reserve(3 * assets.picture_bytes(picture))?;
            Ok(decode_cel(assets, tiles))
        }
        Picture::CelChanged(cel) => {
            let Some((tiles, _)) = assets.cels.get(&cel) else { return Ok(Vec::new()) };
            // The tiles written, their neighbours and what they are reduced from: a dozen times what is written, at the most the whole cel.
            let whole = assets.picture_bytes(Picture::Cel(cel));
            let _working = styk_alloc::reserve(3 * assets.picture_bytes(picture).saturating_mul(12).min(whole))?;
            Ok(decode_cel_changed(assets, tiles))
        }
    }
}

/// The most memory [`decode_image`] reserves: the picture decoded at its own size (twice: the decoder keeps its own
/// copy), then resized and bordered at the size of its atlas place (twice). An upper bound: a picture at its atlas size
/// in 8-bit RGB or RGBA holds its stored size alone. Zero for an image without one.
pub fn decode_image_working_bytes(assets: &Assets, index: usize) -> usize {
    let Some(entry) = assets.atlas.get(index).filter(|entry| entry.valid) else { return 0 };
    let source = entry.source_w as usize * entry.source_h as usize * 4;
    let stored = (entry.w as usize + 2) * (entry.h as usize + 2) * 4;
    2 * source + 2 * stored
}

/// The soft atlas texels the soft copy of the picture at `entry` covers: `(x, y, width, height)`. Every texel of the
/// rectangle covers at least one pixel of the picture, so a soft texel is the average of the picture's pixels it covers.
pub fn soft_rect(entry: &AtlasEntry) -> (u32, u32, u32, u32) {
    let (x0, y0) = (entry.x / SOFT_SCALE, entry.y / SOFT_SCALE);
    let (x1, y1) = ((entry.x + entry.w - 1) / SOFT_SCALE, (entry.y + entry.h - 1) / SOFT_SCALE);
    (x0, y0, x1 - x0 + 1, y1 - y0 + 1)
}

/// The most memory [`soften_image`] reserves: what decoding the picture takes ([`decode_image_working_bytes`]) and the
/// soft copy. Zero for an image without a place.
pub fn soften_working_bytes(assets: &Assets, index: usize) -> usize {
    let Some(entry) = assets.atlas.get(index).filter(|entry| entry.valid) else { return 0 };
    decode_image_working_bytes(assets, index) + (entry.w as usize / SOFT_SCALE as usize + 2) * (entry.h as usize / SOFT_SCALE as usize + 2) * 4
}

/// The soft copy of image `index`: the picture's premultiplied pixels averaged over the `SOFT_SCALE` × `SOFT_SCALE`
/// blocks of its atlas page (so it lines up with the picture whatever its place), the rest of the pixels dropped.
/// `None` when the image has no place in the atlas or cannot be decoded.
pub fn soften_image(doc: &Document, assets: &Assets, index: usize) -> Option<DecodedImage> {
    let data = doc.images.get(index)?;
    let entry = assets.atlas.get(index).filter(|entry| entry.valid)?;
    // The stored picture (premultiplied, with its gutter) is the only buffer of the picture's size: decoding it as
    // [`decode_image`] does holds no more than a picture that is kept whole does.
    let stored = stored_pixels(&data.bytes, data.color_key, (entry.w, entry.h))?;
    let (sx0, sy0, sw, sh) = soft_rect(entry);
    let mut out = Vec::new();
    out.try_reserve_exact((sw * sh * 4) as usize).ok()?;
    out.resize((sw * sh * 4) as usize, 0u8);
    let row = entry.w as usize + 2;
    for sy in 0..sh {
        // The rows of the picture in this block of the page.
        let top = ((sy0 + sy) * SOFT_SCALE).max(entry.y) - entry.y;
        let bottom = ((sy0 + sy + 1) * SOFT_SCALE).min(entry.y + entry.h) - entry.y;
        for sx in 0..sw {
            let left = ((sx0 + sx) * SOFT_SCALE).max(entry.x) - entry.x;
            let right = ((sx0 + sx + 1) * SOFT_SCALE).min(entry.x + entry.w) - entry.x;
            let mut sum = [0u32; 4];
            for y in top..bottom {
                for x in left..right {
                    // One texel in for the gutter.
                    let at = ((y as usize + 1) * row + x as usize + 1) * 4;
                    for k in 0..4 {
                        sum[k] += stored[at + k] as u32;
                    }
                }
            }
            let n = ((bottom - top) * (right - left)).max(1);
            let o = ((sy * sw + sx) * 4) as usize;
            for k in 0..4 {
                out[o + k] = ((sum[k] + n / 2) / n) as u8;
            }
        }
    }
    Some(DecodedImage { index: index as u32, drawing: false, soft: true, width: sw, height: sh, rgba: out, placement: 0 })
}

/// Decodes image `index` of `doc` for the atlas `assets` laid out. `None` when the
/// image has no place in the atlas or cannot be decoded.
pub fn decode_image(doc: &Document, assets: &Assets, index: usize) -> Option<DecodedImage> {
    let data = doc.images.get(index)?;
    let entry = assets.atlas.get(index).filter(|entry| entry.valid)?;
    let rgba = stored_pixels(&data.bytes, data.color_key, (entry.w, entry.h))?;
    Some(DecodedImage { index: index as u32, drawing: false, soft: false, width: entry.w + 2, height: entry.h + 2, rgba, placement: 0 })
}

/// The stored pixels of an encoded picture of `size`: premultiplied RGBA with a one-pixel gutter that repeats its
/// edges, the colour key made transparent, the picture resized when it is not that size already.
///
/// A picture the atlas keeps at its own size, in 8-bit RGB or RGBA (a PNG, a JPEG, a BMP, a GIF), is decoded into the
/// end of its final buffer and bordered there ([`border_in_place`]), so the buffer of the stored size is the only
/// one of that size that exists; decoding, converting and bordering made three (tdd2's 4K pictures, decoded two at a
/// time, held 300 MiB more than the document while it opened). Any other picture takes the general path.
fn stored_pixels(bytes: &[u8], color_key: Option<[u8; 3]>, size: (u32, u32)) -> Option<Vec<u8>> {
    let (w, h) = (size.0 as usize, size.1 as usize);
    let stored = (w + 2).checked_mul(h + 2)?.checked_mul(4)?;
    // The one allocation of the picture's size that is not the decoder's: a failure is a picture that cannot be shown.
    let mut out = Vec::new();
    out.try_reserve_exact(stored).ok()?;
    out.resize(stored, 0u8);
    if let Some(channels) = read_into_tail(bytes, size, &mut out) {
        border_in_place(&mut out, (w, h), channels, color_key);
        return Some(out);
    }
    let mut rgba = image::load_from_memory(bytes).ok()?.into_rgba8();
    if let Some(key) = color_key {
        for pixel in rgba.pixels_mut() {
            if pixel[0] == key[0] && pixel[1] == key[1] && pixel[2] == key[2] {
                pixel[3] = 0;
            }
        }
    }
    let start = stored - w * h * 4;
    if rgba.dimensions() == size {
        out[start..].copy_from_slice(rgba.as_raw());
    } else {
        resize_triangle(rgba.as_raw(), rgba.dimensions(), size, &mut out[start..]);
    }
    drop(rgba);
    border_in_place(&mut out, (w, h), 4, None);
    Some(out)
}

/// `image::imageops::resize` with the triangle filter, result for result, for 8-bit RGBA: `from` is the decoded picture,
/// `to` the pixels at `size`. The library resizes in two whole-picture passes with a float picture of the source's
/// width and the new height between them (129 MiB for a 4096 x 2160 picture, on top of the picture and its resize);
/// the passes are separable by row, so this does both for one output row at a time and the float row is the only
/// intermediate. The weights, their order of summing and the rounding are the library's.
fn resize_triangle(from: &[u8], (sw, sh): (u32, u32), (dw, dh): (u32, u32), to: &mut [u8]) {
    // A picture with a zero side (a header that claims one) has nothing to sample: the library gives a blank picture.
    if sw == 0 || sh == 0 {
        to.fill(0);
        return;
    }
    fn weights(source: u32, target: u32, at: u32) -> (usize, Vec<f32>) {
        let ratio = source as f32 / target as f32;
        let sratio = if ratio < 1.0 { 1.0 } else { ratio };
        let support = sratio;
        let center = (at as f32 + 0.5) * ratio;
        let left = ((center - support).floor() as i64).clamp(0, source as i64 - 1);
        let right = ((center + support).ceil() as i64).clamp(left + 1, source as i64);
        let center = center - 0.5;
        let mut weights = Vec::with_capacity((right - left) as usize);
        let mut sum = 0.0f32;
        for i in left..right {
            let x = (i as f32 - center) / sratio;
            let weight = if x.abs() < 1.0 { 1.0 - x.abs() } else { 0.0 };
            weights.push(weight);
            sum += weight;
        }
        for weight in weights.iter_mut() {
            *weight /= sum;
        }
        (left as usize, weights)
    }
    let (sw, dw) = (sw as usize, dw as usize);
    let across: Vec<(usize, Vec<f32>)> = (0..dw as u32).map(|x| weights(sw as u32, dw as u32, x)).collect();
    let mut row = vec![0.0f32; sw * 4];
    for y in 0..dh {
        let (top, down) = weights(sh, dh, y);
        for x in 0..sw {
            let mut t = [0.0f32; 4];
            for (i, w) in down.iter().enumerate() {
                let at = ((top + i) * sw + x) * 4;
                for channel in 0..4 {
                    t[channel] += from[at + channel] as f32 * w;
                }
            }
            row[x * 4..x * 4 + 4].copy_from_slice(&t);
        }
        for (x, (left, ws)) in across.iter().enumerate() {
            let mut t = [0.0f32; 4];
            for (i, w) in ws.iter().enumerate() {
                let at = (left + i) * 4;
                for channel in 0..4 {
                    t[channel] += row[at + channel] * w;
                }
            }
            let o = (y as usize * dw + x) * 4;
            for channel in 0..4 {
                let value = if t[channel] < 0.0 { 0.0 } else if t[channel] > 255.0 { 255.0 } else { t[channel] };
                to[o + channel] = value.round() as u8;
            }
        }
    }
}

/// Decodes `bytes` into the end of `out` (a buffer of the stored size) when the picture is 8-bit RGB or RGBA of
/// exactly `size`: the channels it has. `None` leaves the picture to the general path.
fn read_into_tail(bytes: &[u8], size: (u32, u32), out: &mut [u8]) -> Option<usize> {
    use image::ImageDecoder;
    let decoder = image::ImageReader::new(std::io::Cursor::new(bytes)).with_guessed_format().ok()?.into_decoder().ok()?;
    let channels = match decoder.color_type() {
        image::ColorType::Rgb8 => 3,
        image::ColorType::Rgba8 => 4,
        _ => return None,
    };
    let length = size.0 as usize * size.1 as usize * channels;
    if decoder.dimensions() != size || decoder.total_bytes() != length as u64 {
        return None;
    }
    let start = out.len().checked_sub(length)?;
    decoder.read_image(&mut out[start..]).ok()?;
    Some(channels)
}

/// Turns the `w` x `h` picture held in the last `w * h * channels` bytes of `out` into the stored picture that
/// fills it: premultiplied RGBA with a one-pixel gutter that repeats the edges, the pixels of `color_key`
/// transparent. Pixels are written in order and never reach a pixel still to be read: each stored row starts
/// before the source row it reads (`4 * (w + 2)` against `channels * w` bytes a row), and the last stored rows,
/// which read the last source row again, stay a pixel behind it.
fn border_in_place(out: &mut [u8], (w, h): (usize, usize), channels: usize, color_key: Option<[u8; 3]>) {
    let (gw, gh) = (w + 2, h + 2);
    let base = out.len() - w * h * channels;
    for gy in 0..gh {
        let sy = gy.saturating_sub(1).min(h - 1);
        for gx in 0..gw {
            let sx = gx.saturating_sub(1).min(w - 1);
            let s = base + (sy * w + sx) * channels;
            let (r, g, b) = (out[s] as u32, out[s + 1] as u32, out[s + 2] as u32);
            let keyed = color_key.is_some_and(|key| out[s] == key[0] && out[s + 1] == key[1] && out[s + 2] == key[2]);
            let a = if keyed { 0 } else if channels == 4 { out[s + 3] as u32 } else { 255 };
            let o = (gy * gw + gx) * 4;
            out[o] = ((r * a + 127) / 255) as u8;
            out[o + 1] = ((g * a + 127) / 255) as u8;
            out[o + 2] = ((b * a + 127) / 255) as u8;
            out[o + 3] = a as u8;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The pixels a picture stored before it was decoded into its final buffer: decode, convert, key, resize, then
    /// border into a buffer of their own.
    fn stored_reference(bytes: &[u8], color_key: Option<[u8; 3]>, size: (u32, u32)) -> Vec<u8> {
        let mut rgba = image::load_from_memory(bytes).unwrap().to_rgba8();
        if let Some(key) = color_key {
            for pixel in rgba.pixels_mut() {
                if pixel[0] == key[0] && pixel[1] == key[1] && pixel[2] == key[2] {
                    pixel[3] = 0;
                }
            }
        }
        if rgba.width() != size.0 || rgba.height() != size.1 {
            rgba = image::imageops::resize(&rgba, size.0, size.1, image::imageops::FilterType::Triangle);
        }
        let (w, h) = (size.0 as usize, size.1 as usize);
        let (gw, gh) = (w + 2, h + 2);
        let mut out = vec![0u8; gw * gh * 4];
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
        out
    }

    /// Pixels with every alpha, and some of the colour key.
    fn noise(count: usize, seed: u32) -> Vec<u8> {
        let mut state = seed;
        (0..count)
            .map(|_| {
                state = state.wrapping_mul(1664525).wrapping_add(1013904223);
                match state >> 29 {
                    0 => 0,
                    1 => 255,
                    _ => (state >> 16) as u8,
                }
            })
            .collect()
    }

    fn encoded(pixels: Vec<u8>, size: (u32, u32), color: image::ExtendedColorType) -> Vec<u8> {
        use image::ImageEncoder;
        let mut bytes = Vec::new();
        image::codecs::png::PngEncoder::new(&mut bytes).write_image(&pixels, size.0, size.1, color).unwrap();
        bytes
    }

    #[test]
    fn a_picture_decoded_into_its_final_buffer_is_the_picture_the_three_buffers_made() {
        let sizes = [(1, 1), (1, 6), (6, 1), (2, 2), (3, 7), (8, 8), (33, 17), (64, 5)];
        for (n, &size) in sizes.iter().enumerate() {
            let count = size.0 as usize * size.1 as usize;
            for (kind, channels, color) in [("rgb", 3, image::ExtendedColorType::Rgb8), ("rgba", 4, image::ExtendedColorType::Rgba8)] {
                let mut pixels = noise(count * channels, n as u32 + 1);
                // The key colour appears in the picture.
                for pixel in pixels.chunks_mut(channels).step_by(3) {
                    pixel[..3].copy_from_slice(&[10, 200, 30]);
                }
                let bytes = encoded(pixels, size, color);
                for key in [None, Some([10, 200, 30]), Some([1, 2, 3])] {
                    assert_eq!(stored_pixels(&bytes, key, size).unwrap(), stored_reference(&bytes, key, size), "{kind} {size:?} {key:?}");
                }
            }
        }
    }

    #[test]
    fn a_resized_picture_is_the_library_resize_to_the_byte() {
        for (from, to) in [((64, 48), (7, 5)), ((64, 48), (63, 49)), ((13, 29), (13, 3)), ((13, 29), (40, 29)), ((100, 7), (3, 7)), ((1, 1), (5, 4)), ((37, 41), (1, 2))] {
            let pixels = noise(from.0 as usize * from.1 as usize * 4, from.0 * 31 + from.1);
            let source = image::RgbaImage::from_raw(from.0, from.1, pixels).unwrap();
            let library = image::imageops::resize(&source, to.0, to.1, image::imageops::FilterType::Triangle);
            let mut ours = vec![0u8; to.0 as usize * to.1 as usize * 4];
            resize_triangle(source.as_raw(), from, to, &mut ours);
            assert_eq!(library.as_raw(), &ours, "{from:?} to {to:?}");
        }
    }

    #[test]
    fn a_picture_with_a_zero_side_is_blank_not_a_panic() {
        // A 9 x 0 GIF: the atlas raises the side to 1 and takes a 9 x 1 place for it; the decoder gives nothing to sample.
        let hex = "4749463839610900000082000052ccbd40cec80ac81ed6ba5ca05e44d107f900000000000021f904010000d8002c000000000900010000080d000308104040c00003000a0404003b";
        let bytes: Vec<u8> = (0..hex.len()).step_by(2).map(|at| u8::from_str_radix(&hex[at..at + 2], 16).unwrap()).collect();
        assert_eq!(bytes.len(), 72);
        for key in [None, Some([0, 0, 0])] {
            assert_eq!(stored_pixels(&bytes, key, (9, 1)).unwrap(), vec![0u8; 11 * 3 * 4], "{key:?}");
        }
    }

    #[test]
    fn pictures_that_are_not_8_bit_rgb_or_at_their_atlas_size_keep_their_stored_pixels() {
        let size = (9, 5);
        let count = size.0 as usize * size.1 as usize;
        let grey = encoded(noise(count, 7), size, image::ExtendedColorType::L8);
        let wide = encoded(noise(count * 8, 8), size, image::ExtendedColorType::Rgba16);
        let rgba = encoded(noise(count * 4, 9), size, image::ExtendedColorType::Rgba8);
        for bytes in [&grey, &wide] {
            assert_eq!(stored_pixels(bytes, None, size).unwrap(), stored_reference(bytes, None, size), "decoded and converted");
        }
        for target in [(4, 3), (20, 11), (9, 2), (3, 5), (9, 11), (1, 1), (40, 1), (2, 40)] {
            assert_eq!(stored_pixels(&rgba, Some([0, 0, 0]), target).unwrap(), stored_reference(&rgba, Some([0, 0, 0]), target), "resized to {target:?}");
        }
        assert!(stored_pixels(b"not a picture", None, size).is_none());
    }

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

    /// Every stored rectangle with its gutter, as (layer, x0, y0, x1, y1).
    fn rectangles(entries: &[AtlasEntry]) -> Vec<(u32, u32, u32, u32, u32)> {
        entries.iter().filter(|e| e.valid).map(|e| (e.layer, e.x - GUTTER, e.y - GUTTER, e.x + e.w + GUTTER, e.y + e.h + GUTTER)).collect()
    }

    fn assert_disjoint_within_pages(entries: &[AtlasEntry]) {
        let rects = rectangles(entries);
        for (i, a) in rects.iter().enumerate() {
            assert!(a.3 <= PAGE && a.4 <= PAGE, "rectangle {i} leaves its page: {a:?}");
            for (j, b) in rects.iter().enumerate().skip(i + 1) {
                let apart = a.0 != b.0 || a.3 <= b.1 || b.3 <= a.1 || a.4 <= b.2 || b.4 <= a.2;
                assert!(apart, "rectangles {i} and {j} overlap: {a:?} {b:?}");
            }
        }
    }

    #[test]
    fn smaller_images_fill_the_strips_large_pictures_leave_on_earlier_pages() {
        // Four 4K pictures take a page each (a second one fits neither beside nor below the first);
        // the smaller images then go into the strips of those pages instead of opening new ones.
        let mut sizes: Vec<Option<(u32, u32)>> = vec![Some((3840, 2160)); 4];
        sizes.extend(vec![Some((1500, 1500)); 6]);
        let mut entries = vec![AtlasEntry::default(); sizes.len()];
        pack(&sizes, &mut entries, &mut Cursor::default(), GUTTER);
        assert_disjoint_within_pages(&entries);
        let pages = entries.iter().map(|e| e.layer).max().unwrap() + 1;
        assert_eq!(pages, 4, "the shelf packer alone needed five pages for these");
        for (entry, size) in entries.iter().zip(&sizes) {
            let (w, h) = size.unwrap();
            assert_eq!([entry.w, entry.h, entry.source_w, entry.source_h], [w, h, w, h], "packing never resizes an image that fits a page");
        }
    }

    #[test]
    fn images_added_later_take_free_space_without_moving_earlier_ones() {
        let mut entries = vec![AtlasEntry::default(); 6];
        let mut cursor = Cursor::default();
        pack(&[Some((3840, 2160)); 3], &mut entries[..3], &mut cursor, GUTTER);
        let placed: Vec<_> = entries[..3].iter().map(|e| (e.layer, e.x, e.y)).collect();
        pack(&[Some((1500, 1500)); 3], &mut entries[3..], &mut cursor, GUTTER);
        assert_eq!(entries[..3].iter().map(|e| (e.layer, e.x, e.y)).collect::<Vec<_>>(), placed);
        assert_disjoint_within_pages(&entries);
        assert_eq!(entries.iter().map(|e| e.layer).max().unwrap() + 1, 3, "the later images use the strips of the first pages");
    }

    #[test]
    fn a_layout_within_one_page_is_the_shelf_layout() {
        let sizes: Vec<Option<(u32, u32)>> = vec![Some((1000, 700)), Some((900, 700)), Some((2000, 500)), Some((300, 200))];
        let mut entries = vec![AtlasEntry::default(); sizes.len()];
        pack(&sizes, &mut entries, &mut Cursor::default(), GUTTER);
        // Tallest first, shelves left to right: the layout the packer always made.
        let at: Vec<_> = entries.iter().map(|e| (e.layer, e.x, e.y)).collect();
        assert_eq!(at, vec![(0, 1, 1), (0, 1003, 1), (0, 1905, 1), (0, 1, 703)]);
    }
}
