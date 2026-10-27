# Responsive document exports

```js
import {DocumentExporter} from './src/document-export.mjs';

const exporter = new DocumentExporter();
const controller = new AbortController();
const blob = await exporter.export(editor.report, {
  sourceId,
  format: 'styk', // 'stkz', 'piv' or 'stk'
  name: editor.name,
  figureTypeId: selectedFigureId, // STK/STKZ selection
  signal: controller.signal,
  getRevision: () => editor.revision,
  revision: editor.revision, // required for 'piv', 'stk', 'stkz' and 'stykmov'
});
```

A `.styk` save is made from the report the caller passes; the other formats are made by the engine from the
document it holds at `revision` (see below), so the report is not sent to the worker for them.

Pass the live report directly. Calling `editor.serialize()`, `structuredClone()`,
or `JSON.stringify()` first would recreate the main-thread pause this API avoids.
Snapshots use the shared document transport with a 1 MiB packet budget, a
3 ms preparation budget, receiver acknowledgments, and explicit input yields.
Large embedded source strings, glyph records, and pose arrays are split without
serializing the whole document. Only keyframe object `runtime_segments` caches
are omitted; unknown fields and opaque media survive.

For `.piv`, `.stk`, `.stkz` and `.stykmov` nothing of the document is sent: the worker joins the engine and the engine
makes the document of the file from the one it holds at the editor's `revision`, baking authored tracks, camera
motion, styles and movieclips into the stored frames Pivot has, and refusing what Pivot cannot keep
([engine/document.md](engine/document.md#exports-of-the-document)). The worker raises the cancel flag and gives its
thread back before it ends, so cancelling never terminates it inside the engine. A change that lands while the
exporter waits for the engine to publish the revision cancels the export, as for every export.

The worker shares the engine's memory, which only a cross-origin isolated page can do (the desktop app and the site are; the engine
itself still runs on a page that is not, without worker threads). On a page that is not isolated, a `.piv`, `.stk`, `.stkz` or
`.stykmov` export is refused before a worker starts, with "This kind of file cannot be made here. Use the desktop app or a page that
allows shared memory."; `.styk` saves do not need the engine's memory and are made as everywhere.

A dedicated worker assembles each `.styk` snapshot, synchronizes existing derived
aliases, validates the scene, and builds the output. `.styk`/`.stkz`/`.stykmov`
saves are encoded in the worker as version-2 sectioned containers — large
numeric arrays and base64 payloads move to binary sections, the original source
bytes come from the codec's `/api/source` route, and the Rust container writer
(`styk_formats::files` in the codec module, loaded by the worker itself:
`src/native-file-codec.mjs`) compresses the skeleton and sections with zstd and
checks that a figure file holds a self-contained figure — without the document ever
being serialized by the codec. A native save has no service fallback: a missing
original source fails the save (status 404 or 410), as do documents over the
capacity limits. `.piv`/`.stk` exports go to the Pivot codec. The codec is the Rust one
(`engine/crates/styk-piv`) compiled to WebAssembly and running in a worker of the
editor page (`src/codec-web-worker.mjs`); it answers the same `/api/...` routes the
former local file service did, over the worker's message ports, with the same
responses and actionable error statuses ([engine/formats-piv.md](engine/formats-piv.md)). Missing display aliases remain
absent so an untouched STK or legacy document does not become a semantic edit
merely from normalization. A Blob returns to the renderer without JSON or
base64 conversion. Use the native Blob streaming helper to save it through
Electron; browser downloads and IndexedDB can consume the Blob directly.

One exporter runs one worker at a time, with at most four queued requests.
Waiting requests remain cancellable and recheck the captured revision before
preparing a snapshot. Successful work can reuse that worker for 30 seconds,
until its cumulative raw encoding work reaches 8 MiB. Larger jobs retire the
worker immediately after completion so successive saves cannot accumulate
old snapshot and codec heap capacity. This bounds reuse, not the peak memory
needed to encode one document. The threshold includes JSON service uploads.
Idle expiry, disposal, cancellation, timeout and failure terminate it and release
its WASM memory. Every request resets its document, options, timings and codec
port. A monotonically increasing request ID rejects delayed messages from older
requests. No editable graph or completed snapshot remains between saves.

The exporter retains only up to eight immutable compressed blocks, totaling at
most 64 MiB (`src/container-cache.mjs`), and passes them to replacement workers
by transferring their buffers: they leave the page for the duration of one save and
come back with its result. The same idle deadline and
failure/disposal paths clear this pool. Each save still snapshots and validates
current content, then hashes
fresh raw section bytes; identical SHA-256, length and codec settings can reuse
compression. Mutable array identity or editor revision is never a content-cache
key. Changed poses, media and unknown metadata therefore cannot return stale
data. The writer returns the whole container, which becomes the Blob. The layout,
compression settings and output bytes are those of the JavaScript writer this
replaced.

An imported layer sheet whose tracks still map exactly to the original native
times does not require Pivot baking. The materializer checks current track
contents, durations and known controls on every export, including after Undo
or native-save reopen. Authored or retimed tracks retain the full evaluator.
The private PIV snapshot omits editor frame-reference IDs while retaining
unknown frame metadata; the live document and native saves keep their IDs.
Unchanged imported PIVs can therefore reuse exact source bytes after normal
editor initialization, preserving original stored and hidden keyframes.

Sectioned containers keep separate limits: 256 MiB for the compressed file and
each binary section, 384 MiB for the JSON skeleton, and the existing 1 GiB
combined materialization budget. Both readers and writers enforce these
bounds, including repeated marker expansion and restored array allocation;
version-1 limits stay unchanged. Every decoded section must match its
declared length and checksum, including zstd sections. Capacity failures do not
retry through a larger JSON request that could obscure the original error.

For native-frame imports, `/api/source` hashes the canonical decoded scene one
frame at a time under the decode lock. It retains only the digest, so native
saving does not depend on the separate 256 MiB JSON response limit or construct
a second complete normalized pose inventory. Fingerprint version 3 and its
numeric/opaque-field semantics remain unchanged.

Project imports lease their immutable original PIV/STK bytes separately from
the decoded-document LRU, before returning the result. The lease pool is bounded
to 16 owners and 384 MiB of unique original bytes. Replacement adopts the new
owner after document loading succeeds, then releases the old owner; rejected,
cancelled and failed imports release their temporary owner. Import-only library
operations do not lease originals. Browser project imports embed validated
original bytes before publication so codec-worker cancellation cannot discard
the active project's provenance. Native projects remain self-contained.
Only an explicit no-binary-source response (422) permits local native saving
without a fetched archive. A missing endpoint/source (404/410) or another lookup
failure takes the authoritative service fallback; it cannot silently omit the
original. If the service cannot recover it, Save fails and retains unsaved work
and the previous complete file. A desktop lease survives decoded-cache eviction,
but not backend process loss before the first native save or recovery checkpoint.

PIV/STK export uses the same frame-at-a-time fingerprint for the submitted
document. Older fingerprint versions keep their historical encoding. Validation
and hashing still visit the complete document; streaming bounds the temporary
normalized graph and JSON string, not the request or decoded document itself.
Numeric normalization handles builtin scalars directly, preserving the historical
path for subclasses. Integer precision, negative zero, nonfinite rejection,
unknown fields and per-container cancellation checkpoints remain unchanged; the
JSON encoder and fingerprint bytes are unchanged.

The native file writer reports success at atomic destination commit. A later
failure updating optional recent-file or recovery display metadata does not
turn a saved document into a failed save; it reports an app diagnostic and sets
`metadataSaved: false` in the finish result. Failures before commit still reject
and preserve the previous destination. Diagnostic reporting cannot reverse a
completed file write.

Manual Save has one owner from destination selection through commit and optional
cleanup. Repeated requests for the same checkpoint join it; differing requests
cannot start a second write. Optional recovery deletion failures are diagnosed
without changing a successful save result. Save-before-close/update retains the
saved checkpoint and rechecks it after awaited preference, clipboard and desktop
state flushes. A monotonic editor-event epoch supplements revision/draft checks,
including persisted changes that do not advance the history revision.

Recovery retains a maximum-wait deadline across edits instead of restarting the
entire debounce every time. It waits for stable interaction boundaries, uses
bounded retry delays and continues aborting mutable snapshots on changes. This
does not guarantee a checkpoint during uninterrupted edits; complete incremental
snapshots require a broader persisted-change contract. Failed or cancelled work
leaves the previous recovery copy intact.

Browser project Save selects a File System Access destination in the input task,
before awaiting drawing publication or serialization. Its existing output sink
commits through `close()`; cancellation and failure abort the swap file. Where a
picker is unavailable (including a command without user activation), Save starts
a download and retains an unsaved document plus a recovery snapshot. An anchor
click is not a file-write acknowledgement and cannot clear recovery, mark the
document Saved, or satisfy Save changes before replacing the document.

The caller must abort on **every document mutation**, including the start of an
uncommitted drag or another preview operation. Revision checks additionally
reject snapshots changed between batches or while the service is exporting.
An aborted snapshot never returns a file. Catch `AbortError` separately and
reschedule recovery after the next idle period. Manual save should report the
cancellation and retain the unsaved state. `dispose()` cancels every active job.

`exporter.lastTimings` records the most recent successful export's chunk count,
snapshot duration, maximum synchronous chunk preparation/post duration, total
main-thread preparation time across all yields, and worker normalization,
serialization, HTTP, container build, and output sizes. Background completion
may take seconds for very large scenes; those durations do not represent UI
blocking.

The timings also include `reused_worker`, `container_raw_bytes`, compression `hits`/`misses`,
`rawBytesReused`, `compressedBytesReused`, `cacheBytes` and `cacheEntries`.
`node scripts/benchmark-document-saving.mjs --control=<commit SHA>` compares
identical read-only corpus inputs, unchanged exports and a small edit against a
committed encoder/exporter. It verifies output hashes and reports process peak
RSS; its results exclude drawing publication, UI, IPC and atomic disk commit.

Successful service exports also expose `service_ms` for request receipt, JSON
parsing, validation, source fingerprinting, provenance, submitted-document
fingerprinting and encoding, plus `request_bytes` for the actual HTTP body.
These come from bounded `Server-Timing` and `X-Styk-Request-Bytes` headers. They
describe server work before response transmission; `fetch_ms` includes the
response. Only the latest successful export retains these diagnostics.

Run `node tests/document-export-browser.mjs` for real PIV/STK byte identity,
native persistence across an actual backend restart, preserved unknown fields,
fractional edits, cancellation, and export long-task measurements. Pass a file
path to test another project. Results are written to
`artifacts/document-export-browser.json` (or the Akane-specific report).

Native `.styk` and `.stkz` results use the versioned compressed container
described in [Native file format](native-file-format.md). Do not parse a saved
file directly as JSON; reopen it through `ImportClient`.

Pivot text gradients are vertical within each glyph. Modern gradient fills span
the complete text run, so `.piv` and `.stk` export rejects them even when they are
linear with two stops. Save as `.styk` to retain editable fills, export SVG/images
or video to preserve their appearance, or choose a solid text fill for Pivot.

## Drawing publication

Pass the live report, as above: `DocumentExporter` and the engine's export renderer
(`EngineExportFrames`) await its drawing publication barrier before transport. PNG publication is
derived state and does not advance the edit revision. App save/play finishes
active drawing edits; recovery includes committed strokes. Clipboard, library,
playback and thumbnail snapshots use the same barrier. Movieclip scopes flush
before copying their document. Failed/cancelled publication retains live work
and existing atomic writes retain the prior file. See [DRAWING.md](DRAWING.md).

## Drawing flattening

`.piv`, `.stk` and SVG exports cannot carry the sparse tile store, so each v2
drawing cel materializes as an ordinary PNG sprite covering its tile bounds
(the engine's draw lists hold cels as tiles of one display level, so an SVG of a frame with a
drawing is one embedded picture of the frame: [engine rendering](engine/rendering.md#exports)).
Rasterization uses source resolution up to a 16 Mpx cap; beyond that the
largest mip level that fits is used and the export stats record the
downsampled count. Anchors are rewritten into flattened-pixel coordinates so
world placement is identical.
