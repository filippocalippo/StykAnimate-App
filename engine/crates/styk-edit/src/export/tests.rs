//! Pivot and figure exports of recorded documents (`engine/tests/edit` tapes): what they bake, what they refuse and what a
//! figure file holds. The byte-level expectations are the JavaScript tests of the export path (`tests/pivot-export-*.test.mjs`), which run against the engine, and the exported files of the repository's documents.

use std::path::Path;
use std::sync::Arc;

use styk_doc::Value;
use styk_eval::eval::Prepared;
use styk_eval::load::Loader;

use super::style::StyleTable;
use super::{export_document, items, number, Exported, FigureRequest, Format, Hold, Request, CANCELLED};
use crate::session::Session;
use crate::EditError;

fn parse(text: &str) -> Value {
    styk_doc::json::parse(text.as_bytes()).unwrap()
}

/// The document a tape starts from, and the session that runs its steps.
fn tape(name: &str) -> (Value, Session, Vec<Value>) {
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../tests/edit/{name}.reference.json"));
    let reference = parse(&std::fs::read_to_string(file).unwrap());
    let steps: Vec<Value> = reference.get("steps").unwrap().elements().unwrap().iter().collect();
    let mut state = steps[0].get("state").unwrap().as_obj().unwrap().clone();
    for (key, value) in reference.get("editor").unwrap().as_obj().unwrap().iter() {
        state.set(key, value.clone());
    }
    let document = parse(steps[0].get("document").unwrap().as_str().unwrap());
    let session = Session::start(document.clone(), &styk_doc::json::to_string(&Value::object(state))).unwrap();
    (document, session, steps)
}

fn export(tree: &Value, request: &Request) -> Result<Exported, EditError> {
    let mut loader = Loader::new();
    let document = loader.document(tree, "").unwrap();
    let prepared = Arc::new(Prepared::new(Arc::new(document)));
    export_document(tree, &loader, &prepared, request, &Hold { cancel: &|| false })
}

fn request(format: Format) -> Request {
    Request { format, name: Some("Test".into()), figure: FigureRequest { figure_type_id: Some(1.0), figure_uid: Some(1.0), figure_uids: Vec::new(), tick: 0.0 } }
}

fn total_ticks(report: &Value) -> f64 {
    crate::timeline::total_ticks(&crate::timeline::rows(report))
}

/// A native document of two stored keys as the editor opens it: with the layer sheet that stands for them.
fn imported() -> Value {
    let (startup, _, _) = tape("startup-sheet");
    let object = startup.get("keyframes").unwrap().item(0).unwrap().get("objects").unwrap().item(0).unwrap();
    let frame = |duration: f64| {
        let mut frame = crate::sheet::create_frame(&[object.clone()]);
        super::set(&mut frame, "duration_raw", Value::Num(duration));
        frame
    };
    let mut document = startup.as_obj().unwrap().clone();
    document.set("keyframes", Value::array(vec![frame(3.0), frame(1.0)]));
    document.remove("_styk");
    crate::load::prepare_for_editor(Value::object(document), true).unwrap().report
}

#[test]
fn an_untouched_imported_sheet_exports_the_stored_frames_it_stands_for() {
    let document = imported();
    assert!(document.path(&["_styk", "layerSheet"]).is_some());
    let exported = export(&document, &request(Format::Piv)).unwrap();
    let out = &exported.document;
    assert_eq!(items(out.get("keyframes")).len(), items(document.get("keyframes")).len());
    for (frame, stored) in items(out.get("keyframes")).iter().zip(items(document.get("keyframes"))) {
        assert_eq!(number(frame, "duration_raw"), number(&stored, "duration_raw"));
        assert!(frame.path(&["_styk", "frameId"]).is_none(), "editor identities are not Pivot data");
    }
    assert_eq!(out.path(&["_styk", "name"]).and_then(Value::as_str), Some("Test"));
    assert!(!exported.drawings);
}

#[test]
fn a_sheet_longer_than_its_stored_keys_bakes_every_tick() {
    let (document, _, _) = tape("startup-sheet");
    let exported = export(&document, &request(Format::Piv)).unwrap();
    assert_eq!(items(exported.document.get("keyframes")).len() as f64, total_ticks(&document));
    assert!(exported.document.path(&["_styk", "layerSheet"]).is_none());
}

