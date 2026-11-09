//! Cooperative query cancellation must leave the existing generation usable.
use std::sync::atomic::{AtomicUsize, Ordering};
use styk_eval::{assets::{Assets, Picture}, geometry};
fn fixture(name: &str) -> styk_eval::doc::Document {
    styk_eval::open(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)).unwrap()
}
#[test]
fn evaluation_and_geometry_stop_after_admission_without_publishing_partial_results() {
    let prepared = styk_eval::prepare(fixture("drawlist/painted-limbs.json"));
    let checks = AtomicUsize::new(0);
    assert!(prepared.evaluate_cancellable(0., &|| checks.fetch_add(1, Ordering::SeqCst) > 0).is_none());
    let frame = prepared.evaluate(0.);
    let checks = AtomicUsize::new(0);
    assert!(geometry::build_shapes_cancellable(&prepared.doc, &frame, None, &|| checks.fetch_add(1, Ordering::SeqCst) > 0).is_none());
    let scene = geometry::build_shapes(&prepared.doc, &frame, None);
    assert!(!scene.items.is_empty());
    let checked = geometry::build_shapes_cancellable(&prepared.doc, &frame, None, &|| false).unwrap();
    assert_eq!(checked.items.len(), scene.items.len()); assert_eq!(checked.points, scene.points);
}
#[test]
fn a_cancelled_picture_miss_can_be_decoded_again_with_identical_bytes() {
    let doc = fixture("clip-paint/image-identity.json"); let assets = Assets::build(&doc);
    let checks = AtomicUsize::new(0);
    let decoded = styk_eval::assets::decode_picture_cancellable(&doc, &assets, Picture::Image(0), &|| checks.fetch_add(1, Ordering::SeqCst) > 0).unwrap();
    assert!(decoded.is_empty()); assert!(checks.load(Ordering::SeqCst) > 1);
    let normal = styk_eval::assets::decode_picture(&doc, &assets, Picture::Image(0)).unwrap();
    let checked = styk_eval::assets::decode_picture_cancellable(&doc, &assets, Picture::Image(0), &|| false).unwrap();
    assert!(!normal.is_empty()); assert_eq!(normal[0].rgba, checked[0].rgba);
}
#[test]
fn cancelling_a_cel_does_not_publish_partial_ink_bounds() {
    let doc = fixture("drawlist/drawing-cel.json"); let assets = Assets::build(&doc);
    let (cel, _) = assets.cels.values().next().unwrap();
    let checks = AtomicUsize::new(0);
    assert!(styk_eval::drawing::decode_cel_cancellable(cel, &|| checks.fetch_add(1, Ordering::SeqCst) > 0).is_empty());
    assert!(cel.decoded_bounds.get().is_none());
    assert!(!styk_eval::drawing::decode_cel(cel).is_empty());
    assert!(cel.decoded_bounds.get().is_some());
}

#[test]
fn uncancelled_query_evaluation_matches_normal_native_sheet_and_artwork_sampling() {
    for name in ["drawlist/painted-limbs.json", "clip-paint/image-identity.json", "drawlist/drawing-cel.json", "../../../../tests/edit/startup.document.json"] {
        let prepared = styk_eval::prepare(fixture(name));
        let assets = Assets::build(&prepared.doc);
        for tick in [0., 1., 3.5] {
            let normal = geometry::build(&prepared.doc, &prepared.evaluate(tick));
            let checked = geometry::build(&prepared.doc, &prepared.evaluate_cancellable(tick, &|| false).unwrap());
            let normal = styk_eval::drawlist::encode(&prepared.doc, &assets, &normal);
            let checked = styk_eval::drawlist::encode(&prepared.doc, &assets, &checked);
            assert_eq!(format!("{normal:?}"), format!("{checked:?}"), "{name}, tick={tick}");
        }
    }
}

#[test]
fn inspector_bounds_cancel_inside_measurement_and_keep_exact_uncancelled_values() {
    let prepared = styk_eval::prepare(fixture("drawlist/painted-limbs.json"));
    let frame = prepared.evaluate(0.0);
    let slots: Vec<_> = (0..frame.objects.len()).collect();
    let visits = AtomicUsize::new(0);
    let checked = geometry::build_only_measured_cancellable(&prepared.doc, &frame, &slots, &|| { visits.fetch_add(1, Ordering::SeqCst); false }).unwrap();
    let normal = geometry::build_only_measured(&prepared.doc, &frame, &slots);
    assert_eq!(normal.points, checked.points);
    let total = visits.load(Ordering::SeqCst);
    let visits = AtomicUsize::new(0);
    assert!(geometry::build_only_measured_cancellable(&prepared.doc, &frame, &slots, &|| visits.fetch_add(1, Ordering::SeqCst) >= total / 2).is_none());
    let expected = styk_eval::drawlist::app_bounds_of(&normal, prepared.doc.as_ref(), &slots);
    let visits = AtomicUsize::new(0);
    assert_eq!(styk_eval::drawlist::app_bounds_of_cancellable(&normal, prepared.doc.as_ref(), &slots, &|| { visits.fetch_add(1, Ordering::SeqCst); false }).unwrap(), expected);
    let total = visits.load(Ordering::SeqCst);
    let visits = AtomicUsize::new(0);
    assert!(styk_eval::drawlist::app_bounds_of_cancellable(&normal, prepared.doc.as_ref(), &slots, &|| visits.fetch_add(1, Ordering::SeqCst) >= total / 2).is_none());
}
