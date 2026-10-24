use styk_doc::{Value,json};
fn reference() -> Value { json::parse(&std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/vfx-owner-edges/scopes.json")).unwrap()).unwrap() }
#[test]
fn owning_remapper_matches_recorded_scope_token_semantics() {
    let tape=reference();
    for case in tape.get("cases").unwrap().elements().unwrap().iter() {
        let mut owner=case.get("owner").unwrap().as_obj().unwrap().clone();
        let map=case.get("handles").unwrap().elements().map(|items|items.iter().map(|row|(row.item(0).unwrap().as_f64().unwrap(),row.item(1).unwrap().numbers().unwrap())).collect::<Vec<_>>());
        styk_eval::vfx::remap_owner(&mut owner,case.get("typeId").unwrap().as_f64().unwrap(),map.as_deref(),case.get("sourceType").unwrap().as_f64().unwrap());
        assert_eq!(json::to_string(&Value::object(owner)),json::to_string(case.get("expected").unwrap()),"{}",case.get("name").unwrap().as_str().unwrap());
    }
}
#[test]
fn materializer_uses_same_owner_for_recorded_raw_scope_metadata() {
    let tape=reference();let tree=tape.get("document").unwrap();let prepared=styk_eval::prepare(styk_eval::from_value(tree,"").unwrap());
    let materialized=tape.get("materializer").unwrap();let mut owner=styk_eval::materialize::Materializer::new(tree,&prepared).unwrap();
    let frame=owner.frame(materialized.get("frame").unwrap()).unwrap();
    assert_eq!(json::to_string(&frame),json::to_string(materialized.path(&["reference","frame"]).unwrap()));
}
