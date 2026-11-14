# Design system

`src/styles/tokens.css` defines the editor chrome's visual language once: the
StykAnimate brand colours for the light and dark themes, type, spacing, radius,
control sizes, elevation and motion. `src/styles/legacy-bridge.css` points the
older token names at it, so every surface uses the brand palette before it is
rebuilt. The shared legacy components (buttons, segmented controls, switches,
empty states) are still styled by `src/styles/legacy/45-design-system.css`.
Artwork, paint swatches, joint colours and export previews keep their own
colours. Brush preset thumbnails show a stroke's shape, not its colour, so dark
mode inverts them to light strokes.

## The redesign spec

The editor is being rebuilt to the design in `docs/design/` (revision 4.3,
"Simple at a glance, powerful underneath"). This file describes what the code
does today; the spec describes where it is going, and each milestone updates
this file as its surfaces land.

| Document | What it owns |
| --- | --- |
| `docs/design/README.md` | Index, the owner's standard, what each revision changed, the measured results, and how the spec maps onto this repository |
| `docs/design/DECISIONS.md` | The sign-off of revision 4.3: approved and deferred behaviours; it overrides `experience.md` §11 where they differ |
| `docs/design/experience.md` | Every surface and interaction, the balanced budget and first-glance rule, the layout model and tiers, and where every command lives |
| `docs/design/visual-system.md` | Calm through structure, colour and the contrast matrix, type, spacing, depth, motion, icons |
| `docs/design/components.md` | The `.ui-*` component vocabulary |
| `docs/design/function-ledger.md` | Every function of the editor as measured at `c82312fb`, with its clicks then and in the redesign (generated) |
| `docs/design/ui-architecture.md` | The build plan: layers and lint, the UI kit, the shell and layout model, contracts, milestones M0–M9, and their status |

The reference editor used to design and audit the redesign, and the research
behind the spec, are not part of this repository.

## Stylesheets and cascade layers

`index.html` links one stylesheet, `src/styles/app.css`. It declares the cascade
layers once, lowest priority first, and then imports every sheet:

```css
@layer legacy, reset, tokens, base, layout, components, features, states, utilities;
```

- **`legacy`** holds the stylesheets that predate the layers, moved unchanged
  into `src/styles/legacy/`. Their number prefixes follow their previous
  cascade order, which is also their import order: `00-drawing.css` (formerly
  imported by the first line of `style.css`), `01-style.css`, `20-studio.css`,
  and the other sheets `index.html` linked. Modules that inject a `<style>`
  block wrap its text in `@layer legacy { … }`, and the desktop feedback shell
  links `src/styles/support-bridge.css`, which imports `src/support-center.css`
  into `legacy` after `app.css`. `src/support-center.css` is copied byte for
  byte to the website; never move or edit it for the editor.
  `features/support-desktop.css` gives it the editor's look from the
  `features` layer, which beats it whatever the specificity.
- **Every later layer beats `legacy`** for normal declarations, whatever the
  specificity, so a rebuilt surface does not need heavier selectors. For
  `!important` the order inverts: a legacy `!important` rule beats every later
  layer, so delete the ones that touch a surface when you rebuild it.
- **New files** wrap themselves in one `@layer` block named after their folder
  (`base/*.css` in `base`, `components/*.css` in `components`, …). While the
  legacy layer exists, an unscoped rule in a later layer overrides every legacy
  rule, so scope new rules to the rebuilt region; only document-wide rules such
  as the `html` font may be unscoped.
- **Add styles by adding a file** and importing it from `app.css`, not with a
  new `<link>` or an unlayered `<style>` element, which would beat every layer.
  `tests/shell-contract.test.mjs` checks the single link and that every import
  resolves, with the legacy imports in `layer(legacy)`.
- **Keep the import count low.** Every import is a request that first paint
  waits for. In local measurements, splitting `style.css` and `studio.css` into
  29 fragments (54 stylesheet requests in all) delayed first paint by
  45–100 ms, while the 21 whole sheets load within 2 ms of the old links.
  Measure startup before adding many files.

## Fonts

