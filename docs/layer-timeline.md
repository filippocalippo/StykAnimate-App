# Layers and frames

The Advanced timeline is an exposure sheet. Each row is a persistent user layer; each cell is one output frame. A scene frame is the complete vertical column. The Simple filmstrip displays the combined scene at the union of layer key times. Switching views changes no animation data and creates no working-frame or property-channel overlay.

Select a layer to keep its contents selected while scrubbing, including when its contents change or disappear. Add or paste figures into that layer. Multiple figures and movieclips can share a layer. Layer order controls stacking. Rename by double-clicking the name; drag names or use the arrows to reorder. Eye and lock controls affect visibility and editability. Deleting a layer removes its contents and is undoable.

| Action | Shortcut |
| --- | --- |
| Extend exposure / insert frames | F5 |
| Remove selected frames | Shift+F5 |
| Insert a pose key | F6 |
| Duplicate current pose into the following cell | Ctrl+Enter |
| Clear key boundary | Shift+F6 |
| Delete selected frames | Delete |
| Copy / cut / paste layer frames | Ctrl+C / X / V |

Click a cell to select it; Shift extends the selection. Double-click a held or empty cell to insert a key, or use the inline plus on the selected cell. Double-click a key to select its exposure. Drag a key directly to retime it; Alt copies. Drag the exposure's right edge to change its duration. Drag between rows to transfer a frame range. Pasting replaces the destination range; Simple Paste inserts a complete scene range. Same-layer frame copies retain figure identities. Cross-layer or cross-project copies allocate distinct instance identities once per copied range. External attachment parents are not accidentally copied as new figures.

A Hold span displays one pose. Editing a held cell edits its preceding key; use F6 first to make a new pose. Beyond a layer's end, F6 carries forward its last pose. Choose “Insert blank keyframe” in the frame menu to intentionally clear the layer. Ctrl+Enter (or the duplicate button) inserts the current pose in the following cell and shifts later keys on the selected layers. Simple mode duplicates all scene layers, including Camera and Scene. Each duplication is one undo step. Choose Linear or an easing curve to interpolate between keys. An edit within a tween creates a key at the playhead. Camera and Scene tracks are always visible above the figure layers, each with its own color and icon. Frame menus contain frame operations; layer menus contain naming, visibility, locking and layer operations. Delete and Cut remove time rather than authoring blank cells.

Simple Add frame copies the current complete scene to the end. The green slider below each preview changes its inbetweens. The Inbetweens field applies to all selected scene frames, and Tweening (or a double-click on a preview) opens the easing controls, including editable Bezier curves. These edits change all layers together. Edits made in either view are visible immediately in the other.

## Document and compatibility

`_styk.layerSheet` owns the duration and every layer's ordered key sequence. Keys have stable cell IDs and either a retained pose reference (or explicit blank) or an imported source time. Figure `unique_id`, layer ID, cell ID, and pose-source ID are different identities. Changing time never allocates a figure identity.

Imported spans are evaluated through an immutable compatibility baseline, retaining native holds, automatic easing and old authored curves. Only affected endpoints are captured when a span changes. This avoids copying a whole imported animation for one edit. Old native poses, unknown fields, and legacy curve data remain available for reading and native-project saving. They are not a second authoring surface.

The former property-row Advanced component, per-figure movieclip bars, old Simple component, and separate authored-key navigation strip have been removed. The public timeline module names now export the replacement components. Legacy reader/projection regression fixtures live under tests and are not loaded by the app.

Every edit plans and validates its result before publication, then records one undoable change. Clipboard transfers and movieclip commands group their constituent changes. Rendering, playback, thumbnails, SVG/image/video export and Pivot materialization sample `evaluatedFrame`. Native STYK files retain editable layer data. Pivot export samples the resulting scene in the export worker because Pivot has one scene-wide frame sequence.

The grid renders visible rows and columns only. Pose history stores affected sources and shares unchanged tracks. Imported source evaluation is shared between layers sampling the same time. The Fig 107 diagnostic (`scripts/verify-layer-import.mjs`, using the local decoded fixture) checks duplicate identities, geometry evaluation and exact undo on 194 imported native frames / 3,782 historical instance IDs.

The timeline uses the studio's icons, fields, menus and color tokens. Figure and movieclip Properties include a Layer selector. Scrubbing coalesces pointer positions to one seek per display frame, paints the playhead separately, and retains the grid and layer DOM. Unchanged imported poses retain native object identities for geometry reuse. `scripts/benchmark-layer-scrub.mjs` measures imported and edited-layer seeking against the native evaluator.

## Verification

- `node --test tests/layer-sheet.test.mjs tests/layer-movieclips.test.mjs`
- `node tests/layer-timeline.browser.mjs` with the local server running
- `node tests/layer-timeline-modern.browser.mjs`
- `node tests/timeline-polish.browser.mjs`
- `node tests/movieclip-commands.browser.mjs`
- `node --test tests/*.test.mjs`
- `node scripts/check.mjs`

The browser test performs real cell/keyboard interactions, mode switches, and binary STYK/PIV export-import comparisons. Model tests cover ownership, connected figures, blank spans, easing, history, clipboard assets, scene/camera editing, movieclip clocks and legacy import.

The browser also checks key and cross-layer dragging, layer reordering, rename, locks and compact layouts. Regression cases cover exact-cell inspector ranges, imported segment-style repair after rig edits, blank Camera/Scene cells, camera baking, and Stick Nodes projects containing nested movieclips.

The polish checks exercise the green sliders, multi-frame inbetweens, preset and custom easing, menu contents and keyboard dismissal, opening-frame insertion, cut, exact undo, and keeping the current scene frame selected when earlier timing changes.

Behavior references: [Adobe frames](https://helpx.adobe.com/animate/desktop/animation/frames-keyframes.html), [Pivot frames](https://www.pivotanimator.net/help5-2/animation_frame_controls.htm), [Stick Nodes movieclips](https://sticknodes.com/new-version-3-0-0-the-movieclip-update/).
