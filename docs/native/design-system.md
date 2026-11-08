# The design system's sources (`styk-design`)

The native interface looks like today's app because it is generated from the same sources, not copied by eye. Three
inputs feed `engine/crates/styk-design`; `cargo xtask design generate` writes the Rust and `cargo xtask design check`
fails when any generated file is stale, missing or stray (it needs Node, which evaluates `src/icons.mjs`).

| Input | Output | Notes |
| --- | --- | --- |
| `src/styles/tokens.css` | `src/tokens.rs` | Both themes. `tokens::primitives` (the palette and fixed colours), `tokens::scale` (type, space, radius, controls, motion) and `Palette` with `tokens::LIGHT` and `tokens::DARK`. |
| `src/icons.mjs` | `icons/*.svg`, `src/icon_table.rs` | Every shape and alias, looked up with `icons::svg(name)` by the names the JavaScript uses. |
| `assets/fonts/` licences, Google Fonts files | `fonts/*.ttf` | Hand-placed, not generated; see `engine/crates/styk-design/fonts/README.md`. |

## Tokens

The generator reads the custom properties inside `@layer tokens` and follows the cascade the browser follows: a rule
that names plain `:root` applies to every theme; `:root[data-theme="dark"]` is applied last for dark. Light is the
`:root` cascade. A token declared in a rule that also names `:root[data-theme="light"]`, or in a dark rule, is a themed
role and becomes a field of `Palette`; the rest are theme-independent. Every `var()` is resolved at generation time.

- **Colours** are `Rgba` with the red, green and blue bytes and the alpha a fraction, exactly as CSS computes them.
  `styk_design::widgets` converts them to iced colours; iced is built with `web-colors`, so blending matches the browser.
  All 460 generated colours (86 primitives, 187 per theme) were compared with Chromium's computed `color` for the same
  custom property in both themes: no difference.
- **Shadows** (`--elevation-*`, `--shadow-*`, `--primary-shadow`) are `&[BoxShadow]`, including `inset`.
- **Type roles** (`--type-*`) are `TypeRole { weight, size, line_height, family }`, with the line height in pixels.
- **Length expressions** (`max()`, `min()`, `clamp()`, `calc()`) become functions of the run-time properties they read:
  `--topbar-h: max(52px, calc(44px / var(--ui-scale)))` is `scale::topbar_h(ui_scale)`. Only pixel lengths and numbers
  are understood.
- **Nothing is skipped silently.** A declaration in a rule the generator follows that it cannot turn into a value (`env()`,
  a unit that is not pixels, a new function) fails `design generate` and `design check` with the token's name. Whole
  rules for touch input and compact chrome are not followed; the generated file lists them with their property counts.

Each constant's doc comment names its CSS custom property. A port reads `--surface-field` in the CSS and finds
`Palette::surface_field` (field names are the property names with `_` for `-`).

## Fonts

iced's text stack reads TrueType; the web build ships WOFF2 subsets. The bundled `Inter.ttf` and `InterTight.ttf` are
the same fonts, whole: Inter 4.001 (git `66647c0bb`, axes `opsz` and `wght`) and Inter Tight 3.004, the versions in the
name tables of the app's own WOFF2 files, and one file per family covers every subset (Latin, Latin Extended,
Cyrillic, Greek, Vietnamese). A test fails if a file is replaced by another build, and `cargo xtask fonts verify` proves every
code point of every shipped subset has the same advance in them. How the text stack draws them like the browser, the
fidelity check (`cargo xtask fonts`) and its results: [typography.md](typography.md).

## Shared controls (`styk-design::widgets`)

Every control a panel needs is built once here and drawn from the tokens only; a panel (`styk-ui::inspector` is the
worked example) composes them and sends messages. A control reports; it never computes a feature.

| Module | Controls | Notes |
| --- | --- | --- |
| `button` | `Button` (soft, primary, accent, ghost, outline, danger; sm 28, md 32, lg 36; glyph, toggled, danger tone, section action), `IconButton` (xs to lg, soft, round, toggled, expanded) | the pressed state is drawn at `--press-scale` about its centre; the words keep their size |
| `toggle` | `Switch` (bare, in a field, as a row), `Checkbox` (mixed), `Radio` | a disabled control is one 42 % layer: a knob or tick is the opaque part over the page, not faded twice |
| `segmented` | `Segmented` (md, sm, lg, fill, glyphs) | one Tab stop; the arrow keys choose the next enabled item (`roving`); radios or buttons |
| `slider` | `Slider`, `Slider::row` | press jumps, a drag follows the pointer until release (snapped to the step), keys through `styk_core::controls::slider_value`, wheel only when asked; it reports `Slide { value, commit }` |
| `number_field` | `NumberField` (field box, label that scrubs, value sized to its text, unit glued for `%`, `°`, `×`), `stepper` | the scrub, step and clamp rules are `styk_core::number` |
| `select`, `color` | `Select`, `ColorField`, `swatch` | a select reports the option picked and the key step asked for |
| `badge` | `Chip`, `badge` (the section tint tile) | |
| `frame` | `FieldFrame` | the field box: hover hairline, accent ring and halo while anything inside holds focus (it asks the tree), danger ring, half opacity |
| `surface`, `control` | `Surface`, `Look`, `Preview`, shadows | the pressable box under buttons, chips and segmented items |
| `card`, `layer` | `Card` (fill, radius, `--elevation-*`, hairline, clip), `Layer`/`Placed` | every overlay and island is a `Card`; the layer places boxes where the core's arithmetic says |
| `menu`, `select`, `tooltip`, `toast`, `dialog` | menu list and rows, the select (opens an anchored menu), tooltip, message, dialog, popover, sheet | drawn from `styk_core::overlay::host`; [overlays.md](overlays.md) |
| `parts`, `progress`, `splitter` | stepper, kbd, chord, dot, divider, crumb, island, list row, section head, tabs, scroll area, empty state, split button; progress bar, spinner; splitter | small parts a panel composes; the `parts` screen shows them against today's |

**Input roles.** An input-like control declares its `styk_core::focus::InputRole` in its own constructor, so no panel can
forget it and let Delete reach the document: text and number fields are `Text`, `Select` is `Select`, switch and checkbox
are `Checkbox`, radio and a radio group are `Radio`, slider and colour field are `Other`. Buttons, chips and a button group
declare none. `control_tests::every_input_like_control_declares_its_role_and_keeps_delete_from_the_document` routes each kind
through `Shortcuts::press`.

**Previews.** `Preview::{Hover, Pressed, Focus}` holds a state whatever the pointer does. The controls page
(`stykanimate --screen controls`, `controls-dark`; `styk_ui::controls_sheet`) shows every control in every state with them
and is compared with today's components drawn by today's stylesheets
(`engine/crates/styk-app/automation/controls-reference/screens.mjs`: hover, pressed and focus forced through the DevTools
protocol). `--scale 1.5 --out <dir>` writes the 150 % references the chunk checked by hand.

## Dependencies

`styk-design` is plain data without its `widgets` feature, so tools and tests read the tokens without a toolkit. Nothing
on the engine side may depend on it (`cargo xtask deps`).
