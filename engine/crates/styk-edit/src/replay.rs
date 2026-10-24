//! The command-replay harness, engine side (docs/engine/editing.md): runs a reference
//! recorded by `engine/tools/edit-replay.mjs` in an [`Editor`] and compares, after
//! every step, the document's bytes, the playhead, the selection, history and the
//! change events with what the JavaScript editor did.

use styk_doc::Value;

use crate::{EditError, Editor, Options, Selection};

mod live;
pub use live::replay_session_live_worker;

/// What a replay found.
#[derive(Debug, Default)]
pub struct Outcome {
    pub scenario: String,
    /// Steps in the reference (not counting the loaded document).
    pub steps: usize,
    /// Steps that ran in the engine and matched.
    pub matched: usize,
    /// The first step the engine does not run yet, and why. Later steps are not compared.
    pub unported: Option<(usize, String)>,
    /// Differences, one line each. A replay stops at the first step with one.
    pub mismatches: Vec<String>,
}

impl Outcome {
    pub fn passed(&self) -> bool {
        self.mismatches.is_empty()
    }
}

/// Replays `reference` (the JSON the JavaScript side wrote).
pub fn replay(reference: &Value) -> Result<Outcome, String> {
    replay_with_worker(reference, false, 128 * 1024 * 1024)
}

/// Native/offline verification of recorded native/sheet worker commands using their existing
/// worker preparation owner. This is not UI admission: the calling thread may
/// perform dense preparation. Results use the same every-step comparisons.
pub fn replay_worker(reference: &Value) -> Result<Outcome, String> {
    replay_worker_with_source_budget(reference, 128 * 1024 * 1024)
}

/// Explicit native/offline host budget; this never changes runtime/UI limits.
/// The ordinary replay worker retains its 128 MiB default.
pub fn replay_worker_with_source_budget(reference: &Value, max_source_bytes: usize) -> Result<Outcome, String> {
    if max_source_bytes == 0 { return Err("offline source budget must be positive".into()); }
    replay_with_worker(reference, true, max_source_bytes)
}

