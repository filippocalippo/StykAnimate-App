//! What the interface's file workers ask of a native file: opening one into the
//! lifted form the interface shares with the store, and saving from it.

use std::collections::HashMap;

use styk_doc::json;
use styk_formats::container::{Kind, encode_v1, encode_v2, lift};
use styk_formats::files::{self, BlockStore, NoStore, Rules};

fn doc(text: &str) -> styk_doc::Value {
    json::parse(text.as_bytes()).unwrap()
}

fn numbers(count: usize) -> String {
    let values: Vec<String> = (0..count).map(|i| format!("{}", (i as f64 * 0.37).sin() * 180.0)).collect();
    format!("[{}]", values.join(","))
}

fn container(text: &str, kind: Kind) -> Vec<u8> {
    encode_v2(&lift(&doc(text), &[]).unwrap(), kind).unwrap()
}

/// A project with one array held twice, an image and an embedded source with its fingerprint.
fn project() -> Vec<u8> {
    let source = [7u8; 9000];
    let mut encoded = Vec::new();
    json::base64_into(&source, &mut encoded);
    let mut image = Vec::new();
    json::base64_into(&vec![3u8; 80_000], &mut image);
    let hash = {
        use sha2::{Digest, Sha256};
        Sha256::digest(source).iter().map(|b| format!("{b:02x}")).collect::<String>()
    };
    let text = format!(
        r#"{{"version":5,"media":[{{"data_url":"data:image/png;base64,{img}"}}],"_stykSource":{{"sha256":"{hash}","source_base64":"{src}"}}}}"#,
        img = String::from_utf8(image).unwrap(),
        src = String::from_utf8(encoded).unwrap(),
    );
    let mut document = doc(&text);
    let angles = doc(&numbers(64));
    let mut pose = styk_doc::Obj::new();
    pose.set("angles", angles.clone());
    let mut frame = styk_doc::Obj::new();
    frame.set("objects", styk_doc::Value::array(vec![styk_doc::Value::object(pose)]));
    let object = document.make_obj().unwrap();
    object.set("angles", angles);
    object.set("keyframes", styk_doc::Value::array(vec![styk_doc::Value::object(frame)]));
    encode_v2(&lift(&document, &[]).unwrap(), Kind::Styk).unwrap()
}

#[test]
fn a_project_opens_into_the_lifted_form_and_saves_back_to_the_same_bytes() {
    let file = project();
    let opened = files::open(&file, Kind::Styk, Rules::PROJECT).unwrap();
    assert_eq!(opened.version, 2);
    assert!(opened.materialized_bytes > opened.skeleton.len());
    let saved = files::save(Kind::Styk, &opened.skeleton, &opened.sections[0], &opened.sections[1], &mut NoStore, &|| false).unwrap();
    assert_eq!(saved.bytes, file, "an unchanged project saves to the bytes it was opened from");
    assert_eq!((saved.stats.hits, saved.stats.misses), (0, 3));
}

#[test]
fn arrays_shared_in_the_file_share_one_marker_in_the_skeleton() {
    let opened = files::open(&project(), Kind::Styk, Rules::PROJECT).unwrap();
    let skeleton = doc(std::str::from_utf8(&opened.skeleton).unwrap());
    let top = skeleton.get("angles").and_then(|v| v.as_str()).unwrap().to_string();
    let frame = skeleton.get("keyframes").and_then(|frames| frames.item(0)).unwrap();
    let pose = frame.get("objects").and_then(|objects| objects.item(0)).unwrap();
    let inner = pose.get("angles").and_then(|v| v.as_str()).unwrap();
    assert!(top.starts_with("S2B:"));
    assert_eq!(top, inner, "one array, one marker");
}

