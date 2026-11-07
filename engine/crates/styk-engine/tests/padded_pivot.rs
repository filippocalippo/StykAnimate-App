//! A padded Pivot file edited once is exported as a Pivot file without the codec's request in between (whose size is twice the padding, as the
//! document holds it as hex text), with the bytes the codec's route writes.
mod support;

use styk_doc::Value;
use styk_engine::document_export::Output;
use support::*;
use styk_piv::Limits;

#[test]
fn an_edited_padded_file_exports_the_bytes_the_codec_service_writes() {
    let file = padded_with_noise(6 << 20);
    let (engine, revision) = edited(&file);
    let (status, expected) = through_the_service(&engine, revision, Limits::desktop());
    assert_eq!(status, 200);
    assert!(expected != file, "the edit is in the file");
    let written = pivot(&engine, revision);
    assert!(written == expected, "{} bytes written, {} by the service", written.len(), expected.len());
}

#[test]
fn an_edited_padded_file_is_exported_although_its_request_exceeds_the_codec_limit() {
    // The document holds the padding as hex text: its request is twice the padding. A codec that takes 16 MiB of document refuses the
    // request of 10 MiB of padding; the export that sends no request writes what the codec writes with room for it.
    let file = padded_with_noise(10 << 20);
    let (engine, revision) = edited(&file);
    let (refused, _) = through_the_service(&engine, revision, Limits { max_document: 16 << 20, ..Limits::desktop() });
    assert_eq!(refused, 413, "the request is too large for this codec");
    let (status, expected) = through_the_service(&engine, revision, Limits::desktop());
    assert_eq!(status, 200);
    let written = pivot(&engine, revision);
    assert!(written == expected, "{} bytes written, {} by the service", written.len(), expected.len());
}

#[test]
fn a_pivot_export_that_is_cancelled_writes_nothing() {
    let (engine, revision) = edited(&padded_with_noise(1 << 20));
    let refused = engine.export_document(revision, &request(), &Output::Pivot { format: "piv".into() }, &|| true);
    assert!(matches!(refused, Err(styk_engine::document_export::DocumentExportError::Cancelled)), "{refused:?}");
}

#[test]
fn a_pivot_export_the_memory_cannot_hold_is_refused_before_it_writes_anything() {
    use styk_engine::document_export::DocumentExportError;
    use styk_engine::save::SaveError;
    let file = padded_with_noise(24 << 20);
    let (engine, revision) = edited(&file);
    let expected = pivot(&engine, revision);
    // The export asks for several times what the document retains (the padding, as hex and as bytes, the original, the file written):
    // a memory of 100 MiB does not have it, and says so with the message of a save that ran out of memory.
    let refused = styk_alloc::with_limit(100 << 20, || engine.export_document(revision, &request(), &Output::Pivot { format: "piv".into() }, &|| false));
    match refused {
        Err(DocumentExportError::Save(SaveError::OutOfMemory(memory))) => assert!(memory.requested > memory.available, "{memory:?}"),
        other => panic!("expected a refusal for lack of memory, got {:?}", other.map(|made| made.bytes.len())),
    }
    // A refusal holds nothing back: with room the same export writes the same file.
    let written = styk_alloc::with_limit(3 << 30, || engine.export_document(revision, &request(), &Output::Pivot { format: "piv".into() }, &|| false)).unwrap().bytes;
    assert!(written == expected);
    // The export in the codec's request form is not asked for the memory (the browser's path reserves nothing here).
    let request_body = styk_alloc::with_limit(100 << 20, || engine.export_document(revision, &request(), &Output::CodecRequest { format: "piv".into() }, &|| false));
    assert!(request_body.is_ok());
}

#[test]
fn a_document_with_edge_numbers_exports_the_bytes_the_codec_route_writes() {
    // JSON has no negative zero, no NaN and no infinity: the route that writes the document as text and reads it back turns a negative zero into a
    // zero and the others into null. The tree export must write what that route writes, for the fields a Pivot file stores.
    let file = padded_with_noise(1 << 10);
    let probe = |tree: &Value| {
        let mut root = tree.as_obj().unwrap().clone();
        root.set("probe", Value::nums(&[f64::NAN, f64::INFINITY, -0.0, 1.5]));
        root.set("probe_zero", Value::Num(-0.0));
        Value::object(root)
    };
    let cases: [(&str, Box<dyn Fn(&Value) -> Value>); 5] = [
        ("root_x negative zero", Box::new(|tree| with_numbers(tree, &|n| n, Some(("root_x", -0.0))))),
        ("first angle negative zero", Box::new(|tree| with_numbers(tree, &|n| n, Some(("angles", -0.0))))),
        ("root_x NaN", Box::new(|tree| with_numbers(tree, &|n| n, Some(("root_x", f64::NAN))))),
        ("NaN, infinity and negative zero in a field the format has no place for", Box::new(probe)),
        ("nothing changed", Box::new(|tree| tree.clone())),
    ];
    let mut written = 0;
    for (name, change) in cases {
        let (engine, revision) = edited_then(&file, &*change);
        let (service, tree) = both_routes(&engine, revision);
        match (&service, &tree) {
            (Ok(expected), Ok(bytes)) => {
                assert!(bytes == expected, "{name}: {} bytes by the tree, {} by the codec's route; first difference at {:?}", bytes.len(), expected.len(), bytes.iter().zip(expected.iter()).position(|(a, b)| a != b));
                written += 1;
            }
            (Err(by_route), Err(by_tree)) => assert!(by_route.contains(by_tree.as_str()), "{name}: refused as {by_tree:?} by the tree and {by_route:?} by the route"),
            _ => panic!("{name}: one route writes and the other refuses: route {:?}, tree {:?}", service.as_ref().map(Vec::len), tree.as_ref().map(Vec::len)),
        }
    }
    assert!(written >= 3, "the cases that write are compared byte for byte ({written})");
}
