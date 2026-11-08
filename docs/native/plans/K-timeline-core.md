# K-timeline core: plan for review

Base: `native-app` / `origin/native-app` at `a4aa1e0c4f4d0dbe86d89d7cc652738f97bd8537`.
Step 1 only; implementation starts after the orchestrator returns Sol's plan check.

## Parts and inventory reconciliation

The [inventory](../INVENTORY.md) actually names `styk-core::timeline` on **78** feature rows, not 122.
This proposed **122-row planning ledger** includes those 78 plus **44 adjacent rows**: the other 30
`styk-ui::timeline` rows and 14 audio, playback and settings dependencies explicitly listed below.
Owners remain unchanged; all 78 direct rows occur once. Shared rows cover only the timeline's
contribution, not completion of their services or future views.

| Part, in implementation order | Direct timeline rows | Adjacent rows (existing owners retained) | Count |
| --- | --- | --- | ---: |
| **1. Document navigation and transport** | CA-055, IN-022, IN-030, ST-062, TL-001, TL-006, TL-007, TL-008, TL-009, TL-010, TL-011, TL-012, TL-017, TL-018, TL-019, TL-025, TL-036, TL-043, TL-049, TL-052, TL-053, TL-063, TL-067, TL-091, TL-101, TL-104 | CA-001, TL-048, TL-050, TL-058, TL-085, TL-086, TL-087, TL-088, TL-089, TL-090, TL-099, TL-103 | **38 (26 + 12)** |
| **2. Layer organization** | IN-039, TL-021, TL-022, TL-023, TL-024, TL-026, TL-027, TL-028, TL-029, TL-030, TL-031, TL-032, TL-051, TL-062, TL-100 | TL-020, TL-046 | **17 (15 + 2)** |
| **3. Frame edits and easing** | IN-034, IN-075, IN-076, IN-077, TL-004, TL-005, TL-037, TL-038, TL-040, TL-041, TL-042, TL-044, TL-054, TL-055, TL-061 | TL-034, TL-035, TL-039, TL-045, TL-060 | **20 (15 + 5)** |
| **4. Camera, effect and audio lanes** | CA-022, CA-034, CA-035, CA-036, CA-037, CA-038, CA-040, IN-102, IN-108, IN-109, IN-110, TL-092 | CA-031, CA-039, TL-068, TL-069, TL-070, TL-071, TL-072, TL-073, TL-075, TL-076, TL-077, TL-078, TL-079, TL-080, TL-081, TL-082, TL-083 | **29 (12 + 17)** |
| **5. Onion controls, view navigation and clip scopes** | CA-058, CA-060, CA-062, CA-063, CA-064, TL-013, TL-014, TL-015, TL-093, TL-094 | TL-002, TL-003, TL-016, TL-033, TL-047, TL-056, TL-057, TL-059 | **18 (10 + 8)** |

Part 1 supplies both modes' frame/layer models, cell/card/layer selection, Edit together integration,
seeking/scrubbing, first/previous/next/last/key navigation, Go to frame, FPS editing, playback limits,
looping, startup/buffering/pause and presentation feedback. Layers/folders/exposures are read-only;
frame edits, organization, thumbnails, full navigation geometry, specialized lanes, onion editing
and widgets follow later. Their unfinished actions remain explicitly unavailable.

## Part 1 ownership

Follow [patterns](../patterns.md), [documents](../documents.md), [commands](../commands.md),
[frames](../frames.md), [stage](../stage.md) and [audio](../audio.md).

- `documents::Documents` and each `styk-edit::Session` remain the sole document, history, figure
  selection, active-layer and playhead owners. Native ready reads replace the brief's JavaScript
  “patched read view”; no document mirror.
- Extend the existing `view_state::ViewState` with the canonical timeline cell/card selection
  (selected layer IDs, frame span/card indices). Keep Edit together there; adapt `range::Range`
  to consume it, preserving chosen-order ticks plus the playhead once. No second selected-ticks
  vector: contiguous spans stay compact. Anchors/pending pointer positions are interaction state.
- New `timeline::Panel` owns interaction state, drafts, mode-transition policy and revision-keyed
  plain models. `timeline::transport` owns play intent, temporary preview range, deadlines,
  startup/buffering and one pending scrub target. Requested/presented identities are demand metadata.
  Extend the stage demand/ready/presented seam; route its provisional `Event::Frame` and automation
  frame steps through the session playhead.
- K-frames owns preparation, lookahead, cancellation and caches; K-stage owns complete pictures and
  submission. S4's `AudioTransport` owns sound, decode jobs and stream clock. K-cmd owns registry,
  shortcuts, gesture queue and focus routing; K-dock owns panel placement. Reuse these owners.
- No general native settings owner exists at this base: introduce the minimal shared
  `styk_core::settings` record/service adapter for timeline preferences, using `Storage`, not a
  timeline-private file. Part 1 consumes effective auto-key/onion preferences; part 5 adds controls.
  `timeline::onion` will own only enabled state and an uncommitted preference patch; sampling stays
  in the engine. Search/filter/folder collapse belong to the panel; part 2 adds their actions using
  the session's focus-lock seam. The shared hidden-layer filter survives mode switches.

## Data flow, lifecycle and persistence

