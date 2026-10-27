# Pose Tweener

Select figures in Animate, place the playhead between keys, and choose a tween
type from the arrow on the **Tweener** toolbar button. Click a figure's handle or
artwork to select it without leaving the tool; Shift-click adds or removes figures.
Dragging a different figure selects it first. Dragging a selected figure or empty
canvas keeps the current selection. Drag horizontally to preview; release to apply.
Selection clicks work even where the selected figures have no neighboring keys;
tween preparation and validation start only after horizontal dragging begins.
**Escape or right-click cancels** and
restores the original pose without opening a context menu. The tool operates on whole
selected figures, including their joint poses, rather than individual selected
handles. It does not insert time or bake a sequence of frames.

| Mode | Amount |
| --- | --- |
| Breakdown | 0% is the previous pose; 100% is the next pose. |
| Blend to Neighbor | -100% is the previous pose, 0% the original, +100% the next. |
| Relax | Moves the original pose toward the in-between at the playhead's proportional time. |
| Push | Reflects the Relax displacement to exaggerate the original pose; scale stops at zero. |

The toolbar distinguishes Breakdown (purple), Neighbor (blue), Push (orange),
and Relax (green) by color, icon and name. Clicking the main button activates the
last chosen type; its arrow or right-click opens the four-item flyout. Arrow keys
and Enter can select a type. The flyout closes after selection; there is no settings
panel or confirmation dialog. A small percentage readout appears only during a drag.

Breakdown starts at 50%; other modes start at 0%. A 300-pixel horizontal movement
changes the amount by 100 percentage points, independent of canvas zoom. Shift
reduces sensitivity tenfold. A click without horizontal movement does not edit
or create a key. Space/middle-button panning uses the existing canvas behavior.
Changing tools, losing pointer capture or window focus also cancels the gesture.

These modes follow the concepts in [Blender's In-Betweens manual](https://docs.blender.org/manual/en/latest/animation/in_betweens.html).
This is a figure pose tool, not Blender's Graph Editor or a full bone-channel filter.

Each selected layer supplies its own strict previous and next authored keys. The
key at the playhead is excluded, as are movieclip frame replacement boundaries.
The selection must exist with the same rig and attachment parent at both ends.
Blank endpoints, missing neighbors, hidden layers and locked selections reject
before opening a gesture. Movieclip instances keep their playback descriptors;
open a clip to tween the figures inside it.

Releasing a drag writes a key at the exact playhead in the existing layer sheet, including
inside held exposures and when the new pose equals the displayed interpolation.
It preserves timing, identity, appearance, figure definitions and unrelated tracks.
An unchanged existing key creates no history. The result saves through the normal
project format and participates in ordinary playback, undo and redo. Low-level
native documents without a layer sheet edit an existing stored frame.

## Ownership and performance

The engine session's `beginTween` and `updateTween` (`engine/crates/styk-edit/src/tweener.rs`) own neighbor resolution and pose planning. It captures
endpoint projections once at gesture start, with only selected figures and their
attachment ancestors. Definitions are shared by reference. The existing native
evaluator supplies parent-relative angle wrapping, animation-origin and IK
interpolation; existing authored pose gestures own preview, validation and history.
Push reflects the relaxed pose's translation, joint, origin and constraint changes.
Constraint configuration is retained from the original pose.

No document clone, timeline sampling, per-tick expansion, worker transfer, or
history capture occurs on pointer input. Each update evaluates compact two-pose
projections from immutable baselines and invalidates the existing affected-object
render caches. Input is coalesced to one update per animation frame; release flushes
the final pending value. The host canvas owns pointer capture and the shared tool
state. The controller clears pending animation frames and its gesture on cancellation
and removes listeners on disposal.

The selection is limited to 256 figures and 100,000 joints. Gesture preparation
samples each distinct endpoint tick once through the existing scene evaluator;
that initial work can still depend on scene complexity. Joined ancestors are
retained as required for correct interpolation. This is not a claim that every
dense imported scene will open or render within a fixed frame budget.

## Verification

Run from the repository root:

```sh
node --import ./tests/support/register-engine.mjs --test tests/tweener.test.mjs tests/layer-sheet.test.mjs
node tests/tweener.browser.mjs
npm run check
```

The browser test uses the running local app on port 47831 (override with
`STYK_URL`) and captures light, dark and compact layouts under `artifacts/tweener`.
Unit coverage includes cancellation, drift-free input, strict neighbors, held
and unchanged-pose key insertion, independent layers, shortest-angle rotation,
selection isolation, undo/redo and project reopening.
