# Engine: visual effects

How the Rust engine (`engine/crates/styk-eval/src/vfx/`) decides, for one tick, which effects apply to what and with which parameter values. The user-facing behaviour is in [`VFX.md`](../VFX.md), [`VFX-DESIGN.md`](../VFX-DESIGN.md) and [`VFX.md`](../VFX.md); the JavaScript editor is the oracle while both exist ([`RUST-ENGINE-PORT.md`](../RUST-ENGINE-PORT.md)). Drawing the effects is the renderer's ([Rendering](#rendering)).

## Contract

- `Prepared::evaluate(tick)` (and `evaluate_clip`) fills `Frame::vfx: Option<Arc<vfx::FrameVfx>>`: everything a renderer draws for effects at that tick, or `None` when there is nothing. When `Prepared::has_vfx` is false (no effect clip and no per-pose stack in the document or its movieclips) evaluation does no effect work and allocates nothing.
- `FrameVfx` holds, by object slot:
  - `scene`: the camera image's stack, the scene's per-pose stack then its clips;
  - `objects[slot]` (`FrameVfx::object`): `figure`, the stack of the object's own artwork; `attached`, the connected group it owns (its stack and member slots); `segments`, node stacks by handle id;
  - `roots`: the slots owning a drawn connected group, in compositing order (smaller groups first, so nested groups filter before the groups containing them);
  - `generators`: generated effects inside their clip's range, with their parameters, opacity and start (what the editor's reference dump lists); what they draw is a separate batch ([Generated effects](#generated-effects));
  - `warnings`: connected groups nested too deep.
- Every stack is what `activeVfx` returns, in render order: enabled filters that change their input, each an `Arc<vfx::Effect>` whose `Params` is one struct per effect type with typed fields (`f64`, `Color` for an RGB integer or a paint, an enum per option list, `bool` switches, `u32` seeds and counts). Values are those the editor hands an executor: keys sampled, poses tweened, `effectStrength` multiplied by the clip's strength and fades.
- `vfx::padding`, `vfx::sampling_padding` and `vfx::working_slots` take such a stack.
- Saying what must be drawn: a frame whose `vfx` is `Some` has effects the renderer must draw, and `vfx::document_has_vfx` tells whether a document carries any at all. The engine draws every filter and every generated effect ([Rendering](#rendering)); the interface refuses no document for its effects.

## Recorded effect editing

`styk-edit` uses the effect registry and existing typed paint interpolation for stack
and clip commands. The remaining 12 recordings / 392 steps cover every built-in
preset, saved preset timing/keys with remapped identities, attached scopes through
depth 16 and refusal at 17, raw paint validation and keyed solid/gradient sampling.
`records::paint_record` preserves the typed paint's editor record form. The facade
records identity/seed draws (D18) for preset/group creation. User-preset storage and inspector flows remain in
their existing UI owners.

## Evaluation order

1. **Per-pose stacks** (`Object::vfx`, `Object::vfx_scope`, and `Keyframe::vfx` for the scene) are read with the pose. Between two keys they tween with it (`vfx::interpolate`, called from `eval::evaluate_native` for the scene and from `tween_object` for objects) at the pose tween's own progress. A layer sheet takes the scene's stack from the scene track. Property channels of effects then apply to the tweened stacks (`channels::scalar`, `applyVfxParameter`, [evaluation.md](evaluation.md#property-channels)): a `vfxStack` channel replaces a target's whole stack (an empty one removes it), a `vfx1:<type>:<id>:<param>` channel sets one parameter of the first effect in the stack with that identity and type (numbers clamped to their range, colours as keyed, discrete values held; `enabled` switches it), `vfxScope` turns a figure's scope on or off; a node channel applies only where the instance's figure type has that node. Channels apply before clips, and a document whose only effects are channels still resolves effects (`Prepared::has_vfx`).
2. **Clips** at the tick: enabled, in range, with strength; a node clip scoped to another figure type is skipped. Their filters append to the target's stacks after the per-pose ones, clips in saved order. A figure clip that includes attached parts also feeds the connected stack and turns the scope on.
3. **Movieclip containers** (`buildMovieclipGeometrySteps`): an instance's `figure` stack is the clip's own scene stack at the instance's local time (`evaluate_clip`, only when the clip document has effects), then the instance's. The clip's own objects have their stacks in the clip frame's own `FrameVfx`.
4. **Connected groups**: an object whose scope is on and whose connected stack is active owns a group: itself and every object joined below it, breadth first. Scopes nesting deeper than 16 leave the group out with a warning. The root's `figure` drops the effects the group applies (by identity).
5. **Generated effects** (the clip loop of `collectLayers`): sampled at the tick, at most just before the clip's end, with opacity `strength × fade × effectStrength`, from `start + delay`.

## Modules

| Module (`src/vfx/`) | Holds |
| --- | --- |
| `mod.rs` | `Effect`, `Stack`, `Stacks`/`StackKey` (`_stykVfx`), `active`, `interpolate`, `document_has_vfx` |
| `registry.rs` | `Kind`, `Params` and one struct per type, `Spec`, option enums, `neutral`, `available` |
| `paint.rs` | `normalize`, `interpolate`, `js_round` |
| `parse.rs` | saved effects, stacks and clips → typed (lenient) |
| `clips.rs` | `Clip`, `Clips`, `Target`, `Channel`, `Key`, `sample_keys`, `Clip::{contains, time, fade, sample, active_at}` |
| `frame.rs` | `evaluate` → `FrameVfx`, `generators` |
| `frame.rs` | `composed`: the `FrameVfx` of an edit frame from the fields the editor composed |
| `layers.rs` | `objectBounds` for effect layers: `item_extent`, `rounded` |
| `padding.rs` | `padding`, `sampling_padding`, `working_slots` |
| `parity.rs` | comparison with `frames[].vfx` of a reference dump |

The loader (`load.rs`) reads `_stykVfx`, `_stykVfxScope` and `_styk.vfxClips` (clips cached by record, like figures and keyframes). Generated effects are in `vfx/generated/` ([Generated effects](#generated-effects)); rendering is the renderer's and the inspector stays in the interface.

## Generated effects

Particles, auras, energy beams, explosions and smoke create artwork instead of filtering it ([`VFX.md`](../VFX.md)). `styk_eval::vfx::generated` is the only implementation. The interface reads from it only a clip's tail and whether the clip plays (`vfxClips`, [evaluation.md](evaluation.md#the-interfaces-views)).

| Module (`vfx/generated/`) | Holds |
| --- | --- |
| `layers.rs` | the layer vocabulary (below): shapes, materials, emitters, light and paint, curves over life, trails, halos, outlines, erosion, beam looks, `Spec` (one layer, every field with a default), colour ramps |
| `styles/` | every effect type and style compiled into layers: one module per type (`aura.rs`, `beam.rs`, `explosion.rs`, `smoke.rs`, `particles.rs`), each style a function that reads like a description of the effect (its layers with their shapes, colours, motion and timing); `mod.rs` holds `compile`, `Context`, the body scale and what the types share |
| `anchors.rs` | `anchor`: a target's point, bounds, size (`measure`) and outline; `Sampler`: anchors on earlier ticks; `Evaluate`, a sampler without a cache; `evaluate_targets`, the geometry of the targets alone |
| `batch.rs` | `build`, `build_within`: the frame's `Batch` (a draw per layer, the layers' parameters, the birth table and outlines); `clip_tail`; the limits; the caches of compiled layers and clip tails |
| `particle.rs` | `Evaluator`: a particle's birth, its motion at an age, the particle itself; `ramp`, `beam`, `arc_segment`, `beam_tip`, `beam_width`, `trail_lag`, the hashes and value noise |
| `fastmath.rs` | `sin`, `cos`, `atan2`, `exp`, `ln`, `powf` from exact IEEE operations: the same on every platform |
| `stage.rs` | small documents of stick figures with effect clips, for `styk vfx-review` and the tests |
| `atlas.rs` | the noise materials: smoke, flame, wisp and puff, four variants of each in 256-pixel cells (density and light), with three reduced levels; generated on the engine's workers (`prepare`), never on the interface thread |

**A frame's batch** (`generated::build(prepared, frame, scene, tick, sampler, density)`): every enabled generator clip active at the frame's effects tick (from its start to its end plus `clip_tail`) compiles its effects, sampled at the tick, into layers; then movieclip containers whose documents carry generators add theirs, evaluated at the instance's local time, in its transform and opacity, four levels deep, beside the container. Each layer becomes one draw: when and how much it emits, its instances (capacity), its rows in the birth table, its transform. The birth table has a row per tick of still-visible births: where the emitter was, how much was emitted, the keyed direction, speed and size, the body's scale, the layer's parameters keyed at that tick (an index into `Batch::specs`), the ground. Outlines (for layers that emit from the body) follow the rows, one per birth tick for layers that leave a trail, each segment with the outline's running length. A particle is then a pure function of its draw, the table, its instance index and the tick (`particle::Evaluator`): nothing is simulated or kept between frames, any frame can be drawn alone, and a frame drawn alone equals the same frame reached by playing.

**Behaviour**:

- **A particle is fixed at its birth.** Where its target was, the target's size, and every parameter of its layer as keyed at that tick (direction, speed, size, gravity, colour, life…) are read from its birth row; animating a parameter changes new particles, not those in flight. A clip with keys compiles its effect once per birth tick (identical results share one entry). A scene emitter whose position is keyed leaves a trail.
- **An effect outlives its target.** When the target is not in the frame (removed, or not resolved), what it emitted while it was there still draws, from where it last was, for as long as those particles live; nothing is born at ticks it is absent. An explosion bursts from where its target was at the effect's start, so it draws even when the figure is removed on that frame.
- **Auras follow the body, not its pose.** Auras are authored in units of a body 200 pixels tall and scaled at each birth by `body_scale(Anchor::measure)`: the target's two longest limbs from its root, end to end (posed lengths, so a figure scaled on a key is measured scaled; raising the arms changes nothing).
- **Body emitters are even along the outline**: a birth picks a place by length, so a long limb emits as much as its length (a circle is eight chords).
- **Starting already running** (`prefill`): continuous layers then emitted for a lifetime before the effect's start, without the clip's fade-in. Auto does so for a clip with no end or one that starts at the animation's start; a movieclip that loops then never restarts its effects empty. Only layers that begin with the effect run ahead: those that begin later (a beam's sparks once it fires, its impact) wait for their moment, and a beam that charges plays its charge from nothing unless it is set to start firing.
- **Every copy plays its own pattern** (`unique`, on by default): the seed mixes in the clip's identity, its target and the movieclip container. Off, copies are identical, as before.
- **Time**: the effect's own time is `t0 + (tick − t0) · timeScale` (`timeScale`, 0.1–4); emission, lives and motion are in it, birth rows in ticks. Animate on twos and threes holds the tick; a trail's copies are `trail_lag` apart, a whole number of held frames, so none lands on the particle's own frame.
- **The ground**: layers that land collide with the ground under their target at their birth, bounce (`bounce`, the share of the fall speed kept, a few times) and slide to a stop (`friction`).
- **A trail inside a movieclip** stays behind when the container moves: each birth is moved by the container's own move since that tick.
- **A beam whose aim leaves** keeps pointing where the aim last was.

**What a layer can draw** (`layers.rs`). A style is a list of layers, each a `Spec` that says what its particles are, how they move and how they change over their life:

- **Shapes**, measured as distances, so they are crisp at any size with one pixel of antialiasing: disc, ring, square, rhombus, star, sparkle, spark (a needle), shard, drop, heart, burst, cloud, flake, petal, bolt, flame, splat, bokeh, cartoon star, rock, and a segment (lightning, ribbons). `softness` blurs the edge (0 crisp, 1.8 a soft glow), `aspect` and `stretch` lengthen a shape along its motion, an `Outline` draws an ink line around it.
- **Materials**: smoke, flame (torn, forked tongues), wisp and puff, four variants each, noise fields of density and light. `Erosion` eats a material away from its thin parts as it ages (a threshold rising from `from` to `to`), with a soft or hard edge and a coloured rim where it breaks up (fire cooling at its edges); `shade` lights it from above.
- **Light and paint**: each record says how much of it is light (`emissive`, a curve over life). It is drawn premultiplied as (colour × k, k × (1 − light)): paint covers what is under it, light adds to it, and a mix does both. Nothing guesses the background: on white, light disappears and paint stays; on dark, light glows. `blend` keeps its three saved values: Solid paints, Glow is all light, Auto is the style's own mix (for styles that set none, light growing with how white the colour is). Over a transparent background light keeps its colour beyond its coverage; exports turn it into a translucent colour (`styk-export` `pixels`: alpha at least the brightest channel).
- **Colour over life** from a ramp of up to eight stops (colour, strength, opacity), the style's or the effect's own gradient (`paint_or`); `hue_jitter` and `value_jitter` vary it per particle. Size and opacity over life are `Curve`s (values at birth, at one or two points and at death, eased).
- **Motion**: launch angle, spread and speeds; gravity, wind and `drag`; curl noise (`curl`, `curl_scale`) for smoke and fire that swirl without crossing; `attract` towards the emitter, `orbit` around it, `radial` out of or into a ring, or toward a point above the target (`radial_above`, from its lowest point: an aura's tongues of flame lean in to a point above the head); the ground with `bounce` and `friction`; `inherit` the emitter's motion; `spin` and four ways to face (random, along the motion, upright, fixed).
- **Trails**: a `Trail` is a ribbon of segments through where the particle was over its last frames, tapering and fading, with an optional glow; a `Halo` is a larger soft disc of light under each particle.
- **Beams**: a `BeamLook` gives a beam a core, a body and a glow, each with its colour and its share of light, a head that swells as it travels, optional spiral strands and an ink line; `ARC` layers draw branching lightning that crawls along it, struck again on a rhythm.
- **Timing**: a material's own frames (`frame_rate`), the effect's step (ones, twos, threes) and time scale.

The five rebuilt styles show the vocabulary at the quality the rest should reach: Explosion Fireball, Aura Fire, Energy beam Energy, Smoke Soft and the Particles look Spark. The others are drawn through the same system and keep their earlier look until they are restyled.

**Limits** (`batch.rs`): a layer holds at most 65,536 particles alive (beyond, it emits fewer, evenly, rather than cutting the oldest), a frame evaluates at most 262,144 and draws at most `MAX_DRAWN` (200,000) records, every trail copy, halo and outline counted. An edit frame drawn on the interface thread is built with `build_within(…, EDIT_DRAWN)` (8,000). Beyond a limit, emission is thinned evenly: each particle keeps its own chance (`hash(n, 15) < emission × keep`), so the same particles stay as the share changes and old and young are thinned alike. The draw list further limits the area particles cover to `FILL_LIMIT` (48) canvases, thinning by another chance of each particle, faded near the threshold. Whenever a limit reduces what is drawn, `Batch::reduced` is set and the list's `materials` carries `styk_draw::MATERIALS_REDUCED` (`styk_draw::effects_reduced`); `EditScene::effects_reduced` says so for the stage's frame. Playback and export are reduced only beyond the frame limits.

**Anchors on earlier ticks**: particles keep the place their target had when they were born, so a batch reads the target on earlier ticks through a `Sampler`. The evaluation crate's `Evaluate` evaluates the document's targets at each such tick (`evaluate_targets`: the frame, then the geometry of the targets, what they are joined to and what is attached to them, nothing else); the engine keeps them across frames (`styk_engine::anchors`, see [Generated effects on screen](#generated-effects-on-screen)). A sampler may answer `Pending` when an interactive frame's time budget is spent: the batch then uses the nearest tick the sampler knows (`Sampler::nearest`), samples the newest births first, and is marked `incomplete`, to be built again.

**Reviewing generated effects** (`styk vfx-review`, `engine/crates/styk-cli/src/review.rs`). Builds a stage (`generated::stage`: a 640 × 400 canvas, a stick figure 180 pixels tall at its middle, one effect clip) and renders a contact sheet in a second or two: a row of frames across the effect's life, one row per background and zoom (1 = one canvas pixel per screen pixel), each labelled, on the graphics card or with `--cpu` on the processor renderer. With `--seq <folder>` it writes every tick as numbered PNG frames instead.

```sh
cargo build --release -p styk-cli --manifest-path engine/Cargo.toml
engine/target/release/styk vfx-review explosion --style fireball --out sheet.png                 # white and dark, 1× and 4×
engine/target/release/styk vfx-review aura --style fire --set color=0x66ccff --set width=1.6 --motion arms
engine/target/release/styk vfx-review smoke --style soft --motion walk --backgrounds white,dark,sky --zooms 1
engine/target/release/styk vfx-review particles --style spark --scene --set y=0.2 --cpu --out cpu.png
engine/target/release/styk vfx-review beam --style energy --seq frames --until 48 --zooms 2
```

`styk vfx-review shapes [--sizes 5,18,60] [--columns 8] [--out sheet.png]` draws every particle shape and material (painted and as light, at each size) on white and on dark, on the graphics card and the processor renderer side by side: the sheet to look at after changing a shape, a material or the shading.

Options: `--style <name|index>` (the Particles look), `--set <name>=<value>` (any saved parameter; `0x…` colours, `on`/`off`), `--ticks a,b,…`, `--start`, `--duration <ticks|none>`, `--motion still|walk|run|arms|vanish`, `--scene`, `--backgrounds white,dark,grey,sky,0xRRGGBB`, `--zooms 1,4`, `--focus x,y`, `--cell WxH`, `--cpu`, `--out`, `--seq <folder>`, `--until <tick>`, `--save <file.json>` (the stage as a document the app opens).

Invariants:

- **Pure and the same everywhere**: a function of the prepared document, the frame, its geometry and the sampler's answers. Particle values are drawn, never stored, so they are not V8's (decision 16 holds for stored arithmetic only): `fastmath` builds `sin`, `cos`, `atan2`, `exp`, `ln` and `powf` from IEEE operations that are exact on every platform and in WebAssembly, and hashes are integer PCG, so both renderers and every platform draw the same particles.
- **Saved parameters keep their names and meaning**; new ones default to the behaviour before them unless that behaviour was a defect (prefill, per-copy variation).
- **Retired styles** (`registry.rs` `RETIRED`, `retired` in src/vfx-registry.mjs) are still read and drawn as the option each merged into: Explosion Plasma as Magic and Smoke bomb as Dust, Smoke Thick and Steam as Soft (with their own thickness, amount, size, rise and life), Beam Spiral as Energy with strands, Particles Leaf as Petal. The interface leaves them out of its menus. Option lists are saved by position and never renumbered.
- **Honest controls**: a control a style ignores has a `when` condition in src/vfx-registry.mjs, so the inspector hides it for that style (for example an Explosion's intensity and blend for Cartoon, Dust and Pixel, an Aura's turbulence for Spirit, a beam's switches per style).
- **Bounded and cached**: compiled layers (by effect and context) and clip tails are kept per thread, at most 512 entries each, holding the effects they were made from; nothing compiles a style again for a frame whose effects did not change. Materials never wait (D7): the engine's workers generate them when a document with generated effects opens or a frame first needs them (`atlas::prepare`); a list whose material is not ready draws soft discs in its place and carries `MATERIALS_PENDING`, and the stage draws again. They live for the process (2 MB; 2.7 MB with the reduced levels on the graphics card).

## Invariants

- **Same arithmetic as the JavaScript**: operand order, clamps where the editor clamps (tweened numbers to their range, colour channels to 0–255), no clamp where it does not (keyed values), `Math.round` (`paint::js_round`, halves up), stable sorts of gradient stops, `Map` semantics (the last effect with an identity wins).
- **Effects resolve once**, when read: defaults filled, paints normalized, version 1 outlines square. Keys and tweens produce valid values, so nothing is validated again during evaluation; unkeyed, untweened effects are shared `Arc`s from frame to frame.
- **Order is render order**: per-pose effects first, clips in saved order; a container's clip scene effects before its own.
- **Presence and activity differ**: `document_has_vfx` counts an empty `_stykVfx`; stacks only hold active effects.
- **Pure**: a function of the prepared document and the tick; no clocks, threads or files (it builds for `wasm32-unknown-unknown`).

## Differences from the JavaScript, on purpose

- **Lenient reading**: the editor refuses a project with an invalid effect record; the engine drops the record (an effect, a stack entry, a key channel, a clip) and says so in `Document::notes`. Key easing is not validated, nor the limits on keys and simultaneous effects.
- **Generators** are listed within their clip's range only: particles outlive a clip by a tail only the generator compiler knows (`generated::clip_tail`); `vfx::generators(clips, tick, tail)` takes it. Whether the target is present (an anchor) is the generator's to check. Their colours are normalized paints; the editor's generator code reads the saved form.
- **Connected groups** list every member; the renderer leaves out hidden ones and skips a group whose owner is hidden (the editor plans with visibility). The depth warning is given for every too-deep owner, hidden or not.
- **Edit frames** the interface sends (a drawing's first stroke) take their effects from the pose it sends, never from the clips again: the editor's geometry already composed clip effects into each pose (`_stykVfx` per key, `_vfxConnectedEffects`, a scope a clip turned on) and the scene's into `_vfxTimelineScene`. `Loader::edit_frame` reads those fields (`Object::vfx_connected`; `_vfxTimelineScene` becomes the frame's scene stack) and `vfx::frame::composed` builds the `FrameVfx` from them: the same stacks, connected groups and movieclip contents as `evaluate`, with nothing sampled twice. The frame the stage draws from the open document's session (`Stage::edit_session`) is not composed: it carries its `tick`, and `vfx::frame::evaluate` samples the clips at it as a prepared frame's are. Movieclip contents are still evaluated by the engine at the instance's local time. Playback frames are evaluated by the engine itself (`evaluate`).
- **A captured movieclip's retained source**: a crop of a movieclip that has no effect clips of its own draws its retained source's filters, sampled at the source tick the frame was taken at (`Prepared::frame_vfx`, `vfx::frame::inherited_filters`); its generated effects are not inherited.
- **Not evaluated**: `_stykVfx` on a figure definition's segments, which nothing in the editor reads either.

### JavaScript behaviours reproduced that look wrong

- Node stacks and node clips saved without a figure type (`*/handle`) are never drawn: renderers look node stacks up by the object's own figure type. The inspector always scopes, so only older or hand-made data has them.
- With Auto easing, a native pose tween interpolates effect parameters linearly while the pose follows the Auto curve (`vfx::interpolate` receives the raw progress).
- `includeAttached` on a node clip is accepted and ignored.
- The inspector's "active" (`Clip::active_at`, read through `vfxClips`) ignores fades: a clip at a fade endpoint is listed though nothing is drawn.
- A scope on an object without any effect still counts toward the 16-level limit of nested groups.
- Interpolating two gradients of different kinds or stop counts keeps the first, with no transition; a solid and a gradient interpolate on the gradient's layout.

## Rendering

The engine draws every filter the way the recorded editor's WebGPU renderer did, on WebGPU, native and WebGL2 alike, and every generated effect ([Generated effects on screen](#generated-effects-on-screen)). The editor's effects preview switch reaches the engine for edit frames (`Stage::set_effects`) and prepared playback (`EngineHandle::set_effects`), which then draws without effects, generated ones included.

### From effects to layers (`drawlist.rs`, `vfx/layers.rs`)

A filtered group is an isolation group with a raster **layer** (`Group::layer`, `styk_draw::EffectLayer`). Encoding reads the frame's `FrameVfx` (and, for movieclip contents, each owner's clip frame: `Scene::clip_vfx`) and nests groups as the editor's painter does:

- **Levels of a run** (`path`): the connected groups of its frame holding it (outermost first, `FrameVfx::roots` reversed), then each movieclip instance of its chain (`Level::Owner`, its container stack: the clip's scene stack then the instance's) with the connected groups of that clip's frame. Consecutive runs sharing a level share its group, so a connected group splits where a foreign figure interrupts it and its runs share one domain (`owner.domainBounds`), as `connectedVfxGeometry` does. Hidden members do not split a run; a group whose owner is hidden is not formed.
- **An object** (`Builder::object`): its figure stack over its outline and items, then each node with a stack (`segmentVfx`: segments, never polygons) on a layer of its own in painter order. Opacity applies after the stack.
- **Entries**: the outermost group of top-level artwork that holds effects anywhere (an object, a movieclip instance or a connected run) is an *entry* (`LayerKind::Entry`), even when it is opaque and has no stack of its own: the editor rasterizes such artwork whole and resamples it. Groups inside an entry are *nested* (`LayerKind::Nested`).
- **The scene stack** becomes the *camera image* (`LayerKind::Camera`): the background and the frame's runs drawn again inside it, composited last over the unfiltered frame, then the onion skins over it (`ViewportVfx` draws them as overlays).

Every layer carries the rectangles the editor filters on: `objectBounds` with the padding of every stack from that level down to each item (`drawableVfxPadding`), and without it (the effects' **domain**, which global coordinates, gradient positions and centres are relative to), in whole world units. `vfx/layers.rs` ports `objectBounds` (three units beyond half the stroke width and the figure outline, circles by radius, sprites and cels by their corners, text by its glyphs and box). `styk layers <file> <tick>` prints them.

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
- **Slots**: up to eight `Rgba8Unorm` textures of one size (only those a stack uses are created), grown in 256-pixel steps, kept across unused frames and released with their owner. Exact renderers (exports and the native stage) preserve frame-dependent texture dimensions for sampling parity. Non-exact renderers keep high-water dimensions until close. The uniform buffer (768 bytes per pass) and bind groups (by slot triple) are reused.
- **Atlases**: page counts retain their high-water capacity until close. Non-exact page dimensions grow for layers larger than the frame and reset when the view size changes; exact dimensions remain frame-dependent. Frame counts do not act as idle deadlines.
- `Renderer::stats` reports `effect_layers`, `effect_passes`, `effect_bytes` (slots) and `layer_bytes` (atlases); `styk gpubench <file> <tick> [--no-effects]` times a frame with and without effects.

### Differences from the JavaScript, on purpose or known

- The editor rasterizes every translucent figure and every entry through its raster cache at bucketed densities; the engine does so only for entries (where effect kernels depend on the density) and draws other artwork at screen density, as before. Edges differ by a pixel.
- The engine does not lower raster densities when a scene's rasters exceed a preview budget, so effects of such scenes are sharp.
- A foreign object without any primitive does not split a connected run in the engine (the editor's layout lists it); such runs filter together.
- A drawing cel inside an effect layer is sampled as the cel display samples it (one display level, bilinear); the editor paints it into the effect raster through Canvas 2D with high-quality smoothing. Thin strokes differ, and a threshold (bloom) amplifies it.
- Effects of the editor's Canvas 2D fallback run on its WebGL 2 or CPU executor with the same kernels; on devices without WebGPU the engine draws like WebGPU devices.

### Generated effects on screen

**Where batches are built.** Prepared playback frames (`styk_engine` `frames::produce`, on the engine's workers) build the frame's batch with the generation's anchor cache and no time budget. Edit frames (`EditScene::draw_list`, on the interface thread) build it once per pose with a budget of 6 ms for earlier anchors and at most `EDIT_DRAWN` records (`build_within`), thinned evenly beyond; an incomplete batch is drawn and `Stage::refining` tells the app (`engine-stage.mjs`) to draw again, and `EditScene::effects_reduced` says whether the frame's effects were thinned. A drag moves the draws beside the dragged figure (`Batch::offset`): particles that follow the target move with it; those that stay where they were born keep their place and only their newest births follow. The CLI's `render`, `raster`, `gpubench` and `vfx-review` draw a frame's generated effects with `Evaluate`.

**Anchor cache** (`styk_engine::anchors`). One per document generation, for documents with generated effects (`Generation::anchors`), shared by workers and the interface thread through the spinning lock (map accesses only; D7). A miss evaluates the document's generator targets at that tick (`evaluate_targets`: their geometry alone) once and stores the anchors of every target there, so consecutive frames evaluate one new tick each. At most 4,096 entries; beyond, the least recently used quarter goes. Entries are kept per target by tick, so a pending sample is answered with the nearest tick known (`Sampler::nearest`). An edit publishes a new generation: when it moves no figure (the same figures, keyframes, layers, timing sources and animation, shared: an effect's settings, colours or clip timing changed), the new generation's cache starts with the old one's anchors (`Anchors::follow`), so trails survive it; otherwise it starts empty.

**In the draw list** (`drawlist/generators.rs`). Each draw of the batch becomes its records, every live particle evaluated once per frame: a `K_PARTICLE` per live particle (shape in the kind's bits, position, size, rotation and velocity in the draw's local units, colour from the ramp of the parameters it was born with, the stop's opacity multiplied in, its light and erosion, a material's cell), its halo and trail ribbon drawn from that one evaluation (`P_SEGMENT` records through its earlier positions), a segment per lightning arc piece, one `K_BEAM` per firing beam; each points at its draw's six rows in `paints`: the transform to the world, the scale and shading, softness, stretch, aspect and outline width, the outline colour, the erosion edge and rim (styk-draw documents the record); a beam's seven rows are its transform, its core, body and glow colours, its head and ink, and the rim colour its body turns to over its outer half, which gives a light beam a darker edge that reads on a light page. Within a draw, trails, halos, then the particles. Every record blends premultiplied with its own share of light (above); there is no separate additive pass. A frame's particles are also limited by the area they cover (`FILL_LIMIT`). Placement is the walk through painter order: scene draws behind the figures come after the background, before the first entry; a target's behind-placed draws come when its first entry begins and its front-placed ones when the next entry begins; draws of targets with no entry (hidden artwork, no artwork) and scene draws in front come after the last entry. Draws of targets the stage hides are left out (the stage's own visibility switch), onion skins draw none, and the camera image draws every draw again in its own walk. Draw lists of frames without generated effects are unchanged.

**On the GPU and the CPU**: see [rendering.md](rendering.md). The graphics card draws generated effects with their own shader entry points (`vs_particle`, `fs_particle` in `prim.wgsl`) and pipeline, created with the first list that has them, so documents without them never compile that shading. The processor renderer (`styk-raster/src/generators.rs`) evaluates the same distances, noise and light per pixel over each record's box. The materials are one two-channel texture of 1,024 texels square with its reduced levels, uploaded material by material as lists name them (`DrawList::materials`) once the workers have made them; the renderer never generates one.

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

- Particles are evaluated on the CPU in double precision and expanded by the vertex shader (the GPU) or the processor renderer's quad (the CPU).
- On devices without WebGPU the engine draws like WebGPU devices (above). Edit frames have a preview budget of their own (`EDIT_DRAWN`, see Limits); playback and export draw every particle within the frame limits.
- A connected group's member that is not its root, drawn in the root's run, has its draws placed at the end of the frame, as the editor's layout lists only the run's anchor (the same in both).


### Adding an effect type to the renderer

After its evaluation (see Changing it): add its passes to `Recorder::effect` in `effects/recipe.rs`, as `VfxWebGPU.run` records them; a new operation goes into `passes.wgsl` as in the editor's shader (one more `if (operation == N)`) and into `general` in `styk-raster/src/effects.rs` with the same arithmetic; its padding and sampling padding come from `vfx::padding`. Add a Rust test of the pass (`styk-render` and `styk-raster` tests) that states what it draws for non-default parameters.

### Testing the rendering

```sh
cd engine && cargo test -p styk-render && cargo test -p styk-eval --test suite -- vfx_layers::   # planning, records, pass recording, layer structure
target/debug/styk layers <file> <tick>          # a frame's layers
target/debug/styk render <file> <tick> out.png [--zoom Z] [--neutral] [--after T]   # --after: the renderer drew tick T first
```

### Measured when this landed

Machine: Linux, NVIDIA RTX 4070 SUPER, shared with other work (load average 4 to 12 during the runs), 2026-10-02 and 03. Pictures were compared by the app-parity script (since deleted) with its limits unchanged (a step fails on any pixel more than 32 levels off together with its eight neighbours, or a mean above 0.25 levels not counting differences of 2 or less; [D13](decisions/0013-app-parity-rule.md)), in a 1,440×900 window, onion skins on (the app's default), at the fitted view and four zoom-in steps (2.07×).

**Editor-built documents** (built with the editor by a generator that is deleted with the JavaScript renderer; the documents were not kept). Each cell: steps passing, largest mean, largest single difference, solid pixels.

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
- Fixed since, not caused by effects: a still frame could lack a drawing cel until the next redraw, because the stage uploads decoded images only when it draws and nothing drew again while they decoded; the stage now draws again once the pictures a shown frame needs arrive ([rendering.md](rendering.md#in-the-app)).

## Changing it

- **A parameter**: add a field to its type in `registry.rs`, in the registry's order, with its saved name, default and range; a switch is `bool`, an option list an enum (`choice!`), a discrete number `u32`. If it changes what is neutral, the padding or the working slots, update `Params::neutral`, `padding.rs`. Add a Rust test that gives the parameter a non-default value and states the result.
- **An effect type**: an `effects!` entry (with `generator`/`scene_only`), its `neutral` rule, its padding and slot rules, `Params::delay` for a generator, `Kind::available` if the scene catalogue changes. Add a Rust test that states what it evaluates to.
- **The recorded fixtures are frozen** ([README](README.md#fixtures)): a new or changed behaviour gets a Rust test that states its expected result; nothing re-records `fixtures/vfx/` from the JavaScript. A parameter added to a generated effect after a dump was made is compared as its default (`vfx::parity`). `fixtures/generators/` keeps the recorded scene documents as inputs; what generated effects draw is stated by `tests/generators.rs`.

## Testing

```sh
cd engine && cargo test -p styk-eval --test suite -- vfx::   # well under a second
cargo clippy -p styk-eval --all-targets
cargo build -p styk-eval --target wasm32-unknown-unknown
```

`tests/vfx.rs` loads every fixture and:

- compares geometry, then every stack effect by effect and parameter by parameter (continuous values within 1e-9 relative, colours, options, seeds, paddings and working slots exactly), connected groups and their order, generated effects and active clips;
- checks that each fixture stops matching without its clips or without its per-pose stacks, and that tweened fixtures stop matching when keys cannot tween;
- checks that documents without effects resolve none;
- replays recorded inputs of the paint interpolation, key sampling, the paddings, working slots and neutral effects (`vectors.json`).

Generated effects:

```sh
cd engine && cargo test -p styk-eval --test suite -- generators::
target/debug/styk generators <file> <tick>…       # a frame's draws, live particles and what they cost
target/debug/styk vfx-review <type> [options]     # contact sheets and frame sequences (Reviewing generated effects)
```

`tests/generators.rs` states the behaviour directly (until 2026-11 it compared every particle with recordings of the old JavaScript editor, whose look was replaced): a frame is the same drawn twice, alone, or after playing to it; every recorded scene document (every style of every type, clip tails, placement, a movieclip) draws finite particles alike twice; an effect outlives its target; a keyed parameter changes new particles only; a moving scene emitter leaves a trail; an aura's size does not follow the pose; body emission is even along the outline; prefill; copies differ unless asked not to; the limits thin evenly and say so; huge soft particles are limited by the area they cover; trails keep the drawing's step; debris lands, bounces and stops; the batch's bounds hold every live particle; retired styles draw as the style they merged into; the materials fit every device and hash the same everywhere. `styk-engine` tests that the anchor cache survives an edit that moves no figure and answers a pending sample with the nearest tick; `styk-raster`'s `gpu_generators` that both renderers draw the same particles, every shape and material at three sizes on white and on dark alike, and that paint covers while light adds (on white, on black, over transparency); `styk-export`'s `pixels` that light over transparency exports as a translucent colour.

Measured when this landed: `TDD2 URIEL NEMESIS 3.styk` (40 clips), all 232 ticks: 602 stacks and 337 effects compared, no difference (nor in its geometry). The Impact FX pack (`AssetReleases/Impact-FX`: the fight scene, 240 ticks, and the 28 movieclip files) keeps its effects, all particles, inside 8 distinct movieclip documents; opened alone, each compares 18 ticks and 16 generated effects with no difference. Their geometry differs where they use 3D poses and surfaces, which the engine did not evaluate then.

Generated effects, measured when they landed (2026-10-03): the eight fixtures, 32 ticks, 8,428 live particles matched the editor bit for bit. That requirement ended with their rebuild (2026-11). In `TDD2 URIEL NEMESIS 3.styk` the explosion clip's target (uid 2386) is absent from every frame of the clip's range; an effect now outlives its target only when the target was there while it ran, so it still draws nothing.
