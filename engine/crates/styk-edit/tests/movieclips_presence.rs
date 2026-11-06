use std::path::Path;
#[test]
fn native_presence_breaks_match_editor_at_every_step() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    for name in ["clip-break-presence-native", "clip-break-presence-gaps-native", "clip-break-presence-continuation-native", "clip-break-presence-once-native", "clip-break-presence-live-native"] {
        let reference = styk_doc::json::parse(&std::fs::read(folder.join(format!("{name}.reference.json"))).unwrap()).unwrap();
        let outcome = styk_edit::replay::replay(&reference).unwrap();
        assert!(outcome.passed(), "{name}: {:#?}", outcome.mismatches);
        assert_eq!((outcome.matched, &outcome.unported), (outcome.steps, &None), "{name}");
    }
}
