//! The triangles of a concave polygon a figure fills are made once, and are the ones tessellating it makes.

use std::sync::Arc;

use lyon_tessellation::FillRule;
use styk_eval::assets::{triangulate, Assets};

fn arrow(dx: f64) -> Vec<[f64; 2]> {
    vec![[0.0 + dx, 0.0], [10.0 + dx, 4.0], [0.0 + dx, 8.0], [3.0 + dx, 4.0]]
}

fn path(points: &[[f64; 2]]) -> lyon_path::Path {
    let mut builder = lyon_path::Path::builder();
    builder.begin(lyon_path::math::point(points[0][0] as f32, points[0][1] as f32));
    for p in &points[1..] {
        builder.line_to(lyon_path::math::point(p[0] as f32, p[1] as f32));
    }
    builder.end(true);
    builder.build()
}

#[test]
fn a_polygon_drawn_again_is_not_tessellated_again_and_a_moved_one_is() {
    let assets = Assets::default();
    let first = assets.fill(&arrow(0.0));
    assert_eq!(&*first, &*triangulate(&path(&arrow(0.0)), FillRule::EvenOdd, 0.05), "the triangles tessellating the polygon makes");
    assert!(!first.is_empty());
    assert!(Arc::ptr_eq(&first, &assets.fill(&arrow(0.0))), "the same polygon: the triangles kept");
    // The memory is shared by the revisions of a document.
    assert!(Arc::ptr_eq(&first, &assets.clone().fill(&arrow(0.0))));
    let moved = assets.fill(&arrow(1.5));
    assert!(!Arc::ptr_eq(&first, &moved), "another polygon: its own triangles");
    assert_eq!(&*moved, &*triangulate(&path(&arrow(1.5)), FillRule::EvenOdd, 0.05));
}

/// A frame drawn again is not tessellated again: the call site of the polygons of the documents goes through the memory.
#[test]
fn the_concave_polygons_of_a_frame_are_tessellated_once_however_often_it_is_encoded() {
    use styk_eval::drawlist::{encode_composed, Overrides};
    let mut tessellated = 0;
    for name in ["rig/curved-connector-polygon.json", "picking-construction/sticknodes.json"] {
        let doc = styk_eval::open(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)).expect("fixture");
        let prepared = styk_eval::prepare(doc);
        let assets = Assets::build(&prepared.doc);
        let encode = |tick: f64| {
            let scene = styk_eval::geometry::build(&prepared.doc, &prepared.evaluate(tick));
            encode_composed(&prepared.doc, &assets, &scene, &Overrides::default(), &[], None).prims.len()
        };
        let first: Vec<usize> = [0.0, 3.0].into_iter().map(encode).collect();
        let made = assets.fills_made();
        let again: Vec<usize> = [0.0, 3.0].into_iter().map(encode).collect();
        assert_eq!(assets.fills_made(), made, "{name}: the frames again tessellate nothing");
        assert_eq!(first, again, "{name}: and are the same frames");
        tessellated += made;
    }
    assert!(tessellated > 0, "the documents have concave polygons to tessellate");
}