fn replay_with_worker(reference: &Value, worker: bool, max_source_bytes: usize) -> Result<Outcome, String> {
    let steps: Vec<Value> = reference.get("steps").and_then(Value::elements).ok_or("the reference has no steps")?.iter().collect();
    let first = steps.first().ok_or("the reference has no steps")?;
    let mut expected = first.get("document").and_then(Value::as_str).ok_or("step 0 has no document")?.to_string();
    let report = styk_doc::json::parse(expected.as_bytes()).map_err(|error| error.to_string())?;
    let flag = |key: &str| reference.path(&["editor", key]).is_some_and(Value::truthy);
    let mut editor = Editor::new(report, Options { property_channels: flag("propertyChannels"), layer_timeline: flag("layerTimeline"), auto_key: flag("autoKey") });
    let state = first.get("state").ok_or("step 0 has no state")?;
    let selected = state.get("selectedUid").and_then(Value::as_f64).map(|v| v as u32);
    let uids = state.get("selectedUids").and_then(Value::numbers).unwrap_or_default().into_iter().map(|v| v as u32).collect();
    editor.set_view(
        state.get("tick").and_then(Value::as_f64).unwrap_or(0.0),
        state.get("frameIndex").and_then(Value::as_f64).unwrap_or(0.0) as usize,
        Selection { uid: selected, uids, joint: state.get("selectedJoint").and_then(Value::as_f64).unwrap_or(-1.0) as i64 },
    );
    let counter = |key: &str| state.get(key).and_then(Value::as_f64).unwrap_or(0.0) as u64;
    editor.set_counters(counter("layerRevision"), counter("nextFrameIdentity"), counter("nextUid"));
    let mut history_ready = !reference.path(&["initialHistory", "ready"]).is_some_and(|value| matches!(value,Value::Bool(false)));
    if let Some(history) = reference.get("initialHistory") {
        let counter = |key: &str| history.get(key).and_then(Value::as_f64).unwrap_or(0.0) as u64;
        editor.set_revision_counters(counter("revision"),counter("revisionSerial"),counter("savedRevision"));
        let limits = crate::HistoryLimits { count: history.get("limit").and_then(Value::as_f64).unwrap_or(80.0) as usize, bytes: history.get("bytes").and_then(Value::as_f64).unwrap_or(48.0*1024.0*1024.0) };
        if history_ready { editor.configure_worker_history(limits).map_err(|error|format!("history settings: {error:?}"))?; }
        else { editor.history_limits = limits; }
    }
    editor.set_selection_metadata(state).map_err(|error| format!("{error:?}"))?;
    let mut outcome = Outcome { scenario: reference.get("scenario").and_then(Value::as_str).unwrap_or("").to_string(), steps: steps.len() - 1, ..Outcome::default() };
    if editor.report_json() != expected {
        outcome.mismatches.push("step 0: the loaded document does not survive the engine's store byte for byte".into());
        return Ok(outcome);
    }
    // Opt-in audit is retained outside transaction snapshots, exactly like the
    // editor recording wrapper: it sees successful _record calls even when an
    // enclosing editor batch later rolls back. Normal editor calls allocate none.
    let record_capture = steps.iter().any(|step| step.get("records").is_some());
    if record_capture { editor.replay_records = Some(Vec::new()); }
    let captured_history = |step: &Value| {
        let history = step.get("history");
        let kinds = history.into_iter().flat_map(|value| [value.get("undo"),value.get("redo")]).flatten().filter_map(Value::elements).flat_map(|values|values.iter()).any(|entry| entry.get("kind").is_some());
        (kinds, !kinds)
    };
    if let Some(selection) = first.get("selection") {
        if json(&editor.selection_state().history_value()) != json(selection) { outcome.mismatches.push("step 0: selection differs".into()); return Ok(outcome); }
    }
    if let Some(history) = first.get("history") {
        let (kinds,children) = captured_history(first);
        if json(&editor.history_value_shape(kinds,children)) != json(history) { outcome.mismatches.push("step 0: history differs".into()); return Ok(outcome); }
    }
    let mut native_token = Value::Null;
    for step in &steps[1..] {
        let number = step.get("step").and_then(Value::as_f64).unwrap_or(0.0) as usize;
        // An awaited recording can contain another real editor call during a
        // yield. The offline owner cannot reproduce that concurrent writer yet;
        // refuse its explicit capability before executing or changing anything.
        if let Some(interleavings) = step.get("interleavings") {
            let calls = interleavings.elements().ok_or_else(|| format!("step {number}: interleavings must be an array"))?;
            if !calls.is_empty() {
                outcome.unported = Some((number, "recorded interleaved editor calls require the canonical actor".into()));
                return Ok(outcome);
            }
        }
        let call: Vec<Value> = step.get("call").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
        let method = call.first().and_then(Value::as_str).unwrap_or("").to_string();
        editor.set_draws(step.get("draws").unwrap_or(&Value::Null));
        if let Some(records) = editor.replay_records.as_mut() { records.clear(); }
        // A replay-only read verifies the live pose using the existing snapshot owner.
        // Every step also checks the read view's patch (D19): the operations from the
        // document before to the document after rebuild the document after.
        let previous = editor.report().clone();
        let result = if method == "@historyLimits" {
            editor.configure_worker_history(crate::HistoryLimits { count:call.get(1).and_then(Value::as_f64).unwrap_or(80.0) as usize,bytes:call.get(2).and_then(Value::as_f64).unwrap_or(48.0*1024.0*1024.0) }).map(|_|Value::Null)
        } else if method == "@trimHistory" {
            editor.trim_worker_history().map(|_|Value::Null)
        } else if method == "@prepareHistory" {
            editor.prepare_worker_history(crate::HistoryLimits { count:call.get(1).and_then(Value::as_f64).unwrap_or(80.0) as usize,bytes:call.get(2).and_then(Value::as_f64).unwrap_or(48.0*1024.0*1024.0) },call.get(3).and_then(Value::as_f64).unwrap_or(f64::NAN),||Ok(())).map(|_|Value::Null)
        } else if method == "@frame" {
            editor.shown_frame().map(|frame| Value::str(&styk_doc::json::to_string(&styk_eval::records::snapshot_pose_frame(&frame))))
        } else if method == "@motionFrame" {
            editor.motion_display_frame_worker().and_then(|display| display.map_or_else(|| editor.shown_frame(), Ok))
                .map(|frame| Value::str(&styk_doc::json::to_string(&styk_eval::records::snapshot_pose_frame(&frame))))
        } else if method == "@selection" {
            Ok(Value::str(&styk_doc::json::to_string(&editor.selection_state().history_value())))
        } else if method == "@restoreSelection" {
            let value = call.get(1).unwrap_or(&Value::Null);
            let selection = crate::select::selection_state_of(value);
            editor.restore_selection(&selection).map(|()| Value::Null)
        } else if method == "@cameraAtTime" {
            editor.shown_frame().and_then(|frame| editor.camera_at_time(&frame, editor.tick)).map(|camera| camera.unwrap_or(Value::Null))
        } else if method.starts_with("@native") {
            let arg = |i: usize| call.get(i).cloned().unwrap_or(Value::Null);
            let (name, args) = match method.as_str() {
                "@nativeBegin" => ("beginNativePropertyEdit", call[1..].to_vec()),
                "@nativePreview" => ("previewNativePropertyEdit", vec![call.get(2).cloned().unwrap_or_else(|| native_token.clone()), arg(1)]),
                "@nativeCommit" => ("commitNativePropertyEdit", vec![call.get(1).cloned().unwrap_or_else(|| native_token.clone())]),
                "@nativeCancel" => ("cancelNativePropertyEdit", vec![call.get(1).cloned().unwrap_or_else(|| native_token.clone())]),
                "@nativeGet" => ("getNativePropertyValue", call[1..].to_vec()),
                "@nativeCan" => ("canEditNativeProperty", call[1..].to_vec()),
                _ => (method.as_str(), call[1..].to_vec()),
            };
            let result = editor.call(name, &args);
            if method == "@nativeBegin" && let Ok(value) = &result { native_token = value.get("token").cloned().unwrap_or(Value::Null); }
            result
        } else {
            let measured: Option<Vec<Value>> = step.get("boundsArgs").and_then(Value::elements).map(|e| e.iter().collect());
            let args = measured.as_deref().unwrap_or(&call[1..]);
            if worker && editor.movieclip_timeline_replay_call(&method, args) {
                editor.call_movieclip_timeline_worker(&method, args, &mut crate::movieclip_planning::TimelineWorker {
                    max_source_bytes,
                    check: &mut || Ok(()),
                    progress: &mut |_| {},
                    clock: || 0.0,
                })
            } else { editor.call(&method, args) }
        };
        let mut differences = Vec::new();
        let recorded_error = step.get("error").filter(|e| !e.is_null());
        match (&result, recorded_error) {
            (Err(EditError::Unported(what)), _) => {
                outcome.unported = Some((number, what.clone()));
                return Ok(outcome);
            }
            (Err(EditError::Invalid(key)), Some(error)) => {
                let recorded = error.get("key").and_then(Value::as_str).or_else(|| error.get("message").and_then(Value::as_str)).unwrap_or("");
                if recorded != crate::error_key(key) {
                    differences.push(format!("error {key}, the editor's was {recorded}"));
                }
            }
            (Err(EditError::Invalid(key)), None) => differences.push(format!("error {key}, the editor succeeded")),
            (Ok(_), Some(error)) => differences.push(format!("succeeded, the editor failed with {}", error.get("key").and_then(Value::as_str).unwrap_or("an error"))),
            (Ok(value), None) => {
                // These return the evaluated frame, the editor's own clipboard or property edit: views the facade reads from its own copy.
                if !["seek", "@seek", "sheetAppendFrame", "sheetCopyFrames", "beginAnimationEdit"].contains(&method.as_str()) {
                    let got = json(&plain(value, 4).unwrap_or(Value::Null));
                    let want = json(step.get("result").unwrap_or(&Value::Null));
                    if got != want {
                        differences.push(format!("returned {}, the editor {}", short(&got), short(&want)));
                    }
                }
            }
        }
        if let Some(document) = step.get("document").and_then(Value::as_str) {
            expected = document.to_string();
        }
        match crate::patch::apply(&previous, &crate::patch::diff(&previous, editor.report())) {
            Ok(patched) if patched == *editor.report() => {}
            Ok(_) => differences.push("the document patch does not rebuild the document".into()),
            Err(error) => differences.push(format!("the document patch does not apply: {error}")),
        }
        let actual = editor.report_json();
        if actual != expected {
            differences.push(format!("document differs: {}", first_difference(&actual, &expected)));
        }
        let got = json(&editor.state_value());
        let want = json(step.get("state").unwrap_or(&Value::Null));
        if got != want {
            differences.push(format!("state {got}, the editor's {want}"));
        }
        if method == "@prepareHistory" && result.is_ok() { history_ready = true; }
        if let Some(history) = step.get("history") {
            // An explicitly unprepared owner still verifies labels, children,
            // stack membership and epochs at each step. Bytes become exact only
            // after its recorded worker checkpoint; existing probes stay exact.
            fn unprepared(value: &Value) -> Value {
                match value {
                    Value::Obj(object) => Value::object(object.iter().filter(|(key,_)| &***key != "bytes" && &***key != "size").map(|(key,value)|(key.clone(),unprepared(value))).collect()),
                    Value::Arr(items) => Value::array(items.iter().map(unprepared).collect()),
                    _ => value.clone(),
                }
            }
            let (kinds,children) = captured_history(step);
            let actual = editor.history_value_shape(kinds,children);
            let (got,want) = if history_ready { (json(&actual),json(history)) } else { (json(&unprepared(&actual)),json(&unprepared(history))) };
            if got != want { differences.push(format!("history {got}, the editor's {want}")); }
        }
        if let Some(selection) = step.get("selection") {
            let got = json(&editor.selection_state().history_value()); let want = json(selection);
            if got != want { differences.push(format!("selection {got}, the editor's {want}")); }
        }
        if let Some(records) = step.get("records") {
            let got = json(&Value::array(editor.replay_records.as_ref().unwrap().clone())); let want = json(records);
            if got != want { differences.push(format!("records differ: {}", first_difference(&got,&want))); }
        }
        let got = json(&Value::array(editor.take_events()));
        let want = json(step.get("events").unwrap_or(&Value::Null));
        if got != want {
            differences.push(format!("events {}, the editor's {}", short(&got), short(&want)));
        }
        if !differences.is_empty() {
            outcome.mismatches.extend(differences.into_iter().map(|d| format!("step {number} ({method}): {d}")));
            return Ok(outcome);
        }
        outcome.matched += 1;
    }
    Ok(outcome)
}

