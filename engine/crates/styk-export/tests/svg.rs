//! A frame as SVG: vector artwork where the draw list has a vector form, and one embedded
//! picture of the frame where it has none (effects, 3D faces, drawing cels).

use std::path::Path;

use styk_engine::{Budgets, Engine};
use styk_export::svg::{self, Frame};
use styk_export::{CpuExport, Settings, Smoothing};

fn fixture(name: &str, tick: u32) -> (Engine, std::sync::Arc<styk_engine::FrameData>, std::sync::Arc<styk_engine::Generation>) {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/policy");
    let engine = Engine::new(|| 0.0, Budgets::for_device(None));
    engine.open(&std::fs::read(root.join(format!("{name}.json"))).unwrap(), "json", "svg").unwrap();
    let frames = engine.export_frames(0).unwrap();
    let frame = frames.take(tick).unwrap();
    let generation = frames.generation().clone();
    (engine, frame, generation)
}

fn vector(name: &str, tick: u32) -> Option<String> {
    let (_engine, frame, generation) = fixture(name, tick);
    svg::vector(&Frame { doc: &generation.prepared.doc, assets: &generation.assets, list: &frame.list, camera: frame.camera.as_ref(), size: [640, 480], title: "StykAnimate frame 1" })
}

#[test]
fn plain_artwork_is_written_as_vectors() {
    let text = vector("plain-vector", 0).expect("a frame of strokes and circles has a vector form");
    assert!(text.starts_with("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<svg xmlns="), "{}", &text[..80]);
    assert!(text.contains("width=\"640\" height=\"480\" viewBox=\"0 0 320 240\" preserveAspectRatio=\"none\""));
    assert!(text.contains("<title>StykAnimate frame 1</title>"));
    assert!(text.contains("<g transform=\"matrix("), "the scene camera is one group");
    assert!(text.contains("stroke-linecap=\"round\""), "limbs are round-capped strokes");
    assert!(text.contains("<rect "), "the background fills the view");
    assert!(!text.contains("NaN") && !text.contains("<image"), "no pictures in plain artwork");
}

#[test]
fn what_has_no_vector_form_is_one_picture_of_the_frame() {
    for (name, tick) in [("figure-filter", 0), ("scene-filter", 0), ("mesh", 0), ("depth-surface", 0), ("nested-filter", 0), ("plain-drawing", 0)] {
        assert!(vector(name, tick).is_none(), "{name}: exported as a picture");
    }
    let (_engine, frame, generation) = fixture("figure-filter", 0);
    let settings = Settings::new(320, 240, Smoothing::Edges, styk_export::settings::MAX_PIXELS).unwrap();
    let pixels = CpuExport::new(settings, styk_export::cpu::TILE_SIDE).frame(&generation.prepared.doc, &frame.list, frame.camera.as_ref(), false).unwrap();
    let text = svg::picture([320, 240], "StykAnimate frame 1", &pixels).unwrap();
    assert!(text.contains("viewBox=\"0 0 320 240\"") && text.contains("<image width=\"320\" height=\"240\" href=\"data:image/png;base64,"));
}

#[test]
fn numbers_are_short_and_stable() {
    let (_engine, frame, generation) = fixture("plain-vector", 0);
    let args = Frame { doc: &generation.prepared.doc, assets: &generation.assets, list: &frame.list, camera: frame.camera.as_ref(), size: [320, 240], title: "a & b" };
    let first = svg::vector(&args).unwrap();
    assert_eq!(first, svg::vector(&args).unwrap(), "the same frame gives the same file");
    assert!(first.contains("<title>a &amp; b</title>"));
    assert!(!first.contains("0000"), "no long runs of zeros");
}

/// Draw lists built by hand: what each record becomes, and what has no vector form.
mod records {
    use styk_draw::*;
    use styk_eval::assets::Assets;
    use styk_eval::doc::Document;
    use styk_export::svg::{self, Frame};

