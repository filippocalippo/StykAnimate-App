# D19: The engine owns the document; the editor keeps a read view patched from it

Status: accepted (user, 2026-10-11). Recorded in [`docs/RUST-ENGINE-PORT.md`](../../RUST-ENGINE-PORT.md)
section 4. Supersedes the per-command adoption of D15 in the app; D15's record-for-record
replays still decide when a command is ported.

## Context

Until now an engine session was started for a run of calls and ended at the first call it
could not run. The JavaScript editor stayed the owner of the document and of history, and
each command the engine ran had to be adopted by hand-written code that rebuilt the editor's
state from a command-specific packet (200–400 lines of validation per family). About 230
methods the app calls still ran in JavaScript, and all of that adoption code would be thrown
away once the engine owns the document (phase 3).

## Decision

- One engine session per open document owns the document and its history. It starts when a
  document is loaded and lives until another one is.
- Every answer can carry a **document patch** (`patch: true` in the view): the operations that
  turn the report before the call into the report after it, computed from copy-on-write
  identity (`styk_edit::patch`), so its cost follows the size of the change. The editor
  applies it to its document copy-on-write (`src/engine/engine-patch.mjs`): the interface keeps
  reading `editor.report`, now a read view. Key order follows JavaScript's rules on both sides,
  so the read view stays byte-identical to the engine's document.
- Undo and redo are the session's; the editor's history getters read the session's state.
- A call the session has no command for yet runs in the JavaScript editor, on the read view.
  Its changed records are written back into the session with a history entry that the
  JavaScript editor undoes itself, until the call is ported and the entry kind disappears.
  A call the session refuses for any other reason raises a localized error; it never runs
  in the editor.
- Every native replay also checks that the patch of each step rebuilds the document after it.

## Consequences

- No more per-command adoption packets; porting a command is the Rust implementation and its
  recorded replays.
- The JavaScript command implementations and evaluation are deleted as their callers move to
  the engine; the read view, its patch applier and the interface's projections remain.
- The mirror's job shrinks to giving the stage the session's document; it disappeared when the
  engine began to open documents itself and its session published each change it makes
  (cut 2, 2026-10-24; [document.md](../document.md#opening-a-document)).
- Values the editor draws at random (D18) are handed to the session as a pool per call; it
  takes what it needs in order.
