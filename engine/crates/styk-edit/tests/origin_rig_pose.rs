#[test]
fn two_dimensional_rig_origin_gestures_match_editor_at_every_step() {
    let folder = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    let mut total = 0;
    for kind in ["layout", "offsets", "support", "saved-layout", "saved-support"] {
        let modes: &[&str] = if kind.starts_with("saved-") { &["sheet", "autokey-sheet"] } else { &["native", "sheet", "autokey-sheet"] };
        for mode in modes {
            let file = folder.join(format!("origin-rig-pose-{kind}-{mode}.reference.json"));
            let reference = styk_doc::json::parse(&std::fs::read(file).unwrap()).unwrap();
            let outcome = styk_edit::replay::replay(&reference).unwrap();
            assert!(outcome.passed() && outcome.matched == outcome.steps && outcome.unported.is_none(), "{kind} / {mode}: {outcome:#?}");
            total += outcome.steps;
        }
    }
    for mode in ["native", "sheet"] {
        let file = folder.join(format!("slide-connector-direct-{mode}.reference.json"));
        let reference = styk_doc::json::parse(&std::fs::read(file).unwrap()).unwrap();
        let outcome = styk_edit::replay::replay(&reference).unwrap();
        assert!(outcome.passed() && outcome.matched == outcome.steps && outcome.unported.is_none(), "direct connector / {mode}: {outcome:#?}");
        total += outcome.steps;
    }
    println!("2D rig/origin gestures: {total} matched steps");
}
