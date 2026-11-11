//! Drawing undo records in bounded binary chunks (`drawing-history-codec.mjs`): exact
//! absent, uniform (four bytes) and full tile sides, validated before any pixel buffer
//! is allocated. The disk tier stores these chunks; saved documents never contain them.

use crate::error::{fail, Result};
use crate::tiles::{assert_tile, Side, TileChange, TILE_BYTES};

pub const HISTORY_CHUNK_BYTES: usize = 1024 * 1024;
const MAGIC: u32 = 0x3148_5944;
const HEADER: usize = 12;
const RECORD: usize = 16;

fn valid_length(n: usize) -> bool {
    n == 0 || n == 4 || n == TILE_BYTES
}

/// `historyPixelBytes(tiles)`.
pub fn history_pixel_bytes(tiles: &[TileChange]) -> usize {
    tiles.iter().map(|t| t.before.bytes() + t.after.bytes()).sum()
}

/// `encodeHistoryChunk(tiles)`.
pub fn encode_chunk(tiles: &[TileChange]) -> Result<Vec<u8>> {
    let length = HEADER + tiles.iter().map(|t| RECORD + t.before.bytes() + t.after.bytes()).sum::<usize>();
    if length > HISTORY_CHUNK_BYTES || tiles.is_empty() {
        return fail("errors.drawingHistoryCodec.invalidDrawingHistoryChunkSize");
    }
    let mut out = Vec::with_capacity(length);
    out.extend_from_slice(&MAGIC.to_le_bytes());
    out.extend_from_slice(&(tiles.len() as u32).to_le_bytes());
    out.extend_from_slice(&(length as u32).to_le_bytes());
    for tile in tiles {
        assert_tile(tile.tx as i64, tile.ty as i64)?;
        let (before, after) = (tile.before.bytes(), tile.after.bytes());
        out.extend_from_slice(&tile.tx.to_le_bytes());
        out.extend_from_slice(&tile.ty.to_le_bytes());
        out.extend_from_slice(&(before as u32).to_le_bytes());
        out.extend_from_slice(&(after as u32).to_le_bytes());
        if let Some(b) = tile.before.as_slice() {
            out.extend_from_slice(b);
        }
        if let Some(a) = tile.after.as_slice() {
            out.extend_from_slice(a);
        }
    }
    Ok(out)
}

fn le(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

/// `decodeHistoryChunk(bytes)`.
pub fn decode_chunk(bytes: &[u8]) -> Result<Vec<TileChange>> {
    let damaged = || fail("errors.drawingHistoryCodec.drawingUndoDataIsDamaged");
    if bytes.len() < HEADER || bytes.len() > HISTORY_CHUNK_BYTES || le(bytes, 0) != MAGIC || le(bytes, 8) as usize != bytes.len() {
        return damaged();
    }
    let count = le(bytes, 4) as usize;
    if count == 0 || count as f64 > (bytes.len() - HEADER) as f64 / RECORD as f64 {
        return damaged();
    }
    let mut records = Vec::with_capacity(count);
    let mut offset = HEADER;
    for _ in 0..count {
        if offset + RECORD > bytes.len() {
            return fail("errors.drawingHistoryCodec.drawingUndoDataIsTruncated");
        }
        let tx = le(bytes, offset) as i32;
        let ty = le(bytes, offset + 4) as i32;
        let before = le(bytes, offset + 8) as usize;
        let after = le(bytes, offset + 12) as usize;
        offset += RECORD;
        if !valid_length(before) || !valid_length(after) || offset + before + after > bytes.len() {
            return damaged();
        }
        records.push((tx, ty, before, after, offset));
        offset += before + after;
    }
    if offset != bytes.len() {
        return fail("errors.drawingHistoryCodec.drawingUndoDataHasTrailingBytes");
    }
    Ok(records
        .into_iter()
        .map(|(tx, ty, b, a, at)| TileChange {
            tx,
            ty,
            before: if b == 0 { Side::Absent } else { Side::from_slice(Some(&bytes[at..at + b])) },
            after: if a == 0 { Side::Absent } else { Side::from_slice(Some(&bytes[at + b..at + b + a])) },
        })
        .collect())
}

/// `historyChunks(tiles)`: consecutive runs that each fit one chunk.
pub fn history_chunks(tiles: &[TileChange]) -> Vec<&[TileChange]> {
    let mut out = Vec::new();
    let (mut start, mut bytes) = (0usize, HEADER);
    for (i, tile) in tiles.iter().enumerate() {
        let length = RECORD + tile.before.bytes() + tile.after.bytes();
        if bytes + length > HISTORY_CHUNK_BYTES && i > start {
            out.push(&tiles[start..i]);
            start = i;
            bytes = HEADER;
        }
        bytes += length;
    }
    if start < tiles.len() {
        out.push(&tiles[start..]);
    }
    out
}
