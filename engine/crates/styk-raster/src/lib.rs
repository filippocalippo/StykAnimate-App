//! CPU rasterizer for StykAnimate draw lists: the GPU renderer's pipeline (styk-render)
//! carried out on the CPU, so a frame drawn here is the frame the stage, thumbnails and
//! exports draw on a GPU. For devices with neither WebGPU nor WebGL2 (thumbnails, library
//! previews and exports in the app) and for tools (`styk raster`, `styk export --cpu`).
//!
//! It follows styk-render rule for rule:
//!
//! * **Layers**: every isolation group is drawn where styk-render's plan puts it for the
//!   view (`styk_render::effects::plan` and `record`, built without the `gpu` feature):
//!   translucent figures on their parent's grid, raster entries (text, 3D artwork) and
//!   filtered artwork on the editor's raster grid at its density, the camera image through
//!   the scene camera. Each into a target of its own, composited at its place in painter
//!   order, sampled bilinearly (to the nearest texel with crisp edges).
//! * **Samples** (`target`, `coverage`): four a pixel at the standard positions of 4×
//!   multisampling (one at the centre for crisp edges), each blended on its own in RGBA8 and
//!   averaged when resolved; triangles and quads covered by the GPU's rasterization rules
//!   (sub-pixel snapping, the top-left rule), so meshes, glyph fans and adjacent polygons
//!   show no seams.
//! * **Shapes** (`shade`, `frame`): strokes, arcs, polylines, discs and rings covered by
//!   distance at each pixel's centre as `prim.wgsl` covers them; custom paints shaded by
//!   [`styk_draw::sample_paint`]; sprites, drawing cels and backgrounds sampled as the GPU
//!   samples them.
//! * **3D faces**: depth runs depth tested per sample at 24 bits, a face drawn over what
//!   is there when it is not behind it (`less-equal`), as the GPU's depth test does.
//! * **Lone glyphs** (`glyphs`): from masks filled at four samples a texel for the view's
//!   raster density, kept across frames within a budget; their triangles where the view
//!   allows no mask.
//! * **Generated effects** (`generators`): the GPU's quads, shaded by its fragment arithmetic.
//! * **Filter effects** (`effects`): each layer's effect recipe
//!   (`styk_render::effects::recipe`) run pass by pass with the arithmetic of `passes.wgsl`.
//!
//! A [`Raster`] keeps what outlives a frame (glyph masks); [`render`] draws one frame alone.
//! Nothing here blocks on a lock or a thread: callers run it where it may take its time
//! (a worker, a tool).

mod coverage;
mod effects;
mod frame;
mod generators;
mod glyphs;
mod shade;
mod target;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use styk_draw::{DrawList, F_DRAWING, K_BG_IMAGE, K_IMAGE, NO_PAINT};
use styk_eval::assets::{Assets, DecodedImage, PAGE, Picture};
use styk_eval::doc::Document;

pub use frame::Stats;
pub use styk_render::{DrawingGrid, Edges, ViewParams};
pub use styk_render::paint::PaintContext;

use shade::Texture;

/// An atlas place by the key the rasterizer samples it with: its page and corner.
type Key = (u32, u32, u32);

/// A picture the rasterizer samples: a sprite or a background (`false`), or a drawing cel tile (`true`), by its place.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Place(bool, Key);

/// A decoded picture and when it was last asked for.
#[derive(Clone)]
struct Held {
    image: Arc<DecodedImage>,
    used: u64,
}

/// Decoded pixels of a document's images, keyed by their atlas place (the draw list
/// addresses images by atlas rectangle, as the GPU samples them). The decoded images are
/// shared, not copied.
///
/// The pixels held are bounded: beyond the budget (a sixteenth of the memory the module may use,
/// [`Images::MEMORY_SHARE`]) the least recently used are dropped, and [`Images::ensure`] decodes
/// again, from the document's encoded pictures, what a frame needs and is not held. A frame is never
/// drawn short of a picture because of the budget: what it samples is kept while it is drawn.
///
/// A clone shares the decoded pixels (it copies the tables of which picture is where), so a set the threads drawing
/// a frame read can be taken further for the next frame without waiting for them.
#[derive(Clone)]
pub struct Images {
    /// Premultiplied sprites with their one-texel gutter repeating their edges.
    sprites: HashMap<Key, Held>,
    /// Drawing cel tiles: straight alpha, with a two-texel border of neighbouring texels.
    tiles: HashMap<Key, Held>,
    budget: usize,
    bytes: usize,
    clock: u64,
    /// Pictures that could not be decoded (a damaged file): not tried again while the atlas is the one they were
    /// tried against (its size: a later revision may place more).
    failed: HashSet<Place>,
    failed_in: (usize, usize),
}

