# Insert Inbetween

The command inserts one chosen pose immediately before every selected native
source key. The dialog previews that pose in a worker; dragging its ratio slider
does not change the document. Insert prepares the entire selection asynchronously and applies it in one undo.

The interaction follows Pivot's [frame controls](https://pivotanimator.net/help5-2/animation_frame_controls.htm).
The more specific easing and exposure rules were verified by read-only inspection
of the supplied Pivot 5.2.11 binary, with source hash, RTTI names, disassembly and
a reproducer in [the native evidence](../artifacts/native-static/insert-inbetween.md).

| Chosen ratio | Inserted pose | Inserted exposure |
| --- | --- | --- |
| 0 | Previous source key | Previous source exposure |
| Between 0 and 1 | Forced-linear previous-to-clicked interpolation | Clicked source exposure |
| 1 | Clicked source key | Clicked source exposure |

Original exposures, including zero-duration hidden poses and the stored final
exposure, stay unchanged. New exposure adds time; this operation does not split
an existing exposure or bake the entire movie. Native Insert Inbetween forces
linear interpolation even when playback uses automatic easing. The project's
easing setting stays unchanged. Its hidden previous source is therefore sampled
without a zero-duration PCHIP division.

The native menu disables the first source key. The low-level helper supports
copying the first key, which the model also supports for a mixed selected range.
The dialog uses a 0.001 ratio step, matching the native 0–1000 ratio control.

## Model API

`src/editor-inbetween.mjs` exports `editorInbetweenMethods` and its installer.
`Editor` installs the methods directly.

```js
const preview = editor.previewInbetween(0.375, 4);
// {frame, ratio, sourceTick, insertionTick, index}

const result = editor.insertInbetweenFrames(0.375, [1, 4, 8]);
// {insertedFrames, ratio, indices, ticks, frameIds, durations, skippedIndices: []}

editor.setInbetweenPlanner((request, options) => {
  syncPlayback();
  return playback.planInsertInbetweens(request, options);
});
const resultAsync = await editor.insertInbetweenFramesAsync(0.375, [1, 4, 8], {
  signal: controller.signal,
  onProgress: ({phase, completed, total}) => updateProgress(phase, completed, total),
});
```

Input indices refer to the original selected native keys. Results identify the
newly inserted keys after all insertions. Indices are validated, deduplicated and
sorted before planning. Ratios must be finite numbers in 0–1. Empty selections
are no-ops. The preview returns shared read-only pose data; callers must not edit
it. `sampleInbetweenPreview(report, ratio, index)` is the worker-safe sampler.

`planInsertInbetweens(editor, ratio, indices)` validates a complete insertion
without reserving identities or changing the document. It snapshots only the new
poses and shares existing assets and source frames. The commit uses one `ranges`
history entry, with sparse channel and retained-source patches when necessary.
Original frame IDs remain valid; each inserted frame receives a new identity.

`planInsertInbetweenSteps` is the cooperative, worker-safe form of the same
planner. The async application path uses the existing acknowledged playback
worker report, then receives only new poses and changed channels in 64 KiB ACK
chunks. It does not send a second animation snapshot. Cancellation discards the
unpublished plan, and a changed document, revision, playhead, identity allocator,
or Simple working-frame checkpoint prevents a stale commit.

Main-thread staging validates all newly captured poses and authored channels,
clones independent report copies in short batches, and prepares UID retention
counts and history-size accounting. Publication swaps the prepared frame array
and records one command. Undo removes the new frames; redo reuses their detached
report copies without sharing mutable poses with history snapshots. Existing
frames, definitions and media keep their references. `lastInbetweenTimings`
reports staging, commit, total duration, and estimated history bytes. A local
cooperative fallback remains available when no playback planner is connected.

## Independently authored timing

The operation remains a whole-document native-frame insertion in authored
projects. Each selected native interval maps to its actual time, and every
existing authored key at or after an insertion moves by the inserted exposure.
Noncontiguous selections are sampled before any destination changes.

Layer, Scene and Camera poses are sampled separately from absolute scalar curves.
Only pose data enters new retained source assets. New scalar keys reproduce the
chosen property values, avoiding double-applied rotation or scale. A scalar
curve that begins after the chosen sample cannot mask its underlying pose.
Existing key identities, hidden references and interpolation modes are retained.
The inserted pose keys inherit their preceding authored interpolation mode.

Zero-exposure insertions create hidden pose references in the correct coincident
key order. They do not create scalar keys, because scalar tracks have no hidden
key representation. Scalar-only documents require no retained pose assets.

## Dialog and timeline integration

`InsertInbetweenDialog` is a standalone modal. Root application wiring:

