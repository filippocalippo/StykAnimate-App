//! The frame the stage draws from the open document's session (`EditScene::update_shown`): the same picture
//! as the prepared frame of that tick, effect clips and the scene camera included, and a frame built over the
//! one before it (the objects it shares with it are not built again) is the frame built whole.

use std::path::Path;
use std::sync::OnceLock;
use std::time::Instant;

use styk_doc::Value;
use styk_edit::session::Session;
use styk_engine::document::{OpenOptions, OpenSource, OpenedDocument};
use styk_engine::edit::{EditOptions, EditScene};
use styk_engine::{Budgets, Engine};

fn clock() -> f64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}

fn parse(text: &[u8]) -> Value {
    styk_doc::json::parse(text).unwrap()
}

const STATE: &str = r#"{"tick":0,"frameIndex":0,"selectedUid":null,"selectedUids":[],"selectedJoint":-1,"layerTimeline":true,"propertyChannels":true}"#;

/// A fixture opened on the engine, and the session that edits the same document (on a layer sheet, as the app does): they share the
/// document's views, so the frame the session shows is drawn against the engine's document.
fn open(name: &str) -> (Engine, OpenedDocument, Session) {
    let bytes = std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../styk-eval/tests/fixtures").join(name)).unwrap();
    let engine = Engine::new(clock, Budgets::for_device(None));
    let opened = engine.open_document(OpenSource::Json { bytes: &bytes, name }, OpenOptions { layer_timeline: true }, &|| false).expect("opens");
    engine.activate(&opened.typed, &opened.tree, 1).unwrap();
    let session = opened.start_session(STATE).expect("a session");
    (engine, opened, session)
}

fn view(session: &mut Session, tick: u32) -> String {
    let rows = parse(session.query("timeline", "{}", "null").unwrap().as_bytes());
    let index = rows.elements().unwrap().iter().filter(|row| row.item(0).and_then(|start| start.as_f64()).is_some_and(|start| start <= tick as f64)).count().saturating_sub(1);
    format!("{{\"tick\":{tick},\"frameIndex\":{index}}}")
}

#[test]
fn the_session_frame_is_the_prepared_frame_of_its_tick() {
    for name in ["vfx/clips.json", "eval/follow-figures.json", "eval/parallax-layers.json"] {
        let (engine, _opened, mut session) = open(name);
        let generation = engine.generation().unwrap();
        let mut scene = EditScene::default();
        let ticks = generation.prepared.total_ticks;
        for tick in (0..ticks).step_by(((ticks / 6).max(1)) as usize) {
            let at = view(&mut session, tick);
            let shown = session.show(&at, false).unwrap();
            assert!(scene.update_shown(&generation, &shown), "{name} tick {tick}: the session shows the engine's document");
            // Seen through the scene camera, as the preview and playback are.
            let drawn = scene.draw_list(&generation, &EditOptions { camera: true, prepare_camera: true, ..Default::default() }).unwrap().expect("a frame");
            let prepared = engine.frame_now(tick).expect("prepared");
            assert!(!drawn.prims.is_empty(), "{name} tick {tick}: something is drawn");
            assert_eq!(drawn.prims, prepared.list.prims, "{name} tick {tick}: the primitives");
        }
    }
}

#[test]
fn a_frame_built_over_the_last_is_the_frame_built_whole() {
    let (engine, opened, mut session) = open("eval/follow-figures.json");
    let generation = engine.generation().unwrap();
    let mut scene = EditScene::default();
    let at = view(&mut session, 3);
    let first = session.show(&at, false).unwrap();
    assert!(scene.update_shown(&generation, &first));
    let before = scene.draw_list(&generation, &EditOptions::default()).unwrap().unwrap();
    // The same frame again is the same picture.
    let again = session.show(&at, false).unwrap();
    assert!(std::sync::Arc::ptr_eq(&first, &again), "a frame that did not change is the one held");
    assert!(scene.update_shown(&generation, &again));
    assert_eq!(scene.draw_list(&generation, &EditOptions::default()).unwrap().unwrap().prims, before.prims);
    // Another tick of the same pose: built over the last, it is the picture a session that never showed another builds.
    let at = view(&mut session, 9);
    let later = session.show(&at, false).unwrap();
    assert!(scene.update_shown(&generation, &later));
    let delta = scene.draw_list(&generation, &EditOptions::default()).unwrap().unwrap();
    let mut fresh_session = opened.start_session(STATE).unwrap();
    let whole = fresh_session.show(&at, false).unwrap();
    let mut fresh = EditScene::default();
    assert!(fresh.update_shown(&generation, &whole));
    assert_eq!(delta.prims, fresh.draw_list(&generation, &EditOptions::default()).unwrap().unwrap().prims, "building a frame over the last is building it whole");
}
