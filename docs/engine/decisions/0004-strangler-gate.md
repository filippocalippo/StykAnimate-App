# D4: The engine replaces the JavaScript engine document by document, feature by feature

Status: accepted; the renderer gate is deleted (every document is drawn by the engine, 2026-10-24). Recorded in [`docs/RUST-ENGINE-PORT.md`](../../RUST-ENGINE-PORT.md) section 4.

## Context

The app must work at every commit while subsystems move to Rust one at a time.

## Decision

The engine stage wrapped the JavaScript renderer behind the same interface. A gate named the first feature of a document the engine lacked; such a document kept the JavaScript renderer whole. It shrank as features landed, and its last two reasons (a frame draft; movieclips nested deeper than 16 levels) went when the engine drew both: the gate and the JavaScript renderer are gone. What remains are conditions of a frame, not of the document: the engine has failed, a drawing has unpublished strokes, a drawing preview, a rotated or mirrored view (`refusal` in the stage, `eligible` in the playback adapter). Editing is gated per command group (S5).

## Evidence

The start-up document, the repository's test projects and asset packs, the IK fixtures, the large Pivot files and the documents the gate refused last (frame drafts, movieclips 17 and 24 levels deep, an animation with no keys: [rendering.md](../rendering.md#every-document)) were drawn by the engine and compared with the JavaScript renderers until the engine became the only stage (plan section 7).

## Consequences

Two renderers coexist until the JavaScript renderer is deleted; a frame switching between them shows the same picture (parity), so switching is invisible.
