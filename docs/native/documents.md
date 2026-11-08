# Native documents and engine host (K-doc)

`styk_core::documents::Documents` holds the tabs, each owning one `styk-edit::session::Session`.
The session owns the document, selection/playhead, gesture and history. There is no report mirror,
JSON patch or duplicate selection. During an exclusive worker handoff only the last accepted
revision and dirty scalars remain for tab chrome; the session is their sole editing authority.

Engine type re-exports live only in **`styk_core::engine`**: `Value`, `CallAnswer` (`NativeCall`),
`DocumentView` (`SessionView`), `EditError`, `Selection`, `OpenError`, `TypedDocument`, `Engine` and `Budgets`.
Core panel logic may name that module; views must not. Views receive plain view models and messages.
The native composition root installs `engine::Counting` and sets `engine::set_memory_limit` through
this boundary too; it does not depend directly on an engine crate. The document re-export guard has no exemption.
`documents` exposes the core's own document identities, owners, requests and effects.

## Preparing and installing a document

On an engine worker, `PreparedDocument::open_bytes(engine, bytes, name, cancel)` runs the existing
file reader and normalization. Bytes are an `Arc<[u8]>`; an imported Pivot original is attached to
the canonical tree without another byte buffer. `from_opened` accepts an engine open for new
documents and decoded imports. Both entries finish constructing the session on the worker, including
its indexes, reusing the prepared typed views. Only the small start options use the existing JSON
initializer; the document is never serialized again.

These are **synchronous worker preparation entries**, not interface-thread open commands.
`Documents::dispatch` schedules application opens and handles cancellation/stale replies. `Documents::open` only
moves the ready session into a tab beside the active one: no decode, normalization, evaluation,
publication or index construction. A refusal returns the prepared document for retry or worker disposal.

Initial selection and names follow `_publishLoadedReport`: select the first keyframe's first figure;
drop `.piv`, `.stk` or `.styk` case insensitively, then fall back to the stored name and `Untitled animation`.
A fresh session has revision/saved revision 1 and empty history. `PreparedDocument::set_clock` injects
the budgeted-read clock. The asynchronous application path additionally follows `acceptImport`: Pivot
opens at the last frame unless it stored a draft, all supported import extensions are removed from
the name, and repairs mark the session dirty. The milestone-1 preparation defaults remain unchanged.

## Commands and reads

Panel **logic in the core** uses these names; a view displays its plain-data model and sends messages.

| API | Contract |
| --- | --- |
| `Documents::tabs`, `active`, `get(id)` | Borrow the owner in tab order or by stable identity. |
| `Documents::activate(id)` | Switch without rebuilding a session. Refuse an unfinished edit, as today's detach guard does. |
| `Documents::call(id, method, args, view)` | Today's command name and native `Value` arguments. A null view retains the session's view; an object supplies the existing complete view inputs, including auto-key, focus and D18 draws. No encoded JSON argument wrapper. |
| `Documents::undo(id)`, `redo(id)` | The original session commands and gesture grouping, with no second history stack. |
| `Document::revision`, `view`, `selection` | `view` and `selection` return `Result`, refusing with `Busy` during exclusive worker handoff. Revision remains the last accepted revision until the session returns. |
| `Document::with_document(read)` | Borrow cached typed figures, keyframes, layers and project properties inside core logic. Project displayed fields into a plain-data model; do not retain engine objects in a UI model. |
| `Document::frame_records()` | The session's shown records, including live gestures/property previews. A COW handle, with no record copy, serialization or geometry build. |
| `Document::records()` | `Result` borrowing the canonical store for core operations such as save preparation; `Busy` while the session is on its worker. Never an editable mirror. |

`DocumentsError` means no session was called. Otherwise `CallAnswer::result` is the actual result or
`EditError`, accompanied by events, drawing fork/retirement effects, clipboard data and unused random
draws. Handle even an error's events: the host invents no rollback beyond today's command. There is
no fallback implementation. `Session::call_native` uses the same view synchronizer, per-call setup
and `Editor::call` dispatcher as the JSON host, without making read-view packets.

