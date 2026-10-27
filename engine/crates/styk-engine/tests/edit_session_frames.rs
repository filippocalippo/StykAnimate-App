//! The frame the stage draws from the open document's session (`EditScene::update_record`): the same picture
//! as the prepared frame of that tick, effect clips and the scene camera included, and the figures a frame
//! shares with the one before it are not read again.

use std::path::Path;
use std::sync::OnceLock;
use std::time::Instant;

use styk_doc::Value;
use styk_edit::session::Session;
use styk_engine::edit::{EditOptions, EditScene};
use styk_engine::{Budgets, Engine};

fn clock() -> f64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}

fn parse(text: &[u8]) -> Value {
    styk_doc::json::parse(text).unwrap()
}

/// A fixture opened on the engine, and the session that edits the same document (on a layer sheet, as the app does).
fn open(name: &str) -> (Engine, Session) {
    let bytes = std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../styk-eval/tests/fixtures").join(name)).unwrap();
    let engine = Engine::new(clock, Budgets::for_device(None));
    engine.open(&bytes, "json", name).expect("opens");
    let state = r#"{"tick":0,"frameIndex":0,"selectedUid":null,"selectedUids":[],"selectedJoint":-1,"layerTimeline":true,"propertyChannels":true}"#;
    let session = Session::start(parse(&bytes), state).expect("a session");
    (engine, session)
}

fn view(session: &mut Session, tick: u32) -> String {
    let rows = parse(session.query("timeline", "{}", "null").unwrap().as_bytes());
    let index = rows.elements().unwrap().iter().filter(|row| row.item(0).and_then(|start| start.as_f64()).is_some_and(|start| start <= tick as f64)).count().saturating_sub(1);
    format!("{{\"tick\":{tick},\"frameIndex\":{index}}}")
}

#[test]
fn the_session_frame_is_the_prepared_frame_of_its_tick() {
    for name in ["vfx/clips.json", "eval/follow-figures.json", "eval/parallax-layers.json"] {
        let (engine, mut session) = open(name);
        let generation = engine.generation().unwrap();
        let mut scene = EditScene::default();
        let ticks = generation.prepared.total_ticks;
        for tick in (0..ticks).step_by(((ticks / 6).max(1)) as usize) {
            let at = view(&mut session, tick);
            let record = session.show(&at, false).unwrap();
            scene.update_record(&generation, &record).unwrap();
            // Seen through the scene camera, as the preview and playback are.
            let drawn = scene.draw_list(&generation, &EditOptions { camera: true, prepare_camera: true, ..Default::default() }).unwrap().expect("a frame");
            let prepared = engine.frame_now(tick).expect("prepared");
            assert!(!drawn.prims.is_empty(), "{name} tick {tick}: something is drawn");
            assert_eq!(drawn.prims, prepared.list.prims, "{name} tick {tick}: the primitives");
        }
    }
}

#[test]
fn figures_a_frame_shares_with_the_last_are_not_read_again() {
    let (engine, mut session) = open("eval/follow-figures.json");
    let generation = engine.generation().unwrap();
    let mut scene = EditScene::default();
    let at = view(&mut session, 3);
    let first = session.show(&at, false).unwrap();
    scene.update_record(&generation, &first).unwrap();
    let before = scene.draw_list(&generation, &EditOptions::default()).unwrap().unwrap();
    // The same record again, and the record of another tick of the same keyframe's pose: the picture is a fresh read's.
    scene.update_record(&generation, &first).unwrap();
    assert_eq!(scene.draw_list(&generation, &EditOptions::default()).unwrap().unwrap().prims, before.prims);
    let at = view(&mut session, 9);
    let later = session.show(&at, false).unwrap();
    scene.update_record(&generation, &later).unwrap();
    let delta = scene.draw_list(&generation, &EditOptions::default()).unwrap().unwrap();
    let mut fresh = EditScene::default();
    fresh.update_record(&generation, &later).unwrap();
    assert_eq!(delta.prims, fresh.draw_list(&generation, &EditOptions::default()).unwrap().unwrap().prims, "reading a frame over the last is reading it whole");
}
