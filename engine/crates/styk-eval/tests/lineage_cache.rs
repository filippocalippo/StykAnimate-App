//! Aggregate scene retention follows the Loader's existing typed-resource
//! lifetime. Fixtures are read at runtime; queries/rendering retain one owner.
use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;

use styk_doc::{Value, json};
use styk_eval::doc::{Document, Movieclip};
use styk_eval::geometry::{self, SceneBudget};
use styk_eval::load::Loader;
use styk_eval::picking::{self, HandleOptions};

fn value(name: &str) -> Value {
    json::parse(&std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)).unwrap()).unwrap()
}

/// Nest copies of actual editor-built movieclip records around an existing
/// recorded native figure fixture. Each branch has distinct source nodes, so
/// the test exercises many independent caches rather than many clip instances.
fn tree(depth: usize, width: usize) -> Value {
    if depth == 0 {
        return value("picking/native-order-static.json");
    }
    let mut project = value("picking/virtual-clip.json");
    // This stress document supplies its own native frame below. Imported sheet
    // rows in the template still name its original single instance and must
    // not override that frame with unrelated saved poses.
    project.make_obj().unwrap().get_mut("_styk").unwrap().make_obj().unwrap().remove("layerSheet");
    let template = project.get("figure_types").unwrap().as_arr().unwrap().iter().find(|f| f.path(&["_styk", "movieclip"]).is_some()).unwrap().clone();
    let object = project.path(&["keyframes"]).unwrap().as_arr().unwrap()[0].get("objects").unwrap().as_arr().unwrap()[0].clone();
    let mut figures = Vec::new();
    let mut objects = Vec::new();
    for i in 0..width {
        let id = (i + 1) as f64;
        let mut figure = template.clone();
        figure.make_obj().unwrap().set("figure_type_id", Value::Num(id));
        figure.make_obj().unwrap().get_mut("_styk").unwrap().make_obj().unwrap().get_mut("movieclip").unwrap().make_obj().unwrap().set("document", tree(depth - 1, width));
        figures.push(figure);
        let mut object = object.clone();
        object.make_obj().unwrap().set("unique_id", Value::Num(id));
        object.make_obj().unwrap().set("figure_type_id", Value::Num(id));
        object.make_obj().unwrap().set("object_slot", Value::Num(i as f64));
        objects.push(object);
    }
    project.make_obj().unwrap().set("figure_types", Value::array(figures));
    let mut frame = project.get("keyframes").unwrap().as_arr().unwrap()[0].clone();
    frame.make_obj().unwrap().set("objects", Value::array(objects));
    frame.make_obj().unwrap().set("object_draw_order", Value::array((0..width).map(|i| Value::Num(i as f64)).collect()));
    project.make_obj().unwrap().set("keyframes", Value::array(vec![frame]));
    project
}

fn clips(doc: &Document) -> Vec<Arc<Movieclip>> {
    fn collect(doc: &Document, seen: &mut HashSet<usize>, found: &mut Vec<Arc<Movieclip>>) {
        for figure in &doc.figures {
            if let Some(clip) = &figure.movieclip
                && seen.insert(Arc::as_ptr(clip) as usize)
            {
                found.push(clip.clone());
                collect(&clip.document, seen, found);
            }
        }
    }
    let mut found = Vec::new();
    collect(doc, &mut HashSet::new(), &mut found);
    found
}

fn charge() -> usize {
    let prepared = styk_eval::prepare(styk_eval::from_value(&value("picking/native-order-static.json"), "recorded").unwrap());
    geometry::build(&prepared.doc, &prepared.evaluate_clip(0.0)).retained_bytes
}

fn retained(clips: &[Arc<Movieclip>]) -> (usize, usize) {
    clips.iter().fold((0, 0), |(bytes, entries), clip| {
        let cache = clip.cache.lock().unwrap();
        assert!(cache.len() <= 64);
        (bytes + cache.retained_bytes(), entries + cache.len())
    })
}

