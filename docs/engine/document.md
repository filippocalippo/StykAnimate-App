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
its tables, then each background and audio recording, lifted as a
file lifts them (`container::ViewLifter`: arrays and images the tree shares are written once and named by
the same marker, so the read view shares them and a save lifts the same bytes) and restored by
`restoreLifted`. The interface thread restores in slices of 4 ms.

The keyframes, the figure types and the retained pose sources are not part of that building. `report.keyframes` and `report.figure_types` are lazy tables
(`src/lazy-table.mjs`), and `report._styk.frameSources` a lazy table of records by key: to their readers an array (`Array.isArray`, `length`,
indexing, `map`, `find`, `slice`, `for...of`, spread, `JSON.stringify`, `structuredClone`) or an object, whose records the interface fetches
from the session when something reads them (`EditSession.record` and `keyed_record`; until the session starts, `OpenedDocument.record`), each lifted
on its own, whole, and restored like a piece. A record is the same object for as long as the table holds it; a table holds at most 64 keyframes,
256 figure types and 64 sources, giving the least recently read back, and fetches it again, equal, when it is read again. The elements have no
setters, as the lazy picture fields have none: the view is changed by patches, never in place.

What a reader needs without the record is the table's own: its row, which the open sends in its metadata (`rows`) and the table keeps through
patches. A keyframe's row is its identity (`getFrameById` and the pose sources are found without fetching the others); a figure type's is
`{id, name, cel, kind, segments, pictures}` (`styk_edit::figure_row`, mirrored by `figureRow`: a test holds the two to the same rows). The
readers go through `src/figure-types.mjs`: `findFigureType` fetches the type asked for and no other, and the lists of the figure library,
the drawing cels, the next free id, the movieclips and the telemetry's and the GIF defaults' questions are answered from the rows, fetching only
the types they then show. The timeline rows (`timeline`, `styk_edit::timeline_rows`) are sent with the open for the first frame. A reader that
walks every record of a table fetches every record (and sees the table give the first ones back as it goes): none does on an interactive path,
and the tests that read the whole view do it inside `holdingAll`. What still does: the validators of a document the interface exports
or imports (`validateScene`, `validateAnimationDocument`, `serialize`) and a stored frame draft being saved on leaving a movieclip (`storedFrameReport`).

