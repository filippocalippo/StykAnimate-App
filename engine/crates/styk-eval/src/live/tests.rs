use std::sync::Arc;

use image::ImageEncoder;

use std::collections::{HashMap, HashSet};

use super::*;
use crate::doc::DrawingTiles;
use styk_draw::{DrawList, F_DRAWING, K_IMAGE};

/// One slot's contents as a test sees a write: a cell of a run.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Upload {
    page: u32,
    x: u32,
    y: u32,
    rgba: Vec<u8>,
}

/// The cells of runs, `(x, y)` being the corner of each tile itself.
fn cells_of(runs: Vec<Run>) -> Vec<Upload> {
    let mut cells = Vec::new();
    for run in runs {
        let row = (CELL * 4) as usize;
        for cell in 0..run.cells as usize {
            let mut rgba = Vec::new();
            for line in 0..CELL as usize {
                let start = (line * run.cells as usize + cell) * row;
                rgba.extend_from_slice(&run.rgba[start..start + row]);
            }
            cells.push(Upload { page: run.page, x: run.x + BORDER + cell as u32 * CELL, y: run.y + BORDER, rgba });
        }
    }
    cells
}

fn update(cels: &mut LiveCels, id: &str, float: bool, changes: Vec<(Coord, Option<Vec<u8>>)>) -> Result<Vec<Upload>, Full> {
    cels.update(id, float, changes)?;
    Ok(cells_of(cels.take_runs()))
}

fn set_resident(cels: &mut LiveCels, levels: Levels) -> Vec<Upload> {
    cels.set_resident(levels);
    cells_of(cels.take_runs())
}

fn rewrite_all(cels: &mut LiveCels) -> Vec<Upload> {
    cels.rewrite_all();
    cells_of(cels.take_runs())
}

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
    let cel = DrawingTiles::new([0.0; 2], 1.0, None, list, levels);
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
    atlas.write(update(&mut cels, "a", false, tiles.iter().map(|(&c, p)| (c, Some(p.clone()))).collect()).unwrap());
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
        atlas.write(update(&mut cels, "a", false, changes).unwrap());
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
    assert!(!update(&mut cels, "a", false, vec![((0, 0), Some(pixels.clone()))]).unwrap().is_empty());
    assert!(update(&mut cels, "a", false, vec![((0, 0), Some(pixels))]).unwrap().is_empty());
}

#[test]
fn a_changed_tile_rewrites_its_neighbours_borders_at_every_level() {
    let mut noise = Noise(5);
    let mut cels = LiveCels::default();
    update(&mut cels, "a", false, vec![((0, 0), Some(tile(&mut noise))), ((1, 0), Some(tile(&mut noise)))]).unwrap();
    let uploads = update(&mut cels, "a", false, vec![((1, 0), Some(tile(&mut noise)))]).unwrap();
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
    assert_eq!(update(&mut cels, "a", false, vec![((0, 0), Some(tile(&mut noise)))]), Err(Full));
    assert!(cels.get("a").is_none(), "a cel that does not fit is dropped whole");
    let mut cels = LiveCels { pool: Pool { capacity: 100, ..Pool::default() }, ..LiveCels::default() };
    update(&mut cels, "a", false, vec![((0, 0), Some(tile(&mut noise)))]).unwrap();
    assert_eq!(cels.stats().slots, 81);
    // Moving the tile far away frees the old slots and takes them again.
    update(&mut cels, "a", false, vec![((0, 0), None), ((100, 100), Some(tile(&mut noise)))]).unwrap();
    assert_eq!(cels.stats().slots, 81);
    assert_eq!(cels.pages(), 1);
    cels.drop_cel("a");
    assert_eq!(cels.stats(), Stats::default());
}

