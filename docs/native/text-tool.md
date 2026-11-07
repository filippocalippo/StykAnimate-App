# The text tool's compiler and the font service

The native text tool does what today's does, bit for bit: the draft in the dialog becomes vector outlines embedded in the
figure, laid out one glyph per UTF-16 unit with no shaping, and a document saved with that figure has the same bytes as
one saved by the JavaScript app. This page is the contract the Rust port keeps. The code is `styk-core::text` (the
compiler), `styk-services::fonts` (limits, container checks, the service trait) and `styk-platform::fonts` (the folder
walk). Design decisions that come from the reviews of the S2 spike: the port is **bit-exact** (the orchestrator's decision;
a mismatch changes the implementation, never a tolerance), kerning precedence follows opentype.js (finding 12), loading
preview fonts and discovery are bounded and cancellable (findings 15, 16).

## 1. What today's app does

`src/text-authoring.mjs`, with the opentype.js build in `vendor/text/opentype.mjs` (`parseBuffer`, `charToGlyph`,
`Glyph.getPath`, `getKerningValue`), `src/text-font-compat.mjs` and `src/native-text-authoring.mjs`.

**Validation (`textOptionsWithDefaults`), in this order.** Text must contain a visible character after JavaScript `trim`
(which counts U+FEFF and not U+0085). At most 16,384 UTF-16 units. Alignment `left|center|right`. Bold and italic are
booleans. Figure id an integer 1..65535. Then `\r\n?` becomes `\n` and the text is normalised to NFC (imported text is
not). At most 255 distinct UTF-16 units; no surrogates (BMP only); no `\x00-\x08 \x0b-\x1f \x7f`. Then the paint is
normalised (`paint.mjs`), and font size 1..2048, line height 0.5..5, colour three integer bytes, opacity 0..1, gradient
colour, outline width 0..128 and outline colour are checked in that order. Every error is a message key with parameters
(`errors.textAuthoring.*`, `errors.cameraMotion.mustBeBetweenAnd` with a label object); the interface localises it.

**Layout (`compileTextFigure`).**

1. For each distinct code unit in order of first use: tab and line feed have no glyph; every other character is looked
   up with `charToGlyph` (cmap, then the glyph); glyph 0 (`.notdef`) is the error "does not contain U+XXXX". The outline
   is `glyph.getPath(0, 0, fontSize)`: each font-unit coordinate `v` becomes `0 + v * scale` and `0 + (-v) * scale` with
   `scale = 1 / unitsPerEm * fontSize` in doubles. Quadratic segments are converted to cubic in doubles
   (`x + (x1 - x) * 2 / 3`, ...) and **only then** every coordinate is rounded with `Math.fround`. Glyph bounds include
   control points (`Math.min`/`Math.max`, NaN-propagating); `node_count` counts three per cubic; `svg_path` is the
   command list printed with JavaScript's number-to-string.
2. `scale = fontSize / unitsPerEm`. Space advance is `(advanceWidth(space) || unitsPerEm / 4) * scale`. For each
   line, each unit adds `(advanceWidth || 0) * scale` (a tab adds four space advances) and, between two adjacent units
   that both have glyphs, `getKerningValue * scale`, as a separate addition.
3. `layoutWidth` is the widest line; left aligns at 0, centre at `(layoutWidth - width) / 2`, right at
   `layoutWidth - width`. Placement y is `row * fontSize * lineHeight`; x and y are `fround`ed, and 0 for a glyph with
   no outline. A line feed placement follows every line but the last.
4. Bounds are the float32 sums of glyph bounds and placements (`textHasNoVisibleGlyphOutlines` if empty). The figure,
   its one text segment, the global style (outline width as float32 bits) and the `_styk.textAuthoring` record follow
   with the key order of the JavaScript object literal, including integer-like keys of `glyphAdvances` first and
   ascending.

**opentype.js details that show in the numbers** (all reproduced):

- The cmap is the **last** supported subtable (platform 3 encodings 0, 1, 10 or platform 0), format 4 or 12 only;
  format 4 skips the final segment; later segments override earlier ones; every mapped glyph must exist in the font or
  the font is rejected at load (`addGlyphNames`), and a TrueType font without a `post` table is rejected too.