impl Default for Images {
    fn default() -> Images {
        Images::with_budget(styk_alloc::ceiling() / Images::MEMORY_SHARE)
    }
}

impl Images {
    /// The decoded pixels kept may take a sixteenth of the memory the module may use (128 MiB of 2 GiB).
    pub const MEMORY_SHARE: usize = 16;

    /// Pictures that hold at most `budget` bytes of pixels beyond what a frame being drawn samples.
    pub fn with_budget(budget: usize) -> Images {
        Images { sprites: HashMap::new(), tiles: HashMap::new(), budget, bytes: 0, clock: 0, failed: HashSet::new(), failed_in: (0, 0) }
    }

    /// Adds a decoded image (`styk_eval::assets::decode_image` / `decode_cel`), copied.
    pub fn add(&mut self, assets: &Assets, image: &DecodedImage) {
        self.add_shared(assets, Arc::new(DecodedImage { index: image.index, drawing: image.drawing, soft: image.soft, width: image.width, height: image.height, rgba: image.rgba.clone(), placement: image.placement }));
    }

    /// Adds a decoded image the engine already holds. Over the budget, the least recently used are dropped.
    pub fn add_shared(&mut self, assets: &Assets, image: Arc<DecodedImage>) {
        self.insert(assets, image);
        self.trim(&HashSet::new());
    }

    fn insert(&mut self, assets: &Assets, image: Arc<DecodedImage>) {
        let entry = if image.drawing { assets.drawing.get(image.index as usize) } else { assets.atlas.get(image.index as usize) };
        let Some(e) = entry.filter(|e| e.valid) else { return };
        if image.rgba.len() < image.width as usize * image.height as usize * 4 || image.width == 0 || image.height == 0 {
            return;
        }
        let key = (e.layer, e.x, e.y);
        self.clock += 1;
        let held = Held { used: self.clock, image };
        let len = held.image.rgba.len();
        let replaced = if held.image.drawing { self.tiles.insert(key, held) } else { self.sprites.insert(key, held) };
        self.bytes += len;
        if let Some(old) = replaced {
            self.bytes -= old.image.rgba.len();
        }
    }

    /// Puts the drawing tile `image` (straight alpha with its two-texel border, `styk_eval::live::CELL` texels a side) at
    /// atlas place `(layer, x, y)` (its first texel inside the border): the slots of the drawing cels the editor holds live,
    /// which the document's atlas does not lay out. Over the budget, the least recently used pictures are dropped.
    pub fn put_tile(&mut self, place: (u32, u32, u32), image: Arc<DecodedImage>) {
        self.clock += 1;
        let len = image.rgba.len();
        if let Some(old) = self.tiles.insert(place, Held { used: self.clock, image }) {
            self.bytes -= old.image.rgba.len();
        }
        self.bytes += len;
        self.trim(&HashSet::new());
    }

    /// Lets go of the drawing tiles on atlas layers `layer` and above (the live cels' pages, when they move).
    pub fn drop_tiles_from(&mut self, layer: u32) {
        let mut freed = 0;
        self.tiles.retain(|key, held| {
            let keep = key.0 < layer;
            if !keep {
                freed += held.image.rgba.len();
            }
            keep
        });
        self.bytes -= freed;
    }

