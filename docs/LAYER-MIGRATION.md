# Layer membership and independent animation

Imported figures begin on one user layer. Native-only assignment changes remain sparse metadata edits. When the source or destination has independent pose keys, moving a figure preserves its composed appearance at every integer playback tick and publishes the assignment and new destination pose channel in one undo command.

The planner retains only the destination figures and their attachment ancestors. Other layers, scalar channels, native frames, definitions, and media retain their existing references. This preserves internal and cross-layer joins without applying scalar animation twice. Destination pose keys use hold interpolation because each integer playback pose is sampled explicitly.

## Background API

```js
editor.setLayerMigrationPlanner((params, options) =>
  playback.planLayerMigration(params, options));

await editor.assignFiguresToLayerAsync(uids, destinationLayerId, {
  signal: abortController.signal,
  onProgress({phase, completed, total}) { /* sampling or staging */ },
});

await editor.deleteLayerAsync(layerId, {
  targetLayerId: destinationLayerId,
  signal: abortController.signal,
  onProgress,
});
```

The worker uses its acknowledged playback mirror. It does not receive another full document for a layer move. Result chunks are acknowledged individually and staged before publication. The editor validates new source poses, builds independent report-owned copies in short yielding batches, and checks the report, revision, and frame identity counter again before committing. Cancellation, invalid data, or an edit during planning leaves the existing document intact.

History owns immutable source assets separately from editable report sources. Undo removes only the newly created assets and restores prior channel and membership references. Redo reuses private report-owned source copies; subsequent shared Rig changes cannot corrupt the history assets.

## Limits and verification

Synchronous callers retain the 10,000-tick planning limit. The background generator supports the document time range up to 10 million ticks, subject to the one-million-key limit and retained pose limits. It stops before cloning a source that would exceed the 128 MiB estimated source budget; the transfer separately enforces a 128 MiB payload limit. These limits protect memory and fail atomically. They do not guarantee that every possible scene fits.

Tests cover cross-layer ancestor closure, all-tick geometry preservation, scalar overlays, empty layers, default-layer deletion, source identity safety, cancellation during staging, stale edits and document replacement, malformed source rejection, shared Rig history isolation, exact undo/redo, and a real playback worker through editor commit without resending its retained document.

The actual application test imports the 17 MB Akane project and moves joined figure UID 460611 into a new layer through the layer panel callback. Its 1,872-tick preservation job took 9.42 seconds in the background; publication took 9.8 ms, with no recorded long tasks and a maximum animation-frame gap of 13.9 ms. Nine complete-scene joint snapshots matched exactly after assignment, undo, and redo. The history command occupied 1.79 MB. This is a measurement on the tested machine, not a universal latency guarantee. The progress dialog was rendered and inspected. See `artifacts/akane-layer-migration-app/report.json` and `tests/akane-layer-migration-app.mjs`.
