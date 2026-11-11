//! Shape-query geometry stays in the existing joint/IK builder. Render-only
//! output may be omitted; complex selected objects and ancestors remain full.
//! The runtime-read documents were built by the existing Editor fixture tools.
use std::path::{Path, PathBuf};
use std::sync::Arc;

use styk_doc::Value;
use styk_eval::geometry::{self, ItemKind, Scene};

fn folder() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn json(path: &Path) -> Value {
    styk_doc::json::parse(&std::fs::read(path).unwrap()).unwrap()
}

fn same_number(a: f64, b: f64) {
    assert_eq!(a.to_bits(), b.to_bits(), "{a:?} != {b:?}");
}

fn same_point(a: [f64; 2], b: [f64; 2]) {
    same_number(a[0], b[0]);
    same_number(a[1], b[1]);
}

fn same_query_geometry(full: &Scene, query: &Scene) {
    assert_eq!(full.figure_of, query.figure_of);
    assert_eq!(full.warnings, query.warnings);
    assert_eq!(full.objects.len(), query.objects.len());
    for (a, b) in full.objects.iter().zip(&query.objects) {
        assert_eq!((a.slot, a.uid, a.figure, a.resolved), (b.slot, b.uid, b.figure, b.resolved));
        same_point(a.root, b.root);
        same_number(a.scale, b.scale);
        same_number(a.opacity, b.opacity);
        assert_eq!(a.starts.len(), b.starts.len());
        assert_eq!(a.ends.len(), b.ends.len());
        assert_eq!(a.lengths.len(), b.lengths.len());
        for (&p, &q) in a.starts.iter().zip(&b.starts) { same_point(p, q); }
        for (&p, &q) in a.ends.iter().zip(&b.ends) { same_point(p, q); }
        for (&p, &q) in a.lengths.iter().zip(&b.lengths) { same_number(p, q); }
        assert_eq!(a.raw_segments.len(), b.raw_segments.len());
        for (p, q) in a.raw_segments.iter().zip(&b.raw_segments) {
            same_point(p.drawing_end, q.drawing_end);
            same_number(p.thickness, q.thickness);
            let p = &full.points[p.points.0 as usize..p.points.1 as usize];
            let q = &query.points[q.points.0 as usize..q.points.1 as usize];
            assert_eq!(p.len(), q.len());
            for (&p, &q) in p.iter().zip(q) { same_point(p, q); }
        }
        assert_eq!(format!("{:?}", a.spatial), format!("{:?}", b.spatial));
        assert_eq!(format!("{:?}", a.rig), format!("{:?}", b.rig));
        assert_eq!(a.extent, b.extent);
    }
}

#[test]
fn ordinary_shape_query_preserves_pinned_joined_curved_and_polygon_joints() {
    let fixtures = ["ik/startup", "ik/startup-pinned", "ik/bent", "ik/conflict", "ik/followers", "ik/joined", "ik/joined-stretch", "eval/color-transitions"];
    let (mut samples, mut polygons, mut curves, mut joined, mut pinned) = (0, 0, 0, 0, 0);
    for name in fixtures {
        let prepared = styk_eval::prepare(styk_eval::open(&folder().join(format!("{name}.json"))).unwrap());
        let reference = json(&folder().join(format!("{name}.reference.json")));
        for sample in reference.get("frames").unwrap().elements().unwrap() {
            let tick = sample.get("tick").unwrap().as_f64().unwrap();
            let frame = prepared.evaluate(tick);
            // This mixed Editor fixture keeps ordinary UID 1 next to the
            // captured clip (UID 3). Only UID 1 belongs to this omission control;
            // the complex test below also checks the complete mixed query.
            let slots: Vec<_> = if name == "eval/color-transitions" {
                let slot = frame.objects.iter().position(|object| object.uid == 1).expect("ordinary UID 1");
                assert!(prepared.doc.figure(frame.objects[slot].figure).unwrap().movieclip.is_none());
                vec![slot]
            } else { (0..frame.objects.len()).collect() };
            for slot in slots {
                let full = geometry::build_only(&prepared.doc, &frame, &[slot]);
                let query = geometry::build_only_for_shape(&prepared.doc, &frame, &[slot]);
                same_query_geometry(&full, &query);
                assert!(query.items.is_empty(), "{name}@{tick}/{slot}: ordinary query produced render primitives");
                assert!(query.transitions.is_empty());
                if !full.items.is_empty() {
                    assert!(query.retained_bytes < full.retained_bytes, "{name}@{tick}/{slot}: render output was retained");
                }
                polygons += full.items.iter().filter(|item| item.kind == ItemKind::Poly).count();
                curves += full.objects.iter().flat_map(|object| &object.raw_segments).filter(|raw| raw.points.1 > raw.points.0).count();
                joined += usize::from(frame.objects[slot].join.is_some());
                pinned += usize::from(styk_eval::ik::has_pinned(&frame.objects[slot]));
                samples += 1;
            }
        }
    }
    assert!(samples > 0 && polygons > 0 && curves > 0 && joined > 0 && pinned > 0,
        "samples={samples}, polygons={polygons}, curves={curves}, joined={joined}, pinned={pinned}");
}

