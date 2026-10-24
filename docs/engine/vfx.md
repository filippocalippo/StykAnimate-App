# Engine: visual effects

How the Rust engine (`engine/crates/styk-eval/src/vfx/`) decides, for one tick, which effects apply to what and with which parameter values. The user-facing behaviour is in [`VFX.md`](../VFX.md), [`VFX-DESIGN.md`](../VFX-DESIGN.md) and [`VFX-GENERATORS.md`](../VFX-GENERATORS.md); the JavaScript editor is the oracle while both exist ([`RUST-ENGINE-PORT.md`](../RUST-ENGINE-PORT.md)). Drawing the effects is the renderer's ([Rendering](#rendering)).

## Contract

- `Prepared::evaluate(tick)` (and `evaluate_clip`) fills `Frame::vfx: Option<Arc<vfx::FrameVfx>>`: everything a renderer draws for effects at that tick, or `None` when there is nothing. When `Prepared::has_vfx` is false (no effect clip and no per-pose stack in the document or its movieclips) evaluation does no effect work and allocates nothing.
- `FrameVfx` holds, by object slot:
  - `scene`: the camera image's stack, the scene's per-pose stack then its clips;
  - `objects[slot]` (`FrameVfx::object`): `figure`, the stack of the object's own artwork; `attached`, the connected group it owns (its stack and member slots); `segments`, node stacks by handle id;
  - `roots`: the slots owning a drawn connected group, in compositing order (smaller groups first, so nested groups filter before the groups containing them);
  - `generators`: generated effects inside their clip's range, with their parameters, opacity and start (what the editor's reference dump lists); what they draw is a separate batch ([Generated effects](#generated-effects));
  - `warnings`: connected groups nested too deep.
- Every stack is what `activeVfx` returns, in render order: enabled filters that change their input, each an `Arc<vfx::Effect>` whose `Params` is one struct per effect type with typed fields (`f64`, `Color` for an RGB integer or a paint, an enum per option list, `bool` switches, `u32` seeds and counts). Values are those the editor hands an executor: keys sampled, poses tweened, `effectStrength` multiplied by the clip's strength and fades.
- `vfx::padding`, `vfx::sampling_padding` and `vfx::working_slots` take such a stack (`vfxPadding`, `vfxSamplingPadding`, `vfxWorkingSlots`).
- Saying what must be drawn: `Document::unsupported` does not name effects, since they are evaluated. A frame whose `vfx` is `Some` has effects the renderer must draw, and `vfx::document_has_vfx` (`documentHasVfx`) tells whether a document carries any at all. The engine draws every filter and every generated effect ([Rendering](#rendering)); the interface refuses no document for its effects.

## Recorded effect editing

`styk-edit` uses the effect registry and existing typed paint interpolation for stack
and clip commands. The remaining 12 recordings / 392 steps cover every built-in
preset, saved preset timing/keys with remapped identities, attached scopes through
depth 16 and refusal at 17, raw paint validation and keyed solid/gradient sampling.
`records::paint_record` preserves the typed paint's editor record form. The facade
records identity/seed draws (D18) for preset/group creation; commands retain their
existing shadow/adoption policy. User-preset storage and inspector flows remain in
their existing UI owners.

## Evaluation order

1. **Per-pose stacks** (`Object::vfx`, `Object::vfx_scope`, and `Keyframe::vfx` for the scene) are read with the pose. Between two keys they tween with it (`vfx::interpolate`, called from `eval::evaluate_native` for the scene and from `tween_object` for objects) at the pose tween's own progress. A layer sheet takes the scene's stack from the scene track. Property channels of effects then apply to the tweened stacks (`channels::scalar`, `applyVfxParameter`, [evaluation.md](evaluation.md#property-channels)): a `vfxStack` channel replaces a target's whole stack (an empty one removes it), a `vfx1:<type>:<id>:<param>` channel sets one parameter of the first effect in the stack with that identity and type (numbers clamped to their range, colours as keyed, discrete values held; `enabled` switches it), `vfxScope` turns a figure's scope on or off; a node channel applies only where the instance's figure type has that node. Channels apply before clips, and a document whose only effects are channels still resolves effects (`Prepared::has_vfx`).
2. **Clips** at the tick (`renderVfxOwner`): enabled, in range, with strength; a node clip scoped to another figure type is skipped. Their filters append to the target's stacks after the per-pose ones, clips in saved order. A figure clip that includes attached parts also feeds the connected stack and turns the scope on.
3. **Movieclip containers** (`buildMovieclipGeometrySteps`): an instance's `figure` stack is the clip's own scene stack at the instance's local time (`evaluate_clip`, only when the clip document has effects), then the instance's. The clip's own objects have their stacks in the clip frame's own `FrameVfx`.
4. **Connected groups** (`connectedVfxGeometry`): an object whose scope is on and whose connected stack is active owns a group: itself and every object joined below it, breadth first. Scopes nesting deeper than 16 leave the group out with a warning. The root's `figure` drops the effects the group applies (by identity).
5. **Generated effects** (the clip loop of `collectLayers`): sampled at the tick, at most just before the clip's end, with opacity `strength × fade × effectStrength`, from `start + delay`.

## Modules

| Module (`src/vfx/`) | Holds | JavaScript |
| --- | --- | --- |
| `mod.rs` | `Effect`, `Stack`, `Stacks`/`StackKey` (`_stykVfx`), `active`, `interpolate`, `document_has_vfx` | `activeVfx`, `interpolateVfx`, `documentHasVfx` (src/vfx.mjs) |
| `registry.rs` | `Kind`, `Params` and one struct per type, `Spec`, option enums, `neutral`, `available` | `VFX_REGISTRY`, `neutralVfx`, `effectAvailable` |
| `paint.rs` | `normalize`, `interpolate`, `js_round` | `vfxPaint`, `interpolateVfxColor`, `normalizePaint`, `samplePaint` |
| `parse.rs` | saved effects, stacks and clips → typed (lenient) | `validateVfxStack`, `validateVfxOwner`, `validateVfxClips`, `vfxDescriptor` |
| `clips.rs` | `Clip`, `Clips`, `Target`, `Channel`, `Key`, `sample_keys`, `Clip::{contains, time, fade, sample, active_at}` | `clipContains`, `clipTime`, `vfxFadeAt`, `sampleVfxKeys`, `sampleVfxClip`, `vfxClipActiveAt` |
| `frame.rs` | `evaluate` → `FrameVfx`, `generators` | `frameWithVfxTime`, `vfxRenderFrame`, `renderVfxOwner`, `connectedVfxGeometry` (planning), `collectLayers` (clips) |
| `frame.rs` | `composed`: the `FrameVfx` of an edit frame from the fields the editor composed | `vfxRenderFrame` (its output), `connectedVfxGeometry` |
| `layers.rs` | `objectBounds` for effect layers: `item_extent`, `rounded` | `objectBounds`, `drawableVfxPadding` |
| `padding.rs` | `padding`, `sampling_padding`, `working_slots` | `vfxPadding`, `vfxSamplingPadding`, `vfxWorkingSlots` |
| `parity.rs` | comparison with `frames[].vfx` of a reference dump | — |

The loader (`load.rs`) reads `_stykVfx`, `_stykVfxScope` and `_styk.vfxClips` (clips cached by record, like figures and keyframes). Generated effects are in `vfx/generated/` ([Generated effects](#generated-effects)); rendering is the renderer's and the inspector stays in the interface.

## Generated effects

Particles, auras, energy beams, explosions and smoke create artwork instead of filtering it ([`VFX-GENERATORS.md`](../VFX-GENERATORS.md)). `styk_eval::vfx::generated` ports `src/vfx-generators.mjs` and its modules operation for operation, and its output is the editor's bit for bit (see Testing).

| Module (`vfx/generated/`) | Holds | JavaScript |
| --- | --- | --- |
| `layers.rs` | the layer vocabulary: shapes, emitters, blending, rotation and size modes, `Spec` (one layer with the editor's defaults), materials, colour ramps | `vfx-generator-layers.mjs` |
| `styles.rs` | every effect type and style compiled into layers (`compile`), `Context` | `vfx-generator-styles.mjs` |
| `anchors.rs` | `anchor`: a target's point, bounds and outline; `Sampler`: anchors on earlier ticks; `Evaluate`, a sampler without a cache | `anchorFromGeometry`, `GeneratorAnchors` (`vfx-generator-anchors.mjs`) |
| `batch.rs` | `build`: the frame's `Batch` (128-number layer records, the birth table, draws); `clip_tail`; `background_is_light`; `Batch::offset` | `buildGeneratorBatch`, `collectLayers`, `packBatch`, `generatorClipTail`, `backgroundIsLight`, `offsetGeneratorBatch` |
| `particle.rs` | `evaluate`: one particle of a draw; `ramp`, `beam`, `arc_segment`, `beam_tip`, `beam_width`, `stepped_time`, the hashes and value noise | `evaluateParticle`, `rampColor`, `beamTip`, `beamWidth`, `steppedTime`, `pcg`, `hash`, `vnoise` (and the WGSL vertex shader of `vfx-generator-gpu.mjs`) |
| `atlas.rs` | the procedural material atlas: 17 rows of eight 128-pixel cells with three reduced levels, generated on first use | `vfx-generator-atlas.mjs` |

**A frame's batch** (`generated::build(prepared, frame, scene, tick, sampler, density)`): every enabled generator clip active at the frame's `_vfxTimelineTick` (from its start to its end plus `clip_tail`, the longest lifetime, jitter and trail of its layers) compiles its sampled effects into layers, then movieclip containers whose documents carry generators add theirs, evaluated at the instance's local time, in its transform and opacity, four levels deep, beside the container. Layers pack into one batch: a record per draw, a birth table (per layer, a row per tick of still-visible births: anchor, emission amount, keyed direction, speed and size; per effect, the target's outline, one per birth tick for trails) and the draws (shape, resolved blending, target, placement, material row). Trail echoes, glow halos and outlines are extra draws of the same particles. A particle is then a pure function of its record, the table, its instance index and the tick (`particle::evaluate`): nothing is simulated or kept between frames.

**Anchors on earlier ticks**: particles keep the position their target had when they were born, so a batch reads the target on earlier ticks through a `Sampler`. The evaluation crate's `Evaluate` evaluates the document at each such tick; the engine keeps them across frames (`styk_engine::anchors`, see [Generated effects on screen](#generated-effects-on-screen)). A sampler may answer `Pending` when an interactive frame's time budget is spent: the batch then uses the current pose for those births and is marked `incomplete`, to be built again.

Invariants:

- **The editor's arithmetic**: `f64` operation for operation, single precision where the editor stores a `Float32Array` (records, table, outlines, material texels), `Math.round` as `js_round`, V8's `sin`, `cos`, `atan2`, `hypot` and `exp` from `styk-math` (D16). Hashes are the shaders' integer PCG, bit-compatible with the editor's `hash`.
- **Pure**: a function of the prepared document, the frame, its geometry and the sampler's answers.
- **Materials never wait** (D7): a row another thread is generating is generated again, the first finished copy kept; rows live for the process (5.9 MB for all 17).

Differences, on purpose or known:

- `Math.pow` (sizes over life, trail fades, some material shapes) is `styk_math::pow`, V8's own (D16), and the fixtures are recorded with Node pinned to it (`engine/tools/v8-pin.mjs`); a browser's is the platform's, which can differ in the last bit and cannot change a stored record (single precision) or a material byte in practice. Particle sizes are compared bit for bit.
- A styled instance's nested generators are read from its base figure's movieclip (the same clip document).

## Invariants

- **Same arithmetic as the JavaScript**: operand order, clamps where the editor clamps (tweened numbers to their range, colour channels to 0–255), no clamp where it does not (keyed values), `Math.round` (`paint::js_round`, halves up), stable sorts of gradient stops, `Map` semantics (the last effect with an identity wins).
- **Effects resolve once**, when read: defaults filled, paints normalized, version 1 outlines square. Keys and tweens produce valid values, so nothing is validated again during evaluation; unkeyed, untweened effects are shared `Arc`s from frame to frame.
- **Order is render order**: per-pose effects first, clips in saved order; a container's clip scene effects before its own.
- **Presence and activity differ**: `document_has_vfx` counts an empty `_stykVfx`; stacks only hold active effects.
- **Pure**: a function of the prepared document and the tick; no clocks, threads or files (it builds for `wasm32-unknown-unknown`).

## Differences from the JavaScript, on purpose

- **Lenient reading**: the editor refuses a project with an invalid effect record; the engine drops the record (an effect, a stack entry, a key channel, a clip) and says so in `Document::notes`. Key easing is not validated, nor the limits on keys and simultaneous effects.
- **Generators** are listed within their clip's range only: particles outlive a clip by a tail only the generator compiler knows (`generatorClipTail`); `vfx::generators(clips, tick, tail)` takes it. Whether the target is present (an anchor) is the generator's to check. Their colours are normalized paints; the editor's generator code reads the saved form.
- **Connected groups** list every member; the renderer leaves out hidden ones and skips a group whose owner is hidden (the editor plans with visibility). The depth warning is given for every too-deep owner, hidden or not.
- **Edit frames** take their effects from the pose the editor sends, never from the clips again: the editor's geometry already composed clip effects into each pose (`_stykVfx` per key, `_vfxConnectedEffects`, a scope a clip turned on) and the scene's into `_vfxTimelineScene`. `Loader::edit_frame` reads those fields (`Object::vfx_connected`; `_vfxTimelineScene` becomes the frame's scene stack) and `vfx::frame::composed` builds the `FrameVfx` from them: the same stacks, connected groups and movieclip contents as `evaluate`, with nothing sampled twice. Movieclip contents are still evaluated by the engine at the instance's local time. Playback frames are evaluated by the engine itself (`evaluate`).
- **Not evaluated**: the clips of a captured movieclip's retained source (`movieclipSource`, noted in `unsupported`; the engine does not read retained sources at all), and `_stykVfx` on a figure definition's segments, which nothing in the editor reads either.

### JavaScript behaviours reproduced that look wrong

- Node stacks and node clips saved without a figure type (`*/handle`) are never drawn: renderers look node stacks up by the object's own figure type. The inspector always scopes, so only older or hand-made data has them.
- With Auto easing, a native pose tween interpolates effect parameters linearly while the pose follows the Auto curve (`interpolateVfx` receives the raw progress).
- `includeAttached` on a node clip is accepted and ignored.
- The inspector's "active" (`vfxClipActiveAt`) ignores fades: a clip at a fade endpoint is listed though nothing is drawn.
- A scope on an object without any effect still counts toward the 16-level limit of nested groups.
- Interpolating two gradients of different kinds or stop counts keeps the first, with no transition; a solid and a gradient interpolate on the gradient's layout.

## Rendering

The engine draws every filter the way the editor's WebGPU renderer does (`rasterObject`, `filterArtworkVfx`, `withVfx` and `CameraVfx` in the JavaScript), on WebGPU, native and WebGL2 alike, and every generated effect ([Generated effects on screen](#generated-effects-on-screen)). The editor's effects preview switch reaches the engine for edit frames (`Stage::set_effects`) and prepared playback (`EngineHandle::set_effects`), which then draws without effects, generated ones included.

### From effects to layers (`drawlist.rs`, `vfx/layers.rs`)

A filtered group is an isolation group with a raster **layer** (`Group::layer`, `styk_draw::EffectLayer`). Encoding reads the frame's `FrameVfx` (and, for movieclip contents, each owner's clip frame: `Scene::clip_vfx`) and nests groups as the editor's painter does:

- **Levels of a run** (`path`): the connected groups of its frame holding it (outermost first, `FrameVfx::roots` reversed), then each movieclip instance of its chain (`Level::Owner`, its container stack: the clip's scene stack then the instance's) with the connected groups of that clip's frame. Consecutive runs sharing a level share its group, so a connected group splits where a foreign figure interrupts it and its runs share one domain (`owner.domainBounds`), as `connectedVfxGeometry` does. Hidden members do not split a run; a group whose owner is hidden is not formed.
- **An object** (`Builder::object`): its figure stack over its outline and items, then each node with a stack (`segmentVfx`: segments, never polygons) on a layer of its own in painter order. Opacity applies after the stack.
- **Entries**: the outermost group of top-level artwork that holds effects anywhere (an object, a movieclip instance or a connected run) is an *entry* (`LayerKind::Entry`), even when it is opaque and has no stack of its own: the editor rasterizes such artwork whole and resamples it. Groups inside an entry are *nested* (`LayerKind::Nested`).
- **The scene stack** becomes the *camera image* (`LayerKind::Camera`): the background and the frame's runs drawn again inside it, composited last over the unfiltered frame, then the onion skins over it (`ViewportVfx` draws them as overlays).

Every layer carries the rectangles the editor filters on: `objectBounds` with the padding of every stack from that level down to each item (`drawableVfxPadding`), and without it (the effects' **domain**, which global coordinates, gradient positions and centres are relative to), in whole world units. `vfx/layers.rs` ports `objectBounds` (three units beyond half the stroke width and the figure outline, circles by radius, sprites and cels by their corners, text by its glyphs and box). `styk layers <file> <tick>` prints them; `engine/tools/vfx-layer-bounds.mjs` prints the editor's for a project, to compare.

Edit frames take their stacks from the pose the editor sends (see the Contract): nothing is applied twice.

### Spaces, density and units (`styk-render/src/effects/plan.rs`)

Each frame, every group is placed in a *space* (world units to layer pixels) for the view:

- the frame and plain isolation groups: their parent's space (the screen at the top);
- an entry: a world-aligned grid anchored at its bounds, at `rasterResolution` of the view's pixels per world unit (the scale rounded up to a quarter octave, at least 0.5), lowered by the editor's raster budget (128 MiB), the texture limit and `vfxRasterScale` (3,968 pixels over the bounds plus twice the largest padding); above 8× or past the texture limit it is the editor's `rasterBounds` crop of the complete grid;
- a nested layer: its entry's grid, on its bounds grown by its effects' padding plus two pixels (`withVfx`);
- the camera image: the scene camera at the camera preview's density (the workspace zoom, times the camera's scale in the neutral workspace, at most 2,048 pixels on the longest side and within the effect surface), with the effects' padding plus two pixels around it.

So effects are view independent exactly as the editor's are: sizes are authored units times the owner's absolute scale times the layer's density (`Filter::scale`), coordinates are global pixels from the domain's corner (`Filter::origin`, `output_size`), and the density follows the view in quarter octaves. Between buckets an entry is resampled to the screen (bilinear, clamped to its edge texels as an exact texture is); the camera image is stretched onto the camera rectangle as the editor's quad is.

Every layer is **cropped** to what can reach the screen: the drawn part of its parent, widened by its effects' sampling reach (`vfx::sampling_padding`) and two pixels. A crop keeps the pixel grid and the global coordinates, so visible pixels are those of the complete layer; a layer entirely off screen is not drawn.

### Passes (`frame.rs`, `effects/recipe.rs`, `effects/executor.rs`, `effects/passes.wgsl`)

Layers are packed into the two isolation atlases as before (one pass per nesting depth, rounds when they overflow). Pages are at least the frame's size and grow, in 256-pixel steps, to the largest layer (an entry at the bucketed density, the camera image). Each group has a six-texel record in the group table (`effects::record`): world to atlas, page, atlas rectangle, its composite into its parent (atlas pixels to the parent's target) and the part shown.

After a depth's layer passes, each filtered layer of that depth is copied into working slot 0, filtered, and copied back in place, so the next depth composites the result. Each stack is recorded (`effects::recipe`, which needs no GPU) exactly as `VfxWebGPU.run` does: the same operations (`passes.wgsl` is the editor's WGSL with the operation as a uniform), the same slot choice, saves, three box passes per axis with downsampling on the global grid past 20 pixels, rounded or separable dilation, partial strength through the strength source, and the same uniform values in single precision. Slots are pooled at one size, so a pass uses its slot's top-left corner; sampling scales into it and clamps where the editor's exact-size textures would.

The CPU rasterizer (`styk-raster`, [rendering.md](rendering.md#cpu-styk-raster)) runs the same recipes: the same plan places and crops each layer, and `styk-raster/src/effects.rs` carries out every operation of `passes.wgsl` on slots of exactly each pass's size, rounded to 8 bits per pass as the GPU's slots are.

### Memory

- **No effects**: no slot, no pass, no executor; draw lists have no layers. Group records are 96 bytes per isolation group instead of 32.
- **Slots**: up to eight `Rgba8Unorm` textures of one size (only those a stack uses are created), grown in 256-pixel steps to the largest filtered layer, kept across frames, shrunk after 240 frames that need under a quarter of their area, released after 240 frames without effects. The uniform buffer (768 bytes per pass) and bind groups (by slot triple) are reused.
- **Atlases**: pages grow for layers larger than the frame and return to the frame's size when it changes, or after 240 frames whose layers all fit it.
- `Renderer::stats` reports `effect_layers`, `effect_passes`, `effect_bytes` (slots) and `layer_bytes` (atlases); `styk gpubench <file> <tick> [--no-effects]` times a frame with and without effects.

### Differences from the JavaScript, on purpose or known

- The editor rasterizes every translucent figure and every entry through its raster cache at bucketed densities; the engine does so only for entries (where effect kernels depend on the density) and draws other artwork at screen density, as before. Edges differ by a pixel.
- The editor lowers all raster densities when a scene's rasters exceed its preview budget (`previewRasterScale`); the engine does not, so effects of such scenes are sharper there.
- A foreign object without any primitive does not split a connected run in the engine (the editor's layout lists it); such runs filter together.
- A drawing cel inside an effect layer is sampled as the cel display samples it (one display level, bilinear); the editor paints it into the effect raster through Canvas 2D with high-quality smoothing. Thin strokes differ, and a threshold (bloom) amplifies it.
- Effects of the editor's Canvas 2D fallback run on its WebGL 2 or CPU executor with the same kernels; on devices without WebGPU the engine draws like WebGPU devices.

### Generated effects on screen

**Where batches are built.** Prepared playback frames (`styk_engine` `frames::produce`, on the engine's workers) build the frame's batch with the generation's anchor cache and no time budget, as the editor's playback workers do. Edit frames (`EditScene::draw_list`, on the interface thread) build it once per pose with a budget of 6 ms for earlier anchors (the editor's `INTERACTIVE_SAMPLING_MS`); an incomplete batch is drawn and `Stage::refining` tells the app (`engine-stage.mjs`) to draw again, as the editor's incomplete batches do. A drag moves the draws beside the dragged figure (`Batch::offset`, `offsetGeneratorBatch`). The CLI's `render`, `raster` and `gpubench` draw a frame's generated effects with `Evaluate`.

**Anchor cache** (`styk_engine::anchors`). One per document generation, for documents with generated effects (`Generation::anchors`), shared by workers and the interface thread through the spinning lock (map accesses only; D7). A miss evaluates the document at that tick (`anchors::evaluate_at`) once and stores the anchors of every generator target of the document there, so consecutive frames evaluate one new tick each. At most 4,096 entries; beyond, the least recently used quarter goes. An edit publishes a new generation and a new cache, as the editor's cache is dropped when the evaluation generation changes.

**In the draw list** (`drawlist/generators.rs`). Each draw of the batch becomes its records, evaluated once per frame: a `K_PARTICLE` per live particle (shape in the kind's bits, position, size, rotation and velocity in the draw's local units, colour from the ramp with the stop's opacity multiplied in, a sprite's atlas cell), a `K_PARTICLE` per lightning arc segment, one `K_BEAM` per firing beam; each points at its draw's rows in `paints`: the movieclip transform and offset to the world, the scale, the material shading, softness, stretch and aspect, and for beams the ramp's end colours. Additive draws carry `F_ADD`. Placement is the editor's walk through painter order (`generatorSchedule`, `scheduleWalker`): scene draws behind the figures come after the background, before the first entry; a target's behind-placed draws come when its first entry begins and its front-placed ones when the next entry begins; draws of targets with no entry (hidden artwork, no artwork) and scene draws in front come after the last entry. An entry is the editor's layout entry: one object, a movieclip container's runs, or a connected run, which counts as its root when the root is in it and as its first part otherwise. Draws of hidden targets are left out, onion skins draw none, and the camera image draws every draw again in its own walk, as `CameraVfx` does. Draw lists of frames without generated effects are unchanged.

**On the GPU and the CPU**: see [rendering.md](rendering.md). The material atlas is uploaded row by row as lists name rows (`DrawList::materials`); when a document with generated effects opens, the engine generates the 17 rows on its workers (once per process), so the interface thread finds them ready. A row being generated by another thread is generated again rather than waited for (D7).

**Measured** (2026-10-03, NVIDIA RTX 4070 SUPER, machine shared with other work at a load average of 11 to 15). App parity (measured while the editor's renderers could be compared; D13 limits unchanged), Electron, the engine on WebGPU against the editor's WebGPU renderer:

| Document | Steps passing | Largest mean beyond 2 | Largest single difference | Solid pixels |
| --- | --- | --- | --- | --- |
| fixture `explosions` (ticks 2, 6, 12) | 3/3 | 0.008 | 24 | 0 |
| fixture `auras` (4, 9, 13, 19) | 4/4 | 0.010 | 30 | 0 |
| fixture `beams` (3, 7, 11, 15) | 4/4 | 0.034 | 58 | 0 |
| fixture `particles` (3, 7, 10, 14) | 4/4 | 0.067 | 53 | 0 |
| fixture `smoke` (3, 8, 13, 17) | 4/4 | 0.034 | 55 | 0 |
| fixture `movieclip` (0, 2, 5, 9) | 4/4 | 0.029 | 61 | 0 |
| fixture `tails` (2, 5, 7, 12, with onion skins, after playback through the engine) | 9/9 | 0.023 | 61 | 0 |
| fixture `placement` (4, 8, 12): overlapping figures, effects behind and in front, scene effects, a connected group | 3/3 | 0.031 | 46 | 0 |
| `Impact-FX-Fight.styk` (30, 108, 157, 185, 192, 205) | 0/6 | 0.38 | 115 | 0 |
| `TDD2 URIEL NEMESIS 3.styk` (20, 100, 140, 200) | 2/4 | 0.23 | 189 | 910 |

The largest single differences are along figure and beam edges. Every failing step there is not caused by generated effects: `Impact-FX-Fight.styk` fails by the mean rule alone, along glyph and figure edges, with the same numbers when effects are off in both runs (tick 30: 0.3233 against 0.3210 with effects; tick 185: 0.3842 against 0.3796), so with no generated effect drawn by either; `TDD2 URIEL NEMESIS 3.styk` ticks 100 and 140 lack a drawing cel the stage had not uploaded yet when the step was captured (the open issue below; `styk render`, which uploads every image first, draws it), and the document draws no generated effect at any tick.

Web target (headless Chromium, the engine on WebGL2 against the editor's Canvas 2D fallback): `auras` 4/4, `smoke` 4/4, `particles` 3/4 (tick 14: mean 0.27), `explosions` 1/3 (means 0.22, 0.89, 0.74; 11 and 4 solid pixels), `beams` 1/4 (means up to 2.61, 3,820 solid). These are the fallback's own departure from the editor's WebGPU renderer: its Canvas path draws particles from tinted sprites on a colour ramp of 8 or 32 steps, beams from a cross-section sprite along segments, squares, rings and streaks from sprites, and thins previews above 4,000 particles. The editor's two renderers differ by as much on the same document (Electron, the editor's WebGPU pictures against its Canvas 2D pictures: `explosions` means 0.17, 0.66, 0.41 with 0, 15 and 3 solid pixels; `beams` ticks 7, 11, 15 means 1.24, 2.66, 1.07 with 552, 3,882 and 195 solid). Recorded as a deliberate difference, as for polygon seams: where a device lacks WebGPU, generated effects now look as they do on WebGPU devices.

Cost: building a batch takes 0.1 to 1.6 ms on the fixtures and evaluating their 100 to 920 live particles 0.07 to 0.39 ms (native, `styk generators`, earlier anchors evaluated without a cache); `Impact-FX-Fight.styk` 2.4 ms for its batch (nested movieclip documents evaluated at earlier ticks without a cache) and 0.04 ms for its 68 particles. GPU frame time at 1,440×900 over 200 zoom levels (`styk gpubench`, p50): fixtures 0.13 to 0.17 ms without their generated effects, 0.16 to 0.55 ms with them (`beams` the most, its soft, wide beams filling the frame). Documents without generated effects, against `engine-rust` before this work (4 interleaved rounds, the order of the two builds alternating): GPU p50 `hitoshi vs suzu tomiee ssj.piv` tick 129 0.39 to 0.81 ms before and 0.41 to 0.68 after, `svr_uriel.piv` tick 100 0.80 to 1.34 and 0.82 to 1.27, `Jay on a new app (repaired).styk` tick 13 0.29 to 0.65 and 0.27 to 1.00; draw-list encoding 0.45 to 4.05 ms and 0.40 to 3.93 (hitoshi), 0.25 to 0.50 and 0.25 to 0.51 (Jay). The load made single runs vary by a factor of up to four; no difference shows beyond that noise. Edit frames in the desktop app (Electron, the engine on WebGPU, seeking tick by tick, the stage's own timing of `render_edit` on the interface thread, two passes: anchors cold, then cached): fixture `auras` ticks 0 to 20, median 1.03 and 1.14 ms, p95 2.09 and 1.84 ms; `Impact-FX-Fight.styk` ticks 170 to 200, median 5.51 and 4.50 ms with effects against 5.12 and 4.84 ms with effects off (p95 11.3 and 10.4 against 39.1 and 11.0). Not measured: frame times in a browser, other GPUs.

**Differences from the JavaScript, on purpose or known**:

- Particles are evaluated on the CPU in double precision (the editor's reference, `evaluateParticle`) and expanded by the vertex shader; the editor's WebGPU renderer evaluates them in its vertex shader in single precision. Positions differ below a pixel.
- On devices without WebGPU the engine draws like WebGPU devices (above); the Canvas fallback's 4,000-particle preview budget is not followed (every particle is drawn).
- A connected group's member that is not its root, drawn in the root's run, has its draws placed at the end of the frame, as the editor's layout lists only the run's anchor (the same in both).


### Adding an effect type to the renderer

After its evaluation (see Changing it): add its passes to `Recorder::effect` in `effects/recipe.rs`, as `VfxWebGPU.run` records them; a new operation goes into `passes.wgsl` as in the editor's shader (one more `if (operation == N)`) and into `general` in `styk-raster/src/effects.rs` with the same arithmetic; its padding and sampling padding come from `vfx::padding`. Add it to a document of `engine/tools/vfx-parity-docs.mjs` with non-default parameters and compare in the app.

### Testing the rendering

```sh
cd engine && cargo test -p styk-render -p styk-eval --test vfx_layers   # planning, records, pass recording, layer structure
target/debug/styk layers <file> <tick>          # a frame's layers; compare with:
node tools/vfx-layer-bounds.mjs <project.json> <tick>
target/debug/styk render <file> <tick> out.png [--zoom Z] [--neutral] [--after T]   # --after: the renderer drew tick T first
node engine/tools/vfx-parity-docs.mjs           # tmp/vfx-parity/*.json and their ticks
```

### Measured when this landed

Machine: Linux, NVIDIA RTX 4070 SUPER, shared with other work (load average 4 to 12 during the runs), 2026-10-02 and 03. Pictures were compared by the app-parity script (since deleted) with its limits unchanged (a step fails on any pixel more than 32 levels off together with its eight neighbours, or a mean above 0.25 levels not counting differences of 2 or less; [D13](decisions/0013-app-parity-rule.md)), in a 1,440×900 window, onion skins on (the app's default), at the fitted view and four zoom-in steps (2.07×).

**Editor-built documents** (`engine/tools/vfx-parity-docs.mjs`). Each cell: steps passing, largest mean, largest single difference, solid pixels.

| Document | Electron: engine (WebGPU) against the WebGPU renderer, fit | zoomed | Web: engine (WebGL2) against Canvas 2D, fit | zoomed |
| --- | --- | --- | --- | --- |
| `figures-light`: tint (gradient), glow, outline (outer, centred only), shadow, bloom; one figure translucent | 1/1, 0.036, 39, 0 | 1/1, 0.040, 33, 0 | 1/1, 0.046, 58, 0 | 1/1, 0.048, 46, 0 |
| `figures-blur`: blur in its four modes (radius 7 and 80), grade | 1/1, 0.006, 22, 0 | 1/1, 0.001, 19, 0 | 1/1, 0.020, 58, 0 | 1/1, 0.004, 19, 0 |
| `figures-texture`: pixelate, noise then tint, dissolve, RGB split, wave at partial strength, turbulence then light sweep | 1/1, 0.028, 113, 0 | 1/1, 0.032, 26, 0 | 0/1, 0.064, 45, 2 | 1/1, 0.061, 59, 0 |
| `figures-inner`: inner glow, shadow and outline, two-effect stacks at partial strength, bloom then grade | 1/1, 0.019, 28, 0 | 1/1, 0.019, 26, 0 | 1/1, 0.045, 44, 0 | 1/1, 0.043, 57, 0 |
| `targets`: nodes, figures, a connected group inside another, clips with fades and strength (four ticks) | 4/4, 0.023, 51, 0 | 4/4, 0.020, 41, 0 | 4/4, 0.026, 42, 0 | 4/4, 0.027, 47, 0 |
| `movieclip`: a clip with its own scene stack and effects inside, instanced with a stack (two ticks) | 2/2, 0.053, 63, 0 | 2/2, 0.075, 65, 0 | 2/2, 0.070, 71, 0 | 2/2, 0.060, 53, 0 |
| `scene`: grade, vignette, shockwave, blur on the scene, a glow inside it | 1/1, 0.002, 9, 0 | 1/1, 0.000, 1, 0 | 1/1, 0.001, 8, 0 | 1/1, 0.000, 2, 0 |
| `scene-camera`: CRT, then RGB split from a clip, with a moved, scaled and rotated camera (three ticks) | 3/3, 0.010, 20, 0 | 3/3, 0.020, 20, 0 | 0/3, 1.846, 49, 14,548 | 0/3, 1.185, 53, 9,275 |

Electron: 30 of 30 steps. Web: 23 of 30, and the seven are the reference's, not the engine's:

- `scene-camera` on the web: the Canvas 2D fallback clears the camera rectangle before drawing the camera image, the WebGPU renderer draws the image over the unfiltered frame. Where CRT curvature leaves the image transparent the fallback shows the artboard and WebGPU (and the engine) the unfiltered frame. See the behaviours below.
- `figures-texture` at the fitted view on the web: two pixelate cells along a figure's edge, which pixelate enlarges from one antialiased pixel each (Canvas 2D and the engine cover edge pixels differently).

Playback through the engine's prepared frames was started and stopped on `targets` (web); the script compares the stage after stopping, not the frames shown while playing, which no step captures. The Electron numbers were measured before the onion-skin fix below and before the last merge of `engine-rust`; the web numbers are the same to the last digit before and after both, and after the merge the native renders of the eight documents (fit, 2.5× and through the camera) are byte for byte the same, so Electron was not measured again.

**`TDD2 URIEL NEMESIS 3.styk`** (40 effect clips, drawing layers, a nested explosion generator, 3D surfaces), Electron, ticks 41 to 112 and 128 to 164, after twenty warm-up steps on ticks 0 to 19. The gates for 3D surfaces and generated effects were disabled in a local change that is not committed, so the engine drew every tick without its 3D surfaces and without the generator. 103 of the 109 ticks pass. Mean per tick: 42 to 45 0.01 to 0.09; 47 to 60 0.09 to 0.21; 65 to 92 0.03 to 0.05; 93 to 112 and 128 to 164 0.00 to 0.02; largest single difference among passing ticks 110, no solid pixel. The six:

| Tick | Result | What differs |
| --- | --- | --- |
| 41 | mean 3.58, 9,363 solid | The reference had not shown the drawing cel that first appears at this tick when the step was captured; the engine had. Captured after tick 42 instead, in an earlier run, the tick passed (mean 0.08). |
| 46 | mean 0.96, 19 solid | A drawing layer's onion skin (the layer's last drawing, shown past its end) is missing in the engine. The same with effects off (mean 0.45): drawing-layer onion skins, not effects. |
| 61 to 64 | mean 0.21 to 0.35, 4 to 26 solid | A drawing cel under blur, bloom and glow. Same shapes; the streaks are thinner in the engine. Inside an effect raster the editor paints cels through Canvas 2D with high-quality smoothing, the engine with the cel display's bilinear filter, and the bloom threshold amplifies the difference. With effects off the ticks pass (largest difference 23). |

Found on the way and fixed: onion skins drew solid paints in the paint's colour instead of the skin's tint (ticks 47 and 56 to 60 failed until then).

**Cost.** `styk gpubench`: one frame at 200 zoom levels from the fitted view to 11×, 1,440×900, native Vulkan, submit and wait. Two runs; the first under a load average near 5, the second near 11.

| Frame | p50 with effects | p50 without (`--no-effects`) | Effect passes | Atlases and slots with effects | without |
| --- | --- | --- | --- | --- | --- |
| `figures-light` | 1.15 and 1.41 ms | 0.12 and 0.13 ms | 30 to 58 | 12 to 34 MiB | 0 |
| `figures-blur` | 0.62 and 0.56 ms | 0.14 and 0.16 ms | 8 to 18 | 17 to 79 MiB | 0 |
| `targets`, tick 12 | 0.78 and 1.04 ms | 0.22 and 0.25 ms | 26 to 50 | 22 to 56 MiB | 20 MiB |
| `movieclip` | 1.25 and 1.67 ms | 0.19 and 0.23 ms | 25 to 34 | 29 to 112 MiB | 10 MiB |
| `scene` | 1.08 and 1.61 ms | 0.14 and 0.18 ms | 25 to 29 | 70 to 140 MiB | 0 |
| `scene-camera`, tick 4 | 0.59 and 1.06 ms | 0.11 and 0.26 ms | 3 | 60 to 132 MiB | 0 |
| URIEL, tick 57 | 1.93 and 6.96 ms | 0.25 and 0.33 ms | 31 to 39 | 56 to 160 MiB | 20 MiB |
| URIEL, tick 60 | 1.08 and 1.51 ms | 0.29 and 0.40 ms | 10 to 12 | 70 to 108 MiB | 20 MiB |
| URIEL, tick 140 | 0.36 and 0.37 ms | 0.22 and 0.25 ms | 1 | 32 to 36 MiB | 10 MiB |

Documents without effects, against the renderer before this work (`engine-rust` at 66686509, same command): `hitoshi vs suzu tomiee ssj.piv` tick 129 p50 0.36 to 0.44 ms against 0.41 to 0.54 ms; `svr_uriel.piv` tick 100 0.61 to 0.91 ms against 0.66 to 1.02 ms, with the same atlas memory. The no-effect path is not slower within this machine's noise. Not measured: frame times in the browser, other GPUs, integrated graphics.

The memory is bounded but the bound is large: a layer is at most 3,968 pixels on a side (60 MiB), an atlas has two to eight pages of the largest layer, and a stack uses up to eight slots of it. The largest measured total is 160 MiB.

### JavaScript behaviours reproduced that look wrong (rendering)

- With a scene stack, onion skins are drawn over the frame instead of behind the current pose (`ViewportVfx` paints them after the camera image), so the whole current frame takes their tint.
- The WebGPU renderer draws the camera image over the unfiltered frame. Where the scene stack leaves the image transparent (CRT curvature corners, a dissolve) the unfiltered frame shows through; the Canvas 2D fallback clears the camera rectangle first and shows the artboard. The two JavaScript renderers disagree; the engine follows WebGPU.
- The camera image is stretched by up to a pixel onto the camera rectangle where its whole-pixel size rounds the two axes differently.

### Open

- Drawing cels inside effect layers are resampled bilinearly, not with Canvas 2D's high-quality smoothing (URIEL ticks 61 to 64).
- `previewRasterScale` (the editor lowering all raster densities under memory pressure) is not followed.
- Fixed since, not caused by effects: a still frame could lack a drawing cel until the next redraw, because the stage uploads decoded images only when it draws and nothing drew again while they decoded; the stage now draws again once the pictures a shown frame needs arrive ([rendering.md](rendering.md#in-the-app)).

## Changing it

- **A parameter**: add a field to its type in `registry.rs`, in the registry's order, with its saved name, default and range; a switch is `bool`, an option list an enum (`choice!`), a discrete number `u32`. If it changes what is neutral, the padding or the working slots, update `Params::neutral`, `padding.rs`. Regenerate the fixtures; give the parameter a non-default value in one.
- **An effect type**: an `effects!` entry (with `generator`/`scene_only`), its `neutral` rule, its padding and slot rules, `Params::delay` for a generator, `Kind::available` if the scene catalogue changes. Add it to a fixture.
- **Behaviour changes start in the JavaScript** while it is the oracle: change it there, regenerate the fixtures, then make the engine match.

## Testing

```sh
node engine/tools/vfx-fixtures.mjs                # regenerate engine/crates/styk-eval/tests/fixtures/vfx/ (byte-stable)
cd engine && cargo test -p styk-eval --test vfx   # well under a second
cargo clippy -p styk-eval --all-targets
cargo build -p styk-eval --target wasm32-unknown-unknown
```

`tests/vfx.rs` loads every fixture and:

- compares geometry, then every stack effect by effect and parameter by parameter (continuous values within 1e-9 relative, colours, options, seeds, paddings and working slots exactly), connected groups and their order, generated effects and active clips;
- checks that each fixture stops matching without its clips or without its per-pose stacks, and that tweened fixtures stop matching when keys cannot tween;
- checks that documents without effects resolve none;
- replays recorded inputs of `interpolateVfxColor`, `sampleVfxKeys`, `vfxPadding`, `vfxSamplingPadding`, `vfxWorkingSlots` and `neutralVfx` (`vectors.json`).

Against a real file:

```sh
cd engine && cargo build -p styk-cli
node tools/reference.mjs <file.styk> /tmp/reference.json --every 1 --vfx
target/debug/styk compare <file.styk> /tmp/reference.json     # adds an effects line
```

Generated effects:

```sh
node engine/tools/generator-fixtures.mjs          # regenerate engine/crates/styk-eval/tests/fixtures/generators/ (byte-stable)
cd engine && cargo test -p styk-eval --test generators
target/debug/styk generators <file> <tick>…       # a frame's draws, live particles and what they cost
```

`tests/generators.rs` loads every fixture (auras, beams, explosions, smoke and particles in every style and look, clip tails, painter-order placement with a connected group, a movieclip carrying generators instanced turned, scaled, mirrored and translucent) and, at every recorded tick, requires the editor's batch bit for bit (records and table in single precision, draws) and the same live particles with every value equal (sizes included, through V8's own `Math.pow`), the same beams, arc hashes and ramp colours; each fixture stops matching without its effect clips, and those with trails without earlier-tick anchors. `atlas.json` holds a hash of every material row and level, which the engine generates byte for byte.

Measured when this landed: `TDD2 URIEL NEMESIS 3.styk` (40 clips), all 232 ticks: 602 stacks and 337 effects compared, no difference (nor in its geometry). The Impact FX pack (`AssetReleases/Impact-FX`: the fight scene, 240 ticks, and the 28 movieclip files) keeps its effects, all particles, inside 8 distinct movieclip documents; opened alone, each compares 18 ticks and 16 generated effects with no difference. Their geometry differs where they use 3D poses and surfaces, which the engine did not evaluate then.

Generated effects, measured when they landed (2026-10-03): the eight fixtures, 32 ticks, 8,428 live particles: every batch bit for bit, every particle equal (sizes within 1e-12), all 17 material rows and their levels byte for byte. In `TDD2 URIEL NEMESIS 3.styk` the explosion clip's target (uid 2386) is absent from every frame of the clip's range, so neither the editor nor the engine draws a generated effect at any of its 232 ticks.
