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
