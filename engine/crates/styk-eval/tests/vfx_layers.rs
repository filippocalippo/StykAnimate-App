//! Effect layers in draw lists: which groups get a raster of their own, how
//! they nest, and the rectangles they are filtered on (docs/engine/vfx.md,
//! Rendering). The effects themselves are checked against the editor in
//! `tests/vfx.rs`; pixels were compared in the app (D13).

use std::path::{Path, PathBuf};

use styk_eval::assets::Assets;
use styk_eval::drawlist::{encode_composed, layer_effects, DrawList, LayerKind, Overrides, K_COMPOSITE, NO_LAYER};
use styk_eval::geometry::build;
use styk_eval::vfx::Kind;

fn folder() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/vfx")
}

fn encode(name: &str, tick: f64, bypass: bool) -> DrawList {
    let doc = styk_eval::open(&folder().join(format!("{name}.json"))).unwrap_or_else(|e| panic!("{name}: {e}"));
    let prepared = styk_eval::prepare(doc);
    let assets = Assets::build(&prepared.doc);
    let frame = prepared.evaluate(tick);
    let scene = build(&prepared.doc, &frame);
    let overrides = Overrides { hidden: &[], translations: &[], background: None, bypass_effects: bypass, generators: None, live: None };
    encode_composed(&prepared.doc, &assets, &scene, &overrides, &[], None)
}

/// The layer kind of group `g`, if it has one.
fn kind(list: &DrawList, g: usize) -> Option<LayerKind> {
    let layer = list.groups[g].layer;
    (layer != NO_LAYER).then(|| list.layers[layer as usize].kind)
}

fn kinds(list: &DrawList, g: usize) -> Vec<Kind> {
    let layer = list.groups[g].layer;
    if layer == NO_LAYER { Vec::new() } else { layer_effects(&list.layers[layer as usize]).iter().map(|e| e.kind()).collect() }
}

/// The nearest entry above (or at) group `g`.
fn entry_of(list: &DrawList, mut g: usize) -> Option<usize> {
    while g != 0 {
        if matches!(kind(list, g), Some(LayerKind::Entry { .. })) {
            return Some(g);
        }
        g = list.groups[g].parent as usize;
    }
    None
}

fn contains(outer: [f64; 4], inner: [f64; 4]) -> bool {
    outer[0] <= inner[0] && outer[1] <= inner[1] && outer[0] + outer[2] >= inner[0] + inner[2] && outer[1] + outer[3] >= inner[1] + inner[3]
}

/// Every nested layer sits inside an entry, on rectangles inside the entry's; every
/// domain lies inside its padded bounds; every filtered group composites once.
fn check_structure(list: &DrawList) {
    for g in 1..list.groups.len() {
        match kind(list, g) {
            Some(LayerKind::Nested { bounds, domain, .. }) => {
                let entry = entry_of(list, g).unwrap_or_else(|| panic!("nested layer {g} outside any entry"));
                let Some(LayerKind::Entry { bounds: outer, .. }) = kind(list, entry) else { unreachable!() };
                assert!(contains(outer, bounds), "group {g}: {bounds:?} outside its entry's {outer:?}");
                assert!(contains(bounds, domain), "group {g}: domain {domain:?} outside {bounds:?}");
            }
            Some(LayerKind::Entry { bounds, domain, padding, .. }) => {
                assert!(entry_of(list, list.groups[g].parent as usize).is_none(), "entry {g} inside another entry");
                assert!(padding >= 0.0 && bounds[2] >= 1.0 && bounds[3] >= 1.0);
                if !kinds(list, g).is_empty() {
                    assert!(contains(bounds, domain), "entry {g}: domain {domain:?} outside {bounds:?}");
                }
            }
            _ => {}
        }
        let composites = list.prims.iter().filter(|p| p.kind & 255 == K_COMPOSITE && p.b[0].to_bits() as usize == g).count();
        assert!(composites <= 1, "group {g} composited {composites} times");
    }
}

#[test]
fn nodes_filter_inside_their_figure() {
    let list = encode("segments", 0.0, false);
    check_structure(&list);
    let nested: Vec<usize> = (1..list.groups.len()).filter(|&g| matches!(kind(&list, g), Some(LayerKind::Nested { .. }))).collect();
    assert!(!nested.is_empty(), "the node stacks have layers");
    for &g in &nested {
        // A node's layer is a child of its figure's entry, which holds no effect of its own.
        let parent = list.groups[g].parent as usize;
        assert!(matches!(kind(&list, parent), Some(LayerKind::Entry { .. })), "node layer {g} under {parent}");
        assert!(kinds(&list, parent).is_empty());
        assert!(!kinds(&list, g).is_empty());
    }
}

