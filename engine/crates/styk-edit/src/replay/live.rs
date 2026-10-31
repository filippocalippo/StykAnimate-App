//! Strict offline replay through the SAME exclusive worker Session and response owner.
use super::Outcome;
use crate::{EditError, HistoryLimits, session::{RevisionCounters, Session}};
use styk_doc::{Value, json};
use std::sync::Arc;

fn values(value: &Value, key: &str) -> Result<Vec<Value>, String> {
    value.get(key).and_then(Value::elements).map(|items| items.iter().collect())
        .ok_or_else(|| format!("{key} must be an array"))
}
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value.get(key).and_then(Value::as_str).ok_or_else(|| format!("{key} must be text"))
}
fn number(value: &Value, key: &str) -> Result<f64, String> {
    value.get(key).and_then(Value::as_f64).filter(|n| n.is_finite() && *n >= 0.0)
        .ok_or_else(|| format!("{key} must be a finite nonnegative number"))
}
// JSON counters use the same lossless JavaScript integer range as the recorded
// owner handoff. Validate before Session's integer casts or limit conversion.
fn counter(value: &Value, key: &str) -> Result<u64, String> {
    let number = number(value, key)?;
    if number.fract() != 0.0 || number > 9_007_199_254_740_991.0 {
        return Err(format!("{key} must be a lossless nonnegative whole counter"));
    }
    Ok(number as u64)
}
fn count(value: &Value, key: &str) -> Result<usize, String> {
    usize::try_from(counter(value, key)?).map_err(|_| format!("{key} exceeds the owner's count range"))
}
// The canonical history owner exports weights/labels and may omit private JS
// command kinds. Compare every exported field; never fabricate those kinds.
fn exported(actual: &Value, expected: &Value) -> bool {
    match actual {
        Value::Obj(object) => object.iter().all(|(key, value)| expected.get(key).is_some_and(|expected| exported(value, expected))),
        Value::Arr(_) | Value::Nums(_) => actual.array_len() == expected.array_len()
            && actual.elements().unwrap().iter().zip(expected.elements().unwrap().iter()).all(|(a, e)| exported(&a, &e)),
        _ => actual == expected,
    }
}

