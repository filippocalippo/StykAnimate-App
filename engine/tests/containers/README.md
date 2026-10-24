# Native container fixtures

Small `.styk`, `.stkz` and `.stykmov` files, so the container reader and writer have inputs in a fresh
checkout and in CI, and library previews have a figure and movieclips to open
(`engine/crates/styk-engine/tests/thumbnails.rs`). Regenerate them with
`node engine/tools/container-fixtures.mjs` (`--list` names them, `--out <folder>` writes elsewhere); the
output is byte-stable, so a regeneration that changes a file means the app's save path or a source
document changed. Each is written from a document already in the repository by the app's save path
(the document export worker; the lift and the Rust writer for the shared arrays), and
`npm run engine:parity` regenerates them, then opens and saves every one again against the Rust store
(`engine/tools/container-parity.mjs`).

| File | Source document | Covers |
| --- | --- | --- |
| `project-arrays.styk` | `spatial/mesh-views.json` | version 2, a numeric-array section (a mesh's positions, bones, weights) |
| `project-shared-arrays.styk` | `spatial/mesh-in-movieclip.json` | arrays held once and named by several markers (a movieclip reusing the figure's mesh) |
| `project-channels.styk` | `channels/channels-pose.json` | stored pose-key sequences referenced from several channels |
| `project-images.styk` | `clip-paint/image-identity.json`, with a noise picture | a binary-payload section; the same picture in two backgrounds is stored once |
| `project-drawing.styk` | `drawing-root-sampling/raw-cel-only.json` | a drawing layer's tile blob as a payload |
| `project-version-1.styk` | `drawlist/painted-limbs.json` | version 1 (zlib around the project's JSON), which the app reads and no longer writes |
| `figure.stkz` | `spatial/mesh-views.json` | a figure file with a mesh's arrays |
| `movieclip-effects.stykmov` | `generators/movieclip.json` | a movieclip file with generated effects growing through its nine ticks |
| `movieclip-motion.stykmov` | `channels/channels-in-movieclip.json` | a movieclip file whose figure swings out and back (its widest pose is mid-clip) |

Sources are under `engine/crates/*/tests/fixtures/`.
