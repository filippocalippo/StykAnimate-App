//! Worker planning + owning publication is compared at every actual editor step.
use std::path::Path;
use styk_doc::{Value, json};
use styk_edit::{EditError, Editor, Options, Selection, movieclip_planning::TimelineWorker};
fn items(value: Option<&Value>) -> Vec<Value> {
    value
        .and_then(Value::elements)
        .map(|e| e.iter().collect())
        .unwrap_or_default()
}
fn plain(value: &Value, depth: usize) -> Option<Value> {
    match value {
        Value::Null | Value::Bool(_) | Value::Num(_) | Value::Str(_) | Value::Blob(_) => {
            Some(value.clone())
        }
        _ if depth == 0 => None,
        Value::Arr(_) | Value::Nums(_) => Some(Value::array(
            items(Some(value))
                .iter()
                .filter_map(|v| plain(v, depth - 1))
                .collect(),
        )),
        Value::Obj(o) => Some(Value::object(
            o.iter()
                .filter_map(|(k, v)| Some((k.clone(), plain(v, depth - 1)?)))
                .collect(),
        )),
    }
}
fn assert_json(actual: &str, expected: &str, context: &str) {
    if actual != expected {
        let at = actual
            .bytes()
            .zip(expected.bytes())
            .position(|(a, b)| a != b)
            .unwrap_or(actual.len().min(expected.len()));
        let excerpt = |s: &str| {
            String::from_utf8_lossy(
                &s.as_bytes()[at.saturating_sub(80).min(s.len())..(at + 200).min(s.len())],
            )
            .into_owned()
        };
        panic!(
            "{context} byte{at}: {} / {}",
            excerpt(actual),
            excerpt(expected)
        );
    }
}
fn editor(initial: &Value, report: Value, sheet: bool) -> Editor {
    let state = initial.get("state").unwrap();
    let mut e = Editor::new(
        report,
        Options {
            property_channels: sheet,
            layer_timeline: sheet,
            auto_key: false,
        },
    );
    e.set_view(
        state.get("tick").unwrap().as_f64().unwrap(),
        state.get("frameIndex").unwrap().as_f64().unwrap() as usize,
        Selection {
            uid: state
                .get("selectedUid")
                .and_then(Value::as_f64)
                .map(|u| u as u32),
            uids: state
                .get("selectedUids")
                .unwrap()
                .numbers()
                .unwrap()
                .iter()
                .map(|u| *u as u32)
                .collect(),
            joint: state.get("selectedJoint").unwrap().as_f64().unwrap() as i64,
        },
    );
    e.set_counters(
        state.get("layerRevision").unwrap().as_f64().unwrap() as u64,
        state.get("nextFrameIdentity").unwrap().as_f64().unwrap() as u64,
        state.get("nextUid").unwrap().as_f64().unwrap() as u64,
    );
    e
}
#[test]
fn movieclip_insertion_matches_every_editor_step() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/movieclip-insertion");
    for name in [
        "insert-native",
        "insert-native-fraction",
        "insert-native-layer2",
        "insert-native-empty",
        "insert-native-slow",
        "insert-native-locked",
        "insert-native-live",
        "insert-native-repeat",
        "insert-native-saved-layer2",
        "insert-native-saved-fraction",
        "insert-native-triple",
        "insert-sheet",
        "insert-sheet-fraction",
        "insert-sheet-layer2",
        "insert-sheet-empty",
        "insert-sheet-slow",
        "insert-sheet-locked",
        "insert-sheet-live",
        "insert-sheet-repeat",
    ] {
        let sheet = name.contains("-sheet");
        let reference =
            json::parse(&std::fs::read(folder.join(format!("{name}.reference.json"))).unwrap())
                .unwrap();
        let steps = items(reference.get("steps"));
        let mut expected = steps[0]
            .get("document")
            .unwrap()
            .as_str()
            .unwrap()
            .to_string();
        let mut e = editor(&steps[0], json::parse(expected.as_bytes()).unwrap(), sheet);
        for step in &steps[1..] {
            let number = step.get("step").unwrap().as_f64().unwrap();
            let call = items(step.get("call"));
            let method = call[0].as_str().unwrap();
            let result = if sheet && method == "addFigure" {
                e.call_movieclip_timeline_worker(
                    method,
                    &call[1..],
                    &mut TimelineWorker {
                        max_source_bytes: 128 * 1024 * 1024,
                        check: &mut || Ok(()),
                        progress: &mut |_| {},
                        clock: || 0.0,
                    },
                )
            } else {
                e.call(method, &call[1..])
            };
            let context = format!("{name} step{number} ({method})");
            match (result, step.get("error").filter(|v| !v.is_null())) {
                (Ok(result), None) => {
                    if !["@seek", "seek"].contains(&method) {
                        assert_json(
                            &json::to_string(&plain(&result, 4).unwrap_or(Value::Null)),
                            &json::to_string(step.get("result").unwrap()),
                            &format!("{context} result"),
                        );
                    }
                }
                (Err(EditError::Invalid(key)), Some(error)) => assert_eq!(
                    Some(styk_edit::error_key(&key)),
                    error.get("key").and_then(Value::as_str),
                    "{context}"
                ),
                (other, error) => {
                    panic!("{context}: unsupported/error mismatch {other:?} vs {error:?}")
                }
            }
            if let Some(document) = step.get("document").and_then(Value::as_str) {
                expected = document.into();
            }
            assert_json(&e.report_json(), &expected, &format!("{context} document"));
            assert_json(
                &json::to_string(&e.state_value()),
                &json::to_string(step.get("state").unwrap()),
                &format!("{context} state"),
            );
            assert_json(
                &json::to_string(&Value::array(e.take_events())),
                &json::to_string(step.get("events").unwrap()),
                &format!("{context} events"),
            );
        }
    }
}

