//! A document whose frame joins name no figure opens, mended from the nearest frame whose joins resolve, and says so
//! (`Prepared::repairs`); a document that resolves is left exactly as the file holds it.

use styk_doc::Value;
use styk_edit::load::prepare_for_editor;

fn read(path: &str) -> Value {
    let folder = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    styk_doc::json::parse(&std::fs::read(folder.join(path)).unwrap()).unwrap()
}

fn at<'a>(value: &'a mut Value, key: &str) -> &'a mut Value { value.make_obj().unwrap().get_mut(key).unwrap() }

/// The joins of the figures of frame `frame`, as (identity, parent identity).
fn parents(document: &Value, frame: usize) -> Vec<(f64, Option<f64>)> {
    let frames = document.get("keyframes").and_then(Value::elements).unwrap();
    let frame = frames.get(frame).unwrap();
    let objects: Vec<Value> = frame.get("objects").and_then(Value::elements).unwrap().iter().collect();
    objects
        .iter()
        .map(|o| {
            let parent = o.get("join").filter(|j| j.truthy()).and_then(|j| j.get("target_object_slot")).and_then(Value::as_f64).and_then(|s| objects.get(s as usize)).and_then(|p| p.get("unique_id")).and_then(Value::as_f64);
            (o.get("unique_id").and_then(Value::as_f64).unwrap(), parent)
        })
        .collect()
}

/// `camera-chain`: three figures, the second joined to the first and the third to the second, in both its frames; the first frame's joins
/// are given the shapes a badly cut scene left: one without a slot, one joined to itself.
fn damaged() -> Value {
    let mut document = read("tests/edit/camera-chain.document.json");
    let frames = at(&mut document, "keyframes").make_arr().unwrap();
    let objects = at(&mut frames[0], "objects").make_arr().unwrap();
    at(&mut objects[1], "join").make_obj().unwrap().remove("target_object_slot");
    at(&mut objects[1], "join").make_obj().unwrap().remove("target_unique_id");
    at(&mut objects[2], "join").make_obj().unwrap().set("target_object_slot", Value::Num(2.0));
    at(&mut objects[2], "join").make_obj().unwrap().remove("target_unique_id");
    document
}

#[test]
fn a_frame_whose_joins_name_no_figure_takes_the_joins_of_the_nearest_frame_that_resolves() {
    let healthy = read("tests/edit/camera-chain.document.json");
    let wanted = parents(&healthy, 0);
    assert!(wanted.iter().any(|(_, parent)| parent.is_some()), "the fixture joins figures");
    assert!(prepare_for_editor(damaged(), false).is_ok(), "the damaged document opens");
    let opened = prepare_for_editor(damaged(), false).unwrap();
    assert_eq!(opened.repairs, 1, "one frame was mended");
    assert_eq!(parents(&opened.report, 0), wanted, "the first frame joins the figures its neighbour joins");
    assert_eq!(parents(&opened.report, 1), parents(&healthy, 1), "the frame that resolved is as it was");
}

#[test]
fn a_document_whose_joins_resolve_opens_as_it_is() {
    let healthy = read("tests/edit/camera-chain.document.json");
    let opened = prepare_for_editor(healthy.clone(), false).unwrap();
    assert_eq!(opened.repairs, 0);
    assert_eq!(parents(&opened.report, 0), parents(&healthy, 0));
    assert_eq!(parents(&opened.report, 1), parents(&healthy, 1));
}

/// `camera-follow-figures` keeps five poses in `_styk.frameSources` (what a layer sheet retains, and what the scene of a movieclip keeps), one of
/// them with a figure joined to another. The join is given the shape a badly cut scene left: it names a slot that is not there.
fn with_a_damaged_retained_pose() -> Value {
    let mut document = read("tests/edit/camera-follow-figures.document.json");
    let sources = at(at(&mut document, "_styk"), "frameSources").make_obj().unwrap();
    let ids: Vec<String> = sources.keys().map(|id| id.to_string()).collect();
    let mut damaged = 0;
    for id in ids {
        let objects = at(sources.get_mut(&id).unwrap(), "objects").make_arr().unwrap();
        for object in objects.iter_mut().filter(|o| o.get("join").is_some_and(Value::truthy)) {
            at(object, "join").make_obj().unwrap().set("target_object_slot", Value::Num(99.0));
            damaged += 1;
        }
    }
    assert!(damaged > 0, "the fixture retains a pose with a joined figure");
    document
}

#[test]
fn a_retained_pose_whose_join_names_no_figure_opens_mended() {
    let damaged = with_a_damaged_retained_pose();
    assert!(styk_edit::load::prepare_editor_load(damaged.clone()).is_err(), "opening without mending refuses it");
    let opened = prepare_for_editor(damaged, true).expect("the project opens");
    assert_eq!(opened.repairs, 1, "the pose was mended");
    assert_eq!(prepare_for_editor(opened.report, true).unwrap().repairs, 0, "what opening wrote needs no mending");
}

/// A timed movieclip placement whose end is not after its start, as a clip placed in a frame that ended before it started was left: opening
/// refused it (`errors.movieclips.movieclipPlacementMustHaveAValidStartAnd`). The end becomes the frame after the start.
#[test]
fn a_placement_whose_end_is_not_after_its_start_opens_with_the_shortest_end() {
    let mut document = read("tests/edit/clip-break-joined-sheet.document.json");
    let timed = styk_doc::json::parse(br#"{"start":8,"end":8,"offset":0,"speed":1,"mode":"loop"}"#).unwrap();
    let mut placed = 0;
    let mut place = |frame: &mut Value| {
        if let Some(object) = at(frame, "objects").make_arr().unwrap().first_mut() {
            object.make_obj().unwrap().set("_stykMovieclip", timed.clone());
            placed += 1;
        }
    };
    place(&mut at(&mut document, "keyframes").make_arr().unwrap()[0]);
    let sources = at(at(&mut document, "_styk"), "frameSources").make_obj().unwrap();
    let id = sources.keys().next().unwrap().to_string();
    place(sources.get_mut(&id).unwrap());
    assert_eq!(placed, 2);
    assert!(styk_edit::load::prepare_editor_load(document.clone()).is_err(), "opening without mending refuses it");
    let opened = prepare_for_editor(document, true).expect("the project opens");
    assert_eq!(opened.repairs, 2, "the keyframe and the retained pose were mended");
    assert_eq!(opened.report.path(&["keyframes"]).and_then(Value::elements).unwrap().get(0).unwrap().path(&["objects"]).and_then(Value::elements).unwrap().get(0).unwrap().path(&["_stykMovieclip", "end"]).and_then(Value::as_f64), Some(9.0));
}
