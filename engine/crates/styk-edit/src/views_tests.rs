//! What the interface reads besides the frame on show: the motion-path trails, the onion skins and the camera's views
//! (`trails.rs`, `onion_skins.rs`, `camera_views.rs`), on `tests/edit/camera-follow-figures.document.json`: three figures on two
//! layers of a layer sheet (figures 1 and 2 on `layer-1`, 3 on `layer-2`), keys at ticks 0, 12, 20 and 30, a follow clip of
//! figures 1 and 2 over ticks 2 to 35, a shake over 10 to 21 and a second follow over 5 to 34.

use std::cell::Cell;

use styk_doc::Value;

use crate::trails::plan_ticks;
use crate::{Editor, Options, Selection};

fn parse(text: &str) -> Value {
    styk_doc::json::parse(text.as_bytes()).unwrap()
}

fn document() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit/camera-follow-figures.document.json");
    parse(&std::fs::read_to_string(path).unwrap())
}

fn editor_at(tick: f64) -> Editor {
    let mut editor = Editor::new(document(), Options { property_channels: true, layer_timeline: true, auto_key: false });
    editor.set_view(tick, 0, Selection { uid: Some(1), uids: vec![1], joint: -1 });
    editor
}

thread_local! { static NOW: Cell<f64> = const { Cell::new(0.0) }; }
/// A clock that is ten milliseconds later every time it is read.
fn ticking() -> f64 {
    NOW.with(|now| { now.set(now.get() + 10.0); now.get() })
}

const ORIGIN: &str = r#"{"kind":"node","uid":1,"handleId":0,"joint":-1}"#;
const TIP: &str = r#"{"kind":"node","uid":1,"handleId":33,"joint":2}"#;

fn trails(editor: &Editor, args: &str) -> Value {
    parse(&editor.interface_trails(&parse(args)).unwrap())
}

/// The sampled points of a trail by tick: `(x, y, flags, bodyX, bodyY)`.
fn points(entry: &Value) -> Vec<(f64, [f64; 5])> {
    let flat = entry.get("points").unwrap().numbers().unwrap();
    flat.chunks(6).map(|row| (row[0], [row[1], row[2], row[3], row[4], row[5]])).collect()
}

fn at(entry: &Value, tick: f64) -> Option<[f64; 5]> {
    points(entry).into_iter().find(|(at, _)| *at == tick).map(|(_, point)| point)
}

