use std::path::Path;
#[test]
fn timed_native_movieclip_views_match_editor() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/movieclip-timed-native");
    for family in ["clip-playback-all-native", "clip-playback-sources-native", "clip-playback-presence-native", "clip-playback-live-native"] {
        for suffix in ["applied", "final"] {
            let name = format!("{family}-{suffix}");
            let tree = styk_doc::json::parse(&std::fs::read(folder.join(format!("{name}.json"))).unwrap()).unwrap();
            let reference = styk_doc::json::parse(&std::fs::read(folder.join(format!("{name}.native.reference.json"))).unwrap()).unwrap();
            let prepared = styk_eval::prepare(styk_eval::from_value(&tree, "").unwrap());
            let report = styk_eval::parity::compare(&prepared, &reference);
            assert!(report.matches(), "{name}: {:?}", report.bad_frames);
        }
    }
}
