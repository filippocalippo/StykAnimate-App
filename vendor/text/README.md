# Portable text dependencies

These assets ship inside the desktop application and are served locally. Text
authoring uses the font outlines directly; PIV and STK exports embed the resulting
glyph paths and do not depend on installed fonts or these files when reopened.

## opentype.js

- Version: **1.3.4**
- Upstream: <https://github.com/opentypejs/opentype.js>
- Exact distribution: <https://unpkg.com/opentype.js@1.3.4/dist/opentype.module.js>
- Local module: `opentype.mjs` (renamed without code changes)
- License: MIT, included in `opentype.LICENSE` from
  <https://unpkg.com/opentype.js@1.3.4/LICENSE>.
- SHA-256: `8d79d17388114a29d74681dfaed84068b1d7d9b4e39a9544fb6406d25579ad8f`

## Noto Sans

- Upstream: <https://github.com/notofonts/noto-fonts>
- Pinned revision: `c971829a87e7920f960e7277c3dafd9bedd3c601`
- Source directory: `hinted/ttf/NotoSans/` at that revision.
- License: SIL Open Font License 1.1, unmodified copy in `OFL.txt`.
- Fonts are unmodified upstream files. All four styles use real outline fonts.

| File | SHA-256 |
| --- | --- |
| NotoSans-Regular.ttf | `b85c38ecea8a7cfb39c24e395a4007474fa5a4fc864f6ee33309eb4948d232d5` |
| NotoSans-Bold.ttf | `c976e4b1b99edc88775377fcc21692ca4bfa46b6d6ca6522bfda505b28ff9d6a` |
| NotoSans-Italic.ttf | `36cff144df01309dab648bea71baff9bb074026914afe63aeacc8bc90b67a28b` |
| NotoSans-BoldItalic.ttf | `6edf4227ef0fa846aca70e86a307804ca4401741830f5b3af0f2554abe2b8466` |

## Supported authoring

The initial authoring path supports left/center/right multiline text, kerning,
regular/bold/italic/bold-italic, fill/gradient, opacity and figure outline. Latin,
Greek, Cyrillic, and other characters covered by these fonts are accepted; a
missing character produces an explicit error. Text is canonically composed and
newlines are normalized. This is not a general bidirectional or complex-script
shaping engine. The Pivot interchange schema stores one outline per distinct
UTF-16 code unit with a limit of 255 distinct units per text figure. Supplementary
Unicode characters are rejected before compilation.

TrueType quadratic outlines are converted exactly to cubic Bézier curves and
rounded to the native format's float32 precision. Each exported glyph and each
visible placement is explicit. The normalized origin matches the Pivot decoder's
lower-left convention. Bounds include control points, matching the native
decoder's bounds calculations. Alignment flags use the
[FMX TTextAlign enum](https://docwiki.embarcadero.com/Libraries/Florence/en/FMX.Types.TTextAlign);
explicit placement coordinates determine the rendered alignment.
