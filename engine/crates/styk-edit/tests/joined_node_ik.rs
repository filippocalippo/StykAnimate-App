//! IK settings on figures joined into an assembly (`setNodeIK` and `rotateIKTarget`
//! on a joined graph): switching a controller on from nothing, its chain,
//! stretch and bend, releasing, pinning again and switching it off, the refusals, and posing
//! the limb afterwards. Every edit is one history entry that undo and redo take back and
//! give again exactly.
//!
//! The fixture is `ik/joined.json` opened as a layer sheet (the `ik-joined-sheet` tape's
//! document): figure 2 hangs from figure 1 and carries a pinned controller at handle 22;
//! figures 3 and 4 hang from figure 2's handle 22.

use styk_doc::Value;
use styk_edit::{EditError, Editor, Options};

fn json(text: &str) -> Value { styk_doc::json::parse(text.as_bytes()).unwrap() }

fn open() -> Editor {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/ik-joined-sheet.reference.json");
    let reference = styk_doc::json::parse(&std::fs::read(path).unwrap()).unwrap();
    let first = reference.get("steps").unwrap().item(0).unwrap();
    let mut editor = Editor::new(json(first.get("document").unwrap().as_str().unwrap()), Options { property_channels: true, layer_timeline: true, auto_key: false });
    let state = first.get("state").unwrap();
    let counter = |key| state.get(key).unwrap().as_f64().unwrap() as u64;
    editor.set_counters(counter("layerRevision"), counter("nextFrameIdentity"), counter("nextUid"));
    editor
}

fn call(editor: &mut Editor, method: &str, args: &str) -> Result<Value, EditError> {
    let args: Vec<Value> = json(args).elements().unwrap().iter().collect();
    editor.call(method, &args)
}

fn select(editor: &mut Editor, uid: u32, joint: i64) {
    editor.call("select", &[Value::Num(uid as f64), Value::Num(joint as f64)]).unwrap();
}

/// The controller of `handle` on figure `uid` in the frame on show: the layer's first key names the pose source it
/// shows once an edit has made one, else the stored keyframe.
fn controller(editor: &Editor, uid: u32, handle: u32) -> Option<Value> {
    let report = json(&editor.report_json());
    let key = report.path(&["_styk", "layerSheet", "tracks", "layer-1", "keys"]).and_then(Value::elements).and_then(|keys| keys.get(0)).expect("a key");
    let frame = match key.path(&["value", "frameId"]).and_then(Value::as_str) {
        Some(id) => report.path(&["_styk", "frameSources", id]).cloned().expect("its pose source"),
        None => report.get("keyframes").and_then(Value::elements).and_then(|frames| frames.get(0)).expect("a keyframe"),
    };
    frame.get("objects").and_then(Value::elements).unwrap().iter()
        .find(|object| object.get("unique_id").and_then(Value::as_f64) == Some(uid as f64))
        .and_then(|object| object.path(&["_stykIK", &handle.to_string()]).cloned())
}

fn truthy(value: &Option<Value>, key: &str) -> bool { value.as_ref().and_then(|v| v.get(key)).is_some_and(Value::truthy) }

fn number(value: &Option<Value>, path: &[&str]) -> f64 { value.as_ref().and_then(|v| v.path(path)).and_then(Value::as_f64).unwrap() }

/// Undoes every entry back to the first state and redoes them all, comparing each document on the way.
fn assert_history_exact(editor: &mut Editor, states: &[String]) {
    for earlier in states[..states.len() - 1].iter().rev() {
        assert_eq!(call(editor, "undo", "[]").unwrap(), Value::Bool(true));
        assert_eq!(&editor.report_json(), earlier, "undo gives the document before");
    }
    assert!(!editor.state().can_undo, "nothing is left to undo");
    for later in &states[1..] {
        assert_eq!(call(editor, "redo", "[]").unwrap(), Value::Bool(true));
        assert_eq!(&editor.report_json(), later, "redo gives the document after");
    }
    assert!(!editor.state().can_redo, "nothing is left to redo");
}

#[test]
fn a_controller_is_switched_on_from_nothing_on_a_joined_figure() {
    let mut editor = open();
    select(&mut editor, 3, 1);
    assert!(controller(&editor, 3, 34).is_none());
    let before = editor.report_json();
    assert_eq!(call(&mut editor, "setNodeIK", "[{\"enabled\":true}]").unwrap(), Value::Bool(true));
    let made = controller(&editor, 3, 34);
    assert!(truthy(&made, "enabled") && truthy(&made, "pinned"), "switched on pinned where the limb is drawn: {made:?}");
    assert_eq!(number(&made, &["chainLength"]), 2.0);
    assert_eq!(number(&made, &["target", "rotation"]), 0.0);
    assert!(made.as_ref().unwrap().get("joinedFollowers").is_some(), "the followers of the figures joined to the limb are captured");
    assert!(made.as_ref().unwrap().get("bendReference").is_some());
    assert_eq!(editor.state().undo_label, "Configure IK");
    let after = editor.report_json();
    assert_ne!(after, before);
    assert_history_exact(&mut editor, &[before, after]);
}