Cache keys and job replies need `(DocumentId, revision)`: revisions belong to each history, and undo
restores earlier ones. Live frames also depend on playhead, view inputs and draft identity; revision
alone cannot identify a preview. The session owns those caches; core adds none. Each session is boxed
once so moving tabs does not move its large state.

## Asynchronous effects and resources

Attach `HostOptions` before accepting requests. It injects the engine, `Spawner`, asynchronous `Files`,
startup document, clock and an event-loop notifier. The host owns that engine's worker lifetime;
other owners submit work to it but do not stop it independently. One bounded document lane feeds at most one job
to `Engine::spawn`; two engine workers leave one available for frame preparation. Dispatch, polling,
cancellation and retirement exchanges use nonblocking access. `poll` handles at most one completion.
Refusals return the original request and its payload. Busy callers retry that request; a prompt response
is not consumed when submission is refused. The host does not start a second open/save behind a running one.

`OpenFile`, `OpenBytes` and `OpenDocument` use the existing engine decoders/normalizers. Native projects,
legacy JSON, Pivot projects and figure/movieclip containers are supported. Figure files import into
the active session with the existing `importFigure` command. Canonical Stick Nodes trees enter through
`OpenDocument`; raw Stick Nodes decoding still belongs to the import owner (the existing engine inventory
marks its decoder as JavaScript). No new serializer or raw Stick Nodes decoder is hidden in this host.

`Save` and `SaveAll` leave movieclip scopes first, as `performNativeSave` does, then snapshot the root
and call the engine's existing `save_project`. Each scope contributes one parent history entry. The
snapshot's document identity, revision, mutation epoch and depth must still match before marking saved.
A committed older snapshot may update the target but leaves newer work dirty (`Saved { current: false }`).
Undo and redo keep their original relationship to the saved revision. Save-as always asks for a target.
The platform writes a short, uniquely created sibling stage, flushes it, crosses the cancellation commit
boundary and replaces the destination by rename. Failure/cancellation preserves the existing file and
unsaved work; cleanup removes only the stage this call created. File input reserves both byte buffers
and scratch before reading; decoding retains the engine's own reservations.

Open/save dialogs, close confirmation and quit confirmation are effects. Close activates the requested
tab, asks Save/Discard/Cancel when dirty and selects its most recently used predecessor afterwards.
Closing the last tab or replacing an untouched blank keeps that tab's identity. Close Saved keeps the
front and dirty tabs. Save All visits other dirty tabs in band order, then the original front tab; a
cancel/failure ends the sequence. Quit uses the same saving sequence after one confirmation.
An accepted quit Save locks input for the existing `after_save` continuation; failure, cancellation or
refusal clears that continuation and releases the lock. Discard, a completed quit-save sequence and
clean quit commit the host's terminal quit state before recovery cleanup starts. `Documents::edits_locked`
then remains true through `QuitReady` and window teardown, even without a recovery service. The synchronous
session seam and asynchronous request seam refuse new work; save-target replies and cancellation still run.
`Core::dispatch` uses that same permission to silently fence commands, stage/pen gestures, drawing and text
drafts. Overlay housekeeping continues, and its action callbacks re-enter the command gate. Save's private
continuations alone may settle scopes and mark the committed snapshot saved. No revision can arrive after
the approved Save/Discard snapshot while cleanup or preference storage drains.
Renaming trims the name, uses `Untitled` for an empty input and marks an edit without adding history.

`published()` is the accepted stored-document generation for the stage, guarded by the current tab
and head. A stale worker generation is never returned as current. Session commands and live-frame
reads keep the milestone-1 interface-thread seam; the existing import and movieclip publication commands
still commit through that seam. Their parsing, open preparation, stored-frame projection and engine
activation run on workers. Drawing barriers and displayed live drafts belong to their existing owners.

