//! What the frame costs to show around a commit, natively, phase by phase. A measurement, not a check: it needs a document,
//! `STYK_BENCH_DOC=<file> STYK_BENCH_TICK=<tick> cargo test --release -p styk-engine --test commit_bench -- --ignored --nocapture`.

use std::sync::{Arc, OnceLock};
use std::time::Instant;

use styk_doc::Value;
use styk_engine::document::{OpenOptions, OpenSource};
use styk_engine::edit::{EditOptions, EditScene, Onion};
use styk_engine::{Budgets, Engine, Generation};

fn clock() -> f64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}

const REQUEST: &str = r##"{"onionMode":"frames","onionBefore":3,"onionAfter":3,"onionStep":1,"onionRangeBefore":10,"onionRangeAfter":10,"onionScope":"all","onionJoined":true,"onionOpacity":0.3,"onionFade":true,"onionTint":true,"onionBeforeColor":"#e76b70","onionAfterColor":"#549de7","onionShowOnTop":false,"hidden":[]}"##;

thread_local! { static LAST: std::cell::RefCell<Option<Arc<styk_edit::OnionSet>>> = const { std::cell::RefCell::new(None) }; }

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}

#[test]
#[ignore]
fn the_frame_around_a_commit() {
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
    let view = format!("{{\"tick\":{tick},\"frameIndex\":0}}");
    let mut scene = EditScene::default();
    let mut id = base.id;
    let generation_of = |prepared: &Arc<styk_eval::eval::Prepared>, id: u64| Generation { id, lineage: base.lineage, revision: base.revision, prepared: prepared.clone(), assets: base.assets.clone(), open_ms: 0.0, anchors: base.anchors.clone() };

    let show = |session: &mut styk_edit::session::Session, scene: &mut EditScene, view: &str, id: u64, label: &str, print: bool| -> Vec<u32> {
        let _ = styk_edit::prof::take();
        let t0 = Instant::now();
        let shown = session.show(view, false).unwrap();
        let t1 = Instant::now();
        if print { for (name, count, total) in styk_edit::prof::take().into_iter().take(8) { println!("      show prof {name}: {count} x, {total:.2} ms"); } }
        let set = session.onions(view, REQUEST).unwrap();
        let t2 = Instant::now();
        if print { for (name, count, total) in styk_edit::prof::take().into_iter().take(12) { println!("      onions prof {name}: {count} x, {total:.2} ms"); } }
        let generation = generation_of(&shown.prepared, id);
        assert!(scene.update_shown(&generation, &shown));
        let ghosts: Vec<(u32, Value, f64, Option<[u8; 3]>)> = set.ghosts.iter().enumerate().map(|(at, g)| (at as u32, g.record.clone(), g.opacity, g.tint)).collect();
        let stale = ghosts.iter().filter(|(gid, record, ..)| !scene.has_ghost(*gid, record)).count();
        if print { println!("  {label}: ghosts sent again {stale}, set same as last {}", LAST.with(|last| { let same = last.borrow().as_ref().is_some_and(|l: &Arc<styk_edit::OnionSet>| Arc::ptr_eq(l, &set)); *last.borrow_mut() = Some(set.clone()); same })); }
        for (gid, record, ..) in &ghosts {
            if !scene.has_ghost(*gid, record) {
                scene.update_ghost(&generation, *gid, record).unwrap();
            }
        }
        let t3 = Instant::now();
        let onions: Vec<Onion<'_>> = ghosts.iter().map(|(gid, _, opacity, tint)| Onion { id: *gid, opacity: *opacity, tint: *tint, show_on_top: false, hidden: &[] }).collect();
        let options = EditOptions { onions: &onions, ..Default::default() };
        let list = scene.draw_list(&generation, &options).unwrap().unwrap();
        let t4 = Instant::now();
        if print {
            println!("{label}: show {:.2}  onions {:.2}  ghosts-in {:.2}  draw_list {:.2}  total {:.2} ms  ({} prims, {} ghosts)", (t1 - t0).as_secs_f64() * 1000.0, (t2 - t1).as_secs_f64() * 1000.0, (t3 - t2).as_secs_f64() * 1000.0, (t4 - t3).as_secs_f64() * 1000.0, ms(t0), list.prims.len(), ghosts.len());
        }
        if print { let rec: Vec<String> = shown.record.get("objects").and_then(Value::elements).map(|e| e.iter().take(6).map(|o| o.get("unique_id").and_then(Value::as_f64).unwrap_or(-1.0).to_string()).collect()).unwrap_or_default(); println!("  record order {rec:?}"); }
        shown.frame.objects.iter().map(|o| o.uid as u32).collect()
    };

    id += 1;
    let order_before = show(&mut session, &mut scene, &view, id, "first", true);
    let shown = session.show(&view, false).unwrap();
    let slot = (0..shown.frame.objects.len()).filter(|&s| !shown.frame.objects[s].angles.is_empty() && shown.frame.objects[s].join.is_none()).max_by_key(|&s| shown.frame.objects[s].angles.len()).unwrap();
    let uid = shown.frame.objects[slot].uid;
    let end = shown.scene.objects[slot].ends[0];
    println!("object slot {slot} uid {uid}");
    let selected = format!("{{\"tick\":{tick},\"frameIndex\":0,\"selectedUid\":{uid},\"selectedUids\":[{uid}],\"selectedJoint\":0}}");
    let r = session.call("select", &format!("[{uid},0]"), &selected);
    println!("select -> {}", &r[..r.len().min(200)]);
    let began = session.call("beginDrag", "[\"Pose joint\"]", &selected);
    println!("beginDrag -> {}", &began[..began.len().min(80)]);
    let mut steps = Vec::new();
    for step in 0..40 {
        let t = Instant::now();
        let r = session.call("poseJoint", &format!("[{},{}]", end[0] + 30.0 + step as f64, end[1] + 3.0), &selected);
        let call = ms(t);
        if step == 0 { println!("poseJoint -> {}", &r[..r.len().min(200)]); }
        let t = Instant::now();
        show(&mut session, &mut scene, &selected, id, "step", false);
        steps.push((call, ms(t)));
    }
    let n = steps.len() as f64;
    println!("drag step: call {:.2} ms, show+draw {:.2} ms (mean of {n})", steps.iter().map(|s| s.0).sum::<f64>() / n, steps.iter().map(|s| s.1).sum::<f64>() / n);
    let order_drag = show(&mut session, &mut scene, &selected, id, "last step", true);
    let _ = styk_edit::prof::take();
    let t = Instant::now();
    let r = session.call("commitDrag", "[]", &selected);
    println!("commitDrag call {:.2} ms, answer {} bytes -> {}", ms(t), r.len(), &r[..r.len().min(60)]);
    if let Ok(value) = styk_doc::json::parse(r.as_bytes()) { if let Some(entries) = value.as_obj() { let mut sizes: Vec<(String, usize)> = entries.iter().map(|(k, v)| (k.to_string(), styk_doc::json::to_string(v).len())).collect(); sizes.sort_by_key(|(_, n)| std::cmp::Reverse(*n)); println!("    answer parts: {:?}", &sizes[..sizes.len().min(6)]); } }
    for (name, count, total) in styk_edit::prof::take().into_iter().take(26) { println!("    prof {name}: {count} x, {total:.2} ms"); }
    id += 1;
    let order_after = show(&mut session, &mut scene, &selected, id, "after commit", true);
    id += 1;
    show(&mut session, &mut scene, &selected, id, "after commit, again", true);
    println!("uid order: drag == before: {}, committed == before: {}, committed == drag: {}", order_drag == order_before, order_after == order_before, order_after == order_drag);
    for what in ["undo", "redo"] {
        let t = Instant::now();
        let r = session.call(what, "[]", &selected);
        println!("{what} call {:.2} ms -> {}", ms(t), &r[..r.len().min(60)]);
        id += 1;
        let order = show(&mut session, &mut scene, &selected, id, what, true);
        println!("  uid order == before: {}", order == order_before);
        if order != order_before { let moved: Vec<(usize, u32, u32)> = order.iter().zip(&order_before).enumerate().filter(|(_, (a, b))| a != b).map(|(i, (a, b))| (i, *a, *b)).take(12).collect(); println!("  first differing slots (slot, now, before): {moved:?}; count {}", order.iter().zip(&order_before).filter(|(a, b)| a != b).count()); }
    }
}