#[test]
fn complex_shape_query_retains_the_complete_render_geometry() {
    // The construction-only rig/spatial documents deliberately hide every
    // segment. Their complete output includes real rig state, not drawables.
    let fixtures = [("ik/rig-follow", false), ("ik/spatial", false), ("ik/movieclip", true),
        ("spatial/mesh-skinned", true), ("spatial/surfaces-solid", true), ("spatial/surfaces-perspective", true),
        ("picking-construction/sticknodes", true), ("picking-construction/joined-rig", false),
        ("eval/color-transitions", true)];
    let (mut complete, mut rendered, mut hidden_rigs) = (0, 0, 0);
    for (name, renders) in fixtures {
        let prepared = styk_eval::prepare(styk_eval::open(&folder().join(format!("{name}.json"))).unwrap());
        if name.starts_with("spatial/surfaces-") {
            assert!(prepared.doc.figures.iter().any(|figure| figure.polyfills.iter().any(|polygon| polygon.surface.is_some())),
                "{name}: the existing fixture must load actual typed surfaces");
        }
        let reference = json(&folder().join(format!("{name}.reference.json")));
        for sample in reference.get("frames").unwrap().elements().unwrap() {
            let tick = sample.get("tick").unwrap().as_f64().unwrap();
            let frame = if reference.get("native").and_then(Value::as_bool).unwrap_or(false) { prepared.native_at(tick) } else { prepared.evaluate(tick) };
            let slots: Vec<_> = (0..frame.objects.len()).collect();
            let full = geometry::build_only(&prepared.doc, &frame, &slots);
            let query = geometry::build_only_for_shape(&prepared.doc, &frame, &slots);
            same_query_geometry(&full, &query);
            if renders {
                assert!(!full.items.is_empty(), "{name}@{tick}: no drawable output to test");
                rendered += 1;
            } else {
                assert!(full.items.is_empty(), "{name}@{tick}: construction-only fixture unexpectedly draws");
                assert!(full.objects.iter().any(|object| object.resolved && object.rig.is_some()),
                    "{name}@{tick}: no resolved rig output to test");
                if name == "ik/spatial" { assert!(full.objects.iter().any(|object| object.spatial.is_some())); }
                hidden_rigs += 1;
            }
            if name == "eval/color-transitions" {
                let clip = frame.objects.iter().find(|object| object.uid == 3).expect("captured clip UID 3");
                assert!(prepared.doc.figure(clip.figure).unwrap().movieclip.is_some());
            }
            assert_eq!(format!("{:?}", full.items), format!("{:?}", query.items), "{name}@{tick}: full drawable fallback");
            assert_eq!(full.points.len(), query.points.len());
            for (&p, &q) in full.points.iter().zip(&query.points) { same_point(p, q); }
            assert_eq!(format!("{:?}", full.meshes), format!("{:?}", query.meshes));
            assert_eq!(format!("{:?}", full.depths), format!("{:?}", query.depths));
            assert_eq!(format!("{:?}", full.transitions), format!("{:?}", query.transitions));
            assert_eq!(full.chains, query.chains);
            assert_eq!(full.retained_bytes, query.retained_bytes);
            complete += 1;
        }
    }
    assert!(complete > 0 && rendered > 0 && hidden_rigs > 0);
}

