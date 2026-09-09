# StykAnimate UI and UX overhaul audit

September 9, 2026 · Current source version: package.json 0.3.0

## Recommendation

Rebuild the interface around **choose a figure → pose it → control its timing → preview → export**. Make animation the default working context. Give shared rig construction its own unmistakable context. Make selection, edit scope, and saved state explicit throughout.

The current app has a recognizable editor shell and considerable capability. Its primary problem is that several interaction models occupy the same surface without sufficiently explaining their relationship. A visual refresh alone would preserve that confusion.

Assumption: StykAnimate remains a desktop-first stick-figure and rigged 2D animation editor, serving both Pivot users and people learning animation. This proposal preserves that focus rather than expanding into a general drawing, compositing, or video-editing suite. Recommendations are design hypotheses to validate; this is not a claim of universally “perfect” UX.

## Evidence and coverage

I launched the current source at localhost and inspected its rendered interface at the browser's existing 1280 × 720 viewport. I reviewed the initial demo workspace, object inspector, Design/Animation tab behavior, Rig tool, camera selection, Assets library, main menu, Settings, export dialog collapsed and expanded, and text creation dialog. I cancelled text creation and did not export or save a project.

Source review covered the shell, styles, inspector dispatch, layers, asset insertion, both timeline implementations, frame drafts, panel constraints, settings, camera actions, background/text/sprite/segment/inbetween dialogs, import/save/export paths, recovery integration, and localization documentation. These are targeted UI and workflow reads, not a line-by-line review of rendering or codecs.

**Limitations:** Simple timeline behavior, native file dialogs, packaged desktop-only formats, recovery after a crash, complex rig construction, dense projects, alternate languages, and other viewport sizes were not exercised end-to-end in this audit. Findings for those areas are marked as source findings or proposed validation. Browser-disabled MP4/AVI/WMV choices are a platform distinction, not evidence that desktop export is broken. No user study, accessibility conformance audit, or performance benchmark was conducted.

## What is worth retaining

- A central stage, left hierarchy, right inspector, and lower timeline already form a useful foundation.
- Direct joint manipulation, numeric scrubbing, keyboard commands, and onion skins support repeated animation work.
- Searchable, virtualized layers and asset previews are valuable for large documents.
- Native project saving, draft preservation, recovery, and undo are important foundations for trust.
- Text authoring already has a live preview and separate draft/apply behavior.
- Resizable panels and persistent layouts support different screens. Keep those capabilities, but improve the starting layout.
- The current neutral palette and restrained icon style can evolve. A new brand identity is not a prerequisite.

## Findings, ranked by impact

Priority definitions: **P0** blocks a trustworthy editing model; **P1** materially affects everyday work; **P2** improves consistency, learnability, or longer-term quality. These are design priorities, not measured defect frequencies.

