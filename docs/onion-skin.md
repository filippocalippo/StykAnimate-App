# Onion skin sampling

Onion skin starts enabled each session. Press O or use the timeline's Onion skin
button to toggle it; its range and appearance preferences stay saved.

Onion skin samples the same `evaluatedFrame` scene as the editor and renderer.
Keyframe mode samples each visible user layer's keys independently when a layer
sheet exists. Camera, Scene and other layers cannot use up its neighbouring poses;
blank exposures are skipped. The selected range still measures output-frame
distance, and Step spaces the keys within each layer. Native keyframes remain compatibility
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
Layer subsets share each full-scene sample. The warm sample budget counts unique
evaluations, while styled layer wrappers stay reusable across nearby seeks.

Layer pose drags edit a private working frame, so ghosts retain committed poses
during the gesture and refresh when the sheet is published. Seeking, opacity,
tint, and selection changes reuse sampled geometry. Shared-definition changes
invalidate geometry even when the layer-sheet state is unchanged.

Completed ghost pixels belong to the renderer, separately from sampled geometry.
Without Scene VFX, default ghosts sit immediately behind the current artwork
on their own layer, above lower layers such as an opaque floor. A blank current
layer retains the same place in the stack. Show on top still places all ghosts
above current artwork.
Scene VFX retains ghosts as an unfiltered overlay above the completed camera preview.
Both backends cache contiguous ghost layers within a hardware-derived memory
budget, retaining committed pixels during live poses. View, visibility, resource,
and sampled-geometry changes invalidate the affected layer. The
[engine's rendering](engine/rendering.md) describes compositing, admission, and disposal.

Regression checks cover both the legacy reader and the app's layer timeline:

- `node --test tests/onion-skin.test.mjs tests/onion-layer-sheet.test.mjs`
- `node --test tests/onion-performance.test.mjs`
- `node tests/onion-selection.browser.mjs` with the local server running

The browser check enables onion skin before adding frames, checks the renderer's
ghosts through Simple and Advanced edits and history, and captures screenshots.
It also checks the topbar's selection-aware ordering for segments, branches, and
figures, including one-step movement and undo/redo.
