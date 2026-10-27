# Layer membership and independent animation

Imported figures begin on one user layer. Native-only assignment changes remain sparse metadata edits. When the source or destination has independent pose keys, moving a figure preserves its composed appearance at every integer playback tick and publishes the assignment and new destination pose track in one undo command.

The planner retains only the destination figures and their attachment ancestors. Other layers, scalar channels, native frames, definitions, and media retain their existing references. This preserves internal and cross-layer joins without applying scalar animation twice. Destination pose keys use hold interpolation because each integer playback pose is sampled explicitly.

## API

```js
await editor.assignFiguresToLayerAsync(uids, destinationLayerId, {signal: abortController.signal});
await editor.deleteLayerAsync(layerId, {signal: abortController.signal});
```

Both await the engine session's `assignFiguresToLayer(uids, id)` and `deleteLayer(id)`
(`engine/crates/styk-edit/src/layer_membership.rs`), which plan the change with the sheet kernel
(`layer_planning::sheet_layer_plan`) from the poses of the whole animation and publish it as one history entry,
in one call. There is no progress and no cancellation once the call has begun: a `signal` already aborted
cancels the call before it starts. Deleting a layer moves its figures to the first other layer; choosing the
layer (`targetLayerId`) is not a session call. A document without a layer sheet is refused (the app gives every
document one).

History owns immutable source assets separately from editable report sources. Undo removes only the newly created assets and restores prior track and membership references.

## Limits and verification

A move may sample the document's whole time range (up to 10 million ticks), subject to the one-million-key limit and the retained pose limits; it stops before keeping a source that would exceed the estimated 128 MiB source budget. These limits protect memory and fail atomically. They do not guarantee that every possible scene fits.

The recorded sheet migrations (`engine/tests/layer-sheet-migration`) give the document, the history entry, the change events and the counters the editor recorded for every case (shared, vacant, combined, absent, joined, dense, movieclip and deletion cases) and the editor's refusals (`engine/crates/styk-edit/tests/layer_sheet_commands.rs`); `tests/engine-owner-commands.test.mjs` states what the interface reads. The editor's own JavaScript implementation of the sync forms (`deleteLayer`, `assignFiguresToLayer`) remains for bare editors in tests until they move to engine-owned editors.