| ID | Priority | Evidence and problem | Recommended change |
| --- | --- | --- | --- |
| 01 | P0 | **Inspector tabs can promise a change they do not deliver.** With Walker selected, clicking Animation changed the active tab but retained figure properties. The click handler changes `inspectorTab`; `inspectorView` gives the explicit `inspectorContext` precedence. | Replace the two competing selectors with one selection-driven inspector. A tab should either have a reliable, distinct purpose or be removed. |
| 02 | P0 | **Shared rig scope is concealed.** Rig is an icon beside pose tools. The source generates “Updates every instance of this figure,” but `#inspector .property-note { display: none; }` hides it. The rendered Rig state did not show that warning. | Enter a named Rig context with a persistent scope banner, clear exit, and an action to make an independent rig copy. Restore essential guidance immediately. |
| 03 | P0 | **The editing contract changes with timeline mode.** Simple uses stored-frame Add/Update and a working draft; Advanced uses layers and property keys. The choice lives in Settings → Interface, while Advanced separately offers Layers/Frames. | Separate workflow choice from timeline display. Explain any semantic transition and preserve drafts, timing, history, selection, and document fidelity. Do not disguise a conversion as a cosmetic view toggle. |
| 04 | P1 | **Timeline chrome crowds out animation.** At 1280 × 720 the default 193 px timeline contains transport, edit toolbar, heading/ruler, bottom navigation, and footer. Only about one complete track row is clearly visible. | Use a full-width lower timeline, consolidate navigation, and budget actual track area. Offer a deliberate expanded timeline state. |
| 05 | P1 | **Selection has several visually competing meanings.** Layer 1 and Walker are both highlighted initially. Selecting Camera retains Walker's selected state and the footer still names Walker. This may preserve useful state internally but is difficult to interpret visually. | Distinguish active edit target, retained object selection, selected keys, and selected range. Show one plain-language scope line beside the relevant actions. |
| 06 | P1 | **The inspector is a long, equally weighted command list.** Transform, Appearance, Outline and Connection coexist with many arrow/diamond controls. Delete sits in Appearance; fixed 15° rotation sits among routine transforms. | Group by user intent, collapse secondary sections, move object commands to a menu, and give each property a clear local animation affordance. |
| 07 | P1 | **The canvas dock mixes navigation, posing, rig construction, creation and a modifier.** Eleven controls include Select, Pose, Handle edit, Rig, Isolate, Line, Circle, Polygon, Text, Pan and Add figure. | Use a small stable tool rail plus a contextual options row. Show construction tools in Rig context. Explain advanced posing options in a labeled popover. |
| 08 | P1 | **Export starts with a format inventory.** Fourteen choices were visible in the browser. Expanding settings exposes GIF, WebM, MP4 and AVI parameters together before an output is chosen. | Start with output type and preset, then show applicable settings and one Export button. Keep existing formats accessible. |
| 09 | P1 | **Timing vocabulary requires translation.** The interface exposes 24 keys, 47 frames, frame index, Hold in ticks, and Inbetweens in different places. These are distinct concepts but their relationship is weakly explained. | Use a consistent glossary and show authored pose number separately from playback frame. Display duration in frames and seconds, with interpolation as a separate concept. |
| 10 | P1 | **Scope and navigation explanations are inconsistently visible.** Important inspector notes are hidden globally; many distinctions depend on tooltips or shortcuts. | Restore short, specific guidance where an action changes scope or meaning. Use progressive disclosure for detail, never for essential consequences. |
| 11 | P2 | **Asset selection and insertion are conflated.** Library entries look like selectable rows; source click handling immediately adds the asset. Import is available both in the panel heading and its footer. | Single click previews/selects; explicit Add or drag places an instance. Retain a documented fast insertion gesture. Consolidate import under the Library. |
| 12 | P2 | **The project title looks like a dropdown but opens rename.** Header markup supplies a chevron to a rename action. The main brand menu mixes file, edit, creation, settings and diagnostics. | Make the document dropdown a real document menu. Put Rename there; use familiar command groups and searchable commands. |
| 13 | P2 | **Creation can interrupt scene composition.** Text opens a large separate preview and pushes styling below the fold at the inspected size. Background source combines library choice and fill creation with different apply actions. | Prefer scene-context previews with compact property editing. Keep modal font/advanced editors when needed; standardize Apply/Cancel and explicit targets. |
| 14 | P2 | **Density is achieved partly through small text and targets.** Source uses 9–11 px auxiliary text and layer buttons around 20 × 23 px. Several buttons have technical accessible names such as `root_x`. | Establish typography, control-size and accessibility tokens. Use human-readable names, visible focus, and non-color state cues. Measure contrast and target spacing. |
| 15 | P2 | **Layout customization competes with content navigation.** Each panel exposes move/float controls beside its tabs; reset is in Settings. | Provide Animate, Rig and Focus workspace layouts, with panel controls in an overflow and Reset workspace under View. Retain keyboard resizing and floating. |
| 16 | P2 | **Localization is explicitly partial.** Documentation records mixed English and translated controls, and UI strings remain embedded in components. | Build redesigned components around message keys, translated accessible names, pluralization and expandable layouts from the start. |

## Proposed workspace

Use three levels of organization: **document commands**, **working context**, and **current selection**. Do not introduce another independent “beginner/pro” switch that changes the meaning of editing commands.

```text
┌───────────────────────────────────────────────────────────────────────────┐
│ File  Edit  View  Help   Project name · Saved    Animate | Rig   Export…   │
├───────────────────────────────────────────────────────────────────────────┤
│ Tool options / edit scope                Onion skins  Camera view  Zoom   │
├───────┬──────────────────┬───────────────────────────────┬─────────────────┤
│ Tools │ Scene | Library  │                               │ Inspector       │
│       │ Search           │             STAGE             │ Walker          │
│Select │ Layer / figures  │                               │ Frame 12 · Pose │
│Pose   │                  │                               │ Transform       │
│Pan    │                  │                               │ Appearance      │
│Add…   │                  │                               │ More…           │
├───────┴──────────────────┴───────────────────────────────┴─────────────────┤
│ Timeline view ▾   Previous  Play  Next  Frame 12   Loop   Zoom/Fit         │
├──────────────────────────┬────────────────────────────────────────────────┤
│ Track / property names   │ Ruler · work range · playhead                  │
│ Walker                   │ ●────────●────────●                            │
│   Position               │ ◇────────◇────────◇                            │
│ Ground                   │ ●─────────────────                             │
├──────────────────────────┴────────────────────────────────────────────────┤
│ Selection / operation feedback                       Project save state   │
└───────────────────────────────────────────────────────────────────────────┘
```

