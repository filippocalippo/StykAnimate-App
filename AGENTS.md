# StykAnimate agent guide

StykAnimate is a local stick animation program built on sound architecture and good performance. Preserve editable animation semantics, reliable saving, responsive interaction, and bounded memory as the software grows.

## Working agreement

- Inspect relevant source, configuration, documentation, and `git status --short` before editing. Preserve unrelated work; never reset a dirty workspace to simplify a task.
- Complete implementation and relevant verification. Make reasonable assumptions for routine reversible decisions. Ask only when missing information changes correctness, scope, or authorization; continue independent work meanwhile.
- Follow the user's latest correction without losing the original objective. Use applicable skills and inspect their instructions for conflicts or stale assumptions. Delegate only when requested or explicitly authorized by applicable instructions.
- Keep changes focused and use existing module boundaries. Fix the owning layer instead of duplicating state or adding a second implementation of the same behavior.
- Report the result, checks actually run, and remaining limitations concisely. Claims about builds, performance, or releases require evidence for the changed bytes.

## Where to look

| Concern | Start here |
| --- | --- |
| Architecture and setup | `docs/ARCHITECTURE.md`, `README.md`, `package.json` |
| Document, commands, undo | `engine/crates/styk-edit/`, `src/engine/engine-owner.mjs`, `src/engine/engine-commands.mjs`, `src/editor.mjs` (read view and view state), `docs/engine/editing.md`, `docs/SCENE-EDITING.md` |
| Timeline and animation modes | `src/layer-timeline.mjs`, `docs/TIMELINE.md`, `docs/animation-modes.md` |
| Home, project list, tutorials | `src/home/`, `src/tutorials/`, `desktop/project-library.cjs`, `docs/HOME.md`, `docs/TUTORIALS.md` |
| Rust engine: plan, decisions, subsystems | `docs/RUST-ENGINE-PORT.md` (read first), `docs/engine/README.md`, `docs/engine/decisions/`, `docs/engine/INVENTORY.md`, `engine/` |
| Engine in the app: owner, frame reads, stage, playback, exports | `src/engine/`, `docs/engine/document.md`, `docs/engine/evaluation.md`, `docs/engine/rendering.md`, `docs/engine/threading.md` |
| Import, formats, saving | `backend/README.md`, `codecs/`, `native/`, `docs/IMPORT-PIPELINE.md`, `docs/document-exports.md` |
| Desktop and packaging | `desktop/`, `scripts/before-pack.cjs`, `docs/DESKTOP-RELEASE.md` |
| Tests and measurements | `tests/`, `scripts/smoke-*.mjs`, `scripts/benchmark-*.mjs`; generated output goes to the ignored `artifacts/` |
| Release history and shipping | `CHANGELOG.md`, `docs/RELEASING.md`, `docs/UPDATES.md`, `.github/workflows/desktop-release.yml` |
| Licensing and community | `LICENSE`, `THIRD_PARTY_NOTICES.md`, `CONTRIBUTING.md`, `SECURITY.md` |
| Public site, catalogue and services | The separate StykAnimate-Site repository; `docs/WEB.md` covers the browser editor |

Read the relevant contract before changing behavior. Current code and workflow configuration establish executable commands; older release reports certify only their original artifacts. Update documentation when its contract changes.

## Architecture and performance

- Keep document data, editor commands/history, worker preparation, rendering caches, and UI state separate. Preserve native IDs, topology, frame timing, file compatibility, and undo/redo.
- Keep expensive parsing, evaluation, rasterization, and encoding off the UI thread using existing workers and bounded transfers. Avoid full-document cloning or serialization on interactive paths.
- Bound queues and CPU/GPU caches; invalidate by document revision and resource lifetime. Preserve cancellation and release obsolete resources. Measure representative dense scenes when changing hot paths.
- Preserve staged/atomic file replacement, recovery, and save-before-close behavior. Failed or cancelled saves must preserve existing files and unsaved work.
- Keep Electron context isolation and narrow preload/IPC APIs. Use local codec and export paths; remote processing of user projects requires an explicit product requirement.

## Rust engine

