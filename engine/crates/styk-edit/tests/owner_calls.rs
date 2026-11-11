//! What the interface's owner tells the session besides the editor's calls (`owner.rs`, `preview.rs`, `args.rs`): the
//! bookkeeping calls, the live previews of a camera-motion clip and a layer's parallax, and the arguments JSON cannot say.

use styk_doc::Value;
use styk_edit::session::Session;

fn json(text: &str) -> Value { styk_doc::json::parse(text.as_bytes()).unwrap() }

fn session(name: &str) -> Session {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../tests/edit/{name}.reference.json"));
    let reference = styk_doc::json::parse(&std::fs::read(path).unwrap()).unwrap();
    let first = reference.get("steps").unwrap().item(0).unwrap();
    let mut state = first.get("state").unwrap().as_obj().unwrap().clone();
    for (key, value) in reference.get("editor").unwrap().as_obj().unwrap().iter() { state.set(key, value.clone()); }
    Session::start(json(first.get("document").unwrap().as_str().unwrap()), &styk_doc::json::to_string(&Value::object(state))).unwrap()
}

fn call_with(session: &mut Session, method: &str, args: &str, view: &str) -> Value { json(&session.call(method, args, view)) }
fn answer(session: &mut Session, method: &str, args: &str) -> Value { call_with(session, method, args, "null") }

fn ok(session: &mut Session, method: &str, args: &str) -> Value {
    let answer = answer(session, method, args);
    assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"), "{method} {args}: {answer:?}");
    answer.get("result").cloned().unwrap_or(Value::Null)
}

fn refused(session: &mut Session, method: &str, args: &str) -> String {
    let answer = answer(session, method, args);
    assert_eq!(answer.get("status").and_then(Value::as_str), Some("error"), "{method} {args}: {answer:?}");
    answer.get("error").and_then(Value::as_str).unwrap().to_string()
}

fn state(session: &mut Session) -> Value { answer(session, "seek", "[0]").get("state").cloned().unwrap() }

const FOLLOW: &str = "motion-00000000-0000-4000-8000-000000000001";

#[test]
fn a_document_marked_changed_has_a_new_revision_and_no_history_entry() {
    let mut session = session("camera-motion-sheet");
    let before = session.revision();
    ok(&mut session, "@markSaved", "[]");
    assert_eq!(state(&mut session).get("dirty").and_then(Value::as_bool), Some(false));
    ok(&mut session, "@touch", "[]");
    assert!(session.revision() > before, "a new revision");
    let after = state(&mut session);
    assert_eq!(after.get("dirty").and_then(Value::as_bool), Some(true));
    assert_eq!(after.get("canUndo").and_then(Value::as_bool), Some(false), "nothing to undo");
    ok(&mut session, "@markSaved", "[]");
    assert_eq!(state(&mut session).get("dirty").and_then(Value::as_bool), Some(false));
}

