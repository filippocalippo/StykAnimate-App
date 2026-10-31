//! Drawing PNGs (`drawing-png.mjs`): the exact synchronous RGBA encoder of published
//! tiles (unfiltered or adaptive None/Sub/Up rows, whichever LZ77 can reuse more of,
//! deflated by [`crate::zlib::deflate`]) and the bounded decoder of 8-bit RGB/RGBA,
//! non-interlaced PNGs with all five filters, without premultiplication.

use crate::error::{fail, Result};
use crate::mask::DRAWING_MAX_PIXELS;
use crate::zlib::{deflate, inflate};

static CRC_TABLE: std::sync::OnceLock<[u32; 256]> = std::sync::OnceLock::new();

/// CRC-32 (IEEE), as `crc32` in sticknodes/decoder/archive.mjs.
pub fn crc32(bytes: &[u8]) -> u32 {
    let table = CRC_TABLE.get_or_init(|| {
        let mut table = [0u32; 256];
        for (n, entry) in table.iter_mut().enumerate() {
            let mut c = n as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
            }
            *entry = c;
        }
        table
    });
    let mut c = 0xffff_ffffu32;
    for &v in bytes {
        c = table[((c ^ v as u32) & 255) as usize] ^ (c >> 8);
    }
    c ^ 0xffff_ffff
}

fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let start = out.len();
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let crc = crc32(&out[start..]);
    out.extend_from_slice(&crc.to_be_bytes());
}

fn scanlines(pixels: &[u8], width: usize, height: usize, adaptive: bool) -> Vec<u8> {
    let stride = width * 4;
    let mut scan = vec![0u8; (stride + 1) * height];
    for y in 0..height {
        let row = y * stride;
        let o = y * (stride + 1);
        let mut filter = 0u8;
        if adaptive {
            let (mut none, mut sub, mut up) = (0u64, 0u64, 0u64);
            for x in 0..stride {
                let v = pixels[row + x];
                let a = if x >= 4 { pixels[row + x - 4] } else { 0 };
                let b = if y > 0 { pixels[row + x - stride] } else { 0 };
                none += if v < 128 { v as u64 } else { 256 - v as u64 };
                let s = v.wrapping_sub(a);
                sub += if s < 128 { s as u64 } else { 256 - s as u64 };
                let u = v.wrapping_sub(b);
                up += if u < 128 { u as u64 } else { 256 - u as u64 };
            }
            filter = if sub < none && sub <= up {
                1
            } else if up < none {
                2
            } else {
                0
            };
        }
        scan[o] = filter;
        if filter == 0 {
            scan[o + 1..o + 1 + stride].copy_from_slice(&pixels[row..row + stride]);
        } else {
            for x in 0..stride {
                let v = pixels[row + x];
                scan[o + 1 + x] = if filter == 1 { v.wrapping_sub(if x >= 4 { pixels[row + x - 4] } else { 0 }) } else { v.wrapping_sub(if y > 0 { pixels[row + x - stride] } else { 0 }) };
            }
        }
    }
    scan
}

/// Bytes that differ from the byte one pixel earlier: positions LZ77 cannot reuse.
fn breaks(scan: &[u8]) -> usize {
    (4..scan.len()).filter(|&i| scan[i] != scan[i - 4]).count()
}

/// `encodeRGBAPNG(pixels, width, height)`.
pub fn encode_rgba_png(pixels: &[u8], width: usize, height: usize) -> Vec<u8> {
    let plain = scanlines(pixels, width, height, false);
    let adaptive = scanlines(pixels, width, height, true);
    let data = deflate(if breaks(&adaptive) < breaks(&plain) { &adaptive } else { &plain });
    let mut header = [0u8; 13];
    header[0..4].copy_from_slice(&(width as u32).to_be_bytes());
    header[4..8].copy_from_slice(&(height as u32).to_be_bytes());
    header[8] = 8;
    header[9] = 6;
    let mut out = Vec::with_capacity(data.len() + 64);
    out.extend_from_slice(&[137, 80, 78, 71, 13, 10, 26, 10]);
    chunk(&mut out, b"IHDR", &header);
    chunk(&mut out, b"IDAT", &data);
    chunk(&mut out, b"IEND", &[]);
    out
}

/// A decoded drawing PNG: straight RGBA.
#[derive(Clone, Debug)]
pub struct Image {
    pub width: usize,
    pub height: usize,
    pub pixels: Vec<u8>,
}