    pub fn len(&self) -> usize {
        self.sprites.len() + self.tiles.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Bytes of the pixels held.
    pub fn bytes(&self) -> usize {
        self.bytes
    }

    /// Shared decoded pixels, for an auxiliary GPU view using the same image owner.
    /// Iteration borrows the pixels; rebuilding an atlas does not make a second cache.
    pub fn decoded(&self) -> impl Iterator<Item = &DecodedImage> {
        self.sprites.values().chain(self.tiles.values()).map(|held| held.image.as_ref())
    }

    /// The decoded picture at `place`, if it is held.
    pub fn get(&self, place: Place) -> Option<&Arc<DecodedImage>> {
        let held = if place.0 { self.tiles.get(&place.1) } else { self.sprites.get(&place.1) };
        held.map(|held| &held.image)
    }

    /// The places a list samples: its images, backgrounds and drawing cel tiles, and the parent tile a drawing
    /// cel blends in inside a layer the editor paints with Canvas 2D.
    pub fn places(list: &DrawList) -> HashSet<Place> {
        let mut places = HashSet::new();
        for p in &list.prims {
            match p.kind & 255 {
                K_IMAGE => {
                    let drawing = p.kind & F_DRAWING != 0;
                    places.insert(Place(drawing, atlas_key(p.b[2], p.c)));
                    if drawing && p.paint != NO_PAINT
                        && let Some(row) = list.paints.get(p.paint as usize)
                    {
                        places.insert(Place(true, (row[0] as u32, row[1] as u32, row[2] as u32)));
                    }
                }
                K_BG_IMAGE => {
                    places.insert(Place(false, atlas_key(p.a[2], p.c)));
                }
                _ => {}
            }
        }
        places
    }

    /// Makes the pictures `list` samples available: the ones not held (dropped to stay in the budget, or never
    /// taken) are decoded from `doc`, and the least recently used of the others are dropped to stay in it. An error
    /// says the memory cannot hold a picture: the frame would be drawn without it.
    pub fn ensure(&mut self, list: &DrawList, doc: &Document, assets: &Assets) -> Result<(), styk_alloc::OutOfMemory> {
        self.ensure_cancellable(list, doc, assets, &|| false)
    }
    pub fn ensure_cancellable(&mut self, list: &DrawList, doc: &Document, assets: &Assets, cancelled: &dyn Fn() -> bool) -> Result<(), styk_alloc::OutOfMemory> {
        let places = Images::places(list);
        if self.failed_in != (assets.atlas.len(), assets.drawing.len()) {
            self.failed.clear();
            self.failed_in = (assets.atlas.len(), assets.drawing.len());
        }
        self.clock += 1;
        let clock = self.clock;
        let mut missing = Vec::new();
        for &place in &places {
            let held = if place.0 { self.tiles.get_mut(&place.1) } else { self.sprites.get_mut(&place.1) };
            match held {
                // A tile of a cel the document replaced: its slot is another cel's now (`Assets::extended`), and what is held is the old cel's.
                Some(held) if place.0 && held.image.placement != 0 && !assets.holds_placement(held.image.placement) => {
                    if let Some(old) = self.tiles.remove(&place.1) {
                        self.bytes -= old.image.rgba.len();
                    }
                    missing.push(place);
                }
                Some(held) => held.used = clock,
                None if !self.failed.contains(&place) => missing.push(place),
                None => {}
            }
        }
        if !missing.is_empty() {
            let sources = sources(assets);
            let mut pictures: Vec<Picture> = Vec::new();
            for place in &missing {
                match sources.get(place) {
                    Some(picture) if !pictures.iter().any(|known| same(*known, *picture)) => pictures.push(*picture),
                    _ => {}
                }
            }
            for picture in pictures {
                if cancelled() { return Ok(()); }
                let decoded = styk_eval::assets::decode_picture_cancellable(doc, assets, picture, cancelled)?;
                if cancelled() { return Ok(()); }
                for image in decoded {
                    self.insert(assets, Arc::new(image));
                }
            }
            // A picture still not held cannot be decoded: it is not tried again.
            for place in missing {
                let held = if place.0 { self.tiles.contains_key(&place.1) } else { self.sprites.contains_key(&place.1) };
                if !held {
                    self.failed.insert(place);
                }
            }
        }
        self.trim(&places);
        Ok(())
    }

    /// Drops the least recently used pictures outside `keep` until the pixels held are under three quarters of the
    /// budget, when they are over it.
    fn trim(&mut self, keep: &HashSet<Place>) {
        if self.bytes <= self.budget {
            return;
        }
        let target = self.budget - self.budget / 4;
        let mut order: Vec<(u64, Place, usize)> = Vec::new();
        for (drawing, map) in [(false, &self.sprites), (true, &self.tiles)] {
            for (key, held) in map {
                let place = Place(drawing, *key);
                if !keep.contains(&place) {
                    order.push((held.used, place, held.image.rgba.len()));
                }
            }
        }
        order.sort_unstable_by_key(|(used, ..)| *used);
        for (_, place, len) in order {
            if self.bytes <= target {
                break;
            }
            if if place.0 { self.tiles.remove(&place.1) } else { self.sprites.remove(&place.1) }.is_some() {
                self.bytes -= len;
            }
        }
    }

    fn texture(image: &DecodedImage, straight: bool) -> Texture<'_> {
        Texture { width: image.width as usize, height: image.height as usize, data: image.rgba.as_chunks::<4>().0, straight }
    }

