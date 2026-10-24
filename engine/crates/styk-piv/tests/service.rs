//! The request service: routes, limits, the source cache and its leases.
//!
//! These are the behaviours `backend/test_browser_service.py` and
//! `backend/test_source_lifetime.py` assert, asked of [`styk_piv::Codec`].

mod common;

use common::*;
use styk_doc::Value;
use styk_piv::{Codec, Limits};

fn blank() -> Vec<u8> {
    fixture("blank.piv")
}

#[test]
fn health_reports_the_host_formats_and_import_limit() {
    let mut web = Service::with(Limits::web());
    let health = parse(&web.get("/api/health").body);
    assert_eq!(str_at(&health, "host"), "browser");
    assert_eq!(at(&health, "ok"), Value::Bool(true));
    assert_eq!(column(&health, "formats", "").iter().map(|v| v.as_str().unwrap().to_string()).collect::<Vec<_>>(), ["piv", "stk", "styk", "stkz", "stykmov"]);
    assert_eq!(numbers(&health, "versions"), [2.0, 3.0, 4.0, 5.0]);
    assert_eq!(number(&health, "maxImportBytes"), 96.0 * 1024.0 * 1024.0);
    let mut desktop = Service::new();
    let health = parse(&desktop.get("/api/health").body);
    assert!(!has(&health, "host"), "the desktop service names no host");
    assert_eq!(number(&health, "maxImportBytes"), 128.0 * 1024.0 * 1024.0);
}

#[test]
fn the_documented_limits_are_the_python_services() {
    const MIB: usize = 1024 * 1024;
    let web = Limits::web();
    assert_eq!((web.max_source, web.max_document, web.max_cache), (96 * MIB, 128 * MIB, 160 * MIB));
    let desktop = Limits::desktop();
    assert_eq!((desktop.max_source, desktop.max_document, desktop.max_cache, desktop.max_cache_entries), (128 * MIB, 256 * MIB, 384 * MIB, 24));
}

