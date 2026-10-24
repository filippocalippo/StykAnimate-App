# StykAnimate redesign: implementation architecture and migration plan

This document is the build plan for the redesign, revision 4.3 ("Simple at a glance, powerful underneath": the Islands backbone with every function of today's app kept at most as many clicks away, frequent commands visible in context, and calm through structure). It turns `visual-system.md`, the spec's `tokens.css` and `components.css` (`design/app-ui/`), its `fonts.css` (now `src/styles/base/fonts.css`), `components.md` and `experience.md` into code that ships inside the existing app. The scope is the UI layer only.

**This document is canonical** for the stored layout schema (§3.11.2), the solver's input, tiers and stage insets (§3.11.4), `window.styk.workspace` (§3.11.7), contracts (§4) and the build order (§5). `experience.md` describes the same model in user terms and references these sections. **Revision 4 changes to this plan are listed once in §0.1 and folded into the sections they touch** (§3.11.2, §3.12, §3.13, §3.14, §3.15, §4.6 and the milestones in §5.3); where an older paragraph still describes the revision 3 plan, §0.1 wins.

**Baseline.** This repository, `main` at `cbf1c335` (2026-09-26; re-baselined for revision 3.2 from `f0e069a1`), Electron 39.8.10 (Chromium 142), Playwright 1.63, no CSS build step. **M0 has started:** four M0 commits are on `main` (`521f0e5c` the shell-contract guard and UI snapshots, `1e8a7cec` the layered stylesheet entry, `74a95b94` the CSS lint, `cbf1c335` the bundled fonts); what they did, where they differ from this plan and what is still to do is under M0 (§5.3). Sections that describe those files as future work are read against that status.

**Status in the repository (2026-09-27).** Since that baseline, M0 commit 5 has landed as `876a7e8f` with the follow-ups `f007e2fe`, `df29707b`, `d0154b51`, `de7ba2b7` and `c82312fb`: `src/styles/tokens.css` holds the brand tokens of revision 3 ("Islands"), and revision 4.3's token changes (`design/app-ui/tokens.css`) are still to adopt. The layout engine (`7b0112b1`, `ffb3a331`: `src/shell/panel-registry.mjs`, `layout-schema.mjs`, `layout-solver.mjs` and `layout-store.mjs`) and the overlay kit (`9b084a1c`, `5e115000`: `src/ui/`, styled by `src/styles/components/`) are on `main`. The layout engine is pure and not yet wired into the editor; the kit's menus, messages and hotkey gate are (M2 status, §5.3). Where they settle a detail differently from §3.10–3.11, their module headers are canonical: the stored layout keeps per-panel records (dock, order, size), each arrangement's `weights` per side and the shared sizes in px, and keeps up to 8 unknown panel records, which the solver ignores; the default timeline height follows the window height on every solve and is never stored; `islandMin` (120 px) is a placeholder; the artboard floors hold for the default layout, while a size the person stores (a splitter, Tall timeline, Timing) may go below them and `#viewport` keeps its 360×200 minimum; menus use `popover="manual"` and close themselves. Wiring the rest in still has to supply every name in `CATALOG_REQUIREMENTS` (a missing one shows its commands unavailable), import `en-overlays.mjs` from `src/locales/en.mjs`, and move toolbar overflow's inline `display: none !important` into a `states.css` rule.

**Facts behind this plan.** Every claim here was re-checked against the code on 2026-09-26 (revision 3.2 re-checked the M0 status, the timeline menus in `layer-timeline.mjs`, `sheet-filmstrip.mjs` and `timeline-navigation.mjs`, the registry in `app.mjs` and `hotkeys.mjs`, and the tests that read `layer-*`, `selection-*`, `#builder-branch`, `[data-setting=timelineMode]` and "Fit timeline") (`index.html`, `src/app.mjs`, `src/studio-layout.mjs`, `src/localization-bindings.mjs`, `src/hotkey-hints.mjs`, `src/inspector-dom.mjs`, `src/telemetry-schema.mjs`, `scripts/check.mjs`, `package.json`, `desktop/web-host.cjs`, `desktop/main.cjs`, `cloud/generate-support-assets.mjs`, plus test greps). Test counts in §4 are **files** under `tests/` and `scripts/` that match the hook (grep, 2026-09-26). They are approximate because some tests build selectors dynamically.

**Fixed decisions honoured.** These are not re-litigated here:

- The core is untouched: document model, editor commands, renderer, IK default, file formats and IPC.
- Every `data-action`, `data-shift-action`, `data-tool` and `data-workspace-mode` value is kept.
- Native `<dialog>` for modals, one fixed `#viewport`, WCAG AA contrast, 24 px targets, the 11 px text floor.
- The shell stays LTR. Light is the brand default. UI scale 75–200% down to 500×340.
- Playback is quiet, and the Advanced grid stays canvas-drawn.
- **No default changes** (Advanced timeline, onion off with today's colours, IK off, the first figure selected on load, Build's hidden timeline and VFX tab, blue Camera keys); no set-length command; no key diamonds in the inspector; no selection ring, hover halo or name tags on the canvas.
- **The balanced budget, the first-glance rule, the task rule and the function rule** of `experience.md` §0 are tests: `tests/ui-budget.browser.mjs` (M3b) runs the reference audit's per-region budget and first-glance checks against the app in the rest states; `tests/ui-tasks.browser.mjs` (M3b, extended per milestone) replays `design/app-ui/reference/tools/tasks.json` against the app and fails when a task takes more steps than today or a named target is missing; `scripts/check-function-ledger.mjs` (M3b) fails when a row of `function-ledger.md` is further than today without a documented trade. The budget test It counts controls **inside `#viewport`** too (§3.11.8), counts a one-tab-stop collection (the Library grid, the effect list) once, and together with `shell-layout.browser` checks the band, the page height and the stage floors over the reference's size sweep (`experience.md` §1.9).

---

## 0. Summary

1. **CSS.** There is one entry sheet, `src/styles/app.css`, with a single declared order: `legacy, reset, tokens, base, layout, components, features, states, utilities`.
   - Every current sheet moves unchanged into `src/styles/legacy/` as order-preserving fragments inside the `legacy` layer. Each fragment has one owning milestone that retires it.
   - In the same M0 commit, each of the 11 JS-injected `<style>` blocks wraps its text in `@layer legacy { … }` and the lazy support sheets load into `legacy`, so their cascade against the moved sheets is unchanged. They are then removed feature by feature.
   - A zero-dependency lint, `scripts/check-css.mjs`, runs inside `npm run check`.
2. **Fonts.** Fourteen woff2 subsets of Inter (opsz) and Inter Tight (wght) from `@fontsource-variable` 5.3.0 live in `assets/fonts/`, together with their OFL texts. They load through `unicode-range`, and the two latin files are preloaded. Canvas painters repaint on `document.fonts` `loadingdone`.
3. **UI kit (`src/ui/`).**
   - One `OverlayManager` owns the dialog stack, close guards, the hotkey gate, focus return and the startup prompt queue.
   - Menu, Popover, Tooltip, Toast/Task and Dialog helpers are built on the top layer and CSS anchor positioning.
   - One command registry, keyed by the existing `actions` names and `HOTKEY_COMMANDS`, feeds menus, the palette, the rail and tooltips.
4. **Shell (`src/shell/`).**
   - A pure `layout-schema` + `layout-solver` pair drives a `dock-host`, a `panel-registry` with `onVisibility`, and a merge-on-write `layout-store`.
   - Layouts are stored as schema v2 inside the existing `workspace-preferences.json`, under 16 KiB, with a downgrade-safe v1 mirror.
   - The responsive tiers come from the `#app` content box and are written as two independent attributes: `:root[data-tier]` from the width (horizontal chrome) and `:root[data-height]` from the height (vertical chrome). `fittedView()` reads solver-published stage insets, with no extra padding.
   - `dock-host` is the single owner of panel visibility; feature modules no longer hide each other.
   - It replaces `studio-layout.mjs` and the dead `workspace-layout.mjs`, `workspace-panels.mjs` and `layer-panel.mjs`.
5. **Playback-quiet contract.** The monolithic `updateUI()` becomes per-surface invalidation with compare-before-write. During playback only `#time-display` (5 Hz), the two playheads (transform only) and `#play-button` (on start and stop) are written. This is enforced by `tests/playback-quiet.browser.mjs`.
6. **Hot spots.** These files have a single owner, the **Integrator**, for the whole programme:
   - `index.html`
   - `src/app.mjs`
   - `src/styles/app.css`
   - `src/hotkeys.mjs`, `src/icons.mjs`, `src/telemetry-schema.mjs`
   - `src/locales/en.mjs` and `it.mjs` (composition only)
   - `src/localization-bindings.mjs`
   - `CHANGELOG.md`, `docs/ARCHITECTURE.md`
   - `tests/shell-contract.test.mjs`

   Track agents own disjoint files and hand hot-file changes to the Integrator as patch requests.
7. **Order and parallelism.**
   - M0 foundation (serial).
   - Then M1 shell ∥ M2 overlays kit.
   - Then M3a seams (serial, short).
   - Then M3b top bar/rail/canvas chrome ∥ M4 inspector ∥ M5 timeline ∥ M6 dialogs/settings/export.
   - Then M7 feature tracks a–g in parallel. Audio (7f) waits for M5.
   - Then M8 polish/a11y/responsive/perf plus legacy deletion, then M9 docs and changelog.

```
M0 ─┬─ M1 shell/layout ──────┐
    └─ M2 overlay kit+cmds ──┴─ M3a seams ─┬─ M3b chrome ──────────┐
                                           ├─ M4 inspector ────────┤
                                           ├─ M5 timeline ─────────┼─ M7a..g features (7f after M5) ─ M8 ─ M9
                                           └─ M6 dialogs/export ───┘
```

### 0.1 Revision 4 changes to this plan

**Revision 4.3** (the review of 4.2) changes the plan in eight places, none in the document model, editor commands, file formats or IPC: (1) **the timeline painter** (M5) gets a **row-layout function** for rows of three heights (Camera and Scene 24px, content rows `ROW` 32, content rows 28 at the short height tier) with the hit-test, the label column's virtualisation and the duplicated constants (`vfx-clip-timeline.mjs`, `timeline-organization.mjs`, `camera-motion-timeline.mjs`, `audio-timeline.mjs`) changed together and gated on `benchmark:dense` (this is the "shared row-layout function" of the phase 2 row, §6, brought forward for today's row capacity); it also reserves **the ruler tools' column** (the scroll width ends before it; *Fit timeline* fits into what remains), **draws its own thin scrollbar and the "N more" cue** (a DOM ghost button over the column's foot), keeps the playhead tab and the onion ends inside the ruler, and gives the onion ends a **drag threshold** (a press and release without movement falls through to the ruler's seek; the existing gesture machine's slop); (2) **the shell solver** (M3a) sizes the default timeline from its data (4½, 4 or 3 content slots by height; the vertical insets 24, 10 or 8) and runs the band's revised fold order (the primary's word last; `name8`, `testrig`, `export2`, `switchtight`, `export2out`); (3) **the band** (M3a) keeps a quiet Export in every session (a second `[data-action=export]` inside `.shell-top`, one registry entry); (4) **the camera session** (M6) no longer hides joint handles: the renderer's unselected-handle style (50%) is used for the figures, and a joint drag in the session runs today's pose gesture and then `camera-done`; (5) **the joint menu** (M6) gains *Edit part ▸* (today's Editor-menu commands, the registry entries Build's part menu uses; its first row reads the shared-figure count from the document, and each command's toast carries Undo); (6) **Draw** (M7b) keeps `#open-insert` in its rail with today's Draw meaning (New drawing layer) plus a corner tick that opens the Add menu, and its inspector gets a "New drawing" empty state; (7) **the timeline header** (M5) folds in the new order (the transport's shift first) and hides *Edit together* on a one-frame document and at the minimal tier (a Timeline ⋯ row); (8) **the gates** (M3b): `tests/ui-budget.browser.mjs` adds the header overlap check, the ruler hit check, the paired-toggle check and the honest all-targets count with its frozen per-workspace ceilings; `tests/ui-tasks.browser.mjs` adds T46–T53 and counts a scroll once per size; `scripts/check-function-ledger.mjs` adds the session checks; the screenshot job records the build hash and fails on stale pictures. The easing names are today's (`keyframe-easing.mjs`), so nothing there changes.

**Revision 4.2** (the review of 4.1) changes the plan in five places, none in a core system: (1) the **gates** become clip-aware and per function (`design/app-ui/reference/tools/shoot.mjs`'s `whereIs`: a target must be inside every clipping ancestor and the element at its centre, a scroll costs a step; `ledger.mjs` counts each function by itself and fails any drop in visibility for high- and medium-frequency rows), so `tests/ui-tasks.browser.mjs` and `scripts/check-function-ledger.mjs` (M3b) port those rules, plus the message pass (every message at six widths) and the union glyph check; (2) **stage-chrome** (M3b) solves the message's room from the view cluster's minimum and drops it to its own line when its text does not fit (`data-msg-drop`), with no width cap; (3) the **inspector** (M4) gains the field switch, the stepper field and the bare select in the kit, the VFX panel orders the selected effect's parameters before Timing, and the figure's Arrange gets the Z-index stepper; (4) the **joint context menu** (M6) starts with today's joint right-click list and gets its own Figure ▸ submenu; (5) **Build** (M7) keeps the outliner footer as Structure's foot (*Fit figure*, *Timeline*) and names the figure in Structure's head with its scope line. The band's fold order changes in the solver's data (the workspace switch folds last). Nothing changes in the document model, editor commands, renderer, file formats or IPC; `Pin joint` reads the pin IK already makes.


Revision 3 reached calm by moving 258 of today's functions behind menus (194 of them further than today, in the revision 3 gap analysis, internal research, not in the repository). Revision 4 brings every one back to at most today's clicks and keeps the first glance calm through structure. For the plan this means **less test churn and less re-homing** (many revision 3 moves are cancelled: `#loop-button`, `#onion-settings-button`, `#timeline-audio`, `#timeline-zoom`, `#expand-timeline`, `#fps`, Save and the menubar stay where tests and people find them today), plus five new pieces of UI.

| Area | Revision 3 plan | Revision 4 plan | Milestone and owner |
|---|---|---|---|
| Band | Menubar behind the mark; Save in the Document popover; movieclip Cancel in a menu | **The menubar docked** (`ui-menu.mjs`'s MenuBar, M2) at every width down to the minimal tier (revision 4.1: the band folds its labels and spacing first), folding into the mark only there; **Save** beside Export (`.titlebar [data-action=save]` stays visible); **Cancel** beside Done in a movieclip session | M3b, I (`index.html`, `topbar.mjs`) + track C (`menubar.css`) |
| Stage | The zoom corner and the message slot in the stage's bottom inset | **The stage header** (`.stage-head`, 40px, a sibling of `#viewport` above it): the location crumb or **the tool options bar** (start), the one message (centre), **the view cluster** (today's view pill: `#handles-button`, `#paths-button` + `.path-options-button`, `#canvas-guides-button`, `#vfx-preview`; Build: Static handles, Highlight part, the Timeline toggle), `#zoom-label` and Fit (end). `.ui-corner` is not built | M3b: I (`stage-head.mjs`, slots, re-parenting with ids) + track C (`tool-options.mjs`, `stage-head.css`, `optbar.css`, `crumb.css`, `split.css`) |
| Tool options | Tweener options in an inspector context; the Draw quick bar's controls in the Draw inspector; Build's modes in More › Editing | Each tool declares **option descriptors** (`{ id, kind, label, fold }`) rendered by `tool-options.mjs` into the stage header: the Tweener's mode and Amount; Draw's colour pair, recent colours, sizes, variants and the pixel selection's commands (the quick bar's controls move here, out of `#viewport`); Build's `#rig-mode` (a select, as today), `#builder-branch` (a toggle button, `aria-pressed`) and `#builder-snap`; chain and polygon Finish/Cancel | M3b framework (track C); content in M7g (Tweener), M7b (Draw), M7a (Build) |
| Inspector | A name, ≤ 3 sections and one "More" | **Quick actions** (≤ 5 defaults and a pin slot, registry entries with `quick: { context, group }`), **core sections** (open), **titled sections** (collapsible, remembered, auto-open rules), **at most two title actions** per section, **the scope line** while Edit together is on, the figure inspector's footer (*Add to library*), the several-figures Align row and actions, the 3D rig inspector specified in full | M4, track D (`inspector-kit.mjs`, `quick.css`, `section.css`, `scope.css`); pins in the layout store (M1, §3.11.2) |
| Timeline | A 9-control header; everything else in *Timeline ⋯*; no Simple sidebar | **Three header clusters, 14 controls** (First frame, Loop, `#fps` as an inline field, Onion as a split button, Audio with a has-audio dot, all as buttons, as today); **the layer list's header** (Focus selected layers, New layer as a split button with rename on create, Find layers); **the ruler's tools** (`#timeline-zoom`, Fit timeline, `#expand-timeline`); **the Simple frame bar** (Inbetweens, Easing, Copy, Paste, Delete, Edit together, `#layers-button`); in Draw the *Next copy ▾* split; eye and lock at rest on every row; the exposure's end handle, live timing while dragging keys, grips on hover, cel thumbnails (gated); double-click meanings kept | M5, track E |
| Export | One Format control and More options | Format and a **visible Type select** (`#output-format`), Size presets 1080p, 720p, 4K, Original, Custom, **From and To fields** beside the trim strip, the type's own settings shown (not folded) | M6, track F |
| Draw, Library, VFX, Camera | The quick bar retired into the inspector; the library tab without sources; a VFX empty state with one button | Draw's tool options bar and the Brush section's visible presets; the Library's **sources** (This project, Mine, Examples), Kind filter, folder path with New folder, Show in folder and Refresh; VFX's **suggested tiles** and *Paste effect* beside *Add effect*; the camera's quick actions and **Motion ▾** | M7b, M7c, M7d, M7e |
| Messages | Error, recovery, update, toast, first-run hint | Adds the **mode** variant (a pick mode's instruction: Join, Connect joints, sprite placement, Chain, Polygon) and the **quiet** variant ("Slow · 14 of 24 fps · Details", throttled to 1 Hz) | M2 (`ui-toast.mjs` variants), M3b (placement in the header), M7 tracks (their modes) |
| Registry | One home per command; menus are indexes | Adds **rule 10, a visible home plus menu aliases** (`experience.md` §8): a registry entry may have one visible home (`home: 'quick' | 'option' | 'header' | 'section-action'`) and be listed by the context menus of the same selection; the homes check (`homes.mjs`) treats those as aliases, not second homes | M2, I (`command-registry.mjs`, `command-catalog.mjs`) |
| Gates | `ui-budget` (a hard budget of ≤ 40) | `ui-budget` with the **balanced budget and first-glance rule** (`experience.md` §0.1–0.2), **`ui-tasks`** (the 53 tasks of `design/app-ui/reference/tools/tasks.json`, no task longer than today), **`check-function-ledger`** (852 rows, none further than today without a documented trade) | M3b onward (I + track C); every milestone's exit |

**Ownership changes.** New files: `src/shell/stage-head.mjs` (I; the slots, the message placement and its collision rule), `src/ui/tool-options.mjs` (track C; renders option descriptors, folds them in order into "More options", one tab stop with arrow keys), `src/ui/quick-actions.mjs` (track D; renders a context's quick actions from the registry, applies pins), `src/styles/components/{menubar,stage-head,optbar,split,crumb,quick,scope}.css` (C and D as listed). `corner.css` and `more.css` are not created. `src/drawing-controller.mjs`'s quick bar moves into Draw's option descriptors (M7b), not into the inspector. `#chain-controls` and `#polygon-controls` move into Build's tool options (M7a), not into an inspector section.

**Tests that no longer change.** Revision 3 had to update the tests that click `#loop-button`, `#onion-settings-button`, `#timeline-audio`, `#expand-timeline` and `#timeline-zoom` as buttons, the tests that click Save in the band, and the ones that read `#fps` in the timeline; revision 4 keeps those elements as buttons and fields in the timeline header or the ruler's end, so those tests keep their selectors (`tests/shell-contract.test.mjs` updates the parent of `#timeline-zoom` from `.timeline-actions` to the ruler's tools). `tests/rig.browser.mjs` keeps `#rig-mode` as a native select.

### 0.2 Revision 4.1 changes to this plan

Revision 4's "nothing further than today" held only at 1440×900. Revision 4.1 makes it hold at the sizes people use (1280×720, 1440×900 at 125% and 150% UI scale, 1100, 1024 and 900 px wide), restores the entry points and words the review found missing, and adds the gates that check them. None of it touches the document model, the renderer or IPC.

| Area | Revision 4 | Revision 4.1 | Milestone and owner |
|---|---|---|---|
| Solver | compact ≤ 900 (the inspector a sheet, the view toggles and Simple │ Advanced folded, the switch a pill); the menubar folded ≤ 1180; the frame rate folded ≤ 1180; floor 50% from 800×600; Structure strip under a 400 px stage | **compact ≤ 800**; the menubar folds only at minimal, after the band's fold order (`data-band`); the frame rate folds at compact (as today's app hides it at 800); the view toggles, the switch's three segments and Simple │ Advanced stay at every tier; the 800×600 floor row is dropped (45% from 600×441 up to 1023 px); Structure narrows to 200 px and folds only under the 360 px `#viewport` floor (§3.11.4) | M1, I (`layout-solver.mjs`: `WIDTH_TIERS` thresholds, `STAGE_FLOORS`, the band fold steps as `bandMin` input; the tier table in `layout-solver.test.mjs`) |
| Tool options | Fold into *More options* by declared order | Descriptors may declare a **twin** (the option shows in its tool's inspector section while folded: Draw's Mirror pair; the recent colours always live in the tool's section, as today's inspector swatches) or a **home** (it folds away to where it already lives: Pen pressure → Brush details › Dynamics); only options today's quick bar clips at that width fold into *More options*. Build's Highlight part and Static handles declare an end-cluster fold into *View › Build* | M3b framework (track C), M7b, M7a |
| Inspector | ≤ 6 quick actions, icon-only; one title action | ≤ 5 defaults and a pin slot; **words where glyphs are hard to tell apart** (Front, Back, Split, Duplicate, Remove keys; the joint's Match pair behind a quiet "Match" label, with pose glyphs); Join to figure is Arrange's title action; at most two title actions; the joint shows its figure's Layer; the camera's *Ease new keys* opt-in; Build's part is titled by its Structure label ("Line 4") | M4, track D; M7a, M7e |
| Draw | Cel commands as the drawing layer's quick actions; Mirror split between the header and the inspector | The cel commands move to **Draw's timeline header** (a labelled *Next copy* split, where today's *Next copied drawing* button is; its chevron: Next blank drawing, Blank drawing here, Copy drawing here, Extend); **Mirror** is one labelled pair of toggles; today's 14 brushes and saved ones in a five-column grid; Blend selects carry inline labels; Tip, Stroke, Texture and Dynamics are one titled *Brush details*; in Draw the layer list's + makes a drawing layer | M7b, M5 (the header slot) |
| VFX | Apply to and Show in the header's ⋯; 6 suggestions; Presets as a catalogue heading | **Apply to** is a labelled select under the name; **Show** is a labelled row whenever the filter hides effects; **Presets** is a visible button and the catalogue's Effects │ Presets switch; the catalogue lists today's 22 effects in their six categories and 13 looks; **12 suggestions** (today's chips) | M7d |
| Timeline | Eye and lock on hover; readout "Frame 28 / 48"; Focus as a layer quick action; "6 +5" | **Eye and lock at rest** on every row; the readout keeps today's **MM:SS:FF** (Go to frame's Show switch offers frames); **Focus** in the layer list's header (today's one-click toggle); the card caption "6 · 5 inbetweens"; the has-audio dot follows the document | M5, track E |
| Band, rail, stage | Test rig at the rail's end; Grid a single popover button; no corner ticks | **Test rig** beside Done in Build's band; **Grid** a split button (toggle + settings); the crumb's **background chip**; a corner tick on tools with variants (the Tweener, Select pixels, Shapes) | M3b (I, C), M7a |
| Export | Size started on 1080p | Size starts on **Original** (today's default) and is remembered | M6, track F |
| Glyphs | One glyph per concept by symbol name | By **SVG content** (the app set's byte-identical pairs are split: `exact` for Exact values, `rotate-step` for Rotate 15°, `step-up`/`step-down` for the order steps, `match-prev`/`match-next`, `cel-next`, `join-figure`, `focus-layers`, the workspaces' glyphs); `ui-budget` fails a rest state where one symbol stands for two command families | M2 (`icons.mjs` additions, track C), M3b gate |
| Gates | `ui-budget` at 1440×900; `ui-tasks` and the ledger at 1440×900 | `ui-budget` with headroom and reserved slots, the default inspector's fold rule, value clipping, first-launch marks; **`ui-tasks` and `check-function-ledger` again at the tier sizes** (the ledger compares with `today-tiers.json`, measured in today's app); the ledger's visibility classes (yes, hover, ctx, no) and its check that every visible home names a drawn control | M3b onward (I + track C) |

---

## 1. Ground rules for every implementer

1. **Contracts are an API** (§4). Markup, element types and class names may change freely, but these may not:
   - listed ids, `data-*` values and accessible names
   - `window.styk` members
   - `/src/*.mjs` exports used by tests

   An id may disappear only in the same commit that changes its last reader, and only where §4 marks it as reader-bound.
2. **Fix the owning layer.** The kit owns chrome. Feature modules own content. The editor owns data. No UI module stores document state, and derived readouts (the target, the numbering) are computed, never stored (`uiContext`, §3.12).
3. **`#viewport` rules.**
   - `#viewport` is the stage island's content box and is never re-parented or cloned.
   - `#scene` is replaced by id on GPU recovery, so it is never cached.
   - No ancestor of `#viewport` gets a `transform`, `zoom`, `filter`, `will-change: transform`, `clip-path` or `border-radius` clip.
   - Regions next to it never animate their size. Docking, folding and splitter changes commit instantly, coalesced to one per frame.
4. **Panels, strips, sheets and drawers are never `<dialog open>`.** Any open dialog suspends all editor hotkeys. They are plain elements or `popover`.
5. **Top-layer rule.** A menu, popover or picker opened from inside an open modal is mounted **inside that `<dialog>`** (otherwise it is inert: the colour-picker rule, `color-picker.mjs:32`). One opened from inside an open popover or sheet is mounted inside it or shown with `showPopover({ source: invoker })`, so popover ancestry keeps the host open. This applies to the kit and, the first time a host becomes a sheet or popover, to every existing nested overlay: the colour picker, the VFX catalogue (`vfx-inspector.mjs openPopup`), the library context menu (`user-library.mjs:39`), `#path-popover` and `#canvas-guides-panel`. Every overlay root sets `-webkit-app-region: no-drag`.
6. **Working agreement.**
   - Work on `main` in the shared checkout. Other sessions commit there too.
   - `git diff -U0` every file before staging, and stage only your own hunks.
   - Never remove another process's `index.lock`.
   - Local commits only. Never push, tag or publish.
   - Each commit is coherent, passes `npm run check` and `npm test`, and includes its tests and docs.
   - **Release freeze.** Between M0 and M9 the UI on `main` is a mix of legacy and new surfaces. M0 commit 1 adds the marker `artifacts/ui-redesign/IN_PROGRESS` and a check in `scripts/release-prepare` (the `release:prepare` script) that refuses to run while the marker exists; M9 removes it. M0 commits 1–4 landed before the freeze was confirmed; the marker and its check now land before M0 commit 5 (the first change of colours), and the owner confirms the freeze before that commit (§6). User-facing changelog entries are drafted in `docs/design/CHANGELOG-DRAFT.md` and move into `CHANGELOG.md` `Unreleased` only in M9.
7. **Dev servers.** Each track runs its own server:
   - start: `node scripts/serve.mjs --port <port>` (background)
   - run tests with: `STYK_URL=http://127.0.0.1:<port> node tests/<name>.browser.mjs`

   | Milestone | Port |
   |---|---|
   | M0 | 47910 |
   | M1 | 47911 |
   | M2 | 47912 |
   | M3 | 47913 |
   | M4 | 47914 |
   | M5 | 47915 |
   | M6 | 47916 |
   | M7a–g | 47917–47923 |
   | M8 | 47924 |

   Avoid 47831, 47832, 47843, 47851 and 47880, which other sessions use.
8. **Other runners.** For Electron smoke tests, run `env -u ELECTRON_RUN_AS_NODE npm run test:<x>:desktop`. In PowerShell, use `npm.cmd` if `npm` reports a missing `npm-cli.js`.
9. **Known baseline failures** are not regressions:
   - `timeline-usability.browser`
   - `theme.browser`
   - `audio-ux.browser`
   - `vfx-expansion` and `vfx-strength` (run with `--render-only`)
   - the load-sensitive `backend-session` unit test (rerun it alone; removed with the Python codec service in the Rust engine port)

   M0.1 records the full baseline in `artifacts/ui-redesign/baseline.json` before anything changes.

---

## 2. CSS architecture

### 2.1 Cascade layers and migration semantics

`src/styles/app.css` is the only stylesheet linked from `index.html`:

```css
@layer legacy, reset, tokens, base, layout, components, features, states, utilities;

@import url("./legacy/00-drawing.css") layer(legacy);   /* …every legacy fragment, in today's order (§2.9)… */
@import url("./legacy/99-settings.css") layer(legacy);  /* was loaded last at runtime; stays last */

@import url("./base/reset.css");        /* each new file wraps itself in exactly one @layer block */
@import url("./tokens.css");
@import url("./legacy-bridge.css");     /* @layer tokens: old token names → semantic tokens (deleted in M8) */
@import url("./base/fonts.css");
@import url("./base/document.css");
@import url("./base/elements.css");
@import url("./base/a11y.css");
@import url("./layout/shell.css");      /* …every layout/components/features file, pre-listed in M0 (§2.2)… */
@import url("./states.css");
@import url("./utilities.css");
```

What this means for the migration:

| Case | Behaviour | Consequence |
|---|---|---|
| Normal declarations | `legacy` is declared first, so **every new layer beats legacy**, regardless of specificity | A ported surface wins without `#inspector …` weight wars. A legacy fragment that is still present is harmless for normal declarations. |
| `!important` declarations | Layer order inverts, so **legacy `!important` beats every new layer** | Porting a surface must delete the legacy `!important` rules that touch it. M0 generates the inventory with a grep over every legacy fragment into `scripts/check-css-baseline.json` (`legacyImportant`: file, line, selector). Known at planning time: `camera-motion.css` (10), `layer-timeline.css:43,77,99,167,178`, `studio.css:157-158, 216, 242` (the last two are a global reduced-motion `transition-duration: 0s` on `*`), `style.css:78, 691, 1772, 1774, 2062`, `audio.css:1`, `user-library.css:4, 24, 35, 66`, `vfx.css:2, 18, 45, 134, 301`, `drawing.css:51`, `tweener.css:16`, `update-ui.css:2`. `check-css.mjs --ported <root>` fails when a ported root's classes are still matched by a surviving inventory entry. |
| Unlayered CSS | The 11 injected `<style>` blocks would beat every layer | **M0 wraps each live injector's text in `@layer legacy { … }`** (one line per injector). They are appended after `app.css`, so inside `legacy` they keep today's relative order and still beat the moved sheets exactly as they do now: the move is pixel-neutral. Each porting milestone then moves its injector's CSS out of `legacy` into a layered file (§2.6). The JS01 ratchet counts them until they are gone. |
| Element-level base rules (`:where(button){font:inherit}` …) | They would beat legacy `.button` rules everywhere | Until M8, `base/elements.css` is scoped to ported roots: `:where([data-ui]) :where(button, input, select, textarea, h1, h2, h3, p) {…}`. Every ported region root carries `data-ui`. M8 drops the qualifier when the legacy layer is deleted. |
| Token names | The `tokens` layer beats legacy `:root { --theme-* }` | `legacy-bridge.css` re-points old names at semantic tokens, so unported UI adopts the brand palette in M0 (§2.4). |
| Canvas-read tokens | A declaration on an element beats inheritance from `:root`, whatever the layer | `.layer-timeline { --sheet-* }` (legacy) keeps winning until M5 deletes it. The audio tokens are deleted in M7f. |

Any unscoped rule in a new layer beats **every** legacy rule for normal declarations, so M0 keeps the unscoped set minimal. Only these apply unscoped from M0 (`base/document.css`):

- `html` font family, font features, smoothing and `color-scheme`
- `::selection`
- the pending-theme mask
- the `.ui-*` helpers (`.ui-icon`, `.ui-tnum`, `.ui-truncate`, `.ui-visually-hidden`), which match nothing legacy

Everything else in the spec's base block waits behind `:where([data-ui])` until M8: `scrollbar-width` and scrollbar colours (unscoped they would override `.draw-quick-row { scrollbar-width: none }` and the `auto` scrollbars of `.sheet-scroll` and `.sheet-filmstrip-scroll`, changing their `clientWidth` and the JS-written `--sheet-scrollbar-*`), the brand `:focus-visible` ring and the `:focus:not(:focus-visible)` reset. The spec gallery's `components.css` base block is unscoped because the gallery has no legacy; the app's M0 copy scopes it. Lint CSS18 enforces this while `legacy` exists. The full `font: var(--type-ui)` shorthand on `html` waits until M8.

### 2.2 File tree and owners

```
index.html                         <link rel=stylesheet href=./src/styles/app.css> + 2 font preloads (M0)
assets/fonts/                      14 × .woff2, OFL-Inter.txt, OFL-InterTight.txt (M0)
src/styles/
  app.css                          layer order + every @import, pre-listed in M0; Integrator-only afterwards
  tokens.css                       spec tokens.css verbatim (design/app-ui/tokens.css) (tiers 1–2, scale, canvas-read, reduced-motion, forced-colors)
  legacy-bridge.css                @layer tokens: --theme-*, --ds-*, legacy aliases → semantic (M0; deleted M8)
  support-bridge.css               @import "../support-center.css" and "../support-desktop.css", layer(legacy) in M0, layer(features) in M6; lazy
  base/reset.css                   [hidden]{display:none!important}; box-sizing (M0)
  base/fonts.css                   @font-face ×14 (M0)
  base/document.css                html font and features, ::selection, pending mask, .ui-* helpers unscoped (M0); focus ring and scrollbars under :where([data-ui]) until M8
  base/elements.css                element resets, [data-ui]-scoped until M8
  base/a11y.css                    reduced motion, forced colors, (hover:none) globals (M0; M8)
  layout/shell.css                 #app grid, top band, data-tier rules, drag regions (M1, M3b)
  layout/workspace.css             region grid, strips, floating host (M1)
  layout/dock.css                  islands in docks, splitters, drop overlay (M1)
  layout/topbar.css                (M3b)
  layout/rail.css                  (M3b)
  layout/stage.css                 stage island, the stage header row, #viewport box, corner caps (M3b)
  components/<block>.css           one file per .ui-* block, split from spec components.css (design/app-ui/components.css) in M0 (owners in §5.4)
  features/<feature>.css           inspector, timeline, filmstrip, audio, vfx, library, builder, rig, drawing, camera,
                                   onion, guides, motion-path, tweener, color-picker, export, settings, dialogs, splash,
                                   privacy, update, text-dialog, segment-values, sprite-placement, inbetween,
                                   background-dialog, movieclip, palette-content, support-desktop (stubs in M0)
  states.css                       body.is-panning *, scrubbing, eyedropper, drag cursors (!important allowed)
  utilities.css                    .u-visually-hidden, .u-truncate … (!important allowed)
  legacy/NN-*.css                  today's CSS split into order-preserving fragments (§2.9); emptied by owners, deleted in M8
src/support-center.css             UNCHANGED and not moved (copied byte-for-byte to the website by cloud/generate-support-assets.mjs)
src/support-desktop.css            stays in place until M6 replaces it with features/support-desktop.css
```

Rules for the tree:

- M0 creates every file in this list, with an empty `@layer x {}` stub where the owner has not started, and lists them all in `app.css`. **No track ever edits `app.css`.**
- Every file except `app.css`, `support-bridge.css` and `legacy/**` contains exactly one top-level `@layer` block whose name matches its folder (lint CSS01).
- **Startup gate.** About 85 small `@import`s are fetched over loopback. M0 measures time-to-`styk.ready` and first paint, before and after, in the browser and in Electron (`npm run test:desktop` timing). If the cost exceeds **+25 ms**, the component files are concatenated per owning milestone (still one owner per file) rather than adding a build step.

### 2.3 How features are organised

- **Class API** (from `components.md` §0):
  - Blocks are `.ui-<name>`, parts are `.ui-<name>-<part>`, and variants use `[data-variant|size|tint|tone]`.
  - Features keep their prefixes (`sheet-`, `audio-`, `vfx-`, `library-`, `builder-`, `draw-`, `export-`, `settings-`) and **compose `.ui-*` blocks** instead of re-implementing them. Examples: the 14 segmented controls become `.ui-segmented`, the 8 switches `.ui-switch`, the 9 searches `.ui-field[data-shape=pill]`, and the 8 menus `.ui-menu`.
- **Hook classes are never styled.** These classes stay as JS and test hooks only: `.workspace`, `.titlebar`, `.center`, `.studio-rail`, `.tool-dock`, `.timeline-panel`, `.timeline-toolbar`, `.right-panel`, `.layer-timeline`, `.sheet-filmstrip`, `.sheet-scroll`, `.menu-item`, `.icon`, `.brand`. The visual class sits beside the hook class (`class="tool-dock ui-rail"`).
- **State order.** Use native or ARIA state first (`:disabled`, `[aria-pressed]`, `[aria-selected]`, `[aria-expanded]`, `[aria-current]`, `:popover-open`, `[open]`), then `data-*` enums, then `is-*` for transient flags. Bare `.active` and `.selected` are retired as their writers are ported. Never style `[data-action]`, `[aria-label]` or `[title]`.
- **Specificity.**
  - base uses `:where()` only
  - components ≤ (0,2,0), layout ≤ (0,2,0), features ≤ (0,3,0)
  - no IDs (`:where(#x)` only when unavoidable)
- **Responsive rules.**
  - Shell tiers come **only** from `:root[data-tier="wide|regular|narrow|compact|minimal"]` (width), `:root[data-height="tall|short|low"]` (height) and `:root[data-left="docked|strip"]` (Build's Structure), which the solver writes. A rule keyed on the width tier never changes vertical chrome and a rule keyed on the height tier never changes horizontal chrome (lint CSS19 flags a `data-height` rule that folds or resizes a dock or the band, and a `data-tier` rule that sets the timeline's block size or a block inset). CSS never uses viewport `@media (width…)` except inside `layout/shell.css` for pre-JS first paint.
  - Island internals use named container queries (`island-head`, `toolbar`, `fieldgrid`, `timeline`, `inspector`, `dialog`).
  - Label priority is `data-label-priority="1|2|3"` (`components.md` Toolbar).
- **Stacking.** Anything floating is in the top layer. The only z-index values are `--z-sticky` 5, `--z-canvas-overlay` 10, `--z-canvas-hud` 20 and `--z-floating` 30, plus literal 0–3 for local stacking.
- **Motion.** Animate transform, opacity and colour only. There is no `backdrop-filter` anywhere. `prefers-reduced-motion` is honoured in `src/styles/tokens.css` and by JS through `matchMedia` (library hover preview, view animations).
- **Input modes.** Every hover-revealed control has an `@media (hover: none)` rule. `forced-colors` gets real borders and Highlight outlines from `src/styles/tokens.css` and `base/a11y.css`.
- **Data-driven values** go through CSSOM (`el.style.setProperty('--x', v)`). In HTML templates the only inline style allowed is custom properties (`style="--swatch:#aabbcc"`). The CSP is unchanged.

### 2.4 Token tiers

| Tier | File | Contents | Readers |
|---|---|---|---|
| 1. Primitives | `src/styles/tokens.css` `:root` | Brand ramps: mist, slate, ink, blue, violet, mint, orange, gold, rose, red, lime, teal. **Raw hex lives only here.** | `src/styles/tokens.css` tier 2 only |
| 2. Semantic | `src/styles/tokens.css` `:root`, `:root[data-theme=light]`, `:root[data-theme=dark]` | Surface, text, line, accent (4 blues), selection, focus, primary, controls, status, concept tints (select, time, library, draw, fx, camera, export), inverse | Components and features |
| Scale | `src/styles/tokens.css` | Type (`--type-*`, 11 px floor), space, radius, control heights, icons, elevation, motion, z, layout (`--topbar-h` 44, `--rail-w` 48, `--inspector-w` 288, `--gutter`, `--island-pad`, `--stage-head-h`, `--stage-inset-*`, `--cluster-gap`, `--quick-gap`) | Everything |
| JS-mirrored geometry | `src/styles/tokens.css` | `--timeline-row` 32 (`layer-timeline.mjs` ROW), `--timeline-header` 32, `--audio-row` 64, `--audio-ruler` 22, `--audio-toolbar` 36 (all unchanged in this programme), `--outliner-row` 30 (`builder-outliner.mjs` ROW_HEIGHT; Structure rows stay 30 with a 16px indent per level), `--asset-row` 74 (`asset-library.mjs` ROW_HEIGHT, the hidden `#insert-dialog` list; retired in M7c with that virtualiser) | CSS and the named JS constant, which must change together |
| Canvas-read | `src/styles/tokens.css` | `--sheet-*` (the 13 existing plus the new ones, including the thin-mark line tokens `--sheet-camera-line`, `-scene-line`, `-fx-line`, `-draw-line`), `--audio-ink/-fill`, `--layer-*`, `--canvas-*`. Each is a `var()` chain ending in a hex or rgba literal. No `light-dark()` or `color-mix()`. Under `forced-colors: active` they map to system colours (tokens.css), which `canvasChromeTheme` resolves to `rgb()` through a probe element. | `layer-timeline.mjs:119`, `audio-timeline.mjs:209`, `canvas-chrome-theme.mjs` |
| 3. Component | inside each block | Private `--_x` tokens only | That component |

**`legacy-bridge.css`** (M0, `@layer tokens`) maps old names so unported UI turns brand-coloured at once. It follows `visual-system.md` §14 (migration notes), with the corrections below. They exist because legacy code uses these tokens for text as well as fills.

| Old | Bridge value | Why |
|---|---|---|
| `--theme-panel`, `--panel` | `--surface` | |
| `--theme-workspace` | `--surface-field` | |
| `--theme-field`, `--input` | `--surface-sunken` | |
| `--theme-subtle` | `--surface-sunken` | |
| `--theme-hover` | `--surface-hover` | |
| `--theme-border`, `--border` | `--line-2` | |
| `--theme-border-strong` | `--line-3` | |
| `--theme-text`, `--text` | `--text-1` | |
| `--theme-secondary` | `--text-2` | |
| `--theme-muted`, `--muted` | `--text-3` | |
| `--theme-accent` | **`--accent-text`** (not `--accent`) | Legacy uses it for small text and active icons. `#0d99ff` would be 2.99:1. |
| `--theme-action`, `--purple` | `--primary` | Primary fills become ink. White labels stay above 4.5:1. |
| `--theme-action-hover` | `--primary-hover` | |
| `--theme-selected`, `--purple-soft` | `--surface-selected` | |
| `--theme-selected-hover` | `--surface-selected-hover` | |
| `--theme-danger`, `-bg`, `-action` | `--danger-text`, `--danger-soft`, `--danger-strong` | |
| `--theme-warning`, `-bg` | `--warning-text`, `--warning-soft` | |
| `--theme-success`, `-bg` | `--success-text`, `--success-soft` | |
| `--theme-violet`, `-bg` | `--tint-time-ink`, `--tint-time-soft` | |
| `--theme-overlay` | `--surface-raised` | |
| `--theme-backdrop` | `--surface-backdrop` | |
| `--theme-shadow` | `--line-2` | Legacy uses it as a ring colour. Shadows come from `--elevation-*` once a surface is ported. |
| Undefined `--theme-selection`, `--theme-canvas`, `--accent` (legacy use), `--field`, `--input-bg`, `--font` | `--surface-selected`, `--artboard-placeholder`, `--accent-text`, `--surface-sunken`, `--surface-sunken`, `--font-ui` | Fixes the dark-mode leaks in `css-architecture.md` §4.5 (internal research, not in the repository). The bridge defines them on `:root`, so they apply to unlayered injected CSS too. |
| `--ds-*` scale | Nearest scale token (`--ds-text` → `--text-12` …) | |

The legacy UI must pass the contrast walk after M0.5 (`tests/ui-audit.browser.mjs --scope app`). Legacy literals (`var(--x, #fallback)` never renders) and the hard-coded colours of unported injected CSS are fixed by their owners, never in the bridge.

**JS-written custom properties** are an allowlist inside `scripts/check-css.mjs`. Each entry names its writer, and the lint checks that the writer still writes it.

| Property | Writer |
|---|---|
| `--sheet-label`, `--sheet-scrollbar-x`, `--sheet-scrollbar-y`, `--layer-color` | `layer-timeline.mjs` |
| `--audio-label`, `--audio-toolbar-top`, `--audio-toolbar-bottom` | `audio-timeline.mjs` |
| `--filmstrip-card` | `sheet-filmstrip.mjs` |
| `--onion-progress`, `--onion-before`, `--onion-after` | `onion-controls.mjs`, `onion-timeline-range.mjs` |
| `--tween-color` | `tweener-controls.mjs` |
| `--vfx-progress`, `--paint` | `vfx-inspector.mjs` |
| `--library-matte`, `--library-progress` | `user-library.mjs`, `library-hover-preview.mjs`, `library-drag.mjs` |
| `--styk-ratio` | `insert-inbetween-dialog.mjs` |
| `--size`, `--node-outline`, `--node-color` | `settings.mjs` |
| `--swatch`, `--_p`, `--hold-w`, `--level`, `--start`, `--end`, `--dot` | kit components (M2–M5) |
| `--shell-left`, `--shell-right`, `--shell-bottom`, `--shell-rail`, `--stage-inset-*` | `dock-host.mjs` |

`--studio-inspector`, `--studio-timeline` and `--builder-outliner-w` are removed in M1 together with their writers.

**Pre-paint colours** change together in M0.5 (4 places plus 1 test):

| Place | Change |
|---|---|
| `desktop/main.cjs:584` `backgroundColor` | `'#191a1d'` → `'#0a0b0f'` (still dark before settings load, as today) |
| `src/theme-bootstrap.js:13,23` meta | `#202227`/`#f8f8fa` → `#0a0b0f`/`#f5f6f9` |
| `src/theme.mjs:22` | Same values |
| The pending mask (`theme.css:6-7`) | Moves to `base/document.css` |
| `tests/theme.test.mjs:44,59` | Updated to the new values |

`theme-bootstrap.js` also sets `html[data-platform=darwin|win32|linux|web]` from `stykDesktop.platform`. This replaces the inline `padding-left: 84px` at `app.mjs:5936` with `:root[data-platform=darwin] .topbar { padding-inline-start: 84px }`.

### 2.5 Tokens read by canvas painters

- `src/ui/canvas-chrome-theme.mjs` (M3b) is the single resolver. It reads `--canvas-*`, `--sheet-*`, `--audio-*`, `--layer-*`, `--font-ui` and `--font-display` once per `styk-theme-change`, once per `document.fonts` `loadingdone` and once per `matchMedia('(forced-colors: active)')` change, resolving each value through a probe element so system colours become `rgb()` strings, then emits `styk-canvas-theme`.
- These painters move to it in their milestones and stop hard-coding colours and font stacks:
  - app overlay pass: marquee, pivot, polygon draft, sprite placement (M3b)
  - `camera-overlay`, `camera-monitor` (M7e)
  - `spatial-gizmo` (M7g)
  - `vfx-gizmos` (M7d)
  - `rig-controls` guides, `builder-construction`, `builder-duplicate-preview` (M7a)
  - `drawing-controller` cursor and transform box (M7b)
  - the timeline, audio, camera-motion and VFX lanes (M5 and M7f)
- Canvas text is `600 11px var(--font-ui)`. English strings drawn on canvases go through the localization catalog.
- Joint handle colours stay renderer-owned. `HandleRenderer` and `PIVOT_HANDLE_COLORS` are not touched.

### 2.6 Removing the JS-injected and runtime-loaded CSS

**M0 first makes every live injector layered:** its CSS text becomes `@layer legacy { … }` (for example `property-controls.mjs:65`, whose `.property-row:not(.is-animatable) .field { padding-inline: 6px }` and `.field > .property-scrub { font-size: 10px }` lose to `studio.css:278-282` today and must keep losing; unlayered after the move they would win). Porting milestones then move the CSS to its destination:

| Module (live injector) | Destination | Milestone |
|---|---|---|
| `property-controls.mjs:65` (`data-styk-property-styles`, ref-counted) | `components/field.css` + `features/inspector.css`. The ref-count code is deleted (one document). | M4 |
| `movieclip-ui.mjs:36` | `features/movieclip.css` | M4 |
| `keyframe-easing-popover.mjs:45` (`data-styk-easing-style`) | `components/ease.css` + `ui-popover` | M5 |
| `insert-inbetween-dialog.mjs:30` | `features/inbetween.css` | M6 |
| `text-dialog.mjs:71` | `features/text-dialog.css` | M6 |
| `background-dialog.mjs:29` | `features/background-dialog.css` | M6 |
| `segment-values-dialog.mjs:63` | `features/segment-values.css` | M6 |
| `sprite-placement-dialog.mjs:47` (includes `#viewport.sprite-placement #overlay`) | `features/sprite-placement.css` (the cursor rule goes to `states.css`) | M6 |
| `vfw-export-controls.mjs:21` | `features/export.css` | M6 |
| `privacy-ui.mjs:18` (51 hex values, `z-index` 10000, blur; includes the fixed `.styk-trace-status` banner) | `features/privacy.css` (no blur); the trace banner becomes a message | M6 |
| `builder-outliner.mjs:65` | `features/builder.css` | M7a |
| Dead: `layer-panel.mjs:63`, `workspace-layout.mjs:179`, `workspace-panels.mjs:106` | Deleted with the modules | M1 |

| Runtime `<link>` | Change |
|---|---|
| `settings.mjs:186-190` (`settings.css`) | **M0:** the link is removed. `settings.css` becomes `legacy/99-settings.css`, imported last in the legacy layer (same relative order as today). **M6:** `features/settings.css`. |
| `support-desktop-ui.mjs:17-18` (`support-center.css`, `support-desktop.css`) | **M0:** a single lazy link to `src/styles/support-bridge.css`. It `@import`s the untouched `src/support-center.css` and then `src/support-desktop.css`, **both into `layer(legacy)`**, keeping today's relative order; loaded last, they keep competing with the other legacy sheets on specificity and order exactly as today, so M0 stays pixel-neutral. It stays lazy because it has 524 selectors. <br>**M6** re-points both imports to `layer(features)` when the feedback shell is ported (`features` keeps them above `base` and `components`, so `[data-ui]` element rules never leak into the shared support center) and replaces `support-desktop.css` with `features/support-desktop.css`, mapping `--sc-*` to semantic tokens. The desktop remap (`.styk-feedback .support-center { --sc-* }`) always stays in the same layer as `support-center.css`. The shared `support-center.css` is never edited. |

### 2.7 Fonts

**Files.** Copy them from the `files/` folders of the `@fontsource-variable/inter` and `@fontsource-variable/inter-tight` packages (both 5.3.0, OFL-1.1). The spec gallery's `gallery-assets/fonts/` held the same 14 files (Inter opsz and Inter Tight wght, every subset below). They go to `assets/fonts/`:

| Family | Axis | Subsets (file `…-<subset>-<axis>-normal.woff2`) | Locales covered |
|---|---|---|---|
| Inter | opsz (better at 11–13 px) | latin, latin-ext, vietnamese, cyrillic, cyrillic-ext, greek, greek-ext | latin: en it es es-419 fr de nl da nb fi id pt-BR. latin-ext: cs hr hu pl ro sl tr. vietnamese: vi. cyrillic(-ext): ru uk kk. greek(-ext): el |
| Inter Tight | wght | the same 7 subsets | Headings, numerals, prominent buttons |
| (system fallback) | | | ar and he (Segoe UI, Noto Sans Arabic or Hebrew), zh-Hans (Microsoft YaHei UI, PingFang SC) |

- `LICENSE` from each package is copied as `OFL-Inter.txt` and `OFL-InterTight.txt`.
- Budget: Inter is 340,500 B and Inter Tight 222,800 B. A latin-only session loads 72,920 + 44,872 B.

**`@font-face`.** `src/styles/base/fonts.css` is the spec `fonts.css` with one change: the paths become `url("../../../assets/fonts/<file>")`, because the file sits three levels below the root. Each face has `font-weight: 100 900` and the spec `unicode-range`. The two preloaded latin faces use `font-display: block`; every other subset uses `swap`, so a Greek, Cyrillic or Vietnamese label is never invisible while its file loads (the pending-theme mask exists only on desktop). `theme-bootstrap.js` may add a preload for the active locale's subset. The stacks come from `src/styles/tokens.css`:

- `--font-ui: "Inter", "Segoe UI Variable Text", "Segoe UI", system-ui, …`
- `--font-display: "Inter Tight", "Inter", …`
- `--font-mono: "Cascadia Mono", …`
- `--font-features: "cv11", "ss01"`

**Preload** (in `index.html` after the bootstrap script, allowed by the CSP `default-src 'self'`; there is no `font-src` and none is added):

```html
<link rel="preload" href="./assets/fonts/inter-latin-opsz-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="./assets/fonts/inter-tight-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
```

For the latin faces, `font-display: block` works with the existing `html[data-theme-pending]` mask, which hides `#app` until settings answer, so the block period is hidden rather than blank.

**Loading and repaint.** `src/ui/font-loading.mjs` (M0):

- `installFontLoading()` listens for `document.fonts` `loadingdone` and dispatches `styk-theme-change` on `window`. This is coalesced to one event per frame, and the existing timeline and audio canvases already repaint on it (`layer-timeline.mjs:71`).
- **Nothing awaits fonts.** Init paths stay synchronous (the +25 ms startup gate); a canvas painted with the fallback font repaints on `loadingdone`.
- From M3b, `canvas-chrome-theme.mjs` listens to `loadingdone` itself and `font-loading.mjs` stops dispatching the theme event.

**Packaging.** `assets/**` is already in `package.json` `build.extraResources[0].filter`, `desktop/web-host.cjs:48-55` serves `assets/`, `.woff2` has a MIME type (`web-host.cjs:13`), and `scripts/verify-package.mjs` hashes `assets/`. **No packaging change is needed.** M0 proves this in a packaged build (§5.3 M0 verification).

**Tests.** `tests/fonts.test.mjs` (unit, CI) checks that:

- every `url()` in `base/fonts.css` exists
- every subset listed above is declared for both families
- the OFL texts are present
- the two preloads in `index.html` point at existing files

### 2.8 CSS lint: `scripts/check-css.mjs`

This is a zero-dependency Node script, about 400 lines, with a small CSS tokenizer (comments, strings and `url()` aware, with brace-depth tracking for at-rules). It is spawned by `scripts/check.mjs` after the syntax pass, so `npm run check` fails on lint errors. It exports `lintCss(text, file)` and `lintSource(text, file)` for `tests/check-css.test.mjs` (unit, CI, fixture strings for every rule).

| Id | Rule | Scope |
|---|---|---|
| CSS01 | Every rule is inside exactly one top-level `@layer` block named after its folder. `app.css` declares the canonical order statement exactly once. | `src/styles/**` except `legacy/**` |
| CSS02 | No colour literals (hex, `rgb()`, `hsl()`, named colours other than `transparent`, `currentColor` and system colours inside `forced-colors`) outside `src/styles/tokens.css`. A declaration tagged `/* artwork */` is exempt (checkerboards, VFX catalogue art). | same |
| CSS03 | No `var(--x, fallback)`, except private `--_x` with a non-colour fallback | same |
| CSS04 | Every `var(--name)` is declared somewhere in `src/styles/**` or is on the JS-written allowlist (§2.4) | same |
| CSS05 | Every allowlist entry still appears in its writer module | allowlist |
| CSS06 | `!important` only in `base/reset.css`, `states.css` and `utilities.css` | same |
| CSS07 | No ID selectors (only inside `:where()`) | same |
| CSS08 | No selectors on behaviour hooks: `[data-action`, `[data-shift-action`, `[aria-label`, `[title`, `[style`, `[data-i18n` | same |
| CSS09 | Specificity budget: base (0,0,x) plus `.ui-*` helpers (0,1,0); components and layout ≤ (0,2,0); features ≤ (0,3,0). `:where()` is 0 and `:is()`, `:not()` and `:has()` take their maximum argument. State and variant qualifiers go inside `:where()` (`.ui-menu-item:where(:hover, [aria-expanded=true]):not([aria-disabled=true])`). The spec `components.css` has 0 selectors over budget (`specificity.mjs`, internal design tooling, not in the repository). | same |
| CSS10 | Text floor: no `font-size` or `font` size below 11px, and no `--text-*` token below 11 | same plus `src/styles/tokens.css` |
| CSS11 | `z-index` is a `var(--z-*)` or a literal 0–3 | same |
| CSS12 | No `backdrop-filter` | same |
| CSS13 | In `layout/**` and in `components/{island,strip,splitter}.css`, `transition` and `animation` may touch only `opacity`, `transform`, colours, `visibility`, `display` and `overlay` | same |
| CSS14 | No viewport size media queries outside `layout/shell.css` | same |
| CSS15 | No invalid `font:` shorthand (`inherit` or `initial` mixed with other values, or a missing family) | all CSS including legacy (report only for legacy) |
| CSS16 | `@import` only in `app.css` and `support-bridge.css` | same |
| CSS17 | No `px` literals in `padding*`, `margin*`, `gap`, `row-gap`, `column-gap` or `border*-radius`; use `--space-*` and `--radius-*`. Allowed: hairlines (≤ 1.5px), tiny-mark radii (≤ 2px), `calc()` geometry tagged `/* geometry */`. (The spec `components.css` passes: 0 literals besides these.) | `components/**`, `features/**`, `layout/**` |
| CSS18 | While `legacy` exists: no unscoped `:where(*)`, universal or bare element selectors in `base/**` except the `html`, `::selection` and pending-mask rules of §2.1; everything else is under `:where([data-ui])` | `base/**` until M8 |
| CSS19 | Tier rules stay on their axis: a rule under `[data-height]` never folds or resizes a dock (the inspector, Structure, the label column) or the band; a rule under `[data-tier]` never sets the timeline's block size or a block inset (`experience.md` §1.8). The rail's compact size (40 with 32 px tools) may be keyed on either, since its tools serve both axes | `layout/**`, `features/**` |
| JS01 | No `createElement('style')`, `new CSSStyleSheet`, `adoptedStyleSheets` or `insertRule` | `src/**/*.mjs`, **ratchet** |
| JS02 | No runtime `<link rel=stylesheet>`, except `support-desktop-ui.mjs` → `support-bridge.css` | `src/**/*.mjs` |
| JS03 | In HTML template strings, `style="…"` may hold only custom properties | `src/**/*.mjs`, **ratchet** |
| JS04 | No colour literals or font stacks assigned to a canvas context (`fillStyle`, `strokeStyle`, `font`) in UI modules; use `canvasChromeTheme` | listed UI painters, **ratchet** |
| JS05 | No canvas font size below 11px | same, **ratchet** |
| HTML01 | `index.html` has no `<style>`, no inline script or `on*=` attribute, `style=` only with custom properties, exactly one stylesheet link and the two font preloads | `index.html` |

**Ratchet.** `scripts/check-css-baseline.json` records per-file counts for the ratchet rules (JS01 lists the 11 injectors). A count may only go down. `--update-baseline` refuses any increase. The file must be empty (`{}`) at the end of M8, and M8 then removes the ratchet code path. Legacy fragments are excluded from CSS01–CSS14, and they are deleted rather than fixed.

**Wiring.** Add one block to `scripts/check.mjs`: `spawnSync(process.execPath, ['scripts/check-css.mjs'], …)`, count failures and keep the existing summary line.

### 2.9 Splitting the legacy sheets and deleting them

**Status on `main` (`1e8a7cec`).** M0 commit 2 landed with the legacy sheets **whole**: `src/styles/legacy/` holds 21 files (`00-drawing.css`, `01-style.css`, `20-studio.css`, `30-builder-workspace.css` … `46-theme.css`, `99-settings.css`) imported in today's cascade order. Splitting `style.css` and `studio.css` into the fragments below was measured and dropped: 54 stylesheet requests delayed first paint by 45–100 ms and `styk.ready` by up to 50 ms, while the whole sheets matched the old links within 2 ms (commit message of `1e8a7cec`). The fragment table below therefore names **line ranges inside `01-style.css` and `20-studio.css`**, not files: each owner deletes its range (leaving a one-line `/* retired in Mx */` comment) in the commit that ports its surface, and M8 deletes what is left. The 0-changed-pixel gate held (144 snapshots).

M0.2 moves today's CSS into `src/styles/legacy/`. It is a pure move with no rule edits, and it is concatenation-equivalent **together with** the injector wrapping (§2.6) and the support sheets loading into `legacy` (§2.6): every rule that competes today still competes on specificity and order inside one layer. The M0 snapshot comparison must show 0 changed pixels, and its matrix includes the inspector open on a figure, on a joint and on the polygon rows (the `property-controls` injector), Settings, and the feedback shell.

- Imports stay in today's order: the `@import` inside `style.css` comes first, then `index.html:14-32`, then the runtime sheets.
- The original `src/*.css` files are deleted, **except** `src/support-center.css` (shared with the website, never moved) and `src/support-desktop.css` (lazy, loaded through `support-bridge.css` until M6).

Each fragment's owner empties it (leaving a one-line `/* retired in Mx */` comment) in the commit that ports its surface. M8 deletes the files and their import lines.

| Fragment (source lines) | Owner |
|---|---|
| `00-drawing.css` (`drawing.css`, the `@import` at `style.css:1`) | M7b |
| `01-style-root.css` (`style.css:2-92`: aliases, reset, base) | M8 |
| `02-style-titlebar.css` (`:94-158`) | M3b |
| `03-style-buttons.css` (`:159-210`) | M8 |
| `04-style-legacy-layout.css` (`:211-470`, dead) | M1 |
| `05-style-canvas.css` (`:470-641`) | M3b |
| `06-style-timeline.css` (`:642-766`) | M5 |
| `07-style-inspector.css` (`:767-1164`) | M4 |
| `08-style-statusbar.css` (`:1165-1242`) | M3b |
| `09-style-menu.css` (`:1243-1283`) | M2 |
| `10-style-dialog.css` (`:1284-1340`) | M6 |
| `11-style-toast.css` (toast rules within `:1341-1406`) | M2 |
| `12-style-export-misc.css` (the rest of `:1341-1506`: export options, renderer error, recovery, metric table, text options) | M6 empties it. The renderer-error and recovery rules in it have no `!important`, so M3b's layered styles already win and M3b does not edit this fragment. |
| `13-style-polygon.css` (`:1507-1574`) | M7a |
| `14-style-export-grid.css` (`:1575-1751`) | M6 |
| `15-style-floating.css` (`:1752-1779`) | M1 |
| `16-style-media.css` (`:1795-1866`) | M8 |
| `17-style-assets.css` (`:1868-2051`) | M7c |
| `18-style-paint.css` (`:2052-2076`) | M7g |
| `20a-studio-shell.css` and `20b-studio-rail.css` (`studio.css:1-57`, split at the rail rules) | M1 (grid, splitters, **and the rail's placement**: `studio.css:28` `top: calc((100% - var(--studio-timeline) + 38px)/2); transform: translateY(-50%)` and `:64`, which break once M1 removes `--studio-timeline`; M1 places the rail through the `.shell-rail` layout wrapper) and M3b (rail look, canvas toolbar) |
| `21-studio-builder.css` (`:58-88`) | M7a |
| `22-studio-viewport-inspector.css` (`:89-116`) | M4 |
| `23-studio-timeline.css` (`:117-131`) | M5 |
| `24-studio-dialogs-export.css` (`:132-242`) | M6 |
| `25a-studio-menubar.css` and `25b-studio-inspector.css` (`:243-323`, split) | M3b (menubar) and M4 (inspector) |
| `26-studio-camera.css` (`:325-349`) | M7e |
| `27-studio-quiet.css` (`:351-405`) | M3b |
| `30-builder-workspace.css`, `31-rig-controls.css` | M7a |
| `32-motion-path.css`, `33-tweener.css`, `34-canvas-guides.css`, `35-onion-controls.css` | M7g |
| `36-movieclip-ui.css`, `42-ik.css` | M4 |
| `37-vfx.css` | M7d |
| `38-camera-motion.css` | M7e |
| `39-user-library.css` | M7c |
| `40-layer-timeline.css` | M5 |
| `41-audio.css` | M7f |
| `43-update-ui.css`, `44-support-ui.css`, `99-settings.css` | M6 |
| `45-design-system.css`, `46-theme.css` | M8 (M0 moves the pending mask; M5 takes the timeline tokens; M6 takes the settings theme picker) |

The file-name prefixes sort in today's cascade order, which is also the `@import` order in `app.css`. The line ranges come from `css-architecture.md` §2 (internal research, not in the repository). The splitter adjusts each cut to the nearest rule boundary and records the final ranges in the commit message.

Paths that tests and scripts read change in M0:

- `tests/localization-settings.browser.mjs:14` and `tests/sprite-placement.browser.mjs:12` go from `/src/style.css` to `/src/styles/app.css`
- `tests/workspace-release-ux.desktop.mjs:18`
- `scripts/verify-library-release.mjs:11` goes from `src/user-library.css` to `src/styles/legacy/39-user-library.css`, and in M7c to `src/styles/features/library.css`; the same script lists `src/studio-shell.mjs`, which M3b deletes, so M3b updates it too

---

## 3. JS UI kit and shell

### 3.1 Module map

Rules for new modules:

- New modules live in `src/ui/` (reusable kit) and `src/shell/` (layout and chrome).
- **Basenames are unique across `src/` and `desktop/`.** Telemetry frames match by basename (`telemetry-schema.mjs:106`).
- Modules are DOM-free at import. Anything that touches the DOM runs from an `install*()` or `create*()` call, so pure parts can be unit-tested in Node.

| Module | Role | Built in | Reuses |
|---|---|---|---|
| `src/ui/dom-write.mjs` | `setText`, `setAttr`, `setFlag`, `setVar`, `setHidden`: compare-before-write with a WeakMap cache | M0 | Timeline P6 practice |
| `src/ui/font-loading.mjs` | Font readiness and repaint signal | M0 | – |
| `src/ui/overlay-manager.mjs` | Stack, hotkey gate, focus, close guards, prompt queue | M2 | `builder-toolbar.mjs:33-79` keyboard model; `timeline-menu.mjs` lifetimes |
| `src/ui/anchor-position.mjs` | CSS anchor positioning helpers, virtual pointer anchor, JS fallback for canvas points | M2 | Existing clamp code |
| `src/ui/ui-menu.mjs` | Menu and MenuBar (Add menu, app menu, Help menu, context, row and timeline menus) | M2 | `app.mjs:4147-4235`, `builder-toolbar.mjs`, `timeline-menu.mjs` |
| `src/ui/ui-popover.mjs` | Anchored non-modal panels | M2 | – |
| `src/ui/ui-tooltip.mjs` | The one tooltip | M2 | `hotkey-hints.mjs` data |
| `src/ui/ui-toast.mjs` | Toast and Task | M2 | The 150 ms deferred progress pattern (`app.mjs:5996-6120`) |
| `src/ui/ui-dialog.mjs` | Dialog shell, `confirm`, `prompt`, `choose`, the `#dialog` compatibility instance | M2 | `showDialog` (`app.mjs:3821`) |
| `src/ui/roving-focus.mjs` | Roving tabindex for toolbars, rails and tabs | M2 | `user-library.mjs:70-71` |
| `src/ui/toolbar-overflow.mjs` | Measured "More" overflow (priority-plus) through ResizeObserver | M2 | – |
| `src/ui/command-catalog.mjs` | Pure metadata: id → icon, labelKey, category, keywords, modes, group | M2 | `application-menu.mjs`, `MENU_KEYS` |
| `src/ui/command-registry.mjs` | Runtime registry over `actions` and `HOTKEY_COMMANDS` | M2 | – |
| `src/ui/command-palette.mjs` | The palette dialog | M2 | – |
| `src/ui/ui-invalidation.mjs` | Per-surface invalidation scheduler | M3a | `queueUI` (`app.mjs:398`) |
| `src/ui/ui-context.mjs` | Derived `uiContext`: target, range, numbering (no crumbs, scope or key state: those surfaces are gone) | M2 (track B: pure stub with the target and numbering fields, and its unit test), completed in M3b (track C). M4 and M5 only read it. | `studio-shell.mjs:87-97` scope logic |
| `src/ui/canvas-chrome-theme.mjs` | Canvas token resolver | M3b | `layer-timeline.mjs:115-122` |
| `src/shell/layout-schema.mjs` | v2 schema, presets, normalize, migrate, budget | M1 | `normalizeWorkspacePreferences` (`workspace-layout.mjs:10-41`) |
| `src/shell/layout-solver.mjs` | Tiers, sizes, states, insets, clamps | M1 | `constrainWorkspace` (`:44-118`), `constrainFloatingPanel` (`workspace-panels.mjs:4-38`), `constrainStudioLayout` |
| `src/shell/layout-store.mjs` | Load, debounced ordered save, merge-on-write, flush | M1 | `workspace-layout.mjs:223-267` |
| `src/shell/panel-registry.mjs` | Panel descriptors, visibility and `onVisibility` | M1 | – |
| `src/shell/dock-host.mjs` | Islands, tabs, strips, sheets, splitters, drag-to-dock, float | M1 | `workspace-layout.mjs:195-448` splitters; `workspace-panels.mjs:147-537` drag, float and dock zones |
| `src/shell/dock-keyboard.mjs` | Keyboard panel move (`Ctrl+Alt+M`), F6 and Ctrl+F6 region cycling | M1 | – |
| `src/shell/shell-commands.mjs` | Layout actions merged into `actions` | M1 | – |
| `src/shell/topbar.mjs` | The 8-control band: the mark and app menu, the Alt menubar overlay (in the document slot, no reflow), the document button and its popover (name, save, saved location), Undo/Redo, the primary slot (Export or a session's Done), window controls with `onWindowState` | M3b | `app.mjs:1907-1917`, `:5934-5936` |
| `src/shell/workspace-mode.mjs` | Mode state machine; replaces `studio-shell.mjs` | M3b | `studio-shell.mjs:15-22` |
| `src/shell/stage-head.mjs` | The stage header (a sibling of `#viewport` above it): the crumb or tool options slot, the message slot and its collision rule, the view cluster, zoom and Fit; the first-run hint (`hintsSeen.pose`) | M3b | – |
| `src/ui/tool-options.mjs` | Renders a tool's option descriptors into the stage header; folds them in order into "More options" | M3b (C) | – |
| `src/ui/quick-actions.mjs` | Renders a context's quick actions from the registry, with pins | M4 (D) | – |
| `src/inspector-bindings.mjs` | The `#inspector` change handlers as a declarative map | M3a (moved), M4 | `app.mjs:5021-5288` |
| `src/timeline-host.mjs` | `mountTimeline`, transport and header wiring, and the `#timeline-workflow` click listener (moved out of `studio-shell.mjs` in M3a) | M3a (moved), M5 | `app.mjs:6141-6270`, `:1880-1906` |
| `src/export-flow.mjs` | `showExport`, `exportOptions` and export actions; imports `mountExportFlow` directly from `export-panel.mjs` (not through `studio-shell.mjs:109`) from M3a | M3a (moved), M6 | `app.mjs:3489-4097` |
| `src/app-dialogs.mjs` | confirmReplace, rename, open recent, performance, import notes, Stick Nodes picker, discard frame | M3a (moved), M6 | `app.mjs:2974-3005, 3097, 3245, 4101-4146, 4391-4490, 6170` |
| `src/inspector-kit.mjs`, `src/inspector-header.mjs` | Section descriptors rendered to HTML; target block. `inspector-header.mjs` is the one writer of `#inspector-context`, `#object-actions` and `#inspector[data-selection-kind]` (track D); M3b only deletes `studio-shell.mjs`'s writes to them | M4 | `inspector-dom.mjs` contract |
| `src/timeline-header.mjs` | The shared timeline header | M5 | – |
| `src/export-request.mjs`, `src/export-sheet.mjs` | Pure `ExportRequest` and the export sheet UI (replaces `export-panel.mjs`) | M6 | `export-panel.mjs:64-119` validation |

### 3.2 Playback-quiet updates: `ui-invalidation.mjs` and `dom-write.mjs`

The measured baseline (`completeness-critique.md` §2.1, internal research, not in the repository) for 2 s of playback: 386 style recalcs (173 ms), 67 layouts, +18,355 DOM nodes, about 5,000 attribute writes. The cause is that `updateUI()` (`app.mjs:1935-1954`) rewrites the whole chrome and re-parses the inspector about 24 times a second.

```js
const ui = createInvalidator({ schedule: requestAnimationFrame, isPlaying: () => state.playing });
ui.surface('title',     { on: ['document', 'save'],                       update: topbar.update });
ui.surface('transport', { on: ['tick', 'playback'], playback: true, playbackInterval: 200, update: transport.update });
ui.surface('vfx',       { on: ['selection', 'revision', 'context', 'tick'], quiet: true,
                          visible: () => panels.isVisible('vfx'), update: () => vfxInspector.sync() });   // split out of renderInspector
ui.surface('inspector', { on: ['selection', 'revision', 'context', 'tick'], quiet: true,
                          visible: () => panels.isVisible('properties'), update: renderInspector });
ui.surface('camera',    { on: ['selection', 'tick', 'revision'], quiet: true,
                          visible: () => panels.isVisible('properties'), update: syncCameraSurfaces });  // was per frame in the render loop
ui.surface('stagehead', { on: ['view', 'tool', 'selection'], quiet: true, update: stageHead.update });   // zoom value, view toggles, tool options
ui.surface('shell',     { on: ['mode', 'settings'], update: workspaceMode.sync });
ui.surface('log',       { on: ['objects'], quiet: true, update: statusLog.update });
ui.invalidate('selection');   // reasons: tick, selection, revision, context, mode, range, view, settings, document, save, objects, drag, all
queueUI();                    // stays as the compatibility alias for ui.invalidate('all')
```

- A `quiet` surface is skipped while playing and flushed once when playback stops.
- An invisible surface (`visible()` false) is marked dirty and flushed on `onVisibility(true)`.
- Surface updates write only through `dom-write.mjs`, so equal strings or attributes never touch the DOM.
- `renderInspector()` keeps its gesture bail-out (`app.mjs:1978`) and no longer calls `vfxInspector.sync()` first, so folding Properties never stops VFX from syncing while VFX is visible.
- **Render loop.** `syncCameraControls($('inspector'))` and `drawCameraMonitor` (today called every frame when a camera is selected) move to the `camera` surface: never while playing, never while Properties is hidden. `#render-time` and `#renderer-label` (written every 200 ms today) are written only while the Performance dialog or the Document popover is open, and they live **outside** the `aria-live` log so they are never announced.

**Budgets.** These are enforced by `tests/playback-quiet.browser.mjs`, a port of the churn probe `churn.mjs` (internal research, not in the repository): MutationObserver per region plus wrapped layout-read APIs. Over 2 s of playback on the startup document plus 6 frames, in Advanced and in Simple, and again **with the camera selected**:

- **0** nodes created outside `#time-display`
- attribute writes only on the playhead elements and `#play-button`
- style recalc time ≤ 26 ms (15% of baseline)
- **0** calls to `getBoundingClientRect`, `offset*`, `client*`, `scrollLeft`, `scrollTop`, `scrollWidth`, `scrollHeight` or `getComputedStyle` from chrome code (the one allowlisted batch is the timeline's cached `_extent` read)
- 0 long animation frames
- at most 2.5 canvas draws per animation frame (the new frame, the repaint after the chrome pass its seek schedules, and the readout's passes), whatever the display's refresh rate

The test is introduced in M3a with a ratchet allowlist:

- the filmstrip's per-seek `clientWidth` read (G1) until M5
- `audio-timeline.mjs:208-209` per-paint `getComputedStyle` and resize (G2) until M7f

### 3.3 `OverlayManager` (`src/ui/overlay-manager.mjs`)

```js
const overlays = createOverlayManager({ hotkeys, fallbackFocus: () => viewport, telemetry });
overlays.register(el, { kind: 'dialog'|'menu'|'popover'|'palette'|'sheet'|'toast'|'tooltip',
                        modal, keyboardScope, returnFocus, beforeClose, signal });   // → handle {id, signal, close(v), requestClose(), result}
overlays.blocksHotkeys();          // true while a modal dialog, menu, palette or keyboard-scoped popover is open
overlays.top(); overlays.closeAll(reason);
overlays.enqueuePrompt({ id, priority, ready: () => boolean, open: () => Promise });
overlays.addEventListener('open' | 'close' | 'blocking-change', …);
```

- **Stack and ownership.** Each dialog owns its own `<dialog>` element, so flows can no longer clobber each other and nesting works (a confirm over Settings or Export). `#dialog` and `#dialog-content` remain as the default compatibility instance (§3.8). The MutationObserver pre-emption checks in `export-panel.mjs:156-158`, `sprite-placement-dialog.mjs` and `app.mjs:6000-6026, 6076-6103` are removed as their flows are ported.
- **Lifetimes.** Every handle owns an `AbortController`, and listeners, observers and timers use its `signal`.
- **Hotkey gate.**
  - `document.querySelector('dialog[open]')` at `app.mjs:5576` and `:5609` becomes `overlays.blocksHotkeys()`. It is still true for any open `dialog`, which keeps today's invariant.
  - The MutationObserver at `:5648` becomes `blocking-change` → `hotkeys.releaseAll()`.
  - Menus and keyboard-scoped popovers capture keydown, so unhandled letters never reach editor hotkeys. This fixes H switching to Pan while the File menu is open.
- **Close guards.**
  - Dialogs use `closedBy = 'closerequest'`. The `cancel` event calls `preventDefault()` and then runs `beforeClose(reason)`, which may veto.
  - Export progress asks "Stop exporting?". Text apply and segment values keep their busy semantics.
  - `dialog.requestClose()` (Chromium 134 and later) is the × and Escape path.
- **Focus.** On open, focus goes to `[autofocus]`, then the first field, then the primary action, and never to ×. On close, focus returns to the invoker, with `#viewport` as the fallback.
- **Top-layer order.** After any modal opens, the toast host is re-shown (`hidePopover()` then `showPopover()`). Toasts stay visible above dialogs, although they are inert while the modal is open.
- **Startup prompt queue.** This replaces `support-ui.mjs:14-19` polling and the capture-phase `close` listener at `app.mjs:6521-6525`.
  - A prompt opens only when no blocking overlay is open, after the first rendered frame.
  - The order preserves today's sequence: **release notes, then the privacy first run**.
  - The recovery offer is a non-modal message in the stage slot, shown immediately. It keeps `#restore-recovery` and adds the snapshot time and file name. Recovery has one slot (`getRecovery`/`deleteRecovery` take no id): *Not now* hides the card, and the Document popover offers "Restore last session" only until this session's first backup (`scheduleRecovery`) overwrites the slot.
  - Update-ready is a persistent message that keeps the "Restart to update" and "Open downloads" names.
  - The first-run hint waits for everything above and is shown once (`hintsSeen.pose`).
- **Message priority** (one message in the stage's bottom inset at a time): error → recovery → update → toast → first-run hint. `ui-toast.mjs` owns the queue; `experience.md` §4.3 and `components.md` Message use the same list.

### 3.4 Menu and MenuBar (`src/ui/ui-menu.mjs`)

```js
openMenu({ anchor | point: {x, y}, items, placement: 'bottom-start', mount?, keyboardScope: true, onClose });   // → handle
// item: { command?, label?, labelKey?, icon?, shortcut?: 'auto' | string, checked?, radio?, group?, danger?,
//         disabled?, reason?, submenu?: items | () => items, run? } | null (separator) | { label: 'Group' } (group label)
installMenuBar(nav, { menus: { file: () => items, edit, view, editor, animation, help }, overlays });
```

- **Rendering.** The element is a `popover="auto"` with `role="menu"` and `aria-label`. Items are `button.menu-item.ui-menu-item[role=menuitem | menuitemcheckbox | menuitemradio][data-action]`.
  - The **first `<span>` is the label**, which keeps `tests/localization-app.browser.mjs:48` passing.
  - The check column is `<i class="ui-menu-check">` and the icon is `<svg class="ui-icon icon">`.
  - The shortcut is `<kbd class="ui-menu-shortcut">`, styled as plain text but still a `kbd` (the same test asserts `kbd` equals `Ctrl S`).
  - Separators get `role=separator`.
- **The app, context and zoom instance renders into `#menu`**, which 19 test files query as `#menu [data-action=…]`. **`#menu` mirrors the `hidden` attribute**: the kit clears `hidden` before `showPopover()` (legacy `[hidden] { display: none !important }` beats every layer) and sets it again on close, so the five tests that read `#menu.hidden` (`native-handles:83`, `node-only-drag:64-74`, `pen-input:49`, `tweener:41`, `workspace-clean:55`) keep passing. Timeline menus keep the extra `.sheet-menu` class through `timeline-menu.mjs`, which becomes an adapter over `openMenu` with an unchanged `showTimelineMenu(host, event, groups)` API. The library context menu, `.tweener-types` and the builder "pages" become submenus.
- **Keyboard.** This is the union of the best existing code:
  - Up, Down, Home, End
  - typeahead with a 700 ms buffer
  - Enter and Space re-dispatch the click **with modifiers**, so `data-shift-action` still works
  - Right and Left open and close submenus, with hover-intent
  - Escape and Tab close and return focus
  - menubar Left and Right plus hover-switch
- **Dismissal.** Outside pointerdown, window blur, anchor scroll, and optionally `editor` `change`.
- **Submenus** are nested popovers shown with `showPopover({ source: invoker })`, so popover ancestry keeps the parent open.
- **Items** come from the command registry. Labels, icons, enablement, checked state and shortcut text are never hand-written. A disabled item shows its reason line, or is hidden when the command makes no sense in the mode.
- **Fixes that come with it.**
  - `#object-actions` opens. Today the document click handler closes `#menu` in the same click that opened it.
  - View toggles become checked items.
  - The `about` action opens an About/What's new surface (M6) instead of Shortcuts.
  - Text fields get Cut, Copy, Paste and Select all through the same Menu on `contextmenu` for `isHotkeyInput` targets.

### 3.5 Popover and anchor positioning (`ui-popover.mjs`, `anchor-position.mjs`)

```js
createPopover({ anchor, placement: 'top-end', title?, powerSwitch?, closeLabel?, body, foot?,
                dismiss: 'auto' | 'manual', returnFocus: true, mount: 'auto' });
// → { element, show(), hide(), toggle(), update(), signal }
```

- **Placement** uses CSS anchor positioning. On open, the anchor gets `style.anchorName = '--a<id>'` through CSSOM (allowed by the CSP). The popover gets `position-anchor`, `position-area` from `placement`, and `position-try-fallbacks: flip-block, flip-inline`. This replaces more than 10 hand-written clamp functions, none of which flip.
- **Context menus** anchor to one fixed 1×1 virtual element, moved per open (never per frame).
- **`mount: 'auto'`** means `anchor.closest('dialog[open]')` if any, else `document.body` with `showPopover({ source: anchor })` so an ancestor popover or sheet stays open (§1 rule 5).
- **Size.** Menus and popovers get `max-block-size` limited to the window below the top band and scroll inside; head and foot stay put. After `position-try-fallbacks`, a JS clamp shifts the box inside the window (context menus open at the pointer and flip left or up first).
- **Semantics.** `role=dialog`, `aria-modal=false`, `aria-labelledby`. Focus goes to the first control. Escape returns focus to the anchor.
- **Users.** Onion settings, guides, motion paths, audio options, the VFX catalogue and parameter key menu, Layout, Layers (Simple), Document, Go to frame, brush presets, and the paint picker (keeping its `popover=manual` eyedropper behaviour).

### 3.6 Tooltip (`ui-tooltip.mjs`)

- One element with `popover="hint"` (Chromium 133 and later), so tooltips never close open menus. Showing is delegated on `pointerover` and `focusin`.
- **Timing.** A 500 ms delay, instant between neighbours for 300 ms. It hides on pointerdown, scroll or Escape and is never interactive.
- **Content.** The name comes from `data-tooltip`, then `data-hotkey-title`, then `aria-label`, followed by a middle dot and the shortcut as plain text from `commands.shortcutParts(id)` (`HOTKEY_BY_ID` and the user's bindings), never parsed from text. No keycaps.
- **Accessibility.** `role=tooltip`, and `aria-describedby` is set only while it is shown.
- **`refreshHotkeyHints`** stops writing `title`, which would double up with the tooltip. It writes `data-hotkey-title`, `data-hotkey-hint` and `aria-keyshortcuts`. Accessible names never contain the shortcut (`getByRole('button', { name: 'Undo', exact: true })` in `autopose.browser.mjs:24,31`).
  - `localization-bindings.mjs` gains `data-i18n-tooltip`, which translates into `data-tooltip` with the same `· <shortcut>` suffix rule.
  - Tests that read `title` move to `data-hotkey-hint` in the same M2 commit: `hotkeys-timeline.browser.mjs:49,82`, `integrated-ux-walkthrough.browser.mjs:184-191`, `join-selection.browser.mjs:73`, `asset-library.browser.mjs:162`.

### 3.7 Toast and Task (`ui-toast.mjs`)

```js
toasts.show({ message, tone: 'info'|'success'|'warning'|'error', action?: { label, command }, timeout });
const task = toasts.task({ title, meta, format?, cancellable, signal, confirmCancel?: 'Stop exporting?' });
task.progress(0..1 | null); task.done({ message }); task.fail(error);
```

- **Host.** The host is `#toast`, the id kept (5 test files), as a `popover="manual"` placed in the stage's bottom inset (bottom centre, 8px from the edge), never over the artboard. While a modal dialog is open the host lives inside the topmost one (outside it the message would be inert: seen but not clickable) and sits outside the dialog's box (above it, else below it, else under the band); it moves back when the dialog closes. Until M3b's message slot, the stage placement moves the message left of the canvas's view controls, else above them (`avoid()`), so it never covers them.
- **Behaviour.**
  - One toast is visible at a time, with at most 3 queued.
  - Identical messages are de-duplicated.
  - Hover or focus pauses the timeout.
  - `role=status`, or `role=alert` for errors. An error shows its glyph (`alert`; a warning `warning`) and a dismiss button. Failed saves, exports and imports persist until dismissed; until command preconditions throw `UserActionError`, the app's other failures go after 8 s (`FAILURE_MESSAGE_MS`), as 1.1's notices did.
  - Only info toasts clear on canvas pointerdown (today `app.mjs:2246`).
- **`fail()` mapping:**
  - `AbortError` is silent.
  - `UserActionError` (`user-action-error.mjs`) is a warning.
  - Anything else is an error, with "Send feedback" on desktop.
- **Status line.** `status()` writes the hidden `aria-live` log (§3.12 / M3b) instead of the status bar.
- **Task** generalises the 150 ms deferred progress used by `changeFigureLayer` and clipboard operations. Export progress stays inside the export sheet in M6 (§3.15).

### 3.8 Dialog kit (`ui-dialog.mjs`)

```js
const d = createDialog({ size: 'sm'|'md'|'lg', variant?, title, description?, body, actions: [{ label, value, variant, autofocus }],
                         beforeClose, className, closeLabel });
await d.showModal();   // resolves with the submitted value, or null on cancel
d.setBusy(true); d.setError(message); d.close(value); d.requestClose();
await confirm({ title, body, confirmLabel, cancelLabel, danger, alternatives });
await prompt({ title, label, value, validate, confirmLabel });            // rename
await choose({ title, options: [{ value, id, label, description, icon }] });  // builder exit, Stick Nodes asset; `id` keeps
                                                                           // #builder-exit-update|import|import-new|discard
showLegacyDialog(title, bodyHTML);   // #dialog compatibility: wraps the body in <form method=dialog> and applies the focus rule
```

- **Structure.** Always a `<form method="dialog">`, so Enter submits and Escape fires `cancel`. Sizes are sm 420, md 640 and lg 880 × min(540, 100dvh − 32) (`design/app-ui/components.css`, `experience.md` §5.14). A dialog never changes size between tabs. The backdrop is `--surface-backdrop` with no blur.
- **`showDialog`** (`app.mjs:3821`) becomes a thin alias of `showLegacyDialog` until every caller is ported in M6. `#dialog`, `#dialog-content` and `[data-action=close-dialog]` stay (37, about 8 and 11 test files).
- **Initial focus.** `[autofocus]` → the first field → the primary, never × or a tab. When the opening event came from a pointer (the OverlayManager records it), the control is focused with `focus({ focusVisible: false })`, so the ring appears only for keyboard-initiated opens and from the first Tab (Chromium supports the option; `experience.md` §5.14).
- **Test hooks** stay on the ported dialogs: `#keep-editing`, `#discard-changes`, `#restore-recovery`, `#cancel-export`, `#export-progress`, `#text-content`, `#create-text`, `[data-text-close]`, `.styk-settings`, `.release-splash`, `.styk-privacy`, `.styk-inbetween-*`, `.movieclip-dialog`, and "Close settings" and "Close welcome screen".

### 3.9 Command registry (`command-registry.mjs`, `command-catalog.mjs`)

```js
const commands = createCommandRegistry({ actions, dispatch, hotkeys, localization, catalog, context: () => uiContext() });
commands.get(id);            // → { id, label, icon, category, shortcut, shortcutParts, enabled, reason, checked, danger }
commands.run(id, { event, source: 'menu'|'palette'|'rail'|'hotkey'|'native' });
commands.list({ query, context });   // for the palette: recents first, out-of-context rows with reasons
commands.items(model);       // Menu items from a list of ids and groups
commands.define(id, meta);   // tracks add metadata for actions they add (shell-commands, timeline, …)
```

- **Ids are the existing `actions` keys, which are never renamed.** The registry enumerates `actions` **at runtime**. There are 184 today, including late additions such as `add-to-library` and the `movieclip-*` telemetry wrappers (`app.mjs:6462-6484`).
- **Metadata** is merged from `HOTKEY_COMMANDS` (118 ids: labels, categories, scopes), `command-catalog.mjs` (icons, `labelKey`s, keywords, mode filters, menu groups) and `MENU_KEYS`, which moves into the catalog.
- **`dispatch(id, el, event)`** is the **same guarded wrapper** used by click delegation (`app.mjs:4950-4968`). That wrapper defers during drawing gestures, applies the polygon-safe filter and records `telemetry.action(name)`, so telemetry buckets do not change.
- **Registration order.** Today the wrapper is applied by a one-time loop over `actions` (`app.mjs:6462-6466`), so anything merged later would skip it. `SHELL_ACTIONS` and every track's actions are merged **before** that loop; anything registered later goes through one `registerAction(id, fn)` that applies the same wrapper. A browser contract test checks the runtime `Object.keys(styk.actions)` (dynamic keys such as `zoom-25/50/100/200` included) against every `data-action` in the DOM.
- **Labels reuse existing catalog keys** (`timeline.addFrame`, `menu.newAnimation`, `common.undo`, `menu.importFigures`, …) because the 26 native Pivot catalogs (`locales/native-catalogs.mjs`) map them; a new `labelKey` for an existing control would silently drop those translations. `tests/native-catalog-keys.test.mjs` fails when a key referenced by `native-catalogs.mjs` is no longer used by a rendered control or registry entry.
- **Indexes and homes.** The app-menu submenus, the Alt menubar, the native menu and the palette render **indexes** of the registry (whole groups); every other menu lists only the commands whose home it is (`experience.md` §8). `commands.items(model)` takes the menu's model either way, so no command is implemented twice.
- **One source for labels.** `application-menu.mjs` keeps `applicationMenuItems()` as a view over the catalog, for compatibility. The brand menu, the Editor menu, the canvas context menu, `#object-actions`, the builder menus and the palette all render from the registry. This ends the Mirror/Flip, Segment editor/Exact values and Settings/Preferences drift.

### 3.10 Command palette (`command-palette.mjs`)

- **Opening.** A `ui-dialog` (md, anchored at the top; full window at compact and minimal width), opened by the **`command-palette`** action: **Ctrl+P, Ctrl+Shift+P or F1** (all free in `hotkeys.mjs`), and by *Search commands…* in the app menu (`[data-action=command-palette]`). The id is listed in `SHELL_ACTIONS`, so `shell-contract.test.mjs` sees it. Ctrl+K stays `toggle-camera`.
- **Search row.** A combobox input plus a listbox driven by `aria-activedescendant` (no scope chip).
- **Groups.** Commands (registry), In this project (providers registered by features: figures, layers, library clips), Learn (tutorial links through the existing `openServicePage`), and Settings (every `data-setting`, which opens that settings tab and field).
- **Frame jump.** Typing a number jumps to that frame through the timeline host.
- **Keys.** `Shift+Slash` (`help`) is re-pointed in M6 to the read-only shortcut cheat sheet. Settings keeps Ctrl+Comma.

### 3.11 Layout engine (`src/shell/*`)

#### 3.11.1 Panel registry

```js
panels.define({ id, title, titleKey, icon, root: () => el, regions: [...], floatable, min, pref, max, modes, onVisibility });
panels.isVisible(id); panels.activate(id); panels.onVisibility(id, cb);
```

| Panel | Root, moved with `append()` and never re-created | Allowed places | Floatable | Size (px) min / pref / max | Modes | `onVisibility` pauses |
|---|---|---|---|---|---|---|
| `properties` | `.inspector-header` + `#inspector` | right, left (dock); strip or sheet (tiers) | **no** | 256 / 288 / 360 | all | `renderInspector`, the `camera` surface |
| `vfx` | `#vfx-panel` | right, left; tab into properties | yes | 256 / 288 / 360 | animate, draw, rig (Build keeps it, as today) | the `vfx` surface (`vfxInspector.sync`) |
| `library` | `#user-library` | right, left; tab into properties | yes | 256 / 288 / 420 | animate, draw, rig | thumbnails and hover preview |
| `timeline` | `.timeline-panel` (`#animation-timeline`) | **bottom only**: docked (height `sizes.bottom`) or strip (the header row); the header alone at the low height tier, whose body opens as a sheet | **no** | 120 / `sizes.bottom` / 0.6 × height | all (rig: `hidden` by default, as today) | already zero-size safe |
| `structure` | `#builder-outliner` | left, right; narrows to 200 px, then a strip, wherever docking it would leave `#viewport` under its 360 px floor (always at compact and minimal width; at narrow below about 890 px, revision 4.1), opening as a sheet over the stage (`panel-toggle-structure`) | no | 200 / 232 / 360 | rig | outliner ResizeObserver |

- **The rail is not a panel.** Its side is part of the arrangement (`rail: 'left' | 'right'`). It is **vertical at every tier** (40px wide with 32 px tools at minimal width or the low height tier). The stage is not a panel and can never be moved, floated or folded.
- **Late roots.** `#user-library` is created by the `UserLibrary` controller after `installShell()`; `index.html` therefore holds an empty `#user-library` host that the controller fills, so `panels.define()` always finds its root (late `define()` is also supported and re-applies the solution).
- **`dock-host` is the single owner of per-group visibility.** Today the feature modules hide each other: `UserLibrary.showView()` hides `#inspector` and `.inspector-header` when Library or VFX is shown (`user-library.mjs:125-131`), and `VfxInspector.setVisible(v)` sets `this.properties.hidden = v` (`vfx-inspector.mjs:47`). In M1 both are rewritten to show only their own root (track A owns those lines in M1). Stacked groups, floating VFX and a Library docked left then work without hiding Properties.
- **VFX rows in the Advanced timeline** show while the VFX panel is visible in the current workspace (docked, floating or open as a sheet), which keeps today's behaviour; `editor._vfxTimelineVisible` is derived from `panels.isVisible('vfx')` by `dock-host`, never written by the VFX module.
- **Tab reset.** Entering Draw or Build activates Properties; returning to Animate restores Animate's last active tab. Build keeps today's Properties, VFX and Library tabs.

#### 3.11.2 Schema v2 (inside `workspace-preferences.json`)

```json
{
  "studioVersion": 1, "right": 288, "timeline": 152,
  "layoutVersion": 2,
  "shared": { "stamp": 0, "sizes": { "left": 256, "right": 288, "bottom": 152, "structure": 256, "timelineLabels": 196 } },
  "modes": {
    "animate": { "stamp": 0, "preset": "user:u1", "rail": "left", "bottomSpan": "full",
      "regions": {
        "left":   { "state": "docked", "groups": [{ "tabs": ["library"], "active": "library", "weight": 1 }] },
        "right":  { "state": "docked", "groups": [{ "tabs": ["properties", "vfx"], "active": "properties", "weight": 1 }] },
        "bottom": { "state": "docked" } },
      "floating": [],
      "focus": null,
      "pins": { "figure": ["mirror", "layer-front", "layer-back", "duplicate", "join-figure", "delete"] } },
    "draw": { "stamp": 0, "preset": "draw" },
    "rig":  { "stamp": 0, "preset": "build" }
  },
  "saved": [{ "id": "u1", "name": "Fight setup", "mode": "animate", "stamp": 0, "arrangement": { "…": "…" } }],
  "tombstones": [{ "id": "u0", "stamp": 0 }]
}
```

- **Allowed values.**
  - Region `state`: `docked`, `strip` or `hidden`. The UI labels are **Shown / Strip / Hidden** (one word everywhere: the model, the Layout popover's position selects; the tab menu's command is *Hide*). The timeline is **Full / Strip**; `hidden` is allowed for the timeline **only in `rig`**, where it is the default (today's Build hides the timeline, `builder-mode.mjs` `data-builder-timeline`). `Ctrl+4` and *View › Panels › Timeline* show it there, and Play, Add frame and Onion with it.
  - `bottomSpan`: `full` (the timeline spans the stage and the right dock, as today; **the default**) or `stage` (the timeline sits under the stage and the right dock runs full height). UI: "Timeline: Full width │ Under stage".
  - `floating`: `[{ panel, x, y, w, h }]`, **VFX and Library only, at most 2 per mode**, integers in CSS px relative to the stage island's top-left; clamped on load and on every resize without writing back.
  - `focus`: `null` or the snapshot arrangement to restore when Focus is turned off.
  - `pins` (revision 4, optional): per inspector context kind, the quick actions a person pinned (registry ids, at most 6 per context, at most 12 contexts). Absent means the context's default quick actions from the registry. Unknown ids are dropped on load. The titled sections' open state is **not** a layout field: it is the editor setting `inspectorSections` (`{ [contextKind]: string[] }`, at most 64 entries), because it follows the person, not the arrangement.
  - `sizes.bottom`: the timeline height, one user-owned number shared by every workspace and both timeline modes. `null` means "the default height", which **does not depend on the document or the mode**: the header, the label header, Camera and Scene (pinned) and three content-row slots, capped at 32% of the window in whole rows and never fewer than two content slots (compact drops the 8 px bottom padding). The first time the timeline is shown the solver resolves `null` once and the height then stays until the splitter stores a number (120px to 60%), *Tall timeline* stores 60%, the **Timing preset stores 40%** of the workspace (it writes this one shared field, so, like the splitter, it changes the height in every workspace; no arrangement carries a height of its own), or *Default height* stores `null` again (*Default height* and *Tall timeline* are one radio pair in *Timeline ⋯*). More rows (layers, the VFX tab's effect rows) scroll under the pinned rows with the thin themed scrollbar and a soft bottom fade; the Simple filmstrip sizes its cards to the same body (104–168 px). **Nothing resizes the timeline on a tab switch, a mode switch or a new row**, so `#viewport` never moves on a routine click (the reference measures 240 px and 94% in the Advanced, Simple, VFX-tab and first-launch states).
- **Normalization** (`layout-schema.mjs`, pure):
  - Unknown panel ids are dropped. Missing required panels (properties; the timeline, which may be `hidden` only in `rig`; structure in `rig`) are re-added to their default region. A timeline `hidden` outside `rig` is normalized to `strip`. A panel in a region it does not allow is moved home; a `floating` entry for a non-floatable panel is dropped.
  - Sizes are clamped to the registry min and max. Weights stay in 0–1.
  - At most 8 saved layouts, with names up to 48 characters.
  - At most 16 tombstones, pruned after 30 days.
  - Integers only.
- **Budget.** The serialized size is kept at or below **12 KiB** (the file cap is 16 KiB, `desktop/preferences.cjs:34`). *Save as preset…* is disabled with the reason "8 presets saved. Delete one first." when 8 exist (`experience.md` §1.7), and with "Preset storage is full. Delete one first." if a new preset would pass the budget.
- **Presets** are data in the schema module. Each is also a mini dock map (`.ui-dock-map`).

| Preset | Arrangement |
|---|---|
| Animate | Inspector right, tabs Properties, VFX, Library; timeline full width (`bottomSpan: full`) |
| Timing | `bottomSpan: full`, timeline 40% of the workspace, written to the shared `sizes.bottom` (every workspace's height changes with it); inspector above it, Properties only (VFX and Library `strip`) |
| Focus | Rail and stage; every other region `strip` (a toggle with a `focus` snapshot) |
| Review | Inspector `hidden`, timeline `strip` |
| Draw | As Animate |
| Build | Structure left, inspector right (Properties, VFX, Library), the stage showing today's artboard at fit canvas, timeline `hidden` (today's Build default; `Ctrl+4` or *View › Panels › Timeline* shows it, and Play, Add frame and Onion with it; Build's app menu has Figure, not Animation) |
| Build + timeline | As Build with the timeline `docked` |
| User-saved | Up to 8 |

**Per-workspace arrangement, shared sizes.** This keeps the "sizes are shared" contract in `docs/animation-modes.md:51`, whose wording is updated in M1 to cover arrangements.

**Fixtures.** `tests/layout-schema.test.mjs` freezes JSON fixtures: a v1 file → v2; a v2 file → 1.1's `persist()` (`{ ...loaded, studioVersion: 1 }`) → read again by v2 with every v2 key intact; an unknown future `layoutVersion` → presets, blob untouched.

#### 3.11.3 Migration and downgrade safety

- `migrateLayout(raw)` is a pure, tested function:
  - `{ studioVersion: 1, right, timeline }` becomes v2 with `shared.sizes.right` and `.bottom`. The v1 default `timeline: 280` means "never customised" and migrates to `null` (the default height); nothing is stored at first run, so the height stays at the default until the user drags the splitter or uses *Tall timeline*. Any other value is kept.
  - The legacy `{ left, right, timeline, floating }` blob maps to the same fields.
  - The editor setting `builderOutlinerWidth` is read once into `shared.sizes.structure`.
  - Anything invalid falls back to presets.
  - An unknown future `layoutVersion` falls back to presets **without rewriting the blob**, and the app says once "This layout was made by a newer StykAnimate. Changes this session won't be saved."
- **Downgrade.** The v2 writer keeps the mirror keys `studioVersion: 1`, `right` and `timeline` at the top level. A 1.1 app then reads the file as v1. Its `persist()` spreads the loaded object back (`{ ...preferences, studioVersion: 1 }`, `studio-layout.mjs:35`), so the v2 keys survive a downgrade round trip.
- **Clamping never writes back.** This principle is carried over from `tests/studio-layout.test.mjs` ("compact layout clamps without changing the saved desktop preference").

#### 3.11.4 Solver and tiers

`solveLayout(model, { width, height, mode, platform }) → Solution`. It is pure and deterministic. Its input is the **`#app` content box** (the window) from a ResizeObserver in CSS px after page zoom; it does not depend on anything the solution changes, so tiers cannot oscillate. The tier is written to `document.documentElement` as `data-tier`, where top-layer dialogs and popovers can read it.

Two independent tiers (`visual-system.md` §11, `experience.md` §1.8). **Width folds horizontal chrome only; height folds vertical chrome only**, so a short window keeps its docked inspector and workspace switch (1920×520: Windows top-half Snap), and a narrow one keeps its timeline body.

| Width tier (`data-tier`) | Trigger |
|---|---|
| wide | ≥ 1367 |
| regular | ≤ 1366 |
| narrow | ≤ 1180 (down to 801: everything stays docked, as today's app keeps it) |
| compact | ≤ 800 (revision 4.1; was 900) |
| minimal | ≤ 660, or wherever the band does not fit even with every step of its fold order applied |

| Height tier (`data-height`) | Trigger |
|---|---|
| tall | ≥ 641 |
| short | 569–640 |
| low | ≤ 568 |

- **`bandMin`** is the band's min-content width for each step of the **band fold order** (revision 4.1: the document state's words → tighter menubar spacing → the workspace switch's three glyphs → Export's and Test rig's labels → the document name truncated to 9 characters → Save into File → 36 px window controls → the document name to its dot → Redo into Edit), measured by `topbar.mjs` once per language, UI scale and session state (Export, a session's *Done*, Build's *Test rig*) and passed to the solver as an input (`{ step: px }`), so the solver stays pure. The solver applies the fewest steps that fit and writes them to `data-band`; **the menubar folds into the mark only at minimal**, where even the last step does not fit (English Animate: 700 px keeps it; a movieclip session with Cancel and Done: 800 px). The band's labels and spacing always fold before the menubar does.
- **568** is where docking the short timeline body (200 px) would leave the artboard under 45%: below it the timeline is its header and *Timeline ⋯ › Timeline…* opens the body as a sheet. **Stage floors** (the artboard zoom a window at least W×H always gets: 500×340 35%, 600×441 45%, 1024×700 60%, 1280×720 65%, 1440×900 90%) never decrease as a window grows, so the stage share is monotonic across tiers; the solver tests assert them over the reference's sweep (33 widths × 29 heights). Revision 4.1 drops the 800×600 floor of 50% to the 45% row: from 801 px the inspector stays docked, as today's app keeps it (today's artboard is 42–44% there); at 800 and below it is a sheet and the stage gets 51%.
- **`data-left`** is `strip` in Build wherever docking Structure would leave `#viewport` under its 360 px floor (revision 4.1; was 400): Structure docks at 232 px, narrows to 200 px before it folds, and folds at compact and minimal width and below about 890 px at narrow, so Build at 900×700 and 960×600 keeps today's docked outliner.

**Collapse order** (applied until the stage is at least **360×200** and the band fits):

1. Width: the band folds its labels and spacing in its fold order (above); tool options fold their labels, then their declared twins (into the tool's inspector section) and homes, then into *More options*; Build's Highlight part and Static handles fold into *View › Build* when its stage header is full.
2. Width: the left dock narrows to 200 px, then becomes a strip (before the inspector, whatever the user put there); its button opens the panel as a sheet over the stage, so `#viewport` never drops below 360×200.
3. Width: the inspector becomes a sheet (compact, minimal: 800 px and below): the band's Properties button moves the same `#inspector` root into the sheet host. Floating panels become sheets. The saved layout is unchanged.
4. Width (minimal only): the menubar folds into the mark; First frame, Loop and Audio fold into *Timeline ⋯*; labels drop on Add frame and Next copy. The workspace switch is never a pill: it keeps its three segments (glyphs when the band is tight).
5. Height: timeline rows scroll under the one sticky height; at the short tier the timeline shows Camera, Scene and two content rows; at the low tier the timeline is its 40 px header, and *Timeline ⋯ › Timeline…* opens the timeline body (the same root, moved into a sheet host) as a bottom sheet over the stage in both modes; the rail's tools drop to 32 px.

**Never hidden:** the document state (at least its dot), Undo, Export (or a session's Done, which always lives in the band's primary slot), the workspace switch's three segments, the window controls, zoom and Fit, and outside `rig` (where the timeline is `hidden` by default, as today) `#play-button`, *Add frame* and Onion. From 801 px also the menubar, the docked inspector, the view toggles, *Simple │ Advanced* and (from 801 px, as today) the frame rate. The per-tier table is `experience.md` §1.8; `tests/ui-tasks.browser.mjs` and `scripts/check-function-ledger.mjs` run again at 1280×720, 1152×720, 1100×700, 1024×700, 960×600 and 900×700 (revision 4.1).

**Output:**

```js
{ tier, height, rail: { side, orientation: 'vertical', compact },   // tier: width tier; height: 'tall' | 'short' | 'low'
  regions: { left: { size, state }, right: { size, state }, bottom: { size, state, span } },
  floating: [{ panel, x, y, w, h }],          // clamped inside the stage, never over the top band or transport
  stageHead: 40,                               // the stage header row above #viewport (revision 4), every tier
  stageInsets: { top: 24, right: 28, bottom: 24, left: 28 },   // inside #viewport; left/right by width: 28 (wide, regular), narrow and compact 20, minimal 10;
                                               // top/bottom by height: tall 24/24, short 12/12, low 8/8 (pure clearance:
                                               // nothing sits inside #viewport)
  timelineRows: { pinned, content },           // pinned Camera/Scene + visible content rows before scrolling (content >= 2)
  messageSlot: { width },                      // the header width minus 2 x (the end cluster + 12); it may cover the tool options
  aria: { [splitter]: { min, max, now } } }
```

**Unit tests** (`tests/layout-solver.test.mjs`) cover:

- the five width tiers and three height tiers, each from its own dimension of the window box, and `bandMin` moving the minimal step (a band that needs 700 px makes every width up to 723 minimal)
- the 1100×620 case (175% on a 1080p laptop), and the short windows 1920×520, 960×520, 911×485, 1000×450, 853×453, 640×480 and 601×441: the inspector stays docked at wide to narrow width, the timeline is its header, `#viewport` at least 360×200 and the artboard at or above its floor
- the stage floors (monotonic: a window at least W×H never gets less than its floor) over the reference's 33 widths × 29 heights
- 500×340, with no region beyond the window, a stage of at least 360×200 and a vertical rail
- Build at 962×700 (Structure docked, stage 400), 961×700, 901×700, 900×640, 800×600, 640×480 and 500×340 (the Structure strip): `#viewport` at least 360×200 (never 0 wide), the stage header on one line
- the message slot's width (never meeting the view cluster), and the view cluster folding into View at compact and minimal
- the stage insets above and the artboard zoom of the guarantee table in `experience.md` §1.9 (computed with the §3.11.8 formula)
- the timeline's default height (pinned Camera and Scene plus three content slots, capped at 32% of the window in whole rows, never fewer than 2 content slots), resolved once and unchanged by a tab, mode or timeline-mode switch or by added rows
- the left dock folding before the inspector with a user layout that docks Library left
- saved preferences never mutated
- invalid input giving defaults
- floating rects kept out of the transport
- the rail's top-left position identical across modes
- aria min, now and max within bounds

#### 3.11.5 Dock host

- **DOM application.** It applies the solution in **one rAF commit**: `:root[data-tier]`, the region attributes (`data-state`, `data-bottom-span`, `data-rail`), and CSS variables `--shell-left`, `--shell-right`, `--shell-bottom` and `--shell-rail` on `.workspace`. There are no transitions (lint CSS13).
- **Islands.** Each island gets a head with its title or `.ui-tabs`; there is no grip or ⋮ menu at rest. Tabs are the drag handles; a tab's context menu (right-click, Shift+F10) offers Dock left, Dock right, Float (VFX, Library), Fold to strip and Hide. Tabs are rendered here, which moves tab ownership out of `user-library.mjs:19-23`. Tab names and ids are unchanged: `#properties-tab` / `#vfx-tab` / `#library-tab`, `data-vfx-tab`, `role=tab` named Properties, VFX and Library. `app.mjs:6461` still counts clicks on `#library-tab`.
- **Splitters** (from `workspace-layout.mjs:195-448`):
  - `role=separator` with a name ("Resize timeline" is kept)
  - `aria-valuenow`, `-min`, `-max` and `aria-controls`
  - Arrow keys (±12, or ±40 with Shift), Home and End, Enter to reset, double-click (timeline: *Default height*; others: reset), Escape to cancel
  - blur cancels, and `pagehide` flushes
- **Drag-to-dock** reuses the dock-zone hit test (`workspace-panels.mjs:166-199`) with the single calm `.ui-drop-zone` under the pointer ("Dock left", "Dock right", "Add as a tab", "Float here" with Shift). The dragged tab follows the pointer and the origin tab dims; there are no veils, tags, instruction toasts or helper sentences. A 4 px slop and pen `dragSlop` apply, and Escape cancels. New drop targets call `preventDefault` on `dragover` and `drop`, so the global file drop (`app.mjs:5311-5329`) does not also fire.
- **Floating** (VFX and Library only): the tab's context menu › *Float*, or Shift-drop. It uses `transform` on **the floating island only**, never on an ancestor of `#viewport`. Floating islands snap to dock zones within 24 px.
- **Strips** are 40 px icon columns (icon-only, tooltips). Clicking an icon opens that panel as a `.ui-sheet` (`popover="auto"`, transform animation), so `#viewport` never resizes.
- **Keyboard and menu paths** (WCAG 2.5.7):
  - The tab context menu lists only the regions every tab in its group allows.
  - The Layout popover (*View › Layout…*, `Ctrl+Alt+L`) offers presets as dock maps, one position select per panel (Properties, VFX, Library, Timeline width, Tools side), *Reset* and *Save as preset…*. "Hide panels while playing" is not offered (§6).
  - **Keyboard move** (`dock-keyboard.mjs`, `Ctrl+Alt+M`) moves the focused panel between allowed regions with the arrow keys (the target previews); Enter commits and Escape cancels; the instructions live in the tooltip and are announced, never shown as a sentence.
  - F6 and Ctrl+F6 cycle regions (Shift+F6 stays "Remove keyframes").
  - Ctrl+1 to Ctrl+3 show and focus Properties, VFX and Library, and fold them to a strip when pressed again; Ctrl+4 toggles the timeline Full/Strip; Ctrl+\\ toggles Focus. All are verified free in `hotkeys.mjs`.
  - Every one of these is an `actions` entry from `shell-commands.mjs` (`panel-toggle-*`, `panel-hide-*`, `layout-*`, `focus-*-region`), so the menubar, native menu, palette and hotkeys agree.
- **Landmarks.**
  - the top band: `banner`
  - the rail: `nav` "Editor tools"
  - the stage: `main`, with `#viewport` as `role=application` plus a name and a live selection summary
  - docks: `complementary`, with names
  - the timeline: `region` "Timeline"

#### 3.11.6 Store (`layout-store.mjs`)

- **Backends.** On desktop it uses `desktop.getWorkspacePreferences()` and `setWorkspacePreferences()` only, because localStorage does not survive restarts (the origin changes per launch). In the browser it uses localStorage key `stykanimate.workspace-layout.v2`.
- **Saves** are debounced by 200 ms into an ordered promise chain. `flushPreferences()` returns that chain. Failures dispatch `styk-workspace-persistence-error` and show a warning toast.
- **Merge-on-write.** Before each write it re-reads the disk and merges:
  - `shared` and each `modes.*` by newest `stamp`
  - `saved` as a union by id, minus tombstones newer than the item
  - the result is validated against the budget, then written

  Immediately before writing it re-reads once more and compares stamps; on a mismatch it merges again and retries once. This stops "New window" processes from deleting each other's saved layouts in normal use (`completeness-critique.md` §2.8, internal research, not in the repository). **Residual risk:** two windows whose read-merge-write sequences interleave within the same few milliseconds can still lose one change, because the read and the write are two IPC calls. The real fix, an atomic merge in the main process, is an IPC change (§6).
- **Load order.** The layout loads before the first shell commit. `init()` awaits the preferences before `installShell()` applies (today it happens after controllers exist, `app.mjs:6344-6352`), which removes the startup layout jump.

#### 3.11.7 `window.styk.workspace` (the API tests use)

- **Kept:** `sizes` (still exposes `right` and `timeline`, used by `thumbnail-akane-integrated` and `integrated-ux-walkthrough`), `preferences`, `reset()`, `resize()`, `flushPreferences()` and `destroy()`.
- **Added:**
  - `setPreset(id)`
  - `togglePanel(id, state?)` where `state` is `'docked' | 'strip' | 'hidden'` (omitted: the `Ctrl+1–4` behaviour)
  - `fold(id)`, `hide(id)`
  - `dock(id, region, { tabInto?, index? })`
  - `float(id, rect?)` for `vfx` and `library` (with the legacy alias `float('right')` → the right dock's active floatable panel, for `scripts/smoke-preferences.mjs:23`)
  - `floating` (read by `smoke-preferences.mjs:47`)
  - `focus(on?)`
  - `saveLayout(name)`, `layouts`, `deleteLayout(id)`
  - `tier`, `height` and `stageInsets`

#### 3.11.8 `#viewport` and `fittedView()`

`fittedView()` (`app.mjs:1068-1091`) stops reading the `.studio-rail` rect and `quickBar.offsetHeight`, and **drops today's 64/72 px padding**: the solver's stage insets replace it.

```js
const inset = shell.stageInsets();   // published by the solver: {40, 28, 52, 28}; compact {20, 20, 48, 20}; minimal {8, 10, 46, 10}
s = Math.min((rect.width - inset.left - inset.right) / w, (rect.height - inset.top - inset.bottom) / h, 2);
x = inset.left + (rect.width - inset.left - inset.right - w * s) / 2;   // y likewise
```

- This is the formula behind every number in `experience.md` §1.2 and §1.9 (and the reference build's `fit()`); the solver tests assert them.
- **Floating islands and transient sheets never change the fit.** Refitting while an island is dragged would move the artboard under the user. `fitSelection` and Fit use the same insets.
- `isFittedView` and `fittedSnapshot` behaviour is unchanged: a fitted view follows `#viewport` size changes (docking, folding, splitters) until the user zooms or pans.
- **The stage header is a sibling of `#viewport`**, above it, inside the stage island (§3.12). The drawing quick bar (`drawing-controller.mjs:245` appends `.drawing-quickbar` to `#viewport`) **leaves `#viewport` in M3b**, the milestone that removes the canvas HUD: I re-parents the same element (`append()`, never a re-creation; its handlers and sliders are untouched) into the stage header's tool options slot while a Draw tool is active, so nothing floats over the artboard from M3b on and the stage veto has no allowlist. M7b then replaces it with Draw's option descriptors. Until M7b the header's start may exceed its budget in Draw, so `ui-budget` carries one named stage-header allowlist entry in Draw (never a `#viewport` entry), which M7b deletes; no release is cut in between (the release freeze, §6).
- **Inside `#viewport` counts.** Today's canvas HUD (`.canvas-view-controls` with Guides, VFX, Joints, Paths and Zoom, and `.viewport-top`) are children of `#viewport`, so a test that skips `#viewport` would miss the likeliest regression. The budget and chrome tests therefore count every control and box inside `#viewport` and exempt only `#scene`, `#overlay`, the canvas-guides drawing layer while guides are on (non-interactive, `aria-hidden`, drawn like `#overlay`), and `#renderer-error` or `#canvas-empty` while that state is active.
- `tests/shell-layout.browser.mjs` asserts, at every tier:
  - every ancestor of `#viewport` has computed `transform: none`, `zoom: 1` and no `clip-path` or `filter`
  - `#viewport` has no `border-radius`
  - `#scene` and `#overlay` cover `#viewport` exactly
  - no `.stage-head` or `.ui-toast` is a descendant of `#viewport`, and `.canvas-view-controls`, `.viewport-top` and `.drawing-quickbar` (from M3b) are not descendants of `#viewport`; the stage header's top and bottom match the inspector tabs' (±1 px)
  - `#viewport` is at least 360×200 in Animate, Draw and Build at every tier (a 0-wide viewport fails, and would also break `fittedView`), and the artboard at fit is at or above the stage floor for the window size (outside Build)
  - `document.documentElement.scrollHeight === innerHeight` and `scrollWidth === innerWidth`, also after `window.scrollTo(0, 1)` and after focusing each hidden host (the page never scrolls the shell by a pixel)
  - the band's `scrollWidth <= clientWidth` and every `#window-controls` button inside the window, at every width from 500 to 1920 (the 601–661 band in Animate, Draw and a camera or movieclip session included)
  - the rail is fully inside `.workspace` in Animate, Draw and Build (from M1)
  - `#play-button`'s rect is identical across Animate and Draw × Simple and Advanced at the same window size and timeline height
  - nothing overlaps the artboard at fit except `#scene`, `#overlay` and an active `#renderer-error` / `#canvas-empty` card: `#viewport`'s other children count; the artboard keeps ≥ 8 px of clear space inside `#viewport`; the message and the view cluster never intersect, and each of their buttons is the element at its own centre (`elementFromPoint`)

### 3.12 Stage chrome, `uiContext` and canvas chrome

- **The stage header** (`.stage-head`, `role=toolbar` "Stage", `--stage-head-h` 40px) is a sibling of `#viewport` inside the stage island (`main.shell-stage`), **above** it, at `--z-canvas-hud`, so `hotkeyScopes()` (`app.mjs:5482-5494`) never treats it as the canvas and a wheel over it never zooms. `stage-head.mjs` (I) owns three slots:
  - **start**: the location crumb (`.ui-crumb`: "Scene 1 960 × 540", running `scene-settings`; inside a session the scope path, whose first part runs `movieclip-done` or `camera-done`) when the active tool has no options, otherwise **the tool options bar** rendered by `tool-options.mjs` from the tool's option descriptors (§0.1);
  - **centre**: **the message slot**, the `#toast` host (`ui-toast.mjs`), one message at a time (§3.3). Its width is capped at the header minus twice the end cluster's width and a 12px gap, so a centred message never meets the view cluster; when the tool options leave it less room it covers them until it closes (`data-msg-over`);
  - **end**: **the view cluster**, today's view pill re-parented with its ids and element references (`#handles-button`, `#paths-button` with `.path-options-button` as a split button, `#canvas-guides-button` with `#guides-options-button` as a split button (revision 4.1: the button toggles the grid, the chevron opens the Grid and guides popover), `#vfx-preview`; in Build `builder-static-handles`, `builder-highlight` and `panel-toggle-timeline`), then `#zoom-label` (the zoom menu) and Fit (`zoom-reset`). View toggles are quiet when on (`data-quiet`). **They stay at every tier** (revision 4.1; today's view pill does too); at compact and minimal width a message may cover them while it shows, and in Build Highlight part and Static handles fold into *View › Build* when the header is full (today's builder View ▾ is a third click too). The view-option popovers (Grid and guides, Motion path settings, Onion) apply live and close on the next click elsewhere, which still acts.
- **Nothing interactive inside `#viewport`.** No lanes, no lane solver, no HUD pills, no floating view pill, no scope crumb, no selection pill, no corner group. `fittedView()` reads the solver's insets (§3.11.4: 24/24/28 tall, 12/12 short, 8/8 low), which are pure clearance. HUD-like hosts move with their ids: `#viewport-hint` stays hidden (the first-run hint is a message); `#chain-controls` and `#polygon-controls` become Build's tool options while a chain or polygon is being drawn (M7a); the tweener readout becomes the Tweener's tool options (M7g); `#playback-fps` is a passive counter in the top-right of the canvas during playback, updated at most every 250 ms; low FPS does not post a message. `#preview-quality` sits beside zoom and `#preview-badge` stays in the hidden status log; the compatibility renderer is announced once as a message and detailed in Help › Performance.
- Canvas-anchored overlays stay inside `#viewport`: `#renderer-error` and `#canvas-empty` (centred cards), the canvas-guides layer, and the drawing palette at the pointer (until M7b shows it as a `ui-popover`).
- **Corner caps.** One `::after` on the stage island (four radial-gradient layers in `--surface-field`); `#viewport` stays rectangular.
- **View commands** keep their ids and element references for their controllers (`app.mjs:6330-6338`). Their settings open from the split button and the grid toggle: `.path-options-button` opens `#path-popover` and `#canvas-guides-button` opens `#canvas-guides-panel` (`Ctrl+'`), both anchored to their buttons; the View menu lists them as an index; M7g ports them to `ui-popover` with their ids. The camera frame and other figures' joints are View menu rows and keys, as today.
- **The selection menu** is one registry list with three openers: right-click on the canvas, **Shift+F10 or the Menu key on the focused `#viewport`** (new keyboard `contextmenu` path), and `#object-actions` in the inspector header.
- **No UI-drawn selection marks.** The joint ring, hover halo, hover bounds, selection bounds, name tags and drag readout of revision 2 are **not built**: the canvas shows what today's renderer shows. The `#overlay` 2D pass keeps today's marquee, pivot, polygon draft and sprite placement, restyled through `canvasChromeTheme`.
- **Joint hit radius, body click, right-click (in scope; audit F2 and F5).** `pick()` (`minRadius: 8` at `app.mjs:2218,2425,2641`) moves to a 24 px radius per handle, limited to half the distance to that handle's nearest neighbour, ties to the nearest centre. A click on a figure's body selects the figure; right-click never targets hidden or zero-width joints. **Acceptance gate:** `tests/joint-hit-radius.browser.mjs` on the dense Pivot corpus (no handle pickable at 8 px becomes unreachable) plus behaviour tests. Nothing new is drawn.
- **`uiContext`** (`ui-context.mjs`) is pure plus a memo keyed by `(revision, tick, selection token, mode, range, timeline mode)`. It returns `target { kind, name }`, `numbering` (Simple frames or Advanced ticks with converters; used by the readout, the export trim and the range inspector) and `range`. It has no scope, crumbs or key state.
- **The status bar is visually removed.** `.statusbar` becomes a visually hidden `role=log aria-live=polite` region that keeps `#status`, `#status-dot`, `#object-count`, `#selection-summary`, `#timeline-summary` and `[data-action=performance]`; `#renderer-label` and `#render-time` stay hidden **outside** it (§3.2). The log is readable in Help › Performance. `#stage-size` moves into the Scene inspector (a JS-created contract id from M4, §4.1). **Every visually hidden host** (the log, `#renderer-label` and `#render-time`, and the compatibility hosts `#menu`, `#toast`, `#dialog`, `#insert-dialog`, `#builder-bar`) uses the fixed pattern of `.ui-visually-hidden` (`position: fixed` at the window's origin, 1 px, `clip-path: inset(50%)`) or `hidden`, so none of them extends the document below the shell (revision 3.2's reference was one pixel taller than the window, which let `scrollTo` or a focus move the whole shell).
- **First run.** Today's load selects the first figure (`editor.mjs`, `selectedUid = objects[0]`), so the inspector opens on Bubble; nothing in the core load changes. One message, "Drag a red joint to pose", shown once per install; its seen state is the editor setting `hintsSeen` (`{ pose: true }`, added in M0). No coach cursor, steps card or IK tip.
- **Empty scene.** An empty artboard with nothing over it; the Scene is in the inspector. The rail's *Add* is the home of adding a figure; `#canvas-empty` appears only while files are dragged over the window.

### 3.13 Inspector rendering model

- **Contract kept** (`inspector-dom.mjs`):
  - `updateInspectorDOM(root, html, { preserveDisclosure })` is the only writer of `#inspector`.
  - Node identity is `id`, `data-property`, `data-section`, `data-polygon-index` and `data-inspector-owned`.
  - Owned subtrees (brush preview, pressure curve, drawing sliders, camera motion graph) are never touched.
  - A focused input keeps its value, and `<details open>` is preserved.
- **Section descriptors.** Contexts return descriptors, and `inspector-kit.mjs` renders them to an HTML string using `.ui-*` classes:

  ```js
  { id: 'transform', title: 'Transform', place: 'core' | 'titled', open: (ctx) => boolean /* titled only: auto-open */, action: { command, icon } | null, rows: [
      { kind: 'number', key: 'root_x', label: 'X', unit: 'px', value, precision, displayPrecision, step, field: 'root_x' },
      { kind: 'slider' | 'switch' | 'swatch' | 'segmented' | 'select' | 'stepper' | 'actions' | 'owned', … } ] }
  // core sections are always open (2-3 per context); titled sections are collapsible, closed unless open(ctx) is true or the
  // person opened them (editor setting inspectorSections), and never a generic More. A context also returns
  // quick: ['mirror', ['layer-front', 'layer-back'], ...] (registry ids in at most three groups, at most six) and
  // scope: { label, stop } while an edit reaches beyond the selection (Edit together).
  ```

  The renderer guarantees these outputs:
  - `data-section` on each `<section>` or `<details>`
  - on number rows: `data-property-row`, `data-property-scrub` on the label, `data-property`, `data-property-value`, `data-property-precision`, `data-property-display-precision` and `data-property-step`
  - the legacy `data-field` where it exists today (unit tests assert `data-field="thickness"`, `"scale"`, `"joint_angle"` and `"joint_length"`)
  - every existing control id (`#segment-color`, `#rig-position`, `#static-joint`, `#figure-color`, `#background-color`, `#node-is-ik`, `#node-ik-*`, `#apply-range-movement`, `#figure-name`, `#builder-joint-name`, `#movieclip-next-keys`, …) and property (`data-property=figure_z_order`, kept for `figure-z-index.browser`, in the figure More › Arrange)
  - `data-inspector-owned` hosts for imperative widgets

  It never emits `data-property-key`, `data-property-nav` or `property-key-controls` (`tests/property-controls.test.mjs:66-68`), and it has no key-state output at all: the inspector shows no key diamonds.
- **`inspectorView(opts)`** keeps its export and signature and returns the HTML string. Its unit tests (`property-controls`, `style-opacity`, `connector-properties`, `rig-asset-boundaries`, `movieclip-presence`) keep passing with **unchanged expectations** except where a contract changes deliberately.
  - Sub-modules move from HTML to descriptors in their milestones: `ik-view`, `movieclip-ui`, `spatial-controls` and the camera's commands (`camera-view`, now part of the camera context) in M4; `rig-controls` in M7a; `camera-motion-ui` in M7e; `drawing-view` in M7b; `vfx-clip-inspector` in M7d.
- **Header** (`inspector-header.mjs`, track D; the only writer from M4) writes through `dom-write` the target's **name** (double-click renames), an optional kind glyph, **one menu button** (`#object-actions`: the selection, joint, part, scene, clip or camera menu for the context), **the scope line** while Edit together is on, and **the quick actions row** (`quick-actions.mjs`: registry entries, tooltips with keys and Shift variants, one tab stop with arrow keys, pins from the layout store), plus `#inspector-context` and `#inspector[data-selection-kind]`. No crumbs, meta, chips or badges. A figure shared by several instances is handled where it matters, in the Build exit dialog (*Update all 3 Bubbles*, `experience.md` §5.2); the header says nothing about it.
- **Changes** go through `inspector-bindings.mjs`, a declarative `{ selector → handler }` map with the same effects as `app.mjs:5021-5288`, including `#apply-range-movement` → `state.applyRange`, whose visible owner is the range inspector's *Edit together* switch (`#range-edit`, M5); the checkbox mirrors it.
- **No render during playback, and no render while hidden** (§3.2). The measured target is 0 inspector mutations during playback.
- **No key state in the inspector.** Keys are created as today (posing at a frame, *Add frame*) and managed in the Advanced timeline. The revision 2 plan for field diamonds (and the "has key at tick" read API it needed) is withdrawn.
- **Titled sections** (revision 4) replace the one More: each is a `section[data-collapsible]` with a `.ui-section-toggle` (`aria-expanded`, `aria-controls`); `preserveDisclosure` keeps the open state across renders and `inspectorSections` remembers it per context kind. Auto-open rules (`open(ctx)`): Connection while the figure is joined, Parallax while on, IK's options while Use IK is on, Connector on connector joints, Weighted joint and Angle-driven path on parts that have them, Drawing sets when a joined bank exists. The audit's inspector budget (revision 4.1, with headroom): ≤ 30 controls (28 used), ≤ 6 quick actions (5 defaults used per context, the sixth kept for a pin), ≤ 5 open and ≤ 8 titled sections at rest, and **each workspace's default inspector fits at 1440×900 without scrolling**. A section has **at most two title actions** (revision 4.1 makes the two explicit: several figures' Selection has Rotate 15° and Centre; the camera's Transform has Copy camera and Paste camera; every other section has at most one).
- **Contexts added or completed in revision 3.1** (`experience.md` §5.1): the **movieclip instance** (today's `movieclipInspector`: the Movieclip menu with *Edit movieclip*, Playback with today's four modes, Start, Speed, Transform, and More › Appearance, Arrange › Z-index, Extend › Next keys + Add (`movieclip-extend`), Drawing sets), the figure's **Z-index** in More › Arrange (the only Arrange control there: today's four `layer-*` buttons become the selection menu's Arrange ▸, and the effect switches stay in the VFX tab), **several figures** (X, Y, W, H and one *Align* menu button with the six `align-*` entries), the camera's More › Framing (Level, Fit view, Centre, Centre X/Y, Match, Guides) and Figures (Apply to figures), and Build's More › Attachment › *Weighted joint* (`rig-weighted`, with its `rig-weighted-*` fields). **Revision 3.3** adds the camera's **Preview** section (the monitor, `data-camera-monitor`, paused while hidden or playing), the camera's More › Motion (today's motion editor: preset and *Add*, the clip list, *Bake all*) and the **camera motion clip context** (Timing, Motion; More › Graph, Noise, Fades; its header menu is the camera motion menu), all in M7e; the layer contexts' More › Parallax (today's parallax panel) in M4; and Draw's complete tool groups, Filters › Invert and More › Cel › Filtering and *Resample…* in M7b. The 3D rig's **Pose │ Rotate** stays an `aria-pressed` button pair named "Pose" and "Rotate" (the tested role), styled as the segmented control's button-group form.

- **Titled section open state** persists per context kind in the editor setting `inspectorSections`, which replaces today's per-document-token disclosure key. The revision 3.1 and 3.3 paragraphs above say "More ›" for what are now titled sections of the same name (Arrange is a core section of the figure; Framing, Motion clips, Graph, Noise, Fades, Parallax, Cel, Second colour, Connector, Stretch and IK defaults are titled). The camera's Level, Centre, Reset and Guides (and its Motion ▾) and a motion clip's Preview, Mute, Duplicate, Bake and Delete are quick actions; Fit view is the Framing section's first button (revision 4.1: today it is a third click too); the camera's Copy and Paste are Transform's title actions, and Transform ends with the opt-in *Ease new keys* switch (off; this session only).

### 3.14 Timeline shell

- **Shared header.** `timeline-header.mjs` renders into **static slots** that M3a adds to `.timeline-toolbar` in `index.html`, **14 controls in three clusters** in both modes (revision 4; revision 3 had 9 and a larger ⋯ menu):

  | Slot | Contents |
  |---|---|
  | `[data-slot=start]` | `#timeline-workflow` with `[data-timeline-mode=simple|advanced]` (an `aria-pressed` group; moves into the ⋯ menu at compact), and the Add frame button (accessible name exactly **"Add Frame"**, visible "Add frame", tooltip "Add frame · A") |
  | `[data-slot=transport]` | **First frame**, previous, `#play-button` (soft round disc), next, **`#loop-button`** (a quiet toggle button, on by default as today), the readout `#time-display` (today's MM:SS:FF, "00:01:03"; its tooltip names the frame; a click opens Go to frame, whose Show switch offers frames, revision 4.1) and **`#fps`** (an inline field "24 fps"; it folds into the Scene inspector's Rate at compact width, 800px, as today's app hides it; revision 4 folded it at 1180px) |
  | `[data-slot=end]` | **Onion as a split button** (`#onion-button` and `#onion-settings-button`, both buttons, as today), **`#timeline-audio`** (a quiet toggle button with a has-audio dot) and `#timeline-menu-button` (⋯) |

  - **The ⋯ menu** holds only rare rows: *Last frame*, *Previous key*, *Next key*, *Default height* (`timeline-reset-height`); at compact and minimal width *Simple/Advanced timeline*; at minimal width *First frame*, *Loop playback* and *Audio* first (their buttons fold there, tier aliases); at the low height tier *Timeline…* first.
  - **The layer list's header** (`.sheet-label-head`, Advanced) holds the title "Layers", **New layer** (a split button: `timeline-new-layer` adds a layer and opens its name for typing; the chevron adds a drawing layer) and **Find layers** (`timeline-find-layers`: today's `layerSearch` field replaces the title while it has focus or text).
  - **The ruler's tools** (the ruler's right end, over a fade, never over cells): `#timeline-zoom` (a quiet slider, "Timeline zoom"), *Fit timeline* (`timeline-fit-frames`, today's `fitFrameRange()`) and `#expand-timeline` (a toggle button, "Tall timeline"). In Simple the zoom and Fit sit above the filmstrip's top-right end (today's floating zoom, off the cards).
  - The components stop injecting after `#timeline-workflow` (`layer-timeline.mjs:44-46`). They receive a `header` API: `setRange(range | null)` (drives the range inspector and the Simple frame bar), `setZoom(value)`, `setOnionRange(before, after)`, `setHasAudio(boolean)`.
  - `#timeline-summary` and `#selection-summary` move into the hidden log.
- **Height.** `sizes.bottom` is the only timeline height (§3.11.2); `null` is the default height, resolved once. The header never sizes the island; content scrolls inside it. At minimal `timeline-host.mjs` moves the body root into a bottom-sheet host (`append()`, never a re-creation) for *Timeline…* and back on close, so the canvas painter, its row model and its hit tests are the same objects.
- **Engine kept.** These stay unchanged:
  - `Timeline` (canvas grid) and `SheetFilmstrip` (virtualized cards)
  - the scrub pipeline (`pendingScrub`, `_flushScrub`, `canScrub`, `onScrub*`)
  - `_changeNeedsPaint`, `_cachedOffsetX`, `_extent` read batching, `MAX_SCROLL`
  - the gesture machines, the hotkey adapter, the VFX `Timeline.prototype` hook points
  - the thumbnail queue and 32-entry LRU, `thumbnailVisualChange`
  - the row model: `ROW = 32`, `HEADER = 32` and their duplicates (`vfx-clip-timeline.mjs:7`, `timeline-organization.mjs:34-36`, `camera-motion-timeline.mjs:8-12`, `audio-timeline.mjs:187-207`)
  - the public API used by `app.mjs` and the `window.styk.timeline.*` members tests poke
- **Advanced paint** changes only in drawing and tokens; **keys stay round, as today**:
  - keys: 9px circles in the row colour with a 1px `--sheet-key-outline`; blank keys and cel starts hollow in the concept line token
  - spans: a 12px capsule at 12% of the row colour; tweens a 1.25px arrow; the final hold a neutral capsule; Camera and Scene rows keep today's key colours (Camera blue: `--sheet-camera-accent` resolves to today's camera blue; Scene violet) and draw neutral spans
  - cels and effect clips: neutral blocks (`--sheet-cel`, `--sheet-cel-line`); the active cel outlined in `--accent-line`
  - the grid: a `--sheet-line` every 5 frames; single-frame ticks only when a cell is ≥ 24 px
  - the ruler numbers every 5 frames across the whole visible span, as today, past the last frame too (regular weight over the `--sheet-hover` tint, still `--sheet-muted` at 4.5:1); a label hides only on real overlap with the playhead tab (**no End marker, hatch or draggable end**; there is no set-length command)
  - Camera and Scene stay pinned under the ruler; the content rows scroll beneath them in a real scroll region (the thin themed scrollbar stays; a soft fade at the bottom edge while rows are below), so every row and its eye and lock can be reached
  - the playhead: a 1.5 px line under the keys and a `--sheet-playhead-tab` tab with white 600 11 px numerals
  - onion ranges on the ruler whenever onion is on, as today (`onion-timeline-range.mjs` keeps `overlay.hidden = !enabled`), restyled: a 2 px band in each saved colour from the playhead to the range end and a small end mark that stays today's slider ("Onion frames before/after", 24 px hit area)
  - the label column: one marker per row (type icon, colour dot, or dot with a muted brush glyph after a drawing layer's name); **eye and lock on every row at rest** in their own column (revision 4.1: quiet `--text-3` glyphs, as today's 35% icons; full contrast when not at their default, a hidden layer's eye-off and a locked layer's lock); a grip appears at the row's start on hover (drag to reorder; the row menu's Move up and Move down are the keyboard path); an effect row shows *Visible keys* on hover; the layer list's header holds *Focus selected layers* (today's one-click header toggle, revision 4.1), New layer (in Draw its + makes a drawing layer) and Find layers (above), and *Focus selected layers* is also a row menu row; an uncoloured layer's marker and keys use `--sheet-ink`
  - **direct manipulation (revision 4):** the selected (and hovered) exposure draws a 3px `--accent-line` grip at its end in a 24px hit area over today's edge-drag gesture (no new gesture, only its affordance); while keys are dragged the ruler shows "12 → 14" beside the playhead tab; double-click keeps today's meanings (a key: its easing popover with presets, handles and numbers; an empty cell: a key); a cel wide enough shows a thumbnail of its drawing (behind the thumbnail worker's gate, like the filmstrip's)
- **Frame menu** (`showTimelineMenu` adapter): Copy, Paste and Cut frames (the scope-aware `copy`, `paste`, `cut`), *Change easing…* (opens the range inspector's Easing), Insert inbetween…, Make movieclip… (`movieclip-range`), Extend (`extend-keyframe`), Insert blank key (`insert-blank-key`), Insert copied key (`insert-copied-key`), the drawing-row commands, **Remove keys** (`clear-keys`, `Del` as today) and **Delete frames** (`delete-frame`, which in Advanced calls `removeFrames()`, the `remove-frames` key `Shift+F5`); *Unlock layers* replaces the editing rows on locked layers. In Advanced the range inspector's select and curve (`keyframe-easing-view.mjs`) are the one easing editor; in Simple the card menu's *Change easing…* opens the easing popover (`keyframe-easing-popover.mjs`).
- **The other timeline menus** keep today's `showTimelineMenu` lists, regrouped (experience §5.7): the **row menu** (Rename, Layer colour ▸, Move up, Move down, Duplicate layer for a drawing layer (today's *Duplicate drawing layer*), *Focus selected layers* / *Show all layers*, Delete; Hide and Lock are the row's eye and lock; the Simple *Layers…* popover's rows open the same menu), the **background menu** (today's `view:true` list less *Fit animation* and *Find layers*: Fit selected frames, Reveal playhead, Show all layers on canvas, Unlock all layers, Select Camera, Select Scene), the **camera motion menu** (Preview motion, Mute or Enable motion, Duplicate motion, Bake clip range, Delete motion; Unlock Camera while locked; the motion clip context's `⋯` opens the same menu object) and the **card menu** in `sheet-filmstrip.mjs` (Change easing…, Insert inbetween…, Copy, Cut, Paste frames, Delete frames; Unlock layers on locked layers). *Add Frame* leaves both menus: its home is the header.
- **Not in this programme (phase 2):** collapsible group bands, a shared row-layout function, 40 px audio rows and a Simple audio lane (hit-test and paint-budget changes need their own milestone).
- **Simple filmstrip.**
  - **The Simple frame bar** (revision 4.1) replaces today's 154 px sidebar in the label column's width, in one left-aligned column: "Holds 0.25 s · plays as 48" (how long the selected frame holds; where you are is the header's readout, so there is no second frame count), Inbetweens (a stepper for every selected card), Easing (a select showing the current easing), Copy, Paste and Delete frames, **Edit together** (the same labelled switch as Advanced's range inspector, `toggle-range-edit`), and `#layers-button` ("Layer · ● Bubble ▾", the Layers popover). The current card and a hovered one carry a caption in words, "6 · 5 inbetweens" (`.ui-frame-count`); at the short height tier the first line drops.
  - The strip scrolls sideways (thin themed scrollbar) when the cards do not fit. Cards are sized to the body (104–168 px; today's `MIN_CARD`/`MAX_CARD` clamp stays the outer bound) with a thumbnail in the artboard's aspect framed as today, the number and **one neutral duration bar** (the current frame's in blue) that is the `role=slider` "Frame N inbetweens" with a 25 px hit area; its count is the current and hovered card's caption ("6 · 5 inbetweens") and the tooltip. No "+N", easing pins, partial marks, cel marks or ghost card.
  - **Figure framing (gated).** Thumbnails frame the union of the figures' bounds over the whole animation (10% margin), computed in the thumbnail worker from already-evaluated frames, debounced and quantised so the framing only grows in steps, with its own framing generation so posing never regenerates every card. Gate: `benchmark:dense` unchanged and a thumbnail-churn metric while dragging a joint (≤ 1 regenerated card per pose edit). If the gate fails, cards keep today's artboard framing.
  - The working copy (docs/SIMPLE-FRAME-DRAFTS.md) shows only an "edited" dot on the current card's number (`Editor.frameDraft` dirty); behaviour unchanged.
  - **G1 fix:** a transform-only playhead element; during playback `render()` is not called per seek, and auto-scroll uses cached geometry.
- **Menus** go through `showTimelineMenu`. The camera motion, VFX clip and audio clip row menus keep their items and gain the kit look.

### 3.15 Export

- **`export-request.mjs`** (pure): `buildExportRequest(uiState) → { category, format, width, height, start, end, quality, smoothing, dither, videoQuality, bitrateMode, bitrate, codec, audio, vfw, repeat }` and `validateExportRequest(request, capabilities)`. The rules come from `export-panel.mjs:64-119`.
- **`exportOptions()`** stops reading DOM ids and label visibility (`app.mjs:3489-3530`, including the `closest('label').hidden` quality fallback at `:3496`). The export actions receive the request.
- **Equivalence gate.** Before the sheet is restyled, the same fixture exports produce byte-identical PNG, SVG and GIF output, and identical MP4 frame count, size and duration, before and after the request refactor.
- **`export-sheet.mjs`** (replaces `export-panel.mjs`):
  - a calm two-column lg dialog (880 × 452): a sunken preview pane (live preview, the trim strip, "Frames 1–48") and the form; at compact and minimal a full-window single column with the preview as a 48 px strip; no lime, no icon badge
  - **one Format segmented control** matching today's `categories` (`video`, `animated`, `frames`, `editable`, `[data-category]`), and `#output-format` (More options › Type) listing the formats of the chosen category, so every existing `export-*` command stays reachable; the primary names the format ("Export MP4")
  - editable formats (`.stkz`/`.stykmov`, `.piv`, `.stk`) replace Size, Quality and Sound with a Type select and one line
  - Size presets (YouTube, Original, Discord, Custom) in one select; a preset whose aspect differs from the artboard is disabled with a reason, because letterbox or crop would change the pipeline (§6)
  - the `ui-range-strip` (ink ends), whose handles write `#export-start` and `#export-end` **converted from the active numbering** (Simple frames snap to their ticks; the caption reads "Frames 1–8 · plays as 48")
  - *Repeat: Forever │ Once* for GIF and Transparency (disabled with a reason) in More options
  - **no destination row**: export still saves through `saveVideoExport` after encoding (the OS dialog chooses the place); the success toast shows the saved path with *Show* (it opens the folder)
  - choices remembered globally in the editor setting `exportPreferences`
  - kept hooks: `#export-submit`, `#output-format`, `[data-category]`, `#export-width`, `#export-height`, `#export-start`, `#export-end`, `#export-validation`, `#export-quality`, `#export-resolution`, `#export-smoothing`, `#export-video-quality`, `#export-bitrate-mode`, `#export-video-bitrate`, `#export-avi-codec`, `#export-mp4-codec`, `#export-gif-dither`, `#export-vfw-*`
- **Progress.** It stays **inside the export sheet** (modal), keeping `#export-progress` and `#cancel-export`. Escape and × ask "Stop exporting?" through `beforeClose`. Success raises a toast ("Exported kick-combo.mp4 · 3.4 MB · Show"). Moving progress into a non-modal Task toast is a product decision (§6), because export snapshots `editor.report` and checks `getRevision` (`app.mjs:3577`).

### 3.16 Localization

- **Explicit attributes everywhere.** Every static string in `index.html` gets `data-i18n`, `data-i18n-aria-label`, `data-i18n-placeholder` or `data-i18n-tooltip`. Icon-plus-label buttons wrap their label in `<span data-i18n-slot>`, which avoids `caption()` rule 3 appending a duplicate span. Kit components take `labelKey`.
- **`APP_CHROME_BINDINGS`** (`localization-bindings.mjs:54-76`):
  - M0 deletes its stale rows: `.titlebar > [data-action="open"]`, `.left-panel …`, `.right-panel .panel-tabs …`, `.panel-bottom …`, `#layer-search`, `#layer-list`.
  - M3b converts the live rows to attributes on the new markup, then removes the table, updating `tests/localization-settings.browser.mjs` in the same commit.
  - `applyMenu()` stays until every menu renders from the registry (M2), then becomes a no-op for kit menus.
- **Catalog fragments** remove the hot spot on `en.mjs`. In M0, `src/locales/en.mjs` keeps its literal and spreads frozen fragments:
  - `en-shell.mjs` (M1, M3b), `en-overlays.mjs` (M2), `en-inspector.mjs` (M4), `en-timeline.mjs` (M5), `en-dialogs.mjs` (M6)
  - `en-builder.mjs`, `en-draw.mjs`, `en-library.mjs`, `en-vfx.mjs`, `en-camera.mjs`, `en-audio.mjs`, `en-aids.mjs` (M7a–g)

  Each fragment is owned by its track. `tests/locale-fragments.test.mjs` fails on any key defined twice. Italian stays partial (the existing test requires every `it` key to exist in `en`, with the same placeholders).
- **Direction.** The shell, timeline and canvas stay LTR (`localization-bindings.mjs:111-115`, `tests/localization-native-app.browser.mjs:43`). Text containers inside dialogs and menus may take `dir` from the locale later; that is a separate decision.
- **Canvas strings** (camera overlay, gizmos, rig guides, construction feedback, row labels) move to catalog keys in their milestones.
- **Reuse existing keys.** Registry entries and ported controls keep the existing catalog keys that the 26 native Pivot catalogs map (§3.9); `tests/native-catalog-keys.test.mjs` guards it.

### 3.17 Telemetry

- **`ERROR_MODULES`** (`src/telemetry-schema.mjs:72`) only lists `app.mjs` among UI files. Frames from new files are dropped, and code moved out of `app.mjs` would lose diagnostics.
- **In one M0 commit**, add every planned basename:
  - `overlay-manager`, `ui-menu`, `ui-popover`, `ui-tooltip`, `ui-toast`, `ui-dialog`, `anchor-position`, `command-registry`, `command-catalog`, `command-palette`, `roving-focus`, `toolbar-overflow`, `dom-write`, `ui-invalidation`, `ui-context`, `canvas-chrome-theme`, `font-loading`
  - `layout-schema`, `layout-solver`, `layout-store`, `panel-registry`, `dock-host`, `dock-keyboard`, `shell-commands`, `topbar`, `workspace-mode`, `stage-chrome`
  - `inspector-bindings`, `timeline-host`, `export-flow`, `app-dialogs`, `inspector-kit`, `inspector-header`, `timeline-header`, `export-request`, `export-sheet`

  Each is added as `<name>.mjs`.
- **Release gate.** `cloud/worker.mjs` validates snapshots with this schema and **rejects a snapshot whose error frame names an unknown module** (`telemetry-schema.mjs:164`). The cloud worker must therefore be deployed with the new list **before** any app build that reports these frames ships. The change is additive, so older apps still validate. Deploying is not authorized for agents; it is listed in §6 as a release precondition. **The M0 `ERROR_MODULES` commit lands only once the owner has scheduled that deploy**; until then new modules simply report no frames, and the release freeze (§1 rule 6) keeps any build from shipping.
- **`tests/shell-contract.test.mjs`** also asserts that every `ERROR_MODULES` name found in `src/` or `desktop/` resolves to exactly one file (basename uniqueness).
- **Unchanged.** Action names, and therefore `telemetry.action` buckets and the `ACTIONS` map (`telemetry-core.mjs:49,110-113`), stay the same. INP and LoAF baselines will shift, so the redesign release must be flagged on the dashboard.

### 3.18 Packaging and serving

- **No `package.json` change is needed.** New files live under `src/` and `assets/`:
  - `build.extraResources[0].filter` already covers `src/**/*` and `assets/**/*`
  - `build.files` (the asar: `desktop/**`, `package.json`) needs only the `main.cjs` colour literal
  - `desktop/web-host.cjs` serves only the `src`, `vendor` and `assets` segments and root `.html`, `.css`, `.svg`, `.png` and `.ico`, with a `.woff2` MIME type
  - `scripts/verify-package.mjs` hashes `src/`, `vendor/` and `assets/`
- **Never add a root-level JS, font or other file.** The desktop host (`desktop/web-host.cjs`, which `npm run serve` also uses) serves only `src/`, `vendor/`, `assets/` and root `.html`/`.css`/`.svg`/`.png`/`.ico` files, and a packaged app also leaves out `tests/` and `artifacts/`: a misplaced file gets a 403.
- **Proof.** In M0 and M8: `npm run pack && npm run verify:package && env -u ELECTRON_RUN_AS_NODE npm run test:desktop:packaged`. Also check the packaged renderer console for 403s on `assets/fonts/*` and `src/styles/**`.

### 3.19 `window.styk` additions

- `styk.ui = { overlays, commands, palette, toasts, tooltips, context: () => uiContext() }`
- `styk.workspace` is extended (§3.11.7)
- `styk.studio` now points at the `workspace-mode` controller (no test uses it)

Every existing member used by tests stays: `editor`, `state`, `actions`, `settingsUI` (81 files), `timeline` (49), `drawing` (39), `builder` (14), `vfx` (11), `library`, `properties`, `onionController`, `tweener`, `hotkeys`, `localization`, `telemetry`, `privacyUI`, `ready`, …

---

## 4. Contracts

### 4.1 Static ids in `index.html` (77 today)

**Rule: all 77 ids stay; 67 of them stay static in `index.html`.** Ten ids move with their controls into JS-rendered surfaces and become **JS-created contract ids** in `tests/fixtures/ui-contract.json`, removed from the static list in the commit that moves them: `#fps` and `#stage-size` (the Scene inspector, M4), `#range-edit` (the range inspector's More, M5), and `#chain-controls`, `#chain-count`, `#chain-finish`, `#chain-cancel`, `#polygon-controls`, `#polygon-count`, `#finish-polygon` (the inspector's first section while drawing, M7a). The other exception is a "reader-bound" id, which may be removed only together with its reader, in the commit named here. `tests/shell-contract.test.mjs` is updated in each of those commits.

| Group | Ids (test and script files) | Readers | Placement in the redesign |
|---|---|---|---|
| Canvas | `viewport` (104), `scene` (22), `overlay` (27), `artboard` (1) | `app.mjs` (resize, `worldPoint`, pointer, `placeArtboard`), builder-mode, sprite-placement, drawing-controller, canvas-guides | Stage island content. Never moved. |
| Hidden inputs | `file-input` (61), `media-input` (1) | `app.mjs` | Unchanged |
| Hosts | `dialog` (37), `dialog-content`, `menu` (19), `toast` (5), `insert-dialog` (1), `asset-list`, `sample-list` (1), `close-insert`, `insert-title`, `insert-movieclip-title` | `app.mjs`, studio-shell/workspace-mode, builder-mode, rig-test-ui, movieclip-ui, asset-library | `#dialog` is the compatibility instance; `#menu` is the app, context and zoom Menu; `#toast` is the toast host; `#insert-dialog` (with `#asset-list`, `#sample-list`) is a hidden compatibility host until M7c ports `asset-library.mjs`; the Library is its own tab, so the Add menu has no library row (`experience.md` §3.3). Every host here is `hidden` or uses the fixed visually hidden pattern (§3.12) |
| Panels | `inspector` (32), `inspector-context`, `object-actions`, `vfx-panel` (3), `timeline` (15), `animation-timeline`, `builder-outliner` (2) | many | Moved into islands with `append()` |
| Transport | `play-button` (27), `loop-button`, `time-display`, `fps` (2), `timeline-zoom` (2), `range-edit` (1, plus 19 video capture scripts), `onion-button` (2), `onion-settings-button`, `timeline-audio` (1), `expand-timeline` (2), `timeline-workflow`, `timeline-summary`, `selection-summary` | `app.mjs` / timeline-host, controllers, audio-timeline, localization | The header (`play-button`, `time-display`, `onion-button`, `timeline-workflow`); the Timeline ⋯ menu (`loop-button`, `onion-settings-button`, `timeline-audio`, `timeline-zoom`, `expand-timeline`; static markup until M5 renders the menu, then JS-created contract ids); the Scene inspector (`fps`, JS-created from M4); the range inspector (`range-edit`, JS-created from M5); the hidden log |
| Canvas view | `zoom-label` (3), `handles-button`, `paths-button` (1), `canvas-guides-button` (2), `vfx-preview` (7), `tweener-button` (1), `open-insert` (3) | Controllers constructed with element references (`app.mjs:6330-6338`) | The stage header's end (`zoom-label`, `handles-button`, `paths-button`, `canvas-guides-button`, `vfx-preview`, re-parented with their ids; the View menu indexes them); the rail (`tweener-button`, `open-insert`) |
| Builder | `builder-bar` (5), `builder-title`, `builder-done` (5), `builder-menu-edit`, `builder-menu-arrange`, `builder-menu-view` | builder-mode, builder-toolbar | `#builder-done` in the band's primary slot (keeps `data-workspace-mode=animate`); the bar and its menus a hidden compatibility host until M7a |
| Stage overlays | `viewport-hint`, `canvas-empty`, `renderer-error` (9), `playback-fps`, `preview-quality`, `preview-badge`, `chain-controls`, `chain-count`, `chain-finish`, `chain-cancel`, `polygon-controls`, `polygon-count`, `finish-polygon` | `app.mjs` | Inside `#viewport` (centred cards, exempt from the budget only while their state is active); `#playback-fps` in the canvas’s top-right corner during playback, `#preview-quality` beside zoom, `#preview-badge` and `#viewport-hint` in the hidden log; the chain and polygon controls in the inspector's first section while drawing (JS-created from M7a) |
| Title and status | `app`, `project-name` (1), `dirty-dot`, `save-state`, `stage-size`, `status`, `status-dot`, `renderer-label`, `render-time`, `object-count` (1), `window-controls` (1) | `app.mjs` / topbar, studio-shell | Top band, save-state control, Scene inspector (`stage-size`, JS-created from M4), hidden log (`#renderer-label` and `#render-time` hidden outside the live region) |
| **Reader-bound** | `leave-rig`, `tool-context`, `edit-scope` (studio-shell only, with no null checks), `frame-badge` (always hidden) | studio-shell, `app.mjs` | May be removed in **M3b** together with `studio-shell.mjs` and the reader |

**Ids created by JS that are contracts.** About 60 ids that tests read are created by JS, not by `index.html`, so `shell-contract.test` alone cannot guard them. **M0 generates the contract mechanically**: `scripts/ui-contract.mjs` intersects the ids (and `data-action` values) that `tests/**` and `scripts/**` query with the ids that `src/**` creates, and writes `tests/fixtures/ui-contract.json`; `tests/ui-contract.test.mjs` (unit, CI) fails when a listed id no longer has a creator in `src/`. Known at planning time, besides the list below: `#builder-exit-update`, `#builder-exit-import`, `#builder-exit-import-new`, `#builder-exit-discard` (4 files; kept through `choose()` option ids, §3.8), the export ids of §3.15, `#text-font|size|bold|italic|color|error|preview*`, `#segment-values-apply|paste|copy|cancel|status`, `#rig-test-*`, `#retry-renderer`, `#fill-reference-form`, `#create-background`, `#background-*`, `#cancel-clipboard`, `#vfx-scope`, `#builder-snap`, `#builder-timeline-toggle`, `#builder-branch` and `#rig-mode` (both kept with their element types, moved to Inspector › More › Editing in M7a), `#movieclip-next-keys`, `#doc-pop` (the Document popover, a DOM descendant of `.titlebar`), `#inspector-layer-name`, `#node-is-ik`, `#rename-input`.

- `properties-tab`, `vfx-tab`, `library-tab` (dock host, M1)
- `user-library` (an empty host in `index.html` from M1, filled by the controller)
- `onion-popover` (4)
- `canvas-guides-panel`, `path-popover` (opened from *View › Grid and guides…* and *View › Motion path settings…*)
- from their moving milestone: `fps`, `stage-size` (M4), `range-edit`, `onion-settings-button`, `timeline-audio`, `timeline-zoom`, `loop-button`, `expand-timeline` (M5), the chain and polygon controls (M7a)
- the export ids (§3.15)
- `export-progress` (5), `cancel-export` (3), `restore-recovery` (2), `keep-editing` (2), `discard-changes` (3)
- `text-content`, `create-text`
- the inspector control ids (§3.13)
- `styk-ui-scale`

### 4.2 `data-*` values

| Attribute | Values or rule | Test files |
|---|---|---|
| `data-action` | The 59 values in `index.html` today, plus every value rendered by JS. Each is an `actions` key and is never renamed. | 74 |
| `data-shift-action` | `duplicate-branch`, `mirror-branch`, `mirror-branch-vertical`, `selection-down`, `selection-up` | – |
| `data-tool` | `select`, `rig`, `tweener`, `line`, `chain`, `circle`, `polygon`, `hand`, `drawing-{brush,eraser,fill,lasso,shape,transform}` | 32 |
| `data-workspace-mode` | `animate`, `draw`, `rig`, including `#builder-done` | 45 |
| `data-app-menu` | `file`, `edit`, `view`, `editor` (labelled **Figure**, visible in Build only), `animation`, `help`. Queried once at module evaluation (`app.mjs:4150`), so the buttons stay static in `index.html` even when folded. | 5 |
| `data-timeline-mode` | `simple`, `advanced` | 2 |
| `data-hotkey-command`, `data-hotkey-title`, `data-hotkey-hint` | Unchanged semantics (`title` is no longer written, §3.6) | 3 |
| `data-property*`, `data-field`, `data-section`, `data-polygon-index`, `data-inspector-owned`, `data-camera-monitor` | Inspector contract (§3.13) | 35 / 18 / 12 |
| `data-setting`, `data-tab`, `data-scale-reset`, `data-settings-*`, `data-hotkey-*` | Settings contract (M6) | 23 |
| `data-figure`, `data-sample`, `data-joint`, `data-delete-polygon`, `data-selection-order`, `data-connector-part`, `data-polygon-*` | Delegation (`app.mjs:4977-5018`) | – |
| `data-draw-*`, `data-vfx-*`, `data-library-*`, `data-motion-*`, `data-parallax-*`, `data-camera-tab`, `data-rig-*`, `data-sprite-*`, `data-kind`, `data-layer-id`, `data-frame`, `data-clip`, `data-category`, `data-accept`, `data-decline` | Owned by their feature milestone; kept | 1–12 each |
| `data-i18n*`, `data-i18n-slot` | Localization (§3.16) | – |

### 4.3 Accessible names (Playwright `getByRole`)

| Role and name | Files | Owner |
|---|---|---|
| tab **VFX**, **Library**, **Properties** (the visible label equals the name) | 11 / 6 / 5 | dock-host (M1) |
| grid **Layer frames** | 12 | layer-timeline (M5) |
| listbox **Animation frames**; option **Frame N** | 3–6 | sheet-filmstrip (M5) |
| button **Add Frame** (with `exact: true` in `add-frame`, `audio-navigation`, `layer-timeline` and `timeline-polish`; regex in `thumbnail-akane-integrated`) | 5 | timeline-header (M5). The `aria-label` is exactly "Add Frame"; the visible text is sentence case. |
| button **Close welcome screen**, **Close settings** | 10 / 8 | support-ui, settings (M6) |
| button **Pose** (and **Rotate**) | 4 files, 8 uses (`pistol-3d`, `scythe-asset`, `skateboard-asset`, `spatial-controls`) | spatial controls (M4). **Kept as `role=button` with `aria-pressed`**: the 3D rig's Pose │ Rotate uses the segmented control's button-group form (like the workspace switch), never radios |
| menuitem **Onion skin settings** (a `button` until M5 renders the Timeline ⋯ menu); button **Close onion settings**; spinbutton **Frames before/after**; slider **Onion frames before/after**; button **Drag frames before**; dialog **Onion skin settings** | 4–5 | onion (M5/M7g); the tests that clicked the button open *Timeline ⋯* first (§4.6) |
| menuitem **Audio** in *Timeline ⋯* (a `button` until M5); button **Audio clip controls**; label **Choose audio recording** | 3 / 5 / 4 | Timeline ⋯ menu (M5), audio (M7f); the tests that clicked the button open *Timeline ⋯* first (§4.6) |
| slider **Timeline zoom**; separator **Resize timeline**, **Resize layer names**; searchbox **Find layers** | 2 / 1 / 1 / 1 | M5, M1 |
| slider **Frame N inbetweens** | 5 | filmstrip (M5) |
| button **Select layer {name}**; menuitem **New layer** and **New drawing layer** (in *Timeline ⋯*; the tests that clicked a New layer button open the menu first, §4.6); **Fit timeline** (a `button` in today's zoom float, a menuitem of *Timeline ⋯* from M5: `timeline-organization.browser:21` opens the menu first and queries the menuitem); menuitems **Change easing…**, **Insert inbetween…**, **Rename layer**, **Select Camera**, **Select Scene**; menuitemcheckbox layer colours (**Violet** …) | 3–5 | M5 |
| dialog **Keyframe easing**, **Onion skin settings** | – | M5, M7g |
| button **Undo**, **Redo**, **Play** | 1 | topbar, transport |
| button **Close color picker**, **Add gradient stop**; combobox **Gradient type**; textbox **Hex color** | 3–5 | color-picker (M7g) |
| button **Restart to update**, **Open downloads** | 4 / 1 | update (M6) |
| searchbox **Search shortcuts**, **Search library**, **Search effects** | 2–4 | M6, M7c, M7d |
| button **Close feedback**; labels **Title**, **Description**, **Steps to reproduce**, **Expected result**; text **Message sent.** | 3 | support center (unchanged) |

### 4.4 Hook classes and structure

These are kept as hook-only classes (never styled): `.titlebar`, which stays the drag-region element and contains `[data-action=export]` and, **inside the Document popover `#doc-pop`, a DOM descendant of `.titlebar` rendered in the top layer**, `[data-action=save]` (the localization tests read `.titlebar [data-action=save]`, its text and its icon node without opening anything; `clipboard-legacy-app` clicks it after opening the popover, §4.6); `.brand[data-action=menu]`; `.workspace` (`data-mode`, `data-builder-timeline`); `.center`; `.studio-rail`; `.tool-dock`; `.timeline-panel`; `.timeline-toolbar`; `.layer-timeline` and `.sheet-filmstrip` (hotkey scopes, `app.mjs:5482-5494, 5564`); `.sheet-scroll` (3 benchmarks); `.sheet-layer`, `.sheet-layer-name`, `.sheet-preview`, `.sheet-add-frame`; `.menu-item`; `.icon`; `.styk-settings`; `.release-splash`; `.styk-privacy`.

These change with test updates:

- `.canvas-toolbar` (4 files, selection-order): the canvas toolbar disappears in M3b, and those tests switch to the rail and selection-menu hooks.
- `.canvas-options` (`workspace-clean`).
- `.canvas-view-controls` (1): removed in M3b; `ui-budget` and `stage-chrome` assert it is absent or hidden.
- `.right-panel` (1).

### 4.5 JS and CSS couplings

- The CSS variables that painters read (§2.4, §2.5), and `styk-theme-change` dispatched by `theme.mjs:23`.
- The JS-written properties (§2.4 allowlist).
- `user-library.mjs:98` counts `gridTemplateColumns`, so `.library-grid` stays a CSS grid.
- `library-drag.mjs:89` copies the computed `backgroundColor`.
- Geometry constants: `ROW`/`HEADER` 32 (layer-timeline, also duplicated in `vfx-clip-timeline.mjs:7`, `timeline-organization.mjs:34-36`, `camera-motion-timeline.mjs:8-12`, `audio-timeline.mjs:187-207`), audio 64/22/36, outliner 30, asset rows 74. Each changes only together with its token.
- `isHotkeyInput` targets: every custom text control is an `input`, `textarea`, `select`, `[contenteditable]` or `[role=textbox]`.

### 4.6 Tests to keep, update, delete and add

**Keep green unchanged.** All unit tests except those listed below. Every behavioural browser test that goes through `window.styk`, `data-action` or `#overlay`.

**Update, in the milestone that changes the surface.**

| Tests | Why | Milestone |
|---|---|---|
| `tests/theme.test.mjs` (unit) | Meta colours | M0 |
| `localization-settings.browser:14`, `sprite-placement.browser:12`, `workspace-release-ux.desktop:18`, `scripts/verify-library-release.mjs:11` | CSS paths | M0 (and M7c) |
| `scripts/smoke-preferences.mjs` | `float()` and `floating` now exist; v2 schema expectations | M1 |
| `integrated-ux-walkthrough.browser`, `thumbnail-akane-integrated.browser`, `workspace-release-ux.desktop` | Shell geometry and panel assumptions; references to the dead floating panel | M1 / M3b |
| `hotkeys-timeline.browser:49,82`, `integrated-ux-walkthrough.browser:184-191`, `join-selection.browser:73`, `asset-library.browser:162` | Title assertions → `data-hotkey-hint` | M2 |
| `native-handles:83`, `node-only-drag:64-74`, `pen-input:49`, `tweener:41`, `workspace-clean:55` (read `#menu.hidden`) | Kept green by the `hidden` mirror on `#menu` (§3.4); no edit | M2 (verify) |
| `workspace-clean.browser` (`.canvas-options` count, `.canvas-view-controls #zoom-label`), `ui-refresh.browser`, `ux-audit.browser`, `app.browser` (overflow at 1100×740, `#layer-count`, `[data-inspector]`), `selection-order` tests (`.canvas-toolbar`) | Chrome restructure | M3b |
| `data-tool="pose"` users: `branch-opacity`, `builder-aids`, `integrated-ux-walkthrough`, `onion-performance` | The tool was removed in 76c7fa5f (already stale) | M3b |
| `clipboard-legacy-app.browser:43` | Clicks `.titlebar [data-action=save]`: opens the Document popover first (the node is unchanged, now inside `#doc-pop`) | M3b |
| `localization-app.browser`, `localization-native-app.browser` | Read `.titlebar [data-action=save]`, its text and icon node: unchanged (the Save node is a DOM descendant of `.titlebar`); verify only | M3b (verify) |
| `figure-order-controls.browser` | Clicks `#inspector [data-action=layer-*]` and `.canvas-toolbar [data-action=selection-*]`: both surfaces go (one home each). The `layer-*` cases open the selection menu's Arrange ▸ (`#menu [data-action=layer-*]`, which `canvas-workspace.browser` already reads); the toolbar cases select a joint and use the joint menu's Arrange ▸ (`selection-*`) | M4 |
| `timeline-organization.browser:21` | `getByRole('button', {name: 'Fit timeline'})` becomes the menuitem of that name in *Timeline ⋯* (the same `fitFrameRange()`) | M5 |
| Tests that click a **New layer** button (`layer-timeline.browser:17`, `layer-ownership.browser:28`, `panels-settings-timeline.integrated.browser:24`) | *New layer* and *New drawing layer* are `menuitem`s of *Timeline ⋯*: open the menu, then `getByRole('menuitem', { name: 'New layer' })` | M5 |
| `onion-timeline-range.browser` | Unchanged: the ranges still show on the ruler while onion is on and keep their slider names | M5 (verify) |
| `workspace-clean.browser` (`selection-more`) | The figure inspector's `⋯` runs `selection-more` and opens the selection menu (today's "More figure actions…" items are in that one menu) | M4 |
| `builder-*` tests that use today's builder context menu pages (Branch…, Arrange…, View) | The part menu lists those commands flat (Flip ▸, Arrange ▸, Isolate joint, the part deletes); `#builder-branch` stays the inspector switch they `check()`; F9, F10 and F12 are unchanged | M7a |
| `animation-mode-sync.browser`, `settings.component.browser` (`[data-setting=timelineMode]`) | Kept: Settings › Interface › Timeline mirrors the timeline header's switch (experience §8 rule 5) | – (verify) |
| `hotkeys-timeline.browser:91-93`, `polygon-construction.browser:89` | Focus `#fps` with a figure selected or while drawing; `#fps` now renders only in the Scene inspector, so they focus another text field of the inspector context they are in (the figure's X field, `[data-property=root_x]`; while drawing a polygon, the first field of the drawing section) for the same "typing in an input does not trigger hotkeys" check | M4 |
| `audio-navigation.browser`, `audio-ux.browser`, `audio.browser` ("Audio" button, 6 uses) | *Audio* is a `menuitem` of *Timeline ⋯*: open the menu, then `getByRole('menuitem', { name: 'Audio' })` | M5 (with M7f for `audio-ux`) |
| `onion-timeline-range.browser`, `onion-controls.desktop`, `timeline-context.browser`, `timeline-usability.browser` ("Onion skin settings" button) | *Onion skin settings…* is a `menuitem` of *Timeline ⋯*: open the menu first; the dialog keeps its name | M5 |
| `pistol-3d`, `scythe-asset`, `skateboard-asset`, `spatial-controls` (button "Pose") | Unchanged: Pose │ Rotate keeps `role=button` with `aria-pressed` (§4.3); verify only | M4 (verify) |
| `figure-z-index.browser` | Unchanged: `data-property=figure_z_order` lives in the figure's Arrange core section (visible at rest, as today) | M4 |
| `tests/shell-contract.test.mjs` (unit) | The ten relocated ids leave the static list for `ui-contract.json` in their moving commits (§4.1); `.titlebar [data-action=save]` is found inside `#doc-pop`; the static accessible names become "Undo", "Redo", "Play" once M5 renders the Timeline ⋯ menu (§4.7) | M3b, M4, M5, M7a |
| `[data-inspector=]`: `app`, `authoring`, `ux-audit` | Stale | M4 |
| `.styk-timeline-scroll`: `authoring`, `clipboard-legacy-app`, `insert-inbetween-app`, `recovery-interaction`, `scrub-selection`, `ux-audit`, `edit-freeze-profile`, `scripts/benchmark-dense-scene.mjs`; `.styk-simple-*`: `scripts/smoke-simple-boundaries.mjs`, `smoke-simple-native.mjs`; `mixed-rig-scope` (`.styk-timeline-label*`); removed timeline APIs: `clipboard-async-app`, `clipboard-legacy-app`, `insert-inbetween-app`, `insert-inbetween-dialog`, `mixed-rig-scope`, `scripts/benchmark-connected-editing.mjs` | Stale; triaged to current hooks, or deleted where the scenario no longer exists | M5 |
| `timeline-polish.browser:59` (menu text `Add FrameA`) | Menu item anatomy and sentence case | M5 |
| `timeline-organization.browser` (`.timeline-footer`) | The footer moves into the hidden log | M5 |
| `settings.component.browser` (computed colours), `settings-tabs.desktop` (`.hotkey-row` grid), `export-panel-layout.desktop` (3 columns), `export-experience.browser` | Restyle | M6 |
| `user-library-ux.desktop:41` (thumbnail `rgb(52,59,71)`), `tweener.browser:22`, `audio-ux.browser:91`, `color-picker-eyedropper:63-67` | Restyle | M7c / M7g / M7f / M7g |

**Delete** (with the dead modules in M1, after porting their useful cases into the new unit tests):

- `tests/studio-layout.test.mjs` and `tests/workspace-layout.test.mjs` (both unit, in CI; ported first)
- `tests/workspace-layout.browser.mjs`, `workspace-panels.browser.mjs`, `workspace-persistence.browser.mjs`, `workspace-simple-mode.browser.mjs`, `layer-panel.component.browser.mjs`

**Add.**

| Test | Kind | Milestone |
|---|---|---|
| `tests/shell-contract.test.mjs` | unit (CI) | M0 |
| `tests/ui-contract.test.mjs` with the generated `tests/fixtures/ui-contract.json` | unit (CI) | M0 |
| `tests/native-catalog-keys.test.mjs` | unit (CI) | M2 |
| `tests/actions-contract.browser.mjs` (runtime `Object.keys(styk.actions)` against every `data-action` in the DOM) | local | M2 |
| `tests/check-css.test.mjs` | unit (CI) | M0 |
| `tests/fonts.test.mjs` | unit (CI) | M0 |
| `tests/locale-fragments.test.mjs` | unit (CI) | M0 |
| `tests/i18n-keys.test.mjs` (every `data-i18n*` key in `index.html` exists in `en`) | unit (CI) | M3b |
| `tests/layout-schema.test.mjs`, `layout-solver.test.mjs`, `layout-store.test.mjs` (merge, budget, ordering, downgrade mirror) | unit (CI) | M1 |
| `tests/command-registry.test.mjs`, `overlay-queue.test.mjs`, `toolbar-overflow.test.mjs` | unit (CI) | M2 |
| `tests/ui-context.test.mjs` | unit (CI) | M3b |
| `tests/inspector-kit.test.mjs` | unit (CI) | M4 |
| `tests/export-request.test.mjs` | unit (CI) | M6 |
| `tests/ui-audit.browser.mjs` (the spec `design/app-ui/reference/tools/shoot.mjs` audit: text ≥ 11 px, text contrast, targets ≥ 24 px, off-screen controls outside scroll regions, overflowing bars, focus-ring and control-boundary contrast ≥ 3:1, every canvas-read token resolves, and a forced-colours pass; `--scope app | gallery`, `[data-ui]` roots during migration) | local | M0 |
| `scripts/ui-snapshots.mjs`: a state matrix saved to `artifacts/ui-redesign/<label>/`. The matrix is Animate, Draw and Build × Simple and Advanced × light and dark × the 5 sizes, plus Settings (every tab), Export, Insert, the text dialog, the onion popover, an open menu, a toast over a modal, and the feedback shell (mock bridge). It uses the Canvas renderer (`rendererMode: 'canvas'`) for determinism. `--compare` diffs pixels in the page with canvas, with no dependencies. | local | M0 |
| `tests/shell-layout.browser.mjs` | local | M1 |
| `tests/overlays.browser.mjs` | local | M2 |
| `tests/playback-quiet.browser.mjs` | local | M3a |
| `tests/stage-chrome.browser.mjs` (nothing over the artboard at fit, `#viewport`'s children included; one message at a time; the message never meeting the view cluster in the stage header (revision 3: the zoom corner, which stepped aside at compact and minimal), `joint-hit-radius.browser.mjs`, **`ui-budget.browser.mjs`** (the reference budget check run against the app in the rest states, counting controls inside `#viewport` too: band ≤ 8, stage ≤ 1 group of ≤ 3, rail ≤ 7 + 1, inspector name + one menu + ≤ 3 sections + one disclosure, header area ≤ 9 (the toolbar row and the layer list's title) with one readout, window ≤ 40 (a one-tab-stop collection counts once), 1 ink primary, 0 keycaps at rest, 1 shadow level, 0 labels over two words, today's canvas HUD hosts absent; plus, in every state, `#viewport` ≥ 360×200, the artboard at or above its floor, the band fitting with every window control inside the window, the page one window tall, stage chrome clear of the artboard and of itself, menus below the band, and every layer, tree and frame row reachable; its matrix includes the short windows 1920×520, 960×520, 911×485, 1000×450, 853×453, 640×480 and 601×441, the 601–661 bands in Animate, Draw and a camera session, and Build at 901–962 wide) | local | M3b (extended by M4 and M5) |
| `tests/fixtures/ui-gallery.html` (+ `ui-gallery.css`): the spec gallery rebuilt to link the **real** `/src/styles/app.css` (served unpackaged via `tests/`) | local | M0 |

### 4.7 `tests/shell-contract.test.mjs` (the only CI guard for markup)

It reads `index.html` and `src/app.mjs` as text, parses the markup with a small tag-stack scanner (about 60 lines, aware of void elements) and asserts:

1. Each static id (§4.1: 77 today, 67 once the ten relocated ids have moved to `ui-contract.json`, minus reader-bound ids once removed) appears **exactly once**.
2. The 59 baseline `data-action` values are present somewhere in `index.html`. Every `data-action` value in `index.html` is an `actions` key: keys are scanned from the `const actions = {` literal in `app.mjs` by brace depth (skipping strings and template literals), plus `actions["x"] =` and `Object.assign(actions, …)` registrations and the `SHELL_ACTIONS` export of `src/shell/shell-commands.mjs` (DOM-free at import; it includes `command-palette`). Dynamic keys (`zoom-25/50/100/200` from `Object.fromEntries`) and keys registered outside `app.mjs` are covered by `actions-contract.browser` at runtime.
3. The 5 `data-shift-action` values, the 14 `data-tool` values, `data-workspace-mode` ∈ {animate, draw, rig} (including `#builder-done`), the 6 `data-app-menu` values and the 2 `data-timeline-mode` values.
4. Structure:
   - `#viewport` has `#scene` and `#overlay` as direct children
   - `.titlebar` contains `[data-action=export]`, `#window-controls` with minimize, maximize and close, and `#doc-pop` with `[data-action=save]` and `[data-action=save-as]` (the Document popover is a DOM descendant of the band; from M3b)
   - `.timeline-toolbar` contains the three header slots, `[data-slot=start]`, `[data-slot=transport]` and `[data-slot=end]` (from M3a, §3.14)
   - every compatibility and announcement host (§3.12, §4.1) is `hidden` or inside an element with `.ui-visually-hidden`, whose rule in `components/base.css` is `position: fixed` (the measured check that the page is one window tall is in `shell-layout.browser`, §3.11.8)
5. The CSP meta string is unchanged byte for byte.
6. There is exactly one stylesheet link (`./src/styles/app.css`) and the two font preloads. There is no `<style>` element, no inline script and no `on*=` attribute.
7. The static accessible names are present in the markup: "Undo", "Redo", "Play", and, until M5 renders the Timeline ⋯ menu, "Onion skin settings", "Audio" and "Timeline zoom" (from M5 they are JS-created and guarded by `ui-contract.json`).
8. `ERROR_MODULES` basenames are unique across `src/` and `desktop/`.

---

## 5. Phased plan

### 5.1 Roles and ownership rules

- **Integrator (I).** One agent for the whole programme, working serially. I owns the hot spots:
  - `index.html`, `src/app.mjs`, `src/styles/app.css`
  - `src/hotkeys.mjs`, `src/icons.mjs`, `src/telemetry-schema.mjs`
  - `src/locales/en.mjs` and `it.mjs` (composition only)
  - `src/localization-bindings.mjs`
  - `src/studio-shell.mjs` (until it is deleted in M3b)
  - `CHANGELOG.md`, `docs/ARCHITECTURE.md`, `docs/DESIGN-SYSTEM.md`
  - `tests/shell-contract.test.mjs`

  I is the only agent that commits changes spanning a hot file. In W3, I finishes **M3b's hot-file work before taking patch requests** from D, E and F, then takes them in batches at fixed points (after each M3b commit), so the critical path accounts for I's serial load.
- **Track agents** own the files listed for their milestone, and nothing else. Ownership of an existing module passes between milestones sequentially (§5.4). No two concurrently active tracks ever own the same file.
- **Integration requests.**
  - A track that needs a hot-file change writes a unified diff to `artifacts/ui-redesign/requests/<track>-<n>.patch` (gitignored) and messages I.
  - I applies it, runs the track's verification, and commits the track's staged files and the hot-file hunks together as one coherent commit with the track's subject.
  - Track agents commit standalone work themselves: unused-yet modules with their unit tests, feature CSS and restyles that need no hot-file edit.
- **The legacy fragment rule.** A track empties only the fragments listed for it (§2.9), never deletes the file, and never edits `app.css`.
- **Changelog.** At each milestone close, I updates the few outcome-grouped entries in `docs/design/CHANGELOG-DRAFT.md` (§5.3 M9 lists the target wording); they move into `CHANGELOG.md` `Unreleased` in M9, under the release freeze (§1 rule 6). Changelog work is never done in parallel.

### 5.2 Dependencies and parallel windows

| Window | Runs in parallel | Needs |
|---|---|---|
| W0 | M0 (I alone) | – |
| W1 | M1 (track A + I) ∥ M2 (track B + I) | M0. M1's last feature commit (tab menus, Layout popover) needs M2's Menu and Popover. M2 creates the pure `ui-context.mjs` stub. |
| W2 | M3a (I alone, short) | M1, M2. M3a also moves the `#timeline-workflow` listener and the `mountExportFlow` import, and takes the movieclip breadcrumb's mount out of `movieclip-ui.mjs` (the breadcrumb is removed in M4: its scope path moves into the inspector's name line, its buttons are the band's Done and the movieclip menu's Cancel editing), so no W3 track shares a file with another. |
| W3 | M3b (I + track C) ∥ M4 (track D) ∥ M5 (track E) ∥ M6 (track F) | M3a (seams, static slots, invalidation) |
| W4 | M7a builder ∥ 7b draw ∥ 7c library ∥ 7d VFX ∥ 7e camera ∥ 7g canvas aids; then 7f audio | M3b + M4. 7f also needs M5. 7a also needs M3b's band primary slot. |
| W5 | M8 (I + QA track G) | All of the above |
| W6 | M9 (I, or a docs agent owning `docs/**` except the hot docs) | M8 |

The critical path is M0 → M1 → M3a → M3b → M7a → M8. M2, M4, M5 and M6 have slack.

### 5.3 Milestones

Every milestone runs `npm run check` and `npm test` for **every** commit, plus the listed checks. "Exit" means screenshots of the affected surfaces reviewed in light and dark at 1440×900, 1280×720, 1024×700, 800×600, 500×340 and the short window 1000×450 (`scripts/ui-snapshots.mjs`), with no new failures compared with `artifacts/ui-redesign/baseline.json`.

---

#### M0 Foundation (I alone; blocks everything)

**Goal.** Layered CSS, brand tokens and fonts, lint and guards, with no behaviour change. The app looks the same, except that it is brand-coloured in Inter.

**Status on `main` (`cbf1c335`, 2026-09-26; updated 2026-09-27).** Five of the seven commits have landed, and part of the seventh:

| Commit | On `main` | Differs from this plan |
|---|---|---|
| 1 *Record the UI baseline and guard the editor shell contract* | `521f0e5c`: `tests/shell-contract.test.mjs` (77 static ids, every `data-action` checked against `app.mjs` and `movieclip-ui.mjs`, tool, workspace-mode, app-menu and timeline-mode values, structure, static accessible names, CSP, served files) and `scripts/ui-snapshots.mjs` (144 labelled captures, pixel compare) | **Not yet:** `scripts/ui-contract.mjs`, `tests/fixtures/ui-contract.json` and the JS-created-id contract; the release-freeze marker `artifacts/ui-redesign/IN_PROGRESS` and its `release:prepare` check. They land before commit 5 |
| 2 *Load every stylesheet through one layered entry* | `1e8a7cec`: `src/styles/app.css` declares the layer order and imports the 21 legacy sheets into `layer(legacy)`; the 11 injectors wrap their text in `@layer legacy`; `support-bridge.css`; 0 changed pixels in 144 snapshots | The legacy sheets stay **whole** (§2.9, measured); no empty layer files are imported yet |
| 3 *Lint stylesheets in npm run check* | `74a95b94`: `scripts/check-css.mjs`, `scripts/check-css-baseline.json` (a ratchet of the 14 injectors and 77 legacy `!important`), `tests/check-css.test.mjs` | The ratchet file replaces the separate `legacyImportant` inventory |
| 4 *Bundle Inter and Inter Tight for every shipped language* | `cbf1c335`: `assets/fonts/` (14 subsets and the OFL texts), `src/styles/base/fonts.css` and `document.css`, `src/ui/font-loading.mjs` (`onFontsReady()`, used by the layer and audio timelines and the overlay), `tests/fonts.test.mjs` | Fonts live in `src/styles/base/`, not a root `fonts.css`; nothing uses Inter Tight yet |
| 5 *Adopt the StykAnimate brand colours* | `876a7e8f`, with the follow-ups `f007e2fe`, `df29707b`, `d0154b51`, `de7ba2b7` and `c82312fb` | The tokens are revision 3's; revision 4.3's changes (`design/app-ui/tokens.css`) are still to adopt. The release-freeze marker and its check have not landed |
| 6 *Allow diagnostics from the redesigned UI modules* | — | To do; held for the telemetry deploy (§3.17) |
| 7 *Stage the component library, glyphs and design docs* | — | To do: `src/ui/dom-write.mjs`, the `src/locales/en-*.mjs` stubs, `tests/locale-fragments.test.mjs`, `tests/ui-audit.browser.mjs` with `tests/fixtures/ui-gallery.{html,css}`, the glyphs. **Landed:** `docs/design/*` and the reference source in `design/app-ui/` |

The file list and verification below are the original plan; items marked landed above are not redone.

**Files.**

- Create:
  - `src/styles/**` (§2.2; components split verbatim from spec `components.css`, inert because no `.ui-*` class exists in the DOM yet; feature and layout stubs)
  - `src/styles/legacy/**` (split, §2.9)
  - `assets/fonts/**`
  - `src/ui/dom-write.mjs`, `src/ui/font-loading.mjs`
  - `src/locales/en-*.mjs` stubs (12 fragments)
  - `scripts/check-css.mjs`, `scripts/check-css-baseline.json` (ratchet counts and the generated `legacyImportant` inventory), `scripts/ui-snapshots.mjs`, `scripts/ui-contract.mjs` and `tests/fixtures/ui-contract.json`
  - `artifacts/ui-redesign/IN_PROGRESS` (the release-freeze marker) and its check in the `release:prepare` script
  - tests: `shell-contract`, `check-css`, `fonts`, `locale-fragments` (unit); `ui-audit.browser`; `tests/fixtures/ui-gallery.{html,css}`
  - `docs/design/*` (copies of the spec, with repo-relative paths; `architecture.md` becomes `ui-architecture.md`) and the reference source in `design/app-ui/`
- Edit:
  - `index.html` (head only)
  - `scripts/check.mjs`
  - `src/settings.mjs`: drop the CSS link; add the setting keys `hintsSeen` (the one first-run hint) and `exportPreferences` with normalizers. **Defaults are unchanged** (revision 3 drops the `onboarding` and `settingsVersion` keys: they only served the coach marks and the withdrawn default migration).
  - `src/support-desktop-ui.mjs` (one link; `support-bridge.css` imports into `layer(legacy)`)
  - the 11 live injectors (`property-controls`, `movieclip-ui`, `keyframe-easing-popover`, `insert-inbetween-dialog`, `text-dialog`, `background-dialog`, `segment-values-dialog`, `sprite-placement-dialog`, `vfw-export-controls`, `privacy-ui`, `builder-outliner`): wrap the injected text in `@layer legacy { … }`, one line each
  - `src/theme-bootstrap.js` (colours, `data-platform`), `src/theme.mjs`, `desktop/main.cjs:584`, `tests/theme.test.mjs`
  - `src/icons.mjs`: every new glyph from `visual-system.md` §10 (the in-between `tween` glyph, `test-rig`, `properties`, `layout`, `film`, `sparkles`, `shapes`, `key`, window controls)
  - `src/telemetry-schema.mjs` (§3.17)
  - `src/locales/en.mjs` (spread fragments)
  - `src/localization-bindings.mjs` (delete the stale rows; add `data-i18n-tooltip`)
  - the CSS path users (§4.6)
  - `docs/DESIGN-SYSTEM.md` (points to `docs/design/*`, describes the layers and lint), `docs/ARCHITECTURE.md` (styles section; `:183-191` settings CSS ownership), `docs/LOCALIZATION.md` (fragments), `docs/telemetry.md` (the module list and the deploy-first rule)
- Delete: the original `src/*.css` except `src/support-center.css` and `src/support-desktop.css`

**Commits.**

1. *"Record the UI baseline and guard the editor shell contract"*: `shell-contract.test`, `ui-contract.test` and its generated fixture, `ui-snapshots.mjs`, the release-freeze marker and check, and the `baseline.json` run (local artifact).
2. *"Load every stylesheet through one layered entry"*: app.css, the legacy split, the injectors wrapped in `@layer legacy`, index head, the settings and support link changes, the path fixes.
3. *"Lint stylesheets in npm run check"*
4. *"Bundle Inter and Inter Tight for every shipped language"*
5. *"Adopt the StykAnimate brand colours"*: tokens, bridge, pre-paint colours, theme test.
6. *"Allow diagnostics from the redesigned UI modules"*: `ERROR_MODULES` only, isolated for the cloud deploy, and **held until the owner schedules that deploy** (§3.17).
7. *"Stage the component library, glyphs and design docs"*

**Verify.**

- `node --test tests/theme.test.mjs tests/localization.test.mjs tests/shell-contract.test.mjs tests/check-css.test.mjs tests/fonts.test.mjs tests/locale-fragments.test.mjs`
- Snapshots on server 47910: `node scripts/ui-snapshots.mjs --url http://127.0.0.1:47910 --label m0-before` before commit 2, then `--label m0-layered --compare m0-before`, which **must be 0 changed pixels**. The matrix includes the inspector open on a figure, a joint and polygon rows, Settings (every tab) and the feedback shell (mock bridge).
- Browser tests on 47910: `app`, `localization-app`, `localization-native-app`, `localization-settings`, `theme` (compare with the baseline result), `workspace-clean`, `integrated-ux-walkthrough`, `sprite-placement`.
- `node tests/ui-audit.browser.mjs --page /tests/fixtures/ui-gallery.html` gives 0 failures. `--scope app` on the bridged legacy UI gives no new contrast failures compared with the baseline audit.
- Startup gate (§2.2).
- `env -u ELECTRON_RUN_AS_NODE npm run test:desktop`.
- Once: `npm run pack && npm run verify:package && env -u ELECTRON_RUN_AS_NODE npm run test:desktop:packaged` (fonts served in the packaged web root).

**Exit.** Lint green. Contract test green. Fonts render in Electron and the browser, with Cyrillic, Greek and Vietnamese checked on the Settings language list. The app is otherwise unchanged.

---

#### M1 Shell and layout engine (track A ∥ M2; I integrates)

**Status on `main` (2026-09-27).** All five commits have landed: commit 1 as `7b0112b1` and `ffb3a331`, its data brought to revision 4.3 in `741b8a50`, commit 2 as `de163679` (*Dock the editor panels as islands*: `index.html`'s islands, `dock-host.mjs`, `dock-keyboard.mjs`, `shell-commands.mjs`, `layout/{shell,workspace,dock}.css` and `components/{island,tabs,strip,sheet,splitter,drop-zone}.css`) commit 3 as `058dd3d8` (*Keep the stage usable in small windows and at high interface scale*: `topbar.mjs`, `layout/topbar.css`) commit 4 as `2eb1bda6` (*Arrange panels from the Layout menu or by dragging a tab*: `layout-popover.mjs`, `dock-tabs.mjs`, `components/choice.css`) and commit 5 (*Remove the unused floating-panel and layer-panel modules*). Where they differ from this plan:

- The solver's data is revision 4.3's (§3.11.4): compact ≤ 800, `STAGE_FLOORS` without the 800×600 row, a 40px stage header above `#viewport` (the solution reports `stage`, `stageHead` and `viewport`), the vertical insets 24, 10 and 8, the default timeline from its data (Camera and Scene at 24px, then 4½, 4 or 3 content slots) and `bandMin` as the band's width after each fold step (`BAND_FOLDS`, written to `data-band`). The timeline's row minimum stays two content rows (184px tall, 168px short), not 120px.
- Until M3b the status bar stays under the workspace (the solver's `footer` input) and the canvas toolbar is the stage island's 40px header row; `dock-host` measures that row (plus Build's bar) as `stageHead`. The floors hold in the solver, but the app's artboard sits a few points lower (86% at 1440×900), and at 500×340 `#viewport` is about 180px tall; `shell-layout.browser` records that exception.
- Until M5's row-layout painter draws Camera and Scene at 24px, the default timeline shows about one content row fewer than today.
- Sheets are the panels' own islands shown as `popover="manual"` in place (a side's sheet island, `#timeline` at the low tier), so every root keeps its DOM ancestry; they close on Escape and on a press outside any other overlay. At compact width the right sheet keeps the Properties, VFX and Library tabs.
- The band is measured by `src/shell/topbar.mjs` (its max-content width with no step, then after each `BAND_FOLDS` step that frees room, with the menubar docked and folded into the mark), again only when its text or parts change and once the fonts load, never on a resize, so its fold rules (`styles/layout/topbar.css`) must not depend on the window size; the legacy band media queries are gone, and Save stays beside Export while the band fits. The steps go to the band's own `data-band` (not `:root`), plus `menus` at the minimal tier, where the mark's menu leads with File, Edit, View, Editor, Animation and Help as submenus (Alt does not show the menubar yet). Today's band has the steps `state`, `tight`, `name`, `name8`, `savelabel`, `save`, `winctl`, `dot` and `primary`; M3b's band adds the rest. `.shell` has one `minmax(0, 1fr)` column, so a band can never widen the workspace (it did at 500×340).
- The band's Properties button is `.shell-sheet-button` (`data-action="panel-toggle-properties"`) in today's band, and the timeline header starts with Timeline… (`data-action="timeline-sheet"`) while the timeline is folded, until M5's Timeline ⋯ menu. At the minimal width the header folds First frame, Loop, Audio and Edit selected frames (the Animation menu lists them; the last two only at that tier) and hides Tall timeline while folded, so Timeline…, Play and Onion stay on screen at 500×340. The folded body is not rendered until Timeline… opens it. In Build at 500×340 the rail scrolls to its two stacking buttons until M3b shows only the workspace's tools. In Simple, Add frame lives in the filmstrip, so at the low tier it is inside the Timeline… sheet (or the A key) until M5 puts it in the header.
- Splitters keep today's keys: the arrows step 12px (Shift: 40), Home, Enter and a double-click restore the default, and Escape cancels a drag; End is not bound.
- Ctrl+1–4 are bound in the desktop app only (`DESKTOP_PANEL_KEYS` in `hotkeys.mjs`); F6, Ctrl+F6, Ctrl+\ and Ctrl+Alt+M everywhere.
- Build's timeline toggle writes Build's arrangement, so Build remembers a shown timeline; entering Draw or Build shows Properties.
- The Layout popover opens under View (under the mark at the minimal tier) with the workspace's default preset first (Animate, Timing, Focus, Review; Draw, Focus; Build, Build + timeline, Focus), then its saved presets. A card is checked while every panel sits where the preset puts it, whichever tab shows. The positions are Properties (Right, Left, Hidden), VFX and Library (With Properties, the other side, Floating, Hidden), Timeline (Full width, Under stage) and Tools (Left, Right). Reset returns the arrangement only: the shared sizes stay, so a height Timing stored stays until Default height or the splitter. When 8 presets are saved (or storage is full) Save as preset… explains why instead of doing nothing. A saved card's menu (right-click, Shift+F10) has Rename…, Update and Delete, without a confirmation. View also gains Panels ▸ (Properties, VFX, Library, Structure, Timeline, checked while shown), Focus mode and Layout….
- `dock-tabs.mjs`: a tab or strip icon dragged past 4px shows one target: Add as a tab over a docked island's tab row, Dock left or right over a dock or the stage's outer quarter (at most 160px), and Float here with Shift or when the panel already floats (so a floating panel moves by its tab). Its menu lists Dock left and right (not its current side), Float (VFX, Library), Fold to strip (Show on a strip icon) and Hide. A menu opened from inside a kit popover mounts inside it instead of `#menu`, so choosing a row does not light-dismiss the popover. `styk.workspace` adds `renameLayout`, `updateLayout`, `canSaveLayout`, `setRail` and `setTimelineSpan`.
- `studio-layout.mjs`, `workspace-layout.mjs`, `workspace-panels.mjs` and `layer-panel.mjs` are removed with the tests §4.6 lists; their cases live in `layout-solver.test`, `layout-schema.test` and `shell-layout.browser`. The preferences smoke also checks that a saved layout and the timeline's width survive a restart. Still open for M1's verify list: the dense-scene splitter measurement and the two-window manual check.

**Goal.** The calm islands shell (three islands on the mist field, the timeline full width by default) with docking, strips, sheets, tiers, presets and saved presets, organised through the Layout popover, tab menus and one calm drag target. It replaces `studio-layout.mjs` and fixes the 500×340 stage (28 px tall today).

**Track A owns:**

- `src/shell/{layout-schema,layout-solver,layout-store,panel-registry,dock-host,dock-keyboard,shell-commands}.mjs`
- `src/styles/layout/{shell,workspace,dock}.css`
- `src/styles/components/{island,strip,tabs,splitter,drop-zone,choice,sheet}.css` (the dock map lives in `choice.css`; sheet is shared with M2, which owns it; A asks B for changes)
- `src/locales/en-shell.mjs`
- `scripts/smoke-preferences.mjs`
- the new tests `layout-schema`, `layout-solver`, `layout-store` and `shell-layout.browser`
- temporarily: `src/user-library.mjs` (remove the tab injection, and make `showView()` show only the library root, never hiding `#inspector` or `.inspector-header`), `src/vfx-inspector.mjs` (make `setVisible()` show only `#vfx-panel` and stop writing `editor._vfxTimelineVisible`, which `dock-host` now derives) and `src/builder-outliner.mjs` (remove its own resizer and `--builder-outliner-w` writes; the width comes from the dock)
- legacy fragments `04`, `15` and `20a`, **including the rail's placement** (`studio.css:28` and `:64`, §2.9): M1 places the rail through the `.shell-rail` layout wrapper, so the rail never loses its position when `--studio-timeline` disappears

**I:**

- `index.html`: island hosts, stage island around `.center` and `#viewport`, static tabs, region hosts, an empty `#user-library` host, `data-ui` roots
- `app.mjs`: `installShell()` replaces `initWorkspaceLayout()`; `fittedView` insets; `styk.workspace`; load order
- `hotkeys.mjs`: panel toggles, Ctrl+\\, F6 and Ctrl+F6, Arrange
- `docs/ARCHITECTURE.md` (workspace section; remove the stale floating claim at `:109`), `docs/animation-modes.md:51`

**Delete:** `src/studio-layout.mjs`, `src/workspace-layout.mjs`, `src/workspace-panels.mjs`, `src/layer-panel.mjs` and the tests in §4.6. First trace indirect uses (`grep` over `src`, `tests`, `scripts`, `desktop`, `videos`).

**Commits.**

1. *"Model workspace layouts as versioned data"* (A: pure modules and unit tests, including ported studio-layout and workspace-layout cases)
2. *"Dock the editor panels as islands"* (I + A)
3. *"Keep the stage usable in small windows and at high interface scale"* (independent width and height tiers, the band's measured minimal step, strips, sheets, the Structure strip in Build wherever the stage would drop under 400 px, the low tier's timeline sheet, stage insets and floors)
4. *"Arrange panels from the Layout menu or by dragging a tab"* (the Layout popover, tab context menus, one calm drag target, float, presets, saved presets, keyboard move, F6; after M2 commit 1)
5. *"Remove the unused floating-panel and layer-panel modules"*

**Verify.**

- `node --test tests/layout-*.test.mjs`
- Browser tests on 47911:
  - `shell-layout` (5 sizes plus 1100×620 and the short windows 1920×520, 1000×450 and 601×441: minimum `#viewport`, never-hidden controls visible and ≥ 24 px, no element outside the window, the rail fully inside `.workspace` and at the same position in Animate, Draw and Build, `#viewport` ancestry rule, splitter keyboard, drag-to-dock, tab-menu and Layout-popover equivalence; **VFX floating and Library docked left keep Properties visible**; the left dock folds before the inspector; Build at 900×640, 800×600, 640×480 and 500×340 with the Structure strip and `#viewport` ≥ 360×200; the timeline's one default height (pinned Camera and Scene plus three content slots, capped in whole rows) unchanged by a VFX tab switch, a Simple ↔ Advanced switch and an added layer (the `#viewport` rectangle is compared before and after), every row reachable by scrolling, and at 500×340 every row reachable through *Timeline ⋯ › Timeline…* in both modes)
  - `integrated-ux-walkthrough`, `thumbnail-akane-integrated`, `animation-mode-sync`, `library-panel`, `vfx-clips` (VFX tab), `creation` (pointer alignment after docking), `builder-outliner` (and the other builder tests that open the outliner), `timeline-invalidation`
- Unit: `npm run test:preferences`.
- Desktop: `env -u ELECTRON_RUN_AS_NODE npm run test:preferences:desktop` (restart persistence, v1 → v2, `float`), `node tests/settings-scale.desktop.mjs` (75, 100, 150, 200%), `node tests/workspace-release-ux.desktop.mjs`.
- Manual: two windows save different layouts, and neither is lost.
- Downgrade: `layout-schema.test.mjs` and `layout-store.test.mjs` replay 1.1's `persist()` (`{ ...loaded, studioVersion: 1 }`) on the frozen v2 fixture and assert that every v2 key survives; an unknown future version is left untouched.
- Perf: splitter drag over `benchmark:dense` gives 0 LoAF over 200 ms, measured inside `shell-layout.browser`.

---

#### M2 Overlay kit and command registry (track B ∥ M1; I integrates)

**Goal.** One overlay system. It fixes the toast under modals, letters reaching hotkeys, the dead `•••` menu, Enter on rename and focus on ×, and adds the palette and the tooltip.

**Status on `main` (2026-09-27).** All six commits have landed. `app.mjs` creates the overlay manager and the toasts (`styk.ui = { overlays, toasts, commands, palette, tooltips, context }`); the menubar, the main menu and every `showCommandMenu` menu (canvas, zoom, `selection-more`, the builder context pages) render into `#menu` through `ui-menu.mjs`, from today's item lists, with labels translated through `MENU_KEYS` (`menuLabelKey`) and shortcuts from the user's bindings; `toast()` and `fail()` go through `ui-toast.mjs`, whose host is raised above any modal, including the `<dialog>`s that feature modules open themselves (the kit listens for the dialog `toggle` event); and the keydown gate, the Space listener and the release of held keys read `overlays.blocksHotkeys()`. Commit 3: the click delegation no longer closes `#menu` (menus close themselves on a press outside), so `#object-actions` opens, toggles and returns focus, and it is marked as a menu button; `showDialog` is `showLegacyDialog` (Enter in a field runs the body's primary; focus starts on `[autofocus]`, the first field or the primary, without the ring after a pointer); rename is `prompt()` (`#rename-input`, with Cancel). Commit 4: `app.mjs` creates the command registry (its context is the workspace mode for now) and one tooltip, which shows the control's name and the registry's shortcut in the current workspace; `refreshHotkeyHints` writes `data-hotkey-title`, `data-hotkey-hint` and `aria-keyshortcuts`, moves a shortcut control's `title` into `data-hotkey-title` (an explicit one wins) and keeps a name the control took from that title as its `aria-label`; the drawing tools show their own bindings. Commit 5: the `command-palette` action (in the `actions` literal; `hotkeys.mjs` binds Ctrl+P, Ctrl+Shift+P and F1, and where hotkeys are off those keys still never reach the browser) opens the palette, a modal `.ui-dialog` anchored near the top, as §3.10 plans (the integration note that called it a popover was stale); *Search commands…* heads the StykAnimate menu. The registry answers every `CATALOG_REQUIREMENTS` name with a reason ("Select a figure first", "In the desktop app"), runs hotkey-only commands through the key's path, and the catalog now labels the zoom presets and the palette itself, so every runtime action has metadata (`overlays.browser` checks it). Commit 6: `app.mjs` queues the release notes and the first-run privacy choice through `overlays.enqueuePrompt` (the notes first; the choice waits until the notes are known) and calls `markReady()` after the first rendered frame; `ReleaseSplash` gained `startupInfo()` and `open({info})` and lost its wait for open dialogs, and the `close` listener and 300 ms timer that offered the privacy choice are gone. Where the landed code differs from the plan:

- `status()` still writes the visible status bar. M3b commit 6 replaces the bar; until then it is the only place results such as "PNG exported" show, and hiding it earlier would drop them. `fail()` writes it and shows the error message.
- A failure's message stays until dismissed (with *Send feedback* on desktop). Most editor preconditions still throw a plain `Error` rather than a `UserActionError`, so they show as errors, not timed warnings; the editor is not changed here.
- The message is never cut: the host spans the widest band centred on the stage that the window holds, and a message wraps only when it is wider than that band (until M3b places it in the stage header).
- Timeline menus (`timeline-menu.mjs`) are not yet an adapter over `openMenu`, and the builder context menu keeps its pages as whole menus: submenus are separate popovers outside `#menu`, which its tests read.
- A menu that a pointer opened focuses its first row without the focus ring, as dialogs do.
- The palette's groups are Commands, Go to (a typed number), In this project (layers; figures on the current frame, outside Draw) and Settings (every `data-setting` of the Interface, Canvas and Animation tabs, opened with the field focused). **Learn** waits for a tutorials destination: the desktop's `openServicePage` knows only `home` and `download`, and IPC is not changed here. A command of another workspace is listed with its reason ("In Build") and does not run; switching workspace first waits for M3b's workspace controller. `SHELL_ACTIONS` (`src/shell/shell-commands.mjs`) does not exist yet, so the action lives in the `actions` literal, which the shell contract scans.
- The recovery offer (today's banner in `#viewport`, `#restore-recovery`) and the update notice (`UpdateUI`'s aside) are already non-modal and show at once, so they are not queued; M3b moves them into the stage's message slot with the snapshot time and file name. There is no first-run hint yet (`hintsSeen.pose` comes with it). `privacy-ui.mjs` needed no hook: the queue waits for its dialog's `close` event.
- A control that still carries a native `title` and no `data-tooltip` keeps its native tip and gets no ink tooltip, so no control shows two; each surface moves its titles to `data-tooltip` when its milestone ports it. Until then, inside the chrome (`installTooltips({adopt})`: the band, the rail, the stage and timeline headers, the view controls, strips and tabs) a native title becomes the control's `data-tooltip` (and its name, when it had none) the first time it is pointed at or focused, so neighbours never show two tooltip styles. Beside a vertical toolbar (the rail, a strip) the tooltip opens on the stage's side, not above. `asset-library.browser.mjs` keeps reading the fallback card's `title` for that reason. A shortcut control's `data-i18n-title` binding translates into `data-hotkey-title`; `data-i18n-tooltip` waits for its first user.

**Track B owns:**

- `src/ui/{overlay-manager,anchor-position,ui-menu,ui-popover,ui-tooltip,ui-toast,ui-dialog,roving-focus,toolbar-overflow,command-catalog,command-registry,command-palette}.mjs`
- `src/ui/ui-context.mjs` as a pure stub (target, numbering and range; there is no scope; its unit test), handed to track C in M3b
- `src/styles/components/{menu,popover,tooltip,toast,dialog,sheet,palette,kbd,button,icon-button}.css`
- `src/timeline-menu.mjs` (adapter, same API), `src/application-menu.mjs` (view over the catalog), `src/hotkey-hints.mjs`
- `src/locales/en-overlays.mjs`
- legacy fragments `09` and `11`
- tests `command-registry`, `overlay-queue`, `toolbar-overflow`, `native-catalog-keys`, `ui-context` (stub cases) (unit), `overlays.browser` and `actions-contract.browser`

**I:**

- `app.mjs`:
  - `showCommandMenu`, `showMenu` and the menubar → Menu and MenuBar into `#menu`
  - `toast`, `status` and `fail` → toasts plus the hidden log
  - the hotkey gate → `overlays.blocksHotkeys()`
  - `showDialog` → `showLegacyDialog`
  - the `command-palette` action, and the `hidden` mirror on `#menu` (§3.4)
  - the startup queue
  - `styk.ui`
- `hotkeys.mjs`: `command-palette` on Ctrl+P, Ctrl+Shift+P and F1
- `src/support-ui.mjs` and `src/privacy-ui.mjs`: queue hooks only (they pass to M6 afterwards)
- the `title` readers moved to `data-hotkey-hint`: `tests/hotkeys-timeline.browser.mjs`, `integrated-ux-walkthrough.browser.mjs`, `join-selection.browser.mjs`, `asset-library.browser.mjs`
- `docs/hotkeys.md` (tooltips, palette)

**Commits.**

1. *"Add shared overlay, menu, popover and dialog primitives"* (B)
2. *"Show errors above dialogs and stop menus from triggering tools"*
3. *"Open the Properties menu and fix Enter and focus in simple dialogs"* (object-actions, rename form, confirmReplace focus)
4. *"Show shortcuts in tooltips from the shortcut registry"*
5. *"Find any command with the command palette"*
6. *"Show startup prompts one at a time"*

**Verify.**

- Unit tests.
- Browser tests on 47912:
  - `overlays` (toast visible above a modal; H with the File menu open leaves the tool unchanged; `•••` opens; Escape returns focus to the invoker; the menu flips near the bottom and shifts inside a 500×340 window, its top never above the band's bottom + 6 px; a pointer-opened dialog shows no focus ring and a keyboard-opened one does; typeahead; submenu keys; a menu inside a dialog is clickable; a picker opened from a popover or sheet keeps its host open)
  - `localization-app`, `hotkeys-timeline`, `timeline-context`, `timeline-polish`
  - builder context-menu tests using `#menu [data-action=split-segment]`
  - `app`
  - three splash tests (`Close welcome screen`)
- Desktop: `env -u ELECTRON_RUN_AS_NODE npm run test:support:desktop`, and the privacy first-run desktop test.

---

#### M3a Seams (I alone; short)

**Goal.** Move code out of `app.mjs` **without behaviour change** so that the M4, M5 and M6 tracks own their code, and make chrome updates surface-scoped.

**Files.** I owns everything here:

- create `src/inspector-bindings.mjs`, `src/timeline-host.mjs`, `src/export-flow.mjs`, `src/app-dialogs.mjs` and `src/ui/ui-invalidation.mjs`, each moved with a context object (`{ editor, state, $, actions, … }`)
- `index.html`: the timeline header slots, the inspector header block, and the stage header slots (start, message, end)
- moves that keep W3 tracks disjoint: the `#timeline-workflow` click listener from `studio-shell.mjs` into `timeline-host.mjs`; `export-flow.mjs` imports `mountExportFlow` directly from `export-panel.mjs` (not through `studio-shell.mjs:109`); the movieclip breadcrumb's mount (`movieclip-ui.mjs:33-34`, which inserts it before `.context-strip`) into a no-op seam, since M4 removes the breadcrumb: the nested scope path ("Clip A › Clip B") becomes the inspector's name line and "← Scene", Done and Cancel become the band's Done (`movieclip-done`, one level) and the movieclip menu's *Cancel editing* (the file then passes to D in M4)
- `tests/playback-quiet.browser.mjs` (with its ratchet allowlist)

**Commits** (each is a pure move verified by the existing tests):

1. *"Move inspector change handling out of app.mjs"*
2. *"Move timeline mounting and transport wiring out of app.mjs"*
3. *"Move export and app dialogs out of app.mjs"*
4. *"Update editor chrome only when its inputs change"* (invalidation plus the playback-quiet test)

**Verify.**

- `npm test`
- Browser tests on 47913: `properties-app`, `property-controls`, `inspector-dom`, `add-frame`, `layer-timeline`, `sheet-filmstrip`, `export-experience`, three `#export-submit` tests, `recovery-interaction`, `playback-quiet`. `export-experience`, `export-auto-quality` and `export-bitrate` remove `showSaveFilePicker` (as `builder.browser` does), because headless Chrome's picker left them waiting for a download in the baseline; they now run the export flow end to end
- `node scripts/benchmark-scrub-backpressure.mjs` (no regression)

**Exit.** `app.mjs` shrinks. Playback mutations are ≥ 90% lower than the baseline (inspector and title quiet).

**Status on `main` (2026-09-27): done** in the four commits above (`03a8d854`, `a7ba1b44`, `452a8991` and the invalidation commit `0e68c135`) and a review fix (the canvas repaint after chrome passes, below); `app.mjs` went from 7,020 to about 5,860 lines. The moves are pure except one detail: wrapping the header in slots made `#range-edit`'s parent `[data-slot=end]`, so at `a7ba1b44` and `452a8991` `syncRangeEdit()` refreshed the hotkey hints of the end cluster only; `0e68c135` restored the toolbar scope (`range.closest('.timeline-toolbar')`), with no visible effect found on either build. What the W3 tracks build on:

- **M4 (D).** `inspector-bindings.mjs`: `inspectorBindings(ctx)` is the ordered `[selector, handler]` table (the first match takes the change; a handler returns `false` to pass it on, `*` is the rig controls' claim), `installInspectorBindings(root, ctx)` the one listener. The header hosts are `[data-slot=inspector-target]` (today's `.inspector-header` with `#inspector-context` and `#object-actions`) and, between it and `#inspector`, the hidden, empty `[data-slot=inspector-head]` for `renderInspectorHead()` and `syncQuickHost()`. The inspector is the quiet `inspector` surface (`renderProperties()` in app.mjs) and VFX its own quiet `vfx` surface; `renderInspector()` still syncs both for direct callers. Not wired yet, as planned: `visible()` from `onVisibility('properties')` and the `camera` surface (the render loop still syncs the camera controls and monitor every frame: ratchet entry `camera-inspector`). `installMovieclipUI` takes `mountBreadcrumb(element)`; app.mjs mounts it before `.context-strip`, and M4 drops the option to retire the breadcrumb.
- **M5 (E).** `timeline-host.mjs`: `createTimelineHost(ctx)` returns `mount()` (the only constructor of `Timeline` and `SheetFilmstrip`, with the app's callbacks), `attach(shell)`, `updateTransport()`, `syncPlayButton()` (writes only when playback starts or stops), `syncRangeEdit()`, `syncMode()` and the `timeline` getter; it owns the `#fps`, `#timeline-zoom` and `#timeline-workflow` listeners. `.timeline-toolbar` has `[data-slot=start]` (`#timeline-workflow`; layer-timeline still inserts `.sheet-header-tools` after it), `[data-slot=transport]` (`.playback-controls`), `[data-slot=end]` (`#range-edit`, the onion pair, `#timeline-audio`) and `[data-slot=ruler-tools]` (`#expand-timeline`, `.timeline-actions` with `#timeline-zoom`), all `display: contents` (`layout/workspace.css`) until the header lays them out; `.timeline-title` and Timeline… stay outside them. Ratchet entries `filmstrip`, `filmstrip-geometry` and `filmstrip-audio-toggle` end in M5.
- **M6 (F).** `export-flow.mjs`: `createExportFlow(ctx)` returns `showExport`, `exportOptions`, `exportPivot`, `saveBlob` and `finishExport`, and registers `export` and every `export-*` command with `Object.assign(actions, …)` before app.mjs wraps the actions (drawing barrier, polygon guard, telemetry). `tests/export-request.test.mjs` compares its legacy blocks with the fixture. `app-dialogs.mjs`: `createAppDialogs(ctx)` returns `confirmReplace`, `showImportNotes`, `chooseSticknodesEntry`, `confirmDiscardFrame` and `showPerformance`, and registers `rename`, `open-recent` and `performance`.
- **M3b (I, C).** `.stage-head` (`role=toolbar` "Stage") sits hidden in `main.shell-stage` directly above `#viewport`, with `[data-slot=stage-start]` (`.stage-head-start`), `[data-slot=stage-message]` (`.stage-head-msg`) and `[data-slot=stage-end]` (`.stage-head-end`); `stage-head.css` hides it while `[hidden]`. `stage-head.mjs` declares a `stagehead` surface on app.mjs's invalidator. Ratchet entries `render-time`, `playback-fps`, `preview-badge`, `preview-quality`, `status` and `frame-badge` end in M3b; `audio-timeline` (and the G2 read `audio-paint`) in M7f.
- **The invalidator.** `ui-invalidation.mjs` (`createInvalidator`, `surface`, `invalidate`, `update(name)` for the render loop's 200 ms transport call, `flushAll`, `show`) drives nine surfaces in today's order: title, transport (`playbackInterval: 200`), layers, vfx, inspector, selection, status, assets, shell; `queueUI()` is `invalidate('all')`, `updateUI()` is `flushAll()`. While playing, every surface except the transport and the title (which writes only when the name or saved state changes) waits for the first pass after playback stops: the layers, VFX, the inspector, Edit selected frames and the stage hint, the status readouts, the Add dialog's lists and the shell, so `#inspector-context`, `#edit-scope` and `#selection-summary` keep their values from before playback too (experience.md §5.8). In today's shell the one visible effect is Properties: its fields and its header's target show the frame and selection from before playback until it stops. `afterPass` (app.mjs: `requestRender()`) runs only after a pass that updated a surface, and a surface waiting for its `playbackInterval` sets one timer for when it is due instead of scheduling a pass every display frame. `dom-write.mjs` compares with the element's live value (not a WeakMap cache, so writes by other code are seen) except `setMarkup`, which compares with the markup it wrote last. Besides the surfaces, studio-shell's sync, the onion controls, the canvas guides, the Library's save button, the drawing quick bar and the breadcrumb now write only what changed. New modules report no telemetry frames until the M0 `ERROR_MODULES` commit lands.
- **Measured** (`tests/playback-quiet.browser.mjs`, 2 s of Advanced playback, startup document plus 6 frames, headless Chrome): 79 nodes and 50 attribute writes (was 885 and 5,338), 111 style recalculations in about 105 ms (was 354 in about 340 ms), no layout reads, no long frames. The canvas draws about 100 times in those 2 s at 24 fps (96 before M3a); at `0e68c135` it drew about 260 at the test browser's 144 Hz, because a pass that only found the transport waiting repainted and scheduled the next pass every display frame. The test now fails above 2.5 draws per animation frame. The final budgets (≤ 26 ms of style recalculation) are M8's.

---

#### M3b Top band, rail and stage (I + track C ∥ M4 ∥ M5 ∥ M6)

**Goal.** The stable frame, revision 4: the band (the mark and its menu, **the visible menubar**, docked down to the minimal tier after the band's labels and spacing fold (revision 4.1), the document button and popover, Undo, Redo, **Save**, the workspace switch, the primary slot with **Cancel** beside Done in a movieclip session, window controls); the rail with only the current workspace's tools; **the stage header** (the location crumb, the tool options framework, the message slot with its collision rule and the mode and quiet variants, the view cluster re-parented from today's `.canvas-view-controls`, zoom and Fit) with nothing inside `#viewport`; the Add menu with *In this project* and *Examples ▸*; the selection menu on the keyboard; the joint hit area; the status bar turned into the hidden log with the Scene's meta line; and **the gates**: the balanced budget and first-glance test, the task test and the function ledger check.

**Track C owns:**

- `src/ui/{ui-context,canvas-chrome-theme}.mjs`
- `src/styles/layout/{topbar,rail,stage}.css`
- `src/ui/tool-options.mjs` (option descriptors, fold order, "More options")
- `src/styles/components/{tool,rail,toolbar,segmented,menubar,stage-head,optbar,split,crumb,message,doc,readout,dot,progress,empty}.css`
- tests `ui-context`, `tool-options`, `i18n-keys` (unit), `stage-chrome.browser`, `ui-budget.browser`, `ui-tasks.browser`; `scripts/check-function-ledger.mjs`
- legacy fragments `02`, `05`, `08`, `20b`, `25a` and `27`

**I:**

- `index.html`: band, rail, stage
- `src/shell/{topbar,workspace-mode,stage-head}.mjs`; delete `src/studio-shell.mjs` and the reader-bound ids
- `app.mjs`: title and save state → topbar; `onWindowState` wiring; `data-platform`; `fittedView` insets; `canvasChromeTheme` for marquee, pivot, polygon draft and sprite placement; keyboard `contextmenu` on `#viewport`; joint cycling with `[` and `]`; the Add menu (Stick figure, Text…, Image…, Import figures…, Movieclip… ─ *In this project* (today's Insert dialog's project library, in the browser too) ─ *Examples ▸*; `#insert-dialog` becomes a hidden compatibility host); the view pill's buttons re-parented into the stage header with their ids; the drawing quick bar re-parented out of `#viewport` into the stage header's tool options (§3.11.8; its controls become Draw's option descriptors in M7b); `pick()` hit radius, body click, right-click filter
- delete only `studio-shell.mjs`'s writes to `#inspector-context`, `#object-actions` and `data-selection-kind` (track D owns the writers in M4)
- `scripts/verify-library-release.mjs` (it lists `src/studio-shell.mjs`)
- `hotkeys.mjs` (`Ctrl+Alt+L` Layout…), `localization-bindings.mjs` (bindings → `data-i18n`; delete `APP_CHROME_BINDINGS`)
- `tests/localization-settings.browser.mjs`, `tests/shell-contract.test.mjs` (`#doc-pop` inside `.titlebar`), `docs/SCENE-EDITING.md` (UI locations)

**Commits.**

1. *"Keep the menubar, Save and Export in one calm top band"* (the menubar docked at every width down to the minimal tier, its labels and spacing folding first; Save beside Export; Cancel beside Done in a movieclip session; Test rig beside Done in Build)
2. *"Show only the current workspace's tools on the rail"*
3. *"Put the location, the tool's options, the view toggles and zoom in a stage header"* (nothing inside `#viewport`; one message at a time in the header's centre, with the mode and quiet variants)
4. *"Open the selection menu from the inspector and the keyboard"*
5. *"Show one first-run hint, once"*
6. *"Replace the status bar with calm save state and a hidden activity log"*
7. *"Grab joints more easily and select figures by their body"* (the acceptance gate is `joint-hit-radius` on the dense corpus)
8. *"Hold the editor to its balanced budget and today's click counts"* (`ui-budget.browser` for the band, rail and stage header regions and the first-glance rule; `ui-tasks.browser` for the tasks whose surfaces exist; `check-function-ledger`; the band fit, the page height and the stage floors over the size sweep)

**Status on `main` (2026-09-27).** Commit 1 has landed as *"Put the workspace switch, save state and Export in one top bar"*. The band (`.titlebar.shell-top`) is three clusters, `.band-start` (the mark `.brand.shell-mark` with its chevron, the menubar as `.ui-menubar`, the document `.ui-doc` with `#project-name`, the dot `#dirty-dot` and `#save-state`), `.band-center` (the workspace switch, moved from the canvas toolbar: `.ui-segmented` items with their concept dot, name and a glyph for the `icons` step; "Build figure" reads "Build") and `.band-end` (the Edit history toolbar with Undo and Redo, moved from `.canvas-options`, which is gone; Save; the compact Properties button; **one** `[data-action=export]`; and, hidden, the session buttons `[data-band-session]`: the movieclip's Cancel, Build's Test rig (moved from the builder bar, with the `test-rig` glyph), the movieclip's and the camera's Done and `#builder-done`, moved from the builder bar). Where it differs from the plan:
- Export is one element whose `data-variant` turns from `primary` to `ghost` in a session (tests click `.titlebar [data-action=export]` in strict mode), not a second `.rf-export2`; the session steps `export2` and `export2out` fold it only while `data-session` is set, and `primary` folds Export's word at rest and Done's in a session.
- `topbar.mjs` measures the band at its **min-content** width: its side columns are `minmax(max-content, 1fr)` around a `max-content` switch, so the switch sits centred while the window allows, and max-content would count the wider side twice. The band's layout and whole-control folds are `layout/topbar.css`; the components it composes and the folds of their words are `features/band.css` (components beat layout), with `components/{dot,doc}.css`.
- The session is app.mjs's `bandSession()` (Build, then a movieclip being edited, then the Camera selected outside Draw and Build), written by `syncBandSession()` from the quiet `shell` surface. The camera session's Done is a new command, `camera-done` (catalog `requires: ['camera-session']`): it leaves the Camera for the figure the session kept selected, or the Scene. Until M4 retires the movieclip breadcrumb, a movieclip session shows its Cancel and Done both there and in the band.
- The document button still runs Rename (the Document popover, `#doc-pop`, is not built yet), and its state reads Edited, Saving…, Saved 12:04 after a save in this session, else Saved (no "Not saved": the app does not know yet whether a document was ever saved). The menubar keeps today's six menus (Editor too: segment surgery stays there until M6's joint menu gains *Edit part ▸*). Undo's tooltip does not yet name the action.

Commit 2 has landed as *"Anchor the tool rail and give each workspace its own tools"*. `src/shell/rail.mjs` owns the rail: `syncRail()` (from studio-shell's sync) shows the workspace's tools (`RAIL_TOOLS`: Animate +, Select and pose, Tweener, Pan; Draw +, Brush, Eraser, Fill, Select pixels, Shapes, Transform, Pan; Build Edit joints, Select figure, Line, Chain, Circle, Polygon, Pan), renames the ones that differ by workspace and marks the active tool; `installRail()` wraps each `[data-rail-menu]` tool (`#open-insert` `add`, `drawing-lasso` `lasso`, `drawing-shape` `shape`) in a `.rail-slot` with a 14px tick button (`.ui-tool-tick-button`) that opens its list, as a right-click, a long press (450 ms, its click swallowed) or ArrowDown/ArrowRight on the tool do; the Tweener keeps its own menu and draws its arrow as the same tick. The markup puts the + inside `.tool-dock`, orders the tools for every workspace (Edit joints before Select) and drops the rail's hidden Isolate (Caps Lock, the selection menu and Build's View menu keep it). Where it differs from the plan:
- Animate's + opens **the Add menu** (app.mjs `addMenuItems`, beside the rail): Stick figure, Text…, Image…, Import figures…, Movieclip… and, for parity with today's Insert dialog, *Movieclip from selection…* and *Movieclip from frames…*; *In this project* lists up to 10 of the project's figures and clips, then *All in this project…* opens today's Insert dialog (search and previews; `studio-shell.showInsertDialog()`); *Examples ▸* has Rig examples… and the example animations. In Draw the + keeps making a drawing layer and its tick opens the same menu, led by New drawing layer. The corner ticks' variant lists set the drawing settings `selectShape` and `shapeKind`, then the tool.
- Animate keeps today's two stacking buttons (`.rail-order`) under its tools until M4's figure quick actions (To front, To back) land; M4 removes them in that commit. Draw and Build no longer show them (a Build part's order is in its Arrange menus and Stacking).
- The rail is not yet one tab stop (no roving focus), and the new tool keys (W, Q, J, K, Y) are not bound: tooltips show today's keys.
- At 500×340 Draw's eight 32px tools overflow the rail by a few pixels (its Pan); the rail's fade and scrollbar say so.

Commit 3 has landed as two: *"Put view controls and tool options in the stage header"* and *"Show a mode's instructions while it is active"*. `src/shell/stage-head.mjs` (`createStageHead`) owns `.stage-head`, now the stage island's first row (Build's bar and the hidden context strip sit between it and `#viewport` until M7a), updated as the quiet `stagehead` surface and at once from `syncShell()` and the settings commit (a workspace or a view toggle changes outside the invalidator, during playback too):
- **Start.** The crumb (`.ui-crumb`: the Scene with `#stage-size`, which it now writes alone, running `scene-settings`, and the background chip `#crumb-background`, a `data-paint-picker` that opens the Scene's colour like `#background-color`); in a movieclip or camera session the scope path ("Scene › Punch", "Scene › Camera"), whose first part runs `movieclip-done` or `camera-done`. `setToolOptions(descriptors, {tool, label})` renders a tool's options with `tool-options.mjs` (created on first use with the command registry, its More options popover mounted in `.stage-head`); no tool declares descriptors yet, and a field descriptor needs PropertyControls attached to `.stage-head` by the milestone that adds one. `adopt(element)` re-parents a legacy host: Draw's quick bar (the same element, once, after DrawingController is built; its preset drawer drops under the header; at compact width its tool name gives way to its options) and, static in the markup, `#chain-controls` and `#polygon-controls`. The crumb shows only while nothing else in the start does (`:has()`).
- **End.** The view cluster re-parented with its ids, each shown in the workspaces its `[data-workspaces]` names: Animate Joints (`#handles-button`, the `joints` glyph), Motion paths (`#paths-button`, which MotionPathControls wraps with its chevron as a `.ui-split`), Grid, Effects preview (`#vfx-preview`, `fx`); Draw Grid and Effects preview; Build Grid, Static handles and Highlight part (`builder-static-handles`, `builder-highlight`). Then `#zoom-label` (its value in `.stage-zoom-value`, written by `placeArtboard()` through `setZoom`) and Fit (`zoom-reset`). Toggles are quiet (`data-quiet`) with `aria-pressed`; their tooltip is their name and shortcut, and their pressed look shows their state. The end is one tab stop (roving focus). **Grid is a split**: `#canvas-guides-button` runs the new `toggle-grid` (catalog entry, default key `Ctrl+'`), and `#guides-options-button` opens Grid and guides (CanvasGuides' new `trigger`; the popover opens under it).
- **Message.** `createToasts({slot})` asks `placeMessage()` where the `#toast` host goes (it stays a top-layer popover, so nothing can cover it; `.stage-head-msg` stays empty): `solveMessage()` (pure, `tests/stage-head.test.mjs`) centres it in the header, else in its room up to the view cluster (zoom and Fit at compact and minimal width, where the view toggles step aside only when it reaches them), covering the start while it shows (`data-msg-over`), or drops it to a line of its own 6px under the header (`data-msg-drop`) when its whole width does not fit or it would cover a focused option. The kit gained the `slot` option, `reposition()` (the header's ResizeObserver and focus changes call it) and an action's `id` and `tip`. The recovery offer is now the recovery message ("Restore unsaved work in *name* from *12:04*?", Not now · Restore, keeping `#restore-recovery` and `#dismiss-recovery`), not a banner over the canvas; the update notice still is UpdateUI's own until its commit.
- **Modes.** The kit gained `show({variant})` (`mode`: tinted, no lift; `quiet`: words on the header; both the lifted pill when dropped), a handle's `update()` (no second announcement) and the `mode` rank between update and recovery. app.mjs `modeMessage()` derives the one mode from state and `syncModeMessage()` shows it through `stageHead.showMode()` (from `setTool`, the stage header's sync, and where Connect joints and image or copy placement start and end): Join ("Click the joint to join to", Cancel), Connect joints (the old passing toasts' words, Cancel), image and copy placement (Cancel), Chain and Polygon (while the tool is active; their own Finish and Cancel are the start's controls) and the Tweener (its type; Esc cancels a drag). `#viewport-hint` stays hidden. **Slow**: the render loop reads the playback rate at most once a second and `showSlow()` shows "Slow · N of M fps · Details" (the quiet variant; Details runs `performance`) only while playback misses its target after its first second and is not buffering; pause clears it.
- **Fit.** `fittedView()` is the solver's insets alone (the in-viewport chrome and its ResizeObserver are gone), so the artboard grows where the view pill or Draw's quick bar used to push it (500×340: 31% in Animate, was 23%, and in Draw, was 20%; 1440×900 is unchanged at 83%). `.artboard-name` is hidden (the crumb names the Scene). `#playback-fps`, `#preview-quality` and `.viewport-top` (`#frame-badge`, `#preview-badge`) wait in the status bar until its commit makes it the hidden log.
- Deviations: Build's Timeline toggle stays in Structure's foot (experience.md §4.4, revision 4.2) rather than the header; Draw keeps Effects preview (one click, as today) beside Grid; the View menu does not list Grid yet. Until M4 drops it, a movieclip session shows the breadcrumb row under the header as well as the crumb's scope path.

**Verify.**

- Browser tests on 47913: `stage-chrome` (nothing interactive inside `#viewport` and nothing over the artboard at fit at 1440, 1280, 1024, 800 and 500 wide; one message at a time, never meeting the view cluster; the recovery message's *Restore* is the element at its centre at 800×600, 640×480 and 500×340; arrow keys on a focused stage-header button leave the pose unchanged; a wheel over the header does not zoom), `ui-budget` (band, rail, stage header; first glance), `ui-tasks` (band and stage tasks), `workspace-clean`, `ui-refresh`, `app`, `integrated-ux-walkthrough`, `creation`, `authoring`, `drawing-tools`, `sprite-placement`, `localization-native-app` (LTR), `localization-app`, `playback-quiet`, `joint-hit-radius`
- Desktop: `env -u ELECTRON_RUN_AS_NODE node scripts/smoke-app-save.mjs` (window controls), `node tests/settings-scale.desktop.mjs`
- `node tests/ui-audit.browser.mjs --scope app` (ported roots)

---

#### M4 Inspector (track D ∥ M3b ∥ M5 ∥ M6)

**Goal.** The inspector from section descriptors, revision 4: a name and one menu, **quick actions** (≤ 5 defaults per context from the registry, the sixth slot for a pin; words where glyphs are hard to tell apart: Front, Back, Split, Duplicate, Remove keys, the Match pair), **core sections** always open with **at most two title actions** each (Arrange's is Join to figure), **titled sections** (collapsible, remembered, auto-opening when their content matters), **the scope line** while Edit together is on, the figure footer's *Add to library*, Use IK and Pin joint as switches in the joint's IK section, no key state, no chips, no prose, and no render during playback or while hidden (including the camera monitor and camera controls). It includes the movieclip instance context (Edit clip and Make unique as quick actions), the figure's Arrange core section (Layer and Z-index), several figures (quick actions, Rotate 15° and Centre as title actions, Align's six buttons), the text, image and layer contexts, the Scene inspector with its meta line, `#stage-size` and Rate (mirroring `#fps`), and the 3D rig inspector (§3.13).

**Track D owns:**

- `src/inspector-view.mjs`, `src/inspector-kit.mjs`, `src/inspector-header.mjs` (the one writer of `#inspector-context`, `#object-actions` and `#inspector[data-selection-kind]`), `src/inspector-bindings.mjs`
- `src/property-controls.mjs` (remove the injected CSS and the ref-count; keep the API), `src/property-toggle.mjs`
- `src/ik-view.mjs`, `src/spatial-controls.mjs` (inspector part), `src/movieclip-ui.mjs`
- `src/styles/features/{inspector,movieclip}.css`
- `src/ui/quick-actions.mjs`
- `src/styles/components/{field,slider,select,stepper,switch,check,swatch,form,section,quick,scope,target,list-row}.css`
- `src/locales/en-inspector.mjs`
- tests `inspector-kit` (unit), and updates to `app`, `authoring` and `ux-audit` for `[data-inspector]`
- legacy fragments `07`, `22`, `25b`, `36` and `42`
- docs: `property-channels.md`, `inverse-kinematics.md`, `figure-stacking-and-property-keys.md`, `movieclips.md`

**Integration requests to I:** `renderInspector` gating is already surfaced by M3a; the `panels.onVisibility('properties')` hook-up; the `camera` surface that replaces the per-frame `syncCameraControls` and `drawCameraMonitor` calls in the render loop (§3.2).

**Commits.**

1. *"Render inspector sections from descriptors"* (no visual change; unit tests unchanged)
2. *"Show the selection's most used commands under its name"* (quick actions, pins; `ui-budget` for the inspector region)
3. *"Keep less used settings in titled sections that remember being open"* (core and titled sections, title actions, auto-open rules, the scope line; `ui-tasks` for the inspector tasks)
4. *"Put Use IK and Pin joint beside the joint's properties"*
5. *"Stop redrawing the inspector while playing or hidden"*

**Status on `main` (2026-09-27).** Commits 1 to 3 have landed, 2 and 3 as one (*"Redesign the inspector with calm sections and quick actions"*). `inspectorDescriptor(options)` (`inspector-view.mjs`) returns `{kind, target, quick, scope, sections}` for every context and `inspectorView()` renders the sections with the kit's own renderers; the legacy skin is gone and `inspector-legacy.mjs` keeps only `numericField`, `group`, `grid`, `heading` and `esc` for `drawing-view.mjs` (M7b). `inspector-header.mjs` is installed by `installInspectorBindings()` (the one call app.mjs makes) and fed by `onInspectorRender()`: it builds the target line in `[data-slot=inspector-target]` around today's `#inspector-context` (kept as visually hidden kind text, the value studio-shell also writes) and `#object-actions` (the kit's icon button; studio-shell's menu until M3b's selection menu), renames in place (double-click, Enter or F2; the input keeps `#figure-name` or `data-movieclip-name`, whose change the bindings or movieclip-ui apply), and writes the scope line and the quick actions (`syncQuickHost`, the registry from `ctx.commands` or `styk.ui.commands`) into `[data-slot=inspector-head]`. Titled sections remember being open in `inspectorSections` (a session `SectionMemory` until app.mjs seeds and saves the setting: request `artifacts/ui-redesign/requests/D-1.patch`). Contexts as in `experience.md` §5.1, with these deviations: the camera keeps its Transform │ Motion tabs and its motion pane (M7e) and Build keeps the builder bar for the part's commands (no part quick actions until M7a); several figures add **Arrange** (Layer and the one-step order today's inspector shows), so `INSPECTOR_BUDGET.coreSections` is 4 (the joint's Figure line is the other); a layer's Visible and Locked checkboxes are gone (its row's eye and lock); Connection shows while there is a connection; the Scene has no Aspect and no `#stage-size` (M3b's status bar); the movieclip breadcrumb stays until the stage header's crumb lands. `camera-view.mjs` is removed (its commands are the camera's quick actions, Transform's title actions and Framing). `spatial-controls.mjs` returns `spatialSections()` (Pose, Body, Limb, Mechanism; titled Exact angles, Perspective, Shape, Choices) and `spatialControlsView()` renders them. `tests/inspector-descriptors.test.mjs` proves in the 64 states that every control of today's inspector (`tests/fixtures/inspector-legacy.mjs`, frozen at `64646330` and `52f13960`) is still there or at its listed new home, with parity checks of the key hooks; `tests/inspector-header.browser.mjs` covers the header. The spec's glyphs (`step-up`, `step-down`, `exact`, `match-prev`, `match-next`, `join-figure`, `dup`, `level`) wait for `icons.mjs` and the catalog (request `D-2.patch`); the order steps draw `arrow-up` and `arrow-down` until then.

**Verify.**

- Unit: `node --test tests/property-controls.test.mjs tests/style-opacity.test.mjs tests/connector-properties.test.mjs tests/rig-asset-boundaries.test.mjs tests/movieclip-presence.test.mjs tests/inspector-kit.test.mjs tests/inspector-descriptors.test.mjs`.
- Browser tests on 47914: `properties-app`, `property-controls`, `inspector-dom`, `figure-z-index`, `hotkeys-timeline` and `polygon-construction` (updated, §4.6), `pistol-3d`, `scythe-asset`, `skateboard-asset`, `spatial-controls` (Pose buttons), `movieclip-*` (the instance inspector), `figure-order-controls`, `branch-opacity`, `style-opacity`, `builder-*` (sample the 10 with `#builder-branch`), `rig-*`, `camera-actions` (inspector shell only), `drawing-ux` (owned widgets survive), `playback-quiet` (inspector 0 mutations).

---

#### M5 Timeline (track E ∥ M3b ∥ M4 ∥ M6)

**Goal.** One header in three clusters (14 controls, one readout) in both modes, with First frame, Loop, the frame rate, Onion's settings and Audio visible as today and only rare rows in the Timeline ⋯ menu; the layer list's header (New layer with rename on create, Find layers) and the ruler's tools (zoom, Fit timeline, Tall timeline); the Simple frame bar; the filmstrip with large cards and one duration bar (figure framing behind its gate); the Advanced sheet drawn as today with a calmer hand (round keys, today's Camera and Scene key colours, neutral cels, a 5-frame rhythm, ruler numbers across the visible span with a faint area past the end, a white-on-blue playhead tab, Camera and Scene pinned with the content rows scrolling beneath them); the frame menu and the range inspector as the homes of easing, Edit together, Remove keys and Delete frames; the Layers popover for Simple; the exposure's end handle, live timing while dragging keys, grips on hover and double-click meanings kept; the user-owned height with the whole-row cap; and the G1 fix. No row-model change (§3.14).

**Track E owns:**

- `src/layer-timeline.mjs`, `src/sheet-filmstrip.mjs`, `src/timeline-header.mjs`, `src/timeline-host.mjs`
- `src/timeline-navigation.mjs`, `src/timeline-organization.mjs`, `src/timeline-menu.mjs` (after M2)
- `src/camera-motion-timeline.mjs` and `src/vfx-clip-timeline.mjs` (paint colours only)
- `src/keyframe-easing-popover.mjs`, `src/keyframe-easing-view.mjs`, `src/onion-timeline-range.mjs`
- `src/styles/features/{timeline,filmstrip}.css`, `src/styles/components/{filmstrip,range-strip,curve}.css`
- `src/locales/en-timeline.mjs`
- the stale-hook test triage (§4.6), `tests/timeline-polish.browser.mjs`, `tests/timeline-organization.browser.mjs`
- legacy fragments `06`, `23`, `40`, and the timeline tokens of `46`
- docs: `layer-timeline.md`, `keyframe-easing.md`, `onion-skin.md`; `TIMELINE.md` and `TIMELINE-DIRECT-EDIT.md` marked historical

**Commits.**

1. *"Share one timeline header between Simple and Advanced"* (three clusters, 14 controls, the Timeline ⋯ menu for rare rows, Strip = header; `ui-budget` for the header)
1b. *"Add and find layers from the layer list's header"* (New layer with rename on create, Find layers; the ruler's zoom, Fit and Tall timeline)
1c. *"Edit frames from the Simple frame bar"* (Inbetweens, Easing, the frame clipboard, Edit together, the layer button)
2. *"Keep the Simple timeline still during playback"* (G1)
3. *"Show frames as large cards with one duration bar"* (the edited dot; figure framing only after its gate passes)
4. *"Draw keys as today with a calmer grid"* (tokens, outline, neutral cels, the quiet area past the end, the playhead tab)
5. *"Manage frames from the range inspector, its quick actions and one menu"* (and *"Drag the end of an exposure to hold a pose longer"*: the visible grip and the live timing label)
6. *"Show and lock layers from the Simple timeline"* (Layers…)
7. *"Keep the timeline at the height you choose"* (shared height, the whole-row cap counted in content rows under the pinned Camera and Scene, the visible scrollbar and fade, the Default height │ Tall timeline pair and the Timing preset writing the shared height)
8. *"Retire stale timeline test hooks"*

**Verify.** Browser tests on 47915:

- `timeline-invalidation` (P5 and P6), `layer-timeline`, `layer-timeline-modern`, `timeline-organization`, `timeline-context`, `timeline-usability`, `onion-timeline-range`, `audio-navigation`, `audio` (header buttons unchanged), `ui-tasks` (timeline tasks), `timeline-polish`, `sheet-filmstrip`, `simple-timeline.component`, `onion-timeline-range`, `audio-navigation`, `hotkeys-timeline`, `animation-mode-sync`, `add-frame`, `playback-quiet` (filmstrip allowlist removed)
- `node scripts/benchmark-scrub-backpressure.mjs`, `node scripts/benchmark-layer-scrub.mjs`, `npm run test:animation-performance:browser`
- dense paint: 302 × 3,000 must stay at or below a median of 0.7 ms and p90 of 1.6 ms (the timeline study `timeline.md` §6, internal research, not in the repository)
- `env -u ELECTRON_RUN_AS_NODE node tests/onion-controls.desktop.mjs`

**Status on `main` (2026-09-27): M5.1 done** in two commits, commit 1 with 1b folded in: *"Share one timeline header between Simple and Advanced"* (`timeline-header.mjs` lays the three clusters out in the static slots and owns Add frame for both modes, the Next copy split, Timeline ⋯, Go to frame and the ruler's tools, which it moves into `#timeline`; the layer list's header is `layer-timeline.mjs`'s) and *"Keep the Simple timeline still during playback"*. Where they differ from the plan:

- `src/styles/features/timeline.css` and its `@import`, the host's `overlays`, the palette's frame jump through `timelineHost.goToFrame` and the name "Edit together" in the catalog, Settings › Shortcuts and the Animation menu landed with the integrator's `ac0ad3e2` (requests `trackE-1` to `trackE-3`). The header still detects the stylesheet (`--ruler-tools-w`) before it gives index.html's controls the kit's classes.
- The header hides First frame, Loop, Audio and Edit together itself at the minimal tier (and Edit together in Draw, Build and on a one-frame file) with `hidden`, because the kit's display beats `layout/workspace.css`'s folds. After the three words, a fourth fold (`celmenu`) moves the Next copy split into Timeline ⋯ where even its glyph does not fit (a drawing layer at about 500px); the header clips (`overflow: clip`), so a focused control never scrolls it and closes a menu.
- Tall timeline sits beside Simple's zoom and Fit too, and Go to frame has neither the Show: Time │ Frames switch (a new setting) nor Ctrl+G (`hotkeys.mjs`). The glyphs are today's (the key jumps chevrons, Tall timeline the bottom panel, Edit together the frame); revision 4.3's are an `icons.mjs` request.
- While playing, the filmstrip renders no card and reads no layout: a 2px line (`.sheet-playhead.sheet-filmstrip-playhead`, transform only) moves to where playback is, and at the stop (`setPlaying`, from `syncPlayButton()`) the current card is selected and revealed. The strip does not follow playback past its visible cards (a page flip would render cards). `playback-quiet` drops the `filmstrip`, `filmstrip-geometry` and `filmstrip-audio-toggle` entries.
- Measured: dense paint (302 layers × 3,000 frames) median 0.4 ms, p90 0.7 ms with the ruler tools' column; 2 s of Simple playback 67 style recalculations in about 80 ms and no layout reads.

**M5.2, commit 1** (1c and 3 as one: *"Show frames as a calm filmstrip with a frame bar"*). The Simple frame bar replaces the sidebar in the label column's place (372px in two columns, 212px in one at compact width, the first line dropped at the short tier): the frame and its hold, the whole length in time, Inbetweens (a stepper for every selected card; `setDuration` takes a count or a function of each card's count, so − and + are one undo step), Easing (a select of today's six modes, Mixed while the cards differ), Copy, Paste, Delete frames, **Edit together** (a switch running `toggle-range-edit`; the host writes its state through `setEditTogether` and the header hides `#range-edit` in Simple) and `#layers-button`, which opens `timeline-layers-popover.mjs` (the layers with their eye and lock, choosing the layer new figures go into, New layer and Drawing layer). Cards: white and rounded, the current and selected outlined in the accent, the count in words on the current, hovered and dragged card, the working copy's edited dot, and one duration bar on the strip's shared scale whose end is dragged by whole inbetweens (a click changes nothing; the range input carries the value for the keyboard); while playing a short line moves along the bars. The card menu drops *Add Frame* (the header's). Where it differs from the plan:
- Its styles, the frame card's included, are in `features/timeline.css` (already imported), not a new `components/filmstrip.css`: only the Simple timeline draws the card, and no hot file had to change. `--hold` is today's neutral duration token (`slate-500`, `slate-550` dark), as the spec's.
- Cards keep today's 5:3 thumbnails and framing (figure framing is deferred, DECISIONS.md); they size themselves to the body up to 168px (72–240 by zoom).
- No easing pins and no ghost *Add frame* card (visual-system.md removes both for density; Add frame is the header's). *Insert inbetween…* stays off the card menu: the dialog's insertion does not change a layer-sheet timeline today (an engine issue, reported).
- The Layers popover has no row menu yet (commit 6: rename, colour, order and delete stay in Advanced's row menu and the inspector's Layer).

---

#### M6 Dialogs, settings and export (track F ∥ M3b ∥ M4 ∥ M5)

**Status on `main` (2026-09-27): commits 1 to 4 have landed**: 1 as `ca098044`, 2 as `ad469ada`, 3 as `788236e3` (*"Redesign the export dialog"*, with the fix `5bc3b9eb` for Windows AVI in the desktop app) and 4 as `73721800` (*"Ask before stopping a running export"*). The dialog is `openExportSheet()` in `export-sheet.mjs`, a kit dialog of its own (`#export-dialog`, not `#dialog`); `export-panel.mjs` is gone. It holds the ExportRequest; Export runs the chosen type's command, which exports the dialog's request, and its progress replaces the settings in place (`showProgress`); a palette export gets `openExportProgress()` and today's defaults. Where it differs from §3.15 and `experience.md` §5.14: Size offers Original, 1080p, 720p, 4K and Custom… (presets keep the artboard's shape, so none is disabled for its aspect; one larger than an export allows is disabled with the reason); Quality is Draft │ Great │ Max over today's Smaller file, Recommended and Higher quality (`#export-video-quality` is a radiogroup with `data-value`); Encoding stays a titled section closed at rest, as today's Advanced video settings ("shown, not folded" is read as no More options), and holds the installed Windows codecs too; a Name field starts on today's file name; the preview draws through a thumbnail worker of its own while the dialog is open (the first exported frame, eight strip cells, ▶ plays the range) and the caption's All (`#export-all-frames`) restores the whole range; From and To count played frames as today, with today's Simple note, not Simple's numbering; at the minimal tier or low height From and To give way to the trim's ends; Transparent is a disabled switch that says whether the type keeps transparency; there is no success message with *Show* (it needs a reveal IPC). A palette export after the dialog was closed without exporting now uses today's defaults (the old dialog left its fields in the page); the other 32 of the 33 equivalence exports saved the same bytes. *Stop exporting?* starts on Keep exporting. Requests: `F-3.patch` (the flow's ctx: overlays, localization, `commitSettings`) with `F-5.patch` (the `exportPreferences` setting); until then the choices last for the session and the dialog is not on the overlay stack (the native modal still gates the hotkeys). `F-4.patch` stops a slow layer change when the export dialog opens over it, `F-6.patch` and `F-8.patch` are the changelog, `F-7.patch` ARCHITECTURE.md.

**Goal.**

- Every dialog uses the kit.
- `ExportRequest` replaces DOM-as-state; the calm export dialog.
- Settings get search and a read-only cheat sheet.
- Splash, privacy, update and feedback shells are restyled.
- Six injectors and two runtime links are removed.

**Track F owns:**

- `src/app-dialogs.mjs`, `src/export-flow.mjs`, `src/export-request.mjs`, `src/export-sheet.mjs` (delete `src/export-panel.mjs`), `src/export-progress.mjs` (mount only; the model is untouched), `src/vfw-export-controls.mjs`
- `src/settings.mjs` (dialog rendering; schema functions unchanged except via I), `src/hotkey-settings.mjs`
- `src/text-dialog.mjs`, `src/background-dialog.mjs`, `src/segment-values-dialog.mjs`, `src/sprite-placement-dialog.mjs`, `src/insert-inbetween-dialog.mjs`
- `src/support-ui.mjs`, `src/privacy-ui.mjs`, `src/support-desktop-ui.mjs`, `src/update-ui.mjs`
- `src/styles/features/{dialogs,export,settings,splash,privacy,update,text-dialog,segment-values,sprite-placement,inbetween,background-dialog,support-desktop}.css`, `src/styles/support-bridge.css`; delete `src/support-desktop.css`
- `src/locales/en-dialogs.mjs`
- tests `export-request` (unit), and updates to `settings.component.browser`, `settings-tabs.desktop` and `export-panel-layout.desktop`
- legacy fragments `10`, `12`, `14`, `24`, `43`, `44`, `99`, and the settings picker of `46`
- docs: `export-experience.md`, `document-exports.md`, `text-authoring.md`, `segment-values.md`, `SPRITE-PLACEMENT.md`, `INSERT-INBETWEEN.md`

**Never edit** `src/support-center.css` or `src/support-center.mjs` (shared with the website).

**Commits.**

1. *"Confirm, rename and choose with keyboard-friendly dialogs"*
2. *"Build exports from an explicit request"* (equivalence gate)
3. *"Make exporting calm and clear"* (Format and a visible Type select `#output-format`; Size presets 1080p, 720p, 4K, Original and Custom, aspect-gated; the trim strip with From and To fields in the active numbering; the type's own settings shown, not folded; "Export MP4"; no destination row; the success message with *Show*; the small-tier single column)
4. *"Ask before stopping a running export"*
5. *"Redesign settings and add a keyboard shortcuts sheet"* (plain-language rows, every group kept, the Feedback tab replaced by a link, the footer's support link moved to *Help › Support development*, focus starting on the first field; `help` → the shortcuts dialog, the only place keycaps appear; `about` → the About dialog)
6. *"Restyle the text, background, segment, inbetween and sprite dialogs"*
7. *"Restyle the welcome, privacy, update and feedback surfaces"* (the trace banner becomes a message; support sheets move from `layer(legacy)` to `layer(features)`)

**Verify.**

- `node --test tests/export-progress.test.mjs tests/export-request.test.mjs`.
- Browser tests on 47916: `export-experience`, 3–4 `#export-submit` tests (including GIF and PNG), `settings.component`, `localization-settings`, `text-dialog`, `text-app`, `insert-inbetween-dialog`, `sprite-placement`, the segment-values and background tests, and 3 splash tests.
- Desktop: `node tests/settings-tabs.desktop.mjs`, `node tests/export-panel-layout.desktop.mjs`, `env -u ELECTRON_RUN_AS_NODE npm run test:support:desktop`, `npm run test:support:ui`.
- `git diff --exit-code src/support-center.css src/support-center.mjs`.
- `npm run site:test`.
- Export equivalence hashes are recorded in `artifacts/ui-redesign/export-equivalence.json`.

---

#### M7 Feature tracks (parallel; each track owns only its files)

Every track:

- removes its injected CSS and its legacy fragments
- moves canvas-drawn chrome to `canvasChromeTheme` with 11 px text and localized strings
- adds `(hover: none)` rules
- converts inspector content to descriptors
- runs `npm run check`, `npm test` and its browser list on its own port

| Track | Owns | Legacy fragments | Key checks |
|---|---|---|---|
| **7a Builder** (47917) | `builder-mode`, `builder-toolbar`, `builder-outliner`, `builder-context-menu`, `builder-surface-ui`, `builder-construction`, `builder-duplicate-preview`, `rig-controls`, `rig-test-ui`; `features/{builder,rig}.css`; `en-builder`; docs `BUILDER-*.md`, `RIG-CONSTRAINTS.md`, `polygon-construction.md` | `13`, `21`, `30`, `31` | Build keeps today's view by default, the white artboard at fit canvas with the figure being built (the construction desk, with "Show scene behind", is a pending option in §6: built only after the owner's sign-off, with `editorBackgroundColor` alpha 0 and `clipToCanvas: false` verified on the WebGPU and Canvas 2D paths first); the Structure tree keeps today's labels (`segment.name || kind + id`) with quiet static and hidden glyphs instead of badges; Done in the band's primary slot as the only ink primary; Test rig in the rail's extra slot; the part menu, the home of every part-level command (Split, Duplicate part, Select branch (`builder-context-select-branch`), Exact values ─ Flip ▸, Arrange ▸ (`segment-order-*`) ─ Copy appearance, Paste appearance ─ Isolate joint, Set as origin ─ Remove joint keep ends, Delete part (`delete-single-segment`), Delete branch; with a fill targeted, Bring fill to front, Send fill to back and Delete fill (`builder-context-fill-*`, `-delete-fill`); `reference/31`), replacing today's builder context menu pages (their tool rows are the rail; *Builder view…* is View › Build); the Figure menu (Build's app submenu) as their index plus *Find part…*; Static handles, Highlight part and Smart snapping (today's `#builder-snap` in the Structure header) in *View › Build*; **revision 4:** the builder bar's commands become the part's quick actions (Split, Duplicate part, Flip, Flip vertically, Delete part) and Edit joints' tool options (`#rig-mode`, still a native select; `#builder-branch`, a toggle button with `aria-pressed`, `B`; `#builder-snap`, as today), the Attachment core section holds *Connect joints…*, *Attach image…* and *Weighted joint* (`rig-weighted`, `rig-weighted-*`), Stretch is a titled section with the Smart Stretch switch on its title row, and Build's view toggles (Static handles, Highlight part, the Timeline toggle) sit in the stage header; **Structure folds to its strip wherever docking it would leave the stage under 400 px and opens as a sheet over the stage** (`panel-toggle-structure`, `data-left`; `#viewport` ≥ 360×200 in Build at 962×700, 961×700, 901×700, 800×600 and 500×340); `#chain-controls` and `#polygon-controls` become Edit joints' tool options while drawing (Finish, Cancel); builder exit through `choose()` with the four `#builder-exit-*` ids; Structure rows 30 px with a 14 px indent; no segment highlight (`builderHighlightSegment` stays false). Tests: `builder-*.browser` (the ten `#builder-branch` users unchanged), `rig-*.browser`, `builder-outliner` unit |
| **7b Draw** (47918) | `drawing-controller` (UI parts only), `drawing-view`, `drawing-sliders`, `drawing-pressure-curve`; `features/drawing.css`; `en-draw`; `DRAWING.md` | `00` | **Revision 4:** the quick bar (`drawing-controller.mjs:245`, mounted in `#viewport`) becomes **Draw's option descriptors in the stage header** (the colour pair, Swap, Size, Opacity, Flow, Smooth, Mirror as one labelled pair, Pen pressure for Brush; each tool its own, with fold order, twins and homes; the pixel selection's Apply, Deselect, Flip and Delete pixels while a selection exists); **revision 4.1:** the cel commands are Draw's timeline header split (*Next copy ▾*: Next copied drawing, Next blank drawing, Blank drawing here, Copy drawing here, Extend) where today's *Next copied drawing* button is, and New drawing layer is the layer list's + in Draw, so the inspector holds the drawing target and **the tool's section** (Brush: today's 14 presets and saved ones as a five-column grid, Recent, Hardness, Blend (labelled), Lock alpha; *Save preset* as its text action; a saved preset's menu has *Delete preset*), Layer (Opacity, Blend labelled), and **Brush details** (one titled section for Tip, Stroke, Texture, Dynamics); the default Draw inspector fits at 1440×900; the pixel selection menu (right-click with Select pixels or Transform; a painting tool's right-click keeps today's palette) lists every selection command; `ui-budget` covers every tool (≤ 80 in the window with headroom; Draw 74 in the budget count; revision 4.3 counts every visible target too: 105, and 93 on a new file against today's 72, with a frozen ceiling per default); Filters gain *Invert*; the pixel selection menu adds the clipboard group and *Delete pixels*; a drawing layer's row menu adds *Duplicate layer*; the Pan tool's section is View › Rotation; More › Cel adds Filtering and *Resample…* and every layer context's More › Parallax is today's parallax panel; the pressure curve keeps `data-inspector-owned` when it remounts; the colour pair in the rail opens the colour picker; nothing floats over the drawing. Tests: `drawing-tools`, `drawing-ux`, `drawing` unit; `env -u ELECTRON_RUN_AS_NODE npm run test:drawing:desktop`; `npm run benchmark:drawing-load` |
| **7c Library** (47919) | `user-library`, `library-drag`, `library-hover-preview` (reduced-motion in JS), `asset-library`; `features/library.css`; `en-library`; `scripts/verify-library-release.mjs`; `asset-library.md` | `17`, `39` | **Revision 4:** sources *This project │ Mine │ Examples* (This project reads the document's cast, clips and backgrounds, as today's Insert dialog; Examples are today's rig examples and example animations), a Kind filter, the library menu (Preview background, Animated previews), and the folder path with New folder, Show in folder and Refresh (today's toolbar buttons). The grid stays a CSS grid; drop zones call `preventDefault`. Tests: `library-panel`, `user-library-ux.desktop`; `npm run test:library`; `env -u ELECTRON_RUN_AS_NODE npm run test:library:desktop` |
| **7d VFX** (47920) | `vfx-inspector`, `vfx-clip-inspector`, `vfx-clip-controls`, `vfx-key-channel-menu`, `vfx-gizmos`; `features/vfx.css`; `en-vfx`; `VFX.md` | `37` | The effects as one grid (one tab stop) of rows with a dot and a switch, pose effects and effect clips in one row model; **revision 4.1:** *Apply to* as a labelled select under the name, *Show* as a labelled row whenever the filter hides effects, the header menu (Show, *Paste effect*), a visible *Presets* button beside *Add effect*; the effect menu (Copy effect, Duplicate effect, Move up, Move down, Rename…, Combine with…, Visible keys…, Reset effect, Remove effect), opened from a row and from the effect's clip row in the timeline, so today's per-effect card buttons and the clip menu's items have one home; the catalogue popover (search and an Effects │ Presets switch pinned; today's 22 effects in their six categories and 13 looks, scene-only entries dimmed with their reason) opens with `showPopover({ source })` so an inspector sheet stays open; **the key diamonds of `vfx-clip-inspector.mjs` become the parameter menu** (Add key at frame N, Remove key (listed only when the parameter has a key at the playhead), Previous, Next, Easing, Reset value; `K` on a focused parameter) with the same editor calls (`toggleVfxClipKey`, `setVfxClipParameter`); the channel filter moves to the clip row menu (*Visible keys ▸*); VFX rows follow `panels.isVisible('vfx')` (M1); empty state "No effects on Bubble" with **today's twelve suggestions as tiles** (Glow, Outline, Shadow, Blur, Particles, Aura, Energy beam, Explosion, Smoke, Power up, Neon, Hit flash; `vfx:quick`), *All effects…* and *Presets*; *Paste effect* beside *Add effect* while an effect is copied. Tests: `vfx-clips`, `vfx-*` (`--render-only` for expansion and strength), `vfx-empty-state` (`STYK_URL`) |
| **7e Camera** (47921) | `camera-view`, `camera-motion-ui`, `camera-motion-graph`, `camera-monitor` (colours), `camera-overlay` (colours and strings); `features/camera.css`; `en-camera`; `camera-controls.md`, `camera-motion.md` | `26`, `38` | Today's blue camera colour through `--sheet-camera-accent` and `--sheet-camera-line` (keys and the session frame); monitor paused when hidden; the camera's **Preview** section (today's monitor, `data-camera-monitor`; paused while hidden or playing), **revision 4:** the camera's quick actions (Level, Centre, Fit view, Reset, Guides, and **Motion ▾**, a preset list that adds a clip at the playhead), Transform with *Copy camera* and *Paste camera* as title actions, the titled Motion clips (the list, *Bake all*) and Framing (Centre X/Y, Match previous/next, Apply to figures), and the Camera menu (Copy camera, Paste camera, Reset camera); clicking a figure or another row leaves the session; the **motion clip context** (Timing: Start, Duration; Motion: Strength and the type's parameters; More › Graph, Noise with *Randomize*, Fades) whose header menu is the camera motion menu (Preview motion, Mute, Duplicate, Bake clip range, Delete); today's Transform │ Motion tabs dissolve; `camera-edit` registered around today's `selectTrack({ id: 'camera' })` for the Scene menu's *Edit camera*. Tests: `camera-actions`, `camera-live`, `camera-motion-scrub`, `camera-motion-graph` and `camera-monitor-visibility` units |
| **7f Audio** (47922, after M5) | `audio-timeline`; `features/audio.css`; `en-audio`; `AUDIO-UX.md` | `41` | G2 fix (no per-paint `getComputedStyle` or canvas resize); mint waveforms; today's Audio view and 64 px rows (the Simple lane and 40 px rows are phase 2, §3.14). Tests: `audio-navigation`, `audio-ux` (baseline-compare), `playback-quiet` (allowlist removed) |
| **7g Canvas aids** (47923) | `onion-controls`, `canvas-guides`, `motion-path-controls`, `tweener-controls`, `spatial-gizmo` (colours), `color-picker`, `color-picker-magnifier`; `features/{onion,guides,motion-path,tweener,color-picker}.css`; `en-aids`; `onion-skin.md`, `MOTION-PATHS.md`, `TWEENER.md` | `18`, `32`–`35` | The onion settings go through `ui-popover` with today's defaults and the saved colours; `#path-popover` and `#canvas-guides-panel` are ported to `ui-popover` and open from the View menu items *Motion path settings…* (`.path-options-button`) and *Grid and guides…* (`#canvas-guides-button`, `Ctrl+'` through an integration request to I for `hotkeys.mjs`), anchored to the stage (ids kept; Settings › Canvas holds neither); the Tweener's options (Breakdown │ Neighbor │ Push │ Relax, Amount) become its tool options in the stage header, and the Tweener keeps the figure inspector; the colour picker opens with `showPopover({ source })` from any host popover or sheet. Tests: `onion-*`, `tweener`, `color-picker-*`, `canvas-guides`, motion-path tests |

---

#### M8 Polish, accessibility, responsive and performance; legacy removal (I + QA track G)

**I:**

- delete `src/styles/legacy/**`, `legacy-bridge.css` and their imports
- unscope `base/elements.css` and apply the `html` `font: var(--type-ui)` shorthand
- lint strict mode: an empty ratchet baseline, then remove the ratchet code
- remove the `showDialog` alias once no caller remains
- final `index.html` and `app.mjs` clean-up (dead `.context-strip`, `.rail-bottom`, `.timeline-actions`, `#frame-badge` readers if not already done)

**Track G** owns the audit tools and test updates. It files findings to the owning module's last owner. Fixes are applied serially by G with I's approval, since all tracks have finished.

**Verify (the release candidate for the redesign).**

- **Full a11y, budget, task and function audit:** `node tests/ui-audit.browser.mjs --scope app`, `node tests/ui-budget.browser.mjs` (balanced budget and first glance), `node tests/ui-tasks.browser.mjs` (all 53 tasks) and `node scripts/check-function-ledger.mjs` across Animate, Draw and Build × Simple and Advanced × light and dark × 1440, 1280, 1100×620, 1024, 800, 500×340 and the short windows 1920×520, 960×520, 911×485, 1000×450, 853×453, 640×480 and 601×441 × joint, figure, **several figures** and none selected, **each Draw tool** (Brush, Eraser, Fill, Select pixels, Shapes, Transform, Pan), a frame range, the Tweener and the movieclip, camera and Build sessions, plus every dialog, popover and menu at 1440, 800×600 and 500×340 (the reference's 116 states and its 52 rest states are the checklist, including Build at 962, 961, 901, 800 and 500 wide, the low tier's timeline sheet, the narrowest bands, messages and menus at the small tiers), plus the size sweep (33 widths × 29 heights in Animate, Draw, a camera session and Build: `#viewport` ≥ 360×200, the stage floors, the band and window controls, the page height). The budget counts the timeline's whole header area (the toolbar row and the layer list's title, ≤ 9), a one-tab-stop collection once, and reach follows each tier's declared path (*Timeline…*, the Structure strip). The result must be 0 text below 11 px, 0 text contrast failures, 0 focus-ring or control-boundary pairs below 3:1, 0 targets under 24 px, 0 controls off-screen outside scroll regions, 0 overflowing bars, 0 budget failures in the rest states, every canvas-read token resolved, a visible focus everywhere including `#viewport`, and no key traps (Tab never cycles joints; F6 reaches every region).
- **Forced colours and reduced motion:** Playwright `emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' })` snapshots, and a check that `--surface` resolves to `Canvas` in the **light** theme (the theme blocks must not win over the forced-colours mapping) and that the canvas painters repaint with system colours.
- **Locales:** snapshots for `el`, `de`, `pl`, `ru`, `ar` and `zh-Hans` (no clipping; the shell stays LTR).
- **UI scale:** `node tests/settings-scale.desktop.mjs` at 75, 100, 150 and 200%; dialogs at 1000×680 and 200% in packaged Electron do not overlap the drag region.
- **Performance** (same workloads as the baselines): `npm run benchmark:dense`, `npm run benchmark:animation-modes`, `npm run test:animation-performance:browser`, `node scripts/benchmark-scrub-backpressure.mjs`, `node scripts/benchmark-playback-interactions.mjs`, and `playback-quiet` with the final budgets (§3.2). Tradeoffs are reported explicitly.
- **Usability acceptance matrix** (`docs/audits/UI-UX-OVERHAUL-AUDIT-2026-09-09.md:211-230`), measured against the M0 baseline.
- **Packaged:** `npm run pack && npm run verify:package && env -u ELECTRON_RUN_AS_NODE npm run test:desktop:packaged`, plus the other smoke suites: `test:hotkeys:desktop`, `test:preferences:desktop`, `test:library:desktop`, `test:support:desktop`, `test:recovery:desktop`, `test:drawing:desktop`.

**Commits.**

1. *"Remove the legacy stylesheets"*
2. *"Apply the type scale everywhere"*
3. *"Make every control reachable and visible by keyboard"*
4. *"Hold the redesign to its accessibility and playback budgets"*

---

#### M9 Documentation and changelog (I; optionally a docs agent that owns `docs/**` except the hot docs)

- **Rewrite** `docs/DESIGN-SYSTEM.md` as an index of `docs/design/*`. **Update** `docs/ARCHITECTURE.md` (UI layer, shell, kit, layers and lint), `docs/LOCALIZATION.md`, `docs/hotkeys.md` and `docs/animation-modes.md`. Sweep the 28 docs that describe UI locations (`completeness-critique.md` §2.10, internal research, not in the repository). Retire `docs/TIMELINE.md` and `docs/TIMELINE-DIRECT-EDIT.md`.
- **`CHANGELOG.md` `Unreleased`**: one entry per outcome, moved from `docs/design/CHANGELOG-DRAFT.md` (drafted at earlier milestone closes). M9 finalizes the wording and removes the release-freeze marker once the owner lifts the freeze.
  - "A calmer editor in the new StykAnimate look: fewer controls on screen, a clear stage, and everything else one click away in menus."
  - "Arrange panels from View › Layout or by dragging a tab, and save your own layouts."
  - "Find any command with the command palette (Ctrl+P)."
  - "The editor stays usable in small windows and at 200% interface scale."
  - "Playback no longer redraws the panels, so animations play more smoothly."
  - "Error messages now appear above open dialogs, and Escape asks before stopping an export."
  - "Menus no longer switch tools while you type, and the Properties ⋯ menu opens again."
  - "Joints are easier to grab, and clicking a figure's body selects it."
- **Verify** with `npm run changelog:check`, and check that every path and link in the touched docs exists (a small `node -e` scan).
- **Commit:** *"Document the redesigned editor"*.

### 5.4 Ownership timeline for shared files

Only one active owner per file at any time. "–" means the file is frozen (changes go to I on request).

| File | M0 | M1 | M2 | M3a | M3b | M4 | M5 | M6 | M7 | M8 |
|---|---|---|---|---|---|---|---|---|---|---|
| `index.html`, `src/app.mjs`, `src/styles/app.css` | I | I | I | I | I | – (I) | – (I) | – (I) | – (I) | I |
| `src/hotkeys.mjs`, `src/icons.mjs`, `src/telemetry-schema.mjs`, `src/locales/en.mjs`, `it.mjs`, `src/localization-bindings.mjs` | I | I | I | – | I | – | – | – | – | I |
| `src/settings.mjs` | I | – | – | – | – | – | – | F | – | I |
| `src/user-library.mjs` | – | A (tabs, `showView`) | – | – | – | – | – | – | 7c | G |
| `src/vfx-inspector.mjs` | – | A (`setVisible`) | – | – | – | – | – | – | 7d | G |
| `src/ui/ui-context.mjs` | – | – | B (stub) | – | C | – (read) | – (read) | – | – | G |
| `src/studio-shell.mjs` | I | – | – | I (listener, export import moved out) | I (deleted) | – | – | – | – | – |
| `src/builder-outliner.mjs` | – | A (resizer only) | – | – | – | – | – | – | 7a | G |
| `src/movieclip-ui.mjs` | – | – | – | I (anchor) | – | D | – | – | – | G |
| `src/timeline-menu.mjs` | – | – | B | – | – | – | E | – | – | G |
| `src/support-ui.mjs`, `src/privacy-ui.mjs` | – | – | I (queue hooks) | – | – | – | – | F | – | G |
| `src/styles/components/sheet.css` | I (split) | – | B | – | – | – | – | – | – | G |
| `src/styles/components/{island,strip,tabs,splitter,drop-zone,choice}.css` | I (split) | A | – | – | – | – | – | – | – | G |
| `src/styles/components/{menu,popover,tooltip,toast,dialog,palette,kbd,button,icon-button}.css` | I (split) | – | B | – | – | – | – | F (dialog variants via B's API) | – | G |
| `src/styles/components/{tool,rail,toolbar,segmented,menubar,stage-head,optbar,split,crumb,message,doc,readout,dot,progress,empty}.css` | I (split) | – | – | – | C | – | – | – | – | G |
| `src/styles/components/{field,slider,select,stepper,switch,check,swatch,chip,kbd,form,section,more,target,list-row}.css` | I (split) | – | – | – | – | D | – | – | – | G |
| `src/styles/components/{filmstrip,range-strip,curve}.css` | I (split) | – | – | – | – | – | E | – | – | G |
| `CHANGELOG.md`, `docs/ARCHITECTURE.md`, `docs/DESIGN-SYSTEM.md` | I | I | I | I | I | I | I | I | I | I |

---

## 6. Decisions and exceptions that need sign-off

These are not implemented until they are approved. The plan works without them.

| Item | Why it needs approval | Without approval |
|---|---|---|
| Filmstrip figure framing (union of figure bounds): a pending option | A thumbnail-worker change | Built in M5 only behind its gate (`benchmark:dense`, thumbnail churn) and after sign-off; otherwise today's artboard framing in the larger card, which is what the reference shows |
| Non-modal export progress (a task message while editing) | Revision coupling (`app.mjs:3577`) | Progress stays in the export dialog; success is a message |
| Window bounds persistence, `titleBarOverlay` with snap layouts, native theme sync, cross-window live preference sync, an **atomic layout merge in the main process**, **macOS traffic lights centred under UI zoom** | `desktop/main.cjs` or new IPC | Out of scope. Merge-on-write narrows the layout-loss race (§3.11.6); the traffic lights stay inside the ≥ 44 pt band. |
| **Release freeze** for the programme (§1 rule 6) | Owner decision; tags can publish immediately | M0 commits 5–7 and everything after them do not start (commits 1–4 are on `main` already: the contract guard and snapshots, the layered entry, the lint and the fonts) |
| **Release precondition:** deploy the cloud worker with the extended `ERROR_MODULES` before shipping | Publishing is not authorized for agents | The M0 `ERROR_MODULES` commit is held until the deploy is scheduled |
| Export aspect presets that differ from the artboard (letterbox or crop) | Export-pipeline change | Disabled with a reason |
| Recovery with several snapshots, an export destination row, per-document export choices | Core or IPC | "Restore last session" until the next backup; the saved path in the success message; global `exportPreferences` |
| **Construction desk for Build** (a pending option: the dotted desk without the artboard, fitted to the figure, with Show scene behind) | A default change: today's Build shows the artboard at fit canvas; also needs `editorBackgroundColor` alpha 0 and `clipToCanvas: false` honoured by both render paths | Build keeps today's view (the artboard at fit canvas), which is the reference's default |
| Phase 2 timeline: group bands, 40 px audio rows, a Simple audio lane | Row-model and hit-test change in six modules (§3.14) | Today's row model and Audio view |
| **Revision 4.3:** the timeline's row-layout function (Camera and Scene 24px, content rows 32, 28 at the short tier) and the default height it serves (4½ / 4 / 3 content slots, the vertical insets giving way) | A hit-test and constant change in five modules (the phase 2 row-layout function, brought forward), and the stage trade it makes (91% at 1440×900 against revision 4.2's 95%) | Revision 4.2's heights and uniform 32px rows (fewer layer rows than today's app at every size) |
| **Revision 4.3:** segment surgery in Animate saying its scope and offering Undo | The owner's view (the commands and their shared-figure behaviour are today's; the scope row and the message are new) | The same submenu without them |
| **Revision 4.3:** a live drop preview on the canvas (the renderer draws the dropped result; no outline, glow or highlight) | The canvas veto | The cursor's badge and the message slot only |
| "Hide panels while playing" | It would resize `#viewport` at play start unless refits are suppressed | Deferred |
| **Revision 4:** the new default keys (`W` Tweener, `Q` Transform, `J`, `K`, `Y` in Build, `Ctrl+G` Go to frame, `Ctrl+'` Grid and guides) | They add default bindings (none changes an existing one; conflict-checked against `hotkeys.mjs`) | Bindable commands with no default key |
| **Revision 4:** quick-action pins | A small layout-store field (`pins`, §3.11.2) | Quick actions fixed per context |
| **Revision 4:** dropping a swatch on a limb, an effect tile on a figure, an image on a joint | Hit-testing on drop through the existing pick path (no renderer change) | The inspector paths only |
| **Revision 4:** the "Slow · N of M fps" message | A throttled read of today's playback statistics | Help › Performance only |
| **Revision 4:** cel thumbnails in the Advanced grid | The thumbnail worker's gate, as the filmstrip's | Neutral cels |

**Withdrawn in revision 3** (they only served removed features or default changes, so nothing needs approving): the "has key at tick" read query, a set-length command, violet/mint onion defaults, Simple by default and the `settingsVersion: 2` migration, the inspector folded by default, display aliases for a joint pill, and (3.2) *A* keying only the targeted row in Advanced (*A* keeps today's routing).

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| New `base` rules restyle unported legacy UI | `[data-ui]`-scoped element rules until M8 (§2.1); the M0 zero-pixel snapshot gate; `ui-audit --scope app` per milestone |
| Legacy `!important` and unlayered injected CSS beat ported surfaces | Injectors wrapped in `@layer legacy` in M0; the generated `legacyImportant` inventory and `check-css --ported`; the lint ratchet JS01; visual review per surface |
| A release is tagged while `main` is half-migrated | The release freeze and the `release:prepare` marker check (§1 rule 6); changelog entries stay in a draft until M9 |
| Feature modules hiding each other's panels | `dock-host` owns visibility from M1; `shell-layout` covers stacked, floating and left-docked panels |
| Nested overlays light-dismissing their host sheet or popover | The nesting rule (§1 rule 5) applied to every existing nested overlay; `overlays.browser` cases |
| The `app.mjs` bottleneck | M3a seams move each track's code into its own module; integration requests are batched as patches; I commits one coherent change per step |
| Other sessions editing `app.mjs` or `CHANGELOG.md` concurrently | `git diff -U0` before staging; stage own hunks only with `git apply --cached` on trimmed patches; never reset |
| Startup cost of about 85 `@import`s | Measured gate at M0; concatenate per owner if above +25 ms |
| Font block delaying first paint | Preload the two latin files (`block`, hidden by the pending-theme mask); every other subset uses `swap`; nothing awaits fonts; measure time-to-`styk.ready` |
| Telemetry snapshots rejected after release | Deploy order (§3.17, §6) |
| Tier or tooltip churn breaking tests that rely on `title` | Tests updated in the same commit (§4.6); `data-hotkey-hint` and `aria-keyshortcuts` expose the same data |
| Chrome creeping back onto the stage or into the rest state as features land | The budget is a test (`ui-budget.browser`, M3b onward) and the M8 audit; `stage-chrome.browser` asserts nothing overlaps the artboard at fit; new controls must name their single home in `experience.md` §8 |
| Two windows saving layouts at the same moment | Merge-on-write with a stamp re-check and one retry; the residual race is documented (§3.11.6) and the atomic merge is a §6 item |
| Video capture scripts (63) and `verify-app-guide.mjs` (38 recipes) break | Out-of-repo follow-up (§8); the §4 contracts keep most selectors (`#vfx-panel`, `#inspector`, `#range-edit`, `#viewport`, `#tweener-button`, `#builder-bar`, `#builder-done`, `#menu`, `#toast`, `#static-joint`, `#segment-shape`). `#status` becomes hidden but still exists. Controls that moved into menus (Loop, fps, zoom, audio) need their capture steps updated. |

## 8. Follow-ups outside this repository and after M9

- Re-run `videos/tutorials/_capture/tools/verify-app-guide.mjs` and update the capture scripts that used the canvas toolbar, the status bar, the floating view controls, or header controls that moved into the Timeline ⋯ menu.
- Re-shoot the website's `media/editor-current-1280.webp`, which is used by `download/index.html:50`, the `index.html:54` JSON-LD and `scripts/seo.mjs:46`.
- Mark the recorded tutorials and the 1.1 launch film as showing the previous UI.
- Deploy the telemetry schema (§6). Shipping itself follows `docs/RELEASING.md` only when it is authorized.
