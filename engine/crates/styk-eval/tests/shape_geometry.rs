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
        assert!(prepared.doc.unsupported.is_empty(), "{name}");
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


fn same_selected_joint(full: &Scene, query: &Scene, slot: usize, joint: usize) {
    assert_eq!(full.figure_of, query.figure_of);
    assert_eq!(full.warnings, query.warnings);
    let (a, b) = (&full.objects[slot], &query.objects[slot]);
    assert_eq!((a.slot, a.uid, a.figure, a.resolved), (b.slot, b.uid, b.figure, b.resolved));
    same_point(a.root, b.root);
    same_number(a.scale, b.scale);
    same_number(a.opacity, b.opacity);
    same_point(a.starts[joint], b.starts[joint]);
    same_point(a.ends[joint], b.ends[joint]);
    same_number(a.lengths[joint], b.lengths[joint]);
    let (a, b) = (&a.raw_segments[joint], &b.raw_segments[joint]);
    same_point(a.drawing_end, b.drawing_end);
    same_number(a.thickness, b.thickness);
    let a = &full.points[a.points.0 as usize..a.points.1 as usize];
    let b = &query.points[b.points.0 as usize..b.points.1 as usize];
    assert_eq!(a.len(), b.len());
    for (&a, &b) in a.iter().zip(b) { same_point(a, b); }
}

#[test]
fn selected_joint_query_preserves_ordinary_endpoints_curves_and_ancestor_order() {
    let (mut selected, mut skipped, mut curves, mut ancestors, mut polygons) = (0, 0, 0, 0, 0);
    for name in ["ik/startup", "ik/bent", "eval/color-transitions"] {
        let prepared = styk_eval::prepare(styk_eval::open(&folder().join(format!("{name}.json"))).unwrap());
        let reference = json(&folder().join(format!("{name}.reference.json")));
        for sample in reference.get("frames").unwrap().elements().unwrap() {
            let tick = sample.get("tick").unwrap().as_f64().unwrap();
            let frame = prepared.evaluate(tick);
            let slot = frame.objects.iter().position(|object| object.uid == 1).unwrap();
            let figure = prepared.doc.figure(frame.objects[slot].figure).unwrap();
            let full = geometry::build_only_for_shape(&prepared.doc, &frame, &[slot]);
            let rendered = geometry::build_only(&prepared.doc, &frame, &[slot]);
            polygons += rendered.items.iter().filter(|item| item.kind == ItemKind::Poly).count();
            for joint in 0..figure.segments.len() {
                let query = geometry::build_joint_for_shape(&prepared.doc, &frame, slot, joint);
                same_selected_joint(&full, &query, slot, joint);
                assert!(query.items.is_empty());
                for (i, point) in query.objects[slot].ends.iter().enumerate() {
                    if point[0].is_nan() {
                        if !full.objects[slot].ends[i][0].is_nan() { skipped += 1; }
                    } else {
                        // Every retained dependency still uses the original loop's bits.
                        same_selected_joint(&full, &query, slot, i);
                        ancestors += usize::from(i != joint);
                    }
                }
                curves += usize::from(query.objects[slot].raw_segments[joint].points.1 > query.objects[slot].raw_segments[joint].points.0);
                selected += 1;
            }
        }
    }
    assert!(selected > 0 && skipped > 0 && curves > 0 && ancestors > 0 && polygons > 0,
        "selected={selected}, skipped={skipped}, curves={curves}, ancestors={ancestors}, polygons={polygons}");
}

#[test]
fn selected_joint_query_keeps_pinned_joined_and_rich_whole_object_fallbacks() {
    for name in ["ik/startup-pinned", "ik/joined", "ik/rig-follow", "ik/spatial", "ik/movieclip", "picking-construction/sticknodes", "spatial/surfaces-solid"] {
        let prepared = styk_eval::prepare(styk_eval::open(&folder().join(format!("{name}.json"))).unwrap());
        let reference = json(&folder().join(format!("{name}.reference.json")));
        for sample in reference.get("frames").unwrap().elements().unwrap() {
            let tick = sample.get("tick").unwrap().as_f64().unwrap();
            let frame = if reference.get("native").and_then(Value::as_bool).unwrap_or(false) { prepared.native_at(tick) } else { prepared.evaluate(tick) };
            let full = geometry::build_only_for_shape(&prepared.doc, &frame, &[0]);
            let query = geometry::build_joint_for_shape(&prepared.doc, &frame, 0, 0);
            same_query_geometry(&full, &query);
            assert_eq!(format!("{:?}", full.items), format!("{:?}", query.items), "{name}@{tick}: full fallback");
            assert_eq!(format!("{:?}", full.meshes), format!("{:?}", query.meshes));
            assert_eq!(format!("{:?}", full.depths), format!("{:?}", query.depths));
            assert_eq!(format!("{:?}", full.transitions), format!("{:?}", query.transitions));
            assert_eq!(full.chains, query.chains);
            assert_eq!(full.retained_bytes, query.retained_bytes);
        }
    }
}

