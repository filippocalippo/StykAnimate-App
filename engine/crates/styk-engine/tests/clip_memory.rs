//! Where the memory of a movieclip goes, natively: a counting allocator around a scripted session on a real document.
//! `STYK_CLIP_DOC=<file> STYK_CLIP_FRAMES=1 cargo test --release -p styk-engine --test clip_memory -- --ignored --nocapture`.
use std::alloc::{GlobalAlloc, Layout, System};
use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
use std::sync::{Arc, OnceLock};
use std::time::Instant;

use styk_doc::Value;
use styk_engine::document::{OpenOptions, OpenSource};
use styk_engine::{Budgets, Engine};

struct Count;
static LIVE: AtomicUsize = AtomicUsize::new(0);
unsafe impl GlobalAlloc for Count {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 { LIVE.fetch_add(layout.size(), Relaxed); unsafe { System.alloc(layout) } }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) { LIVE.fetch_sub(layout.size(), Relaxed); unsafe { System.dealloc(ptr, layout) } }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new: usize) -> *mut u8 { LIVE.fetch_add(new, Relaxed); LIVE.fetch_sub(layout.size(), Relaxed); unsafe { System.realloc(ptr, layout, new) } }
}
#[global_allocator]
static COUNT: Count = Count;

fn clock() -> f64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}
fn mib() -> f64 { LIVE.load(Relaxed) as f64 / 1048576.0 }

/// The nodes of `value` by address, and their bytes (approximate: a value is 16 bytes, an array of numbers its elements).
fn walk(value: &Value, seen: &mut HashSet<usize>, fresh: &mut usize, shared: &mut usize, known: Option<&HashSet<usize>>) {
    let mut node = |address: usize, bytes: usize| -> bool {
        if known.is_some_and(|known| known.contains(&address)) { *shared += bytes; return false; }
        if !seen.insert(address) { return false; }
        *fresh += bytes;
        true
    };
    match value {
        Value::Obj(object) => {
            if node(Arc::as_ptr(object) as usize, 16 * object.values().len() + 48) { for v in object.values() { walk(v, seen, fresh, shared, known); } }
        }
        Value::Arr(items) => {
            if node(Arc::as_ptr(items) as usize, 16 * items.len() + 24) { for v in items.iter() { walk(v, seen, fresh, shared, known); } }
        }
        Value::Nums(numbers) => { node(Arc::as_ptr(numbers) as usize, 4 * numbers.to_vec().len() + 24); }
        Value::Str(text) => { node(Arc::as_ptr(text) as *const u8 as usize, text.len() + 24); }
        _ => {}
    }
}

