# Bundled fonts

The native interface's text stack reads TrueType, not the WOFF2 subsets the web build ships (`assets/fonts/`). These are
the same fonts, whole, as single variable files that cover every subset the app uses.

| File | Family | Version | Axes | Source |
| --- | --- | --- | --- | --- |
| `Inter.ttf` | Inter | 4.001 (`git-66647c0bb`) | `opsz`, `wght` | Google Fonts, `ofl/inter/Inter[opsz,wght].ttf` |
| `InterTight.ttf` | Inter Tight | 3.004 | `wght` | Google Fonts, `ofl/intertight/InterTight[wght].ttf` |

The version strings are the ones in the `name` table of the app's own WOFF2 files (`inter-latin-opsz-normal.woff2`,
`inter-tight-latin-wght-normal.woff2`), so the glyph outlines and variation data are the same; a test in
`src/fonts.rs` fails if a file is replaced by another build. Licences: `assets/fonts/OFL-Inter.txt` and
`assets/fonts/OFL-InterTight.txt` (SIL Open Font License 1.1).

SHA-256: `Inter.ttf` `29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031`, `InterTight.ttf`
`b81b73dcb64df3c230cabade7df6c5773bf863233f24c9ee51087519f1f88b6f`.

`cargo xtask fonts verify` checks these files against the WOFF2 subsets in `assets/fonts/` (same advance width for every code point of every
subset, same axes) and lists the OpenType features the subsets lost: `cv01`..`cv14`, `ss01`..`ss08` and others are in the TrueType
files but in no shipped subset, so the browser never draws them and the native interface never asks for them.
