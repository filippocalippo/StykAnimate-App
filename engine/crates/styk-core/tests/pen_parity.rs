//! The native pen path against today's app, from the same original events.
//!
//! `scripts/pen-parity-capture.mjs` drives the JavaScript app with pen events and records, per scenario, the brush the
//! controller posted, how it maps window pixels to the cel, the events, and a hash of every cel tile after the stroke, after
//! undo, after redo and after a save and reopen. This test feeds the same events through `StrokeInput`, the mapping and the
//! drawing worker and compares the tiles. It needs a capture file: `STYK_PEN_PARITY=<capture.json> cargo test -p styk-core
//! --test pen_parity`; without one it says so and passes nothing (a capture needs Chrome and the built app).
//!
//! The capture's `oldVersusOld` lists the fields that differed between two runs of today's app on the same events; only
//! those may differ here.

use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::time::Duration;
use styk_core::drawing::mapping::Mapping;
use styk_core::drawing::stroke_input::{Context, FingerDraw, StrokeInput, ToolMode};
use styk_core::drawing::worker::{Reply, Request, Worker};
use styk_doc::{Value, json};
use styk_services::input::{InputEvent, InterruptReason, Modifiers, PenButtons, PenSample, Phase, Tool, Valid};

fn field<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.as_obj().and_then(|o| o.get(key)).unwrap_or_else(|| panic!("the capture has no {key}"))
}

fn numbers(value: &Value) -> Vec<f64> {
    value.numbers().unwrap_or_else(|| panic!("expected numbers"))
}

fn tiles_of(value: &Value) -> Vec<(i64, i64, String)> {
    value
        .elements()
        .expect("a tile list")
        .into_iter()
        .map(|row| {
            let items = row.as_arr().expect("a [tx, ty, hash] row");
            (items[0].as_f64().unwrap() as i64, items[1].as_f64().unwrap() as i64, items[2].as_str().unwrap().to_string())
        })
        .collect()
}