This is a structural wireframe, not a pixel-accurate mockup or implemented screen.

**Animate:** default. Pose figures, manage timing, edit camera animation, and preview. Selection and posing remain distinct tools with clear names. “Add…” opens figures, images and text without exposing every construction command permanently.

**Rig:** edits the reusable figure definition. Show `Editing rig: Walker · shared by …` with an accurately computed usage description. Display construction joints, branches, shapes and rig styles. Keep a small pose-test preview if useful; the animation timeline may collapse. Offer `Return to animation` and `Make independent copy` with well-defined consequences. Switching context itself must not alter the document.

**Focus:** a layout preset or temporary canvas expansion, not a third editing model. Preserve selected object, playhead, and tool when entering and leaving it.

At 1280 × 720, start prototyping with a 44–48 px command row, a 32–36 px context row, a 40–44 px tool rail, a 190–220 px scene panel, a 260–280 px inspector, and a 240–270 px full-width timeline. These are initial design budgets to validate, not fixed CSS requirements. Target at least four usable track rows in the normal laptop layout. When height is insufficient, offer a clearly labeled timeline expansion rather than shrinking everything further.

## Ownership of controls

| Surface | Owns | Move out |
| --- | --- | --- |
| Document header | New/Open/Recent, project name, saved state, Save, Export | Scene dimensions and object commands |
| Context row | Current tool options, explicit edit scope, onion skin access, editor zoom, view selector | File operations and raw diagnostics |
| Tool rail | Select, Pose, Pan, Add; construction tools in Rig | Standalone toggle modifiers and export |
| Scene panel | Layers, instances, search, visibility, locking, ordering | Frame operations |
| Library | Reusable figures, images, text assets/backgrounds as supported, import, examples | Duplicate import bars and ambiguous click-to-add behavior |
| Inspector | Properties of exactly the named selection and its scope | Unrelated creation, delete/reorder toolbars repeated inside styling sections |
| Timeline | Timing, keys, exposure, playback, work range, retiming | Panel customization buttons and duplicated counters |
| Preferences | Language, appearance, input behavior, recovery interval | Daily onion-skin adjustments and primary workflow discovery |

## Inspector and selection contract

Replace Design/Animation with one inspector whose header describes its target. If distinct property tabs remain necessary, label them by content, such as Properties and Timing, and derive both from the same selection model.

| Selection | Header and first controls |
| --- | --- |
| None | Scene · size, background and project frame rate |
| Figure | Walker · current frame; transform and appearance |
| Joint/segment | Walker / selected joint; angle, length or stretch controls appropriate to the tool |
| Several figures | 3 figures · current frame; shared properties with Mixed values, align and distribute |
| Layer | Layer name; visibility, lock and contents |
| Key or range | Selected key/property or frame span; duration, interpolation and applicable retiming |
| Camera | Camera · current frame; transform and framing, clearly distinct from editor zoom |
| Shared rig | Rig name; persistent shared-definition scope and construction properties |

Keep common fields in predictable positions. Use Position X/Y together when width permits; put Rotation and Scale nearby. Show ordinary values with useful display precision without truncating stored precision. Mixed values must never pretend to be the first selected object's value.

Use one visible diamond per animatable property with distinct keyed, animated-between-keys, and unanimated states. Reveal previous/next navigation on focus or in the animation details section, while retaining keyboard access. Do not hide the fact that a value is animated.

Move Duplicate/Delete/Arrange into an object action menu and context menu. Keep Undo accessible globally and describe the last action. Collapse Outline when unused. Reveal Connection details when attached or when the user chooses Attach. Keep Reset pose discoverable but secondary.

For range edits, display `Apply to: Current frame / Selected range` next to the operation, including the range bounds. Never carry an invisible range target into an unrelated edit. Preserving a selected figure while editing Camera is acceptable internally; visually, Camera must be the unmistakable active target.

