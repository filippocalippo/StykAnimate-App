# Timeline core, part 1

The timeline views are a later chunk. This implements the navigation and transport contract in
[the approved plan](plans/K-timeline-core.md), including its Settings and geometry amendments.

## Ownership and API

- Read `Core::timeline().model()`: document/lineage/revision identity, readiness, session tick,
  duration/FPS, Simple cards, Advanced rows and visible exposures, canonical selections, geometry,
  playback range/state/readout and the requested parameter editor. Names use `Label`; refusals use `Msg`.
- Send `Command::Timeline(Event::Action { id, payload, now })` through `Core::dispatch`.
  The registry owns thirteen existing navigation/transport actions and ten new parameter/input IDs.
  Geometry events carry viewport and scroll positions. Cell/scrub payloads carry logical
  coordinates and modifiers; core calculates hits, visibility, reveal and scrub edge scrolling.
- A projection is accepted only for its complete document/lineage/revision key. Document-sized
  rows, key unions and audio metadata are derived on one worker; refresh copies visible slices.
  Immutable sparse selections share storage; contiguous selections stay spans. The existing
  Inspector range adapter expands them only when an actual range edit begins.
  Advanced spans derive Edit together targets on a separate single-flight worker: the first tick
  plus existing key times in selected layers. A revision/selection stamp rejects stale results;
  pending targets disable edits. The highlighted span never inserts a key at every held tick.
- The session remains the sole playhead, active layer, figure selection, document and history owner.
  Native `@timeline` batches (at most four whitelisted existing calls) run on Documents' exclusive
  worker, including seek/selection evaluation. `Core::poll_document()` consumes each answer through
  the existing answers adapter before requesting the accepted stage tick. FPS is one `setFPS` edit;
  navigation creates no history. Ready reads include the session's borrowed sheet selection.
- The shared lifecycle finishes Inspector previews, pauses transport, and retains a scrub's final
  target before history, editing, mode/tab/scope changes or document requests. Busy retains identity
  and payload. One deferred Core intent plus K-cmd's existing gesture queue have visible overflow
  refusals. Release/cancel events are retained; there is no second history or focus owner.

## Playback and host wiring

K-frames prepares lookahead. K-stage owns candidate pictures and acknowledges an encoded picture
at the following post-submit observation; readiness alone cannot advance playback. Tokens reject
superseded acknowledgements. No public timeline event lets a view claim submission.

Transport uses injected application time, half-open ranges, the reference startup runway, looping,
final-frame duration, no skipped frames and no catch-up burst. S4 supplies the heard audio position.
Preparation and device startup hold playback; sound starts/reanchors when the first, looped or
buffered picture is submitted. Delayed submission rechecks the audio clock. Device failure produces
a notice and uses silent pacing; decode/preparation failure stops playback, as today's app does.
Raster export pauses and gates playback. Fit and quality use loaded
settings; Automatic keeps today's thresholds and 50% floor. Executable app.mjs uses a **250 ms**
FPS readout interval (the original plan said 200 ms).

The app shares one coalesced Progress stream among document, timeline, settings, facts, audio and
stage workers. Core exposes deadlines; idle transport has none. Raw keys pass through K-cmd with
field/IME/overlay gates; Space release plays only when it did not pan. Existing stage widget input
and automation FPS edits use the same command path. App close first settles the new owners and
flushes settings. Once exit is accepted, commands and document requests stay fenced until window
teardown. Document save/close/quit requests use the same lifecycle barrier. Existing document
confirmation/file-picker UI and OS-session-end installation remain with document/app integration;
this core does not invent a second confirmation policy.

## Persistence and verification

See [Settings](settings.md). Document serialization retains today's session/format path with no
new timeline fields. A native session retains the single saved active-layer scalar until the next
document command: today's browser view selection is imported at that command boundary, while an
immediate export snapshots the previous session metadata. This compatibility normalization runs
on the save worker; the live playhead and selection still have one owner. Advanced mode also runs
the existing `disableFrameDrafts` command on the document lane.
The explicit save oracle first runs today's source twice, then compares every
byte of native startup/channel/drawing/Pivot saves across initial, edit, undo and redo, and reopens
them, including saves immediately after camera selection (32 native comparisons). No fields are
excluded. Public fixtures and frozen tapes remain untouched.

Tests: `timeline_core` (session edits, geometry, modes/ranges, timing and executable JS policies),
`settings_storage` (real transactional platform storage), `stage_surface` (real renderer ACK and
accepted session ticks), and the app's mounted-stage keyboard/production wake test. The latter
mounts the existing widget; it does not claim timeline views have been delivered. Wiring mutations
remove Core timeline/settings routing, physical-key translation, the production progress handler
and submission acknowledgement: each corresponding test must fail.
