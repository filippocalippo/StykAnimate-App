//! Reading the frame on show never refuses for a document that opened: layer poses that cannot all stand leave the frame
//! with one figure loose.

use std::path::Path;

use styk_doc::Value;
use styk_eval::records::Records;

fn parse(text: &str) -> Value {
    styk_doc::json::parse(text.as_bytes()).unwrap()
}

fn num(value: &Value, key: &str) -> f64 {
    value.get(key).and_then(Value::as_f64).unwrap_or_else(|| panic!("{key} is not a number in {}", styk_doc::json::to_string(value)))
}

fn objects(frame: &Value) -> Vec<Value> {
    frame.get("objects").and_then(Value::elements).unwrap().iter().collect()
}

/// `channels-pose-native`: figure 3 joins figure 2 in the document's own poses. Figure 2's pose channel, from tick 4, holds a pose
/// where figure 2 joins figure 3: each pose is valid alone, the two composed join in a ring (the editor refuses to make one; a file
/// can hold it).
fn ring() -> Value {
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/records/channels-pose-native/report.json");
    let mut tree = styk_doc::json::parse(&std::fs::read(file).unwrap()).unwrap();
    let sources = tree.make_obj().unwrap().get_mut("_styk").unwrap().make_obj().unwrap().get_mut("frameSources").unwrap().make_obj().unwrap();
    let frame = sources.get_mut("frame-5").unwrap().make_obj().unwrap();
    let objects = frame.get_mut("objects").unwrap().make_arr().unwrap();
    assert_eq!((num(&objects[0], "unique_id"), num(&objects[1], "unique_id")), (2.0, 3.0));
    objects[0].make_obj().unwrap().set("join", parse(r#"{"target_object_slot":1,"target_unique_id":3,"target_handle_id":22}"#));
    objects[1].make_obj().unwrap().set("join", Value::Null);
    tree
}

#[test]
fn layer_poses_that_join_in_a_ring_read_with_one_figure_loose() {
    let tree = ring();
    let prepared = styk_eval::prepare(styk_eval::from_value(&tree, "").unwrap());
    let records = Records::new(&tree, &prepared).unwrap();
    let joined = |frame: &Value| objects(frame).iter().filter(|o| matches!(num(o, "unique_id") as u32, 2 | 3) && o.get("join").is_some_and(Value::truthy)).count();
    // Before the ring figure 3 alone joins figure 2; from tick 4 the two would join each other, and the ring breaks at one figure.
    assert_eq!(joined(&records.evaluated(3.0).unwrap()), 1);
    for tick in [4.0, 5.0] {
        let frame = records.evaluated(tick).unwrap_or_else(|error| panic!("tick {tick}: {error}"));
        assert_eq!(joined(&frame), 1, "tick {tick}: the ring is broken at one figure");
        // The typed frame the stage is drawn from breaks the ring at the same figure, so the stage draws every figure.
        let typed = prepared.evaluate(tick);
        assert_eq!(typed.objects.len(), objects(&frame).len(), "tick {tick}");
        for (object, record) in typed.objects.iter().zip(objects(&frame)) {
            assert_eq!(object.uid, num(&record, "unique_id") as u32, "tick {tick}");
            assert_eq!(object.join.is_some(), record.get("join").is_some_and(Value::truthy), "tick {tick}: figure {} joins in both or in neither", object.uid);
        }
        let scene = styk_eval::geometry::build(&prepared.doc, &typed);
        assert!(scene.warnings.is_empty(), "tick {tick}: {:?}", scene.warnings);
    }
}
