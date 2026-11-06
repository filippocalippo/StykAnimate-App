//! The drawing raster engine as a WebAssembly module (docs/engine/drawing.md,
//! docs/engine/decisions/0017-drawing-raster-engine.md): `styk-drawing` behind the calls
//! the drawing workers make, for `src/engine/engine-drawing.mjs`.
//!
//! A separate module from the engine's: no threads, no shared memory, stable Rust. Every
//! drawing worker owns one instance; a worker is terminated to cancel its job, which a
//! thread of the engine's shared memory could not survive. Tiles come in through [`Tiles`]
//! (one copy each into this module's memory) and results go out through [`Output`], whose
//! byte getters move each buffer out once (one copy into a fresh, transferable
//! `Uint8Array`). Failures throw an `Error` whose message is the editor's localization
//! key, so the worker rethrows the message users already know.

#![allow(clippy::type_complexity, clippy::chunks_exact_to_as_chunks)]

use styk_doc::Value;
use styk_drawing::brush::{Brush, BrushStroke, Dab, Sample, DAB_FLOATS};
use styk_drawing::codec::{decode_tile_blob, EncodedTile, PublishTile, TileEncodeCache, TileEncoder};
use styk_drawing::error::DrawingError;
use styk_drawing::fill::{flood_tiles, FillOptions};
use styk_drawing::filters::{filter_tiles, Filter};
use styk_drawing::lasso::{capture_mask_selection, capture_selection, Captured};
use styk_drawing::levels::{level_store, Levels};
use styk_drawing::mask::{flood_dense, DenseFlood, Flooded, Mask, MaskData};
use styk_drawing::stroke::{SeedTile, StrokeEngine};
use styk_drawing::tiles::{alpha_bounds, pixels_from, tile_changes, tiles_in_rect, Alpha, Before, Pixels, Rect, Side, TileChange, TileStore, TILE, TILE_BYTES};
use styk_drawing::transform::{transform_selected_pixels, transform_tiles, Filter as Sampling};
use styk_drawing::{clipboard, history, png, prepare};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = error)]
    fn console_error(message: &str);
}

/// Panics reach the console before the module aborts; the facade then replaces the
/// instance (`__wbg_reset_state`).
#[wasm_bindgen(start)]
fn start() {
    std::panic::set_hook(Box::new(|info| console_error(&format!("StykAnimate drawing engine panic: {info}"))));
}

/// Bytes of linear memory this instance holds. It grows with the largest working set and
/// never shrinks; `src/engine/engine-drawing.mjs` replaces an instance that holds too much.
#[wasm_bindgen(js_name = memoryBytes)]
pub fn memory_bytes() -> f64 {
    #[cfg(target_arch = "wasm32")]
    {
        (core::arch::wasm32::memory_size::<0>() * 65536) as f64
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        0.0
    }
}

/// The version of the calls below, checked by `src/engine/engine-drawing.mjs`.
#[wasm_bindgen(js_name = drawingApiVersion)]
pub fn drawing_api_version() -> u32 {
    1
}

fn error(e: DrawingError) -> JsError {
    JsError::new(e.key)
}

type JsResult<T> = Result<T, JsError>;

fn key(text: &'static str) -> JsError {
    JsError::new(text)
}

fn safe(values: &[f64]) -> bool {
    values.iter().all(|v| v.is_finite() && v.trunc() == *v && v.abs() <= 9007199254740991.0)
}

fn rect(values: &[f64]) -> Option<Rect> {
    (values.len() == 4 && safe(values)).then(|| Rect::new(values[0] as i64, values[1] as i64, values[2] as i64, values[3] as i64))
}

/// Tiles going in: in order, each with full pixels, four uniform bytes, nothing (an
/// empty side) or a trusted PNG.
#[wasm_bindgen]
#[derive(Default)]
pub struct Tiles {
    list: Vec<(i64, i64, Option<Vec<u8>>, Option<Vec<u8>>)>,
}

/// A buffer going out: owned, or shared with a tile (copied once, into JavaScript).
enum Buf {
    Owned(Vec<u8>),
    Tile(Pixels),
    Bytes(std::sync::Arc<[u8]>),
}

impl Buf {
    fn slice(&self) -> &[u8] {
        match self {
            Buf::Owned(v) => v,
            Buf::Tile(p) => &p[..],
            Buf::Bytes(b) => b,
        }
    }
}

#[wasm_bindgen]
impl Tiles {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Tiles {
        Tiles::default()
    }
    /// A tile with pixels (16,384 bytes or four uniform bytes).
    pub fn push(&mut self, tx: f64, ty: f64, pixels: Vec<u8>) {
        self.list.push((tx as i64, ty as i64, Some(pixels), None));
    }
    /// A tile without pixels (an absent side, a seeded empty tile).
    #[wasm_bindgen(js_name = pushEmpty)]
    pub fn push_empty(&mut self, tx: f64, ty: f64) {
        self.list.push((tx as i64, ty as i64, None, None));
    }
    /// A tile known by its published PNG.
    #[wasm_bindgen(js_name = pushPng)]
    pub fn push_png(&mut self, tx: f64, ty: f64, png: Vec<u8>) {
        self.list.push((tx as i64, ty as i64, None, Some(png)));
    }
    #[wasm_bindgen(getter)]
    pub fn length(&self) -> usize {
        self.list.len()
    }
}

