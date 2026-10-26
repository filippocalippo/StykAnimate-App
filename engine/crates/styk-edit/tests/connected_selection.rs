use styk_doc::Value;

fn reference(mode: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../../tests/edit/connected-selection-{mode}.reference.json"));
    styk_doc::json::parse(&std::fs::read(path).unwrap()).unwrap()
}

#[test]
fn connected_selection_matches_editor_documents_state_events_and_history() {
    for mode in ["native", "sheet", "autokey-sheet"] {
        let outcome = styk_edit::replay::replay(&reference(mode)).unwrap();
        assert!(outcome.passed() && outcome.matched == outcome.steps && outcome.unported.is_none(), "{mode}: {outcome:#?}");
    }
}

#[test]
fn connected_selection_runs_through_the_session_api() {
    for mode in ["native", "sheet", "autokey-sheet"] {
        let reference = reference(mode);
        let steps: Vec<Value> = reference.get("steps").unwrap().elements().unwrap().iter().collect();
        let first = &steps[0];
        let document = styk_doc::json::parse(first.get("document").unwrap().as_str().unwrap().as_bytes()).unwrap();
        let mut state = first.get("state").unwrap().as_obj().unwrap().clone();
        for (key, value) in reference.get("editor").unwrap().as_obj().unwrap().iter() {
            state.set(key, value.clone());
        }
        let mut session = styk_edit::session::Session::start(document, &styk_doc::json::to_string(&Value::object(state))).unwrap();
        let mut previous = first.get("state").unwrap().clone();
        let mut expected = first.get("document").unwrap().as_str().unwrap().to_string();
        for step in &steps[1..] {
            let call: Vec<Value> = step.get("call").unwrap().elements().unwrap().iter().collect();
            let method = call[0].as_str().unwrap();
            let mut view = previous.as_obj().unwrap().clone();
            view.set("autoKey", Value::Bool(mode == "autokey-sheet"));
            let answer = styk_doc::json::parse(session.call(method,
                &styk_doc::json::to_string(&Value::array(call[1..].to_vec())),
                &styk_doc::json::to_string(&Value::object(view))).as_bytes()).unwrap();
            assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"), "{mode}/{method}: {answer}");
            assert_eq!(answer.get("state"), step.get("state"), "{mode}/{method} state");
            assert_eq!(answer.get("events"), step.get("events"), "{mode}/{method} events");
            if let Some(document) = step.get("document").and_then(Value::as_str) { expected = document.to_string(); }
            assert_eq!(styk_doc::json::to_string(session.report()), expected, "{mode}/{method} document");
            previous = step.get("state").unwrap().clone();
        }
    }
}

