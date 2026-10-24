//! 3D evaluation against the JavaScript editor (docs/engine/spatial.md).
//!
//! Every fixture in `tests/fixtures/spatial/` is a small project and the
//! editor's own evaluation of it (`node engine/tools/spatial-fixtures.mjs`
//! regenerates them): spatial poses and their tweens, one-sided surfaces,
//! figure meshes and attached movieclip meshes. The engine must produce the
//! same joints, the same visible faces in the same order, and the same
//! vertices and depths. Each fixture must also stop matching without the
//! feature it is about, or it would prove nothing.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use styk_doc::Value;
use styk_eval::doc::{Document, Figure, Keyframe, Movieclip, Object};
use styk_eval::geometry::{build, ItemKind};
use styk_eval::parity::{self, Report};
use styk_eval::rig::Spatial;

fn folder() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/spatial")
}

fn json(path: &Path) -> Value {
    styk_doc::json::parse(&std::fs::read(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// Fixture names, from the reference dumps present in the folder.
fn fixtures() -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(folder())
        .expect("fixture folder")
        .filter_map(|entry| entry.ok()?.file_name().to_str()?.strip_suffix(".reference.json").map(str::to_string))
        .collect();
    names.sort();
    names
}

fn open(name: &str) -> Document {
    styk_eval::open(&folder().join(format!("{name}.json"))).unwrap_or_else(|e| panic!("{name}: {e}"))
}

fn compare(name: &str, document: Document) -> Report {
    parity::compare(&styk_eval::prepare(document), &json(&folder().join(format!("{name}.reference.json"))))
}

fn describe(report: &Report) -> String {
    report.bad_frames.iter().map(|frame| format!("tick {}:\n  {}", frame.tick, frame.problems.join("\n  "))).collect::<Vec<_>>().join("\n")
}

#[test]
fn every_fixture_evaluates_like_the_editor() {
    let names = fixtures();
    assert!(names.len() >= 13, "fixtures are missing: run node engine/tools/spatial-fixtures.mjs");
    let (mut faces, mut surfaces) = (0, 0);
    for name in &names {
        let document = open(name);
        assert!(document.unsupported.is_empty(), "{name}: not evaluated: {:?}", document.unsupported);
        assert!(document.notes.is_empty(), "{name}: read leniently: {:?}", document.notes);
        let prepared = styk_eval::prepare(document);
        let reference = json(&folder().join(format!("{name}.reference.json")));
        let report = parity::compare(&prepared, &reference);
        assert!(report.frames > 0 && report.joints > 0 && report.primitives > 0, "{name}: an empty reference");
        assert!(report.total_ticks.is_none(), "{name}: timeline length {:?}", report.total_ticks);
        assert!(
            report.matches(),
            "{name}: {} of {} primitives and {} of {} joints differ\n{}",
            report.mismatched_primitives,
            report.primitives,
            report.mismatched_joints,
            report.joints,
            describe(&report)
        );
        // What the comparison covered: depth-tested faces of meshes and of native surfaces.
        for frame in reference.get("frames").and_then(Value::as_arr).expect("frames") {
            let scene = build(&prepared.doc, &prepared.evaluate(frame.get("tick").and_then(Value::as_f64).expect("tick")));
            for item in &scene.items {
                match item.kind {
                    ItemKind::Mesh => faces += item.faces.1 - item.faces.0,
                    ItemKind::Poly if item.depth_surface() => surfaces += 1,
                    _ => {}
                }
            }
        }
    }
    assert!(faces >= 400 && surfaces >= 80, "only {faces} mesh faces and {surfaces} depth-tested surfaces were compared");
}

// ------------------------------------------------ documents without a feature

/// The document with every figure (also those of nested movieclips) changed by `change`.
fn with_figures(mut document: Document, change: &dyn Fn(&mut Figure)) -> Document {
    for figure in document.figures.iter_mut() {
        let figure = Arc::make_mut(figure);
        if let Some(clip) = &figure.movieclip {
            let nested = Arc::new(with_figures((*clip.document).clone(), change));
            figure.movieclip = Some(Arc::new(Movieclip {
                duration: clip.duration,
                source_start: clip.source_start,
                pivot: clip.pivot,
                meshes: clip.meshes.clone(),
                drawing_sets: clip.drawing_sets.clone(),
                drawing_rotation: clip.drawing_rotation,
                prepared: Arc::new(styk_eval::eval::Prepared::new(nested.clone())),
                document: nested,
                cache: Default::default(),
            }));
        }
        change(figure);
    }
    // Poses resolved against a figure (style overlays) take the changed figure.
    let figures: std::collections::HashMap<u32, Arc<Figure>> = document.figures.iter().map(|f| (f.id, f.clone())).collect();
    let restyle = |frame: &mut Arc<Keyframe>| {
        for object in Arc::make_mut(frame).objects.iter_mut() {
            if object.figure_override.is_some() {
                let object = Arc::make_mut(object);
                let mut resolved = (**object.figure_override.as_ref().unwrap()).clone();
                change(&mut resolved);
                resolved.base = figures.get(&object.figure).cloned();
                object.figure_override = Some(Arc::new(resolved));
            }
        }
    };
    document.keyframes.iter_mut().for_each(restyle);
    document.frame_sources.values_mut().for_each(restyle);
    document
}

/// The document with every pose of its own timeline changed by `change`.
fn with_objects(mut document: Document, change: &dyn Fn(&mut Object)) -> Document {
    let apply = |frame: &mut Arc<Keyframe>| {
        for object in Arc::make_mut(frame).objects.iter_mut() {
            change(Arc::make_mut(object));
        }
    };
    document.keyframes.iter_mut().for_each(apply);
    document.frame_sources.values_mut().for_each(apply);
    document
}

fn without_meshes(document: Document) -> Document {
    with_figures(document, &|figure| {
        figure.mesh = None;
        if let Some(clip) = &figure.movieclip
            && clip.meshes.is_some()
        {
            figure.movieclip = Some(Arc::new(Movieclip {
                duration: clip.duration,
                source_start: clip.source_start,
                pivot: clip.pivot,
                meshes: None,
                drawing_sets: clip.drawing_sets.clone(),
                drawing_rotation: clip.drawing_rotation,
                prepared: clip.prepared.clone(),
                document: clip.document.clone(),
                cache: Default::default(),
            }));
        }
    })
}

fn without_surfaces(document: Document) -> Document {
    with_figures(document, &|figure| figure.polyfills.iter_mut().for_each(|polygon| polygon.surface = None))
}

fn without_poses(document: Document) -> Document {
    with_objects(document, &|object| object.spatial = None)
}

fn has_meshes(document: &Document) -> bool {
    document.figures.iter().any(|f| f.mesh.is_some() || f.movieclip.as_ref().is_some_and(|clip| clip.meshes.is_some() || has_meshes(&clip.document)))
}

fn has_surfaces(document: &Document) -> bool {
    document.figures.iter().any(|f| f.polyfills.iter().any(|p| p.surface.is_some()))
}

fn has_drawings(document: &Document) -> bool {
    document.figures.iter().any(|f| f.movieclip.as_ref().is_some_and(|clip| clip.drawing_rotation.is_some()))
}

/// The document with no movieclip turning its drawings with a bone.
fn without_drawings(document: Document) -> Document {
    with_figures(document, &|figure| {
        if let Some(clip) = &figure.movieclip
            && clip.drawing_rotation.is_some()
        {
            figure.movieclip = Some(Arc::new(Movieclip {
                duration: clip.duration,
                source_start: clip.source_start,
                pivot: clip.pivot,
                meshes: clip.meshes.clone(),
                drawing_sets: clip.drawing_sets.clone(),
                drawing_rotation: None,
                prepared: clip.prepared.clone(),
                document: clip.document.clone(),
                cache: Default::default(),
            }));
        }
    })
}

fn has_poses(document: &Document) -> bool {
    document.keyframes.iter().chain(document.frame_sources.values()).any(|frame| frame.objects.iter().any(|o| o.spatial.is_some()))
}

/// A fixture that passed without its meshes, its surfaces, its rotated drawings or its 3D
/// poses would prove nothing.
#[test]
fn fixtures_depend_on_their_features() {
    let (mut meshes, mut surfaces, mut poses, mut drawings) = (0, 0, 0, 0);
    for name in fixtures() {
        let document = open(&name);
        assert!(has_meshes(&document) || has_surfaces(&document) || has_drawings(&document), "{name}: neither a mesh, a surface nor rotated drawings");
        if has_drawings(&document) {
            drawings += 1;
            let report = compare(&name, without_drawings(open(&name)));
            assert!(!report.matches(), "{name}: matches without its rotated drawings");
        }
        if has_meshes(&document) {
            meshes += 1;
            let report = compare(&name, without_meshes(open(&name)));
            assert!(!report.matches(), "{name}: matches without its meshes");
        }
        if has_surfaces(&document) {
            surfaces += 1;
            let report = compare(&name, without_surfaces(open(&name)));
            assert!(!report.matches(), "{name}: matches without its surfaces");
        }
        if has_poses(&document) {
            poses += 1;
            let report = compare(&name, without_poses(open(&name)));
            assert!(!report.matches(), "{name}: matches without its perspective and proportions");
        }
    }
    assert!(meshes >= 10 && surfaces >= 3 && poses >= 5 && drawings >= 1, "{meshes} fixtures with meshes, {surfaces} with surfaces, {poses} with 3D poses, {drawings} with rotated drawings");
}

/// The fixtures about one part of a mesh or a rig stop matching without that part.
#[test]
fn fixtures_depend_on_what_they_are_about() {
    let differs = |name: &str, what: &str, document: Document| assert!(!compare(name, document).matches(), "{name}: matches without {what}");
    // View-corrected vertices.
    let views = open("mesh-views");
    assert!(views.figures[0].mesh.as_ref().is_some_and(|mesh| mesh.views == 8 && mesh.view_slot.iter().any(|&slot| slot != u32::MAX)));
    differs("mesh-views", "its view targets", with_figures(views, &|figure| {
        if let Some(mesh) = &mut figure.mesh {
            let mesh = Arc::make_mut(mesh);
            mesh.views = 0;
            mesh.view_slot.fill(u32::MAX);
        }
    }));
    // Vertices bound to two bones.
    let skinned = open("mesh-skinned");
    assert!(skinned.figures[0].mesh.as_ref().is_some_and(|mesh| mesh.counts.contains(&2)));
    differs("mesh-skinned", "its blended vertices", with_figures(skinned, &|figure| {
        if let Some(mesh) = &mut figure.mesh {
            Arc::make_mut(mesh).counts.fill(1);
        }
    }));
    // The depth-order offset of a mesh, and the primitives that split it.
    let split = open("mesh-split");
    assert!(split.figures[0].mesh.as_ref().is_some_and(|mesh| mesh.base != 0.0));
    differs("mesh-split", "its depth-order offset", with_figures(open("mesh-split"), &|figure| {
        if let Some(mesh) = &mut figure.mesh {
            Arc::make_mut(mesh).base = 0.0;
        }
    }));
    differs("mesh-split", "the limbs that split it", with_figures(split, &|figure| figure.segments.iter_mut().for_each(|segment| segment.visible = false)));
    // An instance's own palette entry and its colour override.
    let instances = open("mesh-instances");
    assert!(instances.keyframes[0].objects.iter().any(|o| o.style.as_ref().is_some_and(|style| !style.mesh_colors.is_empty())));
    differs("mesh-instances", "the instance's palette", with_objects(instances, &|object| {
        object.style = None;
        object.figure_override = None;
    }));
    differs("mesh-instances", "the reflection", with_objects(open("mesh-instances"), &|object| object.image_text_flags = false));
    // Mechanical joints and the hidden expression.
    let mechanism = open("mesh-mechanism");
    let motions = mechanism.figures[0].segments.iter().filter(|s| matches!(s.rig.as_ref().and_then(|r| r.spatial.as_ref()), Some(Spatial::Bone { motion: Some(_), .. }))).count();
    assert_eq!(motions, 3, "mesh-mechanism: a hinge, a slide and a driven hinge");
    assert!(mechanism.figures[0].segments.iter().any(|s| s.choice_scale));
    differs("mesh-mechanism", "its mechanical joints", with_figures(mechanism, &|figure| {
        for segment in figure.segments.iter_mut() {
            if let Some(rig) = &mut segment.rig
                && let Some(Spatial::Bone { motion, .. }) = &mut Arc::make_mut(rig).spatial
            {
                *motion = None;
            }
        }
    }));
    differs("mesh-mechanism", "the hidden expression", with_figures(open("mesh-mechanism"), &|figure| figure.segments.iter_mut().for_each(|segment| segment.choice_scale = false)));
    // Depth guides of native surfaces.
    differs("surfaces-skin", "its depth guides", with_figures(open("surfaces-skin"), &|figure| {
        for polygon in figure.polyfills.iter_mut() {
            if let Some(surface) = &mut polygon.surface {
                surface.depth.clear();
                surface.depth_test = false;
            }
        }
    }));
}

/// Faces that cross the near plane are clipped before projection: the fixtures
/// reach that path, in a mesh, an attached mesh and native surfaces.
#[test]
fn perspective_fixtures_clip_at_the_near_plane() {
    for (name, mesh) in [("mesh-perspective", true), ("clip-mesh", true), ("surfaces-perspective", false)] {
        let prepared = styk_eval::prepare(open(name));
        let mut clipped = false;
        for tick in 0..prepared.total_ticks {
            let scene = build(&prepared.doc, &prepared.evaluate(tick as f64));
            if mesh {
                // A clip adds vertices beyond those of the definition.
                let definition = |figure: &Figure| figure.mesh.as_ref().map(|m| m.vertices).or_else(|| figure.movieclip.as_ref()?.meshes.as_ref().map(|meshes| meshes[0].positions.len() / 3));
                let vertices = prepared.doc.figures.iter().filter_map(|f| definition(f)).max().expect("a mesh");
                clipped |= scene.meshes.iter().any(|m| m.depth.len() > vertices);
            } else {
                clipped |= scene.items.iter().any(|item| item.kind == ItemKind::Poly && item.depth_surface() && item.points.1 - item.points.0 == 4);
            }
        }
        assert!(clipped, "{name}: no face crosses the near plane");
    }
}

/// Meshes inside a movieclip stay where the clip's own frame evaluates them,
/// as in the editor: its instance places points, starts and ends, and a mesh
/// drawable has none (docs/engine/spatial.md, "Reproduced from the editor").
#[test]
fn a_mesh_inside_a_movieclip_does_not_follow_its_instance() {
    let prepared = styk_eval::prepare(open("mesh-in-movieclip"));
    let at = |tick: f64| {
        let scene = build(&prepared.doc, &prepared.evaluate(tick));
        (scene.objects.iter().find(|o| o.resolved).expect("the instance").root, scene.meshes[0].bounds.expect("visible faces"))
    };
    let ((first_root, first), (last_root, last)) = (at(0.0), at(6.0));
    assert!((first_root[0] - last_root[0]).abs() > 50.0, "the instance moves: {first_root:?} to {last_root:?}");
    assert_eq!((first[1], first[3]), (last[1], last[3]), "the mesh keeps its vertical extent");
}

// ------------------------------------------------------------ pose vectors

fn object(loader: &mut styk_eval::load::Loader, value: &Value) -> Arc<Object> {
    let mut frame = styk_doc::Obj::new();
    frame.set("objects", Value::array(vec![value.clone()]));
    loader.keyframe(&Value::object(frame)).expect("a pose").objects[0].clone()
}

/// `interpolateSpatialPose` for recorded inputs, bit for bit: what a tween
/// between two 3D poses stores when it is committed.
#[test]
fn spatial_poses_interpolate_as_the_editor_does() {
    let vectors = json(&folder().join("vectors.json"));
    let cases = vectors.get("interpolate").and_then(Value::as_arr).expect("interpolate");
    assert!(cases.len() >= 100, "vectors are missing: run node engine/tools/spatial-fixtures.mjs");
    let mut loader = styk_eval::load::Loader::new();
    for (index, case) in cases.iter().enumerate() {
        let (a, b) = (object(&mut loader, case.get("a").expect("a")), object(&mut loader, case.get("b").expect("b")));
        let t = case.get("t").and_then(Value::as_f64).expect("t");
        let pose = styk_eval::spatial::interpolate_pose(&a, &b, t);
        let expected = case.get("result").expect("result");
        let camera = pose.camera.expect("a tweened pose always has a camera");
        let number = |path: &[&str]| expected.path(path).and_then(Value::as_f64).unwrap_or_else(|| panic!("case {index}: {path:?}"));
        for (key, ours) in [("strength", camera.strength), ("distance", camera.distance), ("centerX", camera.center[0].unwrap()), ("centerY", camera.center[1].unwrap())] {
            assert_eq!(number(&["camera", key]).to_bits(), ours.to_bits(), "case {index}: camera {key} {} vs {ours}", number(&["camera", key]));
        }
        let shapes = expected.get("shape").and_then(Value::as_obj);
        assert_eq!(shapes.map_or(0, |s| s.len()), pose.shape.as_ref().map_or(0, |s| s.len()), "case {index}: bones with proportions");
        for (id, shape) in pose.shape.iter().flatten() {
            let id = id.to_string();
            assert_eq!(number(&["shape", &id, "width"]).to_bits(), shape.width.to_bits(), "case {index}: width of {id}");
            assert_eq!(number(&["shape", &id, "taper"]).to_bits(), shape.taper.to_bits(), "case {index}: taper of {id}");
        }
    }
}

// ------------------------------------------------------------ draw lists

/// Every depth-tested face of a fixture is encoded once, in a depth run that starts
/// with a reset covering it, with window depths inside the run's range; an onion
/// skin draws every face in its tint (docs/engine/spatial.md, Drawing).
#[test]
fn depth_surfaces_encode_as_depth_runs() {
    use styk_eval::drawlist::{encode, encode_composed, rgba8, Ghost, Layer, Overrides, Prim, F_DEPTH, K_DEPTH_RESET, K_TRI};
    let face = |p: &Prim| p.kind & 255 == K_TRI && p.kind & F_DEPTH != 0;
    let mut runs = 0;
    for name in fixtures() {
        let prepared = styk_eval::prepare(open(&name));
        let assets = styk_eval::assets::Assets::build(&prepared.doc);
        for tick in 0..prepared.total_ticks {
            let scene = build(&prepared.doc, &prepared.evaluate(tick as f64));
            let expected: u32 = scene
                .items
                .iter()
                .filter(|item| item.depth_surface())
                .map(|item| if item.kind == ItemKind::Mesh { item.faces.1 - item.faces.0 } else { item.points.1 - item.points.0 - 2 })
                .sum();
            let list = encode(&prepared.doc, &assets, &scene);
            assert_eq!(list.prims.iter().filter(|p| face(p)).count() as u32, expected, "{name} tick {tick}: depth-tested faces");
            let mut reset: Option<[f32; 4]> = None;
            for (i, p) in list.prims.iter().enumerate() {
                if p.kind & 255 == K_DEPTH_RESET {
                    reset = Some(p.a);
                    runs += 1;
                    assert!(list.prims.get(i + 1).is_some_and(face), "{name} tick {tick}: a reset without faces");
                } else if face(p) {
                    // The editor draws an object with depth-tested faces from a raster of its own.
                    let mut group = p.group as usize;
                    while group != 0 && list.groups[group].layer == styk_draw::NO_LAYER {
                        group = list.groups[group].parent as usize;
                    }
                    let layer = list.layers.get(list.groups[group].layer as usize).map(|l| l.kind);
                    assert!(matches!(layer, Some(styk_draw::LayerKind::Raster { bounds }) if bounds[2] > 0.0 && bounds[3] > 0.0), "{name} tick {tick}: a face outside a raster entry ({layer:?})");
                    let r = reset.unwrap_or_else(|| panic!("{name} tick {tick}: a face outside a run"));
                    assert!(list.prims[i - 1].kind & 255 == K_DEPTH_RESET || face(&list.prims[i - 1]), "{name} tick {tick}: a run interrupted");
                    for (x, y) in [(p.a[0], p.a[1]), (p.a[2], p.a[3]), (p.b[0], p.b[1])] {
                        assert!(x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3], "{name} tick {tick}: a face outside its reset");
                    }
                    for d in [p.b[2], p.b[3], p.c[0]].map(|d| styk_eval::drawlist::window_depth(d, p.c[1], p.c[2])) {
                        assert!((0.0004..=0.9996).contains(&d), "{name} tick {tick}: window depth {d}");
                    }
                }
            }
            // The same frame as an onion skin, in one colour.
            let tint = [12, 200, 90];
            let ghost = Ghost { scene: &scene, opacity: 0.5, tint: Some(tint), hidden: &[] };
            let order: Vec<Layer> = (0..scene.objects.len() as u32).map(|slot| Layer::Ghost(0, slot)).collect();
            let hidden = vec![true; scene.objects.len()];
            let onion = encode_composed(&prepared.doc, &assets, &scene, &Overrides { hidden: &hidden, ..Default::default() }, &[ghost], Some(&order));
            assert!(onion.prims.iter().filter(|p| face(p)).all(|p| p.color == rgba8(tint, 1.0)), "{name} tick {tick}: an onion skin's face keeps its colour");
            assert_eq!(onion.prims.iter().filter(|p| face(p)).count() as u32, expected, "{name} tick {tick}: onion faces");
        }
    }
    assert!(runs >= 100, "only {runs} depth runs");
}
