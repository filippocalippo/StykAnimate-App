use std::path::PathBuf;
use styk_doc::json;

#[test]
fn recorded_history_sizes_limits_and_retirement_match_the_editor() {
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/history");
    let mut files: Vec<_> = std::fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect();
    files.sort();
    assert!(files.len() >= 23);
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
fn worker_readiness_and_invalid_settings_preserve_the_existing_owner() {
    use styk_edit::{EditError, Editor, HistoryLimits, Options};
    let file =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/history/native-count-2.json");
    let reference = json::parse(&std::fs::read(file).unwrap()).unwrap();
    let report = json::parse(
        reference
            .path(&["steps"])
            .unwrap()
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
    let before = editor.report().clone();
    assert_eq!(editor.history_limits().count, 80);
    assert_eq!(editor.history_limits().bytes, 48.0 * 1024.0 * 1024.0);
    assert_eq!(editor.history_size(), None);
    assert!(matches!(
        editor.trim_worker_history(),
        Err(EditError::Unported(_))
    ));
    assert!(matches!(
        editor.configure_worker_history(HistoryLimits {
            count: 2,
            bytes: f64::NAN
        }),
        Err(EditError::Invalid(_))
    ));
    assert!(matches!(
        editor.configure_worker_history(HistoryLimits {
            count: 2,
            bytes: -1.0
        }),
        Err(EditError::Invalid(_))
    ));
    assert!(editor.report().same_node(&before));
    assert_eq!(editor.history_size(), None);
    editor
        .configure_worker_history(HistoryLimits::default())
        .unwrap();
    assert_eq!(editor.history_size(), Some(0.0));
    editor
        .configure_worker_history(HistoryLimits {
            count: 0,
            bytes: f64::INFINITY,
        })
        .unwrap();
    assert_eq!(editor.history_limits().count, 0);
}
