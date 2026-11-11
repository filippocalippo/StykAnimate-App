//! What a seek costs natively, phase by phase, as the stage shows it: the interface's read of the frame (`query frame`), the session's
//! frame (`Session::show`), the draw list, the draw list of the same frame again (a pan or zoom step), and a click on artwork. A
//! measurement, not a check: it needs a document,
//! `STYK_BENCH_DOC=<file> cargo test --release -p styk-export --test seek_bench -- --ignored --nocapture` (`STYK_BENCH_TICKS=<n>`, 12 by
//! default; `STYK_EDIT_PROFILE=1` adds where the session's calls spend their time).

use std::collections::HashSet;
use std::sync::{Arc, OnceLock};
use std::time::Instant;

use styk_engine::document::{OpenOptions, OpenSource};
use styk_engine::edit::{EditOptions, EditScene};
use styk_engine::{Budgets, Engine, Generation};

fn clock() -> f64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}

#[test]
#[ignore]
fn the_frame_of_a_seek() {
    let Some(path) = std::env::var_os("STYK_BENCH_DOC") else { return };
    let ticks = std::env::var("STYK_BENCH_TICKS").ok().and_then(|t| t.parse::<u32>().ok()).unwrap_or(12);
    let path = std::path::PathBuf::from(path);
    let bytes = std::fs::read(&path).unwrap();
    let name = path.file_name().unwrap().to_str().unwrap().to_string();
    let engine = Engine::new(clock, Budgets::for_device(None));
    let opened = engine.open_document(OpenSource::File { bytes: &bytes, name: &name }, OpenOptions { layer_timeline: true }, &|| false).expect("opens");
    engine.activate(&opened.typed, &opened.tree, 1).unwrap();
    let state = "{\"tick\":0,\"frameIndex\":0,\"selectedUid\":null,\"selectedUids\":[],\"selectedJoint\":-1,\"layerTimeline\":true,\"propertyChannels\":true}";
    let mut session = opened.start_session(state).expect("a session");
    let base = engine.generation().unwrap();
    let generation_of = |prepared: &Arc<styk_eval::eval::Prepared>| Generation { id: base.id + 1, lineage: base.lineage, revision: base.revision, prepared: prepared.clone(), assets: base.assets.clone(), open_ms: 0.0, anchors: base.anchors.clone() };
    let mut scene = EditScene::default();
    let mut picker = styk_export::pick::Picker::default();
    let mut rows = Vec::new();
    for tick in 0..ticks {
        let view = format!("{{\"tick\":{tick},\"frameIndex\":0}}");
        let _ = styk_edit::prof::take();
        let t = Instant::now();
        let text = session.query("frame", "{}", &view).unwrap();
        let read = ms(t);
        let t = Instant::now();
        let shown = session.show(&view, false).unwrap();
        let show = ms(t);
        let prof = styk_edit::prof::take();
        let generation = generation_of(&shown.prepared);
        let t = Instant::now();
        assert!(scene.update_shown(&generation, &shown));
        let list = scene.draw_list(&generation, &EditOptions::default()).unwrap().unwrap();
        let draw = ms(t);
        let t = Instant::now();
        let again = scene.draw_list(&generation, &EditOptions::default()).unwrap().unwrap();
        let redraw = ms(t);
        // Clicks: on the first segment of a few figures, and beside everything.
        let frame = scene.frame().unwrap();
        let points: Vec<[f64; 2]> = shown.scene.objects.iter().filter(|g| g.resolved && !g.ends.is_empty()).step_by(shown.scene.objects.len().max(8) / 8).map(|g| [(g.root[0] + g.ends[0][0]) / 2.0, (g.root[1] + g.ends[0][1]) / 2.0]).chain([[-1.0e5, -1.0e5]]).collect();
        let none = HashSet::new();
        let mut picks = Vec::new();
        for point in &points {
            let t = Instant::now();
            // As the stage picks: the session's scene of the frame on show, kept for the frame.
            let hit = styk_export::pick::shown(&mut picker, &generation.prepared.doc, &generation.assets, generation.id, &frame, scene.shapes().map(|(_, scene)| scene).as_ref(), *point, 1.0, &none, &none).unwrap();
            picks.push((ms(t), hit.map(|h| h.slot)));
        }
        let pick_mean = picks.iter().map(|p| p.0).sum::<f64>() / picks.len() as f64;
        let pick_max = picks.iter().map(|p| p.0).fold(0.0, f64::max);
        println!("tick {tick}: frame read {read:.2} ms ({} KB)  show {show:.2}  draw list {draw:.2}  again {redraw:.2} (same list {})  pick mean {pick_mean:.2} max {pick_max:.2}  ({} prims)",
            text.len() / 1024, Arc::ptr_eq(&list, &again), list.prims.len());
        for (name, count, total) in prof.into_iter().take(10) {
            println!("    show prof {name}: {count} x, {total:.2} ms");
        }
        rows.push((read, show, draw, redraw, pick_mean));
    }
    let n = rows.len().saturating_sub(1).max(1) as f64;
    let mean = |f: fn(&(f64, f64, f64, f64, f64)) -> f64| rows.iter().skip(1).map(f).sum::<f64>() / n;
    println!("mean after the first: frame read {:.2}  show {:.2}  draw list {:.2}  again {:.2}  pick {:.2} ms", mean(|r| r.0), mean(|r| r.1), mean(|r| r.2), mean(|r| r.3), mean(|r| r.4));
}