The Rust engine in `engine/` is the only engine. It holds the open document and its history, runs every edit (a `styk-edit` session per document, reached through `src/engine/engine-owner.mjs`), evaluates and draws every frame, and makes every export. The interface keeps a read view of the document, patched from the session's answers, and its own view state (selection, playhead, tools); it never changes the document in place. `docs/RUST-ENGINE-PORT.md` records the migration.

- Commands: `npm run engine:build` (WebAssembly into `src/engine/pkg/`, required before the app can use the engine), `npm run engine:test` (Rust tests, seconds once built), `npm run engine:parity` (the Rust fixture suites, V8 `Math` fixtures, container checks and live-worker replays; `-- --corpus`), `npm run engine:bench` and `npm run engine:bench:summary <label>`.
- One owner per concern: `styk-doc` store, `styk-formats` containers, `styk-piv` Pivot codec, `styk-eval` evaluation and draw-list encoding, `styk-draw` the draw-list format, `styk-render` GPU, `styk-raster` CPU, `styk-edit` editing commands, `styk-drawing` drawing raster work (in the drawing workers), `styk-math` V8-exact `Math` functions, `styk-engine` scheduler and jobs, `styk-wasm` browser binding, `styk-cli` tools. JavaScript reaches the engine only through `src/engine/`.
- A new primitive kind or flag: define and document it in `styk-draw`, encode it in `styk_eval::drawlist`, draw it in `prim.wgsl` and `styk-raster`, with Rust tests of its encoding and of both renderers' output.
- A new evaluated feature or file field: unknown fields already survive in the store; read it into the typed views in `styk_eval::load`, evaluate it in `styk_eval`, with Rust tests that state the expected result and fail without it, and a test of what the interface reads of it (an owned editor: `tests/support/owned-editor.mjs`).
- A new effect: registry and parameters in `styk_eval::vfx`, evaluation fixtures, then a pass in `styk-render/src/effects/` and in `styk-raster/src/effects.rs` (`docs/engine/vfx.md`).
- Editing commands are `styk-edit` session commands; the owner installs each on the editor (`src/engine/engine-commands.mjs`, held to the session's dispatch by `tests/engine-owner-command-list.test.mjs`). A new or changed command: implement it in `styk-edit` with Rust tests, list it, and test it on an owned editor, undo and redo included. Interface code never writes the read view in place: every change is a session call (tests run the owner in verify mode, which catches in-place writes). The recorded tapes and fixtures (`engine/tests/**`, `engine/crates/*/tests/fixtures/`, `tests/fixtures/owner-references/`) are frozen: nothing re-records them, and a behaviour change updates the test that states it. A read of the frame on show never fails for a document that opened (`docs/engine/evaluation.md`). Arithmetic whose results are stored in documents uses `styk-math` (V8's `Math.sin`, `cos`, `atan2`, `hypot` bit for bit), never `f64::sin` and friends.
- Verify: Rust tests, `npm run engine:parity`, `npm test`, `npm run check`, and the app on the affected documents (`scripts/smoke-*.mjs`); update the engine docs whose contract changed and `engine/inventory.tsv` (`node scripts/engine-inventory.mjs --render`). Delete a module once nothing calls it.
- Never strip the WebAssembly profile (D10), block the interface thread (D7), or tune a parity threshold to pass (D13).

## Evidence and complexity

- For nontrivial fixes, identify the failing behavior, owning layer, and invariant to preserve. Reproduce the defect where practical; distinguish confirmed causes from hypotheses and state verification limits.
- Add focused behavioral regression coverage where useful, confirming it exposes the original defect where practical. Test observable outcomes; change expectations only when the contract changes or the old expectation is demonstrably wrong.
- Before adding helpers, state, caches, dependencies, or fallbacks, inspect existing implementations. Prefer clear ownership and current needs over speculative abstractions. Trace relevant indirect uses before deletion, including workers, dynamic imports, IPC, configuration, and packaging. Keep useful boundaries; line count is not a quality target.
- Compare performance on the same workload and settings, measuring the affected interaction, stalls, memory, and visual correctness as relevant. Report tradeoffs explicitly; CPU throttling does not establish behavior on other GPUs. Verify cancellation, stale results, disposal, and recovery when changing asynchronous work or resource lifetimes.
- Review the final diff for duplicated state, unnecessary abstractions, abandoned experiments, weakened tests, and scope expansion. Scale investigation and verification to the change; repeat or broaden passing checks only when new evidence warrants it. Documentation-only changes need documentation checks, not application benchmarks.