#[test]
fn the_document_rules_are_the_callers_choice() {
    let wrapped = r#"{"format":"stykanimate","version":1,"document":{"version":5,"editable_paths":{},"_codec":{},"keyframes":[]}}"#;
    let file = container(wrapped, Kind::Styk);
    let raw = files::open(&file, Kind::Styk, Rules::RAW).unwrap();
    assert!(std::str::from_utf8(&raw.skeleton).unwrap().contains("\"format\":\"stykanimate\""));
    let normal = files::open(&file, Kind::Styk, Rules::PROJECT).unwrap();
    assert_eq!(std::str::from_utf8(&normal.skeleton).unwrap(), r#"{"version":5,"keyframes":[]}"#);
    let future = container(r#"{"format":"stykanimate","version":2,"document":{}}"#, Kind::Styk);
    let error = files::open(&future, Kind::Styk, Rules::PROJECT).err().unwrap();
    assert_eq!((error.message_key, error.code), ("errors.nativeContainer.unsupportedStykanimateProjectVersion", Some("invalid_native_version")));
}

#[test]
fn a_figure_file_must_hold_one_pose_of_reusable_figures() {
    let figure = r#"{"figure_types":[{"figure_type_id":1}],"keyframes":[{"objects":[{"figure_type_id":9}]}]}"#;
    let file = container(figure, Kind::Stkz);
    let error = files::open(&file, Kind::Stkz, Rules::PREVIEW).err().unwrap();
    assert_eq!((error.message_key, error.code, error.kind), ("errors.nativeContainer.theFigureMustBeSelfContained", Some("invalid_native_figure"), Some("stkz")));
    assert!(files::open(&file, Kind::Stkz, Rules::RAW).is_ok(), "raw reads the container only");
    let saved = files::save(Kind::Stkz, figure.as_bytes(), &[], &[], &mut NoStore, &|| false).err().unwrap();
    assert_eq!((saved.message_key, saved.code, saved.kind), ("errors.nativeContainer.theFigureMustBeSelfContained", Some("invalid_native_figure"), Some("stkz")));
    let movieclip = r#"{"figure_types":[{"figure_type_id":1}],"keyframes":[{"objects":[{"figure_type_id":1}]}]}"#;
    let error = files::save(Kind::Stykmov, movieclip.as_bytes(), &[], &[], &mut NoStore, &|| false).err().unwrap();
    assert_eq!((error.message_key, error.code), ("errors.nativeContainer.aStykmovFileMustContainOneMovieclip", Some("invalid_movieclip")));
    assert!(files::save(Kind::Stkz, movieclip.as_bytes(), &[], &[], &mut NoStore, &|| false).is_ok());
    assert!(files::save(Kind::Styk, figure.as_bytes(), &[], &[], &mut NoStore, &|| false).is_ok(), "a project is not a figure file");
}

#[test]
fn the_embedded_source_is_checked_against_its_fingerprint() {
    let text = r#"{"_stykSource":{"sha256":"00","source_base64":"AAAA"}}"#;
    let file = container(text, Kind::Styk);
    let error = files::open(&file, Kind::Styk, Rules::PROJECT).err().unwrap();
    assert_eq!(error.message_key, "errors.nativeContainer.embeddedOriginalSourceFingerprintDoesNotMatch");
    assert!(files::open(&file, Kind::Styk, Rules::PREVIEW).is_ok(), "a preview does not read the source");
}

#[test]
fn damaged_and_foreign_files_name_their_message() {
    let file = project();
    let mut flipped = file.clone();
    flipped[30] ^= 0xff; // the skeleton's fingerprint
    assert_eq!(files::open(&flipped, Kind::Styk, Rules::PROJECT).err().unwrap().message_key, "errors.nativeContainer.theStykanimateFileIsDamagedChecksumMismatch");
    assert_eq!(files::open(&file, Kind::Stkz, Rules::PROJECT).err().unwrap().message_key, "errors.nativeContainer.theStykanimateFileTypeDoesNotMatchIts");
    let old = encode_v1(br#"{"version":5,"keyframes":[]}"#, Kind::Styk);
    assert_eq!(files::open(&old, Kind::Styk, Rules::PROJECT).unwrap().version, 1);
    let plain = files::open(b"  {\"version\":5}", Kind::Styk, Rules::PROJECT).unwrap();
    assert_eq!(plain.version, 0);
}

/// A store that keeps what it is given.
#[derive(Default)]
struct Kept(HashMap<String, Vec<u8>>);

impl BlockStore for Kept {
    fn get(&mut self, key: &str) -> Option<Vec<u8>> {
        self.0.get(key).cloned()
    }
    fn put(&mut self, key: &str, stored: &[u8]) {
        self.0.insert(key.to_string(), stored.to_vec());
    }
}

#[test]
fn compressed_blocks_are_reused_only_for_the_same_bytes() {
    let opened = files::open(&project(), Kind::Styk, Rules::PROJECT).unwrap();
    let (skeleton, arrays, payloads) = (&opened.skeleton, &opened.sections[0], &opened.sections[1]);
    let mut store = Kept::default();
    let first = files::save(Kind::Styk, skeleton, arrays, payloads, &mut store, &|| false).unwrap();
    assert_eq!((first.stats.hits, first.stats.misses, store.0.len()), (0, 3, 3));
    assert_eq!(first.stats.container_raw_bytes, skeleton.len() + arrays.len() + payloads.len());
    assert!(store.0.keys().all(|key| key.starts_with("2:3:")));
    let second = files::save(Kind::Styk, skeleton, arrays, payloads, &mut store, &|| false).unwrap();
    assert_eq!(second.bytes, first.bytes);
    assert_eq!((second.stats.hits, second.stats.misses), (3, 0));
    assert_eq!(second.stats.raw_bytes_reused, first.stats.container_raw_bytes);
    // An edited array misses; the other two blocks are still found.
    let mut edited = arrays.clone();
    edited[0] ^= 1;
    let third = files::save(Kind::Styk, skeleton, &edited, payloads, &mut store, &|| false).unwrap();
    assert_eq!((third.stats.hits, third.stats.misses), (2, 1));
    assert_ne!(third.bytes, first.bytes);
    let reopened = files::open(&third.bytes, Kind::Styk, Rules::RAW).unwrap();
    assert_eq!(reopened.sections[0], edited);
}

#[test]
fn saving_refuses_what_the_format_cannot_hold() {
    let error = files::save(Kind::Styk, b"{}", &vec![0; (256 << 20) + 1], &[], &mut NoStore, &|| false).err().unwrap();
    assert_eq!((error.message_key, error.code), ("errors.nativeContainer.theStykanimateDocumentExceedsTheUncompressedSizeLimit", Some("document_too_large")));
}

/// The document a skeleton and its sections stand for.
fn restored(opened: &files::Opened) -> String {
    json::to_string(&styk_formats::container::parse_lifted(&opened.skeleton, &opened.sections[0], &opened.sections[1]).unwrap())
}

#[test]
fn a_project_that_keeps_its_document_is_handed_over_as_stored() {
    let file = project();
    let stored = styk_formats::container::decode_parts(&file, Kind::Styk).unwrap();
    let opened = files::open(&file, Kind::Styk, Rules::PROJECT).unwrap();
    assert_eq!(opened.skeleton, stored.skeleton, "no tree was built and nothing was written again");
    assert_eq!(opened.sections, stored.sections.iter().map(|(_, bytes)| bytes.clone()).collect::<Vec<_>>());
    // It stands for the document the tree path reads.
    let tree = styk_formats::container::decode(&file, Kind::Styk).unwrap().document;
    assert_eq!(restored(&opened), json::to_string(&tree));
}

#[test]
fn the_scanned_and_the_built_paths_refuse_the_same_files_the_same_way() {
    let mut forged = vec![project()];
    let crafted = |skeleton: &str, arrays: Vec<u8>| {
        encode_v2_with_parts(skeleton, arrays)
    };
    for marker in ["S2B:f64:0:0:4", "S2B:f64:0:8:64", "S2B:f64:3:0:1", "S2B:u8:0:0:99999", "S2S:1:0:5", "S2B:bad", "S2B:u64:0:0:1"] {
        forged.push(crafted(&format!(r#"{{"a":"{marker}"}}"#), vec![0, 0, 0, 0, 0, 0, 0xf8, 0x7f, 0, 0, 0, 0, 0, 0, 0xf8, 0x7f, 0, 0, 0, 0, 0, 0, 0xf8, 0x7f, 0, 0, 0, 0, 0, 0, 0xf8, 0x7f]));
    }
    forged.push(crafted(r#"{"a":"S2B:f64:0:0:3","b":1,}"#, vec![0; 24]));
    for file in forged {
        let built = styk_formats::container::decode(&file, Kind::Styk).err().map(|error| error.message_key());
        let opened = files::open(&file, Kind::Styk, Rules::RAW).err().map(|error| error.message_key);
        assert_eq!(opened, built);
    }
}

fn encode_v2_with_parts(skeleton: &str, arrays: Vec<u8>) -> Vec<u8> {
    encode_v2(&styk_formats::container::Lifted { skeleton: skeleton.as_bytes().to_vec(), arrays, payloads: Vec::new(), reserved_offsets: Vec::new() }, Kind::Styk).unwrap()
}

#[test]
fn text_the_store_cannot_hold_survives_when_the_file_is_handed_over_as_stored() {
    // JavaScript keeps a surrogate without its pair; the store replaces it. Handed over as stored, it is kept.
    let plain = br#"{"name":"lone \ud800 surrogate","keyframes":[]}"#;
    let opened = files::open(plain, Kind::Styk, Rules::PROJECT).unwrap();
    assert_eq!((opened.version, opened.skeleton.as_slice()), (0, plain.as_slice()));
    assert!(opened.sections.is_empty() && !opened.markers, "a plain project is the document itself");
    // Bytes that are not UTF-8 are replaced, as the browser's text decoder replaces them.
    let broken = files::open(b"{\"name\":\"caf\xe9\"}", Kind::Styk, Rules::PROJECT).unwrap();
    assert_eq!(broken.skeleton, "{\"name\":\"caf\u{fffd}\"}".as_bytes());
}

#[test]
fn the_rules_that_rewrite_a_document_take_the_built_path() {
    // Browser fields are dropped, a project wrapped by an early build is unwrapped, and a missing source fingerprint is refused.
    let browser = container(r#"{"version":5,"_codec":{"x":1},"keyframes":[]}"#, Kind::Styk);
    assert_eq!(std::str::from_utf8(&files::open(&browser, Kind::Styk, Rules::PROJECT).unwrap().skeleton).unwrap(), r#"{"version":5,"keyframes":[]}"#);
    assert!(std::str::from_utf8(&files::open(&browser, Kind::Styk, Rules::RAW).unwrap().skeleton).unwrap().contains("_codec"));
    let other = container(r#"{"format":"something else","version":5}"#, Kind::Styk);
    assert!(std::str::from_utf8(&files::open(&other, Kind::Styk, Rules::PROJECT).unwrap().skeleton).unwrap().contains("something else"));
    let scalar = container("7", Kind::Styk);
    assert_eq!(files::open(&scalar, Kind::Styk, Rules::PROJECT).err().unwrap().code, Some("invalid_document"));
    assert!(files::open(&scalar, Kind::Styk, Rules::RAW).is_ok());
}

#[test]
fn a_string_that_looks_like_a_marker_is_only_a_marker_in_a_version_two_skeleton() {
    let legacy = encode_v1(br#"{"marker":"S2B:f64:0:0:5","escaped":"S2E:x"}"#, Kind::Styk);
    let opened = files::open(&legacy, Kind::Styk, Rules::PROJECT).unwrap();
    assert!(!opened.markers && opened.version == 1);
    assert_eq!(opened.skeleton, br#"{"marker":"S2B:f64:0:0:5","escaped":"S2E:x"}"#);
    assert!(files::open(&project(), Kind::Styk, Rules::PROJECT).unwrap().markers);
    // A document the rules rewrite is lifted, whatever container it came from: its markers are real.
    let wrapped = encode_v1(br#"{"format":"stykanimate","version":1,"document":{"literal":"S2B:f64:0:0:5"}}"#, Kind::Styk);
    let lifted = files::open(&wrapped, Kind::Styk, Rules::PROJECT).unwrap();
    assert!(lifted.markers);
    assert_eq!(lifted.skeleton, br#"{"literal":"S2E:S2B:f64:0:0:5"}"#);
}

/// A small deterministic generator.
struct Noise(u64);
impl Noise {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

/// JSON text shaped like a project's skeleton: records of figures and frames with the same keys again and again, numbers that
/// do not repeat, and whole records that come back far later (a figure held by several frames and clips).
fn skeleton_shaped(length: usize) -> Vec<u8> {
    let mut noise = Noise(0x2545_f491_4f6c_dd1d);
    let mut out = Vec::with_capacity(length + 4096);
    let mut records: Vec<(usize, usize)> = Vec::new();
    out.extend_from_slice(b"{\"keyframes\":[");
    while out.len() < length {
        let start = out.len();
        if !records.is_empty() && noise.below(5) == 0 {
            // A record from far back, with a few numbers changed.
            let (from, to) = records[noise.below(records.len() as u64) as usize];
            let copy = out[from..to].to_vec();
            out.extend_from_slice(&copy);
            let at = out.len() - 40.min(copy.len());
            out[at] = b'0' + noise.below(10) as u8;
        } else {
            let id = noise.below(1 << 20);
            let text = format!(
                "{{\"duration_raw\":{},\"object_slot\":{},\"unique_id\":{id},\"figure_type_id\":{},\"root_x\":{}.{:04},\"root_y\":{}.{:04},\"scale\":1,\"angles\":\"S2B:f32:0:{}:{}\",\"lengths\":\"S2B:f32:0:{}:{}\",\"len_flag\":1,\"bend_flag\":0,\"join\":null,\"_styk\":{{\"frameId\":\"frame-{}\",\"easing\":{{\"x1\":0.{},\"y1\":0.{}}}}}}}",
                1 + noise.below(4), noise.below(8), noise.below(6), noise.below(900), noise.below(10000), noise.below(500), noise.below(10000),
                noise.below(1 << 26), 30 + noise.below(30), noise.below(1 << 26), 30 + noise.below(30), noise.below(1 << 22), noise.below(1000), noise.below(1000)
            );
            out.extend_from_slice(text.as_bytes());
        }
        records.push((start, out.len()));
        out.push(b',');
    }
    out.extend_from_slice(b"null]}");
    out
}

/// Packed pose arrays: smooth angles (single precision), lengths that rarely change, whole frames that repeat after a long while.
fn arrays_shaped(length: usize) -> Vec<u8> {
    let mut noise = Noise(0x9e37_79b9_7f4a_7c15);
    let segments = 60usize;
    let lengths: Vec<f32> = (0..segments).map(|i| 20.0 + (i * 7 % 40) as f32 + noise.below(100) as f32 / 8.0).collect();
    let mut out: Vec<u8> = Vec::with_capacity(length + 1024);
    let mut frame = 0usize;
    while out.len() < length {
        if frame % 3000 == 2999 {
            // A stretch from far back comes again.
            let from = (noise.below((out.len() / 2) as u64) as usize / 4) * 4;
            let copy = out[from..from + 720 * 40].to_vec();
            out.extend_from_slice(&copy);
        }
        for (i, &len) in lengths.iter().enumerate() {
            let angle = ((frame as f32) * 0.013 + i as f32 * 0.37).sin() * 1.5 + (noise.below(64) as f32) / 4096.0;
            out.extend_from_slice(&angle.to_le_bytes());
            out.extend_from_slice(&(if frame % 211 == 0 { len + 1.0 } else { len }).to_le_bytes());
            out.extend_from_slice(&0f32.to_le_bytes());
        }
        frame += 1;
    }
    out
}

/// Picture-like payload bytes: runs and gradients with noise, rows that repeat, and a pattern that comes back megabytes later.
fn payload_shaped(length: usize) -> Vec<u8> {
    let mut noise = Noise(0xd6e8_feb8_6659_fd93);
    let mut out: Vec<u8> = Vec::with_capacity(length + 8192);
    while out.len() < length {
        let row: Vec<u8> = (0..4096).map(|x| ((x / 16) as u8).wrapping_mul(3).wrapping_add(noise.below(4) as u8)).collect();
        out.extend_from_slice(&row);
        if noise.below(7) == 0 && out.len() > (3 << 20) {
            let from = noise.below((out.len() - 8192) as u64) as usize;
            let copy = out[from..from + 8192].to_vec();
            out.extend_from_slice(&copy);
        }
    }
    out
}

#[test]
fn sections_shaped_like_real_ones_compress_to_the_frames_one_shot_compression_makes() {
    // `encode_v2` compresses each block in one call; `files::save` must write the same frames, byte for byte, because a
    // person's unchanged project has to save to the bytes it was opened from. A compressor fed in pieces, or with a small output
    // buffer, writes other (valid) frames once the input passes a few megabytes of real structure: synthetic noise does not show it.
    let skeleton = skeleton_shaped(16 << 20);
    let arrays = arrays_shaped(24 << 20);
    let payloads = payload_shaped(20 << 20);
    let shapes: [(&str, &[u8], &[u8], &[u8]); 3] = [("skeleton", &skeleton, &[], &[]), ("arrays", b"{}", &arrays, &[]), ("payloads", b"{}", &[], &payloads)];
    for (name, skeleton, arrays, payloads) in shapes {
        let one_shot = encode_v2(&styk_formats::container::Lifted { skeleton: skeleton.to_vec(), arrays: arrays.to_vec(), payloads: payloads.to_vec(), reserved_offsets: Vec::new() }, Kind::Styk).unwrap();
        let saved = files::save(Kind::Styk, skeleton, arrays, payloads, &mut NoStore, &|| false).unwrap().bytes;
        assert!(saved == one_shot, "the {name} section: {} bytes saved, {} one-shot", saved.len(), one_shot.len());
    }
}

#[test]
fn a_save_asks_whether_to_stop_often_enough_and_stops_at_once() {
    let (arrays, payloads) = (arrays_shaped(40 << 20), payload_shaped(6 << 20));
    let asked = std::cell::Cell::new(0usize);
    let saved = files::save(Kind::Styk, b"{}", &arrays, &payloads, &mut NoStore, &|| { asked.set(asked.get() + 1); false }).unwrap();
    // Hashing asks every 4 MiB; compression, one call to the compressor for a block, is asked before and after each of the three.
    let (hashing, compressing) = ((arrays.len() + payloads.len()).div_ceil(4 << 20), 6);
    assert!(asked.get() >= hashing + compressing, "{} questions for {} MiB", asked.get(), (arrays.len() + payloads.len()) >> 20);
    assert!(!saved.bytes.is_empty());
    // Whichever question says stop, the save ends there with the code the callers read, and has asked nothing since.
    for stop_at in [1, 2, hashing + 3, asked.get() - 1, asked.get()] {
        let asked = std::cell::Cell::new(0usize);
        let stopped = files::save(Kind::Styk, b"{}", &arrays, &payloads, &mut NoStore, &|| { asked.set(asked.get() + 1); asked.get() >= stop_at }).err().expect("stopped");
        assert_eq!(stopped.code, Some(styk_formats::container::CANCELLED), "stopped at question {stop_at}");
        assert_eq!(asked.get(), stop_at, "no question after the one that said stop");
    }
}

#[test]
fn a_lift_asks_whether_to_stop() {
    let document = doc(&format!("{{\"items\":[{}]}}", (0..20_000).map(|i| format!("{{\"n\":{i}}}")).collect::<Vec<_>>().join(",")));
    let asked = std::cell::Cell::new(0usize);
    styk_formats::container::lift_until(&document, &[], &|| { asked.set(asked.get() + 1); false }).unwrap();
    assert!(asked.get() >= 8, "{} questions for 40,000 values", asked.get());
    let stopped = styk_formats::container::lift_until(&document, &[], &|| true).err().expect("stopped");
    assert_eq!(stopped, styk_formats::container::ContainerError::Cancelled);
}
