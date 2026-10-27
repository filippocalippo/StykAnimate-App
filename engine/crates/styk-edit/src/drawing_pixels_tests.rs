//! Drawing pixel commits as session commands: the entries name the cel and the interface's record of the pixels, the weights and the
//! history limit are the session's, and undo and redo move the revision. The expected results are stated here (no recorded tape holds pixels).
use super::*;
use crate::session::Session;

fn json(value: &Value) -> String { styk_doc::json::to_string(value) }
fn parse(text: &str) -> Value { styk_doc::json::parse(text.as_bytes()).unwrap() }

const FIGURE: &str = r#"{"figure_type_id":2,"name":"Drawing","segment_count":1,"segments":[{"segment_id":1,"parent_id":0,"length":256,"angle_rad":0,"thickness":0,"bend_rad":0,"primitive_code":2,"aux_code":0,"flags":2,"segment_type":"image","segment_kind":"image","color_rgb":[0,0,0],"transparency":0,"extra_u16":0,"extra_u8_a":0,"extra_u8_b":0,"extra":[0,0,0],"visible":true,"z_order":1}],"polyfills":[],"image_assets":[{"kind":"image","asset_index":0,"table_index":0,"mime_type":"image/png","width":1,"height":1,"data_url":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=","anchor_start":{"x":0,"y":0},"anchor_end":{"x":256,"y":0},"anchor_length":256,"anchor_angle_rad":0,"display_width":1,"display_height":1,"drawing_anchor":{"x":0,"y":0}}],"text_assets":[],"_styk":{"sourceName":"Drawing","drawing":{"version":2,"celId":"cel-test","pixelsPerUnit":1,"revision":0,"bounds":null}}}"#;
const OBJECT: &str = r#"{"object_slot":0,"unique_id":2,"figure_type_id":2,"root_x":10,"root_y":20,"scale":1,"color_override_raw":0,"field28":0,"angles":[0],"len_flag":0,"lengths":[],"bend_flag":0,"bends":[],"join":null}"#;

/// A session on the first document of a recorded tape, with the history sized as the app sizes it.
fn session(bytes: u64) -> Session {
    let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/startup-sheet.reference.json");
    let reference = parse(&std::fs::read_to_string(file).unwrap());
    let first = reference.get("steps").unwrap().item(0).unwrap();
    let mut state = first.get("state").unwrap().as_obj().unwrap().clone();
    for (key, value) in reference.get("editor").unwrap().as_obj().unwrap().iter() { state.set(key, value.clone()); }
    let mut session = Session::start(parse(first.get("document").unwrap().as_str().unwrap()), &json(&Value::object(state))).unwrap();
    let view = json(&session.editor.state_value());
    let answer = parse(&session.call("@historyLimits", &format!("[80,{bytes}]"), &view));
    assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"), "{}", json(&answer));
    session
}

