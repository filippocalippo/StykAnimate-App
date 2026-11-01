//! A save never writes a file that opening refuses, and is never refused for what opening mends. Beside the lift it runs the reader's check
//! on every document the project holds: what opening would mend is mended in what is written (and counted), and what no repair mends is
//! written all the same, with the reason. Each shape found in a person's file or by the gesture fuzz has its test here.
use styk_doc::{Value, json};
use styk_engine::save::{ProjectRequest, Written, save_project};
use styk_formats::{Kind, files};

fn repo(path: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..").join(path)
}

fn read(path: &str) -> Value {
    json::parse(&std::fs::read(repo(path)).unwrap()).unwrap()
}

const STATE: &str = r#"{"layerTimeline":true,"propertyChannels":true,"tick":0,"frameIndex":0,"selectedUid":null,"selectedUids":[],"selectedJoint":-1,"activeLayerId":"layer-1","nextFrameIdentity":100,"nextUid":60}"#;

fn at<'a>(value: &'a mut Value, key: &str) -> &'a mut Value {
    value.make_obj().unwrap().get_mut(key).unwrap()
}

fn save(tree: &Value) -> Written {
    save_project(std::slice::from_ref(tree), &[], ProjectRequest { name: None, source: None, reservation: None }, &|| false).expect("the save writes")
}

/// The project as a person's next open holds it, and how much opening mended.
fn reopened(written: &Written) -> (Value, usize) {
    let document = files::open_document(&written.bytes, Kind::Styk).expect("the container reads");
    let opened = styk_edit::load::prepare_for_editor(document, true).expect("opening accepts the file");
    (opened.report, opened.repairs)
}

