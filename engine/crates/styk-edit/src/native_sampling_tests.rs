//! One-tick native rows have distinct authoritative and raw fractional views.
use crate::{Editor, Options};
use styk_doc::Value;
use std::path::Path;

#[test]
fn one_tick_native_shown_and_raw_reads_cannot_contaminate_the_same_cache_tick() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    let reference = styk_doc::json::parse(&std::fs::read(folder.join("origin-motion-layout-native.reference.json")).unwrap()).unwrap();
    let steps = reference.get("steps").unwrap().elements().unwrap().iter().collect::<Vec<_>>();
    let document = steps[..158].iter().rev().find_map(|step| step.get("document").and_then(Value::as_str)).unwrap();
    let expected = steps[158].get("result").and_then(Value::as_str).unwrap();
    let report = styk_doc::json::parse(document.as_bytes()).unwrap();
    for raw_first in [false, true] {
        let mut editor = Editor::new(report.clone(), Options::default());
        editor.call("seek", &[Value::Num(3.5)]).unwrap();
        let (raw, shown) = if raw_first {
            let raw = editor.evaluated(3.5, true).unwrap(); (raw, editor.shown_frame().unwrap())
        } else {
            let shown = editor.shown_frame().unwrap(); (editor.evaluated(3.5, true).unwrap(), shown)
        };
        let snapshot = styk_eval::records::snapshot_pose_frame_of(&shown, None);
        assert_eq!(styk_doc::json::to_string(&snapshot), expected, "editor-native row holds at its recorded pose");
        assert_ne!(raw.get("objects"), shown.get("objects"), "motion raw fractional sampling stays distinct");
        assert_eq!(editor.evaluated(3.5, true).unwrap(), raw);
        assert_eq!(editor.shown_frame().unwrap(), shown);
        assert_eq!(editor.eval.borrow().frames.len(), 2, "both modes use the existing bounded cache");
        assert_eq!(editor.report_json(), document);
    }
}

#[test]
fn one_tick_native_hold_keeps_fractional_scalar_channel_clocks_in_both_views() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/origin-motion-native-reads.json");
    let oracle = styk_doc::json::parse(&std::fs::read(path).unwrap()).unwrap();
    for case in oracle.elements().unwrap().iter() {
        let report = styk_doc::json::parse(case.get("report").and_then(Value::as_str).unwrap().as_bytes()).unwrap();
        let mut editor = Editor::new(report, Options::default());
        // This is an owning read, independent of document-class command admission.
        editor.tick = case.get("tick").and_then(Value::as_f64).unwrap();
        let raw = editor.evaluated(editor.tick, true).unwrap();
        let shown = editor.shown_frame().unwrap();
        for (frame, key) in [(raw, "raw"), (shown, "shown")] {
            assert_eq!(styk_doc::json::to_string(&styk_eval::records::snapshot_pose_frame_of(&frame, None)), case.get(key).and_then(Value::as_str).unwrap(), "{}:{key}", case.get("name").and_then(Value::as_str).unwrap());
            assert_eq!(frame.get("objects").and_then(|objects| objects.item(2)).and_then(|object| object.get("root_x").and_then(Value::as_f64)), Some(635.0));
        }
    }
}