#[test]
fn cyclic_and_dangling_joins_are_bounded_without_changing_the_document() {
    let reference = reference("native");
    let first = reference.get("steps").unwrap().item(0).unwrap();
    let mut report = styk_doc::json::parse(first.get("document").unwrap().as_str().unwrap().as_bytes()).unwrap();
    let objects = report.make_obj().unwrap().get_mut("keyframes").unwrap().make_arr().unwrap()[0]
        .make_obj().unwrap().get_mut("objects").unwrap().make_arr().unwrap();
    // 1 -> 2 -> 1 is a cycle; 3 joins 2; 4 has a missing target.
    objects[0].make_obj().unwrap().set("join", styk_doc::json::parse(br#"{"target_object_slot":1,"target_handle_id":22}"#).unwrap());
    objects[3].make_obj().unwrap().set("join", styk_doc::json::parse(br#"{"target_object_slot":99,"target_handle_id":22}"#).unwrap());
    let mut editor = styk_edit::Editor::new(report.clone(), styk_edit::Options::default());
    editor.call("selectConnected", &[Value::Num(1.0)]).unwrap();
    assert_eq!(editor.state_value().get("selectedUids").unwrap().numbers().unwrap(), vec![1.0, 2.0, 3.0]);
    editor.call("selectConnected", &[Value::Num(4.0)]).unwrap();
    assert_eq!(editor.state_value().get("selectedUids").unwrap().numbers().unwrap(), vec![4.0]);
    assert!(report.same_node(editor.report()), "selection must not replace the document");
    assert_eq!(editor.state_value().get("canUndo"), Some(&Value::Bool(false)));
}

#[test]
fn unsupported_candidate_transport_refuses_without_mutating_selection_or_document() {
    let reference = reference("native");
    let document = reference.get("steps").unwrap().item(0).unwrap().get("document").unwrap().as_str().unwrap().to_string();
    let report = styk_doc::json::parse(document.as_bytes()).unwrap();
    let mut editor = styk_edit::Editor::new(report.clone(), styk_edit::Options::default());
    editor.call("select", &[Value::Num(4.0)]).unwrap();
    editor.take_events();
    let before = editor.state_value();
    let result = editor.call("selectConnected", &[Value::Num(1.0), styk_doc::json::parse(br#"{"candidates":null}"#).unwrap()]);
    assert!(matches!(result, Err(styk_edit::EditError::Unported(_))));
    assert_eq!(editor.state_value(), before);
    assert!(report.same_node(editor.report()));
    assert!(editor.take_events().is_empty());
}

#[test]
fn invalid_join_slots_do_not_connect_unrelated_figures() {
    let reference = reference("native");
    let text = reference.get("steps").unwrap().item(0).unwrap().get("document").unwrap().as_str().unwrap().to_string();
    for target in ["-1", "0.5", "99", "\"0\"", "null"] {
        let mut report = styk_doc::json::parse(text.as_bytes()).unwrap();
        let objects = report.make_obj().unwrap().get_mut("keyframes").unwrap().make_arr().unwrap()[0]
            .make_obj().unwrap().get_mut("objects").unwrap().make_arr().unwrap();
        objects[3].make_obj().unwrap().set("join", styk_doc::json::parse(format!(r#"{{"target_object_slot":{target},"target_handle_id":22}}"#).as_bytes()).unwrap());
        let mut editor = styk_edit::Editor::new(report, styk_edit::Options::default());
        editor.call("selectConnected", &[Value::Num(4.0)]).unwrap();
        assert_eq!(editor.state().selected_uids, vec![4], "target {target}");
    }
}

#[test]
fn external_ownership_candidates_skip_a_bridge_without_breaking_traversal() {
    use std::collections::HashSet;
    let reference = reference("native");
    let first = reference.get("steps").unwrap().item(0).unwrap();
    for cycle in [false, true] {
        let mut report = styk_doc::json::parse(first.get("document").unwrap().as_str().unwrap().as_bytes()).unwrap();
        if cycle {
            let objects = report.make_obj().unwrap().get_mut("keyframes").unwrap().make_arr().unwrap()[0]
                .make_obj().unwrap().get_mut("objects").unwrap().make_arr().unwrap();
            objects[0].make_obj().unwrap().set("join", styk_doc::json::parse(br#"{"target_object_slot":1,"target_handle_id":22}"#).unwrap());
        }
        // Ownership lives at the caller, not in an invented engine document tag.
        // Figure 2 bridges 1 and 3; a remote lock excludes it from additions.
        let externally_owned = HashSet::from([2_u32]);
        let candidates = Value::array((1..=4_u32).filter(|id| !externally_owned.contains(id))
            .map(|id| Value::Num(id as f64)).collect());
        let mut options = styk_doc::Obj::new();options.set("candidates", candidates);
        let options = Value::object(options);
        let mut editor = styk_edit::Editor::new(report.clone(), styk_edit::Options::default());
        for start in [1, 2] {
            let result = editor.call("selectConnected", &[Value::Num(start as f64), options.clone()]).unwrap();
            assert_eq!(editor.state().selected_uids, vec![1,3]);
            assert_eq!(editor.state().selected_uid, Some(if start == 1 { 1 } else { 3 }));
            let ids: Vec<f64> = result.elements().unwrap().iter().map(|o| o.get("unique_id").unwrap().as_f64().unwrap()).collect();
            assert_eq!(ids, vec![1.0,3.0]);
            editor.take_events();
            editor.call("selectConnected", &[Value::Num(start as f64), options.clone()]).unwrap();
            assert!(editor.take_events().is_empty());
            assert!(report.same_node(editor.report()));
            assert!(!editor.state().can_undo);
        }
        // add preserves prior selections, even when the caller's eligibility changes.
        editor.call("select", &[Value::Num(2.0)]).unwrap();
        let mut add = options.as_obj().unwrap().clone();add.set("add", Value::Bool(true));
        editor.call("selectConnected", &[Value::Num(1.0), Value::object(add)]).unwrap();
        assert_eq!(editor.state().selected_uids, vec![2,1,3]);
        assert!(report.same_node(editor.report()));
    }
}

#[test]
fn session_lock_mask_overrides_stale_candidates_and_add_selection() {
    let reference = reference("native");
    let first = reference.get("steps").unwrap().item(0).unwrap();
    let report = styk_doc::json::parse(first.get("document").unwrap().as_str().unwrap().as_bytes()).unwrap();
    let mut session = styk_edit::session::Session::start(report.clone(), &styk_doc::json::to_string(first.get("state").unwrap())).unwrap();
    session.call("selectMany", "[[2,4]]", "null");
    let revision = session.revision();
    let state = styk_doc::json::parse(session.set_selection_locks(1, &[2]).unwrap().as_bytes()).unwrap();
    assert_eq!(state.get("selectedUids").unwrap().numbers().unwrap(), vec![4.0]);
    // A stale caller reintroduces the denied bridge in both view and candidates.
    let mut view = first.get("state").unwrap().as_obj().unwrap().clone();
    view.set("selectedUid", Value::Num(2.0));
    view.set("selectedUids", styk_doc::json::parse(b"[2,4]").unwrap());
    // Command/view fields cannot replace the host-installed mask.
    view.set("selectionLocks", styk_doc::json::parse(b"[]").unwrap());
    let view = styk_doc::json::to_string(&Value::object(view));
    for start in [1,2] {
        let args = format!(r#"[{start},{{"add":true,"candidates":[1,2,3,999],"selectionLocks":[]}}]"#);
        let answer = styk_doc::json::parse(session.call("selectConnected", &args, &view).as_bytes()).unwrap();
        assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"));
        let state = answer.get("state").unwrap();
        assert_eq!(state.get("selectedUids").unwrap().numbers().unwrap(), vec![4.0,1.0,3.0]);
        assert_eq!(state.get("selectedUid").and_then(Value::as_f64), Some(if start==1 {1.0} else {3.0}));
        assert_eq!(state.get("canUndo"), Some(&Value::Bool(false)));
    }
    // Invalid transport refuses without restoring the stale denied selection.
    let answer = styk_doc::json::parse(session.call("selectConnected", r#"[1,{"add":true,"candidates":null}]"#, &view).as_bytes()).unwrap();
    assert_eq!(answer.get("status").and_then(Value::as_str), Some("unported"));
    assert_eq!(answer.get("state").unwrap().get("selectedUids").unwrap().numbers().unwrap(), vec![4.0]);
    assert!(report.same_node(session.report()));
    assert_eq!(session.revision(), revision);
    assert!(!session.can_undo());
}

#[test]
fn lock_policy_generations_are_monotonic_and_never_enter_history() {
    let reference = reference("native");
    let first = reference.get("steps").unwrap().item(0).unwrap();
    let report = styk_doc::json::parse(first.get("document").unwrap().as_str().unwrap().as_bytes()).unwrap();
    let mut editor = styk_edit::Editor::new(report.clone(), styk_edit::Options::default());
    editor.call("selectMany", &[styk_doc::json::parse(b"[1,2,3]").unwrap()]).unwrap();
    editor.set_selection_locks(4, &[2,2]).unwrap();
    assert_eq!(editor.state().selected_uids, vec![1,3]);
    editor.take_events();
    editor.set_selection_locks(4, &[2]).unwrap();
    assert!(editor.take_events().is_empty());
    assert!(editor.set_selection_locks(3, &[]).is_err());
    assert!(editor.set_selection_locks(4, &[]).is_err());
    editor.call("selectConnected", &[Value::Num(2.0)]).unwrap();
    assert_eq!(editor.state().selected_uids, vec![1,3]);
    editor.take_events();
    editor.call("selectConnected", &[Value::Num(2.0)]).unwrap();
    assert!(editor.take_events().is_empty());
    // A newer empty policy explicitly releases the deny mask.
    editor.set_selection_locks(5, &[]).unwrap();
    editor.call("selectConnected", &[Value::Num(2.0)]).unwrap();
    assert_eq!(editor.state().selected_uids, vec![1,2,3]);
    assert!(report.same_node(editor.report()));
    assert!(!editor.state().can_undo);
}

#[test]
fn worker_policy_update_retires_a_prepared_operation_without_changing_revision() {
    let reference = reference("native");
    let first = reference.get("steps").unwrap().item(0).unwrap();
    let report = styk_doc::json::parse(first.get("document").unwrap().as_str().unwrap().as_bytes()).unwrap();
    let mut session = styk_edit::session::Session::start(report.clone(), &styk_doc::json::to_string(first.get("state").unwrap())).unwrap();
    session.call("select", "[2]", "null");
    session.prepare_worker_history(styk_edit::HistoryLimits::default(), 0.0, || Ok(())).unwrap();
    let mut worker = session.into_worker();
    let revision = worker.revision();
    let prepared = worker.prepare_quiet("moveSelection", &styk_doc::json::parse(b"[5,0]").unwrap(), &Value::Null, || Ok(())).unwrap();
    let epoch = worker.operation_epoch();
    worker.set_selection_locks(1, &[2]).unwrap();
    assert!(worker.operation_epoch() > epoch);
    assert!(worker.guard(prepared, || Ok(())).is_err());
    assert_eq!(worker.revision(), revision);
    assert!(report.same_node(worker.report()));
    let epoch = worker.operation_epoch();
    worker.set_selection_locks(1, &[2]).unwrap();
    assert_eq!(worker.operation_epoch(), epoch, "identical updates are idempotent");
    let mut session = worker.into_session();
    let answer = styk_doc::json::parse(session.call("selectConnected", "[2]", "null").as_bytes()).unwrap();
    assert_eq!(answer.get("state").unwrap().get("selectedUids").unwrap().numbers().unwrap(), vec![1.0,3.0]);
}

#[test]
fn denied_bridge_in_a_cycle_is_traversed_but_never_retained_or_added() {
    let reference = reference("native");
    let first = reference.get("steps").unwrap().item(0).unwrap();
    let mut report = styk_doc::json::parse(first.get("document").unwrap().as_str().unwrap().as_bytes()).unwrap();
    let objects = report.make_obj().unwrap().get_mut("keyframes").unwrap().make_arr().unwrap()[0]
        .make_obj().unwrap().get_mut("objects").unwrap().make_arr().unwrap();
    objects[0].make_obj().unwrap().set("join", styk_doc::json::parse(br#"{"target_object_slot":1,"target_handle_id":22}"#).unwrap());
    let mut editor = styk_edit::Editor::new(report.clone(), styk_edit::Options::default());
    editor.call("select", &[Value::Num(2.0)]).unwrap();
    editor.set_selection_locks(1, &[2]).unwrap();
    let options = styk_doc::json::parse(br#"{"add":true,"candidates":[1,2,3]}"#).unwrap();
    editor.call("selectConnected", &[Value::Num(2.0), options]).unwrap();
    assert_eq!(editor.state().selected_uids, vec![1,3]);
    assert_eq!(editor.state().selected_uid, Some(3));
    assert!(report.same_node(editor.report()));
}

#[test]
fn direct_publication_guard_checks_policy_even_when_selection_did_not_change() {
    let reference = reference("native");
    let first = reference.get("steps").unwrap().item(0).unwrap();
    let report = styk_doc::json::parse(first.get("document").unwrap().as_str().unwrap().as_bytes()).unwrap();
    let mut session = styk_edit::session::Session::start(report.clone(), &styk_doc::json::to_string(first.get("state").unwrap())).unwrap();
    session.call("select", "[1]", "null");
    session.prepare_worker_history(styk_edit::HistoryLimits::default(), 0.0, || Ok(())).unwrap();
    let prepared = session.prepare_worker_call_values("moveSelection", &styk_doc::json::parse(b"[5,0]").unwrap(), &Value::Null, || Ok(())).unwrap();
    // UID 2 was not selected: the policy change alone must retire this candidate.
    session.set_selection_locks(1, &[2]).unwrap();
    assert!(session.guard_worker_publication_checked(prepared, || Ok(())).is_err());
    assert!(report.same_node(session.report()));
}

#[test]
fn batch_dispatch_cannot_retain_denied_ids_added_by_an_earlier_step() {
    let reference = reference("native");
    let first = reference.get("steps").unwrap().item(0).unwrap();
    let report = styk_doc::json::parse(first.get("document").unwrap().as_str().unwrap().as_bytes()).unwrap();
    let mut editor = styk_edit::Editor::new(report.clone(), styk_edit::Options::default());
    editor.set_selection_locks(1, &[2]).unwrap();
    let args = styk_doc::json::parse(br#"["selection",[["selectMany",[2,4]],["selectConnected",1,{"add":true,"candidates":[1,2,3]}]]]"#).unwrap();
    editor.call("@batch", &args.elements().unwrap().iter().collect::<Vec<_>>()).unwrap();
    assert_eq!(editor.state().selected_uids, vec![4,1,3]);
    assert!(report.same_node(editor.report()));
    assert!(!editor.state().can_undo);
}