fn hashes(worker: &Worker, token: u64) -> Vec<(i64, i64, String)> {
    worker.send(Request::Snapshot { token });
    loop {
        match worker.wait(Duration::from_secs(30)).expect("the worker answers") {
            Reply::Snapshot { tiles, .. } => {
                let mut rows: Vec<(i64, i64, String)> = tiles.iter().map(|(tx, ty, pixels)| (*tx, *ty, hex(&Sha256::digest(pixels)))).collect();
                rows.sort_by_key(|r| (r.1, r.0));
                return rows;
            }
            _ => {}
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn settle(worker: &Worker) {
    worker.send(Request::Ping { token: 9 });
    loop {
        if let Reply::Pong { .. } = worker.wait(Duration::from_secs(60)).expect("the worker answers") {
            return;
        }
    }
}

#[test]
fn the_native_pen_path_matches_todays_app_on_the_same_events() {
    let Some(path) = std::env::var_os("STYK_PEN_PARITY") else {
        eprintln!("STYK_PEN_PARITY is not set: no capture of today's app to compare with (see scripts/pen-parity-capture.mjs)");
        return;
    };
    let capture = json::parse(&std::fs::read(path).expect("the capture file reads")).expect("the capture is JSON");
    let mut failures = Vec::new();
    for scenario in field(&capture, "scenarios").elements().expect("scenarios") {
        let name = field(&scenario, "name").as_str().unwrap().to_string();
        let brush: Arc<str> = field(&scenario, "brush_json").as_str().unwrap().into();
        let mapping_value = field(&scenario, "mapping");
        let canvas = numbers(field(mapping_value, "canvas"));
        let mirror = field(&scenario, "mirror").as_bool() == Some(true);
        let camera = numbers(field(mapping_value, "camera"));
        let rect = numbers(field(mapping_value, "rect"));
        let p = numbers(field(mapping_value, "pixel_matrix"));
        let mapping = Mapping {
            window_origin: (rect[0], rect[1]),
            window_scale: (rect[2], rect[3]),
            camera: [camera[0], camera[1], camera[2], camera[3], camera[4], camera[5]],
            pixel_matrix: [p[0], p[1], p[2], p[3], p[4], p[5]],
            mirror_x: mirror.then_some(canvas[0] / 2.0),
            mirror_y: None,
        };
        let end = field(&scenario, "end").as_str().unwrap().to_string();
        let worker = Worker::spawn(Vec::new(), Arc::new(|| {}));
        let mut input = StrokeInput::new();
        let context = Context { tool: ToolMode::Brush, space_held: false, playing: false, finger: FingerDraw::Never, mapping: &mapping, continue_from: None, region: None };
        let mut commands = Vec::new();
        let base = 1_000_000_000u64;
        let mut last_ns = base;
        for event in field(&scenario, "events").elements().expect("events") {
            let kind = field(&event, "type").as_str().unwrap(); // down, move or up
            let num = |key: &str| field(&event, key).as_f64().unwrap();
            let time_ns = base + (num("t") * 1e6) as u64;
            last_ns = time_ns;
            let mut sample = PenSample::at(time_ns, 1, Tool::Pen, num("x"), num("y"));
            sample.phase = match kind {
                "down" => Phase::Down,
                "up" => Phase::Up,
                _ if num("buttons") as u32 & 1 != 0 => Phase::Move,
                _ => Phase::Hover,
            };
            sample.pressure = num("pressure") as f32;
            sample.tilt_x = num("tiltX") as f32;
            sample.tilt_y = num("tiltY") as f32;
            sample.valid = Valid::PRESSURE | Valid::TILT;
            if sample.phase != Phase::Hover && sample.phase != Phase::Up {
                sample.buttons = PenButtons::TIP;
            }
            sample.modifiers = Modifiers::NONE;
            input.feed(&InputEvent::Sample(sample), &context, &mut commands);
        }
        match end.as_str() {
            "lostcapture" => input.feed(&InputEvent::Interrupted { pointer: 1, time_ns: last_ns + 1, reason: InterruptReason::CaptureLost }, &context, &mut commands),
            "escape" => input.discard(&mut commands),
            _ => {}
        }
        for command in commands {
            worker.command(command, &brush);
        }
        settle(&worker);
        let expect = field(&scenario, "expect");
        let baseline: Vec<String> = field(&scenario, "oldVersusOld").elements().map(|e| e.into_iter().map(|v| v.as_str().unwrap_or("").to_string()).collect()).unwrap_or_default();
        let mut check = |stage: &str, native: Vec<(i64, i64, String)>| {
            let Some(expected) = expect.as_obj().and_then(|o| o.get(stage)) else { return };
            let expected = tiles_of(expected);
            if baseline.iter().any(|path| path.starts_with(&format!("/expect/{stage}"))) {
                return;
            }
            if native != expected {
                let differing: Vec<(i64, i64)> = native.iter().filter(|row| !expected.contains(row)).map(|row| (row.0, row.1)).collect();
                failures.push(format!("{name} {stage}: {} native tiles, {} in today's app, {} native tiles differ: {differing:?}", native.len(), expected.len(), differing.len()));
            }
        };
        check("commit", hashes(&worker, 1));
        if end != "escape" {
            worker.send(Request::Undo);
            settle(&worker);
            check("undo", hashes(&worker, 2));
            worker.send(Request::Redo);
            settle(&worker);
            check("redo", hashes(&worker, 3));
            // Save and reopen: a worker started from the saved tiles.
            worker.send(Request::Snapshot { token: 4 });
            let saved = loop {
                if let Reply::Snapshot { tiles, .. } = worker.wait(Duration::from_secs(30)).unwrap() {
                    break tiles;
                }
            };
            let reopened = Worker::spawn(saved, Arc::new(|| {}));
            check("reopen", hashes(&reopened, 5));
        } else {
            let expected_empty = tiles_of(field(expect, "commit")).is_empty();
            assert_eq!(hashes(&worker, 6).is_empty(), expected_empty, "{name}: a discarded stroke leaves the cel as it was");
        }
    }
    assert!(failures.is_empty(), "the native path differs from today's app:\n{}", failures.join("\n"));
}
