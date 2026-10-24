use std::path::Path;
#[test]
fn native_movieclip_recordings_match_every_step() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    for name in [
        "clip-unique-legacy-native",
        "clip-place-legacy-native",
        "clip-native-extended-bounds",
        "clip-split-legacy-native",
        "clip-placement-native",
        "clip-create-native",
        "clip-create-joined-native",
        "clip-native-batch-cancel",
        "clip-break-native",
    ] {
        let reference = styk_doc::json::parse(&std::fs::read(folder.join(format!("{name}.reference.json"))).unwrap()).unwrap();
        let outcome = styk_edit::replay::replay(&reference).unwrap();
        assert!(outcome.passed(), "{name}: {:#?}", outcome.mismatches);
        assert_eq!((outcome.matched, &outcome.unported), (outcome.steps, &None), "{name}");
    }
}
