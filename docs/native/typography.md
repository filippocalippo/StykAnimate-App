# Typography: Inter and Inter Tight as the browser draws them

The native interface must set its text the way today's app does: the same families, weights, numerals, widths and line
pitch, and the same ink on the screen. This page is the contract for that (the spike S2t), how the iced text stack
reproduces it, and the record of the check that proves it and of the one thing that is still different.

Sources: `src/styles/tokens.css` (the roles), `src/styles/base/fonts.css` (what the browser loads) and the components
that use them. The bundled files: [design-system.md](design-system.md) and `engine/crates/styk-design/fonts/README.md`.

## 1. Every role the app uses

Family, weight, size and line height are the CSS `font:` shorthands of `--type-*`; tracking is `letter-spacing`
(`--tracking-*`, em). `Inter` is `--font-ui`, `Inter Tight` is `--font-display`. Both are whole variable fonts, so
weights are `wght` values, never the nine CSS keywords.

| Role (`--type-*`) | Family | `wght` | Size / line | Tracking | Uses |
| --- | --- | --- | --- | --- | --- |
| `micro`, `eyebrow` | Inter | 600 | 11 / 14 | 0 (caps tags: +0.04em) | kbd, frame numbers, badges, menu group names |
| `small` | Inter | 500 | 12 / 16 | 0 | field labels, meta, shortcuts (119 rules) |
| `small-strong` | Inter | 600 | 12 / 16 | 0 | 55 rules |
| `ui` | Inter | 500 | 13 / 18 | 0 | tabs, menus, rows |
| `ui-strong` | Inter | 600 | 13 / 18 | 0 | |
| `value` | Inter | **450** | 13 / 18 | 0 | inspector values (with `tnum` on number inputs) |
| `body` | Inter | 400 | 13 / 18 | 0 | prose |
| `emphasis` | Inter | 600 | 14 / 20 | 0 | readouts, palette input |
| `numeral` | Inter Tight | 700 | 14 / 20 | 0 | |
| `heading` | Inter Tight | **650** | 16 / 20 | -0.01em | dialog sections |
| `section` | Inter Tight | **650** | 13 / 18 | 0 | section titles |
| `button`, `button-prominent` | Inter Tight | **650** | 13 / 13 | 0 | every button's words |
| `panel-title` | Inter Tight | 700 | 18 / 24 | 0 | the selection's name |
| `title` | Inter Tight | 700 | 20 / 26 | -0.02em | dialogs |
| `display` | Inter Tight | **760** | 28 / 32 | -0.03em | export hero, welcome |

Literals outside the roles (every `font:` shorthand in `src/styles`): 760 at 18, 20 and 24 px (24 px on a 1.15 line,
-0.035em), 800 on `clamp(26px, min(6cqi, 6dvh), 38px) / 1`, 700 at 12 px, 600 at 10 and 11 px, 400 at 14 px. More
tracking values: -0.005em (six rules), 0.01em, -0.035em (three), and 1 px and 1.25 px (two one-off rules, absolute).
Weights in use: 400, 450, 500, 600, 650, 700, 760, 800.

`font-variant-numeric: tabular-nums` (`tnum`) is set by 74 rules; text and search inputs reset it. `font-synthesis:
none` is on the root. Settings and the support dialog also set `font-feature-settings: "cv11", "ss01"`: **this has no
effect today** (section 2).

