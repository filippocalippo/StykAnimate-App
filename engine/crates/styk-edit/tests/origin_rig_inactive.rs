#[test]
fn inactive_connector_origin_poses_match_editor_at_every_step() {
    let folder = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");let mut total = 0;
    for kind in ["null", "false", "zero"] {
        for mode in ["native", "sheet", "autokey-sheet"] {
            let file = folder.join(format!("origin-rig-inactive-connector-{kind}-{mode}.reference.json"));
            let reference = styk_doc::json::parse(&std::fs::read(file).unwrap()).unwrap();
            let outcome = styk_edit::replay::replay(&reference).unwrap();
            assert!(outcome.passed() && outcome.matched == outcome.steps && outcome.unported.is_none(), "{kind} / {mode}: {outcome:#?}");total += outcome.steps;
        }
    }
    println!("Inactive origin connectors: {total} matched steps");
}
