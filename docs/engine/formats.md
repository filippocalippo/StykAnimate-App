# Engine: file formats

The engine reads and writes StykAnimate's native files in
`engine/crates/styk-formats` and Pivot's files in `engine/crates/styk-piv`
([formats-piv.md](formats-piv.md)). The app's workers open and save native files
through it ([below](#opening-and-saving-for-the-apps-workers)); the JavaScript reader and
writer that were the oracle for native files are deleted. The Python codec is the
oracle for Pivot files.

## Native containers (`.styk`, `.stkz`, `.stykmov`)

- `container::decode(bytes, kind)` reads version 0 (plain JSON), version 1
  (zlib) and version 2 (a zstd-compressed skeleton plus binary sections:
  number arrays and payloads) into a `styk_doc::Value`. `decode_parts` returns
  the skeleton and sections without lifting them back.
- `container::lift` / `lift_within` split a document into skeleton and
  sections the way the JavaScript `liftDocument` did (a save writes this layout, byte for byte, and so does the interface's read view);
  `parse_lifted` reads a lifted record back (the tests of `files` check what a skeleton and its sections stand for with it).
- `container::encode_v2` writes version 2 (zstd level 3, [D5](decisions/0005-zstd-from-c.md));
  `encode_v1` writes version 1.
- `native::normalize_decoded`, `validate_figure` and `verify_embedded_source`
  apply the native document rules after decoding, with the editor's error keys
  (`ContainerError::message_key`, `NativeError::message_key`).

Parity: all 461 corpus files decoded to the JavaScript reader's document and all
448 version 2 files rewrote byte-identical before that reader was deleted; the
app's open and save path was compared with it on 261 files first (documents,
the bytes of every save, and 1,760 damaged copies: [the plan](../RUST-ENGINE-PORT.md), "Containers").
Repository files are checked by `npm run engine:parity`:
`engine/tools/container-parity.mjs` compares the document the app's open path
produces with the store's reader, and the bytes its save path writes with the file.
The repository's own native files are `engine/tests/containers` (a version 1 project, version 2
projects with array, shared-array and payload sections, a drawing, an image, a figure and two
movieclips; [its README](../../engine/tests/containers/README.md)), written from fixture documents by
`engine/tools/container-fixtures.mjs` through the app's save path; the same stage regenerates them and
fails when a file changes or when it finds no native file to compare. Engine tests that need a figure or
movieclip file (`styk-engine`'s library previews) open these, not the local asset packs.

## Opening and saving for the app's workers

The import and library-preview workers open native files through `styk_formats::files`, bound in the codec module
(`engine/crates/styk-codec-wasm/src/native.rs`, `src/native-file-codec.mjs`). Each worker loads the module itself, so a library
preview never waits for a Pivot import in the codec worker. What crosses is the *lifted form*: a JSON skeleton and the byte
sections its markers name (`src/document-lift.mjs` restores it into the editor's objects). The app **writes** its files from the
engine's document, not through this module: `styk_engine::save` lifts the tree an edit session holds and `files::save` frames it
(a project, on the document export worker: [document.md](document.md#saving-a-project)); the codec module's `saveNativeDocument`
writes a document given as JSON, for the tests and tools that make a file to read.

- `files::open(bytes, kind, rules)` reads a container and returns the skeleton and sections. A project
  whose document the rules leave as it is (nearly every one) is checked by `container::check`, which
  verifies the container and scans the skeleton and every marker with the reader's own admission but
  builds no tree, and is handed over **as the file stores it**: arrays and images shared in the file
  stay shared, and text the store cannot hold (a surrogate without its pair) is kept. A document the
  rules rewrite (an early project wrapper, browser fields), a figure file (its shape is checked on the
  tree) and one whose cheap size bound exceeds the limit (only `decode` measures it exactly) are decoded
  into the store, normalized and lifted.
- `Rules`: `RAW` returns the container as stored, `PROJECT` applies `native::normalize_decoded` and
  `verify_embedded_source`, `PREVIEW` the same without the source check.
- `files::save(kind, skeleton, arrays, payloads, store)` writes a version 2 container from a lifted document
  (`container::lift`; an array held once by the tree is stored once). A `.stkz` or `.stykmov` skeleton must be a
  self-contained figure. `BlockStore` is a cache of compressed blocks, keyed `2:3:<length>:<sha256>`; the app
  passes none (`NoStore`).
- Failures are `FileError`s: the message key (`errors.nativeContainer.*`), the machine code
  (`document_too_large` for anything a save refuses for size) and the `kind` some messages name.

## Opening a file in the engine

`styk_eval::open` / `open_bytes` pick by extension: native containers through
`styk-formats`, `.piv` and `.stk` through `styk_piv::decode_document`, so the
engine reads exactly the document the editor imports. Both produce a tree that
`styk_eval::from_value` turns into typed views.

## Hashing large buffers on a cold module

V8 runs WebAssembly in its baseline tier (Liftoff) first and moves a function to optimised code between calls: there is
no on-stack replacement, so one call that loops for seconds stays baseline code for all of it. A container's SHA-256
checks (a 175 MB `.styk` hashes about 175 MB) were exactly that: `sha2`'s block function ran for the whole buffer in one
call, and a profile of the first open of a large `.styk` showed it as 7.9 s of 15 s of CPU (the same decode again in one
process: about 1 s). Every hash of a large buffer therefore goes through `styk_doc::digest`, which feeds the hasher in
16 KiB calls of a non-inlined function so the optimised code is picked up within the first megabyte. The digest is the
same. Apply the same shape to any new loop over megabytes that runs once per document (a scan, a checksum, a copy with
a transform); a loop that already recurses or is called per record needs nothing.

## Changing a format

Add the field where the writer writes it (`container::lift`), keep unknown fields
flowing through the tree (no typed view is needed to preserve a field), add a
corpus or fixture file that has it, and check `npm run engine:parity`. A new
container version needs a reader here; the interface only sees the lifted form
(`src/document-lift.mjs`).
