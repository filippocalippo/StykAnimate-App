//! Legal spatial pose-choice documents are actual editor recordings.
use std::path::Path;
#[test]
fn spatial_origin_choices_match_native_sheet_and_joined_recordings() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");let mut total = 0;
    for kind in ["visibility", "presets", "mixed"] {
        let joined_modes: &[bool] = if kind == "mixed" { &[false, true] } else { &[false] };
        for joined in joined_modes {for origin in ["layout", "support"] {for mode in ["native", "sheet", "autokey-sheet"] {
            let suffix = if *joined { "-joined" } else { "" };
            let name = format!("origin-pose-choice-{kind}-{origin}-{mode}{suffix}");
            let reference = styk_doc::json::parse(&std::fs::read(folder.join(format!("{name}.reference.json"))).unwrap()).unwrap();
            let outcome = styk_edit::replay::replay(&reference).unwrap();
            assert!(outcome.passed() && outcome.matched == outcome.steps && outcome.unported.is_none(), "{name}: {outcome:#?}");total += outcome.steps;
        }}}
    }
    println!("spatial origin choices: {total} exact steps");
}

#[test]
fn ordinary_choice_recordings_remain_exact() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    for name in ["pose-choices-sheet", "pose-presets-sheet", "pose-choice-mechanism-sheet"] {
        let reference = styk_doc::json::parse(&std::fs::read(folder.join(format!("{name}.reference.json"))).unwrap()).unwrap();
        let outcome = styk_edit::replay::replay(&reference).unwrap();
        assert!(outcome.passed() && outcome.matched == outcome.steps && outcome.unported.is_none(), "{name}: {outcome:#?}");
    }
}
