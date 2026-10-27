//! A session started from the typed views the mirror made (as the app starts one) edits a
//! follow-camera document through every revision it makes, as a session started from the
//! document does: it shapes the follow paths of its own revisions itself, as far as the frame
//! on show needs, and never refuses for want of a worker's preparation.

use std::sync::Arc;
use styk_doc::Value;
use styk_edit::session::Session;

fn json(text: &str) -> Value { styk_doc::json::parse(text.as_bytes()).unwrap() }

const STATE: &str = "{\"tick\":6,\"frameIndex\":1,\"selectedUid\":1,\"selectedUids\":[1],\"selectedJoint\":-1,\"layerTimeline\":true,\"propertyChannels\":true}";

/// The same document as a mirror-started session (cold: no worker has shaped a path) and a
/// document-started one, and the mirror's typed views the first started from.
fn sessions() -> (Session, Session, Arc<styk_eval::eval::Prepared>) {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/camera-follow-handles-sheet.reference.json");
    let reference = styk_doc::json::parse(&std::fs::read(path).unwrap()).unwrap();
    let first = reference.get("steps").unwrap().item(0).unwrap();
    let report = json(first.get("document").unwrap().as_str().unwrap());
    let mut loader = styk_eval::load::Loader::new();
    let doc = loader.document(&report, "readiness").unwrap();
    let prepared = Arc::new(styk_eval::eval::Prepared::new(Arc::new(doc)));
    let mirrored = Session::start_prepared(report.clone(), STATE, loader, prepared.clone()).unwrap();
    (mirrored, Session::start(report, STATE).unwrap(), prepared)
}

/// Runs a call on both and asks for the same answer, document and history.
fn both(mirrored: &mut Session, alone: &mut Session, method: &str, args: &str) -> Value {
    let (a, b) = (json(&mirrored.call(method, args, "null")), json(&alone.call(method, args, "null")));
    assert_eq!(a, b, "{method} {args}: the mirror-started session answered differently");
    assert_eq!(mirrored.report(), alone.report(), "{method} {args}: the documents differ");
    assert_eq!((mirrored.can_undo(), mirrored.can_redo()), (alone.can_undo(), alone.can_redo()), "{method} {args}: the histories differ");
    a
}

#[test]
fn mirror_session_follows_each_revision_it_makes() {
    let (mut mirrored, mut alone, prepared) = sessions();
    assert!(prepared.travel_ready(None, 6.0).is_none(), "a worker warmed the path");
    // Three changes in a row, each a new revision with its own projection and path.
    for args in ["[1,2]", "[3,-1]", "[0,4]"] {
        let answer = both(&mut mirrored, &mut alone, "nudgeHandle", args);
        assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"), "{answer:?}");
    }
    assert!(mirrored.can_undo());
}

#[test]
fn mirror_session_runs_a_gesture_and_the_camera_commands_after_it() {
    let (mut mirrored, mut alone, _) = sessions();
    for (method, args) in [("beginDrag", "[]"), ("moveSelection", "[5,3]"), ("applyCameraToFigures", "[]"), ("cancelDrag", "[]"),
        ("beginCameraDrag", "[]"), ("updateCameraDrag", "[4,2]"), ("cancelCameraDrag", "[]"), ("nudgeHandle", "[1,2]")] {
        let answer = both(&mut mirrored, &mut alone, method, args);
        assert_ne!(answer.get("status").and_then(Value::as_str), Some("unported"), "{method} {args}: {answer:?}");
    }
}
