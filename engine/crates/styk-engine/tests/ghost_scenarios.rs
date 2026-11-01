//! A stage kept across a recorded scenario draws what a stage that never saw the scenario draws, onion skins included: every
//! step of the editing scenarios (`engine/tests/edit`) is shown and drawn by one long-lived `EditScene`, and by a fresh one.
//! `STYK_SCENARIOS=name,name` picks scenarios (default: the one that once drew a stale ghost); `STYK_SCENARIOS=all` runs them all.

use std::path::Path;
use std::sync::{Arc, OnceLock};
use std::time::Instant;

use styk_doc::{json, Value};
use styk_engine::document::{OpenOptions, OpenSource};
use styk_engine::edit::{EditOptions, EditScene, Onion};
use styk_engine::{Budgets, Engine, Generation};

fn clock() -> f64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}

const REQUESTS: [&str; 2] = [
    r##"{"onionMode":"frames","onionBefore":2,"onionAfter":2,"onionStep":1,"onionRangeBefore":10,"onionRangeAfter":10,"onionScope":"all","onionJoined":true,"onionOpacity":0.4,"onionFade":true,"onionTint":true,"onionBeforeColor":"#e76b70","onionAfterColor":"#549de7","onionShowOnTop":false,"hidden":[]}"##,
    r##"{"onionMode":"poses","onionBefore":2,"onionAfter":2,"onionStep":1,"onionRangeBefore":10,"onionRangeAfter":10,"onionScope":"all","onionJoined":true,"onionOpacity":0.4,"onionFade":false,"onionTint":false,"onionShowOnTop":true,"hidden":[]}"##,
];

type Ghosts = Vec<(u32, Value, f64, Option<[u8; 3]>, bool, Vec<u32>)>;

fn draw(scene: &mut EditScene, generation: &Generation, ghosts: &Ghosts) -> Arc<styk_eval::drawlist::DrawList> {
    for (id, record, ..) in ghosts {
        if !scene.has_ghost(*id, record) {
            scene.update_ghost(generation, *id, record).unwrap();
        }
    }
    let onions: Vec<Onion<'_>> = ghosts.iter().map(|(id, _, opacity, tint, on_top, hidden)| Onion { id: *id, opacity: *opacity, tint: *tint, show_on_top: *on_top, hidden }).collect();
    scene.draw_list(generation, &EditOptions { onions: &onions, ..Default::default() }).unwrap().unwrap()
}