#[test]
fn the_floating_selection_has_its_own_layer_and_goes_with_the_cel() {
    let mut noise = Noise(13);
    let mut cels = LiveCels::default();
    update(&mut cels, "a", false, vec![((0, 0), Some(tile(&mut noise)))]).unwrap();
    update(&mut cels, "a", true, vec![((2, 2), Some(tile(&mut noise)))]).unwrap();
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
    atlas.write(update(&mut cels, "a", false, tiles.iter().map(|(&c, p)| (c, Some(p.clone()))).collect()).unwrap());
    let mut fresh = Atlas::default();
    fresh.write(rewrite_all(&mut cels));
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
        let uploads = update(&mut lazy, "a", false, changes.clone()).unwrap();
        assert_eq!(levels_written(&lazy.get("a").unwrap().base, &uploads) & !0b11, 0, "a level that is not resident was written");
        let all = update(&mut every, "a", false, changes).unwrap();
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
    let more = set_resident(&mut lazy, ALL_LEVELS & !(1 << 3));
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
    atlas.write(set_resident(&mut lazy, ALL_LEVELS));
    matches_published(&lazy, &atlas, "a", &tiles);
    assert!(set_resident(&mut lazy, 0).is_empty() && set_resident(&mut lazy, ALL_LEVELS).is_empty());
}