#[test]
fn a_trail_has_a_point_at_every_tick_of_a_short_animation_and_marks_the_keys() {
    let editor = editor_at(0.0);
    let answer = trails(&editor, &format!(r#"{{"targets":[{ORIGIN}]}}"#));
    let entry = answer.get("entries").unwrap().item(0).unwrap();
    assert_eq!(entry.get("key").and_then(Value::as_str), Some("1:0"));
    assert_eq!(entry.get("complete"), Some(&Value::Bool(true)));
    let ticks = entry.get("ticks").unwrap().numbers().unwrap();
    assert_eq!(ticks, (0..40).map(f64::from).collect::<Vec<_>>());
    assert_eq!(points(&entry).len(), 40);
    // The stored poses: frame-3 at tick 0, frame-2 at 12, frame-4 at 30.
    assert_eq!(&at(&entry, 0.0).unwrap()[..2], &[180.0, 170.0]);
    assert_eq!(&at(&entry, 12.0).unwrap()[..2], &[340.0, 130.0]);
    assert_eq!(&at(&entry, 30.0).unwrap()[..2], &[460.0, 190.0]);
    for (tick, point) in points(&entry) {
        assert_eq!(point[2] as u32 & 1 == 1, [0.0, 12.0, 20.0, 30.0].contains(&tick), "tick {tick}: keyed");
        assert_eq!(point[2] as u32 & 6, 0, "the origin has no body reference and is never missing");
    }
}

#[test]
fn a_trail_that_is_given_a_budget_takes_it_and_goes_on_over_the_next_reads() {
    let mut editor = editor_at(5.0);
    editor.clock = Some(ticking);
    let args = format!(r#"{{"targets":[{ORIGIN}],"budgetMs":0}}"#);
    let first = trails(&editor, &args).get("entries").unwrap().item(0).unwrap();
    assert_eq!(first.get("complete"), Some(&Value::Bool(false)));
    let sampled = points(&first).len();
    assert!(sampled >= 1 && sampled < 40, "a read takes at least one sample and no more than its budget lets it: {sampled}");
    // The playhead's surroundings first.
    assert!(at(&first, 5.0).is_some());
    let mut entry = first;
    for _ in 0..100 {
        if entry.get("complete") == Some(&Value::Bool(true)) { break; }
        entry = trails(&editor, &args).get("entries").unwrap().item(0).unwrap();
    }
    assert_eq!(entry.get("complete"), Some(&Value::Bool(true)));
    let whole = trails(&editor, &format!(r#"{{"targets":[{ORIGIN}]}}"#)).get("entries").unwrap().item(0).unwrap();
    assert_eq!(points(&entry), points(&whole), "the sampling that was spread over reads is the one that was not");
}

#[test]
fn a_reader_that_holds_a_trail_is_sent_its_version_and_not_its_points_again() {
    let editor = editor_at(0.0);
    let first = trails(&editor, &format!(r#"{{"targets":[{ORIGIN}]}}"#)).get("entries").unwrap().item(0).unwrap();
    let version = first.get("version").and_then(Value::as_f64).unwrap();
    let again = trails(&editor, &format!(r#"{{"targets":[{ORIGIN}],"held":{{"1:0":{version}}}}}"#)).get("entries").unwrap().item(0).unwrap();
    assert_eq!(again.get("version").and_then(Value::as_f64), Some(version));
    assert!(again.get("points").is_none() && again.get("ticks").is_none());
    let other = trails(&editor, &format!(r#"{{"targets":[{ORIGIN}],"held":{{"1:0":{}}}}}"#, version + 1.0)).get("entries").unwrap().item(0).unwrap();
    assert_eq!(points(&other), points(&first));
}

#[test]
fn a_limb_tip_trail_carries_the_body_it_belongs_to_and_the_camera_trail_is_the_canvas_centre() {
    let editor = editor_at(0.0);
    let answer = trails(&editor, &format!(r#"{{"targets":[{ORIGIN},{TIP},{{"kind":"camera"}}]}}"#));
    let entries = answer.get("entries").unwrap();
    let (origin, tip, camera) = (entries.item(0).unwrap(), entries.item(1).unwrap(), entries.item(2).unwrap());
    for (tick, point) in points(&tip) {
        assert_eq!(point[2] as u32 & 4, 4, "tick {tick}: a tip has its body");
        let root = at(&origin, tick).unwrap();
        assert_eq!([point[3], point[4]], [root[0], root[1]], "tick {tick}: the body is the origin of the figure");
    }
    // The tip hangs from the origin, away from it.
    assert_ne!(&at(&tip, 0.0).unwrap()[..2], &at(&origin, 0.0).unwrap()[..2]);
    assert_eq!(&at(&camera, 0.0).unwrap()[..2], &[480.0, 270.0]);
}

#[test]
fn trails_sampled_together_equal_the_trails_sampled_alone() {
    let editor = editor_at(0.0);
    let together = trails(&editor, &format!(r#"{{"targets":[{ORIGIN},{TIP}]}}"#));
    for (n, target) in [ORIGIN, TIP].into_iter().enumerate() {
        let alone = trails(&editor_at(0.0), &format!(r#"{{"targets":[{target}]}}"#)).get("entries").unwrap().item(0).unwrap();
        assert_eq!(points(&together.get("entries").unwrap().item(n).unwrap()), points(&alone));
    }
}

#[test]
fn a_trail_asks_for_a_target_it_can_read_and_the_ones_the_figure_is_not_in_are_missing() {
    let editor = editor_at(0.0);
    assert!(editor.interface_trails(&parse(r#"{"targets":[{"kind":"banana"}]}"#)).is_err());
    let absent = trails(&editor, r#"{"targets":[{"kind":"node","uid":99,"handleId":0}]}"#).get("entries").unwrap().item(0).unwrap();
    assert!(points(&absent).iter().all(|(_, point)| point[2] as u32 & 2 == 2), "a figure that is not there is missing everywhere");
    // A joint the figure does not have is missing too.
    let none = trails(&editor, r#"{"targets":[{"kind":"node","uid":1,"handleId":4242}]}"#).get("entries").unwrap().item(0).unwrap();
    assert!(points(&none).iter().all(|(_, point)| point[2] as u32 & 2 == 2));
}

#[test]
fn a_ranged_trail_follows_the_playhead_and_keeps_what_it_sampled() {
    let mut editor = editor_at(10.0);
    let args = r#"{"targets":[{"kind":"node","uid":1,"handleId":0}],"range":4}"#;
    let before = trails(&editor, args).get("entries").unwrap().item(0).unwrap();
    assert_eq!(before.get("ticks").unwrap().numbers().unwrap(), (6..=14).map(f64::from).collect::<Vec<_>>());
    editor.set_view(12.0, 0, Selection::default());
    let after = trails(&editor, args).get("entries").unwrap().item(0).unwrap();
    assert_eq!(after.get("ticks").unwrap().numbers().unwrap(), (8..=16).map(f64::from).collect::<Vec<_>>());
    assert_eq!(at(&after, 10.0), at(&before, 10.0));
    assert!(at(&after, 6.0).is_none());
}

#[test]
fn a_changed_document_resamples_a_trail_and_keeps_showing_the_old_points_meanwhile() {
    let mut editor = editor_at(0.0);
    editor.clock = Some(ticking);
    let args = format!(r#"{{"targets":[{ORIGIN}],"budgetMs":0}}"#);
    let mut entry = trails(&editor, &args).get("entries").unwrap().item(0).unwrap();
    for _ in 0..100 {
        if entry.get("complete") == Some(&Value::Bool(true)) { break; }
        entry = trails(&editor, &args).get("entries").unwrap().item(0).unwrap();
    }
    let complete = points(&entry).len();
    // Another document: a figure moves at its key.
    editor.report = {
        let mut report = editor.report.clone();
        let source = report.make_obj().unwrap().get_mut("_styk").unwrap().make_obj().unwrap().get_mut("frameSources").unwrap().make_obj().unwrap().get_mut("frame-2").unwrap().make_obj().unwrap().get_mut("objects").unwrap().make_arr().unwrap();
        source[0].make_obj().unwrap().set("root_x", Value::Num(500.0));
        report
    };
    let during = trails(&editor, &args).get("entries").unwrap().item(0).unwrap();
    assert_eq!(during.get("complete"), Some(&Value::Bool(false)));
    assert!(points(&during).len() >= complete, "the points of the old document stay while it is sampled again");
    let mut done = during;
    for _ in 0..100 {
        if done.get("complete") == Some(&Value::Bool(true)) { break; }
        done = trails(&editor, &args).get("entries").unwrap().item(0).unwrap();
    }
    assert_eq!(at(&done, 12.0).unwrap()[0], 500.0);
}

#[test]
fn the_pose_at_a_trail_point_covers_the_figure_at_that_tick() {
    let editor = editor_at(0.0);
    let ghost = parse(&editor.interface_trail_ghost(&parse(&format!(r#"{{"target":{ORIGIN},"tick":12}}"#))).unwrap());
    assert_eq!(ghost.get("rx").and_then(Value::as_f64), Some(340.0));
    assert_eq!(ghost.get("ry").and_then(Value::as_f64), Some(130.0));
    let lines = ghost.get("lines").unwrap();
    assert_eq!(lines.array_len(), Some(3), "a limb of three segments");
    // It starts at the root.
    assert_eq!(&lines.item(0).unwrap().numbers().unwrap()[..2], &[340.0, 130.0]);
    // Another figure than the one asked for is not in it.
    let other = parse(&editor.interface_trail_ghost(&parse(r#"{"target":{"kind":"node","uid":99,"handleId":0},"tick":12}"#)).unwrap());
    assert!(other.is_null());
    assert!(parse(&editor.interface_trail_ghost(&parse(r#"{"target":{"kind":"camera"},"tick":12}"#)).unwrap()).is_null());
}

#[test]
fn trail_ticks_keep_the_ends_and_the_playhead_and_stay_inside_their_budget() {
    // Everything of a short animation.
    assert_eq!(plan_ticks(21.0, 7.0, 0.0, 21, &[]).len(), 21);
    // Bounded, whatever the length, with its ends and the playhead.
    let ticks = plan_ticks(50_000.0, 2345.0, 0.0, 100, &[]);
    assert!(ticks.len() <= 100);
    assert_eq!((ticks[0], *ticks.last().unwrap()), (0.0, 49_999.0));
    assert!(ticks.contains(&2345.0));
    // A key-heavy plan is bounded too, and takes a share of the keys.
    let keys: Vec<f64> = (1..5000).map(|key| f64::from(key) * 10.0).collect();
    let ticks = plan_ticks(50_000.0, 100.0, 0.0, 100, &keys);
    assert!(ticks.len() <= 100 && ticks.contains(&100.0));
    assert!(ticks.iter().filter(|tick| keys.contains(tick)).count() > 30);
    // A window either side of the playhead, which the ends of the animation cut.
    assert_eq!(plan_ticks(21.0, 10.0, 4.0, 1600, &[]), (6..=14).map(f64::from).collect::<Vec<_>>());
    assert_eq!(plan_ticks(21.0, 0.0, 4.0, 1600, &[])[0], 0.0);
    // Nothing to sample in an empty animation.
    assert!(plan_ticks(0.0, 0.0, 0.0, 100, &[]).is_empty());
}

fn onions(editor: &Editor, request: &str) -> std::sync::Arc<crate::OnionSet> {
    editor.onion_set(request).unwrap()
}

const SKINS: &str = r##""onionMode":"keyframes","onionBefore":1,"onionAfter":1,"onionStep":1,"onionRangeBefore":10,"onionRangeAfter":10,"onionScope":"all","onionJoined":true,"onionOpacity":0.4,"onionFade":true,"onionTint":true,"onionBeforeColor":"#e76b70","onionAfterColor":"#549de7","onionShowOnTop":false"##;

#[test]
fn each_layer_has_the_keys_either_side_of_the_playhead_as_its_onion_skins() {
    let editor = editor_at(15.0);
    let set = onions(&editor, &format!("{{{SKINS},\"hidden\":[]}}"));
    // Two layers, a key before (tick 12) and after (tick 20) each.
    let mut seen: Vec<(f64, Vec<u32>)> = set.ghosts.iter().map(|ghost| (ghost.tick, ghost.hidden.clone())).collect();
    seen.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
    // Figures 1 and 2 are on layer-1 (slots 0 and 1), 3 on layer-2 (slot 2): a skin of one layer hides the figures of the other.
    assert_eq!(seen, vec![(12.0, vec![0, 1]), (12.0, vec![2]), (20.0, vec![0, 1]), (20.0, vec![2])]);
    let before = set.ghosts.iter().find(|ghost| ghost.tick == 12.0).unwrap();
    let after = set.ghosts.iter().find(|ghost| ghost.tick == 20.0).unwrap();
    assert_eq!((before.tint, after.tint), (Some([0xe7, 0x6b, 0x70]), Some([0x54, 0x9d, 0xe7])));
    assert_eq!((before.opacity, before.show_on_top), (0.4, false));
    // A record per ghost is the document evaluated there.
    let slot = |ghost: &crate::Ghost| ghost.record.get("objects").unwrap().item(0).unwrap().get("root_x").and_then(Value::as_f64);
    assert_eq!((slot(before), slot(after)), (Some(340.0), Some(393.0 + 1.0 / 3.0)));
}

#[test]
fn the_skins_of_a_frame_are_one_set_until_something_they_depend_on_changes() {
    let mut editor = editor_at(15.0);
    let request = format!("{{{SKINS},\"hidden\":[]}}");
    let first = onions(&editor, &request);
    assert!(std::sync::Arc::ptr_eq(&first, &onions(&editor, &request)));
    editor.set_view(16.0, 0, Selection::default());
    let moved = onions(&editor, &request);
    assert!(!std::sync::Arc::ptr_eq(&first, &moved));
    // The same neighbours: their evaluated poses are the ones already made.
    assert!(first.ghosts[0].record.same_node(&moved.ghosts[0].record));
    let hidden = onions(&editor, &format!("{{{SKINS},\"hidden\":[1]}}"));
    assert!(hidden.ghosts.iter().all(|ghost| ghost.hidden.contains(&0)), "figure 1 (slot 0) is hidden in every skin");
}

#[test]
fn the_scope_of_the_selected_figures_takes_the_figures_joined_to_them() {
    let editor = editor_at(15.0);
    let selected = SKINS.replace(r#""onionScope":"all""#, r#""onionScope":"selected""#);
    let set = onions(&editor, &format!("{{{selected},\"hidden\":[],\"selected\":[2]}}"));
    // Only figure 2 (slot 1) is drawn, and only in the skins of its own layer.
    let mut seen: Vec<Vec<u32>> = set.ghosts.iter().map(|ghost| ghost.hidden.clone()).collect();
    seen.sort();
    // (The pose at tick 20 of the second layer holds figures 2 and 3 only.)
    assert_eq!(seen, vec![vec![0, 1], vec![0, 1, 2], vec![0, 2], vec![0, 2]]);
}

#[test]
fn every_tick_mode_takes_the_ticks_either_side_and_counts_stay_inside_the_animation() {
    let editor = editor_at(15.0);
    let frames = SKINS.replace(r#""onionMode":"keyframes""#, r#""onionMode":"frames""#).replace(r#""onionBefore":1,"onionAfter":1"#, r#""onionBefore":3,"onionAfter":2"#);
    let set = onions(&editor, &format!("{{{frames},\"hidden\":[]}}"));
    let mut ticks: Vec<f64> = set.ghosts.iter().map(|ghost| ghost.tick).collect();
    ticks.sort_by(f64::total_cmp);
    assert_eq!(ticks, vec![12.0, 13.0, 14.0, 16.0, 17.0]);
    // Far to near, fading with the distance.
    let order: Vec<f64> = set.ghosts.iter().map(|ghost| ghost.opacity).collect();
    assert!(order.windows(2).all(|pair| pair[0] <= pair[1]));
    // At the start there is nothing before.
    let start = editor_at(0.0);
    let at_start = onions(&start, &format!("{{{frames},\"hidden\":[]}}"));
    assert!(at_start.ghosts.iter().all(|ghost| ghost.tick > 0.0));
    // A count of zero removes that side.
    let none = onions(&editor, &format!("{{{},\"hidden\":[]}}", frames.replace(r#""onionBefore":3,"onionAfter":2"#, r#""onionBefore":0,"onionAfter":0"#)));
    assert!(none.ghosts.is_empty());
}

#[test]
fn the_camera_the_frame_on_show_is_seen_through_follows_the_camera_motion() {
    let editor = editor_at(15.0);
    let shot = parse(&editor.interface_camera("shot", &Value::Null).unwrap());
    let authored = parse(&editor.interface_camera("frameCamera", &parse(r#"{"tick":15}"#)).unwrap());
    assert!(!shot.is_null());
    // Follow clips and a shake move the shot from where the frame has it.
    assert_ne!(shot.get("x").and_then(Value::as_f64), authored.get("x").and_then(Value::as_f64));
    let still = editor_at(40.0);
    let late = parse(&still.interface_camera("shot", &Value::Null).unwrap());
    assert_eq!(late.get("x").and_then(Value::as_f64).unwrap_or(0.0), authored.get("x").and_then(Value::as_f64).unwrap_or(0.0), "past the clips nothing moves it");
}

#[test]
fn a_clip_is_sampled_alone_as_a_preset_impulse_or_a_follow_path() {
    let editor = editor_at(0.0);
    let clips = document().path(&["_styk", "cameraMotion", "clips"]).unwrap().clone();
    let (follow, shake) = (clips.item(0).unwrap(), clips.item(1).unwrap());
    let ask = |clip: &Value, ticks: &str| {
        let args = parse(&format!(r#"{{"clip":{},"ticks":{ticks}}}"#, styk_doc::json::to_string(clip)));
        parse(&editor.interface_camera("cameraSamples", &args).unwrap()).numbers().unwrap()
    };
    // The shake outside its clip is nothing.
    assert_eq!(ask(&shake, "[0, 30]"), vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]);
    // Inside it, the impulse the evaluation adds to the shot.
    let clip = styk_eval::load::camera_motion_clip(&shake).unwrap();
    let impulse = styk_eval::camera::impulse(&[clip], 14.0, 24.0).unwrap();
    assert_eq!(ask(&shake, "[14]"), vec![impulse.x, impulse.y, impulse.rotation, impulse.zoom]);
    // A follow clip moves the camera toward its figures inside its span, and nothing outside it.
    let samples = ask(&follow, "[0, 1, 20]");
    assert_eq!(&samples[..8], &[0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]);
    assert!(samples[8].abs() + samples[9].abs() > 0.0, "{samples:?}");
    // Asking again is the same answer.
    assert_eq!(ask(&follow, "[0, 1, 20]"), samples);
}

#[test]
fn the_framing_that_keeps_the_followed_figures_where_they_stand_is_read_from_the_frame_on_show() {
    let editor = editor_at(0.0);
    let offset = parse(&editor.interface_camera("framing", &parse(r#"{"targets":[{"uid":1,"weight":1}]}"#)).unwrap());
    // Figure 1 stands left of the middle of the canvas at tick 0.
    assert!(offset.get("x").and_then(Value::as_f64).unwrap() < 0.0);
    // A figure that is not in the frame leaves nothing to frame.
    assert!(parse(&editor.interface_camera("framing", &parse(r#"{"targets":[{"uid":99,"weight":1}]}"#)).unwrap()).is_null());
    assert!(parse(&editor.interface_camera("framing", &parse(r#"{"targets":[{"uid":1,"weight":0}]}"#)).unwrap()).is_null());
}

/** The document with `layer-1` a drawing layer whose exposures are `keys` (JSON) until `end`. */
fn drawing_editor(keys: &str, end: u32, tick: f64) -> Editor {
    let mut report = document();
    let styk = report.make_obj().unwrap().get_mut("_styk").unwrap().make_obj().unwrap();
    styk.get_mut("layerSheet").unwrap().make_obj().unwrap().get_mut("tracks").unwrap().make_obj().unwrap().set("layer-1", parse(&format!(r#"{{"end":{end},"keys":{keys}}}"#)));
    styk.get_mut("layers").unwrap().make_obj().unwrap().get_mut("byId").unwrap().make_obj().unwrap().get_mut("layer-1").unwrap().make_obj().unwrap().set("drawing", parse(r#"{"version":1}"#));
    let mut editor = Editor::new(report, Options { property_channels: true, layer_timeline: true, auto_key: false });
    editor.set_view(tick, 0, Selection::default());
    editor
}

/** `[direction, tick, distance]` of the drawings shown on a drawing layer. */
fn drawing_samples(editor: &Editor, settings: &str) -> Vec<(i32, f64, f64)> {
    let settings = crate::onion_skins::Settings::parse(&parse(settings)).unwrap();
    editor.drawing_candidates(&settings).into_iter().map(|sample| (sample.direction, sample.tick, sample.distance)).collect()
}

const DRAWINGS: &str = r#""onionMode":"keyframes","onionBefore":2,"onionAfter":2,"onionStep":1"#;

#[test]
fn a_drawing_layer_shows_the_drawings_around_the_one_on_screen_and_not_that_one() {
    let editor = drawing_editor(r#"[{"tick":0,"value":{"frameId":"frame-3"}},{"tick":5,"value":{"frameId":"frame-2"}}]"#, 10, 7.0);
    assert_eq!(drawing_samples(&editor, &format!("{{{DRAWINGS}}}")), vec![(-1, 0.0, 1.0)], "the drawing held under the playhead is skipped");
    assert!(drawing_samples(&editor, &format!("{{{}}}", DRAWINGS.replace("keyframes", "frames"))).is_empty(), "every-tick sampling is not of drawings");
}

#[test]
fn blank_exposures_are_skipped_instead_of_using_up_the_range_and_the_last_drawing_is_the_nearest_past_the_end() {
    let keys = r#"[{"tick":0,"value":{"frameId":"frame-3"}},{"tick":1,"value":{"frameId":null}},{"tick":2,"value":{"frameId":"frame-2"}},{"tick":3,"value":{"frameId":null}},{"tick":4,"value":{"frameId":null}}]"#;
    let samples = |tick: f64, settings: &str| drawing_samples(&drawing_editor(keys, 6, tick), &format!("{{{settings}}}"));
    assert_eq!(samples(4.0, DRAWINGS), vec![(-1, 2.0, 1.0), (-1, 0.0, 2.0)]);
    assert_eq!(samples(1.0, DRAWINGS), vec![(-1, 0.0, 1.0), (1, 2.0, 1.0)]);
    // The layer ends at tick 3: from there on the nearest drawing before is the last one.
    let short = r#"[{"tick":0,"value":{"frameId":"frame-3"}},{"tick":1,"value":{"frameId":null}},{"tick":2,"value":{"frameId":"frame-2"}}]"#;
    let past = |tick: f64, settings: &str| drawing_samples(&drawing_editor(short, 3, tick), &format!("{{{settings}}}"));
    assert_eq!(past(5.0, DRAWINGS), vec![(-1, 2.0, 1.0), (-1, 0.0, 2.0)]);
    assert_eq!(past(2.0, DRAWINGS), vec![(-1, 0.0, 1.0)]);
    assert_eq!(past(5.0, &DRAWINGS.replace("\"onionStep\":1", "\"onionStep\":2")), vec![(-1, 2.0, 1.0)]);
}

#[test]
fn the_range_of_a_drawing_layer_is_a_distance_in_ticks_whatever_the_counts() {
    let editor = drawing_editor(r#"[{"tick":0,"value":{"frameId":"frame-3"}},{"tick":5,"value":{"frameId":"frame-2"}},{"tick":8,"value":{"frameId":"frame-4"}}]"#, 10, 5.0);
    let settings = r#""onionMode":"keyframes","onionStep":2,"onionBefore":0,"onionAfter":0"#;
    assert_eq!(drawing_samples(&editor, &format!("{{{settings},\"onionRangeBefore\":5,\"onionRangeAfter\":3}}")).iter().map(|sample| sample.1).collect::<Vec<_>>(), vec![0.0, 8.0]);
    assert!(drawing_samples(&editor, &format!("{{{settings},\"onionRangeBefore\":4,\"onionRangeAfter\":2}}")).is_empty());
}
