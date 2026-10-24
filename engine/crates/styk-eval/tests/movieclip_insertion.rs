use std::path::Path;
#[test]
fn inserted_movieclip_views_match_editor() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/movieclip-insertion");
    for family in [
        "insert-native",
        "insert-native-fraction",
        "insert-native-layer2",
        "insert-native-empty",
        "insert-native-slow",
        "insert-native-locked",
        "insert-native-live",
        "insert-native-repeat",
        "insert-native-saved-layer2",
        "insert-native-saved-fraction",
        "insert-native-triple",
        "insert-sheet",
        "insert-sheet-fraction",
        "insert-sheet-layer2",
        "insert-sheet-empty",
        "insert-sheet-slow",
        "insert-sheet-locked",
        "insert-sheet-live",
        "insert-sheet-repeat",
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
