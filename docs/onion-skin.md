# Onion skin sampling

Onion skin samples the same `evaluatedFrame` scene as the editor and renderer.
Keyframe mode chooses times from `sheetKeyTimes` when a layer sheet exists, matching
the Simple filmstrip's combined scene keys. Native keyframes remain compatibility
sources; their indices do not identify authored layer keys. Legacy documents use
their animation-channel keys or native frames. Output-frame mode samples neighboring
ticks independently of key spacing.

`OnionSkinCache` listens for document, edit, and history changes and also checks
document identity, revision, and layer-sheet identity when read. Layer publications
replace the sheet state, invalidating cached evaluations and key times together.
Native frame-index dependency hints apply only to the native timeline: they cannot
describe layer holds, tweens, or retained pose sources. A committed sheet change
marks cached poses for re-evaluation. The shared `RetainedGeometryCache` compares
the resulting objects exactly, including joined parent positions, and rebuilds only
changed geometry. Unchanged objects keep their tint and renderer artwork identities.
New neighboring samples use the same reuse path, preventing texture churn while
scrubbing. Document replacement and shared-definition edits discard the baseline.

Layer pose drags edit a private working frame, so ghosts retain committed poses
during the gesture and refresh when the sheet is published. Seeking, opacity,
tint, and selection changes reuse sampled geometry. Shared-definition changes
invalidate geometry even when the layer-sheet state is unchanged.

Regression checks cover both the legacy reader and the app's layer timeline:

- `node --test tests/onion-skin.test.mjs tests/onion-layer-sheet.test.mjs`
- `node --test tests/onion-performance.test.mjs`
- `node scripts/benchmark-onion-skin.mjs` compares onion on/off and asserts work budgets
- `node tests/onion-selection.browser.mjs` with the local server running
- `node tests/onion-performance.browser.mjs` verifies pointer drags and pixel parity on WebGPU and Canvas

The browser check enables onion skin before adding frames, checks the renderer's
ghosts through Simple and Advanced edits and history, and captures screenshots.
It also checks the topbar's selection-aware ordering for segments, branches, and
figures, including one-step movement and undo/redo.