impl Tiles {
    /// The worker's `storeOf(data)`: full tiles inserted as they are.
    fn store(&self) -> JsResult<TileStore> {
        let mut store = TileStore::new();
        for (tx, ty, pixels, _) in &self.list {
            let Some(pixels) = pixels else { continue };
            if pixels.len() != TILE_BYTES {
                return Err(key("errors.drawingTiles.tilePixelsMustBeOneFullTile"));
            }
            store.adopt(*tx, *ty, pixels_from(pixels), Alpha::Unknown).map_err(error)?;
        }
        Ok(store)
    }
}

/// A selection going in.
#[wasm_bindgen]
pub struct MaskIn {
    mask: Mask,
}

#[wasm_bindgen]
impl MaskIn {
    /// A byte mask read as `byte / max`.
    pub fn dense(x: f64, y: f64, width: f64, height: f64, bytes: Vec<u8>, max: f64) -> JsResult<MaskIn> {
        if !safe(&[x, y, width, height]) || width < 0.0 || height < 0.0 || bytes.len() as f64 != width * height {
            return Err(key("errors.drawingLasso.invalidSelectionMask"));
        }
        Ok(MaskIn { mask: Mask { x: x as i64, y: y as i64, width: width as i64, height: height as i64, data: MaskData::Dense { mask: bytes, max } } })
    }
    /// An even-odd polygon (`[x0, y0, x1, y1, …]`) with its bounds.
    pub fn points(x: f64, y: f64, width: f64, height: f64, points: &[f64]) -> MaskIn {
        let points = points.chunks_exact(2).map(|p| (p[0], p[1])).collect();
        MaskIn { mask: Mask { x: x as i64, y: y as i64, width: width as i64, height: height as i64, data: MaskData::Points(points) } }
    }
}

struct Item {
    tx: i64,
    ty: i64,
    a: Option<Buf>,
    b: Option<Buf>,
    alpha: Option<Rect>,
    alpha2: Option<Rect>,
    flag: bool,
    level: u32,
}

impl Item {
    fn new(tx: i64, ty: i64) -> Item {
        Item { tx, ty, a: None, b: None, alpha: None, alpha2: None, flag: false, level: 0 }
    }
}

/// Results going out.
#[wasm_bindgen]
#[derive(Default)]
pub struct Output {
    items: Vec<Item>,
    rect: Option<Rect>,
    bytes: Vec<u8>,
    texts: Vec<String>,
    numbers: Vec<f64>,
}

fn rect_vec(r: Option<Rect>) -> Option<Vec<f64>> {
    r.map(|r| vec![r.x as f64, r.y as f64, r.width as f64, r.height as f64])
}

fn side_buf(side: &Side) -> Option<Buf> {
    match side {
        Side::Absent => None,
        Side::Uniform(c) => Some(Buf::Owned(c.to_vec())),
        Side::Full(p) => Some(Buf::Tile(p.clone())),
    }
}

/// A buffer copied out of this module into a fresh, transferable `Uint8Array`.
fn js_bytes(buf: Option<Buf>) -> Option<js_sys::Uint8Array> {
    buf.map(|b| js_sys::Uint8Array::from(b.slice()))
}

#[wasm_bindgen]
impl Output {
    #[wasm_bindgen(getter)]
    pub fn length(&self) -> usize {
        self.items.len()
    }
    pub fn tx(&self, i: usize) -> f64 {
        self.items[i].tx as f64
    }
    pub fn ty(&self, i: usize) -> f64 {
        self.items[i].ty as f64
    }
    /// The first buffer of item `i` (pixels, or an undo record's before side), moved out.
    pub fn a(&mut self, i: usize) -> Option<js_sys::Uint8Array> {
        js_bytes(self.items[i].a.take())
    }
    /// The second buffer of item `i` (a PNG, a remainder, or an undo record's after side), moved out.
    pub fn b(&mut self, i: usize) -> Option<js_sys::Uint8Array> {
        js_bytes(self.items[i].b.take())
    }
    /// Alpha bounds `[x, y, width, height]` of item `i`'s first buffer.
    pub fn alpha(&self, i: usize) -> Option<Vec<f64>> {
        rect_vec(self.items[i].alpha)
    }
    /// Alpha bounds of item `i`'s second buffer.
    pub fn alpha2(&self, i: usize) -> Option<Vec<f64>> {
        rect_vec(self.items[i].alpha2)
    }
    pub fn flag(&self, i: usize) -> bool {
        self.items[i].flag
    }
    pub fn level(&self, i: usize) -> u32 {
        self.items[i].level
    }
    /// A rectangle `[x, y, width, height]` (dirty area, bounds, mask placement).
    #[wasm_bindgen(getter)]
    pub fn rect(&self) -> Option<Vec<f64>> {
        rect_vec(self.rect)
    }
    /// Bytes (a mask, a blob, an encoded chunk, pixels), moved out.
    #[wasm_bindgen(js_name = takeBytes)]
    pub fn take_bytes(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.bytes)
    }
    pub fn text(&self, i: usize) -> String {
        self.texts[i].clone()
    }
    #[wasm_bindgen(getter)]
    pub fn texts(&self) -> usize {
        self.texts.len()
    }
    pub fn number(&self, i: usize) -> f64 {
        self.numbers.get(i).copied().unwrap_or(f64::NAN)
    }
}

