# Timeline interaction and verification

Implementation: [timeline.mjs](../src/timeline.mjs). Reproduce the browser checks
with `node tests/timeline.browser.mjs` from the app directory. Current results are
in [timeline-verification.json](../artifacts/timeline-verification.json).

## Independent layer and property tracks

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
previews a snapped offset, then calls `moveAnimationKeys` once on release. First
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
the host inspector. `selectedAnimationKeys` returns those exact grouped IDs.
`setMode('frames')` switches to whole-document editing; `setMode('tracks')` returns
to independent tracks. Destruction cancels pointer/paint RAFs and removes listeners.

Run `node --test tests/timeline-channels.test.mjs` and
`node tests/timeline-channels.browser.mjs`. The
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
Frame operations are undoable in this application. Zero-selection copy/delete
are no-ops and preserve the clipboard. Sparse clipboard, reverse, timing and bake
commands receive the exact sorted index set. Painting uses cached selection runs
and set membership, so gaps remain visibly unselected. A playback range requires
one continuous selection.

## Timing and baking

The Timing dialog synchronizes exposure frames with inbetweens, handles mixed
values, and applies the chosen duration to the selected keys in one history
command. Duration zero hides a key. The model retains Pivot's terminal-frame rule.
Blank insertion preserves the current camera/background. Duplication preserves
the frame clipboard.

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
sparse selection/clipboard/reverse/baking, zero-selection behavior, hidden-key
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
