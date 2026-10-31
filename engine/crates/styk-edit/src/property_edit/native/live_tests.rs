//! Complete actual-editor native options:true returns and source/history lifecycle.
use super::*;
use crate::{HistoryLimits, Options, Selection};
fn fixture() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/edit/native-transform-projection-live-oracle.json");
    styk_doc::json::parse(&std::fs::read(path).unwrap()).unwrap()
}
fn json(value: &Value) -> String {
    styk_doc::json::to_string(value)
}
fn number(value: &Value, name: &str) -> f64 {
    value.get(name).unwrap().as_f64().unwrap()
}
fn initialized(case: &Value) -> Editor {
    let initial = case.get("states").unwrap().item(0).unwrap();
    let tree = styk_doc::json::parse(
        initial
            .get("documentJSON")
            .unwrap()
            .as_str()
            .unwrap()
            .as_bytes(),
    )
    .unwrap();
    let state = initial.get("state").unwrap();
    let history = initial.get("history").unwrap();
    let mut editor = Editor::new(
        tree,
        Options {
            property_channels: case
                .path(&["options", "propertyChannels"])
                .is_some_and(Value::truthy),
            layer_timeline: case
                .path(&["options", "layerTimeline"])
                .is_some_and(Value::truthy),
            ..Options::default()
        },
    );
    editor.set_view(
        number(state, "tick"),
        number(state, "frameIndex") as usize,
        Selection {
            uid: state
                .get("selectedUid")
                .and_then(Value::as_f64)
                .map(|n| n as u32),
            uids: state
                .get("selectedUids")
                .unwrap()
                .numbers()
                .unwrap()
                .into_iter()
                .map(|n| n as u32)
                .collect(),
            joint: number(state, "selectedJoint") as i64,
        },
    );
    editor.set_counters(
        number(state, "layerRevision") as u64,
        number(state, "nextFrameIdentity") as u64,
        number(state, "nextUid") as u64,
    );
    editor.set_revision_counters(
        number(history, "revision") as u64,
        number(history, "savedRevision") as u64,
        number(history, "revisionSerial") as u64,
    );
    editor
        .configure_worker_history(HistoryLimits::default())
        .unwrap();
    editor
}
fn command_value(command: &Command, bytes: Value) -> Value {
    let CommandKind::Animation {
        before,
        after,
        structural,
    } = &command.kind
    else {
        panic!("the shared Animation carrier is required")
    };
    assert!(command.layer_changes.is_empty() && !command.layers);
    let mut out = Obj::new();
    out.set("kind", Value::str("animation"));
    out.set("label", Value::str(&command.label));
    out.set("before", before.clone().unwrap_or(Value::Null));
    out.set("after", after.clone());
    out.set("beforeSelection", command.before_selection.history_value());
    out.set("afterSelection", command.after_selection.history_value());
    out.set("structural", Value::Bool(*structural));
    out.set("timing", Value::Bool(true));
    out.set("beforeRevision", Value::Num(command.before_revision as f64));
    out.set("afterRevision", Value::Num(command.after_revision as f64));
    out.set("bytes", bytes);
    Value::object(out)
}
fn assert_state(editor: &mut Editor, state: &Value, at: &str) {
    assert_eq!(
        json(editor.report()),
        state.get("documentJSON").unwrap().as_str().unwrap(),
        "{at} document"
    );
    let shown = editor.shown_frame().unwrap();
    assert_eq!(
        json(&shown),
        state.get("evaluatedJSON").unwrap().as_str().unwrap(),
        "{at} shown frame"
    );
    assert_eq!(
        json(&shown),
        state.get("displayJSON").unwrap().as_str().unwrap(),
        "{at} display"
    );
    assert_eq!(
        json(&editor.selection_state().history_value()),
        state.get("selectionJSON").unwrap().as_str().unwrap(),
        "{at} selection"
    );
    let actual = editor.state_value();
    for (name, value) in state.get("state").unwrap().as_obj().unwrap().iter() {
        assert_eq!(actual.get(name), Some(value), "{at} state {name}");
    }
    let history = editor.history_value();
    let expected = state.get("history").unwrap();
    for name in ["size", "revision", "revisionSerial", "savedRevision"] {
        assert_eq!(history.get(name), expected.get(name), "{at} history {name}");
    }
    let mut commands = Obj::new();
    for (name, entries) in [("undo", &editor.undo), ("redo", &editor.redo)] {
        let weights = items(history.get(name));
        let values = entries
            .iter()
            .zip(&weights)
            .map(|(entry, weight)| command_value(entry, weight.get("bytes").unwrap().clone()))
            .collect();
        commands.set(name, Value::array(values));
    }
    assert_eq!(
        json(&Value::object(commands)),
        state.get("historyJSON").unwrap().as_str().unwrap(),
        "{at} full enumerable history and sole owner weights"
    );
    assert_eq!(
        json(&Value::array(editor.take_events())),
        json(state.get("events").unwrap()),
        "{at} events"
    );
    let live = state.get("live").unwrap();
    for (name, value) in [
        ("drag", editor.drag.is_some()),
        ("authored", editor.authored.is_some()),
        ("animationEdit", editor.property_edit.is_some()),
    ] {
        assert_eq!(live.get(name), Some(&Value::Bool(value)), "{at} {name}");
    }
    assert_eq!(
        live.get("changed"),
        Some(&Value::Bool(
            editor.drag.as_ref().is_some_and(|drag| drag.changed)
                || editor
                    .property_edit
                    .as_ref()
                    .is_some_and(|edit| edit.changed)
        )),
        "{at} changed"
    );
    let sources = state.get("sources").unwrap();
    let captured = sources.get("authored").unwrap();
    match &editor.authored {
        Some(edit) => {
            assert_eq!(
                captured.get("tick"),
                Some(&Value::Num(edit.tick)),
                "{at} authored clock"
            );
            assert_eq!(
                captured.get("sourceJSON").unwrap().as_str().unwrap(),
                json(&edit.source),
                "{at} immutable authored source"
            );
            assert_eq!(
                captured.get("frameJSON").unwrap().as_str().unwrap(),
                json(&edit.frame),
                "{at} current authored frame"
            );
            // COW ownership is expressed by the existing value heads, not a
            // second JS-style owned-slot set. Every untouched object is shared.
            let taken = editor
                .drag
                .as_ref()
                .unwrap()
                .before
                .iter()
                .filter_map(crate::record::uid)
                .collect::<Vec<_>>();
            for (original, current) in crate::frame::objects_of(&edit.source)
                .iter()
                .zip(crate::frame::objects_of(&edit.frame))
            {
                if !crate::record::uid(original).is_some_and(|uid| taken.contains(&uid)) {
                    assert!(original.same_node(&current), "{at} unrelated pose COW");
                }
            }
        }
        None => assert!(captured.is_null(), "{at} no authored source"),
    }
    let captured = sources.get("animationEdit").unwrap();
    match &editor.property_edit {
        Some(edit) => {
            let native = edit.native.as_ref().unwrap();
            assert_eq!(
                captured.get("tick"),
                Some(&Value::Num(edit.tick)),
                "{at} property clock"
            );
            assert_eq!(
                captured.get("target"),
                Some(&edit.target),
                "{at} property target"
            );
            assert_eq!(
                captured.get("property").and_then(Value::as_str),
                Some(edit.property.as_str()),
                "{at} property name"
            );
            assert_eq!(
                captured.get("exactTarget"),
                Some(&Value::Bool(edit.exact)),
                "{at} property targeting"
            );
            assert_eq!(
                captured.get("initialValue"),
                Some(&edit.initial),
                "{at} property initial value"
            );
            assert_eq!(
                captured.get("changed"),
                Some(&Value::Bool(edit.changed)),
                "{at} property changed"
            );
            assert_eq!(
                captured.get("selectionJSON").unwrap().as_str().unwrap(),
                json(&edit.selection.history_value()),
                "{at} property selection"
            );
            assert_eq!(
                captured.get("beforeJSON").and_then(Value::as_str),
                native.before.as_ref().map(json).as_deref(),
                "{at} property before"
            );
            assert_eq!(
                captured.get("beforeChannelJSON").and_then(Value::as_str),
                Some(json(&native.before_channel.clone().unwrap_or(Value::Null))).as_deref(),
                "{at} property channel before"
            );
            let preview = native.preview.as_ref().map(|(animation, channel, key)| {
                let mut preview = Obj::new();
                preview.set("animation", animation.clone());
                preview.set("channelIndex", Value::Num(*channel as f64));
                preview.set("keyIndex", Value::Num(*key as f64));
                json(&Value::object(preview))
            });
            assert_eq!(
                captured.get("previewJSON").and_then(Value::as_str),
                preview.as_deref(),
                "{at} property preview"
            );
        }
        None => assert!(captured.is_null(), "{at} no property draft"),
    }
    assert_eq!(
        sources.get("tableWasPresent"),
        Some(&Value::Bool(editor.source_table_was_present)),
        "{at} original source table retention"
    );
    assert!(
        editor.pending_source_layer_changes.is_empty(),
        "{at} no pending source layer carrier"
    );
    assert_eq!(
        sources
            .get("pendingLayerChangesJSON")
            .and_then(Value::as_str),
        Some("null"),
        "{at} no pending source layer changes"
    );
    editor.ensure_counts();
    assert_eq!(
        sources.get("nextFrameIdentity"),
        Some(&Value::Num(editor.next_frame_identity as f64)),
        "{at} source identity"
    );
    let generated = Value::array(
        editor
            .generated_sources
            .iter()
            .map(|id| Value::str(id))
            .collect(),
    );
    assert_eq!(
        sources.get("generated"),
        Some(&generated),
        "{at} generated sources"
    );
    let mut counts = editor
        .uid_counts
        .as_ref()
        .unwrap()
        .0
        .iter()
        .map(|(uid, n)| (*uid, *n))
        .collect::<Vec<_>>();
    counts.sort_by_key(|(uid, _)| *uid);
    let counts = Value::array(
        counts
            .into_iter()
            .map(|(uid, n)| Value::nums(&[uid as f64, n as f64]))
            .collect(),
    );
    assert_eq!(sources.get("uidCounts"), Some(&counts), "{at} membership");
    let table = editor.report.path(&["_styk", "frameSources"]);
    assert_eq!(
        sources.get("tablePresent"),
        Some(&Value::Bool(table.is_some())),
        "{at} source table existence"
    );
    if let Some(table) = table {
        assert_eq!(
            sources.get("tableJSON").unwrap().as_str().unwrap(),
            json(table),
            "{at} source bytes"
        );
    }
    assert_eq!(
        sources.get("pendingBytes"),
        Some(&Value::Num(editor.pending_source_bytes as f64)),
        "{at} pending captured bytes"
    );
}
#[test]
fn native_options_true_live_tapes_match_every_complete_return_and_owner_state() {
    let mut calls = 0;
    let mut states = 0;
    let mut defined = 0;
    let mut history_transitions = 0;
    let mut registrations = 0;
    for case in items(Some(&fixture())) {
        let name = case.get("name").unwrap().as_str().unwrap();
        let mut editor = initialized(&case);
        let oracle = items(case.get("states"));
        let returns = items(case.get("returns"));
        let native_rows = editor.report.get("keyframes").unwrap().clone();
        assert_state(&mut editor, &oracle[0], name);
        states += 1;
        for (number, expected) in returns.iter().enumerate() {
            let call = items(expected.get("call"));
            let method = call[0].as_str().unwrap();
            let at = format!("{name} step{} {method}", number + 1);
            let result =
                editor
                    .call_worker_checked(method, &Value::array(call[1..].to_vec()), &mut || Ok(()));
            if expected.get("error").is_some_and(|error| !error.is_null()) {
                let Err(EditError::Invalid(error)) = result else {
                    panic!("{at} expected recorded error, got {result:?}")
                };
                assert_eq!(
                    error.split('\u{1f}').next(),
                    expected.path(&["error", "key"]).and_then(Value::as_str),
                    "{at} error"
                );
            } else {
                let returned = result.unwrap_or_else(|error| panic!("{at}: {error:?}"));
                let returned = if matches!(method, "seek" | "@seek") {
                    editor.shown_frame().unwrap()
                } else if method == "beginAnimationEdit" {
                    editor.animation_edit_value_worker().unwrap()
                } else {
                    returned
                };
                assert_eq!(
                    expected.get("resultDefined"),
                    Some(&Value::Bool(true)),
                    "{at} success return is complete"
                );
                if expected.get("resultDefined") == Some(&Value::Bool(true)) {
                    defined += 1;
                    assert_eq!(
                        json(&returned),
                        expected.get("resultJSON").unwrap().as_str().unwrap(),
                        "{at} complete return"
                    );
                }
            }
            assert_state(&mut editor, &oracle[number + 1], &at);
            history_transitions += usize::from(
                oracle[number].get("historyJSON") != oracle[number + 1].get("historyJSON"),
            );
            registrations += oracle[number + 1]
                .path(&["sources", "registrations"])
                .and_then(Value::array_len)
                .unwrap();
            assert!(
                native_rows.same_node(editor.report.get("keyframes").unwrap()),
                "{at} imported rows must remain assets"
            );
            calls += 1;
            states += 1;
        }
    }
    assert_eq!(
        (calls, states, defined, history_transitions, registrations),
        (93, 101, 91, 25, 9)
    );
}

