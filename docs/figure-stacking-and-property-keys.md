# Figure stacking and property keys

The figure inspector's **Arrange** section holds the figure's Layer and its
**Order** stepper: the Z-index, with **Send backward** and **Bring forward** on
either side (one step each). **To front** and **To back** are the figure's quick
actions under its name; Shift steps them by one. Higher values draw in
front within the same user layer. Equal values preserve the pose's native draw
order. Z-index is an integer from −1,000,000 to 1,000,000, defaults to zero, and
uses Constant interpolation: the order changes exactly at the next key.

Segment and polygon Order controls also belong to the current timeline pose.
Numeric edits, ordering buttons and branch ordering retain a combined drawing
sequence for that figure instance. Editing another frame does not rewrite the
shared figure definition or the order saved in earlier frames. Playback and
native export preserve these internal orders.

The canvas toolbar resolves the complete selection before choosing its order
scope. A selection spanning attached figures moves all selected instances within
their user layers, preserving their relative paint order and each figure's
internal artwork. A selected joint in a single-segment figure, or a branch
containing an entire figure, also moves the instance in scene order. A partial
segment or branch selection confined to one figure changes only its internal
order. Repeating a move at a boundary does not change scope or create history.
The inspector's explicit segment and polygon Order controls remain internal.
The joint inspector's **Front** and **Back** quick actions use this same
selection-aware scope, including complete attached branches. As with figures,
a normal click moves all the way to front/back; Shift-click moves one step.
They replace Isolate, Values and Match in the top row; those commands remain in
the selection menus.

In the timeline, blue diamonds indicate independent property animation. Filled
diamonds mark a key at the current frame; outlines indicate animation between
keys. The inspector shows no key state: no diamonds or key-navigation controls
for any property, and no separate keyframe controls for joint transforms. It
omits explanatory paragraphs, key legends and subtitles.

In the app, editing an independently animatable property adds or updates its
own key at the current frame, including the first edit. Property-only edits do
not add Pose keys. Deleting the last authored key restores the native baseline;
the next property edit creates its channel again. Mixed pose gestures separate
changed properties from skeleton changes. See [Independent property channels](property-channels.md)
for the complete property list and compatibility behavior.

## Implementation

- `animation-properties.mjs` defines channel names, supported targets and
  discrete properties, shared by validation and the timeline.
- Z-index channels target stable figure UIDs. The engine's evaluation writes
  `_stykZIndex` on an evaluated object, retaining its geometry vectors; captured
  poses and clipboard objects retain this small override.
- The engine stably sorts depths within user layers after pose and scalar
  composition (`styk_eval`). Object slots and attachment references are never
  reordered.
- Authored order commands (`styk-edit`) write Z-index keys directly, including
  tied depths, so independent figure poses cannot override them. Native-only
  editing retains native paint order. History and range edits remain atomic. The
  canvas toolbar provides Bring to front and Send to back for the current
  selection. Holding Shift while clicking moves the selection one step forward or
  backward instead.
- Playback and export use the same evaluation. Pivot materialization
  writes the resulting native draw order and removes the depth extension.

Regression coverage lives in `tests/figure-z-index.browser.mjs`, alongside the
engine's recorded order tapes and the existing animation, property-control,
timeline, range-operation and clipboard checks.

`tests/selection-order.test.mjs` covers selection scope, joined groups, stable
ordering, history and reopening. `node tests/inspector-order.browser.mjs` checks
the current Properties buttons for nodes, partial branches and attached figures
in Simple and Advanced, including boundary clicks, undo/redo and rendered order.
`node tests/selection-order.browser.mjs` checks
actual joint double-clicks and toolbar clicks in Simple and Advanced, including
Shift moves, rendered order, unchanged poses/attachments and STYK/PIV round trips.
It also accepts the reported `Firing Range Bren MKII.piv` path as its argument;
the external project is read only and test exports stay in memory.
