//! Worker planning + owning publication is compared at every actual editor step.
use std::{path::Path, sync::Arc};
use styk_doc::{Value, json};
use styk_edit::{
    EditError, Editor, Options, Selection,
    movieclip_planning::{ChannelsRequest, PreparationRequest, apply_channels, prepare_movieclips},
};
fn clock() -> f64 {
    0.0
}
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
fn editor(initial: &Value, report: Value) -> Editor {
    let state = initial.get("state").unwrap();
    let mut e = Editor::new(
        report,
        Options {
            property_channels: true,
            layer_timeline: true,
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
fn timed_sheet_movieclip_recordings_match_every_step() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/movieclip-timed-sheet");
    for name in [
        "prepare-imported",
        "prepare-dense",
        "prepare-multilayer",
        "prepare-locked",
        "prepare-noop",
        "channels-timing",
        "channels-masked",
        "channels-scalar-fixed",
        "channels-live-errors",
    ] {
        let reference =
            json::parse(&std::fs::read(folder.join(format!("{name}.reference.json"))).unwrap())
                .unwrap();
        let payloads =
            json::parse(&std::fs::read(folder.join(format!("{name}.payloads.json"))).unwrap())
                .unwrap();
        let steps = items(reference.get("steps"));
        let mut expected = steps[0]
            .get("document")
            .unwrap()
            .as_str()
            .unwrap()
            .to_string();
        let mut e = editor(&steps[0], json::parse(expected.as_bytes()).unwrap());
        for step in &steps[1..] {
            let number = step.get("step").unwrap().as_f64().unwrap();
            let call = items(step.get("call"));
            let method = call[0].as_str().unwrap();
            let result = if ["_prepareSheetMovieclips", "sheetApplyChannels"].contains(&method) {
                let report = e.report().clone();
                let mut loader = styk_eval::load::Loader::new();
                let prepared = styk_eval::eval::Prepared::new(Arc::new(
                    loader.document(&report, name).unwrap(),
                ));
                let state = e.state_value();
                let identity = state.get("nextFrameIdentity").unwrap().as_f64().unwrap() as u64;
                let plan = if method == "_prepareSheetMovieclips" {
                    let uids: Vec<u32> = state
                        .get("selectedUids")
                        .unwrap()
                        .numbers()
                        .unwrap()
                        .iter()
                        .map(|u| *u as u32)
                        .collect();
                    prepare_movieclips(
                        &report,
                        &prepared,
                        PreparationRequest {
                            uids: &uids,
                            next_frame_identity: identity,
                            max_source_bytes: 128 * 1024 * 1024,
                            focus: None,
                        },
                        || Ok(()),
                        |_| {},
                        clock,
                    )
                } else {
                    let channels = items(call.get(1));
                    apply_channels(
                        &report,
                        &prepared,
                        ChannelsRequest {
                            channels: &channels,
                            label: call.get(2).and_then(Value::as_str).unwrap_or(""),
                            preserve_duration: call
                                .get(3)
                                .and_then(|v| v.get("preserveDuration"))
                                .is_some_and(Value::truthy),
                            next_frame_identity: identity,
                            max_source_bytes: 128 * 1024 * 1024,
                            focus: None,
                        },
                        || Ok(()),
                        |_| {},
                        clock,
                    )
                    .map(Some)
                };
                assert_eq!(
                    json::to_string(&report),
                    e.report_json(),
                    "{name} step{number} read-only"
                );
                plan.and_then(|plan| {
                    if let Some(plan) = plan {
                        let payload = items(Some(&payloads))
                            .into_iter()
                            .find(|p| p.get("step").and_then(Value::as_f64) == Some(number))
                            .unwrap();
                        assert_json(
                            &json::to_string(&plan.payload()),
                            &json::to_string(payload.get("payload").unwrap()),
                            &format!("{name} step{number} payload"),
                        );
                        e.publish_sheet_migration(plan).map(|ok| {
                            if method == "_prepareSheetMovieclips" {
                                Value::Null
                            } else {
                                Value::Bool(ok)
                            }
                        })
                    } else {
                        Ok(Value::Null)
                    }
                })
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
                    Some(key.as_str()),
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
fn borrowed_planning_cancels_and_bounds_sources_before_publication() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/movieclip-timed-sheet");
    let reference =
        json::parse(&std::fs::read(folder.join("prepare-imported.reference.json")).unwrap())
            .unwrap();
    let first = items(reference.get("steps"))[0].clone();
    let report = json::parse(first.get("document").unwrap().as_str().unwrap().as_bytes()).unwrap();
    let mut loader = styk_eval::load::Loader::new();
    let prepared =
        styk_eval::eval::Prepared::new(Arc::new(loader.document(&report, "cancel").unwrap()));
    let request = |bytes| PreparationRequest {
        uids: &[1],
        next_frame_identity: 3,
        max_source_bytes: bytes,
        focus: None,
    };
    let before = json::to_string(&report);
    for bytes in [0, 1, 3695] {
        assert!(matches!(
            prepare_movieclips(&report, &prepared, request(bytes), || Ok(()), |_| {}, clock),
            Err(EditError::Invalid(_))
        ));
        assert_eq!(
            json::to_string(&report),
            before,
            "budget failure is read-only"
        );
    }
    assert!(
        prepare_movieclips(&report, &prepared, request(3696), || Ok(()), |_| {}, clock)
            .unwrap()
            .is_some(),
        "exact budget covers the two recorded sources"
    );
    let checks = std::cell::Cell::new(0usize);
    let cancelled = prepare_movieclips(
        &report,
        &prepared,
        request(3696),
        || {
            checks.set(checks.get() + 1);
            if checks.get() == 3 {
                Err(EditError::Invalid("cancelled".into()))
            } else {
                Ok(())
            }
        },
        |_| {},
        clock,
    );
    assert!(matches!(cancelled, Err(EditError::Invalid(key)) if key == "cancelled"));
    assert_eq!(json::to_string(&report), before);
    let revision = std::cell::Cell::new(0usize);
    let stale = prepare_movieclips(
        &report,
        &prepared,
        request(3696),
        || {
            if revision.get() == 0 {
                Ok(())
            } else {
                Err(EditError::Invalid("stale".into()))
            }
        },
        |_| revision.set(1),
        clock,
    );
    assert!(matches!(stale, Err(EditError::Invalid(key)) if key == "stale"));
    assert_eq!(json::to_string(&report), before);
    let plan = prepare_movieclips(&report, &prepared, request(3696), || Ok(()), |_| {}, clock)
        .unwrap()
        .unwrap();
    let mut e = editor(&first, report);
    e.call(
        "setLayerColor",
        &[
            Value::array(vec![Value::str("layer-1")]),
            Value::str("blue"),
        ],
    )
    .unwrap();
    e.take_events();
    let state = e.state_value();
    let edited = e.report_json();
    assert!(
        matches!(e.publish_sheet_migration(plan), Err(EditError::Invalid(key)) if key == "errors.editorLayerAsync.theAnimationChangedWhileTheLayerMoveWas")
    );
    assert_eq!(e.report_json(), edited);
    assert_eq!(e.state_value(), state);
    assert!(e.take_events().is_empty());
}
