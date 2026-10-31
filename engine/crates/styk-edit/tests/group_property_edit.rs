//! One property edited on several targets at once (`beginAnimationEdit([targets], property)`, `previewAnimationEdit`,
//! `commitAnimationEdit`, `cancelAnimationEdit`, `property_edit.rs`): a branch's opacity and the draw order of a figure's drawables,
//! on the recorded layer sheet of three figures keyed at ticks 0 and 6. Figure 1's segments are 11, 22, 33, 44, 55 and 66.

use styk_doc::Value;
use styk_edit::session::Session;

fn json(text: &str) -> Value { styk_doc::json::parse(text.as_bytes()).unwrap() }

fn session() -> Session {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/figures-sheet.reference.json");
    let reference = styk_doc::json::parse(&std::fs::read(path).unwrap()).unwrap();
    let first = reference.get("steps").unwrap().item(0).unwrap();
    let mut state = first.get("state").unwrap().as_obj().unwrap().clone();
    for (key, value) in reference.get("editor").unwrap().as_obj().unwrap().iter() { state.set(key, value.clone()); }
    Session::start(json(first.get("document").unwrap().as_str().unwrap()), &styk_doc::json::to_string(&Value::object(state))).unwrap()
}

fn call(session: &mut Session, method: &str, args: &str) -> Value { json(&session.call(method, args, "null")) }

fn ok(session: &mut Session, method: &str, args: &str) -> Value {
    let answer = call(session, method, args);
    assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"), "{method} {args}: {answer:?}");
    answer.get("result").cloned().unwrap_or(Value::Null)
}

fn refused(session: &mut Session, method: &str, args: &str) -> String {
    let answer = call(session, method, args);
    assert_eq!(answer.get("status").and_then(Value::as_str), Some("error"), "{method} {args}: {answer:?}");
    answer.get("error").and_then(Value::as_str).unwrap().to_string()
}

fn state(session: &mut Session) -> Value { call(session, "seek", "[0]").get("state").cloned().unwrap() }

fn text(session: &Session) -> String { styk_doc::json::to_string(session.report()) }

