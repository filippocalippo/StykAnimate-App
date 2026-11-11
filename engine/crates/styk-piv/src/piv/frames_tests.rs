//! The frame grammar, exercised on frame tables built field by field
//! (`backend/test_fast_decode.py`, `test_native_scan.py`).

use super::*;

#[derive(Clone, Default)]
struct Object {
    uid: u32,
    tid: u16,
    scale: Option<f32>,
    color: Option<u32>,
    alpha: Option<u8>,
    media: Option<u8>,
    angle: Option<f64>,
    x: Option<f32>,
    y: Option<f32>,
    length: Option<f32>,
    len_flag: Option<u16>,
    bend: Option<f64>,
    bend_flag: Option<u16>,
    join: Option<(u16, u16)>,
}

fn object(uid: u32) -> Object {
    Object { uid, tid: 1, ..Object::default() }
}

#[derive(Clone, Default)]
struct Frame {
    objects: Vec<Object>,
    duration: Option<u16>,
    bg: u16,
    mix: u8,
    bg_b: u16,
    order: Option<Vec<u16>>,
    camera: Option<(f32, f32, f64, f32)>,
    media: bool,
}

/// One frame as the file stores it (one `f64` angle per object: figures have one segment).
fn frame_record(frame: &Frame) -> Vec<u8> {
    let mut data = Vec::new();
    data.extend_from_slice(&frame.duration.unwrap_or(1).to_le_bytes());
    data.push(frame.mix);
    data.extend_from_slice(&frame.bg.to_le_bytes());
    if frame.mix != 0 {
        data.extend_from_slice(&frame.bg_b.to_le_bytes());
    }
    data.extend_from_slice(&(frame.objects.len() as u16).to_le_bytes());
    for o in &frame.objects {
        data.extend_from_slice(&o.uid.to_le_bytes());
        data.extend_from_slice(&o.tid.to_le_bytes());
        data.extend_from_slice(&o.scale.unwrap_or(1.0).to_le_bytes());
        data.extend_from_slice(&o.color.unwrap_or(0x807f55ff).to_le_bytes());
        data.push(o.alpha.unwrap_or(3));
        if frame.media {
            data.push(o.media.unwrap_or(5));
        }
        data.extend_from_slice(&o.angle.unwrap_or(-0.0).to_le_bytes());
        data.extend_from_slice(&o.x.unwrap_or(-0.0).to_le_bytes());
        data.extend_from_slice(&o.y.unwrap_or(20.0).to_le_bytes());
        let len_flag = o.len_flag.unwrap_or(o.length.is_some() as u16);
        data.extend_from_slice(&len_flag.to_le_bytes());
        if len_flag != 0 {
            data.extend_from_slice(&o.length.unwrap_or(3.0).to_le_bytes());
        }
        let bend_flag = o.bend_flag.unwrap_or(o.bend.is_some() as u16);
        data.extend_from_slice(&bend_flag.to_le_bytes());
        if bend_flag != 0 {
            data.extend_from_slice(&o.bend.unwrap_or(0.125).to_le_bytes());
        }
        match o.join {
            Some((slot, handle)) => {
                data.push(1);
                data.extend_from_slice(&slot.to_le_bytes());
                data.extend_from_slice(&handle.to_le_bytes());
            }
            None => data.push(0),
        }
    }
    let order = frame.order.clone().unwrap_or_else(|| (0..frame.objects.len() as u16).collect());
    for slot in order {
        data.extend_from_slice(&slot.to_le_bytes());
    }
    match frame.camera {
        None => data.push(1),
        Some((x, y, angle, scale)) => {
            data.push(0);
            data.extend_from_slice(&x.to_le_bytes());
            data.extend_from_slice(&y.to_le_bytes());
            data.extend_from_slice(&angle.to_le_bytes());
            data.extend_from_slice(&scale.to_le_bytes());
        }
    }
    data
}