    pub(crate) fn sprite(&self, key: (u32, u32, u32)) -> Option<Texture<'_>> {
        self.sprites.get(&key).map(|held| Images::texture(&held.image, false))
    }

    pub(crate) fn tile(&self, key: (u32, u32, u32)) -> Option<Texture<'_>> {
        self.tiles.get(&key).map(|held| Images::texture(&held.image, true))
    }
}

/// What a device holds of the pictures of an atlas, by place: the placement ([`DecodedImage::placement`]) of the tile written there, 0 for a sprite.
/// A place is lacking when it holds nothing, or the tile of a cel that no longer has the slot.
#[derive(Default)]
pub struct Uploads(HashMap<Place, u64>);

impl Uploads {
    /// The device was allocated again, or the atlas laid out anew: it holds nothing.
    pub fn clear(&mut self) {
        self.0.clear();
    }

    /// The pictures of `places` that `images` holds and the device does not hold as they are now.
    pub fn lacking<'a>(&self, places: impl IntoIterator<Item = Place>, images: &'a Images) -> Vec<(Place, &'a Arc<DecodedImage>)> {
        places.into_iter().filter_map(|place| images.get(place).map(|image| (place, image))).filter(|(place, image)| self.0.get(place) != Some(&image.placement)).collect()
    }

    /// `images` were written to the device.
    pub fn record<'a>(&mut self, written: impl IntoIterator<Item = (Place, &'a Arc<DecodedImage>)>) {
        self.0.extend(written.into_iter().map(|(place, image)| (place, image.placement)));
    }
}

/// Whether two pictures are the same one.
fn same(a: Picture, b: Picture) -> bool {
    match (a, b) {
        (Picture::Image(a), Picture::Image(b)) | (Picture::Cel(a), Picture::Cel(b)) => a == b,
        _ => false,
    }
}

/// The picture that decodes into each atlas place `assets` lays out: a sprite for an image, every tile of a drawing
/// cel for the cel.
fn sources(assets: &Assets) -> HashMap<Place, Picture> {
    let mut sources = HashMap::new();
    for (index, entry) in assets.atlas.iter().enumerate().filter(|(_, entry)| entry.valid) {
        sources.insert(Place(false, (entry.layer, entry.x, entry.y)), Picture::Image(index));
    }
    for (cel, (_, slots)) in &assets.cels {
        for &slot in slots.iter().flatten() {
            if let Some(entry) = assets.drawing.get(slot as usize).filter(|entry| entry.valid) {
                sources.insert(Place(true, (entry.layer, entry.x, entry.y)), Picture::Cel(*cel));
            }
        }
    }
    sources
}

/// The atlas place a primitive's uv rectangle starts at.
pub(crate) fn atlas_key(layer: f32, uv: [f32; 4]) -> (u32, u32, u32) {
    let p = PAGE as f32;
    (layer.round() as u32, (uv[0] * p).round() as u32, (uv[1] * p).round() as u32)
}

/// A rasterized frame: premultiplied RGBA8 rows.
#[derive(Clone, Debug)]
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

