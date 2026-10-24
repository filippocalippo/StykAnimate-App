//! Reading and writing Pivot files: the document the decoder builds, what the
//! writers keep, and the recoveries for damaged files.
//!
//! These are the behaviours `backend/test_piv_identities.py`,
//! `test_piv_type_changes.py`, `test_piv_media_recovery.py`,
//! `test_legacy_upgrade_export.py` and `test_stk_topology.py` assert, on the
//! generated fixtures; `tests/fixtures/expected.json` holds what the Python
//! codec answered for each of them.

mod common;

use std::collections::HashMap;

use common::*;
use styk_doc::{Nums, Value};
use styk_piv::{decode_document, encode_piv, encode_stk};

const NEVER: &dyn Fn() -> bool = &|| false;

fn first_object_path(document: &Value) -> Option<String> {
    (0..len(document, "keyframes")).find(|&frame| len(document, &format!("keyframes/{frame}/objects")) > 0).map(|frame| format!("keyframes/{frame}/objects/0"))
}

/// The first figure a file defines (not the built-in one) that has segments.
fn custom_figure(document: &Value) -> Option<(usize, f64)> {
    (0..len(document, "figure_types"))
        .find(|&index| number(document, &format!("figure_types/{index}/figure_type_id")) != 1.0 && len(document, &format!("figure_types/{index}/segments")) > 0)
        .map(|index| (index, number(document, &format!("figure_types/{index}/figure_type_id"))))
}

fn export_with_figure(service: &mut Service, document: &Value, source_id: &str, figure: f64) -> Vec<u8> {
    let request = object(&[("document", document.clone()), ("format", string("stk")), ("sourceId", string(source_id)), ("figureTypeId", num(figure))]);
    let response = service.post_json("/api/export", &request);
    assert_eq!(response.status, 200, "{}", String::from_utf8_lossy(&response.body));
    response.body
}

// ---- what the Python codec answered ---------------------------------------------

#[test]
fn every_fixture_imports_and_exports_as_the_python_codec_did() {
    let expected = expected();
    let files = at(&expected, "files");
    let names: Vec<String> = files.as_obj().expect("files").keys().map(|key| key.to_string()).collect();
    assert_eq!(names.len(), fixtures(".piv").len() + fixtures(".stk").len(), "expected.json covers every fixture");
    for name in names {
        let facts = at(&files, &name);
        let source = fixture(&name);
        let kind = if name.ends_with(".stk") { "stk" } else { "piv" };
        assert_eq!(sha256(&source), str_at(&facts, "source_sha256"), "{name}: regenerate with engine/tools/piv/fixtures.py");
        let mut service = Service::new();
        let imported = service.import(&name, &source);
        let id = str_at(&imported, "sourceId");
        let (_, metadata) = service.source_record(&id);
        assert_eq!(str_at(&metadata, "document_sha256"), str_at(&facts, "document_sha256"), "{name}: document fingerprint");
        assert_eq!(sha256(&service.exported(&imported, kind)), str_at(&facts, "unchanged"), "{name}: unchanged export");
        let document = at(&imported, "document");
        let mut moved = document.clone();
        set(&mut moved, "fps", num(27.0));
        if let Some(path) = first_object_path(&moved) {
            add(&mut moved, &format!("{path}/root_x"), 37.25);
        }
        let response = service.export(&moved, Some(&id), "piv");
        assert_eq!(response.status, 200, "{name}: {}", String::from_utf8_lossy(&response.body));
        assert_eq!(sha256(&response.body), str_at(&facts, "moved"), "{name}: edited export");
        // The library entry points write the same bytes as the service, for the
        // document it received (JavaScript's text has no negative zero).
        let piv_source = (kind == "piv").then_some(source.as_slice());
        let received = parse(&text(&moved));
        assert_eq!(sha256(&encode_piv(&received, piv_source, NEVER).expect("encode_piv")), str_at(&facts, "moved"), "{name}: encode_piv");
        if let Some((index, figure)) = custom_figure(&document) {
            let mut longer = document.clone();
            add(&mut longer, &format!("figure_types/{index}/segments/0/length"), 0.25);
            assert_eq!(sha256(&export_with_figure(&mut service, &longer, &id, figure)), str_at(&facts, "figure"), "{name}: figure export");
            let received = parse(&text(&longer));
            assert_eq!(sha256(&encode_stk(&received, Some(figure), NEVER).expect("encode_stk")), str_at(&facts, "figure"), "{name}: encode_stk");
        }
    }
}

// ---- the document tree ------------------------------------------------------------

#[test]
fn the_decoded_document_is_the_import_response_document() {
    for name in fixtures(".piv").into_iter().chain(fixtures(".stk")) {
        let source = fixture(&name);
        let decoded = decode_document(&source, &format!("some/dir/{name}"), NEVER).expect("decodes");
        assert_eq!(decoded.filename, name);
        assert_eq!(decoded.kind, if name.ends_with(".stk") { "stk" } else { "piv" });
        assert_eq!(decoded.version, number(&decoded.document, "version"));
        let mut service = Service::new();
        assert_eq!(at(&service.import(&name, &source), "document"), decoded.document, "{name}");
    }
}