#[test]
fn a_level_that_came_late_holds_what_later_edits_changed() {
    let mut noise = Noise(29);
    let mut tiles: HashMap<Coord, Vec<u8>> = HashMap::new();
    let mut cels = LiveCels::new(0b1);
    let mut atlas = Atlas::default();
    // Levels left stale while tiles come and go and slots are reused, then asked for in turn.
    edit_rounds(&mut noise, 12, &mut tiles, |changes| atlas.write(update(&mut cels, "a", false, changes).unwrap()));
    atlas.write(set_resident(&mut cels, 0b11));
    edit_rounds(&mut noise, 12, &mut tiles, |changes| atlas.write(update(&mut cels, "a", false, changes).unwrap()));
    atlas.write(set_resident(&mut cels, 0b1111));
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
    update(&mut cels, "a", false, tiles.iter().map(|(&c, p)| (c, Some(p.clone()))).collect()).unwrap();
    let mut fresh = Atlas::default();
    let uploads = rewrite_all(&mut cels);
    assert_eq!(levels_written(&cels.get("a").unwrap().base, &uploads) & !0b11, 0);
    fresh.write(uploads);
    fresh.write(set_resident(&mut cels, ALL_LEVELS));
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

#[test]
fn slots_built_once_for_a_frame_leave_the_texels_of_writing_after_every_call() {
    let mut noise = Noise(5);
    let mut tiles: HashMap<Coord, Vec<u8>> = HashMap::new();
    let mut eager = LiveCels::default();
    let mut deferred = LiveCels::default();
    let mut every_call = Atlas::default();
    let mut written = 0;
    edit_rounds(&mut noise, 40, &mut tiles, |changes| {
        let uploads = update(&mut eager, "a", false, changes.clone()).unwrap();
        written += uploads.len();
        every_call.write(uploads);
        // The slots are freed, taken again and rewritten across the calls; nothing is built until the frame.
        deferred.update("a", false, changes).unwrap();
    });
    let runs = deferred.take_runs();
    let mut frame = Atlas::default();
    let cells = cells_of(runs.clone());
    let slots = cells.len();
    frame.write(cells);
    // Every slot a call ever wrote and still holds is as the calls left it; a slot given back may hold anything.
    let held = |cels: &LiveCels| -> HashSet<(u32, u32, u32)> {
        let layer = &cels.get("a").unwrap().base;
        (0..=MAX_LEVEL as usize).flat_map(|level| layer.drawn(level).iter().map(move |&coord| (level, coord))).map(|(level, coord)| place(layer.slot(level, coord).unwrap())).collect()
    };
    for key in held(&deferred) {
        assert!(frame.0.get(&key) == every_call.0.get(&key), "slot {key:?} was built from the pixels as they were last");
    }
    assert!(slots < written, "a slot several calls changed is built once ({slots} of {written})");
    assert!(runs.len() < slots, "neighbours in a row are one write ({} for {slots} slots)", runs.len());
}

#[test]
fn slots_given_back_are_taken_lowest_first_and_a_row_becomes_one_write() {
    let mut noise = Noise(9);
    let mut cels = LiveCels::default();
    // A row of six tiles: its slots are side by side in the page.
    let row: Vec<(Coord, Option<Vec<u8>>)> = (0..6).map(|x| ((x, 0), Some(tile(&mut noise)))).collect();
    cels.update("a", false, row).unwrap();
    let runs = cels.take_runs();
    let widest = runs.iter().map(|run| run.cells).max().unwrap();
    assert!(widest >= 8, "a row of tiles with their halos is written as a run ({widest} cells)");
    // Removing them and drawing others again takes the same low slots, not scattered ones.
    let before = cels.stats().slots;
    update(&mut cels, "a", false, (0..6).map(|x| ((x, 0), None)).collect()).unwrap();
    assert_eq!(cels.stats().slots, 0);
    update(&mut cels, "a", false, (10..16).map(|x| ((x, 7), Some(tile(&mut noise)))).collect()).unwrap();
    assert_eq!(cels.stats().slots, before);
    assert_eq!(cels.pages(), 1, "the slots given back are used before new pages");
}

/// The reduction as the texel-by-texel formula states it (the published path's `downTile`).
fn reduced_by_the_formula(below: &HashMap<Coord, Vec<u8>>, tx: i32, ty: i32) -> Option<Vec<u8>> {
    let subs = [below.get(&(2 * tx, 2 * ty)), below.get(&(2 * tx + 1, 2 * ty)), below.get(&(2 * tx, 2 * ty + 1)), below.get(&(2 * tx + 1, 2 * ty + 1))];
    if subs.iter().all(Option::is_none) {
        return None;
    }
    let (t, h) = (TILE as usize, TILE as usize / 2);
    let mut out = vec![0u8; TILE_BYTES];
    for (q, sub) in subs.iter().enumerate() {
        let Some(sub) = sub else { continue };
        for py in 0..h {
            for px in 0..h {
                let i = (2 * py * t + 2 * px) * 4;
                let texels = [i, i + 4, i + t * 4, i + t * 4 + 4];
                let alpha: u32 = texels.iter().map(|&k| u32::from(sub[k + 3])).sum();
                if alpha == 0 {
                    continue;
                }
                let o = (((q >> 1) * h + py) * t + (q & 1) * h + px) * 4;
                for c in 0..3 {
                    let weighted: u32 = texels.iter().map(|&k| u32::from(sub[k + c]) * u32::from(sub[k + 3])).sum();
                    out[o + c] = ((2 * weighted + alpha) / (2 * alpha)) as u8;
                }
                out[o + 3] = ((alpha + 2) / 4) as u8;
            }
        }
    }
    Some(out)
}

#[test]
fn reduced_tiles_equal_the_formula_for_opaque_translucent_and_empty_texels() {
    let mut noise = Noise(77);
    let mut below: HashMap<Coord, Vec<u8>> = HashMap::new();
    for coord in [(0, 0), (1, 0), (0, 1)] {
        // Quarters of opaque, empty and random alpha, so every branch of the reduction runs.
        let mut pixels = vec![0u8; TILE_BYTES];
        for (index, texel) in pixels.chunks_exact_mut(4).enumerate() {
            let alpha = match (index / 7 + (index / 64) / 5) % 4 {
                0 => 255,
                1 => 0,
                _ => noise.next() as u8,
            };
            texel.copy_from_slice(&[noise.next() as u8, noise.next() as u8, noise.next() as u8, alpha]);
        }
        below.insert(coord, pixels);
    }
    let fast: HashMap<Coord, Vec<u8>, CoordBuild> = below.iter().map(|(c, p)| (*c, p.clone())).collect();
    for coord in [(0, 0), (1, 0), (-1, -1), (0, -1)] {
        assert_eq!(crate::drawing::down_tile(&fast, coord.0, coord.1), reduced_by_the_formula(&below, coord.0, coord.1), "reduced tile {coord:?}");
    }
}

#[test]
fn a_neighbour_is_rewritten_only_when_the_edge_it_copies_changed() {
    let mut noise = Noise(31);
    let mut cels = LiveCels::default();
    let base = tile(&mut noise);
    update(&mut cels, "a", false, vec![((0, 0), Some(base.clone()))]).unwrap();
    let level0 = |cels: &LiveCels, written: &[Upload], at: Coord| {
        let (page, x, y) = place(cels.get("a").unwrap().base.slot(0, at).expect("a drawn tile has a slot"));
        written.iter().any(|u| (u.page, u.x, u.y) == (page, x, y))
    };
    let texel = |x: usize, y: usize| (y * TILE as usize + x) * 4;
    // A texel well inside the tile: its own slot only (at level 0).
    let mut inside = base.clone();
    inside[texel(30, 30)..texel(30, 30) + 4].copy_from_slice(&[9, 8, 7, 255]);
    let written = update(&mut cels, "a", false, vec![((0, 0), Some(inside.clone()))]).unwrap();
    assert!(level0(&cels, &written, (0, 0)));
    for dy in -1..=1 {
        for dx in -1..=1 {
            assert!((dx, dy) == (0, 0) || !level0(&cels, &written, (dx, dy)), "the neighbour at ({dx}, {dy}) holds nothing of that texel");
        }
    }
    // A texel on the right edge: the tile to its right copies it, the others do not.
    let mut edge = inside.clone();
    edge[texel(63, 30)..texel(63, 30) + 4].copy_from_slice(&[1, 2, 3, 255]);
    let written = update(&mut cels, "a", false, vec![((0, 0), Some(edge))]).unwrap();
    assert!(level0(&cels, &written, (0, 0)) && level0(&cels, &written, (1, 0)));
    assert!(!level0(&cels, &written, (-1, 0)) && !level0(&cels, &written, (0, 1)) && !level0(&cels, &written, (1, 1)), "only the neighbour beside that edge changes");
}

#[test]
fn the_picture_budget_follows_the_clock_and_returns_to_the_full_amount_by_itself() {
    const FULL: usize = 8 << 20;
    let mut noise = Noise(8);
    let mut cels = LiveCels::default();
    assert_eq!(cels.picture_budget(0.0, FULL), FULL, "nothing is held or has changed");
    update(&mut cels, "a", false, vec![((0, 0), Some(tile(&mut noise)))]).unwrap();
    cels.changed(1000.0);
    assert_eq!(cels.picture_budget(1000.0, FULL), CHANGING_PICTURE_BYTES, "a cel is changing");
    assert_eq!(cels.picture_budget(1000.0 + CHANGING_MS - 1.0, FULL), CHANGING_PICTURE_BYTES);
    assert_eq!(cels.picture_budget(1000.0 + CHANGING_MS, FULL), SETTLING_PICTURE_BYTES, "and then a moment of smaller bursts");
    // No frame has to be drawn for it to end: the clock alone does.
    assert_eq!(cels.picture_budget(1000.0 + CHANGING_MS + SETTLING_MS, FULL), FULL, "a held, quiet cel (Draw left, a jump, playback) loads at the full amount");
    assert_eq!(cels.picture_budget(1.0e9, FULL), FULL);
    // A cel that changes again starts over; a document that lets go of its cels is not slowed at all.
    cels.changed(5000.0);
    assert_eq!(cels.picture_budget(5100.0, FULL), CHANGING_PICTURE_BYTES);
    cels.drop_cel("a");
    assert_eq!(cels.picture_budget(5100.0, FULL), FULL);
    // The caller's own limit is never raised.
    cels.update("a", false, vec![((0, 0), Some(tile(&mut noise)))]).unwrap();
    cels.changed(6000.0);
    assert_eq!(cels.picture_budget(6000.0, 100), 100);
}

/// A copy of `pixels` with a `size` × `size` block at `(x, y)` painted: opaque, translucent or cleared.
fn dabbed(pixels: &[u8], x: usize, y: usize, size: usize, noise: &mut Noise) -> Vec<u8> {
    let mut out = pixels.to_vec();
    let (t, kind) = (TILE as usize, noise.next() % 3);
    let color = [noise.next() as u8, noise.next() as u8, noise.next() as u8, match kind { 0 => 255, 1 => 1 + (noise.next() % 254) as u8, _ => 0 }];
    for row in y..(y + size).min(t) {
        for column in x..(x + size).min(t) {
            out[(row * t + column) * 4..][..4].copy_from_slice(&color);
        }
    }
    out
}

#[test]
fn small_edits_leave_every_level_as_the_published_decode_makes_it() {
    let mut noise = Noise(64);
    let mut tiles: HashMap<Coord, Vec<u8>> = HashMap::new();
    let mut cels = LiveCels::default();
    let mut atlas = Atlas::default();
    let first: Vec<(Coord, Option<Vec<u8>>)> = [(0, 0), (1, 0), (0, 1), (1, 1), (-1, 0), (2, 3), (5, 5)].into_iter().map(|c| (c, Some(tile(&mut noise)))).collect();
    for (coord, pixels) in &first {
        tiles.insert(*coord, pixels.clone().unwrap());
    }
    atlas.write(update(&mut cels, "a", false, first).unwrap());
    matches_published(&cels, &atlas, "a", &tiles);
    for round in 0..60 {
        let coord = [(0, 0), (1, 0), (0, 1), (1, 1), (-1, 0), (2, 3), (5, 5), (3, 3)][(noise.next() % 8) as usize];
        let (x, y, size) = ((noise.next() % 64) as usize, (noise.next() % 64) as usize, 1 + (noise.next() % 9) as usize);
        let changes = match (tiles.get(&coord), noise.next() % 9) {
            (Some(_), 0) => {
                tiles.remove(&coord);
                vec![(coord, None)]
            }
            (Some(pixels), _) => {
                let next = dabbed(pixels, x, y, size, &mut noise);
                tiles.insert(coord, next.clone());
                vec![(coord, Some(next))]
            }
            (None, _) => {
                let next = dabbed(&vec![0u8; TILE_BYTES], x, y, size, &mut noise);
                tiles.insert(coord, next.clone());
                vec![(coord, Some(next))]
            }
        };
        atlas.write(update(&mut cels, "a", false, changes).unwrap());
        if tiles.values().any(|pixels| visible(pixels)) {
            matches_published(&cels, &atlas, "a", &tiles.iter().filter(|(_, pixels)| visible(pixels)).map(|(c, p)| (*c, p.clone())).collect());
        }
        let _ = round;
    }
}

#[test]
fn a_reduction_made_again_only_where_the_tiles_below_changed_equals_the_whole_one() {
    use crate::drawing::{changed_rect, down_tile, down_tile_patch};
    let mut noise = Noise(90);
    for trial in 0..40 {
        let mut below: HashMap<Coord, Vec<u8>> = HashMap::new();
        for coord in [(0, 0), (1, 0), (0, 1), (1, 1)] {
            if noise.next() % 4 != 0 {
                below.insert(coord, tile(&mut noise));
            }
        }
        if below.is_empty() {
            continue;
        }
        let previous = down_tile(&below, 0, 0).expect("a child exists");
        // One child changes in a small block (or is removed, or appears).
        let coord = [(0, 0), (1, 0), (0, 1), (1, 1)][(noise.next() % 4) as usize];
        let before = below.get(&coord).cloned();
        let after = match (noise.next() % 6, &before) {
            (0, Some(_)) => None,
            (_, Some(pixels)) => Some(dabbed(pixels, (noise.next() % 64) as usize, (noise.next() % 64) as usize, 1 + (noise.next() % 12) as usize, &mut noise)),
            (_, None) => Some(dabbed(&vec![0u8; TILE_BYTES], (noise.next() % 64) as usize, (noise.next() % 64) as usize, 1 + (noise.next() % 12) as usize, &mut noise)),
        };
        match &after {
            Some(pixels) => below.insert(coord, pixels.clone()),
            None => below.remove(&coord),
        };
        let Some([x0, y0, x1, y1]) = changed_rect(before.as_deref(), after.as_deref()) else { continue };
        let (ox, oy) = ((coord.0 as usize) * 32, (coord.1 as usize) * 32);
        let rect = [ox + x0 / 2, oy + y0 / 2, ox + x1.div_ceil(2), oy + y1.div_ceil(2)];
        let whole = down_tile(&below, 0, 0);
        let patched = down_tile_patch(&below, 0, 0, &previous, rect);
        assert!(whole.as_deref() == Some(patched.as_slice()) || (whole.is_none() && patched.iter().all(|&byte| byte == 0)), "trial {trial}: the patched reduction equals the whole one");
    }
}

#[test]
fn warming_the_levels_beside_the_shown_ones_in_slices_leaves_a_zoom_nothing_to_write() {
    let mut noise = Noise(17);
    let mut tiles: HashMap<Coord, Vec<u8>> = HashMap::new();
    let mut cels = LiveCels::new(0b11);
    let mut atlas = Atlas::default();
    edit_rounds(&mut noise, 20, &mut tiles, |changes| atlas.write(update(&mut cels, "a", false, changes).unwrap()));
    // The cel was edited while only levels 0 and 1 were written: the others hold what they held.
    assert_eq!(cels.warm(0, 100), 0, "nothing is shown, nothing is beside it");
    let mut left = usize::MAX;
    let mut slices = 0;
    let mut written = 0;
    while left > 0 {
        left = cels.warm(0b11, 40);
        let runs = cells_of(cels.take_runs());
        assert!(runs.len() <= 40, "a slice is at most what it was asked for");
        written += runs.len();
        atlas.write(runs);
        slices += 1;
        assert!(slices < 500);
    }
    assert!(slices > 1 && written > 0, "the stale slots took several slices ({slices}, {written} slots)");
    // Level 2 is beside the shown levels and now current: a zoom to it writes nothing.
    assert!(set_resident(&mut cels, 0b111).is_empty(), "nothing is left stale at the level the view zooms to");
    // And whatever is finally resident, every level is as the published decode makes it.
    atlas.write(set_resident(&mut cels, ALL_LEVELS));
    if !tiles.is_empty() {
        matches_published(&cels, &atlas, "a", &tiles);
    }
}

#[test]
fn a_warmed_level_is_written_again_when_its_tiles_change_and_it_is_not_shown() {
    let mut noise = Noise(18);
    let mut cels = LiveCels::new(0b1);
    let mut atlas = Atlas::default();
    let mut tiles: HashMap<Coord, Vec<u8>> = HashMap::new();
    edit_rounds(&mut noise, 8, &mut tiles, |changes| atlas.write(update(&mut cels, "a", false, changes).unwrap()));
    while cels.warm(0b1, 1000) > 0 {
        atlas.write(cells_of(cels.take_runs()));
    }
    atlas.write(cells_of(cels.take_runs()));
    edit_rounds(&mut noise, 8, &mut tiles, |changes| atlas.write(update(&mut cels, "a", false, changes).unwrap()));
    // Levels changed after the warm-up are stale again, and arrive when called for.
    atlas.write(set_resident(&mut cels, ALL_LEVELS));
    if !tiles.is_empty() {
        matches_published(&cels, &atlas, "a", &tiles);
    }
}

#[test]
fn a_page_can_be_reserved_before_any_slot_is_taken() {
    let mut noise = Noise(3);
    let mut cels = LiveCels::default();
    assert_eq!(cels.pages(), 0);
    cels.reserve();
    assert_eq!((cels.pages(), cels.stats().slots), (1, 0), "room for a page, nothing held");
    // The first tile takes the reserved slot, not a second one.
    let uploads = update(&mut cels, "a", false, vec![((0, 0), Some(tile(&mut noise)))]).unwrap();
    assert_eq!(cels.pages(), 1);
    assert!(uploads.iter().any(|u| (u.page, u.x, u.y) == (0, BORDER, BORDER)), "slot 0 is the first one used");
    // Reserving again, with a cel held, changes nothing.
    cels.reserve();
    assert_eq!((cels.pages(), cels.stats().slots), (1, 81));
}
