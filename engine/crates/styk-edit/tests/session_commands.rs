//! Commands the session took over from the editor, on the documents of recorded tapes: what each stores, what it
//! refuses and what one undo takes back. (Commands with recordings of their own are replayed against them:
//! `layer_sheet_commands.rs`, `movieclip_sheet_extension.rs`.)

use styk_doc::Value;
use styk_edit::session::Session;

fn json(text: &str) -> Value { styk_doc::json::parse(text.as_bytes()).unwrap() }

fn session(name: &str) -> Session {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../tests/edit/{name}.reference.json"));
    let reference = styk_doc::json::parse(&std::fs::read(path).unwrap()).unwrap();
    let first = reference.get("steps").unwrap().item(0).unwrap();
    let mut state = first.get("state").unwrap().as_obj().unwrap().clone();
    for (key, value) in reference.get("editor").unwrap().as_obj().unwrap().iter() { state.set(key, value.clone()); }
    Session::start(json(first.get("document").unwrap().as_str().unwrap()), &styk_doc::json::to_string(&Value::object(state))).unwrap()
}

fn answer(session: &mut Session, method: &str, args: &str) -> Value { json(&session.call(method, args, "null")) }

fn ok(session: &mut Session, method: &str, args: &str) -> Value {
    let answer = answer(session, method, args);
    assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"), "{method} {args}: {answer:?}");
    answer.get("result").cloned().unwrap_or(Value::Null)
}

/// The refusal's message key.
fn refused(session: &mut Session, method: &str, args: &str) -> String {
    let answer = answer(session, method, args);
    assert_eq!(answer.get("status").and_then(Value::as_str), Some("error"), "{method} {args}: {answer:?}");
    answer.get("error").and_then(Value::as_str).unwrap().to_string()
}

fn undo_label(session: &mut Session) -> String {
    answer(session, "seek", "[0]").path(&["state", "undoLabel"]).and_then(Value::as_str).unwrap_or("").to_string()
}

fn numbers(value: Option<&Value>) -> Vec<f64> { value.and_then(Value::numbers).unwrap_or_default() }

#[test]
fn figures_are_pasted_into_every_chosen_frame_as_one_entry() {
    let mut session = session("figure-clipboard-sheet");
    // Nothing copied: nothing pasted.
    let none = ok(&mut session, "pasteFiguresInFrames", "[[0]]");
    assert_eq!(numbers(none.get("changedTicks")), Vec::<f64>::new());
    ok(&mut session, "select", "[1,-1]");
    assert_eq!(ok(&mut session, "copySelection", "[]"), Value::Num(1.0));
    let outcome = ok(&mut session, "pasteFiguresInFrames", "[[0,1]]");
    assert_eq!(outcome.get("changedFrames").and_then(Value::as_f64), Some(2.0));
    assert_eq!(numbers(outcome.get("changedTicks")), vec![0.0, 6.0], "the keys the frames start at");
    assert_eq!(numbers(outcome.get("insertedUids")), vec![4.0], "the copy has the next identity");
    assert_eq!(undo_label(&mut session), "Paste figures across frames");
    // The copy is on the layer of the figure it copies, and both frames hold it.
    let report = session.report();
    assert_eq!(report.path(&["_styk", "layers", "assignments", "4"]).and_then(Value::as_str), Some("layer-1"));
    let sources = report.path(&["_styk", "frameSources"]).and_then(Value::as_obj).unwrap();
    let holding = sources.values().iter().filter(|frame| frame.get("objects").and_then(Value::elements).is_some_and(|objects| objects.iter().any(|o| o.get("unique_id").and_then(Value::as_f64) == Some(4.0)))).count();
    assert!(holding >= 2, "both frames hold the copy, {holding}");
    ok(&mut session, "undo", "[]");
    assert!(session.report().path(&["_styk", "layers", "assignments", "4"]).is_none(), "one undo takes the copy out of both frames");
    ok(&mut session, "redo", "[]");
    assert!(session.report().path(&["_styk", "layers", "assignments", "4"]).is_some());
}

