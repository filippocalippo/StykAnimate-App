# Typography: Inter and Inter Tight as the browser draws them

The native interface must set its text the way today's app does: the same families, weights, numerals, widths and line
pitch, and the same ink on the screen. This page is the contract for that (the spikes S2t and S2c), how the iced text stack
reproduces it, and the record of the check that proves it and of what is still different.

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

Result of the typography spike's run, with grayscale native text (Windows 11, ClearType on, RTX 4070 SUPER; Chromium from
Playwright 1.63; section 6 has the same table for the subpixel text that is drawn now). The table is produced by the
command; widths are in logical pixels, the ink error is the sum of absolute luminance differences over Chromium's ink
(0 is identical, 1 is as different as an empty cell):

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

## 6. Subpixel text and the coverage adjustment

**What differed.** Today's app draws ClearType text (RGB subpixel coverage) on opaque surfaces whenever Windows has
ClearType on (`HKCU\Control Panel\Desktop` `FontSmoothing` 2, `FontSmoothingType` 2, orientation RGB, contrast 1200: all
true on the machine this was measured on). The native interface drew grayscale only: cryoglyph downgraded swash's subpixel
mask to a mask. Chromium also bends glyph coverage by the colour of the text (Skia's `SkMaskGamma`, the "contrast and
gamma hack"), so light text on a dark surface keeps the weight of its font: natively it was 14 % lighter.

**What is built.** On Windows with ClearType on, the native interface draws subpixel text; with it off, and on every other
platform, grayscale; both with Skia's coverage adjustment.

- `styk_platform::font_smoothing::current()` reads `SPI_GETFONTSMOOTHING`, `SPI_GETFONTSMOOTHINGTYPE`,
  `SPI_GETFONTSMOOTHINGORIENTATION` (RGB or BGR) and the contrast and gamma the system reports.
  `styk_design::typography::apply_system_text_rendering()` turns them into the program's text rendering
  (`graphics::text::set_rendering`); `warm_up::install_bundled` calls it, so the application, the headless path and the
  typography check all draw the same way.
- cosmic-text rasterizes a glyph with `CacheKeyFlags::LCD` as one coverage sample per subpixel (swash, a third of a pixel
  apart; on Windows DirectWrite does it, below); cryoglyph stores it in the existing mask atlas, three texels per pixel, and the fragment shader blends each
  channel by its own coverage with a second fragment output: **one device, the same pass**. A device without
  `DUAL_SOURCE_BLENDING` builds the other shader variant, which has no subpixel entry, and text stays grayscale
  (`text_pipeline.rs` builds both variants on a real device). iced's wgpu device requests the feature where the adapter
  has it.
- The coverage adjustment is Skia's: per channel for subpixel text and on the luminance for grayscale, the text colour
  quantized to three bits as Skia does, with the contrast and gamma below.
- Only where Chromium draws it. `styk_design::grayscale::grayscale(content)` draws the text inside it in grayscale
  (iced's `Grayscale` scope, read when the text is drawn); canvas text is always grayscale. Which surfaces of today's app
  need it was measured with `cargo xtask fonts surfaces` (one row of text per CSS pattern; the colour spread of its
  ink pixels, about 7 for grayscale and 14 to 98 for ClearType):

| Chromium draws ClearType | Chromium draws grayscale |
| --- | --- |
| a plain opaque page; text colour with alpha; a translucent background on an opaque page | `opacity` below 1 (even .99); `will-change`; `transform: translateZ(0)` and `scale()` |
| `translate(.5px)`; `rotate(.01deg)`; `isolation: isolate` | `backdrop-filter`; `filter`; `mix-blend-mode` |
| `overflow: hidden` with a radius; a box shadow on an opaque panel | `position: fixed` over the page (its own layer); a CSS animation of opacity or transform |
| a top-layer `<dialog>` or popover | canvas 2D by default (`alpha: false` canvases get ClearType) |

  In the app's stylesheets that is: the faded and disabled states (about 40 rules with `opacity` from .25 to .92), the
  few `will-change` and `backdrop-filter` rules, fixed-position layers and canvas painters. Everything else, panels,
  menus in the top layer, dialogs, is ClearType.

**What the numbers decided.** The contrast and the gamma were swept against Chromium's ClearType captures
(`cargo xtask fonts`, the four combinations):

- The system's ClearType contrast (1.2 here) is *not* what Chromium draws with: against Chromium the error is least at
  Skia's own default 0.5 (`CONTRAST`) and several times larger at 1.2. The system values are read but not applied.
- The gamma (`GAMMA` 1.8): least at 1.8 for light text on dark (insensitive to the contrast) and 1.2 to 1.8 for dark text
  on light. The paint gamma and the device gamma of Skia make no difference for the near-black and near-white text the
  app uses (the colour is quantized to a level that is 0 or 1 in any gamma), so there is one gamma.
- The order of the subpixels: swash's mask is blue first (its first channel samples the glyph to the right of the
  pixel's centre), so an RGB display takes the channels reversed. With them the wrong way round the error was about 0.14
  in the light themes; it is 0.09 now. A wider filter (a second pass of the box, five subpixels across) gave fringes half
  as strong as Chromium's and a larger error: swash's one-pixel box per subpixel is the filter. The offset of the samples
  (0.25 to 0.36 of a pixel) changes the error by 0.001.

**Result of the swash masks** (`cargo xtask fonts`, Windows 11, ClearType on; the state before DirectWrite, kept as the
record of why it was built): the mean ink error of the Inter rows between native text and Chromium's ClearType, against
the mark to beat (Chromium's grayscale against its ClearType):

| Theme, scale | Native vs ClearType, grayscale | Native vs ClearType, swash subpixel | The mark | |
| --- | --- | --- | --- | --- |
| dark, 100 % | 0.155 | 0.071 | 0.116 | below |
| dark, 150 % | 0.113 | 0.048 | 0.083 | below |
| light, 100 % | 0.131 | 0.088 | 0.077 | above |
| light, 150 % | 0.085 | 0.058 | 0.052 | above |

Total ink and its centroid matched; what differed was its distribution (the error fell with weight and size), which is
the rasterizer: DirectWrite draws Chromium's glyphs and swash drew ours. Tuning the contrast, the gamma, the offset and
the filter did not close it, so the masks themselves changed.

### DirectWrite masks (Windows)

**What is built.** On Windows the glyph masks come from DirectWrite, the rasterizer Chromium uses there, behind the same
atlas; swash stays the rasterizer on macOS and Linux, for colour fonts (COLR, SVG, bitmap strikes: DirectWrite is asked
for none of them) and with `STYK_TEXT_RASTERIZER=swash`. Shaping, layout and widths are still cosmic-text's.

- `cosmic_text::dwrite::DirectWrite` loads the bundled font's bytes through an in-memory font file loader and
  `IDWriteFontResource::CreateFontFace` at the `wght` and `opsz` coordinates of the glyph (cached by font, weight and
  optical size), and rasterizes with `IDWriteGlyphRunAnalysis`: ClearType 3x1 for subpixel text, a grayscale
  `ALIASED_1x1` texture for grayscale text. The subpixel offset (0, ¼, ½, ¾ pixel) is the transform's translation, as
  in Skia.
- **Skia's choices** (`SkScalerContext_DW`, Chromium's hinting on Windows is "normal"; `scaler_choice`): measuring mode
  natural; the rendering mode and size by the font's `gasp` table (version 1: natural symmetric where its symmetric
  smoothing flag is set, natural otherwise, at the device size), otherwise natural symmetric at the device size above
  20 px or for a font without instructions, otherwise (a hinted font up to 20 px: Segoe UI, Microsoft YaHei UI) natural
  at the size rounded to 1/64 pixel; grid fitting enabled. Inter has no instructions, so it is natural symmetric at its
  size. Assuming Chromium draws without grid fitting (as with `HINTING_NONE`) was tried first and was wrong for the
  fallback fonts: the error of the Chinese rows was 0.53 and of the Arabic 0.15, against 0.01 and 0.03 with Skia's
  tree.
- **Off the interface thread.** Rasterizing is not done in `prepare`. The first frame that needs a glyph asks the
  worker (`cryoglyph::raster`, thread "glyphs"), leaves the glyph out and reports the text incomplete; iced prepares a
  cached upload again while it is incomplete; the worker wakes the program (`styk_design::glyphs::ready`, a
  subscription) when it has glyphs, and the next frame draws them. A program that captures a frame (a screenshot, the
  typography check, the headless path) draws until `glyphs::pending()` is zero. The atlas grows by copying its texture,
  not by drawing every glyph again.

**Result** (`cargo xtask fonts`, Windows 11, ClearType on, the Inter rows, 90 per combination):

| Theme, scale | Swash masks | DirectWrite masks | The mark | |
| --- | --- | --- | --- | --- |
| light, 100 % | 0.088 | **0.021** | 0.077 | below |
| dark, 100 % | 0.071 | **0.013** | 0.116 | below |
| light, 150 % | 0.058 | **0.015** | 0.052 | below |
| dark, 150 % | 0.048 | **0.010** | 0.083 | below |

The Arabic, Hebrew and CJK rows are at 0.014 to 0.034, 0.013 to 0.030 and 0.007 to 0.016. The mean colour spread of the
ink pixels is 78.5, 68.0, 62.9 and 55.0 against Chromium's 79.8, 68.7, 63.7 and 55.4, the total ink is within 0.1 %, and
the widths are unchanged (largest difference 0.03 px, in all four combinations).

**The coverage adjustment, rechecked.** With DirectWrite's masks the adjustment is still needed and the same: switched
off (`STYK_TEXT_ADJUST=0`) the error is 0.087, 0.144, 0.059 and 0.104 (light 100 %, dark 100 %, light 150 %, dark 150 %).
A sweep of the contrast from 0.4 to 0.6 and the gamma from 1.7 to 1.9 (`cargo xtask fonts`'s captures, nine pairs) has its
least in the light themes at contrast 0.5 or 0.6 with gamma 1.8 or 1.9, and in the dark ones at gamma 1.8 whatever the
contrast; the pair (0.5, 1.8), Skia's default contrast, is within 0.002 of the least in every combination, and a contrast
of 0.4 is worse in the light themes (0.028 against 0.021 at 100 %). The values stay.

**Cost.** Text-dense frames (`styk-text-check bench`: 5,376 glyphs of the interface's body text, light theme, drawn and
read back in a headless renderer, 150 frames, the machine shared with other jobs), four interleaved rounds. Medians in
ms, DirectWrite subpixel / swash subpixel / grayscale: at 100 %, 2.49 / 4.23 / 3.19, 3.13 / 3.07 / 2.87, 3.70 / 2.15 /
2.44 and 3.49 / 4.70 / 2.62; at 150 %, 8.35 / 7.85 / 8.08, 7.75 / 7.47 / 7.34, 7.23 / 7.78 / 7.59 and 7.23 / 8.43 / 8.39.
A frame with every glyph cached costs the same with the three (the spread between rounds is larger than the spread
between kinds; a frame is 7 ms at 144 Hz). What DirectWrite adds is the first view: every glyph of a new text waits for
the worker, so a screen of new text is drawn without it for a moment. On this screen (the 5,376 glyphs of about 100
distinct characters in one size) all glyphs were on screen after 15 to 23 ms at 100 % and 23 to 26 ms at 150 %, against
7 to 9 ms and 11 to 13 ms for swash on the interface thread, which stalls the frame it is drawn in instead. The interface
thread draws no glyph on Windows.

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
