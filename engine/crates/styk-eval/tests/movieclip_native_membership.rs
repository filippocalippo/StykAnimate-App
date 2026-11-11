use std::path::Path;
#[test]
fn native_membership_history_views_match_editor() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/movieclip-native-membership");
    for name in ["clip-capture-active-layer-native", "clip-capture-active-anchor-native", "clip-capture-active-plain-native", "clip-capture-active-cancel-native", "clip-break-active-layer-native"] {
        let tree = styk_doc::json::parse(&std::fs::read(folder.join(format!("{name}.json"))).unwrap()).unwrap();
        let reference = styk_doc::json::parse(&std::fs::read(folder.join(format!("{name}.native.reference.json"))).unwrap()).unwrap();
        let prepared = styk_eval::prepare(styk_eval::from_value(&tree, "").unwrap());
        let report = styk_eval::parity::compare(&prepared, &reference);
        assert!(report.matches(), "{name}: {:?}", report.bad_frames);
    }
}