impl Frame {
    /// Straight RGBA8 (encoders take straight alpha), rounded as exports round
    /// (`styk_export::pixels`: to nearest, halves up).
    pub fn straight(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.pixels.len());
        for p in self.pixels.as_chunks::<4>().0 {
            let a = p[3] as u32;
            if a == 0 {
                out.extend_from_slice(&[0; 4]);
                continue;
            }
            let c = |v: u8| ((2 * 255 * v as u32 + a) / (2 * a)).min(255) as u8;
            out.extend_from_slice(&[c(p[0]), c(p[1]), c(p[2]), p[3]]);
        }
        out
    }
}

/// A CPU renderer: draws frames as styk-render's `Renderer` does, keeping lone glyphs'
/// masks across frames.
pub struct Raster {
    edges: Edges,
    drawing_grid: DrawingGrid,
    paint_context: PaintContext,
    orientation: Option<[f64; 6]>,
    glyphs: glyphs::Masks,
    pub stats: Stats,
}

/// What the threads drawing one frame in bands of rows share ([`Raster::bands`]): the renderer's settings and each lone
/// glyph's mask for the frame's view, filled once. Each band is drawn as the whole frame draws those rows.
#[derive(Clone)]
pub struct Bands {
    edges: Edges,
    drawing_grid: DrawingGrid,
    paint_context: PaintContext,
    orientation: Option<[f64; 6]>,
    glyphs: Arc<[Option<glyphs::Placed>]>,
    glyph_stats: (u32, u32, usize),
}

impl Bands {
    /// Rows `y0 .. y0 + rows` of the frame of `list` seen through `view` at `size`: the same view moved up by `y0` pixels
    /// at the band's height (an export's tiles are drawn so too), each layer cropped to what reaches the band. `None` when
    /// `cancelled` says so on the way.
    #[allow(clippy::too_many_arguments)]
    pub fn render(&self, list: &DrawList, images: &Images, view: &ViewParams, size: [u32; 2], y0: u32, rows: u32, cancelled: &dyn Fn() -> bool) -> Option<(Frame, Stats)> {
        if cancelled() { return None; }
        let size = [size[0].max(1), rows.max(1)];
        let (view, orientation) = if y0 == 0 { (*view, self.orientation) } else { band_view(view, self.orientation, y0 as f64) };
        let crisp = self.edges == Edges::Crisp;
        let mut frame = frame::Frame::new(list, images, &view, size, crisp, &self.glyphs, self.drawing_grid, self.paint_context, orientation);
        frame.cancelled = cancelled;
        if cancelled() { return None; }
        let pixels = frame.draw();
        if cancelled() { return None; }
        let (glyph_masks, glyph_masks_filled, glyph_bytes) = self.glyph_stats;
        let stats = frame::Stats { glyph_masks, glyph_masks_filled, glyph_bytes, ..frame.stats };
        Some((Frame { width: size[0], height: size[1], pixels: pixels.into_flattened() }, stats))
    }
}

/// `view` (and the turned view's `orientation`) for the pixels from row `dy` on: everything on screen moved up by `dy`.
fn band_view(view: &ViewParams, orientation: Option<[f64; 6]>, dy: f64) -> (ViewParams, Option<[f64; 6]>) {
    let up = [1.0, 0.0, 0.0, 1.0, 0.0, -dy];
    let a = view.artboard;
    let moved = ViewParams { matrix: styk_eval::view::compose(up, view.matrix), artboard: [a[0], a[1] - dy, a[2], a[3] - dy], pan: [view.pan[0], view.pan[1] - dy], ..*view };
    // The turning happens on the frame's screen: on the band's, it is the frame's moved down, turned, and moved back up.
    let turned = orientation.map(|o| styk_eval::view::compose(up, styk_eval::view::compose(o, [1.0, 0.0, 0.0, 1.0, 0.0, dy])));
    (moved, turned)
}

impl Raster {
    pub fn new(edges: Edges) -> Raster {
        Raster { edges, drawing_grid: DrawingGrid::World, paint_context: PaintContext::Native, orientation: None, glyphs: glyphs::Masks::default(), stats: Stats::default() }
    }

