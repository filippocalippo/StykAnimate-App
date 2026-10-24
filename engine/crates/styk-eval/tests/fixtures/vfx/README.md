# Visual-effect fixtures

Regenerate everything here with `node engine/tools/vfx-fixtures.mjs` (from the repository root; `--list` names the fixtures, a name regenerates one). The output is byte-stable: the generator replaces the editor's random effect identities and generator seeds with fixed sequences, so a regeneration that changes a file means the editor's evaluation changed.

Each `<name>.json` is a small project built with the JavaScript editor and saved as plain JSON, which the engine opens like a `.styk`. `<name>.reference.json` is what the editor evaluates for it at a few ticks (`engine/tools/reference.mjs --vfx`, without its timings): geometry, and per tick the effects it resolves (`frames[].vfx`). `vectors.json` holds inputs and outputs of the pure functions (colour interpolation, key sampling, padding, working slots, neutral effects). `cargo test -p styk-eval --test vfx` compares the engine with all of them; see `docs/engine/vfx.md`.