#[test]
fn pose_arrays_are_packed_with_the_files_exact_doubles() {
    let document = decode(&fixture("modern-media.piv"), "modern-media.piv");
    let angles = at(&document, "keyframes/0/objects/0/angles");
    assert!(matches!(angles, Value::Nums(_)), "angles are a packed array");
    // Doubles a float cannot hold stay doubles.
    match at(&document, "keyframes/3/objects/0/angles").as_nums() {
        Some(Nums::F64(values)) => assert_eq!(values[0].to_bits(), 1e-300f64.to_bits()),
        other => panic!("expected double storage, got {other:?}"),
    }
    // Negative zero keeps its sign, through the tree and through the response text.
    let root_x = number(&document, "keyframes/1/objects/0/root_x");
    assert_eq!(root_x.to_bits(), (-0.0f64).to_bits());
    let bends = numbers(&document, "keyframes/1/objects/1/bends");
    assert_eq!(bends[2].to_bits(), (-0.0f64).to_bits());
    let mut service = Service::new();
    let response = service.post("/api/import?filename=modern-media.piv", &fixture("modern-media.piv"));
    let reparsed = parse(&response.body);
    assert_eq!(number(&reparsed, "document/keyframes/1/objects/0/root_x").to_bits(), (-0.0f64).to_bits());
    // Integers beyond 2^53 and beyond 1e21 are the same doubles after the round trip.
    let wide = at(&reparsed, "document/keyframes/3/objects/1");
    assert_eq!(number(&wide, "root_x"), 1e20f32 as f64);
    assert_eq!(numbers(&wide, "angles"), [-1e25]);
    assert_eq!(numbers(&wide, "lengths"), [9007199254740992.0]);
}

#[test]
fn media_is_held_as_bytes_not_text() {
    let document = decode(&fixture("modern-media.piv"), "modern-media.piv");
    let image = at(&document, "backgrounds/0/data_url");
    assert!(matches!(image, Value::Blob(_)), "a data URL is a blob");
    assert!(str_at(&document, "backgrounds/0/data_url").starts_with("data:image/png;base64,iVBORw0KGgo"));
    assert_eq!(&image.payload_bytes().expect("bytes")[..8], b"\x89PNG\r\n\x1a\n");
}

#[test]
fn files_the_decoder_refuses_are_codec_errors() {
    for (bytes, name, status, code) in [
        (&b""[..], "empty.piv", 400, "empty_file"),
        (b"not a pivot file", "broken.piv", 422, "invalid_project"),
        (b"\x09rest", "future.piv", 422, "invalid_project"),
        (b"data", "notes.txt", 415, "unsupported_file"),
    ] {
        let error = decode_document(bytes, name, NEVER).expect_err(name);
        assert_eq!((error.status, error.code.as_str()), (status, code), "{name}: {error}");
    }
    let always = || true;
    let error = decode_document(&fixture("modern-media.piv"), "modern-media.piv", &always).expect_err("cancelled");
    assert_eq!((error.status, error.code.as_str()), (499, "cancelled"));
}

// ---- writing ----------------------------------------------------------------------

#[test]
fn an_unedited_document_writes_its_source_back() {
    // Where the Python writer gave the source back for the imported document.
    // (For files whose records it normalizes, renamed IDs, recovered images
    // and legacy files it writes another file; the service still answers the
    // source for those, because the document's fingerprint is the source's.)
    for name in ["blank.piv", "modern-type-change.piv"] {
        let source = fixture(name);
        let document = decode(&source, name);
        assert_eq!(encode_piv(&document, Some(&source), NEVER).expect("encode_piv"), source, "{name}");
    }
}

#[test]
fn a_new_document_needs_no_source() {
    let mut document = decode(&fixture("blank.piv"), "blank.piv");
    set(&mut document, "canvas_width", num(1280.0));
    let mut object = decode(&fixture("modern-type-change.piv"), "x.piv");
    object = at(&object, "keyframes/0/objects/0");
    for key in ["record_offset", "record_end"] {
        remove(&mut object, key);
    }
    set(&mut object, "root_x", num(640.0));
    push(&mut document, "keyframes/0/objects", object);
    set(&mut document, "keyframes/0/object_draw_order", Value::nums(&[0.0]));
    set(&mut document, "keyframes/0/object_draw_order_unique_ids", Value::nums(&[10.0]));
    let output = encode_piv(&document, None, NEVER).expect("encode_piv");
    let restored = decode(&output, "new.piv");
    assert_eq!(number(&restored, "canvas_width"), 1280.0);
    assert_eq!(number(&restored, "keyframes/0/objects/0/root_x"), 640.0);
    let legacy = decode(&fixture("legacy-v4.piv"), "legacy-v4.piv");
    let error = encode_piv(&legacy, None, NEVER).expect_err("a legacy document without its source");
    assert_eq!((error.status, error.code.as_str()), (422, "missing_legacy_source"));
}

