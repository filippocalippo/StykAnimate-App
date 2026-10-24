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
    let saved = files::save(Kind::Styk, &opened.skeleton, &opened.sections[0], &opened.sections[1], &mut NoStore).unwrap();
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
    let saved = files::save(Kind::Stkz, figure.as_bytes(), &[], &[], &mut NoStore).err().unwrap();
    assert_eq!((saved.message_key, saved.code, saved.kind), ("errors.nativeContainer.theFigureMustBeSelfContained", Some("invalid_native_figure"), Some("stkz")));
    let movieclip = r#"{"figure_types":[{"figure_type_id":1}],"keyframes":[{"objects":[{"figure_type_id":1}]}]}"#;
    let error = files::save(Kind::Stykmov, movieclip.as_bytes(), &[], &[], &mut NoStore).err().unwrap();
    assert_eq!((error.message_key, error.code), ("errors.nativeContainer.aStykmovFileMustContainOneMovieclip", Some("invalid_movieclip")));
    assert!(files::save(Kind::Stkz, movieclip.as_bytes(), &[], &[], &mut NoStore).is_ok());
    assert!(files::save(Kind::Styk, figure.as_bytes(), &[], &[], &mut NoStore).is_ok(), "a project is not a figure file");
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
    let first = files::save(Kind::Styk, skeleton, arrays, payloads, &mut store).unwrap();
    assert_eq!((first.stats.hits, first.stats.misses, store.0.len()), (0, 3, 3));
    assert_eq!(first.stats.container_raw_bytes, skeleton.len() + arrays.len() + payloads.len());
    assert!(store.0.keys().all(|key| key.starts_with("2:3:")));
    let second = files::save(Kind::Styk, skeleton, arrays, payloads, &mut store).unwrap();
    assert_eq!(second.bytes, first.bytes);
    assert_eq!((second.stats.hits, second.stats.misses), (3, 0));
    assert_eq!(second.stats.raw_bytes_reused, first.stats.container_raw_bytes);
    // An edited array misses; the other two blocks are still found.
    let mut edited = arrays.clone();
    edited[0] ^= 1;
    let third = files::save(Kind::Styk, skeleton, &edited, payloads, &mut store).unwrap();
    assert_eq!((third.stats.hits, third.stats.misses), (2, 1));
    assert_ne!(third.bytes, first.bytes);
    let reopened = files::open(&third.bytes, Kind::Styk, Rules::RAW).unwrap();
    assert_eq!(reopened.sections[0], edited);
}

#[test]
fn saving_refuses_what_the_format_cannot_hold() {
    let error = files::save(Kind::Styk, b"{}", &vec![0; (256 << 20) + 1], &[], &mut NoStore).err().unwrap();
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
