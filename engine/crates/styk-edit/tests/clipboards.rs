//! The clipboards the interface holds and hands to the session (`@setClipboard`): a copy answers with the clipboard it filled,
//! one handed to another session pastes there (as a copy from another document where it was), and what the interface
//! hands over wrongly is refused.

use styk_doc::Value;
use styk_edit::session::Session;

fn json(text: &str) -> Value { styk_doc::json::parse(text.as_bytes()).unwrap() }

/// A session on a recorded tape's document, as the tape's first step has it.
fn session(name: &str) -> Session {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../tests/edit/{name}.reference.json"));
    let reference = json(std::str::from_utf8(&std::fs::read(path).unwrap()).unwrap());
    let first = reference.get("steps").unwrap().item(0).unwrap();
    let mut state = first.get("state").unwrap().as_obj().unwrap().clone();
    for (key, value) in reference.get("editor").unwrap().as_obj().unwrap().iter() { state.set(key, value.clone()); }
    Session::start(json(first.get("document").unwrap().as_str().unwrap()), &styk_doc::json::to_string(&Value::object(state))).unwrap()
}

fn answer(session: &mut Session, method: &str, args: &str) -> Value { json(&session.call(method, args, "null")) }

/// A call with the identities it may draw, as the editor hands them to the session with its view.
fn drawn(session: &mut Session, method: &str, args: &str) -> Value {
    let uuids: Vec<String> = (1..=24).map(|i| format!("[\"uuid\",\"00000000-0000-4000-8000-{:012}\"]", 500 + i)).collect();
    json(&session.call(method, args, &format!(r#"{{"draws":[{}],"drawPool":true}}"#, uuids.join(","))))
}

fn ok(session: &mut Session, method: &str, args: &str) -> Value {
    let answer = answer(session, method, args);
    assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"), "{method} {args}: {answer:?}");
    answer.get("result").cloned().unwrap_or(Value::Null)
}

fn ok_drawn(session: &mut Session, method: &str, args: &str) -> Value {
    let answer = drawn(session, method, args);
    assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"), "{method} {args}: {answer:?}");
    answer.get("result").cloned().unwrap_or(Value::Null)
}

fn refused(session: &mut Session, method: &str, args: &str) -> String {
    let answer = answer(session, method, args);
    assert_eq!(answer.get("status").and_then(Value::as_str), Some("error"), "{method} {args}: {answer:?}");
    answer.get("error").and_then(Value::as_str).unwrap().to_string()
}

/// What a copy's answer says was copied: the kind and the clipboard.
fn copied(answer: &Value) -> (String, Value) {
    assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"), "{answer:?}");
    let clipboard = answer.get("clipboard").unwrap_or_else(|| panic!("the answer carries the clipboard: {answer:?}"));
    (clipboard.get("kind").and_then(Value::as_str).unwrap().to_string(), clipboard.get("data").cloned().unwrap())
}

/// `@setClipboard` for `session`: the interface hands it what another session copied.
fn hand_over(session: &mut Session, kind: &str, data: &Value, foreign: bool) {
    ok(session, "@setClipboard", &format!("[\"{kind}\",{},{foreign}]", styk_doc::json::to_string(data)));
}

fn count(session: &Session, key: &str) -> usize { session.report().get(key).and_then(Value::elements).map_or(0, |items| items.len()) }

fn text(session: &Session) -> String { styk_doc::json::to_string(session.report()) }

#[test]
fn a_copy_answers_with_what_it_copied() {
    let mut session = session("figure-clipboard-sheet");
    ok(&mut session, "select", "[1,-1]");
    let (kind, data) = copied(&answer(&mut session, "copySelection", "[]"));
    assert_eq!(kind, "figures");
    assert_eq!(data.get("objects").and_then(Value::elements).map(|objects| objects.len()), Some(1));
    assert_eq!(data.get("figures").and_then(Value::elements).map(|figures| figures.len()), Some(1));
    assert_eq!((data.get("offset").and_then(Value::as_f64), data.get("pastes").and_then(Value::as_f64)), (Some(24.0), Some(0.0)));
    assert_eq!(data.path(&["layers"]).and_then(|layers| layers.item(0)).and_then(|pair| pair.item(1)).and_then(|layer| layer.as_str().map(str::to_string)), Some("layer-1".to_string()));
    // A cut is pasted back where it was.
    let (_, cut) = copied(&answer(&mut session, "cutSelection", "[]"));
    assert_eq!(cut.get("offset").and_then(Value::as_f64), Some(0.0));
    // Nothing selected, nothing copied, no clipboard to keep.
    let nothing = answer(&mut session, "copySelection", "[]");
    assert_eq!(nothing.get("result"), Some(&Value::Num(0.0)));
    assert!(nothing.get("clipboard").is_none(), "{nothing:?}");
    // Copying in place pastes in place.
    ok(&mut session, "undo", "[]");
    ok(&mut session, "select", "[1,-1]");
    let (_, in_place) = copied(&answer(&mut session, "copySelection", r#"[{"inPlace":true}]"#));
    assert_eq!(in_place.get("offset").and_then(Value::as_f64), Some(0.0));
}

#[test]
fn figures_copied_in_another_document_paste_as_definitions_of_their_own() {
    let mut source = session("figure-clipboard-sheet");
    ok(&mut source, "select", "[1,-1]");
    let (kind, data) = copied(&answer(&mut source, "copySelection", "[]"));
    let mut here = session("figure-clipboard-sheet");
    let mut there = session("figure-clipboard-sheet");
    let (before_here, before_there) = (count(&here, "figure_types"), count(&there, "figure_types"));
    hand_over(&mut here, &kind, &data, false);
    hand_over(&mut there, &kind, &data, true);
    // As instances: the definition it was copied from, or one the document does not have.
    ok(&mut here, "pasteSelection", r#"[{"pasteMode":"instance"}]"#);
    ok(&mut there, "pasteSelection", r#"[{"pasteMode":"instance"}]"#);
    assert_eq!(count(&here, "figure_types"), before_here, "copied in this document: an instance of the same definition");
    assert_eq!(count(&there, "figure_types"), before_there + 1, "copied in another: its definition comes along");
    // The paste in the document it was copied in is the one the session that copied makes.
    ok(&mut source, "pasteSelection", r#"[{"pasteMode":"instance"}]"#);
    assert_eq!(text(&here), text(&source));
    ok(&mut there, "undo", "[]");
    assert_eq!(count(&there, "figure_types"), before_there, "one undo takes the definition back");
}

#[test]
fn what_the_interface_empties_or_garbles_is_not_pasted() {
    let mut session = session("figure-clipboard-sheet");
    ok(&mut session, "select", "[1,-1]");
    let (kind, data) = copied(&answer(&mut session, "copySelection", "[]"));
    // Emptied: nothing to paste.
    ok(&mut session, "@setClipboard", r#"["figures",null]"#);
    let before = text(&session);
    assert_eq!(ok(&mut session, "pasteSelection", "[]").elements().map(|pasted| pasted.len()), Some(0));
    assert_eq!(text(&session), before);
    // Garbled: refused, and what was held stays.
    hand_over(&mut session, &kind, &data, false);
    assert_eq!(refused(&mut session, "@setClipboard", r#"["figures",{"objects":[],"figures":[],"order":[],"offset":24}]"#), "errors.sharedClipboard.invalidFigureClipboard");
    assert_eq!(refused(&mut session, "@setClipboard", r#"["figures",{"objects":[{}],"figures":[],"order":[],"offset":null}]"#), "errors.sharedClipboard.invalidFigureClipboard");
    assert_eq!(refused(&mut session, "@setClipboard", r#"["sheet",{"version":2}]"#), "errors.sharedClipboard.invalidTimelineClipboard");
    // A figure the copy found on no layer is not garbled.
    let mut layerless = data.clone();
    layerless.make_obj().unwrap().set("layers", json(r#"[[1,null]]"#));
    hand_over(&mut session, &kind, &layerless, false);
    hand_over(&mut session, &kind, &data, false);
    assert_eq!(refused(&mut session, "@setClipboard", r#"["nothing",{}]"#), "errors.sharedClipboard.unsupportedClipboardType");
    assert_eq!(refused(&mut session, "@setClipboard", r#"["segmentValues",5]"#), "errors.sharedClipboard.unsupportedClipboardType");
    assert_eq!(text(&session), before);
    assert_eq!(ok(&mut session, "pasteSelection", "[]").elements().map(|pasted| pasted.len()), Some(1), "the clipboard it held is still there");
}

#[test]
fn a_copied_branch_pastes_as_a_definition_of_its_own() {
    // A selected branch is extracted as a definition the document does not have, which names it in `freshTypes`; pasted
    // here or handed to another session it is a definition of its own, never an instance of the one it came from.
    let mut source = session("figure-clipboard-sheet");
    ok(&mut source, "selectBranch", "[1,3]");
    let (kind, data) = copied(&answer(&mut source, "copySelection", "[]"));
    let fresh = data.get("freshTypes").and_then(Value::numbers).expect("the copy names the definition it made");
    assert_eq!(fresh.len(), 1);
    let made = data.get("figures").and_then(Value::elements).unwrap().iter().find(|figure| figure.get("figure_type_id").and_then(Value::as_f64) == Some(fresh[0])).expect("the definition is in the copy");
    assert_eq!(made.get("segments").and_then(Value::array_len), Some(3), "the branch alone: the joint, its child and its grandchild");
    assert!(made.get("segments").and_then(|segments| segments.item(0)).and_then(|segment| segment.get("parent_id").and_then(Value::as_f64)) == Some(0.0), "it hangs from the figure's origin");
    let before = count(&source, "figure_types");
    ok(&mut source, "pasteSelection", r#"[{"pasteMode":"instance"}]"#);
    assert_eq!(count(&source, "figure_types"), before + 1, "a fresh definition is never an instance of the document's");
    let mut here = session("figure-clipboard-sheet");
    let before = count(&here, "figure_types");
    hand_over(&mut here, &kind, &data, false);
    ok(&mut here, "pasteSelection", r#"[{"pasteMode":"instance"}]"#);
    assert_eq!(count(&here, "figure_types"), before + 1);
    // A cut takes the branch out of the figure, and pasting puts it back in place.
    let mut cut = session("figure-clipboard-sheet");
    ok(&mut cut, "selectBranch", "[1,3]");
    assert_eq!(ok(&mut cut, "cutSelection", "[]").as_f64(), Some(1.0));
    let figure = cut.report().get("figure_types").and_then(|figures| figures.item(0)).unwrap();
    assert_eq!(figure.get("segments").and_then(Value::array_len), Some(3), "three of its six joints went");
}

#[test]
fn timeline_frames_copied_here_or_elsewhere_paste_the_same_way() {
    let mut source = session("sheet-clipboard-sheet");
    let (kind, data) = copied(&answer(&mut source, "sheetCopyFrames", r#"[["layer-1"],0,3]"#));
    assert_eq!(kind, "sheet");
    assert_eq!((data.get("version").and_then(Value::as_f64), data.get("duration").and_then(Value::as_f64)), (Some(1.0), Some(4.0)));
    assert_eq!(data.path(&["rows"]).and_then(|rows| rows.item(0)).and_then(|row| row.get("id").and_then(Value::as_str).map(str::to_string)), Some("layer-1".to_string()));
    assert!(data.get("figures").is_some_and(Value::is_array) && data.get("backgrounds").is_some_and(Value::is_array));
    // Handed to a session of the same document it pastes what the session that copied pastes.
    let mut same = session("sheet-clipboard-sheet");
    hand_over(&mut same, &kind, &data, false);
    ok(&mut source, "sheetPasteFrames", r#"[["layer-1"],6]"#);
    ok(&mut same, "sheetPasteFrames", r#"[["layer-1"],6]"#);
    assert_eq!(text(&same), text(&source));
    // In another document every figure it brings is a new one.
    let mut other = session("sheet-clipboard-sheet");
    hand_over(&mut other, &kind, &data, true);
    let (figures, uids) = (count(&other, "figure_types"), styk_doc::json::to_string(other.report().path(&["_styk", "layers", "assignments"]).unwrap()));
    ok(&mut other, "sheetPasteFrames", r#"[["layer-1"],6]"#);
    assert!(count(&other, "figure_types") > figures, "its definitions come along");
    assert_ne!(styk_doc::json::to_string(other.report().path(&["_styk", "layers", "assignments"]).unwrap()), uids);
    ok(&mut other, "undo", "[]");
    assert_eq!(count(&other, "figure_types"), figures);
    ok(&mut other, "redo", "[]");
    assert!(count(&other, "figure_types") > figures);
}

#[test]
fn a_scene_copied_in_another_document_brings_its_backgrounds() {
    let mut source = session("channels-pose-sheet");
    let (kind, data) = copied(&answer(&mut source, "sheetCopyFrames", r#"[["scene","camera","layer-1"],0,3]"#));
    let backgrounds = data.get("backgrounds").and_then(Value::elements).map_or(0, |items| items.len());
    assert!(backgrounds > 0, "the document has backgrounds to bring");
    let mut other = session("figure-clipboard-sheet");
    let (held, figures) = (count(&other, "backgrounds"), count(&other, "figure_types"));
    let before = text(&other);
    hand_over(&mut other, &kind, &data, true);
    ok(&mut other, "sheetPasteFrames", r#"[["scene","camera","layer-1"],0,{"insert":true}]"#);
    assert_eq!(count(&other, "backgrounds"), held + backgrounds, "the scene row's backgrounds are new ones");
    assert!(count(&other, "figure_types") > figures);
    let ids: Vec<f64> = other.report().get("backgrounds").and_then(Value::elements).unwrap().iter().filter_map(|b| b.get("background_id").and_then(Value::as_f64)).collect();
    assert_eq!(ids.len(), ids.iter().map(|id| *id as u64).collect::<std::collections::HashSet<_>>().len(), "background identities stay unique: {ids:?}");
    let after = text(&other);
    ok(&mut other, "undo", "[]");
    assert_eq!(text(&other), before, "one undo takes back the frames, the definitions and the backgrounds");
    ok(&mut other, "redo", "[]");
    assert_eq!(text(&other), after);
}

#[test]
fn camera_motion_segment_values_camera_and_effect_clips_follow_the_same_way() {
    // Camera motion.
    let mut source = session("camera-motion-sheet");
    let clip = source.report().path(&["_styk", "cameraMotion", "clips"]).and_then(|clips| clips.item(0)).and_then(|clip| clip.get("id").cloned()).unwrap();
    let (kind, data) = copied(&answer(&mut source, "copyCameraMotion", &format!("[{}]", styk_doc::json::to_string(&clip))));
    assert_eq!((kind.as_str(), data.get("id")), ("cameraMotion", Some(&clip)));
    let mut other = session("camera-motion-sheet");
    hand_over(&mut other, &kind, &data, false);
    ok_drawn(&mut source, "pasteCameraMotion", "[9]");
    ok_drawn(&mut other, "pasteCameraMotion", "[9]");
    assert_eq!(text(&other), text(&source));
    // The camera.
    let (kind, data) = copied(&answer(&mut source, "copyCamera", "[]"));
    assert_eq!(kind, "camera");
    let mut other = session("camera-motion-sheet");
    hand_over(&mut other, &kind, &data, false);
    let after = ok(&mut source, "pasteCamera", "[[0]]");
    assert_eq!(ok(&mut other, "pasteCamera", "[[0]]"), after);
    // Segment values.
    let mut source = session("segment-clipboard-sheet");
    ok(&mut source, "@select", "[3,2]");
    let (kind, data) = copied(&answer(&mut source, "copySegmentValues", "[]"));
    assert_eq!(kind, "segmentValues");
    assert!(data.as_str().is_some_and(|text| text.split(':').count() == 3), "{data:?}");
    let mut other = session("segment-clipboard-sheet");
    hand_over(&mut other, &kind, &data, false);
    for session in [&mut source, &mut other] { ok(session, "@select", "[3,1]"); ok(session, "pasteSegmentValues", "[]"); }
    assert_eq!(text(&other), text(&source));
    // An effect clip, with the effects as they were at the playhead when it was copied.
    let mut source = session("vfx-clip-add-sheet");
    let clip = source.report().path(&["_styk", "vfxClips", "clips"]).and_then(|clips| clips.item(0)).and_then(|clip| clip.get("id").cloned()).unwrap();
    let (kind, data) = copied(&answer(&mut source, "copyVfxClip", &format!("[{}]", styk_doc::json::to_string(&clip))));
    assert_eq!((kind.as_str(), data.path(&["clip", "id"])), ("vfxClip", Some(&clip)));
    assert!(data.get("values").is_some(), "the effects at the playhead travel with it");
    let mut other = session("vfx-clip-add-sheet");
    hand_over(&mut other, &kind, &data, false);
    let target = r#"[{"kind":"figure","uid":1}]"#;
    let pasted = ok_drawn(&mut source, "pasteVfxClip", target);
    assert_eq!(ok_drawn(&mut other, "pasteVfxClip", target), pasted);
    assert_eq!(text(&other), text(&source));
}
