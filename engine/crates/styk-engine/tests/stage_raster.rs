//! The stage drawn by the processor renderer on the engine's workers (`styk_engine::stage_raster`, docs/engine/rendering.md
//! "The stage on the processor"), with real worker threads: a frame drawn in bands on the workers is the frame the
//! processor renderer draws whole; a newer request replaces the one waiting and the buffers stay bounded; a frame let
//! go of is never shown; pictures the stage hands over and the live drawing cels' slots are what the frames sample.

use std::path::Path;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use styk_draw::{DrawList, Group, Pass, Prim, F_DRAWING, K_FILL_VIEW, K_IMAGE, NO_LAYER, NO_PAINT};
use styk_engine::stage_raster::{Request, StageRaster, BAND_ROWS};
use styk_engine::{Budgets, Engine};
use styk_raster::{DrawingGrid, Edges, Raster, ViewParams};

fn clock() -> f64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}

fn with_workers(count: usize, run: impl FnOnce(&Engine)) {
    let engine = Engine::new(clock, Budgets::for_device(None));
    let workers: Vec<_> = (0..count).map(|_| { let engine = engine.clone(); std::thread::spawn(move || engine.work()) }).collect();
    run(&engine);
    engine.stop();
    for worker in workers {
        worker.join().unwrap();
    }
}

/// Polls as the interface does until no frame is being drawn.
fn settle(stage: &mut StageRaster) {
    let started = Instant::now();
    while stage.poll() {
        assert!(started.elapsed() < Duration::from_secs(20), "the frame was never drawn");
        std::thread::sleep(Duration::from_millis(1));
    }
}

/// The fitted view of a document at `size`, as the stage draws a prepared frame (through its camera, clipped to the artboard).
fn view(doc: &styk_eval::doc::Document, camera: Option<&styk_eval::doc::Camera>, size: [u32; 2]) -> ViewParams {
    let (cw, ch) = (doc.canvas[0] as f64, doc.canvas[1] as f64);
    let zoom = (size[0] as f64 / cw).min(size[1] as f64 / ch) * 0.9;
    let pan = [(size[0] as f64 - cw * zoom) / 2.0, (size[1] as f64 - ch * zoom) / 2.0];
    ViewParams { matrix: styk_eval::view::camera_matrix(doc, camera, zoom, pan), artboard: [pan[0], pan[1], pan[0] + cw * zoom, pan[1] + ch * zoom], clip_to_artboard: true,
        clear: [0.0; 4], zoom, pan, stretch: 1.0, camera_view: camera.is_some(), camera_limit: 2048.0 }
}

#[test]
fn a_frame_drawn_on_the_workers_is_the_frame_drawn_whole() {
    for file in ["engine/crates/styk-eval/tests/fixtures/drawlist/drawing-cel.json", "engine/crates/styk-eval/tests/fixtures/generators/explosions.json"] {
        with_workers(4, |engine| {
            let bytes = std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..").join(file)).unwrap();
            engine.open(&bytes, "json", "fixture").unwrap();
            let snapshot = engine.prepared_frame_now_at(0.0).expect("a frame");
            let generation = snapshot.generation.clone();
            let size = [333, 3 * BAND_ROWS + 17];
            let view = view(&generation.prepared.doc, snapshot.frame.camera.as_ref(), size);
            let mut stage = StageRaster::new(engine);
            // No picture is handed over: the frame's job decodes what it samples from the document.
            stage.request(Request { generation: generation.clone(), list: snapshot.frame.list.clone(), view, orientation: None, size, grid: DrawingGrid::World });
            settle(&mut stage);
            let shot = stage.ready().expect("drawn").clone();
            assert_eq!((shot.serial, shot.width, shot.height), (1, size[0], size[1]));
            let whole = Raster::new(Edges::Smooth).render(&snapshot.frame.list, &styk_raster::decode_all(&generation.prepared.doc, &generation.assets), &view, size).straight();
            let worst = whole.iter().zip(shot.pixels()).map(|(a, b)| a.abs_diff(*b)).max().unwrap();
            assert!(worst <= 2, "{file}: a pixel differs by {worst} levels");
            assert!(shot.pixels().chunks(4).any(|p| p[3] > 0), "{file}: something is drawn");
            let stats = stage.stats();
            assert_eq!(stats.bands, 4);
            if file.contains("drawing-cel") {
                assert!(stats.picture_bytes > 0, "the cel's tiles are held for the next frame");
            }
        });
    }
}

