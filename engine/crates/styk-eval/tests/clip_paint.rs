//! Camera background paint bounds from the existing Editor painter.
use std::path::{Path,PathBuf};
use styk_doc::Value;
fn folder() -> PathBuf { Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/clip-paint") }
fn array<const N: usize>(v: &Value) -> [f64;N] { std::array::from_fn(|i| v.item(i).unwrap().as_f64().unwrap()) }
#[test]
fn background_paint_bounds_match_the_editor_and_viewport() {
    let reference = styk_doc::json::parse(&std::fs::read(folder().join("bounds.reference.json")).unwrap()).unwrap();
    let mut checked = 0;
    let Value::Arr(rows) = reference else { panic!("expected rows") };
    for row in rows.iter() {
        let name = row.get("name").unwrap().as_str().unwrap();
        let prepared = styk_eval::prepare(styk_eval::open(&folder().join(format!("{name}.json"))).unwrap());
        let frame = prepared.evaluate(0.0);
        let viewport = array(row.get("viewport").unwrap());
        let bounds = styk_eval::view::background_bounds(&prepared.doc,frame.camera.as_ref(),true,viewport);
        assert_eq!(bounds.rect,array::<4>(row.get("bounds").unwrap()),"{name}");
        assert_eq!(bounds.clear_raster,row.get("clearRaster").unwrap().as_bool().unwrap(),"{name}");
        assert_eq!(styk_eval::view::background_bounds(&prepared.doc,frame.camera.as_ref(),false,viewport).rect,viewport);
        checked += 1;
    }
    assert_eq!(checked,14);
}

#[test]
fn hidden_camera_uses_the_neutral_background_paint_bounds() {
    let prepared = styk_eval::prepare(styk_eval::open(&folder().join("color-camera.json")).unwrap());
    let frame = prepared.evaluate(0.0);
    let viewport = [123.25,45.75,320.5,192.25];
    assert_ne!(styk_eval::view::background_bounds(&prepared.doc,frame.camera.as_ref(),true,viewport).rect,viewport);
    let mut doc = (*prepared.doc).clone();
    std::sync::Arc::make_mut(doc.layers.as_mut().unwrap()).camera_visible = false;
    let bounds = styk_eval::view::background_bounds(&doc,frame.camera.as_ref(),true,viewport);
    assert_eq!(bounds.rect,viewport);
    assert!(!bounds.clear_raster);
}

#[test]
fn root_solid_admission_uses_the_actual_typed_background_owner() {
    for (name,expected) in [("color-identity",true),("color-alpha",true),("color-hidden",true),("gradient-identity",false),("image-identity",false)] {
        let prepared=styk_eval::prepare(styk_eval::open(&folder().join(format!("{name}.json"))).unwrap());
        let frame=prepared.evaluate(0.0);let scene=styk_eval::geometry::build(&prepared.doc,&frame);
        assert_eq!(styk_eval::drawlist::plain_solid_background(&prepared.doc,&scene),expected,"{name}");
    }
}