#[test]
fn a_figure_file_round_trips_through_the_writer() {
    let source = fixture("figure-modern.stk");
    let document = decode(&source, "figure-modern.stk");
    let written = encode_stk(&document, Some(2.0), NEVER).expect("encode_stk");
    let again = decode(&written, "figure-modern.stk");
    // The writer numbers joints and orders records itself; the geometry is what it keeps.
    let geometry = |document: &Value| {
        let mut segments: Vec<(u64, u64)> = (0..len(document, "figure_types/1/segments"))
            .map(|index| (number(document, &format!("figure_types/1/segments/{index}/length")).to_bits(), number(document, &format!("figure_types/1/segments/{index}/angle_rad")).to_bits()))
            .collect();
        segments.sort();
        segments
    };
    assert_eq!(geometry(&again), geometry(&document));
    assert_eq!(encode_stk(&again, Some(2.0), NEVER).expect("encode_stk"), written, "writing is stable");
    let error = encode_stk(&document, Some(9.0), NEVER).expect_err("no such figure");
    assert_eq!(error.message, "Select a figure to export as STK");
}

#[test]
fn exports_are_stable_across_round_trips() {
    for name in ["modern-media.piv", "legacy-v3.piv", "modern-identities.piv"] {
        let mut service = Service::new();
        let imported = service.import(name, &fixture(name));
        let mut document = at(&imported, "document");
        let path = first_object_path(&document).expect("an object");
        add(&mut document, &format!("{path}/root_x"), 1.5);
        let first = service.export(&document, Some(&str_at(&imported, "sourceId")), "piv").body;
        let again = service.import("again.piv", &first);
        assert_eq!(service.exported(&again, "piv"), first, "{name}: an unchanged re-export is the same file");
        // And a re-export of the re-read document after another edit writes the same file each time.
        let mut edited = at(&again, "document");
        add(&mut edited, "fps", 1.0);
        let second = service.export(&edited, Some(&str_at(&again, "sourceId")), "piv").body;
        assert_eq!(service.export(&edited, Some(&str_at(&again, "sourceId")), "piv").body, second);
        assert_eq!(number(&decode(&second, "second.piv"), "fps"), number(&edited, "fps"));
    }
}

// ---- duplicate object IDs (test_piv_identities.py) --------------------------------

fn unique_ids(document: &Value, frame: usize) -> Vec<f64> {
    column_numbers(document, &format!("keyframes/{frame}/objects"), "unique_id")
}

#[test]
fn duplicate_ids_get_new_identities_and_keep_their_slots() {
    let compressed = fixture("modern-identities.piv");
    for source in [inflate(&compressed), compressed] {
        let document = decode(&source, "identities.piv");
        assert_eq!(column_numbers(&document, "keyframes", "duration_raw"), [4.0, 0.0, 3.0, 1.0]);
        assert_eq!(number(&document, "total_output_frames"), 8.0);
        assert_eq!(unique_ids(&document, 0), [4294967295.0, 10.0, 4.0, 5.0, 0.0, 2147483648.0]);
        assert_eq!(unique_ids(&document, 1), [4294967295.0, 10.0, 6.0, 7.0, 0.0, 2147483648.0]);
        for frame in 0..4 {
            assert_eq!(numbers(&document, &format!("keyframes/{frame}/object_draw_order")), [4.0, 1.0, 5.0, 0.0, 3.0, 2.0]);
            for slot in 0..6 {
                let path = format!("keyframes/{frame}/objects/{slot}");
                assert_eq!(number(&document, &format!("{path}/object_slot")), slot as f64);
                assert_eq!(number(&document, &format!("{path}/root_x")), 100.0 + 60.0 * slot as f64 + frame as f64);
            }
            assert_eq!(number(&document, &format!("keyframes/{frame}/objects/4/join/target_object_slot")), 2.0);
            assert_eq!(number(&document, &format!("keyframes/{frame}/objects/4/join/target_unique_id")), unique_ids(&document, frame)[2]);
        }
        assert_eq!(len(&document, "piv_identity_recovery/objects"), 4);
        assert_eq!(str_at(&document, "import_warnings/0/code"), "piv_duplicate_object_ids");
        assert!(str_at(&document, "import_warnings/0/message").contains("keyframes 1, 2"));
    }
}

#[test]
fn the_frame_transport_changes_only_the_renamed_ids() {
    let source = fixture("modern-identities.piv");
    let payload = inflate(&source);
    for frames_first in [true, false] {
        let mut service = Service::new();
        if !frames_first {
            service.import("identities.piv", &source);
        }
        let (packet, frames) = service.import_frames("identities.piv", &source, None);
        let document = at(&service.import("identities.piv", &source), "document");
        let start = number(&packet, "nativeFrames/sourceOffset") as usize;
        let mut expected = payload[start..start + frames.len()].to_vec();
        for index in 0..len(&document, "piv_identity_recovery/objects") {
            let repair = format!("piv_identity_recovery/objects/{index}");
            let at = number(&document, &format!("{repair}/record_offset")) as usize - start;
            expected[at..at + 4].copy_from_slice(&(number(&document, &format!("{repair}/unique_id")) as u32).to_le_bytes());
        }
        assert_eq!(frames, expected);
    }
}