## Timeline and animation behavior

The long-term goal is one consistent document model with multiple representations. The current implementations have different semantics, so achieve that in stages.

1. **Near term:** move the workflow selector out of obscure preferences into a clearly explained timeline menu. Name the workflows `Frame-by-frame (Pivot)` and `Keyframe animation`. Explain what changes before switching; resolve a pending working pose without discarding it. Keep the Advanced Layers/Frames distinction subordinate and name it by the operation's scope.
2. **Later, after parity tests:** provide `Frames` and `Dope Sheet` views over compatible document state. A view switch must preserve output, edit scope, timing and history. If that cannot be guaranteed, retain an explicit workflow conversion instead.

In frame-by-frame workflow, make `Add next frame` the obvious action. When editing an existing stored frame, show `Editing frame 12 · Modified` and a clearly named `Update frame`. Explain when navigation commits a draft. Provide a reversible revert action and never use an unlabeled state change to distinguish a new pose from a stored frame.

In keyframe workflow, define and show the keying policy. A proposed default is automatic key insertion for pose gestures within Animate, with a visible Auto-key state and undo label. Validate that choice with existing users before rollout; never silently replace established keying semantics. With Auto-key off, show when a value is only a working preview and provide Add key/Revert.

Use a single primary playback-frame readout. Distinguish it from an authored pose/key index with labels such as `Pose 3 · Frame 9`. Show timing as `8 frames · 0.33 s` where appropriate. A hold and interpolation are not synonyms: preserve Pivot's exact timing rules and expose any special zero-duration state explicitly rather than relabeling raw fields mechanically.

Show keys, held spans, blank poses and interpolated intervals differently. Use shape and pattern as well as color. Selection and playhead must have distinct appearances. Show the selected object's track automatically, with a visible filter state if other tracks are hidden. Scene and Camera should remain accessible without always consuming the first scarce rows.

Place Insert key, Duplicate, Delete and Retime beside the selected keys or in one compact edit group. Keep named menu equivalents and shortcuts. Consolidate playback/navigation into one transport row. A curves/easing editor can arrive later as an alternate lower panel; it should not delay fixing the core timeline.

## Revised primary journeys

### Start and learn

First launch offers New animation, Open project, Recent files, and a clearly labeled example. Keep “First steps” as an example rather than making it indistinguishable from a user's new document. New animation asks only for a useful canvas preset and frame rate, with advanced configuration optional.

The empty stage gives one next action: Add a figure. A brief, dismissible exercise guides Add → Pose → Add next frame → Play. Experienced users can skip it. Do not require an account or cloud workflow for this local editor.

### Add and pose a figure

Open Library, choose a figure, preview it, and drag or press Add to place it. Select the new instance and reveal its track. Pose shows movable handles with a short tool description. Stretch, isolate and fixed-point handle editing are named tool options with shortcuts, not an undifferentiated cluster of icons.

Retain Pivot-compatible joint colors where they are useful. Add shapes or outlines for origin, selected, joined and static states. Prefer selected-figure handles by default, with a quick All handles option. Keep screen-space hit targets usable when zoomed out without making the visible joints excessively large.

### Edit a rig safely

Choose Edit rig from the figure or workspace control. The stage enters construction view and names the shared definition. Users can either edit it for all uses or make an independent copy before modifying it. Construction actions and pose edits have different undo descriptions. Return to animation restores the previous playhead and selection. Do not add repetitive confirmations to every joint movement; communicate scope continuously.

### Animate the camera

Select Camera in the scene or timeline. Label the canvas view `Scene view` or `Camera preview`. Editor zoom changes only the viewport; camera scale changes animation. Put center/fit commands in a Framing group. Move Apply camera transform to figures into an advanced, explicitly described command because it changes figure data rather than just the view.

### Create text, images and backgrounds

Use Add → Text/Image and an immediate scene preview where feasible. Keep a compact initial text editor: content, font, size, alignment and fill. Move font sourcing, gradient and outline detail behind appropriate controls. Preserve portable text outlines and draft isolation. For sprites, show placement and attachment target together. For backgrounds, distinguish Use library background from Create/edit fill; use consistent action labels and scope feedback.

### Export

Replace the format grid with `Video / Animated image / Still or sequence / Editable file`. Within the chosen category, offer a format and preset. Recommend MP4 for common video sharing only when supported by the current runtime; use an available alternative with an explanation when it is not. Keep PNG sequence, GIF/APNG, SVG, PIV/STK and legacy video options discoverable.

