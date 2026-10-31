# Scene background editing

## Bending in Build

Right-drag a line joint with Build's joint or creation tools to bend it, including static
joints. The tangent, Ctrl/Command stretching, snapping and Isolate behavior
match Animate. A stationary right-click still opens the context menu; dragging never opens it,
including on platforms that send the menu event on mouse-down.

The preview changes only the current pose; release publishes one reusable rig
edit across the definition's instances and stored poses, applying the bend delta
and stretch ratio to their existing poses. Undo and Escape use the existing rig transaction. Attached
figures retain their own poses, as with Build's branch rotation. Animate bending
continues to edit only the current pose and respects static-joint protection.

## Importing builder edits as a new figure

Build figure → Done → Import as new figure captures the bound instance's displayed
pose, style overrides and edited definition through the native figure format used
by the library. The capture owns its data before session undo restores the original
definition and instances. Import creates a separate definition and instance as one
undoable command. Deleting parts must not reset surviving angles, lengths, bends,
scale or paint to definition defaults. Regression coverage is in
`tests/builder-session.test.mjs` and `tests/builder-import-new.desktop.mjs`.

## Canvas navigation

In Animate, clicking visible artwork selects that figure's origin after visible
and hidden static handle picking have missed. This includes joined figures whose
origins are not exposed as handles, so Unjoin is available immediately. Dragging
artwork keeps that selection without moving the figure or adding history; use
the free origin handle to translate a figure.

With joints shown, movable line segments also accept a press along their visible
stroke, including curves, with eight screen pixels of extra tolerance. The hit
selects and poses that segment's endpoint, preserving the grab offset. Visible
handles retain priority, static parts stay fixed, and artwork in front prevents
picking a segment on a figure behind it. Segment right-drags bend as usual.
Artwork picking skips hidden/locked figures and transparent pixels; it runs only on a
click, using a three-pixel scratch surface and the existing geometry painter.
Build tools and explicit handle-target modes retain their handle-only behavior.

Settings → Canvas → Pasted figure depth defaults to **Same Z-index**. **In front**
places pasted figures in front of the destination layer's existing figures,
retaining their relative painter order and internal joins. The preference applies
to ordinary, in-place, instance and unique pastes, including Edit together ranges.
It does not change the definition-sharing choice or add another undo step.

Ctrl+V pastes copied figures with the existing offset. Ctrl+Shift+V (**Paste in
place**) preserves their copied canvas positions without advancing the offset
for subsequent normal pastes. On macOS, use Command instead of Ctrl. Both commands
are available in the Edit and canvas context menus and can be remapped in
Settings → Shortcuts. With timeline focus, both paste frames at the playhead.

Settings → Canvas → Zoom gesture saves a choice of **Ctrl + scroll to zoom**
(the default) or **Scroll to zoom**. In the default mode, plain scrolling pans
and Shift + scroll pans horizontally. Ctrl or Command + scroll zooms around the
pointer in either mode. Middle-button drag and Space + drag remain available
for panning. This preference changes the workspace view, not the document.

