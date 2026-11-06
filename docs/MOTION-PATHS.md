# Motion paths

The path button (M) toggles trails. Its inset chevron opens display settings; Down Arrow on the path button opens them from the keyboard. Escape closes settings and returns focus. Settings stay open while editing and dismiss on an outside click. Display options persist; paths start hidden each session.

## Settings

- **Figures**: Selected (every selected figure) or All (every figure on the stage).
- **Joints**: Selected shows the primary figure's selected joint and the origin of every other figure. Hands & feet shows each figure's origin plus every *tip joint* — a segment end no other segment hangs from (hands, feet and head on a stick figure). No anatomical labels are assumed. The primary figure's selected joint always leads its group.
- **Frame range**: a ±12/24/48 frame window or Full. With a window selected, enter a custom radius up to 4,000 frames. Windows follow the playhead.
- **Frame numbers**, **In-between dots**: independent display options. In Hands & feet, frame numbers appear only on each figure's first trail; tip trails keep their key diamonds, and a hovered tip still shows its number.
- **Speed colours**: each segment is coloured by screen distance per frame against the trail's 90th-percentile speed, from cool (slow, holds) to warm (fast). The legend beside the switch uses the same palette (`MOTION_PATH_SPEED_COLORS`).
- **Relative to body**: every sample carries its component root's origin at that time (`rx`, `ry`). The trail is drawn shifted by *root at the playhead − root at the sample*, so a travelling character's limb arcs stay in place. A figure's own origin (and the camera) has no reference and is always drawn in world space.

The selected camera uses the same trail controls. Each figure keeps one colour for all of its trails; the primary selection takes the accent colour and a slightly heavier line.

## Reading and editing trails

Trails show a quieter past and stronger future, hollow key diamonds, a ring at the current frame, and a filled marker at the hovered or dragged frame. Screen-space spacing suppresses crowded markers; frame badges avoid one another and are capped at 48 per trail. Hovered/dragged frame numbers remain visible even when persistent numbers are off. Missing sampled poses split the line; samples that are still pending do not. Visual simplification never changes stored timing or keyframes.

Pointing at a trail point at another frame draws that frame's pose as a dashed outline (the *ghost*) of the target's joined component, and the canvas tooltip explains the gestures. Drag a trail point to edit its pose without seeking; the ghost follows the live edit. The grab offset is preserved; Shift constrains movement to the dominant axis, Ctrl/Command retains the editor's stretch behavior, and Escape cancels. A completed gesture creates one undo entry. Overlapping samples resolve toward the playhead. Relative display does not change editing: a drag moves the world position by the pointer's delta.

Double-clicking a trail point (two presses without movement within 450 ms) goes to its frame. In the Simple timeline, a point at a frame's start selects that frame.

For a figure origin with pinned IK, **Shift-drag** carries the pins with the
figure, preserving its pose and leaving pinning enabled. **Ctrl/Command** locks
that origin's movement to an axis and combines with Shift. Pressing or releasing
Shift during the drag updates the preview immediately from the original pose.
The same rule applies when reshaping nearby keys with motion-path falloff.
Other trail points retain Shift's axis constraint and Ctrl/Command's stretch
behavior. An attached figure's origin trail still edits its parent joint.

## Reshaping arcs with falloff

**Right-drag** a trail point to reshape the arc around it. Left-drag edits just the grabbed frame; falloff has no keyboard shortcuts. The grabbed frame lands exactly under the pointer; the target's existing keys within **±N frames** move by their falloff weight; in-betweens stay ordinary tweens. Settings › Motion paths › *Reshape arc* holds the influence (1–240 frames, default 8) and its shape: Smooth (cosine), Linear, Sharp (cubic) or Flat. Weights are 1 at the grab, positive inside the influence and 0 beyond it (`motion-path-falloff.mjs`).

The edit adds only the keys it needs:

- the grabbed frame becomes a key if it is not one (a native tween splits there);
- existing keys inside the influence are rewritten in place;
- an **edge key** holding the original pose is added one frame beyond the influence on a side only when a key lies further out, no key sits exactly there, and the outermost moved pose on that side has weight ≥ 0.1. This keeps a substantial change from leaking through a long tween; a negligible one does not justify a key.

Layer-timeline holds resolve each write onto its hold's key: the grab claims its hold first, stronger weights claim before weaker ones, a key already claimed is not written twice, and edges never rewrite a hold (a hold cannot leak). Camera trails reshape the same way.

While the right button is down on a trail, the overlay previews the plan: orange rings sized by each frame's weight, filled diamonds on keys a release will change, squares where edge keys will be added, and the radius on the point's badge. During the drag, **scroll** resizes the influence live without zooming (`editor.setMotionPathFalloff` rebuilds the session and replays the pointer). Escape cancels. A completed reshape is **one undo step** in every timeline mode: a single `ranges` command for native keyframes, one animation draft for channels, and one layer-sheet publish. A stationary right-click on a trail makes no edit and does not open figure actions or seek; right-click elsewhere retains the usual context menu.

