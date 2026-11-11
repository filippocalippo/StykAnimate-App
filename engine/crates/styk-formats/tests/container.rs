//! Container behaviour: lossless round trips, what moves into sections, limits,
//! and rejection of damaged files. These are the assertions of the JavaScript
//! codec's tests (at commit 96ebce85), against the Rust codec.

use std::sync::Arc;

use styk_doc::json;
use styk_doc::{Blob, Value};
use styk_formats::container::{self, ContainerError, Kind, Lifted, MAX_BYTES, decode, encode_v1, encode_v2, lift, lift_within};
use styk_formats::native::{NativeError, normalize_decoded};

fn doc(text: &str) -> Value {
    json::parse(text.as_bytes()).unwrap()
}

fn floats() -> String {
    let values: Vec<String> = (0..64).map(|i| styk_doc::json::to_string(&Value::Num((i as f64).sin() * 180.0))).collect();
    format!("[{}]", values.join(","))
}

fn base64(bytes: &[u8]) -> String {
    let mut out = Vec::new();
    json::base64_into(bytes, &mut out);
    String::from_utf8(out).unwrap()
}

fn build(document: &Value, kind: Kind) -> Vec<u8> {
    encode_v2(&lift(document, &[]).unwrap(), kind).unwrap()
}

fn skeleton_of(document: &Value) -> Value {
    doc(std::str::from_utf8(&lift(document, &[]).unwrap().skeleton).unwrap())
}

fn crafted(skeleton: &str, arrays: Vec<u8>, payloads: Vec<u8>) -> Vec<u8> {
    encode_v2(&Lifted { skeleton: skeleton.as_bytes().to_vec(), arrays, payloads, reserved_offsets: Vec::new() }, Kind::Styk).unwrap()
}

fn set_u64(bytes: &mut [u8], at: usize, value: u64) {
    bytes[at..at + 8].copy_from_slice(&value.to_le_bytes());
}

