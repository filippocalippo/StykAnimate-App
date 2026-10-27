# Timeline interaction and verification

Implementation: [layer-timeline.mjs](../src/layer-timeline.mjs). Reproduce the browser checks
with `node tests/timeline.browser.mjs` from the app directory. Current results are
in [timeline-verification.json](../artifacts/timeline-verification.json).

## Layer exposure grid

New projects start with Blue and one constant key at frame 1 on Camera, Scene
and Layer 1. Each key holds through frame 10, in both Simple and Advanced mode.
These are explicit layer exposures, not ten duplicated poses.

The [pose Tweener](TWEENER.md) authors selected figures at the exact playhead,
using each layer's neighboring keys, with live preview and one undo step.

The movieclip inspector's **Add to next keyframes** action adds the selected
instance at its current position to the next X existing authored keys on its
owning layer. It skips keys already containing that instance without overwriting
them, stops at the layer's end, and never creates frames or key boundaries.
Other figures, Scene/Camera content, easing and timing stay intact. The additions
retain one movieclip identity and playback clock and undo together in one step.
Frame-only movieclip replacement boundaries do not count as authored keys.

The current Advanced grid is implemented in `src/layer-timeline.mjs`. Dragging
from an unselected cell (including an occupied key) selects a rectangular range.
Only a range selected before pointer-down can move, starting on an existing pose
or blank exposure. Empty cells outside exposures select ranges without moving or
creating frames; Shift-drag extends selection.
Clicking inside a selected range preserves it. Delete clears its keys without
changing duration or shifting later keys; the opening key at tick zero is retained.
Remove Frames remains a separate command that removes time.

The ruler coalesces pending pointer positions while an editable preview is being
prepared and submitted. Release requests the exact final tick.

With a VFX clip selected, previous/next frame shortcuts move the playhead without
selecting a layer cell or clearing the clip selection, including outside its duration.

Effect rows retain their target while selecting layer cells or seeking with that
selection, including blank frames and ranges. An explicit figure/scene selection
refreshes the target. Reindexing computes the complete row layout before changing
the scroll extent, so temporary removal of effect rows cannot clamp scroll position.
`tests/feedback-workflow.browser.mjs` checks real pointer range selection at the
bottom of a scrolled sheet and a later explicit selection change.

## Independent layer and property tracks

User layers can be grouped in collapsible folders in both timeline views. See
[Layer folders](LAYER-FOLDERS.md) for ordering, saving and editing behavior.
[Layer focus](LAYER-FOCUS.md) describes persistent multi-layer focus and the
temporary Focus and lock option.

The default Advanced timeline uses the actual user layers, with permanent Scene
and Camera tracks above them. User layers appear front-most first, matching the
layer browser. Disclosure opens layer pose channels, figures, and their property
channels. Empty property rows are insertion targets, not fabricated keys.
The layer count excludes property rows. Eye, lock, and add-layer buttons call the
model's layer commands. The header shows the current track, key count, timecode,
and output-frame position.

Native Scene, Camera, and layer pose descriptors are requested lazily only when
their keys are needed. Merely displaying them does not author or bake animation.
Summary diamonds refer to the exact underlying channel/key identities. A drag
previews a snapped offset, then commits one key move (a session command) on release. First
editing a native track adopts it within that same undo command. No global Pivot
frame is moved when a single layer key is moved.

| Input | Independent-track behavior |
| --- | --- |
| Drag ruler | Scrub using the existing lazy preview callbacks. |
| Click a key | Select that actual key or its summary references. |
| Shift-click / Ctrl/Cmd-click | Range selection / independent toggling. |
| Drag selected key(s) | Move selected channel keys; occupied destinations reject atomically. |
| Alt-drag | Duplicate selected keys at the snapped destination. |
| Drag empty track space | Marquee-select keys across visible track rows. |
| Alt-Left/Right | Nudge keys one frame; add Shift for ten frames. |
| F6 / Delete | Insert at playhead / delete selected channel keys. |
| F7 | Insert a blank pose on Scene, Camera, a user layer, or a Pose channel. |
| Page Up/Down or comma/period | Visit keys of the current track, including coincident hidden keys on pose rows. |
| Enter / Up / Down | Expand the current track / select an adjacent row. |
| Ctrl/Cmd-A, C, X, V, D | Select track keys, copy, cut, paste at playhead, duplicate. |

