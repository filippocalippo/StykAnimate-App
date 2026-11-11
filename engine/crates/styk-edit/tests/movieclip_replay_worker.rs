//! The CLI's worker mode uses the existing replay comparisons and preparation owner.
use std::path::Path;
use styk_doc::{Value, json};
use styk_edit::replay::{replay, replay_worker};
fn reference(folder: &str, name: &str) -> Value {
    json::parse(&std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests").join(folder).join(format!("{name}.reference.json"))).unwrap()).unwrap()
}
#[test]
fn worker_replay_completes_actual_movie_scenarios_while_ordinary_replay_stays_refused() {
    let (mut cases, mut closed) = (0, 0);
    for folder in ["movieclip-timed-sheet-commands", "movieclip-timed-sheet-expansion", "movieclip-sheet-extension", "movieclip-native-extension", "movieclip-insertion", "movieclip-key-capacity"] {
        let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests").join(folder);
        for path in std::fs::read_dir(folder).unwrap().map(|entry| entry.unwrap().path()).filter(|path| path.to_string_lossy().ends_with(".reference.json")) {
            let r = json::parse(&std::fs::read(&path).unwrap()).unwrap();
            if replay(&r).unwrap().unported.is_some() {
                closed += 1;
            }
            let result = replay_worker(&r).unwrap();
            assert!(result.mismatches.is_empty(), "{}: {:?}", path.display(), result.mismatches);
            assert!(result.unported.is_none(), "{}: {:?}", path.display(), result.unported);
            assert_eq!(result.matched, result.steps, "{}", path.display());
            cases += 1;
        }
    }
    assert!(cases >= 60);
    assert!(closed > 0, "ordinary UI dispatch must stay closed for what only the worker plans");
    println!("{cases} editor movie tapes match through the central worker replay");
}
#[test]
fn worker_replay_keeps_every_step_result_document_state_and_events_comparisons() {
    for field in ["result", "document", "state", "events", "history"] {
        let mut r = reference("movieclip-insertion", "insert-sheet");
        let step = r.make_obj().unwrap().get_mut("steps").unwrap().make_arr().unwrap()[2].make_obj().unwrap();
        match field {
            "result" => step.set(field, Value::Num(-123.0)),
            "document" => step.set(field, Value::str("{}")),
            "state" => step.get_mut(field).unwrap().make_obj().unwrap().set("selectedUid", Value::Num(999.0)),
            "events" => step.set(field, Value::array(Vec::new())),
            "history" => step.set(field, Value::object(styk_doc::Obj::new())),
            _ => unreachable!(),
        }
        let result = replay_worker(&r).unwrap();
        assert!(!result.mismatches.is_empty(), "corrupted {field} passed shared comparator");
        assert!(result.unported.is_none());
    }
}
#[test]
fn worker_replay_retains_native_ik_refusal_and_ordinary_replay_outcomes() {
    let r = reference("movieclip-admission", "native-ik-shown");
    let direct = replay(&r).unwrap();let worker = replay_worker(&r).unwrap();
    assert!(direct.unported.is_some());
    assert_eq!(direct.unported, worker.unported);
    assert_eq!(direct.matched, worker.matched);
    assert_eq!(direct.mismatches, worker.mismatches);
}
