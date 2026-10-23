# Engine: editing (stage S5, phase 1)

How editing moves from the JavaScript `Editor` (`src/editor.mjs` and about 80
`src/editor-*.mjs` modules, roughly 800 methods) into the engine without
changing the interface or breaking the app at any commit. The plan is
[`../RUST-ENGINE-PORT.md`](../RUST-ENGINE-PORT.md); the decision is D15.

## Where it starts

The editor owns the document as JavaScript objects and runs every command; the
engine mirrors it ([document.md](document.md), [D12](decisions/0012-document-mirror.md)).
Commands mutate records copy-on-write, record history entries (records before
and after), and emit change events the interface listens to.

## Phase 1: commands one at a time, record for record

- A command is ported when `styk-edit` reproduces it **record for record**:
  given the same document, selection, tick and arguments, it changes the same
  records into the same bytes, leaves the same selection and returns the same
  event detail (`kind`, `frameIndices`, `figureIndices`, `sourceIds`,
  `structural`, `definition`, labels).
- In the app a ported command first runs in **shadow** (below): the JavaScript editor
  stays in charge and the engine's answer is compared, on real documents and gestures.
  Ownership of a document moves to the engine in one step once its commands are ported
  ([D15](decisions/0015-commands-record-for-record.md), revised): adopting records command
  by command would need two copies of the editor's runtime state kept equal by hand.
- Every port is checked by the **command-replay harness**: a scenario (a
  document, editor options, a list of `[method, ...arguments]` steps including
  undo and redo) runs in the JavaScript editor, which records the document
  bytes, selection and events after every step; `styk edit-replay` runs the same
  steps in `styk-edit` and compares. Scenarios come from the existing editor
  tests, from fixtures built with `engine/tools/fixture-kit.mjs`, and from
  recorded sessions.
- Order: what the app runs. The app constructs the editor with `propertyChannels` and
  `layerTimeline` (`src/app.mjs`), and `load` gives every document a layer sheet
  (`initializeLayerSheet`). Every gesture in the app therefore takes the authored path
  (`src/editor-authored-pose.mjs`): a draft of the evaluated frame at the playhead, the same
  per-figure mutations as on a native frame, and a commit that captures the edited frame
  into pose sources and writes keys on the layer tracks (`_commitSheetPose`, the sheet
  planner and `publish` in `src/editor-layer-sheet.mjs`). The native-timeline commands
  ported first are those mutations, checked on native frames; the app needs, in order:
  1. **The evaluated frame as records**: `editor.evaluatedFrame` reproduced as JSON byte for
     byte (layer sheets, tweens, movieclips, layer order), because a commit stores it.
     Done: `styk_eval::records` ([evaluation.md](evaluation.md)).
  2. **The authored lifecycle and the sheet planner**: drafts, ownership, key writing,
     pose-source capture and the history entry `publish` records. Done for gestures on
     existing figures (see the status below).
  3. **The facade**: the app's gestures run in the engine.
  Then frames and keys, layers and the layer sheet, figures and the builder, movieclips,
  effects and clips, camera, drawings' metadata, clipboard, sessions.

### Camera and builder prerequisites (2026-10-04)

The camera owner includes V8-exact logarithms and the native editor follows cached travel.
`Prepared::travel_ready` reads worker preparation only; `Pose::shot` retains the source
key for that view. A browser edit session refuses a cold follow tick or a changed report
instead of preparing the path on the interface thread. Native read/bake replays match;
canonical worker session publication remains required before app bake adoption.

Measured bounds are captured once from the callback the editor already runs and sent as
bounded data (8,192 samples, receiver/UID/tick/range order preserved). Centering/alignment
shadow those completed measurements; the callback still belongs to the editor. Joined
spatial IK, branch thickness, native-property tokens, sprite insertion and drawing a new
figure have focused recorded native/sheet coverage; their remaining origin/native-channel
branches refuse explicitly, and no facade/class gate opens from this prerequisite.
`CommandKind::FigureSplice` preserves library insertion and native-frame undo/redo.

The joined pinned motion-path oracle correction is exercised in the app through cancel,
commit and history (one adopted + 11 exact calls). Measured bounds compare eight calls;
new-figure identity-capacity refusal compares two and preserves the whole project.
Electron follow pictures pass all nine stored/preview/onion captures (mean 0.0553–0.0884,
zero solid pixels). The strict follow app check still refuses cold paths and baking at
new revisions; it does not certify adoption until worker publication is connected.
Forty-five admitted recordings match all 1,290 steps; four guard recordings confirm refusal.
The 41 derived evaluated groups / 362 ticks are included. Public portable additions are
`styk_math::log`, `Prepared::travel_ready`, `Pose::shot` and `CommandKind::FigureSplice`;
`math_log` is a browser export only in `styk-wasm`. The logarithm test reads its generated
binary at runtime so identical regeneration does not invalidate release compilation.

### Ordinary builder Split publication (2026-10-05)

`splitBuilderSegments`, `splitSegment` and `splitSegmentBranch` can request the
additive Session JSON field `view.topologyPublication: true` (strict boolean).
For an admitted ordinary sheet call with one structural definition edit,
`answer.topology` carries `{index, figure, frames}` and optional `animation` and
`sheetAnimation`. Each frame names an existing keyframe index or a local source
(`index: -1, sourceId`); its objects replace existing UIDs in their original order.
Animation fields use `{exists, value?}` to distinguish absence from explicit null.
The packet comes from pre-call/final COW reports, not the last undo entry. Consumers
must reject an absent or unusable packet before mutation.

Before mutation, the facade validates definition/pose identity, ordered frame/source
coverage and absent/null animation fields. It applies the packet, then runs the
original `_finishTopologyEdit` history/publication tail; rollback and source pruning
remain in their existing owners. Native timelines, movieclip/source/origin figures,
live gestures and drafts retain the original route.

Focused checks pass 94 Rust tests, 12 recordings / 272 exact calls, 225 JS tests,
Main check and 1,340 byte-stable fixture JSON. The full warmed default run adopts
one Split with exact document/history/selection/full undo. Build UI Split/Undo,
branch scope, repeated sessions and drawing/discard also pass without page errors;
inspected desktop/compact screenshots use the compatibility renderer, not engine-1
GPU certification. See the separate
[command measurement](../performance/RUST-EDITING-COMMANDS.md). Other Session answers
and Rust signatures are unchanged; mobile consumers opting in must read the fields.

### Ordinary sheet Unique publication (2026-10-05)

Literal `view.movieclipUniquePublication: true` requests optional
`answer.movieclipUnique: {definitionIndex}` for quiet ordinary-sheet
`makeMovieclipUnique`. Existing `definitions[0]`, sheet, layers, sources, result,
state and events remain the payload. The certificate binds a sole appended shallow
copy to the selected original, with unchanged existing definitions/keyframes,
complete new source frames and the original event order: definition edit, sheet
edit, seek, selection and closing batch edit. An absent or
unusable certificate retains the existing route; a native timeline has no sheet to
certify and runs the command without one.

The facade preserves original shallow definition children and runs the existing
`movieclipBatch`, definition publication and layer-sheet adoption tail. It validates
marker/scalars/events/state/source order before writing through the original
incremental layer-sheet validator. Application failure uses the original rollback
and retires the advanced Native session; tick/selection follow original event points. This is additive opt-in Session JSON only; Rust signatures,
document schema and stored math do not change. Mobile consumers opting in must
handle the requested certificate. Focused checks pass 233 Rust tests, five
recordings / 79 exact calls, 266 JS tests and Main check. Required-profile shipping
is 10,257,065 bytes. Actual warmed default UI copies at ticks 2 and 2.25 preserve
twelve paired document/history/selection/phase boundaries, undo/redo and full undo.
Both Unique calls have positive Native/adoption clocks without fallback; the
matched command timing is diagnostic only, not a class-cost gate. See
[command measurements](../performance/RUST-EDITING-COMMANDS.md).

### Layer folder publication (2026-10-05)

Literal `view.layerPublication: true` requests optional `answer.layerPublication`
for quiet ordinary-sheet create/rename/move/arrange/delete folder calls:
`{label, structural, updates: [{path, remove, value?}]}`. Original accepted operands
are captured in order before history recording or trimming. A null removal carries
`value: null`; undefined removal omits `value`. False no-ops and errors omit the
packet. Default answers remain unchanged without the opt-in field.

The facade validates the command certificate and metadata paths before applying
updates through the original `_layerEdit` filtering, history, source pruning,
selection and sheet-track publication owner. It reuses the existing folder
validator, copies metadata heads once and leaves retained tracks/report data in
their existing owners. Native/source/origin/active-edit contexts retain their
existing route. Public Rust signatures/layouts and stored math are unchanged;
mobile consumers opting in must handle the additive JSON field, while the current
mobile pin remains untouched.

`getLayerFolders` is an ordered UI projection of published records, including
unknown fields, with no independent validation, ordering or mutation. The module
is verified after actual positive default adoption of all five mutators with exact
query/return/history/selection/full undo. Normal editing-crate checks pass
236 tests (zero failed/ignored, 53 groups), three fresh recorded replays /
58 exact calls, 204 JS tests (zero failed/skipped) and final Main check. The actual
Advanced timeline Ungroup action and all 21 paired boundaries match; each mutator
has positive Native/adoption clocks and no editor fallback. Observed command timings
are diagnostic only; class-cost policy and full-class row counts are unchanged.

### Figure clipboard counter publication (2026-10-05)

Literal `view.figureClipboardPastes: true` requests successful top-level
`pasteSelection` and `duplicateSelection` answers with `figureClipboardPastes:
null | {before, after}`. Null represents no copied clipboard. A pair binds the
actual clipboard counter; duplicate captures its temporary clipboard before
restoring the saved clipboards. Defaults, errors and unrelated calls omit the field.

Before any copy or publication, the facade validates the captured counter and an
increment of zero or one. It runs the original events, then increments that same
clipboard only when certified; duplicate reuses `copySelection` and restores both
saved clipboards in the original `finally`. Listener-held temporary references,
listener mutation/replacement, no-op writes and failure recovery retain their
original behavior. Range paste history keeps its original geometry-retention flag
independently of whether a committed retained frame is present. Foreign clipboard
guards and unsupported-context routes are unchanged.

This is additive opt-in Session JSON; public Rust signatures/layouts, document
schema and stored math do not change. Mobile consumers opting in must handle the
requested null/pair field; the mobile pin remains untouched. Checks pass 238 Rust
tests, three recordings / 106 exact calls, 263 JS tests and Main check. The actual
default proof matches all 34 paired boundaries and full undo, including nine
successful pastes, three duplicates and three expected validation errors. See
[command measurements](../performance/RUST-EDITING-COMMANDS.md); this does not
advance a class gate or full-class cost row.

### Recorded worker movieclips, history and publication (2026-10-04)

Native and sheet movieclip creation, splitting, unique copies, break apart, placement,
playback and extension share the existing materializer, capture, `SheetPlan` and history
owners. Retained source documents preserve their original effect clocks. Worker-only
entry points do not bypass the app's readiness or document-class gates; unrecorded
IK/draft combinations and runtime adoption remain guarded.
`styk edit-replay --worker <reference.json>` exercises this same dispatch and compares
every editor step. Ordinary replay retains its explicit refusal behavior.

Native-timeline movieclip commands (create, empty, place, split, break apart, playback,
restart, unique, next-keyframe extension, library insertion) also run in the owner's
interface-thread Session (D19), through the same `Editor::call` implementation: the
editor ran them synchronously on that thread, the Session takes no lock, and a refused
call became an external history entry instead. The Session's earlier "requires worker
preparation" refusal is gone: 67 recorded tape calls were refused, now none. Documents
with IK controllers or a saved working frame still refuse atomically before any change.
`tests/movieclip_session_integration.rs` replays 56 native tapes through the Session.

Awaited Bake now uses this central worker replay for 37 default-budget families /
234 calls, including recorded saved figure/scene VFX reads. The same materializer,
native source capture and checked SheetPlan/history owners handle publication;
direct Editor/legacy Session admission stays closed. A separate four-call object-limit
trace uses an explicit 1 GiB offline source allowance; the runtime/default replay
budget remains 128 MiB. The four-call concurrent stale trace remains unported until
the actual actor/yield lifecycle is matched. Its optional step `interleavings`
array records the real editor calls run during the awaited operation. The shared
offline replay refuses a nonempty array before dispatch; it does not compare that
unsupported step or claim stale runtime parity. The initial worker CLI check
revealed a step-2 mismatch in the old recording rather than the lane's claimed
refusal. Adding causal metadata preserves all of its original captured fields.

Full record observation is opt-in and disabled on normal Editor/Session calls.
At the canonical checked record boundary it captures attached metadata, actual
weights and enumerable carriers before batch insertion or trimming. The sole
history-weight projection supplies both sizing and the optional carrier; specialized
estimates remain separate from payload data. The strict replay compares every
captured field, including selection, history epochs/weights and nested batch records.
Two existing Frame/Ranges traces add 27 observer calls without extending command
admission. Unrecorded carrier variants refuse rather than inventing optional fields.
Materializer, topology and clipboard now share `styk_eval::vfx::remap_owner`.

History weights follow the editor's UTF-16 JSON accounting, source charges, trim order
and oversized-entry rules. A warm owner supplies its exact readiness checkpoint;
reconstructing it by summing entries can change stored floating-point results. Optional
selection metadata is kept in the central snapshot/restore owner and checked before
publication. The facade exchanges ordinary new figure IDs before their records arrive,
then publishes the document; restoration must preserve that ordering.

