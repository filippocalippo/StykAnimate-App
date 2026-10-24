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
fn future_complex_range_targets_refuse_atomically_during_a_drag() {
    use styk_doc::{Obj, Value};
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    for (document, selected) in [("origin-future-rig-sheet", 3.0), ("origin-future-rig-joined-sheet", 2.0), ("origin-changing-rig-sheet", 3.0)] {
        let report = styk_doc::json::parse(&std::fs::read(folder.join(format!("{document}.document.json"))).unwrap()).unwrap();
        let mut editor = styk_edit::Editor::new(report, styk_edit::Options { property_channels: true, layer_timeline: true, auto_key: false });
        editor.call("select", &[Value::Num(1.0), Value::Num(-1.0)]).unwrap();
        editor.call("beginTranslationDrag", &[]).unwrap();
        editor.call("moveSelection", &[Value::Num(7.25), Value::Num(-3.5)]).unwrap();
        editor.take_events();
        let before = (editor.report_json(), editor.state(), editor.drag_value(), editor.draft_figures());
        let mut indices = Obj::new(); indices.set("@array", Value::array(vec![Value::Num(1.0)])); indices.set("sheetTicks", Value::array(vec![Value::Num(8.0)])); let indices = Value::object(indices);
        let mut options = Obj::new(); options.set("uids", Value::array(vec![Value::Num(selected)])); let options = Value::object(options);
        let calls = [
            ("rotateFiguresInFrames", vec![Value::Num(0.27), indices.clone(), options.clone()]),
            ("mirrorFiguresInFrames", vec![Value::str("horizontal"), indices.clone(), options.clone()]),
            ("scaleFiguresInFrames", vec![Value::Num(1.125), indices.clone(), options.clone()]),
            ("resetPoseInFrames", vec![indices.clone(), options.clone()]),
            ("centerFiguresInFrames", vec![indices.clone(), options.clone()]),
            ("detachFiguresInFrames", vec![indices.clone(), options.clone()]),
            ("joinFiguresInFrames", vec![Value::Num(selected), Value::Num(22.0), indices.clone(), Value::Null]),
        ];
        for (method, args) in calls {
            assert!(matches!(editor.call(method, &args), Err(styk_edit::EditError::Unported(_))), "{document} {method}");
            assert_eq!((editor.report_json(), editor.state(), editor.drag_value(), editor.draft_figures()), before, "{document} {method} changed editor or live pose on refusal");
            assert!(editor.take_events().is_empty(), "{document} {method} emitted on refusal");
        }
    }
}

#[test]
fn complex_direct_joins_and_unrecorded_origin_ranges_remain_refused() {
    use styk_doc::{Obj, Value};
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    let document = std::fs::read(folder.join("origin-range-support-native.document.json")).unwrap();
    let mut report = styk_doc::json::parse(&document).unwrap();
    report.make_obj().unwrap().get_mut("figure_types").unwrap().make_arr().unwrap()[1].make_obj().unwrap().get_mut("segments").unwrap().make_arr().unwrap()[0].make_obj().unwrap().set("_stykRig", Value::object(Obj::new()));
    let mut editor = styk_edit::Editor::new(report, styk_edit::Options::default());
    editor.call("select", &[Value::Num(1.0), Value::Num(-1.0)]).unwrap();editor.call("beginTranslationDrag", &[]).unwrap();editor.call("moveSelection", &[Value::Num(7.25), Value::Num(-3.5)]).unwrap();editor.take_events();
    let before = (editor.report_json(), editor.state(), editor.drag_value(), editor.draft_figures());
    for (method, args) in [("joinTo", vec![Value::Num(2.0), Value::Num(22.0)]), ("joinFigure", vec![Value::Num(2.0), Value::Num(22.0)]), ("unjoinFigure", vec![])] {
        assert!(matches!(editor.call(method, &args), Err(styk_edit::EditError::Unported(_))), "{method}");
        assert_eq!((editor.report_json(), editor.state(), editor.drag_value(), editor.draft_figures()), before, "{method}");assert!(editor.take_events().is_empty());
    }
    let report = styk_doc::json::parse(&document).unwrap();let mut editor = styk_edit::Editor::new(report, styk_edit::Options::default());
    editor.call("select", &[Value::Num(1.0), Value::Num(-1.0)]).unwrap();editor.call("beginTranslationDrag", &[]).unwrap();editor.call("moveSelection", &[Value::Num(7.25), Value::Num(-3.5)]).unwrap();editor.take_events();
    let before = (editor.report_json(), editor.state(), editor.drag_value(), editor.draft_figures());
    for method in ["applyFigureRange", "addFigureInFrames", "duplicateFiguresInFrames", "deleteFiguresInFrames", "updateFiguresInFrames", "orderFiguresInFrames", "moveSelectionInFrames", "alignFigures", "recolorFiguresInFrames", "beginMotionPathEdit"] {
        assert!(matches!(editor.call(method, &[]), Err(styk_edit::EditError::Unported(_))), "{method}");
        assert_eq!((editor.report_json(), editor.state(), editor.drag_value(), editor.draft_figures()), before, "{method}");assert!(editor.take_events().is_empty());
    }
}

