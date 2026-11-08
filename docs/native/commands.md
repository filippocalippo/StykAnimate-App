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
gates, polygon keyboard permissions and repeat rules. It reuses S2a's `text_entry` gate. The only default field chords
are F6, Mod+F6, Mod+Alt+M and Mod+Alt+L, with exactly those modifiers. Shift+F6 remains Remove keyframes and cannot escape
a field. The resolved command must also be one of the four field-safe commands. Held keys release by their physical
key after modifiers or focus change; blur/teardown uses `release_all`. A refused start uses `reject` and dispatches its
terminal cancellation, so no held-key bookkeeping survives a refused submission.

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

The queue holds at most 256 records, with a release slot reserved for every queued held press. Saturation returns
`Submitted::Refused` with the original invocation and a warning key; callers must report it and roll back any admission
bookkeeping. Terminals of already live keys and Cancel still reach their owner when full. A key released before its
queued press executes is queued behind that press, using its reservation. Nothing silently drops a terminal event.
The capacity is an explicit native admission bound, not a performance claim or a changed document limit.

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
