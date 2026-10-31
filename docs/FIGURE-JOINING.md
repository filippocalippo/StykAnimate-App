# Figure joining and static-node selection

In Animate, **J** and **Join figure / Unjoin figure** in the canvas context menu
or inspector invoke the same action. A selected node or branch resolves to its
owning figure. An independently selected group of multiple figures is ambiguous
and disables this action. A branch selection may include attached descendants;
the action still operates only on the branch's owning figure.

An unjoined figure enters parent-handle picking. Eligible dynamic handles appear
red (origins orange) and eligible static handles white. The source and its descendants are excluded to prevent
cycles. Hidden and locked figures cannot be sources or targets. Clicking a target
attaches the source's origin; unjoining retains its visible position. Each edit
is one undo step, including an enabled timeline range. Escape or a second J
cancels picking. Selection, document, frame, playhead and revision changes cancel
stale gestures. Text inputs and the figure builder do not dispatch this command.

Clicking a hidden static endpoint selects its figure/node without moving its pose
or recording history. Shift-click toggles figure membership. Double-click on a
static or dynamic node selects its branch, including figures joined to it;
double-click on a body or origin selects the connected group. Normal
visible handles take priority over hidden static targets. Static posing still
requires the existing explicit editing tools; ordinary static-node dragging
does not alter the pose.

**Shift+J** now controls handle visibility. Preferences migrate only the exact old
default J visibility binding when the new join command is absent. Custom bindings
and explicitly disabled commands survive normalization. Menus, tooltips, settings
and dispatch use the common shortcut catalog.

## Implementation

`figure-join-action.mjs` resolves the owning instance and builds the eligible
target set with an iterative traversal by native object slots. `app.mjs` owns the
temporary gesture, shared action and menu item. It calls the existing sparse
figure-range planner with an explicit source UID, at the playhead or captured
range ticks. This preserves native handles/IDs, authored membership, sparse
history and atomic range validation without a second join implementation.

`canvas-interactions.mjs` supplies descriptors for both drawing and picking.
Static selection targets are lazy, separate from painted handles, and cached by
geometry through weak maps. Hover retains the visible-handle path. Picking reuses
the spatial index; the target traversal runs once per join gesture, not once per
node. Temporary selection data is neither saved nor added to document history.

## Pivot evidence

The parent `tools/pivot_decoder.py` decodes static status from flag bit `0x0100`
(the low bit of the auxiliary byte in modern segments). The parent's
`tools/piv_document.py` writes joins as a target object slot and native handle ID,
resolving persistent UIDs before serialization. Origin handle zero is distinct
from a segment array index.

`python scripts/inspect-pivot-joining.py` uses the parent's Capstone/PE tools and
asserts seven instructions against the supplied Pivot 5.2.11 executable, SHA-256
`2c7911d3303cc28de2ac016c3f7575082aa47680e63a0fe8930ce8799de3df98`:

- J at `0xB1E0FD` calls the button handler `0xB24248`.
- That handler requires one selected figure and branches on its attachment flag.
- Mouse-up uses a separate soft figure hit at `0x948CB8`; repeated clicks call
  joined selection at `0x94C080`. This is distinct from draggable-handle picking.
- The existing `artifacts/native-static/joined-handle-routing.md` describes static
  drag filtering and suppression of attached origins.

This is static executable analysis, not a new interactive native Pivot capture.
Pivot's [joining reference](https://www.pivotanimator.net/help5-2/joining_figures.htm)
and [selection reference](https://www.pivotanimator.net/help5-2/multi_figure_selection.htm)
also describe origin attachment, static targets, single-figure joining and
double-click joined selection. The app retains its existing whole-connected-group
and dynamic-branch double-click semantics.

## Verification

- `npm run check`: 939 JavaScript files checked, zero syntax errors.
- `npm test`: all 2,046 unit tests passed on the first full run. The final run
  passed 2,045 with the existing midnight-sensitive telemetry case failing;
  feature tests passed. See the limitation below.
- `node tests/join-selection.browser.mjs`: 49 checks passed using real input,
  with Simple/Advanced joins, static selection, context/inspector parity, range
  undo, cancellation, custom shortcuts and no uncaught browser errors.
- `node tests/connected-selection.browser.mjs`: connected/branch selection and
  copy/paste regression passed. Its count now reads the displayed selection
  frame, which includes authored figures, rather than the native source frame.
- `node scripts/benchmark-node-selection.mjs`: a synthetic 30,000-segment rig
  (29,000 static nodes) took about 22 ms for cold selection descriptors, 9 ms
  for its first spatial index and 0.0084 ms at the 95th percentile of 1,000 warm
  picks on this workstation. These are Node hit-testing measurements, not an
  end-to-end frame-rate claim.

Screenshots, machine-readable checks and benchmark results are generated under
`artifacts/join-selection/`. One broader browser script,
`tests/hotkeys-timeline.browser.mjs`, still fails its existing duration-growth
assertion after rebinding Add Frame: the command runs and inserts a key at tick 1
without extending duration. This task's join rebinding checks pass. That separate
timeline behavior has not been changed.

The final unit run began after 23:40 UTC. `tests/telemetry.test.mjs:79` advances
its wall-clock fixture by 20 minutes and then assumes one day's idle counter is
present. It failed independently at the same boundary and passed in a temporary
copy with a fixed noon clock (all 11 telemetry cases passed). No telemetry source
or tests were changed. The final full-suite log retains the failure rather than
claiming a fully green rerun.

## Disconnecting a segment

In Animate, a joint's canvas context menu (and the command palette) offers
**Disconnect segment**. It turns the selected segment and every segment hanging
from it into a new, unjoined figure, named after the segment, on the same layer.
The command applies to that instance in every frame and pose source of the
animation, so each key keeps its drawing: the new figure's origin sits on the
joint where the part was attached, with the displayed pose (pinned IK and
joined-parent poses included). Tweens between keys now move the new figure's
origin on its own path rather than following the old parent bone. The new
figure is selected; one undo restores the original figure.

A linked instance (a definition shared with other figures) is first given its
own copy of the definition, so the other instances keep the whole rig. The part
paints in front of or behind the remaining figure, according to where its
segments sat in the figure's drawing order. Fills inside the part move with it;
figures joined to a joint of the part stay joined to the same joint of the new
figure. IK controllers whose chain lies inside the part move with it; a chain
crossing the cut is shortened, as Build's Delete does.

The command is unavailable for the origin, for a segment holding the whole
figure, for movieclips and drawing layers, and on hidden or locked figures. It
refuses, without changing the document, figures with connectors, stretch parts
or 3D rigs, a figure origin placed on the part, a fill that spans the cut, and
figures still animated by legacy property curves.

### Implementation

The engine session (`styk-edit/src/disconnect.rs`) publishes one compound history step of three commands. A `disconnect` command inserts
the new instance beside the source in each native keyframe and pose source that
holds it, forking a shared definition; its definitions travel in
`figureDefinitionSplice` and its layer membership in `frameUidCounts`, so undo,
layer indexes and source retention use the existing paths. Two ordinary
`_topologyEdit` calls (with an explicit `definition`) then trim the new and the
remaining definitions, so IK, per-instance styles, effects and validation reuse
the topology repair and whole-document validation. Handle IDs are preserved,
which keeps joins, styles and IK tables keyed without remapping. Geometry is
evaluated once per affected pose, only for the source's joined component.

Coverage: `tests/editor-disconnect.test.mjs` (Simple and layer timelines,
reopening, linked instances, joined children, pinned IK, fills, refusals) and
`tests/disconnect-segment.browser.mjs` (the real context menu, undo and redo
shortcuts in both timelines).
