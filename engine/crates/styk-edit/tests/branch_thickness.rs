#[test]
fn branch_thickness_recordings_match_every_step() {
    let folder = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    for name in ["branch-thickness-native", "branch-thickness-sheet", "branch-thickness-locked-sheet", "branch-thickness-origin-sheet", "branch-thickness-origin-native"] {
        let reference = styk_doc::json::parse(&std::fs::read(folder.join(format!("{name}.reference.json"))).unwrap()).unwrap();
        let outcome = styk_edit::replay::replay(&reference).unwrap();
        assert!(outcome.passed() && outcome.matched == outcome.steps && outcome.unported.is_none(), "{name}: {outcome:#?}");
        println!("{name}: {} / {} steps matched", outcome.matched, outcome.steps);
    }
}
