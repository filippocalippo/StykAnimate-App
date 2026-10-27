# Engine: the document store

How the engine holds a StykAnimate document (`engine/crates/styk-doc`) and how
the typed views evaluation reads are derived from it (`styk_eval::load`). The
file formats are in [formats.md](formats.md); why the store is shaped this way
is [D2](decisions/0002-lossless-document-store.md).

## Contract

- A document is a tree of `styk_doc::Value`: `Null`, `Bool`, `Num(f64)`,
  `Str(Arc<str>)`, `Arr(Arc<Vec<Value>>)`, `Nums(Arc<Nums>)` (a packed numeric
  array, `F32` or `F64`), `Obj(Arc<Obj>)` and `Blob(Arc<Blob>)` (binary payload
  with its `data:` prefix). Every node is shared and copy-on-write: an edit
  clones the path to the record it changes, never the document.
- Objects keep JavaScript's key order: integer-like keys first in ascending
  order, then insertion order (`Obj`, `index_key`). Objects of the same shape
  share one key list (`Shape`).
- `styk_doc::json` reads and writes JSON exactly as JavaScript does: numbers in
  `JSON.stringify`'s spelling (`number::format_number`, ryu-js), strings with
  JavaScript's escapes, nesting up to 512 levels. Writing a value read from
  JavaScript gives JavaScript's bytes back.
- Typed views (`styk_eval::doc::Document`: figures, keyframes, pose sources,
  layers, layer sheet, effects, …) are derived by a `styk_eval::load::Loader`
  that lives as long as a document's lineage. It keeps the view of every record
  whose tree node is unchanged (by node address), interns images by payload and
  resolves style overlays once per base figure; an edit that replaces one
  keyframe converts one keyframe.

## Opening a document