fn changes_output(changes: Vec<TileChange>) -> Output {
    let items = changes
        .into_iter()
        .map(|c| Item { a: side_buf(&c.before), b: side_buf(&c.after), ..Item::new(c.tx as i64, c.ty as i64) })
        .collect();
    Output { items, ..Output::default() }
}

fn tiles_output(store: &TileStore) -> Output {
    let items = store.iter().map(|t| Item { a: Some(Buf::Tile(t.pixels.clone())), alpha: t.alpha_bounds(), ..Item::new(t.tx as i64, t.ty as i64) }).collect();
    Output { items, ..Output::default() }
}

fn filter_named(name: &str) -> JsResult<Sampling> {
    Sampling::named(name).map_err(error)
}

fn matrix(m: &[f64]) -> JsResult<[f64; 6]> {
    if m.len() != 6 {
        return Err(key("errors.drawingTransform.invalidDrawingTransform"));
    }
    Ok([m[0], m[1], m[2], m[3], m[4], m[5]])
}

// ------------------------------------------------------------------ the pixel worker

/// `fill`: `floodTiles` of drawing-fill.mjs. The undo records (`a` before, `b` after).
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn fill(tiles: &Tiles, bounds: &[f64], x: f64, y: f64, color: &[f64], tolerance: f64, expansion: f64, gap: f64, max_bytes: f64, clip: Option<MaskIn>, source: Option<Vec<u8>>) -> JsResult<Output> {
    let mut store = tiles.store()?;
    let Some(bounds) = rect(bounds) else { return Err(key("errors.drawingFill.invalidFillBounds")) };
    if color.len() != 4 {
        return Err(key("errors.drawingFill.invalidFillOptions"));
    }
    let clip = clip.map(|m| m.mask);
    let options = FillOptions { x, y, color: [color[0], color[1], color[2], color[3]], tolerance, expansion, gap, bounds, source: source.as_deref(), clip: clip.as_ref(), max_bytes };
    Ok(changes_output(flood_tiles(&mut store, &options).map_err(error)?))
}

/// `flood-mask`: the magic wand's selection: `rect` and the mask bytes.
#[wasm_bindgen(js_name = floodMask)]
pub fn flood_mask(tiles: &Tiles, bounds: &[f64], x: f64, y: f64, tolerance: f64, gap: f64, source: Option<Vec<u8>>) -> JsResult<Output> {
    let mut store = tiles.store()?;
    let Some(bounds) = rect(bounds) else { return Err(key("errors.drawingWorkerOperations.invalidSelectionBounds")) };
    if bounds.width <= 0 || bounds.height <= 0 || bounds.width * bounds.height > styk_drawing::mask::DRAWING_MAX_PIXELS {
        return Err(key("errors.drawingWorkerOperations.invalidSelectionBounds"));
    }
    let flood = DenseFlood { x, y, color: [0.0, 0.0, 0.0, 255.0], tolerance, expansion: 0.0, gap, bounds, source: source.as_deref(), clip: None };
    // `number(0)`: 0 when the start is outside the bounds (the JavaScript returns
    // `undefined`), 1 when it is not selectable (`null`), 2 with a selection.
    let mut out = Output { numbers: vec![0.0], ..Output::default() };
    match flood_dense(&mut store, &flood, true).map_err(error)? {
        Flooded::Selection(Some(mask)) => {
            out.numbers[0] = 2.0;
            out.rect = Some(mask.rect());
            if let MaskData::Dense { mask, .. } = mask.data {
                out.bytes = mask;
            }
        }
        Flooded::Selection(None) => out.numbers[0] = 1.0,
        _ => {}
    }
    Ok(out)
}

/// `filter`: a drawing filter's undo records; transparent tiles a blur leaves are pruned.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn filter(tiles: &Tiles, bounds: &[f64], kind: &str, radius: f64, hue: f64, saturation: f64, lightness: f64, brightness: f64, contrast: f64, mask: Option<MaskIn>) -> JsResult<Output> {
    let mut store = tiles.store()?;
    let blur = kind == "blur";
    let Some(bounds) = rect(bounds) else { return Err(key("errors.drawingPixels.invalidFilterBounds")) };
    if blur && (bounds.width <= 0 || bounds.height <= 0 || bounds.width * bounds.height > styk_drawing::mask::DRAWING_MAX_PIXELS) {
        return Err(key("errors.drawingPixels.invalidFilterBounds"));
    }
    let filter = match kind {
        "blur" => Filter::Blur { radius },
        "hsl" => Filter::Hsl { hue, saturation, lightness },
        "brightness" => Filter::Brightness { brightness, contrast },
        "invert" => Filter::Invert,
        _ => {
            styk_drawing::filters::point_filter_work(&store, bounds).map_err(error)?;
            return Err(key("errors.drawingController.unknownDrawingFilter"));
        }
    };
    let mut before = Before::new();
    if blur {
        for (tx, ty) in tiles_in_rect(bounds.x, bounds.y, bounds.width, bounds.height) {
            before.set(tx as i32, ty as i32, store.get(tx, ty).map(|t| t.pixels.clone()));
        }
    }
    let mask = mask.map(|m| m.mask);
    filter_tiles(&mut store, bounds, filter, mask.as_ref(), Some(&mut before)).map_err(error)?;
    if blur {
        store.prune();
    }
    Ok(changes_output(tile_changes(&store, before.entries())))
}