#[test]
fn the_settings_of_a_joined_controller_each_undo_and_redo_exactly() {
    let mut editor = open();
    select(&mut editor, 3, 1);
    let mut states = vec![editor.report_json()];
    for (patch, check) in [
        ("{\"enabled\":true}", "on"),
        ("{\"chainLength\":1}", "chain"),
        ("{\"allowStretch\":true}", "stretch"),
        ("{\"bendDirection\":1}", "bend"),
        ("{\"bendDirection\":0}", "bend free"),
        ("{\"pinned\":false}", "released"),
        ("{\"pinned\":true}", "pinned again"),
        ("{\"enabled\":false}", "off"),
    ] {
        assert_eq!(call(&mut editor, "setNodeIK", &format!("[{patch}]")).unwrap(), Value::Bool(true), "{check}");
        let made = controller(&editor, 3, 34);
        match check {
            "chain" => assert_eq!(number(&made, &["chainLength"]), 1.0),
            "stretch" => assert!(truthy(&made, "allowStretch")),
            "bend" => assert_eq!(number(&made, &["bendDirection"]), 1.0),
            "bend free" => assert!(made.as_ref().unwrap().path(&["bendReference", "side"]).is_some(), "a free bend keeps the side it is drawn with"),
            "released" => assert!(truthy(&made, "enabled") && !truthy(&made, "pinned")),
            "pinned again" => assert!(truthy(&made, "pinned")),
            "off" => assert!(made.is_none(), "a controller switched off is removed"),
            _ => {}
        }
        states.push(editor.report_json());
        assert_ne!(states[states.len() - 1], states[states.len() - 2], "{check} changed the document");
    }
    assert_history_exact(&mut editor, &states);
}

#[test]
fn a_joined_controller_that_shares_bones_or_is_malformed_is_refused_and_changes_nothing() {
    let mut editor = open();
    let before = editor.report_json();
    // Figure 2's own controller at handle 22 already holds the bones below figure 3's root.
    select(&mut editor, 3, 0);
    for (patch, refusal) in [
        ("{\"enabled\":true}", "errors.editorIk.ikChainsCannotShareBonesShortenTheChain"),
        ("{\"bogus\":1}", "errors.editorIk.unknownIkSetting"),
        ("{\"enabled\":true,\"bendDirection\":5}", "errors.editorIk.invalidIkSetting"),
        ("{\"enabled\":\"yes\"}", "errors.editorIk.invalidIkSetting"),
    ] {
        match call(&mut editor, "setNodeIK", &format!("[{patch}]")) {
            Err(EditError::Invalid(message)) => assert_eq!(message, refusal, "{patch}"),
            other => panic!("{patch}: {other:?}"),
        }
    }
    select(&mut editor, 3, 1);
    match call(&mut editor, "setNodeIK", "[{\"enabled\":true,\"chainLength\":99}]") {
        Err(EditError::Invalid(message)) => assert!(message.starts_with("errors.editorIk.chainLengthMustBeBetween1And"), "{message}"),
        other => panic!("{other:?}"),
    }
    assert_eq!(editor.report_json(), before, "a refused setting changes nothing");
    assert!(!editor.state().can_undo, "and records nothing");
}

#[test]
fn posing_a_joined_limb_with_ik_undoes_and_redoes_exactly() {
    let mut editor = open();
    select(&mut editor, 3, 1);
    let start = editor.report_json();
    call(&mut editor, "setNodeIK", "[{\"enabled\":true}]").unwrap();
    let enabled = editor.report_json();
    let made = controller(&editor, 3, 34);
    let (x, y) = (number(&made, &["target", "x"]), number(&made, &["target", "y"]));
    call(&mut editor, "beginDrag", "[\"Pose joint\"]").unwrap();
    call(&mut editor, "poseJoint", &format!("[{},{}]", x - 40.0, y + 25.0)).unwrap();
    assert_eq!(call(&mut editor, "commitDrag", "[]").unwrap(), Value::Bool(true));
    let posed = editor.report_json();
    assert_ne!(posed, enabled, "the pinned limb followed the pointer");
    assert_eq!(number(&controller(&editor, 3, 34), &["target", "x"]), x - 40.0);
    assert_history_exact(&mut editor, &[start, enabled, posed]);
}

#[test]
fn a_free_joined_controller_turns_its_target_and_the_limb_beyond_it() {
    let mut editor = open();
    select(&mut editor, 3, 1);
    let mut states = vec![editor.report_json()];
    call(&mut editor, "setNodeIK", "[{\"enabled\":true,\"pinned\":false}]").unwrap();
    states.push(editor.report_json());
    assert!(!truthy(&controller(&editor, 3, 34), "pinned"));
    assert_eq!(call(&mut editor, "rotateIKTarget", "[0.4]").unwrap(), Value::Bool(true));
    assert_eq!(number(&controller(&editor, 3, 34), &["target", "rotation"]), 0.4);
    states.push(editor.report_json());
    assert_ne!(states[1], states[2]);
    // A pinned target only turns.
    call(&mut editor, "setNodeIK", "[{\"pinned\":true}]").unwrap();
    states.push(editor.report_json());
    assert_eq!(call(&mut editor, "rotateIKTarget", "[-0.2]").unwrap(), Value::Bool(true));
    assert_eq!(number(&controller(&editor, 3, 34), &["target", "rotation"]), -0.2);
    states.push(editor.report_json());
    assert_history_exact(&mut editor, &states);
}

#[test]
fn a_joined_setting_inside_an_open_gesture_belongs_to_it() {
    let mut editor = open();
    select(&mut editor, 3, 1);
    let before = editor.report_json();
    call(&mut editor, "beginDrag", "[\"Move and configure\"]").unwrap();
    call(&mut editor, "moveSelection", "[3,2]").unwrap();
    assert_eq!(call(&mut editor, "setNodeIK", "[{\"enabled\":true}]").unwrap(), Value::Bool(true));
    assert!(!editor.state().can_undo, "the gesture is still open");
    assert_eq!(call(&mut editor, "commitDrag", "[]").unwrap(), Value::Bool(true));
    let after = editor.report_json();
    assert!(controller(&editor, 3, 34).is_some());
    assert_history_exact(&mut editor, &[before, after]);
}