fn table(frames: &[Frame]) -> Vec<u8> {
    let mut data = (frames.len() as u32).to_le_bytes().to_vec();
    for frame in frames {
        data.extend_from_slice(&frame_record(frame));
    }
    data
}

fn figures(media: bool) -> Vec<FigureInfo> {
    (1..=2).map(|id| FigureInfo { id, count: 1, has_media: media, handles: vec![0, 1] }).collect()
}

fn read(data: &[u8], media: bool, mode: FrameMode) -> PyResult<Frames> {
    let never = || false;
    read_frames(&Ctx::new(&never), data, 0, &figures(media), 2, mode)
}

const SCAN: FrameMode = FrameMode::Scan { max_pose_bytes: NATIVE_POSE_BUDGET };

/// Every mode accepts the table and consumes all of it.
fn accepted(data: &[u8], media: bool) -> Vec<Value> {
    for mode in [FrameMode::Validate, SCAN] {
        assert_eq!(read(data, media, mode).unwrap().end, data.len());
    }
    let frames = read(data, media, FrameMode::Build).unwrap();
    assert_eq!(frames.end, data.len());
    frames.values.unwrap()
}

fn rejected(data: &[u8], media: bool) -> String {
    let messages: Vec<String> = [FrameMode::Build, FrameMode::Validate, SCAN].into_iter().map(|mode| read(data, media, mode).err().expect("must be rejected").msg).collect();
    assert!(messages.iter().all(|m| *m == messages[0]), "{messages:?}");
    messages[0].clone()
}

fn number(value: &Value, path: &[&str]) -> f64 {
    value.path(path).and_then(Value::as_f64).unwrap()
}

#[test]
fn valid_pose_variants_keep_every_field_and_float_bit() {
    let frames = accepted(&table(&[Frame { objects: vec![object(1)], ..Frame::default() }]), false);
    let pose = &frames[0].get("objects").unwrap().as_arr().unwrap()[0];
    // Negative zeros survive as negative zeros.
    assert!(pose.get("angles").unwrap().numbers().unwrap()[0].is_sign_negative());
    assert!(number(pose, &["root_x"]).is_sign_negative());
    assert_eq!(number(pose, &["color_override_mix"]), 128.0);
    assert_eq!(pose.get("color_override_rgb").unwrap().numbers().unwrap(), [255.0, 85.0, 127.0]);
    assert_eq!(number(pose, &["opacity"]), 1.0 - 3.0 / 255.0);

    let tiny = Object { x: Some(1e-35), angle: Some(1e-300), ..object(1) };
    let frames = accepted(&table(&[Frame { objects: vec![tiny], ..Frame::default() }]), false);
    let pose = &frames[0].get("objects").unwrap().as_arr().unwrap()[0];
    assert_eq!(pose.get("angles").unwrap().numbers().unwrap(), [1e-300]);
    assert_eq!(number(pose, &["root_x"]), 1e-35f32 as f64);

    let flagged = Object { length: Some(-0.0), bend: Some(1e-300), len_flag: Some(65535), bend_flag: Some(37), ..object(1) };
    let frames = accepted(&table(&[Frame { objects: vec![flagged], ..Frame::default() }]), false);
    let pose = &frames[0].get("objects").unwrap().as_arr().unwrap()[0];
    assert_eq!((number(pose, &["len_flag"]), number(pose, &["bend_flag"])), (65535.0, 37.0));
    assert!(pose.get("lengths").unwrap().numbers().unwrap()[0].is_sign_negative());

    let mirrored = Object { media: Some(255), ..object(1) };
    let frames = accepted(&table(&[Frame { objects: vec![mirrored], media: true, ..Frame::default() }]), true);
    assert_eq!(number(&frames[0].get("objects").unwrap().as_arr().unwrap()[0], &["image_text_flags"]), 255.0);

    let hidden = Frame {
        objects: vec![Object { scale: Some(-0.25), alpha: Some(255), color: Some(0xffff_ffff), ..object(1) }],
        camera: Some((-0.0, 13.0, -1.5, 0.75)),
        duration: Some(0),
        mix: 1,
        bg_b: 1,
        ..Frame::default()
    };
    let frames = accepted(&table(&[hidden]), false);
    assert_eq!(frames[0].get("hidden"), Some(&Value::Bool(true)));
    assert_eq!(number(&frames[0], &["inbetweens"]), -1.0);
    assert_eq!(number(&frames[0], &["background_id_b"]), 1.0);
    assert_eq!(number(&frames[0], &["camera", "angle_rad"]), -1.5);
    assert!(number(&frames[0], &["camera", "x"]).is_sign_negative());

    // Joins refer to source slots; IDs need not be sorted.
    let joined = Frame {
        objects: vec![object(0xffff_ffff), Object { join: Some((0, 1)), ..object(0) }, Object { join: Some((1, 0)), ..object(1) }],
        order: Some(vec![2, 0, 1]),
        ..Frame::default()
    };
    let frames = accepted(&table(&[joined]), false);
    let objects = frames[0].get("objects").unwrap().as_arr().unwrap();
    assert_eq!(number(&objects[1], &["join", "target_unique_id"]), 4294967295.0);
    assert_eq!(number(&objects[2], &["join", "target_unique_id"]), 0.0);
    assert_eq!(frames[0].get("object_draw_order_unique_ids").unwrap().numbers().unwrap(), [1.0, 4294967295.0, 0.0]);
    assert!(accepted(&table(&[Frame::default()]), false)[0].get("objects").unwrap().as_arr().unwrap().is_empty());
}

