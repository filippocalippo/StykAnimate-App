use std::path::{Path, PathBuf};
use std::sync::Arc;
use styk_doc::{Value, json};
use styk_edit::{EditError, HistoryLimits, session::{Session, RevisionCounters, WorkerSession}};

fn reference(name: &str) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../tests/session-live/{name}.json"));
    json::parse(&std::fs::read(path).unwrap()).unwrap()
}
fn worker(reference: &Value) -> WorkerSession {
    let initial = reference.get("steps").unwrap().item(0).unwrap();
    let report = json::parse(initial.get("document").unwrap().as_str().unwrap().as_bytes()).unwrap();
    worker_from(reference, report)
}
fn worker_from(reference: &Value, report: Value) -> WorkerSession {
    let initial = reference.get("steps").unwrap().item(0).unwrap();
    let mut state = initial.get("state").unwrap().as_obj().unwrap().clone();
    for (key, value) in reference.get("options").unwrap().as_obj().unwrap().iter() { state.set(key, value.clone()); }
    for key in ["activeLayerId", "sheetSelection"] {
        if let Some(value) = initial.get("selection").unwrap().get(key) { state.set(key, value.clone()); }
    }
    let history = initial.get("history").unwrap();
    let counter = |key| history.get(key).unwrap().as_f64().unwrap() as u64;
    let mut loader = styk_eval::load::Loader::new();
    let document = loader.document(&report, "").unwrap();
    let prepared = Arc::new(styk_eval::eval::Prepared::new(Arc::new(document)));
    let mut session = Session::start_worker_prepared(report, &json::to_string(&Value::object(state)), loader, prepared,
        RevisionCounters { revision: counter("revision"), serial: counter("revisionSerial"), saved: counter("savedRevision") }).unwrap();
    let limits = reference.get("historyLimits").unwrap();
    session.prepare_worker_history(HistoryLimits { count: limits.get("count").unwrap().as_f64().unwrap() as usize,
        bytes: limits.get("bytes").unwrap().as_f64().unwrap() }, 0.0, || Ok(())).unwrap();
    session.into_worker()
}

#[test]
fn actual_editor_live_steps_keep_working_display_history_and_runtime_exact() {
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/session-live");
    let mut paths: Vec<_> = std::fs::read_dir(directory).unwrap().map(|e|e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e|e=="json") && !p.file_name().unwrap().to_str().unwrap().contains("preflight")).collect();
    paths.sort(); assert_eq!(paths.len(), 18);
    let mut calls=0;
    for path in paths {
        let reference=json::parse(&std::fs::read(&path).unwrap()).unwrap();
        let name=path.file_name().unwrap().to_str().unwrap();
        let returns=Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../tests/session-live-return/{name}"));
        let returns=json::parse(&std::fs::read(returns).unwrap()).unwrap();
        let outcome=styk_edit::replay::replay_session_live_worker(&reference,&returns).unwrap();
        assert!(outcome.passed() && outcome.unported.is_none() && outcome.matched==outcome.steps,"{name}: {outcome:#?}");
        calls+=outcome.matched;
    }
    assert_eq!(calls,208);
}