Show dimensions, frame range, duration, background/transparency behavior, destination and one Export button. Show only applicable quality settings. Put codec configuration in Advanced. Add a preview or representative frame. Before export, explicitly resolve any draft that would otherwise be omitted: add/update it or deliberately export stored frames. Preserve the original project regardless of the choice.

During export show phase, progress and cancellation when supported. On success, show the filename and Open output/Show in folder where the platform permits. Failure should preserve chosen settings and explain an actionable retry. Do not treat a browser capability limitation as a generic encoding error.

### Save and recover

Distinguish `Project saved`, `Unsaved changes`, `Saving…`, and `Recovery copy updated`. Recovery is not the same as saving the user's named file. The header's document menu should include Rename, Save as, and location information where available. Recovery selection should identify the file and timestamp, preserve the original, and make the recovered copy's state explicit. Validate native behavior separately.

## Visual system and accessibility

Use a restrained editor design: neutral surfaces, a clearly separated stage, one primary accent, and semantic colors reserved for meaningful states. Offer light and dark themes using common tokens. “Modern” should mean legible and predictable rather than fashionable effects.

- Prototype with 12–13 px normal control labels, 14 px panel headings, and smaller text only for secondary metadata. Use tabular numerals for frames and coordinates.
- Use a small spacing scale such as 4/8/12/16/24 px, restrained corner radii, and shared control heights. Avoid boxing every field and section with equal emphasis.
- Prefer 28–32 px compact desktop controls and larger primary actions. Evaluate target size and spacing together; W3C's 24 × 24 CSS px minimum criterion has exceptions and is not a blanket rule for every dense timeline key.
- Measure text and non-text contrast in normal, hovered, selected, disabled and focused states. The current small gray labels are a reason to test, not proof of universal failure.
- Give tools accessible pressed states and panels proper tab semantics. Replace accessible names such as `root_x` with Position X.
- Make the timeline's keys and selection reachable through a coherent keyboard model. Preserve alternative numeric controls for operations that cannot depend on precise dragging.
- Keep keyboard shortcuts context-aware: text entry must not trigger canvas actions. Explain tap-versus-hold behavior for Space and handle-edit modifiers consistently.
- Avoid moving controls during ordinary selection changes. Preserve inspector scroll per context, focus after dialogs, and layouts at increased UI scale.
- Localize redesigned labels and accessible text together. Check Italian/German expansion, CJK fonts, and RTL text without reversing animation time or canvas coordinates.

## Implementation sequence

| Phase | Scope | Exit criteria |
| --- | --- | --- |
| 1. Trust and clarity | Fix inspector context dispatch; restore essential scope notes; clarify active selection, draft state and timing terms | A user can state what the next edit changes and whether it is stored; tab behavior is deterministic |
| 2. Workspace foundation | Shared design tokens and controls; full-width timeline; contextual tool rail; single inspector; layout presets | Four usable timeline rows at the target laptop size; primary pose workflow does not require searching menus |
| 3. Workflow rebuild | Library placement, frame/key workflows, range editing, camera scope, contextual creation | Walkthroughs complete with clear targets, undo and no hidden draft loss |
| 4. Files and delivery | Startup/Recent, export categories and presets, save/recovery feedback, relevant format settings | User can save, reopen and export expected content with an explicit destination and result |
| 5. Polish and validation | Theme, localization, accessibility, onboarding, dense projects and desktop integration | Validation matrix below passes; unresolved issues are recorded before rollout |

Preserve the existing editor command layer, codecs, GPU rendering, worker pipeline, clipboard semantics and document fidelity while replacing presentation. Avoid combining a full UI rewrite with a renderer or file-format rewrite.

Introduce a single UI context model for workspace, active target, selected objects, selected keys/range, and edit scope. Derive inspector and toolbar state from it. Consolidate component styling currently spread across `style.css` and injected module CSS. Route buttons, shortcuts and menus through a common command description so labels, availability and scope agree. Migrate stored layout preferences with a safe reset path.

## Verification and usability acceptance

These are proposed release gates, not completed results. Test novice animators and experienced Pivot users separately; also include users familiar with timeline editors. Start with a small formative round and iterate rather than treating a small sample as statistical proof.