#[test]
fn selected_joint_query_keeps_alias_cycles_override_and_invalid_index_behavior() {
    let prepared = styk_eval::prepare(styk_eval::open(&folder().join("ik/startup.json")).unwrap());
    let original = prepared.evaluate(0.0);
    for case in ["uid", "handle", "cycle", "missing-parent", "joint", "slot", "override"] {
        let mut frame = original.clone();
        let mut slot = 0;
        let mut joint = 0;
        match case {
            "uid" => {
                frame.objects.push(frame.objects[0].clone());
                frame.draw_order.push((frame.objects.len() - 1) as u32);
            },
            "handle" | "cycle" | "missing-parent" => {
                let mut figure = (**prepared.doc.figure(frame.objects[0].figure).unwrap()).clone();
                match case {
                    "handle" => figure.segments[1].id = figure.segments[0].id,
                    "cycle" => figure.segments[0].parent = figure.segments[1].id,
                    _ => figure.segments[0].parent = u32::MAX,
                }
                figure.plan = styk_eval::doc::plan_figure(&figure.segments, &figure.polyfills);
                Arc::make_mut(&mut frame.objects[0]).figure_override = Some(Arc::new(figure));
            },
            "joint" => joint = usize::MAX,
            "slot" => slot = usize::MAX,
            "override" => {
                let rigged = styk_eval::prepare(styk_eval::open(&folder().join("ik/rig-follow.json")).unwrap());
                let source = rigged.evaluate(0.0);
                Arc::make_mut(&mut frame.objects[0]).figure_override = Some(rigged.doc.figure(source.objects[0].figure).unwrap().clone());
            },
            _ => unreachable!(),
        }
        let full = geometry::build_only_for_shape(&prepared.doc, &frame, &[slot]);
        let query = geometry::build_joint_for_shape(&prepared.doc, &frame, slot, joint);
        same_query_geometry(&full, &query);
        assert_eq!(format!("{:?}", full.items), format!("{:?}", query.items), "{case}");
        assert_eq!(full.retained_bytes, query.retained_bytes, "{case}");
    }
}


#[test]
fn selected_joint_query_preserves_prior_curve_for_invalid_and_overflow_geometry() {
    let prepared = styk_eval::prepare(styk_eval::open(&folder().join("ik/startup.json")).unwrap());
    let original = prepared.evaluate(0.0);
    // Typed owner differential: the first root-attached curve is unrelated to
    // the selected branch, but the original arc's nonfinite-input fallback can
    // consume its last point. This is not a new editable/accepted document.
    let mut figure = (**prepared.doc.figure(original.objects[0].figure).unwrap()).clone();
    figure.segments.truncate(3);
    figure.segments[0].parent = 0;
    figure.segments[1].parent = 0;
    figure.segments[2].parent = figure.segments[1].id;
    figure.plan = styk_eval::doc::plan_figure(&figure.segments, &figure.polyfills);
    for case in ["angle", "bend", "length", "ancestor", "overflow"] {
        let mut frame = original.clone();
        let object = Arc::make_mut(&mut frame.objects[0]);
        object.figure_override = Some(Arc::new(figure.clone()));
        object.ik = None;
        object.root = [120.0, 160.0];
        object.scale = 1.0;
        object.angles = Arc::from([0.3, 0.5, 0.7]);
        object.bends = Some(Arc::from([0.8, 0.2, 0.4]));
        object.lengths = Some(Arc::from([40.0, 30.0, 20.0]));
        let selected = match case {
            "angle" => { Arc::make_mut(&mut object.angles)[1] = f64::NAN; 1 },
            "bend" => { Arc::make_mut(object.bends.as_mut().unwrap())[1] = f64::INFINITY; 1 },
            "length" => { Arc::make_mut(object.lengths.as_mut().unwrap())[1] = f64::INFINITY; 1 },
            "ancestor" => { Arc::make_mut(object.lengths.as_mut().unwrap())[1] = f64::INFINITY; 2 },
            _ => {
                Arc::make_mut(object.bends.as_mut().unwrap())[1] = 0.0;
                Arc::make_mut(object.lengths.as_mut().unwrap())[1] = 1e40;
                2
            },
        };
        let full = geometry::build_only_for_shape(&prepared.doc, &frame, &[0]);
        assert!(full.objects[0].raw_segments[0].points.1 > full.objects[0].raw_segments[0].points.0, "{case}: earlier unrelated curve");
        let query = geometry::build_joint_for_shape(&prepared.doc, &frame, 0, selected);
        same_selected_joint(&full, &query, 0, selected);
        // A retry must preserve the whole original buffer, including the prior
        // curve that the old arc branch reads and may overwrite.
        same_query_geometry(&full, &query);
        assert_eq!(full.points.len(), query.points.len(), "{case}");
        for (&a, &b) in full.points.iter().zip(&query.points) { same_point(a, b); }
    }
}


