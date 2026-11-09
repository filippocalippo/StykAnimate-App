//! Cancellation budgets count checkpoints, not elapsed time. Dense work is generated
//! in memory; the repository fixtures and their recorded results stay frozen.
use std::sync::{Arc, Mutex, atomic::{AtomicUsize, Ordering}};
use crate::{doc::{Document, Movieclip}, geometry, assets::Assets};

fn fixture(name: &str) -> Document {
    crate::open(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)).unwrap()
}
fn dense() -> Document {
    let mut doc = fixture("drawlist/painted-limbs.json");
    doc.animation = None; doc.sheet = None; doc.layers = None;
    let template = doc.keyframes[0].objects[0].clone();
    let mut key = (*doc.keyframes[0]).clone();
    key.duration = 10; key.easing = None;
    key.objects = (0..1024).map(|uid| {
        let mut object = (*template).clone(); object.uid = uid + 1; object.join = None;
        object.root[0] += uid as f64;
        Arc::new(object)
    }).collect();
    key.draw_order = (0..1024).collect(); key.reindex();
    let mut next = key.clone();
    for object in &mut next.objects { Arc::make_mut(object).root[1] += 20.; }
    doc.keyframes = vec![Arc::new(key), Arc::new(next)];
    doc
}
fn wrapped(document: Document) -> Document {
    let mut outer = fixture("vfx/movieclip.json");
    let figure = outer.figures.iter_mut().find(|f| f.movieclip.is_some()).unwrap();
    let old = figure.movieclip.as_ref().unwrap();
    let prepared = Arc::new(crate::prepare(document));
    let clip = Movieclip { duration: 10., source_start: 0., pivot: old.pivot,
        document: prepared.doc.clone(), prepared, meshes: None,
        drawing_sets: old.drawing_sets.clone(), drawing_rotation: old.drawing_rotation,
        cache: Mutex::new(geometry::ClipSceneCache::default()) };
    Arc::make_mut(figure).movieclip = Some(Arc::new(clip));
    outer.sheet = None; outer.animation = None; outer.layers = None; outer.vfx_clips = None;
    outer.frame_sources.clear();
    for key in &mut outer.keyframes {
        let key = Arc::make_mut(key); key.objects.truncate(1); key.draw_order = vec![0]; key.reindex();
    }
    outer
}
fn empty_caches(doc: &Document) {
    for figure in &doc.figures {
        if let Some(clip) = &figure.movieclip {
            assert!(clip.cache.lock().unwrap().is_empty(), "cancelled nested work was published");
            empty_caches(&clip.document);
        }
    }
}
#[test]
fn nested_clip_cancels_inside_evaluation_without_publishing_a_scene() {
    let prepared = crate::prepare(wrapped(wrapped(dense())));
    let frame = prepared.evaluate(5.);
    let checks = AtomicUsize::new(0);
    // The two outer instances have only a few admission checks; 64 reaches the
    // 1024-object nested evaluation before any clip can publish its scene.
    assert!(geometry::build_shapes_cancellable(&prepared.doc, &frame, None, &|| checks.fetch_add(1, Ordering::SeqCst) >= 64).is_none());
    empty_caches(&prepared.doc);
    assert!(!geometry::build(&prepared.doc, &frame).items.is_empty());
}
#[test]
fn nested_clip_cancels_inside_geometry_without_publishing_a_scene() {
    let prepared = crate::prepare(wrapped(dense()));
    let frame = prepared.evaluate(5.);
    let clip = prepared.doc.figures.iter().find_map(|f| f.movieclip.as_ref()).unwrap();
    let local = frame.objects.iter().find_map(|o| o.clip_time).unwrap();
    let evaluation_checks = AtomicUsize::new(0);
    clip.prepared.evaluate_clip_cancellable(clip.source_start + local, &|| { evaluation_checks.fetch_add(1, Ordering::SeqCst); false }).unwrap();
    let checks = AtomicUsize::new(0);
    assert!(clip.prepared.evaluate_clip_cancellable(clip.source_start + local, &|| checks.fetch_add(1, Ordering::SeqCst) >= 64).is_none());
    let budget = evaluation_checks.load(Ordering::SeqCst) + 64;
    let checks = AtomicUsize::new(0);
    // Permit the entire nested evaluation, then interrupt its dense geometry.
    assert!(geometry::build_shapes_cancellable(&prepared.doc, &frame, None, &|| checks.fetch_add(1, Ordering::SeqCst) >= budget).is_none());
    empty_caches(&prepared.doc);
}
#[test]
fn pose_channel_cancels_inside_sampling_even_when_it_brings_no_owned_figures() {
    use crate::channels::{Animation, Property, Target, KeyValue};
    let source = dense();
    let mut doc = fixture("channels/channels-pose.json");
    let mut channel = doc.animation.as_ref().unwrap().channels.iter().find(|c| c.property == Property::Pose && matches!(c.target, Target::Layer { .. })).unwrap().clone();
    channel.target = Target::Layer { id: Arc::from("layer-2") };
    channel.use_base_pose = false; channel.masked = Arc::from([]);
    let mut keys = vec![channel.keys[0].clone(); 2];
    for (index, key) in keys.iter_mut().enumerate() {
        let id: Arc<str> = Arc::from(format!("dense-{index}"));
        doc.frame_sources.insert(id.clone(), source.keyframes[index].clone());
        key.tick = index as f64 * 10.; key.value = KeyValue::Pose(Some(id)); key.hidden = false; key.easing = None;
    }
    doc.figures = source.figures.clone(); doc.figure_index = source.figure_index.clone();
    channel.keys = keys.into();
    doc.animation = Some(Arc::new(Animation { channels: vec![channel], end: 11., poses: true, ..Default::default() }));
    doc.keyframes = vec![Arc::new(crate::eval::blank_keyframe())]; doc.layers = None; doc.sheet = None;
    // Every source figure belongs to layer-1. Sampling still traverses the dense
    // source, but composition and finish_frame have no figures to check afterward.
    let prepared = crate::prepare(doc);
    assert!(prepared.evaluate(5.).objects.is_empty());
    let checks = AtomicUsize::new(0);
    assert!(prepared.evaluate_cancellable(5., &|| checks.fetch_add(1, Ordering::SeqCst) >= 64).is_none());
    assert!(checks.load(Ordering::SeqCst) > 64);
}
#[test]
fn clip_mesh_cancels_during_vertices_and_faces() {
    use crate::spatial::{ClipMesh, ClipPose, evaluate_clip_mesh_cancellable};
    let mesh = ClipMesh { positions: [0., 0., 0., 10., 0., 0., 0., 10., 0.].repeat(1024),
        indices: (0..3072).collect(), materials: vec![0; 1024], colors: vec![[10, 20, 30]], ..Default::default() };
    let mut doc = fixture("spatial/clip-mesh.json");
    for figure in &mut doc.figures {
        if let Some(clip) = Arc::make_mut(figure).movieclip.as_mut() {
            let clip = Arc::get_mut(clip).expect("fresh fixture owns its clip");
            if clip.meshes.is_some() { clip.meshes = Some(vec![Arc::new(mesh.clone())].into()); }
        }
    }
    let prepared = crate::prepare(doc); let frame = prepared.evaluate(3.5);
    let checks = AtomicUsize::new(0);
    assert!(geometry::build_shapes_cancellable(&prepared.doc, &frame, None, &|| checks.fetch_add(1, Ordering::SeqCst) >= 64).is_none());
    for budget in [64, mesh.positions.len() / 3 + 64] {
        let checks = AtomicUsize::new(0);
        let pose = ClipPose { root: [0.; 2], angle: 0., scale: 1., mirror: false, pivot: [0.; 2], attachment: None, colors: mesh.colors.clone() };
        assert!(evaluate_clip_mesh_cancellable(&mesh, pose, &|| checks.fetch_add(1, Ordering::SeqCst) >= budget).is_none());
    }
}
fn drawing_bits(doc: Document, checked: bool) -> (String, Vec<u32>, Vec<u64>) {
    let prepared = crate::prepare(doc);
    let frame = if checked { prepared.evaluate_cancellable(3.5, &|| false).unwrap() } else { prepared.evaluate(3.5) };
    let scene = if checked { geometry::build_cancellable(&prepared.doc, &frame, &|| false).unwrap() } else { geometry::build(&prepared.doc, &frame) };
    let drawing = crate::drawlist::encode(&prepared.doc, &Assets::build(&prepared.doc), &scene);
    let mut bits = Vec::new();
    for p in &drawing.prims {
        bits.extend([p.kind, p.group, p.color, p.paint]);
        bits.extend(p.a.into_iter().chain(p.b).chain(p.c).map(f32::to_bits));
    }
    bits.extend(drawing.paints.iter().flatten().chain(drawing.points.iter().flatten()).map(|v| v.to_bits()));
    let geometry = scene.items.iter().flat_map(|i| i.start.into_iter().chain(i.end).chain([i.angle, i.bend, i.length, i.thickness, i.scale, i.opacity])).chain(scene.points.iter().flatten().copied()).map(f64::to_bits).collect();
    (format!("{drawing:?}"), bits, geometry)
}
#[test]
fn uncancelled_nested_pose_and_mesh_paths_preserve_bits() {
    assert_eq!(drawing_bits(wrapped(wrapped(dense())), false), drawing_bits(wrapped(wrapped(dense())), true));
    for name in ["channels/channels-pose.json", "spatial/clip-mesh.json", "spatial/mesh-in-movieclip.json"] {
        // Independent cold loaders ensure the second path cannot reuse the first's scene.
        assert_eq!(drawing_bits(fixture(name), false), drawing_bits(fixture(name), true), "{name}");
    }
}
