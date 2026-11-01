//! Leaving out what the artboard clips away (`styk_eval::drawlist::cull_outside`) changes no pixel: frames with figures shifted
//! wholly or partly outside the artboard are drawn from the whole list and from the culled one, through the scene camera and without it,
//! at several zooms and pans, and the pictures are the same.

use std::path::Path;
use std::sync::Arc;

use styk_eval::doc::Camera;
use styk_eval::drawlist::{cull_outside, encode_with, Overrides};
use styk_eval::geometry::build;
use styk_eval::view::camera_matrix;

fn fixture(name: &str) -> styk_eval::doc::Document {
    styk_eval::open(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../styk-eval/tests/fixtures").join(name)).unwrap()
}

#[test]
fn a_culled_list_draws_the_pictures_of_the_whole_one() {
    let (mut dropped_total, mut compared) = (0, 0);
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
}
