use std::sync::Arc;

use image::ImageEncoder;

use super::*;
use crate::doc::DrawingTiles;
use styk_draw::{DrawList, F_DRAWING, K_IMAGE};

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
    let mut cels = LiveCels { pool: Pool { capacity: 40, ..Pool::default() }, ..LiveCels::default() };
    assert_eq!(cels.update("a", false, vec![((0, 0), Some(tile(&mut noise)))]), Err(Full));
    assert!(cels.get("a").is_none(), "a cel that does not fit is dropped whole");
    let mut cels = LiveCels { pool: Pool { capacity: 100, ..Pool::default() }, ..LiveCels::default() };
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

/// Random edits in rounds (paint, remove), each handed to `apply` and kept in `tiles`.
fn edit_rounds(noise: &mut Noise, rounds: usize, tiles: &mut HashMap<Coord, Vec<u8>>, mut apply: impl FnMut(Vec<(Coord, Option<Vec<u8>>)>)) {
    for _ in 0..rounds {
        let mut changes = Vec::new();
        for _ in 0..(1 + noise.next() % 6) {
            let coord = ((noise.next() % 9) as i32 - 4, (noise.next() % 9) as i32 - 4);
            match noise.next() % 5 {
                0 => {
                    tiles.remove(&coord);
                    changes.push((coord, None));
                }
                _ => {
                    let pixels = tile(noise);
                    tiles.insert(coord, pixels.clone());
                    changes.push((coord, Some(pixels)));
                }
            }
        }
        apply(changes);
    }
}

/// The levels of `layer` that `uploads` wrote a slot of.
fn levels_written(layer: &Layer, uploads: &[Upload]) -> Levels {
    let written: HashSet<(u32, u32, u32)> = uploads.iter().map(|u| (u.page, u.x, u.y)).collect();
    let mut levels = 0;
    for level in 0..=MAX_LEVEL as usize {
        for &coord in layer.drawn(level) {
            let (page, x, y) = place(layer.slot(level, coord).expect("a drawn tile has a slot"));
            if written.contains(&(page, x, y)) {
                levels |= 1 << level;
            }
        }
    }
    levels
}

#[test]
fn only_the_resident_levels_are_written_and_the_others_arrive_exact_when_called_for() {
    let mut noise = Noise(23);
    let mut tiles: HashMap<Coord, Vec<u8>> = HashMap::new();
    let mut lazy = LiveCels::new(0b11);
    let mut atlas = Atlas::default();
    let mut every = LiveCels::default();
    let mut full = Atlas::default();
    let mut writes = (0, 0);
    edit_rounds(&mut noise, 30, &mut tiles, |changes| {
        let uploads = lazy.update("a", false, changes.clone()).unwrap();
        assert_eq!(levels_written(&lazy.get("a").unwrap().base, &uploads) & !0b11, 0, "a level that is not resident was written");
        let all = every.update("a", false, changes).unwrap();
        writes = (writes.0 + uploads.len(), writes.1 + all.len());
        atlas.write(uploads);
        full.write(all);
    });
    assert!(writes.0 * 2 < writes.1, "{} writes against {}", writes.0, writes.1);
    // The resident levels are as a full upload makes them.
    let (view_lazy, view_full) = (LiveView { cels: &lazy, base: 3 }, LiveView { cels: &every, base: 3 });
    let (layer, layer_full) = (&lazy.get("a").unwrap().base, &every.get("a").unwrap().base);
    for level in 0..=1 {
        for &coord in layer.drawn(level) {
            assert!(atlas.read(&view_lazy, layer, level, coord) == full.read(&view_full, layer_full, level, coord), "level {level} {coord:?}");
        }
    }
    // A view that calls for more levels gets them, equal to the published decode's.
    let more = lazy.set_resident(ALL_LEVELS & !(1 << 3));
    assert_eq!(levels_written(&lazy.get("a").unwrap().base, &more) & (1 << 3), 0, "level 3 was not asked for");
    atlas.write(more);
    let (levels, expected) = published(&tiles);
    let view = LiveView { cels: &lazy, base: 3 };
    let layer = &lazy.get("a").unwrap().base;
    for (level, coords) in levels.iter().enumerate() {
        if level != 3 {
            for &coord in coords {
                assert!(atlas.read(&view, layer, level, coord) == &expected[&(level, coord)], "level {level} {coord:?}");
            }
        }
    }
    // Level 3 arrives when asked for, and nothing is stale after.
    atlas.write(lazy.set_resident(ALL_LEVELS));
    matches_published(&lazy, &atlas, "a", &tiles);
    assert!(lazy.set_resident(0).is_empty() && lazy.set_resident(ALL_LEVELS).is_empty());
}

