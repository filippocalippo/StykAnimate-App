//! What a joint drag, a figure move and a single seek cost natively on the interface thread, phase by phase, with and without onion
//! skins: the session's call, its frame (`Session::show`), the interface's geometry read since the last one (`query_packet`), the
//! frame's JSON (`query frame`, for a seek), the onion skins and the draw list. A measurement, not a check: it needs a document,
//! `STYK_BENCH_DOC=<file> cargo test --release -p styk-engine --test dense_bench -- --ignored --nocapture` (`STYK_BENCH_TICK=<tick>`).

use std::sync::{Arc, OnceLock};
use std::time::Instant;

use styk_engine::document::{OpenOptions, OpenSource};
use styk_engine::edit::{EditOptions, EditScene, Onion};
use styk_engine::{Budgets, Engine, Generation};

fn clock() -> f64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}

const ONIONS: &str = r##"{"onionMode":"frames","onionBefore":3,"onionAfter":3,"onionStep":1,"onionRangeBefore":10,"onionRangeAfter":10,"onionScope":"all","onionJoined":true,"onionOpacity":0.3,"onionFade":true,"onionTint":true,"onionBeforeColor":"#e76b70","onionAfterColor":"#549de7","onionShowOnTop":false,"hidden":[]}"##;

#[derive(Default, Clone, Copy)]
struct Step {
    call: f64,
    read: f64,
    show: f64,
    geometry: f64,
    groups: f64,
    onions: f64,
    draw: f64,
}

fn median(mut values: Vec<f64>) -> f64 {
    values.sort_by(f64::total_cmp);
    values.get(values.len() / 2).copied().unwrap_or(0.0)
}

fn report(label: &str, steps: &[Step]) {
    let col = |f: fn(&Step) -> f64| median(steps.iter().map(f).collect());
    let total = col(|s| s.call + s.read + s.show + s.geometry + s.onions + s.draw);
    println!("{label}: median of {}: call {:.2}  frame read {:.2}  show {:.2}  geometry {:.2} ({} groups)  onions {:.2}  draw list {:.2}  total {:.2} ms",
        steps.len(), col(|s| s.call), col(|s| s.read), col(|s| s.show), col(|s| s.geometry), col(|s| s.groups), col(|s| s.onions), col(|s| s.draw), total);
    for (name, count, total) in styk_edit::prof::take().into_iter().take(10) {
        println!("      prof {name}: {:.2} ms a call ({count} calls)", total / count.max(1) as f64);
    }
}

/// One frame as the interface draws it: the session's frame, the geometry read since the last, the onion skins and the draw list.
struct Drawer {
    scene: EditScene,
    since: Option<f64>,
    onions: bool,
}

impl Drawer {
    fn frame(&mut self, session: &mut styk_edit::session::Session, generation_of: &dyn Fn(&Arc<styk_eval::eval::Prepared>) -> Generation, view: &str, step: &mut Step, translations: &[(u32, [f64; 2])]) -> usize {
        let t = Instant::now();
        let shown = session.show(view, false).unwrap();
        step.show = ms(t);
        let t = Instant::now();
        let args = match self.since { Some(token) => format!("{{\"since\":{token}}}"), None => "{}".into() };
        let packet = session.query_packet("geometry", &args, view).unwrap();
        step.geometry = ms(t);
        if !packet.is_empty() {
            self.since = Some(packet[0]);
            step.groups = packet[3];
        }
        let generation = generation_of(&shown.prepared);
        assert!(self.scene.update_shown(&generation, &shown));
        let t = Instant::now();
        let mut ghosts = Vec::new();
        if self.onions {
            let set = session.onions(view, ONIONS).unwrap();
            for (at, ghost) in set.ghosts.iter().enumerate() {
                if !self.scene.has_ghost(at as u32, &ghost.record) {
                    self.scene.update_ghost(&generation, at as u32, &ghost.record).unwrap();
                }
                ghosts.push((at as u32, ghost.opacity, ghost.tint));
            }
        }
        step.onions = ms(t);
        let list: Vec<Onion<'_>> = ghosts.iter().map(|&(id, opacity, tint)| Onion { id, opacity, tint, show_on_top: false, hidden: &[] }).collect();
        let t = Instant::now();
        let drawn = self.scene.draw_list(&generation, &EditOptions { onions: &list, translations, ..Default::default() }).unwrap().unwrap();
        step.draw = ms(t);
        drawn.prims.len()
    }
}

