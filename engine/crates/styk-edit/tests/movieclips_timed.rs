use std::path::Path;
#[test]
fn timed_native_movieclip_recordings_match_every_step() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    for name in ["clip-playback-all-native", "clip-playback-sources-native", "clip-playback-presence-native", "clip-playback-live-native"] {
        let reference = styk_doc::json::parse(&std::fs::read(folder.join(format!("{name}.reference.json"))).unwrap()).unwrap();
        let outcome = styk_edit::replay::replay(&reference).unwrap();
        assert!(outcome.passed(), "{name}: {:#?}", outcome.mismatches);
        assert_eq!((outcome.matched, &outcome.unported), (outcome.steps, &None), "{name}");
    }
}