The editor bundles two variable fonts in `assets/fonts/`, with their SIL Open
Font License texts (`OFL-Inter.txt`, `OFL-InterTight.txt`): Inter (optical
size axis) for UI text and Inter Tight for display text. Nothing uses Inter
Tight yet. `src/styles/base/fonts.css` declares one face per subset: latin,
latin-ext, Vietnamese, Cyrillic, Cyrillic extended, Greek and Greek extended.
`unicode-range` makes each language load only the files its glyphs need;
Arabic, Hebrew and Chinese use the system fonts that follow Inter in
`--font-ui` (`tokens.css`), which `base/document.css` sets on the document;
`--font-display` starts with Inter Tight. Stylesheets name the family only
through `var(--font-ui)`; canvas text takes the same stack from
`canvasFont(size)` in `src/ui/font-loading.mjs`. The subsets hold letters,
punctuation and currency but no arrows or symbols (⇔, ✓, ▸), which render in
a fallback font: draw such marks as icons.

`index.html` preloads the Inter latin file, which uses `font-display: block`;
every other face uses `swap`, so text in other scripts shows in a system font
while its file loads. The first surface that uses Inter Tight adds its latin
preload and makes that face `block`; until then, preloading it would fetch a
file nothing draws with. Nothing waits for fonts. A canvas that draws text
keeps the fallback glyphs until it repaints, so canvas text painters register
a repaint with `onFontsReady()` (the stage repaints through `app.mjs`).
`tests/fonts.test.mjs` checks the files, subsets, preload, language coverage,
licences and that the packaged app serves them.

## Stylesheet lint

`npm run check` runs `scripts/check-css.mjs`. The rule ids appear in its
messages. Layered files, meaning everything under `src/styles/` except
`app.css`, `support-bridge.css` and `legacy/`, must:

- wrap all their rules in one `@layer` block named after their place:
  `base/` in `base` (except `base/reset.css`, in `reset`), `layout/`,
  `components/`, `features/`, `tokens.css` and `legacy-bridge.css` in
  `tokens`, `states.css` and `utilities.css`. `app.css` imports each file
  once, without `layer()`. Only `app.css` and `support-bridge.css` (the lazy
  feedback styles) may use `@import` (CSS01, CSS16).
- take colours from tokens. Hex, `rgb()`, `hsl()` and named colours appear only
  in `tokens.css`; system colours only inside `@media (forced-colors: active)`.
  Comment a declaration `/* artwork */` for checkerboards and other artwork
  (CSS02).
- use `!important` only in `base/reset.css`, `states.css` and `utilities.css`
  (CSS06).
- use no id selectors outside `:where()` (CSS07), and stay within the
  specificity budget, counted in classes, attributes and pseudo-classes: base 0
  (a lone `.ui-*` helper class 1), layout and components 2, features 3. Put
  state qualifiers inside `:where()` (CSS09).
- take `z-index` from `var(--z-*)` or a local 0–3 (CSS11).
- query the viewport size only in `layout/shell.css`; everything else follows
  the layout tier or a container query (CSS14).

The legacy layer is emptied and deleted rather than fixed, so the lint keeps a
ratchet instead. `scripts/check-css-baseline.json` lists the modules that still
create stylesheets at runtime (JS01) and every `!important` declaration in the
legacy layer, including the injected CSS text (`legacyImportant`). Both lists
may only shrink: a new entry fails the check, and so does an entry whose code
is gone until you run `node scripts/check-css.mjs --update-baseline`, which
refuses to record new entries. Only `support-desktop-ui.mjs` may link a
stylesheet at runtime (JS02).

## Tokens

`src/styles/tokens.css` is the `tokens` layer, in three tiers:

- **Primitives**: the brand ramps (mist, slate, ink, blue, violet, mint,
  orange, gold, rose, red, lime, teal). Raw colour values appear only in this
  file, and only the semantic tier reads the primitives.
- **Semantic tokens**: roles for `:root` (light, the default) and
  `:root[data-theme="dark"]`. Styles read these and the scale, never primitives
  or literals.
