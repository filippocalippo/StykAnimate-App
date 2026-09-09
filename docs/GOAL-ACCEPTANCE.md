# Full product goal and acceptance ledger

Updated 2026-09-09 after an independent source/artifact audit. The full objective
remains a modern, expandable desktop successor to Pivot, with complete Pivot
behavior and markedly better large-scene interaction. A packaged first slice or a
green smoke test does **not** complete that objective. This ledger records current
source progress. Windows 0.3.0 is now built and verified; older releases are preserved.

Final Windows delivery verification on September 9 passed the packaged native
WebGPU/import/save/close smoke, two-process settings and Italian locale persistence,
and all 32 workspace/timeline checks. The final package contains the compact
title-bar overflow fix and matches 159 web assets and 11 native modules.
[Release notes](RELEASE-0.3.0.md) state the measured limits;
[the release marker](../release/0.3.0/verified-release.json) records exact binary hashes.
This closes Windows delivery and the final integrated workspace walkthrough,
not the remaining full native performance or cross-platform acceptance.

The baseline is the supplied Pivot Animator 5.2.11 and its
[official manual](https://pivotanimator.net/help5-2/index.htm). The
[compatibility contract](PIVOT_PARITY.md) remains the full acceptance matrix.
Unchecked items mean unsigned acceptance, not necessarily absent implementation.
The finite release gates below identify current blocking work. Broader matrix
coverage in the compatibility contract is a record of confidence and limits;
an unspecified additional combination does not reopen an implemented operation.
The audit read source and retained artifacts; localization and legacy clipboard
upgrade additionally have actual app checks. GPU benchmarks were not rerun by this audit. Old artifact
results do not transfer to untested later changes.

## Explicit requirements

| Requirement | Current evidence | Remaining acceptance |
| --- | --- | --- |
| StykAnimate-webapp desktop application | Repository/package uses `stykanimate-webapp`; Electron window and executable use StykAnimate. Native bridges and Windows packages exist. | Record the shortened display name consistently; rebuild and smoke-test the final source rather than claiming the older package contains it. |
| Custom WebGPU canvas | Live editing and prepared playback use WebGPU, retained resources, bounded caches and workers. Actual unavailable-device status and graphics-loss input cancellation/reconnect pass the integrated UX walkthrough. | Final source performance measurements; wider native pixel/platform recovery comparisons are coverage limits. |
| Clean Figma-style UI and usable movable/resizable panels | Real user layers, contextual inspector, continuous numeric scrubbing, independent settings, docking/floating and compact-width controls have interaction evidence. | Finish the native workflows below and repeat the final integrated visual/focus walkthrough. |
| Adobe Animate-style Advanced timeline | Independent layer pose keys and scalar channels, permanent Scene/Camera tracks, blank keys, undo and STYK/PIV roundtrips pass 22 actual-app checks; large Akane layer migration and scoped-row interaction also have actual evidence. | Final integrated smoke and stated performance limits; no known missing named track operation. |
| Exact Pivot Simple timeline | Native thumbnails, green inbetween sliders, multi-selection, frame actions and virtualized scrolling exist. Eleven native workflows now prove Add/Update/draft/discard, stored playback/thumbnails, held-gesture Save and restart persistence. | Shared-rig drafts also have focused model coverage; complete cross-feature Simple/Advanced transitions and final package verification remain unsigned. |
| Real PIV/STK interchange through supplied tools | All 37 supplied PIV fixtures import; source-bearing STYK, edited PIV and media/text STK workflows pass focused checks. | Original Pivot reopen/render evidence and full legacy conversion, unsupported-data and asset/style matrices. |
| Very fast import, immediate large-scene posing and smooth playback | Exact Akane traces, native node gestures, pooled GPU resources and incremental playback document patches are measured. | Matched native import/input/presentation and complete final-source playback comparisons; no universal zero-latency claim. |
| Expandable, performant architecture | Native codecs, model/history, sparse channels, retained pose sources, worker export/playback, UI and desktop bridge have defined boundaries. Large migration, inbetween and clipboard work are cancellable and published atomically. | Full-scene clipboard still takes several seconds and has measured allocation/scheduling gaps; keep those limits explicit. |
| Broad desktop OS support | Windows delivery exists; macOS/Linux package and sidecar targets are configured. | Actual macOS/Linux builds, launch/import/export/recovery and platform input tests. |
| Full Pivot feature parity and direct-posing philosophy | Definition, instance, pose and timing are separate; joined-handle routing now uses native rules and colors. | Close remaining feature/compatibility gaps without silently simplifying animation or reducing the accepted scope. |

## Native workflow ledger

“Implemented with evidence” closes the named earlier missing operation, not every
combination in the full compatibility contract. Owners may be working beyond the
artifact snapshot; in-progress code is not a passing result.

| ID / priority | Current implementation and evidence | Remaining work |
| --- | --- | --- |
| G01 / P0 | **Pose-local Handle Edit implemented.** Held R and Ctrl+R use a separate current-pose editor; the global Rig tool remains distinct. [20 pointer checks](../artifacts/native-handle-pointer/report.json) include attached Akane nodes, fixed other endpoints, cancel and one undo. | Preserve this through shared-definition/topology and authored-pose combinations; final full interaction matrix remains unsigned. |
| G02 / P1 | **Alt whole-figure transforms implemented.** Selected joined subtrees rotate/scale once; Ctrl/Shift modifiers can change during the gesture. [Pointer](../artifacts/native-handle-pointer/report.json) and [7 modifier checks](../artifacts/native-modifier-pointer/report.json) verify routing, locks, axis capture and cancellation. | Complete the broader selected-parent/child, default reset and multi-frame transform matrix. |
| G03 / P1 | **Neighbor Locate and alignment implemented.** Native handle IDs, joined groups and pose-local R behavior are supported. [15 keyboard checks](../artifacts/native-handle-keyboard/report.json) cover rotated-camera screen-pixel nudge, diagonal alignment, retained hover target, Locate, Caps Lock and input focus. | Preserve behavior across missing identities, hidden keys, all camera channels and authoring modes. |
| G04 / P1 | **Range commands and root wiring implemented.** [19 actual range UI checks](../artifacts/range-actions-app.json) exercise real noncontiguous selection, one undo, untouched gaps and four worker-rendered output ticks before/after undo. [Figure range API](FIGURE-RANGES.md) covers appearance, order, joins and transforms; numeric X/Y is absolute, canvas translation relative. | Broader native/authored media and original-Pivot reopen combinations remain unsigned. Per-segment values remain current-pose operations by native design. |
| G05 / P1 | **Cross-document clipboard and legacy destination upgrade implemented.** Authored sources/destinations, assets/UIDs/layers, joins and visibility are remapped; desktop clipboard survives restart. Final source-stable [14 clipboard/Simple Cut All workflows](../artifacts/clipboard-async-app/report.json) and [19 legacy-upgrade workflows](../artifacts/clipboard-legacy-app/report.json) pass with actual Undo/Redo and PIV/STYK export/reopen. The [86-test focused suite](../artifacts/clipboard-final-focused.tap) covers exact asset preflight, cancellation and native codecs. | All [1/64/all-key existing/empty CPU cases](../artifacts/clipboard-akane-final-cpu.json) preserve exact values, old frame references and history. Actual UI default Copy/Paste takes 85.9/89.4 ms and 64-key Akane Paste 1.309 seconds; its maximum rAF gap is 132.1 ms despite zero Long Tasks. CPU all-key Paste takes 8.698/9.784 seconds existing/empty. Capacity/correctness gaps are closed; measured pacing limits remain explicit. [Contract](FRAME-CLIPBOARD.md). |
| G06 / P1 | **Camera viewport and authored baking implemented.** [13 viewport checks](../artifacts/camera-app/report.json) cover native transforms, locks and preview. [9 authored bake checks](../artifacts/camera-bake-authored/report.json) cover the actual app, worker and WebGPU; all 24 tested outputs survive converted PIV reopen with maximum MAE 0.0352/255 and STYK channels/sources remain exact. [Baking contract](camera-baking.md). | Complete the broader native camera/background/media matrix; the measured native Webdings and legacy-sprite edge differences remain documented rather than called pixel-exact. |
| G07 / P1 | **Native onion model implemented.** Previous full frame plus optional 0–9 single-selected-figure skins, Show Ahead/Joined and progressive opacity are cached; playback/preview/export exclude overlays. [Renderer ordering](../artifacts/renderer-onion-order/report.json) covers five Canvas/WebGPU cases, including insertion before the selected figure. [Settings](../artifacts/settings-verification.json) verify defaults and controls. | Final integrated selected/joined filtering, UID transitions and output-exclusion walkthrough; renderer and settings evidence are narrower than that full workflow. |
| G08 / P1 | **Same-path Save implemented and verified.** [11 actual desktop workflows](../artifacts/desktop-app-save-smoke.json) distinguish Save/Save As, scope destinations to documents, preserve PIV sources, handle cancellation and prevent dirty-close data loss when edits arrive during save. | Include these source changes in the final rebuilt package; maintain the full failure/recovery matrix. |
| G09 / P1 | **Native codecs, VFW and sampling implemented.** [28 baseline desktop checks](../artifacts/native-video-renderer/report.json) cover six portable codec choices and lossless odd-size RGB. Genuine VFW has [21 Electron checks](../artifacts/vfw-renderer/report.json), both architectures, real vendor Configure/state and nine independently decoded choices. [Six VP9 alpha checks](../artifacts/webm-alpha-renderer/report.json) prove native Save/RGBA decode. [23 root sampling checks](../artifacts/export-sampling-app/report.json), 137 worker/encoder and 38 independent decode checks cover no smoothing, default smoothing and 2× sprite filtering. [Nine updated worker video checks](../artifacts/worker-video-renderer/report.json) prove actual cancel/retry, saved frames and selected sampling. | Native D2D aliased sprite-boundary behavior is now implemented and independently verified. GIF palette/dithering has [9 root checks](../artifacts/gif-dithering-app/report.json), 11 worker and 32 independent decode checks. Native whole-corpus pixel equivalence and final package verification remain open. [Export contract](EXPORT-FORMATS.md), [sampling scope](EXPORT-SAMPLING.md). |
| G10 / P1 | **Portable editable text and fonts implemented.** [18 dialog checks](../artifacts/text-dialog/report.json), [16 root-app checks](../artifacts/text-app/report.json), [71 native codec checks](../artifacts/native-text-authoring/report.json) and [10 desktop font checks](../artifacts/desktop-fonts-smoke.json) cover imported native text, installed/supplied fonts, live worker preview, one undo and exact outline persistence with fonts unavailable. | Native binary evidence confirms per-UTF-16-unit glyph outlines rather than full contextual/non-BMP outline shaping. Webdings symbol authoring and TTC face selection now have [6 actual dialog checks](../artifacts/text-symbols/report.json) and 22 focused codec/unit checks. Font fallback and complete native typography pixel equivalence remain unsigned; do not call absent native non-BMP shaping a parity blocker. |
| G11 / P2 | **Background library/gradient dialog implemented.** [11 actual dialog checks](../artifacts/background-dialog/report.json) verify search/rename/undo, imported angle, exact unchanged endpoints, independent stop alpha, preserved midpoint/length and radial offsets/radii. [Scene commands](SCENE-EDITING.md) cover sparse/range edits and native interchange. | Complete all native image formats, async image-preview refresh and combined dialog-to-save/reopen cases. |
| G12 / P2 | **Chosen-ratio Insert Inbetween implemented.** [5 actual app checks](../artifacts/insert-inbetween-app.json), [14 dialog checks](../artifacts/insert-inbetween-dialog.json) and 14 model/codec tests cover imported PIV, ratio preview, selected ranges, exposure inheritance, forced-linear native semantics, cancellation, one undo and PIV/STYK reopen. [Contract](INSERT-INBETWEEN.md). | The [actual Akane worker run](../artifacts/akane-inbetween-async-app/report.json) inserts 20 keys into 208,373 poses with exact source geometry/order/joins/media/camera, one Undo/Redo and cancellation. It records 8.39 seconds background work, 16.3 ms commit, zero long tasks and a remaining 104.2 ms maximum rAF gap. Broader media/native reference coverage remains unsigned. |
| G13 / P2 | **Joint value UI and clipboard implemented.** [11 root-app checks](../artifacts/segment-values-app/report.json) plus [25 dialog checks](../artifacts/segment-values-dialog/report.json) cover I/context entry, relative angle, label scrubbing, native partial-token clipboard, fixed-point mode, apply/cancel and one undo. Keyboard nudge/alignment is separately covered by G03. | Preserve native tangent/length semantics and focus across the broader joint/attachment matrix. |
| G14 / P1 | **Simple native working-pose baseline implemented.** [11 real desktop checks](../artifacts/simple-native-smoke.json) cover Add preserving the prior saved frame, Update, actual Keep/Discard dialog, undo/redo, navigation, exact stored thumbnail pixels, stored playback/Stop restoration, held-gesture STYK Save and restart. The Simple journal has 30 focused model checks; [six additional native boundary checks](../artifacts/simple-boundaries-smoke.json) cover true zero stored frames, native STYK/PIV zero export/reopen, context actions and working-pose isolation. | Complete cross-feature mode transitions and final-package verification remain unsigned; the named prior draft/thumbnail/held-save gaps are implemented with evidence. |
| G15 / P1 | **Large layer migration now uses cancellable worker planning.** [Actual Akane assignment](../artifacts/akane-layer-migration-app/report.json) moves joined UID 460611 across all 1,872 ticks in 9.42 seconds background work, with 9.8 ms publication, zero long tasks and maximum rAF gap 13.9 ms. Nine complete-scene geometry samples stay exact after assignment, undo and redo. [Contract](LAYER-MIGRATION.md). | Broader limits, cancellation races and independently timed deletion cases remain unsigned; 9.42 seconds of background processing is not an instantaneous-operation claim. |
| G16 / P2 | **Recent Files implemented.** A bounded native store retains 20 canonical paths behind opaque IDs; 14 service tests cover atomic replacement, duplicate/order/cap, missing/forged IDs, restart and non-deletion. [Native restart proof](../artifacts/simple-native-smoke.json) exercises Open/Clear and preserves the file. | The allowlist includes PIV/STK/STYK and the existing validated legacy STYK JSON Open path. Native main alone remembers authorized Open/Save descriptors. Final package inclusion remains open. |
| G17 / P2 | **Interface language service and settings implemented.** [12 actual app checks](../artifacts/localization-app/report.json) prove English/Italian selection, same control/icon identities, exact document/history preservation, Undo/Redo, preview labels and preference reload. All 27 supplied languages also pass [37 actual editor checks](../artifacts/localization-native-app/report.json), with Arabic reload, native Unicode captions, unchanged document/history and compact Chinese fit; 16 pure parser/service/source-hash checks pass. [Scope](LOCALIZATION.md). | Modern controls without supplied captions use English fallback; native desktop language restart is queued. Full RTL and a custom locale installer are optional modern extensions unless an actual supplied-Pivot baseline proves them; they are not inferred completion blockers. |

[The integrated UX walkthrough](../artifacts/integrated-ux-walkthrough/verified.md) now verifies docking/floating at three widths, exact property-key targets, real Akane attached dragging and Build across figures, late-frame Simple reveal, unavailable-GPU status and graphics-disconnect pointer/keyboard/scrub cancellation without history. Reconnect restores WebGPU; broad IME/high-DPI/platform acceptance remains separate.

[29 export/Preferences layout checks](../artifacts/export-panel-layout/verified.md) verify all 15 final export controls, persistent close/header, internal scrolling and separate settings/format columns at three desktop sizes. The regional Spanish language choice is fully readable after widening the selector.

The original audit remains in [native-feature-gaps.md](../artifacts/native-feature-gaps.md)
as historical evidence. Its earlier missing-operation descriptions are superseded
by this table. Additional source-level and unsigned acceptance findings are listed
in [acceptance-audit-current.md](../artifacts/acceptance-audit-current.md).

The missing outline/gradient opacity controls are also implemented: [53 actual inspector workflows](../artifacts/style-keyframes/report.json) cover all three opacity channels, key diamonds, interpolation, navigation, scrubbing/undo and copied instance overrides; three viewport screenshots were inspected. [11 builder workflows](../artifacts/builder-topology-app.json) cover branch mirror, Unsplit, single-joint delete and real styled STK/PIV reopen. [Topology style remapping](TOPOLOGY-STYLES.md) supports definition-scoped curves across reused-UID rigs: 30 focused tests and [22 actual scope workflows](../artifacts/mixed-rig-scope/report.json) cover global/scoped keys, dormant selection, Undo and 11-tick PIV/STYK poses/styles. [13 actual Builder order checks](../artifacts/builder-order/report.json) cover internal segment order and polygon alpha.

[20 actual origin-support workflows](../artifacts/origin-support/report.json) close retained-reference deletion, Unsplit and existing-parent duplicate placement, with native export/Undo and pixel comparisons. [Eight native Sprite Builder workflows](../artifacts/sprite-builder-smoke.json) close endpoint placement, cross-figure attachment, cancellation and PIV/STK dialogs/reopen. [35 polygon workflows](../artifacts/polygon-construction/report.json) verify curved preview, path Undo/Redo, completion/cancellation and native roundtrips. [29 Builder aid checks](../artifacts/builder-aids/report.json) verify F9/F10/F12 preferences, static-handle exceptions, highlight and export exclusion. These named prior operation gaps are closed; newly wired branch-style/split controls remain in the finite integration gate.

## Performance evidence and required comparison

The [complete earlier Akane run](../artifacts/edit-freeze-16-akane-vs-akato-segundo-round--3--full-playback-budgeted/presentation-summary.json)
submits all 1,872 output ticks in order: 117.264 seconds first-to-last versus
116.938 nominal, p50 62.5 ms, p95 69.5 ms, p99 70 ms and maximum 363.1 ms.
Both prepared caches stay within 128 MiB; active playback has no main-thread long
task in that run. This predates later pool/patch/camera changes.

The [later pooled tail run](../artifacts/renderer-live-tail-desktop-pool-pruned/report.json)
covers ticks 1824–1871 at 16 fps: 2933.9 ms versus 2937.5 nominal, submission p95
69.9 ms and maximum 73.8 ms. The [editor-adoption run](../artifacts/renderer-live-tail-desktop-editor-adoption/report.json)
reduces final live renderer CPU work from 49.6 to 17.5 ms and the measured return
task from 142 to 78 ms, but that run also has a 118.4 ms playback submission gap.
Do not select only the most favorable run or treat submission as physical display.

The [visible incremental-patch run](../artifacts/playback-patch-app-visible-final/report.json)
records four actual Akane translation commits. Commit calls take 6.4–13.3 ms,
worker ACK 31.2–44.8 ms, and patch payloads 1.33–2.26 MB; no long tasks occur in
those four measured windows. Packet readiness is 285.8–297.6 ms, including the
app's 250 ms idle prefetch debounce. That is not input-to-present latency.

The [original Pivot visible tail](../artifacts/native-playback-tail-visible-v5/report.json)
records the same 48 ticks with native Present-call intervals p95 67.35 ms and
maximum 74.26 ms. Native Present calls, browser submissions, GPU queue callbacks
and compositor/display events are distinct metrics. The new app has **not** yet
passed the requested overall performance-superiority comparison.

The [atomic first-scene diagnostic](../artifacts/matched-app-interaction-atomic-diagnostic-v1/report.json) records one source-stable cold/warm Akane pair at 2,224.2/1,640.9 ms to the first complete media-ready GPU callback, zero import long tasks, 0.6/0.5 ms first retained draws, exact legacy-upload pixels and 23 native gesture checks. The earlier 2,016.8/1,699.1 ms C++/cooperative-load callback omitted the background texture and is historical partial-submit evidence. This is not the formal repeated-process native Present comparison or a universally faster claim.

Final acceptance needs matched source/build/fixture hashes, viewport/camera,
machine/GPU/display settings and defined cold/warm conditions. Record native and
new-app import-to-editable time, body/joint/joined-group input-to-present latency,
scrubbing, full playback pacing, peak memory and repeated-session behavior. Retain
raw traces, report distributions and worst stalls, and rerun the complete file
on the final integrated source. Universal zero latency is a product aspiration,
not a claim supported by GPU use or a short average.

## Integrated UX and release closure

The earlier [exploratory UX audit](../artifacts/ux-audit/report.json) remains a
historical snapshot. Its gradient-angle, numeric-range, scrub and text limitations
must not be presented as current absent features: the focused background,
properties, native range and text reports above supersede them. The
[14 current properties checks](../artifacts/properties-app/report.json) verify native
and keyed scrubbing, exact typing, Escape, contextual layer/Scene/Camera panels,
and one-line navigation without clipping at 900 px. The
[Simple panel minimum checks](../artifacts/workspace-simple-mode/report.json) verify
reachable controls when docked, floating, restored and resized.

A feature closes when its intended operation works through the current UI,
preserves document meaning through undo/save/reopen and passes the relevant
focused verification. The full goal remains open while required feature,
performance, compatibility or delivery gaps remain. Final release notes must
state measured limitations and the exact tested package bytes; a prior Windows
launch does not establish that current source, macOS or Linux is delivered.

### Current finite release gates

| Gate | Required result |
| --- | --- |
| Large clipboard | Capacity and correctness are closed: final source-stable CPU 1/64/all-key existing/empty cases, 14 actual clipboard/Simple Cut All and 19 actual legacy-upgrade workflows pass. Preserve the measured limits in release claims: all-key Paste takes 8.70/9.78 seconds, and actual 64-key Paste records a 132.1 ms maximum rAF gap. Remaining pacing work belongs to the performance gate. |
| Performance | Complete the final source's media-ready import and full-file playback measurements with stated native/browser endpoints, source hashes and peak memory. Investigate any reproduced stalls, including the recorded 104.2 ms inbetween rAF gap, before describing the app as frictionless. |
| Final integration | Run a final source smoke covering import, attached posing, Simple/Advanced editing, undo, save/reopen and export. Scoped styles pass 22 actual checks; native branch-style/split controls pass [20 actual checks](../artifacts/builder-branch-controls/report.json), including pixel-exact PIV output; the override-aware opacity convenience passes [13 actual checks](../artifacts/branch-opacity/report.json). The named construction, panel and recovery defects are resolved. |
| Windows delivery | **Passed for 0.3.0.** Exact package hashes, native codec/scanner availability, import/save/close, two-process locale/panel preferences and 32 packaged workspace checks passed. See the release marker and RELEASE-0.3.0.md. |
| Platform claims | Run macOS/Linux builds and native workflows where hosts are available; otherwise state explicitly that these are configured, untested targets. Do not claim those binaries were built or run. |

Full RTL, custom language installation and contextual non-BMP glyph shaping have
not been established as capabilities of the supplied Pivot baseline. They are
optional extensions. Wider typography, renderer pixel, high-DPI and input-method
matrices remain documented coverage limits unless a reproducible defect is found.
