# VFX implementation

VFX use the existing layer/pose editing system. There is no separate VFX timeline or parameter-key interface; the Advanced timeline's Auto key also keys effect values. Effects are instance data and stay editable in native files.

## User interaction

The right panel has Properties, VFX, and Library tabs. VFX follows the selected figure or node; the target menu also offers Whole figure and Scene. Movieclip handles target the container artwork. Multiple selected figures receive independent stacks in one history operation.

The panel reads top down, from what receives effects to one effect's values. Its head names the target and holds *Apply to*. The list's own header, **Effects**, holds the Show choice (At this frame, Only selected, All with a search), Paste while something is copied, and **Add**, the one way to add: its catalogue switches between Effects and Presets. The head and the list header stay put while the rest scrolls. The effects on the target are one list of entries: each row is the effect's glyph on a tile in its category's tint, its name, its frame range, an eye, a ⋯ menu (Rename, Combine with another effect… or Add effect to group…, Move up/down, Copy animation, Duplicate, Delete; a right-click or Shift+F10 opens it too) and a chevron. Whenever the Show choice hides effects, a row says how many and offers Show all; an effect switched off with its eye stays listed where it would play. Clicking a row opens its settings under that row, between two full-width hairlines, and clicking it again closes them, so the settings never repeat the effect's name or sit apart from it: a grid of scrub label, slider and precise value, paint swatches, selects and switches, More for advanced parameters, then *Combine with another effect*, a full-width accent row always in view because combining is the usual next step (the ⋯ menu keeps it too); for a group its strength, then *Effects in this group* indented on a guide line as rows that open one at a time (each with its eye, ⋯ and a drag grip; Alt+Up/Down reorders) and *Add to group*; and Timing last. Pose effects from older projects share the list and open the same way, with a grip on hover to reorder in one history operation and their own ⋯ (Move up/down, Copy effect, Duplicate, Reset, Remove). An empty target offers twelve one-click starting points; with nothing selected, the panel offers only *Scene effects*, which applies to the whole picture. Searchable effect and preset popups use the same registry and scope rules. Labels retain the standard horizontal scrub interaction. A continuous slider or scrub previews through the existing editor transaction and creates one undo entry. Held exposures, interpolated frames, frame insertion, and frame copying keep the same behavior as Properties. Existing timeline controls own timing and easing.

No captions, effect-cost badges, or additional animation modes appear in this panel; an effect clip's value key is a quiet toggle in the row's right margin, shown on hover and once the value is animated. Presets install ordinary editable effects. Power up, Teleport, Impact, Hologram, Ice, Poison, Neon, Golden hour, and Retro screen join the original presets. Copy/paste gives each pasted effect a fresh identity. Selecting a row opens its settings and enables its canvas handles; changing targets or tabs hides the handles. Canvas drags use one stack transaction and Escape cancels it. Locked targets cannot be edited.

## Current catalogue

| Effect | Parameters |
| --- | --- |
| Tint | Color, mix |
| Glow | Core/halo paints, radius, intensity, placement, spread, falloff, blend |
| Outline | Paint, width, opacity, placement, rounded, outline only |
| Blur | Mode, radius, angle, center |
| Shadow | Paint, softness, X/Y offset, angle/distance, spread, opacity, placement |
| Color grading | Exposure, contrast, saturation, temperature, tint, shadows, highlights, gamma |
| Pixelate | Linked cell width/height, grid X/Y |
| Noise | Amount, grain size, color grain, pattern, contrast, softness, seed, evolution |
| Vignette | Amount, softness, paint, center, roundness, aspect, radius |
| Dissolve | Progress, pattern scale, edge width/paint, softness, seed |
| RGB split | Amount, angle, individual channel offsets |
| Wave distortion | Strength, wavelength, angle, phase |
| Shockwave | Radius, thickness, strength, center, falloff |
| Bloom | Threshold, soft knee, radius, intensity, paint |
| Light sweep | Position, angle, width, softness, intensity, paint |
| CRT / scanlines | Scanlines, spacing, curvature, RGB fringe, phase, paint |
| Turbulent displacement | Amount, scale, evolution, detail, seed |

Generated effects — Particles, Aura, Energy beam and Explosion — create artwork rather than filtering it and live only in effect clips.

Every effect also has an animatable **Effect strength** from 0–100%. It mixes the completed effect with its input in premultiplied alpha. Zero strength bypasses filter work; 100% avoids the extra mixing pass. Older saved stacks resolve to 100% without changing their saved data.

Scene catalogues include camera distortions and CRT; object catalogues include silhouette effects. Vignette, Shockwave, and CRT are camera effects. Preset choices are filtered by their component effects.

Turbulent displacement uses up to four normalized coherent-noise octaves in a single GPU pass. Its two displacement components are each bounded by Amount, which also supplies the conservative tile guard. Evolution moves continuously through the noise field; seed and explicit evolution determine the output independently of playback order. WebGPU and WebGL implement identical kernels.

## Ownership, storage, and animation

`src/vfx-registry.mjs` owns the effect schemas, scope rules, icons, and conditional/advanced inspector fields. `src/vfx.mjs` owns limits, validation, parameter descriptors, interpolation, padding, and remapping. Each stack contains at most 16 records:

