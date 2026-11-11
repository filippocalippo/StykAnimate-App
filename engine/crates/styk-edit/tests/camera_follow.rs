//! Follow-camera reads and commands recorded in the JavaScript editor before the port.
#[test]
fn follow_camera_recordings_match_every_step() {
    let folder = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    let mut failed = Vec::new();
    for name in ["camera-follow-handles-native", "camera-follow-handles-sheet", "camera-follow-commands-sheet", "camera-follow-bake-sheet", "camera-follow-path-sheet", "camera-follow-spatial-sheet", "camera-center-default-sheet"] {
        let reference = styk_doc::json::parse(&std::fs::read(folder.join(format!("{name}.reference.json"))).unwrap()).unwrap();
        let outcome = styk_edit::replay::replay(&reference).unwrap();
        if !(outcome.passed() && outcome.matched == outcome.steps && outcome.unported.is_none()) { failed.push(format!("{name}: {outcome:#?}")); }
        println!("{name}: {} / {} steps matched", outcome.matched, outcome.steps);
    }
    assert!(failed.is_empty(), "{}", failed.join("\n"));
}