    fn prim(kind: u32, group: u32, color: u32, paint: u32, a: [f32; 4], b: [f32; 4]) -> Prim {
        Prim { kind, group, color, paint, a, b, c: [0.0; 4] }
    }

    fn root(prims: Vec<Prim>, groups: Vec<Group>, paints: Vec<[f32; 4]>) -> DrawList {
        let end = prims.len() as u32;
        DrawList { prims, groups, paints, passes: vec![Pass { depth: 0, start: 0, end }], ..Default::default() }
    }

    fn group(opacity: f32) -> Group {
        Group { parent: 0, depth: 0, opacity, bounds: [0.0; 4], layer: NO_LAYER }
    }

    fn write(list: &DrawList) -> Option<String> {
        let doc = Document { canvas: [320, 240], ..Default::default() };
        svg::vector(&Frame { doc: &doc, assets: &Assets::default(), list, camera: None, size: [320, 240], title: "frame" })
    }

    const BLACK: u32 = 0xff00_0000;
    const WHITE: u32 = 0xffff_ffff;

    #[test]
    fn a_translucent_group_is_a_group_with_an_opacity_and_a_fill_covers_the_view() {
        let child = prim(K_CAPSULE, 1, 0x8000_00ff, NO_PAINT, [10.0, 10.0, 60.0, 10.0], [4.0, 0.0, 0.0, 0.0]);
        let composite = prim(K_COMPOSITE, 0, 0x8000_0000 | 0x00ff_ffff, NO_PAINT, [0.0; 4], [f32::from_bits(1), 0.0, 0.0, 0.0]);
        let list = root(
            vec![prim(K_FILL_VIEW, 0, WHITE, NO_PAINT, [0.0; 4], [0.0; 4]), composite, child],
            vec![group(1.0), group(0.5)],
            Vec::new(),
        );
        let text = write(&list).unwrap();
        assert!(text.contains("<rect x=\"0\" y=\"0\" width=\"320\" height=\"240\" fill=\"#ffffff\"/>"), "{text}");
        assert!(text.contains("<g opacity=\"0.501961\"><path d=\"M10 10L60 10\" fill=\"none\" stroke=\"#ff0000\" stroke-opacity=\"0.501961\" stroke-width=\"8\" stroke-linecap=\"round\""), "{text}");
    }

    #[test]
    fn triangles_of_one_colour_are_one_path_and_a_gradient_is_defined_once() {
        let tri = |x: f32, color: u32, paint: u32| prim(K_TRI, 0, color, paint, [x, 0.0, x + 10.0, 0.0], [x, 10.0, 0.0, 0.0]);
        // Head, geometry, extra, then each stop as its offset row and its colour.
        let paints = vec![[P_LINEAR, 2.0, 0.0, 0.0], [0.0, 0.0, 100.0, 0.0], [0.0; 4], [0.0; 4], [1.0, 0.0, 0.0, 1.0], [1.0, 0.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.5]];
        let list = root(vec![tri(0.0, BLACK, NO_PAINT), tri(10.0, BLACK, NO_PAINT), tri(20.0, WHITE, NO_PAINT), tri(30.0, 0, 0), tri(40.0, 0, 0)], vec![group(1.0)], paints);
        let text = write(&list).unwrap();
        assert_eq!(text.matches("<path").count(), 3, "{text}");
        assert_eq!(text.matches('Z').count(), 5);
        assert_eq!(text.matches("<linearGradient").count(), 1);
        assert!(text.contains("<stop offset=\"0\" stop-color=\"#ff0000\"/><stop offset=\"1\" stop-color=\"#0000ff\" stop-opacity=\"0.5\"/>"));
        assert!(text.contains("fill=\"url(#gradient-1)\""));
    }

