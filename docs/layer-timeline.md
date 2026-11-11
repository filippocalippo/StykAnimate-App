# Layers and frames

The **Audio** icon opens shared [audio editing](AUDIO.md), hidden by default.
Advanced places sound tracks under animation layers with one ruler, playhead,
zoom and scroll area. Its footer follows the selected animation cell or audio
clip. Simple opens an Audio tab in the filmstrip area. Closing audio editing
restores animation space while sound keeps playing. The timeline's splitter and
Tall timeline (in the header's view tools) provide more room in either mode.

Waveform clips support source trimming, split/copy/paste, volume, fades and
mute/solo. Audio uses seconds and snaps to the current frame rate. Explicit
Ripple follows whole-scene time insertion/removal; single-layer pose edits
leave audio timing intact. Drag clips between tracks (Shift preserves time),
or drop onto the new-track row to create a destination in the same undo step.

The Advanced timeline is an exposure sheet. Each row is a persistent user layer; each cell is one output frame. A scene frame is the complete vertical column. The Simple filmstrip displays the combined scene at the union of layer key times. Switching views changes no animation data and creates no working-frame or property-channel overlay.

Camera's disclosure collapses its motion lanes while retaining the camera keyframe row. A collapsed Camera shows the motion count. The control supports Enter/Space and Left/Right; collapsing affects only the view and survives edits and undo. Selecting a motion reveals its lanes again.

Select a layer to keep its contents selected while scrubbing, including when its contents change or disappear. Add or paste figures into that layer. Multiple figures and movieclips can share a layer. Layer order controls stacking. Rename by double-clicking the name; drag names or use the arrows to reorder. Eye and lock controls affect visibility and editability. Deleting a layer removes its contents and is undoable.

| Action | Shortcut |
| --- | --- |
| Previous / next frame (scene frame in Simple) | , / . |
| Jump to previous / next keyframe on the selected layer (scene frame in Simple) | Shift+, / Shift+. |
| Extend keyframe by one output frame | Shift+A |
| Remove selected frames | Shift+F5 |
| Insert a pose key | F6 |
| Duplicate current pose into the following cell | Ctrl+Enter |
| Clear key boundary | Shift+F6 |
| Delete selected frames | Delete |
| Copy / cut / paste layer frames | Ctrl+C / X / V |

Click a cell to select it; Shift extends the selection. Double-click a held or empty cell to insert a key, or use the inline plus on the selected cell. Double-click a key to select its exposure. Drag from an unselected cell, including a key, to select a range. Drag an already selected range to retime it; Alt copies. Drag the exposure's right edge to change its duration. Drag between rows to transfer a frame range. Pasting replaces the destination range; Simple Paste inserts a complete scene range. Same-layer frame copies retain figure identities. Cross-layer or cross-project copies allocate distinct instance identities once per copied range. External attachment parents are not accidentally copied as new figures.

A Hold span displays one pose. Editing a held cell edits its preceding key; press A first to make a new pose. **Auto key** (the header's record toggle, K; Advanced only, off by default, saved as the `autoKey` preference) instead keys the playhead for every edit on a frame without its own key: figure poses and properties, camera, scene, layer properties, effect values (a first key on an unanimated value) and drawings (painting a held drawing first copies it to the playhead). The new key inherits the preceding key's easing; one edit remains one undo step. While it is on, the playhead turns red. The editor owns the policy (`editor.autoKey`, synchronized from the preference and timeline mode by `app.mjs`) at the same places that choose a held cell's key, so every entry point behaves like pressing A during the gesture. Choose “Insert blank keyframe” in the frame menu to intentionally clear the layer. Add Frame inserts a key at the selected cell; when every selected layer already holds a key there, it instead duplicates the current pose into the following cell and shifts later keys. A key placed beyond a layer's end carries its last exposure forward to reach it. Blank cells draw as outlined spans with open-circle keys. Simple mode duplicates all scene layers, including Camera and Scene. Each duplication is one undo step. Choose Linear or an easing curve to interpolate between keys. An edit within a tween creates a key at the playhead. Camera and Scene tracks are always visible above the figure layers, each with its own color and icon. Frame menus contain frame operations; layer menus contain naming, visibility, locking and layer operations. Delete and Cut remove time rather than authoring blank cells.

The Advanced sheet's rows share one geometry (`src/timeline-rows.mjs`, used by the layer, camera-motion, effect and audio painters and their hit tests): a 32px ruler (24px at the short height tier), Camera and Scene as 24px rows pinned under it while they take at most half the grid's height, and 32px content rows (28px at the short tier). Every row is a lane with a hairline under it and one marker (a type glyph or the layer's colour dot); eye and lock stay visible at rest, quiet until a layer is hidden or locked. Every 5th frame's column (every 10th, 20th or 50th zoomed out) is softly shaded under its ruler number, the ruler draws a tick at each frame's edge, and past the animation's end the grid is grey behind a clear end line. Every exposure is one rounded bar from its key to the next key (the last hold runs to the row's end), so a held pose reads as one piece: a hold in the neutral bar colour (`--sheet-cell`), a tween in the time violet (`--sheet-cell-tween`), a blank span a dashed outline (`--sheet-cell-blank`); nothing is drawn before a layer's first key. Once a frame is 10px wide, 1px seams inside a bar (`--sheet-cell-divider`) count its frames. Keys are ink dots at the start of their bar (Camera gold, Scene violet; blank keys hollow), and a layer's own colour stays a dot in its label; Camera and Scene name themselves in their colour. The current layer is marked in the label column only, never across the grid; the selected frames get a blue wash (`--sheet-cell-selected`) and one blue outline around the range (a single frame too), and the hovered frame is outlined. The every-5th-frame shading stays in the ruler, under its numbers. Drawing cels and effect clips are neutral blocks whose keys carry the colour. While the pointer is on its row, the selected exposure shows a small grip at its end: dragging it holds the pose longer or shorter (the grip reaches up to 12px into the exposure but never its middle, so a key's centre still moves the selection), and while keys or a hold are dragged a small label shows the timing ("5 → 9"). The playhead is a 1.5px line with a white-on-blue frame tab inside the ruler. The grid keeps 14px scrollbar targets with a slim thumb; when content rows are below the visible grid, a fade and "N more" at the grid's lower right scroll to them. Onion ranges show on the ruler while onion skin is on; each end is a 24px target on its own side of the frame it marks, and a press that does not move past 3px is a click on the ruler (it goes to that frame) while a drag moves the end.

Simple Add frame copies the current complete scene to the end. Simple shows each scene frame as a card (`sheet-filmstrip.mjs`, experience.md §5.6): the whole-scene thumbnail on a white rounded card (the current and selected cards outlined in blue), the number, and one duration bar whose length is the hold on the strip's shared scale (the longest hold fills its card). The current card, a hovered one and a bar being dragged say their count in words ("6 · 5 inbetweens"); the other cards show their number only, and the current card's number carries a dot while its working copy is edited. Drag a bar's end to hold that frame longer or shorter, by whole inbetweens, one undo step at release (a click on the bar changes nothing; Escape cancels); the bar's range input ("Frame N inbetweens") carries the value for the keyboard. While an animation plays, the cards stay still: a short line moves along the bars to where playback is (only its transform changes; no card renders and no layout is read), and when playback stops the card it stopped in is selected and scrolled into view.

The Simple frame bar sits in the label column's place: "Frame 6 of 8 · holds 0.25 s" and the whole length in time ("2.0 s in all", its tooltip counting the timeline frames with the inbetweens); **Inbetweens** (a stepper: − and + step every selected card, typing sets them all); **Easing** (today's six modes; Mixed when the selected cards differ; choosing one applies it, and a double-click on a card opens the easing popover with its Bezier handles); **Copy**, **Paste** and Delete frames; **Edit together** (the header's command and state, which Simple shows here instead of in the header); and the layer Simple edits ("Layer ● Bubble ▾", `#layers-button`), which opens the **Layers** popover: the layers top first with their colour, eye and lock, a click choosing the layer new figures go into, and New layer and Drawing layer at its foot. At compact width the bar is one column; at the short height tier its first line drops. These edits change all layers together. Edits made in either view are visible immediately in the other.

Apply camera to figures preserves the projected pose at the selected sheet keys.
Those new poses participate in the layer's interpolation, so neighboring tweens
can change. Native save and Pivot export reproduce the resulting sheet animation.

## Document and compatibility

**Settings > Animation > Timeline > Replace keyframes on drop** is enabled by
default and saved with editor preferences. Turning it off blocks occupied
destinations when dragging or Alt-dragging keys within a layer.

Dragging selected keys onto existing keys replaces keys at their exact landing
frames on the same layer. Incoming poses and easing win; intervening keys survive.
Alt-drag copies follow the same rule. Overlapping selections are captured before
replacement, and one Undo restores both source and overwritten keys. This follows
[Adobe Premiere's keyframe replacement behavior](https://helpx.adobe.com/sa_en/premiere/desktop/add-video-effects/control-effects-and-transitions-using-keyframes/edit-keyframes-graphs.html).

`_styk.layerSheet` owns the duration and every layer's ordered key sequence. Keys have stable cell IDs and either a retained pose reference (or explicit blank) or an imported source time. Figure `unique_id`, layer ID, cell ID, and pose-source ID are different identities. Changing time never allocates a figure identity.

Imported spans are evaluated through an immutable compatibility baseline, retaining native holds, automatic easing and old authored curves. Only affected endpoints are captured when a span changes. This avoids copying a whole imported animation for one edit. Old native poses, unknown fields, and legacy curve data remain available for reading and native-project saving. They are not a second authoring surface.

The former property-row Advanced component, per-figure movieclip bars, old Simple component, and separate authored-key navigation strip have been removed. The public timeline module names now export the replacement components. Legacy reader/projection regression fixtures live under tests and are not loaded by the app.

Every edit plans and validates its result before publication, then records one undoable change. Clipboard transfers and movieclip commands group their constituent changes. Rendering, playback, thumbnails, SVG/image/video export and Pivot materialization sample `evaluatedFrame`. Native STYK files retain editable layer data. Pivot export samples the resulting scene in the export worker because Pivot has one scene-wide frame sequence.

The grid renders visible rows and columns only. Pose history stores affected sources and shares unchanged tracks. Imported source evaluation is shared between layers sampling the same time.

Filmstrip cards own their event listeners and preview markers. Eviction releases
both, prunes queued work, and rejects late results for replaced cards. Hidden
mounts defer preview work and reveal the selected frame at their first visible
layout; subsequent renders preserve deliberate scrolling. The focused regression
is `node tests/sheet-filmstrip.browser.mjs`.

The timeline uses the studio's icons, fields, menus and color tokens. Figure and movieclip Properties include a Layer selector. Scrubbing coalesces pointer positions to one seek per display frame, paints the playhead separately, and retains the grid and layer DOM. Unchanged imported poses retain native object identities for geometry reuse.

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

The polish checks exercise the duration bars, multi-frame inbetweens, preset and custom easing, menu contents and keyboard dismissal, opening-frame insertion, cut, exact undo, and keeping the current scene frame selected when earlier timing changes.

Behavior references: [Adobe frames](https://helpx.adobe.com/animate/desktop/animation/frames-keyframes.html), [Pivot frames](https://www.pivotanimator.net/help5-2/animation_frame_controls.htm), [Stick Nodes movieclips](https://sticknodes.com/new-version-3-0-0-the-movieclip-update/).

## Timeline organization and compact layout

Simple and Advanced share one header (`timeline-header.mjs`, experience.md §5.6)
in three clusters: Simple │ Advanced, **Add frame** (one button for both modes;
Blank frame on a drawing layer, and there the **Next copy** split: Next blank
drawing, Blank drawing here, Copy drawing here, Extend) and **Edit together**
(`#range-edit`: shown with its word and count only while two or more frames
are selected, never on a one-frame file); the transport (First frame,
previous, Play, next, Loop, the MM:SS:FF readout and the frame rate); and the
view tools (the timeline zoom, **Fit timeline** and **Tall timeline**), then after
a hairline Onion (a split button), Audio (a dot while the animation has sound) and **Timeline ⋯**
for the rare rows (Last frame, Previous key, Next key, Default height; Timeline…
first while the timeline is folded; at the minimal width First frame, Loop
playback, Audio and Edit together, whose buttons fold there). A click on the
readout opens **Go to frame** (a frame of the ruler in Advanced, a card in
Simple). The clusters never touch: the transport slides into free space, then
the zoom slider folds and the words fold in order (Edit together's, Next copy's,
Add frame's last; at the minimal width the view tools leave the header and Fit
timeline leads Timeline ⋯); the
header measures itself only on a resize or when its words change, never while
playing. There is no persistent bottom command/status bar; extra view commands
live in the ruler's context menu.

The view tools (the timeline zoom, **Fit timeline** and **Tall timeline**) lead
the header's end cluster, so the Advanced grid and Simple's cards take the
island's whole width and no frame, number, playhead tab or onion end is ever
under a tool.

The layer list's header holds the title "Layers", **Show all** (only while a
layer focus is on; a layer's menu and the grid's menu focus layers), **New layer** (a split button: + makes
a layer, in Draw a drawing layer, and the chevron the other kind; the new row
opens its name for typing) and **Find layers** (Ctrl/Cmd+F from the grid; its
field takes the title's place while it has focus or text). Layer ordering
remains available by dragging rows and through the layer commands.
Audio clip controls open from the audio toolbar. Audio selection hides
frame-authoring controls; switching back to frame cells restores them.

Find layers filters user rows by case-insensitive words; Camera, camera motions
and Scene remain available. Focus selected layers retains a fixed set of user
rows until cleared. Both are view-only, do not change canvas visibility or undo,
and reset on document load. Escape clears search/focus; Ctrl/Cmd+F from the grid
focuses search. Selecting a filtered-out layer from another editor surface reveals
it by clearing the filter. New layers are revealed too. Frame operations use only
visible selected layer IDs; filtered-out rows are not implicit edit targets.

Layer context menus offer saved color tags, focus and rename. Colors use validated
optional layer metadata and sparse undoable commands; they never change rendering
or frame data. Dragging above/below a user row shows the corresponding insertion
edge. F2 renames a visible selected layer. The layer-name divider supports arrow
keys (Shift for larger steps), Home and double-click reset.

Ctrl/Cmd-wheel zooms around the pointer; slider zoom retains viewport center.
Timeline indexing creates lazy key descriptors. Filtering traverses lightweight
layer descriptors only; painting and row DOM remain viewport-bounded.

Checks: `node --test tests/timeline-organization.test.mjs`,
`node tests/timeline-organization.browser.mjs` and `node tests/timeline-header.browser.mjs`
(the header's clusters, Timeline ⋯, Go to frame, Edit together, the minimal
folds, the layer list's header and, where the timeline stylesheet is loaded, no
overlapping header controls at the tier sizes), plus the existing layer timeline
and audio navigation browser regressions. Browser artifacts are written to
`artifacts/timeline-organization/` and `artifacts/timeline-header/`.

### Contextual easing and view navigation

Double-click an Advanced keyframe dot or Simple frame thumbnail to change easing.
Right-click > Change easing preserves multi-frame selection. Advanced applies the
curve to the selected layers' outgoing keys (including the exposure containing
the range start). Simple retains its whole-scene boundary isolation. Each apply
is one undo step. Both use the same preset/custom Bezier editor; locked selections
cannot apply changes. Advanced has no persistent easing selector; Simple also exposes easing in its
frame bar. The card menu keeps to the selected frames (Change easing…, Copy, Cut and Paste frames,
Delete frames; Unlock layers while they are locked); Add frame's home is the header.
Duration bars remain duration controls, independent of easing.

Middle-button drag pans without changing selection or document data. The ruler's
zoom control changes Advanced time scale or Simple thumbnail width; Simple audio
uses that same variable frame-to-pixel mapping. Ctrl/Cmd-wheel zooms at the pointer.
Simple cards retain viewport eviction and fixed, bounded thumbnail resolution.
The contextual regression is `node tests/timeline-context.browser.mjs`.

### Onion range and thumbnail lifetime

Before/After are fixed output-frame distances from the playhead. Seeking,
pending scrubs, panning, zooming and document boundaries never change these
preferences. The ruler markers are brackets at the outer edges of the frames
`playhead - before` and `playhead + after`, with a tinted band over the frames
in each range, and move with the playhead. Their positions are not pinned to
authored keys or document edges. Only the visible projection clips at the timeline
viewport. No additional onion toolbar or row is inserted above the ruler.

A marker never covers the playhead's tab: at short distances it sits beside the
tab (`onion-timeline-range.mjs` follows the tab's width with a ResizeObserver
instead of reading layout while painting). Dragging a marker changes its distance
by one frame per timeline frame under the pointer, so it follows the pointer at
every zoom; pressing a marker never seeks. Its count shows while hovered, focused
or dragged. Markers support arrow keys, Home (zero) and Escape during a drag. The
**Timeline markers** switch in onion settings (`onionTimelineMarkers`, on by
default) hides them without turning onion skin off.

The settings panel provides numeric fields, single-frame minus/plus buttons and
label scrubbing, including when a marker is outside the viewport. Label scrubbing
uses eight pointer pixels per output frame, or 32 with Shift held when the gesture
starts; movement below one step does nothing.

Sampling selects output frames or authored keys inside the requested range,
respecting sample spacing and available document poses. It never rounds outward
to a neighboring key. Only sample counts shrink near the document edges; the
stored values, displayed values and visual offsets stay fixed. Ranges have no
ten-frame cap. Simple mode uses the same settings panel without a ruler overlay.

`onion-range.mjs` owns the cached document index and range/sample calculations.
`onion-controller.mjs` owns the sole transient preference session. Ruler markers
and `onion-frame-field.mjs` (through `onion-range-drag.mjs`) measure displacement
from a fixed start; previews do not persist, and release commits once. Escape,
pointer cancellation, blur, seeking, document edits and view disposal clear the
session. A superseded view cannot commit another view's preview. Onion edits
never enter document history. Native slider cancellation also suppresses its
trailing release/change event.

`onionRangeBefore`/`onionRangeAfter` store output-frame spans. The controller
interprets legacy Before/After values as fixed distances (including their saved
spacing), independent of document/key spacing, and persists the explicit pair
on the first range/sampling edit.
Colors and other settings retain their values. The views and the request that asks
the engine for the skins (`OnionController.request`) share the same range calculation;
the engine plans the skins ([onion-skin.md](onion-skin.md)) and keeps their evaluated poses
while the document is the same, drawing the nearest forty-eight at most.

Verification: `node tests/onion-timeline-range.browser.mjs`,
`node tests/onion-controls.desktop.mjs`, and the `onion-controller`,
`onion-timeline-range`, and `onion-skins` unit tests. Desktop coverage includes native 75%, 100%, 150%, and 200% UI scaling.

Audio tracks share the timeline's existing scroll area. Opening audio or adding
tracks preserves the user's timeline height; resizing remains a manual action.

Simple thumbnails retain up to 32 rendered canvases (7.5 MiB of pixel storage),
independent of the viewport's card DOM. Cache eviction releases canvas storage.
Returning to recent frames copies cached pixels without worker rendering. Pixel
changes conservatively invalidate the cache; audio and layer label/color/lock
changes do not. Cancellation retries use a 120 ms to 2 s bounded backoff and stop
when paused/disposed. A separate render target prevents late results from painting
stale cards. Document synchronization and rendering remain in ThumbnailRenderer's
single worker; the UI yields between results. See THUMBNAIL-PERFORMANCE.md.