#[test]
fn a_newer_request_replaces_the_one_waiting_and_the_buffers_stay_bounded() {
    with_workers(2, |engine| {
        let bytes = std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../engine/crates/styk-eval/tests/fixtures/generators/explosions.json")).unwrap();
        engine.open(&bytes, "json", "fixture").unwrap();
        let snapshot = engine.prepared_frame_now_at(0.0).expect("a frame");
        let size = [640, 360];
        let view = view(&snapshot.generation.prepared.doc, snapshot.frame.camera.as_ref(), size);
        let request = || Request { generation: snapshot.generation.clone(), list: snapshot.frame.list.clone(), view, orientation: None, size, grid: DrawingGrid::World };
        let mut stage = StageRaster::new(engine);
        let frame = (size[0] * size[1] * 4) as usize;
        for _ in 0..6 {
            stage.request(request());
            assert!(stage.stats().buffer_bytes <= 3 * frame, "at most a frame drawn, one shown and one kept");
        }
        settle(&mut stage);
        // The first was being drawn while the others came: each replaced the one waiting, and the last is the one to show.
        let stats = stage.stats();
        assert_eq!(stage.ready().map(|shot| shot.serial), Some(6));
        assert!(stats.replaced >= 1 && stats.replaced <= 4, "{stats:?}");
        stage.shown(6);
        assert!(stage.ready().is_none());
        assert_eq!(stage.stats().shown, 1);
        assert!(stage.stats().buffer_bytes <= frame, "a shown frame's buffer is kept for the next one, and nothing else");
        // A frame let go of (another document, the stage freed) is never shown, and the stage draws again afterwards.
        stage.request(request());
        stage.clear();
        settle(&mut stage);
        assert!(stage.ready().is_none());
        assert_eq!(stage.stats().buffer_bytes, 0);
        stage.request(request());
        settle(&mut stage);
        assert_eq!(stage.ready().map(|shot| shot.serial), Some(8));
    });
}

#[test]
fn the_live_cels_slots_are_drawn_from_what_the_stage_hands_over() {
    use styk_eval::live::{Run, CELL};
    with_workers(2, |engine| {
        let bytes = std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../engine/crates/styk-eval/tests/fixtures/generators/explosions.json")).unwrap();
        engine.open(&bytes, "json", "fixture").unwrap();
        let generation = engine.generation().unwrap();
        // Two live slots side by side on the live page at atlas layer 5: the first red, the second blue.
        let mut rgba = vec![0u8; (2 * CELL * CELL * 4) as usize];
        for (i, pixel) in rgba.chunks_mut(4).enumerate() {
            let blue = (i as u32 % (2 * CELL)) >= CELL;
            pixel.copy_from_slice(if blue { &[0, 0, 255, 255] } else { &[255, 0, 0, 255] });
        }
        let base = 5;
        let border = styk_eval::drawing::BORDER;
        let run = Run { page: 0, x: 0, y: 0, cells: 2, rgba };
        let tile = |x: f32, cell: u32| {
            let place = [(cell * CELL + border) as f32, border as f32];
            let page = styk_eval::assets::PAGE as f32;
            Prim { kind: K_IMAGE | F_DRAWING, group: 0, color: 0xffff_ffff, paint: NO_PAINT, a: [x, 0.0, 64.0, 0.0], b: [0.0, 64.0, base as f32, 0.0],
                c: [place[0] / page, place[1] / page, (place[0] + 64.0) / page, (place[1] + 64.0) / page] }
        };
        let fill = Prim { kind: K_FILL_VIEW, group: 0, color: 0xffff_ffff, paint: NO_PAINT, a: [0.0; 4], b: [0.0; 4], c: [0.0; 4] };
        let list = Arc::new(DrawList { prims: vec![fill, tile(0.0, 0), tile(64.0, 1)], groups: vec![Group { parent: 0, depth: 0, opacity: 1.0, bounds: [0.0; 4], layer: NO_LAYER }],
            passes: vec![Pass { depth: 0, start: 0, end: 3 }], background_prims: 1, ..Default::default() });
        let size = [128, 64];
        let view = ViewParams { matrix: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0], artboard: [0.0, 0.0, 128.0, 64.0], clip_to_artboard: false, clear: [0.0; 4], zoom: 1.0, pan: [0.0; 2], stretch: 1.0, camera_view: false, camera_limit: 2048.0 };
        let mut stage = StageRaster::new(engine);
        stage.add_live(base, &[run]);
        stage.request(Request { generation: generation.clone(), list: list.clone(), view, orientation: None, size, grid: DrawingGrid::World });
        settle(&mut stage);
        let shot = stage.ready().unwrap().clone();
        let at = |x: usize, y: usize| shot.pixels()[(y * 128 + x) * 4..][..4].to_vec();
        assert_eq!(at(30, 30), [255, 0, 0, 255], "the first slot");
        assert_eq!(at(100, 30), [0, 0, 255, 255], "the second slot");
        // The live pages moved: their tiles are let go of, and the slots draw nothing until they are written again.
        stage.shown(shot.serial);
        stage.drop_live_from(base);
        stage.request(Request { generation, list, view, orientation: None, size, grid: DrawingGrid::World });
        settle(&mut stage);
        let shot = stage.ready().unwrap();
        assert_eq!(shot.pixels()[(30 * 128 + 30) * 4..][..4].to_vec(), [255, 255, 255, 255]);
    });
}