#[test]
fn renamed_ids_survive_unchanged_exports_native_saves_and_edits() {
    let source = fixture("modern-identities.piv");
    let mut service = Service::new();
    let imported = service.import("identities.piv", &source);
    assert_eq!(service.exported(&imported, "piv"), source);
    let native = service.exported(&imported, "styk");
    let mut fresh = Service::new();
    let reopened = fresh.import("restored.styk", &native);
    assert_eq!(fresh.exported(&reopened, "piv"), source);

    let mut document = at(&imported, "document");
    add(&mut document, "keyframes/0/objects/2/root_x", 0.25);
    let saved = service.export(&document, Some(&str_at(&imported, "sourceId")), "piv").body;
    let restored = decode(&saved, "edited.piv");
    assert!(!has(&restored, "piv_identity_recovery"), "the written file has unique IDs");
    for frame in 0..len(&document, "keyframes") {
        let path = format!("keyframes/{frame}");
        assert_eq!(number(&restored, &format!("{path}/duration_raw")), number(&document, &format!("{path}/duration_raw")));
        assert_eq!(numbers(&restored, &format!("{path}/object_draw_order_unique_ids")), numbers(&document, &format!("{path}/object_draw_order_unique_ids")));
        let by_id: HashMap<u64, usize> = unique_ids(&restored, frame).iter().enumerate().map(|(slot, &id)| (id as u64, slot)).collect();
        assert_eq!(by_id.len(), len(&document, &format!("{path}/objects")));
        for (slot, id) in unique_ids(&document, frame).into_iter().enumerate() {
            let (before, after) = (format!("{path}/objects/{slot}"), format!("{path}/objects/{}", by_id[&(id as u64)]));
            for key in ["root_x", "root_y", "angles", "lengths", "bends", "figure_type_id"] {
                assert_eq!(at(&restored, &format!("{after}/{key}")), at(&document, &format!("{before}/{key}")), "{before}/{key}");
            }
            if !at(&document, &format!("{before}/join")).is_null() {
                assert_eq!(at(&restored, &format!("{after}/join/target_unique_id")), at(&document, &format!("{before}/join/target_unique_id")));
            }
        }
    }
}

#[test]
fn recovery_never_hides_later_corruption() {
    let payload = inflate(&fixture("modern-identities.piv"));
    let document = decode(&payload, "identities.piv");
    let last = format!("keyframes/{}/objects/5", len(&document, "keyframes") - 1);
    let (offset, end) = (number(&document, &format!("{last}/record_offset")) as usize, number(&document, &format!("{last}/record_end")) as usize);
    let mut nan = payload.clone();
    nan[offset + 6..offset + 10].copy_from_slice(&f32::NAN.to_le_bytes());
    let mut order = payload.clone();
    order[end..end + 2].copy_from_slice(&65535u16.to_le_bytes());
    let truncated = payload[..offset + 10].to_vec();
    for broken in [nan, order, truncated] {
        for bytes in [deflate(&broken), broken] {
            let error = decode_document(&bytes, "broken.piv", NEVER).expect_err("corrupt");
            assert_eq!(error.code, "invalid_project");
            assert!(!error.message.contains("duplicate"), "{}", error.message);
            let mut service = Service::new();
            let response = service.call("POST", "/api/import?filename=broken.piv", &[("Accept", styk_piv::NATIVE_FRAMES_CONTENT_TYPE)], &bytes);
            assert_eq!(outcome(&response), (422, "invalid_project".to_string()));
        }
    }
    // A failed import leaves nothing behind for the next one.
    assert_eq!(decode(&payload, "identities.piv"), document);
}

// ---- figure type changes (test_piv_type_changes.py) --------------------------------

/// The type-change fixture with these holds on its first two keys.
fn with_holds(outgoing: u16, incoming: u16) -> Vec<u8> {
    let mut payload = inflate(&fixture("modern-type-change.piv"));
    let document = decode(&payload, "type-change.piv");
    for (frame, hold) in [(0, outgoing), (1, incoming)] {
        let at = number(&document, &format!("keyframes/{frame}/record_offset")) as usize;
        payload[at..at + 2].copy_from_slice(&hold.to_le_bytes());
    }
    payload
}

#[test]
fn a_figure_may_change_type_between_keys_whatever_the_holds() {
    for outgoing in [0u16, 1, 4, 65535] {
        for incoming in [0u16, 1, 3] {
            let raw = with_holds(outgoing, incoming);
            for bytes in [deflate(&raw), raw] {
                let document = decode(&bytes, "type-change.piv");
                assert_eq!(column_numbers(&document, "keyframes", "duration_raw"), [outgoing as f64, incoming as f64, 1.0]);
                let types: Vec<f64> = (0..3).map(|frame| number(&document, &format!("keyframes/{frame}/objects/0/figure_type_id"))).collect();
                assert_eq!(types, [1.0, 2.0, 2.0]);
                assert!(len(&document, "keyframes/0/objects/0/angles") > len(&document, "keyframes/1/objects/0/angles"));
                assert_eq!(number(&document, "keyframes/1/objects/2/join/target_unique_id"), 10.0);
                assert_eq!(number(&document, "total_output_frames"), outgoing as f64 + incoming as f64 + 1.0);
                let (packet, _) = Service::new().import_frames("type-change.piv", &bytes, None);
                assert_eq!(number(&packet, "document/total_output_frames"), outgoing as f64 + incoming as f64 + 1.0);
            }
        }
    }
}