fn be(bytes: &[u8], at: usize) -> u32 {
    u32::from_be_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

/// `decodeDrawingPNGBytes(bytes, {width, height})`.
pub fn decode_png(bytes: &[u8], expected: Option<(usize, usize)>) -> Result<Image> {
    if bytes.len() < 8 || bytes[..8] != [137, 80, 78, 71, 13, 10, 26, 10] {
        return fail("errors.drawingPng.invalidDrawingPngSignature");
    }
    let (mut width, mut height, mut channels) = (0usize, 0usize, 0usize);
    let mut parts: Vec<&[u8]> = Vec::new();
    let mut pos = 8usize;
    while pos + 12 <= bytes.len() {
        let length = be(bytes, pos) as usize;
        let end = pos + 12 + length;
        if end > bytes.len() {
            return fail("errors.drawingPng.truncatedDrawingPng");
        }
        let kind = &bytes[pos + 4..pos + 8];
        let data = &bytes[pos + 8..pos + 8 + length];
        if crc32(&bytes[pos + 4..pos + 8 + length]) != be(bytes, pos + 8 + length) {
            return fail("errors.drawingPng.drawingPngChecksumMismatch");
        }
        if kind == b"IHDR" {
            width = be(bytes, pos + 8) as usize;
            height = be(bytes, pos + 12) as usize;
            let at = |i: usize| data.get(i).copied();
            channels = match at(9) {
                Some(6) => 4,
                Some(2) => 3,
                _ => 0,
            };
            if width == 0 || height == 0 || width > 8192 || height > 8192 || (width * height) as i64 > DRAWING_MAX_PIXELS || at(8) != Some(8) || channels == 0 || at(12) != Some(0) {
                return fail("errors.drawingPng.drawingsRequireABoundedNonInterlaced8Bit");
            }
            if let Some((w, h)) = expected {
                if width != w || height != h {
                    return fail("errors.drawingPng.drawingPngDimensionsDoNotMatchItsTile");
                }
            }
        }
        if kind == b"IDAT" {
            parts.push(data);
        }
        if kind == b"IEND" {
            break;
        }
        pos = end;
    }
    if channels == 0 || parts.is_empty() {
        return fail("errors.drawingPng.drawingPngIsMissingPixelData");
    }
    let stride = width * channels;
    let size = (stride + 1) * height;
    let joined: Vec<u8> = parts.concat();
    let mut scan = inflate(&joined, Some(size), size).map_err(|e| {
        crate::error::DrawingError::new(match e.key {
            "errors.zlibSync.deflateStreamExpandsBeyondItsBound" => "errors.drawingPng.drawingPngExpandsBeyondItsDeclaredDimensions",
            "errors.zlibSync.deflateStreamSizeMismatch" | "errors.zlibSync.truncatedDeflateStream" | "errors.zlibSync.truncatedStoredBlock" => "errors.drawingPng.drawingPngHasIncompletePixelData",
            _ => "errors.drawingPng.corruptPixelData",
        })
    })?;
    let mut output = vec![0u8; width * height * 4];
    let paeth = |a: i32, b: i32, c: i32| {
        let p = a + b - c;
        let (x, y, z) = ((p - a).abs(), (p - b).abs(), (p - c).abs());
        if x <= y && x <= z {
            a
        } else if y <= z {
            b
        } else {
            c
        }
    };
    for y in 0..height {
        let start = y * (stride + 1) + 1;
        let filter = scan[start - 1];
        if filter > 4 {
            return fail("errors.drawingPng.invalidDrawingPngFilter");
        }
        if filter != 0 {
            for x in 0..stride {
                let left = if x >= channels { scan[start + x - channels] as i32 } else { 0 };
                let up = if y > 0 { scan[start + x - stride - 1] as i32 } else { 0 };
                let corner = if y > 0 && x >= channels { scan[start + x - stride - 1 - channels] as i32 } else { 0 };
                let add = match filter {
                    1 => left,
                    2 => up,
                    3 => (left + up) / 2,
                    _ => paeth(left, up, corner),
                };
                scan[start + x] = ((scan[start + x] as i32 + add) & 255) as u8;
            }
        }
        if channels == 4 {
            output[y * stride..(y + 1) * stride].copy_from_slice(&scan[start..start + stride]);
        } else {
            for x in 0..width {
                let (a, b) = (start + x * 3, (y * width + x) * 4);
                output[b] = scan[a];
                output[b + 1] = scan[a + 1];
                output[b + 2] = scan[a + 2];
                output[b + 3] = 255;
            }
        }
    }
    Ok(Image { width, height, pixels: output })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_round_trips() {
        let mut pixels = vec![0u8; 64 * 64 * 4];
        for (i, v) in pixels.iter_mut().enumerate() {
            *v = ((i * 37) % 251) as u8;
        }
        let png = encode_rgba_png(&pixels, 64, 64);
        let image = decode_png(&png, Some((64, 64))).unwrap();
        assert_eq!(image.pixels, pixels);
    }
}