`Session::prepare_worker_history` and `prepare_worker_call_values` operate on the same
worker-owned editor. `PreparedPublication::guard_worker_checked` validates the original
report, selection, counters and history before exchanging heads. Engine publication
pairs that exchange with the acknowledged mirror generation. Its opaque
`EditPublicationAdmission` retains canonical roots and their shared byte charge through
terminal ACK, cancellation or refusal. This is a prerequisite for the durable actor;
it does not make the current interface-thread Session a worker actor.

Recorded origin sheet motion paths use `Editor::motion_display_frame_worker` for the
editor's transient display read while the canonical shown-frame owner remains unchanged.
Checked `SheetPlan` state forwards cancellation checks and preserves removed tracks.
Unsupported native authored channels and complex live states refuse before mutation.

The five recorded native origin motion families also use that display owner. A remote
write splits a native row through `FrameSlice` / `CommandKind::Ranges`; membership,
attached-layer changes and UTF-16 history weights use the existing checked owners.
Twenty-two actual editor commands certify both their enumerable history and the
worker's retained weights. A native one-tick shown row holds its pose while scalar
channels keep the fractional clock; raw sampling remains distinct in the same bounded
cache, through `Records::evaluated_editor_with`.

The two recorded saved-native origin motion families extend the same private native
draft and pose-source owners. `Records::new_native_draft` composes validated transient
channels with the same immutable tree/Prepared projection, preserving live scalar-key
insertion order until commit; finalized channels still require normal ordering.
Repeated pointer writes reuse allocated source IDs, and only commit publishes their
registration and the ordinary Animation history entry. Separate `@frame` and
`@motionFrame` observations preserve authoritative and transient displays. Scalar-only
native motion, property projection, ordinary native targets and unrecorded complex
combinations remain atomic refusals. These worker prerequisites do not open an app
ownership gate.

Portable mobile pin additions include `HistoryLimits`, worker history configuration,
preparation and application methods, `Editor::set_revision_counters`,
`set_selection_metadata`, `motion_display_frame_worker`, prepared/guarded publication
types and accessors, and the Engine layer planning and canonical publication APIs.
`CommandKind::Animation` gains structural metadata, `FigureRange` retains geometry when
recorded, and layer/movieclip command variants preserve their recorded history shape.
Browser bindings remain confined to `styk-wasm`.

The native motion milestone additionally exports `FrameSlice` and the
`CommandKind::Ranges` variant; downstream exhaustive matches need the new variant.
`Records::evaluated_editor_with` is an additive portable evaluation entry point.
The saved-native milestone adds portable `Records::new_native_draft` and changes no
public `styk-edit` API.
The Bake milestone adds `CommandKind::LayerSheet.retain_geometry: bool` (update explicit
constructors/patterns), portable `styk_eval::vfx::remap_owner`, and offline-only
`replay_worker_with_source_budget`; normal runtime budgets are unchanged.

Evaluation also adds `MovieclipSource`, `Document::movieclip_source` and
`Frame`/`Keyframe::retained_vfx_tick`. These portable fields keep cropped source clocks
and inherited effect evaluation intact; downstream struct literals need the new fields.

### Quiet actor and exclusive live capability (2026-10-04)

The Engine's existing Core can own one moved Session. Quiet requests prepare on workers,
stream bounded packets, and wait for packet and readiness acknowledgements. Final
publication exchanges the canonical Engine and editor heads under the same State and
cancellation guard. Committed quiet and live requests retain displaced roots and their
admission charge until terminal ACK, including cancellation after publication. Close
retires them on the owning worker.
Fresh bootstrap preserves loaded revision/serial/saved counters; attaching
an existing Session preserves its history and exact warm checkpoint. Unsupported warm,
clipboard, live, metadata and absent-field states refuse before transfer or mutation.

`prepareFreshEditWorker` and `projectWorker` are explicit asynchronous host primitives,
with no app call-site or document-class activation. Project controls admit at most three
existing scalar fields from the original Fields/history owner. They keep the old host
root behind a dependent-query barrier, then accept the actual committed identity before
exchanging scalar slots. Busy reads preserve that root. The same finite progress wait
retries lock contention without fabricating progress or resubmitting a command. Every
Ready attempt checks cancellation and view ownership; cancellation after an actual
commit cannot roll back or replay it. Postcommit host failure retires the worker owner.

Separately, consuming `Session::into_worker` produces the portable exclusive
`WorkerSession` capability. Its private identity and operation epoch guard prepared live
operations using the same editor, publication, history, source and SceneBudget owners.
The actual editor's working document and shown frame remain separate. Ten ordinary
native/sheet lifecycle tapes compare all 115 calls, complete returns, state, events,
display, exported history fields/weights and runtime flags. Eight recorded native
`propertyChannels:true` tapes now also match all 93 calls through the same exclusive
worker and Core owner; their original options are preserved. Five asynchronous
preflight tapes remain evidence for a future protocol, not admitted live calls. This
capability is coupled to Core's portable `Handle::submit_live` for the twelve recorded
methods. It remains outside browser ready/shown tickets and app writer transfer.

Core moves the same Session into its WorkerSession capability during initialization,
attachment and detachment. Working-only operations exchange the editor/display heads
without publishing a stored Mirror root or rebuilding its Loader. Actual history
revision changes publish the stored root even when the committed JSON is identical.
Each ready display and displaced display uses the same SceneBudget reservation.
Quiet undo/redo after a live gesture uses that same display owner. Ready is a raw/typed
Frame and Scene here; no encoded DrawList or actual Stage presentation is certified.
After terminal ACK, the current ready display remains alive and its raw record stays
charged to the SAME receiver reservation. Admission counts current, canonical,
prepared and response raw heads as one shared union before cloning. It grows only the
positive delta, then shrinks to the actual current raw head after worker disposal of
all detached aliases. `Arc::get_mut` supplies the hard uniqueness barrier including
Weak aliases. New preparation returns Busy before Session mutation while an alias
survives; existing drop-first retirement wakes only the original Core, including idle
request-zero recovery, without polling or another queue. Close/no-ready releases the
charge after the physical ready drop. The receiver cap remains 1 GiB, separate from
128 MiB editing/materialization. This covers receiver/current-ready raw storage;
Editor history/clipboards, typed/encoded ownership, physical union and leases remain open.

`WorkerSession::prepare_worker_history` is the additive portable history entry point;
`Handle::submit_live` adds portable Core submission. Existing browser bindings do not
activate it. Preserve complete return values, events, history and displayed frames from
the recorded oracle rather than substituting the editor's working document for display.

The private native property projector adopts the original scalar curve through the
existing marker/source, Draft, Records, typed channel sampler and Animation/history
owners. Recorded automatic easing, rotation winding and source ordering are preserved.
The recorded worker-only lifecycle now dispatches through the existing checked native
owner, AuthoredDrag and guarded publication; legacy calls and wider native combinations
remain refused. Cold baseline/presence/typed preparation
between cancellation checks is not certified as bounded dense work.
The additive `Records::pose_source_frame(id, native_index)` lookup preserves retained
source precedence. A row hint requires verified unique native frame identities; raw or
unvalidated records must use `None` for first-match semantics.

The Session's single response builder borrows the existing worker check callback only
for worker preparation. Original host cancellation/Invalid/Unported errors escape that
preparation even if a later callback succeeds; recorded editor Invalid stays canonical
JSON. Legacy calls keep the same serializer and dispatcher. Complete original returns,
actual displayed records, exported history and source/cancel lifecycle are compared.

Portable offline tool addition: `replay::replay_session_live_worker(&Value, &Value)`
consumes one fresh Session and checks its actual initial document/state/history/display/
runtime before the first call, then every prepared and guarded step. Counters must be
lossless nonnegative whole JavaScript integers; counts also fit platform `usize` before
casts. `styk edit-replay --live-worker <session> <returns> [pairs...]` exits nonzero for
any refusal, mismatch or invalid pair. Its original recordings are separate immutable
inputs; foreign warm history is not fabricated. This adds a portable replay API for the
mobile pin and worker command support; browser capability/class gates are unchanged.

`mirror::{WorkerPublication, WorkerEditPublication}` provide an opaque scoped worker
candidate. Preparation retains the same Mirror guard, CommitMarker and Loader, and
exposes borrowed access to the exact prebuilt Generation/Assets before the existing
final State exchange. `prepare_record_publication_worker` and
`prepare_edit_publication_worker` use that owner; existing commit methods delegate to
it. Commit consumes it once and returns worker retirements; cancellation, stop, stale
generation or disposal preserve the old heads and leave callbacks uncalled. Working
displays borrow the current generation; actual history revision changes still publish
when stored JSON is identical. This adds portable APIs for the mobile pin, with no
ACK-spanning guard, Core ready-storage change or browser adoption.

The additive opt-in `prepare_edit_typed_publication_worker` pairs the actual Editor
WorkerFrame Scene with candidate Assets using `GuardedPublication::typed_cache_worker`.
Its opaque `GuardedTypedCache` borrows the same guarded after-Cache report, Loader and
Prepared; it cannot be supplied from another host or independently compiled Scene.
The raw layerSheet must be an object, the actual Prepared must have a typed sheet and
the existing checked layer planner must admit its descriptors. Malformed or missing
sheets refuse atomically. All typed heads and the SceneBudget lineage must match;
image namespace and imported glyph identity are preserved, including working-only
operations whose guarded after report differs from the acknowledged stored root.
The displaced typed Loader is retired on the worker through the existing publication
retirement. These three additive APIs are platform neutral for the mobile pin.

Recorded namespace and glyph operations compare the complete editor observations;
native/nested figure import and background import remain explicit refusals. The ordinary
independent-loader publication API and Core route are unchanged. Actual encoded
Ready/Shown adoption still needs this opt-in capability connected to the existing worker
owner; pairing is not Stage, release or whole-document D7 certification.

Portable mobile pin additions: `RevisionCounters`, `Session::{start_worker_prepared,
revision,history_checkpoint_worker,into_worker}`, `WorkerSession`, `WorkerPrepared`,
`WorkerFrame`, `PreparedPublication::{revision,project_fields_response_worker}`,
`RetainedScene`, `RetainedScene::scene`, `SceneBudget::retain_worker`; the Engine
`session` module's `Stamp`, `Epochs`, `Phase`, `Error`, `Success`, `Packet`, `Poll`,
`FreshHistory`, `Handle` and Engine attach/detach/fresh-session methods. Browser
`EditWorker` and typed Busy bindings remain in `styk-wasm`. Exclusive app writer
transfer, bounded live transport, cold query ordering, actual ready/shown/resource ACK
and complete disposal remain required before class adoption or deletion.

## Status of phase 1