#[test]
fn insertion_publication_rejection_preserves_live_editor() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/movieclip-insertion");
    let reference =
        json::parse(&std::fs::read(folder.join("insert-sheet.reference.json")).unwrap()).unwrap();
    let initial = items(reference.get("steps"))[0].clone();
    let report = json::parse(
        initial
            .get("document")
            .unwrap()
            .as_str()
            .unwrap()
            .as_bytes(),
    )
    .unwrap();
    for mode in ["publication-budget", "publication-cancel"] {
        let mut e = editor(&initial, report.clone(), true);
        e.call("@seek", &[Value::Num(2.0)]).unwrap();
        e.call("@select", &[Value::Num(2.0), Value::Num(-1.0)])
            .unwrap();
        e.call("beginTranslationDrag", &[Value::str("Other figure")])
            .unwrap();
        e.call("moveSelection", &[Value::Num(4.5), Value::Num(-2.25)])
            .unwrap();
        e.call("@select", &[Value::Num(1.0), Value::Num(-1.0)])
            .unwrap();
        e.take_events();
        let before = e.report_json();
        let state = json::to_string(&e.state_value());
        let cancelled = std::cell::Cell::new(false);
        let mut check = || {
            if cancelled.get() {
                Err(EditError::Invalid("worker-cancelled".into()))
            } else {
                Ok(())
            }
        };
        let mut progress = |_| {
            if mode == "publication-cancel" {
                cancelled.set(true);
            }
        };
        let result = e.call_movieclip_timeline_worker(
            "addFigure",
            &[Value::Num(4.0)],
            &mut TimelineWorker {
                max_source_bytes: if mode == "publication-budget" {
                    1
                } else {
                    128 * 1024 * 1024
                },
                check: &mut check,
                progress: &mut progress,
                clock: || 0.0,
            },
        );
        match result {
            Err(EditError::Invalid(key)) => assert_eq!(
                key,
                if mode == "publication-budget" {
                    "errors.editorLayerMigration.thisLayerMigrationExceedsTheRetainedPoseMemory"
                } else {
                    "worker-cancelled"
                }
            ),
            other => panic!("{mode}: wrong refusal {other:?}"),
        }
        assert_json(&e.report_json(), &before, &format!("{mode} document"));
        assert_json(
            &json::to_string(&e.state_value()),
            &state,
            &format!("{mode} state"),
        );
        assert!(e.take_events().is_empty(), "{mode} events");
        e.call("@select", &[Value::Num(2.0), Value::Num(-1.0)])
            .unwrap();
        e.call("moveSelection", &[Value::Num(2.0), Value::Num(1.0)])
            .unwrap();
        e.call("cancelDrag", &[]).unwrap();
    }
}

#[test]
fn combined_movieclip_history_uses_exact_recorded_structural_retention_and_source_weights() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/movieclip-insertion");
    for name in ["insert-native", "insert-native-fraction", "insert-native-layer2", "insert-native-empty", "insert-native-slow", "insert-native-locked", "insert-native-live", "insert-native-repeat", "insert-native-saved-layer2", "insert-native-saved-fraction", "insert-native-triple", "insert-sheet", "insert-sheet-fraction", "insert-sheet-layer2", "insert-sheet-empty", "insert-sheet-slow", "insert-sheet-locked", "insert-sheet-live", "insert-sheet-repeat"] {
        let reference = json::parse(&std::fs::read(folder.join(format!("{name}.reference.json"))).unwrap()).unwrap();
        let history = json::parse(&std::fs::read(folder.join(format!("{name}.history.json"))).unwrap()).unwrap();
        let steps = items(reference.get("steps"));
        let sheet = name.contains("-sheet");
        let mut e = editor(&steps[0], json::parse(steps[0].get("document").unwrap().as_str().unwrap().as_bytes()).unwrap(), sheet);
        // The owning editor records revision digit widths in enumerableJSON.
        let revision = history.get("records").unwrap().item(0).map(|first_command| {
            let metadata = json::parse(first_command.get("enumerableJSON").unwrap().as_str().unwrap().as_bytes()).unwrap();
            metadata.get("beforeRevision").unwrap().as_f64().unwrap() as u64
        }).unwrap_or(0); // Error-only tapes never create a weighted entry.
        e.set_revision_counters(revision, revision, revision);
        e.configure_worker_history(styk_edit::HistoryLimits { count: history.get("historyLimit").unwrap().as_f64().unwrap() as usize, bytes: history.get("historyBytes").unwrap().as_f64().unwrap() }).unwrap();
        for (index, step) in steps.iter().enumerate().skip(1) {
            e.set_draws(step.get("draws").unwrap_or(&Value::Null));
            let call = items(step.get("call"));
            let method = call[0].as_str().unwrap();
            let result = if sheet && method == "addFigure" {
                e.call_movieclip_timeline_worker(method, &call[1..], &mut TimelineWorker { max_source_bytes:128*1024*1024, check:&mut ||Ok(()), progress:&mut |_|{}, clock:||0.0 })
            } else { e.call(method, &call[1..]) };
            match (result, step.get("error").filter(|v| !v.is_null())) {
                (Ok(_), None) => (),
                (Err(EditError::Invalid(key)), Some(error)) => assert_eq!(Some(styk_edit::error_key(&key)), error.get("key").and_then(Value::as_str), "{name} step{index}"),
                (result, expected) => panic!("{name} step{index}: {result:?} vs {expected:?}"),
            }
            let expected = history.get("states").unwrap().item(index).unwrap().get("historySize").unwrap().as_f64().unwrap();
            assert_eq!(e.history_size(), Some(expected), "{name} step{index} ({method}): exact recorded history bytes");
        }
    }
}
