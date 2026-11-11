# Shared animation state across timeline modes

Simple and Advanced are views of the same `Editor` document, history, and pose evaluator. Switching views does not flatten the animation or create a second document.

> Layer-sheet documents (every document opened by the app) do not use the working-frame checkpoints described below: the Simple filmstrip edits the same sheet keys as the Advanced exposure sheet, so Add/Update/Discard drafts and `storedFrameReport` apply only to native documents. The editor no longer implements them: the engine session keeps the working-frame commands (`styk-edit/src/frame_draft.rs`), and the interface starts none.

## Working frames

Simple retains its Add, Update, and Discard workflow. A working frame checkpoint contains the native frame baseline and, when an authored property changes, an optional `animationBaseline`. This is a reference to the immutable channel table before the first edit. An explicit `null` means the working edit created the first animation channels. Unaffected frames and channels are shared.

Both native edits and authored pose, property, camera, and Scene edits participate in the checkpoint. Discard restores both kinds of state in one undo command. Update accepts both. History records the checkpoint state, so undo/redo still works after switching timelines.

Simple playback, thumbnails, and native animation output read `storedFrameReport`. For an Add draft, that projection substitutes both the stored frame and its original animation channels. The editable canvas continues to show the working pose. Simple's transport timing uses the same stored channel baseline. Recovery/project serialization retains the checkpoint and the working channels, and cooperative loading validates both before publishing the document.

## Adding and changing stored frames

In Animate, Add frame (A) keeps pointer capture during a joint pose, bend, or
figure-root drag. It commits the current pose, inserts the next frame using the
active timeline's normal rules, and continues dragging from the same pointer
position. This works in Simple and Advanced. Each completed pose and frame
insertion stays undoable; Escape cancels only the unfinished pose on the new
frame. Draw strokes, Build edits and duplicate-placement gestures finish normally.

## Mode transitions

The app commits active inspector and canvas gestures before replacing the timeline. A pending Add becomes a distinct stored frame when switching to Advanced; an Update remains on its existing frame. Planning failure retains the existing timeline, document identities, draft, and mode preference. Obsolete frame ranges and loop selections are cleared after a successful transition. Timeline components own their listeners, thumbnail jobs, and disposal; model semantics stay in editor modules.

Simple thumbnails represent stored native frame rows. Advanced can also place independent keys between those rows. Those keys remain in the shared animation and are evaluated by playback in either mode.

## Verification

With the development server running:

```sh
node --test tests/pivot-frame-draft.test.mjs
node tests/animation-mode-sync.browser.mjs
node tests/simple-timeline.component.browser.mjs
node scripts/check.mjs
```

The tests cover the Pivot export of a saved working frame and the Simple timeline component. The browser test exercises actual Settings switches and Simple Update, checks the final playback pose and rejected-switch recovery, and captures both timelines under `artifacts/animation-mode-sync/`.

## Draw workspace

Draw is presentation state over the same document and timeline modes. Entering
it selects an eligible drawing layer but creates no content. Leaving waits for
pending drawing edits and restores the previous figure layer and joint, tool,
joint visibility and view rotation. If that layer is no longer editable, it
selects another visible, unlocked figure layer. A figure layer deliberately
selected while in Draw is preserved. Onion preferences and
panel sizes remain shared; each workspace keeps its own panel arrangement and
its own saved layouts (View › Layout…). Drawing content holds between keys; copies receive
independent pixel identities. [Drawing workflow](DRAWING.md) describes controls.