#[test]
fn shape_query_keeps_draw_order_publication_and_joined_ancestor_scope() {
    let prepared = styk_eval::prepare(styk_eval::open(&folder().join("ik/joined.json")).unwrap());
    let mut frame = prepared.evaluate(0.0);
    let slot = frame.objects.iter().position(|object| object.join.is_some()).expect("joined fixture");
    let parent = frame.objects[slot].join.unwrap().slot as usize;
    let full = geometry::build_only(&prepared.doc, &frame, &[slot]);
    let query = geometry::build_only_for_shape(&prepared.doc, &frame, &[slot]);
    same_query_geometry(&full, &query);
    assert!(query.objects[slot].resolved && query.objects[parent].resolved);
    // A differential owner control, distinct from the unchanged Editor input:
    // publication must still take objects from draw_order, including absence
    // and a repeated slot. Do not expose a built but unpublished ancestor.
    frame.draw_order = vec![slot as u32, slot as u32];
    let full = geometry::build_only(&prepared.doc, &frame, &[slot]);
    let query = geometry::build_only_for_shape(&prepared.doc, &frame, &[slot]);
    same_query_geometry(&full, &query);
    assert!(query.objects[slot].resolved);
    assert!(!query.objects[parent].resolved);
}


#[test]
fn shape_query_checks_the_resolved_needed_figure_and_its_ancestors() {
    // A typed-owner control combining two existing Editor-built poses, not a new
    // recorded Editor scenario. The resolved override deliberately differs from
    // the startup definition the object still identifies.
    let prepared = styk_eval::prepare(styk_eval::open(&folder().join("ik/startup.json")).unwrap());
    let rigged = styk_eval::prepare(styk_eval::open(&folder().join("ik/rig-follow.json")).unwrap());
    let mut frame = prepared.evaluate(0.0);
    let rig_frame = rigged.evaluate(0.0);
    let mut object = frame.objects[0].clone();
    let object_mut = Arc::make_mut(&mut object);
    object_mut.figure_override = Some(rigged.doc.figure(rig_frame.objects[0].figure).unwrap().clone());
    object_mut.uid = frame.objects.iter().map(|object| object.uid).max().unwrap() + 1;
    object_mut.join = None;
    object_mut.ik = None;
    let complex_slot = frame.objects.len();
    frame.objects.push(object);
    frame.draw_order.push(complex_slot as u32);
    let full = geometry::build_only(&prepared.doc, &frame, &[0]);
    let query = geometry::build_only_for_shape(&prepared.doc, &frame, &[0]);
    same_query_geometry(&full, &query);
    assert!(query.items.is_empty(), "an unrelated complex object disabled the ordinary query");
    assert!(!query.objects[complex_slot].resolved);

    Arc::make_mut(&mut frame.objects[0]).join = Some(styk_eval::doc::Join { slot: complex_slot as u32, handle: 0 });
    let full = geometry::build_only(&prepared.doc, &frame, &[0]);
    let query = geometry::build_only_for_shape(&prepared.doc, &frame, &[0]);
    same_query_geometry(&full, &query);
    assert!(query.objects[complex_slot].resolved);
    assert!(!query.items.is_empty(), "a complex resolved ancestor needs the full builder");
    assert_eq!(format!("{:?}", full.items), format!("{:?}", query.items));
}