#[test]
fn a_long_project_keeps_every_frame_through_piv_and_native_saves() {
    let source = fixture("modern-type-change.piv");
    let mut service = Service::new();
    let imported = service.import("type-change.piv", &source);
    let mut document = at(&imported, "document");
    let template = at(&document, "keyframes/1");
    let mut frames = vec![at(&document, "keyframes/0")];
    for index in 1..1129 {
        let mut frame = template.clone();
        set(&mut frame, "duration_raw", num(if index == 1 { 3.0 } else { 1.0 }));
        set(&mut frame, "objects/0/root_x", num(150.0 + index as f64 * 40.0));
        set(&mut frame, "objects/1/root_x", num(350.0 + index as f64 * 40.0));
        frames.push(frame);
    }
    set(&mut document, "keyframes", Value::array(frames));
    let long = service.export(&document, Some(&str_at(&imported, "sourceId")), "piv").body;
    let imported = service.import("long.piv", &long);
    let mut document = at(&imported, "document");
    assert_eq!(len(&document, "keyframes"), 1129);
    assert_eq!(number(&document, "total_output_frames"), 1134.0);
    assert_eq!(service.exported(&imported, "piv"), long);
    add(&mut document, "keyframes/1/objects/0/root_x", 0.25);
    for format in ["piv", "styk"] {
        let saved = service.export(&document, Some(&str_at(&imported, "sourceId")), format).body;
        let restored = at(&Service::new().import(&format!("restored.{format}"), &saved), "document");
        assert_eq!(len(&restored, "keyframes"), 1129);
        assert_eq!(column(&restored, "keyframes", "duration_raw"), column(&document, "keyframes", "duration_raw"));
        for frame in 0..1129 {
            let path = format!("keyframes/{frame}");
            assert_eq!(at(&restored, &format!("{path}/object_draw_order_unique_ids")), at(&document, &format!("{path}/object_draw_order_unique_ids")));
            for slot in 0..3 {
                for key in ["unique_id", "figure_type_id", "root_x", "angles", "lengths", "bends", "join"] {
                    let field = format!("{path}/objects/{slot}/{key}");
                    assert_eq!(at(&restored, &field), at(&document, &field), "{format}: {field}");
                }
            }
        }
    }
}

// ---- image records (test_piv_media_recovery.py) -------------------------------------

const JPEG: &[u8] = b"\xff\xd8\xff\xe1\x00\x08meta\xff\xd9\xff\xda\x00\x02abc\xff\x00\xd9\xff\xd0def\xff\xc4\x00\x04hi\xff\xda\x00\x02xyz\xff\xd9";

#[test]
fn a_jpeg_record_keeps_its_stored_extent_but_not_the_bytes_after_the_image() {
    let source = fixture("legacy-v4.piv");
    let document = decode(&source, "legacy-v4.piv");
    let stored = JPEG.len() + b"old data after the image\xff\xd9".len();
    assert_eq!(at(&document, "backgrounds/1/data_url").payload_bytes().as_deref(), Some(JPEG));
    assert_eq!(number(&document, "backgrounds/1/source_size"), (8 + stored) as f64);
    assert_eq!(str_at(&document, "backgrounds/1/name"), "Sky");
    assert_eq!(number(&document, "fps"), 15.0);
    let mut service = Service::new();
    let imported = service.import("legacy-v4.piv", &source);
    assert_eq!(service.exported(&imported, "piv"), source);
    let mut wider = at(&imported, "document");
    add(&mut wider, "canvas_width", 10.0);
    let changed = service.export(&wider, Some(&str_at(&imported, "sourceId")), "piv").body;
    let restored = decode(&changed, "changed.piv");
    assert_eq!((number(&restored, "version"), number(&restored, "canvas_width")), (5.0, 650.0));
    // Held legacy frames become keys of the same background (the Python migration's answer).
    assert_eq!(column_numbers(&restored, "keyframes", "background_id"), [0.0, 1.0, 1.0, 2.0, 2.0, 0.0, 0.0]);
    assert_eq!(column(&restored, "backgrounds", "name"), [string("Board"), string("Sky")]);
}

/// The missing-image fixture without its end pointer, with `pointer` stored
/// where the end pointer goes and `name` as the figure name.
fn missing_image(pointer: Option<u64>, name: &[u8]) -> Vec<u8> {
    const POINTER_AT: usize = 59;
    let omitted = fixture("modern-missing-image-omitted.piv");
    let rest = &omitted[POINTER_AT + 2 + 1 + "Empty image".len()..];
    let mut out = omitted[..POINTER_AT].to_vec();
    if let Some(pointer) = pointer {
        out.extend_from_slice(&pointer.to_le_bytes());
    }
    out.extend_from_slice(&[0, 0, name.len() as u8]);
    out.extend_from_slice(name);
    out.extend_from_slice(rest);
    out
}