| Task or condition | What to observe or verify |
| --- | --- |
| Make a two-pose animation | Can a newcomer add a figure, pose, add the next frame and play without coaching? Record time, misclicks and help requests. Initial target: under three minutes. |
| Change timing | Can the user distinguish hold from interpolation and predict the resulting duration? |
| Edit one joint / shared rig | Can the user identify whether the change affects this pose, a range, or every rig instance before acting? Require no unintended scope changes in the test tasks. |
| Select Camera after a figure | Header, toolbar and inspector agree on the active target; retained figure selection is visually secondary. |
| Switch timeline representation/workflow | Drafts, output timing, keys, selection and undo remain intact, or a clearly explained conversion handles differences. |
| Export with a pending working pose | The chosen content, range, dimensions and transparency match the output. No omitted pose without explicit explanation. |
| Save/reopen/recover | Named project and recovery copy are distinguishable; working poses and assets survive supported round trips. |
| 1280 × 720 and 1440 × 900 | No inaccessible primary actions; useful stage area; at least four track rows in normal Animate layout. Also inspect 1024 × 768 and 150%/200% scaling for supported compact behavior. |
| Dense scene and long timeline | Selection reveals the appropriate track; search remains useful; new components retain virtualization and bounded work. Measure on representative hardware. |
| Keyboard-only and assistive technology | Predictable focus, announced selection/key states, useful field names, no hidden keyboard traps. |
| Cancel / error paths | Escape and Cancel restore prior state; export/import errors retain context; retry does not duplicate actions. |
| Native desktop integration | Recent files, save locations, clipboard, window controls, codecs and recovery tested in the actual packaged app. |

Prioritize scope mistakes and lost work above visual preference ratings. Compare before/after task completion, time to find controls, and ability to explain state. Set final quantitative targets after measuring the existing app.

## Source map

Paths are relative to the repository root. Searchable anchors are included because line positions may change as development continues.

| File | Relevant evidence / work |
| --- | --- |
| `index.html` | `tool-dock`, `data-inspector`, `document-tab`, timeline shell |
| `src/app.mjs` | `renderInspector`, inspector-tab click handler, `showMenu`, `showExport`, `showRecovery`, import/save actions |
| `src/inspector-view.mjs` | `resolvedContext`, shared Rig note, property key controls, `frameView`, `cameraView`, section grouping |
| `src/style.css` | `#inspector .property-note`, typography, responsive rules and export layout |
| `src/timeline.mjs` | Timeline editbar/navigation, hierarchy, keys/ranges and virtualized layout |
| `src/simple-timeline.mjs` | Add/Update controls, frame thumbnails and inbetweens |
| `src/editor-frame-draft.mjs` | Draft state and preservation semantics |
| `src/layer-panel.mjs` | Hierarchy, selection styling and compact visibility/lock targets |
| `src/asset-library.mjs` | Library click-to-add behavior and bounded previews |
| `src/settings.mjs` | Advanced default, workflow choice under Interface, canvas/onion preferences |
| `src/workspace-layout.mjs`, `src/workspace-panels.mjs` | Constraints, 193 px short-screen timeline, docking/persistence |
| `src/text-dialog.mjs`, `src/background-dialog.mjs`, `src/sprite-placement-dialog.mjs`, `src/segment-values-dialog.mjs`, `src/insert-inbetween-dialog.mjs` | Creation and modal interaction contracts |
| `src/camera-view.mjs` | Camera framing and apply-to-figures command |
| `docs/LOCALIZATION.md` | Explicit translation coverage and boundaries |

## External patterns informing the proposal

The redesign recommendation is my synthesis, not an instruction to copy a competitor's interface.

- [Rive interface overview](https://rive.app/docs/editor/interface-overview/overview): selection-based inspector, central viewport, and timeline surfaced for animation. The useful principle is contextual disclosure and clear panel ownership.
- [Harmony workspace menu](https://docs.toonboom.com/help/harmony-24/essentials/reference/menu/main/windows-menu.html): task-specific workspaces and show/hide controls for views support the proposed layout presets.
- [Blender Grease Pencil Dope Sheet](https://docs.blender.org/manual/en/latest/editors/dope_sheet/modes/grease_pencil.html): manipulating animation keys in a dedicated time editor supports keeping timing operations together.
- [Pivot animation frame controls](https://www.pivotanimator.net/help5-2/animation_frame_controls.htm): Add/Update, frame selection and inbetweens are established user expectations worth preserving and explaining during modernization.
- [W3C target-size guidance](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html): evaluate compact controls and spacing, including the documented exceptions, rather than making every interaction depend on small precise targets.