#[test]
fn a_paste_across_frames_refuses_what_a_paste_does() {
    let mut session = session("figure-clipboard-sheet");
    ok(&mut session, "select", "[1,-1]");
    ok(&mut session, "copySelection", "[]");
    let before = styk_doc::json::to_string(session.report());
    assert_eq!(refused(&mut session, "pasteFiguresInFrames", r#"[[1],{"pasteMode":"bogus"}]"#), "errors.editorRangeCommands.chooseAValidFigurePasteMode");
    assert_eq!(refused(&mut session, "pasteFiguresInFrames", r#"[[1],{"pasteDepth":"x"}]"#), "errors.editorRangeCommands.chooseAValidFigurePasteDepth");
    assert_eq!(refused(&mut session, "pasteFiguresInFrames", "[[99]]"), "errors.editor.selectExistingKeyframes");
    assert_eq!(styk_doc::json::to_string(session.report()), before);
}

#[test]
fn camera_motion_is_keyed_on_the_camera_track_and_the_clips_are_silenced_there() {
    let mut session = session("camera-motion-sheet");
    let keys = |session: &Session| -> Vec<(f64, String)> {
        session.report().path(&["_styk", "layerSheet", "tracks", "camera", "keys"]).and_then(Value::elements).unwrap().iter()
            .map(|key| (key.get("tick").and_then(Value::as_f64).unwrap(), key.get("interpolation").and_then(Value::as_str).unwrap_or("").to_string())).collect()
    };
    let clips = |session: &Session| -> Vec<(bool, Value)> {
        session.report().path(&["_styk", "cameraMotion", "clips"]).and_then(Value::elements).unwrap().iter()
            .map(|clip| (clip.get("enabled").is_some_and(Value::truthy), clip.get("mutedRanges").cloned().unwrap_or(Value::Null))).collect()
    };
    assert_eq!(keys(&session), vec![(0.0, "linear".to_string())]);
    let before: Vec<String> = clips(&session).iter().map(|(enabled, muted)| format!("{enabled} {}", styk_doc::json::to_string(muted))).collect();
    assert_eq!(ok(&mut session, "bakeCameraMotion", r#"[{"start":4,"end":9}]"#), Value::Bool(true));
    // Held keys from the start of the sampled span to the end of the range, and the key after it as it was.
    let baked = keys(&session);
    assert_eq!(baked.len(), 10);
    assert!(baked[..9].iter().enumerate().all(|(i, (tick, easing))| *tick == i as f64 && easing == "constant"), "{baked:?}");
    assert_eq!(baked[9], (9.0, "linear".to_string()), "the camera returns to the track's own after the range");
    // The clips are silent over the range; the motion they made is in the keys.
    let muted = clips(&session);
    assert_eq!(styk_doc::json::to_string(&muted[0].1), r#"[{"start":4,"end":9}]"#, "the follow clip");
    assert_eq!(styk_doc::json::to_string(&muted[1].1), r#"[{"start":12,"end":16}]"#, "the shake clip starts after the range: its own silence stays");
    assert_eq!(undo_label(&mut session), "Bake camera motion");
    ok(&mut session, "undo", "[]");
    assert_eq!(keys(&session), vec![(0.0, "linear".to_string())], "one undo takes the keys and the silence");
    let after: Vec<String> = clips(&session).iter().map(|(enabled, muted)| format!("{enabled} {}", styk_doc::json::to_string(muted))).collect();
    assert_eq!(after, before);
}

#[test]
fn baking_asks_for_a_range_of_whole_frames_inside_the_animation() {
    let mut session = session("camera-motion-sheet");
    let before = styk_doc::json::to_string(session.report());
    for range in [r#"{"start":3,"end":3}"#, r#"{"start":-1,"end":4}"#, r#"{"start":0,"end":41}"#, r#"{"start":0.5,"end":4}"#, r#"{"start":null}"#] {
        assert_eq!(refused(&mut session, "bakeCameraMotion", &format!("[{range}]")), "errors.editorCameraMotion.bakeAValidRangeOfAtMost100", "{range}");
    }
    assert_eq!(styk_doc::json::to_string(session.report()), before);
    assert!(!session.can_undo());
}

#[test]
fn nothing_is_baked_when_no_motion_plays() {
    let mut session = session("camera-motion-add-sheet");
    assert_eq!(ok(&mut session, "bakeCameraMotion", "[]"), Value::Bool(false));
    assert!(!session.can_undo());
}

#[test]
fn a_locked_camera_is_not_baked() {
    let mut session = session("camera-motion-sheet");
    ok(&mut session, "setLayerLocked", r#"["camera",true]"#);
    assert_eq!(refused(&mut session, "bakeCameraMotion", "[]"), "errors.editorCameraMotion.unlockCameraBeforeEditingMotion");
}

#[test]
fn the_exposure_under_the_playhead_is_set() {
    let mut session = session("add-figure-sheet");
    let end = |session: &Session| session.report().path(&["_styk", "layerSheet", "tracks", "layer-1", "end"]).and_then(Value::as_f64).unwrap();
    let before = end(&session);
    assert_eq!(ok(&mut session, "setFrameDuration", "[4]"), Value::Bool(true));
    assert!(end(&session) < before, "the key under the playhead holds fewer frames, so the layer is shorter");
    assert_eq!(undo_label(&mut session), "Remove frames");
    let longer = format!("[{}]", 4 + (before - end(&session)) as u32 + 20);
    assert_eq!(ok(&mut session, "setFrameDuration", &longer), Value::Bool(true), "and longer again");
    ok(&mut session, "undo", "[]");
    assert_eq!(ok(&mut session, "setFrameDuration", "[4]"), Value::Bool(false), "the same length changes nothing");
    assert_eq!(refused(&mut session, "setFrameDuration", "[0]"), "errors.editorLayerSheet.exposureMustBe165535Frames");
    assert_eq!(refused(&mut session, "setFrameDuration", "[70000]"), "errors.editorLayerSheet.exposureMustBe165535Frames");
    ok(&mut session, "undo", "[]");
    assert_eq!(end(&session), before);
}

// --- drawings -----------------------------------------------------------------------------------

/// The startup document with a drawing layer `layer-2` whose first cel (figure 26, from the drawing fixtures) is held
/// from frame 0 to the layer's end at frame 10.
fn with_a_cel() -> Session {
    let folder = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let read = |path: &str| styk_doc::json::parse(&std::fs::read(folder.join(path)).unwrap()).unwrap();
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
    let state = r#"{"layerTimeline":true,"propertyChannels":true,"tick":0,"frameIndex":0,"selectedUid":null,"selectedUids":[],"selectedJoint":-1,"activeLayerId":"layer-2","nextFrameIdentity":100,"nextUid":60}"#;
    Session::start(report, state).unwrap()
}

/// A call that draws identities, as the editor hands them to the session with its view (the layer `layer-2` active).
fn draw(session: &mut Session, method: &str, args: &str, extra: &str) -> Value {
    let uuids: Vec<String> = (1..=8).map(|i| format!("[\"uuid\",\"00000000-0000-4000-8000-{i:012}\"]")).collect();
    let view = format!(r#"{{"tick":0,"frameIndex":0,"selectedUid":null,"selectedUids":[],"selectedJoint":-1,"activeLayerId":"layer-2",{extra}"draws":[{}],"drawPool":true}}"#, uuids.join(","));
    json(&session.call(method, args, &view))
}

fn cels(session: &Session) -> Vec<String> {
    session.report().get("figure_types").and_then(Value::elements).unwrap().iter()
        .filter_map(|figure| figure.path(&["_styk", "drawing", "celId"]).and_then(Value::as_str).map(str::to_string)).collect()
}

fn keys_of(session: &Session, layer: &str) -> Vec<(f64, bool)> {
    session.report().path(&["_styk", "layerSheet", "tracks", layer, "keys"]).and_then(Value::elements).unwrap().iter()
        .map(|key| (key.get("tick").and_then(Value::as_f64).unwrap(), key.get("empty").is_some_and(Value::truthy))).collect()
}

#[test]
fn a_new_drawing_layer_starts_with_a_blank_cel_and_one_undo_takes_both() {
    let mut session = session("add-figure-sheet");
    let layer = ok(&mut session, "createDrawingLayer", r#"["Ink"]"#);
    assert_eq!(layer.get("name").and_then(Value::as_str), Some("Ink"));
    assert_eq!(layer.path(&["drawing", "version"]).and_then(Value::as_f64), Some(1.0));
    let id = layer.get("id").and_then(Value::as_str).unwrap().to_string();
    assert_eq!(keys_of(&session, &id), vec![(0.0, true)], "a blank cel from the first frame");
    assert_eq!(undo_label(&mut session), "New drawing layer");
    ok(&mut session, "undo", "[]");
    assert!(session.report().path(&["_styk", "layers", "byId", &id]).is_none() && session.report().path(&["_styk", "layerSheet", "tracks", &id]).is_none());
    assert!(!session.can_undo(), "the layer and its cel were one entry");
    ok(&mut session, "redo", "[]");
    assert_eq!(keys_of(&session, &id), vec![(0.0, true)]);
}

#[test]
fn a_copied_cel_is_a_definition_of_its_own_and_tells_which_cel_it_copies() {
    let mut session = with_a_cel();
    assert_eq!(cels(&session).len(), 1);
    let first = cels(&session)[0].clone();
    // The answer names the pixels' source and target for the interface, which holds the pixels.
    let answer = draw(&mut session, "drawingKey", r#"[["layer-2"],4]"#, "");
    assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"), "{answer:?}");
    assert_eq!(answer.get("result"), Some(&Value::Bool(true)));
    let after = cels(&session);
    assert_eq!(after.len(), 2);
    assert!(after[1].starts_with("cel-") && after[1] != first, "{after:?}");
    let forks = answer.get("drawingForks").and_then(Value::elements).expect("the copied cels");
    assert_eq!(forks.len(), 1);
    assert_eq!(styk_doc::json::to_string(&forks.get(0).unwrap()), format!(r#"["{first}","{}"]"#, after[1]));
    assert_eq!(keys_of(&session, "layer-2"), vec![(0.0, false), (4.0, false)]);
    assert_eq!(undo_label(&mut session), "Copy drawing");
    ok(&mut session, "undo", "[]");
    assert_eq!(cels(&session), vec![first], "undo takes the copy's definition away with its key");
}

#[test]
fn a_blank_cel_is_keyed_without_a_definition() {
    let mut session = with_a_cel();
    assert_eq!(ok(&mut session, "drawingKey", r#"[["layer-2"],4,{"blank":true}]"#), Value::Bool(true));
    assert_eq!(keys_of(&session, "layer-2"), vec![(0.0, false), (4.0, true)]);
    assert_eq!(cels(&session).len(), 1);
    assert_eq!(undo_label(&mut session), "Blank drawing");
    // A copy where a cel already starts changes nothing.
    assert_eq!(ok(&mut session, "drawingKey", r#"[["layer-2"],0]"#), Value::Bool(false));
}

#[test]
fn the_next_drawing_makes_room_after_the_exposure_and_goes_to_it() {
    let mut session = with_a_cel();
    let drawn = draw(&mut session, "nextDrawing", r#"[["layer-2"],{"blank":false,"length":3}]"#, "");
    assert_eq!(drawn.get("result"), Some(&Value::Bool(true)), "{drawn:?}");
    // The first cel held ten frames; the layer grew by three and the copy starts where the first ended.
    assert_eq!(keys_of(&session, "layer-2"), vec![(0.0, false), (10.0, false)]);
    assert_eq!(session.report().path(&["_styk", "layerSheet", "tracks", "layer-2", "end"]).and_then(Value::as_f64), Some(13.0));
    assert_eq!(cels(&session).len(), 2);
    let state = answer(&mut session, "seek", "[10]");
    assert_eq!(state.path(&["state", "tick"]).and_then(Value::as_f64), Some(10.0));
    assert_eq!(undo_label(&mut session), "Next copied drawing");
    ok(&mut session, "undo", "[]");
    assert_eq!(keys_of(&session, "layer-2"), vec![(0.0, false)]);
    assert_eq!(session.report().path(&["_styk", "layerSheet", "tracks", "layer-2", "end"]).and_then(Value::as_f64), Some(10.0));
    assert!(!session.can_undo(), "making room and the cel were one entry");
}

#[test]
fn a_cel_can_be_held_longer_and_the_layer_grows_with_it() {
    let mut session = with_a_cel();
    assert_eq!(ok(&mut session, "extendDrawing", r#"[["layer-2"],4]"#), Value::Bool(true));
    assert_eq!(session.report().path(&["_styk", "layerSheet", "tracks", "layer-2", "end"]).and_then(Value::as_f64), Some(14.0));
    assert_eq!(undo_label(&mut session), "Extend drawing exposure");
    assert_eq!(refused(&mut session, "extendDrawing", r#"[["layer-2"],0]"#), "errors.editorDrawing.chooseAPositiveExposureExtension");
}

#[test]
fn a_frame_is_added_after_the_cel_that_starts_there() {
    let mut session = with_a_cel();
    // Where a cel starts, the next frame is a blank cel after it; where none does, a blank cel is keyed there.
    assert_eq!(ok(&mut session, "addDrawingFrame", r#"["layer-2",0]"#), Value::Bool(true));
    assert_eq!(keys_of(&session, "layer-2"), vec![(0.0, false), (10.0, true)], "after the ten frames the first cel held");
    assert_eq!(ok(&mut session, "addDrawingFrame", r#"["layer-2",5]"#), Value::Bool(true));
    assert_eq!(keys_of(&session, "layer-2"), vec![(0.0, false), (5.0, true), (10.0, true)], "inside an exposure a cel is keyed where it is asked for");
}

#[test]
fn painting_with_auto_key_first_copies_the_held_cel_to_the_playhead() {
    let mut session = with_a_cel();
    assert_eq!(draw(&mut session, "autoKeyDrawing", r#"["layer-2",3]"#, "").get("result"), Some(&Value::Bool(false)), "auto key is off");
    let answer = draw(&mut session, "autoKeyDrawing", r#"["layer-2",3]"#, r#""autoKey":true,"#);
    assert_eq!(answer.get("result"), Some(&Value::Bool(true)), "{answer:?}");
    assert_eq!(keys_of(&session, "layer-2"), vec![(0.0, false), (3.0, false)]);
    // On the key itself there is nothing to copy.
    let again = draw(&mut session, "autoKeyDrawing", r#"["layer-2",3]"#, r#""autoKey":true,"#);
    assert_eq!(again.get("result"), Some(&Value::Bool(false)));
}

#[test]
fn drawing_commands_refuse_a_layer_that_is_not_a_drawing_that_can_be_drawn_on() {
    let mut session = with_a_cel();
    assert_eq!(refused(&mut session, "drawingKey", "[[],1]"), "errors.editorDrawing.chooseADrawingLayer");
    assert_eq!(refused(&mut session, "drawingKey", r#"[["layer-1"],1]"#), "errors.editorDrawing.chooseADrawingLayerOrCreateANew");
    assert_eq!(refused(&mut session, "nextDrawing", r#"[["layer-2"],{"length":70000}]"#), "errors.editorDrawing.chooseAnExposureLengthOf165535");
    ok(&mut session, "setLayerVisible", r#"["layer-2",false]"#);
    assert_eq!(refused(&mut session, "drawingKey", r#"[["layer-2"],1]"#), "errors.editorDrawing.showAndUnlockBeforeDrawing");
}

#[test]
fn a_key_or_a_frame_after_on_a_drawing_layer_is_a_cel() {
    let mut session = with_a_cel();
    // The layer timeline's insert key: on a drawing layer it keys a cel.
    assert_eq!(ok(&mut session, "sheetInsertKey", r#"[["layer-2"],3,{"blank":true}]"#), Value::Bool(true));
    assert_eq!(keys_of(&session, "layer-2"), vec![(0.0, false), (3.0, true)]);
    assert_eq!(undo_label(&mut session), "Blank drawing");
    ok(&mut session, "undo", "[]");
    // The duplicate after the playhead: the next cel, a copy.
    let drawn = draw(&mut session, "sheetDuplicateFrameAfter", r#"[["layer-2"],0]"#, "");
    assert_eq!(drawn.get("result"), Some(&Value::Bool(true)), "{drawn:?}");
    assert_eq!(cels(&session).len(), 2);
    assert_eq!(undo_label(&mut session), "Next copied drawing");
}
