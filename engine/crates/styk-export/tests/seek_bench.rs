//! What a seek costs natively, phase by phase, as the stage shows it: the interface's read of the frame (`query frame`), the session's
//! frame (`Session::show`), the interface's geometry read (`query_packet geometry`, as the interface asks it after a seek), the draw list,
//! the draw list of the same frame again (a pan or zoom step), and a click on artwork. A measurement, not a check: it needs a document,
//! `STYK_BENCH_DOC=<file> cargo test --release -p styk-export --test seek_bench -- --ignored --nocapture` (`STYK_BENCH_TICKS=<n>`, 12 by
//! default; `STYK_BENCH_ROUNDS=<n>` sweeps the ticks that many times and prints the minimum and the median of each phase, which on a
//! machine busy with other work says more than one sweep; `STYK_EDIT_PROFILE=1` adds where the session's calls spend their time).
//! `RAYON_NUM_THREADS=1` builds each frame on one thread, as the app's interface thread does.

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

fn quantile(values: &[f64], q: f64) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    sorted.get(((sorted.len() as f64 - 1.0) * q).round() as usize).copied().unwrap_or(0.0)
}

#[test]
#[ignore]
fn the_frame_of_a_seek() {
    let Some(path) = std::env::var_os("STYK_BENCH_DOC") else { return };
    let ticks = std::env::var("STYK_BENCH_TICKS").ok().and_then(|t| t.parse::<u32>().ok()).unwrap_or(12);
    let rounds = std::env::var("STYK_BENCH_ROUNDS").ok().and_then(|t| t.parse::<u32>().ok()).unwrap_or(1).max(1);
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
    let mut since: Option<f64> = None;
    for round in 0..rounds {
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
            // The geometry since the last read, as the interface reads it after the frame is drawn.
            let t = Instant::now();
            let args = match since { Some(token) => format!("{{\"since\":{token}}}"), None => "{}".into() };
            let packet = session.query_packet("geometry", &args, &view).unwrap();
            let geometry = ms(t);
            if !packet.is_empty() {
                since = Some(packet[0]);
            }
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
            if rounds == 1 {
                println!("tick {tick}: frame read {read:.2} ms ({} KB)  show {show:.2}  geometry {geometry:.2} ({} words)  draw list {draw:.2}  again {redraw:.2} (same list {})  pick mean {pick_mean:.2} max {pick_max:.2}  ({} prims)",
                    text.len() / 1024, packet.len(), Arc::ptr_eq(&list, &again), list.prims.len());
                for (name, count, total) in prof.into_iter().take(10) {
                    println!("    show prof {name}: {count} x, {total:.2} ms");
                }
            }
            // The first seek of the first round opens the frame's caches: it is not a seek like the others.
            if round > 0 || tick > 0 {
                rows.push([read, show, geometry, draw, redraw, pick_mean]);
            }
        }
    }
    let n = rows.len().max(1) as f64;
    let mean = |k: usize| rows.iter().map(|r| r[k]).sum::<f64>() / n;
    println!("mean after the first: frame read {:.2}  show {:.2}  geometry {:.2}  draw list {:.2}  again {:.2}  pick {:.2} ms", mean(0), mean(1), mean(2), mean(3), mean(4), mean(5));
    let column = |k: usize| rows.iter().map(|r| r[k]).collect::<Vec<_>>();
    for (q, label) in [(0.0, "min"), (0.5, "median")] {
        let at = |k: usize| quantile(&column(k), q);
        let total: Vec<f64> = rows.iter().map(|r| r[0] + r[1] + r[2] + r[3]).collect();
        println!("{label} of {}: frame read {:.2}  show {:.2}  geometry {:.2}  draw list {:.2}  (seek {:.2})  again {:.2}  pick {:.2} ms", rows.len(), at(0), at(1), at(2), at(3), quantile(&total, q), at(4), at(5));
    }
}

/// What a frame prepared for playback costs natively on one thread, phase by phase, as a preparation worker makes it
/// (`FrameBuilder::prepare_fresh`): the frame's evaluation, its scene, its draw list and the cull to the artboard. The same document and
/// settings as [`the_frame_of_a_seek`]; `STYK_BENCH_THREADS=<n>` prepares on that many threads at once (each its own ticks), to see
/// what they cost one another.
#[test]
#[ignore]
fn a_prepared_frame() {
    let Some(path) = std::env::var_os("STYK_BENCH_DOC") else { return };
    let ticks = std::env::var("STYK_BENCH_TICKS").ok().and_then(|t| t.parse::<u32>().ok()).unwrap_or(12);
    let rounds = std::env::var("STYK_BENCH_ROUNDS").ok().and_then(|t| t.parse::<u32>().ok()).unwrap_or(1).max(1);
    let threads = std::env::var("STYK_BENCH_THREADS").ok().and_then(|t| t.parse::<u32>().ok()).unwrap_or(1).max(1);
    let path = std::path::PathBuf::from(path);
    let bytes = std::fs::read(&path).unwrap();
    let name = path.file_name().unwrap().to_str().unwrap().to_string();
    let engine = Engine::new(clock, Budgets::for_device(None));
    let opened = engine.open_document(OpenSource::File { bytes: &bytes, name: &name }, OpenOptions { layer_timeline: true }, &|| false).expect("opens");
    engine.activate(&opened.typed, &opened.tree, 1).unwrap();
    let generation = engine.generation().unwrap();
    let rows = std::sync::Mutex::new(Vec::new());
    std::thread::scope(|scope| {
        for thread in 0..threads {
            let (generation, rows) = (&generation, &rows);
            scope.spawn(move || {
                let (prepared, doc) = (&generation.prepared, &generation.prepared.doc);
                for round in 0..rounds {
                    for n in 0..ticks {
                        let tick = (n * threads + thread) as f64;
                        let t = Instant::now();
                        let frame = prepared.evaluate(tick);
                        let evaluate = ms(t);
                        let t = Instant::now();
                        let scene = styk_eval::geometry::build(doc, &frame);
                        let build = ms(t);
                        let t = Instant::now();
                        let mut list = styk_eval::drawlist::encode_composed(doc, &generation.assets, &scene, &styk_eval::drawlist::Overrides::default(), &[], None);
                        let encode = ms(t);
                        let t = Instant::now();
                        styk_eval::drawlist::cull_outside(&mut list, doc, scene.camera.as_ref());
                        let cull = ms(t);
                        let t = Instant::now();
                        drop((frame, scene, list));
                        let dropped = ms(t);
                        if round > 0 || n > 0 {
                            rows.lock().unwrap().push([evaluate, build, encode, cull, dropped]);
                        }
                    }
                }
            });
        }
    });
    let rows = rows.into_inner().unwrap();
    let column = |k: usize| rows.iter().map(|r: &[f64; 5]| r[k]).collect::<Vec<_>>();
    let total: Vec<f64> = rows.iter().map(|r| r.iter().sum()).collect();
    for (q, label) in [(0.0, "min"), (0.5, "median")] {
        let at = |k: usize| quantile(&column(k), q);
        println!("{label} of {} on {threads} threads: evaluate {:.2}  build {:.2}  encode {:.2}  cull {:.2}  drop {:.2}  (frame {:.2}) ms", rows.len(), at(0), at(1), at(2), at(3), at(4), quantile(&total, q));
    }
}
