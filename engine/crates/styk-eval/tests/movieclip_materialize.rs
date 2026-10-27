use std::path::Path;
use styk_eval::materialize::Materializer;
fn parse(path: &Path) -> styk_doc::Value {
    styk_doc::json::parse(&std::fs::read(path).unwrap()).unwrap()
}
#[test]
fn explicit_materialization_matches_editor_definitions_frames_and_paths() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/movieclip-materialize");
    for name in ["plain", "flip", "joined", "nested"] {
        let tree = parse(&folder.join(format!("{name}.document.json")));
        let frame = parse(&folder.join(format!("{name}.frame.json")));
        let reference = parse(&folder.join(format!("{name}.reference.json")));
        let prepared = styk_eval::prepare(styk_eval::from_value(&tree, "").unwrap());
        let mut materializer = Materializer::new(&tree, &prepared).unwrap();
        let frame = materializer.frame(&frame).unwrap();
        assert_eq!(styk_doc::json::to_string(&frame), styk_doc::json::to_string(reference.get("frame").unwrap()), "{name} frame");
        assert_eq!(styk_doc::Value::array(materializer.figures().to_vec()), reference.get("figures").unwrap().clone(), "{name} definitions");
        assert_eq!(
            styk_doc::Value::array(materializer.identities().map(|(p, id)| styk_doc::Value::array(vec![styk_doc::Value::str(p), styk_doc::Value::Num(id as f64)])).collect()),
            reference.get("identities").unwrap().clone(),
            "{name} paths"
        );
    }
}

#[test]
fn identities_above_the_allocation_bound_are_kept_and_never_collided_with() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/movieclip-materialize");
    let mut tree = parse(&folder.join("plain.document.json"));
    let prepared = styk_eval::prepare(styk_eval::from_value(&tree, "").unwrap());
    let before = Materializer::new(&tree, &prepared).unwrap().identities().count();
    // A file may carry identities up to 2^32 - 1; the editor only allocates below 2^31 - 1.
    let mut frames = tree.get("keyframes").unwrap().elements().unwrap().iter().collect::<Vec<_>>();
    let mut object = frames[0].get("objects").unwrap().item(0).unwrap();
    object.make_obj().unwrap().set("unique_id", styk_doc::Value::Num(4_294_967_295.0));
    let mut objects = frames[0].get("objects").unwrap().elements().unwrap().iter().collect::<Vec<_>>();
    objects[0] = object;
    frames[0].make_obj().unwrap().set("objects", styk_doc::Value::array(objects));
    tree.make_obj().unwrap().set("keyframes", styk_doc::Value::array(frames));
    let materializer = Materializer::new(&tree, &prepared).expect("an identity above the bound does not exhaust the allocation");
    assert_eq!(materializer.identities().count(), before);
}
