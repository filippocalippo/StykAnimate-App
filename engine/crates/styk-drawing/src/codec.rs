//! The tile blob (`drawing-tile-codec.mjs`): a cel's published pixels as one bounded blob
//! of per-tile PNGs (`TYTS`, version 1, 64-pixel tiles, then `tx`, `ty`, length and PNG
//! bytes per tile), the per-tile encoder with its cache of uniform colours, the parallel
//! decode shards and the pixel worker's encoded-tile cache.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use crate::error::{fail, Result};
use crate::png::{decode_png, encode_rgba_png};
use crate::tiles::{assert_tile, Pixels, TILE_BYTES};

pub const TILE_BLOB_MAX_BYTES: usize = 96 * 1024 * 1024;
pub const TILE_BLOB_MAX_PIXELS: usize = 512 * 1024 * 1024;
pub const TILE_BLOB_MAX_TILES: usize = TILE_BLOB_MAX_PIXELS / TILE_BYTES;
const MAGIC: u32 = 0x5459_5453;

/// One encoded tile.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EncodedTile {
    pub tx: i32,
    pub ty: i32,
    pub png: Arc<[u8]>,
}

/// `assembleTileBlobBytes(tiles)`.
pub fn assemble_tile_blob(tiles: &[EncodedTile]) -> Result<Vec<u8>> {
    if tiles.len() > TILE_BLOB_MAX_TILES {
        return fail("errors.drawingTileCodec.drawingTileBlobExceedsItsTileBound");
    }
    let mut seen = HashSet::new();
    for tile in tiles {
        assert_tile(tile.tx as i64, tile.ty as i64)?;
        if !seen.insert((tile.tx, tile.ty)) {
            return fail("errors.drawingTileCodec.drawingTileBlobContainsDuplicateTiles");
        }
    }
    let total = tiles.iter().fold(16 + 12 * tiles.len(), |n, t| n + t.png.len());
    if total > TILE_BLOB_MAX_BYTES {
        return fail("errors.drawingTileCodec.drawingTileBlobExceedsItsSizeBound");
    }
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(&MAGIC.to_be_bytes());
    out.extend_from_slice(&1u32.to_le_bytes());
    out.extend_from_slice(&64u32.to_le_bytes());
    out.extend_from_slice(&(tiles.len() as u32).to_le_bytes());
    for tile in tiles {
        out.extend_from_slice(&tile.tx.to_le_bytes());
        out.extend_from_slice(&tile.ty.to_le_bytes());
        out.extend_from_slice(&(tile.png.len() as u32).to_le_bytes());
        out.extend_from_slice(&tile.png);
    }
    Ok(out)
}

/// `encodeTile(pixels)`: one tile as PNG bytes; tiles of one colour reuse a cached
/// encoding (at most 256 colours, oldest dropped first).
#[derive(Default)]
pub struct TileEncoder {
    uniform: HashMap<u32, Arc<[u8]>>,
    order: std::collections::VecDeque<u32>,
}

impl TileEncoder {
    pub fn new() -> TileEncoder {
        TileEncoder::default()
    }
    pub fn encode(&mut self, pixels: &[u8]) -> Arc<[u8]> {
        let first = u32::from_le_bytes([pixels[0], pixels[1], pixels[2], pixels[3]]);
        let uniform = pixels.chunks_exact(4).all(|px| u32::from_le_bytes([px[0], px[1], px[2], px[3]]) == first);
        if !uniform {
            return encode_rgba_png(pixels, 64, 64).into();
        }
        if let Some(png) = self.uniform.get(&first) {
            return png.clone();
        }
        let png: Arc<[u8]> = encode_rgba_png(pixels, 64, 64).into();
        if self.uniform.len() >= 256 {
            if let Some(oldest) = self.order.pop_front() {
                self.uniform.remove(&oldest);
            }
        }
        self.uniform.insert(first, png.clone());
        self.order.push_back(first);
        png
    }
}

/// Parallel decode shards own whole 8×8-tile blocks (`inShard`).
pub fn in_shard(tx: i32, ty: i32, index: i64, count: i64) -> bool {
    let block = ((tx >> 3) as i64 + (ty >> 3) as i64) % count;
    ((block + count) % count) == index
}

/// A decoded tile with the PNG it came from.
#[derive(Clone, Debug)]
pub struct DecodedTile {
    pub tx: i32,
    pub ty: i32,
    pub pixels: Pixels,
    pub png: Arc<[u8]>,
}

