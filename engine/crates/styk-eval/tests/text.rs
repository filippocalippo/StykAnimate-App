//! Text in draw lists.
//!
//! `tests/fixtures/drawlist/outlined-text.json` holds one glyph of a Pivot text
//! figure (from `finisher tdd2.piv`) with three figure outlines: 1.5 wide at
//! scale 1, 4 wide at scale 2.5, and 8 wide at half opacity at scale 4, all red.
//! The app-parity rule (D13) compared the pixels with the editor's renderers.

use std::path::Path;
use std::sync::Arc;

use styk_eval::assets::Assets;
use styk_eval::drawlist::{encode_composed, rgba8, GlyphMask, LayerKind, Overrides, Prim, F_GLYPH_VECTOR, K_GLYPH, K_TRI, NO_LAYER};
use styk_eval::geometry::build;

fn open() -> styk_eval::doc::Document {
    styk_eval::open(&Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/drawlist/outlined-text.json")).expect("fixture")
}

fn outline_triangles(doc: styk_eval::doc::Document) -> usize {
    let assets = Assets::build(&doc);
    let prepared = styk_eval::prepare(doc);
    let scene = build(&prepared.doc, &prepared.evaluate(0.0));
    let list = encode_composed(&prepared.doc, &assets, &scene, &Overrides { hidden: &[], translations: &[], background: None, bypass_effects: false, generators: None, live: None }, &[], None);
    let red = rgba8([220, 30, 30], 1.0);
    list.prims.iter().filter(|p| p.kind & 255 == K_TRI && p.color == red).count()
}

#[test]
fn a_figure_outline_strokes_its_text() {
    let doc = open();
    assert!(outline_triangles(doc) > 0, "outlined text draws its outline");
}

#[test]
fn text_without_a_figure_outline_has_none() {
    let mut doc = open();
    for figure in &mut doc.figures {
        Arc::make_mut(figure).outline = None;
    }
    assert_eq!(outline_triangles(doc), 0);
}

/// The draw list of the fixture's first frame, with `edit` applied to the document first.
fn frame(edit: impl FnOnce(&mut styk_eval::doc::Document)) -> styk_eval::drawlist::DrawList {
    let mut doc = open();
    edit(&mut doc);
    let assets = Assets::build(&doc);
    let prepared = styk_eval::prepare(doc);
    let scene = build(&prepared.doc, &prepared.evaluate(0.0));
    encode_composed(&prepared.doc, &assets, &scene, &Overrides { hidden: &[], translations: &[], background: None, bypass_effects: false, generators: None, live: None }, &[], None)
}

/// The raster layer each glyph triangle of `list` is drawn on, outermost first.
fn text_layers(list: &styk_eval::drawlist::DrawList) -> Vec<LayerKind> {
    let mut groups: Vec<u32> = list.prims.iter().filter(|p| p.kind == K_TRI).map(|p| p.group).collect();
    groups.dedup();
    groups
        .into_iter()
        .map(|mut g| {
            while g != 0 && list.groups[g as usize].layer == NO_LAYER {
                g = list.groups[g as usize].parent;
            }
            list.layers.get(list.groups[g as usize].layer as usize).map(|l| l.kind).unwrap_or_else(|| panic!("glyph triangles of group {g} outside any raster"))
        })
        .collect()
}

fn without_outlines(doc: &mut styk_eval::doc::Document) {
    for figure in &mut doc.figures {
        Arc::make_mut(figure).outline = None;
    }
}

/// The editor's WebGPU renderer draws an object holding text from a Canvas 2D raster of
/// the object (`requiresCompatibilityTexture`, `rasterObject`): a raster entry on its
/// `objectBounds`, as `objectBounds` measures them (`renderer-geometry.mjs`).
#[test]
fn text_is_drawn_from_a_raster_of_its_object() {
    let layers = text_layers(&frame(|_| {}));
    // The editor's `objectBounds` of the three objects, outlines included.
    let bounds = [[140.0, 223.0, 37.0, 37.0], [374.0, 181.0, 95.0, 95.0], [595.0, 126.0, 180.0, 179.0]];
    // Outlined text is no lone solid glyph: each object, outline and text, on one raster
    // entry (the half-opaque outline of the third in a group of its own inside it).
    let mut distinct: Vec<LayerKind> = Vec::new();
    for layer in layers {
        if !distinct.contains(&layer) {
            distinct.push(layer);
        }
    }
    assert_eq!(distinct.len(), 3, "{distinct:?}");
    // Prims are stored deepest group first: compare in the objects' left-to-right order.
    let left = |layer: &LayerKind| match layer {
        LayerKind::Raster { bounds } => bounds[0],
        _ => f64::NAN,
    };
    distinct.sort_by(|a, b| left(a).total_cmp(&left(b)));
    for (layer, expected) in distinct.iter().zip(bounds) {
        assert!(matches!(layer, LayerKind::Raster { bounds } if *bounds == expected), "{layer:?} against {expected:?}");
    }
}

/// One solid glyph is drawn from a mask of its own (`glyphTextureDescriptor`), not from
/// its object's raster: a `K_GLYPH` record whose mask layout is the editor's for every
/// density (printed by the editor for this fixture without its outlines at densities 1 and
/// 2.38), followed by its own triangles for views that allow no mask.
#[test]
fn a_lone_glyph_is_drawn_from_a_mask_of_its_own() {
    let list = frame(without_outlines);
    assert!(list.layers.is_empty(), "no raster entry: {:?}", list.layers);
    let expected = [
        [(32, 32, [148.76476182302991, 231.57142979758126], [19.763810831521177, 19.65714154924665]), (64, 64, [149.42355551741397, 232.22666784922282], [18.446223442753098, 18.34666544596354])],
        [(64, 64, [398.5588887935349, 205.56666962305707], [46.11555860688274, 45.86666361490885]), (256, 256, [399.656878284175, 206.65873304245963], [43.919579625602616, 43.682536776103674])],
        [(128, 128, [648.8843010014464, 180.09032723211473], [71.40473590743134, 71.01935011340726]), (256, 256, [649.45100525468, 180.6539728679354], [70.27132740096418, 69.89205884176587])],
    ];
    let records: Vec<&Prim> = list.prims.iter().filter(|p| p.kind & 255 == K_GLYPH).collect();
    assert_eq!((records.len(), list.glyphs.len()), (3, 3));
    let mut instances: Vec<usize> = records.iter().map(|p| p.b[0].to_bits() as usize).collect();
    instances.sort_by(|&a, &b| list.glyphs[a].mask.origin[0].total_cmp(&list.glyphs[b].mask.origin[0]));
    for (&index, masks) in instances.iter().zip(expected) {
        let glyph = &list.glyphs[index];
        // Its triangles follow, flagged, pointing at the same glyph.
        let vector = list.prims.iter().filter(|p| p.kind == K_TRI | F_GLYPH_VECTOR && p.b[2].to_bits() as usize == index).count();
        assert_eq!(vector * 3, glyph.triangles.len(), "glyph {index}: its triangles for views without a mask");
        for (resolution, (w, h, at, axes)) in [1.0, 2.378414230005442].into_iter().zip(masks) {
            let mask = glyph.mask.layout(resolution, GlyphMask::MAX_DIMENSION).expect("a mask");
            assert_eq!((mask.width, mask.height), (w, h));
            let m = mask.to_world;
            let near = |a: f64, b: f64| (a - b).abs() < 1e-4;
            assert!(near(m[4], at[0]) && near(m[5], at[1]), "{m:?} against {at:?}");
            assert!(near(m[0] * w as f64, axes[0]) && near(m[3] * h as f64, axes[1]) && m[1].abs() < 1e-9 && m[2].abs() < 1e-9, "{m:?} against {axes:?}");
        }
    }
    assert!(!list.prims.iter().any(|p| p.kind == K_TRI), "every triangle is a lone glyph's");
}

/// Text of several characters is drawn from the object's raster even without an outline.
#[test]
fn text_of_several_characters_is_drawn_from_the_object_raster() {
    let layers = text_layers(&frame(|doc| {
        without_outlines(doc);
        for figure in &mut doc.figures {
            for text in &mut Arc::make_mut(figure).texts {
                let (g, x, y) = text.placements[0];
                text.placements.push((g, x + 20.0, y));
            }
        }
    }));
    assert_eq!(layers.len(), 3);
    assert!(layers.iter().all(|layer| matches!(layer, LayerKind::Raster { .. })), "{layers:?}");
}

/// Large text flattens its curves finer, within the same distance of its outline in the
/// world as small text: Pivot text scaled 60 times drew curves a pixel off at the fitted view.
#[test]
fn large_text_flattens_its_curves_finer() {
    use styk_eval::assets::{glyph_level, GLYPH_TOLERANCE, GLYPH_WORLD_TOLERANCE};
    assert_eq!(glyph_level(1.0, 1.0), 0);
    assert_eq!(glyph_level(-4.0, 2.5), 0);
    assert_eq!(glyph_level(57.4, 60.0), 4);
    for scale in [6.0, 40.0, 300.0, 1e4] {
        let level = glyph_level(scale, 1.0);
        let world = GLYPH_TOLERANCE as f64 / f64::from(1u32 << level) * scale;
        assert!(world <= GLYPH_WORLD_TOLERANCE || level == styk_eval::assets::GLYPH_MAX_LEVEL, "scale {scale}: level {level} flattens within {world}");
    }
    let triangles = |scale: f64| frame(|doc| {
        without_outlines(doc);
        for keyframe in &mut doc.keyframes {
            for object in &mut Arc::make_mut(keyframe).objects {
                Arc::make_mut(object).scale *= scale;
            }
        }
    })
    .prims
    .iter()
    .filter(|p| p.kind & 255 == K_TRI)
    .count();
    assert!(triangles(30.0) > triangles(1.0), "a glyph drawn 30 times larger has more triangles");
}
