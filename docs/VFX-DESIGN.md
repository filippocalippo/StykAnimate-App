# VFX implementation

VFX are instance data: effect clips on a figure, a node or the scene (with their own timing, fades and per-value keys, shown as effect lanes under their layer in the Advanced timeline), and the per-pose effect stacks of older projects, which key through their poses. Effects stay editable in native files.

## User interaction

The right panel has Properties, VFX, and Library tabs. VFX follows the selected figure or node; *Apply to* also offers Whole figure and Scene. Movieclip handles target the container artwork. Multiple selected figures receive independent stacks in one history operation.

The panel reads top down, from what receives effects to one effect's values, and shows a thing when it exists or is selected, not always:

- **The head** is one line: the target's glyph and name, and *Apply to* as a quiet choice at its end whose value is the scope ("This part ▾"); on a narrow panel the word "Apply to" folds into the choice's tooltip and accessible name, and the value stays whole.
- **The list header**: **Effects**, the Show choice (At this frame, Only selected, Show all with a search), *Paste* while something is copied (the last thing copied: an effect clip, one effect copied out of a group, or an older pose effect), and **Add**, the one way to add. The head and the list header stay put while the rest scrolls.
- **A row** per effect: its glyph on a tile in its category's tint, its name, its frame range, a quiet dot when it carries a notice, an eye, a ⋯ menu (Copy effect, Duplicate ─ Move up, Move down ─ Rename…, Combine with another effect… or Add effect to group…, Save as preset… ─ Shuffle (seeded effects), Reset effect, Delete; a right-click or Shift+F10 opens it too) and a chevron. A grip on hover reorders effect clips by dragging, or Alt+Up/Down on the grip, as one undo step. Whenever the Show choice hides effects, a row says how many and offers Show all; an effect switched off with its eye stays listed where it would play.
- **The open card.** Clicking a row opens its settings under it as one bordered card, and clicking it again closes them. The card holds, in order: a short notice when there is one; **the few values that define the effect** (three to five, in the order a person thinks of them: Glow's Color, Radius, Intensity, Placement and strength; Particles' Look, Color, Emission, Rate or Count, Size); then the rest of its values: a small effect (about six values or fewer besides the defining ones, counting a pair as two: every filter today) keeps them all in **one section**, *More settings*, in a sensible order, and a large one (the five generated effects) in **titled sections**, one quiet line each until opened (Core, Shape, Motion, Life, Look, Emitter, Rhythm, Variation, Blend…); a dot on a title says a value inside is animated, and an open section is remembered per effect type for the session; for a group its strength, then its effects as rows that open one at a time on a guide line (each with its eye, ⋯ and a drag grip; Alt+Up/Down reorders); **Timing**; and **the foot**: *Combine* (or *Add to group*) on the left, Shuffle (seeded effects), Reset effect and Save as preset as quiet icons on the right.
- **Timing** is one line while an effect plays for the whole animation ("Timing · Whole animation ▾"); for a frame range it adds Start, Duration, Fade in and Fade out as values, the fades the same ones the timeline's fade handles drag. A clip's own strength leads the card when it matters: for a group, or when it is not 100%.
- **A value shows only while it does something** (a burst's Count, a circle emitter's size, a glow's core colour while its core shows, a directional blur's angle), and every value has a one-line description its tooltip and screen reader give.
- **Effects from older projects** (per-pose stacks) are listed under a quiet "From an older version" with the same rows and the same open card (their values key through the poses, so their fields carry no key), their ⋯ menu (Copy effect, Duplicate, Move up/down, Reset, Remove) and a foot with Shuffle and Reset. Opening a project never converts them.

**No word in the panel is cut**, at any dock width from 256 to 420px and in a longer language: names and captions wrap to a second line, a label that does not fit beside its value wraps under itself (the value never shrinks), the suggestions and the catalogue go to one column below 300px and Timing below 236px.