fn target(handle: u32) -> String { format!(r#"{{"kind":"segment","uid":1,"handleId":{handle},"figureTypeId":1}}"#) }

fn targets(handles: &[u32]) -> String { format!("[{}]", handles.iter().map(|h| target(*h)).collect::<Vec<_>>().join(",")) }

/// What the session reads for `property` of segment `handle` of figure 1 at `tick`.
fn value_at(session: &mut Session, handle: u32, property: &str, tick: u32) -> f64 {
    let answer = json(&session.query("animationValue", &format!(r#"[{},"{property}",{tick}]"#, target(handle)), r#"{"tick":0,"frameIndex":0}"#).unwrap());
    answer.get("v").and_then(Value::as_f64).unwrap_or(f64::NAN)
}

/// The key of the sheet's first layer at `tick`.
fn layer_key(session: &Session, tick: f64) -> Value {
    let keys = session.report().path(&["_styk", "layerSheet", "tracks", "layer-1", "keys"]).unwrap();
    keys.elements().unwrap().iter().find(|key| key.get("tick").and_then(Value::as_f64) == Some(tick)).unwrap()
}

#[test]
fn one_value_is_previewed_on_every_target_and_keyed_as_one_entry_when_the_edit_ends() {
    let mut session = session();
    let original = text(&session);
    let both = targets(&[11, 22]);
    let begun = ok(&mut session, "beginAnimationEdit", &format!(r#"[{both},"opacity",{{"exactTarget":true}}]"#));
    assert_eq!(begun.get("targets").and_then(Value::array_len), Some(2), "{begun:?}");
    assert_eq!(begun.get("changed").and_then(Value::as_bool), Some(false));
    // Nothing is a value yet: the document is as it was until the edit ends.
    ok(&mut session, "previewAnimationEdit", "[0.4]");
    assert_eq!(text(&session), original, "a preview writes nothing");
    let preview = json(&session.query("frame", "[]", r#"{"tick":0,"frameIndex":0}"#).unwrap());
    let styles = preview.get("objects").and_then(Value::elements).unwrap().iter().find(|o| o.get("unique_id").and_then(Value::as_f64) == Some(1.0)).unwrap().path(&["_stykStyle", "segments"]).cloned().unwrap();
    for handle in ["11", "22"] {
        assert_eq!(styles.path(&[handle, "opacity"]).and_then(Value::as_f64), Some(0.4), "the preview shows segment {handle}");
    }
    assert!(styles.get("33").is_none(), "and not the others");
    assert_eq!(ok(&mut session, "commitAnimationEdit", "[]"), Value::Bool(true));
    for handle in [11, 22] {
        assert_eq!(value_at(&mut session, handle, "opacity", 0), 0.4, "segment {handle} is keyed at the playhead");
    }
    assert_eq!(value_at(&mut session, 33, "opacity", 0), 1.0);
    assert_eq!(value_at(&mut session, 11, "opacity", 6), 1.0, "the other key is as it was");
    assert_eq!(state(&mut session).get("undoLabel").and_then(Value::as_str), Some("Edit layer pose"));
    ok(&mut session, "undo", "[]");
    assert_eq!(text(&session), original, "one undo takes both back");
    ok(&mut session, "redo", "[]");
    assert_eq!(value_at(&mut session, 22, "opacity", 0), 0.4);
}

#[test]
fn a_cancelled_edit_and_an_unchanged_one_leave_no_entry() {
    let mut session = session();
    let original = text(&session);
    let both = targets(&[11, 22]);
    ok(&mut session, "beginAnimationEdit", &format!(r#"[{both},"opacity",{{"exactTarget":true}}]"#));
    ok(&mut session, "previewAnimationEdit", "[0.4]");
    assert_eq!(ok(&mut session, "cancelAnimationEdit", "[]"), Value::Bool(true));
    assert_eq!(text(&session), original);
    assert_eq!(state(&mut session).get("canUndo").and_then(Value::as_bool), Some(false));
    // The value every target already has is no change.
    ok(&mut session, "beginAnimationEdit", &format!(r#"[{both},"opacity",{{"exactTarget":true}}]"#));
    ok(&mut session, "previewAnimationEdit", "[1]");
    assert_eq!(ok(&mut session, "commitAnimationEdit", "[]"), Value::Bool(false));
    assert_eq!(text(&session), original);
    assert_eq!(state(&mut session).get("canUndo").and_then(Value::as_bool), Some(false));
    // Ending an edit that is not open changes nothing.
    assert_eq!(ok(&mut session, "commitAnimationEdit", "[]"), Value::Bool(false));
}

#[test]
fn a_value_for_each_target_is_validated_before_anything_shows() {
    let mut session = session();
    let original = text(&session);
    let both = targets(&[11, 22]);
    ok(&mut session, "beginAnimationEdit", &format!(r#"[{both},"opacity",{{"exactTarget":true}}]"#));
    assert_eq!(refused(&mut session, "previewAnimationEdit", "[[0.5]]"), "errors.editorBranchStyle.everyEditedDrawableNeedsAValue");
    assert_eq!(refused(&mut session, "previewAnimationEdit", "[[0.5,2]]"), "errors.animationChannels.animationOpacityMustBeBetweenZeroAndOne");
    ok(&mut session, "previewAnimationEdit", "[[0.5,0.25]]");
    assert_eq!(ok(&mut session, "commitAnimationEdit", "[]"), Value::Bool(true));
    assert_eq!((value_at(&mut session, 11, "opacity", 0), value_at(&mut session, 22, "opacity", 0)), (0.5, 0.25));
    ok(&mut session, "undo", "[]");
    assert_eq!(text(&session), original);
    // No target, or one that is not there, is refused with the edit not begun.
    assert_eq!(refused(&mut session, "beginAnimationEdit", r#"[[],"opacity",{"exactTarget":true}]"#), "errors.editorBranchStyle.chooseABranchWithEditableOpacity");
    assert_eq!(refused(&mut session, "beginAnimationEdit", r#"[[{"kind":"segment","uid":99,"handleId":11}],"opacity",{"exactTarget":true}]"#), "errors.editorAnimation.theSelectedFigureIsNotPresentAtThis");
    assert_eq!(ok(&mut session, "cancelAnimationEdit", "[]"), Value::Bool(false), "nothing is open");
}

#[test]
fn a_draw_order_keys_a_position_for_every_drawable_and_holds_it() {
    let mut session = session();
    let all = targets(&[11, 22, 33, 44, 55, 66]);
    assert_eq!(layer_key(&session, 0.0).get("interpolation").and_then(Value::as_str), Some("linear"));
    let begun = ok(&mut session, "beginAnimationEdit", &format!(r#"[{all},"zIndex",{{"exactTarget":true}}]"#));
    assert_eq!(begun.get("initialValue").and_then(Value::elements).map(|e| e.len()), Some(6), "{begun:?}");
    ok(&mut session, "previewAnimationEdit", "[[6,5,4,3,2,1]]");
    assert_eq!(ok(&mut session, "commitAnimationEdit", "[]"), Value::Bool(true));
    for (handle, position) in [(11, 6.0), (22, 5.0), (33, 4.0), (44, 3.0), (55, 2.0), (66, 1.0)] {
        assert_eq!(value_at(&mut session, handle, "zIndex", 0), position, "the position of segment {handle}");
    }
    // Draw orders hold between keys: the key they are written in holds.
    assert_eq!(layer_key(&session, 0.0).get("interpolation").and_then(Value::as_str), Some("constant"));
    assert_eq!(state(&mut session).get("undoLabel").and_then(Value::as_str), Some("Edit layer pose"));
}

#[test]
fn an_edit_of_several_targets_is_refused_where_there_is_no_layer_sheet() {
    // A native timeline has no such edit: the call is the one the session does not answer for.
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/branch-thickness-native.document.json");
    let document = json(&std::fs::read_to_string(path).unwrap());
    let mut session = Session::start(document, r#"{"tick":0,"frameIndex":0,"selectedUid":1,"selectedUids":[1],"selectedJoint":-1,"propertyChannels":true}"#).unwrap();
    let answer = call(&mut session, "beginAnimationEdit", &format!(r#"[{},"opacity",{{"exactTarget":true}}]"#, targets(&[11])));
    assert_eq!(answer.get("status").and_then(Value::as_str), Some("unported"), "{answer:?}");
}