Each written frame is posed with the single-frame rules (`applyPathPoint`): origins translate, joints rotate toward their weighted point, IK controllers solve, and joined origins edit their parent joint. The virtual report previews every frame and the playhead while dragging; the stored document changes only on release.

## Ownership and limits

- `motion-path-controls.mjs` writes normalized editor preferences (`motionPathAllTargets`, `motionPathJoints`, `motionPathRange`, `motionPathLabels`, `motionPathDots`, `motionPathSpeed`, `motionPathRelative`, `motionPathFalloffRadius`, `motionPathFalloffShape`); `styles/features/view-options.css` owns its presentation.
- `motion-path-falloff.mjs` owns the falloff weights the interface draws (the planning of an edit is the session's `motion_path.rs`); `editor-animation.mjs` holds what the interface reads of the open gesture (`motionPathFalloff`, and the open gesture's report).
- The engine's session samples the trails and the ghost (`styk-edit/src/trails.rs`, read through `Session::query` kinds `trails` and `ghost`): the tick plan, the target's keys, the revision-aware sample cache and the geometry of the joined components. `motion-path.mjs` owns choosing targets, holding what the engine sent (`MotionTrails`), screen projection, hit testing and screen-space layout. The session's `motion_path.rs` owns editable pose semantics and history. `app.mjs` decides which trails are active and draws them in the overlay.
- Only overlay rendering advances sampling and asks for ghosts. Pointer hover and pointer-down read the trails the last read left (`MotionTrails.peek`) and their cached screen projections; they never ask the engine and never evaluate animation. A trail is sent only when it changed since the reader's last read (each carries a version).
- All active trails sample together in one read: every trail needing a display tick is resolved from one evaluation of that tick, and geometry is built only for the join/IK components that hold the targets. A trail sample therefore costs its own character, not the whole scene, and 48 limb-tip trails cost about the same as their figures' origins.
- Up to 48 targets share a 6 ms cooperative sampling deadline per read (the host's clock; at least one sample is taken) and a 6,400-point allowance, with at most 1,600 samples per target. The leading trail rotates so trails with distinct plans all refine. Dense plans preserve endpoints and the current tick, prioritize authored times, and subsample the remainder. Short windows include every tick. A single evaluation cannot be preempted by this deadline.
- Range shifts reuse overlapping points and discard points outside the new plan. While a trail point is dragged the trails are sampled from the document as the edit shows it; the ticks the edit changes are queued first, once per pointer move, and later reads finish the queue. Cancelling or committing queues those ticks again from the document, even under a one-sample budget. A document that changed keeps its old points on show while it is sampled again.
- Projection: the view × camera transform is affine, so `affineProjection` recovers its matrix from three probes. `projectMotionPath` caches each entry's screen positions until its samples, the matrix or the relative anchor change; drawing and hit tests share them, and speed buckets are computed once per projection.
- The engine retains at most 64 trails and one ghost; the interface holds the trails of the last read. Disabling paths releases the interface's. Markers outside the viewport (plus a margin) are not laid out. Where the engine does not hold the document (a movieclip edited in place) there are no trails.

## Verification

Run from the repository root:

- `cargo test -p styk-edit --lib views_tests` (the tick plan, sampling, budgets, versions, body references and ghosts)
- `node --import ./tests/support/register-engine.mjs --test tests/motion-trails.test.mjs tests/motion-path.test.mjs tests/motion-path-falloff.test.mjs`
- `node tests/motion-path.browser.mjs` against the local app at port 47831 (`STYK_URL` overrides it).

Unit tests cover tip targeting, batched sampling agreeing with per-target sampling and the frame's own geometry, body references, relative projection and its hit testing, ghosts of joined components that exclude unrelated figures, trails that follow a drag and are the commit's trail, and speed colouring. Falloff tests run the same reshape against native keyframes, animation channels and the layer timeline (live preview, one undo step, redo, save, untouched frames outside the influence, exact in-between grabs, cancellation), plus layer holds, switching falloff on, off and resizing mid-drag, camera trails and joint rotation. Browser checks also cover the falloff settings, right-drag message and tooltip, scroll resizing without zooming, removal of the former shortcuts, context-menu suppression, cancellation, stationary right-clicks and undo. Browser checks cover scope, joints, range, speed and relative persistence, numeric input, keyboard opening and dismissal, synchronized toggles, remote dragging with grab offset and Shift, the hover tooltip, the drag ghost, Escape cancellation, double-click to go to a frame, and undo. Screenshots in `artifacts/motion-path-ux/` cover light, dark and compact layouts, limb tips with speed and relative display, and the drag ghost.
