//! Unsupported editor-built combinations. The session boundary is in movieclip_session_integration.
//! Unported here is explicit admission coverage, never ported-replay evidence.
use std::path::Path;
use styk_doc::{Value,json};
use styk_edit::{Editor,Options,Selection,EditError};
fn read(folder:&str,name:&str)->Value {
 let path=Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests").join(folder).join(format!("{name}.reference.json"));
 json::parse(&std::fs::read(path).unwrap()).unwrap()
}
fn first(reference:&Value)->Value { reference.get("steps").unwrap().item(0).unwrap() }
fn start(reference:&Value)->Editor {
 let step=first(reference);let state=step.get("state").unwrap();
 let report=json::parse(step.get("document").unwrap().as_str().unwrap().as_bytes()).unwrap();
 let mut editor=Editor::new(report,Options::default());
 editor.set_view(0.0,0,Selection{uid:Some(2),uids:vec![],joint:-1});
 editor.set_counters(state.get("layerRevision").unwrap().as_f64().unwrap() as u64,state.get("nextFrameIdentity").unwrap().as_f64().unwrap() as u64,state.get("nextUid").unwrap().as_f64().unwrap() as u64);
 editor
}
#[test]
fn unrecorded_native_draft_and_ik_movieclip_calls_refuse_atomically(){
 for name in ["native-ik-shown","native-ik-future","native-ik-source","native-ik-asset","native-saved-draft"] {
  let reference=read("movieclip-admission",name);
  let actual=reference.get("steps").unwrap().item(2).unwrap();
  assert!(actual.get("error").unwrap().is_null(),"{name}: actual editor extension must be valid, refusal is engine admission only");
  for method in ["addMovieclipToNextKeyframes","addFigure"] {
   for live in [false,true] {
    let mut editor=start(&reference);let original=editor.report_json();
    if live {
     editor.call("@select",&[Value::Num(3.0),Value::Num(-1.0)]).unwrap();
     editor.call("beginTranslationDrag",&[Value::str("Unrelated live gesture")]).unwrap();
     editor.call("moveSelection",&[Value::Num(4.5),Value::Num(-2.25)]).unwrap();
     editor.call("@select",&[Value::Num(2.0),Value::Num(-1.0)]).unwrap();
    }
    editor.take_events();let before=editor.report_json();let state=json::to_string(&editor.state_value());
    let args=[Value::Num(if method=="addFigure" {4.0}else{1.0})];
    match editor.call(method,&args) {
     Err(EditError::Unported(reason))=>assert!(reason.contains(if name=="native-saved-draft" {"saved working frame"}else{"native movieclip edits with IK"}),"{name}: {reason}"),
     result=>panic!("{name} {method} live{live}: expected explicit refusal, got {result:?}"),
    }
    assert_eq!(editor.report_json(),before,"{name} document");
    assert_eq!(json::to_string(&editor.state_value()),state,"{name} state");
    assert!(editor.take_events().is_empty(),"{name} events");
    if live {
     editor.call("@select",&[Value::Num(3.0),Value::Num(-1.0)]).unwrap();
     editor.call("moveSelection",&[Value::Num(2.0),Value::Num(1.0)]).unwrap();
     editor.call("cancelDrag",&[]).unwrap();
     assert_eq!(editor.report_json(),original,"{name} preserved gesture cancel");
    }
   }
  }
 }
}
