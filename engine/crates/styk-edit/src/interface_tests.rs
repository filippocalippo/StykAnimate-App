//! What the interface reads of the frame on show (`interface.rs`): the geometry of a recorded document
//! is complete and consistent, a gesture changes only the groups of the figures it moves, and the
//! frame and timeline are the ones the editor shows.
use std::path::Path;

use styk_doc::Value;

use crate::session::Session;

fn parse(text: &str) -> Value {
    styk_doc::json::parse(text.as_bytes()).unwrap()
}

fn json(value: &Value) -> String {
    styk_doc::json::to_string(value)
}

/// The session a recorded tape starts from, and the steps that follow its first.
fn tape(name: &str) -> (Session, Vec<Value>) {
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../tests/edit/{name}.reference.json"));
    let reference = parse(&std::fs::read_to_string(file).unwrap());
    let steps: Vec<Value> = reference.get("steps").unwrap().elements().unwrap().iter().collect();
    let mut state = steps[0].get("state").unwrap().as_obj().unwrap().clone();
    for (key, value) in reference.get("editor").unwrap().as_obj().unwrap().iter() {
        state.set(key, value.clone());
    }
    let session = Session::start(parse(steps[0].get("document").unwrap().as_str().unwrap()), &json(&Value::object(state))).unwrap();
    (session, steps)
}

/// The view a call of `session` is made with.
fn view(session: &Session) -> String {
    let mut view = session.editor.state_value().as_obj().unwrap().clone();
    view.set("autoKey", Value::Bool(session.editor.auto_key));
    json(&Value::object(view))
}

fn run(session: &mut Session, step: &Value) {
    let call: Vec<Value> = step.get("call").unwrap().elements().unwrap().iter().collect();
    let method = call[0].as_str().unwrap();
    let args = json(&Value::array(call[1..].to_vec()));
    let answer = parse(&session.call(method.trim_start_matches('@'), &args, &view(session)));
    assert_ne!(answer.get("status").and_then(Value::as_str), Some("unported"), "{method}: {answer:?}");
}

fn geometry(session: &mut Session, since: Option<f64>) -> Value {
    let args = match since {
        Some(token) => format!("{{\"since\":{token}}}"),
        None => "{}".to_string(),
    };
    let view = view(session);
    parse(&session.query("geometry", &args, &view).unwrap())
}

fn slots_of(read: &Value) -> Vec<usize> {
    read.get("slots").unwrap().elements().unwrap().iter().map(|pair| pair.item(0).unwrap().as_f64().unwrap() as usize).collect()
}

fn group(read: &Value, slot: usize) -> Value {
    read.get("slots").unwrap().elements().unwrap().iter().find(|pair| pair.item(0).unwrap().as_f64().unwrap() as usize == slot).unwrap().item(1).unwrap()
}

fn point(value: &Value) -> [f64; 2] {
    [value.item(0).unwrap().as_f64().unwrap(), value.item(1).unwrap().as_f64().unwrap()]
}

/// The numbers of a row of a group's `segs`.
fn row(shape: &Value) -> Vec<f64> {
    shape.elements().unwrap().iter().map(|value| value.as_f64().unwrap_or(f64::NAN)).collect()
}

#[test]
fn a_full_read_holds_every_segment_and_joint_of_each_figure_in_the_frame() {
    for name in ["gestures-sheet", "rig-sheet", "startup-sheet"] {
        let (mut session, _) = tape(name);
        let read = geometry(&mut session, None);
        assert_eq!(read.get("full"), Some(&Value::Bool(true)), "{name}");
        let objects = session.editor.shown_frame().unwrap().get("objects").unwrap().elements().unwrap().len();
        assert_eq!(slots_of(&read), (0..objects).collect::<Vec<_>>(), "{name}: every figure has a group");
        let record = session.editor.shown_frame().unwrap();
        for slot in 0..objects {
            let g = group(&read, slot);
            let figure_type = record.get("objects").unwrap().item(slot).unwrap().get("figure_type_id").and_then(Value::as_f64).unwrap();
            let definition = session.report().get("figure_types").unwrap().elements().unwrap().iter().find(|f| f.get("figure_type_id").and_then(Value::as_f64) == Some(figure_type)).unwrap();
            let segments = definition.get("segments").unwrap().elements().unwrap();
            let ids: Vec<f64> = segments.iter().map(|s| s.get("segment_id").and_then(Value::as_f64).unwrap()).collect();
            let ends: Vec<f64> = g.get("ends").unwrap().elements().unwrap().iter().map(|value| value.as_f64().unwrap_or(f64::NAN)).collect();
            assert_eq!(ends.len(), 2 * ids.len(), "{name} slot {slot}: a joint for every segment");
            let rows = g.get("segs").unwrap().elements().unwrap();
            assert_eq!(rows.len(), ids.len(), "{name} slot {slot}: a row for every segment, drawn or not");
            let joint = |index: usize| [ends[2 * index], ends[2 * index + 1]];
            for (i, shape) in rows.iter().enumerate() {
                let row = row(&shape);
                assert_eq!(row[0], i as f64, "the segment's place in the figure");
                let flags = row[11] as u32;
                // A segment is drawn to its joint and starts where its parent ends (or at the root), unless the row says otherwise.
                let mut at = 12;
                let parent = segments.get(i).unwrap().get("parent_id").and_then(Value::as_f64).unwrap();
                let origin = if parent == 0.0 { point(g.get("root").unwrap()) } else { joint(ids.iter().position(|id| *id == parent).unwrap()) };
                let start = if flags & 1 != 0 { at += 2; [row[at - 2], row[at - 1]] } else { origin };
                let end = if flags & 2 != 0 { at += 2; [row[at - 2], row[at - 1]] } else { joint(i) };
                if flags & 8 == 0 {
                    assert_eq!(flags & 2, 0, "{name} slot {slot} segment {i}: only a connector is drawn to somewhere but its joint");
                }
                assert!(start[0].is_finite() && end[0].is_finite() && row[3].is_finite(), "{name} slot {slot} segment {i}: finite");
                assert_eq!(flags & 4 != 0, shape.elements().unwrap().iter().any(|value| value.is_array()), "{name} slot {slot} segment {i}: a curve is its own array");
            }
        }
        assert_eq!(read.get("warnings").and_then(Value::array_len), Some(0), "{name}");
    }
}