#[test]
fn capability_rejects_other_owner_old_epoch_and_cancel_without_mutating_live_baseline() {
    let trace = reference("native-drag-commit");
    let mut worker = worker(&trace);
    let mut other = worker_from(&trace, worker.report().clone());
    let foreign = other.prepare_live("moveSelection", &Value::array(vec![Value::Num(4.0), Value::Num(2.0)]), &Value::Null, || Ok(())).unwrap();
    assert!(matches!(worker.guard(foreign, || Ok(())), Err((EditError::Invalid(_), _))));
    // A real repeated selection can leave every report/counter/canonical view
    // equal. Its actual operation epoch must still reject an older candidate.
    let selection = Value::array(vec![Value::Num(1.0), Value::Num(-1.0)]);
    let stale_same_head = worker.prepare_live("select", &selection, &Value::Null, || Ok(())).unwrap();
    let repeated = worker.prepare_live("select", &selection, &Value::Null, || Ok(())).unwrap();
    let (guard, display, runtime) = worker.guard(repeated, || Ok(())).unwrap_or_else(|(error,_)|panic!("{error:?}"));
    drop((guard.commit(), display, runtime));
    assert!(matches!(worker.guard(stale_same_head, || Ok(())), Err((EditError::Invalid(_), _))));
    let begin = worker.prepare_live("beginDrag", &Value::array(vec![Value::str("Worker gesture")]), &Value::Null, || Ok(())).unwrap();
    let (guard, display, runtime) = worker.guard(begin, || Ok(())).unwrap_or_else(|(error,_)|panic!("{error:?}"));
    drop((guard.commit(), display, runtime));
    let stale = worker.prepare_live("moveSelection", &Value::array(vec![Value::Num(4.0), Value::Num(2.0)]), &Value::Null, || Ok(())).unwrap();
    let before = worker.report().clone(); let epoch = worker.operation_epoch();
    let mut checks = 0;
    let cancelled = worker.prepare_live("moveSelection", &Value::array(vec![Value::Num(9.0), Value::Num(5.0)]), &Value::Null, || {
        checks += 1; if checks == 4 { Err(EditError::Invalid("cancelled".into())) } else { Ok(()) }
    });
    assert!(matches!(cancelled, Err(EditError::Invalid(ref reason)) if reason=="cancelled"));
    assert!(worker.report().same_node(&before)); assert_eq!(worker.operation_epoch(), epoch);
    let moved = worker.prepare_live("moveSelection", &Value::array(vec![Value::Num(2.0), Value::Num(1.0)]), &Value::Null, || Ok(())).unwrap();
    let (guard, display, runtime) = worker.guard(moved, || Ok(())).unwrap_or_else(|(error,_)|panic!("{error:?}"));
    drop((guard.commit(), display, runtime));
    assert!(matches!(worker.guard(stale, || Ok(())), Err((EditError::Invalid(_), _))));
    assert!(worker.prepare_quiet("setFPS", &Value::array(vec![Value::Num(30.0)]), &Value::Null, || Ok(())).is_err(), "quiet Guard was widened");
    let cancelled = worker.prepare_live("cancelDrag", &Value::array(vec![]), &Value::Null, || Ok(())).unwrap();
    assert_eq!(json::to_string(cancelled.report()), json::to_string(&before), "cancel must use the original live baseline; COW roots may differ after restoring its poses");
}

fn candidate_fingerprint(prepared: &styk_edit::session::WorkerPrepared) -> String {
    let mut value=styk_doc::Obj::new();
    value.set("answer",prepared.result().clone());value.set("report",prepared.report().clone());
    value.set("history",prepared.publication().history().clone());value.set("runtime",prepared.runtime().clone());
    value.set("display",prepared.display().unwrap().record.clone());
    json::to_string(&Value::object(value))
}