#[test]
fn workspace_routes_are_unavailable_not_broken() {
    let mut service = Service::new();
    let samples = service.get("/api/samples");
    assert_eq!(samples.body, br#"{"ok":true,"samples":[]}"#);
    assert_eq!(outcome(&service.post("/api/open", br#"{"path":"x.piv"}"#)), (404, "workspace_unavailable".to_string()));
}

#[test]
fn unknown_routes_and_methods_are_404() {
    let mut service = Service::new();
    for (method, target) in [("GET", "/api/nope"), ("POST", "/api/health"), ("GET", "/api/import"), ("DELETE", "/api/export")] {
        let response = service.call(method, target, &[], b"");
        assert_eq!(outcome(&response), (404, "route_not_found".to_string()), "{method} {target}");
        assert!(header(&response, "Content-Type").starts_with("application/json"));
    }
}

#[test]
fn cancel_is_a_successful_no_op() {
    let mut service = Service::new();
    let response = service.post("/api/cancel?id=abc", b"");
    assert_eq!((response.status, response.body.len()), (204, 0));
}

#[test]
fn import_then_export_returns_a_readable_pivot_file() {
    let mut service = Service::new();
    let imported = service.import("blank.piv", &blank());
    assert_eq!((at(&imported, "ok"), str_at(&imported, "kind")), (Value::Bool(true), "piv".to_string()));
    let request = text(&object(&[
        ("document", at(&imported, "document")),
        ("format", string("piv")),
        ("filename", string("blank.piv")),
        ("sourceId", at(&imported, "sourceId")),
    ]));
    let response = service.post("/api/export", &request);
    assert_eq!(response.status, 200);
    assert!(header(&response, "Content-Disposition").contains("blank.piv"));
    assert_eq!(header(&response, "X-Styk-Request-Bytes"), request.len().to_string());
    let stages: Vec<&str> = header(&response, "Server-Timing").split(", ").map(|stage| stage.split(";dur=").next().unwrap()).collect();
    assert_eq!(stages, ["receive", "parse", "validate", "source_digest", "provenance", "document_digest", "encode", "total"]);
    assert_eq!(number(&decode(&response.body, "exported.piv"), "canvas_width"), 640.0);
}

#[test]
fn timings_come_from_the_clock_the_host_supplies() {
    let mut codec = Codec::new(Limits::desktop());
    let ticks = std::cell::Cell::new(0.0);
    codec.set_clock(Box::new(move || {
        ticks.set(ticks.get() + 1.5);
        ticks.get()
    }));
    let response = codec.request("POST", "/api/import?filename=blank.piv", &[], &blank(), &|| false);
    let imported = parse(&response.body);
    assert!(number(&imported, "timings/total_ms") > 0.0);
    assert!(number(&imported, "timings/decode_ms") > 0.0);
    // Without a clock the library reads no time at all.
    let mut service = Service::new();
    let imported = service.import("blank.piv", &blank());
    assert_eq!((number(&imported, "timings/total_ms"), number(&imported, "timings/decode_ms")), (0.0, 0.0));
}

#[test]
fn the_retained_source_is_served_for_native_saves() {
    let mut service = Service::new();
    let imported = service.import("blank.piv", &blank());
    let (source, metadata) = service.source_record(&str_at(&imported, "sourceId"));
    assert_eq!(source, blank());
    assert_eq!((str_at(&metadata, "kind"), number(&metadata, "version"), number(&metadata, "document_digest_version")), ("piv".to_string(), 5.0, 3.0));
    assert_eq!(outcome(&service.get("/api/source?id=missing")), (410, "source_expired".to_string()));
}

#[test]
fn preferring_the_frame_transport_returns_it_for_pivot_5_only() {
    let mut service = Service::new();
    let (packet, frames) = service.import_frames("modern-type-change.piv", &fixture("modern-type-change.piv"), None);
    assert_eq!(str_at(&packet, "timings/transport"), "native-v5-frames");
    assert_eq!(number(&packet, "nativeFrames/version"), 1.0);
    assert_eq!(number(&packet, "nativeFrames/byteLength"), frames.len() as f64);
    let payload = inflate(&fixture("modern-type-change.piv"));
    let start = number(&packet, "nativeFrames/sourceOffset") as usize;
    assert_eq!(frames, payload[start..start + frames.len()], "the frames are the file's own bytes");
    assert_eq!(start, number(&packet, "document/validation/frame_start") as usize);
    assert_eq!(len(&packet, "document/keyframes"), 0, "the header carries the document without its frames");
    // A legacy project stays complete JSON however it is asked for.
    let response = service.call("POST", "/api/import?filename=legacy-v2.piv", &[("Accept", styk_piv::NATIVE_FRAMES_CONTENT_TYPE)], &fixture("legacy-v2.piv"));
    assert!(header(&response, "Content-Type").starts_with("application/json"));
    let legacy = parse(&response.body);
    assert_eq!(number(&legacy, "document/version"), 2.0);
    assert!(len(&legacy, "document/keyframes/0/objects") > 0);
}

#[test]
fn a_lease_survives_cache_eviction_and_releases_idempotently() {
    let mut service = Service::new();
    let imported = service.import_owned("blank.piv", &blank(), A);
    assert_eq!(str_at(&imported, "sourceOwner"), A);
    let id = str_at(&imported, "sourceId");
    service.evict();
    assert_eq!(service.source_record(&id).0, blank());
    for _ in 0..2 {
        assert_eq!(service.release(A).status, 204);
    }
    assert_eq!(service.get(&format!("/api/source?id={id}")).status, 410);
}

#[test]
fn lease_requests_are_validated() {
    let mut service = Service::new();
    let imported = service.import("blank.piv", &blank());
    let response = service.retain(&str_at(&imported, "sourceId"), B);
    assert_eq!((response.status, response.body.as_slice()), (200, &br#"{"ok":true,"retained":true}"#[..]));
    for path in ["/api/source/retain", "/api/source/release"] {
        assert_eq!(outcome(&service.post(path, b"[]")), (400, "invalid_request".to_string()));
        assert_eq!(outcome(&service.post(path, &[b'x'; 4097])), (413, "body_too_large".to_string()));
        assert_eq!(outcome(&service.post(path, br#"{"ownerId":"wrong"}"#)), (400, "invalid_source_owner".to_string()));
        assert_eq!(outcome(&service.post(path, b"{}")), (400, "invalid_source_owner".to_string()));
    }
    let refused = service.call("POST", "/api/import?filename=active.piv", &[("X-Styk-Source-Owner", "invalid")], &blank());
    assert_eq!(outcome(&refused), (400, "invalid_source_owner".to_string()));
}

#[test]
fn bad_files_become_json_errors() {
    let mut service = Service::new();
    let response = service.post("/api/import?filename=broken.piv", b"not a pivot file at all");
    assert_eq!(outcome(&response), (422, "invalid_project".to_string()));
    assert!(header(&response, "Content-Type").starts_with("application/json"));
    assert_eq!(at(&parse(&response.body), "ok"), Value::Bool(false));
    assert_eq!(outcome(&service.post("/api/import?filename=empty.piv", b"")), (400, "empty_file".to_string()));
    assert_eq!(outcome(&service.post("/api/import?filename=private.py", b"data")), (415, "unsupported_file".to_string()));
}

#[test]
fn oversized_uploads_are_refused_before_decoding() {
    let mut small = Service::with(Limits { max_source: 1024, max_document: 2048, ..Limits::web() });
    assert_eq!(outcome(&small.post("/api/import?filename=big.piv", &[b'x'; 1025])), (413, "body_too_large".to_string()));
    assert_eq!(small.post("/api/import?filename=big.styk", &[b'x'; 2049]).status, 413);
    assert_eq!(small.post("/api/export", &[b'x'; 2049]).status, 413);
    // Within the limit the same bytes are read, and fail as what they are.
    assert_eq!(small.post("/api/import?filename=big.piv", &[b'x'; 1024]).status, 422);
}

#[test]
fn export_requires_a_json_object() {
    let mut service = Service::new();
    assert_eq!(outcome(&service.post("/api/export", b"[1, 2]")), (400, "invalid_request".to_string()));
    assert_eq!(outcome(&service.post("/api/export", b"{")), (422, "invalid_project".to_string()));
    assert_eq!(outcome(&service.post("/api/export", br#"{"format":"piv"}"#)), (400, "invalid_document".to_string()));
}

#[test]
fn a_cancelled_request_answers_499_and_changes_nothing() {
    let mut service = Service::new();
    let first = service.import_owned("first.piv", &opaque_source(0), A);
    let always = || true;
    let cancelled = service.codec.request("POST", "/api/import?filename=cancelled.piv", &[("X-Styk-Source-Owner".to_string(), A.to_string())], &opaque_source(1), &always);
    assert_eq!(outcome(&cancelled), (499, "cancelled".to_string()));
    assert_eq!(error_text(&cancelled), "The file operation was cancelled.");
    // Cancelling part of the way through a decode leaves nothing behind either.
    for after in [1usize, 2, 3, 5, 8] {
        let polls = std::cell::Cell::new(0usize);
        let later = || {
            polls.set(polls.get() + 1);
            polls.get() > after
        };
        let response = service.codec.request("POST", "/api/import?filename=cancelled.piv", &[("X-Styk-Source-Owner".to_string(), A.to_string())], &opaque_source(1), &later);
        assert_eq!(response.status, 499, "cancelled after {after} checks");
    }
    let request = text(&object(&[("document", at(&first, "document")), ("format", string("piv")), ("sourceId", at(&first, "sourceId"))]));
    assert_eq!(service.codec.request("POST", "/api/export", &[], &request, &always).status, 499);
    // The owner still holds the first source, and the service still works.
    service.evict();
    assert_eq!(service.source_record(&str_at(&first, "sourceId")).0, opaque_source(0));
    assert_eq!(service.exported(&first, "piv"), opaque_source(0));
}

#[test]
fn an_active_original_survives_eviction_and_a_native_restart() {
    let raw = opaque_source(0);
    let mut service = Service::new();
    let opened = service.import_owned("active.piv", &raw, A);
    let id = str_at(&opened, "sourceId");
    service.evict();
    let (source, metadata) = service.source_record(&id);
    assert_eq!(source, raw);
    assert_eq!(str_at(&metadata, "kind"), "piv");
    assert_eq!(number(&metadata, "version"), 5.0);
    assert_eq!(str_at(&metadata, "sha256"), str_at(&opened, "document/source_sha256"));
    assert_eq!(str_at(&metadata, "document_sha256").len(), 64);
    assert_eq!(service.exported(&opened, "piv"), raw, "an unchanged export is the original file");
    let native = service.exported(&opened, "styk");
    let mut restarted = Service::new();
    let reopened = restarted.import("reopened.styk", &native);
    assert_eq!(str_at(&reopened, "kind"), "styk");
    assert_eq!(restarted.exported(&reopened, "piv"), raw);
    // The embedded original is enough without a source ID too.
    assert_eq!(restarted.export(&at(&reopened, "document"), None, "piv").body, raw);
}

#[test]
fn edits_and_unknown_fields_survive_a_native_save() {
    let raw = opaque_source(0);
    let mut service = Service::new();
    let opened = service.import_owned("active.piv", &raw, A);
    service.evict();
    let mut edited = at(&opened, "document");
    set(&mut edited, "fps", num(23.75));
    add(&mut edited, "keyframes/0/objects/0/root_x", 0.25);
    add(&mut edited, "keyframes/0/objects/0/angles/0", 0.125);
    set(&mut edited, "keyframes/0/objects/1/lengths", Value::nums(&[17.25]));
    set(
        &mut edited,
        "opaque_future",
        object(&[("values", Value::array(vec![num(9007199254740991.0), num(1.125), string("01"), Value::Bool(true)])), ("bytes", string("\u{0}\u{ff}"))]),
    );
    set(&mut edited, "_styk", object(&[("format", string("StykAnimate")), ("format_version", num(1.0)), ("name", string("Active draft")), ("future", object(&[("keep", num(1.0))]))]));
    let native = service.export(&edited, Some(&str_at(&opened, "sourceId")), "styk");
    assert_eq!(native.status, 200, "{}", String::from_utf8_lossy(&native.body));
    assert!(header(&native, "Content-Disposition").ends_with("''active.styk"), "{}", header(&native, "Content-Disposition"));
    let mut restarted = Service::new();
    let mut reopened = at(&restarted.import("reopened.styk", &native.body), "document");
    assert_eq!(at(&reopened, "_stykSource/source_base64").payload_bytes().as_deref(), Some(raw.as_slice()), "the original is embedded");
    remove(&mut reopened, "_stykSource");
    assert_eq!(reopened, edited);
}

#[test]
fn a_frame_transport_lease_fingerprints_the_document_on_demand() {
    let raw = opaque_source(0);
    let mut service = Service::new();
    let (opened, _) = service.import_frames("wire.piv", &raw, Some(A));
    assert_eq!(str_at(&opened, "sourceOwner"), A);
    service.evict();
    let (original, metadata) = service.source_record(&str_at(&opened, "sourceId"));
    assert_eq!(original, raw);
    // The same fingerprint a JSON import of the same bytes records.
    let mut other = Service::new();
    let json = other.import("wire.piv", &raw);
    let (_, expected) = other.source_record(&str_at(&json, "sourceId"));
    assert_eq!(str_at(&metadata, "document_sha256"), str_at(&expected, "document_sha256"));
}

#[test]
fn a_figure_file_keeps_its_original_and_its_name() {
    let raw = fixture("figure-media.stk");
    let mut service = Service::new();
    let opened = service.import_owned("named-figure.stk", &raw, A);
    assert_eq!(str_at(&opened, "document/figure_types/1/name"), "named-figure");
    service.evict();
    assert_eq!(service.source_record(&str_at(&opened, "sourceId")).0, raw);
    assert_eq!(service.exported(&opened, "stk"), raw);
    let native = service.exported(&opened, "styk");
    let mut fresh = Service::new();
    let reopened = fresh.import("reopened.styk", &native);
    assert_eq!(fresh.exported(&reopened, "stk"), raw);
    assert_eq!(str_at(&reopened, "document/figure_types/1/name"), "named-figure");
}

#[test]
fn owners_share_one_original_until_the_last_release() {
    let raw = opaque_source(0);
    let mut service = Service::new();
    let opened = service.import_owned("active.piv", &raw, A);
    let id = str_at(&opened, "sourceId");
    assert_eq!(service.retain(&id, B).status, 200);
    assert_eq!(service.retain(&id, A).status, 200);
    service.evict();
    assert_eq!(service.release(A).status, 204);
    assert_eq!(service.source_record(&id).0, raw);
    assert_eq!(service.release(B).status, 204);
    assert_eq!(service.release(B).status, 204);
    assert_eq!(outcome(&service.get(&format!("/api/source?id={id}"))), (410, "source_expired".to_string()));
    assert_eq!(outcome(&service.export_of(&opened, "styk")), (410, "source_expired".to_string()));
    assert_eq!(outcome(&service.export_of(&opened, "piv")), (410, "source_expired".to_string()));
}

#[test]
fn a_renamed_reimport_shares_the_active_original() {
    let raw = opaque_source(0);
    let mut service = Service::new();
    let first = service.import_owned("active-name.piv", &raw, A);
    service.evict();
    let (_, before) = service.source_record(&str_at(&first, "sourceId"));
    let second = service.import_owned("renamed-copy.piv", &raw, B);
    assert_eq!(str_at(&second, "filename"), "renamed-copy.piv");
    assert_eq!(at(&second, "document"), at(&first, "document"), "the document keeps the name it was opened under");
    for opened in [&first, &second] {
        assert_eq!(service.exported(opened, "piv"), raw);
        let (source, metadata) = service.source_record(&str_at(opened, "sourceId"));
        assert_eq!(source, raw);
        assert_eq!(str_at(&metadata, "document_sha256"), str_at(&before, "document_sha256"));
    }
}

#[test]
fn retention_limits_are_atomic_and_a_replacement_reuses_its_own_budget() {
    let (raw, other) = (opaque_source(0), opaque_source(1));
    assert_eq!(raw.len(), other.len());
    let mut service = Service::with(Limits { max_retained_sources: raw.len(), ..Limits::desktop() });
    let first = service.import_owned("first.piv", &raw, A);
    let second = service.import("second.piv", &other);
    let (first_id, second_id) = (str_at(&first, "sourceId"), str_at(&second, "sourceId"));
    assert_eq!(outcome(&service.retain(&second_id, B)), (413, "source_retention_limit".to_string()));
    service.evict();
    assert_eq!(service.source_record(&first_id).0, raw, "the refused lease changed nothing");
    // The same owner may swap its one original for another within the same budget.
    let second = service.import("second.piv", &other);
    assert_eq!(service.retain(&str_at(&second, "sourceId"), A).status, 200);
    service.evict();
    assert_eq!(service.source_record(&second_id).0, other);
    assert_eq!(service.get(&format!("/api/source?id={first_id}")).status, 410);

    let mut single = Service::with(Limits { max_source_owners: 1, ..Limits::desktop() });
    let opened = single.import_owned("first.piv", &raw, A);
    assert_eq!(outcome(&single.retain(&str_at(&opened, "sourceId"), B)), (503, "source_owner_limit".to_string()));
}

#[test]
fn replacing_one_shared_owner_cannot_drop_the_others_original() {
    let (raw, other) = (opaque_source(0), opaque_source(1));
    let mut service = Service::with(Limits { max_retained_sources: other.len(), ..Limits::desktop() });
    let first = service.import_owned("first.piv", &raw, A);
    let first_id = str_at(&first, "sourceId");
    assert_eq!(service.retain(&first_id, B).status, 200);
    let second = service.import("second.piv", &other);
    // A's old original is still B's: it cannot make room for the new one.
    assert_eq!(service.retain(&str_at(&second, "sourceId"), A).status, 413);
    service.evict();
    assert_eq!(service.source_record(&first_id).0, raw);
    assert_eq!(service.release(B).status, 204);
    assert_eq!(service.source_record(&first_id).0, raw, "A still holds it");
}

#[test]
fn a_failed_import_does_not_replace_the_owners_original() {
    let mut service = Service::new();
    let first = service.import_owned("first.piv", &opaque_source(0), A);
    let broken = service.call("POST", "/api/import?filename=broken.piv", &[("X-Styk-Source-Owner", A)], b"broken");
    assert_eq!(broken.status, 422);
    service.evict();
    assert_eq!(service.source_record(&str_at(&first, "sourceId")).0, opaque_source(0));
}

#[test]
fn native_documents_are_not_leased_twice() {
    let mut service = Service::new();
    let first = service.import_owned("active.piv", &opaque_source(0), A);
    let native = service.exported(&first, "styk");
    let reopened = service.import_owned("native.styk", &native, B);
    assert!(!has(&reopened, "sourceOwner"), "a native document embeds its original");
    let response = service.retain(&str_at(&reopened, "sourceId"), B);
    assert_eq!(response.body, br#"{"ok":true,"retained":false}"#);
}

#[test]
fn the_cache_does_not_hand_out_what_a_client_edited() {
    let mut service = Service::new();
    let source = fixture("modern-media.piv");
    let first = service.import("modern-media.piv", &source);
    assert_eq!(at(&first, "timings/cache_hit"), Value::Bool(false));
    let second = service.import("modern-media.piv", &source);
    assert_eq!(at(&second, "timings/cache_hit"), Value::Bool(true));
    assert_eq!(at(&second, "document"), at(&first, "document"));
    assert_eq!(str_at(&second, "sourceId"), str_at(&first, "sourceId"));
}

#[test]
fn a_cache_too_small_for_a_project_refuses_it() {
    let source = fixture("modern-media.piv");
    let mut tiny = Service::with(Limits { max_cache: source.len(), ..Limits::desktop() });
    assert_eq!(outcome(&tiny.post("/api/import?filename=modern-media.piv", &source)), (413, "cache_limit".to_string()));
}

#[test]
fn an_expired_source_fails_explicitly() {
    let mut service = Service::new();
    let imported = service.import("blank.piv", &blank());
    let response = service.export(&at(&imported, "document"), Some("expired"), "piv");
    assert_eq!(outcome(&response), (410, "source_expired".to_string()));
}

#[test]
fn nothing_a_client_sends_makes_the_service_panic() {
    let mut service = Service::new();
    let bodies: [&[u8]; 9] = [b"", b"\0", b"{}", b"[]", b"null", b"\xff\xfe", b"{\"document\":{}}", b"{\"document\":[],\"format\":7}", &[0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]];
    let targets = [
        "/api/import",
        "/api/import?filename=",
        "/api/import?filename=a.piv",
        "/api/import?filename=a.stk",
        "/api/import?filename=a.styk",
        "/api/import?filename=a.stkz",
        "/api/import?filename=a.stykmov",
        "/api/import?filename=a.json",
        "/api/import?filename=%ff%00.piv",
        "/api/export",
        "/api/source?id=",
        "/api/source/retain",
        "/api/source/release",
        "//[bad/api/export",
        "",
    ];
    for target in targets {
        for method in ["GET", "POST", "put", ""] {
            for body in bodies {
                let response = service.call(method, target, &[("Accept", "*/*"), ("X-Styk-Source-Owner", A)], body);
                assert!(matches!(response.status, 200 | 204 | 400..=599), "{method} {target}: {}", response.status);
                if response.status >= 400 {
                    let error = parse(&response.body);
                    assert_eq!(at(&error, "ok"), Value::Bool(false));
                    assert!(!str_at(&error, "code").is_empty());
                }
            }
        }
    }
}

#[test]
fn an_upload_kept_for_saving_is_the_original_an_import_of_it_would_have_leased() {
    let raw = opaque_source(0);
    // The engine decodes the file itself: the codec only keeps the bytes, under the id an import gives them.
    let mut keeper = Service::new();
    let kept = parse(&keeper.call("POST", "/api/source/keep?filename=kept.piv", &[("X-Styk-Source-Owner", A)], &raw).body);
    assert_eq!((str_at(&kept, "kind"), number(&kept, "version"), str_at(&kept, "sourceOwner")), ("piv".to_string(), 5.0, A.to_string()));
    let mut importer = Service::new();
    let imported = importer.import_owned("kept.piv", &raw, A);
    assert_eq!(str_at(&kept, "sourceId"), str_at(&imported, "sourceId"));
    // The decoded document saves against the kept original: unchanged, the original file comes back.
    let document = at(&imported, "document");
    assert_eq!(keeper.export(&document, Some(&str_at(&kept, "sourceId")), "piv").body, raw);
    // The original is served for a native save, and survives the cache.
    keeper.evict();
    let (source, metadata) = keeper.source_record(&str_at(&kept, "sourceId"));
    assert_eq!(source, raw);
    assert_eq!(str_at(&metadata, "sha256"), str_at(&imported, "document/source_sha256"));
    // Released, it is gone.
    keeper.post_json("/api/source/release", &object(&[("ownerId", string(A))]));
    keeper.evict();
    assert_eq!(outcome(&keeper.get(&format!("/api/source?id={}", str_at(&kept, "sourceId")))), (410, "source_expired".to_string()));
}

#[test]
fn only_a_pivot_project_is_kept_and_the_owner_must_be_valid() {
    let mut service = Service::new();
    let refuse = |service: &mut Service, name: &str, body: &[u8], owner: &str| outcome(&service.call("POST", &format!("/api/source/keep?filename={name}"), &[("X-Styk-Source-Owner", owner)], body));
    assert_eq!(refuse(&mut service, "x.styk", b"abc", A), (415, "unsupported_file".to_string()));
    assert_eq!(refuse(&mut service, "x.piv", b"", A), (400, "empty_file".to_string()));
    assert_eq!(refuse(&mut service, "x.piv", &opaque_source(0), "not-an-owner"), (400, "invalid_source_owner".to_string()));
    // Not a Pivot file: its version byte is not one.
    assert_eq!(refuse(&mut service, "x.piv", b"\x09junk", A).0, 422);
}
