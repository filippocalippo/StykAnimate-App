# Inverse-kinematics fixtures

Frozen: these were recorded from the JavaScript editor and nothing re-records them (docs/engine/README.md, "Fixtures"). A new or changed behaviour gets a Rust test in `tests/ik.rs` that states its expected result.

Each `<name>.json` is a small project built with the JavaScript editor and saved as plain JSON, which the engine opens like a `.styk`. `<name>.reference.json` is what the editor evaluated for it at a few ticks, plus what its solver derived, unrounded (`frames[].ik`). `vectors.json` holds inputs and outputs of the pure solver and interpolation functions. `cargo test -p styk-eval --test ik` compares the engine with all of them; see `docs/engine/rigs-ik.md`.
