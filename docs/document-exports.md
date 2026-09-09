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
});
```

Pass the live report directly. Calling `editor.serialize()`, `structuredClone()`,
or `JSON.stringify()` first would recreate the main-thread pause this API avoids.
Snapshots use the shared document transport with a 256 KiB packet budget, a
3 ms preparation budget, receiver acknowledgments, and explicit input yields.
Large embedded source strings, glyph records, and pose arrays are split without
serializing the whole document. Only keyframe object `runtime_segments` caches
are omitted; unknown fields and opaque media survive.

A dedicated worker assembles each snapshot, synchronizes existing derived
aliases, validates the scene, serializes JSON, uploads it to the local file
service, and reads the binary result. Missing display aliases remain absent so
an untouched STK or legacy document does not become a semantic edit merely from
normalization. A Blob returns to the renderer without JSON or base64 conversion.
Use the native Blob streaming helper to save it through Electron; browser
downloads and IndexedDB can consume the Blob directly.

The caller must abort on **every document mutation**, including the start of an
uncommitted drag or another preview operation. Revision checks additionally
reject snapshots changed between batches or while the service is exporting.
An aborted snapshot never returns a file. Catch `AbortError` separately and
reschedule recovery after the next idle period. Manual save should report the
cancellation and retain the unsaved state. `dispose()` cancels every active job.

`exporter.lastTimings` records the most recent successful export's chunk count,
snapshot duration, maximum synchronous chunk preparation/post duration, total
main-thread preparation time across all yields, and worker normalization,
serialization, HTTP, and output sizes. Background completion may take seconds
for very large scenes; those durations do not represent UI blocking.

Run `node tests/document-export-browser.mjs` for real PIV/STK byte identity,
native persistence across an actual backend restart, preserved unknown fields,
fractional edits, cancellation, and export long-task measurements. Pass a file
path to test another project. Results are written to
`artifacts/document-export-browser.json` (or the Akane-specific report).

Native `.styk` and `.stkz` results use the versioned compressed container
described in [Native file format](native-file-format.md). Do not parse a saved
file directly as JSON; reopen it through `ImportClient`.
