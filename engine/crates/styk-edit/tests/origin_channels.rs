//! Origin property edits and saved-channel gestures match the editor step by step.
use std::path::Path;

#[test]
fn origin_channel_edits_match_every_recorded_step() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    for kind in ["layout", "offsets", "support", "saved-layout", "saved-support"] {
        for mode in ["sheet", "autokey-sheet"] {
            let name = format!("origin-channels-{kind}-{mode}");
            let reference = styk_doc::json::parse(&std::fs::read(folder.join(format!("{name}.reference.json"))).unwrap()).unwrap();
            let outcome = styk_edit::replay::replay(&reference).unwrap();
            assert!(outcome.passed(), "{name}: {:#?}", outcome.mismatches);
            assert_eq!((outcome.matched, &outcome.unported), (outcome.steps, &None), "{name}");
        }
    }
}

#[test]
fn saved_native_origin_unrecorded_scalar_mutations_remain_refused() {
    let report = styk_doc::json::parse(&std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../styk-eval/tests/fixtures/records/channels-origin-support-native/report.json")).unwrap()).unwrap();
    let mut editor = styk_edit::Editor::new(report, styk_edit::Options::default());
    let before = (editor.report_json(), editor.state());
    // Recorded saved native motion admits selection/history. Its authored-pose
    // header does not admit these scalar or ordinary pose mutations.
    for method in ["moveSelection", "poseJoint", "beginAnimationEdit", "addAnimationKey", "addAnimationKeys"] {
        assert!(matches!(editor.call(method, &[]), Err(styk_edit::EditError::Unported(_))), "{method}");
        assert_eq!((editor.report_json(), editor.state()), before, "{method} changed state on refusal");
    }
}

#[test]
fn future_only_plain_properties_match_recorded_steps() {
    let reference = styk_doc::json::parse(&std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/origin-channels-future-sheet.reference.json")).unwrap()).unwrap();
    let outcome = styk_edit::replay::replay(&reference).unwrap();
    assert!(outcome.passed(), "{:#?}", outcome.mismatches);
    assert_eq!((outcome.matched, &outcome.unported), (outcome.steps, &None));
}

