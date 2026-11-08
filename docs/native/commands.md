# Commands and shortcuts

K-cmd's registry and input-policy modules are independent of the reference slice. While that slice is still on its
branch, `styk-core/src/lib.rs` mounts `commands/registry.rs` as `command_registry`; it does not define a competing
`Command`, `CommandId`, `Effect`, `Msg` or application dispatcher. No screen is added by this chunk.

## Registry

`commands/registry/data.rs` is one metadata table for all 276 identifiers in inventory appendix A. Entries hold the
label key and numeric label parameters, glyph, category, search words, modes, requirements, toggle/destructive flags,
palette visibility, aliases, default shortcuts and history ownership. Alias hints reference the target entry; they
never introduce another keyboard binding. Scope precedence also removes hints claimed by a workspace-wide shortcut.

`Entry::availability` consumes cheap facts from the feature owners at the time of use. It does not cache document or
UI state, evaluate geometry or run a handler. Unknown handlers return `Disabled::NotAvailable`, a mode mismatch hides
the entry, and missing requirements fail closed. A feature handler remains responsible for its contextual preconditions
(for example, camera-clipboard readiness). History metadata describes the owning feature's transaction: no entry for
view state, one for a completed edit, one for a whole gesture, completion-owned for a dialog/session, or undo/redo.
The registry never creates a second session history.

## Input

`shortcuts::resolve` reads only the registry, in today's scope and hotkey declaration order, with exact matches before
the optional gesture Shift. `Mod` is portable key-map data (Control or Command). Desktop-only defaults and Command's
Control+Tab variant are preserved. The tests execute `src/hotkeys.mjs` on Windows with both modifier conventions;
they do not build or run another OS or the web app.

`Shortcuts::press` observes prevented events, IME provenance (including key 229), AltGraph, focus, Home and overlay
gates, polygon keyboard permissions and repeat rules. The focus snapshot carries an `InputRole` independently of
`TargetKind`: selects, checkboxes, radios and other inputs suppress editor shortcuts as text fields do; buttons do not.
Only checkbox/radio inputs permit the reference's `builder-*` commands in the builder scope (not every build command).
It reuses S2a's exact field-chord check. The four default shell field chords
are F6, Mod+F6, Mod+Alt+M and Mod+Alt+L, with exactly those modifiers. Shift+F6 remains Remove keyframes and cannot escape
a field. The capture path runs these four commands, including repeated events, before the ordinary repeat and command
gates; outside an input their regular repeat policy still applies. The capture path is off on Home and under overlays.
Both keyboard and native-menu routing read the same focused `HistoryOwner`; a VFX-owned input returns a typed
`FeatureHistory` route so its owner finishes the edit before undo/redo. Ordinary fields retain their own history.
With an active drag, an unmatched modified chord tries its unmodified Cancel binding after the input and overlay gates.
It returns `CancelDrag`, not the broader Cancel command, and never replaces a real modified binding.
Held keys release by their physical
key after modifiers or focus change; blur/teardown submits `release_all` as one terminal batch before accepting more
input. Refusal uses `reject` immediately: a fresh unaccepted start only clears its physical hold, while a refused
continuation returns the terminal cancellation of the already accepted hold. No unowned release is invented.

`shortcuts::native_route` keeps cut/copy/paste/select-all/undo/redo/delete with a focused text field, including a
dialog's own field, and preserves the VFX field-history override outside a dialog. A dialog blocks document commands.
This follows the executable native-menu handler even though the inventory's abbreviated description says “nothing”.

## Gesture barrier

`command_queue::GestureQueue` holds fixed-size `Invocation` records, never document data, callbacks or arbitrary
strings. The feature supplies its current `Activity`; the queue owns no second busy state. Actions wait for a gesture,
stroke, load, selection or operation to settle. Keyboard commands follow today's narrower selection-commit barrier;
Cancel and Play/Pan can reach their feature while it is busy. A queued command requests settlement rather than
blocking. The host drives settlement asynchronously and then calls `next`, at most one result per pump step, checking
the owners again before another dispatch. A new operation pauses the remaining FIFO.

