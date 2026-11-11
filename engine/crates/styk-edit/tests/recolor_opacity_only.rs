//! `setFigureColor(undefined, {opacity})` (the paint dialog changing only the opacity) reaches the session with a null color,
//! which means no color.
use std::path::Path;
use styk_doc::{json, Value};
use styk_edit::{Editor, Options};

fn editor() -> Editor {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    let report = json::parse(&std::fs::read(folder.join("range-colors.document.json")).unwrap()).unwrap();
    let mut editor = Editor::new(report, Options { property_channels: true, layer_timeline: true, auto_key: false });
    editor.call("select", &[Value::Num(1.0), Value::Num(-1.0)]).unwrap();
    editor
}

#[test]
fn a_color_left_out_changes_only_the_opacity() {
    let (mut left_out, mut operation) = (editor(), editor());
    let before = left_out.report_json();
    left_out.call("setFigureColor", &[Value::Null, json::parse(br#"{"opacity":0.25}"#).unwrap()]).unwrap();
    operation.call("editFigureColors", &[json::parse(br#"{"mode":"all","opacity":0.25}"#).unwrap()]).unwrap();
    assert_ne!(left_out.report_json(), before, "the opacity changed");
    assert_eq!(left_out.report_json(), operation.report_json());
}
