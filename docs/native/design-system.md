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
Cyrillic, Greek, Vietnamese). A test fails if a file is replaced by another build.

## Dependencies

`styk-design` is plain data without its `widgets` feature, so tools and tests read the tokens without a toolkit. Nothing
on the engine side may depend on it (`cargo xtask deps`).