#[test]
fn the_skeleton_has_its_own_limit_and_declared_sizes_are_checked_before_use() {
    let bytes = build(&doc(r#"{"name":"small"}"#), Kind::Styk);
    for (version, raw, expected) in [(1u8, 300u64 << 20, "uncompressed"), (2, 385 << 20, "uncompressed"), (2, 300 << 20, "payload")] {
        let mut malformed = bytes.clone();
        malformed[4] = version;
        if version == 1 {
            malformed[5] = 1;
        }
        set_u64(&mut malformed, 8, raw);
        let error = decode(&malformed, Kind::Styk).err().expect("a wrong declared size must be refused");
        let matches = match expected {
            "uncompressed" => matches!(error, ContainerError::DeclaredTooLarge { .. }),
            _ => matches!(error, ContainerError::PayloadLength { .. }),
        };
        assert!(matches, "version {version}, {raw} bytes: {error}");
    }
    let oversized = Lifted { skeleton: b"{}".to_vec(), arrays: vec![0; MAX_BYTES + 1], payloads: Vec::new(), reserved_offsets: Vec::new() };
    assert_eq!(encode_v2(&oversized, Kind::Styk).err().and_then(|e| e.code()), Some("document_too_large"));
    let together = Lifted { skeleton: b"{}".to_vec(), arrays: vec![0; 200 << 20], payloads: vec![0; 200 << 20], reserved_offsets: Vec::new() };
    assert_eq!(encode_v2(&together, Kind::Styk).err().and_then(|e| e.code()), Some("document_too_large"));
}

#[test]
fn zlib_payloads_must_be_complete_exact_and_alone() {
    let payload = "z".repeat(1 << 20);
    let file = encode_v1(payload.as_bytes(), Kind::Styk);
    // Not JSON, but it must get as far as the JSON parser: the container itself is sound.
    assert!(matches!(decode(&file, Kind::Styk), Err(ContainerError::Json(_))));
    // A stream longer than declared.
    let mut longer = file.clone();
    set_u64(&mut longer, 8, 8192);
    assert!(matches!(decode(&longer, Kind::Styk), Err(ContainerError::PayloadLength { .. })));
    // A truncated stream (with the stored length adjusted so only the stream is wrong).
    let mut truncated = file[..file.len() - 1].to_vec();
    set_u64(&mut truncated, 16, (file.len() - 57) as u64);
    assert!(matches!(decode(&truncated, Kind::Styk), Err(ContainerError::PayloadLength { .. })));
    // Two streams where one is declared.
    let mut doubled = file.clone();
    doubled.extend_from_slice(&file[56..]);
    set_u64(&mut doubled, 16, ((file.len() - 56) * 2) as u64);
    assert!(matches!(decode(&doubled, Kind::Styk), Err(ContainerError::PayloadLength { .. })));
}

#[test]
fn section_records_reject_reserved_bytes_unknown_kinds_codecs_and_unsafe_lengths() {
    let bytes = build(&doc(&format!(r#"{{"a":{}}}"#, floats())), Kind::Styk);
    let table = 60 + u64::from_le_bytes(bytes[16..24].try_into().unwrap()) as usize;
    for relative in [2, 4, 56, 63] {
        let mut damaged = bytes.clone();
        damaged[table + relative] = 1;
        assert!(matches!(decode(&damaged, Kind::Styk), Err(ContainerError::Unsupported(_))), "reserved byte {relative}");
    }
    let mut kind = bytes.clone();
    kind[table] = 3;
    assert!(matches!(decode(&kind, Kind::Styk), Err(ContainerError::UnknownSectionKind { index: 0, kind: 3 })));
    let mut codec = bytes.clone();
    codec[table + 1] = 3;
    assert!(matches!(decode(&codec, Kind::Styk), Err(ContainerError::Unsupported(_))));
    for relative in [8, 16] {
        let mut damaged = bytes.clone();
        set_u64(&mut damaged, table + relative, 1 << 63);
        assert!(matches!(decode(&damaged, Kind::Styk), Err(ContainerError::SectionBounds { .. })), "length at {relative}");
    }
    assert!(matches!(decode(&bytes[..56], Kind::Styk), Err(ContainerError::Truncated(_))));
}

#[test]
fn markers_must_name_valid_ranges_of_the_right_section() {
    let payload = vec![0u8; 60];
    for marker in ["S2B:u8:0:0:9007199254740993", "S2B:u8:9007199254740993:0:0", "S2B:u8:1:0:4", "S2B:u16:0:1:2", "S2B:f64:0:8:64"] {
        let file = crafted(&format!(r#"{{"a":"{marker}"}}"#), vec![0u8; 32], payload.clone());
        assert!(matches!(decode(&file, Kind::Styk), Err(ContainerError::InvalidArraySection { .. })), "{marker}");
    }
    for marker in ["S2S:1:9007199254740993:0", "S2S:0:0:4", "S2S:1:0:61", "S2D:1:61:0:data:x;base64,"] {
        let file = crafted(&format!(r#"{{"a":"{marker}"}}"#), vec![0u8; 32], payload.clone());
        assert!(matches!(decode(&file, Kind::Styk), Err(ContainerError::InvalidPayloadSection { .. })), "{marker}");
    }
    for marker in ["S2B:u9:0:0:1", "S2B:u8:0:0", "S2S:1:0", "S2S:1:0:x", "S2D:1:0:1", "S2B:u8:0:-1:1"] {
        let file = crafted(&format!(r#"{{"a":"{marker}"}}"#), vec![0u8; 32], payload.clone());
        assert!(matches!(decode(&file, Kind::Styk), Err(ContainerError::MalformedMarker { .. })), "{marker}");
    }
}

#[test]
fn equal_markers_restore_one_shared_array() {
    let mut arrays = Vec::new();
    arrays.extend_from_slice(&0.125f64.to_le_bytes());
    arrays.extend_from_slice(&(-1e300f64).to_le_bytes());
    let file = crafted(r#"{"a":"S2B:f64:0:0:2","b":"S2B:f64:0:0:2"}"#, arrays, Vec::new());
    let document = decode(&file, Kind::Styk).unwrap().document;
    assert_eq!(document.get("a").unwrap().numbers(), Some(vec![0.125, -1e300]));
    assert!(document.get("a").unwrap().same_node(document.get("b").unwrap()));
}

#[test]
fn drawing_payloads_literal_markers_and_unknown_fields_survive() {
    let tiles = format!("data:application/x-styk-tiles;base64,{}", base64(&vec![0u8; 80000]));
    let document = doc(&format!(r#"{{"styk_tiles":"{tiles}","literal":"S2B:f64:0:0:3","escaped":"S2E:a","future":{{"__proto__":{{"retained":true}}}}}}"#));
    assert!(skeleton_of(&document).get("styk_tiles").and_then(Value::as_str).unwrap().starts_with("S2D:"));
    assert_eq!(skeleton_of(&document).get("literal").and_then(Value::as_str), Some("S2E:S2B:f64:0:0:3"));
    let restored = decode(&build(&document, Kind::Styk), Kind::Styk).unwrap().document;
    assert_eq!(restored, document);
    assert_eq!(json::to_string(&restored), json::to_string(&document));
}

#[test]
fn the_writer_refuses_excess_data() {
    let numbers = doc(&format!(r#"{{"a":{}}}"#, floats()));
    assert_eq!(lift_within(&numbers, &[], 100).err().and_then(|e| e.code()), Some("document_too_large"));
    let reserved: Arc<[u8]> = Arc::from(vec![0u8; 101]);
    assert_eq!(lift_within(&doc("{}"), &[reserved], 100).err().and_then(|e| e.code()), Some("document_too_large"));
    let encoded = base64(&vec![0u8; 50000]);
    let payload = doc(&format!(r#"{{"data_base64":"{encoded}"}}"#));
    assert_eq!(lift_within(&payload, &[], 100).err().and_then(|e| e.code()), Some("document_too_large"));
    // Text that is not canonical base64 stays in the skeleton as it is.
    let opaque = doc(&format!(r#"{{"data_base64":"={}"}}"#, &encoded[1..]));
    let lifted = lift_within(&opaque, &[], 20000).unwrap();
    assert!(lifted.skeleton.starts_with(br#"{"data_base64":"=AAAA"#));
}

#[test]
fn number_admission_falls_back_to_exact_json_sizes_near_the_limit() {
    // The 32-byte bound per number exceeds 16 bytes, but the document fits.
    assert!(lift_within(&doc(r#"{"x":1.25}"#), &[], 4).is_ok());
    assert_eq!(lift_within(&doc(r#"{"x":1.1234567891234567}"#), &[], 4).err().and_then(|e| e.code()), Some("document_too_large"));
    for x in [5e-324, -5e-324, f64::MAX, f64::MIN, 1e-7, -1e-7, 1e-6, -1e-6, 1e20, -1e20, 1e21, -1e21, f64::EPSILON, -0.0] {
        let document = Value::object([(Arc::from("x"), Value::Num(x))].into_iter().collect());
        let bytes = json::to_string(&document).len();
        assert!(lift_within(&document, &[], bytes.div_ceil(4)).is_ok(), "{x:e} fits");
        assert_eq!(lift_within(&document, &[], bytes.div_ceil(4) - 1).err().and_then(|e| e.code()), Some("document_too_large"), "{x:e} does not fit");
    }
}

#[test]
fn shared_arrays_are_stored_once_and_every_reference_is_counted() {
    let shared = Value::nums(&[0.0; 32]);
    let repeated = |count: usize| Value::object([(Arc::from("arr"), Value::Arr(Arc::new(vec![shared.clone(); count])))].into_iter().collect());
    assert!(json::to_string(&repeated(20)).len() < 1600);
    let lifted = lift_within(&repeated(20), &[], 400).unwrap();
    assert_eq!(lifted.arrays.len(), 32);
    let skeleton = doc(std::str::from_utf8(&lifted.skeleton).unwrap());
    let markers = skeleton.get("arr").unwrap().as_arr().unwrap();
    assert_eq!(markers[0], markers[19]);
    assert!(json::to_string(&repeated(25)).len() > 1600);
    assert_eq!(lift_within(&repeated(25), &[], 400).err().and_then(|e| e.code()), Some("document_too_large"));
    // The text fits, but 48 bytes per restored number plus the section do not.
    let single = Value::object([(Arc::from("arr"), shared.clone())].into_iter().collect());
    assert_eq!(lift_within(&single, &[], 391).err().and_then(|e| e.code()), Some("document_too_large"));
}

#[test]
fn values_json_cannot_hold_are_written_as_null_inline() {
    let nan = Value::object([(Arc::from("x"), Value::Num(f64::NAN)), (Arc::from("y"), Value::Num(1.0))].into_iter().collect());
    assert_eq!(json::to_string(&nan).len(), 16);
    assert!(lift_within(&nan, &[], 4).is_ok());
    assert_eq!(lift_within(&nan, &[], 3).err().and_then(|e| e.code()), Some("document_too_large"));
    let non_finite = Value::object(
        [
            (Arc::from("values"), Value::nums(&[f64::INFINITY; 40])),
            (Arc::from("x"), Value::Num(f64::NAN)),
            (Arc::from("y"), Value::Num(f64::NEG_INFINITY)),
            (Arc::from("z"), Value::Num(-0.0)),
        ]
        .into_iter()
        .collect(),
    );
    let lifted = lift(&non_finite, &[]).unwrap();
    assert!(lifted.arrays.is_empty(), "an array with non-finite values stays inline");
    let restored = decode(&encode_v2(&lifted, Kind::Styk).unwrap(), Kind::Styk).unwrap().document;
    assert_eq!(json::to_string(&restored), json::to_string(&doc(&json::to_string(&non_finite))));
}

#[test]
fn reserved_payloads_come_first_and_every_reference_points_at_them() {
    let bytes: Arc<[u8]> = Arc::from(&[0u8, 1, 2, 255][..]);
    let empty: Arc<[u8]> = Arc::from(&[][..]);
    let blob = |data: &Arc<[u8]>| Value::Blob(Arc::new(Blob { prefix: Arc::from(""), bytes: data.clone() }));
    let object = |key: &str, value: Value| Value::object([(Arc::from(key), value)].into_iter().collect());
    let document = Value::object(
        [
            (Arc::from("_stykSource"), object("source_base64", blob(&bytes))),
            (Arc::from("media"), object("data_base64", blob(&bytes))),
            (Arc::from("literal"), Value::str("S2E:literal")),
            (Arc::from("zero"), object("source_base64", blob(&empty))),
        ]
        .into_iter()
        .collect(),
    );
    let lifted = lift(&document, &[bytes.clone(), empty.clone()]).unwrap();
    assert_eq!(lifted.reserved_offsets, vec![0, 4]);
    let skeleton = doc(std::str::from_utf8(&lifted.skeleton).unwrap());
    assert_eq!(skeleton.path(&["_stykSource", "source_base64"]).and_then(Value::as_str), Some("S2S:1:0:4"));
    assert_eq!(skeleton.path(&["media", "data_base64"]).and_then(Value::as_str), Some("S2S:1:0:4"));
    assert_eq!(skeleton.path(&["zero", "source_base64"]).and_then(Value::as_str), Some("S2S:1:4:0"));
    let restored = decode(&encode_v2(&lifted, Kind::Styk).unwrap(), Kind::Styk).unwrap().document;
    assert_eq!(restored.path(&["_stykSource", "source_base64"]).unwrap().text().unwrap(), base64(&bytes));
    assert_eq!(restored.path(&["zero", "source_base64"]).unwrap().text().unwrap(), "");
    assert_eq!(restored.get("literal").and_then(Value::as_str), Some("S2E:literal"));
    // Every reference to a reserved payload is admitted.
    let many: Arc<[u8]> = Arc::from(vec![0u8; 100]);
    let repeated = |count: usize| Value::object((0..count).map(|i| (Arc::from(format!("k{i}").as_str()), object("source_base64", blob(&many)))).collect());
    assert_eq!(lift_within(&repeated(4), std::slice::from_ref(&many), 150).err().and_then(|e| e.code()), Some("document_too_large"));
    assert!(lift_within(&repeated(1), std::slice::from_ref(&many), 150).is_ok());
}

#[test]
fn a_document_round_trips_losslessly_and_shared_arrays_stay_shared() {
    let source = base64("source bytes ".repeat(6000).as_bytes());
    let png = base64("PNG".repeat(50000).as_bytes());
    let lengths = vec!["12.5"; 64].join(",");
    let bends: Vec<String> = (0..40).map(|i| (i - 20).to_string()).collect();
    let text = format!(
        r#"{{"version":5,"fps":12,"canvas":{{"width":640,"height":480}},"keyframes":[{{"duration_raw":2,"objects":[{{"figure_type_id":1,"angles":{a},"lengths":[{lengths}],"bends":[{b}],"uids":[0,255,65536,4294967295],"neg":[-5,-3,7,-2147483648],"join":{{"target_object_slot":1}}}},{{"figure_type_id":2,"angles":"SHARED"}}]}}],"figure_types":[{{"figure_type_id":1,"segments":[{{"kind":"line"}}]}}],"_stykSource":{{"kind":"piv","version":5,"source_base64":"{source}"}},"media":[{{"name":"a.png","data_url":"data:image/png;base64,{png}"}}],"title":"S2B:looks like a marker","alt":"S2E:also escaped"}}"#,
        a = floats(),
        b = bends.join(",")
    );
    // Give both objects the same angles array, as the editor does for a held pose.
    let mut document = doc(&text);
    let objects = document.make_obj().unwrap().get_mut("keyframes").unwrap().make_arr().unwrap()[0].make_obj().unwrap().get_mut("objects").unwrap().make_arr().unwrap();
    let angles = objects[0].get("angles").unwrap().clone();
    objects[1].make_obj().unwrap().set("angles", angles);

    let file = build(&document, Kind::Styk);
    assert_eq!(&file[..4], b"STYK");
    assert_eq!(file[4], 2);
    let decoded = decode(&file, Kind::Styk).unwrap();
    assert_eq!(decoded.version, 2);
    assert_eq!(decoded.document, document);
    assert_eq!(json::to_string(&decoded.document), json::to_string(&document));
    let frame = &decoded.document.get("keyframes").unwrap().as_arr().unwrap()[0];
    let poses = frame.get("objects").unwrap().as_arr().unwrap();
    assert!(poses[0].get("angles").unwrap().same_node(poses[1].get("angles").unwrap()), "one stored array, one restored array");
    assert!(matches!(decoded.document.path(&["_stykSource", "source_base64"]), Some(Value::Blob(_))));
    // Writing what was read gives the same file.
    assert_eq!(build(&decoded.document, Kind::Styk), file);
}

#[test]
fn integer_arrays_use_the_smallest_exact_type() {
    let repeat = |value: &str| format!("[{}]", vec![value; 40].join(","));
    let document = doc(&format!(r#"{{"a":{},"b":{},"c":{},"d":{},"e":{},"f":{}}}"#, repeat("200"), repeat("70000"), repeat("-7"), repeat("5000000000"), repeat("1.5"), repeat("0.1")));
    let skeleton = skeleton_of(&document);
    let marker = |key: &str| skeleton.get(key).and_then(Value::as_str).unwrap().to_string();
    assert!(marker("a").starts_with("S2B:u8:"));
    assert!(marker("b").starts_with("S2B:u32:"));
    assert!(marker("c").starts_with("S2B:i32:"));
    assert!(marker("d").starts_with("S2B:f64:"), "5e9 exceeds u32 but stays exact");
    assert!(marker("e").starts_with("S2B:f32:"), "1.5 is exactly single precision");
    assert!(marker("f").starts_with("S2B:f64:"));
    // Each array starts at a multiple of its element width.
    assert_eq!(marker("b"), "S2B:u32:0:40:40");
    assert_eq!(marker("d"), "S2B:f64:0:360:40");
    assert_eq!(decode(&build(&document, Kind::Styk), Kind::Styk).unwrap().document, document);
}

#[test]
fn values_the_format_does_not_move_stay_inline() {
    let zeros = vec!["0"; 40].join(",");
    let document = doc(&format!(
        r#"{{"mixed":[1,"two",3,{zeros}],"small":[1,2,3],"nested":{{"list":[[1.5,2.5],[3.5]]}},"bools":[{}],"objects":[{}],"huge":[{}],"proto":{{"__proto__":{{"x":7}}}}}}"#,
        vec!["true"; 40].join(","),
        vec![r#"{"x":1}"#; 40].join(","),
        vec!["9007199254740992"; 40].join(",")
    ));
    let lifted = lift(&document, &[]).unwrap();
    assert!(lifted.arrays.is_empty() && lifted.payloads.is_empty());
    assert_eq!(lifted.skeleton, json::to_string(&document).into_bytes());
    assert_eq!(decode(&build(&document, Kind::Styk), Kind::Styk).unwrap().document, document);
}

#[test]
fn non_finite_numbers_in_a_section_are_rejected() {
    let arrays: Vec<u8> = [f64::NAN; 4].iter().flat_map(|v| v.to_le_bytes()).collect();
    let file = crafted(r#"{"a":"S2B:f64:0:0:4"}"#, arrays, Vec::new());
    assert!(matches!(decode(&file, Kind::Styk), Err(ContainerError::NonFinite { .. })));
    let single: Vec<u8> = [f32::INFINITY; 4].iter().flat_map(|v| v.to_le_bytes()).collect();
    let file = crafted(r#"{"a":"S2B:f32:0:0:4"}"#, single, Vec::new());
    assert!(matches!(decode(&file, Kind::Styk), Err(ContainerError::NonFinite { .. })));
}

#[test]
fn version_one_and_plain_json_projects_stay_readable() {
    let text = r#"{"version":5,"keyframes":[{"objects":[]}],"marker":"S2B:0:0:0:5"}"#;
    let old = decode(&encode_v1(text.as_bytes(), Kind::Styk), Kind::Styk).unwrap();
    assert_eq!(old.version, 1);
    // Version 1 never had markers: the text is a literal.
    assert_eq!(old.document.get("marker").and_then(Value::as_str), Some("S2B:0:0:0:5"));
    let plain = decode(b"\xef\xbb\xbf  {\"version\":5,\"keyframes\":[]}", Kind::Styk).unwrap();
    assert_eq!(plain.version, 0);
    assert_eq!(plain.document.get("version"), Some(&Value::Num(5.0)));
    // Only projects may be plain JSON.
    assert!(matches!(decode(b"{\"version\":5}", Kind::Stkz), Err(ContainerError::Truncated(_))));
}

#[test]
fn corruption_truncation_and_the_wrong_kind_are_rejected() {
    let file = build(&doc(&format!(r#"{{"version":5,"keyframes":[{{"objects":[{{"angles":{}}}]}}]}}"#, floats())), Kind::Styk);
    let mut payload_bit = file.clone();
    let last = payload_bit.len() - 3;
    payload_bit[last] ^= 0xff;
    assert!(decode(&payload_bit, Kind::Styk).is_err());
    let mut digest = file.clone();
    digest[30] ^= 0xff;
    assert!(matches!(decode(&digest, Kind::Styk), Err(ContainerError::Checksum { .. })));
    assert!(matches!(decode(&file[..file.len() - 2], Kind::Styk), Err(ContainerError::SectionBounds { .. })));
    let mut trailing = file.clone();
    trailing.extend_from_slice(&[0, 0]);
    assert!(matches!(decode(&trailing, Kind::Styk), Err(ContainerError::LengthMismatch(_))));
    let mut future = file.clone();
    future[4] = 9;
    assert!(matches!(decode(&future, Kind::Styk), Err(ContainerError::Unsupported(_))));
    assert!(matches!(decode(&file, Kind::Stkz), Err(ContainerError::WrongMagic { .. })));
    assert_eq!(container::Kind::from_extension("STYKMOV"), Some(Kind::Stykmov));
}

#[test]
fn decoded_documents_are_unwrapped_and_figure_files_are_checked() {
    let inner = r#"{"version":5,"keyframes":[],"editable_paths":{},"_codec":{},"_stykWeb":{}}"#;
    let unwrapped = normalize_decoded(doc(&format!(r#"{{"format":"stykanimate","version":1,"document":{inner}}}"#)), Kind::Styk).unwrap();
    assert_eq!(json::to_string(&unwrapped), r#"{"version":5,"keyframes":[]}"#);
    assert_eq!(normalize_decoded(doc(r#"{"format":"stykanimate","version":2,"document":{}}"#), Kind::Styk), Err(NativeError::WrapperVersion));
    assert_eq!(normalize_decoded(doc("[1,2]"), Kind::Styk), Err(NativeError::NotAnObject));
    let figure = r#"{"figure_types":[{"figure_type_id":1}],"keyframes":[{"objects":[{"figure_type_id":1,"join":{"target_object_slot":0}}]}]}"#;
    assert!(normalize_decoded(doc(figure), Kind::Stkz).is_ok());
    assert_eq!(normalize_decoded(doc(r#"{"figure_types":[],"keyframes":[]}"#), Kind::Stkz), Err(NativeError::FigureShape("stkz")));
    let foreign = r#"{"figure_types":[{"figure_type_id":1}],"keyframes":[{"objects":[{"figure_type_id":9}]}]}"#;
    assert_eq!(normalize_decoded(doc(foreign), Kind::Stkz), Err(NativeError::FigureNotSelfContained("stkz")));
    let outside = r#"{"figure_types":[{"figure_type_id":1}],"keyframes":[{"objects":[{"figure_type_id":1,"join":{"target_object_slot":3}}]}]}"#;
    assert_eq!(normalize_decoded(doc(outside), Kind::Stkz), Err(NativeError::FigureJoins));
    assert_eq!(normalize_decoded(doc(figure), Kind::Stykmov), Err(NativeError::Movieclip));
}
