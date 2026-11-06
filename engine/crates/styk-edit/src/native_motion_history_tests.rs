//! The editor-built histories certify the SAME ranges serializer for worker sizing.
use crate::{CommandKind, Editor, Options};
use styk_doc::{Obj, Value};
use std::path::Path;

#[test]
fn native_motion_history_records_and_utf16_weights_match_the_editor() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    let oracle = styk_doc::json::parse(&std::fs::read(folder.join("origin-motion-native-history.json")).unwrap()).unwrap();
    for case in oracle.elements().unwrap().iter() {
        let name = case.get("name").and_then(Value::as_str).unwrap();
        let report = styk_doc::json::parse(&std::fs::read(folder.join(format!("{name}.document.json"))).unwrap()).unwrap();
        let scenario = styk_doc::json::parse(&std::fs::read(folder.join(format!("{name}.scenario.json"))).unwrap()).unwrap();
        let entries = case.get("history").unwrap().elements().unwrap().iter().collect::<Vec<_>>();
        let mut editor = Editor::new(report, Options::default());
        let initial = case.get("initial").unwrap();
        editor.set_revision_counters(
            initial.get("revision").and_then(Value::as_f64).unwrap() as u64,
            initial.get("revisionSerial").and_then(Value::as_f64).unwrap() as u64,
            initial.get("savedRevision").and_then(Value::as_f64).unwrap() as u64,
        );
        editor.configure_worker_history(crate::HistoryLimits::default()).unwrap();
        let mut checked = 0;
        for (index, call) in scenario.get("steps").unwrap().elements().unwrap().iter().enumerate() {
            let method = call.item(0).unwrap(); let method = method.as_str().unwrap();
            if method.starts_with('@') && !matches!(method,"@select"|"@seek") { continue; }
            let args = call.elements().unwrap().iter().skip(1).collect::<Vec<_>>();
            let result = editor.call(method, &args);
            let Some(expected) = entries.iter().find(|entry| entry.get("step").and_then(Value::as_f64) == Some((index + 1) as f64)) else { continue };
            result.unwrap();
            let command = editor.undo.last().unwrap();
            let mut value = Obj::new();
            // Match the actual enumerable command order as well as its fields.
            match &command.kind {
                CommandKind::Ranges { changes, structural, timing } => {
                    value.set("kind", Value::str("ranges")); value.set("label", Value::str(&command.label));
                    value.set("changes", Value::array(changes.iter().map(crate::frame::FrameSlice::history_value).collect()));
                    value.set("beforeSelection", command.before_selection.history_value());
                    value.set("structural", Value::Bool(*structural)); value.set("timing", Value::Bool(*timing));
                    value.set("afterSelection", command.after_selection.history_value());
                },
                CommandKind::Objects { index, before, after } => {
                    value.set("kind", Value::str("objects")); value.set("label", Value::str(&command.label));
                    value.set("index", Value::Num(*index as f64));
                    value.set("before", Value::array(before.clone())); value.set("after", Value::array(after.clone()));
                    value.set("beforeSelection", command.before_selection.history_value());
                    value.set("afterSelection", command.after_selection.history_value());
                    value.set("structural", Value::Bool(false)); value.set("timing", Value::Bool(false));
                },
                other => panic!("{name}:{index}: unexpected history {other:?}"),
            }
            value.set("beforeRevision", Value::Num(command.before_revision as f64));
            value.set("afterRevision", Value::Num(command.after_revision as f64));
            let value = Value::object(value);
            assert_eq!(&value, expected.get("command").unwrap(), "{name}: command at step {}", index + 1);
            assert_eq!((styk_doc::json::to_string(&value).encode_utf16().count() * 2) as f64, expected.get("bytes").and_then(Value::as_f64).unwrap(), "{name}: exact worker weight");
            let history = editor.history_value();
            let recorded = history.get("undo").unwrap().elements().unwrap().iter().last().unwrap();
            assert_eq!(recorded.get("bytes"), expected.get("bytes"), "{name}: existing worker history owner weight");
            checked += 1;
        }
        assert_eq!(checked, entries.len());
    }
}