#[test]
fn every_truncation_is_rejected() {
    let source = table(&[Frame {
        objects: vec![Object { length: Some(15.0), bend: Some(0.1), ..object(1) }],
        camera: Some((1.0, 2.0, 0.25, 1.5)),
        mix: 1,
        bg_b: 1,
        ..Frame::default()
    }]);
    for size in 0..source.len() {
        assert!(rejected(&source[..size], false).starts_with("Unexpected EOF at payload offset 0x"), "size {size}");
    }
}

#[test]
fn unsorted_ids_keep_their_source_slots() {
    for ids in [[1, 2, 0], [0, 1, 0xffff_ffff], [0x7fff_ffff, 0x8000_0000, 2]] {
        let frames = accepted(&table(&[Frame { objects: ids.iter().map(|&uid| object(uid)).collect(), order: Some(vec![2, 0, 1]), ..Frame::default() }]), false);
        let objects = frames[0].get("objects").unwrap().as_arr().unwrap();
        let stored: Vec<f64> = objects.iter().map(|o| number(o, &["unique_id"])).collect();
        assert_eq!(stored, ids.map(|id| id as f64));
    }
}

#[test]
fn the_scan_asks_for_duplicate_recovery_with_the_exact_location() {
    for (ids, detail) in [([1u32, 2, 1], "duplicate object ID 1 (also used by object 1)"), ([0xffff_ffff, 0, 0xffff_ffff], "duplicate object ID 4294967295 (also used by object 1)")] {
        let first = frame_record(&Frame::default());
        let mut source = b"prefix!".to_vec();
        source.extend_from_slice(&2u32.to_le_bytes());
        source.extend_from_slice(&first);
        source.extend_from_slice(&frame_record(&Frame { objects: ids.iter().map(|&uid| object(uid)).collect(), ..Frame::default() }));
        // One empty frame, then a frame header and two complete 36-byte objects.
        let offset = 7 + 4 + first.len() + 7 + 2 * 36;
        let never = || false;
        let error = read_frames(&Ctx::new(&never), &source, 7, &figures(false), 2, SCAN).err().unwrap();
        assert_eq!(error.exc, crate::error::Exc::PivIdentity);
        assert!(error.msg.contains(&format!("Pivot keyframe 2, object 3: {detail}")), "{}", error.msg);
        assert!(error.msg.contains(&format!("payload offset {offset:#x}")), "{}", error.msg);
        // The complete reader renames the second occurrence instead.
        let frames = read_frames(&Ctx::new(&never), &source, 7, &figures(false), 2, FrameMode::Build).unwrap();
        assert_eq!(frames.repairs.len(), 1);
        assert_eq!((frames.repairs[0].keyframe_index, frames.repairs[0].object_slot, frames.repairs[0].source_unique_id), (1, 2, ids[0]));
    }
}