- Windows **symbol** fonts (OS/2 code page bit 31, or any (3, 0) cmap subtable): codes 0x20..0xff without a glyph take
  the glyph of U+F000 + code.
- **Kerning.** If the font has a `GPOS` table, kerning comes from the default script's (`DFLT`, else `latn`) default
  language system's first `kern` feature, type-2 pair lookups only (extension lookups are not followed); a `GPOS` table
  without such a feature kerns **nothing** and the `kern` table is ignored. Only a font with no `GPOS` table uses the
  `kern` table (a later duplicate pair wins). Format 2 returns the first covered subtable's class value, even 0.
- **CFF width.** A CFF glyph's `advanceWidth` is overwritten with the width its charstring declares when its outline is
  first read, and stays that way for the life of the font object: the space advance of a text without a space depends
  on whether an earlier draft read the space. The worker keeps one font object per face, so the Rust `Font` keeps the
  same per-glyph state.
- Composite glyph points are transformed in doubles (`xScale*x + scale01*y + dx`), matched points by their offset
  difference; CFF charstring stacks give `NaN` for a missing operand (`undefined` in JavaScript) and `endchar` does not
  stop interpretation.
- Names: the family is `preferredFamily.en`, else `fontFamily.en`, else the first language stored, else "Custom font".
  Language ids map through the Windows and Macintosh tables of opentype.js (generated into `names_data.rs` from the
  vendored module by `tests/fixtures/text/names-data.mjs`).

**Imported text (`native-text-authoring.mjs`).** `readTextFigureOptions` reconstructs a draft from the figure. An edit
that changes neither text, alignment, line height nor size keeps every path, UTF-16 unit and position (CRLF included).
Otherwise glyphs are scaled in float32, layout reuses the spacing the file shows (observed pair distances, stored
`glyphAdvances`, medians) and marks the result `spacingEstimated` where it had to guess. A character the file has no
glyph for is `MissingTextGlyphsError`; changing bold or italic needs a font face; the scale must be in (0, 40].
`replaceTextAssetFigure` installs the outlines of an explicitly chosen font into one asset of a mixed rig.

**The worker (`text-authoring-worker.mjs`).** `source`, `font` and `compile` requests. At most 8 faces, 32 MiB per
file, 64 MiB retained; a face is rejected rather than evicted. One compile in flight, one replaceable latest draft
(the dialog debounces 100 ms).

**Installed fonts (`desktop/font-service.cjs`).** Folders only (Windows `%SystemRoot%\Fonts` and
`%LOCALAPPDATA%\Microsoft\Windows\Fonts`; macOS and Linux lists), extensions `.ttf .otf .ttc .otc`, real paths contained
in the roots, 20,000 files, 2,048 folders, depth 8, 4,096 faces; file 32 MiB (collection 128 MiB, 128 faces); a face's
table directory is validated (printable unique tags, in bounds, `cmap` and `head` and `glyf+loca` or `CFF `, rebuilt
size under 32 MiB); name records are read with bounds (4,096 records, 8 KiB a string, 1 MiB total), English preferred;
collection faces are repacked standalone (tables sorted, `DSIG` dropped, `head` adjustment recomputed); ids are
`font_` + 32 hex digits of SHA-256 of the lower-cased real path, NUL and the face number; reads re-check the path and
the file's fingerprint, are serialised, at most 8 in flight, with an 8-font, 64 MiB cache.

## 2. The Rust port

### Why not skrifa

The brief allows skrifa/read-fonts "where their numbers are provably identical". They are not: skrifa scales outlines in
single precision, resolves composite offsets with its own rounding, and does not reproduce opentype.js's bad-input
behaviour (`undefined` arithmetic, what is rejected at load). Bit-exactness is the requirement, so every table that
touches a number or a decision is a line-for-line port of the opentype.js function, in the same operation order
(`truetype.rs`, `cff.rs`, `kerning.rs`, the cmap, hmtx and name readers in `font.rs`/`names.rs`). Reading goes through a
bounds-checked reader (`reader.rs`) whose failure mode is opentype.js's `RangeError`. No font crate is a dependency.