Closed tabs, replaced scope sessions, superseded clipboards and rejected results return to the document
worker for reclamation. Native clipboard calls move outgoing typed storage into their retirement
effect, including `@setClipboard`. A successful shared copy also detaches obsolete typed clipboards in
every other tab and parent scope; a refused paste cannot retain one until a later interface-thread drop.
A refused or empty copy restores its previous clipboard by move. Dropping the owner cancels its active operation and hands over its remaining
tabs/clipboards without joining. `Cancel` wakes a waiting asynchronous file service and does not wait
for a concurrent waker registration. Local file I/O checks cancellation between bounded chunks.

Clipboard commands require an attached host (`ServicesRequired` otherwise), because a standalone
milestone-1 owner has no reclamation worker. Ordinary commands and queries still work without services.

## Native memory

`styk-app` installs `styk_alloc::Counting` before startup. `styk-platform::memory` reads machine facts;
the service policy chooses the smaller of half the physical memory and three quarters of available
memory at startup, with a checked conversion for 32-bit hosts and a 1 GiB fallback when the query fails.
Admission retains its existing extra sixteenth for small allocations that cannot refuse. This is a native policy;
the browser's largest-reservable WebAssembly maximum is not a physical-memory policy.

The explicit ignored release tests `allocator_drag_system` and `allocator_drag_counted` use the same
in-place input and 120 moves/frame reads per sample on its densest frame with all figures selected,
one warm-up and three samples. They assert cancellation
restores the original head and that counting is active only in the counted process.
An exclusive timing result remains the orchestrator's batch measurement, as required by the machine queue.
The Windows diagnostic exercised 848 figures with both allocators, with successful moves and restored heads.
It ran in a shared `probe` slot, so it does not establish an overhead figure; exact accounting is retained
pending the exclusive gate. `documents_memory` verifies counted open refusal, movieclip allocation
refusal without a changed head, and successful retries. Tiny metadata edits do not use that allocation gate.

Pivot admission counts the expanded stream before decoding even when the compressed-size estimate
would fit. Container admission uses its expanded section sizes without capping them at compressed size.
The engine checks `Reservation::overrun` after decode, normalization, typed conversion and prepared
assets, and the native host checks counted session construction before installation. A refusal returns
`out_of_memory`, releases the prepared work on its worker and leaves the current tab untouched.
`styk-engine/tests/native_admission` generates a 64 MiB zero-padded repository Pivot: the 128 MiB refusal is followed
by a successful retry after a competing reservation is released. No private file or frozen fixture is changed.

## Verification and integration

`styk-core/tests/documents.rs` opens repository legacy JSON and binary `.styk` fixtures. It checks
typed/record identity reuse, initial state, command results/refusals, live drafts, one-entry gestures,
cancel, undo/redo, isolated tabs, failed/cancelled opens and the limit of 12. The native session tests
compare document bytes, selection, playhead, history labels and events with frozen gesture/layer
tapes, and results/refusals/view inputs with the existing JSON boundary. Fixtures are never regenerated.

`documents_host` checks formats, imports, saves, failures, prompts, scopes, tab order and shared clipboards;
`documents_jobs` holds a file future pending to prove dispatch returns, cancellation wakes it, a subsequent
open succeeds and owner disposal runs off the interface thread. `styk-platform/tests/document_files.rs`
checks actual Windows replacement, read-only failure and staging cleanup.

The explicit save oracle runs today's owned editor and export worker twice before writing expected bytes
under ignored `artifacts/`. Native tests compare every byte after open/edit/undo/redo, using the same inputs.
Run with `node --test tests/native-documents-save-reference.test.mjs`, `STYK_REFERENCE_ROOT` naming the
pinned reference checkout (including its matching WASM package), and `STYK_NATIVE_SAVE_ORACLE` naming
that artifacts directory; the matching ignored Rust test requires the latter. The reference checkout
is read only. Comparing against native-app's changed JavaScript paired with an older WASM is invalid.
Nothing writes frozen fixtures. [Recovery/autosave](recovery.md) attaches a bounded worker lane and
chooser model to this owner. Raw import decoding, the window's dialogs and stage presentation remain
the respective owners' integrations. The panel seam needs none of those services to edit.

