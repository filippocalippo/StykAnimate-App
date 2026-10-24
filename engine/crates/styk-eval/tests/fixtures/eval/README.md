# Evaluation fixtures

Regenerate everything here with `node engine/tools/eval-fixtures.mjs` (from the repository root; `--list` names the fixtures, a name regenerates one). The output is byte-stable: a regeneration that changes a file means the editor's evaluation changed.

Each `<name>.json` is a small project the JavaScript editor built; `<name>.reference.json` is what the editor evaluates for it at a few ticks (`engine/tools/reference.mjs`). `tests/eval.rs` requires the engine to draw the same joints and primitives.
