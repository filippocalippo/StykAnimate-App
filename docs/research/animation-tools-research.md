# StykAnimate animation tools research

StykAnimate’s strongest next direction is faster character posing and motion refinement. The current source already has many of the foundational features that a generic animation roadmap would recommend. The opportunity is to connect those foundations into tools that reduce repeated pose editing while keeping the animator in control.

The recommended first package is **pose assets, selected-limb pose blending, and named character controls**. Follow it with **contact editing and motion adjustments across a range**. Reusable actions and secondary motion become more valuable after those foundations are established.

These priorities are product judgments for stick-figure character animation, not measured customer demand. Research was reviewed on September 13, 2026. Local findings refer to the working source, including substantial uncommitted work, rather than a verified released application. This is a source and documentation analysis; no live usability session, fresh performance benchmark, or release verification was performed.

**Existing capabilities and meaningful gaps**

| Area | Evidence in the current app | Meaningful addition |
| --- | --- | --- |
| IK posing | `src/ik-view.mjs`, `src/editor-ik.mjs`, `src/ik.mjs`: enabled/pinned controls, chain length, stretch, bend direction, target orientation; analytic two-link solving and bounded longer-chain solving | Character control sets, contact ranges, clearer pin/release workflows, and target-space transitions |
| Pose construction | Rig and Handle Edit, branch selection and operations | Named hands/feet/body controls; pose-only mirroring through explicit left/right mappings |
| Inbetweens | `src/insert-inbetween-dialog.mjs` and `src/editor-inbetween.mjs`: chosen ratio, preview, bounded insertion | Adjust an existing pose at the playhead, selected-limb blending, push/relax, overshoot |
| Timing | `src/layer-timeline.mjs`, `src/editor-layer-sheet.mjs`: exposure resizing, range movement/copy, frame insertion/removal, easing | Proportional retiming with anchored events and a clear policy for audio/camera motion |
| Curves | Editable Bezier easing in Simple; layer easing choices in Advanced; procedural camera graphs | Optional character value/velocity inspection; a full property graph editor requires a deliberate product decision |
| Motion paths | `src/motion-path.mjs`, `src/editor-motion-path.mjs`: selected joint/origin/camera trails, sampled frame markers, direct point dragging | Persistent multiple joint targets on one character, path shaping with temporal falloff, optional speed inspection |
| Onion skin | `src/settings.mjs`, `src/onion-controller.mjs`, the engine's `onion_skins.rs`: before/after, colors, opacity, scope, frame/key modes, camera and drawing-order options | Root-aligned comparison, movable reference ghosts, loop-boundary comparison |
| Asset reuse | `src/user-library.mjs`, `docs/movieclips.md`: figures, sets, animated movieclips, reusable definitions, playback modes, speed | Apply a pose or action to an existing compatible character while keeping that character’s identity and artwork |
| Range editing | `src/editor-range-commands.mjs`, `src/range-figure-operations.mjs`, `sheetMoveSelection`: move, rotate, scale, mirror, appearance, joins and other figure operations across frames | Selected-joint corrections across time, with falloff and contact preservation |
| Presentation | Existing VFX stacks, audio editing, camera motion presets, parallax | Later action-specific effects and character secondary motion; another general effects panel is not the priority |

The current layer-sheet contract is more authoritative for the active timeline than older sections of `docs/TIMELINE.md` describing independent property rows. `docs/layer-timeline.md` explicitly establishes layer exposure keys, and the pending changelog records removal of separate inspector property-key controls. Recommendations must respect that decision.

Absence claims below mean that a dedicated feature was not identified in the inspected source and contracts. They do not imply that an animator cannot approximate the result manually.

**Lessons from comparable applications**