#[test]
fn selected_joint_query_keeps_unjoined_draw_order_omission_and_repetition() {
    let prepared = styk_eval::prepare(styk_eval::open(&folder().join("ik/startup.json")).unwrap());
    let mut original = prepared.evaluate(0.0);
    assert_eq!(original.objects.len(), 1);
    let slot = 0;
    let joint = 3;
    let count = prepared.doc.figure(original.objects[slot].figure).unwrap().segments.len();
    // Typed-owner publication control derived from the existing Editor fixture,
    // not a new recording. Curves make duplicate point publication observable;
    // unrelated unique objects keep global figure resolution in the query.
    Arc::make_mut(&mut original.objects[slot]).bends = Some(Arc::from(vec![0.2; count]));
    for offset in 1..=2 {
        let mut object = original.objects[slot].clone();
        Arc::make_mut(&mut object).uid += offset;
        original.objects.push(object);
    }
    assert!(original.objects.iter().all(|object| object.join.is_none() && !styk_eval::ik::has_pinned(object)));
    let mut published_points: Option<Vec<[f64; 2]>> = None;
    for (name, order, published) in [
        ("normal", vec![0, 1, 2], true),
        ("omitted", vec![1, 2], false),
        ("repeated", vec![2, 0, 1, 0], true),
        ("selected twice", vec![0, 0], true),
        ("empty", vec![], false),
    ] {
        let mut frame = original.clone();
        frame.draw_order = order;
        let full = geometry::build_only_for_shape(&prepared.doc, &frame, &[slot]);
        let query = geometry::build_joint_for_shape(&prepared.doc, &frame, slot, joint);
        assert_eq!(full.figure_of, query.figure_of, "{name}: global figure table");
        assert_eq!(full.warnings, query.warnings, "{name}: unrelated roots must not produce unresolved warnings");
        assert!(query.warnings.is_empty());
        assert_eq!(query.objects[slot].resolved, published, "{name}: draw order owns resolution");
        assert_eq!(query.objects[slot].resolved, full.objects[slot].resolved);
        assert!(query.objects.iter().enumerate().all(|(i, object)| i == slot || !object.resolved));
        assert!(query.items.is_empty());
        if published {
            same_selected_joint(&full, &query, slot, joint);
            assert!(query.points.len() > 0, "{name}: real curved point output");
            assert!(query.objects[slot].ends.iter().any(|point| point[0].is_nan()), "{name}: ordinary sparse route is eligible");
            match &published_points {
                Some(points) => {
                    assert_eq!(query.points.len(), points.len(), "{name}: repeated slots publish once");
                    for (&a, &b) in query.points.iter().zip(points) { same_point(a, b); }
                }
                None => published_points = Some(query.points.clone()),
            }
        } else {
            assert!(query.points.is_empty(), "{name}: unpublished geometry has no points");
            same_query_geometry(&full, &query);
        }
    }
    assert!(published_points.is_some());
    // A malformed publication slot still reaches the existing indexed splice,
    // after figure resolution and the unchanged selected-object build.
    let mut invalid = original.clone();
    invalid.draw_order = vec![invalid.objects.len() as u32];
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        geometry::build_only_for_shape(&prepared.doc, &invalid, &[slot]);
    })).is_err());
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        geometry::build_joint_for_shape(&prepared.doc, &invalid, slot, joint);
    })).is_err());
}