The queue holds at most 256 records including its reserved terminal capacity. Admission receives the current
`Shortcuts::held()` snapshot, after the incoming input event. Reservations are recomputed from the records and that
snapshot: one slot for each physical key whose last queued held event is a press, plus held keys not already counted.
This covers both queued starts and already-live keys whose releases may have to wait behind another handle event.
There is no incrementally updated reservation counter. Saturation returns
`Submitted::Refused` with the original invocation and a warning key; callers must report it and roll back any admission
bookkeeping. Reserved slots keep every accepted hold's terminal admissible when full. A key released before its
queued press or repeat executes stays behind those events, using its reservation. Nothing silently drops a terminal.
The capacity is an explicit native admission bound, not a performance claim or a changed document limit.

The keyboard-handle owner supplies its live document in `Activity::keyboard_handles`. Its nudges and releases do not
wait on their own gesture: live continuations may pass unrelated waiting actions. Every `handle-*` press, repeat and
release stays in family FIFO order. `submit` can dispatch immediately only with no earlier queued handle event;
`next` considers only the first queued handle as a bypass candidate, then checks its document, owner and readiness.
A blocked repeat therefore blocks its later release, and a fresh direction cannot pass an older unstarted direction.
Other documents and drawing/load/operation barriers do not acquire the continuation exception.
The owner keeps its existing edit session open for all nudges and commits once on the final release; the queue never
starts, commits or splits history itself.

Every queued command is bound to its document identity. A different active document or failed settlement returns
`Next::Cancelled`, never an edit of another tab. The host keeps failed settlement in force until its affected queue
has been retired, and cancels held keys through the same terminal path before dropping the queue.

SH-012's action-wrapper polygon rule and the earlier keyboard rule are distinct in today's app. Registry entries
keep both: the wrapper permits its safe list and `zoom-*`/`toggle-*`; document switches cancel the draft first. A
refused action reports `app.finishOrCancelThePolygonFirst`. The keyboard's earlier list is narrower in some places
and broader in others (Save passes that list but its wrapped action still refuses). Do not merge these gates.

## Errors

`error_policy::classify` is shared by handler failures and asynchronous replies. Cancellation produces no notice.
A user precondition is a six-second warning, even during a save/export/import. Other save/export/import failures stay
until dismissed. Other failures are eight-second, dismissible errors. These durations come from `ui-toast.mjs` and
`app.mjs`; the host supplies timers, the core reads no clock. The slice's message key and scalar parameters must pass
through unchanged to its notice; external diagnostics remain verbatim. Logging/telemetry remain their owners' work.

## Reference-slice attachment

After the orchestrator announces the slice's merge, merge `native-app` once and attach this metadata to its
`CommandId::info` (including the implemented handler owner). Keep handlers in their feature modules. Extend its
`Effect::NotAvailable` to every unported entry, route the common command inlet through the queue and gates, and apply
the error policy to its notices. Do not keep the slice's small metadata match alongside this table. The four zoom
preset labels have no key in today's catalogue; `commands.zoomToPercent` with `{percent}` is reserved here for the
equivalent “Zoom to {percent}%” message when attaching to the slice's native localization catalogue.

`tests/commands.rs` reads appendix A and executes `tests/support/command-reference.mjs` against today's catalogues.
It checks all metadata and default shortcut cases, field modifiers, repeat and held-key behavior, requirements,
queue release/capacity/document identity, both polygon gates and each error outcome. Frozen fixtures are unchanged.
`tests/command_routing.rs` enters the production router/queue and executes the actual JS capture and bubble handlers
for control, VFX history, modified Cancel and repeat cases. Its live/queued nudge regressions use a real edit session
and verify that a single undo restores the gesture's baseline and a single redo restores its result.
`tests/command_queue_order.rs` covers overlapping operations, queued directions, full-queue refusal/cancellation and
live-key reservations. Its 2,000 seeded sequences of 60 steps use a separate admission/outcome ledger to check family
order, release ownership, capacity, terminal completion and reservations after each step, including document switches
and failed settlement. It never reads the queue's storage or uses its reservation implementation as the oracle.
