//! The tweener and the Alt-drag duplicate on a document with animation origins: both are admitted, a tweened figure keeps its
//! pivot with its pose and a copy finds its pivot again where it stands.

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

fn call(session: &mut Session, method: &str, args: &str) -> Value {
    let answer = json(&session.call(method, args, "null"));
    assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"), "{method} {args}: {answer:?}");
    answer
}

fn pivot(figure: &Value) -> [f64; 2] {
    let origin = figure.get("_stykAnimationOrigin").expect("a pivot");
    [origin.get("x").and_then(Value::as_f64).unwrap(), origin.get("y").and_then(Value::as_f64).unwrap()]
}

#[test]
fn the_tweener_runs_on_a_document_with_animation_origins() {
    let mut session = session("origin-pose-layout-sheet");
    call(&mut session, "select", "[1,-1]");
    for (tick, by) in [(2, "0.3"), (8, "-0.4")] {
        call(&mut session, "seek", &format!("[{tick}]"));
        call(&mut session, "rotateSelection", &format!("[{by}]"));
    }
    call(&mut session, "seek", "[5]");
    let begun = call(&mut session, "beginTween", "[]");
    assert_eq!(styk_doc::json::to_string(begun.get("result").unwrap()), r#"{"groups":[{"previous":2,"next":8}],"figures":1}"#);
    assert_eq!(call(&mut session, "updateTween", "[0.5,\"breakdown\"]").get("result"), Some(&Value::Bool(true)));
    let pushed = call(&mut session, "updateTween", "[0.25,\"push\"]");
    assert_eq!(pushed.get("result"), Some(&Value::Bool(true)));
    let figure = pushed.get("draft").and_then(|draft| draft.item(0)).expect("the posed figure");
    assert!(pivot(&figure).iter().all(|value| value.is_finite()), "the draft keeps its pivot");
    let committed = call(&mut session, "commitDrag", "[]");
    assert_eq!(committed.get("result"), Some(&Value::Bool(true)));
    assert_eq!(committed.get("state").and_then(|state| state.get("undoLabel")).and_then(Value::as_str), Some("Tween pose"));
    let undone = call(&mut session, "undo", "[]");
    assert_eq!(undone.get("state").and_then(|state| state.get("redoLabel")).and_then(Value::as_str), Some("Tween pose"), "one undo takes the whole tween");
}

#[test]
fn a_copy_of_a_figure_with_an_animation_origin_finds_its_pivot_again_where_it_stands() {
    let mut session = session("origin-pose-layout-sheet");
    let original = session.report().get("keyframes").and_then(|frames| frames.item(0)).and_then(|frame| frame.get("objects").cloned()).and_then(|objects| objects.item(0)).unwrap();
    let start = pivot(&original);
    call(&mut session, "select", "[1,-1]");
    let begun = call(&mut session, "beginDuplicateDrag", "[]");
    assert_eq!(begun.get("result"), Some(&Value::Bool(true)));
    let copy = begun.get("drag").and_then(|drag| drag.get("before")).and_then(|ids| ids.item(0)).and_then(|id| id.as_f64()).unwrap();
    assert_ne!(copy, 1.0, "the copy has an identity of its own");
    let find = |answer: &Value| -> Value {
        let draft = answer.get("draft").expect("the gesture's draft");
        (0..draft.array_len().unwrap()).filter_map(|i| draft.item(i)).find(|figure| figure.get("unique_id").and_then(Value::as_f64) == Some(copy)).expect("the copy in the draft")
    };
    let at = pivot(&find(&begun));
    assert!((at[0] - start[0]).abs() < 1e-9 && (at[1] - start[1]).abs() < 1e-9, "a copy in place has the pivot of the figure: {at:?} against {start:?}");
    let moved = call(&mut session, "moveSelection", "[40,20]");
    let at = pivot(&find(&moved));
    assert!((at[0] - start[0] - 40.0).abs() < 1e-9 && (at[1] - start[1] - 20.0).abs() < 1e-9, "the pivot goes with the copy: {at:?}");
    assert_eq!(call(&mut session, "commitDrag", "[]").get("result"), Some(&Value::Bool(true)));
}

#[test]
fn a_figure_added_to_a_document_with_animation_origins_has_its_pivot() {
    let mut session = session("origin-pose-layout-sheet");
    let added = call(&mut session, "addFigure", "[1]");
    let figure = added.get("result").expect("the added figure");
    assert!(pivot(figure).iter().all(|value| value.is_finite()), "the pivot is placed with the figure");
    assert_eq!(call(&mut session, "undo", "[]").get("state").and_then(|state| state.get("redoLabel")).and_then(Value::as_str), Some("Add figure"));
}