#[test]
fn connected_groups_nest_smaller_inside_larger() {
    // At tick 4 figure 1's group (outline, tint, its timed shadow) holds figure 2's (glow, bloom).
    let list = encode("attached", 4.0, false);
    check_structure(&list);
    let filtered: Vec<usize> = (1..list.groups.len()).filter(|&g| !kinds(&list, g).is_empty()).collect();
    let outer = filtered.iter().copied().find(|&g| kinds(&list, g).contains(&Kind::Outline) && kinds(&list, g).contains(&Kind::Tint)).expect("figure 1's connected group");
    assert!(matches!(kind(&list, outer), Some(LayerKind::Entry { .. })), "the outermost group is the entry");
    let inner = filtered.iter().copied().find(|&g| kinds(&list, g).contains(&Kind::Bloom)).expect("figure 2's connected group");
    assert_eq!(entry_of(&list, inner), Some(outer), "the inner group is filtered on the outer's grid");
    // Figure 1's own stack keeps only the clip without its parts (the blur).
    assert!(filtered.iter().any(|&g| kinds(&list, g) == vec![Kind::Blur]), "{:?}", filtered.iter().map(|&g| kinds(&list, g)).collect::<Vec<_>>());
}

#[test]
fn the_scene_stack_filters_a_camera_image_of_the_frame() {
    let list = encode("scene-clips", 4.0, false);
    check_structure(&list);
    let camera: Vec<usize> = (1..list.groups.len()).filter(|&g| matches!(kind(&list, g), Some(LayerKind::Camera { .. }))).collect();
    assert_eq!(camera.len(), 1);
    let g = camera[0];
    assert_eq!(list.groups[g].parent, 0);
    assert_eq!(kinds(&list, g).first(), Some(&Kind::Grade), "the scene's own stack, then its clips");
    // The camera image holds the frame's artwork again (the editor projects it over the unfiltered frame).
    let inside = list.prims.iter().filter(|p| p.group as usize == g).count();
    let root = list.prims.iter().filter(|p| p.group == 0 && p.kind & 255 != K_COMPOSITE).count();
    assert_eq!(inside, root, "background and figures in both");
    // It composites last, over everything else of the frame.
    let last = list.prims.iter().rev().find(|p| p.group == 0).unwrap();
    assert!(last.kind & 255 == K_COMPOSITE && last.b[0].to_bits() as usize == g);
}

#[test]
fn movieclip_containers_filter_their_contents() {
    let list = encode("movieclip", 3.0, false);
    check_structure(&list);
    let entries: Vec<Vec<Kind>> = (1..list.groups.len()).filter(|&g| matches!(kind(&list, g), Some(LayerKind::Entry { .. }))).map(|g| kinds(&list, g)).collect();
    // Both instances: the clip's own tinted scene, then instance 8's outline.
    assert!(entries.iter().any(|k| k == &vec![Kind::Tint, Kind::Outline]), "{entries:?}");
    assert!(entries.iter().any(|k| k.first() == Some(&Kind::Tint)), "{entries:?}");
}

#[test]
fn without_effects_nothing_has_a_layer() {
    for name in ["segments", "attached", "scene-clips", "movieclip", "pose-sheet"] {
        let list = encode(name, 0.0, true);
        assert!(list.layers.is_empty(), "{name}: effects bypassed");
        assert!(list.groups.iter().all(|g| g.layer == NO_LAYER));
    }
}

#[test]
fn layers_are_anchored_on_whole_units() {
    let list = encode("pose-sheet", 0.0, false);
    check_structure(&list);
    let mut seen = 0;
    for g in 1..list.groups.len() {
        if let Some(LayerKind::Entry { bounds, domain, padding, .. }) = kind(&list, g) {
            // `objectBounds` floors and ceils: every corner is a whole world unit.
            for v in bounds.iter().chain(domain.iter()) {
                assert_eq!(v.fract(), 0.0, "{bounds:?} {domain:?}");
            }
            // The effects' margin around the artwork: at most the largest item padding.
            let margin = domain[0] - bounds[0];
            assert!(margin >= 0.0 && margin <= padding.ceil() + 1.0, "{bounds:?} {domain:?} {padding}");
            seen += 1;
        }
    }
    assert!(seen > 0);
}

#[test]
fn artwork_bounds_reach_as_far_as_the_effects_on_it() {
    // Node stacks and movieclip containers' stacks pad the artwork's bounds (a library
    // preview is fitted to them, `drawableVfxPadding`); without effects only the strokes do.
    use styk_eval::drawlist::artwork_bounds;
    use styk_eval::vfx::layers::{item_extent, rounded, EMPTY};
    for name in ["segments", "movieclip"] {
        let doc = styk_eval::open(&folder().join(format!("{name}.json"))).unwrap();
        let prepared = styk_eval::prepare(doc);
        let assets = Assets::build(&prepared.doc);
        let scene = build(&prepared.doc, &prepared.evaluate(0.0));
        let mut plain = EMPTY;
        for it in &scene.items {
            if let Some(e) = item_extent(&scene, &assets, it) {
                e.include(&mut plain, 0.0);
            }
        }
        let plain = rounded(plain);
        let padded = artwork_bounds(&assets, &scene).expect("artwork");
        assert!(contains(padded, plain), "{name}: {padded:?} holds {plain:?}");
        assert!(padded[2] > plain[2] && padded[3] > plain[3], "{name}: the effects reach beyond the artwork ({padded:?} against {plain:?})");
        let mut without = scene.clone();
        without.vfx = None;
        without.clip_vfx.iter_mut().for_each(|v| *v = None);
        assert_eq!(artwork_bounds(&assets, &without), Some(plain), "{name}: without effects, the strokes alone");
    }
}