#[test]
fn authored_tracks_bake_into_one_stored_frame_for_each_tick() {
    let (_, mut session, steps) = tape("channels-pose-sheet");
    for step in &steps[1..] {
        let call: Vec<Value> = step.get("call").unwrap().elements().unwrap().iter().collect();
        let mut view = session.editor.state_value().as_obj().unwrap().clone();
        view.set("autoKey", Value::Bool(session.editor.auto_key));
        let args = styk_doc::json::to_string(&Value::array(call[1..].to_vec()));
        session.call(call[0].as_str().unwrap().trim_start_matches('@'), &args, &styk_doc::json::to_string(&Value::object(view)));
    }
    let tree = session.editor.report().clone();
    let exported = export(&tree, &request(Format::Piv)).unwrap();
    let out = &exported.document;
    let frames = items(out.get("keyframes"));
    assert_eq!(frames.len() as f64, total_ticks(&tree));
    assert!(frames.iter().all(|frame| number(frame, "duration_raw") == Some(1.0)));
    assert!(out.path(&["_styk", "animation"]).is_none() && out.path(&["_styk", "layerSheet"]).is_none() && out.path(&["_styk", "frameSources"]).is_none());
    assert_eq!(out.get("auto_easing"), Some(&Value::Bool(false)));
    assert_eq!(number(out, "total_output_frames"), Some(total_ticks(&tree)));
    // Every frame is complete: its objects are numbered in order and the draw order names each once.
    for frame in &frames {
        let objects = items(frame.get("objects"));
        assert_eq!(number(frame, "object_count"), Some(objects.len() as f64));
        for (slot, object) in objects.iter().enumerate() {
            assert_eq!(number(object, "object_slot"), Some(slot as f64));
        }
        let mut order = frame.get("object_draw_order").and_then(Value::numbers).unwrap();
        order.sort_by(|a, b| a.partial_cmp(b).unwrap());
        assert_eq!(order, (0..objects.len()).map(|slot| slot as f64).collect::<Vec<_>>());
    }
    // The document the interface edits is not changed by exporting it.
    assert!(session.editor.report().same_node(&tree));
}

#[test]
fn what_pivot_cannot_keep_is_refused_and_a_cancelled_export_stops() {
    let (document, _, _) = tape("vfx-clips-sheet");
    for format in [Format::Piv, Format::Stk] {
        let refused = export(&document, &request(format)).unwrap_err();
        assert!(matches!(&refused, EditError::Invalid(key) if key == "errors.documentExportWorker.pivotFilesCannotPreserveVfxSaveAsStyk"), "{refused:?}");
    }
    let (plain, _, _) = tape("startup-sheet");
    let mut loader = Loader::new();
    let prepared = Arc::new(Prepared::new(Arc::new(loader.document(&plain, "").unwrap())));
    let stopped = export_document(&plain, &loader, &prepared, &request(Format::Piv), &Hold { cancel: &|| true }).unwrap_err();
    assert!(matches!(&stopped, EditError::Invalid(message) if message == CANCELLED), "{stopped:?}");
}

#[test]
fn a_figure_is_a_document_of_its_own_with_the_pose_it_shows() {
    let (document, _, _) = tape("channels-pose-sheet");
    let mut request = request(Format::Stkz);
    let exported = export(&document, &request).unwrap();
    let out = &exported.document;
    assert_eq!(items(out.get("figure_types")).len(), 1);
    assert_eq!(items(out.get("keyframes")).len(), 1);
    let objects = |document: &Value| items(document.get("keyframes").and_then(|frames| frames.item(0)).as_ref().and_then(|frame| frame.get("objects"))).len();
    assert_eq!(objects(out), 1);
    assert_eq!(out.path(&["_styk", "format"]).and_then(Value::as_str), Some("StykAnimate"));
    // A set of figures keeps its figures in the order they draw, and says so.
    request.figure.figure_uids = vec![1.0, 2.0];
    let set = export(&document, &request).unwrap().document;
    assert_eq!(set.path(&["_styk", "libraryKind"]).and_then(Value::as_str), Some("set"));
    assert_eq!(objects(&set), 2);
    // Nothing selected is a refusal, a figure that is not a movieclip is not a .stykmov.
    request.figure.figure_uids = vec![999.0];
    assert!(matches!(export(&document, &request), Err(EditError::Invalid(key)) if key == "errors.nativeFigure.selectFiguresToSaveToTheLibrary"));
    request.figure.figure_uids = Vec::new();
    request.format = Format::Stykmov;
    assert!(matches!(export(&document, &request), Err(EditError::Invalid(key)) if key == "errors.documentExportWorker.selectAMovieclipToExportAsStykmov"));
}