Settings → Canvas → Smooth zooming chooses how a mouse-wheel notch moves the
view. **Automatic** (the default) glides between zoom levels with WebGPU and
zooms each notch at once on slower graphics (the engine's WebGL2 backend),
where every extra frame of a glide is a costly repaint of the scene. **On** and **Off** apply everywhere.
A notch zooms about 1.35x either way; only the motion differs. Trackpad and
touch pinches stay continuous, and reduced-motion system settings always zoom
directly (`src/canvas-wheel-zoom.mjs`).

Every color picker ends with the palette (`src/color-palette.mjs`), under a hairline: a Project | Recent | Mine ▾ switch, + and one grid of swatches, ten a row. Project colors belong to the document (`_styk.palette`, up to 64 unique `#rrggbb` values in order) and change only through `addPaletteColor`, `removePaletteColor` and `movePaletteColor` (engine session commands, `styk-edit/src/palette.rs`): each is one undo step that touches no frame or figure, and its `palette` event keeps playback's prepared frames. Recent colors are the app's last twelve colors painted in Draw or chosen in a picker (the color it closes on, when it changed), kept in local storage with the chosen view. Personal palettes are named palettes kept in local storage beside the recent colors (up to 32, of up to 64 colors each), offered in every project and never saved in one. Mine ▾ replaces the grid with them, in the order made, each with its first five colors, then New palette…, Save project colors as a palette… and, for the palette shown, Add “name” to this project (`addPaletteColors`, one undo step), Rename… and Delete…; naming and the delete confirmation happen in place, and Escape returns to the grid. Personal palette edits are not undoable, like brush presets. Until someone chooses a view it follows the project: Recent while the project has no colors, then Project. + saves the color being edited to the palette shown (`saveTarget`): the project in the Project view, the personal palette in Mine, nothing in a chosen Recent view and, until a view is chosen, the project while it has none, so the first color saved switches to Project. Clicking a swatch applies it to the solid color or selected gradient stop, keeping opacity. Project and personal swatches drag to reorder and remove with right-click or Delete; arrow keys, Home and End move between swatches, and the current color holds the one tab stop. Draw's color rail (`docs/DRAWING.md`) shows the same palette; the rail exists only in Draw.

The color picker opens with canvas sampling off, so clicking outside the panel dismisses it. Click the Eyedropper button to enable sampling and its canvas cursor; click it again to turn sampling off. A floating loupe enlarges an 11×11 pixel neighborhood, marks the center pixel and shows its HEX color. Click to copy the rendered RGB color into the solid color or selected gradient stop, preserving opacity. Sampling keeps the picker and canvas selection open; Escape or clicking another control closes the picker. The normal paint command supplies undo. Pixels are read immediately after a requested render, with GPU handles omitted for that sample, so idle WebGPU canvases and scaled preview buffers are supported. Hover requests are coalesced to at most 30 per second with one readback in flight, stop when the pointer is idle, and cancel on leaving the canvas or closing the picker. The loupe never intercepts canvas input or enters the sampled artwork.

These are commands of the engine session (`styk-edit/src/property_edit.rs` for the colors and backgrounds, `scene_backgrounds.rs` for importing and renaming one; layer-sheet documents, which the app always opens) that `Editor` forwards to:

| API | Behavior |
| --- | --- |
| `setSceneColor(argb, {indices})` | Set a 32-bit ARGB color absolutely at selected native frames or authored Scene keys. Numeric zero is transparent. |
| `setSceneBackground(id, {indices})` | Select an existing background; zero selects the default white background. Clear any active color override at the edited point. |
| `importSceneBackground(background, {indices})` | Import a decoded image, solid color or gradient, assign a fresh native ID, select it, and return the inserted asset. Import and selection form one undo command. |
| `renameSceneBackground(id, name)` | Change only a background's name. The image/gradient asset retains its identity and media bytes. |
| `sceneValuesAt(editor, index, tick)` | Sample only Scene fields, without composing or copying figure poses. |

Indices default to the current stored frame. Native changes snap to that frame's
start. A single authored edit uses the displayed tick; authored range changes use
the selected native frame start ticks. Hidden or locked Scene tracks reject edits
before changing the document.

Ordinary editing does not create scalar animation channels. Existing Scene color
or background channels receive keys on those channels. If a Scene pose track is
present instead, the command records a minimal Scene-only source and a pose key,
preserving unrelated animation tracks. Selecting a background writes a `null`
key to an existing color channel: null returns control to the background, whereas
ARGB zero remains a transparent color. Composition applies the background channel
before the color channel, independently of channel creation order.

Native undo snapshots contain only changed Scene fields and newly imported table
entries. Renaming snapshots only the previous and next names. They do not copy
existing figure arrays or unrelated images. Authored snapshots contain only
changed channels and small source frames; the standard source-history lifecycle
keeps required sources available through undo/redo and prunes unused captures.

The recorded edit tapes (`engine/tests/edit/*scene*.scenario.json`) and the session tests (`cargo test -p styk-edit`) state sparse ranges, authored inbetween edits, null/transparent colors, atomic image import, name-only history, invalid/locked/hidden edits and history sizes: a 2 MB unrelated image does not appear in color history, and renaming a 1 MB image stays small.

Rendering uses the shared Scene override on the engine's stage, playback and
SVG. A browser check of the background previously passed 35 checks with all four
paths, transparent/translucent colors, Scene/Camera visibility and retained-cache
changes. The pixel report is in
[`artifacts/scene-background/report.json`](../artifacts/scene-background/report.json).
These checks cover the engine and rendering contracts; they do not claim the
separate background library dialog's UI workflow is complete.

### Pen and tablet input

`src/pen-input.mjs` holds the shared tablet rules:

- Pen and touch drags start only after the press leaves a small slop (5 px for a
  pen, 10 px for touch), so a tap selects a joint or figure without nudging it or
  adding an undo step. Mouse drags keep pixel precision. Property scrub labels
  use the same slop, so a pen tap focuses the field.
- Windows turns a stationary pen press into a right click. The editor ignores
  that synthesized menu, as Krita and Photoshop do; the barrel button (a real
  right press) still opens menus and bends joints. Keyboard menus are unaffected.
- Wheel-free navigation: Space+drag pans, Ctrl+Space+drag zooms around the press
  (right or up zooms in), and Shift+Space+drag rotates the Draw view, settling on
  upright within 3°. Releasing Space after these gestures never starts playback.
- Touch: a second finger on the canvas zooms and pans it (`src/canvas-pinch.mjs`).
  The artwork under the fingers' midpoint follows them and the zoom changes by the
  change in their distance, with the wheel's limits. Whatever the first finger was
  doing is cancelled as with Escape (a joint drag is undone, nothing reaches the
  undo history), and the finger still down is ignored until it lifts, so ending a
  pinch never selects or moves anything. Draw mode keeps its own two-finger
  gesture, which also zooms and pans.

`tests/canvas-pinch.test.mjs` covers the view maths and the finger hand-over;
`tests/canvas-pinch.browser.mjs` (`npm run test:pinch`) drives real two-finger touch
through Chromium, including a second finger landing in the middle of a drag.
`tests/pen-input.browser.mjs` drives real pen pointer events through the
DevTools protocol. Press-and-hold is simulated with a pen `contextmenu` event;
the Windows gesture itself needs a physical tablet to verify.

## Figure selection and frame corrections

Hold **Alt** and drag a figure's root handle in Animate to duplicate and move
it. Settings → Canvas → **Alt-drag a figure root** chooses **Linked instance**
(the default, sharing figure edits made in Build) or **Independent copy**
(a separate figure definition). Both copies have their own pose and position.
The gesture duplicates the selected figures and their connected attachments,
preserving joins within the copies and leaving the originals in place. It edits
the current pose only, even with Edit selected frames enabled. Alt-dragging a
non-root joint retains the existing figure rotation/scale gesture; Build keeps
its existing handle editing behavior.

An Alt-click only selects; duplication starts after 3 px of mouse movement or
the existing pen/touch slop. Releasing Alt during the drag keeps the same copy.
Insertion and movement share one undo step. Escape, pointer cancellation, lost
capture and window blur remove unfinished copies without clearing redo. The
editor reuses sparse paste commands and translation previews; no document-wide
gesture snapshot is added. Coverage: `tests/alt-drag-preference.test.mjs`, the
duplicate-drag edit tapes and `tests/alt-drag-duplicate.browser.mjs`.

Settings → Canvas → **Rectangle selects** switches between **Origins** (the
default) and **Bounds** (overlapping artwork). Origins tests each figure’s
evaluated root, including attachments, in the displayed canvas projection.
Coincident roots remain coincident selection targets. Hidden and locked figures
are excluded. The saved selection preference and **Edit selected frames** can
also be assigned shortcuts in Settings → Shortcuts.
Builder and Draw retain their own selection behavior.

Ctrl/Cmd-click on a figure handle toggles its membership; Shift-click still does
the same. Ctrl/Cmd-drag on empty canvas also toggles rectangle hits. A modified
handle press defers selection until release, so a stationary click never authors
a pose or changes undo history. Crossing the 3 px mouse slop (or the existing pen/
touch slop) starts the existing constrained move/stretch gesture. Escape, lost
capture, blur, document changes and seeking cancel pending clicks. Ctrl/Cmd
double-click toggles twice without invoking connected-group selection.

The timeline **Edit selected frames** button shares state.applyRange with the
Figure Properties checkbox. Its count includes the current playhead, matching
the existing range commands. It is off initially and resets when selection
collapses, the timeline mode changes, or a new document opens. Figure translation
applies a relative displacement to each selected pose through the existing
atomic range command; supported figure property actions retain their own range
semantics. This control does not extend joint posing or Alt-drag transforms to a
frame range.

Hit testing lives in canvas-interactions.mjs; selection membership stays in
editor-selection.mjs. Origin selection does not measure artwork, clone frames
or allocate a cache. Bounds selection preserves the four projected-corner test
without temporary arrays. Pending modified clicks reuse the existing pointer
gesture owner. Pivot feedback draws a constant number of overlay primitives.

Regression coverage: tests/selection-workflow.browser.mjs,
tests/canvas-interactions.test.mjs, tests/hotkeys.test.mjs, and the existing
multi-figure, joining and tablet browser tests. Performance comparison:
node scripts/benchmark-selection-workflow.mjs <baseline-ref>.

## Joining and node selection

Joint Properties keeps Static in Transform and gives IK its own section. Enabling
IK reveals pinning, stretch, chain, rotation and bend direction controls nested
beneath its toggle. Appearance offers Secondary
color only for circle primitives (white, filled or clear), including selections
containing only circles; its color and opacity appear when enabled. Switching to
a non-circle hides those controls without discarding existing native color data.

See [figure joining and static-node selection](FIGURE-JOINING.md) for the shared
J/context-menu action, soft static selection, native evidence and verification.

Posing an attachment on an unlocked layer can evaluate its locked IK ancestors,
but must not bake their solved angles or update their bend references. Actual pose
changes crossing into a locked layer are rejected atomically. A rejected layer-sheet
commit clears its draft, leaving saving and navigation available; Escape also
cancels a model gesture left behind after pointer-up. Regression coverage is in
`tests/locked-layer-pose.test.mjs`.

## Figure colors

`src/figure-colors.mjs` reads displayed segment and fill colors and builds pure
recolor plans. the engine session publishes them through the existing figure
range commands (`editFigureColors`). The Properties palette counts a segment once for each color it
uses, including gradient stops; polygon uses are listed separately. Palette rows
are paged in groups of 32. Bitmap pixels and VFX colors are not palette entries.
Selecting a figure origin includes its attached descendants in the palette.
Replacement targets retain each instance UID and definition identity, so shared
handle IDs cannot recolor unrelated figures; nested attachments participate in
the same undo step. Selecting a node retains its owning figure's palette.

Figure color assigns one RGB to every segment stop and fill. Palette replacement
changes only the matching stops/fills. Node edits preserve the other displayed
colors. These commands retain opacity, paint layout, geometry, IDs and shared
definitions, and form one history step. Reset colors restores definition colors.
An open palette picker retains its original segment/stop membership after colors
merge. Opacity-only edits do not recolor the figure.

Pivot 2–4 absolute COLORREF values and negative black differ from Pivot 5's mix
byte. On the first local color edit, an active legacy/modern figure override is
baked into per-instance `_stykStyle` colors before clearing it. Legacy instances
carry `_styk.colorMode: 'segments'`; resolution exposes the existing definition
color-mode contract without mutating shared definitions. Full native overrides
suppress secondary alpha as well as RGB, so baking preserves the displayed solid.
Clipboard conversion preserves the instance mode, and native export materializes
style variants and converts untouched legacy COLORREF values to Pivot 5 too.

Layer-sheet edits use the existing held-key/interpolated-boundary policy and range
history. Legacy scalar timelines keep independent color/paint channels and native
Simple working-copy behavior. Tests are in `tests/figure-colors.test.mjs` and
`tests/figure-colors.browser.mjs`.

## Figure flips

Horizontal and vertical flip commands use the active selection in both current-pose
and timeline-range edits. A root selection flips the whole figure and its joined
descendants. A segment selection reflects only the selected segment angles and
bends around their parent joints; explicit branch selection includes descendants
and figures attached to that branch. Unselected segment poses stay unchanged,
and connected children follow their parent endpoints. Each command is one undo step.

## Alt-drag figure transforms

Alt-dragging a figure joint preserves an existing multiple-figure selection and
rotates/scales the group around the picked figure's origin. Other independent
origins orbit and scale toward that shared pivot. Joined descendants follow their
parent and transform once even if also selected. A selected attached figure wins
when its handle overlaps another figure's handle during Alt-drag; ordinary handle
picking retains its existing order. An amber pivot and guide line show the fixed
center during the gesture. Ctrl locks scale; Shift locks rotation. Release records
one undo step. The configured Cancel key also works while drag modifiers remain
held, without overriding a separately assigned modified shortcut.

## Figure Properties

Figure Properties places Color palette last in a collapsed disclosure. Compact
swatches retain bulk replacement and accessible segment/fill counts without helper
copy. Disclosure state survives ordinary edits. Layer parallax appears only in the
layer inspector, never in figure, joint or movieclip Properties.

## Motion paths

Hold **Shift** while dragging a figure origin to move the whole connected figure,
including its pinned IK nodes. Pins remain enabled at their new positions. The
modifier can change during a drag; the preview always uses the gesture's original
pin targets. Ctrl/Command still constrains the move to one axis, and Shift-click
still toggles selection without editing. Modified origin presses wait for the
existing mouse/pen/touch drag threshold before starting an edit. Joint gestures,
Build tools, Alt transforms and Space navigation keep their existing modifiers.
Edit selected frames carries each affected pose's pins by the same displacement.

`translateIKTargets` owns pin displacement for canvas, range and motion-path
edits. Only affected objects/controllers change, with existing history and cache
invalidation; no temporary unpinning or additional document snapshots are needed.
Coverage includes `tests/ik-shift-origin.browser.mjs` and the IK, joined IK,
spatial IK and motion-path unit suites.

See [Motion paths](MOTION-PATHS.md) for display settings, remote pose gestures, cache ownership, sampling limits, and verification.