#[test]
fn a_level_that_came_late_holds_what_later_edits_changed() {
    let mut noise = Noise(29);
    let mut tiles: HashMap<Coord, Vec<u8>> = HashMap::new();
    let mut cels = LiveCels::new(0b1);
    let mut atlas = Atlas::default();
    // Levels left stale while tiles come and go and slots are reused, then asked for in turn.
    edit_rounds(&mut noise, 12, &mut tiles, |changes| atlas.write(cels.update("a", false, changes).unwrap()));
    atlas.write(cels.set_resident(0b11));
    edit_rounds(&mut noise, 12, &mut tiles, |changes| atlas.write(cels.update("a", false, changes).unwrap()));
    atlas.write(cels.set_resident(0b1111));
    if !tiles.is_empty() {
        let view = LiveView { cels: &cels, base: 3 };
        let layer = &cels.get("a").unwrap().base;
        let (levels, expected) = published(&tiles);
        for (level, coords) in levels.iter().enumerate().take(4) {
            for &coord in coords {
                assert!(atlas.read(&view, layer, level, coord) == &expected[&(level, coord)], "level {level} {coord:?}");
            }
        }
    }
}

#[test]
fn a_new_atlas_gets_the_resident_levels_at_once_and_the_others_when_called_for() {
    let mut noise = Noise(31);
    let tiles: HashMap<Coord, Vec<u8>> = [(0, 0), (1, 2), (-3, 1), (4, 4)].into_iter().map(|c| (c, tile(&mut noise))).collect();
    let mut cels = LiveCels::new(0b11);
    cels.update("a", false, tiles.iter().map(|(&c, p)| (c, Some(p.clone()))).collect()).unwrap();
    let mut fresh = Atlas::default();
    let uploads = cels.uploads();
    assert_eq!(levels_written(&cels.get("a").unwrap().base, &uploads) & !0b11, 0);
    fresh.write(uploads);
    fresh.write(cels.set_resident(ALL_LEVELS));
    matches_published(&cels, &fresh, "a", &tiles);
}

/// A drawing tile of `level` whose edge is `world_edge` world units.
fn drawing_tile(level: u32, layer: u32, group: u32, world_edge: f32) -> styk_draw::Prim {
    styk_draw::Prim { kind: K_IMAGE | F_DRAWING, group, a: [0.0, 0.0, world_edge, 0.0], b: [0.0, world_edge, layer as f32, level as f32], ..Default::default() }
}

#[test]
fn the_levels_shown_follow_the_scale_and_ask_for_the_level_above() {
    let list = |prims: Vec<styk_draw::Prim>| DrawList { prims, ..Default::default() };
    // Level n's tile spans 64 << n cel pixels.
    let at = |scale: f64| shown_levels(&list((0..=MAX_LEVEL).map(|level| drawing_tile(level, 3, 0, (64u32 << level) as f32)).collect()), 3, scale);
    assert_eq!(at(1.0), 0b11, "the cel's own pixels, and the level above");
    assert_eq!(at(0.75), 0b11);
    assert_eq!(at(0.3), 0b110, "level 1, and 2 above it");
    assert_eq!(at(4.0), 0b11, "enlarged, level 0 is shown");
    assert_eq!(at(1.0 / 512.0), 1 << 8, "level 8 shows however small the view");
    // The published cel's tiles (atlas layers before the live ones) do not count.
    assert_eq!(shown_levels(&list(vec![drawing_tile(0, 2, 0, 64.0)]), 3, 1.0), 0);
    // A tile in an isolation group is drawn at a scale this does not know.
    assert_eq!(shown_levels(&list(vec![drawing_tile(0, 3, 1, 64.0)]), 3, 1.0), ALL_LEVELS);
    // The exact boundary shows the levels on both sides.
    assert_eq!(at(0.5) & 0b111, 0b111);
}
