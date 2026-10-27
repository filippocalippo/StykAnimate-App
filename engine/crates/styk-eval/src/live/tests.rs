use std::sync::Arc;

use image::ImageEncoder;

use super::*;
use crate::doc::DrawingTiles;

/// A deterministic stream of numbers.
struct Noise(u64);
impl Noise {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0 >> 33
    }
}

/// A tile holding a translucent block of colour, with a mark on each edge so that
/// neighbours' borders carry something.
fn tile(noise: &mut Noise) -> Vec<u8> {
    let side = TILE as usize;
    let mut pixels = vec![0u8; TILE_BYTES];
    let (x0, y0) = ((noise.next() % 40) as usize, (noise.next() % 40) as usize);
    let (w, h) = (4 + (noise.next() % 16) as usize, 4 + (noise.next() % 16) as usize);
    let color = [noise.next() as u8, noise.next() as u8, noise.next() as u8, 1 + (noise.next() % 255) as u8];
    for y in y0..y0 + h {
        for x in x0..x0 + w {
            pixels[(y * side + x) * 4..(y * side + x) * 4 + 4].copy_from_slice(&color);
        }
    }
    for k in (0..side).step_by(7) {
        for (x, y) in [(k, 0), (k, side - 1), (0, k), (side - 1, k)] {
            pixels[(y * side + x) * 4..(y * side + x) * 4 + 4].copy_from_slice(&[200, 30, 90, 255]);
        }
    }
    pixels
}

fn png(pixels: &[u8]) -> Arc<[u8]> {
    let mut out = Vec::new();
    image::codecs::png::PngEncoder::new(&mut out).write_image(pixels, TILE, TILE, image::ExtendedColorType::Rgba8).expect("an encoded tile");
    Arc::from(out)
}

/// What the published path makes of the same tiles: the drawn tiles of each level and the
/// slot pixels by level and coordinate.
fn published(tiles: &HashMap<Coord, Vec<u8>>) -> (Vec<Vec<Coord>>, HashMap<(usize, Coord), Vec<u8>>) {
    let list: Vec<(i32, i32, Arc<[u8]>)> = tiles.iter().map(|(&(x, y), pixels)| (x, y, png(pixels))).collect();
    let levels = crate::drawing::level_tiles(&list);
    let cel = DrawingTiles { anchor: [0.0; 2], pixels_per_unit: 1.0, bounds: None, decoded_bounds: Default::default(), tiles: list, levels };
    let mut slots = HashMap::new();
    for (level, index, rgba) in crate::drawing::decode_cel(&cel) {
        slots.insert((level as usize, cel.levels[level as usize][index as usize]), rgba);
    }
    (cel.levels.clone(), slots)
}

/// The atlas a host keeps: every upload written where it says.
#[derive(Default)]
struct Atlas(HashMap<(u32, u32, u32), Vec<u8>>);
impl Atlas {
    fn write(&mut self, uploads: Vec<Upload>) {
        for upload in uploads {
            assert_eq!(upload.rgba.len(), (CELL * CELL * 4) as usize);
            self.0.insert((upload.page, upload.x, upload.y), upload.rgba);
        }
    }
    fn read(&self, view: &LiveView<'_>, layer: &Layer, level: usize, coord: Coord) -> &Vec<u8> {
        let entry = view.entry(layer.slot(level, coord).expect("a drawn tile has a slot"));
        self.0.get(&(entry.layer - view.base, entry.x, entry.y)).expect("the slot was written")
    }
}

fn matches_published(cels: &LiveCels, atlas: &Atlas, id: &str, tiles: &HashMap<Coord, Vec<u8>>) {
    let view = LiveView { cels, base: 3 };
    let layer = &cels.get(id).expect("a live cel").base;
    let (levels, expected) = published(tiles);
    for (level, coords) in levels.iter().enumerate() {
        assert_eq!(layer.drawn(level), coords.as_slice(), "the tiles drawn at level {level}");
        for &coord in coords {
            let want = expected.get(&(level, coord)).unwrap_or_else(|| panic!("the published cel lacks {coord:?} at level {level}"));
            assert!(atlas.read(&view, layer, level, coord) == want, "slot of {coord:?} at level {level}");
        }
    }
}

#[test]
fn a_live_cel_fills_the_slots_the_published_cel_would() {
    let mut noise = Noise(7);
    let mut tiles = HashMap::new();
    for (x, y) in [(0, 0), (1, 0), (0, 1), (-1, -1), (-2, 3), (5, 5), (9, -4), (-17, 12)] {
        tiles.insert((x, y), tile(&mut noise));
    }
    let mut cels = LiveCels::default();
    let mut atlas = Atlas::default();
    atlas.write(cels.update("a", false, tiles.iter().map(|(&c, p)| (c, Some(p.clone()))).collect()).unwrap());
    matches_published(&cels, &atlas, "a", &tiles);
    assert_eq!(cels.stats().tiles, tiles.len());
    assert_eq!(cels.pages(), 1);
}