**Optical size.** `font-optical-sizing` is its default `auto`: Chromium sets Inter's `opsz` axis (14 to 32) to the used
size in CSS pixels, clamped to the axis. 11 to 14 px therefore use 14 (the font's default coordinate), 16 px 16, 18 px
18, 28 px 28. The scale factor does not change it (13 px text at 150 % still uses 14). Inter Tight has no `opsz`.

**Fallbacks.** `--font-ui` continues `"Segoe UI Variable Text", "Segoe UI", system-ui, ..., "Noto Sans Arabic", "Noto
Sans Hebrew", "Noto Sans CJK SC", ..., "Microsoft YaHei UI", ...`; the browser tries these in order for every
character Inter lacks.

## 2. How each part is reproduced

| Part | Today (CSS) | Native |
| --- | --- | --- |
| Families | `Inter`, `Inter Tight` WOFF2 subsets | `styk_design::fonts::INTER`, `INTER_TIGHT`: whole variable TrueType files, embedded. An installed Inter or Inter Tight is dropped from the font system (`warm_up::install_bundled`), as a web font beats an installed one in the browser; a static Inter installed on the machine otherwise answered for "Inter" (no axes) |
| Arbitrary `wght` (450, 650, 760, 800) | variable axis | `Weight::Value(u16)` in iced's `Font`; cosmic-text already carried any weight to the shaper, the glyph cache and swash |
| `opsz` auto | the used size in px | `Font::optical_size = OpticalSize::Auto`. iced resolves it from the **logical** text size when it builds the paragraph (`to_attributes_sized`), so the scale factor never changes it. It is part of the face instance, the shaped run, `LayoutGlyph` and the glyph cache key, and swash rasterizes with it |
| `tnum` | `font-variant-numeric` | `Font::features` (`styk_design::typography::TABULAR`), forwarded to the shaper; part of the paragraph cache key |
| `cv11`, `ss01` | `font-feature-settings` | **not requested**. The WOFF2 subsets the web build ships contain none of Inter's `cv*`, `ss*` features (`cargo xtask fonts verify` lists them), so Chromium draws the plain letters; asking for them natively would draw something today's app does not |
| Tracking | `letter-spacing: Nem` | `Font::tracking` in thousandths of an em, added after every glyph (cosmic-text `letter_spacing`), as Chromium does |
| Line height and baseline | `line-height: Npx` | `LineHeight::Absolute(N)`; the baseline is placed as Chromium places it (section 4) |
| Fallback fonts | the CSS list, in order | `styk_design::warm_up::StylesheetFallback`: the same list in the same order, each family at its nearest weight, heavier first on a tie as DirectWrite chooses (section 5) |

`styk_design::typography::TextStyle::from_role(&scale::TYPE_UI)` turns a role of the generated tokens into the iced
font, size and line height; `.tracking_em(scale::TRACKING_TITLE_EM)` and `.tabular()` add what the stylesheets add.

## 3. The text stack's patches

Each is an entry in the vendored crate's `VENDOR.md` with its reason.

- **cosmic-text**: `OpticalSize` in `Attrs`, `LayoutGlyph` and `CacheKey`; `FontSystem::get_font_instance` caches by
  (face, weight, optical size) and a face without an `opsz` axis is one instance whatever the size; swash gets
  `wght` **and** `opsz` coordinates (review finding 14: instance cache, glyph cache and rasterizer all carry the
  variation, and a test draws one string at two sizes at once); `LayoutRun` reports the line's ascent and descent;
  fallback families are matched at their nearest weight; `FontSystem::set_fallback`; the basic shaper reads
  advances at the face's variation coordinates and spans with different features are separate shaping runs.
- **cryoglyph**: the baseline rule (section 4).
- **iced**: `Font` gains `Weight::Value`, `optical_size`, `features`, `tracking`; `to_attributes_sized`;
  `font_system_if_built`; `Shaping::Auto` shapes in full for a named family or a font with features (the basic shaper
  has neither features nor kerning), so a default `text(..)` widget follows the typography too.

The text editor and text input (`text/editor.rs`, `core/src/text/input.rs`) are another spike's and keep calling
`to_attributes(font)`: an `OpticalSize::Auto` font there stays at the default coordinate, which is the right one up to
14 px (every field is 12 to 14 px).

## 4. Line pitch and baseline

N0 found the native line pitch about a pixel larger and uneven. Cause: cosmic-text places the baseline from the
unrounded font metrics and iced rounds the sum; Chromium rounds the ascent and the descent to whole **logical** pixels,
floors the half of the leading above the baseline, and only then scales to the device. So 18 px on a 24 px line sits
its baseline 18 px down in Chromium and 19 in the unrounded version. The rule (`cryoglyph::text_render::baseline`)
is `round((line_top + round(ascent) + floor((line_height - round(ascent) - round(descent)) / 2)) * scale)`. A first
version rounded at the drawn size; at 150 % that put 70 of 98 rows one pixel too high, which is how it was found.

## 5. Fidelity: the check and its result

`cargo xtask fonts` (slot it: it builds, opens a window off-screen and starts Chromium) draws the type matrix in
Chromium with today's `tokens.css` and `fonts.css` (Playwright from `node_modules`) and natively
(`engine/crates/styk-text-check`, an iced window under `STYK_BACKGROUND_WINDOW=1`), light and dark at 100 % and
150 %, and compares:

- **The matrix** (98 rows): all 16 roles with Latin, Cyrillic, Greek, Vietnamese and French text; weights 400, 450,
  500, 600, 650, 700, 760, 800 in both families; sizes 11, 12, 13, 14, 16, 18, 20, 22, 24 in both families; Arabic,
  Hebrew, Japanese and Chinese in both families; numerals with and without `tnum` and with the brand features; three
  tracking values.
- **Widths**: Chromium's `Range` rectangle against the paragraph width. Gate: within 0.5 px for text Inter covers,
  within 1 px for the fallback scripts.
- **Fallback fonts**: the platform fonts Chromium used (`CSS.getPlatformFontsForNode`) against the faces the native
  paragraph used.
- **Pixels**: per row, in the row's cell, luminance difference summed over the ink; at the same place and at the best
  shift of two pixels (a better shift means a baseline or pitch difference). The comparison is also made against
  Chromium with grayscale text (`--disable-lcd-text`), which separates what subpixel text changes.
- **`cargo xtask fonts verify`** (run first): the bundled TrueType files against the shipped WOFF2 subsets: every code
  point of every subset has the same advance width in the bundled font, the axes are the expected ones, and the GSUB
  features the subsets lost are listed. Result: 1,690 code points (Inter) and 1,719 (Inter Tight) identical;
  `aalt case cv01..cv14 dlig ordn salt sinf ss01..ss08 subs sups zero` are in no shipped subset of Inter.

Result of the last run (Windows 11, ClearType on, RTX 4070 SUPER; Chromium from Playwright 1.63). The table is
produced by the command; widths are in logical pixels, the ink error is the sum of absolute luminance differences over
Chromium's ink (0 is identical, 1 is as different as an empty cell):

| Theme, scale | max \|dwidth\| Inter / Arabic / Hebrew / CJK | Rows better when shifted | Ink error, Inter, vs Chromium (ClearType) | Ink error, Inter, vs Chromium (grayscale) | Chromium ClearType vs Chromium grayscale |
| --- | --- | --- | --- | --- | --- |
| light, 100 % | 0.03 / 0.03 / 0.03 / 0.00 | 0 of 98 | 0.131 | 0.105 | 0.077 |
| dark, 100 % | 0.03 / 0.03 / 0.03 / 0.00 | 0 of 98 | 0.155 | 0.234 | 0.116 |
| light, 150 % | 0.03 / 0.03 / 0.03 / 0.00 | 0 of 98 | 0.085 | 0.068 | 0.052 |
| dark, 150 % | 0.03 / 0.03 / 0.03 / 0.00 | 0 of 98 | 0.113 | 0.174 | 0.083 |

Before the baseline rule and the fallback list (the first run): Arabic differed by 14.4 px and Hebrew by 8.0 px
(Arial instead of Segoe UI), the kana and Chinese rows used Yu Gothic and Microsoft JhengHei where Chromium uses
Microsoft YaHei UI, and 13 rows (70 at 150 %) sat a pixel off. The fallback fonts now match: Arabic and Hebrew use
Segoe UI (Chromium names the face "Segoe UI Semibold": weight 500 sits between Regular and Semibold and DirectWrite
takes the heavier), Japanese and Chinese use Microsoft YaHei UI. On a machine without those fonts both programs fall
through the same list.

## 6. Subpixel text: the decision

**What differs.** Today's app draws ClearType text (RGB subpixel coverage) on opaque surfaces whenever Windows has
ClearType on (`HKCU\Control Panel\Desktop` `FontSmoothing` 2, `FontSmoothingType` 2: true here). The mean colour spread
of the ink pixels is 55 to 80 in Chromium's captures and 6.5 (the tint of the background) in the native ones. iced
draws grayscale coverage only: cryoglyph downgrades swash's `SubpixelMask` to a mask. Measured on the luminance alone,
ClearType against grayscale in Chromium itself differs by an ink error of 0.05 to 0.12, about as much as the whole
remaining native difference (0.07 to 0.16 against ClearType): the colour fringes come on top, since the comparison
ignores colour.

**Decision.** The native app draws ClearType-style subpixel text on Windows when the system has it on, and grayscale
otherwise (other platforms, ClearType off, text on translucent layers). It is **not built in this spike**: it is a
patch through four crates (swash `Format::Subpixel` masks in cosmic-text, a third glyph atlas and a shader output in
cryoglyph, a dual-source blend state in the wgpu text pipeline with a grayscale fallback where the adapter lacks
`DUAL_SOURCE_BLENDING`, and the system-setting lookup in `styk-platform`) whose result only this check can judge.
Its acceptance is stated in numbers: the native ink error against Chromium's ClearType must fall below the last
column above for all four combinations, and the colour spread must reach Chromium's.

**Contrast in dark mode.** The native ink is 14 % lighter than Chromium's ClearType (0.86 of its ink at 100 %, 0.90 at
150 %) for light text on dark, and 3 to 9 % heavier for dark text on light (1.09, 1.06). Skia adjusts coverage by the
text colour's luminance; iced blends the mask as it is. The same follow-up adds that curve and is judged by the same
check.

