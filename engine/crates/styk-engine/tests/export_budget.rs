//! A Pivot export stays within the memory it was given, whatever the document: it asks as it goes, and a memory that cannot hold it
//! refuses it, with nothing written and what it had built dropped. This binary counts the bytes the process holds
//! ([`styk_alloc::Counting`]) and its tests run one at a time.
mod support;

use std::sync::Arc;

use styk_alloc::Counting;
use styk_doc::Value;
use styk_engine::document_export::{DocumentExportError, Output};
use styk_engine::save::SaveError;
use support::*;

#[global_allocator]
static ALLOCATOR: Counting = Counting;

static ONE_AT_A_TIME: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn memory(error: Option<&DocumentExportError>) -> Option<styk_alloc::OutOfMemory> {
    match error {
        Some(DocumentExportError::Save(SaveError::OutOfMemory(memory))) => Some(*memory),
        _ => None,
    }
}

/// The fixture project with one field the format has no place for, holding `copies` references to one text of a megabyte: the document retains
/// the megabyte once, and everything that goes through it a copy at a time sees `copies` of it.
fn with_a_shared_text(tree: &Value, copies: usize) -> Value {
    let text = Value::str(&"x".repeat(1 << 20));
    let mut root = tree.as_obj().unwrap().clone();
    root.set("unknown_field", Value::Arr(Arc::new(vec![text; copies])));
    Value::object(root)
}

#[test]
fn an_export_whose_document_expands_far_beyond_what_it_retains_stays_within_the_memory() {
    let _turn = ONE_AT_A_TIME.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let file = padded_with_noise(1 << 10);
    let (engine, revision) = edited_then(&file, |tree| with_a_shared_text(tree, 128));
    let before = styk_alloc::live_bytes();
    styk_alloc::reset_peak();
    // 72 MiB of memory: the document and the megabyte it shares fit, 128 megabytes of it a copy at a time do not.
    let made = styk_alloc::with_limit(72 << 20, || engine.export_document(revision, &request(), &Output::Pivot { format: "piv".into() }, &|| false));
    let grew = styk_alloc::peak_bytes().saturating_sub(before);
    eprintln!("MiB: the export grew {} against a memory of 72 and a document of {}; {}", grew >> 20, before >> 20, if made.is_ok() { "written" } else { "refused" });
    assert!(grew < 72 << 20, "the export took {} MiB of a memory of 72", grew >> 20);
    match &made {
        Ok(_) => {}
        Err(error) => assert!(memory(Some(error)).is_some(), "refused for another reason: {error}"),
    }
    assert!(styk_alloc::live_bytes() < before + (8 << 20), "nothing the export built stays: {} MiB held over {} before", styk_alloc::live_bytes() >> 20, before >> 20);
    assert_eq!(styk_alloc::reserved_bytes(), 0, "the reservation is given back");
}

#[test]
fn an_export_that_outgrows_its_memory_in_the_middle_is_refused_with_nothing_written() {
    let _turn = ONE_AT_A_TIME.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let file = padded_with_noise(24 << 20);
    let (engine, revision) = edited(&file);
    let before = styk_alloc::live_bytes();
    // A memory with room for the reservation (64 MiB and the original twice) and for little more: the file is written in about ten times the padding.
    let limit = (before + (64 << 20) + 2 * file.len() + (24 << 20)) / 15 * 16;
    styk_alloc::reset_peak();
    let made = styk_alloc::with_limit(limit, || engine.export_document(revision, &request(), &Output::Pivot { format: "piv".into() }, &|| false));
    let overrun = memory(made.as_ref().err()).unwrap_or_else(|| panic!("expected a refusal for lack of memory, got {:?}", made.as_ref().map(|made| made.bytes.len())));
    assert!(overrun.requested > overrun.available, "{overrun:?}");
    let grew = styk_alloc::peak_bytes().saturating_sub(before);
    assert!(grew > 16 << 20, "the export began (the reservation was made) and was refused as it went: it took {} MiB", grew >> 20);
    eprintln!("MiB: refused after the export took {} of a memory with {} to give; the file is {}", grew >> 20, overrun.available >> 20, file.len() >> 20);
    assert!(grew < 2 * overrun.available, "it stopped soon after it outgrew the memory: {} MiB taken, {} MiB there", grew >> 20, overrun.available >> 20);
    assert!(styk_alloc::live_bytes() < before + (8 << 20), "the partial buffers are dropped: {} MiB held over {} before", styk_alloc::live_bytes() >> 20, before >> 20);
    assert_eq!(styk_alloc::reserved_bytes(), 0, "the reservation is given back");
    // A refusal holds nothing back: with room the same export writes.
    let written = styk_alloc::with_limit(4 << 30, || engine.export_document(revision, &request(), &Output::Pivot { format: "piv".into() }, &|| false)).unwrap().bytes;
    assert!(written.len() > file.len() / 2);
}
