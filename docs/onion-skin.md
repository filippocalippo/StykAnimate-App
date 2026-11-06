# Onion skin sampling

Onion skin starts enabled each session. Press O or use the timeline's Onion skin
button to toggle it; its range and appearance preferences stay saved.

The engine's session plans the skins (`styk-edit/src/onion_skins.rs`) and the stage
draws them (`styk-wasm` `Stage::set_onions`); the interface sends the settings, the
selection and the figures it hides (`OnionController.request`) and holds no ghost of
its own. Each skin is the document evaluated at its tick, the same `evaluatedFrame`
scene as the editor and the stage, so it shows the committed pose, never the draft of
a gesture in progress.

Keyframe mode samples each visible user layer's keys independently when a layer
sheet exists. Camera, Scene and other layers cannot use up its neighbouring poses;
blank exposures are skipped. The selected range is a distance in ticks, and Step
spaces the keys within each layer. Drawing layers show the nearest drawings either
side of the playhead, never repeating the one on screen. Native keyframes remain
compatibility sources; their indices do not identify authored layer keys. A document
without a layer timeline uses its native frames; one that has only property channels
of its own shows no skins. Output-frame mode samples neighboring ticks independently
of key spacing. At most 48 skins are drawn, the nearest ones.

Which figures of a skin are drawn is the scope (the selected figures, with the ones
joined to them when Joined is on), the figures the interface hides, the layers that are
hidden, and, in keyframe mode, the layer the skin samples. Opacity fades with the
distance when Fade is on; the tint of each side is the setting's colour.

The plan is one set of skins for the document, the playhead and the request, kept until
one of them changes; the evaluated poses are kept for as long as the document is the
same, so scrubbing past neighbours already sampled evaluates nothing again. The stage
keeps a pose per sampled tick and builds its geometry once, when it is first drawn.
Document replacement and edits drop them.

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

Regression checks:

- `cargo test -p styk-edit --lib views_tests` (the plan, on a layer sheet with drawing layers)
- `node --import ./tests/support/register-engine.mjs --test tests/onion-skins.test.mjs tests/onion-controller.test.mjs`
- `node tests/onion-selection.browser.mjs` with the local server running

The browser check enables onion skin before adding frames, checks the skins the engine
plans through Simple and Advanced edits and history, and captures screenshots.
It also checks the topbar's selection-aware ordering for segments, branches, and
figures, including one-step movement and undo/redo.