#[test]
fn the_rebuilt_omitted_fixture_is_the_committed_one() {
    assert_eq!(missing_image(None, b"Empty image"), fixture("modern-missing-image-omitted.piv"));
    assert_eq!(deflate(&missing_image(Some(59), b"Empty image")), fixture("modern-missing-image-unpatched.piv"));
    assert_eq!(deflate(&missing_image(Some(67), b"Empty image")), fixture("modern-missing-image-empty.piv"));
}

#[test]
fn image_records_without_pixels_keep_their_objects() {
    for name in ["modern-missing-image-unpatched.piv", "modern-missing-image-omitted.piv", "modern-missing-image-empty.piv"] {
        let stored = fixture(name);
        let raw = if stored[0] == 5 { stored.clone() } else { inflate(&stored) };
        for bytes in [raw.clone(), deflate(&raw)] {
            let document = decode(&bytes, name);
            let asset = at(&document, "figure_types/1/image_assets/0");
            assert_eq!(&at(&asset, "data_base64").payload_bytes().expect("bytes")[..8], b"\x89PNG\r\n\x1a\n", "{name}: a placeholder image");
            assert_eq!(at(&asset, "missing_image_data"), Value::Bool(true));
            assert_eq!(number(&asset, "anchor_length"), 300.0);
            assert_eq!((number(&document, "keyframes/0/objects/0/unique_id"), number(&document, "keyframes/0/objects/0/figure_type_id")), (77.0, 2.0));
            assert_eq!(str_at(&document, "import_warnings/0/code"), "piv_missing_image_data");
            let (packet, _) = Service::new().import_frames(name, &bytes, None);
            assert_eq!(at(&packet, "document/figure_types"), at(&document, "figure_types"));
            assert_eq!(at(&packet, "document/piv_missing_images"), at(&document, "piv_missing_images"));
        }
    }
}

#[test]
fn a_recovered_image_round_trips_and_stays_editable() {
    for name in ["modern-missing-image-unpatched.piv", "modern-missing-image-omitted.piv"] {
        let source = fixture(name);
        let mut service = Service::new();
        service.import_frames(name, &source, None);
        let imported = service.import(name, &source);
        assert_eq!(service.exported(&imported, "piv"), source, "{name}");
        let native = service.exported(&imported, "styk");
        let mut restarted = Service::new();
        let reopened = restarted.import("image.styk", &native);
        assert_eq!(restarted.exported(&reopened, "piv"), source, "{name}");
        let mut document = at(&imported, "document");
        set(&mut document, "keyframes/0/objects/0/root_x", num(123.5));
        let changed = service.export(&document, Some(&str_at(&imported, "sourceId")), "piv").body;
        let restored = decode(&changed, "changed.piv");
        assert_eq!(number(&restored, "keyframes/0/objects/0/root_x"), 123.5);
        assert_eq!(len(&restored, "figure_types"), 2);
        assert_eq!(at(&restored, "figure_types/1/image_assets/0/data_base64"), at(&document, "figure_types/1/image_assets/0/data_base64"));
    }
}

#[test]
fn recovery_accepts_only_the_known_pointer_shapes() {
    for pointer in [0, 58, 60, 66, u64::MAX] {
        assert!(decode_document(&missing_image(Some(pointer), b"Empty image"), "image.piv", NEVER).is_err(), "pointer {pointer}");
    }
    for name in [&b""[..], b"\x01bad"] {
        assert!(decode_document(&missing_image(None, name), "image.piv", NEVER).is_err(), "name {name:?}");
    }
    let raw = missing_image(None, b"Empty image");
    for end in 0..raw.len() - 5 {
        assert!(decode_document(&raw[..end], "image.piv", NEVER).is_err(), "truncated at {end}");
    }
    let mut no_rate = raw.clone();
    let at = no_rate.len() - 5;
    no_rate[at..at + 4].copy_from_slice(&0u32.to_le_bytes());
    let response = Service::new().call("POST", "/api/import?filename=image.piv", &[("Accept", styk_piv::NATIVE_FRAMES_CONTENT_TYPE)], &no_rate);
    assert_eq!(outcome(&response), (422, "invalid_project".to_string()));
}

// ---- legacy projects upgraded to Pivot 5 (test_legacy_upgrade_export.py) --------------

struct Upgrade {
    service: Service,
    imported: Value,
    legacy: Value,
    modern: Value,
    source: Vec<u8>,
}

