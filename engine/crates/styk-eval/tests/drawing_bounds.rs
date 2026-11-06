//! Ink bounds are derived from decoded pixels without changing published data.

use std::sync::{Arc, OnceLock};

use image::ImageEncoder;
use styk_eval::doc::DrawingTiles;

fn png(ink: &[(u32, u32, u8)]) -> Arc<[u8]> {
    let mut pixels = vec![0; 64 * 64 * 4];
    for &(x, y, alpha) in ink {
        pixels[((y * 64 + x) * 4 + 3) as usize] = alpha;
    }
    let mut bytes = Vec::new();
    image::codecs::png::PngEncoder::new(&mut bytes).write_image(&pixels, 64, 64, image::ExtendedColorType::Rgba8).unwrap();
    bytes.into()
}

fn cel(tiles: Vec<(i32, i32, Arc<[u8]>)>, bounds: Option<[f64; 4]>) -> DrawingTiles {
    let levels = styk_eval::drawing::level_tiles(&tiles);
    DrawingTiles { anchor: [0.0; 2], pixels_per_unit: 1.0, bounds, decoded_bounds: OnceLock::new(), tiles, levels }
}

#[test]
fn sparse_translucent_ink_overrides_stale_metadata_after_decode() {
    let published = Some([0.0, 0.0, 1.0, 1.0]);
    let cel = cel(vec![(-3, 2, png(&[(7, 4, 1)])), (1, -2, png(&[(61, 63, 255)]))], published);
    assert_eq!(cel.artwork_bounds(), published);
    assert!(cel.decoded_bounds.get().is_none(), "loading metadata cannot decode PNGs");
    styk_eval::drawing::decode_cel(&cel);
    assert_eq!(cel.artwork_bounds(), Some([-185.0, -65.0, 311.0, 198.0]));
    assert_eq!(cel.bounds, published, "derived resource bounds cannot mutate the document");
}

#[test]
fn decoded_ink_fills_missing_metadata_at_far_signed_coordinates() {
    let cel = cel(vec![(-1_000_000_000, 1_000_000_000, png(&[(63, 0, 128)]))], None);
    styk_eval::drawing::decode_cel(&cel);
    assert_eq!(cel.artwork_bounds(), Some([-1_000_000_000f64 * 64.0 + 63.0, 1_000_000_000f64 * 64.0, 1.0, 1.0]));
}

#[test]
fn empty_ink_keeps_the_editors_published_metadata_fallback() {
    for published in [None, Some([-7.0, 12.0, 10.0, 20.0])] {
        let cel = cel(vec![(-1, 2, png(&[])), (0, 0, Arc::from(&b"invalid PNG"[..]))], published);
        styk_eval::drawing::decode_cel(&cel);
        assert_eq!(cel.decoded_bounds.get(), Some(&None));
        assert_eq!(cel.artwork_bounds(), published, "store.bounds ?? published bounds");
    }
}

#[test]
fn duplicate_tile_coordinates_use_the_final_tiles_alpha() {
    let cel = cel(vec![(0, 0, png(&[(0, 0, 255), (63, 63, 255)])), (0, 0, png(&[(10, 20, 255)]))], None);
    styk_eval::drawing::decode_cel(&cel);
    assert_eq!(cel.artwork_bounds(), Some([10.0, 20.0, 1.0, 1.0]), "tile stores replace duplicate keys");
}