#[test]
fn updates_in_pieces_end_where_one_update_would() {
    let mut noise = Noise(11);
    let mut tiles: HashMap<Coord, Vec<u8>> = HashMap::new();
    let mut cels = LiveCels::default();
    let mut atlas = Atlas::default();
    for round in 0..24 {
        let mut changes = Vec::new();
        for _ in 0..(1 + noise.next() % 6) {
            let coord = ((noise.next() % 7) as i32 - 3, (noise.next() % 7) as i32 - 3);
            // Mostly paint; sometimes remove a tile or write one that is transparent.
            match noise.next() % 5 {
                0 => {
                    tiles.remove(&coord);
                    changes.push((coord, None));
                }
                1 => {
                    tiles.remove(&coord);
                    changes.push((coord, Some(vec![0u8; TILE_BYTES])));
                }
                _ => {
                    let pixels = tile(&mut noise);
                    tiles.insert(coord, pixels.clone());
                    changes.push((coord, Some(pixels)));
                }
            }
        }
        atlas.write(cels.update("a", false, changes).unwrap());
        if !tiles.is_empty() {
            matches_published(&cels, &atlas, "a", &tiles);
        }
        assert_eq!(cels.get("a").unwrap().base.len(), tiles.len(), "round {round}");
    }
}

#[test]
fn a_tile_written_again_with_the_same_pixels_uploads_nothing() {
    let mut noise = Noise(3);
    let pixels = tile(&mut noise);
    let mut cels = LiveCels::default();
    assert!(!cels.update("a", false, vec![((0, 0), Some(pixels.clone()))]).unwrap().is_empty());
    assert!(cels.update("a", false, vec![((0, 0), Some(pixels))]).unwrap().is_empty());
}

#[test]
fn a_changed_tile_rewrites_its_neighbours_borders_at_every_level() {
    let mut noise = Noise(5);
    let mut cels = LiveCels::default();
    cels.update("a", false, vec![((0, 0), Some(tile(&mut noise))), ((1, 0), Some(tile(&mut noise)))]).unwrap();
    let uploads = cels.update("a", false, vec![((1, 0), Some(tile(&mut noise)))]).unwrap();
    assert!(uploads.len() > 9, "{} slots rewritten", uploads.len());
    let distinct: HashSet<_> = uploads.iter().map(|u| (u.page, u.x, u.y)).collect();
    assert_eq!(distinct.len(), uploads.len(), "a slot is written once");
    assert!(uploads.len() <= cels.get("a").unwrap().base.slot_count());
}

#[test]
fn released_slots_are_reused_and_a_full_pool_drops_the_cel() {
    let mut noise = Noise(9);
    // One isolated tile draws its nine neighbourhood at each of nine levels: 81 slots.
    let mut cels = LiveCels { cels: HashMap::new(), pool: Pool { capacity: 40, ..Pool::default() } };
    assert_eq!(cels.update("a", false, vec![((0, 0), Some(tile(&mut noise)))]), Err(Full));
    assert!(cels.get("a").is_none(), "a cel that does not fit is dropped whole");
    let mut cels = LiveCels { cels: HashMap::new(), pool: Pool { capacity: 100, ..Pool::default() } };
    cels.update("a", false, vec![((0, 0), Some(tile(&mut noise)))]).unwrap();
    assert_eq!(cels.stats().slots, 81);
    // Moving the tile far away frees the old slots and takes them again.
    cels.update("a", false, vec![((0, 0), None), ((100, 100), Some(tile(&mut noise)))]).unwrap();
    assert_eq!(cels.stats().slots, 81);
    assert_eq!(cels.pages(), 1);
    cels.drop_cel("a");
    assert_eq!(cels.stats(), Stats::default());
}

#[test]
fn the_floating_selection_has_its_own_layer_and_goes_with_the_cel() {
    let mut noise = Noise(13);
    let mut cels = LiveCels::default();
    cels.update("a", false, vec![((0, 0), Some(tile(&mut noise)))]).unwrap();
    cels.update("a", true, vec![((2, 2), Some(tile(&mut noise)))]).unwrap();
    cels.show("a", true, true);
    let cel = cels.get("a").unwrap();
    assert!(cel.show_base && cel.show_float);
    assert_eq!((cel.base.len(), cel.float.len()), (1, 1));
    cels.clear_float("a");
    assert!(cels.get("a").unwrap().float.is_empty() && !cels.get("a").unwrap().show_float);
    assert_eq!(cels.stats().slots, 81, "only the base keeps slots");
    // A cel not shown does not replace the published one.
    cels.show("a", false, true);
    assert!(LiveView { cels: &cels, base: 0 }.cel("a").is_none());
}

#[test]
fn every_slot_is_written_again_after_the_atlas_is_allocated_anew() {
    let mut noise = Noise(17);
    let mut cels = LiveCels::default();
    let mut atlas = Atlas::default();
    let tiles: HashMap<Coord, Vec<u8>> = [(0, 0), (1, 2), (-3, 1)].into_iter().map(|c| (c, tile(&mut noise))).collect();
    atlas.write(cels.update("a", false, tiles.iter().map(|(&c, p)| (c, Some(p.clone()))).collect()).unwrap());
    let mut fresh = Atlas::default();
    fresh.write(cels.uploads());
    assert!(atlas.0 == fresh.0);
    matches_published(&cels, &fresh, "a", &tiles);
}
