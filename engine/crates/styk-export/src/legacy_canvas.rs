//! The mapping of today's canvas step.
//!
//! Today's export worker puts each frame's straight RGBA into a 2d canvas (`putImageData`) and encodes it as a PNG.
//! The canvas keeps premultiplied colour, so the colour of a translucent pixel comes out of the PNG changed (by up to
//! 127 levels at alpha 1; alpha itself is exact, fully opaque pixels are exact, and the colour under alpha 0 becomes
//! black). FFmpeg's WebM path reads that PNG, so a file with the same bytes needs the same colours: the native path
//! applies this mapping to the straight frames it sends for WebM, and only there (every other video is opaque).
//!
//! The mapping depends on one channel and the alpha alone. It was measured on every pair in Chromium
//! (`scripts/generate-legacy-canvas-fixture.cjs`, which also checks a second image with the channels spread apart) and
//! is the table in `legacy_canvas.bin`: index `alpha * 256 + colour`. It is behaviour kept, not a recommendation: a
//! better pipeline would skip it, and that is a separate, named change.

static TABLE: &[u8; 65536] = include_bytes!("legacy_canvas.bin");

/// The colour a canvas gives back for `colour` at `alpha`.
pub fn map(colour: u8, alpha: u8) -> u8 {
    TABLE[alpha as usize * 256 + colour as usize]
}

/// Applies the mapping to straight RGBA pixels in place.
pub fn apply(rgba: &mut [u8]) {
    for pixel in rgba.chunks_exact_mut(4) {
        let alpha = pixel[3];
        if alpha != 255 {
            let row = &TABLE[alpha as usize * 256..alpha as usize * 256 + 256];
            pixel[0] = row[pixel[0] as usize];
            pixel[1] = row[pixel[1] as usize];
            pixel[2] = row[pixel[2] as usize];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opaque_pixels_are_untouched_and_clear_pixels_lose_their_colour() {
        for colour in 0..=255u8 {
            assert_eq!(map(colour, 255), colour);
            assert_eq!(map(colour, 0), 0);
        }
    }

    #[test]
    fn translucent_values_are_what_chromium_gave() {
        // Measured in Chromium (Electron) by the generator: premultiply, store, unpremultiply.
        assert_eq!(map(22, 6), 42);
        assert_eq!(map(197, 6), 212);
        assert_eq!(map(85, 2), 128);
        assert_eq!(map(255, 1), 255);
        assert_eq!(map(1, 1), 0);
    }

    #[test]
    fn a_brighter_colour_never_maps_darker() {
        for alpha in 0..=255u8 {
            for colour in 1..=255u8 {
                assert!(map(colour, alpha) >= map(colour - 1, alpha), "alpha {alpha} colour {colour}");
            }
        }
    }

    #[test]
    fn a_frame_is_mapped_pixel_by_pixel() {
        let mut frame = [10, 20, 30, 255, 50, 60, 70, 0, 100, 150, 200, 6];
        apply(&mut frame);
        assert_eq!(frame[..4], [10, 20, 30, 255]);
        assert_eq!(frame[4..8], [0, 0, 0, 0]);
        assert_eq!(frame[8..], [map(100, 6), map(150, 6), map(200, 6), 6]);
    }
}