    /// How this renderer covers edges.
    pub fn edges(&self) -> Edges {
        self.edges
    }

    /// Explicitly change edge coverage while retaining images and glyph masks.
    /// Ordinary rendering keeps the mode passed to [`Raster::new`].
    pub fn set_edges(&mut self, edges: Edges) { self.edges = edges; }

    /// Uses the same layer/filter owner with an explicit drawing pixel grid.
    /// Defaults to the GPU-compatible world grid.
    pub fn set_drawing_grid(&mut self, grid: DrawingGrid) { self.drawing_grid = grid; }

    /// Selects the host's root paint contract; Native is the default. This does
    /// not change isolated child rasterization or allocate another cache.
    pub fn set_paint_context(&mut self, context: PaintContext) { self.paint_context = context; }

    /// Turns and mirrors the workspace view as styk-render's `Renderer::set_orientation` does: `orientation` maps the
    /// upright view's screen pixels to the turned one's (`view.matrix` includes it already); the artboard, the root's
    /// fills and its clip follow the turned quad. `None` for the upright view.
    pub fn set_orientation(&mut self, orientation: Option<[f64; 6]>) { self.orientation = orientation; }

    /// What the bands of a frame of `list` seen through `view` share: the lone glyphs' masks for the view, filled now
    /// where no frame has yet (on the thread that asks: call it where the frame's work is done, not where it is shown).
    pub fn bands(&mut self, list: &DrawList, view: &ViewParams, cancelled: &dyn Fn() -> bool) -> Option<Bands> {
        let crisp = self.edges == Edges::Crisp;
        // Lone glyphs: the masks this view calls for (filled now when no frame has yet).
        let resolution = styk_render::effects::plan::raster_resolution(view.matrix[0].hypot(view.matrix[1]));
        let glyphs: Arc<[Option<glyphs::Placed>]> = if list.glyphs.is_empty() { Arc::from(Vec::new()) } else { Arc::from(self.glyphs.prepare(list, resolution, !crisp, cancelled)) };
        if cancelled() { return None; }
        Some(Bands { edges: self.edges, drawing_grid: self.drawing_grid, paint_context: self.paint_context, orientation: self.orientation, glyphs,
            glyph_stats: (self.glyphs.count() as u32, self.glyphs.filled, self.glyphs.bytes()) })
    }

    /// Draws `list` seen through `view` at `size`, with `images`.
    pub fn render(&mut self, list: &DrawList, images: &Images, view: &ViewParams, size: [u32; 2]) -> Frame {
        self.render_cancellable(list, images, view, size, &|| false).expect("uncancelled raster")
    }
    pub fn render_cancellable(&mut self, list: &DrawList, images: &Images, view: &ViewParams, size: [u32; 2], cancelled: &dyn Fn() -> bool) -> Option<Frame> {
        if cancelled() { return None; }
        let size = [size[0].max(1), size[1].max(1)];
        // The whole frame is the one band of all its rows.
        let (frame, stats) = self.bands(list, view, cancelled)?.render(list, images, view, size, 0, size[1], cancelled)?;
        self.stats = stats;
        Some(frame)
    }

    /// Lets go of the glyph masks kept between frames.
    pub fn release(&mut self) {
        self.glyphs = glyphs::Masks::default();
    }
}

/// Draws one frame of `list` seen through `view` at `size`, covering edges as `edges` says.
pub fn render(list: &DrawList, images: &Images, view: &ViewParams, size: [u32; 2], edges: Edges) -> Frame {
    Raster::new(edges).render(list, images, view, size)
}

/// Every image of `assets` decoded for the CPU (tools and exports).
pub fn decode_all(doc: &styk_eval::doc::Document, assets: &Assets) -> Images {
    let mut images = Images::default();
    for index in 0..doc.images.len() {
        if let Some(image) = styk_eval::assets::decode_image(doc, assets, index) {
            images.add_shared(assets, Arc::new(image));
        }
    }
    for (cel, _) in assets.cels.values() {
        for image in styk_eval::assets::decode_cel(assets, cel) {
            images.add_shared(assets, Arc::new(image));
        }
    }
    images
}
