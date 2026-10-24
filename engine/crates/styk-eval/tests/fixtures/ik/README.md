# Inverse-kinematics fixtures

Regenerate everything here with `node engine/tools/ik-fixtures.mjs` (from the repository root; `--list` names the fixtures, a name regenerates one).

Each `<name>.json` is a small project built with the JavaScript editor and saved as plain JSON, which the engine opens like a `.styk`. `<name>.reference.json` is what the editor evaluates for it at a few ticks (`engine/tools/reference.mjs`, without its timings), plus what its solver derived, unrounded (`frames[].ik`). `vectors.json` holds inputs and outputs of the pure solver and interpolation functions. `cargo test -p styk-eval --test ik` compares the engine with all of them; see `docs/engine/rigs-ik.md`.