fn lifecycle_heads(editor: &mut Editor) -> String {
    editor.ensure_counts();
    format!(
        "{}|{}|{}|{}|{:?}|{:?}|{:?}|{:?}|{:?}|{}|{}|{:?}",
        json(&editor.state_value()),
        json(&editor.history_value()),
        json(&editor.selection_state().history_value()),
        json(&Value::array(editor.events.clone())),
        editor.drag,
        editor.authored,
        editor.property_edit,
        editor.selection_metadata,
        editor.uid_counts,
        editor.pending_source_bytes,
        editor.source_table_was_present,
        editor.generated_sources
    )
}
fn assert_atomic(editor: &mut Editor, before: &Value, view: &Value, heads: &str, at: &str) {
    assert!(
        editor.report.same_node(before),
        "{at} same canonical COW head"
    );
    assert_eq!(
        json(&editor.shown_frame().unwrap()),
        json(view),
        "{at} displayed view"
    );
    assert_eq!(
        lifecycle_heads(editor),
        heads,
        "{at} exact live/source/history/selection/event heads"
    );
}

#[test]
fn native_options_true_live_cancellation_restores_every_checked_owner_boundary() {
    let mut attempts = 0;
    let mut operations = 0;
    for case in items(Some(&fixture())) {
        let name = case.get("name").unwrap().as_str().unwrap();
        let mut editor = initialized(&case);
        for expected in items(case.get("returns")) {
            let call = items(expected.get("call"));
            let method = call[0].as_str().unwrap();
            let args = Value::array(call[1..].to_vec());
            let before = editor.report.clone();
            let view = editor.shown_frame().unwrap();
            let heads = lifecycle_heads(&mut editor);
            let snapshot = editor.snapshot();
            let mut checkpoints = 0;
            let _ = editor.call_worker_checked(method, &args, &mut || {
                checkpoints += 1;
                Ok(())
            });
            editor.restore(snapshot);
            assert_atomic(
                &mut editor,
                &before,
                &view,
                &heads,
                &format!("{name} {method} calibration rollback"),
            );
            assert!(
                checkpoints >= 2,
                "{name} {method} owns checks before and after preparation"
            );
            for stop in 1..=checkpoints {
                let mut visited = 0;
                let result = editor.call_worker_checked(method, &args, &mut || {
                    visited += 1;
                    if visited == stop {
                        Err(EditError::Invalid("test cancellation".into()))
                    } else {
                        Ok(())
                    }
                });
                assert!(
                    matches!(result,Err(EditError::Invalid(ref error)) if error=="test cancellation"),
                    "{name} {method} stop{stop}/{checkpoints}: {result:?}"
                );
                assert_atomic(
                    &mut editor,
                    &before,
                    &view,
                    &heads,
                    &format!("{name} {method} stop{stop}/{checkpoints}"),
                );
                attempts += 1;
            }
            let _ = editor.call_worker_checked(method, &args, &mut || Ok(()));
            operations += 1;
        }
    }
    assert_eq!(operations, 93);
    assert!(
        attempts > 1_000,
        "every new owner is reached; got {attempts}"
    );
    eprintln!("93 complete operations / {attempts} cancellation boundaries restored atomically");
}