#[test]
#[ignore]
fn a_drag_and_a_seek() {
    let (Some(path), tick) = (std::env::var_os("STYK_BENCH_DOC"), std::env::var("STYK_BENCH_TICK").ok().and_then(|t| t.parse::<u32>().ok()).unwrap_or(0)) else { return };
    let path = std::path::PathBuf::from(path);
    let bytes = std::fs::read(&path).unwrap();
    let name = path.file_name().unwrap().to_str().unwrap().to_string();
    let engine = Engine::new(clock, Budgets::for_device(None));
    let opened = engine.open_document(OpenSource::File { bytes: &bytes, name: &name }, OpenOptions { layer_timeline: true }, &|| false).expect("opens");
    engine.activate(&opened.typed, &opened.tree, 1).unwrap();
    let state = format!("{{\"tick\":{tick},\"frameIndex\":0,\"selectedUid\":null,\"selectedUids\":[],\"selectedJoint\":-1,\"layerTimeline\":true,\"propertyChannels\":true}}");
    let mut session = opened.start_session(&state).expect("a session");
    let base = engine.generation().unwrap();
    let generation_of = |prepared: &Arc<styk_eval::eval::Prepared>| Generation { id: base.id + 1, lineage: base.lineage, revision: base.revision, prepared: prepared.clone(), assets: base.assets.clone(), open_ms: 0.0, anchors: base.anchors.clone() };
    for onions in [false, true] {
        let mut drawer = Drawer { scene: EditScene::default(), since: None, onions };
        let view = format!("{{\"tick\":{tick},\"frameIndex\":0}}");
        let prims = drawer.frame(&mut session, &generation_of, &view, &mut Step::default(), &[]);
        let shown = session.show(&view, false).unwrap();
        let slot = (0..shown.frame.objects.len()).filter(|&s| !shown.frame.objects[s].angles.is_empty() && shown.frame.objects[s].join.is_none()).max_by_key(|&s| shown.frame.objects[s].angles.len()).unwrap();
        let uid = shown.frame.objects[slot].uid;
        let end = shown.scene.objects[slot].ends[0];
        let selected = format!("{{\"tick\":{tick},\"frameIndex\":0,\"selectedUid\":{uid},\"selectedUids\":[{uid}],\"selectedJoint\":0}}");
        session.call("select", &format!("[{uid},0]"), &selected);
        println!("{}: {} objects, {prims} primitives", if onions { "with onion skins" } else { "without onion skins" }, shown.frame.objects.len());
        for (gesture, label) in [("Pose joint", "joint drag move"), ("Move connected figures", "figure move")] {
            let pose = gesture == "Pose joint";
            session.call(if pose { "beginDrag" } else { "beginTranslationDrag" }, &format!("[\"{gesture}\"]"), &selected);
            let mut delta = [0.0, 0.0];
            let mut steps = Vec::new();
            for n in 0..30 {
                let mut step = Step::default();
                let t = Instant::now();
                if pose {
                    let answer = session.call("poseJoint", &format!("[{},{}]", end[0] + 30.0 + n as f64, end[1] + 3.0), &selected);
                    assert!(answer.contains("\"status\":\"ok\""), "{}", &answer[..answer.len().min(200)]);
                }
                step.call = ms(t);
                delta = [2.0 * n as f64 + 1.0, 1.0];
                let moved = [(slot as u32, delta)];
                drawer.frame(&mut session, &generation_of, &selected, &mut step, if pose { &[] } else { &moved });
                steps.push(step);
            }
            report(&format!("  {label}"), &steps[1..]);
            let mut step = Step::default();
            let t = Instant::now();
            if !pose {
                session.call("moveSelection", &format!("[{},{},{{\"fromStart\":true}}]", delta[0], delta[1]), &selected);
            }
            // As the app asks: the changes only, patched over what it holds.
            let answer = session.call("commitDrag", "[]", &selected.replacen('{', "{\"patch\":true,\"changesOnly\":true,", 1));
            step.call = ms(t);
            if let Ok(value) = styk_doc::json::parse(answer.as_bytes()) && let Some(parts) = value.as_obj() {
                let mut sizes: Vec<(String, usize)> = parts.iter().map(|(key, part)| (key.to_string(), styk_doc::json::to_string(part).len() / 1024)).filter(|(_, kb)| *kb > 0).collect();
                sizes.sort_by_key(|(_, kb)| std::cmp::Reverse(*kb));
                println!("  {label} release answer, KB by part: {sizes:?}");
            }
            drawer.frame(&mut session, &generation_of, &selected, &mut step, &[]);
            report(&format!("  {label} release ({} KB answered)", answer.len() / 1024), &[step]);
            let mut step = Step::default();
            let t = Instant::now();
            session.call("undo", "[]", &selected);
            step.call = ms(t);
            drawer.frame(&mut session, &generation_of, &selected, &mut step, &[]);
            report("  undo", &[step]);
        }
        let mut seeks = Vec::new();
        for n in 1..=8 {
            let view = format!("{{\"tick\":{},\"frameIndex\":0}}", tick + n);
            let mut step = Step::default();
            let t = Instant::now();
            let text = session.query("frame", "{}", &view).unwrap();
            step.read = ms(t);
            if n == 1 {
                println!("  seek frame read: {} KB", text.len() / 1024);
            }
            drawer.frame(&mut session, &generation_of, &view, &mut step, &[]);
            seeks.push(step);
        }
        report("  seek", &seeks);
    }
}