/// `fill-mask`: paints a colour over every selected pixel.
#[wasm_bindgen(js_name = fillMask)]
pub fn fill_mask(tiles: &Tiles, mask: MaskIn, color: &[f64]) -> JsResult<Output> {
    let mut store = tiles.store()?;
    let m = mask.mask;
    if !matches!(m.data, MaskData::Dense { .. }) || m.width <= 0 || m.height <= 0 || m.width * m.height > styk_drawing::mask::DRAWING_MAX_PIXELS {
        return Err(key("errors.drawingLasso.invalidSelectionMask"));
    }
    if color.len() != 4 {
        return Err(key("errors.drawingFill.invalidFillOptions"));
    }
    let mut before = Before::new();
    for (tx, ty) in tiles_in_rect(m.x, m.y, m.width, m.height) {
        before.set(tx as i32, ty as i32, store.get(tx, ty).map(|t| t.pixels.clone()));
    }
    styk_drawing::mask::fill_mask_tiles(&mut store, &m, [color[0], color[1], color[2], color[3]]).map_err(error)?;
    Ok(changes_output(tile_changes(&store, before.entries())))
}

fn captured_output(tiles: Vec<Captured>) -> Output {
    let items = tiles
        .into_iter()
        .map(|t| Item {
            a: (!t.full).then(|| Buf::Tile(t.pixels.clone())),
            b: t.remaining.as_ref().map(|r| Buf::Tile(r.clone())),
            alpha: t.alpha,
            alpha2: t.remaining_bounds,
            flag: t.full,
            ..Item::new(t.tx as i64, t.ty as i64)
        })
        .collect();
    Output { items, ..Output::default() }
}

/// `select`: splits the cel's tiles into the selection and the remainder. Item `a` is the
/// selected pixels (absent when the whole tile is selected: `flag`), `b` the remainder.
#[wasm_bindgen]
pub fn select(tiles: &Tiles, points: Option<Vec<f64>>, mask: Option<MaskIn>, max_bytes: f64) -> JsResult<Output> {
    let store = tiles.store()?;
    let result = match (mask, points) {
        (Some(mask), _) => capture_mask_selection(&store, &mask.mask, max_bytes),
        (None, Some(points)) => capture_selection(&store, &points.chunks_exact(2).map(|p| (p[0], p[1])).collect::<Vec<_>>(), max_bytes),
        (None, None) => return Err(key("errors.drawingLasso.invalidLassoCoordinates")),
    };
    let (bounds, tiles) = result.map_err(error)?;
    let mut out = captured_output(tiles);
    out.rect = bounds;
    Ok(out)
}

/// `selection`: commits a floating selection (`transformSelectedPixels`).
#[wasm_bindgen(js_name = transformSelection)]
pub fn transform_selection(tiles: &Tiles, source: &Tiles, m: &[f64], remove: bool, filter: &str, max_bytes: f64) -> JsResult<Output> {
    let mut store = tiles.store()?;
    let source = source.store()?;
    let changes = transform_selected_pixels(&mut store, &source, &matrix(m)?, remove, filter_named(filter)?, max_bytes).map_err(error)?;
    Ok(changes_output(changes))
}

/// `paste`: decodes a pixel clipboard packet (JSON) and lays it over the cel.
#[wasm_bindgen]
pub fn paste(tiles: &Tiles, clip: &str, m: &[f64], filter: &str, max_bytes: f64) -> JsResult<Output> {
    let mut store = tiles.store()?;
    let packet = styk_doc::json::parse(clip.as_bytes()).map_err(|_| key("errors.drawingClipboard.invalidDrawingPixelClipboard"))?;
    let (source, encoded) = clipboard::decode(&packet, max_bytes - store.bytes()).map_err(error)?;
    let mut before = Before::new();
    transform_tiles(&source, &matrix(m)?, &mut store, Some(&mut before), filter_named(filter)?, max_bytes - encoded).map_err(error)?;
    Ok(changes_output(tile_changes(&store, before.entries())))
}

