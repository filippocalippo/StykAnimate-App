# Test status: heuristic auto-rigging and the Claude mascot rig

**Status**: the pure-JavaScript tests pass; the engine-owned tests run when the Rust engine is built.
**Files**: `tests/auto-rig.test.mjs`, `tests/adversarial-ik.test.mjs`, `tests/adversarial-cli-worker.test.mjs`

## What runs where

| Layer | Where | How |
| --- | --- | --- |
| Landmark-to-figure synthesis, Claude figure data, document wrapping | `tests/auto-rig.test.mjs` | plain `node:test`; no engine needed |
| Adversarial skeleton/IK-table contract | `tests/adversarial-ik.test.mjs` | plain `node:test`; no engine needed |
| Detector honesty, pixel negative cases, pose variation | `tests/adversarial-cli-worker.test.mjs` Suite 3 | plain `node:test`; no engine needed |
| CLI argument/error contract, SVG hardening | `tests/adversarial-cli-worker.test.mjs` Suites 1-2 | spawns `scripts/creative-studio-cli.mjs`; needs a normal OS process spawn |
| Engine-owned import → undo → redo → save | `tests/auto-rig.test.mjs`, last `describe` | skipped unless `src/engine/pkg/styk_engine_bg.wasm` exists (`npm run engine:build`) |

Run everything the way the repository does:

```
npm run engine:build     # once, so the engine-owned tests have a session
npm test
```

One file:

```
node --import ./tests/support/register-engine.mjs --test tests/auto-rig.test.mjs
```

The engine-owned block skips with a named reason when the engine build is missing, so the file never fails only
because a local checkout has no WebAssembly module.

## What these tests deliberately do not cover

- **The Rust IK solver.** `solveIKPoints`/`solveObjectIK` were removed from JavaScript when the engine took over
  the document; solver edge cases belong to `npm run engine:test` (styk-edit/styk-eval), not to these files.
- **The dialog in a real browser and the desktop app.** These need a window and Playwright; no browser suite was
  run for this change.
- **Real pose accuracy.** There is no trained model: the detector's contract here is only that it labels results
  as heuristic (`synthetic: true`, low visibility), rejects clearly non-figure silhouettes, and responds to the
  image instead of returning a fixed template.

## Known blind spots

- `npm run check` cannot report anything in an environment that blocks child processes (`scripts/check.mjs`
  spawns `node --check` per file); its individual parts can be run directly: `node scripts/build-locales.mjs
  --check`, `node scripts/engine-inventory.mjs`, `node scripts/check-css.mjs`.
- The CLI tests that spawn the CLI are exercised by CI on a normal runner; they fail with `EPERM` in a sandbox
  that blocks child-process pipes.