    #[test]
    fn circles_arcs_rings_and_polylines_keep_their_shapes() {
        let mut list = root(
            vec![
                prim(K_DISC, 0, BLACK, NO_PAINT, [50.0, 40.0, 12.0, 0.0], [0.0; 4]),
                prim(K_RING | F_RING_FILL, 0, BLACK, NO_PAINT, [100.0, 40.0, 12.0, 3.0], [f32::from_bits(WHITE), 0.0, 0.0, 0.0]),
                prim(K_ARC, 0, BLACK, NO_PAINT, [150.0, 40.0, 20.0, 2.0], [0.0, std::f32::consts::PI / 2.0, 0.0, 0.0]),
                prim(K_POLYLINE | F_CLOSED, 0, BLACK, NO_PAINT, [0.0, 0.0, 10.0, 10.0], [1.5, f32::from_bits(0), f32::from_bits(3), 0.0]),
                prim(K_BOX, 0, BLACK, NO_PAINT, [200.0, 10.0, 240.0, 10.0], [5.0, 0.0, 0.0, 0.0]),
            ],
            vec![group(1.0)],
            Vec::new(),
        );
        list.points = vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0]];
        let text = write(&list).unwrap();
        assert!(text.contains("<circle cx=\"50\" cy=\"40\" r=\"12\" fill=\"#000000\"/>"), "{text}");
        assert!(text.contains("<circle cx=\"100\" cy=\"40\" r=\"12\" fill=\"#ffffff\" stroke=\"#000000\" stroke-width=\"6\"/>"));
        assert!(text.contains("M170 40A20 20 0 0 1 149.999999 60"), "a quarter turn from the positive x axis: {text}");
        assert!(text.contains("M0 0L10 0L10 10Z"));
        assert!(text.contains("stroke-linecap=\"square\""));
    }

    #[test]
    fn what_has_no_vector_form_is_not_written() {
        let plain = prim(K_CAPSULE, 0, BLACK, NO_PAINT, [0.0, 0.0, 10.0, 0.0], [2.0, 0.0, 0.0, 0.0]);
        assert!(write(&root(vec![plain], vec![group(1.0)], Vec::new())).is_some());
        let unsupported = [
            prim(K_PARTICLE, 0, 0, NO_PAINT, [0.0; 4], [0.0; 4]),
            prim(K_BEAM, 0, 0, NO_PAINT, [0.0; 4], [0.0; 4]),
            prim(K_DEPTH_RESET, 0, 0, NO_PAINT, [0.0; 4], [0.0; 4]),
            prim(K_TRI | F_DEPTH, 0, BLACK, NO_PAINT, [0.0; 4], [0.0; 4]),
            prim(K_IMAGE | F_DRAWING, 0, WHITE, NO_PAINT, [0.0; 4], [0.0; 4]),
            // An image of the atlas the document does not hold.
            prim(K_IMAGE, 0, WHITE, NO_PAINT, [0.0; 4], [0.0; 4]),
        ];
        for record in unsupported {
            assert!(write(&root(vec![plain, record], vec![group(1.0)], Vec::new())).is_none(), "kind {:#x}", record.kind);
        }
        // Conic and diamond gradients, a composited frame, a filtered layer.
        let angular = vec![[P_ANGULAR, 2.0, 0.0, 0.0], [0.0; 4], [0.0; 4], [0.0; 4], [1.0; 4], [1.0; 4], [1.0; 4]];
        assert!(write(&root(vec![prim(K_CAPSULE, 0, 0, 0, [0.0, 0.0, 10.0, 0.0], [2.0, 0.0, 0.0, 0.0])], vec![group(1.0)], angular)).is_none());
        let mut composited = root(vec![plain], vec![group(1.0)], Vec::new());
        composited.composited_export = true;
        assert!(write(&composited).is_none());
        let mut filtered = root(vec![plain], vec![group(1.0)], Vec::new());
        filtered.layers = vec![EffectLayer { effects: Some(std::sync::Arc::new(1u32)), kind: LayerKind::Raster { bounds: [0.0; 4] } }];
        assert!(write(&filtered).is_none());
    }
}