#[test]
fn non_finite_numbers_are_rejected_at_every_float_location() {
    for value in [f64::INFINITY, f64::NEG_INFINITY, f64::NAN] {
        let single = value as f32;
        for bad in [
            Object { scale: Some(single), ..object(1) },
            Object { angle: Some(value), ..object(1) },
            Object { x: Some(single), ..object(1) },
            Object { y: Some(single), ..object(1) },
            Object { length: Some(single), ..object(1) },
            Object { bend: Some(value), ..object(1) },
        ] {
            assert!(rejected(&table(&[Frame { objects: vec![bad], ..Frame::default() }]), false).starts_with("Non-finite"));
        }
        for index in 0..4 {
            let mut camera = [0.0, 0.0, 0.0, 1.0];
            camera[index] = value;
            let frame = Frame { objects: vec![object(1)], camera: Some((camera[0] as f32, camera[1] as f32, camera[2], camera[3] as f32)), ..Frame::default() };
            assert_eq!(rejected(&table(&[frame]), false), "Non-finite camera in frame 0");
        }
    }
}

#[test]
fn semantic_bounds_and_joins_are_checked() {
    let one = |frame: Frame| table(&[frame]);
    assert!(rejected(&1_000_001u32.to_le_bytes(), false).starts_with("Implausible keyframe count 1000001"));
    assert!(rejected(&one(Frame { objects: vec![object(1)], bg: 2, ..Frame::default() }), false).starts_with("Unknown background in frame 0"));
    assert!(rejected(&one(Frame { objects: vec![object(1)], mix: 1, bg_b: 2, ..Frame::default() }), false).starts_with("Unknown background in frame 0"));
    assert!(rejected(&one(Frame { objects: vec![Object { tid: 3, ..object(1) }], ..Frame::default() }), false).starts_with("Unknown figure type 3 in frame 0, object 0"));
    assert_eq!(rejected(&one(Frame { objects: vec![Object { join: Some((1, 0)), ..object(1) }], ..Frame::default() }), false), "Invalid joined object slot 1 in frame 0");
    assert_eq!(rejected(&one(Frame { objects: vec![object(1), Object { join: Some((0, 2)), ..object(2) }], ..Frame::default() }), false), "Unknown joined target handle in frame 0");
    assert_eq!(rejected(&one(Frame { objects: vec![Object { join: Some((0, 0)), ..object(1) }], ..Frame::default() }), false), "Cyclic object joins in frame 0");
    let cycle = vec![Object { join: Some((1, 0)), ..object(1) }, Object { join: Some((0, 0)), ..object(2) }];
    assert_eq!(rejected(&one(Frame { objects: cycle, ..Frame::default() }), false), "Cyclic object joins in frame 0");
    for order in [vec![0, 0], vec![0, 2]] {
        let frame = Frame { objects: vec![object(1), object(2)], order: Some(order), ..Frame::default() };
        assert!(rejected(&one(frame), false).starts_with("Invalid object draw-order permutation in frame 0"));
    }
}

#[test]
fn a_figure_type_may_change_between_keys_whatever_the_hold() {
    for duration in [0, 1, 2, 65535] {
        let frames = [
            Frame { objects: vec![object(1)], duration: Some(duration), ..Frame::default() },
            Frame { objects: vec![Object { tid: 2, ..object(1) }], ..Frame::default() },
        ];
        let data = table(&frames);
        accepted(&data, false);
        assert_eq!(read(&data, false, SCAN).unwrap().durations, [duration, 1]);
    }
}