#[test]
fn selected_joint_query_preserves_unpinned_joined_parents_and_full_ancestors() {
    let documents = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    let mut skipped = 0;
    let mut attached = 0;
    let mut free_controllers = 0;
    for (name, ticks) in [("joined-chain", &[0.0, 3.0, 6.0][..]), ("ik-joined-unpinned", &[0.0][..])] {
        let prepared = styk_eval::prepare(styk_eval::open(&documents.join(format!("{name}.document.json"))).unwrap());
        for &tick in ticks {
            let mut frame = prepared.evaluate(tick);
            assert!(frame.objects.iter().any(|object| object.join.is_some()));
            assert!(!frame.objects.iter().any(|object| styk_eval::ik::has_pinned(object)));
            // Derived finite curves expose raw point slices and parent attachments;
            // the document/topology/controller sources are existing Editor recordings.
            for object in &mut frame.objects {
                let count = prepared.doc.figure(object.figure).unwrap().segments.len();
                free_controllers += object.ik.as_ref().map_or(0, |table| table.controllers.values().filter(|controller| controller.enabled && !controller.pinned).count());
                Arc::make_mut(object).bends = Some(Arc::from(vec![0.2; count]));
            }
            for slot in 0..frame.objects.len() {
                let figure = prepared.doc.figure(frame.objects[slot].figure).unwrap();
                let joint = usize::from(figure.segments.len() > 1);
                let full = geometry::build_only_for_shape(&prepared.doc, &frame, &[slot]);
                let query = geometry::build_joint_for_shape(&prepared.doc, &frame, slot, joint);
                same_selected_joint(&full, &query, slot, joint);
                assert_eq!(full.warnings, query.warnings);
                assert!(query.warnings.is_empty());
                assert_eq!(format!("{:?}", full.camera), format!("{:?}", query.camera));
                assert_eq!((full.background.0, full.background.1), (query.background.0, query.background.1));
                same_number(full.background.2, query.background.2);
                assert_eq!(full.background_color, query.background_color);
                assert_eq!(full.figures.len(), query.figures.len());
                assert!(full.figures.iter().zip(&query.figures).all(|(a, b)| Arc::ptr_eq(a, b)));
                match (&full.vfx, &query.vfx) {
                    (Some(a), Some(b)) => assert!(Arc::ptr_eq(a, b)),
                    (None, None) => {},
                    _ => panic!("frame effects changed"),
                }
                assert!(query.items.is_empty());
                for (other, (a, b)) in full.objects.iter().zip(&query.objects).enumerate() {
                    assert_eq!((a.slot, a.uid, a.figure, a.resolved), (b.slot, b.uid, b.figure, b.resolved));
                    if other != slot {
                        assert_eq!(a.ends.len(), b.ends.len());
                        // Every needed parent retains ALL joints/curves; only the
                        // selected object's unused segment entries may be omitted.
                        for index in 0..a.ends.len() { same_selected_joint(&full, &query, other, index); }
                    }
                }
                if let Some(join) = frame.objects[slot].join {
                    let parent = join.slot as usize;
                    let parent_figure = prepared.doc.figure(frame.objects[parent].figure).unwrap();
                    same_point(query.objects[slot].root, full.objects[parent].joint(parent_figure, join.handle).unwrap());
                    attached += 1;
                }
                skipped += query.objects[slot].ends.iter().enumerate().filter(|(index, point)| point[0].is_nan() && full.objects[slot].ends[*index][0].is_finite()).count();
            }
        }
    }
    assert!(skipped > 0 && attached > 0 && free_controllers > 0, "sparse={skipped}, attached={attached}, free={free_controllers}");
}

