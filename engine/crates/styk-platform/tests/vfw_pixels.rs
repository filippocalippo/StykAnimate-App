//! The Windows codec helper's frame, held to `rgbaToVfwBgr24` (`src/vfw-pixels.mjs`) on every colour at every alpha:
//! the fixture is the JavaScript's own output for an image whose pixel (x, y) is colour x at alpha y.

use styk_platform::video::pixels::rgba_to_bgr24;

#[test]
fn every_colour_at_every_alpha_converts_as_the_javascript_does() {
    let mut rgba = Vec::with_capacity(256 * 256 * 4);
    for alpha in 0..256u32 {
        for colour in 0..256u32 {
            rgba.extend_from_slice(&[colour as u8, (colour * 3 & 255) as u8, (colour * 7 + 1 & 255) as u8, alpha as u8]);
        }
    }
    let mut out = Vec::new();
    rgba_to_bgr24(&rgba, 256, 256, &mut out);
    let expected = include_bytes!("fixtures/vfw-bgr24.bin");
    assert_eq!(out.len(), expected.len());
    let wrong = out.iter().zip(expected.iter()).filter(|(a, b)| a != b).count();
    assert_eq!(wrong, 0, "{wrong} of {} bytes differ", expected.len());
}