#[test]
fn many_nested_clips_share_one_byte_budget_and_release_every_reservation() {
    let mut loader = Loader::with_scene_limits(charge() * 8, 1024);
    let project = tree(3, 4);
    let doc = loader.document(&project, "nested").unwrap();
    let owner = doc.scene_budget.clone();
    let clips = clips(&doc);
    assert_eq!(clips.len(), 84);
    for clip in &clips {
        assert!(Arc::ptr_eq(&owner, &clip.document.scene_budget));
        for tick in 0..6 {
            let scene = geometry::clip_scene(clip, tick as f64);
            assert!(!scene.items.is_empty(), "saturation must still return usable geometry");
            assert!(owner.retained_bytes() <= owner.limits().0);
            assert!(owner.retained_entries() <= owner.limits().1);
            assert_eq!(retained(&clips), (owner.retained_bytes(), owner.retained_entries()));
        }
    }
    assert!(owner.retained_entries() > 0);
    assert!(owner.retained_entries() < clips.len() * 6);
    for clip in &clips {
        clip.cache.lock().unwrap().clear();
    }
    assert_eq!(owner.retained_bytes(), 0);
    assert_eq!(owner.retained_entries(), 0);
    geometry::clip_scene(&clips[0], 0.0);
    assert!(owner.retained_entries() > 0);
    drop(clips);
    drop(doc);
    drop(loader);
    drop(project);
    assert_eq!(owner.retained_bytes(), 0);
    assert_eq!(owner.retained_entries(), 0);
    let weak = Arc::downgrade(&owner);
    drop(owner);
    assert!(weak.upgrade().is_none(), "no cache/typed-resource cycle keeps the lineage token alive");
}

#[test]
fn aggregate_entry_limit_rejects_without_retention_and_reuses_released_capacity() {
    let mut loader = Loader::with_scene_limits(usize::MAX, 7);
    let project = tree(1, 50);
    let doc = loader.document(&project, "many clips").unwrap();
    let owner = doc.scene_budget.clone();
    let clips = clips(&doc);
    for clip in &clips {
        geometry::clip_scene(clip, 0.0);
    }
    assert_eq!(retained(&clips), (charge() * 7, 7));
    assert_eq!(owner.retained_entries(), 7);
    assert_eq!(owner.retained_bytes(), charge() * 7);
    let uncached = geometry::clip_scene(&clips[8], 0.0);
    assert!(!uncached.items.is_empty());
    assert!(!Arc::ptr_eq(&uncached, &geometry::clip_scene(&clips[8], 0.0)));
    assert!(clips[8].cache.lock().unwrap().is_empty());
    clips[0].cache.lock().unwrap().clear();
    geometry::clip_scene(&clips[8], 0.0);
    assert_eq!(owner.retained_entries(), 7);
    assert_eq!(clips[8].cache.lock().unwrap().len(), 1);
    let cached = geometry::clip_scene(&clips[8], 0.0);
    assert!(Arc::ptr_eq(&cached, &geometry::clip_scene(&clips[8], 0.0)));
    assert_eq!(owner.retained_entries(), 7, "hits must not reserve again");
}

#[test]
fn simultaneous_clip_publications_share_the_same_aggregate_byte_limit() {
    let mut loader = Loader::with_scene_limits(charge() * 5, 7);
    let project = tree(1, 40);
    let doc = loader.document(&project, "concurrent clips").unwrap();
    let owner = doc.scene_budget.clone();
    let clips = clips(&doc);
    let barrier = std::sync::Barrier::new(4);
    std::thread::scope(|scope| {
        for group in clips.chunks(10) {
            let owner = &owner;
            let barrier = &barrier;
            scope.spawn(move || {
                barrier.wait();
                for clip in group {
                    for tick in 0..5 {
                        drop(geometry::clip_scene(clip, tick as f64));
                        assert!(owner.retained_bytes() <= owner.limits().0);
                        assert!(owner.retained_entries() <= owner.limits().1);
                    }
                }
            });
        }
    });
    assert_eq!(retained(&clips), (owner.retained_bytes(), owner.retained_entries()));
    assert!(owner.retained_entries() > 0);
    for clip in &clips {
        clip.cache.lock().unwrap().clear();
    }
    assert_eq!(owner.retained_bytes(), 0);
    assert_eq!(owner.retained_entries(), 0);
}