- **Scale**: type (`--font-ui`, `--font-display`, `--font-mono`, `--text-11` …
  `--text-28`; 11 px is the floor), space (`--space-*`, a 4 px grid), radius,
  control and icon sizes, elevation, motion (zeroed under
  `prefers-reduced-motion`) and the in-flow stacking scale `--z-*`.

| Group | Tokens | Notes |
| --- | --- | --- |
| Surfaces | `--surface-field`, `--surface`, `--surface-raised`, `--surface-sunken`, `--surface-well`, `--surface-hover`, `--surface-pressed`, `--surface-selected`, `--surface-inverse`, `--surface-stage`, `--surface-backdrop` | Back to front: the window, panels, menus and dialogs, fields, tracks, states, toasts, the desk around the artboard, the modal backdrop. |
| Text | `--text-1`, `--text-2`, `--text-3`, `--text-disabled`, `--text-inverse`, `--text-on-accent`, `--text-on-strong`, `--text-link` | `--text-3` keeps 4.5:1 on every resting surface. |
| Lines | `--line-1` … `--line-3`, `--line-control` | The first three are decorative; `--line-control` meets 3:1 for control boundaries. |
| Blue | `--accent`, `--accent-strong`, `--accent-line`, `--accent-text`, `--accent-soft` | One blue, four jobs: brand fills that carry an ink label, fills behind glyphs (switches, checkboxes, sliders), focus rings and thin marks, and small blue text. The brand blue `#0d99ff` is 2.99:1 on white, so never put white text or icons on `--accent`. |
| Primary | `--primary`, `--primary-hover`, `--on-primary` | The main action on a surface: an ink pill in light, a light pill in dark. |
| Controls | `--control-soft`, `--switch-knob-on`, `--switch-knob-off`, `--slider-*`, `--value-fill`, `--value-fill-hover`, `--value-fill-active`, `--swatch-ring`, `--scrollbar-thumb` | `--value-fill*`: the travel a value field fills (components.md, Value field): a neutral at rest and on hover, the accent's soft tint while dragged or typed. |
| Status | `--danger-*`, `--warning-*`, `--success-*`, `--neutral-dot` | Each has `-text` and `-soft`; danger also `-strong` with `--on-danger`. |
| Concepts | `--tint-select`, `-time`, `-library`, `-draw`, `-fx`, `-camera`, `-export` | One meaning per hue. `-soft` is a background; `-ink` is for small text and icons. |

