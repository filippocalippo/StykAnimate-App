//! A pose property at one value in every chosen frame (`setPoseProperty`, `pose_value.rs`) and a figure the builder created taken out
//! of the document (`discardNewFigure`, `figure_discard.rs`), on the recorded layer sheet of three figures joined in a chain
//! (figure 1 holds 2, figure 2 holds 3), keyed at ticks 0 and 6.

use styk_doc::Value;
use styk_edit::session::Session;

fn json(text: &str) -> Value { styk_doc::json::parse(text.as_bytes()).unwrap() }

fn session() -> Session {
    open(None)
}

/// The recorded document, or `document` (the saved text of an edited one), opened the way the first step opens it.
fn open(document: Option<Value>) -> Session {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/figures-sheet.reference.json");
    let reference = styk_doc::json::parse(&std::fs::read(path).unwrap()).unwrap();
    let first = reference.get("steps").unwrap().item(0).unwrap();
    let mut state = first.get("state").unwrap().as_obj().unwrap().clone();
    for (key, value) in reference.get("editor").unwrap().as_obj().unwrap().iter() { state.set(key, value.clone()); }
    Session::start(document.unwrap_or_else(|| json(first.get("document").unwrap().as_str().unwrap())), &styk_doc::json::to_string(&Value::object(state))).unwrap()
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

/// The frame on show at `tick`, and one figure of it.
fn shown(session: &mut Session, tick: u32, id: u32) -> Value {
    let frame = json(&session.query("frame", "[]", &format!(r#"{{"tick":{tick},"frameIndex":{}}}"#, usize::from(tick >= 6))).unwrap());
    frame.get("objects").and_then(Value::elements).unwrap().iter().find(|o| o.get("unique_id").and_then(Value::as_f64) == Some(id as f64)).unwrap()
}

fn number(object: &Value, key: &str) -> f64 { object.get(key).and_then(Value::as_f64).unwrap_or(f64::NAN) }

/// The chosen frames as the interface hands them over: the keyframe index with the timeline's chosen ticks.
const BOTH: &str = r#"{"@array":[0],"sheetTicks":[0,6]}"#;

#[test]
fn a_position_is_set_in_every_chosen_frame_from_where_each_stands_as_one_entry() {
    let mut session = session();
    let original = text(&session);
    ok(&mut session, "select", "[1,-1]");
    // The second key is not where the first is: each frame is brought to the value from where it stands.
    assert_eq!((number(&shown(&mut session, 0, 1), "root_x"), number(&shown(&mut session, 6, 1), "root_x")), (200.0, 240.0));
    let before = shown(&mut session, 6, 3);

    let outcome = ok(&mut session, "setPoseProperty", &format!(r#"["root_x",100,{BOTH},{{"label":"Root x"}}]"#));
    assert_eq!(outcome.get("changedFrames").and_then(Value::as_f64), Some(2.0), "{outcome:?}");
    for tick in [0, 6] {
        assert_eq!(number(&shown(&mut session, tick, 1), "root_x"), 100.0, "the value at tick {tick}");
    }
    // What hangs from the figure went with it: the third figure moved by the same amount.
    let after = shown(&mut session, 6, 3);
    assert!((number(&after, "root_x") - number(&before, "root_x") + 140.0).abs() < 1e-3, "the chain follows: {} from {}", number(&after, "root_x"), number(&before, "root_x"));
    assert_eq!(number(&after, "root_y"), number(&before, "root_y"));
    assert_eq!(state(&mut session).get("undoLabel").and_then(Value::as_str), Some("Root x in 2 frames"));
    ok(&mut session, "undo", "[]");
    assert_eq!(text(&session), original, "one undo takes both frames back");
    ok(&mut session, "redo", "[]");
    assert_eq!(number(&shown(&mut session, 6, 1), "root_x"), 100.0);
    ok(&mut session, "undo", "[]");
    assert_eq!(text(&session), original);
}

#[test]
fn the_value_every_frame_already_has_changes_nothing() {
    let mut session = session();
    ok(&mut session, "select", "[1,-1]");
    let original = text(&session);
    // The second key is already there (the first holds figures joined where they are not: they would be brought back).
    let outcome = ok(&mut session, "setPoseProperty", r#"["root_x",240,{"@array":[1],"sheetTicks":[6]},{"label":"Root x"}]"#);
    assert_eq!(outcome.get("changedFrames").and_then(Value::as_f64), Some(0.0));
    assert_eq!(text(&session), original);
    assert_eq!(state(&mut session).get("canUndo").and_then(Value::as_bool), Some(false), "no entry for nothing");
}

#[test]
fn a_rotation_a_scale_an_opacity_and_a_stacking_number_are_absolute_too() {
    let mut session = session();
    ok(&mut session, "selectMany", "[[1,2]]");
    ok(&mut session, "setPoseProperty", &format!(r#"["figure_opacity",25,{BOTH},{{"label":"Figure opacity"}}]"#));
    for tick in [0, 6] {
        for id in [1, 2] {
            assert_eq!(number(&shown(&mut session, tick, id), "field28"), 191.0, "opacity of {id} at {tick}");
        }
        assert_eq!(shown(&mut session, tick, 3).get("field28").and_then(Value::as_f64).unwrap_or(0.0), 0.0, "an unselected figure stays");
    }
    // Several figures at once: the stacking number is set on each selected figure, and zero is the figure without one.
    ok(&mut session, "setPoseProperty", &format!(r#"["figure_z_order",5,{BOTH},{{"label":"Z-index"}}]"#));
    for tick in [0, 6] {
        assert_eq!(number(&shown(&mut session, tick, 1), "_stykZIndex"), 5.0);
        assert_eq!(number(&shown(&mut session, tick, 2), "_stykZIndex"), 5.0);
        assert!(shown(&mut session, tick, 3).get("_stykZIndex").is_none());
    }
    assert_eq!(state(&mut session).get("undoLabel").and_then(Value::as_str), Some("Z-index in 2 frames"));
    ok(&mut session, "setPoseProperty", &format!(r#"["figure_z_order",0,{BOTH},{{"label":"Z-index"}}]"#));
    assert!(shown(&mut session, 0, 1).get("_stykZIndex").is_none(), "zero takes the number away");
    // The scale and the rotation of the figure on show.
    ok(&mut session, "select", "[1,-1]");
    ok(&mut session, "setPoseProperty", &format!(r#"["scale",150,{BOTH},{{"label":"Scale"}}]"#));
    assert_eq!(number(&shown(&mut session, 6, 1), "scale"), 1.5);
    assert_eq!(number(&shown(&mut session, 6, 2), "scale"), 1.0, "only the selected figure");
    let rest = session.report().get("figure_types").unwrap().item(0).unwrap().get("segments").unwrap().item(0).unwrap().get("angle_rad").and_then(Value::as_f64).unwrap_or(0.0);
    ok(&mut session, "setPoseProperty", &format!(r#"["rotation",90,{BOTH},{{"label":"Rotation"}}]"#));
    for tick in [0, 6] {
        let first = shown(&mut session, tick, 1).get("angles").unwrap().item(0).and_then(|v| v.as_f64()).unwrap();
        assert!((first - rest - std::f64::consts::FRAC_PI_2).abs() < 1e-9, "the turn of the figure at {tick}: {first}");
    }
}

#[test]
fn a_joint_is_set_in_every_chosen_frame() {
    let mut session = session();
    ok(&mut session, "select", "[1,2]");
    ok(&mut session, "setPoseProperty", &format!(r#"["joint_angle",45,{BOTH},{{"label":"Joint angle"}}]"#));
    for tick in [0, 6] {
        let angle = shown(&mut session, tick, 1).get("angles").unwrap().item(2).and_then(|v| v.as_f64()).unwrap();
        assert!((angle - std::f64::consts::FRAC_PI_4).abs() < 1e-9, "the joint of figure 1 at {tick}: {angle}");
    }
    assert_eq!(state(&mut session).get("undoLabel").and_then(Value::as_str), Some("Joint angle in 2 frames"));
    ok(&mut session, "setPoseProperty", &format!(r#"["joint_length",33,{BOTH},{{"label":"Joint length"}}]"#));
    for tick in [0, 6] {
        let figure = shown(&mut session, tick, 1);
        assert_eq!(figure.get("lengths").unwrap().item(2).and_then(|v| v.as_f64()), Some(33.0));
    }
    // A joint the selection does not have: nothing to set.
    ok(&mut session, "select", "[1,-1]");
    let outcome = ok(&mut session, "setPoseProperty", &format!(r#"["joint_bend",10,{BOTH},{{"label":"Joint bend"}}]"#));
    assert_eq!(outcome.get("changedFrames").and_then(Value::as_f64), Some(0.0));
}

#[test]
fn a_value_the_inspector_would_not_take_is_refused_before_anything_changes() {
    let mut session = session();
    ok(&mut session, "select", "[1,-1]");
    let original = text(&session);
    assert_eq!(refused(&mut session, "setPoseProperty", &format!(r#"["root_x","a lot",{BOTH},{{"label":"Root x"}}]"#)), "errors.nativePropertyEdit.enterAFiniteNumberWithinTheNativeRange");
    assert_eq!(refused(&mut session, "setPoseProperty", &format!(r#"["fps",1,{BOTH},{{"label":"Frame rate"}}]"#)), "errors.nativePropertyEdit.selectThePropertyBeforeEditingIt");
    assert_eq!(text(&session), original);
}

#[test]
fn a_figure_created_in_the_builder_leaves_every_frame_and_the_library_in_one_entry() {
    let mut session = session();
    let original = text(&session);
    ok(&mut session, "select", "[2,-1]");
    // Figure 2's definition (type 2): its instance goes from every frame, figure 3, which hung from it, stays where it was drawn.
    let figures_before = session.report().get("figure_types").and_then(Value::array_len).unwrap();
    let before = (shown(&mut session, 0, 3), shown(&mut session, 6, 3));
    assert_eq!(ok(&mut session, "discardNewFigure", r#"[2,{"label":"Discard new figure"}]"#), Value::Bool(true));
    assert_eq!(session.report().get("figure_types").and_then(Value::array_len), Some(figures_before - 1), "the definition left the library");
    for tick in [0, 6] {
        let frame = json(&session.query("frame", "[]", &format!(r#"{{"tick":{tick},"frameIndex":{}}}"#, usize::from(tick >= 6))).unwrap());
        let ids: Vec<f64> = frame.get("objects").and_then(Value::elements).unwrap().iter().filter_map(|o| o.get("unique_id").and_then(Value::as_f64)).collect();
        assert_eq!(ids, vec![1.0, 3.0], "no instance of the figure at tick {tick}");
    }
    let (first, second) = (shown(&mut session, 0, 3), shown(&mut session, 6, 3));
    for (after, was) in [(&first, &before.0), (&second, &before.1)] {
        assert!(after.get("join").is_none_or(Value::is_null), "figure 3 holds nothing any more");
        assert_eq!((number(after, "root_x"), number(after, "root_y")), (number(was, "root_x"), number(was, "root_y")), "it stays where it was drawn");
    }
    assert_eq!(state(&mut session).get("undoLabel").and_then(Value::as_str), Some("Discard new figure"));
    assert_eq!(state(&mut session).get("selectedUids").and_then(Value::elements).map(|e| e.len()), Some(0), "the discarded figure is not selected any more");
    ok(&mut session, "undo", "[]");
    assert_eq!(text(&session), original, "one undo brings back the definition and every instance");
    ok(&mut session, "redo", "[]");
    assert_eq!(session.report().get("figure_types").and_then(Value::array_len), Some(figures_before - 1));
    ok(&mut session, "undo", "[]");
    // A definition that is not there is nothing to discard.
    assert_eq!(ok(&mut session, "discardNewFigure", r#"[99,{}]"#), Value::Bool(false));
    assert_eq!(text(&session), original);
}


/// The figures of every stored frame of the document, as `(unique_id, object_slot, join target identity, join target slot)`.
fn stored_joins(session: &Session) -> Vec<Vec<(f64, f64, Option<f64>, Option<f64>)>> {
    session.report().get("keyframes").and_then(Value::elements).unwrap().iter().map(|frame| {
        frame.get("objects").and_then(Value::elements).unwrap().iter().map(|o| {
            let join = o.get("join").filter(|j| !j.is_null());
            (number(&o, "unique_id"), number(&o, "object_slot"), join.and_then(|j| j.get("target_unique_id")).and_then(Value::as_f64), join.and_then(|j| j.get("target_object_slot")).and_then(Value::as_f64))
        }).collect()
    }).collect()
}

#[test]
fn a_figure_kept_joined_to_a_kept_figure_follows_it_to_its_new_slot() {
    let mut session = session();
    let original = text(&session);
    // Figure 1's definition (type 1) leaves: figure 2, which hung from it, is detached, and figure 3 stays hung from figure 2, which now
    // stands one slot lower. A join that kept its old slot would point figure 3 at itself.
    assert_eq!(ok(&mut session, "discardNewFigure", r#"[1,{"label":"Discard new figure"}]"#), Value::Bool(true));
    let frames = stored_joins(&session);
    assert_eq!(frames.len(), 2);
    for (index, frame) in frames.iter().enumerate() {
        assert_eq!(frame, &vec![(2.0, 0.0, None, None), (3.0, 1.0, Some(2.0), Some(0.0))], "the figures that remain in frame {index}");
    }
    // The document the discard leaves is one that opens again.
    let saved = styk_doc::json::parse(text(&session).as_bytes()).unwrap();
    styk_edit::load::prepare_editor_load(saved).expect("the document after the discard can be reopened");
    assert_eq!(shown(&mut session, 6, 3).get("join").and_then(|j| j.get("target_unique_id")).and_then(Value::as_f64), Some(2.0));
    ok(&mut session, "undo", "[]");
    assert_eq!(text(&session), original, "one undo brings back the definition and every instance");
}