Every way a document arrives goes through one entry (`styk_engine::document`, bound by
`styk-wasm/src/open.rs`, used through `src/engine/engine-open.mjs`): a file's bytes (Pivot `.piv`
through `styk-piv`, `.styk` through `styk-formats`) or a document as JSON (a new document, the startup
document, a tutorial's, a recovery copy, a Stick Nodes import the importer worker decoded).
`Engine::open_document` runs on an engine worker (`EngineHandle.open_document`, a job the interface
polls on the progress counter and cancels with `cancel_open`) or, for a small document the editor needs
at once, on the calling thread (`open_document_now`). It decodes, normalizes the document
(`styk_edit::load::prepare_for_editor`: the validation and migration, then the layer sheet an editor with
a layer timeline gives every document) and converts it into the typed views (`styk_eval::load::Loader`, the image atlas). The result, an
`OpenedDocument`, holds the normalized tree, the indexes the editor adopts (next identities, figures per
layer, tracks) and the typed views; nothing is published yet. A failure is an `OpenError`: a message
key with its parameters where the editor has one (`errors.nativeContainer.*`, the load's keys), the
codec's own message and status for a Pivot file it cannot read, `cancelled` for a stopped job, and
`errors.engine.outOfMemory` when the memory cannot hold the open ([memory.md](memory.md)). Nothing in
the load panics on a damaged document: `styk-edit/tests/load_robust.rs` loads every edit fixture with
each value replaced by values of the wrong kind or removed.

The editor's read view is built from the opened tree once, in pieces
(`OpenedDocument.part`, `Opening.read` in `engine-open.mjs`): the document without the contents of
its tables, then each figure, keyframe, background, retained pose source and audio recording, lifted as a
file lifts them (`container::ViewLifter`: arrays and images the tree shares are written once and named by
the same marker, so the read view shares them and a save lifts the same bytes) and restored by
`restoreLifted`. The interface thread restores in slices of 4 ms. The Pivot original of a project
stays with the codec for saving (`/api/source/keep`, leased to the project); the web build embeds it in
the document instead (`OpenedDocument.attach_source`).

The session that edits the document starts from the same tree and typed views
(`OpenedDocument.start_session`; nothing is converted again) and is the document's from the moment the
editor publishes it. `EditSession.activate(revision)` makes its document the engine's
(`Engine::activate`): the stage draws it, playback and exports read it. Every call that changes the
document publishes the new tree at the session's revision (`Engine::publish_tree`): copy-on-write
sharing means only the records the call replaced are converted again. Revisions are unique across the
documents of one editor, so `holdsRevision` (the document identity the engine reports) says whether the
engine holds a given document at a given state; the stage never brings the engine up to date itself.
A document in a background tab keeps its session; coming to the front activates it again.

Nothing but the session changes the document. Two things the interface does outside a command are told to it at once, by the
owner (`owner.rs`, [editing.md](editing.md#phase-3-the-engine-owns-the-document), "Bookkeeping"): a document marked as changed
(`editor.dirty = true`: `@touch`, a new revision with the tree untouched, published without converting anything), and the
encoded tiles of a drawing attached to its definition (a derived publication, `DrawingResources.onPublished`:
`@publishCel`; the revision does not move). A frame the stage
draws of a cel that only a gesture's draft holds goes through `EngineHandle.set_draft`
([drawing.md](drawing.md#live-cels)).

`Engine::open` (bytes and an extension, no normalization) remains for the command-line tools and the
Rust tests that open recorded documents as they are.

## Exports of the document

The files that cannot hold the editable document are made from the document the engine holds: Pivot animations and
figures (`.piv`, `.stk`), figure files (`.stkz`) and movieclip files (`.stykmov`). A `.styk` save is not among them: it
needs no evaluation, so the interface sends the editable document to the export worker in bounded chunks and the worker
writes the container.

The document export worker (`src/document-export-worker.mjs`) joins the engine as the export renderer does, and calls
`export_document` (`styk-wasm`, `styk_engine::document_export`) on the document the engine holds at the revision the
interface exports (the editor's revision; the interface waits briefly for a change still being published, and a
different revision is a cancelled export). Nothing of the document crosses to the worker, and the interface thread
takes no part in the work (D7). The work is `styk_edit::export`:

- **Pivot animation** (`pivot.rs`): the stored frames, or, when authored tracks, camera motion, parallax, layers, styles,
  movieclips or IK are in play, one stored frame for each tick with them baked in (hidden poses keep their zero-duration
  exposures). An imported layer sheet that is the identity of its native keys exports the stored frames as they are. A
  working frame (`simpleFrameDraft`) is left out, the editor's identities and caches are dropped, and the result is
  validated as a native document. Pivot cannot keep VFX, connectors, Smart Stretch, one-sided fills, Stick Nodes shapes
  or gradient fills: each is a refusal naming the feature (`telemetryCode: unsupported_feature`).
- **Pivot figure** (`style.rs`): one figure type with the style of the selected instance at the requested tick; instances
  that look alike share a figure type.
- **Figure files** (`figure.rs`, `pose_sequences.rs`): a figure, a set of figures or a movieclip with the pose it shows as a
  document of its own, portable (without the project's source), with the poses its channels share stored once.

The answer is the document as JSON (figure files, which the worker writes as a container) or the body of the codec's
export request with the document in it (Pivot files, which the codec encodes). Drawing cels that Pivot cannot carry
are flagged and flattened into pictures by the worker. The engine returns an error, never a panic, for what it
refuses; the worker passes it on with its message key. The export asks `cancelled()` (a flag in shared memory) between
the ticks it bakes, and a worker that joined gives its thread back before it ends (`release`).

## Invariants

- No silent loss: a field the engine does not understand stays in the tree and
  is written back.
- Never mutate a published node: build a new path (`Arc::make_mut` on a clone).
- Number identity: a value read and written unchanged is the same bytes.

## Known differences

- A lone UTF-16 surrogate in a string becomes U+FFFD (JavaScript keeps it).
- Integers between 2^53 and 2^64 are `f64` like in JavaScript; Python's integer
  spelling of them is not kept ([formats-piv.md](formats-piv.md)).

## Testing

`cargo test -p styk-doc -p styk-formats`; `npm run engine:parity` decodes every
native file of the repository with both readers and compares the documents
(`engine/tools/container-parity.mjs`).