The Move dialog accepts an exact destination frame. The context menu restores one
selected hidden pose key through the engine's independent timing command. Channel
clipboard paste is restricted to its source document and uses one bulk key command.
Locked layer keys reject timeline edits. Native hidden key identities remain in
their leaf pose channel even when a summary combines coincident references.

The visible Blank button and matching menu item perform the same command as F7.
Blanking first adopts the native pose track and inserts a `{frameId:null}` key in
one history command, preserving earlier source poses. It selects only that actual
pose key, even when unrelated property keys share its tick. Blank poses use open
circles in the timeline. Layer blanks remove that layer's figures; Scene/Camera
blanks use their canonical defaults while separately authored scalar channels
continue to apply. Scalar and figure-property rows explicitly disable Blank and
F7 announces which track kinds support it, without invoking a host shortcut.

`selectTrack(id, {notify:false})` updates the highlighted track while preserving
key selection and without editor mutations or selection callbacks. Pass
`notify:true` for the same model selection behavior as clicking a row. Optional
`onTrackSelect(descriptor)` and `onKeysChange([{channelId,keyIds}])` callbacks connect
the host inspector with those exact grouped IDs.
`setMode('frames')` switches to whole-document editing; `setMode('tracks')` returns
to independent tracks. Destruction cancels pointer/paint RAFs and removes listeners.

Run `node tests/timeline-channels.browser.mjs`. The
[channel report](../artifacts/timeline-channels-verification.json) verifies native
single-layer isolation, no mutations during drag, unchanged native frame data,
one-command adoption undo/redo, scalar and range dragging, collision rejection,
keyboard nudging, insertion/deletion, layer flags, and view switching. Blank-key
checks cover F7 event isolation, figure presence, prior source poses, exact key
selection, pose-leaf/Scene toolbar actions, the Camera menu, canonical defaults,
and disabled scalar handling. The pure
projection test indexes 20,000 collapsed layers without materializing native key
tables; reading six visible rows requests six cached tables. This evidence covers
timeline-to-engine commands; composition and output-pose equivalence are separate
engine acceptance checks.

## Navigation and zoom

The zoom slider and any zoom without a pointer position keep the playhead where
it is; when the playhead is out of view the zoom brings it to the middle of the
grid. Ctrl/Cmd-wheel zooms under the pointer in proportion to the wheel delta, so
a mouse notch is about 16% and a trackpad zooms continuously. Shift-wheel and
middle-drag pan.

A seek outside a drag keeps the playhead in view: stepping, the transport and Go
to frame page the grid forward (playhead near the left) or back (playhead near
the right). Playback pages forward only while the playhead was in view, so
scrolling away to inspect other frames is left alone. The touch timeline keeps
its centred playhead instead.

A drag held within 28 pixels of the grid's edge scrolls it for as long as the
pointer stays there, faster nearer the edge: sideways for every drag, and up or
down for ranges and moved frames (a ruler scrub scrolls time only). The speed is
set per second (120 to 1,200 pixels), so it is the same at every refresh rate,
and a press that starts inside an edge zone scrolls only once the pointer moves
toward that edge: selecting in the first row under the pinned ones leaves the
grid still. Once the rows
no longer fit, they
scroll up to three row heights past the last layer, so the bottom layers clear
the scrollbar and the "N more" button.

Camera and Scene, with the Camera's Motion row and the Scene's effect lanes,
stay pinned under the ruler while they take at most half of the grid's height or
leave room for three content rows; a taller block scrolls with the layers.

A wheel over the layer names scrolls the rows like one over the grid: a mouse
notch glides to its place and notches add up, a trackpad's small steps apply
directly, and reduced motion jumps. Each visible row keeps its label node while
it stays in view, so a scroll moves the nodes and fills only the row that came
into view; the nodes stay in row order for the keyboard. In an 85-row list with
21 rows in view, a scroll frame's timeline work fell from 4.0 ms to 1.3 ms
(labels from 2.5 ms to 0.2 ms; Canvas 2D test browser, Ryzen 5 5500).