## 7. The font system is ready before the first font-dependent widget

iced builds its global font system on first use: it scans every installed font and any thread that asks meanwhile
waits for it. `styk_design::warm_up` is the program's first task: a worker builds the system, installs the bundled
fonts and the stylesheet fallback, and only then marks it ready; the view holds no text until `FontsReady`, and the
runtime's own font loading (`Settings::fonts`, which would build the system on the event loop) is not used.
`styk-app` starts it first, shows `styk_ui::loading` (no text) until ready, builds `styk_ui::view` only from a `warm_up::Ready` proof (a
screen that sets text cannot be built earlier, by type), and waits for it before a `--screenshot` capture. If the interface thread
builds the font system first, the worker records it (`warm_up::built_early`) and the application and the check fail the run.

Tested: `warm_up` unit tests (not ready before the worker has loaded the fonts; the caller kept polling meanwhile; an
installed Inter never answers for the bundled one), and a run of the real window with a deliberately delayed worker:
`STYK_FONT_WARMUP_DELAY_MS=1500 styk-text-check sheet ...` (a window whose view sets text) draws frames throughout and fails if
fewer than 5 frames were drawn before the fonts were ready, any gap exceeded 100 ms or the font system was built early. Its
negative control, `--no-font-gate` (the view sets text at once), must fail with "built the font system":
`tests/font_gate.rs` runs both.
