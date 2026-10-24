//! Destination-grid eligibility belongs to evaluated editor entries, not to
//! the many tile primitives produced from one image.
use std::path::Path;
use std::sync::Arc;
use styk_eval::assets::Assets;
use styk_eval::drawlist::{self, Ghost, Layer, LayerKind, Overrides};
use styk_eval::geometry::{self, Scene};
use styk_eval::vfx::{Effect, FrameVfx, ObjectVfx};
use styk_eval::vfx::registry::{Blur, Params};

fn drawing() -> (styk_eval::eval::Prepared, Assets, Scene) {
    let doc = styk_eval::open(&Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/drawlist/drawing-cel.json")).unwrap();
    let prepared = styk_eval::prepare(doc);
    let assets = Assets::build(&prepared.doc);
    let mut scene = geometry::build(&prepared.doc, &prepared.evaluate(0.0));
    let effect = Arc::new(Effect { id: Arc::from("drawing-grid-blur"), enabled: true, params: Params::Blur(Blur { radius: 4.0, ..Default::default() }) });
    scene.vfx = Some(Arc::new(FrameVfx { objects: vec![Some(ObjectVfx { figure: vec![effect], ..Default::default() })], ..Default::default() }));
    (prepared, assets, scene)
}

fn entries(list: &styk_eval::drawlist::DrawList) -> Vec<bool> {
    list.layers.iter().filter_map(|layer| match layer.kind { LayerKind::Entry { single_drawing, .. } => Some(single_drawing), _ => None }).collect()
}

#[test]
fn one_current_cel_is_eligible_but_its_many_tiles_do_not_define_admission() {
    let (prepared, assets, scene) = drawing();
    let list = drawlist::encode(&prepared.doc, &assets, &scene);
    assert!(list.prims.len() > 100, "the single image expands into a dense tile list");
    assert_eq!(entries(&list), [true]);
    let mut multiple = scene.clone();
    multiple.items.push(scene.items[0].clone());
    assert_eq!(entries(&drawlist::encode(&prepared.doc, &assets, &multiple)), [false], "two images in one entry retain the world raster grid");
}

#[test]
fn ordinary_onion_entries_keep_their_world_grid() {
    let (prepared, assets, scene) = drawing();
    let ghosts = [Ghost { scene: &scene, hidden: &[], opacity: 0.14, tint: Some([255,0,0]) }];
    let list = drawlist::encode_composed(&prepared.doc, &assets, &scene, &Overrides::default(), &ghosts, Some(&[Layer::Ghost(0,0),Layer::Current(0)]));
    let mut eligible = entries(&list);
    eligible.sort();
    assert_eq!(eligible, [false,true], "only the actual current image uses direct drawing eligibility");
}

#[test]
fn inbetween_per_figure_ghosts_share_the_direct_thumbnail_painter() {
    let (prepared, assets, scene) = drawing();
    let ghosts = [Ghost { scene: &scene, hidden: &[], opacity: 0.14, tint: None }];
    let list = drawlist::encode_preview(&prepared.doc, &assets, &scene, &Overrides::default(), &ghosts);
    assert_eq!(entries(&list), [true,true], "thumbnail interval ghosts are painted directly, unlike stage onion rasters");
}

#[test]
fn an_ordinary_bitmap_is_not_a_published_drawing_cel() {
    let (prepared, mut assets, mut scene) = drawing();
    let figure = Arc::make_mut(&mut scene.figures[0]);
    figure.images[0].tiles = None;
    assets.cels.clear();
    let list = drawlist::encode(&prepared.doc, &assets, &scene);
    assert_eq!(entries(&list), [false]);
}

fn clipped(name: &str) -> (styk_eval::eval::Prepared, Assets, Scene) {
    let doc = styk_eval::open(&Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("tests/fixtures/drawing-grid/{name}.json"))).unwrap();
    let prepared = styk_eval::prepare(doc);
    let assets = Assets::build(&prepared.doc);
    let scene = geometry::build(&prepared.doc, &prepared.evaluate(0.0));
    (prepared, assets, scene)
}

#[test]
fn one_child_cel_keeps_direct_drawing_eligibility_through_its_container() {
    let (prepared, assets, scene) = clipped("single-child");
    assert_eq!(scene.items.len(), 1);
    assert_ne!(scene.items[0].chain, geometry::NO_CHAIN, "the recorded child really belongs to a movieclip");
    let list = drawlist::encode(&prepared.doc, &assets, &scene);
    assert_eq!(entries(&list), [true]);
    let kinds: Vec<_> = list.layers.iter().flat_map(|layer| drawlist::layer_effects(layer).iter().map(|effect| effect.kind())).collect();
    assert!(kinds.contains(&styk_eval::vfx::Kind::Tint), "the recorded container effect remains present");
    assert!(kinds.contains(&styk_eval::vfx::Kind::Blur), "the recorded child effect remains present");
}

#[test]
fn several_clip_children_do_not_become_one_direct_drawing() {
    let (prepared, assets, scene) = clipped("multiple-children");
    assert_eq!(scene.items.len(), 2);
    assert!(scene.items.iter().all(|item| item.chain != geometry::NO_CHAIN));
    assert_eq!(entries(&drawlist::encode(&prepared.doc, &assets, &scene)), [false]);
}

#[test]
fn a_single_cel_clip_onion_stays_on_its_world_raster() {
    let (prepared, assets, scene) = clipped("single-child");
    let ghosts = [Ghost { scene: &scene, hidden: &[], opacity: 0.14, tint: Some([255,0,0]) }];
    let list = drawlist::encode_composed(&prepared.doc, &assets, &scene, &Overrides::default(), &ghosts, Some(&[Layer::Ghost(0,0),Layer::Current(0)]));
    let mut eligible = entries(&list);eligible.sort();
    assert_eq!(eligible, [false,true]);
}