/// `resample`: the cel at `ratio` times its resolution; tiles with alpha bounds, `rect` its bounds.
#[wasm_bindgen]
pub fn resample(tiles: &Tiles, ratio: f64, filter: &str, max_bytes: f64) -> JsResult<Output> {
    if !ratio.is_finite() || ratio <= 0.0 {
        return Err(key("errors.drawingWorkerOperations.invalidDrawingResample"));
    }
    let source = tiles.store()?;
    let mut out = TileStore::new();
    transform_tiles(&source, &[ratio, 0.0, 0.0, ratio, 0.0, 0.0], &mut out, None, filter_named(filter)?, max_bytes).map_err(error)?;
    let bounds = out.bounds();
    let mut result = tiles_output(&out);
    result.rect = bounds;
    Ok(result)
}

/// `decode-tiles`: a cel's tile blob, optionally one shard of it, with its reduced levels
/// up to `levels` (items with `level` > 0; `a` pixels, `b` the PNG of level-0 tiles).
#[wasm_bindgen(js_name = decodeTiles)]
pub fn decode_tiles(blob: &[u8], shard_index: f64, shard_count: f64, levels: u32) -> JsResult<Output> {
    let shard = (shard_count > 0.0).then_some((shard_index as i64, shard_count as i64));
    let decoded = decode_tile_blob(blob, shard, styk_drawing::codec::TILE_BLOB_MAX_PIXELS as f64).map_err(error)?;
    let mut out = Output::default();
    if levels > 0 && !decoded.is_empty() {
        let mut store = TileStore::new();
        for t in &decoded {
            store.insert(styk_drawing::tiles::Tile::new(t.tx, t.ty, t.pixels.clone()));
        }
        let mut chain = Levels::new();
        for k in 1..=levels {
            let level = chain.level(&store, k as usize, None);
            for t in level.iter() {
                out.items.push(Item { a: Some(Buf::Tile(t.pixels.clone())), level: k, ..Item::new(t.tx as i64, t.ty as i64) });
            }
            if shard.is_none() && level.len() <= 4 {
                break;
            }
        }
    }
    let level_items = std::mem::take(&mut out.items);
    out.items = decoded.into_iter().map(|t| Item { a: Some(Buf::Tile(t.pixels)), b: Some(Buf::Bytes(t.png)), ..Item::new(t.tx as i64, t.ty as i64) }).collect();
    out.items.extend(level_items);
    Ok(out)
}

fn png_tiles(png_bytes: &[u8], crop_x: f64, crop_y: f64) -> JsResult<TileStore> {
    let image = png::decode_png(png_bytes, None).map_err(error)?;
    if !safe(&[crop_x, crop_y]) {
        return Err(key("errors.drawingWorkerOperations.invalidDrawingCrop"));
    }
    let (cx, cy) = (crop_x as i64, crop_y as i64);
    let (w, h) = (image.width as i64, image.height as i64);
    let mut store = TileStore::new();
    for (tx, ty) in tiles_in_rect(cx, cy, w, h) {
        let mut pixels = [0u8; TILE_BYTES];
        let (ox, oy) = (tx * TILE - cx, ty * TILE - cy);
        for py in (-oy).max(0)..(TILE).min(h - oy) {
            let from = (((py + oy) * w + ox.max(0)) * 4) as usize;
            let to = (((py + oy) * w + (w).min(ox + TILE)) * 4) as usize;
            let at = ((py * TILE + (-ox).max(0)) * 4) as usize;
            pixels[at..at + (to - from)].copy_from_slice(&image.pixels[from..to]);
        }
        if alpha_bounds(&pixels).is_some() {
            store.insert(styk_drawing::tiles::Tile::new(tx as i32, ty as i32, std::sync::Arc::new(pixels)));
        }
    }
    Ok(store)
}

/// `decode-legacy`: a version 1 cel's PNG cut into its non-transparent tiles at `crop`.
#[wasm_bindgen(js_name = decodeLegacy)]
pub fn decode_legacy(png_bytes: &[u8], crop_x: f64, crop_y: f64) -> JsResult<Output> {
    let store = png_tiles(png_bytes, crop_x, crop_y)?;
    let items = store.iter().map(|t| Item { a: Some(Buf::Tile(t.pixels.clone())), ..Item::new(t.tx as i64, t.ty as i64) }).collect();
    Ok(Output { items, ..Output::default() })
}

/// `encode-pngs`: each tile's PNG (`a`), stateless, for the parallel encoder pool.
#[wasm_bindgen(js_name = encodePngs)]
pub fn encode_pngs(tiles: &Tiles) -> JsResult<Output> {
    let mut encoder = TileEncoder::new();
    let mut items = Vec::with_capacity(tiles.list.len());
    for (tx, ty, pixels, _) in &tiles.list {
        let Some(pixels) = pixels.as_ref().filter(|p| p.len() == TILE_BYTES) else { return Err(key("errors.drawingTiles.tilePixelsMustBeOneFullTile")) };
        items.push(Item { a: Some(Buf::Bytes(encoder.encode(pixels))), ..Item::new(*tx, *ty) });
    }
    Ok(Output { items, ..Output::default() })
}