An empty target offers one-click starting points (effects by name, presets with a short caption, "Moment · 4 f" or "Look · 2"; the catalogue's preview card says the rest); with nothing selected the panel offers only *Scene effects*. Locked targets cannot be edited.

### The value control

Every number in the panel is the shared value field (`docs/design/components.md`, Value field; `src/inspector-kit.mjs` renders it, `src/property-controls.mjs` drives it, the Properties tab uses the same control): its label, a quiet fill showing where a bounded value sits on its travel (from zero for a value that runs both ways), a small tick at its default, and the value with its unit. A drag anywhere on it scrubs from where the value is, never jumping; Shift is fine (×0.1), Alt finer (×0.01), Ctrl or ⌘ coarse; a tap types the value (arrow keys step, Page Up and Down move a tenth of the travel, Enter commits, Escape cancels); a second tap resets it to its default; each gesture is one undo step. Wide ranges follow a log or power scale (`src/ui/value-scale.mjs`), so a particle count of 1 to 5000 or an emitter of 0 to 4000 px gives the small values most of the travel. Angles get a dial that turns to the pointer. Its companions follow the same pattern: a colour field (label, swatch, hex or "Gradient"; the paint picker with gradients and alpha), a choice in a field for two or three short options, a menu beyond that, a **visual picker** with rendered stills for a particle's look and a generated effect's style (`src/vfx-style-picker.mjs`; a retired style is offered only to the effect that already uses one), a switch, a seed with Shuffle, and a pair (a cell's width and height with their link, a centre's X and Y) that stacks its two fields.

An effect clip's value carries its key at the field's end: quiet until the field is hovered or focused, an outline once the value is animated, filled on a key at this frame. Creating a value's first key also selects it; once a value has keys, editing it sets a key at the playhead. A right-click on a value (or Shift+F10) opens its menu: Reset value, Add or Remove key at frame N, Previous key, Next key. The strip pinned at the panel's foot while the clip has keys navigates the chosen value's keys and edits the easing of the key at the playhead.

### Presentation

`src/vfx-presentation.mjs` owns how each effect is presented, keyed by effect type and parameter name and combined with the registry's descriptors at render time: the defining values and their order, the sections, each value's control, scale, shown unit and `when` condition, clearer names (`vfxPanel.label.<type>.<param>`, else the registry's), the one-line descriptions (`vfxPanel.help.<type>.<param>`, else `vfxPanel.help.common.<param>`), the catalogue's groups and which presets are moments. A parameter it does not name still appears, under "More settings" with a control chosen from its descriptor, so parameters added to the registry are never lost; names it mentions that the registry lacks are skipped. `src/vfx-effect-view.mjs` renders one open effect from it (segments only while their words are short in the person's language, a menu otherwise); `tests/vfx-presentation.test.mjs` holds that every saved value has exactly one home and every value has a name and a description.

### The catalogue

*Add* opens a popover with search and an **Effects │ Presets** switch. Effects are grouped by what they do, the ones a stick-figure animator reaches for first: **Generate** (Particles, Explosion, Energy beam, Aura, Smoke, as rendered stills), **Glow and outline** (Glow, Outline, Shadow), **Color and light** (Tint, Color grading, Bloom, Light sweep, Vignette), **Blur and distort** (Blur, RGB split, Wave distortion, Shockwave, Turbulent displacement, Dissolve) and **Texture** (Noise, Pixelate, CRT / scanlines); a type the registry gains later joins "More effects". Presets start with My presets, then **Moments** (Teleport, Impact, Hit flash: short, with their length) and **Looks** (lasting). Hovering a card for a moment, or reaching it with the keyboard, shows a preview card beside the catalogue (`src/vfx-catalog-peek.mjs`): a still of the effect or preset on a figure drawn by the engine, its name, one line on what it does and, for a preset, what it adds. A search finds names and group titles anywhere and what an effect does from the start of a word.

Until built-in presets carry their own timing, a moment is placed at the playhead for a few frames with its fades (`MOMENT_TIMING` in `src/vfx-presentation.mjs`: Hit flash 4 frames fading out over 3, Impact 6 over 4, Teleport 16 with fades of 4 and 8), in the same undo step as adding it. **The engine task that gives presets timing provides:** `duration`, `fadeIn`, `fadeOut` (and keys) on the preset in `vfx_presets.json` and `src/vfx-presets.mjs`, applied by `addVfxGroup`; `presetTiming()` then uses the preset's own timing, and a clip the engine already timed is left as it is.

### Notices

A short, quiet notice shows at the top of an effect's open card, with a small dot on its row while it is closed:

- the engine drew it at reduced quality: `VfxInspector.setEffectNotice(clipId, {kind: 'reduced', effect?})` sets it (one effect of a group with `effect`), `setEffectNotice(clipId, null)` clears it, and a new document clears all. **The engine task wires it** from the frame's report of which clips it drew at reduced resolution or dropped (today it lowers effect resolution silently under its raster budget, its texture limit and its layer cap, docs/engine/vfx.md); the panel needs only the clip ids, per frame on show, and calls the function when the set changes;
- a beam locked onto a figure that is not in this frame aims at its stage point (the panel checks this itself);
- connected effects that cannot reach the whole figure (more than 16 nested groups, or a missing owner) say so in the person's language under the head.

### Canvas handles

Selecting an effect enables its canvas handles; changing targets or tabs hides them. `vfxHandles` and `vfxHandleValues` (`src/vfx-gizmos.mjs`) compute them: a filter measures from its centre or its target's bounds; a figure's generated effect measures from where the engine emits it (the figure's root point, or the selected node's joint; an explosion on a figure from the middle of what it draws); a scene's generated effect from its own stage position. Dissolve's progress runs round a ring like a clock hand (a dissolve is a noise threshold with no direction), or along its angle when it is directional. A drag is one transaction and Escape cancels it.

No effect-cost badges or extra animation modes appear in the panel. Presets install ordinary editable effects. Copy and paste give each pasted effect a fresh identity; one effect copied out of a group pastes as its own clip with its keys.

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

Generated effects — Particles, Aura, Energy beam, Smoke and Explosion — create artwork rather than filtering it and live only in effect clips.

Every effect also has an animatable **Effect strength** from 0–100%. It mixes the completed effect with its input in premultiplied alpha. Zero strength bypasses filter work; 100% avoids the extra mixing pass. Older saved stacks resolve to 100% without changing their saved data.

Scene catalogues include camera distortions and CRT; object catalogues include silhouette effects. Vignette, Shockwave, and CRT are camera effects. Preset choices are filtered by their component effects.

Turbulent displacement uses up to four normalized coherent-noise octaves in a single GPU pass. Its two displacement components are each bounded by Amount, which also supplies the conservative tile guard. Evolution moves continuously through the noise field; seed and explicit evolution determine the output independently of playback order. WebGPU and WebGL implement identical kernels.

## Ownership, storage, and animation

`src/vfx-registry.mjs` owns the effect schemas, scope rules, icons, and conditional fields; `src/vfx-presentation.mjs` owns how the panel presents them (above). `src/vfx.mjs` owns limits, validation, parameter descriptors and the editor-bounds padding; interpolation and remapping are the engine's (docs/engine/vfx.md). Each stack contains at most 16 records:

```js
{version: 2, id: 'fx-stable-id', type: 'glow', enabled: true,
 params: {color: 0x66ccff, radius: 12, intensity: 0.8}}
```

Saved poses use `_stykVfx.figure` for a figure/movieclip/scene stack. Node stacks use `_stykVfx['figureTypeId/handleId']`, scoped to the native physical handle and figure definition, never an array index. The owning pose supplies the instance UID. No GPU or UI state enters saved data.

`src/editor-vfx.mjs` reads the effect stacks and clips the interface shows; every effect edit is an engine session command with the editor's history. The property adapter accepts `vfxStack` and typed `vfx1:type:effectId:parameter` addresses. The layer sheet composes these into its ordinary source poses and then discards the temporary property entries. It never creates a second set of animation tracks. Legacy documents without a layer sheet can still use the existing property adapter.

Matching effect IDs/types interpolate numeric/color parameters through the existing pose easing. Enabled state, stack membership, seed, and order are discrete. New effects are not introduced before their source exposure. Remove/reset/reorder edit the current exposure like other pose edits. Copying frames, physical rig remapping, foreign definition remapping, undo/redo, native save, and recovery preserve ownership.

## Your own presets

*Save as preset* (the open effect's foot, and its ⋯ menu) names the selected effect clip and keeps it outside any project: its effects with their settings, strength, fades, frame length and keys, but not its target. A name already in use asks before replacing that preset. The catalogue's Presets tab starts with **My presets**, one row each with what it holds ("2 effects · animated") and a ⋯ to rename or delete it; an empty figure's suggestions start with up to three of them. Adding one makes an ordinary effect clip with new ids and its keys moved onto them, as one undo step; a timed preset starts at the playhead. Presets are outside undo, and deleting one never changes effects already added from it.

`src/vfx-user-presets.mjs` owns the data (at most 60 presets, 60-character names, 4,000 keys each; stored data is validated by building the clip it makes, and an unreadable preset is left out rather than hiding the others) and `vfxPresetStore`, which shows a change at once, queues writes and restores the previous list if a write fails. The desktop app keeps them in `vfx-presets.json` in the profile (up to 1 MB, written atomically through `desktop/preferences.cjs`) behind `getVfxPresets` and `setVfxPresets`, apart from the 16 KB editor settings; the browser build uses localStorage. `src/vfx-preset-ui.mjs` draws the save dialog, the My presets rows and their menu. `node --test tests/vfx-presentation.test.mjs` covers the presentation (every value has one home, a name and a description; the catalogue's groups; moments). `node --test tests/vfx-user-presets.test.mjs` covers the data and the store; `node tests/vfx-user-presets.browser.mjs` saves, adds, renames, reloads and deletes through the panel.

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

Browser scripts use installed Chrome and the server at `STYK_URL` (`http://127.0.0.1:47831` by default; `npm run test:browser` sets it). Measurement output is in `artifacts/vfx/`. Results depend on hardware, area, radius, and animated content. The measured 1,000-figure camera-editing case improved from approximately 35 ms to 5 ms median after sharing retained GPU artwork. Rebuilding geometry while animating ten glows remains a heavier case (approximately 23 ms median on the measured NVIDIA Lovelace device). Cold shader initialization remains a separate cost.

## Expanded controls and rendering

Glow includes inner/outer/both placement, spread, falloff, core and halo paints, and Normal/Add/Screen blending. Outline supports outside/inside/center placement, rounded edges, and outline-only output. Shadow adds spread and inner placement; angle/distance are derived views of the existing X/Y offsets, never duplicate saved state. Blur offers Gaussian, directional, zoom, and radial kernels with bounded sampling. Grading adds shadows, highlights, gamma, and green/magenta balance. Pixelation has linked or independent dimensions and grid offsets. Noise adds color grain, coherent clouds, contrast, and softness. Vignette adds center, aspect, roundness, radius, and paint.

New effects are Dissolve, RGB split, Wave distortion, Shockwave, Bloom, Light sweep, and CRT/scanlines. Their Progress, Phase, and Evolution controls remain ordinary pose parameters. None relies on elapsed wall-clock time. Spatial kernels use stable full-owner coordinates; curved CRT exports include their displaced sampling neighborhood in tile guards.

Every VFX color accepts either the legacy RGB integer or the existing normalized paint format: solid, linear, radial, angular, or diamond, with up to 32 stops and stop opacity. `vfx-paint.mjs` handles adaptation/interpolation; the GPU evaluates stops directly. Matching gradient layouts interpolate colors, offsets, opacity, and angle. Changes between gradient kinds or stop counts are discrete; solid/gradient transitions interpolate using the gradient layout. Version 1 stacks resolve compatible defaults lazily without mutating the document. New edits write version 2 records.

The stage header's Effects preview toggle (`#vfx-preview`) is a preview bypass. The engine stage turns effects off for the frames it draws (`Stage::set_effects`, `EngineHandle::set_effects` for prepared playback). It does not change the document, undo history, native saves, or export output. Handles and preview options never enter saved data.

`vfx-gizmos.mjs` projects the selected effect's controls into camera or owner coordinates. It supports effect centers, shadow offset, blur/RGB direction, radii, grid/cell sizes, wavelength/strength, dissolve progress, light-sweep position, and CRT curvature. Only the selected, enabled, unlocked effect receives controls; playback never evaluates editor geometry for these overlays.

The engine's effect fixtures and render tests cover the expanded kernels, multi-stop gradients and tiled parity; the VFX browser scripts cover search, preset application, mouse/keyboard reordering, picker commits, canvas drag/cancel, selection visibility, and bypass isolation. The dense-scene benchmark adds distortion and bloom/CRT combinations. On the measured NVIDIA Lovelace device, those combinations took approximately 4–5 ms median at 1280×720 with 1,000 figures (measured on the earlier JavaScript renderer). Splitting shader compilation reduced the tested first grading/noise render from approximately 1,194 ms to 158 ms. These are local measurements; shader initialization, large radii, gradients, and changing artwork still have costs.
