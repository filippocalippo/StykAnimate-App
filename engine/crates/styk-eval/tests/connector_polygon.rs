//! A polygon edge along a curved connector ends at the connector's sliding joint, not at its far end
//! (a rail with a bent connector at half its slide, and a polygon through its start, slider and the part beyond).
use std::path::{Path, PathBuf};

use styk_eval::geometry::{self, ItemKind};

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/rig/curved-connector-polygon.json")
}

#[test]
fn a_polygon_edge_along_a_curved_connector_ends_at_its_slider() {
    let prepared = styk_eval::prepare(styk_eval::open(&fixture()).unwrap());
    let frame = prepared.evaluate(0.0);
    let scene = geometry::build_only(&prepared.doc, &frame, &[0]);
    let object = &scene.objects[0];
    let figure = prepared.doc.figure(frame.objects[0].figure).unwrap();
    let joint = |id: u32| object.ends[figure.segments.iter().position(|segment| segment.id == id).unwrap()];
    let (slider, far) = (joint(3), joint(2));
    let polygon = scene.items.iter().find(|item| item.kind == ItemKind::Poly).expect("the polygon is drawn");
    let points = &scene.points[polygon.points.0 as usize..polygon.points.1 as usize];
    let at = |wanted: [f64; 2]| points.iter().any(|p| (p[0] - wanted[0]).hypot(p[1] - wanted[1]) < 1e-4);
    assert!(at(slider), "the edge reaches the slider {slider:?}: {points:?}");
    assert!(!at(far), "the edge stops at the slider and does not reach {far:?}: {points:?}");
    // The curve is sampled, not a straight chord.
    assert!(points.len() > 6, "{points:?}");
}