#[test]
fn a_long_join_chain_is_linear_and_its_cycle_is_found() {
    let mut objects: Vec<Object> = (0..5000u32).map(|uid| Object { join: (uid < 4999).then_some((uid as u16 + 1, 0)), ..object(uid) }).collect();
    accepted(&table(&[Frame { objects: objects.clone(), ..Frame::default() }]), false);
    objects[4999].join = Some((0, 1));
    assert_eq!(rejected(&table(&[Frame { objects, ..Frame::default() }]), false), "Cyclic object joins in frame 0");
}

#[test]
fn the_pose_budget_is_charged_before_the_data_it_admits_is_read() {
    let never = || false;
    let scan = |data: &[u8], count: usize, budget: u64| {
        let figures = vec![FigureInfo { id: 1, count, has_media: false, handles: (0..=count as u16).collect() }];
        read_frames(&Ctx::new(&never), data, 0, &figures, 2, FrameMode::Scan { max_pose_bytes: budget })
    };
    let over = |data: &[u8], count: usize, budget: u64| {
        let message = scan(data, count, budget).err().expect("over budget").msg;
        assert!(message.starts_with("Native scene exceeds the") && message.ends_with("MiB pose budget"), "{message}");
    };
    // Each source stops right before the bytes the scanner would read next: a
    // budget error instead of an end-of-file error proves the charge comes first.
    let mut many_objects = 1u32.to_le_bytes().to_vec();
    many_objects.extend_from_slice(&[1, 0, 0, 0, 0, 20, 0]);
    over(&many_objects, 1, 512 + 19 * 512);
    let plain = table(&[Frame { objects: vec![object(1)], ..Frame::default() }]);
    over(&plain[..26], 30000, 1024 + 30000 * 24 - 1);
    let lengths = table(&[Frame { objects: vec![Object { length: Some(3.0), ..object(1) }], ..Frame::default() }]);
    over(&lengths[..44], 1, 1024 + 24);
    let bends = table(&[Frame { objects: vec![Object { length: Some(3.0), bend: Some(0.2), ..object(1) }], ..Frame::default() }]);
    over(&bends[..50], 1, 1024 + 48);
    let joins = table(&[Frame { objects: vec![Object { join: Some((1, 0)), ..object(1) }, object(2)], ..Frame::default() }]);
    over(&joins[..47], 1, 512 + 2 * 512 + 24);
    over(&600_000u32.to_le_bytes(), 1, 256 * 1024 * 1024);

    // The exact estimate is admitted: frame, two objects, four pose arrays, one join.
    let source = table(&[Frame { objects: vec![Object { join: Some((1, 0)), ..object(1) }, Object { length: Some(3.0), bend: Some(0.2), ..object(2) }], ..Frame::default() }]);
    let exact = 512 + 2 * 512 + 4 * 24 + 64;
    assert_eq!(scan(&source, 1, exact).unwrap().durations.len(), 1);
    over(&source, 1, exact - 1);
}

#[test]
fn signed_id_extremes_are_not_duplicates() {
    let ids = [0x8000_0000u32, 0xffff_ffff, 0, 0x7fff_ffff];
    accepted(&table(&[Frame { objects: ids.iter().map(|&uid| object(uid)).collect(), ..Frame::default() }]), false);
    let repeated = table(&[Frame { objects: vec![object(0), object(0x8000_0000), object(0)], ..Frame::default() }]);
    assert_eq!(read(&repeated, false, SCAN).err().unwrap().exc, crate::error::Exc::PivIdentity);
}

#[test]
fn cancellation_stops_between_frames() {
    let data = table(&vec![Frame { objects: vec![object(1)], ..Frame::default() }; 8]);
    let polls = std::cell::Cell::new(0);
    let cancel = || {
        polls.set(polls.get() + 1);
        polls.get() > 5
    };
    let error = read_frames(&Ctx::new(&cancel), &data, 0, &figures(false), 2, FrameMode::Build).err().unwrap();
    assert_eq!((error.status, error.code), (499, "cancelled"));
}
