//! Leaving out what the artboard clips away (`styk_eval::drawlist::cull_outside`) changes no pixel: frames with figures shifted
//! wholly or partly outside the artboard are drawn from the whole list and from the culled one, through the scene camera and without it,
//! at several zooms and pans, and the pictures are the same.

use std::path::Path;
use std::sync::Arc;

use styk_eval::doc::Camera;
use styk_eval::drawlist::{cull_outside, encode_with, rgba8, DrawList, Group, Overrides, Pass, Prim, K_BOX, K_FILL_VIEW, K_TRI, NO_LAYER, NO_PAINT};
use styk_eval::geometry::build;
use styk_eval::view::camera_matrix;

fn fixture(name: &str) -> styk_eval::doc::Document {
    styk_eval::open(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../styk-eval/tests/fixtures").join(name)).unwrap()
}

#[test]
fn a_culled_list_draws_the_pictures_of_the_whole_one() {
    let (mut dropped_total, mut compared, mut with_background) = (0, 0, 0);
    for name in ["eval/follow-figures.json", "eval/color-transitions.json", "eval/sticknodes-sprites.json", "eval/movieclip-joined.json"] {
        let doc = fixture(name);
        let assets = styk_eval::assets::Assets::build(&doc);
        let prepared = styk_eval::prepare(doc);
        let images = styk_raster::decode_all(&prepared.doc, &assets);
        let (cw, ch) = (f64::from(prepared.doc.canvas[0]), f64::from(prepared.doc.canvas[1]));
        let frame = prepared.evaluate(3.0);
        for (dx, dy) in [(0.0, 0.0), (cw - 20.0, 10.0), (-cw * 0.6, -ch * 0.7), (cw + 30.0, ch - 15.0), (2500.0, 2500.0), (-3000.0, 40.0), (cw + 180.0, 0.0)] {
            for camera in [None, Some(Camera { x: 30.0, y: -12.0, scale: 0.9, angle: 0.2, is_default: false, motion_offset: None })] {
                let mut moved = frame.clone();
                for object in &mut moved.objects {
                    let mut shifted = (**object).clone();
                    shifted.root = [shifted.root[0] + dx, shifted.root[1] + dy];
                    *object = Arc::new(shifted);
                }
                moved.camera = camera;
                let scene = build(&prepared.doc, &moved);
                let list = encode_with(&prepared.doc, &assets, &scene, &Overrides::default());
                let mut culled = list.clone();
                let dropped = cull_outside(&mut culled, &prepared.doc, scene.camera.as_ref());
                dropped_total += dropped;
                assert_eq!(culled.background_prims, list.background_prims, "{name}: the leading fills stay the leading fills");
                with_background += usize::from(list.background_prims > 0);
                assert_eq!(culled.prims.len() + dropped, list.prims.len(), "{name}");
                assert!(culled.passes.iter().all(|pass| pass.start <= pass.end && pass.end as usize <= culled.prims.len()), "{name}: the passes follow the primitives");
                let covered: u32 = culled.passes.iter().map(|pass| pass.end - pass.start).sum();
                assert_eq!(covered as usize, culled.prims.len(), "{name}: the passes hold every primitive that stays");
                for (through_camera, zoom, pan) in [(true, 1.0, [40.0, 40.0]), (false, 1.0, [40.0, 40.0]), (true, 0.25, [20.0, 10.0]), (false, 3.0, [-100.0, -40.0]), (true, 0.07, [5.0, 5.0])] {
                    let matrix = camera_matrix(&prepared.doc, if through_camera { scene.camera.as_ref() } else { None }, zoom, pan);
                    let view = styk_raster::ViewParams {
                        matrix,
                        artboard: [pan[0], pan[1], pan[0] + cw * zoom, pan[1] + ch * zoom],
                        clip_to_artboard: true,
                        clear: [0.16, 0.16, 0.17, 1.0],
                        zoom,
                        pan,
                        stretch: 1.0,
                        camera_view: through_camera,
                        camera_limit: 2048.0,
                    };
                    let size = [(cw * zoom + 80.0).ceil() as u32, (ch * zoom + 80.0).ceil() as u32];
                    let whole = styk_raster::render(&list, &images, &view, size, styk_raster::Edges::Smooth).straight();
                    let kept = styk_raster::render(&culled, &images, &view, size, styk_raster::Edges::Smooth).straight();
                    assert!(whole == kept, "{name} shifted ({dx}, {dy}), camera {camera:?}, view through camera {through_camera} at {zoom}: the pictures differ");
                    compared += 1;
                }
            }
        }
    }
    assert!(dropped_total > 0, "frames with figures outside the artboard lose primitives");
    assert!(compared > 100);
    assert!(with_background > 0, "the frames have background fills to count");
}

/// A list of a background fill, the primitives `shapes` and a triangle far outside the artboard, drawn on one pass.
fn list_of(shapes: Vec<Prim>) -> DrawList {
    let fill = Prim { kind: K_FILL_VIEW, group: 0, color: rgba8([32, 32, 32], 1.0), paint: NO_PAINT, a: [0.0; 4], b: [0.0; 4], c: [0.0; 4] };
    let far = Prim { kind: K_TRI, group: 0, color: rgba8([0, 255, 0], 1.0), paint: NO_PAINT, a: [9000.0, 9000.0, 9100.0, 9000.0], b: [9000.0, 9100.0, 0.0, 0.0], c: [0.0; 4] };
    let mut prims = vec![fill];
    prims.extend(shapes);
    prims.push(far);
    let end = prims.len() as u32;
    DrawList { prims, groups: vec![Group { parent: 0, depth: 0, opacity: 1.0, bounds: [0.0; 4], layer: NO_LAYER }], passes: vec![Pass { depth: 0, start: 0, end }], background_prims: 1, ..Default::default() }
}

fn draw(list: &DrawList, canvas: [u32; 2]) -> Vec<u8> {
    let view = styk_raster::ViewParams {
        matrix: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
        artboard: [0.0, 0.0, f64::from(canvas[0]), f64::from(canvas[1])],
        clip_to_artboard: true,
        clear: [0.0; 4],
        zoom: 1.0,
        pan: [0.0, 0.0],
        stretch: 1.0,
        camera_view: false,
        camera_limit: 2048.0,
    };
    styk_raster::render(list, &styk_raster::Images::default(), &view, canvas, styk_raster::Edges::Smooth).straight()
}

#[test]
fn a_wide_square_stroke_just_outside_the_margin_keeps_the_corner_that_reaches_in() {
    let doc = fixture("eval/follow-figures.json");
    let (cw, ch) = (f64::from(doc.canvas[0]), f64::from(doc.canvas[1]));
    let margin = 64.0f64.max(cw.max(ch) * 0.1);
    for hw in [100.0f64, 160.0, 200.0, 300.0, 500.0] {
        // A stroke at 45 degrees whose rectangle, padded by its half width alone, lies just beyond the margin on the right; its square
        // end reaches hw·√2 and so cuts into the artboard once the half width is wide enough.
        let d = 10.0;
        let (cx, cy) = (cw + margin + 1.0 + hw + d, ch / 2.0);
        let stroke = Prim { kind: K_BOX, group: 0, color: rgba8([255, 0, 0], 1.0), paint: NO_PAINT, a: [(cx - d) as f32, (cy - d) as f32, (cx + d) as f32, (cy + d) as f32], b: [hw as f32, 0.0, 0.0, 0.0], c: [0.0; 4] };
        let list = list_of(vec![stroke]);
        let mut culled = list.clone();
        let dropped = cull_outside(&mut culled, &doc, None);
        let (whole, kept) = (draw(&list, doc.canvas), draw(&culled, doc.canvas));
        let red = whole.chunks(4).filter(|p| p[0] > 200 && p[1] < 50 && p[3] == 255).count();
        assert!(whole == kept, "a box of half width {hw} at 45 degrees: {} pixels differ ({red} are red in the whole list, {dropped} primitives dropped)", whole.iter().zip(&kept).filter(|(a, b)| a != b).count());
        if hw >= 300.0 {
            assert!(red > 0, "a box of half width {hw} reaches into the artboard");
            assert_eq!(dropped, 1, "only the far triangle is left out");
        }
    }
}

#[test]
fn the_leading_fills_are_still_counted_when_primitives_are_left_out() {
    let doc = fixture("eval/follow-figures.json");
    // The root pass comes after the deeper ones: a group one level down holds a triangle far outside (primitive 0), then the root's fill,
    // a box in view and another far triangle. `background_prims` counts the root's leading fills, not primitives from the start of the list.
    let tri = |group: u32| Prim { kind: K_TRI, group, color: rgba8([0, 255, 0], 1.0), paint: NO_PAINT, a: [9000.0, 9000.0, 9100.0, 9000.0], b: [9000.0, 9100.0, 0.0, 0.0], c: [0.0; 4] };
    let fill = Prim { kind: K_FILL_VIEW, group: 0, color: rgba8([32, 32, 32], 1.0), paint: NO_PAINT, a: [0.0; 4], b: [0.0; 4], c: [0.0; 4] };
    let stroke = Prim { kind: K_BOX, group: 0, color: rgba8([255, 0, 0], 1.0), paint: NO_PAINT, a: [10.0, 10.0, 60.0, 60.0], b: [5.0, 0.0, 0.0, 0.0], c: [0.0; 4] };
    let list = DrawList {
        prims: vec![tri(1), fill, stroke, tri(0)],
        groups: vec![Group { parent: 0, depth: 0, opacity: 1.0, bounds: [0.0; 4], layer: NO_LAYER }, Group { parent: 0, depth: 1, opacity: 0.5, bounds: [0.0; 4], layer: NO_LAYER }],
        passes: vec![Pass { depth: 1, start: 0, end: 1 }, Pass { depth: 0, start: 1, end: 4 }],
        background_prims: 1,
        ..Default::default()
    };
    let mut culled = list.clone();
    assert_eq!(cull_outside(&mut culled, &doc, None), 2);
    assert_eq!(culled.prims.iter().map(|p| p.kind & 255).collect::<Vec<_>>(), vec![K_FILL_VIEW, K_BOX]);
    assert_eq!(culled.passes.iter().map(|pass| (pass.depth, pass.start, pass.end)).collect::<Vec<_>>(), vec![(1, 0, 0), (0, 0, 2)]);
    assert_eq!(culled.background_prims, 1, "the fill is still the root's one leading fill");
}
