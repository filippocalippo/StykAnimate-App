#[test]
fn joined_pinned_followers_match_the_corrected_editor_at_every_step() {
    let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/motion-path-joined-followers-sheet.reference.json");
    let reference = styk_doc::json::parse(&std::fs::read(file).unwrap()).unwrap();
    let outcome = styk_edit::replay::replay(&reference).unwrap();
    assert!(outcome.passed() && outcome.matched == outcome.steps && outcome.unported.is_none(), "{outcome:#?}");
    println!("joined pinned followers: {} / {} steps matched", outcome.matched, outcome.steps);
}