#[test]
fn cloned_loaders_and_unchanged_clip_records_share_capacity_across_revisions() {
    let mut loader = Loader::with_scene_limits(usize::MAX, 2);
    let original = tree(1, 3);
    let first = loader.document(&original, "revision1").unwrap();
    let mut cloned = loader.clone();
    let mut edited = original.clone();
    edited.make_obj().unwrap().get_mut("keyframes").unwrap().make_arr().unwrap()[0].make_obj().unwrap().get_mut("objects").unwrap().make_arr().unwrap()[0].make_obj().unwrap().set("root_x", Value::Num(51.0));
    let second = cloned.document(&edited, "revision2").unwrap();
    let owner = first.scene_budget.clone();
    assert!(Arc::ptr_eq(&owner, loader.scene_budget()));
    assert!(Arc::ptr_eq(&owner, cloned.scene_budget()));
    assert!(Arc::ptr_eq(&owner, &second.scene_budget));
    let first_clips = clips(&first);
    let second_clips = clips(&second);
    for (old, new) in first_clips.iter().zip(&second_clips) {
        assert!(Arc::ptr_eq(old, new));
    }
    geometry::clip_scene(&first_clips[0], 0.0);
    geometry::clip_scene(&second_clips[1], 0.0);
    geometry::clip_scene(&second_clips[2], 0.0);
    assert_eq!(owner.retained_entries(), 2);
    assert!(second_clips[2].cache.lock().unwrap().is_empty());
    drop(first);
    drop(first_clips);
    drop(loader);
    drop(original);
    assert_eq!(owner.retained_entries(), 2, "live revision retains shared resources");
    drop(second);
    drop(second_clips);
    drop(cloned);
    drop(edited);
    assert_eq!(owner.retained_entries(), 0);
    assert_eq!(owner.retained_bytes(), 0);
}

#[test]
fn late_cancelled_lineage_work_cannot_charge_a_new_lineage_and_releases_on_disposal() {
    let project = tree(1, 1);
    let mut old_loader = Loader::with_scene_limits(charge() * 2, 2);
    let old = old_loader.document(&project, "old").unwrap();
    let old_owner = old.scene_budget.clone();
    let old_clip = clips(&old).remove(0);
    let ready = Arc::new(std::sync::Barrier::new(2));
    let resume = Arc::new(std::sync::Barrier::new(2));
    let job_ready = ready.clone();
    let job_resume = resume.clone();
    let job = std::thread::spawn(move || {
        job_ready.wait();
        job_resume.wait();
        // A cancelled worker may still finish work already in progress. Its
        // result is discarded; its captured typed resources own the old token.
        for tick in 0..80 {
            drop(geometry::clip_scene(&old_clip, tick as f64));
            assert!(old_clip.document.scene_budget.retained_bytes() <= old_clip.document.scene_budget.limits().0);
            assert!(old_clip.document.scene_budget.retained_entries() <= old_clip.document.scene_budget.limits().1);
        }
    });
    ready.wait();
    drop(old);
    drop(old_loader);
    let mut new_loader = Loader::with_scene_limits(charge(), 1);
    let new = new_loader.document(&project, "new").unwrap();
    assert!(!Arc::ptr_eq(&old_owner, &new.scene_budget));
    let new_clips = clips(&new);
    let shown = geometry::clip_scene(&new_clips[0], 0.0);
    let new_charge = new.scene_budget.retained_bytes();
    resume.wait();
    job.join().unwrap();
    assert_eq!(old_owner.retained_bytes(), 0);
    assert_eq!(old_owner.retained_entries(), 0);
    assert_eq!(new.scene_budget.retained_bytes(), new_charge);
    assert_eq!(new.scene_budget.retained_entries(), 1);
    assert!(Arc::ptr_eq(&shown, &geometry::clip_scene(&new_clips[0], 0.0)));
    let weak = Arc::downgrade(&old_owner);
    drop(old_owner);
    assert!(weak.upgrade().is_none(), "discarded old job resources release their token");
}

#[test]
fn aggregate_rejection_keeps_exact_queries_and_draw_records() {
    for name in ["picking/native-order-static.json", "picking/sheet-order-static.json", "picking/joined-rig.json", "picking/spatial-perspective.json", "spatial/mesh-in-movieclip.json", "vfx/movieclip.json"] {
        let source = value(name);
        let mut warmed = Loader::new();
        let mut rejected = Loader::with_scene_limits(0, 0);
        let first = Arc::new(warmed.document(&source, name).unwrap());
        let second = Arc::new(rejected.document(&source, name).unwrap());
        let prepare = |doc: Arc<Document>| styk_eval::eval::Prepared::new(doc);
        let cached = prepare(first);
        let uncached = prepare(second);
        let a_frame = cached.evaluate_clip(2.0);
        let b_frame = uncached.evaluate_clip(2.0);
        let a_scene = geometry::build(&cached.doc, &a_frame);
        let b_scene = geometry::build(&uncached.doc, &b_frame);
        if !clips(&cached.doc).is_empty() {
            assert!(cached.doc.scene_budget.retained_entries() > 0, "{name}: comparison must exercise clip retention");
        }
        assert_eq!(picking::handles(&a_scene, &a_frame, &HandleOptions::default()).unwrap(), picking::handles(&b_scene, &b_frame, &HandleOptions::default()).unwrap(), "{name}: exact query descriptors");
        let a_assets = styk_eval::assets::Assets::build(&cached.doc);
        let b_assets = styk_eval::assets::Assets::build(&uncached.doc);
        assert_eq!(format!("{:?}", styk_eval::drawlist::encode(&cached.doc, &a_assets, &a_scene)), format!("{:?}", styk_eval::drawlist::encode(&uncached.doc, &b_assets, &b_scene)), "{name}: exact draw records");
        assert_eq!(uncached.doc.scene_budget.retained_bytes(), 0);
        assert_eq!(uncached.doc.scene_budget.retained_entries(), 0);
    }
    assert_eq!(SceneBudget::default().limits(), (64 * 1024 * 1024, 1024));
}