#[test]
fn native_true_one_shot_inner_checks_preserve_the_exact_exclusive_owner_and_error() {
    let directory=Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/session-live");
    let mut paths:Vec<_>=std::fs::read_dir(directory).unwrap().map(|entry|entry.unwrap().path())
        .filter(|path|path.file_name().unwrap().to_str().unwrap().starts_with("native-channels-")
            && !path.file_name().unwrap().to_str().unwrap().contains("preflight")).collect();
    paths.sort();assert_eq!(paths.len(),8);
    let mut operations=0;let mut boundaries=0;
    for path in paths {
        let reference=json::parse(&std::fs::read(path).unwrap()).unwrap();let mut worker=worker(&reference);
        for step in reference.get("steps").unwrap().elements().unwrap().iter().skip(1) {
            let call=step.get("call").unwrap().elements().unwrap();let method=call.get(0).unwrap();let method=method.as_str().unwrap();
            let args=Value::array(call.iter().skip(1).collect());let before=worker.report().clone();let epoch=worker.operation_epoch();
            let mut count=0;
            let baseline=worker.prepare_live(method,&args,&Value::Null,||{count+=1;Ok(())}).unwrap();
            assert_ne!(baseline.result().get("status").and_then(Value::as_str),Some("unported"));
            let expected=candidate_fingerprint(&baseline);drop(baseline);
            for stop in 1..=count {
                let message=format!("one-shot original error {method} boundary {stop}");let mut observed=0;
                let result=worker.prepare_live(method,&args,&Value::Null,||{
                    observed+=1;
                    if observed==stop { if stop%2==0 {Err(EditError::Invalid(message.clone()))} else {Err(EditError::Unported(message.clone()))} }
                    else {Ok(())}
                });
                match result {
                    Err(EditError::Invalid(actual)) if stop%2==0=>assert_eq!(actual,message),
                    Err(EditError::Unported(actual)) if stop%2==1=>assert_eq!(actual,message),
                    _=>panic!("{method} checkpoint{stop}/{count}: one-shot host error became a prepared canonical answer"),
                }
                assert!(worker.report().same_node(&before),"{method} checkpoint{stop}: published report");
                assert_eq!(worker.operation_epoch(),epoch,"{method} checkpoint{stop}: advanced epoch");
                let retry=worker.prepare_live(method,&args,&Value::Null,||Ok(())).unwrap();
                assert_eq!(candidate_fingerprint(&retry),expected,"{method} checkpoint{stop}: source/history/live baseline changed");
                drop(retry);boundaries+=1;
            }
            let prepared=worker.prepare_live(method,&args,&Value::Null,||Ok(())).unwrap();
            let (guard,display,runtime)=worker.guard(prepared,||Ok(())).unwrap_or_else(|(error,_)|panic!("{error}"));
            drop((guard.commit(),display,runtime));operations+=1;
        }
    }
    assert_eq!(operations,93);assert!(boundaries>1363,"inner row/history checks must reach the capability");
    eprintln!("93 actual exclusive operations / {boundaries} one-shot Invalid+Unported checks restore exact candidate, source/history/epoch and original errors");
}

