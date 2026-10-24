use std::path::Path;
#[test]
fn joined_native_pose_capture_matches_editor_every_step() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    for name in ["clip-capture-joined-channel-uid2", "clip-capture-joined-channel-uid3"] {
        let reference = styk_doc::json::parse(&std::fs::read(folder.join(format!("{name}.reference.json"))).unwrap()).unwrap();
        let outcome = styk_edit::replay::replay(&reference).unwrap();
        assert!(outcome.passed(), "{name}: {:#?}", outcome.mismatches);
        assert_eq!((outcome.matched, &outcome.unported), (outcome.steps, &None), "{name}");
    }
}
