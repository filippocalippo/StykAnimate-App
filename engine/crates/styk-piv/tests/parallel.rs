//! A Pivot file read with its frames built in pieces on several threads is the document it is read to on one: the same tree, and for
//! a damaged file the same refusal.
mod common;

use common::{fixture, fixtures};
use styk_doc::fanout::{Sequential, StdThreads};
use styk_doc::json;

fn read(bytes: &[u8], name: &str, fan: &dyn styk_doc::fanout::Fanout) -> Result<String, String> {
    styk_piv::decode_document_with(bytes, name, &|| false, fan).map(|decoded| json::to_string(&decoded.document)).map_err(|error| format!("{} {}", error.status, error.message))
}

#[test]
fn every_fixture_reads_to_the_same_document_on_several_threads() {
    let mut read_to_a_document = 0;
    for name in fixtures(".piv") {
        let bytes = fixture(&name);
        let in_order = read(&bytes, &name, &Sequential);
        for threads in [2, 5] {
            assert_eq!(read(&bytes, &name, &StdThreads(threads)), in_order, "{name} on {threads} threads");
        }
        read_to_a_document += in_order.is_ok() as usize;
    }
    assert!(read_to_a_document >= 8, "the fixtures that read: {read_to_a_document}");
}

#[test]
fn a_damaged_file_is_refused_the_same_way_on_several_threads() {
    let mut refused = 0;
    for name in ["modern-identities.piv", "modern-media.piv", "modern-type-change.piv"] {
        let stored = fixture(name);
        // The compressed file damaged at spots all along it, and its payload damaged and compressed again.
        let payload = common::inflate(&stored);
        let damaged = (0..payload.len()).step_by(7).map(|at| {
            let mut copy = payload.clone();
            copy[at] ^= 0x41;
            common::deflate(&copy)
        });
        for copy in damaged.chain((0..stored.len()).step_by(11).map(|at| {
            let mut copy = stored.clone();
            copy[at] ^= 0x41;
            copy
        })) {
            let in_order = read(&copy, name, &Sequential);
            assert_eq!(read(&copy, name, &StdThreads(4)), in_order, "{name}");
            refused += in_order.is_err() as usize;
        }
    }
    assert!(refused > 50, "damaged copies refused: {refused}");
}