fn le(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

/// `decodeTileBlob(url, {shard, maxBytes})` on the blob's bytes.
pub fn decode_tile_blob(bytes: &[u8], shard: Option<(i64, i64)>, max_bytes: f64) -> Result<Vec<DecodedTile>> {
    if bytes.len() > TILE_BLOB_MAX_BYTES {
        return fail("errors.drawingTileCodec.drawingTileBlobExceedsItsSizeBound");
    }
    if bytes.len() < 16 || u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) != MAGIC || le(bytes, 4) != 1 || le(bytes, 8) != 64 {
        return fail("errors.drawingModel.invalidDrawingTileBlob");
    }
    let count = le(bytes, 12) as usize;
    if count > TILE_BLOB_MAX_TILES {
        return fail("errors.drawingTileCodec.drawingTileBlobExceedsItsTileBound");
    }
    if (count * TILE_BYTES) as f64 > max_bytes {
        return fail("errors.drawingTileCodec.drawingTilesExceedTheAvailableDecodeMemory");
    }
    let mut tiles = Vec::new();
    let mut seen = HashSet::new();
    let mut offset = 16usize;
    let mut decoded = 0usize;
    for _ in 0..count {
        if offset + 12 > bytes.len() {
            return fail("errors.drawingTileCodec.truncatedDrawingTileBlob");
        }
        let tx = le(bytes, offset) as i32;
        let ty = le(bytes, offset + 4) as i32;
        let length = le(bytes, offset + 8) as usize;
        offset += 12;
        if !seen.insert((tx, ty)) {
            return fail("errors.drawingTileCodec.drawingTileBlobContainsDuplicateTiles");
        }
        if offset + length > bytes.len() || length > TILE_BLOB_MAX_BYTES {
            return fail("errors.drawingTileCodec.truncatedDrawingTileBlob");
        }
        if let Some((index, shards)) = shard {
            if !in_shard(tx, ty, index, shards) {
                offset += length;
                continue;
            }
        }
        let png = &bytes[offset..offset + length];
        let image = decode_png(png, Some((64, 64)))?;
        offset += length;
        if image.width != 64 || image.height != 64 {
            return fail("errors.drawingTileCodec.drawingTileBlobCarriesANonTileImage");
        }
        decoded += image.pixels.len();
        if decoded > TILE_BLOB_MAX_PIXELS {
            return fail("errors.drawingTileCodec.drawingTileBlobExpandsBeyondItsPixelBound");
        }
        tiles.push(DecodedTile { tx, ty, pixels: crate::tiles::pixels_from(&image.pixels), png: png.into() });
    }
    if offset != bytes.len() {
        return fail("errors.drawingTileCodec.drawingTileBlobHasTrailingBytes");
    }
    Ok(tiles)
}

/// A JavaScript `Map` with string keys: insertion order, deletion keeps the others' order.
#[derive(Clone, Debug)]
struct Ordered<K: std::hash::Hash + Eq + Clone, V> {
    entries: Vec<Option<(K, V)>>,
    index: HashMap<K, usize>,
}

impl<K: std::hash::Hash + Eq + Clone, V> Default for Ordered<K, V> {
    fn default() -> Self {
        Ordered { entries: Vec::new(), index: HashMap::new() }
    }
}

impl<K: std::hash::Hash + Eq + Clone, V> Ordered<K, V> {
    fn get(&self, k: &K) -> Option<&V> {
        self.index.get(k).and_then(|&i| self.entries[i].as_ref().map(|e| &e.1))
    }
    fn set(&mut self, k: K, v: V) {
        match self.index.get(&k) {
            Some(&i) => self.entries[i].as_mut().unwrap().1 = v,
            None => {
                self.index.insert(k.clone(), self.entries.len());
                self.entries.push(Some((k, v)));
            }
        }
    }
    fn delete(&mut self, k: &K) -> Option<V> {
        let i = self.index.remove(k)?;
        let v = self.entries[i].take().map(|e| e.1);
        if self.entries.len() > 64 && self.index.len() * 2 < self.entries.len() {
            let entries = std::mem::take(&mut self.entries);
            for (k, v) in entries.into_iter().flatten() {
                self.index.insert(k.clone(), self.entries.len());
                self.entries.push(Some((k, v)));
            }
        }
        v
    }
    fn keys(&self) -> Vec<K> {
        self.entries.iter().flatten().map(|e| e.0.clone()).collect()
    }
    fn len(&self) -> usize {
        self.index.len()
    }
}

/// What a publication request produced (`TileEncodeCache.encode`).
#[derive(Debug, Default)]
pub struct Encoded {
    /// Tiles this request encoded (their PNGs go back to the editor).
    pub tiles: Vec<EncodedTile>,
    /// Keys of the blob that the cache no longer holds.
    pub missing: Vec<(i32, i32)>,
    /// The assembled blob (final requests).
    pub blob: Option<Vec<u8>>,
    pub encoded: usize,
    pub reused: usize,
}

/// A tile for publication: pixels to encode, or a PNG the editor already trusts.
pub enum PublishTile {
    Pixels { tx: i32, ty: i32, pixels: Vec<u8> },
    Png { tx: i32, ty: i32, png: Arc<[u8]> },
}

