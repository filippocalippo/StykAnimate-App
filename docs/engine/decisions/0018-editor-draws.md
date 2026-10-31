# D18: What the editor draws at random is handed to the engine

Status: accepted. Recorded in [`docs/RUST-ENGINE-PORT.md`](../../RUST-ENGINE-PORT.md) section 4.

## Context

Some editing commands draw values at random: identities of effects, effect clips, camera
motion clips and audio clips (`crypto.randomUUID`), seeds (`crypto.getRandomValues`,
`Math.random`). A port compared record for record (D15) cannot draw its own: its documents
would never equal the editor's, and the command-replay recordings would change every time
they are made.

## Decision

- The editor draws through one module, `src/editor-draws.mjs` (`editorDraws.uuid`, `seed`,
  `random`). `withDraws(run, source)` records the draws of a call in order as `[kind, value]`,
  and with `source` replaces them.
- The command-replay recorder (deleted: the tapes in `engine/tests/edit/` are frozen) drew from a fixed sequence
  (identities `d0d0d0d0-0000-4000-8000-…`, a pattern no fixture generator used) and recorded
  each step's draws as `draws`.
- The engine takes the draws of the call it is making, in order and by kind
  (`Editor::set_draws`, `draw_uuid`, `draw_seed`, `draw_random`); a call that would draw what
  it was not handed answers `Unported`. The replay feeds a step's `draws`; a session call
  reads them from its view (`draws`).
- In the app the facade records what the editor drew while it ran the call and sends it with
  the engine's run of the same call. Calls that draw run in both and are compared; they are
  not in `OWNED`, since the engine running alone would have nothing to take.

## Consequences

Commands that draw can be ported and checked like any other. Until the engine owns the
document outright (S5, phases 2 and 3) the editor stays the one that draws; then the engine
draws through the same interface and recordings keep supplying fixed values.