`engine/crates/styk-edit` holds an `Editor` over the report as the mirror receives it, with
the playhead, the selection, the gesture in progress and a history of its own (for the
harness; the app's history stays in JavaScript in this phase). `styk edit-replay
<reference.json>…` and `cargo test -p styk-edit` replay every recording in
`engine/tests/edit/`.

| Call | Ported | Recorded in |
| --- | --- | --- |
| `select(uid, joint, {toggle, add})`, `selectMany(uids)` | yes | selection-native, every sheet scenario |
| `seek(tick)` (its return value, the evaluated frame, is read by the facade from its own copy) | yes | selection-native, move-joined, gestures-sheet |
| `beginDrag(label, {scope})`, `beginTranslationDrag`, `commitDrag`, `cancelDrag` | yes | move-native, drag-cancel, gestures-sheet |
| `moveSelection(dx, dy, {fromStart, detachExternal})`, joined roots refreshed from the engine's geometry | yes | move-native, move-joined, drag-cancel, move-sheet |
| `rotateSelection`, `scaleSelection`, `scaleSelected`, `mirrorSelection` (whole figures), `rotateFigure`, `centerFigure`, `resetPose`: pivots from the engine's geometry | yes | rotate-native, transform-native, transform-joined, gestures-sheet |
| `poseJoint`, `rotateJoint`, `bendJoint` (with `stretch`, `isolate`, snapping back to the definition), rotations carried into joined figures (`rotationEdits`), Stick Nodes curves (a straight segment with a sagitta, which geometry reports with a bend of 1e-6) | yes, without 3D bones | pose-native, pose-joints, pose-joined, pose-snap, gestures-sheet, sticknodes-sheet |
| Every ported call on documents with property channels as the app holds them (a layer sheet's `legacyAnimation`): the frames a call drafts, captures and materializes are composed as the editor composes them (`styk_eval::records`) | yes | channels-figure-sheet, channels-pose-sheet, channels-vfx-sheet, channels-camera-scene-sheet, channels-movieclip-sheet, channels-style-sheet, channels-curves-sheet, channels-outline-sheet, channels-follow-sheet |
| Every ported call on documents with 3D bones, meshes, surfaces, perspective and part proportions | yes | spatial-mesh-perspective-sheet, spatial-mesh-sheet-sheet, spatial-surfaces-skin-sheet, spatial-surfaces-perspective-sheet, spatial-mesh-mechanism-sheet, spatial-clip-mesh-sheet |
| 3D bones (`styk-edit/src/spatial.rs`): turned (`setSpatialPose`, `rotateJoint` without `isolate`, from the angles the bone is drawn with), dragged flat on screen or swung in depth with the depth key, the alternate side and a mid-drag switch (`poseSpatialJoint`, `_flatSpatialJoint`, `_arcSpatialJoint`), stretched, twisted (`bendJoint` → `twistSpatialJoint`); mechanisms' hinges and slides set (`setSpatialMotion`, a hinge through `setSpatialPose`) and dragged along their track (`_moveMechanicalJoint`), a driven hinge included. Results go through `quaternionPose` with `styk-math`'s `asin` | yes | spatial-turn-sheet, spatial-mechanism-sheet, spatial-drag-sheet, spatial-mechanism-drag-sheet |
| Pose choices (`styk-edit/src/pose_choice.rs`, `setPoseChoice`): a group of 3D bones shown one at a time or all hidden (`_stykPoseChoice`), a group of presets over existing angle and length channels (`figure._styk.poseChoices`, `applyChannelPoseChoice`); what is selected read back from the channels as `poseChoiceGroups` does | yes | pose-choices-sheet, pose-presets-sheet, pose-choice-mechanism-sheet |
| 3D IK controllers (`spatialTarget`): every call on their frames, with posing a bone of a planted limb releasing it (`_releaseSpatialChain`), a posed hand or foot planting its new orientation (`_plantSpatialFollower`) and turned followers' 3D orientations (`spatialFollowers`, the editor's quirk of keeping only the last of several turned included) | yes | ik-spatial-sheet, ik-spatial-side-sheet, ik-spatial-mirrored-sheet |
| Steering planted 3D limbs: dragging a knee or elbow swings the limb's bend plane (`getSpatialIKPole`, `setSpatialIKPole`); twisting a bone of the limb swings its swivel and twisting the ankle or wrist marker turns the foot or hand (`twistSpatialJoint`); a whole figure turned with its 3D targets, bend planes and planted orientations (`setSpatialPose` with `wholeFigure`); `resetSpatialPose` for a bone, a mechanism or the whole rig, releasing its targets | yes | ik-spatial-steer-sheet, ik-spatial-side-steer-sheet, ik-spatial-mirrored-steer-sheet, spatial-reset-sheet |
| Posing 3D IK targets (`styk-edit/src/spatial_ik.rs`): a planted target moves with its knee kept on its side on screen (`_flatSpatialIKPole`), the depth key pushes it in depth and a plain drag continues from there (`poseSpatialIKDepth`, `_spatialIKPointer`), `setSpatialIKTarget` sets depth, pole and swivel; a free 3D limb is captured once per gesture with its 3D target and followers' orientations (`captureSpatialIK`, `_drag.ikCapture`) and solved without following the target's orientation; IK posing on rigged figures, the drawn angles read from the rig (`RigJoint`) | yes, not across joined figures | ik-spatial-target-sheet, ik-spatial-side-target-sheet, ik-spatial-free-sheet |
| Rig controls: a joint in a rig space takes the pointer through `authoredRigTarget` (from `styk_eval::ik::rig`; the drawn shape and rig space from geometry's `RigJoint`), an angle lock only stretches along its chord and does not turn, a connector slides (`slideConnector`, `setConnectorPosition`) and bends through the pointer (`_bendConnector`); skins, angle paths and weighted joints are not posed by hand | yes, without 3D bones and IK posing on rigged figures | rig-sheet, ik-rig-follow-sheet, ik-rig-stretch-sheet |
| IK settings (`styk-edit/src/ik_settings.rs`): `setNodeIK` switches a controller on (pinned where the limb is drawn, refused on a joint a rig derives and on chains that would share bones) or off (the limb kept as drawn, a 3D limb's record kept), pins and releases it (released lengths kept on the chain), sets stretch, chain length, bend side ("Both" recapturing the bend) and a 3D limb's swivel; `rotateIKTarget` turns a target (a free limb captured first, its branches turning with it); `setSpatialFeetPinned` plants or releases every foot of a 3D figure in one gesture | yes, not across joined figures | ik-settings-sheet, ik-settings-pinned-sheet, ik-settings-spatial-sheet, ik-settings-rig-sheet, ik-settings-followers-sheet |
| `poseJoint` on the end of a limb with an IK controller (`poseIKTarget`): a pinned target moves; an unpinned limb is captured as drawn, solved to the pointer and baked, its followers and bend kept in the controller; across joined figures on the assembly's skeleton (`poseGraph`, `captureFor`) | yes, without perspective or 3D controllers | startup-sheet, ik-unpinned-sheet, pinned-ik-sheet, ik-joined-unpinned-sheet, startup-join-sheet |
| Gestures around pinned limbs: the solution baked before a pose edit (`_objectEdit(…, {posed})`, `_bakeIKFollowers`), follower offsets turned with their joint (`_rotateIKFollowers`), the bend remembered after every change (`_rememberIKBends`), a stretched end followed by its pin (`_followStretchedIK`); a gesture on joined figures takes in their whole assembly (`_ikPoseSlots`, `_expandIKDrag`) | yes | pinned-ik-sheet, ik-followers-sheet, ik-chains-sheet, ik-joined-sheet, ik-joined-late-sheet |
| The project palette (`styk-edit/src/palette.rs`): `addPaletteColor`, `addPaletteColors`, `removePaletteColor`, `movePaletteColor` (colours as `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` or bytes), one `palette` history entry each; compared in both editors | yes | palette-sheet |
| Audio tracks and clips (`styk-edit/src/audio.rs`): `setAudioTrack` (name, volume, mute, solo), `deleteAudioTrack`, `setAudioClip` (start, trim, duration, volume, fades kept within the clip, another track; the clip edited goes last on its track, as in the editor), `deleteAudioClip`, recordings nothing uses dropped; validated as `validateAudioState` does, each recording checked once (the editor's `WeakSet`, here by identity without keeping it alive); one `audio` history entry each. Not run in the app yet: the engine's document leaves the audio out ([document.md](document.md)), so these stay with the editor until the engine saves. Adding tracks, importing, splitting, duplicating and pasting clips draw random identities and ripples with frame edits are batches: they stay in the editor | yes | audio-sheet, audio-none-sheet |
| Camera motion clips (`styk-edit/src/camera_motion.rs`): `setCameraMotion` (start, duration, switch, parameters, followed figures; muted ranges move with the clip) and `deleteCameraMotion`, validated as `validateCameraMotion` does, one `camera-motion` history entry each, the sheet lengthened to the last clip; compared in both editors, not adopted. `addCameraMotion` (each preset; a follow clip following the selected figures to the end), `copyCameraMotion`, `pasteCameraMotion`, `duplicateCameraMotion` (muted ranges moving with the copy) and `randomizeCameraMotion` take the identities and seeds the editor drew (D18) | yes | camera-motion-sheet, camera-motion-add-sheet, camera-motion-paste-sheet |
| `updateSegment(patch)`: the selected joint's angle, length and bend (one posed edit; a connector's length within 0 to 1) and its definition's colour, transparency, thickness, shape and construction flag with the raw flags following (one `figure` history entry); compared in both editors, not adopted (its definition event is not a sheet publication) | yes | update-segment-sheet, update-segment-rig-sheet |
| `updateObject(patch)`, `updateSelection(patch)`: the inspector's figure fields (scale, position, opacity, name, colour, mirroring, metadata) with the editor's refusals; with several figures selected, shared fields edit them all | yes | update-object-sheet, update-object-native |
| `addFigure(typeId)` on a layer sheet: a new figure of a library definition in the middle of the canvas at the playhead, selected, in the active layer, through the range commit (`applyFigureRange`, `insert`, `_commitSheetRange`: only the inserted figure's layer is keyed, unlike a whole-frame transaction, which also stores joined figures' roots) | yes, not for movieclips or on a native timeline | add-figure-sheet, add-figure-layers-sheet |
| The layer list (`styk-edit/src/layers.rs`): `renameLayer`, `setLayerColor`, `setLayerVisible`, `setLayerLocked` (the scene and camera tracks too), `reorderLayers`, `moveLayerTo`, `createLayer`, and folders (`createLayerFolder`, `renameLayerFolder`, `moveLayersToFolder`, `arrangeLayers`, `deleteLayerFolder`): one `layers` history entry each, as the paths of the layer state it changed (`_layerEdit`, including its quirk of recording a removal of what was absent), the sheet's tracks following the layers | yes; run in both editors and compared, not adopted (cheap, and the session then lives through them) | layer-list-sheet, layers-folders-sheet, layers-native |
| `sheetInsertKey`, `sheetDuplicateFrameAfter`, `sheetSetEasing`, `sheetClearKeys`, `sheetClearFrames`, `sheetInsertFrames`, `sheetRemoveFrames`, `sheetSetDuration`, `sheetAppendFrame`, `sheetMoveFrames` (keys moved or copied along their tracks, replacing the keys they land on): the layer timeline's keys and frames, clips on the document's clock retimed (and, when their keys move, their span and restarts with them: `shiftClipTime`) | yes, without drawing layers and audio ripple; copying a drawing layer's keys is not ported | keys-sheet, frames-sheet, frames-movieclip-sheet, frames-timed-clip-sheet, move-frames-sheet, move-frames-imported-sheet, move-frames-clip-sheet, move-frames-presence-clip-sheet |
| The timeline clipboard (`styk-edit/src/sheet_clipboard.rs`): `sheetCopyFrames` keeps each layer's poses over a range (at its start, its keys and the layer's end inside it, with their easing; a figure joined to one on another layer is kept where geometry puts it, unjoined, as `ownedFrame` does) and `sheetPasteFrames` writes them over or inserted before what follows, on the same layers or on others (the figures, joins and IK followers renamed together, the new identities assigned to the destination; a movieclip on the presence clock, or a continuation of one, that takes a new identity carries on from where it was when copied: `phases`, from the evaluator's presence clock); the copy's return value is the editor's clipboard, a view. A session pastes only what it copied itself: the facade asks the engine only when the editor's clipboard is the object the session's copy made (or both have none) | yes, without drawing layers, movieclip parts and clipboards from another document | sheet-clipboard-sheet, sheet-clipboard-empty-sheet, sheet-clipboard-ik-sheet, clipboard-presence-clip-sheet |
| Polygons (`styk-edit/src/polygons.rs`): `addPolygon` (through at least three distinct handles, a closing repeat dropped, behind the skeleton unless an order is given, the next identity kept in the definition), `updatePolygon` (handles, order, a surface removed), `removePolygon` (polygons without an identity take theirs from their place), refusing a cycle another polygon draws in either direction; one `figure` history entry each (`editDefinition`, native order arrays dropped); compared in both editors, not adopted. A colour edit of a figure on show is recoloured (below); a new surface is fitted to the figure's geometry: `Unported`; an opacity edit with property channels is keyed (property edits, below) | yes | polygons-sheet, polygons-native, polygons-native-file-sheet |
| Effect clips (`styk-edit/src/vfx_clips.rs`): `setVfxClip` (timing, name, switch, strength, fades, effects, keys), `trimVfxClipStart` (keys rebased when time before the source is revealed), `deleteVfxClip`, `moveVfxClipOrder` (among the clips of the same target), `reorderVfxGroupEffect`, `setVfxClipParameter(s)` (set, or keyed when asked, with auto key or where the parameter has keys), `toggleVfxClipKey`, `moveVfxClipKey(s)`, `deleteVfxClipKeys`, `setVfxClipEasing`, and the gizmo edit (`beginVfxClipEdit`, previews, one entry on commit; cancelled by cancel, undo and redo); one `vfx-clips` history entry each, the sheet lengthened to the last timed clip; validated as `validateVfxClips` does against the engine's effect registry (the clips and effects a command changes; the others were checked when they arrived, as the editor's set of checked clips assumes); compared in both editors, not adopted. Paint colours and connected scopes are validated through the same effect/paint owners; see the remaining-effect recordings below | yes | vfx-clips-sheet |
| Effect clips added, copied and pasted (`styk-edit/src/vfx_clips.rs`): `addVfxClip` (for the whole animation unless timed; a generated effect at the playhead's frame for its usual length, `GENERATOR_DURATIONS`), `copyVfxClip` (its effects sampled at the playhead: numbers and `0xRRGGBB` colours between keys, along the earlier key's easing), `pasteVfxClip` (with its keys, or with the values copied and no keys; a timed clip at the given start), `duplicateVfxClip` (after itself) and `addVfxGroupEffect`; identities and generated effects' seeds are the editor's (D18). Built-in and saved presets, attached scopes and paint colours sampled between keys also match the remaining-effect recordings below | yes | vfx-clip-add-sheet |
| Batches (`movieclipBatch`, as the timeline runs several commands as one entry): `beginBatch`, `endBatch`, `abortBatch` (and `@batch` in recordings) record the entries made in between as one `movieclip-batch` entry with the revision before the batch, send the batch's own change event, collect pose sources after it and undo the entries of a failed batch; undo and redo replay the entries in order and restore the batch's selection. In the app the facade opens and closes the session's batch around the editor's, compares the closing event and state, starts no session inside a batch and ends the session if the batch fails or brings its own starting selection | yes | batch-sheet |
| The timeline's layer selection: `selectSheetLayer` (the layer active and, with its contents, its figures on show selected, the first not joined to another the main one), seeks following it, `keepSelectionOnSeek`, any other selection dropping it, history restoring it; `setActiveLayer` | yes | sheet-selection-sheet |
| The figure clipboard (`styk-edit/src/figure_clipboard.rs`): `copySelection` (snapshots of the selected figures, joined ones where geometry draws them, joins kept only inside the copy, their definitions, layers and drawing order), `cutSelection` (pasted back in place), `pasteSelection` at the playhead (`insertionPlan`: new identities, a copy of each definition in the default and unique modes or the definition itself as an instance, offsets growing with each paste, front depth, joins and IK followers renamed, IK targets moved, node effects moved to the new definition; `insert`; `_commitSheetRange` keying the pasted figures' layers, with the new definitions added by the sheet's publication and removed by its undo), `duplicateSelection` (instances with new identities on their own layers, the clipboard kept). Movieclip instances: their definitions shared unless pasted as unique, a copy of one on show carrying on from where it was copied (`movieclipSamples`), an instance pasted where it is not on show keeping its identity (`linked`, `retained`), others playing on the presence clock from their start; movieclips alone are inserted as frame replacements of their own (`replaceAt`), and a pasted movieclip keys the playhead rather than a held cell. A session pastes only what it copied: the facade asks the engine only when the editor's clipboard is the object the session's copy made | yes, without drawings, figures with effect clips, branch selections and clipboards from another document or format version | figure-clipboard-sheet, figure-clipboard-ik-sheet, figure-clipboard-vfx-sheet, figure-clipboard-clip-sheet |
| Project settings (`styk-edit/src/project.rs`): `setFPS` (with the frame delay format 4 stores), `setCanvasSize`, `updateProject`, one `fields` history entry each (`_fields`, nothing recorded when unchanged); compared in both editors, not adopted | yes | project-settings-sheet, project-settings-format4-sheet |
| `importFigure(document, {position})`: a file's first frame (or a single definition) pasted as new figures with new definitions, centred on its unjoined roots at the position (the canvas's centre by default), joins named by slot in the file kept, the first figure selected; owned with the large figure class, adoption carrying the new definitions | yes, without movieclips, drawings and animation origins | import-figure-sheet |
| `setLayerParallax(id, patch)`: a figure layer's response to camera travel (linked axes following the one given, the reference the camera on show unless set), validated as `validateParallax`, one `layers` history entry | yes | layer-parallax-sheet, layer-parallax-camera-sheet |
| `renameMovieclip(name)` (`styk-edit/src/movieclips.rs`): the selected movieclip's definition renamed (trimmed, 1 to 120 characters, unchanged names not recorded), one `movieclip-definition` history entry (`publishDefinition`) | yes | movieclip-rename-sheet |
| `setMovieclipPlayback(patch)` and `setMovieclipDrawing(uid, group, view)` on the frame on show: an instance's mode, speed, offset, placement and restarts (or a drawing set's view, held), checked as `validatePlayback` checks them (presence-clock clips refuse placement), one object edit; across every frame (`{allFrames}`, `restartMovieclip`, `removeMovieclipRestart`), a clip on the presence clock takes the patch on every key of its layer, each written from the frame without its replacements, and in every replacement holding it (`sheetSetMovieclipPlayback`) | yes; across every frame only for clips on the presence clock | movieclip-playback-sheet, movieclip-playback-timed-sheet, clip-playback-all-sheet |
| `sheetTransferFrames(ids, destinations, start, end, tick, {copy})`: frames dragged to other rows, copied, cleared when moved and pasted in one batch, the clipboard left as it was; moved clips on the presence clock leave continuations on their source rows (`Retain moved movieclip phase`); compared in the app (its answer holds two publications, which the facade does not adopt) | yes | sheet-transfer-sheet, clipboard-presence-clip-sheet |
| Handle Edit Mode (`styk-edit/src/handle_edit.rs`): `beginHandleEditDrag({label, bend})`, `editHandlePosition(x, y, {bend})` (one edit outside a gesture), `commitHandleEditDrag`, `cancelHandleEditDrag`; the segments meeting the handle keep their arcs (`handleEditSegmentPose`, a bend edit keeping the tangent at the moved end), figures joined at the handle move with it, a gesture back at its start restores what it moved; angles of pinned limbs as solved, stretched lengths kept; rigged figures refused, movieclips `Unported` | yes | handle-edit-native, handle-edit-sheet, handle-edit-startup-sheet, handle-edit-ik-sheet, handle-edit-chain-sheet, handle-edit-sticknodes-sheet, handle-edit-full-turn-sheet |
| Whole figures by a handle (`styk-edit/src/figure_transform.rs`): `beginFigureHandleDrag(x, y, {rotate, scale, joint, label})`, `transformFigureHandle(x, y, {rotate, scale, ctrlKey, shiftKey})` (one edit outside a gesture), `commitFigureHandleDrag`, `cancelFigureHandleDrag`; the selected figures and those joined below them turn and scale about the dragged figure's origin, turns past a half turn accumulate, Ctrl keeps the scale and Shift the angle, back at the start the figures are restored | yes | figure-transform-native, figure-transform-sheet, figure-transform-ik-sheet |
| Handle commands (`styk-edit/src/handle_commands.rs`): `nudgeHandle(dx, dy, options)` (screen pixels through the view's zoom, rotation and mirroring; a root moves its figure, a joint poses, bends, stretches, moves in Handle Edit Mode or turns the whole figure), `alignHandle` (on an axis through its start or the figure's origin), `locateEditedHandle` (to where the handle is on the previous or next key), `segmentValues`, `beginSegmentValueEdit`, `setSegmentValues` (degrees, relative to the incoming tangent through joined origins, in Handle Edit Mode or by turning), `copySegmentValues` (text, compared as a view), `pasteSegmentValues`; a session pastes only the values it copied. Nudges go through the frame's camera and the camera motion clips moving it at the playhead (`cameraAtTime`, computed with V8's `Math`: `styk_eval::camera::impulse`); follow clips: `Unported` | yes, without follow clips | handle-commands-native, handle-commands-sheet, handle-commands-ik-sheet, handle-commands-camera-native, handle-commands-camera-sheet, camera-motion-handles-sheet |
| Camera commands on a layer sheet (`styk-edit/src/camera_commands.rs`): `copyCamera`, `pasteCamera`, `setCameraValues`, `resetCamera`, `transformCamera`, `alignCameraToView`, `locateCamera` (each changed value a camera key through `addAnimationKeys`), camera drags (`beginCameraDrag`, `updateCameraDrag` previewing its keys on the frame on show, `commitCameraDrag`, `cancelCameraDrag`, and `commitDrag`/`cancelDrag` during one; other calls while one is open: `Unported`), `locateHandle` (the handle's figure moved by where the handle is on the neighbouring key); a session pastes only a camera it copied. `applyCameraToFigures(indices, {ticks})`: at each chosen frame whose camera is not the identity, every figure keyed where the camera shows it (root through the inverse camera matrix, scale, rotation) and the camera keyed back to the identity, through `_sheetPropertyEntries`, the camera being where camera motion clips put it at that frame. On a native timeline, follow clips, and `centerCamera`: `Unported` | yes, on layer sheets | camera-commands-sheet, camera-bake-sheet, camera-motion-handles-sheet |
| Motion paths on a layer sheet (`styk-edit/src/motion_path.rs`): `beginMotionPathEdit(target, tick, {label, falloff})`, `updateMotionPathEdit(point, {stretch, isolate, movePins})`, `commitMotionPathEdit`, `cancelMotionPathEdit` (and `commitDrag`, `cancelDrag`, a seek and undo during one), `setMotionPathFalloff`, `motionPathFalloff`. A trail point dragged at its own tick poses a copy of the frame evaluated there while the playhead stays put: a figure's origin translates its connected figures (pinned targets carried with `movePins`; a joined figure's origin turns its parent's joint), a joint turns its subtree and the figures joined below it (stretched, isolated; pinned limbs' displayed solution baked first), the end of a limb with IK moves a pinned target or solves and bakes a free limb (across joined figures too), the camera's trail moves the camera; each pointer move rewrites one key per track in place (`_sheetPoseDraftWrite`: a held cell at its key unless auto key is on, the figures a key's movieclip replacements placed captured in those replacements), and the commit publishes once. A falloff (`planFalloff`, every shape) moves the target's keys inside the influence by weight, with edge keys holding the original pose and held keys claimed by the strongest write; the sharp shape's cube is V8's (`pow`, not the correctly rounded cube for 15 inputs; every weight is checked against the editor's). Refusals: ticks outside the animation or between frames, a figure, handle or static joint that is not there, locked layers, a full-turn bend stretched. On a native timeline, rigged and 3D figures, and turning a joint of joined figures with pinned limbs whose followers would turn (the editor reads those followers with the dragged figure's own definition and the assembly's layout, and throws once the assembly is larger): `Unported` | yes, on layer sheets | motion-path-sheet, motion-path-falloff-sheet, motion-path-autokey-sheet, motion-path-layers-sheet, motion-path-locked-sheet, motion-path-movieclip-sheet, motion-path-camera-sheet, motion-path-ik-sheet, motion-path-ik-unpinned-sheet, motion-path-ik-pinned-sheet, motion-path-ik-followers-sheet, motion-path-ik-joined-sheet, motion-path-ik-joined-unpinned-sheet, motion-path-sticknodes-sheet |
| `joinTo`, `unjoinFigure`, `joinFigure`, `deleteSelection`, `deleteFigure`, `duplicateFigure`: the editor's `transaction`, a draft of the whole frame in which figures come and go; deleting with a movieclip instance selected leaves the cell as replacements by nothing (`sheetDeleteFigures`, `replaceAt`) | yes, on a layer sheet; not for several figures at once | figures-sheet, figures-layers-sheet, figure-clipboard-clip-sheet |
| Property edits on a layer sheet (`styk-edit/src/property_edit.rs`): `addAnimationKeys`, `addAnimationKey`, the sheet branches of `beginAnimationEdit`, `previewAnimationEdit`, `commitAnimationEdit` and `cancelAnimationEdit`, and the commands that reach `_sheetPropertyEntries` there: `setSceneColor`, `setSceneBackground`, `setBackgroundColor`, `updateFigureStyle` with property channels, `updatePolygon`'s opacity, `setVfxParameter`. Per tick, the frame there with the one-key channels the entries build composed (`styk_eval::records::Records::compose_channels`) is written as a key of each layer they touch, through the planner and `publish` (a held cell at its key unless auto key is on); a value left out is the one on show (`animationValue`, `Records::property_value`). A scrub's preview (`_sheetPropertyPreview`) is the frame on show until the edit ends; the session holds it the same way and its answer to `previewAnimationEdit` carries it, which the app compares and does not adopt. While an edit is open only its own calls run in the engine; undo and redo cancel it first. Owned with the class: what the commands publish is adopted, `beginAnimationEdit`, `previewAnimationEdit` and `cancelAnimationEdit` run in both and are compared (a key whose movieclip frames are replaced keeps its replacements, its pose written from the frame without them: `at(…, {skipMovieclipPatches})`, `Records::evaluated_options`) | yes, without fill styles and native timelines | property-scrub-sheet, property-autokey-sheet, property-keys-sheet, property-locked-sheet, scene-color-sheet, figure-style-sheet, polygon-opacity-sheet, vfx-parameter-sheet, property-clip-patches-sheet |
| Effects in a figure's, a segment's or the scene's stack on a layer sheet (`styk-edit/src/vfx_stack.rs`): `addVfx` (to one or several targets, scene effects on the scene only, no vignette on figures), `removeVfx`, `resetVfx`, `duplicateVfx`, `moveVfx`, `reorderVfx`, `pasteVfx` (the same effect replaced, another kind of the same identity under a new one, the scope set when given), each the stack keyed at the playhead through `addAnimationKeys`; new identities are the editor's (D18) | yes, including recorded presets, `setVfxScope` and pasting with attached parts | vfx-stack-sheet |
| Figures changed across frames (`styk-edit/src/range.rs`, `range_plan.rs`: `applyFigureRange`, `planFigureFrameOperation`): `updateFiguresInFrames` (colour override, transparency, opacity; an override drops a colour transition), `orderFiguresInFrames`, `joinFiguresInFrames`, `detachFiguresInFrames`, `deleteFiguresInFrames`, `duplicateInFrames` (joins kept among the copies), `mirrorFiguresInFrames`, `scaleFiguresInFrames` (an absolute scale keeps the figures' proportions; a zero scale collapses), `rotateFiguresInFrames`, `centerFiguresInFrames`, `resetPoseInFrames`, `addFigureInFrames`, and `moveSelectionInFrames` (`sheetMoveSelection`). Every frame of the range (the timeline's chosen ticks as the app passes them, keyframe starts, or the playhead) is planned on its evaluated frame; figures joined below a changed one are re-joined at their parent's handle (`jointEndpoints`: single precision, `styk-math`); one `_commitSheetRange` keys every layer whose figures changed at each tick (a held cell at its key unless auto key is on), or on a native timeline one `figure-range` entry patches the keyframes | yes, without movieclips among the changed figures on a native timeline (on a layer sheet a deletion with a movieclip among them leaves replacements by nothing, and a duplicated movieclip plays on the presence clock from its start), duplicating figures with effect clips (random identities), aligning (the app measures bounds with a function of its own), pasting across frames, and adding, duplicating or deleting across frames of a native timeline | range-appearance-sheet, range-appearance-colors-sheet, range-joins-sheet, range-transforms-sheet, range-autokey-sheet, range-locked-sheet, range-native, range-ik-pinned-sheet, range-ik-joined-sheet, range-ik-followers-sheet, range-movieclip-sheet, range-clip-sheet |
| Figure order: `bringToFront`, `sendToBack`, `moveSelectionLayer`, `orderSelection` on whole figures and `orderFiguresInFrames`, as depths (`_stykZIndex`) within each layer: reordered ties separated in the direction of the move, a run pushed past ±1,000,000 shifted back or numbered again | yes, with property channels or depths on show (always in the app); a partial selection of one figure orders its segments through `moveBuilderOrder` (below) | range-order-sheet, builder-order-sheet |
| Recolouring (`styk-edit/src/recolor.rs`): `editFigureColors`, `setFigureColor`, `replaceFigureColor` (with a whole figure selected, the colour looked up in the palette of the figure and those joined below it, `attachedFigurePalette`, and replaced in each figure that shows it), `resetFigureColors`, and `updatePolygon`'s colour on a figure on show (`mode: 'style'`): the instance's style overlay (`_stykStyle`) written as `recolorObject` writes it, from the colours on show (`resolveInstanceFigure`'s overlays, `displayedSegmentPaint`: overrides mixed in, a full override solid), gradient ends and paint stops, polygons and mesh colours; a reset samples the definition's paints; format 4's whole-figure colour switches the figure to its segments' colours; validated as `validateRecolor` does (palette targets, paints, refusing hidden or locked layers); through the range operation, so at the playhead or across a range | yes, without movieclips and the builder's segment styles (`updateBuilderSegmentStyle`) | recolor-sheet, recolor-format4-sheet, recolor-mesh-sheet, recolor-native |
| Flipping a branch: `mirrorSelection` and `mirrorFigure` with one figure's joint selected turn its segment over (angle and bend), figures joined below following; `mirrorFigure` on whole figures | yes; a selected branch and several selected segments stay with the editor (the facade, below) | range-branch-sheet, range-native, transform-native, range-transforms-sheet |
| The builder's segment styles (`styk-edit/src/builder.rs`): `updateBuilderSegmentStyle(patch, {branch})`, `updateSegmentStyle`, `updateSegmentBranchStyle`, `convertSegment` (a shape or the construction flag written into the definition with the raw flags following; colours, gradient ends and paints recoloured on the figure on show through `editFigureColors`, opacity and thickness keyed with property channels through `addAnimationKeys`, else written into the definition, a branch's polygons included), `setBranchCaps`, `setBranchFill`, `setPolygonOpacity` (keyed with property channels), `moveBuilderOrder` and `setBuilderOrder` (the figure's combined drawing order of segments and polygons, raised, lowered or placed alone or with a branch; keyed at the playhead as held keys after the preview's live event, as `beginBranchStyleAnimation` and `commitBranchStyleAnimation` do, or written into the definition without property channels; `orderSelection` on one segment of a figure reaches it), `updateFigureStyle` on the definition (a name, or the outline without property channels): one `native-properties` history entry of the paths changed (`applyPatch`), a `figure` entry for the figure's own style; definition edits compared in both editors, not adopted | yes; `changeBranchThickness` stays JavaScript | builder-styles-sheet, builder-styles-native, builder-styles-override-native, builder-order-sheet, builder-order-native |
| Rig relationships (`styk-edit/src/rig_behavior.rs`): `setRigBehavior` (stretch, follow, response, attachment, angle locks, angle paths, weighted joints and connectors merged into a joint; removing a driver's stretch releases its parts), `enableSmartStretch` (from the length on show, the branch below following), `setAngleLock` and `setSecondaryAngleReference` (measured on the figure on show, a parent lock walking past static parents, the authored angle for an authored lock), `bindStretchParts`: each validated as `rigConstraintPlan` validates a rig (`validate_rig`, every relationship's references and ranges and no joint depending on itself) and refusing to derive a joint an enabled IK controller drives; one `native-properties` history entry of the `_stykRig` fields changed; compared in both editors, not adopted | yes; Smart Stretch on a connector stays JavaScript | rig-behavior-sheet, rig-behavior-native, rig-behavior-ik-sheet |
| The figure's topology (`styk-edit/src/topology.rs`, `_topologyEdit`): `addSegment`, `addSegments` (a stroke from the selected joint, each segment taking its parent's colour and width as shown), `deleteSingleSegment` and `unsplitSegment` (the children taken by the parent; Ctrl+Delete refits them to the joints they reached, `fit` and `mergedBend` on `styk-math`), `deleteSegment` (with branches), `mirrorSegment`, `mirrorSegmentBranch`, `moveBuilderSegment` (every pose repacked in the new order), `splitBuilderSegments`, `splitSegment`, `splitSegmentBranch` (polygons gaining the midpoints, the pieces taking consecutive draw-order places), `duplicateSegment`, `duplicateSegmentBranch` (with the branch's polygons and renamed rig relationships), `addConnector`, `addWeightedJoint`, `replaceFigureDefinition` (the text editor's apply: each pose keeps its handles' offsets from the old definition). Every pose of the figure in the keyframes and pose sources follows; figures joined to a removed handle stay where they were drawn and those joined below a reshaped segment are placed again on its handle (`componentGeometry`, `canonicalizeChildren`); IK controllers (chains, followers), 3D shapes, style overlays, Stick Nodes shapes and effect owners follow their handles (`repairIKTopology`, `repairTopologyStyles`); the result is validated as `validateScene` validates what a topology edit can break (handles, numbers, hierarchy, rig, surfaces, poses, joins) and rolled back on a refusal; one `topology` history entry keeps the definition and the poses it touched, by identity, before and after; compared in both editors, not adopted | yes, animation-origin cases below; without frame drafts, IK across joined figures, saved channels a changed handle animates, pose choices, 3D meshes, drawing a new figure, drawing into a rigged figure and duplicating 3D joints | topology-sheet, topology-native, topology-joined-sheet, topology-joined-native, topology-ik-sheet, topology-followers-sheet, topology-rig-sheet, topology-vfx-sheet, topology-sticknodes-sheet, replace-definition-sheet, replace-definition-joined-native |
| Rig edits by dragging (`styk-edit/src/rig_drag.rs`): `beginRigDrag({reposition, bend, label})`, `editRigJoint(x, y, {stretch, isolate, reposition})` (a joint repositioned with its children refitted, its branch or the joint alone turned and stretched, through the rig's spaces with `authoredRigTarget`; an angle-locked joint stretched along its chord; a connector slid), `bendJoint` during a bend gesture (the branch turned with the joint, static joints included), `commitRigDrag` and `cancelRigDrag` (and `commitDrag`, `cancelDrag`, undo during one): the preview on the frame on show, then one `topology` entry changing the definition and every pose of it by the gesture's deltas (lengths by ratio), joined children placed again; compared in both editors, not adopted | yes, with the topology edits' limits | rig-drag-sheet, rig-drag-native, rig-drag-plain-sheet |
| Animation-origin whole figures (`styk-edit/src/origin.rs`): translation, rotation, scaling, reflection, reset and centre preserve the pivot, local offset and retained ghost support; begin/commit/cancel, returning to the start, fractional seeks and history follow native and authored sheet lifecycles. Stored arithmetic uses `styk-math`; the saved-channel calls below are admitted separately, and unrecorded origin command families still refuse atomically. | yes, these calls only; class remains unowned | origin-gestures-layout-native/sheet, origin-gestures-offsets-native/sheet, origin-gestures-support-native/sheet/autokey-sheet |
| Origin joints and handles (`styk-edit/src/origin.rs`, `pose.rs`, `figure_transform.rs`): pose, rotate and bend joints, Handle Edit Mode and whole-figure handle turns/scales synchronize retained ghosts once, preserving captured metadata, cancellation, fractional views and native/sheet history. Complex rig, pose-choice, mesh, drawing, movieclip and unrecorded IK branches refuse atomically. | yes, recorded calls only; class remains unowned | origin-pose-layout/offsets/support-native/sheet/autokey-sheet, origin-pose-support-free/pinned-native/sheet |
| Saved origin channels (`styk-edit/src/property_edit.rs`): begin/preview/commit/cancel animation edits and single/batch x/y/scale/rotation keys match both stored documents and the shown frame after every call. Admission inspects the actual target tick and attachment ancestors, including future definitions; absent post-exposure keys are admitted only for an already recorded ordinary target. Malformed joins and future rig targets refuse before changing live state. | yes, recorded calls only; class remains unowned | origin-channels-layout/offsets/support-sheet/autokey-sheet, origin-channels-saved-layout/support-sheet/autokey-sheet, origin-channels-future-sheet |
| Set Origin and recorded origin topology (`styk-edit/src/origin_topology.rs`): rerooting preserves the original animation basis, joined children, local offsets and reversed gradients; split/delete/add/reorder/duplicate/definition replacement remap and compact retained ghosts across all poses. The typed origin compiler validates support before committing a live gesture; malformed descriptors refuse atomically. `setOrigin` is shadowed through the topology facade, with no topology adoption or class flip. | yes, recorded calls only, without saved origin channels and other topology limits above | origin-reroot-new/layout/offsets/support-native/sheet; origin-topology-layout/offsets/support-native/sheet |
| `undo`, `redo` of what those record | yes | all of the above |
| everything else | no: `Unported` | |

Every ported call runs in both of the editor's modes:

- **On a layer sheet** (the app: every document): a gesture drafts the frame on show
  (`styk_eval::records`), changes the draft, and commits through the sheet planner: the
  layers whose figures changed get a key at the playhead (at the key of a held cell,
  unless auto key is on) holding a new pose source captured from the draft; imported
  keys whose span changed are frozen as poses first; one `layer-sheet` history entry
  records the sheet, the layers and the sources, and undo, redo and the collection of
  sources from a dropped redo branch follow the editor. A movieclip instance, which a
  key's frame replacement places, is edited in that replacement (re-captured in place);
  editing other figures of the layer bakes the replacement into the new pose. After a
  commit the draft stays on show until a seek, an edit or history invalidates it, as in
  the editor. Recorded in move-sheet, gestures-sheet, autokey-sheet, layers-sheet (two
  layers, a join across them, a held key, a multi-layer selection), locked-sheet
  (refusals and their cancel events), movieclip-sheet and movieclip-loose-sheet.
- **On a native timeline** (tools and tests): the keyframe at the playhead is edited in place.

A call answers `Unported`, and changes nothing, on documents with property channels on a
native timeline (a layer sheet's `legacyAnimation`, which every document opened in the app
has instead, is edited) or a movieclip source. On origin documents, the recorded
whole-figure, joint/handle, topology and saved x/y/scale/rotation channel calls are admitted;
ranges, joins and other unrecorded families still refuse before changing the gesture. Also refused: posing a joined 3D IK target and
configuring or turning IK targets across joined figures;
for poses on a drawing layer; for a replaced figure joined to one
outside its movieclip frame; and wherever the engine does not evaluate the frame as
records yet ([evaluation.md](evaluation.md)).

Inverse-kinematics controllers (`_stykIK`) are gated per call on the frame on show
(`styk-edit/src/ik.rs`). Controller targets move with their figure (`translateIKTargets`:
`moveSelection` with `movePins`, a duplicate's targets offset with it), and selection,
seeking and history run anywhere. Dragging the end of a limb moves a pinned target, or
solves an unpinned limb with `styk_eval::ik::solve_object` and bakes it (`poseIKTarget`).
Around pinned limbs, gestures read the solution geometry draws (`ik::solve_local`): a
pose edit bakes it first, turning a follower changes its offset, and every change
remembers the bend the limb is now solved with. Joined figures with IK are compiled into
one temporary skeleton (`styk_eval::ik::joined::Assembly`, which geometry uses too): a
gesture takes in the whole assembly, and followers in other figures are kept by their
identity (`joinedFollowers`). All of it matches the editor bit for bit. A call answers
`Unported` on a frame with a 3D controller and when posing a target of a figure in
perspective. Recorded in startup-sheet and startup-join-sheet (the document the app
starts with, alone and with a copy joined to a hand), ik-unpinned-sheet (a foot whose
branches follow the target, a three-bone chain that stretches, drags, a cancel, undo),
pinned-ik-sheet, ik-followers-sheet and ik-chains-sheet (pinned two-bone limbs, a foot
with followers, four-bone chains on Both and on one side), ik-joined-sheet and
ik-joined-unpinned-sheet (a shin's controller driving another figure's thigh, pinned and
free) and ik-joined-late-sheet (a foot joined after the controller was set).

What the facade must still account for before it calls the engine (none of it is a
document difference the harness can see):

- **Counters and settings the document does not carry**: the layer revision named by
  events, the number of the next pose source, the next figure identity, auto key, and
  the layer hints of the last published poses. The engine keeps them across its own
  calls; the facade hands them over when it starts from the editor's state
  (`set_counters`, `Options::auto_key`).
- **How many poses hold each figure** (`_layerUidCounts`, `_layerSeenUids`) decides
  whether a command adds one more layer revision (a figure appears or disappears
  altogether). The engine counts them from the document when first needed; the editor's
  set of figures *ever seen* can be larger after figures were deleted and collected.
- **Layer focus locks** are runtime state of the JavaScript editor: a focus lock refuses
  edits on the other layers. The facade starts no engine session while one is on, and
  changing the focus ends the current session (measured with the driver's focus step:
  without this, owned editing inserted a key the editor refuses on a locked layer).
- **Frame ranges**: on a layer sheet the app passes a timeline range as an array carrying the
  chosen ticks (`rangeFrames()`, `sheetTicks`), which JSON drops; the facade sends such arrays
  as `{"@array": [...], "sheetTicks": [...]}`, and recorded steps may spell them the same way
  (`engine/tools/edit-replay.mjs`). Found while porting the range commands: owned
  `setSceneColor` with a timeline range selected had keyed the playhead only.
- **Several selected segments** (`_segmentSelection`, `toggleSegment`): a branch flip turns them
  all over. As with a selected branch, the facade starts no session and ends the current one;
  both are checked again before every call, since undo can restore them.
- **A selected branch** (`_branchSelection`, `selectBranch`): commands act on the branch's
  segments instead of whole figures (`deleteSelection` deletes the branch). The facade starts
  no session while a branch is selected, and selecting one ends the current session
  (measured with the driver's branch step: without this, owned editing deleted the whole
  figure).
- **Records the editor changes in place** (a topology edit rewrites the figure and every
  pose of it, drawing edits name their figures): the mirror sees changes by identity, so the
  facade notes what the change events name (a definition edit: every figure; one that
  changes structure outside a sheet publication: every figure, keyframe and pose source)
  and resends it before the next session starts (measured: after deleting a branch in the
  editor, engine sessions posed the old pose arrays and adopting them failed the editor's
  validation).
- **The timeline's layer selection** (`_sheetSelection`, `styk-edit/src/select.rs`): the
  facade hands it over with every call, and the engine follows it as the editor does
  (`selectSheetLayer`, seeks selecting the layer's figures on show, `keepSelectionOnSeek`,
  any other selection dropping it, history restoring it with the selection).
- **`runtime_segments`** of legacy Pivot poses are read by the range operations (lengths and
  bends materialized before a transform, and by geometry): the facade keeps those calls in the
  editor for documents whose keyframes carry them.
- **`runtime_segments`** are not in the engine's copy (the mirror strips them). The
  editor's history snapshots keep them, so on a native timeline a gesture that moves a
  figure with `runtime_segments` and puts it back is a change in JavaScript and none in
  the engine. On a layer sheet a commit compares poses without them, as the engine does.
- **The history byte budget** (`historyBytes`) is not ported; the engine's history trims
  by count (80 entries) only. Phase 1 keeps the app's history in JavaScript.
- **Validation**: a published sheet is checked as `validateLayerSheetChanges` checks it
  (keys in order inside their layer's length, valid easing, poses that exist, the key
  counter), with the editor's errors; movieclip replacement records, the million-key
  limits, `validateObjectChanges` and `validateLayerState` are not ported.
- **Audio ripple** (`editor.audioRipple`): inserting or removing frames on every track
  also shifts audio in the editor; the facade runs those in JavaScript while it is on.

## Shadow editing in the app

With `?engineShadow=on` (or `localStorage['stykanimate.engine.shadowEdit'] = 'on'`) every
ported call the app makes also runs in the engine: `EngineHandle.edit_session` starts
`styk_edit::session::Session` on the mirrored document with the editor's view and
counters, `EditSession.call` answers each call as JSON (result, state, events, the
gesture's draft, and the sheet, layers and pose sources a command published), and
`src/engine/engine-edit-shadow.mjs` compares that with what the editor did. The editor
stays in charge; nothing from the engine is applied. A session lives while every change
to the document goes through calls it shadows; anything else ends it, and the next one
starts when the mirror holds the editor's revision again. Results accumulate in
`globalThis.__stykEditShadow`.

With `--exact-math` the driver replaces the page's `Math.sin`, `cos`, `atan2`, `hypot`,
`asin` and `acos` by the engine's (exported from the WebAssembly binding for this purpose,
`styk-wasm/src/math.rs`) before the document loads: the editor then computes what Node
computes, and the comparison is exact. This is how a difference is told from the browser's
own rounding: on the Kung-Fu Master and Karate Fighter rigs, dragging a free 3D foot
differed by up to 1.54 rad in 34 angles with Chromium's `Math` (a knee's side decided on a
nearly degenerate limb) and was identical with the engine's (95 of 95 calls on each rig,
measured 2026-10-03; also exact: the start-up document 94 of 94, a 3D catalogue scene 74 of
74, joined 55 of 55, the rigged document 78 of 78, sheet-movieclip-loose 78 of 78). With
the driver's 3D steps added (a planted knee dragged, a bone twisted with the right button,
the rig reset), measured the same day: the planted-leg fixture 140 of 140, the Kung-Fu
Master and Karate Fighter rigs 115 of 115 each, a 3D dojo prop 94 of 94.
With the driver's property steps (scrubs with their previews, keyed values, the scene's
colour and background, the figure's outline, an effect's parameter keyed and scrubbed),
measured 2026-10-04 with the engine's `Math`: the start-up document 211 of 211 calls the same,
the property calls among them (`beginAnimationEdit` 4, `previewAnimationEdit` 6,
`commitAnimationEdit` 3, `cancelAnimationEdit` 3, `addAnimationKeys` 2, `setSceneColor`,
`setBackgroundColor`, `setSceneBackground`, `updateFigureStyle` and `setVfxParameter` 1 each);
owned editing the same as the editor alone (106,877 bytes, 55 history entries, and after
undoing everything). The previews are compared: an engine composing a preview with the edit's
first value instead of its last was caught (2 previews different). On documents saved with
property channels (the channel fixtures as the app holds them), the same day: `channels-figure`
184 of 184 calls the same, owned editing the same as the editor alone (70,724 bytes, 46
history entries, and after undoing everything); `channels-pose` 152 of 152; `channels-vfx`
184 of 184.

With the driver's motion-path steps (trail points of the figure's origin, a joint and an IK hand
dragged at another tick, a falloff switched and changed mid-gesture, a cancelled one, and two
gestures made with the pointer on the shown trail, one with the right button), measured
2026-10-04 with the engine's `Math`: the start-up document 392 of 392 calls the same, among them
`beginMotionPathEdit` 8, `updateMotionPathEdit` 33, `commitMotionPathEdit` 7,
`setMotionPathFalloff` 2 and `cancelMotionPathEdit` 1; owned editing (one round) the same as the
editor alone (290,090 bytes, 80 history entries, and after undoing everything) with the 7 commits
adopted, and warmed up (`--warm`) the same again.

`node scripts/engine-edit-shadow.mjs [--file <document.json>]` drives the real app in
headless Chromium: pointer drags on joint handles and on the origin, keyboard undo and
redo, transforms, timeline keys and frames, duplicate/join/unjoin/delete, motion-path trail
points (through the editor, and with the pointer on the shown trail), on a figure with
3D bones a planted knee, a right-button twist and resetting the rig, and on a rig with pose
choices another choice. Measured
2026-10-03 (WebAssembly, SwiftShader), one run each:

| Document | Calls run in the engine | The same as the editor | Different | Editor time | Engine time |
| --- | ---: | ---: | ---: | ---: | ---: |
| joined-chain (imported, joined figures) | 77 | 77 | 0 | 57.7 ms | 28.2 ms |
| sheet-layers (two layers, held key) | 77 | 77 | 0 | 59.9 ms | 30.2 ms |
| sheet-movieclip-loose (a movieclip) | 77 | 77 | 0 | 62.6 ms | 30.6 ms |
| sheet-mixed-keys (imported and authored keys) | 77 | 77 | 0 | 57.9 ms | 27.8 ms |
| the document the app starts with (unpinned IK on every limb) | 77 | 77 | 0 | 174.0 ms | 81.7 ms |
| startup-pinned (every limb pinned) | 88 | 88 | 0 | 167.1 ms | 100.0 ms |
| followers (a pinned foot with followers and a polygon) | 88 | 88 | 0 | 181.5 ms | 93.3 ms |
| joined (IK across four joined figures) | 54 | 54 | 0 | 71.4 ms | 43.9 ms |

"The same" means equal keys, order, strings and integers, and numbers within 1e-9
relative: 28 to 53 of the 77 calls differ from Chromium's editor in the last digits of a
pose, because Chromium's `Math` is not Node's ([D16](decisions/0016-v8-exact-math.md)).
The engine time includes the JSON boundary. The IK documents were measured 2026-10-03
after IK editing was ported, joined figures included: every call the script makes runs in
the engine (on joined, two undos reach history from before the session, which ends it and
starts the next). Their times include a duplicate, join and unjoin that each re-evaluate
the frame with IK.

### Replaying an app session natively

With `?engineEditCapture=on` (or `localStorage['stykanimate.engine.editCapture'] = 'on'`) the
facade keeps each session's starting document and state and every call it sends (name,
arguments and the view, draws included); the first eight sessions to meet an unported call,
a difference or another error are kept in `__stykEditShadow.captures`, one per reason.
`node scripts/engine-edit-shadow.mjs … --capture <folder>` writes them as
`<run>-<n>.capture.json`, and `styk edit-session <file>` replays one in `styk-edit` natively,
printing each answer's status, so a refusal or difference met in the app can be debugged
without the browser. The first one found this way (2026-10-04): `setNodeIK` on any figure
but the first refused with "posing an IK target outside the frame", because the limb was
captured from the native keyframe, which on a layer sheet holds fewer figures than the frame
on show (`ik-settings-second-figure-sheet`).

## Values the editor draws at random (D18)

Commands that draw identities or seeds draw them through `src/editor-draws.mjs`. The recorder
(`engine/tools/edit-replay.mjs`) draws a fixed sequence (identities `d0d0d0d0-0000-4000-8000-…`)
and stores each step's draws as `draws: [[kind, value], …]`; the replay hands them to the
engine before the step (`Editor::set_draws`), and a port takes them in order and by kind
(`draw_uuid`, `draw_seed`, `draw_random`), answering `Unported` when it would draw what it was
not handed. In the app the facade records what the editor drew during its run of the call and
sends it in the call's view; such calls run in both and are compared, never owned.

## Engine-owned editing in the app

The engine runs ported calls in the editor's place while a session lives (the same
`src/engine/engine-edit-shadow.mjs`): by default for documents of an editing class in
`OWNED_CLASSES` (D15: a class flips after exact behavior and the current class-cost
gate below pass), for every document with `?engineEdit=on` (or
`localStorage['stykanimate.engine.ownEdit'] = 'on'`), and never with `off`; `?engineShadow=on`
keeps the editor in charge and compares. `editingClass(report)` names a document's class:
`unported` for classes whose full editing coverage is not yet established (property
channels on a native timeline, animation origins, a captured movieclip's own document;
the engine draws them). Origin whole-figure calls can be compared or forced through the
recorded whitelist, and the topology calls can be compared in shadow; their class has
not flipped (D15).
`channels` for documents whose layer sheet keeps saved property channels (`legacyAnimation`,
edited since 2026-10-04; not owned by default: on `channels-figure` owned editing cost
289.3 ms against the editor's 116.9 ms in one run, and large documents are not measured),
`movieclips` when a
figure is a movieclip, `3d` when a figure has 3D bones or a mesh,
`large figures` from 1,000 segments across its figure definitions, else `figures`. The
calls that change the document
(the gestures' moves, poses and transforms, `commitDrag`, the layer timeline's keys and
frames, joining, duplicating and deleting figures) run in the engine only; the editor
adopts what they produced and does not compute it:

- a gesture's draft: the engine's figures replace the editor's in its draft, and the
  editor's snapshots take in the figures the engine's gesture took in (`drag` in the
  answer: their identities and whether the gesture moves whole connected figures);
- what a call published: `adoptLayerSheet` (src/editor-layer-sheet.mjs) runs the editor's
  own `publish` on a plan made of the engine's sheet, layers and new pose sources, so
  validation, layer bookkeeping, events and the history entry are the editor's. The answer
  carries only the tracks the call replaced (`trackOrder` names them all); the others stay
  the editor's objects, shared with history as before;
- a committed gesture's draft stays on show as in `_commitSheetPose`
  (`_authoredCommitPreview`): the answer carries its figures (`retained`), as the commit
  leaves them (joined figures' roots refreshed from geometry), in place of the editor's
  draft or, for a gesture the call began and ended itself, of the frame it showed;
- the selection, the next figure identity, the live-edit events and a seek the call made.

Owned calls request `changesOnly: true` in the existing session view. The response
contains only changed COW draft/retained figures and sheet fields, with explicit order,
removal and retained-frame metadata when needed. The facade reconstructs the publication
from its current records, preserving untouched identities and runtime movieclip samples.
Full responses remain the default for shadow comparison and native session consumers;
public Rust signatures are unchanged. Eighteen recorded families / 483 native calls and
18 JavaScript adoption tests compare the compact and full paths. The actual origin app
run adopts 62 calls and compares 65 exactly, with document/history/selection/full undo
identical. The startup app retry adopts 165 and compares 295 exactly, preserving its
290,105-byte document, 80 history entries, selection and full undo. This protocol change
does not open another document class.

Selecting, seeking, starting and cancelling a gesture, and undo and redo run in both and are
compared as in shadow mode (history stays the editor's). A motion-path gesture's begin, pointer
moves, falloff changes and cancel run in both too, since the app draws the live trail from the
editor's session (`motionPathReport`, its display frame); its commit is owned: the editor
adopts what it publishes and ends its own session (a commit that changed nothing ends it too). Commands the timeline groups into one history entry
(`movieclipBatch`) run their ported calls through the session, then the batch's own event ends
it, and undoing the batch ends the next one (history the session did not record); measured
with the driver's batch step, owned editing still matches the editor alone. A call the engine refuses, or whose
answer the editor cannot adopt, runs in the editor alone and ends the session; an error runs
the editor's call so that the editor raises it with its message. If the engine itself fails a call (it
throws), the editor runs it and engine sessions stop for the rest of the page. In shadow mode the answer's
unchanged tracks are checked to be the editor's unchanged objects.

`node scripts/engine-edit-shadow.mjs --own [--file <document.json> | --import <file.piv>]`
runs the same interactions twice, with the editor alone and with the engine owning, and
compares the documents, the history labels and the selection after them and after undoing
everything. Numbers may differ in their last digits ([D16](decisions/0016-v8-exact-math.md)):
the engine computes with Node's `Math`, the browser's editor with Chromium's. Measured
2026-10-03, headless Chromium:

| Document | Calls adopted from the engine | Same as the editor alone | Numbers differing in last digits |
| --- | ---: | --- | ---: |
| the document the app starts with | 54 | yes (32,872 bytes, 13 history entries) | 31 |
| startup-pinned | 65 | yes | 43 |
| followers | 65 | yes | 76 |
| joined (four joined figures with IK) | 39 | yes | 38 |
| joined-chain | 54 | yes | 50 |
| sheet-layers | 54 | yes | 80 |
| sheet-movieclip-loose | 54 | yes | 28 |
| AyameDemo.piv, imported (48.7 MB document) | 55 | yes (10 history entries) | 996 |

Two adoption defects were found this way and fixed: on AyameDemo the committed draft the
editor keeps on show was dropped, so the next gesture began from a fresh evaluation
(another figure slot and keyframe index); on joined-chain the kept draft lacked the joined
roots the commit refreshes, so the next gesture began with a joined figure 13 px away.

### Which classes the engine edits by default

For `figures`, `movieclips` and `channels`, the full paired cost gate is
`C <= 1.05 × J` **or** `(C − J) / N <= 0.1 ms`. `C` includes owned/adoption,
eligible JS fallback and failed attempts once; `J` is editor-alone cost and
`N = min(candidate.report.calls, editorAlone.report.calls)` for the complete timed
workload, not only eligible calls. Full report counts may differ; eligible method
counts and exact document/history/selection/full undo must match. A matching class
checkpoint and positive actual default pose/move/commit adoption are also required.
D13 is unchanged. `figures` is owned by default since 2026-10-05, alongside
`large figures` and `3d`. Its three B14 excess averages are 0.047679/0.067983/0.071809 ms
per conservative full timed call, passing the absolute-average arm. The committed
engine checkpoint and final focused gate checks pass. Actual default startup/rig/joined
runs each report31 owned/15 compared/46 calls with positive Native pose/move/commit
clocks and exact document/history/selection/full undo; their short timings are admission
proof only. Movieclips is owned by default on both original layer-sheet inputs. Full costs
246.210/228.600 and 202.875/176.945 ms candidate/JS pass the same rule at
0.042332/0.076041 ms excess over 416/341 conservative full calls. The committed
`379c2dbb` engine checkpoint and 87 focused final gate tests/Main check pass. Actual
default sheet/loose runs report 18/31 owned and positive Native pose/move/commit clocks
with exact document/history/selection/full undo; method counts include fallback and
short smoke timings prove admission only. Playback comparison, worker-only
conversion/Bake and native/source/origin exclusions remain unchanged. The prior channels full measurement costs 226.105/179.890 ms and 0.133569 ms
excess per 346 paired full calls fail both user arms despite exact behavior/accounting.
The measured gap to the per-call arm is 11.615 ms. Focused 129 JS/17 recordings/303
calls and the matching 39d9 engine checkpoint pass (849 native, two existing ignored,
64 stages/60 unchanged generators/358 containers). The class patch is unapplied,
default admission has not run, and native/source/origin exclusions are unchanged. The verified source-sampling fix shares successful imported frames once per source time
within one layer-sheet sampling call, using the original sampler across scene, camera,
layers and mixed imported endpoints. The lookup is cleared per call and failed reads
are not retained; focused count/output controls pass 3→1. This targets channels cost,
but the fresh full run still fails at 233.630/174.045 ms and 0.172211 ms excess per full
call, with a 24.985 ms gap to the per-call arm. Exact behavior matches; no causal total
speed, class opening, default, new checkpoint or API/stored-math/public-state claim.
The same-layer guard skips only an identical raw active-layer string before report
copy-on-write. Selection and restoration keep their current preparation/evaluated
frame; missing, null, nonstring and different IDs retain original writes, events,
results and history. Both new controls and 226 Rust tests / 53 recordings / 2,060
exact calls pass, alongside 125 JS tests and Main check. Fresh full cost remains above
the rule at 224.030/181.885 ms and 0.121806 ms excess/call, leaving 7.545 ms. Channels
stays closed; no matching new checkpoint/default or causal speed claim. Public APIs
and stored arithmetic are unchanged.

Source cleanup now ends before history sheet scans when current references or
flattened history capture IDs already cover every generated source. Otherwise the
original retention readers and removal order run. Undo/redo, imported sources, frame
identity and history behavior are unchanged. Both recorded controls and 92 focused
Rust tests pass, as do 53 recordings / 2,060 exact calls, 125 JS tests and Main check.
Fresh full cost is 240.965/176.585 ms with 0.186069 ms excess per call, leaving
29.780 ms to the per-call arm; both cost arms fail. Channels stays closed, with no
matching new checkpoint/default or causal speed claim. APIs, schema and stored
arithmetic are unchanged; mobile needs no adaptation.

Successful isolated one-shot move adoption now publishes the original moved authored
copy-on-write frame and preserves ready or pending scoped geometry. Complex/joined
fallback, events, document/history/selection/full undo and Rust/Wasm APIs are unchanged.
All 128 JS tests, Main check and seven recordings / 158 calls pass. The
original full paired cost is 369.790/352.875 ms, passing both user arms at 4.793% and
0.048887 ms excess per call. This loaded result establishes no causal speed gain;
channels remains closed pending matching checkpoint and actual default adoption.
Channels is owned by default after its original full paired cost, matching committed
c4c580de engine checkpoint and actual cold default adoption pass. Full cost is
369.790/352.875 ms, passing both user arms at 4.793% and 0.048887 ms excess per full
call. The checkpoint passes 856 native tests (two existing ignored), 64 stages and
358 containers; 132 final JS tests, four recordings / 94 exact calls and Main check
pass. Cold default classes mode reports 31 owned / 15 compared / 46 calls, positive
Native pose/move/commit clocks and exact document/history/selection/full undo.
Method counts include fallback; its short timings prove admission only. Native/source/
origin exclusions, APIs, stored arithmetic, shipping and D13 are unchanged.
Historical measurements below retain their original
rule and outcomes.

`large figures` since 2026-10-03. `node scripts/engine-edit-shadow.mjs --own --default`
runs the shadow driver's interactions with the editor alone, then with the app as users get
it; on large figure documents the engine owned every call it could and cost less in total,
in every run (headless Chromium, the machine under other load, two rounds):

| Document | Calls owned | Editor alone | Engine owning, adoption included | Same document, history and selection |
| --- | ---: | ---: | ---: | --- |
| 20 figures of 200 segments | 54 | 163.2 ms, 213.6 ms | 100.1 ms, 175.8 ms | yes |
| AyameDemo.piv (537 figure definitions, 6,854 segments) | 54 | 946.7 ms, 1,171.2 ms | 757.7 ms, 801.8 ms | yes |

**Earlier figures measurements (class closed at capture):**

`figures` stays with the editor: on the document the app starts with, the same run cost
87.8 ms owned against 76.8 ms alone, a pose about 0.31 ms in the engine plus 0.49 ms to adopt
its answer against the editor's 0.58 ms for the whole call (medians of 48 in the app; the
answer crosses the JSON boundary and the editor's own events and caches still run). Warmed
up (`--warm`: the interactions once untimed, then timed, since the browser optimizes hot
WebAssembly after its first calls: session calls measured in one page went from 0.24 to
0.09–0.13 ms a pose), small figure documents still cost more owned: the start document 66.1
against 50.5 ms, rig 123.3 against 50.9 ms, joined-chain 75.1 against 46.1 ms (startup-pinned
95.3 against 260.2 ms). The editor computes a pose of a ten-segment figure in about 0.07 ms;
the engine's call (0.25–0.35 ms in the app) and the adoption of its answer cannot get below
that while both editors keep their own bookkeeping, so small documents wait for the engine
to own the document outright (S5, phases 2 and 3). Running the animation while calling the
session did not slow the calls (the engine's worker threads do not contend with it).

`3d` flipped on 2026-10-04: with every 3D command and gesture the shadow driver drives ported,
owned editing was the same as the editor alone and cost less on each 3D document measured
(`node scripts/engine-edit-shadow.mjs --own --warm --exact-math`, one run each, the machine
under other load):

| Document | Calls owned | Editor alone | Engine owning, adoption included |
| --- | ---: | ---: | ---: |
| a planted 3D leg (ik/spatial) | 97 | 217.6 ms | 101.5 ms |
| Kung-Fu Master (81 segments, 3D, IK; imported) | 100 | 510.1 ms | 228.9 ms |
| Hand-Right (3D hand; imported) | 110 | 513.4 ms | 480.3 ms |

With the browser's own `Math` instead of the engine's, an owned 3D pose can differ from the
editor's by more than its last digits (one angle of the planted leg by 4.6e-6 rad after a
drag): the 3D solvers iterate on values the browser rounds differently (D16); the engine's
answer is the same in every browser. `movieclips` stays with the editor: every call the driver
makes on the movieclip documents now runs in the engine (229 of 229 the same), but these small
documents cost more owned, as small figure documents do (sheet-movieclip 433.9 ms against
299.4, sheet-movieclip-loose 528.3 against 337.4, owned the same as the editor alone).

What the same calls cost on AyameDemo.piv (one run each; the editor's time from a shadow
run, the engine's from an owned run, adoption included). The first measurement found
`poseJoint` at 200.6 ms; the causes were fixed: a rotation's targets were found with list
membership tests (quadratic in the figure's 515 segments) and on every call, each angle was
changed by unpacking and repacking the whole angle array, every evaluation scanned the
document for 3D, and every call drew the whole frame. Sessions now also start from the
mirror's prepared document instead of converting it again.

| Call | Calls | Editor | Engine | Adoption |
| --- | ---: | ---: | ---: | ---: |
| `poseJoint` (pointer drags) | 36 | 25.3 ms | 56.1 ms | 15.9 ms |
| `moveSelection` | 3 | 10.2 ms | 17.0 ms | 8.0 ms |
| `sheetInsertFrames` | 1 | 393.3 ms | 359.6 ms | 70.8 ms |
| `duplicateFigure`, `joinTo`, `unjoinFigure`, `deleteSelection` | 4 | 365.9 ms | about 100 ms | about 40 ms |

All owned calls together: 899 ms against the editor's 898 ms. Those whole-run totals mix in
the session's first call (about 6 ms once, while the browser compiles the engine's code to
its fast tier) and the load of the machine, so the costs were then measured call by call.

`node scripts/engine-edit-cost.mjs <file>...` (headless Chromium, the same document,
figure and joint): four drags of 15 pointer moves, the first not counted, through an edit
session as engine-owned editing calls it (the answer parsed) and through the editor (the
time its change listeners take subtracted: both pay it). Adopting a pose answer adds about
0.05 ms. Medians, 2026-10-03, after two fixes found this way: publishing a gesture matched
each key of a layer against every earlier key (quadratic in a layer's keys), and the
document's typed views re-read every style overlay after each commit (AyameDemo's commit
was 7.7 ms in WebAssembly, and natively 12.7 to 13.0 ms against 1.5 to 1.7 ms after, in
interleaved runs of `styk edit-bench`):

| Document | Class | Pose: editor | Pose: engine | Commit: editor | Commit: engine |
| --- | --- | ---: | ---: | ---: | ---: |
| the document the app starts with (10 segments, unpinned IK) | figures | 0.325 ms | 0.16 ms | 0.81 ms | 0.22 ms |
| rig (connectors, angle locks) | figures | 0.19 ms | 0.065 ms | 0.58 ms | 0.115 ms |
| joined-chain (three joined figures) | figures | 0.22 ms | 0.075 ms | 0.68 ms | 0.185 ms |
| 20 figures of 200 segments | figures | 0.36 ms | 0.23 ms | 4.02 ms | 1.915 ms |
| AyameDemo.piv (105 figures, largest 699 segments) | figures | 1.59 ms | 0.835 ms | 3.1 ms | 2.69 ms |
| a planted 3D leg (ik/spatial) | 3d | 0.855 ms | 0.895 ms | 0.585 ms | 0.195 ms |
| Kung-Fu Master (81 segments, 3D, IK) | 3d | 1.66 ms | 0.74 ms | 0.5 ms | 0.25 ms |
| Hand-and-Face Talk and React (6 figures) | 3d | 1.985 ms | 1.31 ms | 0.055 ms | 0.115 ms |

Figures of 10 to 800 segments (synthetic trees, one figure) measured the same way: poses
0.07 to 0.235 ms in the engine against 0.185 to 0.93 ms, commits 0.11 to 0.44 ms against
0.52 to 1.36 ms.

## What a gesture costs in the engine

`styk edit-bench <report.json> <uid> <tick>` times a gesture in `styk-edit` on a loaded
report. Native build, one run each while the machine was busy with other work
(2026-10-03), on Pivot imports of about 100 MB of JSON:

| | hitoshi vs suzu tomiee ssj (256 keys, 75 figures on show) | AyameDemo (617 keys, 2 figures on show) |
| --- | --- | --- |
| First call on a document (typed views of all of it) | 102 ms | 68 ms |
| Begin a gesture (evaluate the frame as records) | 2.5–6.2 ms | 2.6–6.0 ms |
| A move step | 0.01 ms | under 0.01 ms |
| A joint-pose step (geometry of the draft) | 0.56 ms | 0.03 ms |
| Commit (planner, capture, history) | 1.8–2.7 ms | 7.3–7.5 ms |
| Undo | 6.1 ms | 5.2 ms |

The same tool on AyameDemo as the app holds it after import (its layer sheet, 105 figures
on show, uid 9043 with 515 segments at tick 734), after the fixes above: a joint-pose step
median 0.39 ms (8.42 ms before: also the drag's cached rotation targets, as the editor's
`_drag.rotationTargets`, and the geometry of the posed figure and those it hangs from only,
`geometry::build_only`), a move step 0.02 ms, commits 5.0–9.0 ms, undo 2.1 ms.

Not measured: WebAssembly, and the boundary (arguments in, changed records out).

## Arithmetic

A ported command must round every stored result as the editor does. The platform's
maths library does not: against V8 on two million inputs, Rust's `f64::sin` differed in
the last bit 2.7 % of the time and `f64::atan2` 17 %; even the `libm` crate (musl)
differed for 0.8 % of sines and 0.7 % of cosines, in fdlibm's cosine kernel, and for `atan2` beyond
|y/x| = 2^60. `styk-math` ports V8's fdlibm 5.3 `sin`, `cos` and `atan2` and its
`hypot`; on 2.8 million inputs (random angles, tiny and huge values up to 1e308, every
n·π/2 up to 64 and its neighbours, special values) it returned V8's bits every time.
`engine/tools/math-fixtures.mjs` records the regression set its tests use.

## Connected-figure selection in the Rust command API (2026-10-23)

`Editor::call` and `Session::call` accept `selectConnected(uid, {add, candidates})`.
Omitting `uid` uses the active selection; an explicit null or unknown UID leaves
selection unchanged. The command walks joins in both directions with a visited
set, then filters candidates, so an excluded intermediate figure does not break
connectivity. `add` preserves existing selection order before appending eligible
component members in document-slot order. The requested UID remains active when
selected, otherwise the last selected UID becomes active. Repeating an unchanged
selection emits no event; selecting a component clears joint/branch selection.
No document records or history entries are changed.

The port is available to native and WebAssembly Session callers after rebuilding;
the app's existing JavaScript selection routing and layer-focus handling remain
unchanged. Documents excluded by the existing document gates remain excluded.
Non-array candidate transport refuses atomically so the caller can use its
existing fallback. This addition does not open any app ownership gate.

`engine/tools/edit-scenarios-connected-selection.mjs` generates three scenarios,
registered by `edit-scenarios.mjs`. Their 81 steps cover native, sheet and auto-key
sheet selection, add/filter ordering, empty/missing targets, no-ops, branch/joint
reset and undo/redo. `tests/connected_selection.rs` in `styk-edit` checks those
recordings through direct commands and the Session API, plus cyclic/dangling or
invalid join targets and atomic refusal. Geometry/hit testing is not required.

## Phase 2: queries from the engine

Handle positions, picking, snapping, bounds, motion paths and inspector values
come from the engine (it already builds the edit frame's geometry,
`styk_engine::edit::EditScene`), so the interface no longer needs JavaScript
geometry. Then the JavaScript evaluation, geometry, IK, rig, movieclip and
effect-model modules have no callers and are deleted.

## Phase 3: the engine owns the document

Decision [D19](decisions/0019-engine-owns-the-document.md). One `styk-edit` session per
open document holds the document and its history; `src/engine/engine-owner.mjs` installs
it on the editor (`?engineOwner=on` while it is verified in the app; the shadow above is
the default until then).

- **Calls.** Every public editor method except queries, view calls (selecting, seeking)
  and lifecycle runs in the session. Its answer (`patch: true`) carries the document patch
  (`styk_edit::patch`, copy-on-write identity diff), the state, the gesture and its draft,
  the retained frame and the change events. The owner applies the patch to `editor.report`
  copy-on-write (`src/engine/engine-patch.mjs`), refreshes what the editor derives from the
  records (layer index, frame index, caches), sets selection and counters, mirrors the
  gesture into `_drag`/`_authoredPoseEdit` and re-emits the events.
- **Property and effect-clip edits.** `beginAnimationEdit`…`cancelAnimationEdit` and
  `beginVfxClipEdit`…`cancelVfxClipEdit` run in the session. Every answer carries `vfxEdit`
  (whether an effect-clip edit is open) and `animationEdit` (`null`, or the open edit's
  `changed` and, on a layer sheet, its `value`; the call that opens it adds its target,
  property, tick and initial value). The owner shows them as the editor's own records
  (`_vfxClipEdit`, `_animationEdit`, marked `engine`), so the interface reads the same
  fields as before. The frame a layer sheet's edit previews is the answer's `previewChanges`
  (figures, order and fields that differ from the frame the edit began on) laid over the
  edit's frame, as `_sheetPropertyPreview`. Ending an edit that is not open answers false
  without asking the session.
- **Refusals.** A call the session refuses (`Unported`), a gesture whose live state the
  interface reads from the editor (motion paths, figure handles, rigs, camera drags, frame
  drafts) and an error the session raised without changing anything run in the editor on the
  read view. If the session holds a property or effect-clip edit then, the edit becomes the
  editor's own first (`@dropEdits`: the session forgets it, the mirrored record loses
  `engine`), so the editor's code ends or amends it as it would have its own. What they recorded becomes
  session history entries of kind `External` (`external.rs`): the session keeps their place,
  label, weight and the pose sources they keep alive, and on undo/redo answers `external
  history entry <id>`; the editor applies its own command (`_drawingHistoryReplay`) and
  the changed records are written back. Edits other modules make in place or through
  `editor._record` are written back the same way before the next call.
- **History.** Undo/redo are the session's. The editor's stacks mirror the session's
  (`depths`): its own commands for external entries, placeholders for native ones, so code
  that reads or amends the entry on top keeps working.
- **Start.** In the app the session starts on the stage's mirrored document (it reuses the
  stage's prepared views); `@shape` then brings key order and what the mirror leaves out
  (audio) to the read view exactly. History the editor recorded before the session started
  is taken over with `@externalStacks`. Sessions of documents open in other tabs are kept.
- **Legacy pose caches.** Pivot imports carry `runtime_segments` on every pose; the range
  operations materialize lengths and bends from it before dropping it, as the editor does.

Checks: `tests/engine-owner.test.mjs` replays every recorded tape (325) on the editor alone
and on an owned editor, from the exact document and from the mirror (there with the legacy
pose cache on every pose), comparing document,
selection, history and the frame on show after every step and after undoing everything,
with the session's document compared to the read view after every call.
`node scripts/engine-app-tape.mjs --owner <tape…>` does the same in the running app, and
`node scripts/engine-owner-cost.mjs <file>` measures the editing cost rule.
Known differences: the frame on show may lack the derived `object_count` the editor's
caches sometimes keep, and the internal `layerRevision` cache key can differ by one around
source pruning; neither is visible.

Still to come: the frame on show, handles and picking as engine queries (phase 2), the
remaining refusals ported, the stage committing the session's tree instead of the mirror,
and opening and saving through `styk-formats` and `styk-piv` directly.

## Invariants

- No commit leaves a command half-ported: a facade method calls the engine only
  when its replay scenarios pass.
- The JavaScript document and the engine's are identical after every command
  in phases 1 and 2 (checked in development builds by comparing the records a
  command touched).
- Interactive commands never send the whole document; a gesture's updates are
  the records it changes.

Recorded JSON is loaded by tests at runtime. Regeneration may rewrite byte-identical
files; embedding those files in test binaries made Cargo relink them needlessly. The
origin atomic-refusal tests now follow the same runtime-fixture policy as replays.

The remaining recorded origin range/join and 2D rig families now use the existing
range, pose and history owners. Sixty-three additional recordings match all 9,764
steps, including fractional shown frames, live commit/cancel and undo/redo; their
63 evaluated-record groups cover 647 ticks. Saved pose/handle/connector operations
admit only the recorded rig combinations. Unrecorded 3D, pose-choice and attachment
combinations remain explicit atomic refusals; recorded spatial choices are described below. `slideConnector` has a native command
entry but is not added to the app facade by this milestone.

Raw nested rig metadata is validated through `styk_eval::rig::validate_2d` before
origin commands can commit a live gesture. The compiler and editor record 102
malformed refusals and 27 accepted boundaries/unknown-field cases; inactive null,
false and zero connector metadata retain JavaScript truthiness. The native-frame
history carrier is `CommandKind::Frame {index, before, after, structural}`.

The recorded origin angle-lock definition lifecycle admits world, figure, parent,
off and secondary reference patches through the same raw validator, before a live
translation commits. Invalid proposed definitions retain the editor's recorded
commit-before-error behavior. Angle posing still uses the narrower world-only
gate; definition support does not admit figure/parent posing. Thirteen tapes match
2,158 steps, with 42 atomic malformed/complex guards and three actual-source mutants.

Spatial origin choices use the same typed basis, pose-choice and history owners.
Twenty-four tapes match 2,724 steps, covering visibility, channel presets, mixed
choices, six joined cases, retained support, a non-first origin handle, mirrors and
fractional reads. Admission permits one selected typed origin instance and ordinary
joined ancestors/followers; another spatial instance, native property channels,
saved/projection/IK/mechanical/mesh/skin/optional-metadata cases remain refused.
Raw definition validation is factored from the existing topology owner, retaining
the shared VFX owner remapper. Schema evidence covers five accepted and 26 rejected
editor loads; 57 command refusals are atomic and three source mutants are caught.
These tapes compare existing history flags/labels/undo-redo and shown frames at
every step, without claiming full enumerable command carriers or new full returns.
The 37 derived record groups cover 357 exact ticks; all 186 affected JSON regenerate
twice byte-stable. No public crate API, app adoption or class gate changes.

Inspector `animationValue` reads accept finite fractional playhead ticks and use
the existing shown-frame/channel sampler, including exact target scope. Stored key
times and property-edit begins still require whole ticks. The affected 93 command
recordings regenerate unchanged and match all 12,050 steps. Native scalar-channel
authoring, canonical worker readiness and document-class adoption remain separate
prerequisites.

Remaining effect commands use the existing stack/clip/history owners. Twelve recorded
scenarios / 392 exact steps cover all 13 built-in presets, saved-preset key identities
and timing, attached-scope depth 16 and refused depth 17, strict raw paint validation
and interpolated solid/gradient layouts. The facade shadows `applyVfxPreset`,
`setVfxScope`, `addVfxGroup` and `addVfxUserPreset`, handing over the editor's identity
and seed draws (D18). These methods retain their existing ownership policy. Focused
app comparison is 19/19 exact; existing paint-parameter adoption plus history/full
undo matches the editor. Command-class cost/readiness gates stay separate.

`Session::call_values(method, args, view)` is the platform-neutral typed entry to the
same response builder used by `Session::call`; it does not introduce another editor
or serializer. Tests compare 830 actual full/compact and malformed calls across 14
families. Worker publication and durable Session ownership remain separate work.

Ordinary joint shape reads use `geometry::build_joint_for_shape` through the same
Prepared/shown-frame conversion. Only the selected segment and its ancestors are
resolved; callers must neither render the returned Scene nor read other joints.
When the complete typed frame has no pinned controller, ordinary joined objects
also narrow their selected segments; every needed parent retains full numeric
geometry. Rich needed figures, pins, aliases or ambiguous segment topology retain
the full shape query.
Nonfinite or overflowing retained geometry retries the original whole-object loop,
preserving its previous-curve buffer behavior.
Only a frame without joins also borrows its sole selected slot directly instead
of constructing whole-frame join levels and filtered root lists. Joined queries
keep the complete topology traversal, ancestor construction and needed filters.
Figure resolution, warnings and original draw-order publication remain; omitted
slots stay unresolved and repeated slots publish once. The existing portable
query API now covers joined frames without pins; signatures and stored fields
are unchanged.

The Cache retains one coherent raw/typed frame pair. `Loader::edit_frame_reusing_ik`
reuses immutable parsed IK and warning-free effect tables only when their raw nodes,
slot UID/figure and Prepared lineage agree. Effect owner/entry and stack/effect counts,
plus the existing 16-effect limit, exclude every warning-producing parser path;
malformed or ambiguous effects reparse with the original ordered diagnostics.
Ordinary Object records with at most 64 fields may retain parsed nonpose fields
when the exact Shape and every raw nonpose node agree. Only angles, root coordinates
and scale may differ; changed fields use their original numeric/default conversion.
Rich or diagnostic-producing records keep full conversion. The unchanged wrapper
assigns sample/style metadata, and duplicate pose keys keep the existing lookup.
A failed conversion installs no new pair. The caller must supply the complete raw record represented by the
predecessor Frame from the current Loader/document lineage. These portable APIs do
not change stored fields, arithmetic or the Session response schema.

Active unpinned IK target edits retain the current call’s all-joint numeric geometry
through the existing `build_only_for_shape` owner. Context, capture and the complete
solved map read the same coordinates and angles; ordinary render items are omitted.
The default context route remains full, as do one-shot and pinned calls. Needed rich
figures and ancestors retain the shape owner’s full-output fallback, and joined graph
callbacks keep their separate complete scene. This private route changes no public
API, command admission, cache, stored arithmetic or response field.