#[test]
fn selected_joint_query_keeps_joined_publication_cycles_invalid_targets_and_pins() {
    let documents = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    let prepared = styk_eval::prepare(styk_eval::open(&documents.join("joined-chain.document.json")).unwrap());
    let mut original = prepared.evaluate(0.0);
    for object in &mut original.objects {
        let count = prepared.doc.figure(object.figure).unwrap().segments.len();
        Arc::make_mut(object).bends = Some(Arc::from(vec![0.2; count]));
    }
    let slot = 2;
    let joint = 1;
    assert_eq!(original.objects.len(), 3);
    let mut published_points: Option<Vec<[f64; 2]>> = None;
    for order in [vec![0, 1, 2], vec![2, 1, 0, 2], vec![2, 2], vec![0, 1], vec![]] {
        let mut frame = original.clone();
        frame.draw_order = order;
        let full = geometry::build_only_for_shape(&prepared.doc, &frame, &[slot]);
        let query = geometry::build_joint_for_shape(&prepared.doc, &frame, slot, joint);
        assert_eq!(full.figure_of, query.figure_of);
        assert_eq!(full.warnings, query.warnings);
        assert_eq!(full.objects[slot].resolved, query.objects[slot].resolved);
        if query.objects[slot].resolved {
            same_selected_joint(&full, &query, slot, joint);
            // Even when parents are omitted from publication, their complete
            // geometry was built before the child's attachment was resolved.
            assert!(query.objects[slot].ends.iter().any(|point| point[0].is_nan()));
            if frame.draw_order == [2, 2] { assert!(!query.objects[0].resolved && !query.objects[1].resolved); }
            let raw = query.objects[slot].raw_segments[joint];
            let points = &query.points[raw.points.0 as usize..raw.points.1 as usize];
            match &published_points {
                Some(before) => { assert_eq!(points.len(), before.len()); for (&a, &b) in points.iter().zip(before) { same_point(a, b); } },
                None => published_points = Some(points.to_vec()),
            }
        } else {
            same_query_geometry(&full, &query);
        }
    }
    for case in ["selected-cycle", "unrelated-cycle", "invalid-target", "invalid-handle", "pinned"] {
        let mut frame = original.clone();
        match case {
            "selected-cycle" => Arc::make_mut(&mut frame.objects[0]).join = Some(styk_eval::doc::Join { slot: 2, handle: 33 }),
            "unrelated-cycle" => {
                for (uid, parent) in [(1001, 4), (1002, 3)] {
                    let mut object = frame.objects[0].clone();
                    let object_mut = Arc::make_mut(&mut object);
                    object_mut.uid = uid;
                    object_mut.join = Some(styk_eval::doc::Join { slot: parent, handle: 11 });
                    frame.objects.push(object);
                }
            },
            "invalid-target" => Arc::make_mut(&mut frame.objects[slot]).join = Some(styk_eval::doc::Join { slot: u32::MAX, handle: 33 }),
            "invalid-handle" => Arc::make_mut(&mut frame.objects[slot]).join.as_mut().unwrap().handle = u32::MAX,
            "pinned" => {
                let pinned = styk_eval::prepare(styk_eval::open(&folder().join("ik/startup-pinned.json")).unwrap());
                let source = pinned.evaluate(0.0);
                let mut object = source.objects[0].clone();
                assert!(styk_eval::ik::has_pinned(&object));
                let object_mut = Arc::make_mut(&mut object);
                object_mut.uid = 1001;
                object_mut.figure_override = Some(pinned.doc.figure(object_mut.figure).unwrap().clone());
                frame.objects.push(object);
            },
            _ => unreachable!(),
        }
        let full = geometry::build_only_for_shape(&prepared.doc, &frame, &[slot]);
        let query = geometry::build_joint_for_shape(&prepared.doc, &frame, slot, joint);
        assert_eq!(full.figure_of, query.figure_of, "{case}");
        assert_eq!(full.warnings, query.warnings, "{case}");
        if case == "selected-cycle" || case == "pinned" {
            same_query_geometry(&full, &query);
            if case == "selected-cycle" { assert!(!query.objects[slot].resolved && !query.warnings.is_empty()); }
            else { assert_eq!(full.retained_bytes, query.retained_bytes); }
        } else {
            same_selected_joint(&full, &query, slot, joint);
            if case == "unrelated-cycle" { assert_eq!(query.warnings.len(), 2); }
            if case == "invalid-target" || case == "invalid-handle" { same_point(query.objects[slot].root, frame.objects[slot].root); }
        }
    }
}