#[test]
fn strict_live_worker_rejects_unproven_tapes_and_legacy_calls_stay_refused() {
    let trace=reference("native-channels-drag-commit");
    let initial=trace.get("steps").unwrap().item(0).unwrap();
    let report=json::parse(initial.get("document").unwrap().as_str().unwrap().as_bytes()).unwrap();
    let mut state=initial.get("state").unwrap().as_obj().unwrap().clone();
    for (key,value) in trace.get("options").unwrap().as_obj().unwrap().iter(){state.set(key,value.clone());}
    let mut legacy=Session::start(report,&json::to_string(&Value::object(state))).unwrap();
    let before=legacy.report().clone();let answer=legacy.call_values("select",&Value::array(vec![Value::Num(1.0),Value::Num(-1.0)]),&Value::Null);
    assert_eq!(answer.get("status").and_then(Value::as_str),Some("unported"));assert!(legacy.report().same_node(&before));
    let mut exclusive=worker(&trace);let before=exclusive.report().clone();
    for (method,args) in [("setOrigin",Value::array(vec![Value::Num(1.0)])),("poseJoint",Value::array(vec![Value::Num(7.0),Value::Num(9.0)]))] {
        assert!(matches!(exclusive.prepare_live(method,&args,&Value::Null,||Ok(())),Err(EditError::Unported(_))));
        assert!(exclusive.report().same_node(&before));assert_eq!(exclusive.operation_epoch(),0);
    }
    let mut complex=json::parse(initial.get("document").unwrap().as_str().unwrap().as_bytes()).unwrap();
    let definition=complex.make_obj().unwrap().get_mut("figure_types").unwrap().make_arr().unwrap()[0].make_obj().unwrap();
    definition.get_mut("segments").unwrap().make_arr().unwrap()[0].make_obj().unwrap().set("_stykRig",json::parse(br#"{"unknownRigFamily":true}"#).unwrap());
    let mut complex=worker_from(&trace,complex);let before=complex.report().clone();
    let prepared=complex.prepare_live("select",&Value::array(vec![Value::Num(1.0),Value::Num(-1.0)]),&Value::Null,||Ok(())).unwrap();
    assert_eq!(prepared.result().get("status").and_then(Value::as_str),Some("unported"));assert!(prepared.report().same_node(&before));assert_eq!(complex.operation_epoch(),0);
}

fn complete_returns(name: &str) -> Value {
    let path=Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../tests/session-live-return/{name}.json"));
    json::parse(&std::fs::read(path).unwrap()).unwrap()
}

fn initial_rejected(trace: &Value, returns: &Value) {
    match styk_edit::replay::replay_session_live_worker(trace,returns) {
        Err(_) => {},
        Ok(outcome) => {
            assert!(!outcome.passed(),"inconsistent initial observation was accepted: {outcome:#?}");
            assert_eq!(outcome.matched,0,"initial refusal must precede the first dispatch");
        },
    }
}

#[test]
fn strict_live_worker_observes_complete_initial_heads_before_first_dispatch() {
    let original=reference("native-channels-drag-cancel");
    let returns=complete_returns("native-channels-drag-cancel");
    for (owner,key,value) in [("state","canUndo",Value::Bool(true)),
        ("state","canRedo",Value::Bool(true)),("state","dirty",Value::Bool(true)),
        ("state","undoLabel",Value::str("fabricated history")),
        ("live","changed",Value::Bool(true)),("live","drag",Value::Bool(true))] {
        let mut trace=original.clone();
        trace.make_obj().unwrap().get_mut("steps").unwrap().make_arr().unwrap()[0]
            .make_obj().unwrap().get_mut(owner).unwrap().make_obj().unwrap().set(key,value);
        initial_rejected(&trace,&returns);
    }
    // Sparse traces may explicitly repeat a later unchanged display. That
    // later observation must not hide a fabricated initial display.
    let initial_frame=original.get("steps").unwrap().item(0).unwrap().get("frame").unwrap().clone();
    let mut trace=original.clone();let steps=trace.make_obj().unwrap().get_mut("steps").unwrap().make_arr().unwrap();
    steps[0].make_obj().unwrap().set("frame",Value::str("{}"));
    steps[1].make_obj().unwrap().set("frame",initial_frame);
    initial_rejected(&trace,&returns);
}

#[test]
fn strict_live_worker_checks_lossless_initial_counter_and_count_ranges_before_casts() {
    let original=reference("native-channels-drag-cancel");
    let returns=complete_returns("native-channels-drag-cancel");
    for (owner,key) in [("history","revision"),("history","revisionSerial"),("history","savedRevision"),
        ("state","layerRevision"),("state","nextFrameIdentity"),("state","nextUid"),("state","frameIndex")] {
        for number in [2.25,-1.0,9_007_199_254_740_992.0,f64::INFINITY,f64::NAN] {
            let mut trace=original.clone();
            trace.make_obj().unwrap().get_mut("steps").unwrap().make_arr().unwrap()[0]
                .make_obj().unwrap().get_mut(owner).unwrap().make_obj().unwrap().set(key,Value::Num(number));
            assert!(styk_edit::replay::replay_session_live_worker(&trace,&returns).is_err(),"{owner}.{key}={number} cast before validation");
        }
    }
    for number in [2.25,-1.0,9_007_199_254_740_992.0,f64::INFINITY,f64::NAN] {
        let mut trace=original.clone();trace.make_obj().unwrap().get_mut("historyLimits").unwrap().make_obj().unwrap().set("count",Value::Num(number));
        assert!(styk_edit::replay::replay_session_live_worker(&trace,&returns).is_err(),"history count {number} cast before validation");
    }
}