/// The steps of a scenario compared, or the first step at which the kept stage drew something else.
fn run(name: &str) -> Result<usize, String> {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    let read = |file: &str| std::fs::read(folder.join(file)).ok().and_then(|bytes| json::parse(&bytes).ok());
    let Some(scenario) = read(&format!("{name}.scenario.json")) else { return Ok(0) };
    let Some(file) = scenario.get("document").and_then(Value::as_str).map(str::to_string) else { return Ok(0) };
    let Ok(document) = std::fs::read(folder.join(&file)) else { return Ok(0) };
    // The state the recording began from, else a plain one.
    let mut state = read(&format!("{name}.reference.json")).and_then(|reference| reference.get("steps")?.item(0)?.get("state")?.as_obj().cloned()).unwrap_or_else(|| {
        json::parse(br#"{"tick":0,"frameIndex":0,"selectedUid":null,"selectedUids":[],"selectedJoint":-1}"#).unwrap().as_obj().cloned().unwrap()
    });
    if let Some(editor) = scenario.get("editor").and_then(Value::as_obj) {
        for (key, value) in editor.iter() {
            state.set(key, value.clone());
        }
    }
    let engine = Engine::new(clock, Budgets::for_device(None));
    let Ok(opened) = engine.open_document(OpenSource::Json { bytes: &document, name }, OpenOptions { layer_timeline: false }, &|| false) else { return Ok(0) };
    engine.activate(&opened.typed, &opened.tree, 1).unwrap();
    let Ok(mut session) = opened.start_session(&json::to_string(&Value::object(state.clone()))) else { return Ok(0) };
    let base = engine.generation().unwrap();
    let mut view = json::to_string(&Value::object(state));
    let mut kept: Vec<EditScene> = REQUESTS.iter().map(|_| EditScene::default()).collect();
    let (mut id, mut last_prepared): (u64, Option<Arc<styk_eval::eval::Prepared>>) = (base.id, None);
    let mut assets = base.assets.clone();
    let mut compared = 0;
    for (at, step) in scenario.get("steps").and_then(Value::elements).unwrap().iter().enumerate() {
        let call: Vec<Value> = step.elements().unwrap().iter().collect();
        let method = call[0].as_str().unwrap();
        let method = match method {
            "@frame" => None,
            "@select" => Some("select"),
            "@seek" => Some("seek"),
            other => Some(other),
        };
        if let Some(method) = method {
            let args = json::to_string(&Value::array(call[1..].to_vec()));
            let answer = json::parse(session.call(method, &args, &view).as_bytes()).unwrap();
            if let Some(state) = answer.get("state").filter(|state| state.is_object()) {
                view = json::to_string(state);
            }
        }
        let Ok(shown) = session.show(&view, false) else { continue };
        if !last_prepared.as_ref().is_some_and(|prepared| Arc::ptr_eq(prepared, &shown.prepared)) {
            id += 1;
            last_prepared = Some(shown.prepared.clone());
            // As the engine publishes them: a later revision's assets extend the earlier ones.
            assets = Arc::new(assets.extended(&shown.prepared.doc));
        }
        let generation = Generation { id, lineage: base.lineage, revision: base.revision, prepared: shown.prepared.clone(), assets: assets.clone(), open_ms: 0.0, anchors: base.anchors.clone() };
        for (which, request) in REQUESTS.iter().enumerate() {
            let Ok(set) = session.onions(&view, request) else { continue };
            // A pose is kept by the tick it samples, as the stage does.
            let ghosts: Ghosts = set.ghosts.iter().map(|g| (g.tick as u32, g.record.clone(), g.opacity, g.tint, g.show_on_top, g.hidden.clone())).collect();
            assert!(kept[which].update_shown(&generation, &shown));
            let mine = draw(&mut kept[which], &generation, &ghosts);
            let mut fresh = EditScene::default();
            assert!(fresh.update_shown(&generation, &shown));
            let whole = draw(&mut fresh, &generation, &ghosts);
            // (A NaN in a primitive is not equal to itself: the printed primitives are compared.)
            let first = mine.prims.iter().zip(&whole.prims).position(|(a, b)| a != b && format!("{a:?}") != format!("{b:?}"));
            if first.is_some() || mine.prims.len() != whole.prims.len() {
                let detail = first.map(|at| format!("{:?} / {:?}", mine.prims[at], whole.prims[at])).unwrap_or_default();
                return Err(format!("{name}: step {} ({}) request {which}: kept stage differs from a fresh one at primitive {first:?} of {}/{} ({} ghosts at {:?}): {detail}", at + 1, call[0].as_str().unwrap(), mine.prims.len(), whole.prims.len(), ghosts.len(), set.ghosts.iter().map(|g| g.tick).collect::<Vec<_>>()));
            }
            if !ghosts.is_empty() {
                compared += 1;
            }
        }
    }
    Ok(compared)
}

#[test]
fn a_kept_stage_draws_what_a_fresh_one_draws_through_the_scenarios() {
    let picked = std::env::var("STYK_SCENARIOS").unwrap_or_else(|_| "origin-angle-lock-layout-native".into());
    let names: Vec<String> = if picked == "all" {
        let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
        let mut names: Vec<String> = std::fs::read_dir(folder).unwrap().filter_map(|e| e.unwrap().file_name().to_str().and_then(|n| n.strip_suffix(".scenario.json").map(str::to_string))).collect();
        names.sort();
        names
    } else {
        picked.split(',').map(str::to_string).collect()
    };
    let (mut compared, mut failures) = (0, Vec::new());
    for name in &names {
        match run(name) {
            Ok(done) => compared += done,
            Err(failure) => failures.push(failure),
        }
    }
    assert!(failures.is_empty(), "{} of {} scenarios drew a stale stage:
{}", failures.len(), names.len(), failures.join("
"));
    assert!(compared > 0, "some step drew onion skins");
}