/// The pixel worker's per-cel cache of encoded tile PNGs (`TileEncodeCache`), bounded
/// globally, oldest cel first; a key the publication still needs is never dropped.
pub struct TileEncodeCache {
    cels: Ordered<String, Ordered<(i32, i32), Arc<[u8]>>>,
    pub bytes: usize,
    pub max_bytes: usize,
    encoder: TileEncoder,
}

impl TileEncodeCache {
    pub fn new(max_bytes: usize) -> TileEncodeCache {
        TileEncodeCache { cels: Ordered::default(), bytes: 0, max_bytes, encoder: TileEncoder::new() }
    }

    /// `cel(id)`: the cel's entries, moved to the most recent place.
    fn touch(&mut self, id: &str) {
        let key = id.to_string();
        let cel = self.cels.delete(&key).unwrap_or_default();
        self.cels.set(key, cel);
    }

    fn cel_mut(&mut self, id: &str) -> &mut Ordered<(i32, i32), Arc<[u8]>> {
        let key = id.to_string();
        let i = self.cels.index[&key];
        &mut self.cels.entries[i].as_mut().unwrap().1
    }

    /// `adopt(celId, list)`: trusts PNGs encoded elsewhere.
    pub fn adopt(&mut self, cel_id: &str, list: Vec<EncodedTile>) {
        self.touch(cel_id);
        for t in list {
            let len = t.png.len();
            let cel = self.cel_mut(cel_id);
            let old = cel.get(&(t.tx, t.ty)).map(|p| p.len());
            cel.set((t.tx, t.ty), t.png);
            if let Some(old) = old {
                self.bytes -= old;
            }
            self.bytes += len;
        }
    }

    /// `encode(celId, keep, tiles, {partial})`.
    pub fn encode(&mut self, cel_id: &str, keep: Option<&[(i32, i32)]>, tiles: Vec<PublishTile>, partial: bool) -> Result<Encoded> {
        self.touch(cel_id);
        let wanted: HashSet<(i32, i32)> = keep.map(|k| k.iter().copied().collect()).unwrap_or_default();
        if !partial || keep.is_some() {
            let keys = self.cel_mut(cel_id).keys();
            for key in keys {
                if !wanted.contains(&key) {
                    let removed = self.cel_mut(cel_id).delete(&key);
                    self.bytes -= removed.map_or(0, |p| p.len());
                }
            }
        }
        let mut encoded = Vec::new();
        for tile in tiles {
            let (tx, ty, png, fresh) = match tile {
                PublishTile::Png { tx, ty, png } => (tx, ty, png, false),
                PublishTile::Pixels { tx, ty, pixels } => {
                    if pixels.len() != TILE_BYTES {
                        return fail("errors.drawingTiles.tilePixelsMustBeOneFullTile");
                    }
                    (tx, ty, self.encoder.encode(&pixels), true)
                }
            };
            let len = png.len();
            let cel = self.cel_mut(cel_id);
            let old = cel.get(&(tx, ty)).map(|p| p.len());
            cel.set((tx, ty), png.clone());
            if let Some(old) = old {
                self.bytes -= old;
            }
            self.bytes += len;
            if fresh {
                encoded.push(EncodedTile { tx, ty, png });
            }
        }
        // Bound the cache, oldest cel entries first.
        let ids = self.cels.keys();
        for id in ids {
            if self.bytes <= self.max_bytes {
                break;
            }
            let keys = self.cels.get(&id).map(|c| c.keys()).unwrap_or_default();
            for key in keys {
                if self.bytes <= self.max_bytes {
                    break;
                }
                if id == cel_id && (partial || wanted.contains(&key)) {
                    continue;
                }
                let i = self.cels.index[&id];
                let entries = &mut self.cels.entries[i].as_mut().unwrap().1;
                let removed = entries.delete(&key);
                self.bytes -= removed.map_or(0, |p| p.len());
            }
            if self.cels.get(&id).is_some_and(|c| c.len() == 0) {
                self.cels.delete(&id);
            }
        }
        let count = encoded.len();
        if partial {
            return Ok(Encoded { tiles: encoded, encoded: count, ..Encoded::default() });
        }
        let keep = keep.unwrap_or(&[]);
        let mut assembly = Vec::new();
        let mut missing = Vec::new();
        let cel = self.cels.get(&cel_id.to_string());
        for &key in keep {
            match cel.and_then(|c| c.get(&key)) {
                Some(png) => assembly.push(EncodedTile { tx: key.0, ty: key.1, png: png.clone() }),
                None => missing.push(key),
            }
        }
        if !missing.is_empty() {
            return Ok(Encoded { tiles: encoded, missing, encoded: count, ..Encoded::default() });
        }
        let blob = assemble_tile_blob(&assembly)?;
        Ok(Encoded { tiles: encoded, blob: Some(blob), encoded: count, reused: keep.len() - count, missing: Vec::new() })
    }
}
