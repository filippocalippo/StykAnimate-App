# Shared animation state across timeline modes

Simple and Advanced are views of the same `Editor` document, history, and pose evaluator. Native stored frames keep their identities; Advanced pose and property channels remain sparse. Switching views does not flatten the animation or create a second document.

## Working frames

Simple retains its Add, Update, and Discard workflow. A working frame checkpoint contains the native frame baseline and, when an authored property changes, an optional `animationBaseline`. This is a reference to the immutable channel table before the first edit. An explicit `null` means the working edit created the first animation channels. Unaffected frames and channels are shared.

Both native edits and authored pose, property, camera, and Scene edits participate in the checkpoint. Discard restores both kinds of state in one undo command. Update accepts both. History records the checkpoint state, so undo/redo still works after switching timelines.

Simple playback, thumbnails, and native animation output read `storedFrameReport`. For an Add draft, that projection substitutes both the stored frame and its original animation channels. The editable canvas continues to show the working pose. Simple's transport timing uses the same stored channel baseline. Recovery/project serialization retains the checkpoint and the working channels, and cooperative loading validates both before publishing the document.

## Adding and changing stored frames

`frame-draft-animation.mjs` plans authored Add operations using the sparse insertion planner in `frame-clipboard-authored.mjs`. The plan is prepared against the stored projection before publication. The native frame changes, channel changes, and retained pose sources are published as one range-history command.

An append after the last authored key holds its final pose rather than introducing a synthetic resume frame. Ordinary held tails use sparse boundary keys, independent of exposure length. Automatic easing may require bounded local sampling to preserve preceding output; the existing insertion budgets still apply. When authored animation continues beyond the native insertion point, the ordinary insertion planner preserves that continuing tail.

Stored-frame operations retain a pending authored Add pose by applying only its changed keys to the resulting animation. The working keys follow the current frame's new start tick. Key and tick maps avoid repeatedly scanning channels. Removed native frames that remain referenced by the working pose are retained as source assets. Source collection includes live checkpoints and their undo/redo records.

Shared rig changes remap checkpoint animation styles alongside live styles. Topology history keeps the corresponding before/after checkpoint references.

## Mode transitions

The app commits active inspector and canvas gestures before replacing the timeline. A pending Add becomes a distinct stored frame when switching to Advanced; an Update remains on its existing frame. Planning failure retains the existing timeline, document identities, draft, and mode preference. Obsolete frame ranges and loop selections are cleared after a successful transition. Timeline components own their listeners, thumbnail jobs, and disposal; model semantics stay in editor modules.

Simple thumbnails represent stored native frame rows. Advanced can also place independent keys between those rows. Those keys remain in the shared animation and are evaluated by playback in either mode.

## Verification

With the development server running:

```sh
node --test tests/animation-mode-sync.test.mjs tests/editor-frame-draft.test.mjs tests/pivot-frame-draft.test.mjs tests/stored-frame-playback.test.mjs tests/frame-clipboard-authored.test.mjs
node tests/animation-mode-sync.browser.mjs
node tests/simple-timeline.component.browser.mjs
node scripts/check.mjs
```

The mode regression tests cover pose/curve checkpoints, camera and Scene, stored worker output, Add/Discard, previous-tick preservation, a 65,535-tick exposure without per-tick source allocation, stored-frame deletion, shared rig splitting and rollback, history across modes, invalid checkpoint rejection, rejected transitions, and project serialization/reopening. The browser test exercises actual Settings switches and Simple Update, checks the final playback pose and rejected-switch recovery, and captures both timelines under `artifacts/animation-mode-sync/`.

Large-project workloads, measured latency, memory retention, and the performance invariants are documented in [Animation mode performance](animation-mode-performance.md).