`Core::dispatch -> timeline -> answers::call -> Documents::call -> Session` is the edit path;
retain refusal events; long operations use the document lane. FPS uses `setFPS`; each edit/gesture
has one undo entry, cancellation none. Previews bind document/lineage/revision/target; every exit
settles the session. Scrubbing has no history; cancellation retains today's last accepted seek.

Refresh reads only ready session data. Document-sized row/scene-key projection and evaluated facts
run on the existing worker/facts lane, keyed by document **and lineage**, revision, relevant view
version and request identity; expose visible slices, disable stale controls. Mode switches finish
the shared lifecycle, pause and clear ranges/focus; refusals preserve mode/preference. Simple keeps
figure selection and navigates sheet key-time unions; Advanced allows beyond-end seeks without
adding frames. Playback limits clamp after timing/history changes. F6 remains focus navigation.

Scrub moves replace one pending target behind one preparation/submission; release retains its
exact final tick until accepted. Session playhead changes drive K-stage/K-frames requests.
Transport copies `app.mjs::play/pause/loop` and `playback-window.mjs`: startup runway, half-open
limits, no skipped frames or catch-up bursts, startup at range start when outside/at the end, raster
export gate, one-time optional fit, and audio stop/re-anchor on buffering or loop. Use S4's heard
position when running; Starting holds, device failure reports and falls back to injected application
time. Open the device on a service job. Recheck clock/generation at submission; a prepared picture
does not count as presented. K-stage keeps the last complete picture until the transport releases
the next current candidate and reports its submission. Readout updates have a 200 ms deadline;
idle has none. Wakes/deadlines use the application's injected clock/subscription.

Register timeline in the **shared** lifecycle before edits, history, save, mode/tab/scope changes,
close, quit and OS session end. Stop audio, retire only this owner's requests and settle previews;
Busy preserves the initiating intent for retry through the existing host, including close prompts.
Replacement resets transient state even if the tab ID survives; stale replies cannot restart
playback. No interface-thread worker joins.

Document bytes keep today's session/format path, including existing active-layer metadata, FPS,
unknown fields and legacy drafts; no new timeline fields. Settings persist `timelineMode` and
`loopPlayback` (which today's code saves), then auto-key, drop policy, fit and onion preferences as
their controls land. Storage merges only changed keys, preserves unknowns, rejects stale loads
over local edits and retains failed writes for retry; ordering stamps/writer identity follow the
existing storage/layout pattern. Ranges, selections, gestures, zoom, filters and playback intent
remain transient. Onion previews persist only on commit; seek/history/replacement cancels them.

## Commands, messages and view contract

Part 1 routes existing `Play`/`PlayPan`, `FirstFrame`, `PreviousFrame`, `NextFrame`,
`LastFrame`, `PreviousKeyframe`, `NextKeyframe`, `PreviousExposure`, `NextExposure`,
`ToggleLoop`, `TimelineLayerUp/Down` to the timeline handler. `ToggleRangeEdit` retains
ViewState ownership with timeline availability; `Undo/Redo` retain history ownership.
`SelectAll` and `Cancel` route by focused owner, preserving field history/IME and Space-pan behavior.

Add registry IDs `TimelineSimple`, `TimelineAdvanced`, `TimelineGoToFrame`,
`TimelinePlaybackRange`, `TimelineSetFps`, `TimelineSeek`, `TimelineSelectLayer`,
`TimelineSelectCell`, `TimelineSelectCard`, `TimelineScrub`. Their metadata uses existing
catalogue labels, animation category, timeline owner, document/mode/busy gates, no invented
shortcuts, and History::None except FPS (Edit); internal pointer actions are palette-hidden.
Parameterized `Command::Timeline(Event::Action { id, payload })` validates the same metadata and
routes to `Panel::update`; begin/update/end/cancel phases carry the same action ID.
Registry `Run(id)` opens parameter editors or executes the corresponding discrete action.
System events (wake, submission, audio/settings completion, viewport/lifecycle) also reach
`Core::dispatch -> timeline`, keyed by origin. Wire the real app handler/effects/subscription in
part 1. Later parts register local actions before exposing them; automation uses the same routes.

Views read engine-free `Clone + PartialEq` header/transport, visible layer/exposure/card and
selection models, with IDs, counts, ranges, pending/enabled reasons, `i18n::Label/Msg`, focus targets
and deadlines. They send action IDs, values/pointer phases/modifiers and viewport metrics only.
Inspector range controls share ViewState. Models/events also build with the engine feature off.

## Verification after the plan check

Through the T1 machine queue: targeted core/changed-crate tests, build, clippy and
`cargo xtask check`. Drive production dispatch, host effects and real wake delivery with injected
time; mutation-check each new wiring test. Cover both modes, selection/locks, exact scrub release,
range shrink, one-entry FPS edit/undo/redo, stale replies, startup/stall/loop/audio failure,
save/close Busy and replacement. Compare today's executable results and saved bytes after edits,
undo/redo and reopen, with an old-versus-old baseline first; only demonstrated baseline variability
may differ. Frozen fixtures and thresholds stay unchanged. No screenshot claim before views exist.

## Decisions

Reconcile 78 direct rows with 44 named dependencies rather than inventing ownership; use native
session ownership and executable sheet behavior over stale read-view/F6/draft descriptions.
Sequence navigation/transport before editing gestures; introduce one shared settings owner because
only Storage exists. Step 1 seeds via the prescribed script but builds/runs no app. The orchestrator
obtains Sol's review; this implementer stops after committing.
