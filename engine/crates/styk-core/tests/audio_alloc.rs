//! The reservation bounds what a recording takes while it is assembled from the document's chunks: the bytes newly allocated at
//! the peak stay within the budget that was reserved for them (a counting allocator measures it). A single-chunk WAV with a
//! budget of exactly its size used to allocate three times that.

#[path = "support/alloc.rs"]
mod alloc;
mod support;

use std::sync::Arc;

use support::audio::*;
use styk_core::audio::{build_plan, Budget, SourceStore};
use styk_services::Cancel;

#[global_allocator]
static COUNTING: alloc::Counting = alloc::Counting;

#[test]
fn assembling_an_embedded_recording_stays_within_its_reservation() {
    // A plain WAV of exactly 192,044 bytes embedded as one base64 chunk, and a budget of exactly that.
    let wav = decoded_wav(1.0);
    assert_eq!(wav.len(), 192_044);
    let audio = state(&[("a", &wav, 1.0)], &[("a", 0.0, 0.0, 1.0, 1.0)]);
    let store = SourceStore::new(Budget::new(192_044), TestDecoder::new(Behavior::Silence));
    let baseline = alloc::reset_peak();
    let plan = build_plan(&store, &audio, 0.0, 1.0, &Cancel::new()).expect("a recording that fits its budget exactly is prepared");
    let new_at_peak = alloc::peak() - baseline;
    assert_eq!(store.budget().used(), 192_044, "the accounting says one copy");
    assert!(new_at_peak <= 192_044 + 16 * 1024, "{new_at_peak} bytes were newly allocated at the peak for a reservation of 192,044");
    drop(plan);
    drop(Arc::new(0));
}