Run `node tests/timeline-navigation.browser.mjs`.

## Playback range

Both timelines expose **Playback range** beside Loop; Timeline ⋯ lists it only
while that button is folded away in a narrow header. Enter
inclusive output-frame limits (50–100 plays all 51 frames), or **Use selection**.
Simple selections include each selected card's full exposure and inbetweens.
Limits remain independent of later editing selections; Loop repeats them, and
disabling Loop plays to the last selected frame and stops. **Entire animation**
clears the limits. Frame numbers clamp to the current duration; shortening a
document clamps the range, while a new document or timeline-mode switch clears
it. Playback limits are session UI state and do not change saved timing or exports.

Run `node --test tests/playback-window.test.mjs` and
`node tests/playback-range.browser.mjs`.

## Whole-document frame editing

The Frames view toolbar adds a pose keyframe, inserts a blank keyframe, edits timing,
duplicates or deletes selected keyframes, and opens the remaining frame actions.
The More menu preserves the existing selection. Right-clicking an unselected key
selects it before opening the menu. A fixed track header and numbered playhead
remain visible while scrolling. The layer divider supports pointer dragging,
Left/Right keyboard adjustment, and double-click/Home reset to 176 pixels.

| Input | Behavior |
| --- | --- |
| Click/drag the ruler or exposure | Scrub an exact output tick. |
| Shift-click | Select every stored key between the anchor and clicked key. |
| Ctrl/Cmd-click | Toggle a stored key independently; all keys may be deselected. |
| Left/Right | Move one output tick. |
| Page Up/Down or comma/period | Visit the previous/next stored key, including hidden keys. |
| Shift-Left/Right | Extend selection to the previous/next stored key. |
| Ctrl/Cmd-comma/period | Visit and toggle the previous/next stored key. |
| Home/End | Visit the first/last output tick. |
| Ctrl/Cmd-A, C, X, V, D | Select all, copy, cut, paste after the playhead, duplicate. |
| F7 / Delete | Insert a blank keyframe / delete selected keys. |
| Ctrl/Cmd-wheel or +/− | Zoom around the playhead. |

Stored keys and output ticks are distinct. Several hidden keys can share one
output tick; stored-key navigation uses `editor.selectFrame(index)` so these keys
remain individually editable. The toolbar identifies the active key as hidden,
and its Timing action can restore a positive duration. Output-tick navigation
continues to use `editor.seek(tick)`.

