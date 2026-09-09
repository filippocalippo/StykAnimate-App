# StykAnimate-webapp: Pivot compatibility contract

This is the acceptance contract for the requested first slice, not a claim that
all these features exist in the new application. An unchecked item is **not
signed off in this document**; it does not by itself prove the feature is absent.
Check an item only with a named implementation, reproducible test, and result
artifact from StykAnimate-webapp. Reusing a decoder does not transfer the older
editor's rendering, interaction, or performance results to WebGPU.

**Verification updated 2026-09-09.** The application now has a working WebGPU
editor, real Pivot import/export, multiselection, a virtualized timeline, portable
text and image authoring, native project persistence, and a Windows desktop shell.
Checked boxes below sign off the **whole stated acceptance item**. Many unchecked
items contain verified, implemented behavior; their progress annotations identify
both that behavior and the remaining verification or feature gap. This document
does not assert complete 1:1 Pivot parity.

The [finite release gates](GOAL-ACCEPTANCE.md#current-finite-release-gates) identify
current blocking work. Broad unchecked combinations below are coverage limits,
not proof of missing features or an instruction to extend acceptance indefinitely.

The original [creation UI regression](../tests/creation.browser.mjs) records
[37 passing checks](../artifacts/creation-verification.json) on its source snapshot.
Current focused evidence additionally includes [20 native pointer checks](../artifacts/native-handle-pointer/report.json),
[7 modifier checks](../artifacts/native-modifier-pointer/report.json),
[15 keyboard checks](../artifacts/native-handle-keyboard/report.json),
[22 Advanced timeline workflows](../artifacts/advanced-track-app.json),
[14 inspector workflows](../artifacts/properties-app/report.json),
[13 camera workflows](../artifacts/camera-app/report.json),
[11 segment-value app checks](../artifacts/segment-values-app/report.json),
[16 native text app checks](../artifacts/text-app/report.json), and
[11 real desktop save workflows](../artifacts/desktop-app-save-smoke.json).
These reports exercise the running app; their exact fixture/source and platform
limits still apply. The previous broad creation script is not a substitute for a
final integrated rerun after all concurrent changes.

The [full-goal ledger](GOAL-ACCEPTANCE.md) distinguishes implemented earlier gaps
from remaining requirements. It records current source and retained evidence;
existing Windows 0.2.0 package artifacts predate several of these changes.
Neither this update nor a passing focused test asserts full Pivot parity.

Baseline: the supplied Pivot Animator **5.2.11**, dated 2025-02-11 in
[ReadMe.txt](../../Pivot%20Animator%20v5/ReadMe.txt). Its `pivot.exe` SHA-256 was
verified on 2026-09-08:
`2c7911d3303cc28de2ac016c3f7575082aa47680e63a0fe8930ce8799de3df98`.
The [official Pivot 5.2 manual](https://pivotanimator.net/help5-2/index.htm)
and the feature pages linked below were inspected on the same date. The earlier
[StykAnimate contract](../../StykAnimate/docs/PIVOT_PARITY.md) supplied additional
edge cases; its Windows-native architecture is not the architecture requested here.

## Preserve the animation philosophy

Pivot's central operation is direct posing: drag an origin to move a figure,
drag a joint to rotate a branch while retaining its proportions, then store a
pose in the timeline. A figure **definition** holds reusable topology and visual
assets. An **instance** has an identity, a pose, appearance, and ordering within
a frame. An animation connects poses across frames using identities and timing.
These distinctions must survive the modern interface.
[Positioning figures](https://pivotanimator.net/help5-2/positioning_figures.htm),
[figure controls](https://pivotanimator.net/help5-2/figure_controls.htm).

The requested Figma-inspired interface should make the canvas primary, with a
compact tool strip, searchable figures/layers, a contextual properties panel,
consistent selection colors, restrained neutral surfaces, and discoverable
shortcuts. The Adobe Animate-inspired timeline should expose time, keys, holds,
and tracks without forcing users to understand the decoder. Changing the layout
is compatible with behavioral parity. Additional undo coverage is an improvement;
silently simplifying imported animation is not.

## Files, assets, and interchange

- [x] F01 Open all 37 original PIV fixtures: 4 V2, 1 V3, 9 V4, and 23 V5. Keep
  the two Broly projects distinct; their equal payload lengths do not imply identity.
  **Verified:** [renderer-corpus.mjs](../tests/renderer-corpus.mjs),
  [37-file result](../artifacts/renderer-corpus-prepared/results.json) and
  [summary](../artifacts/renderer-corpus-prepared/summary.json): no failed imports,
  missing assets, browser exceptions or GPU errors. Both Broly paths are separate.
- [ ] F02 Import STK definitions, including legacy vector figures, polygons,
  sprites, and text. Add editable instances and retain shared definition identity.
  **Progress:** real STK UI import and authored image/text STK round trips pass in
  the creation, [media](../artifacts/media-authoring.json), and text reports.
  The [builder UI](../artifacts/builder-verification.json) creates a joint-bound
  polygon, exports STK and reimports its geometry/fill/alpha; the rig report also
  preserves authored static flags and construction geometry. Creation tests retain
  one shared definition when group instances are pasted. The complete legacy
  format and shared-definition import matrix remains open.
- [ ] F03 New/open/save/save-as, dirty state, cancellation, recoverable errors,
  drag/drop PIV and multiple STK files, and recent files. Failed import must
  preserve the currently open document.
  **Progress:** [Eleven actual desktop save workflows](../artifacts/desktop-app-save-smoke.json)
  verify Ctrl+S same-path save, distinct Save As, document destination scoping,
  imported PIV source preservation, cancellation and edits arriving during save.
  Corrupt import preserves the current document in earlier app checks. Multiple-file
  drag/drop and the full import cancellation matrix remain open. Recent Files
  now has 14 native service tests and [desktop restart/Open/Clear proof](../artifacts/simple-native-smoke.json):
  20 canonical paths behind opaque IDs, visible missing files and no document deletion.
- [ ] F04 Preserve original source bytes/fingerprint, unknown fields, embedded
  assets, and source association required by the existing writers. Reject stale
  source/document pairs and unsupported data instead of silently dropping data.
  **Progress:** source bytes/SHA-256 survive native save and recovery in the
  authoring report and [worker report](../artifacts/import-worker-browser.json).
  [Document export/restart tests](../artifacts/document-export-browser.json)
  preserve unknown metadata and fractional edits, reject expired source references,
  and cancel exports if their revision changes. The complete mismatched
  source/document and unsupported-data rejection matrix remains open.
- [ ] F05 Export edited PIV copies; reopen them in the decoder and original
  Pivot. Route unsupported legacy structural edits through explicit V5 migration.
  **Progress:** edited PIVs, including source-bearing projects with newly authored
  text, reopen in the supplied decoder. Original Pivot reopen and the complete
  user-facing migration workflow are not signed off.
- [ ] F06 Save/reopen native StykAnimate projects with timing, assets, editing
  metadata, organization, and constraints when present; do not depend on cache URLs.
  **Progress:** The [22 Advanced app checks](../artifacts/advanced-track-app.json) retain
  sparse layer/Camera/Scene channels, independent poses and blank keys through
  STYK reopen; PNG comparisons are exact for the tested scenes. Native text app
  checks retain editable original-font metadata and embedded outlines. Full
  organization/constraint and large cross-feature matrices remain unsigned.
- [ ] F07 Save an editable figure as STK. Older-version exports must identify
  unrepresentable features and offer an explicit conversion or reject the export.
  **Progress:** image/text STK exports contain their actual embedded media/glyphs
  and decode correctly. Builder and rig UI reports also verify authored polygons,
  style/alpha, default lengths/angles and static flags through the actual STK
  download/import controls. Older-version conversion/rejection coverage remains open.
- [ ] F08 Figure library thumbnails, search, add, rename, unique names, and
  stable instance identities when duplicating or pasting figures.
  **Progress:** [asset-library.browser.mjs](../tests/asset-library.browser.mjs) and
  its [19-check report](../artifacts/asset-library-verification.json) verify actual
  vector/image/text/polygon previews, name search/clear/empty states, click and
  keyboard insertion, and virtualized navigation through 20,000 definitions.
  The [real Akane library](../artifacts/asset-library-akane-verification.json)
  exposes all 881 native definitions with bounded visible rows. Creation tests
  verify stable remapped identities and shared definitions on paste. Editable
  names are exposed, but rename/unique-name acceptance is not fully recorded.
- [ ] F09 Keep figure type IDs, frame slots, object UIDs, segment record order,
  and handle IDs separate. Sparse IDs must never be treated as array indices.
  **Progress:** import and clipboard remapping work in actual UI tests; the full
  sparse-ID/record-order acceptance matrix is not yet recorded for this app.

References: [corpus](../../docs/CORPUS.md),
[document/API contract](../../docs/PIV_DOCUMENT_MODEL.md),
[full writer](../../docs/PIV_FULL_WRITER.md),
[migration](../../docs/PIV_MIGRATION.md),
[figure controls](https://pivotanimator.net/help5-2/figure_controls.htm).

## Posing, selection, and attachments

- [ ] P01 Origin translation, axis-constrained movement, branch rotation,
  whole-figure rotation/scaling, independent rotate/scale tools, and default-pose reset.
  **Progress:** [Native pointer](../artifacts/native-handle-pointer/report.json) and
  [modifier](../artifacts/native-modifier-pointer/report.json) checks now cover
  Alt combined/independent rotate-scale gestures, live Ctrl/Shift changes and
  initial-axis locking. Numeric transforms and undo also have actual-app evidence.
  Full default-pose reset and selected-parent/child transform coverage remains open.
- [ ] P02 Stretch and bend segments, default-value snapping, joint edit mode,
  isolated rotation, and exact numeric position/angle/length/bend/scale input.
  **Progress:** Pose-local Handle Edit is distinct from shared-definition Rig editing.
  [Pointer checks](../artifacts/native-handle-pointer/report.json) cover held R,
  Ctrl+R, fixed other endpoints, right-drag bend, Alt transforms and cancellation.
  [Segment values](../artifacts/segment-values-app/report.json) add live exact
  angle/bend/length, relative input, clipboard and one undo. Default snapping
  and every isolated/static/bend mode combination remain unsigned.
- [ ] P03 Static segments follow parents and retain valid endpoints for joins
  and polygons. Animation isolation includes contiguous static descendants;
  builder isolation rotates only the selected segment.
  **Progress:** the rig UI regression moves a static construction joint while
  preserving all other endpoints, rotates a static branch with its descendants,
  retains descendant lengths/angles when stretching, and preserves the result in
  PIV/STK. The distinct animation-versus-builder isolation rules and every
  static join/polygon combination are not wholly signed off by this UI report.
- [ ] P04 Fine arrow-key adjustments, axis alignment, alignment to neighboring
  poses, and predictable shortcut behavior while numeric/text inputs have focus.
  **Progress:** [Fifteen actual keyboard checks](../artifacts/native-handle-keyboard/report.json)
  verify one-CSS-pixel nudge through a rotated camera, repeat grouping into one undo,
  cardinal/diagonal alignment, R fixed-point alignment, hover Locate, physical
  Caps Lock isolation, figure cycling and input focus. Model tests also cover
  native sparse handle IDs and hidden neighboring keys. Broader missing-identity
  and mixed-selection combinations remain unsigned.
- [ ] P05 Shape and handle picking, overlapping figures, zero-width helpers,
  off-canvas figures, and consistent screen-space hit areas at every zoom.
  **Progress:** Drawing and picking share cached native handle descriptors. The
  [pointer report](../artifacts/native-handle-pointer/report.json) verifies native
  orange/red/white/blue/light-blue colors, light-gray joined markers and actual
  Akane attachment-node routing; joined child origins are hidden. Native square
  picking, draw order and adaptive sizing have focused module coverage. Complete
  overlapping/zero-width/off-canvas cases at arbitrary zoom remain unsigned.
- [ ] P06 Single/toggle/marquee/inverted-marquee/all/same-definition selection,
  joined-group selection, multi-figure transforms, and a stable active figure.
  **Progress:** single/Shift-toggle/marquee/all, active UID, group dragging and
  internal-join clipboard remapping pass the creation regression. The canvas
  regression additionally verifies same-definition and inverted selection through
  visible context-menu commands. Inverted marquee, every joined-group selection
  route and the complete transform matrix remain open.
- [ ] P07 Add/delete/duplicate/copy/paste, centering, horizontal/vertical mirror,
  RGB override/reset, opacity, and per-frame raise/lower one step or fully.
  **Progress:** Current and selected-frame commands now cover appearance, order,
  duplicates, join/detach, mirror and transforms; see [Figure ranges](FIGURE-RANGES.md).
  [19 actual range checks](../artifacts/range-actions-app.json) verify noncontiguous
  selected frames, one undo, untouched gaps and worker geometry. The complete
  native/authored media, centering and appearance matrix remains unsigned.
- [ ] P08 Join an origin to any valid handle, including static handles; allow
  chains, trees, and several children on one handle. Reject cycles and invalid targets.
- [ ] P09 Rotate/bend joined branches exactly once; reposition attached origins
  without adding parent angles again during unchanged frame evaluation.
  **Progress:** The [actual Akane pointer regression](../artifacts/native-handle-pointer/report.json)
  picks parent 460616/native handle 1 from a selected attached figure and changes
  only the nine-figure branch, keeping free origins fixed. Independently timed
  layer composition has joined-ancestor/detachment regressions in
  [animation-pose-review.test.mjs](../tests/animation-pose-review.test.mjs).
  All join transitions, bent media and all-frame native render parity remain open.
- [ ] P10 Distinguish joined-subtree scale gestures from numeric selected-figure
  scaling. A selected parent and child must never receive the same transform twice.
  **Progress:** Alt gestures now act on the selected joined subtree and numeric range
  scale preserves selected proportions; external parents remain fixed. Native
  pointer/modifier and range command tests cover focused cases. The complete
  selected-parent-plus-child UI/interchange matrix remains unsigned.
- [ ] P11 Unjoin without a visual jump; support joint edit mode during joining;
  combine joined figures into one editable definition with appearance/order intact.
- [ ] P12 One undo transaction per completed drag or numeric edit; undo/redo
  structural and multi-frame operations without losing media or source identity.
  **Progress:** Actual pointer, keyboard, property, segment-value, camera, text and
  Advanced timeline workflows record one undo per completed gesture and exact
  cancellation. Range/model tests add sparse multi-key edits and structural
  assets. Complete topology/multi-frame/media/source combinations remain open.
References: [posing](https://pivotanimator.net/help5-2/positioning_figures.htm),
[joining](https://pivotanimator.net/help5-2/joining_figures.htm),
[local native join/static rules](../../docs/PIV_JOIN_EDITING.md),
[style findings](../../docs/PIV_STYLE_FINDINGS.md).

## Timeline, interpolation, and playback

- [ ] T01 Add/update/insert/remove frames with an explicit, safe policy for the
  current edited pose. Changing frames must not accidentally discard edits.
  **Progress:** Native frame edits survive insertion, undo, playback and native reopen
  in the creation regression. [Eleven actual desktop checks](../artifacts/simple-native-smoke.json)
  now prove Simple Add preserving the stored pose, Update, re-click Cancel/Discard,
  navigation, undo, exact stored thumbnails, stored playback/Stop restoration,
  held-gesture Save and saved working-pose restart. The Simple journal has 30
  focused model checks; final cross-feature mode and package acceptance remain G14.
- [ ] T02 Frame range/toggle selection, copy/paste/insert, reverse, and undo.
  Multi-frame figure operations match UIDs; translation applies relative offsets.
  **Progress:** Sparse range/toggle selection, reverse, copy/insert/delete and undo
  are covered by timeline checks. [Cross-document clipboard smoke](../artifacts/desktop-frame-clipboard-smoke.json)
  verifies real text, legacy sprites and blended backgrounds, native PIV/STYK
  interchange and persistence across desktop processes. Authored source/destination
  remapping and [actual range controls](../artifacts/range-actions-app.json) are
  verified. [19 actual application upgrade checks](../artifacts/clipboard-legacy-app/report.json)
  now prove Pivot 5 paste into real V2/V3/V4 destinations, exact Undo/Redo and
  native PIV/STYK Save/reopen. Conversion retains legacy holds, source bytes and
  Simple working copies; Advanced selects only pasted keys. Dedicated cancellable worker planning and cooperative staging now replace UI
  synchronous planning. The [compact sparse CPU diagnostic](../artifacts/clipboard-akane-flat-sparse-cpu.json)
  passes 1/64/all-key existing and empty destinations, exact fields, Undo/Redo and
  subsequent edits; no existing destination poses cross the worker boundary.
  All-key Paste still takes 14.18/14.81 seconds, so staging optimization and the
  final actual UI rerun remain active. The earlier UI cap failure is historical.
- [ ] T03 Correct modern inbetween counts, hidden keys, legacy repeats and
  millisecond timing, project FPS, and final-frame output count.
  **Progress:** modern timing fields, duration presets, mixed selection values,
  hidden-key restoration, baking with hidden keys, and the final output count
  are exercised by the timeline regression. Consecutive hidden keys sharing an
  output tick are individually reachable through stored-key navigation. The full
  legacy-repeat/millisecond fixture matrix remains unsigned.
- [ ] T04 Interpolate pose, length, bend, color, opacity, camera, and background;
  handle figure births/deaths and changes in join relationships.
- [ ] T05 Auto-easing on/off, neighboring-pose influence, angular wrapping, and
  exact output-tick to keyframe/fraction mapping. Do not replace native easing
  with an arbitrary CSS easing curve.
- [ ] T06 Insert a baked inbetween at a chosen ratio and retain surrounding
  timing/media. Reject unrepresentable background transitions explicitly.
  **Progress:** [5 root-app](../artifacts/insert-inbetween-app.json),
  [14 dialog](../artifacts/insert-inbetween-dialog.json) and 14 model/codec checks
  prove selected native ranges, forced-linear ratio previews, exposure inheritance,
  cancel/undo and PIV/STYK reopen. [The contract](INSERT-INBETWEEN.md) records
  unsupported blends and bounded large ranges. Cancellable worker planning now
  has seven async-model and 15 transport checks. The [actual Akane run](../artifacts/akane-inbetween-async-app/report.json)
  inserts 20 keys with exact pose/order/joins/media/camera, one Undo/Redo and
  cancellation: 8.39 seconds background, 16.3 ms commit and zero long tasks.
  Its 104.2 ms maximum rAF gap remains an explicit performance observation.
- [ ] T07 Play/stop/loop/preview/scrub, previous/next key and output tick,
  visible time, and elapsed-time-based playback without cumulative timer drift.
  **Progress:** Stored/output-key navigation, Ctrl+Play current-frame camera preview,
  click-to-exit preview and active playback/scrubbing have actual app evidence.
  The earlier [full Akane run](../artifacts/edit-freeze-16-akane-vs-akato-segundo-round--3--full-playback-budgeted/presentation-summary.json)
  submits all 1,872 ticks in 117.264 seconds with bounded 128 MiB prepared caches,
  p99 submission interval 70 ms and an isolated 363.1 ms maximum. A later
  [pooled tail run](../artifacts/renderer-live-tail-desktop-pool-pruned/report.json)
  covers ticks 1824–1871 with p95 69.9 ms/max 73.8 ms. The still later
  [editor-adoption run](../artifacts/renderer-live-tail-desktop-editor-adoption/report.json)
  improves return-to-editing but has a 118.4 ms playback gap. Final full-source
  pacing, native comparison and repeated-session drift remain open.
- [x] T08 A bottom timeline with time ruler, playhead, visible keys/holds,
  editable timing, track selection, range selection, and horizontal zoom.
  **Verified:** [timeline.mjs](../src/timeline.mjs),
  [timeline.browser.mjs](../tests/timeline.browser.mjs),
  [timeline report](../artifacts/timeline-verification.json) and integrated
  authoring/creation UI reports exercise timing, tracks, ranges and scrubbing.
  The current [timeline interaction contract](TIMELINE.md) also documents the
  visible editing toolbar, resizable layer column, sparse selection, and scrub
  preview callbacks.
- [x] T09 Virtualize visible rows/ticks; do not create a DOM node for every
  figure multiplied by every frame or render all thumbnails on import.
  **Verified:** the timeline regression renders 20,000 sparse tracks with six
  label nodes and a viewport-sized 944-pixel canvas. Both scroll axes retain fixed
  track headers/ruler; horizontal scroll extent is bounded even for 1.2 billion
  output ticks. Sampled playback causes zero grid redraws. These are structural
  and input-path checks, not a guarantee for arbitrary scene-rendering workloads.
- [ ] T10 Visibility/lock controls state whether they are editor aids or affect
  output. Organizational tracks must not silently change imported Pivot draw order.
  **Progress:** User layer visibility affects composed playback/export; locking is an
  editing constraint. Permanent Scene/Camera visibility has Canvas/WebGPU/prepared/SVG
  color checks. Layer order remains native within unmodified imported layers;
  sampled independent source order and cross-layer joins have model regressions.
  [Advanced UI roundtrips](../artifacts/advanced-track-app.json) preserve tested
  layer blanks and channels exactly. Full visibility/order/media matrix remains open.
- [ ] T11 Simple Pivot filmstrip, real thumbnails, native inbetween sliders,
  multi-selection, Add/Update and keyboard workflow, selectable in Settings.
  **Progress:** [18 component checks](../artifacts/simple-timeline-verification.json)
  verify thumbnail rendering, selection, inbetween counts, frame clipboard,
  insert/reorder/undo, keyboard and bounded 10,000-frame DOM. Seven
  [workspace checks](../artifacts/workspace-simple-mode/report.json) keep controls
  reachable at the 205 px docked/floating minimum. Settings mode and persistence
  work. Native draft/re-click discard, stored playback/thumbnail and held-gesture Save
  now have eleven desktop checks; final cross-feature/package acceptance remains G14.
- [ ] T12 Independent user-created layers and property channels with permanent
  Scene/Camera tracks, sparse keys/holds, blank keys and native export.
  **Progress:** [16 layer-panel checks](../artifacts/layer-panel-verification.json)
  cover creation/rename/assignment/order/visibility/lock/delete and virtualization;
  [22 actual Advanced workflows](../artifacts/advanced-track-app.json) cover
  independent key movement/deletion, Camera/Scene property keys, blanks, undo,
  STYK/PIV reopen and exact tested pixels. [Actual Akane layer migration](../artifacts/akane-layer-migration-app/report.json)
  now plans in a cancellable worker: 9.42 s background work, 9.8 ms publication,
  no long tasks and nine complete-scene geometry samples preserved after undo/redo.
  Broader membership/deletion/cancellation and limit cases remain G15.

References: [frame controls](https://pivotanimator.net/help5-2/animation_frame_controls.htm),
[inbetweening](https://pivotanimator.net/help5-2/frame_inbetweening.htm),
[reference evaluator](../../studio/geometry.mjs),
[native easing tests](../../tests/test_native_easing.mjs), local 5.2.9 release notes.

## Figure construction

- [ ] B01 New/edit definition; attach lines/circles; cancel unfinished creation.
  **Progress:** the builder UI draws three connected line segments, commits a
  polygon with Enter and exposes its native fill. The explicit Rig tool edits shared definitions and cancels construction gestures
  without history; current `R`/Ctrl+R instead invoke pose-local Handle Edit.
  The complete unfinished line/circle/polygon cancellation matrix remains open.
- [ ] B02 Line/circle conversion; white/clear/solid circle fill; round/square
  caps; thickness including zero; dynamic/static state.
  **Progress:** builder UI converts line → solid circle → line and preserves
  native color/alpha; rig UI edits static construction handles. The full set of
  circle fills, caps, zero-width changes and dynamic/static transitions has not
  been exercised through the visible controls in one acceptance matrix.
- [ ] B03 Duplicate/mirror a segment or branch; split/unsplit; delete a segment,
  joint, branch, or polygon; nominate a new origin and repair references.
  **Progress:** [builder UI](../artifacts/builder-verification.json) verifies
  midpoint split, branch duplication/deletion, polygon deletion, undo, and a new
  origin with every visible joint position preserved. [11 current builder checks](../artifacts/builder-topology-app.json)
  add visible branch mirror, Unsplit and single-joint delete, keyboard/undo and
  real styled STK/PIV download/reimport. Independent topology/style tests verify
  remapping and one undo. [Mixed-rig reused-UID style targets](TOPOLOGY-STYLES.md)
  now support definition-scoped curves with 30 focused checks and native PIV
  output. [Set Origin](animation-origin.md) has 16 actual GPU/native/STYK checks.
  Retained-origin deletion/Unsplit and existing-parent duplicate placement now
  pass [20 actual root checks](../artifacts/origin-support/report.json), including
  cancellation, Undo/Redo and PIV/STYK pixel comparisons. The former reference
  deletion rejection is resolved; dense model tests also preserve joined motion.
- [ ] B04 Polygons attached to handles with curved edges and valid fill rules.
  **Progress:** [35 actual polygon construction checks](../artifacts/polygon-construction/report.json)
  verify native curved preview/committed geometry, Ctrl-path Undo/Redo, completion
  and cancellation, duplicate-cycle rules, one commit and actual PIV/STK export
  and picker reopen. Fill-rule comparisons outside these tested paths remain a
  coverage limit, not an observed missing operation.
- [ ] B05 Segment/polygon color, alpha, secondary gradient, figure outlines,
  draw order, numeric properties, and branch-wide operations.
  **Progress:** segment color/alpha and polygon fill changes pass the builder UI;
  text creation verifies gradient/outline styles; native draw-order context
  commands pass the canvas regression. [53 opacity inspector checks](../artifacts/style-keyframes/report.json)
  cover primary/secondary/outline opacity, sparse keys, scrubbing/undo and copied
  captured overrides without changing other instances. [13 actual Builder order checks](../artifacts/builder-order/report.json)
  verify native internal segment order and polygon alpha, with 24 related model/codec checks. The complete segment/polygon gradient,
  outline and branch-wide property UI matrix is not signed off.
- [ ] B06 Add multiple sprites to one figure; position endpoints, reflect,
  stretch, bend, and preserve source alpha.
  **Progress:** sprite import and embedded image/STK round trips pass the media
  report; [builder unit cases](../tests/editor-builder.test.mjs) also cover branch
  copies sharing one embedded media table. [Sprite placement](SPRITE-PLACEMENT.md)
  now has ten model/native PIV/STK cases and [nine actual dialog checks](../artifacts/sprite-placement/report.json)
  for endpoints, alpha, races and narrow layouts. [Eight actual desktop checks](../artifacts/sprite-builder-smoke.json)
  prove cross-figure attachment, Undo/Redo, native PIV/STK dialogs and reopen,
  cancellation and ordinary Import Sprite. Wider deformation/reflection pixel
  combinations remain coverage limits.
- [ ] B07 Modify a definition across the animation without destroying compatible
  instance poses, bends, lengths, colors, scale, or reflection.
  **Progress:** global text definition replacement preserves frame/figure
  identities and undoes correctly in the creation regression. Rig UI verifies
  construction edits retain existing angular offsets in another keyframe, undo
  restores original definition lengths/positions, and edited PIV/STK reopens.
  The complete pose-channel and per-instance appearance matrix remains open.
- [ ] B08 Preview, static-handle display, branch highlighting, canvas color,
  undo/redo including topology changes, and STK save/reload.
  **Progress:** rig UI selects visible static handles, verifies the live preview
  equals the committed geometry, cancels without history, and saves/reloads STK.
  Builder UI covers topology history and authored figure round trips. [29 actual
  construction-aid checks](../artifacts/builder-aids/report.json) now verify native
  F9/F10/F12 behavior, static endpoint exceptions, vector/text highlight and sprite
  anchors, independent editor color, persistence and export exclusion. The named
  branch-highlight and canvas-color gaps are closed.
- [ ] B09 Support the baseline's documented 30,000-segment figures without
  recursive stack overflow or quadratic dependency resolution.
  **Progress:** [large-figure.test.mjs](../tests/large-figure.test.mjs) and its
  [recorded result](../artifacts/large-figure-performance.json) validate, interpolate
  and build all 30,000 endpoints for chains, stars and reversed record order
  without warnings or recursion failure. Builder tests additionally check linear
  branch discovery and duplication up to the native capacity. Whole-editor
  interaction at this limit is not implied by these model-level checks.

References: [figure building](https://pivotanimator.net/help5-2/creating_figure_types.htm),
local release notes, [polygon paths](../../docs/PIV_POLY_PATH_FINDINGS.md),
[stroke rules](../../docs/PIV_STROKE_CACHE_FINDINGS.md).

## Rendering, media, backgrounds, and camera

- [ ] R01 Correct line/circle/caps/bends/polygon geometry, z-order, gradients,
  outlines, subpixel transforms, and antialiasing at arbitrary canvas zoom.
  **Progress:** the current WebGPU corpus run compares 101 sampled frames across
  37 projects against the existing Canvas renderer. Two edge-heavy samples exceed
  the conservative pixel threshold; none exceeds 0.1% interior mismatch. This is
  not an exhaustive native-Pivot pixel comparison at arbitrary zoom.
- [ ] R02 Figure opacity composites the completed figure as a group. Source
  alpha and segment opacity compose correctly; transparent primitives cannot
  be reordered merely to increase batching.
- [ ] R03 Image sampling, reflection, deformation, and native tint exceptions.
  Sprite import supports BMP/GIF/PNG and native bottom-left color-key behavior
  when source transparency is absent.
  **Progress:** actual PNG/JPEG import, optional native color key and embedded
  image round trips pass media tests. The GPU smoke report confirms nearest
  background sampling. BMP/GIF and the complete media-deformation matrix remain open.
- [ ] R04 Imported text uses embedded glyph paths and placement even when the
  original font is unavailable; retain text gradient, fill rule, and stretched outline.
  **Progress:** [71 native text codec checks](../artifacts/native-text-authoring/report.json)
  and [16 root-app workflows](../artifacts/text-app/report.json) preserve real
  Arial, Comic Sans, Webdings and Segoe Print outlines, glyph ordering, placement
  and native text edits through PIV/STK. A fresh app with font loading blocked
  renders tested reopened PIV pixels identically. Independent native stretched
  outlines/fill-rule acceptance across the full corpus remains open.
- [ ] R05 Create/edit Unicode text, installed fonts, bold/italic, multiline
  alignment, fill/gradient/outline, preview, STK persistence, and global updates.
  Changing a string alone does not reshape embedded glyph geometry.
  **Progress:** The worker-backed [text dialog](../src/text-dialog.mjs) supports
  imported native text without private metadata, installed/supplied outline fonts,
  bundled Noto styles, live preview and portable geometry. Reports contain
  [18 dialog checks](../artifacts/text-dialog/report.json),
  [16 root-app checks](../artifacts/text-app/report.json),
  [71 native interchange checks](../artifacts/native-text-authoring/report.json)
  and [10 real desktop font checks](../artifacts/desktop-fonts-smoke.json).
  [Six symbol/TTC dialog checks](../artifacts/text-symbols/report.json) add Webdings
  mapping and separately selectable Japanese collection faces. Missing new glyphs
  request an explicit font. [Native UTF16 outline evidence](../artifacts/native-static/native-text-unicode.md)
  does not establish contextual/non-BMP outlines as a native feature; remaining
  fallback/metrics and complete typography pixel equivalence are unsigned.
  See [font limits](../vendor/text/README.md).
- [ ] R06 Background library/search/rename, implicit white, solid/transparent
  color, linear/radial gradients, BMP/JPEG/GIF/PNG images, and per-frame changes.
  **Progress:** The [background dialog report](../artifacts/background-dialog/report.json)
  verifies search/rename/undo, imported off-center gradients, exact endpoint
  preservation, independent color opacity, angle changes without resetting
  midpoint/length and radial offsets/radii. [Scene commands](SCENE-EDITING.md)
  support sparse/range edits, authored keys, transparent ARGB and image import.
  Earlier model/native PIV and 35 render/color checks supplement the dialog.
  Complete native image formats, async image preview and combined save/reopen
  workflows remain open.
- [ ] R07 Two-background blends, camera-visible regions outside the canvas,
  image alpha, tiny camera scales, and correct image placement/sampling.
- [ ] R08 Camera translation/rotation/scale/reset, numeric input, copy/paste,
  center on selected figures (both axes or one), align to editor view, apply to figures.
  **Progress:** [13 actual camera workflows](../artifacts/camera-app/report.json)
  cover persisted Ctrl+K handles, orange translation, native red rotation,
  outlined radial scaling, initial-axis lock and undo. The [camera API](CAMERA-EDITING.md)
  supports numeric/range commands, copy/paste, center, align-to-view and Locate.
  [Nine authored camera-bake checks](../artifacts/camera-bake-authored/report.json)
  verify actual root/worker/WebGPU conversion and all 24 tested PIV-reopened
  outputs (max MAE 0.0352/255), with exact STYK channels/sources. Broader native
  media and edge differences remain documented in [camera baking](camera-baking.md).
- [ ] R09 Keep document camera separate from editor pan/zoom; preview/export
  and timeline thumbnails use the document camera consistently.
  **Progress:** The current camera app report verifies that ordinary editing and
  figure dragging use world space despite a saved camera, while Ctrl+Play previews
  the document camera without advancing time. Root playback/preview use the camera;
  editor pan/zoom is separate. Full camera-thumbnail/export and viewport boundary
  equivalence across asset cases remains unsigned.
- [ ] R10 Previous-frame background onion skin; 0–9 selected-figure skins,
  optional future/joined poses, UID continuity, and progressive opacity.
  Editor overlays/onion skins never enter playback or export.
  **Progress:** Cached root onion composition now implements the previous full
  frame plus 0–9 single-selected-figure past/ahead skins, joined filtering and
  progressive opacity; preview/playback suppress these overlays. Five
  [Canvas/WebGPU ordering cases](../artifacts/renderer-onion-order/report.json)
  verify previous-frame and selected-figure insertion order. Settings defaults
  and controls have UI evidence. Final integrated UID-transition/filter/output
  exclusion cases remain unsigned.
References: [sprites](https://pivotanimator.net/help5-2/sprites.htm),
[text](https://pivotanimator.net/help5-2/text_objects.htm),
[backgrounds](https://pivotanimator.net/help5-2/backgrounds.htm),
[camera](https://pivotanimator.net/help5-2/virtual_camera.htm),
[onion skins](https://pivotanimator.net/help5-2/onion_skins.htm),
[image/text details](../../docs/PIV_IMAGE_TEXT_RENDERING.md),
[bent media](../../docs/PIV_BENT_MEDIA_FINDINGS.md),
[bitmap sampling](../../docs/PIV_BITMAP_SAMPLING.md),
[background coverage](../../docs/PIV_BACKGROUND_CAMERA_COVERAGE.md).

## Export and desktop product behavior

- [x] X01 Current frame and numbered PNG/JPEG/GIF/SVG sequences; SVG retains
  editable vector data and valid embedded or referenced media.
  **Evidence:** Current PNG/SVG and numbered PNG/JPEG sequences retain independent
  decode evidence. [33 sequence browser checks](../artifacts/image-sequences/report.json)
  verify GIF/SVG numbering, CRC/timing, independent pixels/alpha, editable vectors,
  cancellation and subsequent export. The [28 native export workflows](../artifacts/native-video-renderer/report.json)
  include both sequence buttons and native Save with authored Scene changes at
  each output tick. Broader original-Pivot media equivalence remains tracked in X05.
- [ ] X02 Animated GIF/APNG with expected frame timing, looping, and alpha.
  **Progress:** GIF/APNG frames, timing, alpha and representative pixels pass
  browser and independent Pillow decoding. [Native-style GIF palette/dithering](gif-export.md)
  adds seven unit, eleven worker, nine root and 32 independent decoded checks,
  including repeat/loop behavior, alpha, 24 fps delay rounding and cancellation.
  Full original-Pivot pixel equivalence remains unsigned.
- [x] X03 WebM, MP4 (Pivot baseline: MPEG-4 Part 2), WMV, FFV1 AVI, and
  uncompressed AVI. Track the Windows installed-codec AVI workflow separately
  from portable encoder support; a container extension is not a verified codec.
  **Evidence:** VP8/WebM output has independent decoding. [Native export checks](../artifacts/native-video-renderer/report.json)
  verify MP4 H.264/MPEG-4, WMV2, and AVI MPEG-4/FFV1/uncompressed RGB through real
  buttons, codec selectors and native Save. Independent decoding confirms codec,
  all 16 frames, timestamps and representative pixels; FFV1/raw RGB at 161 × 91
  has zero byte differences. These portable presets are implemented. Arbitrary
  installed Windows VFW is separately implemented in [21 actual Electron checks](../artifacts/vfw-renderer/report.json):
  dual architecture enumeration, real vendor Configure/state and saved/decoded AVI.
  [Six VP9 alpha checks](../artifacts/webm-alpha-renderer/report.json) add actual
  transparent WebM Save and independent RGBA decode. Final package verification remains open.
- [ ] X04 Export dimensions/aspect, quality/bitrate, range, normal/no smoothing,
  supersampled sprites, progress/cancel, safe destination handling, and no overlays.
  **Progress:** Native quality/codec selection, bounded worker/IPC transfer,
  cancellation, post-cancel reuse and native Save pass integration tests.
  [Sampling verification](EXPORT-SAMPLING.md) now covers native no-smoothing and
  2× sprite filtering in 137 worker/encoder checks plus 38 independent file decodes.
  [23 actual root button checks](../artifacts/export-sampling-app/report.json)
  cover PNG/APNG, the current Simple draft versus stored animation, and cancel.
  [Nine updated video checks](../artifacts/worker-video-renderer/report.json)
  cover native VP9/VFW cancellation, retry and decoded sampling. Native D2D
  sprite geometry/alpha now has the documented source oracle and independent
  root-download checks. Full media and output-overlay acceptance remains unsigned.
- [ ] X05 Verify decoded output dimensions, frame count, duration, codec, alpha,
  and representative pixels against the same evaluated viewport scene.
  **Progress:** Image/SVG/WebM and six native codec choices have independent
  decoding, including exact frame timestamps and lossless RGB. A complete
  original-Pivot same-scene comparison across all media/styles remains open.
- [ ] D01 A launchable desktop shell, native file dialogs, filesystem access
  through a bounded bridge, useful import/export errors, and recovery/autosave.
  **Progress:** Windows shell, file read/write bridge, dirty-close flow and native
  recovery across process/origin changes pass the
  [desktop](../artifacts/desktop-smoke.json) and
  [recovery](../artifacts/desktop-recovery-smoke.json) reports. Smoke tests substitute
  dialog results; actual native dialog interaction is not exercised there.
- [ ] D02 Windows/macOS/Linux packages with per-platform smoke checks; source
  portability is not proof that a distributable launches on every platform.
  **Progress:** Windows 0.2.0 launches in the
  [packaged smoke report](../artifacts/desktop-packaged-smoke.json), with unpacked,
  portable and installer artifacts recorded in the
  [release manifest](../artifacts/windows-release-0.2.0.json). Packaged preference
  and recovery restarts are also verified. Evidence applies to those recorded
  package bytes; current macOS/Linux package runs are absent.
- [ ] D03 Custom clean UI with keyboard focus, accessible control labels,
  clipboard/IME, high DPI, resize, tooltips, resizable panels, and persisted preferences.
  **Progress:** Movable/docked panel persistence and bounds retain the earlier
  23-check workspace and packaged-restart evidence. [14 current inspector checks](../artifacts/properties-app/report.json)
  verify continuous native/keyed scrubbing, exact input, Escape and unclipped
  one-line controls at 900 px. [Settings checks](../artifacts/settings-verification.json)
  and [desktop restart](../artifacts/desktop-app-save-smoke.json) verify native
  node controls and persistence; the Simple panel has seven minimum-height checks.
  [The integrated walkthrough](../artifacts/integrated-ux-walkthrough/verified.md)
  verifies three viewport sizes, exact property selection/key target, actual Akane
  attachments/Build, and late-frame Simple reveal. Raw harness failures retain
  linked focused resolutions. Broader IME/high-DPI/accessibility acceptance remains open.
- [ ] D04 Graceful WebGPU unavailable/device-lost states, bounded resource use,
  recovery on resize, and idle/minimized throttling.
  **Progress:** [GPU smoke](../artifacts/renderer-gpu.json) verifies device
  destruction/recreation and tests workspace rendering through an explicit
  Canvas 2D fallback. Workspace tests verify backing-canvas changes while docking
  and resizing; CPU/GPU caches are bounded. [Actual disconnect/reconnect workflows](../artifacts/integrated-ux-walkthrough/verified.md)
  cancel canvas, keyboard and property scrubs without history, reject disconnected
  input, preserve Simple on Space release and restore WebGPU. Unavailable-adapter
  compatibility status is visible with its reason. Complete idle/minimized and
  sustained recovery acceptance remain unsigned.
- [ ] D05 Track optional file associations, Explorer previews, language files,
  and platform-specific integrations explicitly when assessing full baseline parity.
  **Progress:** File associations are configured. [Interface localization](LOCALIZATION.md)
  now has settings and root lifecycle hooks; 12 actual English/Italian app checks
  preserve document/history, focus, control identities and preference reload.
  All 27 supplied native language choices pass [37 actual app checks](../artifacts/localization-native-app/report.json),
  including Arabic reload, Unicode captions, unchanged history/document and compact
  Chinese fit. Modern captions without supplied translations use English fallback,
  and native language restart remains queued. Full RTL/custom installers are
  optional extensions unless established by the supplied native baseline.

References: [image export](https://pivotanimator.net/help5-2/separate_images.htm),
[video export](https://pivotanimator.net/help5-2/video.htm), local release notes.

## Reuse and architecture boundaries

The existing implementation assets are valuable reference code, not disposable
mock data. The following inventory was inspected for this task:

| Component | Reuse and boundary |
| --- | --- |
| [tools/pivot_decoder.py](../../tools/pivot_decoder.py), [piv_codec.py](../../tools/piv_codec.py) | Established binary decoding, legacy handling, source retention, assets. Keep parsing off the UI thread. |
| [tools/piv_server.py](../../tools/piv_server.py) | Existing loopback API: project listing/loading, binary PIV import, conservative/full export, and migration. The original API does not itself define an STK import endpoint. |
| [studio/model.mjs](../../studio/model.mjs) | `validateScene`, `syncDerived`, native numeric normalization, resource limits. |
| [studio/geometry.mjs](../../studio/geometry.mjs) | `timeline`, `frameTicks`, `evaluatedFrame`, `buildGeometry`, `drawGeometry`: reference timing, evaluation, and Canvas2D fidelity. |
| [studio/background.mjs](../../studio/background.mjs) | Native camera/background/blending semantics. |
| [studio/structure.mjs](../../studio/structure.mjs) | Stable identities, ordering, add/duplicate/delete, and rotation propagation. |
| [studio/definitions.mjs](../../studio/definitions.mjs) | Existing definition/project editor behavior; its DOM form implementation can be replaced. |
| [tools/pivot_ik_solver.js](../../tools/pivot_ik_solver.js) | Optional existing IK solver. IK and foot locking are extensions, not features attributed to Pivot 5.2.11. |

For this desktop application, a portable web UI plus a WebGPU canvas should be
hosted by a desktop shell. Decoding/export can use a persistent native/Python
worker behind a narrow bridge. The optional C++ native-frame scanner now targets
the measured import bottleneck and retains a Python fallback; binary transport
and cooperative editor preparation avoid one large JSON/validation task.
Component decoder timing is not full desktop import/presentation acceptance.
No IPC, JSON serialization, media decode, or whole-document clone belongs inside
a pointer-move or playback frame.

Compile immutable definitions into cached topology, handle maps, path data, and
GPU resources. Keep mutable pose channels and transient gesture previews separate
from authoring history. Reevaluate only affected figures and joined descendants;
upload changed data, preserve draw order, and pool temporary group surfaces.
Input handling should schedule the latest pose once per display opportunity.
Cache onion skins and thumbnails, and limit their work to visible/needed content.
Preserve accessible DOM semantics for custom controls even when the canvas is GPU drawn.

## Performance and verification gates

The user's requirement is fluent interaction on large scenes. A universal promise
of zero latency on every GPU, driver, operating system, and unbounded file is not
measurable. Record workload and hardware alongside observed timings; do not
equate `requestAnimationFrame`, GPU use, or an FPS badge with proof of no stalls.
Pivot 5 already advertises GPU rendering in its supplied release notes.

- [ ] Q01 Import measurements separate file read, decompression, decode,
  validation, scene compilation, asset upload, and first editable presentation.
  Record cold/warm runs and peak memory; leave the UI responsive and cancellable.
  **Progress:** native read, backend decode/cache and worker parse have measured
  reports. The [atomic first-scene diagnostic](../artifacts/matched-app-interaction-atomic-diagnostic-v1/report.json)
  measures 2,224.2/1,640.9 ms cold/warm to the first complete media-ready GPU
  callback, zero import long tasks and exact legacy-upload pixels. Repeated native
  endpoint comparison and peak-memory acceptance remain in the finite release gates.
- [ ] Q02 Measure input-to-present latency and CPU/GPU frame times during
  translation, branch rotation, scrubbing, and playback; report p50/p95/p99 and
  stalls rather than an average alone. At 60 Hz one display interval is 16.67 ms.
  **Progress:** The [complete earlier Akane run](../artifacts/edit-freeze-16-akane-vs-akato-segundo-round--3--full-playback-budgeted/presentation-summary.json)
  records p50/p95/p99 submission intervals 62.5/69.5/70 ms and maximum 363.1 ms.
  Later pooled tail and editor-adoption results, with their differing worst gaps,
  are summarized in [the goal ledger](GOAL-ACCEPTANCE.md#performance-evidence-and-required-comparison).
  The [visible patch benchmark](../artifacts/playback-patch-app-visible-final/report.json)
  records four real Akane native/authored translation commits at 6.4–13.3 ms,
  31.2–44.8 ms ACKs, 1.33–2.26 MB patches, no long tasks and maximum rAF gap 20.9 ms
  in those windows. Ready latency 285.8–297.6 ms includes a 250 ms idle debounce.
  These metrics are not input-to-physical-present. The original native visible
  tail is measured separately; matched import/input and final full-run
  superiority are not yet established.
- [ ] Q03 Exercise supplied large PIV/STK fixtures plus explicit stress scenes:
  many instances, detailed rigs, deep joins, large sprites, polygons, translucent
  overlap, text, camera motion, and enabled onion skins. Report dropped frames.
- [ ] Q04 Compare new renderer output with native reference exports, including
  every output tick in the supplied corpus, and inspect representative images.
  Record source/build/fixture hashes and pixel metrics; classify fidelity gaps.
  **Progress:** current results cover 101 sampled ticks from 37 files against
  the existing Canvas evaluator. They do not cover every native Pivot output tick.
- [x] Q05 Run actual UI flows: PIV/STK import → selection/posing → frame edit →
  undo/redo → playback/scrub → save/reopen → export. A decoder unit test cannot
  verify this flow.
  **Verified:** [creation.browser.mjs](../tests/creation.browser.mjs) performs
  this complete chain on one real imported PIV containing a real imported STK,
  using rendered controls and shortcuts; [all 37 checks pass](../artifacts/creation-verification.json).
  Native saved and exported PIV artifacts are retained alongside the report.
- [ ] Q06 Verify malformed-file handling, cancellation, large limits, dirty
  close/recovery, device loss, keyboard focus, and packages on each claimed OS.

The older [browser review](../../docs/STUDIO_REVIEW.md) records comparison of
2,396 outputs across 37 source projects and explicitly limits those findings to
its tested implementation. The tests and reference artifacts are reusable
oracles; those pass claims must not be relabeled as StykAnimate-webapp results.
