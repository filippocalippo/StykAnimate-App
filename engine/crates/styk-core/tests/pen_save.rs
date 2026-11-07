//! A stroke on a moved, scaled and rotated cel, in a rotated and zoomed view, through the pen path and out through the
//! engine's own document, save and open: a drawing layer made by the editing session, the cel published into it and the document
//! written and read back as a file. The reopened document holds the cel the worker drew, tile for tile, at the pose it was placed at,
//! on the layer it was drawn on.
//! (The comparison with today's app on the same events is `pen_parity.rs`; this one needs no capture.)

mod common;

use common::{Pose, hashes, save_and_reopen_document, settle};
use std::sync::Arc;
use std::time::Duration;
use styk_core::drawing::mapping::Mapping;
use styk_core::drawing::stroke_input::{Context, FingerDraw, StrokeCommand, StrokeInput, ToolMode};
use styk_core::drawing::worker::{Reply, Request, Worker};
use styk_services::input::{InputEvent, Phase, Script, ScriptSpec};

const BRUSH: &str = "{\"size\":10,\"hardness\":0.8,\"color\":[200,30,60],\"opacity\":1,\"flow\":1,\"spacingRatio\":0.08,\"pressureSize\":true,\"pressureCurve\":[0.25,0.25,0.75,0.75]}";

fn rotation(degrees: f64) -> (f64, f64) {
    let radians = degrees.to_radians();
    (radians.cos(), radians.sin())
}

/// A pen stroke (the standard script's first stroke) through `mapping`, drawn and settled; returns the worker.
fn draw(mapping: &Mapping) -> Worker {
    let script = Script::generate(&ScriptSpec::standard(240.0, 1.0, 360.0, 300.0), 1);
    let brush: Arc<str> = BRUSH.into();
    let mut input = StrokeInput::new();
    let context = Context { tool: ToolMode::Brush, space_held: false, playing: false, finger: FingerDraw::Never, mapping, continue_from: None, region: None };
    let mut commands: Vec<StrokeCommand> = Vec::new();
    // Only the first stroke: up to its lift.
    for step in script.steps.iter().take_while(|s| s.phase != Phase::Up).chain(script.steps.iter().filter(|s| s.phase == Phase::Up).take(1)) {
        input.feed(&InputEvent::Sample(step.sample(1, 1_000_000_000)), &context, &mut commands);
    }
    let worker = common::new_worker();
    for command in commands {
        worker.command(command, &brush);
    }
    settle(&worker);
    worker
}

#[test]
fn a_stroke_on_a_moved_scaled_and_rotated_cel_survives_the_engines_save_and_open_tile_for_tile() {
    let (c, s) = rotation(32.0);
    // The cel is placed at (120, 80) world units, turned 32 degrees and drawn at 2 pixels per unit: pixels to world.
    let pose = [c * 0.5, s * 0.5, -s * 0.5, c * 0.5, 120.0, 80.0];
    // The view is turned the other way and zoomed, and the stage sits 40 pixels in from the window's corner.
    let (vc, vs) = rotation(-14.0);
    let camera = [vc * 1.6, vs * 1.6, -vs * 1.6, vc * 1.6, 30.0, -20.0];
    let moved = Mapping { window_origin: (40.0, 40.0), camera, pixel_matrix: pose, ..Mapping::default() };
    let plain = Mapping::default();

    let worker = draw(&moved);
    let drawn = hashes(&worker, 1);
    assert!(drawn.len() > 3, "the stroke made tiles: {}", drawn.len());
    // The pose and the view really moved the ink: the same events through an identity mapping land elsewhere.
    let reference = draw(&plain);
    assert_ne!(drawn, hashes(&reference, 1));

    worker.send(Request::Snapshot { token: 2 });
    let snapshot = loop {
        match worker.wait(Duration::from_secs(30)).expect("the worker answers") {
            Reply::Snapshot { tiles, .. } => break tiles,
            Reply::Tiles { seq, last: true, .. } => worker.ack(seq),
            _ => {}
        }
    };
    let placed = Pose::of_matrix(pose);
    let reopened = save_and_reopen_document(&snapshot, placed);
    assert_eq!(reopened.tiles, drawn, "the cel in the saved and reopened document is the cel that was drawn");
    assert_eq!(reopened.pose, placed, "the cel keeps its place, scale and turn");
    assert!(reopened.layer_shows_cel, "the layer's key shows the cel");
    assert!((placed.angle - 32f64.to_radians()).abs() < 1e-12 && (placed.scale - 0.5).abs() < 1e-12 && placed.root == (120.0, 80.0), "the pose is the one the cel was given: {placed:?}");

    // Undo and redo: the same pixels come back, and the saved cel of the undone state is empty.
    worker.send(Request::Undo);
    assert!(hashes(&worker, 3).is_empty());
    worker.send(Request::Redo);
    assert_eq!(hashes(&worker, 4), drawn);
}