**The touch interface** ([docs/TOUCH.md](TOUCH.md)) re-states the scale under
`:root[data-input="touch"]`: controls 36–52px (a tablet's slightly smaller),
icons and the small type a step larger, 16px text fields, and the safe areas
(`--safe-top` … `--safe-left`), the tab bar and the wing as tokens. Its layouts
live in `layout/touch.css` and its components in `features/touch.css`; they
follow `data-touch-layout` (written by `src/touch/touch-mode.mjs`), never the
viewport's size, and start every selector from the root's state inside
`:where()`, so the desktop's cascade is unchanged.

Canvas painters read `--sheet-*`, `--audio-*`, `--layer-*` and `--canvas-*` as
plain colour strings, so those never use `light-dark()` or `color-mix()`. Until
the timelines are rebuilt, legacy rules on `.layer-timeline` and
`.audio-timeline` still set the values the timeline painters read. Under
`forced-colors: active` every role maps to a system colour.

### Legacy names

`src/styles/legacy-bridge.css`, also in the `tokens` layer, redefines the older
names on `:root`: the `--theme-*` colours, the `--text`, `--muted`, `--border`,
`--panel` and `--purple` aliases, colour names that legacy rules read but
nothing defined (`--theme-selection`, `--input`, `--field` …), `--ds-font` and
`--ds-focus-ring`. Defining a name that used to be undefined changes every rule
that relied on its fallback, so point such a rule at a token instead (the
timeline's navigation popover uses `--font-ui` rather than a bridged `--font`). The `tokens` layer beats `legacy`, so these win over the
legacy `:root` definitions in both themes.

- `--theme-accent` is `--accent-text`: legacy rules use it for small text,
  active icons and focus marks.
- `--theme-action` is `--accent-strong`, the fill of switches, sliders,
  progress bars and toggles. Glyphs and knobs on it use `--text-on-strong` or
  `--switch-knob-on` (white in light, ink in dark). Primary buttons use
  `--primary` and `--on-primary` instead.
- `--purple` (timeline keys and playheads) is `--accent-line`; blue text in
  the timeline uses `--accent-text`.
- `--theme-shadow`, `--ds-shadow-*` and the `--ds-*` sizes, radii, spacing and
  motion keep their legacy values until their surface is rebuilt.

Legacy rules still carry literal fallbacks in `var(--token, #fallback)`; they
never render. When you change a legacy rule, use semantic tokens rather than
the bridged names, and delete a bridged name once nothing reads it.

### Colours before the stylesheets load

Four places paint before the styles load and must match `--surface-field`:
`backgroundColor` in `desktop/main.cjs` (`#0a0b0f`: the desktop window stays
dark until settings load), and the `theme-color` meta in `index.html`,
`src/theme-bootstrap.js` and `src/theme.mjs` (`#f5f6f9` light, `#0a0b0f`
dark; `tests/theme.test.mjs` checks them). While the desktop app reads its
settings, `base/document.css` hides `#app` on `--surface-prepaint`, the same
dark colour.

## Shared components

- **Buttons**: `.button`, `.button.primary`, `.button.subtle`, `.button.small`,
  `.button.danger`, `.icon-button`. The primary button is the ink pill (a light
  pill in dark); a disabled one renders neutral. Keep one primary per surface:
  in Build, Done is the primary and Export becomes a soft secondary
  (`--control-soft`), as does Add Frame beside Play in the Simple timeline.
- **Segmented controls**: `.ds-segmented` (also applied to the inspector
  Properties/VFX/Library switch, the timeline Simple/Advanced switch, export
  categories and camera tabs). Mark the chosen button with `aria-pressed` or
  `aria-selected`.
- **Overlays**: menus, popovers and dialogs share border, radius and
  `--ds-shadow-3`.
- **Empty states**: `.ds-empty` with `.ds-empty-icon`, a `strong` title, a short
  `p` and `.ds-empty-actions`. Explain what the area is for and offer the next
  action; avoid bare "Nothing here" messages.
- **Value field**: `.ui-field[data-range]` (`src/inspector-kit.mjs` number rows with `range`, `default`, `angle`, `scrubAnywhere`, `trail`, `help`; `src/property-controls.mjs` drives it): a bounded number that is its own slider, with its default's tick, a non-linear scale for wide ranges (`src/ui/value-scale.mjs`), a dial for angles and a reset on a second tap. The effects panel uses it for every number; see docs/design/components.md.
- **Switches**: `.ds-switch` wraps a checkbox and a label with an optional
  `small` explanation. Use them for behaviour settings that need a sentence of
  explanation. Give the input an explicit `aria-label` when the label has a hint.
- **Chips**: `.ds-chip` for one-click suggestions.
- **Section labels**: `.ds-section-label` for small uppercase group headings in
  popovers.

## Writing

Use sentence case and plain words. Prefer "Add track" to "Track", and name the
result of a setting, not its mechanism ("Keep audio in sync with frame edits"
rather than "Ripple"). Count words must agree with their numbers ("1 figure").
In the Simple timeline, a *frame* is a Pivot-style timeline frame; wherever
playback frames differ, say so ("plays as 47 frames").

## Changing the editor markup

Restyle and restructure freely, but keep the hooks that code and tests use:
static ids, `data-action`, `data-tool`, `data-workspace-mode` and the other
values listed in `tests/shell-contract.test.mjs`, which runs with `npm test`.
Remove a hook only in the commit that changes its last reader, and update the
list there.

Review visual changes with `node scripts/ui-snapshots.mjs --url <server> --label
<name>`. It captures Animate, Draw and Build, both timeline modes, the inspector,
menus, dialogs and the feedback shell in light and dark at four window sizes.
Add `--compare <earlier label>` to count changed pixels and write diff images; a
refactor that should not change the look must report 0 changed images.
