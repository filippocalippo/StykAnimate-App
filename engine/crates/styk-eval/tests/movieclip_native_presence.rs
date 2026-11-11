use std::path::Path;
#[test]
fn native_presence_break_views_match_editor() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/movieclip-native-presence");
    for name in ["clip-break-presence-native", "clip-break-presence-gaps-native", "clip-break-presence-continuation-native", "clip-break-presence-once-native", "clip-break-presence-live-native"] {
        let tree = styk_doc::json::parse(&std::fs::read(folder.join(format!("{name}.json"))).unwrap()).unwrap();
        let reference = styk_doc::json::parse(&std::fs::read(folder.join(format!("{name}.native.reference.json"))).unwrap()).unwrap();
        let prepared = styk_eval::prepare(styk_eval::from_value(&tree, "").unwrap());
        let report = styk_eval::parity::compare(&prepared, &reference);
        assert!(report.matches(), "{name}: {:?}", report.bad_frames);
    }
}
