# Load normalization fixtures

What the editor's load does to a document (`prepareEditorLoad`, `src/editor-load.mjs`), recorded from the
JavaScript for the engine's port (`styk_edit::load`). `engine/crates/styk-edit/tests/load.rs` checks every
case byte for byte; regenerate with `node engine/tools/load-fixtures.mjs` (byte-stable: a change means the
editor's load changed). `--show <name>` prints the editor's answer for one case.

- `repository.json`: every project document the repository holds (the edit recordings' documents, the crates'
  fixture documents, the recordings that carry one), by path. The normalized document is stored as its size
  and the SHA-256 of its `JSON.stringify` bytes, with the indexes the editor builds from it (next frame
  identity and figure identity, figures per layer, tracks); a document the editor refuses stores the error.
- `cases.json`: synthetic documents, one per branch of the normalization and one invalid document per refusal
  (`engine/tools/load-cases.mjs`), with the input and the normalized document in full.

An error is the editor's message key, or its plain message where it raised one without a key, or
`exception: "TypeError"` where a malformed document makes the JavaScript throw on a `null`; the engine answers
the same text (`styk_edit::load::TYPE_ERROR` for the exception). The editor's message parameters are recorded
but not compared: the engine does not carry them yet.

Documents that are not in the repository are compared by `node engine/tools/load-private.mjs` (the `.piv` files
of the folders `STYK_CORPUS_DIR` names) against `styk load`.