/// `thumbnail`: the pixels of the smallest reduced level still spanning about 64 pixels,
/// from a tile blob, a legacy PNG or tiles; `rect` is their bounds at that level.
#[wasm_bindgen]
pub fn thumbnail(tiles: Option<Tiles>, blob: Option<Vec<u8>>, legacy: Option<Vec<u8>>, crop_x: f64, crop_y: f64, bounds: Option<Vec<f64>>) -> JsResult<Output> {
    let mut store = if let Some(png_bytes) = legacy {
        png_tiles(&png_bytes, crop_x, crop_y)?
    } else if let Some(blob) = blob {
        let mut store = TileStore::new();
        for t in decode_tile_blob(&blob, None, styk_drawing::codec::TILE_BLOB_MAX_PIXELS as f64).map_err(error)? {
            store.insert(styk_drawing::tiles::Tile::new(t.tx, t.ty, t.pixels));
        }
        store
    } else {
        tiles.unwrap_or_default().store()?
    };
    let mut b = match bounds {
        Some(v) => rect(&v),
        None => store.bounds(),
    };
    if let Some(r) = b {
        let k = (styk_drawing::js::log2((r.width.max(r.height) as f64) / 64.0)).floor().clamp(0.0, 4.0);
        let k = if k.is_nan() { 0 } else { k as usize };
        if k > 0 {
            store = level_store(&store, k);
        }
        b = store.bounds();
    }
    let mut out = Output::default();
    if let Some(r) = b.filter(|r| r.width > 0 && r.height > 0 && r.width * r.height <= styk_drawing::mask::DRAWING_MAX_PIXELS) {
        out.bytes = store.read_rect(r.x, r.y, r.width, r.height);
        out.rect = Some(r);
    }
    Ok(out)
}

/// `copy-selection`: the clipboard's data URLs (`text`), reusing published PNGs.
#[wasm_bindgen(js_name = copySelection)]
pub fn copy_selection(tiles: &Tiles, max_bytes: f64) -> JsResult<Output> {
    let list: Vec<clipboard::ClipTile> = tiles
        .list
        .iter()
        .map(|(tx, ty, pixels, png)| match png {
            Some(png) => clipboard::ClipTile::Png { tx: *tx as f64, ty: *ty as f64, png: png.clone() },
            None => clipboard::ClipTile::Pixels { tx: *tx as f64, ty: *ty as f64, pixels: pixels.clone().unwrap_or_default() },
        })
        .collect();
    let encoded = clipboard::encode_tiles(&list, max_bytes).map_err(error)?;
    let mut out = Output::default();
    for (tx, ty, url) in encoded {
        out.items.push(Item::new(tx as i64, ty as i64));
        out.texts.push(url);
    }
    Ok(out)
}

/// `prepare-tiles`: replacement tiles expanded from compact undo sides, with alpha bounds.
#[wasm_bindgen(js_name = prepareTiles)]
pub fn prepare_tiles(tiles: &Tiles) -> JsResult<Output> {
    let full: Vec<bool> = tiles.list.iter().map(|(_, _, pixels, _)| pixels.as_ref().is_some_and(|p| p.len() == TILE_BYTES)).collect();
    let input = tiles.list.iter().map(|(tx, ty, pixels, _)| (*tx, *ty, pixels.clone())).collect();
    let prepared = prepare::materialize(input).map_err(error)?;
    let items = prepared
        .into_iter()
        .zip(full)
        .map(|(t, full)| match t.pixels {
            // A full tile comes back as the caller's own buffer: its bounds suffice (`flag`).
            Some((_, bounds)) if full => Item { alpha: Some(bounds), flag: true, ..Item::new(t.tx, t.ty) },
            Some((pixels, bounds)) => Item { a: Some(Buf::Tile(pixels)), alpha: Some(bounds), ..Item::new(t.tx, t.ty) },
            None => Item::new(t.tx, t.ty),
        })
        .collect();
    Ok(Output { items, ..Output::default() })
}

/// The pixel worker's encoded-tile cache across publications (`TileEncodeCache`).
#[wasm_bindgen]
pub struct Publisher {
    cache: TileEncodeCache,
}

