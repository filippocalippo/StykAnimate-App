//! A project saved after making a movieclip opens again. The clip keeps the scene it was made from, cut down to its figures; the
//! frame replacements that scene's layer sheet records (a movieclip placed over frames of the timeline) are cut down with it, or the
//! saved file names a replacement by a figure the scene no longer holds and is refused when it opens
//! (`errors.layerSheet.invalidMovieclipFrameReplacement`).

use styk_doc::Value;
use styk_edit::load::prepare_for_editor;
use styk_edit::session::Session;

fn json(text: &str) -> Value { styk_doc::json::parse(text.as_bytes()).unwrap() }

fn read(path: &str) -> Value {
    let folder = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    json(std::str::from_utf8(&std::fs::read(folder.join(path)).unwrap()).unwrap())
}

const STATE: &str = r#"{"layerTimeline":true,"propertyChannels":true,"tick":0,"frameIndex":0,"selectedUid":null,"selectedUids":[],"selectedJoint":-1,"activeLayerId":"layer-1","nextFrameIdentity":100,"nextUid":60}"#;

fn call(session: &mut Session, method: &str, args: &str, selected: &[u32]) -> Value {
    let uuids: Vec<String> = (1..=24).map(|i| format!("[\"uuid\",\"00000000-0000-4000-8000-{i:012}\"]")).collect();
    let ids: Vec<String> = selected.iter().map(u32::to_string).collect();
    let first = selected.first().map_or("null".to_string(), u32::to_string);
    let view = format!(r#"{{"tick":0,"frameIndex":0,"selectedUid":{first},"selectedUids":[{}],"selectedJoint":-1,"activeLayerId":"layer-1","draws":[{}],"drawPool":true}}"#, ids.join(","), uuids.join(","));
    let answer = json(&session.call(method, args, &view));
    assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"), "{method} {args}: {answer:?}");
    answer.get("result").cloned().unwrap_or(Value::Null)
}

/// The sheet's frame replacements that name a figure the frame they take it from does not hold, in every retained scene of `document`.
fn dangling(document: &Value, found: &mut Vec<String>, at: &str) {
    let sources = document.path(&["_styk", "frameSources"]);
    let tracks = document.path(&["_styk", "layerSheet", "tracks"]).and_then(Value::as_obj);
    for (id, track) in tracks.into_iter().flat_map(|t| t.iter()) {
        for key in track.get("keys").and_then(Value::elements).into_iter().flat_map(|k| k.iter()) {
            for patch in key.get("movieclipPatches").and_then(Value::elements).into_iter().flat_map(|p| p.iter()) {
                let Some(replacement) = patch.get("replacementUid").and_then(Value::as_f64) else { continue };
                let frame = patch.get("frameId").and_then(Value::as_str).and_then(|frame| sources.and_then(|s| s.get(frame)));
                let holds = frame.and_then(|f| f.get("objects")).and_then(Value::elements).is_some_and(|objects| objects.iter().any(|o| o.get("unique_id").and_then(Value::as_f64) == Some(replacement)));
                if !holds {
                    found.push(format!("{at} {id} {}: {}", key.get("id").and_then(Value::as_str).unwrap_or("?"), patch.path(&["frameId"]).and_then(Value::as_str).unwrap_or("?")));
                }
            }
        }
    }
    if let Some(retained) = document.path(&["_styk", "movieclipSource", "document"]) {
        dangling(retained, found, &format!("{at}/source"));
    }
    for figure in document.get("figure_types").and_then(Value::elements).into_iter().flat_map(|f| f.iter()) {
        if let Some(clip) = figure.path(&["_styk", "movieclip", "document"]) {
            dangling(clip, found, &format!("{at}/clip"));
        }
    }
}

#[test]
fn a_movieclip_made_beside_a_placed_one_keeps_no_replacement_by_a_figure_it_does_not_hold() {
    let mut session = Session::start(read("tests/edit/sheet-movieclip.document.json"), STATE).unwrap();
    // A movieclip placed over the timeline replaces frames of its layer, naming the figure that stands for it in them.
    let placed = call(&mut session, "addFigure", "[4]", &[]);
    let instance = placed.get("unique_id").and_then(Value::as_f64).unwrap() as u32;
    // Another movieclip, made of one figure of the project.
    call(&mut session, "createMovieclip", r#"[{"start":0,"end":3}]"#, &[1]);
    let report = session.report();
    let mut found = Vec::new();
    dangling(&report, &mut found, "project");
    assert!(found.is_empty(), "replacements by figures the retained scene does not hold (instance {instance}): {found:?}");
    prepare_for_editor(report.clone(), true).expect("the project opens after it is saved");
}

#[test]
fn a_second_movieclip_made_after_the_first_cuts_its_retained_scene_down_too() {
    let mut session = Session::start(read("tests/edit/sheet-movieclip.document.json"), STATE).unwrap();
    call(&mut session, "addFigure", "[4]", &[]);
    call(&mut session, "createMovieclip", r#"[{"start":0,"end":3}]"#, &[1]);
    let report = session.report();
    let mut found = Vec::new();
    dangling(&report, &mut found, "project");
    assert!(found.is_empty(), "{found:?}");
    // A clip made again from the project, which now holds a clip with a retained scene of its own.
    call(&mut session, "createMovieclip", r#"[{"start":0,"end":3}]"#, &[2]);
    let report = session.report();
    dangling(&report, &mut found, "project");
    assert!(found.is_empty(), "{found:?}");
    prepare_for_editor(report.clone(), true).expect("the project opens after it is saved");
}

fn at<'a>(value: &'a mut Value, key: &str) -> &'a mut Value { value.make_obj().unwrap().get_mut(key).unwrap() }

/// The project as the files of the builds that kept the sheet whole have it: the retained scene of the clip is given a replacement by a figure
/// its poses do not hold and one whose pose is not there.
fn damaged() -> Value {
    let mut session = Session::start(read("tests/edit/sheet-movieclip.document.json"), STATE).unwrap();
    call(&mut session, "createMovieclip", r#"[{"start":0,"end":3}]"#, &[1]);
    let mut report = session.report().clone();
    let figures = at(&mut report, "figure_types").make_arr().unwrap();
    let clip = figures.iter_mut().filter(|f| f.path(&["_styk", "movieclip"]).is_some()).last().unwrap();
    let source = at(at(at(at(at(at(at(clip, "_styk"), "movieclip"), "document"), "_styk"), "movieclipSource"), "document"), "_styk");
    let frame = source.get("frameSources").and_then(Value::as_obj).unwrap().keys().next().unwrap().to_string();
    let keys = at(at(at(at(source, "layerSheet"), "tracks"), "layer-1"), "keys").make_arr().unwrap();
    let patch = |uid: u32, frame: &str, replacement: Option<f64>| {
        json(&format!(r#"{{"uid":{uid},"frameId":"{frame}"{}}}"#, replacement.map_or(String::new(), |r| format!(r#","replacementUid":{r}"#))))
    };
    keys[0].make_obj().unwrap().set("movieclipPatches", Value::array(vec![patch(1, &frame, Some(12345.0)), patch(2, "frame-nowhere", None), patch(3, &frame, None)]));
    report
}

#[test]
fn a_project_saved_with_a_replacement_its_scene_cannot_supply_opens_and_says_what_was_mended() {
    let opened = prepare_for_editor(damaged(), true).expect("the damaged project opens");
    assert_eq!(opened.repairs, 2, "the replacement by a missing figure and the one whose pose is missing");
    let mut found = Vec::new();
    dangling(&opened.report, &mut found, "project");
    assert!(found.is_empty(), "{found:?}");
    // The replacement whose pose is there stays, as a replacement by nothing; the one without a pose goes.
    let figures: Vec<Value> = opened.report.get("figure_types").and_then(Value::elements).unwrap().iter().collect();
    let clip = figures.iter().filter(|f| f.path(&["_styk", "movieclip"]).is_some()).last().unwrap();
    let keys = clip.path(&["_styk", "movieclip", "document", "_styk", "movieclipSource", "document", "_styk", "layerSheet", "tracks", "layer-1", "keys"]).and_then(Value::elements).unwrap();
    let key = keys.get(0).unwrap();
    let patches = key.get("movieclipPatches").and_then(Value::elements).unwrap();
    assert_eq!(patches.len(), 2);
    assert!(patches.iter().all(|p| p.get("replacementUid").is_none()));
}

#[test]
fn a_project_that_needs_no_mending_opens_as_the_file_holds_it() {
    let mut session = Session::start(read("tests/edit/sheet-movieclip.document.json"), STATE).unwrap();
    call(&mut session, "addFigure", "[4]", &[]);
    call(&mut session, "createMovieclip", r#"[{"start":0,"end":3}]"#, &[1]);
    let report = session.report();
    let opened = prepare_for_editor(report.clone(), true).unwrap();
    assert_eq!(opened.repairs, 0);
    let sheet = |document: &Value| styk_doc::json::to_string(document.path(&["_styk", "layerSheet"]).unwrap());
    assert_eq!(sheet(&opened.report), sheet(&report));
}
