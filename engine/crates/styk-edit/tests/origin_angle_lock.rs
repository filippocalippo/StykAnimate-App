//! Actual-editor sparse rig-definition changes preserve both pose and native history.
use std::path::Path;
#[test]
fn origin_angle_lock_and_secondary_reference_match_each_recorded_step() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    let mut total = 0;
    for kind in ["layout", "offsets", "support", "saved-layout", "saved-support"] {
        let modes: &[&str] = if kind.starts_with("saved-") { &["sheet", "autokey-sheet"] } else { &["native", "sheet", "autokey-sheet"] };
        for mode in modes {
            let name = format!("origin-angle-lock-{kind}-{mode}");
            let reference = styk_doc::json::parse(&std::fs::read(folder.join(format!("{name}.reference.json"))).unwrap()).unwrap();
            let outcome = styk_edit::replay::replay(&reference).unwrap();
            assert!(outcome.passed() && outcome.matched == outcome.steps && outcome.unported.is_none(), "{name}: {outcome:#?}");
            total += outcome.steps;
        }
    }
    println!("origin angle locks/references: {total} exact steps");
}

#[test]
fn ordinary_rig_angle_lock_definition_lifecycle_stays_exact() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    for name in ["rig-behavior-native", "rig-behavior-sheet", "rig-behavior-ik-sheet"] {
        let reference = styk_doc::json::parse(&std::fs::read(folder.join(format!("{name}.reference.json"))).unwrap()).unwrap();
        let outcome = styk_edit::replay::replay(&reference).unwrap();
        assert!(outcome.passed() && outcome.matched == outcome.steps && outcome.unported.is_none(), "{name}: {outcome:#?}");
    }
}
