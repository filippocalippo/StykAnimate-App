use std::path::Path;
#[test]
fn baked_movieclip_views_match_editor() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/movieclip-bake");
    for family in [
        "bake-native", "bake-native-presence", "bake-native-outside-placement", "bake-native-live",
        "bake-sheet", "bake-sheet-presence", "bake-sheet-outside-placement", "bake-sheet-live", "bake-native-saved", "bake-native-saved-presence", "bake-native-layer-pose", "bake-native-layer-pose-fractional", "bake-native-stale",
        "bake-native-stored-child", "bake-native-stored-outer-scene",
        "bake-native-timeline-container", "bake-native-timeline-scene", "bake-native-timeline-child", "bake-native-timeline-outer-scene",
        "bake-sheet-stored-child", "bake-sheet-stored-outer-scene",
        "bake-sheet-timeline-container", "bake-sheet-timeline-scene", "bake-sheet-timeline-child", "bake-sheet-timeline-outer-scene",
        "bake-native-stored-remapped-scopes", "bake-sheet-stored-remapped-scopes",
    ] {
        for suffix in ["applied", "final"] {
            let name = format!("{family}-{suffix}");
            let tree =
                styk_doc::json::parse(&std::fs::read(folder.join(format!("{name}.json"))).unwrap())
                    .unwrap();
            let reference = styk_doc::json::parse(
                &std::fs::read(folder.join(format!("{name}.reference.json"))).unwrap(),
            )
            .unwrap();
            let prepared = styk_eval::prepare(styk_eval::from_value(&tree, "").unwrap());
            assert!(
                prepared.doc.unsupported.is_empty(),
                "{name}: {:?}",
                prepared.doc.unsupported
            );
            let report = styk_eval::parity::compare(&prepared, &reference);
            assert!(report.matches(), "{name}: {:?}", report.bad_frames);
        }
    }
}

#[test]
fn materialized_effect_scopes_match_editor_without_changing_sources() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/movieclip-bake");
    for name in ["bake-native-stored-remapped-scopes", "bake-sheet-stored-remapped-scopes"] {
        let reference = styk_doc::json::parse(&std::fs::read(folder.join(format!("{name}.json"))).unwrap()).unwrap();
        let tree = styk_doc::json::parse(reference.get("steps").unwrap().item(0).unwrap().get("document").unwrap().as_str().unwrap().as_bytes()).unwrap();
        let original = styk_doc::json::to_string(&tree);
        let prepared = styk_eval::prepare(styk_eval::from_value(&tree, "").unwrap());
        let materialized = reference.get("materializer").unwrap();
        let expected = materialized.get("reference").unwrap();
        let mut owner = styk_eval::materialize::Materializer::new(&tree, &prepared).unwrap();
        let frame = owner.frame(materialized.get("frame").unwrap()).unwrap();
        assert_eq!(styk_doc::json::to_string(&frame), styk_doc::json::to_string(expected.get("frame").unwrap()), "{name} frame");
        assert_eq!(styk_doc::json::to_string(&styk_doc::Value::array(owner.figures().to_vec())), styk_doc::json::to_string(expected.get("figures").unwrap()), "{name} definitions");
        assert_eq!(styk_doc::json::to_string(&styk_doc::Value::array(owner.identities().map(|(path, id)| styk_doc::Value::array(vec![styk_doc::Value::str(path), styk_doc::Value::Num(id as f64)])).collect())), styk_doc::json::to_string(expected.get("identities").unwrap()), "{name} paths");
        assert_eq!(styk_doc::json::to_string(&tree), original, "{name} source COW");
    }
}
