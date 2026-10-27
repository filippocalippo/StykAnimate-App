# Visual-effect fixtures

Frozen: these were recorded from the JavaScript editor and nothing re-records them (docs/engine/README.md, "Fixtures"). A new or changed behaviour gets a Rust test in `tests/vfx.rs` that states its expected result.

Each `<name>.json` is a small project built with the JavaScript editor and saved as plain JSON, which the engine opens like a `.styk`. `<name>.reference.json` is what the editor evaluated for it at a few ticks: geometry, and per tick the effects it resolved (`frames[].vfx`). `vectors.json` holds inputs and outputs of the pure functions (colour interpolation, key sampling, padding, working slots, neutral effects). `cargo test -p styk-eval --test vfx` compares the engine with all of them; see `docs/engine/vfx.md`.