#[test]
fn future_connected_range_moves_guard_the_complex_root() {
    use styk_doc::{Obj, Value};
    let document = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/origin-future-rig-joined-sheet.document.json");
    let report = styk_doc::json::parse(&std::fs::read(document).unwrap()).unwrap();
    let mut editor = styk_edit::Editor::new(report, styk_edit::Options { property_channels: true, layer_timeline: true, auto_key: false });
    editor.call("select", &[Value::Num(2.0), Value::Num(-1.0)]).unwrap();editor.call("beginTranslationDrag", &[]).unwrap();editor.call("moveSelection", &[Value::Num(7.25), Value::Num(-3.5)]).unwrap();editor.take_events();
    let before = (editor.report_json(), editor.state(), editor.drag_value(), editor.draft_figures());
    let mut indices = Obj::new();indices.set("@array", Value::array(vec![Value::Num(1.0)]));indices.set("sheetTicks", Value::array(vec![Value::Num(8.0)]));
    assert!(matches!(editor.call("moveSelectionInFrames", &[Value::Num(4.25), Value::Num(-2.125), Value::object(indices)]), Err(styk_edit::EditError::Unported(_))));
    assert_eq!((editor.report_json(), editor.state(), editor.drag_value(), editor.draft_figures()), before);assert!(editor.take_events().is_empty());
}

#[test]
fn unrecorded_origin_range_ik_combinations_refuse_atomically() {
    use styk_doc::Value;
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    for kind in ["pinned", "free"] {
        let report = styk_doc::json::parse(&std::fs::read(folder.join(format!("origin-pose-support-{kind}-native.document.json"))).unwrap()).unwrap();
        let mut editor = styk_edit::Editor::new(report, styk_edit::Options::default());
        editor.call("select", &[Value::Num(1.0), Value::Num(-1.0)]).unwrap();editor.call("beginTranslationDrag", &[]).unwrap();editor.call("moveSelection", &[Value::Num(7.25), Value::Num(-3.5)]).unwrap();editor.take_events();
        let before = (editor.report_json(), editor.state(), editor.drag_value(), editor.draft_figures());
        let indices = Value::array(vec![Value::Num(0.0), Value::Num(1.0)]);
        for (method, args) in [("rotateFiguresInFrames", vec![Value::Num(0.27), indices.clone()]), ("mirrorFiguresInFrames", vec![Value::str("horizontal"), indices.clone()]), ("scaleFiguresInFrames", vec![Value::Num(1.125), indices.clone()]), ("resetPoseInFrames", vec![indices.clone()]), ("joinTo", vec![Value::Num(2.0), Value::Num(22.0)])] {
            assert!(matches!(editor.call(method, &args), Err(styk_edit::EditError::Unported(_))), "{kind} {method}");
            assert_eq!((editor.report_json(), editor.state(), editor.drag_value(), editor.draft_figures()), before);assert!(editor.take_events().is_empty());
        }
    }
}