/// The numbers of an array of a group (`null` is NaN).
fn numbers(value: &Value) -> Vec<f64> {
    value.elements().unwrap().iter().map(|number| number.as_f64().unwrap_or(f64::NAN)).collect()
}

#[test]
fn a_figure_in_perspective_sends_what_its_joints_and_starts_are_before_the_camera() {
    let (mut session, _) = tape("ik-spatial-perspective-target-sheet");
    let read = geometry(&mut session, None);
    let g = group(&read, 0);
    let (ends, raws, starts) = (numbers(g.get("ends").unwrap()), numbers(g.get("raws").expect("raws")), numbers(g.get("startRaws").expect("startRaws")));
    assert_eq!(raws.len(), 3 * ends.len() / 2, "a triple for every place in the figure");
    assert_eq!(starts.len(), raws.len());
    // The tape's camera: strength 0.7 at distance 400 about (240, 160), the figure at scale 1.
    let project = |raw: &[f64]| {
        let d = (1.0 - 0.7 / 400.0 * raw[2]).max(0.05);
        [240.0 + (raw[0] - 240.0) / d, 160.0 + (raw[1] - 160.0) / d]
    };
    let mut seen = 0;
    for (i, raw) in raws.chunks(3).enumerate() {
        if raw[0].is_nan() {
            continue;
        }
        seen += 1;
        let [x, y] = project(raw);
        // A joint is stored as a 32-bit float.
        assert!((x - ends[2 * i]).abs() < 1e-3 && (y - ends[2 * i + 1]).abs() < 1e-3, "joint {i} is its raw point seen through the camera: {x},{y} against {},{}", ends[2 * i], ends[2 * i + 1]);
    }
    assert!(seen > 0, "the bones of a 3D figure have raw points");
    assert!(starts.chunks(3).any(|raw| !raw[0].is_nan()), "and raw starts");
    // A flat pose sends none.
    let (mut flat, _) = tape("channels-pose-sheet");
    let read = geometry(&mut flat, None);
    for slot in slots_of(&read) {
        let g = group(&read, slot);
        assert!(g.get("raws").is_none() && g.get("startRaws").is_none(), "slot {slot}: no camera, no raw points");
    }
}

#[test]
fn a_mesh_is_measured_by_its_faces_attached_to_a_figure_or_not() {
    let (mut session, _) = tape("spatial-clip-mesh-sheet");
    let read = geometry(&mut session, None);
    for slot in [1, 2] {
        let bounds = numbers(group(&read, slot).get("bounds").expect("bounds"));
        assert!(bounds[2] - bounds[0] > 2.0 && bounds[3] - bounds[1] > 2.0, "slot {slot}: the faces give the object its extent, not the handle that paints nothing: {bounds:?}");
    }
}

/// A call of the session by hand.
fn call(session: &mut Session, method: &str, args: &str) {
    let answer = parse(&session.call(method, args, &view(session)));
    assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"), "{method}: {}", json(&answer));
}

/// The slots a gesture that moves figure `uid` changes in a read that follows a full one, in the tape of
/// figures 1 and 2 with 3 hanging from 2, and 4 alone (the second read, and the full one after it).
fn moved_by(uid: u32) -> (Vec<u32>, Vec<usize>, Value, Value, Value) {
    let (mut session, _) = tape("channels-pose-sheet");
    call(&mut session, "seek", "[11]");
    call(&mut session, "select", &format!("[{uid},-1]"));
    let first = geometry(&mut session, None);
    let token = first.get("token").and_then(Value::as_f64).unwrap();
    // Nothing changed: nothing to send.
    let same = geometry(&mut session, Some(token));
    assert!(slots_of(&same).is_empty(), "an unchanged frame sends no group");
    assert_eq!(same.get("full"), Some(&Value::Bool(false)));
    let token = same.get("token").and_then(Value::as_f64).unwrap();
    call(&mut session, "beginTranslationDrag", "[]");
    call(&mut session, "moveSelection", "[12,0,{\"fromStart\":true}]");
    assert!(session.editor.authored.is_some(), "the gesture is open");
    let moved = geometry(&mut session, Some(token));
    assert_eq!(moved.get("full"), Some(&Value::Bool(false)));
    let full = geometry(&mut session, None);
    // A read that does not hold the previous one is whole.
    let stale = geometry(&mut session, Some(12345.0));
    assert_eq!(stale.get("full"), Some(&Value::Bool(true)));
    let mut slots = slots_of(&moved);
    slots.sort();
    let shown = session.editor.shown_frame().unwrap();
    let mut uids: Vec<u32> = slots.iter().map(|&slot| shown.get("objects").unwrap().item(slot).unwrap().get("unique_id").and_then(Value::as_f64).unwrap() as u32).collect();
    uids.sort();
    (uids, slots, first, moved, full)
}