#[wasm_bindgen]
impl Publisher {
    #[wasm_bindgen(constructor)]
    pub fn new(max_bytes: f64) -> Publisher {
        Publisher { cache: TileEncodeCache::new(max_bytes as usize) }
    }
    /// Trusts PNGs encoded elsewhere (`adopt`).
    pub fn adopt(&mut self, cel: &str, pngs: &Tiles) {
        let list = pngs.list.iter().filter_map(|(tx, ty, _, png)| png.as_ref().map(|png| EncodedTile { tx: *tx as i32, ty: *ty as i32, png: png.clone().into() })).collect();
        self.cache.adopt(cel, list);
    }
    /// `encode(celId, keep, tiles, {partial})`: `keep` holds the blob's keys as
    /// `[tx0, ty0, tx1, ty1, …]`. Items: the tiles this request encoded (`a`, their PNG);
    /// `flag`ged items are keys the cache no longer holds; `takeBytes()` is the blob;
    /// `number(0)` how many tiles were encoded, `number(1)` how many reused.
    pub fn encode(&mut self, cel: &str, keep: Option<Vec<f64>>, tiles: &Tiles, partial: bool) -> JsResult<Output> {
        let keep: Option<Vec<(i32, i32)>> = keep.map(|k| k.chunks_exact(2).map(|p| (p[0] as i32, p[1] as i32)).collect());
        let list = tiles
            .list
            .iter()
            .map(|(tx, ty, pixels, png)| match png {
                Some(png) => PublishTile::Png { tx: *tx as i32, ty: *ty as i32, png: png.clone().into() },
                None => PublishTile::Pixels { tx: *tx as i32, ty: *ty as i32, pixels: pixels.clone().unwrap_or_default() },
            })
            .collect();
        let result = self.cache.encode(cel, keep.as_deref(), list, partial).map_err(error)?;
        let mut out = Output::default();
        for t in &result.tiles {
            out.items.push(Item { a: Some(Buf::Bytes(t.png.clone())), ..Item::new(t.tx as i64, t.ty as i64) });
        }
        for (tx, ty) in &result.missing {
            out.items.push(Item { flag: true, ..Item::new(*tx as i64, *ty as i64) });
        }
        out.numbers = vec![result.encoded as f64, result.reused as f64, if result.blob.is_some() { 1.0 } else { 0.0 }];
        if let Some(blob) = result.blob {
            out.bytes = blob;
        }
        Ok(out)
    }
}

/// The preview worker's source cache: one viewport's tiles and their reduced levels.
#[wasm_bindgen]
#[derive(Default)]
pub struct Preview {
    store: TileStore,
    levels: Levels,
}

#[wasm_bindgen]
impl Preview {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Preview {
        Preview::default()
    }
    /// Keeps the tiles in `keep` (`[tx0, ty0, …]`), replaces `tiles`, and returns level
    /// `level` (items: `a` pixels).
    pub fn update(&mut self, reset: bool, keep: &[f64], tiles: &Tiles, level: u32) -> JsResult<Output> {
        if reset {
            *self = Preview::default();
        }
        let keep: std::collections::HashSet<(i64, i64)> = keep.chunks_exact(2).map(|p| (p[0] as i64, p[1] as i64)).collect();
        for (tx, ty) in self.store.keys() {
            let (tx, ty) = (tx as i64, ty as i64);
            if !keep.contains(&(tx, ty)) {
                self.store.delete(tx, ty);
                self.levels.invalidate(Some(Rect::new(tx * TILE, ty * TILE, TILE, TILE)));
            }
        }
        for (tx, ty, pixels, _) in &tiles.list {
            let Some(pixels) = pixels.as_ref().filter(|p| p.len() == TILE_BYTES) else { return Err(key("errors.drawingTiles.tilePixelsMustBeOneFullTile")) };
            self.store.insert(styk_drawing::tiles::Tile::new(*tx as i32, *ty as i32, pixels_from(pixels)));
            self.store.revision += 1;
            self.levels.invalidate(Some(Rect::new(tx * TILE, ty * TILE, TILE, TILE)));
        }
        let level = self.levels.level(&self.store, level as usize, None);
        Ok(tiles_output(&level))
    }
}

// ------------------------------------------------------------------ undo chunks

/// `encodeHistoryChunk(tiles)`: `tiles` holds each record as two entries, before then after.
#[wasm_bindgen(js_name = encodeHistoryChunk)]
pub fn encode_history_chunk(tiles: &Tiles) -> JsResult<Vec<u8>> {
    let mut changes = Vec::with_capacity(tiles.list.len() / 2);
    for pair in tiles.list.chunks_exact(2) {
        let side = |p: &Option<Vec<u8>>| -> JsResult<Side> {
            match p {
                None => Ok(Side::Absent),
                Some(b) if b.len() == 4 || b.len() == TILE_BYTES => Ok(Side::from_slice(Some(b))),
                Some(_) => Err(key("errors.drawingHistoryCodec.invalidDrawingHistoryTile")),
            }
        };
        changes.push(TileChange { tx: pair[0].0 as i32, ty: pair[0].1 as i32, before: side(&pair[0].2)?, after: side(&pair[1].2)? });
        if !(i32::MIN as i64..=i32::MAX as i64).contains(&pair[0].0) || !(i32::MIN as i64..=i32::MAX as i64).contains(&pair[0].1) {
            return Err(key("errors.drawingTiles.drawingCoordinatesExceedTheFileFormatRange"));
        }
    }
    history::encode_chunk(&changes).map_err(error)
}

/// `decodeHistoryChunk(bytes)`: the undo records (`a` before, `b` after).
#[wasm_bindgen(js_name = decodeHistoryChunk)]
pub fn decode_history_chunk(bytes: &[u8]) -> JsResult<Output> {
    Ok(changes_output(history::decode_chunk(bytes).map_err(error)?))
}

// ------------------------------------------------------------------ the stroke worker

/// The stroke worker's engine: strokes by id, batches in sequence order.
#[wasm_bindgen]
#[derive(Default)]
pub struct Strokes {
    engine: StrokeEngine,
}

