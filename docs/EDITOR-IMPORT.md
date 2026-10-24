# Editor import preparation

`await editor.loadAsync(document, name, options)` publishes a document the engine opened (docs/engine/document.md, "Opening a document"). The engine decodes it, normalizes it (validation, migration, the layer sheet) and builds the indexes the editor adopts: next identities, figures per layer, tracks. The editor only reads the result into its report, in slices, and publishes it with one `document` event. A document that arrives as an object (a new document, a tutorial's, a recovery copy, an import the interface decoded) is opened from its JSON first; one the engine opened from a file already carries its view (`attachRead` in `src/engine/engine-open.mjs`). Native Pivot imports can use `initialFrameIndex: 'last'`; `initialTick` optionally seeks before that event. The synchronous `load` method reads the same view at once.

Options are `signal`, `sliceMs` (default 4; greater than zero and at most 16), `onProgress`, `initialFrameIndex` and `initialTick`. Tests can inject `yieldControl`; production uses the browser scheduler with a MessageChannel fallback. A document the engine cannot open rejects with a localized message error; a stopped import rejects with an AbortError.

The current editor report, history, selection and identity allocators remain intact until the document has been read. Abort, a newer load, or an edit/gesture on the current document cancels publication. Loading the currently open report through the async method is rejected.

`editor.lastLoadTimings` records the slices' work and the publication and listener durations. A time-slice budget is a scheduling target rather than a hardware-independent latency guarantee: garbage collection, a single unusually large pose and synchronous event listeners can take longer.

Native Pivot permits zero stored keyframes. Such imports normalize to one internal editable placeholder with `_styk.simpleFrameDraft.empty: true`. When Simple mode is enabled, `editor.timeline` is empty and `totalTicks` is zero. Stored-frame export excludes the placeholder; the first Add promotes it. Normal Simple Add drafts likewise expose the stored baseline's duration while edits continue in the working pose.

Tests: `tests/editor-load.test.mjs`, `tests/animation-validation-steps.test.mjs`, and `tests/editor-frame-draft.test.mjs` cover equivalent sync/async results, single-event publication at the requested frame, cancellation and replacement races, and stored/empty timeline semantics.