#[test]
fn an_instance_style_becomes_a_figure_type_shared_by_the_instances_that_look_alike() {
    let (document, _, _) = tape("startup-sheet");
    let mut figures = items(document.get("figure_types"));
    let first = figures[0].clone();
    let id = number(&first, "figure_type_id").unwrap();
    let mut table = StyleTable::new(&figures);
    let object = |style: &str| parse(&format!(r#"{{"figure_type_id":{id},"_stykStyle":{style}}}"#));
    // No overlay, or one that changes nothing, keeps the figure type.
    assert_eq!(table.id(&parse(&format!(r#"{{"figure_type_id":{id}}}"#)), &mut figures).unwrap(), id);
    assert_eq!(table.id(&object("{}"), &mut figures).unwrap(), id);
    let faded = table.id(&object(r#"{"outlineOpacity":0.5}"#), &mut figures).unwrap();
    assert_ne!(faded, id);
    assert_eq!(table.id(&object(r#"{"outlineOpacity":0.5}"#), &mut figures).unwrap(), faded, "one variant for one look");
    let thick = table.id(&object(r#"{"outlineWidth":7}"#), &mut figures).unwrap();
    assert!(thick != id && thick != faded);
    assert_eq!(figures.len(), items(document.get("figure_types")).len() + 2);
    let variant = figures.iter().find(|figure| number(figure, "figure_type_id") == Some(faded)).unwrap();
    let base = first.get("name").and_then(Value::as_str).filter(|name| !name.is_empty()).unwrap_or("Figure");
    assert_eq!(variant.get("name").and_then(Value::as_str), Some(format!("{base} \u{b7} Style 1").as_str()));
    // The overlay's value is on the variant, and the definition it came from is untouched.
    assert_eq!(variant.path(&["segment_decode", "global_style", "u30"]).and_then(Value::as_f64), Some(128.0));
    assert_eq!(first.path(&["segment_decode", "global_style", "u30"]).and_then(Value::as_f64).unwrap_or(0.0), 0.0);
}

#[test]
fn an_animated_gradient_endpoint_makes_a_figure_type_for_each_color_it_has() {
    let (document, _, _) = tape("startup-sheet");
    let mut figures = items(document.get("figure_types"));
    // The first segment of the figure ends in blue, with the opacity of 179 bytes.
    let mut first = figures[0].clone();
    let mut segments = items(first.get("segments"));
    super::set(&mut segments[0], "secondary", parse(r#"{"rgb":[0,0,255],"a":179}"#));
    super::set(&mut first, "segments", Value::array(segments));
    figures[0] = first;
    let id = number(&figures[0], "figure_type_id").unwrap();
    let segment = number(&items(figures[0].get("segments"))[0], "segment_id").unwrap();
    let mut table = StyleTable::new(&figures);
    let object = |style: &str| parse(&format!(r#"{{"figure_type_id":{id},"_stykStyle":{style}}}"#));
    let overlay = |color: u32| object(&format!(r#"{{"segments":{{"{segment}":{{"gradientColor":{color}}}}}}}"#));
    assert_eq!(table.id(&overlay(0x0000ff), &mut figures).unwrap(), id, "the color it already has changes nothing");
    let yellow = table.id(&overlay(0xffff00), &mut figures).unwrap();
    let green = table.id(&overlay(0x00ff00), &mut figures).unwrap();
    assert!(yellow != id && green != id && yellow != green);
    assert_eq!(table.id(&overlay(0xffff00), &mut figures).unwrap(), yellow, "one variant for one color");
    let variant = figures.iter().find(|figure| number(figure, "figure_type_id") == Some(yellow)).unwrap();
    let end = items(variant.get("segments"))[0].path(&["secondary", "rgb"]).and_then(Value::numbers).unwrap();
    assert_eq!(end, vec![255.0, 255.0, 0.0]);
}

fn hold() -> Hold<'static> {
    Hold { cancel: &|| false }
}

#[test]
fn a_project_is_saved_with_its_metadata_and_without_the_editors_caches() {
    let (document, _, _) = tape("startup-sheet");
    let mut cached = document.clone();
    let frame = cached.get("keyframes").unwrap().item(0).unwrap();
    let mut object = frame.get("objects").unwrap().item(0).unwrap();
    super::set(&mut object, "runtime_segments", parse("[1,2,3]"));
    let mut frame = frame.clone();
    super::set(&mut frame, "objects", Value::array(vec![object]));
    super::set(&mut cached, "keyframes", Value::array(vec![frame]));
    let saved = super::project_document(&cached, Some("Saved"), &hold()).unwrap();
    assert_eq!(saved.path(&["_styk", "format"]).and_then(Value::as_str), Some("StykAnimate"));
    assert_eq!(number(saved.get("_styk").unwrap(), "format_version"), Some(1.0));
    assert_eq!(saved.path(&["_styk", "name"]).and_then(Value::as_str), Some("Saved"));
    let objects = items(saved.get("keyframes").unwrap().item(0).unwrap().get("objects"));
    assert!(objects.iter().all(|object| object.get("runtime_segments").is_none()), "the cache of the editor is not saved");
    // The document the session holds is not changed by saving it; without a name it keeps its own.
    assert!(cached.get("keyframes").unwrap().item(0).unwrap().get("objects").unwrap().item(0).unwrap().get("runtime_segments").is_some());
    let unnamed = super::project_document(&document, None, &hold()).unwrap();
    assert_eq!(unnamed.path(&["_styk", "name"]), document.path(&["_styk", "name"]));
    let stopped = super::project_document(&document, Some("Saved"), &Hold { cancel: &|| true }).unwrap_err();
    assert!(matches!(&stopped, EditError::Invalid(message) if message == CANCELLED), "{stopped:?}");
}

#[test]
fn the_pose_channels_of_a_project_store_the_lists_they_share_once() {
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("../styk-eval/tests/fixtures/channels/channels-pose.json");
    let tree = crate::load::prepare_for_editor(parse(&std::fs::read_to_string(file).unwrap()), false).unwrap().report;
    let saved = super::project_document(&tree, Some("Saved"), &hold()).unwrap();
    let keys: Vec<String> = saved.get("_styk").and_then(Value::as_obj).map(|styk| styk.iter().map(|(key, _)| key.to_string()).collect()).unwrap_or_default();
    let animation = saved.path(&["_styk", "animation"]).unwrap_or_else(|| panic!("the authored channels are saved: {keys:?}"));
    let pose_channels = items(animation.get("channels")).iter().filter(|channel| channel.get("property").and_then(Value::as_str) == Some("pose")).count();
    assert!(pose_channels > 0);
    assert_eq!(number(animation, "version"), Some(2.0));
    let sequences = items(animation.get("poseSequences")).len();
    assert!(sequences >= 1 && sequences <= pose_channels);
    assert!(items(animation.get("channels")).iter().filter(|channel| channel.get("property").and_then(Value::as_str) == Some("pose")).all(|channel| channel.path(&["keys", "sequence"]).is_some()), "every pose channel names its list");
    assert!(tree.path(&["_styk", "animation", "channels"]).is_some_and(|channels| items(Some(channels))[0].get("keys").is_some_and(|keys| keys.elements().is_some())), "the document the session holds keeps its lists");
}

#[test]
fn a_movieclip_being_edited_is_folded_into_the_project_it_was_entered_from() {
    let (parent, _, _) = tape("startup-sheet");
    let figures = items(parent.get("figure_types"));
    let type_id = number(&figures[0], "figure_type_id").unwrap();
    // The clip is entered from a figure that holds a movieclip of the same document, as after "Edit movieclip".
    let mut asset = parse(r#"{"version":1,"duration":1,"sourceStart":0,"pivot":{"x":0,"y":0}}"#);
    super::set(&mut asset, "document", parent.clone());
    let mut styk = figures[0].get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
    styk.set("movieclip", asset);
    let mut holder = figures[0].clone();
    super::set(&mut holder, "_styk", Value::object(styk));
    let mut project = parent.clone();
    let mut list = figures.clone();
    list[0] = holder;
    super::set(&mut project, "figure_types", Value::array(list));
    // The clip's document has since been edited and is longer.
    let mut clip = parent.clone();
    super::set(&mut clip, "canvas_width", Value::Num(1234.0));
    let folded = super::fold_movieclip(&project, type_id, &clip).unwrap();
    let definition = items(folded.get("figure_types")).into_iter().find(|figure| number(figure, "figure_type_id") == Some(type_id)).unwrap();
    let movieclip = definition.path(&["_styk", "movieclip"]).unwrap();
    assert!(movieclip.get("document").unwrap().same_node(&clip), "the definition holds the document as it stands");
    assert_eq!(number(movieclip, "duration"), Some(total_ticks(&clip).max(1.0)));
    assert_eq!(number(movieclip, "sourceStart"), Some(0.0), "the rest of the asset is kept");
    assert_eq!(items(folded.get("figure_types")).len(), figures.len());
    assert!(project.path(&["figure_types"]).and_then(|figures| figures.item(0)).unwrap().path(&["_styk", "movieclip", "document"]).unwrap().same_node(&parent), "the parent is not changed");
}
