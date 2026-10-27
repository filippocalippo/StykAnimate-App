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
`npm run engine:parity` (`-- --corpus` adds the Pivot codec's recorded answers), `npm run engine:bench`
(one benchmark run; `scripts/engine-bench-matrix.sh` for rounds) and
`npm run engine:bench:summary <label>`.

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
