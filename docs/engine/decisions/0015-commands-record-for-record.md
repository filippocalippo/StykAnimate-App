# D15: Editing moves to the engine command by command, record for record

Status: accepted, phase 1 in progress. Recorded in [`docs/RUST-ENGINE-PORT.md`](../../RUST-ENGINE-PORT.md) section 4; design in [`../editing.md`](../editing.md).

## Context

The JavaScript `Editor` owns the document and runs about 800 methods across some 80 modules. The engine holds a mirror of the document (D12). Moving every command at once would leave the app broken for weeks and give no way to tell a port from a rewrite.

## Decision

A command moves to `styk-edit` only when it reproduces the editor record for record: from the same document, selection, playhead and arguments it changes the same records into the same bytes, returns the same value, leaves the same selection and history state and emits the same change events. The command-replay harness checks this step by step: `engine/tools/edit-scenarios.mjs` builds scenarios with the editor's own fixture kit, `engine/tools/edit-replay.mjs` records them in the JavaScript editor, and `styk edit-replay` (and `cargo test -p styk-edit`) replays them in Rust. The `Editor` facade keeps its API; a ported method will run in the engine and adopt the changed records and event detail; everything else runs in JavaScript and reaches the engine through the mirror. Calls `styk-edit` cannot run yet answer `Unported`.

## Evidence

Selection, seeking, gestures and moving, rotating, scaling, flipping, centring and resetting figures, with undo and redo, match the editor at every step of their recordings (plan, milestone log). A tampered recording is caught.

## Revision (2026-10-03): shadow before ownership

The app builds its editor with property channels and the layer timeline, so every
command runs through drafts whose JavaScript state (the preview frame, geometry
caches, layer bookkeeping, history objects) is entangled with rendering. Adopting the
engine's records command by command would mean keeping two copies of that runtime state
equal by hand. Instead:

1. Commands are ported and proven in the Node harness, byte for byte.
2. In the app they first ran in **shadow**: the JavaScript editor stayed in charge, the engine
   ran the same call on the mirrored document, and the two were compared. No behaviour
   changed, real documents and real gestures were covered, and the boundary's cost was measured.
   The shadow is deleted: the engine owns every document (D19).
3. Ownership flips in one step per document once its commands are ported: the engine's
   session becomes the document, and the JavaScript editor a view of it.

Step 3 became D19: one engine session holds the open document and its history, the editor
reads what it answers (`src/engine/engine-owner.mjs`, [`../editing.md`](../editing.md), "Phase 3").
The per-class adoption, which ran ported calls in the engine only for document classes whose
cost was not higher than the editor's, is deleted with the shadow.

## Consequences

Each port is a mechanical comparison rather than a judgement. The editor's arithmetic is
reproduced as Node computes it (D16). Runtime state the document does not carry (layer
focus locks, the timeline's layer selection, counters, auto key) is handed to the engine
with each session and call; `editing.md` lists it. Until the flip nothing the engine
computes for an edit is shown to the user, so a wrong port cannot damage a document.

## Cost gate revision (2026-10-05)

For `figures`, `movieclips` and `channels`, the user-approved full paired class gate is
`C <= 1.05 × J` **or** `(C − J) / N <= 0.1 ms`, with adoption, eligible fallback and
failed attempts counted once and `N` the smaller complete timed `report.calls` count.
Exact record-for-record behavior and D13 remain unchanged; see
[editing.md](../editing.md#which-classes-the-engine-edits-by-default).
