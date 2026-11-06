//! Playback across every frame of a clip timed by the document's clock, run by a session call (no worker context): the layer sheet
//! is first expanded to poses, as the timed-sheet worker expands it, so the document, state and events are the worker's.
use std::path::Path;
use styk_doc::{Value, json};
use styk_edit::{Editor, Options, Selection, movieclip_planning::TimelineWorker};

fn editor(name: &str) -> Editor {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/movieclip-timed-sheet-commands");
    let report = json::parse(&std::fs::read(folder.join(format!("{name}.document.json"))).unwrap()).unwrap();
    let mut editor = Editor::new(report, Options { property_channels: true, layer_timeline: true, auto_key: false });
    editor.set_view(2.75, 0, Selection { uid: Some(1), uids: vec![1], joint: -1 });
    editor.set_counters(0, 1, 2);
    editor
}

fn args(patch: &str, options: &str) -> [Value; 2] {
    [json::parse(patch.as_bytes()).unwrap(), json::parse(options.as_bytes()).unwrap()]
}

#[test]
fn a_session_call_prepares_a_timed_sheet_as_the_worker_does() {
    for name in ["playback-authored", "playback-imported"] {
        let (mut session, mut worker) = (editor(name), editor(name));
        let calls: [(&str, Vec<Value>); 3] = [
            ("setMovieclipPlayback", args(r#"{"mode":"single","offset":2.5}"#, r#"{"allFrames":true}"#).to_vec()),
            ("restartMovieclip", vec![]),
            ("removeMovieclipRestart", vec![]),
        ];
        for (method, arguments) in calls {
            let answered = session.call(method, &arguments).unwrap_or_else(|error| panic!("{name} {method}: {error}"));
            let (mut check, mut progress) = (|| Ok(()), |_| {});
            let expected = worker
                .call_movieclip_timeline_worker(method, &arguments, &mut TimelineWorker { max_source_bytes: usize::MAX, check: &mut check, progress: &mut progress, clock: || 0.0 })
                .unwrap_or_else(|error| panic!("{name} {method} on the worker: {error}"));
            assert_eq!(json::to_string(&answered), json::to_string(&expected), "{name} {method} answer");
            assert_eq!(session.report_json(), worker.report_json(), "{name} {method} document");
            assert_eq!(json::to_string(&session.state_value()), json::to_string(&worker.state_value()), "{name} {method} state");
            assert_eq!(session.take_events().len(), worker.take_events().len(), "{name} {method} events");
            // The clip's seek moves on the way: both stand at the same tick.
            if method == "restartMovieclip" {
                session.call("@seek", &[Value::Num(3.0)]).unwrap();
                worker.call("@seek", &[Value::Num(3.0)]).unwrap();
            }
        }
        for _ in 0..3 {
            assert_eq!(session.call("undo", &[]).unwrap(), worker.call("undo", &[]).unwrap());
        }
        assert_eq!(session.report_json(), worker.report_json(), "{name} undone");
    }
}