```js
{version: 2, id: 'fx-stable-id', type: 'glow', enabled: true,
 params: {color: 0x66ccff, radius: 12, intensity: 0.8}}
```

Saved poses use `_stykVfx.figure` for a figure/movieclip/scene stack. Node stacks use `_stykVfx['figureTypeId/handleId']`, scoped to the native physical handle and figure definition, never an array index. The owning pose supplies the instance UID. No GPU or UI state enters saved data.

`src/editor-vfx.mjs` reads the effect stacks and clips the interface shows; every effect edit is an engine session command with the editor's history. The property adapter accepts `vfxStack` and typed `vfx1:type:effectId:parameter` addresses. The layer sheet composes these into its ordinary source poses and then discards the temporary property entries. It never creates a second set of animation tracks. Legacy documents without a layer sheet can still use the existing property adapter.

Matching effect IDs/types interpolate numeric/color parameters through the existing pose easing. Enabled state, stack membership, seed, and order are discrete. New effects are not introduced before their source exposure. Remove/reset/reorder edit the current exposure like other pose edits. Copying frames, physical rig remapping, foreign definition remapping, undo/redo, native save, and recovery preserve ownership.

## Your own presets

*Save as preset* (the last line of an effect's settings, and its ⋯ menu) names the selected effect clip and keeps it outside any project: its effects with their settings, strength, fades, frame length and keys, but not its target. A name already in use asks before replacing that preset. The catalogue's Presets tab starts with **My presets**, one row each with what it holds ("2 effects · animated") and a ⋯ to rename or delete it; an empty figure's suggestions start with up to three of them. Adding one makes an ordinary effect clip with new ids and its keys moved onto them, as one undo step; a timed preset starts at the playhead. Presets are outside undo, and deleting one never changes effects already added from it.

`src/vfx-user-presets.mjs` owns the data (at most 60 presets, 60-character names, 4,000 keys each; stored data is validated by building the clip it makes, and an unreadable preset is left out rather than hiding the others) and `vfxPresetStore`, which shows a change at once, queues writes and restores the previous list if a write fails. The desktop app keeps them in `vfx-presets.json` in the profile (up to 1 MB, written atomically through `desktop/preferences.cjs`) behind `getVfxPresets` and `setVfxPresets`, apart from the 16 KB editor settings; the browser build uses localStorage. `src/vfx-preset-ui.mjs` draws the save dialog, the My presets rows and their menu. `node --test tests/vfx-user-presets.test.mjs` covers the data and the store; `node tests/vfx-user-presets.browser.mjs` saves, adds, renames, reloads and deletes through the panel.

## Composition

Node artwork effects feed figure effects. Each movieclip composites its children, applies its local scene stack and container stack, and applies the container opacity once. Figure opacity likewise applies to the completed effect result. Native figure outlines remain part of the base artwork. A VFX outline expands the composited alpha silhouette.

Scene effects process the camera output after object effects. During editing, the workspace remains in world coordinates: the engine draws the artwork and the background into an offscreen camera image, applies the scene effects to it, and projects the result into the moved/rotated/scaled camera rectangle. The surrounding workspace is unchanged. Backgrounds follow the actual camera. Onion skins and editing handles render afterward as editor overlays. The camera preview is capped at 2048 pixels on its longest side; saved values and export resolution are unchanged.

Playback filters the full camera image with the prepared frame's scene stack. Zooming or panning cannot change offscreen filter neighborhoods. Thumbnails, the camera monitor and export draw the same effects with the same engine passes. Local movieclip samples include their child effects and scene effects. Converting a selection into a movieclip does not capture the parent scene's effects a second time.

Object sizes use local artwork units and scale with the instance. Scene sizes use project output pixels. Noise is deterministic from spatial coordinates, seed, and explicit evolution; no wall-clock state or playback history enters evaluation. Pixel grids and blur downsampling are anchored independently of tile crops.

## Rendering and resource lifetime

The engine runs the filters: `styk-render/src/effects/` on the GPU and `styk-raster/src/effects.rs` on the CPU, from the effect layers the draw list carries ([engine/vfx.md](engine/vfx.md#rendering)). The interface only describes them.

- Fullscreen passes run the filters in order on GPU textures with no CPU pixel readback.
- Blur uses three separable box passes per axis as a Gaussian approximation. Large radii downsample on a stable grid and upsample afterward. Outline uses separable alpha dilation; its rounded mode composes bounded 16-direction dilation passes, while legacy square outlines retain separable dilation. All color math is SDR, with premultiplied alpha at composition boundaries.
- A layer filters its owner's crop plus the padding its effects need (`vfx::padding`, `vfx::sampling_padding`), so spatial filters read real neighbouring artwork and background pixels, rather than transparent borders added to an already clipped camera image. Effect centers, noise, paint coordinates and scale stay anchored to the complete output, whatever the zoom, camera preview, export tile, thumbnail or playback crop. Tiny Gaussian blur guards cover the kernels' minimum size even at reduced resolution.
- Selection handles follow the effect result.

A document without effects allocates no effect textures and draws through the vector path. The working textures of a filter are transient and bounded by the engine's budgets ([engine/rendering.md](engine/rendering.md), [engine/memory.md](engine/memory.md)), separate from the picture caches; partial strength keeps one extra copy of the original input only when needed. This is a bounded working set, not a claim that a large effect stack is free.

Tiled export uses a small antialiasing overlap, and scene preparation owns one effect halo on every edge, including the outside of the camera. Source culling and image decoding use that expanded surface. No-effect scenes do not allocate an effect source. A request whose effect neighborhood exceeds the surface limits fails explicitly rather than omitting effects. Native saving remains independent of graphics availability.

## File behavior

`.styk`, `.stkz`, and `.stykmov` retain editable effects. Raster and video exports use the shared rendering path. SVG with active effects embeds the rendered frame as PNG at the requested dimensions; SVG without effects retains its vector path. PIV/STK export rejects effects rather than silently losing them. Combining separately filtered figures or breaking/baking a filtered movieclip container is rejected when its compositing cannot be represented by independent editable figures.

## Extension contract

A new effect needs a registry schema, validation/interpolation semantics, identity/no-op behavior, conservative sampling padding, a GPU pass and a CPU pass in the engine, and catalogue scope. Add model, export parity, and representative performance checks. The registry describes saved data; rendering resources stay in the engine's render crates; UI state stays in the inspector.

## Verification

- `node --test tests/vfx.test.mjs`: exposure semantics, tween/frame insertion, history, cancellation, presets, instance isolation, rig remapping, and reopening.
- `node tests/vfx.browser.mjs`: binary native round-trip, lossy-format rejection, real slider and label drags, and tab navigation.
- `node --test tests/vfx-strength.test.mjs`: compatible strength defaults, interpolation, zero-strength bypass, layer edits/undo/reopen, and turbulence bounds.

Browser scripts use installed Chrome and a local server at `http://127.0.0.1:47832`; override with `STYK_TEST_URL`. Measurement output is in `artifacts/vfx/`. Results depend on hardware, area, radius, and animated content. The measured 1,000-figure camera-editing case improved from approximately 35 ms to 5 ms median after sharing retained GPU artwork. Rebuilding geometry while animating ten glows remains a heavier case (approximately 23 ms median on the measured NVIDIA Lovelace device). Cold shader initialization remains a separate cost.

## Expanded controls and rendering

Glow includes inner/outer/both placement, spread, falloff, core and halo paints, and Normal/Add/Screen blending. Outline supports outside/inside/center placement, rounded edges, and outline-only output. Shadow adds spread and inner placement; angle/distance are derived views of the existing X/Y offsets, never duplicate saved state. Blur offers Gaussian, directional, zoom, and radial kernels with bounded sampling. Grading adds shadows, highlights, gamma, and green/magenta balance. Pixelation has linked or independent dimensions and grid offsets. Noise adds color grain, coherent clouds, contrast, and softness. Vignette adds center, aspect, roundness, radius, and paint.

New effects are Dissolve, RGB split, Wave distortion, Shockwave, Bloom, Light sweep, and CRT/scanlines. Their Progress, Phase, and Evolution controls remain ordinary pose parameters. None relies on elapsed wall-clock time. Spatial kernels use stable full-owner coordinates; curved CRT exports include their displaced sampling neighborhood in tile guards.

Every VFX color accepts either the legacy RGB integer or the existing normalized paint format: solid, linear, radial, angular, or diamond, with up to 32 stops and stop opacity. `vfx-paint.mjs` handles adaptation/interpolation; the GPU evaluates stops directly. Matching gradient layouts interpolate colors, offsets, opacity, and angle. Changes between gradient kinds or stop counts are discrete; solid/gradient transitions interpolate using the gradient layout. Version 1 stacks resolve compatible defaults lazily without mutating the document. New edits write version 2 records.

The stage header's Effects preview toggle (`#vfx-preview`) is a preview bypass. The engine stage turns effects off for the frames it draws (`Stage::set_effects`, `EngineHandle::set_effects` for prepared playback). It does not change the document, undo history, native saves, or export output. Handles and preview options never enter saved data.

`vfx-gizmos.mjs` projects the selected effect's controls into camera or owner coordinates. It supports effect centers, shadow offset, blur/RGB direction, radii, grid/cell sizes, wavelength/strength, dissolve progress, light-sweep position, and CRT curvature. Only the selected, enabled, unlocked effect receives controls; playback never evaluates editor geometry for these overlays.

The engine's effect fixtures and render tests cover the expanded kernels, multi-stop gradients and tiled parity; the VFX browser scripts cover search, preset application, mouse/keyboard reordering, picker commits, canvas drag/cancel, selection visibility, and bypass isolation. The dense-scene benchmark adds distortion and bloom/CRT combinations. On the measured NVIDIA Lovelace device, those combinations took approximately 4–5 ms median at 1280×720 with 1,000 figures (measured on the earlier JavaScript renderer). Splitting shader compilation reduced the tested first grading/noise render from approximately 1,194 ms to 158 ms. These are local measurements; shader initialization, large radii, gradients, and changing artwork still have costs.
