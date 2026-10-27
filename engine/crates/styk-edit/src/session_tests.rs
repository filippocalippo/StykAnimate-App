//! Compact responses reconstruct the complete session response and keep the oracle's
//! publication bytes. No ownership gate is changed by this protocol test.
use super::*;
use std::path::Path;

fn json(value: &Value) -> String { styk_doc::json::to_string(value) }
fn parse(text: &str) -> Value { styk_doc::json::parse(text.as_bytes()).unwrap() }

#[test]
fn compact_pose_records_reuse_cow_values_and_strip_only_runtime_movieclip_clock() {
    let frame = parse(r#"{"objects":[{"unique_id":1,"angles":[-0,0.25],"unknown":{"_movieclipSample":{"keep":true}}},{"unique_id":2,"angles":[0.5],"_movieclipSample":{"tick":3},"unknown":"retained"},{"unique_id":3,"angles":[1]}]}"#);
    let before = json(&frame);
    let taken = HashSet::from([1, 2]);
    let records = changed_figures(&frame, None, Some(&taken));
    assert_eq!(records.len(), 2);
    let first = frame.get("objects").unwrap().item(0).unwrap();
    assert!(records[0].same_node(&first), "an ordinary live pose response borrows its existing COW record");
    assert_eq!(json(&Value::array(records.clone())), r#"[{"unique_id":1,"angles":[0,0.25],"unknown":{"_movieclipSample":{"keep":true}}},{"unique_id":2,"angles":[0.5],"unknown":"retained"}]"#);
    assert_eq!(json(&frame), before, "clock cleanup never edits the authored frame");
    let mut later = records[0].clone();
    later.make_obj().unwrap().set("angles", parse("[0.75]"));
    assert_eq!(json(&records[0]), json(&first), "later edits retain the already returned pose");
    assert!(changed_figures(&frame, Some(&frame), Some(&taken)).is_empty(), "unchanged records are still omitted");
}

#[test]
fn ordered_state_response_matches_all_five_recorded_figure_tapes() {
    let mut calls = 0;
    for name in ["startup-sheet", "rig-sheet", "gestures-sheet", "figures-layers-sheet", "drag-cancel"] {
        let file = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../tests/edit/{name}.reference.json"));
        let reference = styk_doc::json::parse(&std::fs::read(file).unwrap()).unwrap();
        let steps = reference.get("steps").unwrap().elements().unwrap();
        let first = steps.get(0).unwrap();
        let mut state = first.get("state").unwrap().as_obj().unwrap().clone();
        if let Some(options) = reference.get("editor").and_then(Value::as_obj) {
            for (key, value) in options.iter() { state.set(key, value.clone()); }
        }
        let mut session = Session::start(parse(first.get("document").unwrap().as_str().unwrap()), &json(&Value::object(state))).unwrap();
        assert_eq!(json(&session.editor.state_value()), json(first.get("state").unwrap()), "{name}: initial state");
        for (index, step) in steps.iter().enumerate().skip(1) {
            let call = step.get("call").unwrap().elements().unwrap();
            let method = call.get(0).unwrap();
            let args = Value::array(call.iter().skip(1).collect());
            let mut view = session.editor.state_value().as_obj().unwrap().clone();
            view.set("autoKey", Value::Bool(session.editor.auto_key));
            view.set("changesOnly", Value::Bool(true));
            let answer = session.call_values(method.as_str().unwrap(), &args, &Value::object(view));
            assert_ne!(answer.get("status").and_then(Value::as_str), Some("unported"), "{name} step {index}: {answer:?}");
            assert_eq!(json(answer.get("state").unwrap()), json(step.get("state").unwrap()), "{name} step {index}: ordered state");
            calls += 1;
        }
    }
    assert_eq!(calls, 130);
}

fn session_from_recorded_state(reference: &Value, state: &Value) -> Session {
    let first = reference.get("steps").unwrap().item(0).unwrap();
    let mut state = state.as_obj().unwrap().clone();
    for (key, value) in reference.get("editor").unwrap().as_obj().unwrap().iter() { state.set(key, value.clone()); }
    Session::start(parse(first.get("document").unwrap().as_str().unwrap()), &json(&Value::object(state))).unwrap()
}

/// Consume only the documented stored replacements; frame metadata/order stay local.
fn apply_split_packet(mut report: Value, packet: &Value) -> Value {
    let index = packet.get("index").unwrap().as_f64().unwrap() as usize;
    report.make_obj().unwrap().get_mut("figure_types").unwrap().make_arr().unwrap()[index] = packet.get("figure").unwrap().clone();
    for change in packet.get("frames").unwrap().elements().unwrap().iter() {
        let place = match change.get("sourceId").and_then(Value::as_str) {
            Some(id) => { assert_eq!(change.get("index").and_then(Value::as_f64), Some(-1.0)); crate::topology::Place::Source(id.into()) }
            None => crate::topology::Place::Keyframe(change.get("index").unwrap().as_f64().unwrap() as usize),
        };
        let frame = crate::topology::frame_mut(&mut report, &place).unwrap();
        let objects = frame.get_mut("objects").unwrap().make_arr().unwrap();
        for replacement in change.get("objects").unwrap().elements().unwrap().iter() {
            let slot = objects.iter_mut().find(|object| crate::record::uid(object) == crate::record::uid(&replacement)).unwrap();
            *slot = replacement;
        }
    }
    for (key, path) in [("animation", &["_styk"][..]), ("sheetAnimation", &["_styk", "layerSheet"][..])] {
        if let Some(change) = packet.get(key) {
            let mut parent = &mut report;
            for key in path { parent = parent.make_obj().unwrap().get_mut(key).unwrap(); }
            let parent = parent.make_obj().unwrap();
            let field = if key == "animation" { "animation" } else { "legacyAnimation" };
            if change.get("exists") == Some(&Value::Bool(true)) { parent.set(field, change.get("value").unwrap().clone()); }
            else { parent.remove(field); }
        }
    }
    report
}

#[test]
fn split_topology_packets_reconstruct_recorded_storage_without_changing_default_answers() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/builder-split-sheet.reference.json");
    let reference = parse(&std::fs::read_to_string(path).unwrap());
    let steps: Vec<Value> = reference.get("steps").unwrap().elements().unwrap().iter().collect();
    for compact in [false, true] {
        let mut ordinary = session_from_recorded_state(&reference, steps[0].get("state").unwrap());
        let mut requested = session_from_recorded_state(&reference, steps[0].get("state").unwrap());
        let mut expected = steps[0].get("document").unwrap().as_str().unwrap().to_string();
        let mut packets = Vec::new();
        for step in &steps[1..] {
            let call: Vec<Value> = step.get("call").unwrap().elements().unwrap().iter().collect();
            let method = call[0].as_str().unwrap();
            let label = format!("builder split step{} compact={compact}", step.get("step").unwrap());
            if method == "@frame" {
                for session in [&ordinary, &requested] {
                    let frame = session.editor.shown_frame().unwrap();
                    assert_eq!(Some(&Value::str(&json(&styk_eval::records::snapshot_pose_frame(&frame)))), step.get("result"), "{label}: visible frame");
                }
            } else {
                let before = requested.report().clone();
                let mut view = ordinary.editor.state_value().as_obj().unwrap().clone();
                view.set("autoKey", Value::Bool(ordinary.editor.auto_key));
                view.set("changesOnly", Value::Bool(compact));
                let args = Value::array(call[1..].to_vec());
                let ordinary_answer = ordinary.call_values(method.trim_start_matches('@'), &args, &Value::object(view.clone()));
                view.set("topologyPublication", Value::Bool(true));
                let mut answer = requested.call_values(method.trim_start_matches('@'), &args, &Value::object(view));
                if let Some(packet) = answer.get("topology").cloned() {
                    assert!(matches!(method, "splitBuilderSegments" | "splitSegment" | "splitSegmentBranch"));
                    assert_eq!(answer.get("result"), Some(&Value::Bool(true)));
                    assert_eq!(json(&apply_split_packet(before.clone(), &packet)), json(requested.report()), "{label}: stored definition and poses");
                    if packets.is_empty() {
                        let mut unsupported = requested.report().clone();
                        crate::topology::frame_mut(&mut unsupported, &crate::topology::Place::Keyframe(0)).unwrap().set("unknownMetadata", Value::Bool(true));
                        assert!(split_topology_publication(&before, &unsupported).is_none(), "a pose packet cannot elide frame metadata changes");
                        let mut unsupported = requested.report().clone();
                        crate::topology::frame_mut(&mut unsupported, &crate::topology::Place::Keyframe(0)).unwrap().set("objects", Value::array(Vec::new()));
                        assert!(split_topology_publication(&before, &unsupported).is_none(), "a pose packet cannot remove membership");
                        for (key, path, field) in [("animation", &["_styk"][..], "animation"), ("sheetAnimation", &["_styk", "layerSheet"][..], "legacyAnimation")] {
                            let mut explicit_null = requested.report().clone();
                            let mut parent = &mut explicit_null;
                            for key in path { parent = parent.make_obj().unwrap().get_mut(key).unwrap(); }
                            parent.make_obj().unwrap().set(field, Value::Null);
                            let presence = split_topology_publication(&before, &explicit_null).unwrap();
                            assert_eq!(presence.get(key).unwrap().get("exists"), Some(&Value::Bool(true)));
                            assert_eq!(presence.get(key).unwrap().get("value"), Some(&Value::Null));
                            assert_eq!(json(&apply_split_packet(before.clone(), &presence)), json(&explicit_null));
                            let mut before_null = before.clone();
                            let mut parent = &mut before_null;
                            for key in path { parent = parent.make_obj().unwrap().get_mut(key).unwrap(); }
                            parent.make_obj().unwrap().set(field, Value::Null);
                            let absence = split_topology_publication(&before_null, requested.report()).unwrap();
                            assert_eq!(absence.get(key).unwrap().get("exists"), Some(&Value::Bool(false)));
                            assert!(absence.get(key).unwrap().get("value").is_none());
                            assert_eq!(json(&apply_split_packet(before_null, &absence)), json(requested.report()));
                        }
                    }
                    let index = packet.get("index").unwrap().as_f64().unwrap() as usize;
                    assert!(packet.get("figure").unwrap().same_node(&requested.report().get("figure_types").unwrap().item(index).unwrap()), "{label}: COW definition");
                    packets.push((packet.clone(), json(&packet)));
                    answer.make_obj().unwrap().remove("topology");
                } else if matches!(method, "splitBuilderSegments" | "splitSegment" | "splitSegmentBranch") && step.get("result") == Some(&Value::Bool(true)) {
                    panic!("{label}: successful split did not publish its stored changes");
                }
                assert_eq!(json(&answer), json(&ordinary_answer), "{label}: existing answer bytes");
                assert!(ordinary_answer.get("topology").is_none());
                assert_eq!(json(answer.get("state").unwrap()), json(step.get("state").unwrap()), "{label}: recorded state");
                assert_eq!(json(answer.get("events").unwrap()), json(step.get("events").unwrap()), "{label}: recorded events");
                if let Some(error) = step.get("error").filter(|error| !error.is_null()) {
                    assert_eq!(answer.get("status").and_then(Value::as_str), Some("error"));
                    assert_eq!(answer.get("error"), error.get("key"));
                } else {
                    assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"));
                    assert_eq!(crate::replay::plain(answer.get("result").unwrap(), 4).unwrap_or(Value::Null), step.get("result").cloned().unwrap());
                }
            }
            if let Some(document) = step.get("document").and_then(Value::as_str) { expected = document.into(); }
            assert_eq!(requested.editor.report_json(), expected, "{label}: recorded document");
            assert_eq!(ordinary.editor.report_json(), expected, "{label}: ordinary document");
        }
        assert_eq!(packets.len(), 4, "both direct modes and the two aliases publish");
        for (packet, bytes) in packets { assert_eq!(json(&packet), bytes, "later history leaves a returned packet immutable"); }
    }
}

#[test]
fn split_topology_packet_survives_zero_history_and_keeps_source_cleanup_local() {
    let reference = parse(&std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/builder-split-sheet.reference.json")).unwrap());
    let first = reference.get("steps").unwrap().item(0).unwrap();
    for limit in [0, 80] {
        let mut session = session_from_recorded_state(&reference, first.get("state").unwrap());
        // Existing authored moves create two real captured source owners; the first
        // is retained only by history after the second replaces the current key.
        for args in [parse("[3,0]"), parse("[1,0]")] {
            let answer = session.call_values("moveSelection", &args, &session.editor.state_value());
            assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"));
        }
        let captured = session.editor.generated_sources.clone();
        assert_eq!(captured.len(), 2);
        let selected = session.call_values("select", &parse("[1,1]"), &session.editor.state_value());
        assert_eq!(selected.get("status").and_then(Value::as_str), Some("ok"));
        session.editor.history_limits.count = limit;
        let before = session.report().clone();
        let before_counts = session.editor.uid_counts.clone();
        let source_table_was_present = session.editor.source_table_was_present;
        let old_source = before.path(&["_styk", "frameSources", &captured[0]]).unwrap().clone();
        let old_bytes = json(&old_source);
        let mut view = session.editor.state_value().as_obj().unwrap().clone();
        view.set("topologyPublication", Value::Bool(true));
        let answer = session.call_values("splitBuilderSegments", &parse(r#"[{"branch":false,"fraction":0.5}]"#), &Value::object(view));
        assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"));
        let packet = answer.get("topology").unwrap();
        let changes: Vec<Value> = packet.get("frames").unwrap().elements().unwrap().iter().collect();
        assert!(changes.iter().any(|change| change.get("sourceId").and_then(Value::as_str) == Some(captured[1].as_str())), "current captured poses are carried");
        for change in &changes {
            if let Some(id) = change.get("sourceId").and_then(Value::as_str) {
                assert!(before.path(&["_styk", "frameSources", id]).is_some(), "packet introduces no source");
                let current = session.report().path(&["_styk", "frameSources", id]).unwrap();
                for pose in change.get("objects").unwrap().elements().unwrap().iter() {
                    assert!(current.get("objects").unwrap().elements().unwrap().iter().any(|object| object.same_node(&pose)), "packet borrows the surviving stored pose");
                }
            }
        }
        if limit == 0 {
            assert!(session.editor.undo.is_empty());
            assert!(session.report().path(&["_styk", "frameSources", &captured[0]]).is_none(), "the existing zero-history cleanup drops the orphan");
            assert!(!changes.iter().any(|change| change.get("sourceId").and_then(Value::as_str) == Some(captured[0].as_str())), "cleanup is not a source deletion packet");
            // The adopter publishes the stored replacements and uses its existing
            // record/prune owner. Reconstruct that same empty-history cleanup.
            let mut reconstructed = Editor::new(apply_split_packet(before.clone(), packet), session.editor.options);
            reconstructed.generated_sources = captured.clone();
            reconstructed.uid_counts = before_counts;
            reconstructed.source_table_was_present = source_table_was_present;
            reconstructed.prune_frame_sources();
            assert_eq!(json(reconstructed.report()), json(session.report()), "existing cleanup reconstructs final source table and order");
            assert_eq!(reconstructed.generated_sources, session.editor.generated_sources);
            assert_eq!(reconstructed.uid_counts, session.editor.uid_counts);
        } else {
            assert!(changes.iter().any(|change| change.get("sourceId").and_then(Value::as_str) == Some(captured[0].as_str())), "the kept topology snapshot retains the history-only source");
            assert_eq!(json(&apply_split_packet(before.clone(), packet)), json(session.report()));
        }
        assert_eq!(json(&old_source), old_bytes, "pre-call source aliases are immutable");
    }
}

#[test]
fn unchanged_session_view_keeps_selection_storage_and_continues_options() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    for name in ["move-native", "selection-metadata-plain-sheet"] {
        let reference = parse(&std::fs::read_to_string(root.join(format!("{name}.reference.json"))).unwrap());
        let first = reference.get("steps").unwrap().item(0).unwrap();
        let mut session = session_from_recorded_state(&reference, first.get("state").unwrap());
        let pointer = session.editor.selection.uids.as_ptr();
        assert!(!session.editor.selection.uids.is_empty());
        let report = session.report().clone();
        let state = session.editor.state_value();
        let answer = session.call_values("updateProject", &parse("[{}]"), &state);
        assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"));
        assert_eq!(answer.get("result"), Some(&Value::Bool(false)));
        assert_eq!(pointer, session.editor.selection.uids.as_ptr(), "{name}: unchanged view retains its existing selection allocation");
        assert_eq!(answer.get("state"), Some(&state));
        assert!(session.report().same_node(&report));
        assert_eq!(answer.get("events").and_then(Value::array_len), Some(0));
        assert_eq!(answer.get("drag"), Some(&Value::Null));
        assert_eq!(answer.get("draft"), Some(&Value::Null));

        let mut view = state.as_obj().unwrap().clone();
        view.set("autoKey", Value::Bool(true));
        view.set("sheetSelection", parse(r#"{"id":"camera","contents":true}"#));
        if report.path(&["_styk", "layers"]).is_some() { view.set("activeLayerId", Value::str("camera")); }
        let answer = session.call_values("updateProject", &parse("[{}]"), &Value::object(view));
        assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"));
        assert_eq!(pointer, session.editor.selection.uids.as_ptr());
        assert!(session.editor.auto_key);
        let sheet = session.editor.sheet_selection.as_ref().unwrap();
        assert_eq!(sheet.id, "camera"); assert!(sheet.contents);
        if report.path(&["_styk", "layers"]).is_some() {
            assert_eq!(session.report().path(&["_styk", "layers", "activeId"]).and_then(Value::as_str), Some("camera"));
        }
    }
}

#[test]
fn session_view_sync_keeps_existing_changed_cold_and_invalid_projection() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    let reference = parse(&std::fs::read_to_string(root.join("move-native.reference.json")).unwrap());
    let first = reference.get("steps").unwrap().item(0).unwrap();
    for (view, tick, frame, uid, uids, joint) in [
        (r#"{"tick":1.25,"frameIndex":1,"selectedUid":2,"selectedUids":[2,1],"selectedJoint":0}"#, 1.25f64, 1usize, Some(2u32), vec![2, 1], 0i64),
        (r#"{"tick":-0,"frameIndex":0,"selectedUid":1,"selectedUids":[1],"selectedJoint":-1}"#, -0.0, 0, Some(1), vec![1], -1),
        (r#"{}"#, 0.0, 0, None, vec![], -1),
        (r#"{"tick":0,"frameIndex":0,"selectedUid":1,"selectedUids":[1,false],"selectedJoint":-1}"#, 0.0, 0, Some(1), vec![], -1),
        (r#"{"tick":null,"frameIndex":0.75,"selectedUid":"1","selectedUids":null,"selectedJoint":1.5}"#, 0.0, 0, None, vec![], 1),
        (r#"{"tick":0,"frameIndex":-1,"selectedUid":-1,"selectedUids":[-1,2.75],"selectedJoint":-1}"#, 0.0, 0, Some(0), vec![0, 2], -1),
        (r#"{"tick":1e400,"frameIndex":0,"selectedUid":1,"selectedUids":[1],"selectedJoint":-1}"#, f64::INFINITY, 0, Some(1), vec![1], -1),
    ] {
        let mut session = session_from_recorded_state(&reference, first.get("state").unwrap());
        let report = session.report().clone();
        let answer = session.call_values("updateProject", &parse("[{}]"), &parse(view));
        assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"), "{view}: {answer:?}");
        assert_eq!(answer.get("result"), Some(&Value::Bool(false)));
        assert_eq!(session.editor.tick.to_bits(), tick.to_bits(), "{view}: tick bits");
        assert_eq!(session.editor.frame_index, frame); assert_eq!(session.editor.selection.uid, uid);
        assert_eq!(session.editor.selection.uids, uids); assert_eq!(session.editor.selection.joint, joint);
        assert!(session.report().same_node(&report));
        assert_eq!(answer.get("events").and_then(Value::array_len), Some(0));
    }
}

#[test]
fn optional_view_sync_preserves_present_stale_and_explicit_null_metadata() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    for mode in ["native", "sheet"] {
        let reference = parse(&std::fs::read_to_string(root.join(format!("selection-metadata-plain-{mode}.reference.json"))).unwrap());
        let steps = reference.get("steps").unwrap().elements().unwrap();
        for key in ["polygonSelection", "segmentIds", "branch"] {
            let state = steps.iter().find_map(|step| step.get("state").filter(|state| state.get(key).is_some()).cloned()).unwrap();
            let mut session = session_from_recorded_state(&reference, &state);
            let raw = session.editor.selection_metadata.clone();
            let shown = session.editor.state_value();
            let answer = session.call_values("updateProject", &parse("[{}]"), &shown);
            assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"));
            assert_eq!(raw, session.editor.selection_metadata, "{mode}/{key}: canonical repeated metadata");
            assert_eq!(answer.get("state"), Some(&shown));
            let mut view = shown.as_obj().unwrap().clone(); view.set(key, Value::Null);
            let answer = session.call_values("updateProject", &parse("[{}]"), &Value::object(view));
            assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"));
            assert!(session.editor.selection_metadata.polygon.is_none());
            assert!(session.editor.selection_metadata.segments.is_none());
            assert!(session.editor.selection_metadata.branch.is_none());
            assert!(answer.get("state").unwrap().get(key).is_none());
        }
        let state = steps.iter().find_map(|step| step.get("state").filter(|state| state.get("branch").is_some()).cloned()).unwrap();
        let mut session = session_from_recorded_state(&reference, &state);
        let mut branch = session.editor.selection_metadata.branch.as_ref().unwrap().as_obj().unwrap().clone();
        branch.set("unknown", parse(r#"{"retain":true}"#)); session.editor.selection_metadata.branch = Some(Value::object(branch));
        let original = session.editor.selection_metadata.clone();
        session.editor.selection.joint = -1;
        let hidden = session.editor.state_value(); assert!(hidden.get("branch").is_none());
        let answer = session.call_values("updateProject", &parse("[{}]"), &hidden);
        assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"));
        assert_eq!(original, session.editor.selection_metadata, "{mode}: absent canonical metadata retains hidden stale fields");
        let mut view = hidden.as_obj().unwrap().clone(); view.set("branch", Value::Null);
        let answer = session.call_values("updateProject", &parse("[{}]"), &Value::object(view));
        assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"));
        assert!(session.editor.selection_metadata.branch.is_none());
    }
}

fn merge_figures(base: &Value, changed: &Value, order: Option<&Value>) -> Value {
    let mut objects: Vec<Value> = base.elements().unwrap().iter().collect();
    for figure in changed.elements().unwrap().iter() {
        let uid = crate::record::uid(&figure).unwrap();
        match objects.iter().position(|object| crate::record::uid(object) == Some(uid)) {
            Some(slot) => objects[slot] = figure,
            None => objects.push(figure),
        }
    }
    if let Some(order) = order {
        objects = order.elements().unwrap().iter().map(|uid| objects.iter().find(|object| object.get("unique_id") == Some(&uid)).unwrap().clone()).collect();
    }
    Value::array(objects)
}

/// `base` with the figures and fields of a [`frame_delta`] laid over it, as the owner does.
fn apply_frame_delta(base: &Value, delta: &Value) -> Value {
    let figures = delta.get("figures").unwrap();
    let mut frame = base.as_obj().unwrap().clone();
    for (key, value) in delta.get("fields").and_then(Value::as_obj).into_iter().flat_map(|fields| fields.iter()) { frame.set(key, value.clone()); }
    for key in delta.get("removed").and_then(Value::elements).into_iter().flat_map(|keys| keys.iter()) { frame.remove(key.as_str().unwrap()); }
    frame.set("objects", merge_figures(&clean_objects(base), figures, delta.get("order")));
    if let Some(order) = delta.get("fieldOrder") {
        let mut ordered = Obj::new();
        for key in order.elements().unwrap().iter() {
            let key = key.as_str().unwrap();
            ordered.set(key, frame.get(key).unwrap().clone());
        }
        frame = ordered;
    }
    Value::object(frame)
}

fn clean_objects(frame: &Value) -> Value {
    let objects = frame.get("objects").unwrap().elements().unwrap().iter().map(|figure| {
        let mut figure = figure.as_obj().unwrap().clone();
        figure.remove("_movieclipSample");
        Value::object(figure)
    }).collect();
    Value::array(objects)
}

fn reconstruct_sheet(before: &Value, answer: &Value) -> Value {
    let previous = before.path(&["_styk", "layerSheet"]).unwrap().as_obj().unwrap();
    let mut sheet = previous.clone();
    for (key, value) in answer.get("sheet").unwrap().as_obj().unwrap().iter() {
        if &**key != "tracks" { sheet.set(key, value.clone()); }
    }
    for key in answer.get("sheetRemoved").and_then(Value::elements).into_iter().flat_map(|keys| keys.iter()) {
        sheet.remove(key.as_str().unwrap());
    }
    let old_tracks = previous.get("tracks").unwrap().as_obj().unwrap();
    let changed = answer.path(&["sheet", "tracks"]).unwrap().as_obj().unwrap();
    let order: Vec<Value> = answer.get("trackOrder").and_then(Value::elements).map(|order| order.iter().collect()).unwrap_or_else(|| old_tracks.keys().map(|key| Value::str(key)).collect());
    let mut tracks = Obj::new();
    for id in order {
        let id = id.as_str().unwrap();
        tracks.set(id, changed.get(id).or_else(|| old_tracks.get(id)).unwrap().clone());
    }
    sheet.set("tracks", Value::object(tracks));
    if let Some(order) = answer.get("sheetOrder") {
        let mut ordered = Obj::new();
        for key in order.elements().unwrap().iter() {
            let key = key.as_str().unwrap();
            ordered.set(key, sheet.get(key).unwrap().clone());
        }
        sheet = ordered;
    }
    Value::object(sheet)
}

#[test]
fn compact_answers_preserve_recorded_publications_drafts_and_history() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    let mut savings = 0;
    for name in ["move-native", "drag-cancel", "range-native", "startup-sheet", "rig-sheet", "gestures-sheet", "layers-sheet", "figures-layers-sheet", "locked-sheet",
        "handle-edit-chain-sheet", "figure-clipboard-sheet", "figure-clipboard-clip-sheet", "movieclip-sheet", "movieclip-loose-sheet",
        "channels-figure-sheet", "channels-movieclip-sheet", "channels-style-sheet", "property-clip-patches-sheet", "topology-sheet", "topology-native", "ik-movieclip-parent-sheet"] {
        let reference = styk_doc::json::parse(&std::fs::read(folder.join(format!("{name}.reference.json"))).unwrap()).unwrap();
        let steps: Vec<Value> = reference.get("steps").unwrap().elements().unwrap().iter().collect();
        let mut state = steps[0].get("state").unwrap().as_obj().unwrap().clone();
        for (key, value) in reference.get("editor").unwrap().as_obj().unwrap().iter() { state.set(key, value.clone()); }
        let report = parse(steps[0].get("document").unwrap().as_str().unwrap());
        let mut full = Session::start(report.clone(), &json(&Value::object(state.clone()))).unwrap();
        let mut compact = Session::start(report, &json(&Value::object(state))).unwrap();
        for step in &steps[1..] {
            let args: Vec<Value> = step.get("call").unwrap().elements().unwrap().iter().collect();
            let method = args[0].as_str().unwrap().trim_start_matches('@');
            let mut view = full.editor.state_value().as_obj().unwrap().clone();
            view.set("autoKey", Value::Bool(full.editor.options.auto_key));
            view.set("draws", step.get("draws").cloned().unwrap_or(Value::Null));
            let mut small_view = view.clone(); small_view.set("changesOnly", Value::Bool(true));
            let before = compact.editor.report().clone();
            let draft = compact.editor.authored.as_ref().map(|edit| clean_objects(&edit.frame));
            let retained = compact.editor.retained_frame().map(|frame| clean_objects(&frame));
            let payload = json(&Value::array(args[1..].to_vec()));
            let complete_text = full.call(method, &payload, &json(&Value::object(view)));
            let small_text = compact.call(method, &payload, &json(&Value::object(small_view)));
            let complete = parse(&complete_text); let small = parse(&small_text);
            let label = format!("{name} step {} ({method})", step.get("step").unwrap());
            for key in ["status", "result", "reason", "error", "state", "events", "drag", "preview", "sources", "definitions", "retainedFields", "retainedRemoved", "retainedFieldOrder"] {
                if key == "preview" && small.get("previewChanges").is_some() {
                    let base = compact.editor.property_edit_base().expect("a preview composed on the frame the edit began on");
                    assert_eq!(complete.get("preview").map(json), Some(json(&apply_frame_delta(&base, small.get("previewChanges").unwrap()))), "{label}: preview from its changes");
                    continue;
                }
                if key == "result" && complete.get("status").and_then(Value::as_str) == Some("ok") && matches!(method, "duplicateFigure" | "addFigure" | "importFigure" | "pasteSelection" | "duplicateSelection" | "sheetAppendFrame") {
                    // (A paste or a duplicate that made nothing answers its empty list.)
                    let nothing = complete.get("result").is_some_and(|result| result.array_len() == Some(0));
                    assert_eq!(small.get("result"), if nothing { complete.get("result") } else { Some(&Value::Null) });
                    continue;
                }
                assert_eq!(complete.get(key).map(json), small.get(key).map(json), "{label}: {key}");
            }
            assert_eq!(json(full.editor.report()), json(compact.editor.report()), "{label}: document");
            if let Some(changed) = small.get("draft").filter(|value| value.is_array()) {
                let reconstructed = match &draft { Some(draft) => merge_figures(draft, changed, None), None => changed.clone() };
                // Taking another figure mid-gesture can add an unchanged figure to the draft.
                let taken: Vec<u32> = full.editor.drag.as_ref().unwrap().before.iter().filter_map(crate::record::uid).collect();
                let raw = full.editor.authored.as_ref().unwrap();
                let mut adopted = reconstructed.elements().unwrap().iter().filter(|figure| crate::record::uid(figure).is_some_and(|uid| taken.contains(&uid))).collect::<Vec<_>>();
                for figure in clean_objects(&raw.frame).elements().unwrap().iter().filter(|figure| crate::record::uid(figure).is_some_and(|uid| taken.contains(&uid))) {
                    if !adopted.iter().any(|known| crate::record::uid(known) == crate::record::uid(&figure)) { adopted.push(figure); }
                }
                adopted.sort_by_key(|object| object.get("object_slot").and_then(Value::as_f64).unwrap() as usize);
                assert_eq!(json(&Value::array(adopted)), json(complete.get("draft").unwrap()), "{label}: draft");
            } else { assert_eq!(complete.get("draft"), small.get("draft"), "{label}: draft ended"); }
            if small.get("sheet").is_some() {
                assert_eq!(json(&reconstruct_sheet(&before, &small)), json(compact.editor.report().path(&["_styk", "layerSheet"]).unwrap()), "{label}: sheet");
                let layers = small.get("layers").or_else(|| before.path(&["_styk", "layers"]));
                assert_eq!(layers.map(json), complete.get("layers").map(json), "{label}: layers");
            }
            if let Some(changed) = small.get("retained") {
                let adopted = if small.get("retainedChanges").is_some_and(Value::truthy) {
                    merge_figures(draft.as_ref().or(retained.as_ref()).unwrap(), changed, small.get("retainedOrder"))
                } else { changed.clone() };
                let mut expected_frame = Obj::new();
                expected_frame.set("objects", complete.get("retained").unwrap().clone());
                assert_eq!(json(&adopted), json(&clean_objects(&Value::object(expected_frame))), "{label}: retained without runtime samples");
            }
            if small_text.len() < complete_text.len() { savings += 1; }
        }
    }
    assert!(savings > 100, "{savings} calls had a smaller answer");
}

#[test]
fn unpinned_pose_under_movieclip_uses_the_same_selected_and_ancestor_geometry() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/ik-movieclip-parent-sheet.reference.json");
    let reference = parse(&std::fs::read_to_string(path).unwrap());
    let steps: Vec<Value> = reference.get("steps").unwrap().elements().unwrap().iter().collect();
    let mut checked_poses = 0;
    for compact in [false, true] {
        let mut session = session_from_recorded_state(&reference, steps[0].get("state").unwrap());
        let mut expected = steps[0].get("document").unwrap().as_str().unwrap().to_string();
        for step in &steps[1..] {
            let call: Vec<Value> = step.get("call").unwrap().elements().unwrap().iter().collect();
            let method = call[0].as_str().unwrap().trim_start_matches('@');
            if method == "poseJoint" {
                let (prepared, frame, full) = session.editor.evaluate().unwrap();
                let slot = frame.objects.iter().position(|object| object.uid == 2).unwrap();
                let parent = frame.objects[slot].join.unwrap().slot as usize;
                let figure = prepared.doc.figure(frame.objects[parent].figure).unwrap();
                assert!(figure.movieclip.is_some(), "the recorded ancestor is a movieclip");
                assert!(crate::ik::assembly_of(&prepared, &frame, slot).is_none(), "this pose takes the non-assembled bake_unpinned path");
                let controller = frame.objects[slot].ik.as_ref().unwrap().get(22).unwrap();
                assert!(controller.enabled && !controller.pinned);
                let small = styk_eval::geometry::build_only(&prepared.doc, &frame, &[slot]);
                for included in [parent, slot] {
                    let before = &full.objects[included];
                    let after = &small.objects[included];
                    assert!(before.resolved && after.resolved);
                    // Point-buffer offsets of unrelated objects are deliberately absent
                    // from this comparison; bake_unpinned consumes the selected root.
                    assert_eq!(before.root.map(f64::to_bits), after.root.map(f64::to_bits));
                    assert_eq!(format!("{:?}", (&before.starts, &before.ends, &before.lengths, &before.spatial, &before.rig)),
                        format!("{:?}", (&after.starts, &after.ends, &after.lengths, &after.spatial, &after.rig)));
                }
                checked_poses += 1;
            }
            let mut view = session.editor.state_value().as_obj().unwrap().clone();
            view.set("autoKey", Value::Bool(session.editor.options.auto_key));
            view.set("changesOnly", Value::Bool(compact));
            let answer = parse(&session.call(method, &json(&Value::array(call[1..].to_vec())), &json(&Value::object(view))));
            let label = format!("movieclip ancestor step {}, compact={compact}", step.get("step").unwrap());
            assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"), "{label}");
            assert_eq!(answer.get("state"), step.get("state"), "{label}: state");
            assert_eq!(answer.get("events"), step.get("events"), "{label}: events");
            if let Some(document) = step.get("document").and_then(Value::as_str) { expected = document.to_string(); }
            assert_eq!(session.editor.report_json(), expected, "{label}: document");
        }
    }
    assert_eq!(checked_poses, 6);
}

#[test]
fn refused_and_invalid_calls_send_no_replacements_and_preserve_the_live_gesture() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/move-sheet.reference.json");
    let reference = styk_doc::json::parse(&std::fs::read(path).unwrap()).unwrap();
    let first = reference.get("steps").unwrap().item(0).unwrap();
    let mut state = first.get("state").unwrap().as_obj().unwrap().clone();
    for (key, value) in reference.get("editor").unwrap().as_obj().unwrap().iter() { state.set(key, value.clone()); }
    let mut session = Session::start(parse(first.get("document").unwrap().as_str().unwrap()), &json(&Value::object(state))).unwrap();
    assert_eq!(parse(&session.call("select", "[1,-1]", "null")).get("status").and_then(Value::as_str), Some("ok"));
    assert_eq!(parse(&session.call("beginDrag", "[\"Pose figure\"]", "null")).get("status").and_then(Value::as_str), Some("ok"));
    let before = json(session.editor.report());
    let before_state = session.editor.state_value();
    let before_drag = session.editor.drag_value();
    let mut view = before_state.as_obj().unwrap().clone(); view.set("changesOnly", Value::Bool(true));
    for (method, args, status) in [("moveSelection", "[null,1]", "error"), ("noSuchEditingCommand", "[]", "unported")] {
        let answer = parse(&session.call(method, args, &json(&Value::object(view.clone()))));
        assert_eq!(answer.get("status").and_then(Value::as_str), Some(status));
        assert_eq!(answer.get("draft").and_then(Value::array_len), Some(0), "{method}: no replaced figures");
        assert_eq!(answer.get("state"), Some(&before_state), "{method}: state");
        assert_eq!(answer.get("drag"), Some(&before_drag), "{method}: drag");
        assert_eq!(answer.get("events").and_then(Value::array_len), Some(0), "{method}: no events");
        assert_eq!(json(session.editor.report()), before, "{method}: document");
    }
    let answer = parse(&session.call("commitDrag", "[]", &json(&Value::object(view))));
    assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"));
    assert_eq!(answer.get("result"), Some(&Value::Bool(false)));
    assert_eq!(answer.get("draft"), Some(&Value::Null));
    assert_eq!(answer.get("drag"), Some(&Value::Null));
    assert_eq!(json(session.editor.report()), before);
}

#[test]
fn worker_values_and_legacy_json_share_recorded_editor_outcomes() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    let mut calls = 0;
    for name in ["move-native", "drag-cancel", "range-native", "gestures-sheet",
        "layers-sheet", "figures-layers-sheet", "locked-sheet",
        "figure-clipboard-sheet", "figure-clipboard-clip-sheet",
        "property-clip-patches-sheet", "topology-sheet", "topology-native",
        "vfx-clip-paints-native", "vfx-clip-paints-sheet"] {
        let reference = parse(&std::fs::read_to_string(folder.join(format!("{name}.reference.json"))).unwrap());
        let steps: Vec<Value> = reference.get("steps").unwrap().elements().unwrap().iter().collect();
        for compact in [false, true] {
            let mut state = steps[0].get("state").unwrap().as_obj().unwrap().clone();
            for (key, value) in reference.get("editor").unwrap().as_obj().unwrap().iter() { state.set(key, value.clone()); }
            let initial = parse(steps[0].get("document").unwrap().as_str().unwrap());
            let mut legacy = Session::start(initial.clone(), &json(&Value::object(state.clone()))).unwrap();
            let mut worker = Session::start(initial, &json(&Value::object(state))).unwrap();
            let mut expected = steps[0].get("document").unwrap().as_str().unwrap().to_string();
            for step in &steps[1..] {
                let call: Vec<Value> = step.get("call").unwrap().elements().unwrap().iter().collect();
                let method = call[0].as_str().unwrap().trim_start_matches('@');
                let mut view = legacy.editor.state_value().as_obj().unwrap().clone();
                view.set("autoKey", Value::Bool(legacy.editor.options.auto_key));
                view.set("draws", step.get("draws").cloned().unwrap_or(Value::Null));
                if compact { view.set("changesOnly", Value::Bool(true)); }
                let view = Value::object(view);let args = Value::array(call[1..].to_vec());
                let old = legacy.call(method, &json(&args), &json(&view));
                let answer = worker.call_values(method, &args, &view);
                let label = format!("{name}/{} {method}, compact={compact}", step.get("step").unwrap());
                assert_eq!(json(&answer), old, "{label}: wire bytes");
                assert_ne!(answer.get("status").and_then(Value::as_str), Some("unported"), "{label}");
                assert_eq!(answer.get("state"), step.get("state"), "{label}: editor state");
                assert_eq!(answer.get("events"), step.get("events"), "{label}: editor events");
                if let Some(document) = step.get("document").and_then(Value::as_str) { expected = document.to_string(); }
                assert_eq!(worker.editor.report_json(), expected, "{label}: editor document");
                assert_eq!(legacy.editor.report_json(), worker.editor.report_json(), "{label}: owner");
                calls += 1;
            }
        }
    }
    assert!(calls > 200);
}

#[test]
fn malformed_json_wrapper_does_not_mutate_the_canonical_owner() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/move-sheet.reference.json");
    let reference = parse(&std::fs::read_to_string(path).unwrap());
    let first = reference.get("steps").unwrap().item(0).unwrap();
    let mut session = Session::start(parse(first.get("document").unwrap().as_str().unwrap()), &json(first.get("state").unwrap())).unwrap();
    let report = session.editor.report().clone();let state = session.editor.state_value();
    for (args, view) in [("[", "null"), ("[]", "{"), ("[", "{")] {
        let answer = parse(&session.call("noSuchEditingCommand", args, view));
        assert_eq!(json(&answer), "{\"status\":\"error\",\"error\":\"the call's arguments are not JSON\"}");
        assert!(report.same_node(session.editor.report()));assert_eq!(session.editor.state_value(), state);
        assert!(session.editor.take_events().is_empty());
    }
}

#[test]
fn quiet_worker_session_prepares_the_same_owner_and_keeps_retired_heads() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/move-native.reference.json");
    let reference = parse(&std::fs::read_to_string(path).unwrap());
    let first = reference.get("steps").unwrap().item(0).unwrap();
    let mut session = Session::start(parse(first.get("document").unwrap().as_str().unwrap()), &json(first.get("state").unwrap())).unwrap();
    let before = session.report().clone();
    assert!(matches!(session.prepare_worker_call_values("setFPS", &parse("[31]"), &Value::Null, || Ok(())), Err(EditError::Unported(_))));
    assert!(session.report().same_node(&before));
    session.prepare_worker_history(crate::HistoryLimits::default(), 0.0, || Ok(())).unwrap();
    let state = session.editor.state_value();
    let ready = session.prepare_worker_call_values("setFPS", &parse("[31]"), &Value::Null, || Ok(())).unwrap();
    assert_eq!(ready.result().get("status").and_then(Value::as_str), Some("ok"));
    assert_eq!(ready.result().path(&["state", "undoLabel"]).and_then(Value::as_str), Some("Change frame rate"));
    assert_eq!(ready.result().get("events").and_then(Value::array_len), Some(1));
    assert!(session.report().same_node(&before));assert_eq!(session.editor.state_value(), state);
    let after = ready.report().clone();
    let guard = session.guard_worker_publication_checked(ready, || Ok(())).unwrap_or_else(|(error, _)| panic!("{error:?}"));
    let retired = guard.commit();
    assert!(retired.previous_report().same_node(&before));assert!(session.report().same_node(&after));
    drop(retired);
    let undo = session.prepare_worker_call_values("undo", &parse("[]"), &Value::Null, || Ok(())).unwrap();
    assert_eq!(undo.result().get("status").and_then(Value::as_str), Some("ok"));
    let guard = session.guard_worker_publication_checked(undo, || Ok(())).unwrap_or_else(|(error, _)| panic!("{error:?}"));
    drop(guard.commit());assert_eq!(json(session.report()), json(&before));
}

#[test]
fn worker_session_preserves_cancellation_stale_views_and_quiet_refusals() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/move-native.reference.json");
    let reference = parse(&std::fs::read_to_string(path).unwrap());
    let first = reference.get("steps").unwrap().item(0).unwrap();
    let mut session = Session::start(parse(first.get("document").unwrap().as_str().unwrap()), &json(first.get("state").unwrap())).unwrap();
    session.prepare_worker_history(crate::HistoryLimits::default(), 0.0, || Ok(())).unwrap();
    let before = session.report().clone();let state = session.editor.state_value();
    let mut checks = 0;
    let error = session.prepare_worker_call_values("setFPS", &parse("[31]"), &Value::Null, || {
        checks += 1;if checks == 3 { Err(EditError::Invalid("cancel after owner call".into())) } else { Ok(()) }
    });
    assert!(matches!(error, Err(EditError::Invalid(ref reason)) if reason == "cancel after owner call"));
    assert!(session.report().same_node(&before));assert_eq!(session.editor.state_value(), state);
    let ready = session.prepare_worker_call_values("setFPS", &parse("[31]"), &Value::Null, || Ok(())).unwrap();
    session.call_values("select", &parse("[2,-1]"), &Value::Null);
    let newer = session.editor.state_value();
    let rejected = match session.guard_worker_publication_checked(ready, || Ok(())) {
        Err((EditError::Invalid(_), ready)) => ready,
        Err((error, _)) => panic!("unexpected {error:?}"),
        Ok(_) => panic!("stale session view accepted"),
    };
    assert_eq!(session.editor.state_value(), newer);assert!(session.report().same_node(&before));drop(rejected);
    session.call_values("select", &parse("[1,-1]"), &Value::Null);
    session.call_values("beginDrag", &parse("[\"Live gesture\"]"), &Value::Null);
    let drag = session.editor.drag_value();
    assert!(matches!(session.prepare_worker_call_values("setFPS", &parse("[31]"), &Value::Null, || Ok(())), Err(EditError::Unported(_))));
    assert_eq!(session.editor.drag_value(), drag);
    session.call_values("cancelDrag", &parse("[]"), &Value::Null);
    assert!(session.editor.drag.is_none());
}

fn ik_capture_bits(capture: &crate::spatial_ik::Capture) -> String {
    let angles = |table: &std::collections::BTreeMap<u32, f64>| table.iter().map(|(&id, &angle)| (id, angle.to_bits())).collect::<Vec<_>>();
    let quaternions = |table: &std::collections::BTreeMap<u32, [f64; 4]>| table.iter().map(|(&id, q)| (id, q.map(f64::to_bits))).collect::<Vec<_>>();
    let reference = &capture.bend_reference;
    format!("{:?}", (
        capture.target.map(f64::to_bits), angles(&capture.followers),
        capture.joined_followers.as_ref().map(|parts| parts.iter().map(|(&id, followers)| (id, angles(followers))).collect::<Vec<_>>()),
        capture.bend_direction.to_bits(),
        ([reference.side, reference.angle, reference.axis, reference.ratio].map(f64::to_bits), reference.shape.as_ref().map(|shape| shape.iter().map(|n| n.to_bits()).collect::<Vec<_>>())),
        capture.spatial_followers.as_ref().map(quaternions),
        capture.joined_spatial_followers.as_ref().map(|parts| parts.iter().map(|(&id, followers)| (id, quaternions(followers))).collect::<Vec<_>>()),
        capture.spatial_target.as_ref().map(|target| (target.depth.to_bits(), target.pole.map(f64::to_bits), target.swivel.to_bits(), target.normals.map(|normals| normals.map(|n| n.map(f64::to_bits))))),
    ))
}

#[test]
fn same_call_ik_capture_matches_both_recorded_passes_and_refusal_order() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    let mut checked = 0;
    for name in ["ik-capture-double-2d-sheet", "ik-capture-double-spatial-sheet"] {
        let reference = parse(&std::fs::read_to_string(root.join(format!("{name}.reference.json"))).unwrap());
        let ordinary = crate::replay::replay(&reference).unwrap();
        assert!(ordinary.mismatches.is_empty() && ordinary.unported.is_none(), "{name}: {ordinary:?}");
        assert_eq!(ordinary.matched, 29);
        let steps: Vec<Value> = reference.get("steps").unwrap().elements().unwrap().iter().collect();
        for compact in [false, true] {
            let mut session = session_from_recorded_state(&reference, steps[0].get("state").unwrap());
            let mut expected = steps[0].get("document").unwrap().as_str().unwrap().to_string();
            for step in &steps[1..] {
                let call: Vec<Value> = step.get("call").unwrap().elements().unwrap().iter().collect();
                let method = call[0].as_str().unwrap();
                let label = format!("{name}/{} compact={compact}", step.get("step").unwrap());
                if method == "@frame" {
                    let frame = session.editor.shown_frame().unwrap();
                    let snapshot = Value::str(&json(&styk_eval::records::snapshot_pose_frame(&frame)));
                    assert_eq!(Some(&snapshot), step.get("result"), "{label}: visible pose");
                } else {
                    let before = session.editor.report().clone(); let drag = session.editor.drag_value();
                    let mut view = session.editor.state_value().as_obj().unwrap().clone();
                    view.set("autoKey", Value::Bool(session.editor.options.auto_key));
                    view.set("changesOnly", Value::Bool(compact));
                    view.set("draws", step.get("draws").cloned().unwrap_or(Value::Null));
                    let answer = session.call_values(method.trim_start_matches('@'), &Value::array(call[1..].to_vec()), &Value::object(view));
                    if let Some(error) = step.get("error").filter(|e| !e.is_null()) {
                        assert_eq!(answer.get("status").and_then(Value::as_str), Some("error"), "{label}");
                        assert_eq!(answer.get("error"), error.get("key"), "{label}: validation priority");
                        assert!(session.editor.report().same_node(&before), "{label}: refused report identity");
                        assert_eq!(session.editor.drag_value(), drag, "{label}: refused gesture");
                    } else {
                        assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"), "{label}: {answer:?}");
                        // The recorder and ordinary replay compare the same depth-4 view.
                        // Full document/state/events and visible frames remain exact below.
                        let returned = crate::replay::plain(answer.get("result").unwrap_or(&Value::Null), 4).unwrap_or(Value::Null);
                        assert_eq!(Some(&returned), step.get("result"), "{label}: recorded result");
                        if method == "setNodeIK" && answer.get("result") == Some(&Value::Bool(false)) {
                            assert!(session.editor.report().same_node(&before), "{label}: false result report identity");
                            assert_eq!(session.editor.drag_value(), drag, "{label}: false result gesture");
                        }
                    }
                    assert_eq!(answer.get("events"), step.get("events"), "{label}: events");
                }
                if let Some(document) = step.get("document").and_then(Value::as_str) { expected = document.to_string(); }
                assert_eq!(session.editor.report_json(), expected, "{label}: report/history data");
                assert_eq!(Some(&session.editor.state_value()), step.get("state"), "{label}: selection/clock/history");
                checked += 1;
            }
        }
    }
    assert_eq!(checked, 116);
}

#[test]
fn same_call_ik_capture_borrows_full_solutions_for_rig_spatial_and_joined_ancestors() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    let (mut compared, mut spatial, mut pinned, mut ancestor, mut retained_2d, mut retained_3d) = (0, 0, 0, 0, 0, 0);
    for name in ["ik-settings-sheet", "ik-settings-pinned-sheet", "ik-settings-spatial-sheet", "ik-settings-followers-sheet", "ik-settings-rig-sheet", "ik-unpinned-sheet", "ik-spatial-free-sheet", "ik-movieclip-parent-sheet"] {
        let reference = parse(&std::fs::read_to_string(root.join(format!("{name}.reference.json"))).unwrap());
        let steps: Vec<Value> = reference.get("steps").unwrap().elements().unwrap().iter().collect();
        let mut session = session_from_recorded_state(&reference, steps[0].get("state").unwrap());
        let mut expected = steps[0].get("document").unwrap().as_str().unwrap().to_string();
        for step in &steps[1..] {
            let call: Vec<Value> = step.get("call").unwrap().elements().unwrap().iter().collect();
            let method = call[0].as_str().unwrap().trim_start_matches('@');
            let label = format!("{name}/{} {method}", step.get("step").unwrap());
            let prior = session.editor.drag.as_ref().map(|drag| drag.ik_captures.iter().map(|(key, capture)| (key.clone(), ik_capture_bits(capture))).collect::<std::collections::BTreeMap<_, _>>()).unwrap_or_default();
            if matches!(method, "poseJoint" | "setNodeIK") && let Some((slot, object)) = session.editor.object().unwrap() {
                let (prepared, frame, scene) = session.editor.evaluate_only(Some(&[slot])).unwrap();
                let id = crate::record::uid(&object).unwrap();
                let at = frame.objects.iter().position(|o| o.uid == id).unwrap();
                let evaluated = &frame.objects[at];
                let figure = evaluated.figure_override.as_deref().or_else(|| prepared.doc.figure(evaluated.figure).map(|figure| &**figure)).unwrap();
                if let Some(segment) = figure.segments.get(session.editor.selection.joint as usize)
                    && let Some(controller) = styk_eval::ik::parse::table(object.get("_stykIK")).and_then(|table| table.get(segment.id).cloned())
                {
                    let solved = crate::ik::solve_frame(&prepared, &frame, &scene);
                    let mut keys = solved.keys().copied().collect::<Vec<_>>();keys.sort_unstable();
                    let ordinary = session.editor.capture_limb(slot, segment.id).unwrap();
                    let borrowed = session.editor.capture_limb_from(slot, segment.id, &prepared, &frame, &scene, &solved).unwrap();
                    assert_eq!(ik_capture_bits(&borrowed), ik_capture_bits(&ordinary), "{label}: complete capture numeric bits");
                    let mut after = solved.keys().copied().collect::<Vec<_>>();after.sort_unstable();assert_eq!(keys, after);
                    compared += 1;spatial += usize::from(borrowed.spatial_target.is_some());pinned += usize::from(controller.pinned && !solved.is_empty());
                    ancestor += usize::from(evaluated.join.is_some());
                }
            }
            let mut view = session.editor.state_value().as_obj().unwrap().clone();view.set("autoKey", Value::Bool(session.editor.options.auto_key));
            view.set("draws", step.get("draws").cloned().unwrap_or(Value::Null));
            let args = step.get("boundsArgs").cloned().unwrap_or_else(|| Value::array(call[1..].to_vec()));
            let answer = session.call_values(method, &args, &Value::object(view));
            assert_ne!(answer.get("status").and_then(Value::as_str), Some("unported"), "{label}: {answer:?}");
            if let Some(error) = step.get("error").filter(|e| !e.is_null()) {
                assert_eq!(answer.get("error"), error.get("key"), "{label}: error");
            } else { assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"), "{label}: {answer:?}"); }
            assert_eq!(answer.get("state"), step.get("state"), "{label}: state");assert_eq!(answer.get("events"), step.get("events"), "{label}: events");
            if let Some(document) = step.get("document").and_then(Value::as_str) { expected = document.to_string(); }
            assert_eq!(session.editor.report_json(), expected, "{label}: report");
            if method == "poseJoint" && let Some(drag) = &session.editor.drag {
                for (key, capture) in &drag.ik_captures {
                    if let Some(before) = prior.get(key) {
                        assert_eq!(&ik_capture_bits(capture), before, "{label}: stored gesture baseline is unchanged");
                        if capture.spatial_target.is_some() { retained_3d += 1; } else { retained_2d += 1; }
                    }
                }
            }
        }
    }
    assert!(compared >= 8 && spatial > 0 && pinned > 0 && ancestor > 0, "capture coverage: {compared}/{spatial}/{pinned}/{ancestor}");
    assert!(retained_2d > 0 && retained_3d > 0, "repeated capture lifecycle: 2D={retained_2d}, 3D={retained_3d}");
}

fn check_recorded_shape_angle(editor: &Editor, label: &str, counts: &mut [usize; 4]) {
    let Some(selected) = editor.selection.uid else { return };
    if editor.selection.joint < 0 { return; }
    let slot = editor.selection_frame().unwrap().iter().position(|object| crate::record::uid(object) == Some(selected));
    let (prepared, frame, scene) = editor.evaluate_only(slot.as_ref().map(std::slice::from_ref)).unwrap();
    let Some(slot) = frame.objects.iter().position(|object| object.uid == selected) else { return };
    let Some(geometry) = scene.objects.iter().find(|geometry| geometry.uid == selected && geometry.resolved) else { return };
    let object = &frame.objects[slot];
    let Some(figure) = object.figure_override.as_ref().or_else(|| prepared.doc.figure(object.figure)) else { return };
    let joint = editor.selection.joint as usize;
    if figure.segments.get(joint).is_none() { return; }
    let solved = crate::ik::solve_frame(&prepared, &frame, &scene);
    let old = crate::ik::displayed_angle(&prepared, &frame, &scene, &solved, slot, joint);
    let next = crate::ik::shape_angle(&prepared, &frame, &scene, slot, joint);
    assert_eq!(old.to_bits(), next.to_bits(), "{label}: selected shape angle bits");
    counts[0] += 1;
    counts[1] += usize::from(frame.objects.iter().any(|object| styk_eval::ik::has_pinned(object)));
    counts[2] += usize::from(styk_eval::ik::joined::components(&frame).iter().any(|slots| slots.len() > 1 && slots.contains(&slot)));
    counts[3] += usize::from(geometry.rig.is_some());
}

#[test]
fn selected_shape_angle_matches_recorded_pinned_joined_and_ordinary_states() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    let mut counts = [0usize; 4];
    let mut checked = 0usize;
    for name in ["startup-sheet", "rig-sheet", "gestures-sheet", "pinned-ik-sheet", "ik-followers-sheet", "ik-joined-sheet", "ik-joined-late-sheet", "ik-settings-rig-sheet", "ik-spatial-joined-free-sheet", "ik-movieclip-parent-sheet", "origin-pose-support-free-native", "origin-pose-support-free-sheet", "origin-pose-support-pinned-native", "origin-pose-support-pinned-sheet"] {
        let reference = parse(&std::fs::read_to_string(folder.join(format!("{name}.reference.json"))).unwrap());
        let steps: Vec<Value> = reference.get("steps").unwrap().elements().unwrap().iter().collect();
        let mut session = session_from_recorded_state(&reference, steps[0].get("state").unwrap());
        let mut expected = steps[0].get("document").unwrap().as_str().unwrap().to_string();
        check_recorded_shape_angle(&session.editor, &format!("{name}/0"), &mut counts);
        for step in &steps[1..] {
            let call: Vec<Value> = step.get("call").unwrap().elements().unwrap().iter().collect();
            let method = call[0].as_str().unwrap().trim_start_matches('@');
            let label = format!("{name}/{} {method}", step.get("step").unwrap());
            let args = step.get("boundsArgs").cloned().unwrap_or_else(|| Value::array(call[1..].to_vec()));
            let mut view = session.editor.state_value().as_obj().unwrap().clone();
            view.set("autoKey", Value::Bool(session.editor.options.auto_key));
            view.set("draws", step.get("draws").cloned().unwrap_or(Value::Null));
            let answer = session.call_values(method, &args, &Value::object(view));
            if let Some(error) = step.get("error").filter(|error| !error.is_null()) {
                assert_eq!(answer.get("error"), error.get("key"), "{label}: error priority");
            } else {
                assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"), "{label}: {answer:?}");
            }
            assert_eq!(answer.get("events"), step.get("events"), "{label}: events");
            if let Some(document) = step.get("document").and_then(Value::as_str) { expected = document.to_string(); }
            assert_eq!(session.editor.report_json(), expected, "{label}: complete document/history");
            assert_eq!(Some(&session.editor.state_value()), step.get("state"), "{label}: clock/selection/history");
            check_recorded_shape_angle(&session.editor, &label, &mut counts);
            checked += 1;
        }
    }
    assert_eq!(checked, 559);
    assert!(counts[0] > 20 && counts[1] > 0 && counts[2] > 0 && counts[3] > 0, "real state coverage: {counts:?}");
    eprintln!("SELECTED_ANGLE_RECORDED steps={checked} angles={} pinned={} joined={} rig={}", counts[0], counts[1], counts[2], counts[3]);
}

#[test]
fn selected_shape_angle_preserves_duplicate_uid_and_conflict_fallbacks() {
    // Existing Editor-built evaluation fixture: genuine competing pinned chains.
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../styk-eval/tests/fixtures/ik/conflict.json");
    let editor = Editor::new(parse(&std::fs::read_to_string(path).unwrap()), crate::Options::default());
    let (prepared, frame, _) = editor.evaluate().unwrap();
    let mut conflicts = 0usize;
    let mut compared = 0usize;
    for (slot, object) in frame.objects.iter().enumerate() {
        let Some(figure) = object.figure_override.as_ref().or_else(|| prepared.doc.figure(object.figure)) else { continue };
        let scene = styk_eval::geometry::build_only(&prepared.doc, &frame, &[slot]);
        let solved = crate::ik::solve_frame(&prepared, &frame, &scene);
        conflicts += solved.values().flat_map(|solved| &solved.solution.results).filter(|(_, outcome)| outcome.conflict).count();
        for index in 0..figure.segments.len() {
            assert_eq!(crate::ik::displayed_angle(&prepared, &frame, &scene, &solved, slot, index).to_bits(), crate::ik::shape_angle(&prepared, &frame, &scene, slot, index).to_bits(), "actual conflict slot{slot}/joint{index}");
            compared += 1;
        }
    }
    assert!(conflicts > 0 && compared > 0, "actual conflict coverage {conflicts}/{compared}");
    // Derived identity controls ONLY: preserve every source/angle/controller of a
    // real joined recording; alias one typed UID to expose global map semantics.
    // This is not represented as a new valid Editor document or new D15 tape.
    let reference = parse(&std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/ik-joined-sheet.reference.json")).unwrap());
    let steps: Vec<Value> = reference.get("steps").unwrap().elements().unwrap().iter().collect();
    let session = session_from_recorded_state(&reference, steps[0].get("state").unwrap());
    let (prepared, frame, scene) = session.editor.evaluate().unwrap();
    assert!(frame.objects.len() >= 2);
    let mut duplicate = 0usize;
    for aliased_slot in [0usize, frame.objects.len()-1] {
        let other = if aliased_slot == 0 { frame.objects.len()-1 } else { 0 };
        let mut aliased = frame.clone();
        let duplicate_uid = aliased.objects[aliased_slot].uid;
        std::sync::Arc::make_mut(&mut aliased.objects[other]).uid = duplicate_uid;
        let solved = crate::ik::solve_frame(&prepared, &aliased, &scene);
        let object = &aliased.objects[aliased_slot];
        let figure = object.figure_override.as_ref().or_else(|| prepared.doc.figure(object.figure)).unwrap();
        for index in 0..figure.segments.len() {
            assert_eq!(crate::ik::displayed_angle(&prepared, &aliased, &scene, &solved, aliased_slot, index).to_bits(), crate::ik::shape_angle(&prepared, &aliased, &scene, aliased_slot, index).to_bits(), "derived duplicate UID slot{aliased_slot}/joint{index}");
            duplicate += 1;
        }
    }
    assert!(duplicate > 0);
    eprintln!("SELECTED_ANGLE_EDGE conflicts={conflicts} compared={compared} duplicate={duplicate}");
}

/// The ordinary publication fields suffice; no report or history packet is added.
fn apply_unique_answer(mut report: Value, answer: &Value) -> Value {
    let sheet = reconstruct_sheet(&report, answer);
    report.make_obj().unwrap().get_mut("figure_types").unwrap().make_arr().unwrap()
        .extend(answer.get("definitions").unwrap().elements().unwrap().iter());
    let styk = report.make_obj().unwrap().get_mut("_styk").unwrap().make_obj().unwrap();
    if !styk.contains("frameSources") { styk.set("frameSources", Value::object(Obj::new())); }
    let sources = styk.get_mut("frameSources").unwrap().make_obj().unwrap();
    for (id, frame) in answer.get("sources").unwrap().as_obj().unwrap().iter() { sources.set(id, frame.clone()); }
    if let Some(layers) = answer.get("layers") { styk.set("layers", layers.clone()); }
    styk.set("layerSheet", sheet);
    report
}

#[test]
fn movieclip_unique_marker_keeps_recorded_answers_and_shallow_definition_ownership() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests");
    for compact in [false, true] {
        let mut markers = 0;
        for (path, last) in [("edit/clip-unique-sheet", 12), ("movieclip-timed-sheet-expansion/unique-imported", 3), ("movieclip-timed-sheet-expansion/unique-authored", 3)] {
            let reference = parse(&std::fs::read_to_string(folder.join(format!("{path}.reference.json"))).unwrap());
            let steps: Vec<Value> = reference.get("steps").unwrap().elements().unwrap().iter().collect();
            let mut ordinary = session_from_recorded_state(&reference, steps[0].get("state").unwrap());
            let mut requested = session_from_recorded_state(&reference, steps[0].get("state").unwrap());
            let initial = requested.editor.report_json();
            let mut expected = initial.clone();
            let mut returned = Vec::new();
            for step in &steps[1..=last] {
                let call: Vec<Value> = step.get("call").unwrap().elements().unwrap().iter().collect();
                let method = call[0].as_str().unwrap().trim_start_matches('@');
                let before = requested.report().clone();
                let generated = requested.editor.generated_sources.clone();
                let original = if method == "makeMovieclipUnique" { Some(requested.editor.selected_movieclip().unwrap().2) } else { None };
                let original_bytes = original.as_ref().map(json);
                let mut view = ordinary.editor.state_value().as_obj().unwrap().clone();
                view.set("autoKey", Value::Bool(ordinary.editor.auto_key));
                view.set("changesOnly", Value::Bool(compact));
                let args = Value::array(call[1..].to_vec());
                let complete = ordinary.call_values(method, &args, &Value::object(view.clone()));
                view.set("movieclipUniquePublication", Value::Bool(true));
                let mut answer = requested.call_values(method, &args, &Value::object(view));
                let label = format!("{path} step{} compact={compact}", step.get("step").unwrap());
                assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"), "{label}: {answer:?}");
                if let Some(original) = &original {
                    let marker = answer.get("movieclipUnique").unwrap().clone();
                    let index = before.get("figure_types").unwrap().array_len().unwrap();
                    assert_eq!(marker, parse(&format!(r#"{{"definitionIndex":{index}}}"#)));
                    let definitions = answer.get("definitions").unwrap().elements().unwrap();
                    assert_eq!(definitions.len(), 1);
                    let figure = definitions.get(0).unwrap();
                    assert!(figure.same_node(answer.get("result").unwrap()));
                    assert!(figure.same_node(&requested.report().get("figure_types").unwrap().item(index).unwrap()));
                    assert!(original.as_obj().unwrap().keys().eq(figure.as_obj().unwrap().keys()));
                    for (key, value) in original.as_obj().unwrap().iter().filter(|(key, _)| !matches!(key.as_ref(), "figure_type_id" | "name")) {
                        assert!(value.same_node(figure.get(key).unwrap()), "{label}: shallow child {key}");
                    }
                    let mut reconstructed = apply_unique_answer(before.clone(), &answer);
                    // Recording a new branch can discard old generated sources.
                    // Apply the existing cleanup result, not a deletion packet;
                    // source retirement itself remains covered by its owner tests.
                    let table = reconstructed.make_obj().unwrap().get_mut("_styk").unwrap().make_obj().unwrap().get_mut("frameSources").unwrap().make_obj().unwrap();
                    for id in generated.iter().filter(|id| !requested.editor.generated_sources.contains(id)) { table.remove(id); }
                    assert_eq!(json(&reconstructed), requested.editor.report_json(), "{label}: existing payload + original cleanup reconstruct stored bytes/order");
                    let events = answer.get("events").unwrap().elements().unwrap();
                    assert_eq!(events.len(), 5);
                    // Fractional playhead stays unchanged for the definition and
                    // sheet children, then the actual seek/select rounds it.
                    let previous_tick = steps[step.get("step").unwrap().as_f64().unwrap() as usize - 1].get("state").unwrap().get("tick").unwrap();
                    assert_eq!(events.get(0).unwrap().get("tick"), Some(previous_tick));
                    assert_eq!(events.get(1).unwrap().get("tick"), Some(previous_tick));
                    assert_eq!(events.get(2).unwrap().get("tick"), answer.get("state").unwrap().get("tick"));
                    for id in events.get(1).unwrap().get("sourceIds").unwrap().elements().unwrap().iter() {
                        let id = id.as_str().unwrap();
                        assert!(answer.get("sources").unwrap().get(id).unwrap().same_node(requested.report().path(&["_styk", "frameSources", id]).unwrap()));
                    }
                    assert_eq!(json(original), original_bytes.unwrap(), "{label}: original immutable definition");
                    returned.push((figure.clone(), json(&figure)));
                    answer.make_obj().unwrap().remove("movieclipUnique");
                    markers += 1;
                } else { assert!(answer.get("movieclipUnique").is_none()); }
                assert!(complete.get("movieclipUnique").is_none());
                assert_eq!(json(&answer), json(&complete), "{label}: opt-in changes only the marker");
                assert_eq!(json(answer.get("state").unwrap()), json(step.get("state").unwrap()), "{label}: recorded state");
                assert_eq!(json(answer.get("events").unwrap()), json(step.get("events").unwrap()), "{label}: recorded event order");
                if method != "seek" { assert_eq!(crate::replay::plain(answer.get("result").unwrap(), 4).unwrap_or(Value::Null), step.get("result").cloned().unwrap(), "{label}: result"); }
                if let Some(document) = step.get("document").and_then(Value::as_str) { expected = document.into(); }
                assert_eq!(requested.editor.report_json(), expected, "{label}: recorded document");
                assert_eq!(ordinary.editor.report_json(), expected);
            }
            // Timed expansion's later playback uses a different worker route.
            // Here the existing Unique batch alone is undone/redone/full-undone.
            if last == 3 {
                for method in ["undo", "redo", "undo"] {
                    let mut view = ordinary.editor.state_value().as_obj().unwrap().clone();
                    view.set("changesOnly", Value::Bool(compact));
                    let complete = ordinary.call_values(method, &parse("[]"), &Value::object(view.clone()));
                    view.set("movieclipUniquePublication", Value::Bool(true));
                    let answer = requested.call_values(method, &parse("[]"), &Value::object(view));
                    assert_eq!(json(&answer), json(&complete));
                    assert_eq!(requested.editor.report_json(), ordinary.editor.report_json());
                }
                assert_eq!(requested.editor.report_json(), initial, "{path}: full Unique undo");
            }
            for (figure, bytes) in returned { assert_eq!(json(&figure), bytes, "later history preserves returned shallow definition"); }
        }
        assert_eq!(markers, 4, "two ordinary and both fractional recorded Unique calls");
    }
}

#[test]
fn movieclip_unique_marker_reconstructs_zero_history_and_refuses_incomplete_certificates() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/movieclip-timed-sheet-expansion/unique-imported.reference.json");
    let reference = parse(&std::fs::read_to_string(path).unwrap());
    let state = reference.get("steps").unwrap().item(2).unwrap().get("state").unwrap().clone();
    for compact in [false, true] { for limit in [0, 80] {
        let mut ordinary = session_from_recorded_state(&reference, &state);
        let mut requested = session_from_recorded_state(&reference, &state);
        ordinary.editor.history_limits.count = limit;
        requested.editor.history_limits.count = limit;
        let before = requested.report().clone();
        let original = requested.editor.selected_movieclip().unwrap().2;
        let mut view = state.as_obj().unwrap().clone(); view.set("changesOnly", Value::Bool(compact));
        let complete = ordinary.call_values("makeMovieclipUnique", &parse("[]"), &Value::object(view.clone()));
        view.set("movieclipUniquePublication", Value::Bool(true));
        let mut answer = requested.call_values("makeMovieclipUnique", &parse("[]"), &Value::object(view));
        assert!(answer.get("movieclipUnique").is_some(), "marker is independent of undo tail at history={limit}");
        assert_eq!(json(&apply_unique_answer(before.clone(), &answer)), requested.editor.report_json());
        let events: Vec<Value> = answer.get("events").unwrap().elements().unwrap().iter().collect();
        let figure = answer.get("result").unwrap();
        let id = events[1].get("sourceIds").unwrap().item(0).unwrap();
        let mut incomplete = requested.report().clone();
        incomplete.make_obj().unwrap().get_mut("_styk").unwrap().make_obj().unwrap().get_mut("frameSources").unwrap().make_obj().unwrap().remove(id.as_str().unwrap());
        assert!(movieclip_unique_publication(&before, &original, &incomplete, figure, &events).is_none(), "missing intermediate source cannot certify adoption");
        let mut reordered = events.clone(); reordered.swap(2, 3);
        assert!(movieclip_unique_publication(&before, &original, requested.report(), figure, &reordered).is_none());
        let mut live = events.clone(); live[1].make_obj().unwrap().set("live", Value::Bool(true));
        assert!(movieclip_unique_publication(&before, &original, requested.report(), figure, &live).is_none());
        let mut deep_copy = requested.report().clone();
        let index = answer.get("movieclipUnique").unwrap().get("definitionIndex").unwrap().as_f64().unwrap() as usize;
        let mut altered = figure.as_obj().unwrap().clone();
        altered.set("_styk", parse(&json(figure.get("_styk").unwrap())));
        let altered = Value::object(altered);
        deep_copy.make_obj().unwrap().get_mut("figure_types").unwrap().make_arr().unwrap()[index] = altered.clone();
        assert!(movieclip_unique_publication(&before, &original, &deep_copy, &altered, &events).is_none(), "decoded deep children are not a shallow copy certificate");
        if limit == 0 {
            assert!(requested.editor.undo.is_empty());
            assert!(!requested.can_undo());
            let mut reconstructed = Editor::new(apply_unique_answer(before.clone(), &answer), requested.editor.options);
            reconstructed.generated_sources = requested.editor.generated_sources.clone();
            reconstructed.uid_counts = requested.editor.uid_counts.clone();
            reconstructed.source_table_was_present = requested.editor.source_table_was_present;
            reconstructed.prune_frame_sources();
            assert_eq!(reconstructed.report_json(), requested.editor.report_json(), "existing prune owner keeps every required source at zero history");
        } else {
            let crate::history::CommandKind::Batch { commands } = &requested.editor.undo.last().unwrap().kind else { panic!("Unique must remain one compound batch") };
            assert_eq!(commands.len(), 2);
            assert!(matches!(&commands[0].kind, crate::history::CommandKind::MovieclipDefinition { .. }));
            let crate::history::CommandKind::LayerSheet { sources, .. } = &commands[1].kind else { panic!("second child is the original sheet publication") };
            for (id, source) in sources { assert!(answer.get("sources").unwrap().get(id).unwrap().same_node(source)); }
            assert_eq!(commands[0].before_selection.tick, 2.25);
            assert_eq!(commands[1].before_selection.tick, 2.25);
        }
        answer.make_obj().unwrap().remove("movieclipUnique");
        assert_eq!(json(&answer), json(&complete));
        assert_eq!(requested.editor.state_value(), ordinary.editor.state_value());
    } }
}

#[test]
fn movieclip_unique_opt_in_preserves_errors_and_omits_the_certificate_on_native_timelines() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests");
    for (path, state_index, status) in [("edit/clip-unique-legacy-native", 1, "ok"), ("movieclip-timed-sheet-expansion/expansion-locked", 1, "error")] {
        let reference = parse(&std::fs::read_to_string(folder.join(format!("{path}.reference.json"))).unwrap());
        let state = reference.get("steps").unwrap().item(state_index).unwrap().get("state").unwrap().clone();
        let mut ordinary = session_from_recorded_state(&reference, &state);
        let mut requested = session_from_recorded_state(&reference, &state);
        let complete = ordinary.call_values("makeMovieclipUnique", &parse("[]"), &state);
        let mut view = state.as_obj().unwrap().clone(); view.set("movieclipUniquePublication", Value::Bool(true));
        let answer = requested.call_values("makeMovieclipUnique", &parse("[]"), &Value::object(view));
        assert_eq!(answer.get("status").and_then(Value::as_str), Some(status));
        assert!(answer.get("movieclipUnique").is_none());
        assert_eq!(json(&answer), json(&complete));
        assert_eq!(requested.editor.report_json(), ordinary.editor.report_json());
        let recorded = reference.get("steps").unwrap().item(2).unwrap();
        // A native timeline has no sheet to certify: the command runs as the editor ran it.
        if status == "ok" { assert_eq!(requested.editor.report_json(), recorded.get("document").unwrap().as_str().unwrap()); }
        else { assert_eq!(answer.get("error").and_then(Value::as_str), Some("errors.editorLayerSheet.unlockBeforeEditingIt")); }
        assert_eq!(json(answer.get("state").unwrap()), json(recorded.get("state").unwrap()));
        assert_eq!(json(answer.get("events").unwrap()), json(recorded.get("events").unwrap()));
    }
    let reference = parse(&std::fs::read_to_string(folder.join("edit/clip-unique-sheet.reference.json")).unwrap());
    let state = reference.get("steps").unwrap().item(2).unwrap().get("state").unwrap().clone();
    for flag in [Value::Bool(false), Value::Num(1.0)] {
        let mut ordinary = session_from_recorded_state(&reference, &state);
        let mut requested = session_from_recorded_state(&reference, &state);
        let complete = ordinary.call_values("makeMovieclipUnique", &parse("[]"), &state);
        let mut view = state.as_obj().unwrap().clone(); view.set("movieclipUniquePublication", flag);
        let answer = requested.call_values("makeMovieclipUnique", &parse("[]"), &Value::object(view));
        assert!(answer.get("movieclipUnique").is_none());
        assert_eq!(json(&answer), json(&complete), "only literal true requests the additive wire");
    }
}

fn layer_packet_updates(packet: &Value) -> Vec<crate::layers::Update> {
    packet.get("updates").unwrap().elements().unwrap().iter().map(|update| {
        let path = update.get("path").unwrap().elements().unwrap().iter().map(|key| key.as_str().unwrap().to_string()).collect();
        (path, update.get("value").cloned(), update.get("remove") == Some(&Value::Bool(true)))
    }).collect()
}

#[test]
fn folder_publication_preserves_recorded_answers_and_original_layer_history() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/layers-folders-sheet.reference.json");
    let reference = parse(&std::fs::read_to_string(path).unwrap());
    let steps: Vec<Value> = reference.get("steps").unwrap().elements().unwrap().iter().collect();
    for compact in [false, true] {
        let mut ordinary = session_from_recorded_state(&reference, steps[0].get("state").unwrap());
        let mut requested = session_from_recorded_state(&reference, steps[0].get("state").unwrap());
        let mut expected = ordinary.editor.report_json();
        let mut packets = Vec::new();
        let mut methods = HashSet::new();
        for step in &steps[1..] {
            let call: Vec<Value> = step.get("call").unwrap().elements().unwrap().iter().collect();
            let method = call[0].as_str().unwrap();
            let before = requested.editor.snapshot();
            let mut view = ordinary.editor.state_value().as_obj().unwrap().clone();
            view.set("changesOnly", Value::Bool(compact));
            let args = Value::array(call[1..].to_vec());
            let complete = ordinary.call_values(method, &args, &Value::object(view.clone()));
            if matches!(method, "createLayerFolder" | "renameLayerFolder" | "moveLayersToFolder" | "arrangeLayers" | "deleteLayerFolder") { view.set("layerPublication", Value::Bool(true)); }
            let mut answer = requested.call_values(method, &args, &Value::object(view));
            let label = format!("folder step{} compact={compact}", step.get("step").unwrap());
            if let Some(packet) = answer.get("layerPublication").cloned() {
                assert!(matches!(method, "createLayerFolder" | "renameLayerFolder" | "moveLayersToFolder" | "arrangeLayers" | "deleteLayerFolder"));
                methods.insert(method.to_string());
                let events = answer.get("events").unwrap();
                let event = events.item(0).unwrap();
                assert_eq!(events.array_len(), Some(1));
                assert_eq!(event.get("timing"), Some(&Value::Bool(false)));
                assert!(event.get("layerSheet").is_none());
                assert_eq!(packet.get("label"), event.get("label"));
                assert_eq!(packet.get("structural"), event.get("structural"));
                let after = requested.editor.snapshot();
                let stored = requested.editor.report_json();
                let state = requested.editor.state_value();
                let history = requested.editor.history_value();
                // Reconstruct with the original _layerEdit owner, not a report
                // diff or undo-tail extraction. Preserve all prior history.
                requested.editor.restore(before);
                assert!(requested.editor.layer_edit(packet.get("label").unwrap().as_str().unwrap(), layer_packet_updates(&packet), packet.get("structural") == Some(&Value::Bool(true)), None).unwrap());
                assert_eq!(requested.editor.report_json(), stored, "{label}: sheet tracks/order/unknown stored fields");
                assert_eq!(requested.editor.state_value(), state, "{label}: selection/revisions");
                assert_eq!(requested.editor.history_value(), history, "{label}: one original Layers entry");
                assert_eq!(Value::array(requested.editor.take_events()), events.clone(), "{label}: original edit event");
                let crate::history::CommandKind::Layers { timing, migration, .. } = &requested.editor.undo.last().unwrap().kind else { panic!("folder edit must be one Layers leaf") };
                assert!(*timing, "stored command owns its sheet track-head patch");
                assert!(migration.is_none());
                requested.editor.restore(after);
                packets.push((packet.clone(), json(&packet)));
                answer.make_obj().unwrap().remove("layerPublication");
            } else if matches!(method, "createLayerFolder" | "renameLayerFolder" | "moveLayersToFolder" | "arrangeLayers" | "deleteLayerFolder") && complete.get("status").and_then(Value::as_str) == Some("ok") && complete.get("result").is_some_and(Value::truthy) {
                panic!("{label}: successful folder call omitted its accepted operands");
            }
            assert!(complete.get("layerPublication").is_none());
            assert_eq!(json(&answer), json(&complete), "{label}: default answer bytes");
            assert_eq!(json(answer.get("state").unwrap()), json(step.get("state").unwrap()), "{label}: recorded state");
            assert_eq!(json(answer.get("events").unwrap()), json(step.get("events").unwrap()), "{label}: recorded event order");
            if let Some(error) = step.get("error").filter(|error| !error.is_null()) { assert_eq!(answer.get("error"), error.get("key")); }
            else { assert_eq!(crate::replay::plain(answer.get("result").unwrap(), 4).unwrap_or(Value::Null), step.get("result").cloned().unwrap()); }
            if let Some(document) = step.get("document").and_then(Value::as_str) { expected = document.into(); }
            assert_eq!(requested.editor.report_json(), expected, "{label}: recorded document");
            assert_eq!(ordinary.editor.report_json(), expected);
        }
        assert_eq!(methods.len(), 5);
        assert_eq!(packets.len(), 10);
        for (packet, bytes) in packets { assert_eq!(json(&packet), bytes, "later undo/redo preserves returned immutable operands"); }
    }
}

#[test]
fn folder_publication_keeps_null_removals_absence_noops_and_zero_history() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/layers-folders-sheet.reference.json");
    let reference = parse(&std::fs::read_to_string(path).unwrap());
    let initial = reference.get("steps").unwrap().item(0).unwrap().get("state").unwrap().clone();
    for compact in [false, true] {
        let mut ordinary = session_from_recorded_state(&reference, &initial);
        let mut requested = session_from_recorded_state(&reference, &initial);
        for session in [&mut ordinary, &mut requested] {
            session.editor.history_limits.count = 0;
            let layers = session.editor.report.make_obj().unwrap().get_mut("_styk").unwrap().make_obj().unwrap().get_mut("layers").unwrap().make_obj().unwrap();
            layers.set("unknownFolderMetadata", parse(r#"{"preserve":[null,3]}"#));
        }
        let mut captured = Vec::new();
        for (method, args, packet_count) in [
            ("createLayerFolder", r#"["Group",[]]"#, Some(1)),
            ("renameLayerFolder", r#"["folder-1","Group"]"#, None),
            ("moveLayersToFolder", r#"[["layer-1"],null]"#, Some(1)),
            ("arrangeLayers", r#"[["layer-1","layer-2"],["layer-1"]]"#, None),
            ("arrangeLayers", r#"[["layer-1","layer-2"],["layer-1"],null]"#, Some(1)),
            ("deleteLayerFolder", r#"["folder-1"]"#, Some(1)),
            ("renameLayerFolder", r#"["folder-1","Missing"]"#, None),
        ] {
            let old_report = requested.report().clone();
            let before = requested.editor.snapshot();
            let mut view = ordinary.editor.state_value().as_obj().unwrap().clone(); view.set("changesOnly", Value::Bool(compact));
            let complete = ordinary.call_values(method, &parse(args), &Value::object(view.clone()));
            view.set("layerPublication", Value::Bool(true));
            let mut answer = requested.call_values(method, &parse(args), &Value::object(view));
            if let Some(count) = packet_count {
                let packet = answer.get("layerPublication").unwrap().clone();
                let updates = packet.get("updates").unwrap(); assert_eq!(updates.array_len(), Some(count));
                let update = updates.item(0).unwrap();
                if method == "createLayerFolder" {
                    assert_eq!(update.get("path"), Some(&parse(r#"["folders"]"#)), "absent folders are created as one head");
                    assert_eq!(answer.get("result"), Some(&parse(r#"{"id":"folder-1","kind":"folder","name":"Group"}"#)));
                } else if method == "deleteLayerFolder" {
                    assert_eq!(update.get("remove"), Some(&Value::Bool(true)));
                    assert!(update.get("value").is_none(), "undefined removal is omitted");
                } else {
                    assert_eq!(update.get("path"), Some(&parse(r#"["byId","layer-1","folderId"]"#)));
                    assert_eq!(update.get("remove"), Some(&Value::Bool(true)));
                    assert_eq!(update.get("value"), Some(&Value::Null), "absent-to-absent null still records");
                }
                assert!(requested.editor.undo.is_empty(), "packet cannot depend on the trimmed undo tail");
                let after = requested.editor.snapshot();
                requested.editor.restore(before);
                assert!(requested.editor.layer_edit(packet.get("label").unwrap().as_str().unwrap(), layer_packet_updates(&packet), packet.get("structural") == Some(&Value::Bool(true)), None).unwrap());
                assert_eq!(requested.editor.report_json(), ordinary.editor.report_json());
                assert_eq!(requested.editor.state_value(), ordinary.editor.state_value());
                assert_eq!(Value::array(requested.editor.take_events()), answer.get("events").unwrap().clone());
                requested.editor.restore(after);
                captured.push((packet.clone(), json(&packet)));
                answer.make_obj().unwrap().remove("layerPublication");
            } else {
                assert!(answer.get("layerPublication").is_none());
                assert_eq!(answer.get("events").unwrap().array_len(), Some(0));
                assert_eq!(json(requested.report()), json(&old_report), "no-op/error preserves stored bytes");
            }
            assert_eq!(json(&answer), json(&complete));
            assert_eq!(requested.report().path(&["_styk", "layers", "unknownFolderMetadata"]), Some(&parse(r#"{"preserve":[null,3]}"#)));
        }
        for (packet, bytes) in captured { assert_eq!(json(&packet), bytes); }
    }
}

#[test]
fn folder_publication_is_literal_opt_in_and_keeps_quiet_sheet_admission() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/layers-folders-sheet.reference.json");
    let reference = parse(&std::fs::read_to_string(path).unwrap());
    let initial = reference.get("steps").unwrap().item(0).unwrap().get("state").unwrap().clone();
    for context in ["false", "number", "native", "source", "frameDraft", "origin", "drag", "batch", "otherMethod"] {
        let mut ordinary = session_from_recorded_state(&reference, &initial);
        let mut requested = session_from_recorded_state(&reference, &initial);
        for session in [&mut ordinary, &mut requested] {
            match context {
                "native" => { session.editor.report.make_obj().unwrap().get_mut("_styk").unwrap().make_obj().unwrap().remove("layerSheet"); }
                "source" => { session.editor.report.make_obj().unwrap().get_mut("_styk").unwrap().make_obj().unwrap().set("movieclipSource", parse("{}")); }
                "frameDraft" => { session.editor.report.make_obj().unwrap().get_mut("_styk").unwrap().make_obj().unwrap().set("simpleFrameDraft", parse("{}")); }
                "origin" => { let figure = &mut session.editor.report.make_obj().unwrap().get_mut("figure_types").unwrap().make_arr().unwrap()[0]; figure.make_obj().unwrap().set("_styk", parse(r#"{"animationOrigin":{}}"#)); }
                "drag" => { session.editor.call("beginDrag", &parse(r#"["Existing gesture"]"#).elements().unwrap().iter().collect::<Vec<_>>()).unwrap(); session.editor.take_events(); }
                "batch" => { session.editor.call("beginBatch", &parse(r#"["Existing batch"]"#).elements().unwrap().iter().collect::<Vec<_>>()).unwrap(); session.editor.take_events(); }
                _ => {}
            }
        }
        let mut view = ordinary.editor.state_value().as_obj().unwrap().clone();
        let method = if context == "otherMethod" { "setFPS" } else { "createLayerFolder" };
        let args = if context == "otherMethod" { parse("[30]") } else { parse(r#"["Name",[]]"#) };
        let complete = ordinary.call_values(method, &args, &Value::object(view.clone()));
        view.set("layerPublication", match context { "false" => Value::Bool(false), "number" => Value::Num(1.0), _ => Value::Bool(true) });
        let answer = requested.call_values(method, &args, &Value::object(view));
        assert!(answer.get("layerPublication").is_none(), "{context}: no new admission");
        assert_eq!(json(&answer), json(&complete), "{context}: original status/result/state/events");
        assert_eq!(requested.editor.report_json(), ordinary.editor.report_json());
    }
}

#[test]
fn figure_clipboard_pastes_consumes_recorded_counters_and_preserves_default_answers() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/figure-clipboard-pastes-sheet.reference.json");
    let reference = parse(&std::fs::read_to_string(path).unwrap());
    let steps: Vec<Value> = reference.get("steps").unwrap().elements().unwrap().iter().collect();
    assert_eq!(steps.len(), 34);
    for compact in [false, true] {
        let mut ordinary = session_from_recorded_state(&reference, steps[0].get("state").unwrap());
        let mut requested = session_from_recorded_state(&reference, steps[0].get("state").unwrap());
        let mut expected = ordinary.editor.report_json();
        let mut certificates = Vec::new();
        let mut errors = 0;
        for step in &steps[1..] {
            let call: Vec<Value> = step.get("call").unwrap().elements().unwrap().iter().collect();
            let method = call[0].as_str().unwrap();
            let observation = step.get("figureClipboardPastes").unwrap();
            let before = requested.editor.figure_clipboard_pastes().map_or(Value::Null, Value::Num);
            assert_eq!(Some(&before), observation.get("before"), "step{}: authoritative pre-call count", step.get("step").unwrap());
            let clipboard = requested.editor.figure_clipboard.clone();
            let mut view = ordinary.editor.state_value().as_obj().unwrap().clone();
            view.set("changesOnly", Value::Bool(compact));
            let args = Value::array(call[1..].to_vec());
            let complete = ordinary.call_values(method, &args, &Value::object(view.clone()));
            view.set("figureClipboardPastes", Value::Bool(true));
            let mut answer = requested.call_values(method, &args, &Value::object(view));
            let label = format!("clipboard step{} compact={compact}", step.get("step").unwrap());
            let after = requested.editor.figure_clipboard_pastes().map_or(Value::Null, Value::Num);
            assert_eq!(Some(&after), observation.get("after"), "{label}: authoritative post-call count");
            assert_eq!(ordinary.editor.figure_clipboard_pastes(), requested.editor.figure_clipboard_pastes());
            let ok = answer.get("status").and_then(Value::as_str) == Some("ok");
            if matches!(method, "pasteSelection" | "duplicateSelection") && ok {
                let certificate = answer.get("figureClipboardPastes").unwrap().clone();
                if method == "duplicateSelection" {
                    let expected = match step.get("step").and_then(Value::as_f64).unwrap() as usize {
                        11 => parse(r#"{"before":0,"after":1}"#),
                        12 => parse(r#"{"before":0,"after":0}"#),
                        23 => Value::Null,
                        _ => panic!("unexpected recorded duplicate"),
                    };
                    assert_eq!(certificate, expected, "{label}: actual temporary counter before saved-clipboard restoration");
                } else if before.is_null() {
                    assert_eq!(certificate, Value::Null);
                    if !compact { assert_eq!(answer.get("result"), Some(&parse("[]")), "unrelated selection is not a paste result"); }
                } else {
                    assert_eq!(certificate.get("before"), Some(&before));
                    assert_eq!(certificate.get("after"), Some(&after));
                }
                certificates.push((certificate.clone(), json(&certificate)));
                answer.make_obj().unwrap().remove("figureClipboardPastes");
            } else {
                assert!(answer.get("figureClipboardPastes").is_none(), "{label}: no certificate for other calls/errors");
                if method == "pasteSelection" { errors += 1; }
            }
            // These are the actual JS event observations. Native paste increments
            // only after paste_figures returns; duplicate's events use its fresh
            // temporary clipboard, and cut installs its new clipboard first.
            let event_counts = observation.get("events").unwrap().elements().unwrap();
            assert_eq!(event_counts.len(), answer.get("events").unwrap().array_len().unwrap(), "{label}: every recorded event observed");
            let during = match method { "pasteSelection" => before.clone(), "duplicateSelection" => Value::Num(0.0), _ => after.clone() };
            for count in event_counts.iter() { assert_eq!(count, during, "{label}: original counter/event ordering"); }
            assert!(matches!(observation.get("sameClipboard"), Some(Value::Bool(_))));
            if method == "duplicateSelection" {
                assert_eq!(observation.get("sameClipboard"), Some(&Value::Bool(true)));
                assert_eq!(requested.editor.figure_clipboard, clipboard, "{label}: duplicate restores the complete saved clipboard");
            }
            assert!(complete.get("figureClipboardPastes").is_none());
            assert_eq!(json(&answer), json(&complete), "{label}: default full/compact answer bytes");
            assert_eq!(json(answer.get("state").unwrap()), json(step.get("state").unwrap()), "{label}: recorded state");
            assert_eq!(json(answer.get("events").unwrap()), json(step.get("events").unwrap()), "{label}: recorded events");
            if let Some(error) = step.get("error").filter(|error| !error.is_null()) {
                assert_eq!(answer.get("status").and_then(Value::as_str), Some("error"));
                assert_eq!(answer.get("error"), error.get("key"));
            } else {
                assert!(ok, "{label}: {answer:?}");
                if method != "@seek" && (!compact || !matches!(method, "pasteSelection" | "duplicateSelection")) {
                    // Session seek returns null; the facade reads the visible
                    // frame locally. Editor replay separately checks that view.
                    assert_eq!(crate::replay::plain(answer.get("result").unwrap(), 4).unwrap_or(Value::Null), step.get("result").cloned().unwrap(), "{label}: original result");
                }
            }
            if let Some(document) = step.get("document").and_then(Value::as_str) { expected = document.into(); }
            assert_eq!(requested.editor.report_json(), expected, "{label}: recorded document");
            assert_eq!(ordinary.editor.report_json(), expected);
        }
        assert_eq!(certificates.len(), 12, "nine pastes and three duplicate temporary owners");
        assert_eq!(errors, 3);
        for (certificate, bytes) in certificates { assert_eq!(json(&certificate), bytes, "later history preserves returned scalar pairs"); }
    }
}

#[test]
fn figure_clipboard_pastes_is_literal_opt_in_and_omits_unported_answers() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/figure-clipboard-pastes-sheet.reference.json");
    let reference = parse(&std::fs::read_to_string(path).unwrap());
    let steps: Vec<Value> = reference.get("steps").unwrap().elements().unwrap().iter().collect();
    for compact in [false, true] {
        for method in ["pasteSelection", "duplicateSelection"] {
            for flag in [Value::Bool(false), Value::Num(1.0), Value::str("true"), parse("{}"), Value::Null, Value::Bool(true)] {
                let mut ordinary = session_from_recorded_state(&reference, steps[0].get("state").unwrap());
                let mut requested = session_from_recorded_state(&reference, steps[0].get("state").unwrap());
                for step in &steps[1..4] {
                    let call: Vec<Value> = step.get("call").unwrap().elements().unwrap().iter().collect();
                    for session in [&mut ordinary, &mut requested] {
                        let view = session.editor.state_value();
                        assert_eq!(session.call_values(call[0].as_str().unwrap(), &Value::array(call[1..].to_vec()), &view).get("status").and_then(Value::as_str), Some("ok"));
                    }
                }
                let unported = flag == Value::Bool(true);
                if unported {
                    for session in [&mut ordinary, &mut requested] { session.editor.tick = 0.5; }
                }
                let mut view = ordinary.editor.state_value().as_obj().unwrap().clone();
                view.set("changesOnly", Value::Bool(compact));
                let complete = ordinary.call_values(method, &parse("[]"), &Value::object(view.clone()));
                view.set("figureClipboardPastes", flag);
                let answer = requested.call_values(method, &parse("[]"), &Value::object(view));
                assert!(answer.get("figureClipboardPastes").is_none(), "only literal true and successful paste/duplicate request the handoff");
                assert_eq!(json(&answer), json(&complete));
                assert_eq!(requested.editor.report_json(), ordinary.editor.report_json());
                assert_eq!(requested.editor.figure_clipboard, ordinary.editor.figure_clipboard);
                if unported {
                    assert_eq!(answer.get("status").and_then(Value::as_str), Some("unported"));
                    assert_eq!(answer.get("reason").and_then(Value::as_str), Some("pasting between frames"));
                }
            }
        }
    }
}


fn metadata_method(method: &str) -> bool {
    matches!(method, "renameLayer" | "setLayerColor" | "setLayerVisible" | "setLayerLocked" | "reorderLayers" | "moveLayerTo" | "createLayer" | "setLayerParallax")
}

#[test]
fn layer_metadata_publication_matches_all_75_recorded_calls_and_original_owner() {
    let mut methods = HashSet::new();
    let mut total = 0;
    for compact in [false, true] {
        let mut calls = 0;
        for name in ["layer-list-sheet", "layers-folders-sheet", "layers-native", "layer-parallax-sheet", "layer-parallax-camera-sheet"] {
            let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../tests/edit/{name}.reference.json"));
            let reference = parse(&std::fs::read_to_string(path).unwrap());
            let steps: Vec<Value> = reference.get("steps").unwrap().elements().unwrap().iter().collect();
            let mut ordinary = session_from_recorded_state(&reference, steps[0].get("state").unwrap());
            let mut requested = session_from_recorded_state(&reference, steps[0].get("state").unwrap());
            let mut expected = ordinary.editor.report_json();
            let mut packets = Vec::new();
            for (index, step) in steps.iter().enumerate().skip(1) {
                let call: Vec<Value> = step.get("call").unwrap().elements().unwrap().iter().collect();
                let method = call[0].as_str().unwrap();
                let before = requested.editor.snapshot();
                let quiet_sheet = requested.editor.sheet();
                let mut view = ordinary.editor.state_value().as_obj().unwrap().clone();
                view.set("changesOnly", Value::Bool(compact));
                let args = Value::array(call[1..].to_vec());
                let complete = ordinary.call_values(method, &args, &Value::object(view.clone()));
                if metadata_method(method) { view.set("layerPublication", Value::Bool(true)); }
                let mut answer = requested.call_values(method, &args, &Value::object(view));
                let label = format!("{name} step{index} compact={compact}");
                if let Some(packet) = answer.get("layerPublication").cloned() {
                    assert!(metadata_method(method), "{label}: only requested metadata methods capture");
                    methods.insert(method.to_string());
                    let events = answer.get("events").unwrap();
                    let event = events.item(0).unwrap();
                    assert_eq!(events.array_len(), Some(1));
                    assert_eq!(event.get("layerMetadata"), Some(&Value::Bool(true)));
                    assert_eq!(event.get("timing"), Some(&Value::Bool(false)));
                    assert_eq!(event.get("animation"), Some(&Value::Bool(false)));
                    assert!(event.get("layerSheet").is_none());
                    assert_eq!(packet.get("label"), event.get("label"));
                    assert_eq!(packet.get("structural"), event.get("structural"));
                    if method != "createLayer" { assert!(packet.get("activeId").is_none()); }
                    let after = requested.editor.snapshot();
                    let report = requested.editor.report_json();
                    let state = requested.editor.state_value();
                    let history = requested.editor.history_value();
                    requested.editor.restore(before);
                    assert!(requested.editor.layer_edit(packet.get("label").unwrap().as_str().unwrap(), layer_packet_updates(&packet),
                        packet.get("structural") == Some(&Value::Bool(true)), packet.get("activeId").and_then(Value::as_str).map(str::to_string)).unwrap());
                    assert_eq!(requested.editor.report_json(), report, "{label}: original stored order/presence");
                    assert_eq!(requested.editor.state_value(), state, "{label}: original revisions and selection");
                    assert_eq!(requested.editor.history_value(), history, "{label}: original single Layers record");
                    assert_eq!(Value::array(requested.editor.take_events()), events.clone(), "{label}: original event");
                    let crate::history::CommandKind::Layers { timing, migration, .. } = &requested.editor.undo.last().unwrap().kind else { panic!("{label}: Layers owner") };
                    assert!(*timing); assert!(migration.is_none());
                    requested.editor.restore(after);
                    packets.push((packet.clone(), json(&packet)));
                    answer.make_obj().unwrap().remove("layerPublication");
                } else if metadata_method(method) && quiet_sheet && complete.get("status").and_then(Value::as_str) == Some("ok") && complete.get("result").is_some_and(Value::truthy) {
                    panic!("{label}: successful quiet metadata call omitted its operands");
                }
                assert!(complete.get("layerPublication").is_none());
                assert_eq!(json(&answer), json(&complete), "{label}: full/default answer remains literal");
                assert_eq!(answer.get("state"), step.get("state"), "{label}: recorded state");
                assert_eq!(answer.get("events"), step.get("events"), "{label}: recorded events");
                if let Some(error) = step.get("error").filter(|error| !error.is_null()) { assert_eq!(answer.get("error"), error.get("key")); }
                else { assert_eq!(crate::replay::plain(answer.get("result").unwrap(), 4).unwrap_or(Value::Null), step.get("result").cloned().unwrap()); }
                if let Some(document) = step.get("document").and_then(Value::as_str) { expected = document.into(); }
                assert_eq!(requested.editor.report_json(), expected, "{label}: recorded document");
                assert_eq!(ordinary.editor.report_json(), expected);
                calls += 1;
            }
            for (packet, bytes) in packets { assert_eq!(json(&packet), bytes, "later edits do not mutate accepted operands"); }
        }
        assert_eq!(calls, 75); total += calls;
    }
    assert_eq!(methods.len(), 8); assert_eq!(total, 150);
}

#[test]
fn layer_metadata_publication_keeps_zero_history_removal_noop_and_create_activation() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/layer-list-sheet.reference.json");
    let reference = parse(&std::fs::read_to_string(path).unwrap());
    let initial = reference.get("steps").unwrap().item(0).unwrap().get("state").unwrap().clone();
    for compact in [false, true] {
        let mut ordinary = session_from_recorded_state(&reference, &initial);
        let mut requested = session_from_recorded_state(&reference, &initial);
        for session in [&mut ordinary, &mut requested] { session.editor.history_limits.count = 0; }
        for (method, args, changed) in [
            ("setLayerColor", r#"[["layer-1"],null]"#, true),
            ("setLayerColor", r#"[["layer-1"],null]"#, true),
            ("renameLayer", r#"["layer-1","Layer 1"]"#, false),
            ("setLayerVisible", r#"["scene",false]"#, true),
            ("setLayerVisible", r#"["scene",false]"#, false),
            ("createLayer", r#"["Inactive",{"activate":false}]"#, true),
            ("createLayer", r#"["Active"]"#, true),
            ("setLayerLocked", r#"["camera",true]"#, true),
            ("renameLayer", r#"["scene","Invalid"]"#, false),
        ] {
            let before = requested.editor.snapshot();
            let mut view = ordinary.editor.state_value().as_obj().unwrap().clone(); view.set("changesOnly", Value::Bool(compact));
            let complete = ordinary.call_values(method, &parse(args), &Value::object(view.clone()));
            view.set("layerPublication", Value::Bool(true));
            let mut answer = requested.call_values(method, &parse(args), &Value::object(view));
            if changed {
                let packet = answer.get("layerPublication").unwrap().clone();
                if method == "setLayerColor" {
                    let update = packet.get("updates").unwrap().item(0).unwrap();
                    assert_eq!(update.get("remove"), Some(&Value::Bool(true))); assert_eq!(update.get("value"), Some(&Value::Null));
                }
                if method == "createLayer" {
                    let active = !args.contains("false");
                    assert_eq!(packet.get("activeId").is_some(), active);
                    if active { assert_eq!(packet.get("activeId"), answer.get("result").unwrap().get("id")); }
                }
                let after = requested.editor.snapshot();
                requested.editor.restore(before);
                assert!(requested.editor.layer_edit(packet.get("label").unwrap().as_str().unwrap(), layer_packet_updates(&packet),
                    packet.get("structural") == Some(&Value::Bool(true)), packet.get("activeId").and_then(Value::as_str).map(str::to_string)).unwrap());
                assert_eq!(requested.editor.report_json(), ordinary.editor.report_json());
                assert_eq!(requested.editor.state_value(), ordinary.editor.state_value());
                assert_eq!(Value::array(requested.editor.take_events()), answer.get("events").unwrap().clone());
                assert!(requested.editor.undo.is_empty());
                requested.editor.restore(after); answer.make_obj().unwrap().remove("layerPublication");
            } else { assert!(answer.get("layerPublication").is_none()); assert_eq!(answer.get("events").unwrap().array_len(), Some(0)); }
            assert_eq!(json(&answer), json(&complete));
        }
    }
}

#[test]
fn layer_metadata_publication_keeps_literal_flags_and_unrecorded_drawing_original() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/layer-list-sheet.reference.json");
    let reference = parse(&std::fs::read_to_string(path).unwrap());
    let initial = reference.get("steps").unwrap().item(0).unwrap().get("state").unwrap().clone();
    for (method, args, flag) in [("renameLayer", r#"["layer-1","New"]"#, Value::Bool(false)),
        ("renameLayer", r#"["layer-1","New"]"#, Value::Num(1.0)),
        ("createLayer", r#"["Drawing",{"drawing":true}]"#, Value::Bool(true)),
        ("setFPS", "[30]", Value::Bool(true))] {
        let mut ordinary = session_from_recorded_state(&reference, &initial);
        let mut requested = session_from_recorded_state(&reference, &initial);
        let mut view = ordinary.editor.state_value().as_obj().unwrap().clone();
        let complete = ordinary.call_values(method, &parse(args), &Value::object(view.clone()));
        view.set("layerPublication", flag);
        let answer = requested.call_values(method, &parse(args), &Value::object(view));
        assert!(answer.get("layerPublication").is_none()); assert_eq!(json(&answer), json(&complete));
        assert_eq!(requested.editor.report_json(), ordinary.editor.report_json());
    }
}

#[test]
fn project_fields_certificate_preserves_both_recorded_settings_tapes_and_default_wire() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    for compact in [false, true] {
        let mut calls = 0;
        let mut certificates = 0;
        for name in ["project-settings-sheet", "project-settings-format4-sheet"] {
            let reference = parse(&std::fs::read_to_string(folder.join(format!("{name}.reference.json"))).unwrap());
            let steps: Vec<Value> = reference.get("steps").unwrap().elements().unwrap().iter().collect();
            let mut ordinary = session_from_recorded_state(&reference, steps[0].get("state").unwrap());
            let mut requested = session_from_recorded_state(&reference, steps[0].get("state").unwrap());
            let mut expected = steps[0].get("document").unwrap().as_str().unwrap().to_string();
            for step in &steps[1..] {
                let call: Vec<Value> = step.get("call").unwrap().elements().unwrap().iter().collect();
                let method = call[0].as_str().unwrap();
                let args = Value::array(call[1..].to_vec());
                let before = requested.editor.report().clone();
                let mut view = ordinary.editor.state_value().as_obj().unwrap().clone();
                view.set("changesOnly", Value::Bool(compact));
                let full = ordinary.call_values(method, &args, &Value::object(view.clone()));
                view.set("projectFieldsPublication", Value::Bool(true));
                let mut answer = requested.call_values(method, &args, &Value::object(view));
                let label = format!("{name} step{} compact={compact}", step.get("step").unwrap());
                let changed = matches!(method, "setFPS" | "setCanvasSize" | "updateProject") && answer.get("result") == Some(&Value::Bool(true));
                if changed {
                    let packet = answer.get("projectFields").unwrap();
                    let event = answer.get("events").unwrap().item(0).unwrap();
                    assert_eq!(packet.get("label"), event.get("label"), "{label}");
                    assert_eq!(packet.get("timing"), event.get("timing"), "{label}");
                    let mut reconstructed = before;
                    let mut names = Vec::new();
                    for field in packet.get("fields").unwrap().elements().unwrap().iter() {
                        let key = field.item(0).unwrap();
                        let value = field.item(1).unwrap();
                        names.push(key.clone());
                        reconstructed.make_obj().unwrap().set(key.as_str().unwrap(), value);
                    }
                    assert_eq!(Value::array(names), event.get("projectFields").unwrap().clone(), "{label}: original order");
                    assert_eq!(json(&reconstructed), requested.editor.report_json(), "{label}: complete stored report");
                    answer.make_obj().unwrap().remove("projectFields");
                    certificates += 1;
                } else { assert!(answer.get("projectFields").is_none(), "{label}: no marker on no-op/error/history"); }
                assert_eq!(json(&answer), json(&full), "{label}: default full/compact wire unchanged");
                assert_eq!(requested.editor.history_value(), ordinary.editor.history_value(), "{label}: original history tail");
                assert_eq!(json(answer.get("state").unwrap()), json(step.get("state").unwrap()), "{label}: recorded state");
                assert_eq!(json(answer.get("events").unwrap()), json(step.get("events").unwrap()), "{label}: recorded event");
                if let Some(error) = step.get("error").filter(|value| !value.is_null()) {
                    assert_eq!(answer.get("status").and_then(Value::as_str), Some("error"));
                    assert_eq!(answer.get("error"), error.get("key"));
                } else { assert_eq!(answer.get("result"), step.get("result"), "{label}: original result"); }
                if let Some(document) = step.get("document").and_then(Value::as_str) { expected = document.into(); }
                assert_eq!(requested.editor.report_json(), expected, "{label}: recorded document");
                assert_eq!(ordinary.editor.report_json(), expected);
                calls += 1;
            }
        }
        assert_eq!(calls, 21);
        assert_eq!(certificates, 6);
    }
}

#[test]
fn project_fields_certificate_is_literal_opt_in_bounded_and_refuses_other_stored_changes() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/project-settings-sheet.reference.json");
    let reference = parse(&std::fs::read_to_string(path).unwrap());
    let initial = reference.get("steps").unwrap().item(0).unwrap().get("state").unwrap().clone();
    for flag in [Value::Bool(false), Value::Num(1.0), Value::str("true"), Value::Null, Value::Bool(true)] {
        let mut ordinary = session_from_recorded_state(&reference, &initial);
        let mut requested = session_from_recorded_state(&reference, &initial);
        let mut view = ordinary.editor.state_value().as_obj().unwrap().clone();
        let full = ordinary.call_values("setFPS", &parse("[31]"), &Value::object(view.clone()));
        view.set("projectFieldsPublication", flag.clone());
        let mut answer = requested.call_values("setFPS", &parse("[31]"), &Value::object(view));
        assert_eq!(answer.get("projectFields").is_some(), flag == Value::Bool(true));
        answer.make_obj().unwrap().remove("projectFields");
        assert_eq!(json(&answer), json(&full));
        assert_eq!(requested.editor.report_json(), ordinary.editor.report_json());
    }
    let before = parse(r#"{"fps":24,"canvas_width":960,"unknown":{"keep":[1,2]},"_styk":{"keep":true}}"#);
    // Keep the actual unchanged COW nodes, just as the stored settings owner does.
    let mut after = before.as_obj().unwrap().clone();
    after.set("canvas_width", Value::Null);
    let after = Value::object(after);
    let event = parse(r#"{"kind":"edit","label":"Project settings","timing":false,"projectFields":["canvas_width"]}"#);
    assert_eq!(project_fields_publication(&before, &after, &event).unwrap().get("fields"), Some(&parse(r#"[["canvas_width",null]]"#)));
    for malformed in [r#"{"kind":"edit","label":"Project settings","timing":false,"projectFields":["canvas_width","canvas_width"]}"#,
        r#"{"kind":"edit","label":"Project settings","timing":false,"projectFields":["unknown"]}"#,
        r#"{"kind":"edit","label":"Project settings","timing":false,"live":true,"projectFields":["canvas_width"]}"#] {
        assert!(project_fields_publication(&before, &after, &parse(malformed)).is_none());
    }
    let mut changed = after.as_obj().unwrap().clone();
    changed.set("_styk", parse(r#"{"keep":false}"#));
    assert!(project_fields_publication(&before, &Value::object(changed), &event).is_none(), "source/metadata changes need the full original route");
    let mut wide = before.as_obj().unwrap().clone();
    for index in 0..65 { wide.set(&format!("unknown{index}"), Value::Num(index as f64)); }
    let before = Value::object(wide.clone()); wide.set("canvas_width", Value::Null);
    assert!(project_fields_publication(&before, &Value::object(wide), &event).is_none(), "early fixed root-field bound");
}


#[test]
fn movieclip_rename_marker_preserves_recorded_answers_and_shallow_definition_children() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/movieclip-rename-sheet.reference.json");
    let reference = parse(&std::fs::read_to_string(path).unwrap());
    let steps: Vec<Value> = reference.get("steps").unwrap().elements().unwrap().iter().collect();
    assert_eq!(steps.len(), 13);
    for compact in [false, true] {
        let mut ordinary = session_from_recorded_state(&reference, steps[0].get("state").unwrap());
        let mut requested = session_from_recorded_state(&reference, steps[0].get("state").unwrap());
        let mut expected = requested.editor.report_json();
        let mut markers = Vec::new();
        for step in &steps[1..] {
            let call: Vec<Value> = step.get("call").unwrap().elements().unwrap().iter().collect();
            let method = call[0].as_str().unwrap().trim_start_matches('@');
            let before = requested.report().clone();
            let original = if method == "renameMovieclip" { requested.editor.selected_movieclip().ok().map(|(_, _, figure)| figure) } else { None };
            let original_bytes = original.as_ref().map(json);
            let mut view = ordinary.editor.state_value().as_obj().unwrap().clone();
            view.set("changesOnly", Value::Bool(compact));
            let args = Value::array(call[1..].to_vec());
            let complete = ordinary.call_values(method, &args, &Value::object(view.clone()));
            view.set("movieclipRenamePublication", Value::Bool(true));
            let mut answer = requested.call_values(method, &args, &Value::object(view));
            let label = format!("rename step{} compact={compact}", step.get("step").unwrap());
            if method == "renameMovieclip" && answer.get("status").and_then(Value::as_str) == Some("ok") {
                let original = original.as_ref().unwrap();
                let marker = answer.get("movieclipRename").unwrap().clone();
                let index = marker.get("index").unwrap().as_f64().unwrap() as usize;
                let renamed = requested.report().get("figure_types").unwrap().item(index).unwrap();
                assert_eq!(marker.as_obj().unwrap().len(), 3);
                assert_eq!(marker.get("beforeName"), original.get("name"));
                assert_eq!(marker.get("name"), renamed.get("name"));
                assert!(original.as_obj().unwrap().keys().eq(renamed.as_obj().unwrap().keys()));
                for (key, value) in original.as_obj().unwrap().iter().filter(|(key, _)| key.as_ref() != "name") {
                    assert!(value.same_node(renamed.get(key).unwrap()), "{label}: shallow child {key}");
                }
                if marker.get("beforeName") == marker.get("name") {
                    assert!(renamed.same_node(original)); assert!(requested.report().same_node(&before));
                    assert_eq!(answer.get("result"), Some(&Value::Null));
                    assert_eq!(answer.get("events").unwrap().array_len(), Some(0));
                } else {
                    let mut copied = original.as_obj().unwrap().clone();
                    copied.set("name", marker.get("name").unwrap().clone());
                    let mut reconstructed = before.clone();
                    reconstructed.make_obj().unwrap().get_mut("figure_types").unwrap().make_arr().unwrap()[index] = Value::object(copied);
                    assert_eq!(json(&reconstructed), requested.editor.report_json(), "{label}: scalar packet reconstructs the stored rename");
                    if !compact { assert!(renamed.same_node(answer.get("result").unwrap())); }
                }
                assert_eq!(json(original), original_bytes.unwrap(), "{label}: original immutable definition");
                markers.push((marker.clone(), json(&marker)));
                answer.make_obj().unwrap().remove("movieclipRename");
                if compact {
                    assert_eq!(answer.get("result"), Some(&Value::Null), "{label}: owned wire carries no embedded definition/document");
                    answer.make_obj().unwrap().set("result", complete.get("result").unwrap().clone());
                }
            } else { assert!(answer.get("movieclipRename").is_none(), "{label}: other methods/errors omit the marker"); }
            assert!(complete.get("movieclipRename").is_none());
            assert_eq!(json(&answer), json(&complete), "{label}: default full/compact answer unchanged");
            assert_eq!(json(answer.get("state").unwrap()), json(step.get("state").unwrap()), "{label}: recorded history and selection");
            assert_eq!(json(answer.get("events").unwrap()), json(step.get("events").unwrap()), "{label}: recorded events");
            if let Some(error) = step.get("error").filter(|error| !error.is_null()) {
                assert_eq!(answer.get("error"), error.get("key"), "{label}: original validation");
            } else if method != "seek" {
                assert_eq!(crate::replay::plain(complete.get("result").unwrap(), 4).unwrap_or(Value::Null), step.get("result").cloned().unwrap(), "{label}: original default result");
            }
            if let Some(document) = step.get("document").and_then(Value::as_str) { expected = document.into(); }
            assert_eq!(requested.editor.report_json(), expected, "{label}: recorded document");
            assert_eq!(ordinary.editor.report_json(), expected);
        }
        assert_eq!(markers.len(), 3, "two changed names and the unchanged-name certificate");
        for (marker, bytes) in markers { assert_eq!(json(&marker), bytes, "later undo/redo keeps returned markers immutable"); }
    }
}

#[test]
fn movieclip_rename_marker_keeps_zero_history_noops_and_literal_quiet_admission() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/movieclip-rename-sheet.reference.json");
    let reference = parse(&std::fs::read_to_string(path).unwrap());
    let steps = reference.get("steps").unwrap().elements().unwrap();
    let selected = steps.get(2).unwrap().get("state").unwrap().clone();
    for compact in [false, true] {
        let mut ordinary = session_from_recorded_state(&reference, &selected);
        let mut requested = session_from_recorded_state(&reference, &selected);
        for session in [&mut ordinary, &mut requested] { session.editor.history_limits.count = 0; }
        for name in ["Changed", "Changed"] {
            let mut view = ordinary.editor.state_value().as_obj().unwrap().clone(); view.set("changesOnly", Value::Bool(compact));
            let before = requested.report().clone(); let original = requested.editor.selected_movieclip().unwrap().2;
            let args = Value::array(vec![Value::str(name)]);
            let complete = ordinary.call_values("renameMovieclip", &args, &Value::object(view.clone()));
            view.set("movieclipRenamePublication", Value::Bool(true));
            let mut answer = requested.call_values("renameMovieclip", &args, &Value::object(view));
            let marker = answer.get("movieclipRename").unwrap().clone();
            assert_eq!(marker.get("beforeName"), original.get("name")); assert_eq!(marker.get("name"), Some(&Value::str(name)));
            assert!(requested.editor.undo.is_empty(), "marker is independent of undo.last");
            if original.get("name").and_then(Value::as_str) == Some(name) { assert!(requested.report().same_node(&before)); }
            answer.make_obj().unwrap().remove("movieclipRename");
            if compact { assert_eq!(answer.get("result"), Some(&Value::Null)); answer.make_obj().unwrap().set("result", complete.get("result").unwrap().clone()); }
            assert_eq!(json(&answer), json(&complete));
            assert_eq!(requested.editor.report_json(), ordinary.editor.report_json());
        }
    }
    for context in ["false", "number", "native", "source", "frameDraft", "origin", "drag", "batch", "otherMethod"] {
        let mut ordinary = session_from_recorded_state(&reference, &selected);
        let mut requested = session_from_recorded_state(&reference, &selected);
        for session in [&mut ordinary, &mut requested] {
            match context {
                "native" => { session.editor.report.make_obj().unwrap().get_mut("_styk").unwrap().make_obj().unwrap().remove("layerSheet"); }
                "source" => { session.editor.report.make_obj().unwrap().get_mut("_styk").unwrap().make_obj().unwrap().set("movieclipSource", parse("{}")); }
                "frameDraft" => { session.editor.report.make_obj().unwrap().get_mut("_styk").unwrap().make_obj().unwrap().set("simpleFrameDraft", parse("{}")); }
                "origin" => {
                    let original = session.editor.selected_movieclip().unwrap().2;
                    let index = session.editor.report.get("figure_types").unwrap().elements().unwrap().iter().position(|figure| figure.same_node(&original)).unwrap();
                    session.editor.report.make_obj().unwrap().get_mut("figure_types").unwrap().make_arr().unwrap()[index]
                        .make_obj().unwrap().get_mut("_styk").unwrap().make_obj().unwrap().set("animationOrigin", parse("{}"));
                }
                "drag" => { session.editor.call("beginDrag", &[Value::str("Existing gesture")]).unwrap(); session.editor.take_events(); }
                "batch" => { session.editor.call("beginBatch", &[Value::str("Existing batch")]).unwrap(); session.editor.take_events(); }
                _ => {}
            }
        }
        let method = if context == "otherMethod" { "select" } else { "renameMovieclip" };
        let args = if context == "otherMethod" { parse("[4,-1]") } else { parse(r#"["Changed"]"#) };
        let mut view = ordinary.editor.state_value().as_obj().unwrap().clone();
        let complete = ordinary.call_values(method, &args, &Value::object(view.clone()));
        view.set("movieclipRenamePublication", match context { "false" => Value::Bool(false), "number" => Value::Num(1.0), _ => Value::Bool(true) });
        let answer = requested.call_values(method, &args, &Value::object(view));
        assert!(answer.get("movieclipRename").is_none(), "{context}: no new admission");
        assert_eq!(json(&answer), json(&complete), "{context}: original answer unchanged");
        assert_eq!(requested.editor.report_json(), ordinary.editor.report_json());
    }
}

/// What a session tells the owner of its open motion-path edit while a recorded tape runs:
/// the fixed part once, how it stands after every call, the virtual report when a move changed
/// it, and nothing once it has ended.
#[test]
fn motion_path_answers_tell_the_owner_how_the_edit_stands() {
    let (mut begun, mut moves, mut reshaped, mut ended, mut errors) = (0, 0, 0, 0, 0);
    for name in ["motion-path-sheet", "motion-path-falloff-sheet", "motion-path-camera-sheet"] {
        let file = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../tests/edit/{name}.reference.json"));
        let reference = parse(&std::fs::read_to_string(file).unwrap());
        let steps: Vec<Value> = reference.get("steps").unwrap().elements().unwrap().iter().collect();
        let mut session = session_from_recorded_state(&reference, steps[0].get("state").unwrap());
        let mut open = false;
        for step in &steps[1..] {
            let call: Vec<Value> = step.get("call").unwrap().elements().unwrap().iter().collect();
            let method = call[0].as_str().unwrap().trim_start_matches('@');
            let mut view = session.editor.state_value().as_obj().unwrap().clone();
            view.set("autoKey", Value::Bool(session.editor.auto_key));
            view.set("patch", Value::Bool(true));
            view.set("changesOnly", Value::Bool(true));
            let label = format!("{name} step {} ({method})", step.get("step").unwrap());
            let answer = session.call_values(method, &Value::array(call[1..].to_vec()), &Value::object(view));
            // A recorded error leaves the edit as it was; the owner hands it to the editor.
            let recorded_error = step.get("error").is_some_and(|error| !error.is_null());
            assert_eq!(answer.get("status").and_then(Value::as_str), Some(if recorded_error { "error" } else { "ok" }), "{label}");
            errors += usize::from(recorded_error);
            let live = answer.get("motionPath").unwrap();
            assert_eq!(live.is_null(), answer.get("drag").unwrap().is_null(), "{label}: the edit is the gesture");
            if live.is_null() {
                ended += usize::from(open);
                open = false;
                continue;
            }
            let moved = live.get("moved").unwrap().truthy();
            let range = live.get("range").unwrap().numbers().unwrap();
            assert!(range[0] < range[1], "{label}: a window of ticks");
            if method == "beginMotionPathEdit" || method == "setMotionPathFalloff" && live.get("target").is_some() {
                begun += 1;
                assert!(live.get("target").unwrap().is_object() && live.get("tick").is_some() && live.get("baseline").unwrap().array_len().is_some(), "{label}: the fixed part");
                // Nothing has been moved yet (or the replay moved it): the virtual report is the document, or the changes.
                assert!(live.get("report").unwrap().array_len().is_some(), "{label}: a report to begin with");
                if live.get("falloff").is_some() {
                    let subs = live.get("subs").unwrap().array_len().unwrap();
                    assert!(subs > 1 && live.get("writes").unwrap().array_len().unwrap() > 1 && live.get("movedSubs").unwrap().array_len() == Some(subs), "{label}: a falloff's writes");
                }
                open = true;
            } else {
                assert!(live.get("target").is_none() && live.get("baseline").is_none(), "{label}: the fixed part is told once");
            }
            if method == "updateMotionPathEdit" {
                moves += 1;
                // A move that changed the pose tells the changes to the virtual report, as paths from the root.
                if let Some(report) = live.get("report") {
                    reshaped += 1;
                    assert!(moved && report.array_len().unwrap() > 0, "{label}: changes");
                    for op in report.elements().unwrap().iter() {
                        assert!(["_styk", "keyframes", "figure_types"].contains(&op.get("p").unwrap().item(0).unwrap().as_str().unwrap()), "{label}: {}", json(&op));
                    }
                }
            }
        }
    }
    assert!(begun >= 20 && moves >= 40 && reshaped >= 30 && ended >= 20 && errors >= 1, "begun {begun}, moves {moves}, reshaped {reshaped}, ended {ended}, errors {errors}");
}

#[test]
fn handle_gesture_answers_tell_the_owner_where_the_gesture_stands() {
    let (mut figure, mut edit, mut options, mut turned) = (0, 0, 0, 0);
    for name in ["figure-transform-sheet", "figure-transform-native", "handle-edit-sheet", "handle-edit-native", "handle-commands-sheet", "segment-clipboard-sheet"] {
        let file = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../tests/edit/{name}.reference.json"));
        let reference = parse(&std::fs::read_to_string(file).unwrap());
        let steps: Vec<Value> = reference.get("steps").unwrap().elements().unwrap().iter().collect();
        let mut session = session_from_recorded_state(&reference, steps[0].get("state").unwrap());
        let mut rotation = 0.0;
        for step in &steps[1..] {
            let call: Vec<Value> = step.get("call").unwrap().elements().unwrap().iter().collect();
            let method = call[0].as_str().unwrap().trim_start_matches('@');
            let mut view = session.editor.state_value().as_obj().unwrap().clone();
            view.set("autoKey", Value::Bool(session.editor.auto_key));
            view.set("changesOnly", Value::Bool(true));
            view.set("patch", Value::Bool(true));
            let label = format!("{name} step {} ({method})", step.get("step").unwrap());
            let answer = session.call_values(method, &Value::array(call[1..].to_vec()), &Value::object(view));
            let live = answer.get("handleGesture").unwrap();
            if live.is_null() {
                rotation = 0.0;
                continue;
            }
            assert!(!answer.get("drag").unwrap().is_null(), "{label}: the gesture is a drag");
            if let Some(handle) = live.get("figureHandle") {
                figure += 1;
                assert_eq!(handle.get("origin").unwrap().numbers().unwrap().len(), 2, "{label}: the pivot");
                assert!(handle.get("distance").unwrap().as_f64().unwrap() > 0.0, "{label}: the distance the scale is measured from");
                assert!(handle.get("lastAngle").unwrap().as_f64().unwrap().abs() <= std::f64::consts::PI, "{label}: the angle the last move had");
                assert!(handle.get("rotate").is_some() && handle.get("scale").is_some() && handle.get("uid").is_some(), "{label}: the toolbar's options");
                let now = handle.get("rotation").unwrap().as_f64().unwrap();
                turned += usize::from(now != rotation);
                rotation = now;
            }
            if let Some(handle) = live.get("handleEdit") {
                edit += 1;
                assert_eq!(handle.get("point").unwrap().numbers().unwrap().len(), 2, "{label}: where the handle began");
                assert!(handle.get("index").is_some() && handle.get("uid").is_some() && handle.get("bend").is_some(), "{label}: the handle being edited");
            }
            if let Some(chosen) = live.get("segmentValueOptions") {
                options += 1;
                assert!(chosen.is_object(), "{label}: the options the gesture began with");
            }
        }
    }
    assert!(figure >= 6 && edit >= 8 && options >= 6 && turned >= 3, "figure {figure}, edit {edit}, options {options}, turned {turned}");
}

/// What a session tells the owner of its open rig edit or camera drag while a recorded tape runs:
/// which kind of gesture is open, and a camera drag's preview as the camera alone (the complete
/// frame only where the answer is not compact).
#[test]
fn rig_and_camera_answers_tell_the_owner_which_gesture_is_open() {
    let (mut rig, mut camera, mut previews, mut closed) = (0, 0, 0, 0);
    for name in ["rig-drag-sheet", "rig-drag-native", "camera-commands-sheet"] {
        let file = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../tests/edit/{name}.reference.json"));
        let reference = parse(&std::fs::read_to_string(file).unwrap());
        let steps: Vec<Value> = reference.get("steps").unwrap().elements().unwrap().iter().collect();
        for compact in [true, false] {
            let mut session = session_from_recorded_state(&reference, steps[0].get("state").unwrap());
            for step in &steps[1..] {
                let call: Vec<Value> = step.get("call").unwrap().elements().unwrap().iter().collect();
                let method = call[0].as_str().unwrap().trim_start_matches('@');
                let mut view = session.editor.state_value().as_obj().unwrap().clone();
                view.set("autoKey", Value::Bool(session.editor.auto_key));
                view.set("patch", Value::Bool(true));
                view.set("changesOnly", Value::Bool(compact));
                let label = format!("{name} step {} ({method}, compact {compact})", step.get("step").unwrap());
                let answer = session.call_values(method, &Value::array(call[1..].to_vec()), &Value::object(view));
                let drag = answer.get("drag").unwrap();
                if drag.is_null() {
                    closed += usize::from(compact);
                    assert!(answer.get("cameraPreview").is_none() && answer.get("preview").is_none(), "{label}: no preview once the gesture ended");
                    continue;
                }
                let (is_rig, is_camera) = (drag.get("rig").is_some_and(Value::truthy), drag.get("camera").is_some_and(Value::truthy));
                // A rig edit is a plain pose gesture to the editor, with the marker; a camera drag takes no figure.
                assert!(!(is_rig && is_camera), "{label}");
                if is_camera {
                    assert!(drag.get("before").unwrap().array_len() == Some(0), "{label}: a camera drag takes no figures");
                }
                if compact { rig += usize::from(is_rig); camera += usize::from(is_camera); }
                if method == "updateCameraDrag" && is_camera {
                    previews += usize::from(compact);
                    if compact {
                        assert!(answer.get("preview").is_none(), "{label}: the camera alone");
                        assert!(answer.get("cameraPreview").unwrap().get("scale").is_some(), "{label}: a camera");
                    } else {
                        assert!(answer.get("cameraPreview").is_none() && answer.get("preview").unwrap().get("objects").is_some(), "{label}: the complete frame");
                    }
                } else {
                    assert!(answer.get("cameraPreview").is_none(), "{label}: only a camera move previews");
                }
            }
        }
    }
    assert!(rig >= 20 && camera >= 10 && previews >= 8 && closed >= 20, "rig {rig}, camera {camera}, previews {previews}, closed {closed}");
}