How patches keep a lazy view in step: the call's view names the records each table holds (`lazy`:
`fetchedRecords`), and the session never sends a record the view does not hold (`styk_edit::patch::for_lazy`). A change inside one
it does not hold, and any record a patch sets or inserts, comes as the record's row (`{p, lz: row}`, `{lz: row}` among the refs of an
array rebuild `a`): the view keeps the place and the row and fetches the record when it is read. A table of records by key comes as keys
alone (`{p, lz: [key, …]}` for the table, `{p, lz: 1}` for an entry, `[key, null, 1]` among the entries of a rebuild `o`). So an
edit that captures the poses of a whole animation answers with their names (duplicating a frame of a 590-frame scene: 16 MB of
sources before, 16 KB now), and undoing and redoing a pose key no longer carries it. A table a patch rebuilds keeps the records it holds
and the places of those it does not (a record not fetched is the session's at its place, and every unfetched record is equal to the
session's: verify mode checks the held ones). A copy the interface makes to show a variation of the document (a motion-path edit's virtual
report, a drawing's first stroke) holds records the session does not have and gives none back. The table a patch replaces is retired: its records are still read, but one it never fetched raises, as
it can no longer say which document state it was. Such an answer also carries `layerChanges`, the figures that began to appear in a
pose and those that no pose holds any more, which updates the editor's layer index without the replaced records (a view cannot tell what it never
held). The session keeps the counts behind it (`patch::LayerIndex`), moved by the poses a call changed, found by node, so the cost follows the
change and the answer stays a few bytes; verify mode counts the figures again from the whole document and compares. A patch the
session makes over its own document (a motion-path edit's virtual report) fetches the record it changes and leaves the table in use.

The pictures and originals the tree holds as bytes (a `Blob` in `data_base64`, `data_url`, `styk_tiles` or `source_base64`
of 64 K characters or more) are not part of the view's text: the piece names each by a token (`S2P:<token>`,
`styk_doc::payload`), and `restoreLifted` defines the field as a getter that asks the engine for the text
(`EngineHandle.payload_text`) when something first reads it and keeps it from then on (`src/lazy-payload.mjs`).
Readers see an ordinary string property, `JSON.stringify` and the spread read it, and the owner's verify mode
still compares every byte. The field has no setter: the view is changed by patches, never in place, so a write
throws. A session patch (`styk_edit::patch::for_view`) names the pictures it carries the same way (the answer's
`payloads` flag; a string that looks like a token travels as `S2E:` and the string), and `applyDocumentPatch` keeps
an untouched picture lazy when it copies or rebuilds the record around it. The registry holds blobs weakly: a
picture no document or history entry holds any more answers with an error, so naming a payload never keeps a
deleted picture alive. A picture an edit adds (a string in the session's tree) reaches the view as the string.
The drawing store is the one writer of the view's cels: it attaches a cel's published tiles to its definition in
place and tells the session (`@publishCel`), replacing a lazy field through `putField`. The Pivot original of a project
stays with the codec for saving (`/api/source/keep`, leased to the project, sent while the engine decodes); the web build embeds it in
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
figures (`.piv`, `.stk`), figure files (`.stkz`) and movieclip files (`.stykmov`). A `.styk` save needs no evaluation: the
engine writes it from the tree of the editing session that holds the document (`save_project`, below).

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

The answer is the container of a figure file (written by the engine: `styk_engine::save`) or the body of the codec's
export request with the document in it (Pivot files, which the codec encodes). Drawing cels that Pivot cannot carry
are flagged and flattened into pictures by the worker. The engine returns an error, never a panic, for what it
refuses; the worker passes it on with its message key. The export asks `cancelled()` (a flag in shared memory) between
the ticks it bakes, and a worker that joined gives its thread back before it ends (`release`).

### Saving a project

A `.styk` project is written from a snapshot of an edit session's tree (`EditSession.snapshot`: a token in a registry in the shared
memory, a clone of the copy-on-write root, nothing copied), by `save_project` on the document export worker
(`styk_engine::save::save_project`). Any session can be saved, the one in front, one a tab keeps, or a project whose movieclip is being
edited: the documents the clips were entered from come with the movieclip each holds, and `styk_edit::export::fold_movieclip` stores
the clip inside its parent as a recovery copy does. `prepare_project` prepares the tree (metadata, no `runtime_segments`, the load's
validations, display aliases in line, pose sequences stored once), the Pivot original the codec holds is stored first in the payload
section, and `styk_formats::container::lift` and `files::save` write the container. The work runs on a worker that joined the engine,
reserves its working memory first (`errors.engine.outOfMemoryWhileSaving` when the memory cannot hold it: the project stays open and nothing was
written), and lifts the document in pieces: the elements of its biggest top-level array (the keyframes, nearly all of a project) are serialised side by side in batches (`container::lift_together`; the pieces own clones of their elements), each piece leaving the choices that depend on what came before (where an array or a payload is stored, whether it was stored already) as holes that are settled in document order when the batch is spliced in, so the skeleton and the sections are the ones one thread writes, byte for byte; the scene check (`validateScene`, read-only, the longest single job of the save) is started first on a worker the machine can spare (`Host::start`, `Engine::start_later`, only where three workers can be lent) and runs beside the lift and the frames, and the save waits for it before the file is made (`check_scene`; its error is the save's), and asks the cancel flag between the steps of the preparation, every few thousand values of the lift, every 4 MiB hashed,
and before and after each of the three zstd frames. The three hashes and the three frames (in turn, so that only one frame's output buffer, the size of the worst case, is held at a time) are four
independent jobs: the save thread and up to three of the engine's other workers (the interface passes `engine.workers - 1`, at most 3, so one stays free for the
frame on show) take them largest first (`Host::together`, `Engine::run_together`: `'static` jobs that own their blocks, claimed by whoever starts them first, a panic or a lost worker ending the save with an error and nothing freed under a worker still running one; a
host without workers runs them all itself). The workers cannot ask the interface's cancel, so the save thread asks it every 25 ms
while it waits and raises a flag they read. The save's own timings (`prepare_ms`, `lift_ms`, `frames_ms`, per block
`hash_ms` and `compress_ms`, `assemble_ms`) come back with the file and are in the exporter's `lastTimings.engine`. Each frame is one `zstd::bulk::compress` call (level 3), because the bytes of an unchanged
document must be those the former writer wrote: a compressor fed in pieces, or with a small output buffer, writes other, valid frames
on real data (the test `sections_shaped_like_real_ones_compress_to_the_frames_one_shot_compression_makes`). A cancel therefore takes effect
after the frame in progress; the interface does not wait for it and never ends the worker inside the engine
([threading](threading.md#ending-a-worker)). The session keeps editing while it runs. The saved bytes of an unchanged document are those the JavaScript writer wrote (`tests/save-references.test.mjs` and `engine/crates/styk-engine/tests/save.rs` compare every recorded file in `engine/tests/containers/`).
Arrays the tree shares (a copied frame, a keyframe and the stored frame it came from) are stored once and named by one marker each time, as the former writer did for arrays the interface shared; a copy-like edit can therefore make a file with shared arrays where the former writer made separate ones. The former app reads a shared marker as one array, but its edits of a project with a layer sheet write a new stored frame instead of changing the one on show, so no other frame changes (checked in that app, opening such a file and posing a joint).

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
