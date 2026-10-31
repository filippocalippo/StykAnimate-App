//! A draw-order edit on a layer sheet (the inspector's draw order of every drawable, `beginAnimationEdit([targets], "zIndex")`, and the
//! move buttons, `moveBuilderOrder`) keys the layer whatever easing its keys have: the key it is written in holds the order and is a
//! valid key (a bezier key written over loses its curve), every other key keeps its easing, and one undo takes the edit back.
//! The sheet is the recorded one of three figures keyed at ticks 0 and 6; the sweep also keys tick 9.

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

fn state(session: &mut Session) -> Value { call(session, "seek", "[0]").get("state").cloned().unwrap() }

fn undo_label(session: &mut Session) -> String { state(session).get("undoLabel").and_then(Value::as_str).unwrap().to_string() }

fn text(session: &Session) -> String { styk_doc::json::to_string(session.report()) }

fn target(handle: u32) -> String { format!(r#"{{"kind":"segment","uid":1,"handleId":{handle},"figureTypeId":1}}"#) }

fn targets() -> String { format!("[{}]", [11, 22, 33, 44, 55, 66].map(target).join(",")) }

fn value_at(session: &mut Session, handle: u32, tick: u32) -> f64 {
    let answer = json(&session.query("animationValue", &format!(r#"[{},"zIndex",{tick}]"#, target(handle)), r#"{"tick":0,"frameIndex":0}"#).unwrap());
    answer.get("v").and_then(Value::as_f64).unwrap_or(f64::NAN)
}

/// The keys of the sheet's first layer, as `(tick, easing)` where the easing is the key's interpolation and curve as written.
fn easings(session: &Session) -> Vec<(f64, String)> {
    let keys = session.report().path(&["_styk", "layerSheet", "tracks", "layer-1", "keys"]).unwrap();
    keys.elements().unwrap().iter().map(|key| {
        let curve = key.get("bezier").map(|b| styk_doc::json::to_string(b)).unwrap_or_default();
        (key.get("tick").and_then(Value::as_f64).unwrap(), format!("{}{curve}", key.get("interpolation").and_then(Value::as_str).unwrap_or("?")))
    }).collect()
}

const BEZIER: &str = r#"{"interpolation":"bezier","bezier":[0.1,0.2,0.3,0.9]}"#;

/// The sheet with its layer keys at `ticks` (0 and 6, and 9 when asked) eased as `modes` say.
fn keyed(ticks: &[u32], modes: &[&str]) -> Session {
    let mut session = session();
    if ticks.contains(&9) {
        ok(&mut session, "sheetInsertKey", r#"[["layer-1"],9]"#);
    }
    for (tick, mode) in ticks.iter().zip(modes) {
        let easing = match *mode {
            "bezier" => BEZIER.to_string(),
            other => format!(r#"{{"interpolation":"{other}"}}"#),
        };
        ok(&mut session, "sheetSetEasing", &format!(r#"[["layer-1"],{tick},{tick},{easing}]"#));
    }
    session
}

/// The draw-order edit `how` at `tick` on a sheet keyed as given, checked; the problems found, if any.
fn check(ticks: &[u32], modes: &[&str], tick: u32, how: &str) -> Vec<String> {
    let name = format!("keys {ticks:?} {modes:?}, {how} at {tick}");
    let mut session = keyed(ticks, modes);
    let (before, label, curves) = (text(&session), undo_label(&mut session), easings(&session));
    ok(&mut session, "seek", &format!("[{tick}]"));
    // Segment 33 is the third drawable; the button raises it to the front, the inspector reverses the order.
    let (moved, front) = (33, 6.0);
    let answer = match how {
        "inspector" => {
            let _ = ok(&mut session, "beginAnimationEdit", &format!(r#"[{},"zIndex",{{"exactTarget":true}}]"#, targets()));
            ok(&mut session, "previewAnimationEdit", "[[6,5,4,3,2,1]]");
            call(&mut session, "commitAnimationEdit", "[]")
        }
        _ => call(&mut session, "moveBuilderOrder", r#"[{"kind":"segment","index":2},"front"]"#),
    };
    if answer.get("status").and_then(Value::as_str) != Some("ok") || answer.get("result") != Some(&Value::Bool(true)) {
        return vec![format!("{name}: refused or unchanged: {:?}", answer.get("error").or(answer.get("result")))];
    }
    let mut problems = Vec::new();
    let expected = if how == "inspector" { 4.0 } else { front };
    if value_at(&mut session, moved, tick) != expected {
        problems.push(format!("{name}: the order is not kept"));
    }
    // Exactly one key is written (the key at the playhead, or the held key it edits): constant and with no curve; the others are as they were.
    let after = easings(&session);
    let changed: Vec<&(f64, String)> = after.iter().filter(|key| !curves.contains(key)).collect();
    if changed.len() > 1 || changed.iter().any(|(_, easing)| easing != "constant") {
        problems.push(format!("{name}: keys written {changed:?}, were {curves:?}"));
    }
    if curves.iter().filter(|(at, _)| changed.iter().all(|(written, _)| written != at)).any(|key| !after.contains(key)) {
        problems.push(format!("{name}: a neighbour's easing changed: {after:?} from {curves:?}"));
    }
    let done = text(&session);
    if undo_label(&mut session) == label {
        problems.push(format!("{name}: no entry"));
    }
    ok(&mut session, "undo", "[]");
    if text(&session) != before || undo_label(&mut session) != label {
        problems.push(format!("{name}: one undo does not take it back"));
    }
    ok(&mut session, "redo", "[]");
    if text(&session) != done {
        problems.push(format!("{name}: redo does not bring it back"));
    }
    problems
}

#[test]
fn a_draw_order_edit_commits_one_entry_whatever_easing_the_layer_keys_have() {
    let modes = ["linear", "bezier", "hold"];
    let mut problems = Vec::new();
    let mut cases = 0;
    for how in ["inspector", "buttons"] {
        for first in modes {
            for second in modes {
                for tick in [0, 3, 6] {
                    cases += 1;
                    problems.extend(check(&[0, 6], &[first, second], tick, how));
                }
                for third in modes {
                    for tick in [0, 6, 9] {
                        cases += 1;
                        problems.extend(check(&[0, 6, 9], &[first, second, third], tick, how));
                    }
                }
            }
        }
    }
    assert!(problems.is_empty(), "{} of {cases} cases:\n{}", problems.len(), problems.join("\n"));
}

#[test]
fn the_exact_case_of_a_bezier_key_under_the_playhead() {
    // Two layer keys, linear then bezier, the playhead on the bezier one: the draw order of one drawable raised to the front.
    let mut session = keyed(&[0, 6], &["linear", "bezier"]);
    assert_eq!(easings(&session), [(0.0, "linear".to_string()), (6.0, "bezier[0.1,0.2,0.3,0.9]".to_string())]);
    ok(&mut session, "seek", "[6]");
    assert_eq!(ok(&mut session, "moveBuilderOrder", r#"[{"kind":"segment","index":2},"front"]"#), Value::Bool(true));
    assert_eq!(easings(&session), [(0.0, "linear".to_string()), (6.0, "constant".to_string())], "the key holds the order, the other key is as it was");
    assert_eq!(value_at(&mut session, 33, 6), 6.0);
}
