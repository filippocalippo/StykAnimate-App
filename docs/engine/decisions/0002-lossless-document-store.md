# D2: A lossless copy-on-write document store, typed views per record

Status: accepted. Recorded in [`docs/RUST-ENGINE-PORT.md`](../../RUST-ENGINE-PORT.md) section 4.

## Context

Saves must be byte-identical for unchanged documents and unknown fields must survive a round trip. The prototype's typed model was read-only and dropped what it did not understand; JavaScript's `JSON.stringify` decides number spelling and key order.

## Decision

`styk-doc` holds the document as a tree of `Value`s (`Arc`-shared, copy-on-write): objects keep JavaScript's key order (integer keys first), numbers keep their exact `f64` and are written with JavaScript's spelling (`ryu-js`), numeric arrays are packed (`Nums::F32`/`F64`), binary payloads are `Blob`s. Typed evaluation views (`styk_eval::doc`) are derived per record by a `Loader` that keeps every record whose tree node did not change.

## Evidence

All 461 native files of the corpus decode to the same document as the JavaScript container reader the recordings were made with; all 448 version 2 files rewrite byte-identical. An edit that replaces one keyframe converts one keyframe (`tests/incremental.rs`).

## Consequences

Editing works on the tree (byte-exact saves); evaluation reads the typed views. A lone UTF-16 surrogate in a JSON string becomes U+FFFD (JavaScript keeps it); no corpus file has one. Python's int/float distinction is not kept (see `docs/engine/formats-piv.md`).
