//! Moving figures to another layer and deleting a layer, as the session's own calls (`assignFiguresToLayer`,
//! `deleteLayer`): the recorded sheet migrations (`engine/tests/layer-sheet-migration`) give the document, the
//! history entry, the change events and the counters the editor's recording gave, and their refusals are the
//! editor's.
use styk_doc::{Value, json};
use styk_edit::{EditError, Editor, Options, Selection};

fn fixture(name: &str) -> (Value, Value) {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../tests/layer-sheet-migration/{name}.json"));
    let reference = json::parse(&std::fs::read(path).unwrap()).unwrap();
    let report = json::parse(reference.get("document").unwrap().as_str().unwrap().as_bytes()).unwrap();
    (reference, report)
}

fn editor(reference: &Value, report: Value) -> Editor {
    let initial = reference.get("initialState").unwrap();
    let mut editor = Editor::new(report, Options { layer_timeline: true, property_channels: false, auto_key: false });
    let selection = initial.get("selection").unwrap();
    let numbers = |value: &Value| value.numbers().unwrap().iter().map(|u| *u as u32).collect::<Vec<_>>();
    editor.set_view(
        selection.get("tick").unwrap().as_f64().unwrap(),
        selection.get("frameIndex").unwrap().as_f64().unwrap() as usize,
        Selection { uid: selection.get("uid").and_then(Value::as_f64).map(|u| u as u32), uids: numbers(selection.get("uids").unwrap()), joint: selection.get("joint").unwrap().as_f64().unwrap() as i64 },
    );
    editor.set_counters(
        initial.get("layerRevision").unwrap().as_f64().unwrap() as u64,
        initial.get("nextFrameIdentity").unwrap().as_f64().unwrap() as u64,
        initial.get("nextUid").unwrap().as_f64().unwrap() as u64,
    );
    editor
}

/// The call the recording made: moving the request's figures, or deleting its layer.
fn call(editor: &mut Editor, reference: &Value) -> Result<Value, EditError> {
    let request = reference.get("request").unwrap();
    match request.get("deletedLayerId") {
        Some(id) => editor.call("deleteLayer", &[id.clone()]),
        None => editor.call("assignFiguresToLayer", &[request.get("uids").unwrap().clone(), request.get("targetLayerId").unwrap().clone()]),
    }
}

fn same(actual: &str, wanted: &str, what: &str) {
    if actual != wanted {
        let at = actual.bytes().zip(wanted.bytes()).position(|(a, b)| a != b).unwrap_or(actual.len().min(wanted.len()));
        let around = |text: &str| String::from_utf8_lossy(&text.as_bytes()[at.saturating_sub(100)..(at + 160).min(text.len())]).into_owned();
        panic!("{what} differs at byte {at}: {} / {}", around(actual), around(wanted));
    }
}

#[test]
fn moving_figures_and_deleting_a_layer_give_what_the_editor_recorded() {
    for name in ["shared", "vacant", "vacant-tail", "combined", "absence", "delete-unused", "delete-native", "delete-joined", "dense", "noop", "movieclip", "delete-movieclip"] {
        let (reference, report) = fixture(name);
        let mut editor = editor(&reference, report);
        let command = reference.get("command").unwrap();
        let result = call(&mut editor, &reference).unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_eq!(result.as_bool(), command.get("result").unwrap().as_bool(), "{name} result");
        same(&editor.report_json(), command.get("after").unwrap().as_str().unwrap(), &format!("{name} after"));
        same(&json::to_string(&Value::array(editor.take_events())), &json::to_string(command.get("events").unwrap()), &format!("{name} events"));
        let state = editor.state();
        let wanted = command.get("state").unwrap();
        assert_eq!(state.next_frame_identity, wanted.get("nextFrameIdentity").unwrap().as_f64().unwrap() as u64, "{name} frame identity");
        assert_eq!(state.layer_revision, wanted.get("layerRevision").unwrap().as_f64().unwrap() as u64, "{name} layer revision");
        assert_eq!(state.can_undo, wanted.get("canUndo").unwrap().as_bool().unwrap(), "{name} history");
        editor.call("undo", &[]).unwrap();
        same(&editor.report_json(), command.get("undone").unwrap().as_str().unwrap(), &format!("{name} undone"));
        same(&json::to_string(&Value::array(editor.take_events())), &json::to_string(command.get("undoEvents").unwrap()), &format!("{name} undo events"));
        editor.call("redo", &[]).unwrap();
        same(&editor.report_json(), command.get("redone").unwrap().as_str().unwrap(), &format!("{name} redone"));
        same(&json::to_string(&Value::array(editor.take_events())), &json::to_string(command.get("redoEvents").unwrap()), &format!("{name} redo events"));
    }
}

/// The editor's recording "view-changed" moved the selection while it planned and published the active layer it
/// had before; a call that plans and publishes at once cannot interleave, and keeps the layer the selection is on.
#[test]
fn a_move_follows_the_view_it_is_made_in() {
    let (reference, report) = fixture("view-changed");
    let mut editor = editor(&reference, report);
    editor.call("seek", &[Value::Num(3.0)]).unwrap();
    editor.call("select", &[Value::Num(2.0)]).unwrap();
    assert_eq!(call(&mut editor, &reference).unwrap().as_bool(), Some(true));
    let report = editor.report_json();
    assert!(report.contains(r#""assignments":{"1":"layer-2","2":"layer-2"}"#), "the figure moved");
    assert!(report.contains(r#""activeId":"layer-2""#), "the layer of the selected figure stays active");
    editor.call("undo", &[]).unwrap();
    let assignments = |text: &str| json::to_string(json::parse(text.as_bytes()).unwrap().path(&["_styk", "layers", "assignments"]).unwrap());
    assert_eq!(assignments(&editor.report_json()), assignments(reference.get("document").unwrap().as_str().unwrap()), "one undo takes the whole move back");
}

#[test]
fn a_move_or_a_deletion_the_editor_refused_is_refused_and_changes_nothing() {
    for name in ["invalid-uid", "missing-layer", "locked-destination", "locked-source", "delete-camera", "delete-last"] {
        let (reference, report) = fixture(name);
        let mut editor = editor(&reference, report);
        let failure = reference.get("failure").unwrap();
        let before = editor.report_json();
        let error = call(&mut editor, &reference).unwrap_err();
        let EditError::Invalid(key) = error else { panic!("{name}: {error}") };
        assert_eq!(styk_edit::error_key(&key), failure.get("messageKey").unwrap().as_str().unwrap(), "{name}");
        same(&editor.report_json(), &before, &format!("{name} document"));
        same(&editor.report_json(), failure.get("after").unwrap().as_str().unwrap(), &format!("{name} recorded document"));
        assert!(!editor.state().can_undo, "{name}: nothing was recorded");
        assert!(editor.take_events().is_empty(), "{name}: nothing was announced");
    }
}

#[test]
fn deleting_a_layer_into_a_chosen_layer_is_not_a_session_call() {
    let (reference, report) = fixture("delete-unused");
    let mut editor = editor(&reference, report);
    let mut options = styk_doc::Obj::new();
    options.set("targetLayerId", Value::str("layer-2"));
    let error = editor.call("deleteLayer", &[Value::str("layer-3"), Value::object(options)]).unwrap_err();
    assert!(matches!(error, EditError::Unported(_)), "{error}");
}
