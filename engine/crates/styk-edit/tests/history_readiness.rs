use std::path::PathBuf;
use styk_doc::{json, Value};
use styk_edit::{EditError, Editor, HistoryLimits, Options};

#[test]
fn recorded_warm_checkpoints_keep_exact_entry_metadata_and_arithmetic() {
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/history-readiness");
    let mut files: Vec<_> = std::fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|file| {
            file.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect();
    files.sort();
    assert!(files.len() >= 10);
    for file in files {
        let reference = json::parse(&std::fs::read(&file).unwrap()).unwrap();
        let outcome = styk_edit::replay::replay(&reference).unwrap();
        assert!(
            outcome.unported.is_none(),
            "{}: {:?}",
            file.display(),
            outcome.unported
        );
        assert!(
            outcome.mismatches.is_empty(),
            "{}: {:?}",
            file.display(),
            outcome.mismatches
        );
        assert_eq!(outcome.matched, outcome.steps, "{}", file.display());
    }
}

#[test]
fn dense_cancel_stale_and_invalid_checkpoint_leave_the_owner_unmodified() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/history-readiness/warm-dense.json");
    let reference = json::parse(&std::fs::read(path).unwrap()).unwrap();
    let steps = reference.get("steps").unwrap();
    let report = json::parse(
        steps
            .item(0)
            .unwrap()
            .get("document")
            .unwrap()
            .as_str()
            .unwrap()
            .as_bytes(),
    )
    .unwrap();
    let mut editor = Editor::new(report, Options::default());
    editor.set_revision_counters(2, 2, 2);
    editor
        .call("select", &[Value::Num(1.0), Value::Num(-1.0)])
        .unwrap();
    editor
        .call("moveSelection", &[Value::Num(1.0), Value::Num(2.0)])
        .unwrap();
    editor
        .call("moveSelection", &[Value::Num(3.0), Value::Num(4.0)])
        .unwrap();
    let before = editor.report().clone();
    let state = editor.state();
    let limits = editor.history_limits();
    let checkpoint = steps
        .item(4)
        .unwrap()
        .get("call")
        .unwrap()
        .item(3)
        .unwrap()
        .as_f64()
        .unwrap();
    for reason in ["cancelled", "stale"] {
        let mut checks = 0;
        let result = editor.prepare_worker_history(HistoryLimits::default(), checkpoint, || {
            checks += 1;
            if checks == 5 {
                Err(EditError::Invalid(reason.into()))
            } else {
                Ok(())
            }
        });
        assert!(matches!(result,Err(EditError::Invalid(ref actual)) if actual==reason));
        assert_eq!(checks, 5);
        assert!(editor.report().same_node(&before));
        assert_eq!(editor.state().can_undo, state.can_undo);
        assert_eq!(editor.state().undo_label, state.undo_label);
        assert_eq!(editor.history_size(), None);
        assert_eq!(editor.history_limits().count, limits.count);
        assert_eq!(editor.history_limits().bytes, limits.bytes);
    }
    assert!(matches!(
        editor.prepare_worker_history(HistoryLimits::default(), f64::INFINITY, || Ok(())),
        Err(EditError::Invalid(_))
    ));
    assert_eq!(editor.history_size(), None);
    let mut checks = 0;
    editor
        .prepare_worker_history(HistoryLimits::default(), checkpoint, || {
            checks += 1;
            Ok(())
        })
        .unwrap();
    assert!(checks > 10);
    assert_eq!(editor.history_size(), Some(checkpoint));
    assert!(editor.report().same_node(&before));
    assert!(matches!(
        editor.prepare_worker_history(HistoryLimits::default(), checkpoint + 1.0, || Ok(())),
        Err(EditError::Invalid(_))
    ));
    assert_eq!(editor.history_size(), Some(checkpoint));
}
