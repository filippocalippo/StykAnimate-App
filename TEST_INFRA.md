# Test infrastructure: heuristic auto-rigging

## Philosophy

Plain `node:test` files, no framework beyond the repository's own helpers. The tests are split by what they can
own, not by milestone: pure data transforms run everywhere; anything that needs the engine session or a real
process is gated or delegated.

## Files and what they own

| File | Owns | Needs |
| --- | --- | --- |
| `tests/auto-rig.test.mjs` | 33/17-landmark normalization, segment-tree synthesis, 2-bone IK controller table, Claude mascot figure data, document wrapping, boundary cases, pose variations, engine-owned import/undo/redo/save | engine only for the last block |
| `tests/adversarial-ik.test.mjs` | collapsed/collinear/inverted skeletons, extreme coordinates, stored IK-table validity (`validateIK`, `ikChain`, `hasPinnedIK`) | nothing |
| `tests/adversarial-cli-worker.test.mjs` | CLI exit codes and argument errors, SVG/XML injection hardening, pixel-based detector negatives and pose variation, worker/protocol error isolation | a normal process spawn for the CLI suites; nothing for the rest |

## Conventions

- A test that needs the engine build checks for `src/engine/pkg/styk_engine_bg.wasm` and skips with a named
  reason when it is missing (`npm run engine:build` produces it).
- A test that needs child processes says so by spawning the CLI; it is expected to fail in sandboxes that block
  child-process pipes, and CI runs it on a normal runner.
- Detector results are asserted for honest provenance, not accuracy: `synthetic: true`, `detector:
  'heuristic-silhouette'` or `'synthetic-t-pose'`, and `visibility <= 0.5`. No test may expect a confident
  detection from arbitrary shapes.
- The 2-bone solver is not tested here: it is Rust (`styk-edit`/`styk-eval`), tested by `npm run engine:test` and
  the parity fixtures.

## Coverage map

| Feature | File | Cases |
| --- | --- | --- |
| Landmark normalization and indexing (MediaPipe 33 / COCO 17) | auto-rig, adversarial-ik | T-pose, arms-down, crouch, collapsed, inverted, 17-vs-33 equivalence |
| Segment tree and IK controller table | auto-rig, adversarial-ik | ids, parentage, chain resolution, `validateIK` rejections |
| Claude mascot rig | auto-rig, adversarial-ik | palette, 7 segments, 4 independent IK legs |
| Detector honesty | adversarial-cli-worker | solid block/wide shape/circle rejected, labelled synthetic, pose variation |
| Worker and client protocol | auto-rig, adversarial-cli-worker | request/response shapes, worker crash isolation, error keys |
| Engine-owned document path | auto-rig (engine-gated) | import → undo → redo, serialize → reopen |

## Not covered

Browser/desktop UI of the dialog (`npm run test:browser -- auto-rig`), real pose accuracy (no trained model), and
Rust solver internals (`npm run engine:test`).