#[test]
fn sampled_effects_and_paints_are_charged_and_shared_payloads_are_deduplicated() {
    use styk_eval::geometry::Scene;
    use styk_eval::vfx::{Effect, FrameVfx, Kind, ParamValue, Params};
    let vectors = value("vfx/vectors.json");
    let case = vectors.get("colors").unwrap().as_arr().unwrap().iter().find(|v| v.get("a").unwrap().is_object() && v.get("b").unwrap().is_object() && v.get("a") != v.get("b")).unwrap();
    let color = |v| ParamValue::Paint(Arc::new(styk_eval::vfx::paint::normalize(v).unwrap()));
    let a = color(case.get("a").unwrap());
    let b = color(case.get("b").unwrap());
    let sampled = styk_eval::vfx::paint::interpolate(&a, &b, 0.5);
    let ParamValue::Paint(paint) = &sampled else { panic!("recorded gradient tween") };
    let ParamValue::Paint(source_a) = &a else { unreachable!() };
    let ParamValue::Paint(source_b) = &b else { unreachable!() };
    assert!(!Arc::ptr_eq(paint, source_a) && !Arc::ptr_eq(paint, source_b), "the owner creates a new sampled paint");
    let mut params = Params::defaults(Kind::Tint);
    assert!(params.set(Kind::Tint.param("color").unwrap(), &sampled));
    let effect = Arc::new(Effect {id: Arc::from("sampled"), enabled: true, params});
    let mut scene = Scene {vfx: Some(Arc::new(FrameVfx {scene: vec![effect.clone(), effect.clone()], ..Default::default()})), ..Default::default()};
    scene.account_buffers();
    let repeated = scene.retained_bytes;
    let mut unique = (*effect).clone();
    Arc::make_mut(scene.vfx.as_mut().unwrap()).scene[1] = Arc::new(unique.clone());
    scene.account_buffers();
    assert_eq!(scene.retained_bytes - repeated, std::mem::size_of::<Effect>() + 2 * std::mem::size_of::<usize>(), "new effect shares its id and sampled paint");
    let shared_paint = scene.retained_bytes;
    let duplicate = Arc::new((**paint).clone());
    unique.params.set(Kind::Tint.param("color").unwrap(), &ParamValue::Paint(duplicate.clone()));
    Arc::make_mut(scene.vfx.as_mut().unwrap()).scene[1] = Arc::new(unique);
    scene.account_buffers();
    assert!(scene.retained_bytes >= shared_paint + std::mem::size_of::<styk_eval::doc::Paint>() + duplicate.stops.capacity() * std::mem::size_of::<styk_eval::doc::PaintStop>(), "a distinct sampled paint owns storage even when its values are equal");
    let once = scene.retained_bytes;
    let other = Arc::new((**scene.vfx.as_ref().unwrap()).clone());
    let container_bytes = std::mem::size_of::<FrameVfx>() + 2 * std::mem::size_of::<usize>() + other.scene.capacity() * std::mem::size_of::<Arc<Effect>>();
    scene.clip_vfx.push(Some(other));
    scene.account_buffers();
    assert_eq!(scene.retained_bytes - once, container_bytes + scene.clip_vfx.capacity() * std::mem::size_of::<Option<Arc<FrameVfx>>>(), "different frame containers sharing payloads charge those effects/paints only once per Scene");
    scene.clip_vfx.clear();
    scene.account_buffers();
    let charged = scene.retained_bytes;
    let vfx = scene.vfx.take().unwrap();
    scene.account_buffers();
    assert!(charged > scene.retained_bytes + std::mem::size_of::<FrameVfx>() + std::mem::size_of::<Effect>() + std::mem::size_of::<styk_eval::doc::Paint>());
    assert_eq!(vfx.scene.len(), 2, "accounting must not mutate the sampled owner");
}
