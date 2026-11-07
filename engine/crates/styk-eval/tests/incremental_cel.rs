//! A cel that replaces another is written where it differs: the tiles it shares with the one it replaced keep their slots and their pixels, and
//! the ones it writes are what a decode of the whole cel makes of them.

use std::sync::Arc;

use styk_eval::assets::{decode_cel_changed, Assets};
use styk_eval::doc::DrawingTiles;
use styk_eval::drawing::{decode_cel, decode_cel_dirty, dirty_tiles, level_tiles, TILE};

struct Rng(u64);
impl Rng {
    fn next(&mut self, n: u64) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0 % n
    }
}

/// A 64-pixel tile with ink: a patch of random opaque, half-transparent and empty texels, as a PNG.
fn tile(rng: &mut Rng) -> Arc<[u8]> {
    let side = TILE as usize;
    let mut rgba = vec![0u8; side * side * 4];
    let (x0, y0, w, h) = (rng.next(32) as usize, rng.next(32) as usize, 8 + rng.next(24) as usize, 8 + rng.next(24) as usize);
    for y in y0..y0 + h {
        for x in x0..x0 + w {
            let at = (y * side + x) * 4;
            rgba[at..at + 4].copy_from_slice(&[rng.next(256) as u8, rng.next(256) as u8, rng.next(256) as u8, [0, 128, 255][rng.next(3) as usize]]);
        }
    }
    let image = image::RgbaImage::from_raw(TILE, TILE, rgba).unwrap();
    let mut png = Vec::new();
    image.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).unwrap();
    png.into()
}

fn cel(tiles: Vec<(i32, i32, Arc<[u8]>)>) -> Arc<DrawingTiles> {
    let levels = level_tiles(&tiles);
    Arc::new(DrawingTiles::new([0.0; 2], 1.0, None, tiles, levels))
}

#[test]
fn the_tiles_a_cel_writes_are_the_ones_a_whole_decode_makes_and_the_others_are_the_ones_it_replaced_left() {
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    for round in 0..6 {
        // A cel of scattered tiles, some far apart (the higher levels have to reach them), some next to each other, some at negative coordinates.
        let mut at: Vec<(i32, i32)> = (0..24).map(|_| (rng.next(40) as i32 - 20, rng.next(40) as i32 - 20)).collect();
        at.extend([(0, 0), (1, 0), (0, 1), (1, 1), (300, -200)]);
        at.sort_unstable();
        at.dedup();
        let old_tiles: Vec<(i32, i32, Arc<[u8]>)> = at.iter().map(|&(x, y)| (x, y, tile(&mut rng))).collect();
        let old = cel(old_tiles.clone());
        let old_full = decode_cel(&old);

        // The edit: two tiles painted again, one erased, one added (a stroke into a new place, or a stroke and its undo).
        let mut new_tiles = old_tiles.clone();
        for k in 0..2 {
            let at = rng.next(new_tiles.len() as u64) as usize;
            new_tiles[at].2 = tile(&mut rng);
            let _ = k;
        }
        new_tiles.remove(rng.next(new_tiles.len() as u64) as usize);
        new_tiles.push((rng.next(40) as i32 - 20, 25 + round, tile(&mut rng)));
        let new = cel(new_tiles.clone());
        let dirty = dirty_tiles(&old, &new);
        let written = dirty.iter().flatten().filter(|dirty| **dirty).count();
        let whole: usize = new.levels.iter().map(Vec::len).sum();
        assert!(written > 0 && written < whole, "round {round}: the edit writes some tiles, not all of them ({written} of {whole})");

        // What a decode of the whole new cel makes (on a copy that has no ink handed down).
        let fresh = cel(new_tiles);
        let full = decode_cel(&fresh);
        let by_place = |decoded: &[(u32, u32, Vec<u8>)]| -> std::collections::HashMap<(u32, u32), Vec<u8>> { decoded.iter().map(|(n, i, rgba)| ((*n, *i), rgba.clone())).collect() };
        let full = by_place(&full);

        // The incremental decode needs the ink of the cel it replaced.
        old.tile_ink.get().expect("the decode of the old cel kept its ink");
        new.inherited_ink.set(old.tile_ink.get().unwrap().clone()).unwrap();
        let partial = decode_cel_dirty(&new, &dirty);
        assert_eq!(partial.len(), written, "round {round}: a decode of every tile written and no other");
        for (n, i, rgba) in &partial {
            assert!(dirty[*n as usize][*i as usize]);
            assert!(rgba == &full[&(*n, *i)], "round {round}: level {n} tile {i} is what the whole decode makes");
        }
        assert_eq!(new.decoded_bounds.get(), fresh.decoded_bounds.get(), "round {round}: the same bounds without decoding the tiles that did not change");

        // The tiles it does not write are what the old cel's slots hold: the same pixels the old decode made for the same tile.
        let before = by_place(&old_full);
        for (n, level) in new.levels.iter().enumerate() {
            for (i, &(x, y)) in level.iter().enumerate() {
                if dirty[n][i] {
                    continue;
                }
                let j = old.levels[n].binary_search_by_key(&(y, x), |&(x, y)| (y, x)).expect("a tile that is not written was in the old cel");
                assert!(before[&(n as u32, j as u32)] == full[&(n as u32, i as u32)], "round {round}: level {n} tile ({x}, {y}) kept its slot and changed");
            }
        }
    }
}

