//! Frames for the Video for Windows helper: bottom-up BGR24, rows padded to four bytes, from straight RGBA.

use std::sync::OnceLock;

use styk_services::video::js_round;

/// `round(c * (a / 255))` for every colour and alpha, JavaScript's arithmetic (`rgbaToVfwBgr24`, `src/vfw-pixels.mjs`).
fn table() -> &'static [[u8; 256]; 256] {
    static TABLE: OnceLock<Box<[[u8; 256]; 256]>> = OnceLock::new();
    TABLE.get_or_init(|| {
        let mut table = Box::new([[0u8; 256]; 256]);
        for (alpha, row) in table.iter_mut().enumerate() {
            let scale = alpha as f64 / 255.0;
            for (color, value) in row.iter_mut().enumerate() {
                *value = js_round(color as f64 * scale) as u8;
            }
        }
        table
    })
}

/// The row length in bytes of a `width`-pixel BGR24 DIB.
pub fn bgr24_stride(width: u32) -> usize {
    (width as usize * 3).div_ceil(4) * 4
}

/// Converts straight RGBA (`width` by `height`, rows packed) into the helper's frame in `out`.
pub fn rgba_to_bgr24(rgba: &[u8], width: u32, height: u32, out: &mut Vec<u8>) {
    let (w, h, stride) = (width as usize, height as usize, bgr24_stride(width));
    let table = table();
    out.clear();
    out.resize(stride * h, 0);
    for y in 0..h {
        let source = &rgba[y * w * 4..(y + 1) * w * 4];
        let target = &mut out[(h - y - 1) * stride..(h - y - 1) * stride + w * 3];
        for (pixel, bgr) in source.chunks_exact(4).zip(target.chunks_exact_mut(3)) {
            let row = &table[pixel[3] as usize];
            bgr[0] = row[pixel[2] as usize];
            bgr[1] = row[pixel[1] as usize];
            bgr[2] = row[pixel[0] as usize];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_are_bottom_up_bgr_with_padding() {
        // 1x2: top pixel red, bottom pixel green, both opaque.
        let mut out = Vec::new();
        rgba_to_bgr24(&[255, 0, 0, 255, 0, 255, 0, 255], 1, 2, &mut out);
        assert_eq!(out, [0, 255, 0, 0, 0, 0, 255, 0]);
    }

    #[test]
    fn translucent_colour_is_premultiplied_with_javascripts_rounding() {
        let mut out = Vec::new();
        // 127/255 * 255 = 127, 127/255 * 100 = 49.8 -> 50, half alpha of 1 is 0.5 -> 1.
        rgba_to_bgr24(&[255, 100, 1, 127], 1, 1, &mut out);
        assert_eq!(&out[..3], &[js_round(1.0 * (127.0 / 255.0)) as u8, 50, 127]);
        assert_eq!(table()[0][255], 0);
        assert_eq!(table()[255][200], 200);
    }

    #[test]
    fn the_stride_is_a_multiple_of_four() {
        assert_eq!(bgr24_stride(161), 484);
        assert_eq!(bgr24_stride(4), 12);
        assert_eq!(bgr24_stride(1), 4);
    }
}