/// `plain()` in edit-replay.mjs: containers deeper than `depth` are dropped.
pub(crate) fn plain(value: &Value, depth: u32) -> Option<Value> {
    match value {
        Value::Null | Value::Bool(_) | Value::Num(_) | Value::Str(_) | Value::Blob(_) => Some(value.clone()),
        _ if depth == 0 => None,
        Value::Arr(_) | Value::Nums(_) => Some(Value::array(value.elements().unwrap().iter().filter_map(|item| plain(&item, depth - 1)).collect())),
        Value::Obj(object) => Some(Value::object(object.iter().filter_map(|(key, item)| Some((key.clone(), plain(item, depth - 1)?))).collect())),
    }
}

fn json(value: &Value) -> String {
    styk_doc::json::to_string(value)
}

fn short(text: &str) -> String {
    if text.len() <= 400 { text.to_string() } else { format!("{}…", &text[..text.floor_char_boundary(400)]) }
}

fn first_difference(actual: &str, expected: &str) -> String {
    let at = actual.bytes().zip(expected.bytes()).position(|(a, b)| a != b).unwrap_or(actual.len().min(expected.len()));
    let from = actual.floor_char_boundary(at.saturating_sub(80));
    format!(
        "at byte {at} of {} (editor {}): engine …{}… editor …{}…",
        actual.len(),
        expected.len(),
        &actual[from..actual.floor_char_boundary((at + 80).min(actual.len()))],
        &expected[expected.floor_char_boundary(from.min(expected.len()))..expected.floor_char_boundary((at + 80).min(expected.len()))]
    )
}
