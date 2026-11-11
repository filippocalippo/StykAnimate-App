//! A figure joined to a movieclip instance that is not shown at the playhead (its placement ended)
//! comes loose where the clip had it, in the evaluated record and in the typed frame alike, and
//! reading the frame never refuses (`sampleMovieclipObjects`).

use std::path::Path;

use styk_doc::Value;
use styk_eval::records::Records;

fn num(value: &Value, key: &str) -> f64 {
    value.get(key).and_then(Value::as_f64).unwrap_or_else(|| panic!("{key} is not a number in {}", styk_doc::json::to_string(value)))
}

/// `clip-playback-all-native` with the clip placed from tick 0 to 3 on every key, a figure (uid 2) joined to its root
/// and another figure (uid 3) that is not joined.
fn document(join_slot: f64) -> Value {
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/clip-playback-all-native.document.json");
    let mut tree = styk_doc::json::parse(&std::fs::read(file).unwrap()).unwrap();
    let keys = tree.make_obj().unwrap().get_mut("keyframes").unwrap().make_arr().unwrap();
    for key in keys.iter_mut() {
        let key = key.make_obj().unwrap();
        let objects = key.get_mut("objects").unwrap().make_arr().unwrap();
        let (clip_x, clip_y) = (num(&objects[0], "root_x"), num(&objects[0], "root_y"));
        let placement = objects[0].make_obj().unwrap().get_mut("_stykMovieclip").unwrap().make_obj().unwrap();
        placement.set("end", Value::Num(3.0));
        placement.set("restarts", Value::array(Vec::new()));
        let mut third = objects[1].clone();
        {
            let third = third.make_obj().unwrap();
            third.set("object_slot", Value::Num(2.0));
            third.set("unique_id", Value::Num(3.0));
            third.set("root_x", Value::Num(480.0));
            third.set("root_y", Value::Num(270.0));
        }
        let joined = objects[1].make_obj().unwrap();
        joined.set("root_x", Value::Num(clip_x));
        joined.set("root_y", Value::Num(clip_y));
        joined.set("join", styk_doc::json::parse(format!(r#"{{"target_object_slot":{join_slot},"target_unique_id":1,"target_handle_id":0}}"#).as_bytes()).unwrap());
        objects.push(third);
        key.set("object_draw_order", styk_doc::json::parse(b"[0,1,2]").unwrap());
        key.set("object_draw_order_unique_ids", styk_doc::json::parse(b"[1,2,3]").unwrap());
    }
    tree
}

fn objects(frame: &Value) -> Vec<Value> {
    frame.get("objects").and_then(Value::elements).unwrap().iter().collect()
}

#[test]
fn a_figure_joined_to_a_hidden_clip_stays_where_it_was_in_the_record() {
    let tree = document(0.0);
    let prepared = styk_eval::prepare(styk_eval::from_value(&tree, "").unwrap());
    let records = Records::new(&tree, &prepared).unwrap();

    // While the clip plays, the join stays (renumbered to the slots that remain).
    let playing = objects(&records.evaluated(1.0).unwrap());
    assert_eq!(playing.len(), 3);
    assert_eq!(num(playing[1].get("join").unwrap(), "target_object_slot"), 0.0);

    // At tick 3 the placement has ended: the clip leaves the frame and the figure keeps its place on the way between the
    // keys (the middle of the clip's move from (180, 150) to (212.5, 142.75)).
    let frame = records.evaluated(3.0).unwrap();
    let shown = objects(&frame);
    let summary: Vec<(f64, bool, f64, f64)> = shown.iter().map(|o| (num(o, "unique_id"), o.get("join").is_some_and(Value::is_null), num(o, "root_x"), num(o, "root_y"))).collect();
    assert_eq!(summary, vec![(2.0, true, 196.25, 146.375), (3.0, true, 480.0, 270.0)]);
    assert!(matches!(shown[0].get("join"), Some(Value::Null)), "the join is a null, as the editor writes it");
    assert_eq!(num(&shown[0], "object_slot"), 0.0);
    assert_eq!(num(&shown[1], "object_slot"), 1.0);
    assert_eq!(num(&frame, "object_count"), 2.0);
    assert_eq!(styk_doc::json::to_string(frame.get("object_draw_order").unwrap()), "[0,1]");
    assert_eq!(styk_doc::json::to_string(frame.get("object_draw_order_unique_ids").unwrap()), "[2,3]");

    // Later it keeps following the clip's place in the timeline.
    let later = objects(&records.evaluated(5.0).unwrap());
    assert_eq!(later.len(), 2);
    assert!(matches!(later[0].get("join"), Some(Value::Null)));
    assert!((num(&later[0], "root_x") - (180.0 + 32.5 * 5.0 / 6.0)).abs() < 1e-9);
    assert!((num(&later[0], "root_y") - (150.0 - 7.25 * 5.0 / 6.0)).abs() < 1e-9);
}

#[test]
fn a_figure_joined_to_a_hidden_clip_stays_where_it_was_in_the_typed_frame() {
    let tree = document(0.0);
    let prepared = styk_eval::prepare(styk_eval::from_value(&tree, "").unwrap());
    let frame = prepared.evaluate(3.0);
    let shown: Vec<(u32, bool, [f64; 2])> = frame.objects.iter().map(|o| (o.uid, o.join.is_none(), o.root)).collect();
    assert_eq!(shown, vec![(2, true, [196.25, 146.375]), (3, true, [480.0, 270.0])]);
    assert_eq!(frame.draw_order, vec![0, 1]);
    let scene = styk_eval::geometry::build(&prepared.doc, &frame);
    assert_eq!(scene.objects.len(), 2);
    assert!(scene.objects.iter().all(|group| group.resolved));
}

#[test]
fn a_join_to_a_slot_outside_the_frame_comes_loose_without_refusing() {
    // A join whose target slot is not in the frame is a join to nothing that is shown.
    for slot in [7.0, -1.0, 0.5] {
        let tree = document(slot);
        let prepared = styk_eval::prepare(styk_eval::from_value(&tree, "").unwrap());
        let records = Records::new(&tree, &prepared).unwrap();
        let shown = objects(&records.evaluated(3.0).unwrap_or_else(|error| panic!("slot {slot}: {error}")));
        assert_eq!(shown.len(), 2, "slot {slot}");
        assert!(matches!(shown[0].get("join"), Some(Value::Null)), "slot {slot}");
        let frame = prepared.evaluate(3.0);
        assert_eq!(frame.objects.len(), 2, "slot {slot}");
    }
}
