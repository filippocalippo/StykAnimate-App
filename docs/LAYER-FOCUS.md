# Layer focus

In the Advanced timeline, Ctrl/Command-click layer names to select several layers
and choose **Focus → Focus selected layers** from a layer's context menu. Focus filters
the timeline list while every layer keeps its existing canvas visibility. Selecting
a figure from another layer leaves the focused list in place. **Show all layers**
in the list header ends focus.

**Focus and lock** also prevents selecting or editing figures on other layers.
Their artwork remains visible as a reference. It accepts the same multiple-layer
selection; Camera and Scene are temporarily locked too. The saved eye and lock
settings are preserved, so Show all restores those settings exactly.

The **Filter layers** checklist is independent of focus and its temporary locks.
It reports when focus is active and offers **End focus**; resetting the checklist
keeps focus in place. Both restrictions must allow a layer for its row to appear.

Focus is session state owned by `src/editor-layer-focus.mjs`, separate from the
document's layer metadata. A weak map associates the focused layer IDs and the
temporary lock with the live report only. Copies used for saving, export and
playback do not inherit this editing restriction. Layer descriptors expose
`savedLocked`, `focusLocked` and the effective `locked` value, and the existing
figure lock predicate includes the temporary lock. Focus changes invalidate
selection/layer UI without changing document revision or undo history. They have a
revision of their own (`layerFocusRevision`, apart from `layerRevision`, which counts
the engine session's changes of the layers); caches of how the layers look key on both
(`layerViewKey`).

Edits run in the engine session, which has no focus of its own: with **Focus and lock**
the editor sends the focused layers with every call, and the session refuses an edit of
any other layer, Scene or Camera as it refuses a saved lock, with the same message.
A layer a call creates is free. The focus does not outlive the call that carried it.

Document replacement and timeline disposal clear focus. Deleting a focused layer
prunes it from the set; deleting the last focused layer ends focus. Figure, connected
group and marquee selection all enforce the same temporary selection boundary.
Metadata edits such as renaming or folder organization remain available.

New layers join the active focus before their first edit or selection. This also
applies when Draw creates its first drawing layer, a paste adds missing layers,
or converting a drawing to a movieclip creates a figure layer. **Focus and lock**
keeps other layers temporarily locked while the new layer is ready to edit.
Undoing creation removes the absent layer from focus; focus is not saved in history.

Focused regression coverage lives in `tests/editor-layer-focus.test.mjs`,
`tests/layer-focus.browser.mjs` and the timeline organization browser regression.
These check selection across layers,
multiple focused layers, rejected pose/key edits, unchanged saved locks and history,
creation through Draw, timeline and movieclip commands, and cleanup when a project
or its focused layers change.
