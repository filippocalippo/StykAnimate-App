//! Colour-keyed legacy sprites (`backend/test_legacy_bitmap_keys.py`).

use sha2::{Digest, Sha256};
use styk_doc::{Obj, Value};

use super::*;
use crate::piv::v5::hex;

const KEY: [u8; 3] = [10, 200, 30];
const KEY_RAW: f64 = (10 | 200 << 8 | 30 << 16) as f64;

/// The generator of `engine/tools/piv/fixtures.py`.
struct Lcg(u64);

impl Lcg {
    fn below(&mut self, limit: u64) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (self.0 >> 33) % limit
    }
}

/// `fixtures.keyed_bmp`: a sprite bitmap of which `share` percent is the key colour.
fn keyed_bmp(rng: &mut Lcg, width: usize, height: usize, bits: usize, top_down: bool, share: u64, palette_entries: Option<usize>) -> Vec<u8> {
    let stride = (width * bits).div_ceil(32) * 4;
    let mut palette = Vec::new();
    if bits <= 8 {
        palette.extend_from_slice(&[KEY[2], KEY[1], KEY[0], 0]);
        for _ in 0..palette_entries.unwrap_or(1 << bits) - 1 {
            let (red, green, blue) = (rng.below(256) as u8, rng.below(256) as u8, rng.below(256) as u8);
            palette.extend_from_slice(&[blue, green, red, 0]);
        }
    }
    let mut rows = Vec::new();
    for _ in 0..height {
        let mut row = vec![0u8; stride];
        for x in 0..width {
            let keyed = rng.below(100) < share;
            if bits <= 8 {
                let index = if keyed { 0 } else { rng.below(palette_entries.unwrap_or(1 << bits) as u64) as u8 };
                row[x * bits / 8] |= index << (8 - bits - (x * bits % 8));
            } else {
                let [mut red, mut green, mut blue] = KEY;
                if !keyed {
                    red = rng.below(256) as u8;
                    green = rng.below(256) as u8;
                    blue = rng.below(256) as u8;
                }
                let at = x * (bits / 8);
                row[at..at + 3].copy_from_slice(&[blue, green, red]);
                if bits == 32 {
                    row[at + 3] = rng.below(256) as u8;
                }
            }
        }
        rows.extend_from_slice(&row);
    }
    let offset = 54 + palette.len();
    let mut out = b"BM".to_vec();
    out.extend_from_slice(&((offset + rows.len()) as u32).to_le_bytes());
    out.extend_from_slice(&[0; 4]);
    out.extend_from_slice(&(offset as u32).to_le_bytes());
    out.extend_from_slice(&40u32.to_le_bytes());
    out.extend_from_slice(&(width as i32).to_le_bytes());
    out.extend_from_slice(&(if top_down { -(height as i32) } else { height as i32 }).to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&(bits as u16).to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&(rows.len() as u32).to_le_bytes());
    out.extend_from_slice(&2835i32.to_le_bytes());
    out.extend_from_slice(&2835i32.to_le_bytes());
    out.extend_from_slice(&(palette_entries.filter(|_| bits <= 8).unwrap_or(0) as u32).to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&palette);
    out.extend_from_slice(&rows);
    out
}

fn sprite(bmp: &[u8]) -> Obj {
    let mut asset = Obj::new();
    asset.set("data_uri", blob("data:image/bmp;base64,", &std::sync::Arc::from(bmp)));
    asset.set("transparency_color_raw", Value::Num(KEY_RAW));
    asset
}

/// The pixels of an 8-bit RGBA PNG this module wrote: its inflated scanlines.
fn png_rows(png: &[u8]) -> Vec<u8> {
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    let length = u32::from_be_bytes(png[33..37].try_into().unwrap()) as usize;
    assert_eq!(&png[37..41], b"IDAT");
    crate::zlib::inflate(&png[41..41 + length], usize::MAX).expect("a zlib stream").data
}

#[test]
fn every_depth_converts_to_the_png_the_python_reader_made() {
    let expected = styk_doc::json::parse(&std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/expected.json")).expect("expected.json")).expect("JSON");
    let (mut rng, mut digest) = (Lcg(4), Sha256::new());
    for bits in [1, 4, 8, 24, 32] {
        for width in [1, 3, 7, 16, 33] {
            for height in [1, 5] {
                for top_down in [false, true] {
                    for share in [0, 40, 100] {
                        let bmp = keyed_bmp(&mut rng, width, height, bits, top_down, share, None);
                        let mut asset = sprite(&bmp);
                        keyed_bitmap_png(&mut asset).expect("a convertible sprite");
                        assert_eq!(asset.get("color_key_applied"), Some(&Value::Bool(true)));
                        assert_eq!(asset.get("render_mime_type").and_then(Value::as_str), Some("image/png"));
                        let png = asset.get("data_url").and_then(Value::payload_bytes).expect("a PNG data URL");
                        // Keyed pixels are transparent, every other pixel opaque.
                        let rows = png_rows(&png);
                        assert_eq!(rows.len(), height * (1 + width * 4), "{bits} bits, {width}x{height}");
                        for pixel in rows.chunks(1 + width * 4).flat_map(|row| row[1..].chunks(4)) {
                            assert_eq!(pixel[3], if pixel[..3] == KEY { 0 } else { 255 });
                        }
                        if share == 100 {
                            assert!(rows.chunks(1 + width * 4).all(|row| row[1..].chunks(4).all(|pixel| pixel[3] == 0)));
                        }
                        digest.update(&png);
                    }
                }
            }
        }
    }
    assert_eq!(Some(hex(&digest.finalize()).as_str()), expected.get("keyed_bitmaps_sha256").and_then(Value::as_str));
}

#[test]
fn absent_palette_colours_are_rejected_and_nothing_is_converted() {
    let mut rng = Lcg(9);
    let mut bmp = keyed_bmp(&mut rng, 9, 3, 8, false, 30, Some(4));
    let offset = u32::from_le_bytes(bmp[10..14].try_into().unwrap()) as usize;
    // Outside the four-entry palette.
    bmp[offset + 5] = 7;
    let mut asset = sprite(&bmp);
    let error = keyed_bitmap_png(&mut asset).expect_err("an index without a colour");
    assert_eq!(error.msg, "Legacy sprite bitmap references an absent palette color");
    assert!(!asset.contains("data_url"));
}

#[test]
fn sprites_the_converter_does_not_cover_say_so() {
    let mut rng = Lcg(1);
    let bmp = keyed_bmp(&mut rng, 4, 2, 24, false, 50, None);
    // Run-length compression.
    let mut compressed = bmp.clone();
    compressed[30] = 1;
    let mut asset = sprite(&compressed);
    keyed_bitmap_png(&mut asset).expect("left as a bitmap");
    assert!(!asset.contains("data_url"));
    assert_eq!(asset.get("render_limitations").and_then(|l| l.item(0)), Some(Value::str("Color-key conversion for BMP compression 1, depth 24 is not implemented.")));
    // Pixels that the file does not hold.
    let mut asset = sprite(&bmp[..bmp.len() - 1]);
    assert_eq!(keyed_bitmap_png(&mut asset).expect_err("truncated pixels").msg, "Legacy sprite bitmap pixels exceed stored resource");
    // No key colour: nothing to do.
    let mut plain = sprite(&bmp);
    plain.remove("transparency_color_raw");
    keyed_bitmap_png(&mut plain).expect("no key");
    assert!(!plain.contains("data_url"));
}
