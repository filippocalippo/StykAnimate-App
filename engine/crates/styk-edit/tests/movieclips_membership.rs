use std::path::Path;
#[test]
fn native_capture_membership_matches_editor_at_every_step() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    for name in ["clip-capture-active-layer-native", "clip-capture-active-anchor-native", "clip-capture-active-plain-native", "clip-capture-active-cancel-native", "clip-break-active-layer-native"] {
        let reference = styk_doc::json::parse(&std::fs::read(folder.join(format!("{name}.reference.json"))).unwrap()).unwrap();
        let outcome = styk_edit::replay::replay(&reference).unwrap();
        assert!(outcome.passed(), "{name}: {:#?}", outcome.mismatches);
        assert_eq!((outcome.matched, &outcome.unported), (outcome.steps, &None), "{name}");
    }
}
