# Engine documentation

The Rust engine that replaces StykAnimate's JavaScript engine. The living plan
is [`../RUST-ENGINE-PORT.md`](../RUST-ENGINE-PORT.md); decisions are in
[`decisions/`](decisions/README.md); what is ported module by module is
[`INVENTORY.md`](INVENTORY.md).

| Page | Subsystem |
| --- | --- |
| [document.md](document.md) | the document store, typed views, opening and publishing a document |
| [formats.md](formats.md) | native containers, opening files |
| [formats-piv.md](formats-piv.md) | the Pivot codec and its service |
| [evaluation.md](evaluation.md) | timelines, layer sheets, movieclips, geometry, draw-list encoding |
| [rigs-ik.md](rigs-ik.md) | rig constraints and inverse kinematics |
| [vfx.md](vfx.md) | visual effects |
| [spatial.md](spatial.md) | 3D: spatial poses, one-sided surfaces, figure and movieclip meshes, depth runs |
| [rendering.md](rendering.md) | the draw-list format, GPU renderer, CPU rasterizer, the stage, thumbnails, library previews, the camera monitor, exports |
| [threading.md](threading.md) | WebAssembly, workers, scheduling, budgets |
| [memory.md](memory.md) | the shared memory: what fills it, what is bounded, what is refused when it is full |
| [editing.md](editing.md) | recorded commands, history and canonical worker publication (S5, adoption in progress) |
| [drawing.md](drawing.md) | the drawing raster engine: brushes, strokes, fill, selections, transforms, tile and undo codecs (S6) |

Commands: `npm run engine:build`, `npm run engine:test` (seconds once built),
`npm run engine:parity` (`-- --corpus` adds the Pivot codec's recorded answers), and for speed
`npm run perf -- engine` (the engine by itself in Node, in seconds) and `npm run perf -- run` (the whole app, with
where each scenario's time went, by engine module among the rest): [PERFORMANCE.md](../PERFORMANCE.md).

`styk-edit` and `styk-eval` build their integration tests as one binary each (`tests/suite.rs`, one module per test
file), because linking one binary per file took longer than the tests themselves:
`cargo test -p styk-eval --test suite -- <file>::` runs one file's tests. A new test file is added to `suite.rs`
(a test there fails for a file that is listed nowhere). A file that needs the process to itself (its own allocator, a
measurement) is its own `[[test]]` in the crate's `Cargo.toml`.

Native measurements of an interaction, by phase (a measurement, not a check; they print and assert nothing about speed):
`styk stepbench <file> <tick> [steps]` times a drag step (build, encode and place, with onion skins);
`STYK_BENCH_DOC=<file> STYK_BENCH_TICK=<tick> cargo test --release -p styk-engine --test commit_bench -- --ignored --nocapture`
times a pose drag, its commit, an undo and a redo as the stage shows them (the session call, the frame and the onion skins after it, the
draw), with `STYK_EDIT_PROFILE=1` adding where the session call spends its time (`styk_edit::prof`). `styk prims <file> [tick…]` lists
what a frame is made of.
`STYK_BENCH_DOC=<file> cargo test --release -p styk-export --test seek_bench -- --ignored --nocapture` times a seek as the stage shows it
(the interface's read of the frame, the session's frame, its geometry read, the draw list, the same frame drawn again, and clicks on artwork;
`STYK_BENCH_ROUNDS=<n>` repeats the ticks and prints the minimum and median of each phase, which says more on a busy machine, and
`RAYON_NUM_THREADS=1` builds on one thread as the app's interface does); its `a_prepared_frame` times a frame as a preparation worker makes
it (evaluation, scene, draw list, cull), on `STYK_BENCH_THREADS=<n>` threads at once.
`STYK_BENCH_DOC=<file> cargo test --release -p styk-engine --test dense_bench -- --ignored --nocapture` times a joint drag move, a figure
move, their release, an undo and single seeks on the interface's side (the session's call and frame, the geometry read since the last, the
frame's text, the onion skins, the draw list), with and without onion skins (natively the frame's builds run in parallel, which the
interface thread of the app does not).
`node scripts/engine-build.mjs --names` builds the release WebAssembly with its function names kept, for a CPU profile of the app.

## Fixtures

The JavaScript engine is no longer the oracle. What it produced while it was is kept as **frozen
fixtures**, and the engine is checked against them as they are:

- the command tapes and their references (`engine/tests/edit/*.scenario.json` and `*.reference.json`: the state,
  the document and the events after every step) and the other recordings under `engine/tests/`;
- the evaluation fixtures (`engine/crates/*/tests/fixtures/**`) and the JavaScript tests' fixtures (`tests/fixtures/**`);
- the Pivot codec's recorded answers (`styk-piv`); the Python codec stays the development oracle of the Pivot
  format ([formats-piv.md](formats-piv.md)).

Nothing re-records them from the JavaScript, and `npm run engine:parity` does not regenerate them. A new
or changed behaviour gets a **Rust test** (or, for the app's own path, a JavaScript test) that states its expected
result; a fixture is edited only when the contract it states changes, never to make a comparison pass
([D13](decisions/0013-app-parity-rule.md)).

`engine/tools/` keeps only what does not run the JavaScript engine: `math-fixtures.mjs` (V8's own `Math` results
for `styk-math`, which must stay V8-exact, [D16](decisions/0016-v8-exact-math.md)) and `v8-pin.mjs` (pins Node's
`Math.pow` for the JavaScript tests that load the engine), `container-fixtures.mjs` and `container-parity.mjs` (the
native container files, written and checked through the app's own save path) and `piv/` (the Python codec's recorder).
The app's bounds callback, which the owner tests import, is `tests/support/edit-bounds-callbacks.mjs`.

For `figures`, `movieclips` and `channels`, default editing requires exact behavior,
a matching checkpoint and actual core adoption. Full paired cost may be at most 5%
higher, or average excess may be at most 0.1 ms using the smaller complete timed call
count from the pair; adoption, fallback and failed attempts are included once.
D13 and historical measurements remain unchanged; see [editing.md](editing.md).