/// A legacy project, and the version 5 document the editor makes of it (which
/// keeps the legacy source; `upgraded-*.json`, made by the Python migration), edited.
fn upgraded(name: &str) -> Upgrade {
    let source = fixture(name);
    let mut service = Service::new();
    let imported = service.import(name, &source);
    let legacy = at(&imported, "document");
    assert!(number(&legacy, "version") < 5.0);
    let mut modern = parse(&fixture(&format!("upgraded-{}", name.replace(".piv", ".json"))));
    assert_eq!(at(&modern, "source_sha256"), at(&legacy, "source_sha256"));
    set(&mut modern, "fps", num(27.0));
    add(&mut modern, "keyframes/0/objects/0/root_x", 37.25);
    add(&mut modern, "keyframes/0/objects/0/angles/0", 0.125);
    let mut copy = at(&modern, "keyframes/0");
    set(&mut copy, "keyframe_index", num(len(&modern, "keyframes") as f64));
    push(&mut modern, "keyframes", copy);
    Upgrade { service, imported, legacy, modern, source }
}

fn assert_scene(output: &[u8], modern: &Value) {
    let actual = decode(output, "upgraded.piv");
    assert_eq!((number(&actual, "version"), number(&actual, "fps")), (5.0, 27.0));
    assert_eq!(len(&actual, "keyframes"), len(modern, "keyframes"));
    assert!((number(&actual, "keyframes/0/objects/0/root_x") - number(modern, "keyframes/0/objects/0/root_x")).abs() < 1e-3);
    assert_eq!(numbers(&actual, "keyframes/0/objects/0/angles"), numbers(modern, "keyframes/0/objects/0/angles"));
    assert_eq!(len(&actual, "figure_types"), len(modern, "figure_types"));
    assert_eq!(len(&actual, "backgrounds"), len(modern, "backgrounds"));
    for index in 0..len(modern, "figure_types") {
        let assets = |document: &Value| if has(document, &format!("figure_types/{index}/image_assets")) { len(document, &format!("figure_types/{index}/image_assets")) } else { 0 };
        assert_eq!(assets(&actual), assets(modern));
    }
}

#[test]
fn an_upgraded_legacy_project_exports_as_edited_and_keeps_its_source() {
    for name in ["legacy-v2.piv", "legacy-v3.piv", "legacy-v4.piv"] {
        let Upgrade { mut service, imported, legacy, modern, source } = upgraded(name);
        let id = str_at(&imported, "sourceId");
        let response = service.export(&modern, Some(&id), "piv");
        assert_eq!(response.status, 200, "{name}: {}", String::from_utf8_lossy(&response.body));
        assert_scene(&response.body, &modern);
        assert!(header(&response, "Content-Disposition").ends_with(".piv"));
        assert_eq!(service.source_record(&id).0, source);
        // Undo back to the legacy document: the original file again.
        assert_eq!(service.export(&legacy, Some(&id), "piv").body, source, "{name}");
    }
}

#[test]
fn a_native_save_of_an_upgrade_keeps_the_original_and_the_edits() {
    for name in ["legacy-v2.piv", "legacy-v3.piv", "legacy-v4.piv"] {
        let Upgrade { mut service, imported, legacy, modern, source } = upgraded(name);
        let native = service.export(&modern, Some(&str_at(&imported, "sourceId")), "styk").body;
        let mut restarted = Service::new();
        let reopened = restarted.import("upgraded.styk", &native);
        let document = at(&reopened, "document");
        let provenance = at(&document, "_stykSource");
        assert_eq!(number(&provenance, "version"), number(&legacy, "version"));
        assert_eq!(str_at(&provenance, "sha256"), sha256(&source));
        assert_eq!(at(&provenance, "source_base64").payload_bytes().as_deref(), Some(source.as_slice()));
        assert_scene(&restarted.exported(&reopened, "piv"), &modern);
        // The embedded original is enough without the service's cache.
        assert_scene(&restarted.export(&document, None, "piv").body, &modern);
        let again = restarted.exported(&reopened, "styk");
        let saved_again = at(&Service::new().import("again.styk", &again), "document");
        assert_eq!(at(&saved_again, "_stykSource"), provenance);
        assert_eq!(at(&document, "source_sha256"), at(&legacy, "source_sha256"));
    }
}

#[test]
fn the_embedded_version_cannot_choose_the_wrong_writer() {
    let Upgrade { mut service, imported, modern, .. } = upgraded("legacy-v3.piv");
    let native = service.export(&modern, Some(&str_at(&imported, "sourceId")), "styk").body;
    let mut saved = at(&Service::new().import("upgraded.styk", &native), "document");
    set(&mut saved, "_stykSource/version", num(5.0));
    assert_scene(&service.export(&saved, None, "piv").body, &modern);
    assert_scene(&service.export(&saved, Some(&str_at(&imported, "sourceId")), "piv").body, &modern);
}

#[test]
fn a_document_of_another_source_is_refused() {
    let Upgrade { mut service, imported, mut modern, .. } = upgraded("legacy-v2.piv");
    let id = str_at(&imported, "sourceId");
    let native = service.export(&modern, Some(&id), "styk").body;
    set(&mut modern, "source_sha256", string(&"0".repeat(64)));
    let response = service.export(&modern, Some(&id), "piv");
    assert_eq!(outcome(&response), (422, "invalid_project".to_string()));
    assert!(error_text(&response).contains("different original source"));
    let mut saved = at(&Service::new().import("upgraded.styk", &native), "document");
    set(&mut saved, "source_sha256", string(&"0".repeat(64)));
    assert!(error_text(&service.export(&saved, None, "piv")).contains("different original source"));
}