## Progressive commits

- During implementation, commit completed, coherent steps after their relevant checks pass. Keep each commit independently understandable and include its related tests and documentation. Use meaningful milestones rather than a commit per file or tool action; do not commit known-broken intermediate states.
- Review staged changes and stage only this task's files or hunks. Preserve unrelated work and other tasks' commits. Use a concise imperative subject describing the outcome, with a body explaining motivation or tradeoffs when useful. Do not include secrets or private user data.
- Local commits do not authorize pushing, publishing, or rewriting shared history. Follow explicit user instructions to leave work uncommitted. Keep release metadata together as required below.

## Environment and verification

Use locked dependencies and the runtimes in `.github/workflows/desktop-release.yml` (currently Node 24.11.0 and Python 3.12.9 for releases). Use `npm ci`; avoid incidental upgrades. See `README.md` for source setup and `scripts/requirements-build.txt` for packaging prerequisites. Run commands from the repository root.

If PowerShell's `npm` launcher reports a missing `npm-cli.js`, try `npm.cmd` from the same Node installation; it is verified on this workstation. Do not change global tools or dependencies to work around a launcher issue without diagnosing it first.

Scripts and agents that launch the app set `STYK_BACKGROUND_WINDOW=1`: the window opens off-screen, out of the taskbar and without focus, so it never covers the desktop of the person working on this computer.

Run `npm run check` after JavaScript changes and tests covering affected behavior. `npm test` covers root unit tests; desktop smoke scripts and browser tests are separate. Inspect rendered results for visual changes. Run relevant Python tests for backend/codec changes and representative benchmarks for performance changes. Rebuild native components when their source changes. Report missing prerequisites or unrelated failures accurately.

## Changelog and shipping

- `CHANGELOG.md` is public release history for people using the app. Add completed, user-relevant changes only to its top `Unreleased` section during development. Private or internal-only work, agent instructions, tests, refactors without observable effects, and build housekeeping do not need public entries; keep necessary engineering context in internal documentation or commits.
- Before completing a user-facing feature or fix, update its existing entry or add one concise entry. Describe what users can do or what problem is resolved in natural, plain language. Include technical detail only when it helps users understand compatibility, limitations, or an action they must take. Omit private implementation details, identifiers, paths, and diagnostic data.
- Write entries like a polished consumer app's release notes, following the style guide in `docs/RELEASING.md`: one short sentence per bullet (two at most), correct grammar and punctuation, and the feature or result first. Name a shortcut or where to find something at most; never walk through every button, option, or edge case. Never mention rendering, GPU, workers, caches, memory budgets, textures, engines, tests, fixtures, or other internals. Speed and memory work goes under `### Performance` as the effect people notice.
- Group related work by user-visible outcome rather than listing every code change. Read pending notes for equivalent wording; one outcome gets one entry, even across several tasks. Prefer "Fewer pauses when editing complex animations" over a list of cache, allocation, and worker changes. When extending an entry, keep it short: rewrite it instead of appending clauses. Keep future ideas out of release notes.
- For a release, follow `docs/RELEASING.md`: move pending entries into one new highest version, leave an empty `Unreleased` section, and align package versions. Before preparing notes, reread the whole section as someone using the app would, then trim, merge, and rewrite entries until it reads like a clean, human changelog. Subsequent work goes into `Unreleased`, never an older release.
- Run `npm run release:prepare` and `npm run changelog:check`. Commit the changelog, both package version files, and both generated note files together. Generate notes through the script; never append history to the current release payload.
- Published sections are immutable during ordinary work. Software fixes need a higher version. Review semantic duplicates manually; validation catches normalized text duplicates and structural errors, not equivalent meanings.
- Shipping includes exact-artifact verification and the history update. Implementing a feature alone does not authorize publishing. When shipping is authorized, complete the documented process without redundant approval. Tag pushes can publish immediately.
