//! An edit converts only the records it replaced into typed views.

use std::sync::Arc;

use styk_doc::{Value, json};
use styk_eval::load::{Converted, Loader};

fn project() -> Value {
    let figure = |id: u32| format!(r#"{{"figure_type_id":{id},"name":"f{id}","segments":[{{"segment_id":1,"parent_id":0,"length":40,"angle_rad":0,"thickness":8,"primitive_code":0,"color_rgb":[0,0,0]}}]}}"#);
    let key = |x: f64| format!(r#"{{"duration_raw":4,"objects":[{{"unique_id":7,"figure_type_id":1,"root_x":{x},"root_y":10,"scale":1,"angles":[0.25]}},{{"unique_id":8,"figure_type_id":2,"root_x":5,"root_y":5,"scale":1,"angles":[0]}}]}}"#);
    let text = format!(r#"{{"version":5,"canvas_width":320,"canvas_height":200,"fps":20,"figure_types":[{},{}],"keyframes":[{},{},{}],"backgrounds":[]}}"#, figure(1), figure(2), key(1.0), key(2.0), key(3.0));
    json::parse(text.as_bytes()).unwrap()
}

/// `document.keyframes[frame].objects[object].root_x = x`, copying only that path.
fn move_object(document: &mut Value, frame: usize, object: usize, x: f64) {
    let frames = document.make_obj().unwrap().get_mut("keyframes").unwrap().make_arr().unwrap();
    let objects = frames[frame].make_obj().unwrap().get_mut("objects").unwrap().make_arr().unwrap();
    objects[object].make_obj().unwrap().set("root_x", Value::Num(x));
}

#[test]
fn a_pose_edit_converts_one_keyframe_and_no_figure() {
    let mut loader = Loader::new();
    let original = project();
    let first = loader.document(&original, "p").unwrap();
    assert_eq!(loader.converted, Converted { figures: 2, keyframes: 3 });

    let mut edited = original.clone();
    move_object(&mut edited, 1, 0, 99.0);
    let second = loader.document(&edited, "p").unwrap();
    assert_eq!(loader.converted, Converted { figures: 0, keyframes: 1 });
    assert_eq!(second.keyframes[1].objects[0].root[0], 99.0);
    // Untouched records are the very same views.
    assert!(Arc::ptr_eq(&first.keyframes[0], &second.keyframes[0]));
    assert!(Arc::ptr_eq(&first.keyframes[2], &second.keyframes[2]));
    assert!(Arc::ptr_eq(&first.figures[0], &second.figures[0]));
    assert!(!Arc::ptr_eq(&first.keyframes[1], &second.keyframes[1]));
    // The revision before the edit is intact.
    assert_eq!(first.keyframes[1].objects[0].root[0], 2.0);

    // Converting the same tree again converts nothing.
    loader.document(&edited, "p").unwrap();
    assert_eq!(loader.converted, Converted::default());
}

#[test]
fn views_of_dropped_revisions_are_released() {
    let mut loader = Loader::new();
    let original = project();
    loader.document(&original, "p").unwrap();
    let mut edited = original.clone();
    move_object(&mut edited, 0, 1, 42.0);
    loader.document(&edited, "p").unwrap();
    drop(original);
    loader.release_unused();
    // The replaced keyframe of the dropped revision is gone; the live revision converts nothing new.
    loader.document(&edited, "p").unwrap();
    assert_eq!(loader.converted, Converted::default());
    drop(edited);
    loader.release_unused();
    let fresh = project();
    loader.document(&fresh, "p").unwrap();
    assert_eq!(loader.converted, Converted { figures: 2, keyframes: 3 });
}

/// `project()` with a background picture whose payload is `data_url` (a string made anew each time it is asked for).
fn project_with_picture(data_url: &str) -> Value {
    let mut document = project();
    let text = format!(r#"[{{"background_id":1,"kind":0,"data_url":"{data_url}"}}]"#);
    document.make_obj().unwrap().set("backgrounds", json::parse(text.as_bytes()).unwrap());
    document
}

const PICTURE: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";

#[test]
fn a_picture_whose_payload_is_made_anew_is_the_picture_the_loader_has() {
    let mut loader = Loader::new();
    for _ in 0..3 {
        // Each pass is a document whose picture is a payload of its own (an undo that rebuilds the record).
        let document = project_with_picture(PICTURE);
        let converted = loader.document(&document, "p").unwrap();
        assert_eq!(converted.images.len(), 1, "the picture is in the table once");
        assert_eq!(loader.images.len(), 1);
        drop(document);
        loader.release_unused();
    }
    let other = project_with_picture(&PICTURE.replace("AAAAC0lEQVR4", "AAAAC0lEQVR5"));
    loader.document(&other, "p").unwrap();
    assert_eq!(loader.images.len(), 2, "another picture is another entry");
}

#[test]
fn views_of_a_dropped_revision_are_released_whoever_else_caches_them() {
    // The editor's session and the engine each convert the document with a loader of their own.
    let mut session = Loader::new();
    let original = project();
    session.document(&original, "p").unwrap();
    let mut engine = session.clone();
    let mut edited = original.clone();
    move_object(&mut edited, 0, 1, 42.0);
    session.document(&edited, "p").unwrap();
    engine.document(&edited, "p").unwrap();
    drop(original);
    session.release_unused();
    engine.release_unused();
    let (session, engine) = (session.cached_records(), engine.cached_records());
    assert_eq!(session, engine);
    assert_eq!(session[0], 2, "the two figures of the live revision");
    assert_eq!(session[1], 3, "its three keyframes: the replaced one went with the dropped revision");
}

#[test]
fn a_loader_takes_the_views_another_loader_made_of_the_keyframes() {
    let report = project();
    let mut maker = Loader::new();
    let made = maker.document(&report, "p").unwrap();
    let mut taker = Loader::new();
    taker.adopt_views(&report, &made);
    let again = taker.document(&report, "p").unwrap();
    // Only the figures are made anew; the keyframes are the views the other loader made.
    assert_eq!(taker.converted, Converted { figures: 2, keyframes: 0 });
    assert!(Arc::ptr_eq(&made.keyframes[1], &again.keyframes[1]));
    // An edit converts the one keyframe it replaced.
    let mut edited = report.clone();
    move_object(&mut edited, 2, 0, 7.0);
    taker.document(&edited, "p").unwrap();
    assert_eq!(taker.converted, Converted { figures: 0, keyframes: 1 });
}

/// `project()` with a style overlay on the figure of object 7 in every key.
fn styled_project() -> Value {
    let text = json::to_string(&project()).replace(r#""unique_id":7,"#, r#""unique_id":7,"_stykStyle":{"segments":{"1":{"thickness":29}}},"#);
    json::parse(text.as_bytes()).unwrap()
}

/// Every object with a style holds the figure resolved against the document's own definition of its figure.
fn resolved_against_the_document(document: &styk_eval::doc::Document) -> usize {
    let mut styled = 0;
    for frame in &document.keyframes {
        for object in frame.objects.iter().filter(|object| object.style.is_some()) {
            let base = document.figure(object.figure).expect("the figure exists");
            let resolved = object.figure_override.as_ref().expect("a styled object is resolved");
            assert!(resolved.base.as_ref().is_some_and(|b| Arc::ptr_eq(b, base)), "a style is resolved against the figure the document has");
            styled += 1;
        }
    }
    styled
}

/// Each object of each frame as the scene reads it (a frame's own tables print in no fixed order, so they are left out).
fn what_is_drawn(document: &styk_eval::doc::Document) -> Vec<String> {
    document.keyframes.iter().flat_map(|frame| frame.objects.iter().map(|object| format!("{} {:?} {:?} {:?}", object.uid, object.root, object.angles, object.figure_override))).collect()
}

#[test]
fn styles_are_resolved_again_only_for_the_frames_that_need_it_and_still_resolve_against_the_figures_the_document_has() {
    let mut loader = Loader::new();
    let original = styled_project();
    let first = loader.document(&original, "p").unwrap();
    assert_eq!(resolved_against_the_document(&first), 3);

    // A pose edit: the other frames are the views they were, resolved.
    let mut edited = original.clone();
    move_object(&mut edited, 1, 0, 99.0);
    let second = loader.document(&edited, "p").unwrap();
    assert_eq!(resolved_against_the_document(&second), 3);
    assert!(Arc::ptr_eq(&first.keyframes[0], &second.keyframes[0]));
    assert!(Arc::ptr_eq(&first.keyframes[2], &second.keyframes[2]));

    // The same tree again, and again: nothing changes.
    let third = loader.document(&edited, "p").unwrap();
    assert!(Arc::ptr_eq(&second.keyframes[0], &third.keyframes[0]));
    assert_eq!(resolved_against_the_document(&third), 3);

    // A figure defined another way: every frame is resolved against it, whatever it had been resolved against.
    let mut redefined = edited.clone();
    let figures = redefined.make_obj().unwrap().get_mut("figure_types").unwrap().make_arr().unwrap();
    figures[0].make_obj().unwrap().get_mut("segments").unwrap().make_arr().unwrap()[0].make_obj().unwrap().set("length", Value::Num(55.0));
    let fourth = loader.document(&redefined, "p").unwrap();
    assert_eq!(resolved_against_the_document(&fourth), 3);
    assert!(!Arc::ptr_eq(&third.keyframes[0], &fourth.keyframes[0]), "a frame resolved against the old figure is resolved again");
    // The loader gives what a loader that never saw the other documents gives.
    let fresh = Loader::new().document(&redefined, "p").unwrap();
    assert_eq!(what_is_drawn(&fourth), what_is_drawn(&fresh));
    // And back to the earlier definition.
    let fifth = loader.document(&edited, "p").unwrap();
    assert_eq!(resolved_against_the_document(&fifth), 3);
    assert_eq!(what_is_drawn(&fifth), what_is_drawn(&Loader::new().document(&edited, "p").unwrap()));
}

#[test]
fn a_frame_kept_across_documents_is_resolved_against_the_figures_the_new_document_has() {
    let mut loader = Loader::new();
    let original = styled_project();
    let record = original.get("keyframes").and_then(|frames| frames.item(0)).expect("a keyframe record");
    let first = loader.document(&original, "p").unwrap();
    let mut frame = Arc::new(loader.edit_frame(&record, None, &first).unwrap());
    assert!(!loader.restyle_frame(&mut frame, &first), "a frame converted against the document is resolved");

    // The figure is defined another way: the frame is resolved against it, and is the frame its record converts to.
    let mut redefined = original.clone();
    let figures = redefined.make_obj().unwrap().get_mut("figure_types").unwrap().make_arr().unwrap();
    figures[0].make_obj().unwrap().get_mut("segments").unwrap().make_arr().unwrap()[0].make_obj().unwrap().set("length", Value::Num(55.0));
    let second = loader.document(&redefined, "p").unwrap();
    let before = frame.clone();
    assert!(loader.restyle_frame(&mut frame, &second), "the figure it was resolved against is not the document's");
    assert!(Arc::ptr_eq(&before, &frame) == false && before.objects.iter().any(|o| o.style.is_some()), "the held frame is not changed under whoever holds it");
    let styled: Vec<_> = frame.objects.iter().filter(|object| object.style.is_some()).collect();
    assert_eq!(styled.len(), 1);
    for object in styled {
        let resolved = object.figure_override.as_ref().expect("resolved");
        assert!(resolved.base.as_ref().is_some_and(|b| Arc::ptr_eq(b, second.figure(object.figure).unwrap())), "resolved against the figure the document has");
    }
    let fresh = Loader::new().edit_frame(&record, None, &Loader::new().document(&redefined, "p").unwrap()).unwrap();
    let drawn = |frame: &styk_eval::eval::Frame| frame.objects.iter().map(|object| format!("{} {:?} {:?}", object.uid, object.angles, object.figure_override)).collect::<Vec<_>>();
    assert_eq!(drawn(&frame), drawn(&fresh));
    assert!(!loader.restyle_frame(&mut frame, &second), "and once is enough");
    // Back to the first definition.
    assert!(loader.restyle_frame(&mut frame, &first));
    assert_eq!(drawn(&frame), drawn(&Loader::new().edit_frame(&record, None, &Loader::new().document(&original, "p").unwrap()).unwrap()));
}