/// Strict native/offline recorded live replay. The calling thread must be a
/// worker: cold preparation and complete JSON comparisons are allowed here.
/// Original Session and full-return recordings are separate immutable inputs.
/// This consumes one Session, prepares/guards/commits each recorded operation,
/// and retires the exact displaced payload on this worker. No UI admission,
/// foreign warm-history import, alternate serializer or evaluator is provided.
pub fn replay_session_live_worker(reference: &Value, returns: &Value) -> Result<Outcome, String> {
    let steps = values(reference, "steps")?;
    let complete = values(returns, "steps")?;
    let first = steps.first().ok_or("the live reference has no initial state")?;
    if complete.len() != steps.len() - 1 || reference.get("name") != returns.get("name") {
        return Err("live and complete-return recordings do not identify the same calls".into());
    }
    for (step, returned) in steps[1..].iter().zip(&complete) {
        if step.get("call") != returned.get("call") || step.get("error") != returned.get("error") {
            return Err("live and complete-return recordings disagree on a call/error".into());
        }
    }
    let report = json::parse(text(first, "document")?.as_bytes()).map_err(|error| error.to_string())?;
    let mut state = first.get("state").and_then(Value::as_obj).cloned().ok_or("initial state must be an object")?;
    let options = reference.get("options").and_then(Value::as_obj).ok_or("options must be an object")?;
    for (key, value) in options.iter() { state.set(key, value.clone()); }
    for key in ["activeLayerId", "sheetSelection"] {
        if let Some(value) = first.get("selection").and_then(|selection| selection.get(key)) { state.set(key, value.clone()); }
    }
    let history = first.get("history").ok_or("initial history is absent")?;
    // Fresh owner only; existing warm Sessions move through their normal host API.
    if values(history, "undo")?.len() != 0 || values(history, "redo")?.len() != 0 || number(history, "size")? != 0.0 {
        return Err("offline live replay requires the recorded fresh history owner".into());
    }
    let counters = RevisionCounters { revision:counter(history,"revision")?,
        serial:counter(history,"revisionSerial")?, saved:counter(history,"savedRevision")? };
    let state = Value::object(state);
    for key in ["layerRevision", "nextFrameIdentity", "nextUid"] { counter(&state, key)?; }
    count(&state, "frameIndex")?;
    let limits = reference.get("historyLimits").ok_or("history limits are absent")?;
    let limits = HistoryLimits { count:count(limits,"count")?, bytes:number(limits,"bytes")? };
    let mut loader = styk_eval::load::Loader::new();
    let document = loader.document(&report, "").map_err(|error| error.to_string())?;
    let prepared = Arc::new(styk_eval::eval::Prepared::new(Arc::new(document)));
    let mut session = Session::start_worker_prepared(report, &json::to_string(&state), loader, prepared, counters)?;
    session.prepare_worker_history(limits, 0.0, ||Ok(()))
        .map_err(|error| error.to_string())?;
    let mut worker = session.into_worker();
    let mut outcome = Outcome { scenario:text(reference,"name")?.into(), steps:complete.len(), ..Outcome::default() };
    let mut expected_document = text(first,"document")?.to_owned();
    let mut expected_frame = text(first,"frame")?.to_owned();
    if json::to_string(worker.report()) != expected_document {
        outcome.mismatches.push("initial canonical document differs".into()); return Ok(outcome);
    }
    let (state, history, display, runtime) = worker.initial_observation_worker(&mut ||Ok(()))
        .map_err(|error| error.to_string())?;
    if Some(&state) != first.get("state") { outcome.mismatches.push("initial canonical state differs".into()); }
    if !exported(&history, first.get("history").ok_or("initial history is absent")?) {
        outcome.mismatches.push("initial canonical history fields/bytes differ".into());
    }
    if json::to_string(&display.record) != expected_frame { outcome.mismatches.push("initial actual prepared display differs".into()); }
    if !exported(&runtime, first.get("live").ok_or("initial live runtime is absent")?) {
        outcome.mismatches.push("initial canonical live runtime differs".into());
    }
    drop(display);
    if !outcome.mismatches.is_empty() { return Ok(outcome); }
    for (at, (step, returned)) in steps[1..].iter().zip(&complete).enumerate() {
        let call = values(step,"call")?;
        let method = call.first().and_then(Value::as_str).ok_or("call method must be text")?;
        let args = Value::array(call[1..].to_vec());
        let before = worker.report().clone(); let epoch = worker.operation_epoch();
        let prepared = match worker.prepare_live(method, &args, &Value::Null, ||Ok(())) {
            Ok(prepared) => prepared,
            Err(EditError::Unported(reason)) => { outcome.unported=Some((at+1,reason)); return Ok(outcome); }
            Err(error) => { outcome.mismatches.push(format!("step{} {method}: preparation {error}",at+1)); return Ok(outcome); }
        };
        let answer = prepared.result();
        if answer.get("status").and_then(Value::as_str)==Some("unported") {
            outcome.unported=Some((at+1,answer.get("reason").and_then(Value::as_str).unwrap_or("unported worker call").into())); return Ok(outcome);
        }
        if let Some(next)=step.get("document").and_then(Value::as_str) { expected_document=next.into(); }
        if let Some(next)=step.get("frame").and_then(Value::as_str) { expected_frame=next.into(); }
        let mut differences=Vec::new();
        if !worker.report().same_node(&before) || worker.operation_epoch()!=epoch { differences.push("preparation published the live owner".to_string()); }
        if json::to_string(prepared.report())!=expected_document { differences.push("working document differs".into()); }
        let display=prepared.display().ok_or("live preparation has no display")?;
        if json::to_string(&display.record)!=expected_frame { differences.push("actual prepared display differs".into()); }
        if display.frame.objects.len()!=display.scene.scene().objects.len() { differences.push("typed scene/display count differs".into()); }
        for key in ["state","events"] { if answer.get(key)!=step.get(key) { differences.push(format!("canonical {key} differs")); } }
        let recorded_error=step.get("error").ok_or("recorded error is absent")?;
        if recorded_error.is_null() {
            if answer.get("status").and_then(Value::as_str)!=Some("ok") { differences.push("recorded successful call failed".into()); }
            if returned.get("resultDefined")!=Some(&Value::Bool(true)) || answer.get("result").map(json::to_string).as_deref()!=returned.get("resultJSON").and_then(Value::as_str) {
                differences.push("complete canonical return differs".into());
            }
        } else if answer.get("status").and_then(Value::as_str)!=Some("error") || answer.get("error")!=recorded_error.get("key") {
            differences.push("recorded Invalid error differs".into());
        }
        let actual=prepared.publication().history(); let expected=step.get("history").ok_or("history is absent")?;
        if !exported(actual,expected) { differences.push("canonical history fields/bytes differ".into()); }
        if !exported(prepared.runtime(),step.get("live").ok_or("live runtime is absent")?) { differences.push("canonical live runtime differs".into()); }
        if !differences.is_empty() {
            outcome.mismatches.extend(differences.into_iter().map(|difference|format!("step{} {method}: {difference}",at+1))); return Ok(outcome);
        }
        let (guard,display,runtime)=worker.guard(prepared,||Ok(())).map_err(|(error,_)|error.to_string())?;
        let retired=guard.commit();
        if worker.operation_epoch()!=epoch+1 || json::to_string(worker.report())!=expected_document {
            outcome.mismatches.push(format!("step{} {method}: guarded canonical commit differs",at+1)); return Ok(outcome);
        }
        drop((retired,display,runtime));
        outcome.matched+=1;
    }
    Ok(outcome)
}
