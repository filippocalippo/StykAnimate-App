//! Calls on movieclips, imports and clipboards the session used to refuse and the editor ran instead, on the documents of
//! recorded tapes: what each stores, what undo takes back and that the session answers it (no `unported`).

use styk_doc::Value;
use styk_edit::session::Session;

fn json(text: &str) -> Value { styk_doc::json::parse(text.as_bytes()).unwrap() }

fn read(path: &str) -> Value {
    let folder = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    json(std::str::from_utf8(&std::fs::read(folder.join(path)).unwrap()).unwrap())
}

const STATE: &str = r#"{"layerTimeline":true,"propertyChannels":true,"tick":0,"frameIndex":0,"selectedUid":null,"selectedUids":[],"selectedJoint":-1,"activeLayerId":"layer-1","nextFrameIdentity":100,"nextUid":60}"#;

/// A session on a recorded tape's document, at the first frame, with `layer-1` active.
fn session(name: &str) -> Session { Session::start(read(&format!("tests/edit/{name}.document.json")), STATE).unwrap() }

/// A call with identities to draw, as the editor hands them to the session with its view: where the playhead and the selection are.
fn drawn(session: &mut Session, method: &str, args: &str, tick: u32, selected: &[u32]) -> Value {
    let uuids: Vec<String> = (1..=24).map(|i| format!("[\"uuid\",\"00000000-0000-4000-8000-{i:012}\"]")).collect();
    let ids: Vec<String> = selected.iter().map(u32::to_string).collect();
    let first = selected.first().map_or("null".to_string(), u32::to_string);
    let view = format!(r#"{{"tick":{tick},"frameIndex":0,"selectedUid":{first},"selectedUids":[{}],"selectedJoint":-1,"activeLayerId":"layer-1","draws":[{}],"drawPool":true}}"#, ids.join(","), uuids.join(","));
    json(&session.call(method, args, &view))
}

fn ok(session: &mut Session, method: &str, args: &str) -> Value {
    let answer = json(&session.call(method, args, "null"));
    assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"), "{method} {args}: {answer:?}");
    answer.get("result").cloned().unwrap_or(Value::Null)
}

fn ok_drawn(session: &mut Session, method: &str, args: &str, tick: u32, selected: &[u32]) -> Value {
    let answer = drawn(session, method, args, tick, selected);
    assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"), "{method} {args}: {answer:?}");
    answer.get("result").cloned().unwrap_or(Value::Null)
}

fn undo_label(session: &mut Session) -> String {
    json(&session.call("seek", "[0]", "null")).path(&["state", "undoLabel"]).and_then(Value::as_str).unwrap_or("").to_string()
}

fn entries(session: &mut Session) -> usize {
    let mut count = 0;
    while session.can_undo() {
        ok(session, "undo", "[]");
        count += 1;
    }
    count
}

fn presence(playback: Option<&Value>) -> bool {
    playback.is_some_and(|p| p.get("clock").and_then(Value::as_str) == Some("presence") && p.get("offset").and_then(Value::as_f64) == Some(0.0))
}

fn figures_of(session: &Session, key: &str) -> usize { session.report().get(key).and_then(Value::elements).map_or(0, |e| e.len()) }

fn cels(session: &Session) -> Vec<String> {
    session.report().get("figure_types").and_then(Value::elements).unwrap().iter()
        .filter_map(|figure| figure.path(&["_styk", "drawing", "celId"]).and_then(Value::as_str).map(str::to_string)).collect()
}

#[test]
fn a_movieclip_instance_is_duplicated_on_the_presence_clock() {
    for (name, tick) in [("sheet-movieclip", 0), ("sheet-movieclip-timed", 3)] {
        let mut session = session(name);
        ok(&mut session, "seek", &format!("[{tick}]"));
        ok(&mut session, "select", "[4,-1]");
        let copy = ok(&mut session, "duplicateFigure", "[]");
        assert_ne!(copy.get("unique_id").and_then(Value::as_f64), Some(4.0), "{name}");
        assert!(presence(copy.get("_stykMovieclip")), "{name}: {copy:?}");
        assert_eq!(undo_label(&mut session), "Duplicate figure");
        assert_eq!(entries(&mut session), 1, "{name}: one entry");
    }
}

#[test]
fn a_movieclip_is_added_from_the_project_at_the_playhead_and_across_frames() {
    let mut session = session("sheet-movieclip");
    let added = ok(&mut session, "addFigure", "[4]");
    assert_eq!(added.get("figure_type_id").and_then(Value::as_f64), Some(4.0));
    assert!(presence(added.get("_stykMovieclip")));
    assert_eq!(undo_label(&mut session), "Add figure");
    let range = ok(&mut session, "addFigureInFrames", r#"[4,null,{"ticks":[1,4]}]"#);
    assert_eq!(range.get("insertedUids").and_then(Value::numbers).map(|u| u.len()), Some(1));
    assert_eq!(undo_label(&mut session), "Add figures across frames");
    assert_eq!(entries(&mut session), 2, "one entry each");
}

#[test]
fn duplicating_figures_across_frames_copies_their_effect_clips_in_the_same_entry() {
    let mut session = session("vfx-clips");
    let clips = |session: &Session| session.report().path(&["_styk", "vfxClips", "clips"]).and_then(Value::elements).map_or(0, |c| c.len());
    let before = clips(&session);
    ok(&mut session, "select", "[1,-1]");
    let outcome = ok_drawn(&mut session, "duplicateFiguresInFrames", r#"[null,{"ticks":[0,3]}]"#, 0, &[1]);
    let copy = outcome.get("insertedUids").and_then(Value::numbers).unwrap()[0];
    assert!(copy > 1.0);
    // The figure had three effect clips of its own (the fourth is the scene's); the copy has them too.
    let targeting = session.report().path(&["_styk", "vfxClips", "clips"]).and_then(Value::elements).unwrap().iter()
        .filter(|c| c.path(&["target", "uid"]).and_then(Value::as_f64) == Some(copy)).count();
    assert_eq!(targeting, 3);
    assert_eq!(clips(&session), before + 3);
    assert_eq!(undo_label(&mut session), "Duplicate figures across frames");
    assert_eq!(entries(&mut session), 1, "the figures and their effects are one entry");
    assert_eq!(clips(&session), before);
}

#[test]
fn a_movieclip_with_the_documents_own_clock_breaks_apart() {
    let mut session = session("sheet-movieclip-timed");
    ok(&mut session, "seek", "[3]");
    ok(&mut session, "select", "[4,-1]");
    let parts = ok(&mut session, "breakApartMovieclip", "[]");
    assert!(parts.elements().is_some_and(|parts| !parts.is_empty()), "{parts:?}");
    assert_eq!(undo_label(&mut session), "Break apart frame");
    assert!(entries(&mut session) >= 1);
}

#[test]
fn a_movieclip_file_is_imported_after_its_documents_are_prepared() {
    let mut session = session("sheet-layers");
    let before = figures_of(&session, "figure_types");
    let imported = ok(&mut session, "importFigure", &styk_doc::json::to_string(&Value::array(vec![read("tests/edit/clip-break-native.document.json")])));
    assert!(presence(imported.get("_stykMovieclip")), "{imported:?}");
    assert!(figures_of(&session, "figure_types") > before);
    assert_eq!(undo_label(&mut session), "Import figure");
    assert_eq!(entries(&mut session), 1);
}

#[test]
fn figures_with_animation_origins_are_imported() {
    let mut session = session("sheet-layers");
    let imported = ok(&mut session, "importFigure", &styk_doc::json::to_string(&Value::array(vec![read("tests/edit/branch-thickness-origin-sheet.document.json")])));
    assert!(imported.get("unique_id").is_some(), "{imported:?}");
    let origins = session.report().get("figure_types").and_then(Value::elements).unwrap().iter().filter(|f| f.path(&["_styk", "animationOrigin"]).is_some_and(Value::truthy)).count();
    assert!(origins > 0, "the origin figure came with its definition");
    assert_eq!(entries(&mut session), 1);
}

#[test]
fn a_handle_of_a_movieclip_instance_is_repositioned() {
    let mut session = session("sheet-movieclip");
    ok(&mut session, "select", "[4,0]");
    assert_eq!(ok(&mut session, "beginHandleEditDrag", "[]"), Value::Bool(true));
    assert_eq!(ok(&mut session, "editHandlePosition", "[500,400]"), Value::Bool(true));
    assert_eq!(ok(&mut session, "commitHandleEditDrag", "[]"), Value::Bool(true));
    assert_eq!(entries(&mut session), 1);
}

// --- drawings -----------------------------------------------------------------------------------

/// The startup document with a drawing layer `layer-2` whose first cel (figure 26, from the drawing fixtures) is held from
/// frame 0 to the layer's end at frame 10.
fn with_a_cel() -> Session {
    let source = read("crates/styk-eval/tests/fixtures/drawing-grid/multiple-children.json");
    let figure = source.get("figure_types").and_then(|f| f.item(0)).unwrap();
    let mut object = source.get("keyframes").and_then(|k| k.item(0)).and_then(|k| k.get("objects").cloned()).and_then(|o| o.item(0)).unwrap().as_obj().unwrap().clone();
    object.set("unique_id", Value::Num(50.0));
    object.set("object_slot", Value::Num(0.0));
    object.set("join", Value::Null);
    let frame = json(&format!(
        r#"{{"duration_raw":1,"background_id":0,"background_id_b":0,"background_mix":0,"camera":{{"is_default":true,"x":0,"y":0,"scale":1,"angle_rad":0}},"object_draw_order":[0],"object_draw_order_unique_ids":[50],"_styk":{{"frameId":"frame-90"}},"objects":[{}]}}"#,
        styk_doc::json::to_string(&Value::object(object))
    ));
    let mut report = read("tests/edit/startup.document.json");
    report.make_obj().unwrap().get_mut("figure_types").unwrap().make_arr().unwrap().push(figure);
    let styk = report.make_obj().unwrap().get_mut("_styk").unwrap().make_obj().unwrap();
    let layers = styk.get_mut("layers").unwrap().make_obj().unwrap();
    layers.get_mut("order").unwrap().make_arr().unwrap().push(Value::str("layer-2"));
    layers.set("nextId", Value::Num(3.0));
    layers.get_mut("byId").unwrap().make_obj().unwrap().set("layer-2", json(r#"{"name":"Drawing","visible":true,"locked":false,"drawing":{"version":1}}"#));
    layers.get_mut("assignments").unwrap().make_obj().unwrap().set("50", Value::str("layer-2"));
    let sheet = styk.get_mut("layerSheet").unwrap().make_obj().unwrap();
    sheet.set("nextId", Value::Num(100.0));
    sheet.get_mut("tracks").unwrap().make_obj().unwrap().set("layer-2", json(r#"{"end":10,"keys":[{"id":"cell-90","tick":0,"interpolation":"constant","value":{"frameId":"frame-90"},"empty":false}]}"#));
    let mut sources = styk.get("frameSources").and_then(Value::as_obj).cloned().unwrap_or_default();
    sources.set("frame-90", frame);
    styk.set("frameSources", Value::object(sources));
    Session::start(report, STATE).unwrap()
}

fn forks_of(answer: &Value) -> Vec<(String, String)> {
    answer.get("drawingForks").and_then(Value::elements).map(|forks| forks.iter().map(|pair| (pair.item(0).unwrap().as_str().unwrap().to_string(), pair.item(1).unwrap().as_str().unwrap().to_string())).collect()).unwrap_or_default()
}

#[test]
fn a_pasted_drawing_is_a_cel_of_its_own_and_tells_which_cel_it_copies() {
    let mut session = with_a_cel();
    let first = cels(&session)[0].clone();
    ok(&mut session, "select", "[50,-1]");
    assert_eq!(ok(&mut session, "copySelection", "[]"), Value::Num(1.0));
    ok(&mut session, "seek", "[1]");
    let answer = drawn(&mut session, "pasteSelection", "[{}]", 1, &[50]);
    assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"), "{answer:?}");
    let after = cels(&session);
    assert_eq!(after.len(), 2);
    assert!(after[1].starts_with("cel-") && after[1] != first, "{after:?}");
    assert_eq!(forks_of(&answer), vec![(first, after[1].clone())], "the pixels of the cel it copies go to the new one");
}

#[test]
fn frames_of_a_drawing_layer_paste_as_cels_of_their_own() {
    let mut session = with_a_cel();
    let first = cels(&session)[0].clone();
    let layer = ok(&mut session, "createDrawingLayer", r#"["Ink 2"]"#);
    let target = layer.get("id").and_then(Value::as_str).unwrap().to_string();
    ok(&mut session, "sheetCopyFrames", r#"[["layer-2"],0,5]"#);
    let answer = drawn(&mut session, "sheetPasteFrames", &format!(r#"[["{target}"],2]"#), 0, &[]);
    assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"), "{answer:?}");
    let after = cels(&session);
    assert_eq!(after.len(), 2);
    assert_eq!(forks_of(&answer), vec![(first, after[1].clone())]);
    assert_eq!(undo_label(&mut session), "Paste frames");
    // Moving them is one entry too, and its cels are new again.
    let moved = drawn(&mut session, "sheetTransferFrames", &format!(r#"[["layer-2"],["{target}"],0,5,7,{{"copy":true}}]"#), 0, &[]);
    assert_eq!(moved.get("status").and_then(Value::as_str), Some("ok"), "{moved:?}");
    assert_eq!(cels(&session).len(), 3);
    assert_eq!(forks_of(&moved).len(), 1);
    assert_eq!(undo_label(&mut session), "Copy frames to layer");
}

#[test]
fn capturing_a_drawing_layer_gives_the_clip_cels_and_drawing_keys_of_its_own() {
    let mut session = with_a_cel();
    let first = cels(&session)[0].clone();
    let clip = ok_drawn(&mut session, "createMovieclip", r#"[{"start":0,"end":6,"uids":[]}]"#, 0, &[]);
    let inside = clip.path(&["_styk", "movieclip", "document"]).unwrap();
    let captured: Vec<String> = inside.get("figure_types").and_then(Value::elements).unwrap().iter()
        .filter_map(|figure| figure.path(&["_styk", "drawing", "celId"]).and_then(Value::as_str).map(str::to_string)).collect();
    assert_eq!(captured.len(), 1);
    assert_ne!(captured[0], first, "the clip's cel is not the project's");
    let tracks = inside.path(&["_styk", "layerSheet", "tracks"]).and_then(Value::as_obj).unwrap();
    let keys = tracks.get("layer-2").and_then(|track| track.get("keys")).and_then(Value::elements).unwrap();
    assert!(!keys.is_empty() && keys.iter().all(|key| key.get("interpolation").and_then(Value::as_str) == Some("constant")), "the layer's keys are drawing keys");
    assert!(inside.path(&["_styk", "frameSources"]).and_then(Value::as_obj).is_some_and(|sources| !sources.is_empty()), "each exposure has a pose of its own");
    assert_eq!(undo_label(&mut session), "Create movieclip");
}

#[test]
fn a_clip_of_drawings_gets_a_figure_layer_of_its_own_above_the_drawing_layer() {
    let mut session = with_a_cel();
    let order = |session: &Session| -> Vec<String> {
        session.report().path(&["_styk", "layers", "order"]).and_then(Value::elements).unwrap().iter().filter_map(|id| id.as_str().map(str::to_string)).collect()
    };
    assert_eq!(order(&session), ["layer-1", "layer-2"]);
    ok_drawn(&mut session, "createMovieclip", r#"[{"start":0,"end":6,"uids":[50]}]"#, 0, &[]);
    // Drawing layers hold only drawing cels: the clip is on a figure layer made directly above the drawing layer, named after the clip.
    assert_eq!(order(&session), ["layer-1", "layer-2", "layer-3"]);
    let layers = session.report().path(&["_styk", "layers"]).unwrap().clone();
    let layer = layers.path(&["byId", "layer-3"]).unwrap();
    assert!(layer.get("drawing").is_none(), "a figure layer, not a drawing layer");
    assert_eq!(layer.get("name").and_then(Value::as_str), Some("Movieclip"));
    assert_eq!(layers.get("nextId").and_then(Value::as_f64), Some(4.0));
    let owners: Vec<&str> = layers.get("assignments").and_then(Value::as_obj).unwrap().iter().filter(|(_, layer)| layer.as_str() == Some("layer-3")).map(|(uid, _)| &**uid).collect();
    assert_eq!(owners.len(), 1, "the clip's instance is on the new layer");
    let track = session.report().path(&["_styk", "layerSheet", "tracks", "layer-3"]).unwrap();
    assert!(track.get("keys").and_then(Value::elements).is_some_and(|keys| !keys.is_empty()), "the new layer has the clip's exposure");
    assert_eq!(undo_label(&mut session), "Create movieclip");
    ok(&mut session, "undo", "[]");
    assert_eq!(order(&session), ["layer-1", "layer-2"], "undo takes the layer back");
}

#[test]
fn copied_drawing_keys_show_cels_of_their_own() {
    let mut session = with_a_cel();
    let first = cels(&session)[0].clone();
    let answer = drawn(&mut session, "sheetMoveFrames", r#"[["layer-2"],0,5,12,{"copy":true}]"#, 0, &[]);
    assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"), "{answer:?}");
    let after = cels(&session);
    assert_eq!(after.len(), 2);
    assert_eq!(forks_of(&answer), vec![(first, after[1].clone())], "the pixels of the copied cel go to the new one");
    assert_eq!(undo_label(&mut session), "Copy frames");
    // Moving them copies nothing.
    let moved = drawn(&mut session, "sheetMoveFrames", r#"[["layer-2"],0,5,14]"#, 0, &[]);
    assert_eq!(moved.get("status").and_then(Value::as_str), Some("ok"), "{moved:?}");
    assert_eq!(cels(&session).len(), 2);
    assert!(forks_of(&moved).is_empty());
}

#[test]
fn an_imported_figure_with_a_pose_the_document_cannot_hold_is_refused() {
    let mut session = session("sheet-layers");
    let before = styk_doc::json::to_string(session.report());
    let mut file = read("tests/edit/branch-thickness-origin-sheet.document.json");
    let first = file.make_obj().unwrap().get_mut("keyframes").unwrap().make_arr().unwrap()[0].make_obj().unwrap().get_mut("objects").unwrap().make_arr().unwrap()[0].make_obj().unwrap();
    first.set("scale", Value::Num(-1.0));
    let answer = json(&session.call("importFigure", &styk_doc::json::to_string(&Value::array(vec![file])), "null"));
    assert_eq!(answer.get("status").and_then(Value::as_str), Some("error"), "{answer:?}");
    assert_eq!(answer.get("error").and_then(Value::as_str), Some("errors.model.objectScaleCannotBeNegative"));
    assert_eq!(styk_doc::json::to_string(session.report()), before, "a refused import leaves the document alone");
    assert_eq!(entries(&mut session), 0);
}
