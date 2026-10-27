//! `locateEditedHandle` reads the neighbouring key itself: a hidden (zero-length) key shares its tick with the key after it,
//! which the tick alone would give.
use std::path::Path;
use styk_doc::{json, Value};
use styk_edit::{Editor, Options, Selection};

fn num(value: &Value, key: &str) -> f64 {
    value.get(key).and_then(Value::as_f64).unwrap()
}

/// The first figure of keyframe `index`: its root, and the first segment's angle and length (the figure's own when it has no stored ones).
fn first_segment(report: &Value, index: usize, own_length: f64) -> ([f64; 2], f64, f64) {
    let object = report.get("keyframes").unwrap().item(index).unwrap().get("objects").unwrap().item(0).unwrap();
    let lengths = object.get("lengths").and_then(Value::numbers).unwrap_or_default();
    let angle = object.get("angles").and_then(Value::numbers).unwrap()[0];
    ([num(&object, "root_x"), num(&object, "root_y")], angle, if num(&object, "len_flag") != 0.0 { lengths[0] } else { own_length })
}

#[test]
fn a_hidden_neighbouring_key_is_where_the_handle_is_located() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    let mut report = json::parse(&std::fs::read(folder.join("joined-chain.document.json")).unwrap()).unwrap();
    // A key before the first with no duration: its first figure stands 60 to the right of where it does in the visible key.
    let mut hidden = report.get("keyframes").unwrap().item(0).unwrap();
    {
        let key = hidden.make_obj().unwrap();
        key.set("duration_raw", Value::Num(0.0));
        let object = key.get_mut("objects").unwrap().make_arr().unwrap()[0].make_obj().unwrap();
        let root = object.get("root_x").and_then(Value::as_f64).unwrap();
        object.set("root_x", Value::Num(root + 60.0));
    }
    report.make_obj().unwrap().get_mut("keyframes").unwrap().make_arr().unwrap().insert(0, hidden);
    // The first segment of the first figure is 90 long.
    let (_, hidden_angle, hidden_length) = first_segment(&report, 0, 90.0);
    let (visible_root, ..) = first_segment(&report, 1, 90.0);
    let wanted = [visible_root[0] + 60.0 + hidden_length * hidden_angle.cos(), visible_root[1] + hidden_length * hidden_angle.sin()];

    let mut editor = Editor::new(report, Options::default());
    editor.set_view(0.0, 1, Selection { uid: Some(1), uids: vec![1], joint: 0 });
    assert_eq!(editor.call("locateEditedHandle", &[Value::Num(-1.0)]).unwrap(), Value::Bool(true));
    let (root, angle, length) = first_segment(editor.report(), 1, 90.0);
    assert_eq!(root, visible_root, "the figure's own root stays");
    let end = [root[0] + length * angle.cos(), root[1] + length * angle.sin()];
    assert!((end[0] - wanted[0]).abs() < 2e-4 && (end[1] - wanted[1]).abs() < 2e-4, "the handle is where the hidden key has it: {end:?} vs {wanted:?}");
}