#[test]
fn a_clip_preview_shows_without_a_history_entry_and_is_put_back() {
    let mut session = session("camera-motion-sheet");
    let original = styk_doc::json::to_string(session.report());
    let strength = |session: &Session| session.report().path(&["_styk", "cameraMotion", "clips"]).and_then(Value::elements).unwrap().iter()
        .find(|clip| clip.get("id").and_then(Value::as_str) == Some(FOLLOW)).and_then(|clip| clip.path(&["params", "strength"]).and_then(Value::as_f64));
    assert_eq!(strength(&session), Some(1.0));
    assert_eq!(ok(&mut session, "previewCameraMotion", &format!(r#"["{FOLLOW}",{{"params":{{"strength":1.8}}}}]"#)), Value::Bool(true));
    assert_eq!(strength(&session), Some(1.8), "shown in the document");
    // The next move starts from the clip as it was, not from the last preview.
    ok(&mut session, "previewCameraMotion", &format!(r#"["{FOLLOW}",{{"enabled":false}}]"#));
    assert_eq!(strength(&session), Some(1.0));
    assert_eq!(state(&mut session).get("canUndo").and_then(Value::as_bool), Some(false), "no history entry");
    assert_eq!(ok(&mut session, "cancelDocumentPreview", "[]"), Value::Bool(true));
    assert_eq!(styk_doc::json::to_string(session.report()), original, "the document as it was");
    assert_eq!(ok(&mut session, "cancelDocumentPreview", "[]"), Value::Bool(false), "nothing is open");
}

#[test]
fn a_preview_the_next_edit_ends_leaves_that_edit_recorded_from_the_original() {
    let mut session = session("camera-motion-sheet");
    let original = styk_doc::json::to_string(session.report());
    ok(&mut session, "previewCameraMotion", &format!(r#"["{FOLLOW}",{{"params":{{"strength":1.8}}}}]"#));
    // Committing the edit the preview showed: one entry whose undo gives the clip as it was before the preview.
    ok(&mut session, "setCameraMotion", &format!(r#"["{FOLLOW}",{{"params":{{"strength":1.8}}}}]"#));
    assert_eq!(state(&mut session).get("undoLabel").and_then(Value::as_str), Some("Edit camera motion"));
    ok(&mut session, "undo", "[]");
    assert_eq!(styk_doc::json::to_string(session.report()), original);
    assert_eq!(state(&mut session).get("canUndo").and_then(Value::as_bool), Some(false), "the preview left no entry of its own");
    // Selecting does not end a preview; another edit does.
    ok(&mut session, "previewCameraMotion", &format!(r#"["{FOLLOW}",{{"params":{{"strength":1.8}}}}]"#));
    ok(&mut session, "seek", "[1]");
    assert_ne!(styk_doc::json::to_string(session.report()), original);
    ok(&mut session, "setCanvasSize", "[321,240]");
    ok(&mut session, "undo", "[]");
    assert_eq!(styk_doc::json::to_string(session.report()), original, "the field was put back before the edit was recorded");
}

#[test]
fn a_refused_preview_changes_nothing_and_a_clip_must_exist() {
    let mut session = session("camera-motion-sheet");
    let original = styk_doc::json::to_string(session.report());
    assert_eq!(refused(&mut session, "previewCameraMotion", r#"["nope",{"enabled":false}]"#), "errors.editorCameraMotion.selectACameraMotionClip");
    assert_eq!(refused(&mut session, "previewCameraMotion", &format!(r#"["{FOLLOW}",{{"bogus":1}}]"#)), "errors.editorCameraMotion.unsupportedCameraMotionProperty");
    assert_eq!(styk_doc::json::to_string(session.report()), original);
}

#[test]
fn a_parallax_preview_shows_the_layers_response_and_is_put_back() {
    let mut session = session("figure-clipboard-sheet");
    let original = styk_doc::json::to_string(session.report());
    let parallax = |session: &Session| session.report().path(&["_styk", "layers", "byId", "layer-1", "parallax"]).cloned();
    assert!(parallax(&session).is_none());
    ok(&mut session, "previewLayerParallax", r#"["layer-1",{"x":0.45,"y":0.45}]"#);
    assert_eq!(parallax(&session).and_then(|p| p.get("x").and_then(Value::as_f64)), Some(0.45));
    assert_eq!(state(&mut session).get("canUndo").and_then(Value::as_bool), Some(false), "no history entry");
    assert_eq!(ok(&mut session, "cancelDocumentPreview", "[]"), Value::Bool(true));
    assert_eq!(styk_doc::json::to_string(session.report()), original);
    // Committed: one entry, and the original comes back with it.
    ok(&mut session, "previewLayerParallax", r#"["layer-1",{"x":0.15}]"#);
    ok(&mut session, "setLayerParallax", r#"["layer-1",{"x":0.15}]"#);
    assert_eq!(parallax(&session).and_then(|p| p.get("x").and_then(Value::as_f64)), Some(0.15));
    ok(&mut session, "undo", "[]");
    assert_eq!(styk_doc::json::to_string(session.report()), original);
    assert_eq!(refused(&mut session, "previewLayerParallax", r#"["nope",{"x":1}]"#), "errors.editorCameraMotion.selectAFigureLayerForParallax");
}

#[test]
fn a_non_finite_number_is_refused_as_the_editor_refuses_it_never_read_as_missing() {
    let mut session = session("figure-clipboard-sheet");
    let original = styk_doc::json::to_string(session.report());
    let view = r#"{"encoded":true}"#;
    // Encoded as the owner encodes NaN in an option object.
    let nan = call_with(&mut session, "setCanvasSize", r#"[{"@number":"NaN"},240]"#, view);
    assert_eq!(nan.get("status").and_then(Value::as_str), Some("error"));
    assert_eq!(nan.get("error").and_then(Value::as_str), Some("errors.editor.canvasDimensionsMustBe1100000Pixels"));
    let infinite = call_with(&mut session, "setFPS", r#"[{"@number":"Infinity"}]"#, view);
    assert_eq!(infinite.get("error").and_then(Value::as_str), Some("errors.editor.fpsMustBeAnIntegerBetween1And"));
    assert_eq!(styk_doc::json::to_string(session.report()), original);
    // Without the flag the text is data like any other.
    assert_eq!(answer(&mut session, "setFPS", r#"[{"@number":"NaN"}]"#).get("error").and_then(Value::as_str), Some("errors.editor.fpsMustBeAnIntegerBetween1And"));
}

#[test]
fn a_member_set_to_undefined_is_absent_for_the_commands_that_do_not_read_it() {
    // (setRigBehavior reads it: tests/rig-angle-path.test.mjs takes a rig path's pitch away through the owner, and
    // `merged` in rig_behavior.rs has its own test.)
    let mut session = session("figure-clipboard-sheet");
    let project = call_with(&mut session, "updateProject", r#"[{"fps":24,"canvas_width":{"@undefined":true}}]"#, r#"{"encoded":true}"#);
    assert_eq!(project.get("status").and_then(Value::as_str), Some("ok"), "{project:?}");
    assert_eq!(session.report().get("fps").and_then(Value::as_f64), Some(24.0));
    // Without the flag the marker is an object like any other, and the project refuses it.
    let plain = answer(&mut session, "updateProject", r#"[{"fps":25,"canvas_width":{"@undefined":true}}]"#);
    assert_eq!(plain.get("status").and_then(Value::as_str), Some("error"), "{plain:?}");
}

#[test]
fn a_rig_member_set_to_undefined_is_taken_away_and_the_encoding_is_never_stored() {
    let mut session = session("origin-angle-lock-layout-sheet");
    let view = r#"{"encoded":true,"selectedUid":1,"selectedUids":[1],"selectedJoint":4}"#;
    let rig = |session: &Session| session.report().get("figure_types").and_then(|f| f.item(0)).and_then(|f| f.get("segments").and_then(|s| s.item(4))).and_then(|s| s.get("_stykRig").cloned());
    let set = call_with(&mut session, "setRigBehavior", r#"[{"response":{"mode":"rigid"},"orientation":"world"}]"#, view);
    assert_eq!(set.get("status").and_then(Value::as_str), Some("ok"), "{set:?}");
    assert!(rig(&session).unwrap().get("response").is_some());
    // The editor deleted what a falsy member named: `undefined` is falsy as `null` is.
    for member in ["response", "orientation"] {
        let removed = call_with(&mut session, "setRigBehavior", &format!(r#"[{{"{member}":{{"@undefined":true}}}}]"#), view);
        assert_eq!(removed.get("status").and_then(Value::as_str), Some("ok"), "{member}: {removed:?}");
        assert!(rig(&session).and_then(|rig| rig.get(member).cloned()).is_none(), "{member} is gone");
        assert!(!styk_doc::json::to_string(session.report()).contains("@undefined"), "{member} left the encoding in the document");
    }
    // A member inside a merged one: the old value of that member alone goes.
    call_with(&mut session, "setRigBehavior", r#"[{"response":{"mode":"rigid","multiplier":2}}]"#, view);
    let merged = call_with(&mut session, "setRigBehavior", r#"[{"response":{"multiplier":{"@undefined":true}}}]"#, view);
    assert_eq!(merged.get("status").and_then(Value::as_str), Some("ok"), "{merged:?}");
    assert_eq!(styk_doc::json::to_string(&rig(&session).unwrap().get("response").cloned().unwrap()), r#"{"mode":"rigid"}"#);
    assert!(!styk_doc::json::to_string(session.report()).contains("@undefined"));
}