fn call(session: &mut styk_edit::session::Session, method: &str, args: &str, selected: &[u32]) {
    let ids: Vec<String> = selected.iter().map(u32::to_string).collect();
    let first = selected.first().map_or("null".to_string(), u32::to_string);
    let view = format!(r#"{{"tick":0,"frameIndex":0,"selectedUid":{first},"selectedUids":[{}],"selectedJoint":-1,"activeLayerId":"layer-1","draws":[],"drawPool":false}}"#, ids.join(","));
    let answer = json::parse(session.call(method, args, &view).as_bytes()).unwrap();
    assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"), "{method}: {answer:?}");
}

/// A project with a movieclip made in it.
fn with_a_movieclip() -> Value {
    let mut session = styk_edit::session::Session::start(read("engine/tests/edit/sheet-movieclip.document.json"), STATE).unwrap();
    call(&mut session, "createMovieclip", r#"[{"start":0,"end":3}]"#, &[1]);
    session.report().clone()
}

/// The last movieclip definition of `report`.
fn last_clip(report: &mut Value) -> &mut Value {
    let figures = at(report, "figure_types").make_arr().unwrap();
    figures.iter_mut().filter(|f| f.path(&["_styk", "movieclip"]).is_some()).last().unwrap()
}

/// The movieclip's retained scene given a replacement by a figure it does not hold and one whose pose is not there (what builds that cut a
/// scene down without its layer sheet saved).
fn with_dangling_replacements() -> Value {
    let mut report = with_a_movieclip();
    let clip = last_clip(&mut report);
    let source = at(at(at(at(at(at(at(clip, "_styk"), "movieclip"), "document"), "_styk"), "movieclipSource"), "document"), "_styk");
    let frame = source.get("frameSources").and_then(Value::as_obj).unwrap().keys().next().unwrap().to_string();
    let keys = at(at(at(at(source, "layerSheet"), "tracks"), "layer-1"), "keys").make_arr().unwrap();
    let patch = |uid: u32, frame: &str, replacement: Option<f64>| {
        let replacement = replacement.map_or(String::new(), |r| format!(r#","replacementUid":{r}"#));
        json::parse(format!(r#"{{"uid":{uid},"frameId":"{frame}"{replacement}}}"#).as_bytes()).unwrap()
    };
    keys[0].make_obj().unwrap().set("movieclipPatches", Value::array(vec![patch(1, &frame, Some(12345.0)), patch(2, "frame-nowhere", None), patch(3, &frame, None)]));
    report
}

#[test]
fn a_project_with_replacements_its_retained_scene_cannot_supply_is_saved_mended() {
    let written = save(&with_dangling_replacements());
    assert_eq!(written.repairs, 2, "the replacement by a missing figure and the one whose pose is missing");
    assert_eq!(written.warning, None);
    let (_, repairs) = reopened(&written);
    assert_eq!(repairs, 0, "the file needs no mending when it opens");
}

#[test]
fn a_frame_whose_joins_name_no_figure_is_saved_with_its_neighbours_joins() {
    // `camera-chain`: the second figure joined to the first and the third to the second, in both frames; the first frame's joins are given
    // the shapes a badly cut scene left (no slot, a figure joined to itself).
    let mut document = read("engine/tests/edit/camera-chain.document.json");
    let parents = |frame: &Value| -> Vec<Option<f64>> {
        let objects: Vec<Value> = frame.get("objects").and_then(Value::elements).unwrap().iter().collect();
        objects.iter().map(|o| o.get("join").filter(|j| j.truthy()).and_then(|j| j.get("target_object_slot")).and_then(Value::as_f64).and_then(|s| objects.get(s as usize)).and_then(|p| p.get("unique_id")).and_then(Value::as_f64)).collect()
    };
    let wanted = parents(&document.get("keyframes").and_then(Value::elements).unwrap().get(1).unwrap());
    assert!(wanted.iter().any(Option::is_some), "the fixture joins figures");
    let frames = at(&mut document, "keyframes").make_arr().unwrap();
    let objects = at(&mut frames[0], "objects").make_arr().unwrap();
    at(&mut objects[1], "join").make_obj().unwrap().remove("target_object_slot");
    at(&mut objects[1], "join").make_obj().unwrap().remove("target_unique_id");
    at(&mut objects[2], "join").make_obj().unwrap().set("target_object_slot", Value::Num(2.0));
    at(&mut objects[2], "join").make_obj().unwrap().remove("target_unique_id");
    let written = save(&document);
    assert_eq!(written.repairs, 1, "the first frame");
    assert_eq!(written.warning, None);
    let (opened, repairs) = reopened(&written);
    assert_eq!(repairs, 0);
    assert_eq!(parents(&opened.get("keyframes").and_then(Value::elements).unwrap().get(0).unwrap()), wanted);
}

/// A document that keeps itself `levels` times over as the scene its `movieclipSource` retains: a graph deeper than movieclips may run.
fn too_deep(levels: usize) -> Value {
    fn wrap(base: &Value, levels: usize) -> Value {
        let mut inner = base.clone();
        if levels > 0 {
            let mut source = json::parse(br#"{"inheritFigures":false}"#).unwrap().as_obj().cloned().unwrap();
            source.set("document", wrap(base, levels - 1));
            let mut styk = inner.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
            styk.set("movieclipSource", Value::object(source));
            inner.make_obj().unwrap().set("_styk", Value::object(styk));
        }
        inner
    }
    wrap(&read("engine/tests/edit/startup.document.json"), levels)
}

#[test]
fn a_project_made_too_deep_is_neither_refused_nor_written_unopenable() {
    // Ten levels of retained scenes: the limit is eight, the save used to refuse the project, and a file written beyond the limit could not
    // be opened. The deepest retained scenes are let go of, as many as it takes, and the project is saved.
    let tree = too_deep(10);
    assert!(styk_edit::load::prepare_editor_load(tree.clone()).is_err(), "the project is deeper than movieclips may run");
    let written = save(&tree);
    assert!(written.repairs >= 1, "retained scenes were let go of");
    assert_eq!(written.warning, None);
    let (opened, repairs) = reopened(&written);
    assert_eq!(repairs, 0);
    assert!(opened.path(&["_styk", "movieclipSource", "document"]).is_some(), "the retained scenes that fit are kept");
}

#[test]
fn what_no_repair_mends_is_written_with_the_reason() {
    // A movieclip whose retained scene has a layer timeline with a broken counter: opening refuses it and there is nothing to mend it from.
    let mut report = with_a_movieclip();
    let clip = last_clip(&mut report);
    let source = at(at(at(at(at(at(clip, "_styk"), "movieclip"), "document"), "_styk"), "movieclipSource"), "document");
    at(at(source, "_styk"), "layerSheet").make_obj().unwrap().set("nextId", Value::Num(0.0));
    let written = save(&report);
    assert_eq!(written.repairs, 0);
    assert!(written.warning.as_deref().is_some_and(|key| key.starts_with("errors.layerSheet.")), "{:?}", written.warning);
    assert!(!written.bytes.is_empty(), "the file is written");
}

#[test]
fn a_sound_project_is_written_without_repairs_or_warning() {
    let written = save(&with_a_movieclip());
    assert_eq!((written.repairs, written.warning), (0, None));
}
