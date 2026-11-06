//! Set Origin support is admitted only after matching editor-built recordings.
use std::path::Path;
const RECORDINGS: &[&str] = &[
    "origin-reroot-new-native",
    "origin-reroot-new-sheet",
    "origin-reroot-layout-native",
    "origin-reroot-layout-sheet",
    "origin-reroot-offsets-native",
    "origin-reroot-offsets-sheet",
    "origin-reroot-support-native",
    "origin-reroot-support-sheet",
];
#[test]
fn origin_reroot_matches_every_recorded_step() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    for name in RECORDINGS {
        let reference = styk_doc::json::parse(
            &std::fs::read(folder.join(format!("{name}.reference.json"))).unwrap(),
        )
        .unwrap();
        let outcome = styk_edit::replay::replay(&reference).unwrap();
        assert!(outcome.passed(), "{name}: {:#?}", outcome.mismatches);
        assert_eq!(
            (outcome.matched, &outcome.unported),
            (outcome.steps, &None),
            "{name}"
        );
    }
}

#[test]
fn origin_topology_matches_every_recorded_step() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    for kind in ["layout", "offsets", "support"] {
        for mode in ["native", "sheet"] {
            let name = format!("origin-topology-{kind}-{mode}");
            let reference = styk_doc::json::parse(
                &std::fs::read(folder.join(format!("{name}.reference.json"))).unwrap(),
            )
            .unwrap();
            let outcome = styk_edit::replay::replay(&reference).unwrap();
            assert!(outcome.passed(), "{name}: {:#?}", outcome.mismatches);
            assert_eq!(
                (outcome.matched, &outcome.unported),
                (outcome.steps, &None),
                "{name}"
            );
        }
    }
}

#[test]
fn malformed_support_refuses_atomically_before_committing_a_gesture() {
    use styk_doc::Value;
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../styk-eval/tests/fixtures");
    let oracle = styk_doc::json::parse(&std::fs::read(root.join("origin-invalid-support.json")).unwrap()).unwrap();
    let document = std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit").join(oracle.get("document").unwrap().as_str().unwrap())).unwrap();
    for test in oracle.get("cases").unwrap().elements().unwrap().iter() {
        let name = test.get("name").unwrap().as_str().unwrap();
        assert_eq!(test.get("refused"), Some(&Value::Bool(true)), "{name}: JS oracle");
        let mut report = styk_doc::json::parse(&document).unwrap();
        let mut at = report.make_obj().unwrap().get_mut("figure_types").unwrap().make_arr().unwrap()[0]
            .make_obj().unwrap().get_mut("_styk").unwrap().make_obj().unwrap().get_mut("animationOrigin").unwrap();
        let path: Vec<_> = test.get("path").unwrap().elements().unwrap().iter().collect();
        for key in &path[..path.len() - 1] {
            at = match key.as_str() {
                Some(key) => at.make_obj().unwrap().get_mut(key).unwrap(),
                None => &mut at.make_arr().unwrap()[key.as_f64().unwrap() as usize],
            };
        }
        let key = path.last().unwrap();
        let value = test.get("value").unwrap();
        let value = match value.get("specialNumber").and_then(Value::as_str) {
            Some("NaN") => Value::Num(f64::NAN),
            Some("Infinity") => Value::Num(f64::INFINITY),
            Some("-Infinity") => Value::Num(f64::NEG_INFINITY),
            _ => value.clone(),
        };
        match key.as_str() {
            Some(key) => {
                if test.get("remove") == Some(&Value::Bool(true)) { at.make_obj().unwrap().remove(key); }
                else { at.make_obj().unwrap().set(key, value); }
            }
            None => at.make_arr().unwrap()[key.as_f64().unwrap() as usize] = value,
        }
        let mut editor = styk_edit::Editor::new(report, styk_edit::Options::default());
        // A changed drag on an ordinary figure must survive refusal of a topology
        // command on the malformed origin-bearing figure.
        editor.call("select", &[Value::Num(3.0), Value::Num(-1.0)]).unwrap();
        editor.call("beginTranslationDrag", &[]).unwrap();
        editor.call("moveSelection", &[Value::Num(4.0), Value::Num(-2.0)]).unwrap();
        editor.call("select", &[Value::Num(1.0), Value::Num(2.0)]).unwrap();
        let before = (editor.report_json(), editor.state());
        for (method, args) in [("mirrorSegmentBranch", vec![Value::str("vertical")]), ("setOrigin", vec![Value::Num(55.0)])] {
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| editor.call(method, &args)));
            assert!(outcome.is_ok(), "{name} {method}: malformed support panicked");
            assert!(matches!(outcome.unwrap(), Err(styk_edit::EditError::Unported(_))), "{name} {method}: malformed support was admitted");
            assert_eq!((editor.report_json(), editor.state()), before, "{name} {method}: refusal committed or changed a gesture");
        }
    }
}