#[test]
fn a_later_read_names_only_the_figures_a_gesture_moved() {
    let (uids, slots, first, moved, full) = moved_by(4);
    assert_eq!(uids, vec![4], "only the figure the gesture moves");
    // Its group is the one a full read now gives, and has moved.
    assert_eq!(json(&group(&moved, slots[0])), json(&group(&full, slots[0])));
    assert_ne!(json(&group(&first, slots[0])), json(&group(&full, slots[0])));
}

#[test]
fn a_figure_hanging_from_another_moves_with_it_in_the_next_read() {
    // Moving 3 moves what it hangs from and everything joined to that.
    let (uids, slots, _, moved, full) = moved_by(3);
    assert_eq!(uids, vec![2, 3], "the joined figures, and no others");
    for slot in slots {
        assert_eq!(json(&group(&moved, slot)), json(&group(&full, slot)));
    }
}

#[test]
fn the_frame_on_show_is_the_document_at_the_playhead_until_a_gesture_drafts_it() {
    let (mut session, steps) = tape("gestures-sheet");
    let begin = steps.iter().position(|step| step.get("call").and_then(|c| c.item(0)).and_then(|m| m.as_str().map(str::to_string)).as_deref() == Some("beginDrag")).unwrap();
    for step in &steps[1..begin] {
        run(&mut session, step);
    }
    let query = |session: &mut Session, kind: &str| {
        let view = view(session);
        session.query(kind, "{}", &view).unwrap()
    };
    let before = query(&mut session, "frame");
    assert_eq!(before, query(&mut session, "document"), "with no gesture the frame is the document's");
    assert_eq!(before, json(&session.editor.shown_frame().unwrap()));
    for step in &steps[begin..begin + 2] {
        run(&mut session, step);
    }
    let drafted = query(&mut session, "frame");
    assert_ne!(drafted, before, "the draft shows the pose being made");
    assert_eq!(query(&mut session, "document"), before, "the document's frame stays what the draft is composed on");
    assert_eq!(query(&mut session, "motion"), "null", "no motion-path edit is open");
}

#[test]
fn the_timeline_is_one_start_and_count_per_row() {
    let (mut session, _) = tape("gestures-sheet");
    let view = view(&session);
    let rows = parse(&session.query("timeline", "{}", &view).unwrap());
    let rows = rows.elements().unwrap();
    assert!(rows.len() > 1);
    let mut start = 0.0;
    for row in rows.iter() {
        assert_eq!(row.item(0).and_then(|v| v.as_f64()), Some(start));
        start += row.item(1).and_then(|v| v.as_f64()).unwrap();
    }
    assert!(session.query("elsewhere", "{}", &view).is_err());
}

/// What the session answers to a read of the editor's own, as `{"v": value}` text (or `{}`).
fn read(session: &mut Session, name: &str, args: &str) -> Value {
    let view = view(session);
    parse(&session.query(name, args, &view).unwrap_or_else(|error| panic!("{name}: {error}")))
}

