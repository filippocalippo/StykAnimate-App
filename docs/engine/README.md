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
`npm run engine:parity` (`-- --corpus`), `npm run engine:bench`
(one benchmark run; `scripts/engine-bench-matrix.sh` for rounds) and
`npm run engine:bench:summary <label>`.

For `figures`, `movieclips` and `channels`, default editing requires exact behavior,
a matching checkpoint and actual core adoption. Full paired cost may be at most 5%
higher, or average excess may be at most 0.1 ms using the smaller complete timed call
count from the pair; adoption, fallback and failed attempts are included once.
D13 and historical measurements remain unchanged; see [editing.md](editing.md).
