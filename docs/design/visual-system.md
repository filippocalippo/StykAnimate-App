# StykAnimate visual system (revision 4.3, "Simple at a glance, powerful underneath")

The visual system for the StykAnimate redesign. Revision 4 keeps the Islands backbone and the brand (the StykAnimate site: white and mist, Inter Tight and Inter, an ink pill primary, one Styk blue, concept colours used sparingly) and encodes both of the owner's standards: **clean, easy to use and beautiful to look at in every way, never overwhelming, at home at first glance**, and **"simple to use but super powerful … all the functionality we have now and room for even more"**. Revision 3 reached calm by hiding; revision 4 reaches it through **structure**, so that everything used often can stay visible without the window feeling crowded.

| File | What it is |
|---|---|
| `src/styles/tokens.css` | The shipping tokens: primitives, light and dark semantic tokens, scale, canvas-read tokens, `::backdrop`, reduced motion, forced colours |
| `src/styles/base/fonts.css` | Local `@font-face` rules for Inter (opsz) and Inter Tight with every subset the 27 locales need |
| `design/app-ui/components.css`, `components.md` | The `.ui-*` vocabulary, with revision 4's quick actions, titled sections, tool options bar, split button, crumb, scope line and menubar |
| `design/app-ui/tokens.css` | Revision 4.3's token values, which the reference renders with, until `src/styles/tokens.css` adopts them |
| The component gallery (`gallery.html`, `gallery-light.png`, `gallery-dark.png`) | Every component in its states, both themes, and the editor in context (internal design material, not in the repository; M0 commit 7 rebuilds it as `tests/fixtures/ui-gallery.html`) |
| The spec's tools | `build-gallery.mjs` + `shoot.mjs` (gallery audit), `contrast.mjs` (the matrix in 3.6), `specificity.mjs` (the CSS09 budget); internal design tooling, not in the repository |

**What is measured.** The gallery (both themes) and the 200 reference states (revision 4.3) are audited with Playwright for text below 11px, text contrast (4.5:1, 3:1 large), targets under 24px and canvas-read tokens that must resolve to plain colours; the reference audit adds off-screen controls, overflow, focus-ring and control-boundary contrast, forced colours, the stage size, its zoom floor and clearance, the band's fit and the window controls, the page height, menus below the band, row reachability, **the balanced budget and the first-glance rule** in its 72 rest states (experience §0), the 45-task gate and a sweep of 3,828 window sizes. All are 0. Canvas-drawn marks (keys, the playhead, duration bars) are checked as token pairs in 3.6 (0 failures).

---

## 1. Calm through structure

These rules are the system. Every token and component exists to make them easy to follow and hard to break.

