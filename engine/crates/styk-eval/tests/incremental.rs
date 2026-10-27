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