#[test]
fn a_corrupt_embedded_original_is_refused() {
    let Upgrade { mut service, imported, modern, .. } = upgraded("legacy-v2.piv");
    let native = service.export(&modern, Some(&str_at(&imported, "sourceId")), "styk").body;
    let mut saved = at(&Service::new().import("upgraded.styk", &native), "document");
    set(&mut saved, "_stykSource/sha256", string(&"0".repeat(64)));
    let response = service.export(&saved, None, "piv");
    assert_eq!(outcome(&response), (422, "invalid_project".to_string()));
    assert!(error_text(&response).contains("fingerprint"), "{}", error_text(&response));
    // A matching fingerprint does not make bytes a Pivot file.
    for malformed in [b"\x02".to_vec(), deflate(b"\x03broken"), deflate(b"")] {
        let digest = sha256(&malformed);
        set(&mut saved, "source_sha256", string(&digest));
        set(&mut saved, "_stykSource/sha256", string(&digest));
        set(&mut saved, "_stykSource/source_base64", string(&base64(&malformed)));
        assert_eq!(outcome(&service.export(&saved, None, "piv")), (422, "invalid_project".to_string()));
    }
    // An expired cache entry is not replaced by the embedded bytes.
    let saved = at(&Service::new().import("upgraded.styk", &native), "document");
    assert_eq!(outcome(&service.export(&saved, Some("expired"), "piv")), (410, "source_expired".to_string()));
}

#[test]
fn a_legacy_document_must_keep_its_version() {
    let Upgrade { mut service, imported, mut legacy, .. } = upgraded("legacy-v2.piv");
    set(&mut legacy, "version", num(3.0));
    let response = service.export(&legacy, Some(&str_at(&imported, "sourceId")), "piv");
    assert_eq!(outcome(&response), (422, "invalid_project".to_string()));
    assert!(error_text(&response).contains("version does not match"), "{}", error_text(&response));
}

fn base64(bytes: &[u8]) -> String {
    let mut out = Vec::new();
    styk_doc::json::base64_into(bytes, &mut out);
    String::from_utf8(out).expect("ASCII")
}

// ---- figure topology (test_stk_topology.py) -----------------------------------------

/// A modern figure file: explicit joint IDs (a parent may come later), bends, no media.
fn modern_stk(segments: &[(u16, u16, f32, f64, f64)]) -> Vec<u8> {
    let mut payload = vec![1 | 2 | 4 | 8 | 16 | 128];
    payload.extend_from_slice(&(segments.len() as u16).to_le_bytes());
    for &(id, parent, length, angle, _) in segments {
        payload.extend_from_slice(&parent.to_le_bytes());
        payload.extend_from_slice(&id.to_le_bytes());
        payload.extend_from_slice(&length.to_le_bytes());
        payload.extend_from_slice(&angle.to_le_bytes());
        payload.extend_from_slice(&4.0f32.to_le_bytes());
    }
    let bends: Vec<(usize, f64)> = segments.iter().enumerate().filter(|(_, s)| s.4 != 0.0).map(|(index, s)| (index, s.4)).collect();
    payload.extend_from_slice(&(bends.len() as u16).to_le_bytes());
    for (index, bend) in bends {
        payload.extend_from_slice(&(index as u16).to_le_bytes());
        payload.extend_from_slice(&bend.to_le_bytes());
    }
    payload.extend_from_slice(&0u16.to_le_bytes());
    let mut out = vec![0x79];
    out.extend_from_slice(&deflate(&payload));
    out
}

#[test]
fn a_figure_keeps_its_authored_record_order() {
    let chain: Vec<(u16, u16, f32, f64, f64)> = (1..=200u16).map(|id| (id, id - 1, 1.25, ((id % 11) as f64 - 5.0) * 0.07, if id % 5 == 0 { -0.035 } else { 0.0 })).collect();
    let reversed: Vec<_> = chain.iter().rev().copied().collect();
    let mut shuffled = chain.clone();
    let mut state = 9181u64;
    for index in (1..shuffled.len()).rev() {
        state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        shuffled.swap(index, ((state >> 33) % (index as u64 + 1)) as usize);
    }
    for ordering in [chain, reversed, shuffled] {
        let document = decode(&modern_stk(&ordering), "exact-topology.stk");
        let ids: Vec<f64> = ordering.iter().map(|s| s.0 as f64).collect();
        assert_eq!(column_numbers(&document, "figure_types/1/segments", "segment_id"), ids);
        assert_eq!(str_at(&document, "figure_types/1/name"), "exact-topology");
    }
}

#[test]
fn missing_parents_and_cycles_are_refused() {
    for segments in [vec![(1u16, 9u16, 1.25f32, 0.0, 0.0)], vec![(1, 2, 1.25, 0.0, 0.0), (2, 1, 1.25, 0.0, 0.0)]] {
        let error = decode_document(&modern_stk(&segments), "malformed-topology.stk", NEVER).expect_err("bad topology");
        assert_eq!(error.code, "invalid_project");
    }
}