Ctrl/Shift frame selection and comma/period navigation follow the supplied
[Pivot frame-control conventions](https://pivotanimator.net/help5-2/animation_frame_controls.htm).
Frame operations are undoable in this application. Zero-selection delete
is a no-op. Sparse reverse, timing and bake
commands receive the exact sorted index set. Painting uses cached selection runs
and set membership, so gaps remain visibly unselected. A playback range requires
one continuous selection.

## Timing and baking

The Timing dialog synchronizes exposure frames with inbetweens, handles mixed
values, and applies the chosen duration to the selected keys in one history
command. Duration zero hides a key. The model retains Pivot's terminal-frame rule.
Blank insertion preserves the current camera/background.

Baking materializes output poses through the model's bounded range command.
Hidden keys remain stored. Sparse baking selects only the resulting selected
keys, leaving untouched gaps unselected. The model validates allocation limits
before the timeline allocates the resulting selection. Partial connected runs
with automatic easing are rejected before mutation; the dialog displays the
model's corrective instruction. Chosen-ratio insertion is a separate feature and
is not implemented by this range-baking workflow.

## Scrub integration

`Timeline(container, editor, callbacks)` exposes the following optional callbacks:

- `onScrubStart(targetTick)` runs before the first editor seek/selection event.
- `onScrub(tick, frameIndex)` follows each distinct, coalesced pointer seek.
- `onScrubEnd(tick, {cancelled, frameIndex})` runs for release, cancellation,
  lost capture, blur, Escape, or destruction, even if release did not change time.
- `onRangeChange(indices)` is deferred until gesture completion. It runs before
  `onScrubEnd`, while the host can still suppress expensive inspector updates.
- `onSeek(tick, frameIndex)` runs at scrub start/end and normal navigation, not
  on each intermediate move.
- `onLoopRangeChange(range)` receives `null` or `{startTick, endTick}` with an
  exclusive end. Timing edits update markers; structural frame-count changes
  clear them.

The host must suppress normal scene evaluation while scrubbing, show available
prepared worker previews, and settle the exact editable frame at completion.
Timeline pointer seeks use `editor.seek(tick, {evaluate:false})`; keyboard seeks
retain normal evaluation. The latest pending move is consumed at most once per
RAF. Pointer release cancels any older pending move and flushes its exact tick.

## Recorded evidence and remaining acceptance

The browser regression verifies toolbar actions, timing fields and presets,
sparse selection/reverse/baking, zero-selection behavior, hidden-key
navigation/restoration, loop callbacks, cancellation, resize, and undo. It also
verifies zero eager evaluations across a 144-move burst, one seek per RAF, one
deferred range notification, and exact final-tick handling.

The virtualized fixture contains 20,000 tracks and 1.2 billion output ticks. It
uses six label nodes, a 944-pixel viewport canvas, and an 8,000,000-pixel maximum
scroll spacer; headers and ruler stay fixed in both axes. Normal sampled playback
reuses the grid bitmap. These measurements cover timeline structure and input
work, not GPU completion or input-to-photon latency of complex imported scenes.

The whole T01–T07 and T10 acceptance items remain unsigned in
[PIVOT_PARITY.md](PIVOT_PARITY.md). Remaining work/evidence includes the complete
imported-inbetween edit policy, multi-frame figure operations, legacy timing and
interpolation matrices, chosen-ratio insertion/background-transition rejection,
long-run playback drift, actual scrub preview presentation, and full
visibility/lock/output semantics. T08 and T09 remain supported by the named
timeline implementation and regression artifacts.


## Canvas figure clipboard

Canvas Ctrl/Cmd-V creates independent definitions for ordinary figures. Movieclips
retain shared definitions and, in the layer sheet, reuse absent source instance
IDs and playback clocks; collisions allocate fresh object IDs. Right-click offers
Paste instance (shared definitions) and Paste unique copy (independent definitions,
including movieclips). Mixed selections apply the default per figure type.
Timeline-focused Ctrl/Cmd-V continues to paste timeline keys/frames.

`pasteSelection` and `pasteFiguresInFrames` accept `pasteMode: 'default' |
'instance' | 'unique'`. The insertion planner prepares one definition per copied
type per operation, shared across range destinations, and records only inserted
assets and changed poses. Unique copies use the captured clipboard design.
Immutable movieclip documents are retained until editing publishes a replacement.
Cross-document pastes import captured definitions because source IDs are local.

Figure clipboard snapshots include `sourceVersion` so cross-project insertion
preserves the source color interpretation. Legacy absolute colors (including
negative black sentinels) become full-strength modern overrides; modern figures
inserted into legacy projects retain segment-color semantics. Conversion touches
only inserted poses and definitions, and stays inside the existing paste undo.

## Drawing layers

Drawing rows have a brush icon, DRAW badge and cel thumbnails in wide exposures.
They share the same sheet as figure, Scene and Camera rows. On an active drawing
layer, A inserts a blank at a held cell or a next blank after the exposure at a
key. Only that drawing layer changes, in Simple and Advanced timelines and in
Draw or Animate. Shift+A extends the hold, and F7 inserts a blank here. Copy here
is in the context menu; Next copied drawing is in the timeline toolbar. No F5 extension alias is
added. These current bindings supersede legacy F6 descriptions above.

Blank/copy at the playhead preserve later keys; Next blank/copy inserts time
after the current exposure. Drawing copies detach pixels, while a hold retains
one cel. Clear keys and Remove frames retain their existing distinct timing
semantics. See [the drawing contract](DRAWING.md) for target and history rules.