## Exclusive long commands

`Documents::call` returns `DocumentsError::AsyncRequired { entry: "Documents::dispatch(Request::Call)" }`
for `bakeMovieclip`, `restartMovieclip`, `removeMovieclipRestart`, `breakApartMovieclip`,
`addMovieclipToNextKeyframes`, `placeMovieclip`, `splitMovieclip`, `setMovieclipPlayback` with `allFrames`,
and `addFigure` when its definition is a movieclip. It also refuses the browser's incremental
`bakeMovieclipBegin`, `bakeMovieclipSample`, `bakeMovieclipPublish` and `bakeMovieclipCancel`; native
callers dispatch the complete `bakeMovieclip` instead. The session owns this classification.

`Request::Call { document, method, args, view }` moves that tab's sole session to the bounded document
lane and an engine job via `Spawner`. The worker enters `WorkerSession`, calls the existing cancellable
timeline worker, and uses the existing publication heads for rollback. Cancellation before its commit
boundary restores document, history, selection, counters and caches; after commit it cannot undo the
operation. Every ordinary completion, refusal and cancellation reattaches the same session before its
effect is returned. Dropping the host while work is pending retires it on the worker without joining.

While handed off, `view`, `selection` and `records` refuse with `Busy`; `with_document` and
`frame_records` preserve their `EditError` seam with the same busy message key. There is no second
document or evaluation cache. Only revision and dirty scalars for tab chrome retain their last accepted
values; editing, saving, switching and closing are refused until the owner returns. API names remain fixed.
`Effect::Called` carries the session's actual answer and effects. Tests cover the blocked worker, busy
queries, cancellation during bake and at commit, retry, one undo entry and save bytes against today's bake.

The document and recovery lanes both report `HostError::ScheduledJobLost` when a
scheduled closure disappears without returning (for example, a native worker
unwinds). Recovery presents this as an unavailable operation with that reason;
`NoHost` is reserved for document services that were never attached. Publishing
another document does not cancel either lane's queued jobs.

## The band's use of it (K-shell)

The top band (`styk_core::shell`, [shell-band.md](shell-band.md)) reads tab order and recency from this owner
(`Documents::tabs`, `recency`, `successor`, `neighbour`, `reorder`) and holds none of them itself; `documents/tabs.rs`
adds only `drop_index`, where a dragged tab lands. `styk-app/src/top_band.rs` attaches the host (`HostOptions`: the engine
through `styk_core::engine`, the platform's `Spawner` and `LocalFiles`, the one application clock) and opens the files the
command line and a script name with `Request::OpenFile`, one at a time, polling the host on the frames it draws while an
open runs. A project the tabs refuse comes back as a failure and is disposed of on the host's worker. The band's other
commands (Save, Close, New, Rename) are still dropped until the command registry and the dialogs exist; `Event::Closed`
tells the band when a project closed.

The recovery panel retains a refused Quit or prompt response until a documents-host progress wake;
`Core::documents_progress` makes one retry, following the `continue_save` pattern. It never consumes
a visible prompt on Busy. K-shell currently has no save-file dialog consumer, so its close prompt
makes Save unavailable for documents without a target and retains Discard/Cancel. Existing targets
save normally; successful saves finish cleanup before QuitReady. The session-end platform adapter
uses this same checkpoint and confirmation path; see [recovery.md](recovery.md).
If its OS-derived deadline expires first, the core instead uses the same asynchronous teardown as
`Documents::drop`: pending work is cancelled, both lanes are detached, and their payloads and any late
reply are reclaimed on workers. This terminal path preserves committed recovery files and never calls
normal quit cleanup. The app exits without waiting for another disk operation.
