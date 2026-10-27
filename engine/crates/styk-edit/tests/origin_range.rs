//! Origin range and join commands follow editor recordings at every step.
use std::path::Path;

#[test]
fn origin_range_matches_every_recorded_step() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    for kind in ["layout", "offsets", "support", "saved-layout", "saved-support"] {
        for mode in ["native", "sheet", "autokey-sheet"] {
            if kind.starts_with("saved-") && mode == "native" { continue; }
            let name = format!("origin-range-{kind}-{mode}");
            let reference = styk_doc::json::parse(&std::fs::read(folder.join(format!("{name}.reference.json"))).unwrap()).unwrap();
            let outcome = styk_edit::replay::replay(&reference).unwrap();
            assert!(outcome.passed(), "{name}: {:#?}", outcome.mismatches);
            assert_eq!((outcome.matched, &outcome.unported), (outcome.steps, &None), "{name}");
        }
    }
}

#[test]
fn origin_join_matches_every_recorded_step() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    for kind in ["layout", "offsets", "support", "saved-layout", "saved-support"] {
        for mode in ["native", "sheet", "autokey-sheet"] {
            if kind.starts_with("saved-") && mode == "native" { continue; }
            let name = format!("origin-join-{kind}-{mode}");
            let reference = styk_doc::json::parse(&std::fs::read(folder.join(format!("{name}.reference.json"))).unwrap()).unwrap();
            let outcome = styk_edit::replay::replay(&reference).unwrap();
            assert!(outcome.passed(), "{name}: {:#?}", outcome.mismatches);
            assert_eq!((outcome.matched, &outcome.unported), (outcome.steps, &None), "{name}");
        }
    }
}

#[test]
fn origin_ranges_and_joins_with_ik_limbs_run() {
    use styk_doc::Value;
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    for kind in ["pinned", "free"] {
        let report = styk_doc::json::parse(&std::fs::read(folder.join(format!("origin-pose-support-{kind}-sheet.document.json"))).unwrap()).unwrap();
        let mut editor = styk_edit::Editor::new(report, styk_edit::Options { property_channels: true, layer_timeline: true, auto_key: false });
        editor.call("select", &[Value::Num(1.0), Value::Num(-1.0)]).unwrap();
        let indices = Value::array(vec![Value::Num(0.0), Value::Num(1.0)]);
        for (method, args) in [("rotateFiguresInFrames", vec![Value::Num(0.27), indices.clone()]), ("mirrorFiguresInFrames", vec![Value::str("horizontal"), indices.clone()]), ("scaleFiguresInFrames", vec![Value::Num(1.125), indices.clone()]), ("resetPoseInFrames", vec![indices.clone()]), ("unjoinFigure", vec![]), ("joinTo", vec![Value::Num(2.0), Value::Num(22.0)])] {
            let result = editor.call(method, &args);
            assert!(!matches!(result, Err(styk_edit::EditError::Unported(_))), "{kind} {method}: {result:?}");
        }
    }
}
