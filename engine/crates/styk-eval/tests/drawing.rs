//! Drawing cels in assets and draw lists.
//!
//! `tests/fixtures/drawlist/drawing-cel.json` holds the largest drawing cel of
//! `Jay on a new app (repaired).styk` (2,248 × 382 cel pixels at 2 pixels per
//! unit), one object of it in the middle of the canvas.
//! The app-parity rule (D13) compared the pixels with the editor's
//! GPU drawing display at several zoom levels.

use std::path::Path;
use std::sync::Arc;

use styk_eval::assets::{decode_cel, Assets};
use styk_eval::drawlist::{encode_composed, Overrides, F_DRAWING, NO_PAINT};
use styk_eval::geometry::build;

#[test]
fn every_level_of_a_cel_is_placed_decoded_and_drawn() {
    let doc = styk_eval::open(&Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/drawlist/drawing-cel.json")).expect("fixture");
    let assets = Assets::build(&doc);
    assert_eq!(assets.cels.len(), 1);
    let (cel, starts) = assets.cels.values().next().expect("one cel");
    assert_eq!(cel.levels.len(), styk_eval::drawing::MAX_LEVEL as usize + 1);
    let slots: usize = cel.levels.iter().map(Vec::len).sum();
    assert_eq!(assets.drawing.len(), slots);
    assert!(starts.windows(2).all(|pair| pair[0] <= pair[1]));
    // Each level holds fewer tiles than the one below, down to a tile and its halo.
    assert!(cel.levels.windows(2).all(|pair| pair[1].len() <= pair[0].len()));

    let decoded = decode_cel(&assets, cel);
    assert_eq!(decoded.len(), slots, "a slot per drawn tile and level");
    assert!(decoded.iter().all(|image| image.drawing && image.width == 68 && image.height == 68));
    assert!(decoded.iter().any(|image| image.rgba.chunks_exact(4).any(|texel| texel[3] != 0)), "the cel has visible texels");

    let prepared = styk_eval::prepare(doc);
    let scene = build(&prepared.doc, &prepared.evaluate(0.0));
    let list = encode_composed(&prepared.doc, &assets, &scene, &Overrides { hidden: &[], translations: &[], background: None, bypass_effects: false, generators: None, live: None }, &[], None);
    let drawn = list.prims.iter().filter(|p| p.kind & F_DRAWING != 0).count();
    assert_eq!(drawn, slots, "every level's tiles are in the list; the shader keeps one level");
    for (level, tiles) in cel.levels.iter().enumerate() {
        let at_level = list.prims.iter().filter(|p| p.kind & F_DRAWING != 0 && p.b[3] == level as f32).count();
        assert_eq!(at_level, tiles.len(), "level {level}");
    }
}

#[test]
fn parent_tiles_cover_negative_coordinates_in_the_right_quadrant() {
    let mut doc = styk_eval::open(&Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/drawlist/drawing-cel.json")).expect("fixture");
    let figure = Arc::make_mut(&mut doc.figures[0]);
    let cel = Arc::make_mut(figure.images.iter_mut().find_map(|image| image.tiles.as_mut()).expect("a cel"));
    for (tx, ty, _) in &mut cel.tiles {
        *tx -= 30;
        *ty -= 4;
    }
    cel.levels = styk_eval::drawing::level_tiles(&cel.tiles);
    let prepared = styk_eval::prepare(doc);
    let assets = Assets::build(&prepared.doc);
    let (cel, starts) = assets.cels.values().next().unwrap();
    let decoded = decode_cel(&assets, cel);
    let decoded_indices: Vec<_> = decoded.iter().map(|image| image.index).collect();
    let scene = build(&prepared.doc, &prepared.evaluate(0.0));
    let list = encode_composed(&prepared.doc, &assets, &scene, &Overrides::default(), &[], None);
    let drawn: Vec<_> = list.prims.iter().filter(|p| p.kind & F_DRAWING != 0).collect();
    let mut at = 0;
    let mut quadrants = [false; 4];
    for (level, tiles) in cel.levels.iter().enumerate() {
        for (i, &(tx, ty)) in tiles.iter().enumerate() {
            let p = drawn[at + i];
            assert_eq!(p.b[3], level as f32);
            if level + 1 == cel.levels.len() {
                assert_eq!(p.paint, NO_PAINT, "the last level has no parent");
                continue;
            }
            let row = list.paints[p.paint as usize];
            let parent = assets.drawing.iter().find(|entry| entry.layer as f32 == row[0] && entry.x as f32 == row[1] && entry.y as f32 == row[2]).expect("parent atlas slot");
            let parent_index = assets.drawing.iter().position(|entry| std::ptr::eq(entry, parent)).unwrap() as u32 - starts[level + 1];
            let parent_slot = starts[level + 1] + parent_index;
            let child_slot = starts[level] + i as u32;
            let parent_decoded = decoded_indices.iter().position(|&index| index == parent_slot).expect("every named parent is decoded");
            let child_decoded = decoded_indices.iter().position(|&index| index == child_slot).expect("every child is decoded");
            assert!(parent_decoded > child_decoded, "the engine's LIFO image queue uploads parent level {} before child level {level}", level + 1);
            let (px, py) = cel.levels[level + 1][parent_index as usize];
            let q = row[3] as usize;
            quadrants[q] = true;
            assert_eq!(tx, 2 * px + (q & 1) as i32, "parent covers tile x={tx}");
            assert_eq!(ty, 2 * py + (q >> 1) as i32, "parent covers tile y={ty}");
        }
        at += tiles.len();
    }
    assert!(quadrants.into_iter().all(|seen| seen), "all four quadrants are exercised");
}

#[test]
fn dragging_a_cel_moves_its_quads_without_moving_parent_atlas_references() {
    let doc = styk_eval::open(&Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/drawlist/drawing-cel.json")).expect("fixture");
    let prepared = styk_eval::prepare(doc);
    let assets = Assets::build(&prepared.doc);
    let scene = build(&prepared.doc, &prepared.evaluate(0.0));
    let original = encode_composed(&prepared.doc, &assets, &scene, &Overrides::default(), &[], None);
    let delta = [17.25, -8.5];
    let moved = encode_composed(&prepared.doc, &assets, &scene, &Overrides { translations: &[(0, delta)], ..Default::default() }, &[], None);
    assert!(original.paints.len() > 2, "the cel must have parent references to translate past");
    assert_eq!(moved.paints, original.paints, "dragging artwork cannot change atlas coordinates or quadrants");
    let tiles = |list: &styk_eval::drawlist::DrawList| list.prims.iter().filter(|p| p.kind & F_DRAWING != 0).copied().collect::<Vec<_>>();
    let (before, after) = (tiles(&original), tiles(&moved));
    assert_eq!(before.len(), after.len());
    for (before, after) in before.iter().zip(&after) {
        assert_eq!(after.a, [before.a[0] + delta[0] as f32, before.a[1] + delta[1] as f32, before.a[2], before.a[3]]);
        assert_eq!(after.paint, before.paint);
        assert_eq!(after.b, before.b);
        assert_eq!(after.c, before.c);
    }
}

#[test]
fn drawing_artwork_bounds_follow_the_ink_instead_of_whole_tiles() {
    let doc = styk_eval::open(&Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/drawlist/drawing-cel.json")).expect("fixture");
    let prepared = styk_eval::prepare(doc);
    let assets = Assets::build(&prepared.doc);
    let scene = build(&prepared.doc, &prepared.evaluate(0.0));
    // Recorded with objectBounds(editor.geometry.drawables, {vfxBounds:false})
    // on this editor-built fixture. Its ink starts inside negative-coordinate tiles.
    assert_eq!(styk_eval::drawlist::artwork_bounds(&assets, &scene), Some([-56.0, -100.0, 2254.0, 388.0]));
}

/// The same fixture's tiles held live: the draw list shows what the published cel shows.
#[test]
fn a_live_cel_replaces_the_published_one_quad_for_quad() {
    use styk_eval::live::{LiveCels, LiveView};

    let doc = styk_eval::open(&Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/drawlist/drawing-cel.json")).expect("fixture");
    let id = doc.figures[0].images.iter().find_map(|image| image.cel.as_ref()).expect("a drawing cel with an identity").id.clone();
    let prepared = styk_eval::prepare(doc);
    let assets = Assets::build(&prepared.doc);
    let scene = build(&prepared.doc, &prepared.evaluate(0.0));
    let published = encode_composed(&prepared.doc, &assets, &scene, &Overrides::default(), &[], None);
    let cel = assets.cels.values().next().expect("one cel").0.clone();

    let mut live = LiveCels::default();
    let tiles: Vec<_> = cel.tiles.iter().map(|(tx, ty, png)| ((*tx, *ty), Some(image::load_from_memory(png).expect("a tile").to_rgba8().into_raw()))).collect();
    live.update(&id, false, tiles.clone()).expect("room for the cel");
    // Hidden until shown: the published cel still draws.
    let view = LiveView { cels: &live, base: assets.pages };
    let hidden = encode_composed(&prepared.doc, &assets, &scene, &Overrides { live: Some(view), ..Default::default() }, &[], None);
    assert_eq!(hidden.prims, published.prims);
    live.show(&id, true, false);
    let view = LiveView { cels: &live, base: assets.pages };
    let shown = encode_composed(&prepared.doc, &assets, &scene, &Overrides { live: Some(view), ..Default::default() }, &[], None);

    let drawn = |list: &styk_eval::drawlist::DrawList| list.prims.iter().filter(|p| p.kind & F_DRAWING != 0).copied().collect::<Vec<_>>();
    let (before, after) = (drawn(&published), drawn(&shown));
    assert_eq!(before.len(), after.len(), "a quad for every tile of every level");
    let mut parents = 0;
    for (a, b) in before.iter().zip(&after) {
        assert_eq!((a.kind, a.color, a.a, a.b[0], a.b[1], a.b[3]), (b.kind, b.color, b.a, b.b[0], b.b[1], b.b[3]));
        assert!(b.b[2] >= assets.pages as f32, "the live slots follow the document's pages");
        assert_eq!(a.paint == NO_PAINT, b.paint == NO_PAINT, "the same quads have a parent");
        if a.paint != NO_PAINT {
            parents += 1;
            assert_eq!(published.paints[a.paint as usize][3], shown.paints[b.paint as usize][3], "the same quadrant of the parent");
        }
    }
    assert!(parents > 0);

    // A floating selection through the identity transform repeats the quads over the base.
    live.update(&id, true, tiles).unwrap();
    live.show(&id, true, true);
    let view = LiveView { cels: &live, base: assets.pages };
    let floating = drawn(&encode_composed(&prepared.doc, &assets, &scene, &Overrides { live: Some(view), ..Default::default() }, &[], None));
    assert_eq!(floating.len(), 2 * after.len());
    for (base, float) in floating[..after.len()].iter().zip(&floating[after.len()..]) {
        assert_eq!((base.a, base.b[0], base.b[1], base.b[3]), (float.a, float.b[0], float.b[1], float.b[3]));
    }
    // Moved by a whole tile, the quads move by the figure's placement of 64 cel pixels.
    live.set_matrix(&id, [1.0, 0.0, 0.0, 1.0, 64.0, 0.0]);
    let view = LiveView { cels: &live, base: assets.pages };
    let moved = drawn(&encode_composed(&prepared.doc, &assets, &scene, &Overrides { live: Some(view), ..Default::default() }, &[], None));
    let shift = |q: &styk_draw::Prim, r: &styk_draw::Prim| (r.a[0] - q.a[0]).hypot(r.a[1] - q.a[1]);
    let first = shift(&moved[0], &moved[after.len()]);
    assert!(first > 0.0, "the floating copy moved off the base");
    for (base, float) in moved[..after.len()].iter().zip(&moved[after.len()..]).take(50) {
        assert!((shift(base, float) - first).abs() < 1e-3, "every quad moves alike");
        assert_eq!((base.a[2], base.a[3]), (float.a[2], float.a[3]), "a translation keeps the quad's axes");
    }
}