### What is not reproduced (accepted, documented)

- opentype.js also parses `GSUB`, `GDEF`, `fvar`, `meta`, `cvt `, `fpgm`, `prep` at load, and fails the font if one is
  malformed. The text tool never reads them; the Rust port ignores them.
- WOFF input and font collections (the picker offers `.ttf`/`.otf`; collection faces arrive repacked).
- Lone UTF-16 surrogates inside a font's name strings become U+FFFD.
- NFC uses the `unicode-normalization` crate's Unicode version, not V8's ICU: they differ only for characters assigned
  after either was built.
- A class-pair `GPOS` table of more than 2^24 pairs, or a cmap whose segments overlap for more than 4 million
  characters, is refused (opentype.js would hang or run out of memory building it).
- `toLocaleString()` in the "at most N characters" message: the parameter is the plain number.

### `styk-core::text`

- `Font::parse(bytes)`: the work of `opentype.parse` + `applyWindowsSymbolMapping`; `Font` offers `glyph_index`,
  `advance_width`, `scaled_path` (which records a CFF width), `kerning`, `family`, `style`, `bold`, `italic`.
- `TextOptions` (a draft), `TextSettings::validate`, `compile_text_figure` → a `styk_doc::Value` figure whose
  `json::to_string` is `JSON.stringify` of the JavaScript result.
- `read_text_figure_options`, `compile_embedded_text_figure`, `replace_text_asset_figure`, `can_edit_text_figure`,
  `text_asset_for`: the native-text rules over document values, so key order and numbers are the file's.
- `TextCompiler`: the worker's state (source, up to 8 faces / 64 MiB, the four bundled styles on demand).
  `TextJob`: that state on its own thread. `CompileRequest { revision, font, options }`; `compile` replaces a draft that
  has not started and cancels one that has (a flag polled before every distinct character and every line); only the newest
  `JobEvent::Compiled` is kept, tagged with its revision, so the interface drops anything stale; commands (source, font
  load) queue at most 16 deep and answer `Busy` instead of dropping; the single lock is never held across a parse or a
  compile, so the interface thread never waits (D7); dropping the job cancels, wakes and joins the thread. The 100 ms
  debounce is the interface's (`styk-ui`).

### `styk-services::fonts` and `styk-platform::fonts`

`styk-services::fonts` has the limits above as constants, `FontId`, `FontFace`, `FontError`, the `FontService` trait
(`list` and `read`, both taking a `cancel: &dyn Fn() -> bool`), a fake, the `ReadAt` abstraction and the pure checks:
`inspect_file` (container, face directories, names) and `standalone_face`. They run on bytes before any parser sees them.
`styk-platform::fonts::SystemFonts` is the walk: breadth first over the roots, `read_dir` entries sorted, links resolved
with `canonicalize` and dropped unless inside a root, junctions treated as links, the same caps, a scan shared by
concurrent callers (waiters poll their own cancel callback), a cancelled scan keeping nothing, reads chunked with a cancel
check per 256 KiB. `with_directories` takes trusted absolute folders; `new()` takes the machine's. The per-user Roaming
folder that fontdb would also scan is **not** listed: the face list is today's service's list.

## 3. Proof

`engine/crates/styk-core/tests/fixtures/text/generate.mjs` runs `compileTextFigure`, `compileEmbeddedTextFigure` and
`replaceTextAssetFigure` from the repository's JavaScript on: the four bundled Noto Sans styles, a user TTF
(FiraSans), the variable Inter, derived fonts (GPOS and `kern` with different values; `kern` only; an empty `GPOS` plus
`kern`; a Windows symbol font), and a synthetic CFF font written for the fixtures. `tests/text_fixtures.rs` requires the
JSON text of each result to equal the JavaScript's byte for byte (and the parsed structure, key order included), and
each refusal to carry the same message key and parameters. `tests/pivot_bytes.rs` saves documents holding a natively
compiled figure and the JavaScript's figure and compares the files. The platform tests cover escaped links, oversized
collections, cancel in the middle of a walk and the same face list as the JavaScript service on the machine that runs
them. Results of the runs are in the chunk's report.
