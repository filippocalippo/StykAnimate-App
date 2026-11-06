//! Actual JS source/history internals supplement the public every-step replays.
use super::*;
use crate::{CommandKind, HistoryLimits, Options, Selection};

fn fixture(name: &str) -> Value {
    styk_doc::json::parse(
        &std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join(format!("../../tests/edit/{name}")),
        )
        .unwrap(),
    )
    .unwrap()
}
fn initialized(name: &str) -> Editor {
    let reference = fixture(&format!("{name}.reference.json"));
    let state = reference
        .get("steps")
        .unwrap()
        .item(0)
        .unwrap()
        .get("state")
        .unwrap()
        .clone();
    let mut editor = Editor::new(
        fixture(&format!("{name}.document.json")),
        Options::default(),
    );
    editor.set_view(
        num(&state, "tick").unwrap(),
        num(&state, "frameIndex").unwrap() as usize,
        Selection {
            uid: num(&state, "selectedUid").map(|n| n as u32),
            uids: state
                .get("selectedUids")
                .unwrap()
                .numbers()
                .unwrap_or_default()
                .into_iter()
                .map(|n| n as u32)
                .collect(),
            joint: num(&state, "selectedJoint").unwrap() as i64,
        },
    );
    editor.set_counters(
        num(&state, "layerRevision").unwrap() as u64,
        num(&state, "nextFrameIdentity").unwrap() as u64,
        num(&state, "nextUid").unwrap() as u64,
    );
    editor.set_revision_counters(2, 2, 2);
    editor
        .configure_worker_history(HistoryLimits::default())
        .unwrap();
    editor
}
fn internals(editor: &mut Editor, step: &Value) -> Value {
    editor.ensure_counts();
    let mut counts = editor
        .uid_counts
        .as_ref()
        .unwrap()
        .0
        .iter()
        .map(|(uid, n)| (*uid, *n))
        .collect::<Vec<_>>();
    counts.sort_by_key(|(uid, _)| *uid);
    let live = editor
        .drag
        .as_ref()
        .and_then(|drag| drag.motion_path.as_ref());
    let live_sources = live
        .and_then(|session| session.draft.as_ref())
        .map(|draft| {
            let mut sources = Obj::new();
            for (id, source) in draft.sources() {
                sources.set(id, source.clone());
            }
            Value::str(&styk_doc::json::to_string(&Value::object(sources)))
        })
        .unwrap_or(Value::Null);
    let owners = live
        .map(|session| {
            Value::array(
                session
                    .posed
                    .iter()
                    .map(|posed| {
                        Value::array(
                            posed
                                .source_ids
                                .iter()
                                .map(|(owner, id)| {
                                    Value::array(vec![Value::str(owner), Value::str(id)])
                                })
                                .collect(),
                        )
                    })
                    .collect(),
            )
        })
        .unwrap_or_else(|| Value::array(Vec::new()));
    let mut value = Obj::new();
    value.set("step", step.get("step").unwrap().clone());
    value.set("method", step.get("method").unwrap().clone());
    value.set(
        "nextFrameIdentity",
        Value::Num(editor.next_frame_identity as f64),
    );
    value.set(
        "generatedSources",
        Value::array(
            editor
                .generated_sources
                .iter()
                .map(|id| Value::str(id))
                .collect(),
        ),
    );
    value.set(
        "sourceIds",
        Value::array(
            editor
                .report
                .path(&["_styk", "frameSources"])
                .and_then(Value::as_obj)
                .map(|sources| sources.keys().map(|id| Value::str(id)).collect())
                .unwrap_or_default(),
        ),
    );
    value.set(
        "uidCounts",
        Value::array(
            counts
                .iter()
                .map(|(uid, n)| Value::nums(&[*uid as f64, *n as f64]))
                .collect(),
        ),
    );
    value.set("liveSources", live_sources);
    value.set("sourceOwners", owners);
    Value::object(value)
}
fn animation_command(command: &crate::Command) -> Value {
    let CommandKind::Animation {
        before,
        after,
        structural,
    } = &command.kind
    else {
        panic!("shared Animation owner required")
    };
    assert!(command.layer_changes.is_empty() && !command.layers);
    let mut value = Obj::new();
    value.set("kind", Value::str("animation"));
    value.set("label", Value::str(&command.label));
    value.set("before", before.clone().unwrap_or(Value::Null));
    value.set("after", after.clone());
    value.set("beforeSelection", command.before_selection.history_value());
    value.set("afterSelection", command.after_selection.history_value());
    value.set("structural", Value::Bool(*structural));
    value.set("timing", Value::Bool(true));
    value.set("beforeRevision", Value::Num(command.before_revision as f64));
    value.set("afterRevision", Value::Num(command.after_revision as f64));
    Value::object(value)
}
#[test]
fn saved_native_motion_source_lifecycle_and_shared_history_weights_match_js() {
    let oracle = fixture("origin-motion-native-saved-history.json");
    let mut checked = 0;
    let mut commands = 0;
    for case in oracle.elements().unwrap().iter() {
        let name = case.get("name").unwrap().as_str().unwrap();
        let mut editor = initialized(name);
        let reference = fixture(&format!("{name}.reference.json"));
        let steps = items(reference.get("steps"));
        for state in case.get("states").unwrap().elements().unwrap().iter() {
            let number = num(&state, "step").unwrap() as usize;
            let step = &steps[number];
            let call = items(step.get("call"));
            let method = call[0].as_str().unwrap();
            editor.set_draws(step.get("draws").unwrap_or(&Value::Null));
            let result = editor.call(method, &call[1..]);
            if step.get("error").is_some_and(|error| !error.is_null()) {
                assert!(
                    matches!(result, Err(EditError::Invalid(_))),
                    "{name} step {number}: {result:?}"
                );
            } else {
                result.unwrap_or_else(|error| panic!("{name} step {number}: {error:?}"));
            }
            let actual = internals(&mut editor, &state);
            assert_eq!(
                styk_doc::json::to_string(&actual),
                styk_doc::json::to_string(&state),
                "{name} step {number} source lifecycle"
            );
            checked += 1;
            if let Some(expected) = items(case.get("history"))
                .iter()
                .find(|entry| num(entry, "step") == Some(number as f64))
            {
                let entry = editor.undo.last().unwrap();
                assert_eq!(
                    styk_doc::json::to_string(&animation_command(entry)),
                    styk_doc::json::to_string(expected.get("command").unwrap()),
                    "{name} step {number} enumerable command"
                );
                let history = editor.history_value();
                let actual = items(history.get("undo"))
                    .last()
                    .unwrap()
                    .get("bytes")
                    .unwrap()
                    .clone();
                assert_eq!(
                    actual,
                    expected.get("bytes").unwrap().clone(),
                    "{name} step {number} shared worker history bytes"
                );
                commands += 1;
            }
            editor.take_events();
        }
    }
    assert_eq!((checked, commands), (122, 8));
    println!(
        "{checked} exact source lifecycle states; {commands} exact enumerable Animation commands and configured worker weights"
    );
}

#[test]
fn first_native_draft_capture_counts_sources_once_without_warming_membership() {
    let oracle = fixture("origin-motion-native-saved-history.json");
    for case in oracle.elements().unwrap().iter() {
        let name = case.get("name").unwrap().as_str().unwrap();
        let mut editor = initialized(name);
        assert!(editor.uid_counts.is_none());
        let reference = fixture(&format!("{name}.reference.json"));
        for step in items(reference.get("steps")).iter().skip(1).take(37) {
            let call = items(step.get("call"));
            let method = call[0].as_str().unwrap();
            if ["@frame", "@motionFrame"].contains(&method) {
                continue;
            }
            let result = editor.call(method, &call[1..]);
            if !step.get("error").is_some_and(|error| !error.is_null()) {
                result.unwrap();
            }
            editor.take_events();
        }
        let expected = items(case.get("states"))
            .into_iter()
            .find(|state| num(state, "step") == Some(37.0))
            .unwrap();
        assert_eq!(
            internals(&mut editor, &expected),
            expected,
            "{name}: lazy registration must not double count the newly inserted table"
        );
    }
}
