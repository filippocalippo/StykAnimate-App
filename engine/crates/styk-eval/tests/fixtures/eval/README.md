# Evaluation fixtures

Frozen: these were recorded from the JavaScript editor and nothing re-records them (docs/engine/README.md, "Fixtures"). A new or changed behaviour gets a Rust test in `tests/eval.rs` that states its expected result.

Each `<name>.json` is a small project the JavaScript editor built; `<name>.reference.json` is what the editor evaluated for it at a few ticks. `tests/eval.rs` requires the engine to draw the same joints and primitives.