/// One call of the session as the owner makes it: the editor's view, the identities a call may draw.
fn call(session: &mut Session, method: &str, args: &str) -> Value {
    let mut view = session.editor.state_value().as_obj().unwrap().clone();
    view.set("autoKey", Value::Bool(session.editor.auto_key));
    view.set("patch", Value::Bool(true));
    view.set("changesOnly", Value::Bool(true));
    view.set("draws", parse(r#"[["uuid","11111111-2222-4333-8444-555555555555"],["uuid","66666666-2222-4333-8444-555555555555"]]"#));
    view.set("drawPool", Value::Bool(true));
    parse(&session.call(method, args, &json(&Value::object(view))))
}

fn ok(answer: &Value) -> &Value {
    assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"), "{}", json(answer));
    answer
}

fn query(session: &mut Session, kind: &str, args: &str) -> Value {
    parse(&session.query(kind, args, "null").unwrap()).get("v").cloned().unwrap()
}

/// A new drawing layer (one blank cel) and the identity of the layer and of the key that shows the cel.
fn drawing_layer(session: &mut Session) -> (String, String) {
    let answer = call(session, "createDrawingLayer", r#"["Ink"]"#);
    let layer = ok(&answer).get("result").unwrap().get("id").and_then(Value::as_str).unwrap().to_string();
    let key = session.editor.report().path(&["_styk", "layerSheet", "tracks", &layer, "keys"]).unwrap().item(0).unwrap().get("id").and_then(Value::as_str).unwrap().to_string();
    (layer, key)
}

fn first_stroke(layer: &str, key: &str) -> String {
    format!(r#"[{{"id":"{layer}","tick":0,"keyId":"{key}","celId":"cel-test","created":true,"selectable":true,"figure":{FIGURE},"object":{OBJECT}}},{{"record":7,"bytes":1000}},"Brush stroke"]"#)
}

fn next_stroke(layer: &str, key: &str, record: u32, bytes: u32, label: &str) -> String {
    format!(r#"[{{"id":"{layer}","tick":0,"keyId":"{key}","celId":"cel-test","selectable":true}},{{"record":{record},"bytes":{bytes}}},"{label}"]"#)
}

fn cels(session: &Session) -> Vec<String> {
    session.editor.report().get("figure_types").unwrap().elements().unwrap().iter().filter_map(|figure| figure.path(&["_styk", "drawing", "celId"]).and_then(Value::as_str).map(str::to_string)).collect()
}

fn labels(answer: &Value) -> (String, String) {
    let state = answer.get("state").unwrap();
    (state.get("undoLabel").and_then(Value::as_str).unwrap().to_string(), state.get("redoLabel").and_then(Value::as_str).unwrap().to_string())
}

#[test]
fn the_first_stroke_on_a_blank_exposure_creates_the_cel_and_is_one_entry_with_the_stroke() {
    let mut session = session(48 * 1024 * 1024);
    let (layer, key) = drawing_layer(&mut session);
    let before = session.editor.history_size().unwrap();
    let answer = call(&mut session, "commitDrawingPixels", &first_stroke(&layer, &key));
    assert_eq!(ok(&answer).get("result"), Some(&Value::Bool(true)));
    assert_eq!(cels(&session), ["cel-test"], "the cel joined the document");
    assert_eq!(labels(&answer).0, "Brush stroke");
    assert_eq!(json(answer.get("depths").unwrap()), "[2,0]", "the layer, and the cel with its stroke");
    assert_eq!(json(answer.get("sheetSelection").unwrap()), format!(r#"{{"id":"{layer}","contents":true}}"#), "painting selects the layer, as selecting it on the timeline does");
    // The weight is the interface's: the stroke's bytes, and a batch's 128.
    let weight = session.editor.history_size().unwrap() - before;
    assert!(weight >= 1000.0 + 128.0, "the entry weighs the stroke's bytes: {weight}");
    // The session names the commit for the interface, which applies the tiles.
    assert_eq!(json(&query(&mut session, "drawingReplay", "[false]")), r#"[{"celId":"cel-test","record":7}]"#);
    assert_eq!(json(&query(&mut session, "drawingReplay", "[true]")), "[]");
    assert_eq!(json(&query(&mut session, "drawingRefs", "[]")), r#"{"records":[7],"cels":["cel-test"]}"#);
    let edit = answer.get("events").unwrap().elements().unwrap().iter().find(|event| event.get("drawing").is_some_and(Value::truthy)).expect("the stroke announces itself");
    assert_eq!((edit.get("kind").and_then(Value::as_str), edit.get("label").and_then(Value::as_str)), (Some("edit"), Some("Brush stroke")));
    assert_eq!(json(edit.get("figureIndices").unwrap()), format!("[{}]", session.editor.report().get("figure_types").unwrap().array_len().unwrap() - 1));

    // Undo removes the cel again with the stroke; redo brings both back. The tiles are the interface's.
    let revision = session.editor.revision;
    let undone = call(&mut session, "undo", "[]");
    assert_eq!(ok(&undone).get("result"), Some(&Value::Bool(true)));
    assert!(cels(&session).is_empty());
    assert_eq!(labels(&undone), ("New drawing layer".to_string(), "Brush stroke".to_string()));
    assert_ne!(session.editor.revision, revision, "the document is another revision");
    assert_eq!(json(&query(&mut session, "drawingReplay", "[true]")), r#"[{"celId":"cel-test","record":7}]"#);
    let redone = call(&mut session, "redo", "[]");
    assert_eq!(ok(&redone).get("result"), Some(&Value::Bool(true)));
    assert_eq!(cels(&session), ["cel-test"]);
    assert_eq!(session.editor.revision, revision, "redo restores the revision the stroke made");
    assert!(redone.get("drawingRetired").is_none(), "no entry left the history");
}

#[test]
fn a_later_stroke_is_an_entry_of_its_own_and_undoes_to_the_revision_before_it() {
    let mut session = session(48 * 1024 * 1024);
    let (layer, key) = drawing_layer(&mut session);
    ok(&call(&mut session, "commitDrawingPixels", &first_stroke(&layer, &key)));
    let (revision, size) = (session.editor.revision, session.editor.history_size().unwrap());
    let answer = call(&mut session, "commitDrawingPixels", &next_stroke(&layer, &key, 8, 3000, "Erase stroke"));
    assert_eq!(ok(&answer).get("result"), Some(&Value::Bool(true)));
    assert_eq!(labels(&answer).0, "Erase stroke");
    assert_eq!(json(answer.get("depths").unwrap()), "[3,0]");
    assert_eq!(session.editor.history_size().unwrap() - size, 3000.0, "a stroke alone weighs what the interface measured");
    assert_eq!(json(&query(&mut session, "drawingReplay", "[false]")), r#"[{"celId":"cel-test","record":8}]"#);
    assert_eq!(json(&query(&mut session, "drawingRefs", "[]")), r#"{"records":[7,8],"cels":["cel-test"]}"#);
    let undone = call(&mut session, "undo", "[]");
    assert_eq!(labels(&undone), ("Brush stroke".to_string(), "Erase stroke".to_string()));
    assert_eq!(session.editor.revision, revision);
    assert_eq!(session.editor.history_size().unwrap(), size + 3000.0, "undo keeps the entry's weight");
    let history = undone.get("events").unwrap().elements().unwrap().iter().find(|event| event.get("kind").and_then(Value::as_str) == Some("history")).expect("undo announces the cel");
    assert_eq!((history.get("drawing"), history.get("definition")), (Some(&Value::Bool(true)), Some(&Value::Bool(true))));
    assert_eq!(history.get("label").and_then(Value::as_str), Some("Erase stroke"));
}

#[test]
fn a_new_edit_after_an_undo_retires_the_undone_stroke_and_says_so() {
    let mut session = session(48 * 1024 * 1024);
    let (layer, key) = drawing_layer(&mut session);
    ok(&call(&mut session, "commitDrawingPixels", &first_stroke(&layer, &key)));
    ok(&call(&mut session, "commitDrawingPixels", &next_stroke(&layer, &key, 8, 3000, "Erase stroke")));
    ok(&call(&mut session, "undo", "[]"));
    let size = session.editor.history_size().unwrap();
    let renamed = call(&mut session, "renameLayer", &format!(r#"["{layer}","Paint"]"#));
    assert_eq!(ok(&renamed).get("drawingRetired"), Some(&Value::Bool(true)), "the redo branch held a pixel commit");
    assert_eq!(json(&query(&mut session, "drawingRefs", "[]")), r#"{"records":[7],"cels":["cel-test"]}"#, "the retired commit's record is no entry's");
    assert!(session.editor.history_size().unwrap() < size + 3000.0, "its weight left the history");
    // An edit that retires nothing says nothing.
    let again = call(&mut session, "renameLayer", &format!(r#"["{layer}","Paint 2"]"#));
    assert!(ok(&again).get("drawingRetired").is_none());
}

#[test]
fn moving_a_record_to_the_disk_and_back_changes_the_weight_and_the_byte_limit_applies() {
    let mut session = session(48 * 1024 * 1024);
    let (layer, key) = drawing_layer(&mut session);
    ok(&call(&mut session, "commitDrawingPixels", &first_stroke(&layer, &key)));
    let mut size = session.editor.history_size().unwrap();
    ok(&call(&mut session, "commitDrawingPixels", &next_stroke(&layer, &key, 8, 500, "Fill")));
    assert_eq!(session.editor.history_size().unwrap() - size, 500.0);
    size = session.editor.history_size().unwrap();
    // The tiles of record 8 failed to reach the disk and came back into memory: they count again.
    let answer = call(&mut session, "@drawingBytes", "[8,3500]");
    assert_eq!(ok(&answer).get("result"), Some(&Value::Bool(true)));
    assert_eq!(session.editor.history_size().unwrap() - size, 3500.0);
    // And the other way: record 8 reached the disk after all.
    ok(&call(&mut session, "@drawingBytes", "[8,-3500]"));
    assert_eq!(session.editor.history_size().unwrap(), size);
    // The weight of a record inside a batch counts in the batch.
    let before = session.editor.history_size().unwrap();
    ok(&call(&mut session, "@drawingBytes", "[7,-400]"));
    assert_eq!(session.editor.history_size().unwrap() - before, -400.0);
    let summary = session.editor.history_value();
    let batch = summary.get("undo").unwrap().item(1).unwrap();
    assert_eq!(batch.get("label").and_then(Value::as_str), Some("Brush stroke"));
    assert_eq!(json(&batch.get("children").unwrap().item(1).unwrap().get("bytes").cloned().unwrap()), "600", "the stroke inside the batch weighs 600 now");
    ok(&call(&mut session, "@drawingBytes", "[7,400]"));
    // A record no entry holds changes nothing.
    assert_eq!(ok(&call(&mut session, "@drawingBytes", "[99,10]")).get("result"), Some(&Value::Bool(false)));
    assert_eq!(session.editor.history_size().unwrap(), size);
    // Past the byte limit the oldest entries retire: the layer, then the cel with its first stroke.
    ok(&call(&mut session, "@historyLimits", "[80,5000]"));
    let heavy = call(&mut session, "@drawingBytes", "[8,10]");
    assert_eq!(ok(&heavy).get("drawingRetired"), Some(&Value::Bool(true)));
    assert_eq!(json(heavy.get("depths").unwrap()), "[1,0]", "only the heavy stroke is left: the byte limit always keeps one entry");
    assert_eq!(json(&query(&mut session, "drawingRefs", "[]")), r#"{"records":[8],"cels":["cel-test"]}"#);
}

#[test]
fn a_stroke_on_an_exposure_that_changed_is_refused_and_leaves_the_history_alone() {
    let mut session = session(48 * 1024 * 1024);
    let (layer, key) = drawing_layer(&mut session);
    let depths = |answer: &Value| json(answer.get("depths").unwrap());
    let stale = first_stroke(&layer, "cell-999");
    let answer = call(&mut session, "commitDrawingPixels", &stale);
    assert_eq!(answer.get("status").and_then(Value::as_str), Some("error"));
    assert_eq!(answer.get("error").and_then(Value::as_str), Some("errors.editorDrawing.theDrawingExposureChangedBeforeTheEditFinished"));
    assert!(cels(&session).is_empty(), "the refused stroke created nothing");
    // A stroke of a cel the exposure does not show (it was replaced) is refused too.
    ok(&call(&mut session, "commitDrawingPixels", &first_stroke(&layer, &key)));
    let other = next_stroke(&layer, &key, 9, 10, "Brush stroke").replace("cel-test", "cel-other");
    let answer = call(&mut session, "commitDrawingPixels", &other);
    assert_eq!(answer.get("error").and_then(Value::as_str), Some("errors.editorDrawing.theDrawingExposureChangedBeforeTheEditFinished"));
    let depth = call(&mut session, "@drawingBytes", "[7,0]");
    assert_eq!(depths(&depth), "[2,0]", "nothing was recorded");
    // A hidden layer refuses painting.
    ok(&call(&mut session, "setLayerVisible", &format!(r#"["{layer}",false]"#)));
    let hidden = call(&mut session, "commitDrawingPixels", &next_stroke(&layer, &key, 10, 10, "Brush stroke"));
    assert_eq!(hidden.get("error").and_then(Value::as_str), Some("errors.editorDrawing.showAndUnlockBeforeDrawing"));
}

#[test]
fn a_stroke_that_migrates_a_v1_cel_is_one_entry_with_the_migration() {
    let mut session = session(48 * 1024 * 1024);
    let (layer, key) = drawing_layer(&mut session);
    ok(&call(&mut session, "commitDrawingPixels", &first_stroke(&layer, &key)));
    let size = session.editor.history_size().unwrap();
    // The migrated figure replaces the cel under the same object: a second definition, a second cel.
    let migrated = FIGURE.replace(r#""figure_type_id":2"#, r#""figure_type_id":3"#).replace("cel-test", "cel-migrated");
    let object = OBJECT.replace(r#""figure_type_id":2"#, r#""figure_type_id":3"#);
    let args = format!(r#"[{{"id":"{layer}","tick":0,"keyId":"{key}","celId":"cel-migrated","migratedFrom":"cel-test","selectable":true,"figure":{migrated},"object":{object}}},{{"record":9,"bytes":700}},"Fill"]"#);
    let answer = call(&mut session, "commitDrawingPixels", &args);
    assert_eq!(ok(&answer).get("result"), Some(&Value::Bool(true)));
    assert_eq!(cels(&session), ["cel-test", "cel-migrated"]);
    assert_eq!(labels(&answer).0, "Fill");
    assert!(session.editor.history_size().unwrap() - size >= 700.0 + 128.0);
    assert_eq!(json(&query(&mut session, "drawingReplay", "[false]")), r#"[{"celId":"cel-migrated","record":9}]"#);
    let undone = call(&mut session, "undo", "[]");
    assert_eq!(ok(&undone).get("result"), Some(&Value::Bool(true)));
    assert_eq!(cels(&session), ["cel-test"]);
}

#[test]
fn resampling_makes_a_cel_of_the_new_resolution_that_undoes_as_one_entry() {
    let mut session = session(48 * 1024 * 1024);
    let (layer, key) = drawing_layer(&mut session);
    ok(&call(&mut session, "commitDrawingPixels", &first_stroke(&layer, &key)));
    let args = format!(r#"[{{"id":"{layer}","keyId":"{key}","celId":"cel-test"}},{{"pixelsPerUnit":2,"bounds":{{"x":0,"y":0,"width":8,"height":8}}}}]"#);
    let answer = call(&mut session, "resampleDrawing", &args);
    let cel = ok(&answer).get("result").and_then(Value::as_str).unwrap().to_string();
    assert_eq!(cel, "cel-11111111-2222-4333-8444-555555555555", "the cel's identity is a draw of the call");
    assert_eq!(labels(&answer).0, "Resample drawing");
    let figures = session.editor.report().get("figure_types").unwrap().elements().unwrap().iter().collect::<Vec<_>>();
    let figure = figures.last().unwrap();
    assert_eq!(figure.get("figure_type_id").and_then(Value::as_f64), Some(3.0));
    assert_eq!(json(figure.path(&["_styk", "drawing"]).unwrap()), format!(r#"{{"version":2,"celId":"{cel}","pixelsPerUnit":2,"revision":0,"bounds":{{"x":0,"y":0,"width":8,"height":8}}}}"#));
    let asset = figure.path(&["image_assets"]).unwrap().item(0).unwrap();
    assert_eq!((asset.get("anchor_length").and_then(Value::as_f64), json(asset.get("anchor_end").unwrap())), (Some(512.0), r#"{"x":512,"y":0}"#.to_string()), "the anchors scale with the ratio");
    assert_eq!(figure.path(&["segments"]).unwrap().item(0).unwrap().get("length").and_then(Value::as_f64), Some(512.0));
    // The object of the exposure shows the new cel at half the scale (the pixels are twice as many).
    let source = session.editor.report().path(&["_styk", "layerSheet", "tracks", &layer, "keys"]).unwrap().item(0).unwrap().path(&["value", "frameId"]).and_then(Value::as_str).unwrap().to_string();
    let object = session.editor.report().path(&["_styk", "frameSources", &source, "objects"]).unwrap().item(0).unwrap();
    assert_eq!((object.get("figure_type_id").and_then(Value::as_f64), object.get("scale").and_then(Value::as_f64)), (Some(3.0), Some(0.5)));
    // The old cel stays in the history for the undo, the new one is in the history's cels.
    assert_eq!(json(&query(&mut session, "drawingRefs", "[]")), format!(r#"{{"records":[7],"cels":["cel-test","{cel}"]}}"#));
    let undone = call(&mut session, "undo", "[]");
    assert_eq!(labels(&undone), ("Brush stroke".to_string(), "Resample drawing".to_string()));
    assert_eq!(cels(&session), ["cel-test"]);
    // A resample of a cel the exposure no longer shows is refused.
    let stale = args.replace("cel-test", "cel-gone");
    assert_eq!(call(&mut session, "resampleDrawing", &stale).get("error").and_then(Value::as_str), Some("errors.editorDrawing.theDrawingChangedBeforeResampling"));
}

#[test]
fn a_commit_the_interface_could_not_apply_is_retracted_as_if_it_had_not_been_recorded() {
    let mut session = session(48 * 1024 * 1024);
    let (layer, key) = drawing_layer(&mut session);
    let (revision, size) = (session.editor.revision, session.editor.history_size().unwrap());
    // The commit that creates a cel is one entry with the stroke: both go.
    ok(&call(&mut session, "commitDrawingPixels", &first_stroke(&layer, &key)));
    assert_eq!(cels(&session), ["cel-test"]);
    let retracted = call(&mut session, "@retractDrawing", "[7]");
    assert_eq!(ok(&retracted).get("result"), Some(&Value::Bool(true)));
    assert_eq!(ok(&retracted).get("drawingRetired"), Some(&Value::Bool(true)), "the interface lets go of the cel it was about to give pixels");
    assert!(cels(&session).is_empty());
    assert_eq!(json(retracted.get("depths").unwrap()), "[1,0]", "the layer alone is left: nothing to redo");
    assert_eq!(session.editor.revision, revision);
    assert_eq!(session.editor.history_size().unwrap(), size);
    assert_eq!(json(&query(&mut session, "drawingRefs", "[]")), r#"{"records":[],"cels":[]}"#);
    // The same record names the next commit: nothing of the retracted one is left to clash with.
    ok(&call(&mut session, "commitDrawingPixels", &first_stroke(&layer, &key)));
    // A later stroke is retracted alone, the earlier history untouched.
    ok(&call(&mut session, "commitDrawingPixels", &next_stroke(&layer, &key, 8, 3000, "Erase stroke")));
    let size = session.editor.history_size().unwrap();
    // Only the entry recorded last can be retracted.
    assert_eq!(ok(&call(&mut session, "@retractDrawing", "[7]")).get("result"), Some(&Value::Bool(false)));
    assert_eq!(ok(&call(&mut session, "@retractDrawing", "[99]")).get("result"), Some(&Value::Bool(false)));
    assert_eq!(session.editor.history_size().unwrap(), size);
    let retracted = call(&mut session, "@retractDrawing", "[8]");
    assert_eq!(ok(&retracted).get("result"), Some(&Value::Bool(true)));
    assert_eq!(labels(&retracted).0, "Brush stroke");
    assert_eq!(session.editor.history_size().unwrap(), size - 3000.0);
    assert_eq!(json(&query(&mut session, "drawingRefs", "[]")), r#"{"records":[7],"cels":["cel-test"]}"#);
    assert_eq!(cels(&session), ["cel-test"], "the cel the first stroke made stays");
}

#[test]
fn the_pixel_commits_of_a_grouped_edit_in_progress_are_named_for_its_abort() {
    let mut session = session(48 * 1024 * 1024);
    let (layer, key) = drawing_layer(&mut session);
    ok(&call(&mut session, "commitDrawingPixels", &first_stroke(&layer, &key)));
    assert_eq!(json(&query(&mut session, "drawingBatch", "[]")), "[]", "no grouped edit is open");
    ok(&call(&mut session, "beginBatch", r#"["Two strokes"]"#));
    ok(&call(&mut session, "commitDrawingPixels", &next_stroke(&layer, &key, 8, 100, "Fill")));
    ok(&call(&mut session, "commitDrawingPixels", &next_stroke(&layer, &key, 9, 100, "Erase stroke")));
    assert_eq!(json(&query(&mut session, "drawingBatch", "[]")), r#"[{"celId":"cel-test","record":9},{"celId":"cel-test","record":8}]"#, "the last commit is taken back first");
    // The last commit of the group is retracted from the group, not from the history.
    let size = session.editor.history_size().unwrap();
    assert_eq!(ok(&call(&mut session, "@retractDrawing", "[9]")).get("result"), Some(&Value::Bool(true)));
    assert_eq!(session.editor.history_size().unwrap(), size, "the group's entries weigh nothing before the group ends");
    assert_eq!(json(&query(&mut session, "drawingBatch", "[]")), r#"[{"celId":"cel-test","record":8}]"#);
    let aborted = call(&mut session, "abortBatch", "[]");
    assert_eq!(ok(&aborted).get("drawingRetired"), Some(&Value::Bool(true)));
    assert_eq!(json(&query(&mut session, "drawingBatch", "[]")), "[]");
    assert_eq!(json(&query(&mut session, "drawingRefs", "[]")), r#"{"records":[7],"cels":["cel-test"]}"#);
}