#[test]
#[ignore]
fn where_a_clip_keeps_its_memory() {
    let Some(path) = std::env::var_os("STYK_CLIP_DOC") else { return };
    let frames: u32 = std::env::var("STYK_CLIP_FRAMES").ok().and_then(|n| n.parse().ok()).unwrap_or(1);
    let path = std::path::PathBuf::from(path);
    let bytes = std::fs::read(&path).unwrap();
    let name = path.file_name().unwrap().to_str().unwrap().to_string();
    let engine = Engine::new(clock, Budgets::for_device(None));
    let before_open = mib();
    let opened = engine.open_document(OpenSource::File { bytes: &bytes, name: &name }, OpenOptions { layer_timeline: true }, &|| false).expect("opens");
    drop(bytes);
    println!("opened: {:.0} MiB (tree + typed views)", mib() - before_open);
    engine.activate(&opened.typed, &opened.tree, 1).unwrap();
    let mut parent = HashSet::new();
    let (mut fresh, mut shared) = (0, 0);
    walk(&opened.tree, &mut parent, &mut fresh, &mut shared, None);
    println!("the parent tree: {} nodes, {:.0} MiB as values", parent.len(), fresh as f64 / 1048576.0);
    let tick = 235u32;
    let indexes = opened.indexes.indexes();
    let state = format!("{{\"tick\":{tick},\"frameIndex\":0,\"selectedUid\":null,\"selectedUids\":[],\"selectedJoint\":-1,\"layerTimeline\":true,\"propertyChannels\":true,\"nextUid\":{},\"nextFrameIdentity\":{}}}",
        indexes.get("nextUid").and_then(Value::as_f64).unwrap_or(1.0), indexes.get("nextFrameIdentity").and_then(Value::as_f64).unwrap_or(1.0));
    let mut session = opened.start_session(&state).expect("a session");
    let draws = r#"[["uuid","a1"],["uuid","a2"],["uuid","a3"],["uuid","a4"],["seed",1],["seed",2],["seed",3],["seed",4],["random",0.1],["random",0.2],["random",0.3],["random",0.4]]"#;
    let view = format!("{{\"tick\":{tick},\"frameIndex\":0,\"selectedUid\":null,\"selectedUids\":[],\"patch\":true,\"changesOnly\":true,\"draws\":{draws},\"drawPool\":true}}");
    let args = format!("[{{\"name\":\"c\",\"start\":{tick},\"end\":{},\"replace\":true,\"uids\":[]}}]", tick + frames);
    let before = mib();
    let started = Instant::now();
    let answer = session.call("createMovieclip", &args, &view);
    println!("create: {:.0} ms, answer {} bytes, live +{:.0} MiB", started.elapsed().as_secs_f64() * 1000.0, answer.len(), mib() - before);
    drop(answer);
    println!("  after the answer is dropped: +{:.0} MiB", mib() - before);
    let report = session.report().clone();
    let before_publish = mib();
    let made = session.views();
    println!("  the session's own typed views: {}", if made.is_some() { "made" } else { "none" });
    let published = engine.publish_tree_with(opened.lineage(), report.clone(), 2, made.clone());
    println!("  the engine publishes the new tree ({:?}): +{:.0} MiB", published.as_ref().map(|c| c.as_ref().map(|c| c.ms)), mib() - before_publish);
    // What of the new clip is not the parent's.
    let figures = report.get("figure_types").and_then(Value::elements).unwrap();
    let clip = figures.iter().last().unwrap();
    let definition = clip.path(&["_styk", "movieclip", "document"]).unwrap().clone();
    let (mut seen, mut fresh, mut shared) = (HashSet::new(), 0, 0);
    walk(&definition, &mut seen, &mut fresh, &mut shared, Some(&parent));
    println!("the clip's document: {:.0} MiB of new values, {:.0} MiB shared with the parent's nodes ({} new nodes)", fresh as f64 / 1048576.0, shared as f64 / 1048576.0, seen.len());
    for part in ["keyframes", "figure_types"] {
        if let Some(v) = definition.get(part) { let (mut s, mut f, mut sh) = (HashSet::new(), 0, 0); walk(v, &mut s, &mut f, &mut sh, Some(&parent)); println!("   document.{part}: {:.0} MiB new, {:.0} shared", f as f64 / 1048576.0, sh as f64 / 1048576.0); }
    }
    if let Some(styk) = definition.get("_styk").and_then(Value::as_obj) {
        for (key, v) in styk.iter() { let (mut s, mut f, mut sh) = (HashSet::new(), 0, 0); walk(v, &mut s, &mut f, &mut sh, Some(&parent)); if f + sh > 1 << 20 { println!("   document._styk.{key}: {:.0} MiB new, {:.0} shared", f as f64 / 1048576.0, sh as f64 / 1048576.0); } }
        if let Some(source) = styk.get("movieclipSource").and_then(|s| s.get("document")).and_then(Value::as_obj) {
            for (key, v) in source.iter() { let (mut s, mut f, mut sh) = (HashSet::new(), 0, 0); walk(v, &mut s, &mut f, &mut sh, Some(&parent)); if f + sh > 1 << 20 { println!("   movieclipSource.document.{key}: {:.0} MiB new, {:.0} shared", f as f64 / 1048576.0, sh as f64 / 1048576.0); } }
        }
    }
    // The typed views of each: converted alone, so the memory they take is the difference.
    let typed = |label: &str, value: &Value| {
        let before = mib();
        let mut loader = styk_eval::load::Loader::new();
        let document = loader.document(value, "x").expect("converts");
        let converted = mib() - before;
        let patches: usize = document.sheet.as_ref().map(|sheet| sheet.tracks.values().map(|t| t.keys.iter().map(|k| k.movieclip_patches.len()).sum::<usize>()).sum()).unwrap_or(0);
        let keys: usize = document.sheet.as_ref().map(|sheet| sheet.tracks.values().map(|t| t.keys.len()).sum()).unwrap_or(0);
        let before_views = mib();
        let views = styk_eval::eval::Prepared::new(Arc::new(document));
        println!("   typed {label}: +{converted:.0} MiB ({} keyframes, {} sources, {keys} sheet keys holding {patches} replacements), then its views +{:.0} MiB", views.doc.keyframes.len(), views.doc.frame_sources.len(), mib() - before_views);
        let document = views.doc.clone();
        drop(views);
        (loader, document)
    };
    let kept_parent = typed("the parent before the clip", &opened.tree);
    let kept_whole = typed("the whole project with the clip", &report);
    let kept_clip = typed("the clip's own document", &definition);
    let retained = definition.path(&["_styk", "movieclipSource", "document"]).unwrap().clone();
    let kept_retained = typed("the document the clip retains", &retained);
    drop((kept_parent, kept_whole, kept_clip, kept_retained));
    println!("total live now: {:.0} MiB", mib());
    let before_undo = mib();
    let undo = session.call("undo", "[]", &format!("{{\"tick\":{tick},\"frameIndex\":0,\"patch\":true}}"));
    println!("undo: answer {} bytes, live {:+.0} MiB", undo.len(), mib() - before_undo);
    let before_redo = mib();
    let redo = session.call("redo", "[]", &format!("{{\"tick\":{tick},\"frameIndex\":0,\"patch\":true}}"));
    println!("redo: answer {} bytes, live {:+.0} MiB, peak not measured", redo.len(), mib() - before_redo);
}