#[test]
fn the_values_the_interface_shows_are_read_from_the_frame_on_show() {
    let (mut session, _) = tape("channels-pose-sheet");
    call(&mut session, "seek", "[11]");
    let shown = session.editor.shown_frame().unwrap();
    let figure = |uid: u32| shown.get("objects").unwrap().elements().unwrap().iter().find(|o| o.get("unique_id").and_then(Value::as_f64) == Some(uid as f64)).unwrap();
    // A property at the playhead is the frame's own value, at another tick the document's there.
    let x = read(&mut session, "animationValue", r#"[{"kind":"figure","uid":4},"x"]"#);
    assert_eq!(x.get("v").and_then(Value::as_f64), figure(4).get("root_x").and_then(Value::as_f64));
    let camera = read(&mut session, "animationValue", r#"[{"kind":"camera"},"x"]"#);
    assert_eq!(camera.get("v").and_then(Value::as_f64), shown.get("camera").and_then(|c| c.get("x")).and_then(Value::as_f64));
    let later = read(&mut session, "animationValue", r#"[{"kind":"figure","uid":4},"x",13]"#);
    assert!(later.get("v").and_then(Value::as_f64).is_some(), "the document at another tick has its own value");
    // A figure that is not there has no value: the editor answers undefined.
    assert_eq!(json(&read(&mut session, "animationValue", r#"[{"kind":"figure","uid":999},"x"]"#)), "{}");
    // A tick the document does not have is refused with the editor's message.
    let at = view(&session);
    assert_eq!(session.query("animationValue", r#"[{"kind":"figure","uid":4},"x",-1]"#, &at).unwrap_err(), "errors.editorAnimation.keyframeTimeMustBeAnIntegerFrom0");
    // The target of a segment's property is its figure, handle and nothing more on a layer sheet.
    assert_eq!(json(&read(&mut session, "segmentAnimationTarget", r#"[4,2,"x"]"#)), r#"{"v":{"kind":"segment","uid":4,"handleId":2}}"#);
    // No effect yet: an empty stack; one added shows in its target's.
    call(&mut session, "select", "[4,-1]");
    assert_eq!(json(&read(&mut session, "vfxEffects", r#"[{"kind":"figure","uid":4}]"#)), r#"{"v":[]}"#);
    // The identity the effect takes is one the editor drew and hands over with the call.
    let mut drawn = parse(&view(&session));
    drawn.make_obj().unwrap().set("draws", parse(r#"[["uuid","8a3c2f10-5c3b-4d4e-9d0a-6b2f1e7c9a11"],["seed",7],["random",0.5]]"#));
    drawn.make_obj().unwrap().set("drawPool", Value::Bool(true));
    let answer = parse(&session.call("addVfx", r#"[[{"kind":"figure","uid":4}],"glow"]"#, &json(&drawn)));
    assert_eq!(answer.get("status").and_then(Value::as_str), Some("ok"), "{}", json(&answer));
    let stack = read(&mut session, "vfxEffects", r#"[{"kind":"figure","uid":4}]"#);
    assert_eq!(stack.get("v").unwrap().elements().unwrap().len(), 1);
    assert_eq!(stack.get("v").unwrap().item(0).unwrap().get("type").and_then(Value::as_str), Some("glow"));
    let at = view(&session);
    assert!(session.query("elsewhere", "[]", &at).unwrap_err().contains("answers no read"));
}

#[test]
fn the_paint_of_a_segment_without_a_style_override_is_the_segment_own() {
    let (mut session, _) = tape("channels-pose-sheet");
    call(&mut session, "seek", "[11]");
    let figure = session.editor.report().get("figure_types").unwrap().elements().unwrap().iter().find(|f| f.get("figure_type_id").and_then(Value::as_f64) == Some(4.0)).unwrap();
    let segment = figure.get("segments").unwrap().item(0).unwrap();
    let handle = segment.get("segment_id").and_then(Value::as_f64).unwrap();
    let opacity = 1.0 - segment.get("transparency").and_then(Value::as_f64).unwrap_or(0.0) / 255.0;
    let painted = read(&mut session, "animationValue", &format!(r#"[{{"kind":"segment","uid":4,"handleId":{handle}}},"paint"]"#));
    let paint = painted.get("v").unwrap_or_else(|| panic!("{}", json(&painted)));
    assert_eq!(paint.get("angle").and_then(Value::as_f64), Some(0.0));
    let stop = paint.get("stops").unwrap().item(0).unwrap();
    assert_eq!(stop.get("offset").and_then(Value::as_f64), Some(0.0));
    assert_eq!(stop.get("color"), segment.get("color_rgb"));
    assert_eq!(stop.get("opacity").and_then(Value::as_f64), Some(opacity));
    assert_eq!(paint.get("type").and_then(Value::as_str), Some(if segment.get("secondary").is_some_and(Value::truthy) { "linear" } else { "solid" }));
}

#[test]
fn the_settings_of_a_controller_are_the_defaults_over_what_the_node_has() {
    let (mut session, _) = tape("channels-pose-sheet");
    call(&mut session, "seek", "[11]");
    // Nothing selected below the figure: no node, no chain.
    call(&mut session, "select", "[4,-1]");
    let none = read(&mut session, "getIKSettings", "[]");
    assert_eq!(json(none.get("v").unwrap()), r#"{"enabled":false,"pinned":false,"allowStretch":false,"bendDirection":0,"chainLength":0,"maxLength":0}"#);
    // A node of an unjoined figure: a chain of two where there are two bones, and the longest it can have.
    call(&mut session, "select", "[4,0]");
    let node = read(&mut session, "getIKSettings", "[]");
    let node = node.get("v").unwrap();
    assert_eq!(node.get("enabled"), Some(&Value::Bool(false)));
    let longest = node.get("maxLength").and_then(Value::as_f64).unwrap();
    assert!(longest >= 1.0);
    assert_eq!(node.get("chainLength").and_then(Value::as_f64), Some(longest.min(2.0)));
    // A node of a figure with others joined to it: the chain it can have runs across the assembly.
    call(&mut session, "select", "[2,0]");
    let joined = read(&mut session, "getIKSettings", "[]");
    let joined = joined.get("v").unwrap();
    let across = joined.get("maxLength").and_then(Value::as_f64).unwrap();
    assert!(across >= 1.0);
    assert_eq!(joined.get("chainLength").and_then(Value::as_f64), Some(across.min(2.0)));
}

#[test]
fn a_bone_reads_back_the_rotation_it_was_given() {
    let (mut session, _) = tape("spatial-turn-sheet");
    // No bone is selected: nothing to read.
    let none = read(&mut session, "getSpatialPose", "[]");
    assert_eq!(none.get("v"), Some(&Value::Null), "{}", json(&none));
    call(&mut session, "select", "[1,5]");
    let rest = read(&mut session, "getSpatialPose", "[]");
    let rest = rest.get("v").unwrap();
    assert!(["bend", "turn", "pitch"].iter().all(|key| rest.get(key).and_then(Value::as_f64).is_some_and(f64::is_finite)), "{}", json(rest));
    call(&mut session, "setSpatialPose", r#"[{"turn":0.3,"pitch":-0.2,"bend":0.1}]"#);
    let turned = read(&mut session, "getSpatialPose", "[]");
    let turned = turned.get("v").unwrap();
    for (key, expected) in [("turn", 0.3), ("pitch", -0.2), ("bend", 0.1)] {
        let got = turned.get(key).and_then(Value::as_f64).unwrap();
        assert!((got - expected).abs() < 1e-9, "{key}: {got} != {expected}");
    }
    // A joint named by the call is read instead of the selected one; one that is not a bone reads nothing.
    let named = read(&mut session, "getSpatialPose", "[5]");
    assert_eq!(json(named.get("v").unwrap()), json(turned));
    let missing = read(&mut session, "getSpatialPose", "[999]");
    assert_eq!(missing.get("v"), Some(&Value::Null));
    // A bone that is not a mechanism has no travel.
    let motion = read(&mut session, "getSpatialMotion", "[]");
    assert_eq!(motion.get("v"), Some(&Value::Null));
}

#[test]
fn a_mechanical_joint_reads_its_travel_between_the_ends_of_its_range() {
    let (mut session, _) = tape("spatial-mechanism-sheet");
    call(&mut session, "select", "[1,8]");
    call(&mut session, "setSpatialMotion", r#"[0.25,{"fraction":true}]"#);
    let read_motion = read(&mut session, "getSpatialMotion", "[]");
    let motion = read_motion.get("v").unwrap();
    assert!(matches!(motion.get("type").and_then(Value::as_str), Some("slide" | "hinge")), "{}", json(motion));
    let (min, max, value, driver, applied) = ["min", "max", "value", "driver", "applied"].map(|key| motion.get(key).and_then(Value::as_f64).unwrap()).into();
    assert!(max > min);
    assert!(((value - min) / (max - min) - 0.25).abs() < 1e-9, "{}", json(motion));
    assert!((motion.get("fraction").and_then(Value::as_f64).unwrap() - 0.25).abs() < 1e-9);
    assert!((applied - driver - value).abs() < 1e-9, "the travel is the applied value less its driver's share");
    // A joint that is not a mechanism has none.
    call(&mut session, "select", "[1,5]");
    assert_eq!(read(&mut session, "getSpatialMotion", "[]").get("v"), Some(&Value::Null));
}

#[test]
fn a_clip_is_sampled_at_the_playhead_through_its_keys() {
    let (mut session, steps) = tape("vfx-clips-sheet");
    // The tape keys the tint clip's mix and colour at tick 4 (steps 1-21 set it up), then moves them.
    for step in &steps[1..=21] {
        let call: Vec<Value> = step.get("call").unwrap().elements().unwrap().iter().collect();
        let method = call[0].as_str().unwrap().trim_start_matches('@').to_string();
        let args = json(&Value::array(call[1..].to_vec()));
        let view = view(&session);
        session.call(&method, &args, &view);
    }
    let clip = session.editor.report().path(&["_styk", "vfxClips", "clips"]).unwrap().elements().unwrap().iter().find(|c| c.get("id").and_then(Value::as_str) == Some("clip-tint")).unwrap();
    let keys = clip.path(&["keys", "vfx1:tint:fx-tint:mix"]).unwrap_or_else(|| panic!("{}", json(&clip)));
    let first = keys.item(0).unwrap();
    let (start, offset) = (clip.get("start").and_then(Value::as_f64).unwrap(), clip.get("offset").and_then(Value::as_f64).unwrap());
    let at = start - offset + first.get("tick").and_then(Value::as_f64).unwrap();
    let expected = first.get("value").and_then(Value::as_f64).unwrap();
    let mix = |session: &mut Session, tick: f64| {
        let sampled = read(session, "sampleVfxClip", &format!(r#"["clip-tint",{tick}]"#));
        let effects = sampled.get("v").unwrap_or_else(|| panic!("{}", json(&sampled))).clone();
        let tint = effects.elements().unwrap().iter().find(|e| e.get("id").and_then(Value::as_str) == Some("fx-tint")).unwrap();
        tint.path(&["params", "mix"]).and_then(Value::as_f64).unwrap()
    };
    assert!((mix(&mut session, at) - expected).abs() < 1e-12, "the keyed value at its key");
    // One key holds before and after it.
    assert!((mix(&mut session, at + 5.0) - expected).abs() < 1e-12 || keys.array_len().unwrap() > 1);
    assert!((mix(&mut session, 0.0) - expected).abs() < 1e-12 || keys.array_len().unwrap() > 1, "before the first key the first key holds");
    // The glow's radius is keyed too (step 15): sampled it is the key's, and everything else stays as stored.
    let glow = read(&mut session, "sampleVfxClip", r#"["clip-glow",4]"#);
    let stored = session.editor.report().path(&["_styk", "vfxClips", "clips"]).unwrap().elements().unwrap().iter().find(|c| c.get("id").and_then(Value::as_str) == Some("clip-glow")).unwrap().get("effects").unwrap().item(0).unwrap();
    let sampled = glow.get("v").unwrap().item(0).unwrap();
    assert_eq!(stored.path(&["params", "radius"]).and_then(Value::as_f64), Some(12.0));
    assert_eq!(sampled.path(&["params", "radius"]).and_then(Value::as_f64), Some(30.0));
    let mut expected = stored.as_obj().unwrap().clone();
    let mut params = expected.get("params").and_then(Value::as_obj).cloned().unwrap();
    params.set("radius", Value::Num(30.0));
    expected.set("params", Value::object(params));
    assert_eq!(json(&sampled), json(&Value::object(expected)));
    // No such clip.
    let error = session.query("sampleVfxClip", r#"["nope",4]"#, &view(&session)).unwrap_err();
    assert_eq!(error, "errors.editorVfxClips.selectAnEffectClip");
}

#[test]
fn a_frame_with_a_figure_the_document_lacks_has_its_geometry_read_against_that_figure() {
    let (mut session, _) = tape("startup-sheet");
    let record = session.editor.shown_frame().unwrap();
    let objects: Vec<Value> = record.get("objects").unwrap().elements().unwrap().iter().collect();
    let layer = session.report().path(&["_styk", "layers", "order"]).unwrap().item(0).unwrap().as_str().unwrap().to_string();
    // A copy of the first figure's definition under a new type, and an object of it that the frame does not hold.
    let mut figure = session.report().get("figure_types").unwrap().item(0).unwrap().as_obj().unwrap().clone();
    figure.set("figure_type_id", Value::Num(99.0));
    let mut object = objects[0].as_obj().unwrap().clone();
    let root_x = object.get("root_x").and_then(Value::as_f64).unwrap() + 123.0;
    object.set("unique_id", Value::Num(99.0));
    object.set("figure_type_id", Value::Num(99.0));
    object.set("root_x", Value::Num(root_x));
    object.set("object_slot", Value::Num(objects.len() as f64));
    object.set("join", Value::Null);
    let mut frame = record.as_obj().unwrap().clone();
    let mut with = objects.clone();
    with.push(Value::object(object));
    frame.set("objects", Value::array(with));
    frame.remove("object_draw_order");
    frame.remove("object_draw_order_unique_ids");
    let mut request = styk_doc::Obj::new();
    request.set("frame", Value::object(frame));
    request.set("figure", Value::object(figure));
    request.set("uid", Value::Num(99.0));
    request.set("layerId", Value::str(&layer));
    let read = read(&mut session, "previewGeometry", &json(&Value::object(request)));
    assert_eq!(read.get("full"), Some(&Value::Bool(true)));
    assert_eq!(read.get("count").and_then(Value::as_f64), Some(objects.len() as f64 + 1.0));
    assert_eq!(slots_of(&read), (0..=objects.len()).collect::<Vec<_>>());
    let preview = group(&read, objects.len());
    assert_ne!(preview, Value::Null, "the figure the document does not hold yet has geometry");
    assert_eq!(point(preview.get("root").unwrap())[0], root_x);
    // The document itself is untouched: its read has the figures it had.
    let own = geometry(&mut session, None);
    assert_eq!(own.get("count").and_then(Value::as_f64), Some(objects.len() as f64));
}

/// An effect clip record, as the timeline holds one.
fn clip_record(id: &str, effect: &str, start: f64, duration: Option<f64>) -> String {
    let duration = duration.map_or("null".to_string(), |duration| duration.to_string());
    format!(
        r#"{{"id":"{id}","name":"","target":{{"kind":"scene"}},"start":{start},"duration":{duration},"offset":0,"enabled":true,"strength":1,"fadeIn":0,"fadeOut":0,"includeAttached":false,"effects":[{{"version":2,"type":"{effect}","id":"fx-{id}","enabled":true,"params":{{}}}}],"keys":{{}}}}"#
    )
}

#[test]
fn a_generated_clip_plays_after_its_end_while_its_particles_last_and_a_filter_does_not() {
    let (mut session, _) = tape("vfx-clips-sheet");
    let (boom, glow) = (clip_record("boom", "explosion", 0.0, Some(10.0)), clip_record("glow", "glow", 0.0, Some(10.0)));
    let query = |session: &mut Session, clips: &[&str], tick: f64| read(session, "vfxClips", &format!(r#"{{"clips":[{}],"tick":{tick}}}"#, clips.join(",")));
    // Particles outlive the clip by their longest life; a filter ends with its clip.
    let views = query(&mut session, &[&boom, &glow], 15.0);
    let (boom_view, glow_view) = (views.item(0).unwrap(), views.item(1).unwrap());
    let tail = boom_view.get("tail").and_then(Value::as_f64).unwrap();
    assert!(tail > 30.0, "an explosion's particles last: {tail}");
    assert_eq!(boom_view.get("plays"), Some(&Value::Bool(true)));
    assert_eq!(boom_view.get("active"), Some(&Value::Bool(false)), "the clip itself has ended; only its particles remain");
    assert_eq!(glow_view.get("tail").and_then(Value::as_f64), Some(0.0));
    assert_eq!(glow_view.get("plays"), Some(&Value::Bool(false)), "tick 15 is past the filter's end");
    // Inside the range both play; after the tail the generated one is over; before the start neither.
    let inside = query(&mut session, &[&boom, &glow], 5.0);
    assert_eq!((inside.item(0).unwrap().get("active"), inside.item(1).unwrap().get("active")), (Some(&Value::Bool(true)), Some(&Value::Bool(true))));
    assert_eq!((inside.item(0).unwrap().get("plays"), inside.item(1).unwrap().get("plays")), (Some(&Value::Bool(true)), Some(&Value::Bool(true))));
    assert_eq!(query(&mut session, &[&boom], 10.0 + tail + 1.0).item(0).unwrap().get("plays"), Some(&Value::Bool(false)));
    assert_eq!(query(&mut session, &[&boom], 10.0 + tail - 1.0).item(0).unwrap().get("plays"), Some(&Value::Bool(true)));
    let later = clip_record("later", "explosion", 20.0, Some(10.0));
    assert_eq!(query(&mut session, &[&later], 5.0).item(0).unwrap().get("plays"), Some(&Value::Bool(false)));
    // A clip with no end has no tail, and one that is switched off does not play.
    let always = clip_record("always", "explosion", 0.0, None);
    let view = query(&mut session, &[&always], 400.0);
    assert_eq!((view.item(0).unwrap().get("tail").and_then(Value::as_f64), view.item(0).unwrap().get("plays")), (Some(0.0), Some(&Value::Bool(true))));
    let off = boom.replace(r#""enabled":true,"strength""#, r#""enabled":false,"strength""#);
    assert_eq!(query(&mut session, &[&off], 5.0).item(0).unwrap().get("plays"), Some(&Value::Bool(false)));
    // What is not a clip has no view; the playhead is the default tick.
    assert_eq!(query(&mut session, &["7"], 5.0).item(0), Some(Value::Null));
    assert_eq!(read(&mut session, "vfxClips", &format!(r#"{{"clips":[{boom}]}}"#)).item(0).unwrap().get("plays"), Some(&Value::Bool(true)));
}

#[test]
fn the_stored_clips_play_by_their_range() {
    let (mut session, _) = tape("vfx-clips-sheet");
    // The document's own clips: the tint (no end) plays at every tick, the glow only inside its range.
    let clips = session.editor.report().path(&["_styk", "vfxClips", "clips"]).unwrap().elements().unwrap().iter().map(|clip| json(&clip)).collect::<Vec<_>>();
    let ids: Vec<String> = session.editor.report().path(&["_styk", "vfxClips", "clips"]).unwrap().elements().unwrap().iter().map(|clip| clip.get("id").and_then(Value::as_str).unwrap().to_string()).collect();
    let plays = |session: &mut Session, tick: f64| -> Vec<(String, bool)> {
        let views = read(session, "vfxClips", &format!(r#"{{"clips":[{}],"tick":{tick}}}"#, clips.join(",")));
        ids.iter().cloned().zip(views.elements().unwrap().iter().map(|view| view.get("plays") == Some(&Value::Bool(true)))).collect()
    };
    let at = |plays: &[(String, bool)], id: &str| plays.iter().find(|(name, _)| name == id).unwrap().1;
    let early = plays(&mut session, 0.0);
    assert!(at(&early, "clip-tint"), "a clip with no end plays at the start");
    let late = plays(&mut session, 50.0);
    assert!(at(&late, "clip-tint"));
    assert!(!at(&late, "clip-glow"), "the glow ended at tick 8");
}

#[test]
fn a_figure_with_connected_effects_owns_the_figures_attached_to_it() {
    let (mut session, steps) = tape("vfx-scopes-sheet");
    let group = |session: &mut Session, uid: u32| read(session, "vfxGroup", &format!(r#"{{"uid":{uid}}}"#));
    // Nothing is connected yet.
    assert_eq!(group(&mut session, 1), Value::Null);
    // The tape switches figure 1 to the whole figure and pastes an effect onto it (steps 1 to 8).
    for step in &steps[1..=8] {
        run(&mut session, step);
    }
    let members = |group: &Value| group.get("members").unwrap().numbers().unwrap();
    assert_eq!(members(&group(&mut session, 1)), vec![1.0, 2.0, 3.0], "the owner first, then the figures hanging from it");
    // A figure that does not own a group has none, whatever hangs from it.
    assert_eq!(group(&mut session, 3), Value::Null);
    assert_eq!(group(&mut session, 99), Value::Null);
    // The reads change nothing.
    let before = json(session.editor.report());
    group(&mut session, 1);
    assert_eq!(before, json(session.editor.report()));
}

#[test]
fn a_movieclip_instance_is_measured_by_what_it_paints_for_the_effects_gizmo() {
    let (mut session, _) = tape("movieclip-playback-sheet");
    // The geometry the interface holds of an instance is its handle: it paints nothing there.
    let shown = geometry(&mut session, None);
    let handle = group(&shown, 0).get("bounds").unwrap().numbers().unwrap();
    assert!(handle[2] - handle[0] <= 1.0 && handle[3] - handle[1] <= 1.0, "the handle alone, {handle:?}");
    // What it draws is measured by the engine, for the figures asked.
    let extent = read(&mut session, "vfxExtent", r#"{"uids":[4]}"#).numbers().expect("the clip paints");
    assert_eq!(extent, vec![146.0, 164.0, 209.0, 452.0], "the clip's figures, as x, y, width, height");
    // Nothing known, nothing painted.
    assert_eq!(read(&mut session, "vfxExtent", r#"{"uids":[99]}"#), Value::Null);
    // The read changes nothing.
    let before = json(session.editor.report());
    read(&mut session, "vfxExtent", r#"{"uids":[4]}"#);
    assert_eq!(before, json(session.editor.report()));
}

#[test]
fn the_frame_carries_the_playhead_as_the_time_of_the_effect_clips_the_document_has() {
    let at = |session: &mut Session, kind: &str, tick: u32| parse(&session.query(kind, "{}", &format!(r#"{{"tick":{tick},"frameIndex":0}}"#)).unwrap());
    let tick_of = |frame: &Value| frame.get("_vfxTimelineTick").and_then(Value::as_f64);
    // Effect clips: the effects timeline reads the frame at the playhead; every kind of frame says so.
    let (mut effects, _) = tape("vfx-clips-sheet");
    for kind in ["frame", "document"] {
        assert_eq!(tick_of(&at(&mut effects, kind, 7)), Some(7.0), "{kind}");
    }
    // A document with none leaves the frame as the editor shows it, camera-motion clips or not.
    for name in ["gestures-sheet", "camera-motion-sheet"] {
        let (mut plain, _) = tape(name);
        let frame = at(&mut plain, "frame", 3);
        assert_eq!(tick_of(&frame), None, "{name}");
        assert_eq!(frame.get("_cameraMotionTick"), None, "{name}: the camera is read from the shot, not from a time");
    }
}

#[test]
fn the_interface_the_stage_and_the_pose_commands_read_one_scene() {
    use std::sync::Arc;
    let (mut session, _) = tape("channels-pose-sheet");
    call(&mut session, "seek", "[11]");
    call(&mut session, "select", "[4,-1]");
    let composed = session.editor.shown_scene(false, crate::Flavor::Composed).unwrap().unwrap();
    // A document without effects has one scene, whichever effects are asked for.
    let sampled = session.editor.shown_scene(false, crate::Flavor::Sampled).unwrap().unwrap();
    assert!(Arc::ptr_eq(&composed, &sampled), "the stage reads the scene the interface reads");
    assert!(Arc::ptr_eq(&composed, &session.editor.shown_scene(false, crate::Flavor::Composed).unwrap().unwrap()), "a frame that did not change is the one held");
    // The geometry the interface was sent is that scene's.
    let read = geometry(&mut session, None);
    assert_eq!(slots_of(&read).len(), composed.frame.objects.len());
    let again = session.editor.shown_scene(false, crate::Flavor::Composed).unwrap().unwrap();
    assert!(Arc::ptr_eq(&composed, &again), "reading the geometry builds nothing");
}

#[test]
fn a_gesture_builds_the_figure_it_moves_and_the_figures_that_hang_from_what_moved() {
    use std::sync::Arc;
    let (mut session, _) = tape("channels-pose-sheet");
    call(&mut session, "seek", "[11]");
    call(&mut session, "select", "[4,-1]");
    let before = session.editor.shown_scene(false, crate::Flavor::Composed).unwrap().unwrap();
    call(&mut session, "beginTranslationDrag", "[]");
    call(&mut session, "moveSelection", "[12,0,{\"fromStart\":true}]");
    let during = session.editor.shown_scene(false, crate::Flavor::Composed).unwrap().unwrap();
    assert!(!Arc::ptr_eq(&before, &during));
    let uid_at = |slot: usize| during.frame.objects[slot].uid;
    let rebuilt: Vec<u32> = (0..during.frame.objects.len()).filter(|&slot| during.built_in[slot] > before.serial).map(uid_at).collect();
    assert_eq!(rebuilt, vec![4], "only the figure the gesture moves is built again");
    for slot in 0..during.frame.objects.len() {
        if during.built_in[slot] <= before.serial {
            assert_eq!(during.scene.objects[slot].root.map(f64::to_bits), before.scene.objects[slot].root.map(f64::to_bits), "slot {slot} is where it was");
        }
    }
    // The scene is the scene built whole.
    let whole = styk_eval::geometry::build_shapes(&during.prepared.doc, &during.frame, None);
    for (kept, fresh) in during.scene.objects.iter().zip(&whole.objects) {
        assert_eq!(kept.ends.iter().map(|p| p.map(f64::to_bits)).collect::<Vec<_>>(), fresh.ends.iter().map(|p| p.map(f64::to_bits)).collect::<Vec<_>>());
    }
    call(&mut session, "cancelDrag", "[]");
}
