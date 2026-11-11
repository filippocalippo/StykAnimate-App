# D9: The engine build output is generated, not committed

Status: accepted. Recorded in [`docs/RUST-ENGINE-PORT.md`](../../RUST-ENGINE-PORT.md) section 4.

## Context

A 4 MiB binary per engine change would bloat history.

## Decision

`src/engine/pkg/` is git-ignored and produced by `npm run engine:build`. The web build and the desktop package copy `src/`, so they include it once built; CI builds it and fails when it is missing.

## Evidence

—

## Consequences

A fresh checkout needs `npm run engine:build` (README, AGENTS.md) before the app can use the engine; without it the app keeps the JavaScript renderer and logs why.