fn open_drag(case: &Value) -> Editor {
    let mut editor = initialized(case);
    for expected in items(case.get("returns")).into_iter().take(3) {
        let call = items(expected.get("call"));
        editor
            .call_worker_checked(
                call[0].as_str().unwrap(),
                &Value::array(call[1..].to_vec()),
                &mut || Ok(()),
            )
            .unwrap();
    }
    assert!(editor.authored.is_some() && editor.drag.as_ref().is_some_and(|drag| drag.changed));
    editor
}
#[test]
fn native_options_true_unrecorded_calls_and_future_complex_dependencies_are_atomic() {
    let fixture = fixture();
    let case = items(Some(&fixture))
        .into_iter()
        .find(|case| {
            case.get("name").and_then(Value::as_str) == Some("native-channels-drag-commit")
        })
        .unwrap();
    let calls=styk_doc::json::parse(br#"[["select",1,0],["selectMany",[1,2]],["moveSelection",1,1,{"fromStart":true}],["rotateSelection",0.2],["beginAnimationEdit",{"kind":"figure","uid":1},"rotation"],["beginAnimationEdit",{"kind":"figure","uid":1},"x",{"exactTarget":true}],["beginAnimationEdit",{"kind":"figure","uid":1},"x",{"exactTarget":""}],["addAnimationKey",{"kind":"figure","uid":1},"x",0,310],["seek",3.5],["createLayer",{"name":"unrecorded"}]]"#).unwrap();
    for call in items(Some(&calls)) {
        let mut editor = open_drag(&case);
        let before = editor.report.clone();
        let view = editor.shown_frame().unwrap();
        let heads = lifecycle_heads(&mut editor);
        let call = items(Some(&call));
        let result = editor.call_worker_checked(
            call[0].as_str().unwrap(),
            &Value::array(call[1..].to_vec()),
            &mut || Ok(()),
        );
        assert!(
            matches!(result, Err(EditError::Unported(_))),
            "{call:?}: {result:?}"
        );
        assert_atomic(&mut editor, &before, &view, &heads, "unrecorded live call");
    }
    for mutation in [
        "future-join",
        "retained-join",
        "future-origin",
        "malformed-source-table",
        "optional-selection",
        "duplicate-frame-identity",
        "unavailable-frame-identity",
        "vfx-clips",
        "multi-selection",
        "fractional-live-tick",
    ] {
        let mut editor = open_drag(&case);
        match mutation {
            "future-origin" => {
                let figure = editor
                    .report
                    .make_obj()
                    .unwrap()
                    .get_mut("figure_types")
                    .unwrap()
                    .make_arr()
                    .unwrap()
                    .get_mut(0)
                    .unwrap()
                    .make_obj()
                    .unwrap();
                figure.set(
                    "_styk",
                    styk_doc::json::parse(br#"{"animationOrigin":{"handleId":1}}"#).unwrap(),
                );
            }
            "future-join" | "retained-join" => {
                let mut frame = editor.report.get("keyframes").unwrap().item(0).unwrap();
                let frame_object = frame.make_obj().unwrap();
                frame_object.set(
                    "_styk",
                    styk_doc::json::parse(br#"{"frameId":"future-joined-source"}"#).unwrap(),
                );
                frame_object
                    .get_mut("objects")
                    .unwrap()
                    .make_arr()
                    .unwrap()
                    .get_mut(0)
                    .unwrap()
                    .make_obj()
                    .unwrap()
                    .set(
                        "join",
                        styk_doc::json::parse(br#"{"target_object_slot":1,"target_handle_id":1}"#)
                            .unwrap(),
                    );
                if mutation == "future-join" {
                    editor
                        .report
                        .make_obj()
                        .unwrap()
                        .get_mut("keyframes")
                        .unwrap()
                        .make_arr()
                        .unwrap()
                        .push(frame);
                } else {
                    let mut sources = Obj::new();
                    sources.set("future-joined-source", frame);
                    editor
                        .report
                        .make_obj()
                        .unwrap()
                        .get_mut("_styk")
                        .unwrap()
                        .make_obj()
                        .unwrap()
                        .set("frameSources", Value::object(sources));
                }
            }
            "malformed-source-table" => {
                editor
                    .report
                    .make_obj()
                    .unwrap()
                    .get_mut("_styk")
                    .unwrap()
                    .make_obj()
                    .unwrap()
                    .set("frameSources", Value::str("malformed"));
            }
            "duplicate-frame-identity" => {
                let frame = editor.report.get("keyframes").unwrap().item(0).unwrap();
                editor
                    .report
                    .make_obj()
                    .unwrap()
                    .get_mut("keyframes")
                    .unwrap()
                    .make_arr()
                    .unwrap()
                    .push(frame);
            }
            "unavailable-frame-identity" => {
                editor
                    .report
                    .make_obj()
                    .unwrap()
                    .get_mut("keyframes")
                    .unwrap()
                    .make_arr()
                    .unwrap()
                    .get_mut(0)
                    .unwrap()
                    .make_obj()
                    .unwrap()
                    .get_mut("_styk")
                    .unwrap()
                    .make_obj()
                    .unwrap()
                    .remove("frameId");
            }
            "multi-selection" => {
                editor.selection.uids = vec![1, 2];
            }
            "fractional-live-tick" => {
                editor.tick = 3.5;
            }
            "vfx-clips" => {
                editor
                    .report
                    .make_obj()
                    .unwrap()
                    .get_mut("_styk")
                    .unwrap()
                    .make_obj()
                    .unwrap()
                    .set(
                        "vfxClips",
                        styk_doc::json::parse(br#"{"version":1,"clips":[]}"#).unwrap(),
                    );
            }
            "optional-selection" => {
                editor.selection_metadata.branch =
                    Some(styk_doc::json::parse(br#"{"index":1,"unknown":"retained"}"#).unwrap());
            }
            _ => unreachable!(),
        }
        let before = editor.report.clone();
        let view = editor.shown_frame().unwrap();
        let heads = lifecycle_heads(&mut editor);
        let result =
            editor.call_worker_checked("commitDrag", &Value::array(vec![]), &mut || Ok(()));
        assert!(
            matches!(result, Err(EditError::Unported(_))),
            "{mutation}: {result:?}"
        );
        assert_atomic(&mut editor, &before, &view, &heads, mutation);
    }
    let property_case = items(Some(&fixture))
        .into_iter()
        .find(|case| {
            case.get("name").and_then(Value::as_str) == Some("native-channels-property-commit")
        })
        .unwrap();
    for call in items(Some(&styk_doc::json::parse(br#"[["beginAnimationEdit",{"kind":"figure","uid":999},"x"],["beginAnimationEdit",{"kind":"figure","uid":1},"x",null],["beginAnimationEdit",{"kind":"figure","uid":1},"x",{"exactTarget":false}],["seek",3.5]]"#).unwrap())) {
        let mut editor=initialized(&property_case);for expected in items(property_case.get("returns")).into_iter().take(3){let call=items(expected.get("call"));editor.call_worker_checked(call[0].as_str().unwrap(),&Value::array(call[1..].to_vec()),&mut || Ok(())).unwrap();}
        let before=editor.report.clone();let view=editor.shown_frame().unwrap();let heads=lifecycle_heads(&mut editor);let call=items(Some(&call));let result=editor.call_worker_checked(call[0].as_str().unwrap(),&Value::array(call[1..].to_vec()),&mut || Ok(()));assert!(matches!(result,Err(EditError::Unported(_))),"unrecorded property replacement: {result:?}");assert_atomic(&mut editor,&before,&view,&heads,"unrecorded property replacement");
    }
    let mut editor = initialized(&case);
    let before = editor.report.clone();
    let state = lifecycle_heads(&mut editor);
    assert!(matches!(
        editor.call("select", &[Value::Num(1.0), Value::Num(-1.0)]),
        Err(EditError::Unported(_))
    ));
    assert!(editor.report.same_node(&before));
    assert_eq!(
        lifecycle_heads(&mut editor),
        state,
        "legacy UI call remains refused"
    );
}

#[test]
fn existing_ordinary_live_115_complete_returns_remain_exact_on_final_owners() {
    let base = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests");
    let mut calls = 0;
    for name in [
        "native-drag-commit",
        "native-drag-cancel",
        "native-drag-error",
        "native-drag-replace",
        "native-drag-seek",
        "sheet-drag-commit",
        "sheet-drag-cancel",
        "sheet-drag-error",
        "sheet-property-commit",
        "sheet-property-cancel",
    ] {
        let read = |folder: &str| {
            styk_doc::json::parse(
                &std::fs::read(base.join(folder).join(format!("{name}.json"))).unwrap(),
            )
            .unwrap()
        };
        let original = read("session-live");
        let returned = read("session-live-return");
        let original_steps = items(original.get("steps"));
        let returned_steps = items(returned.get("steps"));
        let mut initial = Obj::new();
        initial.set(
            "documentJSON",
            original_steps[0].get("document").unwrap().clone(),
        );
        initial.set("state", original_steps[0].get("state").unwrap().clone());
        initial.set("history", original_steps[0].get("history").unwrap().clone());
        let mut case = Obj::new();
        case.set("states", Value::array(vec![Value::object(initial)]));
        case.set("options", original.get("options").unwrap().clone());
        let mut editor = initialized(&Value::object(case));
        let mut document = original_steps[0].get("document").unwrap().clone();
        let mut displayed = original_steps[0].get("frame").unwrap().clone();
        for (number, expected) in returned_steps.iter().enumerate() {
            let call = items(expected.get("call"));
            let method = call[0].as_str().unwrap();
            let step = &original_steps[number + 1];
            let at = format!("{name} step{} {method}", number + 1);
            let result =
                editor
                    .call_worker_checked(method, &Value::array(call[1..].to_vec()), &mut || Ok(()));
            if expected.get("error").is_some_and(|error| !error.is_null()) {
                let Err(EditError::Invalid(error)) = result else {
                    panic!("{at}: expected actual error, got {result:?}")
                };
                assert_eq!(
                    error.split('\u{1f}').next(),
                    expected.path(&["error", "key"]).and_then(Value::as_str),
                    "{at}"
                );
            } else {
                let result = result.unwrap_or_else(|error| panic!("{at}: {error:?}"));
                let result = if matches!(method, "seek" | "@seek") {
                    editor.shown_frame().unwrap()
                } else if method == "beginAnimationEdit" {
                    editor.animation_edit_value_worker().unwrap()
                } else {
                    result
                };
                assert_eq!(
                    expected.get("resultDefined"),
                    Some(&Value::Bool(true)),
                    "{at} complete result"
                );
                assert_eq!(
                    json(&result),
                    expected.get("resultJSON").unwrap().as_str().unwrap(),
                    "{at} complete return"
                );
            }
            if let Some(value) = step.get("document") {
                document = value.clone();
            }
            if let Some(value) = step.get("frame") {
                displayed = value.clone();
            }
            assert_eq!(
                json(editor.report()),
                document.as_str().unwrap(),
                "{at} document"
            );
            assert_eq!(
                json(&editor.shown_frame().unwrap()),
                displayed.as_str().unwrap(),
                "{at} display"
            );
            for (field, value) in step.get("state").unwrap().as_obj().unwrap().iter() {
                assert_eq!(
                    editor.state_value().get(field),
                    Some(value),
                    "{at} state {field}"
                );
            }
            assert_eq!(
                json(&editor.selection_state().history_value()),
                json(step.get("selection").unwrap()),
                "{at} selection"
            );
            let actual_history = editor.history_value();
            let expected_history = step.get("history").unwrap();
            for field in ["size", "revision", "revisionSerial", "savedRevision"] {
                assert_eq!(
                    actual_history.get(field),
                    expected_history.get(field),
                    "{at} history {field}"
                );
            }
            for (side, commands) in [("undo", &editor.undo), ("redo", &editor.redo)] {
                let actual = items(actual_history.get(side));
                let expected = items(expected_history.get(side));
                assert_eq!(actual.len(), expected.len(), "{at} {side} count");
                for ((actual, expected), command) in actual.iter().zip(&expected).zip(commands.iter()) {
                    // The existing canonical worker history view exports labels
                    // and exact weights. Verify private command kinds directly
                    // against their sole carrier, without another serializer.
                    for (field, value) in actual.as_obj().unwrap().iter() {
                        assert_eq!(Some(value), expected.get(field), "{at} {side} {field}");
                    }
                    let kind = match command.kind {
                        CommandKind::Objects { .. } => "objects",
                        CommandKind::LayerSheet { .. } => "layer-sheet",
                        ref other => panic!("{at} unexpected carrier {other:?}"),
                    };
                    assert_eq!(
                        expected.get("kind").and_then(Value::as_str),
                        Some(kind),
                        "{at} sole {side} carrier"
                    );
                }
            }
            assert_eq!(
                json(&Value::array(editor.take_events())),
                json(step.get("events").unwrap()),
                "{at} events"
            );
            calls += 1;
        }
    }
    assert_eq!(calls, 115);
    eprintln!(
        "115 existing ordinary default-native/sheet calls retain complete returns, history, events, doc and display"
    );
}
