//! Focus and lock (docs/LAYER-FOCUS.md): the layers the interface's focus holds are locked for the session's edits as a saved lock
//! locks them, without the document, its history or its saved locks changing. The focus comes with the view of every call
//! (`layerFocusLock`, the focused layers) and holds nothing past that call.
//!
//! The tape `locked-sheet` recorded what a saved lock on the second layer refuses; the same tape on the same document with the
//! layer unlocked and held by the focus must refuse the same steps for the same reason.

use styk_doc::{Value, json};
use styk_edit::{Editor, Options, session::Session};

fn edit_folder() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit")
}

fn parse(text: &str) -> Value {
    json::parse(text.as_bytes()).unwrap()
}

/// The document of the tape `locked-sheet` with its second layer unlocked.
fn document() -> Value {
    let text = std::fs::read_to_string(edit_folder().join("sheet-locked.document.json")).unwrap();
    assert!(text.contains(r#""layer-2":{"name":"Second","visible":true,"locked":true}"#), "the tape's document locks the second layer");
    parse(&text.replace(r#""layer-2":{"name":"Second","visible":true,"locked":true}"#, r#""layer-2":{"name":"Second","visible":true,"locked":false}"#))
}

/// A session on that document, and the view the interface has of it (the playhead and selection of the last answer).
struct Run {
    session: Session,
    state: Value,
}

impl Run {
    fn new() -> Run {
        let reference = parse(&std::fs::read_to_string(edit_folder().join("locked-sheet.reference.json")).unwrap());
        let first = reference.get("steps").unwrap().item(0).unwrap();
        let mut state = first.get("state").unwrap().as_obj().unwrap().clone();
        for (key, value) in reference.get("editor").unwrap().as_obj().unwrap().iter() {
            state.set(key, value.clone());
        }
        let state = Value::object(state);
        Run { session: Session::start(document(), &json::to_string(&state)).unwrap(), state }
    }

    /// The view of a call: the playhead and selection the interface has, and the focus lock when `focus` (the focused layers) is given.
    fn view(&self, focus: Option<&[&str]>) -> String {
        let mut view = styk_doc::Obj::new();
        for key in ["tick", "frameIndex", "selectedUid", "selectedUids", "selectedJoint"] {
            view.set(key, self.state.get(key).cloned().unwrap_or(Value::Null));
        }
        if let Some(focus) = focus {
            view.set("layerFocusLock", Value::array(focus.iter().map(|id| Value::str(id)).collect()));
        }
        json::to_string(&Value::object(view))
    }

    /// The answer of a call made in the view of the interface; the playhead and selection it leaves are the next call's view.
    fn call(&mut self, focus: Option<&[&str]>, method: &str, args: &str) -> Value {
        let answer = parse(&self.session.call(method, args, &self.view(focus)));
        if let Some(state) = answer.get("state") {
            self.state = state.clone();
        }
        answer
    }

    fn refusal(&mut self, focus: Option<&[&str]>, method: &str, args: &str) -> String {
        let answer = self.call(focus, method, args);
        assert_eq!(answer.get("status").and_then(Value::as_str), Some("error"), "{method} {args} is refused: {answer:?}");
        answer.get("error").and_then(Value::as_str).unwrap().to_string()
    }

    fn ok(&mut self, focus: Option<&[&str]>, method: &str, args: &str) -> Value {
        let answer = self.call(focus, method, args);
        assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"), "{method} {args}: {answer:?}");
        answer
    }
}

const UNLOCK: &str = "errors.editorLayerSheet.unlockBeforeEditingIt";

/// The tape's calls as a session takes them (`@seek` and `@select` are the editor's own calls of the same names).
fn tape() -> Vec<(String, String, Option<String>)> {
    let reference = parse(&std::fs::read_to_string(edit_folder().join("locked-sheet.reference.json")).unwrap());
    let steps = reference.get("steps").unwrap();
    (1..steps.array_len().unwrap())
        .map(|at| {
            let step = steps.item(at).unwrap();
            let call = step.get("call").unwrap();
            let method = call.item(0).unwrap().as_str().unwrap().trim_start_matches('@').to_string();
            let args = Value::array(call.elements().unwrap().iter().skip(1).collect());
            (method, json::to_string(&args), step.path(&["error", "key"]).and_then(Value::as_str).map(str::to_string))
        })
        .collect()
}

#[test]
fn a_focus_lock_refuses_the_steps_a_saved_lock_refused() {
    let tape = tape();
    assert!(tape.iter().any(|(_, _, error)| error.is_some()), "the tape has refusals");
    let mut run = Run::new();
    let free = ["layer-1", "layer-2"];
    let held = ["layer-1"];
    // Without the lock (a focus that only filters, or none) the layer is free: nothing is refused.
    for (method, args, _) in &tape {
        run.ok(Some(&free), method, args);
    }
    let mut run = Run::new();
    let before = json::to_string(run.session.report());
    for (method, args, error) in &tape {
        match error {
            Some(key) => assert_eq!(run.refusal(Some(&held), method, args), *key, "{method} {args}"),
            None => {
                run.ok(Some(&held), method, args);
            }
        }
    }
    // The tape ends with an undo of its last edit: nothing was recorded, nothing was saved as locked. (Selecting a figure of the
    // second layer made that layer the active one, which is the selection's, not an edit's.)
    let after = json::to_string(run.session.report()).replace(r#""activeId":"layer-2""#, r#""activeId":"layer-1""#);
    assert_eq!(after, before, "the document is as it was");
    let layers = run.session.report().path(&["_styk", "layers", "byId", "layer-2", "locked"]).cloned();
    assert_eq!(layers, Some(Value::Bool(false)), "the saved lock is untouched");
}

#[test]
fn the_focus_does_not_outlive_the_view_that_carried_it() {
    let mut run = Run::new();
    run.ok(None, "select", "[3,-1]");
    assert_eq!(run.refusal(Some(&["layer-1"]), "moveSelection", "[5,5]"), UNLOCK);
    // The next view has no lock: the same call is made.
    run.ok(None, "moveSelection", "[5,5]");
    run.ok(None, "undo", "[]");
    // A focus that holds nothing back (every layer focused, Scene and Camera too).
    run.ok(Some(&["layer-1", "layer-2", "scene", "camera"]), "moveSelection", "[5,5]");
}

#[test]
fn every_check_of_the_session_holds_what_the_focus_holds() {
    let mut run = Run::new();
    let held = Some(&["layer-1"][..]);
    // The timeline's planners, for the layers and for Scene and Camera.
    for id in ["layer-2", "scene", "camera"] {
        assert_eq!(run.refusal(held, "sheetInsertKey", &format!("[[\"{id}\"],3,{{}}]")), UNLOCK, "{id}");
    }
    // Moving figures between layers and deleting a layer: the layers they come from and go to.
    assert_eq!(run.refusal(held, "assignFiguresToLayer", r#"[[1],"layer-2"]"#), UNLOCK);
    assert_eq!(run.refusal(held, "assignFiguresToLayer", r#"[[3],"layer-1"]"#), UNLOCK);
    assert_eq!(run.refusal(held, "deleteLayer", r#"["layer-2"]"#), UNLOCK);
    // A figure layer's parallax, the camera's motion, a recolor and an effect on a figure of a held layer.
    assert_eq!(run.refusal(held, "setLayerParallax", r#"["layer-2",{"enabled":true}]"#), "errors.editorCameraMotion.unlockBeforeEditingParallax");
    assert_eq!(run.refusal(held, "bakeCameraMotion", "[{}]"), "errors.editorCameraMotion.unlockCameraBeforeEditingMotion");
    assert_eq!(run.refusal(held, "editFigureColors", r#"[{"mode":"all","opacity":0.25},{"uids":[3]}]"#), "errors.editorColors.showAndUnlockTheSelectedLayersBeforeRecoloring");
    assert_eq!(run.refusal(held, "addVfx", r#"[{"kind":"figure","uid":3},"blur"]"#), "errors.editorVfx.unlockThisLayerBeforeEditingEffects");
    // What the focus leaves free is edited.
    let free = Some(&["layer-1", "layer-2", "camera"][..]);
    run.ok(free, "sheetInsertKey", r#"[["layer-1"],3,{}]"#);
    run.ok(free, "bakeCameraMotion", "[{}]");
    run.ok(free, "setLayerParallax", r#"["layer-2",{"enabled":true}]"#);
}

#[test]
fn a_layer_created_while_the_focus_is_held_is_free() {
    let report = document();
    let mut editor = Editor::new(report, Options { layer_timeline: true, property_channels: true, auto_key: false });
    editor.set_layer_focus_lock(Some(&["layer-1".to_string()]));
    let before = editor.report_json();
    let created = editor.call("createLayer", &[Value::str("Fresh")]).unwrap();
    let id = created.get("id").and_then(Value::as_str).unwrap().to_string();
    let ids = Value::array(vec![Value::str(&id)]);
    editor.call("sheetInsertKey", &[ids, Value::Num(3.0), Value::object(styk_doc::Obj::new())]).expect("the layer the call made is free");
    let held = Value::array(vec![Value::str("layer-2")]);
    assert!(editor.call("sheetInsertKey", &[held, Value::Num(3.0), Value::object(styk_doc::Obj::new())]).is_err(), "the layer it held still is");
    // The focus is never in the document, nor in what undo takes back.
    assert!(!editor.report_json().contains("layerFocus"));
    editor.call("undo", &[]).unwrap();
    editor.call("undo", &[]).unwrap();
    assert_eq!(editor.report_json(), before);
}