```js
const dialog = new InsertInbetweenDialog({
  editor,
  getSettings: () => settings,
  renderThumbnail: thumbnailRenderer.renderThumbnail,
  onApply: refreshUI,
});
// Pass to SimpleTimeline and Timeline:
const onInsertInbetween = indices => dialog.open(indices);
```

Omit `renderThumbnail` to give the modal its own thumbnail worker. The preview
uses a 512×288 canvas, byte-bounded document transport, one render in flight and
coalesced latest-ratio requests. Once loaded, the worker snapshot is reused for
slider and onion changes. Closing aborts requests and releases an owned worker.

Clicking the preview cycles adjacent before/after skins, the user's configured
skin count/direction/opacity, and no skins. A dropdown previews any selected key;
Insert applies the same ratio to every selected key. During preparation, a
phase label and progress bar report progress while the pose controls are locked.
Cancel and Escape remain active and abort planning or unpublished staging. The
dialog awaits `insertInbetweenFramesAsync` when installed and retains the
synchronous API fallback for isolated clients. A cancelled operation's delayed
progress or result cannot alter a newly opened dialog. Cancel, Escape, invalid
text, concurrent document changes and worker errors cannot commit a partial
range. A queued close event from a prior session cannot close a reopened modal.

Both timeline frame views expose **Insert inbetween…**. The Advanced layer view
labels it **Insert document inbetween…** and targets the current native source
key; independently authored property-key insertion remains a separate command.

## Validation and limits

Transitions requiring more than two different blended background images reject
before document changes. The message suggests an endpoint ratio or simplifying
the neighboring background blends. Figure definitions and media remain shared.

A command supports at most 10,000 insertions, within the 100,000-source-key
document limit, 250,000 captured object poses and 3,000,000 segment values.
Authored keys must remain within tick 10,000,000. Larger requested ranges reject
atomically. Background planning is implemented, with a separate 128 MiB result
transport budget; it does not remove the document and command allocation limits.

Verified:

- `node --test tests/editor-inbetween.test.mjs`: 14 tests, including actual PIV
  and STYK codec round trips, joined geometry, forced-linear/easing separation,
  exposure inheritance, hidden keys, authored curves, media/source preservation,
  bounded planning and atomic undo/redo.
- `tests/editor-inbetween-async.test.mjs`: seven tests cover exact sync/async
  native and authored results, staged cancellation, stale-edit/checkpoint
  rejection, malformed worker plans, derived-cache exclusion, and independent
  history/source copies after subsequent shared-rig edits.
- `tests/playback-inbetween-planning.test.mjs`: seven protocol tests include
  actual retained-worker results, bounded ACK transport, cancellation, stale
  revisions, corrupt transfers, and continued playback after planning.
- `node tests/insert-inbetween-dialog.browser.mjs`: actual worker pixels,
  repeated ratio/onion updates, cancellation/reopen, invalid-value races,
  multiple selected keys and both timeline context actions. Fourteen verified
  scenarios include real async planner cancellation, Escape, stale delivery,
  progress, one-undo completion and concurrent document/edit rejection. The 160-input burst
  reused one worker snapshot; this fixture's largest transport task was under
  1 ms. [Evidence](../artifacts/insert-inbetween-dialog.json).
- `node tests/insert-inbetween-app.browser.mjs`: imported `tween_pendulum.piv`
  through the real app, opened its context menu, previewed 37.5%, inserted two
  keys through the connected worker planner and undid to the exact original
  native document. All five root integration checks pass.
  [Evidence](../artifacts/insert-inbetween-app.json).
- `node tests/akane-inbetween-async-app.mjs`: imported the 17 MB Akane project
  (1,479 native keys and 208,373 object poses), then inserted 20 keys at 37.5%
  through the actual connected worker. All inserted pose arrays, identities,
  joins, paint order, camera and backgrounds matched the synchronous planner;
  original frame references remained intact. One-step undo, redo and cancelled
  follow-up planning preserved exact state. Background planning and transport
  took 8.39 seconds; staged main-thread work yielded across 270 ms. The commit
  took 16.3 ms, undo 9.6 ms and redo 8.2 ms. No long tasks or page errors were
  recorded, but the largest animation-frame gap was 104.2 ms; this test does
  not establish uninterrupted frame delivery. [Measured result](../artifacts/akane-inbetween-async-app/report.json)
  and [visually inspected imported scene](../artifacts/akane-inbetween-async-app/inserted-range.png).

The two dialog/browser correctness checks ran with hardware GPU disabled to avoid interference with the
separate native/GPU benchmark. They verify UI and worker rendering behavior,
not hardware-GPU performance. [Dialog screenshot](../artifacts/insert-inbetween-dialog.png)
and [real app screenshot](../artifacts/insert-inbetween-app.png).

The [preparation screenshot](../artifacts/insert-inbetween-progress.png) was visually inspected; the progress indicator and active Cancel control fit inside the compact modal.