/// The cel handed to `Assets`: its slots are those of the cel it replaced for the tiles they share.
#[test]
fn a_placed_cel_that_replaces_another_keeps_the_slots_of_the_tiles_they_share() {
    use styk_eval::load::Loader;
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/drawlist/drawing-cel.json");
    let read = || styk_doc::json::parse(&std::fs::read(&path).unwrap()).unwrap();
    let mut loader = Loader::new();
    let first = loader.document(&read(), "p").unwrap();
    let tiles = |document: &styk_eval::doc::Document| document.figures[0].images.iter().find_map(|image| image.tiles.clone()).unwrap();
    let assets = Assets::build(&first);
    let old = tiles(&first);
    // Decoding the cel resolves its ink, as the engine does before it publishes the next.
    for image in styk_eval::assets::decode_cel(&assets, &old) {
        let _ = image;
    }
    // The next revision: the same file read again is other pixels in the same tiles, so nothing is shared by bytes... the PNG bytes are equal.
    let next = loader.document(&read(), "p").unwrap();
    let replaced = assets.extended_inheriting(&next, true);
    let new = tiles(&next);
    let (was, now) = (assets.cel_slots(&old).unwrap(), replaced.cel_slots(&new).unwrap());
    assert_eq!(was, now, "every tile is in the slot it was in");
    let dirty = replaced.cel_dirty(new.key()).expect("a placement that inherits says what it writes");
    assert!(dirty.iter().flatten().all(|dirty| !dirty), "the same tiles: nothing to write");
    assert!(decode_cel_changed(&replaced, &new).is_empty());
    // Not inheriting writes it whole.
    let whole = assets.extended_inheriting(&next, false);
    assert!(whole.cel_dirty(new.key()).is_none());
    assert_eq!(decode_cel_changed(&whole, &new).len(), whole.cel_slots(&new).unwrap().iter().map(Vec::len).sum::<usize>());
}

/// A document whose first figure draws `cels` in that order, one image each.
fn drawing_cels(base: &styk_eval::doc::Document, cels: &[&Arc<DrawingTiles>]) -> styk_eval::doc::Document {
    let mut document = base.clone();
    let mut figure = (*document.figures[0]).clone();
    let template = figure.images.iter().find(|image| image.tiles.is_some()).unwrap().clone();
    figure.images = cels.iter().map(|cel| styk_eval::doc::ImageAsset { tiles: Some((*cel).clone()), ..template.clone() }).collect();
    document.figures[0] = Arc::new(figure);
    document
}

/// A payload the document draws more than once, with another between the draws (A, B, A), is placed once: the second draw of A taking slots of
/// its own would overwrite the first's placement and leave its slots held by nobody, for good.
#[test]
fn a_payload_drawn_twice_with_another_between_is_placed_once_however_often_it_comes_and_goes() {
    use styk_eval::load::Loader;
    let mut rng = Rng(0x2545_f491_4f6c_dd1d);
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/drawlist/drawing-cel.json");
    let base = Loader::new().document(&styk_doc::json::parse(&std::fs::read(&path).unwrap()).unwrap(), "p").unwrap();
    let a = cel((0..6).map(|n| (n, 0, tile(&mut rng))).collect());
    let b = cel((0..4).map(|n| (n, 3, tile(&mut rng))).collect());
    let slots_of = |assets: &Assets| assets.cels.values().map(|(_, slots)| slots.iter().map(Vec::len).sum::<usize>()).sum::<usize>();
    let unique = |cels: &[&Arc<DrawingTiles>]| {
        let mut seen = std::collections::HashSet::new();
        cels.iter().filter(|cel| seen.insert(cel.key())).map(|cel| cel.levels.iter().map(Vec::len).sum::<usize>()).sum::<usize>()
    };
    let (with, without) = (drawing_cels(&base, &[&a, &b, &a]), drawing_cels(&base, &[&b]));
    let mut assets = Assets::build(&with);
    assert_eq!(assets.cels.len(), 2, "the two payloads are placed");
    assert_eq!(slots_of(&assets), unique(&[&a, &b]), "each payload has its tiles' slots, once");
    let allocated = assets.drawing.len();
    assert_eq!(allocated, slots_of(&assets), "and nothing else is allocated");
    for round in 0..8 {
        assets = assets.extended(&without);
        assert_eq!(assets.cels.len(), 1, "round {round}: A is gone");
        assets = assets.extended(&with);
        assert_eq!(slots_of(&assets), unique(&[&a, &b]), "round {round}: A is back, once");
        assert_eq!(assets.drawing.len(), allocated, "round {round}: removing and restoring a cel does not grow the atlas");
    }
}
