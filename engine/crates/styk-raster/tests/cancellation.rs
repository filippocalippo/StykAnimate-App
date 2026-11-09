//! A cancelled raster is never a partly drawn frame; the renderer stays reusable.
use std::sync::atomic::{AtomicUsize, Ordering};
use styk_raster::{Edges, Images, Raster, ViewParams};
#[test]
fn a_cancelled_raster_can_render_the_same_list_again() {
    let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../styk-eval/tests/fixtures/drawlist/painted-limbs.json");
    let prepared = styk_eval::prepare(styk_eval::open(&file).unwrap());
    let assets = styk_eval::assets::Assets::build(&prepared.doc);
    let scene = styk_eval::geometry::build(&prepared.doc, &prepared.evaluate(0.));
    let list = styk_eval::drawlist::encode(&prepared.doc, &assets, &scene);
    let images = Images::default();
    let view = ViewParams { matrix: [1., 0., 0., 1., 0., 0.], artboard: [0., 0., 3., 3.], clip_to_artboard: false, clear: [0.; 4], zoom: 1., pan: [0.; 2], stretch: 1., camera_view: false, camera_limit: 2048. };
    let mut raster = Raster::new(Edges::Smooth); let checks = AtomicUsize::new(0);
    assert!(raster.render_cancellable(&list, &images, &view, [3, 3], &|| checks.fetch_add(1, Ordering::SeqCst) > 1).is_none());
    let checked = raster.render_cancellable(&list, &images, &view, [3, 3], &|| false).unwrap();
    let regular = raster.render(&list, &images, &view, [3, 3]);
    assert_eq!(checked.pixels, regular.pixels);
}