Pivot’s inbetweening workflow already separates compact authored frames from generated output frames, with an explicit operation to materialize the generated frames. StykAnimate already has substantial corresponding functionality. The next gain should come from controlling selected parts of the pose and revising motion without unnecessary materialization. [Pivot: adding inbetween frames](https://w.pivotanimator.net/help5-2/adding_inbetween_frames_to_the_timeline.htm).

Blender documents a family of pose tools—pose library, breakdown, blend to neighbor, push/relax, copying, and propagation. Spine similarly provides a Favor slider for intermediate poses. The useful lesson is that interpolation is also an interactive authoring operation, rather than solely an automatic transition between keys. [Blender: editing bone poses](https://docs.blender.org/manual/en/4.5/animation/armatures/posing/editing/index.html), [Spine: Graph](https://esotericsoftware.com/spine-graph).

Spine’s dopesheet supports scaling selected key timing and adjusting multiple selected key values relatively. This is particularly relevant when an animator likes an action but wants its timing or amplitude changed. StykAnimate has range operations already; a refinement tool should add joint-level control and temporal weighting. [Spine: Dopesheet](https://esotericsoftware.com/spine-dopesheet).

Spine describes IK targets for hands and feet, and transform constraints for cases such as equipping or throwing objects. Those are task-oriented precedents for a contact workflow on top of StykAnimate’s existing pins and joins. [Spine: IK constraints](https://us.esotericsoftware.com/spine-ik-constraints), [Spine: Transform constraints](https://esotericsoftware.com/spine-transform-constraints).

Moho documents relative animation transfer between similar skeletons and Smart Bones that drive authored changes. Its export documentation also describes reusable walk, run, idle, and jump actions. These provide useful precedents for motion reuse and user-authored controls, while leaving rig compatibility as an explicit requirement. [Moho: Features](https://moho.lostmarble.com/pages/features), [Moho: actions in the 14.4 exporter](https://moho.lostmarble.com/blogs/news/free-update-export-to-video-game-engines-with-the-moho-14-4-side-quest).

Harmony’s Shift and Trace temporarily repositions reference drawings without modifying the animation. Spine’s ghost offset can help reveal sliding feet in cycles. Better comparison tools can improve posing without introducing a new animation evaluator. [Harmony 25: Shift and Trace](https://docs.toonboom.com/help/harmony-25/advanced/paperless-animation/about-shift-trace.html), [Spine: Ghosting](https://esotericsoftware.com/spine-ghosting).

The current Stick Nodes developer page emphasizes quick controls, selection fixes, sample projects, and onboarding alongside features such as sprite distortion. This supports including tool accessibility in competitive analysis, but does not establish that any particular feature is demanded by StykAnimate users. [Stick Nodes: current developer updates](https://sticknodes.com/).

**Priorities**

Effort is relative engineering scope, not a delivery estimate. Small means a focused command or view extension; medium spans several existing modules; large introduces substantial evaluation, persistence, or cross-track semantics. Benefits remain hypotheses until tested with animators.

| Priority | Tool | Type | Effort | Principal benefit |
| --- | --- | --- | --- | --- |
| 1 | Pose assets applied to existing characters | New workflow over existing library | Medium | Reuse strong poses without reconstructing them |
| 2 | Live selected-limb blend, push and relax | Extension of inbetween authoring | Medium | Build expressive intermediate poses quickly |
| 3 | Named character controls and selection sets | New authoring metadata/UI | Small–medium | Reduce repeated selection and IK setup |
| 4 | Contact ranges and pin/release tools | Extension of existing IK | Medium–large | Make grounded motion and interactions easier |
| 5 | Joint adjustments across time with falloff | Extension of range editing | Medium–large | Revise a whole movement with one gesture |
| 6 | Anchored proportional retiming | Extension of timeline editing | Medium–large | Tune rhythm while retaining important events |
| 7 | Pose comparison and richer path targeting | Extension of existing overlays | Small–medium initially | See arcs, balance and loop problems clearly |
| 8 | Reusable actions applied to a character | New workflow over reuse infrastructure | Large | Reuse motion while preserving the destination character |
| 9 | Limb delay and follow-through | New motion-authoring operation | Medium–large | Add overlap and weight |
| 10 | Matched attach/release transitions | Extension of joins/IK | Large | Simplify props and two-character interactions |
| 11 | Local video reference and annotations | New reference workflow | Medium–large | Study timing inside the workspace |
| 12 | Pose-driven custom controls | New rig capability | Large | Reuse character-specific expressions and body turns |

**1. Pose assets applied to an existing character**

Save “guard,” “crouch,” “contact,” “anticipation,” or a hand pose. Select a character and apply it at the playhead. The operation changes the intended pose values while preserving the selected figure’s identity, appearance, and scene position by default.

The first version should support the same rig definition and selected branches. Store stable handle IDs and a compatibility signature. Expose position inclusion explicitly. Start with apply and preview; introduce blend strength when the live blending tool is ready. An incompatible rig should produce a clear explanation rather than a guessed mapping.

This differs from inserting a saved figure or movieclip, which the app can already do. A saved guard pose should update the fighter already in the scene. Cross-character transfer comes later, after explicit semantic mapping exists.

Acceptance example: save a right-arm guard, apply it to the same rig on another frame, and verify the legs, root, colors, joins, and figure identity remain unchanged. Undo and save/reopen must preserve the result. The pose library concept is established in Blender’s posing toolset; the proposed StykAnimate behavior is a product design recommendation. [Blender: editing bone poses](https://docs.blender.org/manual/en/4.5/animation/armatures/posing/editing/index.html).

**2. Live selected-limb blending, push and relax**

At an existing frame, select an arm and drag toward the preceding or following pose. A second mode exaggerates or relaxes the current deviation from the interpolated pose. For a punch, the torso could be most of the way into its turn while the arm still trails behind. This creates overlapping action without manually reconstructing every joint.

StykAnimate’s current Insert Inbetween dialog already offers a 0–100% ratio. The new capability is selection scope, immediate canvas feedback, editing the pose at the current time, and optional extrapolation. It should reuse the established pose interpolation and IK semantics rather than interpolate raw arrays independently.

The initial version writes an ordinary layer pose key containing the selectively changed values. It does not require a new property timeline. Preserve angular wrapping, bend behavior, unselected figures, and pin targets. Clearly distinguish changing a held key from inserting a new key inside its exposure. [Spine: Favor and blend controls](https://esotericsoftware.com/spine-graph), [Blender: In-Betweens](https://docs.blender.org/manual/en/latest/animation/in_betweens.html).

**3. Named character controls and selection sets**

Allow an animator to identify hips, chest, head, hands and feet, then save useful selections such as upper body or left arm. The mappings should work with connected multi-figure characters, not only a single figure object. Imported rigs need explicit confirmation of the mapping; geometric guessing is an optional suggestion.

A small character control view can expose configured IK targets, bend-side shortcuts, and select-body-part actions. This makes existing functionality faster to reach and creates a reusable foundation for pose mirroring and later action transfer. Do not require anatomical labels for non-humanoid figures.

Add “mirror pose to opposite limb” only after left/right mappings are known. Existing whole-figure and branch flips are different operations. Named controls are a proposed StykAnimate design, not evidence of a missing solver.

**4. Contact ranges and pin/release tools**

Select a foot and mark its contact interval. During that interval, body changes should retain the intended contact position. Release at the end without a visible jump. Extend the interaction to hands on walls, a hand holding a prop, and a foot on a moving platform only after the ground-contact version is reliable.

The app already has persistent pin settings in pose data and no-jump capture logic for configuring IK. The gap is an explicit contact workflow across time. A first implementation can author pin values into existing pose keys; a dedicated contact track should be introduced only if ordinary keys make editing too cumbersome.

Use visible contact start/end indicators, “pin here,” and “release here.” Test unreachable targets, two planted feet, bend direction near full extension, pin changes in tweens, and root movement. Existing code rejects overlapping IK chains; the tool must explain that constraint instead of pretending to provide unrestricted full-body solving. [Spine: IK constraints](https://us.esotericsoftware.com/spine-ik-constraints).

**5. Joint adjustments across time with falloff**

Select frames around a jump, raise the hips at its apex, and taper the adjustment toward the range ends. Or bend an elbow more throughout a punch without changing its timing. Existing range movement and figure transforms cover part of this space; the addition is selected-joint editing and varying influence over time.

Provide an initially simple influence choice: uniform or smooth falloff. Preview sampled ghosts and publish one history command. Pinned endpoints should have explicit preservation rules. Avoid silently editing every output frame: first target selected authored poses, with an explicit bake option for corrections that need denser sampling.

This is likely to deliver substantial value for experienced animators because it supports revising work already made. The claim is a workflow hypothesis. Spine’s relative multi-key adjustment is an established precedent; temporal falloff is the proposed extension. [Spine: Dopesheet Adjust](https://esotericsoftware.com/spine-dopesheet).

**6. Anchored proportional retiming**

Compress an anticipation while preserving the hit frame; lengthen the recovery without shifting that hit. Ordinary range movement and exposure resizing already exist. Proportional timing changes with fixed event anchors would let an animator shape a movement’s rhythm in fewer operations.

Start with one selected layer range and two fixed endpoints. Whole-scene timing needs a visible policy for audio, camera keys, procedural camera clips, contacts, and nested movieclip playback. Camera-motion clips currently use absolute frames, while audio uses seconds and an explicit ripple policy. A retime tool must not accidentally desynchronize them.

Integer-frame compression creates collisions. Preview and reject impossible mappings, or offer a clearly stated resampling operation. Do not silently drop poses. Spine’s key-scaling and graph handle-preservation tools are useful references for the interaction and curve concerns. [Spine: Dopesheet](https://esotericsoftware.com/spine-dopesheet), [Spine: Graph](https://esotericsoftware.com/spine-graph).

**7. Comparison tools and path refinement**

Add persistent trail targets for both hands, both feet and hips on the same character. The current path target logic primarily selects one joint on the primary figure and origins for additional figures. Follow with optional speed coloring and selected-window path shaping, reusing the existing sampling budget.

For onion skin, add root-aligned comparison so a traveling character’s body poses can be compared in place. A movable reference ghost can help compare silhouettes or a distant key pose. Loop-boundary ghosts should make the last-to-first transition inspectable. All these are editor overlays and must not affect output or saved motion.

Root-aligned ghosts are a proposed design. Harmony’s temporary reference transforms and Spine’s offset/loop ghost options demonstrate related comparison techniques. [Harmony: Shift and Trace](https://docs.toonboom.com/help/harmony-25/advanced/paperless-animation/about-shift-trace.html), [Spine: Ghosting](https://esotericsoftware.com/spine-ghosting).

**8. Reusable actions and cycle editing**

Capture a walk or punch as an action and apply it to the selected character, preserving destination artwork. Begin with identical rigs and explicit relative root placement. Add mirror, speed, repeat count, and phase controls only where they extend the existing movieclip behavior meaningfully.

The key distinction is applying motion to the character, including only selected limbs, rather than inserting another animated container. Cross-rig retargeting needs a mapping and proportion policy. A walk can retain angular motion while still sliding because stride length and travel distance differ. Contacts and root displacement therefore need separate treatment.

Cycle editing can later include matching first/last poses, phase-shifting an arm, and stride-distance previews. Full action mixing is a major semantics change; a first version should write editable pose keys with one undo step. [Moho: rigging and relative animation transfer](https://moho.lostmarble.com/pages/features), [Moho: reusable actions](https://moho.lostmarble.com/blogs/news/free-update-export-to-video-game-engines-with-the-moho-14-4-side-quest).

**9. Limb delay and controlled follow-through**

Delay a head turn by two frames relative to the torso, or let an arm overshoot and settle. Start with a bounded authoring command that samples a selected branch at an offset time and writes editable keys. This is easier to reason about than continuous physics.

A later spring tool could assist hair, tails, scarves or accessories. It must produce the same result when playing, scrubbing backward, reopening, and exporting. Spine’s documentation explicitly describes the computational cost of deterministic physics replay. StykAnimate should use bounded worker preparation and explicit baking or checkpoints rather than unbounded replay during every seek. [Spine: Physics constraints](https://esotericsoftware.com/spine-physics-constraints).

**10. Matched attach/release transitions**

Make a sword follow a hand, switch it to world motion on release, then attach it elsewhere without jumping. Join/detach operations already exist, including across frames. The useful addition is transition matching, timed control, and clear ownership of target space.

Treat moving-target IK and attachment changes as related but distinct capabilities. Detect dependency cycles before publication and preserve world appearance at the switch. A selected-frame command is a practical first scope; weighted parent blending is a later capability. [Spine: Transform constraints](https://esotericsoftware.com/spine-transform-constraints).

**Additional ideas worth keeping**

| Idea | Concrete use | Suggested order |
| --- | --- | --- |
| Local video reference | Scrub recorded movement beside the scene, synchronize by offset, mark useful poses | After the first posing package; requires bounded decoding and frame-rate mapping |
| Timeline annotations | Mark contact, anticipation, impact and recovery without creating animation keys | Good small companion to retiming |
| Pose-driven controls | A user-authored slider moves a face turn, fist closure or body turn through saved poses | After pose assets; inspired by Moho’s Smart Bones, not automatic 3D rotation |
| Hand/mouth substitution picker | Choose authored variants while keeping attachment placement | Useful for expressive characters; related to Harmony drawing substitutions |
| Lightweight pose checks | Highlight selected contact drift or unreachable targets | Advisory overlays after contact tools, not an automatic judge of animation quality |
| Editable walk-cycle starter | Generate a small set of contact/down/passing/up poses from mapped limbs | After mappings and contacts; preserve manual editing |
| Smear and impact helpers | Create editable transient shapes or poses over a short selected range | Later action package, using the existing VFX/movieclip infrastructure where appropriate |

Moho’s Smart Bones provide a precedent for user-authored controls. Harmony offers a thumbnail-based drawing substitution view. The proposed StykAnimate versions should remain narrow and preserve the project’s editable figure semantics. [Moho: Features](https://moho.lostmarble.com/pages/features), [Harmony 25: Drawing substitutions](https://docs.toonboom.com/help/harmony-25/essentials/cut-out-animation/swap-drawing-picker-view.html).

**Work to defer**

A full character graph editor deserves a separate decision. StykAnimate already exposes easing and stores animation infrastructure, but a graph that edits independent limb values may conflict with the present whole-layer key model. Read-only value/speed plots or better easing controls are smaller steps. A graph is most compelling if experienced animators repeatedly need precise numerical curve edits that canvas tools cannot provide.

Full-body physics, automatic motion capture, general image-to-animation generation, and unconstrained retargeting should follow clearer evidence of demand. These introduce larger correctness and editing burdens. Generative output is particularly less useful when it cannot preserve the selected rig’s topology, contacts, timing and editable motion. No remote processing should be assumed for this local application.

**Implementation sequence and verification**

| Package | Scope | Completion evidence |
| --- | --- | --- |
| A: Faster posing | Same-rig pose assets, selected-branch blend, named controls | Create a guard and crouch, apply partial poses, undo, reopen and export without changes to unrelated parts |
| B: Better movement | Contact ranges, weighted joint correction, improved path/ghost targets | Revise a walk and jump while preserving contacts, outside-range motion, and bounded interaction cost |
| C: Timing and reuse | Anchored retiming, annotations, same-rig action transfer and cycle tools | Retiming keeps declared anchors and explicitly included media synchronized; reused action preserves destination identity |
| D: Expressive polish | Limb delay, baked spring motion, matched prop transitions | Arbitrary seek and export produce matching poses; cancellation and undo restore the original animation |

Use the existing editor command/history layer as the owner of authored changes. Keep overlay samples outside document state. Reuse stable IDs, pose snapshots, sparse layer keys, revision invalidation, worker transport, and existing export evaluation. New pose tools must account for the app’s native absolute-angle skeletons and joined components; generic local-angle recipes are insufficient.

For each package, run the repository’s JavaScript checks and affected unit/browser tests after implementation. Add meaningful coverage for topology mismatch, connected rigs, held cells versus tween interiors, lock rules, one-step undo, save/reopen, and export agreement. Performance-sensitive range operations need representative dense-scene measurements and cancellation checks. These are future completion requirements; they have not been executed for hypothetical tools.

Validate priorities with a small comparative animator exercise: create a walk, a jump, and a punch with a prop. Record time to a chosen result, corrective edits, undo usage, and animator preference. Existing diagnostic event counts alone cannot establish demand for a tool that does not yet exist.

**Source inventory**

Official product documentation establishes feature precedents, not independent estimates of productivity. Undated pages were reviewed September 13, 2026; versioned manuals are identified below. Some Blender direct-page fetches failed; accessible indexed official documentation supports the limited tool descriptions used here. No numerical productivity claims are inferred from those sources.

| Publisher | Source | Version/date context | Used for |
| --- | --- | --- | --- |
| Pivot Animator | [Adding Inbetween Frames to the Timeline](https://w.pivotanimator.net/help5-2/adding_inbetween_frames_to_the_timeline.htm) | 5.2 guide; undated | Compact versus materialized inbetweens |
| Blender Foundation | [Editing Bone Poses](https://docs.blender.org/manual/en/4.5/animation/armatures/posing/editing/index.html) | 4.5 LTS manual | Pose tool family and library precedent |
| Blender Foundation | [In-Betweens](https://docs.blender.org/manual/en/latest/animation/in_betweens.html) | Indexed 5.2 LTS manual | Breakdown, push/relax and neighbor blending |
| Esoteric Software | [Graph](https://esotericsoftware.com/spine-graph) | Live user guide; undated | Favor controls, curves and timing handles |
| Esoteric Software | [Dopesheet](https://esotericsoftware.com/spine-dopesheet) | Live user guide; undated | Relative key adjustment and timing scale |
| Esoteric Software | [IK Constraints](https://us.esotericsoftware.com/spine-ik-constraints) | Live user guide; undated | Endpoint posing and contact precedent |
| Esoteric Software | [Transform Constraints](https://esotericsoftware.com/spine-transform-constraints) | Live user guide; undated | Object interactions and transform matching |
| Esoteric Software | [Ghosting](https://esotericsoftware.com/spine-ghosting) | Live user guide; undated | Loop ghosts and foot-slide inspection |
| Esoteric Software | [Physics Constraints](https://esotericsoftware.com/spine-physics-constraints) | Live user guide; undated | Secondary motion and deterministic replay costs |
| Lost Marble | [Moho Features](https://moho.lostmarble.com/pages/features) | Live product page; undated | Relative transfer and authored controls |
| Lost Marble | [Moho 14.4 export update](https://moho.lostmarble.com/blogs/news/free-update-export-to-video-game-engines-with-the-moho-14-4-side-quest) | 14.4 update | Reusable animation actions |
| Toon Boom | [About Shift and Trace](https://docs.toonboom.com/help/harmony-25/advanced/paperless-animation/about-shift-trace.html) | Harmony 25; updated March 26, 2026 | Temporary reference-pose transforms |
| Toon Boom | [Drawing Substitutions](https://docs.toonboom.com/help/harmony-25/essentials/cut-out-animation/swap-drawing-picker-view.html) | Harmony 25 | Variant picker precedent |
| ForTheLoss Games | [Stick Nodes developer updates](https://sticknodes.com/) | Includes August–September 2026 updates | Quick tools and onboarding context |

Local evidence includes `README.md`, `CHANGELOG.md`, `docs/ARCHITECTURE.md`, `docs/layer-timeline.md`, `docs/animation-modes.md`, `docs/TIMELINE.md`, `docs/SCENE-EDITING.md`, `docs/MOTION-PATHS.md`, `docs/movieclips.md`, `docs/camera-motion.md`, `docs/AUDIO-UX.md`, and the owning source modules identified in the capability table. Older acceptance reports were treated as historical evidence, not fresh verification.
