# Native documents: panel seam (K-doc, milestone 1)

`styk_core::documents::Documents` holds the tabs, each owning one `styk-edit::session::Session`.
The session owns the document, selection/playhead, gesture and history. There is no report mirror,
JSON patch, duplicate selection or duplicate dirty flag. This milestone writes no file.

## Preparing and installing a document

On an engine worker, `PreparedDocument::open_bytes(engine, bytes, name, cancel)` runs the existing
file reader and normalization. Bytes are an `Arc<[u8]>`; an imported Pivot original is attached to
the canonical tree without another byte buffer. `from_opened` accepts an engine open for new
documents and decoded imports. Both entries finish constructing the session on the worker, including
its indexes, reusing the prepared typed views. Only the small start options use the existing JSON
initializer; the document is never serialized again.

These are **synchronous worker preparation entries**, not interface-thread open commands. The later
K-doc dispatcher will schedule them and handle cancellation/stale replies. `Documents::open` only
moves the ready session into a tab beside the active one: no decode, normalization, evaluation,
publication or index construction. A refusal returns the prepared document for retry or worker disposal.

Initial selection and names follow `_publishLoadedReport`: select the first keyframe's first figure;
drop `.piv`, `.stk` or `.styk` case insensitively, then fall back to the stored name and `Untitled animation`.
A fresh session has revision/saved revision 1 and empty history. `PreparedDocument::set_clock` injects
the budgeted-read clock. Commands use the allocator's admission gate; setting its machine limit and
installing the counting allocator remain the later engine-host work.

## Commands and reads

Panel **logic in the core** uses these names; a view displays its plain-data model and sends messages.

| API | Contract |
| --- | --- |
| `Documents::tabs`, `active`, `get(id)` | Borrow the owner in tab order or by stable identity. |
| `Documents::activate(id)` | Switch without rebuilding a session. Refuse an unfinished edit, as today's detach guard does. |
| `Documents::call(id, method, args, view)` | Today's command name and native `Value` arguments. A null view retains the session's view; an object supplies the existing complete view inputs, including auto-key, focus and D18 draws. No encoded JSON argument wrapper. |
| `Documents::undo(id)`, `redo(id)` | The original session commands and gesture grouping, with no second history stack. |
| `Document::revision`, `view`, `selection` | Borrow selection/labels and read scalar playhead, history, dirty and editing state. |
| `Document::with_document(read)` | Borrow cached typed figures, keyframes, layers and project properties inside core logic. Project displayed fields into a plain-data model; do not retain engine objects in a UI model. |
| `Document::frame_records()` | The session's shown records, including live gestures/property previews. A COW handle, with no record copy, serialization or geometry build. |
| `Document::records()` | Borrow the canonical store for core operations such as save preparation. Never an editable mirror. |

`DocumentsError` means no session was called. Otherwise `CallAnswer::result` is the actual result or
`EditError`, accompanied by events, drawing fork/retirement effects, clipboard data and unused random
draws. Handle even an error's events: the host invents no rollback beyond today's command. There is
no fallback implementation. `Session::call_native` uses the same view synchronizer, per-call setup
and `Editor::call` dispatcher as the JSON host, without making read-view packets.

Cache keys and job replies need `(DocumentId, revision)`: revisions belong to each history, and undo
restores earlier ones. Live frames also depend on playhead, view inputs and draft identity; revision
alone cannot identify a preview. The session owns those caches; core adds none. Each session is boxed
once so moving tabs does not move its large state.

## Verification and remaining integration

`styk-core/tests/documents.rs` opens repository legacy JSON and binary `.styk` fixtures. It checks
typed/record identity reuse, initial state, command results/refusals, live drafts, one-entry gestures,
cancel, undo/redo, isolated tabs, failed/cancelled opens and the limit of 12. The native session tests
compare document bytes, selection, playhead, history labels and events with frozen gesture/layer
tapes, and results/refusals/view inputs with the existing JSON boundary. Fixtures are never regenerated.

Remaining K-doc work: asynchronous open/save/publication dispatch, stage activation, format/import
services, save targets/atomic files, close/quit prompts, movieclip scopes, tab reordering/recency,
empty-tab replacement, cross-tab clipboard transfer, and resource reclamation. Recovery/autosave
belong to K-rec. The panel seam needs none of those services to edit and read a real session.