1. **Visible where it is used, quiet where it is not.** What is used every minute is visible at rest; what belongs to the current tool or selection appears in its context (the tool options bar, the quick actions under the selection's name, a section's one title action, the timeline's own header clusters); what is rare sits in **titled** sections, named menus and popovers. A generic "More" never hides a frequent control. The per-region ceilings are the **balanced budget** (experience §0.1): band ≤ 16, rail ≤ 8, stage header ≤ 11 + 9, inspector ≤ 30 with ≤ 6 quick actions, timeline header ≤ 17 + 5, the window ≤ 80, and ≤ 76 at first glance; revision 4.3 **freezes** them and adds a ceiling of its own for each workspace's default, in the budget count and in an honest count of every visible target (every tile, every row's eye and lock).
2. **One header line.** Each island begins with one 40px header row with a hairline under it; the stage header and the inspector's tabs share their top and bottom (±1px). Context changes happen inside that line or under it, never around it.
3. **Three clusters, one line.** A header row (the band, the stage header, the timeline header) and a quick-actions row hold at most three groups, separated by `--cluster-gap` (12) or a hairline, never wrapping. Inside a group, controls share one size (28px icon buttons, 32px fields and segmented controls) and `--quick-gap` (2) or `--space-1` (4).
4. **Nothing over the artwork.** The artboard is the brightest thing on screen. No pill, crumb, hint, lane or HUD floats over it, and nothing interactive sits inside `#viewport`: the stage header holds the location, the tool's options, the one message, the view toggles and the zoom, above the canvas. The canvas shows today's renderer only: no selection ring, hover halo, name tag or drag readout.
5. **Quiet toggles, one accent.** A view toggle that is on (Joints, Motion paths, Grid, Effects preview, Loop, Snapping, Onion) is a soft neutral tile (`[data-quiet]`). Blue marks selection, focus, the current frame and the active tool; a toggle turns blue only when it changes what edits do (Whole branch, Isolate, Edit together) and is never on by default, so the first glance has **no** accent toggle.
6. **One shadow at rest.** `--lift` (a 6% hairline and a 1px drop) is the only rest shadow: the artboard, the active tool, the segmented thumb, slider knobs and the message pill. Islands have no shadow; their shape on the mist field is the border. `--elevation-3` and `--elevation-4` are for surfaces that are never at rest.
7. **Titles and whitespace, not boxes.** Fields have no ring at rest. Sections have no dividers: a quiet 12px title and whitespace separate them. A titled section is one line (its title and a chevron) until opened; it remembers being open. Rows separate by rhythm.
8. **Ink acts, blue selects, concepts whisper.** At most one ink primary per surface, flat. Concept colours appear only as 6–8px dots next to text and as thin marks and key fills in the timeline. No tinted blocks, chips, badges or bars at rest.
9. **Words carry weight.** Weight on screen comes from words more than icons: labels are three words at most (two in a header row), and at first glance at most 30 controls carry words (frozen, revision 4.3). No keycaps at rest (shortcuts are plain text in tooltips and menus); no helper sentences in panels (a pick mode's instruction is the mode message while it lasts).
10. **Regular values, five sizes.** Numbers in fields are regular weight (450); weight is for names and titles. The chrome at rest uses at most five type sizes.
11. **Accessible by construction.** Contrast is designed into the tokens; an 11px floor; 24px targets; visible focus everywhere; `prefers-reduced-motion`, `forced-colors` and `(hover: none)`.

## 2. What changed in the system

### 2.0 Revision 4.3

| Change | Why | Where |
|---|---|---|
| **Compact system rows**: Camera and Scene are 24px pinned rows; content rows keep 32px (28px at the short tier) | The default timeline showed fewer layer rows than today's at every size | experience §1.9 |
| **The "more below" set**: a 12px fade (never over a whole row's controls), a drawn 6px scrollbar (`--surface-sunken` track, `--scrollbar-thumb-hover` thumb) and a quiet "N more" ghost button with a down arrow | Clipped rows were invisible (no scrollbar, no fade drawn) | experience §1.9 |
| **The ruler tools' own column** (`--ruler-tools-w`: 148, 132 narrow, 116 compact; revision 5 moved the tools into the header's end cluster) | The tools covered the last frames, the playhead tab and the onion ends | experience §5.7 |
| **One grammar in quick actions**: a label and its glyphs in one sunken tile (`.ui-quick-tile`); word buttons with the glyph buttons' gap and hover tile | "Level ⊕ ↺" read like "Match ◀ ▶"; a label looked like a button | components.md; §10 |
| **A switch attached to its section title** (`.ui-section-head[data-switch]`) | "Parallax › ◯" put two targets on one line with the switch far from its title | components.md |
| **The background chip is a swatch** (the scene's colour, a 1px `--line-control` border, 3:1 on both themes, 18×13) | The small artboard read as an empty screen | experience §4.2 |
| **New glyphs**: Previous key and Next key `key-prev`, `key-next` (a round key with an arrow), Tall timeline `tall` (a panel growing upward), Exact values `exact2` (a ruler with a typed angle); one-step order `step-up`, `step-down` without their bars | Frame steps and key jumps shared a glyph through an alias; Tall read as full screen; "123" read as a code; ⤒ ⤓ read as "all the way" | §10 |
| **VFX suggestions on a mid-tone stage in the light theme** (`#48506A`) | Twelve dark tiles outweighed the calm Properties tab | experience §5.4 |
| **The ink primary keeps its word longest** (the band's fold order) | A wordless black circle was the heaviest thing at first launch at 1024px | experience §1.8 |

### 2.0.1 Revision 4.2

| Change | Why | Where |
|---|---|---|
| **One pattern per kind of field**: inline-labelled selects (a bare select when the value names its kind), the field switch, the stepper field; row labels only for steppers and segmented controls | The same Layer control was drawn two ways; switches had three forms (the review) | components.md §3; the gallery's *Field patterns* |
| **Scrub labels** carry a quiet dotted underline | Today's ↔ and caption told people fields scrub; revision 4 had removed every cue | `.ui-field-label[data-property-scrub]` |
| **Previews in collections**: today's brush stroke textures; effect and look stills on a dark stage (`--fx-stage`, reference-local); each effect's own glyph on a tile in its category's colour | Five identical dots and fifteen grey arcs hid what people recognise things by | §10; experience §5.3, §5.4 |
| **New glyphs**: Duplicate `dup` (the copy with a plus), Effects `fx` (the sparkle read as AI), Build `ws-build` (a bone), Fit figure `fit-figure`, the Properties panel `inspector` and the timeline panel `timeline` (two panels on different sides), linked values `link-values` (Lock ratio, Link axes), Edit together `together` | One symbol per meaning across every state a person sees, menus included (the audit now takes the union) | §10 |
| **A section divider** (`[data-divider]`: a hairline and a stronger gap before a section that starts a new group) | Draw's drawing layer settings read as the brush's | experience §5.3 |
| **The message's own line** under the stage header when it does not fit beside the view cluster | A message is never cut | experience §4.3 |

### 2.1 Revision 4

| Change | Why | Where |
|---|---|---|
| **Added** the stage header (`--stage-head-h` 40) above `#viewport` | The tool's options, the location, the one message, the view toggles and the zoom need a home that is not over the artwork | experience §4 |
| **Added** quick actions, titled sections with one title action, the tool options bar with folding, the split button, the crumb, the scope line, the menubar, quiet toggles, the frame count, the mode and quiet message variants | Frequent commands visible in context without crowding (owner, message B) | components.md |
| **Added** `--cluster-gap` 12, `--quick-gap` 2 | The header-row rhythm of rule 3 | `src/styles/tokens.css` |
| **Retired** the stage corner group (`.ui-corner`, `--corner-inset`) | Zoom and Fit moved to the stage header; nothing sits in `#viewport` | The stage header's end |
| **Retired** the generic "More" (`.ui-more`) | It hid frequent controls behind an unnamed click | Titled sections |
| **Changed** the stage insets to 24 / 24 / 28 (short 12 / 12, low 8 / 8) | Nothing sits in the insets any more; they are pure clearance | §5 |
| **Changed** pressed view toggles from blue-soft to a neutral tile | Several visible toggles would otherwise paint the header blue | `[data-quiet]` |

### 2.2 Revision 3 (kept)

| Removed | Why | Replaced by |
|---|---|---|
| Key diamond (`.ui-key`), key stepping, "Keyed" chips | Owner: no diamonds for normal animation | Keys stay in the Advanced timeline, drawn as today |
| Selection pill, scope readout over the canvas, HUD pill, lane message, coach mark and pulse | Owner: no selection ring and stuff; nothing over the artboard | The selection menu and quick actions, the stage header, the one message slot; the scope line in the inspector |
| Range chip, Simple selection bar, easing pins, partial-frame marks, ghost add card | Density | The range inspector and the Simple frame bar; the current card's count |
| Badges, count badges, kind tags (DRAW, FX), keycaps at rest | Noise | A muted glyph after a drawing layer's name; tooltips; the has-audio dot |
| Ink selections (the ink mode thumb, the ink export card), inverse toasts, the lime export pane | Accent discipline | A white thumb with a hairline; white message pills; a neutral export preview |
| Section summaries, cards, bar sliders, easing tiles, steps | Density | Quiet sections with one title action, sliders, the easing select and curve |
| `--elevation-2`, `--shadow-thumb`, `--primary-shadow` (now `none`), `--badge-*`, `--inverse-*` colours, `--export-focus`, `--tint-export*`, `--on-export`, `--onion-*-default`, `--sheet-hatch`, `--sheet-end`, `--sheet-easing*`, `--hold-line`, `--drop-color` | Their components are gone | `--lift`, `--thumb-line`, `--hint-dot`, `--sheet-playhead-tab`, `--sheet-cel`, `--sheet-cel-line` |
| `--canvas-joint-ring`, `--canvas-joint-halo` (every theme block and the forced-colours map) | No selection ring or hover halo is drawn (owner) | Today's renderer: a selected joint is drawn paler |

## 3. Colour

### 3.1 Primitives (tier 1)

Raw hex lives only here. Brand values come from `StykAnimate-Site/src/css/base.css`.

| Ramp | Stops |
|---|---|
| Mist | `--paper #ffffff` · `--mist-50 #fbfcfd` · `--mist-100 #f5f6f9` (site mist) · `--mist-150 #f1f3f7` · `--mist-200 #eceef3` · `--mist-250 #e7e9ef` · `--mist-275 #dfe2ea` (a value field's travel) · `--mist-300 #e2e5ec` · `--mist-400 #d9dce5` |
| Slate | `--slate-300 #b4bac7` · `--slate-350 #a9aebb` · `--slate-400 #9aa0ae` · `--slate-450 #8f95a4` · `--slate-500 #80879a` · `--slate-550 #737a8c` · `--slate-600 #676c7a` · `--slate-700 #525868` |
| Ink | `--ink-400 #5d6272` … `--ink-900 #0c0d12` (site ink) · `--ink-950 #0a0b0f` |
| Blue | `--blue-50 #eaf5ff` · `--blue-100 #dcefff` · `--blue-400 #45b0ff` · `--blue-500 #0d99ff` (Styk Blue) · `--blue-550 #0a8ae6` · `--blue-600 #006dd1` · `--blue-700 #0059ab` · `--blue-850`, `--blue-900` |
| Concepts | violet `#7c5cff`, mint `#12c98a`, orange `#ff6a2b`, gold `#f5a524`, rose `#ff3d5e`, teal `#36a8b5`, each with 50/300/700/900 stops for soft, dark-theme and ink uses |
| Status | red `#d93025` / `#b3261e`; the gold and mint stops above |
| Onion (today's defaults) | `--onion-red #e76b70` · `--onion-blue #549de7` (`settings.mjs` `onionBeforeColor` / `onionAfterColor`; unchanged) |
| Lime | `--lime-*`: the website's celebration colour. Not used by the editor chrome. |

### 3.2 Semantic tokens (tier 2)

Components read only these. Light is the brand default; dark is neutral ink and keeps the true blue.

| Group | Tokens (light / dark) | Role |
|---|---|---|
| Surface | `--surface-field` `#f5f6f9` / `#0a0b0f` | The window: the field between islands, the band, the rail |
| | `--surface` `#fff` / `#15161c` · `--surface-raised` `#fff` / `#1b1c23` | Islands · menus, popovers, messages, dialogs |
| | `--surface-sunken` `#f5f6f9` / `#1e2029` · `--surface-well` `#eceef3` / `#22242e` | Fields · segmented tracks |
| | `--surface-hover`, `--surface-pressed`, `--surface-selected` (`#eaf5ff` / `#132a3e`) | States |
| | `--surface-stage` + `--stage-dot`, `--surface-construction` + `--construction-dot` | The dotted desk in every workspace; the construction pair is reserved for Build's pending construction-desk option (experience §11) |
| | `--surface-inverse` | Tooltips only |
| | `--surface-backdrop` (ink 30% / `rgba(4,5,8,.62)`; declared on `::backdrop` too) | The modal veil |
| Text | `--text-1` `#0c0d12` · `--text-2` `#525868` · `--text-3` `#676c7a` · `--text-disabled` · `--text-inverse(-2)` · `--text-on-strong` · `--text-link` | Names and values · labels · meta and section titles |
| Line | `--line-1`, `--line-2`, `--line-3` (decorative) · `--line-control` `#80879a` (3:1 boundaries) · `--thumb-line` (3:1 against the well) | |
| Accent | `--accent` `#0d99ff` · `--accent-strong` `#006dd1` · `--accent-line` `#0a8ae6` · `--accent-text` `#006dd1` · `--accent-soft` | One blue, four jobs (3.3) |
| Focus | `--focus-ring` `#0a8ae6` · `--inverse-focus` · `--focus-halo` | |
| Primary | `--primary` `#0c0d12` / `#f5f6f9` · `--on-primary` · `--primary-shadow: none` | The flat ink pill (a white pill in dark) |
| Controls | `--control-soft(-hover, -pressed)` · `--control-thumb` · `--switch-knob-off/-on` · `--slider-track/-fill/-thumb` · `--kbd-bg/-line` · `--swatch-ring` · `--swatch-ring-strong` (swatches on the field: 3.32 light, 3.75 dark) | |
| Status | `--danger-*`, `--warning-*`, `--success-*`, `--neutral-dot` | Never a whole panel; unsaved work is neutral, never red |
| Concepts | `--tint-select/-time/-library/-draw/-fx/-camera` (+ `-soft`, `-ink`) | Dots, the easing curve, thin marks |
| Timing | `--hold` (neutral duration bar) · `--hint-dot` (the first-run hint) · `--easing-ink` | |
| Depth | `--lift` (= `--elevation-1`) · `--elevation-3` · `--elevation-4` · `--shadow-artboard` · `--shadow-knob` | Section 7 |

### 3.3 One blue, four jobs

Brand blue `#0d99ff` is 2.99:1 on white, so each job has its own token.

| Job | Token | Light | Dark | Rule |
|---|---|---|---|---|
| Brand fill | `--accent` | `#0d99ff` | `#0d99ff` | Graphics that carry an outline or another cue (layer key fills with `--sheet-key-outline`) |
| Fill behind a glyph | `--accent-strong` | `#006dd1` | `#0d99ff` | Switch on, checkbox, slider fill, the playhead tab (`--sheet-playhead-tab`, white numerals 5.11) |
| Thin state mark | `--accent-line` | `#0a8ae6` | `#0d99ff` | Focus rings, the current frame's card ring and duration bar, the active cel, drop targets |
| Small text | `--accent-text` | `#006dd1` | `#45b0ff` | Links, the current frame number, the active tool glyph |

### 3.4 Concepts (dots and thin marks only)

| Concept | Where it appears | Never |
|---|---|---|
| Select (blue) | The Animate dot in the switch; figure layer dots; key fills | A tinted row, chip or bar |
| Draw (orange) | The Draw dot; drawing-layer dots; hollow cel keys (`--sheet-draw-line`) | Filled cel blocks |
| Library / Build (mint) | The Build dot; the movieclip layer dot | Hold bars (they are neutral) |
| Time (violet) | The Scene row key; the easing curve | Chips |
| Effects (rose) | The effect dot in VFX; effect keys in the timeline | Clip outlines |
| Camera (today's blue) | The camera key and the camera frame line in a session, as today (`--sheet-camera-*`, `--tint-camera` resolve to the brand blue) | Spans (system rows are neutral) |

**Layer tags.** The six `LAYER_COLORS` keys map to `--layer-blue`, `-violet`, `-rose`, `-orange`, `-green`, `-teal`; `layers.mjs` is not edited. **Onion skin** uses the colours saved in settings; the defaults are today's. **Joint handles** are renderer-owned Pivot colours and are not part of this system.

### 3.5 Colour rules

1. Never place white text or icons on `#0d99ff`; use `#006dd1` (5.11) or ink (6.49).
2. `#006dd1` text only on white, mist and blue-soft.
3. Concept colours are graphics, never text, except their `-ink` variants in the rare label.
4. Every swatch carries `--swatch-ring`; a swatch that sits on the field (the rail's colour pair) carries `--swatch-ring-strong`, 3:1 against `--surface-field`, so an ink swatch never vanishes on the dark rail.
5. Thin marks that carry state use `--accent-line`; concept thin marks on the canvas use the `--sheet-*-line` tokens (3:1 on every row).
6. Keep the chrome neutral: no tinted panels, no tinted row blocks, no second accent colour on a surface.
7. The artboard and thumbnails keep the document's colours in both themes (`--artboard-placeholder` is white).

### 3.6 Measured contrast matrix

Generated by `contrast.mjs` (internal design tooling, not in the repository) from `design/app-ui/tokens.css` (WCAG 2.x; an rgba foreground is blended over its background): **79 rows, 0 failures**, pasted whole (revision 3.3 regenerated it; 3.2's copy had dropped the last row, `--swatch-ring-strong` on `--surface-field`). Revision 3.1 regenerated it: the black-on-blue playhead row is gone (the tab is white on `--sheet-playhead-tab`), the chip and tag rows are relabelled for what still uses those tokens (rare labels and the legacy bridge), and the camera rows follow today's blue.

| Foreground | Background | Use | Need | Light | Dark |
|---|---|---|---|---|---|
| `--text-1` | `--surface` | Names, values | 4.5:1 | 19.41 (#0c0d12 on #ffffff) | 15.55 (#eceef3 on #15161c) |
| `--text-1` | `--surface-sunken` | Field values | 4.5:1 | 17.96 (#0c0d12 on #f5f6f9) | 13.98 (#eceef3 on #1e2029) |
| `--text-1` | `--surface-selected` | Selected row label | 4.5:1 | 17.56 (#0c0d12 on #eaf5ff) | 12.66 (#eceef3 on #132a3e) |
| `--text-2` | `--surface` | Labels, body | 4.5:1 | 7.11 (#525868 on #ffffff) | 8.13 (#a9aebb on #15161c) |
| `--text-2` | `--surface-well` | Segmented labels | 4.5:1 | 6.12 (#525868 on #eceef3) | 6.96 (#a9aebb on #22242e) |
| `--text-2` | `--surface-hover` | Icon on hover | 4.5:1 | 6.40 (#525868 on #f1f3f7) | 6.60 (#a9aebb on #262833) |
| `--text-3` | `--surface` | Meta, units, captions | 4.5:1 | 5.25 (#676c7a on #ffffff) | 6.02 (#8f95a4 on #15161c) |
| `--text-3` | `--surface-sunken` | Field labels | 4.5:1 | 4.85 (#676c7a on #f5f6f9) | 5.41 (#8f95a4 on #1e2029) |
| `--text-3` | `--surface-well` | Meta on a well | 4.5:1 | 4.52 (#676c7a on #eceef3) | 5.15 (#8f95a4 on #22242e) |
| `--text-3` | `--surface-field` | Meta on the mist field | 4.5:1 | 4.85 (#676c7a on #f5f6f9) | 6.56 (#8f95a4 on #0a0b0f) |
| `--accent-text` | `--surface` | Blue small text | 4.5:1 | 5.11 (#006dd1 on #ffffff) | 7.66 (#45b0ff on #15161c) |
| `--accent-text` | `--surface-selected` | Pressed toggle, selected lead icon | 4.5:1 | 4.63 (#006dd1 on #eaf5ff) | 6.24 (#45b0ff on #132a3e) |
| `--accent-text-strong` | `--accent-soft-hover` | Pressed toggle on hover | 4.5:1 | 5.91 (#0059ab on #dcefff) | 5.45 (#45b0ff on #17344d) |
| `--accent-text-strong` | `--surface-well` | Blue text on a well | 4.5:1 | 6.00 (#0059ab on #eceef3) | 6.55 (#45b0ff on #22242e) |
| `--text-on-strong` | `--accent-strong` | Check glyph, switch knob | 3:1 | 5.11 (#ffffff on #006dd1) | 6.49 (#0c0d12 on #0d99ff) |
| `--on-primary` | `--primary` | Primary pill | 4.5:1 | 19.41 (#ffffff on #0c0d12) | 17.96 (#0c0d12 on #f5f6f9) |
| `--on-primary` | `--primary-hover` | Primary pill, hover | 4.5:1 | 14.65 (#ffffff on #262833) | 19.41 (#0c0d12 on #ffffff) |
| `--on-danger` | `--danger-strong` | Destructive button | 4.5:1 | 6.54 (#ffffff on #b3261e) | 8.50 (#0c0d12 on #ff8a80) |
| `--text-inverse` | `--surface-inverse` | Tooltip | 4.5:1 | 19.41 (#ffffff on #0c0d12) | 17.96 (#0c0d12 on #f5f6f9) |
| `--danger-text` | `--surface` | Error text | 4.5:1 | 6.54 (#b3261e on #ffffff) | 7.91 (#ff8a80 on #15161c) |
| `--danger-text` | `--danger-soft` | Error box | 4.5:1 | 5.72 (#b3261e on #fdecea) | 6.74 (#ff8a80 on #3a1c1f) |
| `--warning-text` | `--warning-soft` | Warning box | 4.5:1 | 6.23 (#8a4b00 on #fff4de) | 8.79 (#ffc05a on #33291a) |
| `--success-text` | `--success-soft` | Success box | 4.5:1 | 4.60 (#097e56 on #e5f8f0) | 8.26 (#3ddc9f on #132e25) |
| `--tint-select-ink` | `--tint-select-soft` | Blue concept label on its tint (rare label) | 4.5:1 | 4.63 (#006dd1 on #eaf5ff) | 6.24 (#45b0ff on #132a3e) |
| `--tint-time-ink` | `--tint-time-soft` | Violet label on its tint (legacy bridge --theme-violet) | 4.5:1 | 4.73 (#6a47f5 on #f0ecff) | 6.44 (#a898ff on #231f3d) |
| `--tint-time-ink` | `--surface` | Easing label | 4.5:1 | 5.48 (#6a47f5 on #ffffff) | 7.39 (#a898ff on #15161c) |
| `--tint-library-ink` | `--tint-library-soft` | Mint label on its tint (rare label) | 4.5:1 | 4.60 (#097e56 on #e5f8f0) | 8.26 (#3ddc9f on #132e25) |
| `--tint-draw-ink` | `--tint-draw-soft` | Orange label on its tint (rare label) | 4.5:1 | 4.99 (#b04818 on #fff0e8) | 6.87 (#ff8f63 on #33201a) |
| `--tint-fx-ink` | `--tint-fx-soft` | Rose label on its tint (rare label) | 4.5:1 | 4.99 (#c8163a on #ffe9ec) | 6.26 (#ff7a93 on #3a1a22) |
| `--tint-camera-ink` | `--tint-camera-soft` | Camera label on its tint (rare label) | 4.5:1 | 4.63 (#006dd1 on #eaf5ff) | 6.24 (#45b0ff on #132a3e) |
| `--sheet-muted` | `--sheet-surface` | Ruler numerals (canvas) | 4.5:1 | 5.25 (#676c7a on #ffffff) | 6.02 (#8f95a4 on #15161c) |
| `--focus-ring` | `--surface` | Focus ring on islands | 3:1 | 3.63 (#0a8ae6 on #ffffff) | 6.03 (#0d99ff on #15161c) |
| `--focus-ring` | `--surface-field` | Focus ring on the field | 3:1 | 3.36 (#0a8ae6 on #f5f6f9) | 6.57 (#0d99ff on #0a0b0f) |
| `--focus-ring` | `--surface-well` | Focus ring on tracks | 3:1 | 3.12 (#0a8ae6 on #eceef3) | 5.16 (#0d99ff on #22242e) |
| `--accent-line` | `--surface-selected` | Selected outline, row bar | 3:1 | 3.28 (#0a8ae6 on #eaf5ff) | 4.91 (#0d99ff on #132a3e) |
| `--accent-strong` | `--surface` | Switch on, checkbox | 3:1 | 5.11 (#006dd1 on #ffffff) | 6.03 (#0d99ff on #15161c) |
| `--accent-strong` | `--surface-sunken` | Switch on inside a field | 3:1 | 4.73 (#006dd1 on #f5f6f9) | 5.42 (#0d99ff on #1e2029) |
| `--line-control` | `--surface` | Checkbox, radio, switch off | 3:1 | 3.59 (#80879a on #ffffff) | 4.20 (#737a8c on #15161c) |
| `--line-control` | `--surface-well` | Control boundary on a well | 3:1 | 3.09 (#80879a on #eceef3) | 3.60 (#737a8c on #22242e) |
| `--switch-knob-off` | `--surface-sunken` | Switch knob, off | 3:1 | 4.85 (#676c7a on #f5f6f9) | 5.41 (#8f95a4 on #1e2029) |
| `--slider-fill` | `--slider-track` | Slider fill against its track | 3:1 | 4.05 (#006dd1 on #e2e5ec) | 4.53 (#0d99ff on #2a2e3a) |
| `--sheet-playhead` | `--sheet-surface` | Playhead line (canvas) | 3:1 | 3.63 (#0a8ae6 on #ffffff) | 6.03 (#0d99ff on #15161c) |
| `--sheet-accent` | `--sheet-row-alt` | Keys, tween lines (canvas) | 3:1 | 3.53 (#0a8ae6 on #fbfcfd) | 5.67 (#0d99ff on #1b1c23) |
| `--accent-line` | `--surface-field` | Current-frame tab, rings on the field | 3:1 | 3.36 (#0a8ae6 on #f5f6f9) | 6.57 (#0d99ff on #0a0b0f) |
| `--text-1` | `--surface-selected-hover` | Selected row, hovered | 4.5:1 | 16.48 (#0c0d12 on #dcefff) | 11.07 (#eceef3 on #17344d) |
| `--text-2` | `--surface-selected-hover` | Selected row meta, hovered | 4.5:1 | 6.04 (#525868 on #dcefff) | 5.79 (#a9aebb on #17344d) |
| `--accent-text-strong` | `--surface-selected-hover` | Blue text on a hovered selection | 4.5:1 | 5.91 (#0059ab on #dcefff) | 5.45 (#45b0ff on #17344d) |
| `--focus-ring` | `--surface-hover` | Inset ring on a hovered row or menu item | 3:1 | 3.26 (#0a8ae6 on #f1f3f7) | 4.89 (#0d99ff on #262833) |
| `--focus-ring` | `--surface-selected` | Inset ring on a selected row | 3:1 | 3.28 (#0a8ae6 on #eaf5ff) | 4.91 (#0d99ff on #132a3e) |
| `--inverse-focus` | `--surface-inverse` | Focus ring on the inverse tooltip | 3:1 | 8.23 (#45b0ff on #0c0d12) | 4.73 (#006dd1 on #f5f6f9) |
| `--sheet-playhead-ink` | `--sheet-playhead-tab` | Playhead tab numerals, white on blue (canvas) | 4.5:1 | 5.11 (#ffffff on #006dd1) | 5.11 (#ffffff on #006dd1) |
| `--thumb-line` | `--surface-well` | Segmented thumb hairline against the well | 3:1 | 3.09 (#80879a on #eceef3) | 3.60 (#737a8c on #22242e) |
| `--hold` | `--surface` | Filmstrip duration bar (slider) | 3:1 | 3.59 (#80879a on #ffffff) | 4.20 (#737a8c on #15161c) |
| `--accent-line` | `--surface` | Current-frame duration bar and card ring | 3:1 | 3.63 (#0a8ae6 on #ffffff) | 6.03 (#0d99ff on #15161c) |
| `--hint-dot` | `--surface-raised` | First-run hint dot | 3:1 | 3.45 (#ff3d5e on #ffffff) | (not required) |
| `--canvas-selection` | `--artboard-placeholder` | Marquee and snap marks on the artboard (canvas) | 3:1 | 3.63 (#0a8ae6 on #ffffff) | 3.63 (#0a8ae6 on #ffffff) |
| `--canvas-selection` | `--surface-stage` | Marquee and snap marks on the desk (canvas) | 3:1 | 3.53 (#0a8ae6 on #fbfcfd) | 5.16 (#0a8ae6 on #111217) |
| `--sheet-key-outline` | `--sheet-surface` | Key outline on a row (canvas) | 3:1 | 3.63 (#868689 on #ffffff) | (not required) |
| `--sheet-key-outline` | `--sheet-row-alt` | Key outline on an alternate row (canvas) | 3:1 | 3.59 (#848588 on #fbfcfd) | (not required) |
| `--sheet-key-outline` | `--sheet-selected` | Key outline in a selected range (canvas) | 3:1 | 3.56 (#7b8189 on #eaf5ff) | (not required) |
| `--layer-blue` | `--sheet-row-alt` | Key fill, blue layer, no outline needed (canvas) | 3:1 | (not required) | 5.67 (#0d99ff on #1b1c23) |
| `--layer-violet` | `--sheet-row-alt` | Key fill, violet layer, no outline needed (canvas) | 3:1 | (not required) | 3.91 (#7c5cff on #1b1c23) |
| `--layer-rose` | `--sheet-row-alt` | Key fill, rose layer, no outline needed (canvas) | 3:1 | (not required) | 4.92 (#ff3d5e on #1b1c23) |
| `--layer-orange` | `--sheet-row-alt` | Key fill, orange layer, no outline needed (canvas) | 3:1 | (not required) | 5.94 (#ff6a2b on #1b1c23) |
| `--layer-green` | `--sheet-row-alt` | Key fill, green layer, no outline needed (canvas) | 3:1 | (not required) | 7.88 (#12c98a on #1b1c23) |
| `--layer-teal` | `--sheet-row-alt` | Key fill, teal layer, no outline needed (canvas) | 3:1 | (not required) | 6.00 (#36a8b5 on #1b1c23) |
| `--sheet-camera-accent` | `--sheet-row-alt` | Camera key fill (canvas) | 3:1 | (not required) | 5.67 (#0d99ff on #1b1c23) |
| `--sheet-playhead` | `--sheet-row-alt` | Playhead line over a row (canvas) | 3:1 | 3.53 (#0a8ae6 on #fbfcfd) | 5.67 (#0d99ff on #1b1c23) |
| `--sheet-camera-line` | `--sheet-surface` | camera tween line, hollow key, clip edge (canvas) | 3:1 | 5.11 (#006dd1 on #ffffff) | 7.66 (#45b0ff on #15161c) |
| `--sheet-camera-line` | `--sheet-row-alt` | camera thin mark on an alternate row (canvas) | 3:1 | 4.98 (#006dd1 on #fbfcfd) | 7.20 (#45b0ff on #1b1c23) |
| `--sheet-scene-line` | `--sheet-surface` | scene tween line, hollow key, clip edge (canvas) | 3:1 | 5.48 (#6a47f5 on #ffffff) | 7.39 (#a898ff on #15161c) |
| `--sheet-scene-line` | `--sheet-row-alt` | scene thin mark on an alternate row (canvas) | 3:1 | 5.33 (#6a47f5 on #fbfcfd) | 6.95 (#a898ff on #1b1c23) |
| `--sheet-fx-line` | `--sheet-surface` | fx tween line, hollow key, clip edge (canvas) | 3:1 | 5.78 (#c8163a on #ffffff) | 7.27 (#ff7a93 on #15161c) |
| `--sheet-fx-line` | `--sheet-row-alt` | fx thin mark on an alternate row (canvas) | 3:1 | 5.63 (#c8163a on #fbfcfd) | 6.84 (#ff7a93 on #1b1c23) |
| `--sheet-draw-line` | `--sheet-surface` | draw tween line, hollow key, clip edge (canvas) | 3:1 | 5.55 (#b04818 on #ffffff) | 6.32 (#ff6a2b on #15161c) |
| `--sheet-draw-line` | `--sheet-row-alt` | draw thin mark on an alternate row (canvas) | 3:1 | 5.40 (#b04818 on #fbfcfd) | 5.94 (#ff6a2b on #1b1c23) |
| `--audio-ink` | `--sheet-surface` | Audio waveform (canvas) | 3:1 | 5.08 (#097e56 on #ffffff) | 10.26 (#3ddc9f on #15161c) |
| `--tint-library-ink` | `--surface` | Mint glyph on an island (rare; the Structure flags are --text-3) | 3:1 | 5.08 (#097e56 on #ffffff) | 10.26 (#3ddc9f on #15161c) |
| `--swatch-ring-strong` | `--surface-field` | Swatch ring on the field (the rail colour pair) | 3:1 | 3.32 (#80879a on #f5f6f9) | 3.75 (#676c7a on #0a0b0f) |

### 3.7 Canvas-read tokens

Canvas painters read these with `getComputedStyle(root).getPropertyValue()`. Each is a `var()` chain ending in a hex or rgba literal; none uses `light-dark()` or `color-mix()`. Under `forced-colors` they map to system colours; `canvasChromeTheme` resolves them through a probe element.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--sheet-surface`, `-hover`, `-line`, `-ink`, `-muted` | `#fff`, `#fbfcfd`, `#eceef3`, `#0c0d12`, `#676c7a` | `#15161c`, `#111217`, `#22242e`, `#eceef3`, `#8f95a4` | Rows; the quiet area past the end; the 5-frame lines; ruler numerals |
| `--sheet-accent`, `-selected`, `-span`, `-tween`, `-row-alt` | see `src/styles/tokens.css` | | Existing reads |
| `--sheet-playhead` / `-playhead-tab` / `-playhead-ink` | `#0a8ae6` / `#006dd1` / `#fff` | `#0d99ff` / `#006dd1` / `#fff` | The line; the tab; its white numerals (5.11) |
| `--sheet-key-outline` | ink 50% (3.6) | black 55% | The 1px ring on filled keys |
| `--sheet-cel` / `-cel-line` | `#f5f6f9` / `#d9dce5` | `#1e2029` / `#3a3f4f` | Neutral cels and effect clips |
| `--sheet-camera-*`, `-scene-*`, `-fx*`, `-draw*`, `-*-line` | today's camera blue, violet, rose, orange (lines 5.0–5.8) | the base hues (camera line `--blue-400`) | Key fills and thin concept marks; the camera frame in a session |
| `--sheet-onion-before` / `-after` | `#e76b70` / `#549de7` at 20% | at 28% | Ruler ranges whenever onion is on, as today (the 2px band; the range end is the full `--onion-*` colour) |
| `--audio-ink` / `--audio-fill` | `#097e56` / `#e5f8f0` | `#3ddc9f` / `#132e25` | Waveforms |
| `--layer-*` | brand hues | same | `LAYER_COLORS` lookup |
| `--canvas-selection`, `-selection-fill`, `-pivot`, `-snap`, `-guide`, `-label-bg`, `-label-text`, `-muted` | see `src/styles/tokens.css` | | Marquee, pivot, snap feedback, guides and camera gizmos (restyled today's marks; there are no ring or halo tokens) |

Painter contract: repaint on `styk-theme-change` and on `document.fonts` `loadingdone`; canvas text is `600 11px` in the UI font.

## 4. Typography

| Role | Token | Size / line | Weight | Family | Used for |
|---|---|---|---|---|---|
| Display | `--type-display` | 28 / 32 | 760 | Inter Tight | Welcome |
| Title | `--type-title` | 20 / 26 | 700 | Inter Tight | Dialog titles |
| Heading | `--type-heading` | 16 / 20 | 650 | Inter Tight | The inspector name, Structure, stage cards |
| Numeral | `--type-numeral` | 14 / 20 | 700 (600 in the readout) | Inter Tight, tabular | "Frame 28 / 48" |
| Emphasis | `--type-emphasis` | 14 / 20 | 600 | Inter | Palette input |
| UI / strong | `--type-ui`, `--type-ui-strong` | 13 / 18 | 500 / 600 | Inter | Buttons, tabs, menus, rows |
| **Value** | `--type-value` | 13 / 18 | **450** | Inter, tabular | Field and slider values: regular, never bold |
| Body | `--type-body` | 13 / 18 | 400 | Inter | The rare sentence (dialog descriptions) |
| Small / strong | `--type-small`, `--type-small-strong` | 12 / 16 | 500 / 600 | Inter | Field labels, section titles, meta, shortcuts in menus |
| Micro (floor) | `--type-micro` | 11 / 14 | 600 | Inter | Frame numbers, ruler, menu group labels |

`font-feature-settings: "cv11", "ss01"`; numbers that change are tabular, names and paths are not. Nothing is smaller than 11px (DOM or canvas). Negative tracking only at 16px and above. Sentence case everywhere. Labels budget 2–2.6× growth for localisation. Latin files are preloaded (`block`); other subsets `swap`; nothing awaits fonts.

## 5. Spacing and layout

A 4px grid with 2, 6, 10 and 14 for rhythm: `--space-0-5` 2 · `-1` 4 · `-1-5` 6 · `-2` 8 · `-2-5` 10 · `-3` 12 · **`-3-5` 14** · `-4` 16 · `-5` 20 · `-6` 24 · `-8` 32 · `-10` 40.

| Layout token | Value |
|---|---|
| `--topbar-h` | 44 at every tier, never below 44 window points |
| `--rail-w` | 48 (40 with 32px tools at minimal width or the low height tier); the rail sits on the field |
| `--inspector-w` | 288 (272 regular, 256 narrow; 256–360) |
| `--gutter` | 6 between islands (4 between the stage and the timeline at the low height tier) |
| `--island-pad` | 16 (14 narrow, 12 compact): generous, calm density |
| `--label-col` | 196 (168 narrow, 156 compact and minimal: names read beside the eye and lock) |
| `--stage-head-h` | 40: the stage header row, level with the inspector's tabs (the island header line) |
| `--stage-inset-top`, `--stage-inset-bottom`, `--stage-inset-inline` | 24, 24, 28: the fit insets inside `#viewport`. Top and bottom follow the height tier (short 12, 12; low 8, 8), inline the width tier (narrow and compact 20; minimal 10). Nothing sits in the insets, so they are pure clearance around the artboard (≥ 8px) |
| `--cluster-gap` | 12: between the groups of a header row |
| `--quick-gap` | 2: between the buttons of a quick-actions group (groups are `--space-2-5` apart) |
| `--dot-gap` | 24: the desk's dot pitch |

JS-mirrored geometry changes only with its constant: `--timeline-row` 32, `--timeline-header` 32, `--audio-row` 64, `--audio-ruler` 22, `--audio-toolbar` 36, `--outliner-row` 30, `--asset-row` 74. Every spacing, gap and radius in components uses these tokens (lint CSS17).

**Density.** Section titles 14 above, 10 below; fields 32 high with 8 between; islands 16 inside; quick actions 28 high, 8 under the name and 14 above the first section; titled sections 28 high each. The inspector shows at most four open sections and seven titled ones at rest. The window's controls are budgeted per region (experience §0.1).

## 6. Radius

`--radius-2xs` 4 (colour chips, checkboxes) · `-xs` 5 (kbd) · `-sm` 6 (rows, menu items) · `-md` 8 (fields, frame cards, tooltips) · `-lg` 10 (tools, menus) · `-xl` 12 (islands, popovers) · `-2xl` 16 (dialogs) · `-pill` (buttons, segmented, split buttons, messages). Inner radius = outer minus padding. The artboard has radius 0 (truthful to export).

## 7. Depth

| Token | Light | Dark | Use |
|---|---|---|---|
| `--lift` (= `--elevation-1`) | 6% ring + `0 1px 2px` 6% | white 7% ring + `0 1px 2px` black 40% | **The only rest shadow**: artboard, active tool, segmented thumb, slider knobs, message pill |
| `--elevation-3` | ring + long soft drop | ring + black drops | Menus, popovers, sheets, floating panels (never at rest) |
| `--elevation-4` | ring + deepest drop | same | Dialogs, the palette (never at rest) |
| `--shadow-artboard`, `--shadow-knob` | | | Reserved for the canvas and slider internals |

Islands carry no shadow. Shadows are static: no hover-lift, no `backdrop-filter`. Forced-colours mode removes shadows, so components carry transparent borders that become real ones. The audit counts distinct drop shadows on visible elements at rest and fails above 1.

### 7.1 The stage

The stage island is a 40px header (`.stage-head`, a hairline under it) and `#viewport` below it. `#viewport` fills the rest; the dotted desk is a static background; `#viewport` is never clipped with a radius and none of its ancestors has a transform (the island's corners come from one `::after` cap layer). Nothing interactive sits inside `#viewport`, so its insets are pure clearance around the artboard at fit. The header's start holds the location crumb or the tool's options, its centre the one message (capped so it never meets the view cluster), its end the view toggles, zoom and Fit. Build shows today's white artboard at fit canvas; its Structure folds to a 40px strip wherever docking it would leave the stage under 400px, so the stage keeps its room. The page is exactly one window: visually hidden hosts are fixed at the window's origin, so nothing extends the document below the shell.

## 8. Focus

A 2px `--focus-ring` with a 2px offset (inset −2px in rows, menus and the canvas; −6px in line tabs, which carry 8px inline padding so the ring never touches the label or covers the underline); fields get a 1.5px ring and a 3px halo; the slider ring sits on the thumb; frame cards ring the thumbnail. Tooltips re-point to `--inverse-focus`. Mouse focus shows no ring, and a dialog opened by a pointer focuses its first field with `focusVisible: false`. F6 cycles regions; focus returns to the invoker when an overlay closes.

## 9. Motion

`--dur-fast` 100ms (hover, press), `--dur-base` 160ms (menus, popovers, a titled section's chevron), `--dur-slow` 240ms (dialogs, sheets), `--dur-thumb` 200ms (the segmented thumb, spring). Animate only transform, opacity and colour; docking and splitters commit instantly; nothing next to `#viewport` animates its size. No marketing motion and no pulses. Reduced motion makes everything instant.

## 10. Iconography

The app's pinned Lucide set on a 24 grid, stroke 1.75 (2 at 14px and below), `currentColor`; transport glyphs solid. Sizes 12 (chevrons), 14 (fields, compact buttons), 16 (buttons, menus, rows), 18 (transport), 20 (rail tools). Rest `--text-2`, hover `--text-1`, the active tool `--accent-text` on the white lift tile. **One glyph per concept, menu rows included** (the reference build fails when a tool, a button or a menu row reuses another concept's glyph; a row's label names its concept, and the rows that share a glyph are one concept: every Copy is the two squares and **every Duplicate the copy with a plus** (revision 4.2: two families, two glyphs), every delete is the trash, Bring forward and Move up step up): Select `cursor` (and Select all, Invert selection, Select same figure) · Add `plus` · **Tweener `tween`** (two key nodes and the blended node on a dashed arc; never a diamond; also Insert inbetween…) · **Test rig `test-rig`** (a figure with a play mark; never the transport Play) · Pan `hand` · **Add frame `frame-plus`** (a frame card with a plus; never the bare `+` of Add) · **New layer `plus`** (revision 4.1: the layer list's +, as today; one "add" family with Add, and never a stack that looks like Focus) · **Structure `structure`** (a part tree) · Combine `combine` · Brush, Eraser, Fill, Lasso, Shapes, Transform · Edit joints `nodes` (and Edit figure) · Onion `onion` · Scene `scene` · Camera `camera` · Layers `layers` · Movieclip `film` · VFX and Effects preview **`fx`** (revision 4.2; the sparkle read as "AI") · Properties **`inspector`** (a window with a shaded side panel; revision 4.2) · Layout `layout` · **Fit `fit`** (Fit canvas, Fit selection, Fit timeline, Fit selected frames: fitting content to a view, nothing else) · **Fit figure `fit-figure`** (Build; the fit corners around a small figure) · Export `export` · Keys `key` · Remove keys `minus` · Delete `trash` · Menu `more` · and, from revision 3.3, **Isolate joint `isolate`**, **Timeline… `timeline`**, **Reveal playhead `playhead`**, **Insert blank key `blank-key`**, **Extend `extend`**, **Bake `bake`**, **Preview motion `preview`**, **Select branch `select-branch`**, **Visible keys `channels`**, **Rename `rename`**, **New window `new-window`**, **Privacy `privacy`**, **Add to library `library`**, **What's new `whats-new`**, and Animation `clock`. The timeline's two height rows are a radio pair (*Default height*, *Tall timeline*), so they carry no glyph. Every app-menu row carries an icon. **Revision 4 adds** **Motion paths `motion-path`** (and Motion path settings), **Grid and guides `grid`**, **Loop `loop`**, **First frame `first`**, **Snapping `builder-snap`**, **Whole branch `builder-branch`**, **Flip `mirror`** (Flip horizontally, Flip limb, Flip part), **Highlight part `highlight`**, **Static handles `pin`**, **Level `level`**, **Guides `guides`**, **Connect joints `link`**, **Save `save`**, **New folder `folder-plus`**, **Refresh `rescan`**, **Show in folder `reveal`**, **Go to frame `go-frame`**, and the Select pixels and Shapes variants (`sel-rect`, `sel-ellipse`, `wand`, `shape-rect`, `shape-ellipse`). A labelled control whose words carry the meaning may drop the glyph rather than borrow one.

**Revision 4.1: glyphs compared by their drawing, words for look-alikes, one meaning per symbol.** The reference build compares glyphs by **SVG content** as well as by name: the app set ships byte-identical pairs (`rotate` = `reset`, `sliders` = `settings`, `chevron-up` = `up`, `zoom` = `zoom-out`), so two names can draw the same symbol. Revision 4.1 adds **Exact values `exact`** (a field with digits; `sliders` looked exactly like Settings), **Rotate 15° `rotate-step`** (a clockwise turn with its angle; `rotate` looked exactly like every Reset, and Reset rotation now uses `reset`), **Bring forward / Move up `step-up`** and **Send backward / Move down `step-down`** (never the chevrons that open settings), **Match previous pose `match-prev`** and **Match next pose `match-next`** (a figure with the arrow it copies from; never the transport's ◀| and |▶), **Next copied drawing `cel-next`**, **Join to figure `join-figure`** (a figure hooked onto a joint; Connect joints keeps the chain link), **Focus selected layers `focus-layers`**, **Mirror vertically `mirror-v`**, **Move to… `move-folder`**, and the workspaces' own glyphs for a tight band (**Animate `ws-animate`**, **Draw `ws-draw`**, **Build `ws-build`**). At rest, **one symbol stands for one command family**: every icon control carries `data-concept`, and the audit fails a state where one `<use href>` stands for two families (generic openers share theirs: ⋯ opens a menu, ▾ opens options, × closes, + adds, − removes). Where glyphs stay hard to tell apart at 16px, the control carries **words** instead: To front and To back (revision 4.2; a bare "Back" read as navigation), Build's Split and Duplicate, the range's Remove keys (beside the trash of Delete frames), the Match pair's label, Test rig and Next copy; revision 4.2 adds Save, *Join…*, the joint's Isolate, the camera's Level, *Rotate 15°* and *Centre*, *Invert*, *Combine with…*, *Edit together* and the Simple frame bar's Copy and Paste.

**Revision 4.3: no aliases between families.** A frame step (`,` `.`: the transport's ◀| |▶) and a key jump (`Shift+,` `Shift+.`) are two families: the key jumps draw **`key-prev` and `key-next`** (a round key, as the timeline draws keys, with an arrow) in the Animation menu, Timeline ⋯ and a VFX parameter's menu; revision 4.2's alias that let them share `previous` and `next` is gone, and the union across all 200 states has 0 clashes. **Tall timeline `tall`** (a panel with an arrow growing up) no longer reads as full screen's four corners; **Exact values `exact2`** (a ruler with a typed angle) replaces the "123" field; **Bring forward and Send backward** draw a plain arrow over a faint stack line, never the barred ⤒ ⤓ that read as "to top" beside To front and To back.

**Revision 4.2: one meaning per symbol across states, and what things are drawn.** The audit now takes the **union** of every state's visible glyphs, menus and popovers included (a person sees the figure's quick actions and the range's commands in one session), and menu rows carry `data-concept` too; it found and fixed Copy frames = Duplicate, Play = Play preview, Tall timeline = Focus mode, Connect joints = Lock ratio. New glyphs: `dup`, `fx`, `ws-build` (a bone: Build never shows a second stick figure beside Animate's runner), `fit-figure`, `inspector` and `timeline` (a side panel and a bottom panel, never two tables), `link-values`, `together` (a pencil in a range's brackets). **Effects keep today's own glyphs** (`vfx-icons.mjs`: glow, outline, shadow, particles, aura, beam…) on a 22px tile tinted in their category's colour (Generate orange 700, Distort violet 600, Colour mint 700, Light blue 600, Blur teal 700, Texture slate 600). **Collections draw their items**: brush tiles show today's stroke textures (grain, rough edge, bristles, dabs, the blender's red-to-blue), effect and look tiles a still of the effect on a small figure on a dark stage (`--fx-stage` #1F2533, so glows and shadows both read).

## 11. Responsive tiers

Two independent tiers (experience §1.8): **width folds horizontal chrome, height folds vertical chrome.** Folding hides labels first, then moves items into their declared path; nothing is lost.

| Width tier | Trigger | Visual changes |
|---|---|---|
| Wide | ≥ 1367 | The saved layout; the menubar docked |
| Regular | ≤ 1366 | Inspector 272 |
| Narrow | ≤ 1180 (down to 801) | Everything stays docked, as today's app keeps it (revision 4.1): the menubar, the inspector (256), the view toggles, the workspace switch, Simple │ Advanced, the frame rate; label column 168, island padding 14, stage insets 20; the band folds labels and spacing in its fold order (the state's words, the menubar's spacing, the switch's names to its glyphs, Export's label, the name, Save, the window controls' width, Redo); tool options fold to their twins and homes, then into "More options"; filmstrip cards follow the timeline height (104–168) |
| Compact | ≤ 800 | Inspector as a sheet (the band's Properties button); the frame rate in the Scene; label column 156; the view toggles, the switch's three segments and Simple │ Advanced stay (a message may cover the view toggles for its moment); dialogs full window |
| Minimal | ≤ 660, or wherever the band does not fit with every fold step | The menubar folds into the mark; rail 40 with 32px tools; round Export; the frame-plus Add frame and the cel-next Next copy without their labels; First frame, Loop and Audio in Timeline ⋯ |

| Height tier | Trigger | Visual changes |
|---|---|---|
| Tall | ≥ 641 | The default timeline height; stage insets 24 / 24 |
| Short | 569–640 | Camera, Scene and two content rows (the rest scroll); the Simple frame bar drops its first line and tightens; stage insets 12 / 12 |
| Low | ≤ 568 | The timeline is its header and *Timeline ⋯ › Timeline…* opens the body as a bottom sheet (`--elevation-3`, radius 12); the rail compacts to 40 with 32px tools; stage insets 8 / 8; the stage header stays 40 |

Build's Structure narrows to 200px, then folds to a 40px strip with a sheet, wherever docking it would leave `#viewport` under its 360px floor (always at compact and minimal width; at narrow below about 890). The artboard-zoom floors of experience §1.9 never decrease as the window grows, so no larger window gets a smaller artboard than a smaller window's floor (revision 4.1: 45% from 600×441 up to 1023px wide).

## 12. Writing

The site's voice: short, friendly, verbs first. Sentence case. Name the thing ("Frames", "Constant", "Match previous"), with today's names (revision 4.3: the easing modes are today's six, Auto, Bezier, Ease in, Ease out, Linear, Constant). Units are in the value ("172°"). Buttons say what happens ("Export MP4", "Delete frames"). Disabled means explained ("needs a 9:16 canvas"); an item that makes no sense in the current state is hidden, not disabled, so menus never read out key state. Confirm only what can't be undone. Errors say what happened and what to do. **No helper sentences in panels**; one first-run hint, once; a pick mode's instruction as the mode message while the mode lasts ("Click the joint to join to"). **An empty state is one line, not a helper sentence** (revision 4.3): while a panel has nothing to show it says what fills it, once, and goes when it is filled (VFX's "No effects on Bubble"; Draw on a new file's "Paint anywhere to start a drawing layer"). **Disabled means explained, and a control that can never act is not shown** (revision 4.3): *Edit together* on a one-frame file and *Focus selected layers* with one layer are absent, not greyed; while *Edit together* waits for a selection it is a quiet glyph whose tooltip says what to select, and its word appears when it can act.

| Instead of | Write |
|---|---|
| "Keyed at frame 28" chip in the inspector | Nothing; the key is in the timeline |
| "Drag a tab out to split it" in the UI | A tooltip on the tab: "Drag to move" |
| "Frame 6 of 8 · Keyed · Edit together" crumb | The readout "Frame 6 / 8"; Edit together as a visible switch, and the scope line "Editing frames 22–28 · Stop" while it is on |
| "More" | The section's own title ("Second colour", "Framing", "Advanced") |
| "Arrange mode: drag parts to reorder" | Nothing at rest; a grip appears on hover |
| "Show in folder" on the export message | "Show" (two words at most; it opens the folder) |
| "Rotate" | "Angle" (today's word) |
| "IK", "Pin" | "Use IK", "Pin joint" |

## 13. Input modes and platform

`(hover: none)`: eye, lock, grips, twisties and every hover-revealed action are visible. Pen: zoom and Fit are on screen; `dragSlop` applies. `forced-colors: active`: every role, including canvas-read tokens and `--lift`, maps to system colours; the block names both theme selectors so it wins in the light theme too. The band is the drag region; controls and overlay roots are `no-drag`; the pre-paint colour stays in sync in four places (`#f5f6f9` light, `#0a0b0f` dark).

## 14. Migration notes (visual layer only)

1. Load `src/styles/tokens.css`, `src/styles/base/fonts.css` and the components split from `design/app-ui/components.css` in the layer order `legacy, reset, tokens, base, layout, components, features, states, utilities`; today's sheets go in `legacy`, declared first (architecture M0).
2. `legacy-bridge.css` maps old names (`--theme-panel` → `--surface`, `--theme-accent` → `--accent-text`, `--theme-action` → `--primary`, …) so unported UI adopts the palette at once.
3. The timeline and audio painters keep working: the existing `--sheet-*` names and `--audio-*` are defined; the new ones (`--sheet-playhead-tab`, `--sheet-cel`, `--sheet-cel-line`, `--sheet-key-outline`) take effect with the M5 painter update.
4. Removed tokens (section 2) must not be reintroduced; the M0 lint's CSS04 rule fails on any `var()` without a declaration.