fn dabs(values: &[f64]) -> Vec<Dab> {
    values.chunks_exact(DAB_FLOATS).map(Dab::unpack).collect()
}

#[wasm_bindgen]
impl Strokes {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Strokes {
        Strokes::default()
    }
    /// `begin(id, settings)`: `settings` is the brush settings as JSON.
    pub fn begin(&mut self, id: f64, settings: &str, mask: Option<MaskIn>) -> JsResult<()> {
        let settings = styk_doc::json::parse(settings.as_bytes()).map_err(|_| key("errors.drawingBrush.invalidBrushSettings"))?;
        self.engine.begin(id as u64, &settings, mask.map(|m| m.mask)).map_err(error)
    }
    /// `dabs(id, seq, dabs, tiles, tail)`: dab shapes packed 11 doubles each. `undefined`
    /// for an unknown stroke or a stale batch; otherwise the dirty tiles (`a`) and `rect`.
    pub fn dabs(&mut self, id: f64, seq: f64, shapes: &[f64], seeds: &Tiles, tail: Option<Vec<f64>>) -> JsResult<Option<Output>> {
        let seeds = seeds.list.iter().map(|(tx, ty, pixels, _)| SeedTile { tx: *tx, ty: *ty, pixels: pixels.clone() }).collect();
        let tail = tail.map(|t| dabs(&t));
        let Some(result) = self.engine.dabs(id as u64, seq, &dabs(shapes), seeds, tail.as_deref()).map_err(error)? else { return Ok(None) };
        let items = result.tiles.into_iter().map(|(tx, ty, pixels)| Item { a: Some(Buf::Owned(pixels)), ..Item::new(tx, ty) }).collect();
        Ok(Some(Output { items, rect: result.dirty, ..Output::default() }))
    }
    /// `end(id)`: the stroke's undo records, or `undefined` for an unknown stroke.
    pub fn end(&mut self, id: f64) -> JsResult<Option<Output>> {
        Ok(self.engine.end(id as u64).map_err(error)?.map(changes_output))
    }
    pub fn cancel(&mut self, id: f64) {
        self.engine.cancel(id as u64);
    }
}

// ------------------------------------------------------------------ the brush model

/// `BrushStroke`: pointer samples to final dab shapes (packed 11 doubles each).
#[wasm_bindgen(js_name = BrushPath)]
pub struct BrushPath {
    stroke: BrushStroke,
}

fn pack(shapes: &[Dab]) -> Vec<f64> {
    let mut out = Vec::with_capacity(shapes.len() * DAB_FLOATS);
    for d in shapes {
        d.pack(&mut out);
    }
    out
}

#[wasm_bindgen(js_class = BrushPath)]
impl BrushPath {
    /// A stroke of normalized brush settings (JSON); `seed` separates mirrored paths.
    #[wasm_bindgen(constructor)]
    pub fn new(settings: &str, seed: Option<f64>) -> JsResult<BrushPath> {
        let settings: Value = styk_doc::json::parse(settings.as_bytes()).map_err(|_| key("errors.drawingBrush.invalidBrushSettings"))?;
        let brush = Brush::normalize(&settings).map_err(error)?;
        let seed = seed.map(styk_drawing::js::to_u32);
        Ok(BrushPath { stroke: BrushStroke::new(brush, seed) })
    }
    /// One input sample; the final shapes it produced.
    pub fn sample(&mut self, x: f64, y: f64, pressure: Option<f64>, time: Option<f64>, ax: Option<f64>, ay: Option<f64>) -> JsResult<Vec<f64>> {
        let mut shapes = Vec::new();
        self.stroke.sample(&Sample { x, y, pressure, time, ax, ay }, &mut |d| shapes.push(d)).map_err(error)?;
        Ok(pack(&shapes))
    }
    /// Ends the stroke; the last shapes (the tapered tail included).
    pub fn finish(&mut self) -> Vec<f64> {
        let mut shapes = Vec::new();
        self.stroke.finish(&mut |d| shapes.push(d));
        pack(&shapes)
    }
    /// The provisional tail's shapes.
    pub fn tail(&mut self) -> Vec<f64> {
        pack(self.stroke.tail_shapes())
    }
    #[wasm_bindgen(getter, js_name = tailVersion)]
    pub fn tail_version(&self) -> f64 {
        self.stroke.tail_version as f64
    }
    #[wasm_bindgen(getter, js_name = hasTail)]
    pub fn has_tail(&self) -> bool {
        self.stroke.has_tail()
    }
    /// The pen curve applied to a pressure.
    #[wasm_bindgen(js_name = mapPressure)]
    pub fn map_pressure(&self, pressure: f64) -> f64 {
        self.stroke.map_pressure(pressure)
    }
    #[wasm_bindgen(getter, js_name = hasPressureCurve)]
    pub fn has_pressure_curve(&self) -> bool {
        styk_drawing::brush::PressureMap::new(self.stroke.brush.pressure_curve).is_some()
    }
    /// The path's arc length so far.
    #[wasm_bindgen(getter)]
    pub fn dist(&self) -> f64 {
        self.stroke.path.dist
    }
}
